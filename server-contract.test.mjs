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
  source.includes('_isAdvancedForFallback') &&
    source.includes("Protect the remaining fringe") &&
    source.includes("Plan coverage; protect the fringe") &&
    source.includes("Maximize realistic outcomes") &&
    source.includes("data.stage === 'NW6' || data.stage === 'NW7'"),
  'weakest-metric fallback insights should use surgical-aware language at NW6/NW7 — not promise "treatment response window is open" when FUE/FUT or SMP is the primary path'
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
  source.includes("month === 6 && PROGRESSION_ADVANCED_STAGES.has(stage)") &&
    source.includes("OVERRIDES the \"40–50% closer to full density\" language above") &&
    source.includes("far more modest than the 40–50% figure implies"),
  'buildProgressionPrompt should override the 40-50% density language for NW5-NW7 at 6 months, matching the existing 12-month override pattern for advanced stages'
);

assert(
  source.includes("month === 12 && PROGRESSION_CALIBRATED_12MO_STAGES.has(stage)") &&
    source.includes("CALIBRATES the \"Full natural-looking density\" language above") &&
    source.includes("NW2 hairline, NOT a fully restored NW1 hairline") &&
    source.includes("PROGRESSION_CALIBRATED_12MO_STAGES = new Set(['NW3', 'NW3v'])"),
  'buildProgressionPrompt should apply a calibrated 12-month override for NW3/NW3v that prevents the "Full natural-looking density" language from producing a fully-restored NW1 result — realistic 12-month ceiling is NW2-equivalent, not complete recession erasure'
);

assert(
  source.includes("month === 12 && stage === 'NW4'") &&
    source.includes('35–45% of its current exposed scalp area') &&
    source.includes('NW2-to-NW3 appearance') &&
    source.includes('NOT a fully restored NW1 straight hairline'),
  'buildProgressionPrompt should apply a specific NW4 12-month calibration that constrains the crown to retain 35-45% exposed scalp area and the hairline to a NW2-NW3 equivalent — preventing the generic "full density" base prompt from producing an unrealistic fully-restored result at this significant-loss stage'
);

assert(
  source.includes("month === 12 && stage === 'NW5'") &&
    source.includes('50–60% of the current exposed scalp area') &&
    source.includes('sparse bridge between the frontal and crown zones'),
  'buildProgressionPrompt should apply a specific NW5 12-month calibration that constrains the scalp top to retain 50-60% exposed scalp area — preventing the generic "full density" base prompt from overstating the modest real-world improvement ceiling at this near-merged loss stage'
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
  source.includes('max_tokens: 1800') || source.includes('max_tokens: 2400') || source.includes('max_tokens: 2500'),
  'scan should use at least 1800 max_tokens to avoid truncating structured JSON output'
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
    source.includes('narrow bridge of hair between the two thinning zones') &&
    source.includes('fringe width and density are the key features at NW7') &&
    source.includes('Both fringe edges need to be in frame at NW6'),
  'buildPhotoGuidance should return female-specific central-parting guidance for n/a (female) users and stage-specific guidance for NW5 (bridge focus), NW6 (merged fringe extent), and NW7 (horseshoe fringe width)'
);

assert(
  source.includes('At NW3v both zones are active and need to be captured together') &&
    source.includes('NW3v has two active zones and both should be in frame') &&
    source.includes("Early M-shape recession is subtle — capturing both temples at once gives the clearest NW2 baseline") &&
    source.includes('early temple recession is subtle and easier to measure when both sides are visible simultaneously'),
  'buildPhotoGuidance should have NW3v-specific dual-zone angle guidance and NW2-specific temple-corner guidance for subtle early recession'
);

assert(
  source.includes("stage === 'diffuse'") &&
    source.includes('Diffuse thinning is distributed across the entire scalp top') &&
    source.includes('diffuse thinning is distributed across the entire scalp top and a straight overhead angle captures the full extent'),
  "buildPhotoGuidance should have diffuse-specific straight-overhead guidance so diffuse-pattern users get angle advice appropriate for uniform thinning, not localized-recession advice"
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
  source.includes('At NW3, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression at the active temple recession edge — take finasteride at the same time each day and leave DHT shampoo on 3-5 minutes per wash 3× weekly.'),
  'WEEKLY_FOCUS_MAP.Health NW3 branch should have a finasteride+DHT-shampoo compound branch so users who have both but no supplements are told to add supplements and microneedling — not incorrectly told to add DHT-blocking shampoo they already use'
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
  source.includes("_pqStageChange.stageDirection === 'improved'") &&
    source.includes('is this real progress from my treatment or photo variability?') &&
    source.includes('how do I know if my OTC routine caused this and how do I sustain it?') &&
    source.includes("without treatment — what does this mean and should I start a protocol now?"),
  'scan should override the first coachSuggestedQuestion with a stage-improvement question when a rescan shows the stage improved, symmetric to the existing stage-progression override'
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
  source.includes('At NW3v, finasteride + DHT-blocking shampoo delivers dual-level DHT suppression across both active zones — systemic through finasteride and topical through the shampoo (3-5 min contact time 3× weekly). Add minoxidil to BOTH the temple recession zones AND the vertex twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the most complete non-surgical dual-zone protocol at this pivotal NW3v window.'),
  'WEEKLY_FOCUS_MAP.Hairline NW3v branch should have a finasteride+DHT-shampoo compound branch so users who have dual DHT suppression but no minoxidil at NW3v get dual-zone advice acknowledging both layers and recommending minoxidil as the missing growth signal'
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
  source.includes('NW5 frontal recession with minoxidil + DHT shampoo + scalp massage covers topical growth signal, local DHT suppression, and mechanical stimulation'),
  'WEEKLY_FOCUS_MAP.Hairline NW5 OTC branch should be DHT-shampoo+massage-aware: minoxidil + DHT shampoo + massage users get protocol confirmation with finasteride CTA rather than falling into the minoxidil+DHT branch that ignores their massage'
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
  source.includes('At NW5, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression across both frontal and crown thinning zones') &&
    source.includes('finasteride + minoxidil + DHT shampoo is the strongest non-surgical NW5 protocol (realistic potential: 28-48%)'),
  'WEEKLY_FOCUS_MAP.Potential NW5 should have a finasteride+DHT-shampoo compound branch so users on fin+DHT-shampoo (without minoxidil) do not fall through to the standalone finasteride branch that ignores their topical DHT layer'
);

assert(
  source.includes('At NW6, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression for the remaining fringe and lateral edges') &&
    source.includes('finasteride + minoxidil + DHT shampoo is the strongest non-surgical fringe protocol (realistic potential: 15-32%)'),
  'WEEKLY_FOCUS_MAP.Potential NW6 should have a finasteride+DHT-shampoo compound branch so users on fin+DHT-shampoo (without minoxidil) do not fall through to the standalone finasteride branch that ignores their topical DHT layer'
);

assert(
  source.includes('NW3v crown thinning has just started and your finasteride + minoxidil + massage stack is fully deployed') &&
    source.includes('NW3v early crown thinning with finasteride + minoxidil is the strongest available intervention') &&
    source.includes('NW3v means early crown thinning has just started — your finasteride is suppressing DHT systemically'),
  'WEEKLY_FOCUS_MAP.Crown NW3v branch should be finasteride-aware so Rx users at the dual-zone early-crown stage get vertex advice that builds on their systemic DHT suppression'
);

assert(
  source.includes('NW3v early crown thinning with finasteride + DHT-blocking shampoo delivers dual-level DHT suppression at the vertex — systemic through finasteride and topical through the shampoo (3-5 min contact time 3× weekly). Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo at NW3v is the strongest non-surgical crown combination at this highest-ROI intervention window.'),
  'WEEKLY_FOCUS_MAP.Crown NW3v branch should have a finasteride+DHT-shampoo compound branch so users with dual DHT suppression but no minoxidil at NW3v get vertex advice acknowledging both suppression layers and recommending minoxidil as the missing crown growth signal'
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
  source.includes("_hasFinasteride && _hasDHTShampoo\n                    ? 'Finasteride + DHT-blocking shampoo gives you dual-level DHT protection at NW2 — systemic and topical control keeps the crown well-guarded. The temple recession is the active priority"),
  'WEEKLY_FOCUS_MAP.Crown NW2 branch should have a combined finasteride+DHT-shampoo branch so users with dual DHT suppression at NW2 receive crown advice acknowledging both layers and redirecting to the temple recession priority'
);

assert(
  source.includes("_hasFinasteride && _hasMinoxidil && _hasDHTShampoo\n                    ? 'Your crown is intact at NW3 — finasteride + minoxidil + DHT-blocking shampoo gives you systemic DHT suppression, topical growth signal, and topical DHT control across the full scalp top. The deep temple recession is the active priority"),
  'WEEKLY_FOCUS_MAP.Crown NW3 branch should have a finasteride+minoxidil+DHT-shampoo branch so users with all three active at NW3 receive crown advice that acknowledges the full three-layer protocol rather than falling through to the fin+min branch that ignores DHT shampoo'
);

assert(
  source.includes("_hasFinasteride && _hasDHTShampoo\n                      ? 'Your crown is intact at NW3 — finasteride + DHT-blocking shampoo gives you dual-level DHT protection across the entire scalp top. The deep temple recession is the active priority"),
  'WEEKLY_FOCUS_MAP.Crown NW3 branch should have a combined finasteride+DHT-shampoo branch so users with dual DHT suppression at NW3 receive crown advice acknowledging both layers and recommending crown-targeted minoxidil at the NW3v transition window'
);

assert(
  source.includes("_hasMinoxidil && _hasDHTShampoo\n                        ? 'Your crown is still intact at NW3 — your minoxidil and DHT-blocking shampoo provide topical growth signal and local DHT suppression across the scalp top. The deep temple recession is the active priority"),
  'WEEKLY_FOCUS_MAP.Crown NW3 branch should have a minoxidil+DHT-shampoo OTC branch so users with both topical layers at NW3 receive crown advice acknowledging their two-layer protocol rather than falling through to the minoxidil-only branch that ignores DHT shampoo'
);

assert(
  source.includes("_hasDHTShampoo\n                        ? 'Your crown is still intact at NW3 — your DHT-blocking shampoo is providing topical DHT suppression across the scalp top. The deep temple recession is the active priority"),
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
    /buildSuggestedQuestions[\s\S]{0,8000}specialistRecommended\s*\?/.test(source),
  "buildSuggestedQuestions should use the specialistRecommended parameter to surface specialist-visit questions for NW3/NW3v/NW4 users flagged for a trichologist — the parameter must not be accepted but silently ignored"
);

assert(
  source.includes('suggestedFollowUps') &&
    source.includes('buildSuggestedQuestions(ctx.scan.stage, coachProtocolCoverage, ctx.scan.specialistRecommended)') &&
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
  source.includes('Your minoxidil provides a topical growth signal for the remaining horseshoe fringe at NW7 — keep applying it consistently to the fringe and lateral edges') &&
    source.includes('Your minoxidil helps maintain remaining fringe density at NW7 — keep applying it consistently') &&
    source.includes('Your minoxidil provides a topical growth signal for the remaining horseshoe fringe at NW7 — keep applying it consistently. Crown coverage at this stage') &&
    source.includes('Your minoxidil helps support follicle health at the remaining horseshoe fringe at NW7') &&
    source.includes('Your minoxidil provides a topical growth signal for the remaining horseshoe fringe at NW7 — keep applying it consistently. Your highest-ROI step is a transplant or SMP consultation; minoxidil is often continued post-transplant'),
  'WEEKLY_FOCUS_MAP NW7 Hairline/Density/Crown/Health/Potential entries should be minoxidil-aware so OTC users at near-total loss who have minoxidil receive fringe-maintenance advice alongside surgical planning, rather than generic advice that ignores their active treatment'
);

assert(
  source.includes('Your finasteride + minoxidil at NW7 delivers systemic DHT suppression and a topical growth signal for the remaining horseshoe fringe') &&
    source.includes('At NW7, your finasteride + minoxidil provides systemic DHT suppression and a topical growth signal for the remaining fringe — keep both consistent without gaps. The primary path for meaningful density') &&
    source.includes('Your finasteride + minoxidil at NW7 delivers systemic DHT suppression and a topical growth signal for the remaining fringe — keep both consistent. Crown coverage') &&
    source.includes('At NW7, your finasteride + minoxidil is protecting remaining fringe follicles through systemic DHT suppression and topical stimulation') &&
    source.includes('At NW7, your finasteride + minoxidil provides systemic DHT suppression and a topical growth signal for the remaining horseshoe fringe — keep both consistent without gaps. Your highest-ROI step is a transplant or SMP consultation; both finasteride and minoxidil are often continued post-transplant'),
  'WEEKLY_FOCUS_MAP NW7 entries should be finasteride+minoxidil-aware so Rx users at near-total loss who have both treatments receive advice acknowledging the dual-layer protocol rather than falling through to the finasteride-only branch that ignores minoxidil'
);

assert(
  source.includes('Female-pattern frontal thinning with finasteride + minoxidil covers DHT suppression and the topical growth signal') &&
    source.includes('Finasteride is an active part of your female-pattern routine and provides DHT suppression for frontal thinning'),
  'WEEKLY_FOCUS_MAP.Hairline n/a (female) branch should be finasteride-aware so Rx female-pattern users get hairline advice that acknowledges their systemic DHT suppression'
);

assert(
  source.includes('Female-pattern frontal thinning with finasteride + minoxidil + DHT-blocking shampoo covers systemic DHT suppression, topical growth signal, and topical DHT control'),
  'WEEKLY_FOCUS_MAP.Hairline n/a (female) should have a fin+min+DHT-shampoo triple branch so users on all three treatments receive advice acknowledging the complete triple-layer protocol'
);

assert(
  source.includes("Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for female-pattern frontal thinning"),
  'WEEKLY_FOCUS_MAP.Hairline n/a (female) should have a supplements+minoxidil+DHT-shampoo triple branch so OTC-triple users with female-pattern thinning receive advice acknowledging all three layers'
);

assert(
  source.includes('Diffuse frontal thinning with finasteride + minoxidil + DHT shampoo covers systemic DHT suppression, topical growth signal, and topical DHT control') &&
    source.includes('Finasteride provides systemic DHT suppression for diffuse frontal thinning'),
  'WEEKLY_FOCUS_MAP.Hairline diffuse branch should be finasteride-aware so Rx users with diffuse-pattern loss receive frontal-thinning advice calibrated to their systemic DHT suppression'
);

assert(
  source.includes("Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for diffuse frontal thinning"),
  'WEEKLY_FOCUS_MAP.Hairline diffuse should have a supplements+minoxidil+DHT-shampoo triple branch so OTC-triple users with diffuse loss receive advice acknowledging all three layers'
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
  source.includes('Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for female-pattern scalp health') &&
    source.includes('Your supplement stack, minoxidil, and DHT-blocking shampoo form the strongest OTC three-layer approach for diffuse scalp health'),
  'WEEKLY_FOCUS_MAP.Health diffuse/n/a(female) should have a supplements+minoxidil+DHT-shampoo triple branch so OTC-triple users receive scalp-health advice acknowledging all three layers rather than falling through to the supplements+DHT-shampoo branch that ignores their minoxidil'
);

assert(
  source.includes('Your supplement stack and minoxidil cover nutritional follicle support and topical growth stimulation for female-pattern scalp health') &&
    source.includes('Your supplement stack and minoxidil cover nutritional follicle support and topical growth stimulation for diffuse scalp health'),
  'WEEKLY_FOCUS_MAP.Health diffuse/n/a(female) should have a supplements+minoxidil dual branch so users with both but no DHT shampoo receive advice acknowledging minoxidil and recommending DHT shampoo as the missing layer'
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
    source.includes('NW5 frontal recession with finasteride + minoxidil + LLLT covers systemic DHT suppression, topical growth signal, and photobiomodulation — apply minoxidil along the full frontal zone immediately after your LLLT session while scalp circulation is elevated.') &&
    source.includes('NW5 frontal recession with finasteride + minoxidil + microneedling covers systemic DHT suppression, topical growth signal, and scalp priming — wait 24-48 hours after each microneedling session before applying minoxidil along the full frontal zone') &&
    source.includes('NW5 frontal recession with minoxidil and scalp massage covers topical growth signal and mechanical stimulation — apply minoxidil along the full frontal zone immediately after your scalp massage so freshly stimulated follicles absorb it.'),
  'WEEKLY_FOCUS_MAP.Hairline NW5 branch should be minoxidil+massage-aware so OTC users (and Rx users) who have minoxidil and scalp massage but no DHT shampoo receive hairline advice that acknowledges both layers; Rx fin+min+massage branches should sub-check LLLT/microneedling so device users get correct timing advice'
);

