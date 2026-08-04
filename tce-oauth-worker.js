// ============================================================
// TCE Office Booking — Cloudflare Worker  (deployed as: tce-oauth)
// Full proxy: handles OAuth, serves app, proxies API to Apps Script
// ============================================================

const CLIENT_ID = '922633372763-rhftau15jc4loepphatc2fl51r5unhkf.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const CALLBACK_URI = 'https://tce-oauth.agencytech.workers.dev/callback';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyhp7Uf5V4K7q88FheCAizMosGejrnVPVdsI8O9nZJMIf4pbfBaifk7QcSATbCJJo-r/exec';
const DOMAIN = 'thecontentemporium.co.uk';

// Hard ceiling on how long we'll wait for Apps Script before giving up cleanly.
// Prevents the 30s+ hangs seen in the logs — a slow backend now fails fast as a
// graceful 502 instead of leaving the request (and the user) stuck.
const APPS_SCRIPT_TIMEOUT_MS = 20000;

// getInitialLoadShared's response is identical for every caller asking about
// the same weekStart+monthStart (see that action's comment in code.gs) — it
// deliberately excludes anything per-user (prefs, "mine"). That's what makes
// it safe to cache here at Cloudflare's edge, keyed on weekStart+monthStart
// only (no session/user data in the key) — a cache hit skips the call to
// Apps Script entirely, sidestepping its per-request latency variance rather
// than just reducing how often it's hit. Kept short and TTL-only (no
// purge-on-write): the actual booking flow (bookDesk/cancelDesk/etc.) never
// reads through this cache — it goes through the always-live getAll/
// getGlassBox/getMonthSummary actions, which is why a write shows up for the
// person who made it immediately regardless of this TTL. The only case this
// TTL bounds is someone else hard-refreshing the whole page within this
// window of another person's booking change — a short, rare, low-stakes
// staleness window, same category of trade-off as every other TTL in this
// app (see ARCHITECTURE.md's caching table).
const SHARED_CACHE_TTL_SECONDS = 60;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://deskbooking.agencytech.workers.dev',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// Session stored in cookie as base64 JSON — no server memory needed
function encodeSession(data) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(data))));
}

