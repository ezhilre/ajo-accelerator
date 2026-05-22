/**
 * agents/audience-agent.js — Agent 1: Audience Resolver
 *
 * Responsibilities:
 *   1. Fetch audience definition from Adobe UPS API (server-side, no CORS)
 *   2. Normalize PQL/AST expression → clean intermediate JSON (pure JS)
 *   3. Call LLM once per audience → plain-English description for business users
 *
 * Exports:
 *   resolveJourneyAudiences(audiences, cfg)  → Promise<Array<ResolvedAudience>>
 *   buildAudienceDefinitionsBlock(resolved)  → string (for injection into scoring prompt)
 */

'use strict';

const { callOllama }                  = require('../lib/queue');
const { normalizeAudienceExpression } = require('../lib/expression-parser');
const { log }                         = require('../lib/logger');

const ADOBE_UPS_BASE = process.env.ADOBE_UPS_BASE || 'https://platform.adobe.io/data/core/ups';
const ADOBE_TOKEN    = process.env.ADOBE_TOKEN    || '';
const ADOBE_API_KEY  = process.env.ADOBE_API_KEY  || '';
const ADOBE_ORG_ID   = process.env.ADOBE_ORG_ID   || '';
const ADOBE_SANDBOX  = process.env.ADOBE_SANDBOX  || '';

// ── fetchAudienceDetail() ─────────────────────────────────────────────────────
/**
 * Fetch a single audience from the Adobe UPS Segmentation API.
 * Credentials resolved from: request cfg → env vars (in that priority order).
 */
async function fetchAudienceDetail(audienceId, cfg) {
  const token   = (cfg && cfg.token)   || ADOBE_TOKEN;
  const apiKey  = (cfg && cfg.apiKey)  || ADOBE_API_KEY;
  const orgId   = (cfg && cfg.orgId)   || ADOBE_ORG_ID;
  const sandbox = (cfg && cfg.sandbox) || ADOBE_SANDBOX;

  if (!token || !apiKey || !orgId) {
    throw new Error('Missing Adobe credentials (token / apiKey / orgId)');
  }

  const url  = `${ADOBE_UPS_BASE}/audiences/${audienceId}`;
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 15_000);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization:    `Bearer ${token}`,
        'x-api-key':      apiKey,
        'x-gw-ims-org-id': orgId,
        'x-sandbox-name': sandbox,
        'Content-Type':   'application/json',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Adobe UPS HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// ── audienceToPlainEnglish() ──────────────────────────────────────────────────
/**
 * Call LLM to convert a normalized audience rule JSON into one plain-English sentence.
 * Returns { plainEnglish, prompt, raw, error? }
 */
async function audienceToPlainEnglish(normalized, audienceName, audienceId) {
  const prompt = `You are a marketing analyst. Convert the following audience rule JSON into a clear, concise description in plain English for a business user. Do NOT describe the JSON structure — describe WHO qualifies for this audience and WHY.

Audience name: "${audienceName}"

Normalized audience rule:
${JSON.stringify(normalized, null, 2)}

Requirements:
- Write 1–3 sentences maximum.
- Focus on the business meaning: who the person is, what they did, and any qualifying attributes.
- Use plain language (no technical field names like "_adobe_corpnew.aviProgramV2").
- Map field path segments to readable terms (e.g. "geo" → region, "fireflyOwnershipFlag" → Firefly product ownership).
- IMPORTANT: If the rule explicitly lists named values (e.g. store names, product codes, language codes, regions), you MUST enumerate them by name — do NOT collapse them into a generic phrase. For example, if the rule excludes ["APPLE_IOS", "Apple App Store", "GOOGLE", "GOOGLEPLAYSTORE", "Google Play", "SAMSUNG", "Samsung App Store"], write "excluding subscribers from Apple App Store, Google Play, and Samsung App Store" — NOT "non-app-store channel".
- IMPORTANT: If the rule includes a "notEqualTo" or exclusion condition on a list of values, always name those values explicitly in the description.

Plain English description:`;

  try {
    const { text } = await callOllama(prompt, audienceId);
    const plainEnglish = text.trim()
      .replace(/^(plain english description:|description:|answer:)\s*/i, '')
      .trim();
    return { plainEnglish, prompt, raw: text };
  } catch (e) {
    log('warn', '🎭 Audience LLM call failed', { audienceId, error: e.message });
    return { plainEnglish: null, prompt, raw: null, error: e.message };
  }
}

// ── resolveOneAudience() ──────────────────────────────────────────────────────
/**
 * Full pipeline for a single audience: fetch → normalize → LLM plain English.
 * Always returns a result object (never throws) — errors are captured in result.error.
 *
 * @returns {Promise<ResolvedAudience>}
 */
