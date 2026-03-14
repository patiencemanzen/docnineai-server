# MCP Server with Token Authentication

> **Model Context Protocol (MCP)** integration for Claude, Cursor, VS Code, and other compatible MCP clients with Docnine's API Token authentication

## Overview

Docnine provides a **centralized MCP server** that allows Claude, Cursor, VS Code, and other MCP-compatible tools to analyze your codebase and documentation directly from the Docnine platform.

**Key Features:**
- ✅ **Per-project isolation** — Each MCP token is scoped to specific projects
- ✅ **Token-based authentication** — Secure API tokens from dashboard
- ✅ **12+ AI-powered tools** — Ask codebase, security audits, API reference, etc.
- ✅ **Zero setup overhead** — One line in your config file
- ✅ **Browser-friendly sharing** — Share project URL with team

---

## Quick Start (5 minutes)

### Step 1: Create an API Token

1. Log into **Docnine Dashboard**
2. Go to **Project Settings** → **API Tokens**
3. Click **+ New Token**
4. Fill the form:
   - **Token Name:** `Claude MCP` (or any name)
   - **Scopes:** Check `api` and `mcp`
   - **Expiration:** (optional) e.g., 2026-12-31
5. Click **Create Token**
6. **Copy the token** — You won't see it again!

### Step 2: Configure Your MCP Client

Choose your environment below:

#### Claude Desktop
 
**File:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)  
**File:** `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "docnine": {
      "command": "curl",
      "args": [],
      "env": {
        "MCP_URL": "https://mcp.docnineai.com/projects/YOUR_PROJECT_ID/mcp",
        "MCP_TOKEN": "docnine_abc123xyz...",
        "MCP_COMMAND": "tools"
      }
    }
  }
}
```

#### Cursor Editor

**File:** `.cursor/mcp_config.json` (in workspace root)

```json
{
  "mcpServers": {
    "docnine": {
      "serverUrl": "https://mcp.docnineai.com/projects/YOUR_PROJECT_ID/mcp",
      "provider": "http",
      "auth": {
        "type": "bearer",
        "token": "docnine_abc123xyz..."
      }
    }
  }
}
```

#### VS Code with Cline Extension

**File:** `.vscode/settings.json` (in workspace root)

```json
{
  "cline.mcpServers": {
    "docnine": {
      "url": "https://mcp.docnineai.com/projects/YOUR_PROJECT_ID/mcp",
      "Authorization": "Bearer docnine_abc123xyz..."
    }
  }
}
```

### Step 3: Test the Connection

In Claude, Cursor, or Cline prompt:

```
@docnine What security vulnerabilities did you find in my codebase?
```

Expected response: Docnine retrieves security audit data and displays results.

---

## Environment Variables

After creating a token, you have:

```
Token Name:        Claude MCP
Plain Token:       docnine_abc123xyz... (64+ hex chars)
Last 6 chars:      ...xyz789
Project ID:        66f7c3a1b2d4e5f6g7h8i9j0
MCP URL:           https://mcp.docnineai.com/projects/66f7c3a1b2d4e5f6g7h8i9j0/mcp
```

**Use in your MCP config:**

| Variable | Value | Example |
|----------|-------|---------|
| `MCP_URL` or `serverUrl` | Base MCP endpoint | `https://mcp.docnineai.com/projects/66f7c3a1b2d4e5f6g7h8i9j0/mcp` |
| `MCP_TOKEN` or `Authorization: Bearer` | Full token from dashboard | `docnine_abc123xyz...` |
| `Scope` | API token scope | `["api", "mcp", "cli"]` |

---

## Available MCP Tools

Once configured, these tools are available:

### Documentation Tools
| Tool | Input | Output |
|------|-------|--------|
| **get_project_docs** | — | Full README, guides, all docs |
| **get_api_reference** | — | All API endpoints, params, responses |
| **get_schema_docs** | — | Data models, DB schema, types |
| **get_component_docs** | — | Components, services, hooks |

### Knowledge Base
| Tool | Input | Output |
|------|-------|--------|
| **ask_codebase** | `question: string` | Semantic search + LLM answer |
| **search_docs** | `query: string` | Relevant docs with snippets |

### Security Tools
| Tool | Input | Output |
|------|-------|--------|
| **get_security_audit** | — | Full OWASP report + findings |
| **get_critical_findings** | — | Critical/High severity only |
| **get_security_score** | — | Grade (A-F) with breakdown |

### Project Tools
| Tool | Input | Output |
|------|-------|--------|
| **list_projects** | — | All projects in workspace |
| **get_project_summary** | — | Key stats, file counts, languages |
| **get_diff** | — | Latest changes/diff from last scan |

---

## API Endpoints

### HTTP Requests (Raw)

