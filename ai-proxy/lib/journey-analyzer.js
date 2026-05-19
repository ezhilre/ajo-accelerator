/**
 * lib/journey-analyzer.js — Journey canvas node extraction, flow path builder,
 * channel summarizer, audience extractor, and business intent layer deriver.
 *
 * All functions are pure/deterministic — no LLM calls, no side effects.
 */

'use strict';

const { log } = require('./logger');

// ── Node type matchers ────────────────────────────────────────────────────────
const EVENT_TYPES = /^(unitary_event|read_segment|audience_entry|event|trigger|audience|entry|segment)/i;
const COND_TYPES  = /^condition/i;
const END_TYPES   = /^end$/i;

// ── extractNodes() ────────────────────────────────────────────────────────────
/**
 * Extract actions / events / conditions from a journey object.
 * Handles flat arrays (pre-flattened by detail endpoint) and canvas.nodes.
 */
function extractNodes(journey) {
  if (
    (journey.actions    && journey.actions.length)
    || (journey.events  && journey.events.length)
    || (journey.conditions && journey.conditions.length)
  ) {
    return {
      actions:    journey.actions    || [],
      events:     journey.events     || [],
      conditions: journey.conditions || [],
      allNodes:   [],
    };
  }

  let rawNodes = [];
  if (Array.isArray(journey.canvas?.nodes) && journey.canvas.nodes.length) {
    rawNodes = journey.canvas.nodes;
  } else if (Array.isArray(journey.nodes) && journey.nodes.length) {
    rawNodes = journey.nodes;
  } else if (journey.canvas?.nodes && typeof journey.canvas.nodes === 'object') {
    rawNodes = Object.values(journey.canvas.nodes);
  }

  if (rawNodes.length) {
    const typeOf     = (nd) => (nd.type || nd.nodeType || nd.actionType || nd.eventType || '').toLowerCase();
    const nonEnd     = rawNodes.filter((nd) => !END_TYPES.test(typeOf(nd)));
    const events     = nonEnd.filter((nd) => EVENT_TYPES.test(typeOf(nd)));
    const conditions = nonEnd.filter((nd) => COND_TYPES.test(typeOf(nd)));
    const actions    = nonEnd.filter((nd) => !EVENT_TYPES.test(typeOf(nd)) && !COND_TYPES.test(typeOf(nd)));
    log('debug', '🗂 Canvas nodes extracted', {
      total: rawNodes.length, non_end: nonEnd.length,
      actions: actions.length, events: events.length, conditions: conditions.length,
    });
    return { actions, events, conditions, allNodes: rawNodes };
  }

  return { actions: [], events: [], conditions: [], allNodes: [] };
}

// ── extractChannelSummary() ───────────────────────────────────────────────────
function extractChannelSummary(actions) {
  const typeOf = (nd) => (nd.type || nd.nodeType || nd.actionType || '').toLowerCase();
  return {
    emailCount:       actions.filter((a) => /email_message|^email$/i.test(typeOf(a))).length,
    smsCount:         actions.filter((a) => /\bsms\b/i.test(typeOf(a))).length,
    pushCount:        actions.filter((a) => /\bpush\b/i.test(typeOf(a))).length,
    inAppCount:       actions.filter((a) => /inapp|in.app|\biam\b/i.test(typeOf(a))).length,
    contentCardCount: actions.filter((a) => /content.?card/i.test(typeOf(a))).length,
    directMailCount:  actions.filter((a) => /direct.?mail/i.test(typeOf(a))).length,
    webCount:         actions.filter((a) => /web.?action|\bweb\b/i.test(typeOf(a))).length,
    codeBasedCount:   actions.filter((a) => /code.?based/i.test(typeOf(a))).length,
    timerCount:       actions.filter((a) => /\btimer\b|\bwait\b/i.test(typeOf(a))).length,
    customCount:      actions.filter((a) => /custom_action|\bcustom\b/i.test(typeOf(a))).length,
  };
}

// ── extractAudienceNames() ────────────────────────────────────────────────────
function extractAudienceNames(nodes) {
  const names = new Set();
  nodes.forEach((node) => {
    (node.transitions || []).forEach((t) => {
      if (t.expression) {
        for (const m of t.expression.matchAll(/inAudience\(["']([^"']+)["']\)/gi)) names.add(m[1]);
      }
    });
    if (node.expression) {
      for (const m of node.expression.matchAll(/inAudience\(["']([^"']+)["']\)/gi)) names.add(m[1]);
    }
  });
  return [...names];
}

