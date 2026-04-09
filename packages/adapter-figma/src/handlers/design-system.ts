// ─── Figma Handlers ──────────────────────────────────────────────

async function getFullDesignSystemContext(_opts?: { force?: boolean }): Promise<Record<string, any>> {
  // ── 1. Discover components by scanning instances in the document ──────────
  // NOTE: figma.teamLibrary has NO method to enumerate library components.
  //       Only variable-related methods exist on teamLibrary.
  //       Component discovery requires scanning existing instances and resolving
  //       their mainComponent to extract keys usable with:
  //         figma.importComponentSetByKeyAsync(key)   — for COMPONENT_SET keys
  //         figma.importComponentByKeyAsync(key)      — for single COMPONENT keys
  const componentKeyMap: Record<string, { setKey: string; componentKey: string; keyType: "SET" | "COMPONENT"; libraryName: string }> = {};
  const componentSets: any[] = [];
  const countByLib: Record<string, number> = {};
  let componentScanError: string | null = null;

  try {
    // Load current page so findAll works
    await figma.currentPage.loadAsync();
    const instances = figma.currentPage.findAllWithCriteria({ types: ["INSTANCE"] as any }) as InstanceNode[];

    // Also check local components/component sets
    const localComponents = figma.currentPage.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] as any });

    // De-duplicate by component set name or component name
    const seen = new Set<string>();

    for (const inst of instances) {
      try {
        const mc = await inst.getMainComponentAsync();
        if (!mc || !mc.key) continue;

        const isRemote = mc.remote;
        const parentSet = mc.parent?.type === "COMPONENT_SET" ? mc.parent as ComponentSetNode : null;
        const name = parentSet?.name ?? mc.name;
        if (seen.has(name)) continue;
        seen.add(name);

        // Determine library name from the description or from publish status
        let libraryName = "";
        try {
          // Remote components come from a library — try to identify it
          if (isRemote && parentSet) {
            libraryName = (parentSet as any).remote ? "Library" : "Local";
          } else if (isRemote) {
            libraryName = "Library";
          } else {
            libraryName = "Local";
          }
        } catch (_) {}

        if (parentSet) {
          // Multi-variant component set
          const setKey = parentSet.key || "";
          componentKeyMap[name] = { setKey, componentKey: mc.key, keyType: "SET", libraryName };
          componentSets.push({ name, libraryName, key: setKey, source: isRemote ? "library" : "local" });
        } else {
          // Single component (no parent set)
          componentKeyMap[name] = { setKey: "", componentKey: mc.key, keyType: "COMPONENT", libraryName };
          componentSets.push({ name, libraryName, key: mc.key, source: isRemote ? "library" : "local" });
        }

        if (libraryName) countByLib[libraryName] = (countByLib[libraryName] ?? 0) + 1;
      } catch (_) {
        // Individual instance resolution can fail — skip silently
      }
    }

    // Also register local component sets not yet seen via instances
    for (const node of localComponents) {
      const name = node.name;
      if (seen.has(name)) continue;
      seen.add(name);

      if (node.type === "COMPONENT_SET") {
        const cs = node as ComponentSetNode;
        const defaultVariant = (cs as any).defaultVariant ?? cs.children[0];
        const key = cs.key || "";
        componentKeyMap[name] = { setKey: key, componentKey: defaultVariant?.key || "", keyType: "SET", libraryName: "Local" };
        componentSets.push({ name, libraryName: "Local", key, source: "local" });
        countByLib["Local"] = (countByLib["Local"] ?? 0) + 1;
      } else if (node.type === "COMPONENT") {
        const comp = node as ComponentNode;
        // Skip if it's a child of a component set (handled above)
        if (comp.parent?.type === "COMPONENT_SET") continue;
        const key = comp.key || "";
        componentKeyMap[name] = { setKey: "", componentKey: key, keyType: "COMPONENT", libraryName: "Local" };
        componentSets.push({ name, libraryName: "Local", key, source: "local" });
        countByLib["Local"] = (countByLib["Local"] ?? 0) + 1;
      }
    }
  } catch (e: any) {
    componentScanError = e?.message ?? String(e);
  }

  // ── 2. Variable collections from attached libraries ───────────────────────
  // teamLibrary permission must be declared in manifest.json:
  //   { "permissions": ["teamlibrary"] }
  const variableCollections: any[] = [];
  let variableApiError: string | null = null;
  try {
    const libCollections = await (figma as any).teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const col of libCollections) {
      let variables: any[] = [];
      try {
        const libVars = await (figma as any).teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
        variables = libVars.map((v: any) => ({ name: v.name, type: v.resolvedType, key: v.key }));
      } catch (_) {}
      variableCollections.push({
        name: col.name,
        libraryName: col.libraryName,
        key: col.key,
        variables,
        source: "library",
      });
    }
  } catch (e: any) {
    variableApiError = e?.message ?? String(e);
  }

  // ── 3. Collect library names from both sources ────────────────────────────
  const libNamesFromComponents = new Set<string>(Object.values(componentKeyMap).map(e => e.libraryName).filter(Boolean));
  const libNamesFromVars = new Set<string>(variableCollections.map((c: any) => c.libraryName).filter(Boolean));
  const sortedLibNames: string[] = [...new Set([...libNamesFromComponents, ...libNamesFromVars])].sort();

  // ── 4. Summary ────────────────────────────────────────────────────────────
  const libBreakdown = sortedLibNames.map(n => `${n} (${countByLib[n] ?? 0} components)`).join(", ");
  const libDisplay = sortedLibNames.length > 0 ? libBreakdown : "none";

  let summary =
    `Detected ${variableCollections.length} variable collection${variableCollections.length !== 1 ? "s" : ""} ` +
    `and ${componentSets.length} component${componentSets.length !== 1 ? "s" : ""} from ` +
    `${sortedLibNames.length === 1 ? "source" : "sources"}: ${libDisplay}. ` +
    `Components discovered by scanning instances on the current page. ` +
    `Use create_instance to place components.`;

  if (componentScanError) {
    summary += ` ⚠ Component scan error: ${componentScanError}`;
  }

  return {
    summary,
    documentName: figma.root.name,
    currentPage: figma.currentPage.name,
    variableCollections,
    componentSets,
    componentKeyMap,
    hasAttachedLibraries: componentSets.some((cs: any) => cs.source === "library") || variableCollections.length > 0,
    attachedLibraryNames: sortedLibNames,
    componentScanError,
    variableApiError,
    timestamp: Date.now(),
  };
}

export const figmaHandlers: Record<string, (params: any) => Promise<any>> = {
  get_full_design_system_context: (params?: any) => getFullDesignSystemContext(params),
};