/** Bounded processing of paid web responses. No dependency on the pi runtime. */
import fs from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_SERIALIZED_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 50 * 1024;
const MAX_PREVIEW_LINES = 2000;
const MAX_DETAILS_BYTES = 2048;
const WRAP_CODEPOINTS = 1000;
const BILLING_WARNING = "The request may already have been billed. No automatic retry was performed. Do not repeat the paid request solely to recover output.";

export interface WebOutputDetails {
  metadata?: unknown;
  meta?: unknown;
  summary?: unknown;
  httpStatus?: number;
  truncated?: boolean;
  fullOutputPath?: string;
  /** A filesystem error code only; never an arbitrary filesystem error message. */
  artifactError?: string;
  /** The artifact/preview contains only a bounded prefix of the response. */
  serializationTruncated?: boolean;
}

function safetyError(reason: string): Error {
  return new Error(`NanoGPT web response ${reason}. ${BILLING_WARNING}`);
}

/**
 * Run BEFORE JSON.parse (and any recursive redaction). This is a complexity
 * guard, not a JSON validator: JSON.parse still checks syntax. Count containers,
 * scalar values AND property names, but not punctuation or string contents.
 * In particular, escaped quotes/backslashes must not expose fake delimiters.
 */
export function assertResponseComplexity(text: string): void {
  let depth = 0;
  let nodes = 0;
  let primitive = false;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    if (char === 34) {
      if (++nodes > MAX_NODES) throw safetyError("exceeded the 100000 value/property safety limit");
      primitive = false;
      while (++i < text.length) {
        if (text.charCodeAt(i) === 92) i++; // Skip the escaped code unit, including an escaped quote.
        else if (text.charCodeAt(i) === 34) break;
      }
    } else if (char === 123 || char === 91) {
      if (++depth > MAX_DEPTH) throw safetyError("exceeded the nesting safety limit of 64");
      if (++nodes > MAX_NODES) throw safetyError("exceeded the 100000 value/property safety limit");
      primitive = false;
    } else if (char === 125 || char === 93) {
      depth--;
      primitive = false;
    } else if (char === 44 || char === 58 || char === 32 || char === 10 || char === 13 || char === 9) {
      primitive = false;
    } else if (!primitive) {
      if (++nodes > MAX_NODES) throw safetyError("exceeded the 100000 value/property safety limit");
      primitive = true;
    }
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = safetyError("output cancelled");
    error.name = "AbortError";
    throw error;
  }
}

/** Small slices avoid both full-string escape expansion and splitting surrogate pairs. */
function* stringSlices(text: string): Generator<string> {
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 2048, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end++;
    yield text.slice(start, end);
    start = end;
  }
}

function* quoted(text: string): Generator<string> {
  yield '"';
  for (const slice of stringSlices(text)) yield JSON.stringify(slice).slice(1, -1);
  yield '"';
}

/**
 * JSON-like, with ordinary pretty-JSON spacing and indentation capped at 16
 * spaces. Neither JSON.stringify(payload, null, 2) nor a full-size Buffer is
 * allocated. Recursion is checked BEFORE descent and bounded to 64 frames.
 * Only JSON data is supported: do not call arbitrary toJSON methods.
 */
function* serialize(payload: unknown): Generator<string> {
  let nodes = 0;
  const ancestors = new Set<object>();
  const count = () => {
    if (++nodes > MAX_NODES) throw safetyError("exceeded the 100000 value/property serialization safety limit");
  };
  const indent = (depth: number) => "  ".repeat(Math.min(depth, 8));
  const unsupported = (value: unknown) => value === undefined || typeof value === "function" || typeof value === "symbol";
  function* value(item: unknown, depth: number): Generator<string> {
    count();
    if (typeof item === "string") yield* quoted(item);
    else if (item === null || unsupported(item)) yield "null";
    else if (typeof item === "boolean") yield item ? "true" : "false";
    else if (typeof item === "number") yield Number.isFinite(item) ? String(item) : "null";
    else if (typeof item === "object") {
      if (depth >= MAX_DEPTH) throw safetyError("exceeded the nesting serialization safety limit of 64");
      if (ancestors.has(item)) throw safetyError("cannot safely serialize a circular value");
      ancestors.add(item);
      const array = Array.isArray(item);
      yield array ? "[" : "{";
      let first = true;
      if (array) {
        for (let i = 0; i < item.length; i++) {
          yield `${first ? "" : ","}\n${indent(depth + 1)}`;
          yield* value(item[i], depth + 1);
          first = false;
        }
      } else {
        // Do not allocate Object.keys/entries for an unbounded object.
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          const child = (item as Record<string, unknown>)[key];
          count(); // Property names count too, even when the value is omitted.
          if (unsupported(child)) continue;
          yield `${first ? "" : ","}\n${indent(depth + 1)}`;
          yield* quoted(key);
          yield ": ";
          yield* value(child, depth + 1);
          first = false;
        }
      }
      yield `${first ? "" : `\n${indent(depth)}`}${array ? "]" : "}"}`;
      ancestors.delete(item);
    } else throw safetyError("contains a value that cannot be serialized safely");
  }
  yield* value(payload, 0);
}

