import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { registerWebTools } from "../web-tools.ts";

const video = "dQw4w9WgXcQ";
const examples = {
  nano_gpt_web_extract: { url: "https://example.com/pricing", prompt: "Extract prices" },
  nano_gpt_site_map: { url: "https://example.com", maxTotalChargeUsd: 0.1 },
  nano_gpt_site_crawl: { url: "https://example.com", maxTotalChargeUsd: 0.2 },
  nano_gpt_youtube_transcript: { urls: [`https://youtu.be/${video}`] },
  nano_gpt_web_research: { query: "Compare authentication options" },
};

function setup(t) {
  const tools = new Map();
  const requests = [];
  const replies = [];
  const state = { apiKey: "inference-secret", subscriptionOnly: false };
  registerWebTools({ registerTool(tool) { tools.set(tool.name, tool); } }, {
    getApiKey: () => state.apiKey,
    isSubscriptionOnly: () => state.subscriptionOnly,
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, ...init, body: JSON.parse(init.body) });
    assert.ok(replies.length, "unexpected upstream request (paid calls must not retry or poll)");
    const reply = replies.shift();
    return typeof reply === "function" ? reply(url, init) : Response.json(reply);
  });
  return {
    tools, requests, replies, state,
    call: (name, args = examples[name], signal) => tools.get(name).execute("id", args, signal),
  };
}
function text(result) { return result.content.map((block) => block.text).join("\n"); }

test("extract uses Sofya's explicit extract operation and retains opaque data/cost", async (t) => {
  const { call, requests, replies } = setup(t);
  const payload = { data: { plans: [{ name: "Basic", price: 10 }], sources: ["https://example.com/pricing"] }, metadata: { cost: 0.02625, operation: "extract" } };
  replies.push(payload);
  const result = await call("nano_gpt_web_extract", { url: "https://example.com/pricing", prompt: "  Extract prices  ", timeout: 180, query: "not forwarded" });
  assert.equal(requests[0].url, "https://api.nano-gpt.com/api/web");
  assert.deepEqual(requests[0].body, { provider: "sofya", operation: "extract", url: "https://example.com/pricing", prompt: "Extract prices" });
  assert.deepEqual(result.details, { metadata: payload.metadata, truncated: false });
  assert.match(text(result), /"price": 10/);
  assert.match(text(result), /untrusted/);
});

test("research defaults and bounded options match the Sofya contract", async (t) => {
  const { call, requests, replies } = setup(t);
  const payload = { data: { report: "A cited report", citations: [{ url: "https://example.com/" }] }, metadata: { cost: 0.13125 } };
  replies.push(payload, payload);
  await call("nano_gpt_web_research");
  assert.deepEqual(requests[0].body, {
    provider: "sofya", operation: "research", query: "Compare authentication options", maxSources: 10, topic: "general",
  });
  const result = await call("nano_gpt_web_research", { query: " news ", maxSources: 30, topic: "news", freshness: "2026-01-01:2026-02-01", timeout: 300 });
  assert.deepEqual(requests[1].body, {
    provider: "sofya", operation: "research", query: "news", maxSources: 30, topic: "news", freshness: "2026-01-01:2026-02-01",
  });
  assert.equal(requests[1].url, "https://api.nano-gpt.com/api/web");
  assert.deepEqual(result.details.metadata, payload.metadata);
  assert.match(text(result), /https:\/\/example.com/);
});

test("invalid extraction/research inputs are rejected before billing", async (t) => {
  const { call, requests } = setup(t);
  for (const args of [
    { url: "file:///etc/passwd", prompt: "x" }, { url: "https://user:pass@example.com", prompt: "x" },
    { url: "https://example.com:8000", prompt: "x" }, { url: "https://example.com", prompt: " " },
    { url: "https://example.com", prompt: "x", timeout: 181 },
  ]) await assert.rejects(call("nano_gpt_web_extract", args));
  for (const args of [
    { query: " " }, { query: "x", maxSources: 4 }, { query: "x", maxSources: 31 },
    { query: "x", maxSources: 5.5 }, { query: "x", topic: "other" },
    { query: "x", freshness: "yesterday" }, { query: "x", freshness: "2026-02-30:2026-03-01" },
    { query: "x", freshness: "2026-03-01:2026-02-01" }, { query: "x", timeout: 301 },
  ]) await assert.rejects(call("nano_gpt_web_research", args));
  assert.equal(requests.length, 0);
});

