// ===================================================================
// HTML response for provider OAuth popup callbacks.
// Interpolations are JSON-encoded (script) or HTML-escaped (body)
// so usernames / error messages cannot break out of context.
// postMessage targets FRONTEND_URL only — never '*'.
// ===================================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function titleCase(provider) {
  if (provider === "azure") return "Azure DevOps";
  if (provider === "github") return "GitHub";
  if (provider === "gitlab") return "GitLab";
  if (provider === "bitbucket") return "Bitbucket";
  return provider;
}

/**
 * Send a self-closing popup page that notifies the opener and stores
 * the result for same-origin polling fallbacks.
 *
 * @param {import('express').Response} res
 * @param {{ provider: string, status: 'success'|'error', message?: string, user?: string }} opts
 */
export function sendOAuthPopupResult(res, { provider, status, message, user }) {
  const frontendUrl = process.env.FRONTEND_URL || "";
  const label = titleCase(provider);
  const ok = status === "success";
  const heading = ok ? "Successfully Connected" : "Connection Failed";
  const title = ok ? `${label} Connected` : `${label} Connection Failed`;
  const bodyText = ok && user
    ? `${label} account connected as <strong>${escapeHtml(user)}</strong>`
    : escapeHtml(message || (ok ? "Connected." : "Connection failed."));

  const payload = {
    type: `${provider}-oauth-complete`,
    status,
    ...(user ? { user } : {}),
    ...(message ? { msg: message } : {}),
  };

  const payloadJson = JSON.stringify(payload);
  const originJson = JSON.stringify(frontendUrl);
  const storageKeyJson = JSON.stringify(`__docnine_${provider}_oauth_result`);
  const closeDelay = ok ? 500 : 0;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(title)}</title>
  <meta charset="utf-8" />
  <style>body { font-family: system-ui; text-align: center; padding: 2rem; }</style>
</head>
<body>
  <h2>${escapeHtml(heading)}</h2>
  <p>${bodyText}</p>
  <script>
    (function () {
      var result = ${payloadJson};
      try { localStorage.setItem(${storageKeyJson}, JSON.stringify(result)); } catch (e) {}
      var origin = ${originJson};
      if (window.opener && origin) {
        window.opener.postMessage(result, origin);
      }
      setTimeout(function () { window.close(); }, ${closeDelay});
    })();
  </script>
</body>
</html>`);
}
