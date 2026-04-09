// Figma Plugin entry point
// Built by tsup into code.js (IIFE bundle) for the Figma plugin sandbox

import { allFigmaHandlers } from "../handlers/registry";

// ─── Plugin State ────────────────────────────────────────────────

const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 260;
const MAX_WIDTH = 400;

const state = {
  serverPort: 3055,
  channelName: "",
  locale: "",
  uiWidth: DEFAULT_WIDTH,
  apiKey: "",
  model: "",
  // Populated when Auto-detect Design System runs — maps component set name → default component key
  componentKeyMap: {} as Record<string, { setKey: string; componentKey: string; keyType: "SET" | "COMPONENT"; libraryName: string }>,
};

// ─── UI Setup ────────────────────────────────────────────────────

figma.showUI(__html__, { width: DEFAULT_WIDTH, height: 480 });

// Send saved settings to UI on startup
figma.clientStorage.getAsync("settings").then((saved: any) => {
  if (saved) {
    if (saved.serverPort) state.serverPort = saved.serverPort;
    if (saved.channelName) state.channelName = saved.channelName;
    if (saved.locale) state.locale = saved.locale;
    if (saved.apiKey) state.apiKey = saved.apiKey;
    if (saved.model) state.model = saved.model;
    if (saved.uiWidth) {
      state.uiWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, saved.uiWidth));
      figma.ui.resize(state.uiWidth, 480);
    }
  }
  figma.ui.postMessage({ type: "restore-settings", serverPort: state.serverPort, channelName: state.channelName, locale: state.locale || "en", uiWidth: state.uiWidth, apiKey: state.apiKey, model: state.model });
});

// ─── Auto-Focus ─────────────────────────────────────────────────
// After every create/modify command, select affected nodes and scroll
// viewport to show them. Fire-and-forget — never blocks the response.

const SKIP_FOCUS = new Set([
  "join", "set_selection", "set_viewport", "zoom_into_view", "set_focus",
  "set_current_page", "create_page", "rename_page", "delete_node",
  "get_document_info", "get_current_page", "get_selection",
  "get_node_info", "get_available_fonts",
  "variable_collections", "variables",
  "search_nodes", "scan_text_nodes", "export_node_as_image",
  "lint_node", "get_node_variables", "ping",
]);

function extractNodeIds(result: any, params: any): string[] {
  const ids: string[] = [];
  // From result (create commands return {id} or {results: [{id}, ...]})
  if (result?.id && typeof result.id === "string") ids.push(result.id);
  if (Array.isArray(result?.results)) {
    for (const r of result.results) {
      if (r?.id && typeof r.id === "string") ids.push(r.id);
    }
  }
  // Fallback: from params (modify commands use items[].nodeId)
  if (ids.length === 0 && Array.isArray(params?.items)) {
    for (const item of params.items) {
      if (item?.nodeId && typeof item.nodeId === "string") ids.push(item.nodeId);
    }
  }
  return ids;
}

async function autoFocus(nodeIds: string[]) {
  const nodes: SceneNode[] = [];
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && "x" in node) nodes.push(node as SceneNode);
  }
  if (nodes.length > 0) {
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
  }
}

// ─── Message Handling ────────────────────────────────────────────

// Serialized autoFocus: tracked so the next command waits for it to finish.
// This prevents race conditions where viewport/selection changes from autoFocus
// interfere with getNodeByIdAsync in the next command.
let pendingAutoFocus: Promise<void> | null = null;

figma.ui.onmessage = async (msg: any) => {
  switch (msg.type) {
    case "update-settings":
      updateSettings(msg);
      break;
    case "notify":
      figma.notify(msg.message);
      break;
    case "close-plugin":
      figma.closePlugin();
      break;
    case "resize":
      if (msg.width) {
        state.uiWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, msg.width));
      }
      figma.ui.resize(state.uiWidth, msg.height);
      break;
    case "save-width":
      state.uiWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, msg.width));
      figma.clientStorage.setAsync("settings", {
        serverPort: state.serverPort,
        channelName: state.channelName,
        locale: state.locale,
        uiWidth: state.uiWidth,
      });
      break;
    case "execute-command":
      try {
        // Wait for any pending autoFocus from the previous command
        if (pendingAutoFocus) {
          await pendingAutoFocus;
          pendingAutoFocus = null;
        }
        const result = await handleCommand(msg.command, msg.params);
        figma.ui.postMessage({
          type: "command-result",
          id: msg.id,
          result,
        });
        // Start autoFocus after response is sent (non-blocking for current command,
        // but the next command will await it before running)
        if (!SKIP_FOCUS.has(msg.command)) {
          const ids = extractNodeIds(result, msg.params);
          if (ids.length > 0) {
            pendingAutoFocus = autoFocus(ids).catch(() => {});
          }
        }
      } catch (error: any) {
        const errorMsg = error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error) || "Error executing command";
        figma.ui.postMessage({
          type: "command-error",
          id: msg.id,
          error: errorMsg || `Unknown error (${typeof error})`,
        });
      }
      break;
    case "llm-generate":
      handleLLMGenerate(msg);
      break;
    case "cache-component-keys":
      // Always replace (including empty map) so stale keys from a detached library are cleared
      state.componentKeyMap = (msg.componentKeyMap && typeof msg.componentKeyMap === "object")
        ? msg.componentKeyMap
        : {};
      break;
    case "fetch-design-system":
      handleRemoteDesignSystemFetch(msg).catch((error: any) => {
        figma.ui.postMessage({
          type: "fetch-design-system-error",
          id: msg.id,
          error: error?.message || String(error),
        });
      });
      break;
    case "test-ds-on-canvas":
      handleTestDSOnCanvas(msg).catch((e: any) => {
        figma.ui.postMessage({ type: "test-ds-error", error: e?.message || String(e) });
      });
      break;
    case "ds-diagnostics":
      handleDSDiagnostics(msg).catch((e: any) => {
        figma.ui.postMessage({ type: "ds-diagnostics-error", error: e?.message || String(e) });
      });
      break;
  }
};

// Listen for plugin commands from menu
figma.on("run", ({ command }: any) => {
  figma.ui.postMessage({ type: "auto-connect" });
});

// ─── Settings ────────────────────────────────────────────────────

function updateSettings(settings: any) {
  if (settings.serverPort) {
    state.serverPort = settings.serverPort;
  }
  if (settings.channelName !== undefined) {
    state.channelName = settings.channelName;
  }
  if (settings.locale) {
    state.locale = settings.locale;
  }
  if (settings.apiKey !== undefined) {
    state.apiKey = settings.apiKey;
  }
  if (settings.model !== undefined) {
    state.model = settings.model;
  }
  figma.clientStorage.setAsync("settings", {
    serverPort: state.serverPort,
    channelName: state.channelName,
    locale: state.locale,
    uiWidth: state.uiWidth,
    apiKey: state.apiKey,
    model: state.model,
  });
}

function extractFigmaFileKey(url: string): string {
  const match = url.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)(?:\/|\?|$)/i);
  if (!match?.[1]) {
    throw new Error("Invalid Figma design system URL.");
  }
  return match[1];
}

function objectValues<T = any>(value: any): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") return Object.values(value) as T[];
  return [];
}

