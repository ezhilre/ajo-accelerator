/**
 * agents/scoring-agent.js — Agent 2: Journey Scorer
 *
 * Responsibilities:
 *   1. Build a rich scoring prompt from journey metadata + flow + resolved audiences
 *   2. Call LLM via Ollama and parse structured JSON response
 *
 * Exports:
 *   scoreJourney(journey, resolvedAudiences) → Promise<{ parsed, rawText, promptTokens, completionTokens }>
 *   buildPrompt(journey, resolvedAudiences)  → string  (exported for testing/logging)
 */

'use strict';

const { callOllama, extractJson }       = require('../lib/queue');
const { buildAudienceDefinitionsBlock } = require('./audience-agent');
const {
  extractNodes, extractChannelSummary, extractAudienceNames,
  extractTriggerInfo, buildFlowPath, buildAudienceSummary,
  buildJourneyStructure, buildOperationalSignals,
  inferJourneyTypeFromName, preClassifyJourney, deriveIntentLayer,
} = require('../lib/journey-analyzer');
const { log } = require('../lib/logger');

// ── buildPrompt() ─────────────────────────────────────────────────────────────
function buildPrompt(journey, resolvedAudiences) {
  const meta     = journey.metadata || {};
  const name     = journey.name || '(unnamed)';
  const status   = (journey.status || 'unknown').toLowerCase();
  const version  = journey.version || '1';
  const daysStale = journey._daysStale || 0;

  const createdBy      = meta.createdBy      || 'unknown';
  const createdAt      = meta.createdAt      ? meta.createdAt.slice(0, 10)      : 'unknown';
  const modifiedBy     = meta.lastModifiedBy || 'unknown';
  const modifiedAt     = meta.lastModifiedAt ? meta.lastModifiedAt.slice(0, 10) : 'unknown';
  const lastDeployedBy = meta.lastDeployedBy || '';
  const lastDeployedAt = meta.lastDeployedAt ? meta.lastDeployedAt.slice(0, 10) : '';
  const isDefaultName  = journey._isDefaultName
    ? 'YES — never renamed (strong abandonment signal)' : 'No';

  const journeyApiType = journey.type         || '';
  const sandboxName    = journey.sandboxName  || journey.sandbox || '';
  const category       = journey.category     || '';
  const description    = journey.description  || '';

  const sched      = journey.schedule || {};
  const schedStart = (sched.startDate || sched.startTime || sched.start || '').toString().slice(0, 10);
  const schedEnd   = (sched.endDate   || sched.endTime   || sched.end   || '').toString().slice(0, 10);
  const schedTz    = sched.timezone || sched.timeZone || journey.timeZone || '';
  const schedLine  = [
    schedStart ? `starts ${schedStart}` : '',
    schedEnd   ? `ends ${schedEnd}`     : '',
    schedTz    ? `tz: ${schedTz}`       : '',
  ].filter(Boolean).join(', ') || 'none / unknown';

  const reentrance  = journey.reentrance || {};
  const reentPolicy = reentrance.policy || '';
  const reentDur    = reentrance.durationInSecs != null ? `${reentrance.durationInSecs}s window` : '';
  const reentLine   = reentPolicy ? `${reentPolicy}${reentDur ? ' (' + reentDur + ')' : ''}` : 'none / unknown';

  const exitArr  = Array.isArray(journey.exitCriteria)
    ? journey.exitCriteria : (journey.exitCriteria ? [journey.exitCriteria] : []);
  const exitLine = exitArr.length
    ? exitArr.map((x) => x.type || x.condition || JSON.stringify(x)).join('; ')
    : 'none';

  const rawTags  = journey.tags || [];
  const tagNames = rawTags
    .map((t) => (typeof t === 'string' ? t : (t.name || t.label || t.title || '').trim()))
    .filter(Boolean);

  const { actions, events, conditions, allNodes } = extractNodes(journey);
  const channelCounts = extractChannelSummary(actions);
  const {
    emailCount, smsCount, pushCount, inAppCount, contentCardCount,
    directMailCount, webCount, codeBasedCount, timerCount, customCount,
  } = channelCounts;

  const audienceId = journey.audienceId || journey.segmentId || journey.segment?.id
    || (events.find((e) => e.segmentId || e.audienceId) || {}).segmentId
    || (events.find((e) => e.segmentId || e.audienceId) || {}).audienceId || '';

  const allForAudience = allNodes.length ? allNodes : [...actions, ...events, ...conditions];
  const audienceNames  = extractAudienceNames(allForAudience);
  const triggerInfo    = extractTriggerInfo(events);

  const { flowText, maxDepth } = buildFlowPath(journey);

  const audienceSummary    = buildAudienceSummary(events, conditions, audienceNames, audienceId, triggerInfo);
  const journeyStructure   = buildJourneyStructure(
    actions, events, conditions, channelCounts, audienceNames, audienceId, description, maxDepth,
  );
  const operationalSignals = buildOperationalSignals(meta, sched, exitArr, status);

  const conditionNames = conditions.map((c) => c.name || '').filter(Boolean).slice(0, 10);
  const actionNames    = actions.map((a) => a.name || '')
    .filter((nm) => nm && !/^(wait|timer)/i.test(nm)).slice(0, 8);

  const nodeCount = actions.length + events.length + conditions.length;

  const preClass     = preClassifyJourney(name, { actions, events, conditions }, channelCounts, triggerInfo);
  const nameHint     = inferJourneyTypeFromName(name);
  const typeHintLine = preClass
    ? `Pre-classification: "${preClass.type}" (rule confidence: ${preClass.confidence}% — confirm or override based on structure)`
    : (nameHint
      ? `Name-based type hint: "${nameHint}" (weak signal — structure takes precedence)`
      : 'Type hint: unclear');

  const structureNote = nodeCount === 0
    ? 'WARNING: No structural node data from API — rely on name, status, tags, and description.'
    : '';

  const intentLayer = deriveIntentLayer(
    name, actions, conditions, audienceNames, channelCounts, flowText, triggerInfo,
  );

  const audienceDefsBlock = buildAudienceDefinitionsBlock(resolvedAudiences || []);

  // Suppress unused-var lint warnings for channel vars — all used in journeyStructure
  void (emailCount + smsCount + pushCount + inAppCount + contentCardCount
    + directMailCount + webCount + codeBasedCount + timerCount + customCount);

  return `You are a customer lifecycle strategist reviewing an Adobe Journey Optimizer workflow.
Your job is NOT to describe the graph topology — it is to interpret the business intent behind it.
A marketing or product team built this workflow deliberately. Your task is to articulate WHY.

Ask yourself:
  - What customer experience is this workflow trying to create?
  - What specific user behavior is being influenced or triggered?
  - What lifecycle stage does this journey target?
  - What business outcome appears to be intended?
  - Why would a marketing/product team build exactly this workflow?

GOVERNANCE RULES (apply in priority order):
1. INTENT IS PRIMARY. Interpret purpose from flow structure, audience names, condition names, and channel choices.
2. Draft ≠ abandoned. A draft with entry logic + branching + message actions has deliberate business purpose.
3. Staleness influences retirement urgency only — not whether the journey had a legitimate purpose.
4. Name tokens (test/copy/delete/old/v2) are WEAK signals. Strong structural evidence overrides naming completely.
5. If journey has >=1 entry event AND >=1 condition AND >=1 message action → describe the real business intent.
6. Test/POC requires: placeholder name AND trivial structure (<=1 node, no audience logic, no messaging).

WORKFLOW RICHNESS CALIBRATION:
- Rich lifecycle workflow = audience qualification + condition branching + 2+ message actions + timing/wait steps
  → retirementScore MUST be ≤ 35, regardless of draft status or staleness up to 120 days
- Monetization signals (free/paid split, subscription branching, upsell targeting):
  → floor retirementScore at ≤ 25
- Onboarding + activation + app-timing patterns with multiple IAM/push actions:
  → floor retirementScore at ≤ 30

SCORING EXAMPLES:
- Onboarding + free/paid audience split + 4 IAM actions + wait timer + draft + 65d stale
  → retirementScore: 20, lifecycleDecision: "Keep"
- Named journey + rich conditions + email sequence + audience segments + stopped 8 months ago
  → retirementScore: 45, lifecycleDecision: "Review"
- AJO default name + 0 conditions + 0 message actions + 400d stale + no description
  → retirementScore: 92, lifecycleDecision: "Archive"

JOURNEY IDENTITY:
Name: "${name}"
Status: ${status} | Version: ${version} | Days stale: ${daysStale}
Execution type: ${journeyApiType || 'unknown'} (unitary=event-triggered; read_segment=audience-batch)
Created by: ${createdBy} on ${createdAt} | Modified by: ${modifiedBy} on ${modifiedAt}
${lastDeployedBy ? `Deployed by: ${lastDeployedBy} on ${lastDeployedAt}` : ''}
Default AJO name (never renamed): ${isDefaultName}
${sandboxName ? `Sandbox: ${sandboxName}` : ''}${category ? ` | Category: ${category}` : ''}
Tags: ${tagNames.length ? tagNames.join(', ') : 'none'}
${typeHintLine}
${intentLayer ? `\nBUSINESS INTENT SIGNALS (pre-derived — use as context, override if flow contradicts):\n${intentLayer}` : ''}
${audienceDefsBlock ? `\n${audienceDefsBlock}` : ''}

CUSTOMER LIFECYCLE CONTEXT:
Schedule: ${schedLine} | Re-entrance: ${reentLine} | Exit criteria: ${exitLine}

JOURNEY FLOW (primary signal — read this to understand the customer experience being designed):
${flowText || structureNote || '(flow unavailable — no transitions in API response)'}

WORKFLOW STRUCTURE:
${journeyStructure}
${structureNote && !flowText ? '\n' + structureNote : ''}

NODE LABELS:
Entry events: ${events.length} | Message actions: ${actions.length} | Conditions: ${conditions.length}
Action names:    ${actionNames.length ? actionNames.join(' | ') : 'none'}
Condition names: ${conditionNames.length ? conditionNames.join(' | ') : 'none'}

TARGET AUDIENCE:
${audienceSummary}

OPERATIONAL STATE:
${operationalSignals}

Return ONLY valid JSON — no markdown, no explanatory text outside the object.
{
  "journeyType": "Welcome|Promotional|Transactional|Re-engagement|Abandoned Cart|Onboarding|Retention|Test/POC|Unknown",
  "lifecycleStage": "Acquisition|Onboarding|Activation|Retention|Re-engagement|Monetization|Post-purchase|Loyalty|Unknown",
  "customerExperience": "What experience is this workflow creating for the customer? (1 sentence, customer POV)",
  "behaviorTargeted": "What specific user action or behavior is this workflow trying to trigger or influence?",
  "businessObjective": "What measurable business outcome does this workflow appear designed to achieve?",
  "whyTeamBuiltThis": "Why would a marketing/product team build exactly this workflow? (strategic reasoning)",
  "useCaseSummary": "Concise description of what this journey does — synthesizing flow, channels, audience, and timing.",
  "targetAudience": "Who it targets — inferred from audience segments, conditions, and entry qualification.",
  "businessValue": "low|medium|high",
  "businessPurpose": "One sentence describing the strategic business process this journey serves.",
  "retirementScore": 0-100,
  "retirementLabel": "Safe to Retire|Review First|Keep Active",
  "confidence": 0-100,
  "reasoning": "2-3 sentences citing specific signals: lifecycle stage, audience segmentation, channel strategy, timing pattern, status, and staleness.",
  "lifecycleDecision": "Keep|Archive|Review",
  "governanceReviewPriority": "low|medium|high",
  "recommendation": "Archive|Review with owner|Keep|Contact owner before deleting"
}`;
}

