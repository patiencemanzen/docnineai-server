// ===================================================================
// Pipeline Validation & Error Recovery Utility
// ===================================================================
// Provides enhanced validation and error handling for agents that work with
// multiple programming languages and frameworks (PHP, Java, Python, C++, C, Go, Kotlin, Swift)

/**
 * Validates agent output structure and provides detailed error messages
 */
export function validateAgentOutput(output, agentType, schema = null) {
  if (!output) {
    return {
      valid: false,
      error: `Agent returned null/undefined`,
      recovery: `Retry the agent or check model response`,
    };
  }

  if (typeof output !== "object") {
    return {
      valid: false,
      error: `Expected object output, got ${typeof output}`,
      recovery: `Check response parsing`,
    };
  }

  // Type-specific validation
  switch (agentType) {
    case "repo-scanner":
      return validateRepoScannerOutput(output);
    case "api-extractor":
      return validateApiExtractorOutput(output);
    case "schema-analyser":
      return validateSchemaAnalyserOutput(output);
    case "component-mapper":
      return validateComponentMapperOutput(output);
    case "doc-writer":
      return validateDocWriterOutput(output);
    case "security-auditor":
      return validateSecurityAuditorOutput(output);
    default:
      return {
        valid: Array.isArray(output) || typeof output === "object",
        error: null,
      };
  }
}

function validateRepoScannerOutput(output) {
  if (!Array.isArray(output)) {
    return {
      valid: false,
      error: "Repo scanner output must be an array",
      recovery: "Ensure output is wrapped in []",
    };
  }

  const validRoles = new Set([
    "entry",
    "controller",
    "route",
    "service",
    "model",
    "schema",
    "middleware",
    "utility",
    "helper",
    "config",
    "migration",
    "seed",
    "test",
    "hook",
    "component",
    "store",
    "context",
    "guard",
    "interceptor",
    "decorator",
    "job",
    "event",
    "frontend",
    "other",
  ]);

  const issues = [];
  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    if (!item.path) issues.push(`Item ${i}: missing path`);
    if (!validRoles.has(item.role)) {
      issues.push(`Item ${i}: invalid role "${item.role}"`);
    }
  }

  if (issues.length > 0) {
    return {
      valid: false,
      error: `Validation errors: ${issues.join("; ")}`,
      recovery: "Check repo-scanner output schema",
    };
  }

  return { valid: true, error: null };
}

function validateApiExtractorOutput(output) {
  if (!Array.isArray(output)) {
    return {
      valid: false,
      error: "API extractor output must be an array",
      recovery: "Ensure output is wrapped in []",
    };
  }

  const validMethods = new Set([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ]);

  const issues = [];
  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    if (!validMethods.has(item.method)) {
      issues.push(`Item ${i}: invalid HTTP method "${item.method}"`);
    }
    if (!item.path || !item.path.startsWith("/")) {
      issues.push(`Item ${i}: invalid path "${item.path}"`);
    }
  }

  if (issues.length > 0) {
    return {
      valid: false,
      error: `Validation errors: ${issues.join("; ")}`,
      recovery: "Check api-extractor output schema",
    };
  }

  return { valid: true, error: null };
}

function validateSchemaAnalyserOutput(output) {
  if (typeof output !== "object" || !output.models) {
    return {
      valid: false,
      error:
        "Schema analyser output must have 'models' and 'relationships' keys",
      recovery: "Check schema-analyser output format",
    };
  }

  if (!Array.isArray(output.models) || !Array.isArray(output.relationships)) {
    return {
      valid: false,
      error: "Models and relationships must be arrays",
      recovery: "Compare against schema-analyser output schema",
    };
  }

  return { valid: true, error: null };
}

function validateComponentMapperOutput(output) {
  if (!Array.isArray(output)) {
    return {
      valid: false,
      error: "Component mapper output must be an array",
      recovery: "Ensure output is wrapped in []",
    };
  }

  const issues = [];
  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    if (!item.name) issues.push(`Item ${i}: missing name`);
    if (!item.file) issues.push(`Item ${i}: missing file`);
  }

  if (issues.length > 0) {
    return {
      valid: false,
      error: `Validation errors: ${issues.join("; ")}`,
      recovery: "Check component-mapper output schema",
    };
  }

  return { valid: true, error: null };
}

function validateDocWriterOutput(output) {
  if (typeof output !== "object") {
    return {
      valid: false,
      error: "Doc writer output must be an object with content",
      recovery: "Check doc-writer output format",
    };
  }

  if (!output.readme && !output.internalGuide && !output.componentRef) {
    return {
      valid: false,
      error: "Doc writer must produce readme, internalGuide, or componentRef",
      recovery: "Check doc-writer context and prompts",
    };
  }

  return { valid: true, error: null };
}

function validateSecurityAuditorOutput(output) {
  if (!Array.isArray(output)) {
    return {
      valid: false,
      error: "Security auditor output must be an array",
      recovery: "Ensure output is wrapped in []",
    };
  }

  return { valid: true, error: null };
}

/**
 * Safely parse JSON with comprehensive error recovery
 */
