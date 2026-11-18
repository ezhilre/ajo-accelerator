/*
 * Delivery Summary Component
 * Monthly delivery reports for Journeys and Campaigns - matches EDS UI
 */

import React, { useState } from 'react';
import {
  View,
  Flex,
  Picker,
  Item,
  Button,
  Text,
  ProgressCircle,
  TextField,
  Well,
  Heading,
  ActionButton,
  Dialog,
  DialogTrigger,
  Content,
  Divider,
  ButtonGroup
} from '@adobe/react-spectrum';
import Download from '@spectrum-icons/workflow/Download';
import Refresh from '@spectrum-icons/workflow/Refresh';
import Search from '@spectrum-icons/workflow/Search';
import Info from '@spectrum-icons/workflow/Info';
import { downloadCsv, exportDeliverySummaryCsv } from '../services/csvExport';
import actionWebInvoke from '../utils/actions';

// Helper functions for journey type styling (matches EDS patterns)
const getJourneyTypeIcon = (type) => {
  const icons = {
    'Welcome': '👋',
    'Promotional': '📣',
    'Transactional': '🧾',
    'Re-engagement': '🔄',
    'Abandoned Cart': '🛒',
    'Onboarding': '🚀',
    'Retention': '🤝',
    'Test/POC': '🧪',
    'Unknown': '❓'
  };
  return icons[type] || '📋';
};

const getJourneyTypeColor = (type) => {
  const colors = {
    'Welcome': '#4CAF50',
    'Promotional': '#FF9800',
    'Transactional': '#2196F3',
    'Re-engagement': '#9C27B0',
    'Abandoned Cart': '#F44336',
    'Onboarding': '#00BCD4',
    'Retention': '#009688',
    'Test/POC': '#795548',
    'Unknown': '#9E9E9E'
  };
  return colors[type] || '#607D8B';
};