/** Soft wrapping is incremental, with at most one 1000-codepoint line held. */
function* wrap(chunks: Iterable<string>): Generator<string> {
  let line = "";
  let points = 0;
  for (const chunk of chunks) {
    for (const char of chunk) {
      if (char === "\n") {
        yield `${line}\n`;
        line = "";
        points = 0;
      } else {
        if (points === WRAP_CODEPOINTS) {
          yield `${line}\n`;
          line = "";
          points = 0;
        }
        line += char;
        points++;
      }
    }
  }
  if (line) yield line;
}

function* source(header: string, payload: unknown): Generator<string> {
  yield* stringSlices(header);
  yield "\n\n";
  yield* serialize(payload);
}

async function* rendered(header: string, payload: unknown, state: { truncated: boolean }, signal?: AbortSignal, softWrap = false): AsyncGenerator<string> {
  let bytes = 0;
  let work = 0;
  // Only artifacts are soft-wrapped: inserting newlines into model-facing
  // JSON strings would corrupt long URLs and other whitespace-sensitive data.
  const chunks = source(header, payload);
  // Reserve enough space for the serialization-cap notice, including wrapping.
  for (const chunk of softWrap ? wrap(chunks) : chunks) {
    checkAbort(signal);
    const size = Buffer.byteLength(chunk, "utf8");
    if (bytes + size > MAX_SERIALIZED_BYTES - 1024) {
      state.truncated = true;
      yield `\n\n[Serialization truncated at the 16 MiB safety limit; remaining response omitted. ${BILLING_WARNING}]`;
      break;
    }
    bytes += size;
    yield chunk;
    work += size;
    // Let cancellation events run even during the pre-artifact validation pass.
    if (work >= 64 * 1024) {
      await setImmediate();
      checkAbort(signal);
      work = 0;
    }
  }
  checkAbort(signal);
}

class Preview {
  text = "";
  truncated = false;
  private bytes = 0;
  private lines = 1;
  private maxBytes: number;
  private maxLines: number;
  constructor(maxBytes: number, maxLines: number) {
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
  }
  add(chunk: string): void {
    if (this.truncated) return;
    for (const char of chunk) {
      const bytes = Buffer.byteLength(char, "utf8");
      if (this.bytes + bytes > this.maxBytes || (char === "\n" && this.lines === this.maxLines)) {
        this.truncated = true;
        return;
      }
      this.text += char;
      this.bytes += bytes;
      if (char === "\n") this.lines++;
    }
  }
}

const BILLING_FIELDS = [
  "cost", "totalCost", "costUsd", "costUSD", "totalCostUsd", "totalCostUSD", "total_cost", "cost_usd", "total_cost_usd",
  "charged", "chargedUsd", "amount", "amountUsd", "currency", "credits", "creditsUsed", "billing", "billed",
  "provider", "operation", "requested", "successful", "failed", "total", "totalRequests", "requestCount",
] as const;

/** Fixed whitelist, fixed nesting, fixed scalar length: never traverse opaque traces. */
function billingFields(value: unknown, nested = true, budget = { bytes: 1500 }): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  for (const key of BILLING_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const scalar = (value as Record<string, unknown>)[key];
    if (typeof scalar === "boolean" || (typeof scalar === "number" && Number.isFinite(scalar)) ||
        (typeof scalar === "string" && scalar.length <= 64 && Buffer.byteLength(scalar, "utf8") <= 64)) {
      const bytes = Buffer.byteLength(JSON.stringify({ [key]: scalar }), "utf8");
      if (bytes <= budget.bytes) {
        result[key] = scalar;
        budget.bytes -= bytes;
      }
    }
  }
  if (nested) {
    for (const key of ["nanogpt", "billing"] as const) {
      if (!Object.hasOwn(value, key)) continue;
      budget.bytes -= key.length + 5;
      const fields = billingFields((value as Record<string, unknown>)[key], false, budget);
      if (Object.keys(fields).length) result[key] = fields;
    }
  }
  return result;
}

