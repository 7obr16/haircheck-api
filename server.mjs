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

// ─── Treatment timeline expectations by Norwood stage ────────────
// Injected into the coach system prompt so the model can give accurate
// "when will I see results?" answers keyed to the user's actual stage.
const TREATMENT_TIMELINE_GUIDE = {
  NW1:        'NW1 — goal is prevention; no visible hair changes expected. Focus on long-term consistency (daily topicals, DHT shampoo) and 6-month monitoring intervals to catch any drift.',
  NW2:        'NW2 — first signs of stabilization (shedding slow-down) typically appear within 3–4 months. Temple filling, if it occurs, usually takes 9–12 months on a consistent dual-therapy protocol.',
  NW3:        'NW3 — active recession window; expect stabilization in 3–6 months with consistent minoxidil/finasteride. Visible temple filling can take 9–15 months, and not all NW3 users will regrow; halting further loss is the primary realistic benchmark.',
  NW3v:       'NW3v — dual-zone pattern (temples + crown); both areas are responsive but crown regrowth typically lags 2–3 months behind temple response. Expect stabilization in 4–6 months and measurable density improvement in 9–15 months with a full protocol.',
  NW4:        'NW4 — significant loss across frontal and crown zones; stabilization is the primary 6-month goal. Partial density recovery is realistic by 12 months with consistent triple-therapy (minoxidil, finasteride, LLLT/microneedling). Expectations should be managed carefully — hairline restoration to NW2 is not realistic.',
  NW5:        'NW5 — OTC treatments primarily slow further progression at this stage. Expect stabilization in 6–12 months. Cosmetic density improvement is possible but limited without Rx (finasteride/dutasteride); surgical options (FUE/FUT) are worth discussing with a specialist if density recovery is the goal.',
  NW6:        'NW6 — advanced loss; fringe maintenance is the realistic OTC goal. FUE/FUT transplant candidacy is the primary path to visible density improvement. Surgical consultation is the most impactful next step.',
  NW7:        'NW7 — near-total scalp loss; limited donor fringe available. OTC treatments maintain what remains. Hair transplant candidacy depends on donor density — consult a specialist. Scalp micropigmentation (SMP) is a realistic non-surgical option.',
  diffuse:    'Diffuse pattern — if telogen effluvium (stress/nutritional trigger), shedding typically resolves in 3–6 months once the root cause is addressed, with visible regrowth 3–6 months after shedding stops. AGA-driven diffuse thinning responds on a 6–12 month timeline similar to NW3.',
  'n/a (female)': 'Female pattern — Ludwig scale; treatment response timeline is 6–12 months once the correct root cause (hormonal, nutritional, or AGA) is identified and treated. Hormonal causes (PCOS, thyroid) often respond faster once corrected. AGA-driven female pattern responds to minoxidil within 6 months for shedding reduction and 12 months for density.',
};

// ─── Thinning zones per pattern ──────────────────────────────────
// Derived from thinningPattern; gives the iOS app a structured zone list
// for rendering targeted highlights without string parsing on the client.
const THINNING_ZONES_MAP = {
  minimal:            [],
  bitemporal:         ['temples'],
  crown:              ['crown'],
  'bitemporal+crown': ['temples', 'crown'],
  frontal:            ['frontal'],
  diffuse:            ['temples', 'frontal', 'mid-scalp', 'crown'],
  total:              ['temples', 'frontal', 'mid-scalp', 'crown', 'vertex'],
};

// Female-pattern AGA (Ludwig scale) spares the temporal hairline by definition —
// the standard THINNING_ZONES_MAP 'diffuse' and 'total' entries include 'temples'
// which would incorrectly highlight them for n/a (female) users.
// Ludwig I-II → 'diffuse' pattern: central parting, mid-scalp, crown only.
// Ludwig III  → 'total'   pattern: same zones plus vertex, still no temples.
const FEMALE_THINNING_ZONES_MAP = {
  diffuse: ['frontal', 'mid-scalp', 'crown'],
  total:   ['frontal', 'mid-scalp', 'crown', 'vertex'],
};

// Stage-correlated soft score bounds for hairline, density, and crown.
// Applied server-side after GPT-4o output to catch calibration drift that
// produces scores clearly inconsistent with the classified stage — e.g. an
// NW1 user (no recession anywhere) receiving a hairline score of 60, or an
// NW7 user (near-total loss) receiving a hairline of 55.
// Format: [hairlineMin, hairlineMax, densityMin, densityMax, crownMin, crownMax]
// Values = prompt guidance ranges ± 15 pts so only genuine outliers are corrected.
// health is NOT bounded: it depends on individual scalp condition regardless of stage.
// potential has its own POTENTIAL_STAGE_BOUNDS table below (stage-only, age-agnostic).
const STAGE_SCORE_BOUNDS = {
  NW1:           [75, 100,  73, 100,  75, 100],
  NW2:           [60, 100,  65, 100,  72, 100],
  NW3:           [40,  87,  50,  97,  67, 100],
  NW3v:          [40,  87,  43,  93,  40,  90],
  NW4:           [20,  70,  30,  83,  20,  73],
  NW5:           [ 5,  53,  15,  67,   3,  55],
  NW6:           [ 0,  40,   0,  50,   0,  35],
  NW7:           [ 0,  33,   0,  40,   0,  27],
  diffuse:       [50, 100,  20,  80,  17,  87],
  'n/a (female)': [57, 100, 15,  93,   7, 100],
};

// Stage-correlated soft bounds for the potential score.
// Unlike hairline/density/crown which are pure anatomy, potential is also
// age- and routine-dependent. These bounds are intentionally wide (±25 from
// the midpoint of the widest-age-bracket prompt range) so only genuine
// calibration outliers are caught — e.g. an NW7 user with potential=82 or
// an NW2 under-30 user with potential=18. Age-specific within-range variation
// is handled by the GPT-4o prompt and is NOT corrected here.
// Format: [potentialMin, potentialMax]
const POTENTIAL_STAGE_BOUNDS = {
  NW1:            [55, 100],  // prompt: 75-90; any-age; ±25 floor
  NW2:            [40, 100],  // prompt: 65-92 across all ages; generous floor for older users
  NW3:            [25, 100],  // prompt: 50-85 across all ages
  NW3v:           [19,  99],  // prompt: 44-79 across all ages
  NW4:            [17,  90],  // prompt: 42-70 across both age brackets
  NW5:            [ 0,  68],  // prompt: 28-48; +20 ceiling headroom for Rx upward adjustments
  NW6:            [ 0,  52],  // prompt: 15-32; generous ceiling for Rx combinations
  NW7:            [ 0,  52],  // same as NW6
  diffuse:        [23,  98],  // prompt: 48-78 across all ages; wide for TE upward adjustment
  'n/a (female)': [20,  98],  // prompt: 45-78 (Ludwig I-III); wide for hormonal Rx upward adjustment
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
  scan:             { requests: 0, errors: 0, cacheHits: 0, slowRequests: 0, retries: 0, promptTokens: 0, completionTokens: 0, lastError: null, lastSuccess: null, lastRetry: null },
  after:            { requests: 0, errors: 0, cacheHits: 0, slowRequests: 0, retries: 0, lastError: null, lastSuccess: null, lastRetry: null },
  progression:      { requests: 0, errors: 0, cacheHits: 0, slowRequests: 0, retries: 0, lastError: null, lastSuccess: null, lastRetry: null },
  progressionBatch: { requests: 0, errors: 0,               slowRequests: 0, retries: 0, lastError: null, lastSuccess: null, lastRetry: null },
  map:              { requests: 0, errors: 0, cacheHits: 0, slowRequests: 0, retries: 0, lastError: null, lastSuccess: null, lastRetry: null },
  adviceVisual:     { requests: 0, errors: 0, cacheHits: 0, slowRequests: 0, retries: 0, lastError: null, lastSuccess: null, lastRetry: null },
  coach:            { requests: 0, errors: 0, cacheHits: 0, slowRequests: 0, retries: 0, promptTokens: 0, completionTokens: 0, lastError: null, lastSuccess: null, lastRetry: null },
};

// OpenAI pricing constants (USD). Update as pricing changes on platform.openai.com/docs/pricing.
const OPENAI_TOKEN_PRICING = {
  scan:  { prompt: 2.50, completion: 10.00 },  // gpt-4o
  coach: { prompt: 0.15, completion:  0.60 },  // gpt-4o-mini
};
// gpt-image-2 cost per edit/generation call by quality level.
// Each image endpoint has its own default quality (see endpoint handlers).
const IMAGE_COST_BY_QUALITY = { low: 0.02, medium: 0.07, high: 0.19, auto: 0.07 };

// Rolling latency samples (ms) per endpoint — last 100 POST requests each.
// Exposed via /api/health so Railway dashboards and alerts can track p50/p95.
const LATENCY_MAX_SAMPLES = 100;
const LATENCY = {
  scan:             [],
  after:            [],
  progression:      [],
  progressionBatch: [],
  map:              [],
  adviceVisual:     [],
  coach:            [],
};

const URL_TO_LATENCY_KEY = {
  '/api/analyze-scan':                'scan',
  '/api/generate-after':              'after',
  '/api/generate-progression':        'progression',
  '/api/generate-progression-batch':  'progressionBatch',
  '/api/generate-analysis-map':       'map',
  '/api/generate-advice-visual':      'adviceVisual',
  '/api/coach':                       'coach',
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

function bumpSuccess(m) {
  m.lastSuccess = new Date().toISOString();
}

function bumpRetry(m, reason, status) {
  m.retries++;
  m.lastRetry = {
    at: new Date().toISOString(),
    reason: String(reason || '').slice(0, 80),
    status: status || null,
  };
}

function latencyStats(arr) {
  if (!arr.length) return { samples: 0, p50: null, p95: null, p99: null, avg: null, min: null, max: null };
  const sorted = [...arr].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct / 100))];
  return {
    samples: arr.length,
    p50: p(50),
    p95: p(95),
    p99: p(99),
    avg: Math.round(arr.reduce((s, v) => s + v, 0) / arr.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

// Compute estimated OpenAI API spend since server start.
// Token costs come from METRICS (tracked per successful call).
// Image costs use each endpoint's default quality level since quality
// can be overridden by the client but isn't tracked per-call.
function computeEstimatedCost() {
  const scan  = METRICS.scan.promptTokens    / 1e6 * OPENAI_TOKEN_PRICING.scan.prompt
              + METRICS.scan.completionTokens  / 1e6 * OPENAI_TOKEN_PRICING.scan.completion;
  const coach = METRICS.coach.promptTokens   / 1e6 * OPENAI_TOKEN_PRICING.coach.prompt
              + METRICS.coach.completionTokens / 1e6 * OPENAI_TOKEN_PRICING.coach.completion;
  // Cached calls never reach OpenAI — subtract them from the billable count.
  const billableAfter       = Math.max(0, METRICS.after.requests       - METRICS.after.cacheHits);
  const billableProgression = Math.max(0, METRICS.progression.requests - METRICS.progression.cacheHits);
  const billableMap         = Math.max(0, METRICS.map.requests         - METRICS.map.cacheHits);
  const billableVisual      = Math.max(0, METRICS.adviceVisual.requests - METRICS.adviceVisual.cacheHits);
  // Default qualities: after=low, progression=high, map=medium, adviceVisual=low.
  const images = billableAfter       * IMAGE_COST_BY_QUALITY.low
               + billableProgression * IMAGE_COST_BY_QUALITY.high
               + billableMap         * IMAGE_COST_BY_QUALITY.medium
               + billableVisual      * IMAGE_COST_BY_QUALITY.low;
  const total = scan + coach + images;
  return {
    scan:   +scan.toFixed(4),
    coach:  +coach.toFixed(4),
    images: +images.toFixed(4),
    total:  +total.toFixed(4),
    note:   'Estimated since server start; image costs use per-endpoint default quality prices',
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

let GIT_SHA = process.env.GIT_SHA
  || (process.env.RAILWAY_GIT_COMMIT_SHA ? process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7) : null)
  || 'unknown';
if (GIT_SHA === 'unknown') {
  try { GIT_SHA = execSync('git rev-parse --short HEAD', { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (_) {}
}

const SERVER_START_MS = Date.now();

const PORT = Number(process.env.PORT || 4322);
const SERVE_STATIC = process.env.SERVE_STATIC === '1';
const staticRoot = join(here, '..');
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 14 * 1024 * 1024);
// Decoded image buffer ceiling — prevents oversized uploads from exhausting Railway RAM
// and wasting OpenAI vision tokens. iOS HEIC→JPEG photos are typically 1–4 MB.
const MAX_PHOTO_BYTES = Number(process.env.MAX_PHOTO_BYTES || 8 * 1024 * 1024);
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

Change only one thing: locally improve the visible hair-loss areas while preserving the person's current hairstyle. Only add plausible density inside the already visible thinning, receded, sparse, or bald spots. Fill those weak areas with short, natural hair that exactly matches the existing surrounding hair.

CRITICAL texture rule: preserve the hair's exact ethnic texture — do NOT straighten curly, coily, or wavy hair; do NOT lighten or darken the hair color; do NOT apply a smooth or silky European texture to Afro-textured, South Asian, East Asian, or any other non-European hair type. The added hair must be indistinguishable in coarseness, curl pattern, wave, thickness, direction, shine, and color from the hair immediately surrounding the thinning zone.

CRITICAL grey/white hair rule: if the person's hair is grey, white, silver, or salt-and-pepper, the restored hair MUST match that exact grey or white shade — do NOT restore grey or white hair to a darker, younger-looking color. Restoring density does NOT mean restoring youth; the added hair must be the same grey, white, or mixed grey-and-dark shade as the hair it connects to. Adding dark hair where grey hair exists is wrong.

CRITICAL buzz-cut / very short hair rule: if the person has a buzz cut or clipper cut (hair ≤6mm — guard #1 through #3, machine-shaved sides, or any style where the hair lies flat and the scalp is easily visible through uniform short stubble), the restored hair MUST remain at the same ultra-short length as the surrounding hair. Do NOT add longer strands, fuzz, or visible growth to represent density improvement — show improvement as marginally denser coverage of identically short follicles within the thinning zone only. Growing out a buzz cut is NOT a valid restoration; if the improvement is barely perceptible at that length, that is clinically realistic and correct.

Do NOT create a new hairstyle. Do NOT change the existing hair length, parting, volume, silhouette, styling direction, forehead size, temples beyond the recession area, beard, eyebrows, skin, head shape, or background. Do NOT make the hair look freshly styled, longer, lighter, darker, wet, straighter, or like a different person. Keep the original hairline character and make it only moderately denser and more even.

The result must be photorealistic and pixel-aligned with the input so it can be used as the AFTER side of a before/after slider.`;

// Stage-specific zone hints appended to AFTER_PROMPT when the caller provides
// a Norwood stage from a prior scan. Helps the model focus restoration on the
// zones that matter most for that stage without over-restoring stable areas.
const AFTER_STAGE_HINTS = {
  NW1:  "This user is Norwood 1: fully intact hairline with no significant hair loss anywhere on the scalp. There are NO thinning, receding, or bald zones to restore. Make absolutely no changes to the hair — return an output that looks pixel-identical to the input. Do not add extra density, do not modify the hairline position, do not change any aspect of the hair. The result must be indistinguishable from the input photo.",
  NW2:  "This user is Norwood 2: slight symmetric temple recession. Focus only on the temple corners — fill the M-shape recession to a natural, slightly receded adult hairline. Crown and mid-scalp are intact; leave them unchanged.",
  NW3:  "This user is Norwood 3: deep bilateral temple recession extending past mid-pupil. Prioritize filling both temple recession zones. Crown and mid-scalp should remain mostly unchanged unless thinning is clearly visible there.",
  NW3v: "This user is Norwood 3v: deep temple recession PLUS early vertex/crown thinning. Address both zones equally — fill temple recession and add modest density to the crown.",
  NW4:  "This user is Norwood 4: significant frontal hairline retreat and pronounced crown thinning. Restore density in both the frontal zone (to a credible age-appropriate hairline — approximately NW2-to-NW3 equivalent, NOT a straight youthful NW1 hairline) and the crown/vertex. The result should look 'clearly improved, not fully restored': the crown must retain at least 40–50% of its current exposed scalp area even in the best-case result — meaningful improvement, but the crown must never appear fully covered. The scalp top should still look clearly thinner than a person with no hair loss. Complete crown coverage at NW4 is not realistic.",
  NW5:  "This user is Norwood 5: frontal and crown zones nearly merging. The merged or nearly-merged bald area across the scalp top is large — show only modest improvement. The scalp top must still show 50–65% of its current exposed scalp area. Show slight density increase primarily at the hairline edge and fringe margins; the central bald area should look marginally less bare than the input but must remain clearly sparse. A person looking at the after photo should still immediately recognize significant hair loss across the full scalp top.",
  NW6:  "This user is Norwood 6: frontal and crown merged with only a lateral fringe. DO NOT fill in the large bald top — the merged frontal-crown bald zone must remain clearly bare and essentially unchanged in extent. Improve density only at the edges of the lateral fringe (slightly thicker, marginally denser fringe hairs) and at the very outermost boundary of the bald zone. The result should look slightly better at the fringe perimeter only — not as though meaningful coverage has been added across the scalp top.",
  NW7:  "This user is Norwood 7: near-total top loss. The near-total bald scalp top must remain essentially unchanged — DO NOT add new coverage to the bare top. Show only very marginal fringe density preservation (marginally thicker individual hairs at the horseshoe fringe edges). Treatment at NW7 maintains what remains; it does not restore lost top coverage. The improvement should be nearly imperceptible — someone looking at the after photo should still see essentially the same extent of hair loss.",
  diffuse: "This user has diffuse thinning (AGA or telogen effluvium): uniform density reduction across the entire scalp top without a distinct recession pattern — the hairline perimeter and temple shape are largely intact. Apply a uniform density increase across the whole scalp top without shifting or changing the hairline position. The result should look meaningfully fuller than the input — less scalp visible through the hair uniformly across the top — but retain some evidence of diffuse thinning: hair should appear naturally denser throughout but not uniformly thick like a person with no hair loss history. Do not add density unevenly, do not create temple recession or any new pattern where none existed, and do not move the hairline forward or backward. The frontal hairline, temple geometry, and sides must remain identical to the input.",
  'n/a (female)': "This user has female-pattern thinning (Ludwig scale): diffuse loss at the central part and crown vertex, with the frontal hairline and temple shape largely intact. Focus improvement on two specific zones: (1) the central parting — make it visibly narrower so less scalp shows through the part line; (2) the crown/vertex region — add noticeable density increase across the scalp top. The result should look clearly improved (a narrower central part and fuller crown) but retain some evidence of central-part thinning — hair should not appear uniformly thick from front to crown the way a person with no hair loss history looks. The frontal hairline, temple shape, and sides must remain completely unchanged — female-pattern loss spares these zones and modifying them would look anatomically incorrect.",
};

// Returns AFTER_PROMPT with an optional stage-specific zone hint appended.
// Falls back to the base prompt when stage is absent or unrecognised.
const buildAfterPrompt = (stage) => {
  const hint = stage ? AFTER_STAGE_HINTS[stage] : null;
  return hint ? `${AFTER_PROMPT}\n\nStage-specific focus: ${hint}` : AFTER_PROMPT;
};

// Stage-specific zone hints for the analysis-map heatmap overlay.
// Tells the model WHERE to place red/orange (low density) vs green (high density)
// patches so the overlay matches the expected anatomy for each Norwood stage.
const MAP_STAGE_HINTS = {
  NW1:  'Show HIGH density (green/teal) uniformly across the entire scalp top. This user has NO thinning or recession anywhere — do NOT place any red, orange, or yellow patches anywhere on the scalp. The entire hair-bearing area should show consistent green/teal indicating complete, healthy coverage with no localized low-density zones.',
  NW2:  'Show HIGH density (green/teal) at crown and mid-scalp. Place subtle LOW density (orange/yellow) patches only at the temple corners where the M-shape recession is visible.',
  NW3:  'Show LOW density (red/orange) at both temple recession zones extending past mid-pupil. Crown and mid-scalp should be HIGH density (green). Do not add red to the crown.',
  NW3v: 'Show LOW density (red/orange) at both temple recession zones AND a separate LOW density zone at the vertex/crown. Mid-scalp between these zones should be MEDIUM density (yellow/orange).',
  NW4:  'Show LOW density (red/orange) at the frontal/hairline zone AND at the crown/vertex. A narrow MEDIUM density bridge (yellow) should appear between the two low-density zones. Sides are HIGH density (green).',
  NW5:  'Show LOW density (red) at both the frontal and crown zones. Only a very narrow, sparse bridge separates them — show it as orange/yellow. Lateral fringe shows HIGH density (green).',
  NW6:  'Show LOW density (red) across the entire scalp top — frontal and crown zones have merged. Only the lateral sides and nape should show HIGH density (green).',
  NW7:  'Show LOW density (red) across the entire scalp top uniformly. Only a narrow horseshoe fringe at the sides and back should show HIGH density (green).',
  diffuse: 'Show MEDIUM-to-LOW density (yellow/orange) distributed uniformly across the entire scalp top without any localized red zones. The hairline perimeter stays HIGH density (green).',
  'n/a (female)': 'Show LOW density (red/orange) along the central parting line and crown. Hairline perimeter and sides should remain HIGH density (green).',
};

// Stage-specific zone hints for progression photos — mirrors AFTER_STAGE_HINTS
// but phrased to keep the focus on the correct zones at each Norwood level.
// The progression prompt already specifies the degree of improvement per month;
// these hints tell the model WHERE to apply that improvement.
const PROGRESSION_STAGE_HINTS = {
  NW1:  "This user is Norwood 1 — fully intact hairline with no hair loss anywhere. There are no thinning zones to improve at any treatment month. Make no visible changes — the 3-month, 6-month, and 12-month results should all look identical to the input photo. Do not add extra density or modify the hairline in any way.",
  NW2:  "This user is Norwood 2 (slight temple recession). Direct all visible improvement to the temple corners only — gradually fill the M-shape recession toward a natural adult hairline. Crown and mid-scalp are intact; leave them unchanged.",
  NW3:  "This user is Norwood 3 (deep bilateral temple recession). Show improvement primarily in the temple recession zones. Crown and mid-scalp should remain mostly unchanged unless thinning is clearly visible there.",
  NW3v: "This user is Norwood 3v (deep temple recession + early crown thinning). Show improvement in both zones equally — temple recession filling and modest crown density increase — proportional to the treatment month.",
  NW4:  "This user is Norwood 4 (significant frontal hairline retreat + pronounced crown thinning). Direct any improvement to both zones — the frontal hairline area (toward a more defined, credible adult hairline shape, not a teenager's hairline) and the crown/vertex (denser, but visible scalp always remains; 'clearly improved, not naturally full'). Complete crown coverage at NW4 is unlikely regardless of treatment duration — the crown must still show thinning and exposed scalp even at the strongest improvement level.",
  NW5:  "This user is Norwood 5 (frontal and crown zones nearly merging). Direct improvement uniformly across the entire scalp top — reduce visible scalp throughout, proportional to the treatment month. The sparse band between frontal and crown should look slightly wider and denser, but never fully bridged.",
  NW6:  "This user is Norwood 6 (frontal and crown merged). Direct improvement uniformly across the full scalp top, proportional to the treatment month. The result must still show large areas of exposed scalp — improvement is always partial at NW6, never approaching full coverage.",
  NW7:  "This user is Norwood 7 (near-total top loss). Direct improvement uniformly across the entire scalp top, proportional to the treatment month. The horseshoe fringe must remain as the only dense zone — the top should look less bare than the input, but never appear densely covered.",
  diffuse: "This user has diffuse thinning (uniform loss across the entire scalp top without a distinct recession). Show uniform density increase across the whole scalp top without shifting or changing the hairline position or temple geometry — do not create any recession pattern where none existed. The frontal hairline and sides must remain identical to the input; improvement is applied uniformly across the top only.",
  'n/a (female)': "This user has female-pattern thinning (Ludwig scale — diffuse loss at the central part and crown, with the frontal hairline intact). Direct all improvement to two zones: (1) the central parting — make it proportionally narrower and less scalp-visible through the part line; (2) the crown/vertex region — increase density across the scalp top. The frontal hairline, temple shape, and sides must remain completely unchanged — female-pattern loss spares these zones. Do not alter the hairline position or create any angular recession where none existed.",
};

// Build a progression prompt with an optional stage-specific zone hint.
// Falls back to the base prompt when stage is absent or unrecognised.
// For 12-month + realistic stages (NW4-NW7) the base prompt says "Full natural-looking density"
// which conflicts with clinical reality — NW4+ rarely achieves complete coverage after 12 months.
// For 6-month + advanced stages (NW4-NW7) the base says "40–50% closer to full density" —
// too optimistic for NW4-NW7; that range applies to NW2-NW3 where follicles are more viable.
// For 12-month + NW3/NW3v, "Full natural-looking density" overshoots — the realistic best-case
// ceiling after 12 months of consistent treatment is a substantial fill of the temple recession
// (equivalent to a NW2 hairline), not full NW1 restoration. Recession lines remain visible.
const PROGRESSION_ADVANCED_STAGES    = new Set(['NW4', 'NW5', 'NW6', 'NW7']); // 6-month override
const PROGRESSION_REALISTIC_12MO_STAGES = new Set(['NW4', 'NW5', 'NW6', 'NW7']); // 12-month override
const PROGRESSION_CALIBRATED_12MO_STAGES = new Set(['NW3', 'NW3v']); // 12-month calibration override
// 12-month calibration for diffuse/female-pattern stages: miniaturized follicles can recover
// significantly with treatment, but the base prompt's "Full natural-looking density" language
// overstates the typical 12-month ceiling — especially for Ludwig II-III or severe diffuse AGA
// where central-part thinning is unlikely to be completely invisible at 12 months.
// The improvement should look meaningful (denser parting, less visible scalp) but retain
// some evidence that thinning was present — the same principle as the NW3/NW3v calibration.
const PROGRESSION_CALIBRATED_DIFFUSE_12MO_STAGES = new Set(['diffuse', 'n/a (female)']); // 12-month calibration
// 3-month calibration for diffuse/female-pattern stages: the base prompt uses AGA-specific
// language ("thinning edges", "recession boundary") that is anatomically incorrect for these
// stages — diffuse thinning is uniform and female-pattern (Ludwig) loss spares the temples.
// The override redirects the model to the correct zone (central parting) and removes the
// recession-specific language that would cause the wrong area to be "improved".
const PROGRESSION_CALIBRATED_DIFFUSE_3MO_STAGES = new Set(['diffuse', 'n/a (female)']); // 3-month calibration
// 6-month calibration for diffuse/female-pattern stages: the base prompt says "hairline edges
// look more defined and the temple recession appears partially filled" — both wrong for these
// stages. Female-pattern loss and diffuse AGA affect the central parting and scalp top, not
// the temples. Override to redirect improvement to the correct anatomical zone.
const PROGRESSION_CALIBRATED_DIFFUSE_6MO_STAGES = new Set(['diffuse', 'n/a (female)']); // 6-month calibration
// 3-month override for advanced stages: at NW4+ the bald zones are large enough that real
// 3-month results are essentially invisible in photos. The base prompt's "15–20% shine
// reduction / slight thickening" language is far too optimistic when large bald areas exist.
// NW5-NW7: near-total or fully merged bald zones → essentially identical to input.
// NW4: large frontal + crown bald zones → nearly identical; faintest edge thickening only.
const PROGRESSION_MINIMAL_3MO_STAGES = new Set(['NW5', 'NW6', 'NW7']); // 3-month override
// 3-month calibration for NW2/NW3/NW3v: the stage hints direct the model to "gradually fill
// the M-shape recession" or "show improvement primarily in the temple recession zones" — language
// that is correct for the 6/12-month timeframes but too aggressive for 3 months. Real 3-month
// results for these stages are nearly imperceptible: the recession shape stays essentially
// unchanged and any visible improvement is limited to marginally thicker existing hairs at the
// very outermost edge of the recession boundary. Without this calibration the model may
// prematurely fill visible recession corners that realistically wouldn't change for many months.
const PROGRESSION_CONSERVATIVE_3MO_STAGES = new Set(['NW2', 'NW3', 'NW3v']); // 3-month calibration
// 6-month calibration for NW3/NW3v: the base prompt says "40–50% closer to full density"
// and "hairline edges look more defined and the temple recession appears partially filled".
// For deep recession stages (NW3/NW3v), 40–50% temple filling significantly overstates
// what 6 months of treatment achieves — realistic results are around 20–30% recession
// reduction, not a half-restored hairline. NW2 is not included here because its shallow
// recession is genuinely more responsive and 40–50% filling is plausible by month 6.
const PROGRESSION_CALIBRATED_6MO_NW3_STAGES = new Set(['NW3', 'NW3v']); // 6-month calibration
// NW1 has no hair loss at all — the base prompts for months 3, 6, and 12 all instruct
// making improvements, which directly conflicts with the stage hint ("make no changes").
// Without an explicit OVERRIDES qualifier the image model follows the base prompt and
// incorrectly adds hair to an already-full scalp. Apply an override for all months.
const PROGRESSION_IDENTICAL_STAGES = new Set(['NW1']); // no-change override (all months)
const buildProgressionPrompt = (month, stage) => {
  const basePrompt = PROGRESSION_PROMPTS[month];
  const hint = stage ? PROGRESSION_STAGE_HINTS[stage] : null;
  if (!hint) return basePrompt;
  let qualifier;
  if (PROGRESSION_IDENTICAL_STAGES.has(stage)) {
    qualifier = 'Stage-specific constraint (OVERRIDES the entire improvement prompt above — this user is Norwood 1 with a fully intact hairline and no hair loss anywhere. Make NO visible changes to hair density, hairline shape, or any scalp area for any treatment month. The output must look essentially identical to the input. Do not thicken, darken, add, or restore any hair):';
  } else if (month === 12 && PROGRESSION_REALISTIC_12MO_STAGES.has(stage)) {
    qualifier = 'Stage-specific constraint (OVERRIDES the "STRONG / Full natural-looking density" language above — do not restore to full density for this stage; show clear improvement proportional to what real users at this stage achieve after 12 months):';
  } else if (month === 12 && PROGRESSION_CALIBRATED_12MO_STAGES.has(stage)) {
    qualifier = 'Stage-specific constraint (CALIBRATES the "Full natural-looking density" language above — at NW3/NW3v the realistic 12-month ceiling is significant temple filling equivalent to a NW2 hairline, NOT a fully restored NW1 hairline. The recession should look substantially reduced — temple corners clearly filled and less angular — but the hairline must still show some recession character; do NOT erase all recession to produce a straight, NW1-level result):';
  } else if (month === 12 && PROGRESSION_CALIBRATED_DIFFUSE_12MO_STAGES.has(stage)) {
    qualifier = 'Stage-specific constraint (CALIBRATES the "Full natural-looking density" language above — for diffuse thinning or female-pattern loss the realistic 12-month ceiling is noticeably increased central density and visibly less scalp showing at the central part and crown top, NOT a return to uniformly full hair. Show meaningful improvement — the parting and scalp top look substantially denser than the input — but keep some evidence that central-part thinning was present; do NOT produce a result where the parting and scalp look completely identical to a person with no hair loss history):';
  } else if (month === 6 && PROGRESSION_ADVANCED_STAGES.has(stage)) {
    qualifier = 'Stage-specific constraint (OVERRIDES the "40–50% closer to full density" language above — at this advanced stage that level of improvement is not realistic at 6 months; show clearly better coverage than the 3-month result but far more modest than the 40–50% figure implies):';
  } else if (month === 6 && PROGRESSION_CALIBRATED_6MO_NW3_STAGES.has(stage)) {
    qualifier = 'Stage-specific constraint (CALIBRATES the "40–50% closer to full density" and "temple recession appears partially filled" language above — for NW3 and NW3v with deep bilateral temple recession, the realistic 6-month ceiling is noticeably less recession than the input (roughly 20–30% recession reduction), NOT a half-filled hairline. Temple corners should look visibly less angular and slightly filled compared to the 3-month result, but the deep recession must still be clearly present and recognizable as the same pattern. Show meaningful improvement over the 3-month photo without overstating what 6 months of treatment realistically achieves for deep temple recession):';
  } else if (month === 6 && PROGRESSION_CALIBRATED_DIFFUSE_6MO_STAGES.has(stage)) {
    qualifier = 'Stage-specific constraint (CALIBRATES the "hairline edges / temple recession" language above — for diffuse thinning or female-pattern loss there is NO temple recession and the hairline position must not change. Show noticeable density improvement at the central parting and scalp top only: the part line looks narrower, visibly less scalp shows through the central area and crown region, and the overall top appears moderately denser than the 3-month result — but DO NOT alter the hairline, temples, or frontal edge in any way):';
  } else if (month === 3 && PROGRESSION_CALIBRATED_DIFFUSE_3MO_STAGES.has(stage)) {
    qualifier = 'Stage-specific constraint (CALIBRATES the "thinning edges / recession boundary" language above — for diffuse thinning or female-pattern loss there are no distinct recession edges or temple corners to fill. Show only the faintest, nearly imperceptible uniform density improvement across the central parting and scalp top: slightly less scalp shows through the center part, the overall top looks the tiniest bit fuller — but the output must look nearly identical to the input and an ordinary viewer should not notice any change without a side-by-side comparison. DO NOT alter the hairline, temples, or frontal edge):';
  } else if (month === 3 && stage === 'NW4') {
    qualifier = 'Stage-specific constraint (OVERRIDES the "15–20% shine reduction / slight thickening" language above — at NW4, real 3-month treatment results are nearly invisible in photos. The large frontal and crown bald zones must show NO new growth or density change. Show at most the faintest hint of marginally thicker hairs only at the very edges of the recession boundary and crown thinning edge — the output must look nearly identical to the input and an ordinary viewer should not notice any difference without a side-by-side comparison):';
  } else if (month === 3 && PROGRESSION_MINIMAL_3MO_STAGES.has(stage)) {
    qualifier = 'Stage-specific constraint (OVERRIDES the "15–20% shine reduction / slight thickening" language above — at this advanced stage, real 3-month treatment results are nearly invisible in photos. The large bald zones across the scalp top must show NO new growth or density change. Show at most the faintest hint of marginally thicker hairs only at the horseshoe fringe boundary — the output must look essentially identical to the input and an ordinary viewer should not notice any difference without a side-by-side comparison):';
  } else if (month === 3 && PROGRESSION_CONSERVATIVE_3MO_STAGES.has(stage)) {
    qualifier = 'Stage-specific constraint (CALIBRATES both the base improvement prompt and the stage hint below — at 3 months the recession shape must remain essentially identical to the input: no visible filling of temple corners, no forward shift of the recession boundary. Real 3-month results for these stages are nearly imperceptible. Show only the faintest possible edge effect — marginally thicker existing hairs at the outermost edge of the recession boundary, if anything — so the output looks nearly identical to the input and an ordinary viewer would not notice any difference without a side-by-side comparison. For NW3v, the early crown thinning patch is also essentially unchanged at 3 months):';
  } else {
    qualifier = 'Stage-specific focus:';
  }
  return `${basePrompt}\n\n${qualifier} ${hint}`;
};

// Build 3 context-aware suggested questions for the coach tab.
// Returned as coachSuggestedQuestions in the scan response so the iOS app can surface
// them as suggestion chips — zero API cost, pure server-side rule logic.
// Questions are routine-aware (don't suggest starting something already active) and
// stage-aware (specialist framing for NW5+, cause-finding for diffuse/female).
const buildSuggestedQuestions = (stage, protocolCoverage, specialistRecommended) => {
  const { topical = false, rx = false, dhtShampoo = false, mechanical = false, lllt = false, microneedling = false, supplements = false } = protocolCoverage || {};
  const hasAnyOTC = topical || dhtShampoo || mechanical || supplements;

  // NW7 — near-total loss; horseshoe fringe only; surgical options (FUE/FUT or SMP) are the primary path.
  // 3-tier structure matches NW5/NW6: no-treatment / OTC-only / Rx, each with transplant-planning context.
  if (stage === 'NW7') {
    if (!hasAnyOTC && !rx) {
      return [
        'What are my realistic options at NW7?',
        'Should I start any OTC treatment or go straight to a transplant consultation at NW7?',
        'What should I ask a trichologist about at NW7?',
      ];
    }
    if (!rx) {
      return [
        topical
          ? 'Can I continue minoxidil after a hair transplant?'
          : dhtShampoo ? 'Should I add minoxidil to my DHT-blocking shampoo routine at NW7?' : 'Which OTC steps are still worth keeping alongside a transplant plan at NW7?',
        'Is finasteride worth adding at NW7, or is surgical planning the priority?',
        'How does my current OTC routine fit into a transplant or SMP plan at NW7?',
      ];
    }
    // Has Rx (and possibly OTC)
    return [
      'How does finasteride fit into a hair transplant or SMP plan?',
      topical
        ? 'Can I continue minoxidil after a hair transplant?'
        : dhtShampoo ? 'Should I add minoxidil to my finasteride + DHT-blocking shampoo at NW7?' : 'Should I add minoxidil to my finasteride at NW7?',
      'Should I continue finasteride after a hair transplant?',
    ];
  }
  // NW6 — frontal and crown merged; only lateral fringe remains; surgical options become primary path.
  // 3-tier structure matches NW5: no-treatment / OTC-only / Rx, each with transplant-planning context.
  if (stage === 'NW6') {
    if (!hasAnyOTC && !rx) {
      return [
        'What OTC steps still make sense at NW6?',
        'Should I book a hair transplant consultation now?',
        'How do I protect the hair I still have?',
      ];
    }
    if (!rx) {
      return [
        topical
          ? 'Am I applying minoxidil correctly to my remaining fringe and temple edges at NW6?'
          : dhtShampoo ? 'Should I add minoxidil to my DHT-blocking shampoo routine at NW6?' : 'Which OTC treatments most effectively slow fringe recession at NW6?',
        'Is finasteride worth adding to my OTC protocol at NW6?',
        'Should I book a hair transplant consultation now?',
      ];
    }
    // Has Rx (and possibly OTC)
    return [
      topical
        ? 'How do I get the most from my finasteride and minoxidil at NW6?'
        : dhtShampoo ? 'Should I add minoxidil to my finasteride + DHT-blocking shampoo at NW6?' : 'Should I add minoxidil to my finasteride at NW6?',
      'Should I book a hair transplant consultation now?',
      topical
        ? 'How does my NW6 protocol fit into a transplant or SMP plan?'
        : dhtShampoo ? 'How does my finasteride + DHT-blocking shampoo fit into a transplant or SMP plan at NW6?' : 'How does finasteride alone fit into a transplant or SMP plan at NW6?',
    ];
  }
  // NW5 — frontal and crown zones nearly merging; significant loss across the full scalp top.
  // specialistRecommended is always true at NW5 (SPECIALIST_STAGES); conditional is written
  // for consistency with other branches and against the edge case where currentStateScore
  // overrides the flag. A transplant-consultation question appears at every tier.
  if (stage === 'NW5') {
    if (!hasAnyOTC && !rx) {
      return [
        'At NW5, what OTC steps are still worth starting alongside a transplant plan?',
        'Is minoxidil worth starting at NW5, or is it too late for meaningful results?',
        specialistRecommended
          ? 'At NW5, when should I prioritize booking a hair transplant consultation?'
          : 'What is the most impactful step I can take at NW5?',
      ];
    }
    if (!rx) {
      return [
        topical
          ? 'Am I applying minoxidil correctly across both my frontal and crown zones at NW5?'
          : dhtShampoo ? 'Should I add minoxidil to my DHT shampoo routine at NW5?' : 'Should I add minoxidil across both my frontal and crown zones at NW5?',
        'Is finasteride worth adding to my OTC protocol at NW5?',
        specialistRecommended
          ? 'My scan recommended a transplant consultation — what OTC steps should I keep going alongside surgical planning at NW5?'
          : 'How do I know if my OTC protocol is working at NW5?',
      ];
    }
    // Has Rx and some OTC
    return [
      topical
        ? 'How do I get the most from my finasteride and minoxidil at NW5?'
        : dhtShampoo ? 'Should I add minoxidil to my finasteride + DHT-blocking shampoo at NW5?' : 'Should I add minoxidil to my finasteride at NW5?',
      !mechanical
        ? 'Does scalp massage improve minoxidil absorption across both the frontal and crown zones at NW5?'
        : !dhtShampoo
          ? (lllt ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + LLLT stack at NW5?' : microneedling ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + microneedling stack at NW5?' : 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + massage stack at NW5?')
          : (specialistRecommended
              ? 'My scan recommended a transplant consultation — how does my current NW5 protocol fit into a surgical plan?'
              : (lllt ? 'How do I get the most from my LLLT device across both my NW5 frontal and crown zones?' : microneedling ? 'How do I time my microneedling sessions with minoxidil across both my NW5 frontal and crown zones?' : 'How do I measure progress with my current NW5 Rx protocol?')),
      'What results can I realistically expect from my NW5 protocol before committing to a transplant?',
    ];
  }
  // n/a (female) — female-pattern thinning; Ludwig scale applies; hormonal/nutritional root-cause
  // investigation is always the first priority because treating a correctable cause (ferritin,
  // thyroid, oestrogen) produces faster results than adding products over an uncorrected driver.
  // 3-tier structure: no-treatment / OTC-only / Rx, all with specialist-visit context since
  // n/a (female) is always in SPECIALIST_STAGES.
  if (stage === 'n/a (female)') {
    if (!hasAnyOTC && !rx) {
      return [
        'What hormone and blood tests should I ask my doctor about for female hair loss?',
        'What is the most effective treatment for female-pattern hair loss?',
        'My scan flagged a specialist visit — what should I ask a dermatologist or gynecologist about female-pattern loss?',
      ];
    }
    if (!rx) {
      return [
        topical
          ? 'Am I applying minoxidil correctly for female-pattern hair loss — central part, not just the hairline?'
          : 'Is minoxidil effective for female-pattern hair loss and how should I use it correctly?',
        'Should I ask my doctor about prescription treatments for female-pattern loss?',
        'What hormone and blood tests should I still get, even while using OTC treatment for female-pattern loss?',
      ];
    }
    // Has Rx (and possibly OTC)
    return [
      topical
        ? 'How do I know if my current treatment is working for female-pattern loss — what signs should I look for?'
        : 'Should I add minoxidil to my current prescription treatment for female-pattern loss?',
      'What blood tests should I still ask about, even while on treatment for female-pattern loss?',
      'What results can I realistically expect from my female-pattern loss protocol over 6-12 months?',
    ];
  }
  // diffuse — uniform thinning without a classic recession pattern; often nutritional, hormonal,
  // or telogen-effluvium-driven. Root-cause investigation before adding products is the highest-ROI
  // step since many diffuse causes are reversible. diffuse is always in SPECIALIST_STAGES.
  // 3-tier structure: no-treatment / OTC-only / Rx, all with specialist-visit context.
  if (stage === 'diffuse') {
    if (!hasAnyOTC && !rx) {
      return [
        'What blood tests should I ask my doctor about for diffuse thinning?',
        'What is the most effective first step for diffuse hair loss: topicals or root-cause testing?',
        'My scan flagged a specialist visit — what should I bring up about my diffuse thinning?',
      ];
    }
    if (!rx) {
      return [
        topical
          ? 'Am I applying minoxidil correctly for diffuse thinning across the full scalp?'
          : 'Which OTC topical works best for diffuse thinning alongside my current routine?',
        'Is finasteride worth adding to my OTC routine to address the hormonal side of diffuse thinning?',
        'What blood workup should I still ask about while treating diffuse thinning with OTC products?',
      ];
    }
    // Has Rx (and possibly OTC)
    return [
      topical
        ? 'How do I know if my finasteride and minoxidil are targeting the right cause of my diffuse thinning?'
        : 'Should I add minoxidil to my finasteride for diffuse thinning?',
      'What blood tests should I still ask about, even while on Rx treatment for diffuse thinning?',
      'What results can I realistically expect from my current diffuse thinning protocol?',
    ];
  }
  // NW1 — fully intact hairline; purely preventive stage; questions focus on prevention value and monitoring, not treatment.
  // 3-tier structure: no-treatment / OTC-only / Rx, calibrated to a user who has no visible loss yet.
  if (stage === 'NW1') {
    if (!hasAnyOTC && !rx) {
      return [
        'Is it worth starting any treatment when my hair is still fully intact at NW1?',
        'Which prevention step has the strongest evidence at NW1?',
        'How will I know when I need to escalate from prevention to active treatment?',
      ];
    }
    if (!rx) {
      return [
        'Is finasteride worth starting at NW1 to strengthen my prevention protocol?',
        dhtShampoo
          ? 'How long should I leave DHT shampoo on at NW1 for the best anti-miniaturization effect?'
          : 'Is DHT-blocking shampoo worth it on its own at NW1?',
        'How will I know if my NW1 prevention is actually working?',
      ];
    }
    // Has Rx and possibly OTC
    return [
      !mechanical
        ? 'Is finasteride enough on its own for NW1 prevention, or should I add something else?'
        : !dhtShampoo
          ? (lllt ? 'Should I add a DHT-blocking shampoo to my finasteride + LLLT stack at NW1?' : microneedling ? 'Should I add a DHT-blocking shampoo to my finasteride + microneedling stack at NW1?' : 'Should I add a DHT-blocking shampoo to my finasteride + scalp massage routine at NW1?')
          : (lllt ? 'How do I get the most from my LLLT device as part of my NW1 prevention stack?' : microneedling ? 'How often should I do microneedling alongside finasteride at NW1 to maximize prevention?' : 'How do I get the most from my finasteride and DHT shampoo at NW1?'),
      'How long should I continue finasteride at NW1 before reassessing?',
      'How will I know if my NW1 prevention protocol is actually working?',
    ];
  }
  // NW2 — slight symmetric temple recession; earliest AGA stage; strongest preventive window.
  // 3-tier structure mirrors NW3-NW7: no-treatment / OTC-only / Rx, calibrated to the early stage.
  if (stage === 'NW2') {
    if (!hasAnyOTC && !rx) {
      return [
        'Should I start minoxidil for early temple recession at NW2?',
        'Is finasteride worth starting at NW2 to prevent further recession?',
        'How quickly can NW2 progress without treatment?',
      ];
    }
    if (!rx) {
      return [
        'Is finasteride worth adding to my OTC routine at NW2?',
        topical
          ? 'Am I applying minoxidil correctly to both temple corners at NW2?'
          : dhtShampoo ? 'Should I add minoxidil to my DHT shampoo routine at NW2?' : 'Should I add minoxidil to both temple corners at NW2?',
        'How long before I know if my OTC treatment is protecting my temples at NW2?',
      ];
    }
    // Has Rx and possibly OTC
    return [
      topical
        ? 'How do I know if my finasteride and minoxidil are slowing my NW2 recession?'
        : 'Should I add minoxidil to my finasteride at NW2?',
      !mechanical
        ? 'Does scalp massage improve minoxidil absorption at the temple corners at NW2?'
        : !dhtShampoo
          ? (lllt ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + LLLT stack at NW2?' : microneedling ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + microneedling stack at NW2?' : 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + massage stack at NW2?')
          : (lllt ? 'How do I get the most from my LLLT device alongside finasteride and minoxidil at NW2?' : microneedling ? 'How do I time my microneedling sessions with minoxidil at my NW2 temple corners?' : 'How should I time scalp massage with my minoxidil application at NW2?'),
      'What results can I realistically expect from my NW2 protocol?',
    ];
  }
  // NW3v — dual-zone stage (temples AND early crown active simultaneously)
  // Needs its own branch because both zones require treatment and the key
  // questions differ from NW3 (temples only) and the generic NW4 fallback.
  if (stage === 'NW3v') {
    if (!hasAnyOTC && !rx) {
      return [
        'At NW3v, should I treat my temples and crown at the same time?',
        'How long does minoxidil take to show results on both the temples and crown?',
        specialistRecommended
          ? 'My scan flagged a trichologist visit — should I see a specialist before starting NW3v treatment?'
          : "What's the best treatment stack for NW3v dual-zone loss?",
      ];
    }
    if (!rx) {
      return [
        'Does finasteride help protect both my temples and crown at NW3v?',
        topical
          ? 'Am I applying minoxidil to both my temple and crown zones at NW3v?'
          : dhtShampoo ? 'Should I add minoxidil to my DHT shampoo routine at NW3v?' : 'Should I add minoxidil to both my temples and crown at NW3v?',
        specialistRecommended
          ? 'My scan flagged a specialist visit — what should I bring up about my NW3v dual-zone loss?'
          : 'How long before I see improvement in both active zones at NW3v?',
      ];
    }
    // Has Rx and some OTC
    return [
      !mechanical
        ? 'Does scalp massage help both my temple and crown zones at NW3v?'
        : !dhtShampoo
          ? (lllt ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + LLLT stack at NW3v?' : microneedling ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + microneedling stack at NW3v?' : 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + massage stack at NW3v?')
          : (lllt ? 'How do I get the most from my LLLT device across both my NW3v temple and crown zones?' : microneedling ? 'How do I time my microneedling sessions with minoxidil across both my NW3v temple and crown zones?' : 'How should I time scalp massage for both my temple and crown zones?'),
      specialistRecommended
        ? 'My scan recommended a specialist visit — what questions should I ask about NW3v?'
        : 'How long before finasteride shows results in both my NW3v zones?',
      'How do I track whether both my temples and crown are responding to treatment?',
    ];
  }
  // NW4 — frontal hairline retreat + pronounced crown thinning; dual-zone stage
  // Both zones need simultaneous treatment; questions reflect this dual-front reality.
  if (stage === 'NW4') {
    if (!hasAnyOTC && !rx) {
      return [
        'At NW4, should I be treating my frontal hairline and crown simultaneously?',
        'How long does it take to see results from minoxidil at NW4?',
        specialistRecommended
          ? 'My scan flagged a trichologist visit — should I see a specialist before starting NW4 treatment?'
          : "What's the most effective treatment stack for NW4?",
      ];
    }
    if (!rx) {
      return [
        'Does finasteride help protect both my frontal hairline and crown at NW4?',
        topical
          ? 'Am I applying minoxidil correctly across both my frontal and crown zones at NW4?'
          : dhtShampoo ? 'Should I add minoxidil to my DHT shampoo routine at NW4?' : 'Should I add minoxidil to both my frontal zone and crown at NW4?',
        specialistRecommended
          ? 'My scan flagged a specialist visit — what should I ask about NW4 treatment options?'
          : 'How long before I know if my NW4 protocol is working?',
      ];
    }
    // Has Rx and some OTC
    return [
      !mechanical
        ? 'Does scalp massage help with NW4 frontal and crown coverage?'
        : !dhtShampoo
          ? (lllt ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + LLLT stack at NW4?' : microneedling ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + microneedling stack at NW4?' : 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + massage stack at NW4?')
          : (lllt ? 'How do I get the most from my LLLT device for both my NW4 frontal and crown zones?' : microneedling ? 'How do I time my microneedling sessions with minoxidil for both my NW4 frontal and crown zones?' : 'How should I time scalp massage for both my frontal and crown zones at NW4?'),
      specialistRecommended
        ? 'My scan recommended a specialist visit — what should I ask about my NW4 protocol?'
        : 'How do I measure progress when treating both my frontal and crown zones?',
      'What results can I realistically expect from finasteride and minoxidil at NW4?',
    ];
  }
  // NW3 — deep bilateral temple recession past mid-pupil; this is the strongest treatment response window
  if (stage === 'NW3') {
    if (!hasAnyOTC && !rx) {
      return [
        'At NW3, what should I start first to stop my temple recession from deepening?',
        'How long does it take minoxidil to show results at both temple recession zones?',
        specialistRecommended
          ? 'My scan flagged a trichologist visit — should I see a specialist before starting NW3 treatment?'
          : "What's the most effective treatment stack for deep bilateral temple recession at NW3?",
      ];
    }
    if (!rx) {
      return [
        'Is finasteride worth adding at NW3 when my temples are already in deep recession?',
        topical
          ? 'Am I applying minoxidil correctly to both temple recession zones at NW3?'
          : dhtShampoo ? 'Should I add minoxidil to my DHT shampoo routine at NW3?' : 'Should I add minoxidil to both temple recession zones at NW3?',
        specialistRecommended
          ? 'My scan flagged a specialist visit — what should I bring up about my NW3 temple recession?'
          : 'How long before I see improvement in my temple recession at NW3?',
      ];
    }
    // Has Rx and some OTC
    return [
      !mechanical
        ? 'Does scalp massage improve minoxidil absorption at the temple recession edge at NW3?'
        : !dhtShampoo
          ? (lllt ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + LLLT protocol at NW3?' : microneedling ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + microneedling protocol at NW3?' : 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + massage protocol at NW3?')
          : (lllt ? 'How do I get the most from my LLLT device for my NW3 temple recession?' : microneedling ? 'How do I time my microneedling sessions with minoxidil for my NW3 temple recession?' : 'How should I time scalp massage with minoxidil for my NW3 temple recession?'),
      specialistRecommended
        ? 'My scan recommended a specialist visit — what questions should I ask about my NW3 protocol?'
        : 'How do I track whether my finasteride and minoxidil are slowing my NW3 recession?',
      'What results can I realistically expect from my protocol at NW3?',
    ];
  }
  // Generic fallback (should not be reached with a valid Norwood stage)
  if (!hasAnyOTC && !rx) {
    return [
      `What's the best first step for someone at ${stage}?`,
      'How long does minoxidil take to show results?',
      specialistRecommended
        ? 'My scan flagged a trichologist visit — should I see a specialist before starting treatment?'
        : 'What does a complete treatment stack look like for my stage?',
    ];
  }
  if (!rx) {
    return [
      `Is finasteride worth adding at ${stage}?`,
      topical ? 'How do I know if my minoxidil is working?' : 'Should I add minoxidil to my current routine?',
      specialistRecommended
        ? 'My scan flagged a specialist visit — what should I bring up with a trichologist?'
        : 'What is a realistic outcome with my current protocol?',
    ];
  }
  // Has Rx and some OTC
  return [
    !mechanical ? 'Does scalp massage actually make a difference?' : (lllt ? 'How should I time my LLLT sessions with minoxidil for maximum absorption?' : microneedling ? 'How should I time my microneedling sessions with minoxidil for maximum absorption?' : 'How should I time scalp massage with my minoxidil?'),
    specialistRecommended
      ? 'My scan recommended a specialist visit — what questions should I ask a trichologist?'
      : 'How long before my current protocol shows visible results?',
    'How do I track whether my treatment is working?',
  ];
};

// Build stage- and sex-aware photo guidance text.
// Female-pattern users need central-parting guidance, not generic overhead/hairline advice.
// Advanced AGA stages (NW5+) benefit from a reminder to capture both thinning zones in one shot.
const buildPhotoGuidance = (quality, stage, sex) => {
  if (quality === 'good') return null;
  const isFemale = stage === 'n/a (female)' || sex === 'female' || sex === 'f';
  // NW5: frontal and crown zones are nearly merged — the diagnostic key is whether the narrow
  // bridge of hair between the two loss zones is still intact. A 45° overhead angle from slightly
  // behind the hairline captures both the frontal recession and crown simultaneously, so the
  // bridge (or its absence) is clearly visible in a single frame.
  const isNearlyMerged = stage === 'NW5';
  // NW6: frontal and crown have fully merged into one bald zone — lateral fringe is the remaining
  // diagnostic area. A straight overhead shot captures the full extent of the merged bald top and
  // shows how far the lateral fringe extends inward on each side.
  const isMergedFringe = stage === 'NW6';
  // NW7: near-total top loss with only a horseshoe fringe — the fringe's density and width are
  // the key surgical-planning metrics (donor supply for FUE/FUT). A straight overhead shot with
  // the head tilted slightly back captures both the bald crown and fringe thickness simultaneously.
  const isHorseshoeFringe = stage === 'NW7';
  // NW3v: dual-zone stage (temples AND early crown) — both zones must be visible in the same frame.
  // A straight-overhead shot captures the crown but can miss temple recession depth; a too-low
  // angle captures temples but misses the crown. A 45° angle from slightly behind the hairline
  // is the best compromise for capturing both active zones simultaneously.
  const isDualZone = stage === 'NW3v';
  // NW4: frontal hairline retreat + pronounced crown thinning — another dual-zone stage.
  // Like NW3v, capturing both the frontal zone and the crown in one frame is critical.
  // A straight-overhead angle sees the crown but loses the frontal hairline shape;
  // a 45° overhead angle from slightly above and behind the hairline captures both.
  const isFrontalCrown = stage === 'NW4';
  // NW3: deep bilateral temple recession — the defining diagnostic feature is the depth and
  // symmetry of both temple corners. An angle slightly above eye level keeps both temples
  // in frame without foreshortening; avoid straight-overhead (compresses temple depth).
  const isDeepRecession = stage === 'NW3';
  // NW2: early symmetric temple recession is subtle — the M-shape is shallow and easy to miss
  // if the camera is too high (compresses the hairline) or too low (face dominates). Shooting
  // slightly above eye level with both temple corners clearly in frame is the ideal angle.
  const isEarlyRecession = stage === 'NW2';
  // NW1: fully intact hairline — no loss to measure, but this is a preventive baseline scan.
  // The most important features to capture are the hairline shape and both temple corners,
  // because the NW1→NW2 transition begins at the temple angles. A slightly-above-eye-level
  // angle that keeps the full hairline and both temple corners in frame creates the best
  // baseline for detecting any early M-shape development in future scans.
  const isIntact = stage === 'NW1';
  // diffuse: uniform thinning across the entire scalp top without a localized pattern. Unlike
  // recession stages where 45° angles help capture depth at specific zones, diffuse needs a
  // straight overhead shot to show the full distribution — any angle that cuts off the scalp
  // edges will miss how far the diffuse thinning extends. Good overhead lighting from a window
  // or lamp directly above the user helps reveal the subtle scalp visibility through the hair.
  const isDiffuse = stage === 'diffuse';
  if (quality === 'poor') {
    if (isFemale) {
      return 'For best results: part your hair down the center and hold your camera directly above your head in bright natural light near a window — the parting line and scalp top are the most diagnostically important zones for female-pattern thinning.';
    }
    if (isHorseshoeFringe) {
      return 'For best results: hold your camera directly above your head with your arm fully extended in bright natural light — a straight overhead shot captures the full bald top and the horseshoe fringe around the sides and nape. The fringe width and density are the key features at NW7, so make sure both sides of the fringe are visible in the frame.';
    }
    if (isMergedFringe) {
      return 'For best results: hold your camera directly above your head with your arm fully extended in bright natural light — a straight overhead shot shows the full extent of the bald zone across the top and how far the lateral fringe reaches on each side. Both fringe edges need to be in frame at NW6.';
    }
    if (isNearlyMerged) {
      return 'For best results: hold your camera at a 45° angle above your head in bright natural light — slightly behind the hairline so both your frontal recession and crown are visible in the same frame. At NW5, the narrow bridge of hair between the two thinning zones is the key diagnostic feature and needs to be visible to track whether merger has occurred.';
    }
    if (isFrontalCrown) {
      return 'For best results: hold your camera at a 45° angle above your head in bright natural light — slightly behind the hairline so both your frontal recession and crown thinning are visible in the same frame. At NW4 both zones are actively thinning and capturing them together gives the most accurate multi-zone reading.';
    }
    if (isDualZone) {
      return 'For best results: hold your camera at a 45° angle above your head in bright natural light — slightly behind the hairline so both your temple recession and early crown are visible in the same frame. At NW3v both zones are active and need to be captured together.';
    }
    if (isDeepRecession) {
      return 'For best results: hold your camera slightly above eye level in bright natural light so both temple recession zones are clearly in frame. At NW3, the depth and symmetry of bilateral recession is the key diagnostic feature — both temple corners need to be visible from the same angle.';
    }
    if (isEarlyRecession) {
      return 'For best results: hold your camera slightly above eye level in bright natural light so both temple corners are clearly in frame. Early M-shape recession is subtle — capturing both temples at once gives the clearest NW2 baseline.';
    }
    if (isIntact) {
      return 'For best results: hold your camera slightly above eye level in bright natural light so your full hairline and both temple corners are clearly in frame. At NW1 this creates the baseline photo — capturing the exact hairline shape and temple angles now makes early changes detectable in future scans.';
    }
    if (isDiffuse) {
      return 'For best results: hold your camera directly above your head with your arm fully extended in bright natural light (near a window or lamp directly overhead). Diffuse thinning is distributed across the entire scalp top — a straight overhead angle captures the full extent of coverage, including the edges. Part your hair slightly along the center to show the scalp surface through the hair.';
    }
    return 'For best results: hold your camera directly above your head with your arm fully extended. Use bright natural light (near a window or outdoors). Part your hair slightly so the scalp is visible, and make sure both your hairline and crown are in frame.';
  }
  // acceptable quality
  if (isFemale) {
    return 'For a more accurate scan: part your hair down the center and shoot from directly above in bright lighting — the parting line is where female-pattern thinning is most visible and measurable.';
  }
  if (isHorseshoeFringe) {
    return 'For a more accurate scan: shoot from directly overhead in bright lighting with your arm fully extended — a straight overhead frame captures the full bald top and the horseshoe fringe around the sides and nape. Make sure both sides of the fringe are visible in the shot.';
  }
  if (isMergedFringe) {
    return 'For a more accurate scan: shoot from directly overhead in bright lighting — a straight overhead shot shows the full extent of the merged bald zone and how far the lateral fringe reaches on each side. Both fringe edges should be in frame.';
  }
  if (isNearlyMerged) {
    return 'For a more accurate scan: hold your camera at a 45° overhead angle so both your frontal recession and crown are visible in the same shot — at NW5 the narrow bridge of hair between the two thinning zones is the key diagnostic feature and needs to be clearly visible.';
  }
  if (isFrontalCrown) {
    return 'For a more accurate scan: hold your camera at a 45° overhead angle so both your frontal hairline and crown are visible in the same shot — at NW4 both zones are actively thinning and a single frame that captures both gives the most accurate multi-zone assessment.';
  }
  if (isDualZone) {
    return 'For a more accurate scan: hold your camera at a 45° angle above your head so both your temple recession and early crown are visible in the same shot — NW3v has two active zones and both should be in frame.';
  }
  if (isDeepRecession) {
    return 'For a more accurate scan: shoot from slightly above eye level with both temple corners clearly in frame — at NW3 the depth of bilateral recession is the defining diagnostic feature and symmetry is best assessed when both sides are visible simultaneously.';
  }
  if (isEarlyRecession) {
    return 'For a more accurate scan: shoot from slightly above eye level with both temple corners clearly in frame — early temple recession is subtle and easier to measure when both sides are visible simultaneously.';
  }
  if (isIntact) {
    return 'For a more accurate scan: shoot from slightly above eye level with your full hairline and both temple corners clearly in frame — at NW1 the hairline shape and temple angles are the key baseline features, and capturing them clearly now makes any early change detectable in future scans.';
  }
  if (isDiffuse) {
    return 'For a more accurate scan: shoot from directly overhead in bright lighting — diffuse thinning is distributed across the entire scalp top and a straight overhead angle captures the full extent. Part your hair along the center so the scalp surface is visible through the hair.';
  }
  return 'For a more accurate scan: try shooting from a slightly higher angle in brighter lighting. Part your hair so the scalp is visible through thinning areas.';
};

// Per-month progression prompts. 3-month results in real life are subtle —
// the model must NOT overshoot to "perfect" or it stops being credible.
const PROGRESSION_PROMPTS = {
  3: `Edit this photo to show a SUBTLE 3-month treatment result. Keep face, expression, camera angle, distance to camera, head position, aspect ratio, crop/framing, lighting, skin tone, eyes, ears, clothing, and background pixel-identical to the input.

Make ONLY a small, realistic improvement that matches what a user would expect after 12 weeks of minoxidil + supplements + medicated shampoo:
- Slight thickening at the existing thinning edges (NOT in obviously bald spots — those don't fully fill in by month 3)
- Reduce visible scalp shine through hair by maybe 15–20%
- Existing miniaturized hairs at the recession boundary appear very slightly more pigmented and thicker as they begin to terminalize — do NOT add new fuzzy peach-fuzz growth in bald or empty zones; the early response is invisible-unless-comparing, not dramatic
- Hairline shape unchanged — recession edges still visible, just very slightly less sharp

DO NOT regrow lost zones to completion. DO NOT change hair color or style. CRITICAL: preserve the exact hair texture and ethnicity — do NOT straighten curly or coily hair, do NOT lighten dark hair, do NOT apply a European texture to any other hair type. CRITICAL grey/white hair: if the hair is grey, white, silver, or salt-and-pepper, the restored hair MUST match that exact shade — do NOT restore grey or white hair to a darker color. CRITICAL buzz-cut rule: if the person has a buzz cut or clipper cut (hair ≤6mm), do NOT add longer strands to show improvement — keep restored hair at the same ultra-short length; marginal density improvement at identical short length is realistic and correct. The user should think "subtle but real" — not "miracle." Most people wouldn't notice unless comparing photos side-by-side.

The result must be photorealistic and pixel-aligned with the input so it can be used as the AFTER side of a before/after slider.`,

  6: `Edit this photo to show a MODERATE 6-month treatment result. Keep face, expression, camera angle, distance to camera, head position, aspect ratio, crop/framing, lighting, skin tone, eyes, ears, clothing, and background pixel-identical to the input.

Make a clearly visible but still realistic improvement that matches what a committed user would see after 6 months of consistent treatment:
- Noticeable density gain in the thinning areas, roughly 40–50% closer to the user's natural full density
- Hairline edges look more defined and the temple recession appears partially filled with new pigmented hair
- Crown/vertex thinning area shows real coverage (not bald patch — nor full restoration)
- Hair color, length, style, and texture exactly match the original

DO NOT make it look like a completely full head of hair. There should still be some evidence of the original hair loss pattern, just clearly improved. CRITICAL: preserve the exact hair texture and ethnicity — do NOT straighten curly or coily hair, do NOT lighten dark hair, do NOT apply a European texture to any other hair type. CRITICAL grey/white hair: if the hair is grey, white, silver, or salt-and-pepper, the restored hair MUST match that exact shade — do NOT restore grey or white hair to a darker color. CRITICAL buzz-cut rule: if the person has a buzz cut or clipper cut (hair ≤6mm), do NOT add longer strands to represent 6-month growth — the restored hair must remain at the same ultra-short length; show density improvement as slightly denser short follicles within the thinning zones only. The viewer should think "real progress" — not "different person."

The result must be photorealistic and pixel-aligned with the input so it can be used as the AFTER side of a before/after slider.`,

  12: `Edit this photo to show a STRONG 12-month treatment result. Keep face, expression, camera angle, distance to camera, head position, aspect ratio, crop/framing, lighting, skin tone, eyes, ears, clothing, and background pixel-identical to the input.

Make a substantial, realistic improvement matching what a fully-compliant user might achieve after a year of treatment:
- Full natural-looking density across the previously-thin areas
- Hairline restored to a credible age-appropriate shape (NOT a teenager's hairline — match the user's age)
- Crown looks naturally full
- New hair matches the user's existing color, texture, and ethnicity exactly
- A trace of the original recession may still be visible if it was severe — most real cases never reach 100% baseline

DO NOT change hair color, style, length, or any other feature. CRITICAL: preserve the exact hair texture and ethnicity — do NOT straighten curly or coily hair, do NOT lighten or darken the hair color, do NOT apply a European or generic smooth texture to any non-European hair type. CRITICAL grey/white hair: if the hair is grey, white, silver, or salt-and-pepper, the restored hair MUST match that exact shade — do NOT restore grey or white hair to a darker color; this is a 12-month treatment result, not a youth reversal. CRITICAL buzz-cut rule: if the person has a buzz cut or clipper cut (hair ≤6mm), do NOT add longer or styled hair to represent 12-month improvement — the restored hair must remain at the same ultra-short length as the input; show density improvement as denser short follicle coverage in the thinning zones only. The viewer should think "best realistic outcome" — clearly the same person with clearly more hair.

The result must be photorealistic and pixel-aligned with the input so it can be used as the AFTER side of a before/after slider.`,
};

const THINNING_PATTERN_MAP_HINTS = {
  minimal:            'Thinning pattern: MINIMAL — use mostly teal/green across the scalp; at most faint yellow in lightly affected zones; avoid red patches.',
  bitemporal:         'Thinning pattern: BITEMPORAL — concentrate orange/red at the temples and frontal corners; mid-scalp and crown should remain teal/green.',
  crown:              'Thinning pattern: CROWN — concentrate orange/red at the crown and vertex; temples and frontal hairline may remain teal/green.',
  'bitemporal+crown': 'Thinning pattern: BITEMPORAL+CROWN — place orange/red at both the temples/frontal corners AND the crown/vertex; mid-scalp may remain moderate yellow.',
  frontal:            'Thinning pattern: FRONTAL — concentrate orange/red along the entire frontal hairline band; crown and posterior scalp may remain teal/green.',
  diffuse:            'Thinning pattern: DIFFUSE — spread red/orange uniformly across the entire scalp top without concentrating in any single region.',
  total:              'Thinning pattern: TOTAL LOSS — place red/orange across the entire scalp reflecting severe thinning in all zones.',
};

const buildAnalysisMapPrompt = (kind, result = {}) => {
  const density = Number.isFinite(Number(result.density)) ? Math.round(Number(result.density)) : 'unknown';
  const crown = Number.isFinite(Number(result.crown)) ? Math.round(Number(result.crown)) : 'unknown';
  const hairline = Number.isFinite(Number(result.hairline)) ? Math.round(Number(result.hairline)) : 'unknown';
  const densityScore  = typeof density  === 'number' ? density  : null;
  const crownScore    = typeof crown    === 'number' ? crown    : null;
  const hairlineScore = typeof hairline === 'number' ? hairline : null;
  const stage = String(result.stage || '').trim();
  const thinningPattern = String(result.thinningPattern || '').trim();

  // Build score-aware stage hints for diffuse, female-pattern, NW2, NW3, NW3v, NW4, NW5, and NW6
  // so the overlay color reflects within-stage severity rather than a one-size-fits-all static
  // description. For NW1 and NW7 the static MAP_STAGE_HINTS cover the full stage range without
  // meaningful within-stage variation worth individualising.
  let stageHint;
  if (stage === 'diffuse') {
    // Severity tiers keyed to density score:
    //   mild   (≥55): yellow/green-yellow — early diffuse; hairline intact
    //   moderate (40-54): orange/yellow — moderate uniform thinning
    //   severe  (<40): red/orange — severe diffuse; large scalp exposure
    if (densityScore !== null && densityScore >= 55) {
      stageHint = 'Show MEDIUM density (yellow and green-yellow) distributed uniformly across the entire scalp top and mid-scalp — diffuse thinning is early/mild for this user. The color should look more yellow-green than orange, reflecting that most follicles are still active. The hairline perimeter and temple geometry must remain teal/green because diffuse AGA and telogen effluvium preserve the hairline shape. Do NOT create any concentrated red patches — the defining visual of diffuse loss is uniform, low-grade thinning across the top, not focal bald zones.';
    } else if (densityScore !== null && densityScore >= 40) {
      stageHint = 'Show MEDIUM-to-LOW density (orange/yellow-orange) distributed uniformly across the entire scalp top and mid-scalp — diffuse thinning is moderate for this user. Use orange as the dominant heatmap tone with softer yellow at the periphery. The hairline perimeter and temple geometry must remain teal/green because diffuse AGA and TE always preserve the hairline shape. Keep the distribution uniform without concentrating color in any single zone — uniformity is the anatomical hallmark of diffuse loss.';
    } else {
      // densityScore < 40 or unknown (default to showing severity)
      stageHint = 'Show LOW density (red/orange) distributed uniformly across the entire scalp top and mid-scalp — diffuse thinning is severe for this user. Use red-orange as the dominant heatmap tone spread evenly across the entire scalp top without concentrating in a focal zone. The hairline perimeter and temple geometry must remain teal/green because diffuse AGA and TE preserve the hairline shape even at severe density loss. The uniform red-orange across the top is what visually distinguishes severe diffuse loss from focal NW6/NW7 bald zones.';
    }
  } else if (stage === 'n/a (female)') {
    // Ludwig severity tiers keyed to crown score (most affected zone in female-pattern):
    //   Ludwig I (crown ≥70): mild central-part widening; green-yellow at parting
    //   Ludwig II (crown 48-69): moderate crown/vertex thinning; orange/yellow
    //   Ludwig III (crown <48): severe crown/vertex loss; red/orange
    if (crownScore !== null && crownScore >= 70) {
      stageHint = 'Show MEDIUM density (yellow/green-yellow) along the central parting line and at the crown/vertex — female-pattern thinning is mild (Ludwig I) for this user; the central part is slightly wider than normal but overall crown coverage is still good. Sides, frontal hairline, and temporal zones must show HIGH density (teal/green) — female-pattern loss always spares the temporal hairline regardless of severity. Do NOT use red; the parting-line color should read as yellow or yellow-green to reflect modest mild thinning.';
    } else if (crownScore !== null && crownScore >= 48) {
      stageHint = 'Show LOW-to-MEDIUM density (orange/yellow) along the central parting line and across the crown/vertex area — female-pattern thinning is moderate (Ludwig II) for this user. Concentrate orange along the central parting axis and at the vertex. Sides and frontal hairline must remain HIGH density (teal/green) — female-pattern loss always spares the temporal hairline and sides, regardless of central-part severity.';
    } else {
      // crownScore < 48 or unknown
      stageHint = 'Show LOW density (red/orange) along the central parting line and across the crown/vertex area — female-pattern thinning is severe (Ludwig III) for this user. Use red-orange concentrated along the central parting axis and vertex/crown region. Sides and frontal hairline MUST remain HIGH density (teal/green) even at this severity — female-pattern loss always spares the temporal hairline and lateral sides regardless of how severe the central crown thinning is. This contrast (red crown/parting vs. green temples/sides) is the defining visual of female-pattern loss.';
    }
  } else if (stage === 'NW2') {
    // Temple recession severity tiers keyed to hairline score (typical NW2 range: 75–97).
    //   early      (≥88): slight bilateral temple notching → subtle yellow at corners
    //   moderate (75–87): defined angular recession → orange at both temple corners
    //   pronounced (<75): deeper recession near NW3 boundary → red/orange at corners
    if (hairlineScore !== null && hairlineScore >= 88) {
      stageHint = 'Show HIGH density (green/teal) across crown, mid-scalp, and most of the frontal area. Place only subtle YELLOW patches at both temple corners where the M-shape recession is just beginning — this user\'s NW2 is early with slight bilateral temple notching. The yellow should look like light, patchy thinning at the outer temple angles only and should not extend toward the central hairline. Do NOT use orange or red outside the corner notches — crown and mid-scalp must remain teal/green.';
    } else if (hairlineScore !== null && hairlineScore >= 75) {
      stageHint = 'Show HIGH density (green/teal) across crown and mid-scalp. Place clear ORANGE patches at both temple recession zones following the contours of the M-shape angles — this user is mid-NW2 with defined bilateral temple recession. The orange concentrates at both frontal corners and does not bleed into the mid-scalp or crown. Do NOT use red; orange reflects moderate follicle miniaturization along the recession boundary.';
    } else {
      // hairlineScore < 75 or unknown
      stageHint = 'Show HIGH density (green/teal) across crown and mid-scalp. Place RED/ORANGE patches at both temple recession zones — this user\'s NW2 recession is pronounced with deep angular notches at both frontal corners. The red/orange concentrates along the angular recession lines extending toward the mid-frontal area. Crown and mid-scalp must stay teal/green even though the temple recession is pronounced — the intact crown is what keeps this NW2 rather than NW3.';
    }
  } else if (stage === 'NW3v') {
    // NW3v vertex thinning severity tiers keyed to crown score (typical NW3v range: 55–75).
    //   early      (≥68): subtle vertex involvement → light orange at crown
    //   moderate (52–67): clearly visible crown thinning from above → orange at vertex
    //   pronounced  (<52): significant vertex loss, approaching NW4 severity → red/orange
    if (crownScore !== null && crownScore >= 68) {
      stageHint = 'Show LOW density (red/orange) at both temple recession zones. Also place LIGHT ORANGE patches at the vertex/crown area — this user\'s crown involvement is early (NW3v); the vertex is just starting to thin but coverage is still relatively reasonable. The crown orange should look softer than the temple zones to reflect the early crown stage. Mid-scalp between the temple and vertex zones should be MEDIUM density (yellow/orange).';
    } else if (crownScore !== null && crownScore >= 52) {
      stageHint = 'Show LOW density (red/orange) at both temple recession zones AND a clearly visible ORANGE zone at the vertex/crown area — this user\'s crown thinning is moderate NW3v. The crown orange should be similar in intensity to the temple zones, with scalp clearly visible through the vertex area. Mid-scalp between the temple and vertex zones should be MEDIUM density (yellow/orange).';
    } else {
      // crownScore < 52 or unknown
      stageHint = 'Show LOW density (red/orange) at both temple recession zones AND a prominent ORANGE/RED zone at the vertex/crown area — this user\'s NW3v crown thinning is pronounced, approaching NW4 vertex severity. The vertex zone may be nearly as red as the temple recession areas, reflecting significant scalp visibility at the crown. Mid-scalp between the temple and vertex zones should be MEDIUM density (yellow/orange).';
    }
  } else if (stage === 'NW3') {
    // Temple recession severity tiers keyed to hairline score (typical NW3 range: 55–72).
    //   moderate (≥65): defined bilateral recession but still within clear NW3 depth → orange
    //   pronounced (<65): deep bilateral recession approaching NW4 boundary → red/orange
    if (hairlineScore !== null && hairlineScore >= 65) {
      stageHint = 'Show HIGH density (green/teal) across crown and mid-scalp. Place clear ORANGE patches at both temple recession zones extending past mid-pupil — this user\'s NW3 recession is moderate in depth. The orange concentrates along both angular temple zones and does not extend toward the crown or mid-scalp. Crown should stay teal/green — crown thinning would indicate NW3v, not plain NW3.';
    } else {
      // hairlineScore < 65 or unknown — deep NW3 recession approaching NW4
      stageHint = 'Show HIGH density (green/teal) across crown and mid-scalp. Place RED/ORANGE patches at both deep temple recession zones — this user\'s NW3 recession is pronounced, with the recession line extending well past mid-pupil and approaching the NW4 depth boundary. The red/orange is concentrated at both angular temple zones; do NOT bleed it into the crown — the intact crown is what keeps this classified as NW3 rather than NW4. Mid-scalp should remain teal/green.';
    }
  } else if (stage === 'NW4') {
    // Combined frontal + crown severity tiers keyed to hairline score (typical NW4 range: 35–55).
    //   moderate (≥48): frontal retreat with visible band still separating zones → orange frontal + orange crown
    //   pronounced (<48): significant retreat with narrow or nearly-gone band → red frontal + red/orange crown
    if (hairlineScore !== null && hairlineScore >= 48) {
      stageHint = 'Show LOW density (orange/red-orange) across the frontal hairline zone. Show a separate ORANGE zone at the crown/vertex. A MEDIUM density band (yellow-orange) connects the frontal and crown zones — this user\'s NW4 still has a visible hair bridge, though it is thinning. Lateral sides must remain HIGH density (teal/green). Do NOT fully merge the frontal and crown red zones — a bridge is still present at this score level.';
    } else {
      // hairlineScore < 48 or unknown — significant frontal retreat, narrow bridge
      stageHint = 'Show LOW density (red) across the frontal hairline zone AND a separate LOW density (red/orange) zone at the crown/vertex. The band separating these zones is NARROW and sparse — show it as a thin stripe of orange/yellow that is visually nearly consumed by the two bald zones on either side. Lateral sides must remain HIGH density (teal/green). The two red zones should dominate the scalp top, with only a marginal separation remaining.';
    }
  } else if (stage === 'NW5') {
    // Bridge visibility severity tiers keyed to hairline score (typical NW5 range: 20–38).
    //   moderate (≥30): narrow but still-visible sparse bridge separates frontal and crown zones → dual red with orange bridge
    //   severe   (<30): bridge nearly gone; scalp top approaching one continuous bald zone → near-merged red mass
    if (hairlineScore !== null && hairlineScore >= 30) {
      stageHint = 'Show LOW density (red) at both the frontal hairline zone AND the crown/vertex zone. Between them, place a narrow ORANGE/YELLOW strip representing the sparse bridge of remaining hair — this user\'s NW5 still shows a marginal hair bridge separating the two large bald zones, though it is visibly very sparse. The bridge strip should be clearly narrow but detectable — not strong green, but not fully red. Lateral fringe must show HIGH density (teal/green). The two red zones are dominant; the orange bridge occupies only a small fraction of the scalp top.';
    } else {
      // hairlineScore < 30 or unknown — bridge nearly absent, approaching NW6 merger
      stageHint = 'Show LOW density (red) across the entire frontal and crown zones with almost no visible bridge between them — this user\'s NW5 is close to the NW6 boundary with an almost entirely continuous bald scalp top. Show only a very faint ORANGE sliver or no gap at all between the two large red zones. Lateral fringe must show HIGH density (teal/green). The scalp top should appear almost entirely red — this is the threshold appearance just short of full NW6 merger.';
    }
  } else if (stage === 'NW6') {
    // Fringe coverage severity tiers keyed to density score (typical NW6 range: 12–35).
    //   moderate (≥22): merged bald top with broader lateral fringe still well-defined → large red top, clear green fringe band
    //   advanced  (<22): merged bald top with narrower, fading fringe → large red top, thin green fringe border only
    if (densityScore !== null && densityScore >= 22) {
      stageHint = 'Show LOW density (red) across the entire merged frontal-to-crown scalp top — the two zones have fully merged at NW6. The lateral sides and nape must show HIGH density (teal/green) representing the remaining fringe hair. For this user the lateral fringe is still reasonably well-defined — show the green fringe band extending a moderate distance up from the ears and along the sides. Do NOT place any red in the lateral fringe zones. The overall visual is a large red scalp top with a clear green border around the sides and back.';
    } else {
      // densityScore < 22 or unknown — advanced NW6 with thinner, narrower fringe
      stageHint = 'Show LOW density (red) across the entire merged frontal-to-crown scalp top. At this severity level the lateral fringe is relatively thin and narrow — show it as a slender teal/green strip only at the very periphery of the sides and nape, not extending far up the sides. The overall visual is a mostly red scalp top with a narrow green border. Do NOT place any red in the fringe strip itself, but the fringe coverage is clearly limited.';
    }
  } else if (stage === 'NW7') {
    // Horseshoe fringe quality tiers keyed to density score (typical NW7 range: 8–25).
    //   moderate (≥18): near-total scalp top loss with horseshoe fringe still relatively visible → large red top, narrow but clear green horseshoe
    //   severe   (<18): near-total loss with very sparse/thinning fringe approaching total donor compromise → nearly all-red with barely-visible fringe
    if (densityScore !== null && densityScore >= 18) {
      stageHint = 'Show LOW density (red) across the entire scalp top — the frontal and crown zones are fully bare at NW7. The horseshoe fringe at the sides and nape must show HIGH density (teal/green) representing the remaining lateral and occipital donor hair — for this user the horseshoe fringe is still a relatively clear narrow band. Show the green horseshoe as a visible but narrow continuous strip along both sides and the back of the scalp. The large red scalp top dominates; the green horseshoe provides a clear but thin perimeter border. Do NOT place any red inside the horseshoe fringe zone.';
    } else {
      // densityScore < 18 or unknown — very sparse fringe, approaching total loss
      stageHint = 'Show LOW density (red) across the entire scalp top. The horseshoe fringe is very sparse and thin at this severity level — show it as a very narrow, barely-visible sliver of yellow-green at the extreme periphery of the sides and nape only. The fringe should look patchy and thin, suggesting the donor zone itself is thinning. The overall visual should be nearly entirely red with only a faint teal-green hint at the very edges. Do NOT use bright teal for the fringe at this severity — the diminished fringe reads as yellow-green or pale teal, not solid green.';
    }
  } else {
    stageHint = MAP_STAGE_HINTS[stage] || null;
  }

  const isFemaleStage = stage === 'n/a (female)';
  const isDiffuseStage = stage === 'diffuse';

  const focus = kind === 'crown'
    ? `Focus the overlay on crown and vertex thinning. Use crown score ${crown}/100, density score ${density}/100, and hairline score ${hairline}/100 as guidance.`
    : isFemaleStage
      ? `Focus the overlay on visible scalp density along the central part, crown, and mid-scalp. The frontal hairline and temples are typically preserved in female-pattern loss — do not place red or orange zones there. Use density score ${density}/100, crown score ${crown}/100, and hairline score ${hairline}/100 as guidance.`
      : isDiffuseStage
        ? `Focus the overlay on overall scalp density distributed uniformly across the entire scalp top and mid-scalp — diffuse thinning does not spare the temples or hairline. Use density score ${density}/100, crown score ${crown}/100, and hairline score ${hairline}/100 as guidance.`
        : `Focus the overlay on visible scalp density across the top, mid-scalp, temples, and hairline. Use density score ${density}/100, crown score ${crown}/100, and hairline score ${hairline}/100 as guidance.`;

  const stageSection = stageHint
    ? `\n\nStage-specific placement guide (${stage}): ${stageHint}`
    : '';

  const patternHint = THINNING_PATTERN_MAP_HINTS[thinningPattern] || null;
  const patternSection = patternHint ? `\n\n${patternHint}` : '';

  return `Edit this input scan photo into a clear clinical hair-density heatmap of the user's actual head hair. Keep the original photograph underneath completely unchanged: same person, same face, same head position, same camera angle, same distance, same crop/framing, same lighting, same background, same hair style, same hair color, same skin tone, same clothing. Do not beautify, redraw, restore, move, rotate, zoom, or replace anything in the photo.

Add only a visible translucent diagnostic heatmap overlay directly on the hair-bearing scalp region, like a premium trichology analysis screen. The heatmap must be obvious enough that the user immediately sees it is an AI-generated scalp map, not just their original photo. ${focus}${stageSection}${patternSection}

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
  topical: `Create a photorealistic premium hair-health app advice card image. Subject: close crop of a realistic scalp/top of head while a glass dropper applies topical serum to a thinning area. Add a subtle translucent violet diagnostic glow over the application zone, but no UI and no text. Style: dark luxury clinical lighting, realistic skin and hair texture, black background, shallow depth of field, expensive medical-aesthetic. Avoid brand names, logos, labels, watermarks, extra text, cartoon style, and exaggerated hair restoration.`,
  supplements: `Create a photorealistic premium hair-health app advice card image. Subject: a dark luxury still life of neutral hair supplements beside a glass of water on a black marble surface. Style: restrained medical-aesthetic, subtle violet rim light, realistic capsule shapes without identifiable logos. Avoid brand names, labels, watermarks, text, UI, messy clutter, and bright pharmacy colors.`,
  massage: `Create a photorealistic premium hair-health app advice card image. Subject: close crop of gentle scalp massage on dark hair, clean hands parting hair, healthy scalp texture visible. Style: dark premium clinical background, subtle teal/violet light, calm aspirational mood, realistic. Avoid text, logos, watermark, cartoon style, medical gore, or hands covering the entire scalp.`,
  shampoo: `Create a photorealistic premium hair-health app advice card image. Subject: matte black unbranded medicated shampoo bottle beside rich foam, water droplets, and dark hair texture on black stone. Style: dark clinical luxury, high detail, subtle violet rim light, aspirational but medical-aesthetic. Avoid people, shower nudity, text, labels, logos, watermark, UI, and generic stock-photo brightness.`,
  microneedling: `Create a photorealistic premium hair-health app advice card image. Subject: close crop of a matte-black unbranded dermaroller or microneedling device positioned above a dark-haired scalp parting, fine needles shown at the hairline with a subtle blue-violet glow at the tips suggesting follicle stimulation. Style: dark luxury clinical lighting, black background, sharp macro detail, premium medical-aesthetic. Avoid blood, visible wounds, gore, brand logos, labels, text, watermark, UI, cartoon style, or exaggerated injury.`,
  lllt: `Create a photorealistic premium hair-health app advice card image. Subject: a sleek matte-black unbranded low-level laser therapy (LLLT) laser cap or laser comb resting on a dark surface, emitting a soft red-to-infrared glow across its diode array, suggesting clinical photobiomodulation. Add a subtle warm red-rose halo around the device to convey therapeutic energy without looking garish. Style: dark luxury clinical background, black surface, restrained medical-aesthetic, macro detail on the device's diode panel, shallow depth of field. Avoid brand names, logos, identifiable product names, watermarks, text, UI, people wearing the device, exaggerated sci-fi glow, and cartoon style.`,
  consultation: `Create a photorealistic premium hair-health app advice card image. Subject: minimalist dark clinical consultation scene — a premium trichoscope lens examining a scalp parting on dark hair, or a sleek black clinical notepad and pen beside a stethoscope on a dark marble desk. Style: dark luxury medical-aesthetic, subtle violet rim light, calm confident atmosphere. Avoid visible faces, clinical white hospital rooms, brand logos, labels, watermarks, text, UI, or overly bright settings.`,
};

const normalizeAdviceKind = (kind) => (
  Object.prototype.hasOwnProperty.call(ADVICE_VISUAL_PROMPTS, String(kind || '').toLowerCase())
    ? String(kind).toLowerCase()
    : 'topical'
);

// ─── helpers ────────────────────────────────────────────────────
const requestId = () => `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// Valid Norwood stages accepted by this API.
const VALID_STAGES = new Set(['NW1', 'NW2', 'NW3', 'NW3v', 'NW4', 'NW5', 'NW6', 'NW7', 'diffuse', 'n/a (female)']);

// Compute stage-change metadata from the current scan result versus the
// caller-supplied previous stage. Returns null values when previousStage is
// absent — the iOS app only passes it after a prior scan exists.
// Computed server-side so the result never gets cached (staleChange would be
// wrong for a different caller's previousStage hitting the same cache entry).
const computeStageChange = (currentStage, previousStage) => {
  if (!previousStage || !VALID_STAGES.has(previousStage)) {
    return { stageChanged: null, stageDirection: null };
  }
  const prev = STAGE_SEVERITY_INDEX[previousStage] ?? null;
  const curr = STAGE_SEVERITY_INDEX[currentStage] ?? null;
  const changed = currentStage !== previousStage;
  const direction = (prev !== null && curr !== null)
    ? curr > prev ? 'progressed' : curr < prev ? 'improved' : 'stable'
    : null;
  return { stageChanged: changed, stageDirection: direction };
};

// Compute per-metric score deltas from the current scan versus the caller-supplied
// previousScores object. Returns null for each delta when previousScores is absent
// or the corresponding previous value is not a finite number.
// Computed server-side (not cached) because it depends on the caller's prior scores
// which vary between requests (same photo, different user).
// deltaDirection: 'improved' when delta > 0 (higher score = better hair state),
//                'declined'  when delta < 0,
//                'stable'    when delta is 0.
const computeScoreDeltas = (currentData, previousScores) => {
  if (!previousScores || typeof previousScores !== 'object') {
    return {
      hairlineDelta: null, hairlineDeltaDirection: null,
      densityDelta:  null, densityDeltaDirection:  null,
      crownDelta:    null, crownDeltaDirection:    null,
      healthDelta:   null, healthDeltaDirection:   null,
      potentialDelta:null, potentialDeltaDirection:null,
      overallDelta:  null, overallDeltaDirection:  null,
      currentStateScoreDelta: null, currentStateScoreDeltaDirection: null,
    };
  }
  const direction = (delta) => delta > 0 ? 'improved' : delta < 0 ? 'declined' : 'stable';
  const delta = (curr, prevKey) => {
    const prev = Number(previousScores[prevKey]);
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) return null;
    return Math.round(curr - prev);
  };
  const hd  = delta(currentData.hairline,          'hairline');
  const dd  = delta(currentData.density,           'density');
  const cd  = delta(currentData.crown,             'crown');
  const hld = delta(currentData.health,            'health');
  const pd  = delta(currentData.potential,         'potential');
  const od  = delta(currentData.overall,           'overall');
  const csd = delta(currentData.currentStateScore, 'currentStateScore');
  return {
    hairlineDelta:              hd,  hairlineDeltaDirection:              hd  !== null ? direction(hd)  : null,
    densityDelta:               dd,  densityDeltaDirection:               dd  !== null ? direction(dd)  : null,
    crownDelta:                 cd,  crownDeltaDirection:                 cd  !== null ? direction(cd)  : null,
    healthDelta:                hld, healthDeltaDirection:                hld !== null ? direction(hld) : null,
    potentialDelta:             pd,  potentialDeltaDirection:             pd  !== null ? direction(pd)  : null,
    overallDelta:               od,  overallDeltaDirection:               od  !== null ? direction(od)  : null,
    currentStateScoreDelta:     csd, currentStateScoreDeltaDirection:     csd !== null ? direction(csd) : null,
  };
};

// Emit a warning when an endpoint is unexpectedly slow. Thresholds are
// generous to avoid false alarms during cold Railway starts.
const SLOW_THRESHOLDS_MS = { scan: 45_000, image: 180_000, coach: 30_000 };
const WARN_LABEL_TO_METRICS_KEY = {
  'generate-after':            'after',
  'generate-progression':      'progression',
  'generate-progression-batch':'progressionBatch',
  'generate-analysis-map':     'map',
  'generate-advice-visual':    'adviceVisual',
  'analyze-scan':              'scan',
  'coach':                     'coach',
};
// Resolve any retry/slow-request label to a METRICS key. Handles the plain
// labels above and the per-month batch labels (generate-progression-3/-6/-12)
// which fan out inside /api/generate-progression-batch — those roll up under
// progressionBatch so retry counts stay attributable at the endpoint level.
const resolveMetricsKey = (label) => {
  if (!label) return null;
  const direct = WARN_LABEL_TO_METRICS_KEY[label];
  if (direct) return direct;
  if (/^generate-progression-\d+$/.test(label)) return 'progressionBatch';
  return null;
};
const warnIfSlow = (label, startedAt, kind = 'image') => {
  const elapsed = Date.now() - startedAt;
  const threshold = SLOW_THRESHOLDS_MS[kind] ?? SLOW_THRESHOLDS_MS.image;
  if (elapsed > threshold) {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'slow_request', label, elapsed, threshold }));
    const mk = resolveMetricsKey(label);
    if (mk && METRICS[mk]) METRICS[mk].slowRequests++;
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
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
  if (acceptsGzip) {
    const existingVary = res.getHeader('Vary');
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-store',
      'Vary': existingVary ? `${existingVary}, Accept-Encoding` : 'Accept-Encoding',
      ...securityHeaders,
    });
    res.end(gzipSync(data));
  } else {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...securityHeaders });
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

// Per-request read timeout. Prevents a very slow or stalled client from holding an
// open connection (and a server process) indefinitely while trickling in body bytes.
// Set REQUEST_BODY_TIMEOUT_MS in env to override; default 90s is generous for a 14MB
// photo upload even on a slow mobile connection (~1 Mbps = 112s for 14MB, but photos
// from an iOS camera are typically 1-4MB HEIC→JPEG, so 90s covers the realistic tail).
const REQUEST_BODY_TIMEOUT_MS = Number(process.env.REQUEST_BODY_TIMEOUT_MS || 90_000);

const readJsonBody = async (req) => {
  // Collect chunks as Buffers to avoid quadratic string-concatenation overhead.
  // At 14MB payload / 16KB chunks = ~900 iterations; `body += chunk` would create
  // ~900 intermediate string copies, whereas Buffer.concat does one final allocation.
  const chunks = [];
  let bytes = 0;

  let timeoutId;
  const readBody = async () => {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        const err = new Error(`Request body too large. Limit is ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB.`);
        err.statusCode = 413;
        throw err;
      }
      chunks.push(chunk);
    }
  };
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error('Request body read timed out — upload was too slow or stalled');
      err.statusCode = 408;
      reject(err);
    }, REQUEST_BODY_TIMEOUT_MS);
  });

  try {
    await Promise.race([readBody(), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }

  try {
    return JSON.parse(chunks.length ? Buffer.concat(chunks).toString('utf8') : '{}');
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
  // OpenAI 429s can be billing (quota) or pure rate-limit — distinguish them for a friendlier user message.
  const rateLimited = status === 429 && !billing;
  return {
    error: billing
      ? 'OpenAI generation is temporarily paused because billing or quota is unavailable.'
      : rateLimited
        ? 'The service is momentarily busy — please wait a few seconds and try again.'
        : contentPolicy
          ? 'This photo could not be processed. Please try a clearer, well-lit photo showing only your hair and scalp.'
          : message,
    code,
    // billing and content_policy errors are NOT retryable — they need manual intervention
    // or a different input. Only rate-limit (non-billing 429) and server errors are transient.
    retryable: !billing && !contentPolicy && (status === 429 || status >= 500),
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
        console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'openai_retry', label, reason: kind, attempt, maxAttempts, delayMs: Math.round(delay) }));
        const _mkNet = resolveMetricsKey(label);
        if (_mkNet && METRICS[_mkNet]) bumpRetry(METRICS[_mkNet], isTimeout ? 'timeout' : 'network', null);
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
    // Billing/quota errors are not transient — retrying won't help and just adds delay.
    const _errCode = payload?.error?.code || payload?.code || null;
    const _isBilling = _errCode === 'billing_hard_limit_reached' || _errCode === 'insufficient_quota'
      || /billing|quota/i.test(payload?.error?.message || payload?.message || '');
    if (_isBilling) {
      return { ok: false, status: r.status, payload };
    }
    // Respect OpenAI's Retry-After header (seconds) when present; fall back to
    // exponential backoff. Cap at 60s to avoid stalling too long on stale headers.
    const retryAfterSec = parseFloat(r.headers.get('retry-after') || '0');
    const serverDelay = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
    const delay = (serverDelay > 0 && serverDelay <= 60_000)
      ? serverDelay
      : baseDelayMs * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'openai_retry', label, status: r.status, attempt, maxAttempts, delayMs: Math.round(delay), delaySource: serverDelay > 0 ? 'server' : 'backoff' }));
    const _mkHttp = resolveMetricsKey(label);
    if (_mkHttp && METRICS[_mkHttp]) bumpRetry(METRICS[_mkHttp], r.status === 429 ? 'rate_limit' : 'upstream_5xx', r.status);
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

// Static per-metric fallbacks used when deduplicating insights (and as the weakest-metric
// guarantee fallback). Text is generic — no live score values — so these can live at
// module level and be referenced before `data` is populated.
const STATIC_METRIC_FALLBACKS = {
  Hairline: { title: 'Target recession zones',     body: 'Apply minoxidil to both temple recession zones twice daily — consistent topical coverage is the highest-ROI step for hairline improvement.',                             metric: 'Hairline' },
  Density:  { title: 'Build mid-scalp density',    body: 'Add a DHT-blocking shampoo 3× weekly followed by a 5-minute scalp massage — together these are the most cost-effective OTC tools for mid-scalp coverage.',             metric: 'Density'  },
  Crown:    { title: 'Protect the vertex now',     body: 'Apply minoxidil 1ml directly to the crown twice daily and track with monthly overhead photos — targeted coverage stabilizes vertex thinning before it advances.',         metric: 'Crown'    },
  Health:   { title: 'Optimize scalp environment', body: 'Switch to a gentle sulfate-free shampoo and add biotin and zinc — scalp health directly affects how well topicals absorb and follicles respond to treatment.',            metric: 'Health'   },
  Potential:{ title: 'Stack the right habits',     body: 'Pair minoxidil with scalp massage and a DHT-blocking shampoo — this full stack delivers the strongest 6-month OTC response while the treatment window is open.',         metric: 'Potential'},
};

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
    case 'diffuse':          return isYoung ? 'high' : 'moderate'; // young diffuse: likely TE, reversible with early action; older: cause uncertain, temper expectations
    case 'n/a (female)':     return isYoung ? 'high' : 'moderate'; // young female: hormonal correction highly effective early; older: established AGA, moderate outlook
    default:                 return 'moderate';
  }
};

// Compute how complete the user's treatment protocol is for their stage.
// Returns a 0-100 integer and a label for the iOS app to surface in a protocol card.
// Weights reflect evidence strength: Rx DHT blocker and topical minoxidil are the
// two highest-impact interventions; DHT shampoo and mechanical stimulation are
// supporting layers; supplements are the most foundational / lowest-barrier addition.
// Mechanical is split: clinical devices (LLLT or microneedling) = 15; basic massage
// only = 8. This differentiates evidence-backed devices from low-cost stimulation.
// At NW6/NW7, OTC alone cannot address the primary coverage deficit — surgical options
// are the main path — so even a perfect OTC protocol is capped at 75 to signal that
// the "missing 25" requires a specialist/surgical step, not more products.
const computeProtocolStrengthScore = (stage, protocolCoverage) => {
  if (!protocolCoverage) return { score: 0, label: 'starting' };
  const { topical, rx, dhtShampoo, mechanical, microneedling, lllt, supplements } = protocolCoverage;
  let score = 0;
  if (rx)          score += 30; // Rx DHT blocker — highest-evidence systemic layer
  if (topical)     score += 25; // Minoxidil — highest-evidence topical
  if (dhtShampoo)  score += 20; // DHT-blocking shampoo — supporting topical DHT layer
  // Clinical mechanical (LLLT or microneedling) = 15; basic massage only = 8.
  if (microneedling || lllt) score += 15;
  else if (mechanical)       score += 8;
  if (supplements) score += 10; // nutritional layer (biotin, zinc, vitamin D, saw palmetto, nutrafol, spermidine, etc.)
  // NW5: cap at 80 — even a fully complete OTC stack can't restore the near-merged frontal/crown
  // deficit; "strong" (65–84) is the realistic OTC ceiling at this stage. Prevents the iOS app
  // from showing "complete" for a score that clinical reality doesn't support.
  // NW6/NW7: cap at 75 — OTC covers the maintenance role but surgical evaluation is the
  // primary path to meaningful coverage; the capped score signals that gap to the iOS app.
  if (stage === 'NW5') score = Math.min(score, 80);
  const isAdvanced = stage === 'NW6' || stage === 'NW7';
  if (isAdvanced) score = Math.min(score, 75);
  const label = score >= 85 ? 'complete'
    : score >= 65 ? 'strong'
    : score >= 45 ? 'partial'
    : score >= 20 ? 'basic'
    : 'starting';
  return { score, label };
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

// Clamp user-supplied profile fields to prevent prompt injection and token bloat.
// All string fields are truncated; numeric fields are range-validated; arrays are
// element-capped. Legitimate iOS app values fall well within all limits.
const sanitizeProfile = (raw = {}) => {
  const s = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
  const n = (v, lo, hi) => { const x = Number(v); return (Number.isFinite(x) && x >= lo && x <= hi) ? x : null; };
  const a = (v, itemMax, count) =>
    Array.isArray(v) ? v.slice(0, count).map((item) => s(String(item ?? ''), itemMax)) : [];
  return {
    sex:      s(raw.sex,      30),
    age:      n(raw.age,      1, 120),
    concern:  a(raw.concern,  80, 6),
    timeline: s(raw.timeline, 80),
    family:   a(raw.family,   80, 6),
    lifestyle: {
      stress: n(raw.lifestyle?.stress, 0, 10),
      sleep:  n(raw.lifestyle?.sleep,  0, 24),
    },
    routine:  a(raw.routine,  100, 12),
    goals:    a(raw.goals,    100, 6),
  };
};

// Magic byte signatures for each allowed image MIME type.
// Checked against the first bytes of the decoded buffer so we catch corrupted
// or mistyped data URLs before sending them to OpenAI.
const IMAGE_MAGIC = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png':  [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
  'image/webp': null, // validated separately (RIFF....WEBP)
  'image/gif':  [0x47, 0x49, 0x46, 0x38], // GIF8 (covers GIF87a and GIF89a)
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
  const buffer = Buffer.from(m[2], 'base64');

  if (buffer.length > MAX_PHOTO_BYTES) {
    const err = new Error(`Photo too large (${Math.round(buffer.length / 1024 / 1024 * 10) / 10} MB). Please resize below ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB and try again.`);
    err.statusCode = 413;
    throw err;
  }

  // Validate magic bytes — catches corrupted uploads and MIME type mismatches
  // before they cause confusing errors from OpenAI.
  const magic = IMAGE_MAGIC[mime];
  if (magic !== null) {
    const mismatch = magic && magic.some((b, i) => buffer[i] !== b);
    if (mismatch) {
      const err = new Error(`Photo data appears corrupted — declared ${mime} but file header does not match. Please retake the photo.`);
      err.statusCode = 422;
      throw err;
    }
  } else if (mime === 'image/webp') {
    // WebP: starts with RIFF (bytes 0-3) and has WEBP at bytes 8-11
    const isWebP = buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
                && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
    if (!isWebP) {
      const err = new Error(`Photo data appears corrupted — declared image/webp but file header does not match. Please retake the photo.`);
      err.statusCode = 422;
      throw err;
    }
  }

  return { mime, buffer };
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

  // Extract pathname without query string so routing works with ?foo=bar appended
  let reqPath;
  try { reqPath = new URL(req.url, 'http://localhost').pathname; }
  catch (_) { reqPath = req.url.split('?')[0]; }

  // Suppress health-check log spam — Railway probes every ~10s creating ~720 log lines/hr
  const isHealthCheck = req.method === 'GET' && reqPath === '/api/health';

  res.setHeader('X-Request-Id', reqId);
  if (!isHealthCheck) console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'req', method: req.method, path: reqPath, reqId }));
  const origEnd = res.end.bind(res);
  res.end = (...args) => {
    const ms = Date.now() - reqStart;
    if (!isHealthCheck) console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'res', method: req.method, path: reqPath, status: res.statusCode, durationMs: ms, reqId }));
    if (req.method === 'POST') {
      const latencyKey = URL_TO_LATENCY_KEY[reqPath];
      if (latencyKey) recordLatency(latencyKey, ms);
    }
    return origEnd(...args);
  };

  // Reject new non-health requests during graceful shutdown
  if (isShuttingDown && reqPath !== '/api/health') {
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

  if (req.method === 'GET' && reqPath === '/api/health') {
    const mem = process.memoryUsage();
    const railwayEnv = process.env.RAILWAY_ENVIRONMENT_NAME || null;
    const railwayService = process.env.RAILWAY_SERVICE_NAME || null;
    json(req, res, 200, {
      ok: true,
      models: { scan: 'gpt-4o', coach: 'gpt-4o-mini', image: 'gpt-image-2' },
      port: PORT,
      sha: GIT_SHA,
      ...(railwayEnv || railwayService ? { railway: { environment: railwayEnv, service: railwayService } } : {}),
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
      metrics: Object.fromEntries(
        Object.entries(METRICS).map(([k, m]) => [k, {
          ...m,
          errorRate: m.requests > 0 ? +(m.errors / m.requests * 100).toFixed(1) : 0,
          ...(m.cacheHits !== undefined
              ? { cacheHitRate: m.requests > 0 ? +(m.cacheHits / m.requests * 100).toFixed(1) : 0 }
              : {}),
        }])
      ),
      latency: Object.fromEntries(
        Object.entries(LATENCY).map(([k, arr]) => [k, latencyStats(arr)])
      ),
      estimatedCostUSD: computeEstimatedCost(),
      requestId: reqId,
    });
    return;
  }

  if (req.method === 'GET' && reqPath === '/api/version') {
    // Enriched deploy metadata: lets operators / the iOS app correlate a live pod
    // to a specific commit + Railway deployment without opening the dashboard.
    // Fields are additive — sha and requestId are the historical shape and are
    // preserved verbatim so any existing client continues to parse cleanly.
    const railwayEnv        = process.env.RAILWAY_ENVIRONMENT_NAME    || null;
    const railwayService    = process.env.RAILWAY_SERVICE_NAME        || null;
    const railwayDeployment = process.env.RAILWAY_DEPLOYMENT_ID       || null;
    const railwayBranch     = process.env.RAILWAY_GIT_BRANCH          || null;
    const railwayCommitMsg  = process.env.RAILWAY_GIT_COMMIT_MESSAGE  || null;
    const railwayCommitFull = process.env.RAILWAY_GIT_COMMIT_SHA      || null;
    json(req, res, 200, {
      sha: GIT_SHA,
      shaFull: railwayCommitFull,
      nodeVersion: process.version,
      startedAt: new Date(SERVER_START_MS).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - SERVER_START_MS) / 1000),
      ...(railwayEnv || railwayService || railwayDeployment || railwayBranch || railwayCommitMsg
          ? { railway: {
                environment:   railwayEnv,
                service:       railwayService,
                deploymentId:  railwayDeployment,
                branch:        railwayBranch,
                commitMessage: railwayCommitMsg,
              } }
          : {}),
      requestId: reqId,
    });
    return;
  }

  if (req.method === 'POST' && reqPath === '/api/generate-after') {
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

      // NW1 = fully intact hairline with no hair loss. The prompt tells gpt-image-2 to make
      // zero changes, but model drift can still introduce subtle artifacts. Skip the API call
      // entirely when the client uses the default stage flow (no custom prompt): return the
      // original photo instantly, saving ~$0.02-0.19 and 30-300 seconds per call.
      if (!prompt && stageParam === 'NW1') {
        METRICS.after.cacheHits++;
        bumpSuccess(METRICS.after);
        console.log('[openai] generate-after NW1 passthrough (no hair loss at this stage)');
        json(req, res, 200, { afterPhoto: photoDataUrl, requestId: reqId });
        return;
      }

      const hash = cacheHashOf('after', mime, buffer.length, createHash('sha256').update(buffer).digest('hex'), effectivePrompt, quality);

      // 1. Cache hit — return instantly
      const cached = cacheRead(AFTER_CACHE, hash);
      if (cached) {
        METRICS.after.cacheHits++;
        console.log('[openai] generate-after CACHE HIT', { hash: hash.slice(0, 8), reqId });
        json(req, res, 200, { afterPhoto: cached, cached: true, requestId: reqId });
        return;
      }

      // 2. In-flight dedup — piggyback on the same OpenAI call
      let inflight = AFTER_INFLIGHT.get(hash);
      if (inflight) {
        console.log('[openai] generate-after IN-FLIGHT JOIN', { hash: hash.slice(0, 8), reqId });
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
      console.log('[openai] generate-after START', { hash: hash.slice(0, 8), mime, inputKb: Math.round(buffer.length / 1024), reqId });

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
          console.error('[openai] generate-after error', { status, reqId }, payload);
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
      bumpSuccess(METRICS.after);
      warnIfSlow('generate-after', startedAt, 'image');
      console.log('[openai] generate-after OK', { ms: Date.now() - startedAt, hash: hash.slice(0, 8), reqId });
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
  if (req.method === 'POST' && reqPath === '/api/generate-progression') {
    try {
      METRICS.progression.requests++;
      const { photoDataUrl, month, quality: qParam, stage: stageParam } = await readJsonBody(req);
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

      // NW1 = fully intact hair, no thinning zones to improve at any month.
      // The prompt instructs the model to return a pixel-identical result — skip the API call
      // entirely and return the original photo instantly.
      if (stageParam === 'NW1') {
        METRICS.progression.cacheHits++;
        bumpSuccess(METRICS.progression);
        console.log('[progression] NW1 passthrough', { month: m });
        json(req, res, 200, { afterPhoto: photoDataUrl, month: m, requestId: reqId });
        return;
      }

      // Include stage in cache key because buildProgressionPrompt interpolates it.
      // stageParam || '' ensures the key is stable when stage is omitted.
      const hash = cacheHashOf('progression', mime, createHash('sha256').update(buffer).digest('hex'), String(m), quality, stageParam || '');

      // 1. Cache hit — return instantly
      const progCached = cacheRead(PROGRESSION_CACHE, hash);
      if (progCached) {
        METRICS.progression.cacheHits++;
        console.log('[progression] CACHE HIT', { month: m, hash: hash.slice(0, 8), reqId });
        json(req, res, 200, { afterPhoto: progCached, month: m, cached: true, requestId: reqId });
        return;
      }

      // 2. In-flight dedup
      let progInflight = PROGRESSION_INFLIGHT.get(hash);
      if (progInflight) {
        console.log('[progression] IN-FLIGHT JOIN', { month: m, hash: hash.slice(0, 8), reqId });
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
      const progressionPrompt = buildProgressionPrompt(m, stageParam);
      console.log('[progression] start', { month: m, stage: stageParam || null, mime, inputKb: Math.round(buffer.length / 1024), quality, reqId });

      const progPromise = (async () => {
        const { ok, status, payload } = await withOpenAIRetry('generate-progression', (signal) => {
          const fd = new FormData();
          fd.append('model', 'gpt-image-2');
          fd.append('image', new Blob([buffer], { type: mime }), 'selfie.png');
          fd.append('prompt', progressionPrompt);
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
          console.error('[openai progression] error', { status, month: m, reqId }, payload);
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
      bumpSuccess(METRICS.progression);
      warnIfSlow('generate-progression', startedAt, 'image');
      console.log('[progression] ok', { month: m, ms: Date.now() - startedAt, hash: hash.slice(0, 8), reqId });
      json(req, res, 200, { afterPhoto: progResult.afterPhoto, month: m, requestId: reqId });
    } catch (err) {
      bumpError(METRICS.progression, err.statusCode || 500, err.message);
      console.error('[server] generate-progression error', err);
      json(req, res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/generate-progression-batch — all N months in one parallel call ─
  // Input: { photoDataUrl, months?: (3|6|12)[], quality?, stage? }
  // Output: { results: { '3': dataUrl, '6': dataUrl, '12': dataUrl }, requestId }
  // Default months = [3, 6, 12]. Runs all months in parallel → 3× faster than three sequential
  // single-month calls. Cache and in-flight dedup are shared with /api/generate-progression so a
  // batch call and a single-month call for the same photo never duplicate OpenAI work.
  if (req.method === 'POST' && reqPath === '/api/generate-progression-batch') {
    try {
      METRICS.progressionBatch.requests++;
      const { photoDataUrl, months: monthsParam = [3, 6, 12], quality: qParam, stage: stageParam } = await readJsonBody(req);
      if (!photoDataUrl) throw new Error('photoDataUrl required');

      const rawMonths = Array.isArray(monthsParam) ? monthsParam : [monthsParam];
      const months = [...new Set(rawMonths.map(Number).filter((m) => PROGRESSION_PROMPTS[m]))];
      if (!months.length) throw new Error('months must include one or more of: 3, 6, 12');

      const quality = ['auto', 'high', 'medium', 'low'].includes(qParam) ? qParam : 'high';
      const { mime, buffer } = dataUrlToBuffer(photoDataUrl);
      if (buffer.length < 3000) {
        const err = new Error('Photo appears corrupted or too small. Please retake a clearer photo.');
        err.statusCode = 422;
        throw err;
      }

      // NW1 = fully intact hair, no thinning zones to improve at any month.
      // Skip OpenAI for all requested months and return the original photo instantly.
      if (stageParam === 'NW1') {
        months.forEach(() => { METRICS.progression.requests++; METRICS.progression.cacheHits++; });
        const results = Object.fromEntries(months.map((m) => [String(m), photoDataUrl]));
        console.log('[progression-batch] NW1 passthrough', { months });
        bumpSuccess(METRICS.progressionBatch);
        json(req, res, 200, { results, requestId: reqId });
        return;
      }

      const photoHash = createHash('sha256').update(buffer).digest('hex');
      const startedAt = Date.now();
      console.log('[progression-batch] start', { months, stage: stageParam || null, mime, inputKb: Math.round(buffer.length / 1024), quality, reqId });

      // Run all requested months in parallel. PROGRESSION_CACHE and PROGRESSION_INFLIGHT are shared
      // with the single-month handler so concurrent calls for the same photo never hit OpenAI twice.
      const monthResults = await Promise.all(months.map(async (m) => {
        METRICS.progression.requests++;
        const hash = cacheHashOf('progression', mime, photoHash, String(m), quality, stageParam || '');

        const progCached = cacheRead(PROGRESSION_CACHE, hash);
        if (progCached) {
          METRICS.progression.cacheHits++;
          console.log('[progression-batch] CACHE HIT', { month: m, hash: hash.slice(0, 8) });
          return { month: m, ok: true, afterPhoto: progCached, cached: true };
        }

        let progInflight = PROGRESSION_INFLIGHT.get(hash);
        if (progInflight) {
          console.log('[progression-batch] IN-FLIGHT JOIN', { month: m, hash: hash.slice(0, 8) });
          const r = await progInflight;
          return { month: m, ...r };
        }

        const progressionPrompt = buildProgressionPrompt(m, stageParam);
        console.log('[progression-batch] generating', { month: m, hash: hash.slice(0, 8) });

        const progPromise = (async () => {
          const { ok, status, payload } = await withOpenAIRetry(`generate-progression-${m}`, (signal) => {
            const fd = new FormData();
            fd.append('model', 'gpt-image-2');
            fd.append('image', new Blob([buffer], { type: mime }), 'selfie.png');
            fd.append('prompt', progressionPrompt);
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
            console.error('[progression-batch] month error', { month: m, status, payload });
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

        if (progResult.ok) {
          cacheWrite(PROGRESSION_CACHE, hash, progResult.afterPhoto, IMAGE_CACHE_MAX);
          bumpSuccess(METRICS.progression);
          console.log('[progression-batch] month ok', { month: m, ms: Date.now() - startedAt });
        } else {
          bumpError(METRICS.progression, progResult.status || 502, progResult.error?.error || 'failed');
        }
        return { month: m, ...progResult };
      }));

      const results = {};
      const errors = {};
      for (const r of monthResults) {
        if (r.ok) {
          results[String(r.month)] = r.afterPhoto;
        } else {
          errors[String(r.month)] = normalizeOpenAIError('Generation failed', r.status, r.error);
        }
      }

      if (!Object.keys(results).length) {
        const firstErr = Object.values(errors)[0] || { error: 'All months failed' };
        bumpError(METRICS.progressionBatch, 502, 'all months failed');
        jsonError(req, res, 502, { ...firstErr, errors, requestId: reqId });
        return;
      }

      bumpSuccess(METRICS.progressionBatch);
      warnIfSlow('generate-progression-batch', startedAt, 'image');
      console.log('[progression-batch] done', { months, ms: Date.now() - startedAt, succeeded: Object.keys(results).length, failed: Object.keys(errors).length, reqId });
      json(req, res, 200, {
        results,
        ...(Object.keys(errors).length ? { errors } : {}),
        requestId: reqId,
      });
    } catch (err) {
      bumpError(METRICS.progressionBatch, err.statusCode || 500, err.message);
      console.error('[server] generate-progression-batch error', err);
      json(req, res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/generate-analysis-map — photo-locked GPT image edit overlay ─
  // Input: { photoDataUrl, kind: 'density' | 'crown', result? }
  // Output: { analysisMap: 'data:image/png;base64,...', kind }
  if (req.method === 'POST' && reqPath === '/api/generate-analysis-map') {
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
      // Include scores, stage, and thinningPattern in cache key — all three change the overlay placement.
      const scoreKey = [
        Number.isFinite(Number(scanScores.density)) ? Math.round(Number(scanScores.density)) : 'x',
        Number.isFinite(Number(scanScores.crown)) ? Math.round(Number(scanScores.crown)) : 'x',
        Number.isFinite(Number(scanScores.hairline)) ? Math.round(Number(scanScores.hairline)) : 'x',
      ].join(',');
      const stageKey = String(scanScores.stage || '');
      const patternKey = String(scanScores.thinningPattern || '');
      const hash = cacheHashOf('map', mime, createHash('sha256').update(buffer).digest('hex'), mapKind, scoreKey, stageKey, patternKey);

      // 1. Cache hit — return instantly
      const mapCached = cacheRead(MAP_CACHE, hash);
      if (mapCached) {
        METRICS.map.cacheHits++;
        console.log('[analysis-map] CACHE HIT', { kind: mapKind, hash: hash.slice(0, 8), reqId });
        json(req, res, 200, { analysisMap: mapCached, kind: mapKind, cached: true, requestId: reqId });
        return;
      }

      // 2. In-flight dedup
      let mapInflight = MAP_INFLIGHT.get(hash);
      if (mapInflight) {
        console.log('[analysis-map] IN-FLIGHT JOIN', { kind: mapKind, hash: hash.slice(0, 8), reqId });
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
      console.log('[analysis-map] start', { kind: mapKind, stage: stageKey || null, pattern: patternKey || null, mime, inputKb: Math.round(buffer.length / 1024), reqId });

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
          console.error('[analysis-map] error', { status, kind: mapKind, reqId }, payload);
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
      bumpSuccess(METRICS.map);
      warnIfSlow('generate-analysis-map', startedAt, 'image');
      console.log('[analysis-map] ok', { kind: mapKind, ms: Date.now() - startedAt, hash: hash.slice(0, 8), reqId });
      json(req, res, 200, { analysisMap: mapResult.analysisMap, kind: mapKind, requestId: reqId });
    } catch (err) {
      bumpError(METRICS.map, err.statusCode || 500, err.message);
      console.error('[server] generate-analysis-map error', err);
      json(req, res, err.statusCode || 500, { error: err.message || String(err), requestId: reqId });
    }
    return;
  }

  // ─── /api/generate-advice-visual — image-led protocol card art ─
  // Input: { kind: 'topical' | 'supplements' | 'massage' | 'shampoo' | 'microneedling' | 'lllt' | 'consultation', quality? }
  // Output: { adviceVisual: 'data:image/png;base64,...', kind }
  if (req.method === 'POST' && reqPath === '/api/generate-advice-visual') {
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
        console.log('[advice-visual] CACHE HIT', { kind: visualKind, hash: hash.slice(0, 8), reqId });
        json(req, res, 200, { adviceVisual: cached, kind: visualKind, cached: true, requestId: reqId });
        return;
      }

      let inflight = ADVICE_VISUAL_INFLIGHT.get(hash);
      if (inflight) {
        console.log('[advice-visual] IN-FLIGHT JOIN', { kind: visualKind, hash: hash.slice(0, 8), reqId });
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
      console.log('[advice-visual] start', { kind: visualKind, quality, reqId });

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
          console.error('[advice-visual] error', { status, kind: visualKind, reqId }, payload);
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
      bumpSuccess(METRICS.adviceVisual);
      warnIfSlow('generate-advice-visual', startedAt, 'image');
      console.log('[advice-visual] ok', { kind: visualKind, ms: Date.now() - startedAt, hash: hash.slice(0, 8), reqId });
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
  if (req.method === 'POST' && reqPath === '/api/analyze-scan') {
    try {
      METRICS.scan.requests++;
      const { photoDataUrl, profile: rawProfile = {}, scoringInstruction = '', previousStage: prevStageRaw = null, previousScores: prevScoresRaw = null } = await readJsonBody(req);
      // previousStage: optional Norwood stage from the user's most recent prior scan.
      // Used server-side only to annotate stageChanged/stageDirection on the response.
      // Never included in the cache key or GPT prompt so the cache stays valid.
      const previousStage = prevStageRaw && VALID_STAGES.has(String(prevStageRaw)) ? String(prevStageRaw) : null;
      // previousScores: optional score snapshot from the user's most recent prior scan.
      // Shape: { hairline, density, crown, health, potential, overall, currentStateScore }
      // Used server-side only to compute per-metric deltas; not included in the cache key.
      const previousScores = prevScoresRaw && typeof prevScoresRaw === 'object' ? prevScoresRaw : null;
      const profile = sanitizeProfile(rawProfile);
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
        console.log('[vision] CACHE HIT', { hash: scanHash.slice(0, 8), reqId });
        json(req, res, 200, { ...scanCached, ...computeStageChange(scanCached.stage, previousStage), ...computeScoreDeltas(scanCached, previousScores), cached: true, requestId: reqId });
        return;
      }

      const scanInflight = SCAN_INFLIGHT.get(scanHash);
      if (scanInflight) {
        console.log('[vision] IN-FLIGHT JOIN', { hash: scanHash.slice(0, 8), reqId });
        const scanResult = await scanInflight;
        if (scanResult.ok) {
          json(req, res, 200, { ...scanResult.data, ...computeStageChange(scanResult.data.stage, previousStage), ...computeScoreDeltas(scanResult.data, previousScores), deduped: true, requestId: reqId });
        } else {
          bumpError(METRICS.scan, scanResult.status || 502, scanResult.error?.error || 'scan failed');
          jsonError(req, res, scanResult.status || 502, { ...scanResult.error, requestId: reqId });
        }
        return;
      }

      const startedAt = Date.now();
      console.log('[vision] start', { inputKb: Math.round(visionBuffer.length / 1024), reqId });

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
        scoringInstruction ? `Scoring instruction: ${String(scoringInstruction).replace(/[\r\n\t]+/g, ' ').slice(0, 280)}` : '',
      ].join('\n');

      const sys = `You are an aesthetic hair-analysis AI for a consumer hair-loss app. Analyze the scalp photo and user profile context, then output structured JSON with these fields:
- hairline, density, crown, health, potential: 0-100 integer scores
- stage: exactly one of: NW1, NW2, NW3, NW3v, NW4, NW5, NW6, NW7, diffuse, "n/a (female)" — choose the single best match; do not output intermediate values like "NW2-NW3" or ranges
- headline: 6-9 word punchy summary, confident tone. Calibrate energy to the stage: NW1-NW2 → protective/preventive urgency (this is the best window); NW3-NW3v → action-oriented, motivating, results-focused; NW4 → committed/realistic, acknowledge the work ahead; NW5+ → frank expectation-setting, specialist-aware; diffuse/female → cause-investigation framing. Avoid hedging words like "might", "could", or "some". Never start with "Your". Vary the structure — do not repeat the same phrase across multiple scans. Example headlines by stage (use as style guides, not templates to copy verbatim): NW1 → "Intact hairline — now is the ideal protection window" or "Full hair now — protect it before change starts"; NW2 → "Early temples caught — strong response window open" or "Slight M-shape, act now for best outcome"; NW3 → "Deep temple recession, response window is real" or "NW3 — follicles still viable, act with confidence"; NW3v → "Dual-zone active — temples and crown need attention" or "NW3v: two fronts, one consistent protocol"; NW4 → "Significant loss — consistent protocol drives real gains" or "NW4 challenges real, multi-therapy still delivers"; NW5 → "Advanced loss — OTC slows it, specialist plans ahead" or "NW5 stage — targeted protocol plus transplant planning"; NW6 → "Fringe remaining — protect it, plan surgical options" or "Merged bald zones — specialist consultation is the path"; NW7 → "Near-total loss — surgical options give the best outcome" or "Horseshoe fringe — surgical consultation is the priority"; diffuse → "Diffuse thinning — root cause investigation first" or "Uniform loss signals a reversible cause — investigate now"; female → "Central thinning — hormonal workup unlocks faster progress" or "Female-pattern loss — cause-first approach works best".
- insights: exactly 3 items, each with a 5-word title (≤5 words), a 20-28 word actionable body that is specific to THIS user's visible loss pattern, scores, stage, or profile — name the actual stage or a score, specify a concrete action, and give a reason tied to their situation. CRITICAL routine rule: check "Current routine" in the user context above — if a treatment is already listed (e.g. minoxidil, finasteride, dutasteride, spironolactone, bicalutamide, flutamide, cyproterone, androcur, DHT-blocking shampoo, supplements), do NOT suggest starting it. Instead, suggest how to optimize that treatment (e.g. proper application coverage, timing, frequency) or recommend a different complementary layer. Never repeat a recommendation for something the user already does. Avoid generic advice. CRITICAL diversity rule: every insight MUST target a DIFFERENT metric — never assign the same metric value to two insights; pick the 3 most clinically relevant distinct metrics from: Hairline, Density, Crown, Health, Potential. The metric must match: Hairline→temple/frontal recession, Density→mid-scalp thinning, Crown→vertex/crown thinning, Health→scalp condition or miniaturization, Potential→treatment response or growth timeline. NW1 calibration: when stage is NW1 (fully intact), there is no visible loss to describe — frame all three insights preventively. Hairline insight: monitoring cadence to catch early M-shape (e.g. monthly front-facing photo from the same angle); Density insight: scalp-health habit that protects mid-scalp follicle caliber now (e.g. DHT-blocking shampoo contact time, scalp massage frequency); Crown insight OR Health insight: nutritional or topical layer that extends the fully-intact window. Reframe every metric as "protect what's there" not "restore what's lost". TE/stress calibration for insights: when Stress ≥ 7/10 or Sleep ≤ 5h in the user context AND stage is 'diffuse' or 'n/a (female)' (uniform thinning without M-shape recession), dedicate at least one insight — preferably Health metric — to the TE root cause: frame it as "Stress ≥ 7 with diffuse thinning suggests TE — typically reverses within 3-6 months once the stressor is managed; prioritize sleep and stress reduction alongside topicals." or "Sleep ≤ 5h is a recognized TE trigger — restoring 7-8h sleep is the highest-leverage action alongside topicals for diffuse loss." Body must be 20-28 words. Do NOT apply this to NW1-NW7 AGA stages with clear temple or vertex recession.
- verdict: 1-2 sentence verdict, no medical claims. Calibrate tone to stage: NW1-NW2 → protective and preventive opportunity (e.g. "Your follicles are fully intact — this is the best window to build the habits that keep them that way."); NW3-NW3v → motivating and results-focused (e.g. "Deep recession at this stage responds strongly to a consistent topical + DHT approach — the response window is genuinely open."); NW4 → realistic but forward-looking (e.g. "Significant loss has progressed, but consistent multi-therapy still produces real, measurable gains at this stage."); NW5 → frank with a concrete path (e.g. "OTC treatment can meaningfully slow further loss — pairing it with a transplant consultation now gives the most complete long-term strategy."); NW6-NW7 → specialist-aware and candid (e.g. "Surgical options — FUE/FUT or SMP — are the most realistic path to meaningful coverage at this stage."); diffuse/female → cause-investigation-first (e.g. "Identifying and addressing the underlying cause is the highest-impact step — topicals work best once the root driver is managed."). Never start with "Your". Slightly aspirational where the stage allows it.
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

Thinning pattern discriminator — use when adjacent patterns are ambiguous:
- minimal vs bitemporal: Assign minimal ONLY when the hairline shows no recession and both temples are fully intact. Any M-shape deepening, angular notch, or even subtle temple asymmetry → bitemporal minimum.
- bitemporal vs bitemporal+crown: Assign bitemporal when ONLY the temple recession is visible and the crown is fully intact from above. If ANY independent thinning is visible at the vertex/crown — even subtle — assign bitemporal+crown.
- crown vs bitemporal+crown: Assign crown ONLY when the temples are clearly intact with no M-shape recession. If any temple recession co-exists with crown thinning → bitemporal+crown.
- frontal vs bitemporal: frontal = hairline retreating evenly across the full width without a distinct M-shape or sharp temple angles. bitemporal = clear bilateral angular recession at both temple corners. If the recession forms visible corner notches → bitemporal; if it's a uniform straight-line retreat → frontal.
- frontal vs diffuse: frontal = hairline retreating at the front, mid-scalp and crown largely intact. diffuse = uniform thinning distributed across the entire scalp top with the hairline mostly preserved. If the top is uniformly thin AND the hairline has some frontal retreat, prefer diffuse.
- diffuse vs total: total applies ONLY when multiple large consolidated bald areas are visible (equivalent to NW6+). diffuse means thinning throughout but no large bald patches. If large patches exist → total. NW5 still retains a narrow sparse bridge between the frontal and crown bald zones — assign bitemporal+crown, NOT total, for NW5 (total is NW6+ where that bridge is fully gone).
- n/a (female): Use for female-presenting patients regardless of pattern — Ludwig classification applies mentally but output the Norwood thinningPattern enum value that best describes the visible zone (diffuse for Ludwig I-II, total for Ludwig III).

Stage-thinningPattern consistency — apply after assigning both stage and thinningPattern independently:
- NW1 has no recession and no thinning — thinningPattern MUST be minimal.
- NW2 is defined by slight symmetric temple recession — thinningPattern MUST be bitemporal (not minimal; there IS visible recession at NW2 by definition, it just isn't deep yet).
- NW3 is defined by deep bilateral temple recession without crown involvement — thinningPattern MUST be bitemporal. Crown is intact at NW3 (that is what distinguishes NW3 from NW3v); do NOT assign bitemporal+crown to NW3.
- NW3v is defined by simultaneous temple recession AND early crown thinning — thinningPattern MUST be bitemporal+crown; if independent pattern assessment returned only bitemporal, re-examine the vertex and correct to bitemporal+crown.
- NW4 has both frontal and pronounced crown thinning — thinningPattern should be bitemporal+crown (not bitemporal alone). If crown is somehow unaffected at NW4, double-check the stage assignment.
- NW5 has extensive frontal and crown loss with a narrow, sparse bridge of hair still separating the two zones — thinningPattern MUST be bitemporal+crown (NOT total; the bridge distinguishes NW5 from NW6). Only assign total at NW6+, where the bridge has fully disappeared.
- NW6 and NW7 have fully merged frontal and crown bald zones — thinningPattern MUST be total.
- stage=diffuse → thinningPattern MUST be diffuse.
- stage=n/a (female) → thinningPattern MUST be diffuse (Ludwig I-II) or total (Ludwig III severe).

PHOTO QUALITY ASSESSMENT:
good — scalp clearly visible, well-lit, shot from above or ~45° angle, can see hairline + crown.
acceptable — lighting or angle is suboptimal but loss pattern is still assessable; also use 'acceptable' for wet or heavily-styled hair where the pattern is visible but density may be temporarily distorted by clumping (note it in photoNote).
poor — too dark, heavily blurred, shot straight-on (forehead/face only, no scalp visible), or the image doesn't contain a person's hair/scalp at all.

For poor-quality photos: acknowledge uncertainty in the verdict and photoNote. Score based on what IS actually visible — do NOT default everyone with a poor photo to the same range. Examples:
- If hair looks clearly full/healthy in the photo despite bad lighting → hairline/density/crown/health in 75-90 range with appropriate uncertainty noted.
- If meaningful thinning is clearly visible even in bad conditions → score it lower based on what you can see.
- If the scalp is completely invisible (wrong subject, total darkness, forehead-only) → score all fields 62-70 and mark photoNote with the specific issue.
The 62-76 midpoint is only for genuine uncertainty when the scalp state truly cannot be assessed.

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
- NW1 vs NW2: Assign NW1 only when the hairline sits at or above the upper forehead crease with completely symmetric temples and no frontotemporal angle widening. Any visible M-shape deepening, angular notch at either temple, or even subtle asymmetry → NW2 minimum.
- NW2 vs NW3: If temple recession extends PAST the mid-pupil vertical line, assign NW3. If it barely reaches or falls short of midpupil, assign NW2.
- NW3 vs NW4: If a clear forelock mass still covers the central frontal scalp (even with deep temple recession), assign NW3 or NW3v. Once the frontal hairline itself has retreated past mid-scalp, assign NW4.
- NW3 vs NW3v: Assign NW3v (not plain NW3) only when vertex/crown thinning is independently visible as a SEPARATE thinning zone distinct from the temple recession. Crown-invisible caveat: When the photo is front-facing and the vertex/crown is not visible in the frame, the model cannot directly confirm or rule out vertex involvement. In that case, classify as NW3 by default — BUT if the user's 'Concerns' field explicitly includes any of the following keywords (crown, vertex, top, back of head, bald spot on top, thinning on top, losing on top, hair on top, thin on top, spot on top, bald on top), prefer NW3v over plain NW3. Self-reported crown concern at an otherwise NW3-consistent temple recession depth is a reliable indirect signal for early vertex involvement that the photo angle cannot capture. Do NOT apply this override when crown thinning is clearly absent in a photo that does show the top of the scalp.
- NW4 vs NW5: If the bridge of hair connecting the forelock to the sides is a visible full-width band, assign NW4. If that bridge is sparse, narrow, or nearly gone, assign NW5.
- NW5 vs NW6: If even a sparse band of tissue still separates the frontal and crown bald zones, assign NW5. If the two zones have fully merged with no separation at all, assign NW6.
- NW6 vs NW7: Assign NW7 only when the entire scalp top is essentially bare and only a narrow horseshoe-shaped fringe along the sides and nape remains — and even that fringe is thinning or sparse. If a meaningful lateral fringe still offers substantial coverage on both sides connecting to the back, assign NW6. NW7 means even the horseshoe fringe is compromised; the defining feature is that virtually no usable donor-zone width remains on top.
- diffuse vs NW1/NW2/NW3 (male): The critical distinguisher is temple geometry. NW stages (NW1–NW7) are driven by androgenic M-shape recession — the hairline retreats at the temple corners specifically, producing visible angular notches or frontotemporal angles. Diffuse AGA (and telogen effluvium) preserves the frontal hairline position and temple shape while thinning uniformly across the scalp top, mid-scalp, and crown. Assign 'diffuse' when: (a) the hairline is intact with no M-shape angles AND (b) thinning is distributed broadly across the scalp without a focal recession zone. Assign NW2 or NW3 (not 'diffuse') whenever even subtle bilateral temple angle deepening is visible alongside the overall thinning — an M-shape, however early, rules out 'diffuse'. Stress/TE context: when Stress ≥ 7/10 or Sleep ≤ 5h appears in the user profile and the thinning is diffuse and uniform with no temple recession, strongly prefer 'diffuse' over NW2 — telogen effluvium presents as diffuse shedding, not focal temple recession.
- n/a (female) vs any Norwood stage: If Sex in the user context is 'female', 'f', 'woman', or any recognizable feminine variant, ALWAYS output stage 'n/a (female)'. Never assign NW1-NW7 or 'diffuse' to a female-presenting user — the Ludwig scale applies mentally but the output stage is always 'n/a (female)'. If sex is unspecified but the photo clearly shows a female-presenting patient (long styled hair, feminine hairline shape without M-recession, female facial features), default to 'n/a (female)'.
- diffuse vs n/a (female): 'diffuse' as a stage applies ONLY to male users (or sex-unspecified users) who show uniform thinning without a classic recession pattern — e.g. telogen effluvium, diffuse AGA in a male patient. Do NOT assign 'diffuse' to a female user; use 'n/a (female)' instead. A female user whose loss looks diffuse should get stage 'n/a (female)' with thinningPattern 'diffuse', not stage 'diffuse'.

Scoring guide (all scores 0-100 integers):
- hairline: 100 = fully intact hairline, no recession. Deduct for temple recession depth/width, frontal loss. Stage-correlated ranges: NW1→90-100, NW2→75-88, NW3→55-72, NW3v→55-72 (same temple recession depth as NW3; vertex thinning that defines NW3v does not affect the hairline position or temple recession depth — score within the NW3 hairline range), NW4→35-55, NW5→20-38 (frontal and crown nearly merged, minimal forelock), NW6→10-25 (frontal and crown merged; only lateral fringe; hairline score reflects fringe height), NW7→5-18 (horseshoe fringe only; near-total frontal loss), diffuse→65-88 (diffuse thinning preserves the hairline position and temple shape — the key distinguisher from NW2/NW3 is the ABSENCE of M-shape temple recession; score 78-88 when the hairline is fully intact with no visible temple angle; score 65-78 when mild frontal density reduction is visible but the temple geometry remains non-angular), n/a (female)→72-95 (female-pattern hair loss almost always spares the frontal hairline — score 82-95 when the hairline is fully intact regardless of crown/part thinning; score 72-82 only if diffuse frontal hairline thinning is clearly visible, e.g. Ludwig III frontal type).
- density: 100 = full terminal hair density with no scalp visible through hair. Deduct for mid-scalp see-through, diffuse thinning, miniaturization. Stage-correlated ranges: NW1→88-100, NW2→80-95, NW3→65-82 (reduce by 5-15 more if visible mid-scalp thinning alongside the recession), NW3v→58-78 (early vertex thinning at NW3v typically coincides with some mid-scalp density reduction; default to the lower half of the NW3 range; reduce toward 55-65 if visible mid-scalp see-through or miniaturization is present alongside the temple recession), NW4→45-68, NW5→30-52, NW6→12-35 (large bald top; only lateral fringe provides density), NW7→8-25 (near-total top loss; fringe hairs may be thin themselves), diffuse→35-65 (depends on coverage uniformity), n/a (female)→30-78 (Ludwig I mild central-part widening→65-78; Ludwig II moderate diffuse thinning→48-65; Ludwig III severe thinning→30-48; score based on how much scalp is visible through the central part and crown region). If the photo is a straight-on face shot where mid-scalp isn't visible, estimate from stage. Hair color calibration: scalp visibility through light-colored hair (blonde, grey, white, silver) is naturally higher than through dark hair at the same actual density level. Assess coverage by estimating the percentage of scalp that has hair over it, not purely by how much bare scalp shows through — a person with grey or blonde hair whose strands cover 90% of the scalp zone should score similarly to a dark-haired person with the same coverage. Do not deduct density points simply because scalp is more visible through lighter hair pigment. Very short hair calibration: hair cut to ≤6mm (buzz cut, #1-#2 clipper guard, or machine shave) will naturally show significant scalp visibility between follicles because there is no shaft length to bridge the gaps — this is a physical consequence of hair length, not a sign of thinning. For very short hair, assess density by evaluating the uniformity of follicle distribution across the scalp top; score 78-95 for a uniform clipper cut with no visible bald patches or density differential between zones. Do not deduct density points because a buzz cut shows more scalp than the same person with longer hair would. Wet hair / styling product calibration: wet hair (post-shower, post-swim) and hair loaded with gel, pomade, wax, or heavy mousse clumps into rope-like groups of strands, exposing scalp between the clumps even when follicle density is healthy. This can make density appear 10-20 points lower than it actually is. When wet-hair texture (dark, slick, strand-clumping with visible wet shine) or heavy-product clumping is visible, assess density from the uniformity and coverage of follicle groups across the scalp zone rather than from raw scalp-show-through between wet clumps. Do not deduct density points solely because wet or product-heavy clumping reveals scalp between strand groups; use the visible follicle distribution to estimate what dry coverage would look like. Always note the wet/styled condition in photoNote and recommend the user retake the photo with dry, unstyled hair for the most accurate reading. Hair building fiber / concealer calibration: cosmetic density products — keratin fiber sprays (Toppik, Caboki, Bumble and bumble Fill-In Powder, Boldify, Nanogen), scalp concealers (DermMatch), and spray-on root concealers — add artificial bulk to sparse zones, making density appear significantly higher than the actual underlying follicle coverage. Visual signs of fiber product use: unusually even or thick coverage in zones where the assessed Norwood stage predicts visible scalp; fine speckling, powdery, or gritty texture visible on the scalp surface or near hair roots; or density that looks inconsistent with the degree of recession or hairline loss visible at the scalp edge. When fiber or concealer use is strongly suspected: (a) score density 15–25 points lower than the raw photo appearance to estimate actual underlying follicle coverage; (b) rate photoQuality as 'acceptable'; (c) note the suspected fiber/concealer use in photoNote and recommend a retake on dry, product-free scalp for accurate scores. Flash photography / overexposure calibration: direct smartphone flash at close range creates a bright overexposed area on the scalp surface that artificially inflates scalp visibility between hairs, making density appear 10–20 points lower than the actual underlying follicle coverage. Visual signs of direct flash: a central or circular overexposed bright patch where the scalp looks unnaturally white or washed out between hair strands; strong specular highlights along individual hair shafts; surrounding hair zones appear darker by contrast. When direct-flash overexposure is visible on the scalp, assess density from follicle distribution uniformity across the zone rather than from raw scalp-show-through in the overexposed area. Do not deduct density points for flash-induced glare; rate photoQuality as 'acceptable' and note the flash lighting condition in photoNote, recommending the user retake in natural or diffuse indoor lighting for the most accurate reading. Scalp-skin contrast calibration: scalp visibility between hair strands is affected by the contrast between hair color and skin tone. Users with dark hair against pale or light skin (Fitzpatrick types I–II) show high scalp-hair contrast — individual strands are sharply delineated against a bright scalp surface, making inter-strand gaps more visually prominent even at moderate underlying density. Users with dark hair against darker skin tones (Fitzpatrick types IV–VI) show lower scalp-hair contrast — inter-strand gaps are less visually prominent even at similar underlying coverage levels. When assessing density for high-contrast (pale skin + dark hair) users: assess coverage from follicle spacing uniformity across the scalp zone rather than raw scalp-show-through, and do not penalize density solely because high contrast makes individual gaps more visible. For lower-contrast (dark skin + dark hair) users: do not inflate density scores based on reduced visible scalp — assess follicle coverage patterns the same way. The goal is an equitable density score that reflects actual follicle count and coverage uniformity, independent of skin-hair color contrast.
- crown: 100 = full vertex/crown coverage from above. Stage-correlated ranges: NW1→90-100, NW2→87-100, NW3→82-97 (crown should be intact unless NW3v), NW3v→55-75 (early vertex thinning distinguishes this stage), NW4→35-58, NW5→18-40, NW6→5-20 (crown fully merged with frontal zone; essentially no vertex coverage), NW7→2-12 (complete vertex absence; only narrow horseshoe fringe survives), diffuse→32-72 (crown involvement varies with severity; mild diffuse AGA with intact vertex coverage→60-72; moderate diffuse with visible scalp through the vertex and crown zone→45-60; severe diffuse with widespread vertex thinning and large exposed crown area→32-45), n/a (female)→22-88 (Ludwig I: crown mostly intact, only the part line is wider→72-88; Ludwig II: crown thinning visible from above→48-72; Ludwig III: severe vertex and crown loss with large exposed area→22-48). If crown IS visible in the photo, score directly from what you see. If not, use the stage estimate. Flash photography / overexposure calibration from above: direct smartphone flash aimed at the top of the scalp creates a central overexposed bright patch in overhead shots that makes the bare crown area appear larger than it actually is — the overexposed zone looks unnaturally white or washed out, and the boundary between covered and bare scalp may fade into the bright flash zone rather than showing a sharp, clean edge. This can make crown coverage appear 5-15 points lower than the actual underlying follicle coverage. When a central overexposed bright patch is visible in an overhead shot, assess the covered-to-bare boundary from the follicle distribution visible at the edges of the bright region — do not use the apparent size of the overexposed zone itself as the bald area boundary. Do not deduct crown points for flash-induced glare in overhead shots; rate photoQuality as 'acceptable' and note the flash lighting condition in photoNote, recommending the user retake from the same overhead angle in natural or diffuse indoor lighting for the most accurate reading.
- health: 100 = thick terminal hairs at normal caliber, healthy scalp, no miniaturization or inflammation. Deduct for: visible miniaturization (fine, short hairs at the thinning edge) −10 to −20; scalp inflammation or redness −5 to −15; visible flakiness or dandruff −5 to −10; widespread vellus hairs replacing terminal hairs −10 to −20. Health is NOT determined by hairline position — a NW4 with thick terminal hairs and healthy scalp can score high on health. Stage-correlated baseline ranges (adjust up/down based on visible scalp condition): NW1→82-100, NW2→75-95, NW3→65-85, NW3v→60-82, NW4→55-80 (still high if remaining hair is thick and scalp healthy), NW5→45-70, NW6→38-62 (lateral fringe may still be healthy terminal hair), NW7→30-55 (even fringe hairs may be finer at this stage), diffuse→35-70 (cause-dependent; often inflammatory or nutritional), n/a (female)→45-78 (often nutritional/hormonal; health improves when root cause treated). Stress/TE calibration: when Stress ≥ 7/10 in the user profile context and the visible pattern is diffuse uniform thinning without discrete miniaturization (individual hairs look normal in shaft thickness despite widespread shedding), telogen effluvium (TE) is likely co-driving or primarily causing the loss alongside AGA. TE preserves individual follicle shaft caliber — the follicles themselves are healthy, only the growth cycle timing is disrupted. When Stress ≥ 7 and diffuse thinning appears with normal-looking individual shaft thickness, score health toward the upper end of the diffuse or n/a(female) range (55-70 for diffuse, 62-78 for female pattern) because underlying follicle integrity is intact; do NOT apply miniaturization deductions unless visibly finer vellus hairs are present. Likewise, if Sleep ≤ 5h and a diffuse shedding pattern is visible, apply the same lenient health calibration (chronic sleep deprivation is a recognized TE trigger). Grey/white hair calibration: grey and white hair is naturally slightly finer in shaft diameter than pigmented hair — this is a normal age-related characteristic, not miniaturization. Deduct health points for miniaturization only when there is a visible contrast between clearly full-caliber hairs and noticeably shorter, wispier vellus hairs in the same zone. Do not automatically penalize older users with uniformly grey or white hair for the natural fineness of depigmented strands. Very short hair calibration: with a buzz cut or clipper cut (≤6mm), all terminal hairs appear short and may look similar in caliber to vellus hairs simply because they are trimmed close to the scalp. Score miniaturization only when there is a visible spatial contrast — areas where hairs are clearly shorter, wispier, or sparser than the surrounding uniformly-trimmed hairs (not when the entire cut is uniformly short). Do not deduct health points for a uniform clipper cut where all hairs appear identically trimmed at the same length with no visible density differential. Hair building fiber / concealer calibration: keratin fibers and scalp concealers coat the hair shaft and scalp surface, making miniaturization assessment unreliable in covered zones — fine or vellus hairs are hidden beneath the fiber coating. When fiber products are suspected (see density calibration above), do not apply aggressive miniaturization deductions to zones that appear covered; note in photoNote that health/miniaturization assessment may be imprecise in product-covered areas. Flash photography / overexposure calibration: direct smartphone flash overexposes the scalp surface and washes out fine hair shaft detail, making individual full-caliber terminal hairs appear thinner or more vellus-like than they actually are. This is an optical artifact of overexposure, not genuine miniaturization. Do not apply miniaturization deductions based on apparent shaft thinning in flash-overexposed zones; if flash signs are present (see density calibration above), note the flash condition in photoNote and treat miniaturization assessment in overexposed zones as unreliable.
- potential: realistic percentage improvement achievable with a consistent 6-12 month treatment protocol (OTC or Rx already in the user's "Current routine"). Score what is ACHIEVABLE — not the current state. If "Current routine" contains any Rx antiandrogen — finasteride, dutasteride, spironolactone, bicalutamide, flutamide, cyproterone, or androcur — these drugs substantially improve outcomes at every stage by blocking androgen-driven follicle miniaturization; treat their presence as meaningful upward pressure on potential. Use these stage×age guidelines:
  • NW1, any age: 75-90 (fully intact scalp; preventive stage; strong potential to preserve density and prevent NW2 transition with a consistent protocol)
  • NW2, under 30: 80-92 (earliest visible recession; follicles just beginning to miniaturize; highest treatment response window at this stage — consistent minoxidil + DHT suppression typically produces meaningful temple-corner filling)
  • NW2, age 30-50: 74-86 (strong treatment response window; meaningful temple recession filling expected with a consistent topical + DHT suppression protocol)
  • NW2, over 50: 65-78 (OTC response still clinically meaningful; lower recovery ceiling than younger users; Rx antiandrogens add meaningful upward pressure at this stage)
  • NW3, under 35: 70-85 (single-zone temple recession; strong responders; significant regrowth expected)
  • NW3, age 35-54: 60-76 (good gains with consistency; moderately responsive)
  • NW3, over 54: 50-66 (meaningful improvement still expected; longer treatment timeline)
  • NW3v, under 35: 64-79 (dual-zone: temples + early crown; highly responsive but two zones to recover)
  • NW3v, age 35-54: 54-70 (dual-zone stage; consistent gains expected; early crown raises treatment complexity)
  • NW3v, over 54: 44-62 (dual-zone with age; realistic gains with Rx and minoxidil; manage expectations accordingly)
  • NW4, under 40: 55-70 (meaningful improvement still achievable)
  • NW4, over 40: 42-58 (maintenance priority; modest regrowth in best cases)
  • NW5, any age: 28-48 (OTC slows progression; realistic expectations needed)
  • NW6-NW7, any age: 15-32 (very limited OTC benefit; transplant/SMP discussion)
  • diffuse, under 35: 62-78 (more likely telogen effluvium or early hormonal — highly reversible if nutritional/stress cause is identified and treated; follicle quality typically preserved)
  • diffuse, age 35-54: 55-70 (mixed TE/early AGA pattern; good response when root cause is found; treat hormonal or nutritional triggers aggressively)
  • diffuse, over 54: 48-65 (AGA-driven diffuse thinning more likely; score toward lower end without confirmed reversible cause; hormonal Rx still meaningful)
  • n/a (female): age-agnostic Ludwig sub-ranges — Ludwig I mild central-part widening→65-78, Ludwig II moderate diffuse thinning→55-65, Ludwig III severe thinning→45-58; infer Ludwig severity from the crown/density scores already assigned above — crown 72-88 → Ludwig I, 48-72 → Ludwig II, 22-48 → Ludwig III
  Upward adjustments (+5 to +10): age under 28, loss duration under 1 year, no family history of NW6+, already responding to current treatment, currently on any Rx antiandrogen — finasteride or dutasteride (male 5-alpha-reductase inhibitors), spironolactone (primary Rx androgen blocker for female-pattern thinning), or second-line antiandrogens bicalutamide, flutamide, cyproterone, or androcur (all carry the same strong upward pressure on potential because they suppress androgen-driven follicle miniaturization; use at the same +6 to +10 level) (+6 to +10 on top of stage baseline — apply this adjustment for any user whose "Current routine" lists any of these Rx drugs; use the high end of this range for consistent 6+ month use).
  Downward adjustments (−5 to −8): age over 60, family history of NW6+, loss for 10+ years untreated, visible miniaturization across entire top.
  Stress/TE upward adjustment: when Stress ≥ 7/10 in the user context AND the stage is 'diffuse' or 'n/a (female)', apply +5 to +8 on top of the stage baseline — high-stress telogen effluvium is typically fully reversible when the stressor is managed; follicle quality is preserved and recovery potential is meaningfully higher than for chronic AGA at the same coverage level. Apply the same +5 to +8 if Sleep ≤ 5h with a diffuse pattern (sleep deprivation is a recognized TE trigger with similar reversibility). Do not apply this adjustment to NW1-NW7 AGA stages where the M-shape or vertex loss pattern indicates androgen-driven follicle miniaturization rather than a reversible growth-cycle disruption.
  Age unspecified: use the median bracket for each stage (NW2 → apply the 30-50 range; NW3 → apply the 35-54 range; NW3v → apply the 35-54 range; NW4 → apply the over-40 range; NW5+ → any-age range; diffuse → apply the 35-54 range); skip all age-specific upward or downward adjustments; do NOT guess or infer an age penalty when age is absent.
  photoQuality does not affect potential: score potential from stage×age×routine context alone regardless of photoQuality — poor or acceptable photos reduce confidence in hairline/density/crown/health assessment only, never in the forward-looking treatment-response potential.
  Potential is NOT the same as current health — a NW4 with good hair health can still score 55+ potential because the follicles are viable.
  No-treatment baseline: when "Current routine" is empty or lists nothing, the user has not yet started treatment. This is a HIGH-potential scenario — any consistent evidence-based protocol will produce improvement from this baseline. Do NOT penalize potential because the user hasn't started yet; if anything, an untreated user at a given stage has MORE upside than a treatment-resistant user at the same stage. Score toward the higher end of the stage range when no treatment is listed, because the first treatment cycle typically delivers the largest gain.
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
              { type: 'image_url', image_url: { url: photoDataUrl, detail: 'high' } },
            ],
          },
        ],
        temperature: 0.15,
        max_tokens: 1800,
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
          console.error('[openai vision] error', { status: scanStatus, reqId }, scanPayload);
          return { ok: false, status: scanStatus, error: normalizeOpenAIError('Vision request failed', scanStatus, scanPayload) };
        }

        const scanChoice = scanPayload.choices?.[0];
        const finishReason = scanChoice?.finish_reason;
        if (finishReason === 'length') {
          console.warn('[vision] response truncated by max_tokens — JSON may be incomplete');
        }
        // Structured-output refusals land in message.refusal (not message.content); a
        // content_filter finish_reason means the response was blocked entirely. Both
        // produce null/empty content which, without this guard, JSON.parse('{}') silently
        // turns into all-zero scores — a confusing result for the user.
        if (scanChoice?.message?.refusal) {
          console.warn('[vision] model refused (structured output refusal):', scanChoice.message.refusal);
          return { ok: false, status: 422, error: { error: 'This photo could not be processed. Please try a clearer, well-lit photo showing only your hair and scalp.' } };
        }
        if (finishReason === 'content_filter') {
          console.warn('[vision] response blocked by content_filter');
          return { ok: false, status: 422, error: { error: 'This photo could not be processed due to content guidelines. Please try a different, well-lit scalp photo.' } };
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
        // Deduplicate insight metrics: if two insights share the same metric, replace the
        // lower-priority one (highest index = lowest priority) with a static fallback
        // targeting an uncovered metric. Runs before the weakest-metric guarantee so
        // both fixes operate on the same array without conflicting.
        {
          const _allMetrics = ['Hairline', 'Density', 'Crown', 'Health', 'Potential'];
          const _usedMetrics = new Set(rawInsights.map((ins) => ins.metric));
          if (_usedMetrics.size < rawInsights.length) {
            const _uncovered = _allMetrics.filter((m) => !_usedMetrics.has(m));
            let _uncovIdx = 0;
            for (let _i = rawInsights.length - 1; _i >= 1 && _uncovIdx < _uncovered.length; _i--) {
              const _isDup = rawInsights.slice(0, _i).some((ins) => ins.metric === rawInsights[_i].metric);
              if (_isDup) {
                const _tgt = _uncovered[_uncovIdx++];
                rawInsights[_i] = STATIC_METRIC_FALLBACKS[_tgt] ?? rawInsights[_i];
                _usedMetrics.add(_tgt);
              }
            }
          }
        }
        const stageRaw = String(parsed.stage || '').trim();
        const stage = VALID_STAGES.has(stageRaw) ? stageRaw : 'n/a';
        if (stageRaw && stageRaw !== stage) {
          console.warn('[vision] invalid stage corrected', { from: stageRaw, to: stage });
        }
        const VALID_PHOTO_QUALITIES = new Set(['good', 'acceptable', 'poor']);
        const photoQuality = VALID_PHOTO_QUALITIES.has(parsed.photoQuality) ? parsed.photoQuality : 'acceptable';
        const VALID_THINNING_PATTERNS = new Set(['minimal', 'bitemporal', 'crown', 'bitemporal+crown', 'frontal', 'diffuse', 'total']);
        const thinningPatternRaw = VALID_THINNING_PATTERNS.has(parsed.thinningPattern) ? parsed.thinningPattern : 'minimal';
        // Server-side stage/thinningPattern consistency enforcement.
        // The scan prompt instructs GPT-4o to follow these rules, but models
        // occasionally violate them (e.g., NW3v with thinningPattern='bitemporal').
        // Correct silently so the iOS app never receives an inconsistent pair.
        // Rules come directly from the stage-thinningPattern section of the scan prompt.
        const STAGE_THINNING_OVERRIDES = {
          NW1:  'minimal',          // NW1 = no visible recession anywhere; no thinning pattern
          NW2:  'bitemporal',       // NW2 = slight symmetric temple recession by definition; never minimal
          NW3:  'bitemporal',       // NW3 = deep bilateral temple recession, crown intact; NW3v covers crown
          NW3v: 'bitemporal+crown', // NW3v = temple + early crown by definition
          NW4:  'bitemporal+crown', // NW4 has both frontal + pronounced crown thinning
          NW5:  'bitemporal+crown', // NW5 frontal+crown nearly merging — NOT total (reserved for NW6/NW7)
          NW6:  'total',            // frontal and crown merged; only lateral fringe remains
          NW7:  'total',            // horseshoe fringe only; near-total scalp loss
          diffuse: 'diffuse',       // diffuse stage → diffuse pattern (always uniform)
        };
        let thinningPattern = STAGE_THINNING_OVERRIDES[stage] != null
          ? STAGE_THINNING_OVERRIDES[stage]
          : stage === 'n/a (female)' && thinningPatternRaw !== 'diffuse' && thinningPatternRaw !== 'total'
            ? 'diffuse'             // female-pattern defaults to diffuse unless Ludwig III severe
            : thinningPatternRaw;
        if (thinningPattern !== thinningPatternRaw) {
          console.warn('[vision] stage-thinningPattern corrected', { stage, from: thinningPatternRaw, to: thinningPattern });
        }
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
          thinningZones: stage === 'n/a (female)'
            ? (FEMALE_THINNING_ZONES_MAP[thinningPattern] || THINNING_ZONES_MAP[thinningPattern] || [])
            : (THINNING_ZONES_MAP[thinningPattern] || []),
          confidenceScore,
          scoredAt:            new Date().toISOString(),
        };
        // Stage-score soft bounds: clamp hairline, density, and crown when GPT-4o
        // returns values clearly outside the expected range for the classified stage.
        // health is left untouched — it depends on individual scalp condition.
        // potential is corrected by POTENTIAL_STAGE_BOUNDS below (separate wide table).
        {
          const _b = STAGE_SCORE_BOUNDS[stage];
          if (_b) {
            const [hlMin, hlMax, dMin, dMax, cMin, cMax] = _b;
            const _bc = {};
            if (data.hairline < hlMin || data.hairline > hlMax) {
              _bc.hairline = { from: data.hairline, to: Math.max(hlMin, Math.min(hlMax, data.hairline)) };
              data.hairline = _bc.hairline.to;
            }
            if (data.density < dMin || data.density > dMax) {
              _bc.density = { from: data.density, to: Math.max(dMin, Math.min(dMax, data.density)) };
              data.density = _bc.density.to;
            }
            if (data.crown < cMin || data.crown > cMax) {
              _bc.crown = { from: data.crown, to: Math.max(cMin, Math.min(cMax, data.crown)) };
              data.crown = _bc.crown.to;
            }
            if (Object.keys(_bc).length > 0) {
              console.warn('[vision] stage-score bounds correction', { stage, corrections: _bc });
            }
          }
        }
        // Potential soft bounds: catch extreme outliers where potential is clearly
        // wrong for the stage (e.g. NW7 user with potential=82, NW2 with potential=15).
        // Bounds are wide (±25 from the midpoint of the widest age bracket) so valid
        // age-specific variation and Rx upward adjustments are never clipped.
        {
          const _pb = POTENTIAL_STAGE_BOUNDS[stage];
          if (_pb) {
            const [pMin, pMax] = _pb;
            if (data.potential < pMin || data.potential > pMax) {
              const _corrected = Math.max(pMin, Math.min(pMax, data.potential));
              console.warn('[vision] potential bounds correction', { stage, from: data.potential, to: _corrected });
              data.potential = _corrected;
            }
          }
        }
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
        // Second-weakest metric (by current-state score). Gives the iOS app a #2 priority
        // without extra client-side sorting logic, and surfaces it in the coach context.
        data.secondWeakestMetric = _sortedMetrics.length >= 2
          ? { label: _sortedMetrics[1][0], value: _sortedMetrics[1][1] }
          : null;
        // Guarantee the weakest metric is covered by at least one insight.
        // GPT-4o may return 3 insights that all miss the weakest area — replace
        // insights[2] (lowest-priority slot) with a targeted server-side fallback.
        // NW6/NW7 get surgical-aware language: at those stages OTC can only protect
        // the remaining fringe; promising "the treatment response window is open" is
        // misleading when FUE/FUT or SMP is the primary coverage path.
        if (!data.insights.some((ins) => ins.metric === _weakLabel)) {
          const _isAdvancedForFallback = data.stage === 'NW6' || data.stage === 'NW7';
          const _weakFallback = {
            Hairline: _isAdvancedForFallback
              ? { title: 'Protect the remaining fringe',   body: `At ${data.stage} with hairline at ${data.hairline}/100, finasteride protects the lateral fringe from further loss — pair it with a transplant consultation this quarter to plan the most realistic path to coverage.`,                                                                                             metric: 'Hairline' }
              : { title: 'Target recession zones',         body: `Apply minoxidil twice daily to both temple recession zones — at ${data.hairline}/100, hairline is your highest-ROI focus and the treatment response window is open.`,                                                                                                                                        metric: 'Hairline' },
            Density: _isAdvancedForFallback
              ? { title: 'Defend lateral hair density',    body: `At ${data.stage} with density at ${data.density}/100, apply minoxidil along the fringe and temporal edges twice daily to protect remaining density — book a transplant consultation to build a realistic full-coverage strategy alongside your OTC routine.`,                                                      metric: 'Density'  }
              : { title: 'Build mid-scalp density',        body: `Add a DHT-blocking shampoo 3× weekly and a 5-minute scalp massage each wash — at ${data.density}/100 density, these are the most cost-effective OTC tools for coverage.`,                                                                                                                                  metric: 'Density'  },
            Crown: _isAdvancedForFallback
              ? { title: 'Plan coverage; protect the fringe', body: `At ${data.stage} with crown at ${data.crown}/100, crown restoration is primarily a surgical goal — apply minoxidil along the remaining lateral fringe to preserve it and consult a trichologist about FUE/FUT or SMP options.`,                                                                           metric: 'Crown'    }
              : { title: 'Protect the vertex now',         body: `Apply minoxidil 1ml directly to the crown twice daily and track with monthly overhead photos — your crown at ${data.crown}/100 responds best to targeted topical coverage.`,                                                                                                                               metric: 'Crown'    },
            Health:   { title: 'Optimize scalp environment', body: `Switch to a gentle sulfate-free shampoo and add biotin and zinc — scalp health at ${data.health}/100 directly affects how well topicals absorb and follicles respond.`,                                                                                                                                   metric: 'Health'   },
            Potential: _isAdvancedForFallback
              ? { title: 'Maximize realistic outcomes',    body: `At ${data.stage} with potential at ${data.potential}/100, finasteride and minoxidil together give the strongest OTC baseline for the remaining fringe — pair with a surgical consultation to build the most complete multi-layer strategy.`,                                                                    metric: 'Potential'}
              : { title: 'Stack the right habits',         body: `Pairing minoxidil with scalp massage and a DHT-blocking shampoo gives the strongest 6-month OTC response — start the full stack now while the treatment window is open.`,                                                                                                                                   metric: 'Potential'},
          }[_weakLabel];
          if (_weakFallback) data.insights[2] = _weakFallback;
        }
        // stageSeverityIndex: numeric 1-7 (with 0.5 steps for NW3v/diffuse/female).
        // Lets the iOS app render a severity bar or compare stages without string logic.
        data.stageSeverityIndex = STAGE_SEVERITY_INDEX[stage] ?? null;
        // stageSeverityLabel: human-readable categorical label for stageSeverityIndex.
        // Four buckets: Early (1-2) → Moderate (3-3.5) → Advanced (4-5) → Severe (6-7).
        // Use for badge text, color-coded pills, or summary lines without parsing stageLabel.
        const _ssi = data.stageSeverityIndex;
        data.stageSeverityLabel = _ssi === null ? null
          : _ssi <= 2   ? 'Early'
          : _ssi <= 3.5 ? 'Moderate'
          : _ssi <= 5   ? 'Advanced'
          : 'Severe';
        // retakeRecommended: true when photo quality is too poor for reliable scoring.
        // The iOS app can use this to show a "Retake for better results" CTA.
        data.retakeRecommended = photoQuality === 'poor';

        // specialistRecommended: true when a trichologist, dermatologist, or
        // transplant consultation is the highest-ROI next step — either because OTC
        // alone is unlikely to produce meaningful results (NW5+), or because the stage
        // requires a professional workup to identify a reversible root cause
        // (diffuse / female pattern). The iOS app can use this flag to show a
        // "Book a Specialist" CTA without parsing the verdict or weeklyFocus text.
        const SPECIALIST_STAGES = new Set(['NW5', 'NW6', 'NW7', 'diffuse', 'n/a (female)']);
        data.specialistRecommended = SPECIALIST_STAGES.has(stage) || data.currentStateScore < 40;
        const _SPECIALIST_REASONS = {
          NW5: 'At NW5, a transplant consultation is worth planning alongside your OTC protocol — a specialist can outline surgical options and realistic coverage goals while OTC treatment continues.',
          NW6: 'At NW6, FUE/FUT or SMP are the most realistic paths to meaningful coverage — a trichologist or transplant consultation now is the highest-ROI next step.',
          NW7: 'At NW7, surgical options (FUE/FUT or SMP) are the primary path — a transplant consultation this quarter will clarify donor supply, coverage options, and realistic outcomes.',
          diffuse: 'Diffuse thinning often has a reversible nutritional or hormonal cause — a dermatologist or trichologist workup (ferritin, thyroid, hormones) is the highest-ROI next step.',
          'n/a (female)': 'Female-pattern thinning responds best when the hormonal root cause is identified — a dermatologist or gynecologist workup (hormone panel, ferritin, thyroid) is the highest-ROI next step.',
        };
        data.specialistReason = SPECIALIST_STAGES.has(stage)
          ? (_SPECIALIST_REASONS[stage] || 'A specialist consultation can clarify your treatment options and realistic outcomes.')
          : data.currentStateScore < 40
            ? 'Your hair loss score indicates significant thinning — a trichologist or dermatologist can evaluate whether surgical or medical options are right for you.'
            : null;

        // photoGuidance: actionable retake tip shown when quality isn't ideal.
        // Computed server-side so the iOS app can display it without extra logic.
        // Stage- and sex-aware: female users get central-parting guidance; NW5+ users
        // are reminded to capture both thinning zones in one overhead shot.
        data.photoGuidance = buildPhotoGuidance(photoQuality, stage, profile.sex);

        // weeklyFocus: highest-ROI weekly action based on the user's weakest metric.
        // Routine-aware: if the primary suggestion is already in their routine, recommend
        // the next most impactful complementary action instead of repeating redundant advice.
        const _routineItems = (profile.routine || []).map((r) => String(r).toLowerCase());
        const _hasMinoxidil  = _routineItems.some((r) => r.includes('minoxidil') || r.includes('rogaine') || r.includes('regaine') || r.includes('minox') || r.includes('kirkland') || r.includes('tugain') || r.includes('mintop') || r.includes('loniten') || r.includes('nanoxidil') || r.includes('morr') || r.includes('hims') || r.includes('keeps'));
        const _hasDHTShampoo = _routineItems.some((r) => r.includes('dht') || r.includes('ketoconazole') || r.includes('nizoral') || r.includes('keto shampoo') || r.includes('caffeine shampoo') || r.includes('regenepure') || r.includes('alpecin') || r.includes('plantur') || r.includes('foligain') || r.includes('lipogaine') || r.includes('revita') || r.includes('pura d') || r.includes('shapiro md') || r.includes('rosemary oil') || r.includes('mielle') || r.includes('maple holistics') || r.includes('nioxin') || r.includes('keranique') || r.includes('ultrax') || r.includes('phytocyane') || r.includes('bioxsine') || r.includes('watermans') || r.includes('anaphase') || r.includes('vichy') || r.includes('dercos') || r.includes('klorane') || r.includes('rene furterer') || r.includes('triphasic') || r.includes('ducray') || r.includes('bioscalin') || r.includes('revivogen') || r.includes('pronexa'));
        const _hasMassage    = _routineItems.some((r) => r.includes('massage') || r.includes('dermaroller') || r.includes('derma roller') || r.includes('derma stamp') || r.includes('dermastamp') || r.includes('dermapen') || r.includes('microneedl') || r.includes('micro-needl') || r.includes('dr pen') || r.includes('drpen') || r.includes('dr.pen') || r.includes('zgts') || r.includes('derminator') || r.includes('lllt') || r.includes('laser cap') || r.includes('laser comb') || r.includes('laser helmet') || r.includes('laserband') || r.includes('laser band') || r.includes('capillus') || r.includes('hairmax') || r.includes('irestore') || r.includes('igrow') || r.includes('theradome') || r.includes('kiierr') || r.includes('illumiflow') || r.includes('sunetics'));
        const _hasLLLT       = _routineItems.some((r) => r.includes('lllt') || r.includes('laser cap') || r.includes('laser comb') || r.includes('laser helmet') || r.includes('laserband') || r.includes('laser band') || r.includes('capillus') || r.includes('hairmax') || r.includes('irestore') || r.includes('igrow') || r.includes('theradome') || r.includes('kiierr') || r.includes('illumiflow') || r.includes('sunetics'));
        const _hasMicroneedling = _routineItems.some((r) => r.includes('microneedl') || r.includes('micro-needl') || r.includes('dermaroller') || r.includes('derma roller') || r.includes('derma stamp') || r.includes('dermastamp') || r.includes('dermapen') || r.includes('dr pen') || r.includes('drpen') || r.includes('dr.pen') || r.includes('zgts') || r.includes('derminator'));
        const _hasSupplements= _routineItems.some((r) => r.includes('supplement') || r.includes('biotin') || r.includes('vitamin') || r.includes('zinc') || r.includes('saw palmetto') || r.includes('nutrafol') || r.includes('viviscal') || (r.includes('iron') && !r.includes('flat iron') && !r.includes('curling iron') && !r.includes('steam iron') && !r.includes('hair iron') && !r.includes('flat-iron') && !r.includes('curling-iron')) || r.includes('pumpkin seed') || r.includes('folexin') || r.includes('hairfinity') || r.includes('perfectil') || r.includes('hairburst') || r.includes('collagen') || (r.includes('keratin') && !r.includes('keratin treatment') && !r.includes('keratin therapy') && !r.includes('keratin complex') && !r.includes('keratin smoothing') && !r.includes('keratin straighten') && !r.includes('keratin blowout')) || r.includes('marine collagen') || r.includes('hair formula') || r.includes('omega') || r.includes('fish oil') || r.includes('folic acid') || r.includes('folate') || r.includes('silica') || r.includes('niacin') || r.includes('evening primrose') || r.includes('selenium') || r.includes('magnesium') || r.includes('copper') || r.includes('lysine') || r.includes('msm') || r.includes('ashwagandha') || r.includes('nettle') || r.includes('beta-sitosterol') || r.includes('hair gum') || r.includes('multivitamin') || r.includes('nourkrin') || r.includes('priorin') || r.includes('hair vitalics') || r.includes('pantogar') || r.includes('bhringraj') || r.includes('sugarbear') || r.includes('vegamour') || r.includes('hair la vie') || r.includes('foligrowth') || r.includes('pantovigar') || r.includes('philip kingsley') || r.includes('tricho complex') || r.includes('florisene') || r.includes('lambdapil') || r.includes('hum nutrition') || r.includes('anacaps') || r.includes('pilexil') || r.includes('reishi') || r.includes('black seed') || r.includes('fo-ti') || r.includes('he shou wu') || r.includes('pycnogenol') || r.includes('moringa') || r.includes('horsetail') || r.includes('inneov') || r.includes('bioscalin') || r.includes('inositol') || r.includes('spermidine') || r.includes('diindolylmethane') || r.includes(' dim ') || r.includes('dim supplement') || r.includes('green tea extract') || r.includes('egcg') || r.includes('grape seed') || r.includes('procyanidin') || r.includes('resveratrol') || r.includes('turmeric') || r.includes('curcumin') || r.includes('berberine') || r.includes('ginkgo') || r.includes('nac') || r.includes('n-acetyl') || r.includes('coq10') || r.includes('coenzyme q') || r.includes('l-carnitine') || r.includes('carnitine tartrate') || r.includes('quercetin') || r.includes('melatonin') || r.includes('olly') || r.includes('astaxanthin') || r.includes('milk thistle') || r.includes('silymarin') || r.includes('spearmint') || r.includes('licorice root') || r.includes('pygeum') || r.includes('fenugreek') || r.includes('tocopherol') || r.includes('ascorbic acid') || r.includes('pantothenic acid') || r.includes('vitamin b5') || r.includes('l-cysteine') || r.includes('maca') || r.includes('lion') || r.includes('cordyceps') || r.includes('rhodiola') || r.includes('adaptogen') || r.includes('stinging nettle') || r.includes('amla'));
        const _hasFinasteride = _routineItems.some((r) => r.includes('finasteride') || r.includes('propecia') || r.includes('dutasteride') || r.includes('avodart') || r.includes('proscar') || r.includes('finpecia') || r.includes('finalo') || r.includes('finast') || r.includes('fincar') || r.includes('finax') || r.includes('aindeem') || r.includes('spironolactone') || r.includes('spiro') || r.includes('aldactone') || r.includes('bicalutamide') || r.includes('casodex') || r.includes('flutamide') || r.includes('cyproterone') || r.includes('androcur') || r.includes('clascoterone') || r.includes('winlevi'));
        // Stage gates: at NW5 expectations shift; at NW6/NW7 OTC has very limited effect
        // and the primary path is specialist consultation / surgical options.
        const _isNW7          = data.stage === 'NW7';
        const _isNW5only      = data.stage === 'NW5';
        const _isNW56         = data.stage === 'NW5' || data.stage === 'NW6';
        const WEEKLY_FOCUS_MAP = {
          Hairline: _isNW7
            ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                ? 'At NW7, your finasteride + minoxidil + DHT-blocking shampoo is the most complete non-surgical fringe protocol — systemic DHT suppression through finasteride, topical growth signal through minoxidil, and local DHT control through the shampoo. Keep all three consistent without gaps. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your triple-layer protocol integrates into the surgical strategy.'
                : _hasFinasteride && _hasDHTShampoo
                ? 'Your finasteride + DHT-blocking shampoo at NW7 delivers both systemic and topical DHT suppression for the remaining horseshoe fringe — keep both consistent without gaps. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your dual-layer DHT protocol integrates into the surgical strategy.'
                : _hasFinasteride && _hasMinoxidil
                ? 'Your finasteride + minoxidil at NW7 delivers systemic DHT suppression and a topical growth signal for the remaining horseshoe fringe — keep both consistent without gaps. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your dual-layer protocol integrates into the surgical strategy.'
                : _hasFinasteride
                ? 'Your finasteride is protecting the remaining horseshoe fringe at NW7 — keep it consistent without gaps. The primary coverage path is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your systemic treatment fits into the surgical strategy.'
                : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                ? 'At NW7, your supplement stack, minoxidil, and DHT-blocking shampoo combine nutritional support, topical growth signal, and local DHT suppression for the remaining horseshoe fringe — apply minoxidil to the fringe and lateral edges twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement stack consistent without gaps. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your three-layer OTC protocol integrates into the surgical strategy.'
                : _hasSupplements && _hasDHTShampoo
                ? 'Your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression for the remaining horseshoe fringe at NW7 — keep DHT shampoo on 3-5 minutes per wash 3× weekly and your supplement stack consistent. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your nutritional and topical DHT protocol integrates into the surgical strategy.'
                : _hasSupplements && _hasMinoxidil
                ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for the remaining horseshoe fringe at NW7 — apply minoxidil to the fringe and lateral edges twice daily and keep your supplement routine consistent. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your nutritional and topical protocol integrates into the surgical strategy.'
                : _hasMinoxidil && _hasDHTShampoo
                ? 'Your minoxidil + DHT-blocking shampoo provides a topical growth signal and local DHT suppression for the remaining horseshoe fringe at NW7 — apply minoxidil to the fringe and lateral edges twice daily and leave DHT shampoo on 3-5 minutes per wash. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your dual-layer topical protocol integrates into the surgical strategy.'
                : _hasDHTShampoo
                ? 'Your DHT-blocking shampoo provides topical DHT suppression for the remaining fringe at NW7 — keep using it 3× weekly with 3-5 minutes of contact time. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and realistic coverage outcomes alongside your OTC routine.'
                : _hasMinoxidil
                ? 'Your minoxidil provides a topical growth signal for the remaining horseshoe fringe at NW7 — keep applying it consistently to the fringe and lateral edges. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your topical protocol integrates into the surgical strategy.'
                : _hasSupplements && _hasMassage
                ? (_hasLLLT
                    ? 'At NW7, your supplement stack and LLLT device provide nutritional support and photobiomodulation for the remaining horseshoe fringe — keep your supplement routine consistent and maintain your LLLT sessions on schedule. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your nutritional and photobiomodulation protocol integrates into the surgical strategy.'
                    : _hasMicroneedling
                    ? 'At NW7, your supplement stack and microneedling cover nutritional support and scalp priming for the remaining horseshoe fringe — keep your supplement routine consistent and use microneedling 24-48 hours before any topical application along the fringe to prime absorption. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your current protocol integrates into the surgical strategy.'
                    : 'At NW7, your supplement stack and scalp massage provide nutritional support and mechanical stimulation for the remaining horseshoe fringe — keep your supplement routine consistent and massage along the fringe and lateral edges daily. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your current protocol integrates into the surgical strategy.')
                : _hasSupplements
                ? 'Your supplement stack supports remaining fringe follicle health at NW7 — keep biotin, zinc, and vitamin D consistent as nutritional support. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and realistic coverage outcomes alongside your supplement routine.'
                : 'At NW7, the primary path is FUE/FUT transplant or SMP — book a trichologist consult this week to understand candidacy, donor supply, and realistic coverage outcomes.')
            : _isNW5only
              ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo && _hasMassage
                  ? (_hasLLLT
                      ? 'NW5 frontal recession with finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical protocol — apply minoxidil along the full frontal zone immediately after your LLLT session while scalp circulation is elevated, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time each day. Monthly front-facing photos track the bridge; this four-layer stack gives the strongest realistic hairline response at this stage.'
                      : _hasMicroneedling
                      ? 'NW5 frontal recession with finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical protocol — wait 24-48 hours after each microneedling session before applying minoxidil along the full frontal zone (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Leave DHT shampoo on 3-5 minutes per wash and take finasteride at the same time each day. Monthly front-facing photos track the bridge; this four-layer stack gives the strongest realistic hairline response at this stage.'
                      : 'NW5 frontal recession with finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical protocol — apply minoxidil along the full frontal zone immediately after your scalp massage so primed follicles absorb it, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time each day. Monthly front-facing photos track the bridge; this four-layer stack gives the strongest realistic hairline response at this stage.')
                  : _hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                  ? 'NW5 frontal recession with finasteride + minoxidil + DHT shampoo is the strongest non-surgical protocol — keep all three consistent. Apply minoxidil across the full frontal zone and both temple edges twice daily, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time each day. Monthly front-facing photos track the bridge; the goal is stabilization.'
                  : _hasFinasteride && _hasMinoxidil && _hasMassage
                    ? (_hasLLLT
                        ? 'NW5 frontal recession with finasteride + minoxidil + LLLT covers systemic DHT suppression, topical growth signal, and photobiomodulation — apply minoxidil along the full frontal zone immediately after your LLLT session while scalp circulation is elevated. Add a DHT-blocking shampoo 3× weekly as the topical DHT layer to complete the protocol; track with monthly front-facing photos to monitor how quickly the bridge between forelock and lateral fringe is changing.'
                        : _hasMicroneedling
                        ? 'NW5 frontal recession with finasteride + minoxidil + microneedling covers systemic DHT suppression, topical growth signal, and scalp priming — wait 24-48 hours after each microneedling session before applying minoxidil along the full frontal zone (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly as the topical DHT layer to complete the protocol; track with monthly front-facing photos to monitor how quickly the bridge between forelock and lateral fringe is changing.'
                        : 'NW5 frontal recession with finasteride + minoxidil + massage covers systemic DHT suppression, topical growth signal, and mechanical stimulation — apply minoxidil along the full frontal zone immediately after your scalp massage so primed follicles absorb it directly. Add a DHT-blocking shampoo 3× weekly as the topical DHT layer to complete the protocol; track with monthly front-facing photos to monitor how quickly the bridge between forelock and lateral fringe is changing.')
                  : _hasFinasteride && _hasMinoxidil
                    ? 'NW5 frontal recession with finasteride + minoxidil gives the strongest available non-surgical coverage — add a DHT-blocking shampoo 3× weekly as the third layer. Apply minoxidil across the entire frontal zone twice daily and take monthly front-facing photos to track how the bridge between forelock and lateral fringe responds.'
                    : _hasFinasteride && _hasDHTShampoo
                      ? 'Finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression across the narrowing frontal bridge at NW5 — take finasteride at the same time each day and leave DHT shampoo on 3-5 minutes per wash 3× weekly. Add minoxidil across the full frontal zone and both temple edges twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the strongest non-surgical hairline protocol at this stage where the bridge between the forelock and lateral fringe is narrowing. Track with monthly front-facing photos.'
                    : _hasFinasteride
                      ? 'NW5 frontal recession with finasteride providing systemic DHT suppression is a strong foundation — add minoxidil across the full frontal zone twice daily for the complementary topical signal. The finasteride + minoxidil combination is the most effective non-surgical approach at NW5; add a DHT-blocking shampoo 3× weekly and track with monthly front-facing photos.'
                      : _hasMinoxidil && _hasDHTShampoo && _hasMassage
                          ? (_hasLLLT
                              ? 'NW5 frontal recession with minoxidil + DHT shampoo + LLLT covers topical growth signal, local DHT suppression, and photobiomodulation — apply minoxidil along the full frontal zone immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes per wash. A doctor consult about finasteride adds systemic DHT suppression, the most impactful upgrade at this stage; track with monthly front-facing photos to monitor how quickly the bridge between the forelock and lateral fringe is changing.'
                              : _hasMicroneedling
                              ? 'NW5 frontal recession with minoxidil + DHT shampoo + microneedling covers topical growth signal, local DHT suppression, and scalp priming — wait 24-48 hours after each microneedling session before applying minoxidil along the full frontal zone (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Leave DHT shampoo on 3-5 minutes per wash. A doctor consult about finasteride adds systemic DHT suppression, the most impactful upgrade at this stage; track with monthly front-facing photos to monitor how quickly the bridge between the forelock and lateral fringe is changing.'
                              : 'NW5 frontal recession with minoxidil + DHT shampoo + scalp massage covers topical growth signal, local DHT suppression, and mechanical stimulation — apply minoxidil along the full frontal zone immediately after your scalp massage and leave DHT shampoo on 3-5 minutes per wash. A doctor consult about finasteride adds systemic DHT suppression, the most impactful upgrade at this stage; track with monthly front-facing photos to monitor how quickly the bridge between the forelock and lateral fringe is changing.')
                          : _hasMinoxidil && _hasDHTShampoo
                          ? 'NW5 frontal recession is severe with a narrow bridge still separating the forelock from the lateral fringe — apply minoxidil across the full frontal zone twice daily and leave your DHT-blocking shampoo on 3-5 minutes per wash to slow the merge. Take monthly front-facing photos; tracking how quickly the bridge narrows is the key signal at this stage.'
                          : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                          ? 'NW5 frontal recession with your supplement stack, minoxidil, and DHT-blocking shampoo covers nutritional follicle support, topical growth signal, and local DHT suppression across the full frontal zone — apply minoxidil twice daily across the full frontal bridge and leave DHT shampoo on 3-5 minutes per wash. Keep your supplement routine consistent as the nutritional foundation. Add a 4-minute scalp massage before each minoxidil application to prime absorption where the bridge between the forelock and lateral fringe is narrowing; this OTC three-layer stack gives the strongest non-surgical hairline response at this stage. Track with monthly front-facing photos.'
                          : _hasMinoxidil && _hasMassage
                            ? (_hasLLLT
                                ? 'NW5 frontal recession with minoxidil and LLLT covers topical growth signal and photobiomodulation across the full frontal zone — apply minoxidil along the full frontal hairline immediately after your LLLT session while scalp circulation is elevated. Add a DHT-blocking shampoo 3× weekly as the topical DHT-suppression layer; the three-layer OTC stack gives the strongest non-surgical hairline response at this stage. Track with monthly front-facing photos.'
                                : _hasMicroneedling
                                ? 'NW5 frontal recession with minoxidil and microneedling covers topical growth signal and scalp priming across the full frontal zone — wait 24-48 hours after each microneedling session before applying minoxidil to avoid follicle irritation; on non-needling days apply along the full frontal zone twice daily. Add a DHT-blocking shampoo 3× weekly as the topical DHT-suppression layer; together the three OTC layers give the strongest non-surgical hairline response at this stage. Track with monthly front-facing photos.'
                                : 'NW5 frontal recession with minoxidil and scalp massage covers topical growth signal and mechanical stimulation — apply minoxidil along the full frontal zone immediately after your scalp massage so freshly stimulated follicles absorb it. Add a DHT-blocking shampoo 3× weekly as the topical DHT-suppression layer; together the three OTC layers give the strongest non-surgical hairline response at this stage. Track with monthly front-facing photos.')
                            : _hasSupplements && _hasMinoxidil
                              ? 'NW5 frontal recession with your supplement stack and minoxidil covers nutritional follicle support and the topical growth signal at the narrowing frontal bridge — apply minoxidil across the full frontal zone twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer hairline approach at this stage where the bridge between the forelock and lateral fringe is narrowing. Take monthly front-facing photos to track how quickly the bridge is closing.'
                            : _hasMinoxidil
                              ? 'NW5 frontal recession is extensive — the bridge between the forelock and lateral fringe is narrowing. Apply minoxidil across the full frontal zone and both temple edges twice daily, and add a DHT-blocking shampoo 3× weekly. Take monthly front-facing photos to monitor how quickly the bridge is closing.'
                              : _hasSupplements && _hasDHTShampoo
                                ? 'Your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression at the narrowing frontal bridge at NW5 — keep DHT shampoo on 3-5 minutes per wash 3× weekly and your supplement stack consistent. Add minoxidil across the full frontal zone twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC three-layer hairline approach at this stage where the bridge between the forelock and lateral fringe is narrowing. Take monthly front-facing photos to track how quickly the bridge is closing.'
                                : _hasDHTShampoo
                                ? 'NW5 frontal recession is substantial and the bridge between the forelock and lateral fringe is narrowing — your DHT-blocking shampoo provides local DHT suppression at the recession edge, which is a solid start. Add minoxidil across the full frontal zone twice daily as the topical growth signal; DHT shampoo + minoxidil targets the narrowing bridge from two angles. OTC at this stage is about slowing the merge, not full reversal; take monthly front-facing photos to track the bridge.'
                                : _hasSupplements && _hasMassage
                                ? (_hasLLLT
                                    ? 'NW5 frontal recession with your supplement stack and LLLT device cover nutritional support and photobiomodulation across the narrowing frontal bridge — apply minoxidil along the full frontal zone immediately after your LLLT session while scalp circulation is elevated. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; the combination of nutritional support, photobiomodulation, and DHT suppression gives the strongest non-Rx hairline approach where the bridge between the forelock and lateral fringe is narrowing. A doctor consult about finasteride adds systemic DHT suppression, the most impactful upgrade at this stage. Track with monthly front-facing photos.'
                                    : _hasMicroneedling
                                    ? 'NW5 frontal recession with your supplement stack and microneedling cover nutritional support and scalp priming across the narrowing frontal bridge — use microneedling 24-48 hours before any topical application along the full frontal zone to prime absorption where the bridge between the forelock and lateral fringe is narrowing; on non-needling days keep your routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer and consider adding minoxidil along the full frontal zone twice daily for the topical growth signal. A doctor consult about finasteride adds systemic DHT suppression, the most impactful upgrade at this stage. Track with monthly front-facing photos.'
                                    : 'NW5 frontal recession with your supplement stack and scalp massage cover nutritional support and mechanical stimulation across the narrowing frontal bridge — keep your supplement routine consistent and apply a 4-minute scalp massage daily focusing on the full frontal zone where the bridge between the forelock and lateral fringe is narrowing. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer and consider adding minoxidil along the full frontal zone twice daily for the topical growth signal; the combination targets the frontal bridge from multiple angles. A doctor consult about finasteride adds systemic DHT suppression, the most impactful upgrade at this stage. Track with monthly front-facing photos.')
                                : _hasSupplements
                                ? 'Your supplement stack supports follicle health at NW5 where the frontal bridge is narrowing — biotin, zinc, and vitamin D are a good nutritional foundation. Add minoxidil across the full frontal zone twice daily as the topical growth signal; at this stage OTC is about slowing the bridge from closing, and nutritional support combined with a topical approach gives the strongest non-surgical response. Take monthly front-facing photos to track the bridge.'
                                : 'NW5 frontal recession is substantial and the bridge between the forelock and lateral fringe is narrowing — start minoxidil across the full frontal zone twice daily and add a DHT-blocking shampoo 3× weekly. OTC at this stage is about slowing the merge, not full reversal; take monthly photos to track the bridge.')
              : _isNW56
              // only NW6 reaches here — NW5 is handled by _isNW5only above
              ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                  ? 'At NW6, finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT blocking — apply minoxidil along the fringe and temple edges twice daily, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time each day. Together they give the strongest non-surgical fringe defense at this stage; book a transplant consultation to evaluate surgical planning alongside your protocol.'
                  : _hasFinasteride && _hasMinoxidil
                  ? 'At NW6, finasteride + minoxidil is your strongest non-surgical defense for the remaining fringe and temporal hair — keep both consistent with no gaps. Apply minoxidil along the fringe and temple edges twice daily and take finasteride at the same time each day. In parallel, research FUE/FUT transplant options: combining systemic treatment with surgical planning is the most complete strategy at this stage.'
                  : _hasFinasteride && _hasDHTShampoo
                  ? 'Finasteride + DHT-blocking shampoo at NW6 delivers dual-level DHT suppression for the remaining fringe and temporal hairline — systemic through finasteride and topical through the shampoo (3-5 min contact time 3× weekly). Add minoxidil to the fringe and temporal edges twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the strongest non-surgical fringe hairline protocol at this stage. Book a transplant consultation to evaluate surgical coverage options alongside your current dual-layer DHT protocol.'
                  : _hasFinasteride
                    ? 'Finasteride is blocking systemic DHT at NW6 — add minoxidil to the fringe and temporal edges twice daily to complete the non-surgical protocol. Together they give the best realistic slowdown of further fringe recession; book a transplant consultation in the next 6 months to plan your full-coverage strategy.'
                    : _hasMinoxidil && _hasDHTShampoo && _hasMassage
                      ? (_hasLLLT
                          ? 'At NW6, minoxidil + DHT shampoo + LLLT covers topical growth signal, local DHT suppression, and photobiomodulation for the remaining fringe — apply minoxidil along the fringe and temple edges immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes per wash. Book a transplant consultation and consider a doctor consult about finasteride for systemic DHT suppression as the most impactful upgrade at this stage.'
                          : _hasMicroneedling
                          ? 'At NW6, minoxidil + DHT shampoo + microneedling covers topical growth signal, local DHT suppression, and scalp priming for the remaining fringe — wait 24-48 hours after each microneedling session before applying minoxidil along the fringe and temple edges (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Leave DHT shampoo on 3-5 minutes per wash. Book a transplant consultation and consider a doctor consult about finasteride for systemic DHT suppression as the most impactful upgrade at this stage.'
                          : 'At NW6, minoxidil + DHT shampoo + scalp massage covers topical growth signal, local DHT suppression, and mechanical stimulation — apply minoxidil along the fringe and temple edges immediately after your massage, and leave DHT shampoo on 3-5 minutes per wash. Book a transplant consultation and consider a doctor consult about finasteride for systemic DHT suppression as the most impactful upgrade at this stage.')
                      : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                        ? 'At NW6, your supplement stack, minoxidil, and DHT-blocking shampoo deliver the strongest OTC three-layer fringe hairline approach — nutritional follicle support, topical growth signal, and local DHT suppression all active. Apply minoxidil along the fringe and temple edges twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. Consider a doctor consult about finasteride for systemic DHT suppression, the most impactful upgrade at this stage, and book a transplant consultation to evaluate surgical coverage options alongside your OTC maintenance.'
                      : _hasMinoxidil && _hasDHTShampoo
                        ? 'At NW6, minoxidil + DHT shampoo covers topical growth signal and local DHT blocking — apply minoxidil along the fringe and temple edges twice daily and leave DHT shampoo on 3-5 minutes per wash. Consider a doctor consult about finasteride for systemic DHT suppression, the most impactful upgrade at this stage, and book a transplant consultation for a full coverage strategy.'
                        : _hasMinoxidil && _hasMassage
                          ? (_hasLLLT
                              ? 'At NW6, your minoxidil and LLLT device cover topical growth signal and photobiomodulation across the remaining fringe and temple edges — apply minoxidil immediately after your LLLT session while scalp circulation is elevated so freshly stimulated follicles absorb it. Add a DHT-blocking shampoo 3× weekly as the topical DHT-suppression layer; book a transplant consultation to evaluate surgical coverage options alongside your OTC maintenance.'
                              : _hasMicroneedling
                              ? 'At NW6, your minoxidil and microneedling both target the remaining fringe and temple edges — wait 24-48 hours after each microneedling session before applying minoxidil to avoid follicle irritation; on non-needling days apply along the fringe and temple edges twice daily. Add a DHT-blocking shampoo 3× weekly as the topical DHT-suppression layer; book a transplant consultation to evaluate surgical coverage options alongside your OTC maintenance.'
                              : 'At NW6, your minoxidil and scalp massage are both active — apply minoxidil along the fringe and temple edges immediately after each massage to prime freshly stimulated follicles for absorption. Add a DHT-blocking shampoo 3× weekly as the topical DHT-suppression layer; book a transplant consultation to evaluate surgical coverage options alongside your OTC maintenance.')
                          : _hasSupplements && _hasMinoxidil
                            ? 'Your supplement stack and minoxidil provide nutritional follicle support and the topical growth signal for the remaining fringe at NW6 — apply minoxidil to the fringe and temple edges twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach for fringe hairline defense at this advanced stage. Book a transplant consultation to evaluate surgical coverage options alongside your OTC maintenance.'
                          : _hasMinoxidil
                            ? 'At NW6, apply minoxidil consistently to the fringe and temple edges twice daily and add a DHT-blocking shampoo 3× weekly as a second layer. Track whether a transplant consultation makes sense in the next 3-6 months for a comprehensive coverage strategy.'
                            : _hasSupplements && _hasDHTShampoo
                              ? 'Your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression for the remaining fringe and temporal hairline at NW6 — keep DHT shampoo on 3-5 minutes per wash 3× weekly and your supplement stack consistent. Add minoxidil to the fringe and temporal edges twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC three-layer approach for fringe hairline defense at this advanced stage. Book a transplant consultation to evaluate surgical coverage options alongside your OTC maintenance.'
                              : _hasDHTShampoo
                              ? 'At NW6, your DHT-blocking shampoo helps slow miniaturization of the remaining fringe and temporal edges — keep it up 3× weekly with 3-5 minutes of contact time. Add minoxidil to the fringe and temporal edges twice daily as the topical growth signal; DHT shampoo + minoxidil is the strongest dual-mechanism OTC approach for fringe defense at this stage. Book a transplant consultation to evaluate surgical coverage options alongside your OTC maintenance.'
                              : _hasSupplements && _hasMassage
                              ? (_hasLLLT
                                  ? 'At NW6, your supplement stack and LLLT device cover nutritional support and photobiomodulation for the remaining fringe and temporal hairline — keep your supplement routine consistent and maintain your LLLT sessions. Apply minoxidil to the fringe and temple edges immediately after your LLLT session while scalp circulation is elevated; add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Book a transplant consultation and consider a doctor consult about finasteride for systemic DHT suppression as the most impactful upgrade at this stage. Track with monthly front-facing photos.'
                                  : _hasMicroneedling
                                  ? 'At NW6, your supplement stack and microneedling cover nutritional support and scalp priming for the remaining fringe and temporal hairline — use microneedling 24-48 hours before any topical application along the fringe and temple edges to maximize absorption. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer and apply minoxidil to the fringe and temple edges twice daily for the topical growth signal. Book a transplant consultation and consider a doctor consult about finasteride for systemic DHT suppression as the most impactful upgrade at this stage. Track with monthly front-facing photos.'
                                  : 'At NW6, your supplement stack and scalp massage cover nutritional support and mechanical stimulation for the remaining fringe and temporal hairline — keep your supplement routine consistent and massage along the fringe and lateral edges. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; it is the most impactful addition to your existing stack where fringe coverage is limited at this advanced stage. Book a transplant consultation and consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly front-facing photos.')
                              : _hasSupplements
                              ? 'Your supplement stack supports remaining fringe follicle health at NW6 — keep biotin, zinc, and vitamin D consistent as nutritional support. Add minoxidil to the fringe and temporal edges twice daily as the most impactful topical addition at this stage; book a transplant consultation to evaluate surgical coverage options and how your supplement routine integrates with the full strategy.'
                              : 'At NW6 minoxidil applied to the fringe and temporal edges twice daily can still slow further recession — start this week alongside a DHT-blocking shampoo. Book a transplant consultation to evaluate surgical coverage options alongside your OTC protocol.')
              : data.stage === 'NW4'
                // NW4 hairline loss extends across the entire frontal zone (not just temple corners) — advice must reflect the full frontal hairline, not just "recession zones"
                ? (_hasFinasteride && _hasDHTShampoo && _hasMinoxidil && _hasMassage)
                    ? (_hasLLLT
                        ? 'NW4 frontal hairline with finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical protocol — apply minoxidil along the entire hairline edge immediately after your LLLT session while scalp circulation is elevated, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time daily without gaps. Consistent four-layer coverage over 4-6 months gives the strongest documented non-surgical hairline response at this established stage. Track with monthly front-facing photos.'
                        : _hasMicroneedling
                        ? 'NW4 frontal hairline with finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical protocol — wait 24-48 hours after each microneedling session before applying minoxidil along the entire hairline edge (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time daily without gaps. Consistent four-layer coverage over 4-6 months gives the strongest documented non-surgical hairline response at this established stage. Track with monthly front-facing photos.'
                        : 'NW4 frontal hairline with finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical protocol — apply minoxidil along the entire hairline edge immediately after each scalp massage, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time daily without gaps. Consistent four-layer coverage over 4-6 months gives the strongest documented non-surgical hairline response at this established stage. Track with monthly front-facing photos.')
                    : (_hasFinasteride && _hasDHTShampoo && _hasMinoxidil)
                      ? 'At NW4, finasteride + minoxidil + DHT shampoo delivers systemic and topical DHT suppression alongside the topical growth signal — apply minoxidil across the entire frontal zone twice daily, not just the temples, and leave DHT shampoo on 3-5 minutes per wash. Add a 4-minute scalp massage before each topical application as the highest-ROI mechanical layer to complete the protocol. Track with monthly front-facing photos.'
                      : (_hasFinasteride && _hasMinoxidil && _hasMassage)
                        ? (_hasLLLT
                            ? 'NW4 frontal hairline with finasteride + minoxidil + LLLT is a strong non-surgical protocol — apply minoxidil along the entire hairline edge immediately after your LLLT session while scalp circulation is elevated, and take finasteride at the same time daily without gaps. Uninterrupted consistency over 4-6 months is what separates stabilization from further retreat. Track with monthly front-facing photos.'
                            : _hasMicroneedling
                            ? 'NW4 frontal hairline with finasteride + minoxidil + microneedling is a strong non-surgical protocol — wait 24-48 hours after each microneedling session before applying minoxidil along the entire hairline edge (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; take finasteride at the same time daily without gaps. Uninterrupted consistency over 4-6 months is what separates stabilization from further retreat. Track with monthly front-facing photos.'
                            : 'NW4 frontal hairline with finasteride + minoxidil + massage is the most complete non-surgical protocol — apply minoxidil along the entire hairline edge immediately after each scalp massage, and take finasteride at the same time daily without gaps. Uninterrupted consistency over 4-6 months is what separates stabilization from further retreat. Track with monthly front-facing photos.')
                        : (_hasFinasteride && _hasMinoxidil)
                          ? 'At NW4, finasteride + minoxidil is the most evidence-backed non-surgical hairline combination — apply minoxidil across the entire frontal zone twice daily, not just the temples. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT suppression and a 4-minute scalp massage before each application to prime absorption along the hairline edge where DHT pressure is highest.'
                          : _hasFinasteride && _hasDHTShampoo
                            ? 'At NW4, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression across the frontal hairline — add minoxidil applied along the entire hairline edge twice daily (not just the temples) as the topical growth signal. Finasteride + minoxidil + DHT shampoo at NW4 is the strongest non-surgical hairline combination; consistent triple-layer coverage over 4-6 months gives the best documented response at this established stage.'
                          : _hasFinasteride
                            ? 'Finasteride provides systemic DHT suppression at NW4 — add minoxidil applied along the entire frontal hairline twice daily as the topical growth signal. Finasteride + minoxidil at NW4 is the strongest non-surgical approach; together they give the best documented hairline response at this established stage.'
                            : (_hasMinoxidil && _hasDHTShampoo && _hasMassage)
                              ? (_hasLLLT
                                  ? 'NW4 frontal hairline with minoxidil + DHT shampoo + LLLT covers topical growth signal, local DHT suppression, and photobiomodulation — apply minoxidil along the entire hairline edge immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes per wash. A doctor consult about finasteride adds systemic DHT suppression for the strongest long-term hairline response at this established stage. Track with monthly front-facing photos.'
                                  : _hasMicroneedling
                                  ? 'NW4 frontal hairline with minoxidil + DHT shampoo + microneedling covers topical growth signal, local DHT suppression, and scalp priming — wait 24-48 hours after each microneedling session before applying minoxidil along the entire hairline edge (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Leave DHT shampoo on 3-5 minutes per wash. A doctor consult about finasteride adds systemic DHT suppression for the strongest long-term hairline response at this established stage. Track with monthly front-facing photos.'
                                  : 'At NW4, minoxidil + DHT shampoo + scalp massage covers topical growth signal, local DHT suppression, and mechanical stimulation across the full frontal hairline — apply minoxidil along the entire hairline edge immediately after your scalp massage, and leave DHT shampoo on 3-5 minutes per wash. A doctor consult about finasteride adds systemic DHT suppression for the strongest long-term hairline response at this established stage. Track with monthly front-facing photos.')
                              : (_hasMinoxidil && _hasDHTShampoo && _hasSupplements)
                                ? 'Your supplement stack, minoxidil, and DHT-blocking shampoo cover nutritional follicle support, topical growth signal, and local DHT suppression across the full frontal hairline at NW4 — apply minoxidil along the entire hairline edge twice daily (not just the temples), leave DHT shampoo on 3-5 minutes per wash, and maintain your supplement routine consistently. Add a 4-minute scalp massage before each application and consider a doctor consult about finasteride, which significantly improves the hairline response at this established stage. Track with monthly front-facing photos.'
                              : (_hasMinoxidil && _hasDHTShampoo)
                                ? 'At NW4, minoxidil + DHT shampoo covers topical growth signal and local DHT suppression across the full frontal hairline — apply minoxidil along the entire hairline edge twice daily (not just the temples) and leave DHT shampoo on 3-5 minutes per wash. Add a 4-minute scalp massage before each application and consider a doctor consult about finasteride, which significantly improves the hairline response at this established stage. Track with monthly front-facing photos.'
                                : (_hasMinoxidil && _hasMassage)
                                  ? (_hasLLLT
                                      ? 'At NW4, your full frontal hairline needs coverage — apply minoxidil along the entire hairline edge and both temples twice daily immediately after your LLLT session while scalp circulation is elevated. If progress stalls, a doctor consult about finasteride adds systemic DHT suppression that significantly improves outcomes at this stage. Track with monthly front-facing photos.'
                                      : _hasMicroneedling
                                      ? 'At NW4, your full frontal hairline needs coverage — wait 24-48 hours after each microneedling session before applying minoxidil along the entire hairline edge and both temples (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; microneedling primes follicle absorption where DHT pressure is highest along the hairline edge. If progress stalls, a doctor consult about finasteride adds systemic DHT suppression that significantly improves outcomes at this stage. Track with monthly front-facing photos.'
                                      : 'At NW4, your full frontal hairline needs coverage — apply minoxidil along the entire hairline edge and both temples twice daily, right after your scalp massage. If progress stalls, a doctor consult about finasteride adds systemic DHT suppression that significantly improves outcomes at this stage. Track with monthly front-facing photos.')
                                  : _hasSupplements && _hasMinoxidil
                                    ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at NW4 where the full frontal hairline has retreated — apply minoxidil along the entire frontal hairline twice daily (not just the temples) and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer hairline approach at this established stage. A doctor consult about finasteride adds systemic DHT suppression for the most complete protocol at NW4. Track with monthly front-facing photos.'
                                  : _hasMinoxidil
                                    ? 'At NW4, extend minoxidil to the entire frontal hairline (not just the temples) twice daily. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression and a 3-minute scalp massage before each application to drive absorption. For stronger long-term results, consider a doctor consult about finasteride — systemic DHT suppression at NW4 meaningfully improves the hairline trajectory.'
                                    : _hasSupplements && _hasDHTShampoo
                                      ? 'Your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression at the full frontal hairline at NW4 — keep DHT shampoo on 3-5 minutes per wash and your supplement stack consistent. Add minoxidil applied along the entire frontal hairline twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC three-layer hairline combination at this established stage. A doctor consult about finasteride adds systemic DHT suppression for the most complete hairline protocol at NW4. Track with monthly front-facing photos.'
                                      : _hasDHTShampoo
                                      ? 'NW4 frontal recession — your DHT-blocking shampoo provides topical DHT suppression at the hairline edge, which is a solid foundation. Add minoxidil applied along the entire frontal hairline twice daily as the topical growth signal; DHT shampoo + minoxidil is the strongest OTC combination for hairline defense at NW4. A doctor consult about finasteride adds systemic DHT suppression for the most complete hairline protocol at this established stage. Track with monthly front-facing photos.'
                                      : _hasSupplements && _hasMassage
                                      ? (_hasLLLT
                                          ? 'At NW4, your supplement stack and LLLT device cover nutritional support and photobiomodulation across the full frontal hairline — keep your supplement routine consistent and maintain your LLLT sessions on schedule. Apply minoxidil along the entire frontal hairline immediately after your LLLT session while scalp circulation is elevated; add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. The combination of nutritional + photobiomodulation + DHT suppression gives the strongest non-Rx hairline response at this established stage. Consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly front-facing photos.'
                                          : _hasMicroneedling
                                          ? 'At NW4, your supplement stack and microneedling cover nutritional support and scalp priming across the full frontal hairline — use microneedling 24-48 hours before any topical application along the entire frontal hairline to prime absorption where DHT pressure is highest (applying immediately after needling risks follicle irritation). Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; the combination of nutritional + scalp priming + DHT suppression gives the strongest non-Rx hairline response at this established stage. Consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly front-facing photos.'
                                          : 'At NW4, your supplement stack and scalp massage cover nutritional support and mechanical stimulation across the full frontal hairline — keep your supplement routine consistent and apply a 4-minute scalp massage daily focusing on the entire frontal zone. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; it is the most impactful addition to your existing stack where the full frontal hairline has retreated at this established stage. Consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly front-facing photos.')
                                      : _hasSupplements
                                      ? 'Your supplement stack is supporting follicle health at NW4 where the full frontal hairline has retreated — biotin, zinc, and vitamin D are a good nutritional foundation. Add minoxidil applied along the entire frontal hairline twice daily as the topical growth signal; at NW4, combining nutritional support with a consistent topical approach gives the strongest non-surgical hairline response. Consider a doctor consult about finasteride for systemic DHT suppression to complete the protocol. Track with monthly front-facing photos.'
                                      : 'NW4 frontal recession responds best to minoxidil applied along the full hairline edge and both temples twice daily. Also consider talking to a doctor about finasteride — at NW4, finasteride + minoxidil gives the strongest evidence-based response for slowing recession. Start this week and track with monthly front-facing photos.'
                : data.stage === 'NW3v'
                // NW3v: dual-zone stage — temple recession AND early crown thinning — advice must address both zones simultaneously
                ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo && _hasMassage
                    ? (_hasLLLT
                        ? 'NW3v has two active zones and finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical protocol — apply 1ml minoxidil to both temple recession zones AND the vertex immediately after your LLLT session while scalp circulation is elevated, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time daily. Four-layer consistency over 3-4 months at this dual-zone stage gives the strongest realistic non-surgical response.'
                        : _hasMicroneedling
                        ? 'NW3v has two active zones and finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical protocol — wait 24-48 hours after each microneedling session before applying 1ml minoxidil to both temple recession zones AND the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time daily. Four-layer consistency over 3-4 months at this dual-zone stage gives the strongest realistic non-surgical response.'
                        : 'NW3v has two active zones and finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical protocol — apply 1ml minoxidil to both temple recession zones AND the vertex immediately after your scalp massage, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time daily. Four-layer consistency over 3-4 months at this dual-zone stage gives the strongest realistic non-surgical response.')
                    : _hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                    ? 'NW3v with finasteride + minoxidil + DHT shampoo delivers systemic DHT suppression, topical growth signal, and local DHT control across both active zones — add a 3-minute scalp massage before each minoxidil application covering temples AND vertex to prime absorption. Scalp massage is the highest-ROI upgrade to your existing three-layer protocol at this dual-zone stage.'
                    : _hasFinasteride && _hasMinoxidil && _hasMassage
                    ? (_hasLLLT
                        ? 'NW3v has two active zones and your finasteride + minoxidil + LLLT protocol is fully deployed — confirm 1ml minoxidil covers BOTH temple recession zones AND the vertex each session, applied immediately after your LLLT session while scalp circulation is elevated. Take finasteride at the same time daily; dual-zone consistency over 3-4 months converts this complete stack into visible results.'
                        : _hasMicroneedling
                        ? 'NW3v has two active zones and your finasteride + minoxidil + microneedling protocol is fully deployed — confirm 1ml minoxidil covers BOTH temple recession zones AND the vertex each session, but wait 24-48 hours after each microneedling session before applying (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal. Take finasteride at the same time daily; dual-zone consistency over 3-4 months converts this complete stack into visible results.'
                        : 'NW3v has two active zones and your finasteride + minoxidil + massage protocol is fully deployed — confirm 1ml minoxidil covers BOTH temple recession zones AND the vertex each session, applied right after your scalp massage. Take finasteride at the same time daily; dual-zone consistency over 3-4 months converts this complete stack into visible results.')
                    : _hasFinasteride && _hasMinoxidil
                    ? 'At NW3v two zones are thinning simultaneously and your finasteride + minoxidil is the right foundation — add a 4-minute scalp massage before each topical application, covering temples AND vertex. Mechanical stimulation is the highest-ROI addition to your finasteride + minoxidil stack at this dual-zone stage.'
                    : _hasFinasteride && _hasDHTShampoo
                    ? 'At NW3v, finasteride + DHT-blocking shampoo delivers dual-level DHT suppression across both active zones — systemic through finasteride and topical through the shampoo (3-5 min contact time 3× weekly). Add minoxidil to BOTH the temple recession zones AND the vertex twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the most complete non-surgical dual-zone protocol at this pivotal NW3v window. Track with monthly front-facing photos to monitor both active zones.'
                    : _hasFinasteride
                    ? 'Finasteride addresses the systemic DHT driving both active zones at NW3v — add minoxidil to BOTH the temple recession zones AND the vertex twice daily for targeted topical coverage. Dual-zone minoxidil alongside finasteride gives the strongest non-surgical response for this simultaneous two-front stage.'
                    : _hasMinoxidil && _hasMassage
                    ? (_hasLLLT
                        ? 'NW3v has two active zones — apply 1ml minoxidil to both temple recession zones AND directly to the vertex immediately after your LLLT session while scalp circulation is elevated. LLLT primes follicles across both active fronts simultaneously; add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression — it is the highest-ROI missing layer when minoxidil and LLLT are already in place at this dual-zone stage.'
                        : _hasMicroneedling
                        ? 'NW3v has two active zones — wait 24-48 hours after each microneedling session before applying minoxidil to both temple recession zones AND the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml per zone twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression across both active zones — it is the highest-ROI missing layer when minoxidil and microneedling are already in place at this dual-zone stage.'
                        : 'NW3v means temple recession AND early crown thinning are both active — apply 1ml minoxidil to both temple recession zones AND directly to the vertex immediately after each scalp massage so freshly primed follicles absorb it. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression across both active zones — it is the highest-ROI missing layer when minoxidil and massage are already in place at this dual-zone stage.')
                    : _hasMinoxidil && _hasDHTShampoo
                    ? 'NW3v temple recession AND early crown thinning with minoxidil and DHT-blocking shampoo covers the topical growth signal and local DHT control across both active zones — apply 1ml to both temple recession zones AND directly to the vertex twice daily, and leave the DHT shampoo on 3-5 minutes per wash. Add a 3-minute scalp massage before each minoxidil application to prime absorption at both active fronts; massage is the highest-ROI addition at this dual-zone stage.'
                    : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                    ? 'NW3v has two active zones and your supplement stack, minoxidil, and DHT-blocking shampoo covers nutritional follicle support, topical growth signal, and local DHT control across both fronts — confirm minoxidil reaches BOTH temple recession zones AND the vertex twice daily (1ml per zone), leave DHT shampoo on 3-5 minutes per wash, and keep your supplement routine consistent. Add a 3-minute scalp massage before each minoxidil application to prime absorption at both active fronts; massage is the highest-ROI upgrade to your existing three-layer OTC stack at this dual-zone stage. Track with monthly front-facing photos to monitor both zones.'
                    : _hasSupplements && _hasMinoxidil
                    ? 'NW3v is a dual-zone stage and your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal — confirm minoxidil reaches BOTH temple recession zones AND the vertex twice daily (1ml per zone) and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer hairline approach for this dual-zone stage where temple recession and early crown thinning are both active. Take monthly front-facing photos to track both zones.'
                    : _hasMinoxidil
                    ? 'At NW3v, two zones are thinning: temples and early crown. Apply minoxidil to both — 1ml per temple zone PLUS 1ml directly to the vertex twice daily. Add a 3-minute scalp massage before each application to open follicles in both areas to absorption.'
                    : _hasSupplements && _hasDHTShampoo
                    ? 'Your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression across both active zones at NW3v — keep DHT shampoo on 3-5 minutes per wash and your supplement stack consistent. Add minoxidil to BOTH the temple recession zones AND directly to the vertex twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil covers all three OTC hairline layers for this dual-zone stage where temple recession and early crown thinning are both active. Take monthly front-facing photos to track both zones.'
                    : _hasDHTShampoo
                    ? 'NW3v temple recession AND early crown thinning — your DHT-blocking shampoo provides local DHT suppression across both active zones, which is a solid start. Add minoxidil to BOTH the temple recession zones AND directly to the vertex twice daily as the topical growth signal; dual-zone coverage at this two-front stage addresses recession and early crown thinning simultaneously. Take monthly front-facing photos to track both zones.'
                    : _hasSupplements && _hasMassage
                    ? (_hasLLLT
                        ? 'NW3v has two active zones and your supplement stack and LLLT device cover nutritional support and photobiomodulation across both temple recession zones AND the early vertex — keep your supplement routine consistent and maintain your LLLT sessions. Add minoxidil to BOTH the temple recession zones AND the vertex twice daily immediately after your LLLT session while scalp circulation is elevated; NW3v follicles across both zones are still highly responsive and the full two-layer OTC approach gives the strongest realistic result. Track with monthly front-facing photos to monitor both zones.'
                        : _hasMicroneedling
                        ? 'NW3v has two active zones and your supplement stack and microneedling cover nutritional support and scalp priming across both temple recession zones AND the early vertex — wait 24-48 hours after each microneedling session before applying topicals to both zones (applying immediately after needling risks follicle irritation); on non-needling days keep consistent. Keep your supplement routine consistent. Add minoxidil to BOTH the temple recession zones AND the vertex twice daily; this two-layer OTC approach at NW3v targets both active fronts while follicles are still highly responsive. Track with monthly front-facing photos to monitor both zones.'
                        : 'NW3v has two active zones and your supplement stack and scalp massage cover nutritional support and mechanical stimulation across both temple recession zones AND the early vertex — keep your supplement routine consistent and apply a 4-minute scalp massage covering BOTH the temple recession zones AND the vertex daily. Add minoxidil to BOTH the temple recession zones AND the vertex twice daily immediately after your massage so freshly primed follicles absorb it; this two-layer OTC approach at NW3v targets both active fronts while follicles are still highly responsive. Track with monthly front-facing photos to monitor both zones.')
                    : _hasSupplements
                    ? 'Your supplement stack supports follicle health at NW3v where both temple recession AND early crown thinning are active — biotin, zinc, and vitamin D are a good nutritional foundation for a dual-zone stage. Add minoxidil to BOTH the temple recession zones AND directly to the vertex twice daily; at NW3v acting on both fronts simultaneously while the treatment window is open gives the strongest realistic response. Take monthly front-facing photos to track both zones.'
                    : 'NW3v is a dual-front stage: temples and crown are both starting to lose ground simultaneously. Start minoxidil on BOTH the temple recession zones AND the vertex now — dual coverage prevents both fronts from advancing independently, and acting at NW3v gives the strongest response window.')
                : data.stage === 'NW3'
                // NW3: deep bilateral temple recession past mid-pupil — established AGA; this is the strongest treatment response window
                ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo && _hasMassage
                    ? (_hasLLLT
                        ? 'NW3 deep temple recession with finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical protocol at this pivotal window — apply 1ml to each recession zone immediately after your LLLT session while scalp circulation is elevated, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time daily without gaps. This four-layer stack at the NW3 response window gives the best documented non-surgical results.'
                        : _hasMicroneedling
                        ? 'NW3 deep temple recession with finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical protocol at this pivotal window — wait 24-48 hours after each microneedling session before applying 1ml to each recession zone (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time daily without gaps. This four-layer stack at the NW3 response window gives the best documented non-surgical results.'
                        : 'NW3 deep temple recession with finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical protocol at this pivotal window — apply 1ml to each recession zone right after a 4-minute scalp massage, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time daily without gaps. This four-layer stack at the NW3 response window gives the best documented non-surgical results.')
                    : _hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                    ? 'NW3 is the strongest treatment response window and finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control at the recession edge — add a 4-minute scalp massage before each topical application to prime absorption where DHT pressure is highest. Confirm full 1ml coverage per recession zone, morning and night.'
                    : _hasFinasteride && _hasMinoxidil && _hasMassage
                    ? (_hasLLLT
                        ? 'NW3 deep temple recession with finasteride + minoxidil + LLLT is a strong non-surgical stack at this pivotal window — apply 1ml to each recession zone immediately after your LLLT session while scalp circulation is elevated, and take finasteride at the same time daily. This combination produces the best documented long-term results at NW3.'
                        : _hasMicroneedling
                        ? 'NW3 deep temple recession with finasteride + minoxidil + microneedling is a strong non-surgical stack at this pivotal window — wait 24-48 hours after each microneedling session before applying 1ml to each recession zone (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; take finasteride at the same time daily. This combination produces the best documented long-term results at NW3.'
                        : 'NW3 deep temple recession with finasteride + minoxidil + massage is the most complete non-surgical stack at this pivotal window — apply 1ml to each recession zone right after a 4-minute scalp massage and take finasteride at the same time daily. This combination produces the best documented long-term results at NW3.')
                    : _hasFinasteride && _hasMinoxidil
                    ? 'NW3 is a strong response window and your finasteride + minoxidil is the most evidence-backed combination — add a 4-minute scalp massage before each topical application to prime absorption at the recession edge. Confirm full 1ml coverage per side, morning and night.'
                    : _hasFinasteride && _hasDHTShampoo
                    ? 'At NW3, finasteride + DHT-blocking shampoo delivers both systemic and topical DHT suppression at the temple recession edge — leave DHT shampoo on 3-5 minutes per wash. Add minoxidil to both recession zones twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the most complete non-surgical hairline protocol at this pivotal response window. Track with monthly front-facing photos.'
                    : _hasFinasteride
                    ? 'Finasteride suppresses systemic DHT at NW3 — add minoxidil to both temple recession zones twice daily for the topical growth signal. NW3 is the strongest treatment window; finasteride + minoxidil together produce the best documented non-surgical results at this stage.'
                    : _hasMinoxidil && _hasMassage
                    ? (_hasLLLT
                        ? 'NW3 deep temple recession is established AGA — apply 1ml to each recession zone immediately after your LLLT session while scalp circulation is elevated, and confirm full 1ml coverage per side morning and night. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression at the recession edge — it is the highest-ROI missing layer when minoxidil and LLLT are already in place at this pivotal stage.'
                        : _hasMicroneedling
                        ? 'NW3 deep temple recession is established AGA — wait 24-48 hours after each microneedling session before applying minoxidil to the recession zones; applying immediately after needling risks follicle irritation. On non-needling days apply 1ml per side twice daily and confirm full coverage morning and night. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression at the recession edge — it is the highest-ROI missing layer when minoxidil and microneedling are already in place at this pivotal stage.'
                        : 'NW3 deep temple recession is established AGA — apply 1ml to each recession zone immediately after a 4-minute scalp massage and confirm full 1ml coverage per side morning and night. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression at the recession edge — it is the highest-ROI missing layer when minoxidil and massage are already in place at this pivotal stage.')
                    : _hasMinoxidil && _hasDHTShampoo
                    ? 'NW3 deep temple recession with minoxidil and DHT-blocking shampoo covers the topical growth signal and local DHT control at the recession edge — apply 1ml minoxidil to each zone twice daily and leave DHT shampoo on 3-5 minutes per wash. Add a 4-minute scalp massage before each minoxidil application to prime absorption where DHT pressure is highest; massage completes the triple OTC stack at this pivotal stage.'
                    : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                    ? 'NW3 deep temple recession with your supplement stack, minoxidil, and DHT-blocking shampoo covers nutritional follicle support, topical growth signal, and local DHT control at the recession edge — apply 1ml to each recession zone twice daily, leave DHT shampoo on 3-5 minutes per wash, and keep your supplement routine consistent. Add a 4-minute scalp massage before each minoxidil application to prime absorption where DHT pressure is highest; this OTC three-layer stack at the NW3 response window gives the strongest realistic non-surgical result. Track with monthly front-facing photos.'
                    : _hasSupplements && _hasMinoxidil
                    ? 'NW3 deep temple recession with your supplement stack and minoxidil covers nutritional follicle support and the topical growth signal at this established stage — apply 1ml to each recession zone twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression at the recession edge; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer hairline approach at this pivotal response window where follicles are still highly responsive. Track with monthly front-facing photos.'
                    : _hasMinoxidil
                    ? 'NW3 temple recession extends past mid-pupil — this is an active phase but still a strong response window. Apply 1ml to each temple recession zone twice daily and add a 4-minute scalp massage after each application to maximize absorption where DHT pressure is highest.'
                    : _hasSupplements && _hasDHTShampoo
                    ? 'Your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression at the temple recession edge at NW3 — keep DHT shampoo on 3-5 minutes per wash and your supplement stack consistent. Add minoxidil on both temple recession zones twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil covers all three OTC hairline layers at the strongest treatment response window. NW3 follicles at the recession edge are still viable and highly responsive — acting now with the full stack gives the best long-term outcome. Track with monthly front-facing photos.'
                    : _hasDHTShampoo
                    ? 'NW3 deep temple recession — your DHT-blocking shampoo provides local DHT suppression at the recession edge, which is a solid start. Add minoxidil on both temple zones twice daily for the topical growth signal; the two-layer approach (topical growth + DHT suppression) addresses recession from both angles at this strong response window. Track with monthly front-facing photos.'
                    : _hasSupplements && _hasMassage
                    ? (_hasLLLT
                        ? 'At NW3, your supplement stack and LLLT device cover nutritional support and photobiomodulation at the temple recession edge — keep your supplement routine consistent and apply minoxidil to both temple recession zones immediately after your LLLT session while scalp circulation is elevated. NW3 is the strongest treatment response window and follicles at the recession edge are still highly responsive; add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer to complete the three-layer OTC approach. Track with monthly front-facing photos.'
                        : _hasMicroneedling
                        ? 'At NW3, your supplement stack and microneedling cover nutritional support and scalp priming at the temple recession edge — wait 24-48 hours after each microneedling session before applying minoxidil to the recession zones (applying immediately after needling risks follicle irritation); on non-needling days apply 1ml per zone twice daily as normal. Keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; NW3 is the strongest response window and follicles at the recession edge are still highly responsive. Track with monthly front-facing photos.'
                        : 'At NW3, your supplement stack and scalp massage cover nutritional support and mechanical stimulation at the temple recession edge — keep your supplement routine consistent and apply a 4-minute scalp massage at both recession zones daily. Add minoxidil to both temple recession zones twice daily immediately after each massage so freshly primed follicles absorb it; NW3 is the strongest response window and follicles at the recession edge are still highly responsive. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Track with monthly front-facing photos.')
                    : _hasSupplements
                    ? 'Your supplement stack supports follicle health at NW3 where temple recession extends past mid-pupil — biotin, zinc, and vitamin D are a good nutritional foundation. Add minoxidil to both temple recession zones twice daily as the topical growth signal; NW3 is the strongest response window and combining nutritional support with a consistent topical approach while follicles at the recession edge are still viable gives the best realistic outcome. Track with monthly front-facing photos.'
                    : 'NW3 deep temple recession responds well to action now — follicles at the recession edge are still viable and highly responsive. Start minoxidil on both temple zones twice daily, add a 4-minute scalp massage per application, and track with monthly front-facing photos from the same angle.')
                : data.stage === 'NW2'
                // NW2: earliest detectable stage — preventive window; best long-term outcome comes from acting here
                ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                    ? 'NW2 with finasteride + minoxidil + DHT-blocking shampoo is the most complete preventive stack at the ideal early detectable stage — keep all three consistent and take monthly front-facing photos to catch any further M-shape deepening the moment it begins. This is the strongest three-layer non-surgical hairline protection at this window.'
                    : _hasFinasteride && _hasMinoxidil
                    ? 'NW2 temple recession with finasteride + minoxidil is the strongest dual-mechanism approach at the ideal preventive stage — keep both consistent. Add a DHT-blocking shampoo 3× weekly as the topical DHT suppression layer, and take monthly front-facing photos to catch any further M-shape deepening early.'
                    : _hasFinasteride && _hasDHTShampoo
                    ? 'NW2 temple recession with finasteride + DHT-blocking shampoo gives dual-level DHT suppression — systemic and topical — at the ideal preventive stage. Leave DHT shampoo on 3-5 minutes before rinsing. Add minoxidil directly to both temple corners twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the strongest non-surgical hairline protection at this earliest-detectable window. Take monthly front-facing photos to catch any further M-shape deepening.'
                    : _hasFinasteride
                    ? 'Finasteride is already suppressing systemic DHT at NW2 — add minoxidil directly to both temple corners twice daily for the topical growth signal. Finasteride + minoxidil at the earliest detectable stage gives the strongest long-term protection before the M-shape deepens further.'
                    : (_hasMinoxidil && _hasMassage)
                    ? (_hasLLLT
                        ? 'NW2 temple recession with minoxidil and LLLT covers topical growth signal and photobiomodulation at the ideal preventive stage — apply minoxidil to both temple corners immediately after your LLLT session so follicles primed by the light therapy absorb it. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression layer to complete the triple OTC approach before the M-shape deepens further.'
                        : _hasMicroneedling
                        ? 'NW2 temple recession with minoxidil and microneedling covers topical growth signal and scalp priming at the ideal preventive stage — wait 24-48 hours after each microneedling session before applying minoxidil to both temple corners (applying immediately risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression layer to complete the triple OTC approach before the M-shape deepens further.'
                        : 'NW2 temple recession with minoxidil and scalp massage covers topical growth signal and mechanical stimulation at the ideal preventive stage — apply minoxidil to both temple corners immediately after your scalp massage so freshly stimulated follicles absorb it. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression layer to complete the triple OTC approach before the M-shape deepens further.')
                    : _hasMinoxidil && _hasDHTShampoo
                    ? 'NW2 temple recession with minoxidil and DHT-blocking shampoo covers the topical growth signal and local DHT suppression at the ideal preventive stage — leave DHT shampoo on 3-5 minutes before rinsing and confirm twice-daily minoxidil coverage on both temple corners. The highest-ROI next step is a doctor consult about finasteride for systemic DHT suppression.'
                    : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                    ? 'NW2 temple recession with your supplement stack, minoxidil, and DHT-blocking shampoo is the complete OTC preventive triple-layer approach at the ideal early detectable stage — apply minoxidil to both temple corners twice daily, leave DHT shampoo on 3-5 minutes per wash, and keep your supplement routine consistent. This three-layer OTC stack at NW2 gives the strongest non-Rx hairline prevention. Take monthly front-facing photos to catch any further M-shape deepening early; the highest-ROI remaining upgrade is a doctor consult about finasteride for systemic DHT suppression.'
                    : _hasSupplements && _hasMinoxidil
                    ? 'NW2 temple recession with your supplement stack and minoxidil covers nutritional follicle support and the topical growth signal at the ideal preventive stage — apply minoxidil to both temple corners twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression layer to complete the OTC triple-layer approach; supplements + minoxidil + DHT shampoo is the strongest non-Rx hairline preventive stack at this earliest-detectable window. Take monthly front-facing photos to catch any further M-shape deepening early.'
                    : _hasMinoxidil
                    ? 'NW2 is the ideal preventive stage and your minoxidil is already on the temple corners — good call. Keep it consistent twice daily and add a DHT-blocking shampoo 3× weekly as a complementary prevention layer to slow the M-shape from deepening further.'
                    : _hasSupplements && _hasDHTShampoo
                    ? 'Your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression at the earliest-detectable temple recession at NW2 — keep DHT shampoo on 3-5 minutes per wash and your supplement stack consistent. Add minoxidil directly to both temple corners twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil forms the complete three-layer OTC hairline protocol at this ideal preventive stage. NW2 follicles at the temple corners are fully viable — acting with the full stack at the earliest stage gives the strongest long-term protection. Take monthly front-facing photos to catch any further M-shape deepening early.'
                    : _hasDHTShampoo
                    ? 'NW2 temple recession is the earliest warning sign — your DHT-blocking shampoo provides topical DHT protection at the temple edges, which is a good start. Add minoxidil directly to both temple corners twice daily as the topical growth signal; minoxidil + DHT shampoo addresses recession from two angles at this ideal preventive window. Take monthly front-facing photos to catch any further M-shape deepening.'
                    : _hasSupplements && _hasMassage
                    ? (_hasLLLT
                        ? 'At NW2, your supplement stack and LLLT device cover nutritional support and photobiomodulation at the temple corners — keep your supplement routine consistent and maintain your LLLT sessions on schedule. Add minoxidil directly to both temple corners twice daily as the topical growth signal; NW2 follicles at the temple corners are fully viable — acting with the full two-layer OTC stack at the earliest-detectable stage gives the strongest long-term hairline protection. Take monthly front-facing photos to catch any further M-shape deepening early.'
                        : _hasMicroneedling
                        ? 'At NW2, your supplement stack and microneedling cover nutritional support and scalp priming at the temple corners — wait 24-48 hours after each microneedling session before applying any topicals to the temple corners (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily. Keep your supplement routine consistent. Add minoxidil directly to both temple corners as the topical growth signal; NW2 is the ideal preventive window and follicles are fully viable. Take monthly front-facing photos to catch any further M-shape deepening early.'
                        : 'At NW2, your supplement stack and scalp massage cover nutritional support and mechanical stimulation at the temple corners — keep your supplement routine consistent and apply a 4-minute scalp massage at both temple corners daily. Add minoxidil directly to both temple corners twice daily immediately after your massage so freshly stimulated follicles absorb it; NW2 is the ideal preventive window and follicles are fully viable — acting with the full two-layer OTC stack now gives the strongest long-term hairline protection. Take monthly front-facing photos to catch any further M-shape deepening early.')
                    : _hasSupplements
                    ? 'Your supplement stack is supporting follicle health at NW2 where slight temple recession has just appeared — biotin, zinc, and vitamin D are a good nutritional foundation. Add minoxidil directly to both temple corners twice daily as the topical growth signal; NW2 is the ideal preventive window and acting on both nutritional and topical layers now gives the strongest long-term hairline protection. Take monthly front-facing photos to catch any further M-shape deepening early.'
                    : 'NW2 temple recession is the earliest warning sign — and the best treatment window. Start minoxidil directly on both temple corners twice daily this week. At NW2, follicles are fully viable and early intervention produces the strongest long-term results. Take a monthly front-facing photo to catch any further change early.')
                : data.stage === 'NW1'
                // NW1: no recession exists — advice must be preventive, not treatment-focused
                ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                    ? 'Your hairline is fully intact at NW1 with finasteride + minoxidil + DHT-blocking shampoo — the most complete preventive stack available. No recession zone exists to target; your finasteride and DHT shampoo are the primary hairline protection layers, while minoxidil supports general scalp health. Take monthly front-facing photos from the same angle so any early M-shape at either temple is caught the moment it begins — the NW1→NW2 transition window is the highest-ROI moment to act if change ever starts.'
                    : _hasFinasteride && _hasMinoxidil
                    ? 'Your hairline is fully intact at NW1 with finasteride + minoxidil active — finasteride is your primary hairline protection layer through systemic DHT suppression, and minoxidil supports general scalp health. No recession zone exists to target. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical-level DHT control complement to complete the dual-mechanism prevention stack; take monthly front-facing photos to catch any early M-shape the moment it begins.'
                    : _hasFinasteride && _hasDHTShampoo
                    ? 'Your hairline is fully intact at NW1 and finasteride + DHT-blocking shampoo gives you the strongest dual-level prevention stack — take monthly front-facing photos so any early M-shape at either temple is caught the moment it begins. That NW1→NW2 transition window is the highest-ROI time to intensify coverage if change ever starts.'
                    : _hasFinasteride
                      ? 'Finasteride is already blocking DHT systemically at NW1 — add a DHT-blocking shampoo 3× weekly for the complementary topical-level prevention layer. Together they form the most complete non-surgical hairline protection at this early stage; take monthly front-facing photos to catch any early M-shape deepening.'
                      : _hasMinoxidil && _hasDHTShampoo
                        ? 'Your hairline is fully intact at NW1 with minoxidil and DHT-blocking shampoo active — the DHT shampoo is the primary hairline protection layer at this intact stage (3× weekly, 3-5 min contact time). No active recession zone exists to target. Take monthly front-facing photos from the same angle; catching any early M-shape at the NW1→NW2 transition gives the strongest possible response window. A doctor consult about finasteride adds systemic DHT suppression for the most complete dual-level prevention stack at NW1.'
                        : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                          ? 'Your hairline is fully intact at NW1 with supplements, minoxidil, and DHT-blocking shampoo — a comprehensive OTC preventive stack. The DHT shampoo is the primary hairline protection layer at this intact stage (3× weekly, 3-5 min contact time); minoxidil supports general scalp health and your supplement routine provides nutritional foundation. No active recession zone exists to target. Take monthly front-facing photos from the same angle so any early M-shape at either temple is caught the moment it begins — the NW1→NW2 transition window is the highest-ROI moment to act if change ever starts.'
                        : _hasSupplements && _hasMinoxidil
                          ? 'Your hairline is fully intact at NW1 with supplements and minoxidil active — your supplement stack provides nutritional follicle support and minoxidil maintains general scalp health before any recession begins. The primary hairline prevention layer at this stage is DHT suppression: add a DHT-blocking shampoo 3× weekly (3-5 min contact time) to complete the preventive stack. Take monthly front-facing photos from the same angle so any early M-shape at either temple is caught the moment it begins — the NW1→NW2 transition is the highest-ROI window to act if change ever starts.'
                        : _hasMinoxidil
                          ? 'Your hairline is intact at NW1 — minoxidil supports general scalp health but the primary prevention layer for hairline protection is DHT suppression. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical-level DHT control layer alongside your existing routine. Take monthly front-facing photos to catch any early M-shape the moment it begins; acting at NW1 costs far less effort than treating established recession later.'
                          : _hasSupplements && _hasDHTShampoo
                            ? 'Your hairline is fully intact at NW1 with supplements and DHT-blocking shampoo providing nutritional support and topical DHT control — a solid preventive foundation. Keep DHT shampoo 3× weekly with 3-5 minutes of contact time and your supplements consistent. Take monthly front-facing photos from the same angle; catching any early M-shape at the NW1→NW2 transition gives the strongest possible intervention window if change ever begins.'
                            : _hasSupplements && _hasMassage
                              ? (_hasLLLT
                                  ? 'Your hairline is fully intact at NW1 with your supplement stack and LLLT device covering nutritional support and photobiomodulation — keep your supplement routine consistent and maintain your LLLT sessions on schedule. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-prevention layer; at NW1 prevention costs far less effort than treating established recession later. Take monthly front-facing photos to catch any early M-shape the moment it begins.'
                                  : _hasMicroneedling
                                  ? 'Your hairline is fully intact at NW1 with your supplement stack and microneedling covering nutritional support and scalp priming — keep your supplement routine consistent and wait 24-48 hours after each microneedling session before applying any topicals. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-prevention layer; at NW1 prevention costs far less effort than treating established recession later. Take monthly front-facing photos to catch any early M-shape the moment it begins.'
                                  : 'Your hairline is fully intact at NW1 with your supplement stack and scalp massage covering nutritional support and mechanical stimulation — keep your supplement routine consistent and apply a 4-minute scalp massage daily. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-prevention layer; at NW1 prevention costs far less effort than treating established recession later. Take monthly front-facing photos to catch any early M-shape the moment it begins.')
                            : _hasSupplements
                              ? 'Your hairline is fully intact at NW1 — your supplement stack (biotin, zinc, vitamin D) supports follicle nutrition before any recession begins. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-prevention layer to complement your supplement routine. Take monthly front-facing photos to catch any early M-shape the moment it begins; acting at NW1 costs far less effort than treating established recession later.'
                              : _hasDHTShampoo
                                ? 'Your hairline is fully intact at NW1 — keep it that way. Stay consistent with your DHT-blocking shampoo 3× weekly and take monthly front-facing photos; catching any early M-shape at NW1 gives the best possible intervention window if change ever begins.'
                                : 'Your hairline is fully intact at NW1 — protect it before any recession starts. Add a DHT-blocking shampoo 3× weekly now. Prevention at this stage costs far less effort than treating established recession later.')
                : data.stage === 'n/a (female)'
                // n/a (female): female-pattern loss typically spares the frontal hairline; a lower hairline score here indicates Ludwig III frontal type with diffuse thinning behind the hairline edge — temple recession advice does not apply
                ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                    ? "Female-pattern frontal thinning with finasteride + minoxidil + DHT-blocking shampoo covers systemic DHT suppression, topical growth signal, and topical DHT control — spread minoxidil evenly across the frontal hair band behind the hairline edge (not the temples) twice daily and leave DHT shampoo on 3-5 minutes on wash days. A ferritin, thyroid, and hormone panel remains the highest-ROI investigation: a reversible hormonal cause can produce rapid improvement beyond what your current triple-layer protocol achieves alone."
                    : _hasFinasteride && _hasMinoxidil
                    ? "Female-pattern frontal thinning with finasteride + minoxidil covers DHT suppression and the topical growth signal — spread minoxidil evenly across the frontal hair band behind the hairline edge (not the temples) twice daily. A ferritin, thyroid, and hormone panel remains the highest-ROI investigation: a reversible hormonal cause can produce rapid improvement beyond what your current protocol achieves alone."
                    : _hasFinasteride
                      ? "Finasteride is an active part of your female-pattern routine and provides DHT suppression for frontal thinning — add minoxidil applied evenly across the frontal scalp behind the hairline edge (not just the temples) twice daily. A ferritin, thyroid, and hormone panel is still the highest-ROI investigation: treating a reversible hormonal cause alongside your current protocol gives the strongest combined response."
                      : _hasMinoxidil && _hasDHTShampoo
                        ? "Female-pattern thinning with minoxidil + DHT-blocking shampoo covers topical growth signal and local DHT suppression at the frontal band — spread minoxidil evenly across the frontal scalp behind the hairline edge (not the temples) twice daily and leave DHT shampoo on 3-5 minutes on wash days. A ferritin, thyroid, and hormone panel is still the highest-ROI investigation for a reversible cause that your current protocol alone cannot address."
                        : _hasMinoxidil
                          ? "Female-pattern thinning rarely recedes the hairline like male AGA — your minoxidil is the right tool. Spread coverage evenly across the frontal hair band behind the hairline edge (not the temples) twice daily and take monthly front-facing photos to track any change along the parting line."
                          : _hasDHTShampoo
                            ? "DHT-blocking shampoo is active in your female-pattern routine — add minoxidil applied evenly across the frontal scalp behind the hairline edge (not the temples) twice daily. Check ferritin, thyroid, and hormones; a reversible nutritional or hormonal cause is common and combining your DHT shampoo with minoxidil covers both the local DHT suppression and topical growth signal layers."
                            : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                              ? "Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for female-pattern frontal thinning — spread minoxidil evenly across the frontal hair band behind the hairline edge (not the temples) twice daily, leave DHT shampoo on 3-5 minutes on wash days, and keep your supplement routine consistent. A ferritin, thyroid, and hormone panel remains the highest-ROI investigation: a reversible hormonal cause in women can produce improvement beyond what your current OTC stack achieves alone."
                              : _hasSupplements && _hasMassage
                              ? (_hasLLLT
                                  ? "Your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation for female-pattern frontal thinning — keep your supplement routine consistent and maintain your LLLT sessions on schedule. Apply any topicals across the frontal scalp behind the hairline edge (not the temples) immediately after your LLLT session while scalp circulation is elevated. Add minoxidil twice daily as the topical growth signal; also check ferritin, thyroid, and hormones — a reversible hormonal cause in women can produce improvement beyond what topicals alone achieve."
                                  : _hasMicroneedling
                                  ? "Your supplement stack and microneedling cover nutritional follicle support and scalp priming for female-pattern frontal thinning — wait 24-48 hours after each microneedling session before applying topicals to the frontal scalp behind the hairline edge (not the temples; applying immediately after needling risks follicle irritation); on non-needling days apply as normal. Add minoxidil twice daily as the topical growth signal; also check ferritin, thyroid, and hormones — a reversible hormonal cause in women can produce improvement beyond what topicals alone achieve."
                                  : "Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation for female-pattern frontal thinning — keep your supplement routine consistent and massage the frontal scalp daily. Add minoxidil applied evenly across the frontal hair band behind the hairline edge (not the temples) twice daily as the topical growth signal; also check ferritin, thyroid, and hormones — a reversible hormonal cause is common in women and treating it alongside your supplement routine produces improvement that topicals alone cannot achieve.")
                              : _hasSupplements
                              ? "Your supplement stack (biotin, zinc, vitamin D) supports follicle health with female-pattern thinning — a good nutritional foundation. The highest-ROI addition is minoxidil applied evenly across the frontal scalp behind the hairline edge (not the temples) twice daily. Also check ferritin, thyroid, and hormones; a reversible hormonal or nutritional cause is common in women and treating it alongside your supplement routine produces faster, lasting improvement."
                              : "Female-pattern thinning at the frontal hair band responds best to minoxidil applied evenly across the frontal scalp — not the temples. Start twice daily and check ferritin, thyroid, and hormones; a reversible nutritional or hormonal cause is common and fixing it produces improvements topicals alone cannot achieve.")
                : data.stage === 'diffuse'
                // diffuse: uniform thinning WITHOUT temple recession — hairline is typically preserved; a lower hairline score means frontal scalp-top thinning (not classic M-shape recession), so temple-specific advice is wrong here
                ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                    ? "Diffuse frontal thinning with finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and topical DHT control — ensure minoxidil covers the full frontal scalp (not just the temples) twice daily and leave the DHT shampoo on 3-5 minutes before rinsing. A ferritin, thyroid, and vitamin D workup can still rule out a reversible nutritional cause that DHT suppression alone won't address."
                    : _hasFinasteride && _hasMinoxidil
                      ? "Diffuse frontal thinning with finasteride + minoxidil addresses DHT suppression and the topical growth signal — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) and ensure minoxidil covers the full frontal scalp rather than just the temples. A ferritin, thyroid, and vitamin D workup is still worthwhile to rule out a reversible nutritional component alongside the diffuse pattern."
                      : _hasFinasteride
                        ? "Finasteride provides systemic DHT suppression for diffuse frontal thinning — add minoxidil across the full frontal scalp twice daily (not just the temples) and a DHT-blocking shampoo 3× weekly. A ferritin, thyroid, and vitamin D workup can rule out a reversible cause that amplifies the diffuse pattern beyond what DHT suppression alone can address."
                        : _hasMinoxidil && _hasDHTShampoo
                          ? "Diffuse thinning typically spares the hairline — a lower hairline score here reflects frontal scalp-top thinning rather than classic temple recession. Your minoxidil and DHT shampoo are the right tools; ensure minoxidil covers the full frontal scalp (not just the temples) twice daily and leave the DHT shampoo on 3-5 minutes before rinsing. A ferritin, thyroid, and vitamin D workup can rule out a reversible cause that topicals alone won't fix."
                          : _hasMinoxidil
                            ? "Diffuse thinning typically preserves the hairline — if your hairline score is lower, it reflects frontal scalp-top thinning rather than temple recession. Apply minoxidil across the full frontal scalp twice daily, not just the temple corners. Add a DHT-blocking shampoo 3× weekly and consider a ferritin, thyroid, and vitamin D workup to check for a reversible root cause."
                            : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                              ? "Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for diffuse frontal thinning — apply minoxidil across the full frontal scalp (not just the temples) twice daily, leave DHT shampoo on 3-5 minutes before rinsing, and keep your supplement routine consistent. Investigate ferritin, thyroid, and vitamin D alongside your three-layer stack; a reversible nutritional or hormonal cause is common with diffuse loss and treating it produces improvement beyond what topicals alone achieve."
                              : _hasSupplements && _hasMassage
                              ? (_hasLLLT
                                  ? "Your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation for diffuse frontal thinning — keep your supplement routine consistent and maintain your LLLT sessions on schedule. Apply any topicals across the full frontal scalp (not just the temples) immediately after your LLLT session while scalp circulation is elevated. Add minoxidil twice daily and a DHT-blocking shampoo 3× weekly; also investigate ferritin, thyroid, and vitamin D — a reversible nutritional or hormonal cause is common with diffuse loss and treating it alongside your current protocol significantly improves the topical response."
                                  : _hasMicroneedling
                                  ? "Your supplement stack and microneedling cover nutritional follicle support and scalp priming for diffuse frontal thinning — wait 24-48 hours after each microneedling session before applying topicals to the frontal scalp (not just the temples; applying immediately after needling risks follicle irritation); on non-needling days apply across the full frontal scalp as normal. Add minoxidil twice daily and a DHT-blocking shampoo 3× weekly; also investigate ferritin, thyroid, and vitamin D — a reversible nutritional or hormonal cause is common with diffuse loss and treating it alongside your current protocol significantly improves the topical response."
                                  : "Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation for diffuse frontal thinning — keep your supplement routine consistent and apply your scalp massage across the full frontal scalp daily. Add minoxidil applied across the full frontal scalp (not just the temples) twice daily and a DHT-blocking shampoo 3× weekly; also investigate ferritin, thyroid, and vitamin D — a reversible nutritional or hormonal cause is common with diffuse loss and treating it alongside your supplement routine can significantly improve the topical response.")
                              : _hasSupplements
                              ? "Your supplement stack (biotin, zinc, vitamin D) supports follicle health with diffuse thinning — a solid nutritional foundation. The next step is minoxidil applied across the full frontal scalp twice daily (not just the temples) and a DHT-blocking shampoo 3× weekly. Also investigate ferritin, thyroid, and vitamin D; a reversible nutritional or hormonal cause is common with diffuse loss and treating it alongside your supplement routine can significantly improve the topical response."
                              : "Diffuse thinning typically spares the frontal hairline — a lower hairline score here reflects frontal scalp-top thinning, not classic temple recession. Start minoxidil applied across the full frontal scalp twice daily, add a DHT-blocking shampoo 3× weekly, and investigate ferritin, thyroid, and vitamin D; identifying and treating a reversible cause improves topical response significantly.")
                : (_hasMinoxidil && _hasMassage)
                  ? 'Minoxidil and scalp massage are both active — maximize impact by parting your hair to expose receding temple zones before applying, ensuring full 1ml coverage per side, morning and night.'
                  : _hasMinoxidil
                    ? 'Your minoxidil is active — maximize coverage across both recession zones twice daily and add a 3-minute scalp massage post-application to boost absorption.'
                    : 'Apply minoxidil directly to your recession zones every morning and night — temple consistency is the highest-leverage habit right now.',
          Density: _isNW7
            ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                ? 'At NW7, your finasteride + minoxidil + DHT-blocking shampoo delivers systemic DHT suppression, topical growth signal, and local DHT control for the remaining fringe — keep all three consistent without gaps. Apply minoxidil to the fringe and lateral edges twice daily, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time each day. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist consultation to evaluate candidacy, donor supply, and how your triple-layer protocol complements the surgical coverage plan.'
                : _hasFinasteride && _hasDHTShampoo
                ? 'At NW7, your finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression for the remaining fringe — keep both consistent without gaps. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist consultation to evaluate candidacy and how your dual-layer DHT protocol complements the surgical coverage plan.'
                : _hasFinasteride && _hasMinoxidil
                ? 'At NW7, your finasteride + minoxidil provides systemic DHT suppression and a topical growth signal for the remaining fringe — keep both consistent without gaps. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist consultation to evaluate candidacy and how your dual-layer protocol complements the surgical coverage plan.'
                : _hasFinasteride
                ? 'At NW7, your finasteride helps protect remaining fringe density from further miniaturization — keep it consistent without gaps. The primary path for meaningful coverage is surgical (FUE/FUT or SMP); prioritize a trichologist consultation to evaluate candidacy and how your systemic treatment complements the surgical coverage plan.'
                : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                ? 'At NW7, your supplement stack, minoxidil, and DHT-blocking shampoo provide nutritional support, topical growth signal, and local DHT suppression for the remaining fringe — apply minoxidil to the fringe and lateral edges twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement stack consistent. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist consultation to evaluate candidacy, donor supply, and how your three-layer OTC protocol integrates with the surgical coverage plan.'
                : _hasSupplements && _hasDHTShampoo
                ? 'Your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression for the remaining fringe at NW7 — keep DHT shampoo on 3-5 minutes per wash 3× weekly and your supplement stack consistent. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist consultation to evaluate candidacy, donor supply, and how your nutritional and topical DHT protocol integrates with the surgical coverage plan.'
                : _hasSupplements && _hasMinoxidil
                ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for the remaining fringe at NW7 — apply minoxidil to the fringe and lateral edges twice daily and keep your supplement routine consistent. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist consultation to evaluate candidacy, donor supply, and how your nutritional and topical protocol complements the surgical coverage plan.'
                : _hasMinoxidil && _hasDHTShampoo
                ? 'Your minoxidil + DHT-blocking shampoo provides a topical growth signal and local DHT suppression for the remaining fringe at NW7 — apply minoxidil to the fringe and lateral edges twice daily and leave DHT shampoo on 3-5 minutes per wash. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist consultation to evaluate candidacy and how your dual-layer topical protocol complements the surgical coverage plan.'
                : _hasDHTShampoo
                ? 'Your DHT-blocking shampoo helps slow miniaturization of the remaining fringe at NW7 — keep using it 3× weekly with 3-5 minutes of contact time. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist or transplant consultation to evaluate candidacy and realistic coverage outcomes alongside your OTC routine.'
                : _hasMinoxidil
                ? 'Your minoxidil helps maintain remaining fringe density at NW7 — keep applying it consistently. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist or transplant consultation to evaluate candidacy and how your topical protocol complements the surgical coverage plan.'
                : _hasSupplements && _hasMassage
                ? (_hasLLLT
                    ? 'Your supplement stack and LLLT cover nutritional support and photobiomodulation for the remaining fringe at NW7 — keep your supplement routine consistent and maintain your LLLT sessions on schedule. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist or transplant consultation to evaluate candidacy, donor supply, and how your nutritional and photobiomodulation protocol integrates with the surgical coverage plan.'
                    : _hasMicroneedling
                    ? 'Your supplement stack and microneedling cover nutritional support and scalp priming for the remaining fringe at NW7 — keep your supplement routine consistent and use microneedling 24-48 hours before any topical application along the fringe to prime absorption. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist or transplant consultation to evaluate candidacy, donor supply, and how your nutritional and scalp priming protocol integrates with the surgical coverage plan.'
                    : 'Your supplement stack and scalp massage cover nutritional support and mechanical stimulation for the remaining fringe at NW7 — keep your supplement routine consistent and massage along the fringe and lateral edges daily. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist or transplant consultation to evaluate candidacy, donor supply, and how your current protocol integrates with the surgical coverage plan.')
                : _hasSupplements
                ? 'Your supplement stack supports remaining fringe follicle health at NW7 — keep biotin, zinc, and vitamin D consistent as nutritional support for fringe density. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist or transplant consultation to evaluate candidacy and how your nutritional protocol integrates with the surgical coverage plan.'
                : 'At NW7, density restoration is best addressed through surgical options — keep any active OTC routine consistent and prioritize a trichologist or transplant consultation to evaluate FUE/FUT or SMP coverage for the thinning zones.')
            : _isNW5only
              ? (_hasFinasteride && _hasDHTShampoo && _hasMinoxidil && _hasMassage
                  ? (_hasLLLT
                      ? 'At NW5, finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical density protocol — finasteride handles systemic DHT suppression across both frontal and crown loss zones. Apply minoxidil immediately after your LLLT session while scalp circulation is elevated, leave DHT shampoo on 3-5 minutes before rinsing, and take finasteride at the same time each day. Track progress with monthly overhead photos; this four-layer protocol gives the strongest documented non-surgical density response at NW5.'
                      : _hasMicroneedling
                      ? 'At NW5, finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical density protocol — finasteride handles systemic DHT suppression across both frontal and crown loss zones. Wait 24-48 hours after each microneedling session before applying minoxidil (applying immediately after needling risks follicle irritation); on non-needling days apply across both thinning fronts twice daily as normal. Leave DHT shampoo on 3-5 minutes before rinsing and take finasteride at the same time each day. Track progress with monthly overhead photos; this four-layer protocol gives the strongest documented non-surgical density response at NW5.'
                      : 'At NW5, finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical density protocol — finasteride handles systemic DHT suppression across both frontal and crown loss zones. Optimize by applying minoxidil immediately after scalp massage, leaving DHT shampoo on 3-5 minutes before rinsing, and taking finasteride at the same time each day. Add weekly microneedling over the thinnest zones to prime follicle absorption where density loss is most advanced.')
                  : _hasFinasteride && _hasDHTShampoo && _hasMinoxidil
                    ? 'At NW5, finasteride + minoxidil + DHT shampoo delivers systemic and topical DHT suppression alongside the topical growth signal — add a 4-minute scalp massage before each minoxidil application and weekly microneedling to maximize absorption across the full top. Finasteride handles the systemic root cause; the full stack gives the strongest non-surgical density maintenance across both frontal and crown zones at this stage.'
                    : _hasFinasteride && _hasMinoxidil
                      ? 'At NW5, finasteride + minoxidil addresses both the systemic DHT cause and topical growth signal across the full density loss area — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT suppression where miniaturization spans both frontal and crown zones. Weekly microneedling primes follicle absorption to maximize the response from your finasteride + minoxidil foundation.'
                      : _hasFinasteride && _hasDHTShampoo
                        ? 'Finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression at NW5 where density loss spans both frontal and crown zones — add minoxidil across the entire scalp top twice daily as the growth signal. Finasteride + minoxidil + DHT shampoo is the strongest non-surgical density protocol at this stage; add scalp massage before each application and weekly microneedling to maximize the topical benefit on top of your systemic foundation.'
                        : _hasFinasteride
                          ? 'Finasteride is suppressing systemic DHT at NW5 where density has declined across both frontal and crown zones — add minoxidil across the entire scalp top twice daily and a DHT-blocking shampoo 3× weekly (3-5 min contact time). Finasteride + minoxidil + DHT shampoo is the strongest non-surgical density stack at this stage; add weekly microneedling to prime follicle absorption across the full thinning area.'
                          : _hasDHTShampoo && _hasMinoxidil && _hasMassage
                            ? (_hasLLLT
                                ? 'At NW5, density loss spans both frontal and crown zones and your three-layer stack is the right approach — apply minoxidil immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes before rinsing. A doctor consult about finasteride adds systemic DHT suppression, the most impactful upgrade at this stage; track progress with monthly overhead photos.'
                                : _hasMicroneedling
                                ? 'At NW5, density loss spans both frontal and crown zones and your three-layer stack is the right approach — wait 24-48 hours after each microneedling session before applying minoxidil (applying immediately after needling risks follicle irritation); on non-needling days apply across both thinning fronts twice daily as normal. Leave DHT shampoo on 3-5 minutes before rinsing. A doctor consult about finasteride adds systemic DHT suppression, the most impactful upgrade at this stage; track progress with monthly overhead photos.'
                                : 'At NW5, density loss spans both frontal and crown zones and your three-layer stack is the right approach — optimize by leaving DHT shampoo on 3-5 minutes before rinsing and applying minoxidil immediately after the scalp massage. Add weekly microneedling over the thinnest zones to prime follicle absorption and get the most from your existing protocol.')
                            : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                              ? 'NW5 density has declined across both frontal and crown zones and your supplement stack, minoxidil, and DHT-blocking shampoo deliver the strongest OTC three-layer density approach — nutritional follicle support, topical growth signal, and local DHT suppression all active. Apply minoxidil across the full scalp top twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. Add a 4-minute scalp massage before each minoxidil application to prime follicle absorption across both thinning fronts; massage is the highest-ROI addition to your existing three-layer OTC stack at this advanced stage. Track with monthly overhead photos and consider a doctor consult about finasteride for systemic DHT suppression.'
                              : _hasDHTShampoo && _hasMinoxidil
                              ? 'At NW5, density spans both frontal and crown zones — add a 4-minute scalp massage before each minoxidil application and weekly microneedling to maximize absorption. Mechanical stimulation significantly improves topical penetration where follicles are most compromised; leave your DHT shampoo on 3-5 minutes per wash for maximum local DHT suppression.'
                              : _hasSupplements && _hasDHTShampoo
                                ? 'Your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression across both frontal and crown density loss zones at NW5 — leave DHT shampoo on 3-5 minutes per wash and keep supplements consistent. Add minoxidil across the full scalp top twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC three-layer density approach where loss spans both zones at this advanced stage. Track with monthly overhead photos and consider a doctor consult about finasteride for systemic DHT suppression.'
                              : _hasDHTShampoo
                                ? 'NW5 density loss covers the full scalp top — add minoxidil across the entire top twice daily alongside your DHT-blocking shampoo. Combining topical growth signal (minoxidil) with local DHT suppression (shampoo) gives the strongest dual-mechanism OTC approach for slowing further density loss at this stage.'
                                : _hasMinoxidil && _hasMassage
                                  ? (_hasLLLT
                                      ? 'At NW5, minoxidil and LLLT cover topical growth signal and photobiomodulation across both frontal and crown density loss zones — apply minoxidil immediately after your LLLT session while scalp circulation is elevated to maximize absorption across both thinning fronts. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression and weekly microneedling over the thinnest zones to prime follicle response at this stage.'
                                      : _hasMicroneedling
                                      ? 'At NW5, minoxidil and microneedling cover topical growth signal and scalp priming across both frontal and crown density loss zones — wait 24-48 hours after each microneedling session before applying minoxidil to avoid follicle irritation; on non-needling days apply across both thinning fronts twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression to complete the density stack at this stage.'
                                      : 'At NW5, minoxidil and scalp massage address topical growth signal and mechanical stimulation across both frontal and crown density loss zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression. Leave DHT shampoo on 3-5 minutes per wash and add weekly microneedling over the thinnest zones to prime follicle absorption and get the most from your existing protocol.')
                                  : _hasSupplements && _hasMinoxidil
                                    ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal across both frontal and crown density loss zones at NW5 — apply minoxidil across the full scalp top twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the local DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer density approach where loss spans both zones at this advanced stage. Track with monthly overhead photos and consider a doctor consult about finasteride for systemic DHT suppression.'
                                  : _hasMinoxidil
                                    ? 'At NW5, add a DHT-blocking shampoo 3× weekly to your minoxidil — leave it on 3-5 minutes before rinsing and follow with a scalp massage. At this stage, stacking topical growth signal + DHT suppression + mechanical stimulation gives the strongest realistic density response; add weekly microneedling to prime follicle absorption.'
                                    : _hasSupplements && _hasMassage
                                      ? (_hasLLLT
                                          ? 'At NW5, your supplement stack and LLLT cover nutritional support and photobiomodulation across both frontal and crown density loss zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Apply minoxidil after LLLT sessions while scalp circulation is elevated to maximize absorption across both thinning fronts; three complementary layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx density approach at this advanced stage. Track with monthly overhead photos.'
                                          : _hasMicroneedling
                                          ? 'At NW5, your supplement stack and microneedling cover nutritional support and scalp priming across both frontal and crown density loss zones — use microneedling 24-48 hours before topical application to maximize absorption where miniaturization spans both thinning fronts. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx density approach at this advanced stage. Track with monthly overhead photos.'
                                          : 'At NW5, your supplement stack and scalp massage cover nutritional support and mechanical stimulation across both frontal and crown density loss zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. It is the most impactful addition to your existing stack where density has declined across both zones at this advanced stage. Track with monthly overhead photos.')
                                    : _hasSupplements
                                      ? 'Your supplement stack supports follicle health at NW5 where density has declined across both frontal and crown zones — nutritional support is a good foundation, but the highest-ROI additions at this dual-zone stage are minoxidil applied across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly (3-5 min contact time). Adding both topical layers while follicles are still viable gives the strongest OTC density response at NW5; track with monthly overhead photos.'
                                      : 'NW5 density loss spans both frontal and crown zones — start the full density stack this week: minoxidil across the entire scalp top twice daily, DHT-blocking shampoo 3× weekly (3-5 min contact time), and daily scalp massage. All three layers together give the strongest OTC density response at this stage; track with monthly overhead photos.')
              : _isNW56
              // only NW6 reaches here — NW5 is handled by _isNW5only above
              ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                  ? 'At NW6, finasteride + minoxidil + DHT shampoo delivers systemic and topical DHT suppression alongside the topical growth signal — apply minoxidil across the remaining fringe and lateral hair twice daily and leave the DHT shampoo on 3-5 minutes per wash. Add weekly microneedling over the fringe zones to prime remaining follicle response. The realistic goal is stabilizing existing coverage; track with monthly overhead photos.'
                  : _hasFinasteride && _hasMinoxidil
                    ? 'At NW6, finasteride + minoxidil is the strongest non-surgical density combination — apply minoxidil across the fringe and lateral hair twice daily and add a DHT-blocking shampoo 3× weekly as the topical DHT-suppression layer. Together these slow further fringe miniaturization; realistic expectation is stabilization rather than density restoration. Track with monthly overhead photos.'
                    : _hasFinasteride && _hasDHTShampoo
                    ? 'Finasteride + DHT-blocking shampoo delivers dual-level DHT suppression at NW6 where density is mostly lost — systemic DHT control through finasteride and topical suppression through the shampoo (3-5 min contact time 3× weekly). Add minoxidil to the remaining fringe and lateral edges twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the strongest non-surgical density maintenance protocol at this stage. Track with monthly overhead photos and consider a transplant consultation for full coverage planning.'
                    : _hasFinasteride
                      ? 'Finasteride is blocking systemic DHT at NW6 where density is mostly lost across the scalp top — add minoxidil to the remaining fringe and lateral edges twice daily and a DHT-blocking shampoo 3× weekly. Finasteride + minoxidil + DHT shampoo is the strongest non-surgical density maintenance protocol at this stage; the realistic goal is slowing further fringe loss.'
                      : _hasDHTShampoo && _hasMassage
                        ? 'At NW6, DHT-blocking shampoo and scalp stimulation are both active — leave shampoo on for 3-5 minutes before rinsing and do weekly microneedling over the fringe zones for maximum response. Adding minoxidil to the fringe and lateral edges twice daily is worth considering for an additional topical growth signal at this stage.'
                        : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                          ? 'At NW6, your supplement stack, minoxidil, and DHT-blocking shampoo deliver the strongest OTC three-layer density approach — nutritional follicle support, topical growth signal, and local DHT suppression all active. Apply minoxidil to the fringe and lateral edges twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. The realistic goal at this advanced stage is stabilizing remaining fringe coverage; track with monthly overhead photos.'
                        : _hasSupplements && _hasDHTShampoo
                          ? 'Your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression for the remaining fringe at NW6 — keep DHT shampoo on 3-5 minutes per wash 3× weekly and your supplement stack consistent. Add minoxidil to the fringe and lateral edges twice daily as the missing topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC three-layer approach for stabilizing remaining fringe coverage at this advanced stage. Track with monthly overhead photos.'
                        : _hasMinoxidil && _hasDHTShampoo
                          ? 'At NW6, your minoxidil and DHT-blocking shampoo deliver topical growth signal and local DHT suppression for the remaining fringe — apply minoxidil to the fringe and lateral edges twice daily and leave DHT shampoo on 3-5 minutes per wash 3× weekly. Add weekly microneedling over the fringe zones to prime remaining follicle response. The realistic goal at this advanced stage is stabilizing existing fringe coverage; track with monthly overhead photos.'
                        : _hasDHTShampoo
                          ? "Your DHT-blocking shampoo helps slow miniaturization at NW6 — keep it up and add weekly microneedling to prime remaining follicles. Consider adding minoxidil to the fringe and lateral edges twice daily for the complementary topical growth signal alongside DHT suppression."
                          : _hasMinoxidil && _hasMassage
                            ? (_hasLLLT
                                ? 'At NW6, minoxidil and LLLT cover topical growth signal and photobiomodulation across the remaining fringe — apply minoxidil immediately after your LLLT session while scalp circulation is elevated. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical DHT suppression to complete the non-surgical density stack. The realistic goal is stabilizing existing fringe coverage; consistent application and monthly overhead photos track whether the combination is holding.'
                                : _hasMicroneedling
                                ? 'At NW6, minoxidil and microneedling cover topical growth signal and scalp priming across the remaining fringe — wait 24-48 hours after each microneedling session before applying minoxidil along the fringe and lateral edges (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical DHT suppression to complete the non-surgical density stack. The realistic goal is stabilizing existing fringe coverage; consistent application and monthly overhead photos track whether the combination is holding.'
                                : 'At NW6, minoxidil and scalp massage address topical growth signal and mechanical stimulation across the remaining fringe — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical DHT suppression to complete the non-surgical density stack. The realistic goal is stabilizing existing fringe coverage; consistent application and monthly overhead photos track whether the combination is holding.')
                            : _hasSupplements && _hasMinoxidil
                              ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for remaining fringe coverage at NW6 — apply minoxidil to the fringe and lateral edges twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the local DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach for stabilizing remaining fringe coverage at this advanced stage. Track with monthly overhead photos.'
                            : _hasMinoxidil
                              ? 'At NW6, your minoxidil provides the topical growth signal across the fringe and lateral edges — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT suppression alongside it. Together they slow further fringe miniaturization; track with monthly overhead photos.'
                              : _hasSupplements && _hasMassage
                              ? (_hasLLLT
                                  ? 'Your supplement stack and LLLT cover nutritional support and photobiomodulation for the remaining fringe at NW6 — apply minoxidil to the fringe and lateral edges immediately after your LLLT session while scalp circulation is elevated. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer to complete the non-surgical density stack. The realistic goal at this advanced stage is stabilizing existing fringe coverage; track with monthly overhead photos.'
                                  : _hasMicroneedling
                                  ? 'Your supplement stack and microneedling cover nutritional support and scalp priming for the remaining fringe at NW6 — use microneedling 24-48 hours before any topical application along the fringe to maximize absorption. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer to complete the non-surgical density stack. The realistic goal at this advanced stage is stabilizing existing fringe coverage; track with monthly overhead photos.'
                                  : 'Your supplement stack and scalp massage cover nutritional support and mechanical stimulation for the remaining fringe at NW6 — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. It is the most impactful addition to your existing stack for stabilizing remaining fringe coverage at this advanced stage. Track with monthly overhead photos.')
                              : _hasSupplements
                                ? 'Your supplement stack is supporting fringe follicle health at NW6 — add minoxidil to the fringe and lateral edges twice daily and a DHT-blocking shampoo 3× weekly as the two missing topical layers. Together they deliver topical growth signal and local DHT suppression where density loss is advanced; the realistic goal at this stage is stabilizing remaining fringe coverage. Track with monthly overhead photos.'
                                : 'At NW6, add a DHT-blocking shampoo 3× weekly to slow further miniaturization of remaining fringe coverage. Also start minoxidil on the fringe and lateral edges twice daily — the realistic goal at this stage is stabilizing what remains rather than restoring full density.')
              : data.stage === 'NW2'
              ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                  ? 'At NW2, finasteride + minoxidil + DHT-blocking shampoo is the most complete non-surgical stack at this early preventive stage — finasteride blocks systemic DHT, the DHT shampoo adds topical control, and minoxidil addresses the temple recession. Your density is well-protected; leave the DHT shampoo on 3-5 minutes before rinsing and add a 5-minute scalp massage on wash days to maximize the anti-miniaturization benefit.'
                  : _hasFinasteride && _hasMinoxidil
                  ? 'At NW2, finasteride + minoxidil covers systemic DHT suppression and the topical growth signal for your temple recession — your density protection is solid. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT control layer to complete the dual-level density prevention at this early stage.'
                  : _hasFinasteride && _hasDHTShampoo
                  ? 'NW2 density is protected by finasteride (systemic DHT suppression) and your DHT-blocking shampoo (topical DHT control) — dual-level coverage at this early stage gives the strongest long-term density protection. Leave the DHT shampoo on 3-5 minutes before rinsing and add a 5-minute scalp massage on wash days to maximize the benefit of both layers.'
                  : _hasFinasteride
                  ? 'Finasteride is already blocking systemic DHT at NW2 — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical complement. Dual-level DHT suppression at this early stage gives the strongest protection before any mid-scalp miniaturization develops.'
                  : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                  ? 'NW2 density protection with your supplement stack, minoxidil, and DHT-blocking shampoo is the most complete OTC three-layer preventive approach at this ideal early stage — your density is still intact and all three layers are active. Leave DHT shampoo on 3-5 minutes per wash 3× weekly, apply minoxidil to both temple corners twice daily, and keep your supplement routine consistent. Add a 4-minute scalp massage before each minoxidil application as the next highest-ROI mechanical layer; together these form the strongest non-Rx preventive density protocol at this optimal prevention window. Take monthly overhead photos to catch any early mid-scalp change the moment it begins.'
                  : _hasMinoxidil && _hasDHTShampoo
                  ? 'At NW2, minoxidil + DHT-blocking shampoo is a solid dual-mechanism OTC stack — minoxidil delivers the topical growth signal and the DHT shampoo adds local DHT control. Leave the shampoo on 3-5 minutes before rinsing. Your density is intact; the next highest-ROI addition is a doctor consult about finasteride, which adds systemic DHT suppression for the strongest long-term density protection at this stage.'
                  : _hasMinoxidil && _hasMassage
                  ? (_hasLLLT
                      ? 'At NW2, minoxidil and LLLT cover the topical growth signal and photobiomodulation at the ideal preventive stage — apply minoxidil to both temple corners immediately after your LLLT session while scalp circulation is elevated so freshly primed follicles absorb it. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; the triple OTC approach gives the strongest long-term density protection before any mid-scalp miniaturization begins.'
                      : _hasMicroneedling
                      ? 'At NW2, minoxidil and microneedling cover topical growth signal and scalp priming at the ideal preventive stage — wait 24-48 hours after each microneedling session before applying minoxidil to both temple corners (applying immediately risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; the triple OTC approach gives the strongest long-term density protection before any mid-scalp miniaturization begins.'
                      : 'At NW2, minoxidil and scalp massage cover the topical growth signal and mechanical stimulation at the ideal preventive stage — apply minoxidil to both temple corners immediately after your scalp massage so freshly stimulated follicles absorb it. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; the triple OTC approach gives the strongest long-term density protection before any mid-scalp miniaturization begins.')
                  : _hasSupplements && _hasMinoxidil
                  ? 'Minoxidil and your supplement stack cover the topical growth signal and nutritional follicle support at NW2 — your density is still intact and this is the right preventive stage to add a DHT-blocking shampoo 3× weekly alongside them. The DHT shampoo adds local DHT suppression as the third prevention layer; supplements + minoxidil + DHT shampoo gives the strongest OTC three-layer density protection before any mid-scalp miniaturization begins.'
                  : _hasMinoxidil
                  ? 'Minoxidil is active at NW2 — your density is still intact and this is the right preventive stage to add a DHT-blocking shampoo 3× weekly alongside it. Minoxidil drives the topical growth signal; the DHT shampoo adds local DHT suppression. Together they give a meaningful dual-layer OTC density protection before any mid-scalp thinning starts.'
                  : _hasSupplements && _hasMassage
                  ? (_hasLLLT
                      ? 'Your supplement stack and LLLT cover nutritional follicle support and photobiomodulation at NW2 where density is in the ideal preventive window — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer. Apply minoxidil after LLLT sessions while scalp circulation is elevated; three complementary preventive layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx density foundation at this optimal window before any mid-scalp miniaturization begins.'
                      : _hasMicroneedling
                      ? 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming at NW2 where density is in the ideal preventive window — use microneedling 24-48 hours before any topical application to maximize absorption at this preventive stage. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; three complementary preventive layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx density foundation at this optimal window before any mid-scalp miniaturization begins.'
                      : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at NW2 where density is in the ideal preventive window — keep your daily 4-minute massage consistent to maintain circulation at both temple corners and your supplement routine solid. The highest-ROI addition at this stage is a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; supplements + massage + DHT shampoo gives the strongest non-Rx preventive density protocol at NW2 before any mid-scalp miniaturization begins.')
                  : _hasDHTShampoo
                  ? (_hasSupplements
                    ? 'Your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression at NW2 — a solid dual-layer preventive approach for density. Leave the DHT shampoo on 3-5 minutes per wash 3× weekly and keep your supplement routine consistent. Your density is still strong; the next highest-ROI addition is minoxidil to both temple corners twice daily as the topical growth signal, completing the strongest OTC three-layer preventive density protocol at this early stage.'
                    : 'Your DHT-blocking shampoo is already protecting your density — at NW2 your coverage is still strong. Keep using it 3× weekly and add a 5-minute scalp massage on wash days to maintain circulation and catch any early diffuse change.')
                  : _hasSupplements
                  ? 'Your supplement stack supports follicle health at NW2 where your density is still strong — nutritional support is a good preventive foundation. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the next layer: topical DHT suppression at NW2 is the highest-ROI addition to your supplement routine before any mid-scalp miniaturization begins.'
                  : 'At NW2 your density is still strong — protect it now by adding a DHT-blocking shampoo 3× weekly. This is the highest-ROI prevention step at your stage: slowing miniaturization before it becomes visible is far easier than reversing it later.')
              : (data.stage === 'NW3' || data.stage === 'NW3v')
                ? (_hasFinasteride && _hasDHTShampoo && _hasMassage
                    ? data.stage === 'NW3v'
                        ? 'NW3v density spans mid-scalp and early crown — your finasteride + DHT shampoo + scalp massage covers all three anti-miniaturization layers. Add weekly microneedling (0.5mm) across BOTH the mid-scalp and early crown zone 24-48 hours before topical application; finasteride handles systemic DHT while microneedling primes follicle absorption across both active fronts.'
                        : 'NW3 mid-scalp density with finasteride + DHT shampoo + scalp massage covers the key anti-miniaturization layers — add weekly microneedling (0.5mm) over the thinning mid-scalp zone 24-48 hours before topical application. Finasteride handles systemic DHT; microneedling primes follicle absorption where density loss is progressing at the recession edge.'
                    : _hasFinasteride && _hasDHTShampoo
                        ? data.stage === 'NW3v'
                            ? 'At NW3v, finasteride + DHT shampoo delivers systemic and topical DHT suppression across mid-scalp and early crown — add weekly microneedling covering both zones and a 4-minute scalp massage before each topical application. Mechanical stimulation is the highest-ROI addition when dual-zone DHT suppression is already in place.'
                            : 'At NW3, finasteride + DHT shampoo delivers both systemic and topical DHT suppression at the mid-scalp — add weekly microneedling (0.5mm) and a 5-minute scalp massage before each application. Mechanical stimulation is the highest-ROI addition when DHT is already covered at both levels.'
                        : _hasFinasteride && _hasMinoxidil && _hasMassage
                            ? data.stage === 'NW3v'
                                ? (_hasLLLT
                                    ? 'NW3v mid-scalp and early crown with finasteride + minoxidil + LLLT covers systemic DHT suppression, topical growth signal, and photobiomodulation across both active zones — apply minoxidil immediately after your LLLT session while scalp circulation is elevated, covering BOTH mid-scalp and vertex zones. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control across both active fronts — it is the highest-ROI missing layer alongside your finasteride at this dual-zone stage.'
                                    : _hasMicroneedling
                                    ? 'NW3v mid-scalp and early crown with finasteride + minoxidil + microneedling covers systemic DHT suppression, topical growth signal, and scalp priming across both active zones — wait 24-48 hours after each microneedling session before applying minoxidil across BOTH mid-scalp and vertex zones (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control across both active fronts — it is the highest-ROI missing layer alongside your finasteride at this dual-zone stage.'
                                    : 'NW3v mid-scalp and early crown with finasteride + minoxidil + scalp massage covers systemic DHT suppression, topical growth signal, and mechanical stimulation across both active zones — apply minoxidil immediately after your scalp massage across BOTH mid-scalp and vertex zones. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control across both active fronts — it is the highest-ROI missing layer alongside your finasteride at this dual-zone stage.')
                                : (_hasLLLT
                                    ? 'NW3 mid-scalp density with finasteride + minoxidil + LLLT covers systemic DHT suppression, topical growth signal, and photobiomodulation — apply minoxidil immediately after your LLLT session while scalp circulation is elevated so freshly primed follicles absorb it at the recession edge. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control at the mid-scalp — it is the highest-ROI missing layer alongside your finasteride at this established stage.'
                                    : _hasMicroneedling
                                    ? 'NW3 mid-scalp density with finasteride + minoxidil + microneedling covers systemic DHT suppression, topical growth signal, and scalp priming — wait 24-48 hours after each microneedling session before applying minoxidil (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control at the mid-scalp — it is the highest-ROI missing layer alongside your finasteride at this established stage.'
                                    : 'NW3 mid-scalp density with finasteride + minoxidil + scalp massage covers systemic DHT suppression, topical growth signal, and mechanical stimulation — apply minoxidil immediately after your 4-minute scalp massage so freshly primed follicles absorb it at the recession edge. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control at the mid-scalp — it is the highest-ROI missing layer alongside your finasteride at this established stage.')
                        : _hasFinasteride && _hasMinoxidil
                            ? data.stage === 'NW3v'
                                ? 'At NW3v, finasteride + minoxidil addresses both systemic DHT suppression and topical growth signal across mid-scalp and early crown — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control across both active zones, plus a 4-minute scalp massage covering both the mid-scalp and vertex before each application. Dual-zone consistency with the complete three-layer stack gives the strongest density response at NW3v.'
                                : 'At NW3, finasteride + minoxidil is the most evidence-backed non-surgical density combination — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT suppression where miniaturization is progressing at the recession edge, and pair each minoxidil application with a 4-minute scalp massage. Finasteride handles systemic DHT; the DHT shampoo and massage complete the triple-mechanism density stack at this pivotal stage.'
                        : _hasFinasteride
                            ? data.stage === 'NW3v'
                                ? 'Finasteride suppresses systemic DHT at NW3v where density is declining across mid-scalp and early crown — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control across both zones, plus weekly microneedling. Systemic + topical DHT suppression together give the strongest two-front density response at this stage.'
                                : 'Finasteride suppresses systemic DHT at NW3 — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control at the mid-scalp, plus weekly microneedling (0.5mm) and a scalp massage before each application. Systemic and topical DHT suppression together give the strongest density response at this stage.'
                            : _hasMinoxidil && _hasDHTShampoo && _hasMassage
                                ? (data.stage === 'NW3v'
                                    ? 'NW3v mid-scalp and early crown with minoxidil + DHT shampoo + scalp massage is a strong OTC three-layer stack — add weekly microneedling across both the mid-scalp and vertex 24-48 hours before topical application to prime both active zones. If progress plateaus, a doctor consult about finasteride adds systemic DHT suppression for the strongest dual-front density response.'
                                    : 'Mid-scalp density at NW3 with minoxidil + DHT shampoo + scalp massage covers the key OTC layers — add weekly microneedling over the thinning mid-scalp zone 24-48 hours before topical application so freshly primed follicles absorb more. Finasteride would add systemic DHT suppression for the most evidence-backed stack at this stage.')
                                : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                    ? (data.stage === 'NW3v'
                                        ? 'NW3v density is declining across mid-scalp and early crown — your supplement stack, minoxidil, and DHT-blocking shampoo covers nutritional follicle support, topical growth signal, and local DHT suppression across both active zones. Confirm minoxidil reaches BOTH mid-scalp and vertex twice daily, leave DHT shampoo on 3-5 minutes per wash, and keep your supplement routine consistent. Add a 4-minute scalp massage before each minoxidil application as the next highest-ROI layer; massage primes both active fronts for maximum absorption and completes the OTC three-layer-plus-massage density stack at this dual-zone stage. Track with monthly overhead photos.'
                                        : 'Mid-scalp density at NW3 is thinning while follicles are still highly responsive — your supplement stack, minoxidil, and DHT-blocking shampoo covers nutritional follicle support, topical growth signal, and local DHT suppression at the recession edge. Apply minoxidil to the mid-scalp twice daily, leave DHT shampoo on 3-5 minutes per wash, and keep your supplement routine consistent. Add a 4-minute scalp massage before each minoxidil application as the next highest-ROI layer; massage primes the mid-scalp for maximum absorption and completes the OTC three-layer-plus-massage density stack at this pivotal response window. Track with monthly overhead photos.')
                                : _hasMinoxidil && _hasDHTShampoo
                                    ? (data.stage === 'NW3v'
                                        ? 'NW3v density with minoxidil + DHT shampoo targets both thinning zones with topical growth signal and local DHT control — add a 4-minute scalp massage before each minoxidil application and weekly microneedling across mid-scalp and vertex. A doctor consult about finasteride would add systemic DHT suppression for a complete dual-zone density protocol.'
                                        : 'Mid-scalp density at NW3 with minoxidil + DHT shampoo gives both topical growth signal and local DHT suppression — add a 5-minute scalp massage before each minoxidil application and weekly microneedling to prime follicle absorption at the recession edge. Finasteride would add the systemic DHT layer for the most complete density stack at this stage.')
                                    : _hasMinoxidil && _hasMassage
                                        ? (_hasLLLT
                                            ? (data.stage === 'NW3v'
                                                ? 'NW3v mid-scalp and early crown with minoxidil and LLLT covers topical growth signal and photobiomodulation across both active zones — apply minoxidil immediately after your LLLT session while scalp circulation is elevated so freshly primed follicles at both fronts absorb it. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression; DHT shampoo completes the OTC density stack at this two-front stage.'
                                                : 'Mid-scalp density at NW3 with minoxidil and LLLT covers topical growth signal and photobiomodulation at the recession edge — apply minoxidil immediately after your LLLT session while scalp circulation is elevated to maximize absorption where miniaturization is most active. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression; DHT shampoo completes the OTC density stack and slows miniaturization while follicles are still highly responsive.')
                                            : _hasMicroneedling
                                            ? (data.stage === 'NW3v'
                                                ? 'NW3v mid-scalp and early crown with minoxidil and microneedling covers topical growth signal and scalp priming across both active zones — wait 24-48 hours after each microneedling session before applying minoxidil to both mid-scalp and vertex (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression; DHT shampoo completes the OTC density stack at this two-front stage.'
                                                : 'Mid-scalp density at NW3 with minoxidil and microneedling covers topical growth signal and scalp priming at the recession edge — wait 24-48 hours after each microneedling session before applying minoxidil to the mid-scalp zone (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression; DHT shampoo completes the OTC density stack and slows miniaturization while follicles are still highly responsive.')
                                            : (data.stage === 'NW3v'
                                                ? 'NW3v mid-scalp and early crown with minoxidil and scalp massage covers topical growth signal and mechanical stimulation across both active zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression. DHT shampoo completes the OTC density stack at this two-front stage.'
                                                : 'Mid-scalp density at NW3 with minoxidil and scalp massage is a strong two-layer approach — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression at the recession edge. DHT shampoo completes the OTC density stack and slows miniaturization while follicles are still highly responsive.'))
                                        : _hasSupplements && _hasMinoxidil
                                            ? (data.stage === 'NW3v'
                                                ? 'NW3v density is declining across mid-scalp and early crown — your supplement stack and minoxidil cover nutritional support and the topical growth signal across both zones. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) alongside them to target local DHT suppression across both fronts; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer density approach at this dual-zone stage. Take monthly overhead photos to track both zones.'
                                                : 'Mid-scalp density at NW3 is thinning while follicles are still highly responsive — your supplement stack and minoxidil cover nutritional support and the topical growth signal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression where miniaturization is progressing; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer density approach at this established stage while follicles are still highly responsive.')
                                        : _hasMinoxidil
                                            ? (data.stage === 'NW3v'
                                                ? 'NW3v density is declining across mid-scalp and early crown — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) alongside your minoxidil to target local DHT suppression across both zones. Follow each minoxidil application with a 4-minute scalp massage to prime follicle absorption at both thinning fronts.'
                                                : 'Mid-scalp density at NW3 is thinning while follicles are still highly responsive — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) alongside your minoxidil. DHT shampoo adds local DHT suppression where miniaturization is progressing; follow each minoxidil application with a 4-minute scalp massage to maximize absorption at the recession edge.')
                                        : _hasDHTShampoo && _hasMassage
                                                ? (data.stage === 'NW3v'
                                                    ? 'At NW3v, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation across both the mid-scalp and early crown — optimize by microneedling BOTH the recession edge and the vertex 24-48 hours before topical application, so freshly primed follicles at both active fronts absorb more.'
                                                    : 'DHT shampoo and scalp stimulation are both active — optimize for density by microneedling the thinning mid-scalp zone 24-48 hours before your topical application, so freshly primed follicles absorb more at the area that matters most.')
                                                : _hasDHTShampoo
                                                    ? (data.stage === 'NW3v'
                                                        ? 'Your DHT-blocking shampoo is active at NW3v where both mid-scalp and early crown are thinning simultaneously — add minoxidil to BOTH zones (1ml per temple recession zone + 1ml vertex twice daily) as the topical growth signal. Dual-zone coverage at this two-front stage maximizes density response; pair each application with a 4-minute scalp massage to prime absorption at both active fronts.'
                                                        : (_hasSupplements
                                                            ? 'Your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression at NW3 where mid-scalp density is beginning to decline — leave DHT shampoo on 3-5 minutes per wash 3× weekly and keep supplements consistent. Add minoxidil applied to the mid-scalp twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC three-layer density approach at NW3 while follicles are still highly responsive. Track with monthly overhead photos.'
                                                            : "Your DHT-blocking shampoo is active at a key stage — add weekly microneedling over the mid-scalp thinning zone and a 5-minute post-wash scalp massage to drive follicle response while coverage is still stabilizable."))
                                                    : _hasSupplements && _hasMassage
                                                        ? (_hasLLLT
                                                            ? (data.stage === 'NW3v'
                                                                ? 'At NW3v, your supplement stack and LLLT cover nutritional support and photobiomodulation across both the mid-scalp and early crown — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Apply minoxidil after LLLT sessions while scalp circulation is elevated across both active fronts; three complementary layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx density approach at this dual-zone stage.'
                                                                : 'At NW3, your supplement stack and LLLT cover nutritional support and photobiomodulation at the recession edge — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Apply minoxidil after LLLT sessions while scalp circulation is elevated where miniaturization is most active; three complementary layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx density approach at this stage while follicles are still highly responsive.')
                                                            : _hasMicroneedling
                                                            ? (data.stage === 'NW3v'
                                                                ? 'At NW3v, your supplement stack and microneedling cover nutritional support and scalp priming across both the mid-scalp and early crown — use microneedling 24-48 hours before topical application to maximize absorption at both active fronts. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx density approach at this dual-zone stage.'
                                                                : 'At NW3, your supplement stack and microneedling cover nutritional support and scalp priming at the recession edge — use microneedling 24-48 hours before topical application to maximize absorption where miniaturization is most active. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx density approach at this stage while follicles are still highly responsive.')
                                                            : (data.stage === 'NW3v'
                                                                ? 'At NW3v, your supplement stack and scalp massage cover nutritional support and mechanical stimulation across both the mid-scalp and early crown — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. It is the most impactful addition to your existing stack at this dual-zone stage while follicles are still viable.'
                                                                : 'At NW3, your supplement stack and scalp massage cover nutritional support and mechanical stimulation at the recession edge — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. It is the most impactful addition to your existing stack at this stage while follicles are still highly responsive.'))
                                                    : _hasSupplements
                                                        ? (data.stage === 'NW3v'
                                                            ? 'Your supplement stack supports follicle health at NW3v where mid-scalp and early crown density are both declining — nutritional support is a good foundation, but the highest-ROI additions at this dual-zone active stage are a DHT-blocking shampoo 3× weekly and minoxidil applied to both zones twice daily. Adding both topical layers while follicles are still viable gives the strongest dual-zone density response at NW3v.'
                                                            : 'Your supplement stack supports follicle health at NW3 where mid-scalp density is beginning to decline — nutritional support is a solid foundation, but the highest-ROI additions at this stage are a DHT-blocking shampoo 3× weekly and minoxidil applied to the mid-scalp twice daily. Starting both while follicles are still highly responsive gives the strongest density-preservation result at NW3.')
                                                        : (data.stage === 'NW3v'
                                                            ? 'NW3v density is declining across mid-scalp and early crown simultaneously — start a DHT-blocking shampoo 3× weekly and ensure coverage reaches BOTH active zones. Adding minoxidil to both the recession edge and vertex twice daily completes the dual-zone OTC density stack at the strongest response window before either front advances.'
                                                            : 'Mid-scalp density at NW3 responds well to DHT-blocking shampoo 3× weekly plus scalp massage — start both this week while follicles are still viable and the density response window is open.'))
                : data.stage === 'NW4'
                  ? (_hasFinasteride && _hasDHTShampoo && _hasMinoxidil && _hasMassage
                      ? (_hasLLLT
                          ? 'At NW4, finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical density protocol — apply minoxidil immediately after your LLLT session while scalp circulation is elevated across the full scalp top, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. Finasteride handles systemic DHT suppression; the photobiomodulation from LLLT optimizes scalp circulation where mid-scalp miniaturization is most active. Track with monthly overhead photos.'
                          : _hasMicroneedling
                          ? 'At NW4, finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical density protocol — wait 24-48 hours after each microneedling session before applying minoxidil across the full scalp top (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Leave DHT shampoo on 3-5 minutes on wash days and take finasteride at the same time each day. Finasteride handles systemic DHT suppression; microneedling primes follicle absorption across the mid-scalp where miniaturization is most active. Track with monthly overhead photos.'
                          : 'At NW4, finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical density protocol — optimize timing: massage first, apply minoxidil immediately after across the full top, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. Finasteride handles systemic DHT suppression; the remaining stack optimizes the scalp environment where mid-scalp miniaturization is most active.')
                      : _hasFinasteride && _hasDHTShampoo && _hasMinoxidil
                        ? 'At NW4, finasteride + minoxidil + DHT shampoo delivers systemic and topical DHT suppression alongside the topical growth signal — add scalp massage before each topical application and weekly microneedling across the mid-scalp. Mechanical stimulation is the highest-ROI addition to your finasteride-backed density stack at this established stage.'
                        : _hasFinasteride && _hasDHTShampoo
                          ? 'At NW4, finasteride + DHT-blocking shampoo delivers dual-level DHT suppression — systemic finasteride handles the hormonal root cause and the shampoo adds topical control where mid-scalp miniaturization is most active. Add minoxidil across the full scalp top twice daily to complete the triple-mechanism stack; finasteride + minoxidil + DHT shampoo gives the strongest non-surgical density response at this established stage.'
                          : _hasFinasteride && _hasMinoxidil
                          ? 'NW4 mid-scalp density with finasteride + minoxidil gives the strongest non-surgical foundation — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical DHT suppression where miniaturization is progressing across the full scalp top. Finasteride handles systemic DHT; the shampoo adds a targeted topical layer to complete dual-level coverage.'
                          : _hasFinasteride
                            ? 'Finasteride is suppressing systemic DHT at NW4 where mid-scalp density is declining — add minoxidil across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly. Finasteride + minoxidil + DHT shampoo gives the strongest triple-mechanism density response at this established stage; add weekly microneedling to prime follicle absorption across the thinnest zones.'
                            : _hasDHTShampoo && _hasMinoxidil && _hasMassage
                                ? (_hasLLLT
                                    ? 'At NW4, minoxidil + DHT shampoo + LLLT covers topical growth signal, local DHT suppression, and photobiomodulation across the mid-scalp — apply minoxidil immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes on wash days. A doctor consult about finasteride adds systemic DHT suppression, the most impactful upgrade at this established stage; track with monthly overhead photos.'
                                    : _hasMicroneedling
                                    ? 'At NW4, minoxidil + DHT shampoo + microneedling covers topical growth signal, local DHT suppression, and scalp priming across the mid-scalp — wait 24-48 hours after each microneedling session before applying minoxidil across the full scalp top (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Leave DHT shampoo on 3-5 minutes on wash days. A doctor consult about finasteride adds systemic DHT suppression, the most impactful upgrade at this established stage; track with monthly overhead photos.'
                                    : 'At NW4, mid-scalp density benefits from stacking all three layers — optimize timing: massage first, then apply minoxidil immediately after across the full top, and leave DHT shampoo on for 3-5 minutes on wash days. Consistency beats adding new products.')
                                : _hasSupplements && _hasDHTShampoo && _hasMinoxidil
                                  ? 'Your supplement stack, minoxidil, and DHT-blocking shampoo cover nutritional follicle support, topical growth signal, and local DHT suppression across the mid-scalp at NW4 — apply minoxidil across the full scalp top twice daily, keep DHT shampoo on 3-5 minutes on wash days, and maintain your supplement routine consistently. Add a 4-minute scalp massage before each topical application and consider a doctor consult about finasteride, the most impactful upgrade at this established stage; track with monthly overhead photos.'
                                : _hasDHTShampoo && _hasMinoxidil
                                  ? 'At NW4, add scalp massage and weekly microneedling to your topical + shampoo stack — mechanical stimulation significantly improves absorption across the mid-scalp thinning zones at this stage.'
                                  : _hasMinoxidil && _hasMassage
                                    ? (_hasLLLT
                                        ? 'At NW4, your minoxidil and LLLT cover topical growth signal and photobiomodulation across the mid-scalp — apply minoxidil immediately after your LLLT session while scalp circulation is elevated to maximize mid-scalp absorption. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression where miniaturization is advancing across the full scalp top; the three-layer OTC stack gives the strongest non-surgical density response at this established stage.'
                                        : _hasMicroneedling
                                        ? 'At NW4, your minoxidil and microneedling cover topical growth signal and scalp priming across the mid-scalp — wait 24-48 hours after each microneedling session before applying minoxidil to avoid follicle irritation; on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression where miniaturization is advancing across the full scalp top; the three-layer OTC stack gives the strongest non-surgical density response at this established stage.'
                                        : 'At NW4, minoxidil and scalp massage cover topical growth signal and mechanical stimulation — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression where miniaturization is advancing across the mid-scalp. Stacking all three OTC layers gives the strongest non-surgical density response at this established stage.')
                                    : _hasSupplements && _hasMinoxidil
                                      ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at NW4 where mid-scalp density is declining across the full scalp top — apply minoxidil across the full top twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer density approach at this established stage. A doctor consult about finasteride adds systemic DHT suppression for the most complete protocol at NW4. Track with monthly overhead photos.'
                                    : _hasMinoxidil
                                      ? 'At NW4, mid-scalp coverage needs a DHT-blocking shampoo as the second layer — use it 3× weekly with a 3-minute scalp massage to slow ongoing miniaturization alongside your existing topical.'
                                      : _hasDHTShampoo
                                      ? (_hasSupplements
                                        ? 'Your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression at NW4 where mid-scalp density is declining across the full scalp top — leave DHT shampoo on 3-5 minutes per wash 3× weekly and keep supplements consistent. Add minoxidil applied across the full top twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC three-layer density approach at NW4 while follicles are still viable. Track with monthly overhead photos.'
                                        : 'At NW4, add minoxidil across the full scalp top (temples + crown + mid-scalp) twice daily — your DHT shampoo slows miniaturization but minoxidil drives the active regrowth signal your follicles need.')
                                      : _hasSupplements && _hasMassage
                                        ? (_hasLLLT
                                            ? 'At NW4, your supplement stack and LLLT cover nutritional support and photobiomodulation across the mid-scalp — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Apply minoxidil after LLLT sessions while scalp circulation is elevated where miniaturization spans the full scalp top; three complementary layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx density approach at this established stage. Track with monthly overhead photos.'
                                            : _hasMicroneedling
                                            ? 'At NW4, your supplement stack and microneedling cover nutritional support and scalp priming across the mid-scalp — use microneedling 24-48 hours before topical application to maximize absorption where miniaturization spans the full scalp top. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx density approach at this established stage. Track with monthly overhead photos.'
                                            : 'At NW4, your supplement stack and scalp massage cover nutritional support and mechanical stimulation across the mid-scalp — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. It is the most impactful addition to your existing stack where miniaturization spans the full scalp top at this established stage. Track with monthly overhead photos.')
                                      : _hasSupplements
                                        ? 'Your supplement stack supports follicle health at NW4 where mid-scalp density is declining across the full scalp top — nutritional support is a good foundation, but the highest-ROI additions at this established stage are a DHT-blocking shampoo 3× weekly and minoxidil applied across the full top twice daily. Starting both topical layers while follicles are still viable gives the strongest OTC density response at NW4; track with monthly overhead photos.'
                                        : 'NW4 mid-scalp density responds best to the full OTC stack: minoxidil twice daily across the entire top plus DHT-blocking shampoo 3× weekly. Start both this week — density at this stage needs simultaneous DHT suppression and growth signal.')
                  : (data.stage === 'diffuse' || data.stage === 'n/a (female)')
                    ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                        ? (data.stage === 'n/a (female)'
                            ? "Female-pattern density with finasteride + minoxidil + DHT shampoo covers the key treatment layers — confirm minoxidil spreads evenly across the full central parting and scalp top twice daily. A ferritin, thyroid, and hormone panel is still the highest-ROI investigation: a reversible hormonal cause can produce rapid, lasting density improvement beyond what topicals achieve alone."
                            : 'Diffuse density with finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and topical DHT control — the complete stack. Add a 5-minute whole-scalp massage on wash days to prime absorption and consider a nutritional workup (ferritin, vitamin D, thyroid) to rule out any reversible cause compounding the diffuse pattern.')
                        : _hasFinasteride && _hasMinoxidil
                          ? (data.stage === 'n/a (female)'
                              ? "Female-pattern density with finasteride + minoxidil covers DHT suppression and the topical growth signal — add a DHT-blocking shampoo 3× weekly for topical-level DHT control. A ferritin, thyroid, and hormone panel is still the highest-ROI investigation: a reversible hormonal cause produces rapid improvement beyond what topicals alone can achieve."
                              : 'Diffuse density with finasteride + minoxidil gives systemic DHT suppression and topical growth signal — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) and a 5-minute whole-scalp massage on wash days. A ferritin, vitamin D, and thyroid workup is still worthwhile to rule out any reversible nutritional cause alongside the diffuse pattern.')
                          : _hasFinasteride
                            ? (data.stage === 'n/a (female)'
                                ? "Finasteride in your female-pattern routine provides DHT suppression for scalp density — add minoxidil applied evenly across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly. A ferritin, thyroid, and hormone panel is the highest-ROI next step: a reversible hormonal cause in women can produce rapid density improvement that topicals alone cannot achieve."
                                : 'Finasteride provides systemic DHT suppression for diffuse density loss — add minoxidil across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly. Finasteride + minoxidil + DHT shampoo gives the strongest diffuse density stack; also investigate ferritin, vitamin D, and thyroid to rule out a reversible nutritional cause compounding the pattern.')
                            : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                              ? (data.stage === 'n/a (female)'
                                  ? "Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for female-pattern density thinning — apply minoxidil across the full central parting and scalp top twice daily (not just the hairline), leave DHT shampoo on 3-5 minutes on wash days, and keep your supplement routine consistent. A ferritin, thyroid, and hormone panel is still the highest-ROI investigation: a reversible hormonal cause in women can produce improvement beyond what your current triple-layer OTC stack achieves alone."
                                  : 'Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for diffuse density thinning — apply minoxidil across the full scalp top twice daily, leave DHT shampoo on 3-5 minutes on wash days (not just a rinse), and keep your supplement routine consistent. Add a 5-minute whole-scalp massage on wash days to complete mechanical stimulation; also check ferritin, vitamin D, and thyroid — a reversible nutritional or hormonal cause compounds diffuse loss, and treating it alongside your triple-layer stack accelerates improvement significantly.')
                            : _hasMinoxidil && _hasDHTShampoo
                              ? (data.stage === 'n/a (female)'
                                  ? "Female-pattern thinning responds well when minoxidil covers the full central parting and scalp top — confirm coverage is even rather than concentrated at the hairline. If you haven't already, check ferritin, vitamin D, and thyroid — these are the most common reversible causes in women."
                                  : 'Diffuse thinning spans the full scalp — your topical and DHT shampoo are the right tools. Add a 5-minute whole-scalp massage on wash days and consider a nutritional workup (ferritin, vitamin D, thyroid) to rule out a reversible cause.')
                              : _hasSupplements && _hasMinoxidil
                                ? (data.stage === 'n/a (female)'
                                    ? "Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for female-pattern density thinning — apply minoxidil across the full central parting and scalp top twice daily (not just the hairline) and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach for female-pattern density. A ferritin, thyroid, and hormone panel is still the highest-ROI investigation: a reversible hormonal cause in women can produce improvement beyond what your current OTC stack achieves."
                                    : 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for diffuse density thinning — apply minoxidil across the full scalp top twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach for diffuse density. Also check ferritin, vitamin D, and thyroid — a reversible nutritional or hormonal cause is common with diffuse loss and addressing it alongside your OTC stack can accelerate density improvement significantly.')
                                : _hasMinoxidil
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern thinning responds well to minoxidil applied across the central parting and scalp top — not just the hairline. Add a check of ferritin, vitamin D, and thyroid: these are the most common reversible causes and topicals alone won't fix them."
                                    : 'Diffuse thinning often has a nutritional or hormonal component — add a DHT-blocking shampoo 3× weekly and consider checking ferritin, vitamin D, and thyroid levels to find a reversible root cause.')
                                : _hasSupplements && _hasMassage
                                ? (_hasLLLT
                                    ? (data.stage === 'n/a (female)'
                                        ? "Your supplement stack and LLLT cover nutritional follicle support and photobiomodulation for female-pattern density thinning — apply minoxidil across the full central parting and scalp top twice daily after your LLLT session while scalp circulation is elevated. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; also check ferritin, thyroid, and hormones since a reversible hormonal cause in women can produce improvement beyond what topicals alone achieve."
                                        : 'Your supplement stack and LLLT cover nutritional follicle support and photobiomodulation for diffuse density thinning — apply minoxidil across the full scalp top twice daily after your LLLT session while scalp circulation is elevated. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; also check ferritin, vitamin D, and thyroid — a reversible nutritional or hormonal cause is common with diffuse loss and addressing it alongside your current stack can accelerate density improvement significantly.')
                                    : _hasMicroneedling
                                    ? (data.stage === 'n/a (female)'
                                        ? "Your supplement stack and microneedling cover nutritional follicle support and scalp priming for female-pattern density thinning — use microneedling 24-48 hours before applying minoxidil across the full central parting and scalp top to maximize absorption; on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; also check ferritin, thyroid, and hormones since a reversible hormonal cause in women can produce improvement beyond what topicals alone achieve."
                                        : 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming for diffuse density thinning — use microneedling 24-48 hours before applying minoxidil across the full scalp top to maximize absorption where thinning spans the entire scalp; on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; also check ferritin, vitamin D, and thyroid — a reversible nutritional or hormonal cause is common with diffuse loss and addressing it alongside your current stack can accelerate density improvement significantly.')
                                    : (data.stage === 'n/a (female)'
                                        ? "Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation for female-pattern density thinning — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. A ferritin, thyroid, and hormone panel is still the highest-ROI investigation: a reversible hormonal cause in women can produce improvement beyond what topicals alone achieve, and addressing it alongside your existing routine compounds the benefit."
                                        : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation for diffuse density thinning — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. It is the most impactful addition to your existing stack; also check ferritin, vitamin D, and thyroid — a reversible nutritional or hormonal cause is common with diffuse loss and addressing it alongside your supplement routine can accelerate density improvement significantly.'))
                                : _hasSupplements
                                ? (data.stage === 'n/a (female)'
                                    ? "Your supplement stack is a good nutritional foundation for female-pattern density thinning — biotin, zinc, and vitamin D support follicle health along the central parting and scalp top. Add minoxidil applied across the full scalp top twice daily as the topical growth signal; also check ferritin, thyroid, and hormones since a reversible hormonal cause is common in women and treating it alongside your supplement routine produces faster, lasting density improvement."
                                    : 'Your supplement stack is a good nutritional foundation for diffuse density thinning — add a DHT-blocking shampoo 3× weekly and minoxidil across the full scalp top twice daily as the topical layers. Also check ferritin, vitamin D, and thyroid — a reversible nutritional or hormonal cause is common with diffuse loss and addressing it alongside your supplement routine can accelerate density improvement significantly.')
                                : (data.stage === 'n/a (female)'
                                    ? "Female-pattern thinning responds best to minoxidil applied across the full scalp top (not just the hairline) twice daily — start this week. Also worth a ferritin, vitamin D, and thyroid check: these reversible causes are common in women and topicals alone won't address them."
                                    : 'Diffuse thinning covers the entire scalp top — start DHT-blocking shampoo 3× weekly and minoxidil across the full top twice daily. Also check ferritin, vitamin D, and thyroid — diffuse loss often has a treatable nutritional or hormonal component.'))
                    : data.stage === 'NW1'
                    // NW1: density is completely intact — preventive messaging only; no thinning zones exist
                    ? (_hasFinasteride && _hasDHTShampoo && _hasSupplements
                        ? 'Your mid-scalp density is fully protected at NW1 with finasteride + DHT-blocking shampoo + supplements — the most complete preventive foundation available. Maximize long-term density through lifestyle: prioritize 7-8 hours of sleep each night. Cortisol from poor sleep accelerates follicle miniaturization even before visible mid-scalp thinning begins, and no supplement can offset poor recovery.'
                        : _hasFinasteride && _hasDHTShampoo
                          ? 'Your density is fully intact at NW1 and finasteride + DHT-blocking shampoo delivers dual-level DHT suppression — systemic through finasteride and topical through the shampoo (3-5 min contact time per wash). Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer to complete the three-layer preventive density protocol; together they form the strongest non-Rx preventive foundation at this optimal window. Take monthly overhead photos to catch any early mid-scalp change the moment it begins.'
                          : _hasFinasteride && _hasSupplements
                            ? 'Finasteride + supplement stack is a strong NW1 density foundation — systemic DHT suppression and nutritional follicle support working in parallel before any miniaturization begins. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-control layer to complete the triple-layer preventive protocol.'
                            : _hasFinasteride
                              ? 'Finasteride is suppressing systemic DHT at NW1 where density is completely intact — add a DHT-blocking shampoo 3× weekly as the topical prevention complement. Together they form the most complete dual-level DHT protection before any mid-scalp miniaturization begins.'
                              : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                ? 'At NW1, your supplement stack, minoxidil, and DHT-blocking shampoo form the most complete OTC density-prevention protocol before any mid-scalp miniaturization begins — nutritional follicle support, topical growth signal, and local DHT suppression all active. Apply minoxidil to the scalp top twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistently. The DHT shampoo is the primary miniaturization-prevention layer; supplements and minoxidil complete the three-layer OTC preventive stack. Take monthly overhead photos to catch any early mid-scalp change at this optimal prevention window.'
                              : _hasSupplements && _hasDHTShampoo
                                ? 'Your supplements and DHT-blocking shampoo cover nutritional support and topical DHT suppression at NW1 — a solid dual-layer preventive approach for density. Maximize DHT shampoo contact time (3-5 minutes per wash) and take monthly overhead photos; catching any early mid-scalp change at NW1 gives the best possible intervention window.'
                                : _hasSupplements && _hasMassage
                                  ? (_hasLLLT
                                      ? 'At NW1, your supplement stack and LLLT device cover nutritional support and photobiomodulation before any mid-scalp thinning develops — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary preventive layers (nutritional + photobiomodulation + DHT suppression) form the strongest non-Rx density foundation at this optimal prevention window.'
                                      : _hasMicroneedling
                                      ? 'At NW1, your supplement stack and microneedling cover nutritional support and scalp priming before any mid-scalp thinning develops — use microneedling 24-48 hours before any topical application for maximum absorption at this preventive stage. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary preventive layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx density protection before any miniaturization begins.'
                                      : 'At NW1, your supplement stack and scalp massage cover nutritional support and mechanical stimulation before any mid-scalp thinning develops — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary preventive layers (nutritional + mechanical + DHT suppression) give the strongest non-Rx density protection at this optimal prevention window.')
                                  : _hasSupplements && _hasMinoxidil
                                    ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at NW1 where mid-scalp density is fully intact — this is a proactive two-layer preventive stack before any miniaturization begins. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC non-Rx preventive foundation for density at this optimal prevention window. Take monthly overhead photos to catch any early change the moment it appears.'
                                  : _hasSupplements
                                    ? 'Your supplement stack is active at NW1 where mid-scalp density is fully intact — add a DHT-blocking shampoo 3× weekly as the next preventive layer. NW1 is the optimal window to build a protective routine; follicles are fully viable and most responsive before any mid-scalp miniaturization begins.'
                                    : _hasDHTShampoo && _hasMassage
                                      ? (_hasLLLT
                                          ? 'At NW1, your DHT-blocking shampoo and LLLT device cover topical DHT suppression and photobiomodulation before any mid-scalp thinning develops — schedule your LLLT sessions on DHT shampoo wash days so the follicle microenvironment is primed. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer to complete the three-layer non-Rx preventive foundation for density at this optimal prevention window.'
                                          : _hasMicroneedling
                                          ? 'At NW1, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming before any mid-scalp thinning develops — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer; three complementary preventive layers (DHT suppression + scalp priming + nutritional) form the strongest non-Rx density foundation at this optimal prevention window.'
                                          : 'At NW1, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation before any mid-scalp thinning develops — add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer. Three complementary preventive layers (DHT suppression + mechanical + nutritional) give the strongest non-Rx preventive foundation for density at this optimal window.')
                                      : _hasMinoxidil && _hasDHTShampoo
                                        ? 'Your minoxidil and DHT-blocking shampoo cover the topical growth signal and local DHT suppression at NW1 where mid-scalp density is fully intact — leave DHT shampoo on 3-5 minutes per wash 3× weekly and keep minoxidil consistent. Your density is well-protected; the next highest-ROI addition is a doctor consult about finasteride for systemic DHT suppression, which completes the dual-level prevention stack at this optimal window. Take monthly overhead photos to catch any early mid-scalp change the moment it begins.'
                                        : _hasDHTShampoo
                                        ? 'Your density is strong at NW1 — keep your DHT-blocking shampoo 3× weekly with 3-5 minutes of contact time. This is the highest-ROI density prevention habit at your stage; take monthly overhead photos so any early mid-scalp thinning is caught the moment it starts.'
                                        : _hasMinoxidil
                                        ? 'Your minoxidil is active at NW1 where mid-scalp density is fully intact — a proactive preventive step at this optimal window. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression complement: minoxidil supports general follicle health while the DHT shampoo directly blocks the miniaturization driver at the scalp surface. Take monthly overhead photos to catch any early mid-scalp change the moment it begins.'
                                        : 'Your density is strong at NW1 — protect it now before any miniaturization begins. Add a DHT-blocking shampoo 3× weekly with 3-5 minutes of contact time; prevention here costs far less effort than treating mid-scalp thinning later.')
                    : data.stage === 'NW2'
                    // NW2: density intact mid-scalp, early miniaturization at temple corners only
                    ? (_hasFinasteride && _hasDHTShampoo && _hasMinoxidil
                        ? 'NW2 density is fully intact mid-scalp with early miniaturization beginning at the temple corners — your finasteride + minoxidil + DHT-blocking shampoo delivers systemic DHT suppression, topical growth signal, and local DHT control across both temple zones. Apply minoxidil specifically to both temple corners twice daily and leave DHT shampoo on 3-5 minutes per wash 3× weekly to maximize absorption at the active miniaturization sites. Track with monthly front-facing photos to catch any mid-scalp spread early; at NW2 the density response window is fully open.'
                        : _hasFinasteride && _hasDHTShampoo
                          ? 'Your finasteride + DHT-blocking shampoo delivers dual-level DHT suppression at the NW2 temple corners where early miniaturization is active — keep DHT shampoo on 3-5 minutes per wash 3× weekly and take finasteride at the same time each day. Add minoxidil applied to both temple corners twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the strongest density-protection stack at this early, reversible stage.'
                          : _hasFinasteride && _hasMinoxidil
                            ? 'Finasteride + minoxidil delivers systemic DHT suppression and a topical growth signal to the NW2 temple corners where early miniaturization is active — apply minoxidil specifically to both temple corners twice daily. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the local DHT-suppression complement; the three-layer Rx stack stops the density clock at your temple corners before mid-scalp thinning can develop.'
                            : _hasFinasteride
                              ? 'Finasteride is suppressing systemic DHT at NW2 where only the temple corners are showing early miniaturization — add minoxidil applied to both temple corners twice daily and a DHT-blocking shampoo 3× weekly as the topical density-protection layers. Together with finasteride they complete the triple-layer protocol that protects mid-scalp density and addresses the active temple-corner miniaturization at this optimal intervention window.'
                              : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                ? 'NW2 density is fully intact mid-scalp with early miniaturization at the temple corners — your supplement stack, minoxidil, and DHT-blocking shampoo cover nutritional follicle support, topical growth signal, and local DHT suppression at both temple zones. Apply minoxidil to both temple corners twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. At NW2 the density response window is wide open; your three OTC layers plus monthly front-facing tracking give the strongest preventive density protocol at this early stage.'
                                : _hasSupplements && _hasDHTShampoo
                                  ? 'Your supplement stack and DHT-blocking shampoo cover nutritional follicle support and topical DHT suppression at the NW2 temple corners where early miniaturization is beginning — keep DHT shampoo on 3-5 minutes per wash 3× weekly and your supplement routine consistent. Add minoxidil applied to both temple corners twice daily as the topical growth signal; supplements + minoxidil + DHT shampoo is the strongest OTC triple-layer density approach at this early, reversible NW2 stage.'
                                  : _hasSupplements && _hasMinoxidil
                                    ? 'Your supplement stack and minoxidil cover nutritional follicle support and a topical growth signal at the NW2 temple corners where early miniaturization is beginning — apply minoxidil specifically to both temple corners twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the local DHT-suppression layer; supplements + minoxidil + DHT shampoo is the strongest OTC triple-layer density approach and catches the miniaturization at this optimal prevention window.'
                                    : _hasMinoxidil && _hasDHTShampoo
                                      ? 'Your minoxidil and DHT-blocking shampoo provide a topical growth signal and local DHT suppression at the NW2 temple corners where early miniaturization is active — apply minoxidil to both temple corners twice daily and leave DHT shampoo on 3-5 minutes per wash 3× weekly. The miniaturization at NW2 is still early and fully reversible with consistent topical coverage; add a supplement stack (biotin, zinc, vitamin D) as the nutritional third layer to complete the OTC density-protection protocol.'
                                      : _hasSupplements && _hasMassage
                                        ? (_hasLLLT
                                            ? 'At NW2, your supplement stack and LLLT device cover nutritional support and photobiomodulation at the early temple-corner miniaturization zones — keep your supplement routine consistent and your LLLT sessions on schedule. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary preventive layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx density protection at this early stage before any mid-scalp spread develops.'
                                            : _hasMicroneedling
                                            ? 'At NW2, your supplement stack and microneedling cover nutritional support and scalp priming at the early temple-corner miniaturization zones — use microneedling 24-48 hours before any topical application to maximize absorption at the temple corners. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary preventive layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx density protection at this early stage before any mid-scalp spread develops.'
                                            : 'At NW2, your supplement stack and scalp massage cover nutritional support and mechanical stimulation at the early temple-corner miniaturization zones — apply your scalp massage with focus on both temple corners where miniaturization is just beginning. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary preventive layers (nutritional + mechanical + DHT suppression) give the strongest non-Rx density protection at this early stage before any mid-scalp spread develops.')
                                        : _hasSupplements
                                          ? 'Your supplement stack provides nutritional follicle support at NW2 where early temple-corner miniaturization is beginning — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) and minoxidil to both temple corners twice daily as the topical density-protection layers. Catching the miniaturization with a three-layer OTC approach at this early NW2 stage gives the best possible density-preservation outcome before any mid-scalp spread develops.'
                                          : _hasDHTShampoo && _hasMassage
                                            ? (_hasLLLT
                                                ? 'At NW2, your DHT-blocking shampoo and LLLT device cover topical DHT suppression and photobiomodulation at the early temple-corner miniaturization zones — schedule your LLLT session on DHT shampoo wash days so the follicle microenvironment is primed. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer; three complementary preventive layers (DHT suppression + photobiomodulation + nutritional) give the strongest non-Rx density protection at this early NW2 stage before any mid-scalp spread develops.'
                                                : _hasMicroneedling
                                                ? 'At NW2, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming at the early temple-corner miniaturization zones — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer; three complementary preventive layers (DHT suppression + scalp priming + nutritional) give the strongest non-Rx density protection at this early NW2 stage before any mid-scalp spread develops.'
                                                : 'At NW2, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation at the early temple-corner miniaturization zones — leave DHT shampoo on 3-5 minutes per wash 3× weekly and focus your scalp massage on both temple corners. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer; three complementary preventive layers (DHT suppression + mechanical + nutritional) give the strongest non-Rx density protection at this early NW2 stage before any mid-scalp spread develops.')
                                            : _hasDHTShampoo
                                              ? 'Your DHT-blocking shampoo is suppressing local DHT at the NW2 temple corners where early miniaturization is active — keep it on 3-5 minutes per wash 3× weekly. Add minoxidil to both temple corners twice daily as the topical growth signal; the combination stops the density clock at your temple corners before mid-scalp thinning can develop.'
                                              : _hasMinoxidil
                                                ? 'Your minoxidil is providing a topical growth signal at the NW2 temple corners where early miniaturization is beginning — apply it specifically to both temple corners twice daily for targeted coverage. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) to directly suppress the DHT driving miniaturization at the temple zones; early NW2 is the optimal window where consistent topical treatment produces the strongest density-preservation response.'
                                                : 'At NW2, early temple-corner miniaturization is the only density concern — mid-scalp density is fully intact. Start a DHT-blocking shampoo 3× weekly with 3-5 minutes of contact time and minoxidil applied to both temple corners twice daily this week. NW2 is the optimal intervention window for density preservation; consistent topical coverage at the temple corners now prevents mid-scalp spread and keeps density options open.')
                    : data.stage === 'NW1'
                      // NW1: density is fully intact — messaging focuses on prevention, not treatment of existing loss
                      ? (_hasFinasteride && _hasDHTShampoo
                          ? 'At NW1 your density is fully intact and finasteride + DHT-blocking shampoo gives you dual-level DHT suppression at the ideal early prevention stage — finasteride handles systemic DHT and the DHT shampoo adds topical control. Leave DHT shampoo on 3-5 minutes per wash 3× weekly and take finasteride at the same time each day. Monthly front-facing photos are your early-warning system for any temple-corner change; your density is well-protected at this stage.'
                          : _hasFinasteride
                            ? 'Finasteride at NW1 gives you systemic DHT suppression at the ideal early prevention stage — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control. Dual-level DHT suppression at NW1 is the strongest long-term density preservation approach while follicles are still fully intact and the prevention window is open.'
                            : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                              ? 'At NW1, your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer preventive density protocol — nutritional follicle support, topical growth signal, and local DHT suppression all active while your density is fully intact. Apply minoxidil to the temple corners twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. Monthly front-facing photos are your early-warning system; your density is well-protected with all three preventive layers active.'
                              : _hasMinoxidil && _hasDHTShampoo
                                ? 'At NW1, your minoxidil and DHT-blocking shampoo cover the topical growth signal and local DHT suppression at the ideal preventive stage — apply minoxidil to the temple corners twice daily and leave DHT shampoo on 3-5 minutes per wash 3× weekly. Your density is fully intact; a supplement stack (biotin, zinc, vitamin D) adds the nutritional prevention layer to complete a three-layer OTC protocol. Monthly front-facing photos are your early-warning system for any temple-corner change.'
                                : _hasSupplements && _hasMassage
                                  ? (_hasLLLT
                                      ? 'At NW1, your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation at the ideal early prevention stage — keep your supplement routine consistent and your LLLT sessions on schedule. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary prevention layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx density foundation while your density is fully intact and the prevention window is open. Monthly front-facing photos are your early-warning system for any early temple change.'
                                      : _hasMicroneedling
                                      ? 'At NW1, your supplement stack and microneedling cover nutritional follicle support and scalp priming at the ideal early prevention stage — use microneedling 24-48 hours before any topical application to maximize absorption while follicles are fully intact. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary prevention layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx density foundation at this optimal window. Monthly front-facing photos are your early-warning system.'
                                      : 'At NW1, your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at the ideal early prevention stage — keep your supplement routine consistent and your daily scalp massage focused on the temple corners. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary prevention layers (nutritional + mechanical + DHT suppression) give the strongest non-Rx density foundation while your density is fully intact and the prevention window is open. Monthly front-facing photos are your early-warning system.')
                                  : _hasSupplements && _hasDHTShampoo
                                    ? 'At NW1, your supplement stack and DHT-blocking shampoo cover nutritional follicle support and topical DHT suppression at the ideal preventive stage — keep DHT shampoo on 3-5 minutes per wash 3× weekly and your supplement routine consistent. Add minoxidil to the temple corners twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC three-layer preventive density protocol at NW1. Monthly front-facing photos are your early-warning system for any early temple change.'
                                    : _hasDHTShampoo && _hasMassage
                                      ? (_hasLLLT
                                          ? 'At NW1, your DHT-blocking shampoo and LLLT device cover topical DHT suppression and photobiomodulation at the ideal early prevention stage — schedule your LLLT session on DHT shampoo wash days so the follicle microenvironment is optimally primed. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional prevention layer; three complementary layers (DHT suppression + photobiomodulation + nutritional) give the strongest non-Rx density foundation while your density is fully intact and the prevention window is open.'
                                          : _hasMicroneedling
                                          ? 'At NW1, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming at the ideal early prevention stage — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional prevention layer; three complementary layers (DHT suppression + scalp priming + nutritional) give the strongest non-Rx density foundation at NW1.'
                                          : 'At NW1, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation at the ideal early prevention stage — leave DHT shampoo on 3-5 minutes per wash 3× weekly and keep your daily scalp massage focused on the temple corners. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional prevention layer; three complementary prevention layers (DHT suppression + mechanical + nutritional) give the strongest non-Rx density foundation while your density is fully intact and the prevention window is open.')
                                      : _hasDHTShampoo
                                        ? 'Your DHT-blocking shampoo is already protecting your NW1 density — leave it on 3-5 minutes per wash 3× weekly. At NW1 your density is fully intact; the highest-ROI next addition is a supplement stack (biotin, zinc, vitamin D) for the nutritional prevention layer. Monthly front-facing photos are your early-warning system for any early temple change.'
                                        : _hasSupplements
                                          ? 'Your supplement stack provides nutritional follicle support at NW1 where your density is fully intact — nutritional support is a solid preventive foundation. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; DHT shampoo at NW1 is the highest-ROI preventive addition while follicles are at their most responsive and the density window is fully open. Monthly front-facing photos are your early-warning system for any early temple change.'
                                          : 'At NW1 your density is fully intact — protect it now with a DHT-blocking shampoo 3× weekly (3-5 min contact time). This is the ideal preventive stage: slowing any future miniaturization before it begins is far easier than reversing it later. Monthly front-facing photos establish your density baseline.')
                      : _hasFinasteride && _hasMassage
                          ? 'Finasteride + scalp massage is a solid foundation — add weekly microneedling (0.5mm) over the thinning zones to prime follicle absorption and boost local circulation alongside the systemic DHT suppression you already have.'
                          : _hasFinasteride
                            ? 'Finasteride already provides systemic DHT suppression — add a 5-minute scalp massage each session and weekly microneedling to complement it. Mechanical stimulation is the highest-ROI addition alongside your existing Rx treatment.'
                            : (_hasDHTShampoo && _hasMassage
                                ? 'DHT-blocking shampoo and scalp stimulation are both active — time them for best effect: microneedle on the thinning zones 24-48 hours before topical application to open absorption channels.'
                                : _hasDHTShampoo
                                  ? "You're using a DHT-blocking shampoo — add a 5-minute scalp massage each wash session and consider microneedling once a week to prime follicle response."
                                  : 'Add a DHT-blocking shampoo 3× this week and follow with a 5-minute scalp massage each time to boost circulation.'),
          Crown: _isNW7
            ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                ? 'At NW7, your finasteride + minoxidil + DHT-blocking shampoo delivers systemic DHT suppression, topical growth signal, and local DHT control for the remaining fringe — keep all three consistent without gaps. Crown vertex coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your triple-layer protocol fits into the surgical plan.'
                : _hasFinasteride && _hasDHTShampoo
                ? 'Your finasteride + DHT-blocking shampoo at NW7 delivers dual-level DHT suppression for the remaining fringe — keep both consistent. Crown coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your dual-layer DHT protocol fits into the surgical plan.'
                : _hasFinasteride && _hasMinoxidil
                ? 'Your finasteride + minoxidil at NW7 delivers systemic DHT suppression and a topical growth signal for the remaining fringe — keep both consistent. Crown coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your dual-layer protocol fits into the surgical plan.'
                : _hasFinasteride
                ? 'Your finasteride at NW7 helps protect the remaining fringe from further miniaturization — keep it consistent. Crown coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your systemic treatment fits into the surgical plan.'
                : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                ? 'Your supplement stack, minoxidil, and DHT-blocking shampoo provide nutritional support, topical growth signal, and local DHT suppression for remaining fringe follicles at NW7 — apply minoxidil to the fringe and lateral edges twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement stack consistent. Crown vertex coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your three-layer OTC protocol integrates with the surgical coverage plan.'
                : _hasSupplements && _hasDHTShampoo
                ? 'Your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression for remaining fringe follicles at NW7 — keep DHT shampoo on 3-5 minutes per wash 3× weekly and your supplement stack consistent. Crown vertex coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your nutritional + topical DHT protocol integrates with the surgical coverage plan.'
                : _hasSupplements && _hasMinoxidil
                ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for the remaining horseshoe fringe at NW7 — apply minoxidil to the fringe and lateral edges twice daily and keep your supplement routine consistent. Crown vertex coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your nutritional and topical protocol integrates with the surgical coverage plan.'
                : _hasMinoxidil && _hasDHTShampoo
                ? 'Your minoxidil + DHT-blocking shampoo provides a topical growth signal and local DHT suppression for the remaining fringe at NW7 — apply minoxidil to the fringe and lateral edges twice daily and leave DHT shampoo on 3-5 minutes per wash. Crown coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your dual-layer topical protocol fits into the surgical plan.'
                : _hasDHTShampoo
                ? 'Your DHT-blocking shampoo provides topical DHT suppression for the remaining fringe at NW7 — keep using it 3× weekly with 3-5 minutes of contact time. Crown coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult to discuss vertex coverage goals and realistic outcomes alongside your OTC maintenance.'
                : _hasMinoxidil
                ? 'Your minoxidil provides a topical growth signal for the remaining horseshoe fringe at NW7 — keep applying it consistently. Crown coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and realistic outcomes alongside your topical maintenance.'
                : _hasSupplements && _hasMassage
                ? (_hasLLLT
                    ? 'Your supplement stack and LLLT device provide nutritional follicle support and photobiomodulation for the remaining fringe at NW7 — keep your supplement routine consistent and your LLLT sessions on schedule. Crown vertex coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your nutritional and photobiomodulation protocol integrates with the surgical coverage plan.'
                    : _hasMicroneedling
                    ? 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming for the remaining fringe at NW7 — keep your supplement routine consistent and use microneedling 24-48 hours before any topical application along the fringe to prime absorption. Crown vertex coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your nutritional and scalp priming protocol integrates with the surgical coverage plan.'
                    : 'Your supplement stack and scalp massage provide nutritional follicle support and mechanical stimulation for the remaining fringe at NW7 — keep your supplement routine consistent and massage along the fringe and lateral edges daily. Crown vertex coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your current protocol integrates into the surgical plan.')
                : _hasSupplements
                ? 'Your supplement stack supports remaining fringe follicle health at NW7 — nutritional support is a useful baseline layer for the horseshoe fringe. Crown coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and realistic outcomes alongside your supplement routine.'
                : 'Crown coverage at NW7 is best addressed through FUE/FUT or SMP — prioritize a specialist consultation to discuss vertex coverage goals and realistic outcomes.')
            : _isNW5only
              ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo && _hasMassage
                  ? (_hasLLLT
                      ? 'NW5 crown thinning with finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical vertex protocol — confirm 1ml minoxidil reaches the vertex directly after your LLLT session while scalp circulation is elevated, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. Track with overhead photos every 4 weeks to monitor how quickly the frontal and crown zones are merging; book a transplant consultation in parallel for full vertex coverage planning.'
                      : _hasMicroneedling
                      ? 'NW5 crown thinning with finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical vertex protocol — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml directly to the vertex twice daily as normal; leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. Track with overhead photos every 4 weeks to monitor how quickly the frontal and crown zones are merging; book a transplant consultation in parallel for full vertex coverage planning.'
                      : 'NW5 crown thinning with finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical vertex protocol — confirm 1ml minoxidil reaches the vertex directly after each scalp massage, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. Track with overhead photos every 4 weeks to monitor how quickly the frontal and crown zones are merging; book a transplant consultation in parallel for full vertex coverage planning.')
                  : _hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                    ? 'At NW5, finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control at the crown zone — add a 4-minute scalp massage before each topical application to prime vertex follicle absorption where the frontal and crown zones are closest to merging. Track with monthly overhead photos and consider booking a transplant consultation for full vertex coverage planning.'
                    : _hasFinasteride && _hasMinoxidil && _hasMassage
                      ? (_hasLLLT
                          ? 'NW5 crown thinning with finasteride + minoxidil + LLLT is a strong non-surgical vertex protocol — confirm 1ml minoxidil reaches the vertex directly after your LLLT session while scalp circulation is elevated, and take finasteride at the same time each day. Track with overhead photos every 4 weeks to monitor how quickly the frontal and crown zones are merging. A transplant consultation in parallel is worth prioritizing this quarter for full vertex coverage planning.'
                          : _hasMicroneedling
                          ? 'NW5 crown thinning with finasteride + minoxidil + microneedling is a strong non-surgical vertex protocol — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml directly to the vertex twice daily as normal; take finasteride at the same time each day. Track with overhead photos every 4 weeks to monitor how quickly the frontal and crown zones are merging. A transplant consultation in parallel is worth prioritizing this quarter for full vertex coverage planning.'
                          : 'NW5 crown thinning with finasteride + minoxidil + massage is the most complete non-surgical vertex protocol — confirm 1ml minoxidil reaches the vertex directly after each scalp massage, and take finasteride at the same time each day. Track with overhead photos every 4 weeks to monitor how quickly the frontal and crown zones are merging. A transplant consultation in parallel is worth prioritizing this quarter for full vertex coverage planning.')
                      : _hasFinasteride && _hasMinoxidil
                        ? 'At NW5, finasteride + minoxidil is the most evidence-backed non-surgical crown protocol — apply 1ml minoxidil directly to the vertex twice daily and take finasteride at the same time each day. Add a 4-minute scalp massage before each topical application to prime vertex absorption where the frontal and crown zones are closest to merging. Track with monthly overhead photos.'
                        : _hasFinasteride && _hasDHTShampoo
                          ? 'Finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression at the NW5 crown zone where the frontal and crown thinning areas are nearly merging — take finasteride at the same time each day and leave DHT shampoo on 3-5 minutes per wash 3× weekly. Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the strongest non-surgical crown protocol at this advanced stage. Pair each application with a 4-minute scalp massage and track with overhead photos every 4 weeks.'
                        : _hasFinasteride
                          ? 'Finasteride is suppressing systemic DHT at the NW5 crown zone — add minoxidil (1ml) directly to the vertex twice daily for the topical growth signal. Finasteride + minoxidil is the most effective non-surgical combination for NW5 crown coverage; pair each application with a 4-minute scalp massage and track with monthly overhead photos.'
                          : _hasMinoxidil && _hasDHTShampoo && _hasMassage
                              ? (_hasLLLT
                                  ? 'At NW5, your minoxidil, DHT shampoo, and LLLT cover topical growth signal, local DHT suppression, and photobiomodulation at the crown — apply 1ml minoxidil directly to the vertex immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes on wash days. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW5 crown protocol; track with overhead photos every 4 weeks.'
                                  : _hasMicroneedling
                                  ? 'At NW5, your minoxidil, DHT shampoo, and microneedling cover topical growth signal, local DHT suppression, and scalp priming at the crown — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml directly to the vertex twice daily as normal; leave DHT shampoo on 3-5 minutes on wash days. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW5 crown protocol; track with overhead photos every 4 weeks.'
                                  : 'At NW5, your minoxidil, DHT shampoo, and scalp massage cover the three OTC layers at the crown — apply 1ml minoxidil directly to the vertex immediately after your scalp massage and leave DHT shampoo on 3-5 minutes on wash days. Add weekly microneedling over the crown to prime follicle response. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW5 crown protocol; track with overhead photos every 4 weeks.')
                              : _hasMinoxidil && _hasDHTShampoo && _hasSupplements
                                  ? 'At NW5, your supplement stack, minoxidil, and DHT-blocking shampoo deliver nutritional follicle support, topical growth signal, and local DHT control at the crown — apply 1ml minoxidil directly to the vertex twice daily, leave DHT shampoo on 3-5 minutes on wash days, and keep your supplement routine consistent. Add a 4-minute scalp massage before each application and weekly microneedling over the crown to prime vertex follicle absorption at this advanced stage. Consider a doctor consult about finasteride for systemic DHT suppression; track with overhead photos every 4 weeks.'
                              : _hasMinoxidil && _hasDHTShampoo
                                  ? 'At NW5, your minoxidil and DHT shampoo cover topical growth signal and local DHT suppression at the crown — apply 1ml minoxidil directly to the vertex twice daily and leave DHT shampoo on 3-5 minutes on wash days. Add a 4-minute scalp massage before each application and weekly microneedling to prime vertex follicle absorption. A doctor consult about finasteride adds systemic DHT suppression for the strongest NW5 crown protocol; track with overhead photos every 4 weeks.'
                                  : _hasMinoxidil && _hasMassage
                                      ? (_hasLLLT
                                          ? 'At NW5, your minoxidil and LLLT target the crown directly — apply 1ml to the vertex immediately after your LLLT session while scalp circulation is elevated so freshly primed follicles absorb it. Add weekly microneedling over the crown to prime follicle response and take overhead photos every 4 weeks to track how quickly the frontal and crown thinning zones are merging.'
                                          : _hasMicroneedling
                                          ? 'At NW5, your minoxidil and microneedling target the crown directly — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml directly to the vertex twice daily as normal; microneedling primes follicle absorption where crown thinning is most advanced. Take overhead photos every 4 weeks to track how quickly the frontal and crown thinning zones are merging.'
                                          : 'At NW5, your minoxidil and massage target the right zones — confirm 1ml reaches the vertex directly, not just the sides. Add weekly microneedling over the crown to prime follicle response and take overhead photos every 4 weeks to track how quickly the frontal and crown thinning zones are merging.')
                                      : _hasSupplements && _hasMinoxidil
                                          ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at the NW5 crown vertex where the frontal and crown zones are nearly merging — apply 1ml minoxidil directly to the vertex twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the local DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer crown approach at this advanced stage. Consider a doctor consult about finasteride for systemic DHT suppression; take an overhead photo today as your baseline.'
                                      : _hasMinoxidil
                                        ? 'NW5 crown thinning is substantial — apply 1ml minoxidil directly to the vertex twice daily after a 4-minute scalp massage to maximize absorption, then add weekly microneedling. The goal is slowing how quickly the frontal and crown zones merge; photograph from above every 4 weeks to track the bridge.'
                                        : _hasSupplements && _hasDHTShampoo
                                          ? 'At NW5, your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression at the crown vertex — leave DHT shampoo on 3-5 minutes per wash. Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC crown protocol where the frontal and crown zones are nearly merging. Pair each application with a 4-minute scalp massage and consider a doctor consult about finasteride for systemic DHT suppression. Take an overhead photo today as your baseline.'
                                          : _hasDHTShampoo
                                            ? 'NW5 crown thinning is substantial — your DHT-blocking shampoo provides topical DHT suppression at the vertex where the frontal and crown zones are closest to merging. Leave it on 3-5 minutes per wash and add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; DHT shampoo + minoxidil is the strongest OTC combination for the NW5 crown zone. Take an overhead photo today as your baseline and consider booking a transplant consultation for full vertex coverage planning.'
                                            : _hasSupplements && _hasMassage
                                              ? (_hasLLLT
                                                  ? 'Your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation at the NW5 crown vertex where the frontal and crown zones are nearly merging — keep your supplement routine consistent and maintain your LLLT sessions on schedule. Apply any topical immediately after your LLLT session while scalp circulation is elevated and add minoxidil (1ml) directly to the vertex twice daily; supplements + LLLT + minoxidil addresses crown thinning from nutritional and photobiomodulation angles at this advanced stage. Take an overhead photo today as your baseline and consider a doctor consult about finasteride for systemic DHT suppression.'
                                                  : _hasMicroneedling
                                                  ? 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming at the NW5 crown vertex where the frontal and crown zones are nearly merging — keep your supplement routine consistent and wait 24-48 hours after each microneedling session before applying topicals to the vertex (applying immediately after needling risks follicle irritation). Add minoxidil (1ml) directly to the vertex twice daily on non-needling days; supplements + microneedling + minoxidil addresses crown thinning from nutritional and mechanical priming angles at this advanced stage. Take an overhead photo today as your baseline and consider a doctor consult about finasteride for systemic DHT suppression.'
                                                  : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at the NW5 crown vertex where the frontal and crown zones are nearly merging — keep your supplement routine consistent and massage the crown daily. Add minoxidil (1ml) directly to the vertex twice daily immediately after each scalp massage so freshly primed follicles absorb it; supplements + massage + minoxidil addresses crown thinning from nutritional and mechanical angles at this advanced stage. Take an overhead photo today as your baseline and consider a doctor consult about finasteride for systemic DHT suppression.')
                                            : _hasSupplements
                                              ? 'Your supplement stack supports crown follicle health at NW5 where the frontal and crown thinning zones are nearly merging — add minoxidil (1ml) directly to the vertex twice daily and a DHT-blocking shampoo 3× weekly (3-5 min contact time). Nutritional support + topical growth signal + local DHT suppression is the three-layer OTC crown protocol at this advanced stage; take an overhead photo today as your baseline and consider a doctor consult about finasteride.'
                                              : 'NW5 crown thinning is large and the frontal zone is nearly merging — start minoxidil (1ml) directly on the vertex twice daily paired with weekly microneedling. Stabilizing the bridge between the two thinning zones is the realistic near-term goal; take an overhead photo today as your baseline.')
              : _isNW56
              // only NW6 reaches here — NW5 is handled by _isNW5only above
              ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                  ? 'At NW6, finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control for crown coverage — apply 1ml minoxidil to the vertex twice daily, leave DHT shampoo on 3-5 minutes per wash, and keep finasteride consistent. Add weekly microneedling over the crown zone and photograph from above every 6 weeks to track change; consider booking a transplant consultation for vertex coverage planning.'
                  : _hasFinasteride && _hasMinoxidil
                    ? 'At NW6, finasteride + minoxidil applied to the vertex twice daily is the most complete non-surgical protocol for crown coverage — keep both consistent. Add weekly microneedling over the crown zone and photograph from above every 6 weeks to track change. Booking a transplant consultation for vertex coverage planning is worth prioritizing this quarter.'
                    : _hasFinasteride && _hasDHTShampoo
                    ? 'Finasteride + DHT-blocking shampoo at NW6 delivers dual-level DHT suppression for the crown — systemic through finasteride and topical through the shampoo (3-5 min contact time 3× weekly). Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the strongest non-surgical crown protocol at this stage. Photograph from above every 6 weeks to track change and consider booking a transplant consultation for vertex coverage planning.'
                    : _hasFinasteride
                      ? 'Finasteride is suppressing systemic DHT at NW6 — add minoxidil (1ml) directly to the vertex twice daily for the topical growth signal. Together they form the strongest non-surgical approach for crown; photograph overhead every 6 weeks and consider booking a transplant consultation for vertex coverage planning.'
                      : _hasMinoxidil && _hasDHTShampoo && _hasMassage
                        ? (_hasLLLT
                            ? 'Apply minoxidil directly to the crown (1ml) twice daily at NW6, immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes on wash days — photograph from above every 6 weeks to track change. Consider booking a transplant consultation to evaluate vertex coverage options alongside your OTC maintenance.'
                            : _hasMicroneedling
                            ? 'Apply minoxidil directly to the crown (1ml) twice daily at NW6 — wait 24-48 hours after each microneedling session before applying (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; leave DHT shampoo on 3-5 minutes on wash days and photograph from above every 6 weeks to track change. Consider booking a transplant consultation to evaluate vertex coverage options alongside your OTC maintenance.'
                            : 'Apply minoxidil directly to the crown (1ml) twice daily at NW6, immediately after each scalp massage and leave DHT shampoo on 3-5 minutes on wash days — add weekly microneedling over the crown zone and photograph from above every 6 weeks to track change. Consider booking a transplant consultation to evaluate vertex coverage options alongside your OTC maintenance.')
                        : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                          ? 'At NW6, your supplement stack, minoxidil, and DHT-blocking shampoo deliver the strongest OTC three-layer crown protocol — nutritional follicle support, topical growth signal, and local DHT suppression all active. Apply minoxidil (1ml) directly to the vertex twice daily, leave DHT shampoo on 3-5 minutes per wash, and keep your supplement routine consistent. Add weekly microneedling over the crown zone and photograph from above every 6 weeks to track change; consider booking a transplant consultation to evaluate vertex coverage options alongside your OTC maintenance.'
                        : _hasMinoxidil && _hasDHTShampoo
                          ? 'Apply minoxidil directly to the crown (1ml) twice daily at NW6 and leave DHT shampoo on 3-5 minutes on wash days — add a 4-minute scalp massage before each application and weekly microneedling to prime vertex follicle response. Photograph from above every 6 weeks to track change and consider booking a transplant consultation to evaluate vertex coverage options.'
                          : _hasMinoxidil && _hasMassage
                            ? (_hasLLLT
                                ? 'Apply minoxidil directly to the crown (1ml) twice daily at NW6, immediately after your LLLT session while scalp circulation is elevated to prime follicle absorption — add weekly microneedling over the crown zone and photograph from above every 6 weeks to track change. Consider booking a transplant consultation to evaluate vertex coverage options.'
                                : _hasMicroneedling
                                ? 'Apply minoxidil directly to the crown (1ml) twice daily at NW6 — wait 24-48 hours after each microneedling session before applying (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; microneedling may improve topical follicle response across the crown zone. Photograph from above every 6 weeks to track change and consider booking a transplant consultation to evaluate vertex coverage options.'
                                : 'Apply minoxidil directly to the crown (1ml) twice daily at NW6, immediately after each scalp massage to prime follicle absorption — add weekly microneedling over the crown zone and photograph from above every 6 weeks to track change. Consider booking a transplant consultation to evaluate vertex coverage options.')
                            : _hasSupplements && _hasMinoxidil
                              ? 'At NW6, your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for the crown — apply minoxidil (1ml) directly to the vertex twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical DHT suppression to complete the OTC crown protocol; supplements + minoxidil + DHT shampoo is the strongest three-layer crown stack at this advanced stage. Photograph from above every 6 weeks to track change and consider booking a transplant consultation for vertex coverage planning.'
                            : _hasMinoxidil
                              ? 'Apply minoxidil directly to the crown (1ml) twice daily at NW6 and add weekly microneedling to prime follicle response — manage expectations and photograph from above every 6 weeks to track change. Consider booking a transplant consultation to evaluate vertex coverage options.'
                              : _hasSupplements && _hasDHTShampoo
                                ? 'At NW6, your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression for the crown — keep DHT shampoo on 3-5 minutes per wash. Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC crown protocol at this advanced stage. Photograph from above every 6 weeks to track change and consider booking a transplant consultation for full vertex coverage planning.'
                                : _hasDHTShampoo
                                  ? 'Your DHT-blocking shampoo provides topical DHT suppression at the NW6 crown zone — keep using it 3× weekly with 3-5 minutes of contact time. Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; DHT shampoo + minoxidil is the strongest OTC crown combination at this stage. Photograph from above every 6 weeks to track change and consider booking a transplant consultation to evaluate vertex coverage options alongside your OTC maintenance.'
                                  : _hasSupplements && _hasMassage
                                    ? (_hasLLLT
                                        ? 'Your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation at the NW6 crown zone where the frontal and crown have merged — keep your supplement routine consistent and maintain your LLLT sessions on schedule. Add minoxidil (1ml) directly to the vertex twice daily immediately after your LLLT session while scalp circulation is elevated; supplements + LLLT + minoxidil addresses what crown coverage remains from nutritional and photobiomodulation angles. Photograph from above every 6 weeks to track change and consider booking a transplant consultation to evaluate vertex coverage options alongside your OTC maintenance.'
                                        : _hasMicroneedling
                                        ? 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming at the NW6 crown zone where the frontal and crown have merged — keep your supplement routine consistent and wait 24-48 hours after each microneedling session before applying topicals to the vertex (applying immediately after needling risks follicle irritation). Add minoxidil (1ml) directly to the vertex twice daily on non-needling days; supplements + microneedling + minoxidil addresses what crown coverage remains from nutritional and mechanical priming angles. Photograph from above every 6 weeks to track change and consider booking a transplant consultation to evaluate vertex coverage options alongside your OTC maintenance.'
                                        : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at the NW6 crown zone where the frontal and crown have merged — keep your supplement routine consistent and massage the crown daily. Add minoxidil (1ml) directly to the vertex twice daily immediately after each scalp massage; supplements + massage + minoxidil addresses what crown coverage remains from nutritional and mechanical angles. Photograph from above every 6 weeks to track change and consider booking a transplant consultation to evaluate vertex coverage options alongside your OTC maintenance.')
                                  : _hasSupplements
                                    ? 'Your supplement stack supports crown follicle health at NW6 — add minoxidil (1ml) directly to the vertex twice daily and a DHT-blocking shampoo 3× weekly (3-5 min contact time). Nutritional support + topical growth signal + local DHT suppression is the OTC crown protocol for fringe maintenance at this advanced stage; photograph from above every 6 weeks to track change and consider booking a transplant consultation for vertex coverage planning.'
                                    : 'Apply minoxidil directly to the crown/vertex (1ml) twice daily and add weekly microneedling — manage expectations and photograph from above every 6 weeks to track any change.')
              : data.stage === 'NW4'
                // NW4 crown thinning is significant and well-established; needs direct targeted topical + realistic timeline
                ? (_hasFinasteride && _hasDHTShampoo && _hasMinoxidil && _hasMassage)
                    ? (_hasLLLT
                        ? 'NW4 crown with finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical crown protocol — apply 1ml minoxidil to the vertex immediately after your LLLT session while scalp circulation is elevated, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time daily. Consistent four-layer coverage over 4-6 months gives the strongest documented non-surgical crown response at this established stage. Track with monthly overhead photos.'
                        : _hasMicroneedling
                        ? 'NW4 crown with finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical crown protocol — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml directly to the vertex twice daily as normal; leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time daily. Consistent four-layer coverage over 4-6 months gives the strongest documented non-surgical crown response at this established stage. Track with monthly overhead photos.'
                        : 'NW4 crown with finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical crown protocol — apply 1ml minoxidil to the vertex immediately after a 4-minute scalp massage, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time daily. Consistent four-layer coverage over 4-6 months gives the strongest documented non-surgical crown response at this established stage. Track with monthly overhead photos.')
                    : (_hasFinasteride && _hasDHTShampoo && _hasMinoxidil)
                      ? 'At NW4, finasteride + minoxidil + DHT shampoo delivers systemic and topical DHT suppression alongside the topical growth signal for crown coverage — apply 1ml minoxidil directly to the vertex twice daily and leave DHT shampoo on 3-5 minutes on wash days. Add a 4-minute scalp massage before each topical application to complete the protocol and prime vertex follicle absorption at this established stage. Track with monthly overhead photos.'
                      : (_hasFinasteride && _hasMinoxidil && _hasMassage)
                        ? (_hasLLLT
                            ? 'NW4 crown with finasteride + minoxidil + LLLT is a strong non-surgical crown protocol — apply 1ml minoxidil to the vertex immediately after your LLLT session while scalp circulation is elevated, and take finasteride at the same time each day. Consistent coverage over 4-6 months is what produces visible crown density change at this stage. Track with monthly overhead photos.'
                            : _hasMicroneedling
                            ? 'NW4 crown with finasteride + minoxidil + microneedling is a strong non-surgical crown protocol — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml directly to the vertex twice daily as normal; take finasteride at the same time each day. Consistent coverage over 4-6 months is what produces visible crown density change at this stage. Track with monthly overhead photos.'
                            : 'NW4 crown with finasteride + minoxidil + massage is the most complete non-surgical crown protocol — apply 1ml minoxidil to the vertex immediately after a 4-minute scalp massage, and take finasteride at the same time each day. Consistent dual-mechanism coverage over 4-6 months is what produces visible crown density change at this stage. Track with monthly overhead photos.')
                        : (_hasFinasteride && _hasMinoxidil)
                          ? 'At NW4, finasteride + minoxidil is the strongest non-surgical crown combination — apply 1ml minoxidil directly to the vertex twice daily and take finasteride at the same time each day. Add a 4-minute scalp massage before each topical application to prime vertex follicle absorption and improve the response from your existing stack.'
                          : _hasFinasteride && _hasDHTShampoo
                            ? 'At NW4, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression at the vertex — add minoxidil (1ml) applied directly to the crown twice daily as the topical growth signal. Finasteride + minoxidil + DHT shampoo is the strongest non-surgical crown combination at NW4; pair each minoxidil application with a 4-minute scalp massage and track with monthly overhead photos.'
                          : _hasFinasteride
                            ? 'Finasteride is suppressing DHT at NW4 — add minoxidil (1ml) applied directly to the vertex twice daily as the topical growth signal. Finasteride + minoxidil is the strongest non-surgical combination for NW4 crown coverage; pair each application with a 4-minute scalp massage and track with monthly overhead photos.'
                            : (_hasMinoxidil && _hasDHTShampoo && _hasMassage)
                              ? 'At NW4, minoxidil + DHT shampoo + scalp massage covers topical growth signal, local DHT suppression, and mechanical stimulation at the vertex — apply 1ml minoxidil to the crown immediately after your scalp massage and leave DHT shampoo on 3-5 minutes on wash days. A doctor consult about finasteride adds systemic DHT suppression for the strongest non-surgical crown response at this established stage. Track with monthly overhead photos.'
                              : (_hasMinoxidil && _hasMassage)
                                ? (_hasLLLT
                                    ? 'NW4 crown thinning responds best when minoxidil reaches the vertex directly — apply 1ml to the crown right after your LLLT session while scalp circulation is elevated so freshly primed follicles absorb it. Take an overhead photo today as your baseline; meaningful density changes take 3-4 months to show.'
                                    : _hasMicroneedling
                                    ? 'NW4 crown thinning responds best when minoxidil reaches the vertex directly — wait 24-48 hours after each microneedling session before applying minoxidil to the crown (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml to the crown twice daily as normal; microneedling primes follicle absorption where vertex thinning is most active at this established stage. Take an overhead photo today as your baseline; meaningful density changes take 3-4 months to show.'
                                    : 'NW4 crown thinning responds best when minoxidil reaches the vertex directly — apply 1ml to the crown right after your scalp massage so freshly stimulated follicles absorb it immediately. Take an overhead photo today as your baseline; meaningful density changes take 3-4 months to show.')
                                : (_hasMinoxidil && _hasDHTShampoo && _hasSupplements)
                                  ? 'Your supplement stack, minoxidil, and DHT-blocking shampoo cover nutritional follicle support, topical growth signal, and local DHT control at the NW4 crown vertex — apply 1ml minoxidil directly to the vertex twice daily, leave DHT shampoo on 3-5 minutes on wash days, and maintain your supplement routine consistently. Add a 4-minute scalp massage before each minoxidil application to prime vertex absorption, and consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly overhead photos.'
                              : (_hasMinoxidil && _hasDHTShampoo)
                                  ? 'At NW4, minoxidil + DHT shampoo covers topical growth signal and local DHT control at the vertex — apply 1ml minoxidil directly to the crown twice daily and leave DHT shampoo on 3-5 minutes on wash days. Add a 4-minute scalp massage before each minoxidil application to prime vertex absorption, and consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly overhead photos.'
                                  : _hasSupplements && _hasMinoxidil
                                    ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at the NW4 crown vertex — apply 1ml minoxidil directly to the vertex twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer crown approach at this established stage. Pair each application with a 4-minute scalp massage and consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly overhead photos.'
                                  : _hasMinoxidil
                                    ? 'At NW4, crown coverage requires targeted application — apply 1ml minoxidil directly to the vertex twice daily and add a 4-minute scalp massage before each application to prime absorption. Track with monthly overhead photos.'
                                    : _hasSupplements && _hasMassage
                                    ? (_hasLLLT
                                        ? 'At NW4, your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation at the crown vertex — keep your supplement routine consistent and your LLLT sessions on schedule. Apply any topicals immediately after your LLLT session while scalp circulation is elevated; adding minoxidil (1ml) directly to the vertex twice daily is the highest-ROI next topical layer at this established stage. Consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly overhead photos.'
                                        : _hasMicroneedling
                                        ? 'At NW4, your supplement stack and microneedling cover nutritional follicle support and scalp priming at the crown vertex — wait 24-48 hours after each microneedling session before applying topicals to the vertex (applying immediately after needling risks follicle irritation). Add minoxidil (1ml) directly to the vertex twice daily on non-needling days; supplement + microneedling primes vertex follicles for maximum topical response at this established stage. Consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly overhead photos.'
                                        : 'At NW4, your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at the crown vertex — keep your supplement routine consistent and massage the crown daily. Add minoxidil (1ml) directly to the vertex twice daily immediately after each scalp massage to prime vertex follicle absorption at this established stage. Consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly overhead photos.')
                                    : _hasSupplements && _hasDHTShampoo
                                      ? 'Your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression at the NW4 crown vertex — leave DHT shampoo on 3-5 minutes per wash. Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC crown combination at this established stage. Pair each application with a 4-minute scalp massage and consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly overhead photos.'
                                      : _hasDHTShampoo
                                        ? 'Your DHT-blocking shampoo provides topical DHT suppression at the NW4 crown vertex — leave it on 3-5 minutes per wash. Add minoxidil (1ml) directly to the crown twice daily as the topical growth signal; DHT shampoo + minoxidil covers local DHT suppression and active follicle stimulation from two complementary angles at this established stage. Pair each application with a 4-minute scalp massage and consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly overhead photos.'
                                        : _hasSupplements
                                          ? 'Your supplement stack supports crown follicle health at NW4 — add minoxidil (1ml) directly to the vertex twice daily and a DHT-blocking shampoo 3× weekly (3-5 min contact time). Nutritional support + topical growth signal + local DHT suppression is the three-layer OTC crown protocol at this established stage; pair each minoxidil application with a 4-minute scalp massage and take an overhead photo today as your baseline.'
                                          : 'NW4 crown thinning responds best to minoxidil applied directly to the vertex twice daily, paired with a 4-minute scalp massage. Together these are the highest-ROI OTC combination at this stage — start this week and take an overhead photo today as your baseline.'
                : data.stage === 'NW3v'
                // NW3v = early crown thinning just started — this is the highest-ROI intervention window
                ? (_hasFinasteride && _hasDHTShampoo && _hasMinoxidil && _hasMassage)
                    ? (_hasLLLT
                        ? 'NW3v crown thinning has just started and your finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical protocol — apply 1ml to the vertex immediately after your LLLT session while scalp circulation is elevated, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time daily. NW3v is the highest-ROI crown intervention window; this complete five-layer stack gives the strongest long-term response. Track with monthly overhead photos.'
                        : _hasMicroneedling
                        ? 'NW3v crown thinning has just started and your finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical protocol — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml directly to the vertex twice daily as normal; leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time daily. NW3v is the highest-ROI crown intervention window; this complete five-layer stack gives the strongest long-term response. Track with monthly overhead photos.'
                        : 'NW3v crown thinning has just started and your finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical protocol — apply 1ml to the vertex immediately after your scalp massage, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time daily. NW3v is the highest-ROI crown intervention window; this complete four-layer stack gives the strongest long-term response. Track with monthly overhead photos.')
                    : (_hasFinasteride && _hasDHTShampoo && _hasMinoxidil)
                      ? 'NW3v early crown thinning with finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control at the vertex — apply 1ml minoxidil directly to the crown twice daily and leave DHT shampoo on 3-5 minutes on wash days. Add a 3-minute scalp massage before each topical application to complete the stack and prime vertex follicle absorption at the highest-ROI crown intervention window.'
                      : (_hasFinasteride && _hasMinoxidil && _hasMassage)
                        ? (_hasLLLT
                            ? 'NW3v crown thinning has just started and your finasteride + minoxidil + LLLT protocol is fully deployed for the crown — apply 1ml to the vertex immediately after your LLLT session while scalp circulation is elevated. Take finasteride at the same time daily. NW3v is the highest-ROI crown intervention window; this complete stack produces the strongest long-term response.'
                            : _hasMicroneedling
                            ? 'NW3v crown thinning has just started and your finasteride + minoxidil + microneedling protocol is fully deployed for the crown — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml directly to the vertex twice daily as normal. Take finasteride at the same time daily. NW3v is the highest-ROI crown intervention window; this complete stack produces the strongest long-term response.'
                            : 'NW3v crown thinning has just started and your finasteride + minoxidil + massage stack is fully deployed — apply 1ml to the vertex immediately after your scalp massage so freshly primed follicles absorb it. Take finasteride at the same time daily. NW3v is the highest-ROI crown intervention window; this complete stack now produces the strongest long-term response.')
                        : (_hasFinasteride && _hasMinoxidil)
                          ? 'NW3v early crown thinning with finasteride + minoxidil is the strongest available intervention at this window — apply 1ml minoxidil directly to the vertex twice daily and add a 3-minute scalp massage before each application to maximize vertex absorption. Catching crown thinning at NW3v gives the best long-term response.'
                          : _hasFinasteride && _hasDHTShampoo
                            ? 'NW3v early crown thinning with finasteride + DHT-blocking shampoo delivers dual-level DHT suppression at the vertex — systemic through finasteride and topical through the shampoo (3-5 min contact time 3× weekly). Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo at NW3v is the strongest non-surgical crown combination at this highest-ROI intervention window. Track with monthly overhead photos.'
                          : _hasFinasteride
                            ? 'NW3v means early crown thinning has just started — your finasteride is suppressing DHT systemically. Add minoxidil (1ml) directly to the vertex twice daily to target the crown zone directly. NW3v is the highest-ROI crown intervention window; finasteride + minoxidil here produces the strongest documented response before the vertex advances further.'
                            : (_hasMinoxidil && _hasDHTShampoo && _hasMassage)
                              ? 'NW3v crown thinning has just started — your minoxidil, DHT shampoo, and scalp massage cover topical growth signal, local DHT suppression, and mechanical stimulation at the vertex. Apply 1ml minoxidil to the crown immediately after your massage and leave DHT shampoo on 3-5 minutes on wash days; catching crown thinning at NW3v gives the strongest OTC response window. A doctor consult about finasteride adds systemic DHT suppression for the most complete protocol.'
                              : (_hasMinoxidil && _hasMassage)
                                ? (_hasLLLT
                                    ? 'NW3v means your crown thinning just started — this is the highest-ROI window. Apply 1ml directly to the vertex immediately after your LLLT session while scalp circulation is elevated so freshly primed follicles absorb it; track with overhead photos every 3 weeks.'
                                    : _hasMicroneedling
                                    ? 'NW3v means your crown thinning just started — this is the highest-ROI window. Wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml directly to the vertex twice daily as normal; microneedling primes follicle absorption at the crown where it matters most. Track with overhead photos every 3 weeks.'
                                    : 'NW3v means your crown thinning just started — this is the highest-ROI window. Apply 1ml directly to the vertex immediately after your scalp massage so freshly stimulated follicles absorb it; track with overhead photos every 3 weeks.')
                                : (_hasSupplements && _hasMinoxidil && _hasDHTShampoo)
                                  ? 'NW3v early crown thinning has just started — your supplement stack, minoxidil, and DHT-blocking shampoo deliver the strongest OTC three-layer crown protocol at this highest-ROI intervention window: nutritional follicle support, topical growth signal, and local DHT suppression all active. Apply 1ml minoxidil directly to the vertex twice daily, leave DHT shampoo on 3-5 minutes per wash, and keep your supplement routine consistent. Add a 3-minute scalp massage before each minoxidil application to prime vertex absorption, and consider a doctor consult about finasteride for systemic DHT suppression to complete the protocol. Track with monthly overhead photos.'
                                : (_hasMinoxidil && _hasDHTShampoo)
                                  ? 'NW3v crown thinning is at the earliest detectable stage — your minoxidil and DHT shampoo cover topical growth signal and local DHT control at the vertex. Leave DHT shampoo on 3-5 minutes per wash and add a 3-minute scalp massage before each minoxidil application to prime vertex absorption. A doctor consult about finasteride adds systemic DHT suppression for the most complete early-crown response.'
                                  : _hasSupplements && _hasMinoxidil
                                    ? 'NW3v early crown thinning has just started — your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at the vertex. Apply 1ml minoxidil directly to the vertex twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer crown approach at this highest-ROI early-crown intervention window. Track with monthly overhead photos.'
                                  : _hasMinoxidil
                                    ? 'NW3v crown thinning is at the earliest detectable stage — apply 1ml minoxidil directly to the vertex twice daily and add a 3-minute post-application scalp massage now. Catching it here gives the strongest response.'
                                    : _hasSupplements && _hasMassage
                                    ? (_hasLLLT
                                        ? 'NW3v early crown thinning has just started — your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation at the vertex. Keep your supplement routine consistent and your LLLT sessions on schedule; apply any topicals immediately after your LLLT session while scalp circulation is elevated. Add minoxidil (1ml) directly to the vertex twice daily — NW3v is the highest-ROI crown intervention window to catch vertex thinning before it advances. Track with monthly overhead photos.'
                                        : _hasMicroneedling
                                        ? 'NW3v early crown thinning has just started — your supplement stack and microneedling cover nutritional follicle support and scalp priming at the vertex. Wait 24-48 hours after each microneedling session before applying topicals to the vertex (applying immediately after needling risks follicle irritation); add minoxidil (1ml) directly to the vertex twice daily on non-needling days. NW3v is the highest-ROI crown intervention window; supplement + microneedling primes vertex follicles for maximum response at this earliest-detectable stage. Track with monthly overhead photos.'
                                        : 'NW3v early crown thinning has just started — your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at the vertex. Keep your supplement routine consistent and massage the crown daily; add minoxidil (1ml) directly to the vertex twice daily immediately after each scalp massage to prime vertex follicle absorption. NW3v is the highest-ROI crown intervention window — acting now gives the strongest long-term response. Track with monthly overhead photos.')
                                    : _hasSupplements && _hasDHTShampoo
                                      ? 'Your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression at the vertex where NW3v crown thinning has just started — keep DHT shampoo on 3-5 minutes per wash 3× weekly and your supplement stack consistent. Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil gives the strongest OTC three-layer crown response at this highest-ROI early-crown intervention window. Take monthly overhead photos to track the vertex.'
                                      : _hasDHTShampoo
                                        ? 'NW3v early crown thinning — your DHT-blocking shampoo provides topical DHT suppression at the vertex. Keep it on 3-5 minutes per wash 3× weekly. Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; DHT shampoo + minoxidil targets early crown thinning from two angles and NW3v is the highest-ROI window to act before the vertex advances. Take monthly overhead photos to track response.'
                                        : _hasSupplements
                                          ? 'Your supplement stack is supporting crown follicle health at NW3v where vertex thinning has just started — biotin, zinc, and vitamin D are a strong nutritional foundation. Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; combining nutritional support with a consistent topical approach gives the strongest OTC response at this early-crown window. Take monthly overhead photos to track the vertex.'
                                          : 'NW3v means your crown thinning has just started — the highest-ROI move is acting now: apply minoxidil directly to the vertex daily, add scalp massage, and take an overhead photo as your baseline today.'
                : data.stage === 'NW1'
                // NW1: crown is fully healthy — no targeted treatment needed; preventive messaging only
                ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                    ? 'Your crown is fully healthy at NW1 with finasteride + minoxidil + DHT-blocking shampoo active — the most complete preventive combination available. Finasteride and DHT shampoo are the primary crown protection layers; minoxidil supports general scalp health. Take monthly overhead photos from the same position; catching any early vertex thinning at the NW1→NW3v transition is the highest-ROI crown intervention window.'
                    : _hasFinasteride && _hasMinoxidil
                      ? 'Your crown is fully healthy at NW1 with finasteride + minoxidil active — finasteride is the primary crown protection layer through systemic DHT suppression. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical-level complement; together they form the most complete dual-level DHT prevention stack. Take monthly overhead photos to catch any early vertex thinning the moment it appears.'
                      : _hasFinasteride && _hasSupplements && _hasDHTShampoo
                        ? 'Your crown is fully protected at NW1 with finasteride + supplements + DHT-blocking shampoo — systemic DHT suppression, nutritional support, and topical DHT control are all active. No targeted crown treatment needed at this stage; take monthly overhead photos so any early vertex change is caught the moment it begins.'
                        : _hasFinasteride && _hasSupplements
                          ? 'Finasteride + supplement stack is a strong NW1 crown prevention foundation — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT complement to your systemic finasteride. Together they form the most complete dual-level crown prevention stack at NW1; take monthly overhead photos to catch any early vertex thinning.'
                          : _hasFinasteride && _hasDHTShampoo
                            ? 'Your crown is fully healthy at NW1 and finasteride + DHT-blocking shampoo covers both systemic and topical DHT suppression — no targeted crown treatment needed. Take monthly overhead photos so any early vertex change is caught the moment it begins, which is the highest-ROI intervention window.'
                            : _hasFinasteride
                              ? 'Finasteride is providing systemic DHT protection at NW1 where your crown is fully healthy — no targeted treatment needed. Add a DHT-blocking shampoo 3× weekly as the topical-level complement and take monthly overhead photos to catch any early vertex thinning the moment it appears.'
                              : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                ? 'Your crown is fully healthy at NW1 with supplements, minoxidil, and DHT-blocking shampoo providing nutritional follicle support, topical scalp health, and local DHT control — a comprehensive OTC preventive stack. The DHT shampoo is the primary crown protection layer at this intact stage (3× weekly, 3-5 min contact time); minoxidil supports general scalp health and your supplement routine provides the nutritional foundation. No targeted crown treatment is needed at NW1; take monthly overhead photos from the same position so any early vertex thinning is caught the moment it begins — the NW1→NW3v transition is the highest-ROI crown intervention window.'
                              : _hasMinoxidil && _hasDHTShampoo
                                ? 'Your crown is fully healthy at NW1 with minoxidil + DHT-blocking shampoo active — the DHT shampoo is the primary crown protection layer (3× weekly, 3-5 min contact time). Take monthly overhead photos from the same position; catching any early vertex thinning at the NW1→NW3v transition is the highest-ROI crown intervention window. A doctor consult about finasteride adds systemic DHT suppression for the most complete dual-level prevention stack.'
                                : _hasSupplements && _hasMinoxidil
                                  ? 'Your crown is fully intact at NW1 with supplements and minoxidil active — your supplement stack provides nutritional follicle support and minoxidil maintains general scalp health before any vertex thinning begins. The primary crown prevention layer is DHT suppression: add a DHT-blocking shampoo 3× weekly (3-5 min contact time) to complete the preventive stack. Take monthly overhead photos so any early vertex change is caught the moment it begins — the NW1→NW3v transition is the highest-ROI crown intervention window.'
                                : _hasMinoxidil
                                  ? 'Your crown is intact at NW1 — minoxidil supports general scalp health but the primary prevention layer for crown protection is DHT suppression. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical-level DHT control layer alongside your existing routine. Take monthly overhead photos to catch any early vertex change the moment it begins.'
                                  : _hasSupplements && _hasMassage
                                  ? (_hasLLLT
                                      ? 'Your crown is fully intact at NW1 with your supplement stack and LLLT device providing nutritional follicle support and photobiomodulation — no targeted crown treatment needed at this stage. Keep your supplement routine consistent and your LLLT sessions on schedule as preventive maintenance. Take monthly overhead photos so any early vertex change is caught at the highest-ROI intervention window; the NW1→NW3v transition is when targeted crown coverage has the most impact.'
                                      : _hasMicroneedling
                                      ? 'Your crown is fully intact at NW1 with your supplement stack and microneedling providing nutritional follicle support and scalp priming — no targeted crown treatment needed at this stage. Keep your supplement routine consistent and use microneedling as preventive scalp maintenance. Take monthly overhead photos so any early vertex change is caught at the highest-ROI intervention window; the NW1→NW3v transition is when adding targeted crown topicals has the most impact.'
                                      : 'Your crown is fully intact at NW1 with your supplement stack and scalp massage providing nutritional follicle support and mechanical stimulation — no targeted crown treatment needed at this stage. Keep your supplement routine consistent and massage the scalp daily as preventive maintenance. Take monthly overhead photos so any early vertex change is caught at the highest-ROI intervention window; the NW1→NW3v transition is when adding targeted crown coverage has the most impact.')
                                  : _hasSupplements && _hasDHTShampoo
                                    ? 'Your crown is fully healthy at NW1 with supplements and DHT-blocking shampoo providing nutritional support and topical DHT control — a solid preventive foundation. Take monthly overhead photos so any early vertex change is caught at the highest-ROI intervention window; if vertex thinning ever appears, that marks the NW3v transition and is the ideal time to act.'
                                    : _hasSupplements
                                      ? 'Your supplement stack supports crown follicle health at NW1 where your vertex is fully intact — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT prevention layer. Together they form a dual-layer non-Rx preventive foundation; take monthly overhead photos to catch any early vertex change before it progresses.'
                                      : _hasDHTShampoo
                                        ? 'Your crown is fully healthy at NW1. No targeted crown treatment needed yet — your DHT-blocking shampoo already provides preventive coverage. Take monthly overhead photos so any early vertex change is caught at the highest-ROI intervention window.'
                                        : 'Your crown is healthy at NW1. No crown treatment needed yet — add a DHT-blocking shampoo 3× weekly as a general prevention layer and take monthly overhead photos to catch any early vertex change before it requires aggressive treatment.')
                : data.stage === 'NW2'
                // NW2: crown is intact, temples are the active priority — redirect focus there
                ? (_hasFinasteride && _hasDHTShampoo
                    ? 'Finasteride + DHT-blocking shampoo gives you dual-level DHT protection at NW2 — systemic and topical control keeps the crown well-guarded. The temple recession is the active priority; keep your dual-layer DHT protocol consistent and take monthly overhead photos to catch any early vertex thinning the moment it appears. If vertex thinning develops, that marks NW3v — the highest-ROI crown intervention window.'
                    : _hasFinasteride && _hasMinoxidil
                    ? 'Your crown is intact at NW2 with finasteride + minoxidil providing systemic DHT suppression and topical growth signal — the temple recession is the active priority right now. Keep both consistent and take monthly overhead photos to catch any early vertex thinning; if it develops, that marks NW3v — the highest-ROI crown intervention window to redirect minoxidil (1ml) directly to the vertex.'
                    : _hasFinasteride
                    ? 'Finasteride at NW2 is already protecting the crown through systemic DHT suppression — the temple recession is the active priority. Keep taking finasteride consistently and track the crown monthly with overhead photos; if vertex thinning appears, that marks NW3v — the highest-ROI window to add direct crown coverage.'
                    : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                    ? 'Your crown is intact at NW2 with your supplement stack, minoxidil, and DHT-blocking shampoo providing nutritional follicle support, topical growth signal, and local DHT suppression — the complete OTC three-layer preventive foundation. The temple recession is the active priority; keep minoxidil on both temple corners twice daily, leave DHT shampoo on 3-5 minutes per wash, and maintain your supplement routine consistently. Take monthly overhead photos to catch any early vertex thinning; at the NW2→NW3v transition, redirect 1ml of minoxidil directly to the vertex alongside your existing OTC protocol for the strongest early-crown response.'
                    : _hasMinoxidil && _hasDHTShampoo
                    ? 'Your crown is intact at NW2 — your minoxidil and DHT-blocking shampoo provide topical growth signal and local DHT suppression across the scalp top. The temple recession is the active priority; keep both focused on both temple corners and take monthly overhead photos to catch any early vertex thinning. At the NW2→NW3v transition, redirect 1ml of minoxidil directly to the vertex for the strongest early-crown response.'
                    : _hasSupplements && _hasMinoxidil
                    ? 'Your crown is intact at NW2 with your supplement stack and minoxidil active — nutritional follicle support and the topical growth signal are keeping the crown well-guarded. The temple recession is the active priority; keep minoxidil on both temple corners twice daily and your supplement routine consistent. Take monthly overhead photos to catch any early vertex thinning; at the NW2→NW3v transition, redirect 1ml directly to the vertex alongside your supplement routine for the strongest early-crown response.'
                    : _hasMinoxidil
                    ? 'Your crown is intact at NW2 — the temple recession is the active priority right now. Keep your topical focused on both temple corners and take monthly overhead photos to catch any early vertex thinning as soon as it appears.'
                    : _hasSupplements && _hasMassage
                    ? (_hasLLLT
                        ? 'Your crown is intact at NW2 — your supplement stack and LLLT device provide nutritional follicle support and photobiomodulation across the scalp top. The temple recession is the active priority; keep your supplement routine consistent and your LLLT sessions on schedule. Take monthly overhead photos to catch any early vertex thinning; at the NW2→NW3v transition, adding minoxidil (1ml) directed at the vertex alongside your current protocol gives the strongest early-crown response.'
                        : _hasMicroneedling
                        ? 'Your crown is intact at NW2 — your supplement stack and microneedling provide nutritional follicle support and scalp priming across the scalp top. The temple recession is the active priority; keep your supplement routine consistent and continue microneedling as part of your scalp maintenance. Take monthly overhead photos to catch any early vertex thinning; at the NW2→NW3v transition, adding minoxidil (1ml) directed at the vertex alongside your microneedling protocol gives the strongest early-crown response.'
                        : 'Your crown is intact at NW2 — your supplement stack and scalp massage provide nutritional follicle support and mechanical stimulation across the scalp top. The temple recession is the active priority; keep your supplement routine consistent and massage the scalp daily. Take monthly overhead photos to catch any early vertex thinning; at the NW2→NW3v transition, that is the ideal time to add minoxidil (1ml) directly to the vertex for the strongest early-crown response.')
                    : _hasSupplements && _hasDHTShampoo
                    ? 'Your crown is intact at NW2 — your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression across the scalp top. The temple recession is the active priority; leave DHT shampoo on 3-5 minutes per wash and take monthly overhead photos to catch any early vertex thinning. If vertex thinning develops, that marks NW3v — the highest-ROI crown intervention window.'
                    : _hasDHTShampoo
                    ? 'Your crown is fully intact at NW2 — your DHT-blocking shampoo is providing topical-level DHT protection at the crown. The temple recession is the active priority; focus treatment on both temple corners and keep monthly overhead photos to catch any early vertex thinning the moment it appears.'
                    : _hasSupplements
                    ? 'Your supplement stack is supporting crown follicle health at NW2 where your vertex is fully intact — the temple recession is the active priority. Take monthly overhead photos so any early vertex change is caught at the highest-ROI intervention window; if vertex thinning appears, that marks NW3v and the ideal time to add crown-targeted minoxidil (1ml to the vertex) directly.'
                    : 'Your crown is currently intact at NW2 — temples are the active zone. Focus treatment there first and track the crown monthly with overhead photos to catch any early vertex thinning before it needs aggressive intervention.')
                : data.stage === 'NW3'
                // NW3: crown is intact — vertex thinning only starts at NW3v; redirect focus to temples and set up early-detection tracking
                ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                    ? 'Your crown is intact at NW3 — finasteride + minoxidil + DHT-blocking shampoo gives you systemic DHT suppression, topical growth signal, and topical DHT control across the full scalp top. The deep temple recession is the active priority; keep your three-layer protocol focused on both recession zones and take monthly overhead photos to catch any early vertex thinning. At the NW3→NW3v transition, redirect 1ml of minoxidil directly to the vertex for the strongest early-crown response.'
                    : _hasFinasteride && _hasMinoxidil
                    ? 'Your crown is still intact at NW3 — the deep temple recession is the active priority. Your finasteride + minoxidil stack targets the recession zones directly; keep both consistent and take monthly overhead photos so any early vertex thinning is caught the moment it appears. That transition to NW3v is the highest-ROI crown intervention window.'
                    : _hasFinasteride && _hasDHTShampoo
                      ? 'Your crown is intact at NW3 — finasteride + DHT-blocking shampoo gives you dual-level DHT protection across the entire scalp top. The deep temple recession is the active priority; keep your dual-layer protocol consistent and take monthly overhead photos to catch any early vertex thinning. The NW3→NW3v transition is the ideal time to add crown-targeted minoxidil (1ml to the vertex) for the strongest early-crown response.'
                      : _hasFinasteride
                      ? 'Your crown is intact at NW3 — temple recession is the current focus and your finasteride is already blocking systemic DHT. Take monthly overhead photos to catch any early vertex thinning; the NW3→NW3v transition is the ideal time to add minoxidil directly to the vertex for the strongest early-crown response.'
                      : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                        ? 'Your crown is intact at NW3 with your supplement stack, minoxidil, and DHT-blocking shampoo providing nutritional follicle support, topical growth signal, and local DHT control across the full scalp top — the complete OTC three-layer stack. The deep temple recession is the active priority at this established AGA stage; apply minoxidil to both temple recession zones twice daily, leave DHT shampoo on 3-5 minutes per wash, and keep your supplement routine consistent. Take monthly overhead photos to catch any early vertex thinning; at the NW3→NW3v transition, redirect 1ml of minoxidil directly to the vertex alongside your existing three-layer protocol for the strongest early-crown response.'
                      : _hasMinoxidil && _hasDHTShampoo
                        ? 'Your crown is still intact at NW3 — your minoxidil and DHT-blocking shampoo provide topical growth signal and local DHT suppression across the scalp top. The deep temple recession is the active priority; keep both focused on both recession zones and take monthly overhead photos to catch any early vertex thinning. At the NW3→NW3v transition, redirect 1ml of minoxidil directly to the vertex for the strongest early-crown response.'
                        : _hasSupplements && _hasMinoxidil
                        ? 'Your crown is intact at NW3 with your supplement stack and minoxidil active — nutritional follicle support and the topical growth signal are focused on both temple recession zones where the active loss is progressing. The deep temple recession is the current priority; keep minoxidil on both recession zones twice daily and your supplement routine consistent. Take monthly overhead photos to catch any early vertex thinning; at the NW3→NW3v transition, redirect 1ml directly to the vertex alongside your supplement routine for the strongest early-crown response.'
                        : _hasMinoxidil
                        ? 'Your crown is still intact at NW3 — focus your minoxidil on both temple recession zones now. Take a monthly overhead photo to catch any early vertex thinning; if it appears, that marks NW3v — the highest-ROI window to act on crown thinning before it advances.'
                        : _hasSupplements && _hasMassage
                        ? (_hasLLLT
                            ? 'Your crown is intact at NW3 — your supplement stack and LLLT device provide nutritional follicle support and photobiomodulation across the scalp top. The deep temple recession is the active priority; keep your supplement routine consistent and your LLLT sessions on schedule. Take monthly overhead photos to catch any early vertex thinning; at the NW3→NW3v transition, adding topicals directly to the vertex alongside your LLLT protocol gives the strongest early-crown response.'
                            : _hasMicroneedling
                            ? 'Your crown is intact at NW3 — your supplement stack and microneedling provide nutritional follicle support and scalp priming across the scalp top. The deep temple recession is the active priority; keep your supplement routine consistent and continue microneedling as part of your maintenance. Take monthly overhead photos to catch any early vertex thinning; at the NW3→NW3v transition, adding minoxidil (1ml) directly to the vertex alongside your microneedling gives the strongest early-crown response.'
                            : 'Your crown is intact at NW3 — your supplement stack and scalp massage provide nutritional follicle support and mechanical stimulation across the scalp top. The deep temple recession is the active priority; keep your supplement routine consistent and massage the scalp daily. Take monthly overhead photos to catch any early vertex thinning; at the NW3→NW3v transition, that is the highest-ROI window to add minoxidil (1ml) directly to the vertex for the strongest early-crown response.')
                        : _hasSupplements && _hasDHTShampoo
                        ? 'Your crown is intact at NW3 — your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression across the full scalp top. The deep temple recession is the active priority; keep DHT shampoo on 3-5 minutes per wash and take monthly overhead photos to catch any early vertex thinning. At the NW3→NW3v transition, adding minoxidil (1ml) directed at the vertex gives the strongest early-crown response.'
                        : _hasDHTShampoo
                        ? 'Your crown is still intact at NW3 — your DHT-blocking shampoo is providing topical DHT suppression across the scalp top. The deep temple recession is the active priority; keep your treatment focused on both recession zones and take monthly overhead photos to catch any early vertex thinning; acting at the NW3v window gives the strongest possible crown response.'
                        : _hasSupplements
                        ? 'Your crown is intact at NW3 — your supplement stack is supporting follicle nutrition across the scalp top. The deep temple recession is the active priority right now; take monthly overhead photos to catch any early vertex thinning. If vertex thinning appears, that marks NW3v — the highest-ROI window to act on crown thinning before it progresses further.'
                        : 'Your crown is intact at NW3 — the temple recession is where to direct treatment first. Take a monthly overhead photo as your crown baseline so any early vertex thinning is caught the moment it begins; acting at that NW3v window gives the strongest possible crown response.')
                : (data.stage === 'diffuse' || data.stage === 'n/a (female)')
                  ? (_hasFinasteride && _hasMinoxidil && _hasMassage
                      ? (data.stage === 'n/a (female)'
                          ? "Female-pattern crown thinning with finasteride + minoxidil + massage covers DHT suppression, topical growth signal, and mechanical stimulation — confirm minoxidil covers the full central parting evenly and apply it right after your scalp massage. Monthly central-part photos track crown response alongside the hormonal support your finasteride provides."
                          : 'Diffuse crown thinning with finasteride + minoxidil + massage covers the key layers — apply minoxidil across the full scalp top right after your massage, and take finasteride at the same time each day. Take monthly overhead photos to track the full-scalp density baseline.')
                      : _hasFinasteride && _hasMinoxidil
                        ? (data.stage === 'n/a (female)'
                            ? "Female-pattern crown thinning with finasteride + minoxidil provides DHT suppression and topical growth coverage — apply minoxidil across the full crown top twice daily and add a 4-minute scalp massage before each application. Monthly central-part photos track crown response; a ferritin, thyroid, and hormone panel can identify a reversible cause that amplifies the pattern."
                            : 'Diffuse crown thinning with finasteride + minoxidil covers systemic DHT suppression and topical growth signal — apply minoxidil across the full scalp top (not just the vertex) twice daily and add a 4-minute scalp massage before each application. Take monthly overhead photos to track the full-crown density baseline.')
                        : _hasFinasteride
                          ? (data.stage === 'n/a (female)'
                              ? "Finasteride in your female-pattern routine provides DHT suppression for crown thinning — add minoxidil applied across the full crown top twice daily and a 4-minute scalp massage before each application. Monthly central-part photos track crown response; a ferritin, thyroid, and hormone panel is still the highest-ROI investigation for reversible causes in women."
                              : 'Finasteride provides systemic DHT suppression for diffuse crown thinning — add minoxidil across the full scalp top twice daily (not just the vertex) and pair it with a 4-minute scalp massage before each application. Take monthly overhead photos to track the full-crown baseline alongside your finasteride coverage.')
                          : _hasMinoxidil && _hasMassage
                            ? (data.stage === 'n/a (female)'
                                ? "Female-pattern crown thinning is along the central parting and scalp top — confirm your minoxidil covers the full central parting evenly, not just the hairline edge. Your massage is active: apply it across the central part and top before minoxidil for best absorption. Monthly part-line photos track response."
                                : 'Diffuse thinning reaches the crown uniformly — your minoxidil and massage are both active. Confirm you apply minoxidil across the full scalp top (not just the vertex), and do the massage across the entire top twice daily. Take monthly overhead photos to track the full-scalp density baseline.')
                            : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                              ? (data.stage === 'n/a (female)'
                                  ? "Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for female-pattern crown thinning — apply minoxidil across the full crown top (not just the front hairline) twice daily, leave DHT shampoo on 3-5 minutes on wash days, and keep your supplement routine consistent. Add a 4-minute scalp massage before each minoxidil application to improve absorption along the central parting; a ferritin, thyroid, and hormone panel remains the highest-ROI investigation for a reversible underlying cause in women."
                                  : 'Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for diffuse crown thinning — apply minoxidil across the full scalp top (not just the vertex) twice daily, leave DHT shampoo on 3-5 minutes on wash days, and keep your supplement routine consistent. Pair each application with a 4-minute full-scalp massage to drive even absorption; track with monthly overhead photos and consult a doctor about finasteride to add the systemic DHT layer.')
                            : _hasMinoxidil && _hasDHTShampoo
                              ? (data.stage === 'n/a (female)'
                                  ? "Female-pattern crown thinning with minoxidil + DHT-blocking shampoo covers topical growth signal and local DHT suppression — apply minoxidil across the full crown top (not just the front hairline) twice daily and leave DHT shampoo on 3-5 minutes on wash days. Add a 4-minute scalp massage before each application to improve absorption along the parting line. A ferritin, thyroid, and hormone panel remains the highest-ROI investigation for a reversible underlying cause."
                                  : 'Diffuse crown thinning with minoxidil + DHT-blocking shampoo covers topical growth signal and local DHT control — apply minoxidil across the full scalp top (not just the vertex) twice daily and leave DHT shampoo on 3-5 minutes on wash days. Add a 4-minute full-scalp massage before each minoxidil application to complete the OTC stack; a doctor consult about finasteride adds the systemic DHT layer. Track with monthly overhead photos.')
                            : _hasSupplements && _hasMinoxidil
                              ? (data.stage === 'n/a (female)'
                                  ? "Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for female-pattern crown thinning — apply minoxidil across the full crown top (not just the front hairline) twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach for female-pattern crown coverage. A ferritin, thyroid, and hormone panel remains the highest-ROI investigation for a reversible underlying cause in women."
                                  : 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for diffuse crown thinning — apply minoxidil across the full scalp top (not just the vertex) twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach for diffuse crown density. Pair each application with a 4-minute full-scalp massage to drive even absorption and track with monthly overhead photos.')
                            : _hasMinoxidil
                              ? (data.stage === 'n/a (female)'
                                  ? "Female-pattern crown thinning focuses on the central parting and scalp top — apply minoxidil across the full crown top (not just the front hairline) twice daily. Add a 4-minute scalp massage before each application to improve absorption along the parting line where thinning is most visible."
                                  : 'Diffuse crown thinning responds best to uniform minoxidil coverage across the full scalp top (not just the vertex) twice daily. Add a 4-minute full-scalp massage before each application to drive even absorption. Track with monthly overhead photos.')
                            : _hasDHTShampoo
                              ? (data.stage === 'n/a (female)'
                                  ? "DHT-blocking shampoo is in your female-pattern routine — add minoxidil applied across the full crown top twice daily for the topical growth signal, and apply it after the shampoo on wash days. A ferritin, thyroid, and hormone panel is the highest-ROI next step since female-pattern thinning often has a reversible hormonal driver alongside any DHT sensitivity."
                                  : 'Your DHT-blocking shampoo provides topical DHT control for diffuse crown thinning — add minoxidil applied across the full scalp top twice daily and apply it after letting the shampoo lift DHT buildup. A 4-minute scalp massage before each application completes the OTC stack; monthly overhead photos capture how the full crown responds since diffuse improvement is gradual.')
                              : _hasSupplements && _hasMassage
                              ? (data.stage === 'n/a (female)'
                                  ? "Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation for female-pattern crown thinning along the central parting and scalp top — keep your supplement routine consistent and apply a 4-minute scalp massage covering the central part and crown top daily. Add minoxidil applied across the full crown top twice daily immediately after each massage so freshly primed follicles absorb it; supplements + massage + minoxidil addresses female-pattern crown coverage from nutritional, mechanical, and topical angles. Take monthly central-part photos as your baseline; a ferritin, thyroid, and hormone panel is still the highest-ROI investigation for a reversible underlying cause in women."
                                  : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation for diffuse crown thinning — keep your supplement routine consistent and apply a 4-minute full-scalp massage daily covering the entire crown top. Add minoxidil applied across the full scalp top twice daily immediately after each massage so freshly primed follicles absorb it; supplements + massage + minoxidil addresses diffuse crown thinning from nutritional, mechanical, and topical angles. Take monthly overhead photos to track the full-scalp density baseline; a ferritin, thyroid, and vitamin D workup can rule out a reversible nutritional cause that topicals alone won\'t fix.')
                              : _hasSupplements
                              ? (data.stage === 'n/a (female)'
                                  ? "Your supplement stack supports crown follicle health with female-pattern thinning — biotin, zinc, and vitamin D are a good nutritional foundation for the central parting and scalp top. Add minoxidil applied across the full crown area twice daily as the topical growth signal; consistent coverage along the parting line is the most impactful OTC addition to your supplement routine. Take monthly central-part photos as your baseline."
                                  : 'Your supplement stack is a good nutritional foundation for diffuse crown thinning — add minoxidil applied across the full scalp top (not just the vertex) twice daily as the topical growth signal and pair it with a 4-minute full-scalp massage before each application. Your supplement routine and this OTC stack cover nutritional support, growth signal, and mechanical stimulation; monthly overhead photos track the baseline since diffuse crown improvement happens gradually.')
                              : (data.stage === 'n/a (female)'
                                  ? "Female-pattern crown thinning is centered along the central parting and scalp top — start minoxidil applied across the full crown area twice daily. Take monthly central-part photos as your baseline; consistent coverage along the parting line is the single most impactful OTC step for female-pattern crown thinning."
                                  : 'Diffuse thinning affects the full crown uniformly — start minoxidil across the entire scalp top (not just the vertex) twice daily and pair it with a full-scalp massage. Monthly overhead photos track the baseline since diffuse crown improvement happens gradually.'))
                  : (_hasMassage && _hasMinoxidil)
                      ? 'Massage and topical are both in your routine — optimize by applying minoxidil to the vertex directly after massaging so freshly stimulated follicles absorb more. Track with monthly overhead photos.'
                      : _hasMassage
                        ? 'Your massage habit is on — now add crown-targeted topical (minoxidil at vertex, 1ml) and take a weekly overhead photo to track baseline density.'
                        : 'Begin a crown-focused topical routine and take an overhead comparison photo now to track your baseline.',
          Health: _isNW7
            ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                ? 'At NW7, your finasteride + minoxidil + DHT-blocking shampoo provides the most complete non-surgical fringe follicle health protocol — systemic DHT suppression through finasteride, topical growth signal through minoxidil, and local DHT control through the shampoo. Keep all three consistent without gaps. The highest-ROI next step is booking a trichologist or transplant consultation this week to evaluate how your triple-layer protocol integrates with surgical coverage options (FUE/FUT or SMP).'
                : _hasFinasteride && _hasDHTShampoo
                ? 'At NW7, your finasteride + DHT-blocking shampoo provides systemic and topical DHT suppression for remaining fringe follicle health — keep both consistent without gaps. The highest-ROI next step is booking a trichologist or transplant consultation this week to evaluate how your dual-layer DHT protocol integrates with surgical coverage options (FUE/FUT or SMP).'
                : _hasFinasteride && _hasMinoxidil
                ? 'At NW7, your finasteride + minoxidil is protecting remaining fringe follicles through systemic DHT suppression and topical stimulation — keep both consistent without gaps. The highest-ROI next step is booking a trichologist or transplant consultation this week to evaluate how your dual-layer protocol integrates with surgical coverage options (FUE/FUT or SMP).'
                : _hasFinasteride
                ? 'At NW7, your finasteride is protecting remaining fringe follicles from further miniaturization — the most important next step is keeping it consistent without gaps. For scalp health, continue any active OTC routine and book a trichologist or transplant consultation this week to evaluate how your systemic treatment strategy integrates with surgical coverage options.'
                : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                ? 'At NW7, your supplement stack, minoxidil, and DHT-blocking shampoo provide nutritional support, topical growth signal, and local DHT suppression for remaining fringe follicle health — apply minoxidil to the fringe and lateral edges twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement stack consistent. The highest-ROI next step is booking a trichologist or transplant consultation this week to evaluate how your three-layer OTC protocol integrates with surgical coverage options (FUE/FUT or SMP).'
                : _hasMinoxidil && _hasDHTShampoo
                ? 'Your minoxidil + DHT-blocking shampoo provides a topical growth signal and local DHT suppression for remaining fringe follicle health at NW7 — keep both consistent. Apply minoxidil to the fringe and lateral edges twice daily and leave DHT shampoo on 3-5 minutes per wash. The highest-ROI next step is booking a trichologist or transplant consultation this week to evaluate how your topical stack integrates with surgical coverage options (FUE/FUT or SMP).'
                : _hasMinoxidil && _hasMassage
                ? (_hasLLLT
                    ? 'At NW7, your minoxidil and LLLT device cover topical growth signal and photobiomodulation for remaining fringe follicle health — apply minoxidil immediately after your LLLT session while scalp circulation is elevated. The highest-ROI next step is booking a trichologist or transplant consultation this week to evaluate how your protocol integrates with surgical coverage options; minoxidil and LLLT are commonly continued post-transplant to protect native fringe hair.'
                    : _hasMicroneedling
                    ? 'At NW7, your minoxidil and microneedling cover topical growth signal and scalp priming for remaining fringe follicle health — wait 24-48 hours after each microneedling session before applying minoxidil along the fringe and lateral edges (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. The highest-ROI next step is booking a trichologist or transplant consultation this week to evaluate how your protocol integrates with surgical coverage options; minoxidil is commonly continued post-transplant to protect native fringe hair around new grafts.'
                    : 'At NW7, your minoxidil and scalp massage provide topical growth signal and mechanical stimulation for remaining fringe follicle health — apply minoxidil immediately after your massage while scalp circulation is elevated. The highest-ROI next step is booking a trichologist or transplant consultation this week to evaluate how your protocol integrates with surgical coverage options; minoxidil is commonly continued post-transplant to protect native fringe hair around new grafts.')
                : _hasSupplements && _hasDHTShampoo
                ? 'Your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression for remaining fringe follicles at NW7 — keep DHT shampoo on 3-5 minutes per wash 3× weekly and your supplement stack consistent. The highest-ROI next step is booking a trichologist or transplant consultation to evaluate donor supply, candidacy, and how your nutritional + topical DHT protocol integrates with surgical coverage options (FUE/FUT or SMP).'
                : _hasSupplements && _hasMassage
                ? (_hasLLLT
                    ? 'At NW7, your supplement stack and LLLT device cover nutritional support and photobiomodulation for remaining fringe follicles — apply any topicals immediately after your LLLT session while scalp circulation is elevated and keep your supplement stack consistent as the nutritional layer. The highest-ROI next step is booking a trichologist or transplant consultation to evaluate how your protocol integrates with surgical coverage options; LLLT is commonly continued post-transplant to support graft health and protect native fringe hair.'
                    : _hasMicroneedling
                    ? 'At NW7, your supplement stack and microneedling cover nutritional support and scalp priming for remaining fringe follicles — wait 24-48 hours after each microneedling session before applying topicals along the fringe and lateral edges (applying immediately after needling risks follicle irritation); on non-needling days apply as normal. Keep your supplement stack consistent as the nutritional layer. The highest-ROI next step is booking a trichologist or transplant consultation to evaluate how your protocol integrates with surgical coverage options (FUE/FUT or SMP).'
                    : 'At NW7, your supplement stack and scalp massage cover nutritional support and mechanical stimulation for remaining fringe follicles — apply any topicals immediately after your massage while scalp circulation is elevated and keep your supplement stack consistent as the nutritional layer. The highest-ROI next step is booking a trichologist or transplant consultation to evaluate how your protocol integrates with surgical coverage options (FUE/FUT or SMP).')
                : _hasDHTShampoo && _hasMassage
                ? (_hasLLLT
                    ? 'At NW7, your DHT-blocking shampoo and LLLT device cover topical DHT suppression and photobiomodulation for remaining fringe follicles — leave DHT shampoo on 3-5 minutes per wash and apply any topicals immediately after your LLLT session while scalp circulation is elevated. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer. The highest-ROI next step is booking a trichologist or transplant consultation to evaluate how your protocol integrates with surgical coverage options; LLLT is commonly continued post-transplant to support graft health and protect native fringe hair.'
                    : _hasMicroneedling
                    ? 'At NW7, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming for remaining fringe follicles — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer. The highest-ROI next step is booking a trichologist or transplant consultation to evaluate how your protocol integrates with surgical coverage options (FUE/FUT or SMP).'
                    : 'At NW7, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation for remaining fringe follicles — leave DHT shampoo on 3-5 minutes per wash and apply any topicals immediately after your massage while scalp circulation is elevated. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer. The highest-ROI next step is booking a trichologist or transplant consultation to evaluate how your protocol integrates with surgical coverage options (FUE/FUT or SMP).')
                : _hasDHTShampoo
                ? 'Your DHT-blocking shampoo supports fringe follicle health at NW7 — keep using it 3× weekly with 3-5 minutes of contact time. Scalp health maintenance protects remaining hair, but the highest-ROI step this week is booking a trichologist or transplant consultation to evaluate donor supply, candidacy, and how your OTC routine fits into the surgical coverage plan.'
                : _hasSupplements && _hasMinoxidil
                ? 'At NW7, your supplement stack and minoxidil provide nutritional support and a topical growth signal for remaining fringe follicle health — keep both consistent without gaps. The highest-ROI next addition is a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical DHT suppression alongside your existing minoxidil. Book a trichologist or transplant consultation this week to evaluate how your dual-layer protocol integrates with surgical coverage options (FUE/FUT or SMP).'
                : _hasMinoxidil
                ? 'Your minoxidil helps support follicle health at the remaining horseshoe fringe at NW7 — keep applying it consistently. The highest-ROI next step is booking a trichologist or transplant consultation this week to evaluate donor supply, candidacy, and how your topical maintenance fits into a surgical coverage plan (FUE/FUT or SMP).'
                : _hasSupplements
                ? 'Your supplement stack supports fringe follicle health at NW7 — keep biotin, zinc, and vitamin D consistent as the nutritional layer for remaining fringe follicles. The highest-ROI next step is booking a trichologist or transplant consultation this week to evaluate donor supply, candidacy, and how your nutritional protocol integrates with surgical coverage options (FUE/FUT or SMP).'
                : 'At NW7, scalp health maintenance protects remaining hair — keep any active routine going, but the highest-ROI step this week is booking a trichologist or transplant consultation to evaluate donor supply and candidacy.')
            : _isNW5only
              ? (_hasFinasteride && _hasSupplements && _hasDHTShampoo && _hasMassage
                  ? 'At NW5, your finasteride + supplement stack + DHT shampoo + stimulation protocol is the most complete scalp-health combination — optimize with weekly microneedling (0.5mm) over the thinnest zones 24-48 hours before topical application. Finasteride handles systemic DHT suppression; the remaining layers prime the scalp environment and support follicle health where miniaturization is most active.'
                  : _hasFinasteride && _hasSupplements && _hasDHTShampoo
                    ? 'At NW5, finasteride provides systemic DHT suppression alongside your supplement and DHT shampoo stack — add weekly microneedling (0.5mm) and a 4-minute scalp massage before each topical application. Mechanical stimulation is the highest-ROI addition to your existing finasteride-backed scalp health protocol at this stage.'
                    : _hasFinasteride && _hasSupplements
                      ? 'At NW5, finasteride handles systemic DHT while your supplements support follicle nutrition — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) and weekly microneedling to complete the anti-miniaturization stack. Three complementary layers (systemic DHT suppression + nutritional + mechanical) give the strongest scalp-health response where miniaturization spans the entire top.'
                      : _hasFinasteride
                        ? (_hasDHTShampoo
                            ? 'At NW5, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression across the full scalp top where miniaturization spans both the frontal and crown zones — take finasteride at the same time each day and leave DHT shampoo on 3-5 minutes per wash 3× weekly. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer and weekly microneedling over the thinnest zones to prime follicle response; the complete four-layer scalp-health protocol gives the strongest anti-miniaturization response where miniaturization is most widespread at this advanced stage.'
                            : 'Finasteride is suppressing systemic DHT at NW5 — build on that foundation with a supplement stack (biotin, zinc, vitamin D), a DHT-blocking shampoo 3× weekly (3-5 min contact time), and weekly microneedling. Finasteride addresses the root cause; these layers optimize the scalp environment for the remaining responsive follicles across the full top.')
                        : _hasSupplements && _hasDHTShampoo && _hasMassage
                          ? 'At NW5, miniaturization spans the full scalp top — your supplement stack, DHT shampoo, and stimulation routine are all active. Optimize with weekly microneedling (0.5mm) over the thinnest zones 24-48 hours before topical application to maximize absorption. Track scalp condition monthly; if inflammation or visible scaling appears, a dermatologist check can rule out any treatable scalp condition layered on top of AGA.'
                          : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                            ? 'At NW5, your supplement stack, minoxidil, and DHT-blocking shampoo deliver nutritional support, topical growth signal, and local DHT suppression across the full scalp top where miniaturization is most widespread — apply minoxidil twice daily across the full scalp top, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement stack consistent. Add a 4-minute scalp massage before each minoxidil application to prime follicle absorption; this OTC three-layer stack gives the strongest non-Rx anti-miniaturization response across both frontal and crown zones at this advanced stage.'
                          : _hasSupplements && _hasDHTShampoo
                            ? 'At NW5, scalp health needs mechanical stimulation added to your supplement and DHT shampoo stack — start weekly microneedling (0.5mm) over the thinnest zones and a 4-minute scalp massage before each topical application. Mechanical priming is the highest-ROI addition for improving how much your existing health protocol benefits the compromised follicles at this stage.'
                            : _hasSupplements && _hasMassage
                              ? (_hasLLLT
                                  ? 'At NW5, your supplement stack and LLLT device cover nutritional support and photobiomodulation across the full scalp top — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Biotin, zinc, and vitamin D support follicle structure from within; weekly microneedling (0.5mm) after your LLLT sessions is the highest-ROI absorption upgrade to complete the three-layer scalp-health protocol at this stage.'
                                  : _hasMicroneedling
                                  ? 'At NW5, your supplement stack and microneedling cover nutritional support and scalp priming across the full scalp top — use microneedling 24-48 hours before topical application to maximize absorption where miniaturization is most active across both frontal and crown zones. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx scalp-health response at this advanced stage.'
                                  : 'At NW5, your supplement stack and scalp massage cover nutritional support and mechanical stimulation across the full scalp top — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary layers (nutritional + mechanical + DHT suppression) give the strongest non-Rx scalp-health response where miniaturization spans both the frontal and crown zones at this stage.')
                            : _hasSupplements && _hasMinoxidil
                              ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at NW5 where miniaturization spans the entire scalp top — apply minoxidil across the full scalp top twice daily and keep supplements consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; supplements + minoxidil + DHT shampoo creates three complementary anti-miniaturization layers (nutritional + topical growth signal + topical DHT suppression) for the strongest scalp-health protocol at this advanced stage.'
                            : _hasSupplements
                              ? 'Your supplement stack is a good foundation at NW5 — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) and weekly microneedling to prime follicle response. Three layers together (supplementation + DHT suppression + mechanical stimulation) give the strongest scalp-health support where miniaturization is most widespread.'
                              : _hasDHTShampoo && _hasMassage
                                ? (_hasLLLT
                                    ? 'At NW5, your DHT-blocking shampoo and LLLT device provide topical DHT suppression and photobiomodulation across the full top — add a supplement stack (biotin, zinc, vitamin D) this week as the nutritional layer. Leave DHT shampoo on 3-5 minutes per wash and schedule weekly microneedling after your LLLT sessions to prime follicle response where miniaturization is most advanced at this stage.'
                                    : _hasMicroneedling
                                    ? 'At NW5, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming across the full top — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash for maximum topical DHT suppression. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer to complete the three-layer non-Rx scalp-health protocol where miniaturization is most advanced at this stage.'
                                    : 'At NW5, your DHT-blocking shampoo and scalp massage provide topical DHT suppression and mechanical stimulation across the full top — add a supplement stack (biotin, zinc, vitamin D) this week as the nutritional layer. Leave DHT shampoo on 3-5 minutes per wash and add weekly microneedling over the thinnest zones to prime follicle response where miniaturization is most advanced at this stage.')
                                : _hasDHTShampoo
                                  ? 'Your DHT-blocking shampoo provides topical DHT suppression at NW5 where miniaturization spans the full scalp top — leave it on 3-5 minutes per wash and add a supplement stack (biotin, zinc, vitamin D) plus a 4-minute scalp massage before each topical application. Three layers (DHT suppression + nutrition + mechanical stimulation) give the strongest scalp-health response across both frontal and crown zones.'
                                  : 'At NW5, scalp health across the full top needs the full anti-miniaturization protocol: switch to a gentle sulfate-free shampoo, start a supplement stack (biotin, zinc, vitamin D), add a DHT-blocking shampoo 3× weekly (3-5 min contact time), and consider weekly microneedling. A dermatologist visit can also rule out any inflammatory layer that topicals alone cannot address.')
              : _isNW56
              // only NW6 reaches here — NW5 is handled by _isNW5only above
              ? (_hasFinasteride && _hasSupplements && _hasDHTShampoo
                  ? 'At NW6, finasteride handles systemic DHT suppression for the remaining fringe — your supplement stack and DHT-blocking shampoo complete the anti-miniaturization protocol. Use the DHT shampoo 3× weekly with 3-5 minutes of contact time and add weekly microneedling over the fringe zones to prime remaining follicle response. A dermatologist check is still worth scheduling to rule out any inflammatory overlay.'
                  : _hasFinasteride && _hasSupplements
                    ? 'At NW6, finasteride + supplements handle DHT suppression and follicle nutrition — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) and weekly microneedling over the fringe zones. Together these four layers give the most complete non-surgical scalp-health protocol at this stage; consider a dermatologist visit to rule out any treatable inflammatory component.'
                    : _hasFinasteride
                      ? (_hasDHTShampoo
                          ? 'At NW6, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression for remaining fringe follicle health — take finasteride at the same time each day without gaps and leave DHT shampoo on 3-5 minutes per wash 3× weekly. Add weekly microneedling over the fringe zones to prime remaining follicle response and consider a supplement stack (biotin, zinc, vitamin D) as the nutritional layer; a dermatologist check can also rule out any inflammatory component that your current dual-DHT protocol cannot address alone.'
                          : 'Finasteride is protecting remaining fringe follicles at NW6 through systemic DHT suppression — complement it with biotin, zinc, and vitamin D supplements plus a gentle sulfate-free shampoo 3× weekly. A DHT-blocking shampoo adds topical DHT control on top of your finasteride; consider a dermatologist check to rule out any inflammatory layer at this advanced stage.')
                      : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                        ? 'Your supplement stack, minoxidil, and DHT-blocking shampoo deliver nutritional follicle support, topical growth signal, and local DHT suppression for remaining fringe follicles at NW6 — apply minoxidil to the fringe and lateral edges twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement stack consistent. Add weekly microneedling over the fringe zones to prime remaining follicle response and complete the four-layer scalp-health protocol; consider a dermatologist check to rule out any inflammatory component alongside your existing OTC stack.'
                      : _hasSupplements && _hasDHTShampoo
                        ? 'Your supplement and DHT-blocking shampoo routine is protecting remaining follicles at NW6 — keep DHT shampoo on 3-5 minutes per wash and add weekly microneedling over the fringe zones to prime follicle response. A dermatologist check can rule out any inflammatory component that your current protocol cannot address alone.'
                        : _hasSupplements && _hasMassage
                          ? (_hasLLLT
                              ? 'At NW6, your supplement stack and LLLT device cover nutritional support and photobiomodulation for remaining fringe follicles — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Schedule weekly microneedling after your LLLT sessions to prime remaining fringe follicle response; three complementary layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx scalp-health protocol for stabilizing fringe coverage at this stage. A dermatologist check can rule out any inflammatory component alongside your existing protocol.'
                              : _hasMicroneedling
                              ? 'At NW6, your supplement stack and microneedling cover nutritional support and scalp priming for remaining fringe follicles — use microneedling 24-48 hours before topical application and avoid applying active ingredients to a sensitized scalp immediately after needling. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) on non-needling days as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx protocol for stabilizing remaining fringe coverage at this stage. A dermatologist check can rule out any inflammatory component alongside your existing protocol.'
                              : 'At NW6, your supplement stack and scalp massage cover nutritional support and mechanical stimulation for remaining fringe follicles — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Leave DHT shampoo on 3-5 minutes per wash and add weekly microneedling over the fringe zones to prime remaining follicle response; three complementary layers (nutritional + mechanical + DHT suppression) give the strongest non-Rx scalp-health protocol for stabilizing fringe coverage at this stage.')
                          : _hasDHTShampoo && _hasMassage
                          ? (_hasLLLT
                              ? 'At NW6, your DHT-blocking shampoo and LLLT device cover topical DHT suppression and photobiomodulation for remaining fringe follicles — leave DHT shampoo on 3-5 minutes per wash and schedule weekly microneedling after your LLLT sessions to prime remaining follicle response. Add biotin, zinc, and vitamin D supplements as the nutritional layer and consider a dermatologist check to rule out any inflammatory component alongside your existing protocol.'
                              : _hasMicroneedling
                              ? 'At NW6, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming for remaining fringe follicles — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add biotin, zinc, and vitamin D supplements as the nutritional layer and consider a dermatologist check to rule out any inflammatory component alongside your existing protocol. The realistic goal at NW6 is stabilizing remaining fringe coverage with a complete multi-layer scalp-health routine.'
                              : 'At NW6, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation for remaining fringe follicles — leave DHT shampoo on 3-5 minutes per wash and add weekly microneedling over the fringe zones to prime follicle response. Add biotin, zinc, and vitamin D supplements as the nutritional layer and consider a dermatologist check to rule out any inflammatory component alongside your existing protocol.')
                          : _hasDHTShampoo
                          ? 'Your DHT-blocking shampoo provides topical DHT suppression for remaining fringe follicles at NW6 — keep using it 3× weekly with 3-5 minutes of contact time. Add biotin, zinc, and vitamin D supplements as the nutritional support layer and consider a dermatologist check to rule out any inflammatory component. The combination of DHT suppression and nutritional support protects what follicle health remains at this stage.'
                          : _hasSupplements && _hasMinoxidil
                          ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for remaining fringe follicles at NW6 — apply minoxidil to the fringe and lateral edges twice daily and keep supplements consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; supplements + minoxidil + DHT shampoo creates the strongest OTC three-layer scalp-health approach for stabilizing fringe follicle health at this advanced stage.'
                          : _hasSupplements
                          ? 'Your supplement stack is supporting fringe follicle health at NW6 — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer. DHT shampoo + supplements creates dual-layer coverage (topical DHT control + nutritional support) for protecting remaining follicles; add a 4-minute scalp massage before each topical application for mechanical stimulation. Consider a dermatologist check to rule out any inflammatory component that your current protocol cannot address alone.'
                          : 'Protect remaining follicles: use a gentle sulfate-free shampoo 3× weekly, add biotin/zinc if not already in your routine, and consider a dermatologist visit to rule out any inflammatory or nutritional component slowing response.')
              : data.stage === 'NW1'
                ? (_hasFinasteride && _hasSupplements && _hasDHTShampoo
                    ? 'Your scalp health is fully protected at NW1 with finasteride + supplements + DHT-blocking shampoo — the most complete preventive protocol. Target sleep quality this week (7-8 hrs); cortisol from poor sleep accelerates miniaturization even before visible thinning begins.'
                    : _hasFinasteride && _hasSupplements
                      ? 'Finasteride + supplement stack is a strong NW1 health foundation — add a DHT-blocking shampoo 3× weekly with 3-5 minutes of contact time for the topical-level DHT-suppression layer alongside your systemic finasteride coverage.'
                      : _hasFinasteride && _hasDHTShampoo
                        ? 'Your scalp health has dual-level DHT protection at NW1 — finasteride suppresses systemic DHT and your DHT-blocking shampoo adds topical control at the scalp surface before any visible thinning begins. Keep DHT shampoo on 3-5 minutes per wash 3× weekly and finasteride consistent without gaps. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer to complete the most comprehensive NW1 preventive protocol.'
                        : _hasFinasteride
                          ? 'Finasteride provides systemic DHT protection at NW1 — build the local layer with a supplement stack (biotin, zinc, vitamin D) and a DHT-blocking shampoo 3× weekly. All three together form the most complete anti-miniaturization protocol before any visible thinning begins.'
                        : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                          ? 'At NW1, your supplement stack, minoxidil, and DHT-blocking shampoo form the most complete OTC preventive scalp-health protocol before any visible thinning begins — nutritional follicle support, topical growth signal, and local DHT suppression all active. Apply minoxidil to the scalp top twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. This three-layer OTC stack gives the strongest non-Rx scalp-health foundation at the optimal prevention window; target sleep quality this week (7-8 hrs) as the highest-ROI lifestyle addition — cortisol from poor sleep accelerates miniaturization even when your preventive protocol is this complete.'
                        : _hasSupplements && _hasDHTShampoo
                          ? 'Your scalp is in strong preventive shape — target sleep quality this week (7-8 hrs). Cortisol from poor sleep accelerates miniaturization even before visible thinning begins.'
                          : _hasSupplements && _hasMassage
                            ? (_hasLLLT
                                ? 'At NW1, your supplement stack and LLLT device cover nutritional support and photobiomodulation before any visible thinning begins — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary preventive layers (nutritional + photobiomodulation + topical DHT suppression) form the strongest non-Rx foundation at this optimal prevention window before any recession develops.'
                                : _hasMicroneedling
                                ? 'At NW1, your supplement stack and microneedling cover nutritional support and scalp priming before any visible thinning begins — use microneedling 24-48 hours before topical application for maximum absorption at this preventive stage. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary preventive layers (nutritional + scalp priming + DHT suppression) form the strongest non-Rx foundation before any recession develops.'
                                : 'At NW1, your supplement stack and scalp massage cover nutritional support and mechanical stimulation before any visible thinning begins — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary preventive layers (nutritional + mechanical + DHT suppression) give the strongest non-Rx foundation at this optimal prevention window.')
                          : _hasSupplements && _hasMinoxidil
                            ? 'Your supplement stack and minoxidil cover nutritional follicle support and a topical growth signal at NW1 before any visible thinning begins — keep both consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-prevention layer; supplements + minoxidil + DHT shampoo forms the most complete non-Rx preventive protocol at this optimal window before any recession develops.'
                          : _hasSupplements
                            ? 'Your supplement stack is active — add a DHT-blocking shampoo 3× weekly as a preventive layer. NW1 is the optimal window to build a protective routine before any thinning develops.'
                            : _hasDHTShampoo && _hasMassage
                              ? (_hasLLLT
                                  ? 'At NW1, your DHT-blocking shampoo and LLLT device form a strong dual-layer preventive approach — DHT shampoo suppresses topical DHT at the scalp surface before any visible thinning begins, while LLLT photobiomodulation supports follicle health at the cellular level. Schedule your LLLT session on DHT shampoo wash days so the follicle microenvironment is primed; add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer to complete the three-layer non-Rx preventive foundation at this optimal prevention window.'
                                  : _hasMicroneedling
                                  ? 'At NW1, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming before any visible thinning begins — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer; three complementary preventive layers (DHT suppression + scalp priming + nutritional) form the strongest non-Rx foundation at this optimal prevention window.'
                                  : 'At NW1, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation before any visible thinning begins — add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer. Three complementary preventive layers (DHT suppression + mechanical + nutritional) give the strongest non-Rx preventive foundation at this optimal window before any thinning develops.')
                            : _hasDHTShampoo
                              ? 'Your DHT-blocking shampoo provides topical-level DHT protection at NW1 before any visible thinning begins — keep using it 3× weekly with 3-5 minutes of contact time. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer; together they form the strongest dual-layer OTC preventive foundation at this optimal prevention window.'
                              : 'Your hair is healthy — protect it now: switch to a gentle sulfate-free shampoo, stay well-hydrated, and start a basic supplement stack (biotin, zinc, vitamin D) to support follicle health proactively.')
                : data.stage === 'NW2'
                  // NW2: earliest recession stage — scalp health is still strong, goal is protection and anti-miniaturization foundation
                  ? (_hasFinasteride && _hasSupplements && _hasDHTShampoo
                      ? 'At NW2, finasteride + supplements + DHT shampoo delivers systemic DHT suppression, nutritional support, and topical DHT control — the most complete scalp-health foundation at this early stage. Leave the DHT shampoo on 3-5 minutes before rinsing for maximum contact time at the temple recession edge where miniaturization is just beginning.'
                      : _hasFinasteride && _hasSupplements
                        ? 'Finasteride + supplements is a strong NW2 health foundation — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT layer. Systemic finasteride handles the hormonal root cause; the DHT shampoo adds topical suppression at the early recession edge where miniaturization is beginning.'
                        : _hasFinasteride && _hasDHTShampoo
                          ? 'Finasteride + DHT-blocking shampoo covers both systemic and topical DHT suppression at NW2 where miniaturization is just starting at the temple edge — take finasteride consistently and leave DHT shampoo on 3-5 minutes before rinsing for maximum topical DHT suppression. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer to complete the three-layer anti-miniaturization foundation at this ideal preventive window.'
                          : _hasFinasteride
                            ? 'Finasteride suppresses systemic DHT at NW2 where miniaturization is just beginning — build the local scalp-health layer with a supplement stack (biotin, zinc, vitamin D) and a DHT-blocking shampoo 3× weekly. All three layers together create the strongest anti-miniaturization foundation at the ideal preventive window.'
                          : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                            ? 'At NW2, your supplement stack, minoxidil, and DHT-blocking shampoo deliver the strongest OTC three-layer anti-miniaturization foundation at this ideal early prevention stage — nutritional follicle support, topical growth signal, and local DHT control all active. Apply minoxidil to both temple corners twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. NW2 is the optimal preventive window; this complete OTC triple-layer protocol gives the strongest protection before recession deepens further. Add a 4-minute scalp massage before each minoxidil application as the next highest-ROI mechanical layer.'
                          : _hasSupplements && _hasDHTShampoo
                            ? 'Supplements and DHT-blocking shampoo are building a strong preventive foundation at NW2 — maximize the DHT shampoo by leaving it on 3-5 minutes before rinsing. Contact time determines how much DHT suppression reaches the follicle level at the recession edge.'
                            : _hasSupplements && _hasMassage
                              ? (_hasLLLT
                                  ? 'At NW2, your supplement stack and LLLT device cover nutritional support and photobiomodulation at the ideal prevention stage — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx preventive foundation at this optimal intervention window before temple recession deepens further.'
                                  : _hasMicroneedling
                                  ? 'At NW2, your supplement stack and microneedling cover nutritional support and scalp priming at the early recession edge — use microneedling 24-48 hours before topical application to maximize absorption at the temple corners. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx preventive foundation at this optimal intervention window.'
                                  : 'At NW2, your supplement stack and scalp massage cover nutritional support and mechanical stimulation at the ideal prevention stage — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary layers (nutritional + mechanical + DHT suppression) give the strongest non-Rx preventive foundation before temple recession deepens further.')
                          : _hasSupplements && _hasMinoxidil
                              ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at NW2 where miniaturization is just beginning at the temple edge — apply minoxidil to both temple corners twice daily and keep supplements consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; supplements + minoxidil + DHT shampoo forms the strongest non-Rx anti-miniaturization foundation at this ideal early-intervention window.'
                          : _hasSupplements
                              ? 'Your supplement stack is a good start — add a DHT-blocking shampoo 3× weekly at NW2. Used with 3-5 minutes of contact time before rinsing, it suppresses topical DHT at the recession edge where miniaturization is beginning.'
                              : _hasDHTShampoo && _hasMassage
                                ? (_hasLLLT
                                    ? 'At NW2, your DHT-blocking shampoo and LLLT device form a strong dual-layer preventive approach — DHT shampoo suppresses topical DHT at the early recession edge while LLLT photobiomodulation reaches the follicle level. Schedule your LLLT session on DHT shampoo wash days so the follicle microenvironment is primed immediately after photobiomodulation; then add a supplement stack (biotin, zinc, vitamin D) to complete the three-layer non-Rx preventive foundation at this optimal intervention window.'
                                    : _hasMicroneedling
                                    ? 'At NW2, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming at the early recession edge — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash for maximum topical DHT suppression at the temple corners. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer; three complementary layers (DHT suppression + mechanical priming + nutritional) give the strongest non-Rx preventive foundation at this optimal intervention window.'
                                    : 'At NW2, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation at the early recession edge — add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer. Three complementary layers (DHT suppression + mechanical + nutritional) give the strongest non-Rx preventive foundation at this optimal window before recession progresses.')
                              : _hasDHTShampoo
                                ? 'Your DHT-blocking shampoo is providing topical DHT protection at NW2 where miniaturization is just beginning — add a supplement stack (biotin, zinc, vitamin D) to complete the preventive foundation. Biotin, zinc, and vitamin D support follicle structure and scalp health from within; together with your DHT shampoo they form the dual-layer OTC anti-miniaturization approach at this early stage.'
                              : 'At NW2, scalp health is still excellent — protect it now with a gentle sulfate-free shampoo, a DHT-blocking shampoo 3× weekly, and a supplement stack (biotin, zinc, vitamin D). Building the anti-miniaturization foundation here costs far less than treating established recession later.')
                  : data.stage === 'NW3'
                    // NW3: established AGA — miniaturization is active at the recession edge; scalp health needs to support topical treatment
                    ? (_hasFinasteride && _hasSupplements && _hasDHTShampoo && _hasMassage
                        ? 'NW3 scalp health with finasteride + supplements + DHT shampoo + massage is the most complete anti-miniaturization protocol — add weekly microneedling (0.5mm) over the recession edges. Microneedling primes the follicle microenvironment where DHT-driven miniaturization is most active, amplifying the impact of every layer already in place.'
                        : _hasFinasteride && _hasSupplements && _hasDHTShampoo
                          ? 'At NW3, finasteride + supplements + DHT shampoo delivers systemic and topical DHT suppression alongside nutritional support — add weekly microneedling (0.5mm) to the recession edges and a 4-minute scalp massage. Mechanical stimulation is the highest-ROI addition when the anti-miniaturization protocol is already this complete.'
                          : _hasFinasteride && _hasSupplements
                            ? 'Finasteride + supplements is a solid NW3 foundation — add a DHT-blocking shampoo 3× weekly with 3-5 minutes of contact time at the recession edge. Combined with your finasteride, it delivers both systemic and topical DHT suppression where miniaturization is most active.'
                            : _hasFinasteride && _hasDHTShampoo
                              ? 'At NW3, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression at the active temple recession edge — take finasteride at the same time each day and leave DHT shampoo on 3-5 minutes per wash 3× weekly. Add a supplement stack (biotin, zinc, vitamin D) and weekly microneedling over the recession edges 24-48 hours before topical application to complete the anti-miniaturization protocol at this pivotal NW3 response window.'
                            : _hasFinasteride
                              ? 'Finasteride is suppressing systemic DHT at NW3 — build the local scalp-health layer with a supplement stack (biotin, zinc, vitamin D) and a DHT-blocking shampoo 3× weekly. Systemic and topical DHT suppression together target miniaturization at both levels; add weekly microneedling to prime follicle absorption at the recession edge.'
                              : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                              ? 'Your supplement stack, minoxidil, and DHT-blocking shampoo cover nutritional follicle support, topical growth signal, and local DHT suppression at the active NW3 recession edge — apply minoxidil to both temple recession zones twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. Add weekly microneedling (0.5mm) over the recession edges 24-48 hours before topical application to amplify absorption where miniaturization is most active; mechanical priming is the highest-ROI addition to your existing three-layer anti-miniaturization protocol at this established stage.'
                              : _hasSupplements && _hasDHTShampoo && _hasMassage
                                  ? (_hasLLLT
                                      ? 'At NW3, your supplements + DHT shampoo + LLLT device covers nutrition, topical DHT suppression, and photobiomodulation at the active recession edge — add weekly microneedling (0.5mm) at the recession edge after your LLLT sessions to amplify follicle response where miniaturization is actively progressing. A doctor consult about finasteride is the highest-ROI next step for systemic DHT suppression at this established stage.'
                                      : _hasMicroneedling
                                      ? 'At NW3, your supplements + DHT shampoo + microneedling covers nutrition, topical DHT suppression, and scalp priming at the active recession edge — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. A doctor consult about finasteride is the highest-ROI next step for systemic DHT suppression at this established stage.'
                                      : 'Your scalp-health kit is well-stocked at NW3 — add a weekly dermaroller session (0.5-1mm) over the recession edges. Microneedling primes the follicle microenvironment and significantly improves topical absorption precisely where miniaturization is most active at this stage.')
                                  : _hasSupplements && _hasDHTShampoo
                                    ? 'At NW3, the recession edge is where miniaturization is most active — add weekly microneedling (0.5mm) to the recession zones. It enhances absorption and follicle response where your existing supplement and DHT shampoo routine needs the most backup.'
                                    : _hasSupplements && _hasMassage
                                      ? (_hasLLLT
                                          ? 'At NW3, your supplement stack and LLLT device cover nutritional support and photobiomodulation at the active recession edge — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx scalp-health response where miniaturization is actively progressing at this established stage.'
                                          : _hasMicroneedling
                                          ? 'At NW3, your supplement stack and microneedling cover nutritional support and scalp priming at the active recession edge — use microneedling 24-48 hours before topical application to maximize absorption where miniaturization is most active. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx scalp-health response where miniaturization is actively progressing at this established stage.'
                                          : 'At NW3, your supplement stack and scalp massage cover nutritional support and mechanical stimulation at the active recession edge — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary layers (nutritional + mechanical + DHT suppression) give the strongest non-Rx scalp-health response where miniaturization is actively progressing at this established stage.')
                                    : _hasSupplements && _hasMinoxidil
                                      ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at the active NW3 recession edge — apply minoxidil to both recession zones twice daily and keep supplements consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; suppressing DHT at the recession edge where miniaturization is most active is the highest-ROI scalp-health addition to your current dual-layer protocol.'
                                    : _hasSupplements
                                      ? 'At NW3, DHT-blocking shampoo is the key missing layer — use it 3× weekly with 3-5 minutes of contact time. Scalp inflammation at the recession edge accelerates miniaturization; suppressing topical DHT alongside your supplements is the strongest dual response at this stage.'
                                      : _hasDHTShampoo && _hasMassage
                                        ? (_hasLLLT
                                            ? 'At NW3, your DHT-blocking shampoo and LLLT device cover topical DHT suppression and photobiomodulation at the recession edge — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer. Three complementary layers (DHT suppression + photobiomodulation + nutritional) give the strongest non-Rx scalp-health response where miniaturization is actively progressing at this established stage.'
                                            : _hasMicroneedling
                                            ? 'At NW3, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming at the active recession edge — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer; three complementary layers (DHT suppression + mechanical priming + nutritional) give the strongest non-Rx scalp-health response where miniaturization is actively progressing at this established stage.'
                                            : 'At NW3, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation at the recession edge — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer. Three complementary layers (DHT suppression + mechanical + nutritional) give the strongest non-Rx scalp-health response where miniaturization is actively progressing at this established stage.')
                                        : _hasDHTShampoo
                                          ? 'Your DHT-blocking shampoo is suppressing topical DHT at the recession edge at NW3 — add a supplement stack (biotin, zinc, vitamin D) for nutritional follicle support and a 4-minute scalp massage before each topical application. All three layers together give the strongest non-Rx scalp-health response where miniaturization is most active at this established stage.'
                                          : 'NW3 recession means miniaturization is actively progressing — switch to a sulfate-free shampoo, start a supplement stack (biotin, zinc, vitamin D), and add a DHT-blocking shampoo 3× weekly. Reducing inflammation at the recession edge reinforces every other treatment layer.')
                    : data.stage === 'NW3v'
                      // NW3v: dual-zone miniaturization active at temples AND early crown — scalp health must serve both fronts
                      ? (_hasFinasteride && _hasSupplements && _hasDHTShampoo && _hasMassage
                          ? 'At NW3v, finasteride + supplements + DHT shampoo + massage is the most complete anti-miniaturization protocol across both active fronts — add weekly microneedling (0.5mm) covering BOTH the recession edge AND the early crown zone 24-48 hours before topical application. Mechanical priming at both active fronts amplifies the impact of every layer in your current four-layer protocol where miniaturization is simultaneously progressing.'
                          : _hasFinasteride && _hasSupplements && _hasDHTShampoo
                          ? 'At NW3v, finasteride + supplements + DHT shampoo is providing systemic and topical DHT suppression across both active miniaturization fronts — add weekly microneedling (0.5mm) covering the recession edge AND the early crown zone 24-48 hours before topical application. Two-front miniaturization needs every anti-inflammatory layer; mechanical stimulation is the highest-ROI addition to your current three-layer protocol.'
                          : _hasFinasteride && _hasSupplements
                            ? 'NW3v with finasteride + supplements addressing two simultaneous miniaturization zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) and weekly microneedling across both the recession edge and early crown. Topical DHT suppression alongside your systemic finasteride creates dual-level coverage for both active fronts.'
                            : _hasFinasteride && _hasDHTShampoo
                              ? 'At NW3v, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression across both active miniaturization fronts — temples and early crown. Leave DHT shampoo on 3-5 minutes per wash 3× weekly and take finasteride at the same time each day. Add a supplement stack (biotin, zinc, vitamin D) and weekly microneedling across both the recession edge and early crown zone 24-48 hours before topical application to complete the anti-miniaturization protocol at this dual-zone stage.'
                            : _hasFinasteride
                              ? 'Finasteride provides systemic DHT suppression at NW3v where temples and early crown are simultaneously active — build the local scalp-health layer with a supplement stack (biotin, zinc, vitamin D), a DHT-blocking shampoo 3× weekly, and weekly microneedling across both active zones. Two-front miniaturization needs every anti-inflammatory layer working in parallel.'
                              : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                              ? 'Your supplement stack, minoxidil, and DHT-blocking shampoo cover nutritional follicle support, topical growth signal, and local DHT suppression across both active zones at NW3v — apply minoxidil to BOTH the temple recession zones AND the vertex twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. Add weekly microneedling (0.5mm) covering BOTH the recession edge AND the early crown zone 24-48 hours before topical application to amplify absorption at both active fronts; two-front miniaturization at NW3v needs targeted mechanical priming at both zones, and microneedling is the highest-ROI addition to your existing three-layer protocol.'
                              : _hasSupplements && _hasDHTShampoo && _hasMassage
                                  ? (_hasLLLT
                                      ? 'At NW3v, your supplements + DHT shampoo + LLLT device covers nutrition, topical DHT suppression, and photobiomodulation across both active zones — add weekly microneedling (0.5mm) at both the recession edge AND the early crown zone after your LLLT sessions to amplify follicle response at both active fronts. A doctor consult about finasteride is the highest-ROI next step for systemic DHT suppression at this dual-zone stage.'
                                      : _hasMicroneedling
                                      ? 'At NW3v, your supplements + DHT shampoo + microneedling covers nutrition, topical DHT suppression, and scalp priming across both active zones — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash at both the recession edge and early crown zone. A doctor consult about finasteride is the highest-ROI next step for systemic DHT suppression at this dual-zone stage.'
                                      : 'At NW3v, supplements + DHT shampoo + massage covers nutrition, topical DHT suppression, and mechanical stimulation across both active zones — add weekly microneedling (0.5mm) at both the recession edge AND the early crown zone 24-48 hours before topical application to amplify absorption at both active fronts. A doctor consult about finasteride is the highest-ROI next step for systemic DHT suppression at this dual-zone stage.')
                                  : _hasSupplements && _hasDHTShampoo
                                  ? 'At NW3v, two zones have active miniaturization — temples AND early crown. Add a weekly microneedling session (0.5mm) covering both zones to open absorption channels and stimulate blood flow to both active fronts. Use it 24-48 hours before topical application for maximum impact.'
                                  : _hasSupplements && _hasMassage
                                    ? (_hasLLLT
                                        ? 'At NW3v, your supplement stack and LLLT device cover nutritional support and photobiomodulation across both the recession edge and early crown — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Two-front miniaturization at NW3v needs DHT control at the follicle level across both active zones; together the three layers give the strongest non-Rx anti-miniaturization protocol at this dual-zone stage.'
                                        : _hasMicroneedling
                                        ? 'At NW3v, your supplement stack and microneedling cover nutritional support and scalp priming across both the recession edge and early crown — use microneedling 24-48 hours before topical application to maximize absorption at both active fronts. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers give the strongest non-Rx anti-miniaturization protocol at this dual-zone stage.'
                                        : 'At NW3v, your supplement stack and scalp massage cover nutritional support and mechanical stimulation across both the recession edge and early crown — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. DHT shampoo is the highest-ROI addition when supplements and massage are already in place at this dual-zone stage.')
                                  : _hasSupplements && _hasMinoxidil
                                  ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal across both active zones at NW3v — apply minoxidil to BOTH the temple recession zones AND the vertex twice daily and keep supplements consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; at this dual-zone stage suppressing DHT at both the recession edge and early crown simultaneously is the highest-ROI scalp-health addition to your current protocol.'
                                  : _hasSupplements
                                  ? 'Your supplement stack is active at NW3v where both temples and early crown are simultaneously thinning — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) and weekly microneedling across both the recession edge and early crown. Two-front miniaturization needs topical DHT suppression AND mechanical priming working in parallel at both active zones.'
                                  : _hasDHTShampoo && _hasMassage
                                    ? (_hasLLLT
                                        ? 'At NW3v, your DHT-blocking shampoo and LLLT device cover topical DHT suppression and photobiomodulation across both the recession edge and early crown — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer, and weekly microneedling (0.5mm) at both active zones after your LLLT sessions. A doctor consult about finasteride is the highest-ROI next step for systemic DHT suppression at this dual-zone stage.'
                                        : _hasMicroneedling
                                        ? 'At NW3v, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming across both the recession edge and early crown — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash at both active zones. Add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer, and consider a doctor consult about finasteride as the highest-ROI systemic step at this dual-zone stage.'
                                        : 'At NW3v, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation across both the recession edge and early crown — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer, and weekly microneedling (0.5mm) at both active zones 24-48 hours before topical application. A doctor consult about finasteride is the highest-ROI next step for systemic DHT suppression at this dual-zone stage.')
                                    : _hasDHTShampoo
                                      ? 'DHT-blocking shampoo is a good start at NW3v — add a supplement stack (biotin, zinc, vitamin D) and weekly microneedling at both the recession edge AND the early crown zone. Two active miniaturization fronts need a full anti-inflammatory protocol, not just topicals.'
                                      : 'NW3v means two zones are simultaneously thinning — scalp health must serve both. Add a DHT-blocking shampoo 3× weekly plus a supplement stack (biotin, zinc, vitamin D), and start weekly microneedling across the recession edge and early crown. Two-front miniaturization needs a two-front health protocol.')
                      : data.stage === 'NW4'
                        // NW4: significant miniaturization likely at both frontal and crown edges — scalp environment is critical for topical effectiveness
                        ? (_hasFinasteride && _hasSupplements && _hasDHTShampoo && _hasMassage
                            ? 'NW4 scalp health with finasteride + supplements + DHT shampoo + massage is the most complete anti-miniaturization protocol — optimize by timing microneedling (0.5mm) 24-48 hours before topical application across the frontal and crown zones. Absorption quality determines how much your finasteride-backed protocol converts to follicle-level impact where miniaturization is most advanced.'
                            : _hasFinasteride && _hasSupplements && _hasDHTShampoo
                              ? 'At NW4, finasteride + supplements + DHT shampoo delivers systemic and topical DHT suppression with nutritional support — add scalp massage before each topical application and weekly microneedling over the thinnest zones. Mechanical stimulation is the highest-ROI addition to your existing three-layer anti-miniaturization protocol at NW4.'
                              : _hasFinasteride && _hasSupplements
                                ? 'Finasteride + supplements addresses the systemic and nutritional dimensions of miniaturization at NW4 — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT layer. Systemic finasteride + topical DHT shampoo creates dual-level coverage where miniaturization spans both the frontal and crown zones.'
                                : _hasFinasteride && _hasDHTShampoo
                                  ? 'At NW4, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression where miniaturization spans both the frontal and crown zones — leave DHT shampoo on 3-5 minutes per wash 3× weekly and take finasteride at the same time each day. Add a supplement stack (biotin, zinc, vitamin D) and weekly microneedling over the thinnest zones 24-48 hours before topical application to complete the anti-miniaturization protocol at this advanced stage.'
                                : _hasFinasteride
                                  ? 'Finasteride is blocking systemic DHT at NW4 where miniaturization spans both the frontal and crown zones — build the local scalp-health layer: add a supplement stack (biotin, zinc, vitamin D), a DHT-blocking shampoo 3× weekly, and weekly microneedling. Systemic DHT suppression handles the root cause; these layers optimize the scalp environment for follicles under dual-zone miniaturization pressure.'
                                  : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                    ? 'Your supplement stack, minoxidil, and DHT-blocking shampoo deliver nutritional follicle support, topical growth signal, and local DHT suppression across both the frontal and crown miniaturization zones at NW4 — apply minoxidil across the entire scalp top twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistently. Add a 4-minute scalp massage before each topical application and weekly microneedling (0.5mm) over the thinnest zones to prime follicle-level absorption where miniaturization is most advanced; mechanical stimulation is the highest-ROI addition to your existing three-layer anti-miniaturization protocol at this established stage.'
                                  : _hasSupplements && _hasDHTShampoo && _hasMassage
                                      ? 'At NW4 the full scalp-health kit is active — focus on absorption quality this week: microneedle the thinnest zones (0.5mm) 48 hours before topical application, and leave DHT shampoo on 3-5 minutes per wash. Scalp preparation quality determines how much of your treatment actually reaches the follicle.'
                                      : _hasSupplements && _hasDHTShampoo
                                        ? 'At NW4, add scalp massage before each topical application and consider weekly microneedling (0.5mm) over the thinnest zones — mechanical stimulation significantly improves topical absorption where miniaturization is most advanced, and your supplement and DHT shampoo stack benefits directly from it.'
                                        : _hasDHTShampoo && _hasMassage
                                          ? (_hasLLLT
                                              ? 'At NW4, your DHT-blocking shampoo and LLLT device cover topical DHT suppression and photobiomodulation across the full scalp top — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer. Biotin, zinc, and vitamin D support follicle structure from within; weekly microneedling (0.5mm) over the thinnest zones timed after your LLLT sessions is the highest-ROI absorption upgrade to your existing two-layer protocol at this established stage.'
                                              : _hasMicroneedling
                                              ? 'At NW4, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming across the full scalp top — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer; biotin, zinc, and vitamin D support follicle structure from within and complete the three-layer scalp-health protocol at this established stage.'
                                              : 'At NW4, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation across the full scalp top — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer. Biotin, zinc, and vitamin D support follicle structure from within; weekly microneedling (0.5mm) over the thinnest zones 24-48 hours before topical application is the highest-ROI absorption upgrade to your existing two-layer protocol at this established stage.')
                                          : _hasDHTShampoo
                                          ? 'At NW4, your DHT shampoo is handling topical suppression — add a supplement stack (biotin, zinc, vitamin D) and a pre-application scalp massage. Advanced miniaturization at NW4 needs every anti-inflammatory layer working together to maintain follicle health.'
                                          : _hasSupplements && _hasMassage
                                            ? (_hasLLLT
                                                ? 'At NW4, your supplement stack and LLLT device cover nutritional support and photobiomodulation across both the frontal and crown zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Schedule weekly microneedling (0.5mm) after your LLLT sessions to prime follicle absorption where miniaturization is most advanced; three complementary layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx scalp-health protocol at this established stage.'
                                                : _hasMicroneedling
                                                ? 'At NW4, your supplement stack and microneedling cover nutritional support and scalp priming across both the frontal and crown zones — use microneedling 24-48 hours before topical application to maximize absorption where miniaturization is most advanced. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx scalp-health protocol where miniaturization spans both the frontal and crown zones at this established stage.'
                                                : 'At NW4, your supplement stack and scalp massage cover nutritional support and mechanical stimulation — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT suppression layer. It is the most impactful addition to your existing stack where miniaturization spans both the frontal and crown zones.')
                                            : _hasSupplements && _hasMinoxidil
                                              ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at NW4 where miniaturization spans both the frontal and crown zones — apply minoxidil across the entire scalp top twice daily and keep supplements consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; suppressing DHT at the follicle level across both active zones alongside your existing nutritional and topical protocol gives the strongest non-Rx scalp-health approach at this established stage.'
                                            : _hasSupplements
                                              ? 'Your supplement stack is supporting follicle health at NW4 — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) and a pre-application scalp massage. DHT suppression at the topical level plus mechanical stimulation are the two most impactful missing layers where miniaturization is most advanced across the full scalp top.'
                                              : 'At NW4, scalp health needs the full anti-miniaturization stack: DHT-blocking shampoo 3× weekly (3-5 min contact time), a supplement stack (biotin, zinc, vitamin D), and weekly microneedling. Advanced miniaturization at this stage requires every layer to be active.')
                        : (data.stage === 'diffuse' || data.stage === 'n/a (female)')
                          ? (_hasFinasteride && _hasSupplements && _hasDHTShampoo
                              ? (data.stage === 'n/a (female)'
                                  ? "Female-pattern scalp health with finasteride + supplements + DHT shampoo covers systemic DHT suppression, nutritional support, and topical DHT control — the most complete protocol. The highest-ROI next step is a ferritin, thyroid, and hormone panel: a reversible hormonal cause is common in women and identifying it can produce improvement beyond what your current stack achieves."
                                  : "Diffuse scalp health with finasteride + supplements + DHT shampoo covers systemic DHT suppression, nutritional support, and topical DHT control — the most complete anti-miniaturization protocol. The highest-ROI next step is a ferritin, vitamin D, and thyroid workup to rule out a reversible cause that amplifies the diffuse pattern beyond what DHT suppression can address.")
                              : _hasFinasteride && _hasSupplements
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern scalp health with finasteride + supplements covers systemic DHT suppression and nutritional support — add a DHT-blocking shampoo 3× weekly for topical-level DHT control. A ferritin, thyroid, and hormone panel is still the highest-ROI investigation: a reversible hormonal cause can produce improvement beyond what your supplement + DHT protocol achieves."
                                    : "Diffuse scalp health with finasteride + supplements covers systemic DHT suppression and nutritional support — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control. A ferritin, vitamin D, and thyroid workup is still worthwhile to rule out a reversible nutritional cause compounding the diffuse pattern.")
                              : _hasFinasteride
                                ? (data.stage === 'n/a (female)'
                                    ? "Finasteride in your female-pattern routine provides systemic DHT suppression for scalp health — build the local layer with a supplement stack (biotin, zinc, vitamin D) and a DHT-blocking shampoo 3× weekly. A ferritin, thyroid, and hormone panel is the highest-ROI investigation: a reversible hormonal cause is common in women and treating it significantly improves scalp-health outcomes."
                                    : "Finasteride provides systemic DHT suppression for diffuse scalp health — build the local anti-miniaturization layer with a supplement stack (biotin, zinc, vitamin D), a DHT-blocking shampoo 3× weekly, and a ferritin, vitamin D, and thyroid workup. A reversible nutritional cause is common with diffuse loss and addressing it alongside finasteride gives the strongest combined response.")
                              : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                ? (data.stage === 'n/a (female)'
                                    ? "Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for female-pattern scalp health — leave DHT shampoo on 3-5 minutes per wash 3× weekly, apply minoxidil across the full scalp top twice daily, and keep your supplement routine consistent. A ferritin, thyroid, and hormone panel is the highest-ROI next step: a reversible hormonal cause is common in women and treating it gives your full three-layer stack the strongest environment to work."
                                    : "Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for diffuse scalp health — leave DHT shampoo on 3-5 minutes per wash 3× weekly, apply minoxidil across the full scalp top twice daily, and keep your supplement routine consistent. A ferritin, vitamin D, and thyroid workup is the highest-ROI next step: a reversible nutritional cause is common with diffuse thinning and treating it alongside your three-layer stack accelerates improvement significantly.")
                              : _hasSupplements && _hasDHTShampoo
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern thinning with supplements and DHT shampoo in place is well-protected — the highest-ROI next step is a ferritin, thyroid, and hormone panel. These are the most common reversible causes in women and identifying one can reverse scalp-top thinning that topicals alone cannot fix."
                                    : "Diffuse thinning with supplements and DHT shampoo in your routine is well-covered preventively — the highest-ROI next step is checking ferritin, vitamin D, and thyroid levels. A reversible nutritional or hormonal cause is common with diffuse loss, and topicals alone won't fix it.")
                              : _hasSupplements && _hasMassage
                                ? (_hasLLLT
                                    ? (data.stage === 'n/a (female)'
                                        ? "Female-pattern thinning with a supplement stack and LLLT device covers nutritional support and photobiomodulation across the scalp top — add a DHT-blocking shampoo 3× weekly as the missing topical DHT-suppression layer. A ferritin, thyroid, and hormone panel is the highest-ROI investigation: a reversible hormonal cause is common in women and identifying it gives your current stack the strongest environment to work."
                                        : "Diffuse thinning with a supplement stack and LLLT device covers nutritional support and photobiomodulation — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. A ferritin, vitamin D, and thyroid workup is the highest-ROI investigation; a reversible nutritional or hormonal cause is common with diffuse loss, and targeting it alongside your current stack gives the strongest combined response.")
                                    : _hasMicroneedling
                                    ? (data.stage === 'n/a (female)'
                                        ? "Female-pattern thinning with a supplement stack and microneedling covers nutritional support and scalp priming — use microneedling 24-48 hours before topical application to maximize absorption. Add a DHT-blocking shampoo 3× weekly as the missing topical DHT-suppression layer; a ferritin, thyroid, and hormone panel is the highest-ROI investigation alongside your current stack."
                                        : "Diffuse thinning with a supplement stack and microneedling covers nutritional support and scalp priming — use microneedling 24-48 hours before topical application to maximize absorption. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; a ferritin, vitamin D, and thyroid workup is the highest-ROI investigation alongside your current stack.")
                                    : (data.stage === 'n/a (female)'
                                        ? "Female-pattern thinning with a supplement stack and scalp massage covers nutritional support and mechanical stimulation — add a DHT-blocking shampoo 3× weekly as the missing topical DHT-suppression layer. A ferritin, thyroid, and hormone panel is the highest-ROI investigation; finding a reversible root cause gives your entire stack the strongest environment to work."
                                        : "Diffuse thinning with a supplement stack and scalp massage covers nutritional support and mechanical stimulation — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. A ferritin, vitamin D, and thyroid workup is the highest-ROI investigation; a reversible nutritional or hormonal cause is common with diffuse loss and targeting it alongside topicals gives the strongest response."))
                              : _hasSupplements && _hasMinoxidil
                                ? (data.stage === 'n/a (female)'
                                    ? "Your supplement stack and minoxidil cover nutritional follicle support and topical growth stimulation for female-pattern scalp health — apply minoxidil across the full scalp top twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach for female-pattern scalp health. A ferritin, thyroid, and hormone panel is the highest-ROI next step: a reversible hormonal cause is common in women and treating it gives your protocol the strongest environment to work."
                                    : "Your supplement stack and minoxidil cover nutritional follicle support and topical growth stimulation for diffuse scalp health — apply minoxidil across the full scalp top twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach for diffuse scalp health. Also investigate ferritin, vitamin D, and thyroid: a reversible nutritional cause is common with diffuse loss and treating it accelerates improvement beyond what topicals alone achieve.")
                              : _hasSupplements
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern thinning responds well when nutritional causes are ruled out — add a DHT-blocking shampoo 3× weekly and prioritize a ferritin, thyroid, and hormone workup. Your supplement stack supports follicle health; finding a reversible root cause gives topicals the best environment to work."
                                    : "Diffuse thinning often has a nutritional or hormonal root cause — add a DHT-blocking shampoo 3× weekly and consider a ferritin, vitamin D, and thyroid workup. Your supplement stack is a good start; targeting the underlying cause alongside it gives the strongest response.")
                              : _hasDHTShampoo && _hasMassage
                                ? (_hasLLLT
                                    ? (data.stage === 'n/a (female)'
                                        ? "Female-pattern thinning with DHT-blocking shampoo and LLLT covers topical DHT suppression and photobiomodulation — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer. A ferritin, thyroid, and hormone panel is the highest-ROI investigation: a reversible hormonal cause is common in women and identifying it amplifies the impact of every layer in your stack."
                                        : "Diffuse thinning with DHT-blocking shampoo and LLLT covers topical DHT suppression and photobiomodulation — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer. A ferritin, vitamin D, and thyroid workup is the highest-ROI investigation; a reversible nutritional or hormonal cause is common with diffuse loss and treating it amplifies the impact of your current two-layer stack.")
                                    : _hasMicroneedling
                                    ? (data.stage === 'n/a (female)'
                                        ? "Female-pattern thinning with DHT-blocking shampoo and microneedling covers topical DHT suppression and scalp priming — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer; a ferritin, thyroid, and hormone panel is the highest-ROI investigation alongside your current stack."
                                        : "Diffuse thinning with DHT-blocking shampoo and microneedling covers topical DHT suppression and scalp priming — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer; a ferritin, vitamin D, and thyroid workup is the highest-ROI investigation alongside your current stack.")
                                    : (data.stage === 'n/a (female)'
                                        ? "Female-pattern thinning with DHT-blocking shampoo and scalp massage covers topical DHT suppression and mechanical stimulation — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer. A ferritin, thyroid, and hormone panel is the highest-ROI investigation: a reversible hormonal cause is common in women and identifying it gives every layer in your stack a stronger environment to work."
                                        : "Diffuse thinning with DHT-blocking shampoo and scalp massage covers topical DHT suppression and mechanical stimulation — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer. A ferritin, vitamin D, and thyroid workup is the highest-ROI investigation; a reversible nutritional or hormonal cause is common with diffuse loss and treating it alongside your current stack gives the strongest combined response."))
                              : _hasDHTShampoo
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern thinning with DHT-blocking shampoo in place covers topical DHT control — add a supplement stack (biotin, zinc, vitamin D) for nutritional follicle support. A ferritin, thyroid, and hormone panel is the highest-ROI investigation: a reversible hormonal cause is common in women and identifying it can reverse thinning that topicals alone cannot fix."
                                    : "Diffuse thinning with DHT-blocking shampoo in place covers topical DHT control — add a supplement stack (biotin, zinc, vitamin D) for nutritional support and consider a ferritin, vitamin D, and thyroid workup. A reversible nutritional or hormonal cause is common with diffuse loss, and addressing it alongside your DHT shampoo gives a stronger combined response than topicals alone.")
                              : (data.stage === 'n/a (female)'
                                  ? "Female-pattern scalp-top thinning is often nutritional or hormonal — switch to a gentle sulfate-free shampoo, start a supplement stack (biotin, zinc, vitamin D), and consider checking ferritin, thyroid, and hormones. Identifying and treating a reversible cause can reverse thinning that topicals alone can't fix."
                                  : "Diffuse thinning has a higher chance of a reversible nutritional or hormonal cause — switch to a gentle sulfate-free shampoo, start a supplement stack (biotin, zinc, vitamin D), and consider checking ferritin, thyroid, and iron. Reducing scalp inflammation while investigating the cause is the highest-ROI step."))
                          : (_hasSupplements && _hasDHTShampoo)
                              ? 'Supplements and DHT-blocking shampoo are both active — target sleep quality this week: aim for 7-8 hours. Elevated cortisol from poor sleep accelerates miniaturization beyond what topicals can offset.'
                              : _hasSupplements
                                ? 'Continue your supplement routine — focus this week on scalp hygiene: reduce washing to 3-4× weekly, switch to a sulfate-free shampoo, and watch for scalp tension signs.'
                                : 'Skip sulfate shampoos this week, use a gentle scalp exfoliant mid-week, and increase water intake — scalp condition responds fast to hydration and less irritation.',
          Potential: _isNW7
            ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                ? 'At NW7, your finasteride + minoxidil + DHT-blocking shampoo provides systemic DHT suppression, topical growth signal, and local DHT control for the remaining fringe — keep all three consistent without gaps. Your highest-ROI next step is a transplant or SMP consultation; finasteride and minoxidil are often continued post-transplant to protect native hair alongside new grafts. Research experienced surgeons or SMP artists this week.'
                : _hasFinasteride && _hasDHTShampoo
                ? 'At NW7, your finasteride + DHT-blocking shampoo adds meaningful non-surgical value by protecting the remaining fringe from further miniaturization — keep both consistent. Your highest-ROI step is a transplant or SMP consultation; finasteride is often continued post-transplant to protect native hair alongside new grafts, and your DHT shampoo complements this systemic coverage. Research experienced surgeons or SMP artists this week.'
                : _hasFinasteride && _hasMinoxidil
                ? 'At NW7, your finasteride + minoxidil provides systemic DHT suppression and a topical growth signal for the remaining horseshoe fringe — keep both consistent without gaps. Your highest-ROI step is a transplant or SMP consultation; both finasteride and minoxidil are often continued post-transplant to protect native hair and support graft health. Research experienced surgeons or SMP artists this week.'
                : _hasFinasteride
                ? 'At NW7, your finasteride adds meaningful value by protecting the remaining fringe from further miniaturization — keep it consistent. Your highest-ROI step is a transplant or SMP consultation; finasteride is often continued post-transplant to protect native hair alongside new grafts. Research experienced surgeons or SMP artists this week.'
                : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                ? 'At NW7, your supplement stack, minoxidil, and DHT-blocking shampoo combine nutritional support, topical growth signal, and local DHT suppression for the remaining horseshoe fringe — apply minoxidil to the fringe and lateral edges twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement stack consistent. Your highest-ROI next step is a transplant or SMP consultation; your three-layer OTC protocol supports fringe follicle health and complements a surgical plan by protecting native hair around new grafts. Research experienced surgeons or SMP artists this week.'
                : _hasMinoxidil && _hasDHTShampoo
                ? 'Your minoxidil + DHT-blocking shampoo provides a topical growth signal and local DHT suppression for the remaining fringe at NW7 — keep both consistent. Your highest-ROI step is a transplant or SMP consultation; minoxidil is often continued post-transplant to protect native hair around new grafts. Research experienced surgeons or SMP artists this week.'
                : _hasMinoxidil && _hasMassage
                ? (_hasLLLT
                    ? 'At NW7, your minoxidil and LLLT device cover topical growth signal and photobiomodulation for the remaining horseshoe fringe — apply minoxidil immediately after your LLLT session while scalp circulation is elevated. Your highest-ROI next step is a transplant or SMP consultation; minoxidil and LLLT are commonly continued post-transplant to protect native fringe hair. Research experienced surgeons or SMP artists this week.'
                    : _hasMicroneedling
                    ? 'At NW7, your minoxidil and microneedling cover topical growth signal and scalp priming for the remaining horseshoe fringe — wait 24-48 hours after each microneedling session before applying minoxidil along the fringe (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Your highest-ROI next step is a transplant or SMP consultation; minoxidil is commonly continued post-transplant to protect native fringe hair around new grafts. Research experienced surgeons or SMP artists this week.'
                    : 'At NW7, your minoxidil and scalp massage provide topical growth signal and mechanical stimulation for the remaining horseshoe fringe — apply minoxidil immediately after your massage while scalp circulation is elevated. Your highest-ROI next step is a transplant or SMP consultation; minoxidil is commonly continued post-transplant to protect native fringe hair around new grafts. Research experienced surgeons or SMP artists this week.')
                : _hasSupplements && _hasDHTShampoo
                ? 'Your supplement stack and DHT-blocking shampoo support fringe follicle health through nutritional and topical DHT-suppression layers at NW7 — keep both consistent. Your highest-ROI next step is a transplant or SMP consultation; OTC treatments alone are unlikely to create meaningful new coverage at this stage, but your dual-layer protocol complements a surgical plan by supporting fringe follicle health and protecting native hair around new grafts. Research experienced surgeons or SMP artists this week.'
                : _hasDHTShampoo
                ? 'Your DHT-blocking shampoo helps slow further miniaturization of remaining fringe at NW7 — keep using it 3× weekly. Your highest-ROI step is a transplant or SMP consultation; OTC treatments alone are unlikely to create meaningful new coverage at this stage, but your shampoo can complement a surgical plan by protecting native hair around new grafts. Research experienced surgeons or SMP artists this week.'
                : _hasSupplements && _hasMinoxidil
                ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for the remaining horseshoe fringe at NW7 — apply minoxidil consistently to the fringe and lateral edges and keep your supplement routine consistent. Your highest-ROI next step is a transplant or SMP consultation; supplements + minoxidil complements a surgical plan by supporting fringe follicle health and graft health around new grafts. Research experienced surgeons or SMP artists this week.'
                : _hasMinoxidil
                ? 'Your minoxidil provides a topical growth signal for the remaining horseshoe fringe at NW7 — keep applying it consistently. Your highest-ROI step is a transplant or SMP consultation; minoxidil is often continued post-transplant to protect native hair and support graft health. OTC alone is unlikely to create meaningful new coverage at NW7, but continuing it alongside a surgical plan protects what fringe remains. Research experienced surgeons or SMP artists this week.'
                : _hasSupplements && _hasMassage
                ? (_hasLLLT
                    ? 'At NW7, your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation for the remaining horseshoe fringe — keep your supplement routine consistent and your LLLT sessions on schedule. Apply any topicals immediately after your LLLT session while scalp circulation is elevated; adding minoxidil to the fringe and lateral edges twice daily is the highest-ROI OTC next step. Your highest-ROI next step is a transplant or SMP consultation; LLLT is commonly continued post-transplant to protect native fringe hair and support graft health. Research experienced surgeons or SMP artists this week.'
                    : _hasMicroneedling
                    ? 'At NW7, your supplement stack and microneedling cover nutritional follicle support and scalp priming for the remaining horseshoe fringe — keep your supplement routine consistent and use microneedling 24-48 hours before any topical application along the fringe to prime absorption. Adding minoxidil to the fringe and lateral edges twice daily on non-needling days is the highest-ROI OTC next step; your nutritional and scalp-priming protocol complements a surgical plan by supporting fringe follicle viability. Your highest-ROI next step is a transplant or SMP consultation. Research experienced surgeons or SMP artists this week.'
                    : 'At NW7, your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation for the remaining horseshoe fringe — keep your supplement routine consistent and massage along the fringe and lateral edges daily. Adding minoxidil to the fringe and lateral edges twice daily immediately after each massage is the highest-ROI OTC next step while scalp circulation is elevated. Your highest-ROI next step is a transplant or SMP consultation; OTC treatments alone are unlikely to create meaningful new coverage at NW7, but your nutritional and mechanical protocol complements a surgical plan by protecting fringe follicle health. Research experienced surgeons or SMP artists this week.')
                : _hasSupplements
                ? 'Your supplement stack (biotin, zinc, vitamin D) supports the nutritional health of the remaining horseshoe fringe at NW7 — keep biotin, zinc, and vitamin D consistent as a foundation. Your highest-ROI next step is a transplant or SMP consultation; OTC supplementation alone is unlikely to create meaningful new coverage at this stage, but your nutritional protocol supports fringe follicle health alongside a surgical plan. Research experienced surgeons or SMP artists this week.'
                : 'Your highest-ROI step is a transplant or SMP consultation — OTC treatments alone are unlikely to create meaningful change at NW7. Research experienced surgeons or SMP artists this week.')
            : _isNW5only
              ? (_hasFinasteride && _hasMinoxidil && _hasMassage && _hasDHTShampoo
                  ? (_hasLLLT
                      ? 'NW5 with finasteride + minoxidil + LLLT + DHT shampoo is the most complete non-surgical protocol — apply minoxidil immediately after your LLLT session while scalp circulation is elevated across both frontal and crown zones, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. Realistic potential is toward the upper end of the NW5 range (35-48%); set a 3-month checkpoint with overhead and front-facing photos and research transplant consultations in parallel to plan the full combined strategy.'
                      : _hasMicroneedling
                      ? 'NW5 with finasteride + minoxidil + microneedling + DHT shampoo is the most complete non-surgical protocol — wait 24-48 hours after each microneedling session before applying minoxidil across both frontal and crown zones (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. Realistic potential is toward the upper end of the NW5 range (35-48%); set a 3-month checkpoint with overhead and front-facing photos and research transplant consultations in parallel.'
                      : 'NW5 with finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical protocol — realistic potential is toward the upper end of the NW5 range (35-48%). Set a 3-month checkpoint with overhead and front-facing photos; in parallel, research transplant consultations to plan the full strategy combining systemic treatment with potential surgical options.')
                  : _hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                    ? 'NW5 with finasteride + minoxidil + DHT shampoo gives strong systemic and topical coverage — add weekly microneedling to prime follicle absorption and push toward the upper NW5 potential range. Set a 3-month checkpoint and consider booking a transplant consultation in parallel.'
                    : _hasFinasteride && _hasMinoxidil
                      ? 'NW5 with finasteride + minoxidil has the two most evidence-backed tools active — add a DHT-blocking shampoo 3× weekly and weekly microneedling to complete the stack. The combined protocol gives the strongest realistic NW5 response; set a 3-month checkpoint and book a transplant consultation to plan full coverage options.'
                      : _hasFinasteride && _hasDHTShampoo
                        ? 'At NW5, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression across both frontal and crown thinning zones — take finasteride at the same time each day and leave DHT shampoo on 3-5 minutes per wash 3× weekly. Add minoxidil across the entire scalp top twice daily to complete the triple stack; finasteride + minoxidil + DHT shampoo is the strongest non-surgical NW5 protocol (realistic potential: 28-48%). Set a 3-month checkpoint with overhead and front-facing photos and consider booking a transplant consultation in parallel to plan surgical and OTC paths together.'
                      : _hasFinasteride
                        ? 'NW5 with finasteride providing systemic DHT suppression has a meaningful head start — add minoxidil across the entire scalp top twice daily, DHT-blocking shampoo 3× weekly, and weekly microneedling to maximize topical response alongside your systemic Rx. Set a 3-month checkpoint and book a transplant consultation in parallel to plan your full strategy.'
                        : _hasMinoxidil && _hasMassage && _hasDHTShampoo
                            ? (_hasLLLT
                                ? 'At NW5, your OTC stack with LLLT is fully deployed — apply minoxidil immediately after your LLLT session while scalp circulation is elevated across both frontal and crown zones, and leave DHT shampoo on 3-5 minutes per wash. Realistic potential is 28-48%; set a 3-month checkpoint with overhead and front-facing photos and research transplant consultations in parallel.'
                                : _hasMicroneedling
                                ? 'At NW5, your OTC stack with microneedling is fully deployed — wait 24-48 hours after each microneedling session before applying minoxidil across both frontal and crown zones (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal and leave DHT shampoo on 3-5 minutes per wash. Realistic potential is 28-48%; set a 3-month checkpoint with overhead and front-facing photos and research transplant consultations in parallel.'
                                : 'At NW5, your OTC stack is fully deployed — realistic potential is 28-48%. Set a 3-month checkpoint with overhead and front-facing photos; if meaningful stabilization shows, continue the stack. In parallel, research transplant consultations: at NW5, combining OTC maintenance with surgical planning gives the most complete long-term strategy.')
                            : _hasMinoxidil && _hasDHTShampoo
                              ? 'At NW5, add weekly microneedling to your topical and DHT shampoo stack — it is the highest-ROI addition for maximizing response from remaining follicles. Set a 3-month checkpoint and consider booking a transplant consultation in parallel to plan your full strategy.'
                              : _hasMinoxidil && _hasMassage
                                ? (_hasLLLT
                                    ? 'NW5 potential with minoxidil and LLLT covers the topical growth signal and photobiomodulation across both frontal and crown zones — apply minoxidil immediately after your LLLT session while scalp circulation is elevated so freshly primed follicles absorb it. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression; the three-layer OTC stack gives the strongest realistic non-surgical potential at NW5 (28-48%). Set a 3-month checkpoint and consider booking a transplant consultation to plan surgical and OTC paths in parallel.'
                                    : _hasMicroneedling
                                    ? 'NW5 potential with minoxidil and microneedling covers the topical growth signal and scalp priming across both frontal and crown zones — wait 24-48 hours after each microneedling session before applying minoxidil to avoid follicle irritation; on non-needling days apply across both thinning fronts twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression; the three-layer OTC stack gives the strongest realistic non-surgical potential at NW5 (28-48%). Set a 3-month checkpoint and consider booking a transplant consultation to plan surgical and OTC paths in parallel.'
                                    : 'NW5 potential with minoxidil and scalp massage covers the topical growth signal and mechanical stimulation across both frontal and crown zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression. The three-layer OTC stack gives the strongest realistic non-surgical potential at NW5 (28-48%); set a 3-month checkpoint and consider booking a transplant consultation to plan surgical and OTC paths in parallel.')
                                : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                  ? 'Your supplement stack, minoxidil, and DHT-blocking shampoo deliver the complete OTC three-layer approach at NW5 — nutritional follicle support, topical growth signal, and local DHT suppression across both frontal and crown thinning zones. Apply minoxidil across the entire scalp top twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. This triple-layer stack is the strongest non-surgical OTC approach at this advanced stage (realistic potential: 28-48%); set a 3-month checkpoint with overhead and front-facing photos and consider booking a transplant consultation in parallel to plan surgical and OTC paths together.'
                                : _hasSupplements && _hasMinoxidil
                                  ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at NW5 where both frontal and crown zones are thinning — apply minoxidil across the entire scalp top twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach at this advanced stage (realistic potential: 28-48%). Set a 3-month checkpoint with overhead and front-facing photos and consider booking a transplant consultation in parallel to plan surgical and OTC paths together.'
                                : _hasMinoxidil
                                  ? 'NW5 potential with OTC additions is still meaningful — pair your minoxidil with a DHT-blocking shampoo 3× weekly and weekly microneedling. This triple approach gives the strongest OTC response at this stage. Set a 3-month checkpoint, and consider booking a transplant consultation to evaluate surgical and OTC paths in parallel.'
                                  : _hasSupplements && _hasDHTShampoo
                                    ? 'Your supplement stack and DHT-blocking shampoo are both active at NW5 — nutritional support and topical DHT suppression across both frontal and crown thinning zones. Add minoxidil across the entire scalp top twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil gives the strongest OTC triple-layer approach at this advanced stage (realistic potential: 28-48%). Set a 3-month checkpoint with overhead and front-facing photos and consider booking a transplant consultation in parallel to plan surgical and OTC paths together.'
                                    : _hasDHTShampoo
                                    ? 'Your DHT-blocking shampoo provides topical DHT suppression at NW5 where loss spans both frontal and crown zones — add minoxidil across the entire scalp top twice daily as the topical growth signal. DHT shampoo + minoxidil gives the strongest OTC dual-mechanism approach (realistic potential: 28-48%); add weekly microneedling to prime follicle absorption across both thinning zones. Set a 3-month checkpoint with overhead and front-facing photos today as your baseline and consider booking a transplant consultation in parallel to plan a combined OTC + surgical strategy.'
                                    : _hasSupplements && _hasMassage
                                    ? (_hasLLLT
                                        ? 'Your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation at NW5 where loss spans both frontal and crown zones — apply minoxidil immediately after your LLLT session while scalp circulation is elevated across the full scalp top. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; three complementary layers (nutritional + photobiomodulation + topical DHT suppression) give the strongest non-Rx OTC approach at this advanced stage (realistic potential: 28-48%). Set a 3-month checkpoint with overhead and front-facing photos and consider booking a transplant consultation in parallel to plan a combined OTC + surgical strategy.'
                                        : _hasMicroneedling
                                        ? 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming at NW5 where loss spans both frontal and crown zones — use microneedling 24-48 hours before topical application across the full scalp top to maximize absorption where miniaturization is most advanced. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + topical DHT suppression) give the strongest non-Rx OTC approach at this advanced stage (realistic potential: 28-48%). Set a 3-month checkpoint with overhead and front-facing photos and consider booking a transplant consultation in parallel to plan a combined OTC + surgical strategy.'
                                        : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at NW5 where loss spans both frontal and crown zones — keep your daily 4-minute massage covering the full scalp top to maintain circulation where miniaturization is most advanced. The highest-ROI additions at this stage are minoxidil across the entire scalp top twice daily and a DHT-blocking shampoo 3× weekly; adding both topical layers while follicles remain viable gives the strongest OTC potential at NW5 (realistic potential: 28-48%). Set a 3-month checkpoint with overhead and front-facing photos and consider booking a transplant consultation in parallel to plan a combined OTC + surgical strategy.')
                                    : _hasSupplements
                                    ? 'Your supplement stack (biotin, zinc, vitamin D) supports follicle health at NW5 where potential (28-48%) is still meaningful with consistent treatment — nutritional support is a solid foundation alongside topical layers. The highest-ROI additions at this stage are minoxidil across the entire scalp top twice daily and a DHT-blocking shampoo 3× weekly; starting both while follicles remain viable gives the strongest OTC potential at NW5. Set a 3-month checkpoint with overhead and front-facing photos and consider booking a transplant consultation in parallel to plan a combined OTC + surgical strategy.'
                                    : 'NW5 still has potential (28-48%) with a consistent OTC protocol — start the full stack this week: minoxidil across the entire scalp top twice daily, DHT-blocking shampoo 3× weekly, and weekly microneedling. OTC slows progression and buys time; simultaneously, consider booking a transplant consultation to plan your full-picture strategy.')
              : _isNW56
              // only NW6 reaches here — NW5 is handled by _isNW5only above
              ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                  ? 'At NW6, finasteride + minoxidil + DHT-blocking shampoo delivers systemic DHT suppression, topical growth signal, and local DHT control across the remaining fringe — apply minoxidil to the fringe and lateral edges twice daily and leave the DHT shampoo on 3-5 minutes per wash. Add weekly microneedling over the fringe zones to prime remaining follicle response (realistic potential: 15-32%). Set a 3-month checkpoint and prioritize booking a transplant consultation this quarter — your protocol covers every non-surgical layer and surgical planning is the most complete next step.'
                  : _hasFinasteride && _hasMinoxidil
                  ? 'At NW6 with finasteride + minoxidil, your protocol is well-optimized for non-surgical potential — realistic improvement is modest (15-32%), focused on slowing progression and protecting existing fringe. Set a 3-month checkpoint with overhead and front-facing photos, and prioritize booking a transplant consultation this quarter to plan surgical coverage alongside your OTC maintenance.'
                  : _hasFinasteride && _hasDHTShampoo
                  ? 'At NW6, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression for the remaining fringe and lateral edges — take finasteride at the same time each day and leave DHT shampoo on 3-5 minutes per wash 3× weekly. Add minoxidil to the fringe and lateral edges twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the strongest non-surgical fringe protocol (realistic potential: 15-32%). Set a 3-month checkpoint with overhead photos and prioritize booking a transplant consultation this quarter to plan surgical coverage alongside your protocol.'
                  : _hasFinasteride
                    ? 'Finasteride provides a systemic DHT advantage at NW6 — add minoxidil (twice daily, full top) and weekly microneedling to maximize non-surgical potential (realistic range: 15-32%). Set a 3-month checkpoint and book a transplant consultation in parallel to plan your complete coverage strategy.'
                    : _hasMinoxidil && _hasDHTShampoo && _hasMassage
                      ? (_hasLLLT
                          ? 'At NW6, your minoxidil, DHT-blocking shampoo, and LLLT device cover topical growth signal, local DHT suppression, and photobiomodulation across the remaining fringe — apply minoxidil immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes per wash. This is the strongest OTC triple stack at this stage (realistic potential: 15-32%); set a 3-month checkpoint and consider booking a transplant consultation this quarter.'
                          : _hasMicroneedling
                          ? 'At NW6, your minoxidil, DHT-blocking shampoo, and microneedling cover topical growth signal, local DHT suppression, and scalp priming across the remaining fringe — wait 24-48 hours after each microneedling session before applying minoxidil along the fringe (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal and leave DHT shampoo on 3-5 minutes per wash. This is the strongest OTC triple stack at this stage (realistic potential: 15-32%); set a 3-month checkpoint and consider booking a transplant consultation this quarter.'
                          : 'At NW6, your minoxidil, DHT-blocking shampoo, and scalp massage cover topical growth signal, local DHT suppression, and mechanical stimulation across the remaining fringe — the strongest OTC triple stack at this stage. Apply minoxidil immediately after your scalp massage and leave DHT shampoo on 3-5 minutes per wash; add weekly microneedling to prime remaining follicle response (realistic potential: 15-32%). Set a 3-month checkpoint and consider booking a transplant consultation this quarter — combining this OTC stack with surgical planning is the most complete long-term strategy.')
                      : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                        ? 'Your supplement stack, minoxidil, and DHT-blocking shampoo deliver the strongest OTC three-layer approach for fringe maintenance at NW6 — nutritional follicle support, topical growth signal, and local DHT suppression all active (realistic potential: 15-32%). Apply minoxidil to the fringe and lateral edges twice daily, leave DHT shampoo on 3-5 minutes per wash, and keep your supplement routine consistent. Add weekly microneedling over the fringe zones to prime remaining follicle response; set a 3-month checkpoint and prioritize booking a transplant consultation this quarter — combining this OTC stack with surgical planning is the most complete long-term strategy.'
                      : _hasMinoxidil && _hasDHTShampoo
                        ? 'At NW6, your minoxidil and DHT-blocking shampoo cover topical growth signal and local DHT suppression across the remaining fringe — apply minoxidil to the fringe and lateral edges twice daily and leave DHT shampoo on 3-5 minutes per wash. Add a 4-minute scalp massage before each application and weekly microneedling to complete the OTC stack (realistic potential: 15-32%). Set a 3-month checkpoint and consider booking a transplant consultation this quarter — combining OTC maintenance with surgical planning is the most complete long-term strategy.'
                        : _hasMinoxidil && _hasMassage
                          ? (_hasLLLT
                              ? 'At NW6, your minoxidil and LLLT device cover topical growth signal and photobiomodulation across the remaining fringe — apply minoxidil immediately after your LLLT session while scalp circulation is elevated. Add a DHT-blocking shampoo 3× weekly to complete the OTC stack for the strongest realistic non-surgical potential (15-32%). Set a 3-month checkpoint and consider booking a transplant consultation this quarter — combining OTC maintenance with surgical planning is the most complete long-term strategy.'
                              : _hasMicroneedling
                              ? 'At NW6, your minoxidil and microneedling cover topical growth signal and scalp priming across the remaining fringe — wait 24-48 hours after each microneedling session before applying minoxidil along the fringe and lateral edges (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly to complete the OTC stack for the strongest realistic non-surgical potential (15-32%). Set a 3-month checkpoint and consider booking a transplant consultation this quarter — combining OTC maintenance with surgical planning is the most complete long-term strategy.'
                              : 'At NW6, your minoxidil and scalp massage address topical growth signal and mechanical stimulation across the remaining fringe — add a DHT-blocking shampoo 3× weekly to complete the OTC stack for the strongest realistic non-surgical potential (15-32%). Set a 3-month checkpoint and consider booking a transplant consultation this quarter — combining OTC maintenance with surgical planning is the most complete long-term strategy.')
                          : _hasSupplements && _hasMinoxidil
                            ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal for the remaining fringe at NW6 — apply minoxidil to the fringe and lateral edges twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach for fringe maintenance at this stage (realistic potential: 15-32%). Set a 3-month checkpoint with overhead photos and prioritize booking a transplant consultation this quarter to plan surgical coverage alongside your protocol.'
                          : _hasMinoxidil
                            ? 'At NW6, add weekly microneedling and a DHT-blocking shampoo to your minoxidil to give the best realistic shot at slowing progression (15-32% potential). Set a 3-month checkpoint and consider booking a transplant consultation this quarter — combining OTC maintenance with surgical planning is the most complete long-term strategy.'
                            : _hasSupplements && _hasDHTShampoo
                              ? 'Your supplement stack and DHT-blocking shampoo support fringe follicle health through nutritional and topical DHT-suppression layers at NW6 — keep both consistent. Add minoxidil to the fringe and lateral edges twice daily as the topical growth signal; the triple combination gives the strongest realistic OTC approach for fringe maintenance at this stage (realistic potential: 15-32%). Set a 3-month checkpoint with overhead photos and prioritize booking a transplant consultation this quarter to plan surgical coverage alongside your protocol.'
                              : _hasDHTShampoo
                              ? 'Your DHT-blocking shampoo helps slow fringe miniaturization at NW6 — add minoxidil to the fringe and lateral edges twice daily for the topical growth signal. DHT shampoo + minoxidil is the strongest OTC combination at this stage (realistic potential: 15-32%); add weekly microneedling over the fringe zones to prime remaining follicle response. Set a 3-month checkpoint with overhead photos today as your baseline and consider booking a transplant consultation this quarter to plan surgical coverage alongside your OTC maintenance.'
                              : _hasSupplements && _hasMassage
                              ? (_hasLLLT
                                  ? 'Your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation for remaining fringe follicles at NW6 — apply any topicals to the fringe and lateral edges immediately after your LLLT session while scalp circulation is elevated. The highest-ROI additions at this stage are minoxidil to the fringe and lateral edges twice daily and a DHT-blocking shampoo 3× weekly; timing both topical layers after LLLT while fringe follicles remain viable gives the strongest OTC approach for fringe maintenance at NW6 (realistic potential: 15-32%). Set a 3-month checkpoint with overhead photos and consider booking a transplant consultation this quarter — combining OTC maintenance with surgical planning is the most complete long-term strategy.'
                                  : _hasMicroneedling
                                  ? 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming for remaining fringe follicles at NW6 — use microneedling 24-48 hours before topical application targeting the fringe and lateral edges to maximize absorption where fringe follicles remain viable. The highest-ROI additions at this stage are minoxidil to the fringe and lateral edges twice daily and a DHT-blocking shampoo 3× weekly; adding both topical layers while fringe follicles remain viable gives the strongest OTC approach for fringe maintenance at NW6 (realistic potential: 15-32%). Set a 3-month checkpoint with overhead photos and consider booking a transplant consultation this quarter — combining OTC maintenance with surgical planning is the most complete long-term strategy.'
                                  : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation for remaining fringe follicles at NW6 — keep your daily massage targeting the fringe and lateral edges and your supplement routine consistent. The highest-ROI additions at this stage are minoxidil to the fringe and lateral edges twice daily and a DHT-blocking shampoo 3× weekly; adding both topical layers while fringe follicles remain viable gives the strongest OTC approach for fringe maintenance at NW6 (realistic potential: 15-32%). Set a 3-month checkpoint with overhead photos and consider booking a transplant consultation this quarter — combining OTC maintenance with surgical planning is the most complete long-term strategy.')
                              : _hasSupplements
                              ? 'Your supplement stack (biotin, zinc, vitamin D) supports nutritional follicle health at NW6 where realistic potential is 15-32% focused on fringe maintenance — nutritional support complements any OTC treatment you add. The highest-ROI next step is minoxidil applied to the fringe and lateral edges twice daily, paired with a DHT-blocking shampoo 3× weekly as the strongest dual-mechanism OTC approach for fringe maintenance at this stage. Set a 3-month checkpoint with overhead photos and consider booking a transplant consultation to plan surgical coverage alongside your protocol.'
                              : 'At your stage, combining minoxidil with weekly microneedling and a DHT-blocking shampoo gives the best realistic shot at slowing progression — set a 3-month checkpoint to assess response.')
              : data.stage === 'NW1'
                ? (_hasFinasteride && _hasDHTShampoo && _hasSupplements
                    ? 'Your NW1 prevention protocol is as complete as it gets — finasteride + DHT shampoo + supplements covers all three anti-miniaturization layers. Maximize long-term potential through lifestyle: prioritize 7-8 hours of sleep and manage chronic stress. Cortisol accelerates miniaturization even before visible thinning begins, and no supplement can offset poor recovery.'
                    : _hasFinasteride && _hasDHTShampoo
                      ? 'Finasteride + DHT-blocking shampoo gives dual-level DHT prevention at NW1 — add a supplement stack (biotin, zinc, vitamin D) to complete the protocol. All three together form the most comprehensive NW1 potential protection available.'
                      : _hasFinasteride
                        ? 'Finasteride is your strongest potential protection at NW1 — add a DHT-blocking shampoo 3× weekly and a supplement stack (biotin, zinc, vitamin D). This complete three-layer protocol maximizes long-term follicle viability while your hairline is fully intact.'
                        : _hasDHTShampoo && _hasSupplements
                          ? 'Your preventive stack is solid — the highest-ROI next step is lifestyle: prioritize 7-8 hours of sleep and reduce chronic stress this week. Elevated cortisol accelerates follicle miniaturization even before visible thinning begins, and no supplement can offset poor recovery.'
                          : _hasDHTShampoo
                            ? 'Add a basic supplement stack (biotin, zinc, vitamin D) to complement your DHT-blocking shampoo — at NW1 your follicles are fully viable and this pairing forms the strongest long-term prevention layer before any visible loss starts.'
                            : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                              ? 'Your NW1 prevention stack includes supplements, minoxidil, and DHT-blocking shampoo — the most complete non-Rx preventive protocol at this optimal window. Leave DHT shampoo on 3-5 minutes per wash 3× weekly, apply minoxidil consistently, and keep your supplement routine solid. The highest-ROI next step is lifestyle: prioritize 7-8 hours of sleep and manage chronic stress, as cortisol accelerates miniaturization even before visible thinning begins.'
                            : _hasSupplements && _hasMinoxidil
                              ? 'Your NW1 prevention stack includes supplements and minoxidil — nutritional follicle support and general scalp health coverage before any thinning begins. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-prevention third layer; supplements + minoxidil + DHT shampoo forms the most complete non-Rx preventive protocol at NW1 where follicles are fully viable and most responsive before visible loss begins.'
                            : _hasSupplements && _hasMassage
                              ? (_hasLLLT
                                  ? 'Your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation at NW1 — keep your supplement routine consistent and maintain your LLLT sessions on schedule. The highest-ROI next step is adding a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-prevention third layer; supplements + LLLT + DHT shampoo forms the most complete non-Rx preventive protocol at NW1 where follicles are fully viable and most responsive.'
                                  : _hasMicroneedling
                                  ? 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming at NW1 — keep your supplement routine consistent and use microneedling 24-48 hours before any topical application to prime absorption. The highest-ROI next step is adding a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-prevention layer; supplements + microneedling + DHT shampoo forms the most complete non-Rx preventive protocol at NW1 where follicles are fully viable and most responsive.'
                                  : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at NW1 — a strong preventive dual layer before any visible loss begins. Keep your daily scalp massage consistent and your supplement routine solid. The highest-ROI next step is adding a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-prevention layer; supplements + massage + DHT shampoo forms the most complete non-Rx preventive protocol at NW1 where follicles are fully viable and most responsive.')
                            : _hasSupplements
                              ? 'Your supplement stack supports follicle health at NW1 — a strong nutritional foundation. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) to build the topical DHT-prevention layer alongside your supplement routine. Together they form the strongest dual-layer non-Rx preventive protocol at NW1; follicles are fully viable and most responsive before any visible loss begins.'
                              : 'Protect your potential now by starting a DHT-blocking shampoo 3× weekly and a supplement stack (biotin, zinc, vitamin D). At NW1 prevention is far more cost-effective than treatment later — follicles are fully viable and most responsive before visible loss begins.')
                : data.stage === 'NW2'
                  ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                      ? 'NW2 is the ideal preventive window and your finasteride + minoxidil + DHT-blocking shampoo covers every layer — systemic DHT suppression, topical growth signal, and topical DHT control. Keep all three consistent: take finasteride at the same time daily, apply minoxidil to both temple corners twice daily, and leave the DHT shampoo on 3-5 minutes before rinsing. With the full stack in place, consistency is the only variable left.'
                      : _hasFinasteride && _hasMinoxidil
                        ? 'NW2 is the ideal preventive window and your finasteride + minoxidil combination is the strongest possible non-surgical stack at this stage — keep both consistent. Confirm twice-daily minoxidil coverage on both temple corners and take finasteride at the same time each day without gaps for maximum long-term protection.'
                        : _hasFinasteride && _hasDHTShampoo
                          ? 'Finasteride + DHT-blocking shampoo gives dual-level DHT suppression at NW2 — systemic and topical control at the ideal preventive stage. Add minoxidil to both temple corners twice daily to complete the triple stack; the three layers together cover every angle of AGA prevention before recession deepens further.'
                          : _hasFinasteride
                            ? 'NW2 is the ideal window and your finasteride already suppresses DHT systemically — add minoxidil directly to both temple corners twice daily for the complementary topical growth signal. The finasteride + minoxidil combination at NW2 delivers the most impactful prevention before recession deepens.'
                            : (_hasMinoxidil && _hasMassage && _hasDHTShampoo)
                                ? (_hasLLLT
                                    ? 'NW2 is the ideal prevention window and your minoxidil, LLLT, and DHT-blocking shampoo cover the full OTC triple stack — apply minoxidil immediately after your LLLT session while scalp circulation is elevated so freshly primed follicles absorb it, and leave DHT shampoo on 3-5 minutes before rinsing. Consistent triple-layer coverage now maximizes long-term potential before recession deepens.'
                                    : _hasMicroneedling
                                    ? 'NW2 is the ideal prevention window and your minoxidil, microneedling, and DHT-blocking shampoo cover the full OTC triple stack — wait 24-48 hours after each microneedling session before applying minoxidil to the temple corners (applying immediately risks follicle irritation); on non-needling days apply twice daily as normal and leave DHT shampoo on 3-5 minutes before rinsing. Consistent triple-layer coverage now maximizes long-term potential before recession deepens.'
                                    : 'NW2 is the ideal prevention window and your minoxidil, scalp massage, and DHT-blocking shampoo cover the full OTC triple stack — topical growth signal, mechanical stimulation, and topical DHT control. Apply minoxidil immediately after your scalp massage and leave the DHT shampoo on 3-5 minutes before rinsing; consistent triple-layer coverage now maximizes long-term potential before recession deepens.')
                                : (_hasMinoxidil && _hasDHTShampoo)
                                    ? 'Minoxidil and DHT shampoo are both active at NW2 — your stack is right for this stage. Confirm twice-daily coverage on both temple corners and leave the DHT shampoo on 3-5 minutes before rinsing. Consistency beats adding new products at this early stage.'
                                    : (_hasMinoxidil && _hasMassage)
                                      ? (_hasLLLT
                                          ? 'NW2 is the ideal prevention window and your minoxidil and LLLT cover the topical growth signal and photobiomodulation at the temple corners — apply minoxidil immediately after your LLLT session while scalp circulation is elevated so freshly primed follicles absorb it. Add a DHT-blocking shampoo 3× weekly as the DHT-suppression third layer; the triple approach (topical + LLLT + DHT) delivers the strongest long-term potential at this earliest detectable stage.'
                                          : _hasMicroneedling
                                          ? 'NW2 is the ideal prevention window and your minoxidil and microneedling cover the topical growth signal and scalp priming at the temple corners — wait 24-48 hours after each microneedling session before applying minoxidil to both temple corners (applying immediately risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly as the DHT-suppression third layer; the triple approach (topical + microneedling + DHT) delivers the strongest long-term potential at this earliest detectable stage.'
                                          : 'NW2 is the ideal prevention window and your minoxidil and scalp massage cover the topical growth signal and mechanical stimulation at the temple corners — apply minoxidil immediately after your scalp massage so freshly stimulated follicles absorb it. Add a DHT-blocking shampoo 3× weekly as the DHT-suppression third layer; the triple approach (topical + mechanical + DHT) delivers the strongest long-term potential at this earliest detectable stage.')
                                      : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                        ? 'NW2 is the ideal prevention window and your supplement stack, minoxidil, and DHT-blocking shampoo cover the complete OTC triple-layer approach — nutritional follicle support, topical growth signal, and topical DHT control. Apply minoxidil to both temple corners twice daily, leave DHT shampoo on 3-5 minutes before rinsing, and keep your supplement routine consistent. With the full OTC stack in place, consistency is the only variable left; take monthly front-facing photos to track the temple recession response.'
                                      : _hasSupplements && _hasMinoxidil
                                        ? 'NW2 is the ideal prevention window and your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at the temple corners — keep minoxidil applied twice daily to both temple corners and your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC triple-layer potential at this earliest-detectable recession stage.'
                                      : _hasMinoxidil
                                        ? 'At NW2 minoxidil is well-timed — add a DHT-blocking shampoo 3× weekly as the second prevention layer. Together they attack AGA from two angles (topical growth signal + DHT suppression), which delivers the strongest long-term response at this early stage.'
                                        : _hasSupplements && _hasDHTShampoo
                                          ? 'Your supplement stack and DHT-blocking shampoo are building a strong dual-layer preventive foundation at NW2 — nutritional support and topical DHT suppression working in parallel at the ideal prevention stage. Add minoxidil directly to both temple corners twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC triple-layer approach at this earliest-recession stage. Leave DHT shampoo on 3-5 minutes per wash and set a 3-month checkpoint with front-facing photos to track the temple recession response.'
                                          : _hasDHTShampoo
                                          ? 'At NW2 the treatment window is open and follicles are still fully viable — add minoxidil directly to both temple corners twice daily. Pairing it with your existing DHT-blocking shampoo gives the strongest dual-mechanism response before recession deepens.'
                                          : _hasSupplements && _hasMassage
                                            ? (_hasLLLT
                                                ? 'Your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation at NW2 where the prevention window is still fully open — keep your supplement routine consistent and maintain your LLLT sessions on schedule. The highest-ROI additions at this ideal prevention stage are a DHT-blocking shampoo 3× weekly and minoxidil on both temple corners twice daily (apply minoxidil immediately after LLLT sessions while scalp circulation is elevated); adding both topical layers while follicles are still fully viable gives the strongest long-term potential before recession deepens.'
                                                : _hasMicroneedling
                                                ? 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming at NW2 where the prevention window is still fully open — keep your supplement routine consistent and use microneedling 24-48 hours before any topical application. The highest-ROI additions at this ideal prevention stage are a DHT-blocking shampoo 3× weekly and minoxidil on both temple corners twice daily; adding both topical layers while follicles are still fully viable gives the strongest long-term potential before recession deepens.'
                                                : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at NW2 where the prevention window is still fully open — keep your daily 4-minute massage consistent to maintain circulation at both temple corners and your supplement routine solid. The highest-ROI additions at this ideal prevention stage are a DHT-blocking shampoo 3× weekly and minoxidil on both temple corners twice daily; adding both topical layers while follicles are still fully viable gives the strongest long-term potential before recession deepens.')
                                          : _hasSupplements
                                            ? 'Your supplement stack supports follicle health at NW2 where your hairline is still in the early prevention window — nutritional support is a solid foundation. The highest-ROI additions at this stage are a DHT-blocking shampoo 3× weekly and minoxidil on both temple corners twice daily; adding both topical layers while follicles are fully viable gives the strongest long-term potential at NW2.'
                                            : 'NW2 is the optimal window to act — start minoxidil on both temple corners and add a DHT-blocking shampoo 3× weekly. This dual approach (topical growth signal + DHT suppression) at the earliest detectable stage produces the strongest long-term ROI.')
                  : data.stage === 'NW3'
                    // NW3: strong treatment response window; deep recession is established but follicles at the edge are still highly responsive
                    ? (_hasFinasteride && _hasMinoxidil && _hasMassage && _hasDHTShampoo
                        ? (_hasLLLT
                            ? 'NW3 is a strong response window and your finasteride + minoxidil + LLLT + DHT shampoo is the most complete non-surgical protocol — apply minoxidil to both recession zones immediately after your LLLT session while scalp circulation is elevated, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. This four-layer stack at the established-recession stage gives the strongest documented potential; take monthly front-facing photos to track the temple recession response.'
                            : _hasMicroneedling
                            ? 'NW3 is a strong response window and your finasteride + minoxidil + microneedling + DHT shampoo is the most complete non-surgical protocol — wait 24-48 hours after each microneedling session before applying minoxidil to both recession zones (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. This four-layer stack at the established-recession stage gives the strongest documented potential; take monthly front-facing photos to track the temple recession response.'
                            : 'NW3 is a strong response window and your finasteride + minoxidil + massage + DHT shampoo is the most complete non-surgical protocol — apply minoxidil to both recession zones immediately after a 4-minute scalp massage, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. This four-layer stack at the established-recession stage gives the strongest documented potential; take monthly front-facing photos to track the temple recession response.')
                        : _hasFinasteride && _hasMinoxidil && _hasMassage
                          ? (_hasLLLT
                              ? 'NW3 is a strong response window and your finasteride + minoxidil + LLLT stack is fully deployed — apply minoxidil to both recession zones immediately after your LLLT session while scalp circulation is elevated, and take finasteride at the same time each day. Consistent timing over the next 3-4 months is what converts this complete stack into measurable results.'
                              : _hasMicroneedling
                              ? 'NW3 is a strong response window and your finasteride + minoxidil + microneedling stack is fully deployed — wait 24-48 hours after each microneedling session before applying minoxidil to both recession zones (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; take finasteride at the same time each day. Consistent timing over the next 3-4 months is what converts this complete stack into measurable results.'
                              : 'NW3 is a strong response window and your finasteride + minoxidil + massage stack is fully deployed — apply minoxidil to both recession zones immediately after a 4-minute scalp massage, and take finasteride at the same time each day. Consistent timing over the next 3-4 months is what converts this complete stack into measurable results.')
                          : _hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                            ? 'NW3 is a strong response window and your finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control — add a 4-minute scalp massage before each minoxidil application to complete the stack. Mechanical stimulation is the highest-ROI addition to your existing three-layer protocol at this established-recession stage.'
                            : _hasFinasteride && _hasMinoxidil
                              ? 'NW3 is a strong response window and you have the two most powerful tools active (finasteride + minoxidil) — add a 4-minute scalp massage before each topical application to prime absorption. This finasteride + minoxidil + massage combination is the strongest evidence-based non-surgical approach at NW3.'
                              : _hasFinasteride && _hasDHTShampoo
                                ? 'At NW3, finasteride + DHT-blocking shampoo delivers both systemic and topical DHT suppression at the temple recession edge — leave DHT shampoo on 3-5 minutes per wash. Add minoxidil to both recession zones twice daily to complete the triple stack; finasteride + minoxidil + DHT shampoo is the strongest non-surgical NW3 protocol, and a 4-minute scalp massage before each application maximizes absorption at the recession edge.'
                              : _hasFinasteride
                                ? 'NW3 is a pivotal window and your finasteride is already blocking DHT systemically — add minoxidil twice daily to both recession zones for the topical growth signal, plus a daily 4-minute scalp massage. The finasteride + minoxidil + massage stack gives the strongest documented response at this established stage.'
                                : _hasMinoxidil && _hasMassage && _hasDHTShampoo
                                    ? (_hasLLLT
                                        ? 'NW3 is still a strong response window — your treatment stack is well-timed. Apply minoxidil to both recession zones immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes. Consistent timing over the next 3-4 months is what converts the stack into measurable results.'
                                        : _hasMicroneedling
                                        ? 'NW3 is still a strong response window — your treatment stack is well-timed. Wait 24-48 hours after each microneedling session before applying minoxidil to both recession zones (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal and leave DHT shampoo on 3-5 minutes on wash days. Consistent timing over the next 3-4 months is what converts the stack into measurable results.'
                                        : 'NW3 is still a strong response window — your treatment stack is well-timed. Apply minoxidil to both recession zones immediately after a 4-minute scalp massage on wash days, and leave DHT shampoo on 3-5 minutes. Consistent timing over the next 3-4 months is what converts the stack into measurable results.')
                                    : _hasMinoxidil && _hasDHTShampoo
                                      ? 'NW3 has a strong treatment response window — add a 4-minute scalp massage before each minoxidil application to prime absorption where DHT pressure is highest at the recession edge. Your minoxidil and DHT shampoo cover the topical growth signal and local DHT suppression; massage completes the triple OTC stack for the strongest 6-12 month potential at this established stage.'
                                      : _hasMinoxidil && _hasMassage
                                        ? (_hasLLLT
                                            ? 'At NW3 you have minoxidil and LLLT in place — add a DHT-blocking shampoo 3× weekly as the third leg. The triple stack (topical + LLLT + DHT suppression) gives the strongest 6-month potential at this established stage.'
                                            : _hasMicroneedling
                                            ? 'At NW3 you have minoxidil and microneedling in place — wait 24-48 hours after each microneedling session before applying minoxidil to the recession zones (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly as the third leg; the triple stack (topical + microneedling + DHT suppression) gives the strongest 6-month potential at this established stage.'
                                            : 'At NW3 you have minoxidil and massage in place — add a DHT-blocking shampoo 3× weekly as the third leg. The triple stack (topical + massage + DHT suppression) gives the strongest 6-month potential at this established stage.')
                                        : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                          ? 'NW3 is a strong response window and your supplement stack, minoxidil, and DHT-blocking shampoo deliver the complete OTC three-layer approach — nutritional follicle support, topical growth signal, and local DHT suppression at the recession edge. Apply 1ml to each recession zone twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. This triple-layer stack is the strongest OTC approach at this pivotal established-recession stage; take monthly front-facing photos to track the temple recession response and consider adding a 4-minute scalp massage before each topical application as the mechanical stimulation fourth layer.'
                                        : _hasSupplements && _hasMinoxidil
                                          ? 'NW3 is a strong response window and your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at the recession edge — apply 1ml to each recession zone twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach at this pivotal established-recession window. Take monthly front-facing photos to track the temple recession response.'
                                        : _hasMinoxidil
                                          ? 'NW3 has a strong treatment response window — pair your minoxidil with a 4-minute scalp massage before each application and a DHT-blocking shampoo 3× weekly. This triple approach is the OTC gold standard for maximizing potential at this stage.'
                                          : _hasSupplements && _hasDHTShampoo
                                            ? 'Your supplement stack and DHT-blocking shampoo cover nutritional support and local DHT suppression at NW3 where the recession edge is still highly responsive — leave DHT shampoo on 3-5 minutes per wash. Add minoxidil to both recession zones twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC three-layer approach at this established stage. Pair each application with a 4-minute scalp massage and take monthly front-facing photos; the 3-12 month response window is open.'
                                            : _hasDHTShampoo
                                            ? 'NW3 is a pivotal response window and your DHT-blocking shampoo is providing local DHT suppression at the recession edge — add minoxidil to both temple recession zones twice daily as the topical growth signal. Minoxidil + DHT shampoo addresses recession from two angles at this established stage; pair each application with a 4-minute scalp massage to complete the OTC triple stack.'
                                            : _hasSupplements && _hasMassage
                                              ? (_hasLLLT
                                                  ? 'Your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation at NW3 where follicles at the recession edge are still highly responsive — apply any topicals immediately after your LLLT session while scalp circulation is elevated at the recession edge. The highest-ROI additions at this pivotal stage are minoxidil on both recession zones twice daily and a DHT-blocking shampoo 3× weekly; timing both topical layers after LLLT while follicles remain viable maximizes the 12-month potential while the response window is open.'
                                                  : _hasMicroneedling
                                                  ? 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming at NW3 where follicles at the recession edge are still highly responsive — use microneedling 24-48 hours before topical application to maximize absorption at the recession edge. The highest-ROI additions at this pivotal stage are minoxidil on both recession zones twice daily and a DHT-blocking shampoo 3× weekly; adding both topical layers timed after microneedling while follicles remain viable maximizes the 12-month potential while the response window is open.'
                                                  : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at NW3 where temple recession is established but follicles at the recession edge are still highly responsive — keep your daily 4-minute massage consistent to maintain circulation at the recession edge. The highest-ROI additions at this pivotal stage are minoxidil on both recession zones twice daily and a DHT-blocking shampoo 3× weekly; adding both topical layers while follicles remain viable maximizes the 12-month potential while the response window is open.')
                                            : _hasSupplements
                                              ? 'Your supplement stack supports follicle health at NW3 where temple recession is established but follicles at the recession edge are still highly responsive — nutritional support is a good foundation. The highest-ROI additions at this pivotal stage are minoxidil on both recession zones twice daily and a DHT-blocking shampoo 3× weekly; starting both topical layers now maximizes the 12-month potential while the response window is open.'
                                              : 'NW3 is a pivotal window: deep recession is established, but follicles at the edge are still highly responsive. Start the full stack — minoxidil twice daily on both recession zones, DHT-blocking shampoo 3× weekly, and a daily 4-minute scalp massage. Acting comprehensively now maximizes your 12-month potential.')
                    : data.stage === 'NW3v'
                      // NW3v: dual-zone active stage — both temples and early crown need simultaneous treatment to maximize potential
                      ? (_hasFinasteride && _hasMinoxidil && _hasMassage && _hasDHTShampoo
                          ? (_hasLLLT
                              ? 'NW3v is a dual-zone stage and your finasteride + minoxidil + LLLT + DHT shampoo is the most complete non-surgical protocol — confirm minoxidil covers BOTH temple recession zones AND the vertex each session, apply it immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes on wash days. This four-layer dual-zone stack gives the strongest documented non-surgical potential at NW3v; consistent coverage over 4+ months is what converts it into measurable results across both active fronts.'
                              : _hasMicroneedling
                              ? 'NW3v is a dual-zone stage and your finasteride + minoxidil + microneedling + DHT shampoo is the most complete non-surgical protocol — confirm minoxidil covers BOTH temple recession zones AND the vertex each session, but wait 24-48 hours after each microneedling session before applying (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; leave DHT shampoo on 3-5 minutes on wash days. This four-layer dual-zone stack gives the strongest documented non-surgical potential at NW3v; consistent coverage over 4+ months is what converts it into measurable results across both active fronts.'
                              : 'NW3v is a dual-zone stage and your finasteride + minoxidil + massage + DHT shampoo is the most complete non-surgical protocol — confirm minoxidil covers BOTH temple recession zones AND the vertex each session, apply it right after your scalp massage, and leave DHT shampoo on 3-5 minutes on wash days. This four-layer dual-zone stack gives the strongest documented non-surgical potential at NW3v; consistent coverage over 4+ months is what converts it into measurable results across both active fronts.')
                          : _hasFinasteride && _hasMinoxidil && _hasMassage
                            ? (_hasLLLT
                                ? 'NW3v is a dual-zone active stage and your finasteride + minoxidil + LLLT stack is fully deployed — confirm minoxidil covers BOTH temple recession zones AND the vertex each session, applied immediately after your LLLT session while scalp circulation is elevated. Take finasteride at the same time daily. Dual-zone consistency is what converts this complete stack into maximum potential across both active fronts.'
                                : _hasMicroneedling
                                ? 'NW3v is a dual-zone active stage and your finasteride + minoxidil + microneedling stack is fully deployed — confirm minoxidil covers BOTH temple recession zones AND the vertex each session, but wait 24-48 hours after each microneedling session before applying (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal. Take finasteride at the same time daily. Dual-zone consistency is what converts this complete stack into maximum potential across both active fronts.'
                                : 'NW3v is a dual-zone active stage and your finasteride + minoxidil + massage stack is fully deployed — confirm minoxidil covers BOTH temple recession zones AND the vertex each session, and take finasteride at the same time daily. Dual-zone consistency is what converts this complete stack into maximum potential across both active fronts.')
                            : _hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                              ? 'At NW3v two zones are active and your finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control across both fronts — add scalp massage (4 min, covering temples AND vertex) before each topical application. Mechanical stimulation is the highest-ROI addition to your existing three-layer dual-zone protocol at NW3v.'
                              : _hasFinasteride && _hasMinoxidil
                                ? 'At NW3v two zones are active and your finasteride + minoxidil foundation is in place — add scalp massage (4 min, covering temples AND vertex) before each topical application. This trio (systemic DHT block + topical + mechanical) is the strongest dual-zone approach at NW3v.'
                                : _hasFinasteride && _hasDHTShampoo
                                  ? 'At NW3v, finasteride + DHT-blocking shampoo delivers both systemic and topical DHT suppression across both active zones — leave DHT shampoo on 3-5 minutes per wash. Add minoxidil to BOTH the temple recession zones AND the vertex twice daily to complete the triple stack; finasteride + minoxidil + DHT shampoo gives the strongest non-surgical dual-zone NW3v potential, and a 4-minute scalp massage before each application maximizes absorption at both active fronts.'
                                : _hasFinasteride
                                  ? 'NW3v is a dual-zone stage (temples AND early crown active simultaneously) — your finasteride suppresses systemic DHT. Add minoxidil to BOTH zones (1ml per temple + 1ml vertex twice daily) plus daily scalp massage for maximum dual-zone potential.'
                                  : _hasMinoxidil && _hasMassage && _hasDHTShampoo
                                      ? (_hasLLLT
                                          ? 'NW3v is an active dual-zone stage — your full stack is in place. Apply minoxidil immediately after your LLLT session while scalp circulation is elevated, covering BOTH temple recession zones AND the vertex; leave DHT shampoo on 3-5 minutes on wash days. Consistent timing over the next 3-4 months converts your full stack into maximum potential across both active fronts.'
                                          : _hasMicroneedling
                                          ? 'NW3v is an active dual-zone stage — your full stack is in place. Wait 24-48 hours after each microneedling session before applying minoxidil to both temple recession zones AND the vertex (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal and leave DHT shampoo on 3-5 minutes on wash days. Consistent timing over the next 3-4 months converts your full stack into maximum potential across both active fronts.'
                                          : 'NW3v is an active dual-zone stage — your full stack is in place. Apply minoxidil immediately after a 4-minute scalp massage covering BOTH temple recession zones AND the vertex, and leave DHT shampoo on 3-5 minutes on wash days. Consistent timing over the next 3-4 months converts your full stack into maximum potential across both active fronts.')
                                      : _hasMinoxidil && _hasDHTShampoo
                                        ? 'At NW3v two zones are active simultaneously — add scalp massage (4 min, covering temples AND vertex) before each minoxidil application. Priming both fronts together maximizes absorption where your dual-zone treatment potential is highest.'
                                        : _hasMinoxidil && _hasMassage
                                          ? (_hasLLLT
                                              ? 'NW3v is a dual-zone active stage and your minoxidil + LLLT cover the topical growth signal and photobiomodulation across both zones — apply minoxidil immediately after your LLLT session while scalp circulation is elevated, covering BOTH temple recession zones AND the vertex. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; the triple stack across both active fronts gives the strongest OTC potential at NW3v.'
                                              : _hasMicroneedling
                                              ? 'NW3v is a dual-zone active stage and your minoxidil + microneedling cover the topical growth signal and scalp priming across both zones — wait 24-48 hours after each microneedling session before applying minoxidil to both temple recession zones AND the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; the triple stack across both active fronts gives the strongest OTC potential at NW3v.'
                                              : 'NW3v is a dual-zone active stage and your minoxidil + scalp massage cover the topical growth signal and mechanical stimulation across both zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the third leg. Confirm minoxidil reaches BOTH temple recession zones AND the vertex each session; the triple stack applied simultaneously to both active fronts gives the strongest OTC potential at NW3v.')
                                          : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                            ? 'NW3v is a dual-zone stage and your supplement stack, minoxidil, and DHT-blocking shampoo deliver the complete OTC three-layer approach — nutritional follicle support, topical growth signal, and local DHT suppression across both active zones. Confirm minoxidil reaches BOTH temple recession zones AND the vertex twice daily (1ml per zone), leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. This triple-layer dual-zone coverage is the strongest OTC approach at NW3v; take monthly front-facing and overhead photos to track both active fronts and consider adding a 4-minute scalp massage before each topical application as the mechanical stimulation fourth layer.'
                                          : _hasSupplements && _hasMinoxidil
                                            ? 'NW3v is a dual-zone stage and your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal — confirm minoxidil reaches BOTH temple recession zones AND the vertex twice daily (1ml per zone) and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer approach for this dual-zone stage. Take monthly front-facing and overhead photos to track both active fronts.'
                                          : _hasMinoxidil
                                            ? 'NW3v means both temples and early crown need treatment simultaneously — add a DHT-blocking shampoo 3× weekly and ensure minoxidil reaches BOTH recession zones AND the vertex twice daily. Dual-zone coverage now prevents each front from advancing independently.'
                                            : _hasSupplements && _hasDHTShampoo
                                              ? 'Your supplement stack and DHT-blocking shampoo cover nutritional support and local DHT suppression across both active zones at NW3v — leave DHT shampoo on 3-5 minutes per wash. Add minoxidil to BOTH temple recession zones AND the vertex twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC three-layer approach for dual-zone coverage at this stage. Pair each application with a 4-minute scalp massage covering both active fronts simultaneously and take monthly front-facing and overhead photos.'
                                              : _hasDHTShampoo
                                              ? 'NW3v is a dual-zone stage — both temples and early crown are active — and your DHT-blocking shampoo is providing local DHT suppression across both thinning zones. Add minoxidil to BOTH zones (1ml per temple recession zone + 1ml vertex twice daily) as the topical growth signal; minoxidil + DHT shampoo at NW3v covers both active fronts from two angles. Pair each application with a 4-minute scalp massage to prime absorption at both zones simultaneously.'
                                              : _hasSupplements && _hasMassage
                                                ? (_hasLLLT
                                                    ? 'Your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation at NW3v where both temples and early crown are simultaneously active — apply any topicals immediately after your LLLT session while scalp circulation is elevated, covering BOTH zones. The highest-ROI additions at this dual-zone stage are minoxidil applied to BOTH temple recession zones AND the vertex twice daily, plus a DHT-blocking shampoo 3× weekly; timing both topical layers after LLLT while follicles remain viable gives the strongest OTC dual-zone potential before either front advances further.'
                                                    : _hasMicroneedling
                                                    ? 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming at NW3v where both temples and early crown are simultaneously active — use microneedling 24-48 hours before topical application covering BOTH zones to maximize absorption at both active fronts. The highest-ROI additions at this dual-zone stage are minoxidil applied to BOTH temple recession zones AND the vertex twice daily, plus a DHT-blocking shampoo 3× weekly; adding both topical layers while follicles remain viable gives the strongest OTC dual-zone potential before either front advances further.'
                                                    : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at NW3v where both temples and early crown are simultaneously active — cover BOTH zones during your daily 4-minute massage to maintain circulation at both active fronts. The highest-ROI additions at this dual-zone stage are minoxidil applied to BOTH temple recession zones AND the vertex twice daily, plus a DHT-blocking shampoo 3× weekly; adding both topical layers while follicles remain viable gives the strongest OTC dual-zone potential before either front advances further.')
                                              : _hasSupplements
                                                ? 'Your supplement stack supports follicle health at NW3v where both temples and early crown are simultaneously active — nutritional support is a solid foundation. The highest-ROI additions at this dual-zone stage are minoxidil applied to BOTH temple recession zones AND the vertex twice daily, plus a DHT-blocking shampoo 3× weekly; starting both topical layers across both active fronts simultaneously gives the strongest dual-zone potential before either front advances further.'
                                                : 'NW3v is a dual-zone stage — both temples and early crown are active at the same time. Start minoxidil on BOTH zones (1ml per temple + 1ml vertex twice daily), add a DHT-blocking shampoo 3× weekly, and daily scalp massage. Simultaneous dual-zone coverage now gives the strongest window before either front advances.')
                      : data.stage === 'NW4'
                        // NW4: meaningful potential remains with the right protocol; realistic expectations and consistency are the keys
                        ? (_hasFinasteride && _hasMinoxidil && _hasMassage && _hasDHTShampoo
                            ? (_hasLLLT
                                ? 'At NW4 your finasteride + minoxidil + LLLT + DHT shampoo is the most complete non-surgical protocol — apply minoxidil immediately after your LLLT session while scalp circulation is elevated, covering the full frontal and crown zones; leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. Set a 4-month checkpoint and take front-facing and overhead photos today as your baseline; consistent uninterrupted coverage over 16+ weeks is what determines how much potential converts to visible density.'
                                : _hasMicroneedling
                                ? 'At NW4 your finasteride + minoxidil + microneedling + DHT shampoo is the most complete non-surgical protocol — wait 24-48 hours after each microneedling session before applying minoxidil across the full frontal and crown zones (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. Set a 4-month checkpoint and take front-facing and overhead photos today as your baseline; consistent uninterrupted coverage over 16+ weeks is what determines how much potential converts to visible density.'
                                : 'At NW4 your finasteride + minoxidil + massage + DHT shampoo is the most complete non-surgical protocol — apply minoxidil immediately after a 4-minute scalp massage across the full frontal and crown zones, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day. Set a 4-month checkpoint and take front-facing and overhead photos today as your baseline; consistent uninterrupted coverage over 16+ weeks is what determines how much potential converts to visible density.')
                            : _hasFinasteride && _hasMinoxidil && _hasMassage
                              ? (_hasLLLT
                                  ? 'At NW4 your finasteride + minoxidil + LLLT stack is a strong non-surgical protocol — set a 4-month checkpoint and take front-facing and overhead photos today as your baseline. Consistent uninterrupted coverage over 16+ weeks is what determines how much potential converts to visible density.'
                                  : _hasMicroneedling
                                  ? 'At NW4 your finasteride + minoxidil + microneedling stack is a strong non-surgical protocol — wait 24-48 hours after each microneedling session before applying minoxidil (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal. Set a 4-month checkpoint and take front-facing and overhead photos today as your baseline. Consistent uninterrupted coverage over 16+ weeks is what determines how much potential converts to visible density.'
                                  : 'At NW4 your finasteride + minoxidil + massage stack is the strongest non-surgical protocol available — set a 4-month checkpoint and take front-facing and overhead photos today as your baseline. Consistent uninterrupted coverage over 16+ weeks is what determines how much potential converts to visible density.')
                              : _hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                                ? 'At NW4 your finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control — add a 4-minute scalp massage before each topical application to prime absorption across the full frontal and crown zones. Mechanical stimulation is the highest-ROI addition to your existing three-layer protocol; set a 4-month checkpoint with front-facing and overhead photos today as your baseline.'
                                : _hasFinasteride && _hasMinoxidil
                                  ? 'At NW4 you have finasteride and minoxidil active — add a 4-minute scalp massage before each topical application to prime absorption. Mechanical stimulation is the highest-ROI addition to your existing finasteride + minoxidil stack at this stage.'
                                  : _hasFinasteride && _hasDHTShampoo
                                    ? 'At NW4, finasteride + DHT-blocking shampoo delivers dual-level DHT suppression — systemic and topical control at this established stage. Add minoxidil across the entire top twice daily to complete the triple stack; finasteride + minoxidil + DHT shampoo gives the strongest evidence-based non-surgical potential at NW4. Set a 4-month checkpoint with front-facing and overhead photos today as your baseline.'
                                  : _hasFinasteride
                                    ? 'Finasteride gives NW4 users a meaningful potential advantage — add minoxidil across the entire top twice daily and daily scalp massage to complete the stack. Comprehensive, consistent coverage over 4+ months is what converts your finasteride foundation into visible results.'
                                    : _hasMinoxidil && _hasMassage && _hasDHTShampoo
                                        ? (_hasLLLT
                                            ? 'At NW4, your minoxidil, LLLT device, and DHT-blocking shampoo cover the full OTC triple stack — apply minoxidil immediately after your LLLT session while scalp circulation is elevated across the full frontal and crown zones, and leave DHT shampoo on 3-5 minutes per wash. The outcome now depends on consistency; take front-facing and overhead photos today as your baseline, and set a 4-month checkpoint. Meaningful density change at NW4 typically takes 16+ weeks of uninterrupted coverage to show.'
                                            : _hasMicroneedling
                                            ? 'At NW4, your minoxidil, microneedling, and DHT-blocking shampoo cover the full OTC triple stack — wait 24-48 hours after each microneedling session before applying minoxidil across the full frontal and crown zones (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal and leave DHT shampoo on 3-5 minutes per wash. The outcome now depends on consistency; take front-facing and overhead photos today as your baseline, and set a 4-month checkpoint. Meaningful density change at NW4 typically takes 16+ weeks of uninterrupted coverage to show.'
                                            : 'At NW4 you have the right stack active — the outcome now depends on consistency and realistic expectations. Take front-facing and overhead photos today as your baseline, and set a 4-month checkpoint. Meaningful density change at NW4 typically takes 16+ weeks of uninterrupted coverage to show.')
                                        : _hasMinoxidil && _hasDHTShampoo
                                          ? 'At NW4 your topical and DHT shampoo are in place — add a 4-minute scalp massage before each minoxidil application. Mechanical stimulation improves absorption directly where miniaturization is most advanced and is the highest-ROI addition to an existing NW4 stack.'
                                          : _hasMinoxidil && _hasMassage
                                            ? (_hasLLLT
                                                ? 'At NW4, your minoxidil and LLLT cover the topical growth signal and photobiomodulation across the full frontal and crown zones — apply minoxidil immediately after your LLLT session while scalp circulation is elevated to maximize absorption. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; set a 4-month checkpoint with front-facing and overhead photos today as your baseline.'
                                                : _hasMicroneedling
                                                ? 'At NW4, your minoxidil and microneedling cover the topical growth signal and scalp priming across the full frontal and crown zones — wait 24-48 hours after each microneedling session before applying minoxidil to avoid follicle irritation; on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; set a 4-month checkpoint with front-facing and overhead photos today as your baseline.'
                                                : 'At NW4, your minoxidil and scalp massage cover the topical growth signal and mechanical stimulation — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the third layer. The triple approach (topical + mechanical + DHT suppression) is the strongest realistic OTC protocol at NW4; set a 4-month checkpoint with front-facing and overhead photos today as your baseline.')
                                            : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                              ? 'Your supplement stack, minoxidil, and DHT-blocking shampoo deliver the complete OTC three-layer approach at NW4 — nutritional follicle support, topical growth signal, and local DHT suppression across the full frontal and crown zones. Apply minoxidil across the entire top twice daily, leave DHT shampoo on 3-5 minutes per wash 3× weekly, and keep your supplement routine consistent. This triple-layer stack is the strongest OTC combination at this established stage; pair each application with a 4-minute scalp massage and set a 4-month checkpoint with front-facing and overhead photos today as your baseline. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW4 protocol.'
                                            : _hasSupplements && _hasMinoxidil
                                              ? 'Your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal at NW4 where mid-scalp miniaturization is established — apply minoxidil across the entire top twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC three-layer combination at this established stage. Pair each application with a 4-minute scalp massage and set a 4-month checkpoint with front-facing and overhead photos today as your baseline. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW4 potential protocol.'
                                            : _hasMinoxidil
                                              ? 'At NW4, pair your minoxidil with a DHT-blocking shampoo 3× weekly and a 4-minute scalp massage before each application. This triple approach — topical growth signal + DHT suppression + mechanical stimulation — is the strongest realistic OTC protocol at this stage.'
                                              : _hasSupplements && _hasDHTShampoo
                                                ? 'Your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression at NW4 where mid-scalp miniaturization is established — leave DHT shampoo on 3-5 minutes per wash. Add minoxidil across the entire top twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC three-layer combination at this established stage. Pair each application with a 4-minute scalp massage and set a 4-month checkpoint with front-facing and overhead photos today as your baseline. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW4 potential protocol.'
                                                : _hasDHTShampoo
                                                  ? 'Your DHT-blocking shampoo provides topical DHT suppression at NW4 where mid-scalp miniaturization is established — add minoxidil across the entire top twice daily as the topical growth signal. DHT shampoo + minoxidil covers both mechanisms (DHT suppression + follicle stimulation) from two complementary angles and is the strongest OTC combination at this stage. Pair each application with a 4-minute scalp massage and set a 4-month checkpoint with front-facing and overhead photos today as your baseline. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW4 potential protocol.'
                                                  : _hasSupplements && _hasMassage
                                                    ? (_hasLLLT
                                                        ? 'Your supplement stack and LLLT device cover nutritional follicle support and photobiomodulation at NW4 where mid-scalp miniaturization is established — apply minoxidil immediately after your LLLT session while scalp circulation is elevated across the full frontal and crown zones. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; three complementary layers (nutritional + photobiomodulation + topical DHT suppression) give the strongest non-Rx OTC approach at this established stage. Set a 4-month checkpoint with front-facing and overhead photos today as your baseline. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW4 potential protocol.'
                                                        : _hasMicroneedling
                                                        ? 'Your supplement stack and microneedling cover nutritional follicle support and scalp priming at NW4 where mid-scalp miniaturization is established — use microneedling 24-48 hours before topical application across the full frontal and crown zones to maximize absorption where miniaturization is most advanced. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + topical DHT suppression) give the strongest non-Rx OTC approach at this established stage. Set a 4-month checkpoint with front-facing and overhead photos today as your baseline. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW4 potential protocol.'
                                                        : 'Your supplement stack and scalp massage cover nutritional follicle support and mechanical stimulation at NW4 where mid-scalp miniaturization is established — keep your daily 4-minute massage covering the full frontal and crown zones to maintain circulation where miniaturization is most advanced. The highest-ROI additions at this stage are minoxidil across the entire top twice daily and a DHT-blocking shampoo 3× weekly; adding both topical layers while follicles remain viable gives the strongest OTC potential at NW4. Set a 4-month checkpoint with front-facing and overhead photos today as your baseline. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW4 potential protocol.')
                                                  : _hasSupplements
                                                    ? 'Your supplement stack supports follicle health at NW4 where mid-scalp miniaturization is established — nutritional support is a good foundation, but the highest-ROI additions at this stage are minoxidil across the entire top twice daily and a DHT-blocking shampoo 3× weekly. Adding both topical layers while follicles remain viable gives the strongest OTC potential at NW4; set a 4-month checkpoint with front-facing and overhead photos today as your baseline.'
                                                    : 'NW4 still has meaningful potential with the right protocol — start the full stack this week: minoxidil across the entire top twice daily, DHT-blocking shampoo 3× weekly (3-5 min contact time), and daily 4-minute scalp massage. Comprehensive, consistent coverage over 4+ months determines the outcome.')
                        : (data.stage === 'diffuse' || data.stage === 'n/a (female)')
                          ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                              ? (data.stage === 'n/a (female)'
                                  ? "Female-pattern potential is 55-78% and your finasteride + minoxidil + DHT shampoo covers the key treatment layers — your protocol is well-optimized. Prioritize a ferritin, thyroid, and hormone panel this month: a reversible hormonal cause is common in women and when treated can push your outcome toward the upper end of that range faster than adding products."
                                  : "Diffuse potential is 55-78% and your finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and topical DHT control — the strongest OTC + Rx stack for this pattern. Prioritize a ferritin, vitamin D, and thyroid workup this month: fixing a reversible nutritional cause alongside your existing stack can accelerate improvement significantly.")
                              : _hasFinasteride && _hasMinoxidil
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern potential is 55-78% and your finasteride + minoxidil addresses DHT suppression and the topical growth signal — add a DHT-blocking shampoo 3× weekly to complete the topical DHT control layer. Also check ferritin, thyroid, and hormones: a reversible cause is common in women and treating it alongside your current protocol pushes outcomes toward the upper range."
                                    : "Diffuse potential is 55-78% and your finasteride + minoxidil covers systemic DHT suppression and topical growth signal — add a DHT-blocking shampoo 3× weekly to complete the topical DHT control layer. Investigate ferritin, vitamin D, and thyroid; a reversible nutritional cause alongside diffuse AGA responds well when treated alongside your finasteride-backed protocol.")
                              : _hasFinasteride
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern potential is 55-78% and finasteride in your routine provides systemic DHT suppression — add minoxidil applied across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly. Ferritin, thyroid, and hormone testing is still the highest-ROI step: a reversible hormonal cause can unlock the upper range of that potential when treated alongside your current protocol."
                                    : "Diffuse potential is 55-78% and finasteride provides the systemic DHT suppression that significantly improves outcomes — add minoxidil across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly. Investigate ferritin, vitamin D, and thyroid: fixing a reversible nutritional cause alongside your finasteride foundation produces the fastest and most lasting improvement.")
                              : _hasMinoxidil && _hasDHTShampoo && _hasMassage
                                ? (_hasLLLT
                                    ? (data.stage === 'n/a (female)'
                                        ? "Female-pattern potential is 55-78% and your minoxidil, DHT shampoo, and LLLT device are a strong three-layer OTC stack — apply minoxidil immediately after your LLLT session while scalp circulation is elevated across the full top, and leave DHT shampoo on 3-5 minutes per wash. Prioritize a ferritin, thyroid, and hormone panel this month: a reversible cause is common in women and, when treated alongside your existing protocol, can push the outcome toward the upper end of that range."
                                        : "Diffuse thinning potential is 55-78% and your minoxidil, DHT shampoo, and LLLT device are a strong three-layer OTC stack — apply minoxidil immediately after your LLLT session while scalp circulation is elevated across the full top, and leave DHT shampoo on 3-5 minutes per wash. Prioritize a ferritin, vitamin D, and thyroid workup this month: a reversible nutritional cause alongside this protocol can produce rapid and lasting improvement.")
                                    : _hasMicroneedling
                                    ? (data.stage === 'n/a (female)'
                                        ? "Female-pattern potential is 55-78% and your minoxidil, DHT shampoo, and microneedling are a strong three-layer OTC stack — wait 24-48 hours after each microneedling session before applying minoxidil across the full scalp top (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Prioritize a ferritin, thyroid, and hormone panel this month: a reversible cause is common in women and when treated alongside your existing protocol can push outcomes toward the upper range."
                                        : "Diffuse thinning potential is 55-78% and your minoxidil, DHT shampoo, and microneedling are a strong three-layer OTC stack — wait 24-48 hours after each microneedling session before applying minoxidil (applying immediately after needling risks follicle irritation); on non-needling days apply across the full scalp top twice daily as normal. Prioritize a ferritin, vitamin D, and thyroid workup this month: fixing a reversible nutritional cause alongside this protocol can produce rapid and lasting improvement.")
                                    : (data.stage === 'n/a (female)'
                                        ? "Female-pattern potential is 55-78% and your minoxidil, DHT shampoo, and scalp massage are a solid three-layer OTC stack — apply minoxidil immediately after your scalp massage while circulation is elevated, and leave DHT shampoo on 3-5 minutes per wash. Prioritize a ferritin, thyroid, and hormone panel this month: a reversible cause is common in women and when treated alongside your existing protocol can push the outcome toward the upper range."
                                        : "Diffuse thinning potential is 55-78% and your minoxidil, DHT shampoo, and scalp massage are a solid three-layer OTC stack — apply minoxidil immediately after your scalp massage while circulation is elevated, and leave DHT shampoo on 3-5 minutes per wash. Prioritize a ferritin, vitamin D, and thyroid workup this month: fixing a reversible nutritional cause alongside this protocol can produce rapid and lasting improvement."))
                              : _hasSupplements && _hasMinoxidil && _hasDHTShampoo
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern potential is 55-78% and your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC triple-layer approach — apply minoxidil across the full scalp top twice daily, leave DHT shampoo on 3-5 minutes on wash days, and keep your supplement routine consistent. Prioritize a ferritin, thyroid, and hormone panel this month: a reversible hormonal cause is common in women and treating it alongside your existing triple-layer stack can push outcomes toward the upper end of the 55-78% range."
                                    : "Diffuse thinning potential is 55-78% and your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC triple-layer approach — apply minoxidil across the full scalp top twice daily, leave DHT shampoo on 3-5 minutes on wash days, and keep your supplement routine consistent. Prioritize a ferritin, vitamin D, and thyroid workup this month: fixing a reversible nutritional cause alongside your existing triple-layer protocol can produce rapid and lasting improvement toward the upper end of the 55-78% range.")
                              : _hasMinoxidil && _hasDHTShampoo
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern potential is 55-78% — your minoxidil and DHT shampoo are the right tools. Prioritize a ferritin, thyroid, and hormone panel this month: a reversible cause is more likely in women and when treated it can produce rapid, lasting improvement beyond what topicals achieve alone."
                                    : "Diffuse thinning has high OTC potential (55-78%) especially if a reversible cause is found — your topical and DHT shampoo are the right tools. Prioritize a ferritin, vitamin D, and thyroid workup this month: fixing a nutritional root cause alongside consistent treatment can produce rapid and lasting improvement.")
                              : _hasMinoxidil && _hasMassage
                                ? (_hasLLLT
                                    ? (data.stage === 'n/a (female)'
                                        ? "Female-pattern potential is 55-78% — your minoxidil and LLLT device provide a topical growth signal and photobiomodulation across the full scalp top. Apply minoxidil immediately after your LLLT session while scalp circulation is elevated, and add a DHT-blocking shampoo 3× weekly to complete the three-layer OTC stack. Also check ferritin, thyroid, and hormones: a reversible cause is common in women and, when treated, produces improvements beyond what topicals achieve alone."
                                        : "Diffuse thinning potential is 55-78% — your minoxidil and LLLT device provide a topical growth signal and photobiomodulation across the full scalp top. Apply minoxidil immediately after your LLLT session while scalp circulation is elevated, and add a DHT-blocking shampoo 3× weekly to complete the three-layer OTC stack. Also investigate ferritin, vitamin D, and thyroid: a reversible nutritional cause alongside LLLT and topical treatment produces faster and more lasting improvement.")
                                    : _hasMicroneedling
                                    ? (data.stage === 'n/a (female)'
                                        ? "Female-pattern potential is 55-78% — your minoxidil and microneedling provide a topical growth signal and scalp priming across the full top. Wait 24-48 hours after each microneedling session before applying minoxidil (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly and check ferritin, thyroid, and hormones: a reversible cause is common in women and, when treated alongside your protocol, can push outcomes toward the upper range."
                                        : "Diffuse thinning potential is 55-78% — your minoxidil and microneedling provide a topical growth signal and scalp priming across the full top. Wait 24-48 hours after each microneedling session before applying minoxidil (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly and investigate ferritin, vitamin D, and thyroid: fixing a reversible nutritional cause alongside this protocol produces faster improvement.")
                                    : (data.stage === 'n/a (female)'
                                        ? "Female-pattern potential is 55-78% — your minoxidil and scalp massage provide a topical growth signal and mechanical stimulation across the full top. Apply minoxidil immediately after your scalp massage and add a DHT-blocking shampoo 3× weekly to complete the three-layer OTC stack. Also check ferritin, thyroid, and hormones: a reversible cause is common in women and when treated produces improvements that topicals alone can't achieve."
                                        : "Diffuse thinning potential is 55-78% — your minoxidil and scalp massage provide a topical growth signal and mechanical stimulation across the full top. Apply minoxidil immediately after your scalp massage and add a DHT-blocking shampoo 3× weekly to complete the three-layer OTC stack. Also investigate ferritin, vitamin D, and thyroid: a reversible nutritional cause alongside your protocol can produce rapid and lasting improvement."))
                              : _hasSupplements && _hasMinoxidil
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern potential is 55-78% and your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal across the full scalp top — apply minoxidil twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC triple-layer approach for female-pattern loss. Also check ferritin, thyroid, and hormones this month: a reversible hormonal cause is common in women and treating it alongside your existing dual-layer stack pushes outcomes toward the upper end of the 55-78% range."
                                    : "Diffuse thinning potential is 55-78% and your supplement stack and minoxidil cover nutritional follicle support and the topical growth signal across the full scalp top — apply minoxidil twice daily and keep your supplement routine consistent. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; supplements + minoxidil + DHT shampoo is the strongest OTC triple-layer approach for this pattern. Also investigate ferritin, vitamin D, and thyroid: a reversible nutritional cause is common with diffuse loss and treating it alongside your existing dual-layer protocol produces faster, lasting improvement within the 55-78% potential range.")
                              : _hasMinoxidil
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern potential is 55-78% — add a DHT-blocking shampoo 3× weekly to complement your minoxidil. Also check ferritin, thyroid, and hormones: these reversible causes are common in women and, when treated, produce improvements that topicals alone can't achieve."
                                    : "Diffuse thinning potential is 55-78% with a consistent protocol — add a DHT-blocking shampoo 3× weekly to complement your minoxidil. Also investigate ferritin, vitamin D, and thyroid: a reversible nutritional or hormonal cause is common with diffuse loss and dramatically improves the outcome when treated.")
                              : _hasSupplements && _hasDHTShampoo
                                ? (data.stage === 'n/a (female)'
                                    ? "Your supplement stack and DHT-blocking shampoo build a dual nutritional and topical DHT-suppression layer for female-pattern thinning — leave DHT shampoo on 3-5 minutes per wash and keep supplements consistent. Add minoxidil applied across the full scalp top twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC triple-layer approach for female-pattern loss. Also check ferritin, thyroid, and hormones this month: a reversible hormonal cause is common in women and treating it alongside your existing stack pushes outcomes toward the upper end of the 55-78% potential range."
                                    : "Your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression for diffuse thinning — leave DHT shampoo on 3-5 minutes per wash and keep supplements consistent. Add minoxidil across the full scalp top twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil is the strongest OTC triple-layer approach for this pattern. Also investigate ferritin, vitamin D, and thyroid: a reversible nutritional cause is common with diffuse loss and treating it alongside your existing dual-layer protocol produces faster, lasting improvement within the 55-78% potential range.")
                                : _hasSupplements && _hasMassage
                                ? (data.stage === 'n/a (female)'
                                    ? "Female-pattern potential is 55-78% — your supplement stack and scalp massage provide nutritional follicle support and mechanical stimulation across the full scalp top. Keep your supplement routine consistent and your daily scalp massage covering the full top. The highest-ROI next additions are minoxidil applied across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly; adding both topical layers while follicles remain active gives the strongest OTC potential for female-pattern thinning. Also check ferritin, thyroid, and hormones this month: a reversible cause is common in women and when treated alongside your supplement + massage foundation can push outcomes toward the upper end of the 55-78% range."
                                    : "Diffuse thinning potential is 55-78% — your supplement stack and scalp massage provide nutritional follicle support and mechanical stimulation across the full scalp top. Keep your supplement routine consistent and your daily scalp massage covering the full top. The highest-ROI next additions are minoxidil across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly; adding both topical layers while follicles remain viable gives the strongest OTC potential for diffuse thinning. Also investigate ferritin, vitamin D, and thyroid: a reversible nutritional or hormonal cause is common with diffuse loss and treating it alongside your supplement + massage foundation can produce rapid and lasting improvement within the 55-78% potential range.")
                                : _hasSupplements
                                ? (data.stage === 'n/a (female)'
                                    ? "Your supplement stack (biotin, zinc, vitamin D) supports follicle health with female-pattern thinning — a good nutritional foundation. The highest-ROI additions are minoxidil applied across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly; also check ferritin, thyroid, and hormones this month since a reversible cause is common in women and treating it alongside your supplement routine produces faster, lasting improvement."
                                    : "Your supplement stack (biotin, zinc, vitamin D) supports follicle health with diffuse thinning — a solid nutritional foundation. The highest-ROI additions are minoxidil across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly; also investigate ferritin, vitamin D, and thyroid since a reversible nutritional cause is common with diffuse loss and treating it alongside your supplement routine can accelerate improvement significantly.")
                                : (data.stage === 'n/a (female)'
                                    ? "Female-pattern thinning has meaningful potential (55-78%) especially if a reversible hormonal or nutritional cause is present — start minoxidil applied across the full scalp top twice daily. Also check ferritin, thyroid, and hormones this month; a reversible cause is common and treating it is the highest-ROI step for long-term improvement."
                                    : "Diffuse thinning has high OTC potential (55-78%) because the cause is often reversible — start minoxidil across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly. Also investigate ferritin, vitamin D, and thyroid: fixing a nutritional root cause can produce rapid improvement that topicals alone cannot achieve."))
                          : _hasFinasteride && _hasMinoxidil && _hasMassage
                              ? 'Finasteride + minoxidil + scalp massage is the most evidence-backed non-surgical stack — optimize timing: massage 4 minutes first, apply minoxidil immediately after, and take finasteride at the same time each day without gaps. Consistency is the only variable left.'
                              : _hasFinasteride && _hasMinoxidil
                                ? 'Finasteride blocks systemic DHT and minoxidil drives the topical growth signal — add a 4-minute scalp massage before each application to prime absorption. This trio gives the strongest evidence-based response available without surgery.'
                                : _hasFinasteride
                                  ? 'Finasteride is your strongest DHT suppressor — add minoxidil twice daily to the thinning zones for the complementary topical growth signal. The finasteride + minoxidil combination has the strongest non-surgical evidence base; adding scalp massage as the third layer maximizes potential.'
                                  : (_hasMinoxidil && _hasMassage && _hasDHTShampoo)
                                      ? 'You have the top three habits active (minoxidil, scalp massage, DHT-blocking shampoo) — optimize timing: massage first, then apply minoxidil immediately after, and leave DHT shampoo on 3-5 minutes before rinsing on wash days. Consistency beats adding products.'
                                      : (_hasMinoxidil && _hasMassage)
                                        ? 'You have the key habits in place — stack them: apply minoxidil immediately after a 4-minute scalp massage so active ingredients penetrate freshly stimulated follicles.'
                                        : _hasMinoxidil
                                          ? 'Add a 4-minute scalp massage right before your morning minoxidil — stimulating blood flow first significantly improves topical absorption and follicle response.'
                                          : 'To maximize your treatment window, start minoxidil on thinning zones and pair it with daily 4-minute scalp massage — this combination has the strongest OTC evidence for regrowth.',
        };
        data.weeklyFocus = WEEKLY_FOCUS_MAP[data.weakestMetric?.label]
          || 'Stay consistent with your current routine — daily adherence is the single biggest driver of long-term results.';
        // weeklyFocusMetric: which metric the weeklyFocus targets (equals weakestMetric.label).
        // Lets the iOS app highlight the right metric card alongside the weeklyFocus text.
        data.weeklyFocusMetric = data.weakestMetric?.label || null;
        // Secondary focus: pre-built action text for the second-weakest metric.
        // Reuses WEEKLY_FOCUS_MAP (same stage/treatment logic) so the iOS app and
        // coach get ready-to-use advice for the #2 priority without extra client logic.
        data.weeklyFocusSecondary = data.secondWeakestMetric?.label
          ? (WEEKLY_FOCUS_MAP[data.secondWeakestMetric.label] || null)
          : null;
        data.weeklyFocusSecondaryMetric = data.secondWeakestMetric?.label || null;

        // protocolCoverage: structured breakdown of which treatment categories are active
        // in the user's current routine. Derived server-side from the same parsed routine
        // flags used to build weeklyFocus — no additional client-side string parsing needed.
        // The iOS app can use this to render a protocol-completeness indicator, surface
        // prompts for missing layers, or log adherence without re-implementing the detection.
        data.protocolCoverage = {
          topical:     _hasMinoxidil,    // minoxidil / rogaine
          rx:          _hasFinasteride,  // finasteride / dutasteride / spironolactone / bicalutamide / flutamide / cyproterone / androcur
          dhtShampoo:  _hasDHTShampoo,   // ketoconazole / DHT-blocking shampoo
          mechanical:    _hasMassage,        // scalp massage / dermaroller / microneedling / LLLT
          microneedling: _hasMicroneedling, // dermaroller / dermapen / microneedling (excludes LLLT)
          lllt:        _hasLLLT,          // LLLT devices: laser cap, laser comb, Capillus, HairMax
          supplements:   _hasSupplements,   // biotin / zinc / vitamins / saw palmetto
        };

        // protocolStrengthScore + label: how complete the user's treatment stack is for their stage.
        // 0-100 integer (capped at 75 for NW6/NW7 since OTC alone can't address the primary
        // coverage deficit at those stages) plus a plain-language label the iOS app can render
        // on the protocol card without additional client-side logic.
        const _protocolStrength = computeProtocolStrengthScore(stage, data.protocolCoverage);
        data.protocolStrengthScore = _protocolStrength.score;
        data.protocolStrengthLabel = _protocolStrength.label;

        // coachSuggestedQuestions: 3 context-aware conversation starters for the coach tab.
        // Computed server-side from stage + protocolCoverage so the iOS app can surface them
        // as suggestion chips without any extra API calls or client-side logic.
        data.coachSuggestedQuestions = buildSuggestedQuestions(stage, data.protocolCoverage, data.specialistRecommended);
        // Stage-progression override: when a rescan shows the stage worsened since the prior
        // scan, the most pressing question is always about the progression — what it means and
        // what to do next. Replace the first suggested question with a progression-specific one
        // so that slot surfaces the highest-urgency conversation starter. The second and third
        // questions remain stage-calibrated so the user has immediate follow-up options.
        // Only fires when previousStage is provided (i.e., a prior scan exists in the iOS app).
        const _pqStageChange = computeStageChange(stage, previousStage);
        if (_pqStageChange.stageDirection === 'progressed') {
          const { topical: _pqTopical = false, rx: _pqRx = false, dhtShampoo: _pqDht = false, mechanical: _pqMech = false, supplements: _pqSupp = false } = data.protocolCoverage || {};
          const _pqOnAnyTreatment = _pqTopical || _pqDht || _pqMech || _pqSupp || _pqRx;
          const _pqProgressionQ = _pqRx
            ? `My stage moved from ${previousStage} to ${stage} — what should I adjust in my treatment plan?`
            : _pqOnAnyTreatment
              ? `My stage progressed from ${previousStage} to ${stage} despite OTC treatment — should I add finasteride?`
              : `My stage went from ${previousStage} to ${stage} — what treatment should I start immediately?`;
          data.coachSuggestedQuestions = [_pqProgressionQ, ...data.coachSuggestedQuestions.slice(0, 2)];
        } else if (_pqStageChange.stageDirection === 'improved') {
          // Stage-improvement override: when a rescan shows the stage improved (e.g. NW3 → NW2),
          // the user's most natural question is whether the improvement is real and how to sustain it.
          // Replace the first suggested question with an improvement-specific one so the coach tab
          // surfaces a celebration/validation question as the highest-priority conversation starter.
          const { topical: _pqTopical = false, rx: _pqRx = false, dhtShampoo: _pqDht = false, mechanical: _pqMech = false, supplements: _pqSupp = false } = data.protocolCoverage || {};
          const _pqOnAnyTreatment = _pqTopical || _pqDht || _pqMech || _pqSupp || _pqRx;
          const _pqImprovementQ = _pqRx
            ? `My stage improved from ${previousStage} to ${stage} — is this real progress from my treatment or photo variability?`
            : _pqOnAnyTreatment
              ? `My scan shows my stage improved from ${previousStage} to ${stage} — how do I know if my OTC routine caused this and how do I sustain it?`
              : `My stage improved from ${previousStage} to ${stage} without treatment — what does this mean and should I start a protocol now?`;
          data.coachSuggestedQuestions = [_pqImprovementQ, ...data.coachSuggestedQuestions.slice(0, 2)];
        } else {
          // No stage-direction override active (first scan, stable stage, or no previousStage).
          // Replace slot 2 with a risk-profile-aware question when a high-priority lifestyle or
          // genetic risk factor is present — makes suggestion chips more targeted to the user's
          // specific situation rather than generic stage + routine combos.
          // Priority: highStress / poorSleep (reversible, highest urgency) → untreated (no protocol at active stage) → earlyOnset → familyHistoryHighRisk → noMinoxidilAtActiveStage (most important missing OTC layer) → noAntiandrogenAtModerateStage (OTC-only at NW3+, Rx upgrade opportunity) → noDHTShampooAtActiveStage → noScalpStimulationAtActiveStage → noSupplementsAtActiveStage.
          const _rff = data.riskFactorFlags;
          const _stressRelevantStages = new Set(['diffuse', 'n/a (female)', 'NW3', 'NW3v', 'NW4', 'NW5']);
          if (_rff?.highStress && _stressRelevantStages.has(stage)) {
            data.coachSuggestedQuestions = [
              ...data.coachSuggestedQuestions.slice(0, 2),
              'My stress is very high right now — could this be worsening my hair loss, and what can I do about it?',
            ];
          } else if (_rff?.poorSleep && _stressRelevantStages.has(stage)) {
            data.coachSuggestedQuestions = [
              ...data.coachSuggestedQuestions.slice(0, 2),
              'I only get about 5 hours of sleep a night — how much could poor sleep be accelerating my hair loss?',
            ];
          } else if (_rff?.untreated) {
            data.coachSuggestedQuestions = [
              ...data.coachSuggestedQuestions.slice(0, 2),
              `I'm at ${stage} and haven't started any treatment yet — what should I begin with right now?`,
            ];
          } else if (_rff?.earlyOnset) {
            const _eoAge = typeof profile.age === 'number' ? profile.age : null;
            data.coachSuggestedQuestions = [
              ...data.coachSuggestedQuestions.slice(0, 2),
              _eoAge
                ? `I'm ${_eoAge} and already at ${stage} — does early onset mean faster progression and a more aggressive protocol?`
                : `I started losing hair at a young age — does early onset mean faster progression?`,
            ];
          } else if (_rff?.familyHistoryHighRisk) {
            data.coachSuggestedQuestions = [
              ...data.coachSuggestedQuestions.slice(0, 2),
              'My family history includes advanced hair loss — how much extra urgency should this add to my treatment plan?',
            ];
          } else if (_rff?.noMinoxidilAtActiveStage) {
            data.coachSuggestedQuestions = [
              ...data.coachSuggestedQuestions.slice(0, 2),
              `I'm at ${stage} without topical minoxidil in my routine — should I add it, and what results can I realistically expect?`,
            ];
          } else if (_rff?.noAntiandrogenAtModerateStage) {
            data.coachSuggestedQuestions = [
              ...data.coachSuggestedQuestions.slice(0, 2),
              `I'm at ${stage} on OTC treatment — is it time to talk to a doctor about finasteride or dutasteride?`,
            ];
          } else if (_rff?.noDHTShampooAtActiveStage) {
            data.coachSuggestedQuestions = [
              ...data.coachSuggestedQuestions.slice(0, 2),
              `I'm at ${stage} without a DHT-blocking shampoo — how much could adding ketoconazole or a rosemary-oil shampoo help?`,
            ];
          } else if (_rff?.noScalpStimulationAtActiveStage) {
            data.coachSuggestedQuestions = [
              ...data.coachSuggestedQuestions.slice(0, 2),
              `I'm at ${stage} without scalp massage or microneedling — how much could adding mechanical stimulation improve my results?`,
            ];
          } else if (_rff?.noSupplementsAtActiveStage) {
            data.coachSuggestedQuestions = [
              ...data.coachSuggestedQuestions.slice(0, 2),
              `I'm at ${stage} without any hair supplements — which ones have the best evidence for my situation?`,
            ];
          }
        }

        // suggestedAdviceVisuals: ordered list of up to 3 advice-visual kinds for the iOS
        // app to pre-fetch for the protocol card carousel. Derived from missing protocol
        // layers (priority: topical → shampoo → supplements → massage/microneedling).
        // When specialistRecommended is true (NW5+, diffuse, n/a female), consultation
        // is guaranteed in the top-3 slot — up to 2 missing-layer visuals are taken
        // first, then consultation is appended. This prevents consultation from being
        // silently dropped when 3+ protocol layers are missing simultaneously, which
        // would happen for untreated advanced-stage users.
        data.suggestedAdviceVisuals = (() => {
          const { topical, dhtShampoo, supplements, mechanical, microneedling, lllt } = data.protocolCoverage;
          const missing = [];
          if (!topical)     missing.push('topical');
          if (!dhtShampoo)  missing.push('shampoo');
          if (!supplements) missing.push('supplements');
          if (!mechanical)                  missing.push('massage');
          else if (!microneedling && !lllt) missing.push('microneedling');
          else if (!lllt)                   missing.push('lllt');
          if (data.specialistRecommended) {
            return [...missing.slice(0, 2), 'consultation'];
          }
          return missing.slice(0, 3);
        })();

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
        // Friendly label for the check-in interval already set above.
        const _dayLabel = data.checkInIntervalDays === 28 ? '4 weeks'
          : data.checkInIntervalDays === 42 ? '6 weeks'
          : '2 months';
        const _STAGE_CHECKIN_REASONS = {
          'NW1':  profile.routine.length > 0
            ? `Your scalp is fully intact — rescan in ${_dayLabel} to confirm prevention is holding; subtle early temple shifts are easy to miss without a periodic baseline comparison`
            : `Your scalp is fully intact — now is the ideal time to start a protective protocol (DHT-blocking shampoo, scalp massage) before any change begins. Rescan in ${_dayLabel} to baseline your starting point`,
          'NW2':  profile.routine.length > 0
            ? `Early temple recession is highly responsive to treatment — rescan in ${_dayLabel} to catch the first density response before it's visible in the mirror`
            : `NW2 is the highest-response window — start a consistent OTC protocol (topical minoxidil + DHT-blocking shampoo) before the window narrows, then rescan in ${_dayLabel} to baseline your starting point`,
          'NW3':  profile.routine.length > 0
            ? `Deep recession at NW3 responds strongly to a consistent protocol — rescan in ${_dayLabel} to see if the miniaturization edge is stabilizing`
            : `NW3 is still in the active response window — every month without treatment narrows that window. Start a consistent protocol (minoxidil + DHT suppression) and rescan in ${_dayLabel} to capture your baseline`,
          'NW3v': profile.routine.length > 0
            ? `Both active zones (temples and early crown) are in the treatment-response window — rescan in ${_dayLabel} to measure density progress across both active fronts`
            : `Both active zones (temples and early crown) are in the treatment-response window — starting a full protocol now matters. Rescan in ${_dayLabel} once treatment is underway to baseline both zones`,
          'NW4':  profile.routine.length > 0
            ? `Consistent multi-layer treatment at NW4 produces measurable results over 4-6 weeks — rescan in ${_dayLabel} to track stabilization across both the frontal and crown zones`
            : `NW4 still responds to consistent treatment — starting now slows further progression and sets the baseline. Rescan in ${_dayLabel} once treatment is started to track early stabilization`,
          'NW5':  profile.routine.length > 0
            ? `OTC treatment at NW5 primarily slows progression rather than reversing it — rescan in ${_dayLabel} to confirm the rate of change is stabilizing`
            : `NW5 responds mainly to slowing progression rather than reversal — starting OTC treatment (minoxidil) is still worthwhile. Rescan in ${_dayLabel} once started to capture your baseline`,
          'NW6':  profile.routine.length > 0
            ? `Your current protocol is maintaining the remaining fringe at NW6 — rescan in ${_dayLabel} to track fringe density and evaluate whether surgical planning is the right next move alongside your OTC routine`
            : `At NW6 the fringe and temporal edges are the last OTC-responsive zones — starting minoxidil on the fringe now slows further loss. Rescan in ${_dayLabel} and consider a trichologist consultation alongside any OTC protocol`,
          'NW7':  profile.routine.length > 0
            ? `Your current protocol is maintaining the horseshoe fringe at NW7 — rescan in ${_dayLabel} to monitor fringe density and inform any surgical planning around your available donor reserve`
            : `At NW7 the horseshoe fringe is the priority — starting OTC treatment (minoxidil on the fringe) helps maintain what remains. Rescan in ${_dayLabel} and book a surgical consultation to understand donor candidacy`,
          'diffuse':      profile.routine.length > 0
            ? `Treatment is active — rescan in ${_dayLabel} to measure response; diffuse thinning with a managed root cause often begins to stabilize within the first 1-2 check-in cycles`
            : `Identify the root cause first: book a workup (ferritin, thyroid, hormones) — rescan in ${_dayLabel} once treatment is started to measure initial response`,
          'n/a (female)': profile.routine.length > 0
            ? `Treatment is active — rescan in ${_dayLabel} to measure response; female-pattern or hormonal thinning often shows first signs of stabilization within the first few scan cycles`
            : `Hormonal workup is step one: ferritin, thyroid, hormone panel — rescan in ${_dayLabel} once treatment is started to measure initial response`,
        };
        data.nextCheckInReason = _STAGE_CHECKIN_REASONS[stage]
          ?? (URGENCY_REASONS[data.treatmentUrgency] || 'Check back regularly to track progress');

        const scanUsage = scanPayload.usage;
        if (scanUsage) {
          METRICS.scan.promptTokens     += scanUsage.prompt_tokens     || 0;
          METRICS.scan.completionTokens += scanUsage.completion_tokens || 0;
        }
        // riskFactorFlags: structured boolean signals the iOS app can use to surface
        // contextual alerts or CTAs (e.g. "early onset detected") without parsing text.
        // All flags are server-side derived — never sent to GPT-4o or included in prompts.
        const _hasAntiandrogen = profile.routine.some(r =>
          /finasteride|dutasteride|propecia|proscar|avodart|spironolactone|\bspiro\b|bicalutamide|flutamide|cyproterone|androcur/i.test(r)
        );
        data.riskFactorFlags = {
          earlyOnset:                    profile.age !== null && profile.age < 30 && (STAGE_SEVERITY_INDEX[stage] ?? 0) >= 3,
          familyHistoryHighRisk:         profile.family.some(f => /NW[567]|advanced|total|severe|complete/i.test(f)),
          highStress:                    profile.lifestyle.stress !== null && profile.lifestyle.stress >= 7,
          poorSleep:                     profile.lifestyle.sleep  !== null && profile.lifestyle.sleep  <= 5,
          untreated:                     profile.routine.length === 0 && (STAGE_SEVERITY_INDEX[stage] ?? 0) >= 2,
          // True when the user is at a stage where antiandrogens (finasteride, dutasteride,
          // spironolactone, etc.) provide the most clinical benefit but none is in their routine.
          // The iOS app uses this to surface "consider adding an antiandrogen" CTAs at NW3+/diffuse/female.
          noAntiandrogenAtModerateStage: (STAGE_SEVERITY_INDEX[stage] ?? 0) >= 3 && !_hasAntiandrogen,
          // True when the user is at an active loss stage (NW2+) but no topical minoxidil or
          // equivalent vasodilator is in their routine. Minoxidil is the most evidence-backed OTC
          // treatment for AGA and is first-line at NW2+; absence is a clear actionable gap.
          // The iOS app uses this to surface "consider adding topical minoxidil" CTAs.
          // Uses protocolCoverage.topical (computed above) which maps to _hasMinoxidil detection.
          noMinoxidilAtActiveStage:      (STAGE_SEVERITY_INDEX[stage] ?? 0) >= 2 && !data.protocolCoverage.topical,
          // True when the user is at NW3+ (established or advanced AGA) but has no mechanical
          // scalp stimulation in their routine — no scalp massage, microneedling, or LLLT device.
          // Mechanical stimulation at NW3+ significantly amplifies minoxidil absorption (up to 3×
          // increase in follicular uptake with microneedling) and is consistently listed as the
          // highest-ROI addition when minoxidil is already in place. The iOS app uses this to
          // surface "add scalp massage or microneedling" CTAs at the appropriate treatment stage.
          // Uses protocolCoverage.mechanical (computed above) which covers massage/microneedling/LLLT.
          noScalpStimulationAtActiveStage: (STAGE_SEVERITY_INDEX[stage] ?? 0) >= 3 && !data.protocolCoverage.mechanical,
          // True when the user is at an active loss stage (NW2+) but has no DHT-blocking shampoo
          // (ketoconazole, Nizoral, rosemary-oil shampoo, or equivalent) in their routine.
          // Ketoconazole shampoo is the lowest-cost, most accessible OTC adjunct for AGA and is
          // recommended as a base-layer complement to minoxidil from NW2 onward. Its anti-androgenic
          // action at the follicle level adds meaningful DHT suppression when Rx is not yet in use,
          // and amplifies minoxidil efficacy when used together. The iOS app uses this to surface
          // "consider adding a DHT-blocking shampoo" CTAs alongside the minoxidil CTA at NW2+.
          noDHTShampooAtActiveStage: (STAGE_SEVERITY_INDEX[stage] ?? 0) >= 2 && !data.protocolCoverage.dhtShampoo,
          // True when the user is at an active loss stage (NW2+) but has no nutritional supplements
          // (biotin, zinc, vitamin D, saw palmetto, Nutrafol, etc.) in their routine.
          // Supplements are the lowest-barrier foundational layer alongside DHT shampoo —
          // accessible OTC, no prescription needed, and consistently recommended as nutritional
          // follicle support at every stage of AGA. The iOS app uses this to surface
          // "consider adding a hair supplement" CTAs for users missing this layer entirely.
          noSupplementsAtActiveStage: (STAGE_SEVERITY_INDEX[stage] ?? 0) >= 2 && !data.protocolCoverage.supplements,
        };

        console.log('[vision] ok', { overall: data.overall, stage: data.stage, photoQuality: data.photoQuality, ms: Date.now() - startedAt, tokens: scanUsage ? { prompt: scanUsage.prompt_tokens, completion: scanUsage.completion_tokens } : null, reqId });
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
      bumpSuccess(METRICS.scan);
      warnIfSlow('analyze-scan', startedAt, 'scan');
      // stageChanged/stageDirection and score deltas are computed here (not cached)
      // because they depend on the caller's previousStage/previousScores which vary
      // between requests for the same cached scan result.
      json(req, res, 200, { ...scanOutcome.data, ...computeStageChange(scanOutcome.data.stage, previousStage), ...computeScoreDeltas(scanOutcome.data, previousScores), requestId: reqId });
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
  if (req.method === 'POST' && reqPath === '/api/coach') {
    try {
      METRICS.coach.requests++;
      const { message, history = [], userContext = {} } = await readJsonBody(req);
      if (typeof message !== 'string' || !message.trim()) {
        // Whitespace-only messages produce a wasteful OpenAI call and a nonsensical reply;
        // reject them client-side with a 400 instead of paying tokens to find that out.
        const err = new Error('message required (must be a non-empty string)');
        err.statusCode = 400;
        throw err;
      }
      const startedAt = Date.now();
      const coachProfile = sanitizeProfile(userContext.profile);

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
          photoGuidance:     userContext.result.photoGuidance ? String(userContext.result.photoGuidance).slice(0, 350) : null,
          treatmentUrgency:  userContext.result.treatmentUrgency || null,
          checkInIntervalDays: typeof userContext.result.checkInIntervalDays === 'number' ? userContext.result.checkInIntervalDays : null,
          nextCheckIn:       userContext.result.nextCheckIn || null,
          scoredAt:          userContext.result.scoredAt || null,
          currentStateScore: typeof userContext.result.currentStateScore === 'number' ? userContext.result.currentStateScore : null,
          weeklyFocus:       userContext.result.weeklyFocus ? String(userContext.result.weeklyFocus).slice(0, 600) : null,
          nextCheckInReason: userContext.result.nextCheckInReason ? String(userContext.result.nextCheckInReason).slice(0, 200) : null,
          thinningPattern:   userContext.result.thinningPattern || null,
          stageSeverityLabel: userContext.result.stageSeverityLabel ? String(userContext.result.stageSeverityLabel).slice(0, 20) : null,
          weeklyFocusMetric:  userContext.result.weeklyFocusMetric  ? String(userContext.result.weeklyFocusMetric).slice(0, 20)  : null,
          weeklyFocusSecondary: userContext.result.weeklyFocusSecondary ? String(userContext.result.weeklyFocusSecondary).slice(0, 600) : null,
          weeklyFocusSecondaryMetric: userContext.result.weeklyFocusSecondaryMetric ? String(userContext.result.weeklyFocusSecondaryMetric).slice(0, 20) : null,
          specialistRecommended: userContext.result.specialistRecommended ?? false,
          specialistReason: userContext.result.specialistReason ? String(userContext.result.specialistReason).slice(0, 300) : null,
          protocolCoverage: userContext.result.protocolCoverage
            ? {
                topical:      !!userContext.result.protocolCoverage.topical,
                rx:           !!userContext.result.protocolCoverage.rx,
                dhtShampoo:   !!userContext.result.protocolCoverage.dhtShampoo,
                mechanical:   !!userContext.result.protocolCoverage.mechanical,
                microneedling:!!userContext.result.protocolCoverage.microneedling,
                lllt:         !!userContext.result.protocolCoverage.lllt,
                supplements:  !!userContext.result.protocolCoverage.supplements,
              }
            : null,
          protocolStrengthScore: typeof userContext.result.protocolStrengthScore === 'number' ? userContext.result.protocolStrengthScore : null,
          protocolStrengthLabel: userContext.result.protocolStrengthLabel ? String(userContext.result.protocolStrengthLabel).slice(0, 20) : null,
          overallDelta:          typeof userContext.result.overallDelta === 'number' ? userContext.result.overallDelta : null,
          overallDeltaDirection: userContext.result.overallDeltaDirection || null,
          hairlineDelta:         typeof userContext.result.hairlineDelta === 'number' ? userContext.result.hairlineDelta : null,
          densityDelta:          typeof userContext.result.densityDelta  === 'number' ? userContext.result.densityDelta  : null,
          crownDelta:            typeof userContext.result.crownDelta    === 'number' ? userContext.result.crownDelta    : null,
          healthDelta:           typeof userContext.result.healthDelta   === 'number' ? userContext.result.healthDelta   : null,
          potentialDelta:        typeof userContext.result.potentialDelta === 'number' ? userContext.result.potentialDelta : null,
          stageChanged:          userContext.result.stageChanged ?? null,
          stageDirection:        userContext.result.stageDirection || null,
        } : null,
        routine: Array.isArray(userContext.routine) ? userContext.routine.slice(0, 20).map((s) => String(s ?? '').slice(0, 80)) : [],
        scanHistory: Array.isArray(userContext.history) ? userContext.history.slice(-6) : [],
        planProducts: Array.isArray(userContext.planProducts) ? userContext.planProducts.slice(0, 8).map((s) => String(s ?? '').slice(0, 80)) : [],
        routineDoneToday: Array.isArray(userContext.routineDoneToday) ? userContext.routineDoneToday.slice(0, 12).map((s) => String(s ?? '').slice(0, 80)) : [],
        weakestMetric:        userContext.weakestMetric        || userContext.result?.weakestMetric        || null,
        secondWeakestMetric:  userContext.secondWeakestMetric  || userContext.result?.secondWeakestMetric  || null,
        strongestMetric:      userContext.strongestMetric      || userContext.result?.strongestMetric      || null,
        age:           coachProfile.age,
        sex:           coachProfile.sex || null,
        goals:         coachProfile.goals,
        concerns:      coachProfile.concern,
        timeline:      coachProfile.timeline || null,
        familyHistory: coachProfile.family,
        lifestyle:     coachProfile.lifestyle || {},
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

      // Compute thinning pattern evolution from scan history (newest-first → reverse for chronological).
      const patternSeq = ctx.scanHistory.map((h) => h.thinningPattern).filter(Boolean);
      const patternTrendStr = patternSeq.length >= 2 ? [...patternSeq].reverse().join(' → ') : null;
      const patternChanged = patternSeq.length >= 2 && patternSeq[0] !== patternSeq[patternSeq.length - 1];

      // Compute treatment journey duration from oldest scan in history (or current scan if history is empty).
      // scanHistory is newest-first, so the last element is the oldest scan.
      const firstEntry = ctx.scanHistory.length >= 1 ? ctx.scanHistory[ctx.scanHistory.length - 1] : ctx.scan;
      const firstScanDateStr = firstEntry?.scoredAt?.split('T')[0] ?? null;
      const daysSinceFirst = firstScanDateStr
        ? Math.floor((Date.now() - new Date(firstScanDateStr).getTime()) / (24 * 60 * 60 * 1000))
        : null;
      const trackingDurationStr = daysSinceFirst === null ? null
        : daysSinceFirst === 0 ? 'just started (first scan today)'
        : daysSinceFirst < 7  ? `${daysSinceFirst} day${daysSinceFirst !== 1 ? 's' : ''}`
        : daysSinceFirst < 56 ? `${Math.floor(daysSinceFirst / 7)} week${Math.floor(daysSinceFirst / 7) !== 1 ? 's' : ''}`
        : (() => {
            const months = Math.round(daysSinceFirst / 30.44);
            return months < 12
              ? `${months} month${months !== 1 ? 's' : ''}`
              : (() => { const yrs = Math.floor(months / 12); const rem = months % 12; return rem === 0 ? `${yrs} year${yrs !== 1 ? 's' : ''}` : `${yrs} year${yrs !== 1 ? 's' : ''} ${rem} month${rem !== 1 ? 's' : ''}`; })();
          })();

      // Most-recent scan interval: delta from second-to-last scan to latest scan.
      // Distinct from trendStr (oldest→newest). Lets the coach answer "is it working?"
      // with the most recent change rather than the all-time average.
      let recentIntervalStr = null;
      if (ctx.scanHistory.length >= 2) {
        const latest = ctx.scanHistory[0];
        const prev   = ctx.scanHistory[1];
        const recentDelta = typeof latest.overall === 'number' && typeof prev.overall === 'number'
          ? latest.overall - prev.overall
          : null;
        if (recentDelta !== null) {
          const direction  = recentDelta > 1 ? 'improving' : recentDelta < -1 ? 'declining' : 'stable';
          const latestDate = latest.scoredAt ? latest.scoredAt.split('T')[0] : null;
          const prevDate   = prev.scoredAt   ? prev.scoredAt.split('T')[0]   : null;
          const dateRange  = latestDate && prevDate ? ` (${prevDate} → ${latestDate})` : '';
          const recentMetricParts = [];
          for (const [label, key] of [['Hairline','hairline'],['Density','density'],['Crown','crown'],['Health','health'],['Potential','potential']]) {
            const n = typeof latest[key] === 'number' ? latest[key] : null;
            const p = typeof prev[key]   === 'number' ? prev[key]   : null;
            if (n !== null && p !== null && n !== p) {
              recentMetricParts.push(`${label} ${n - p >= 0 ? '+' : ''}${n - p}`);
            }
          }
          recentIntervalStr = `${recentDelta >= 0 ? '+' : ''}${recentDelta} overall${dateRange} (${direction})${recentMetricParts.length ? '; by metric: ' + recentMetricParts.join(', ') : ''}`;
        }
      }

      const todayStr = new Date().toISOString().split('T')[0];
      const todayMs = Date.now();
      const daysSinceLastScan = ctx.scan?.scoredAt
        ? Math.floor((todayMs - new Date(ctx.scan.scoredAt).getTime()) / (24 * 60 * 60 * 1000))
        : null;
      // Compute actual days remaining until nextCheckIn from TODAY, not from scan date.
      // checkInIntervalDays is fixed at scan time (e.g. 28); after 60 days it's misleading
      // to still say "in 28 days". This gives the coach an accurate countdown (or overdue flag).
      const nextCheckInMs = ctx.scan?.nextCheckIn ? new Date(ctx.scan.nextCheckIn).getTime() : null;
      const daysUntilNextScan = nextCheckInMs !== null ? Math.round((nextCheckInMs - todayMs) / (24 * 60 * 60 * 1000)) : null;
      const scanIsOverdue = daysUntilNextScan !== null && daysUntilNextScan < 0;
      // Derive effective protocol coverage for the coach context.
      // Two cases where routine derivation is preferred over the stale scan snapshot:
      //   • !pc && ctx.routine.length > 0 — no scan yet; ensures status lines are available
      //     before the first scan when the user has already set up their routine.
      //   • pc exists but routine changed — reflects post-scan additions without a rescan.
      // Falls back to scan-time protocolCoverage only when routine is empty.
      const coachProtocolCoverage = (() => {
        const pc = ctx.scan?.protocolCoverage ?? null;
        if (ctx.routine.length > 0) {
          const r = ctx.routine.map((s) => String(s).toLowerCase());
          return {
            topical:     r.some((s) => s.includes('minoxidil') || s.includes('rogaine') || s.includes('regaine') || s.includes('minox') || s.includes('kirkland') || s.includes('tugain') || s.includes('mintop') || s.includes('loniten') || s.includes('nanoxidil') || s.includes('morr') || s.includes('hims') || s.includes('keeps')),
            rx:          r.some((s) => s.includes('finasteride') || s.includes('propecia') || s.includes('dutasteride') || s.includes('avodart') || s.includes('proscar') || s.includes('finpecia') || s.includes('finalo') || s.includes('finast') || s.includes('fincar') || s.includes('finax') || s.includes('aindeem') || s.includes('spironolactone') || s.includes('spiro') || s.includes('aldactone') || s.includes('bicalutamide') || s.includes('casodex') || s.includes('flutamide') || s.includes('cyproterone') || s.includes('androcur') || s.includes('clascoterone') || s.includes('winlevi')),
            dhtShampoo:  r.some((s) => s.includes('dht') || s.includes('ketoconazole') || s.includes('nizoral') || s.includes('keto shampoo') || s.includes('caffeine shampoo') || s.includes('regenepure') || s.includes('alpecin') || s.includes('plantur') || s.includes('foligain') || s.includes('lipogaine') || s.includes('revita') || s.includes('pura d') || s.includes('shapiro md') || s.includes('rosemary oil') || s.includes('mielle') || s.includes('maple holistics') || s.includes('nioxin') || s.includes('keranique') || s.includes('ultrax') || s.includes('phytocyane') || s.includes('bioxsine') || s.includes('watermans') || s.includes('anaphase') || s.includes('vichy') || s.includes('dercos') || s.includes('klorane') || s.includes('rene furterer') || s.includes('triphasic') || s.includes('ducray') || s.includes('bioscalin') || s.includes('revivogen') || s.includes('pronexa')),
            mechanical:    r.some((s) => s.includes('massage') || s.includes('dermaroller') || s.includes('derma roller') || s.includes('derma stamp') || s.includes('dermastamp') || s.includes('dermapen') || s.includes('microneedl') || s.includes('micro-needl') || s.includes('dr pen') || s.includes('drpen') || s.includes('dr.pen') || s.includes('zgts') || s.includes('derminator') || s.includes('lllt') || s.includes('laser cap') || s.includes('laser comb') || s.includes('laser helmet') || s.includes('laserband') || s.includes('laser band') || s.includes('capillus') || s.includes('hairmax') || s.includes('irestore') || s.includes('igrow') || s.includes('theradome') || s.includes('kiierr') || s.includes('illumiflow') || s.includes('sunetics')),
            microneedling: r.some((s) => s.includes('microneedl') || s.includes('micro-needl') || s.includes('dermaroller') || s.includes('derma roller') || s.includes('derma stamp') || s.includes('dermastamp') || s.includes('dermapen') || s.includes('dr pen') || s.includes('drpen') || s.includes('dr.pen') || s.includes('zgts') || s.includes('derminator')),
            lllt:          r.some((s) => s.includes('lllt') || s.includes('laser cap') || s.includes('laser comb') || s.includes('laser helmet') || s.includes('laserband') || s.includes('laser band') || s.includes('capillus') || s.includes('hairmax') || s.includes('irestore') || s.includes('igrow') || s.includes('theradome') || s.includes('kiierr') || s.includes('illumiflow') || s.includes('sunetics')),
            supplements:   r.some((s) => s.includes('supplement') || s.includes('biotin') || s.includes('vitamin') || s.includes('zinc') || s.includes('saw palmetto') || s.includes('nutrafol') || s.includes('viviscal') || (s.includes('iron') && !s.includes('flat iron') && !s.includes('curling iron') && !s.includes('steam iron') && !s.includes('hair iron') && !s.includes('flat-iron') && !s.includes('curling-iron')) || s.includes('pumpkin seed') || s.includes('folexin') || s.includes('hairfinity') || s.includes('perfectil') || s.includes('hairburst') || s.includes('collagen') || (s.includes('keratin') && !s.includes('keratin treatment') && !s.includes('keratin therapy') && !s.includes('keratin complex') && !s.includes('keratin smoothing') && !s.includes('keratin straighten') && !s.includes('keratin blowout')) || s.includes('marine collagen') || s.includes('hair formula') || s.includes('omega') || s.includes('fish oil') || s.includes('folic acid') || s.includes('folate') || s.includes('silica') || s.includes('niacin') || s.includes('evening primrose') || s.includes('selenium') || s.includes('magnesium') || s.includes('copper') || s.includes('lysine') || s.includes('msm') || s.includes('ashwagandha') || s.includes('nettle') || s.includes('beta-sitosterol') || s.includes('hair gum') || s.includes('multivitamin') || s.includes('nourkrin') || s.includes('priorin') || s.includes('hair vitalics') || s.includes('pantogar') || s.includes('bhringraj') || s.includes('sugarbear') || s.includes('vegamour') || s.includes('hair la vie') || s.includes('foligrowth') || s.includes('pantovigar') || s.includes('philip kingsley') || s.includes('tricho complex') || s.includes('florisene') || s.includes('lambdapil') || s.includes('hum nutrition') || s.includes('anacaps') || s.includes('pilexil') || s.includes('reishi') || s.includes('black seed') || s.includes('fo-ti') || s.includes('he shou wu') || s.includes('pycnogenol') || s.includes('moringa') || s.includes('horsetail') || s.includes('inneov') || s.includes('bioscalin') || s.includes('inositol') || s.includes('spermidine') || s.includes('diindolylmethane') || s.includes(' dim ') || s.includes('dim supplement') || s.includes('green tea extract') || s.includes('egcg') || s.includes('grape seed') || s.includes('procyanidin') || s.includes('resveratrol') || s.includes('turmeric') || s.includes('curcumin') || s.includes('berberine') || s.includes('ginkgo') || s.includes('nac') || s.includes('n-acetyl') || s.includes('coq10') || s.includes('coenzyme q') || s.includes('l-carnitine') || s.includes('carnitine tartrate') || s.includes('quercetin') || s.includes('melatonin') || s.includes('olly') || s.includes('astaxanthin') || s.includes('milk thistle') || s.includes('silymarin') || s.includes('spearmint') || s.includes('licorice root') || s.includes('pygeum') || s.includes('fenugreek') || s.includes('tocopherol') || s.includes('ascorbic acid') || s.includes('pantothenic acid') || s.includes('vitamin b5') || s.includes('l-cysteine') || s.includes('maca') || s.includes('lion') || s.includes('cordyceps') || s.includes('rhodiola') || s.includes('adaptogen') || s.includes('stinging nettle') || s.includes('amla')),
          };
        }
        return pc;
      })();

      // Build a structured protocol-layer status line for the coach system prompt.
      // Avoids asking gpt-4o-mini to infer what layers are active/missing from raw routine text.
      const protocolStatusLine = (() => {
        const pc = coachProtocolCoverage;
        if (!pc) return '';
        const active = [];
        const missing = [];
        if (pc.topical)                 active.push('minoxidil');                                           else missing.push('minoxidil');
        if (pc.rx) {
          // Surface the specific Rx drug(s) from the live routine — different antiandrogens have
          // completely different mechanisms, routes (oral vs topical), and usage instructions.
          // Finasteride = oral systemic 5-AR inhibitor; clascoterone = topical androgen receptor
          // blocker applied to scalp; spironolactone = oral diuretic-antiandrogen (primary female Rx).
          // Knowing the specific drug lets the coach give accurate timing/application advice.
          const _RX_LABELS = [
            ['finasteride', 'finasteride'], ['propecia', 'finasteride'], ['proscar', 'finasteride'],
            ['finpecia', 'finasteride'],    ['finalo', 'finasteride'],   ['finast', 'finasteride'],
            ['fincar', 'finasteride'],      ['finax', 'finasteride'],    ['aindeem', 'finasteride'],
            ['dutasteride', 'dutasteride'], ['avodart', 'dutasteride'],
            ['spironolactone', 'spironolactone'], ['spiro', 'spironolactone'], ['aldactone', 'spironolactone'],
            ['bicalutamide', 'bicalutamide'], ['casodex', 'bicalutamide'],
            ['flutamide', 'flutamide'],
            ['cyproterone', 'cyproterone acetate'], ['androcur', 'cyproterone acetate'],
            ['clascoterone', 'clascoterone (Winlevi — topical androgen receptor blocker, apply to scalp)'],
            ['winlevi', 'clascoterone (Winlevi — topical androgen receptor blocker, apply to scalp)'],
          ];
          const _rl = ctx.routine.map((s) => String(s).toLowerCase());
          const _rxFound = [];
          for (const [kw, label] of _RX_LABELS) {
            if (_rl.some((r) => r.includes(kw)) && !_rxFound.includes(label)) {
              _rxFound.push(label);
              if (_rxFound.length >= 2) break;
            }
          }
          active.push(_rxFound.length ? `Rx antiandrogen (${_rxFound.join(' + ')})` : 'Rx antiandrogen (finasteride/dutasteride/spironolactone/bicalutamide/flutamide/cyproterone/clascoterone)');
        } else missing.push('Rx antiandrogen');
        if (pc.dhtShampoo)              active.push('DHT-blocking shampoo');                                else missing.push('DHT-blocking shampoo');
        if (pc.lllt) {
          // Surface specific LLLT device from live routine for personalized session timing advice.
          const _LLLT_LABELS = [
            ['capillus', 'Capillus'], ['hairmax', 'HairMax'], ['irestore', 'iRestore'],
            ['igrow', 'iGrow'], ['theradome', 'Theradome'], ['kiierr', 'Kiierr'],
            ['illumiflow', 'illumiflow'], ['sunetics', 'Sunetics (clinical)'],
            ['laserband', 'HairMax LaserBand'], ['laser band', 'HairMax LaserBand'],
            ['laser cap', 'laser cap'], ['laser helmet', 'laser helmet'], ['laser comb', 'laser comb'],
          ];
          const _rl4 = ctx.routine.map((s) => String(s).toLowerCase());
          let _llltDevice = null;
          for (const [kw, label] of _LLLT_LABELS) {
            if (_rl4.some((r) => r.includes(kw))) { _llltDevice = label; break; }
          }
          active.push(_llltDevice ? `LLLT (${_llltDevice})` : 'LLLT (laser cap/comb — Capillus, HairMax, etc.)');
        }
        if (pc.microneedling) {
          // Surface specific device type so coach can reference the correct tool by name.
          const _NEEDLE_LABELS = [
            ['dermapen', 'Dermapen (electric)'], ['dr pen', 'Dr.Pen (electric)'],
            ['drpen', 'Dr.Pen (electric)'], ['dr.pen', 'Dr.Pen (electric)'],
            ['derminator', 'Derminator (electric)'], ['derma stamp', 'derma stamp'],
            ['dermastamp', 'derma stamp'], ['dermaroller', 'dermaroller'],
            ['derma roller', 'dermaroller'], ['zgts', 'ZGTS roller'],
          ];
          const _rl5 = ctx.routine.map((s) => String(s).toLowerCase());
          let _needleDevice = null;
          for (const [kw, label] of _NEEDLE_LABELS) {
            if (_rl5.some((r) => r.includes(kw))) { _needleDevice = label; break; }
          }
          active.push(_needleDevice
            ? `microneedling (${_needleDevice} — apply minoxidil 24-48h after each session, not same-day)`
            : 'microneedling (apply minoxidil 24-48h after each session, not same-day)');
        }
        if (pc.mechanical && !pc.microneedling && !pc.lllt)       active.push('scalp massage');
        if (!pc.mechanical)                                       missing.push('scalp massage/microneedling');
        if (pc.supplements) {
          // Surface the detected supplement name(s) from the live routine for coach context.
          // Do NOT hardcode "biotin/zinc/vitamin D" — many users take nutrafol, viviscal,
          // spermidine, procyanidin, EGCG, or other advanced stacks; the specific product
          // matters for accurate optimization advice (e.g. timing, dosage, stacking strategy).
          const _SUPP_LABELS = [
            ['nutrafol',       'nutrafol'],  ['viviscal',      'viviscal'],
            ['nourkrin',       'nourkrin'],  ['priorin',       'priorin'],
            ['pantogar',       'pantogar'],  ['pantovigar',    'pantovigar'],
            ['vegamour',       'vegamour'],  ['hair la vie',   'Hair la Vie'],
            ['foligrowth',     'foligrowth'], ['folexin',      'folexin'],
            ['hairfinity',     'hairfinity'], ['perfectil',    'perfectil'],
            ['hairburst',      'hairburst'], ['hair gum',      'hair gum'],
            ['philip kingsley','Philip Kingsley tricho complex'], ['tricho complex', 'tricho complex'],
            ['florisene',      'florisene'], ['hum nutrition', 'HUM nutrition'],
            ['anacaps',        'anacaps'],   ['pilexil',       'pilexil'],
            ['lambdapil',      'lambdapil'], ['bioscalin',     'bioscalin'],
            ['inneov',         'inneov'],
            ['spermidine',     'spermidine'], ['procyanidin',  'procyanidin'],
            ['grape seed',     'grape seed extract'], ['resveratrol', 'resveratrol'],
            ['egcg',           'EGCG'], ['green tea extract', 'EGCG/green tea'],
            ['diindolylmethane','DIM'], ['dim supplement',   'DIM'], [' dim ', 'DIM'],
            ['inositol',       'inositol'],  ['pycnogenol',   'pycnogenol'],
            ['saw palmetto',   'saw palmetto'], ['pumpkin seed', 'pumpkin seed oil'],
            ['beta-sitosterol','beta-sitosterol'],
            ['ashwagandha',    'ashwagandha'], ['fo-ti',       'fo-ti/he shou wu'],
            ['he shou wu',     'fo-ti/he shou wu'],
            ['collagen',       'collagen'],  ['marine collagen','marine collagen'],
            ['omega',          'omega/fish oil'], ['fish oil',   'omega/fish oil'],
            ['biotin',         'biotin'],    ['zinc',         'zinc'],
            ['vitamin d',      'vitamin D'], ['folic acid',   'folate'],
            ['folate',         'folate'],    ['iron',         'iron'],
            ['silica',         'silica'],    ['niacin',       'niacin'],
            ['selenium',       'selenium'],  ['magnesium',    'magnesium'],
            ['copper',         'copper'],    ['lysine',       'L-lysine'],
            ['msm',            'MSM'],       ['nettle',       'nettle root'],
            ['horsetail',      'horsetail'], ['evening primrose', 'evening primrose oil'],
            ['bhringraj',      'bhringraj'], ['moringa',      'moringa'],
            ['reishi',         'reishi'],    ['black seed',   'black seed'],
            ['multivitamin',   'multivitamin'], ['sugarbear',  'SugarBear'],  ['olly',       'Olly hair vitamins'],
            ['turmeric',       'turmeric/curcumin'], ['curcumin',   'curcumin'],
            ['berberine',      'berberine'],   ['ginkgo',     'ginkgo biloba'],
            ['nac',            'NAC'],         ['n-acetyl',   'NAC (N-acetyl cysteine)'],
            ['coq10',          'CoQ10'],       ['coenzyme q', 'CoQ10'],
            ['l-carnitine',    'L-carnitine'], ['carnitine tartrate', 'L-carnitine L-tartrate'],
            ['quercetin',      'quercetin'],   ['melatonin',  'melatonin'],
            ['astaxanthin',    'astaxanthin'], ['milk thistle','milk thistle'],
            ['silymarin',      'silymarin'],   ['spearmint',  'spearmint'],
            ['licorice root',  'licorice root'], ['pygeum',   'pygeum'],
            ['fenugreek',      'fenugreek'],   ['tocopherol', 'vitamin E'],
            ['ascorbic acid',  'vitamin C'],   ['pantothenic acid', 'pantothenic acid (B5)'],
            ['vitamin b5',     'vitamin B5'],  ['l-cysteine', 'L-cysteine'],
            ['maca',           'maca root'],   ['lion',       'lion\'s mane'],
            ['cordyceps',      'cordyceps'],   ['rhodiola',   'rhodiola'],
            ['amla',           'amla/Indian gooseberry'],
          ];
          const _rl = ctx.routine.map((s) => String(s).toLowerCase());
          const _found = [];
          for (const [kw, label] of _SUPP_LABELS) {
            if (_rl.some((r) => r.includes(kw)) && !_found.includes(label)) {
              _found.push(label);
              if (_found.length >= 3) break;
            }
          }
          active.push(_found.length ? `supplements (${_found.join(' + ')})` : 'supplements');
        } else {
          missing.push('supplements');
        }
        return `- Protocol layers — ACTIVE: ${active.join(', ') || 'none'}; NOT STARTED: ${missing.join(', ') || 'none'} — when the user asks what to add next, which layer is missing, or how complete their protocol is, use this structured breakdown; never re-suggest an ACTIVE layer. For supplements listed as ACTIVE, reference the specific product shown in parentheses when giving optimization advice rather than defaulting to generic "biotin/zinc/vitamin D".`;
      })();
      const systemPrompt = [
        'You are HairlineCheck Coach — an AI specialist on male/female hair loss.',
        'Tone: friendly, direct, evidence-based. Avoid medical disclaimers unless specifically asked.',
        'Constraints: never prescribe Rx drugs; recommend talking to a doctor for finasteride/dutasteride/spironolactone/bicalutamide/flutamide/cyproterone (and any other Rx-only treatments — including spironolactone for female users).',
        'Length: short, scannable. Use bullets when listing options.',
        'ROUTINE RULE: Always check "Current routine" below before recommending any treatment or product. If something is already listed (e.g. minoxidil, finasteride, DHT shampoo, supplements), do NOT suggest starting it — acknowledge it is active and instead suggest how to optimize it (application technique, timing, coverage area, contact time) or recommend a complementary next step they have not yet tried. If the user asks whether they should do their treatment today or whether they have already done it, check the "Routine tasks completed today" list: if the treatment appears there, confirm they are on track and reinforce the consistency streak; if it is in their routine but not yet listed as done today, gently remind them to complete it.',
        'Response style: answer directly. Do NOT open with affirmations or filler ("Great!", "Absolutely!", "Of course!", "Sure thing!", "That\'s a great question!"). Start with the substance of your answer. Do NOT close with generic motivational CTAs or marketing phrases ("Start your journey today!", "Take the first step!", "You\'ve got this!", "Begin your transformation!") — end with the most specific actionable point.',
        '',
        `Today's date: ${todayStr}.`,
        'User context (use when relevant, do not parrot back verbatim):',
        ctx.scan
          ? `- Last scan: overall ${ctx.scan.overall}/100 (current state ${ctx.scan.currentStateScore ?? ctx.scan.overall}/100 excl. potential), hairline ${ctx.scan.hairline}, density ${ctx.scan.density}, crown ${ctx.scan.crown}, health ${ctx.scan.health}, potential ${ctx.scan.potential}.`
          : '- No scan yet. Encourage the user to complete their first scalp scan (tap the Scan tab) to unlock personalized scores, Norwood stage, and targeted weekly focus. Until then, answer general hair health questions using the profile context below.',
        ctx.scan?.stage && NORWOOD_GUIDE[ctx.scan.stage]
          ? `- Norwood stage: ${ctx.scan.stage} (${NORWOOD_GUIDE[ctx.scan.stage]}).`
          : ctx.scan?.stage ? `- Norwood stage: ${ctx.scan.stage}.` : '',
        ctx.scan?.headline ? `- AI scan headline: "${ctx.scan.headline}".` : '',
        ctx.scan?.verdict  ? `- AI scan verdict: "${ctx.scan.verdict}".`  : '',
        ctx.scan?.treatmentUrgency
          ? `- Treatment urgency: ${ctx.scan.treatmentUrgency} — calibrate your tone and CTA accordingly (high = motivate action now; moderate = steady progress; low = set realistic expectations).`
          : '',
        ctx.scan?.nextCheckIn && daysUntilNextScan !== null
          ? scanIsOverdue
            ? Math.abs(daysUntilNextScan) > 21
              ? `- Next recommended scan: ${ctx.scan.nextCheckIn} — SIGNIFICANTLY OVERDUE by ${Math.abs(daysUntilNextScan)} day${Math.abs(daysUntilNextScan) !== 1 ? 's' : ''}. These scores (from ${ctx.scan.scoredAt?.split('T')[0] ?? 'an earlier date'}) may no longer reflect the user's current state — treat them as a rough historical baseline, not a current reading. Proactively suggest a new scan before interpreting detailed scores; if the user asks whether things are improving or what their current level is, acknowledge the data is stale and a fresh scan is needed for an accurate answer.`
              : `- Next recommended scan: ${ctx.scan.nextCheckIn} — OVERDUE by ${Math.abs(daysUntilNextScan)} day${Math.abs(daysUntilNextScan) !== 1 ? 's' : ''}. If the user asks when to check in again, or whether their scores are current, recommend they take a new scan now to get updated results.`
            : `- Next recommended scan: ${ctx.scan.nextCheckIn} (in ${daysUntilNextScan} day${daysUntilNextScan !== 1 ? 's' : ''}) — if the user asks when to check in again, use this date.`
          : ctx.scan?.nextCheckIn
            ? `- Next recommended scan: ${ctx.scan.nextCheckIn} — if the user asks when to check in again, use this date.`
            : '',
        ctx.scan?.nextCheckInReason ? `- Reason for check-in timing: ${ctx.scan.nextCheckInReason}.` : '',
        ctx.scan?.weeklyFocus
          ? `- This week's priority action (from scan): "${ctx.scan.weeklyFocus}" — if the user asks what to focus on or what to do next, reinforce this specific habit; do not contradict it with a different suggestion.`
          : '',
        ctx.scan?.scoredAt ? `- Last scan taken: ${ctx.scan.scoredAt.split('T')[0]}${daysSinceLastScan !== null ? ` (${daysSinceLastScan} day${daysSinceLastScan !== 1 ? 's' : ''} ago)` : ''} — use this when the user asks how long ago they scanned or how far away their next check-in is.` : '',
        ctx.scan?.photoQuality && ctx.scan.photoQuality !== 'good'
          ? `- Photo quality: ${ctx.scan.photoQuality}${ctx.scan.photoNote ? ` (${ctx.scan.photoNote})` : ''} — scores may have lower confidence.`
          : '',
        ctx.scan?.retakeRecommended && ctx.scan.photoGuidance
          ? `- If the user asks about score reliability or why scores seem low, recommend a retake: ${ctx.scan.photoGuidance}`
          : ctx.scan?.photoQuality === 'acceptable' && ctx.scan.photoGuidance
            ? `- Photo improvement tip (share when the user asks how to get more accurate scores or how to improve their scan photo): ${ctx.scan.photoGuidance}`
            : '',
        ctx.scan?.specialistRecommended && ctx.scan.specialistReason
          ? `- Specialist consultation recommended: ${ctx.scan.specialistReason} — if the user asks what their next step is, whether they should see a doctor, or how to get the best outcome at their stage, include this as a concrete CTA alongside any OTC advice.`
          : '',
        ctx.scan?.insights?.length
          ? `- Scan insights:\n${ctx.scan.insights.map((ins, i) => `  ${i + 1}) [${ins.metric}] ${ins.title}: ${ins.body}`).join('\n')}`
          : '',
        ctx.scan?.thinningPattern
          ? `- Thinning pattern: ${ctx.scan.thinningPattern}${THINNING_PATTERN_GUIDE[ctx.scan.thinningPattern] ? ` (${THINNING_PATTERN_GUIDE[ctx.scan.thinningPattern]})` : ''} — use this to give targeted zone-specific advice.`
          : '',
        ctx.scan?.stageSeverityLabel
          ? `- Stage severity category: ${ctx.scan.stageSeverityLabel} — use this plain-language label when users ask how serious their hair loss is (e.g. Early → "this is early-stage loss and the ideal prevention window"; Moderate → "established loss, strong response window"; Advanced → "significant loss, consistent multi-therapy is key"; Severe → "advanced loss, specialist options are realistic").`
          : '',
        ctx.scan?.stage && TREATMENT_TIMELINE_GUIDE[ctx.scan.stage]
          ? `- Treatment timeline (${ctx.scan.stage}): ${TREATMENT_TIMELINE_GUIDE[ctx.scan.stage]} — use this when the user asks "when will I see results?", "how long does this take?", "is it working?", or similar timeline/expectation questions. Give the stage-specific timeframes rather than a generic answer.`
          : '',
        ctx.scan?.weeklyFocusMetric
          ? `- Weekly focus metric: ${ctx.scan.weeklyFocusMetric} — the specific metric the weekly focus action targets; when the user asks what to work on this week, reinforce both the metric name and the weekly focus text together rather than giving generic advice.`
          : '',
        ctx.scan?.weeklyFocusSecondary
          ? `- Secondary priority action (${ctx.scan.weeklyFocusSecondaryMetric || 'secondary metric'}): "${ctx.scan.weeklyFocusSecondary}" — use this when the user asks what else to work on, wants a second priority, or has already started their primary weekly focus.`
          : '',
        ctx.weakestMetric?.label ? `- Current weakest metric: ${ctx.weakestMetric.label} (${ctx.weakestMetric.value}/100) — primary focus area.` : '',
        ctx.secondWeakestMetric?.label ? `- Second weakest metric: ${ctx.secondWeakestMetric.label} (${ctx.secondWeakestMetric.value}/100) — secondary priority worth mentioning when the user asks what else to work on.` : '',
        ctx.strongestMetric?.label ? `- Current strongest metric: ${ctx.strongestMetric.label} (${ctx.strongestMetric.value}/100) — mention this as a positive when relevant.` : '',
        ctx.routine.length ? `- Current routine: ${ctx.routine.join(', ')}.` : '- No routine logged yet.',
        protocolStatusLine,
        ctx.scan?.protocolStrengthScore !== null && ctx.scan?.protocolStrengthLabel
          ? `- Protocol strength: ${ctx.scan.protocolStrengthLabel} (${ctx.scan.protocolStrengthScore}/100) — use this as a concise summary when the user asks how complete or strong their treatment stack is, e.g. "Your protocol is currently ${ctx.scan.protocolStrengthLabel} at ${ctx.scan.protocolStrengthScore}/100." Labels: starting=0–19, basic=20–44, partial=45–64, strong=65–84, complete=85+.`
          : '',
        ctx.scan?.overallDelta !== null && ctx.scan?.overallDelta !== undefined
          ? `- Score change vs. previous scan: overall ${ctx.scan.overallDelta >= 0 ? '+' : ''}${ctx.scan.overallDelta} (${ctx.scan.overallDeltaDirection || '?'}); per metric: ${[
              ctx.scan.hairlineDelta !== null && ctx.scan.hairlineDelta !== undefined ? `Hairline ${ctx.scan.hairlineDelta >= 0 ? '+' : ''}${ctx.scan.hairlineDelta}` : null,
              ctx.scan.densityDelta  !== null && ctx.scan.densityDelta  !== undefined ? `Density ${ctx.scan.densityDelta  >= 0 ? '+' : ''}${ctx.scan.densityDelta}`  : null,
              ctx.scan.crownDelta    !== null && ctx.scan.crownDelta    !== undefined ? `Crown ${ctx.scan.crownDelta    >= 0 ? '+' : ''}${ctx.scan.crownDelta}`    : null,
              ctx.scan.healthDelta   !== null && ctx.scan.healthDelta   !== undefined ? `Health ${ctx.scan.healthDelta   >= 0 ? '+' : ''}${ctx.scan.healthDelta}`   : null,
              ctx.scan.potentialDelta!== null && ctx.scan.potentialDelta!== undefined ? `Potential ${ctx.scan.potentialDelta >= 0 ? '+' : ''}${ctx.scan.potentialDelta}` : null,
            ].filter(Boolean).join(', ')} — use these numbers when the user asks "did I improve?", "is my treatment working?", or "how did I change since last scan?"`
          : '',
        ctx.scan?.stageChanged === true
          ? `- Stage changed since last scan: YES — direction: ${ctx.scan.stageDirection || 'unknown'}. ${ctx.scan.stageDirection === 'improved' ? 'Stage improved — acknowledge the progress.' : ctx.scan.stageDirection === 'progressed' ? 'Stage progressed to higher severity — acknowledge with empathy and motivate action.' : 'Stage changed.'}`
          : '',
        ctx.routineDoneToday.length ? `- Routine tasks completed today: ${ctx.routineDoneToday.join(', ')}.` : '- No routine tasks completed today.',
        ctx.planProducts.length ? `- Saved plan products: ${ctx.planProducts.join(', ')}.` : '- No saved plan products yet.',
        ctx.scanHistory.length
          ? `- Scan history (${ctx.scanHistory.length} scans, latest-first): ${ctx.scanHistory.map((h) => {
              const date = typeof h.scoredAt === 'string' ? ` on ${h.scoredAt.split('T')[0]}` : '';
              const stage = h.stage ? ` (${String(h.stage).slice(0, 20)})` : '';
              const metrics = [h.hairline, h.density, h.crown, h.health, h.potential].every((v) => typeof v === 'number')
                ? ` [H:${h.hairline} D:${h.density} C:${h.crown} Hlth:${h.health} Pot:${h.potential}]` : '';
              const pattern = h.thinningPattern ? ` pat:${String(h.thinningPattern).slice(0, 20)}` : '';
              return `${h.overall ?? '?'}${date}${stage}${metrics}${pattern}`;
            }).join(', ')}${stageTrendStr ? `; stage progression: ${stageTrendStr}` : ctx.scanHistory[0]?.stage ? `; latest stage: ${String(ctx.scanHistory[0].stage).slice(0, 20)}` : ''}.`
          : '- No scan history yet.',
        ctx.age ? `- Age: ${ctx.age}.` : '',
        ctx.sex ? `- Sex: ${ctx.sex}.` : '',
        ctx.goals.length ? `- Goals: ${ctx.goals.join(', ')}.` : '',
        ctx.concerns.length ? `- Concerns: ${ctx.concerns.join(', ')}.` : '',
        ctx.timeline ? `- Hair loss onset: ${ctx.timeline}.` : '',
        ctx.familyHistory.length ? `- Family history: ${ctx.familyHistory.join(', ')}.` : '',
        (ctx.lifestyle?.stress != null || ctx.lifestyle?.sleep != null)
          ? `- Lifestyle: ${[
              ctx.lifestyle?.stress != null ? `Stress ${ctx.lifestyle.stress}/10${ctx.lifestyle.stress >= 7 ? ' (HIGH — TE risk; when diffuse thinning is present, mention stress management as a high-priority lever)' : ''}` : '',
              ctx.lifestyle?.sleep  != null ? `Sleep ${ctx.lifestyle.sleep}h/night${ctx.lifestyle.sleep <= 5 ? ' (LOW — recognized TE trigger; when diffuse thinning is present, restoring sleep is the highest-leverage lifestyle action)' : ''}` : '',
            ].filter(Boolean).join(', ')}.`
          : '',
        trackingDurationStr ? `- Treatment journey: ${trackingDurationStr} since first scan (${firstScanDateStr}) — when the user asks how long they've been tracking or when to expect results, reference this duration.` : '',
        trendStr ? `- Overall score trend: ${trendStr}.` : '',
        patternTrendStr
          ? `- Thinning pattern evolution (first → latest): ${patternTrendStr}${patternChanged ? ' — pattern has changed; reference this progression when giving zone-specific advice (e.g. crown thinning has developed since first scan).' : ' — pattern stable across scans.'}`
          : '',
        metricTrendStr ? `- Per-metric trends (first scan → latest, ${ctx.scanHistory.length} scans): ${metricTrendStr} — celebrate improving metrics; prioritize declining ones in your advice.` : '',
        recentIntervalStr ? `- Most recent scan interval (previous → latest): ${recentIntervalStr} — use this when the user asks "is it working?" or "did I improve since last time?" to give an accurate, specific answer rather than the all-time average.` : '',
      ].filter(Boolean).join('\n');

      // Trim history to last 10 turns for cost control, and defend against
      // malformed history items from the client: a `null`/non-object entry
      // would crash `m.role` access, and an entry with empty content produces
      // a wasteful empty message to OpenAI (some models reject those with a
      // 400). Filter them out here rather than trusting client-side shape.
      const recentHistory = Array.isArray(history)
        ? history.slice(-10).filter((m) => m && typeof m === 'object' && String(m.content ?? '').trim())
        : [];
      const messages = [
        { role: 'system', content: systemPrompt },
        ...recentHistory.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).slice(0, 1500) })),
        { role: 'user', content: message.trim().slice(0, 1500) },
      ];

      const coachReqBody = JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.6, max_tokens: 1000 });
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
        console.error('[coach] error', { status: coachStatus, reqId }, coachPayload);
        jsonError(req, res, coachStatus, { ...aiErr, requestId: reqId });
        return;
      }

      const coachChoice = coachPayload.choices?.[0];
      const coachFinishReason = coachChoice?.finish_reason;
      if (coachFinishReason === 'length') console.warn('[coach] reply truncated by max_tokens');
      if (coachFinishReason === 'content_filter') {
        console.warn('[coach] response blocked by content_filter');
        json(req, res, 200, { reply: "I can't respond to that request. Please try rephrasing your question about hair health.", requestId: reqId });
        return;
      }
      const reply = coachChoice?.message?.content?.trim()
        || "I didn't quite catch that — could you rephrase your question?";
      const coachUsage = coachPayload.usage;
      if (coachUsage) {
        METRICS.coach.promptTokens     += coachUsage.prompt_tokens     || 0;
        METRICS.coach.completionTokens += coachUsage.completion_tokens || 0;
      }
      bumpSuccess(METRICS.coach);
      warnIfSlow('coach', startedAt, 'coach');
      if (coachUsage) console.log('[coach] ok', { ms: Date.now() - startedAt, tokens: { prompt: coachUsage.prompt_tokens, completion: coachUsage.completion_tokens }, finish: coachFinishReason, reqId });
      const coachTruncated = coachFinishReason === 'length';
      // suggestedFollowUps: context-aware chips for the iOS coach tab.
      // Uses scan-time protocolCoverage for consistency with the scan's chip set.
      // The protocolStatusLine in the system prompt uses coachProtocolCoverage (fresher) for
      // actual coach responses; chips use ctx.scan.protocolCoverage to match the scan's chip set.
      const suggestedFollowUps = ctx.scan?.stage
        ? buildSuggestedQuestions(ctx.scan.stage, ctx.scan.protocolCoverage, ctx.scan.specialistRecommended)
        : null;
      json(req, res, 200, { reply, truncated: coachTruncated, suggestedFollowUps, requestId: reqId });
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
  console.log(`[hairlinecheck api] POST /api/generate-progression { photoDataUrl, month }`);
  console.log(`[hairlinecheck api] POST /api/generate-progression-batch { photoDataUrl, months? } (parallel)`);
  console.log(`[hairlinecheck api] POST /api/generate-analysis-map { photoDataUrl, kind }`);
  console.log(`[hairlinecheck api] POST /api/generate-advice-visual { kind }`);
  console.log(`[hairlinecheck api] POST /api/analyze-scan   { photoDataUrl }`);
  console.log(`[hairlinecheck api] POST /api/coach          { message, history, userContext }`);
  console.log(`[hairlinecheck api] GET  /api/health`);
  console.log(`[hairlinecheck api] GET  /api/version\n`);
});
