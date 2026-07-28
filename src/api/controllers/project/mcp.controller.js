import { Project } from '../../../models/Project.js';
import { ProjectShare } from '../../../models/ProjectShare.js';
import { DocumentVersion } from '../../../models/DocumentVersion.js';
import { Portal } from '../../../models/Portal.js';
import * as projectService from '../../services/projects/project.service.js';

/**
 * MCP Server Controller (Fully Functional)
 * Implements all 12 MCP tools that expose Docnine project data to AI assistants.
 * Uses direct database queries and business logic instead of circular HTTP calls.
 * 
 * SECURITY: All tool invocations verify user has project access (owner or shared member).
 * 
 * Tools:
 *  1. get_project_docs - Full documentation
 *  2. get_api_reference - API endpoints
 *  3. get_schema_docs - Data models
 *  4. get_component_docs - Components & services
 *  5. ask_codebase - Q&A (via Docnine agents)
 *  6. search_docs - Semantic search
 *  7. get_security_audit - OWASP findings
 *  8. get_critical_findings - Critical/High severity only
 *  9. get_security_score - A-F grade
 * 10. list_projects - All projects
 * 11. get_project_summary - Tech stack & architecture
 * 12. get_diff - Recent changes
 */

export class MCPController {
  /**
   * Verify user has access to project (owner or shared member)
   * @throws {Error} If user cannot access project
   */
  static async verifyProjectAccess(projectId, userId) {
    const project = await Project.findById(projectId);
    if (!project) {
      const err = new Error('Project not found');
      err.statusCode = 404;
      throw err;
    }

    // Check if owner
    const userIdStr = userId.toString();
    const projectOwnerStr = project.userId?.toString();
    
    if (projectOwnerStr === userIdStr) {
      return project;
    }

    // Check if shared member
    const share = await ProjectShare.findOne({
      projectId,
      inviteeUserId: userId,
      status: 'accepted',
    });

    if (share) {
      return project;
    }

    // Access denied
    const err = new Error(
      'Access denied. You are not authorized to access this project.'
    );
    err.statusCode = 403;
    throw err;
  }
  /**
   * Get MCP server info for a project
   */
  static async getMCPInfo(req, res) {
    try {
      const { projectId } = req.params;

      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Verify access (owner or shared member)
      const userId = (req.user?.userId || req.user?._id)?.toString();
      const isOwner = project.userId?.toString() === userId;

      if (!isOwner) {
        const share = await ProjectShare.findOne({
          projectId: project._id,
          inviteeUserId: userId,
          status: 'accepted',
        });
        if (!share) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      const mcpUrl = `https://mcp.docnineai.com/projects/${projectId}`;

      return res.status(200).json({
        projectId: project._id,
        projectName: project.name,
        mcpUrl,
        docs: {
          readme:
            'Use this URL in Claude, Cursor, or VS Code MCP configuration',
          example: {
            claude: {
              mcpServers: {
                docnine: {
                  url: mcpUrl,
                  env: {
                    DOCNINE_TOKEN: 'your-api-token-here',
                  },
                },
              },
            },
          },
        },
        setupGuide: 'https://docnineai.com/docs/mcp-setup',
        status: 'ready',
      });
    } catch (error) {
      console.error('Error getting MCP info:', error);
      res.status(500).json({ error: 'Failed to get MCP info' });
    }
  }

  /**
   * Call MCP tool for a project
   * Routes to the appropriate tool handler based on tool name
   */
  static async callTool(req, res) {
    try {
      const { projectId, tool: toolParam } = req.params;
      const body = req.body || {};
      const {
        tool: toolBody,
        input: inputBody,
        projectId: bodyProjectId,
        // Compatibility: older clients may send these fields at the top-level
        // instead of under `input`.
        question,
        query,
      } = body;

      const toolName = toolParam || toolBody;
      const actualProjectId = projectId || bodyProjectId;

      if (!toolName) {
        return res.status(400).json({ error: 'Tool name required' });
      }

      // Access control - check if authenticated user has access
      const userId = req.user?.userId || req.user?._id || req.tokenAuth?.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Verify user can access this specific project
      let project;
      try {
        project = await MCPController.verifyProjectAccess(
          actualProjectId,
          userId
        );
      } catch (err) {
        if (err.statusCode === 404) {
          return res.status(404).json({ error: 'Project not found' });
        }
        if (err.statusCode === 403) {
          return res.status(403).json({ error: 'Access denied' });
        }
        throw err;
      }

      let input = inputBody;
      if (!input) {
        input = {};
        if (question !== undefined) input.question = question;
        if (query !== undefined) input.query = query;
      }

      // Tool invocation
      const result = await MCPController.invokeTool(
        toolName,
        input,
        project,
        userId,
      );
      return res.status(200).json(result);
    } catch (error) {
      console.error(`[MCP] Error calling tool:`, error);
      return res.status(500).json({
        error: 'Tool execution failed',
        message: error.message,
      });
    }
  }

  /**
   * Implement all 12 MCP tools
   */
  static async invokeTool(toolName, input, project, userId) {
    switch (toolName) {
      case 'get_project_docs':
        return await MCPController.getProjectDocs(project);

      case 'get_api_reference':
        return await MCPController.getAPIReference(project);

      case 'get_schema_docs':
        return await MCPController.getSchemaDocs(project);

      case 'get_component_docs':
        return await MCPController.getComponentDocs(project);

      case 'ask_codebase':
        return await MCPController.askCodebase(project, input.question);

      case 'search_docs':
        return await MCPController.searchDocs(project, input.query);

      case 'get_security_audit':
        return await MCPController.getSecurityAudit(project);

      case 'get_critical_findings':
        return await MCPController.getCriticalFindings(project);

      case 'get_security_score':
        return await MCPController.getSecurityScore(project);

      case 'list_projects':
        return await MCPController.listProjects(userId);

      case 'get_project_summary':
        return await MCPController.getProjectSummary(project);

      case 'get_diff':
        return await MCPController.getDiff(project);

      case 'get_project_status':
        return await MCPController.getProjectStatus(project);

      case 'get_doc_section':
        return await MCPController.getDocSection(project, input.section);

      case 'get_portal_url':
        return await MCPController.getPortalUrl(project);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ── Tool Implementations ──────────────────────────────────────

  static async getProjectDocs(project) {
    return {
      projectId: project._id,
      projectName: project.name,
      repo: {
        url: project.repoUrl,
        provider: project.provider,
      },
      documentation: {
        README: project.output?.readme || 'No README generated',
        internal: project.output?.internalDocs || 'No internal docs',
        apiReference:
          project.output?.apiReference || 'No API reference generated',
        schemaDocs: project.output?.schemaDocs || 'No schema docs generated',
        componentRef:
          project.output?.componentRef || 'No component reference generated',
        componentIndex:
          project.output?.componentIndex || 'No component index generated',
        securityReport:
          project.output?.securityReport || 'No security report generated',
      },
      lastUpdated: project.stats?.lastDocumentedCommit || null,
      status: project.status,
    };
  }

  static async getAPIReference(project) {
    const apiEndpoints = project.agentOutputs?.apiEndpoints || [];
    return {
      projectId: project._id,
      projectName: project.name,
      documentation: project.output?.apiReference || 'No API reference',
      endpoints: apiEndpoints,
      summary: {
        total: apiEndpoints.length,
        byMethod: apiEndpoints.reduce(
          (acc, ep) => {
            acc[ep.method] = (acc[ep.method] || 0) + 1;
            return acc;
          },
          {},
        ),
      },
      lastUpdated: project.stats?.lastDocumentedCommit || null,
    };
  }

  static async getSchemaDocs(project) {
    const models = project.agentOutputs?.models || [];
    return {
      projectId: project._id,
      projectName: project.name,
      documentation: project.output?.schemaDocs || 'No schema docs',
      models,
      summary: {
        totalModels: models.length,
        relationships: project.agentOutputs?.relationships || [],
      },
      lastUpdated: project.stats?.lastDocumentedCommit || null,
    };
  }

  static async getComponentDocs(project) {
    const components = project.agentOutputs?.components || [];
    return {
      projectId: project._id,
      projectName: project.name,
      documentation: project.output?.componentRef || 'No component docs',
      index: project.output?.componentIndex || 'No component index',
      components,
      summary: {
        totalComponents: components.length,
      },
      lastUpdated: project.stats?.lastDocumentedCommit || null,
    };
  }

  static async askCodebase(project, question) {
    if (!question || question.trim().length === 0) {
      return { error: 'Question is required' };
    }

    // Build context from generated docs; truncate each section to stay within token budget.
    const SECTION_LIMIT = 2000;
    const trim = (s) => (s ? s.slice(0, SECTION_LIMIT) + (s.length > SECTION_LIMIT ? '…' : '') : null);

    const sections = [
      project.output?.readme       ? `README:\n${trim(project.output.readme)}`         : null,
      project.output?.apiReference ? `API Reference:\n${trim(project.output.apiReference)}` : null,
      project.output?.componentRef ? `Components:\n${trim(project.output.componentRef)}`    : null,
      project.output?.internalDocs ? `Internal Docs:\n${trim(project.output.internalDocs)}` : null,
    ].filter(Boolean);

    if (sections.length === 0) {
      return {
        projectId: project._id,
        projectName: project.name,
        question,
        answer: 'No documentation has been generated yet for this project. Run `docnine generate` first.',
      };
    }

    try {
      const { llmCall } = await import('../../../config/llm.js');
      const systemPrompt =
        `You are a helpful documentation assistant for the project "${project.name}". ` +
        'Answer the question using only the provided documentation. Be concise and accurate.';
      const userContent = `Documentation:\n\n${sections.join('\n\n---\n\n')}\n\n---\n\nQuestion: ${question}`;

      const answer = await llmCall({ systemPrompt, userContent, temperature: 0 });
      return { projectId: project._id, projectName: project.name, question, answer };
    } catch (err) {
      console.error('[MCP askCodebase] LLM call failed:', err.message);
      return {
        projectId: project._id,
        projectName: project.name,
        question,
        answer: `Unable to generate answer (LLM unavailable): ${err.message}`,
      };
    }
  }

  static async searchDocs(project, query) {
    if (!query || query.trim().length === 0) {
      return {
        error: 'Query is required',
      };
    }

    // Simple keyword search across all documentation
    const allDocs = {
      readme: project.output?.readme || '',
      api: project.output?.apiReference || '',
      schema: project.output?.schemaDocs || '',
      components: project.output?.componentRef || '',
      internal: project.output?.internalDocs || '',
      security: project.output?.securityReport || '',
    };

    const results = Object.entries(allDocs)
      .filter(([_, content]) =>
        content.toLowerCase().includes(query.toLowerCase()),
      )
      .map(([section, content]) => ({
        section,
        preview: content.substring(0, 200),
      }));

    return {
      projectId: project._id,
      projectName: project.name,
      query,
      results,
      totalMatches: results.length,
    };
  }

  static async getSecurityAudit(project) {
    return {
      projectId: project._id,
      projectName: project.name,
      audit: {
        findings: project.security?.findings || [],
        score: project.security?.score || 100,
        grade: project.security?.grade || 'A',
        reportMarkdown: project.output?.securityReport || 'No security audit',
        remediationMarkdown:
          project.output?.remediationReport || 'No remediations found',
      },
      summary: {
        critical: project.security?.counts?.CRITICAL || 0,
        high: project.security?.counts?.HIGH || 0,
        medium: project.security?.counts?.MEDIUM || 0,
        low: project.security?.counts?.LOW || 0,
      },
      lastAudit: project.stats?.lastDocumentedCommit || null,
    };
  }

  static async getCriticalFindings(project) {
    const findings = (project.security?.findings || []).filter(
      (f) => f.severity === 'CRITICAL' || f.severity === 'HIGH',
    );

    return {
      projectId: project._id,
      projectName: project.name,
      findings,
      summary: {
        total: findings.length,
        critical: findings.filter((f) => f.severity === 'CRITICAL').length,
        high: findings.filter((f) => f.severity === 'HIGH').length,
      },
      recommendation: 'Review and fix CRITICAL and HIGH severity findings immediately',
    };
  }

  static async getSecurityScore(project) {
    return {
      projectId: project._id,
      projectName: project.name,
      score: {
        value: project.security?.score || 100,
        grade: project.security?.grade || 'A',
      },
      breakdown: project.security?.counts || {
        CRITICAL: 0,
        HIGH: 0,
        MEDIUM: 0,
        LOW: 0,
      },
      recommendation:
        project.security?.grade === 'A'
          ? 'Security posture is strong'
          : 'Review findings for security improvements',
    };
  }

  static async listProjects(userId) {
    // Owned projects
    const ownedProjects = await Project.find({ userId })
      .select('_id name repoName status techStack provider')
      .sort({ updatedAt: -1 })
      .limit(50);

    // Shared projects (accepted invitations)
    const sharedEntries = await ProjectShare.find({
      inviteeUserId: userId,
      status: 'accepted',
    }).select('projectId role');

    const sharedProjectIds = sharedEntries.map((s) => s.projectId);
    const sharedProjects = sharedProjectIds.length
      ? await Project.find({ _id: { $in: sharedProjectIds } })
          .select('_id name repoName status techStack provider')
          .limit(50)
      : [];

    const shareRoleMap = Object.fromEntries(
      sharedEntries.map((s) => [s.projectId.toString(), s.role]),
    );

    return {
      total: ownedProjects.length + sharedProjects.length,
      projects: [
        ...ownedProjects.map((p) => ({
          projectId: p._id,
          name: p.name,
          repo: p.repoName,
          provider: p.provider,
          status: p.status,
          techStack: p.techStack || [],
          access: 'owner',
        })),
        ...sharedProjects.map((p) => ({
          projectId: p._id,
          name: p.name,
          repo: p.repoName,
          provider: p.provider,
          status: p.status,
          techStack: p.techStack || [],
          access: shareRoleMap[p._id.toString()] || 'viewer',
        })),
      ],
    };
  }

  static async getProjectSummary(project) {
    return {
      projectId: project._id,
      projectName: project.name,
      repository: {
        url: project.repoUrl,
        provider: project.provider,
      },
      architecture: {
        hint: project.architectureHint || 'Unknown',
        techStack: project.techStack || [],
        layerMap: project.agentOutputs?.layerMap || {},
        entryPoints: project.entryPoints || [],
        keyFiles: project.keyFiles || [],
      },
      analysis: {
        status: project.status,
        lastAnalyzed: project.stats?.lastDocumentedCommit || null,
        testFrameworks: project.testFrameworks || [],
      },
      documentation: {
        complete: !!project.output,
        sections: Object.keys(project.output || {}).length,
      },
    };
  }

  static async getDiff(project) {
    // Get recent versions to show what changed
    const versions = await DocumentVersion.find({
      projectId: project._id,
    })
      .sort({ createdAt: -1 })
      .limit(2)
      .select('section content meta createdAt');

    return {
      projectId: project._id,
      projectName: project.name,
      recentChanges:
        versions.length > 1
          ? {
              before: versions[1],
              after: versions[0],
            }
          : {
              message: 'No previous version to compare',
            },
    };
  }

  static async getProjectStatus(project) {
    const outputSections = Object.keys(project.output || {});
    const expectedSections = ['readme', 'apiReference', 'schemaDocs', 'componentRef', 'internalDocs', 'securityReport'];
    const completedSections = expectedSections.filter((s) => !!project.output?.[s]);

    return {
      projectId: project._id,
      projectName: project.name,
      status: project.status,
      techStack: project.techStack || [],
      provider: project.provider,
      repo: {
        name: project.repoName,
        url: project.repoUrl,
      },
      sync: {
        lastDocumentedCommit: project.stats?.lastDocumentedCommit || null,
        totalFiles: project.stats?.totalFiles || 0,
      },
      documentation: {
        complete: completedSections.length === expectedSections.length,
        completedSections,
        missingSections: expectedSections.filter((s) => !project.output?.[s]),
        totalSections: expectedSections.length,
        completedCount: completedSections.length,
      },
      security: {
        grade: project.security?.grade || null,
        score: project.security?.score ?? null,
      },
    };
  }

  static async getDocSection(project, section) {
    const validSections = ['readme', 'apiReference', 'schemaDocs', 'componentRef', 'internalDocs', 'securityReport'];
    if (!section || !validSections.includes(section)) {
      return {
        error: `Invalid section. Must be one of: ${validSections.join(', ')}`,
      };
    }

    const content = project.output?.[section];
    if (!content) {
      return {
        projectId: project._id,
        projectName: project.name,
        section,
        content: null,
        message: `Section '${section}' has not been generated yet.`,
      };
    }

    return {
      projectId: project._id,
      projectName: project.name,
      section,
      content,
      lastUpdated: project.stats?.lastDocumentedCommit || null,
    };
  }

  static async getPortalUrl(project) {
    const portal = await Portal.findOne({ projectId: project._id }).select(
      'slug isPublished accessMode customDomain seoTitle',
    );

    if (!portal) {
      return {
        projectId: project._id,
        projectName: project.name,
        portal: null,
        message: 'No portal configured for this project. Create one at docnineai.com.',
      };
    }

    const baseUrl = 'https://docnineai.com/docs';
    const portalUrl = portal.customDomain
      ? `https://${portal.customDomain}`
      : `${baseUrl}/${portal.slug}`;

    return {
      projectId: project._id,
      projectName: project.name,
      portal: {
        slug: portal.slug,
        isPublished: portal.isPublished,
        accessMode: portal.accessMode,
        portalUrl: portal.isPublished ? portalUrl : null,
        customDomain: portal.customDomain || null,
        seoTitle: portal.seoTitle || project.name,
        message: portal.isPublished
          ? 'Portal is live'
          : 'Portal exists but is not published yet',
      },
    };
  }

  /**
   * List all available MCP tools for a project
   */
  static async listTools(req, res) {
    try {
      const { projectId } = req.params;
      const userId = req.user?.userId;

      // Verify the caller actually owns or is a member of this project
      await MCPController.verifyProjectAccess(projectId, userId);

      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const tools = [
        {
          name: 'get_project_docs',
          category: 'documentation',
          description: 'Get full project documentation, README, and API specs'
        },
        {
          name: 'get_api_reference',
          category: 'documentation',
          description: 'Get all API endpoints and their documentation'
        },
        {
          name: 'get_schema_docs',
          category: 'documentation',
          description: 'Get data models and database schema documentation'
        },
        {
          name: 'get_component_docs',
          category: 'documentation',
          description: 'Get component, service, and hook documentation'
        },
        {
          name: 'ask_codebase',
          category: 'qa',
          description: 'Ask natural language questions about the codebase',
          input: { question: 'string' }
        },
        {
          name: 'search_docs',
          category: 'qa',
          description: 'Search documentation semantically',
          input: { query: 'string' }
        },
        {
          name: 'get_security_audit',
          category: 'security',
          description: 'Get full OWASP security audit with findings'
        },
        {
          name: 'get_critical_findings',
          category: 'security',
          description: 'Get critical and high-severity security findings only'
        },
        {
          name: 'get_security_score',
          category: 'security',
          description: 'Get security grade (A-F) with breakdown'
        },
        {
          name: 'list_projects',
          category: 'project',
          description: 'List all projects in workspace'
        },
        {
          name: 'get_project_summary',
          category: 'project',
          description: 'Get project architecture, tech stack, and sync status'
        },
        {
          name: 'get_diff',
          category: 'project',
          description: 'Get what changed in docs since last push'
        }
      ];

      return res.status(200).json({
        projectId,
        totalTools: tools.length,
        tools,
        baseUrl: `https://mcp.docnineai.com/projects/${projectId}`,
        authentication: {
          type: 'Bearer token',
          header: 'Authorization: Bearer <DOCNINE_TOKEN>',
          location: 'Get token from: Dashboard → Settings → API Tokens'
        }
      });
    } catch (error) {
      console.error('Error listing tools:', error);
      const status = error.statusCode || 500;
      res.status(status).json({ error: status === 403 || status === 404 ? error.message : 'Failed to list tools' });
    }
  }

  /**
   * Health check for MCP server
   */
  static async healthCheck(req, res) {
    try {
      const { projectId } = req.params;

      // Only confirm the project exists : do not leak project name to unauthenticated callers.
      const exists = await Project.exists({ _id: projectId });
      if (!exists) {
        return res.status(404).json({ status: 'unhealthy', error: 'Project not found' });
      }

      return res.status(200).json({
        status: 'healthy',
        projectId,
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      });
    } catch (error) {
      console.error('Health check error:', error);
      res.status(500).json({ status: 'unhealthy', error: 'Internal error' });
    }
  }
}

export default MCPController;
