/**
 * lib/logger.js — structured console + file logger + per-journey LLM log writer
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config (read from env at require-time) ────────────────────────────────────
const LOG_FILE    = process.env.LOG_FILE    || null;
const LOG_LEVELS  = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL   = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;
const LLM_LOG_DIR = process.env.LLM_LOG_DIR ? path.resolve(process.env.LLM_LOG_DIR) : null;
const MODEL       = process.env.MODEL || 'llama3';

// ── Console colour helpers ────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';

const LEVEL_ICONS  = { debug: '🔍', info: '✅', warn: '⚠ ', error: '❌' };
const LEVEL_COLORS = { debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };

// ── Optional file stream ──────────────────────────────────────────────────────
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

// ── log() ─────────────────────────────────────────────────────────────────────
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

  if (logFileStream) {
    logFileStream.write(JSON.stringify({ ts, level, message, ...meta }) + '\n');
  }
}

// ── sanitizeName() ────────────────────────────────────────────────────────────
function sanitizeName(name) {
  return (name || 'unnamed')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/__+/g, '_')
    .slice(0, 60);
}

// ── writeLlmFile() ────────────────────────────────────────────────────────────
/**
 * Write one .log file per journey capturing both agents:
 *   Agent 1 — Audience Resolver
 *   Agent 2 — Journey Scorer
 *
 * @param {object}   journey         - journey object
 * @param {string}   prompt          - scoring prompt sent to LLM (Agent 2)
 * @param {string}   raw             - raw LLM response text (Agent 2)
 * @param {object}   parsed          - parsed JSON result (Agent 2)
 * @param {number}   durationMs      - total scoring duration ms
 * @param {Array}    audienceResults - resolved audience objects from Agent 1 (may be empty)
 */
function writeLlmFile(journey, prompt, raw, parsed, durationMs, audienceResults) {
  if (!LLM_LOG_DIR) return;
  try {
    if (!fs.existsSync(LLM_LOG_DIR)) fs.mkdirSync(LLM_LOG_DIR, { recursive: true });

    const id       = journey.id || 'unknown';
    const ts       = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = sanitizeName(journey.name);
    const fileName = `${id}_${safeName}_${ts}.log`;
    const filePath = path.join(LLM_LOG_DIR, fileName);

    const SEP   = '='.repeat(80);
    const THICK = '━'.repeat(80);
    const DIV   = '-'.repeat(80);

    const lines = [
      SEP,
      `Journey ID     : ${id}`,
      `Journey Name   : ${journey.name || '(unnamed)'}`,
      `Status         : ${journey.status || 'unknown'}`,
      `Days Stale     : ${journey._daysStale || 0}`,
      `Model          : ${MODEL}`,
      `Scored At      : ${new Date().toISOString()}`,
      `Total Duration : ${durationMs}ms`,
      SEP,
      '',
    ];

    // ── AGENT 1 — AUDIENCE RESOLVER ──────────────────────────────────────────
    lines.push(THICK);
    lines.push('AGENT 1 — AUDIENCE RESOLVER');
    lines.push(THICK);

    const resolved = Array.isArray(audienceResults) ? audienceResults : [];

    if (!resolved.length) {
      lines.push('  No audiences found in this journey (or audience resolution skipped).');
    } else {
      lines.push(`  Audiences found : ${resolved.length}`);
      resolved.forEach((a, i) => {
        lines.push('');
        lines.push(DIV);
        lines.push(`  [${i + 1}] Audience ID   : ${a.id || '(unknown)'}`);
        lines.push(`       Name          : ${a.name || '(unnamed)'}`);
        lines.push(`       API Status    : ${a.apiStatus || 'unknown'}`);
        lines.push(`       Duration      : ${a.durationMs != null ? a.durationMs + 'ms' : 'n/a'}`);

        if (a.normalized) {
          lines.push('');
          lines.push('       NORMALIZED RULE:');
          JSON.stringify(a.normalized, null, 4).split('\n').forEach((l) => lines.push(`         ${l}`));
        } else {
          lines.push('       NORMALIZED RULE: (unavailable)');
        }

        lines.push('');
        lines.push(`       PLAIN ENGLISH : ${a.plainEnglish || '(LLM failed or skipped)'}`);

        if (a.llmPrompt) {
          lines.push('');
          lines.push('       LLM PROMPT:');
          lines.push('       ' + DIV.slice(7));
          a.llmPrompt.split('\n').forEach((l) => lines.push(`       ${l}`));
        }

        if (a.llmRaw) {
          lines.push('');
          lines.push('       LLM RAW RESPONSE:');
          lines.push('       ' + DIV.slice(7));
          lines.push(`       ${a.llmRaw.slice(0, 500)}`);
        }

        if (a.error) {
          lines.push('');
          lines.push(`       ERROR: ${a.error}`);
        }
      });
    }

    lines.push('');
    lines.push(SEP);
    lines.push('');

    // ── AGENT 2 — JOURNEY SCORER ──────────────────────────────────────────────
    lines.push(THICK);
    lines.push('AGENT 2 — JOURNEY SCORER');
    lines.push(THICK);
    lines.push('');
    lines.push('PROMPT:');
    lines.push(DIV);
    lines.push(prompt);
    lines.push(SEP);
    lines.push('RAW RESPONSE:');
    lines.push(DIV);
    lines.push(raw || '(empty)');
    lines.push(SEP);
    lines.push('PARSED RESULT:');
    lines.push(DIV);

    if (parsed) {
      const fields = [
        ['retirementScore',          parsed.retirementScore],
        ['retirementLabel',          parsed.retirementLabel],
        ['confidence',               parsed.confidence],
        ['businessValue',            parsed.businessValue],
        ['journeyType',              parsed.journeyType],
        ['lifecycleStage',           parsed.lifecycleStage],
        ['customerExperience',       parsed.customerExperience],
        ['behaviorTargeted',         parsed.behaviorTargeted],
        ['businessObjective',        parsed.businessObjective],
        ['whyTeamBuiltThis',         parsed.whyTeamBuiltThis],
        ['useCaseSummary',           parsed.useCaseSummary],
        ['targetAudience',           parsed.targetAudience],
        ['businessPurpose',          parsed.businessPurpose],
        ['lifecycleDecision',        parsed.lifecycleDecision],
        ['governanceReviewPriority', parsed.governanceReviewPriority],
        ['reasoning',                parsed.reasoning],
        ['recommendation',           parsed.recommendation],
      ];
      fields.forEach(([k, v]) => {
        if (v !== undefined && v !== null) lines.push(`  ${k.padEnd(24)}: ${v}`);
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

module.exports = { log, sanitizeName, writeLlmFile, LOG_LEVEL, LOG_LEVELS, LLM_LOG_DIR };