// ── scoreJourney() ─────────────────────────────────────────────────────────────
/**
 * Run Agent 2: build prompt, call LLM, parse response.
 *
 * @param {object} journey           - enriched journey (with _daysStale, _isDefaultName)
 * @param {Array}  resolvedAudiences - output from Agent 1 (may be empty)
 * @param {number} retryCount        - number of previous attempts (0 = first attempt)
 *                                     When > 0, a strict JSON-only suffix is appended to the
 *                                     prompt to nudge the LLM away from conversational output.
 * @returns {Promise<{ parsed, rawText, promptTokens, completionTokens, prompt }>}
 */
async function scoreJourney(journey, resolvedAudiences, retryCount = 0) {
  const id          = journey.id || 'unknown';
  const basePrompt  = buildPrompt(journey, resolvedAudiences);

  // On retry: append a strict reminder that forces JSON-only output.
  // Local Ollama models sometimes respond conversationally on the first attempt.
  const retrySuffix = retryCount > 0
    ? `\n\n--- IMPORTANT (retry attempt ${retryCount}) ---\nYour previous response was not valid JSON.\nYou MUST respond with ONLY a raw JSON object.\nDo NOT include any explanation, preamble, markdown formatting, or code fences.\nStart your response directly with { and end with }.\nNo other text is permitted outside the JSON object.`
    : '';

  const prompt = basePrompt + retrySuffix;

  log('info', '🎯 Agent 2 — scoring journey', {
    id, name: (journey.name || '').slice(0, 40), status: journey.status,
  });

  const { text: rawText, promptTokens, completionTokens } = await callOllama(prompt, id);
  const parsed = extractJson(rawText, id);

  if (!parsed) {
    log('warn', '🎯 Agent 2 — LLM returned non-JSON', { id, raw_preview: rawText.slice(0, 120) });
  } else {
    log('info', '🎯 Agent 2 — scored', {
      id,
      verdict:          parsed.retirementLabel,
      score:            parsed.retirementScore,
      confidence:       parsed.confidence,
      biz_value:        parsed.businessValue,
      prompt_tokens:    promptTokens,
      completion_tokens: completionTokens,
    });
  }

  return { parsed, rawText, promptTokens, completionTokens, prompt };
}

module.exports = { buildPrompt, scoreJourney };
