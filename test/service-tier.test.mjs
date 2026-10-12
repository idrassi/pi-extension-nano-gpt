import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function mockPi() {
  const commands = new Map();
  const hooks = new Map();
  const providers = [];
  return {
    commands,
    hooks,
    providers,
    api: {
      registerCommand(name, command) { commands.set(name, command); },
      registerProvider(name, provider) { providers.push({ name, provider }); },
      on(name, handler) { hooks.set(name, handler); },
    },
  };
}

test("service tier switch changes the next request, persists per model, and composes with routing", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "pi-nano-gpt-tier-"));
  const configPath = join(configDir, "nano-gpt.json");
  const oldConfigDir = process.env.PI_CODING_AGENT_DIR;
  const oldKey = process.env.NANO_GPT_API_KEY;
  const oldFetch = globalThis.fetch;
  const modelA = { id: "vendor/model-a", provider: "nano-gpt" };
  const modelB = { id: "vendor/model-b", provider: "nano-gpt" };

  try {
    writeFileSync(configPath, JSON.stringify({
      apiKey: "test-key",
      customField: "preserve me",
      routing: { [modelA.id]: { suffix: "fast" } },
    }));
    process.env.PI_CODING_AGENT_DIR = configDir;
    process.env.NANO_GPT_API_KEY = "test-key";
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [{ id: modelA.id }, { id: modelB.id }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const { default: loadExtension } = await import("../index.ts");
    const extension = mockPi();
    await loadExtension(extension.api);
    assert.equal(extension.providers.length, 1);

    const statuses = new Map();
    const notices = [];
    let pick = "";
    const ctx = {
      hasUI: true,
      mode: "rpc",
      model: modelA,
      ui: {
        notify(message, type) { notices.push({ message, type }); },
        setStatus(key, value) { statuses.set(key, value); },
        async select(_title, choices) { return choices.find((choice) => choice.startsWith(pick)); },
      },
    };
    const tier = extension.commands.get("nano-gpt-tier");
    const request = extension.hooks.get("before_provider_request");
    const payload = { model: modelA.id, messages: [{ role: "user", content: "hi" }] };

    await tier.handler("priority", ctx);
    assert.deepEqual(request({ payload }, ctx), {
      ...payload,
      model: `${modelA.id}:fast`,
      service_tier: "priority",
    });
    assert.equal(statuses.get("nano-gpt"), "nano-gpt · :fast · tier priority");
    assert.equal(request({ payload }, ctx).promptCaching, undefined, "non-Claude requests are not opted into explicit caching");

    ctx.model = modelB;
    pick = "flex";
    await tier.handler("", ctx); // interactive switch
    assert.equal(request({ payload: { ...payload, model: modelB.id } }, ctx).service_tier, "flex");
    assert.equal(statuses.get("nano-gpt"), "nano-gpt · auto · tier flex");
    await tier.handler("default", ctx);
    assert.equal(request({ payload }, ctx).service_tier, "default");
    await tier.handler("auto", ctx);
    assert.equal(request({ payload }, ctx), undefined); // leaves the request unchanged
    await tier.handler("flex", ctx);
    assert.equal(request({ payload }, { ...ctx, model: { id: "other", provider: "elsewhere" } }), undefined);

    ctx.model = modelA;
    await extension.commands.get("nano-gpt-subscription").handler("on", ctx);
    assert.equal(extension.providers.at(-1).provider.baseUrl, "https://nano-gpt.com/api/subscription/v1");
    assert.deepEqual(request({ payload }, ctx), { ...payload, service_tier: "priority" });
    assert.equal(statuses.get("nano-gpt"), "nano-gpt · subscription · tier priority");

    // Explicit Claude caching bypasses subscription coverage, so the helper is
    // pay-as-you-go only. A thinking suffix is still a Claude id.
    const claude = { id: "anthropic/claude-haiku-5.5:thinking", provider: "nano-gpt" };
    ctx.model = claude;
    assert.equal(
      request({ payload: { ...payload, model: claude.id } }, ctx),
      undefined,
      "subscription mode must not add explicit Claude cache controls",
    );

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(saved.customField, "preserve me");
    assert.deepEqual(saved.serviceTiers, {
      [modelA.id]: "priority",
      [modelB.id]: "flex",
    });

    const reloaded = mockPi();
    await loadExtension(reloaded.api);
    assert.equal(reloaded.providers.at(-1).provider.baseUrl, "https://nano-gpt.com/api/subscription/v1");
    ctx.model = modelA;
    assert.deepEqual(reloaded.hooks.get("before_provider_request")({ payload }, ctx), {
      ...payload,
      service_tier: "priority",
    });
    assert.equal(notices.some(({ type }) => type === "error"), false);

    await extension.commands.get("nano-gpt-subscription").handler("off", ctx);
    ctx.model = claude;
    assert.deepEqual(request({ payload: { ...payload, model: claude.id } }, ctx), {
      ...payload,
      model: claude.id,
      promptCaching: { enabled: true, ttl: "5m" },
    });
    ctx.model = { id: "anthropic/claude-sonnet-4.5", provider: "nano-gpt" };
    assert.equal(
      request({ payload: { model: "anthropic/claude-sonnet-4.5:fast", messages: [] } }, ctx).promptCaching.ttl,
      "5m",
    );
    ctx.model = { id: "openai/gpt-5", provider: "nano-gpt" };
    assert.equal(request({ payload }, ctx), undefined);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldConfigDir;
    if (oldKey === undefined) delete process.env.NANO_GPT_API_KEY;
    else process.env.NANO_GPT_API_KEY = oldKey;
    rmSync(configDir, { recursive: true, force: true });
  }
});