test("map and crawl send explicit bounded requests and retain all response/job/billing fields", async (t) => {
  const { call, requests, replies } = setup(t);
  const map = { data: { links: ["https://example.com/docs"] }, meta: { nanogpt: { costUsd: 0.01 } }, unknown: "preserved" };
  replies.push(map);
  const mapped = await call("nano_gpt_site_map");
  assert.equal(requests[0].url, "https://api.nano-gpt.com/api/v1/data/firecrawl");
  assert.deepEqual(requests[0].body, {
    operation: "map", url: "https://example.com/", limit: 25, waitForFinishSecs: 240, maxTotalChargeUsd: 0.1,
  });
  assert.deepEqual(mapped.details, { metadata: undefined, meta: map.meta, httpStatus: 200, truncated: false });
  assert.match(text(mapped), /"unknown": "preserved"/);

  replies.push({ items: [{ markdown: "# Doc" }], status: "SUCCEEDED", usage: { actualCostUsd: 0.02 } });
  const crawled = await call("nano_gpt_site_crawl");
  assert.deepEqual(requests[1].body, {
    operation: "crawl", url: "https://example.com/", limit: 5, waitForFinishSecs: 240, maxTotalChargeUsd: 0.2,
    maxReturnedPages: 5, formats: ["markdown"],
  });
  assert.match(text(crawled), /# Doc/);
  assert.match(text(crawled), /actualCostUsd/);
  assert.equal(crawled.isError, false);

  replies.push({ data: [] }, { data: [] });
  await call("nano_gpt_site_map", { ...examples.nano_gpt_site_map, limit: 100, search: " docs ", waitForFinishSecs: 30, timeout: 60 });
  assert.equal(requests[2].body.search, "docs");
  assert.equal(requests[2].body.limit, 100);
  assert.equal(requests[2].body.timeout, undefined);
  await call("nano_gpt_site_crawl", { ...examples.nano_gpt_site_crawl, limit: 20, maxReturnedPages: 2, maxTotalChargeUsd: 5, waitForFinishSecs: 5, timeout: 35 });
  assert.equal(requests[3].body.limit, 20);
  assert.equal(requests[3].body.maxReturnedPages, 2);
});

test("site tasks do not guess success schemas, follow job URLs, poll or resubmit", async (t) => {
  const { call, requests, replies } = setup(t);
  replies.push(() => Response.json({ status: "pending", runId: "job-123", pollUrl: "https://untrusted.example/steal-key" }, { status: 202 }));
  const result = await call("nano_gpt_site_crawl");
  assert.equal(result.isError, false, "pending is not a terminal failure");
  assert.equal(result.details.httpStatus, 202);
  assert.match(text(result), /job-123/);
  assert.match(text(result), /Completion is not inferred/);
  assert.match(text(result), /No polling or resubmission/);
  assert.equal(requests.length, 1);
  replies.push({ unfamiliarEnvelope: { data: ["still retained"] } });
  assert.match(text(await call("nano_gpt_site_map")), /still retained/);
});

test("site errors preserve partial data and billing but redact echoed inference credentials", async (t) => {
  const { call, requests, replies } = setup(t);
  for (const status of [200, 400, 402, 429, 500]) {
    replies.push(() => Response.json({
      error: "upstream echoed inference-secret", status: "FAILED", items: [{ markdown: "partial page" }],
      meta: { nanogpt: { costUsd: 0.01 } },
    }, { status }));
    const result = await call("nano_gpt_site_crawl");
    assert.equal(result.isError, true);
    assert.match(text(result), /partial page/);
    assert.match(text(result), /costUsd/);
    assert.match(text(result), /\[redacted\]/);
    assert.doesNotMatch(text(result), /inference-secret/);
  }
  assert.equal(requests.length, 5);
});

test("site limits, required budgets, and timeout/wait relationships fail before billing", async (t) => {
  const { call, requests } = setup(t);
  for (const name of ["nano_gpt_site_map", "nano_gpt_site_crawl"]) {
    for (const patch of [
      { maxTotalChargeUsd: undefined }, { maxTotalChargeUsd: 0 }, { maxTotalChargeUsd: -1 },
      { maxTotalChargeUsd: Infinity }, { maxTotalChargeUsd: NaN }, { maxTotalChargeUsd: 5.01 },
      { limit: 0 }, { limit: 1.5 }, { limit: name.endsWith("map") ? 101 : 21 },
      { waitForFinishSecs: 4 }, { waitForFinishSecs: 241 }, { timeout: 301 },
      { waitForFinishSecs: 240, timeout: 240 }, { url: "https://example.com:8080" },
    ]) await assert.rejects(call(name, { ...examples[name], ...patch }));
  }
  await assert.rejects(call("nano_gpt_site_map", { ...examples.nano_gpt_site_map, search: " " }));
  await assert.rejects(call("nano_gpt_site_crawl", { ...examples.nano_gpt_site_crawl, maxReturnedPages: 6 }));
  assert.equal(requests.length, 0);
});

test("YouTube uses documented x-api-key authentication, normalizes video URLs, and keeps per-video failures", async (t) => {
  const { call, replies, requests } = setup(t);
  const urls = [
    `https://www.youtube.com/watch?v=${video}&t=42`, `https://youtu.be/${video}?si=tracking`,
    `https://youtube.com/embed/${video}`, `https://m.youtube.com/watch?v=${video}`, `https://youtube.com/live/${video}`,
  ];
  const payload = { transcripts: [
    { url: `https://www.youtube.com/watch?v=${video}`, success: true, title: "Talk", transcript: "A technical presentation" },
    { url: "https://youtu.be/other123456", success: false, error: "transcript unavailable" },
  ], summary: { successful: 1, failed: 1, totalCost: 0.01 } };
  replies.push(payload);
  const result = await call("nano_gpt_youtube_transcript", { urls, timeout: 30, provider: "ignored" });
  assert.equal(requests[0].url, "https://api.nano-gpt.com/api/youtube-transcribe");
  assert.deepEqual(requests[0].headers, { "x-api-key": "inference-secret", "Content-Type": "application/json", Accept: "application/json" });
  assert.deepEqual(requests[0].body, { urls: urls.map(() => `https://www.youtube.com/watch?v=${video}`) });
  assert.equal(result.isError, false);
  assert.deepEqual(result.details, { summary: payload.summary, truncated: false });
  assert.match(text(result), /technical presentation/);
  assert.match(text(result), /transcript unavailable/);
  replies.push({ transcripts: [{ url: urls[0], success: false, error: "not available" }] });
  assert.equal((await call("nano_gpt_youtube_transcript")).isError, true);
});

test("invalid YouTube targets and malformed transcripts are not treated as successful", async (t) => {
  const { call, replies, requests } = setup(t);
  for (const urls of [
    [], Array(11).fill(`https://youtu.be/${video}`),
    ...["https://youtube.com/channel/123", "https://youtube.com/playlist?list=123", "https://youtube.com/watch?v=short", `https://youtube.com.evil.example/watch?v=${video}`, `https://evil.example/${video}`, `https://user:pass@youtube.com/watch?v=${video}`, "file:///tmp/audio.mp3"].map((url) => [url]),
  ]) await assert.rejects(call("nano_gpt_youtube_transcript", { urls }));
  assert.equal(requests.length, 0);
  for (const payload of [{}, { transcripts: [] }, { transcripts: [null] }, { transcripts: [{ url: "url", success: true }] }]) {
    replies.push(payload);
    await assert.rejects(call("nano_gpt_youtube_transcript"), /invalid or missing transcripts/);
  }
  for (const name of ["nano_gpt_web_extract", "nano_gpt_web_research"]) {
    replies.push({ data: [] });
    await assert.rejects(call(name), /invalid or missing data/);
  }
});

test("every new tool uses the live billing guard, key resolution, cancellation and no-redirect transport", async (t) => {
  const { call, state, requests, replies } = setup(t);
  state.subscriptionOnly = true;
  for (const name of Object.keys(examples)) await assert.rejects(call(name), /subscription-only/);
  state.subscriptionOnly = false;
  state.apiKey = undefined;
  for (const name of Object.keys(examples)) await assert.rejects(call(name), /No NanoGPT API key/);
  state.apiKey = " new-inference-key ";
  const cancelled = new AbortController();
  cancelled.abort();
  for (const name of Object.keys(examples)) await assert.rejects(call(name, examples[name], cancelled.signal));
  assert.equal(requests.length, 0);
  for (const name of Object.keys(examples)) {
    const controller = new AbortController();
    replies.push((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      controller.abort();
    }));
    await assert.rejects(call(name, examples[name], controller.signal), /cancelled/);
    assert.equal(requests.at(-1).redirect, "error");
    assert.equal(requests.at(-1).method, "POST");
    assert.equal(requests.at(-1).headers[name === "nano_gpt_youtube_transcript" ? "x-api-key" : "Authorization"], name === "nano_gpt_youtube_transcript" ? "new-inference-key" : "Bearer new-inference-key");
  }
  assert.equal(requests.length, 5, "no cancelled request is retried");
});

