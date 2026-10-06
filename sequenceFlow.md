# Journey Cleanup Dashboard - High-Level Flow

```mermaid
sequenceDiagram
    participant User
    participant UI as Dashboard UI
    participant Cache as IndexedDB Cache<br/>(Local Browser Storage)
    participant AJO as AJO API
    participant AI as AI Proxy + LLM

    Note over User,AI: 1. INITIALIZATION
    User->>UI: Open Dashboard
    UI->>Cache: Check sessionStorage for credentials
    alt No Credentials
        UI->>User: Show login modal
        User->>UI: Enter credentials
        UI->>Cache: Save to sessionStorage
    end

    Note over User,AI: 2. CACHE CHECK
    UI->>Cache: Check for existing snapshot (sandbox)
    Cache-->>UI: Return cached data or null
    
    alt Cache Hit
        UI->>User: Show "Load from cache" OR "Refresh" options
        User->>UI: Choose option
    else No Cache
        UI->>User: Show AI configuration modal
    end

    Note over User,AI: 3. DATA FETCH (if needed)
    UI->>AJO: Fetch all stale journeys (paginated)
    loop Each Page
        AJO-->>UI: Journey batch
        UI->>UI: Calculate rule scores (instant, no API)
    end
    AJO-->>UI: All journeys loaded

    Note over User,AI: 4. AI SCORING (optional)
    alt AI Enabled
        UI->>AJO: Fetch detailed journey definitions
        AJO-->>UI: Journey details
        UI->>AI: Send journeys for analysis
        AI->>AI: LLM analyzes each journey
        AI-->>UI: AI scores & recommendations
        UI->>UI: Blend rule scores (40%) + AI scores (60%)
    end

    Note over User,AI: 5. CACHE STORAGE
    UI->>Cache: Save snapshot to IndexedDB
    Note right of Cache: Stores:<br/>• Journeys array<br/>• AI scores<br/>• Timestamp<br/>• Max 5 sandboxes (LRU)
    Cache-->>UI: Saved

    Note over User,AI: 6. DISPLAY & INTERACT
    UI->>User: Show dashboard with filters
    User->>UI: Filter, sort, export, expand rows
    UI->>User: Display results

    Note over User,AI: CACHE LOCATIONS
    Note over Cache: 📦 Journey Snapshots<br/>Store: "snapshots"<br/>Key: sandbox name<br/>Max: 5 (LRU eviction)<br/>Stale: 90 days
    Note over Cache: 📦 Delivery Reports<br/>Store: "delivery_snapshots"<br/>Key: "sandbox:YYYY-MM"<br/>Max: 20 (LRU eviction)<br/>Stale: 3 days
    Note over Cache: ⚙️ Settings: localStorage<br/>🔑 Credentials: sessionStorage
```

## Key Flow Summary:

1. **Check Cache First** → If recent data exists (< 90 days), offer to load instantly
2. **Fetch from AJO** → Only if cache miss or user requests refresh
3. **Rule Scoring** → Happens instantly (no API calls)
4. **AI Scoring** → Optional, requires AI proxy + LLM (slower)
5. **Save to Cache** → Store in IndexedDB for future use
6. **Display Results** → Interactive dashboard with filters

## Cache Strategy:
- **Journey Analysis**: Cached per sandbox (max 5), LRU eviction, 90-day expiry
- **Delivery Reports**: Cached per sandbox+month (max 20), LRU eviction, 3-day expiry
- **Instant Load**: No API calls when loading from cache
- **Credentials**: Session-only storage (cleared on browser close)

## How to View:
1. **VS Code**: Press `Ctrl+Shift+V` (or `Cmd+Shift+V` on Mac) to preview
2. **Online**: Visit https://mermaid.live and paste the mermaid code
3. **Extension**: Install "Mermaid Preview" extension for VS Code
