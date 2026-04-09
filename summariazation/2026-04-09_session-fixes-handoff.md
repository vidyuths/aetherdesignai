# Handoff Note — April 9 Session
**Date:** 2026-04-09  
**Branch:** `phase3-self-contained-mode`  
**Last commit:** `9c79fcc5`  
**Picks up from:** `2026-04-08_phase3-self-contained-handoff.md`

---

## What We Did This Session

Two focused fixes on top of the Phase 3 base:

1. **`keyType` labeling on `componentKeyMap`** — tell the plugin which Figma API to call per key
2. **Ripped out the broken `getAvailableLibraryComponentSetsAsync` call** — it's not a real Figma API — and replaced it with a proper instance-scanning approach

---

## Files Touched

### `packages/adapter-figma/src/handlers/design-system.ts`

**Old behavior (broken):**  
Called `figma.teamLibrary.getAvailableLibraryComponentSetsAsync()` to get a list of library component sets. This method **does not exist** in the Figma Plugin API. Only variable-related methods exist on `teamLibrary`. The call silently threw "not a function", was caught, and left `availableSets` empty — so the plugin always showed stale data from the last session that actually had components.

**New behavior:**  
Component discovery is now done by **scanning instances on the current page**:
```
figma.currentPage.findAllWithCriteria({ types: ["INSTANCE"] })
  → for each instance: getMainComponentAsync()
  → if mainComponent.parent is COMPONENT_SET → keyType: "SET", store setKey + componentKey
  → if mainComponent is standalone              → keyType: "COMPONENT", store componentKey only
```
Also picks up local `COMPONENT` and `COMPONENT_SET` nodes that aren't yet placed as instances.

**Key shape changed:**  
`componentKeyMap[name]` now includes a `keyType: "SET" | "COMPONENT"` field so the plugin knows which import API to use:
- `"SET"` → `figma.importComponentSetByKeyAsync(setKey)`
- `"COMPONENT"` → `figma.importComponentByKeyAsync(componentKey)`

**Note on Figma API limits:**  
There is genuinely no way to enumerate all library components from the Plugin API. You can only discover components that have been placed as instances somewhere in the current file. This is a hard Figma platform constraint.

---

### `packages/adapter-figma/src/plugin/code.ts`

**`state.componentKeyMap` type updated:**  
Added `keyType: "SET" | "COMPONENT"` to the type so TypeScript is consistent with what `design-system.ts` now returns.

**Import logic unified into `importByKey(key, keyType)`:**  
Replaced the parallel `importSetAndPlace` / `importAndPlace` calls in the cache-lookup paths with a single helper:
```ts
importByKey(key, keyType)
  → keyType === "SET":       try importComponentSetByKeyAsync first, fall back to importComponentByKeyAsync
  → keyType === "COMPONENT": try importComponentByKeyAsync first,  fall back to importComponentSetByKeyAsync
```
Both the exact-match and fuzzy-match cache paths now use this.

---

## Known Gap: Auto-Detect Still Shows "0 components" for Fresh Files

If no instances of library components exist on the current page, the scan finds nothing. This is unavoidable with the Plugin API alone.

---

## Where To Pick Up Next

### Option A — Work Around Figma API Limits via REST API (Recommended)

Figma's **REST API** has no such restriction. Given a file URL or file key + access token, you can fetch the full component tree:

```
GET https://api.figma.com/v1/files/:file_key/components
Authorization: Bearer <personal_access_token>
```

This returns every published component in the file (name, key, node ID, etc.) — exactly what we need to populate `componentKeyMap` without needing any instances.

**What to build:**
1. Add a **"Library File URL"** input field in the Settings tab of `ui.html`
2. On Auto-detect, if a URL is provided, call `fetch` (via the relay `/proxy` route if CORS is an issue) against the Figma Files REST API
3. Populate `componentKeyMap` from the REST response with `keyType: "SET"` or `"COMPONENT"` based on `node_type`
4. Fall back to the current instance-scan approach if no URL is provided

**Files to change for this:**
- `packages/adapter-figma/src/plugin/ui.html` — add Library URL input in Settings tab
- `packages/adapter-figma/src/handlers/design-system.ts` — accept `{ libraryFileUrl?, accessToken? }` params, call REST API if provided
- `packages/tunnel/src/index.ts` — optionally add a `/figma-proxy` route to forward REST API calls and handle auth server-side to avoid leaking tokens in plugin UI
- `packages/adapter-figma/src/plugin/code.ts` — pass params through `handleCommand` → handler

---

### Option B — Continue Polishing Instance-Scan Approach

If REST API integration is too much for now:
- Add a **"Scan all pages"** option (currently only scans current page) by calling `figma.loadAllPagesAsync()` first — expensive but comprehensive
- Surface the component count correctly in the UI after scan  
- Handle the case where user switches DS library in the file without reopening the plugin (today: stale until button click)

---

## State of the Plugin Right Now

| Feature | Status |
|---------|--------|
| Tabbed UI (Prompt + Settings) | ✅ Working |
| Self-contained LLM loop via relay `/llm` proxy | ✅ Working |
| Multi-turn agentic tool loop | ✅ Working |
| `create_instance` with SET/COMPONENT fallback logic | ✅ Working |
| Design system auto-detect (instance scan) | ✅ Works — but only sees components already on canvas |
| Variable collections from attached libraries | ✅ Working (teamLibrary variables API works fine) |
| Library component enumeration from fresh file | ❌ Not possible via Plugin API — needs REST API solution |

---

## How To Run

```bash
npm install
npm run build                      # builds plugin + MCP server
npm run socket                     # starts relay on :3055 (required for /llm proxy)
# In Figma: load plugin from plugin/manifest.json
```
