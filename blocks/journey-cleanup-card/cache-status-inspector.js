/**
 * Cache Status Inspector - Check why UI shows 0s
 */

export async function inspectCacheStatus(sandboxName = 'xlg-prod') {
  console.log(`🔍 Inspecting cache status for: ${sandboxName}\n`);
  
  const DB_NAME = 'jcc_dashboard';
  const DB_VERSION = 2;
  const STORE = 'snapshots';
  const STALE_DAYS = 30;
  
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    
    const snap = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(sandboxName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    
    db.close();
    
    if (!snap) {
      console.log(`❌ No snapshot found for "${sandboxName}"`);
      return null;
    }
    
    console.log('📦 Cached Data Overview:\n');
    console.log(`   Total journeys in cache: ${snap.journeys?.length || 0}`);
    console.log(`   AI scores in cache: ${Object.keys(snap.aiScores || {}).length}`);
    console.log(`   Analyzed: ${snap.analyzedAt}`);
    console.log(`   Age: ${Math.floor((Date.now() - new Date(snap.analyzedAt).getTime()) / 86400000)} days\n`);
    
    // Calculate stale cutoff (30+ days)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - STALE_DAYS);
    console.log(`⏰ Stale cutoff date: ${cutoffDate.toISOString()}`);
    console.log(`   (Journeys not modified since this date are "stale")\n`);
    
    // Analyze journeys
    const journeys = snap.journeys || [];
    const statusCounts = { total: 0, draft: 0, live: 0, deployed: 0, finished: 0, closed: 0, stopped: 0, failed: 0 };
    const staleCounts = { total: 0, draft: 0, live: 0, deployed: 0, finished: 0, closed: 0, stopped: 0, failed: 0 };
    const aiScoredCount = { total: 0, withLLM: 0, ruleOnly: 0, pending: 0, error: 0 };
    
    journeys.forEach(j => {
      const status = (j.status || 'unknown').toLowerCase();
      const lastMod = j.metadata?.lastModifiedAt;
      const isStale = lastMod && new Date(lastMod) < cutoffDate;
      
      // Count all journeys by status
      statusCounts.total++;
      if (statusCounts[status] !== undefined) statusCounts[status]++;
      
      // Count stale journeys by status
      if (isStale) {
        staleCounts.total++;
        if (staleCounts[status] !== undefined) staleCounts[status]++;
      }
      
      // Check AI scores
      const aiScore = snap.aiScores?.[j.id];
      if (aiScore) {
        aiScoredCount.total++;
        if (aiScore.llm && !aiScore.llm.error) aiScoredCount.withLLM++;
        else if (aiScore === 'pending') aiScoredCount.pending++;
        else if (aiScore === 'error' || (aiScore.llm && aiScore.llm.error)) aiScoredCount.error++;
        else if (aiScore.rule) aiScoredCount.ruleOnly++;
      }
    });
    
    console.log('📊 ALL Journeys Breakdown:\n');
    console.log(`   Total: ${statusCounts.total}`);
    console.log(`   Draft: ${statusCounts.draft}`);
    console.log(`   Live: ${statusCounts.live}`);
    console.log(`   Deployed: ${statusCounts.deployed}`);
    console.log(`   Finished: ${statusCounts.finished}`);
    console.log(`   Closed: ${statusCounts.closed}`);
    console.log(`   Stopped: ${statusCounts.stopped}`);
    console.log(`   Failed: ${statusCounts.failed}\n`);
    
    console.log('📊 STALE Journeys (30+ days old) Breakdown:\n');
    console.log(`   Total stale: ${staleCounts.total}`);
    console.log(`   Draft: ${staleCounts.draft}`);
    console.log(`   Live: ${staleCounts.live}`);
    console.log(`   Deployed: ${staleCounts.deployed}`);
    console.log(`   Finished: ${staleCounts.finished}`);
    console.log(`   Closed: ${staleCounts.closed}`);
    console.log(`   Stopped: ${staleCounts.stopped}`);
    console.log(`   Failed: ${staleCounts.failed}\n`);
    
    console.log('🤖 AI Scoring Status:\n');
    console.log(`   Total with scores: ${aiScoredCount.total}`);
    console.log(`   With LLM analysis: ${aiScoredCount.withLLM}`);
    console.log(`   Rule-only: ${aiScoredCount.ruleOnly}`);
    console.log(`   Pending: ${aiScoredCount.pending}`);
    console.log(`   Errors: ${aiScoredCount.error}\n`);
    
    // Analysis
    console.log('💡 Analysis:\n');
    
    if (staleCounts.total === 0) {
      console.log('⚠️  ISSUE FOUND: NO stale journeys (30+ days old)!');
      console.log('   This is why the UI shows 0s everywhere.');
      console.log('   Your 100 journeys were all modified within the last 30 days.');
      console.log('\n   Solutions:');
      console.log('   1. Wait until journeys are 30+ days old');
      console.log('   2. Change STALE_DAYS constant in code to a lower value (e.g., 7 days)');
      console.log('   3. These journeys are too "fresh" for governance cleanup\n');
    } else {
      console.log(`✅ Found ${staleCounts.total} stale journeys that should appear in the dashboard\n`);
    }
    
    if (aiScoredCount.withLLM === 0 && aiScoredCount.ruleOnly > 0) {
      console.log('ℹ️  AI was not enabled during the analysis (rule-based scores only)');
      console.log('   To get AI insights, enable "Smart AI Analyze" before fetching\n');
    }
    
    // Show sample journey dates
    console.log('📅 Sample Journey Last Modified Dates (first 5):\n');
    journeys.slice(0, 5).forEach((j, i) => {
      const lastMod = j.metadata?.lastModifiedAt;
      const daysAgo = lastMod ? Math.floor((Date.now() - new Date(lastMod).getTime()) / 86400000) : 'N/A';
      const isStale = lastMod && new Date(lastMod) < cutoffDate;
      console.log(`   ${i + 1}. ${j.name || j.id}`);
      console.log(`      Last modified: ${lastMod || 'Unknown'}`);
      console.log(`      Days ago: ${daysAgo}`);
      console.log(`      Is stale? ${isStale ? '✅ YES' : '❌ NO (too recent)'}\n`);
    });
    
    return {
      sandbox: sandboxName,
      totalJourneys: statusCounts.total,
      staleJourneys: staleCounts.total,
      staleCounts,
      aiScoredCount,
      issueSummary: staleCounts.total === 0 ? 'NO_STALE_JOURNEYS' : 'HEALTHY',
    };
    
  } catch (error) {
    console.error('❌ Error:', error);
    return null;
  }
}

// Auto-load
if (typeof window !== 'undefined') {
  window.inspectCacheStatus = inspectCacheStatus;
  console.log('✅ Cache status inspector loaded. Run:');
  console.log('   await inspectCacheStatus("xlg-prod")');
}
