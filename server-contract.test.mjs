import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');

assert(source.includes('ADVICE_VISUAL_PROMPTS'), 'server should define prompt presets for generated advice visuals');
assert(source.includes('ADVICE_VISUAL_CACHE') && source.includes('ADVICE_VISUAL_INFLIGHT'), 'server should cache and dedupe advice visual generation');
assert(source.includes("/api/generate-advice-visual"), 'server should expose /api/generate-advice-visual');
assert(source.includes('images/generations'), 'advice visuals should use the image generation endpoint');
assert(/kind:\s*'topical'/.test(source) || source.includes("case 'topical'"), 'server should support topical advice visuals');
assert(
  source.includes('Do NOT create a new hairstyle') &&
    source.includes('Do NOT change the existing hair length') &&
    source.includes('Only add plausible density inside the already visible thinning') &&
    !source.includes('natural full head of hair. The new hair must match'),
  'after-photo prompt should preserve the original hairstyle and only fill visible thinning/bald areas'
);
assert(
  source.includes('const effectivePrompt = prompt ||') &&
    source.includes("cacheHashOf('after', mime, buffer.length, createHash('sha256').update(buffer).digest('hex'), effectivePrompt, quality)") &&
    source.includes("fd.append('prompt', effectivePrompt)"),
  'generate-after cache key should include the effective default prompt so prompt changes invalidate old cached images'
);
assert(
  source.includes('buildAfterPrompt') &&
    source.includes('AFTER_STAGE_HINTS') &&
    source.includes('NW2') && source.includes('NW6') && source.includes("n/a (female)"),
  'generate-after should accept a stage parameter and append stage-specific zone hints'
);
assert(
  source.includes('Use a balanced visual baseline') &&
    source.includes('Do not artificially lower scores for healthy-looking or stable-looking areas') &&
    !source.includes('Most paying users should land 45-72 overall'),
  'analysis scoring prompt should stay truthful and balanced instead of pushing most users into pessimistic low ranges'
);

assert(
  source.includes("!data.insights.some((ins) => ins.metric === _weakLabel)") &&
    source.includes("_weakFallback") &&
    source.includes("data.insights[2] = _weakFallback"),
  'scan should guarantee the weakest metric is covered by at least one insight'
);

assert(
  source.includes('STATIC_METRIC_FALLBACKS') &&
    source.includes('Deduplicate insight metrics') &&
    source.includes('_usedMetrics.size < rawInsights.length') &&
    source.includes('CRITICAL diversity rule'),
  'scan should deduplicate insight metrics so all 3 insights cover distinct metrics'
);

assert(
  source.includes("NW5:  'bitemporal+crown'") &&
    source.includes("NW1:  'minimal'"),
  'STAGE_THINNING_OVERRIDES should enforce NW1→minimal and NW5→bitemporal+crown to prevent inconsistent stage/pattern pairs'
);

assert(
  source.includes("NW2:  'bitemporal'") &&
    source.includes("NW3:  'bitemporal'"),
  'STAGE_THINNING_OVERRIDES should enforce NW2→bitemporal and NW3→bitemporal to prevent minimal or bitemporal+crown from being returned for those stages'
);

assert(
  source.includes('/api/generate-progression-batch') &&
    source.includes('Promise.all(months.map'),
  'server should expose /api/generate-progression-batch that runs all months in parallel'
);

assert(
  source.includes('_isNW5only') &&
    source.includes('NW5 density loss spans both frontal and crown zones'),
  'WEEKLY_FOCUS_MAP.Density should have NW5-specific advice distinct from the NW6/NW7 fallback'
);

assert(
  source.includes('max_tokens: 2000'),
  'scan should use max_tokens: 2000 to reduce truncation risk for structured output'
);

assert(
  source.includes('specialistRecommended') &&
    source.includes('SPECIALIST_STAGES') &&
    source.includes('specialistReason') &&
    source.includes('NW5') && source.includes('NW6') && source.includes('NW7') &&
    source.includes('diffuse') && source.includes("'n/a (female)'"),
  'scan should include specialistRecommended boolean and specialistReason for stages where OTC alone is insufficient or a workup is needed'
);

assert(
  source.includes("data.stage === 'n/a (female)'") &&
    source.includes('Female-pattern thinning rarely recedes the hairline like male AGA') &&
    source.includes('not the temples'),
  'WEEKLY_FOCUS_MAP.Hairline should have a n/a (female) branch so female-pattern users never receive temple-recession advice'
);

assert(
  source.includes('buildPhotoGuidance') &&
    source.includes('parting line and scalp top are the most diagnostically important zones for female-pattern thinning') &&
    source.includes('part your hair down the center') &&
    source.includes('capturing both your hairline and crown in the same overhead shot'),
  'buildPhotoGuidance should return female-specific central-parting guidance for n/a (female) users and advanced-stage guidance for NW5+ users'
);

assert(
  source.includes("NW1:  'Show HIGH density (green/teal) uniformly across the entire scalp top") &&
    source.includes('do NOT place any red, orange, or yellow patches anywhere'),
  'MAP_STAGE_HINTS should include NW1 so analysis maps for fully-healthy scalps show uniform high-density overlay, not misleading thinning indicators'
);

assert(
  source.includes('FEMALE_THINNING_ZONES_MAP') &&
    source.includes("diffuse: ['frontal', 'mid-scalp', 'crown']") &&
    source.includes("total:   ['frontal', 'mid-scalp', 'crown', 'vertex']") &&
    source.includes("stage === 'n/a (female)'\n            ? (FEMALE_THINNING_ZONES_MAP"),
  'thinningZones for n/a (female) should exclude temples since female-pattern AGA spares the temporal hairline'
);

console.log('server contract passed');