// ── extractTriggerInfo() ──────────────────────────────────────────────────────
function extractTriggerInfo(events) {
  if (!events.length) return null;
  const trigger = events[0];
  const type    = (trigger.type || trigger.nodeType || '').toLowerCase();
  const name    = trigger.name || '';
  if (type === 'read_segment' || type === 'audience_entry') return `Audience-based (read segment): "${name}"`;
  if (type === 'unitary_event')                             return `Event-triggered (unitary): "${name}"`;
  return `"${name}" (type: ${type})`;
}

// ── buildFlowPath() ───────────────────────────────────────────────────────────
/**
 * BFS-compute max depth + DFS-render a human-readable flow path string.
 * Returns { flowText: string|null, maxDepth: number }.
 */
function buildFlowPath(journey) {
  let rawNodes = [];
  if (Array.isArray(journey.canvas?.nodes) && journey.canvas.nodes.length) {
    rawNodes = journey.canvas.nodes;
  } else if (Array.isArray(journey.nodes) && journey.nodes.length) {
    rawNodes = journey.nodes;
  } else if (journey.canvas?.nodes && typeof journey.canvas.nodes === 'object') {
    rawNodes = Object.values(journey.canvas.nodes);
  }
  if (!rawNodes.length) return { flowText: null, maxDepth: 0 };

  const nodeMap = new Map();
  rawNodes.forEach((nd) => { if (nd.id) nodeMap.set(nd.id, nd); });

  const startId = journey.canvas?.startNodeId
    || rawNodes.find((nd) => EVENT_TYPES.test((nd.type || nd.nodeType || '').toLowerCase()))?.id
    || rawNodes[0]?.id;
  if (!startId) return { flowText: null, maxDepth: 0 };

  // BFS for max depth
  let maxDepth = 0;
  const bfsVisited = new Set();
  const bfsQueue   = [{ id: startId, depth: 0 }];
  while (bfsQueue.length) {
    const { id: curId, depth } = bfsQueue.shift();
    if (bfsVisited.has(curId)) continue;
    bfsVisited.add(curId);
    maxDepth = Math.max(maxDepth, depth);
    const nd = nodeMap.get(curId);
    if (!nd) continue;
    const transitions = Array.isArray(nd.transitions) ? nd.transitions : [];
    transitions.forEach((t) => {
      const nextId = t.nextNodeId || t.targetNodeId;
      if (nextId && !bfsVisited.has(nextId)) bfsQueue.push({ id: nextId, depth: depth + 1 });
    });
    if (!transitions.length) {
      const directNext = nd.nextNodeId || nd.targetNodeId;
      if (directNext && !bfsVisited.has(directNext)) bfsQueue.push({ id: directNext, depth: depth + 1 });
    }
  }

  // Human-readable node label
  function nodeLabel(nd) {
    const type = (nd.type || nd.nodeType || nd.actionType || '').toLowerCase();
    const nm   = nd.name || nd.label || '';
    if (EVENT_TYPES.test(type)) {
      const base = (type === 'read_segment' || type === 'audience_entry') ? 'Audience Entry' : 'Event Trigger';
      return nm ? `${base}: ${nm} [entry point]` : `${base} [entry point]`;
    }
    if (COND_TYPES.test(type)) {
      const bc = Array.isArray(nd.transitions) ? nd.transitions.length : 0;
      return nm ? `Condition: ${nm}${bc > 1 ? ` [${bc} branches]` : ''}` : `Condition${bc > 1 ? ` [${bc} branches]` : ''}`;
    }
    if (/\btimer\b|\bwait\b/i.test(type)) {
      const dur  = nd.waitDuration || nd.duration || '';
      const unit = (nd.waitUnit || nd.unit || '').replace(/s$/, '');
      return dur ? `Wait: ${dur}${unit ? ' ' + unit : ''} [timing gate]` : 'Wait [timing gate]';
    }
    if (/inapp|in.app|\biam\b/i.test(type))    return nm ? `In-App: ${nm} [in-app]`       : 'In-App Message [in-app]';
    if (/email_message|^email$/i.test(type))   return nm ? `Email: ${nm} [email]`          : 'Email [email]';
    if (/\bsms\b/i.test(type))                 return nm ? `SMS: ${nm} [sms]`               : 'SMS [sms]';
    if (/\bpush\b/i.test(type))                return nm ? `Push: ${nm} [push]`             : 'Push Notification [push]';
    if (/content.?card/i.test(type))           return nm ? `Content Card: ${nm}`            : 'Content Card';
    if (/direct.?mail/i.test(type))            return nm ? `Direct Mail: ${nm}`             : 'Direct Mail';
    if (/web.?action|\bweb\b/i.test(type))     return nm ? `Web Action: ${nm}`              : 'Web Action';
    if (/code.?based/i.test(type))             return nm ? `Code-Based: ${nm}`              : 'Code-Based Experience';
    if (/custom_action|\bcustom\b/i.test(type)) return nm ? `Custom Action: ${nm}`          : 'Custom Action';
    if (END_TYPES.test(type)) return 'End';
    return nm ? `${type}: ${nm}` : type || 'Unknown Node';
  }

  // DFS walk with convergence detection
  const renderedCache = new Map();

  function walk(nodeId, depth, branchLabel, pathAncestors) {
    if (depth > 20) return ['...(depth limit)'];
    if (pathAncestors.has(nodeId)) return ['...(loop back)'];
    const nd = nodeMap.get(nodeId);
    if (!nd) return [];
    const type  = (nd.type || nd.nodeType || '').toLowerCase();
    const isEnd = END_TYPES.test(type);
    const indent = '   '.repeat(depth);
    const prefix = depth === 0 ? '' : (branchLabel ? `[${branchLabel}] ` : '-> ');
    const label  = isEnd ? 'End' : nodeLabel(nd);
    if (!isEnd && renderedCache.has(nodeId)) {
      return [`${indent}${prefix}-> (converges to: ${renderedCache.get(nodeId)})`];
    }
    renderedCache.set(nodeId, label);
    const lines         = [`${indent}${prefix}${label}`];
    if (isEnd) return lines;
    const childAncestors = new Set(pathAncestors);
    childAncestors.add(nodeId);
    const transitions = Array.isArray(nd.transitions) ? nd.transitions : [];
    if (COND_TYPES.test(type) && transitions.length > 1) {
      transitions.forEach((t) => {
        const branchName = t.name || t.label || t.type || 'branch';
        const nextId     = t.nextNodeId || t.targetNodeId || t.id;
        if (nextId) {
          lines.push(...walk(nextId, depth + 1, branchName, childAncestors));
        } else {
          lines.push(`${'   '.repeat(depth + 1)}[${branchName}] -> End`);
        }
      });
    } else if (transitions.length === 1) {
      const nextId = transitions[0].nextNodeId || transitions[0].targetNodeId;
      if (nextId) {
        const sub = walk(nextId, depth, null, childAncestors);
        if (sub.length === 1) {
          lines[lines.length - 1] += ` -> ${sub[0].trimStart()}`;
        } else {
          lines.push(...sub);
        }
      }
    } else if (!transitions.length) {
      const nextId = nd.nextNodeId || nd.targetNodeId;
      if (nextId) lines.push(...walk(nextId, depth, null, childAncestors));
    }
    return lines;
  }

  try {
    const flowText = walk(startId, 0, null, new Set()).join('\n');
    return { flowText, maxDepth };
  } catch (_) {
    return { flowText: null, maxDepth };
  }
}

