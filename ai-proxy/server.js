/**
 * AJO Journey Cleanup — AI Proxy Server
 *
 * Phase 1: bridges browser → Ollama (local)
 * Phase 2: swap OLLAMA_BASE_URL + MODEL to point at Claude / OpenAI / Adobe AI
 *
 * Usage:
 *   cd ai-proxy && npm install && node server.js
 *
 * Environment variables:
 *   PORT=3001                               (default: 3001)
 *   OLLAMA_BASE=http://localhost:11434      (default)
 *   MODEL=llama3                            (default; try mistral, phi3, gemma2)
 *   CONCURRENCY=1                           (Ollama is single-threaded; keep at 1)
 *   LOG_FILE=./proxy.log                    (optional: also write logs to file as JSON-lines)
 *   LOG_LEVEL=info                          (debug|info|warn|error — default: info)
 *   LLM_LOG_DIR=./llm-logs                 (optional: write one .log file per journey here)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3001', 10);
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';
const MODEL = process.env.MODEL || 'gpt-oss:20b';
const LLM_CONCURRENCY = parseInt(process.env.CONCURRENCY || '1', 10);
const REQUEST_TIMEOUT_MS = 60_000;
const LOG_FILE = process.env.LOG_FILE || null;
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;
const LLM_LOG_DIR = process.env.LLM_LOG_DIR ? path.resolve(process.env.LLM_LOG_DIR) : null;

// ── LLM per-journey file logger ───────────────────────────────────────────────

function sanitizeName(name) {
  return (name || 'unnamed')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/__+/g, '_')
    .slice(0, 60);
}

function writeLlmFile(journey, prompt, raw, parsed, durationMs) {
  if (!LLM_LOG_DIR) return;
  try {
    if (!fs.existsSync(LLM_LOG_DIR)) fs.mkdirSync(LLM_LOG_DIR, { recursive: true });

    const id = journey.id || 'unknown';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = sanitizeName(journey.name);
    const fileName = `${id}_${safeName}_${ts}.log`;
    const filePath = path.join(LLM_LOG_DIR, fileName);

    const SEP = '='.repeat(80);
    const DIV = '-'.repeat(80);

    const lines = [
      SEP,
      `Journey ID   : ${id}`,
      `Journey Name : ${journey.name || '(unnamed)'}`,
      `Status       : ${journey.status || 'unknown'}`,
      `Days Stale   : ${journey._daysStale || 0}`,
      `Model        : ${MODEL}`,
      `Scored At    : ${new Date().toISOString()}`,
      `Duration     : ${durationMs}ms`,
      SEP,
      'PROMPT:',
      DIV,
      prompt,
      SEP,
      'RAW RESPONSE:',
      DIV,
      raw || '(empty)',
      SEP,
      'PARSED RESULT:',
      DIV,
    ];

    if (parsed) {
      const fields = [
        ['retirementScore',   parsed.retirementScore],
        ['retirementLabel',   parsed.retirementLabel],
        ['confidence',        parsed.confidence],
        ['businessValue',     parsed.businessValue],
        ['journeyType',       parsed.journeyType],
        ['lifecycleStage',    parsed.lifecycleStage],
        ['customerExperience',parsed.customerExperience],
        ['behaviorTargeted',  parsed.behaviorTargeted],
        ['businessObjective', parsed.businessObjective],
        ['whyTeamBuiltThis',  parsed.whyTeamBuiltThis],
        ['useCaseSummary',    parsed.useCaseSummary],
        ['targetAudience',    parsed.targetAudience],
        ['businessPurpose',   parsed.businessPurpose],
        ['lifecycleDecision',        parsed.lifecycleDecision],
        ['governanceReviewPriority', parsed.governanceReviewPriority],
        ['reasoning',                parsed.reasoning],
        ['recommendation',           parsed.recommendation],
      ];
      fields.forEach(([k, v]) => {
        if (v !== undefined && v !== null) lines.push(`  ${k.padEnd(20)}: ${v}`);
      });
    } else {
      lines.push('  (parse failed — see RAW RESPONSE above)');
    }

    lines.push(SEP, '');
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    log('debug', '📄 LLM log written', { id, file: fileName });
  } catch (e) {
    log('warn', '📄 LLM log write failed', { id: journey.id, error: e.message });
  }
}

// ── Logger ────────────────────────────────────────────────────────────────────

let logFileStream = null;
if (LOG_FILE) {
  try {
    logFileStream = fs.createWriteStream(path.resolve(LOG_FILE), { flags: 'a' });
    // eslint-disable-next-line no-console
    console.log(`📂 Log file: ${path.resolve(LOG_FILE)}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`⚠ Could not open log file ${LOG_FILE}: ${e.message}`);
  }
}

const LEVEL_ICONS  = { debug: '🔍', info: '✅', warn: '⚠ ', error: '❌' };
const LEVEL_COLORS = { debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';

function log(level, message, meta = {}) {
  if ((LOG_LEVELS[level] ?? 0) < LOG_LEVEL) return;
  const ts    = new Date().toISOString();
  const icon  = LEVEL_ICONS[level]  || '•';
  const color = LEVEL_COLORS[level] || '';

  const metaStr = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${DIM}${k}=${RESET}${color}${v}${RESET}`)
    .join('  ');

  const line = `${DIM}${ts}${RESET}  ${color}${icon} ${BOLD}[${level.toUpperCase()}]${RESET}${color}  ${message}${RESET}${metaStr ? '  ' + metaStr : ''}`;
  if (level === 'error' || level === 'warn') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  if (logFileStream) logFileStream.write(JSON.stringify({ ts, level, message, ...meta }) + '\n');
}

// ── Request logger middleware ─────────────────────────────────────────────────

function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, path: reqPath } = req;
  const isHealth = reqPath === '/health';

  if (!isHealth || LOG_LEVEL <= LOG_LEVELS.debug) {
    log('info', `→ ${method} ${reqPath}`, {
      ip: req.ip || req.socket?.remoteAddress,
      body_keys: req.body ? Object.keys(req.body).join(',') : '',
    });
  }

  res.on('finish', () => {
    const ms  = Date.now() - start;
    const sc  = res.statusCode;
    const lvl = sc >= 500 ? 'error' : sc >= 400 ? 'warn' : 'info';
    if (!isHealth || LOG_LEVEL <= LOG_LEVELS.debug) {
      log(lvl, `← ${method} ${reqPath}`, { status: sc, ms: `${ms}ms` });
    }
  });

  next();
}

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────────────
const extraOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((o) => o.trim()).filter(Boolean);

const ORIGIN_RE = /^https?:\/\/(localhost(:\d+)?|[a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\.aem\.(live|page))(\/.*)?$/i;

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ORIGIN_RE.test(origin)) return cb(null, true);
    if (extraOrigins.includes(origin)) return cb(null, true);
    log('warn', 'CORS blocked', { origin });
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
}));

app.use(express.json({ limit: '2mb' }));
app.use(requestLogger);

// ── Ollama availability tracking ──────────────────────────────────────────────
let ollamaOnline = false;
let ollamaLastChecked = null;
const OLLAMA_CHECK_INTERVAL_MS = 15_000;

async function checkOllamaAvailability() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    const wasOffline = !ollamaOnline;
    ollamaOnline = r.ok;
    ollamaLastChecked = new Date().toISOString();
    if (wasOffline && ollamaOnline) log('info', '🦙 Ollama came online', { url: OLLAMA_BASE });
  } catch (_) {
    const wasOnline = ollamaOnline;
    ollamaOnline = false;
    ollamaLastChecked = new Date().toISOString();
    if (wasOnline) log('warn', '🦙 Ollama went offline — proxy requests will be rejected', { url: OLLAMA_BASE });
  }
}

checkOllamaAvailability();
setInterval(checkOllamaAvailability, OLLAMA_CHECK_INTERVAL_MS);

// ── Token usage counters ──────────────────────────────────────────────────────
const tokenStats = {
  totalRequests: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  startedAt: new Date().toISOString(),
};

// ── Queue ─────────────────────────────────────────────────────────────────────
let activeCount = 0;
const waitQueue = [];

function acquireSlot(journeyId) {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activeCount < LLM_CONCURRENCY) {
        activeCount += 1;
        log('debug', 'Queue slot acquired', { journeyId, active: activeCount, queued: waitQueue.length });
        resolve();
      } else {
        if (waitQueue.length === 0) {
          log('warn', 'Queue full — request waiting', {
            journeyId, active: activeCount, waiting: waitQueue.length + 1, concurrency: LLM_CONCURRENCY,
          });
        }
        waitQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releaseSlot(journeyId) {
  activeCount -= 1;
  log('debug', 'Queue slot released', { journeyId, active: activeCount, queued: waitQueue.length });
  if (waitQueue.length) waitQueue.shift()();
}

// ── Ollama call ───────────────────────────────────────────────────────────────
async function callOllama(prompt, journeyId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const ollamaStart = Date.now();

  log('debug', '🦙 Ollama → sending prompt', { journeyId, model: MODEL, prompt_chars: prompt.length });
  log('info',  '🦙 Ollama prompt text', { journeyId, prompt });

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${txt}`);
    }
    const data = await res.json();
    const ms = Date.now() - ollamaStart;
    log('info', '🦙 Ollama ← response received', {
      journeyId, ms: `${ms}ms`, response_chars: (data.response || '').length, eval_count: data.eval_count,
    });

    const responseText     = data.response || '';
    const promptTokens     = data.prompt_eval_count || 0;
    const completionTokens = data.eval_count || 0;
    tokenStats.totalRequests         += 1;
    tokenStats.totalPromptTokens     += promptTokens;
    tokenStats.totalCompletionTokens += completionTokens;
    log('info', '🦙 Ollama tokens', {
      journeyId,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      session_total: tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens,
    });
    log('debug', '🦙 Ollama raw response', { journeyId, raw_response: responseText });
    return { text: responseText, promptTokens, completionTokens };
  } catch (e) {
    const ms = Date.now() - ollamaStart;
    if (e.name === 'AbortError') {
      log('error', '🦙 Ollama timeout', { journeyId, after: `${REQUEST_TIMEOUT_MS}ms` });
    } else {
      log('error', '🦙 Ollama error', { journeyId, ms: `${ms}ms`, error: e.message });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── JSON extractor ────────────────────────────────────────────────────────────
function extractJson(raw, journeyId) {
  try { return JSON.parse(raw.trim()); } catch (_) { /* fall through */ }

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (_) { /* fall through */ }
  }

  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) {
    try { return JSON.parse(brace[0]); } catch (_) { /* fall through */ }
  }

  log('warn', 'JSON parse failed — LLM returned non-JSON', {
    journeyId, raw_preview: raw.slice(0, 120).replace(/\n/g, ' '),
  });
  return null;
}