```bash
# List available tools
curl -H "Authorization: Bearer TOKEN" \
  https://mcp.docnineai.com/projects/PROJECT_ID/mcp/tools

# Call a tool
curl -X POST \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool": "ask_codebase", "input": {"question": "What does main.ts do?"}}' \
  https://mcp.docnineai.com/projects/PROJECT_ID/mcp/call

# Or use direct tool endpoint
curl -X POST \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question": "Authentication flow?"}' \
  https://mcp.docnineai.com/projects/PROJECT_ID/mcp/ask_codebase
```

### Response Format

```json
{
  "success": true,
  "tool": "ask_codebase",
  "result": "...",
  "executedAt": "2025-03-14T10:30:00Z",
  "projectId": "66f7c3a1b2d4e5f6g7h8i9j0"
}
```

---

## Token Management

### Token Details

Tokens created from the dashboard have:

| Property | Value | Example |
|----------|-------|---------|
| **Format** | Prefix + 48 random hex | `docnine_abc123xyz...` |
| **Storage** | SHA-256 hash only (never plaintext) | `7e3a9f2c581...` |
| **Scope** | Array of allowed APIs | `["api", "mcp", "cli"]` |
| **Expiration** | Optional date | `2026-12-31T23:59:59Z` |
| **Project Scope** | Inherited from user's projects | Auto-restricted to owner's projects |

### Token Lifecycle

1. **Creation** — Plain token shown once in modal
2. **Storage** — Hash stored in DB, never raw token
3. **Usage** — Include as `Authorization: Bearer TOKEN`
4. **Expiration** — Auto-rejected if past expiry date
5. **Revocation** — Manual revoke disables immediately
6. **Deletion** — Permanently remove from dashboard

### Best Practices

✅ **Do:**
- Keep tokens secret (like passwords)
- Rotate tokens every 6 months
- Use descriptive names (`Claude MCP`, `CI Pipeline`)
- Set expiration dates for temporary tokens
- Store in environment variables, not code

❌ **Don't:**
- Share tokens in public repos
- Log tokens in server output
- Hardcode in configuration files
- Use same token across multiple tools
- Leave tokens without expiration

---

## Authentication Flow

### Bearer Token Authentication

Every request to MCP endpoints must include:

```
Authorization: Bearer docnine_abc123xyz...
```

### Validation Steps

1. **Header check** — Request has `Authorization: Bearer` prefix
2. **Token format** — Token length and prefix (`docnine_`) validation
3. **Hash lookup** — SHA-256 hash matched against DB
4. **Revocation check** — Token not marked as revoked
5. **Expiration check** — Token not past expiry date
6. **IP whitelist** — (Optional) Client IP in whitelist
7. **Scope check** — Token has `mcp` scope for endpoint
8. **Project access** — Token user has project access

### Error Codes

| Code | Status | Cause | Solution |
|------|--------|-------|----------|
| `NO_TOKEN` | 401 | Missing auth header | Add `Authorization: Bearer TOKEN` |
| `INVALID_TOKEN` | 401 | Wrong format/length | Check token format |
| `TOKEN_NOT_FOUND` | 401 | Token doesn't exist | Verify token from dashboard |
| `TOKEN_EXPIRED` | 401 | Token past expiry | Create new token |
| `TOKEN_REVOKED` | 401 | Token manually revoked | Create new token |
| `IP_BLOCKED` | 403 | IP not whitelisted | Contact support |
| `INSUFFICIENT_SCOPE` | 403 | Token missing `mcp` scope | Add `mcp` scope in dashboard |

---

## Troubleshooting

### "Token not found or has been revoked"

