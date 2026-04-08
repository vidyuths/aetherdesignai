// ─── Figma Handlers ──────────────────────────────────────────────

async function getFullDesignSystemContext(): Promise<Record<string, any>> {
  await figma.loadAllPagesAsync();

  // 1. Document info
  const documentName = figma.root.name;
  const currentPage = figma.currentPage.name;

  // 2. Local variable collections + their variables
  const rawCollections = await figma.variables.getLocalVariableCollectionsAsync();
  const allVars = await figma.variables.getLocalVariablesAsync();

  const localVariableCollections = rawCollections.map((col: any) => {
    const modes = col.modes.map((m: any) => m.name);
    const variables = allVars
      .filter((v: any) => v.variableCollectionId === col.id)
      .map((v: any) => ({ name: v.name, type: v.resolvedType, id: v.id }));
    return { name: col.name, modes, variables, source: "local" };
  });

  // 2b. Library variable collections (from attached libraries via teamLibrary API)
  let libraryVariableCollections: any[] = [];
  try {
    const libCollections = await (figma as any).teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const col of libCollections) {
      let variables: any[] = [];
      try {
        const libVars = await (figma as any).teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
        variables = libVars.map((v: any) => ({ name: v.name, type: v.resolvedType, key: v.key }));
      } catch (_) { /* skip if variable fetch fails */ }
      libraryVariableCollections.push({
        name: col.name,
        libraryName: col.libraryName,
        key: col.key,
        variables,
        source: "library",
      });
    }
  } catch (_) {
    // teamLibrary API not available or no attached libraries
  }

  const variableCollections = [...localVariableCollections, ...libraryVariableCollections];

  // 3. Local component sets + standalone components
  // Exclude COMPONENT nodes that are direct children of a COMPONENT_SET (they are variants, not top-level entries)
  const allComponentNodes: any[] = figma.root.findAllWithCriteria({
    types: ["COMPONENT", "COMPONENT_SET"] as any,
  }).filter((n: any) => !(n.type === "COMPONENT" && n.parent?.type === "COMPONENT_SET"));

  const localComponentSets = allComponentNodes
    .filter((n: any) => n.type === "COMPONENT_SET")
    .map((n: any) => {
      const entry: { name: string; key?: string; count: number; source: string } = {
        name: n.name,
        count: n.children?.length ?? 0,
        source: "local",
      };
      if (n.key) entry.key = n.key;
      return entry;
    });

  const localComponentsCount = allComponentNodes
    .filter((n: any) => n.type === "COMPONENT").length;

  // 4. Library component sets
  // IMPORTANT: teamLibrary.getComponentsInLibraryComponentSetAsync() returns keys that are
  // NOT compatible with figma.importComponentByKeyAsync() — they are set-level library keys,
  // not published component keys. Only use the teamLibrary API for component SET NAMES.
  // Valid importable keys can only come from existing instances (.getMainComponentAsync().key).
  const libraryComponentSetNames = new Set<string>();
  const libraryNames = new Set<string>();
  const componentKeyMap: Record<string, { setKey: string; componentKey: string; libraryName: string }> = {};

  // Load cached component data from previous detections (persists across sessions)
  try {
    const cachedMap = await (figma as any).clientStorage.getAsync("vibma_componentKeyMap");
    if (cachedMap && typeof cachedMap === "object") Object.assign(componentKeyMap, cachedMap);
    const cachedLibNames = await (figma as any).clientStorage.getAsync("vibma_libraryNames");
    if (Array.isArray(cachedLibNames)) cachedLibNames.forEach((n: string) => libraryNames.add(n));
  } catch (_) {}

  // A. Collect component set names AND set keys from teamLibrary.
  //    Set keys (not individual component keys) are stored in componentKeyMap so that
  //    handleCreateInstance can call getComponentsInLibraryComponentSetAsync(setKey)
  //    on-demand on fresh files where no instances have been placed yet.
  let componentSetFetchError: string | null = null;
  try {
    const tl = (figma as any).teamLibrary;
    if (typeof tl?.getAvailableLibraryComponentSetsAsync !== "function") {
      throw new Error("getAvailableLibraryComponentSetsAsync is not available in this Figma context");
    }
    const availableSets = await tl.getAvailableLibraryComponentSetsAsync();
    for (const set of availableSets) {
      libraryComponentSetNames.add(set.name);
      if (set.libraryName) libraryNames.add(set.libraryName);
      // Store set key so handleCreateInstance can fetch per-component keys on demand.
      // Don't overwrite — instance scan (section B) may later fill in a real componentKey.
      if (!componentKeyMap[set.name]) {
        componentKeyMap[set.name] = {
          setKey: set.key ?? "",
          componentKey: "",
          libraryName: set.libraryName ?? "",
        };
      }
    }
  } catch (e: any) {
    componentSetFetchError = e?.message ?? String(e);
    console.warn("[Vibma] Library component set detection failed:", componentSetFetchError);
  }

  // Populate libraryNames from variable collections as a reliable fallback.
  // getAvailableLibraryVariableCollectionsAsync is more widely supported and we already
  // called it above — use it to ensure library names appear in the summary even when
  // the component set API is unavailable.
  for (const col of libraryVariableCollections) {
    if (col.libraryName) libraryNames.add(col.libraryName);
  }

  // B. Collect VALID component keys by scanning existing instances (these keys work with importComponentByKeyAsync)
  const instances: any[] = figma.root.findAllWithCriteria({ types: ["INSTANCE"] as any });
  for (const inst of instances) {
    try {
      const mainComponent = await inst.getMainComponentAsync();
      if (mainComponent?.remote && mainComponent.key) {
        const setName = mainComponent.parent?.name ?? mainComponent.name;
        libraryComponentSetNames.add(setName); // capture any names missed by teamLibrary API
        const libName = (mainComponent as any).libraryName ?? (mainComponent.parent as any)?.libraryName;
        if (libName) libraryNames.add(libName);
        if (!componentKeyMap[setName]) {
          componentKeyMap[setName] = {
            setKey: "",
            componentKey: mainComponent.key,
            libraryName: libName ?? "",
          };
        }
      }
    } catch (_) {
      continue;
    }
  }

  // Persist merged componentKeyMap and library names to clientStorage for future sessions
  try {
    await (figma as any).clientStorage.setAsync("vibma_componentKeyMap", componentKeyMap);
    await (figma as any).clientStorage.setAsync("vibma_libraryNames", Array.from(libraryNames));
  } catch (_) {}

  const libraryComponentSets = Array.from(libraryComponentSetNames).map((name) => ({
    name,
    source: "library",
  }));

  const componentSets = [...localComponentSets, ...libraryComponentSets];
  const hasAttachedLibraries = libraryComponentSetNames.size > 0 || libraryVariableCollections.length > 0;

  // 5. Summary string
  const localVarCount = localVariableCollections.length;
  const libVarCount = libraryVariableCollections.length;
  const libNames = Array.from(libraryNames);
  const summaryParts: string[] = [];

  // Lead with library names — most actionable context for the LLM
  if (libNames.length > 0) {
    summaryParts.push(`Libraries attached: ${libNames.join(", ")}`);
  }

  // Variable collections
  summaryParts.push(
    `Detected ${variableCollections.length} variable collection${variableCollections.length !== 1 ? "s" : ""} (${localVarCount} local, ${libVarCount} from libraries)`
  );

  // Component sets: prefer fresh API results, then fall back to cache, then say on-demand
  if (libraryComponentSets.length > 0) {
    const sampleNames = libraryComponentSets.slice(0, 6).map(c => c.name).join(", ");
    const more = libraryComponentSets.length > 6 ? ` +${libraryComponentSets.length - 6} more` : "";
    summaryParts.push(`${libraryComponentSets.length} library component set${libraryComponentSets.length !== 1 ? "s" : ""}: ${sampleNames}${more}`);
  } else {
    const cachedNames = Object.keys(componentKeyMap);
    if (cachedNames.length > 0) {
      const sampleNames = cachedNames.slice(0, 6).join(", ");
      const more = cachedNames.length > 6 ? ` +${cachedNames.length - 6} more` : "";
      summaryParts.push(`${cachedNames.length} component${cachedNames.length !== 1 ? "s" : ""} known from previous detection: ${sampleNames}${more}`);
    } else if (libNames.length > 0) {
      summaryParts.push(`Component set names not enumerable — create_instance resolves components on-demand`);
    }
  }

  // Local component sets
  if (localComponentSets.length > 0) {
    summaryParts.push(`${localComponentSets.length} local component set${localComponentSets.length !== 1 ? "s" : ""}`);
  }

  // Fallback guidance whenever libraries are present
  if (libNames.length > 0 || hasAttachedLibraries) {
    summaryParts.push(`When unsure of exact names, prefer create_auto_layout as a safe fallback`);
  }

  const summary = summaryParts.join(". ") + ".";

  return {
    summary,
    documentName,
    currentPage,
    variableCollections,
    componentSets,
    componentKeyMap,
    localComponentsCount,
    hasAttachedLibraries,
    attachedLibraryNames: Array.from(libraryNames),
    componentSetFetchError,
    timestamp: Date.now(),
  };
}

export const figmaHandlers: Record<string, (params: any) => Promise<any>> = {
  get_full_design_system_context: getFullDesignSystemContext,
};