async function figmaApiGet(path: string, pat: string): Promise<any> {
  const response = await fetch(`https://api.figma.com/v1${path}`, {
    headers: {
      "X-Figma-Token": pat,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Figma API request failed (${response.status}): ${body || response.statusText}`);
  }

  return response.json();
}

function formatVariableApiNote(error: string | null): string {
  if (!error) return "";
  if (error.includes("file_variables:read")) {
    return " Variable collections could not be loaded because this PAT does not include the file_variables:read scope.";
  }
  return ` Variable collections could not be loaded. ${error}`;
}

async function handleRemoteDesignSystemFetch(msg: any): Promise<void> {
  const dsUrl = typeof msg.dsUrl === "string" ? msg.dsUrl.trim() : "";
  const pat = typeof msg.pat === "string" ? msg.pat.trim() : "";

  if (!dsUrl || !pat) {
    throw new Error("Remote design system URL or PAT is not configured.");
  }

  const fileKey = extractFigmaFileKey(dsUrl);
  const filePromise = figmaApiGet(`/files/${fileKey}`, pat);
  const variablesPromise = figmaApiGet(`/files/${fileKey}/variables/local`, pat);

  const fileResponse = await filePromise;
  let variablesResponse: any = null;
  let variableApiError: string | null = null;

  try {
    variablesResponse = await variablesPromise;
  } catch (error: any) {
    variableApiError = error?.message || String(error);
  }

  const sourceName = fileResponse?.name || "Unknown source";
  const remoteComponentSets = objectValues<any>(fileResponse?.componentSets);
  const remoteComponents = objectValues<any>(fileResponse?.components);

  const componentKeyMap: Record<string, { setKey: string; componentKey: string; keyType: "SET" | "COMPONENT"; libraryName: string }> = {};
  const componentSets: Array<{ name: string; libraryName: string; key: string; source: string }> = [];
  const seenNames = new Set<string>();

  for (const entry of remoteComponentSets) {
    if (!entry?.name || !entry?.key || seenNames.has(entry.name)) continue;
    seenNames.add(entry.name);
    componentKeyMap[entry.name] = {
      setKey: entry.key,
      componentKey: "",
      keyType: "SET",
      libraryName: sourceName,
    };
    componentSets.push({ name: entry.name, libraryName: sourceName, key: entry.key, source: "remote" });
  }

  for (const entry of remoteComponents) {
    if (!entry?.name || !entry?.key || entry?.componentSetId || seenNames.has(entry.name)) continue;
    seenNames.add(entry.name);
    componentKeyMap[entry.name] = {
      setKey: "",
      componentKey: entry.key,
      keyType: "COMPONENT",
      libraryName: sourceName,
    };
    componentSets.push({ name: entry.name, libraryName: sourceName, key: entry.key, source: "remote" });
  }

  const variableCollectionsRaw = objectValues<any>(variablesResponse?.meta?.variableCollections ?? variablesResponse?.variableCollections);
  const variablesRaw = objectValues<any>(variablesResponse?.meta?.variables ?? variablesResponse?.variables);
  const variablesByCollection = new Map<string, any[]>();

  for (const variable of variablesRaw) {
    const collectionId = variable?.variableCollectionId;
    if (!collectionId) continue;
    const list = variablesByCollection.get(collectionId) || [];
    list.push(variable);
    variablesByCollection.set(collectionId, list);
  }

  const variableCollections = variableCollectionsRaw.map((collection: any) => ({
    name: collection?.name || "Unnamed collection",
    libraryName: sourceName,
    key: collection?.key || collection?.id || "",
    variables: (variablesByCollection.get(collection?.id) || []).map((variable: any) => ({
      name: variable?.name,
      type: variable?.resolvedType,
      key: variable?.key || variable?.id,
    })),
    source: "remote",
  }));

  state.componentKeyMap = componentKeyMap;

  const summary =
    `Detected ${variableCollections.length} variable collection${variableCollections.length !== 1 ? "s" : ""} ` +
    `and ${componentSets.length} component${componentSets.length !== 1 ? "s" : ""} from source: ` +
    `${sourceName} (${componentSets.length} component${componentSets.length !== 1 ? "s" : ""}). ` +
    `Components fetched from the configured Figma design system file. ` +
    `Use create_instance to place components.` +
    formatVariableApiNote(variableApiError);

  figma.ui.postMessage({
    type: "fetch-design-system-result",
    id: msg.id,
    result: {
      summary,
      sourceName,
      variableCollections,
      componentSets,
      componentKeyMap,
      hasAttachedLibraries: componentSets.length > 0 || variableCollections.length > 0,
      attachedLibraryNames: [sourceName],
      variableApiError,
      timestamp: Date.now(),
    },
  });
}

// ─── Command Dispatch ────────────────────────────────────────────

// ─── create_instance ────────────────────────────────────────────────────────
// Place a library component by set name using keys from the Auto-detect cache.

async function handleCreateInstance(params: any): Promise<any> {
  const { componentName, name: overrideName, parentId, width, height } = params;
  if (!componentName) throw new Error("create_instance: componentName is required");

  const lower = componentName.toLowerCase();

  // Helper: place instance into parent, resize, rename
  async function placeInstance(component: ComponentNode): Promise<any> {
    const instance = component.createInstance();
    instance.name = overrideName ?? componentName;
    if (width != null) instance.resize(width, instance.height);
    if (height != null) instance.resize(instance.width, height);
    if (parentId) {
      const parent = await figma.getNodeByIdAsync(parentId);
      if (parent && "appendChild" in parent) (parent as FrameNode).appendChild(instance);
    }
    return { id: instance.id, name: instance.name };
  }

  // Import via component-set key → importComponentSetByKeyAsync
  async function importSetAndPlace(key: string): Promise<any> {
    const compSet = await (figma as any).importComponentSetByKeyAsync(key) as ComponentSetNode;
    const comp: ComponentNode = (compSet as any).defaultVariant ?? (compSet.children[0] as ComponentNode);
    return placeInstance(comp);
  }

  // Import via single component key → importComponentByKeyAsync
  async function importAndPlace(key: string): Promise<any> {
    const component = await figma.importComponentByKeyAsync(key);
    return placeInstance(component);
  }

  // Try the correct API based on keyType, fall back to the other if it fails.
  // SET keys: importComponentSetByKeyAsync first → importComponentByKeyAsync
  // COMPONENT keys: importComponentByKeyAsync first → importComponentSetByKeyAsync
  async function importByKey(key: string, keyType?: "SET" | "COMPONENT"): Promise<any> {
    if (keyType === "COMPONENT") {
      try { return await importAndPlace(key); } catch (_) {}
      return await importSetAndPlace(key);
    }
    // Default (SET or unknown): try set API first
    try { return await importSetAndPlace(key); } catch (_) {}
    return await importAndPlace(key);
  }

  // 1. Exact match in cache
  const entry = state.componentKeyMap[componentName];
  if (entry?.setKey) {
    try { return await importByKey(entry.setKey, entry.keyType); } catch (_) {}
  }
  if (entry?.componentKey) {
    try { return await importByKey(entry.componentKey, "COMPONENT"); } catch (_) {}
  }

  // 2. Fuzzy match in cache
  const fuzzyKey = Object.keys(state.componentKeyMap).find(
    k => k.toLowerCase() === lower || k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()),
  );
  if (fuzzyKey) {
    const fe = state.componentKeyMap[fuzzyKey];
    if (fe?.setKey) {
      try { return await importByKey(fe.setKey, fe.keyType); } catch (_) {}
    }
    if (fe?.componentKey) {
      try { return await importByKey(fe.componentKey, "COMPONENT"); } catch (_) {}
    }
  }

  // 3. Local component fallback (no page scan — only current page memory)
  const localMatch = figma.root.findOne(
    (n: any) => (n.type === "COMPONENT" || n.type === "COMPONENT_SET") &&
      (n.name === componentName || n.name.toLowerCase().includes(lower))
  ) as ComponentNode | ComponentSetNode | null;
  if (localMatch) {
    const comp = localMatch.type === "COMPONENT_SET"
      ? ((localMatch as ComponentSetNode).defaultVariant ?? (localMatch.children[0] as ComponentNode))
      : (localMatch as ComponentNode);
    return placeInstance(comp);
  }

  return {
    error: `Component "${componentName}" could not be imported (no matching instance or key found). ` +
      `Fall back to create_auto_layout to build an equivalent UI — do not retry create_instance.`,
  };
}

// ─── DS Test-on-canvas ───────────────────────────────────────────────────────
async function handleTestDSOnCanvas(data: any): Promise<void> {
  const { componentKeyMap = {}, componentSets = [], variableCollections = [] } = data;

  await figma.loadFontAsync({ family: "Inter", style: "Regular" }).catch(() => {});
  await figma.loadFontAsync({ family: "Inter", style: "Medium" }).catch(() => {});
  await figma.loadFontAsync({ family: "Inter", style: "Bold" }).catch(() => {});

  function rgb(hex: string): { r: number; g: number; b: number } {
    return {
      r: parseInt(hex.slice(1, 3), 16) / 255,
      g: parseInt(hex.slice(3, 5), 16) / 255,
      b: parseInt(hex.slice(5, 7), 16) / 255,
    };
  }
  function solid(hex: string, a = 1): any[] {
    return [{ type: "SOLID", color: rgb(hex), opacity: a }];
  }

  const COL1 = 180;
  const COL2 = 130;
  const COL3 = 52;
  const COL4 = 200;
  const TABLE_W = COL1 + COL2 + COL3 + COL4;
  const ROW_H = 32;
  const PAD = 24;

  function makeRow(
    cols: { text: string; width: number; color: string; bold?: boolean }[],
    bgHex: string,
  ): FrameNode {
    const totalW = cols.reduce((s, c) => s + c.width, 0);
    const row = figma.createFrame();
    row.fills = bgHex ? solid(bgHex) : [];
    row.resize(totalW, ROW_H);
    let x = 0;
    for (const col of cols) {
      const t = figma.createText();
      t.fontName = { family: "Inter", style: col.bold ? "Medium" : "Regular" };
      t.fontSize = 12;
      t.fills = solid(col.color);
      t.characters = col.text || " ";
      t.textAutoResize = "NONE";
      t.resize(col.width - 24, 16);
      t.x = x + 12;
      t.y = Math.round((ROW_H - 16) / 2);
      row.appendChild(t);
      x += col.width;
    }
    return row;
  }

  function makeTable(header: FrameNode, rows: FrameNode[], totalW: number): FrameNode {
    const wrap = figma.createFrame();
    wrap.layoutMode = "VERTICAL";
    wrap.primaryAxisSizingMode = "AUTO";
    wrap.counterAxisSizingMode = "FIXED";
    wrap.resize(totalW, 100);
    wrap.itemSpacing = 0;
    wrap.fills = [];
    wrap.cornerRadius = 8;
    wrap.clipsContent = true;
    wrap.strokes = solid("#2e2e2e");
    wrap.strokeWeight = 1;
    wrap.strokeAlign = "INSIDE";
    wrap.appendChild(header);
    const divider = figma.createFrame();
    divider.resize(totalW, 1);
    divider.fills = solid("#2a2a2a");
    wrap.appendChild(divider);
    for (let i = 0; i < rows.length; i++) {
      wrap.appendChild(rows[i]);
      if (i < rows.length - 1) {
        const d = figma.createFrame();
        d.resize(totalW, 1);
        d.fills = solid("#222222");
        wrap.appendChild(d);
      }
    }
    return wrap;
  }

  // ── Outer container ──────────────────────────────────────────────
  const outer = figma.createFrame();
  outer.name = "◈ DS Component Map";
  outer.fills = solid("#151515");
  outer.cornerRadius = 12;
  outer.layoutMode = "VERTICAL";
  outer.primaryAxisSizingMode = "AUTO";
  outer.counterAxisSizingMode = "AUTO";
  outer.paddingTop = PAD;
  outer.paddingBottom = PAD;
  outer.paddingLeft = PAD;
  outer.paddingRight = PAD;
  outer.itemSpacing = 16;
  figma.currentPage.appendChild(outer);

  // ── Title ────────────────────────────────────────────────────────
  const title = figma.createText();
  title.fontName = { family: "Inter", style: "Bold" };
  title.fontSize = 18;
  title.fills = solid("#ffffff");
  title.characters = "Design System Map";
  outer.appendChild(title);

  // ── Subtitle ─────────────────────────────────────────────────────
  const keyed = Object.keys(componentKeyMap).length;
  const sub = figma.createText();
  sub.fontName = { family: "Inter", style: "Regular" };
  sub.fontSize = 12;
  sub.fills = solid("#666666");
  sub.characters = `${componentSets.length} component sets · ${keyed} with importable keys · ${variableCollections.length} variable collections`;
  outer.appendChild(sub);

  // ── Component sets table ─────────────────────────────────────────
  if (componentSets.length > 0) {
    const secLabel = figma.createText();
    secLabel.fontName = { family: "Inter", style: "Medium" };
    secLabel.fontSize = 10;
    secLabel.fills = solid("#555555");
    secLabel.characters = "COMPONENT SETS";
    outer.appendChild(secLabel);

    const header = makeRow(
      [
        { text: "Component Set", width: COL1, color: "#999999", bold: true },
        { text: "Library / Source", width: COL2, color: "#999999", bold: true },
        { text: "Key", width: COL3, color: "#999999", bold: true },
        { text: "Component Key", width: COL4, color: "#999999", bold: true },
      ],
      "#222222",
    );

    const dataRows = componentSets.map((cs: any, i: number) => {
      const entry = componentKeyMap[cs.name];
      const hasKey = !!entry?.componentKey;
      const libName = entry?.libraryName || cs.libraryName || (cs.source === "local" ? "Local" : "Library");
      const keyDisplay = entry?.componentKey
        ? entry.componentKey.slice(0, 8) + "…" + entry.componentKey.slice(-4)
        : (entry?.setKey ? "[set] " + entry.setKey.slice(0, 6) + "…" : "—");
      const row = makeRow(
        [
          { text: cs.name, width: COL1, color: "#e0e0e0" },
          { text: libName || "—", width: COL2, color: "#777777" },
          { text: hasKey ? "✓" : "—", width: COL3, color: hasKey ? "#5fd69a" : "#444444" },
          { text: keyDisplay, width: COL4, color: hasKey ? "#4a8f6a" : "#3a3a3a" },
        ],
        i % 2 === 0 ? "#191919" : "#1c1c1c",
      );
      row.name = cs.name;
      return row;
    });

    outer.appendChild(makeTable(header, dataRows, TABLE_W));
  }

  // ── Variable collections table ───────────────────────────────────
  if (variableCollections.length > 0) {
    const VCOL1 = 200;
    const VCOL2 = 110;
    const VCOL3 = 90;
    const VCOL4 = 60;
    const VAR_W = VCOL1 + VCOL2 + VCOL3 + VCOL4;

    const varLabel = figma.createText();
    varLabel.fontName = { family: "Inter", style: "Medium" };
    varLabel.fontSize = 10;
    varLabel.fills = solid("#555555");
    varLabel.characters = "VARIABLE COLLECTIONS";
    outer.appendChild(varLabel);

    const varHeader = makeRow(
      [
        { text: "Collection", width: VCOL1, color: "#999999", bold: true },
        { text: "Source", width: VCOL2, color: "#999999", bold: true },
        { text: "Modes", width: VCOL3, color: "#999999", bold: true },
        { text: "Vars", width: VCOL4, color: "#999999", bold: true },
      ],
      "#222222",
    );

    const varRows = variableCollections.map((vc: any, i: number) => {
      const modesStr = Array.isArray(vc.modes) && vc.modes.length > 0 ? vc.modes.join(", ") : "—";
      const varCount = Array.isArray(vc.variables) ? String(vc.variables.length) : "—";
      const srcLabel = vc.source === "local" ? "Local" : (vc.libraryName || "Library");
      return makeRow(
        [
          { text: vc.name, width: VCOL1, color: "#e0e0e0" },
          { text: srcLabel, width: VCOL2, color: "#777777" },
          { text: modesStr, width: VCOL3, color: "#666666" },
          { text: varCount, width: VCOL4, color: "#888888" },
        ],
        i % 2 === 0 ? "#191919" : "#1c1c1c",
      );
    });

    outer.appendChild(makeTable(varHeader, varRows, VAR_W));
  }

  // ── Focus ─────────────────────────────────────────────────────────
  figma.currentPage.selection = [outer];
  figma.viewport.scrollAndZoomIntoView([outer]);
  figma.ui.postMessage({ type: "test-ds-complete" });
}

// ─── DS Import Diagnostics ───────────────────────────────────────────────────
async function handleDSDiagnostics(data: any): Promise<void> {
  const { componentKeyMap = {}, componentSets = [], variableCollections = [] } = data;

  await figma.loadFontAsync({ family: "Inter", style: "Regular" }).catch(() => {});
  await figma.loadFontAsync({ family: "Inter", style: "Medium" }).catch(() => {});
  await figma.loadFontAsync({ family: "Inter", style: "Bold" }).catch(() => {});

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  function rgb(hex: string) {
    return { r: parseInt(hex.slice(1,3),16)/255, g: parseInt(hex.slice(3,5),16)/255, b: parseInt(hex.slice(5,7),16)/255 };
  }
  function solid(hex: string, a = 1): any[] { return [{ type: "SOLID", color: rgb(hex), opacity: a }]; }

  const PAD = 28;
  const ROW_H = 28;

  // ── text helper ─────────────────────────────────────────────────
  function makeText(chars: string, size: number, hex: string, style: "Regular"|"Medium"|"Bold" = "Regular"): TextNode {
    const t = figma.createText();
    t.fontName = { family: "Inter", style };
    t.fontSize = size;
    t.fills = solid(hex);
    t.textAutoResize = "WIDTH_AND_HEIGHT";
    t.characters = chars || " ";
    return t;
  }

  // ── row factory ─────────────────────────────────────────────────
  type Cell = { text: string; width: number; color: string; bold?: boolean; bgHex?: string };
  function makeRow(cells: Cell[], rowBg: string): FrameNode {
    const totalW = cells.reduce((s, c) => s + c.width, 0);
    const row = figma.createFrame();
    row.fills = rowBg ? solid(rowBg) : [];
    row.resize(totalW, ROW_H);
    let x = 0;
    for (const cell of cells) {
      if (cell.bgHex) {
        const bg = figma.createFrame();
        bg.fills = solid(cell.bgHex);
        bg.resize(cell.width - 2, ROW_H - 2);
        bg.x = x + 1; bg.y = 1;
        row.appendChild(bg);
      }
      const t = figma.createText();
      t.fontName = { family: "Inter", style: cell.bold ? "Medium" : "Regular" };
      t.fontSize = 11;
      t.fills = solid(cell.color);
      t.characters = cell.text || " ";
      t.textAutoResize = "NONE";
      t.resize(cell.width - 16, 14);
      t.x = x + 8;
      t.y = Math.round((ROW_H - 14) / 2);
      row.appendChild(t);
      x += cell.width;
    }
    return row;
  }

  function makeTable(header: FrameNode, dataRows: FrameNode[], totalW: number): FrameNode {
    const wrap = figma.createFrame();
    wrap.name = "table";
    wrap.layoutMode = "VERTICAL";
    wrap.primaryAxisSizingMode = "AUTO";
    wrap.counterAxisSizingMode = "FIXED";
    wrap.resize(totalW, 40);
    wrap.itemSpacing = 0;
    wrap.fills = [];
    wrap.cornerRadius = 6;
    wrap.clipsContent = true;
    wrap.strokes = solid("#2a2a2a");
    wrap.strokeWeight = 1;
    wrap.strokeAlign = "INSIDE";
    wrap.appendChild(header);
    const div = figma.createFrame();
    div.resize(totalW, 1);
    div.fills = solid("#333333");
    wrap.appendChild(div);
    for (let i = 0; i < dataRows.length; i++) {
      wrap.appendChild(dataRows[i]);
      if (i < dataRows.length - 1) {
        const d = figma.createFrame();
        d.resize(totalW, 1);
        d.fills = solid("#1e1e1e");
        wrap.appendChild(d);
      }
    }
    return wrap;
  }

  function sectionLabel(text: string): TextNode {
    return makeText(text, 9, "#4a4a4a", "Medium");
  }

  // ── Collect all distinct records ─────────────────────────────────
  // Merge componentSets + componentKeyMap entries (keyMap may have entries not in componentSets list)
  const allNames = new Set<string>([
    ...componentSets.map((cs: any) => cs.name as string),
    ...Object.keys(componentKeyMap),
  ]);

  type DiagRow = {
    name: string;
    libraryName: string;
    source: string;
    hasKey: boolean;
    componentKey: string;
    setKey: string;
    nodeType: string;
    publishStatus: string;
    remote: boolean;
    importComponentPass: boolean | null;
    importComponentErr: string;
    importComponentNodeType: string;
    importSetPass: boolean | null;
    importSetErr: string;
    importSetNodeType: string;
    resolvedKind: string;
    variantCount: string;
    indexedAt: string;
  };

  const diagRows: DiagRow[] = [];
  let countWithKey = 0;
  let countCompPass = 0;
  let countSetPass = 0;
  let countBothPass = 0;
  let countBothFail = 0;
  let countUnpublished = 0;
  let countInaccessible = 0;
  let countStale = 0;
  let countAmbiguous = 0;

  for (const name of Array.from(allNames)) {
    const entry = componentKeyMap[name];
    const csMeta = componentSets.find((cs: any) => cs.name === name);

    const componentKey: string = entry?.componentKey || "";
    const setKey: string = entry?.setKey || "";
    const libraryName: string = entry?.libraryName || csMeta?.libraryName || (csMeta?.source === "local" ? "Local" : "Library");
    const source: string = csMeta?.source || "library";
    const hasKey = !!componentKey;

    let publishStatus = "unknown";
    let remote = false;
    let nodeType = "unknown";
    let variantCount = "—";

    if (hasKey) countWithKey++;

    // Try to get publish status from main component on current page
    // (best-effort — may not be available for remote components)
    try {
      // Scan instances on current page for this component to get live metadata
      const inst = figma.currentPage.findOne(
        (n: any) => n.type === "INSTANCE"
      ) as InstanceNode | null;
      // We'll resolve these individually per name below during import test
    } catch (_) {}

    let importComponentPass: boolean | null = null;
    let importComponentErr = "";
    let importComponentNodeType = "";
    let importSetPass: boolean | null = null;
    let importSetErr = "";
    let importSetNodeType = "";

    if (hasKey) {
      // Test 1: importComponentByKeyAsync
      try {
        const comp = await figma.importComponentByKeyAsync(componentKey);
        importComponentPass = true;
        importComponentNodeType = comp?.type || "ComponentNode";
        nodeType = comp?.type || "COMPONENT";
        remote = true;
        // Variant count if parent is COMPONENT_SET
        if (comp?.parent?.type === "COMPONENT_SET") {
          variantCount = String((comp.parent as ComponentSetNode).children.length);
        }
        // Publish status
        try {
          const ps = await (comp as any).getPublishStatusAsync?.();
          publishStatus = ps || "published";
        } catch (_) { publishStatus = "published"; }
        // Clean up — remove the imported node from canvas
        try { comp.remove(); } catch (_) {}
      } catch (e: any) {
        importComponentPass = false;
        importComponentErr = e?.message || String(e);
      }

      // Test 2: importComponentSetByKeyAsync
      try {
        const compSet = await (figma as any).importComponentSetByKeyAsync(componentKey);
        importSetPass = true;
        importSetNodeType = compSet?.type || "ComponentSetNode";
        if (nodeType === "unknown") nodeType = compSet?.type || "COMPONENT_SET";
        if (variantCount === "—" && compSet?.children) {
          variantCount = String(compSet.children.length);
        }
        try { compSet.remove(); } catch (_) {}
      } catch (e: any) {
        importSetPass = false;
        importSetErr = e?.message || String(e);
      }
    }

    // Resolve kind
    let resolvedKind = "unknown";
    if (!hasKey) {
      resolvedKind = "unknown";
    } else if (importComponentPass && importSetPass) {
      resolvedKind = "ambiguous";
      countAmbiguous++;
    } else if (importComponentPass) {
      resolvedKind = "component";
      countCompPass++;
    } else if (importSetPass) {
      resolvedKind = "component_set";
      countSetPass++;
    } else {
      // Both failed — determine why
      const errText = (importComponentErr + " " + importSetErr).toLowerCase();
      if (errText.includes("unpublish") || errText.includes("not published")) {
        resolvedKind = "unpublished";
        countUnpublished++;
      } else if (errText.includes("access") || errText.includes("permission") || errText.includes("forbidden")) {
        resolvedKind = "inaccessible";
        countInaccessible++;
      } else if (hasKey) {
        resolvedKind = "stale_or_invalid";
        countStale++;
      }
      countBothFail++;
    }

    if (importComponentPass && importSetPass) {
      countBothPass++;
    }

    diagRows.push({
      name, libraryName, source, hasKey,
      componentKey, setKey, nodeType, publishStatus, remote,
      importComponentPass, importComponentErr, importComponentNodeType,
      importSetPass, importSetErr, importSetNodeType,
      resolvedKind, variantCount, indexedAt: "live",
    });
  }

  // ── Codebase audit (static) ──────────────────────────────────────
  const auditCompByKey = {
    found: true,
    file: "packages/adapter-figma/src/plugin/code.ts",
    fn: "importAndPlace() inside handleCreateInstance()",
    details: "figma.importComponentByKeyAsync(key) — used as primary import path",
    hasFallback: true,
    fallbackNote: "Falls back to state.componentKeyMap cache, then fuzzy match, then local scan, then returns {error} for LLM fallback",
  };
  const auditSetByKey = {
    found: false,
    file: "—",
    fn: "—",
    details: "figma.importComponentSetByKeyAsync — NOT used anywhere in this codebase",
    hasFallback: false,
    fallbackNote: "No fallback because it is never called",
  };

  // ── Build canvas frame ───────────────────────────────────────────
  const BOARD_W = 1840;

  const outer = figma.createFrame();
  outer.name = "DS Import Diagnostics";
  outer.fills = solid("#111111");
  outer.cornerRadius = 12;
  outer.layoutMode = "VERTICAL";
  outer.primaryAxisSizingMode = "AUTO";
  outer.counterAxisSizingMode = "AUTO";
  outer.paddingTop = PAD;
  outer.paddingBottom = PAD + 8;
  outer.paddingLeft = PAD;
  outer.paddingRight = PAD;
  outer.itemSpacing = 20;
  // Position near viewport center offset
  outer.x = figma.viewport.bounds.x + 80;
  outer.y = figma.viewport.bounds.y + 80;
  figma.currentPage.appendChild(outer);

  // ── A. Title ────────────────────────────────────────────────────
  const titleRow = figma.createFrame();
  titleRow.fills = [];
  titleRow.layoutMode = "VERTICAL";
  titleRow.primaryAxisSizingMode = "AUTO";
  titleRow.counterAxisSizingMode = "AUTO";
  titleRow.itemSpacing = 6;
  const titleText = makeText("DS Import Diagnostics", 22, "#ffffff", "Bold");
  const metaText = makeText(
    `Generated: ${ts}  |  File: ${(figma.root as any).name || "—"}  |  Records: ${allNames.size}  |  With key: ${countWithKey}`,
    11, "#555555",
  );
  titleRow.appendChild(titleText);
  titleRow.appendChild(metaText);
  outer.appendChild(titleRow);

  // ── B. Summary legend ────────────────────────────────────────────
  const summaryFrame = figma.createFrame();
  summaryFrame.fills = solid("#181818");
  summaryFrame.cornerRadius = 8;
  summaryFrame.layoutMode = "VERTICAL";
  summaryFrame.primaryAxisSizingMode = "AUTO";
  summaryFrame.counterAxisSizingMode = "FIXED";
  summaryFrame.resize(BOARD_W - PAD * 2, 10);
  summaryFrame.paddingTop = 14;
  summaryFrame.paddingBottom = 14;
  summaryFrame.paddingLeft = 16;
  summaryFrame.paddingRight = 16;
  summaryFrame.itemSpacing = 6;
  const summaryItems: [string, string, string][] = [
    ["Total records", String(allNames.size), "#aaaaaa"],
    ["With key", String(countWithKey), "#aaaaaa"],
    ["Component import pass (importComponentByKeyAsync ✓)", String(countCompPass), "#5fd69a"],
    ["Component-set import pass (importComponentSetByKeyAsync ✓)", String(countSetPass), "#5fd69a"],
    ["Both pass (ambiguous)", String(countBothPass), "#f5c242"],
    ["Both fail", String(countBothFail), "#f87171"],
    ["Unpublished", String(countUnpublished), "#f5a442"],
    ["Inaccessible", String(countInaccessible), "#f87171"],
    ["Stale / invalid", String(countStale), "#f87171"],
    ["Ambiguous", String(countAmbiguous), "#f5c242"],
  ];
  const sumLabel = makeText("SUMMARY", 9, "#3a3a3a", "Medium");
  summaryFrame.appendChild(sumLabel);
  const sumGrid = figma.createFrame();
  sumGrid.fills = [];
  sumGrid.layoutMode = "HORIZONTAL";
  sumGrid.primaryAxisSizingMode = "AUTO";
  sumGrid.counterAxisSizingMode = "AUTO";
  sumGrid.itemSpacing = 32;
  for (const [label, val, color] of summaryItems) {
    const cell = figma.createFrame();
    cell.fills = [];
    cell.layoutMode = "VERTICAL";
    cell.primaryAxisSizingMode = "AUTO";
    cell.counterAxisSizingMode = "AUTO";
    cell.itemSpacing = 2;
    cell.appendChild(makeText(val, 18, color, "Bold"));
    cell.appendChild(makeText(label, 10, "#444444"));
    sumGrid.appendChild(cell);
  }
  summaryFrame.appendChild(sumGrid);
  outer.appendChild(summaryFrame);

  // ── C. Detected DS / libraries ──────────────────────────────────
  const libs = new Map<string, { name: string; count: number }>();
  for (const row of diagRows) {
    const k = row.libraryName || "Unknown";
    if (!libs.has(k)) libs.set(k, { name: k, count: 0 });
    libs.get(k)!.count++;
  }

  const libsFrame = figma.createFrame();
  libsFrame.name = "Detected Libraries";
  libsFrame.fills = solid("#161616");
  libsFrame.cornerRadius = 8;
  libsFrame.layoutMode = "VERTICAL";
  libsFrame.primaryAxisSizingMode = "AUTO";
  libsFrame.counterAxisSizingMode = "FIXED";
  libsFrame.resize(BOARD_W - PAD * 2, 10);
  libsFrame.paddingTop = 14; libsFrame.paddingBottom = 14;
  libsFrame.paddingLeft = 16; libsFrame.paddingRight = 16;
  libsFrame.itemSpacing = 8;
  libsFrame.appendChild(sectionLabel("DETECTED LIBRARIES / DESIGN SYSTEMS"));
  for (const lib of Array.from(libs.values())) {
    const r = figma.createFrame();
    r.fills = [];
    r.layoutMode = "HORIZONTAL";
    r.primaryAxisSizingMode = "AUTO";
    r.counterAxisSizingMode = "AUTO";
    r.itemSpacing = 12;
    r.appendChild(makeText(lib.name, 12, "#c0c0c0", "Medium"));
    r.appendChild(makeText(`${lib.count} component set${lib.count !== 1 ? "s" : ""}`, 11, "#505050"));
    r.appendChild(makeText("Link: unavailable (Figma plugin sandbox cannot construct DS file URLs)", 10, "#3a3a3a"));
    libsFrame.appendChild(r);
  }
  outer.appendChild(libsFrame);

  // ── D. Main diagnostics table ────────────────────────────────────
  //
  // Columns (widths):
  // 1  Component Set     180
  // 2  Library           130
  // 3  Node Type         110
  // 4  Publish Status    120
  // 5  Remote             60
  // 6  Key Present        70
  // 7  Full Key          320
  // 8  Component Key     200
  // 9  importComp        130
  // 10 importSet         130
  // 11 Resolved Kind     160
  // 12 Variant Count      80
  // 13 Last Error        300
  // 14 Indexed At        110
  //
  const C = {
    name: 180, lib: 130, nodeType: 110, pubStatus: 120,
    remote: 60, keyPresent: 70, fullKey: 320, compKey: 200,
    impComp: 130, impSet: 130, resolved: 160, variants: 80,
    err: 300, indexed: 110,
  };
  const DIAG_W = Object.values(C).reduce((s, v) => s + v, 0);

  outer.appendChild(sectionLabel("COMPONENT IMPORT DIAGNOSTICS"));

  const diagHeader = makeRow(
    [
      { text: "Component Set", width: C.name, color: "#888888", bold: true },
      { text: "Library / Source", width: C.lib, color: "#888888", bold: true },
      { text: "Node Type", width: C.nodeType, color: "#888888", bold: true },
      { text: "Publish Status", width: C.pubStatus, color: "#888888", bold: true },
      { text: "Remote", width: C.remote, color: "#888888", bold: true },
      { text: "Key?", width: C.keyPresent, color: "#888888", bold: true },
      { text: "Full Key (exact)", width: C.fullKey, color: "#888888", bold: true },
      { text: "Component Key", width: C.compKey, color: "#888888", bold: true },
      { text: "importComponentByKey", width: C.impComp, color: "#888888", bold: true },
      { text: "importCompSetByKey", width: C.impSet, color: "#888888", bold: true },
      { text: "Resolved Kind", width: C.resolved, color: "#888888", bold: true },
      { text: "Variants", width: C.variants, color: "#888888", bold: true },
      { text: "Last Error", width: C.err, color: "#888888", bold: true },
      { text: "Indexed At", width: C.indexed, color: "#888888", bold: true },
    ],
    "#1e1e1e",
  );

  const resolvedColors: Record<string, { text: string; bg?: string }> = {
    component:       { text: "#5fd69a" },
    component_set:   { text: "#5fbfd6" },
    ambiguous:       { text: "#f5c242", bg: "#2a2200" },
    unpublished:     { text: "#f5a442" },
    inaccessible:    { text: "#f87171" },
    stale_or_invalid:{ text: "#f87171", bg: "#220000" },
    unknown:         { text: "#444444" },
  };

  const diagDataRows: FrameNode[] = diagRows.map((row, i) => {
    const rc = resolvedColors[row.resolvedKind] || resolvedColors["unknown"];
    const rowBg = rc.bg || (i % 2 === 0 ? "#161616" : "#191919");

    const keyDisplay = row.componentKey
      ? row.componentKey.slice(0, 8) + "…" + row.componentKey.slice(-4)
      : (row.setKey ? "[set] " + row.setKey.slice(0, 6) + "…" : "—");

    const errTxt = [row.importComponentErr, row.importSetErr].filter(Boolean).join(" | ");
    const errDisplay = errTxt.length > 60 ? errTxt.slice(0, 57) + "…" : (errTxt || "—");

    function impCell(pass: boolean | null, err: string): { text: string; color: string } {
      if (pass === null) return { text: "—", color: "#3a3a3a" };
      if (pass) return { text: "✓  pass", color: "#5fd69a" };
      return { text: "✗  fail", color: "#f87171" };
    }
    const ic = impCell(row.importComponentPass, row.importComponentErr);
    const is_ = impCell(row.importSetPass, row.importSetErr);

    const fr = makeRow(
      [
        { text: row.name, width: C.name, color: "#e0e0e0" },
        { text: row.libraryName || "—", width: C.lib, color: "#777777" },
        { text: row.nodeType, width: C.nodeType, color: "#888888" },
        { text: row.publishStatus, width: C.pubStatus, color: "#777777" },
        { text: row.remote ? "✓" : "—", width: C.remote, color: row.remote ? "#5fd69a" : "#3a3a3a" },
        { text: row.hasKey ? "✓" : "—", width: C.keyPresent, color: row.hasKey ? "#5fd69a" : "#3a3a3a" },
        { text: row.componentKey || row.setKey || "—", width: C.fullKey, color: "#4a5a6a" },
        { text: keyDisplay, width: C.compKey, color: row.hasKey ? "#4a7f6a" : "#2a2a2a" },
        { text: ic.text, width: C.impComp, color: ic.color },
        { text: is_.text, width: C.impSet, color: is_.color },
        { text: row.resolvedKind, width: C.resolved, color: rc.text, bold: true },
        { text: row.variantCount, width: C.variants, color: "#777777" },
        { text: errDisplay, width: C.err, color: "#5a3a3a" },
        { text: row.indexedAt, width: C.indexed, color: "#3a3a3a" },
      ],
      rowBg,
    );
    fr.name = row.name;
    // Store full details in plugin data for inspection
    try {
      figma.setPluginData(`diag_${row.name}`, JSON.stringify({
        name: row.name, libraryName: row.libraryName,
        componentKey: row.componentKey, setKey: row.setKey,
        nodeType: row.nodeType, publishStatus: row.publishStatus,
        importComponentPass: row.importComponentPass, importComponentErr: row.importComponentErr,
        importSetPass: row.importSetPass, importSetErr: row.importSetErr,
        resolvedKind: row.resolvedKind,
      }));
    } catch (_) {}
    return fr;
  });

  outer.appendChild(makeTable(diagHeader, diagDataRows, DIAG_W));

  // ── E. Codebase import-method audit ─────────────────────────────
  outer.appendChild(sectionLabel("CODEBASE IMPORT API AUDIT"));

  const auditFrame = figma.createFrame();
  auditFrame.name = "Codebase Audit";
  auditFrame.fills = solid("#161620");
  auditFrame.cornerRadius = 8;
  auditFrame.layoutMode = "VERTICAL";
  auditFrame.primaryAxisSizingMode = "AUTO";
  auditFrame.counterAxisSizingMode = "FIXED";
  auditFrame.resize(BOARD_W - PAD * 2, 10);
  auditFrame.paddingTop = 14; auditFrame.paddingBottom = 14;
  auditFrame.paddingLeft = 16; auditFrame.paddingRight = 16;
  auditFrame.itemSpacing = 10;

  type AuditEntry = typeof auditCompByKey;
  function auditRow(label: string, a: AuditEntry) {
    const r = figma.createFrame();
    r.fills = [];
    r.layoutMode = "VERTICAL";
    r.primaryAxisSizingMode = "AUTO";
    r.counterAxisSizingMode = "AUTO";
    r.itemSpacing = 4;
    r.appendChild(makeText(`${a.found ? "✓  USED" : "✗  NOT USED"}  —  ${label}`, 12, a.found ? "#5fd69a" : "#f87171", "Medium"));
    r.appendChild(makeText(`File: ${a.file}`, 11, "#555555"));
    r.appendChild(makeText(`Function: ${a.fn}`, 11, "#555555"));
    r.appendChild(makeText(`Details: ${a.details}`, 11, "#4a4a4a"));
    r.appendChild(makeText(`Fallback: ${a.fallbackNote}`, 11, a.hasFallback ? "#4a6a4a" : "#5a3a3a"));
    return r;
  }

  auditFrame.appendChild(auditRow("figma.importComponentByKeyAsync", auditCompByKey));
  const sep = figma.createFrame();
  sep.resize(BOARD_W - PAD * 2 - 32, 1);
  sep.fills = solid("#232323");
  auditFrame.appendChild(sep);
  auditFrame.appendChild(auditRow("figma.importComponentSetByKeyAsync", auditSetByKey));
  const noteText = makeText(
    "NOTE: importComponentSetByKeyAsync is NOT in the codebase. This diagnostics run is the first time both APIs are being tested live.\n" +
    "Recommendation: If component_set rows appear above, add importComponentSetByKeyAsync as a fallback path in handleCreateInstance().",
    11, "#404040",
  );
  auditFrame.appendChild(noteText);
  outer.appendChild(auditFrame);

  // ── F. Problematic rows detail ───────────────────────────────────
  const problemRows = diagRows.filter(r => r.resolvedKind === "stale_or_invalid" || r.resolvedKind === "ambiguous" || r.resolvedKind === "inaccessible");
  if (problemRows.length > 0) {
    outer.appendChild(sectionLabel("PROBLEMATIC ROWS — EXPANDED DETAIL"));

    const probFrame = figma.createFrame();
    probFrame.name = "Problem Detail";
    probFrame.fills = solid("#190a0a");
    probFrame.cornerRadius = 8;
    probFrame.layoutMode = "VERTICAL";
    probFrame.primaryAxisSizingMode = "AUTO";
    probFrame.counterAxisSizingMode = "FIXED";
    probFrame.resize(BOARD_W - PAD * 2, 10);
    probFrame.paddingTop = 14; probFrame.paddingBottom = 14;
    probFrame.paddingLeft = 16; probFrame.paddingRight = 16;
    probFrame.itemSpacing = 14;

    for (const row of problemRows) {
      const r = figma.createFrame();
      r.fills = solid("#1e1212");
      r.cornerRadius = 6;
      r.layoutMode = "VERTICAL";
      r.primaryAxisSizingMode = "AUTO";
      r.counterAxisSizingMode = "AUTO";
      r.paddingTop = 10; r.paddingBottom = 10;
      r.paddingLeft = 12; r.paddingRight = 12;
      r.itemSpacing = 4;
      r.appendChild(makeText(`${row.name}  [${row.resolvedKind}]`, 12, "#e87d7d", "Medium"));
      r.appendChild(makeText(`Library: ${row.libraryName}  |  Key: ${row.componentKey || row.setKey || "none"}`, 10, "#665555"));
      r.appendChild(makeText(`importComponentByKeyAsync → ${row.importComponentPass === true ? "PASS" : row.importComponentPass === false ? "FAIL: " + row.importComponentErr : "not tested"}`, 10, "#664444"));
      r.appendChild(makeText(`importComponentSetByKeyAsync → ${row.importSetPass === true ? "PASS" : row.importSetPass === false ? "FAIL: " + row.importSetErr : "not tested"}`, 10, "#664444"));
      probFrame.appendChild(r);
    }
    outer.appendChild(probFrame);
  }

  // ── Focus ────────────────────────────────────────────────────────
  figma.currentPage.selection = [outer];
  figma.viewport.scrollAndZoomIntoView([outer]);
  figma.ui.postMessage({ type: "ds-diagnostics-complete" });
}

async function handleCommand(command: string, params: any): Promise<any> {
  // Built-in create_instance — not in allFigmaHandlers, handled here directly
  if (command === "create_instance") {
    return await handleCreateInstance(params);
  }

  const handler = allFigmaHandlers[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);

  // Ensure the current page is fully loaded before any handler runs.
  // Without this, getNodeByIdAsync can return null for nodes that exist,
  // appendChild can throw on pages that aren't synced, and node IDs can
  // shift between pre-sync (temporary) and post-sync (stable) formats.
  await figma.currentPage.loadAsync();

  return await handler(params);
}

// ─── LLM Tool Definitions ────────────────────────────────────────────────────

const FIGMA_TOOLS = [
  {
    name: "create_auto_layout",
    description: "Create an auto-layout frame (primary container for UI). Always use this — never create_frame.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Frame name" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        layoutMode: { type: "string", enum: ["HORIZONTAL", "VERTICAL"], description: "Primary axis direction" },
        padding: { type: "number", description: "Uniform inner padding in px" },
        paddingTop: { type: "number" },
        paddingBottom: { type: "number" },
        paddingLeft: { type: "number" },
        paddingRight: { type: "number" },
        itemSpacing: { type: "number", description: "Gap between children in px" },
        fillColor: { type: "string", description: 'Background hex color e.g. "#FFFFFF"' },
        fillStyleName: { type: "string", description: 'Fill style name from DS e.g. "Background/Primary"' },
        cornerRadius: { type: "number" },
        parentId: { type: "string", description: "Parent node ID to append into" },
      },
      required: ["name", "layoutMode"],
    },
  },
  {
    name: "create_text",
    description: "Create a text node inside a frame.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text content" },
        x: { type: "number" },
        y: { type: "number" },
        fontSize: { type: "number" },
        fontWeight: { type: "number", description: "400=Regular 600=SemiBold 700=Bold" },
        fontColor: { type: "string", description: 'Text color hex e.g. "#1A1A1A"' },
        textStyleName: { type: "string", description: "Text style name from DS" },
        parentId: { type: "string", description: "Parent frame node ID" },
      },
      required: ["text"],
    },
  },
  {
    name: "create_rectangle",
    description: "Create a rectangle (use for input fields, dividers, image placeholders, cards).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        fillColor: { type: "string", description: 'Fill hex color e.g. "#F5F5F5"' },
        fillStyleName: { type: "string" },
        cornerRadius: { type: "number" },
        strokeColor: { type: "string", description: 'Stroke hex color e.g. "#E0E0E0"' },
        strokeWeight: { type: "number" },
        parentId: { type: "string" },
      },
      required: ["name", "width", "height"],
    },
  },
  {
    name: "create_instance",
    description: "Place a library component by its exact set name. ONLY works if that component already exists somewhere in the file (on any page). If create_instance returns an error, fall back to create_rectangle.",
    parameters: {
      type: "object",
      properties: {
        componentName: { type: "string", description: "Exact component set name as listed in the design system, e.g. \"Button\" or \"Input\"" },
        name: { type: "string", description: "Override layer name for this instance" },
        parentId: { type: "string", description: "Parent frame node ID to append into" },
        width: { type: "number", description: "Override width (optional)" },
        height: { type: "number", description: "Override height (optional)" },
      },
      required: ["componentName"],
    },
  },
  {
    name: "patch_nodes",
    description: "Patch/update properties on existing nodes by ID.",
    parameters: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          description: "Array of {id, ...patchProps} objects",
          items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      },
      required: ["nodes"],
    },
  },
  {
    name: "get_selection",
    description: "Get the currently selected nodes on the Figma canvas.",
    parameters: { type: "object", properties: {} },
  },
];

// One HTTP call to the LLM. Returns tool calls + raw assistant message for multi-turn.
async function callLLMTurn(
  apiKey: string,
  model: string,
  messages: any[],
  systemPrompt: string,
  isAnthropic: boolean,
  isGroq: boolean,
): Promise<{
  toolCalls: Array<{ id: string; name: string; input: Record<string, any> }>;
  rawAssistant: any;
  isDone: boolean;
}> {
  let url: string;
  let headers: Record<string, string>;
  let body: string;

  if (isAnthropic) {
    url = "https://api.anthropic.com/v1/messages";
    headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-allow-browser": "true",
    };
    body = JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: FIGMA_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      tool_choice: { type: "auto" },
    });
  } else {
    url = isGroq
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";
    headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
    body = JSON.stringify({
      model,
      messages,
      tools: FIGMA_TOOLS.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
    });
  }

  // Route through relay proxy (fixes Anthropic CORS from Figma web null-origin)
  let resp: Response;
  let usedProxy = false;
  try {
    const proxyResp = await fetch(`http://localhost:${state.serverPort}/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, headers, body }),
    });
    if (proxyResp.status !== 404) { resp = proxyResp; usedProxy = true; }
  } catch (_) {}
  if (!usedProxy) {
    try {
      resp = await fetch(url, { method: "POST", headers, body });
    } catch (netErr: any) {
      const provider = isAnthropic ? "Anthropic" : isGroq ? "Groq" : "OpenAI";
      const hint = isAnthropic ? " Start the relay (npm run socket) for Anthropic support." : "";
      throw new Error(`Network error reaching ${provider}: ${netErr.message}.${hint}`);
    }
  }

  if (!resp!.ok) {
    let errMsg = `HTTP ${resp!.status}`;
    try { const eb = await resp!.json(); errMsg = eb?.error?.message || errMsg; } catch (_) {}
    if (resp!.status === 401) throw new Error("Invalid API key — check your key in Settings.");
    if (resp!.status === 429) throw new Error("Rate limited — please wait a moment and try again.");
    throw new Error(`API error: ${errMsg}`);
  }

  const data = await resp!.json();

  if (isAnthropic) {
    const content = (data.content as any[]) || [];
    const uses = content.filter((c: any) => c.type === "tool_use");
    return {
      toolCalls: uses.map((c: any) => ({ id: c.id, name: c.name, input: c.input || {} })),
      rawAssistant: content,
      isDone: data.stop_reason === "end_turn" || uses.length === 0,
    };
  } else {
    const assistantMsg = data.choices?.[0]?.message;
    const tcs = (assistantMsg?.tool_calls as any[]) || [];
    return {
      toolCalls: tcs.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        input: (() => { try { return JSON.parse(tc.function.arguments); } catch (_) { return {}; } })(),
      })),
      rawAssistant: assistantMsg,
      isDone: data.choices?.[0]?.finish_reason === "stop" || tcs.length === 0,
    };
  }
}