// ── Journey type name-based inference ────────────────────────────────────────
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

// ── Rule-based pre-classifier ─────────────────────────────────────────────────
// Combines channel types + audience + node patterns to infer journey type before LLM.
// Returns { type, confidence } when confident (>=82%), or null when uncertain.
// Priority order:
//  1. Abandoned Cart  — name pattern + email/sms present
//  2. Onboarding      — name pattern + message action present
//  3. Welcome         — name pattern + message action present
//  4. Re-engagement   — name pattern + message actions present
//  5. Retention       — name pattern + message actions present
//  6. Transactional   — event-triggered + email + no conditions
//  7. Promotional     — name pattern + message actions present
//  8. Test/POC        — test/poc name + minimal structure (<=2 nodes)
//  9. Auth/login      — name + in-app/push actions
function preClassifyJourney(name, nodes, channelCounts, triggerInfo) {
  const n = name || '';
  const { actions, events, conditions } = nodes;
  const { emailCount = 0, smsCount = 0, pushCount = 0, inAppCount = 0 } = channelCounts;
  const hasMessaging  = emailCount + smsCount + pushCount + inAppCount > 0;
  const totalNodes    = actions.length + events.length + conditions.length;
  const isEventBased  = !!(triggerInfo && /unitary|event-triggered/i.test(triggerInfo));

  if (/abandon.?cart|cart.?abandon/i.test(n) && (emailCount > 0 || smsCount > 0)) {
    return { type: 'Abandoned Cart', confidence: 92 };
  }
  if (/\bonboard/i.test(n) && hasMessaging) {
    return { type: 'Onboarding', confidence: 90 };
  }
  if (/\bwelcome\b/i.test(n) && hasMessaging) {
    return { type: 'Welcome', confidence: 90 };
  }
  if (/re.?engag|win.?back|laps|reactivat/i.test(n) && hasMessaging) {
    return { type: 'Re-engagement', confidence: 88 };
  }
  if (/\bretention\b|\bchurn\b/i.test(n) && hasMessaging) {
    return { type: 'Retention', confidence: 88 };
  }
  if (isEventBased && emailCount > 0 && conditions.length === 0) {
    return { type: 'Transactional', confidence: 85 };
  }
  if (/\bpromo\b|campaign|offer|discount|sale\b/i.test(n) && hasMessaging) {
    return { type: 'Promotional', confidence: 87 };
  }
  if (/\btest\b|\bpoc\b|\bdemo\b|\bsandbox\b|\bqa\b|\buat\b/i.test(n) && totalNodes <= 2) {
    return { type: 'Test/POC', confidence: 90 };
  }
  if (/\bauth\b|\blogin\b|\bsign.?in\b|\botp\b|\bverif/i.test(n) && (inAppCount > 0 || pushCount > 0)) {
    return { type: 'Onboarding', confidence: 82 };
  }

  return null; // uncertain — let LLM decide
}

