/**
 * Fix for AI-Scored Count Calculation
 * 
 * ISSUE FOUND:
 * The aiScoredCount calculation in saveSnapshot() filters for entries with e.llm,
 * but should specifically check for successful LLM results (not errors).
 */

// Current code (line 70 in jcc-cache.js):
// aiScoredCount: [...aiScores.values()].filter((e) => e.llm).length,

// Should be:
// aiScoredCount: [...aiScores.values()].filter((e) => e.llm && !e.llm.error).length,

export async function recalculateAiScoredCount() {
  console.log('🔧 Recalculating AI-Scored Count\n');
  
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
    
    if (!snap) {
      console.log('❌ No snapshot found');
      db.close();
      return null;
    }
    
    console.log('📊 Current Metadata:');
    console.log(`   Stored aiScoredCount: ${snap.aiScoredCount}`);
    console.log(`   journeyCount: ${snap.journeyCount}\n`);
    
    // Recalculate the CORRECT count
    const scores = snap.aiScores || {};
    const entries = Object.values(scores);
    
    const correctCount = entries.filter((e) => {
      // Must be an object with llm property that's not an error
      return e && typeof e === 'object' && e.llm && !e.llm.error;
    }).length;
    
    console.log('🔍 Detailed Breakdown:');
    const total = entries.length;
    const withLLM = entries.filter((e) => e && typeof e === 'object' && e.llm && !e.llm.error).length;
    const withLLMError = entries.filter((e) => e && typeof e === 'object' && e.llm && e.llm.error).length;
    const ruleOnly = entries.filter((e) => e && typeof e === 'object' && e.rule && !e.llm).length;
    const pending = entries.filter((e) => e === 'pending').length;
    const error = entries.filter((e) => e === 'error').length;
    
    console.log(`   Total entries: ${total}`);
    console.log(`   With successful LLM: ${withLLM}`);
    console.log(`   With LLM error: ${withLLMError}`);
    console.log(`   Rule-only (no LLM): ${ruleOnly}`);
    console.log(`   Pending: ${pending}`);
    console.log(`   Error: ${error}\n`);
    
    console.log('📝 Result:');
    console.log(`   Stored aiScoredCount: ${snap.aiScoredCount}`);
    console.log(`   Correct aiScoredCount: ${correctCount}`);
    
    if (snap.aiScoredCount !== correctCount) {
      console.log(`\n   ⚠️  MISMATCH! Stored count is ${snap.aiScoredCount === 0 && correctCount === 0 ? 'correct but' : 'WRONG'}`);
      console.log(`   The metadata shows ${snap.aiScoredCount} but should be ${correctCount}\n`);
      
      if (correctCount === 0) {
        console.log('💡 EXPLANATION:');
        console.log('   Your cache has 0 successful LLM analyses.');
        console.log('   All 100 entries are rule-based scores only.');
        console.log('   This is why "0 AI-scored" displays correctly!\n');
      }
    } else {
      console.log('\n   ✅ Count is CORRECT!\n');
    }
    
    db.close();
    
    return {
      storedCount: snap.aiScoredCount,
      correctCount,
      isCorrect: snap.aiScoredCount === correctCount,
      breakdown: { total, withLLM, withLLMError, ruleOnly, pending, error },
    };
    
  } catch (error) {
    console.error('❌ Error:', error);
    return null;
  }
}

if (typeof window !== 'undefined') {
  window.recalculateAiScoredCount = recalculateAiScoredCount;
  console.log('✅ Run: await recalculateAiScoredCount()');
}
