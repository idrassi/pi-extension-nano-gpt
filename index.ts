/**
 * Nano-GPT provider extension for pi.
 *
 * Registers https://nano-gpt.com — an OpenAI-compatible aggregator exposing
 * 600+ text models (OpenAI, Anthropic, Google, xAI, DeepSeek, Qwen, ...) — as a
 * pi provider. Nano-GPT bills text models at upstream list price with no markup.
 *
 * API surface (https://nano-gpt.com/api):
 *   - Base URL:        https://nano-gpt.com/api/v1 (documented canonical host)
 *   - Chat Completions: POST /chat/completions  (OpenAI-compatible, streaming)
 *   - Models list:      GET  /models            (public, no auth)
 *   - Auth:             "Authorization: Bearer <key>"
 *
 * Model catalogue is fetched from GET /models?detailed=true at startup so it
 * stays current. The detailed endpoint returns each model's context_length,
 * max_output_tokens, pricing, and capabilities directly
 * (https://docs.nano-gpt.com/api-reference/endpoint/models), so those are taken
 * from the API as the authoritative source. A curated overlay (CURATED below)
 * acts as a fallback if the API lacks a value for a model (it historically
 * filled Anthropic cache-write pricing before the API exposed it). Curated
 * matching is best-match (exact id, then stable prefix), ignoring "vendor/"
 * prefixes.
 *
 * Reasoning: Nano-GPT exposes thinking as separate "<model>:thinking" ids plus
 * effort-controllable families (o-series). Such models are marked reasoning:true
 * and pi sends reasoning_effort (forwarded to the upstream provider). Selecting a
 * ":thinking" variant is how always-on thinking is enabled.
 *
 * Thinking levels: /models?detailed=true reports each model's supported
 * reasoning_efforts using pi's own vocabulary ("none".."max"). Those are turned
 * into a per-model thinkingLevelMap so pi's /thinking command offers exactly the
 * levels the upstream supports — including the opt-in extended levels xhigh and
 * max, which pi hides by default. Unsupported levels are mapped to null (hidden
 * and clamped away by pi).
 *
 * pi's "max" is treated as "the model's maximum": pi only clamps selections
 * upward and nothing sits above max, so an unmapped max would silently send no
 * effort. Instead max is aliased to the highest tier the model reports (native
 * "max" when present, else xhigh/high/...), so defaultThinkingLevel "max"
 * always resolves to the model's ceiling.
 *
 * API key resolution: NANO_GPT_API_KEY env var wins; otherwise the key is read
 * from ~/.pi/agent/nano-gpt.json (see loadKeyFromFile). The file key is backfilled
 * into process.env so the provider's apiKey ("$NANO_GPT_API_KEY") resolves per
 * request with no escaping concerns for keys containing $ or !.
 *
 * Billing modes: /nano-gpt-subscription toggles between the standard
 * pay-as-you-go base (/api/v1, the default) and subscription-only
 * (/api/subscription/v1), which routes only subscription-included models and
 * bills their token quotas instead of the prepaid balance — it can never spend
 * the balance. The choice persists in nano-gpt.json ("subscriptionOnly") and
 * re-registers the provider immediately (no /reload needed).
 *
 * Zero Data Retention: /nano-gpt-zdr reads and switches the active inference
 * API key's server-side ZDR routing policy. NanoGPT exposes this as the
 * key-level `zdr_policy` setting ("zdr" or "off"), not a request field. The
 * extension discovers the active key's numeric id through GET /api/v1/usage,
 * then reads/patches that exact key through the Management API. This requires
 * a separate management token with api_keys:write, supplied through
 * NANO_GPT_MANAGEMENT_TOKEN or nano-gpt.json ("managementToken"). Changes are
 * live for every client using that inference key; no /reload is needed.
 *
 * Provider routing (pay-as-you-go only): /nano-gpt-provider pins the upstream
 * provider for the currently selected model via the X-Provider header
 * (explicit selection always bills pay-as-you-go at that provider's price),
 * and /nano-gpt-suffix sets a routing preference suffix (:fast, :cheap, ...)
 * appended to the model id. The two are mutually exclusive upstream (API error
 * speed_suffix_ambiguous_provider), so setting one clears the other. Both
 * persist per model under "routing" in nano-gpt.json and are applied only when
 * subscription-only is off.
 *
 * Service tiers: /nano-gpt-tier sets the selected model's Chat Completions
 * service_tier to default, flex, or priority. "auto" clears the override.
 * Choices persist per model in nano-gpt.json and take effect on the next
 * request, without re-registering the provider.
 *
 * Claude prompt caching: implicit caching covers OpenAI, Gemini, and many
 * open-source routes, but Claude requires an explicit helper. Pay-as-you-go
 * requests for Claude ids get promptCaching { enabled: true, ttl: "5m" },
 * which NanoGPT turns into cache breakpoints. The 5-minute TTL matches the
 * 1.25x cache-write rate the catalogue exposes; a 1-hour TTL is a 2x write
 * that pi's OpenAI usage parser cannot split into cacheWrite1h. Subscription
 * requests are left untouched: explicit Claude cache controls select
 * pay-as-you-go billing and bypass subscription coverage. The :caching suffix
 * only routes to a cache-capable provider; it does not write a Claude cache.
 *
 * Status bar: while a nano-gpt model is active, a persistent footer entry
 * (ctx.ui.setStatus) shows its routing choice and requested service tier. It
 * refreshes on model_select, session_start, and every mode change, and clears
 * whenever the active model is not served by nano-gpt.
 *
 * Enable by adding to ~/.pi/agent/settings.json:
 *   { "extensions": ["/path/to/pi-extension-nano-gpt"] }
 * Then /model → nano-gpt/<model-id>. Reload after editing the key file: /reload.
 *
 * NOTE (exposure): backfilling puts a file-only key into process.env, so it
 * becomes visible to subprocesses spawned by pi (including bash-tool commands
 * like `env`/`printenv`). If the key was already exported in your shell this
 * changes nothing; if it lived only in nano-gpt.json, this widens exposure.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Use the documented canonical host for discovery and inference together.
// The api.nano-gpt.com deployment can lag behind while still returning HTTP 200
// (e.g. its catalogue omitted MiMo V2.6), so it is not an equivalent alias.
// Two base paths select the billing mode:
//   - pay-as-you-go (default): /api/v1 — every visible model, prepaid-balance
//     billing at list price; provider routing overrides apply.
//   - subscription-only: /api/subscription/v1 — only models included in an
//     active NanoGPT subscription, billed against its token quotas, never the
//     prepaid balance; provider routing does not apply.
// (Docs: swap /api/v1 for /api/subscription/v1 — see chat-completion reference.)
const API_HOST = "https://nano-gpt.com";
const CONTROL_HOST = "https://nano-gpt.com";
const PAYGO_BASE_URL = `${API_HOST}/api/v1`;
const SUBSCRIPTION_BASE_URL = `${API_HOST}/api/subscription/v1`;
const CURRENT_KEY_USAGE_URL = `${CONTROL_HOST}/api/v1/usage`;
const MANAGEMENT_BASE_URL = `${CONTROL_HOST}/api/management/v1`;
const baseUrlFor = (subscriptionOnly: boolean) =>
  subscriptionOnly ? SUBSCRIPTION_BASE_URL : PAYGO_BASE_URL;
const PROVIDER_ID = "nano-gpt";
// Footer status-bar key for the routing indicator (bottom of the TUI).
const STATUS_KEY = "nano-gpt";

// Config dir: honors PI_CODING_AGENT_DIR, defaults to ~/.pi/agent.
const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const KEY_FILE = join(CONFIG_DIR, "nano-gpt.json");

// Per-request model-catalogue fetch budget. Startup must not hang if the network
// is slow; a stale/curated fallback keeps the provider usable.
const FETCH_TIMEOUT_MS = 15_000;

// Fallbacks used only when both the API and the curated overlay omit a value.
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
// The API reports cache-read and cache-write pricing per 1K tokens; pi's cost
// fields are per 1M.
const PER_1K_TO_PER_1M = 1_000;

// ---- Curated metadata overlay ---------------------------------------------
// Fallback for fields /models?detailed=true omits for a model (historically
// chiefly Anthropic cache-write pricing, which the API now exposes too; curated
// values only apply when the API lacks them). The API is authoritative for
// everything else. Applied on
// best-match: exact id first, then longest stable prefix, ignoring "vendor/".
// USD per 1M tokens at upstream list price (Nano-GPT charges at list price).
interface Curated {
  name?: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  vision?: boolean;
}

const CURATED: Record<string, Curated> = {
  // OpenAI
  "gpt-5": { name: "GPT-5", input: 1.25, output: 10, cacheRead: 0.125, contextWindow: 272_000, maxTokens: 128_000, reasoning: true, vision: true },
  "gpt-5-mini": { name: "GPT-5 Mini", input: 0.25, output: 2, cacheRead: 0.025, contextWindow: 272_000, maxTokens: 128_000, reasoning: true, vision: true },
  "gpt-5-nano": { name: "GPT-5 Nano", input: 0.05, output: 0.4, cacheRead: 0.005, contextWindow: 272_000, maxTokens: 128_000, reasoning: true, vision: true },
  "gpt-4.1": { name: "GPT-4.1", input: 2, output: 8, cacheRead: 0.5, contextWindow: 1_047_576, maxTokens: 32_768, vision: true },
  "gpt-4.1-mini": { name: "GPT-4.1 Mini", input: 0.4, output: 1.6, cacheRead: 0.1, contextWindow: 1_047_576, maxTokens: 32_768, vision: true },
  "gpt-4.1-nano": { name: "GPT-4.1 Nano", input: 0.1, output: 0.4, cacheRead: 0.025, contextWindow: 1_047_576, maxTokens: 32_768, vision: true },
  "gpt-4o": { name: "GPT-4o", input: 2.5, output: 10, cacheRead: 1.25, contextWindow: 128_000, maxTokens: 16_384, vision: true },
  "gpt-4o-mini": { name: "GPT-4o Mini", input: 0.15, output: 0.6, cacheRead: 0.075, contextWindow: 128_000, maxTokens: 16_384, vision: true },
  "o3": { name: "o3", input: 2, output: 8, cacheRead: 0.5, contextWindow: 200_000, maxTokens: 100_000, reasoning: true, vision: true },
  "o4-mini": { name: "o4-mini", input: 1.1, output: 4.4, cacheRead: 0.275, contextWindow: 200_000, maxTokens: 100_000, reasoning: true, vision: true },
  // Anthropic (vision-capable; thinking via :thinking variants or effort)
  "claude-opus-4-1": { name: "Claude Opus 4.1", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, contextWindow: 200_000, maxTokens: 32_000, vision: true },
  "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, contextWindow: 200_000, maxTokens: 64_000, vision: true },
  "claude-haiku-4-5": { name: "Claude Haiku 4.5", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, contextWindow: 200_000, maxTokens: 64_000, vision: true },
  // Google
  "gemini-2.5-pro": { name: "Gemini 2.5 Pro", input: 1.25, output: 10, cacheRead: 0.3125, contextWindow: 1_048_576, maxTokens: 65_536, reasoning: true, vision: true },
  "gemini-2.5-flash": { name: "Gemini 2.5 Flash", input: 0.3, output: 2.5, cacheRead: 0.075, contextWindow: 1_048_576, maxTokens: 65_536, reasoning: true, vision: true },
  // xAI
  "grok-4": { name: "Grok 4", input: 3, output: 15, contextWindow: 256_000, maxTokens: 16_384, vision: true },
  "grok-code-fast-1": { name: "Grok Code Fast 1", input: 0.2, output: 1.5, contextWindow: 256_000, maxTokens: 16_384 },
  // DeepSeek
  "deepseek-chat": { name: "DeepSeek V3", input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27, contextWindow: 64_000, maxTokens: 8_192 },
  "deepseek-reasoner": { name: "DeepSeek R1", input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55, contextWindow: 64_000, maxTokens: 8_192, reasoning: true },
  // Qwen
  "qwen3-235b-a22b": { name: "Qwen3 235B", input: 0.2, output: 0.6, contextWindow: 131_072, maxTokens: 8_192 },
};

// Longest-first so "gpt-4.1" wins over a hypothetical "gpt-4" before matching "gpt-4.1-mini".
const CURATED_BASES = Object.keys(CURATED).sort((a, b) => b.length - a.length);

// Match against the full id, then also against the segment after the last "/"
// because the catalogue uses "vendor/<model>" prefixes (e.g. "openai/gpt-4.1-nano")
// while curated keys are bare ("gpt-4.1-nano").
function matchCuratedBases(id: string): Curated | undefined {
  if (CURATED[id]) return CURATED[id];
  for (const base of CURATED_BASES) {
    // Match base as a whole token boundary: base followed by a separator or end.
    // The "." boundary also matches versioned ids ("gpt-5.6-sol" → "gpt-5"):
    // inert while the API prices those ids fully, but curated values would
    // leak into a versioned id if the API ever omitted a field for one.
    if (id === base || id.startsWith(base + "-") || id.startsWith(base + ".") || id.startsWith(base + ":")) {
      return CURATED[base];
    }
  }
  return undefined;
}

function matchCurated(id: string): Curated | undefined {
  return matchCuratedBases(id) ?? (id.includes("/") ? matchCuratedBases(id.slice(id.lastIndexOf("/") + 1)) : undefined);
}

// ---- Heuristics for non-curated models -------------------------------------
// Nano-GPT exposes thinking as a ":thinking" id segment — either a bare
// "<model>:thinking" (always-on) or an effort-baked "<model>:thinking:low|medium|max".
// Some families are effort-controllable via param with no id segment (o-series,
// *reasoner/*r1/*qwq). Detect the segment so effort-baked variants also render
// their thinking content.
const THINKING_SEGMENT = /:thinking(?::|$)/i;
const REASONING_FAMILY = /(^|[-/:_])(o\d+|reasoner|r1|qwq|deepseek-r)([-/:_]|$)/i;

function isReasoning(id: string, curated?: Curated): boolean {
  if (curated?.reasoning) return true;
  return THINKING_SEGMENT.test(id) || REASONING_FAMILY.test(id);
}

// ---- Thinking levels --------------------------------------------------------
// pi thinking levels are off|minimal|low|medium|high|xhigh|max. The extended
// levels (xhigh, max) are opt-in per model: pi only offers them in /thinking
// when thinkingLevelMap carries a non-null entry for them. Nano-GPT reports
// each model's supported efforts in reasoning_efforts using the same
// vocabulary — "none" being the provider's name for pi's "off" — so the map is
// generated straight from the API. Unsupported levels map to null, which hides
// them from the UI and lets pi clamp selections to a supported neighbour.
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

const EFFORT_FOR_LEVEL: Record<ThinkingLevel, string> = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

// Descending effort tiers ("none" excluded — it is the floor, not a maximum)
// used to resolve a model's ceiling when it lacks a literal "max" tier.
const EFFORT_TIERS_DESC = ["max", "xhigh", "high", "medium", "low", "minimal"] as const;

function buildThinkingLevelMap(efforts?: string[]): ThinkingLevelMap | undefined {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
  const supported = new Set(efforts.map((e) => e.trim().toLowerCase()));
  const map: ThinkingLevelMap = {};
  for (const level of Object.keys(EFFORT_FOR_LEVEL) as ThinkingLevel[]) {
    const effort = EFFORT_FOR_LEVEL[level];
    map[level] = supported.has(effort) ? effort : null;
  }
  // "max" means "the model's maximum", not only a literal upstream "max"
  // tier: pi clamps unsupported selections upward, but nothing sits above max,
  // so an unmapped max would end up sending no reasoning_effort at all. Alias it
  // to the highest reported tier — native "max" stays "max", an xhigh/high
  // ceiling resolves to xhigh/high.
  if (map.max === null) {
    const top = EFFORT_TIERS_DESC.find((effort) => supported.has(effort));
    if (top) map.max = top;
  }
  return map;
}

// ---- Model catalogue fetch -------------------------------------------------
// GET /models?detailed=true returns the OpenAI-basic fields plus, per model,
// context_length, max_output_tokens, pricing, capabilities, etc. All enhanced
// fields are optional (absent in basic mode or when unknown for a model).
// See https://docs.nano-gpt.com/api-reference/endpoint/models.
interface RemotePricing {
  prompt?: number; // per 1M tokens, USD
  completion?: number; // per 1M tokens, USD
  cacheReadInputPer1kTokens?: number; // per 1K tokens, USD (NOTE: per-1k!)
  cacheWriteInputPer1kTokens?: number; // per 1K tokens, USD (NOTE: per-1k!)
  currency?: string;
  unit?: string;
}

// GET /api/models/:id/providers reports long-context rates that
// /models?detailed=true omits. Rates here are per 1K tokens. The threshold is
// the prompt length above which the whole request uses the higher rates.
interface ProviderDefaultPrice {
  inputPer1kTokens?: number;
  outputPer1kTokens?: number;
  cacheReadInputPer1kTokens?: number;
  cacheWriteInputPer1kTokens?: number;
  inputPer1kTokensAboveFirstThreshold?: number;
  outputPer1kTokensAboveFirstThreshold?: number;
  cacheReadInputPer1kTokensAboveFirstThreshold?: number;
  cacheWriteInputPer1kTokensAboveFirstThreshold?: number;
  firstContextThresholdTokens?: number;
}

interface RemoteCapabilities {
  vision?: boolean;
  video_input?: boolean;
  audio_input?: boolean;
  reasoning?: boolean;
  tool_calling?: boolean;
  parallel_tool_calls?: boolean;
  structured_output?: boolean;
  pdf_upload?: boolean;
}

interface RemoteArchitecture {
  modality?: string;
  input_modalities?: string[];
  output_modalities?: string[];
}

interface RemoteModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  // Enhanced (detailed=true) fields — all optional.
  name?: string;
  description?: string;
  context_length?: number | null; // max input tokens (null if unknown)
  max_output_tokens?: number | null;
  architecture?: RemoteArchitecture;
  capabilities?: RemoteCapabilities;
  reasoning_efforts?: string[];
  providers?: string[];
  pricing?: RemotePricing;
  open_weights?: boolean;
  icon_url?: string;
  category?: string;
}

async function fetchRemoteModels(baseUrl: string): Promise<RemoteModel[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // detailed=true returns context_length, max_output_tokens, pricing, and
    // capabilities per model. Auth is optional; without it we get upstream list
    // price, which matches pay-as-you-go API billing.
    const res = await fetch(`${baseUrl}/models?detailed=true`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const payload = (await res.json()) as { data?: RemoteModel[] };
    const data = payload.data;
    if (!Array.isArray(data) || data.length === 0) return undefined;
    return data.filter((m) => typeof m?.id === "string");
  } catch {
    return undefined; // network/timeout/abort → fall back to curated ids
  } finally {
    clearTimeout(timer);
  }
}

function prettyName(id: string, remoteName?: string, curated?: Curated): string {
  if (remoteName) return remoteName;
  if (curated?.name) return curated.name;
  // "vendor/model:thinking" → "model:thinking"; leave bare ids untouched.
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PiModel {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: CostRates & { tiers?: Array<CostRates & { inputTokensAbove: number }> };
  // Claude's explicit helper uses a 5-minute TTL. Declaring it lets pi keep an
  // idle cache warm; long retention is unset because this extension does not
  // request the 1-hour TTL.
  promptCache?: { short: number };
  contextWindow: number;
  maxTokens: number;
  compat: Record<string, unknown>;
}

// 5 minutes, matching promptCaching.ttl "5m".
const CLAUDE_CACHE_TTL_SECONDS = 300;

// Claude ids use explicit cache controls. Strip routing suffixes so
// "anthropic/claude-haiku-5.5:thinking:fast" still matches.
function isClaudeModel(id: string): boolean {
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return bare === "claude" || bare.startsWith("claude-") || bare.startsWith("claude:");
}

function per1kToPer1m(value: number | undefined): number | undefined {
  return value != null && Number.isFinite(value) ? value * PER_1K_TO_PER_1M : undefined;
}

// A long-context tier applies only when the provider endpoint reports a
// threshold and at least one rate that differs from the base. Missing above-
// threshold fields keep the base rate, matching how NanoGPT bills that token
// type when it omits the higher price.
function longContextTier(price: ProviderDefaultPrice | undefined, base: CostRates): PiModel["cost"]["tiers"] {
  const threshold = price?.firstContextThresholdTokens;
  if (threshold == null || !Number.isFinite(threshold) || threshold <= 0) return undefined;
  const tier: CostRates & { inputTokensAbove: number } = {
    inputTokensAbove: threshold,
    input: per1kToPer1m(price?.inputPer1kTokensAboveFirstThreshold) ?? base.input,
    output: per1kToPer1m(price?.outputPer1kTokensAboveFirstThreshold) ?? base.output,
    cacheRead: per1kToPer1m(price?.cacheReadInputPer1kTokensAboveFirstThreshold) ?? base.cacheRead,
    cacheWrite: per1kToPer1m(price?.cacheWriteInputPer1kTokensAboveFirstThreshold) ?? base.cacheWrite,
  };
  const sameAsBase =
    tier.input === base.input &&
    tier.output === base.output &&
    tier.cacheRead === base.cacheRead &&
    tier.cacheWrite === base.cacheWrite;
  return sameAsBase ? undefined : [tier];
}

function buildModel(remote: RemoteModel, providerPrice?: ProviderDefaultPrice): PiModel {
  const id = remote.id;
  const curated = matchCurated(id);

  // The API is authoritative; CURATED only fills fields it omits (e.g. Anthropic
  // cache-write pricing) or backs up a missing API value.
  const caps = remote.capabilities;
  const inputModalities = remote.architecture?.input_modalities ?? [];
  const vision =
    caps?.vision === true || inputModalities.includes("image") || curated?.vision === true;
  const apiReasoning =
    caps?.reasoning === true ||
    (Array.isArray(remote.reasoning_efforts) && remote.reasoning_efforts.length > 0);
  const reasoning = apiReasoning || isReasoning(id, curated);
  // Efforts straight from the API: unlocks xhigh/max in /thinking for models
  // that support them and hides levels the upstream rejects.
  const levelMap = buildThinkingLevelMap(remote.reasoning_efforts);

  const pricing = remote.pricing;
  // prompt/completion are per 1M (unit:"per_million_tokens"); cache-read and
  // cache-write are reported per 1K and must be scaled to per-1M for pi's cost
  // fields. Curated values only fill in when the API omits them.
  const cacheRead =
    pricing?.cacheReadInputPer1kTokens != null
      ? pricing.cacheReadInputPer1kTokens * PER_1K_TO_PER_1M
      : (curated?.cacheRead ?? 0);
  const cacheWrite =
    pricing?.cacheWriteInputPer1kTokens != null
      ? pricing.cacheWriteInputPer1kTokens * PER_1K_TO_PER_1M
      : (curated?.cacheWrite ?? 0);
  const cost: PiModel["cost"] = {
    input: pricing?.prompt ?? curated?.input ?? 0,
    output: pricing?.completion ?? curated?.output ?? 0,
    cacheRead,
    cacheWrite,
  };
  const tiers = longContextTier(providerPrice, cost);
  if (tiers) cost.tiers = tiers;
  const claude = isClaudeModel(id);

  return {
    id,
    name: prettyName(id, remote.name, curated),
    reasoning,
    ...(levelMap ? { thinkingLevelMap: levelMap } : {}),
    input: vision ? ["text", "image"] : ["text"],
    cost,
    ...(claude ? { promptCache: { short: CLAUDE_CACHE_TTL_SECONDS } } : {}),
    contextWindow: remote.context_length ?? curated?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: remote.max_output_tokens ?? curated?.maxTokens ?? DEFAULT_MAX_TOKENS,
    compat: {
      supportsUsageInStreaming: true, // Nano-GPT returns usage → cost tracking works
      ...(reasoning ? { supportsReasoningEffort: true } : {}), // send reasoning_effort
    },
  };
}

// Fallback catalogue used only if the public /models endpoint is unreachable.
function fallbackModels(): PiModel[] {
  return CURATED_BASES.map((base) => buildModel({ id: base }));
}

// ---- Overflow normalization ------------------------------------------------
// pi auto-compacts + retries only when errorMessage matches known overflow
// patterns. Nano-GPT forwards upstream backend errors in its own wrapper;
// normalize them so recovery can trigger. Rate-limit errors are excluded so they
// stay on pi's normal retry-with-backoff path.
const OVERFLOW_PATTERN =
  /context_length_exceeded|context window (?:exceeds?|limit)|(?:exceeds?|exceeded|longer than)[^.]*(?:context length|token)|maximum context length|prompt is too long|input (?:length|token count)[^.]*exceeds|exceeded model token limit|exceeds? the limit of \d+|too many (?:input )?tokens|reduce the length of the messages/i;
const RATE_LIMIT_PATTERN = /rate limit|too many requests|throttl|quota|\b429\b|slow down|insufficient/i;

// ---- API key resolution ----------------------------------------------------
// NANO_GPT_API_KEY env var wins; otherwise fall back to ~/.pi/agent/nano-gpt.json.
// Supported JSON shapes (mirrors cline.ts convention):
//   { "apiKey": "..." }          (canonical)
//   { "api_key": "..." }
//   { "nanoGptApiKey": "..." }   / { "nano_gpt_api_key": "..." }
//   { "key": "..." }
//   "...bare string..."          (the whole file is a JSON string)
function loadKeyFromFile(): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(KEY_FILE, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed === "string") return parsed.trim() || undefined;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const field of ["apiKey", "api_key", "nanoGptApiKey", "nano_gpt_api_key", "key"]) {
      const v = obj[field];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}

// The key file ships with a template placeholder; treat it as unset so the user
// gets a clear notification to paste their real key instead of silent 401s.
function isPlaceholderKey(key: string): boolean {
  return /^REPLACE_WITH/i.test(key.trim());
}

// ---- Persisted configuration (nano-gpt.json) --------------------------------
// The key file doubles as the extension's config store; unknown fields ride
// along untouched on writes. A bare JSON string file (legacy key-only shape) is
// migrated to { "apiKey": ... } the first time we persist anything.
interface RoutingPref {
  provider?: string; // upstream provider id sent as X-Provider (paygo only)
  suffix?: string; // routing preference suffix appended to the model id
}

type ServiceTier = "default" | "flex" | "priority";
const SERVICE_TIER_CHOICES = ["auto", "default", "flex", "priority"] as const;

function isServiceTier(value: unknown): value is ServiceTier {
  return value === "default" || value === "flex" || value === "priority";
}

interface PersistedConfig {
  subscriptionOnly?: boolean;
  routing?: Record<string, RoutingPref>; // keyed by model id
  serviceTiers?: Record<string, ServiceTier>; // keyed by exact model id
}

function readRawConfig(): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(KEY_FILE, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ZDR policy changes use a separate Management API credential. Environment
// wins, as with the inference key; unlike that key, a file-only management
// token is not copied into process.env and therefore is not inherited by
// subprocesses. The token needs the api_keys:write scope.
function loadManagementToken(): string | undefined {
  const envToken = process.env.NANO_GPT_MANAGEMENT_TOKEN?.trim();
  if (envToken) return envToken;
  const obj = readRawConfig();
  if (!obj) return undefined;
  for (const field of [
    "managementToken",
    "management_token",
    "nanoGptManagementToken",
    "nano_gpt_management_token",
  ]) {
    const value = obj[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readPersistedConfig(): PersistedConfig {
  const obj = readRawConfig();
  if (!obj) return {};
  const cfg: PersistedConfig = {};
  if (typeof obj.subscriptionOnly === "boolean") cfg.subscriptionOnly = obj.subscriptionOnly;
  if (obj.routing && typeof obj.routing === "object") {
    const routing: Record<string, RoutingPref> = {};
    for (const [modelId, v] of Object.entries(obj.routing as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const pref = v as Record<string, unknown>;
      // Provider and suffix are mutually exclusive upstream; normalize
      // hand-edited configs by keeping the provider when both are present.
      if (typeof pref.provider === "string" && pref.provider.trim()) {
        routing[modelId] = { provider: pref.provider.trim() };
      } else if (typeof pref.suffix === "string" && pref.suffix.trim()) {
        routing[modelId] = { suffix: pref.suffix.trim() };
      }
    }
    if (Object.keys(routing).length > 0) cfg.routing = routing;
  }
  if (obj.serviceTiers && typeof obj.serviceTiers === "object") {
    const tiers: Record<string, ServiceTier> = {};
    for (const [modelId, value] of Object.entries(obj.serviceTiers as Record<string, unknown>)) {
      if (isServiceTier(value)) tiers[modelId] = value;
    }
    if (Object.keys(tiers).length > 0) cfg.serviceTiers = tiers;
  }
  return cfg;
}

function savePersistedConfig(patch: PersistedConfig): boolean {
  const seed: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(KEY_FILE, "utf8"));
    if (parsed && typeof parsed === "object") {
      Object.assign(seed, parsed as Record<string, unknown>);
    } else if (typeof parsed === "string" && parsed.trim()) {
      seed.apiKey = parsed.trim();
    }
  } catch {
    // Missing/unreadable file: start from scratch.
  }
  if (patch.subscriptionOnly !== undefined) seed.subscriptionOnly = patch.subscriptionOnly;
  if (patch.routing !== undefined) seed.routing = patch.routing; // full map replace
  if (patch.serviceTiers !== undefined) seed.serviceTiers = patch.serviceTiers; // full map replace
  try {
    writeFileSync(KEY_FILE, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ---- Zero Data Retention policy -------------------------------------------
// ZDR is enforced by NanoGPT as an inference-API-key policy. There is no
// per-request ZDR header/body field, so the switch uses the scoped Management
// API. GET /api/v1/usage tells us the numeric id of the inference key used by
// this extension; that avoids asking the user to copy or guess an id when they
// own multiple keys.
type ZdrPolicy = "zdr" | "off" | "unset";

interface ManagedApiKey {
  id: string;
  name: string;
  status: "active" | "expired";
  zdr_policy: ZdrPolicy;
}

interface NanoGptErrorBody {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    type?: string;
  };
}

function isZdrPolicy(value: unknown): value is ZdrPolicy {
  return value === "zdr" || value === "off" || value === "unset";
}

async function responseError(res: Response): Promise<string> {
  let body: NanoGptErrorBody | undefined;
  try {
    body = (await res.json()) as NanoGptErrorBody;
  } catch {
    // A proxy may return HTML/plain text. The status is still useful.
  }
  const code = body?.error?.code ?? body?.error?.type;
  const message = body?.error?.message || res.statusText || "request failed";
  const requestId = body?.error?.request_id ?? res.headers.get("x-request-id");
  return `${res.status}${code ? ` ${code}` : ""}: ${message}${requestId ? ` (request ${requestId})` : ""}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverCurrentApiKeyId(apiKey: string): Promise<string> {
  // Bound aggregation work to today; only apiKey.id is consumed.
  const today = new Date().toISOString().slice(0, 10);
  const query = new URLSearchParams({ from: today, to: today, group_by: "day" });
  const res = await fetchWithTimeout(`${CURRENT_KEY_USAGE_URL}?${query}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) throw new Error(`could not identify the active API key — ${await responseError(res)}`);
  const payload = (await res.json()) as { apiKey?: { id?: string | number } };
  const id = payload.apiKey?.id;
  const normalized = typeof id === "number" ? String(id) : id?.trim();
  if (!normalized || !/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error("Usage API response did not include a valid apiKey.id");
  }
  return normalized;
}

function parseManagedApiKey(payload: unknown): ManagedApiKey {
  if (!payload || typeof payload !== "object") {
    throw new Error("Management API returned an invalid API-key response");
  }
  const obj = payload as Record<string, unknown>;
  const rawId = obj.id;
  const id = typeof rawId === "number" ? String(rawId) : typeof rawId === "string" ? rawId : "";
  if (
    !/^[1-9][0-9]*$/.test(id) ||
    typeof obj.name !== "string" ||
    (obj.status !== "active" && obj.status !== "expired") ||
    !isZdrPolicy(obj.zdr_policy)
  ) {
    throw new Error("Management API returned incomplete API-key metadata");
  }
  return {
    id,
    name: obj.name,
    status: obj.status,
    zdr_policy: obj.zdr_policy,
  };
}

async function getManagedApiKey(token: string, keyId: string): Promise<ManagedApiKey> {
  const res = await fetchWithTimeout(`${MANAGEMENT_BASE_URL}/api-keys/${encodeURIComponent(keyId)}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(`could not read API-key ZDR policy — ${await responseError(res)}`);
  const key = parseManagedApiKey(await res.json());
  if (key.id !== keyId) throw new Error("Management API returned metadata for an unexpected API key");
  return key;
}

async function updateManagedApiKeyZdr(
  token: string,
  keyId: string,
  policy: Exclude<ZdrPolicy, "unset">,
): Promise<ManagedApiKey> {
  const res = await fetchWithTimeout(`${MANAGEMENT_BASE_URL}/api-keys/${encodeURIComponent(keyId)}`, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ zdr_policy: policy }),
  });
  if (!res.ok) throw new Error(`could not update API-key ZDR policy — ${await responseError(res)}`);
  const key = parseManagedApiKey(await res.json());
  if (key.id !== keyId) throw new Error("Management API updated an unexpected API key");
  if (key.zdr_policy !== policy) throw new Error("Management API did not apply the requested ZDR policy");
  return key;
}

function zdrPolicyLabel(policy: ZdrPolicy): string {
  if (policy === "zdr") return "ON (ZDR-only)";
  if (policy === "off") return "OFF (Anonymized)";
  return "UNSET (legacy account default)";
}

// ---- Routing suffixes -------------------------------------------------------
// https://docs.nano-gpt.com/api-reference/miscellaneous/model-suffixes
// Aliases normalize to a canonical short form. Suffixes (and explicit provider
// selection) apply only to provider-selection-capable models; on other models
// the upstream ignores them. Exclusive with an explicit provider.
const ROUTING_SUFFIXES = ["fast", "cheap", "throughput", "latency", "tools", "caching"] as const;
type RoutingSuffix = (typeof ROUTING_SUFFIXES)[number];
const ROUTING_SUFFIX_ALIASES: Record<string, RoutingSuffix> = {
  speed: "fast",
  fast: "fast",
  price: "cheap",
  cheap: "cheap",
  floor: "cheap",
  throughput: "throughput",
  latency: "latency",
  tools: "tools",
  caching: "caching",
  cache: "caching",
  cached: "caching",
};
const SUFFIX_MEANING: Record<RoutingSuffix, string> = {
  fast: "best estimated completion time (TTFT + TPS)",
  cheap: "cheapest provider by base input+output price",
  throughput: "highest tokens per second",
  latency: "lowest time to first token",
  tools: "tools-capable provider path",
  caching: "cache-capable provider",
};

// ---- Provider discovery -----------------------------------------------------
// GET /api/models/:canonicalId/providers lists the upstream providers a
// provider-selection-capable model can be pinned to, with the per-provider
// price actually paid and route-level privacy classification. The path is NOT
// under /api/v1 and the model id must be URL-encoded (its "/" is a path
// separator otherwise).
// https://docs.nano-gpt.com/api-reference/miscellaneous/provider-selection
interface ProviderRow {
  provider: string;
  available?: boolean;
  quantization?: string;
  region?: { code?: string; label?: string };
  pricing?: { inputPer1kTokens?: number; outputPer1kTokens?: number };
  privacy?: {
    classification?: string;
    retainsPrompts?: boolean;
    training?: boolean;
  };
}

interface ProviderDiscovery {
  supportsProviderSelection: boolean;
  rows: ProviderRow[];
}

// A discovery attempt either parsed into a ProviderDiscovery or failed for a
// named reason (network/timeout/abort, HTTP error status, malformed body). The
// split lets callers say "could not check" instead of conflating it with an
// empty answer — a network failure must not read as "no providers available".
type ProviderDiscoveryResult =
  | { kind: "ok"; discovery: ProviderDiscovery }
  | { kind: "failed"; reason: string };

// Long-context rates are not on /models?detailed=true. One discovery call per
// Claude id is bounded; a failure leaves the base rates in place rather than
// blocking catalogue registration. The endpoint is public and not under /api/v1.
async function fetchProviderPrice(modelId: string): Promise<ProviderDefaultPrice | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_HOST}/api/models/${encodeURIComponent(modelId)}/providers`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const payload = (await res.json()) as { defaultPrice?: ProviderDefaultPrice };
    const price = payload.defaultPrice;
    return price && typeof price === "object" ? price : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverProviders(modelId: string): Promise<ProviderDiscoveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_HOST}/api/models/${encodeURIComponent(modelId)}/providers`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { kind: "failed", reason: await responseError(res) };
    }
    const payload = (await res.json()) as {
      supportsProviderSelection?: boolean;
      providers?: unknown;
    };
    if (!payload || typeof payload !== "object") {
      return { kind: "failed", reason: "unexpected provider discovery response shape" };
    }
    const rows = Array.isArray(payload.providers)
      ? payload.providers.filter(
          (p): p is ProviderRow => !!p && typeof (p as ProviderRow).provider === "string",
        )
      : [];
    return {
      kind: "ok",
      discovery: { supportsProviderSelection: payload.supportsProviderSelection === true, rows },
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
    return { kind: "failed", reason };
  } finally {
    clearTimeout(timer);
  }
}

function providerPricePer1k(row: ProviderRow): number {
  const i = row.pricing?.inputPer1kTokens;
  const o = row.pricing?.outputPer1kTokens;
  return i != null && o != null ? i + o : Number.POSITIVE_INFINITY;
}

function providerPrivacyLabel(row: ProviderRow): string {
  switch (row.privacy?.classification) {
    case "zdr":
      return "ZDR";
    case "no_training":
      return "non-ZDR · no training";
    case "logs_training_unknown":
      return "non-ZDR · logs · training unknown";
    case "logs_training":
      return "non-ZDR · logs + training";
    default:
      // Only NanoGPT's explicit `zdr` classification earns the ZDR label.
      return "ZDR unknown";
  }
}

function providerRowLabel(row: ProviderRow): string {
  const i = row.pricing?.inputPer1kTokens;
  const o = row.pricing?.outputPer1kTokens;
  const price =
    i != null && o != null
      ? ` · $${(i * 1000).toFixed(2)}/$${(o * 1000).toFixed(2)} per 1M`
      : "";
  const quant = row.quantization && row.quantization !== "unknown" ? ` · ${row.quantization}` : "";
  const region = row.region?.code ? ` · ${row.region.code}` : "";
  return `${row.provider} · ${providerPrivacyLabel(row)}${price}${quant}${region}`;
}

let keyMissing = false;
let catalogSource: "fetched" | "fallback" = "fallback";
// In-memory mirror of the persisted prefs; commands keep both in sync.
let subscriptionOnly = false;
let routingPrefs: Record<string, RoutingPref> = {};
let serviceTiers: Record<string, ServiceTier> = {};

export default async function (pi: ExtensionAPI) {
  // Persisted prefs (billing mode, routing, and tiers) load before the provider
  // registration so the right base URL and catalogue are used from the start.
  const persisted = readPersistedConfig();
  subscriptionOnly = persisted.subscriptionOnly === true;
  routingPrefs = persisted.routing ?? {};
  serviceTiers = persisted.serviceTiers ?? {};

  // Prefer the env var; fall back to the JSON file. Backfilling process.env keeps
  // the provider's apiKey ("$NANO_GPT_API_KEY") resolving per request.
  if (!process.env.NANO_GPT_API_KEY) {
    const fileKey = loadKeyFromFile();
    if (fileKey) process.env.NANO_GPT_API_KEY = fileKey;
  }

  const apiKey = process.env.NANO_GPT_API_KEY;
  if (!apiKey || isPlaceholderKey(apiKey)) {
    keyMissing = true;
    console.error(`[nano-gpt] no NANO_GPT_API_KEY env var and no key in ${KEY_FILE}`);
  }

  // Register (or re-register) the provider for the current billing mode.
  // During the factory this queues a normal startup registration; when called
  // later from a command handler it takes effect immediately — no /reload.
  const registerProviderForMode = async (): Promise<PiModel[]> => {
    const base = baseUrlFor(subscriptionOnly);
    const remote = await fetchRemoteModels(base);
    let models: PiModel[];
    if (remote && remote.length) {
      catalogSource = "fetched";
      // De-dup by id, keep deterministic order (case-insensitive by id).
      const seen = new Set<string>();
      const unique = remote
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
      // Only Claude ids have the long-context rates this lookup exists for,
      // and only their requests opt into explicit caching below.
      const providerPrices = new Map<string, ProviderDefaultPrice>();
      await Promise.all(
        unique.filter((m) => isClaudeModel(m.id)).map(async (m) => {
          const price = await fetchProviderPrice(m.id);
          if (price) providerPrices.set(m.id, price);
        }),
      );
      models = unique.map((m) => buildModel(m, providerPrices.get(m.id)));
    } else {
      catalogSource = "fallback";
      models = fallbackModels();
    }
    pi.registerProvider(PROVIDER_ID, {
      name: "Nano-GPT",
      baseUrl: base,
      api: "openai-completions",
      apiKey: "$NANO_GPT_API_KEY", // resolved per request
      authHeader: true, // sends "Authorization: Bearer <key>"
      models,
    });
    return models;
  };

  if (!keyMissing) await registerProviderForMode();

  // Resolved lazily because most sessions never open the ZDR switch. The
  // inference key cannot change within a loaded extension; /reload creates a
  // fresh instance if the user changes it.
  let currentApiKeyId: string | undefined;
  const getCurrentApiKeyId = async (): Promise<string> => {
    if (currentApiKeyId) return currentApiKeyId;
    if (!apiKey || isPlaceholderKey(apiKey)) throw new Error("no inference API key is configured");
    currentApiKeyId = await discoverCurrentApiKeyId(apiKey);
    return currentApiKeyId;
  };

  // Minimal structural ctx shared by the helpers below: enough for notify and
  // status-bar updates. Both command handlers and event handlers receive a
  // full context that satisfies this shape.
  type UiCtx = {
    hasUI: boolean;
    mode?: string;
    model?: { id: string; provider: string } | undefined;
    ui: {
      notify: (msg: string, type?: "info" | "warning" | "error") => void;
      setStatus: (key: string, text: string | undefined) => void;
      theme?: { fg: (color: string, text: string) => string };
    };
  };

  // ---- Status-bar routing indicator -----------------------------------------
  // Persistent footer entry making the active model's Nano-GPT routing and
  // requested service tier visible. Routing is hidden in subscription-only mode.
  // Cleared whenever a non-nano-gpt model is active. Pass the model explicitly
  // when it is known from the event; ctx.model is the fallback.
  const updateStatus = (ctx: UiCtx, model?: { id: string; provider: string }): void => {
    if (!ctx.hasUI) return;
    const active = model ?? ctx.model;
    if (!active || active.provider !== PROVIDER_ID) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    let label: string;
    if (subscriptionOnly) {
      label = "subscription";
    } else {
      const pref = routingPrefs[active.id];
      label = pref?.provider ?? (pref?.suffix ? `:${pref.suffix}` : "auto");
    }
    const tier = serviceTiers[active.id];
    if (tier) label += ` · tier ${tier}`;
    // Theme colors only in TUI mode; RPC clients get the plain string (theme
    // ANSI codes would otherwise leak into extension_ui_request payloads).
    const themed =
      ctx.mode === "tui" && ctx.ui.theme
        ? ctx.ui.theme.fg("accent", "nano-gpt") + ctx.ui.theme.fg("dim", ` · ${label}`)
        : `nano-gpt · ${label}`;
    ctx.ui.setStatus(STATUS_KEY, themed);
  };

  // Per-model routing writes: re-read the file and merge so entries changed on
  // disk after startup (hand edits, another pi instance) survive; only the
  // affected model's entry is touched. Memory mirrors the merged map. The
  // footer indicator refreshes on every successful write.
  const setRouting = (ctx: UiCtx, modelId: string, pref: RoutingPref | undefined): boolean => {
    const routing = { ...(readPersistedConfig().routing ?? {}) };
    if (pref) routing[modelId] = pref;
    else delete routing[modelId];
    routingPrefs = routing;
    if (savePersistedConfig({ routing })) {
      updateStatus(ctx);
      return true;
    }
    ctx.ui.notify(`[nano-gpt] could not write routing prefs to ${KEY_FILE}`, "warning");
    return false;
  };

  // Tier choices are per exact model id and affect only future requests. Merge
  // with the current file so a different pi instance's entries survive.
  const setServiceTier = (ctx: UiCtx, modelId: string, tier: ServiceTier | undefined): void => {
    const tiers = { ...(readPersistedConfig().serviceTiers ?? {}) };
    if (tier) tiers[modelId] = tier;
    else delete tiers[modelId];
    serviceTiers = tiers;
    if (!savePersistedConfig({ serviceTiers: tiers })) {
      ctx.ui.notify(`[nano-gpt] could not write ${KEY_FILE} — tier choice reverts on reload`, "warning");
    }
    updateStatus(ctx);
  };

  // ---- /nano-gpt-subscription ----------------------------------------------
  // Toggle billing mode: off (default) = standard /api/v1 pay-as-you-go;
  // on = subscription-only /api/subscription/v1 (quota billing, no balance
  // spend). Persists and re-registers the provider immediately.
  pi.registerCommand("nano-gpt-subscription", {
    description: "Toggle NanoGPT subscription-only billing: on|off (default off)",
    getArgumentCompletions: (prefix: string) =>
      ["on", "off"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      if (keyMissing) {
        ctx.ui.notify("[nano-gpt] no API key — configure one first", "warning");
        return;
      }
      let arg = args.trim().toLowerCase();
      if (!arg) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `[nano-gpt] subscription-only is ${subscriptionOnly ? "ON" : "OFF"}. Usage: /nano-gpt-subscription on|off`,
            "info",
          );
          return;
        }
        const choice = await ctx.ui.select(
          `NanoGPT billing mode (currently ${subscriptionOnly ? "ON" : "OFF"})`,
          [
            "on — subscription-only: quota billing, subscription models only",
            "off — standard: pay-as-you-go, all models (default)",
          ],
        );
        if (!choice) return;
        arg = choice.startsWith("on") ? "on" : "off";
      }
      if (arg !== "on" && arg !== "off") {
        ctx.ui.notify("[nano-gpt] usage: /nano-gpt-subscription on|off", "warning");
        return;
      }
      const next = arg === "on";
      if (next === subscriptionOnly) {
        ctx.ui.notify(`[nano-gpt] subscription-only already ${next ? "ON" : "OFF"}`, "info");
        return;
      }
      subscriptionOnly = next;
      if (!savePersistedConfig({ subscriptionOnly })) {
        ctx.ui.notify(`[nano-gpt] could not write ${KEY_FILE} — mode reverts on reload`, "warning");
      }
      ctx.ui.notify(
        `[nano-gpt] subscription-only ${next ? "ON" : "OFF"} — base URL ${baseUrlFor(next)}, refreshing catalogue...`,
        "info",
      );
      const models = await registerProviderForMode();
      updateStatus(ctx); // indicator switches between "subscription" and routing
      if (catalogSource === "fallback") {
        ctx.ui.notify(
          "[nano-gpt] live catalogue unreachable — showing the curated fallback list, which may not match this billing mode's real catalogue",
          "warning",
        );
      }
      const current = ctx.model;
      if (current && current.provider === PROVIDER_ID && !models.some((m) => m.id === current.id)) {
        ctx.ui.notify(
          `[nano-gpt] current model ${current.id} is not in the ${next ? "subscription" : "standard"} catalogue — run /model to pick another`,
          "warning",
        );
      }
    },
  });

  // ---- /nano-gpt-tier ------------------------------------------------------
  // Set the selected model's Chat Completions service_tier on the next request.
  // "auto" omits the field, preserving NanoGPT's normal routing behavior.
  pi.registerCommand("nano-gpt-tier", {
    description: "Switch service tier for the selected NanoGPT model: auto|default|flex|priority",
    getArgumentCompletions: (prefix: string) =>
      [...SERVICE_TIER_CHOICES, "status"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      if (keyMissing) {
        ctx.ui.notify("[nano-gpt] no API key — configure one first", "warning");
        return;
      }
      const model = ctx.model;
      if (!model || model.provider !== PROVIDER_ID) {
        ctx.ui.notify("[nano-gpt] select a nano-gpt model first (/model)", "warning");
        return;
      }
      const current = serviceTiers[model.id] ?? "auto";
      let arg = args.trim().toLowerCase();
      if (arg === "status" || (!arg && !ctx.hasUI)) {
        ctx.ui.notify(
          `[nano-gpt] ${model.id}: service tier ${current}. Usage: /nano-gpt-tier auto|default|flex|priority`,
          "info",
        );
        return;
      }
      if (!arg) {
        const labels = [
          `auto — NanoGPT's default tier (no service_tier field)${current === "auto" ? " (current)" : ""}`,
          `default — standard processing${current === "default" ? " (current)" : ""}`,
          `flex — lower cost where supported; may take longer${current === "flex" ? " (current)" : ""}`,
          `priority — faster processing where supported; priority rates${current === "priority" ? " (current)" : ""}`,
        ];
        const choice = await ctx.ui.select(`Service tier for ${model.id}`, labels);
        if (!choice) return;
        arg = choice.split(" — ")[0] as string;
      }
      if (arg !== "auto" && !isServiceTier(arg)) {
        ctx.ui.notify("[nano-gpt] usage: /nano-gpt-tier auto|default|flex|priority|status", "warning");
        return;
      }
      if (arg === current) {
        ctx.ui.notify(`[nano-gpt] ${model.id}: service tier already ${current}`, "info");
        return;
      }
      setServiceTier(ctx, model.id, arg === "auto" ? undefined : arg);
      const note = arg === "auto"
        ? "NanoGPT chooses the tier"
        : "requested on the next request; the routed provider determines availability";
      ctx.ui.notify(`[nano-gpt] ${model.id}: service tier ${arg} — ${note}`, "info");
    },
  });

  // ---- /nano-gpt-zdr -------------------------------------------------------
  // Read or switch the active inference key's live server-side policy. "on"
  // fails closed when a request has no eligible ZDR provider route; "off" is
  // called Anonymized by NanoGPT and restores ordinary provider routing.
  pi.registerCommand("nano-gpt-zdr", {
    description: "Switch NanoGPT Zero Data Retention routing: on|off|status",
    getArgumentCompletions: (prefix: string) =>
      ["on", "off", "status"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      if (keyMissing) {
        ctx.ui.notify("[nano-gpt] no API key — configure one first", "warning");
        return;
      }
      const managementToken = loadManagementToken();
      if (!managementToken) {
        ctx.ui.notify(
          `[nano-gpt] ZDR switching needs an api_keys:write Management API token in NANO_GPT_MANAGEMENT_TOKEN or ${KEY_FILE} ("managementToken")`,
          "warning",
        );
        return;
      }

      let arg = args.trim().toLowerCase();
      if (arg && arg !== "on" && arg !== "off" && arg !== "status") {
        ctx.ui.notify("[nano-gpt] usage: /nano-gpt-zdr on|off|status", "warning");
        return;
      }

      try {
        const keyId = await getCurrentApiKeyId();
        const current = await getManagedApiKey(managementToken, keyId);
        if (current.status !== "active") {
          ctx.ui.notify(`[nano-gpt] API key ${current.name} (#${keyId}) is ${current.status}`, "error");
          return;
        }

        if (arg === "status" || (!arg && !ctx.hasUI)) {
          ctx.ui.notify(
            `[nano-gpt] API-key ZDR policy is ${zdrPolicyLabel(current.zdr_policy)} for ${current.name} (#${keyId})`,
            "info",
          );
          return;
        }

        if (!arg) {
          const onCurrent = current.zdr_policy === "zdr" ? " (current)" : "";
          const offCurrent = current.zdr_policy === "off" ? " (current)" : "";
          const choice = await ctx.ui.select(
            `NanoGPT API-key ZDR routing for ${current.name} (#${keyId})`,
            [
              `on — ZDR-only routes; fail if none qualify${onCurrent}`,
              `off — Anonymized standard routing${offCurrent}`,
            ],
          );
          if (!choice) return;
          arg = choice.startsWith("on") ? "on" : "off";
        }

        const next: Exclude<ZdrPolicy, "unset"> = arg === "on" ? "zdr" : "off";
        if (current.zdr_policy === next) {
          ctx.ui.notify(
            `[nano-gpt] API-key ZDR policy already ${zdrPolicyLabel(current.zdr_policy)} for ${current.name} (#${keyId})`,
            "info",
          );
          return;
        }

        const updated = await updateManagedApiKeyZdr(managementToken, keyId, next);
        const teamNote = updated.zdr_policy === "off" ? "; team ZDR minimums still apply" : "";
        ctx.ui.notify(
          `[nano-gpt] API-key ZDR policy ${zdrPolicyLabel(updated.zdr_policy)} for ${updated.name} (#${keyId}) — applies to the next request${teamNote}`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`[nano-gpt] ZDR switch failed: ${message}`, "error");
      }
    },
  });

  // ---- /nano-gpt-provider --------------------------------------------------
  // Pin the upstream provider for the currently selected model (X-Provider
  // header; explicit selection always bills pay-as-you-go at that provider's
  // price). "off" restores automatic routing. Pay-as-you-go mode only —
  // provider selection bypasses subscription coverage, so it is blocked while
  // subscription-only is on.
  pi.registerCommand("nano-gpt-provider", {
    description: "Pin upstream provider for the selected model (paygo): <id>|off",
    getArgumentCompletions: (prefix: string) =>
      ["off"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      if (keyMissing) {
        ctx.ui.notify("[nano-gpt] no API key — configure one first", "warning");
        return;
      }
      if (subscriptionOnly) {
        ctx.ui.notify(
          "[nano-gpt] provider selection is pay-as-you-go only — /nano-gpt-subscription off first",
          "warning",
        );
        return;
      }
      const model = ctx.model;
      if (!model || model.provider !== PROVIDER_ID) {
        ctx.ui.notify("[nano-gpt] select a nano-gpt model first (/model)", "warning");
        return;
      }
      const arg = args.trim();
      if (["off", "auto", "none"].includes(arg.toLowerCase())) {
        setRouting(ctx, model.id, undefined);
        ctx.ui.notify(`[nano-gpt] ${model.id}: provider auto (platform picks)`, "info");
        return;
      }
      const result = await discoverProviders(model.id);
      if (result.kind === "ok" && !result.discovery.supportsProviderSelection) {
        ctx.ui.notify(`[nano-gpt] ${model.id} does not support provider selection`, "warning");
        return;
      }
      const discovery = result.kind === "ok" ? result.discovery : undefined;
      const available = discovery?.rows.filter((r) => r.available !== false) ?? [];
      let chosen: string;
      if (arg) {
        if (discovery && !discovery.rows.some((r) => r.provider === arg)) {
          ctx.ui.notify(
            `[nano-gpt] "${arg}" is not a provider for ${model.id} — run /nano-gpt-provider without args to list`,
            "error",
          );
          return;
        }
        if (result.kind === "failed") {
          // Discovery unreachable: accept the pin but say validation didn't
          // happen — it persists, and provider-selection support is unchecked.
          ctx.ui.notify(
            `[nano-gpt] could not validate "${arg}" against live provider discovery (${result.reason}) — pinning anyway; /nano-gpt-provider off to undo`,
            "warning",
          );
        }
        chosen = arg;
      } else {
        if (!ctx.hasUI) {
          ctx.ui.notify(`[nano-gpt] usage: /nano-gpt-provider <provider-id>|off`, "info");
          return;
        }
        if (result.kind === "failed") {
          ctx.ui.notify(
            `[nano-gpt] could not check providers for ${model.id}: ${result.reason}`,
            "error",
          );
          return;
        }
        if (available.length === 0) {
          ctx.ui.notify(`[nano-gpt] no providers available for ${model.id}`, "warning");
          return;
        }
        const sorted = [...available].sort((a, b) => providerPricePer1k(a) - providerPricePer1k(b));
        const labels = ["auto — platform picks the provider", ...sorted.map(providerRowLabel)];
        const pick = await ctx.ui.select(`Provider for ${model.id}`, labels);
        if (!pick) return;
        if (pick.startsWith("auto")) {
          setRouting(ctx, model.id, undefined);
          ctx.ui.notify(`[nano-gpt] ${model.id}: provider auto (platform picks)`, "info");
          return;
        }
        chosen = pick.split(" · ")[0] as string;
      }
      // Exclusive with a routing suffix upstream: setting one clears the other.
      setRouting(ctx, model.id, { provider: chosen });
      ctx.ui.notify(
        `[nano-gpt] ${model.id} → provider ${chosen} (pay-as-you-go; routing suffix cleared)`,
        "info",
      );
    },
  });

  // ---- /nano-gpt-suffix ----------------------------------------------------
  // Set a routing preference suffix (:fast, :cheap, ...) for the currently
  // selected model; the platform picks a provider matching the preference.
  // "off" clears it. Pay-as-you-go mode only; exclusive with a pinned provider.
  pi.registerCommand("nano-gpt-suffix", {
    description: "Routing suffix for the selected model (paygo): fast|cheap|throughput|latency|tools|caching|off",
    getArgumentCompletions: (prefix: string) =>
      [...ROUTING_SUFFIXES, "off"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      if (keyMissing) {
        ctx.ui.notify("[nano-gpt] no API key — configure one first", "warning");
        return;
      }
      if (subscriptionOnly) {
        ctx.ui.notify(
          "[nano-gpt] routing suffixes are pay-as-you-go only — /nano-gpt-subscription off first",
          "warning",
        );
        return;
      }
      const model = ctx.model;
      if (!model || model.provider !== PROVIDER_ID) {
        ctx.ui.notify("[nano-gpt] select a nano-gpt model first (/model)", "warning");
        return;
      }
      const arg = args.trim().toLowerCase();
      if (["off", "none"].includes(arg)) {
        setRouting(ctx, model.id, undefined);
        ctx.ui.notify(`[nano-gpt] ${model.id}: routing suffix off`, "info");
        return;
      }
      let suffix: RoutingSuffix;
      if (arg) {
        const canonical = ROUTING_SUFFIX_ALIASES[arg];
        if (!canonical) {
          ctx.ui.notify(
            `[nano-gpt] unknown suffix "${arg}" — valid: ${ROUTING_SUFFIXES.join(", ")}`,
            "warning",
          );
          return;
        }
        suffix = canonical;
      } else {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `[nano-gpt] usage: /nano-gpt-suffix ${[...ROUTING_SUFFIXES].join("|")}|off`,
            "info",
          );
          return;
        }
        const current = routingPrefs[model.id]?.suffix;
        const labels = [
          "off — no routing suffix",
          ...ROUTING_SUFFIXES.map((s) => `${s} — ${SUFFIX_MEANING[s]}${s === current ? " (current)" : ""}`),
        ];
        const pick = await ctx.ui.select(`Routing suffix for ${model.id}`, labels);
        if (!pick) return;
        if (pick.startsWith("off")) {
          setRouting(ctx, model.id, undefined);
          ctx.ui.notify(`[nano-gpt] ${model.id}: routing suffix off`, "info");
          return;
        }
        suffix = pick.split(" — ")[0] as RoutingSuffix;
      }
      // Suffixes only affect provider-selection-capable models; best-effort
      // warn when discovery says the model is not capable.
      const result = await discoverProviders(model.id);
      if (result.kind === "ok" && !result.discovery.supportsProviderSelection) {
        ctx.ui.notify(
          `[nano-gpt] note: ${model.id} does not support provider selection — :${suffix} may be ignored`,
          "warning",
        );
      }
      // Exclusive with a pinned provider upstream: setting one clears the other.
      setRouting(ctx, model.id, { suffix });
      ctx.ui.notify(
        `[nano-gpt] ${model.id} → :${suffix} (${SUFFIX_MEANING[suffix]}; provider pin cleared)`,
        "info",
      );
    },
  });

  // Apply per-model routing prefs to outgoing pay-as-you-go requests. Provider
  // pin → X-Provider header. Scoped to the active nano-gpt model via ctx.model.
  pi.on("before_provider_headers", (event, ctx) => {
    if (subscriptionOnly) return;
    const model = ctx.model;
    if (!model || model.provider !== PROVIDER_ID) return;
    const pref = routingPrefs[model.id];
    if (pref?.provider) event.headers["X-Provider"] = pref.provider;
  });

  // Combine routing, tier, and Claude cache opt-in in one payload update. A
  // service tier applies in either billing mode. Suffix routing and the Claude
  // helper are pay-as-you-go only: explicit Claude cache controls bypass
  // subscription coverage. The helper lets NanoGPT place the breakpoints, so
  // this does not also inject inline cache_control markers.
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== PROVIDER_ID) return;
    const suffix = subscriptionOnly ? undefined : routingPrefs[model.id]?.suffix;
    const tier = serviceTiers[model.id];
    const cacheClaude = !subscriptionOnly && isClaudeModel(model.id);
    if (!suffix && !tier && !cacheClaude) return;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    return {
      ...payload,
      ...(suffix && typeof payload.model === "string" ? { model: `${payload.model}:${suffix}` } : {}),
      ...(tier ? { service_tier: tier } : {}),
      ...(cacheClaude ? { promptCaching: { enabled: true, ttl: "5m" } } : {}),
    };
  });

  // Keep the footer routing indicator in sync (also clears it when the active
  // model moves off nano-gpt) and remind the user when a model with routing
  // prefs becomes active.
  pi.on("model_select", (event, ctx) => {
    updateStatus(ctx, event.model);
    if (!ctx.hasUI) return;
    const model = event.model;
    if (model.provider !== PROVIDER_ID) return;
    if (subscriptionOnly) return;
    const pref = routingPrefs[model.id];
    if (pref?.provider) {
      ctx.ui.notify(`[nano-gpt] ${model.id}: provider ${pref.provider} (pay-as-you-go)`, "info");
    } else if (pref?.suffix) {
      ctx.ui.notify(`[nano-gpt] ${model.id}: routing :${pref.suffix}`, "info");
    }
  });

  // Surface setup status in the TUI on startup/reload, and refresh the footer
  // routing indicator for the restored model.
  pi.on("session_start", (event, ctx) => {
    updateStatus(ctx);
    if (!ctx.hasUI) return;
    if (event.reason !== "startup" && event.reason !== "reload") return;
    if (keyMissing) {
      ctx.ui.notify(
        `[nano-gpt] No API key found. Set NANO_GPT_API_KEY or add one to ${KEY_FILE}.`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      `[nano-gpt] ready (${catalogSource} catalogue, subscription-only ${subscriptionOnly ? "ON" : "off"})`,
      "info",
    );
  });

  // Normalize context-overflow errors so pi can auto-compact and retry.
  pi.on("message_end", (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant" || msg.stopReason !== "error") return;
    if (msg.provider !== PROVIDER_ID && ctx.model?.provider !== PROVIDER_ID) return;
    const errMsg = msg.errorMessage ?? "";
    if (errMsg.includes("context_length_exceeded")) return; // idempotent
    if (RATE_LIMIT_PATTERN.test(errMsg)) return; // keep throttling on the retry path
    if (OVERFLOW_PATTERN.test(errMsg)) {
      return {
        message: { ...msg, errorMessage: `context_length_exceeded: ${errMsg}` },
      };
    }
  });
}