// ── Canvas node extractor ─────────────────────────────────────────────────────
const EVENT_TYPES = /^(unitary_event|read_segment|audience_entry|event|trigger|audience|entry|segment)/i;
const COND_TYPES  = /^condition/i;
const END_TYPES   = /^end$/i;

function extractNodes(journey) {
  if (
    (journey.actions    && journey.actions.length)
    || (journey.events  && journey.events.length)
    || (journey.conditions && journey.conditions.length)
  ) {
    return {
      actions: journey.actions || [],
      events: journey.events || [],
      conditions: journey.conditions || [],
      allNodes: [],
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

// ── Extract audience names from condition expressions ─────────────────────────
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

// ── Extract event trigger info ────────────────────────────────────────────────
function extractTriggerInfo(events) {
  if (!events.length) return null;
  const trigger = events[0];
  const type = (trigger.type || trigger.nodeType || '').toLowerCase();
  const name = trigger.name || '';
  if (type === 'read_segment' || type === 'audience_entry') return `Audience-based (read segment): "${name}"`;
  if (type === 'unitary_event') return `Event-triggered (unitary): "${name}"`;
  return `"${name}" (type: ${type})`;
}

// ── Extract channel counts from action nodes ──────────────────────────────────
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

// ── Journey flow path builder + BFS max-depth calculator ─────────────────────
// Returns { flowText, maxDepth } where maxDepth is the true BFS longest path.
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

  // BFS to compute longest path depth
  let maxDepth = 0;
  const bfsVisited = new Set();
  const bfsQueue = [{ id: startId, depth: 0 }];
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

  // DFS to build human-readable flow text
  // Uses a path-local ancestor set (not a global visited set) so that:
  //   - TRUE cycles  → detected when nodeId is on the current branch path
  //   - SHARED CONVERGENCE (e.g., both branches → same Wait → End) → rendered correctly
  // A global renderedCache stores the text of already-fully-rendered subtrees so
  // convergent branches can emit a short "-> same as: X" reference instead of
  // re-rendering the full subtree (keeps output clean but complete).
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
    if (/inapp|in.app|\biam\b/i.test(type))      return nm ? `In-App: ${nm} [in-app]`      : 'In-App Message [in-app]';
    if (/email_message|^email$/i.test(type))      return nm ? `Email: ${nm} [email]`         : 'Email [email]';
    if (/\bsms\b/i.test(type))                    return nm ? `SMS: ${nm} [sms]`              : 'SMS [sms]';
    if (/\bpush\b/i.test(type))                   return nm ? `Push: ${nm} [push]`            : 'Push Notification [push]';
    if (/content.?card/i.test(type))              return nm ? `Content Card: ${nm}`           : 'Content Card';
    if (/direct.?mail/i.test(type))               return nm ? `Direct Mail: ${nm}`            : 'Direct Mail';
    if (/web.?action|\bweb\b/i.test(type))        return nm ? `Web Action: ${nm}`             : 'Web Action';
    if (/code.?based/i.test(type))                return nm ? `Code-Based: ${nm}`             : 'Code-Based Experience';
    if (/custom_action|\bcustom\b/i.test(type))   return nm ? `Custom Action: ${nm}`          : 'Custom Action';
    if (END_TYPES.test(type)) return 'End';
    return nm ? `${type}: ${nm}` : type || 'Unknown Node';
  }

  // renderedCache: nodeId → first-render label (used to emit short-form references on convergence)
  const renderedCache = new Map();

  // pathAncestors: Set of nodeIds on the CURRENT DFS branch (detects true back-edges / cycles)
  function walk(nodeId, depth, branchLabel, pathAncestors) {
    if (depth > 20) return ['...(depth limit)'];

    // TRUE cycle: this node is an ancestor on the current branch path
    if (pathAncestors.has(nodeId)) return ['...(loop back)'];

    const nd = nodeMap.get(nodeId);
    if (!nd) return [];

    const type   = (nd.type || nd.nodeType || '').toLowerCase();
    const isEnd  = END_TYPES.test(type);
    const indent = '   '.repeat(depth);
    const prefix = depth === 0 ? '' : (branchLabel ? `[${branchLabel}] ` : '-> ');
    const label  = isEnd ? 'End' : nodeLabel(nd);

    // CONVERGENCE: node already fully rendered by a different branch — emit short reference
    if (!isEnd && renderedCache.has(nodeId)) {
      return [`${indent}${prefix}-> (converges to: ${renderedCache.get(nodeId)})`];
    }

    // Mark as rendered so other branches see the short-form reference
    renderedCache.set(nodeId, label);

    const lines = [`${indent}${prefix}${label}`];
    if (isEnd) return lines;

    // Extend path-local ancestor set for children (immutable per branch)
    const childAncestors = new Set(pathAncestors);
    childAncestors.add(nodeId);

    const transitions = Array.isArray(nd.transitions) ? nd.transitions : [];
    if (COND_TYPES.test(type) && transitions.length > 1) {
      transitions.forEach((t) => {
        const branchName = t.name || t.label || t.type || 'branch';
        const nextId = t.nextNodeId || t.targetNodeId || t.id;
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

// ── Audience summary builder ──────────────────────────────────────────────────
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

// ── Unified journey structure block ──────────────────────────────────────────
// Merges former BUSINESS SIGNALS + FLOW METRICS into one compact block.
function buildJourneyStructure(actions, events, conditions, channelCounts, audienceNames, audienceId, description, maxDepth) {
  const {
    inAppCount = 0, emailCount = 0, smsCount = 0, pushCount = 0,
    contentCardCount = 0, directMailCount = 0, webCount = 0, codeBasedCount = 0,
    customCount = 0, timerCount = 0,
  } = channelCounts;

  const totalNodes    = actions.length + events.length + conditions.length;
  const totalBranches = conditions.reduce(
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

// ── Operational signals builder ───────────────────────────────────────────────
function buildOperationalSignals(meta, sched, exitArr, status) {
  const lastPublishedAt  = meta.lastDeployedAt || meta.publishedAt || meta.lastPublishedAt || '';
  const daysSincePublish = lastPublishedAt
    ? Math.floor((Date.now() - new Date(lastPublishedAt).getTime()) / 86400000)
    : null;

  const now = Date.now();
  const schedStart = sched.startDate || sched.startTime || sched.start || '';
  const schedEnd   = sched.endDate   || sched.endTime   || sched.end   || '';
  const schedActive = schedStart
    ? (new Date(schedStart).getTime() <= now && (!schedEnd || new Date(schedEnd).getTime() > now))
    : false;

  const isLive     = status === 'live' || status === 'published';
  const isStopped  = status === 'stopped' || status === 'closed';
  const hasExitCriteria = exitArr.length > 0;

  return [
    `- Current status:            ${status}`,
    `- Last published:            ${lastPublishedAt ? lastPublishedAt.slice(0, 10) : 'never / unknown'}`,
    `- Days since published:      ${daysSincePublish !== null ? daysSincePublish : 'n/a'}`,
    `- Schedule active now:       ${schedActive ? 'YES' : 'no'}`,
    `- Has exit criteria:         ${yn(hasExitCriteria)}`,
    `- Intentionally stopped:     ${yn(isStopped)}`,
  ].join('\n');

  function yn(v) { return v ? 'YES' : 'no'; }
}

// ── Journey Intent Layer ──────────────────────────────────────────────────────
// Derives high-level semantic business signals from raw orchestration topology.
// Runs BEFORE the LLM call so the model reasons about business intent top-down
// rather than narrating graph structure bottom-up.
//
// Signal categories derived:
//   lifecycleStage    — where in the customer journey this sits
//   primaryIntent     — the core behavior being influenced
//   segmentationType  — what type of split logic is present
//   engagementChannel — what channel(s) are used and why
//   timingStrategy    — what the wait/timer pattern implies
//   customerProblem   — the underlying user need being addressed
//   behaviorTargeted  — the specific action/event being influenced
function deriveIntentLayer(name, actions, conditions, audienceNames, channelCounts, flowText, triggerInfo) {
  const n = (name || '').toLowerCase();
  const conditionLabels = conditions.map((c) => (c.name || '').toLowerCase()).join(' ');
  const actionLabels    = actions.map((a) => (a.name || '').toLowerCase()).join(' ');
  const flowLower       = (flowText || '').toLowerCase();
  const allText         = `${n} ${conditionLabels} ${actionLabels} ${flowLower}`;

  const { emailCount = 0, smsCount = 0, pushCount = 0, inAppCount = 0,
    contentCardCount = 0, timerCount = 0 } = channelCounts;

  const signals = {};

  // ── Lifecycle stage ──────────────────────────────────────────────────────
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
    signals.lifecycleStage = null; // let LLM infer
  }

  // ── Primary intent ────────────────────────────────────────────────────────
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

  // ── Segmentation type ────────────────────────────────────────────────────
  const hasFreeVsPaid = /free.*paid|paid.*free|subscri|premium.*free|free.*premium/i.test(allText)
    || audienceNames.some((a) => /free|paid|subscri|premium/i.test(a));
  const hasNewVsExisting = /new.*user|existing|return|loyal/i.test(allText)
    || audienceNames.some((a) => /new|existing|return|loyal/i.test(a));
  const hasBehavioral = /clicked|opened|visited|purchased|trigger|event/i.test(allText);

  if (hasFreeVsPaid) {
    signals.segmentationType = 'Subscription-state split (Free vs Paid users)';
  } else if (hasNewVsExisting) {
    signals.segmentationType = 'Lifecycle-state split (New vs Existing users)';
  } else if (hasBehavioral) {
    signals.segmentationType = 'Behavioral split (action/event-based branching)';
  } else if (audienceNames.length > 0) {
    signals.segmentationType = `Named audience split: ${audienceNames.slice(0, 3).join(', ')}`;
  } else if (conditions.length > 0) {
    signals.segmentationType = 'Conditional branching (criteria not yet labeled)';
  } else {
    signals.segmentationType = null;
  }

  // ── Engagement channel signal ─────────────────────────────────────────────
  const channels = [];
  if (inAppCount > 0)       channels.push(`in-app message${inAppCount > 1 ? 's' : ''} (real-time contextual)`);
  if (emailCount > 0)       channels.push(`email${emailCount > 1 ? ` (${emailCount}-touch sequence)` : ''}`);
  if (pushCount > 0)        channels.push('push notification (interrupt-driven)');
  if (smsCount > 0)         channels.push('SMS (high-urgency or transactional)');
  if (contentCardCount > 0) channels.push('content card (passive in-app surface)');
  signals.engagementChannel = channels.length ? channels.join(' + ') : null;

  // ── Timing strategy ───────────────────────────────────────────────────────
  // Infer wait semantics from flow text (duration values) or action types
  const waitMatches = (flowText || '').matchAll(/wait[:\s]+(\d+)\s*(day|hour|minute|week|month)/gi);
  const waitDurations = [...waitMatches].map((m) => `${m[1]} ${m[2]}`);
  const hasTimer = timerCount > 0 || /\btimer\b|\bwait\b/i.test(flowLower);

  if (waitDurations.length) {
    const dur = waitDurations[0];
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

  // ── Customer problem being solved ─────────────────────────────────────────
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

  // ── Behavioral target ──────────────────────────────────────────────────────
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

  // ── Format as structured block ────────────────────────────────────────────
  const entries = [
    ['Lifecycle stage',      signals.lifecycleStage],
    ['Primary intent',       signals.primaryIntent],
    ['Segmentation type',    signals.segmentationType],
    ['Engagement channel',   signals.engagementChannel],
    ['Timing strategy',      signals.timingStrategy],
    ['Customer problem',     signals.customerProblem],
    ['Behavioral target',    signals.behaviorTargeted],
  ].filter(([, v]) => v);

  if (!entries.length) return null;

  return entries.map(([k, v]) => `- ${k.padEnd(22)}: ${v}`).join('\n');
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(journey) {
  const meta     = journey.metadata || {};
  const name     = journey.name || '(unnamed)';
  const status   = (journey.status || 'unknown').toLowerCase();
  const version  = journey.version || '1';
  const daysStale = journey._daysStale || 0;
  const createdBy  = meta.createdBy || 'unknown';
  const createdAt  = meta.createdAt ? meta.createdAt.slice(0, 10) : 'unknown';
  const modifiedBy = meta.lastModifiedBy || 'unknown';
  const modifiedAt = meta.lastModifiedAt ? meta.lastModifiedAt.slice(0, 10) : 'unknown';
  const lastDeployedBy = meta.lastDeployedBy || '';
  const lastDeployedAt = meta.lastDeployedAt ? meta.lastDeployedAt.slice(0, 10) : '';
  const isDefaultName  = journey._isDefaultName
    ? 'YES — never renamed (strong abandonment signal)' : 'No';

  const journeyApiType = journey.type || '';
  const sandboxName    = journey.sandboxName || journey.sandbox || '';
  const category       = journey.category || '';
  const description    = journey.description || '';

  // Schedule
  const sched       = journey.schedule || {};
  const schedStart  = (sched.startDate || sched.startTime || sched.start || '').toString().slice(0, 10);
  const schedEnd    = (sched.endDate   || sched.endTime   || sched.end   || '').toString().slice(0, 10);
  const schedTz     = sched.timezone || sched.timeZone || journey.timeZone || '';
  const schedLine   = [
    schedStart ? `starts ${schedStart}` : '',
    schedEnd   ? `ends ${schedEnd}`     : '',
    schedTz    ? `tz: ${schedTz}`       : '',
  ].filter(Boolean).join(', ') || 'none / unknown';

  // Re-entrance
  const reentrance  = journey.reentrance || {};
  const reentPolicy = reentrance.policy || '';
  const reentDur    = reentrance.durationInSecs != null ? `${reentrance.durationInSecs}s window` : '';
  const reentLine   = reentPolicy ? `${reentPolicy}${reentDur ? ' (' + reentDur + ')' : ''}` : 'none / unknown';

  // Exit criteria
  const exitArr  = Array.isArray(journey.exitCriteria)
    ? journey.exitCriteria : (journey.exitCriteria ? [journey.exitCriteria] : []);
  const exitLine = exitArr.length
    ? exitArr.map((x) => x.type || x.condition || JSON.stringify(x)).join('; ')
    : 'none';

  // Tags
  const rawTags  = journey.tags || [];
  const tagNames = rawTags
    .map((t) => (typeof t === 'string' ? t : (t.name || t.label || t.title || '').trim()))
    .filter(Boolean);

  // Nodes
  const { actions, events, conditions, allNodes } = extractNodes(journey);

  // Channel counts
  const channelCounts = extractChannelSummary(actions);
  const {
    emailCount, smsCount, pushCount, inAppCount, contentCardCount,
    directMailCount, webCount, codeBasedCount, timerCount, customCount,
  } = channelCounts;

  // Audience data
  const audienceId = journey.audienceId || journey.segmentId || journey.segment?.id
    || (events.find((e) => e.segmentId || e.audienceId) || {}).segmentId
    || (events.find((e) => e.segmentId || e.audienceId) || {}).audienceId || '';
  const allForAudience = allNodes.length ? allNodes : [...actions, ...events, ...conditions];
  const audienceNames  = extractAudienceNames(allForAudience);
  const triggerInfo    = extractTriggerInfo(events);

  // Flow path + BFS depth
  const { flowText, maxDepth } = buildFlowPath(journey);

  // Audience summary
  const audienceSummary = buildAudienceSummary(events, conditions, audienceNames, audienceId, triggerInfo);

  // Unified structure block
  const journeyStructure = buildJourneyStructure(
    actions, events, conditions, channelCounts, audienceNames, audienceId, description, maxDepth,
  );

  // Operational signals
  const operationalSignals = buildOperationalSignals(meta, sched, exitArr, status);

  // Condition + action labels
  const conditionNames = conditions.map((c) => c.name || '').filter(Boolean).slice(0, 10);
  const actionNames    = actions.map((a) => a.name || '')
    .filter((nm) => nm && !/^(wait|timer)/i.test(nm)).slice(0, 8);

  const nodeCount = actions.length + events.length + conditions.length;

  // Pre-classifier hint
  const preClass   = preClassifyJourney(name, { actions, events, conditions }, channelCounts, triggerInfo);
  const nameHint   = inferJourneyTypeFromName(name);
  const typeHintLine = preClass
    ? `Pre-classification: "${preClass.type}" (rule confidence: ${preClass.confidence}% — confirm or override based on structure)`
    : (nameHint
      ? `Name-based type hint: "${nameHint}" (weak signal — structure takes precedence)`
      : 'Type hint: unclear');

  const structureNote = nodeCount === 0
    ? 'WARNING: No structural node data from API — rely on name, status, tags, and description.'
    : '';

  // Business Intent Layer — derived semantic signals injected before LLM reasoning
  const intentLayer = deriveIntentLayer(
    name, actions, conditions, audienceNames, channelCounts, flowText, triggerInfo,
  );

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
   A word like "delete" in a title is a note-to-self, not proof the journey is empty or accidental.
5. If journey has >=1 entry event AND >=1 condition AND >=1 message action → describe the real business intent.
   "No identifiable business purpose" is only valid when: AJO default name AND 0 message actions AND 0 conditions AND no description.
6. Test/POC requires: placeholder name AND trivial structure (<=1 node, no audience logic, no messaging).

WORKFLOW RICHNESS CALIBRATION (retirementScore anchors — apply before finalising score):
- Rich lifecycle workflow = any combination of: audience qualification + condition branching + 2+ message actions + timing/wait steps
  → retirementScore MUST be ≤ 35, regardless of draft status or staleness up to 120 days
- Monetization signals (free/paid split, subscription branching, upsell targeting, credit/premium audience):
  → Strong KEEP indicator — floor retirementScore at ≤ 25
- Onboarding + activation + app-timing patterns with multiple IAM/push actions:
  → Strong KEEP indicator — floor retirementScore at ≤ 30
- Draft status contributes at most a small bump (+5 to reasoning, not a major retirement factor)
- Staleness (60–120 days) for a complex journey: contributes at most +8 to score — do not compound with other signals
- "Review with owner" is ONLY appropriate when: purpose is genuinely ambiguous OR broken references exist
  OR the journey has been inactive for 1+ years with no structural evidence of active use
- A journey with segmentation + branching + monetization/lifecycle targeting + multiple touchpoints
  should default to: retirementScore ≤ 30, lifecycleDecision: "Keep", recommendation: "Keep"

SCORING EXAMPLES (calibration anchors — use these to self-check your retirementScore before responding):
- Onboarding + free/paid audience split + 4 IAM actions + wait timer + monetization branch + draft + 65d stale
  → retirementScore: 20, lifecycleDecision: "Keep", governanceReviewPriority: "low", recommendation: "Keep"
- Named journey + rich conditions + email sequence + audience segments + stopped 8 months ago
  → retirementScore: 45, lifecycleDecision: "Review", governanceReviewPriority: "medium", recommendation: "Review with owner"
- AJO default name + 0 conditions + 0 message actions + 400d stale + no description
  → retirementScore: 92, lifecycleDecision: "Archive", governanceReviewPriority: "high", recommendation: "Archive"
- Named journey + 1 email + no conditions + draft + 90d stale + no audience
  → retirementScore: 55, lifecycleDecision: "Review", governanceReviewPriority: "medium", recommendation: "Review with owner"

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
Answer each field from a business strategy lens, not a graph description lens:
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

// ── /health ───────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const start = Date.now();
  await checkOllamaAvailability();
  const ms = Date.now() - start;
  if (ollamaOnline) {
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/tags`);
      const data = await r.json();
      const models = (data.models || []).map((m) => m.name);
      log('info', '🩺 Health check', {
        ollama: 'connected', model: MODEL, available_models: models.join(',') || '(none)', ms: `${ms}ms`,
      });
      return res.json({ status: 'ok', model: MODEL, ollama: 'connected', availableModels: models, lastChecked: ollamaLastChecked });
    } catch (e) { /* fall through */ }
  }
  log('error', '🩺 Health check failed — Ollama unreachable', { ms: `${ms}ms` });
  res.status(503).json({ status: 'error', model: MODEL, ollama: 'unreachable', lastChecked: ollamaLastChecked });
});

// ── /score  (single journey) ──────────────────────────────────────────────────
app.post('/score', async (req, res) => {
  if (!ollamaOnline) {
    log('warn', '/score — rejected: Ollama is offline', { url: OLLAMA_BASE, lastChecked: ollamaLastChecked });
    return res.status(503).json({
      error: 'AI backend (Ollama) is currently offline. Please start Ollama and try again.',
      ollama: 'unreachable',
      lastChecked: ollamaLastChecked,
    });
  }

  const journey = req.body?.journey;
  if (!journey || !journey.id) {
    log('warn', '/score — missing journey payload');
    return res.status(400).json({ error: 'Missing journey object with id' });
  }

  const { id, name, status } = journey;
  const daysStale = journey._daysStale || 0;
  log('info', '🎯 Scoring journey', { id, name: (name || '').slice(0, 40), status, days_stale: daysStale });

  const scoreStart = Date.now();
  await acquireSlot(id);
  try {
    const prompt = buildPrompt(journey);
    const { text: rawText, promptTokens, completionTokens } = await callOllama(prompt, id);
    const parsed = extractJson(rawText, id);
    const totalMs = Date.now() - scoreStart;

    writeLlmFile(journey, prompt, rawText, parsed, totalMs);

    if (!parsed) {
      log('error', '🎯 Score failed — non-JSON LLM response', { id, ms: `${totalMs}ms` });
      return res.status(422).json({ error: 'LLM returned non-JSON response', raw: rawText.slice(0, 500), fallback: true });
    }

    log('info', '🎯 Score complete', {
      id, ms: `${totalMs}ms`, verdict: parsed.retirementLabel, score: parsed.retirementScore,
      confidence: parsed.confidence, biz_value: parsed.businessValue,
      prompt_tokens: promptTokens, completion_tokens: completionTokens,
    });
    log('debug', '🎯 Parsed LLM result', { id, ...parsed });

    res.json({
      journeyId: id,
      ...parsed,
      model: MODEL,
      _raw: rawText.slice(0, 200),
      _tokens: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
    });
  } catch (e) {
    const totalMs = Date.now() - scoreStart;
    const timedOut = e.name === 'AbortError';
    log('error', `🎯 Score ${timedOut ? 'timed out' : 'errored'}`, { id, ms: `${totalMs}ms`, error: e.message });
    res.status(timedOut ? 504 : 500).json({ error: timedOut ? 'LLM request timed out' : e.message, journeyId: id });
  } finally {
    releaseSlot(id);
  }
});

// ── /score/batch  (up to 10 journeys) ────────────────────────────────────────
app.post('/score/batch', async (req, res) => {
  if (!ollamaOnline) {
    log('warn', '/score/batch — rejected: Ollama is offline', { url: OLLAMA_BASE, lastChecked: ollamaLastChecked });
    return res.status(503).json({
      error: 'AI backend (Ollama) is currently offline. Please start Ollama and try again.',
      ollama: 'unreachable',
      lastChecked: ollamaLastChecked,
    });
  }

  const journeys = req.body?.journeys;
  if (!Array.isArray(journeys) || !journeys.length) {
    log('warn', '/score/batch — missing journeys array');
    return res.status(400).json({ error: 'Missing journeys array' });
  }

  const batch      = journeys.slice(0, 10);
  const batchStart = Date.now();
  log('info', '📦 Batch scoring started', { count: batch.length, ids: batch.map((j) => j.id).join(',') });

  const results = [];
  for (let i = 0; i < batch.length; i += 1) {
    const journey = batch[i];
    const { id, name, status } = journey;
    const itemStart = Date.now();

    log('info', `📦 Batch [${i + 1}/${batch.length}]`, { id, name: (name || '').slice(0, 35), status });

    await acquireSlot(id);
    try {
      const prompt = buildPrompt(journey);
      const { text: rawText, promptTokens, completionTokens } = await callOllama(prompt, id);
      const parsed  = extractJson(rawText, id);
      const itemMs  = Date.now() - itemStart;

      writeLlmFile(journey, prompt, rawText, parsed, itemMs);

      if (parsed) {
        log('info', `📦 Batch [${i + 1}/${batch.length}] done`, {
          id, ms: `${itemMs}ms`, score: parsed.retirementScore, verdict: parsed.retirementLabel,
          prompt_tokens: promptTokens, completion_tokens: completionTokens,
        });
      } else {
        log('warn', `📦 Batch [${i + 1}/${batch.length}] parse failed`, { id, ms: `${itemMs}ms` });
      }

      results.push({
        journeyId: id,
        ...(parsed || { error: 'parse-failed', raw: rawText.slice(0, 200) }),
        model: MODEL,
        _tokens: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
      });
    } catch (e) {
      const itemMs = Date.now() - itemStart;
      log('error', `📦 Batch [${i + 1}/${batch.length}] error`, { id, ms: `${itemMs}ms`, error: e.message });
      results.push({ journeyId: id, error: e.message });
    } finally {
      releaseSlot(id);
    }
  }

  const totalMs = Date.now() - batchStart;
  const ok      = results.filter((r) => !r.error).length;
  log('info', '📦 Batch complete', {
    total: batch.length, ok, failed: results.length - ok,
    ms: `${totalMs}ms`, avg_ms: `${Math.round(totalMs / batch.length)}ms`,
  });

  res.json({ results });
});

// ── /stats ────────────────────────────────────────────────────────────────────
app.get('/stats', (_req, res) => {
  const uptime = Math.round((Date.now() - new Date(tokenStats.startedAt).getTime()) / 1000);
  const stats  = {
    ...tokenStats,
    totalTokens: tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens,
    uptimeSeconds: uptime,
    model: MODEL,
  };
  log('info', '📊 Stats requested', {
    requests: stats.totalRequests,
    prompt_tokens: stats.totalPromptTokens,
    completion_tokens: stats.totalCompletionTokens,
    total_tokens: stats.totalTokens,
  });
  res.json(stats);
});

// ── /stats/reset ──────────────────────────────────────────────────────────────
app.post('/stats/reset', (_req, res) => {
  tokenStats.totalRequests         = 0;
  tokenStats.totalPromptTokens     = 0;
  tokenStats.totalCompletionTokens = 0;
  tokenStats.startedAt = new Date().toISOString();
  log('info', '📊 Stats reset');
  res.json({ ok: true, message: 'Token stats reset' });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  log('warn', '404 Not Found', { method: req.method, path: req.path });
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  log('error', 'Unhandled server error', { method: req.method, path: req.path, error: err.message });
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('\x1b[1m\x1b[35m🤖  AJO AI Proxy  started\x1b[0m');
  console.log('-'.repeat(48));
  log('info', 'Server listening', { port: PORT, url: `http://localhost:${PORT}` });
  log('info', 'Ollama backend',   { url: OLLAMA_BASE, model: MODEL });
  log('info', 'Queue settings',   { concurrency: LLM_CONCURRENCY, timeout_ms: REQUEST_TIMEOUT_MS });
  if (LOG_FILE)    log('info', 'Log file',    { path: path.resolve(LOG_FILE) });
  if (LLM_LOG_DIR) log('info', 'LLM log dir', { path: LLM_LOG_DIR });
  console.log('');
  console.log('\x1b[2mEndpoints:\x1b[0m');
  console.log(`  \x1b[36mGET  \x1b[0mhttp://localhost:${PORT}/health`);
  console.log(`  \x1b[36mPOST \x1b[0mhttp://localhost:${PORT}/score          { journey: {...} }`);
  console.log(`  \x1b[36mPOST \x1b[0mhttp://localhost:${PORT}/score/batch    { journeys: [...] }`);
  console.log(`  \x1b[36mGET  \x1b[0mhttp://localhost:${PORT}/stats           token usage counters`);
  console.log(`  \x1b[36mPOST \x1b[0mhttp://localhost:${PORT}/stats/reset     reset counters`);
  console.log('');
  console.log('\x1b[2mOptional env vars:\x1b[0m');
  console.log(`  PORT=${PORT}   OLLAMA_BASE=${OLLAMA_BASE}   MODEL=${MODEL}`);
  console.log(`  CONCURRENCY=${LLM_CONCURRENCY}   LOG_FILE=./proxy.log   LOG_LEVEL=debug|info|warn|error`);
  console.log(`  LLM_LOG_DIR=./llm-logs  (one .log file written per journey when set)`);
  console.log('');
});
