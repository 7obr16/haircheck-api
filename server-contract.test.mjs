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
  source.includes('At NW2, finasteride + minoxidil + DHT-blocking shampoo is the most complete non-surgical stack at this early preventive stage') &&
    source.includes('At NW2, finasteride + minoxidil covers systemic DHT suppression and the topical growth signal for your temple recession') &&
    source.includes('NW2 density is protected by finasteride (systemic DHT suppression) and your DHT-blocking shampoo') &&
    source.includes('Finasteride is already blocking systemic DHT at NW2 — add a DHT-blocking shampoo'),
  'WEEKLY_FOCUS_MAP.Density NW2 branch should be finasteride-aware across all Rx combinations: finasteride+minoxidil+DHT shampoo, finasteride+minoxidil, finasteride+DHT shampoo, and finasteride alone'
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
  source.includes('finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical density protocol — finasteride handles systemic DHT suppression across both frontal and crown loss zones') &&
    source.includes('Finasteride is suppressing systemic DHT at NW5 where density has declined across both frontal and crown zones'),
  'WEEKLY_FOCUS_MAP.Density NW5 branch should be finasteride-aware so Rx users at this advanced-dual-zone stage receive density guidance calibrated to their systemic DHT coverage'
);

assert(
  source.includes('At NW3v, finasteride + supplements + DHT shampoo + massage is the most complete anti-miniaturization protocol across both active fronts') &&
    source.includes('Mechanical priming at both active fronts amplifies the impact of every layer in your current four-layer protocol where miniaturization is simultaneously progressing'),
  'WEEKLY_FOCUS_MAP.Health NW3v branch should have a 4-layer (finasteride+supplements+DHT shampoo+massage) branch so users who already have scalp massage are told to add microneedling rather than being told mechanical stimulation is still the highest-ROI addition'
);