function boundedDetails(details: WebOutputDetails, signal?: AbortSignal): WebOutputDetails & { truncated: boolean } {
  const result: WebOutputDetails & { truncated: boolean } = { truncated: false };
  if (Object.hasOwn(details, "httpStatus")) result.httpStatus = details.httpStatus;
  for (const field of ["metadata", "meta", "summary"] as const) {
    checkAbort(signal);
    if (!Object.hasOwn(details, field)) continue;
    if (details[field] === undefined) {
      result[field] = undefined;
      continue;
    }
    try {
      let text = "";
      let bytes = 0;
      for (const chunk of serialize(details[field])) {
        checkAbort(signal);
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > MAX_DETAILS_BYTES) throw safetyError("metadata exceeded its safety limit");
        text += chunk;
      }
      // At most 2 KiB, with the same depth/node guard as the main serializer.
      result[field] = JSON.parse(text);
    } catch {
      checkAbort(signal);
      result[field] = {
        omitted: "Oversized or complex metadata; see output text or available artifact for additional fields",
        ...billingFields(details[field]),
      };
    }
  }
  return result;
}

const filesystemCodes = new Set(Object.keys(constants.errno));
function filesystemCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && filesystemCodes.has(code) ? code : "UNKNOWN";
}

/**
 * Header should not include the separating blank line. The first pass validates
 * size/complexity and retains only a capped preview. A second pass writes an
 * async iterable, without retaining a full serialized/soft-wrapped copy.
 */
export async function outputResult(header: string, payload: unknown, details: WebOutputDetails, signal?: AbortSignal) {
  checkAbort(signal);
  const resultDetails = boundedDetails(details, signal);
  const preview = new Preview(MAX_PREVIEW_BYTES, MAX_PREVIEW_LINES);
  const serialization = { truncated: false };
  for await (const chunk of rendered(header, payload, serialization, signal)) preview.add(chunk);
  if (serialization.truncated) resultDetails.serializationTruncated = true;
  resultDetails.truncated = preview.truncated || serialization.truncated;
  if (!preview.truncated) return { content: [{ type: "text" as const, text: preview.text }], details: resultDetails };

  let directory: string | undefined;
  let cleanupError: string | undefined;
  try {
    checkAbort(signal);
    // mkdtemp creates the unique directory with mode 0700, independently of umask.
    directory = await fs.mkdtemp(join(tmpdir(), "pi-nano-gpt-web-"));
    checkAbort(signal);
    const path = join(directory, "output.txt");
    const artifactSerialization = { truncated: false };
    await fs.writeFile(path, rendered(header, payload, artifactSerialization, signal, true), { encoding: "utf8", flag: "wx", mode: 0o600, signal });
    checkAbort(signal);
    // Wrapping adds bytes, so an artifact can reach its cap before the raw
    // preview pass. Report that distinction instead of claiming full output.
    if (artifactSerialization.truncated) {
      serialization.truncated = true;
      resultDetails.serializationTruncated = true;
    }
    resultDetails.fullOutputPath = path;
  } catch (error) {
    if (directory) {
      try { await fs.rm(directory, { recursive: true, force: true }); }
      catch (cleanup) { cleanupError = filesystemCode(cleanup); }
    }
    checkAbort(signal);
    resultDetails.artifactError = filesystemCode(error);
  }
  const recovery = resultDetails.fullOutputPath
    ? `${serialization.truncated ? "Bounded output prefix" : "Full text"} saved to: ${resultDetails.fullOutputPath} (long lines soft-wrapped, not machine-readable JSON). Use read with offset/limit to continue.`
    : `Output artifact could not be saved (${resultDetails.artifactError}); this preview and bounded billing details are still available.${cleanupError ? ` Temporary-file cleanup failed (${cleanupError}).` : ""}`;
  let notice = "";
  for (const chunk of wrap([`\n\n[Output truncated to 50 KiB / 2000 lines. ${serialization.truncated ? "Serialization also truncated at the 16 MiB safety limit; remaining response omitted. " : ""}${recovery} ${BILLING_WARNING}]`])) notice += chunk;
  let newlines = 0;
  for (const char of notice) if (char === "\n") newlines++;
  const head = new Preview(MAX_PREVIEW_BYTES - Buffer.byteLength(notice, "utf8"), MAX_PREVIEW_LINES - newlines);
  head.add(preview.text);
  checkAbort(signal);
  return { content: [{ type: "text" as const, text: head.text + notice }], details: resultDetails };
}
