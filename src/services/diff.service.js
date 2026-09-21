const ROLE_TO_AGENTS = {
  route: ["apiExtractor", "securityAuditor"],
  controller: ["apiExtractor", "securityAuditor"],
  entry: ["apiExtractor", "securityAuditor"],
  model: ["schemaAnalyser", "securityAuditor"],
  schema: ["schemaAnalyser", "securityAuditor"],
  migration: ["schemaAnalyser"],
  service: ["componentMapper", "securityAuditor"],
  middleware: ["componentMapper", "securityAuditor"],
  utility: ["componentMapper", "securityAuditor"],
  config: ["componentMapper", "securityAuditor"],
  helper: ["componentMapper", "securityAuditor"],
  hook: ["componentMapper", "securityAuditor"],
  frontend: ["componentMapper", "securityAuditor"],
  other: ["securityAuditor"],
};

const MANIFEST_FILES =
  /package\.json$|requirements\.txt$|Cargo\.toml$|go\.mod$|pom\.xml$|composer\.json$|Gemfile$|pyproject\.toml$/i;

const CODE_EXT =
  /\.(js|ts|jsx|tsx|py|go|rs|java|rb|php|cs|cpp|c|h|vue|svelte|prisma|graphql|sql)$/i;

const AGENT_TO_SECTIONS = {
  repoScanner: [],
  apiExtractor: ["apiReference"],
  schemaAnalyser: ["schemaDocs"],
  componentMapper: ["internalDocs"],
  securityAuditor: ["securityReport"],
};

const README_TRIGGERS = new Set(["apiExtractor", "schemaAnalyser", "componentMapper"]);

export function analyseChanges(changedFiles, fileManifest) {
  const manifestMap = new Map(fileManifest.map((f) => [f.path, f]));
  const result = {
    needsFullRun: false,
    fullRunReason: null,
    agentsNeeded: new Set(),
    sectionsAffected: new Set(),
    changedByAgent: {
      repoScanner: [],
      apiExtractor: [],
      schemaAnalyser: [],
      componentMapper: [],
      securityAuditor: [],
    },
    removedFiles: [],
    addedFiles: [],
  };

  for (const file of changedFiles) {
    const { path, status } = file;

    if (MANIFEST_FILES.test(path)) {
      result.needsFullRun = true;
      result.fullRunReason = `Structural manifest file changed: ${path}`;
      return result;
    }

    if (status === "removed") {
      result.removedFiles.push(path);
    }

    if (status === "added") {
      result.addedFiles.push(path);
    }

    const stored = manifestMap.get(path);
    const role = stored?.role || inferRoleFromPath(path);

    const agents = ROLE_TO_AGENTS[role] || (CODE_EXT.test(path) ? ["securityAuditor"] : []);

    if (status !== "removed") {
      result.agentsNeeded.add("repoScanner");
      result.changedByAgent.repoScanner.push(file);
    }

    for (const agent of agents) {
      result.agentsNeeded.add(agent);
      result.changedByAgent[agent].push(file);

      const sections = AGENT_TO_SECTIONS[agent] || [];
      for (const section of sections) {
        result.sectionsAffected.add(section);
      }
    }
  }

  for (const agent of result.agentsNeeded) {
    if (README_TRIGGERS.has(agent)) {
      result.sectionsAffected.add("readme");
      break;
    }
  }

  return result;
}

function inferRoleFromPath(path) {
  if (/route|router/i.test(path)) return "route";
  if (/controller|handler/i.test(path)) return "controller";
  if (/model|schema|entity/i.test(path)) return "model";
  if (/migration/i.test(path)) return "migration";
  if (/service/i.test(path)) return "service";
  if (/middleware/i.test(path)) return "middleware";
  if (/util|helper/i.test(path)) return "utility";
  if (/config|\.env/i.test(path)) return "config";
  if (/^src\/index|^src\/server|^src\/app|^index|^server|^main/i.test(path)) return "entry";
  if (/\.(test|spec)\.(js|ts)$/i.test(path)) return "test";
  return "other";
}

export function mergeAgentOutputs(stored, fresh, changedFilePaths, removedFilePaths) {
  const allDirtyPaths = new Set([...changedFilePaths, ...removedFilePaths]);

  return {
    endpoints: [
      ...stored.endpoints.filter((e) => !allDirtyPaths.has(e.file)),
      ...(fresh.endpoints || []),
    ],

    models: [...stored.models.filter((m) => !allDirtyPaths.has(m.file)), ...(fresh.models || [])],

    relationships:
      fresh.relationships !== undefined
        ? [
            ...stored.relationships.filter((r) => {
              return false;
            }),
            ...(fresh.relationships || []),
          ]
        : stored.relationships,

    components: [
      ...stored.components.filter((c) => !allDirtyPaths.has(c.file)),
      ...(fresh.components || []),
    ],

    findings: [
      ...stored.findings.filter((f) => !allDirtyPaths.has(f.file)),
      ...(fresh.findings || []),
    ],

    projectMap: [
      ...stored.projectMap.filter((p) => !allDirtyPaths.has(p.path)),
      ...(fresh.projectMap || []),
    ],
  };
}

export function updateFileManifest(storedManifest, currentTree, newProjectMap) {
  const roleMap = new Map(newProjectMap.map((p) => [p.path, p.role]));
  const shaMap = new Map(currentTree.map((f) => [f.path, f.sha]));
  const pathSet = new Set(currentTree.map((f) => f.path));

  const surviving = storedManifest.filter((f) => pathSet.has(f.path));

  const updated = new Map(surviving.map((f) => [f.path, f]));

  for (const f of currentTree) {
    const existingRole = updated.get(f.path)?.role;
    updated.set(f.path, {
      path: f.path,
      sha: shaMap.get(f.path) || "",
      role: roleMap.get(f.path) || existingRole || inferRoleFromPath(f.path),
    });
  }

  return [...updated.values()];
}