assert(
  source.includes('At NW3v, supplements + DHT shampoo + massage covers nutrition, topical DHT suppression, and mechanical stimulation across both active zones') &&
    source.includes('A doctor consult about finasteride is the highest-ROI next step for systemic DHT suppression at this dual-zone stage'),
  'WEEKLY_FOCUS_MAP.Health NW3v branch should have a 3-layer OTC+massage branch so OTC users who already have supplements+DHT shampoo+massage are directed to microneedling and finasteride consult rather than being told to add mechanical stimulation they already have'
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

assert(
  source.includes('NW3 deep temple recession with finasteride + minoxidil + massage is the most complete non-surgical stack at this pivotal window') &&
    source.includes('NW3 is a strong response window and your finasteride + minoxidil is the most evidence-backed combination') &&
    source.includes('Finasteride suppresses systemic DHT at NW3 — add minoxidil to both temple recession zones twice daily'),
  'WEEKLY_FOCUS_MAP.Hairline NW3 branch should be finasteride-aware so Rx users at the deep-recession established-AGA stage get hairline advice calibrated to their systemic DHT suppression'
);

assert(
  source.includes('NW3v has two active zones and your finasteride + minoxidil + massage protocol is fully deployed') &&
    source.includes('At NW3v two zones are thinning simultaneously and your finasteride + minoxidil is the right foundation') &&
    source.includes('Finasteride addresses the systemic DHT driving both active zones at NW3v'),
  'WEEKLY_FOCUS_MAP.Hairline NW3v branch should be finasteride-aware so Rx users at the dual-zone stage get hairline advice that accounts for the systemic DHT suppression already in place'
);

assert(
  source.includes('NW4 frontal hairline with finasteride + minoxidil + massage is the most complete non-surgical protocol') &&
    source.includes('Finasteride provides systemic DHT suppression at NW4 — add minoxidil applied along the entire frontal hairline twice daily'),
  'WEEKLY_FOCUS_MAP.Hairline NW4 branch should be finasteride-aware so Rx users at the significant-recession stage get hairline advice calibrated to their systemic DHT suppression'
);

assert(
  source.includes('NW4 frontal hairline with finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical protocol') &&
    source.includes('At NW4, finasteride + minoxidil + DHT shampoo delivers systemic and topical DHT suppression alongside the topical growth signal'),
  'WEEKLY_FOCUS_MAP.Hairline NW4 branch should be DHT-shampoo-aware: users with the complete 4-layer stack get the most-complete protocol confirmation; finasteride + minoxidil + DHT shampoo users are prompted to add massage'
);

assert(
  source.includes('At NW4, minoxidil + DHT shampoo + scalp massage covers topical growth signal, local DHT suppression, and mechanical stimulation across the full frontal hairline') &&
    source.includes('At NW4, minoxidil + DHT shampoo covers topical growth signal and local DHT suppression across the full frontal hairline'),
  'WEEKLY_FOCUS_MAP.Hairline NW4 OTC branches should be DHT-shampoo-aware: minoxidil + DHT shampoo + massage users get protocol confirmation with finasteride CTA; minoxidil + DHT shampoo users are prompted to add massage and consider finasteride'
);

assert(
  source.includes('NW5 frontal recession with finasteride providing systemic DHT suppression is a strong foundation') &&
    source.includes('NW5 frontal recession with finasteride + minoxidil + DHT shampoo is the strongest non-surgical protocol'),
  'WEEKLY_FOCUS_MAP.Hairline NW5 branch should be finasteride-aware so Rx users at the advanced-recession stage get hairline advice that builds on systemic DHT suppression'
);

assert(
  source.includes('At NW6, finasteride + minoxidil is your strongest non-surgical defense for the remaining fringe and temporal hair') &&
    source.includes('Finasteride is blocking systemic DHT at NW6 — add minoxidil to the fringe and temporal edges twice daily'),
  'WEEKLY_FOCUS_MAP.Hairline NW6 branch should be finasteride-aware so Rx users at the advanced merged-loss stage receive guidance that accounts for their systemic DHT coverage'
);

assert(
  source.includes('NW4 crown with finasteride + minoxidil + massage is the most complete non-surgical crown protocol') &&
    source.includes('Finasteride is suppressing DHT at NW4 — add minoxidil (1ml) applied directly to the vertex twice daily'),
  'WEEKLY_FOCUS_MAP.Crown NW4 branch should be finasteride-aware so Rx users at the significant-loss stage get vertex advice that builds on their systemic DHT suppression'
);

assert(
  source.includes('NW5 crown thinning with finasteride + minoxidil + massage is the most complete non-surgical vertex protocol') &&
    source.includes('Finasteride is suppressing systemic DHT at the NW5 crown zone'),
  'WEEKLY_FOCUS_MAP.Crown NW5 branch should be finasteride-aware so Rx users at the nearly-merging stage receive crown advice calibrated to their systemic DHT coverage'
);

assert(
  source.includes('At NW6, finasteride + minoxidil applied to the vertex twice daily is the most complete non-surgical protocol for crown coverage') &&
    source.includes('Finasteride is suppressing systemic DHT at NW6 — add minoxidil (1ml) directly to the vertex twice daily for the topical growth signal'),
  'WEEKLY_FOCUS_MAP.Crown NW6 branch should be finasteride-aware so Rx users at the advanced stage get crown advice that accounts for their systemic DHT suppression'
);

assert(
  source.includes('At NW5, your finasteride + supplement stack + DHT shampoo + stimulation protocol is the most complete scalp-health combination') &&
    source.includes('Finasteride is suppressing systemic DHT at NW5 — build on that foundation with a supplement stack (biotin, zinc, vitamin D)'),
  'WEEKLY_FOCUS_MAP.Health NW5 branch should be finasteride-aware so Rx users at this advanced dual-zone stage receive scalp-health guidance that builds on systemic DHT suppression'
);

assert(
  source.includes('At NW6, finasteride handles systemic DHT suppression for the remaining fringe — your supplement stack and DHT-blocking shampoo complete the anti-miniaturization protocol') &&
    source.includes('Finasteride is protecting remaining fringe follicles at NW6 through systemic DHT suppression'),
  'WEEKLY_FOCUS_MAP.Health NW6 branch should be finasteride-aware so Rx users at the advanced merged-loss stage get scalp-health advice that acknowledges their systemic DHT coverage'
);

assert(
  source.includes('NW3 is a strong response window and your finasteride + minoxidil + massage stack is fully deployed') &&
    source.includes('NW3 is a pivotal window and your finasteride is already blocking DHT systemically'),
  'WEEKLY_FOCUS_MAP.Potential NW3 branch should be finasteride-aware so Rx users at the pivotal treatment window get potential guidance that reflects their systemic DHT advantage'
);

assert(
  source.includes('NW3v is a dual-zone active stage and your finasteride + minoxidil + massage stack is fully deployed') &&
    source.includes('NW3v is a dual-zone stage (temples AND early crown active simultaneously) — your finasteride suppresses systemic DHT'),
  'WEEKLY_FOCUS_MAP.Potential NW3v branch should be finasteride-aware so Rx users at the dual-zone stage get potential guidance that reflects simultaneous two-front systemic DHT suppression'
);

assert(
  source.includes('At NW4 your finasteride + minoxidil + massage stack is the strongest non-surgical protocol available') &&
    source.includes('Finasteride gives NW4 users a meaningful potential advantage'),
  'WEEKLY_FOCUS_MAP.Potential NW4 branch should be finasteride-aware so Rx users at the established-loss stage get potential guidance calibrated to their systemic DHT suppression'
);

assert(
  source.includes('NW5 with finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical protocol') &&
    source.includes('NW5 with finasteride providing systemic DHT suppression has a meaningful head start'),
  'WEEKLY_FOCUS_MAP.Potential NW5 branch should be finasteride-aware so Rx users at this advanced stage receive potential guidance that reflects the systemic DHT advantage they already have'
);

assert(
  source.includes('At NW6 with finasteride + minoxidil, your protocol is well-optimized for non-surgical potential') &&
    source.includes('Finasteride provides a systemic DHT advantage at NW6'),
  'WEEKLY_FOCUS_MAP.Potential NW6 branch should be finasteride-aware so Rx users at the advanced stage receive potential guidance that accounts for their systemic DHT coverage and frames realistic expectations alongside surgical planning'
);

assert(
  source.includes('NW3v crown thinning has just started and your finasteride + minoxidil + massage stack is fully deployed') &&
    source.includes('NW3v early crown thinning with finasteride + minoxidil is the strongest available intervention') &&
    source.includes('NW3v means early crown thinning has just started — your finasteride is suppressing DHT systemically'),
  'WEEKLY_FOCUS_MAP.Crown NW3v branch should be finasteride-aware so Rx users at the dual-zone early-crown stage get vertex advice that builds on their systemic DHT suppression'
);

assert(
  source.includes('Your crown is still intact at NW3 — the deep temple recession is the active priority. Your finasteride + minoxidil stack targets the recession zones directly') &&
    source.includes('Your crown is intact at NW3 — temple recession is the current focus and your finasteride is already blocking systemic DHT'),
  'WEEKLY_FOCUS_MAP.Crown NW3 branch should be finasteride-aware so Rx users at the established-recession stage get crown advice that acknowledges their systemic DHT coverage while redirecting focus to the active temple recession zones'
);

assert(
  source.includes('Finasteride at NW2 is already protecting the crown through systemic DHT suppression — the temple recession is the active priority'),
  'WEEKLY_FOCUS_MAP.Crown NW2 branch should be finasteride-aware so Rx users at the earliest-recession stage get crown advice that acknowledges their systemic DHT coverage while redirecting focus to the active temple recession'
);

assert(
  source.includes("_hasDHTShampoo\n                    ? 'Your crown is fully intact at NW2 — your DHT-blocking shampoo is providing topical-level DHT protection at the crown. The temple recession is the active priority"),
  'WEEKLY_FOCUS_MAP.Crown NW2 branch should be DHT-shampoo-aware so OTC users with a DHT-blocking shampoo (but no finasteride or minoxidil) receive crown advice that acknowledges their active topical DHT protection and redirects focus to the temple recession'
);

assert(
  source.includes("_hasDHTShampoo\n                          ? 'Your crown is still intact at NW3 — your DHT-blocking shampoo is providing topical DHT suppression across the scalp top. The deep temple recession is the active priority"),
  'WEEKLY_FOCUS_MAP.Crown NW3 branch should be DHT-shampoo-aware so OTC users with a DHT-blocking shampoo (but no finasteride or minoxidil) receive crown advice that acknowledges their active topical DHT protection and redirects to the recession zones'
);

assert(
  source.includes('NW2 temple recession with finasteride + minoxidil is the strongest dual-mechanism approach at the ideal preventive stage') &&
    source.includes('Finasteride is already suppressing systemic DHT at NW2 — add minoxidil directly to both temple corners twice daily'),
  'WEEKLY_FOCUS_MAP.Hairline NW2 branch should be finasteride-aware so Rx users at the earliest-recession stage get hairline advice calibrated to their systemic DHT suppression'
);

assert(
  source.includes('At NW2, finasteride + supplements + DHT shampoo delivers systemic DHT suppression, nutritional support, and topical DHT control — the most complete scalp-health foundation at this early stage') &&
    source.includes('Finasteride suppresses systemic DHT at NW2 where miniaturization is just beginning'),
  'WEEKLY_FOCUS_MAP.Health NW2 branch should be finasteride-aware so Rx users at the earliest-recession stage get scalp-health guidance that builds on their systemic DHT suppression'
);

assert(
  source.includes('NW2 is the ideal preventive window and your finasteride + minoxidil + DHT-blocking shampoo covers every layer') &&
    source.includes('Finasteride + DHT-blocking shampoo gives dual-level DHT suppression at NW2') &&
    source.includes('NW2 is the ideal preventive window and your finasteride + minoxidil combination is the strongest possible non-surgical stack at this stage') &&
    source.includes('NW2 is the ideal window and your finasteride already suppresses DHT systemically'),
  'WEEKLY_FOCUS_MAP.Potential NW2 branch should be finasteride+DHT-shampoo-aware so Rx users at the earliest-recession stage get potential guidance that reflects their full multi-layer stack — the triple finasteride+minoxidil+DHT branch acknowledges all three layers, the dual finasteride+DHT branch adds the minoxidil recommendation, and existing single-finasteride and dual-finasteride+minoxidil branches remain distinct'
);

assert(
  source.includes('NW2 is the ideal prevention window and your minoxidil, scalp massage, and DHT-blocking shampoo cover the full OTC triple stack'),
  'WEEKLY_FOCUS_MAP.Potential NW2 branch should be minoxidil+massage+DHT-shampoo-aware so OTC users who already have all three layers get potential guidance that acknowledges the complete OTC stack rather than falling through to the dual-layer minoxidil+DHT branch that ignores their massage habit'
);

assert(
  source.includes('Your density is fully intact at NW1 and finasteride + DHT-blocking shampoo delivers dual-level DHT suppression') &&
    source.includes('Finasteride is suppressing systemic DHT at NW1 where density is completely intact'),
  'WEEKLY_FOCUS_MAP.Density NW1 branch should be finasteride-aware so preventive Rx users at the fully-intact stage see relevant density-protection guidance'
);

assert(
  source.includes('At NW2, minoxidil + DHT-blocking shampoo is a solid dual-mechanism OTC stack') &&
    source.includes('Minoxidil is active at NW2 — your density is still intact and this is the right preventive stage to add a DHT-blocking shampoo'),
  'WEEKLY_FOCUS_MAP.Density NW2 branch should be minoxidil-aware so OTC users (without finasteride) who already have minoxidil get density advice that acknowledges their topical treatment rather than ignoring it'
);

assert(
  source.includes('Mid-scalp density at NW3 with minoxidil + DHT shampoo + scalp massage covers the key OTC layers') &&
    source.includes('Mid-scalp density at NW3 with minoxidil + DHT shampoo gives both topical growth signal and local DHT suppression') &&
    source.includes('Mid-scalp density at NW3 with minoxidil and scalp massage is a strong two-layer approach') &&
    source.includes('Mid-scalp density at NW3 is thinning while follicles are still highly responsive — add a DHT-blocking shampoo 3× weekly') &&
    source.includes('NW3v mid-scalp and early crown with minoxidil + DHT shampoo + scalp massage is a strong OTC three-layer stack') &&
    source.includes('NW3v density with minoxidil + DHT shampoo targets both thinning zones') &&
    source.includes('NW3v mid-scalp and early crown with minoxidil and scalp massage covers topical growth signal and mechanical stimulation') &&
    source.includes('NW3v density is declining across mid-scalp and early crown — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) alongside your minoxidil'),
  'WEEKLY_FOCUS_MAP.Density NW3/NW3v branch should be minoxidil-aware so OTC users (without finasteride) who already have minoxidil get density advice that acknowledges their topical treatment rather than recommending they start it'
);

assert(
  source.includes("'What hormone and blood tests should I ask my doctor about for female hair loss?'") &&
    source.includes("'What is the most effective treatment for female-pattern hair loss?'") &&
    source.includes("'What results can I realistically expect from my female-pattern loss protocol over 6-12 months?'") &&
    source.includes("stage === 'n/a (female)'") &&
    !source.includes("stage === 'n/a (female)' || stage === 'diffuse'"),
  "buildSuggestedQuestions should give female-specific questions for n/a (female) stage (hormone panel, treatment question, expectations), distinct from diffuse-AGA questions — these are separate branches, not combined"
);

assert(
  source.includes("'My scan flagged a trichologist visit — should I see a specialist before starting treatment?'") &&
    source.includes("'My scan flagged a specialist visit — what should I bring up with a trichologist?'") &&
    source.includes("'My scan recommended a specialist visit — what questions should I ask a trichologist?'") &&
    source.includes('specialistRecommended') &&
    /buildSuggestedQuestions[\s\S]{0,3500}specialistRecommended\s*\?/.test(source),
  "buildSuggestedQuestions should use the specialistRecommended parameter to surface specialist-visit questions for NW3/NW3v/NW4 users flagged for a trichologist — the parameter must not be accepted but silently ignored"
);

assert(
  source.includes('suggestedFollowUps') &&
    source.includes('buildSuggestedQuestions(ctx.scan.stage, ctx.scan.protocolCoverage, ctx.scan.specialistRecommended)') &&
    source.includes('ctx.scan?.stage') &&
    source.includes("{ reply, truncated: coachTruncated, suggestedFollowUps, requestId: reqId }"),
  'coach response should include suggestedFollowUps: context-aware chips derived from scan stage and protocolCoverage, returned at zero API cost on every reply'
);

assert(
  source.includes('Your finasteride is protecting the remaining horseshoe fringe at NW7') &&
    source.includes('Your finasteride at NW7 helps protect the remaining fringe from further miniaturization') &&
    source.includes('At NW7, your finasteride helps protect remaining fringe density from further miniaturization') &&
    source.includes('At NW7, your finasteride is protecting remaining fringe follicles from further miniaturization') &&
    source.includes('At NW7, your finasteride adds meaningful value by protecting the remaining fringe from further miniaturization'),
  'WEEKLY_FOCUS_MAP NW7 Hairline/Crown/Density/Health/Potential entries should be finasteride-aware so Rx users at near-total loss see relevant fringe-protection advice alongside surgical planning'
);

assert(
  source.includes('Female-pattern frontal thinning with finasteride + minoxidil covers DHT suppression and the topical growth signal') &&
    source.includes('Finasteride is an active part of your female-pattern routine and provides DHT suppression for frontal thinning'),
  'WEEKLY_FOCUS_MAP.Hairline n/a (female) branch should be finasteride-aware so Rx female-pattern users get hairline advice that acknowledges their systemic DHT suppression'
);

assert(
  source.includes('Diffuse frontal thinning with finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and topical DHT control') &&
    source.includes('Finasteride provides systemic DHT suppression for diffuse frontal thinning'),
  'WEEKLY_FOCUS_MAP.Hairline diffuse branch should be finasteride-aware so Rx users with diffuse-pattern loss receive frontal-thinning advice calibrated to their systemic DHT suppression'
);

assert(
  source.includes('Female-pattern density with finasteride + minoxidil + DHT shampoo covers the key treatment layers') &&
    source.includes('Finasteride in your female-pattern routine provides DHT suppression for scalp density') &&
    source.includes('Diffuse density with finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and topical DHT control') &&
    source.includes('Finasteride provides systemic DHT suppression for diffuse density loss'),
  'WEEKLY_FOCUS_MAP.Density diffuse/n/a(female) branch should be finasteride-aware so Rx users at these stages receive density advice that accounts for their systemic DHT suppression'
);

assert(
  source.includes('Female-pattern crown thinning with finasteride + minoxidil + massage covers DHT suppression, topical growth signal, and mechanical stimulation') &&
    source.includes('Finasteride in your female-pattern routine provides DHT suppression for crown thinning') &&
    source.includes('Diffuse crown thinning with finasteride + minoxidil covers systemic DHT suppression and topical growth signal') &&
    source.includes('Finasteride provides systemic DHT suppression for diffuse crown thinning'),
  'WEEKLY_FOCUS_MAP.Crown diffuse/n/a(female) branch should be finasteride-aware so Rx users with diffuse or female-pattern crown thinning get advice calibrated to their systemic DHT coverage'
);

assert(
  source.includes('Female-pattern scalp health with finasteride + supplements + DHT shampoo covers systemic DHT suppression, nutritional support, and topical DHT control') &&
    source.includes('Finasteride in your female-pattern routine provides systemic DHT suppression for scalp health') &&
    source.includes('Diffuse scalp health with finasteride + supplements + DHT shampoo covers systemic DHT suppression, nutritional support, and topical DHT control') &&
    source.includes('Finasteride provides systemic DHT suppression for diffuse scalp health'),
  'WEEKLY_FOCUS_MAP.Health diffuse/n/a(female) branch should be finasteride-aware so Rx users with diffuse or female-pattern thinning get scalp-health advice that builds on their systemic DHT suppression'
);

assert(
  source.includes('Female-pattern potential is 55-78% and your finasteride + minoxidil + DHT shampoo covers the key treatment layers') &&
    source.includes('Female-pattern potential is 55-78% and finasteride in your routine provides systemic DHT suppression') &&
    source.includes('Diffuse potential is 55-78% and your finasteride + minoxidil + DHT shampoo covers systemic DHT suppression') &&
    source.includes('Diffuse potential is 55-78% and finasteride provides the systemic DHT suppression that significantly improves outcomes'),
  'WEEKLY_FOCUS_MAP.Potential diffuse/n/a(female) branch should be finasteride-aware so Rx users at these stages receive potential guidance that reflects their systemic DHT advantage'
);

assert(
  /weeklyFocus\s*:.*\.slice\(0,\s*6\d\d\)/.test(source) &&
    /weeklyFocusSecondary\s*:.*\.slice\(0,\s*6\d\d\)/.test(source),
  'coach context should truncate weeklyFocus and weeklyFocusSecondary at ≥600 chars so long stage-specific advice texts (NW5 full-stack, ~470 chars) are never cut mid-sentence when passed to gpt-4o-mini'
);

assert(
  source.includes("'How does finasteride fit into a hair transplant or SMP plan?'") &&
    source.includes("'Can I continue minoxidil after a hair transplant?'") &&
    source.includes("'Should I continue finasteride after a hair transplant?'") &&
    source.includes("'Should I add minoxidil to my finasteride at NW6?'"),
  'buildSuggestedQuestions NW6/NW7 branches should be routine-aware so Rx and OTC users at advanced stages get questions about integrating their treatment with surgical options'
);

assert(
  source.includes("stage === 'NW3v'") &&
    source.includes("'At NW3v, should I treat my temples and crown at the same time?'") &&
    source.includes("'Does finasteride help protect both my temples and crown at NW3v?'") &&
    source.includes("'Am I applying minoxidil to both my temple and crown zones at NW3v?'") &&
    source.includes("'Does scalp massage help both my temple and crown zones at NW3v?'") &&
    source.includes("'How do I track whether both my temples and crown are responding to treatment?'"),
  'buildSuggestedQuestions should have a dedicated NW3v branch with dual-zone-aware questions (temples AND crown) distinct from the generic NW3/NW4 fallback — NW3v users have two simultaneous active zones and need questions that reflect that'
);

assert(
  source.includes('At NW4, minoxidil and scalp massage cover topical growth signal and mechanical stimulation — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression where miniaturization is advancing across the mid-scalp. Stacking all three OTC layers gives the strongest non-surgical density response at this established stage.') &&
    source.includes('At NW5, minoxidil and scalp massage address topical growth signal and mechanical stimulation across both frontal and crown density loss zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression. Leave DHT shampoo on 3-5 minutes per wash and add weekly microneedling over the thinnest zones to prime follicle absorption and get the most from your existing protocol.'),
  'WEEKLY_FOCUS_MAP.Density NW4/NW5 branches should be minoxidil+massage-aware so OTC users who have both minoxidil and scalp massage but no DHT shampoo receive density advice acknowledging their two-layer protocol and recommending DHT shampoo as the missing layer'
);

assert(
  source.includes('At NW6, minoxidil and scalp massage address topical growth signal and mechanical stimulation across the remaining fringe — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical DHT suppression to complete the non-surgical density stack.') &&
    source.includes('At NW6, your minoxidil provides the topical growth signal across the fringe and lateral edges — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT suppression alongside it.'),
  'WEEKLY_FOCUS_MAP.Density NW6 branch should be minoxidil-aware so OTC users at NW6 who have minoxidil (but no DHT shampoo or finasteride) receive density advice that acknowledges their existing topical rather than suggesting they start minoxidil they already use'
);

assert(
  source.includes('NW5 frontal recession with finasteride + minoxidil + massage covers systemic DHT suppression, topical growth signal, and mechanical stimulation — apply minoxidil along the full frontal zone immediately after your scalp massage so primed follicles absorb it directly.') &&
    source.includes('NW5 frontal recession with minoxidil and scalp massage covers topical growth signal and mechanical stimulation — apply minoxidil along the full frontal zone immediately after your scalp massage so freshly stimulated follicles absorb it.'),
  'WEEKLY_FOCUS_MAP.Hairline NW5 branch should be minoxidil+massage-aware so OTC users (and Rx users) who have minoxidil and scalp massage but no DHT shampoo receive hairline advice that acknowledges both layers and recommends DHT shampoo as the missing leg'
);

assert(
  source.includes('NW5 frontal recession with finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical protocol — apply minoxidil along the full frontal zone immediately after your scalp massage so primed follicles absorb it, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time each day.'),
  'WEEKLY_FOCUS_MAP.Hairline NW5 4-combo branch should exist so users with finasteride + minoxidil + DHT shampoo + massage at NW5 receive advice acknowledging all four treatment layers'
);

assert(
  source.includes('At NW6, your minoxidil and scalp massage are both active — apply minoxidil along the fringe and temple edges immediately after each massage to prime freshly stimulated follicles for absorption.'),
  'WEEKLY_FOCUS_MAP.Hairline NW6 branch should be minoxidil+massage-aware so OTC users at NW6 who have minoxidil and massage receive hairline advice acknowledging their two-layer stack and recommending DHT shampoo'
);

assert(
  source.includes('At NW6, finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT blocking — apply minoxidil along the fringe and temple edges twice daily, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time each day.') &&
    source.includes('At NW6, minoxidil + DHT shampoo covers topical growth signal and local DHT blocking — apply minoxidil along the fringe and temple edges twice daily and leave DHT shampoo on 3-5 minutes per wash.'),
  'WEEKLY_FOCUS_MAP.Hairline NW6 branch should be DHT-shampoo-aware so users at NW6 with DHT shampoo in their protocol receive hairline advice that acknowledges the topical DHT-blocking layer'
);

assert(
  source.includes('Apply minoxidil directly to the crown (1ml) twice daily at NW6, immediately after each scalp massage to prime follicle absorption — add weekly microneedling over the crown zone and photograph from above every 6 weeks to track change.'),
  'WEEKLY_FOCUS_MAP.Crown NW6 branch should be minoxidil+massage-aware so OTC users at NW6 who have minoxidil and scalp massage receive crown advice that sequences minoxidil after massage for better vertex absorption'
);

assert(
  source.includes('At NW6, your minoxidil and scalp massage address topical growth signal and mechanical stimulation across the remaining fringe — add a DHT-blocking shampoo 3× weekly to complete the OTC stack for the strongest realistic non-surgical potential (15-32%).'),
  'WEEKLY_FOCUS_MAP.Potential NW6 branch should be minoxidil+massage-aware so OTC users at NW6 who have minoxidil and scalp massage receive potential guidance that acknowledges their two-layer OTC protocol and recommends DHT shampoo as the missing layer'
);

assert(
  source.includes('NW3v is a dual-zone active stage and your minoxidil + scalp massage cover the topical growth signal and mechanical stimulation across both zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the third leg.') &&
    source.includes('Confirm minoxidil reaches BOTH temple recession zones AND the vertex each session; the triple stack applied simultaneously to both active fronts gives the strongest OTC potential at NW3v.'),
  'WEEKLY_FOCUS_MAP.Potential NW3v branch should be minoxidil+massage-aware so OTC users who have minoxidil and scalp massage but no DHT shampoo receive dual-zone potential guidance acknowledging their two-layer protocol and recommending DHT shampoo as the missing leg'
);

assert(
  source.includes('At NW4, your minoxidil and scalp massage cover the topical growth signal and mechanical stimulation — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the third layer. The triple approach (topical + mechanical + DHT suppression) is the strongest realistic OTC protocol at NW4; set a 4-month checkpoint with front-facing and overhead photos today as your baseline.'),
  'WEEKLY_FOCUS_MAP.Potential NW4 branch should be minoxidil+massage-aware so OTC users who have minoxidil and scalp massage but no DHT shampoo receive potential guidance that acknowledges their two-layer stack and recommends DHT shampoo as the missing layer'
);

assert(
  source.includes("stage === 'NW4'") &&
    source.includes("'At NW4, should I be treating my frontal hairline and crown simultaneously?'") &&
    source.includes("'Does finasteride help protect both my frontal hairline and crown at NW4?'") &&
    source.includes("'Am I applying minoxidil correctly across both my frontal and crown zones at NW4?'") &&
    source.includes("'Does scalp massage help with NW4 frontal and crown coverage?'") &&
    source.includes("'How should I time scalp massage for both my frontal and crown zones at NW4?'") &&
    source.includes("'What results can I realistically expect from finasteride and minoxidil at NW4?'"),
  'buildSuggestedQuestions should have a dedicated NW4 branch with dual-zone-aware questions (frontal hairline AND crown) distinct from the generic NW3 fallback — NW4 users have two simultaneous active zones and need questions that reflect that'
);

assert(
  source.includes("'My scan flagged a trichologist visit — should I see a specialist before starting NW4 treatment?'") &&
    source.includes("'My scan flagged a specialist visit — what should I ask about NW4 treatment options?'") &&
    source.includes("'My scan recommended a specialist visit — what should I ask about my NW4 protocol?'"),
  'buildSuggestedQuestions NW4 branch should surface specialist-visit questions at all three protocol-coverage levels when specialistRecommended is true'
);

assert(
  source.includes("stage === 'NW3'") &&
    source.includes("'At NW3, what should I start first to stop my temple recession from deepening?'") &&
    source.includes("'Is finasteride worth adding at NW3 when my temples are already in deep recession?'") &&
    source.includes("'Am I applying minoxidil correctly to both temple recession zones at NW3?'") &&
    source.includes("'Does scalp massage improve minoxidil absorption at the temple recession edge at NW3?'") &&
    source.includes("'How should I time scalp massage with minoxidil for my NW3 temple recession?'") &&
    source.includes("'What results can I realistically expect from my protocol at NW3?'"),
  'buildSuggestedQuestions should have a dedicated NW3 branch with temple-recession-aware questions distinct from the generic fallback — NW3 users have established deep bilateral recession and need questions specific to that stage and treatment window'
);

assert(
  source.includes("'My scan flagged a trichologist visit — should I see a specialist before starting NW3 treatment?'") &&
    source.includes("'My scan flagged a specialist visit — what should I bring up about my NW3 temple recession?'") &&
    source.includes("'My scan recommended a specialist visit — what questions should I ask about my NW3 protocol?'"),
  'buildSuggestedQuestions NW3 branch should surface specialist-visit questions at all three protocol-coverage levels when specialistRecommended is true'
);

assert(
  source.includes('NW3 deep temple recession is established AGA — apply 1ml to each recession zone immediately after a 4-minute scalp massage and confirm full 1ml coverage per side morning and night. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression at the recession edge — it is the highest-ROI missing layer when minoxidil and massage are already in place at this pivotal stage.'),
  'WEEKLY_FOCUS_MAP.Hairline NW3 branch should be minoxidil+massage-aware so OTC users who have minoxidil and scalp massage but no DHT shampoo receive hairline advice that sequences minoxidil after massage for better recession absorption and recommends DHT shampoo as the highest-ROI next layer at this pivotal treatment window'
);

assert(
  source.includes('NW3v means temple recession AND early crown thinning are both active — apply 1ml minoxidil to both temple recession zones AND directly to the vertex immediately after each scalp massage so freshly primed follicles absorb it. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression across both active zones — it is the highest-ROI missing layer when minoxidil and massage are already in place at this dual-zone stage.'),
  'WEEKLY_FOCUS_MAP.Hairline NW3v branch should be minoxidil+massage-aware so OTC users at NW3v who have minoxidil and scalp massage but no DHT shampoo receive dual-zone hairline advice that sequences minoxidil immediately after massage and recommends DHT shampoo as the missing layer across both temple and crown zones'
);

assert(
  source.includes('Mid-scalp density at NW3 with minoxidil and scalp massage is a strong two-layer approach — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression at the recession edge. DHT shampoo completes the OTC density stack and slows miniaturization while follicles are still highly responsive.') &&
    source.includes('NW3v mid-scalp and early crown with minoxidil and scalp massage covers topical growth signal and mechanical stimulation across both active zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression. DHT shampoo completes the OTC density stack at this two-front stage.'),
  'WEEKLY_FOCUS_MAP.Density NW3/NW3v branches should be minoxidil+massage-aware so OTC users who have minoxidil and scalp massage but no DHT shampoo or finasteride receive density advice acknowledging their two-layer protocol and recommending DHT shampoo as the missing layer'
);

assert(
  source.includes('At NW3 you have minoxidil and massage in place — add a DHT-blocking shampoo 3× weekly as the third leg. The triple stack (topical + massage + DHT suppression) gives the strongest 6-month potential at this established stage.'),
  'WEEKLY_FOCUS_MAP.Potential NW3 branch should be minoxidil+massage-aware so OTC users at NW3 who have minoxidil and scalp massage but no DHT shampoo receive potential guidance that acknowledges their two-layer protocol and recommends DHT shampoo as the missing third leg at this pivotal treatment window'
);

assert(
  source.includes('NW3 is a strong response window and your finasteride + minoxidil + massage + DHT shampoo is the most complete non-surgical protocol — apply minoxidil to both recession zones immediately after a 4-minute scalp massage, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day.') &&
    source.includes('NW3 is a strong response window and your finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control — add a 4-minute scalp massage before each minoxidil application to complete the stack.') &&
    source.includes('NW3 has a strong treatment response window — add a 4-minute scalp massage before each minoxidil application to prime absorption where DHT pressure is highest at the recession edge. Your minoxidil and DHT shampoo cover the topical growth signal and local DHT suppression'),
  'WEEKLY_FOCUS_MAP.Potential NW3 branch should be DHT-shampoo-aware across all tiers: 4-combo (fin+min+massage+DHT) top tier, fin+min+DHT Rx tier (add massage), and OTC minoxidil+DHT tier (add massage) — so users with DHT shampoo in any combination receive acknowledgement rather than falling through to a branch that ignores it'
);

assert(
  source.includes('NW3v is a dual-zone stage and your finasteride + minoxidil + massage + DHT shampoo is the most complete non-surgical protocol — confirm minoxidil covers BOTH temple recession zones AND the vertex each session, apply it right after your scalp massage, and leave DHT shampoo on 3-5 minutes on wash days.') &&
    source.includes('At NW3v two zones are active and your finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control across both fronts — add scalp massage (4 min, covering temples AND vertex) before each topical application.'),
  'WEEKLY_FOCUS_MAP.Potential NW3v branch should be DHT-shampoo-aware in the Rx tiers: 4-combo (fin+min+massage+DHT) top tier acknowledges the complete protocol, and fin+min+DHT branch recommends massage as the missing layer — mirrors the NW5 pattern and prevents the fin+min+DHT combination from falling through to the fin+min branch that ignores the DHT shampoo'
);

assert(
  source.includes('At NW4 your finasteride + minoxidil + massage + DHT shampoo is the most complete non-surgical protocol — apply minoxidil immediately after a 4-minute scalp massage across the full frontal and crown zones, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day.') &&
    source.includes('At NW4 your finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control — add a 4-minute scalp massage before each topical application to prime absorption across the full frontal and crown zones.'),
  'WEEKLY_FOCUS_MAP.Potential NW4 branch should be DHT-shampoo-aware in the Rx tiers: 4-combo (fin+min+massage+DHT) top tier acknowledges the full stack, and fin+min+DHT branch recommends massage as the missing layer — mirrors the NW5 pattern and prevents the fin+min+DHT combination from silently falling through to the fin+min branch that ignores the DHT shampoo'
);

assert(
  source.includes('NW3 mid-scalp density with finasteride + minoxidil + scalp massage covers systemic DHT suppression, topical growth signal, and mechanical stimulation — apply minoxidil immediately after your 4-minute scalp massage so freshly primed follicles absorb it at the recession edge.') &&
    source.includes('NW3v mid-scalp and early crown with finasteride + minoxidil + scalp massage covers systemic DHT suppression, topical growth signal, and mechanical stimulation across both active zones — apply minoxidil immediately after your scalp massage across BOTH mid-scalp and vertex zones.'),
  'WEEKLY_FOCUS_MAP.Density NW3/NW3v branch should be finasteride+minoxidil+massage-aware so Rx users who also have minoxidil and scalp massage get density advice that acknowledges all three active layers and recommends DHT shampoo as the missing layer — not advice telling them to start minoxidil they already use'
);

assert(
  source.includes('At NW3, finasteride + minoxidil is the most evidence-backed non-surgical density combination — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT suppression where miniaturization is progressing at the recession edge, and pair each minoxidil application with a 4-minute scalp massage.') &&
    source.includes('At NW3v, finasteride + minoxidil addresses both systemic DHT suppression and topical growth signal across mid-scalp and early crown — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical-level DHT control across both active zones, plus a 4-minute scalp massage covering both the mid-scalp and vertex before each application.'),
  'WEEKLY_FOCUS_MAP.Density NW3/NW3v branch should be finasteride+minoxidil-aware so Rx users who also have minoxidil (but no DHT shampoo or massage) receive density advice that acknowledges their dual-mechanism protocol and recommends DHT shampoo + scalp massage as the next steps — not advice telling them to start minoxidil they already have'
);

assert(
  source.includes("stage === 'NW5'") &&
    source.includes("'At NW5, what OTC steps are still worth starting alongside a transplant plan?'") &&
    source.includes("'Is minoxidil worth starting at NW5, or is it too late for meaningful results?'") &&
    source.includes("'At NW5, when should I prioritize booking a hair transplant consultation?'") &&
    source.includes("'Is finasteride worth adding to my OTC protocol at NW5?'") &&
    source.includes("'Am I applying minoxidil correctly across both my frontal and crown zones at NW5?'") &&
    source.includes("'My scan recommended a transplant consultation — what OTC steps should I keep going alongside surgical planning at NW5?'") &&
    source.includes("'How do I get the most from my finasteride and minoxidil at NW5?'") &&
    source.includes("'My scan recommended a transplant consultation — how does my current NW5 protocol fit into a surgical plan?'") &&
    source.includes("'What results can I realistically expect from my NW5 protocol before committing to a transplant?'"),
  'buildSuggestedQuestions NW5 branch should use 3-tier protocol-coverage structure with transplant-consultation questions at every tier — NW5 specialistRecommended is always true so surgical planning context belongs in all branches, and questions must differ by whether the user has no treatment, OTC only, or Rx'
);

assert(
  source.includes('NW5 potential with minoxidil and scalp massage covers the topical growth signal and mechanical stimulation across both frontal and crown zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression. The three-layer OTC stack gives the strongest realistic non-surgical potential at NW5 (28-48%); set a 3-month checkpoint and consider booking a transplant consultation to plan surgical and OTC paths in parallel.'),
  'WEEKLY_FOCUS_MAP.Potential NW5 branch should be minoxidil+massage-aware so OTC users who have minoxidil and scalp massage but no DHT shampoo receive potential guidance that acknowledges their two-layer protocol and recommends DHT shampoo as the missing layer — not advice telling them to start minoxidil they already have'
);

assert(
  source.includes('NW2 temple recession with minoxidil and scalp massage covers topical growth signal and mechanical stimulation at the ideal preventive stage — apply minoxidil to both temple corners immediately after your scalp massage so freshly stimulated follicles absorb it. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression layer to complete the triple OTC approach before the M-shape deepens further.'),
  'WEEKLY_FOCUS_MAP.Hairline NW2 branch should be minoxidil+massage-aware so OTC users who have minoxidil and scalp massage but no DHT shampoo or finasteride receive hairline advice that sequences minoxidil after massage for better absorption and recommends DHT shampoo as the missing layer — not the generic minoxidil-only advice that ignores the active massage habit'
);

assert(
  source.includes('NW2 is the ideal prevention window and your minoxidil and scalp massage cover the topical growth signal and mechanical stimulation at the temple corners — apply minoxidil immediately after your scalp massage so freshly stimulated follicles absorb it. Add a DHT-blocking shampoo 3× weekly as the DHT-suppression third layer; the triple approach (topical + mechanical + DHT) delivers the strongest long-term potential at this earliest detectable stage.'),
  'WEEKLY_FOCUS_MAP.Potential NW2 branch should be minoxidil+massage-aware so OTC users who have minoxidil and scalp massage but no DHT shampoo or finasteride receive potential guidance that acknowledges their two-layer stack and recommends DHT shampoo as the missing third leg — not advice telling them to add DHT shampoo without acknowledging the massage they already do'
);

assert(
  source.includes('At NW2, minoxidil and scalp massage cover the topical growth signal and mechanical stimulation at the ideal preventive stage — apply minoxidil to both temple corners immediately after your scalp massage so freshly stimulated follicles absorb it. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; the triple OTC approach gives the strongest long-term density protection before any mid-scalp miniaturization begins.'),
  'WEEKLY_FOCUS_MAP.Density NW2 branch should be minoxidil+massage-aware so OTC users who have minoxidil and scalp massage but no DHT shampoo or finasteride receive density advice that sequences minoxidil after massage for better absorption and recommends DHT shampoo as the missing layer — not the generic minoxidil-only advice that ignores the active massage habit'
);

assert(
  source.includes("'Is finasteride worth adding to my OTC protocol at NW6?'") &&
    source.includes("'Am I applying minoxidil correctly to my remaining fringe and temple edges at NW6?'") &&
    source.includes("'How does my NW6 protocol fit into a transplant or SMP plan?'") &&
    /stage === 'NW6'[\s\S]{0,600}!hasAnyOTC && !rx/.test(source),
  "buildSuggestedQuestions NW6 branch should use 3-tier protocol-coverage structure (no-treatment / OTC-only / Rx) like NW5 — OTC-only users should be asked about adding finasteride and correct fringe application, Rx users should get transplant-integration context calibrated to whether they have minoxidil"
);

assert(
  source.includes("stage === 'NW7'") &&
    source.includes("'Should I start any OTC treatment or go straight to a transplant consultation at NW7?'") &&
    source.includes("'What should I ask a trichologist about at NW7?'") &&
    source.includes("'Is finasteride worth adding at NW7, or is surgical planning the priority?'") &&
    source.includes("'How does my current OTC routine fit into a transplant or SMP plan at NW7?'") &&
    /stage === 'NW7'[\s\S]{0,500}!hasAnyOTC && !rx/.test(source),
  "buildSuggestedQuestions NW7 branch should use 3-tier protocol-coverage structure (no-treatment / OTC-only / Rx) like NW5/NW6 — no-treatment users see realistic-options + first-step questions, OTC-only users are asked about Rx vs. surgical priority, Rx users get transplant-integration questions"
);

assert(
  source.includes("'Should I start minoxidil for early temple recession at NW2?'") &&
    source.includes("'Is finasteride worth starting at NW2 to prevent further recession?'") &&
    source.includes("'How quickly can NW2 progress without treatment?'") &&
    source.includes("'Is finasteride worth adding to my OTC routine at NW2?'") &&
    source.includes("'Am I applying minoxidil correctly to both temple corners at NW2?'") &&
    source.includes("'How do I know if my finasteride and minoxidil are slowing my NW2 recession?'") &&
    source.includes("'Should I add minoxidil to my finasteride at NW2?'") &&
    source.includes("'What results can I realistically expect from my NW2 protocol?'") &&
    /stage === 'NW2'[\s\S]{0,500}!hasAnyOTC && !rx/.test(source),
  "buildSuggestedQuestions NW2 branch should use 3-tier protocol-coverage structure (no-treatment / OTC-only / Rx) like NW3-NW7 — no-treatment users see starting-point questions, OTC-only users are asked about adding finasteride with OTC optimization, Rx users get tracking and results-expectation questions"
);

assert(
  source.includes("'Is it worth starting any treatment when my hair is still fully intact at NW1?'") &&
    source.includes("'Which prevention step has the strongest evidence at NW1?'") &&
    source.includes("'How will I know when I need to escalate from prevention to active treatment?'") &&
    source.includes("'Is finasteride worth starting at NW1 to strengthen my prevention protocol?'") &&
    source.includes("'How will I know if my NW1 prevention is actually working?'") &&
    source.includes("'Is finasteride enough on its own for NW1 prevention, or should I add something else?'") &&
    source.includes("'How long should I continue finasteride at NW1 before reassessing?'") &&
    /stage === 'NW1'[\s\S]{0,600}!hasAnyOTC && !rx/.test(source),
  "buildSuggestedQuestions NW1 branch should use 3-tier protocol-coverage structure (no-treatment / OTC-only / Rx) — no-treatment users see prevention-value and monitoring questions, OTC users are asked about adding finasteride and optimizing their DHT shampoo, Rx users get finasteride-adequacy and stack-completion questions"
);

assert(
  source.includes("r.includes('regaine')") &&
    source.includes("r.includes('proscar')") &&
    source.includes("r.includes('finpecia')") &&
    source.includes("r.includes('derma roller')") &&
    source.includes("r.includes('micro-needl')") &&
    source.includes("r.includes('nutrafol')") &&
    source.includes("r.includes('viviscal')") &&
    source.includes("r.includes('regenepure')"),
  'routine detection should recognise common product-name variants: Regaine (UK minoxidil), Proscar/Finpecia (finasteride brands), "derma roller"/"micro-needling" (spacing variants), Nutrafol/Viviscal (supplement brands), Regenepure (DHT shampoo brand)'
);

assert(
  source.includes("!pc && ctx.routine.length > 0") &&
    source.includes("s.includes('regaine')") &&
    source.includes("s.includes('proscar')") &&
    source.includes("s.includes('finpecia')") &&
    source.includes("s.includes('regenepure')") &&
    source.includes("s.includes('nutrafol')") &&
    source.includes("s.includes('viviscal')") &&
    source.includes("s.includes('derma roller')") &&
    source.includes("s.includes('micro-needl')"),
  'coach pre-scan protocolCoverage fallback should recognise the same product-name variants as scan-time detection (Regaine, Proscar/Finpecia, Regenepure, Nutrafol/Viviscal, "derma roller"/"micro-needl") so pre-scan users listing brand-name products have their protocol coverage computed correctly'
);

assert(
  source.includes("stage === 'n/a (female)'") &&
    source.includes("'What hormone and blood tests should I ask my doctor about for female hair loss?'") &&
    source.includes("'What is the most effective treatment for female-pattern hair loss?'") &&
    source.includes("'My scan flagged a specialist visit — what should I ask a dermatologist or gynecologist about female-pattern loss?'") &&
    source.includes("'Am I applying minoxidil correctly for female-pattern hair loss — central part, not just the hairline?'") &&
    source.includes("'Is minoxidil effective for female-pattern hair loss and how should I use it correctly?'") &&
    source.includes("'Should I ask my doctor about prescription treatments for female-pattern loss?'") &&
    source.includes("'What hormone and blood tests should I still get, even while using OTC treatment for female-pattern loss?'") &&
    source.includes("'How do I know if my current treatment is working for female-pattern loss — what signs should I look for?'") &&
    source.includes("'Should I add minoxidil to my current prescription treatment for female-pattern loss?'") &&
    source.includes("'What blood tests should I still ask about, even while on treatment for female-pattern loss?'") &&
    source.includes("'What results can I realistically expect from my female-pattern loss protocol over 6-12 months?'") &&
    /stage === 'n\/a \(female\)'[\s\S]{0,600}!hasAnyOTC && !rx/.test(source),
  "buildSuggestedQuestions n/a (female) branch should use 3-tier protocol-coverage structure (no-treatment / OTC-only / Rx) — no-treatment users see hormonal investigation + specialist questions, OTC-only users get minoxidil optimization + Rx prompt + bloodwork reminder, Rx users get efficacy signals + remaining bloodwork + realistic expectations"
);

assert(
  source.includes("stage === 'diffuse'") &&
    source.includes("'What blood tests should I ask my doctor about for diffuse thinning?'") &&
    source.includes("'What is the most effective first step for diffuse hair loss: topicals or root-cause testing?'") &&
    source.includes("'My scan flagged a specialist visit — what should I bring up about my diffuse thinning?'") &&
    source.includes("'Am I applying minoxidil correctly for diffuse thinning across the full scalp?'") &&
    source.includes("'Which OTC topical works best for diffuse thinning alongside my current routine?'") &&
    source.includes("'Is finasteride worth adding to my OTC routine to address the hormonal side of diffuse thinning?'") &&
    source.includes("'What blood workup should I still ask about while treating diffuse thinning with OTC products?'") &&
    source.includes("'How do I know if my finasteride and minoxidil are targeting the right cause of my diffuse thinning?'") &&
    source.includes("'Should I add minoxidil to my finasteride for diffuse thinning?'") &&
    source.includes("'What blood tests should I still ask about, even while on Rx treatment for diffuse thinning?'") &&
    source.includes("'What results can I realistically expect from my current diffuse thinning protocol?'") &&
    /stage === 'diffuse'[\s\S]{0,600}!hasAnyOTC && !rx/.test(source),
  "buildSuggestedQuestions diffuse branch should use 3-tier protocol-coverage structure (no-treatment / OTC-only / Rx) — no-treatment users see root-cause investigation + specialist questions, OTC-only users get topical optimization + Rx prompt + bloodwork reminder, Rx users get cause-targeting check + remaining bloodwork + realistic expectations"
);

assert(
  source.includes("'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + massage protocol at NW3?'") &&
    source.includes("'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + massage stack at NW3v?'") &&
    source.includes("'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + massage stack at NW4?'") &&
    source.includes("'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + massage stack at NW2?'"),
  'buildSuggestedQuestions Rx branches for NW2/NW3/NW3v/NW4 should be DHT-shampoo-aware: when mechanical is already active but dhtShampoo is not, surface a DHT shampoo question instead of a massage timing question'
);

assert(
  source.includes("'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + massage stack at NW5?'") &&
    source.includes("'Does scalp massage improve minoxidil absorption across both the frontal and crown zones at NW5?'") &&
    /stage === 'NW5'[\s\S]{0,2000}!mechanical[\s\S]{0,200}!dhtShampoo/.test(source),
  'buildSuggestedQuestions NW5 Rx branch should be DHT-shampoo-aware: when mechanical is missing ask about massage absorption across both frontal and crown zones; when massage is active but dhtShampoo is not, surface a DHT shampoo question; matches the NW2/NW3/NW3v/NW4 pattern'
);

assert(
  source.includes("_hasSupplements && _hasMassage\n                                            ? 'At NW4, your supplement stack and scalp massage cover nutritional support and mechanical stimulation") &&
    source.includes("_hasSupplements\n                                              ? 'Your supplement stack is supporting follicle health at NW4"),
  'NW4 Health WEEKLY_FOCUS_MAP should have separate branches for (supplements+massage) and (supplements alone) so users who already have supplements are never told to start a supplement stack'
);

assert(
  source.includes("_hasDHTShampoo && _hasMassage\n                                        ? 'At NW3, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation at the recession edge") &&
    source.includes("_hasDHTShampoo\n                                          ? 'Your DHT-blocking shampoo is suppressing topical DHT at the recession edge at NW3"),
  'NW3 Health WEEKLY_FOCUS_MAP should have separate branches for (dhtShampoo+massage) and (dhtShampoo alone) so users who already have a DHT-blocking shampoo are never told to add one'
);

assert(
  source.includes("_hasDHTShampoo && _hasMassage\n                                    ? 'At NW3v, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation across both the recession edge and early crown"),
  'NW3v Health WEEKLY_FOCUS_MAP should have a dedicated (dhtShampoo+massage) branch so users with both treatments active at this dual-zone stage receive nutritional-gap advice rather than the generic no-treatment fallback'
);

assert(
  source.includes('NW4 crown with finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical crown protocol — apply 1ml minoxidil to the vertex immediately after a 4-minute scalp massage, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time daily.') &&
    source.includes('At NW4, finasteride + minoxidil + DHT shampoo delivers systemic and topical DHT suppression alongside the topical growth signal for crown coverage — apply 1ml minoxidil directly to the vertex twice daily and leave DHT shampoo on 3-5 minutes on wash days. Add a 4-minute scalp massage before each topical application to complete the protocol') &&
    source.includes('At NW4, minoxidil + DHT shampoo + scalp massage covers topical growth signal, local DHT suppression, and mechanical stimulation at the vertex — apply 1ml minoxidil to the crown immediately after your scalp massage and leave DHT shampoo on 3-5 minutes on wash days.') &&
    source.includes('At NW4, minoxidil + DHT shampoo covers topical growth signal and local DHT control at the vertex — apply 1ml minoxidil directly to the crown twice daily and leave DHT shampoo on 3-5 minutes on wash days. Add a 4-minute scalp massage before each minoxidil application to prime vertex absorption'),
  'WEEKLY_FOCUS_MAP.Crown NW4 branch should be DHT-shampoo-aware across all tiers: 4-combo (fin+dht+min+massage) top tier, fin+dht+min Rx tier (add massage), OTC min+dht+massage tier (suggest finasteride), and OTC min+dht tier (add massage + suggest finasteride) — so users with DHT shampoo in any combination receive acknowledgement rather than falling through to a branch that ignores it'
);

assert(
  source.includes('NW3v crown thinning has just started and your finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical protocol — apply 1ml to the vertex immediately after your scalp massage, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time daily.') &&
    source.includes('NW3v early crown thinning with finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control at the vertex — apply 1ml minoxidil directly to the crown twice daily and leave DHT shampoo on 3-5 minutes on wash days. Add a 3-minute scalp massage before each topical application to complete the stack') &&
    source.includes('NW3v crown thinning has just started — your minoxidil, DHT shampoo, and scalp massage cover topical growth signal, local DHT suppression, and mechanical stimulation at the vertex. Apply 1ml minoxidil to the crown immediately after your massage and leave DHT shampoo on 3-5 minutes on wash days') &&
    source.includes('NW3v crown thinning is at the earliest detectable stage — your minoxidil and DHT shampoo cover topical growth signal and local DHT control at the vertex. Leave DHT shampoo on 3-5 minutes per wash and add a 3-minute scalp massage before each minoxidil application to prime vertex absorption.'),
  'WEEKLY_FOCUS_MAP.Crown NW3v branch should be DHT-shampoo-aware across all tiers: 4-combo (fin+dht+min+massage) top tier, fin+dht+min Rx tier (add massage), OTC min+dht+massage tier (suggest finasteride), and OTC min+dht tier (add massage + suggest finasteride) — catches the NW3v highest-ROI window with protocol-specific guidance for every combination that includes a DHT-blocking shampoo'
);

assert(
  source.includes('NW5 crown thinning with finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical vertex protocol — confirm 1ml minoxidil reaches the vertex directly after each scalp massage, leave DHT shampoo on 3-5 minutes on wash days, and take finasteride at the same time each day.') &&
    source.includes('At NW5, finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control at the crown zone — add a 4-minute scalp massage before each topical application to prime vertex follicle absorption where the frontal and crown zones are closest to merging.') &&
    source.includes('At NW5, your minoxidil, DHT shampoo, and scalp massage cover the three OTC layers at the crown — apply 1ml minoxidil directly to the vertex immediately after your scalp massage and leave DHT shampoo on 3-5 minutes on wash days.') &&
    source.includes('At NW5, your minoxidil and DHT shampoo cover topical growth signal and local DHT suppression at the crown — apply 1ml minoxidil directly to the vertex twice daily and leave DHT shampoo on 3-5 minutes on wash days. Add a 4-minute scalp massage before each application and weekly microneedling to prime vertex follicle absorption.'),
  'WEEKLY_FOCUS_MAP.Crown NW5 branch should be DHT-shampoo-aware across all tiers: 4-combo (fin+min+dht+massage) top tier, fin+min+dht Rx tier (add massage), OTC min+dht+massage tier (suggest finasteride), and OTC min+dht tier (add massage + suggest finasteride) — NW5 users with DHT shampoo in any combination should receive acknowledgement rather than falling through to a branch that ignores it'
);

assert(
  source.includes('At NW6, finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and local DHT control for crown coverage — apply 1ml minoxidil to the vertex twice daily, leave DHT shampoo on 3-5 minutes per wash, and keep finasteride consistent.') &&
    source.includes('Apply minoxidil directly to the crown (1ml) twice daily at NW6, immediately after each scalp massage and leave DHT shampoo on 3-5 minutes on wash days — add weekly microneedling over the crown zone and photograph from above every 6 weeks to track change. Consider booking a transplant consultation to evaluate vertex coverage options alongside your OTC maintenance.') &&
    source.includes('Apply minoxidil directly to the crown (1ml) twice daily at NW6 and leave DHT shampoo on 3-5 minutes on wash days — add a 4-minute scalp massage before each application and weekly microneedling to prime vertex follicle response.'),
  'WEEKLY_FOCUS_MAP.Crown NW6 branch should be DHT-shampoo-aware across three tiers: fin+min+dht Rx tier (add microneedling), OTC min+dht+massage tier (sequence minoxidil after massage + add microneedling), and OTC min+dht tier (add massage + microneedling) — NW6 users with DHT shampoo should not fall through to branches that ignore it'
);

assert(
  source.includes('At NW6, finasteride + minoxidil + DHT-blocking shampoo delivers systemic DHT suppression, topical growth signal, and local DHT control across the remaining fringe — apply minoxidil to the fringe and lateral edges twice daily and leave the DHT shampoo on 3-5 minutes per wash. Add weekly microneedling over the fringe zones to prime remaining follicle response (realistic potential: 15-32%). Set a 3-month checkpoint and prioritize booking a transplant consultation this quarter — your protocol covers every non-surgical layer and surgical planning is the most complete next step.') &&
    source.includes('At NW6, your minoxidil, DHT-blocking shampoo, and scalp massage cover topical growth signal, local DHT suppression, and mechanical stimulation across the remaining fringe — the strongest OTC triple stack at this stage. Apply minoxidil immediately after your scalp massage and leave DHT shampoo on 3-5 minutes per wash; add weekly microneedling to prime remaining follicle response (realistic potential: 15-32%). Set a 3-month checkpoint and consider booking a transplant consultation this quarter — combining this OTC stack with surgical planning is the most complete long-term strategy.') &&
    source.includes('At NW6, your minoxidil and DHT-blocking shampoo cover topical growth signal and local DHT suppression across the remaining fringe — apply minoxidil to the fringe and lateral edges twice daily and leave DHT shampoo on 3-5 minutes per wash. Add a 4-minute scalp massage before each application and weekly microneedling to complete the OTC stack (realistic potential: 15-32%). Set a 3-month checkpoint and consider booking a transplant consultation this quarter — combining OTC maintenance with surgical planning is the most complete long-term strategy.'),
  'WEEKLY_FOCUS_MAP.Potential NW6 branch should be DHT-shampoo-aware across all OTC tiers: fin+min+dht Rx tier (all non-surgical layers covered), OTC min+dht+massage tier (three-layer triple stack), and OTC min+dht tier (add massage + microneedling) — NW6 users with DHT shampoo should not fall through to branches that tell them to add shampoo they already have'
);

assert(
  source.includes('NW3v has two active zones and finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical protocol') &&
    source.includes('NW3v with finasteride + minoxidil + DHT shampoo delivers systemic DHT suppression, topical growth signal, and local DHT control across both active zones'),
  'WEEKLY_FOCUS_MAP.Hairline NW3v branch should be DHT-shampoo-aware: 4-combo (fin+min+dht+massage) and 3-combo (fin+min+dht) branches so users with DHT shampoo already active are never told to add it'
);

assert(
  source.includes('NW3 deep temple recession with finasteride + minoxidil + DHT shampoo + massage is the most complete non-surgical protocol at this pivotal window') &&
    source.includes('NW3 is the strongest treatment response window and finasteride + minoxidil + DHT shampoo covers systemic DHT suppression'),
  'WEEKLY_FOCUS_MAP.Hairline NW3 branch should be DHT-shampoo-aware: 4-combo (fin+min+dht+massage) and 3-combo (fin+min+dht) branches so users with DHT shampoo already active are never told to add it'
);

assert(
  source.includes('NW2 with finasteride + minoxidil + DHT-blocking shampoo is the most complete preventive stack at the ideal early detectable stage'),
  'WEEKLY_FOCUS_MAP.Hairline NW2 branch should be DHT-shampoo-aware: users with fin+min+dhtShampoo should not be told to add DHT shampoo they already have'
);

console.log('server contract passed');