function decodeSession(str) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(str))));
  } catch(e) {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS PREFLIGHT ──────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── OAUTH CALLBACK ──────────────────────────────────────
    if (url.pathname === '/callback') {
      try {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (!code) return new Response('Missing code', { status: 400 });

        // Exchange code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: CALLBACK_URI,
            grant_type: 'authorization_code'
          })
        });

        const tokens = await tokenRes.json();
        if (tokens.error) return new Response('Token error: ' + tokens.error_description, { status: 400 });

        // Get user info
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: 'Bearer ' + tokens.access_token }
        });
        const userInfo = await userRes.json();

        // Validate domain
        if (!userInfo.email || !userInfo.email.endsWith('@' + DOMAIN)) {
          return new Response('Access restricted to @' + DOMAIN + ' accounts.', { status: 403 });
        }

        // Encode session directly in cookie — no server storage needed
        const sessionData = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: Date.now() + (tokens.expires_in * 1000),
          email: userInfo.email,
          name: userInfo.name,
          picture: userInfo.picture || ''
        };

        const sessionCookie = encodeSession(sessionData);

        // Set session cookie and redirect to app
        return new Response(null, {
          status: 302,
          headers: {
            'Location': 'https://tce-oauth.agencytech.workers.dev/app',
            'Set-Cookie': `tce_session=${sessionCookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
          }
        });

      } catch(err) {
        return new Response('Callback error: ' + err.message, { status: 500 });
      }
    }

    // ── SERVE APP ───────────────────────────────────────────
    if (url.pathname === '/app') {
      const sessionId = getSessionCookie(request);
      const session = await getSession(sessionId, env);

      if (!session) {
        return Response.redirect('https://deskbooking.agencytech.workers.dev/signin.html', 302);
      }

      // Redirect to the asset-hosted app page. Not named index.html: Cloudflare's
      // asset server treats that filename as the implicit document for "/" and
      // won't serve it at its own path, which since "/" is worker-first meant
      // /app -> /index.html -> / -> signin -> /app looped forever.
      return Response.redirect('https://deskbooking.agencytech.workers.dev/app.html', 302);
    }

    // ── API PROXY ───────────────────────────────────────────
    if (url.pathname === '/api') {
      const sessionCookie = getSessionCookie(request);
      const session = await getSession(sessionCookie, env);

      if (!session) return jsonResponse({ error: 'unauthenticated' }, 401);

      // Refresh token if needed
      const { session: refreshed, newCookie } = await maybeRefreshToken(session, sessionCookie, env);
      if (!refreshed) return jsonResponse({ error: 'unauthenticated' }, 401);

      // Helper to add refreshed cookie to response headers if needed
      const withCookie = (response) => {
        if (!newCookie) return response;
        const headers = new Headers(response.headers);
        headers.set('Set-Cookie', `tce_session=${newCookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
        return new Response(response.body, { status: response.status, headers });
      };

      if (request.method === 'GET') {
        const action = url.searchParams.get('action');

        if (action === 'getInitialLoadShared') {
          const cache = caches.default;
          const cacheKey = sharedCacheKey(url);

          const cached = await cache.match(cacheKey);
          if (cached) {
            return withCookie(new Response(cached.body, { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }));
          }

          const asUrl = buildAppsScriptUrl(url, refreshed);
          const result = await fetchAppsScriptJson(
            () => fetch(asUrl.toString(), { redirect: 'follow', signal: AbortSignal.timeout(APPS_SCRIPT_TIMEOUT_MS) }),
            { retries: 1 }
          );
          if (!result.ok) return withCookie(jsonResponse({ error: result.error }, 502));

          const body = JSON.stringify(result.data);
          // Cache the raw response body (not the parsed object) so the hit
          // path above can hand it straight back with no re-serialization.
          // waitUntil so populating the cache never delays this response.
          ctx.waitUntil(cache.put(cacheKey, new Response(body, {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${SHARED_CACHE_TTL_SECONDS}` }
          })));
          return withCookie(new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }));
        }

        // Forward query params to Apps Script
        const asUrl = buildAppsScriptUrl(url, refreshed);

        // Reads are idempotent → one retry masks a transient Apps Script hiccup.
        const result = await fetchAppsScriptJson(
          () => fetch(asUrl.toString(), {
            redirect: 'follow',
            signal: AbortSignal.timeout(APPS_SCRIPT_TIMEOUT_MS)
          }),
          { retries: 1 }
        );
        if (!result.ok) return withCookie(jsonResponse({ error: result.error }, 502));
        return withCookie(jsonResponse(result.data));
      }

      if (request.method === 'POST') {
        const body = await request.json();
        // Add user info from session
        body.workerEmail = refreshed.email;
        body.workerName = refreshed.name;
        body.workerToken = refreshed.access_token;

        // Writes are NOT idempotent (booking/cancel) → never auto-retry.
        const result = await fetchAppsScriptJson(
          () => fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            redirect: 'follow',
            signal: AbortSignal.timeout(APPS_SCRIPT_TIMEOUT_MS)
          }),
          { retries: 0 }
        );
        if (!result.ok) return withCookie(jsonResponse({ error: result.error }, 502));
        return withCookie(jsonResponse(result.data));
      }
    }

    // ── SIGN OUT ────────────────────────────────────────────
    if (url.pathname === '/signout') {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': 'https://deskbooking.agencytech.workers.dev/signin.html',
          'Set-Cookie': 'tce_session=; Path=/; HttpOnly; Secure; Max-Age=0'
        }
      });
    }

    // ── ROOT ─────────────────────────────────────────────────
    if (url.pathname === '/' || url.pathname === '') {
      return Response.redirect('https://deskbooking.agencytech.workers.dev/signin.html', 302);
    }

    // ── SIGN IN (clean URL) ──────────────────────────────────
    // html_handling is "none" (see wrangler.toml) so the asset server won't
    // auto-map /signin -> signin.html itself; with no matching asset the
    // request falls through to the Worker, which needs its own route for it.
    if (url.pathname === '/signin') {
      return Response.redirect('https://deskbooking.agencytech.workers.dev/signin.html', 302);
    }

    // ── NOT FOUND ────────────────────────────────────────────
    // Never `fetch(request)` here: this Worker owns its own hostname, so
    // re-fetching the inbound URL just re-enters this same Worker and spins
    // an infinite subrequest loop that hangs the request (and starves the
    // isolate). Static files are served by the assets binding before the
    // Worker runs, so anything reaching this point genuinely does not exist.
    return new Response('Not found', { status: 404 });
  }
};

// ── HELPERS ──────────────────────────────────────────────────

// Builds the Apps Script exec URL for a GET request, forwarding the caller's
// query params plus their identity from the session.
function buildAppsScriptUrl(url, session) {
  const asUrl = new URL(APPS_SCRIPT_URL);
  for (const [k, v] of url.searchParams) {
    if (k !== 'sessionId') asUrl.searchParams.set(k, v);
  }
  asUrl.searchParams.set('workerEmail', session.email);
  asUrl.searchParams.set('workerName', session.name);
  asUrl.searchParams.set('workerPicture', session.picture || '');
  asUrl.searchParams.set('workerToken', session.access_token);
  return asUrl;
}

// Cache key for getInitialLoadShared — deliberately built from a synthetic
// URL containing ONLY weekStart/monthStart, never the real request URL
// (which carries workerEmail/workerToken/etc as query params). Using the raw
// request as the key would fragment the cache per-user and defeat the point
// of this cache entirely, since every user's request would look like a
// distinct cache key.
function sharedCacheKey(url) {
  const key = new URL('https://tce-shared-cache.internal/getInitialLoadShared');
  key.searchParams.set('weekStart', url.searchParams.get('weekStart') || '');
  key.searchParams.set('monthStart', url.searchParams.get('monthStart') || '');
  return new Request(key.toString());
}

function getSessionCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/tce_session=([^;]+)/);
  return match ? match[1] : null;
}

async function getSession(sessionCookie, env) {
  if (!sessionCookie) return null;
  return decodeSession(sessionCookie);
}

async function maybeRefreshToken(session, sessionCookie, env) {
  if (Date.now() < session.expires_at - 60000) return { session, newCookie: null };
  if (!session.refresh_token) return { session: null, newCookie: null };

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: session.refresh_token,
        grant_type: 'refresh_token'
      })
    });
    const refreshed = await res.json();
    if (refreshed.error) return { session: null, newCookie: null };

    session.access_token = refreshed.access_token;
    session.expires_at = Date.now() + (refreshed.expires_in * 1000);
    const newCookie = encodeSession(session);
    return { session, newCookie };
  } catch(e) {
    return { session: null, newCookie: null };
  }
}

// Fetches Apps Script and safely parses JSON. Apps Script returns an HTML error
// page (starting "<!DOCTYPE") when it times out, errors, or hits a quota — calling
// .json() on that throws and 500s the whole worker (the bug in the logs). This
// reads the body as text first and only parses when it actually looks like JSON,
// returning a structured {ok:false} on any failure so the caller degrades cleanly.
// makeFetch is a thunk so each retry issues a fresh request (and fresh timeout).
async function fetchAppsScriptJson(makeFetch, { retries = 0 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await makeFetch();
    } catch (e) {
      // Timeout/abort or network error — don't retry a slow/unreachable backend.
      return { ok: false, error: 'backend_timeout' };
    }

    const text = await res.text();
    const first = text.trim().charAt(0);
    if (first === '{' || first === '[') {
      try {
        return { ok: true, data: JSON.parse(text) };
      } catch (e) { /* malformed — fall through to retry/return */ }
    }

    // Non-JSON (HTML error page). Retry once for reads; otherwise give up cleanly.
    if (attempt < retries) continue;
    return { ok: false, error: 'backend_error' };
  }
  return { ok: false, error: 'backend_error' };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}
