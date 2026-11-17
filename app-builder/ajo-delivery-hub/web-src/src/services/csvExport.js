/**
 * CSV Export Service
 * Handles exporting journey and delivery data to CSV format
 */

import { daysAgo } from '../utils/scoreCalculator';

function escapeCSV(value) {
  const str = String(value ?? '');
  return str.includes(',') || str.includes('"') || str.includes('\n') 
    ? `"${str.replace(/"/g, '""')}"` 
    : str;
}

function formatDate(isoDate) {
  if (!isoDate) return '';
  return new Date(isoDate).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getStatusLabel(status) {
  const labels = {
    live: 'Deployed',
    deployed: 'Deployed',
    closed: 'Finished',
    finished: 'Finished',
    stopped: 'Stopped',
    draft: 'Draft',
    failed: 'Failed'
  };
  return labels[(status || '').toLowerCase()] || status || '—';
}

/**
 * Export journeys to CSV
 */
export function exportJourneysCsv(journeys, config, aiScores = null) {
  const headers = [
    'ID',
    'Name',
    'Status',
    'Version',
    'Sandbox',
    'Created By',
    'Created At',
    'Last Modified By',
    'Last Modified At',
    'Days Stale',
    'Rule Score',
    'AI Score (Blended)',
    'AI Verdict',
    'Journey Type',
    'Use Case Summary',
    'Target Audience',
    'Business Value',
    'Business Purpose',
    'AI Reasoning',
    'Recommendation',
    'AI Confidence',
    'AJO URL'
  ];

  const rows = journeys.map(j => {
    const aiEntry = aiScores ? aiScores.get(j.id) : null;
    const rule = aiEntry?.rule || null;
    const llm = aiEntry?.llm && !aiEntry.llm.error ? aiEntry.llm : null;
    
    const ruleScore = rule ? rule.score : '';
    const blended = (rule && llm) 
      ? Math.round(rule.score * 0.4 + (llm.retirementScore || 0) * 0.6)
      : (rule ? rule.score : '');

    const ajoUrl = config 
      ? `https://experience.adobe.com/#/@${encodeURIComponent(config.tenantId)}/sname:${encodeURIComponent(config.sandbox)}/journey-optimizer/journeys/journey/${j.id}`
      : '';

    return [
      j.id,
      j.name,
      getStatusLabel(j.status),
      j.version,
      j.sandboxName,
      j.metadata?.createdBy,
      j.metadata?.createdAt,
      j.metadata?.lastModifiedBy,
      j.metadata?.lastModifiedAt,
      daysAgo(j.metadata?.lastModifiedAt),
      ruleScore,
      blended,
      llm ? llm.retirementLabel : (rule ? (rule.score >= 80 ? 'Safe to Delete' : rule.score >= 50 ? 'Review First' : 'Keep Active') : ''),
      llm ? llm.journeyType : '',
      llm ? llm.useCaseSummary : '',
      llm ? llm.targetAudience : '',
      llm ? llm.businessValue : '',
      llm ? llm.businessPurpose : '',
      llm ? llm.reasoning : '',
      llm ? llm.recommendation : '',
      llm ? llm.confidence : '',
      ajoUrl
    ].map(escapeCSV).join(',');
  });

  const csv = [headers.map(escapeCSV).join(','), ...rows].join('\r\n');
  return csv;
}

/**
 * Export delivery summary to CSV
 */
export function exportDeliverySummaryCsv(items, config) {
  const headers = [
    'Name',
    'URL',
    'Type',
    'Description',
    'Tags',
    'Channels',
    'Version ID',
    'Status',
    'Owner',
    'Published At',
    'Last Modified At',
    'AI Journey Type',
    'AI Lifecycle Stage',
    'AI Use Case Summary',
    'AI Target Audience',
    'AI Customer Experience',
    'AI Behavior Targeted',
    'AI Business Objective',
    'AI Business Value',
    'AI Why Team Built This',
    'AI Reasoning',
    'AI Recommendation',
    'AI Confidence'
  ];

  const rows = items.map(item => {
    const tags = (item.tags || []).map(t => t.name || '').filter(Boolean).join(', ');
    
    // Handle channels differently for journeys vs campaigns
    const channels = item._type === 'journey'
      ? (item._channels || '')
      : [...new Set((item.packages || []).flatMap(p => p.channel ? [p.channel] : []))].join(', ');

    const pubDate = item.publishedAt ? new Date(Number(item.publishedAt)).toISOString() : '';
    const modDate = item.modifiedAt ? new Date(Number(item.modifiedAt)).toISOString() : '';
    
    const itemUrl = config 
      ? (item._type === 'journey'
        ? `https://experience.adobe.com/#/@${config.tenantId}/sname:${encodeURIComponent(config.sandbox)}/journey-optimizer/journeys/journey/${encodeURIComponent(item.campaignId)}`
        : `https://experience.adobe.com/#/@${config.tenantId}/sname:${encodeURIComponent(config.sandbox)}/journey-optimizer/campaigns/review/${encodeURIComponent(item.versionId || item.campaignId)}`)
      : '';

    const type = item._type === 'journey' ? 'Journey' : 'Campaign';

    // AI fields from aiSummary attached to item
    const ai = item.aiSummary || {};
    
    return [
      item.name || '',
      itemUrl,
      type,
      item.description || '',
      tags,
      channels,
      item.versionId || '',
      item.status || '',
      item.createdByName || item.createdBy || '',
      pubDate,
      modDate,
      ai.journeyType || '',
      ai.lifecycleStage || '',
      ai.useCaseSummary || '',
      ai.targetAudience || '',
      ai.customerExperience || '',
      ai.behaviorTargeted || '',
      ai.businessObjective || '',
      ai.businessValue || '',
      ai.whyTeamBuiltThis || '',
      ai.reasoning || '',
      ai.recommendation || '',
      ai.confidence || ''
    ].map(escapeCSV).join(',');
  });

  const csv = [headers.map(escapeCSV).join(','), ...rows].join('\r\n');
  return csv;
}

/**
 * Export deletion results to CSV
 */
export function exportDeletionResultsCsv(results) {
  const headers = [
    'Journey ID',
    'Status',
    'Error Message',
    'Timestamp',
    'Response Code',
    'Duration (ms)'
  ];

  const rows = results.map(r => [
    r.journeyId,
    r.status,
    r.errorMessage || '',
    r.timestamp,
    r.responseCode || '',
    r.duration
  ].map(escapeCSV).join(','));

  return [headers.map(escapeCSV).join(','), ...rows].join('\r\n');
}

/**
 * Trigger CSV download
 */
export function downloadCsv(csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  
  // Clean up
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default {
  exportJourneysCsv,
  exportDeliverySummaryCsv,
  exportDeletionResultsCsv,
  downloadCsv
};
