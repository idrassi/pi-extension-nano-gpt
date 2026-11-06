import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "nano-gpt";

/** Pi >=1.1 exposes provider auth independently of the currently selected model. */
export async function resolveWebApiKey(
  ctx: ExtensionContext | undefined,
  fallback: () => string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  // Standalone callers can deliberately omit Pi's context. A supplied context
  // must expose its registry; a broken runtime must not select another account.
  if (!ctx) {
    const key = fallback();
    signal?.throwIfAborted();
    return key;
  }
  const registry = ctx.modelRegistry;
  if (!registry) throw new Error("NanoGPT runtime credentials are unavailable: missing model registry");

  let provider;
  try {
    provider = registry.getProvider(PROVIDER_ID);
  } catch {
    // Do not expose auth/config errors that might contain credentials.
    throw new Error("Unable to resolve the NanoGPT runtime provider; check Pi's provider configuration");
  }
  signal?.throwIfAborted();
  if (!provider) {
    // This is the only fallback path. A registered provider owns credential
    // precedence, including stored /login keys and runtime overrides.
    const key = fallback();
    signal?.throwIfAborted();
    return key;
  }

  let resolution;
  try {
    // getProviderAuth has no signal argument in Pi 1.1. Stop waiting on abort
    // even if credential resolution ignores cancellation or never settles.
    const pending = registry.getProviderAuth(PROVIDER_ID);
    resolution = await waitForAuth(pending, signal);
  } catch {
    signal?.throwIfAborted();
    throw new Error("Unable to resolve NanoGPT runtime credentials; check Pi's NanoGPT authentication");
  }
  signal?.throwIfAborted();

  // Web endpoints need only the inference key: never copy provider headers,
  // base URL, or environment (routing/tier/management settings) into requests.
  const resolvedKey = resolution?.auth?.apiKey;
  const key = typeof resolvedKey === "string" ? resolvedKey.trim() : undefined;
  if (!key) throw new Error("No NanoGPT API key resolved by Pi; check Pi's NanoGPT authentication");
  return key;
}

async function waitForAuth<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      // Attach both handlers even after cancellation so a late auth rejection
      // cannot become an unhandled rejection.
      pending.then(resolve, reject);
      if (signal.aborted) onAbort();
    });
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
