// ============================================================
// TCE Office Booking — Cloudflare Worker
// Handles OAuth callback and proxies API calls to Apps Script
// ============================================================

const CLIENT_ID = '922633372763-rhftau15jc4loepphatc2fl51r5unhkf.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'https://deskbooking.agencytech.workers.dev/callback';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyhp7Uf5V4K7q88FheCAizMosGejrnVPVdsI8O9nZJMIf4pbfBaifk7QcSATbCJJo-r/exec';
const DOMAIN = 'thecontentemporium.co.uk';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── OAUTH CALLBACK ──────────────────────────────────────
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (!code) {
        return new Response('Missing OAuth code', { status: 400 });
      }

      // Exchange code for tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code'
        })
      });

      const tokens = await tokenRes.json();

      if (tokens.error) {
        return new Response('Auth error: ' + tokens.error_description, { status: 400 });
      }

      // Get user info
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: 'Bearer ' + tokens.access_token }
      });
      const userInfo = await userRes.json();

      // Validate domain
      if (!userInfo.email || !userInfo.email.endsWith('@' + DOMAIN)) {
        return new Response('Access restricted to @thecontentemporium.co.uk accounts.', { status: 403 });
      }

      // Store session in Apps Script via POST
      const sessionRes = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'createSession',
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
          email: userInfo.email,
          name: userInfo.name,
          picture: userInfo.picture,
          state
        }),
        redirect: 'follow'
      });

      const sessionData = await sessionRes.json();

      if (sessionData.error || !sessionData.sessionId) {
        return new Response('Session creation failed: ' + JSON.stringify(sessionData), { status: 500 });
      }

      // Redirect to Apps Script main app with session
      return Response.redirect(
        APPS_SCRIPT_URL + '?session=' + sessionData.sessionId,
        302
      );
    }

    // ── ROOT — redirect to signin ────────────────────────────
    if (url.pathname === '/' || url.pathname === '') {
      return Response.redirect('https://deskbooking.agencytech.workers.dev/signin.html', 302);
    }

    // ── STATIC FILES — pass through to Pages ────────────────
    return fetch(request);
  }
};