const DeliverySummary = ({ credentials }) => {
  const [selectedMonthIndex, setSelectedMonthIndex] = useState(0);
  const [selectedType, setSelectedType] = useState('campaign'); // 'campaign' | 'journey'
  const [selectedSandbox, setSelectedSandbox] = useState('xlg-dev'); // Default sandbox
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [tenantId, setTenantId] = useState(null); // Retrieved from backend
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');
  
  // Progress tracking state
  const [isPolling, setIsPolling] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [progress, setProgress] = useState(0);
  const [progressStage, setProgressStage] = useState('');
  const [progressMessage, setProgressMessage] = useState('');
  const [itemsProcessed, setItemsProcessed] = useState(0);
  const [itemsTotal, setItemsTotal] = useState(0);
  
  // Cache state
  const [cachedReport, setCachedReport] = useState(null);
  const [showCachePrompt, setShowCachePrompt] = useState(false);

  // Build month options from Jan 2026 up to current month (newest first)
  const buildMonthOptions = () => {
    const now = new Date();
    const months = [];
    let y = 2026;
    let m = 1;
    while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
      months.push({ year: y, month: m });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    months.reverse(); // newest first
    return months;
  };

  const monthOptions = buildMonthOptions();

  const getMonthLabel = (year, month) => {
    return new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  };

  const fetchDeliveryData = async (forceFresh = false) => {
    console.log('========================================');
    console.log('fetchDeliveryData called with forceFresh:', forceFresh);
    console.log('forceFresh type:', typeof forceFresh);
    console.log('forceFresh === false:', forceFresh === false);
    console.log('!forceFresh:', !forceFresh);
    
    setIsLoading(true);
    setError(null);
    setData(null);
    setShowCachePrompt(false);
    setCachedReport(null);

    try {
      const { year, month } = monthOptions[selectedMonthIndex];
      
      // Step 1: Check cache first (unless forcing fresh)
      if (!forceFresh) {
        console.log('========================================');
        console.log('Checking cache with params:', {
          sandbox: selectedSandbox,
          year: year.toString(),
          month: month.toString(),
          type: selectedType,
        });
        
        const cacheResponse = await actionWebInvoke({
          actionName: 'get-cached-report',
          params: {
            sandbox: selectedSandbox,
            year: year.toString(),
            month: month.toString(),
            type: selectedType,
          },
        });

        console.log('Cache response received:', cacheResponse);

        if (cacheResponse.found) {
          console.log('✅ CACHE HIT! Report found in cache');
          console.log('Cache details:', {
            cachedAt: cacheResponse.cachedAt,
            ageInDays: cacheResponse.ageInDays,
            itemCount: cacheResponse.report?.combined?.length || 0,
            stats: cacheResponse.stats
          });
          setCachedReport(cacheResponse);
          setShowCachePrompt(true);
          setIsLoading(false);
          return; // Stop here, let user decide
        }
        
        console.log('❌ CACHE MISS - No cached report found. Reason:', cacheResponse.reason || 'unknown');
        console.log('Starting fresh fetch...');
      } else {
        console.log('🔄 Force fresh fetch requested - skipping cache check');
      }

      // Step 2: Start async job
      console.log('Starting async report fetch...');
      const startResponse = await actionWebInvoke({
        actionName: 'start-report-fetch',
        imsToken: credentials.token,
        params: {
          sandbox: selectedSandbox,
          year: year.toString(),
          month: month.toString(),
          type: selectedType,
        },
      });

      if (startResponse.error) {
        throw new Error(startResponse.error);
      }

      const newJobId = startResponse.jobId;
      setJobId(newJobId);
      setIsPolling(true);
      setProgress(0);
      setProgressMessage('Starting...');
      
      console.log('Job started:', newJobId);

      // Step 3: Poll for progress
      const pollInterval = setInterval(async () => {
        try {
          const statusResponse = await actionWebInvoke({
            actionName: 'get-report-status',
            params: { jobId: newJobId },
          });

          if (statusResponse.error) {
            console.error('Status poll error:', statusResponse.error);
            clearInterval(pollInterval);
            setError('Failed to get job status');
            setIsPolling(false);
            setIsLoading(false);
            return;
          }

          // Update progress UI
          setProgress(statusResponse.progress || 0);
          setProgressStage(statusResponse.stage || '');
          setProgressMessage(statusResponse.message || '');
          setItemsProcessed(statusResponse.itemsProcessed || 0);
          setItemsTotal(statusResponse.itemsTotal || 0);

          console.log(`Progress: ${statusResponse.progress}% - ${statusResponse.message}`);

          // Check if complete
          if (statusResponse.status === 'complete') {
            clearInterval(pollInterval);
            setIsPolling(false);
            
            // Fetch the cached result (it was just cached by the backend)
            console.log('Job complete! Fetching cached result...');
            const finalCache = await actionWebInvoke({
              actionName: 'get-cached-report',
              params: {
                sandbox: selectedSandbox,
                year: year.toString(),
                month: month.toString(),
                type: selectedType,
              },
            });

            if (finalCache.found && finalCache.report) {
              setData(finalCache.report);
              if (finalCache.report.tenantId) {
                setTenantId(finalCache.report.tenantId);
              }
              console.log('Report loaded successfully!');
            } else {
              throw new Error('Report generation complete but not found in cache');
            }
            
            setIsLoading(false);
          }

        } catch (pollError) {
          console.error('Polling error:', pollError);
          clearInterval(pollInterval);
          setError(pollError.message || 'Failed to poll job status');
          setIsPolling(false);
          setIsLoading(false);
        }
      }, 2000); // Poll every 2 seconds

      // Set timeout to stop polling after 10 minutes
      setTimeout(() => {
        if (isPolling) {
          clearInterval(pollInterval);
          setError('Job timed out after 10 minutes');
          setIsPolling(false);
          setIsLoading(false);
        }
      }, 600000);

    } catch (err) {
      console.error('Failed to fetch delivery data:', err);
      setError(err.message || 'Failed to fetch delivery data');
      setIsLoading(false);
      setIsPolling(false);
    }
  };

  // Load cached report
  const loadCachedReport = () => {
    if (cachedReport && cachedReport.report) {
      setData(cachedReport.report);
      if (cachedReport.report.tenantId) {
        setTenantId(cachedReport.report.tenantId);
      }
      setShowCachePrompt(false);
      console.log('Loaded from cache');
    }
  };

  // Fetch fresh report (skip cache)
  const fetchFresh = () => {
    setShowCachePrompt(false);
    fetchDeliveryData(true); // Force fresh
  };

  const handleExportCSV = () => {
    if (!data || !data.combined.length) return;
    
    const { year, month } = monthOptions[selectedMonthIndex];
    const csv = exportDeliverySummaryCsv(data.combined, credentials);
    const filename = `ajo-delivery-${year}-${String(month).padStart(2, '0')}.csv`;
    downloadCsv(csv, filename);
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return '—';
    return new Date(Number(timestamp)).toLocaleDateString('en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getItemUrl = (item) => {
    if (!tenantId) return '#';
    
    if (item._type === 'journey') {
      return `https://experience.adobe.com/#/@${tenantId}/sname:${encodeURIComponent(selectedSandbox)}/journey-optimizer/journeys/journey/${encodeURIComponent(item.campaignId)}`;
    } else {
      return `https://experience.adobe.com/#/@${tenantId}/sname:${encodeURIComponent(selectedSandbox)}/journey-optimizer/campaigns/review/${encodeURIComponent(item.versionId || item.campaignId)}`;
    }
  };

  // Apply filters
  const getFilteredData = () => {
    if (!data) return [];
    
    return data.combined.filter(item => {
      // Search filter
      if (searchQuery) {
        const searchLower = searchQuery.toLowerCase();
        const searchableText = [
          item.name,
          item.campaignId,
          item.createdBy,
          item.createdByName
        ].join(' ').toLowerCase();
        
        if (!searchableText.includes(searchLower)) return false;
      }

      // Status filter
      if (statusFilter !== 'all') {
        if (item.status.toUpperCase() !== statusFilter) return false;
      }

      // Channel filter
      if (channelFilter !== 'all') {
        if (item._type === 'campaign') {
          const channels = item.packages.map(p => p.channel).filter(Boolean);
          if (!channels.includes(channelFilter)) return false;
        } else {
          if (!item._channels.toLowerCase().includes(channelFilter.toLowerCase())) return false;
        }
      }

      return true;
    });
  };

  const filteredData = getFilteredData();

  // Get unique channels for filter dropdown
  const getUniqueChannels = () => {
    if (!data) return [];
    
    const channels = new Set();
    data.combined.forEach(item => {
      if (item._type === 'campaign') {
        item.packages.forEach(p => {
          if (p.channel) channels.add(p.channel);
        });
      } else {
        if (item._channels) {
          item._channels.split(',').forEach(ch => {
            const trimmed = ch.trim();
            if (trimmed) channels.add(trimmed);
          });
        }
      }
    });
    
    return Array.from(channels).sort();
  };

  const uniqueChannels = getUniqueChannels();

  // Count display
  const getCountDisplay = () => {
    if (!data) return '';
    
    if (selectedType === 'campaign') {
      return `${filteredData.length} campaign${filteredData.length !== 1 ? 's' : ''}`;
    } else if (selectedType === 'journey') {
      return `${filteredData.length} journey${filteredData.length !== 1 ? 's' : ''}`;
    } else {
      // both
      const camps = filteredData.filter(i => i._type === 'campaign').length;
      const jours = filteredData.filter(i => i._type === 'journey').length;
      return `${camps} campaign${camps !== 1 ? 's' : ''}, ${jours} journey${jours !== 1 ? 's' : ''}`;
    }
  };

  return (
    <View>
      {/* Controls Bar - matches EDS layout exactly */}
      <Flex direction="row" gap="size-200" alignItems="end" wrap marginBottom="size-300">
        {/* Combined Month Picker - "October 2026" format */}
        <Picker
          label="Month"
          selectedKey={selectedMonthIndex}
          onSelectionChange={setSelectedMonthIndex}
          width="size-2400"
        >
          {monthOptions.map((opt, idx) => (
            <Item key={idx}>{getMonthLabel(opt.year, opt.month)}</Item>
          ))}
        </Picker>

        {/* Type Selector */}
        <Picker
          label="Type"
          selectedKey={selectedType}
          onSelectionChange={setSelectedType}
          width="size-1600"
        >
          <Item key="campaign">Campaign</Item>
          <Item key="journey">Journey</Item>
          <Item key="both">Both</Item>
        </Picker>

        {/* Sandbox Selector */}
        <Picker
          label="Sandbox"
          selectedKey={selectedSandbox}
          onSelectionChange={setSelectedSandbox}
          width="size-1600"
        >
          <Item key="xlg-dev">xlg-dev</Item>
          <Item key="xlg-stage">xlg-stage</Item>
          <Item key="xlg-prod">xlg-prod</Item>
        </Picker>

        {/* Fetch Button */}
        <Button variant="cta" onPress={() => fetchDeliveryData(false)} isDisabled={isLoading}>
          {isLoading ? (
            <Flex gap="size-100" alignItems="center">
              <ProgressCircle size="S" isIndeterminate />
              <Text>Loading...</Text>
            </Flex>
          ) : (
            <>
              <Download />
              <Text>Fetch</Text>
            </>
          )}
        </Button>

        {/* Export CSV */}
        {data && data.combined.length > 0 && (
          <ActionButton onPress={handleExportCSV} isQuiet>
            <Download />
            <Text>Export CSV</Text>
          </ActionButton>
        )}
      </Flex>

      {/* Search and Filters Row - matches EDS */}
      {data && data.combined.length > 0 && (
        <Flex direction="row" gap="size-200" alignItems="end" wrap marginBottom="size-300">
          {/* Search */}
          <TextField
            label="Search"
            placeholder="Search name, ID, owner…"
            value={searchQuery}
            onChange={setSearchQuery}
            width="size-3600"
            icon={<Search />}
          />

          {/* Status Filter */}
          <Picker
            label="Status"
            selectedKey={statusFilter}
            onSelectionChange={setStatusFilter}
            width="size-1600"
          >
            <Item key="all">All</Item>
            <Item key="LIVE">Live</Item>
            <Item key="COMPLETED">Completed</Item>
            <Item key="STOPPED">Stopped</Item>
          </Picker>

          {/* Channel Filter */}
          <Picker
            label="Channel"
            selectedKey={channelFilter}
            onSelectionChange={setChannelFilter}
            width="size-2000"
          >
            <Item key="all">All Channels</Item>
            {uniqueChannels.map(ch => (
              <Item key={ch}>{ch}</Item>
            ))}
          </Picker>

          {/* Count Display */}
          <View UNSAFE_style={{ paddingBottom: '8px', fontWeight: 600 }}>
            <Text>{getCountDisplay()}</Text>
          </View>
        </Flex>
      )}

      {/* Cache Prompt */}
      {showCachePrompt && cachedReport && (
        <Well marginBottom="size-300">
          <Flex direction="column" gap="size-200">
            <Heading level={4}>✅ Cached Report Available</Heading>
            <Text>
              Last generated: {new Date(cachedReport.cachedAt).toLocaleString()}
              {cachedReport.ageInDays !== undefined && ` (${cachedReport.ageInDays} days ago)`}
            </Text>
            {cachedReport.stats && (
              <Text>
                Contains: {cachedReport.stats.total || 0} items
                {cachedReport.stats.aiSummariesGenerated && ` with ${cachedReport.stats.aiSummariesGenerated} AI summaries`}
              </Text>
            )}
            <Flex gap="size-200" marginTop="size-100">
              <Button variant="cta" onPress={loadCachedReport}>
                Use Cached Report
              </Button>
              <Button variant="secondary" onPress={fetchFresh}>
                <Refresh />
                <Text>Fetch Fresh</Text>
              </Button>
            </Flex>
          </Flex>
        </Well>
      )}

      {/* Progress Display - Dual Progress Bars */}
      {isPolling && (
        <Well marginBottom="size-300">
          <Flex direction="column" gap="size-300">
            <Heading level={4}>Fetching Delivery Report</Heading>
            
            {/* Data Fetching Progress Bar */}
            <View>
              <Flex direction="row" alignItems="center" gap="size-100" marginBottom="size-100">
                <Text UNSAFE_style={{ fontWeight: 600, fontSize: '14px' }}>
                  📊 Data Fetching
                </Text>
                {progress >= 70 && (
                  <Text UNSAFE_style={{ color: '#2d9d78', fontWeight: 600 }}>✓</Text>
                )}
              </Flex>
              
              <View UNSAFE_style={{ 
                width: '100%', 
                height: '24px', 
                backgroundColor: '#f0f0f0', 
                borderRadius: '4px',
                overflow: 'hidden',
                position: 'relative',
                marginBottom: '8px'
              }}>
                <View UNSAFE_style={{
                  width: `${Math.min(100, (progress / 70) * 100)}%`,
                  height: '100%',
                  backgroundColor: progress >= 70 ? '#2d9d78' : '#1473e6',
                  transition: 'width 0.3s ease, background-color 0.3s ease'
                }}>
                  <Text UNSAFE_style={{ 
                    color: '#fff', 
                    fontWeight: 600, 
                    fontSize: '12px',
                    position: 'absolute',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    top: '50%',
                    marginTop: '-6px'
                  }}>
                    {Math.round(Math.min(100, (progress / 70) * 100))}%
                  </Text>
                </View>
              </View>

              {/* Data fetching status message - only show when in data stages */}
              {progressStage !== 'ai' && progressStage !== 'caching' && (
                <Flex direction="row" gap="size-100" alignItems="center">
                  <ProgressCircle size="S" isIndeterminate />
                  <Text UNSAFE_style={{ fontSize: '13px', color: '#6e6e6e' }}>
                    {progressMessage || 'Fetching data...'}
                  </Text>
                </Flex>
              )}
              {progress >= 70 && (
                <Text UNSAFE_style={{ fontSize: '13px', color: '#2d9d78', fontWeight: 500 }}>
                  ✓ Data fetching complete
                </Text>
              )}
            </View>

            {/* AI Summary Generation Progress Bar - only show when AI stage starts */}
            {progressStage === 'ai' && (
              <View>
                <Flex direction="row" alignItems="center" gap="size-100" marginBottom="size-100">
                  <Text UNSAFE_style={{ fontWeight: 600, fontSize: '14px' }}>
                    🤖 AI Summary Generation
                  </Text>
                  {progress >= 95 && (
                    <Text UNSAFE_style={{ color: '#2d9d78', fontWeight: 600 }}>✓</Text>
                  )}
                </Flex>
                
                <View UNSAFE_style={{ 
                  width: '100%', 
                  height: '24px', 
                  backgroundColor: '#f0f0f0', 
                  borderRadius: '4px',
                  overflow: 'hidden',
                  position: 'relative',
                  marginBottom: '8px'
                }}>
                  <View UNSAFE_style={{
                    width: `${itemsTotal > 0 ? (itemsProcessed / itemsTotal) * 100 : 0}%`,
                    height: '100%',
                    backgroundColor: progress >= 95 ? '#2d9d78' : '#9333ea',
                    transition: 'width 0.3s ease, background-color 0.3s ease'
                  }}>
                    <Text UNSAFE_style={{ 
                      color: '#fff', 
                      fontWeight: 600, 
                      fontSize: '12px',
                      position: 'absolute',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      top: '50%',
                      marginTop: '-6px'
                    }}>
                      {itemsTotal > 0 ? Math.round((itemsProcessed / itemsTotal) * 100) : 0}%
                    </Text>
                  </View>
                </View>

                {/* AI generation status */}
                <Flex direction="row" gap="size-100" alignItems="center" marginBottom="size-50">
                  <ProgressCircle size="S" isIndeterminate />
                  <Text UNSAFE_style={{ fontSize: '13px', color: '#6e6e6e' }}>
                    {progressMessage || 'Generating AI summaries...'}
                  </Text>
                </Flex>
                
                {/* Items Counter */}
                {itemsTotal > 0 && (
                  <Text UNSAFE_style={{ fontSize: '13px', color: '#6e6e6e' }}>
                    Processing: {itemsProcessed} / {itemsTotal} items
                  </Text>
                )}
              </View>
            )}

            {/* Caching stage indicator */}
            {progressStage === 'caching' && (
              <Flex direction="row" gap="size-100" alignItems="center">
                <ProgressCircle size="S" isIndeterminate />
                <Text UNSAFE_style={{ fontSize: '13px', color: '#6e6e6e', fontWeight: 500 }}>
                  💾 {progressMessage || 'Caching report...'}
                </Text>
              </Flex>
            )}
          </Flex>
        </Well>
      )}

      {/* Error Message */}
      {error && (
        <Well marginBottom="size-300">
          <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-red-600)' }}>
            ⚠️ {error}
          </Text>
        </Well>
      )}

      {/* Results Table */}
      {filteredData.length > 0 && (
        <View overflow="auto" height="calc(100vh - 450px)">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e1e1e1', backgroundColor: '#fafafa' }}>
                <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600 }}>Name</th>
                <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600 }}>Status</th>
                <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600 }}>Type</th>
                <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600 }}>Journey Type</th>
                <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600 }}>AI Summary</th>
                <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600 }}>Tags</th>
                <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600 }}>Channels</th>
                <th style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600 }}>Published</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.map((item, index) => (
                <tr key={`${item._type}-${item.campaignId}-${index}`} style={{ borderBottom: '1px solid #e1e1e1' }}>
                  <td style={{ padding: '12px 8px' }}>
                    <a 
                      href={getItemUrl(item)} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={{ color: '#1473e6', textDecoration: 'none', fontWeight: 500 }}
                    >
                      {item.name}
                    </a>
                  </td>
                  <td style={{ padding: '12px 8px' }}>
                    <span style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: 500,
                      backgroundColor: '#e1e1e1',
                      display: 'inline-block'
                    }}>
                      {item.status}
                    </span>
                  </td>
                  <td style={{ padding: '12px 8px' }}>
                    <span style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: 500,
                      backgroundColor: item._type === 'journey' ? '#E3F2FD' : '#FFF3E0',
                      color: item._type === 'journey' ? '#1565C0' : '#E65100',
                      display: 'inline-block'
                    }}>
                      {item._type === 'journey' ? 'Journey' : 'Campaign'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 8px', fontSize: '13px' }}>
                    {item.aiSummary?.journeyType ? (
                      <span style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '12px',
                        fontWeight: 500,
                        backgroundColor: getJourneyTypeColor(item.aiSummary.journeyType),
                        color: '#fff',
                        display: 'inline-block'
                      }} title={item.aiSummary.lifecycleStage}>
                        {getJourneyTypeIcon(item.aiSummary.journeyType)} {item.aiSummary.journeyType}
                      </span>
                    ) : '—'}
                  </td>
                  <td style={{ padding: '12px 8px', fontSize: '13px', maxWidth: '300px' }}>
                    {item.aiSummary?.useCaseSummary ? (
                      <Flex direction="row" gap="size-100" alignItems="center">
                        <span 
                          style={{ 
                            display: 'block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            color: '#323232',
                            flex: 1
                          }}
                        >
                          🤖 {item.aiSummary.useCaseSummary}
                        </span>
                        <DialogTrigger>
                          <ActionButton isQuiet aria-label="View AI Summary Details">
                            <Info />
                          </ActionButton>
                          {(close) => (
                            <Dialog>
                              <Heading>AI Summary: {item.name}</Heading>
                              <Divider />
                              <Content>
                                <View padding="size-200">
                                  <Flex direction="column" gap="size-200">
                                    {item.aiSummary.journeyType && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          Journey Type:
                                        </Text>
                                        <Text>{getJourneyTypeIcon(item.aiSummary.journeyType)} {item.aiSummary.journeyType}</Text>
                                      </View>
                                    )}
                                    {item.aiSummary.lifecycleStage && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          Lifecycle Stage:
                                        </Text>
                                        <Text>{item.aiSummary.lifecycleStage}</Text>
                                      </View>
                                    )}
                                    {item.aiSummary.useCaseSummary && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          Use Case Summary:
                                        </Text>
                                        <Text>{item.aiSummary.useCaseSummary}</Text>
                                      </View>
                                    )}
                                    {item.aiSummary.targetAudience && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          Target Audience:
                                        </Text>
                                        <Text>{item.aiSummary.targetAudience}</Text>
                                      </View>
                                    )}
                                    {item.aiSummary.customerExperience && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          Customer Experience:
                                        </Text>
                                        <Text>{item.aiSummary.customerExperience}</Text>
                                      </View>
                                    )}
                                    {item.aiSummary.behaviorTargeted && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          Behavior Targeted:
                                        </Text>
                                        <Text>{item.aiSummary.behaviorTargeted}</Text>
                                      </View>
                                    )}
                                    {item.aiSummary.businessObjective && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          Business Objective:
                                        </Text>
                                        <Text>{item.aiSummary.businessObjective}</Text>
                                      </View>
                                    )}
                                    {item.aiSummary.whyTeamBuiltThis && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          Why Team Built This:
                                        </Text>
                                        <Text>{item.aiSummary.whyTeamBuiltThis}</Text>
                                      </View>
                                    )}
                                    {item.aiSummary.businessValue && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          Business Value:
                                        </Text>
                                        <Text>{item.aiSummary.businessValue}</Text>
                                      </View>
                                    )}
                                    {item.aiSummary.reasoning && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          AI Reasoning:
                                        </Text>
                                        <Text>{item.aiSummary.reasoning}</Text>
                                      </View>
                                    )}
                                    {item.aiSummary.recommendation && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          Recommendation:
                                        </Text>
                                        <Text>{item.aiSummary.recommendation}</Text>
                                      </View>
                                    )}
                                    {item.aiSummary.confidence && (
                                      <View>
                                        <Text UNSAFE_style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                                          Confidence:
                                        </Text>
                                        <Text>{item.aiSummary.confidence}%</Text>
                                      </View>
                                    )}
                                  </Flex>
                                </View>
                              </Content>
                              <ButtonGroup>
                                <Button variant="primary" onPress={close}>Close</Button>
                              </ButtonGroup>
                            </Dialog>
                          )}
                        </DialogTrigger>
                      </Flex>
                    ) : (
                      <span style={{ color: '#999', fontStyle: 'italic' }}>No AI summary</span>
                    )}
                  </td>
                  <td style={{ padding: '12px 8px', fontSize: '13px', color: '#6e6e6e' }}>
                    {item.tags && item.tags.length > 0
                      ? item.tags.slice(0, 2).map(t => t.name).join(', ')
                      : '—'}
                  </td>
                  <td style={{ padding: '12px 8px', fontSize: '13px' }}>
                    {item._type === 'campaign' 
                      ? [...new Set(item.packages.map(p => p.channel).filter(Boolean))].join(', ') || '—'
                      : item._channels || '—'
                    }
                  </td>
                  <td style={{ padding: '12px 8px', fontSize: '13px', color: '#6e6e6e' }}>
                    {formatDate(item.publishedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </View>
      )}

      {/* Empty State */}
      {data && filteredData.length === 0 && (
        <View marginTop="size-400">
          <Well>
            <Text>🔍 No {selectedType === 'campaign' ? 'campaigns' : 'journeys'} match your filters.</Text>
          </Well>
        </View>
      )}

      {/* No Data Yet */}
      {!data && !isLoading && !error && (
        <View marginTop="size-400">
          <Well>
            <Text>📅 Select a month and click Fetch to load delivery data.</Text>
          </Well>
        </View>
      )}
    </View>
  );
};

export default DeliverySummary;