assert(
  source.includes('NW5 frontal recession with finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical protocol — apply minoxidil along the full frontal zone immediately after your scalp massage so primed follicles absorb it, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time each day.') &&
    source.includes('NW5 frontal recession with finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical protocol — apply minoxidil along the full frontal zone immediately after your LLLT session while scalp circulation is elevated, leave DHT shampoo on 3-5 minutes per wash, and take finasteride at the same time each day.') &&
    source.includes('NW5 frontal recession with finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical protocol — wait 24-48 hours after each microneedling session before applying minoxidil along the full frontal zone (applying immediately after needling risks follicle irritation)'),
  'WEEKLY_FOCUS_MAP.Hairline NW5 4-combo branch should sub-check LLLT/microneedling so LLLT device users apply minoxidil after their LLLT session and microneedling users wait 24-48 hours — not be told to apply after a scalp massage they do not practice; mirrors the NW4 Hairline 4-combo pattern'
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
  source.includes('NW3v temple recession AND early crown thinning with minoxidil and DHT-blocking shampoo covers the topical growth signal and local DHT control across both active zones — apply 1ml to both temple recession zones AND directly to the vertex twice daily, and leave the DHT shampoo on 3-5 minutes per wash. Add a 3-minute scalp massage before each minoxidil application to prime absorption at both active fronts; massage is the highest-ROI addition at this dual-zone stage.') &&
    source.includes('NW3v temple recession AND early crown thinning — your DHT-blocking shampoo provides local DHT suppression across both active zones, which is a solid start. Add minoxidil to BOTH the temple recession zones AND directly to the vertex twice daily as the topical growth signal; dual-zone coverage at this two-front stage addresses recession and early crown thinning simultaneously.'),
  'WEEKLY_FOCUS_MAP.Hairline NW3v branch should be OTC-DHT-shampoo-aware: minoxidil+dhtShampoo branch acknowledges both layers and recommends massage as the missing third leg; standalone dhtShampoo branch recommends adding minoxidil to both temple and vertex — mirrors NW2/NW3 pattern for consistency'
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
  source.includes("r.includes('minox')") &&
    source.includes("r.includes('kirkland')") &&
    source.includes("r.includes('alpecin')") &&
    source.includes("r.includes('plantur')") &&
    source.includes("r.includes('foligain')") &&
    source.includes("r.includes('lipogaine')") &&
    source.includes("r.includes('lllt')") &&
    source.includes("r.includes('laser cap')") &&
    source.includes("r.includes('laser comb')") &&
    source.includes("r.includes('capillus')") &&
    source.includes("r.includes('hairmax')"),
  'routine detection should recognise additional brand names and abbreviations: minox (minoxidil abbreviation), Kirkland (Costco minoxidil brand), Alpecin/Plantur (caffeine DHT shampoos), Foligain/Lipogaine (DHT shampoo brands), LLLT/laser cap/laser comb/Capillus/HairMax (low-level laser therapy devices)'
);

assert(
  source.includes("s.includes('minox')") &&
    source.includes("s.includes('kirkland')") &&
    source.includes("s.includes('alpecin')") &&
    source.includes("s.includes('plantur')") &&
    source.includes("s.includes('foligain')") &&
    source.includes("s.includes('lipogaine')") &&
    source.includes("s.includes('lllt')") &&
    source.includes("s.includes('laser cap')") &&
    source.includes("s.includes('laser comb')") &&
    source.includes("s.includes('capillus')") &&
    source.includes("s.includes('hairmax')"),
  'coach pre-scan protocolCoverage fallback should recognise the same additional brand names as scan-time detection: minox, Kirkland, Alpecin, Plantur, Foligain, Lipogaine, LLLT, laser cap/comb, Capillus, HairMax — so pre-scan users who list these products in their routine have their protocol coverage computed correctly before their first scan'
);

assert(
  source.includes("r.includes('spironolactone')") &&
    source.includes("r.includes('spiro')") &&
    source.includes("r.includes('aldactone')"),
  'routine detection (_hasFinasteride) should recognise spironolactone and its variants (spiro, Aldactone) so female users on the most common Rx for FPHL are correctly classified as having Rx treatment'
);

assert(
  source.includes("s.includes('spironolactone')") &&
    source.includes("s.includes('spiro')") &&
    source.includes("s.includes('aldactone')"),
  'coach pre-scan protocolCoverage rx detection should recognise spironolactone/spiro/aldactone — mirrors the scan-time _hasFinasteride detection so female users listing spiro in their routine have their Rx layer correctly identified before their first scan'
);

assert(
  source.includes("r.includes('bicalutamide')") &&
    source.includes("r.includes('flutamide')") &&
    source.includes("r.includes('cyproterone')") &&
    source.includes("r.includes('androcur')"),
  'routine detection (_hasFinasteride) should recognise bicalutamide, flutamide, cyproterone, and androcur — non-steroidal and anti-androgen Rx treatments used for female-pattern hair loss (FPHL) so female users on these medications are correctly classified as having Rx treatment'
);

assert(
  source.includes("r.includes('clascoterone')") &&
    source.includes("r.includes('winlevi')"),
  'routine detection (_hasFinasteride) should recognise clascoterone and Winlevi (FDA-approved topical androgen receptor inhibitor used off-label for AGA) so users on this Rx topical antiandrogen are correctly classified as having Rx treatment'
);

assert(
  source.includes("s.includes('bicalutamide')") &&
    source.includes("s.includes('flutamide')") &&
    source.includes("s.includes('cyproterone')") &&
    source.includes("s.includes('androcur')"),
  'coach pre-scan protocolCoverage rx detection should recognise bicalutamide, flutamide, cyproterone, and androcur — mirrors the scan-time _hasFinasteride detection so female users listing these anti-androgens in their routine have their Rx layer correctly identified before their first scan'
);

assert(
  source.includes("s.includes('clascoterone')") &&
    source.includes("s.includes('winlevi')"),
  'coach pre-scan protocolCoverage rx detection should recognise clascoterone and Winlevi — mirrors the scan-time _hasFinasteride detection so users listing this topical antiandrogen have their Rx layer correctly identified before their first scan'
);

assert(
  source.includes("s.includes('loniten')") &&
    source.includes("s.includes('oral') && (s.includes('minoxidil') || s.includes('minox'))") &&
    source.includes("s.includes('minoxidil') && (s.includes('tablet') || s.includes('pill') || s.includes('low dose') || s.includes('low-dose') || s.includes('systemic'))"),
  'coach pre-scan protocolCoverage rx detection should recognise oral minoxidil (Loniten brand, "oral minoxidil", "low dose minoxidil", "minoxidil tablet") — oral minoxidil is an Rx-only prescription vasodilator, not OTC topical, so users on low-dose oral minoxidil should have rx=true in their protocol coverage rather than being misclassified as OTC-only'
);

assert(
  source.includes("r.includes('loniten')") &&
    source.includes("r.includes('oral') && (r.includes('minoxidil') || r.includes('minox'))") &&
    source.includes("r.includes('minoxidil') && (r.includes('tablet') || r.includes('pill') || r.includes('low dose') || r.includes('low-dose') || r.includes('systemic'))"),
  'scan-time _hasOralMinoxidil detection should recognise loniten (brand), "oral minoxidil", "oral minox", "low dose minoxidil", "minoxidil tablet/pill" — so the protocolCoverage.oralMinoxidil field is correctly set for users on Rx oral minoxidil and the protocolCoverage response gives iOS an explicit oralMinoxidil flag'
);

assert(
  source.includes("oralMinoxidil: _hasOralMinoxidil"),
  'protocolCoverage should expose a separate oralMinoxidil field derived from _hasOralMinoxidil so the iOS app can distinguish Rx oral minoxidil from OTC topical minoxidil without re-parsing the routine string'
);

assert(
  source.includes('if (topical || oralMinoxidil) score += 25'),
  'computeProtocolStrengthScore should credit oralMinoxidil (Rx oral minoxidil vasodilator) with the same 25-point growth-signal contribution as topical minoxidil — Loniten users choosing the oral route should not be penalised with a 0 for the topical layer; also guards that Loniten (oral-only brand) is NOT miscounted in the _hasMinoxidil topical detection'
);

assert(
  source.includes("['loniten', 'oral minoxidil (Loniten") &&
    source.includes("['oral minoxidil', 'oral minoxidil (Rx prescription"),
  '_RX_LABELS should include oral minoxidil entries (loniten, "oral minoxidil", "oral minox") so the coach protocolStatusLine names the specific drug when a user lists oral minoxidil in their routine, rather than falling through to a generic Rx antiandrogen label'
);

assert(
  source.includes("r.includes('minoxidil') && /\\d+\\.?\\d*\\s*mg/.test(r)") ||
    source.includes('r.includes(\'minoxidil\') && /\\d+\\.?\\d*\\s*mg/.test(r)'),
  'scan-time _hasOralMinoxidil and coach rx detection should recognise dosage-pattern oral minoxidil (e.g. "2.5mg minoxidil", "minoxidil 5 mg") — users commonly write their oral dose in mg and this pattern distinguishes oral tablets (mg) from topical solutions (%) so they are correctly classified as Rx'
);

assert(
  source.includes("r.includes('minoxidil') && /\\d+\\.?\\d*\\s*mg/.test(r)") &&
    source.includes("_rxFound.some((l) => l.startsWith('oral minoxidil'))"),
  '_RX_LABELS fallback should catch dosage-pattern oral minoxidil ("2.5mg minoxidil", "minoxidil 5 mg") that does not match any keyword in _RX_LABELS, so the coach protocolStatusLine correctly labels the drug as oral minoxidil rather than a generic Rx antiandrogen'
);

assert(
  source.includes("r.includes('revita')"),
  'routine detection (_hasDHTShampoo) should recognise Revita (DS Laboratories ketoconazole + caffeine shampoo) so users of this popular brand are correctly classified as having a DHT-blocking shampoo in their routine'
);

assert(
  source.includes("s.includes('revita')"),
  'coach pre-scan protocolCoverage dhtShampoo detection should recognise Revita — mirrors the scan-time _hasDHTShampoo detection so pre-scan users listing Revita have their DHT-shampoo layer correctly identified'
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
  source.includes("At NW4, your supplement stack and LLLT device cover nutritional support and photobiomodulation across both the frontal and crown zones — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Schedule weekly microneedling (0.5mm) after your LLLT sessions to prime follicle absorption where miniaturization is most advanced; three complementary layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx scalp-health protocol at this established stage.") &&
    source.includes("At NW4, your supplement stack and microneedling cover nutritional support and scalp priming across both the frontal and crown zones — use microneedling 24-48 hours before topical application to maximize absorption where miniaturization is most advanced. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx scalp-health protocol where miniaturization spans both the frontal and crown zones at this established stage.") &&
    source.includes("At NW4, your supplement stack and scalp massage cover nutritional support and mechanical stimulation — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT suppression layer. It is the most impactful addition to your existing stack where miniaturization spans both the frontal and crown zones.") &&
    source.includes("_hasSupplements\n                                              ? 'Your supplement stack is supporting follicle health at NW4"),
  'NW4 Health WEEKLY_FOCUS_MAP should have (supplements+massage) branch with LLLT/microneedling sub-check and standalone (supplements) branch so users who already have supplements and massage are not given generic advice — consistent with NW2/NW3/NW3v/NW5/NW6 Health pattern'
);

assert(
  source.includes("_hasDHTShampoo && _hasMassage\n                                        ? (_hasLLLT") &&
    source.includes("At NW3, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation at the recession edge") &&
    source.includes("_hasDHTShampoo\n                                          ? 'Your DHT-blocking shampoo is suppressing topical DHT at the recession edge at NW3"),
  'NW3 Health WEEKLY_FOCUS_MAP should have separate branches for (dhtShampoo+massage) and (dhtShampoo alone) so users who already have a DHT-blocking shampoo are never told to add one; the dhtShampoo+massage branch should sub-check _hasLLLT for LLLT device users'
);

assert(
  source.includes("_hasDHTShampoo && _hasMassage\n                                          ? (_hasLLLT") &&
    source.includes("At NW4, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation across the full scalp top"),
  'NW4 Health WEEKLY_FOCUS_MAP should have a (dhtShampoo+massage) branch (with LLLT sub-check) so users who already have both active at this established stage are not told to add scalp massage they already have — direct them to add supplements as the missing nutritional layer instead'
);

assert(
  source.includes("_hasDHTShampoo\n                                ? 'Your DHT-blocking shampoo is providing topical DHT protection at NW2 where miniaturization is just beginning"),
  'NW2 Health WEEKLY_FOCUS_MAP should have a (dhtShampoo alone) branch so OTC users at the earliest-recession stage who already have a DHT shampoo are not told to add one — recommend supplements as the missing layer instead'
);

assert(
  source.includes("_hasDHTShampoo && _hasMassage\n                                    ? (_hasLLLT") &&
    source.includes("At NW3v, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation across both the recession edge and early crown"),
  'NW3v Health WEEKLY_FOCUS_MAP should have a dedicated (dhtShampoo+massage) branch (with LLLT sub-check) so users with both treatments active at this dual-zone stage receive nutritional-gap advice rather than the generic no-treatment fallback'
);

assert(
  source.includes("_hasSupplements && _hasMassage\n                                    ? (_hasLLLT") &&
    source.includes("At NW3v, your supplement stack and LLLT device cover nutritional support and photobiomodulation across both the recession edge and early crown") &&
    source.includes("At NW3v, your supplement stack and microneedling cover nutritional support and scalp priming across both the recession edge and early crown") &&
    source.includes("At NW3v, your supplement stack and scalp massage cover nutritional support and mechanical stimulation across both the recession edge and early crown") &&
    source.includes("_hasSupplements\n                                  ? 'Your supplement stack is active at NW3v where both temples and early crown are simultaneously thinning"),
  'NW3v Health WEEKLY_FOCUS_MAP should have (supplements+massage) branch with LLLT/microneedling sub-check and standalone (supplements) branch so users with a supplement stack are never told to start one — consistent with the NW4 Health pattern'
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
  source.includes("_hasSupplements && _hasDHTShampoo\n                                      ? 'Your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression at the NW4 crown vertex") &&
    source.includes("_hasSupplements && _hasDHTShampoo\n                                          ? 'At NW5, your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression at the crown vertex") &&
    source.includes("_hasSupplements && _hasDHTShampoo\n                                ? 'At NW6, your supplement stack and DHT-blocking shampoo cover nutritional support and topical DHT suppression for the crown"),
  'WEEKLY_FOCUS_MAP.Crown NW4/NW5/NW6 supplement+DHT compound branch ordering fix: _hasSupplements && _hasDHTShampoo must appear BEFORE standalone _hasDHTShampoo so users with both an active supplement stack and DHT-blocking shampoo receive compound-aware advice rather than falling through to the DHT-shampoo-only branch that ignores their supplement routine'
);

