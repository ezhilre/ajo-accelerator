/**
 * Rule-based journey scoring calculator
 * Calculates retirement risk scores based on staleness, naming patterns, and status
 */

const DEFAULT_NAME_RE = /^Journey\s*[\-_]?\s*\d+\s*(v\d+)?$/i;

export function isDefaultJourneyName(name) {
  return !!name && DEFAULT_NAME_RE.test(name.trim());
}

export function daysAgo(isoDate) {
  if (!isoDate) return 0;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

export function computeRuleScore(journey) {
  const days = daysAgo(journey.metadata?.lastModifiedAt);
  const name = journey.name || '';
  const status = (journey.status || '').toLowerCase();
  const version = parseInt(journey.version || '1', 10);
  
  let score = 0;
  const signals = [];

  // Signal 1: Default name (never renamed)
  if (isDefaultJourneyName(name)) {
    score += 25;
    signals.push({ 
      label: 'AJO default name (never renamed)', 
      points: 25, 
      type: 'critical' 
    });
  }

  // Signal 2: Stale indicator words in name
  const badWords = /\b(test|copy|old|tmp|temp|backup|delete|unused|demo|sample|draft|v1|v2|v3|poc|prototype|placeholder|dummy)\b/i;
  if (!isDefaultJourneyName(name) && badWords.test(name)) {
    score += 10;
    signals.push({ 
      label: 'Name contains stale indicator (weak contextual signal)', 
      points: 10, 
      type: 'warning' 
    });
  }

  // Signal 3: Days stale (major factor)
  if (days > 180) {
    score += 35;
    signals.push({ 
      label: `${days} days stale (>180d)`, 
      points: 35, 
      type: 'critical' 
    });
  } else if (days > 120) {
    score += 25;
    signals.push({ 
      label: `${days} days stale (>120d)`, 
      points: 25, 
      type: 'warning' 
    });
  } else if (days > 90) {
    score += 15;
    signals.push({ 
      label: `${days} days stale (>90d)`, 
      points: 15, 
      type: 'warning' 
    });
  } else if (days > 60) {
    score += 8;
    signals.push({ 
      label: `${days} days stale (>60d)`, 
      points: 8, 
      type: 'ok' 
    });
  }

  // Signal 4: Status indicators
  if (status === 'failed') {
    score += 15;
    signals.push({ 
      label: 'Status: failed', 
      points: 15, 
      type: 'warning' 
    });
  } else if (status === 'draft') {
    score += 7;
    signals.push({ 
      label: 'Status: draft (not deployed yet)', 
      points: 7, 
      type: 'warning' 
    });
  } else if (status === 'stopped' || status === 'closed') {
    score += 8;
    signals.push({ 
      label: `Status: ${status}`, 
      points: 8, 
      type: 'ok' 
    });
  }

  // Signal 5: Version 1 (never iterated)
  if (version <= 1) {
    score += 8;
    signals.push({ 
      label: 'Version 1 (never iterated)', 
      points: 8, 
      type: 'ok' 
    });
  }

  // Cap at 100
  const finalScore = Math.min(100, score);
  
  // Determine label and color
  const label = finalScore >= 80 ? 'Safe to Delete' 
    : finalScore >= 50 ? 'Review First' 
    : 'Likely Active';
  
  const color = finalScore >= 80 ? 'red' 
    : finalScore >= 50 ? 'yellow' 
    : 'green';

  return { 
    score: finalScore, 
    signals, 
    label, 
    color 
  };
}

export function combineScores(ruleScore, llmResult) {
  if (!llmResult || llmResult.error) {
    return ruleScore.score;
  }

  // High-value journeys: LLM evidence dominates (80%) over rule heuristics (20%)
  // to prevent staleness/naming penalties from overriding strong business intent signals
  const isHighValue = llmResult.businessValue === 'high' 
    && (llmResult.retirementScore || 100) <= 40;
  
  const ruleWeight = isHighValue ? 0.2 : 0.4;
  const llmWeight = isHighValue ? 0.8 : 0.6;
  
  return Math.round(ruleScore.score * ruleWeight + (llmResult.retirementScore || 0) * llmWeight);
}

export function getCategoryFromScore(score) {
  if (score >= 80) return 'retire';
  if (score >= 50) return 'review';
  return 'keep';
}

export function getAgeBucket(days) {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}
