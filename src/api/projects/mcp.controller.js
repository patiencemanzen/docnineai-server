import { Project } from '../../models/Project.js';
import { DocnineAPIClient } from '../../lib/api-client.js';

/**
 * MCP Server Controller
 * Handles Model Context Protocol requests for projects
 * Routes requests to appropriate project and validates access
 */

export class MCPController {
  /**
   * Get MCP server info for a project
   * Returns project ID, base URL, and authentication details
   */
  static async getMCPInfo(req, res) {
    try {
      const { projectId } = req.params;
      
      // Get project and verify user access
      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Verify user has access to this project
      if (!project.members.includes(req.user._id) && project.owner.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: 'Access denied to this project' });
      }

      const mcp_url = `https://mcp.docnineai.com/projects/${projectId}`;
      
      return res.status(200).json({
        projectId: project._id,
        projectName: project.name,
        mcpUrl: mcp_url,
        docs: {
          readme: 'Use this URL in Claude, Cursor, or VS Code MCP configuration',
          example: {
            claude: {
              mcpServers: {
                docnine: {
                  url: mcp_url,
                  env: {
                    DOCNINE_TOKEN: 'your-api-token-here'
                  }
                }
              }
            }
          }
        },
        setupGuide: 'https://docnineai.com/docs/mcp-setup',
        status: 'ready'
      });
    } catch (error) {
      console.error('Error getting MCP info:', error);
      res.status(500).json({ error: 'Failed to get MCP info' });
    }
  }

  /**
   * Call MCP tool for a project
   * Generic endpoint that routes to appropriate tool handler
   * Supports both /call (with body) and /:tool (with URL param)
   */
  static async callTool(req, res) {
    try {
      const { projectId, tool: toolParam } = req.params;
      const { tool: toolBody, input } = req.body;

      // Tool name can come from URL param or body
      const toolName = toolParam || toolBody;

      if (!toolName) {
        return res.status(400).json({ error: 'Tool name required' });
      }

      // Get project and verify user access
      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Verify user has access (check via token auth middleware)
      // Token must be valid and user must have project access
      const tokenUser = req.tokenAuth?.user || req.user;
      if (!tokenUser) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Initialize API client for this project
      const apiClient = new DocnineAPIClient(
        process.env.DOCNINE_TOKEN || req.tokenAuth?.token,
        projectId,
        process.env.DOCNINE_API_URL
      );

      // Route to appropriate tool handler
      const result = await MCPController.handleTool(toolName, input, apiClient, projectId);
      return res.status(200).json(result);

    } catch (error) {
      console.error('Error calling tool:', error);
      res.status(500).json({ error: 'Failed to execute tool', message: error.message });
    }
  }

  /**
   * Handle specific tool invocation
   */
  static async handleTool(toolName, input = {}, apiClient, projectId) {
    const toolHandlers = {
      get_project_docs: async () => await apiClient.getProjectDocs(),
      get_api_reference: async () => await apiClient.getAPIReference(),
      get_schema_docs: async () => await apiClient.getSchemaDocs(),
      get_component_docs: async () => await apiClient.getComponentDocs(),
      ask_codebase: async () => await apiClient.askCodebase(input.question),
      search_docs: async () => await apiClient.searchDocs(input.query),
      get_security_audit: async () => await apiClient.getSecurityAudit(),
      get_critical_findings: async () => await apiClient.getCriticalFindings(),
      get_security_score: async () => await apiClient.getSecurityScore(),
      list_projects: async () => await apiClient.listProjects(),
      get_project_summary: async () => await apiClient.getProjectSummary(),
      get_diff: async () => await apiClient.getDiff()
    };

    if (!toolHandlers[toolName]) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    return await toolHandlers[toolName]();
  }

  /**
   * List all available MCP tools for a project
   */
  static async listTools(req, res) {
    try {
      const { projectId } = req.params;

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
      res.status(500).json({ error: 'Failed to list tools' });
    }
  }

  /**
   * Health check for MCP server
   */
  static async healthCheck(req, res) {
    try {
      const { projectId } = req.params;

      // Quick validation that project exists (no user auth required for health check)
      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({
          status: 'unhealthy',
          error: 'Project not found'
        });
      }

      return res.status(200).json({
        status: 'healthy',
        projectId,
        projectName: project.name,
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    } catch (error) {
      console.error('Health check error:', error);
      res.status(500).json({
        status: 'unhealthy',
        error: error.message
      });
    }
  }
}

export default MCPController;