// ── buildAudienceSummary() ────────────────────────────────────────────────────
function buildAudienceSummary(events, conditions, audienceNames, audienceId, triggerInfo) {
  const lines = [];
  if (triggerInfo) {
    lines.push(`- Entry qualification:       ${triggerInfo}`);
  } else if (audienceId) {
    lines.push(`- Entry qualification:       Audience segment (ID: ${audienceId})`);
  } else {
    lines.push(`- Entry qualification:       none detected`);
  }
  if (audienceNames.length) {
    lines.push(`- Named audience segments:   ${audienceNames.join(', ')}`);
  } else {
    lines.push(`- Named audience segments:   none detected`);
  }
  const conditionLabels = conditions.map((c) => c.name || '').filter(Boolean).slice(0, 8);
  if (conditionLabels.length) {
    lines.push(`- Segmentation conditions:   ${conditionLabels.join(', ')}`);
  }
  lines.push(`- Personalized segmentation: ${audienceNames.length > 0 && conditions.length > 0 ? 'YES' : 'no'}`);
  return lines.join('\n');
}

// ── buildJourneyStructure() ───────────────────────────────────────────────────
function buildJourneyStructure(actions, events, conditions, channelCounts, audienceNames, audienceId, description, maxDepth) {
  const {
    inAppCount = 0, emailCount = 0, smsCount = 0, pushCount = 0,
    contentCardCount = 0, directMailCount = 0, webCount = 0, codeBasedCount = 0, customCount = 0,
  } = channelCounts;

  const totalNodes     = actions.length + events.length + conditions.length;
  const totalBranches  = conditions.reduce(
    (sum, c) => sum + (Array.isArray(c.transitions) ? Math.max(0, c.transitions.length - 1) : 0), 0,
  );
  const messagingCount = inAppCount + emailCount + smsCount + pushCount
    + contentCardCount + directMailCount + webCount + codeBasedCount + customCount;
  const waitSteps      = actions.filter((a) => /\btimer\b|\bwait\b/i.test((a.type || a.nodeType || '').toLowerCase())).length;
  const complexity     = totalNodes >= 8 || totalBranches >= 3 ? 'HIGH'
    : totalNodes >= 4 || totalBranches >= 1 ? 'MEDIUM' : 'LOW';

  const msgDetail = (() => {
    const p = [];
    if (inAppCount)       p.push(`in-app: ${inAppCount}`);
    if (emailCount)       p.push(`email: ${emailCount}`);
    if (smsCount)         p.push(`sms: ${smsCount}`);
    if (pushCount)        p.push(`push: ${pushCount}`);
    if (contentCardCount) p.push(`content-card: ${contentCardCount}`);
    if (directMailCount)  p.push(`direct-mail: ${directMailCount}`);
    if (webCount)         p.push(`web: ${webCount}`);
    if (codeBasedCount)   p.push(`code-based: ${codeBasedCount}`);
    if (customCount)      p.push(`custom: ${customCount}`);
    return p.length ? ` (${p.join(', ')})` : '';
  })();

  const yn = (v) => (v ? 'YES' : 'no');

  return [
    `- Total nodes:               ${totalNodes} | Complexity: ${complexity}`,
    `- Branch count:              ${totalBranches} (${conditions.length} condition node${conditions.length !== 1 ? 's' : ''})`,
    `- Max path depth (BFS):      ${maxDepth} steps`,
    `- Message touchpoints:       ${messagingCount > 0 ? 'YES' + msgDetail : 'no'}`,
    `- Wait/timing steps:         ${waitSteps > 0 ? `YES (${waitSteps})` : 'no'}`,
    `- Audience qualification:    ${yn(!!(events.length || audienceId || audienceNames.length))}`,
    `- Named audience segments:   ${audienceNames.length ? audienceNames.join(', ') : 'none'}`,
    `- Personalized segmentation: ${yn(audienceNames.length > 0 && conditions.length > 0)}`,
    `- Has description:           ${description && description.trim() ? 'YES' : 'no'}`,
    `- Empty/shell structure:     ${yn(totalNodes === 0)}`,
  ].join('\n');
}

