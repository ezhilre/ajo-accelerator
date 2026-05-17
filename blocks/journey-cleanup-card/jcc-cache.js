/**
 * jcc-cache.js — IndexedDB snapshot persistence for Journey Cleanup Dashboard
 *
 * Each sandbox gets its own snapshot record keyed by sandbox name.
 * Snapshots store: raw journey list + AI scores + metadata (timestamp, counts).
 *
 * Quarterly usage pattern:
 *   • Run fresh analysis once (~5–30 min with LLM)
 *   • Load from cache for the rest of the quarter (instant)
 *   • 90-day threshold triggers a stale warning
 */

const DB_NAME = 'jcc_dashboard';
const DB_VERSION = 1;
const STORE = 'snapshots';
const STALE_DAYS = 90;

// ── open / init DB ────────────────────────────────────────────────────────────

let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'sandbox' });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Save a snapshot for a sandbox.
 * @param {string} sandbox
 * @param {Object[]} journeys  — raw journey objects from AJO API
 * @param {Map<string,{rule,llm}>} aiScores — scoring results map
 * @returns {Promise<void>}
 */
export async function saveSnapshot(sandbox, journeys, aiScores) {
  const db = await openDb();
  const scoresObj = {};
  aiScores.forEach((v, k) => { scoresObj[k] = v; });
  const record = {
    sandbox,
    analyzedAt: new Date().toISOString(),
    journeyCount: journeys.length,
    aiScoredCount: [...aiScores.values()].filter((e) => e.llm).length,
    journeys,
    aiScores: scoresObj,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Load a snapshot for a sandbox.
 * @param {string} sandbox
 * @returns {Promise<{
 *   sandbox: string,
 *   analyzedAt: string,
 *   journeyCount: number,
 *   aiScoredCount: number,
 *   journeys: Object[],
 *   aiScores: Object,
 *   daysOld: number,
 *   isStale: boolean
 * } | null>}
 */
export async function loadSnapshot(sandbox) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(sandbox);
    req.onsuccess = () => {
      const record = req.result;
      if (!record) { resolve(null); return; }
      const daysOld = Math.floor((Date.now() - new Date(record.analyzedAt).getTime()) / 86400000);
      resolve({ ...record, daysOld, isStale: daysOld >= STALE_DAYS });
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete the snapshot for a sandbox.
 * @param {string} sandbox
 * @returns {Promise<void>}
 */
export async function clearSnapshot(sandbox) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(sandbox);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * List all stored snapshot metadata (no journey arrays — lightweight).
 * @returns {Promise<Array<{sandbox, analyzedAt, journeyCount, aiScoredCount, daysOld, isStale}>>}
 */
export async function listSnapshots() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const now = Date.now();
      const list = (req.result || []).map(({ sandbox, analyzedAt, journeyCount, aiScoredCount }) => {
        const daysOld = Math.floor((now - new Date(analyzedAt).getTime()) / 86400000);
        return { sandbox, analyzedAt, journeyCount, aiScoredCount, daysOld, isStale: daysOld >= STALE_DAYS };
      });
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Restore a Map<id, {rule,llm}> from a plain snapshot aiScores object.
 * @param {Object} aiScoresObj
 * @returns {Map<string,{rule,llm}>}
 */
export function hydrateScores(aiScoresObj) {
  const map = new Map();
  Object.entries(aiScoresObj || {}).forEach(([k, v]) => map.set(k, v));
  return map;
}

/**
 * Format an ISO date string as a human-readable "16 Apr 2026, 08:30" string.
 * @param {string} iso
 * @returns {string}
 */
export function fmtSnapshotDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
