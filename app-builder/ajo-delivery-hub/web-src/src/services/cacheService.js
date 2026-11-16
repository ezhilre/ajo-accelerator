/**
 * IndexedDB Cache Service
 * Stores journey analysis snapshots for fast reload
 */

const DB_NAME = 'AJODeliveryHub';
const DB_VERSION = 1;
const SNAPSHOTS_STORE = 'snapshots';
const DELIVERY_STORE = 'delivery';
const MAX_SNAPSHOTS = 5;
const STALE_DAYS = 90;

class CacheService {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Snapshots store (for Analyze All results)
        if (!db.objectStoreNames.contains(SNAPSHOTS_STORE)) {
          const snapStore = db.createObjectStore(SNAPSHOTS_STORE, { keyPath: 'sandbox' });
          snapStore.createIndex('accessedAt', 'accessedAt', { unique: false });
        }

        // Delivery store (for Delivery Summary results)
        if (!db.objectStoreNames.contains(DELIVERY_STORE)) {
          const delivStore = db.createObjectStore(DELIVERY_STORE, { keyPath: 'key' });
          delivStore.createIndex('accessedAt', 'accessedAt', { unique: false });
        }
      };
    });
  }

  /**
   * Save journey analysis snapshot
   */
  async saveSnapshot(sandbox, journeys, aiScores) {
    try {
      await this.init();

      // Convert Map to plain object for storage
      const aiScoresObj = {};
      aiScores.forEach((value, key) => {
        aiScoresObj[key] = value;
      });

      const snapshot = {
        sandbox,
        analyzedAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        journeyCount: journeys.length,
        aiScoredCount: Array.from(aiScores.values()).filter(v => v.llm && !v.llm.error).length,
        journeys,
        aiScores: aiScoresObj
      };

      const tx = this.db.transaction([SNAPSHOTS_STORE], 'readwrite');
      const store = tx.objectStore(SNAPSHOTS_STORE);
      await store.put(snapshot);

      // Clean up old snapshots
      await this.cleanupOldSnapshots();

      return snapshot;
    } catch (error) {
      console.error('Failed to save snapshot:', error);
      throw error;
    }
  }

  /**
   * Load journey analysis snapshot
   */
  async loadSnapshot(sandbox) {
    try {
      await this.init();

      const tx = this.db.transaction([SNAPSHOTS_STORE], 'readwrite');
      const store = tx.objectStore(SNAPSHOTS_STORE);
      const snapshot = await store.get(sandbox);

      if (!snapshot) return null;

      // Update access time
      snapshot.accessedAt = new Date().toISOString();
      await store.put(snapshot);

      // Calculate age
      const analyzedDate = new Date(snapshot.analyzedAt);
      const daysOld = Math.floor((Date.now() - analyzedDate.getTime()) / 86400000);
      snapshot.daysOld = daysOld;
      snapshot.isStale = daysOld > STALE_DAYS;

      return snapshot;
    } catch (error) {
      console.error('Failed to load snapshot:', error);
      return null;
    }
  }

  /**
   * Clear snapshot for a sandbox
   */
  async clearSnapshot(sandbox) {
    try {
      await this.init();
      const tx = this.db.transaction([SNAPSHOTS_STORE], 'readwrite');
      const store = tx.objectStore(SNAPSHOTS_STORE);
      await store.delete(sandbox);
    } catch (error) {
      console.error('Failed to clear snapshot:', error);
    }
  }

  /**
   * List all snapshots
   */
  async listSnapshots() {
    try {
      await this.init();
      const tx = this.db.transaction([SNAPSHOTS_STORE], 'readonly');
      const store = tx.objectStore(SNAPSHOTS_STORE);
      const snapshots = await store.getAll();

      return snapshots.map(snap => {
        const analyzedDate = new Date(snap.analyzedAt);
        const daysOld = Math.floor((Date.now() - analyzedDate.getTime()) / 86400000);
        return {
          sandbox: snap.sandbox,
          analyzedAt: snap.analyzedAt,
          journeyCount: snap.journeyCount,
          aiScoredCount: snap.aiScoredCount,
          daysOld,
          isStale: daysOld > STALE_DAYS
        };
      });
    } catch (error) {
      console.error('Failed to list snapshots:', error);
      return [];
    }
  }

  /**
   * Hydrate AI scores from stored object back to Map
   */
  hydrateScores(aiScoresObj) {
    const map = new Map();
    if (aiScoresObj) {
      Object.entries(aiScoresObj).forEach(([key, value]) => {
        map.set(key, value);
      });
    }
    return map;
  }

  /**
   * Save delivery summary data
   */
  async saveDeliverySnapshot(sandbox, year, month, type, campaigns, aiScores) {
    try {
      await this.init();

      const key = `${sandbox}-${year}-${month}`;
      
      // Convert Map to object
      const aiScoresObj = {};
      aiScores.forEach((value, key) => {
        aiScoresObj[key] = value;
      });

      const snapshot = {
        key,
        sandbox,
        year,
        month,
        type,
        savedAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        count: campaigns.length,
        campaigns,
        aiScores: aiScoresObj
      };

      const tx = this.db.transaction([DELIVERY_STORE], 'readwrite');
      const store = tx.objectStore(DELIVERY_STORE);
      await store.put(snapshot);

      return snapshot;
    } catch (error) {
      console.error('Failed to save delivery snapshot:', error);
      throw error;
    }
  }

  /**
   * Load delivery summary data
   */
  async loadDeliverySnapshot(sandbox, year, month) {
    try {
      await this.init();

      const key = `${sandbox}-${year}-${month}`;
      const tx = this.db.transaction([DELIVERY_STORE], 'readwrite');
      const store = tx.objectStore(DELIVERY_STORE);
      const snapshot = await store.get(key);

      if (!snapshot) return null;

      // Update access time
      snapshot.accessedAt = new Date().toISOString();
      await store.put(snapshot);

      // Calculate age
      const savedDate = new Date(snapshot.savedAt);
      const daysOld = Math.floor((Date.now() - savedDate.getTime()) / 86400000);
      snapshot.daysOld = daysOld;
      snapshot.isStale = daysOld > 30; // Delivery data stale after 30 days

      return snapshot;
    } catch (error) {
      console.error('Failed to load delivery snapshot:', error);
      return null;
    }
  }

  /**
   * Clear delivery snapshot
   */
  async clearDeliverySnapshot(sandbox, year, month) {
    try {
      await this.init();
      const key = `${sandbox}-${year}-${month}`;
      const tx = this.db.transaction([DELIVERY_STORE], 'readwrite');
      const store = tx.objectStore(DELIVERY_STORE);
      await store.delete(key);
    } catch (error) {
      console.error('Failed to clear delivery snapshot:', error);
    }
  }

  /**
   * Clean up old snapshots (keep only MAX_SNAPSHOTS)
   */
  async cleanupOldSnapshots() {
    try {
      const tx = this.db.transaction([SNAPSHOTS_STORE], 'readwrite');
      const store = tx.objectStore(SNAPSHOTS_STORE);
      const index = store.index('accessedAt');
      const snapshots = await index.getAll();

      if (snapshots.length > MAX_SNAPSHOTS) {
        // Sort by accessedAt (oldest first)
        snapshots.sort((a, b) => 
          new Date(a.accessedAt).getTime() - new Date(b.accessedAt).getTime()
        );

        // Delete oldest
        const toDelete = snapshots.slice(0, snapshots.length - MAX_SNAPSHOTS);
        for (const snap of toDelete) {
          await store.delete(snap.sandbox);
        }
      }
    } catch (error) {
      console.error('Failed to cleanup snapshots:', error);
    }
  }

  /**
   * Get cache capacity info
   */
  async getCacheCapacity() {
    try {
      const snapshots = await this.listSnapshots();
      return {
        current: snapshots.length,
        max: MAX_SNAPSHOTS
      };
    } catch (error) {
      return { current: 0, max: MAX_SNAPSHOTS };
    }
  }

  /**
   * Clear all cache data
   */
  async clearAll() {
    try {
      await this.init();
      const tx = this.db.transaction([SNAPSHOTS_STORE, DELIVERY_STORE], 'readwrite');
      await tx.objectStore(SNAPSHOTS_STORE).clear();
      await tx.objectStore(DELIVERY_STORE).clear();
    } catch (error) {
      console.error('Failed to clear all cache:', error);
    }
  }
}

export default new CacheService();