// ── buildOperationalSignals() ─────────────────────────────────────────────────
function buildOperationalSignals(meta, sched, exitArr, status) {
  const lastPublishedAt  = meta.lastDeployedAt || meta.publishedAt || meta.lastPublishedAt || '';
  const daysSincePublish = lastPublishedAt
    ? Math.floor((Date.now() - new Date(lastPublishedAt).getTime()) / 86400000)
    : null;

  const now         = Date.now();
  const schedStart  = sched.startDate || sched.startTime || sched.start || '';
  const schedEnd    = sched.endDate   || sched.endTime   || sched.end   || '';
  const schedActive = schedStart
    ? (new Date(schedStart).getTime() <= now && (!schedEnd || new Date(schedEnd).getTime() > now))
    : false;

  const isStopped       = status === 'stopped' || status === 'closed';
  const hasExitCriteria = exitArr.length > 0;
  const yn              = (v) => (v ? 'YES' : 'no');

  return [
    `- Current status:            ${status}`,
    `- Last published:            ${lastPublishedAt ? lastPublishedAt.slice(0, 10) : 'never / unknown'}`,
    `- Days since published:      ${daysSincePublish !== null ? daysSincePublish : 'n/a'}`,
    `- Schedule active now:       ${schedActive ? 'YES' : 'no'}`,
    `- Has exit criteria:         ${yn(hasExitCriteria)}`,
    `- Intentionally stopped:     ${yn(isStopped)}`,
  ].join('\n');
}

