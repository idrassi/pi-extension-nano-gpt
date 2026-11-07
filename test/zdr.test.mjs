import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const ENV_KEY = "environment-inference-key";
const STORED_KEY = "stored-inference-key";
const CHANGED_KEY = "changed-inference-key";
const FILE_KEY = "file-inference-key";
const TOKEN = "management-token-secret";
const KEY_IDS = new Map([[ENV_KEY, "1"], [STORED_KEY, "2"], [CHANGED_KEY, "3"], [FILE_KEY, "4"]]);
let fixtureId = 0;

async function setup(t, { envKey = ENV_KEY, runtimeKey = STORED_KEY, fileKey = FILE_KEY, provider = true, managementToken = TOKEN } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-nano-gpt-zdr-"));
  const config = join(directory, "nano-gpt.json");
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "NANO_GPT_API_KEY", "NANO_GPT_MANAGEMENT_TOKEN"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = directory;
  if (envKey === null) delete process.env.NANO_GPT_API_KEY;
  else process.env.NANO_GPT_API_KEY = envKey;
  if (managementToken === null) delete process.env.NANO_GPT_MANAGEMENT_TOKEN;
  else process.env.NANO_GPT_MANAGEMENT_TOKEN = managementToken;
  writeFileSync(config, JSON.stringify({ ...(fileKey === null ? {} : { apiKey: fileKey }) }));
  t.mock.method(console, "error", () => {});
  const state = { runtimeKey, provider, authCalls: 0, registrations: 0, response: undefined, resolveAuth: undefined };
  const requests = [];
  const notices = [];
  const commands = new Map();
  const policies = new Map([...KEY_IDS.values()].map((id) => [id, "off"]));
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    // Only mocked public discovery and control-plane calls are allowed.
    if (url.endsWith("/models?detailed=true")) return Response.json({ data: [{ id: "vendor/model" }] });
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://nano-gpt.com");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const request = { url, ...init, body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(request);
    if (state.response) {
      const response = await state.response(request);
      if (response) return response;
    }
    if (parsed.pathname === "/api/v1/usage") {
      assert.deepEqual(Object.keys(init.headers).sort(), ["Accept", "Authorization"]);
      const inferenceKey = init.headers.Authorization.slice("Bearer ".length);
      assert.ok(KEY_IDS.has(inferenceKey), "usage must authenticate with a known inference key, never a management token");
      return Response.json({ apiKey: { id: Number(KEY_IDS.get(inferenceKey)) } });
    }
    const match = /^\/api\/management\/v1\/api-keys\/(\d+)$/.exec(parsed.pathname);
    assert.ok(match, "unexpected control-plane endpoint");
    assert.equal(init.headers.Authorization, `Bearer ${managementToken}`);
    const id = match[1];
    if (init.method === "PATCH") policies.set(id, request.body.zdr_policy);
    return Response.json({ id, name: `key-${id}`, status: "active", zdr_policy: policies.get(id) });
  });
  const ctx = {
    hasUI: false,
    model: { provider: "another-provider", id: "another-model" },
    modelRegistry: {
      getProvider(id) { assert.equal(id, "nano-gpt"); return state.provider ? {} : undefined; },
      async getProviderAuth(id) {
        assert.equal(id, "nano-gpt");
        state.authCalls++;
        return state.resolveAuth ? state.resolveAuth() : { auth: { apiKey: state.runtimeKey, headers: { "x-provider": "must-not-forward" } } };
      },
    },
    ui: { notify(message, type) { notices.push({ message, type }); }, setStatus() {}, async select() { return "on"; } },
  };
  const pi = {
    registerTool() {},
    registerCommand(name, command) { commands.set(name, command); },
    registerProvider() { state.registrations++; },
    on() {},
  };
  const entry = new URL("../index.ts", import.meta.url);
  entry.search = `zdr-test=${fixtureId++}`;
  const { default: load } = await import(entry.href);
  await load(pi);
  return {
    ctx, state, config, requests, notices, policies,
    command: (args) => commands.get("nano-gpt-zdr").handler(args, ctx),
    patches: () => requests.filter((request) => request.method === "PATCH"),
    usage: () => requests.filter(({ url }) => new URL(url).pathname === "/api/v1/usage"),
  };
}

function assertNoSecrets(notices, secrets = [ENV_KEY, STORED_KEY, CHANGED_KEY, FILE_KEY, TOKEN]) {
  const text = JSON.stringify(notices);
  for (const secret of secrets) assert.ok(!text.includes(secret), "notifications must not expose credentials");
}

