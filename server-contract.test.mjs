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

console.log('server contract passed');
