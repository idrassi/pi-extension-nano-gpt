# pi-extension-nano-gpt

A [pi](https://github.com/earendil-works/pi-mono) provider extension that
registers [Nano-GPT](https://nano-gpt.com) — an OpenAI-compatible aggregator
with 600+ text models (OpenAI, Anthropic, Google, xAI, DeepSeek, Qwen, …) billed
at upstream list price — as a pi provider.

## Requirements

- **pi 1.1.0 or later** (`@earendil-works/pi-coding-agent`), which requires
  **Node.js 22.19.0 or later**.
- **A Nano-GPT API key** from <https://nano-gpt.com/api>.
- Node.js 22.19.0+ to run the test suite (`npm run check`). The extension has
  no npm dependencies, so no `npm install` is needed.

## How it works

- **Base URL:** `https://nano-gpt.com/api/v1` (OpenAI-compatible Chat Completions).
  Discovery and inference both use this documented canonical host.
- **Auth:** `Authorization: Bearer <key>`, read from `~/.pi/agent/nano-gpt.json`
  or `NANO_GPT_API_KEY` (see [Add your API key](#add-your-api-key)).
- **Catalogue and metadata:** fetched live from `GET /models?detailed=true` at
  startup, which returns each model's context window, max output, pricing, and
  capabilities ([docs](https://docs.nano-gpt.com/api-reference/endpoint/models)).
  If the fetch fails, a curated fallback list is used. A small `CURATED`
  overlay fills values the API omits, such as cache-write pricing for some
  models.
- **Reasoning and thinking levels:** models with a `:thinking` id segment or an
  effort-controllable family (o-series) are flagged `reasoning: true`, and pi
  sends `reasoning_effort`. Each model's `reasoning_efforts` from the API becomes
  a per-model `thinkingLevelMap`, so `/thinking` offers exactly the levels the
  upstream supports. This includes the opt-in extended levels `xhigh` and `max`,
  and hides unsupported ones.
  pi's `max` means "the model's maximum": it is aliased to the highest tier the
  model reports (native `max` when present, else `xhigh`/`high`/…), so
  `defaultThinkingLevel: "max"` always resolves to the model's ceiling.
- **Overflow recovery:** upstream context-length errors are normalized so pi can
  auto-compact and retry.
- **Claude prompt caching:** pay-as-you-go requests for Claude model ids request
  explicit prompt caching. See [Claude prompt caching](#claude-prompt-caching).
- **Long-context pricing:** when provider discovery reports a higher rate above
  a prompt-length threshold, that tier is added to the model cost. Haiku 5.5 is
  the current example: above 100K input tokens its rates are several times the
  base price, including cache reads.
- **Privacy routing:** `/nano-gpt-zdr` reads and switches the active inference
  key's live Zero Data Retention policy through NanoGPT's Management API.
- **Web tools:** standalone search, page reading, targeted extraction, site
  mapping/crawling, YouTube transcripts, and multi-source research are available
  to any tool-capable model in pi. All reuse the inference key, require no extra
  dependencies, and are billed separately from model tokens; subscription-only
  mode blocks them. See [Web tools](#web-tools).

## Install

### Option 1: install as a pi package (recommended)

```sh
pi install git:github.com/idrassi/pi-extension-nano-gpt
```

Update later with `pi update --extensions`. Then run `/reload` in pi (or
restart it).

### Option 2: copy into the auto-discovered extensions directory

pi auto-discovers extensions under `~/.pi/agent/extensions/`. Clone the
repository, then copy the extension into a subdirectory:

```sh
git clone https://github.com/idrassi/pi-extension-nano-gpt.git
mkdir -p ~/.pi/agent/extensions/nano-gpt
cp pi-extension-nano-gpt/index.ts pi-extension-nano-gpt/web-tools.ts \
  pi-extension-nano-gpt/package.json ~/.pi/agent/extensions/nano-gpt/
```

Copy again after pulling updates. The extension then loads globally with **no
`settings.json` entry needed**. Run `/reload` in pi (or restart it). Only
auto-discovered locations are hot-reloaded by `/reload`.

### Option 3: point `settings.json` at a clone

Add the clone to the `extensions` array in `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": ["/path/to/pi-extension-nano-gpt"]
}
```

Restart pi after editing the source, because only auto-discovered locations
are guaranteed to hot-reload.

## Add your API key

Create `~/.pi/agent/nano-gpt.json` with your key from <https://nano-gpt.com/api>:

```json
{
  "apiKey": "sk_your_real_nano_gpt_key"
}
```

Then run `/reload` in pi (or restart it). If `PI_CODING_AGENT_DIR` is set, the
file lives in that directory instead of `~/.pi/agent/`.

Alternatively, `export NANO_GPT_API_KEY=...` takes precedence over the file.

## Zero Data Retention routing

NanoGPT implements ZDR as a server-side policy on an inference API key. It is
not a chat-completions parameter or model suffix. The extension identifies the
active inference key through `GET /api/v1/usage`, reads its current policy, and
updates that exact key through the
[Management API](https://docs.nano-gpt.com/api-reference/management-api):

```
/nano-gpt-zdr             # live status + interactive switch
/nano-gpt-zdr status      # live status only
/nano-gpt-zdr on          # require ZDR-only provider routes
/nano-gpt-zdr off         # use Anonymized standard routing
```

Create a Management API token with `api_keys:write` under
[Settings → Security](https://nano-gpt.com/settings#management-api-tokens), then
provide it either as an environment variable:

```sh
export NANO_GPT_MANAGEMENT_TOKEN=sk-nano-mgmt-your_token
```

or alongside the inference key in `~/.pi/agent/nano-gpt.json`:

```json
{
  "apiKey": "sk-nano-your_inference_key",
  "managementToken": "sk-nano-mgmt-your_management_token"
}
```

The management token is separate from the inference key; an ordinary inference
key cannot update its own policy. A file-loaded management token stays out of
`process.env`. The switch changes the key on NanoGPT, so it applies immediately
to every client using that inference key and remains set without `/reload`.

With ZDR on, NanoGPT filters provider pins, automatic routing, and fallbacks to
routes classified as ZDR and returns `zdr_provider_required` if none qualify.
The policy is based on provider commitments rather than an independent audit.
Team-level ZDR requirements can still enforce ZDR when the key is set to
Anonymized. See NanoGPT's
[ZDR routing explanation](https://nano-gpt.com/blog/zero-data-retention-routing-controls).

## Billing modes

NanoGPT exposes two interchangeable base URLs; the extension switches between
them and remembers the choice in `nano-gpt.json` (`"subscriptionOnly":` boolean):

| | `off` (default) | `on` |
|---|---|---|
| Base URL | `…/api/v1` | `…/api/subscription/v1` |
| Models | everything visible | subscription-included only |
| Billing | pay-as-you-go from prepaid balance (list price) | subscription token quotas — can never spend the balance |
| Provider routing | available | not applied |

```
/nano-gpt-subscription on     # quota billing, subscription models only
/nano-gpt-subscription off    # standard pay-as-you-go (default)
/nano-gpt-subscription        # status + interactive picker
```

The toggle re-registers the provider immediately (no `/reload`) and refetches
the catalogue from the matching endpoint. If the current model is not in the
new catalogue you are prompted to `/model` again.

## Web tools

Seven ordinary pi tools are registered automatically; no MCP server, extra key,
model suffix, or npm dependency is needed. They work with **any tool-capable
model**, not just models served by NanoGPT. Ask pi to search, read or extract
public pages, map/crawl a site, retrieve video transcripts, or research a topic:

| Tool | Purpose | NanoGPT endpoint |
|---|---|---|
| `nano_gpt_web_search` | Search with explicit query and source URLs | `POST https://nano-gpt.com/api/web` |
| `nano_gpt_web_scrape` | Read 1–5 public pages as markdown or HTML | `POST https://nano-gpt.com/api/scrape-urls` |
| `nano_gpt_web_extract` | Extract requested facts from one page via Sofya | `POST https://api.nano-gpt.com/api/web` |
| `nano_gpt_site_map` | Discover a bounded set of site URLs via Firecrawl | `POST https://api.nano-gpt.com/api/v1/data/firecrawl` |
| `nano_gpt_site_crawl` | Retrieve bounded site pages as markdown via Firecrawl | `POST https://api.nano-gpt.com/api/v1/data/firecrawl` |
| `nano_gpt_youtube_transcript` | Retrieve transcripts for 1–10 YouTube videos | `POST https://api.nano-gpt.com/api/youtube-transcribe` |
| `nano_gpt_web_research` | Produce a cited multi-source report via Sofya | `POST https://api.nano-gpt.com/api/web` |

All use the existing `NANO_GPT_API_KEY` / `nano-gpt.json` inference key, never
the Management API token. They do not change inference requests or silently
add `:online` / `scraping` options. Provider routing pins, service tiers, and
Claude caching do not apply to these standalone requests. Without a key, calls
fail with setup instructions rather than making an unauthenticated request.

Search and scrape keep using `https://nano-gpt.com`. The other five tools use
`https://api.nano-gpt.com` for longer runtimes, following the
[API Hosts documentation](https://docs.nano-gpt.com/api-reference/miscellaneous/api-hosts).
The direct host is **IPv4-only**; there is no automatic host fallback or retry.

### Search options

Minimal tool arguments:

```json
{ "query": "latest Node.js LTS release notes" }
```

The default is Linkup `standard` with `searchResults`. Available options:

- `provider`: `linkup` (default), `tavily`, `exa`, `kagi`, `perplexity`, `valyu`,
  `brave`, `sofya`, or `firecrawl`.
- Linkup only: `depth` (`standard` or `deep`); `outputType` (`searchResults`,
  `sourcedAnswer`, or `structured`). Structured output requires
  `structuredOutputSchema`, a JSON schema **encoded as a string**. Other
  providers support `searchResults` only.
- `includeImages`, `fromDate` / `toDate` (`YYYY-MM-DD`), and `includeDomains` /
  `excludeDomains` (up to 10 domains each). Filter support varies by provider.
- Sofya only: `maxResults` (1–20), `topic` (`general` or `news`), `freshness`
  (`day`, `week`, `month`, `year`, or `YYYY-MM-DD:YYYY-MM-DD`). This tool exposes
  Sofya search, not its separate fetch/extract/research operations.
- `timeout`: 1–180 seconds, default 120, including response download.

Search results retain the provider's data and `metadata`, including source
URLs and reported request cost. Incompatible option combinations are rejected
before making a billable request. See the
[Direct Web Search API](https://docs.nano-gpt.com/api-reference/endpoint/web-search)
for provider behavior and current prices.

### Page-reading options

```json
{ "urls": ["https://nodejs.org/en/about/previous-releases"] }
```

- `urls`: 1–5 absolute HTTP(S) URLs, standard web ports only, no embedded
  credentials. NanoGPT rejects localhost/private IPs, metadata endpoints,
  and unsupported YouTube targets; pages are fetched remotely, not by pi.
- `provider`: `auto` (default) or `linkup`.
- `format`: `markdown` (default) or `html`. Only one representation is returned
  to the model, falling back to available content if necessary.
- `stealthMode`: `false` by default. Explicitly enabling it uses the stealth
  proxy at **5×** the standard price. Not supported with `provider: "linkup"`.
- `timeout`: 1–180 seconds, default 120.

Per-URL failures and the billing `summary` are preserved. A partially successful
batch returns the usable pages plus errors; an entirely failed batch is marked
as a tool error. See the
[Web Scraping API](https://docs.nano-gpt.com/api-reference/endpoint/scrape-urls).

### Targeted extraction

Use `nano_gpt_web_extract` to extract specific information from one public page:

```json
{
  "url": "https://nodejs.org/en/about/previous-releases",
  "prompt": "List the currently supported LTS releases and their end-of-life dates."
}
```

The tool sends `provider: "sofya"`, `operation: "extract"`, `url`, and `prompt`
to `/api/web`. `timeout` is 1–180 seconds, default 120. Output preserves provider
`data` and billing `metadata`; the prompt does not guarantee a JSON schema.

### Site mapping and crawling

Discover URLs with `nano_gpt_site_map`:

```json
{ "url": "https://nodejs.org", "search": "release", "limit": 25, "maxTotalChargeUsd": 0.50 }
```

Retrieve pages with `nano_gpt_site_crawl`:

```json
{ "url": "https://nodejs.org/en/about", "limit": 5, "maxReturnedPages": 3, "maxTotalChargeUsd": 0.50 }
```

Both submit `operation: "map"` or `"crawl"` to `/api/v1/data/firecrawl`:

- Map: `limit` 1–100, default 25; optional `search` filters discovered URLs.
- Crawl: `limit` 1–20, default 5; `maxReturnedPages` 1–`limit`, default `limit`.
  The request sets `formats: ["markdown"]`. Returning fewer pages does not by
  itself reduce the number processed or billed.
- **`maxTotalChargeUsd` is required**, greater than $0 and at most $5. It is sent
  upstream as a requested spending cap, not a verified guarantee: the official
  NanoGPT MCP exposes this field, but server-side enforcement has not been
  independently verified. Agree on a spending cap before submitting.
- `waitForFinishSecs`: 5–240 seconds, default 240 (NanoGPT caps the server wait
  at 240). `timeout`: 1–300 seconds, default 270, and must be at least
  `waitForFinishSecs + 30`. Lower the server wait when choosing a shorter timeout.
  The map/crawl page bounds and $5 budget bound are extension safety limits,
  not claims about NanoGPT's maximums.

Each call makes **one POST, with no polling or automatic resubmission**. The
response schema and asynchronous continuation contract are undocumented. Full
JSON is retained, including any job, status, data, billing, and partial failures;
a returned job/status does **not** prove completion. Inspect the response rather
than assuming an empty or pending result is finished. Do not automatically
resubmit when completion is unknown: cancellation, timeout, or reaching the
server wait may not stop remote jobs or spending.

### YouTube transcripts

Use `nano_gpt_youtube_transcript` instead of page scraping for supported videos:

```json
{ "urls": ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"] }
```

- `urls`: 1–10 YouTube video URLs in watch, `youtu.be` shortlink, embed, or live
  form; channel and playlist URLs are not supported.
- `timeout`: 1–180 seconds, default 120.

The request sends `{ "urls": [...] }` to `/api/youtube-transcribe`, authenticating
with the inference key in `x-api-key`. Per-video errors and the billing `summary`
are preserved; a partially successful batch retains its usable transcripts and
an entirely failed batch is marked as a tool error. Transcript availability is
not guaranteed. This tool does not upload or transcribe local media. See the
[YouTube Transcription API](https://docs.nano-gpt.com/api-reference/endpoint/youtube-transcribe).

### Multi-source research

Use `nano_gpt_web_research` for an **explicit research task**, not a simple
lookup: it costs more than basic search.

```json
{
  "query": "Compare the current Node.js LTS release support timelines using official sources.",
  "maxSources": 10,
  "topic": "general",
  "freshness": "year"
}
```

The tool sends `provider: "sofya"`, `operation: "research"`, and the query to
`/api/web`. Options are `maxSources` 5–30 (default 10), `topic` `general` or
`news` (default `general`), and optional `freshness`: `day`, `week`, `month`,
`year`, or `YYYY-MM-DD:YYYY-MM-DD`. `timeout` is 1–300 seconds, default 270.
Provider data, citations, and billing metadata are retained; verify citations
before relying on the report. See the
[Direct Web Search API](https://docs.nano-gpt.com/api-reference/endpoint/web-search)
for Sofya extraction and research details, and the
[Data Extraction APIs](https://docs.nano-gpt.com/api-reference/endpoint/data-extraction)
for Firecrawl.

### Billing, privacy, and limits

**Web requests are billed separately from inference/subscription quotas.**
NanoGPT currently documents Linkup standard search at $0.006/request, deep at
$0.06/request, and standard scraping at $0.001/successful URL. Sofya extraction
is documented at $0.02625/request and research at $0.13125/request; YouTube at
$0.01/successful transcript. Firecrawl uses variable, credit-based pricing.
Other providers, stealth mode, or BYOK have different billing. Consult the
linked API docs for current rates. The tool output includes upstream-reported
costs when present; these are not added to pi's model-token cost estimate.
Tool bounds are local safety limits, not claims about API maxima.

To preserve the extension's no-balance-spending guarantee, all seven tools **refuse
to run while `/nano-gpt-subscription on` is active**, including after reload.
Use `/nano-gpt-subscription off` to allow paid web requests. The tools remain
registered so the model can see the reason for refusal; there is no hidden
pay-as-you-go fallback. Requests are never automatically retried: even a
cancelled or timed-out request may already have been billed.

Queries, prompts, and URLs are sent to NanoGPT and its upstream providers.
**Inference ZDR routing does not establish ZDR guarantees for these tools.**
Retrieved content is untrusted source material, not instructions.

Model-facing output is limited to **50 KiB or 2,000 lines**. When truncated,
the full text is saved under a private `pi-nano-gpt-web-*` directory
in the OS temporary directory; the result includes its path. Long lines in the
text artifact are soft-wrapped so pi's `read` tool can continue with line offsets
(the artifact is not machine-readable JSON). These files are
not automatically deleted at session end, so they remain readable; remove them
when no longer needed. Oversized billing metadata is also bounded in persisted
tool details; the complete response remains in the output text/artifact.
Responses larger than 10 MiB are rejected as a safety limit. Esc cancellation
and the request timeout apply to response downloads as
well as connection setup. HTTP/API errors are reported without automatic retries.

## Claude prompt caching

OpenAI, Gemini, and many open-source routes cache automatically. Claude does
not: a cache-capable route and the `:caching` suffix only select a provider.
They do not write a Claude cache. Without an explicit helper, a long agent
session is billed as fresh input on every turn.

On pay-as-you-go, the extension adds this to every Claude request, including
`:thinking` variants:

```json
{ "promptCaching": { "enabled": true, "ttl": "5m" } }
```

NanoGPT places the cache breakpoints. The first eligible request writes the
prefix at 1.25× the input rate; a later request with the same prefix reads it,
typically at 0.1× (Haiku 5.5 and Sonnet 5.5 have model-specific read rates).
Five minutes matches an interactive agent loop. A one-hour TTL would write at
2×, and pi's OpenAI usage parser would price that write as a five-minute write,
so the extension does not request it.

A prefix below the route's minimum still succeeds, but it does not create a
cache entry. A single short prompt therefore costs the write premium without a
following read. Verify hits with `cache_read_input_tokens` or pi's cache-read
usage, not with a successful response alone.

Subscription-only mode does not add the helper. On Chat Completions, explicit
Claude cache controls select pay-as-you-go billing and bypass subscription
coverage. Turn subscription-only off before relying on Claude cache discounts.

## Service tiers

With a NanoGPT model selected, use `/nano-gpt-tier` to open an interactive
switch. The choice applies to the next request for that **exact model id** and
persists under `"serviceTiers"` in `nano-gpt.json`:

```
/nano-gpt-tier priority  # request faster priority processing
/nano-gpt-tier flex      # request lower-cost flex processing
/nano-gpt-tier default   # explicitly request standard processing
/nano-gpt-tier auto      # clear the override (default)
/nano-gpt-tier status    # show this model's current choice
```

`auto` omits `service_tier` from the request. Other choices send the matching
`service_tier` field to NanoGPT's Chat Completions API. Changes take effect
without `/reload` and appear in the status bar as a **requested** tier, alongside
the model's routing choice. The switch works with either billing base URL.

[NanoGPT's API docs](https://docs.nano-gpt.com/api-reference/endpoint/chat-completion)
say tier availability depends on the routed provider. A pinned provider that
does not support the tier may ignore it; priority can change routing and is
billed at priority rates where supported. Flex favors lower cost and may take
longer. The model catalogue supplies base prices, so pi's estimated cost may
differ from the final charge when flex or priority applies. Check the actual
response or NanoGPT usage records for the tier used.

## Provider and routing selection (pay-as-you-go only)

After selecting a model (`/model nano-gpt/<id>`), you can pin **which upstream**
serves it. Both persist per model under `"routing"` in `nano-gpt.json` and are
mutually exclusive — the API rejects provider + suffix combined
(`speed_suffix_ambiguous_provider`), so setting one clears the other:

```
/nano-gpt-provider            # picker: providers with live pricing, cheapest first
/nano-gpt-provider deepinfra  # pin a specific upstream (X-Provider header)
/nano-gpt-provider off        # auto — platform picks
/nano-gpt-suffix fast         # platform picks by preference (:fast)
/nano-gpt-suffix cheap        # aliases: speed, price, floor, throughput,
                              #          latency, tools, caching, cache, cached
/nano-gpt-suffix off
```

Notes:

- Explicit provider selection is **always pay-as-you-go** (billed at that
  provider's price incl. markup) and bypasses subscription coverage — hence
  both commands are blocked while subscription-only is on.
- Provider selection works only for models reporting
  `supportsProviderSelection` (checked live via `GET /api/models/:id/providers`);
  routing suffixes are ignored by models that don't support it.
- The provider picker shows NanoGPT's live route-level privacy classification
  beside each provider and its price: `ZDR`, `non-ZDR · no training`,
  `non-ZDR · logs · training unknown`, `non-ZDR · logs + training`, or
  `ZDR unknown` when metadata is absent or unrecognized.
- Suffixes compose with `:thinking` ids (e.g. `deepseek/x:thinking:fast`).
- Prefs persist per **exact** model id, `:thinking` and vendor segments
  included: a pin or suffix set on `vendor/x` does not apply to
  `vendor/x:thinking`. Re-run the command after switching variants.
- While a nano-gpt model is selected, the effective routing choice is always
  visible in pi's status bar: `nano-gpt · <provider>` (pin), `nano-gpt · :fast`
  (suffix), `nano-gpt · auto`, or `nano-gpt · subscription` in
  subscription-only mode. A selected service tier is appended, for example
  `nano-gpt · auto · tier priority`. The entry refreshes on every change and
  clears when the active model is not from nano-gpt.

## Use

```
/model nano-gpt/openai/gpt-5
/model nano-gpt/anthropic/claude-opus-4.6:thinking
```

Model ids above are examples. Run `pi --list-models nano-gpt` to see the
current catalogue.

Set thinking effort per model with `/thinking` (e.g. `/thinking max`). The
offered levels match what Nano-GPT reports for the selected model:

```
/thinking max    # always valid: resolves to the model's highest supported effort
/thinking xhigh  # only for models whose reasoning_efforts include "xhigh"
```

`max` is never hidden — it maps to the model's top tier (`max` → native `max`,
else `xhigh`, else `high`, …). For example, a model that tops out at `xhigh`
sends `xhigh` when you pick `max`. A startup default can be pinned in
`~/.pi/agent/settings.json` via `defaultThinkingLevel` (e.g. `"max"`) or the
per-model `modelThinkingLevels` map.

If a newly released model is missing, run `/reload` to refetch the catalogue.
Opening `/model` alone does not rerun the startup fetch.

## Key resolution and security

The file key is backfilled into `process.env.NANO_GPT_API_KEY` so the provider
resolves it per request (no escaping issues). Side effect: a file-only key becomes
visible to subprocesses spawned by pi (e.g. `bash` commands like `env`). If the key
was already exported in your shell this changes nothing.

The optional `managementToken` is read only when `/nano-gpt-zdr` runs and is
never backfilled into the environment. It must have `api_keys:write`, which also
allows creating, updating, and revoking inference keys; protect it accordingly.

## Development

```sh
npm run check   # runs node --test (Node.js 22.19.0+)
```

## Files

- `index.ts` — provider registration, preferences, commands, and hooks
- `web-tools.ts` — standalone web tool schemas, API calls, and bounded output
- `package.json` — pi extension manifest and check script (no npm dependencies)
- `test/model-catalogue.test.mjs` — canonical endpoint, discovery, and billing-mode regression test
- `test/service-tier.test.mjs` — runtime switch integration test
- `test/web-tools.test.mjs` — web API contracts, billing guard, cancellation, output limits, and extension integration
- `test/research-tools.test.mjs` — extraction, site map/crawl, YouTube transcript, and research API contracts and safeguards
- `LICENSE` — MIT license

## License

MIT. See [LICENSE](LICENSE).
