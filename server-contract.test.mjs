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
  source.includes('// only NW6 reaches here — NW5 is handled by _isNW5only above') &&
    source.includes('Finasteride is blocking systemic DHT at NW6 where density is mostly lost') &&
    source.includes('finasteride + minoxidil is the strongest non-surgical density combination'),
  'WEEKLY_FOCUS_MAP.Density NW6 branch should be finasteride-aware so Rx users at NW6 get relevant density advice'
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

assert(
  source.includes('Finasteride is already blocking DHT systemically at NW1') &&
    source.includes('finasteride + DHT-blocking shampoo gives you the strongest dual-level prevention') &&
    source.includes("Your NW1 prevention protocol is as complete as it gets") &&
    source.includes('finasteride + supplements + DHT-blocking shampoo'),
  'WEEKLY_FOCUS_MAP NW1 entries (Hairline, Crown, Health, Potential) should be finasteride-aware so preventive Rx users see relevant guidance'
);

assert(
  source.includes("data.stage === 'diffuse'") &&
    source.includes('Diffuse thinning typically spares the hairline') &&
    source.includes('frontal scalp-top thinning rather than classic temple recession') &&
    source.includes('not just the temples'),
  'WEEKLY_FOCUS_MAP.Hairline should have a diffuse stage branch so diffuse-thinning users never receive temple-recession advice (a lower hairline score for diffuse reflects frontal scalp-top thinning, not M-shape recession)'
);

assert(
  source.includes('NW2 density is protected by finasteride (systemic DHT suppression) and your DHT-blocking shampoo') &&
    source.includes('Finasteride is already blocking systemic DHT at NW2 — add a DHT-blocking shampoo'),
  'WEEKLY_FOCUS_MAP.Density NW2 branch should be finasteride-aware so Rx users at the earliest detectable stage receive relevant density-protection advice'
);

assert(
  source.includes('NW3 scalp health with finasteride + supplements + DHT shampoo + massage is the most complete anti-miniaturization protocol') &&
    source.includes('Finasteride is suppressing systemic DHT at NW3 — build the local scalp-health layer'),
  'WEEKLY_FOCUS_MAP.Health NW3 branch should be finasteride-aware so Rx users at the established-recession stage get targeted scalp-health guidance'
);

assert(
  source.includes('At NW4, finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical density protocol') &&
    source.includes('Finasteride is suppressing systemic DHT at NW4 where mid-scalp density is declining'),
  'WEEKLY_FOCUS_MAP.Density NW4 branch should be finasteride-aware so Rx users at the significant-loss stage get the most relevant density advice'
);

assert(
  source.includes('ctx.scan?.protocolCoverage ?? null') &&
    source.includes('!pc && ctx.routine.length > 0'),
  'coach should derive protocolCoverage from routine items when scan result lacks it, so protocol-layer status lines are available even before the first scan'
);

assert(
  source.includes('buildSuggestedQuestions') &&
    source.includes('coachSuggestedQuestions') &&
    source.includes('data.coachSuggestedQuestions = buildSuggestedQuestions(stage, data.protocolCoverage, data.specialistRecommended)'),
  'scan should include coachSuggestedQuestions: 3 context-aware coach conversation starters derived from stage and protocolCoverage'
);

assert(
  source.includes("'What are my realistic options at NW7?'") &&
    source.includes("'Should I book a hair transplant consultation now?'") &&
    source.includes("'What blood tests should I ask my doctor about for diffuse thinning?'"),
  'buildSuggestedQuestions should include specialist-aware questions for NW6/NW7 and cause-investigation questions for diffuse/female'
);

assert(
  source.includes('NW3 mid-scalp density with finasteride + DHT shampoo + scalp massage covers the key anti-miniaturization layers') &&
    source.includes('Finasteride suppresses systemic DHT at NW3 — add a DHT-blocking shampoo 3× weekly') &&
    source.includes('NW3v density spans mid-scalp and early crown — your finasteride + DHT shampoo + scalp massage covers all three anti-miniaturization layers') &&
    source.includes('Finasteride suppresses systemic DHT at NW3v where density is declining across mid-scalp and early crown'),
  'WEEKLY_FOCUS_MAP.Density NW3/NW3v branch should be finasteride-aware so Rx users at the established-recession stage get density advice that accounts for systemic DHT suppression'
);

assert(
  source.includes('At NW3v, finasteride + supplements + DHT shampoo is providing systemic and topical DHT suppression across both active miniaturization fronts') &&
    source.includes('Finasteride provides systemic DHT suppression at NW3v where temples and early crown are simultaneously active'),
  'WEEKLY_FOCUS_MAP.Health NW3v branch should be finasteride-aware so Rx users at the dual-zone stage get scalp-health advice that builds on systemic DHT suppression'
);

assert(
  source.includes('NW4 scalp health with finasteride + supplements + DHT shampoo + massage is the most complete anti-miniaturization protocol') &&
    source.includes('Finasteride is blocking systemic DHT at NW4 where miniaturization spans both the frontal and crown zones'),
  'WEEKLY_FOCUS_MAP.Health NW4 branch should be finasteride-aware so Rx users at the significant-loss stage get scalp-health guidance calibrated to their systemic DHT coverage'
);

console.log('server contract passed');
