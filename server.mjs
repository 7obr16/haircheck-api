// _design-handoff/api/server.mjs
// Tiny Node sidecar for AFTER-photo generation via OpenAI gpt-image-2.
// Runs on its own port (4322). The frontend (python http.server on 4321)
// POSTs a base64 selfie here, the sidecar holds the OPENAI_API_KEY in
// env (never sent to the browser), calls images/edits, returns the
// generated image as a data URL.
//
// Start: node _design-handoff/api/server.mjs
// Stop:  Ctrl-C
//
// Requires Node 18+ (fetch, FormData, Blob built in). Tested on Node 25.

import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

// ─── In-memory cache for AFTER-photo generation ──────────────────
// gpt-image-2 takes 2-3 minutes per call. Many client retries are the
// same photo (e.g. Safari's 60s fetch timeout cancels client-side but
// the server keeps running and OpenAI does deliver). We cache by SHA-256
// of the input data URL so a retry returns the result instantly.
//
// Also tracks in-flight requests: if request A is mid-generation and
// request B for the same photo arrives, B awaits the same promise
// instead of hitting OpenAI a second time.
const AFTER_CACHE = new Map();           // hash -> { result, at }
const AFTER_INFLIGHT = new Map();        // hash -> Promise<result>
const ADVICE_VISUAL_CACHE = new Map();   // hash -> { result, at }
const ADVICE_VISUAL_INFLIGHT = new Map();// hash -> Promise<result>
const PROGRESSION_CACHE = new Map();     // hash -> { result, at }
const PROGRESSION_INFLIGHT = new Map();  // hash -> Promise<result>
const MAP_CACHE = new Map();             // hash -> { result, at }
const MAP_INFLIGHT = new Map();          // hash -> Promise<result>
const SCAN_CACHE = new Map();            // hash -> { result, at }
const SCAN_INFLIGHT = new Map();         // hash -> Promise<result>
const CACHE_MAX = 50;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h

function cacheHashOf(prefix, ...parts) {
  return createHash('sha256').update(prefix + '\0' + parts.join('\0')).digest('hex');
}

function cacheRead(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) { map.delete(key); return null; }
  return entry.result;
}

