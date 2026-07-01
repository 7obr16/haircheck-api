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
import { gzipSync } from 'node:zlib';

// ─── Norwood stage severity index ────────────────────────────────
// Numeric 1-7 (with 0.5 steps) mapping each stage to a severity value.
// Exposed in the scan response so the iOS app can render severity bars,
// sort scan history by progression, or compare stages without string logic.
const STAGE_SEVERITY_INDEX = {
  'NW1':          1,
  'NW2':          2,
  'NW3':          3,
  'NW3v':         3.5,
  'NW4':          4,
  'NW5':          5,
  'NW6':          6,
  'NW7':          7,
  'diffuse':      3,
  'n/a (female)': 3,
};

// ─── Norwood stage descriptions ─────────────────────────────────
// Used in the scan response (stageLabel) and coach context.
const NORWOOD_GUIDE = {
  NW1:  'Full hairline, no visible loss — protective / maintenance phase',
  NW2:  'Slight temple recession — very early; OTC topicals work best now',
  NW3:  'Clear bilateral temple recession past mid-pupil — established AGA; strong treatment response window',
  NW3v: 'NW3 temples + early crown thinning — dual-zone priority',
  NW4:  'Significant frontal + crown loss — consistent multi-therapy protocol important',
  NW5:  'Frontal and crown zones nearly merging — still treatable; realistic expectations matter',
  NW6:  'Frontal and crown merged; lateral fringe only — advanced; FUE/FUT or SMP are options',
  NW7:  'Near-total scalp loss; horseshoe fringe only — transplant candidacy or acceptance discussion',
  diffuse: 'Diffuse thinning without classic recession — often women or TE; rule out nutritional/hormonal causes',
  'n/a (female)': 'Female pattern — Ludwig scale applies; hormonal workup and diffuse-specific treatments',
};

// ─── Thinning pattern descriptions ──────────────────────────────
// Used in the scan response (thinningPatternLabel) and coach context.
// Mirrors the NORWOOD_GUIDE pattern for the thinningPattern enum.
const THINNING_PATTERN_GUIDE = {
  minimal:            'No significant loss visible — protective/maintenance phase',
  bitemporal:         'Temple/M-shape recession; frontal and hairline zone priority',
  crown:              'Crown/vertex thinning; back-of-head coverage focus',
  'bitemporal+crown': 'Bitemporal recession plus crown thinning — dual-zone treatment approach',
  frontal:            'Diffuse frontal hairline loss without sharp temple angles',
  diffuse:            'Uniform thinning across entire scalp top; systemic or nutritional cause common',
  total:              'Severe multi-zone loss — advanced stage; transplant or SMP are realistic options',
};

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
// Scan results are tiny (~2KB each). Image caches store base64 PNGs which can
// be 1-5MB each — keep those much smaller to avoid OOM on Railway's ~512MB RAM.
const SCAN_CACHE_MAX = 200;
const IMAGE_CACHE_MAX = 20;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h

// Per-endpoint counters exposed via /api/health for production monitoring.
const METRICS = {
  scan:        { requests: 0, errors: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, lastError: null },
  after:       { requests: 0, errors: 0, cacheHits: 0, lastError: null },
  progression: { requests: 0, errors: 0, cacheHits: 0, lastError: null },
  map:         { requests: 0, errors: 0, cacheHits: 0, lastError: null },
  adviceVisual:{ requests: 0, errors: 0, cacheHits: 0, lastError: null },
  coach:       { requests: 0, errors: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, lastError: null },
};

// Rolling latency samples (ms) per endpoint — last 100 POST requests each.
// Exposed via /api/health so Railway dashboards and alerts can track p50/p95.
const LATENCY_MAX_SAMPLES = 100;
const LATENCY = {
  scan:        [],
  after:       [],
  progression: [],
  map:         [],
  adviceVisual:[],
  coach:       [],
};

const URL_TO_LATENCY_KEY = {
  '/api/analyze-scan':          'scan',
  '/api/generate-after':        'after',
  '/api/generate-progression':  'progression',
  '/api/generate-analysis-map': 'map',
  '/api/generate-advice-visual':'adviceVisual',
  '/api/coach':                 'coach',
};

function recordLatency(key, ms) {
  const arr = LATENCY[key];
  if (!arr) return;
  if (arr.length >= LATENCY_MAX_SAMPLES) arr.shift();
  arr.push(ms);
}

function bumpError(m, httpStatus, msg) {
  m.errors++;
  m.lastError = { at: new Date().toISOString(), status: httpStatus || null, msg: String(msg || '').slice(0, 150) };
}

function latencyStats(arr) {
  if (!arr.length) return { samples: 0, p50: null, p95: null, avg: null };
  const sorted = [...arr].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct / 100))];
  return {
    samples: arr.length,
    p50: p(50),
    p95: p(95),
    avg: Math.round(arr.reduce((s, v) => s + v, 0) / arr.length),
  };
}

function cacheHashOf(prefix, ...parts) {
  return createHash('sha256').update(prefix + '\0' + parts.join('\0')).digest('hex');
}

// Produce a deterministic JSON string regardless of key insertion order.
// Profile objects from the iOS Swift Codable layer may arrive with keys in
// varying order depending on the iOS version and struct layout; without
// sorting, JSON.stringify produces different strings for identical profiles
// and the scan cache always misses on retries.
function stableJSON(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJSON(value[k])).join(',') + '}';
}

function cacheRead(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) { map.delete(key); return null; }
  return entry.result;
}

function cacheWrite(map, key, result, max = SCAN_CACHE_MAX) {
  if (map.size >= max) {
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

// Stage-specific zone hints appended to AFTER_PROMPT when the caller provides
// a Norwood stage from a prior scan. Helps the model focus restoration on the
// zones that matter most for that stage without over-restoring stable areas.
const AFTER_STAGE_HINTS = {
  NW2:  "This user is Norwood 2: slight symmetric temple recession. Focus only on the temple corners — fill the M-shape recession to a natural, slightly receded adult hairline. Crown and mid-scalp are intact; leave them unchanged.",
  NW3:  "This user is Norwood 3: deep bilateral temple recession extending past mid-pupil. Prioritize filling both temple recession zones. Crown and mid-scalp should remain mostly unchanged unless thinning is clearly visible there.",
  NW3v: "This user is Norwood 3v: deep temple recession PLUS early vertex/crown thinning. Address both zones equally — fill temple recession and add modest density to the crown.",
  NW4:  "This user is Norwood 4: significant frontal hairline retreat and pronounced crown thinning. Restore density in both the frontal zone (to a credible age-appropriate hairline, not a teenager's) and the crown/vertex.",
  NW5:  "This user is Norwood 5: frontal and crown zones nearly merging. Show realistic improvement across the entire top — reduce visible scalp throughout but keep the result 'clearly improved,' not 'fully restored.'",
  NW6:  "This user is Norwood 6: frontal and crown merged with only a lateral fringe. Show meaningful density restoration across the full scalp top — the result should look noticeably better than the input, not perfect.",
  NW7:  "This user is Norwood 7: near-total top loss. Reduce visible scalp uniformly across the entire top. Keep it realistic — the improvement should be substantial but believable for this degree of loss.",
  diffuse: "This user has diffuse thinning: uniform loss across the entire scalp top without a distinct recession. Add uniform density increase across the whole top without shifting or changing the hairline position.",
  'n/a (female)': "This user has female-pattern thinning: diffuse loss at the central part and crown. Focus improvement on the central parting and scalp top. Do not change the hairline position — female-pattern loss typically spares the frontal hairline.",
};

// Returns AFTER_PROMPT with an optional stage-specific zone hint appended.
// Falls back to the base prompt when stage is absent or unrecognised.
const buildAfterPrompt = (stage) => {
  const hint = stage ? AFTER_STAGE_HINTS[stage] : null;
  return hint ? `${AFTER_PROMPT}\n\nStage-specific focus: ${hint}` : AFTER_PROMPT;
};

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

// Emit a warning when an endpoint is unexpectedly slow. Thresholds are
// generous to avoid false alarms during cold Railway starts.
const SLOW_THRESHOLDS_MS = { scan: 45_000, image: 180_000, coach: 30_000 };
const warnIfSlow = (label, startedAt, kind = 'image') => {
  const elapsed = Date.now() - startedAt;
  const threshold = SLOW_THRESHOLDS_MS[kind] ?? SLOW_THRESHOLDS_MS.image;
  if (elapsed > threshold) {
    console.warn(`[perf] SLOW ${label} elapsed=${elapsed}ms threshold=${threshold}ms`);
  }
};

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

const json = (req, res, code, body) => {
  const data = Buffer.from(JSON.stringify(body));
  const acceptsGzip = data.length > 512 && /gzip/.test(req.headers['accept-encoding'] || '');
  if (acceptsGzip) {
    const existingVary = res.getHeader('Vary');
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-store',
      'Vary': existingVary ? `${existingVary}, Accept-Encoding` : 'Accept-Encoding',
    });
    res.end(gzipSync(data));
  } else {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(data);
  }
};