// ── inferJourneyTypeFromName() ────────────────────────────────────────────────
function inferJourneyTypeFromName(name) {
  const n = name || '';
  if (/abandon.?cart|cart.?abandon/i.test(n))              return 'Abandoned Cart';
  if (/\bonboard/i.test(n))                                 return 'Onboarding';
  if (/\bwelcome\b/i.test(n))                               return 'Welcome';
  if (/re.?engag|win.?back|laps|reactivat/i.test(n))        return 'Re-engagement';
  if (/\bretention\b|\bchurn\b/i.test(n))                   return 'Retention';
  if (/transact|receipt|confirm|order.?confirm/i.test(n))   return 'Transactional';
  if (/\bpromo\b|campaign|offer|discount|sale\b/i.test(n))  return 'Promotional';
  if (/\btest\b|\bpoc\b|\bdemo\b|\bsandbox\b|\bqa\b|\buat\b/i.test(n)) return 'Test/POC';
  return null;
}

// ── preClassifyJourney() ──────────────────────────────────────────────────────
function preClassifyJourney(name, nodes, channelCounts, triggerInfo) {
  const n = name || '';
  const { actions, events, conditions } = nodes;
  const { emailCount = 0, smsCount = 0, pushCount = 0, inAppCount = 0 } = channelCounts;
  const hasMessaging = emailCount + smsCount + pushCount + inAppCount > 0;
  const totalNodes   = actions.length + events.length + conditions.length;
  const isEventBased = !!(triggerInfo && /unitary|event-triggered/i.test(triggerInfo));

  if (/abandon.?cart|cart.?abandon/i.test(n) && (emailCount > 0 || smsCount > 0)) return { type: 'Abandoned Cart', confidence: 92 };
  if (/\bonboard/i.test(n)    && hasMessaging)                                     return { type: 'Onboarding',    confidence: 90 };
  if (/\bwelcome\b/i.test(n)  && hasMessaging)                                     return { type: 'Welcome',       confidence: 90 };
  if (/re.?engag|win.?back|laps|reactivat/i.test(n) && hasMessaging)               return { type: 'Re-engagement', confidence: 88 };
  if (/\bretention\b|\bchurn\b/i.test(n) && hasMessaging)                          return { type: 'Retention',     confidence: 88 };
  if (isEventBased && emailCount > 0 && conditions.length === 0)                   return { type: 'Transactional', confidence: 85 };
  if (/\bpromo\b|campaign|offer|discount|sale\b/i.test(n) && hasMessaging)         return { type: 'Promotional',   confidence: 87 };
  if (/\btest\b|\bpoc\b|\bdemo\b|\bsandbox\b|\bqa\b|\buat\b/i.test(n) && totalNodes <= 2) return { type: 'Test/POC', confidence: 90 };
  if (/\bauth\b|\blogin\b|\bsign.?in\b|\botp\b|\bverif/i.test(n) && (inAppCount > 0 || pushCount > 0)) return { type: 'Onboarding', confidence: 82 };
  return null;
}

// ── deriveIntentLayer() ───────────────────────────────────────────────────────
/**
 * Pre-derive business intent signals from journey metadata + flow.
 * Returns a formatted multi-line string, or null if no signals found.
 */
