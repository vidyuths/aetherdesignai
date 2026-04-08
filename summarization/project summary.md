# Vibma Project Summary

## Architecture: Communication Chain

```
MCP Client (Claude, etc.)
  ──stdio──▶  packages/core         (MCP server, Node.js)
  ──WS──▶     packages/tunnel       (relay on localhost:3055)
  ──WS──▶     packages/adapter-figma (Figma plugin, runs inside Figma)
```

---

## Key Folders & Files

### `packages/core/` — MCP Server

| File | Purpose |
|---|---|
| `src/mcp.ts` | Entry point — starts `McpServer`, connects to tunnel via WebSocket, registers all tools |
| `src/tools/mcp-registry.ts` | Registers all tools with the MCP SDK |
| `src/tools/registry.ts` | Maps tool names → Zod schemas + handlers |
| `src/tools/endpoint.ts` | Shared CRUD dispatcher (`createDispatcher`, `paginate`, `pickFields`) |
| `src/tools/generated/defs.ts` | **Auto-generated** Zod schemas + commandMap (from YAML — do not edit) |
| `src/tools/generated/help.ts` | Runtime help text for the `help` tool |
| `src/tools/generated/response-types.ts` | TypeScript interfaces + JSON Schema for all tool responses |
| `src/tools/iconify.ts` | Iconify icon search tool |
| `src/tools/pexels.ts` | Pexels stock image tool |

---

### `packages/adapter-figma/` — Figma Plugin

| File | Purpose |
|---|---|
| `src/plugin/manifest.json` | Plugin manifest — main: `code.js`, ui: `ui.html`, WS allowed on ports 3055–3058 |
| `src/plugin/code.ts` | Plugin main thread — receives MCP commands, dispatches to handlers |
| `src/plugin/ui.html` | Plugin UI (connection panel shown in Figma) |
| `src/handlers/` | All MCP handler implementations (run inside Figma) |

**Handler files in `src/handlers/`:**

| File | What it handles |
|---|---|
| `connection.ts` | `ping` / connection health check |
| `document.ts` | Pages: get/set current page, document info |
| `variables.ts` | Design tokens (variables) CRUD |
| `styles.ts` | Figma styles (paint, text, effect) CRUD |
| `components.ts` | Components + instances CRUD |
| `selection.ts` | Get/set current selection |
| `create-frame.ts` | Create frames/auto-layout containers |
| `create-text.ts` | Create text nodes |
| `create-shape.ts` | Create rectangles, ellipses, etc. |
| `modify-node.ts` | Move, resize, delete, clone, reparent nodes |
| `patch-nodes.ts` | Batch-update node properties |
| `fill-stroke.ts` | Set fills and strokes |
| `effects.ts` | Shadows, blurs |
| `text.ts` | Text content + style updates |
| `fonts.ts` | Font listing/loading |
| `lint.ts` | Design linting (`auditNode`) — detects hardcoded colors, missing tokens, etc. |
| `stage.ts` | Stage/canvas management |
| `annotations.ts` | Figma annotations |
| `prototyping.ts` | Prototype links/flows |
| `version-history.ts` | Version history |
| `node-info.ts` | Read node tree/snapshot |
| `inline-tree.ts` | Compact node tree serialization |
| `helpers.ts` | `batchHandler`, shared utilities |
| `registry.ts` | `allFigmaHandlers` — merged dispatch map for every command |

---

### `packages/tunnel/` — WebSocket Relay

| File | Purpose |
|---|---|
| `src/index.ts` | HTTP + WS server on port 3055; bridges MCP server ↔ Figma plugin via named channels |

Start: `npm run socket`

---

### `schema/` — Single Source of Truth (YAML → Generated Code)

| Path | Purpose |
|---|---|
| `schema/tools/*.yaml` | Tool definitions (params, methods, notes) for every endpoint |
| `schema/compiler/index.ts` | Compiler entry — regenerates all generated files |
| `schema/mixins/*.yaml` | Reusable param groups (auto-layout, fill, stroke, geometry, etc.) |
| `schema/guidelines/*.md` | Design guidelines injected into tool descriptions |
| `schema/prompts.yaml` | MCP prompt definitions |

Regenerate: `npm run codegen`

---

### Claude Code Skills (`.claude/skills/`)

| Skill | Purpose |
|---|---|
| `figma-start-macos/` | Opens Figma + launches plugin + connects via MCP (macOS/AppleScript) |
| `vibma-dev/` | Dev workflow: reproduce → trace → reuse pattern → fix → test cycle |

---

### Build / Dev Commands

| Command | Does |
|---|---|
| `npm run build` | Compiles all packages; plugin auto-reloads in Figma |
| `npm run socket` | Starts the WS relay on port 3055 |
| `npm run codegen` | Regenerates `defs.ts`, `help.ts`, `guards.ts`, `prompts.ts`, docs MDX |
| `npm run dev` | Starts MCP server in dev mode (tsx, no compile) |

---

## Notes

- There is **no single `getDesignSystem` tool** — design system context is spread across the `variables`, `styles`, `components`, and `document` endpoints.
- The `lint` handler (`lint.ts` / `auditNode`) is what audits for structural design issues: hardcoded colors, missing auto-layout, unbound tokens, etc.
- **YAML is the single source of truth** — never edit generated files in `src/tools/generated/` directly. Always edit the YAML and run `npm run codegen`.
- The relay supports **multiple named channels** — default channel is `vibma`. Each channel allows exactly one MCP and one plugin connection.