async function resolveOneAudience(audience, cfg) {
  const { id, name } = audience;
  const start  = Date.now();
  const result = {
    id, name,
    apiStatus:    'pending',
    durationMs:   0,
    normalized:   null,
    plainEnglish: null,
    llmPrompt:    null,
    llmRaw:       null,
    error:        null,
  };

  // Step 1: fetch from Adobe UPS
  let audienceData = null;
  try {
    audienceData     = await fetchAudienceDetail(id, cfg);
    result.apiStatus = 'resolved';
    log('info', '🎭 Audience fetched', { id, name: (name || '').slice(0, 50) });
  } catch (e) {
    result.apiStatus  = 'fetch-failed';
    result.error      = e.message;
    result.durationMs = Date.now() - start;
    log('warn', '🎭 Audience fetch failed', { id, error: e.message });
    return result;
  }

  // Step 2: normalize expression (pure JS — deterministic, no LLM)
  const expressionData = audienceData.expression || audienceData.segmentExpression || null;
  if (expressionData) {
    try {
      result.normalized = normalizeAudienceExpression(expressionData);
    } catch (e) {
      log('warn', '🎭 Audience expression normalize failed', { id, error: e.message });
    }
  }

  // Step 3: LLM → plain English (only if normalized data is available)
  if (result.normalized) {
    const llmResult   = await audienceToPlainEnglish(result.normalized, name, id);
    result.plainEnglish = llmResult.plainEnglish;
    result.llmPrompt    = llmResult.prompt;
    result.llmRaw       = llmResult.raw;
    if (llmResult.error) {
      result.error = (result.error ? result.error + '; ' : '') + 'LLM: ' + llmResult.error;
    }
  } else {
    // No expression to parse — fall back to raw audience name
    log('info', '🎭 Audience has no parseable expression — skipping LLM', { id });
    result.plainEnglish = name || null;
  }

  result.durationMs = Date.now() - start;
  log('info', '🎭 Audience resolved', {
    id, duration_ms: result.durationMs, has_plain_english: !!result.plainEnglish,
  });
  return result;
}

// ── resolveJourneyAudiences() ─────────────────────────────────────────────────
/**
 * Resolve all audiences for a journey.
 * Runs up to 3 concurrently; never throws — individual failures are captured per-audience.
 *
 * @param {Array<{id:string, name:string}>} audiences
 * @param {object} cfg — Adobe credentials { token, apiKey, orgId, sandbox }
 * @returns {Promise<ResolvedAudience[]>}
 */
async function resolveJourneyAudiences(audiences, cfg) {
  if (!Array.isArray(audiences) || !audiences.length) return [];
  if (!cfg || !cfg.token) {
    log('debug', '🎭 Audience resolution skipped — no Adobe credentials provided');
    return [];
  }

  const BATCH = 3;
  const results = [];
  for (let i = 0; i < audiences.length; i += BATCH) {
    const batch = audiences.slice(i, i + BATCH);
    // eslint-disable-next-line no-await-in-loop
    const batchResults = await Promise.all(batch.map((a) => resolveOneAudience(a, cfg)));
    results.push(...batchResults);
  }
  return results;
}

// ── buildAudienceDefinitionsBlock() ──────────────────────────────────────────
/**
 * Format resolved audiences as a prompt block for Agent 2 (Journey Scorer).
 * Returns null if no audiences provided.
 */
function buildAudienceDefinitionsBlock(resolvedAudiences) {
  if (!resolvedAudiences || !resolvedAudiences.length) return null;

  const lines = ['AUDIENCE DEFINITIONS (resolved from Adobe UPS API):'];
  resolvedAudiences.forEach((a, i) => {
    const statusSuffix = a.apiStatus === 'resolved' ? '' : ` [${a.apiStatus}]`;
    lines.push(`  [${i + 1}] "${a.name}"${statusSuffix}`);
    if (a.plainEnglish) {
      lines.push(`       → ${a.plainEnglish}`);
    } else if (a.error) {
      lines.push(`       → (could not resolve: ${a.error})`);
    } else {
      lines.push(`       → (no expression data available)`);
    }
  });
  return lines.join('\n');
}

module.exports = {
  resolveJourneyAudiences,
  buildAudienceDefinitionsBlock,
  fetchAudienceDetail,           // exported for /audience/resolve route
  ADOBE_UPS_BASE,
  ADOBE_TOKEN,
  ADOBE_API_KEY,
  ADOBE_ORG_ID,
  ADOBE_SANDBOX,
};
