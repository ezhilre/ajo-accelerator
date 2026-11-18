# Async Progress Tracking & Caching Implementation

## Status: Backend Complete - Frontend Pending

This document tracks the implementation of the async job processing with progress tracking and 30-day caching.

## ✅ Completed Backend Components

### 1. New Actions Created

#### `get-cached-report` 
- **Purpose**: Check if cached report exists for given parameters
- **Location**: `actions/get-cached-report/index.js`
- **Features**:
  - Cache key: `report-{sandbox}-{year}-{month}-{type}`
  - 30-day TTL with auto-expiration
  - Returns age in days
  - Automatically deletes expired cache

#### `start-report-fetch`
- **Purpose**: Initiate async report generation job
- **Location**: `actions/start-report-fetch/index.js`
- **Features**:
  - Returns job ID immediately (202 status)
  - Stores initial status in State
  - Invokes fetch-delivery-report asynchronously
  - Suggests 2-second polling interval

#### `get-report-status`
- **Purpose**: Poll for job progress updates
- **Location**: `actions/get-report-status/index.js`
- **Features**:
  - Returns current job status
  - Progress percentage (0-100)
  - Stage information
  - Items processed count
  - Error handling for expired/missing jobs

### 2. Enhanced `fetch-delivery-report` Action

**New Capabilities**:
- Progress tracking with `updateProgress()` helper
- Report caching with `cacheReport()` helper
- State and Files SDK integration
- Support for async mode with jobId parameter

**Helper Functions Added**:
```javascript
updateProgress(jobId, status, stage, progress, message, itemsProcessed, itemsTotal, logger)
cacheReport(cacheKey, reportData, logger)
```

## 🔨 Remaining Implementation Steps

### Step 1: Integrate Progress Tracking in Main Function

Add progress updates at each stage:

```javascript
// After fetching campaigns (25% complete)
await updateProgress(params.jobId, 'processing', 'campaigns', 25, 
  `Fetched ${campaigns.length} campaigns`, campaigns.length, 0, logger);

// After fetching journeys (40% complete)
await updateProgress(params.jobId, 'processing', 'journeys', 40,
  `Fetched ${journeys.length} journeys`, journeys.length, 0, logger);

// During journey details (40-70%)
await updateProgress(params.jobId, 'processing', 'details', 
  40 + Math.round((processed / journeys.length) * 30),
  `Processing journey ${processed}/${journeys.length}`, processed, journeys.length, logger);

// During AI generation (70-95%)
await updateProgress(params.jobId, 'processing', 'ai',
  70 + Math.round((processed / combined.length) * 25),
  `Generating AI summary ${processed}/${combined.length}`, processed, combined.length, logger);

// On completion (100%)
await updateProgress(params.jobId, 'complete', 'done', 100,
  'Report generation complete', combined.length, combined.length, logger);

// Cache the result
const cacheKey = `report-${params.sandbox}-${params.year}-${params.month}-${params.type}`;
await cacheReport(cacheKey, reportData, logger);
```

### Step 2: Register Actions in app.config.yaml

Add to actions section:
```yaml
actions:
  get-cached-report:
    function: actions/get-cached-report/index.js
    web: 'yes'
    runtime: 'nodejs:18'
    annotations:
      require-adobe-auth: true
  
  start-report-fetch:
    function: actions/start-report-fetch/index.js
    web: 'yes'
    runtime: 'nodejs:18'
    annotations:
      require-adobe-auth: true
  
  get-report-status:
    function: actions/get-report-status/index.js
    web: 'yes'
    runtime: 'nodejs:18'
    annotations:
      require-adobe-auth: true
```

### Step 3: Frontend Implementation

#### A. Check Cache First
```javascript
// In DeliverySummary.js fetchDeliveryData()
const cacheResponse = await actionWebInvoke({
  actionName: 'get-cached-report',
  params: { sandbox, year, month, type }
});

if (cacheResponse.found) {
  // Show cache UI
  setCachedData(cacheResponse);
  showCachePrompt = true;
  return;
}
```

#### B. Start Async Job
```javascript
const startResponse = await actionWebInvoke({
  actionName: 'start-report-fetch',
  imsToken: credentials.token,
  params: { sandbox, year, month, type }
});

const jobId = startResponse.jobId;
```

#### C. Poll for Progress
```javascript
const pollInterval = setInterval(async () => {
  const statusResponse = await actionWebInvoke({
    actionName: 'get-report-status',
    params: { jobId }
  });
  
  setProgress(statusResponse.progress);
  setStage(statusResponse.stage);
  setMessage(statusResponse.message);
  
  if (statusResponse.status === 'complete') {
    clearInterval(pollInterval);
    // Fetch final data
  }
}, 2000);
```

#### D. Progress UI Component
```javascript
<View>
  <ProgressBar value={progress} />
  <Text>{stage}: {message}</Text>
  <Text>{itemsProcessed}/{itemsTotal}</Text>
</View>
```

## 📋 Testing Checklist

- [ ] Deploy all actions
- [ ] Test cache miss → starts async job
- [ ] Test progress polling updates UI
- [ ] Test AI summaries generate
- [ ] Test report caches successfully
- [ ] Test cache hit → instant load
- [ ] Test cache expiration (30 days)
- [ ] Test different sandboxes
- [ ] Test error handling
- [ ] Test "Fetch Fresh" button

## 🚀 Deployment Commands

```bash
cd app-builder/ajo-delivery-hub

# Deploy all actions
aio app deploy

# Test cache action
aio runtime action invoke ajo-delivery-hub/get-cached-report \
  -p sandbox xlg-dev -p year 2026 -p month 11 -p type journey

# Test status action (use real jobId)
aio runtime action invoke ajo-delivery-hub/get-report-status \
  -p jobId job-1234567890-abc123

# Watch logs
aio app logs --tail
```

## 📊 Architecture Diagram

```
User clicks Fetch
       ↓
Check Cache (get-cached-report)
       ↓
   Cache Hit? ──Yes──> Return cached data ✓
       ↓ No
Start Job (start-report-fetch)
   Returns jobId immediately
       ↓
Poll Status every 2s (get-report-status)
       ↓
   Stage 1: Fetching campaigns (25%)
   Stage 2: Fetching journeys (40%)
   Stage 3: Fetching details (40-70%)
   Stage 4: Generating AI (70-95%)
   Stage 5: Complete (100%)
       ↓
Cache result → Files storage (30 days)
       ↓
Return data to UI
```

## 🔑 Key Technical Details

### Cache Keys
Format: `report-{sandbox}-{year}-{month}-{type}`
Examples:
- `report-xlg-dev-2026-11-journey`
- `report-xlg-stage-2026-10-campaign`

### Storage
- **State**: Job progress (TTL: 1 hour)
- **Files**: Cached reports (TTL: 30 days)

### Progress Stages
1. `initializing` (0%)
2. `campaigns` (25%)
3. `journeys` (40%)
4. `details` (40-70%)
5. `ai` (70-95%)
6. `done` (100%)

## ⚠️ Important Notes

1. **Async Invocation**: `start-report-fetch` uses non-blocking invocation
2. **Token Passing**: IMS token passed securely through params
3. **Error Handling**: Graceful degradation if progress update fails
4. **Backwards Compatible**: Still supports sync mode without jobId

## 📝 Next Steps Priority

1. Add progress tracking calls to fetch-delivery-report main function
2. Register actions in app.config.yaml
3. Deploy backend
4. Implement frontend cache check
5. Implement frontend polling UI
6. Test end-to-end flow
7. Remove debug token logging from DeliverySummary.js