test("ZDR status and updates target the runtime NanoGPT key rather than env/file or the active provider", async (t) => {
  const { command, requests, usage, patches, notices, policies } = await setup(t);
  await command("status");
  await command("on");
  await command("off");
  assert.equal(usage().length, 3, "identify the live credential on every command, without a stale id cache");
  assert.ok(usage().every(({ headers }) => headers.Authorization === `Bearer ${STORED_KEY}`));
  assert.ok(requests.filter(({ url }) => url.includes("/management/")).every(({ url }) => url.endsWith("/api-keys/2")));
  assert.deepEqual(patches().map(({ body }) => body), [{ zdr_policy: "zdr" }, { zdr_policy: "off" }]);
  assert.equal(policies.get("1"), "off");
  assert.equal(policies.get("2"), "off");
  assert.match(notices.at(-1).message, /key-2 \(#2\).*clients using this key/);
  assertNoSecrets(notices);
});

test("credential changes between commands never reuse a different key's cached id", async (t) => {
  const { command, state, usage, patches, notices } = await setup(t);
  await command("status");
  state.runtimeKey = CHANGED_KEY;
  await command("on");
  state.runtimeKey = STORED_KEY;
  await command("status");
  assert.deepEqual(usage().map(({ headers }) => headers.Authorization), [STORED_KEY, CHANGED_KEY, STORED_KEY].map((key) => `Bearer ${key}`));
  assert.deepEqual(patches().map(({ url }) => new URL(url).pathname), ["/api/management/v1/api-keys/3"]);
  assert.match(notices.at(-1).message, /OFF.*key-2 \(#2\)/);
});

test("ZDR supports runtime-only keys without the legacy env/file startup key", async (t) => {
  const { command, state, patches, usage, notices } = await setup(t, { envKey: null, fileKey: null });
  assert.equal(state.registrations, 0);
  await command("status");
  await command("on");
  assert.equal(usage().length, 2);
  assert.equal(patches().length, 1);
  assert.ok(notices.every(({ type }) => type === "info"));
});

test("absent-provider fallback resolves current environment/file credentials rather than startup snapshots", async (t) => {
  const { command, usage } = await setup(t, { provider: false });
  await command("status");
  process.env.NANO_GPT_API_KEY = CHANGED_KEY;
  await command("status");
  delete process.env.NANO_GPT_API_KEY;
  await command("status");
  assert.deepEqual(usage().map(({ headers }) => headers.Authorization), [ENV_KEY, CHANGED_KEY, FILE_KEY].map((key) => `Bearer ${key}`));
});

test("registered-provider auth failures or missing keys fail closed without sending env/file credentials", async (t) => {
  const { command, state, requests, notices } = await setup(t);
  for (const result of [undefined, {}, { auth: {} }, { auth: { apiKey: "   " } }]) {
    state.resolveAuth = async () => result;
    await command("on");
    assert.equal(notices.at(-1).type, "error");
  }
  state.resolveAuth = async () => { throw new Error(`auth failed ${STORED_KEY}`); };
  await command("on");
  assert.equal(requests.length, 0);
  assert.match(notices.at(-1).message, /Unable to resolve NanoGPT runtime credentials/);
  assertNoSecrets(notices);
});

test("placeholder inference keys cannot identify or mutate a managed key", async (t) => {
  const { command, state, requests, notices } = await setup(t);
  state.runtimeKey = "REPLACE_WITH_YOUR_KEY";
  await command("on");
  assert.equal(requests.length, 0);
  assert.match(notices.at(-1).message, /no NanoGPT inference API key/);
});

test("missing management token and invalid arguments cause no control-plane requests", async (t) => {
  const { command, state, requests, notices } = await setup(t, { managementToken: null });
  await command("on");
  assert.match(notices.at(-1).message, /api_keys:write Management API token/);
  process.env.NANO_GPT_MANAGEMENT_TOKEN = TOKEN;
  await command("invalid");
  assert.match(notices.at(-1).message, /usage:/);
  assert.equal(requests.length, 0);
  assert.equal(state.authCalls, 0);
});

test("changing credentials while the picker is open cancels the old account's policy update", async (t) => {
  const { ctx, state, command, patches, notices } = await setup(t);
  ctx.hasUI = true;
  ctx.ui.select = async (title) => {
    assert.match(title, /key-2 \(#2\)/);
    state.runtimeKey = CHANGED_KEY;
    return "on";
  };
  await command("");
  assert.equal(patches().length, 0);
  assert.match(notices.at(-1).message, /credentials changed.*no policy update was submitted/);
  await command("on");
  assert.equal(patches().length, 1);
  assert.match(patches()[0].url, /api-keys\/3$/);
});

test("changing credentials during control-plane reads avoids misleading status or writes", async (t) => {
  const { command, state, patches, notices } = await setup(t);
  state.response = async ({ url }) => {
    if (url.includes("/management/")) state.runtimeKey = CHANGED_KEY;
  };
  await command("status");
  assert.equal(patches().length, 0);
  assert.equal(notices.at(-1).type, "error");
  assert.match(notices.at(-1).message, /credentials changed/);
});

test("cancelling the picker and already-current policies never submit a PATCH", async (t) => {
  const { ctx, command, patches, notices } = await setup(t);
  ctx.hasUI = true;
  ctx.ui.select = async () => undefined;
  await command("");
  await command("off");
  assert.equal(patches().length, 0);
  assert.match(notices.at(-1).message, /already OFF/);
});

test("malformed, mismatched, expired and failed control-plane responses do not report policy success", async (t) => {
  const { command, state, patches, notices } = await setup(t);
  for (const [path, payload] of [
    ["/usage", { apiKey: { id: "invalid" } }],
    ["/usage", {}],
    ["/management/", { id: "99", name: "wrong-key", status: "active", zdr_policy: "off" }],
    ["/management/", { id: "2", name: "expired-key", status: "expired", zdr_policy: "off" }],
  ]) {
    state.response = async ({ url }) => url.includes(path) ? Response.json(payload) : undefined;
    await command("on");
    assert.equal(notices.at(-1).type, "error");
  }
  assert.equal(patches().length, 0);
  for (const payload of [
    { id: "99", name: "wrong-key", status: "active", zdr_policy: "zdr" },
    { id: "2", name: "key-2", status: "active", zdr_policy: "off" },
  ]) {
    state.response = async ({ method }) => method === "PATCH" ? Response.json(payload) : undefined;
    await command("on");
    assert.equal(notices.at(-1).type, "error");
  }
  assert.equal(patches().length, 2, "each explicit command submits once, never retries");
});

test("control-plane failures and key names cannot leak inference or management credentials", async (t) => {
  const { command, state, requests, notices } = await setup(t);
  for (const path of ["/usage", "/management/"]) {
    state.response = async ({ url }) => url.includes(path)
      ? Response.json({ error: { code: "denied", message: `secret ${STORED_KEY} ${TOKEN}`, request_id: `id-${TOKEN}` } }, { status: 401 })
      : undefined;
    const before = requests.length;
    await command("on");
    assert.ok(requests.length - before <= 2, "no retry of rejected control-plane operations");
    assert.equal(notices.at(-1).type, "error");
    assertNoSecrets(notices);
  }
  state.response = async ({ url }) => url.includes("/management/")
    ? Response.json({ id: "2", name: `${STORED_KEY}\n${TOKEN}`, status: "active", zdr_policy: "off" })
    : undefined;
  await command("status");
  assert.equal(notices.at(-1).type, "info");
  assertNoSecrets(notices);
  assert.doesNotMatch(notices.at(-1).message, /[\n\r]/);
});

const runtimeDir = process.env.PI_TEST_RUNTIME_DIR;
test("Pi runtime: ZDR follows stored and changed runtime credentials with a different active provider", {
  skip: !runtimeDir && "set PI_TEST_RUNTIME_DIR to enable the offline Pi integration test",
}, async (t) => {
  const { ctx, command, usage, patches, notices } = await setup(t);
  const fromRuntime = (file) => import(pathToFileURL(join(resolve(runtimeDir), "dist/core", file)).href);
  const [{ ModelRuntime }, { ModelRegistry }, { AuthStorage }] = await Promise.all([
    fromRuntime("model-runtime.js"), fromRuntime("model-registry.js"), fromRuntime("auth-storage.js"),
  ]);
  const credentials = AuthStorage.inMemory({ "nano-gpt": { type: "api_key", key: STORED_KEY } });
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider("nano-gpt", {
    api: "openai-completions", baseUrl: "https://nano-gpt.com/api/v1", apiKey: "$NANO_GPT_API_KEY", authHeader: true,
    headers: { "x-provider": "not-for-control-plane", "x-management-token": "not-for-control-plane" }, models: [],
  });
  ctx.modelRegistry = new ModelRegistry(runtime);
  await command("status");
  await runtime.setRuntimeApiKey("nano-gpt", CHANGED_KEY);
  await command("on");
  assert.deepEqual(usage().map(({ headers }) => headers.Authorization), [STORED_KEY, CHANGED_KEY].map((key) => `Bearer ${key}`));
  assert.equal(patches().length, 1);
  assert.match(patches()[0].url, /api-keys\/3$/);
  assert.ok(notices.every(({ type }) => type === "info"));
});