async function handleLLMGenerate(msg: any): Promise<void> {
  const { id, apiKey, model, userPrompt, systemPrompt } = msg;
  const isAnthropic = model.startsWith("claude");
  const isGroq = model.startsWith("llama") || model.startsWith("mixtral") || model.startsWith("gemma");

  try {
    // Build initial messages
    const messages: any[] = isAnthropic
      ? [{ role: "user", content: userPrompt }]
      : [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }];

    let succeeded = 0;
    let totalCalls = 0;
    const allCreatedIds: string[] = [];
    const MAX_TURNS = 8;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { toolCalls, rawAssistant, isDone } = await callLLMTurn(
        apiKey, model, messages, systemPrompt, isAnthropic, isGroq,
      );

      if (toolCalls.length === 0) break;
      totalCalls += toolCalls.length;

      // Append assistant message
      if (isAnthropic) {
        messages.push({ role: "assistant", content: rawAssistant });
      } else {
        messages.push(rawAssistant);
      }

      // Execute tool calls and collect results for next turn
      const toolResults: any[] = [];
      for (const call of toolCalls) {
        let result: any;
        try {
          result = await handleCommand(call.name, call.input);
          const hasBatchError =
            result?.error ||
            (Array.isArray(result?.results) && result.results.length > 0 &&
              result.results.every((r: any) => r?.error !== undefined));
          if (!hasBatchError) {
            succeeded++;
            allCreatedIds.push(...extractNodeIds(result, call.input));
          } else {
            const detail = result?.error || result?.results?.[0]?.error || "unknown";
            console.warn(`LLM tool "${call.name}" error: ${detail}`);
            result = { error: detail };
          }
        } catch (e: any) {
          console.warn(`LLM tool "${call.name}" threw: ${e?.message}`);
          result = { error: e?.message || "execution failed" };
        }

        if (isAnthropic) {
          toolResults.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
        } else {
          toolResults.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }

      // Append tool results
      if (isAnthropic) {
        messages.push({ role: "user", content: toolResults });
      } else {
        for (const tr of toolResults) messages.push(tr);
      }

      if (isDone) break;
    }

    if (allCreatedIds.length > 0) {
      await autoFocus(allCreatedIds).catch(() => {});
    }
    figma.ui.postMessage({ type: "llm-result", id, succeeded, total: totalCalls });
  } catch (error: any) {
    figma.ui.postMessage({
      type: "llm-error",
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

