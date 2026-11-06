import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("runtime-only credentials can enable and persist the paid-tool guard without changing another inference provider", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-nano-gpt-runtime-guard-"));
  const config = join(directory, "nano-gpt.json");
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldKey = process.env.NANO_GPT_API_KEY;
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldKey === undefined) delete process.env.NANO_GPT_API_KEY;
    else process.env.NANO_GPT_API_KEY = oldKey;
    rmSync(directory, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.NANO_GPT_API_KEY;
  writeFileSync(config, JSON.stringify({ subscriptionOnly: false, custom: "preserve" }));
  t.mock.method(console, "error", () => {});
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://nano-gpt.com/api/web", "guard toggle must not fetch or replace an inference catalogue");
    assert.equal(init.headers.Authorization, "Bearer stored-runtime-key");
    requests.push({ url, ...init });
    return Response.json({ data: [], metadata: { cost: 0.006 } });
  });
  const commands = new Map();
  const tools = new Map();
  const notices = [];
  const statuses = new Map();
  const provider = { baseUrl: "https://custom.example/inference" };
  const ctx = {
    hasUI: true,
    model: { provider: "other-provider", id: "other-model" },
    ui: {
      notify(message) { notices.push(message); },
      setStatus(key, value) { statuses.set(key, value); },
    },
    modelRegistry: {
      getProvider(name) { assert.equal(name, "nano-gpt"); return provider; },
      async getProviderAuth(name) { assert.equal(name, "nano-gpt"); return { auth: { apiKey: "stored-runtime-key" } }; },
    },
  };
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerProvider() { assert.fail("no env/file key: do not overwrite an independently registered inference provider"); },
    on() {},
  };
  const { default: load } = await import("../index.ts");
  await load(pi);
  const search = () => tools.get("nano_gpt_web_search").execute("id", { query: "q" }, undefined, undefined, ctx);
  await search();
  assert.equal(requests.length, 1);
  ctx.model = { provider: "nano-gpt", id: "external-model" };
  await commands.get("nano-gpt-subscription").handler("on", ctx);
  assert.equal(statuses.get("nano-gpt"), "nano-gpt · web tools blocked · inference mode external");
  await assert.rejects(search(), /subscription-only/);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { subscriptionOnly: true, custom: "preserve" });
  assert.ok(notices.some((message) => /paid web tools BLOCKED.*inference provider configuration was not changed/.test(message)));
  assert.equal(ctx.modelRegistry.getProvider("nano-gpt"), provider);

  await load(pi);
  await assert.rejects(search(), /subscription-only/, "guard survives reload without an env/file key");
  await commands.get("nano-gpt-subscription").handler("off", ctx);
  assert.equal(statuses.get("nano-gpt"), "nano-gpt · web tools allowed · inference mode external");
  await search();
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(readFileSync(config, "utf8")).subscriptionOnly, false);
  assert.ok(notices.some((message) => /paid web tools ALLOWED/.test(message)));
});