// Use for OpenAI error responses — adds Retry-After hint on gateway errors.
const jsonError = (req, res, code, body) => {
  if (code === 502 || code === 503 || code === 504) {
    if (!res.getHeader('Retry-After')) res.setHeader('Retry-After', '30');
  }
  json(req, res, code, body);
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

const rateLimit = (req, res) => {
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
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX - bucket.count)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
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
  const contentPolicy = code === 'content_policy_violation'
    || code === 'moderation_blocked'
    || /safety system|content policy|violates our|not allowed|moderation/i.test(message || '');
  return {
    error: billing
      ? 'OpenAI generation is temporarily paused because billing or quota is unavailable.'
      : contentPolicy
        ? 'This photo could not be processed. Please try a clearer, well-lit photo showing only your hair and scalp.'
        : message,
    code,
    retryable: billing || status === 429 || status >= 500,
    contentPolicy,
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
      const isTimeout = err.name === 'AbortError';
      // Node.js fetch (undici) throws TypeError with a .cause for network-level failures
      // (ECONNRESET, ECONNREFUSED, DNS lookup failed, etc.). Retry those too.
      const isNetworkError = !isTimeout && err instanceof TypeError && err.cause != null;
      if (isTimeout || isNetworkError) {
        const kind = isTimeout
          ? `timeout after ${timeoutMs}ms`
          : `network error (${err.cause?.code || err.message})`;
        if (attempt >= maxAttempts) {
          const e = new Error(`${label} ${kind}`);
          e.statusCode = 504;
          throw e;
        }
        const delay = baseDelayMs * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
        console.log(`[openai retry] ${label} ${kind} attempt=${attempt}/${maxAttempts} delay=${Math.round(delay)}ms`);
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
    // Respect OpenAI's Retry-After header (seconds) when present; fall back to
    // exponential backoff. Cap at 60s to avoid stalling too long on stale headers.
    const retryAfterSec = parseFloat(r.headers.get('retry-after') || '0');
    const serverDelay = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
    const delay = (serverDelay > 0 && serverDelay <= 60_000)
      ? serverDelay
      : baseDelayMs * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
    console.log(`[openai retry] ${label} status=${r.status} attempt=${attempt}/${maxAttempts} delay=${Math.round(delay)}ms source=${serverDelay > 0 ? 'server' : 'backoff'}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VALID_INSIGHT_METRICS = new Set(['Hairline', 'Density', 'Crown', 'Health', 'Potential']);
const DEFAULT_METRICS = ['Hairline', 'Density', 'Crown'];
const normalizeInsight = (ins, i) => ({
  title:  String(ins?.title  || '').slice(0, 60),
  body:   String(ins?.body   || '').slice(0, 200),
  metric: VALID_INSIGHT_METRICS.has(ins?.metric) ? ins.metric : (DEFAULT_METRICS[i] || 'Health'),
});

// Fallback insights used to pad the array to exactly 3 when GPT-4o returns fewer.
const FALLBACK_INSIGHTS = [
  { title: 'Maintain consistency', body: 'A consistent daily routine is the single biggest driver of long-term hair improvement.', metric: 'Health' },
  { title: 'Track progress monthly', body: 'Monthly photos reveal improvements that are hard to notice day-to-day.', metric: 'Potential' },
  { title: 'Protect your scalp', body: 'UV exposure and heat styling accelerate thinning — broad-spectrum SPF on the scalp helps.', metric: 'Crown' },
];

// Compute how urgently treatment action should be taken, based on the AI-classified
// Norwood stage and the user's age. Used by the iOS app to drive CTA wording.
// 'high'     → act now; best treatment window; early/mid stage under 45
// 'moderate' → worth treating but temper expectations; mid/late stage or older
// 'low'      → OTC options unlikely to move the needle significantly
const computeTreatmentUrgency = (stage, age) => {
  const a = Number(age);
  const isYoung  = Number.isFinite(a) && a < 40;
  const isMid    = Number.isFinite(a) && a >= 40 && a < 55;
  const isOlder  = Number.isFinite(a) && a >= 55;

  switch (stage) {
    case 'NW1':              return 'low';      // no action needed
    case 'NW2':              return isOlder ? 'moderate' : 'high'; // preventive is very effective early
    case 'NW3':
    case 'NW3v':             return isYoung ? 'high' : isMid ? 'high' : 'moderate';
    case 'NW4':              return isYoung ? 'high' : 'moderate';
    case 'NW5':              return 'moderate'; // OTC slows but rarely reverses at this stage
    case 'NW6':
    case 'NW7':              return 'low';      // beyond meaningful OTC response
    case 'diffuse':          return 'moderate'; // cause-dependent; often reversible
    case 'n/a (female)':     return 'moderate'; // hormonal/nutritional work-up first
    default:                 return 'moderate';
  }
};

// Structured output schema for analyze-scan (gpt-4o strict mode).
// This guarantees valid JSON, correct enum values for stage/metric, and eliminates
// parse failures from truncated responses. Strict mode requires all properties listed
// in required and additionalProperties: false on every object.
const SCAN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    hairline:  { type: 'number' },
    density:   { type: 'number' },
    crown:     { type: 'number' },
    health:    { type: 'number' },
    potential: { type: 'number' },
    stage: {
      type: 'string',
      enum: ['NW1', 'NW2', 'NW3', 'NW3v', 'NW4', 'NW5', 'NW6', 'NW7', 'diffuse', 'n/a (female)'],
    },
    headline: { type: 'string' },
    insights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title:  { type: 'string' },
          body:   { type: 'string' },
          metric: { type: 'string', enum: ['Hairline', 'Density', 'Crown', 'Health', 'Potential'] },
        },
        required: ['title', 'body', 'metric'],
        additionalProperties: false,
      },
    },
    verdict:        { type: 'string' },
    photoQuality:   { type: 'string', enum: ['good', 'acceptable', 'poor'] },
    photoNote:      { type: 'string' },
    thinningPattern: {
      type: 'string',
      enum: ['minimal', 'bitemporal', 'crown', 'bitemporal+crown', 'frontal', 'diffuse', 'total'],
    },
  },
  required: ['hairline', 'density', 'crown', 'health', 'potential', 'stage', 'headline', 'insights', 'verdict', 'photoQuality', 'photoNote', 'thinningPattern'],
  additionalProperties: false,
};

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
    const ms = Date.now() - reqStart;
    console.log(`[res] ${req.method} ${req.url} ${reqId} ${res.statusCode} ${ms}ms`);
    if (req.method === 'POST') {
      const latencyKey = URL_TO_LATENCY_KEY[req.url];
      if (latencyKey) recordLatency(latencyKey, ms);
    }
    return origEnd(...args);
  };

  // Reject new non-health requests during graceful shutdown
  if (isShuttingDown && req.url !== '/api/health') {
    res.setHeader('Retry-After', '10');
    json(req, res, 503, { error: 'Server is restarting. Please retry in a few seconds.', requestId: reqId });
    return;
  }

  const corsOk = cors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(corsOk ? 204 : 403).end();
    return;
  }

  if (!corsOk) {
    json(req, res, 403, { error: 'Origin not allowed', requestId: reqId });
    return;
  }

  const limited = rateLimit(req, res);
  if (limited) {
    const retryAfterSec = Math.ceil((limited.body.retryAfterMs || 60_000) / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    json(req, res, limited.status, { ...limited.body, requestId: reqId });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    const mem = process.memoryUsage();
    json(req, res, 200, {
      ok: true,
      models: { scan: 'gpt-4o', coach: 'gpt-4o-mini', image: 'gpt-image-2' },
      port: PORT,
      sha: GIT_SHA,
      uptimeSeconds: Math.floor((Date.now() - SERVER_START_MS) / 1000),
      openRequests,
      cache: {
        scan:        { size: SCAN_CACHE.size,         max: SCAN_CACHE_MAX,  inflight: SCAN_INFLIGHT.size },
        after:       { size: AFTER_CACHE.size,        max: IMAGE_CACHE_MAX, inflight: AFTER_INFLIGHT.size },
        progression: { size: PROGRESSION_CACHE.size,  max: IMAGE_CACHE_MAX, inflight: PROGRESSION_INFLIGHT.size },
        map:         { size: MAP_CACHE.size,           max: IMAGE_CACHE_MAX, inflight: MAP_INFLIGHT.size },
        adviceVisual:{ size: ADVICE_VISUAL_CACHE.size, max: IMAGE_CACHE_MAX, inflight: ADVICE_VISUAL_INFLIGHT.size },
      },
      memoryMB: {
        rss:      Math.round(mem.rss      / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal:Math.round(mem.heapTotal/ 1024 / 1024),
      },
      metrics: METRICS,
      latency: Object.fromEntries(
        Object.entries(LATENCY).map(([k, arr]) => [k, latencyStats(arr)])
      ),
      requestId: reqId,
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/version') {
    json(req, res, 200, { sha: GIT_SHA, requestId: reqId });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/generate-after') {
    try {
      METRICS.after.requests++;
      const { photoDataUrl, prompt, quality: qParam, stage: stageParam } = await readJsonBody(req);
      if (!photoDataUrl) throw new Error('photoDataUrl required (data:image/...;base64,...)');

      // Quality knob — gpt-image-2 supports: auto | high | medium | low.
      // Default 'low' for fastest experience (~30s vs ~200s for high).
      // Pass `"quality":"high"` from the client to force premium.
      const quality = ['auto','high','medium','low'].includes(qParam) ? qParam : 'low';

      // Accept an optional Norwood stage from a recent scan result.
      // Used to append a zone-focus hint so the model restores the right areas.
      const effectivePrompt = prompt || buildAfterPrompt(stageParam);
      const { mime, buffer } = dataUrlToBuffer(photoDataUrl);
      if (buffer.length < 3000) {
        const err = new Error('Photo appears corrupted or too small. Please retake a clearer photo.');
        err.statusCode = 422;
        throw err;
      }
      const hash = cacheHashOf('after', mime, buffer.length, createHash('sha256').update(buffer).digest('hex'), effectivePrompt, quality);

      // 1. Cache hit — return instantly
      const cached = cacheRead(AFTER_CACHE, hash);
      if (cached) {
        METRICS.after.cacheHits++;
        console.log('[openai] generate-after CACHE HIT', { hash: hash.slice(0, 8) });
        json(req, res, 200, { afterPhoto: cached, cached: true, requestId: reqId });
        return;
      }

      // 2. In-flight dedup — piggyback on the same OpenAI call
      let inflight = AFTER_INFLIGHT.get(hash);
      if (inflight) {
        console.log('[openai] generate-after IN-FLIGHT JOIN', { hash: hash.slice(0, 8) });
        const result = await inflight;
        if (result.ok) {
          json(req, res, 200, { afterPhoto: result.afterPhoto, deduped: true, requestId: reqId });
        } else {
          const aiErr = normalizeOpenAIError('OpenAI request failed', result.status, result.error);
          bumpError(METRICS.after, result.status || 502, aiErr.error);
          jsonError(req, res, result.status || 502, { ...aiErr, requestId: reqId });
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
        const aiErr = normalizeOpenAIError('OpenAI request failed', result.status, result.error);
        bumpError(METRICS.after, result.status || 502, aiErr.error);
        jsonError(req, res, result.status || 502, { ...aiErr, requestId: reqId });
        return;
      }
      cacheWrite(AFTER_CACHE, hash, result.afterPhoto, IMAGE_CACHE_MAX);
      warnIfSlow('generate-after', startedAt, 'image');
      console.log('[openai] generate-after OK', { ms: Date.now() - startedAt, hash: hash.slice(0, 8) });
      json(req, res, 200, { afterPhoto: result.afterPhoto, requestId: reqId });
    } catch (err) {
      bumpError(METRICS.after, err.statusCode || 500, err.message);
      console.error('[server] handler error', err);
      json(req, res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/generate-progression — N-month after-photo via gpt-image-2 ─
  // Input: { photoDataUrl, month: 3 | 6 | 12 }
  // Output: { afterPhoto: 'data:image/png;base64,...' }
  // Cost: ~$0.05 per call. Caller should cache aggressively in localStorage.
  if (req.method === 'POST' && req.url === '/api/generate-progression') {
    try {
      METRICS.progression.requests++;
      const { photoDataUrl, month, quality: qParam } = await readJsonBody(req);
      if (!photoDataUrl) throw new Error('photoDataUrl required');
      const m = Number(month);
      if (!PROGRESSION_PROMPTS[m]) throw new Error('month must be 3, 6, or 12');
      const quality = ['auto', 'high', 'medium', 'low'].includes(qParam) ? qParam : 'high';

      const { mime, buffer } = dataUrlToBuffer(photoDataUrl);
      if (buffer.length < 3000) {
        const err = new Error('Photo appears corrupted or too small. Please retake a clearer photo.');
        err.statusCode = 422;
        throw err;
      }
      const hash = cacheHashOf('progression', mime, createHash('sha256').update(buffer).digest('hex'), String(m), quality);

      // 1. Cache hit — return instantly
      const progCached = cacheRead(PROGRESSION_CACHE, hash);
      if (progCached) {
        METRICS.progression.cacheHits++;
        console.log('[progression] CACHE HIT', { month: m, hash: hash.slice(0, 8) });
        json(req, res, 200, { afterPhoto: progCached, month: m, cached: true, requestId: reqId });
        return;
      }

      // 2. In-flight dedup
      let progInflight = PROGRESSION_INFLIGHT.get(hash);
      if (progInflight) {
        console.log('[progression] IN-FLIGHT JOIN', { month: m, hash: hash.slice(0, 8) });
        const progResult = await progInflight;
        if (progResult.ok) {
          json(req, res, 200, { afterPhoto: progResult.afterPhoto, month: m, deduped: true, requestId: reqId });
        } else {
          const aiErr = normalizeOpenAIError('OpenAI request failed', progResult.status, progResult.error);
          bumpError(METRICS.progression, progResult.status || 502, aiErr.error);
          jsonError(req, res, progResult.status || 502, { ...aiErr, requestId: reqId });
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
        const aiErr = normalizeOpenAIError('OpenAI request failed', progResult.status, progResult.error);
        bumpError(METRICS.progression, progResult.status || 502, aiErr.error);
        jsonError(req, res, progResult.status || 502, { ...aiErr, requestId: reqId });
        return;
      }
      cacheWrite(PROGRESSION_CACHE, hash, progResult.afterPhoto, IMAGE_CACHE_MAX);
      warnIfSlow('generate-progression', startedAt, 'image');
      console.log('[progression] ok', { month: m, ms: Date.now() - startedAt, hash: hash.slice(0, 8) });
      json(req, res, 200, { afterPhoto: progResult.afterPhoto, month: m, requestId: reqId });
    } catch (err) {
      bumpError(METRICS.progression, err.statusCode || 500, err.message);
      console.error('[server] generate-progression error', err);
      json(req, res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/generate-analysis-map — photo-locked GPT image edit overlay ─
  // Input: { photoDataUrl, kind: 'density' | 'crown', result? }
  // Output: { analysisMap: 'data:image/png;base64,...', kind }
  if (req.method === 'POST' && req.url === '/api/generate-analysis-map') {
    try {
      METRICS.map.requests++;
      const { photoDataUrl, kind = 'density', result: scanScores = {} } = await readJsonBody(req);
      if (!photoDataUrl) throw new Error('photoDataUrl required');
      const mapKind = String(kind).toLowerCase() === 'crown' ? 'crown' : 'density';

      const { mime, buffer } = dataUrlToBuffer(photoDataUrl);
      if (buffer.length < 3000) {
        const err = new Error('Photo appears corrupted or too small. Please retake a clearer photo.');
        err.statusCode = 422;
        throw err;
      }
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
        METRICS.map.cacheHits++;
        console.log('[analysis-map] CACHE HIT', { kind: mapKind, hash: hash.slice(0, 8) });
        json(req, res, 200, { analysisMap: mapCached, kind: mapKind, cached: true, requestId: reqId });
        return;
      }

      // 2. In-flight dedup
      let mapInflight = MAP_INFLIGHT.get(hash);
      if (mapInflight) {
        console.log('[analysis-map] IN-FLIGHT JOIN', { kind: mapKind, hash: hash.slice(0, 8) });
        const mapResult = await mapInflight;
        if (mapResult.ok) {
          json(req, res, 200, { analysisMap: mapResult.analysisMap, kind: mapKind, deduped: true, requestId: reqId });
        } else {
          const aiErr = normalizeOpenAIError('OpenAI request failed', mapResult.status, mapResult.error);
          bumpError(METRICS.map, mapResult.status || 502, aiErr.error);
          jsonError(req, res, mapResult.status || 502, { ...aiErr, requestId: reqId });
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
        const aiErr = normalizeOpenAIError('OpenAI request failed', mapResult.status, mapResult.error);
        bumpError(METRICS.map, mapResult.status || 502, aiErr.error);
        jsonError(req, res, mapResult.status || 502, { ...aiErr, requestId: reqId });
        return;
      }
      cacheWrite(MAP_CACHE, hash, mapResult.analysisMap, IMAGE_CACHE_MAX);
      warnIfSlow('generate-analysis-map', startedAt, 'image');
      console.log('[analysis-map] ok', { kind: mapKind, ms: Date.now() - startedAt, hash: hash.slice(0, 8) });
      json(req, res, 200, { analysisMap: mapResult.analysisMap, kind: mapKind, requestId: reqId });
    } catch (err) {
      bumpError(METRICS.map, err.statusCode || 500, err.message);
      console.error('[server] generate-analysis-map error', err);
      json(req, res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/generate-advice-visual — image-led protocol card art ─
  // Input: { kind: 'topical' | 'supplements' | 'massage' | 'shampoo', quality? }
  // Output: { adviceVisual: 'data:image/png;base64,...', kind }
  if (req.method === 'POST' && req.url === '/api/generate-advice-visual') {
    try {
      METRICS.adviceVisual.requests++;
      const { kind, quality: qParam } = await readJsonBody(req);
      const visualKind = normalizeAdviceKind(kind);
      const quality = ['auto','high','medium','low'].includes(qParam) ? qParam : 'low';
      const prompt = ADVICE_VISUAL_PROMPTS[visualKind];
      const hash = cacheHashOf('advice-visual', visualKind, prompt, quality);

      const cached = cacheRead(ADVICE_VISUAL_CACHE, hash);
      if (cached) {
        METRICS.adviceVisual.cacheHits++;
        console.log('[advice-visual] CACHE HIT', { kind: visualKind, hash: hash.slice(0, 8) });
        json(req, res, 200, { adviceVisual: cached, kind: visualKind, cached: true, requestId: reqId });
        return;
      }

      let inflight = ADVICE_VISUAL_INFLIGHT.get(hash);
      if (inflight) {
        console.log('[advice-visual] IN-FLIGHT JOIN', { kind: visualKind, hash: hash.slice(0, 8) });
        const result = await inflight;
        if (result.ok) {
          json(req, res, 200, { adviceVisual: result.adviceVisual, kind: visualKind, deduped: true, requestId: reqId });
        } else {
          const aiErr = normalizeOpenAIError('OpenAI request failed', result.status, result.error);
          bumpError(METRICS.adviceVisual, result.status || 502, aiErr.error);
          jsonError(req, res, result.status || 502, { ...aiErr, requestId: reqId });
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
        const aiErr = normalizeOpenAIError('OpenAI request failed', result.status, result.error);
        bumpError(METRICS.adviceVisual, result.status || 502, aiErr.error);
        jsonError(req, res, result.status || 502, { ...aiErr, requestId: reqId });
        return;
      }
      cacheWrite(ADVICE_VISUAL_CACHE, hash, result.adviceVisual, IMAGE_CACHE_MAX);
      warnIfSlow('generate-advice-visual', startedAt, 'image');
      console.log('[advice-visual] ok', { kind: visualKind, ms: Date.now() - startedAt, hash: hash.slice(0, 8) });
      json(req, res, 200, { adviceVisual: result.adviceVisual, kind: visualKind, requestId: reqId });
    } catch (err) {
      bumpError(METRICS.adviceVisual, err.statusCode || 500, err.message);
      console.error('[server] generate-advice-visual error', err);
      json(req, res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/analyze-scan — GPT-4o Vision → full scan result ────────
  // Input: { photoDataUrl, profile? }
  // Output: full scan record with scores + Norwood + headline + 3 insights + verdict
  // Cost: ~$0.01 per call.
  if (req.method === 'POST' && req.url === '/api/analyze-scan') {
    try {
      METRICS.scan.requests++;
      const { photoDataUrl, profile = {}, scoringInstruction = '' } = await readJsonBody(req);
      if (!photoDataUrl) throw new Error('photoDataUrl required');
      const { buffer: visionBuffer } = dataUrlToBuffer(photoDataUrl);
      if (visionBuffer.length < 3000) {
        const err = new Error('Photo appears corrupted or too small. Please retake a clearer photo showing your scalp.');
        err.statusCode = 422;
        throw err;
      }

      // Cache by (photo content + profile + scoringInstruction) to avoid re-billing
      // the same scan on retries or double-taps. TTL is 24h (same as image cache).
      const profileKey = stableJSON(profile);
      const scanHash = cacheHashOf('scan', createHash('sha256').update(visionBuffer).digest('hex'), profileKey, scoringInstruction);

      const scanCached = cacheRead(SCAN_CACHE, scanHash);
      if (scanCached) {
        METRICS.scan.cacheHits++;
        console.log('[vision] CACHE HIT', { hash: scanHash.slice(0, 8) });
        json(req, res, 200, { ...scanCached, cached: true, requestId: reqId });
        return;
      }

      const scanInflight = SCAN_INFLIGHT.get(scanHash);
      if (scanInflight) {
        console.log('[vision] IN-FLIGHT JOIN', { hash: scanHash.slice(0, 8) });
        const scanResult = await scanInflight;
        if (scanResult.ok) {
          json(req, res, 200, { ...scanResult.data, deduped: true, requestId: reqId });
        } else {
          bumpError(METRICS.scan, scanResult.status || 502, scanResult.error?.error || 'scan failed');
          jsonError(req, res, scanResult.status || 502, { ...scanResult.error, requestId: reqId });
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

      const sys = `You are an aesthetic hair-analysis AI for a consumer hair-loss app. Analyze the scalp photo and user profile context, then output structured JSON with these fields:
- hairline, density, crown, health, potential: 0-100 integer scores
- stage: Norwood stage (pick from the enum)
- headline: 6-9 word punchy summary, confident tone
- insights: exactly 3 items, each with a 5-word title (≤5 words), a 20-28 word actionable body that is specific to THIS user's visible loss pattern, scores, stage, or profile — name the actual stage or a score, specify a concrete action (e.g. "5% minoxidil on your recession zones", "DHT-blocking shampoo 3×/week"), and give a reason tied to their situation. Avoid generic advice. The metric must match: Hairline→temple/frontal recession, Density→mid-scalp thinning, Crown→vertex/crown thinning, Health→scalp condition or miniaturization, Potential→treatment response or growth timeline
- verdict: 1-2 sentence verdict, slightly aspirational, no medical claims
- photoQuality: 'good' | 'acceptable' | 'poor'
- photoNote: brief sentence about quality issues, or empty string if quality is good
- thinningPattern: classify the PRIMARY visible loss pattern from this enum:
  minimal=no significant loss visible (NW1 or very early)
  bitemporal=temple/M-shape recession only, crown intact
  crown=crown/vertex thinning only, temples intact
  bitemporal+crown=both temple recession AND crown thinning (most common AGA)
  frontal=diffuse frontal/hairline loss without sharp temple angles
  diffuse=uniform thinning across entire scalp top without a localized pattern
  total=severe multi-zone loss with large bald areas (NW6-NW7)

PHOTO QUALITY ASSESSMENT:
good — scalp clearly visible, well-lit, shot from above or ~45° angle, can see hairline + crown.
acceptable — lighting or angle is suboptimal but loss pattern is still assessable.
poor — too dark, heavily blurred, shot straight-on (forehead/face only, no scalp visible), or the image doesn't contain a person's hair/scalp at all. If poor, use a conservative uncertainty range (62-76) and note it in the verdict.

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

Staging discriminator — use when adjacent stages are ambiguous:
- NW2 vs NW3: If temple recession extends PAST the mid-pupil vertical line, assign NW3. If it barely reaches or falls short of midpupil, assign NW2.
- NW3 vs NW4: If a clear forelock mass still covers the central frontal scalp (even with deep temple recession), assign NW3 or NW3v. Once the frontal hairline itself has retreated past mid-scalp, assign NW4.
- NW3 vs NW3v: Assign NW3v (not plain NW3) only when vertex/crown thinning is independently visible as a SEPARATE thinning zone distinct from the temple recession.
- NW4 vs NW5: If the bridge of hair connecting the forelock to the sides is a visible full-width band, assign NW4. If that bridge is sparse, narrow, or nearly gone, assign NW5.
- NW5 vs NW6: If even a sparse band of tissue still separates the frontal and crown bald zones, assign NW5. If the two zones have fully merged with no separation at all, assign NW6.

Scoring guide (all scores 0-100 integers):
- hairline: 100 = fully intact hairline, no recession. Deduct for temple recession depth/width, frontal loss. NW1→90-100, NW2→75-88, NW3→55-72, NW4→35-55, NW5+→15-40.
- density: 100 = full terminal hair density with no scalp visible through hair. Deduct for mid-scalp see-through, diffuse thinning, miniaturization. Stage-correlated ranges: NW1→88-100, NW2→80-95, NW3→65-82 (reduce by 5-15 more if visible mid-scalp thinning alongside the recession), NW4→45-68, NW5→30-52, NW6+→15-38, diffuse→35-65 (depends on coverage uniformity). If the photo is a straight-on face shot where mid-scalp isn't visible, estimate from stage.
- crown: 100 = full vertex/crown coverage from above. Stage-correlated ranges: NW1→90-100, NW2→87-100, NW3→82-97 (crown should be intact unless NW3v), NW3v→55-75 (early vertex thinning distinguishes this stage), NW4→35-58, NW5→18-40, NW6+→5-25. If crown IS visible in the photo, score directly from what you see. If not, use the stage estimate.
- health: 100 = thick terminal hairs at normal caliber, healthy scalp, no miniaturization or inflammation. Deduct for: visible miniaturization (fine, short hairs at the thinning edge) −10 to −20; scalp inflammation or redness −5 to −15; visible flakiness or dandruff −5 to −10; widespread vellus hairs replacing terminal hairs −10 to −20. Health is NOT determined by hairline position — a NW4 with thick terminal hairs and healthy scalp can score 78-88 on health.
- potential: realistic percentage improvement achievable with a consistent 6-12 month OTC protocol (minoxidil, scalp care, supplements). Score what is ACHIEVABLE — not the current state. Use these stage×age guidelines:
  • NW1-NW2, any age: 72-88 (early prevention window, follicles fully viable)
  • NW3-NW3v, under 35: 68-82 (strong responders; significant regrowth expected)
  • NW3-NW3v, age 35-54: 58-74 (good gains with consistency; moderately responsive)
  • NW4, under 40: 55-70 (meaningful improvement still achievable)
  • NW4, over 40: 42-58 (maintenance priority; modest regrowth in best cases)
  • NW5, any age: 28-48 (OTC slows progression; realistic expectations needed)
  • NW6-NW7, any age: 15-32 (very limited OTC benefit; transplant/SMP discussion)
  • diffuse/female pattern: 55-78 (often nutritional or hormonal — responds well if cause found)
  Upward adjustments (+5 to +8): age under 28, loss duration under 1 year, no family history of NW6+, already responding to current treatment.
  Downward adjustments (−5 to −8): age over 60, family history of NW6+, loss for 10+ years untreated, visible miniaturization across entire top.
  Potential is NOT the same as current health — a NW4 with good hair health can still score 55+ potential because the follicles are viable.
- overall (computed server-side): do not output this field.

Use a balanced visual baseline: score what is actually visible in the photo and user context. Do not artificially lower scores for healthy-looking or stable-looking areas, and do not push users into a low range just for motivation. Typical mild early thinning: 62-78 overall; clearly healthy cases: 78-90; significant recession or density loss: 35-62; 91+ is rare. If photoQuality is 'poor', use a conservative uncertainty range around 62-76 and reflect uncertainty in the verdict. Never refuse — produce a best-effort estimate. Insights array MUST contain exactly 3 entries.`;

      const scanReqBody = JSON.stringify({
        model: 'gpt-4o',
        response_format: { type: 'json_schema', json_schema: { name: 'scan_result', strict: true, schema: SCAN_RESPONSE_SCHEMA } },
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
        max_tokens: 1500,
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

        const scanChoice = scanPayload.choices?.[0];
        const finishReason = scanChoice?.finish_reason;
        if (finishReason === 'length') {
          console.warn('[vision] response truncated by max_tokens — JSON may be incomplete');
        }

        let parsed;
        try { parsed = JSON.parse(scanChoice?.message?.content || '{}'); }
        catch (e) {
          const errMsg = finishReason === 'length'
            ? 'Scan analysis was cut short — please try again.'
            : 'Vision returned non-JSON';
          return { ok: false, status: 502, error: { error: errMsg } };
        }

        const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
        const rawInsights = (Array.isArray(parsed.insights) ? parsed.insights.slice(0, 3) : []).map(normalizeInsight);
        // GPT-4o must return exactly 3; pad with sensible defaults if it falls short.
        while (rawInsights.length < 3) {
          rawInsights.push(FALLBACK_INSIGHTS[rawInsights.length]);
        }
        const stage = parsed.stage || 'n/a';
        const VALID_PHOTO_QUALITIES = new Set(['good', 'acceptable', 'poor']);
        const photoQuality = VALID_PHOTO_QUALITIES.has(parsed.photoQuality) ? parsed.photoQuality : 'acceptable';
        const VALID_THINNING_PATTERNS = new Set(['minimal', 'bitemporal', 'crown', 'bitemporal+crown', 'frontal', 'diffuse', 'total']);
        const thinningPattern = VALID_THINNING_PATTERNS.has(parsed.thinningPattern) ? parsed.thinningPattern : 'minimal';
        // confidenceScore is derived server-side from photoQuality — reflects how
        // reliably the AI could assess the scan. The iOS app can use this to decide
        // whether to show a "retake for better results" nudge.
        const confidenceScore = photoQuality === 'good' ? 90 : photoQuality === 'poor' ? 50 : 70;
        const data = {
          hairline:            clamp(parsed.hairline),
          density:             clamp(parsed.density),
          crown:               clamp(parsed.crown ?? parsed.density),
          health:              clamp(parsed.health),
          potential:           clamp(parsed.potential),
          stage,
          stageLabel:          NORWOOD_GUIDE[stage] || null,
          headline:            String(parsed.headline || 'Strong baseline. Real room to improve.').slice(0, 120),
          insights:            rawInsights,
          verdict:             String(parsed.verdict || '').slice(0, 400),
          photoQuality,
          photoNote:           String(parsed.photoNote || '').slice(0, 200),
          thinningPattern,
          thinningPatternLabel: THINNING_PATTERN_GUIDE[thinningPattern] || null,
          confidenceScore,
          scoredAt:            new Date().toISOString(),
        };
        // Include all 5 metrics in overall: hairline, density, crown, health, potential.
        data.overall = Math.round((data.hairline + data.density + data.crown + data.health + data.potential) / 5);
        // currentStateScore: average of the 4 present-tense metrics only (excludes potential,
        // which is forward-looking). Use this when you want "where the user IS" vs "overall"
        // which is optimistic because it blends in potential.
        data.currentStateScore = Math.round((data.hairline + data.density + data.crown + data.health) / 4);
        // treatmentUrgency is computed server-side from stage + profile age — not sent to GPT-4o.
        data.treatmentUrgency = computeTreatmentUrgency(stage, profile.age);
        // weakestMetric: the lowest-scoring current-state metric (excludes potential, which is forward-looking).
        // The iOS app can pass this directly to the coach endpoint as userContext.weakestMetric.
        const _currentState = { Hairline: data.hairline, Density: data.density, Crown: data.crown, Health: data.health };
        const _sortedMetrics = Object.entries(_currentState).sort((a, b) => a[1] - b[1]);
        const [_weakLabel, _weakValue] = _sortedMetrics[0];
        const [_strongLabel, _strongValue] = _sortedMetrics[_sortedMetrics.length - 1];
        data.weakestMetric   = { label: _weakLabel,   value: _weakValue };
        data.strongestMetric = { label: _strongLabel, value: _strongValue };
        // stageSeverityIndex: numeric 1-7 (with 0.5 steps for NW3v/diffuse/female).
        // Lets the iOS app render a severity bar or compare stages without string logic.
        data.stageSeverityIndex = STAGE_SEVERITY_INDEX[stage] ?? null;
        // retakeRecommended: true when photo quality is too poor for reliable scoring.
        // The iOS app can use this to show a "Retake for better results" CTA.
        data.retakeRecommended = photoQuality === 'poor';

        // photoGuidance: actionable retake tip shown when quality isn't ideal.
        // Computed server-side so the iOS app can display it without extra logic.
        data.photoGuidance = photoQuality === 'good' ? null
          : photoQuality === 'poor'
            ? 'For best results: hold your camera directly above your head with your arm fully extended. Use bright natural light (near a window or outdoors). Part your hair slightly so the scalp is visible, and make sure both your hairline and crown are in frame.'
            : 'For a more accurate scan: try shooting from a slightly higher angle in brighter lighting. Part your hair so the scalp is visible through thinning areas.';

        // weeklyFocus: highest-ROI weekly action based on the user's weakest metric.
        // Gives the iOS app a ready-to-display nudge without needing the coach endpoint.
        const WEEKLY_FOCUS_MAP = {
          Hairline: 'Apply minoxidil directly to your recession zones every morning and night — temple consistency is the highest-leverage habit right now.',
          Density:  'Add a DHT-blocking shampoo 3× this week and follow with a 5-minute scalp massage each time to boost circulation.',
          Crown:    'Begin a crown-focused topical routine and take an overhead comparison photo now to track your baseline.',
          Health:   'Skip sulfate shampoos this week, use a gentle scalp exfoliant mid-week, and increase water intake — scalp condition responds fast to hydration and less irritation.',
        };
        data.weeklyFocus = WEEKLY_FOCUS_MAP[data.weakestMetric?.label]
          || 'Stay consistent with your current routine — daily adherence is the single biggest driver of long-term results.';

        // checkInIntervalDays: how many days until the next meaningful scan.
        // Derived from treatmentUrgency so the iOS app can schedule a push reminder
        // without extra logic. "high" urgency = active treatment phase (28 days);
        // "low" urgency = stable or limited OTC response window (60 days).
        const URGENCY_DAYS = { high: 28, moderate: 42, low: 60 };
        data.checkInIntervalDays = URGENCY_DAYS[data.treatmentUrgency] || 42;
        data.nextCheckIn = new Date(Date.now() + data.checkInIntervalDays * 24 * 60 * 60 * 1000)
          .toISOString().split('T')[0]; // YYYY-MM-DD
        // nextCheckInReason: human-readable explanation for the iOS app to display inline.
        const URGENCY_REASONS = {
          high:     'Active treatment window — check back in 4 weeks to measure early response',
          moderate: 'Steady progress phase — check back in 6 weeks to track improvement',
          low:      'Stable state — next scan in 2 months to monitor for changes',
        };
        data.nextCheckInReason = URGENCY_REASONS[data.treatmentUrgency] || 'Check back regularly to track progress';

        const scanUsage = scanPayload.usage;
        if (scanUsage) {
          METRICS.scan.promptTokens     += scanUsage.prompt_tokens     || 0;
          METRICS.scan.completionTokens += scanUsage.completion_tokens || 0;
        }
        console.log('[vision] ok', { overall: data.overall, stage: data.stage, photoQuality: data.photoQuality, ms: Date.now() - startedAt, tokens: scanUsage ? { prompt: scanUsage.prompt_tokens, completion: scanUsage.completion_tokens } : null });
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
        bumpError(METRICS.scan, scanOutcome.status || 502, scanOutcome.error?.error || 'scan failed');
        jsonError(req, res, scanOutcome.status || 502, { ...scanOutcome.error, requestId: reqId });
        return;
      }
      cacheWrite(SCAN_CACHE, scanHash, scanOutcome.data);
      warnIfSlow('analyze-scan', startedAt, 'scan');
      json(req, res, 200, { ...scanOutcome.data, requestId: reqId });
    } catch (err) {
      bumpError(METRICS.scan, err.statusCode || 500, err.message);
      console.error('[server] analyze-scan error', err);
      json(req, res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/coach — GPT-4o chat with user context ──────────────
  // Input: { message, history, userContext: { result, routine, profile, history, planProducts, routineDoneToday, weakestMetric } }
  // Output: { reply }
  // Cost: ~$0.005/message. History trimmed to last 10 turns to keep it cheap.
  if (req.method === 'POST' && req.url === '/api/coach') {
    try {
      METRICS.coach.requests++;
      const { message, history = [], userContext = {} } = await readJsonBody(req);
      if (!message || typeof message !== 'string') throw new Error('message required');
      const startedAt = Date.now();

      const ctx = {
        scan: userContext.result ? {
          overall:           userContext.result.overall,
          hairline:          userContext.result.hairline,
          density:           userContext.result.density,
          crown:             userContext.result.crown,
          health:            userContext.result.health,
          potential:         userContext.result.potential,
          stage:             String(userContext.result.stage || '').slice(0, 20) || null,
          headline:          String(userContext.result.headline || '').slice(0, 120) || null,
          verdict:           String(userContext.result.verdict || '').slice(0, 400) || null,
          insights:          Array.isArray(userContext.result.insights) ? userContext.result.insights.slice(0, 3) : [],
          photoQuality:      userContext.result.photoQuality || null,
          photoNote:         userContext.result.photoNote || null,
          retakeRecommended: userContext.result.retakeRecommended ?? false,
          photoGuidance:     userContext.result.photoGuidance ? String(userContext.result.photoGuidance).slice(0, 200) : null,
          treatmentUrgency:  userContext.result.treatmentUrgency || null,
          checkInIntervalDays: typeof userContext.result.checkInIntervalDays === 'number' ? userContext.result.checkInIntervalDays : null,
          nextCheckIn:       userContext.result.nextCheckIn || null,
          scoredAt:          userContext.result.scoredAt || null,
          currentStateScore: typeof userContext.result.currentStateScore === 'number' ? userContext.result.currentStateScore : null,
          weeklyFocus:       userContext.result.weeklyFocus ? String(userContext.result.weeklyFocus).slice(0, 200) : null,
          nextCheckInReason: userContext.result.nextCheckInReason ? String(userContext.result.nextCheckInReason).slice(0, 200) : null,
          thinningPattern:   userContext.result.thinningPattern || null,
        } : null,
        routine: Array.isArray(userContext.routine) ? userContext.routine : [],
        scanHistory: Array.isArray(userContext.history) ? userContext.history.slice(-6) : [],
        planProducts: Array.isArray(userContext.planProducts) ? userContext.planProducts.slice(0, 8) : [],
        routineDoneToday: Array.isArray(userContext.routineDoneToday) ? userContext.routineDoneToday.slice(0, 12) : [],
        weakestMetric:   userContext.weakestMetric  || userContext.result?.weakestMetric  || null,
        strongestMetric: userContext.strongestMetric || userContext.result?.strongestMetric || null,
        age: userContext.profile?.age || null,
        sex: userContext.profile?.sex || null,
        goals: Array.isArray(userContext.profile?.goals)
          ? userContext.profile.goals
          : (userContext.profile?.goals ? [String(userContext.profile.goals)] : []),
        concerns: Array.isArray(userContext.profile?.concern)
          ? userContext.profile.concern
          : (userContext.profile?.concern ? [String(userContext.profile.concern)] : []),
        timeline: userContext.profile?.timeline || null,
        familyHistory: Array.isArray(userContext.profile?.family) ? userContext.profile.family : [],
      };

      // Compute overall trend if ≥2 scans are available (scanHistory is newest-first).
      const overallScores = ctx.scanHistory.map((h) => h.overall).filter((v) => typeof v === 'number' && Number.isFinite(v));
      let trendStr = null;
      if (overallScores.length >= 2) {
        const delta = overallScores[0] - overallScores[overallScores.length - 1];
        const direction = delta > 1 ? 'improving' : delta < -1 ? 'declining' : 'stable';
        trendStr = `${delta >= 0 ? '+' : ''}${delta} over ${overallScores.length} scans (${direction})`;
      }

      // Compute Norwood stage progression from scan history (newest-first → reverse for chronological).
      const stageSeq = ctx.scanHistory.map((h) => h.stage).filter(Boolean);
      const stageTrendStr = stageSeq.length >= 2 ? [...stageSeq].reverse().join(' → ') : null;

      // Per-metric trend deltas across scan history (oldest → newest).
      // scanHistory is newest-first, so index 0 is latest, last index is oldest.
      const metricTrendParts = [];
      if (ctx.scanHistory.length >= 2) {
        const newest = ctx.scanHistory[0];
        const oldest = ctx.scanHistory[ctx.scanHistory.length - 1];
        for (const [label, key] of [['Hairline','hairline'],['Density','density'],['Crown','crown'],['Health','health'],['Potential','potential']]) {
          const n = typeof newest[key] === 'number' ? newest[key] : null;
          const o = typeof oldest[key] === 'number' ? oldest[key] : null;
          if (n !== null && o !== null) {
            const delta = n - o;
            const dir = delta > 2 ? 'improving' : delta < -2 ? 'declining' : 'stable';
            metricTrendParts.push(`${label} ${delta >= 0 ? '+' : ''}${delta} (${dir})`);
          }
        }
      }
      const metricTrendStr = metricTrendParts.length >= 2 ? metricTrendParts.join(', ') : null;

      const todayStr = new Date().toISOString().split('T')[0];
      const systemPrompt = [
        'You are HairlineCheck Coach — an AI specialist on male/female hair loss.',
        'Tone: friendly, direct, evidence-based. Avoid medical disclaimers unless specifically asked.',
        'Constraints: never prescribe Rx drugs; recommend talking to a doctor for finasteride/dutasteride.',
        'Length: short, scannable. Use bullets when listing options.',
        'Response style: answer directly. Do NOT open with affirmations or filler ("Great!", "Absolutely!", "Of course!", "Sure thing!", "That\'s a great question!"). Start with the substance of your answer.',
        '',
        `Today's date: ${todayStr}.`,
        'User context (use when relevant, do not parrot back verbatim):',
        ctx.scan
          ? `- Last scan: overall ${ctx.scan.overall}/100 (current state ${ctx.scan.currentStateScore ?? ctx.scan.overall}/100 excl. potential), hairline ${ctx.scan.hairline}, density ${ctx.scan.density}, crown ${ctx.scan.crown}, health ${ctx.scan.health}, potential ${ctx.scan.potential}.`
          : '- No scan yet.',
        ctx.scan?.stage && NORWOOD_GUIDE[ctx.scan.stage]
          ? `- Norwood stage: ${ctx.scan.stage} (${NORWOOD_GUIDE[ctx.scan.stage]}).`
          : ctx.scan?.stage ? `- Norwood stage: ${ctx.scan.stage}.` : '',
        ctx.scan?.headline ? `- AI scan headline: "${ctx.scan.headline}".` : '',
        ctx.scan?.verdict  ? `- AI scan verdict: "${ctx.scan.verdict}".`  : '',
        ctx.scan?.treatmentUrgency
          ? `- Treatment urgency: ${ctx.scan.treatmentUrgency} — calibrate your tone and CTA accordingly (high = motivate action now; moderate = steady progress; low = set realistic expectations).`
          : '',
        ctx.scan?.nextCheckIn
          ? `- Next recommended scan: ${ctx.scan.nextCheckIn} (in ${ctx.scan.checkInIntervalDays} days) — if the user asks when to check in again, use this date.`
          : '',
        ctx.scan?.nextCheckInReason ? `- Reason for check-in timing: ${ctx.scan.nextCheckInReason}.` : '',
        ctx.scan?.weeklyFocus
          ? `- This week's priority action (from scan): "${ctx.scan.weeklyFocus}" — if the user asks what to focus on or what to do next, reinforce this specific habit; do not contradict it with a different suggestion.`
          : '',
        ctx.scan?.scoredAt ? `- Last scan taken: ${ctx.scan.scoredAt.split('T')[0]} — use this when the user asks how long ago they scanned or how far away their next check-in is.` : '',
        ctx.scan?.photoQuality && ctx.scan.photoQuality !== 'good'
          ? `- Photo quality: ${ctx.scan.photoQuality}${ctx.scan.photoNote ? ` (${ctx.scan.photoNote})` : ''} — scores may have lower confidence.`
          : '',
        ctx.scan?.retakeRecommended && ctx.scan.photoGuidance
          ? `- If the user asks about score reliability or why scores seem low, recommend a retake: ${ctx.scan.photoGuidance}`
          : '',
        ctx.scan?.insights?.length
          ? `- Scan insights: ${ctx.scan.insights.map((ins, i) => `${i + 1}) "${ins.title}" (${ins.metric}): ${ins.body}`).join('; ')}.`
          : '',
        ctx.scan?.thinningPattern
          ? `- Thinning pattern: ${ctx.scan.thinningPattern}${THINNING_PATTERN_GUIDE[ctx.scan.thinningPattern] ? ` (${THINNING_PATTERN_GUIDE[ctx.scan.thinningPattern]})` : ''} — use this to give targeted zone-specific advice.`
          : '',
        ctx.weakestMetric?.label ? `- Current weakest metric: ${ctx.weakestMetric.label} (${ctx.weakestMetric.value}/100).` : '',
        ctx.strongestMetric?.label ? `- Current strongest metric: ${ctx.strongestMetric.label} (${ctx.strongestMetric.value}/100) — mention this as a positive when relevant.` : '',
        ctx.routine.length ? `- Current routine: ${ctx.routine.join(', ')}.` : '- No routine logged yet.',
        ctx.routineDoneToday.length ? `- Routine tasks completed today: ${ctx.routineDoneToday.join(', ')}.` : '- No routine tasks completed today.',
        ctx.planProducts.length ? `- Saved plan products: ${ctx.planProducts.join(', ')}.` : '- No saved plan products yet.',
        ctx.scanHistory.length
          ? `- Scan history (${ctx.scanHistory.length} scans, latest-first): ${ctx.scanHistory.map((h) => {
              const date = h.scoredAt ? ` on ${h.scoredAt.split('T')[0]}` : '';
              const stage = h.stage ? ` (${h.stage})` : '';
              const metrics = [h.hairline, h.density, h.crown, h.health, h.potential].every((v) => typeof v === 'number')
                ? ` [H:${h.hairline} D:${h.density} C:${h.crown} Hlth:${h.health} Pot:${h.potential}]` : '';
              return `${h.overall ?? '?'}${date}${stage}${metrics}`;
            }).join(', ')}${stageTrendStr ? `; stage progression: ${stageTrendStr}` : ctx.scanHistory[0]?.stage ? `; latest stage: ${ctx.scanHistory[0].stage}` : ''}.`
          : '- No scan history yet.',
        ctx.age ? `- Age: ${ctx.age}.` : '',
        ctx.sex ? `- Sex: ${ctx.sex}.` : '',
        ctx.goals.length ? `- Goals: ${ctx.goals.join(', ')}.` : '',
        ctx.concerns.length ? `- Concerns: ${ctx.concerns.join(', ')}.` : '',
        ctx.timeline ? `- Hair loss onset: ${ctx.timeline}.` : '',
        ctx.familyHistory.length ? `- Family history: ${ctx.familyHistory.join(', ')}.` : '',
        trendStr ? `- Overall score trend: ${trendStr}.` : '',
        metricTrendStr ? `- Per-metric trends (first scan → latest, ${ctx.scanHistory.length} scans): ${metricTrendStr} — celebrate improving metrics; prioritize declining ones in your advice.` : '',
      ].filter(Boolean).join('\n');

      // Trim history to last 10 turns for cost control
      const recentHistory = Array.isArray(history) ? history.slice(-10) : [];
      const messages = [
        { role: 'system', content: systemPrompt },
        ...recentHistory.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || '').slice(0, 1500) })),
        { role: 'user', content: message.slice(0, 1500) },
      ];

      const coachReqBody = JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.6, max_tokens: 700 });
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
        const aiErr = normalizeOpenAIError('Coach request failed', coachStatus, coachPayload);
        bumpError(METRICS.coach, coachStatus, aiErr.error);
        console.error('[coach] error', coachStatus, coachPayload);
        jsonError(req, res, coachStatus, { ...aiErr, requestId: reqId });
        return;
      }

      const coachChoice = coachPayload.choices?.[0];
      const coachFinishReason = coachChoice?.finish_reason;
      if (coachFinishReason === 'length') console.warn('[coach] reply truncated by max_tokens');
      const reply = coachChoice?.message?.content?.trim()
        || "I didn't quite catch that — could you rephrase your question?";
      const coachUsage = coachPayload.usage;
      if (coachUsage) {
        METRICS.coach.promptTokens     += coachUsage.prompt_tokens     || 0;
        METRICS.coach.completionTokens += coachUsage.completion_tokens || 0;
      }
      warnIfSlow('coach', startedAt, 'coach');
      if (coachUsage) console.log('[coach] ok', { ms: Date.now() - startedAt, tokens: { prompt: coachUsage.prompt_tokens, completion: coachUsage.completion_tokens }, finish: coachFinishReason });
      json(req, res, 200, { reply, requestId: reqId });
    } catch (err) {
      bumpError(METRICS.coach, err.statusCode || 500, err.message);
      console.error('[server] coach error', err);
      json(req, res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  if (serveStatic(req, res)) return;

  json(req, res, 404, { error: 'Not found', requestId: reqId });
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
