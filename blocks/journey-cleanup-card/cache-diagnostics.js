/**
 * Cache Diagnostics Tool
 * Run this in browser console to diagnose cache issues
 */

export async function diagnoseCacheIssues() {
  console.log('🔍 Journey Cleanup Card - Cache Diagnostics\n');
  
  const DB_NAME = 'jcc_dashboard';
  const DB_VERSION = 2;
  const STORE = 'snapshots';
  
  try {
    // 1. Check if IndexedDB is available
    console.log('1️⃣ Checking IndexedDB availability...');
    if (!window.indexedDB) {
      console.error('❌ IndexedDB is not supported in this browser');
      return { error: 'IndexedDB not supported' };
    }
    console.log('✅ IndexedDB is available\n');
    
    // 2. Open the database
    console.log('2️⃣ Opening database...');
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database blocked'));
    });
    console.log(`✅ Database opened: ${db.name} (version ${db.version})\n`);
    
    // 3. Check if object store exists
    console.log('3️⃣ Checking object stores...');
    const storeNames = Array.from(db.objectStoreNames);
    console.log(`   Object stores found: ${storeNames.join(', ')}`);
    
    if (!db.objectStoreNames.contains(STORE)) {
      console.error(`❌ Object store "${STORE}" not found`);
      db.close();
      return { error: `Object store "${STORE}" missing` };
    }
    console.log(`✅ Object store "${STORE}" exists\n`);
    
    // 4. Read all snapshots
    console.log('4️⃣ Reading all snapshots...');
    const snapshots = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    
    console.log(`   Found ${snapshots.length} snapshot(s)\n`);
    
    // 5. Display snapshot details
    if (snapshots.length === 0) {
      console.warn('⚠️  No snapshots found in cache');
      console.log('\n💡 This means either:');
      console.log('   • The cache was never saved properly');
      console.log('   • The cache was cleared');
      console.log('   • The analysis didn\'t complete successfully');
      db.close();
      return { snapshots: [], isEmpty: true };
    }
    
    console.log('5️⃣ Snapshot Details:\n');
    const results = [];
    
    snapshots.forEach((snap, idx) => {
      const daysOld = Math.floor((Date.now() - new Date(snap.analyzedAt).getTime()) / 86400000);
      
      console.log(`📦 Snapshot #${idx + 1}:`);
      console.log(`   Sandbox: ${snap.sandbox}`);
      console.log(`   Analyzed: ${snap.analyzedAt}`);
      console.log(`   Accessed: ${snap.accessedAt || 'N/A'}`);
      console.log(`   Age: ${daysOld} days old`);
      console.log(`   Journey Count: ${snap.journeyCount}`);
      console.log(`   AI Scored Count: ${snap.aiScoredCount}`);
      console.log(`   Journeys Array: ${snap.journeys ? snap.journeys.length : 0} items`);
      console.log(`   AI Scores Keys: ${snap.aiScores ? Object.keys(snap.aiScores).length : 0} items`);
      
      // Check for data integrity issues
      const issues = [];
      if (snap.journeyCount !== snap.journeys?.length) {
        issues.push(`⚠️  Journey count mismatch: ${snap.journeyCount} reported but ${snap.journeys?.length || 0} in array`);
      }
      if (snap.aiScoredCount > (snap.aiScores ? Object.keys(snap.aiScores).length : 0)) {
        issues.push(`⚠️  AI score count mismatch: ${snap.aiScoredCount} reported but ${Object.keys(snap.aiScores || {}).length} in map`);
      }
      if (!snap.journeys || snap.journeys.length === 0) {
        issues.push('❌ CRITICAL: No journey data stored');
      }
      
      if (issues.length > 0) {
        console.log('\n   🚨 Issues detected:');
        issues.forEach(issue => console.log(`      ${issue}`));
      } else {
        console.log('   ✅ No integrity issues detected');
      }
      console.log('');
      
      results.push({
        sandbox: snap.sandbox,
        analyzedAt: snap.analyzedAt,
        daysOld,
        journeyCount: snap.journeyCount,
        actualJourneyCount: snap.journeys?.length || 0,
        aiScoredCount: snap.aiScoredCount,
        actualAiScoreCount: Object.keys(snap.aiScores || {}).length,
        issues: issues.length > 0 ? issues : null,
        hasData: snap.journeys && snap.journeys.length > 0,
      });
    });
    
    db.close();
    
    // 6. Summary
    console.log('\n📊 Summary:');
    console.log(`   Total snapshots: ${snapshots.length}`);
    const withData = results.filter(r => r.hasData).length;
    const withIssues = results.filter(r => r.issues).length;
    console.log(`   Snapshots with data: ${withData}`);
    console.log(`   Snapshots with issues: ${withIssues}`);
    
    if (withIssues > 0) {
      console.log('\n⚠️  RECOMMENDATION: Cache appears corrupted. Try clearing it:');
      console.log('   1. Click "🗑 Clear cache" button in the UI, or');
      console.log('   2. Run: await clearAllCache()');
    } else if (withData === 0) {
      console.log('\n⚠️  RECOMMENDATION: No valid cached data. Run a fresh analysis.');
    } else {
      console.log('\n✅ Cache appears healthy!');
    }
    
    return {
      dbName: DB_NAME,
      dbVersion: DB_VERSION,
      snapshotCount: snapshots.length,
      snapshots: results,
      healthy: withIssues === 0 && withData > 0,
    };
    
  } catch (error) {
    console.error('❌ Error during diagnostics:', error);
    return { error: error.message, stack: error.stack };
  }
}

export async function clearAllCache() {
  console.log('🗑️  Clearing all cached data...\n');
  
  const DB_NAME = 'jcc_dashboard';
  const DB_VERSION = 2;
  const STORE = 'snapshots';
  
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    
    db.close();
    console.log('✅ Cache cleared successfully');
    return { success: true };
    
  } catch (error) {
    console.error('❌ Error clearing cache:', error);
    return { success: false, error: error.message };
  }
}

export async function inspectSnapshot(sandboxName) {
  console.log(`🔍 Inspecting snapshot for sandbox: ${sandboxName}\n`);
  
  const DB_NAME = 'jcc_dashboard';
  const DB_VERSION = 2;
  const STORE = 'snapshots';
  
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    
    const snap = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get(sandboxName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    
    db.close();
    
    if (!snap) {
      console.log(`❌ No snapshot found for sandbox "${sandboxName}"`);
      return null;
    }
    
    console.log('📦 Snapshot found:');
    console.log(JSON.stringify(snap, null, 2));
    
    return snap;
    
  } catch (error) {
    console.error('❌ Error inspecting snapshot:', error);
    return null;
  }
}

// Auto-run diagnostics if loaded directly
if (typeof window !== 'undefined') {
  window.diagnoseCacheIssues = diagnoseCacheIssues;
  window.clearAllCache = clearAllCache;
  window.inspectSnapshot = inspectSnapshot;
  
  console.log('✅ Cache diagnostics loaded. Available commands:');
  console.log('   • await diagnoseCacheIssues() - Run full diagnostics');
  console.log('   • await clearAllCache() - Clear all cached data');
  console.log('   • await inspectSnapshot("sandbox-name") - Inspect specific sandbox');
}