function cacheWrite(map, key, result) {
  if (map.size >= CACHE_MAX) {
    // FIFO eviction — drop the oldest entry
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
  map.set(key, { result, at: Date.now() });
}

// ─── env loader (no dotenv dep) ─────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
try {
  const raw = readFileSync(join(here, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
} catch (e) {
  // .env missing is fine — the user can also set OPENAI_API_KEY in the shell
}

if (!process.env.OPENAI_API_KEY) {
  console.error('\n[after-photo api] ERROR: OPENAI_API_KEY is not set.');
  console.error('Paste your key into _design-handoff/api/.env (one line: OPENAI_API_KEY=sk-...) then rerun.\n');
  process.exit(1);
}

let GIT_SHA = process.env.GIT_SHA || 'unknown';
if (GIT_SHA === 'unknown') {
  try { GIT_SHA = execSync('git rev-parse --short HEAD', { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (_) {}
}

const SERVER_START_MS = Date.now();

const PORT = Number(process.env.PORT || 4322);
const SERVE_STATIC = process.env.SERVE_STATIC === '1';
const staticRoot = join(here, '..');
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 14 * 1024 * 1024);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 18);
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  'http://localhost:4321',
  'http://127.0.0.1:4321',
  'capacitor://localhost',
  'ionic://localhost',
  ...(process.env.ALLOWED_ORIGINS || process.env.APP_ORIGIN || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
]);
const rateBuckets = new Map();
// Periodically evict expired rate buckets to prevent unbounded map growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}, 60_000).unref();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jsx': 'text/jsx; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
};

// ─── prompt ─────────────────────────────────────────────────────
// Tight, single-purpose: keep everything identical, only restore hair.
// Edit this string to tune the result.
const AFTER_PROMPT = `Edit this photo. Keep every visual detail identical: same face, same expression, same camera angle, same distance to camera, same head position and tilt, same aspect ratio, same crop/framing, same lighting, same skin tone, same eyes, same ears, same clothing, same background. Do not change framing, pose, or any feature.

Change only one thing: locally improve the visible hair-loss areas while preserving the person's current hairstyle. Only add plausible density inside the already visible thinning, receded, sparse, or bald spots. Fill those weak areas with short, natural hair that matches the existing surrounding hair color, curl/wave pattern, direction, texture, shine, thickness, and ethnicity.

Do NOT create a new hairstyle. Do NOT change the existing hair length, parting, volume, silhouette, styling direction, forehead size, temples beyond the recession area, beard, eyebrows, skin, head shape, or background. Do NOT make the hair look freshly styled, longer, darker, wet, or like a different person. Keep the original hairline character and make it only moderately denser and more even.

The result must be photorealistic and pixel-aligned with the input so it can be used as the AFTER side of a before/after slider.`;

// Per-month progression prompts. 3-month results in real life are subtle —
// the model must NOT overshoot to "perfect" or it stops being credible.
const PROGRESSION_PROMPTS = {
  3: `Edit this photo to show a SUBTLE 3-month treatment result. Keep face, expression, camera angle, distance to camera, head position, aspect ratio, crop/framing, lighting, skin tone, eyes, ears, clothing, and background pixel-identical to the input.

Make ONLY a small, realistic improvement that matches what a user would expect after 12 weeks of minoxidil + supplements + medicated shampoo:
- Slight thickening at the existing thinning edges (NOT in obviously bald spots — those don't fully fill in by month 3)
- Reduce visible scalp shine through hair by maybe 15–20%
- Vellus (peach-fuzz) hair starting to appear in receded zones, but NOT yet fully pigmented
- Hairline shape unchanged — recession edges still visible, just slightly softer

DO NOT regrow lost zones to completion. DO NOT change hair color or style. The user should think "subtle but real" — not "miracle." Most people wouldn't notice unless comparing photos side-by-side.

The result must be photorealistic and pixel-aligned with the input so it can be used as the AFTER side of a before/after slider.`,

  6: `Edit this photo to show a MODERATE 6-month treatment result. Keep face, expression, camera angle, distance to camera, head position, aspect ratio, crop/framing, lighting, skin tone, eyes, ears, clothing, and background pixel-identical to the input.

Make a clearly visible but still realistic improvement that matches what a committed user would see after 6 months of consistent treatment:
- Noticeable density gain in the thinning areas, roughly 40–50% closer to the user's natural full density
- Hairline edges look more defined and the temple recession appears partially filled with new pigmented hair
- Crown/vertex thinning area shows real coverage (not bald patch — nor full restoration)
- Hair color, length, style, and texture exactly match the original

DO NOT make it look like a completely full head of hair. There should still be some evidence of the original hair loss pattern, just clearly improved. The viewer should think "real progress" — not "different person."

The result must be photorealistic and pixel-aligned with the input so it can be used as the AFTER side of a before/after slider.`,

  12: `Edit this photo to show a STRONG 12-month treatment result. Keep face, expression, camera angle, distance to camera, head position, aspect ratio, crop/framing, lighting, skin tone, eyes, ears, clothing, and background pixel-identical to the input.

Make a substantial, realistic improvement matching what a fully-compliant user might achieve after a year of treatment:
- Full natural-looking density across the previously-thin areas
- Hairline restored to a credible age-appropriate shape (NOT a teenager's hairline — match the user's age)
- Crown looks naturally full
- New hair matches the user's existing color, texture, and ethnicity exactly
- A trace of the original recession may still be visible if it was severe — most real cases never reach 100% baseline

DO NOT change hair color, style, length, or any other feature. The viewer should think "best realistic outcome" — clearly the same person with clearly more hair.

The result must be photorealistic and pixel-aligned with the input so it can be used as the AFTER side of a before/after slider.`,
};

const buildAnalysisMapPrompt = (kind, result = {}) => {
  const density = Number.isFinite(Number(result.density)) ? Math.round(Number(result.density)) : 'unknown';
  const crown = Number.isFinite(Number(result.crown)) ? Math.round(Number(result.crown)) : 'unknown';
  const hairline = Number.isFinite(Number(result.hairline)) ? Math.round(Number(result.hairline)) : 'unknown';
  const focus = kind === 'crown'
    ? `Focus the overlay on crown and vertex thinning. Use crown score ${crown}/100, density score ${density}/100, and hairline score ${hairline}/100 as guidance.`
    : `Focus the overlay on visible scalp density across the top, mid-scalp, temples, and hairline. Use density score ${density}/100, crown score ${crown}/100, and hairline score ${hairline}/100 as guidance.`;

  return `Edit this input scan photo into a clear clinical hair-density heatmap of the user's actual head hair. Keep the original photograph underneath completely unchanged: same person, same face, same head position, same camera angle, same distance, same crop/framing, same lighting, same background, same hair style, same hair color, same skin tone, same clothing. Do not beautify, redraw, restore, move, rotate, zoom, or replace anything in the photo.

Add only a visible translucent diagnostic heatmap overlay directly on the hair-bearing scalp region, like a premium trichology analysis screen. The heatmap must be obvious enough that the user immediately sees it is an AI-generated scalp map, not just their original photo. ${focus}

Overlay rules:
- Green/teal means high density.
- Yellow/orange means medium density.
- Red means low density or visible thinning.
- Align the colored regions to the actual visible hairline, temples, mid-scalp, crown, vertex, and visible scalp in the image. Do not place heatmap color on the face, eyes, neck, hands, clothing, wall, or background.
- Use several soft contour patches and gradients that follow the shape of the head and hair. Low-density zones should get red/orange patches; stronger hair zones should get teal/green patches.
- Keep the overlay semi-transparent so the original photo remains clearly visible, but make the color patches strong enough to read on a phone screen.
- It may include subtle scan-grid texture, small non-text dots, or soft contour lines over the scalp/hair only, but no words, no numbers, no UI labels, no arrows, no legend, no watermark.

Return the same aspect ratio and the same framing as the input. This is an analysis overlay image, not a before/after restoration.`;
};

const ADVICE_VISUAL_PROMPTS = {
  topical: `Create a photorealistic premium hair-health app advice card image. Subject: close crop of a realistic male hairline/top scalp while a glass dropper applies topical serum to the target area. Add a subtle translucent violet diagnostic glow over the application zone, but no UI and no text. Style: dark luxury clinical lighting, realistic skin and hair texture, black background, shallow depth of field, expensive medical-aesthetic. Avoid brand names, logos, labels, watermarks, extra text, cartoon style, and exaggerated hair restoration.`,
  supplements: `Create a photorealistic premium hair-health app advice card image. Subject: a dark luxury still life of neutral hair supplements beside a glass of water on a black marble surface. Style: restrained medical-aesthetic, subtle violet rim light, realistic capsule shapes without identifiable logos. Avoid brand names, labels, watermarks, text, UI, messy clutter, and bright pharmacy colors.`,
  massage: `Create a photorealistic premium hair-health app advice card image. Subject: close crop of gentle scalp massage on dark hair, clean hands parting hair, healthy scalp texture visible. Style: dark premium clinical background, subtle teal/violet light, calm aspirational mood, realistic. Avoid text, logos, watermark, cartoon style, medical gore, or hands covering the entire scalp.`,
  shampoo: `Create a photorealistic premium hair-health app advice card image. Subject: matte black unbranded medicated shampoo bottle beside rich foam, water droplets, and dark hair texture on black stone. Style: dark clinical luxury, high detail, subtle violet rim light, aspirational but medical-aesthetic. Avoid people, shower nudity, text, labels, logos, watermark, UI, and generic stock-photo brightness.`,
};

const normalizeAdviceKind = (kind) => (
  Object.prototype.hasOwnProperty.call(ADVICE_VISUAL_PROMPTS, String(kind || '').toLowerCase())
    ? String(kind).toLowerCase()
    : 'topical'
);

// ─── helpers ────────────────────────────────────────────────────
const requestId = () => `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const originAllowed = (origin) => {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const { hostname: host, protocol } = new URL(origin);
    if (protocol === 'capacitor:' || protocol === 'ionic:') return host === 'localhost';
    return host === 'localhost'
      || host === '127.0.0.1'
      || host.endsWith('.loca.lt')
      || host.endsWith('.ngrok-free.app')
      || host.endsWith('.trycloudflare.com');
  } catch (_) {
    return false;
  }
};

const cors = (req, res) => {
  const origin = req.headers.origin;
  const ok = originAllowed(origin);
  if (origin && ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return ok;
};

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readJsonBody = async (req) => {
  let body = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const err = new Error(`Request body too large. Limit is ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB.`);
      err.statusCode = 413;
      throw err;
    }
    body += chunk;
  }
  try {
    return JSON.parse(body || '{}');
  } catch (_) {
    const err = new Error('Invalid JSON body');
    err.statusCode = 400;
    throw err;
  }
};

const rateLimit = (req) => {
  if (req.method !== 'POST') return null;
  const now = Date.now();
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const key = forwardedFor || req.socket.remoteAddress || 'unknown';
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > RATE_LIMIT_MAX) {
    return {
      status: 429,
      body: {
        error: 'Too many requests. Please wait a minute and try again.',
        retryAfterMs: Math.max(0, bucket.resetAt - now),
      },
    };
  }
  return null;
};

const normalizeOpenAIError = (fallback, status, payload) => {
  const code = payload?.error?.code || payload?.code || null;
  const message = payload?.error?.message || payload?.message || fallback;
  const billing = code === 'billing_hard_limit_reached'
    || code === 'insufficient_quota'
    || /billing|quota/i.test(message || '');
  return {
    error: billing
      ? 'OpenAI generation is temporarily paused because billing or quota is unavailable.'
      : message,
    code,
    retryable: billing || status === 429 || status >= 500,
    detail: payload,
  };
};

// Retry OpenAI calls on transient errors (429, 5xx) with exponential backoff.
// requestFactory receives an AbortSignal each attempt; must return a new fetch Promise
// (FormData can't be reused, and we need a fresh controller per attempt).
// timeoutMs: per-attempt hard limit; on timeout the attempt is retried if attempts remain.
const withOpenAIRetry = async (label, requestFactory, { maxAttempts = 3, baseDelayMs = 1000, timeoutMs } = {}) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let controller = null;
    let timer = null;
    if (timeoutMs) {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    let r;
    try {
      r = await requestFactory(controller?.signal);
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err.name === 'AbortError') {
        const msg = `${label} timed out after ${timeoutMs}ms (attempt ${attempt}/${maxAttempts})`;
        if (attempt >= maxAttempts) {
          const e = new Error(msg);
          e.statusCode = 504;
          throw e;
        }
        const delay = baseDelayMs * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
        console.log(`[openai retry] ${label} timeout attempt=${attempt}/${maxAttempts} delay=${Math.round(delay)}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
    if (timer) clearTimeout(timer);

    const text = await r.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    if (r.ok) return { ok: true, status: r.status, payload };
    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable || attempt >= maxAttempts) {
      return { ok: false, status: r.status, payload };
    }
    const delay = baseDelayMs * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
    console.log(`[openai retry] ${label} status=${r.status} attempt=${attempt}/${maxAttempts} delay=${Math.round(delay)}ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const dataUrlToBuffer = (dataUrl) => {
  const m = dataUrl.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i);
  if (!m) throw new Error('Expected data:image/...;base64,...');
  const mime = m[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.has(mime)) {
    const err = new Error(`Unsupported image type "${mime}". Accepted: jpeg, png, webp, gif.`);
    err.statusCode = 415;
    throw err;
  }
  return { mime, buffer: Buffer.from(m[2], 'base64') };
};

const serveStatic = (req, res) => {
  if (!SERVE_STATIC || (req.method !== 'GET' && req.method !== 'HEAD')) return false;

  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  let filePath = normalize(join(staticRoot, pathname));
  if (!filePath.startsWith(staticRoot) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return false;
  }

  // Phone previews go through a slow HTTPS tunnel. Serve pre-compressed WebP
  // siblings for PNG assets while keeping the public paths unchanged.
  if (extname(filePath).toLowerCase() === '.png') {
    const fastPath = join(dirname(filePath), 'fast', `${basename(filePath, '.png')}.webp`);
    if (existsSync(fastPath) && statSync(fastPath).isFile()) {
      filePath = fastPath;
    }
  }

  res.writeHead(200, {
    'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': extname(filePath).toLowerCase() === '.webp'
      ? 'public, max-age=3600'
      : 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(filePath).pipe(res);
  return true;
};

// ─── Graceful shutdown ───────────────────────────────────────────
// Railway sends SIGTERM on deploy/restart. Without a handler, Node exits
// immediately and aborts in-flight image-generation requests. With this
// handler the server stops accepting new connections and has 25 s to drain
// before a forced exit (Railway's hard kill timeout is 30 s by default).
let isShuttingDown = false;
let openRequests = 0;

const shutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[shutdown] ${signal} received — open requests: ${openRequests}`);
  server.close(() => {
    console.log('[shutdown] server closed cleanly');
    process.exit(0);
  });
  setTimeout(() => {
    console.log('[shutdown] drain timeout — forcing exit');
    process.exit(0);
  }, 25_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── server ─────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const reqId = requestId();
  const reqStart = Date.now();
  openRequests++;
  res.once('finish', () => { openRequests--; });

  res.setHeader('X-Request-Id', reqId);
  console.log(`[req] ${req.method} ${req.url} ${reqId}`);
  const origEnd = res.end.bind(res);
  res.end = (...args) => {
    console.log(`[res] ${req.method} ${req.url} ${reqId} ${res.statusCode} ${Date.now() - reqStart}ms`);
    return origEnd(...args);
  };

  // Reject new non-health requests during graceful shutdown
  if (isShuttingDown && req.url !== '/api/health') {
    res.setHeader('Retry-After', '10');
    json(res, 503, { error: 'Server is restarting. Please retry in a few seconds.', requestId: reqId });
    return;
  }

  const corsOk = cors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(corsOk ? 204 : 403).end();
    return;
  }

  if (!corsOk) {
    json(res, 403, { error: 'Origin not allowed', requestId: reqId });
    return;
  }

  const limited = rateLimit(req);
  if (limited) {
    json(res, limited.status, { ...limited.body, requestId: reqId });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    json(res, 200, { ok: true, model: 'gpt-image-2', port: PORT, sha: GIT_SHA, uptimeSeconds: Math.floor((Date.now() - SERVER_START_MS) / 1000), requestId: reqId });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/version') {
    json(res, 200, { sha: GIT_SHA, requestId: reqId });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/generate-after') {
    try {
      const { photoDataUrl, prompt, quality: qParam } = await readJsonBody(req);
      if (!photoDataUrl) throw new Error('photoDataUrl required (data:image/...;base64,...)');

      // Quality knob — gpt-image-2 supports: auto | high | medium | low.
      // Default 'low' for fastest experience (~30s vs ~200s for high).
      // Pass `"quality":"high"` from the client to force premium.
      const quality = ['auto','high','medium','low'].includes(qParam) ? qParam : 'low';

      const effectivePrompt = prompt || AFTER_PROMPT;
      const { mime, buffer } = dataUrlToBuffer(photoDataUrl);
      const hash = cacheHashOf('after', mime, buffer.length, createHash('sha256').update(buffer).digest('hex'), effectivePrompt, quality);

      // 1. Cache hit — return instantly
      const cached = cacheRead(AFTER_CACHE, hash);
      if (cached) {
        console.log('[openai] generate-after CACHE HIT', { hash: hash.slice(0, 8) });
        json(res, 200, { afterPhoto: cached, cached: true, requestId: reqId });
        return;
      }

      // 2. In-flight dedup — piggyback on the same OpenAI call
      let inflight = AFTER_INFLIGHT.get(hash);
      if (inflight) {
        console.log('[openai] generate-after IN-FLIGHT JOIN', { hash: hash.slice(0, 8) });
        const result = await inflight;
        if (result.ok) {
          json(res, 200, { afterPhoto: result.afterPhoto, deduped: true, requestId: reqId });
        } else {
          json(res, result.status || 502, { error: result.error, requestId: reqId });
        }
        return;
      }

      const startedAt = Date.now();
      console.log('[openai] generate-after START', { hash: hash.slice(0, 8), mime, inputKb: Math.round(buffer.length / 1024) });

      const promise = (async () => {
        const { ok, status, payload } = await withOpenAIRetry('generate-after', (signal) => {
          const fd = new FormData();
          fd.append('model', 'gpt-image-2');
          fd.append('image', new Blob([buffer], { type: mime }), 'selfie.png');
          fd.append('prompt', effectivePrompt);
          fd.append('n', '1');
          fd.append('size', 'auto');
          fd.append('quality', quality);
          return fetch('https://api.openai.com/v1/images/edits', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: fd,
            signal,
          });
        }, { maxAttempts: 2, timeoutMs: 300_000 });

        if (!ok) {
          console.error('[openai] generate-after error', status, payload);
          return { ok: false, status, error: payload };
        }
        const b64 = payload?.data?.[0]?.b64_json;
        if (!b64) return { ok: false, status: 502, error: 'No image returned' };
        return { ok: true, afterPhoto: `data:image/png;base64,${b64}` };
      })();

      AFTER_INFLIGHT.set(hash, promise);
      let result;
      try {
        result = await promise;
      } finally {
        AFTER_INFLIGHT.delete(hash);
      }

      if (!result.ok) {
        json(res, result.status || 502, { ...normalizeOpenAIError('OpenAI request failed', result.status, result.error), requestId: reqId });
        return;
      }
      cacheWrite(AFTER_CACHE, hash, result.afterPhoto);
      console.log('[openai] generate-after OK', { ms: Date.now() - startedAt, hash: hash.slice(0, 8) });
      json(res, 200, { afterPhoto: result.afterPhoto, requestId: reqId });
    } catch (err) {
      console.error('[server] handler error', err);
      json(res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/generate-progression — N-month after-photo via gpt-image-2 ─
  // Input: { photoDataUrl, month: 3 | 6 | 12 }
  // Output: { afterPhoto: 'data:image/png;base64,...' }
  // Cost: ~$0.05 per call. Caller should cache aggressively in localStorage.
  if (req.method === 'POST' && req.url === '/api/generate-progression') {
    try {
      const { photoDataUrl, month, quality: qParam } = await readJsonBody(req);
      if (!photoDataUrl) throw new Error('photoDataUrl required');
      const m = Number(month);
      if (!PROGRESSION_PROMPTS[m]) throw new Error('month must be 3, 6, or 12');
      const quality = ['auto', 'high', 'medium', 'low'].includes(qParam) ? qParam : 'high';

      const { mime, buffer } = dataUrlToBuffer(photoDataUrl);
      const hash = cacheHashOf('progression', mime, createHash('sha256').update(buffer).digest('hex'), String(m), quality);

      // 1. Cache hit — return instantly
      const progCached = cacheRead(PROGRESSION_CACHE, hash);
      if (progCached) {
        console.log('[progression] CACHE HIT', { month: m, hash: hash.slice(0, 8) });
        json(res, 200, { afterPhoto: progCached, month: m, cached: true, requestId: reqId });
        return;
      }

      // 2. In-flight dedup
      let progInflight = PROGRESSION_INFLIGHT.get(hash);
      if (progInflight) {
        console.log('[progression] IN-FLIGHT JOIN', { month: m, hash: hash.slice(0, 8) });
        const progResult = await progInflight;
        if (progResult.ok) {
          json(res, 200, { afterPhoto: progResult.afterPhoto, month: m, deduped: true, requestId: reqId });
        } else {
          json(res, progResult.status || 502, { ...normalizeOpenAIError('OpenAI request failed', progResult.status, progResult.error), requestId: reqId });
        }
        return;
      }

      const startedAt = Date.now();
      console.log('[progression] start', { month: m, mime, inputKb: Math.round(buffer.length / 1024), quality });

      const progPromise = (async () => {
        const { ok, status, payload } = await withOpenAIRetry('generate-progression', (signal) => {
          const fd = new FormData();
          fd.append('model', 'gpt-image-2');
          fd.append('image', new Blob([buffer], { type: mime }), 'selfie.png');
          fd.append('prompt', PROGRESSION_PROMPTS[m]);
          fd.append('n', '1');
          fd.append('size', 'auto');
          fd.append('quality', quality);
          return fetch('https://api.openai.com/v1/images/edits', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: fd,
            signal,
          });
        }, { maxAttempts: 2, timeoutMs: 300_000 });
        if (!ok) {
          console.error('[openai progression] error', status, payload);
          return { ok: false, status, error: payload };
        }
        const b64 = payload?.data?.[0]?.b64_json;
        if (!b64) return { ok: false, status: 502, error: 'No image returned' };
        return { ok: true, afterPhoto: `data:image/png;base64,${b64}` };
      })();

      PROGRESSION_INFLIGHT.set(hash, progPromise);
      let progResult;
      try {
        progResult = await progPromise;
      } finally {
        PROGRESSION_INFLIGHT.delete(hash);
      }

      if (!progResult.ok) {
        json(res, progResult.status || 502, { ...normalizeOpenAIError('OpenAI request failed', progResult.status, progResult.error), requestId: reqId });
        return;
      }
      cacheWrite(PROGRESSION_CACHE, hash, progResult.afterPhoto);
      console.log('[progression] ok', { month: m, ms: Date.now() - startedAt, hash: hash.slice(0, 8) });
      json(res, 200, { afterPhoto: progResult.afterPhoto, month: m, requestId: reqId });
    } catch (err) {
      console.error('[server] generate-progression error', err);
      json(res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/generate-analysis-map — photo-locked GPT image edit overlay ─
  // Input: { photoDataUrl, kind: 'density' | 'crown', result? }
  // Output: { analysisMap: 'data:image/png;base64,...', kind }
  if (req.method === 'POST' && req.url === '/api/generate-analysis-map') {
    try {
      const { photoDataUrl, kind = 'density', result: scanScores = {} } = await readJsonBody(req);
      if (!photoDataUrl) throw new Error('photoDataUrl required');
      const mapKind = String(kind).toLowerCase() === 'crown' ? 'crown' : 'density';

      const { mime, buffer } = dataUrlToBuffer(photoDataUrl);
      // Include scores in cache key because buildAnalysisMapPrompt interpolates them
      const scoreKey = [
        Number.isFinite(Number(scanScores.density)) ? Math.round(Number(scanScores.density)) : 'x',
        Number.isFinite(Number(scanScores.crown)) ? Math.round(Number(scanScores.crown)) : 'x',
        Number.isFinite(Number(scanScores.hairline)) ? Math.round(Number(scanScores.hairline)) : 'x',
      ].join(',');
      const hash = cacheHashOf('map', mime, createHash('sha256').update(buffer).digest('hex'), mapKind, scoreKey);

      // 1. Cache hit — return instantly
      const mapCached = cacheRead(MAP_CACHE, hash);
      if (mapCached) {
        console.log('[analysis-map] CACHE HIT', { kind: mapKind, hash: hash.slice(0, 8) });
        json(res, 200, { analysisMap: mapCached, kind: mapKind, cached: true, requestId: reqId });
        return;
      }

      // 2. In-flight dedup
      let mapInflight = MAP_INFLIGHT.get(hash);
      if (mapInflight) {
        console.log('[analysis-map] IN-FLIGHT JOIN', { kind: mapKind, hash: hash.slice(0, 8) });
        const mapResult = await mapInflight;
        if (mapResult.ok) {
          json(res, 200, { analysisMap: mapResult.analysisMap, kind: mapKind, deduped: true, requestId: reqId });
        } else {
          json(res, mapResult.status || 502, { ...normalizeOpenAIError('OpenAI request failed', mapResult.status, mapResult.error), requestId: reqId });
        }
        return;
      }

      const startedAt = Date.now();
      console.log('[analysis-map] start', { kind: mapKind, mime, inputKb: Math.round(buffer.length / 1024) });

      const mapPromptText = buildAnalysisMapPrompt(mapKind, scanScores);
      const mapPromise = (async () => {
        const { ok, status, payload } = await withOpenAIRetry('generate-analysis-map', (signal) => {
          const fd = new FormData();
          fd.append('model', 'gpt-image-2');
          fd.append('image', new Blob([buffer], { type: mime }), 'scan.png');
          fd.append('prompt', mapPromptText);
          fd.append('n', '1');
          fd.append('size', 'auto');
          fd.append('quality', 'medium');
          return fetch('https://api.openai.com/v1/images/edits', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: fd,
            signal,
          });
        }, { maxAttempts: 2, timeoutMs: 300_000 });
        if (!ok) {
          console.error('[analysis-map] error', status, payload);
          return { ok: false, status, error: payload };
        }
        const b64 = payload?.data?.[0]?.b64_json;
        if (!b64) return { ok: false, status: 502, error: 'No image returned' };
        return { ok: true, analysisMap: `data:image/png;base64,${b64}` };
      })();

      MAP_INFLIGHT.set(hash, mapPromise);
      let mapResult;
      try {
        mapResult = await mapPromise;
      } finally {
        MAP_INFLIGHT.delete(hash);
      }

      if (!mapResult.ok) {
        json(res, mapResult.status || 502, { ...normalizeOpenAIError('OpenAI request failed', mapResult.status, mapResult.error), requestId: reqId });
        return;
      }
      cacheWrite(MAP_CACHE, hash, mapResult.analysisMap);
      console.log('[analysis-map] ok', { kind: mapKind, ms: Date.now() - startedAt, hash: hash.slice(0, 8) });
      json(res, 200, { analysisMap: mapResult.analysisMap, kind: mapKind, requestId: reqId });
    } catch (err) {
      console.error('[server] generate-analysis-map error', err);
      json(res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/generate-advice-visual — image-led protocol card art ─
  // Input: { kind: 'topical' | 'supplements' | 'massage' | 'shampoo', quality? }
  // Output: { adviceVisual: 'data:image/png;base64,...', kind }
  if (req.method === 'POST' && req.url === '/api/generate-advice-visual') {
    try {
      const { kind, quality: qParam } = await readJsonBody(req);
      const visualKind = normalizeAdviceKind(kind);
      const quality = ['auto','high','medium','low'].includes(qParam) ? qParam : 'low';
      const prompt = ADVICE_VISUAL_PROMPTS[visualKind];
      const hash = cacheHashOf('advice-visual', visualKind, prompt, quality);

      const cached = cacheRead(ADVICE_VISUAL_CACHE, hash);
      if (cached) {
        console.log('[advice-visual] CACHE HIT', { kind: visualKind, hash: hash.slice(0, 8) });
        json(res, 200, { adviceVisual: cached, kind: visualKind, cached: true, requestId: reqId });
        return;
      }

      let inflight = ADVICE_VISUAL_INFLIGHT.get(hash);
      if (inflight) {
        console.log('[advice-visual] IN-FLIGHT JOIN', { kind: visualKind, hash: hash.slice(0, 8) });
        const result = await inflight;
        if (result.ok) {
          json(res, 200, { adviceVisual: result.adviceVisual, kind: visualKind, deduped: true, requestId: reqId });
        } else {
          json(res, result.status || 502, { ...normalizeOpenAIError('OpenAI request failed', result.status, result.error), requestId: reqId });
        }
        return;
      }

      const startedAt = Date.now();
      console.log('[advice-visual] start', { kind: visualKind, quality });

      const promise = (async () => {
        const reqBody = JSON.stringify({ model: 'gpt-image-2', prompt, n: 1, size: '1024x1024', quality, output_format: 'png' });
        const { ok, status, payload } = await withOpenAIRetry('generate-advice-visual', (signal) =>
          fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: reqBody,
            signal,
          }),
          { maxAttempts: 2, timeoutMs: 300_000 }
        );

        if (!ok) {
          console.error('[advice-visual] error', status, payload);
          return { ok: false, status, error: payload };
        }
        const b64 = payload?.data?.[0]?.b64_json;
        if (!b64) return { ok: false, status: 502, error: 'No image returned' };
        return { ok: true, adviceVisual: `data:image/png;base64,${b64}` };
      })();

      ADVICE_VISUAL_INFLIGHT.set(hash, promise);
      let result;
      try {
        result = await promise;
      } finally {
        ADVICE_VISUAL_INFLIGHT.delete(hash);
      }

      if (!result.ok) {
        json(res, result.status || 502, { ...normalizeOpenAIError('OpenAI request failed', result.status, result.error), requestId: reqId });
        return;
      }
      cacheWrite(ADVICE_VISUAL_CACHE, hash, result.adviceVisual);
      console.log('[advice-visual] ok', { kind: visualKind, ms: Date.now() - startedAt, hash: hash.slice(0, 8) });
      json(res, 200, { adviceVisual: result.adviceVisual, kind: visualKind, requestId: reqId });
    } catch (err) {
      console.error('[server] generate-advice-visual error', err);
      json(res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/analyze-scan — GPT-4o Vision → full scan result ────────
  // Input: { photoDataUrl, profile? }
  // Output: full scan record with scores + Norwood + headline + 3 insights + verdict
  // Cost: ~$0.01 per call.
  if (req.method === 'POST' && req.url === '/api/analyze-scan') {
    try {
      const { photoDataUrl, profile = {}, scoringInstruction = '' } = await readJsonBody(req);
      if (!photoDataUrl) throw new Error('photoDataUrl required');
      const { buffer: visionBuffer } = dataUrlToBuffer(photoDataUrl);

      // Cache by (photo content + profile + scoringInstruction) to avoid re-billing
      // the same scan on retries or double-taps. TTL is 24h (same as image cache).
      const profileKey = JSON.stringify(profile);
      const scanHash = cacheHashOf('scan', createHash('sha256').update(visionBuffer).digest('hex'), profileKey, scoringInstruction);

      const scanCached = cacheRead(SCAN_CACHE, scanHash);
      if (scanCached) {
        console.log('[vision] CACHE HIT', { hash: scanHash.slice(0, 8) });
        json(res, 200, { ...scanCached, cached: true, requestId: reqId });
        return;
      }

      const scanInflight = SCAN_INFLIGHT.get(scanHash);
      if (scanInflight) {
        console.log('[vision] IN-FLIGHT JOIN', { hash: scanHash.slice(0, 8) });
        const scanResult = await scanInflight;
        if (scanResult.ok) {
          json(res, 200, { ...scanResult.data, deduped: true, requestId: reqId });
        } else {
          json(res, scanResult.status || 502, { error: scanResult.error, requestId: reqId });
        }
        return;
      }

      const startedAt = Date.now();
      console.log('[vision] start', { inputKb: Math.round(visionBuffer.length / 1024) });

      const ctx = [
        `Sex: ${profile.sex || 'unspecified'}`,
        `Age: ${profile.age || 'unspecified'}`,
        `Concerns: ${Array.isArray(profile.concern) ? (profile.concern.join(', ') || 'none') : (profile.concern || 'none')}`,
        `Onset: ${profile.timeline || 'unspecified'}`,
        `Family history: ${(profile.family || []).join(', ') || 'none reported'}`,
        `Stress: ${profile.lifestyle?.stress ?? '?'}/10`,
        `Sleep: ${profile.lifestyle?.sleep ?? '?'}h`,
        `Current routine: ${(profile.routine || []).join(', ') || 'none'}`,
        `Goals: ${(profile.goals || []).join(', ') || 'unspecified'}`,
        scoringInstruction ? `Scoring instruction: ${String(scoringInstruction).slice(0, 280)}` : '',
      ].join('\n');

      const sys = `You are an aesthetic hair-analysis AI for a consumer hair-loss app. Look at the scalp photo and the user's profile context, then return ONLY valid JSON (no prose, no markdown). Required shape:

{
  "hairline":   0-100,
  "density":    0-100,
  "crown":      0-100,
  "health":     0-100,
  "potential":  0-100,
  "stage":      "NW1" | "NW2" | "NW3" | "NW3v" | "NW4" | "NW5" | "NW6" | "NW7" | "diffuse" | "n/a (female)",
  "headline":   "<6-9 word punchy summary, confident tone>",
  "insights": [
    { "title": "<5-word title>", "body": "<12-22 word actionable observation>", "metric": "Hairline" | "Density" | "Crown" | "Health" | "Potential" }
  ],
  "verdict":    "<1-2 sentence verdict, slightly aspirational, no medical claims>"
}

Norwood staging visual guide — pick the stage whose description best matches what is visible in the photo:
NW1: Hairline at or above the upper forehead crease; no perceptible recession; temples full.
NW2: Slight symmetric temple recession forming a shallow V or M; hairline still above the frontotemporal angle.
NW3: Deep bilateral temple recession extending past the mid-pupil vertical line; forelock may still be present but temples are significantly receded.
NW3v: Same temple recession as NW3 PLUS early thinning at the vertex (crown) visible from above.
NW4: Frontal hairline loss extends toward mid-scalp; pronounced crown thinning; a clear band of hair still separates frontal zone from crown.
NW5: The band between frontal and crown zones is narrow and sparse; the two loss regions are nearly merging.
NW6: Frontal and crown bald zones have merged; only a lateral fringe remains; no band across the top.
NW7: Minimal horseshoe-shaped fringe of hair along sides and back only; near-total loss across the entire scalp top.
diffuse: Widespread diffuse thinning without a distinct recession pattern (typical in women, telogen effluvium, or diffuse androgenetic alopecia).
n/a (female): Use for female-presenting patients where the classic Norwood scale does not apply — prefer Ludwig classification mentally but output "n/a (female)".

Scoring guide: 100 = full healthy hair, 0 = severe loss. potential = realistic improvement headroom with a consistent routine (lower if already very healthy, higher when there is visible room to improve). Use a balanced visual baseline: score what is actually visible in the photo and user context. Do not artificially lower scores for healthy-looking or stable-looking areas, and do not push users into a low range just for motivation. Typical mild early thinning can land 62-78 overall; clearly healthy cases can land 78-90; significant visible recession or density loss can land 35-62; 91+ should be rare. If the photo doesn't clearly show hair, use a moderate uncertainty range around 62-76 and reflect uncertainty in the verdict. Be honest but encouraging. Never refuse — produce a best-effort estimate. Insights array MUST contain exactly 3 entries.`;

      const scanReqBody = JSON.stringify({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this scalp photo with the context below. Return JSON only.\n\n' + ctx },
              { type: 'image_url', image_url: { url: photoDataUrl } },
            ],
          },
        ],
        temperature: 0.3,
        max_tokens: 700,
      });

      const scanPromise = (async () => {
        const { ok: scanOk, status: scanStatus, payload: scanPayload } = await withOpenAIRetry('analyze-scan', (signal) =>
          fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: scanReqBody,
            signal,
          }),
          { timeoutMs: 90_000 }
        );

        if (!scanOk) {
          console.error('[openai vision] error', scanStatus, scanPayload);
          return { ok: false, status: scanStatus, error: normalizeOpenAIError('Vision request failed', scanStatus, scanPayload) };
        }

        let parsed;
        try { parsed = JSON.parse(scanPayload.choices?.[0]?.message?.content || '{}'); }
        catch (e) { return { ok: false, status: 502, error: { error: 'Vision returned non-JSON' } }; }

        const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
        const data = {
          hairline:  clamp(parsed.hairline),
          density:   clamp(parsed.density),
          crown:     clamp(parsed.crown ?? parsed.density),
          health:    clamp(parsed.health),
          potential: clamp(parsed.potential),
          stage:     parsed.stage || 'n/a',
          headline:  String(parsed.headline || 'Strong baseline. Real room to improve.').slice(0, 120),
          insights:  Array.isArray(parsed.insights) ? parsed.insights.slice(0, 3) : [],
          verdict:   String(parsed.verdict || '').slice(0, 400),
        };
        // Include all 5 metrics in overall: hairline, density, crown, health, potential.
        data.overall = Math.round((data.hairline + data.density + data.crown + data.health + data.potential) / 5);

        const scanUsage = scanPayload.usage;
        console.log('[vision] ok', { overall: data.overall, stage: data.stage, ms: Date.now() - startedAt, tokens: scanUsage ? { prompt: scanUsage.prompt_tokens, completion: scanUsage.completion_tokens } : null });
        return { ok: true, data };
      })();

      SCAN_INFLIGHT.set(scanHash, scanPromise);
      let scanOutcome;
      try {
        scanOutcome = await scanPromise;
      } finally {
        SCAN_INFLIGHT.delete(scanHash);
      }

      if (!scanOutcome.ok) {
        json(res, scanOutcome.status || 502, { ...scanOutcome.error, requestId: reqId });
        return;
      }
      cacheWrite(SCAN_CACHE, scanHash, scanOutcome.data);
      json(res, 200, { ...scanOutcome.data, requestId: reqId });
    } catch (err) {
      console.error('[server] analyze-scan error', err);
      json(res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/coach — GPT-4o chat with user context ──────────────
  // Input: { message, history, userContext: { result, routine, profile, history, planProducts, routineDoneToday, weakestMetric } }
  // Output: { reply }
  // Cost: ~$0.005/message. History trimmed to last 10 turns to keep it cheap.
  if (req.method === 'POST' && req.url === '/api/coach') {
    try {
      const { message, history = [], userContext = {} } = await readJsonBody(req);
      if (!message || typeof message !== 'string') throw new Error('message required');
      const startedAt = Date.now();

      const ctx = {
        scan: userContext.result ? {
          overall: userContext.result.overall,
          hairline: userContext.result.hairline,
          density: userContext.result.density,
          crown: userContext.result.crown,
          health: userContext.result.health,
          potential: userContext.result.potential,
        } : null,
        routine: Array.isArray(userContext.routine) ? userContext.routine : [],
        scanHistory: Array.isArray(userContext.history) ? userContext.history.slice(-6) : [],
        planProducts: Array.isArray(userContext.planProducts) ? userContext.planProducts.slice(0, 8) : [],
        routineDoneToday: Array.isArray(userContext.routineDoneToday) ? userContext.routineDoneToday.slice(0, 12) : [],
        weakestMetric: userContext.weakestMetric || null,
        age: userContext.profile?.age || null,
        sex: userContext.profile?.sex || null,
      };

      const systemPrompt = [
        'You are HairlineCheck Coach — an AI specialist on male/female hair loss.',
        'Tone: friendly, direct, evidence-based. Avoid medical disclaimers unless specifically asked.',
        'Constraints: never prescribe Rx drugs; recommend talking to a doctor for finasteride/dutasteride.',
        'Length: short, scannable. Use bullets when listing options.',
        '',
        'User context (use when relevant, do not parrot back):',
        ctx.scan ? `- Last scan: overall ${ctx.scan.overall}/100, hairline ${ctx.scan.hairline}, density ${ctx.scan.density}, crown ${ctx.scan.crown}, health ${ctx.scan.health}, potential ${ctx.scan.potential}.` : '- No scan yet.',
        ctx.weakestMetric?.label ? `- Current weakest metric: ${ctx.weakestMetric.label} (${ctx.weakestMetric.value}/100).` : '',
        ctx.routine.length ? `- Current routine: ${ctx.routine.join(', ')}.` : '- No routine logged yet.',
        ctx.routineDoneToday.length ? `- Routine tasks completed today: ${ctx.routineDoneToday.join(', ')}.` : '- No routine tasks completed today.',
        ctx.planProducts.length ? `- Saved plan products: ${ctx.planProducts.join(', ')}.` : '- No saved plan products yet.',
        ctx.scanHistory.length ? `- Scan history count: ${ctx.scanHistory.length}. Latest first values: ${ctx.scanHistory.map((h) => h.overall || '?').join(', ')}.` : '- No scan history yet.',
        ctx.age ? `- Age: ${ctx.age}.` : '',
        ctx.sex ? `- Sex: ${ctx.sex}.` : '',
      ].filter(Boolean).join('\n');

      // Trim history to last 10 turns for cost control
      const recentHistory = Array.isArray(history) ? history.slice(-10) : [];
      const messages = [
        { role: 'system', content: systemPrompt },
        ...recentHistory.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || '').slice(0, 1500) })),
        { role: 'user', content: message.slice(0, 1500) },
      ];

      const coachReqBody = JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.6, max_tokens: 500 });
      const { ok: coachOk, status: coachStatus, payload: coachPayload } = await withOpenAIRetry('coach', (signal) =>
        fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: coachReqBody,
          signal,
        }),
        { timeoutMs: 60_000 }
      );

      if (!coachOk) {
        console.error('[coach] error', coachStatus, coachPayload);
        json(res, coachStatus, { ...normalizeOpenAIError('Coach request failed', coachStatus, coachPayload), requestId: reqId });
        return;
      }

      const reply = coachPayload.choices?.[0]?.message?.content?.trim() || '';
      const coachUsage = coachPayload.usage;
      if (coachUsage) console.log('[coach] ok', { ms: Date.now() - startedAt, tokens: { prompt: coachUsage.prompt_tokens, completion: coachUsage.completion_tokens } });
      json(res, 200, { reply, requestId: reqId });
    } catch (err) {
      console.error('[server] coach error', err);
      json(res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  if (serveStatic(req, res)) return;

  json(res, 404, { error: 'Not found', requestId: reqId });
});

server.listen(PORT, () => {
  console.log(`\n[hairlinecheck api] running on http://localhost:${PORT} sha=${GIT_SHA}`);
  if (SERVE_STATIC) console.log(`[hairlinecheck api] serving static app from ${staticRoot}`);
  console.log(`[hairlinecheck api] POST /api/generate-after { photoDataUrl }`);
  console.log(`[hairlinecheck api] POST /api/generate-analysis-map { photoDataUrl, kind }`);
  console.log(`[hairlinecheck api] POST /api/generate-advice-visual { kind }`);
  console.log(`[hairlinecheck api] POST /api/analyze-scan   { photoDataUrl }`);
  console.log(`[hairlinecheck api] POST /api/coach          { message, history, userContext }`);
  console.log(`[hairlinecheck api] GET  /api/health`);
  console.log(`[hairlinecheck api] GET  /api/version\n`);
});