test("credential echoes in nested JSON keys and values are redacted from details and saved artifacts", async (t) => {
  const { call, replies } = setup(t);
  const secret = "inference-secret";
  replies.push(() => Response.json({
    error: { [secret]: "invalid credential" },
    meta: { [secret]: { trace: `header: ${secret}` } },
    data: { [secret]: "page ".repeat(15000) },
  }, { status: 402 }));
  const result = await call("nano_gpt_site_crawl");
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /inference-secret/);
  assert.match(JSON.stringify(result), /\[redacted\]/);
  const path = result.details.fullOutputPath;
  assert.ok(path);
  t.after(() => rmSync(dirname(path), { recursive: true, force: true }));
  assert.doesNotMatch(readFileSync(path, "utf8"), /inference-secret/);
});

test("oversized upstream metadata is bounded in persisted details and retained in the output artifact", async (t) => {
  const { call, replies } = setup(t);
  const trace = "trace ".repeat(40000);
  for (const name of Object.keys(examples)) {
    const metadata = { cost: 0.01, trace };
    replies.push(name === "nano_gpt_youtube_transcript"
      ? { transcripts: [{ url: "https://youtu.be/12345678901", success: true, transcript: "text" }], summary: metadata }
      : { data: {}, metadata, meta: metadata });
    const result = await call(name);
    const path = result.details.fullOutputPath;
    assert.ok(path);
    t.after(() => rmSync(dirname(path), { recursive: true, force: true }));
    assert.ok(Buffer.byteLength(JSON.stringify(result.details)) < 8192);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 60 * 1024);
    assert.ok(readFileSync(path, "utf8").includes("trace trace trace"));
  }
});

test("all new tools bound displayed output and save complete readable artifacts", async (t) => {
  const { call, replies } = setup(t);
  const large = "source material ".repeat(6000);
  for (const name of Object.keys(examples)) {
    replies.push(name === "nano_gpt_youtube_transcript"
      ? { transcripts: [{ url: "https://youtu.be/12345678901", success: true, transcript: large }] }
      : { data: { text: large } });
    const result = await call(name);
    const path = result.details.fullOutputPath;
    assert.ok(path);
    t.after(() => rmSync(dirname(path), { recursive: true, force: true }));
    assert.equal(result.details.truncated, true);
    assert.ok(Buffer.byteLength(text(result)) <= 50 * 1024);
    assert.ok(text(result).split("\n").length <= 2000);
    const saved = readFileSync(path, "utf8");
    assert.ok(saved.length > large.length);
    assert.ok(saved.split("\n").every((line) => Buffer.byteLength(line) <= 4000));
  }
});
