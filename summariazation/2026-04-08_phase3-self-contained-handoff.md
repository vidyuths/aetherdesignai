# Handoff Note — Phase 3 Self-Contained Mode
**Date:** 2026-04-08  
**Branch:** `phase3-self-contained-mode`  
**Machine context:** Picking up on a new machine — pull this branch and continue from here.

---

## What This Branch Is

Phase 3 adds a fully **self-contained LLM mode** to the Vibma Figma plugin. The plugin can now call an LLM API (OpenAI or Anthropic) directly from inside Figma — no MCP client needed — and use the LLM to generate UI on the canvas via a multi-turn agentic tool loop.

The plugin UI (`ui.html`) gained a tabbed layout:
- **Prompt tab** — text field + Generate button, shimmer loading, DS auto-detect button
- **Settings tab** — API key + model config, persisted via `figma.clientStorage`

---

## Architecture in This Branch

```
Figma Plugin UI (ui.html)
  ──postMessage──▶  Plugin Sandbox (code.ts)
                        │
                        ├── LLM API call (via /llm proxy on relay to avoid CORS)
                        │       POST localhost:3055/llm → { url, headers, body }
                        │       Relay forwards to OpenAI / Anthropic server-side
                        │
                        └── Multi-turn agentic loop (up to 8 turns)
                                Tool calls dispatched to batchHandler
                                Results fed back to LLM each turn
```

---

## Files Changed in This Branch

| File | What changed |
|------|-------------|
| `packages/adapter-figma/src/plugin/ui.html` | Full rewrite — tabbed UI, shimmer, DS auto-detect, buildSystemPrompt(), LLM generate flow |
| `packages/adapter-figma/src/plugin/code.ts` | LLM proxy call, callLLMTurn, handleLLMGenerate (multi-turn loop), handleCreateInstance, FIGMA_TOOLS definitions, state.componentKeyMap, cache-component-keys message handler |
| `packages/adapter-figma/src/handlers/design-system.ts` | New handler: scans DS for variable collections + component sets + componentKeyMap |
| `packages/adapter-figma/src/plugin/manifest.json` | Added `allowedDomains` for OpenAI/Anthropic direct calls (fallback), and /llm proxy |
| `packages/tunnel/src/index.ts` | Added `POST /llm` proxy endpoint to forward LLM API calls server-side (solves CORS for Anthropic) |
| `packages/core/.gitignore` | Minor update |

---

## What Was Fully Fixed / Working

| Feature | Status |
|---------|--------|
| Tabbed UI (Prompt + Settings) | ✅ Done |
| `figma.clientStorage` for API key (localStorage blocked in Figma) | ✅ Done |
| `/llm` proxy on relay — CORS fix for Anthropic | ✅ Done |
| Multi-turn agentic loop (8 turns max, tool results fed back) | ✅ Done |
| Correct FIGMA_TOOLS param names (`layoutMode`, `itemSpacing`, `fillColor`, etc.) | ✅ Done |
| `create_instance` tool added to FIGMA_TOOLS | ✅ Done |
| `handleCreateInstance` — real-time all-pages instance scan as primary key source | ✅ Done |
| `design-system.ts` — names from teamLibrary, keys only from instance scan | ✅ Done |
| Build passes cleanly (392 KB IIFE) | ✅ Done |

---

## The Most Immediate Thing Being Worked On

### `create_instance` — component 404 fix

**Problem:** `figma.importComponentByKeyAsync(key)` throws 404 when given keys from `teamLibrary.getComponentsInLibraryComponentSetAsync()`.  
Those are **set-level library identifiers**, NOT publishable component keys.

**Root cause discovered:** The ONLY keys that work with `importComponentByKeyAsync` are ones obtained from:
```js
const mc = await instance.getMainComponentAsync();
mc.key  // ← this is the valid published component key
```

**Fix implemented (last session):**

1. **`design-system.ts` — section 4 rewritten:**
   - Step A: `teamLibrary.getAvailableLibraryComponentSetsAsync()` → collect set **names only** (do NOT use these keys for import)
   - Step B: Scan ALL instances on ALL pages → `inst.getMainComponentAsync().key` → store in `componentKeyMap`
   - `componentKeyMap` shape: `{ [setName]: { setKey: "", componentKey: string, libraryName: string } }`

2. **`handleCreateInstance` in `code.ts` — fully rewritten:**
   - **Primary:** `figma.loadAllPagesAsync()` → scan ALL instances → match by `mainComponent.parent.name` or `mainComponent.name` → `importComponentByKeyAsync(mc.key)`
   - **Secondary:** check `state.componentKeyMap` (pre-cached from Auto-detect)
   - **Tertiary:** fuzzy case-insensitive match in componentKeyMap
   - **Quaternary:** local component scan via `figma.root.findOne`
   - **Final fallback:** returns `{ error: "..." }` (does NOT throw) so LLM sees the failure and uses `create_rectangle` instead

3. **Tool description + system prompt updated** to tell LLM: _"create_instance only works if the component already exists somewhere in the file"_

**Build status:** ✅ Built successfully after these changes (`npm run build -w packages/adapter-figma`)

---

## What To Continue On The Other Machine

### Immediate next step — test `create_instance` end-to-end in Figma

1. Start relay: `npm run socket`
2. Open Figma → load the Vibma plugin
3. Click **Auto-detect Design System** (this populates `componentKeyMap` from all page instances)
4. Select a frame/container
5. Prompt: _"Add a Checkbox component before the submit button"_
6. Watch Chrome DevTools console for `[LLM turn X]` logs — confirm `create_instance` is called and succeeds

### Known edge case to handle

If a component (e.g. Checkbox) has NEVER been placed on the canvas before, the instance scan finds nothing → returns `{ error: "... no instances in file yet" }` → LLM should fall back to `create_rectangle`.

**Potential improvement:** Try importing via the set key from teamLibrary API as a last-ditch attempt — Figma _might_ support it depending on library type. If it works, update `handleCreateInstance` step 5 to try:
```js
const sets = await figma.teamLibrary.getAvailableLibraryComponentSetsAsync();
const match = sets.find(s => s.name === componentName);
if (match) {
  // try: figma.importComponentByKeyAsync(match.key) — may 404 but worth testing
}
```

### Other things to fine-tune

- **System prompt quality** — test with more complex prompts, refine tool descriptions
- **Error UX** — currently errors from `create_instance` show in console only; surface them in Shimmer/UI
- **Auto-detect on open** — optionally auto-run DS detection when plugin loads if a file was previously scanned
- **Token usage display** — show approximate token count or cost in UI after generation
- **Model selector** — currently hardcoded to whatever's in Settings; could add quick-switch dropdown in Prompt tab

---

## How To Run Locally

```bash
# 1. Install
npm install

# 2. Build plugin
npm run build -w packages/adapter-figma

# 3. Start relay (required for /llm proxy)
npm run socket

# 4. (Optional) Start MCP server for agent-driven design
npm run dev -w packages/core

# 5. In Figma: Plugins → Development → Import plugin from manifest
#    Point to: plugin/manifest.json
```

---

## Key Constraint Reminder

> `importComponentByKeyAsync(key)` ONLY works with keys from `instance.getMainComponentAsync().key`.  
> Never use keys from `getComponentsInLibraryComponentSetAsync()` or `getAvailableLibraryComponentSetsAsync()` for import — they are set-level library IDs and will always 404.
