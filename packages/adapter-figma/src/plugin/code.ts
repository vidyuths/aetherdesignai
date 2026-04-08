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
  componentKeyMap: {} as Record<string, { setKey: string; componentKey: string; libraryName: string }>,
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
      if (msg.componentKeyMap && typeof msg.componentKeyMap === "object") {
        state.componentKeyMap = msg.componentKeyMap;
      }
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

// ─── Command Dispatch ────────────────────────────────────────────

// ─── create_instance ────────────────────────────────────────────────────────
// Place a design system component (library or local) by set name.

async function handleCreateInstance(params: any): Promise<any> {
  const { componentName, name: overrideName, parentId, width, height } = params;
  if (!componentName) throw new Error("create_instance: componentName is required");

  await figma.currentPage.loadAsync();

  const lower = componentName.toLowerCase();

  // Helper: place instance into parent, resize, rename
  async function placeInstance(component: ComponentNode): Promise<any> {
    const instance = component.createInstance();
    if (overrideName) instance.name = overrideName;
    else instance.name = componentName;
    if (width != null) instance.resize(width, instance.height);
    if (height != null) instance.resize(instance.width, height);
    if (parentId) {
      const parent = await figma.getNodeByIdAsync(parentId);
      if (parent && "appendChild" in parent) (parent as FrameNode).appendChild(instance);
    }
    return { id: instance.id, name: instance.name };
  }

  // Helper: import by key and place
  async function importAndPlace(key: string): Promise<any> {
    const component = await figma.importComponentByKeyAsync(key);
    return placeInstance(component);
  }

  // 1. Real-time scan of ALL pages for a matching instance → get its mainComponent key
  //    This is the ONLY reliable source of keys for importComponentByKeyAsync.
  await figma.loadAllPagesAsync();
  const allInstances: InstanceNode[] = figma.root.findAllWithCriteria({ types: ["INSTANCE"] }) as InstanceNode[];
  for (const inst of allInstances) {
    try {
      const mc = await inst.getMainComponentAsync();
      if (!mc?.remote || !mc.key) continue;
      const setName = mc.parent?.name ?? mc.name ?? "";
      const matches = setName === componentName ||
        setName.toLowerCase() === lower ||
        setName.toLowerCase().includes(lower) ||
        lower.includes(setName.toLowerCase());
      if (matches) {
        try { return await importAndPlace(mc.key); } catch (_) { continue; }
      }
    } catch (_) { continue; }
  }

  // 2. Pre-cached componentKeyMap (from Auto-detect instance scan — same keys, but cached)
  const entry = state.componentKeyMap[componentName];
  if (entry?.componentKey) {
    try { return await importAndPlace(entry.componentKey); } catch (_) {}
  }
  // fuzzy match in cache
  const fuzzyKey = Object.keys(state.componentKeyMap).find(
    k => k.toLowerCase() === lower || k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()),
  );
  if (fuzzyKey && state.componentKeyMap[fuzzyKey]?.componentKey) {
    try { return await importAndPlace(state.componentKeyMap[fuzzyKey].componentKey); } catch (_) {}
  }

  // 2b. Fresh-file fallback: use the stored set key to fetch per-variant component keys on demand.
  //     getComponentsInLibraryComponentSetAsync returns LibraryComponent[] whose .key values
  //     ARE valid for importComponentByKeyAsync — unlike the set key itself.
  //     This handles files where Auto-detect ran but no instances exist on canvas yet.
  const setKeyEntry = entry
    ?? (fuzzyKey ? state.componentKeyMap[fuzzyKey] : null)
    ?? (() => {
      const k = Object.keys(state.componentKeyMap).find(
        k => k.toLowerCase() === lower || k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()),
      );
      return k ? state.componentKeyMap[k] : null;
    })();
  if (setKeyEntry?.setKey) {
    try {
      const libraryComps: any[] = await (figma as any).teamLibrary.getComponentsInLibraryComponentSetAsync(setKeyEntry.setKey);
      if (libraryComps?.length) {
        for (const lc of libraryComps) {
          try { return await importAndPlace(lc.key); } catch (_) { continue; }
        }
      }
    } catch (_) {}
  }

  // 3. Local component fallback
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

  // Automatic fallback: all import paths exhausted — create a plain auto-layout frame so
  // the LLM can still nest children inside it. Rectangles cannot have children, so we never
  // return an error that would tempt the LLM to use create_rectangle instead.
  console.warn(`Component "${componentName}" could not be imported — falling back to auto-layout frame`);
  try {
    const fallbackFrame = await allFigmaHandlers.create_auto_layout({
      name: componentName,
      layoutMode: "VERTICAL",
      ...(parentId ? { parentId } : {}),
      ...(width != null ? { width } : {}),
      ...(height != null ? { height } : {}),
    });
    return fallbackFrame;
  } catch (fallbackErr: any) {
    return { error: `Component "${componentName}" could not be imported and auto-layout fallback also failed: ${fallbackErr?.message}` };
  }
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
    description: "Place a library component from the attached design system by its exact set name. Use this for ALL ✓ components — no prior placement needed. If create_instance returns an error, use create_auto_layout as a placeholder frame (NEVER create_rectangle — rectangles cannot have children).",
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

