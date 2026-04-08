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

  // A. Collect component SET NAMES from teamLibrary (do NOT fetch individual component keys)
  try {
    const availableSets = await (figma as any).teamLibrary.getAvailableLibraryComponentSetsAsync();
    for (const set of availableSets) {
      libraryComponentSetNames.add(set.name);
      if (set.libraryName) libraryNames.add(set.libraryName);
    }
  } catch (_) {
    // teamLibrary API not available — names will come from instance scan below
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

  let summary = `Detected ${variableCollections.length} variable collection${variableCollections.length !== 1 ? "s" : ""} `;
  if (localVarCount > 0 || libVarCount > 0) {
    summary += `(${localVarCount} local, ${libVarCount} from libraries) `;
  }
  summary += `and ${componentSets.length} component set${componentSets.length !== 1 ? "s" : ""} `;
  if (localComponentSets.length > 0 || libraryComponentSets.length > 0) {
    summary += `(${localComponentSets.length} local, ${libraryComponentSets.length} from libraries)`;
  }
  if (libNames.length > 0) {
    summary += `. Libraries: ${libNames.join(", ")}`;
  }
  summary = summary.trim() + ".";

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
    timestamp: Date.now(),
  };
}

export const figmaHandlers: Record<string, (params: any) => Promise<any>> = {
  get_full_design_system_context: getFullDesignSystemContext,
};
