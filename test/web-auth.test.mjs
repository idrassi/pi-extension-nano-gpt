import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveWebApiKey } from "../web-auth.ts";
import { registerWebTools } from "../web-tools.ts";

function setup({ provider = {}, resolution = { auth: { apiKey: "stored-key" } }, model } = {}) {
  const state = { provider, resolution, fallbackCalls: 0, authCalls: [] };
  const registry = {
    getProvider(id) {
      assert.equal(id, "nano-gpt");
      return state.provider;
    },
    async getProviderAuth(id) {
      state.authCalls.push(id);
      assert.equal(id, "nano-gpt");
      return state.resolution;
    },
  };
  return {
    state, registry, ctx: { modelRegistry: registry, model },
    fallback: () => { state.fallbackCalls++; return "env-or-file-key"; },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("NanoGPT runtime key wins over env/file regardless of the active provider", async () => {
  for (const model of [undefined, { provider: "nano-gpt", id: "nano" }, { provider: "anthropic", id: "other" }]) {
    const { ctx, state, fallback } = setup({ model });
    assert.equal(await resolveWebApiKey(ctx, fallback), "stored-key");
    assert.equal(state.fallbackCalls, 0);
    assert.deepEqual(state.authCalls, ["nano-gpt"]);
  }
});

test("does not require a loaded/available NanoGPT model or consult model-scoped auth", async () => {
  const { ctx, fallback, registry } = setup();
  Object.defineProperty(ctx, "model", { get() { assert.fail("active model must not be read"); } });
  registry.getAll = registry.getAvailable = registry.getApiKeyAndHeaders = () => assert.fail("no model lookup");
  assert.equal(await resolveWebApiKey(ctx, fallback), "stored-key");
});

test("resolves changed runtime keys on every call and returns only the key", async () => {
  const { ctx, state, fallback } = setup();
  state.resolution = {
    auth: { apiKey: "first-key", headers: { Authorization: "management-secret", "x-routing": "paid" }, baseUrl: "https://wrong.example" },
    env: { NANO_GPT_MANAGEMENT_TOKEN: "management-secret" },
    source: "stored credential",
  };
  assert.equal(await resolveWebApiKey(ctx, fallback), "first-key");
  state.resolution.auth.apiKey = "second-key";
  assert.equal(await resolveWebApiKey(ctx, fallback), "second-key");
  assert.equal(state.fallbackCalls, 0);
  assert.deepEqual(state.authCalls, ["nano-gpt", "nano-gpt"]);
});

test("explicit env/file fallback runs only when the NanoGPT provider is absent", async () => {
  const { ctx, state, fallback } = setup();
  state.provider = undefined;
  assert.equal(await resolveWebApiKey(ctx, fallback), "env-or-file-key");
  assert.equal(await resolveWebApiKey(ctx, () => undefined), undefined);
  assert.equal(state.fallbackCalls, 1);
  assert.deepEqual(state.authCalls, []);
});

test("standalone callers without a context can explicitly use env/file fallback", async () => {
  assert.equal(await resolveWebApiKey(undefined, () => "standalone-key"), "standalone-key");
});

test("missing registry or provider lookup errors fail closed, not as an absent provider", async () => {
  const { ctx, registry, state, fallback } = setup();
  for (const missing of [{}, { modelRegistry: undefined }]) {
    await assert.rejects(resolveWebApiKey(missing, fallback), /missing model registry/);
  }
  registry.getProvider = () => { throw new Error("configuration-secret"); };
  await assert.rejects(resolveWebApiKey(ctx, fallback), (error) => {
    assert.match(error.message, /runtime provider/);
    assert.doesNotMatch(error.message, /configuration-secret/);
    return true;
  });
  assert.equal(state.fallbackCalls, 0);
  assert.deepEqual(state.authCalls, []);
});

test("registered provider auth failures and missing keys never silently use env/file", async () => {
  const { ctx, registry, state, fallback } = setup();
  for (const resolution of [undefined, {}, { auth: {} }, { auth: { apiKey: "" } }, { auth: { apiKey: "   " } }]) {
    state.resolution = resolution;
    await assert.rejects(resolveWebApiKey(ctx, fallback), /No NanoGPT API key resolved by Pi/);
  }
  for (const getAuth of [
    () => { throw new Error("auth-secret"); },
    async () => { throw new Error("auth-secret"); },
  ]) {
    registry.getProviderAuth = getAuth;
    await assert.rejects(resolveWebApiKey(ctx, fallback), (error) => {
      assert.match(error.message, /Unable to resolve NanoGPT runtime credentials/);
      assert.doesNotMatch(error.message, /auth-secret/);
      return true;
    });
  }
  assert.equal(state.fallbackCalls, 0);
});

test("pre-cancelled resolution performs no provider/auth/fallback work", async () => {
  const { ctx, registry, state, fallback } = setup();
  registry.getProvider = () => assert.fail("cancelled before provider lookup");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolveWebApiKey(ctx, fallback, controller.signal), { name: "AbortError" });
  assert.equal(state.fallbackCalls, 0);
  assert.deepEqual(state.authCalls, []);
});

test("cancellation stops waiting for auth and safely handles late success or failure", { timeout: 2000 }, async (t) => {
  for (const lateOutcome of ["resolve", "reject"]) {
    const { ctx, registry, state, fallback } = setup();
    const pending = deferred();
    registry.getProviderAuth = () => pending.promise;
    const controller = new AbortController();
    const remove = t.mock.method(controller.signal, "removeEventListener");
    const result = resolveWebApiKey(ctx, fallback, controller.signal);
    controller.abort();
    await assert.rejects(result, { name: "AbortError" });
    assert.equal(state.fallbackCalls, 0);
    assert.equal(remove.mock.calls.length, 1, "abort listener is removed");
    pending[lateOutcome](lateOutcome === "resolve" ? { auth: { apiKey: "too-late" } } : new Error("late auth failure"));
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("successful auth removes its cancellation listener", async (t) => {
  const { ctx, fallback } = setup();
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, "removeEventListener");
  assert.equal(await resolveWebApiKey(ctx, fallback, controller.signal), "stored-key");
  assert.equal(remove.mock.calls.length, 1);
});

test("all seven web tools forward their execution context and cancellation signal to credential lookup", async (t) => {
  const tools = new Map();
  const ctx = { model: { provider: "another-provider", id: "another-model" } };
  let lookups = 0;
  registerWebTools({ registerTool(tool) { tools.set(tool.name, tool); } }, {
    async getApiKey(actualCtx, signal) {
      assert.equal(actualCtx, ctx);
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      lookups++;
      throw new Error("credential-lookup-tripwire");
    },
    isSubscriptionOnly: () => false,
  });
  t.mock.method(globalThis, "fetch", () => assert.fail("credential lookup must finish before any fetch"));
  const argsByTool = {
    nano_gpt_web_search: { query: "docs" },
    nano_gpt_web_scrape: { urls: ["https://example.com"] },
    nano_gpt_web_extract: { url: "https://example.com", prompt: "Extract prices" },
    nano_gpt_site_map: { url: "https://example.com", maxTotalChargeUsd: 0.1 },
    nano_gpt_site_crawl: { url: "https://example.com", maxTotalChargeUsd: 0.1 },
    nano_gpt_youtube_transcript: { urls: ["https://youtu.be/dQw4w9WgXcQ"] },
    nano_gpt_web_research: { query: "Compare APIs" },
  };
  assert.equal(tools.size, 7);
  for (const [name, args] of Object.entries(argsByTool)) {
    const controller = new AbortController();
    await assert.rejects(tools.get(name).execute("ctx-test", args, controller.signal, undefined, ctx), /credential-lookup-tripwire/);
  }
  assert.equal(lookups, 7);
});

// Opt in to an installed Pi runtime without relying on a particular release or
// package location: PI_TEST_RUNTIME_DIR=/path/to/@earendil-works/pi-coding-agent.
// In-memory credentials, no model refresh, and a fetch tripwire keep this offline.
const runtimeDir = process.env.PI_TEST_RUNTIME_DIR;

test("Pi schema accepts freshness strings but Sofya execute rejects invalid ranges before fetch", {
  skip: !runtimeDir && "set PI_TEST_RUNTIME_DIR to enable the offline Pi validation test",
}, async (t) => {
  const requireRuntime = createRequire(join(resolve(runtimeDir), "package.json"));
  let aiEntry;
  try {
    aiEntry = requireRuntime.resolve("@earendil-works/pi-ai");
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    // Pi AI's ESM-only exports may have no CommonJS resolution condition.
    aiEntry = join(resolve(runtimeDir), "..", "pi-ai", "dist/index.js");
  }
  const { validateToolArguments } = await import(pathToFileURL(aiEntry).href);
  const tools = new Map();
  const requests = [];
  registerWebTools({ registerTool(tool) { tools.set(tool.name, tool); } }, {
    getApiKey: () => "test-key", isSubscriptionOnly: () => false,
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return Response.json({ data: [], metadata: { cost: 0 } });
  });
  const tool = tools.get("nano_gpt_web_search");
  const validate = (freshness) => validateToolArguments(tool, {
    type: "toolCall", id: "schema-test", name: tool.name,
    arguments: { query: "docs", provider: "sofya", freshness },
  });
  for (const freshness of ["not-a-range", "2026-02-30:2026-03-01", "2026-03-02:2026-03-01"]) {
    const args = validate(freshness);
    assert.equal(args.freshness, freshness, "schema must leave string semantics to execute");
    await assert.rejects(tool.execute("schema-test", args), /freshness|Dates/);
  }
  assert.equal(requests.length, 0, "invalid freshness must not reach a billable endpoint");
  const freshness = "2026-01-01:2026-01-31";
  await tool.execute("schema-test", validate(freshness));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.freshness, freshness);
});

test("Pi runtime: stored and runtime overrides win over env/config with another active provider", {
  skip: !runtimeDir && "set PI_TEST_RUNTIME_DIR to enable the offline Pi integration test",
}, async (t) => {
  const requests = [];
  let toolsMayRequest = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(toolsMayRequest, "runtime credential resolution must not make network requests");
    requests.push({ url, ...init });
    return url.endsWith("/api/youtube-transcribe")
      ? Response.json({ transcripts: [{ url: "https://youtu.be/dQw4w9WgXcQ", success: true, transcript: "text" }] })
      : Response.json({ data: [], metadata: { cost: 0.006 } });
  });
  const fromRuntime = (file) => import(pathToFileURL(join(resolve(runtimeDir), "dist/core", file)).href);
  const [{ ModelRuntime }, { ModelRegistry }, { AuthStorage }] = await Promise.all([
    fromRuntime("model-runtime.js"), fromRuntime("model-registry.js"), fromRuntime("auth-storage.js"),
  ]);
  const previous = process.env.NANO_GPT_API_KEY;
  process.env.NANO_GPT_API_KEY = "environment-key";
  t.after(() => {
    if (previous === undefined) delete process.env.NANO_GPT_API_KEY;
    else process.env.NANO_GPT_API_KEY = previous;
  });
  const credentials = AuthStorage.inMemory({ "nano-gpt": { type: "api_key", key: "stored-key" } });
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider("nano-gpt", {
    api: "openai-completions", baseUrl: "https://nano-gpt.com/api/v1", apiKey: "$NANO_GPT_API_KEY", authHeader: true,
    headers: { "x-routing": "dummy-route", "x-management-token": "dummy-management-secret" }, models: [],
  });
  const ctx = { modelRegistry: new ModelRegistry(runtime), model: { provider: "other-provider", id: "other-model" } };
  const fallback = () => assert.fail("registered runtime must not fall back to env/file");
  assert.equal(await resolveWebApiKey(ctx, fallback), "stored-key");
  await credentials.modify("nano-gpt", async () => ({ type: "api_key", key: "changed-stored-key" }));
  assert.equal(await resolveWebApiKey(ctx, fallback), "changed-stored-key");
  await runtime.setRuntimeApiKey("nano-gpt", "runtime-key");
  assert.equal(await resolveWebApiKey(ctx, fallback), "runtime-key");
  await runtime.setRuntimeApiKey("nano-gpt", "changed-runtime-key");
  assert.equal(await resolveWebApiKey(ctx, fallback), "changed-runtime-key");
  assert.equal(ctx.modelRegistry.getAll().filter((model) => model.provider === "nano-gpt").length, 0);

  const tools = new Map();
  registerWebTools({ registerTool(tool) { tools.set(tool.name, tool); } }, {
    getApiKey: (executionCtx, signal) => resolveWebApiKey(executionCtx, fallback, signal),
    isSubscriptionOnly: () => false,
  });
  toolsMayRequest = true;
  await tools.get("nano_gpt_web_search").execute("auth-search", { query: "q" }, undefined, undefined, ctx);
  await tools.get("nano_gpt_youtube_transcript").execute("auth-transcript", { urls: ["https://youtu.be/dQw4w9WgXcQ"] }, undefined, undefined, ctx);
  assert.deepEqual(requests.map(({ headers }) => headers), [
    { Authorization: "Bearer changed-runtime-key", "Content-Type": "application/json", Accept: "application/json" },
    { "x-api-key": "changed-runtime-key", "Content-Type": "application/json", Accept: "application/json" },
  ], "standalone requests use the live runtime key, not env or management/routing headers");
});