function deriveIntentLayer(name, actions, conditions, audienceNames, channelCounts, flowText, triggerInfo) {
  const n               = (name || '').toLowerCase();
  const conditionLabels = conditions.map((c) => (c.name || '').toLowerCase()).join(' ');
  const actionLabels    = actions.map((a) => (a.name || '').toLowerCase()).join(' ');
  const flowLower       = (flowText || '').toLowerCase();
  const allText         = `${n} ${conditionLabels} ${actionLabels} ${flowLower}`;

  const { emailCount = 0, smsCount = 0, pushCount = 0, inAppCount = 0,
    contentCardCount = 0, timerCount = 0 } = channelCounts;

  const signals = {};

  // Lifecycle stage
  if (/first.?app|first.?launch|first.?open|signup|sign.?up|register|creat.*account/i.test(allText)) {
    signals.lifecycleStage = 'Onboarding / First activation';
  } else if (/onboard/i.test(allText)) {
    signals.lifecycleStage = 'Onboarding';
  } else if (/welcome/i.test(allText)) {
    signals.lifecycleStage = 'Acquisition / Welcome';
  } else if (/abandon/i.test(allText)) {
    signals.lifecycleStage = 'Conversion / Cart recovery';
  } else if (/re.?engag|win.?back|laps|reactivat|dormant|inactive/i.test(allText)) {
    signals.lifecycleStage = 'Re-engagement / Win-back';
  } else if (/churn|retention|renew|cancel/i.test(allText)) {
    signals.lifecycleStage = 'Retention / Churn prevention';
  } else if (/upsell|upgrade|premium|paid|credit|subscri/i.test(allText)) {
    signals.lifecycleStage = 'Monetization / Upsell';
  } else if (/transact|receipt|confirm|order|ship|deliver/i.test(allText)) {
    signals.lifecycleStage = 'Post-purchase / Transactional';
  } else if (/loyalt|reward|point|vip/i.test(allText)) {
    signals.lifecycleStage = 'Loyalty / Advocacy';
  } else if (conditions.length >= 2 && (emailCount + inAppCount + pushCount) > 0) {
    signals.lifecycleStage = 'Engagement / Nurture';
  } else {
    signals.lifecycleStage = null;
  }

  // Primary intent
  if (/upsell|upgrade|premium|paid.*user|free.*user|credit|modal/i.test(allText)) {
    signals.primaryIntent = 'Drive conversion from free to paid / trigger upsell';
  } else if (/abandon/i.test(allText)) {
    signals.primaryIntent = 'Recover abandoned intent and complete transaction';
  } else if (/re.?engag|win.?back|laps|reactivat/i.test(allText)) {
    signals.primaryIntent = 'Re-activate dormant users and restore engagement';
  } else if (/onboard|first.?app|first.?launch|first.?open/i.test(allText)) {
    signals.primaryIntent = 'Guide new users through activation milestones';
  } else if (/welcome/i.test(allText)) {
    signals.primaryIntent = 'Welcome and orient new users into the product experience';
  } else if (/retention|churn|renew/i.test(allText)) {
    signals.primaryIntent = 'Prevent churn by reinforcing product value';
  } else if (/transact|confirm|receipt|order/i.test(allText)) {
    signals.primaryIntent = 'Fulfill transactional communication obligation post-event';
  } else if (conditions.length > 0 && inAppCount > 0) {
    signals.primaryIntent = 'Personalize in-app experience based on user segment';
  } else if (emailCount > 1) {
    signals.primaryIntent = 'Nurture users through a multi-touch email sequence';
  } else {
    signals.primaryIntent = null;
  }

  // Segmentation type
  const hasFreeVsPaid    = /free.*paid|paid.*free|subscri|premium.*free|free.*premium/i.test(allText)
    || audienceNames.some((a) => /free|paid|subscri|premium/i.test(a));
  const hasNewVsExisting = /new.*user|existing|return|loyal/i.test(allText)
    || audienceNames.some((a) => /new|existing|return|loyal/i.test(a));
  const hasBehavioral    = /clicked|opened|visited|purchased|trigger|event/i.test(allText);

  if (hasFreeVsPaid)           signals.segmentationType = 'Subscription-state split (Free vs Paid users)';
  else if (hasNewVsExisting)   signals.segmentationType = 'Lifecycle-state split (New vs Existing users)';
  else if (hasBehavioral)      signals.segmentationType = 'Behavioral split (action/event-based branching)';
  else if (audienceNames.length > 0) signals.segmentationType = `Named audience split: ${audienceNames.slice(0, 3).join(', ')}`;
  else if (conditions.length > 0)    signals.segmentationType = 'Conditional branching (criteria not yet labeled)';
  else                               signals.segmentationType = null;

  // Engagement channels
  const channels = [];
  if (inAppCount > 0)       channels.push(`in-app message${inAppCount > 1 ? 's' : ''} (real-time contextual)`);
  if (emailCount > 0)       channels.push(`email${emailCount > 1 ? ` (${emailCount}-touch sequence)` : ''}`);
  if (pushCount > 0)        channels.push('push notification (interrupt-driven)');
  if (smsCount > 0)         channels.push('SMS (high-urgency or transactional)');
  if (contentCardCount > 0) channels.push('content card (passive in-app surface)');
  signals.engagementChannel = channels.length ? channels.join(' + ') : null;

  // Timing strategy
  const waitMatches    = (flowText || '').matchAll(/wait[:\s]+(\d+)\s*(day|hour|minute|week|month)/gi);
  const waitDurations  = [...waitMatches].map((m) => `${m[1]} ${m[2]}`);
  const hasTimer       = timerCount > 0 || /\btimer\b|\bwait\b/i.test(flowLower);

  if (waitDurations.length) {
    const dur  = waitDurations[0];
    const days = parseInt(dur, 10);
    if (/month/i.test(dur) || days >= 21) {
      signals.timingStrategy = `Long-cycle nurture (${waitDurations.join(', ')}) — retention or re-engagement pacing`;
    } else if (days >= 7) {
      signals.timingStrategy = `Medium-term follow-up (${waitDurations.join(', ')}) — post-event engagement window`;
    } else {
      signals.timingStrategy = `Short-term trigger response (${waitDurations.join(', ')}) — immediate post-action nurture`;
    }
  } else if (hasTimer) {
    signals.timingStrategy = 'Timed delay present — cadence-controlled messaging sequence';
  } else if (triggerInfo && /unitary|event-triggered/i.test(triggerInfo)) {
    signals.timingStrategy = 'Real-time event-triggered — immediate response to user action';
  } else {
    signals.timingStrategy = null;
  }

  // Customer problem
  if (/free.*user|free.*paid|upsell|upgrade|credit|modal/i.test(allText)) {
    signals.customerProblem = 'Users signed up but have not discovered or converted to paid features';
  } else if (/abandon/i.test(allText)) {
    signals.customerProblem = 'Users expressed purchase intent but did not complete the transaction';
  } else if (/re.?engag|dormant|inactive|laps/i.test(allText)) {
    signals.customerProblem = 'Previously active users have disengaged and risk churning';
  } else if (/onboard|first.?app|first.?launch/i.test(allText)) {
    signals.customerProblem = 'New users need guided activation to realize product value';
  } else if (/churn|cancel|retention/i.test(allText)) {
    signals.customerProblem = 'At-risk users showing signals of intent to leave or cancel';
  } else if (/welcome/i.test(allText)) {
    signals.customerProblem = 'New users need orientation and a first connection to the product';
  } else {
    signals.customerProblem = null;
  }

  // Behavior targeted
  if (/upsell|upgrade|paid|credit/i.test(allText)) {
    signals.behaviorTargeted = 'First subscription purchase or plan upgrade';
  } else if (/abandon/i.test(allText)) {
    signals.behaviorTargeted = 'Completion of previously abandoned purchase or sign-up flow';
  } else if (/first.?app|first.?launch|activate|onboard/i.test(allText)) {
    signals.behaviorTargeted = 'First key action or feature activation in the app';
  } else if (/re.?engag|return|come.?back/i.test(allText)) {
    signals.behaviorTargeted = 'Return session or re-engagement with core product feature';
  } else if (/open.*email|click|visit/i.test(allText)) {
    signals.behaviorTargeted = 'Email engagement or site/app visit';
  } else {
    signals.behaviorTargeted = null;
  }

  const entries = [
    ['Lifecycle stage',    signals.lifecycleStage],
    ['Primary intent',     signals.primaryIntent],
    ['Segmentation type',  signals.segmentationType],
    ['Engagement channel', signals.engagementChannel],
    ['Timing strategy',    signals.timingStrategy],
    ['Customer problem',   signals.customerProblem],
    ['Behavioral target',  signals.behaviorTargeted],
  ].filter(([, v]) => v);

  if (!entries.length) return null;
  return entries.map(([k, v]) => `- ${k.padEnd(22)}: ${v}`).join('\n');
}

module.exports = {
  extractNodes,
  extractChannelSummary,
  extractAudienceNames,
  extractTriggerInfo,
  buildFlowPath,
  buildAudienceSummary,
  buildJourneyStructure,
  buildOperationalSignals,
  inferJourneyTypeFromName,
  preClassifyJourney,
  deriveIntentLayer,
};
