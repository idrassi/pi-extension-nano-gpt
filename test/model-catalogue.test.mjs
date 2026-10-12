import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The dedicated api.nano-gpt.com deployment returned HTTP 200 but lacked this
// model while the documented nano-gpt.com endpoint already exposed it.
const mimo = {
  id: "xiaomi/mimo-v2.6-pro",
  name: "MiMo V2.6 Pro",
  context_length: 1_048_576,
  max_output_tokens: 131_072,
  capabilities: { reasoning: true, vision: true, tool_calling: true },
  reasoning_efforts: ["none", "high"],
  pricing: {
    prompt: 0.435,
    completion: 0.87,
    cacheReadInputPer1kTokens: 0.0000036,
    cacheWriteInputPer1kTokens: 0,
  },
};

const haiku = {
  id: "anthropic/claude-haiku-5.5",
  name: "Claude Haiku 5.5",
  context_length: 1_000_000,
  max_output_tokens: 128_000,
  capabilities: { reasoning: true, vision: true },
  reasoning_efforts: ["low", "high"],
  pricing: {
    prompt: 0.1,
    completion: 0.5,
    cacheReadInputPer1kTokens: 0.00001,
    cacheWriteInputPer1kTokens: 0.000125,
  },
};

const haikuLongContext = {
  inputPer1kTokensAboveFirstThreshold: 0.0005,
  outputPer1kTokensAboveFirstThreshold: 0.0025,
  firstContextThresholdTokens: 100_000,
  cacheReadInputPer1kTokensAboveFirstThreshold: 0.00005,
  cacheWriteInputPer1kTokensAboveFirstThreshold: 0.000625,
};

test("discovers new models on the canonical host and keeps billing and routing endpoints consistent", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "pi-nano-gpt-catalogue-"));
  const oldConfigDir = process.env.PI_CODING_AGENT_DIR;
  const oldKey = process.env.NANO_GPT_API_KEY;
  t.after(() => {
    if (oldConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldConfigDir;
    if (oldKey === undefined) delete process.env.NANO_GPT_API_KEY;
    else process.env.NANO_GPT_API_KEY = oldKey;
    rmSync(configDir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = configDir;
  process.env.NANO_GPT_API_KEY = "test-key";
  writeFileSync(join(configDir, "nano-gpt.json"), JSON.stringify({ apiKey: "test-key" }));

  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    requests.push(url.href);
    if (url.pathname.endsWith("/providers")) {
      const haikuDiscovery = url.pathname.includes("claude-haiku-5.5");
      return Response.json({
        canonicalId: haikuDiscovery ? haiku.id : mimo.id,
        supportsProviderSelection: false,
        ...(haikuDiscovery ? { defaultPrice: haikuLongContext } : {}),
      });
    }
    // A successful but stale response must not be confused with a fetch error.
    if (url.hostname === "api.nano-gpt.com") {
      return Response.json({ data: [{ id: "xiaomi/mimo-v2.5-pro" }] });
    }
    const data = url.pathname.includes("/subscription/")
      ? [mimo]
      : [mimo, haiku, { id: "vendor/paid-only" }];
    return Response.json({ data });
  });

  const commands = new Map();
  const providers = [];
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    registerProvider(name, provider) { providers.push({ name, provider }); },
    on() {},
  };
  const { default: loadExtension } = await import("../index.ts");
  await loadExtension(pi);

  assert.equal(providers.length, 1, "models are registered before the async factory completes");
  const initial = providers[0];
  assert.equal(initial.name, "nano-gpt");
  const model = initial.provider.models.find(({ id }) => id === mimo.id);
  assert.ok(model, "MiMo V2.6 Pro must be discoverable without a curated entry");
  assert.equal(initial.provider.baseUrl, "https://nano-gpt.com/api/v1");
  assert.equal(initial.provider.apiKey, "$NANO_GPT_API_KEY");
  assert.equal(initial.provider.authHeader, true);
  assert.equal(model.name, mimo.name);
  assert.equal(model.contextWindow, mimo.context_length);
  assert.equal(model.maxTokens, mimo.max_output_tokens);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.deepEqual(model.thinkingLevelMap, {
    off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "high",
  });
  assert.deepEqual(model.cost, { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 });
  assert.equal(model.promptCache, undefined, "implicit-cache models are not declared with Claude's explicit TTL");

  const claude = initial.provider.models.find(({ id }) => id === haiku.id);
  assert.ok(claude, "Claude models stay in the catalogue");
  assert.deepEqual(claude.promptCache, { short: 300 });
  assert.deepEqual(claude.cost, {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [{
      inputTokensAbove: 100_000,
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite: 0.625,
    }],
  });

  const ctx = {
    hasUI: false,
    model: { id: mimo.id, provider: "nano-gpt" },
    ui: { notify() {}, setStatus() {} },
  };
  await commands.get("nano-gpt-provider").handler("", ctx);
  await commands.get("nano-gpt-subscription").handler("on", ctx);
  assert.equal(providers.at(-1).provider.baseUrl, "https://nano-gpt.com/api/subscription/v1");
  assert.deepEqual(providers.at(-1).provider.models.map(({ id }) => id), [mimo.id]);

  // Restarting/reloading preserves subscription-only discovery, not the paygo list.
  await loadExtension(pi);
  assert.equal(providers.at(-1).provider.baseUrl, "https://nano-gpt.com/api/subscription/v1");
  assert.deepEqual(providers.at(-1).provider.models.map(({ id }) => id), [mimo.id]);
  await commands.get("nano-gpt-subscription").handler("off", ctx);
  assert.equal(providers.at(-1).provider.baseUrl, "https://nano-gpt.com/api/v1");
  assert.equal(providers.at(-1).provider.models.length, 3);
  assert.deepEqual(requests, [
    "https://nano-gpt.com/api/v1/models?detailed=true",
    "https://nano-gpt.com/api/models/anthropic%2Fclaude-haiku-5.5/providers",
    "https://nano-gpt.com/api/models/xiaomi%2Fmimo-v2.6-pro/providers",
    "https://nano-gpt.com/api/subscription/v1/models?detailed=true",
    "https://nano-gpt.com/api/subscription/v1/models?detailed=true",
    "https://nano-gpt.com/api/v1/models?detailed=true",
    "https://nano-gpt.com/api/models/anthropic%2Fclaude-haiku-5.5/providers",
  ]);
});
