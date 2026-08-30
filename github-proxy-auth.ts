// Minimal single-user OAuth "consent" screen for the GitHub proxy.
//
// This proxy has exactly one intended user (you), so there's no real user
// database — approval just means "the person completing this form knows the
// passphrase you set." The GitHub PAT itself is never passed through this
// flow or exposed to the client; it's read directly from the Worker's env
// inside github-proxy.ts on every tool call.

export interface AuthEnv {
  // Passphrase required to approve a new client connecting to this proxy.
  // Set with: wrangler secret put PROXY_APPROVAL_PASSPHRASE
  PROXY_APPROVAL_PASSPHRASE: string;

  // Injected automatically by @cloudflare/workers-oauth-provider — not
  // something you configure yourself, just needs to be in the Env type.
  OAUTH_PROVIDER: {
    parseAuthRequest: (request: Request) => Promise<any>;
    lookupClient: (clientId: string) => Promise<{ clientName?: string } | null>;
    completeAuthorization: (options: {
      request: any;
      userId: string;
      metadata: Record<string, unknown>;
      scope: string[];
      props: Record<string, unknown>;
    }) => Promise<{ redirectTo: string }>;
  };
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#039;";
    }
  });
}

function renderApprovalPage(
  encodedReq: string,
  clientName: string,
  error?: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Authorize access</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="font-family: system-ui, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 16px;">
    <h2>Authorize "${escapeHtml(clientName)}"</h2>
    <p>This grants access to your GitHub proxy — a restricted view of GitHub via a scoped personal access token.</p>
    ${error ? `<p style="color: #b91c1c;">${escapeHtml(error)}</p>` : ""}
    <form method="POST">
      <input type="hidden" name="oauthReqInfo" value="${encodeURIComponent(encodedReq)}" />
      <label style="display: block; margin-bottom: 12px;">
        Passphrase
        <input
          type="password"
          name="passphrase"
          autofocus
          required
          style="display: block; width: 100%; box-sizing: border-box; padding: 8px; margin-top: 4px;"
        />
      </label>
      <button type="submit" style="padding: 8px 16px; cursor: pointer;">Approve</button>
    </form>
  </body>
</html>`;
}

export async function handleAuthorizeRequest(
  request: Request,
  env: AuthEnv,
): Promise<Response> {
  if (request.method === "GET") {
    const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const clientInfo = await env.OAUTH_PROVIDER.lookupClient(
      oauthReqInfo.clientId,
    );

    return new Response(
      renderApprovalPage(
        JSON.stringify(oauthReqInfo),
        clientInfo?.clientName ?? oauthReqInfo.clientId,
      ),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const passphrase = form.get("passphrase");
    const encodedReq = form.get("oauthReqInfo");

    if (typeof encodedReq !== "string") {
      return new Response("Missing authorization request", { status: 400 });
    }

    const oauthReqInfo = JSON.parse(decodeURIComponent(encodedReq));

    if (passphrase !== env.PROXY_APPROVAL_PASSPHRASE) {
      const clientInfo = await env.OAUTH_PROVIDER.lookupClient(
        oauthReqInfo.clientId,
      );
      return new Response(
        renderApprovalPage(
          encodedReq,
          clientInfo?.clientName ?? oauthReqInfo.clientId,
          "Incorrect passphrase.",
        ),
        {
          status: 401,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      // Single-user proxy — this is just a stable label, not a real lookup.
      userId: "robdhill",
      metadata: { label: "GitHub proxy (personal)" },
      scope: oauthReqInfo.scope ?? [],
      // Nothing sensitive needs to travel through the OAuth grant — the
      // GitHub PAT is read straight from the Worker's secrets, not from
      // these props.
      props: {},
    });

    return Response.redirect(redirectTo, 302);
  }

  return new Response("Method not allowed", { status: 405 });
}
