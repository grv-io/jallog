import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  DEFAULT_MODELS,
  MAX_NOTES,
  MAX_OUTPUT_TOKENS,
  RESPONSE_SCHEMA,
  buildPrompt,
  createRateLimiter,
  normaliseDate,
  normaliseExtraction,
  readModelAnswer,
} from "@/lib/extract";
import type { NormalisedExtraction, RateLimiter } from "@/lib/extract";
import { CUT_OFF_NOTE_PREFIX } from "@/lib/types";
import type { ExtractError, ExtractResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;
// GET reports whether a key is configured at run time, so it must not be
// rendered once at build time.
export const dynamic = "force-dynamic";

// The capture page downscales to 2000 px JPEG (a few hundred kB). 3 MB of
// image is about 4 MB of base64, which stays under the 4.5 MB request limit
// of the usual serverless hosts, so an oversized upload gets our message
// rather than the platform's.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4096;
const MIN_IMAGE_BYTES = 200;

// ---------------------------------------------------------------------------
// Limits on how much of the shared model allowance one server instance spends
// ---------------------------------------------------------------------------
//
// Two windows, both held in memory by this server instance (a host that runs
// several instances gives each its own count, so these are a brake, not a
// guarantee):
//
// - a burst limit: 12 pages per caller and 60 across all callers in any 10
//   minutes, so one script cannot fire hundreds of upstream calls at once;
// - a daily budget: calls that a model accepted, per caller and across all
//   callers, in any 24 hours. This is the one sized to the allowance: a free
//   key gives each model about 20 requests a day (see .env.example), so four
//   models give roughly 80, and the default budget of 40 calls (10 for one
//   caller) keeps this instance to half of that. A page normally takes one
//   call; a repeat read of the same photo takes none (see the cache below).
//   EXTRACT_DAILY_LIMIT and EXTRACT_DAILY_PER_CALLER change the two numbers.
//
// The caller's address comes from a header anyone outside our proxy can make
// up, which is why each window also has a limit across all callers.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_CALLER = 12;
const MAX_ALL_CALLERS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_TOTAL = 40;
const DEFAULT_DAILY_PER_CALLER = 10;

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : fallback;
}

// Made on first use, so the settings are read when the server runs rather
// than when it is built.
let limiters: { burst: RateLimiter; daily: RateLimiter } | null = null;
function getLimiters() {
  if (!limiters) {
    const dailyTotal = positiveInt(process.env.EXTRACT_DAILY_LIMIT, DEFAULT_DAILY_TOTAL);
    const dailyPerCaller = Math.min(dailyTotal, positiveInt(process.env.EXTRACT_DAILY_PER_CALLER, DEFAULT_DAILY_PER_CALLER));
    limiters = {
      burst: createRateLimiter({ windowMs: WINDOW_MS, perKey: MAX_PER_CALLER, total: MAX_ALL_CALLERS }),
      daily: createRateLimiter({ windowMs: DAY_MS, perKey: dailyPerCaller, total: dailyTotal }),
    };
  }
  return limiters;
}

// A read of the same photo (same bytes, plant kind and dates) within a few
// hours is answered from memory instead of asking the model again: the four
// sample pages are opened by every visitor, and each live read of one would
// otherwise spend the day's allowance. Only complete readings are kept.
// What is stored is the reading, never the photo.
const CACHE_MAX = 50;
const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; body: ExtractResponse }>();

function cacheGet(id: string, now: number): ExtractResponse | null {
  const hit = cache.get(id);
  if (!hit) return null;
  cache.delete(id);
  if (now - hit.at > CACHE_MS) return null;
  cache.set(id, hit); // most recently used last
  return hit.body;
}

function cachePut(id: string, body: ExtractResponse, now: number) {
  cache.delete(id);
  cache.set(id, { at: now, body });
  for (const k of cache.keys()) {
    if (cache.size <= CACHE_MAX) break;
    cache.delete(k); // least recently used first
  }
}

