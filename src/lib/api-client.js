/**
 * Docnine API Client
 * Internal client for calling Docnine backend services
 * Used by MCP server routes and other integrations
 */

export class DocnineAPIClient {
  constructor(token, projectId, apiUrl = 'http://localhost:3000') {
    this.token = token;
    this.projectId = projectId;
    this.apiUrl = apiUrl;
  }

  /**
   * Helper function to make authenticated requests
   */
  async makeRequest(endpoint, options = {}) {
    const url = `${this.apiUrl}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  // ── Documentation Tools ──
  async getProjectDocs() {
    return this.makeRequest(`/api/projects/${this.projectId}/docs`);
  }

  async getAPIReference() {
    return this.makeRequest(`/api/projects/${this.projectId}/docs/API`);
  }

  async getSchemaDocs() {
    return this.makeRequest(`/api/projects/${this.projectId}/docs/SCHEMA`);
  }

  async getComponentDocs() {
    return this.makeRequest(`/api/projects/${this.projectId}/docs/COMPONENTS`);
  }

  // ── Q&A Tools ──
  async askCodebase(question) {
    return this.makeRequest(`/api/projects/${this.projectId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: question }),
    });
  }

  async searchDocs(query) {
    return this.makeRequest(`/api/projects/${this.projectId}/search`, {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  }

  // ── Security Tools ──
  async getSecurityAudit() {
    return this.makeRequest(`/api/projects/${this.projectId}/security`);
  }

  async getCriticalFindings() {
    return this.makeRequest(`/api/projects/${this.projectId}/security/critical`);
  }

  async getSecurityScore() {
    return this.makeRequest(`/api/projects/${this.projectId}/security/score`);
  }

  // ── Project Tools ──
  async listProjects() {
    return this.makeRequest(`/api/projects`);
  }

  async getProjectSummary() {
    return this.makeRequest(`/api/projects/${this.projectId}`);
  }

  async getDiff() {
    return this.makeRequest(`/api/projects/${this.projectId}/diff`);
  }
}

export default DocnineAPIClient;
