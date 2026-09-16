/**
 * Check AI Score Details
 * Run this to see what type of scores are in your cache
 */

export async function checkAiScoreTypes() {
  console.log('🔍 Checking AI Score Types in Cache\n');
  
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
      const req = tx.objectStore(STORE).get('xlg-prod');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    
    db.close();
    
    if (!snap) {
      console.log('❌ No snapshot found');
      return null;
    }
    
    console.log('📊 Snapshot Metadata:');
    console.log(`   aiScoredCount: ${snap.aiScoredCount}`);
    console.log(`   journeyCount: ${snap.journeyCount}\n`);
    
    const scores = snap.aiScores || {};
    const ids = Object.keys(scores);
    
    console.log(`📦 Actual Score Entries: ${ids.length}\n`);
    
    let ruleOnly = 0;
    let withLLM = 0;
    let pending = 0;
    let error = 0;
    
    ids.forEach((id) => {
      const entry = scores[id];
      if (typeof entry === 'string') {
        if (entry === 'pending') pending++;
        else if (entry === 'error') error++;
        return;
      }
      
      if (entry.llm && !entry.llm.error) {
        withLLM++;
      } else if (entry.rule) {
        ruleOnly++;
      }
    });
    
    console.log('📋 Score Type Breakdown:');
    console.log(`   Rule-only (no LLM): ${ruleOnly}`);
    console.log(`   With LLM analysis: ${withLLM}`);
    console.log(`   Pending: ${pending}`);
    console.log(`   Error: ${error}\n`);
    
    if (withLLM === 0) {
      console.log('💡 EXPLANATION:');
      console.log('   Your cache has RULE-BASED scores only.');
      console.log('   "AI-scored" specifically means LLM analysis (GPT/Claude).');
      console.log('   \n   To get LLM scores:');
      console.log('   1. Enable "🧠 Smart AI Analyze" checkbox');
      console.log('   2. Make sure AI proxy is running');
      console.log('   3. Run fresh analysis or analyze existing cache\n');
    }
    
    // Sample a few scores to show structure
    console.log('📝 Sample Score Entries (first 3):\n');
    ids.slice(0, 3).forEach((id, i) => {
      const entry = scores[id];
      console.log(`${i + 1}. Journey ID: ${id.slice(0, 8)}...`);
      if (typeof entry === 'string') {
        console.log(`   Type: ${entry}`);
      } else {
        console.log(`   Has rule score: ${!!entry.rule} (score: ${entry.rule?.score})`);
        console.log(`   Has LLM: ${!!entry.llm && !entry.llm?.error}`);
        if (entry.llm && !entry.llm.error) {
          console.log(`   LLM verdict: ${entry.llm.retirementLabel}`);
        }
      }
      console.log('');
    });
    
    return {
      ruleOnly,
      withLLM,
      pending,
      error,
      needsLLM: withLLM === 0 && ruleOnly > 0,
    };
    
  } catch (error) {
    console.error('❌ Error:', error);
    return null;
  }
}

if (typeof window !== 'undefined') {
  window.checkAiScoreTypes = checkAiScoreTypes;
  console.log('✅ Run: await checkAiScoreTypes()');
}
