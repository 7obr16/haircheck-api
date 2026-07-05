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
  scan:        { requests: 0, errors: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, lastError: null, lastSuccess: null },
  after:       { requests: 0, errors: 0, cacheHits: 0, lastError: null, lastSuccess: null },
  progression: { requests: 0, errors: 0, cacheHits: 0, lastError: null, lastSuccess: null },
  map:         { requests: 0, errors: 0, cacheHits: 0, lastError: null, lastSuccess: null },
  adviceVisual:{ requests: 0, errors: 0, cacheHits: 0, lastError: null, lastSuccess: null },
  coach:       { requests: 0, errors: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, lastError: null, lastSuccess: null },
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

function bumpSuccess(m) {
  m.lastSuccess = new Date().toISOString();
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

Change only one thing: locally improve the visible hair-loss areas while preserving the person's current hairstyle. Only add plausible density inside the already visible thinning, receded, sparse, or bald spots. Fill those weak areas with short, natural hair that exactly matches the existing surrounding hair.

CRITICAL texture rule: preserve the hair's exact ethnic texture — do NOT straighten curly, coily, or wavy hair; do NOT lighten or darken the hair color; do NOT apply a smooth or silky European texture to Afro-textured, South Asian, East Asian, or any other non-European hair type. The added hair must be indistinguishable in coarseness, curl pattern, wave, thickness, direction, shine, and color from the hair immediately surrounding the thinning zone.

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

// Stage-specific zone hints for the analysis-map heatmap overlay.
// Tells the model WHERE to place red/orange (low density) vs green (high density)
// patches so the overlay matches the expected anatomy for each Norwood stage.
const MAP_STAGE_HINTS = {
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
  NW4:  "This user is Norwood 4 (significant frontal hairline retreat + pronounced crown thinning). Show improvement across both the frontal zone (toward a credible age-appropriate hairline, not a teenager's) and the crown/vertex.",
  NW5:  "This user is Norwood 5 (frontal and crown zones nearly merging). Show improvement across the entire scalp top — reduce visible scalp throughout. The sparse band between frontal and crown should look slightly wider and denser.",
  NW6:  "This user is Norwood 6 (frontal and crown merged). Show meaningful density restoration across the full scalp top proportional to the treatment month. The result should be noticeably improved, not perfect.",
  NW7:  "This user is Norwood 7 (near-total top loss). Show uniform density improvement across the entire top proportional to the treatment month. Keep it realistic — the improvement should be believable for this degree of loss.",
  diffuse: "This user has diffuse thinning (uniform loss across the entire scalp top). Show uniform density increase across the whole top without shifting or changing the hairline position.",
  'n/a (female)': "This user has female-pattern thinning (diffuse loss at the central part and crown). Focus improvement on the central parting and scalp top. Do not change the hairline position.",
};

// Build a progression prompt with an optional stage-specific zone hint.
// Falls back to the base prompt when stage is absent or unrecognised.
const buildProgressionPrompt = (month, stage) => {
  const basePrompt = PROGRESSION_PROMPTS[month];
  const hint = stage ? PROGRESSION_STAGE_HINTS[stage] : null;
  return hint ? `${basePrompt}\n\nStage-specific focus: ${hint}` : basePrompt;
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

DO NOT regrow lost zones to completion. DO NOT change hair color or style. CRITICAL: preserve the exact hair texture and ethnicity — do NOT straighten curly or coily hair, do NOT lighten dark hair, do NOT apply a European texture to any other hair type. The user should think "subtle but real" — not "miracle." Most people wouldn't notice unless comparing photos side-by-side.

The result must be photorealistic and pixel-aligned with the input so it can be used as the AFTER side of a before/after slider.`,

  6: `Edit this photo to show a MODERATE 6-month treatment result. Keep face, expression, camera angle, distance to camera, head position, aspect ratio, crop/framing, lighting, skin tone, eyes, ears, clothing, and background pixel-identical to the input.

Make a clearly visible but still realistic improvement that matches what a committed user would see after 6 months of consistent treatment:
- Noticeable density gain in the thinning areas, roughly 40–50% closer to the user's natural full density
- Hairline edges look more defined and the temple recession appears partially filled with new pigmented hair
- Crown/vertex thinning area shows real coverage (not bald patch — nor full restoration)
- Hair color, length, style, and texture exactly match the original

DO NOT make it look like a completely full head of hair. There should still be some evidence of the original hair loss pattern, just clearly improved. CRITICAL: preserve the exact hair texture and ethnicity — do NOT straighten curly or coily hair, do NOT lighten dark hair, do NOT apply a European texture to any other hair type. The viewer should think "real progress" — not "different person."

The result must be photorealistic and pixel-aligned with the input so it can be used as the AFTER side of a before/after slider.`,

  12: `Edit this photo to show a STRONG 12-month treatment result. Keep face, expression, camera angle, distance to camera, head position, aspect ratio, crop/framing, lighting, skin tone, eyes, ears, clothing, and background pixel-identical to the input.

Make a substantial, realistic improvement matching what a fully-compliant user might achieve after a year of treatment:
- Full natural-looking density across the previously-thin areas
- Hairline restored to a credible age-appropriate shape (NOT a teenager's hairline — match the user's age)
- Crown looks naturally full
- New hair matches the user's existing color, texture, and ethnicity exactly
- A trace of the original recession may still be visible if it was severe — most real cases never reach 100% baseline

DO NOT change hair color, style, length, or any other feature. CRITICAL: preserve the exact hair texture and ethnicity — do NOT straighten curly or coily hair, do NOT lighten or darken the hair color, do NOT apply a European or generic smooth texture to any non-European hair type. The viewer should think "best realistic outcome" — clearly the same person with clearly more hair.

The result must be photorealistic and pixel-aligned with the input so it can be used as the AFTER side of a before/after slider.`,
};

const buildAnalysisMapPrompt = (kind, result = {}) => {
  const density = Number.isFinite(Number(result.density)) ? Math.round(Number(result.density)) : 'unknown';
  const crown = Number.isFinite(Number(result.crown)) ? Math.round(Number(result.crown)) : 'unknown';
  const hairline = Number.isFinite(Number(result.hairline)) ? Math.round(Number(result.hairline)) : 'unknown';
  const stage = String(result.stage || '').trim();
  const stageHint = MAP_STAGE_HINTS[stage] || null;

  const focus = kind === 'crown'
    ? `Focus the overlay on crown and vertex thinning. Use crown score ${crown}/100, density score ${density}/100, and hairline score ${hairline}/100 as guidance.`
    : `Focus the overlay on visible scalp density across the top, mid-scalp, temples, and hairline. Use density score ${density}/100, crown score ${crown}/100, and hairline score ${hairline}/100 as guidance.`;

  const stageSection = stageHint
    ? `\n\nStage-specific placement guide (${stage}): ${stageHint}`
    : '';

  return `Edit this input scan photo into a clear clinical hair-density heatmap of the user's actual head hair. Keep the original photograph underneath completely unchanged: same person, same face, same head position, same camera angle, same distance, same crop/framing, same lighting, same background, same hair style, same hair color, same skin tone, same clothing. Do not beautify, redraw, restore, move, rotate, zoom, or replace anything in the photo.

Add only a visible translucent diagnostic heatmap overlay directly on the hair-bearing scalp region, like a premium trichology analysis screen. The heatmap must be obvious enough that the user immediately sees it is an AI-generated scalp map, not just their original photo. ${focus}${stageSection}

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
  microneedling: `Create a photorealistic premium hair-health app advice card image. Subject: close crop of a matte-black unbranded dermaroller or microneedling device positioned above a dark-haired scalp parting, fine needles shown at the hairline with a subtle blue-violet glow at the tips suggesting follicle stimulation. Style: dark luxury clinical lighting, black background, sharp macro detail, premium medical-aesthetic. Avoid blood, visible wounds, gore, brand logos, labels, text, watermark, UI, cartoon style, or exaggerated injury.`,
  consultation: `Create a photorealistic premium hair-health app advice card image. Subject: minimalist dark clinical consultation scene — a premium trichoscope lens examining a scalp parting on dark hair, or a sleek black clinical notepad and pen beside a stethoscope on a dark marble desk. Style: dark luxury medical-aesthetic, subtle violet rim light, calm confident atmosphere. Avoid visible faces, clinical white hospital rooms, brand logos, labels, watermarks, text, UI, or overly bright settings.`,
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

  // Extract pathname without query string so routing works with ?foo=bar appended
  let reqPath;
  try { reqPath = new URL(req.url, 'http://localhost').pathname; }
  catch (_) { reqPath = req.url.split('?')[0]; }

  // Suppress health-check log spam — Railway probes every ~10s creating ~720 log lines/hr
  const isHealthCheck = req.method === 'GET' && reqPath === '/api/health';

  res.setHeader('X-Request-Id', reqId);
  if (!isHealthCheck) console.log(`[req] ${req.method} ${req.url} ${reqId}`);
  const origEnd = res.end.bind(res);
  res.end = (...args) => {
    const ms = Date.now() - reqStart;
    if (!isHealthCheck) console.log(`[res] ${req.method} ${req.url} ${reqId} ${res.statusCode} ${ms}ms`);
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
      estimatedCostUSD: computeEstimatedCost(),
      requestId: reqId,
    });
    return;
  }

  if (req.method === 'GET' && reqPath === '/api/version') {
    json(req, res, 200, { sha: GIT_SHA, requestId: reqId });
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
      bumpSuccess(METRICS.after);
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
      // Include stage in cache key because buildProgressionPrompt interpolates it.
      // stageParam || '' ensures the key is stable when stage is omitted.
      const hash = cacheHashOf('progression', mime, createHash('sha256').update(buffer).digest('hex'), String(m), quality, stageParam || '');

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
      const progressionPrompt = buildProgressionPrompt(m, stageParam);
      console.log('[progression] start', { month: m, stage: stageParam || null, mime, inputKb: Math.round(buffer.length / 1024), quality });

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
      bumpSuccess(METRICS.progression);
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
      // Include scores and stage in cache key because buildAnalysisMapPrompt interpolates them.
      // Stage changes the zone-placement hints so a different stage must produce a fresh image.
      const scoreKey = [
        Number.isFinite(Number(scanScores.density)) ? Math.round(Number(scanScores.density)) : 'x',
        Number.isFinite(Number(scanScores.crown)) ? Math.round(Number(scanScores.crown)) : 'x',
        Number.isFinite(Number(scanScores.hairline)) ? Math.round(Number(scanScores.hairline)) : 'x',
      ].join(',');
      const stageKey = String(scanScores.stage || '');
      const hash = cacheHashOf('map', mime, createHash('sha256').update(buffer).digest('hex'), mapKind, scoreKey, stageKey);

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
      console.log('[analysis-map] start', { kind: mapKind, stage: stageKey || null, mime, inputKb: Math.round(buffer.length / 1024) });

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
      bumpSuccess(METRICS.map);
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
      bumpSuccess(METRICS.adviceVisual);
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
  if (req.method === 'POST' && reqPath === '/api/analyze-scan') {
    try {
      METRICS.scan.requests++;
      const { photoDataUrl, profile: rawProfile = {}, scoringInstruction = '' } = await readJsonBody(req);
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
        scoringInstruction ? `Scoring instruction: ${String(scoringInstruction).replace(/[\r\n\t]+/g, ' ').slice(0, 280)}` : '',
      ].join('\n');

      const sys = `You are an aesthetic hair-analysis AI for a consumer hair-loss app. Analyze the scalp photo and user profile context, then output structured JSON with these fields:
- hairline, density, crown, health, potential: 0-100 integer scores
- stage: Norwood stage (pick from the enum)
- headline: 6-9 word punchy summary, confident tone. Calibrate energy to the stage: NW1-NW2 → protective/preventive urgency (this is the best window); NW3-NW3v → action-oriented, motivating, results-focused; NW4 → committed/realistic, acknowledge the work ahead; NW5+ → frank expectation-setting, specialist-aware; diffuse/female → cause-investigation framing. Avoid hedging words like "might", "could", or "some". Never start with "Your".
- insights: exactly 3 items, each with a 5-word title (≤5 words), a 20-28 word actionable body that is specific to THIS user's visible loss pattern, scores, stage, or profile — name the actual stage or a score, specify a concrete action, and give a reason tied to their situation. CRITICAL routine rule: check "Current routine" in the user context above — if a treatment is already listed (e.g. minoxidil, finasteride, dutasteride, DHT-blocking shampoo, supplements), do NOT suggest starting it. Instead, suggest how to optimize that treatment (e.g. proper application coverage, timing, frequency) or recommend a different complementary layer. Never repeat a recommendation for something the user already does. Avoid generic advice. CRITICAL diversity rule: every insight MUST target a DIFFERENT metric — never assign the same metric value to two insights; pick the 3 most clinically relevant distinct metrics from: Hairline, Density, Crown, Health, Potential. The metric must match: Hairline→temple/frontal recession, Density→mid-scalp thinning, Crown→vertex/crown thinning, Health→scalp condition or miniaturization, Potential→treatment response or growth timeline
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

Thinning pattern discriminator — use when adjacent patterns are ambiguous:
- minimal vs bitemporal: Assign minimal ONLY when the hairline shows no recession and both temples are fully intact. Any M-shape deepening, angular notch, or even subtle temple asymmetry → bitemporal minimum.
- bitemporal vs bitemporal+crown: Assign bitemporal when ONLY the temple recession is visible and the crown is fully intact from above. If ANY independent thinning is visible at the vertex/crown — even subtle — assign bitemporal+crown.
- crown vs bitemporal+crown: Assign crown ONLY when the temples are clearly intact with no M-shape recession. If any temple recession co-exists with crown thinning → bitemporal+crown.
- frontal vs bitemporal: frontal = hairline retreating evenly across the full width without a distinct M-shape or sharp temple angles. bitemporal = clear bilateral angular recession at both temple corners. If the recession forms visible corner notches → bitemporal; if it's a uniform straight-line retreat → frontal.
- frontal vs diffuse: frontal = hairline retreating at the front, mid-scalp and crown largely intact. diffuse = uniform thinning distributed across the entire scalp top with the hairline mostly preserved. If the top is uniformly thin AND the hairline has some frontal retreat, prefer diffuse.
- diffuse vs total: total applies ONLY when multiple large consolidated bald areas are visible (equivalent to NW5+). diffuse means thinning throughout but no large bald patches. If large patches exist → total.
- n/a (female): Use for female-presenting patients regardless of pattern — Ludwig classification applies mentally but output the Norwood thinningPattern enum value that best describes the visible zone (diffuse for Ludwig I-II, total for Ludwig III).

Stage-thinningPattern consistency — apply after assigning both stage and thinningPattern independently:
- NW3v is defined by simultaneous temple recession AND early crown thinning — thinningPattern MUST be bitemporal+crown; if independent pattern assessment returned only bitemporal, re-examine the vertex and correct to bitemporal+crown.
- NW4 has both frontal and pronounced crown thinning — thinningPattern should be bitemporal+crown (not bitemporal alone). If crown is somehow unaffected at NW4, double-check the stage assignment.
- NW6 and NW7 have fully merged frontal and crown bald zones — thinningPattern MUST be total.
- stage=diffuse → thinningPattern MUST be diffuse.
- stage=n/a (female) → thinningPattern MUST be diffuse (Ludwig I-II) or total (Ludwig III severe).

PHOTO QUALITY ASSESSMENT:
good — scalp clearly visible, well-lit, shot from above or ~45° angle, can see hairline + crown.
acceptable — lighting or angle is suboptimal but loss pattern is still assessable.
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
- NW3 vs NW3v: Assign NW3v (not plain NW3) only when vertex/crown thinning is independently visible as a SEPARATE thinning zone distinct from the temple recession.
- NW4 vs NW5: If the bridge of hair connecting the forelock to the sides is a visible full-width band, assign NW4. If that bridge is sparse, narrow, or nearly gone, assign NW5.
- NW5 vs NW6: If even a sparse band of tissue still separates the frontal and crown bald zones, assign NW5. If the two zones have fully merged with no separation at all, assign NW6.
- NW6 vs NW7: Assign NW7 only when the entire scalp top is essentially bare and only a narrow horseshoe-shaped fringe along the sides and nape remains — and even that fringe is thinning or sparse. If a meaningful lateral fringe still offers substantial coverage on both sides connecting to the back, assign NW6. NW7 means even the horseshoe fringe is compromised; the defining feature is that virtually no usable donor-zone width remains on top.

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
          thinningZones: THINNING_ZONES_MAP[thinningPattern] || [],
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
        // Guarantee the weakest metric is covered by at least one insight.
        // GPT-4o may return 3 insights that all miss the weakest area — replace
        // insights[2] (lowest-priority slot) with a targeted server-side fallback.
        if (!data.insights.some((ins) => ins.metric === _weakLabel)) {
          const _weakFallback = {
            Hairline: { title: 'Target recession zones',     body: `Apply minoxidil twice daily to both temple recession zones — at ${data.hairline}/100, hairline is your highest-ROI focus and the treatment response window is open.`,     metric: 'Hairline' },
            Density:  { title: 'Build mid-scalp density',    body: `Add a DHT-blocking shampoo 3× weekly and a 5-minute scalp massage each wash — at ${data.density}/100 density, these are the most cost-effective OTC tools for coverage.`,  metric: 'Density'  },
            Crown:    { title: 'Protect the vertex now',     body: `Apply minoxidil 1ml directly to the crown twice daily and track with monthly overhead photos — your crown at ${data.crown}/100 responds best to targeted topical coverage.`,  metric: 'Crown'    },
            Health:   { title: 'Optimize scalp environment', body: `Switch to a gentle sulfate-free shampoo and add biotin and zinc — scalp health at ${data.health}/100 directly affects how well topicals absorb and follicles respond.`,     metric: 'Health'   },
            Potential:{ title: 'Stack the right habits',     body: `Pairing minoxidil with scalp massage and a DHT-blocking shampoo gives the strongest 6-month OTC response — start the full stack now while the treatment window is open.`,  metric: 'Potential'},
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

        // photoGuidance: actionable retake tip shown when quality isn't ideal.
        // Computed server-side so the iOS app can display it without extra logic.
        data.photoGuidance = photoQuality === 'good' ? null
          : photoQuality === 'poor'
            ? 'For best results: hold your camera directly above your head with your arm fully extended. Use bright natural light (near a window or outdoors). Part your hair slightly so the scalp is visible, and make sure both your hairline and crown are in frame.'
            : 'For a more accurate scan: try shooting from a slightly higher angle in brighter lighting. Part your hair so the scalp is visible through thinning areas.';

        // weeklyFocus: highest-ROI weekly action based on the user's weakest metric.
        // Routine-aware: if the primary suggestion is already in their routine, recommend
        // the next most impactful complementary action instead of repeating redundant advice.
        const _routineItems = (profile.routine || []).map((r) => String(r).toLowerCase());
        const _hasMinoxidil  = _routineItems.some((r) => r.includes('minoxidil') || r.includes('rogaine'));
        const _hasDHTShampoo = _routineItems.some((r) => r.includes('dht') || r.includes('ketoconazole') || r.includes('nizoral') || r.includes('keto shampoo') || r.includes('caffeine shampoo'));
        const _hasMassage    = _routineItems.some((r) => r.includes('massage') || r.includes('dermaroller') || r.includes('microneedl'));
        const _hasSupplements= _routineItems.some((r) => r.includes('supplement') || r.includes('biotin') || r.includes('vitamin') || r.includes('zinc') || r.includes('saw palmetto'));
        const _hasFinasteride = _routineItems.some((r) => r.includes('finasteride') || r.includes('propecia') || r.includes('dutasteride') || r.includes('avodart'));
        // Stage gates: at NW5 expectations shift; at NW6/NW7 OTC has very limited effect
        // and the primary path is specialist consultation / surgical options.
        const _isNW7          = data.stage === 'NW7';
        const _isNW5only      = data.stage === 'NW5';
        const _isNW56         = data.stage === 'NW5' || data.stage === 'NW6';
        const _isAdvancedStage = _isNW7 || _isNW56;
        const WEEKLY_FOCUS_MAP = {
          Hairline: _isNW7
            ? 'At NW7, the primary path is FUE/FUT transplant or SMP — book a trichologist consult this week to understand candidacy, donor supply, and realistic coverage outcomes.'
            : _isNW5only
              ? (_hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                  ? 'NW5 frontal recession with finasteride + minoxidil + DHT shampoo is the strongest non-surgical protocol — keep all three consistent. Apply minoxidil across the full frontal zone and both temple edges twice daily, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time each day. Monthly front-facing photos track the bridge; the goal is stabilization.'
                  : _hasFinasteride && _hasMinoxidil
                    ? 'NW5 frontal recession with finasteride + minoxidil gives the strongest available non-surgical coverage — add a DHT-blocking shampoo 3× weekly as the third layer. Apply minoxidil across the entire frontal zone twice daily and take monthly front-facing photos to track how the bridge between forelock and lateral fringe responds.'
                    : _hasFinasteride
                      ? 'NW5 frontal recession with finasteride providing systemic DHT suppression is a strong foundation — add minoxidil across the full frontal zone twice daily for the complementary topical signal. The finasteride + minoxidil combination is the most effective non-surgical approach at NW5; add a DHT-blocking shampoo 3× weekly and track with monthly front-facing photos.'
                      : _hasMinoxidil && _hasDHTShampoo
                          ? 'NW5 frontal recession is severe with a narrow bridge still separating the forelock from the lateral fringe — apply minoxidil across the full frontal zone twice daily and leave your DHT-blocking shampoo on 3-5 minutes per wash to slow the merge. Take monthly front-facing photos; tracking how quickly the bridge narrows is the key signal at this stage.'
                          : _hasMinoxidil
                            ? 'NW5 frontal recession is extensive — the bridge between the forelock and lateral fringe is narrowing. Apply minoxidil across the full frontal zone and both temple edges twice daily, and add a DHT-blocking shampoo 3× weekly. Take monthly front-facing photos to monitor how quickly the bridge is closing.'
                            : 'NW5 frontal recession is substantial and the bridge between the forelock and lateral fringe is narrowing — start minoxidil across the full frontal zone twice daily and add a DHT-blocking shampoo 3× weekly. OTC at this stage is about slowing the merge, not full reversal; take monthly photos to track the bridge.')
              : _isNW56
              // only NW6 reaches here — NW5 is handled by _isNW5only above
              ? (_hasFinasteride && _hasMinoxidil
                  ? 'At NW6, finasteride + minoxidil is your strongest non-surgical defense for the remaining fringe and temporal hair — keep both consistent with no gaps. Apply minoxidil along the fringe and temple edges twice daily and take finasteride at the same time each day. In parallel, research FUE/FUT transplant options: combining systemic treatment with surgical planning is the most complete strategy at this stage.'
                  : _hasFinasteride
                    ? 'Finasteride is blocking systemic DHT at NW6 — add minoxidil to the fringe and temporal edges twice daily to complete the non-surgical protocol. Together they give the best realistic slowdown of further fringe recession; book a transplant consultation in the next 6 months to plan your full-coverage strategy.'
                    : _hasMinoxidil
                      ? 'At NW6, apply minoxidil consistently to the fringe and temple edges twice daily and add a DHT-blocking shampoo 3× weekly as a second layer. Track whether a transplant consultation makes sense in the next 3-6 months for a comprehensive coverage strategy.'
                      : 'At NW6 minoxidil applied to the fringe and temporal edges twice daily can still slow further recession — start this week alongside a DHT-blocking shampoo. Book a transplant consultation to evaluate surgical coverage options alongside your OTC protocol.')
              : data.stage === 'NW4'
                // NW4 hairline loss extends across the entire frontal zone (not just temple corners) — advice must reflect the full frontal hairline, not just "recession zones"
                ? (_hasMinoxidil && _hasMassage)
                    ? 'At NW4, your full frontal hairline needs coverage — apply minoxidil along the entire hairline edge and both temples twice daily, right after your scalp massage. Pair with monthly front-facing photos to track response over the next 4 months.'
                    : _hasMinoxidil
                      ? 'At NW4, extend minoxidil to the entire frontal hairline (not just the temples) twice daily. Add a 3-minute scalp massage before each application to drive absorption along the hairline edge where follicles face the most DHT pressure.'
                      : 'NW4 frontal recession responds best to minoxidil applied along the full hairline edge and both temples twice daily. Start this week — 3-4 months of consistent coverage is the minimum before evaluating response. Track with monthly front-facing photos.'
                : data.stage === 'NW3v'
                // NW3v: dual-zone stage — temple recession AND early crown thinning — advice must address both zones simultaneously
                ? (_hasMinoxidil && _hasMassage)
                    ? 'NW3v means temple recession AND early crown thinning are both active — two zones need simultaneous coverage. Apply 1ml minoxidil to both temple recession zones AND directly to the vertex twice daily. You have massage active; do it before each application so both zones absorb better.'
                    : _hasMinoxidil
                      ? 'At NW3v, two zones are thinning: temples and early crown. Apply minoxidil to both — 1ml per temple zone PLUS 1ml directly to the vertex twice daily. Add a 3-minute scalp massage before each application to open follicles in both areas to absorption.'
                      : 'NW3v is a dual-front stage: temples and crown are both starting to lose ground simultaneously. Start minoxidil on BOTH the temple recession zones AND the vertex now — dual coverage prevents both fronts from advancing independently, and acting at NW3v gives the strongest response window.'
                : data.stage === 'NW3'
                // NW3: deep bilateral temple recession past mid-pupil — established AGA; this is the strongest treatment response window
                ? (_hasMinoxidil && _hasMassage)
                    ? 'NW3 deep temple recession is established AGA — your minoxidil and massage are both active. Optimize by parting hair to expose both recession zones before applying and confirming full 1ml coverage per side morning and night. Precision in the recession zone matters more than adding products.'
                    : _hasMinoxidil
                      ? 'NW3 temple recession extends past mid-pupil — this is an active phase but still a strong response window. Apply 1ml to each temple recession zone twice daily and add a 4-minute scalp massage after each application to maximize absorption where DHT pressure is highest.'
                      : 'NW3 deep temple recession responds well to action now — follicles at the recession edge are still viable and highly responsive. Start minoxidil on both temple zones twice daily, add a 4-minute scalp massage per application, and track with monthly front-facing photos from the same angle.'
                : data.stage === 'NW2'
                // NW2: earliest detectable stage — preventive window; best long-term outcome comes from acting here
                ? (_hasMinoxidil)
                    ? 'NW2 is the ideal preventive stage and your minoxidil is already on the temple corners — good call. Keep it consistent twice daily and add a DHT-blocking shampoo 3× weekly as a complementary prevention layer to slow the M-shape from deepening further.'
                    : 'NW2 temple recession is the earliest warning sign — and the best treatment window. Start minoxidil directly on both temple corners twice daily this week. At NW2, follicles are fully viable and early intervention produces the strongest long-term results. Take a monthly front-facing photo to catch any further change early.'
                : data.stage === 'NW1'
                // NW1: no recession exists — advice must be preventive, not treatment-focused
                ? (_hasDHTShampoo
                    ? 'Your hairline is fully intact at NW1 — keep it that way. Stay consistent with your DHT-blocking shampoo 3× weekly and take monthly front-facing photos; catching any early M-shape at NW1 gives the best possible intervention window if change ever begins.'
                    : 'Your hairline is fully intact at NW1 — protect it before any recession starts. Add a DHT-blocking shampoo 3× weekly now. Prevention at this stage costs far less effort than treating established recession later.')
                : (_hasMinoxidil && _hasMassage)
                  ? 'Minoxidil and scalp massage are both active — maximize impact by parting your hair to expose receding temple zones before applying, ensuring full 1ml coverage per side, morning and night.'
                  : _hasMinoxidil
                    ? 'Your minoxidil is active — maximize coverage across both recession zones twice daily and add a 3-minute scalp massage post-application to boost absorption.'
                    : 'Apply minoxidil directly to your recession zones every morning and night — temple consistency is the highest-leverage habit right now.',
          Density: _isAdvancedStage
            ? (_hasDHTShampoo && _hasMassage
                ? 'DHT-blocking shampoo and scalp stimulation are both active — leave shampoo on for 3-5 minutes before rinsing and do a focused microneedling session on the thinnest zones weekly for maximum response.'
                : _hasDHTShampoo
                  ? "Your DHT-blocking shampoo helps slow miniaturization — keep it up and add weekly microneedling to prime remaining follicles for maximum response."
                  : 'Add a DHT-blocking shampoo 3× this week — at your stage it helps stabilize existing density and slow further miniaturization.')
            : data.stage === 'NW2'
              ? (_hasDHTShampoo
                  ? 'Your DHT-blocking shampoo is already protecting your density — at NW2 your coverage is still strong. Keep using it 3× weekly and add a 5-minute scalp massage on wash days to maintain circulation and catch any early diffuse change.'
                  : 'At NW2 your density is still strong — protect it now by adding a DHT-blocking shampoo 3× weekly. This is the highest-ROI prevention step at your stage: slowing miniaturization before it becomes visible is far easier than reversing it later.')
              : (data.stage === 'NW3' || data.stage === 'NW3v')
                ? (_hasDHTShampoo && _hasMassage
                    ? 'DHT shampoo and scalp stimulation are both active — optimize for density by microneedling the thinning mid-scalp zone 24-48 hours before your topical application, so freshly primed follicles absorb more at the area that matters most.'
                    : _hasDHTShampoo
                      ? "Your DHT-blocking shampoo is active at a key stage — add weekly microneedling over the mid-scalp thinning zone and a 5-minute post-wash scalp massage to drive follicle response while coverage is still stabilizable."
                      : 'Mid-scalp density at NW3 responds well to DHT-blocking shampoo 3× weekly plus scalp massage — start both this week while follicles are still viable and the density response window is open.')
                : data.stage === 'NW4'
                  ? (_hasDHTShampoo && _hasMinoxidil && _hasMassage
                      ? 'At NW4, mid-scalp density benefits from stacking all three layers — optimize timing: massage first, then apply minoxidil immediately after across the full top, and leave DHT shampoo on for 3-5 minutes on wash days. Consistency beats adding new products.'
                      : _hasDHTShampoo && _hasMinoxidil
                        ? 'At NW4, add scalp massage and weekly microneedling to your topical + shampoo stack — mechanical stimulation significantly improves absorption across the mid-scalp thinning zones at this stage.'
                        : _hasMinoxidil
                          ? 'At NW4, mid-scalp coverage needs a DHT-blocking shampoo as the second layer — use it 3× weekly with a 3-minute scalp massage to slow ongoing miniaturization alongside your existing topical.'
                          : _hasDHTShampoo
                            ? 'At NW4, add minoxidil across the full scalp top (temples + crown + mid-scalp) twice daily — your DHT shampoo slows miniaturization but minoxidil drives the active regrowth signal your follicles need.'
                            : 'NW4 mid-scalp density responds best to the full OTC stack: minoxidil twice daily across the entire top plus DHT-blocking shampoo 3× weekly. Start both this week — density at this stage needs simultaneous DHT suppression and growth signal.')
                  : (data.stage === 'diffuse' || data.stage === 'n/a (female)')
                    ? (_hasMinoxidil && _hasDHTShampoo
                        ? (data.stage === 'n/a (female)'
                            ? "Female-pattern thinning responds well when minoxidil covers the full central parting and scalp top — confirm coverage is even rather than concentrated at the hairline. If you haven't already, check ferritin, vitamin D, and thyroid — these are the most common reversible causes in women."
                            : 'Diffuse thinning spans the full scalp — your topical and DHT shampoo are the right tools. Add a 5-minute whole-scalp massage on wash days and consider a nutritional workup (ferritin, vitamin D, thyroid) to rule out a reversible cause.')
                        : _hasMinoxidil
                          ? (data.stage === 'n/a (female)'
                              ? "Female-pattern thinning responds well to minoxidil applied across the central parting and scalp top — not just the hairline. Add a check of ferritin, vitamin D, and thyroid: these are the most common reversible causes and topicals alone won't fix them."
                              : 'Diffuse thinning often has a nutritional or hormonal component — add a DHT-blocking shampoo 3× weekly and consider checking ferritin, vitamin D, and thyroid levels to find a reversible root cause.')
                          : (data.stage === 'n/a (female)'
                              ? "Female-pattern thinning responds best to minoxidil applied across the full scalp top (not just the hairline) twice daily — start this week. Also worth a ferritin, vitamin D, and thyroid check: these reversible causes are common in women and topicals alone won't address them."
                              : 'Diffuse thinning covers the entire scalp top — start DHT-blocking shampoo 3× weekly and minoxidil across the full top twice daily. Also check ferritin, vitamin D, and thyroid — diffuse loss often has a treatable nutritional or hormonal component.'))
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
            ? 'Crown coverage at NW7 is best addressed through FUE/FUT or SMP — prioritize a specialist consultation to discuss vertex coverage goals and realistic outcomes.'
            : _isNW5only
              ? (_hasMinoxidil && _hasMassage
                  ? 'At NW5, your minoxidil and massage target the right zones — confirm 1ml reaches the vertex directly, not just the sides. Add weekly microneedling over the crown to prime follicle response and take overhead photos every 4 weeks to track how quickly the frontal and crown thinning zones are merging.'
                  : _hasMinoxidil
                    ? 'NW5 crown thinning is substantial — apply 1ml minoxidil directly to the vertex twice daily after a 4-minute scalp massage to maximize absorption, then add weekly microneedling. The goal is slowing how quickly the frontal and crown zones merge; photograph from above every 4 weeks to track the bridge.'
                    : 'NW5 crown thinning is large and the frontal zone is nearly merging — start minoxidil (1ml) directly on the vertex twice daily paired with weekly microneedling. Stabilizing the bridge between the two thinning zones is the realistic near-term goal; take an overhead photo today as your baseline.')
              : _isNW56
              // only NW6 reaches here — NW5 is handled by _isNW5only above
              ? (_hasFinasteride && _hasMinoxidil
                  ? 'At NW6, finasteride + minoxidil applied to the vertex twice daily is the most complete non-surgical protocol for crown coverage — keep both consistent. Add weekly microneedling over the crown zone and photograph from above every 6 weeks to track change. Booking a transplant consultation for vertex coverage planning is worth prioritizing this quarter.'
                  : _hasFinasteride
                    ? 'Finasteride is suppressing systemic DHT at NW6 — add minoxidil (1ml) directly to the vertex twice daily for the topical growth signal. Together they form the strongest non-surgical approach for crown; photograph overhead every 6 weeks and consider booking a transplant consultation for vertex coverage planning.'
                    : _hasMinoxidil
                      ? 'Apply minoxidil directly to the crown (1ml) twice daily at NW6 and add weekly microneedling to prime follicle response — manage expectations and photograph from above every 6 weeks to track change. Consider booking a transplant consultation to evaluate vertex coverage options.'
                      : 'Apply minoxidil directly to the crown/vertex (1ml) twice daily and add weekly microneedling — manage expectations and photograph from above every 6 weeks to track any change.')
              : data.stage === 'NW4'
                // NW4 crown thinning is significant and well-established; needs direct targeted topical + realistic timeline
                ? (_hasMinoxidil && _hasMassage)
                    ? 'NW4 crown thinning responds best when minoxidil reaches the vertex directly — apply 1ml to the crown right after your scalp massage so freshly stimulated follicles absorb it immediately. Take an overhead photo today as your baseline; meaningful density changes take 3-4 months to show.'
                    : _hasMinoxidil
                      ? 'At NW4, crown coverage requires targeted application — apply 1ml minoxidil directly to the vertex twice daily and add a 4-minute scalp massage before each application to prime absorption. Track with monthly overhead photos.'
                      : 'NW4 crown thinning responds best to minoxidil applied directly to the vertex twice daily, paired with a 4-minute scalp massage. Together these are the highest-ROI OTC combination at this stage — start this week and take an overhead photo today as your baseline.'
                : data.stage === 'NW3v'
                // NW3v = early crown thinning just started — this is the highest-ROI intervention window
                ? (_hasMinoxidil && _hasMassage)
                    ? 'NW3v means your crown thinning just started — this is the highest-ROI window. You have minoxidil and massage active: apply 1ml directly to the vertex BEFORE massaging so stimulated follicles absorb it immediately; track with overhead photos every 3 weeks.'
                    : _hasMinoxidil
                      ? 'NW3v crown thinning is at the earliest detectable stage — apply 1ml minoxidil directly to the vertex twice daily and add a 3-minute post-application scalp massage now. Catching it here gives the strongest response.'
                      : 'NW3v means your crown thinning has just started — the highest-ROI move is acting now: apply minoxidil directly to the vertex daily, add scalp massage, and take an overhead photo as your baseline today.'
                : data.stage === 'NW1'
                // NW1: crown is fully healthy — no targeted treatment needed; preventive messaging only
                ? (_hasDHTShampoo
                    ? 'Your crown is fully healthy at NW1. No targeted crown treatment needed yet — your DHT-blocking shampoo already provides preventive coverage. Take monthly overhead photos so any early vertex change is caught at the highest-ROI intervention window.'
                    : 'Your crown is healthy at NW1. No crown treatment needed yet — add a DHT-blocking shampoo 3× weekly as a general prevention layer and take monthly overhead photos to catch any early vertex change before it requires aggressive treatment.')
                : data.stage === 'NW2'
                // NW2: crown is intact, temples are the active priority — redirect focus there
                ? (_hasMinoxidil
                    ? 'Your crown is intact at NW2 — the temple recession is the active priority right now. Keep your topical focused on both temple corners and take monthly overhead photos to catch any early vertex thinning as soon as it appears.'
                    : 'Your crown is currently intact at NW2 — temples are the active zone. Focus treatment there first and track the crown monthly with overhead photos to catch any early vertex thinning before it needs aggressive intervention.')
                : (_hasMassage && _hasMinoxidil)
                    ? 'Massage and topical are both in your routine — optimize by applying minoxidil to the vertex directly after massaging so freshly stimulated follicles absorb more. Track with monthly overhead photos.'
                    : _hasMassage
                      ? 'Your massage habit is on — now add crown-targeted topical (minoxidil at vertex, 1ml) and take a weekly overhead photo to track baseline density.'
                      : 'Begin a crown-focused topical routine and take an overhead comparison photo now to track your baseline.',
          Health: _isNW7
            ? 'At NW7, scalp health maintenance protects remaining hair — keep any active routine going, but the highest-ROI step this week is booking a trichologist or transplant consultation to evaluate donor supply and candidacy.'
            : _isNW56
              ? 'Protect remaining follicles: use a gentle sulfate-free shampoo 3× weekly, add biotin/zinc if not already in your routine, and consider a dermatologist visit to rule out any inflammatory or nutritional component slowing response.'
              : data.stage === 'NW1'
                ? (_hasSupplements && _hasDHTShampoo
                    ? 'Your scalp is in strong preventive shape — target sleep quality this week (7-8 hrs). Cortisol from poor sleep accelerates miniaturization even before visible thinning begins.'
                    : _hasSupplements
                      ? 'Your supplement stack is active — add a DHT-blocking shampoo 3× weekly as a preventive layer. NW1 is the optimal window to build a protective routine before any thinning develops.'
                      : 'Your hair is healthy — protect it now: switch to a gentle sulfate-free shampoo, stay well-hydrated, and start a basic supplement stack (biotin, zinc, vitamin D) to support follicle health proactively.')
                : data.stage === 'NW2'
                  // NW2: earliest recession stage — scalp health is still strong, goal is protection and anti-miniaturization foundation
                  ? (_hasSupplements && _hasDHTShampoo
                      ? 'Supplements and DHT-blocking shampoo are building a strong preventive foundation at NW2 — maximize the DHT shampoo by leaving it on 3-5 minutes before rinsing. Contact time determines how much DHT suppression reaches the follicle level at the recession edge.'
                      : _hasSupplements
                        ? 'Your supplement stack is a good start — add a DHT-blocking shampoo 3× weekly at NW2. Used with 3-5 minutes of contact time before rinsing, it suppresses topical DHT at the recession edge where miniaturization is beginning.'
                        : 'At NW2, scalp health is still excellent — protect it now with a gentle sulfate-free shampoo, a DHT-blocking shampoo 3× weekly, and a supplement stack (biotin, zinc, vitamin D). Building the anti-miniaturization foundation here costs far less than treating established recession later.')
                  : data.stage === 'NW3'
                    // NW3: established AGA — miniaturization is active at the recession edge; scalp health needs to support topical treatment
                    ? (_hasSupplements && _hasDHTShampoo && _hasMassage
                        ? 'Your scalp-health kit is well-stocked at NW3 — add a weekly dermaroller session (0.5-1mm) over the recession edges. Microneedling primes the follicle microenvironment and significantly improves topical absorption precisely where miniaturization is most active at this stage.'
                        : _hasSupplements && _hasDHTShampoo
                          ? 'At NW3, the recession edge is where miniaturization is most active — add weekly microneedling (0.5mm) to the recession zones. It enhances absorption and follicle response where your existing supplement and DHT shampoo routine needs the most backup.'
                          : _hasSupplements
                            ? 'At NW3, DHT-blocking shampoo is the key missing layer — use it 3× weekly with 3-5 minutes of contact time. Scalp inflammation at the recession edge accelerates miniaturization; suppressing topical DHT alongside your supplements is the strongest dual response at this stage.'
                            : 'NW3 recession means miniaturization is actively progressing — switch to a sulfate-free shampoo, start a supplement stack (biotin, zinc, vitamin D), and add a DHT-blocking shampoo 3× weekly. Reducing inflammation at the recession edge reinforces every other treatment layer.')
                    : data.stage === 'NW3v'
                      // NW3v: dual-zone miniaturization active at temples AND early crown — scalp health must serve both fronts
                      ? (_hasSupplements && _hasDHTShampoo
                          ? 'At NW3v, two zones have active miniaturization — temples AND early crown. Add a weekly microneedling session (0.5mm) covering both zones to open absorption channels and stimulate blood flow to both active fronts. Use it 24-48 hours before topical application for maximum impact.'
                          : _hasDHTShampoo
                            ? 'DHT-blocking shampoo is a good start at NW3v — add a supplement stack (biotin, zinc, vitamin D) and weekly microneedling at both the recession edge AND the early crown zone. Two active miniaturization fronts need a full anti-inflammatory protocol, not just topicals.'
                            : 'NW3v means two zones are simultaneously thinning — scalp health must serve both. Add a DHT-blocking shampoo 3× weekly plus a supplement stack (biotin, zinc, vitamin D), and start weekly microneedling across the recession edge and early crown. Two-front miniaturization needs a two-front health protocol.')
                      : data.stage === 'NW4'
                        // NW4: significant miniaturization likely at both frontal and crown edges — scalp environment is critical for topical effectiveness
                        ? (_hasSupplements && _hasDHTShampoo && _hasMassage
                            ? 'At NW4 the full scalp-health kit is active — focus on absorption quality this week: microneedle the thinnest zones (0.5mm) 48 hours before topical application, and leave DHT shampoo on 3-5 minutes per wash. Scalp preparation quality determines how much of your treatment actually reaches the follicle.'
                            : _hasSupplements && _hasDHTShampoo
                              ? 'At NW4, add scalp massage before each topical application and consider weekly microneedling (0.5mm) over the thinnest zones — mechanical stimulation significantly improves topical absorption where miniaturization is most advanced, and your supplement and DHT shampoo stack benefits directly from it.'
                              : _hasDHTShampoo
                                ? 'At NW4, your DHT shampoo is handling topical suppression — add a supplement stack (biotin, zinc, vitamin D) and a pre-application scalp massage. Advanced miniaturization at NW4 needs every anti-inflammatory layer working together to maintain follicle health.'
                                : 'At NW4, scalp health needs the full anti-miniaturization stack: DHT-blocking shampoo 3× weekly (3-5 min contact time), a supplement stack (biotin, zinc, vitamin D), and weekly microneedling. Advanced miniaturization at this stage requires every layer to be active.')
                        : (_hasSupplements && _hasDHTShampoo)
                            ? 'Supplements and DHT-blocking shampoo are both active — target sleep quality this week: aim for 7-8 hours. Elevated cortisol from poor sleep accelerates miniaturization beyond what topicals can offset.'
                            : _hasSupplements
                              ? 'Continue your supplement routine — focus this week on scalp hygiene: reduce washing to 3-4× weekly, switch to a sulfate-free shampoo, and watch for scalp tension signs.'
                              : 'Skip sulfate shampoos this week, use a gentle scalp exfoliant mid-week, and increase water intake — scalp condition responds fast to hydration and less irritation.',
          Potential: _isNW7
            ? 'Your highest-ROI step is a transplant or SMP consultation — OTC treatments alone are unlikely to create meaningful change at NW7. Research experienced surgeons or SMP artists this week.'
            : _isNW5only
              ? (_hasFinasteride && _hasMinoxidil && _hasMassage && _hasDHTShampoo
                  ? 'NW5 with finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical protocol — realistic potential is toward the upper end of the NW5 range (35-48%). Set a 3-month checkpoint with overhead and front-facing photos; in parallel, research transplant consultations to plan the full strategy combining systemic treatment with potential surgical options.'
                  : _hasFinasteride && _hasMinoxidil && _hasDHTShampoo
                    ? 'NW5 with finasteride + minoxidil + DHT shampoo gives strong systemic and topical coverage — add weekly microneedling to prime follicle absorption and push toward the upper NW5 potential range. Set a 3-month checkpoint and consider booking a transplant consultation in parallel.'
                    : _hasFinasteride && _hasMinoxidil
                      ? 'NW5 with finasteride + minoxidil has the two most evidence-backed tools active — add a DHT-blocking shampoo 3× weekly and weekly microneedling to complete the stack. The combined protocol gives the strongest realistic NW5 response; set a 3-month checkpoint and book a transplant consultation to plan full coverage options.'
                      : _hasFinasteride
                        ? 'NW5 with finasteride providing systemic DHT suppression has a meaningful head start — add minoxidil across the entire scalp top twice daily, DHT-blocking shampoo 3× weekly, and weekly microneedling to maximize topical response alongside your systemic Rx. Set a 3-month checkpoint and book a transplant consultation in parallel to plan your full strategy.'
                        : _hasMinoxidil && _hasMassage && _hasDHTShampoo
                            ? 'At NW5, your OTC stack is fully deployed — realistic potential is 28-48%. Set a 3-month checkpoint with overhead and front-facing photos; if meaningful stabilization shows, continue the stack. In parallel, research transplant consultations: at NW5, combining OTC maintenance with surgical planning gives the most complete long-term strategy.'
                            : _hasMinoxidil && _hasDHTShampoo
                              ? 'At NW5, add weekly microneedling to your topical and DHT shampoo stack — it is the highest-ROI addition for maximizing response from remaining follicles. Set a 3-month checkpoint and consider booking a transplant consultation in parallel to plan your full strategy.'
                              : _hasMinoxidil
                                ? 'NW5 potential with OTC additions is still meaningful — pair your minoxidil with a DHT-blocking shampoo 3× weekly and weekly microneedling. This triple approach gives the strongest OTC response at this stage. Set a 3-month checkpoint, and consider booking a transplant consultation to evaluate surgical and OTC paths in parallel.'
                                : 'NW5 still has potential (28-48%) with a consistent OTC protocol — start the full stack this week: minoxidil across the entire scalp top twice daily, DHT-blocking shampoo 3× weekly, and weekly microneedling. OTC slows progression and buys time; simultaneously, consider booking a transplant consultation to plan your full-picture strategy.')
              : _isNW56
              // only NW6 reaches here — NW5 is handled by _isNW5only above
              ? (_hasFinasteride && _hasMinoxidil
                  ? 'At NW6 with finasteride + minoxidil, your protocol is well-optimized for non-surgical potential — realistic improvement is modest (15-32%), focused on slowing progression and protecting existing fringe. Set a 3-month checkpoint with overhead and front-facing photos, and prioritize booking a transplant consultation this quarter to plan surgical coverage alongside your OTC maintenance.'
                  : _hasFinasteride
                    ? 'Finasteride provides a systemic DHT advantage at NW6 — add minoxidil (twice daily, full top) and weekly microneedling to maximize non-surgical potential (realistic range: 15-32%). Set a 3-month checkpoint and book a transplant consultation in parallel to plan your complete coverage strategy.'
                    : _hasMinoxidil
                      ? 'At NW6, add weekly microneedling and a DHT-blocking shampoo to your minoxidil to give the best realistic shot at slowing progression (15-32% potential). Set a 3-month checkpoint and consider booking a transplant consultation this quarter — combining OTC maintenance with surgical planning is the most complete long-term strategy.'
                      : 'At your stage, combining minoxidil with weekly microneedling and a DHT-blocking shampoo gives the best realistic shot at slowing progression — set a 3-month checkpoint to assess response.')
              : data.stage === 'NW1'
                ? (_hasDHTShampoo && _hasSupplements)
                    ? 'Your preventive stack is solid — the highest-ROI next step is lifestyle: prioritize 7-8 hours of sleep and reduce chronic stress this week. Elevated cortisol accelerates follicle miniaturization even before visible thinning begins, and no supplement can offset poor recovery.'
                    : _hasDHTShampoo
                      ? 'Add a basic supplement stack (biotin, zinc, vitamin D) to complement your DHT-blocking shampoo — at NW1 your follicles are fully viable and this pairing forms the strongest long-term prevention layer before any visible loss starts.'
                      : 'Protect your potential now by starting a DHT-blocking shampoo 3× weekly and a supplement stack (biotin, zinc, vitamin D). At NW1 prevention is far more cost-effective than treatment later — follicles are fully viable and most responsive before visible loss begins.'
                : data.stage === 'NW2'
                  ? (_hasFinasteride && _hasMinoxidil)
                      ? 'NW2 is the ideal preventive window and your finasteride + minoxidil combination is the strongest possible non-surgical stack at this stage — keep both consistent. Confirm twice-daily minoxidil coverage on both temple corners and take finasteride at the same time each day without gaps for maximum long-term protection.'
                      : _hasFinasteride
                        ? 'NW2 is the ideal window and your finasteride already suppresses DHT systemically — add minoxidil directly to both temple corners twice daily for the complementary topical growth signal. The finasteride + minoxidil combination at NW2 delivers the most impactful prevention before recession deepens.'
                        : (_hasMinoxidil && _hasDHTShampoo)
                            ? 'Minoxidil and DHT shampoo are both active at NW2 — your stack is right for this stage. Confirm twice-daily coverage on both temple corners and leave the DHT shampoo on 3-5 minutes before rinsing. Consistency beats adding new products at this early stage.'
                            : _hasMinoxidil
                              ? 'At NW2 minoxidil is well-timed — add a DHT-blocking shampoo 3× weekly as the second prevention layer. Together they attack AGA from two angles (topical growth signal + DHT suppression), which delivers the strongest long-term response at this early stage.'
                              : _hasDHTShampoo
                                ? 'At NW2 the treatment window is open and follicles are still fully viable — add minoxidil directly to both temple corners twice daily. Pairing it with your existing DHT-blocking shampoo gives the strongest dual-mechanism response before recession deepens.'
                                : 'NW2 is the optimal window to act — start minoxidil on both temple corners and add a DHT-blocking shampoo 3× weekly. This dual approach (topical growth signal + DHT suppression) at the earliest detectable stage produces the strongest long-term ROI.'
                  : data.stage === 'NW3'
                    // NW3: strong treatment response window; deep recession is established but follicles at the edge are still highly responsive
                    ? (_hasFinasteride && _hasMinoxidil && _hasMassage
                        ? 'NW3 is a strong response window and your finasteride + minoxidil + massage stack is fully deployed — apply minoxidil to both recession zones immediately after a 4-minute scalp massage, and take finasteride at the same time each day. Consistent timing over the next 3-4 months is what converts this complete stack into measurable results.'
                        : _hasFinasteride && _hasMinoxidil
                          ? 'NW3 is a strong response window and you have the two most powerful tools active (finasteride + minoxidil) — add a 4-minute scalp massage before each topical application to prime absorption. This finasteride + minoxidil + massage combination is the strongest evidence-based non-surgical approach at NW3.'
                          : _hasFinasteride
                            ? 'NW3 is a pivotal window and your finasteride is already blocking DHT systemically — add minoxidil twice daily to both recession zones for the topical growth signal, plus a daily 4-minute scalp massage. The finasteride + minoxidil + massage stack gives the strongest documented response at this established stage.'
                            : _hasMinoxidil && _hasMassage && _hasDHTShampoo
                                ? 'NW3 is still a strong response window — your treatment stack is well-timed. Apply minoxidil to both recession zones immediately after a 4-minute scalp massage on wash days, and leave DHT shampoo on 3-5 minutes. Consistent timing over the next 3-4 months is what converts the stack into measurable results.'
                                : _hasMinoxidil && _hasMassage
                                  ? 'At NW3 you have minoxidil and massage in place — add a DHT-blocking shampoo 3× weekly as the third leg. The triple stack (topical + massage + DHT suppression) gives the strongest 6-month potential at this established stage.'
                                  : _hasMinoxidil
                                    ? 'NW3 has a strong treatment response window — pair your minoxidil with a 4-minute scalp massage before each application and a DHT-blocking shampoo 3× weekly. This triple approach is the OTC gold standard for maximizing potential at this stage.'
                                    : 'NW3 is a pivotal window: deep recession is established, but follicles at the edge are still highly responsive. Start the full stack — minoxidil twice daily on both recession zones, DHT-blocking shampoo 3× weekly, and a daily 4-minute scalp massage. Acting comprehensively now maximizes your 12-month potential.')
                    : data.stage === 'NW3v'
                      // NW3v: dual-zone active stage — both temples and early crown need simultaneous treatment to maximize potential
                      ? (_hasFinasteride && _hasMinoxidil && _hasMassage
                          ? 'NW3v is a dual-zone active stage and your finasteride + minoxidil + massage stack is fully deployed — confirm minoxidil covers BOTH temple recession zones AND the vertex each session, and take finasteride at the same time daily. Dual-zone consistency is what converts this complete stack into maximum potential across both active fronts.'
                          : _hasFinasteride && _hasMinoxidil
                            ? 'At NW3v two zones are active and your finasteride + minoxidil foundation is in place — add scalp massage (4 min, covering temples AND vertex) before each topical application. This trio (systemic DHT block + topical + mechanical) is the strongest dual-zone approach at NW3v.'
                            : _hasFinasteride
                              ? 'NW3v is a dual-zone stage (temples AND early crown active simultaneously) — your finasteride suppresses systemic DHT. Add minoxidil to BOTH zones (1ml per temple + 1ml vertex twice daily) plus daily scalp massage for maximum dual-zone potential.'
                              : _hasMinoxidil && _hasMassage && _hasDHTShampoo
                                  ? 'NW3v is an active dual-zone stage — your full stack is in place. Confirm that minoxidil covers BOTH temple recession zones AND the vertex each session; dual-zone coverage twice daily is what converts your current stack into maximum potential across both active fronts.'
                                  : _hasMinoxidil && _hasDHTShampoo
                                    ? 'At NW3v two zones are active simultaneously — add scalp massage (4 min, covering temples AND vertex) before each minoxidil application. Priming both fronts together maximizes absorption where your dual-zone treatment potential is highest.'
                                    : _hasMinoxidil
                                      ? 'NW3v means both temples and early crown need treatment simultaneously — add a DHT-blocking shampoo 3× weekly and ensure minoxidil reaches BOTH recession zones AND the vertex twice daily. Dual-zone coverage now prevents each front from advancing independently.'
                                      : 'NW3v is a dual-zone stage — both temples and early crown are active at the same time. Start minoxidil on BOTH zones (1ml per temple + 1ml vertex twice daily), add a DHT-blocking shampoo 3× weekly, and daily scalp massage. Simultaneous dual-zone coverage now gives the strongest window before either front advances.')
                      : data.stage === 'NW4'
                        // NW4: meaningful potential remains with the right protocol; realistic expectations and consistency are the keys
                        ? (_hasFinasteride && _hasMinoxidil && _hasMassage
                            ? 'At NW4 your finasteride + minoxidil + massage stack is the strongest non-surgical protocol available — set a 4-month checkpoint and take front-facing and overhead photos today as your baseline. Consistent uninterrupted coverage over 16+ weeks is what determines how much potential converts to visible density.'
                            : _hasFinasteride && _hasMinoxidil
                              ? 'At NW4 you have finasteride and minoxidil active — add a 4-minute scalp massage before each topical application to prime absorption. Mechanical stimulation is the highest-ROI addition to your existing finasteride + minoxidil stack at this stage.'
                              : _hasFinasteride
                                ? 'Finasteride gives NW4 users a meaningful potential advantage — add minoxidil across the entire top twice daily and daily scalp massage to complete the stack. Comprehensive, consistent coverage over 4+ months is what converts your finasteride foundation into visible results.'
                                : _hasMinoxidil && _hasMassage && _hasDHTShampoo
                                    ? 'At NW4 you have the right stack active — the outcome now depends on consistency and realistic expectations. Take front-facing and overhead photos today as your baseline, and set a 4-month checkpoint. Meaningful density change at NW4 typically takes 16+ weeks of uninterrupted coverage to show.'
                                    : _hasMinoxidil && _hasDHTShampoo
                                      ? 'At NW4 your topical and DHT shampoo are in place — add a 4-minute scalp massage before each minoxidil application. Mechanical stimulation improves absorption directly where miniaturization is most advanced and is the highest-ROI addition to an existing NW4 stack.'
                                      : _hasMinoxidil
                                        ? 'At NW4, pair your minoxidil with a DHT-blocking shampoo 3× weekly and a 4-minute scalp massage before each application. This triple approach — topical growth signal + DHT suppression + mechanical stimulation — is the strongest realistic OTC protocol at this stage.'
                                        : 'NW4 still has meaningful potential with the right protocol — start the full stack this week: minoxidil across the entire top twice daily, DHT-blocking shampoo 3× weekly (3-5 min contact time), and daily 4-minute scalp massage. Comprehensive, consistent coverage over 4+ months determines the outcome.')
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
      bumpSuccess(METRICS.scan);
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
  if (req.method === 'POST' && reqPath === '/api/coach') {
    try {
      METRICS.coach.requests++;
      const { message, history = [], userContext = {} } = await readJsonBody(req);
      if (!message || typeof message !== 'string') throw new Error('message required');
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
          weeklyFocus:       userContext.result.weeklyFocus ? String(userContext.result.weeklyFocus).slice(0, 400) : null,
          nextCheckInReason: userContext.result.nextCheckInReason ? String(userContext.result.nextCheckInReason).slice(0, 200) : null,
          thinningPattern:   userContext.result.thinningPattern || null,
        } : null,
        routine: Array.isArray(userContext.routine) ? userContext.routine : [],
        scanHistory: Array.isArray(userContext.history) ? userContext.history.slice(-6) : [],
        planProducts: Array.isArray(userContext.planProducts) ? userContext.planProducts.slice(0, 8) : [],
        routineDoneToday: Array.isArray(userContext.routineDoneToday) ? userContext.routineDoneToday.slice(0, 12) : [],
        weakestMetric:   userContext.weakestMetric  || userContext.result?.weakestMetric  || null,
        strongestMetric: userContext.strongestMetric || userContext.result?.strongestMetric || null,
        age:           coachProfile.age,
        sex:           coachProfile.sex || null,
        goals:         coachProfile.goals,
        concerns:      coachProfile.concern,
        timeline:      coachProfile.timeline || null,
        familyHistory: coachProfile.family,
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
        : `${Math.floor(daysSinceFirst / 7)} week${Math.floor(daysSinceFirst / 7) !== 1 ? 's' : ''}`;

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
              const pattern = h.thinningPattern ? ` pat:${h.thinningPattern}` : '';
              return `${h.overall ?? '?'}${date}${stage}${metrics}${pattern}`;
            }).join(', ')}${stageTrendStr ? `; stage progression: ${stageTrendStr}` : ctx.scanHistory[0]?.stage ? `; latest stage: ${ctx.scanHistory[0].stage}` : ''}.`
          : '- No scan history yet.',
        ctx.age ? `- Age: ${ctx.age}.` : '',
        ctx.sex ? `- Sex: ${ctx.sex}.` : '',
        ctx.goals.length ? `- Goals: ${ctx.goals.join(', ')}.` : '',
        ctx.concerns.length ? `- Concerns: ${ctx.concerns.join(', ')}.` : '',
        ctx.timeline ? `- Hair loss onset: ${ctx.timeline}.` : '',
        ctx.familyHistory.length ? `- Family history: ${ctx.familyHistory.join(', ')}.` : '',
        trackingDurationStr ? `- Treatment journey: ${trackingDurationStr} since first scan (${firstScanDateStr}) — when the user asks how long they've been tracking or when to expect results, reference this duration.` : '',
        trendStr ? `- Overall score trend: ${trendStr}.` : '',
        patternTrendStr
          ? `- Thinning pattern evolution (first → latest): ${patternTrendStr}${patternChanged ? ' — pattern has changed; reference this progression when giving zone-specific advice (e.g. crown thinning has developed since first scan).' : ' — pattern stable across scans.'}`
          : '',
        metricTrendStr ? `- Per-metric trends (first scan → latest, ${ctx.scanHistory.length} scans): ${metricTrendStr} — celebrate improving metrics; prioritize declining ones in your advice.` : '',
        recentIntervalStr ? `- Most recent scan interval (previous → latest): ${recentIntervalStr} — use this when the user asks "is it working?" or "did I improve since last time?" to give an accurate, specific answer rather than the all-time average.` : '',
      ].filter(Boolean).join('\n');

      // Trim history to last 10 turns for cost control
      const recentHistory = Array.isArray(history) ? history.slice(-10) : [];
      const messages = [
        { role: 'system', content: systemPrompt },
        ...recentHistory.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || '').slice(0, 1500) })),
        { role: 'user', content: message.slice(0, 1500) },
      ];

      const coachReqBody = JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.6, max_tokens: 1200 });
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
      if (coachUsage) console.log('[coach] ok', { ms: Date.now() - startedAt, tokens: { prompt: coachUsage.prompt_tokens, completion: coachUsage.completion_tokens }, finish: coachFinishReason });
      const coachTruncated = coachFinishReason === 'length';
      json(req, res, 200, { reply, truncated: coachTruncated, requestId: reqId });
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