1. Copy token from dashboard again (don't rely on memory)
2. Verify it starts with `docnine_`
3. Check it's not been manually revoked
4. Check expiration date hasn't passed
5. Check scope includes `mcp`

### "Missing or invalid Authorization header"

```bash
# ❌ Wrong
curl https://...

# ✅ Correct
curl -H "Authorization: Bearer docnine_xyz..." https://...

# ❌ Wrong format
-H "Authorization: docnine_xyz"
-H "Token: docnine_xyz"

# ✅ Correct format
-H "Authorization: Bearer docnine_xyz"
```

### "Project not found"

1. Copy Project ID from settings URL: `/projects/PROJECT_ID/settings`
2. Verify you have access to this project
3. Check token user is the project owner or member

### Connection timeout from Claude/Cursor

1. Verify URL is exactly: `https://mcp.docnineai.com/projects/PROJECT_ID/mcp`
2. Test endpoint with curl first
3. Check network (firewall, proxy) allows HTTPS
4. Verify project exists and is not deleted

---

## Examples

### Example 1: Ask About Security

**Prompt:**
```
@docnine What are the top 3 security risks in my codebase?
```

**Claude retrieves:**
1. `get_security_audit` — Full audit report
2. Parses findings by severity
3. Summarizes top 3 risks

**Output:**
```
Based on Docnine's security audit, here are the top 3 risks:

1. **SQL Injection in user.routes.js:45** [High]
   - User input not sanitized in query
   - Fix: Use parameterized queries

2. **Exposed API Key in config.js** [Critical]
   - AWS_KEY hardcoded in source
   - Fix: Move to environment variables

3. **Weak Password Hashing** [Medium]
   - Using MD5 instead of bcrypt
   - Fix: Migrate to bcrypt
```

### Example 2: Understand API Endpoints

**Prompt:**
```
@docnine Show me all authentication endpoints with their request/response format
```

**Claude retrieves:**
1. `get_api_reference` — All endpoints
2. Filters for `/auth/*` routes
3. Formats with curl examples

**Output:**
```markdown
## Authentication Endpoints

### POST /auth/login
**Request:**
```json
{ "email": "user@example.com", "password": "..." }
```

**Response:**
```json
{ "token": "jwt...", "user": {...} }
```

### POST /auth/signup
...
```

### Example 3: Search Documentation

**Prompt:**
```
@docnine How do I implement custom authentication?
```

**Claude retrieves:**
1. `search_docs` — "custom authentication"
2. Returns relevant doc snippets
3. Asks codebase if not found

**Output:**
```
Found in ARCHITECTURE.md:

"Custom auth flows are implemented via passport.js middleware. 
See examples in src/middleware/auth.middleware.js..."
```

---

## Integration with CI/CD

### GitHub Actions Example

```yaml
name: Code Analysis with Docnine

on: [pull_request]

jobs:
  security-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Check security issues
        run: |
          curl -X POST \
            -H "Authorization: Bearer ${{ secrets.DOCNINE_TOKEN }}" \
            -d '{}' \
            https://mcp.docnineai.com/projects/${{ env.PROJECT_ID }}/mcp/get_critical_findings
```

### GitLab CI Example

```yaml
security_scan:
  script:
    - |
      curl -X POST \
        -H "Authorization: Bearer $DOCNINE_TOKEN" \
        https://mcp.docnineai.com/projects/$PROJECT_ID/mcp/get_security_score
```

---

## FAQ

**Q: Can I use the same token for multiple projects?**  
A: No. Each token is tied to the project it was created in. Create separate tokens for each project.

**Q: How long does a request take?**  
A: Usually 2-5 seconds depending on codebase size. First request may take 10-30s while scanning.

**Q: Can I use this without MCP (raw HTTP)?**  
A: Yes! Use the HTTP endpoints with `curl` or any HTTP client.

**Q: Are tokens encrypted in transit?**  
A: Yes. All MCP requests go over HTTPS. Tokens are never logged or cached.

**Q: What if I lose a token?**  
A: You can't recover it. Generate a new one from dashboard and revoke the old one.

**Q: Can tokens be restricted to specific IPs?**  
A: Yes (coming soon). Contact support to enable IP whitelist.

---

## API Reference

### POST `/projects/:projectId/mcp/call`

Call any MCP tool with generic endpoint.

**Auth:** `Bearer TOKEN` (requires `mcp` scope)

**Body:**
```json
{
  "tool": "ask_codebase",
  "input": { "question": "..." }
}
```

**Response:**
```json
{
  "success": true,
  "tool": "ask_codebase",
  "result": "...",
  "executedAt": "2025-03-14T10:30:00Z"
}
```

---

### POST `/projects/:projectId/mcp/:tool`

Direct tool endpoint (e.g., `POST /...mcp/ask_codebase`).

**Auth:** `Bearer TOKEN`

**Body:** Tool-specific input

```json
{ "question": "What..." }
```

---

### GET `/projects/:projectId/mcp/tools`

List all available MCP tools for a project.

**Auth:** `Bearer TOKEN`

**Response:**
```json
{
  "tools": [
    {
      "name": "ask_codebase",
      "category": "qa",
      "description": "...",
      "input": { "question": "string" }
    },
    ...
  ]
}
```

---

### GET `/projects/:projectId/mcp/health`

Check MCP server status (no auth required).

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2025-03-14T10:30:00Z"
}
```

---

## Support

- 📚 **Docs:** https://docnineai.com/docs/mcp
- 🐛 **Report Issues:** https://github.com/docnineai/docnine-server/issues
- 💬 **Discord:** https://discord.gg/docnine
- 📧 **Email:** support@docnineai.com

---

**Last updated:** March 14, 2025  
**MCP Spec version:** Compatible with MCP 1.0  
**Docnine version:** v3.0.0+