export function safeParseJSON(raw, context = "") {
  if (!raw) return null;

  // First attempt: direct parse
  try {
    return JSON.parse(raw);
  } catch {
    // No action
  }

  // Second attempt: strip markdown fences
  try {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    return JSON.parse(stripped);
  } catch {
    // No action
  }

  // Third attempt: find first valid JSON object/array
  try {
    const start = raw.search(/[\[\{]/);
    const end = Math.max(raw.lastIndexOf("]"), raw.lastIndexOf("}"));
    if (start !== -1 && end > start) {
      const chunk = raw.substring(start, end + 1);
      return JSON.parse(chunk);
    }
  } catch {
    // No action
  }

  return null;
}

/**
 * Enhanced error handler for agent pipeline
 */
export function handlePipelineError(error, agentType, context = {}) {
  const errorObj = {
    timestamp: new Date().toISOString(),
    agentType,
    originalError: error?.message || String(error),
    context,
    recovery: null,
  };

  if (error?.message?.includes("JSON")) {
    errorObj.recovery = "Check LLM output format : may have markdown fences";
  } else if (error?.message?.includes("validation")) {
    errorObj.recovery = "Review schema validation : check output structure";
  } else if (error?.message?.includes("timeout")) {
    errorObj.recovery = "Increase timeout or reduce file batch size";
  } else if (error?.message?.includes("rate limit")) {
    errorObj.recovery = "Implement exponential backoff : waiting before retry";
  } else if (error?.message?.includes("ENOENT")) {
    errorObj.recovery = "Check file paths : may be missing or inaccessible";
  } else {
    errorObj.recovery =
      "Check LLM context and prompt for the agent : may need refinement";
  }

  return errorObj;
}

/**
 * Filter and sanitize agent output for downstream processing
 */
export function sanitizeAgentOutput(output, agentType) {
  if (!output)
    return agentType === "schema-analyser"
      ? { models: [], relationships: [] }
      : [];

  const sanitized = Array.isArray(output)
    ? output.filter(Boolean)
    : output || {};

  // Remove internal fields
  if (Array.isArray(sanitized)) {
    return sanitized.map((item) => {
      const clean = { ...item };
      delete clean._heuristic;
      delete clean._internal;
      return clean;
    });
  }

  return sanitized;
}

/**
 * Check if output requires retry
 */
export function shouldRetry(output, agentType, maxRetries = 2) {
  if (!output) return true;

  const validation = validateAgentOutput(output, agentType);
  if (!validation.valid) return true;

  // Empty results don't necessarily need retry
  if (Array.isArray(output) && output.length === 0) return false;

  return false;
}

/**
 * Language-aware context builder for agents
 */
export function buildLanguageContext(detectedLanguage, detectedFramework) {
  const contexts = {
    "JavaScript/TypeScript": {
      fileExts: [".js", ".ts", ".jsx", ".tsx"],
      popularFrameworks: [
        "Express",
        "Fastify",
        "NestJS",
        "Next.js",
        "React",
        "Vue",
      ],
      packageManager: "npm/yarn",
      testFrameworks: ["Jest", "Vitest", "Mocha"],
    },
    Python: {
      fileExts: [".py", ".pyw"],
      popularFrameworks: ["Django", "FastAPI", "Flask", "Tornado", "aiohttp"],
      packageManager: "pip",
      testFrameworks: ["pytest", "unittest"],
    },
    Java: {
      fileExts: [".java"],
      popularFrameworks: ["Spring Boot", "Quarkus", "Micronaut", "Play"],
      packageManager: "Maven/Gradle",
      testFrameworks: ["JUnit", "TestNG"],
    },
    "Java/Kotlin": {
      fileExts: [".kt", ".kts", ".java"],
      popularFrameworks: ["Spring Boot", "Ktor", "Quarkus"],
      packageManager: "Maven/Gradle",
      testFrameworks: ["JUnit", "Kotest"],
    },
    Go: {
      fileExts: [".go"],
      popularFrameworks: ["Gin", "Echo", "Chi", "Buffalo"],
      packageManager: "go modules",
      testFrameworks: ["testing"],
    },
    PHP: {
      fileExts: [".php", ".phtml"],
      popularFrameworks: ["Laravel", "Symfony", "WordPress", "Slim"],
      packageManager: "Composer",
      testFrameworks: ["PHPUnit", "Codeception"],
    },
    "C/C++": {
      fileExts: [".c", ".cpp", ".h", ".hpp"],
      popularFrameworks: ["Boost", "Qt", "OpenGL", "SDL"],
      packageManager: "CMake/Conan",
      testFrameworks: ["Google Test", "CppUnit"],
    },
    Swift: {
      fileExts: [".swift"],
      popularFrameworks: ["Vapor", "Kitura", "Perfect"],
      packageManager: "SPM",
      testFrameworks: ["XCTest"],
    },
    Ruby: {
      fileExts: [".rb"],
      popularFrameworks: ["Rails", "Sinatra", "Hanami"],
      packageManager: "Bundler",
      testFrameworks: ["RSpec", "Minitest"],
    },
    Rust: {
      fileExts: [".rs"],
      popularFrameworks: ["Actix", "Axum", "Rocket", "Warp"],
      packageManager: "Cargo",
      testFrameworks: ["Criterion"],
    },
  };

  return (
    contexts[detectedLanguage] || {
      fileExts: [],
      popularFrameworks: [],
      packageManager: "unknown",
      testFrameworks: [],
    }
  );
}
