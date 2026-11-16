# AJO Delivery Hub - App Builder Implementation

## 🎯 Overview

A standalone Adobe IO App Builder application for viewing monthly AJO Delivery Reports. This app fetches and displays all campaigns and journeys that were active during a selected month, completely independent of the EDS implementation.

## ✨ Features

- **Monthly Delivery Reports**: View all campaigns and journeys by month
- **Dual Data Sources**: Fetches both campaigns and journeys via GraphQL
- **Rich Table View**: Sortable table with name, type, status, tags, channels, owner, dates
- **CSV Export**: Download complete reports with all metadata
- **Direct Links**: Click through to view items in Adobe Experience Cloud
- **Credential Management**: Secure sessionStorage-based credential handling

## 📁 Project Structure

```
web-src/src/
├── components/
│   ├── Home.js                    # Main app shell
│   ├── CredentialsModal.js        # AJO credential configuration
│   └── DeliverySummary.js         # Delivery report UI
├── services/
│   ├── ajoApi.js                  # AJO API wrapper (GraphQL queries)
│   ├── azureAIService.js          # Azure OpenAI (for future AI features)
│   ├── cacheService.js            # IndexedDB storage (for future caching)
│   └── csvExport.js               # CSV export utilities
└── utils/
    └── scoreCalculator.js         # Scoring logic (for future AI features)
```

## 🚀 Getting Started

### 1. Install Dependencies

```bash
cd app-builder/ajo-delivery-hub
npm install
```

### 2. Start Development Server

```bash
aio app dev
```

The app will open at: `https://experience.adobe.com/?devMode=true#/custom-apps/?localDevUrl=https://localhost:59593`

### 3. Configure Credentials

On first launch, you'll see a setup screen. Click "Configure Credentials" and enter:

- **Access Token**: Bearer token from Adobe Developer Console (get via OAuth or JWT)
- **API Key (Client ID)**: From your Adobe Developer Console project
- **Organization ID**: Your Adobe IMS Org ID (format: `ABC123@AdobeOrg`)
- **Sandbox Name**: AJO sandbox name (e.g., `prod`, `dev`)
- **Tenant ID**: Adobe Experience Cloud tenant ID

The app will verify these credentials before saving.

### 4. View Delivery Reports

1. Select Year and Month from dropdowns
2. Click "Fetch Report" to load data
3. View the combined campaigns + journeys table
4. Export to CSV if needed

## 🔧 How It Works

### Data Fetching

The app makes two parallel GraphQL queries:

1. **Campaigns**: Via `exc-unifiedcontent` GraphQL endpoint
   - Filters by status, sandbox, and date range
   - Returns campaign metadata, versions, packages (channels), tags

2. **Journeys**: Via `cjm-journeys-next-admin` GraphQL endpoint  
   - Filters by state, sandbox, and date range
   - Returns journey metadata, channels, tags

Both results are combined, sorted by modified date, and displayed in a unified table.

### CSV Export

The CSV export includes:
- Name, URL (direct link to AJO), Type (Journey/Campaign)
- Description, Tags, Channels, Version ID
- Status, Owner, Published Date, Modified Date
- AI fields (reserved for future enhancements)

## 🔐 Security

- Credentials stored in **sessionStorage only** (cleared on tab close)
- No server-side storage or persistence
- All API calls made client-side from browser
- Bearer token used for authentication

## 🎨 UI Components

Built with **Adobe Spectrum** design system:
- `Picker` - Year/month selection
- `Button` - Fetch report, export CSV
- `TableView` - Data grid with sorting
- `Well` - Error/empty state messages
- `Dialog` - Credentials modal
- `ProgressCircle` - Loading states

## 📊 Data Model

### Campaign Object
```javascript
{
  _type: 'campaign',
  campaignId: string,
  versionId: string,
  name: string,
  status: string,
  tags: Tag[],
  packages: Package[],  // Contains channel info
  createdBy: string,
  publishedAt: timestamp,
  modifiedAt: timestamp
}
```

### Journey Object
```javascript
{
  _type: 'journey',
  campaignId: string,
  name: string,
  status: string,
  tags: Tag[],
  _channels: string,    // Comma-separated
  createdBy: string,
  publishedAt: timestamp,
  modifiedAt: timestamp
}
```

## 🔮 Future Enhancements

The following modules are ready but not yet integrated:

1. **AI Scoring** (`azureAIService.js`)
   - Journey type classification
   - Lifecycle stage detection
   - Business value assessment
   - Use case summarization

2. **Caching** (`cacheService.js`)
   - IndexedDB persistence
   - Snapshot management
   - Fast reload of previous reports

3. **Additional Features**
   - Analyze All journeys (staleness scoring)
   - Journey lookup by ID
   - Bulk journey deletion

## 🐛 Troubleshooting

### "Failed to verify credentials"
- Ensure your access token is valid (they expire!)
- Check Organization ID format includes `@AdobeOrg`
- Verify sandbox name exactly matches AJO
- Confirm API Key matches Developer Console

### "No campaigns or journeys found"
- Try a different month that had activity
- Check your sandbox has campaigns/journeys
- Verify date filters in GraphQL queries

### App won't load
- Check browser console for errors
- Ensure `aio app dev` is running
- Try clearing browser cache/sessionStorage

## 📚 API Reference

### AJO Campaign GraphQL
**Endpoint**: `https://exc-unifiedcontent.experience.adobe.net/api/gql/app/ajoCampaignsApp/graphql`

**Query**: `searchV2` with filters:
- `noun: campaign`
- `sandboxname: <sandbox>`
- `status: COMPLETED, STOPPED, LIVE, etc.`
- `trueStartDate` / `trueEndDate`: Date range

### AJO Journey GraphQL
**Endpoint**: `https://exc-unifiedcontent.experience.adobe.net/api/gql/app/cjm-journeys-next-admin/graphql`

**Query**: `searchV2` with filters:
- `noun: journey`
- `sandboxname: <sandbox>`
- `state: deployed, stopped, etc.`
- `startDate` / `endDateTimeline`: Date range

## 📝 License

Copyright 2024 Adobe. All rights reserved.

## 🤝 Support

For issues or questions:
1. Check browser console for errors
2. Verify credentials in Developer Console
3. Review GraphQL query responses
4. Check network tab for API errors