// What the server has learnt from the model service's refusals, so that the
// next request does not repeat a call that cannot succeed.
//
// A model that answered "out of quota" or "no such model" is left alone for a
// while. These depend on the key and the model name, never on the photo, so a
// caller cannot use them to switch the reader off for everyone.
const REST_DEFAULT_MS = 10 * 60 * 1000;
const REST_DAILY_QUOTA_MS = 30 * 60 * 1000;
const REST_MIN_MS = 15 * 1000;
const resting = new Map<string, { until: number; why: "quota" | "missing" }>();
// The key the service last refused, and until when we take its word for it.
let refusedKey: { key: string; until: number } | null = null;
const KEY_REFUSED_MS = 10 * 60 * 1000;

const keyIsRefused = (key: string, now: number) => refusedKey !== null && refusedKey.key === key && now < refusedKey.until;

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function fail(code: ExtractError["code"], message: string, status: number, retryAfterMs?: number) {
  const headers: Record<string, string> = { ...NO_STORE };
  if (retryAfterMs !== undefined) headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  return NextResponse.json<ExtractError>({ ok: false, code, message }, { status, headers });
}

// "in about 20 minutes", "in about 3 hours": for messages about a limit.
function inAbout(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 90) return `in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return `in about ${Math.ceil(minutes / 60)} hours`;
}

const KEY_REFUSED_MESSAGE =
  "Photo reading is not working on this server: the vision model refused the server's key. Sample pages still work; tell whoever runs this server.";
const MODELS_MISSING_MESSAGE =
  "Photo reading is not set up correctly on this server: the vision models it is configured to use were not found. Sample pages still work; tell whoever runs this server.";
const QUOTA_MESSAGE = "The vision model's quota is used up for now. Try again later.";

// The route spends a shared quota, so another website must not be able to use
// a visitor's browser to call it. Browsers attach Origin to every cross-site
// POST; when it is present it has to name this host. (A script outside a
// browser can send any header it likes; the limits above are what bound that.)
function fromThisSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false; // "null" (sandboxed frame, file://) or garbage
    }
    let urlHost = "";
    try {
      urlHost = new URL(req.url).host;
    } catch {
      /* relative or odd URL: fall back to the headers */
    }
    // EXTRACT_ALLOWED_HOSTS is for a proxy or tunnel that rewrites Host
    // without setting X-Forwarded-Host.
    const hosts = [req.headers.get("x-forwarded-host"), req.headers.get("host"), urlHost, process.env.EXTRACT_ALLOWED_HOSTS]
      .flatMap((h) => (h ? h.split(",") : []))
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    return hosts.includes(originHost);
  }
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

// Reads the body without trusting Content-Length: stops as soon as more than
// `max` bytes have arrived. null means too large.
async function readBody(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// What the bytes actually are, whatever the data URL claims.
function sniffImage(base64Head: string): "image/jpeg" | "image/png" | "image/webp" | null {
  const b = Buffer.from(base64Head, "base64");
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// The host stops the function at maxDuration (60 s), so everything has to be
// answered a little before that.
const DEADLINE_MS = 55_000;
const MAX_REPLY_CHARS = 2_000_000;

// How long a model may stay silent before it is given up on, and how much
// time must be left to start another attempt. With thinking at minimal or low
// (the default), measured answers start within a few seconds, so 25 s of
// silence means the model is stuck and the next one still has time. Medium
// and high deliberate before the first word: they get 45 s, and a further
// attempt is started only if it could get as long, which in practice means
// one model per page.
function patience(thinking: string): { silenceMs: number; minAttemptMs: number } {
  return thinking === "medium" || thinking === "high"
    ? { silenceMs: 45_000, minAttemptMs: 30_000 }
    : { silenceMs: 25_000, minAttemptMs: 8_000 };
}

// Why the model service turned a request down.
// key: the API key is invalid, expired or not allowed. photo: the request was
// refused as invalid, which for a request that is otherwise the same every
// time means the image. missing: no such model. quota: out of allowance.
// busy: overloaded or failing; worth trying again.
type Problem = "key" | "photo" | "missing" | "quota" | "busy";

// Reads the service's error body ({ error: { status, message, details } }).
// The shape is not trusted: anything unexpected falls back to the HTTP status.
function upstreamProblem(status: number, body: unknown): { problem: Problem; restMs: number } {
  const err = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
  const e = (err && typeof err === "object" ? err : {}) as { message?: unknown; details?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  const details = (Array.isArray(e.details) ? e.details : []).filter((d): d is Record<string, unknown> => !!d && typeof d === "object");
  const keyTrouble = /api[ _]?key/i.test(message) || details.some((d) => typeof d.reason === "string" && /API_KEY/.test(d.reason));

  if (status === 401 || status === 403 || (status === 400 && keyTrouble)) return { problem: "key", restMs: 0 };
  if (status === 429) {
    // A used-up daily allowance will not come back in minutes. Otherwise the
    // service says how long to wait ("retryDelay": "34s"); without either,
    // leave the model alone for ten minutes.
    const text = JSON.stringify(details).slice(0, 5000);
    if (/PerDay/i.test(text)) return { problem: "quota", restMs: REST_DAILY_QUOTA_MS };
    const delay = details.map((d) => (typeof d.retryDelay === "string" ? d.retryDelay.match(/^(\d+(?:\.\d+)?)s$/) : null)).find(Boolean);
    const restMs = delay ? Math.min(REST_DEFAULT_MS, Math.max(REST_MIN_MS, Number(delay[1]) * 1000 + 1000)) : REST_DEFAULT_MS;
    return { problem: "quota", restMs };
  }
  if (status === 404) return { problem: "missing", restMs: REST_DEFAULT_MS };
  if (status === 400) return { problem: "photo", restMs: 0 };
  return { problem: "busy", restMs: 0 };
}

interface Attempt {
  status: number; // HTTP status; 0 when nothing usable came back
  errorText?: string;
  problem?: Problem;
  restMs?: number;
  // What the model wrote, in the shape of a generateContent reply.
  reply?: unknown;
  // We stopped waiting, before or during the answer.
  timedOut: boolean;
  // The caller hung up (closed the tab) while we were waiting.
  cancelled: boolean;
}

// Asks one model, reading its answer as a stream. Measured speed varies from
// about 150 to 400 tokens a second, so a full page can outlast any fixed
// timeout; with a stream, whatever rows have arrived when time runs out are
// still in hand (readModelAnswer keeps the complete ones) instead of lost.
async function askModel(
  model: string,
  key: string,
  payload: string,
  opts: { msLeft: number; silenceMs: number; caller?: AbortSignal | null },
): Promise<Attempt> {
  const { msLeft, silenceMs, caller } = opts;
  const gone = () => Boolean(caller?.aborted);
  if (gone()) return { status: 0, timedOut: false, cancelled: true };

  const ctl = new AbortController();
  const hangUp = () => ctl.abort();
  caller?.addEventListener("abort", hangUp, { once: true });
  const overall = setTimeout(hangUp, msLeft);
  let text = "";
  // Until the answer starts, every event from the model (a thought summary
  // counts) is a sign of life that restarts this timer. Once the answer has
  // started only the overall limit applies.
  let silence: ReturnType<typeof setTimeout> | undefined = setTimeout(hangUp, Math.min(silenceMs, msLeft));
  const alive = () => {
    clearTimeout(silence);
    silence = text ? undefined : setTimeout(hangUp, silenceMs);
  };
  let finish = "";
  let blockReason = "";
  let sawCandidate = false;
  // An overloaded model can accept the request, start writing and then fail:
  // the stream then carries an error event (or just stops).
  let streamError: { status: number; body: unknown } | null = null;

  const take = (event: unknown) => {
    if (!event || typeof event !== "object") return;
    const e = event as { promptFeedback?: { blockReason?: unknown }; candidates?: unknown; error?: { code?: unknown } };
    if (e.error && typeof e.error === "object") streamError = { status: typeof e.error.code === "number" ? e.error.code : 502, body: e };
    if (e.promptFeedback && typeof e.promptFeedback === "object" && e.promptFeedback.blockReason) blockReason = String(e.promptFeedback.blockReason);
    const c = Array.isArray(e.candidates) ? (e.candidates[0] as { finishReason?: unknown; content?: { parts?: unknown } } | null) : null;
    if (!c || typeof c !== "object") return;
    sawCandidate = true;
    if (typeof c.finishReason === "string" && c.finishReason) finish = c.finishReason;
    const parts = c.content && typeof c.content === "object" && Array.isArray(c.content.parts) ? c.content.parts : [];
    for (const p of parts) {
      // Thought summaries are not part of the answer.
      if (p && typeof p === "object" && typeof p.text === "string" && !p.thought) text += p.text;
    }
  };
  const reply = (finishReason: string) => ({
    promptFeedback: blockReason ? { blockReason } : undefined,
    candidates: sawCandidate ? [{ content: { parts: [{ text }] }, finishReason }] : [],
  });
  const refused = (status: number, body: unknown, errorText: string): Attempt => ({
    status,
    errorText,
    ...upstreamProblem(status, body),
    timedOut: false,
    cancelled: false,
  });

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: payload,
      signal: ctl.signal,
    });
    if (!r.ok) {
      const errorText = (await r.text()).slice(0, 20_000);
      let body: unknown = null;
      try {
        body = JSON.parse(errorText);
      } catch {
        /* a proxy's error page: the status alone decides */
      }
      return refused(r.status, body, errorText.slice(0, 300));
    }

    const decoder = new TextDecoder();
    let whole = ""; // kept in case the reply is plain JSON, not a stream of events
    let buffer = "";
    let sawEvent = false;
    const line = (l: string) => {
      if (!l.startsWith("data:")) return;
      sawEvent = true;
      try {
        take(JSON.parse(l.slice(5)));
      } catch {
        /* a broken event: the rest of the stream may still be usable */
      }
      alive();
    };
    const reader = r.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      whole += chunk;
      buffer += chunk;
      if (whole.length > MAX_REPLY_CHARS) {
        await reader.cancel().catch(() => {});
        break;
      }
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, nl).replace(/\r$/, ""));
        buffer = buffer.slice(nl + 1);
      }
    }
    line(buffer.replace(/\r$/, ""));
    if (!sawEvent) {
      try {
        const parsed: unknown = JSON.parse(whole);
        (Array.isArray(parsed) ? parsed : [parsed]).forEach(take);
      } catch {
        /* not JSON either (a proxy's error page, an empty body): reply() reports no candidate */
      }
    }
    const failed = streamError as { status: number; body: unknown } | null;
    if (failed && !text) return refused(failed.status, failed.body, "error event in stream");
    return { status: 200, reply: reply(failed ? "" : finish), timedOut: false, cancelled: false };
  } catch {
    // Our timer fired, the caller hung up, or the connection dropped. Keep
    // what was written so far.
    const timedOut = ctl.signal.aborted && !gone();
    if (text) return { status: 200, reply: reply(finish || "MAX_TIME"), timedOut, cancelled: gone() };
    return { status: 0, timedOut, cancelled: gone() };
  } finally {
    clearTimeout(silence);
    clearTimeout(overall);
    caller?.removeEventListener("abort", hangUp);
  }
}

export async function GET() {
  const key = process.env.GEMINI_API_KEY;
  // A key the model service has just refused is not a working reader: the
  // capture page then opens sample pages at once from the reading recorded
  // earlier (or, where there is none, from the values the page was generated from).
  return NextResponse.json({ ready: Boolean(key) && !keyIsRefused(key ?? "", Date.now()) }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (e) {
    // Nothing below is expected to throw. If something does, the page still
    // gets JSON it can show instead of the framework's bare 500.
    console.error("extract: unexpected failure", e instanceof Error ? e.message : e);
    return fail("model_error", "Something went wrong while reading the page. Try again.", 500);
  }
}

// Loopback means the browser is on the same machine as the server (or a
// local proxy hides the real addresses); either way it does not identify one
// visitor among many.
const isLoopback = (address: string) => /^(?:::1|127\.|::ffff:127\.|localhost$)/i.test(address);

async function handle(req: Request): Promise<Response> {
  if (!fromThisSite(req)) {
    return fail("forbidden", "This request did not come from the JalLog page, so it was not processed.", 403);
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return fail("no_key", "Photo extraction is not configured on this server. Sample pages still work.", 503);
  }

  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return fail("bad_request", "Send the photo as JSON (content-type application/json).", 415);
  }

  // Refuse an oversized body before reading it, then again while reading it
  // in case the declared length was wrong or missing.
  const tooLarge = () => fail("bad_image", "Photo is too large after compression (limit 3 MB).", 413);
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();
  let text: string | null;
  try {
    text = await readBody(req, MAX_BODY_BYTES);
  } catch {
    return fail("bad_image", "The upload was interrupted. Try again.", 400);
  }
  if (text === null) return tooLarge();

  let body: { imageDataUrl?: unknown; plantKind?: unknown; fallbackDate?: unknown };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed;
  } catch {
    return fail("bad_image", "Request was not valid JSON.", 400);
  }

  const url = typeof body.imageDataUrl === "string" ? body.imageDataUrl : "";
  const head = url.slice(0, 40).match(/^data:image\/(?:jpeg|png|webp);base64,/);
  const data = head ? url.slice(head[0].length) : "";
  if (!head || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return fail("bad_image", "Send a JPEG, PNG or WebP photo.", 400);
  }
  const bytes = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) return tooLarge();
  const mimeType = sniffImage(data.slice(0, 32));
  if (!mimeType || bytes < MIN_IMAGE_BYTES) {
    return fail("bad_image", "This file is not a readable JPEG, PNG or WebP photo.", 400);
  }

  const plantKind = body.plantKind === "ETP" ? "ETP" : "STP";
  const startedAt = Date.now();
  const today = new Date(startedAt).toISOString().slice(0, 10);
  const fallbackDate = normaliseDate(body.fallbackDate, today) ?? today;

  // The same photo read again: answer from memory, at no cost to anyone's allowance.
  const photoId = createHash("sha256").update(`${plantKind}|${fallbackDate}|${today}|`).update(data).digest("hex");
  const remembered = cacheGet(photoId, startedAt);
  if (remembered) {
    return NextResponse.json<ExtractResponse>(remembered, { headers: { ...NO_STORE, "x-jallog-reading": "repeat" } });
  }

  if (keyIsRefused(key, startedAt)) return fail("no_key", KEY_REFUSED_MESSAGE, 503);

  // The newest model is often overloaded on the free tier, so fall through a
  // short list rather than failing the operator's upload.
  const models = (process.env.GEMINI_MODEL || DEFAULT_MODELS.join(","))
    .split(",")
    .map((m) => m.trim())
    .filter((m) => /^[\w.-]{1,80}$/.test(m)) // goes into a URL
    .slice(0, 6);
  if (models.length === 0) models.push(...DEFAULT_MODELS);

  // Models known to be out of quota or missing are not asked again until
  // their rest is over. If that leaves none, say so without spending a call
  // or counting the request against the caller: the condition is ours.
  for (const [m, rest] of resting) if (rest.until <= startedAt) resting.delete(m);
  const awake = models.filter((m) => !resting.has(m));
  const quotaWait = () => {
    const waits = models.map((m) => resting.get(m)).filter((r) => r?.why === "quota").map((r) => r!.until - Date.now());
    return waits.length ? Math.max(1000, Math.min(...waits)) : REST_DEFAULT_MS;
  };
  if (awake.length === 0) {
    return models.some((m) => resting.get(m)?.why === "quota")
      ? fail("rate_limited", QUOTA_MESSAGE, 429, quotaWait())
      : fail("model_error", MODELS_MISSING_MESSAGE, 503);
  }

  // Only requests that are about to reach the model are counted.
  const { burst, daily } = getLimiters();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  const caller = forwarded || "local";
  const burstRefused = burst.take(caller, startedAt);
  if (burstRefused) {
    return fail(
      "rate_limited",
      burstRefused === "key"
        ? "Too many pages in a short time. Try again in a few minutes."
        : "The photo reader is busy with other visitors. Try again in a few minutes.",
      429,
      burst.wait(caller, startedAt),
    );
  }
  // The daily budget is counted in model calls, one slot for each call a
  // model accepts; a page normally takes one. Without an address that
  // identifies one visitor, only the budget across all callers can be
  // enforced: such a call gets a key of its own.
  const visitor = forwarded && !isLoopback(forwarded) ? forwarded : null;
  let slot: { key: string; at: number } | null = null;
  const takeSlot = (): null | "key" | "total" => {
    const at = Date.now();
    const slotKey = visitor ?? `direct ${at} ${Math.random()}`;
    const refused = daily.take(slotKey, at);
    if (!refused) slot = { key: slotKey, at };
    return refused;
  };
  const dailyRefused = takeSlot();
  if (dailyRefused) {
    burst.release(caller, startedAt); // nothing was asked of the model
    const wait = daily.wait(visitor ?? "direct", startedAt);
    return fail(
      "rate_limited",
      dailyRefused === "key"
        ? `This server reads a limited number of photos a day for each visitor, and yours are used up. Live reading opens again ${inAbout(wait)}.`
        : `Today's allowance for live reading on this server is used up. It opens again ${inAbout(wait)}.`,
      429,
      wait,
    );
  }

  const thinkingSetting = (process.env.GEMINI_THINKING || "").toLowerCase();
  const thinking = ["minimal", "low", "medium", "high"].includes(thinkingSetting) ? thinkingSetting : "low";
  const { silenceMs, minAttemptMs } = patience(thinking);
  const payload = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType, data } }, { text: buildPrompt(plantKind, fallbackDate) }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // Transcription needs little deliberation; "low" cut a page from ~50 s to ~15 s
      // with no loss on the sample pages (scripts/eval-extract.mjs).
      thinkingConfig: { thinkingLevel: thinking },
    },
  });

  const deadline = startedAt + DEADLINE_MS;
  let cancelled = false;
  let keyRefused = false;
  let quota = false;
  let blocked = false;
  let unreadable = false;
  let rejectedPhoto = false;
  let tooSlow = false;
  let missing = 0;
  let asked = 0;
  // The fullest cut-off answer seen so far, returned only if no model manages
  // a complete one.
  let partial: { model: string; out: NormalisedExtraction } | null = null;
  const respond = (model: string, out: NormalisedExtraction, cut: "rows" | "notes" | null) => {
    // The route's own statement about the answer goes first. The cut-off
    // warning is said plainly: the rows below that point exist on paper only.
    const first =
      cut === "rows"
        ? [`${CUT_OFF_NOTE_PREFIX} after row ${out.rows.length}. Rows lower on the page are missing: add them by hand, or photograph the lower half of the page separately.`]
        : cut === "notes"
          ? ["The reader's notes were cut short. All the rows it read were received."]
          : [];
    const answer: ExtractResponse = {
      ok: true,
      model,
      rows: out.rows,
      unmappedColumns: out.unmappedColumns,
      notes: [...first, ...out.notes].slice(0, MAX_NOTES),
    };
    // A cut-off reading is not kept: another try may get the whole page.
    if (cut !== "rows") cachePut(photoId, answer, Date.now());
    return NextResponse.json<ExtractResponse>(answer, { headers: NO_STORE });
  };

  for (const model of awake) {
    if (req.signal?.aborted) {
      cancelled = true;
      break;
    }
    const left = deadline - Date.now();
    if (left < minAttemptMs) break;
    // An earlier model on this page used the slot: this call needs its own.
    if (!slot && takeSlot()) break;
    asked++;
    const attempt = await askModel(model, key, payload, { msLeft: left, silenceMs, caller: req.signal });
    // The slot is used once a model accepts the call: it answered, or it was
    // still working when we (or the caller) stopped waiting. A call the
    // service turned down, or that never connected, used nothing, and its
    // slot serves the next model.
    if (attempt.reply !== undefined || attempt.timedOut || attempt.cancelled) slot = null;
    if (attempt.cancelled) {
      cancelled = true;
      break;
    }
    if (!attempt.reply) {
      if (attempt.status === 0) {
        tooSlow ||= attempt.timedOut;
        console.error("extract: timeout or network error", model);
        continue;
      }
      console.error("extract: upstream", model, attempt.status, attempt.problem, attempt.errorText);
      if (attempt.problem === "key") {
        // The key itself is refused; no other model will accept it.
        keyRefused = true;
        refusedKey = { key, until: Date.now() + KEY_REFUSED_MS };
        break;
      }
      if (attempt.problem === "quota") {
        quota = true;
        resting.set(model, { until: Date.now() + (attempt.restMs || REST_DEFAULT_MS), why: "quota" });
      } else if (attempt.problem === "missing") {
        missing++;
        resting.set(model, { until: Date.now() + REST_DEFAULT_MS, why: "missing" });
      } else if (attempt.problem === "photo") {
        rejectedPhoto = true;
      }
      continue;
    }

    const answer = readModelAnswer(attempt.reply);
    if (!answer.ok) {
      // Safety block, empty candidate, or JSON cut off before the first row.
      console.error("extract: unusable answer", model, answer.reason, answer.detail);
      if (answer.reason === "blocked") blocked = true;
      else if (attempt.timedOut) tooSlow = true;
      else unreadable = true;
      continue;
    }

    const out = normaliseExtraction(answer.data, fallbackDate, today);
    if (out.malformed) {
      console.error("extract: answer was not an object with rows", model);
      unreadable = true;
      continue;
    }
    if (!out.isLogbook) {
      return fail("not_a_logbook", "This photo does not look like a plant logbook page. Check it shows the register page clearly.", 422);
    }
    if (out.rows.length === 0) {
      if (answer.truncated) {
        // Cut off before any row with a reading: not the same as an empty page.
        if (attempt.timedOut) tooSlow = true;
        else unreadable = true;
        continue;
      }
      return fail("not_a_logbook", "No filled rows were found in this photo. Check it shows the register page clearly.", 422);
    }
    // Every row arrived. If the answer stopped in the notes after them, that
    // is said, but nothing on the page is missing and no other model is asked.
    if (!answer.truncated) return respond(model, out, answer.notesCut ? "notes" : null);
    // Stopped at the output limit: every model has the same limit, so asking
    // another would only spend quota.
    if (answer.finishReason === "MAX_TOKENS") return respond(model, out, "rows");
    // The stream broke or ran out of time. Another model may still give the
    // whole page, so keep this as a fallback and try the next one.
    console.error("extract: answer cut off after", out.rows.length, "rows", model);
    if (!partial || out.rows.length > partial.out.rows.length) partial = { model, out };
  }

  // A slot no model used goes back to the day's budget. (The burst slot stays
  // taken: upstream calls were made.)
  const unused = slot as { key: string; at: number } | null;
  if (unused) daily.release(unused.key, unused.at);
  if (partial && !cancelled) return respond(partial.model, partial.out, "rows");
  if (cancelled) {
    // Nobody is listening; the status is for the server's log.
    return fail("model_error", "The request was cancelled before the page was read.", 499);
  }
  if (keyRefused) return fail("no_key", KEY_REFUSED_MESSAGE, 503);
  if (blocked) {
    return fail("model_error", "The vision model declined to read this photo. Try a photo that shows only the register page.", 502);
  }
  if (unreadable) {
    return fail("model_error", "Could not read the model's answer. Try again, or try a sharper photo.", 502);
  }
  if (rejectedPhoto) {
    return fail("bad_image", "The vision model could not open this photo. Take it again, or save it as a JPEG and send that.", 422);
  }
  if (quota) return fail("rate_limited", QUOTA_MESSAGE, 429, quotaWait());
  if (tooSlow) {
    return fail("model_error", "The page took too long to read. Try again; if it keeps happening, photograph the page in two halves.", 504);
  }
  // Every model that was asked said it does not exist: trying again cannot help.
  if (asked > 0 && missing === asked) return fail("model_error", MODELS_MISSING_MESSAGE, 503);
  return fail("model_error", "The vision model is not responding right now. Try again in a minute.", 502);
}