assert(
  source.includes("_hasSupplements && _hasDHTShampoo\n                    ? 'Your crown is intact at NW2 — your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression across the scalp top. The temple recession is the active priority") &&
    source.includes("_hasSupplements && _hasDHTShampoo\n                        ? 'Your crown is intact at NW3 — your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression across the full scalp top. The deep temple recession is the active priority"),
  'WEEKLY_FOCUS_MAP.Crown NW2/NW3 supplement+DHT compound branch ordering fix: _hasSupplements && _hasDHTShampoo must appear BEFORE standalone _hasDHTShampoo so users with both an active supplement stack and DHT-blocking shampoo receive compound-aware advice rather than falling through to the DHT-shampoo-only branch that ignores their supplement routine'
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

assert(
  source.includes("dhtShampoo ? 'Should I add minoxidil to my DHT shampoo routine at NW2?' : 'Should I add minoxidil to both temple corners at NW2?'") &&
    source.includes("dhtShampoo ? 'Should I add minoxidil to my DHT shampoo routine at NW3?' : 'Should I add minoxidil to both temple recession zones at NW3?'") &&
    source.includes("dhtShampoo ? 'Should I add minoxidil to my DHT shampoo routine at NW3v?' : 'Should I add minoxidil to both my temples and crown at NW3v?'") &&
    source.includes("dhtShampoo ? 'Should I add minoxidil to my DHT shampoo routine at NW4?' : 'Should I add minoxidil to both my frontal zone and crown at NW4?'") &&
    source.includes("dhtShampoo ? 'Should I add minoxidil to my DHT shampoo routine at NW5?' : 'Should I add minoxidil across both my frontal and crown zones at NW5?'"),
  'buildSuggestedQuestions OTC (!rx) branches for NW2/NW3/NW3v/NW4/NW5 should be DHT-shampoo-aware: when topical is missing but dhtShampoo is active, acknowledge the shampoo routine rather than asking a generic add-minoxidil question'
);

assert(
  source.includes("dhtShampoo ? 'Should I add minoxidil to my DHT-blocking shampoo routine at NW6?' : 'Which OTC treatments most effectively slow fringe recession at NW6?'") &&
    source.includes("dhtShampoo ? 'Should I add minoxidil to my DHT-blocking shampoo routine at NW7?' : 'Which OTC steps are still worth keeping alongside a transplant plan at NW7?'"),
  'buildSuggestedQuestions OTC (!rx) branches for NW6/NW7 should be DHT-shampoo-aware: when topical is missing but dhtShampoo is active, acknowledge the shampoo routine rather than surfacing a generic OTC-discovery question — consistent with the NW3/NW4/NW5 pattern'
);

assert(
  source.includes("dhtShampoo ? 'Should I add minoxidil to my finasteride + DHT-blocking shampoo at NW6?' : 'Should I add minoxidil to my finasteride at NW6?'") &&
    source.includes("dhtShampoo ? 'How does my finasteride + DHT-blocking shampoo fit into a transplant or SMP plan at NW6?' : 'How does finasteride alone fit into a transplant or SMP plan at NW6?'") &&
    source.includes("dhtShampoo ? 'Should I add minoxidil to my finasteride + DHT-blocking shampoo at NW7?' : 'Should I add minoxidil to my finasteride at NW7?'"),
  'buildSuggestedQuestions Rx branches for NW6/NW7 should be DHT-shampoo-aware: when topical is missing but dhtShampoo is active, acknowledge the combined finasteride + DHT shampoo stack rather than describing the protocol as finasteride-alone'
);

assert(
  source.includes("_hasFinasteride && _hasDHTShampoo\n                ? 'Your finasteride + DHT-blocking shampoo at NW7 delivers both systemic and topical DHT suppression for the remaining horseshoe fringe") &&
    source.includes("_hasDHTShampoo\n                ? 'Your DHT-blocking shampoo provides topical DHT suppression for the remaining fringe at NW7"),
  'WEEKLY_FOCUS_MAP NW7 Hairline should be DHT-shampoo-aware: add _hasFinasteride && _hasDHTShampoo branch and standalone _hasDHTShampoo branch for users with shampoo but no Rx'
);

assert(
  source.includes("_hasFinasteride && _hasDHTShampoo\n                ? 'At NW7, your finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression for the remaining fringe") &&
    source.includes("_hasDHTShampoo\n                ? 'Your DHT-blocking shampoo helps slow miniaturization of the remaining fringe at NW7"),
  'WEEKLY_FOCUS_MAP NW7 Density should be DHT-shampoo-aware: add _hasFinasteride && _hasDHTShampoo branch and standalone _hasDHTShampoo branch'
);

assert(
  source.includes("_hasFinasteride && _hasDHTShampoo\n                ? 'Your finasteride + DHT-blocking shampoo at NW7 delivers dual-level DHT suppression for the remaining fringe") &&
    source.includes("_hasDHTShampoo\n                ? 'Your DHT-blocking shampoo provides topical DHT suppression for the remaining fringe at NW7 — keep using it 3× weekly with 3-5 minutes of contact time. Crown coverage"),
  'WEEKLY_FOCUS_MAP NW7 Crown should be DHT-shampoo-aware: add _hasFinasteride && _hasDHTShampoo branch and standalone _hasDHTShampoo branch'
);

assert(
  source.includes("_hasFinasteride && _hasDHTShampoo\n                ? 'At NW7, your finasteride + DHT-blocking shampoo provides systemic and topical DHT suppression for remaining fringe follicle health") &&
    source.includes("_hasDHTShampoo\n                ? 'Your DHT-blocking shampoo supports fringe follicle health at NW7"),
  'WEEKLY_FOCUS_MAP NW7 Health should be DHT-shampoo-aware: add _hasFinasteride && _hasDHTShampoo branch and standalone _hasDHTShampoo branch'
);

assert(
  source.includes("_hasFinasteride && _hasDHTShampoo\n                ? 'At NW7, your finasteride + DHT-blocking shampoo adds meaningful non-surgical value") &&
    source.includes("_hasDHTShampoo\n                ? 'Your DHT-blocking shampoo helps slow further miniaturization of remaining fringe at NW7"),
  'WEEKLY_FOCUS_MAP NW7 Potential should be DHT-shampoo-aware: add _hasFinasteride && _hasDHTShampoo branch and standalone _hasDHTShampoo branch'
);

assert(
  source.includes("_hasDHTShampoo && _hasMassage\n                                ? (_hasLLLT") &&
    source.includes("At NW5, your DHT-blocking shampoo and scalp massage provide topical DHT suppression and mechanical stimulation across the full top") &&
    source.includes("_hasDHTShampoo\n                                  ? 'Your DHT-blocking shampoo provides topical DHT suppression at NW5 where miniaturization spans the full scalp top"),
  'WEEKLY_FOCUS_MAP NW5 Health should be DHT-shampoo-aware: _hasDHTShampoo+_hasMassage branch (with LLLT sub-check) and standalone _hasDHTShampoo branch before generic fallback'
);

assert(
  source.includes("_hasDHTShampoo\n                          ? 'Your DHT-blocking shampoo provides topical DHT suppression for remaining fringe follicles at NW6 — keep using it 3× weekly with 3-5 minutes of contact time. Add biotin"),
  'WEEKLY_FOCUS_MAP NW6 Health should be DHT-shampoo-aware: add standalone _hasDHTShampoo branch before generic fallback'
);

assert(
  source.includes("_hasDHTShampoo\n                              ? 'Your DHT-blocking shampoo provides topical-level DHT protection at NW1 before any visible thinning begins — keep using it 3× weekly with 3-5 minutes of contact time. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer; together they form the strongest dual-layer OTC preventive foundation at this optimal prevention window.'"),
  'WEEKLY_FOCUS_MAP NW1 Health should be DHT-shampoo-aware: add a standalone _hasDHTShampoo branch so OTC users at NW1 who only have a DHT-blocking shampoo are not told to add one — they should be directed to add supplements as the missing nutritional layer'
);

assert(
  source.includes('NW3 deep temple recession with minoxidil and DHT-blocking shampoo covers the topical growth signal and local DHT control at the recession edge — apply 1ml minoxidil to each zone twice daily and leave DHT shampoo on 3-5 minutes per wash.') &&
    source.includes('NW3 deep temple recession — your DHT-blocking shampoo provides local DHT suppression at the recession edge, which is a solid start. Add minoxidil on both temple zones twice daily for the topical growth signal'),
  'WEEKLY_FOCUS_MAP.Hairline NW3 branch should be OTC-DHT-shampoo-aware: minoxidil+dhtShampoo branch acknowledges both layers and recommends massage; standalone dhtShampoo branch recommends adding minoxidil as the missing topical growth signal — so OTC users with DHT shampoo are never sent to generic advice that ignores their routine'
);

assert(
  source.includes('NW2 temple recession with minoxidil and DHT-blocking shampoo covers the topical growth signal and local DHT suppression at the ideal preventive stage — leave DHT shampoo on 3-5 minutes before rinsing and confirm twice-daily minoxidil coverage on both temple corners.') &&
    source.includes('NW2 temple recession is the earliest warning sign — your DHT-blocking shampoo provides topical DHT protection at the temple edges, which is a good start. Add minoxidil directly to both temple corners twice daily as the topical growth signal'),
  'WEEKLY_FOCUS_MAP.Hairline NW2 branch should be OTC-DHT-shampoo-aware: minoxidil+dhtShampoo branch acknowledges both layers and recommends finasteride consult; standalone dhtShampoo branch recommends adding minoxidil as the missing topical growth signal — so OTC users with DHT shampoo at the earliest preventive stage are never sent to generic advice that ignores their routine'
);

assert(
  source.includes("r.includes('capillus') || r.includes('hairmax') || r.includes('irestore') || r.includes('igrow')"),
  'server should detect iRestore and iGrow as LLLT devices alongside Capillus and HairMax in both _hasLLLT and _hasMassage detection'
);

assert(
  source.includes("r.includes('kiierr') || r.includes('illumiflow')"),
  'server should detect Kiierr and Illumiflow as LLLT devices in both _hasLLLT and _hasMassage scan-time detection'
);

assert(
  source.includes("s.includes('kiierr') || s.includes('illumiflow')"),
  'coach pre-scan protocolCoverage fallback should detect Kiierr and Illumiflow as LLLT devices in both mechanical and lllt fields, consistent with scan-time detection'
);

assert(
  source.includes("r.includes('finax')") &&
    source.includes("s.includes('finax')"),
  'server should detect Finax (Dr. Reddy\'s finasteride 1mg brand) in both scan-time _hasFinasteride and coach pre-scan rx detection'
);

assert(
  source.includes("r.includes('pura d') || r.includes('shapiro md') || r.includes('rosemary oil')"),
  'server should detect Pura D\'or, Shapiro MD, and rosemary oil as DHT-blocking shampoo brands in _hasDHTShampoo detection'
);

assert(
  source.includes("r.includes('dermapen')"),
  'server should detect Dermapen as a microneedling device in _hasMassage detection'
);

assert(
  source.includes("lllt:        _hasLLLT,") &&
    source.includes("LLLT devices: laser cap, laser comb, Capillus, HairMax"),
  'protocolCoverage should expose a separate lllt field derived from _hasLLLT so the iOS app and coach can distinguish LLLT therapy from scalp massage without re-parsing the routine string'
);

assert(
  source.includes("_LLLT_LABELS") &&
    source.includes("'LLLT (laser cap/comb — Capillus, HairMax, etc.)'") &&
    source.includes("_NEEDLE_LABELS") &&
    source.includes("'microneedling (apply minoxidil 24-48h after each session, not same-day)'") &&
    source.includes("pc.mechanical && !pc.microneedling && !pc.lllt") &&
    source.includes("missing.push('scalp massage/microneedling')"),
  'coach protocolStatusLine should surface specific LLLT device and microneedling tool via lookup tables, fall back to generic labels, and fall back to scalp massage only when no microneedling or LLLT — prevents the coach from giving generic massage advice to LLLT or microneedling users'
);

assert(
  source.includes("_SHAMPOO_LABELS") &&
    source.includes("['nizoral',        'Nizoral (ketoconazole 1% or 2% — leave on 3–5 min per wash)']") &&
    source.includes("['alpecin',        'Alpecin caffeine shampoo (leave on ~2 min per wash)']") &&
    source.includes("['regenepure',     'Regenepure NT (ketoconazole + saw palmetto blend — leave on 3–5 min)']") &&
    source.includes("`DHT-blocking shampoo (${_shampooFound.join(' + ')})`"),
  'coach protocolStatusLine should surface the specific DHT-shampoo brand(s) from the live routine via a _SHAMPOO_LABELS lookup — ketoconazole (Nizoral/Nizral/Ketomac/Ketomine) needs 3–5 min contact, caffeine (Alpecin/Plantur) works in ~2 min, and peptide/procyanidin blends differ again; naming the brand lets the coach give accurate contact-time and stacking advice instead of generic "DHT-blocking shampoo"'
);

assert(
  source.includes("_TOPICAL_LABELS") &&
    source.includes("['rogaine foam',     'Rogaine 5% Minoxidil Foam (apply 1× daily to dry scalp — once-daily foam schedule)']") &&
    source.includes("['kirkland',         'Kirkland Minoxidil 5% (apply to dry scalp twice daily)']") &&
    source.includes("['spectral.rs',      'Spectral.RS (nanoxidil — apply twice daily; different molecule from minoxidil)']") &&
    source.includes("_topicalFound ? `minoxidil (${_topicalFound})` : 'minoxidil'"),
  'coach protocolStatusLine should surface the specific topical minoxidil product via a _TOPICAL_LABELS lookup — Rogaine/Regaine/Mintop/Tugain foam schedules once daily to dry hair while liquids/serums are twice daily, and nanoxidil (Spectral.RS/DNC-N) is a different molecule; naming the brand lets the coach give accurate application frequency instead of generic twice-daily advice'
);

assert(
  source.includes("dhtShampoo ? 'Should I add minoxidil to my finasteride + DHT-blocking shampoo at NW5?' : 'Should I add minoxidil to my finasteride at NW5?'"),
  'buildSuggestedQuestions NW5 Rx branch first question should be DHT-shampoo-aware: when the user has finasteride + DHT shampoo but no topical, acknowledge both layers rather than describing the protocol as finasteride-alone — consistent with the NW6/NW7 Rx pattern'
);

assert(
  source.includes("_hasFinasteride && _hasDHTShampoo\n                          ? 'At NW4, finasteride + DHT-blocking shampoo delivers dual-level DHT suppression"),
  'NW4 Density WEEKLY_FOCUS_MAP should have a dedicated _hasFinasteride+_hasDHTShampoo branch (without minoxidil) so users with this combination get told to add minoxidil rather than hitting the generic _hasFinasteride branch that incorrectly tells them to also add DHT shampoo they already have'
);

assert(
  source.includes("_hasFinasteride && _hasDHTShampoo\n                            ? 'At NW4, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression across the frontal hairline"),
  'NW4 Hairline WEEKLY_FOCUS_MAP should have a dedicated _hasFinasteride+_hasDHTShampoo branch so users with this combo get told to add minoxidil rather than falling through to _hasFinasteride which ignores their existing DHT shampoo'
);

assert(
  source.includes("_hasFinasteride && _hasDHTShampoo\n                            ? 'At NW4, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression at the vertex"),
  'NW4 Crown WEEKLY_FOCUS_MAP should have a dedicated _hasFinasteride+_hasDHTShampoo branch so users with this combo get told to add minoxidil rather than falling through to _hasFinasteride which ignores their existing DHT shampoo'
);

assert(
  source.includes("_hasFinasteride && _hasDHTShampoo\n                                    ? 'At NW4, finasteride + DHT-blocking shampoo delivers dual-level DHT suppression — systemic and topical control at this established stage"),
  'NW4 Potential WEEKLY_FOCUS_MAP should have a dedicated _hasFinasteride+_hasDHTShampoo branch so users with this combo get told to add minoxidil rather than falling through to _hasFinasteride which ignores their existing DHT shampoo'
);

assert(
  source.includes("_hasDHTShampoo\n                                            ? 'NW3 is a pivotal response window and your DHT-blocking shampoo is providing local DHT suppression at the recession edge"),
  'NW3 Potential WEEKLY_FOCUS_MAP should have a standalone _hasDHTShampoo branch so users with only a DHT shampoo (no minoxidil, no finasteride) get told to add minoxidil rather than falling through to the no-treatment fallback that ignores their existing shampoo'
);

assert(
  source.includes("_hasDHTShampoo\n                                              ? 'NW3v is a dual-zone stage — both temples and early crown are active — and your DHT-blocking shampoo is providing local DHT suppression across both thinning zones"),
  'NW3v Potential WEEKLY_FOCUS_MAP should have a standalone _hasDHTShampoo branch so users with only a DHT shampoo at the dual-zone NW3v stage get dual-zone-aware advice to add minoxidil to both zones rather than falling through to the no-treatment fallback'
);

assert(
  source.includes("data.stage === 'NW3v'\n                                                    ? 'At NW3v, your DHT-blocking shampoo and scalp massage cover topical DHT suppression and mechanical stimulation across both the mid-scalp and early crown"),
  'NW3v Density WEEKLY_FOCUS_MAP _hasDHTShampoo && _hasMassage branch should differentiate NW3v users with dual-zone advice (mid-scalp AND early crown) rather than giving mid-scalp-only advice that ignores the NW3v vertex thinning front'
);

assert(
  source.includes("data.stage === 'NW3v'\n                                                        ? 'Your DHT-blocking shampoo is active at NW3v where both mid-scalp and early crown are thinning simultaneously"),
  'NW3v Density WEEKLY_FOCUS_MAP standalone _hasDHTShampoo branch should differentiate NW3v users with dual-zone advice (both mid-scalp and early crown zones) rather than mid-scalp-only microneedling advice that ignores the vertex thinning front'
);

assert(
  source.includes("data.stage === 'NW3v'\n                                                            ? 'NW3v density is declining across mid-scalp and early crown simultaneously"),
  'NW3v Density WEEKLY_FOCUS_MAP no-treatment fallback should differentiate NW3v users with dual-zone advice (mid-scalp and early crown simultaneously) rather than mid-scalp-only DHT shampoo + massage advice that ignores the vertex thinning front'
);

assert(
  source.includes('suggestedAdviceVisuals') &&
    source.includes("missing.push('topical')") &&
    source.includes("missing.push('shampoo')") &&
    source.includes("missing.push('supplements')") &&
    source.includes("missing.push('massage')") &&
    source.includes("missing.push('microneedling')") &&
    source.includes("missing.slice(0, 2), 'consultation'") &&
    source.includes('if (data.specialistRecommended)') &&
    source.includes('missing.slice(0, 3)'),
  'scan response should include suggestedAdviceVisuals: up to 3 protocol-gap visual kinds; when specialistRecommended is true, consultation is guaranteed in the top 3 (up to 2 missing-layer visuals + consultation) so advanced-stage users always see the specialist CTA even when many protocol layers are absent'
);

assert(
  source.includes("lllt = false, microneedling = false, supplements = false, transplant = false } = protocolCoverage || {};") &&
    source.includes("lllt ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + LLLT stack at NW5?'") &&
    source.includes("lllt ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + LLLT stack at NW4?'") &&
    source.includes("lllt ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + LLLT stack at NW3v?'") &&
    source.includes("lllt ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + LLLT stack at NW2?'") &&
    source.includes("lllt ? 'Should I add a DHT-blocking shampoo to my finasteride + minoxidil + LLLT protocol at NW3?'") &&
    source.includes("lllt ? 'How do I get the most from my LLLT device for my NW3 temple recession?'") &&
    source.includes("lllt ? 'How should I time my LLLT sessions with minoxidil for maximum absorption?'"),
  'buildSuggestedQuestions should be LLLT-aware: destructure lllt from protocolCoverage and use it so LLLT users (who have mechanical=true via laser cap/comb) see LLLT-specific questions rather than questions framed around scalp massage they do not practice'
);

assert(
  source.includes("immediately after your LLLT session while scalp circulation is elevated") &&
    source.includes("NW2 temple recession with minoxidil and LLLT covers topical growth signal and photobiomodulation"),
  'WEEKLY_FOCUS_MAP Hairline NW3 and NW2 _hasMinoxidil+_hasMassage branches should sub-check _hasLLLT and give LLLT-specific timing advice (apply after LLLT session) rather than always telling LLLT device users to do a scalp massage they do not practice'
);

assert(
  source.includes("your minoxidil and LLLT device cover topical growth signal and photobiomodulation across the remaining fringe and temple edges — apply minoxidil immediately after your LLLT session while scalp circulation is elevated so freshly stimulated follicles absorb it. Add a DHT-blocking shampoo 3× weekly as the topical DHT-suppression layer; book a transplant consultation to evaluate surgical coverage options alongside your OTC maintenance.") &&
    source.includes("minoxidil and LLLT cover topical growth signal and photobiomodulation across the remaining fringe — apply minoxidil immediately after your LLLT session while scalp circulation is elevated. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical DHT suppression to complete the non-surgical density stack. The realistic goal is stabilizing existing fringe coverage") &&
    source.includes("Apply minoxidil directly to the crown (1ml) twice daily at NW6, immediately after your LLLT session while scalp circulation is elevated to prime follicle absorption — add weekly microneedling over the crown zone and photograph from above every 6 weeks to track change. Consider booking a transplant consultation to evaluate vertex coverage options.") &&
    source.includes("your minoxidil and LLLT device cover topical growth signal and photobiomodulation across the remaining fringe — apply minoxidil immediately after your LLLT session while scalp circulation is elevated. Add a DHT-blocking shampoo 3× weekly to complete the OTC stack for the strongest realistic non-surgical potential (15-32%). Set a 3-month checkpoint"),
  'WEEKLY_FOCUS_MAP NW6 Hairline, Density, Crown, and Potential _hasMinoxidil+_hasMassage branches should sub-check _hasLLLT and give LLLT-specific timing advice rather than telling LLLT device users to time application after a scalp massage they do not practice'
);

assert(
  source.includes("your DHT-blocking shampoo and LLLT device cover topical DHT suppression and photobiomodulation at the recession edge — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer. Three complementary layers (DHT suppression + photobiomodulation + nutritional) give the strongest non-Rx scalp-health response where miniaturization is actively progressing at this established stage.") &&
    source.includes("your supplements + DHT shampoo + LLLT device covers nutrition, topical DHT suppression, and photobiomodulation across both active zones — add weekly microneedling (0.5mm) at both the recession edge AND the early crown zone after your LLLT sessions to amplify follicle response at both active fronts.") &&
    source.includes("your DHT-blocking shampoo and LLLT device cover topical DHT suppression and photobiomodulation across both the recession edge and early crown — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer, and weekly microneedling (0.5mm) at both active zones after your LLLT sessions.") &&
    source.includes("your DHT-blocking shampoo and LLLT device cover topical DHT suppression and photobiomodulation across the full scalp top — add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer. Biotin, zinc, and vitamin D support follicle structure from within; weekly microneedling (0.5mm) over the thinnest zones timed after your LLLT sessions is the highest-ROI absorption upgrade") &&
    source.includes("your DHT-blocking shampoo and LLLT device provide topical DHT suppression and photobiomodulation across the full top — add a supplement stack (biotin, zinc, vitamin D) this week as the nutritional layer. Leave DHT shampoo on 3-5 minutes per wash and schedule weekly microneedling after your LLLT sessions to prime follicle response where miniaturization is most advanced at this stage."),
  'WEEKLY_FOCUS_MAP Health metric _hasDHTShampoo+_hasMassage branches for NW3, NW3v (with and without supplements), NW4, and NW5 should sub-check _hasLLLT and give LLLT-specific advice (photobiomodulation, microneedling after LLLT session) rather than always describing a scalp massage LLLT device users do not practice'
);

assert(
  source.includes('At NW5, minoxidil and microneedling cover topical growth signal and scalp priming across both frontal and crown density loss zones — wait 24-48 hours after each microneedling session before applying minoxidil to avoid follicle irritation; on non-needling days apply across both thinning fronts twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression to complete the density stack at this stage.') &&
    source.includes('At NW6, minoxidil and microneedling cover topical growth signal and scalp priming across the remaining fringe — wait 24-48 hours after each microneedling session before applying minoxidil along the fringe and lateral edges (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for topical DHT suppression to complete the non-surgical density stack. The realistic goal is stabilizing existing fringe coverage; consistent application and monthly overhead photos track whether the combination is holding.') &&
    source.includes('At NW2, minoxidil and microneedling cover topical growth signal and scalp priming at the ideal preventive stage — wait 24-48 hours after each microneedling session before applying minoxidil to both temple corners (applying immediately risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; the triple OTC approach gives the strongest long-term density protection before any mid-scalp miniaturization begins.') &&
    source.includes('NW3v mid-scalp and early crown with minoxidil and microneedling covers topical growth signal and scalp priming across both active zones — wait 24-48 hours after each microneedling session before applying minoxidil to both mid-scalp and vertex (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression; DHT shampoo completes the OTC density stack at this two-front stage.') &&
    source.includes('Mid-scalp density at NW3 with minoxidil and microneedling covers topical growth signal and scalp priming at the recession edge — wait 24-48 hours after each microneedling session before applying minoxidil to the mid-scalp zone (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression; DHT shampoo completes the OTC density stack and slows miniaturization while follicles are still highly responsive.') &&
    source.includes('At NW4, your minoxidil and microneedling cover topical growth signal and scalp priming across the mid-scalp — wait 24-48 hours after each microneedling session before applying minoxidil to avoid follicle irritation; on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression where miniaturization is advancing across the full scalp top; the three-layer OTC stack gives the strongest non-surgical density response at this established stage.'),
  'WEEKLY_FOCUS_MAP.Density _hasMinoxidil+_hasMassage branches for NW2/NW3/NW3v/NW4/NW5/NW6 should sub-check _hasMicroneedling (after _hasLLLT) and give microneedling-specific timing advice (wait 24-48 hours before applying minoxidil) rather than telling microneedling users to time application after a scalp massage they do not practice'
);

assert(
  source.includes('At NW5, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming across the full top — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash for maximum topical DHT suppression. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer to complete the three-layer non-Rx scalp-health protocol where miniaturization is most advanced at this stage.') &&
  source.includes('At NW6, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming for remaining fringe follicles — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add biotin, zinc, and vitamin D supplements as the nutritional layer and consider a dermatologist check to rule out any inflammatory component alongside your existing protocol. The realistic goal at NW6 is stabilizing remaining fringe coverage with a complete multi-layer scalp-health routine.') &&
  source.includes('At NW2, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming at the early recession edge — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash for maximum topical DHT suppression at the temple corners. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer; three complementary layers (DHT suppression + mechanical priming + nutritional) give the strongest non-Rx preventive foundation at this optimal intervention window.') &&
  source.includes('At NW3, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming at the active recession edge — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer; three complementary layers (DHT suppression + mechanical priming + nutritional) give the strongest non-Rx scalp-health response where miniaturization is actively progressing at this established stage.') &&
  source.includes('At NW3v, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming across both the recession edge and early crown — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash at both active zones. Add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer, and consider a doctor consult about finasteride as the highest-ROI systemic step at this dual-zone stage.') &&
  source.includes('At NW4, your DHT-blocking shampoo and microneedling cover topical DHT suppression and scalp priming across the full scalp top — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash. Add a supplement stack (biotin, zinc, vitamin D) as the missing nutritional layer; biotin, zinc, and vitamin D support follicle structure from within and complete the three-layer scalp-health protocol at this established stage.'),
  'WEEKLY_FOCUS_MAP Health metric _hasDHTShampoo+_hasMassage branches for NW2/NW3/NW3v/NW4/NW5/NW6 should sub-check _hasMicroneedling (after _hasLLLT) and give microneedling-specific sequencing advice (DHT shampoo on non-needling days or wait 48 hours) rather than treating microneedling users the same as scalp-massage users'
);

assert(
  source.includes("NW2 is the ideal prevention window and your minoxidil and microneedling cover the topical growth signal and scalp priming at the temple corners — wait 24-48 hours after each microneedling session before applying minoxidil to both temple corners (applying immediately risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly as the DHT-suppression third layer; the triple approach (topical + microneedling + DHT) delivers the strongest long-term potential at this earliest detectable stage.") &&
  source.includes("At NW3 you have minoxidil and microneedling in place — wait 24-48 hours after each microneedling session before applying minoxidil to the recession zones (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly as the third leg; the triple stack (topical + microneedling + DHT suppression) gives the strongest 6-month potential at this established stage.") &&
  source.includes("NW3v is a dual-zone active stage and your minoxidil + microneedling cover the topical growth signal and scalp priming across both zones — wait 24-48 hours after each microneedling session before applying minoxidil to both temple recession zones AND the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; the triple stack across both active fronts gives the strongest OTC potential at NW3v.") &&
  source.includes("At NW4, your minoxidil and microneedling cover the topical growth signal and scalp priming across the full frontal and crown zones — wait 24-48 hours after each microneedling session before applying minoxidil to avoid follicle irritation; on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the DHT-suppression third layer; set a 4-month checkpoint with front-facing and overhead photos today as your baseline.") &&
  source.includes("NW5 potential with minoxidil and microneedling covers the topical growth signal and scalp priming across both frontal and crown zones — wait 24-48 hours after each microneedling session before applying minoxidil to avoid follicle irritation; on non-needling days apply across both thinning fronts twice daily as normal. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) for local DHT suppression; the three-layer OTC stack gives the strongest realistic non-surgical potential at NW5 (28-48%). Set a 3-month checkpoint and consider booking a transplant consultation to plan surgical and OTC paths in parallel.") &&
  source.includes("At NW6, your minoxidil and microneedling cover topical growth signal and scalp priming across the remaining fringe — wait 24-48 hours after each microneedling session before applying minoxidil along the fringe and lateral edges (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Add a DHT-blocking shampoo 3× weekly to complete the OTC stack for the strongest realistic non-surgical potential (15-32%). Set a 3-month checkpoint and consider booking a transplant consultation this quarter — combining OTC maintenance with surgical planning is the most complete long-term strategy."),
  'WEEKLY_FOCUS_MAP.Potential _hasMinoxidil+_hasMassage branches for NW2/NW3/NW3v/NW4/NW5/NW6 should sub-check _hasMicroneedling (after _hasLLLT) and give microneedling-specific timing advice (wait 24-48 hours before applying minoxidil) rather than telling microneedling users to time application after a scalp massage they do not practice'
);

assert(
  source.includes("At NW7, your minoxidil and microneedling cover topical growth signal and scalp priming for the remaining horseshoe fringe — wait 24-48 hours after each microneedling session before applying minoxidil along the fringe (applying immediately after needling risks follicle irritation); on non-needling days apply twice daily as normal. Your highest-ROI next step is a transplant or SMP consultation; minoxidil is commonly continued post-transplant to protect native fringe hair around new grafts. Research experienced surgeons or SMP artists this week.") &&
  source.includes("At NW7, your minoxidil and LLLT device cover topical growth signal and photobiomodulation for the remaining horseshoe fringe — apply minoxidil immediately after your LLLT session while scalp circulation is elevated. Your highest-ROI next step is a transplant or SMP consultation; minoxidil and LLLT are commonly continued post-transplant to protect native fringe hair. Research experienced surgeons or SMP artists this week.") &&
  source.includes("At NW7, your minoxidil and scalp massage provide topical growth signal and mechanical stimulation for the remaining horseshoe fringe — apply minoxidil immediately after your massage while scalp circulation is elevated. Your highest-ROI next step is a transplant or SMP consultation; minoxidil is commonly continued post-transplant to protect native fringe hair around new grafts. Research experienced surgeons or SMP artists this week."),
  'WEEKLY_FOCUS_MAP.Potential NW7 _hasMinoxidil+_hasMassage branch should sub-check _hasLLLT and _hasMicroneedling and give device-specific timing advice — microneedling users wait 24-48 hours before applying minoxidil; LLLT users apply immediately after session; plain massage users also apply immediately after massage'
);

assert(
  source.includes("NW4 crown with finasteride + minoxidil + LLLT is a strong non-surgical crown protocol — apply 1ml minoxidil to the vertex immediately after your LLLT session while scalp circulation is elevated") &&
    source.includes("NW4 crown with finasteride + minoxidil + microneedling is a strong non-surgical crown protocol — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex") &&
    source.includes("NW4 crown with finasteride + minoxidil + massage is the most complete non-surgical crown protocol — apply 1ml minoxidil to the vertex immediately after a 4-minute scalp massage"),
  'WEEKLY_FOCUS_MAP.Crown NW4 _hasFinasteride+_hasMinoxidil+_hasMassage branch should sub-check _hasLLLT and _hasMicroneedling so LLLT device users apply minoxidil after their LLLT session and microneedling users wait 24-48 hours — not be told to time application after a scalp massage they do not practice'
);

assert(
  source.includes("NW3v crown thinning has just started and your finasteride + minoxidil + LLLT protocol is fully deployed for the crown — apply 1ml to the vertex immediately after your LLLT session while scalp circulation is elevated") &&
    source.includes("NW3v crown thinning has just started and your finasteride + minoxidil + microneedling protocol is fully deployed for the crown — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex") &&
    source.includes("NW3v crown thinning has just started and your finasteride + minoxidil + massage stack is fully deployed — apply 1ml to the vertex immediately after your scalp massage"),
  'WEEKLY_FOCUS_MAP.Crown NW3v _hasFinasteride+_hasMinoxidil+_hasMassage branch should sub-check _hasLLLT and _hasMicroneedling so LLLT device users apply minoxidil after their LLLT session and microneedling users wait 24-48 hours at this highest-ROI crown intervention window'
);

assert(
  source.includes("NW5 crown thinning with finasteride + minoxidil + LLLT is a strong non-surgical vertex protocol — confirm 1ml minoxidil reaches the vertex directly after your LLLT session while scalp circulation is elevated") &&
    source.includes("NW5 crown thinning with finasteride + minoxidil + microneedling is a strong non-surgical vertex protocol — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex") &&
    source.includes("NW5 crown thinning with finasteride + minoxidil + massage is the most complete non-surgical vertex protocol — confirm 1ml minoxidil reaches the vertex directly after each scalp massage"),
  'WEEKLY_FOCUS_MAP.Crown NW5 _hasFinasteride+_hasMinoxidil+_hasMassage branch should sub-check _hasLLLT and _hasMicroneedling so LLLT device users apply minoxidil after their LLLT session and microneedling users wait 24-48 hours — mirrors the NW3v/NW4 pattern for consistency at this nearly-merged stage'
);

assert(
  source.includes("NW5 crown thinning with finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical vertex protocol — confirm 1ml minoxidil reaches the vertex directly after your LLLT session while scalp circulation is elevated") &&
    source.includes("NW5 crown thinning with finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical vertex protocol — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation)") &&
    source.includes("NW5 crown thinning with finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical vertex protocol — confirm 1ml minoxidil reaches the vertex directly after each scalp massage"),
  'WEEKLY_FOCUS_MAP.Crown NW5 full-stack _hasFinasteride+_hasMinoxidil+_hasDHTShampoo+_hasMassage branch should sub-check _hasLLLT and _hasMicroneedling so LLLT device users apply minoxidil after their LLLT session and microneedling users wait 24-48 hours — mirrors the non-DHT-shampoo sibling branch pattern'
);

assert(
  source.includes("NW4 crown with finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical crown protocol — apply 1ml minoxidil to the vertex immediately after your LLLT session while scalp circulation is elevated") &&
    source.includes("NW4 crown with finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical crown protocol — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation)") &&
    source.includes("NW4 crown with finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical crown protocol — apply 1ml minoxidil to the vertex immediately after a 4-minute scalp massage"),
  'WEEKLY_FOCUS_MAP.Crown NW4 full-stack _hasFinasteride+_hasDHTShampoo+_hasMinoxidil+_hasMassage branch should sub-check _hasLLLT and _hasMicroneedling so LLLT device users apply minoxidil after their LLLT session and microneedling users wait 24-48 hours — mirrors the non-DHT-shampoo sibling branch pattern'
);

assert(
  source.includes("NW3v crown thinning has just started and your finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical protocol — apply 1ml to the vertex immediately after your LLLT session while scalp circulation is elevated") &&
    source.includes("NW3v crown thinning has just started and your finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical protocol — wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation)") &&
    source.includes("NW3v crown thinning has just started and your finasteride + minoxidil + DHT shampoo + scalp massage is the most complete non-surgical protocol — apply 1ml to the vertex immediately after your scalp massage"),
  'WEEKLY_FOCUS_MAP.Crown NW3v full-stack _hasFinasteride+_hasDHTShampoo+_hasMinoxidil+_hasMassage branch should sub-check _hasLLLT and _hasMicroneedling so LLLT device users apply minoxidil after their LLLT session and microneedling users wait 24-48 hours at this highest-ROI crown window'
);

assert(
  source.includes("NW4 frontal hairline with minoxidil + DHT shampoo + LLLT covers topical growth signal, local DHT suppression, and photobiomodulation — apply minoxidil along the entire hairline edge immediately after your LLLT session while scalp circulation is elevated") &&
    source.includes("NW4 frontal hairline with minoxidil + DHT shampoo + microneedling covers topical growth signal, local DHT suppression, and scalp priming — wait 24-48 hours after each microneedling session before applying minoxidil along the entire hairline edge") &&
    source.includes("At NW4, minoxidil + DHT shampoo + scalp massage covers topical growth signal, local DHT suppression, and mechanical stimulation across the full frontal hairline — apply minoxidil along the entire hairline edge immediately after your scalp massage"),
  'WEEKLY_FOCUS_MAP.Hairline NW4 _hasMinoxidil+_hasDHTShampoo+_hasMassage branch should sub-check _hasLLLT and _hasMicroneedling so LLLT device users apply minoxidil after their LLLT session and microneedling users wait 24-48 hours — not be told to apply after a scalp massage they do not practice'
);

assert(
  source.includes("NW5 frontal recession with minoxidil + DHT shampoo + LLLT covers topical growth signal, local DHT suppression, and photobiomodulation — apply minoxidil along the full frontal zone immediately after your LLLT session while scalp circulation is elevated") &&
    source.includes("NW5 frontal recession with minoxidil + DHT shampoo + microneedling covers topical growth signal, local DHT suppression, and scalp priming — wait 24-48 hours after each microneedling session before applying minoxidil along the full frontal zone") &&
    source.includes("NW5 frontal recession with minoxidil + DHT shampoo + scalp massage covers topical growth signal, local DHT suppression, and mechanical stimulation — apply minoxidil along the full frontal zone immediately after your scalp massage"),
  'WEEKLY_FOCUS_MAP.Hairline NW5 _hasMinoxidil+_hasDHTShampoo+_hasMassage branch should sub-check _hasLLLT and _hasMicroneedling so LLLT device users apply minoxidil after their LLLT session and microneedling users wait 24-48 hours — not be told to apply after a scalp massage they do not practice'
);

assert(
  source.includes("At NW6, minoxidil + DHT shampoo + LLLT covers topical growth signal, local DHT suppression, and photobiomodulation for the remaining fringe — apply minoxidil along the fringe and temple edges immediately after your LLLT session while scalp circulation is elevated") &&
    source.includes("At NW6, minoxidil + DHT shampoo + microneedling covers topical growth signal, local DHT suppression, and scalp priming for the remaining fringe — wait 24-48 hours after each microneedling session before applying minoxidil along the fringe and temple edges") &&
    source.includes("At NW6, minoxidil + DHT shampoo + scalp massage covers topical growth signal, local DHT suppression, and mechanical stimulation — apply minoxidil along the fringe and temple edges immediately after your massage"),
  'WEEKLY_FOCUS_MAP.Hairline NW6 _hasMinoxidil+_hasDHTShampoo+_hasMassage branch should sub-check _hasLLLT and _hasMicroneedling so LLLT device users apply minoxidil after their LLLT session and microneedling users wait 24-48 hours — not be told to apply after a scalp massage they do not practice'
);

assert(
  source.includes("Your scalp is fully intact — rescan in") &&
    source.includes("to confirm prevention is holding; subtle early temple shifts are easy to miss without a periodic baseline comparison") &&
    source.includes("Early temple recession is highly responsive to treatment — rescan in") &&
    source.includes("to catch the first density response before it's visible in the mirror") &&
    source.includes("Deep recession at NW3 responds strongly to a consistent protocol — rescan in") &&
    source.includes("to see if the miniaturization edge is stabilizing") &&
    source.includes("Both active zones (temples and early crown) are in the treatment-response window — rescan in") &&
    source.includes("to measure density progress across both active fronts") &&
    source.includes("Consistent multi-layer treatment at NW4 produces measurable results over 4-6 weeks — rescan in") &&
    source.includes("to track stabilization across both the frontal and crown zones") &&
    source.includes("OTC treatment at NW5 primarily slows progression rather than reversing it — rescan in") &&
    source.includes("to confirm the rate of change is stabilizing"),
  'nextCheckInReason should have stage-specific messages for NW1-NW5 (not just generic urgency strings) so the iOS app can surface clinically relevant, stage-calibrated check-in context for every Norwood stage'
);

assert(
  source.includes('computeProtocolStrengthScore') &&
    source.includes('protocolStrengthScore') &&
    source.includes('protocolStrengthLabel') &&
    source.includes("score >= 85 ? 'complete'") &&
    source.includes("if (stage === 'NW5') score = Math.min(score, 80)") &&
    source.includes('if (isAdvanced) score = Math.min(score, 75)'),
  'scan response should include protocolStrengthScore (0-100) and protocolStrengthLabel derived from protocolCoverage, with NW5 capped at 80 and NW6/NW7 capped at 75 to signal that surgical options are the primary path at these advanced stages'
);

assert(
  source.includes('if (microneedling || lllt) score += 15') &&
    source.includes('else if (mechanical)       score += 8') &&
    source.includes('Clinical mechanical (LLLT or microneedling) = 15; basic massage only = 8'),
  'computeProtocolStrengthScore should differentiate clinical mechanical interventions (LLLT or microneedling = 15 points) from basic scalp massage only (= 8 points) so the protocol strength signal reflects device quality, not just category presence'
);

assert(
  source.includes('At NW5, finasteride + minoxidil + DHT shampoo + LLLT is the most complete non-surgical density protocol') &&
    source.includes('Apply minoxidil immediately after your LLLT session while scalp circulation is elevated, leave DHT shampoo on 3-5 minutes before rinsing, and take finasteride at the same time each day. Track progress with monthly overhead photos; this four-layer protocol gives the strongest documented non-surgical density response at NW5') &&
    source.includes('At NW5, finasteride + minoxidil + DHT shampoo + microneedling is the most complete non-surgical density protocol') &&
    source.includes('Wait 24-48 hours after each microneedling session before applying minoxidil (applying immediately after needling risks follicle irritation); on non-needling days apply across both thinning fronts twice daily as normal. Leave DHT shampoo on 3-5 minutes before rinsing and take finasteride at the same time each day. Track progress with monthly overhead photos; this four-layer protocol gives the strongest documented non-surgical density response at NW5'),
  'WEEKLY_FOCUS_MAP.Density NW5 full-stack (finasteride+minoxidil+DHT shampoo+massage) branch should sub-check _hasLLLT and _hasMicroneedling so LLLT users apply minoxidil after their LLLT session and microneedling users wait 24-48 hours — not be told to apply "immediately after scalp massage" when they have a more advanced device'
);

assert(
  source.includes('At NW5, density loss spans both frontal and crown zones and your three-layer stack is the right approach — apply minoxidil immediately after your LLLT session while scalp circulation is elevated') &&
    source.includes("At NW5, density loss spans both frontal and crown zones and your three-layer stack is the right approach — wait 24-48 hours after each microneedling session before applying minoxidil"),
  'WEEKLY_FOCUS_MAP.Density NW5 OTC 3-layer (DHT shampoo+minoxidil+massage) branch should sub-check _hasLLLT and _hasMicroneedling so device users get correct minoxidil timing rather than "apply immediately after scalp massage"'
);

assert(
  source.includes('Apply minoxidil directly to the crown (1ml) twice daily at NW6, immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes on wash days') &&
    source.includes('Apply minoxidil directly to the crown (1ml) twice daily at NW6 — wait 24-48 hours after each microneedling session before applying (applying immediately after needling risks follicle irritation). On non-needling days apply twice daily as normal; leave DHT shampoo on 3-5 minutes on wash days'),
  'WEEKLY_FOCUS_MAP.Crown NW6 OTC 3-layer (minoxidil+DHT shampoo+massage) branch should sub-check _hasLLLT and _hasMicroneedling so device users get correct minoxidil timing — not "immediately after each scalp massage" when they use an LLLT cap or dermaroller'
);

assert(
  source.includes("apply 1ml minoxidil directly to the vertex immediately after your LLLT session while scalp circulation is elevated, and leave DHT shampoo on 3-5 minutes on wash days. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW5 crown protocol") &&
    source.includes("wait 24-48 hours after each microneedling session before applying minoxidil to the vertex (applying immediately after needling risks follicle irritation). On non-needling days apply 1ml directly to the vertex twice daily as normal; leave DHT shampoo on 3-5 minutes on wash days. A doctor consult about finasteride adds systemic DHT suppression for the most complete NW5 crown protocol"),
  'WEEKLY_FOCUS_MAP.Crown NW5 OTC 3-layer (minoxidil+DHT shampoo+massage) branch should sub-check _hasLLLT and _hasMicroneedling so device users get correct minoxidil timing — LLLT users apply after LLLT session, microneedling users wait 24-48 hours — not "immediately after your scalp massage" when they use an LLLT cap or dermaroller'
);

assert(
  source.includes("At NW3v, your supplements + DHT shampoo + microneedling covers nutrition, topical DHT suppression, and scalp priming across both active zones — use your DHT shampoo on non-needling days (or wait 48 hours after each session) to avoid applying active ingredients to a sensitized scalp; on non-needling wash days leave it on 3-5 minutes per wash at both the recession edge and early crown zone. A doctor consult about finasteride is the highest-ROI next step for systemic DHT suppression at this dual-zone stage."),
  'WEEKLY_FOCUS_MAP.Health NW3v _hasSupplements+_hasDHTShampoo+_hasMassage branch should sub-check _hasMicroneedling so microneedling users get DHT shampoo timing advice (wait 48h after needling) instead of being told to add weekly microneedling they already practice'
);

assert(
  source.includes('Buffer.concat(chunks)') &&
    source.includes('chunks.push(chunk)') &&
    source.includes('REQUEST_BODY_TIMEOUT_MS') &&
    source.includes('err.statusCode = 408'),
  'readJsonBody should accumulate request chunks as Buffers (not string concatenation) for memory efficiency on large photo payloads, and enforce a per-request body-read timeout to guard against slow-body attacks'
);

assert(
  source.includes("PROGRESSION_CALIBRATED_DIFFUSE_12MO_STAGES = new Set(['diffuse', 'n/a (female)'])") &&
    source.includes("month === 12 && PROGRESSION_CALIBRATED_DIFFUSE_12MO_STAGES.has(stage)") &&
    source.includes("CALIBRATES the \"Full natural-looking density\" language above — for diffuse thinning or female-pattern loss") &&
    source.includes("do NOT produce a result where the parting and scalp look completely identical to a person with no hair loss history"),
  'buildProgressionPrompt should apply a calibrated 12-month override for diffuse and n/a (female) stages — the base "Full natural-looking density" is too optimistic for central-part thinning that rarely returns to fully uniform density at 12 months; mirrors the NW3/NW3v calibration pattern'
);

assert(
  source.includes("PROGRESSION_CALIBRATED_DIFFUSE_3MO_STAGES = new Set(['diffuse', 'n/a (female)'])") &&
    source.includes("month === 3 && PROGRESSION_CALIBRATED_DIFFUSE_3MO_STAGES.has(stage)") &&
    source.includes("CALIBRATES the \"thinning edges / recession boundary\" language above") &&
    source.includes("DO NOT alter the hairline, temples, or frontal edge"),
  'buildProgressionPrompt should apply a calibrated 3-month override for diffuse/n/a(female) that removes AGA-specific "thinning edges" language and redirects improvement to the central parting — anatomically correct for uniform diffuse thinning and female-pattern (Ludwig) loss where temples are spared'
);

assert(
  source.includes("PROGRESSION_CALIBRATED_DIFFUSE_6MO_STAGES = new Set(['diffuse', 'n/a (female)'])") &&
    source.includes("month === 6 && PROGRESSION_CALIBRATED_DIFFUSE_6MO_STAGES.has(stage)") &&
    source.includes("CALIBRATES the \"hairline edges / temple recession\" language above") &&
    source.includes("central parting and scalp top only"),
  'buildProgressionPrompt should apply a calibrated 6-month override for diffuse/n/a(female) that removes AGA-specific "temple recession" language and redirects visible density improvement to the central parting and scalp top — correct for diffuse thinning and female-pattern loss where the hairline must not change'
);

assert(
  !source.includes("male hairline/top scalp") &&
    source.includes("scalp/top of head") &&
    source.includes('topical'),
  'topical advice visual prompt should use gender-neutral "scalp/top of head" — not "male hairline" — so female users get a representative image for topical serum advice'
);

assert(
  source.includes('TE/stress calibration for insights') &&
    source.includes("Stress ≥ 7") &&
    source.includes("Sleep ≤ 5h") &&
    source.includes("TE root cause") &&
    source.includes("stage is 'diffuse' or 'n/a (female)'"),
  'scan prompt should include TE/stress calibration for insights — directing GPT-4o to surface stress/sleep management as a high-ROI insight for high-stress or sleep-deprived users with diffuse thinning'
);

assert(
  source.includes("At NW2, your supplement stack and LLLT device cover nutritional support and photobiomodulation at the ideal prevention stage — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx preventive foundation at this optimal intervention window before temple recession deepens further.") &&
    source.includes("At NW2, your supplement stack and microneedling cover nutritional support and scalp priming at the early recession edge — use microneedling 24-48 hours before topical application to maximize absorption at the temple corners. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx preventive foundation at this optimal intervention window.") &&
    source.includes("At NW2, your supplement stack and scalp massage cover nutritional support and mechanical stimulation at the ideal prevention stage — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary layers (nutritional + mechanical + DHT suppression) give the strongest non-Rx preventive foundation before temple recession deepens further."),
  'NW2 Health WEEKLY_FOCUS_MAP should have (supplements+massage) branch with LLLT/microneedling sub-check so users who already have both a supplement stack and scalp massage are not told to start supplements — consistent with the NW3v and NW4 Health pattern'
);

assert(
  source.includes("At NW3, your supplement stack and LLLT device cover nutritional support and photobiomodulation at the active recession edge — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary layers (nutritional + photobiomodulation + DHT suppression) give the strongest non-Rx scalp-health response where miniaturization is actively progressing at this established stage.") &&
    source.includes("At NW3, your supplement stack and microneedling cover nutritional support and scalp priming at the active recession edge — use microneedling 24-48 hours before topical application to maximize absorption where miniaturization is most active. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx scalp-health response where miniaturization is actively progressing at this established stage.") &&
    source.includes("At NW3, your supplement stack and scalp massage cover nutritional support and mechanical stimulation at the active recession edge — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary layers (nutritional + mechanical + DHT suppression) give the strongest non-Rx scalp-health response where miniaturization is actively progressing at this established stage."),
  'NW3 Health WEEKLY_FOCUS_MAP should have (supplements+massage) branch with LLLT/microneedling sub-check so users who already have both a supplement stack and scalp massage are not told to start supplements — consistent with the NW3v and NW4 Health pattern'
);

assert(
  source.includes("At NW5, your supplement stack and LLLT device cover nutritional support and photobiomodulation across the full scalp top — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Biotin, zinc, and vitamin D support follicle structure from within; weekly microneedling (0.5mm) after your LLLT sessions is the highest-ROI absorption upgrade to complete the three-layer scalp-health protocol at this stage.") &&
    source.includes("At NW5, your supplement stack and microneedling cover nutritional support and scalp priming across the full scalp top — use microneedling 24-48 hours before topical application to maximize absorption where miniaturization is most active across both frontal and crown zones. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; three complementary layers (nutritional + scalp priming + DHT suppression) give the strongest non-Rx scalp-health response at this advanced stage.") &&
    source.includes("At NW5, your supplement stack and scalp massage cover nutritional support and mechanical stimulation across the full scalp top — add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer. Three complementary layers (nutritional + mechanical + DHT suppression) give the strongest non-Rx scalp-health response where miniaturization spans both the frontal and crown zones at this stage."),
  'NW5 Health WEEKLY_FOCUS_MAP should have (supplements+massage) branch with LLLT/microneedling sub-check so users who already have both a supplement stack and scalp massage are not told to add microneedling they already have — consistent with NW2/NW3/NW4 Health pattern'
);

assert(
  source.includes("Your supplement stack supports remaining fringe follicle health at NW7 — keep biotin, zinc, and vitamin D consistent as nutritional support for fringe density. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist or transplant consultation to evaluate candidacy and how your nutritional protocol integrates with the surgical coverage plan."),
  'WEEKLY_FOCUS_MAP.Density NW7 should be supplements-aware: users whose only active treatment is a supplement stack receive acknowledgment of their nutritional protocol rather than falling through to the generic surgical-only default'
);

assert(
  source.includes("Your supplement stack supports follicle health at NW5 where density has declined across both frontal and crown zones — nutritional support is a good foundation, but the highest-ROI additions at this dual-zone stage are minoxidil applied across the full scalp top twice daily and a DHT-blocking shampoo 3× weekly (3-5 min contact time). Adding both topical layers while follicles are still viable gives the strongest OTC density response at NW5; track with monthly overhead photos."),
  'WEEKLY_FOCUS_MAP.Density NW5 should be supplements-aware: users with only a supplement stack receive targeted dual-zone advice rather than the generic no-treatment default'
);

assert(
  source.includes("Your supplement stack is supporting fringe follicle health at NW6 — add minoxidil to the fringe and lateral edges twice daily and a DHT-blocking shampoo 3× weekly as the two missing topical layers. Together they deliver topical growth signal and local DHT suppression where density loss is advanced; the realistic goal at this stage is stabilizing remaining fringe coverage. Track with monthly overhead photos."),
  'WEEKLY_FOCUS_MAP.Density NW6 should be supplements-aware: users with only a supplement stack receive fringe-specific advice rather than the generic add-minoxidil/DHT-shampoo default'
);

assert(
  source.includes("Your supplement stack supports fringe follicle health at NW7 — keep biotin, zinc, and vitamin D consistent as the nutritional layer for remaining fringe follicles. The highest-ROI next step is booking a trichologist or transplant consultation this week to evaluate donor supply, candidacy, and how your nutritional protocol integrates with surgical coverage options (FUE/FUT or SMP)."),
  'WEEKLY_FOCUS_MAP.Health NW7 should be supplements-aware: users whose only active treatment is a supplement stack receive acknowledgment of their nutritional support rather than falling through to the generic keep-any-routine-going default — mirrors NW6 supplement awareness pattern'
);

assert(
  source.includes("Your supplement and DHT-blocking shampoo routine is protecting remaining follicles at NW6 — keep DHT shampoo on 3-5 minutes per wash and add weekly microneedling over the fringe zones to prime follicle response. A dermatologist check can rule out any inflammatory component that your current protocol cannot address alone."),
  'WEEKLY_FOCUS_MAP.Health NW6 should be supplements+DHT-shampoo-aware: users who have both a supplement stack and DHT-blocking shampoo at NW6 receive compound-aware acknowledgment rather than falling through to the standalone _hasDHTShampoo branch that ignores their supplements — mirrors the Health NW7 and Potential NW6 supplement+DHT compound patterns'
);

assert(
  source.includes("Your supplement stack and DHT-blocking shampoo provide nutritional support and topical DHT suppression for remaining fringe follicles at NW7 — keep DHT shampoo on 3-5 minutes per wash 3× weekly and your supplement stack consistent. The highest-ROI next step is booking a trichologist or transplant consultation to evaluate donor supply, candidacy, and how your nutritional + topical DHT protocol integrates with surgical coverage options (FUE/FUT or SMP)."),
  'WEEKLY_FOCUS_MAP.Health NW7 should be supplements+DHT-shampoo-aware: users with both a supplement stack and DHT-blocking shampoo at NW7 receive compound-aware fringe-health advice rather than falling through to the standalone _hasDHTShampoo branch that ignores their supplements — mirrors the Health NW6 and Potential NW7 supplement+DHT compound patterns'
);

assert(
  source.includes('Your supplement stack and DHT-blocking shampoo are both active at NW5 — nutritional support and topical DHT suppression across both frontal and crown thinning zones. Add minoxidil across the entire scalp top twice daily as the topical growth signal; supplements + DHT shampoo + minoxidil gives the strongest OTC triple-layer approach at this advanced stage (realistic potential: 28-48%). Set a 3-month checkpoint with overhead and front-facing photos and consider booking a transplant consultation in parallel to plan surgical and OTC paths together.'),
  'WEEKLY_FOCUS_MAP.Potential NW5 should be supplements+DHT-shampoo-aware: users with both a supplement stack and DHT-blocking shampoo (but no minoxidil) receive acknowledgment of both layers and are directed to add minoxidil rather than falling through to the DHT-shampoo-only branch that ignores their supplements'
);

assert(
  source.includes('Your supplement stack and DHT-blocking shampoo support fringe follicle health through nutritional and topical DHT-suppression layers at NW6 — keep both consistent. Add minoxidil to the fringe and lateral edges twice daily as the topical growth signal; the triple combination gives the strongest realistic OTC approach for fringe maintenance at this stage (realistic potential: 15-32%). Set a 3-month checkpoint with overhead photos and prioritize booking a transplant consultation this quarter to plan surgical coverage alongside your protocol.'),
  'WEEKLY_FOCUS_MAP.Potential NW6 should be supplements+DHT-shampoo-aware: users with both a supplement stack and DHT-blocking shampoo (but no minoxidil) receive acknowledgment of both layers and are directed to add minoxidil — mirrors the NW5 supplements+DHT-shampoo pattern'
);

assert(
  source.includes('Your supplement stack and DHT-blocking shampoo support fringe follicle health through nutritional and topical DHT-suppression layers at NW7 — keep both consistent. Your highest-ROI next step is a transplant or SMP consultation; OTC treatments alone are unlikely to create meaningful new coverage at this stage, but your dual-layer protocol complements a surgical plan by supporting fringe follicle health and protecting native hair around new grafts. Research experienced surgeons or SMP artists this week.'),
  'WEEKLY_FOCUS_MAP.Potential NW7 should be supplements+DHT-shampoo-aware: users with both a supplement stack and DHT-blocking shampoo receive acknowledgment of both layers rather than falling through to the DHT-shampoo-only branch that ignores their supplements — mirrors the NW6 pattern'
);

assert(
  source.includes("Your minoxidil + DHT-blocking shampoo provides a topical growth signal and local DHT suppression for the remaining horseshoe fringe at NW7 — apply minoxidil to the fringe and lateral edges twice daily and leave DHT shampoo on 3-5 minutes per wash. The primary hairline coverage path at this stage is FUE/FUT transplant or SMP; book a trichologist consult this week to understand candidacy, donor supply, and how your dual-layer topical protocol integrates into the surgical strategy."),
  'WEEKLY_FOCUS_MAP.Hairline NW7 should have a minoxidil+DHT-shampoo compound branch: users with both topical layers but no finasteride at NW7 receive advice acknowledging both treatments rather than falling through to the DHT-shampoo-only branch that ignores their minoxidil — mirrors the NW7 Health and Potential minoxidil+DHT-shampoo patterns'
);

assert(
  source.includes("Your minoxidil + DHT-blocking shampoo provides a topical growth signal and local DHT suppression for the remaining fringe at NW7 — apply minoxidil to the fringe and lateral edges twice daily and leave DHT shampoo on 3-5 minutes per wash. The primary path for meaningful density coverage is surgical (FUE/FUT or SMP); prioritize a trichologist consultation to evaluate candidacy and how your dual-layer topical protocol complements the surgical coverage plan."),
  'WEEKLY_FOCUS_MAP.Density NW7 should have a minoxidil+DHT-shampoo compound branch: users with both topical layers but no finasteride at NW7 receive density advice acknowledging both treatments rather than falling through to the DHT-shampoo-only branch that ignores their minoxidil — mirrors the NW7 Health and Potential minoxidil+DHT-shampoo patterns'
);

assert(
  source.includes("Your minoxidil + DHT-blocking shampoo provides a topical growth signal and local DHT suppression for the remaining fringe at NW7 — apply minoxidil to the fringe and lateral edges twice daily and leave DHT shampoo on 3-5 minutes per wash. Crown coverage at this stage is best addressed through FUE/FUT or SMP; book a specialist consult this week to discuss vertex coverage goals, donor supply, and how your dual-layer topical protocol fits into the surgical plan."),
  'WEEKLY_FOCUS_MAP.Crown NW7 should have a minoxidil+DHT-shampoo compound branch: users with both topical layers but no finasteride at NW7 receive crown advice acknowledging both treatments rather than falling through to the DHT-shampoo-only branch that ignores their minoxidil — mirrors the NW7 Health and Potential minoxidil+DHT-shampoo patterns'
);

assert(
  source.includes('Finasteride + DHT-blocking shampoo at NW6 delivers dual-level DHT suppression for the remaining fringe and temporal hairline — systemic through finasteride and topical through the shampoo (3-5 min contact time 3× weekly). Add minoxidil to the fringe and temporal edges twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the strongest non-surgical fringe hairline protocol at this stage. Book a transplant consultation to evaluate surgical coverage options alongside your current dual-layer DHT protocol.'),
  'WEEKLY_FOCUS_MAP.Hairline NW6 should have a finasteride+DHT-shampoo compound branch so users with both finasteride and DHT shampoo but not yet minoxidil receive advice acknowledging their dual-layer DHT protocol rather than falling through to the standalone finasteride branch that incorrectly tells them to add DHT shampoo they already have'
);

assert(
  source.includes('Finasteride + DHT-blocking shampoo delivers dual-level DHT suppression at NW6 where density is mostly lost — systemic DHT control through finasteride and topical suppression through the shampoo (3-5 min contact time 3× weekly). Add minoxidil to the remaining fringe and lateral edges twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the strongest non-surgical density maintenance protocol at this stage. Track with monthly overhead photos and consider a transplant consultation for full coverage planning.'),
  'WEEKLY_FOCUS_MAP.Density NW6 should have a finasteride+DHT-shampoo compound branch so users with both finasteride and DHT shampoo but not yet minoxidil receive advice acknowledging their dual-layer DHT protocol rather than falling through to the standalone finasteride branch that incorrectly recommends DHT shampoo they already have'
);

assert(
  source.includes('Finasteride + DHT-blocking shampoo at NW6 delivers dual-level DHT suppression for the crown — systemic through finasteride and topical through the shampoo (3-5 min contact time 3× weekly). Add minoxidil (1ml) directly to the vertex twice daily as the topical growth signal; finasteride + minoxidil + DHT shampoo is the strongest non-surgical crown protocol at this stage. Photograph from above every 6 weeks to track change and consider booking a transplant consultation for vertex coverage planning.'),
  'WEEKLY_FOCUS_MAP.Crown NW6 should have a finasteride+DHT-shampoo compound branch so users with both finasteride and DHT shampoo but not yet minoxidil receive crown advice acknowledging their dual-layer DHT protocol rather than falling through to the standalone finasteride branch that incorrectly tells them to add DHT shampoo they already have'
);

assert(
  source.includes("oralMinoxidil = false, rx = false, dhtShampoo = false, mechanical = false, lllt = false, microneedling = false, supplements = false, transplant = false } = protocolCoverage || {}") &&
    source.includes("const hasAnyOTC = topical || oralMinoxidil || dhtShampoo || mechanical || supplements"),
  'buildSuggestedQuestions should destructure oralMinoxidil and supplements from protocolCoverage and include both in hasAnyOTC so supplement-only users (Nutrafol, Viviscal, biotin+zinc) and oral minoxidil users (Loniten/LDOM) are routed to the OTC-tier questions (is finasteride worth adding?) rather than the no-treatment tier (what should I start first?)'
);

assert(
  source.includes('At NW5, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression across the full scalp top where miniaturization spans both the frontal and crown zones — take finasteride at the same time each day and leave DHT shampoo on 3-5 minutes per wash 3× weekly. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer and weekly microneedling over the thinnest zones to prime follicle response; the complete four-layer scalp-health protocol gives the strongest anti-miniaturization response where miniaturization is most widespread at this advanced stage.'),
  'WEEKLY_FOCUS_MAP.Health NW5 should have a finasteride+DHT-shampoo compound branch so users with both finasteride and DHT shampoo but not supplements receive advice acknowledging their dual-layer DHT protocol rather than falling through to the standalone finasteride branch that incorrectly tells them to add DHT shampoo they already have'
);

assert(
  source.includes('At NW6, finasteride + DHT-blocking shampoo delivers systemic and topical DHT suppression for remaining fringe follicle health — take finasteride at the same time each day without gaps and leave DHT shampoo on 3-5 minutes per wash 3× weekly. Add weekly microneedling over the fringe zones to prime remaining follicle response and consider a supplement stack (biotin, zinc, vitamin D) as the nutritional layer; a dermatologist check can also rule out any inflammatory component that your current dual-DHT protocol cannot address alone.'),
  'WEEKLY_FOCUS_MAP.Health NW6 should have a finasteride+DHT-shampoo compound branch so users with both finasteride and DHT shampoo but not supplements receive advice acknowledging their dual-layer DHT protocol rather than falling through to the standalone finasteride branch that incorrectly tells them to add DHT shampoo they already have — mirrors the NW7 Health finasteride+DHT-shampoo pattern'
);

assert(
  source.includes('Your scalp health has dual-level DHT protection at NW1 — finasteride suppresses systemic DHT and your DHT-blocking shampoo adds topical control at the scalp surface before any visible thinning begins. Keep DHT shampoo on 3-5 minutes per wash 3× weekly and finasteride consistent without gaps. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer to complete the most comprehensive NW1 preventive protocol.'),
  'WEEKLY_FOCUS_MAP.Health NW1 should have a finasteride+DHT-shampoo compound branch so users with both finasteride and DHT shampoo but not supplements receive advice acknowledging their dual-layer DHT protocol rather than falling through to the standalone finasteride branch that incorrectly tells them to add DHT shampoo they already have'
);

assert(
  source.includes('At NW1, your supplement stack, minoxidil, and DHT-blocking shampoo form the most complete OTC preventive scalp-health protocol before any visible thinning begins — nutritional follicle support, topical growth signal, and local DHT suppression all active.') &&
    source.includes('This three-layer OTC stack gives the strongest non-Rx scalp-health foundation at the optimal prevention window; target sleep quality this week (7-8 hrs) as the highest-ROI lifestyle addition — cortisol from poor sleep accelerates miniaturization even when your preventive protocol is this complete.'),
  'WEEKLY_FOCUS_MAP.Health NW1 should have a supplements+minoxidil+DHT-shampoo triple branch so OTC users at NW1 with all three layers get scalp-health advice that acknowledges the complete three-layer preventive protocol rather than falling through to the supplements+DHT-shampoo dual branch that ignores their active minoxidil'
);

assert(
  source.includes('At NW1, your supplement stack, minoxidil, and DHT-blocking shampoo form the most complete OTC density-prevention protocol before any mid-scalp miniaturization begins — nutritional follicle support, topical growth signal, and local DHT suppression all active.') &&
    source.includes('The DHT shampoo is the primary miniaturization-prevention layer; supplements and minoxidil complete the three-layer OTC preventive stack. Take monthly overhead photos to catch any early mid-scalp change at this optimal prevention window.'),
  'WEEKLY_FOCUS_MAP.Density NW1 should have a supplements+minoxidil+DHT-shampoo triple branch so OTC users at NW1 with all three layers get density advice that acknowledges the complete three-layer preventive protocol rather than falling through to the supplements+DHT-shampoo dual branch that ignores their active minoxidil'
);

assert(
  source.includes('Finasteride + DHT-blocking shampoo covers both systemic and topical DHT suppression at NW2 where miniaturization is just starting at the temple edge — take finasteride consistently and leave DHT shampoo on 3-5 minutes before rinsing for maximum topical DHT suppression. Add a supplement stack (biotin, zinc, vitamin D) as the nutritional layer to complete the three-layer anti-miniaturization foundation at this ideal preventive window.'),
  'WEEKLY_FOCUS_MAP.Health NW2 should have a finasteride+DHT-shampoo compound branch so users with both finasteride and DHT shampoo but not supplements receive advice acknowledging their dual-layer DHT protocol rather than falling through to the standalone finasteride branch that incorrectly tells them to add DHT shampoo they already have'
);

assert(
  source.includes("r.includes('nanoxidil')") &&
    source.includes("s.includes('nanoxidil')"),
  'server should detect nanoxidil (DS Laboratories Spectral.DNC-N active ingredient) as a topical hair loss treatment in both scan-time _hasMinoxidil and coach pre-scan topical detection'
);

assert(
  source.includes("r.includes('bioxsine') || r.includes('watermans')"),
  'server should detect Bioxsine and Watermans as anti-hair-loss shampoos in scan-time _hasDHTShampoo detection'
);

assert(
  source.includes("s.includes('bioxsine') || s.includes('watermans')"),
  'coach pre-scan protocolCoverage fallback should detect Bioxsine and Watermans as anti-hair-loss shampoos consistent with scan-time _hasDHTShampoo detection'
);

assert(
  source.includes("r.includes('sugarbear')") &&
    source.includes("s.includes('sugarbear')"),
  'server should detect SugarBear Hair vitamins as a supplement brand in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('vegamour')") &&
    source.includes("s.includes('vegamour')"),
  'server should detect Vegamour (GROE supplements/serums brand sold at Sephora/Ulta) as a supplement in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('hair la vie')") &&
    source.includes("s.includes('hair la vie')"),
  'server should detect Hair La Vie as a supplement brand in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('foligrowth')") &&
    source.includes("s.includes('foligrowth')"),
  'server should detect Foligrowth as a supplement brand in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('pantovigar')") &&
    source.includes("s.includes('pantovigar')"),
  'server should detect Pantovigar (Western European variant of Pantogar, by Stada) as a supplement brand in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('philip kingsley')") &&
    source.includes("s.includes('philip kingsley')"),
  'server should detect Philip Kingsley (UK trichology supplements brand — Tricho Complex) in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('tricho complex')") &&
    source.includes("s.includes('tricho complex')"),
  'server should detect Tricho Complex (Philip Kingsley flagship hair supplement) in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('florisene')") &&
    source.includes("s.includes('florisene')"),
  'server should detect Florisene (Philip Kingsley iron supplement for female TE hair loss) in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('lambdapil')") &&
    source.includes("s.includes('lambdapil')"),
  'server should detect Lambdapil (popular Spanish/European supplement brand in ampoule form) in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('hum nutrition')") &&
    source.includes("s.includes('hum nutrition')"),
  'server should detect HUM Nutrition (popular US supplement brand with hair growth formula) in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('aindeem')") &&
    source.includes("s.includes('aindeem')"),
  'server should detect Aindeem (Accord Healthcare UK brand of finasteride 1mg, commonly prescribed on NHS) in both scan-time _hasFinasteride and coach pre-scan rx detection — UK users who say "I use Aindeem" should be classified as Rx'
);

assert(
  source.includes("r.includes('dr pen')") &&
    source.includes("r.includes('drpen')") &&
    source.includes("r.includes('dr.pen')") &&
    source.includes("s.includes('dr pen')") &&
    source.includes("s.includes('drpen')") &&
    source.includes("s.includes('dr.pen')"),
  'server should detect Dr. Pen (popular microneedling pen device brand) in all three spelling variants in both scan-time _hasMicroneedling/_hasMassage and coach pre-scan microneedling/mechanical detection'
);

assert(
  source.includes("r.includes('anacaps')") &&
    source.includes("s.includes('anacaps')"),
  'server should detect Anacaps (Ducray hair supplement, popular in France and EU) as a supplement in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('pilexil')") &&
    source.includes("s.includes('pilexil')"),
  'server should detect Pilexil (Almirall hair supplement, popular in Spain and Latin America) as a supplement in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('anaphase')") &&
    source.includes("s.includes('anaphase')"),
  'server should detect Anaphase (Ducray Anaphase+ anti-hair-loss shampoo, popular in France and EU) as a DHT-blocking/anti-hair-loss shampoo in both scan-time _hasDHTShampoo and coach pre-scan dhtShampoo detection'
);

assert(
  source.includes("r.includes('vichy')") &&
    source.includes("s.includes('vichy')"),
  'server should detect Vichy (Vichy Dercos anti-hair-loss shampoo line, very popular in Europe, Canada, and Australia) as a DHT-blocking/anti-hair-loss shampoo in both scan-time _hasDHTShampoo and coach pre-scan dhtShampoo detection'
);

assert(
  source.includes("r.includes('dercos')") &&
    source.includes("s.includes('dercos')"),
  'server should detect Dercos (Vichy Dercos brand name — users may type the product name without the Vichy prefix) as a DHT-blocking/anti-hair-loss shampoo in both scan-time _hasDHTShampoo and coach pre-scan dhtShampoo detection'
);

assert(
  source.includes("r.includes('klorane')") &&
    source.includes("s.includes('klorane')"),
  'server should detect Klorane (Klorane Quinine Strengthening Shampoo with B vitamins, popular French pharmacy brand for hair loss and thinning) as a DHT-blocking/anti-hair-loss shampoo in both scan-time _hasDHTShampoo and coach pre-scan dhtShampoo detection'
);

assert(
  source.includes("r.includes('derma stamp')") &&
    source.includes("s.includes('derma stamp')"),
  'server should detect derma stamp (stamp-type microneedling device — distinct from a roller; users who type "derma stamp" should be recognized as having a microneedling tool) in both scan-time _hasMicroneedling/_hasMassage and coach pre-scan microneedling/mechanical detection'
);

assert(
  source.includes("r.includes('dermastamp')") &&
    source.includes("s.includes('dermastamp')"),
  'server should detect dermastamp (single-word variant of derma stamp microneedling device) in both scan-time _hasMicroneedling/_hasMassage and coach pre-scan microneedling/mechanical detection'
);

assert(
  source.includes('NW5 frontal recession with your supplement stack and scalp massage cover nutritional support and mechanical stimulation across the narrowing frontal bridge — keep your supplement routine consistent and apply a 4-minute scalp massage daily focusing on the full frontal zone where the bridge between the forelock and lateral fringe is narrowing.'),
  'WEEKLY_FOCUS_MAP.Hairline NW5 should have a supplements+massage branch: users with both a supplement stack and scalp massage but no minoxidil or DHT shampoo at NW5 receive hairline advice acknowledging both layers and recommending DHT shampoo as the next addition, rather than falling through to the plain supplements branch that ignores their massage routine'
);

assert(
  source.includes('At NW6, your supplement stack and scalp massage cover nutritional support and mechanical stimulation for the remaining fringe and temporal hairline — keep your supplement routine consistent and massage along the fringe and lateral edges. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; it is the most impactful addition to your existing stack where fringe coverage is limited at this advanced stage. Book a transplant consultation and consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly front-facing photos.'),
  'WEEKLY_FOCUS_MAP.Hairline NW6 should have a supplements+massage branch: users with both a supplement stack and scalp massage but no minoxidil or DHT shampoo at NW6 receive fringe hairline advice acknowledging both layers and recommending DHT shampoo as the next addition plus a transplant consult, rather than falling through to the plain supplements branch that ignores their massage routine'
);

assert(
  source.includes('At NW4, your supplement stack and scalp massage cover nutritional support and mechanical stimulation across the full frontal hairline — keep your supplement routine consistent and apply a 4-minute scalp massage daily focusing on the entire frontal zone. Add a DHT-blocking shampoo 3× weekly (3-5 min contact time) as the missing topical DHT-suppression layer; it is the most impactful addition to your existing stack where the full frontal hairline has retreated at this established stage. Consider a doctor consult about finasteride for systemic DHT suppression. Track with monthly front-facing photos.'),
  'WEEKLY_FOCUS_MAP.Hairline NW4 should have a supplements+massage branch: users with both a supplement stack and scalp massage but no minoxidil or DHT shampoo at NW4 receive full-frontal-hairline advice acknowledging both layers and recommending DHT shampoo as the next addition, rather than falling through to the plain supplements branch that ignores their massage routine'
);

assert(
  source.includes("r.includes('revivogen')") &&
    source.includes("s.includes('revivogen')"),
  'server should detect Revivogen (DHT-blocking scalp therapy containing zinc, amino acids, and fatty acids that inhibit 5-alpha reductase) as a DHT-blocking shampoo/treatment in both scan-time _hasDHTShampoo and coach pre-scan dhtShampoo detection — users who list Revivogen should not be told to add a DHT-blocking shampoo they already have'
);

assert(
  source.includes("r.includes('laser helmet')") &&
    source.includes("s.includes('laser helmet')"),
  'server should detect laser helmet (generic term for dome-type LLLT devices like Theradome, Capillus Flex, and similar) as an LLLT device in both scan-time _hasLLLT/_hasMassage and coach pre-scan lllt/mechanical detection — users who describe their device as a laser helmet should be classified as having LLLT rather than having no mechanical stimulation'
);

assert(
  source.includes("r.includes('laserband')") && source.includes("r.includes('laser band')") &&
    source.includes("s.includes('laserband')") && source.includes("s.includes('laser band')"),
  'server should detect HairMax LaserBand (popular LLLT headband device) in both scan-time _hasLLLT/_hasMassage and coach pre-scan lllt/mechanical detection — laserband and laser band are common spellings; missing coach-side detection means users with a LaserBand are incorrectly told LLLT is NOT STARTED'
);

assert(
  source.includes("r.includes('derminator')") &&
    source.includes("s.includes('derminator')"),
  'server should detect Derminator (popular high-speed automated dermaroller brand) as a microneedling device in both scan-time _hasMicroneedling/_hasMassage and coach pre-scan microneedling/mechanical detection — users who list Derminator should not be told to add a microneedling device they already have'
);

assert(
  source.includes("At NW1, your supplement stack and LLLT device cover nutritional support and photobiomodulation") &&
    source.includes("At NW1, your supplement stack and microneedling cover nutritional support and scalp priming"),
  'WEEKLY_FOCUS_MAP.Potential NW1 supplements+massage branch should have LLLT and microneedling sub-branches so users with an LLLT device or microneedling tool do not receive text saying "your scalp massage" when they have a different mechanical stimulation method — mirrors the same sub-branch pattern added to NW3/NW4/NW5/NW6 in prior commits'
);

assert(
  source.includes("At NW2, your supplement stack and LLLT device cover nutritional support and photobiomodulation") &&
    source.includes("At NW2, your supplement stack and microneedling cover nutritional support and scalp priming"),
  'WEEKLY_FOCUS_MAP.Potential NW2 supplements+massage branch should have LLLT and microneedling sub-branches so users with an LLLT device or microneedling tool do not receive text saying "your scalp massage" when they have a different mechanical stimulation method — mirrors the same sub-branch pattern added to NW3/NW4/NW5/NW6 in prior commits'
);

assert(
  source.includes("r.includes('grape seed')") &&
    source.includes("r.includes('procyanidin')") &&
    source.includes("r.includes('resveratrol')") &&
    source.includes("s.includes('grape seed')") &&
    source.includes("s.includes('procyanidin')") &&
    source.includes("s.includes('resveratrol')"),
  'server should detect grape seed extract (procyanidins/OPC), procyanidin, and resveratrol as supplements in both scan-time _hasSupplements and coach pre-scan supplements detection — users listing these common antioxidant/OPC supplements should not be told they have no supplement stack'
);

assert(
  source.includes("r.includes('turmeric')") &&
    source.includes("r.includes('curcumin')") &&
    source.includes("r.includes('berberine')") &&
    source.includes("r.includes('ginkgo')") &&
    source.includes("r.includes('nac')") &&
    source.includes("r.includes('n-acetyl')") &&
    source.includes("s.includes('turmeric')") &&
    source.includes("s.includes('curcumin')") &&
    source.includes("s.includes('berberine')") &&
    source.includes("s.includes('ginkgo')") &&
    source.includes("s.includes('nac')") &&
    source.includes("s.includes('n-acetyl')"),
  'server should detect turmeric/curcumin, berberine, ginkgo biloba, and NAC (N-acetyl cysteine) as supplements in both scan-time _hasSupplements and coach pre-scan supplements detection — popular hair-health community supplements that should be recognized so users are not told they have no supplement stack when they use these'
);

assert(
  source.includes("r.includes('pronexa')") &&
    source.includes("s.includes('pronexa')"),
  'server should detect Pronexa (popular caffeine + saw palmetto DHT-blocking shampoo) as a DHT-blocking shampoo in both scan-time _hasDHTShampoo and coach pre-scan dhtShampoo detection — users who list Pronexa should not be told to add a DHT-blocking shampoo they already have'
);

assert(
  source.includes("r.includes('coq10')") &&
    source.includes("r.includes('coenzyme q')") &&
    source.includes("r.includes('l-carnitine')") &&
    source.includes("r.includes('quercetin')") &&
    source.includes("r.includes('melatonin')") &&
    source.includes("s.includes('coq10')") &&
    source.includes("s.includes('coenzyme q')") &&
    source.includes("s.includes('l-carnitine')") &&
    source.includes("s.includes('quercetin')") &&
    source.includes("s.includes('melatonin')"),
  'server should detect CoQ10, L-carnitine, quercetin, and melatonin as supplements in both scan-time _hasSupplements and coach pre-scan supplements detection — these are popular hair-health community supplements that users frequently log alongside their main protocol'
);

assert(
  source.includes("r.includes('hims')") &&
    source.includes("r.includes('keeps')") &&
    source.includes("s.includes('hims')") &&
    source.includes("s.includes('keeps')"),
  'server should detect Hims and Keeps (popular US telehealth hair loss platforms) as topical minoxidil treatment in both scan-time _hasMinoxidil and coach pre-scan topical detection — users who list "hims" or "keeps" in their routine are on the platform\'s primary topical product and should not be told minoxidil is NOT STARTED'
);

assert(
  source.includes("r.includes('spectral')") &&
    source.includes("r.includes('forhers')") &&
    source.includes("r.includes('alopexy')") &&
    source.includes("s.includes('spectral')") &&
    source.includes("s.includes('forhers')") &&
    source.includes("s.includes('alopexy')"),
  'server should detect Spectral DNC (DS Laboratories), For Hers, and Alopexy as topical minoxidil treatment in both scan-time _hasMinoxidil and coach pre-scan topical detection — users who list these brands in their routine should not be told topical minoxidil is NOT STARTED'
);

assert(
  source.includes("r.includes('sunetics')") &&
    source.includes("s.includes('sunetics')"),
  'server should detect Sunetics (clinical LLLT brand used in salons and trichology clinics) as an LLLT device in both scan-time _hasLLLT/_hasMassage and coach pre-scan lllt/mechanical detection — Sunetics users should receive LLLT-aware timing advice rather than being told they have no mechanical stimulation'
);

assert(
  source.includes("r.includes('olly')") &&
    source.includes("s.includes('olly')"),
  'server should detect Olly (popular US gummy supplement brand with hair vitamins — Olly Heavenly Hair) as a supplement in both scan-time _hasSupplements and coach pre-scan supplements detection — users who list Olly should not be told they have no supplement stack'
);

assert(
  source.includes("typeof message !== 'string' || !message.trim()") &&
    source.includes("message required (must be a non-empty string)"),
  'coach should reject whitespace-only or non-string messages with a 400 rather than pay OpenAI tokens for a nonsensical reply'
);

assert(
  source.includes("history.slice(-10).filter((m) => m && typeof m === 'object' && String(m.content ?? \'\').trim())") &&
    source.includes("content: String(m.content).slice(0, 1500)") &&
    source.includes("message.trim().slice(0, 1500)"),
  'coach should filter null/non-object/empty-content history items before mapping to prevent crashes on malformed client input and avoid sending empty messages to OpenAI'
);

assert(
  source.includes('• NW2, under 30: 80-92') &&
    source.includes('• NW2, age 30-50: 74-86') &&
    source.includes('• NW2, over 50: 65-78') &&
    source.includes('NW2 → apply the 30-50 range'),
  'scan potential score guidance should have three NW2 age bands (under 30 / 30-50 / over 50) matching the NW3/NW3v/NW4 age-stratification pattern — NW2 users in their 20s have dramatically higher treatment response potential than users in their 50s; a combined NW1-NW2 any-age band loses this clinically important distinction'
);

assert(
  source.includes("profile.routine.length > 0") &&
    source.includes("Treatment is active — rescan in") &&
    source.includes("Identify the root cause first: book a workup (ferritin, thyroid, hormones)") &&
    source.includes("Hormonal workup is step one: ferritin, thyroid, hormone panel"),
  'nextCheckInReason for diffuse and n/a (female) should be routine-aware: users with an active routine get a "treatment is active — measure response" message; users without a routine get the workup-first message'
);

assert(
  source.includes('noAntiandrogenAtModerateStage') &&
    source.includes('finasteride|dutasteride|propecia|proscar|avodart|spironolactone') &&
    source.includes('bicalutamide|flutamide|cyproterone|androcur') &&
    source.includes('clascoterone|winlevi') &&
    source.includes('aldactone') &&
    source.includes('casodex') &&
    source.includes('(STAGE_SEVERITY_INDEX[stage] ?? 0) >= 3 && !_hasAntiandrogen'),
  'riskFactorFlags should include noAntiandrogenAtModerateStage flag that fires at NW3+/diffuse/female when no antiandrogen is in the routine — allows iOS app to surface targeted antiandrogen CTAs without parsing treatment text; _hasAntiandrogen must detect brand names aldactone (spironolactone), casodex (bicalutamide), and clascoterone/winlevi (Winlevi) so users on these Rx drugs do not incorrectly receive the noAntiandrogenAtModerateStage flag'
);

assert(
  source.includes('noMinoxidilAtActiveStage') &&
    source.includes('(STAGE_SEVERITY_INDEX[stage] ?? 0) >= 2 && !data.protocolCoverage.topical && !data.protocolCoverage.oralMinoxidil'),
  'riskFactorFlags should include noMinoxidilAtActiveStage flag that fires at NW2+ when neither topical nor oral minoxidil is in the routine — users on oral minoxidil (Loniten/LDOM) must not receive false "add minoxidil" CTAs since oral minoxidil IS a vasodilator equivalent'
);

assert(
  source.includes('noScalpStimulationAtActiveStage') &&
    source.includes('(STAGE_SEVERITY_INDEX[stage] ?? 0) >= 3 && !data.protocolCoverage.mechanical'),
  'riskFactorFlags should include noScalpStimulationAtActiveStage flag that fires at NW3+ when no scalp massage, microneedling, or LLLT is in the routine — allows iOS app to surface targeted mechanical-stimulation CTAs for established-AGA users missing this evidence-backed absorption-amplifying layer'
);

assert(
  source.includes('noDHTShampooAtActiveStage') &&
    source.includes('(STAGE_SEVERITY_INDEX[stage] ?? 0) >= 2 && !data.protocolCoverage.dhtShampoo'),
  'riskFactorFlags should include noDHTShampooAtActiveStage flag that fires at NW2+ when no DHT-blocking shampoo (ketoconazole, Nizoral, rosemary-oil shampoo) is in the routine — allows iOS app to surface targeted DHT-shampoo CTAs for users at active loss stages missing this lowest-cost OTC adjunct layer'
);

assert(
  source.includes('noSupplementsAtActiveStage') &&
    source.includes('(STAGE_SEVERITY_INDEX[stage] ?? 0) >= 2 && !data.protocolCoverage.supplements'),
  'riskFactorFlags should include noSupplementsAtActiveStage flag that fires at NW2+ when no nutritional supplements (biotin, zinc, vitamin D, saw palmetto, Nutrafol, etc.) are in the routine — allows iOS app to surface targeted supplement CTAs for users at active loss stages missing this lowest-barrier foundational nutritional layer'
);

assert(
  source.includes("_rff?.untreated") &&
    source.includes("haven't started any treatment yet") &&
    source.includes('Priority: highStress / poorSleep (reversible, highest urgency) → untreated (no protocol at active stage) → earlyOnset → familyHistoryHighRisk →') &&
    source.includes('noAntiandrogenAtModerateStage'),
  'slot-2 coach question override should handle the untreated riskFactorFlag — when a user at NW2+ has no treatment at all, the third suggested question chip should ask where to start, surfaced between poorSleep and earlyOnset in priority order'
);

assert(
  source.includes("_rff?.noAntiandrogenAtModerateStage") &&
    source.includes("OTC treatment — is it time to talk to a doctor about finasteride or dutasteride"),
  'slot-2 coach question override should surface an Rx-upgrade question chip for users at NW3+ on OTC-only protocols (noAntiandrogenAtModerateStage flag set) — guides users toward a doctor consultation at the clinically appropriate threshold'
);

assert(
  source.includes("reqPath === '/api/version'") &&
    source.includes('nodeVersion: process.version') &&
    source.includes('startedAt: new Date(SERVER_START_MS).toISOString()') &&
    source.includes("RAILWAY_DEPLOYMENT_ID") &&
    source.includes("RAILWAY_GIT_BRANCH") &&
    source.includes("RAILWAY_GIT_COMMIT_MESSAGE"),
  '/api/version should return enriched deploy metadata (nodeVersion, startedAt, uptimeSeconds, and Railway deploymentId/branch/commitMessage when available) so a live pod can be correlated to a specific deploy without the Railway dashboard'
);

assert(
  source.includes('Wet hair / styling product calibration from above') &&
    source.includes('8-15 points lower than the actual underlying follicle coverage') &&
    source.includes('follicle group distribution across the vertex region') &&
    source.includes('same artifact affects crown coverage assessment in overhead shots'),
  'crown score should include wet-hair calibration so overhead photos taken post-shower or with product-heavy clumping do not produce artificially low crown scores — symmetric with the wet-hair calibration already present in density and health scoring'
);

assert(
  source.includes("prp: `") &&
    source.includes('amber-tinted PRP vial') &&
    source.includes('PRP (platelet-rich plasma) injections are a clinical procedure'),
  'ADVICE_VISUAL_PROMPTS should include a prp kind (matching the PRP protocol coverage layer) and the coach constraint should require specialist consultation before starting PRP injections'
);

assert(
  source.includes("transplant: `") &&
    source.includes('successful hair graft integration') &&
    source.includes('anagen regrowth'),
  'ADVICE_VISUAL_PROMPTS should include a transplant kind so post-transplant users get a graft-care visual instead of a generic consultation card'
);

assert(
  source.includes("hair transplant / FUE/FUT/DHI (post-op") &&
    source.includes('grafts shed at weeks 4') &&
    source.includes('native follicles continue to miniaturize post-surgery unless DHT is suppressed'),
  'protocolStatusLine should surface transplant context when pc.transplant is true — giving the coach explicit post-op graft-care constraints and native-follicle miniaturization warning'
);

assert(
  source.includes('const { topical, dhtShampoo, supplements, mechanical, microneedling, lllt, transplant } = data.protocolCoverage') &&
    source.includes("if (transplant) {") &&
    source.includes("return [...missing.slice(0, 2), 'transplant']"),
  'suggestedAdviceVisuals should surface the transplant visual as the third card for post-transplant users instead of consultation — they have already had surgery and need graft-care context'
);

assert(
  source.includes("data.detectedConditions = _conds") &&
    source.includes("_pnL.includes('frontal fibrosing')") &&
    source.includes("_pnL.includes('lichen planopilaris')") &&
    source.includes("_pnL.includes('alopecia areata')") &&
    source.includes("_pnL.includes('seborrheic dermatitis')") &&
    source.includes("_pnL.includes('scalp psoriasis')") &&
    source.includes("_pnL.includes('postpartum te')") &&
    source.includes("_pnL.includes('treatment-induced te')") &&
    source.includes("_pnL.includes('seasonal')"),
  'scan should populate detectedConditions array from photoNote text — machine-readable list of non-AGA conditions for the iOS app to react to without parsing text'
);

assert(
  source.includes("_dc.includes('seasonal_te')") &&
    source.includes("seasonal shedding as a possible factor — is this normal and should I change my routine"),
  'coachSuggestedQuestions should override Q1 with a seasonal-shedding question when seasonal_te is detected — completing the TE reassurance priority chain (postpartum > tx-onset > seasonal)'
);

assert(
  source.includes("_dc.includes('seasonal_te')") &&
    source.includes("Late-summer shedding is often seasonal photoperiod TE"),
  'weeklyFocus should override to seasonal-TE reassurance message when seasonal_te is detected — parallel to treatment_induced_te and postpartum_te overrides'
);

assert(
  source.includes("detectedConditions.includes('seasonal_te') && data.checkInIntervalDays > 42"),
  'checkInIntervalDays should be capped at 42 days when seasonal_te is detected — aligns with scan prompt "rescan in 6–8 weeks" guidance for self-limiting seasonal shedding'
);

assert(
  source.includes("transplant:    r.some((s) => s.includes('transplant') || s.includes('hair graft') || s.includes('graft') || s.includes('dhi') || (s.includes('fue') && !s.includes('fuel')) || (s.includes('fut') && !s.includes('future') && !s.includes('futile') && !s.includes('futuristic'))) || !!(pc?.transplant)"),
  'coachProtocolCoverage routine-derived branch should include transplant detection so post-transplant users with other routine items retain their transplant flag and the coach protocolStatusLine can surface post-op graft-care context'
);

assert(
  source.includes('Treatment-induced TE handling:') &&
    source.includes('treatment_induced_te condition flag') &&
    source.includes('minoxidil-onset TE') &&
    source.includes('finasteride-onset TE') &&
    source.includes('dutasteride-onset TE') &&
    source.includes('stopping treatment at the first sign of shedding is the single most common treatment error') &&
    source.includes('5–7 before the hair cycle fully restabilizes'),
  'coach system prompt should include a dedicated treatment-induced TE handling paragraph (parallel to postpartum TE and seasonal TE) with drug-specific timeframes (minoxidil: 1-3 months, finasteride: 3-4 months, dutasteride: 5-7 months) and strong reassurance against stopping treatment — completing the TE reassurance trilogy in the coach prompt'
);

assert(
  source.includes('Spironolactone-onset TE:') &&
    source.includes('spiro blocks androgen receptors rather than suppressing DHT production') &&
    source.includes('resolves by month 3–5') &&
    source.includes('minoxidil, finasteride, dutasteride, spironolactone, bicalutamide, flutamide, cyproterone, or androcur AND their onset was within the past 6 months'),
  'coach treatment-induced TE handling should include spironolactone-onset TE (parallel to minoxidil/finasteride/dutasteride) with a 3-5 month timeframe and explanation that spiro blocks androgen receptors (not DHT suppression), completing the drug-specific timeframe coverage added alongside the scan spironolactone-TE calibration'
);

assert(
  source.includes('Bicalutamide/flutamide/cyproterone-onset TE:') &&
    source.includes('flutamide and cyproterone — month 2–4') &&
    source.includes('bicalutamide — month 3–5') &&
    source.includes('minoxidil, finasteride, dutasteride, spironolactone, bicalutamide, flutamide, cyproterone, or androcur AND their onset was within the past 6 months'),
  'coach treatment-induced TE trigger condition should include bicalutamide, flutamide, cyproterone, and androcur so the coach applies TE reassurance for these antiandrogens even without a scan (or when scan TE detection was not triggered) — completing the drug-specific TE coverage for full androgen receptor antagonists alongside the existing spiro/finasteride/dutasteride/minoxidil triggers'
);

assert(
  source.includes("'postpill_te'") &&
    source.includes('stopped.{0,15}pill') &&
    source.includes('_isPostPill') &&
    source.includes("!_conds.includes('postpill_te') && !_conds.includes('postpartum_te')"),
  'postpill_te should be detected server-side from profile concerns/timeline when OCP-stopping keywords are present, guarded against postpartum_te already being set (postpartum takes clinical priority)'
);

assert(
  source.includes("detectedConditions.includes('postpill_te') && data.checkInIntervalDays > 42"),
  'checkInIntervalDays should be capped at 42 days when postpill_te is detected — OCP withdrawal TE recovers over 6-12 months; 6-week rescan confirms trajectory'
);

assert(
  source.includes("_dc.includes('postpill_te')") &&
    source.includes('Post-pill shedding is temporary and expected'),
  'weeklyFocus should override to post-pill TE reassurance message when postpill_te is detected — parallel to postpartum_te and seasonal_te overrides'
);

assert(
  source.includes("detectedConditions.includes('postpill_te')") &&
    source.includes('Post-pill shedding is temporary — rescan in 6 weeks'),
  'nextCheckInReason should override to a post-pill TE rescan message when postpill_te is detected — parallel to the other TE nextCheckInReason overrides'
);

assert(
  source.includes('Post-pill TE handling:') &&
    source.includes('postpill_te condition flag') &&
    source.includes('2–4 months after stopping the pill') &&
    source.includes('6–12 months') &&
    source.includes('ferritin') &&
    source.includes('postpill_te → OCP withdrawal TE'),
  'coach system prompt should include a dedicated post-pill TE handling paragraph with reassurance, ferritin guidance, and drug-safety distinction from postpartum TE; detectedConditions mapping should include postpill_te'
);

const _teDrugBlock = source.match(/_hasKnownTEDrug = _profileItems\.some\([\s\S]+?\n            \);/);
assert(
  _teDrugBlock && !_teDrugBlock[0].includes("r.includes('clascoterone')") && !_teDrugBlock[0].includes("r.includes('winlevi')"),
  "server-side _hasKnownTEDrug treatment_induced_te detection must NOT include clascoterone/winlevi — clascoterone (Winlevi) is a topical androgen receptor blocker with <5% systemic absorption; it does not alter serum hormone levels and has no documented systemic-TE mechanism, so including it produces false-positive treatment_induced_te flags for acne patients on Winlevi; the coach prompt also has no clascoterone-onset TE handling, making any flagged condition an orphan"
);

assert(
  source.includes("r.includes('ru58841')") &&
    source.includes("r.includes('ru 58841')") &&
    source.includes("r.includes('pyrilutamide')") &&
    source.includes("r.includes('kx-826')") &&
    source.includes("s.includes('ru58841')") &&
    source.includes("s.includes('ru 58841')") &&
    source.includes("s.includes('pyrilutamide')") &&
    source.includes("s.includes('kx-826')"),
  'server should detect RU58841 (both spacing variants), pyrilutamide, and KX-826 as Rx antiandrogens in both scan-time _hasFinasteride and coach pre-scan rx detection — these research/clinical-trial topical antiandrogens are widely used in the hair loss community; detecting them as rx ensures users on these compounds are not incorrectly shown as lacking Rx treatment'
);

assert(
  source.includes("r.includes('profollica')") &&
    source.includes("s.includes('profollica')"),
  'server should detect Profollica (anti-DHT hair supplement containing saw palmetto, biotin, and millet seed extract, marketed specifically for male hair loss) as a supplement in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('jarrow')") &&
    source.includes("s.includes('jarrow')"),
  'server should detect Jarrow Formulas (popular US supplement brand known for biotin, B-vitamins, and collagen — commonly used by hair loss patients) as a supplement in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('solgar')") &&
    source.includes("s.includes('solgar')"),
  'server should detect Solgar (premium supplement brand frequently used for hair-growth micronutrients: biotin, keratin, folate, zinc) as a supplement in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('garden of life')") &&
    source.includes("s.includes('garden of life')"),
  'server should detect Garden of Life (whole-food supplement brand with popular hair/skin/nails and prenatal vitamin lines used by patients with TE) as a supplement in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('kerotin')") &&
    source.includes("s.includes('kerotin')"),
  'server should detect Kerotin (hair growth supplement brand sold on Amazon, contains biotin and key micronutrients) as a supplement in both scan-time _hasSupplements and coach pre-scan supplements detection'
);

assert(
  source.includes("r.includes('natures bounty')") &&
    source.includes("s.includes('natures bounty')"),
  "server should detect 'natures bounty' (Nature's Bounty brand, one of the largest OTC supplement manufacturers; users frequently take their Hair, Skin & Nails vitamins or Optimal Solutions Hair supplement) as a supplement in both scan-time _hasSupplements and coach pre-scan supplements detection"
);

assert(
  source.includes('low vitamin d') &&
    source.includes('vit') && source.includes('d deficien') &&
    source.includes('low vit') &&
    source.includes('b') && source.includes('12 deficien') &&
    source.includes('low b') && source.includes('12|') &&
    source.includes('zinc deficien') &&
    source.includes('low zinc') &&
    source.includes('deficien.{0,15}iron'),
  'nutritional_te detection should cover low vitamin D, vit D shorthand, B12 deficiency, zinc deficiency, and reversed phrasings like "deficiency in iron"'
);

console.log('server contract passed');
