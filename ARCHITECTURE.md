# TCE Desk Booking — Technical Documentation

This is the full technical picture of the system: what runs where, how data flows,
where things are stored, and what's known to be broken or half-finished. Written
so a new human or AI picking this up cold doesn't need anything beyond this file,
the repo, and the two external consoles it references (Cloudflare, Google).

## 1. What this is

An internal desk-booking app for `thecontentemporium.co.uk`. Staff sign in with
their Google Workspace account, see a 5-day (Mon–Fri) grid of 12 desks plus a
"Glass Box" meeting room, book/cancel a desk (full day or AM/PM half), toggle a
"bringing my dog" flag, and book the Glass Box against a shared Google Calendar
resource. Booking a desk also creates a "working location" entry on the user's
own Google Calendar.

There is no database. The system of record is a Google Sheet, and the app server
is a Google Apps Script project — not a conventional backend.

## 2. Components and where they live

| Component | What it is | Where it lives | Repo path |
|---|---|---|---|
| Sign-in page | Static HTML, kicks off Google OAuth | Served as a static asset by the Worker | [public/signin.html](public/signin.html) |
| App page | Static HTML/JS, the booking UI | Served as a static asset by the Worker | [public/app.html](public/app.html) |
| Edge Worker | OAuth callback, session cookie, API proxy | Cloudflare Workers (see §3) | [tce-oauth-worker.js](tce-oauth-worker.js) |
| Worker config | Asset binding, routing rules | Cloudflare | [wrangler.toml](wrangler.toml) |
| Backend | All business logic, reads/writes the Sheet, calls Google Calendar/People APIs | Google Apps Script project bound to the Sheet | [apps-script/code.gs](apps-script/code.gs) — **reference copy only**, see §8 |
| Data store | Bookings, day notes, admin list | Google Sheet `1C1k-ZMmizDFf357fAQvKdKgjmgaP8V_zmGrie-KR0vI` | external |
| Glass Box calendar | Room resource calendar | Google Calendar resource `c_1880lps1iqdbajhuggvb8tlc8i36g@resource.calendar.google.com` | external |
| Social calendar | Read-only events shown in the UI | Google Calendar `c_41272cd44...@group.calendar.google.com` | external |
| User's own calendar | "Working location" entries | The signed-in user's `primary` calendar | external |

`worker.js` in the repo root is dead code — an earlier draft of the Worker,
superseded by `tce-oauth-worker.js`, not referenced by `wrangler.toml` or
anything else. Safe to ignore (removal is pending — see §9).

## 3. The two-Workers-one-repo setup (important, non-obvious)

Two separate Cloudflare Workers are both connected to **this same GitHub repo**
via Workers Builds, both building the same `wrangler.toml` / `tce-oauth-worker.js`:

- `tce-oauth` → `https://tce-oauth.agencytech.workers.dev`
- `deskbooking` → `https://deskbooking.agencytech.workers.dev`

A push to `main` triggers a build+deploy on **both**. They end up running
identical code and serving identical static assets. The app's own links and API
calls are hardcoded to specific hostnames per purpose (OAuth callback and API
proxy go to `tce-oauth`, the actual HTML pages are linked at `deskbooking`) —
see §5 for exactly which hostname is used where.

**Why this matters:** this is exactly what caused an outage during initial
deployment (2026-08-04). Before `wrangler.toml` had an `[assets]` block, pushing
it deployed the OAuth *script* to both Workers and silently wiped
`deskbooking`'s static-file serving, since the script had no assets bound and no
static-file fallback. Any config change here affects both Workers
simultaneously — there's no way to deploy to just one via this repo. If they
ever need to diverge, they need separate Wrangler configs/branches or one needs
disconnecting from Workers Builds.

**Deploy latency / rollout flapping:** After a push, Cloudflare's rollout across
edge nodes is not instantaneous or atomic — for a minute or two after a deploy,
different requests (even to the same URL, same edge colo) can hit the old and
new versions unpredictably. This isn't a bug, just something to expect and wait
out when verifying a deploy, rather than something to debug.

## 4. Cloudflare Worker: routing and asset config

`wrangler.toml`:

```toml
name = "tce-oauth"
main = "tce-oauth-worker.js"
[assets]
directory = "./public"
not_found_handling = "none"
html_handling = "none"
run_worker_first = ["/", "/api", "/app", "/callback", "/signout"]
```

- **`run_worker_first`** — these exact paths always invoke the Worker's `fetch()`
  handler, regardless of whether a matching static asset exists. Everything else
  is asset-first: if a file in `public/` matches the path, it's served directly
  and the Worker never runs; if nothing matches, the request falls through to
  the Worker (because `not_found_handling = "none"`).
- **`html_handling = "none"`** — asset requests are served verbatim, with none
  of Cloudflare's usual clean-URL rewriting (no `/foo.html` → `/foo` redirect,
  no extension-guessing). This was deliberately turned off — see §9 for why —
  which means any "pretty URL" alias (e.g. `/signin` for `signin.html`) has to
  be added explicitly as a Worker route, by hand, in `tce-oauth-worker.js`.
- The app's HTML lives in `public/` rather than the repo root specifically so
  the Worker's own source (which used to contain a plaintext secret) is never
  addressable as a static asset.
- The app's actual page is `public/app.html`, **not** `index.html`. Cloudflare's
  asset server treats a file literally named `index.html` as the implicit
  document for `/` and won't serve it at its own path — see §9.

### Static asset payload and browser caching (investigated 2026-08-04)

`app.html` is a single monolithic file — HTML, CSS, and JS all inline, plus two
branding images embedded as data URIs (no separate `.css`/`.js`/image files
exist to point a CDN cache or long-lived `Cache-Control` at). Two things found
while chasing load-time complaints:

1. **The two embedded logos were far larger than their display size needed.**
   Both were the same 1042×1042 PNG (~18KB each) — one shown at 64×64 CSS px
   in the header (`.logo-box`), the other at up to 460 CSS px in the loading
   splash. The header one was re-encoded down to 128×128 WebP (~2.3KB); the
   splash one was kept at its original resolution (it's genuinely displayed
   large enough to need it) but re-encoded from PNG to WebP at quality 92
   (~9.4KB, down from ~18KB, same pixels). Combined, this cut `app.html`'s raw
   size by ~26% and its Brotli-compressed size by ~44% (measured: ~49KB → an
   estimated ~27KB). WebP is safe here — every browser capable of signing in
   via Google OAuth supports it.
2. **The live response has no `ETag`/`Last-Modified`, only
   `Cache-Control: public, max-age=0, must-revalidate`.** `max-age=0` alone
   would be fine if paired with a validator (the browser would send a
   conditional request and usually get a cheap 304), but with no validator at
   all the browser has nothing to send — every navigation re-downloads the
   full file from scratch, even a same-day repeat visit. This is Cloudflare's
   default for this asset configuration, not something set explicitly in this
   repo. **Not fixed as part of this pass** — fixing it properly means routing
   `/app.html` through the Worker (via `env.ASSETS.fetch()` + rewriting
   response headers, adding a real `ETag`) rather than serving it purely
   asset-first, which changes routing behaviour that has already caused an
   outage once before (§9) and deserves its own careful test pass rather than
   a drive-by change alongside unrelated fixes.

**Not done, left as an option:** splitting `getGlassBoxWeek`'s Calendar API
call back out of `getInitialLoadShared` (it was folded in for round-trip-count
reasons — see the concurrency section below) — the `GLASS_TTL` bump above
addresses the same risk more cheaply, so this is only worth revisiting if
staleness/latency on `gb_` turns out to still be a problem in practice.

### Cloudflare edge cache for shared data (2026-08-04)

Direct measurement (repeated calls to `getHolidays` — the cheapest possible
action, a single cache hit with zero external API calls) showed Apps Script's
`/exec` endpoint itself varying **1.4s–11s+ between back-to-back calls** with
identical inputs. That's latency in Google's own request routing before the
script even runs — nothing in this codebase can reduce it, only avoid paying
it. The only way to actually eliminate it for a given load is to not call
Apps Script at all. That's what this does, for the parts of a page load where
it's possible.

**The split.** `getInitialLoad`'s response was almost entirely the same for
every caller asking about a given `weekStart`+`monthStart` — desk grid,
social events, Glass Box, holidays/birthdays/anniversaries, and the month
calendar's `full` flags. Only two things in it were genuinely per-caller:
`prefs` (their own name/email/picture/admin flag) and the month calendar's
`mine` flag (which days *they* booked). So the one action became two:

- **`getInitialLoadShared`** (`code.gs`) — everything shared, nothing
  personal. `getMonthSummary`'s scan was split into `scanMonthBookings()` +
  `fullFlagsFrom()` so the shared `full` flags can be computed and cached
  once per month for everyone (`msf_<month>`), instead of redundantly inside
  every user's own `ms_<email>_<month>` cache entry the way it was before.
- **`getPersonal`** (`code.gs`) — just `prefs` and `mine`, reusing
  `getMonthSummary`'s existing per-user cache rather than re-scanning.
- **`tce-oauth-worker.js`** caches `getInitialLoadShared`'s response at
  Cloudflare's edge (`caches.default`), keyed on a *synthetic* URL containing
  only `weekStart`+`monthStart` — deliberately never the real request URL,
  which carries `workerEmail`/`workerToken`. Getting this key construction
  wrong is the one way this feature could leak data (a key that varies by
  caller identity defeats the cache; a shared payload that accidentally
  includes `prefs`/`mine` would leak one user's identity/admin status to
  whoever else hits the same cache entry) — this is exactly why the split
  above exists at the data-shape level, not just as a cache-key trick.
  `SHARED_CACHE_TTL_SECONDS = 60`. On a hit, Apps Script is never called at
  all for that portion of the load.
- **`app.html`'s `loadInitial()`** fires both calls together rather than one
  awaiting the other, so the (potentially slow, always-live) personal call
  never blocks the shared render behind it. The desk grid/Glass Box/holidays
  render as soon as `getInitialLoadShared` resolves; "my desk" highlighting
  and admin-only controls in that same grid depend on `currentUser`, which
  isn't set until `getPersonal` resolves a moment later — so the week grid is
  deliberately re-rendered (same cached data, no extra network call) once it
  does, to catch that highlighting up rather than leave it missing.

**Trade-offs accepted, deliberately:**
- **No purge-on-write.** Cloudflare's cache has no hook into
  `invalidateWeek()`/`invalidateMonth()` on the Apps Script side — a 60s TTL
  is the only freshness mechanism here, not an invalidation call. This is
  safe specifically because the booking flow itself (`bookDesk`, `cancelDesk`,
  `bookMyWeek`, `bookGlassBox`, …) never reads through this cache — it always
  goes through the unchanged, always-live `getAll`/`getGlassBox`/
  `getMonthSummary` actions, invalidated exactly as before. The *only* case
  the 60s window bounds is someone hard-refreshing the whole page within a
  minute of *someone else's* booking change — same category of trade-off as
  every other TTL in the caching table above, just at a different layer.
- **A cold miss now costs two Apps Script round trips instead of one**
  (`getInitialLoadShared` + `getPersonal`, both still queued through the
  same serialized `api()`/`apiPost()` mechanism — see the concurrency
  section below). This is the opposite of the round-trip-count optimization
  `getInitialLoad` was originally built for. The bet: with a single office
  full of people loading the same current week, most requests land on a
  *warm* Cloudflare cache (near-zero latency, bypassing Apps Script
  entirely) far more often than they land on a genuinely cold one, so this
  trade is net-positive in practice — but it is a real trade, not a free win.
- `caches.default` is per-edge-node, not globally shared across every
  Cloudflare colo — the first request to hit a given edge node still pays
  the full cost. That's expected and fine: the benefit is people in the same
  office/region sharing a cache, not a single global one.

## 5. Request routing reference

All hardcoded hostnames as they appear in the code today:

| Path | Host | Handled by | Behavior |
|---|---|---|---|
| `/` | either | Worker (`run_worker_first`) | 302 → `deskbooking.../signin.html` |
| `/signin` | either | Worker (explicit route, fallthrough) | 302 → `deskbooking.../signin.html` |
| `/signin.html` | either | static asset | serves `public/signin.html` |
| `/app.html` | either | static asset | serves `public/app.html` |
| `/app` | either | Worker (`run_worker_first`) | checks session cookie; redirects to `signin.html` (no session) or `app.html` (has session) — see caveat below |
| `/callback` | `tce-oauth` (per `CALLBACK_URI` const) | Worker | Google OAuth code exchange, sets session cookie, 302 → `/app` |
| `/api` | `tce-oauth` (hardcoded as `WORKER` in `app.html`) | Worker | proxies to Apps Script, requires session cookie |
| `/signout` | either | Worker (`run_worker_first`) | clears cookie, 302 → `signin.html` |

Caveat on `/app`: it's a `run_worker_first` path served on **both** hostnames,
but its redirect target is hardcoded to `deskbooking.../app.html`/`signin.html`
regardless of which hostname was hit. Visiting `tce-oauth.../app` works fine
functionally (redirects to the right place on `deskbooking`), just worth
knowing it's not host-symmetric.

## 6. Authentication and session flow

1. `signin.html` builds a Google OAuth URL by hand (no library): scopes are
   `userinfo.email`, `userinfo.profile`, and `calendar` (full calendar access —
   needed because the backend acts on the *user's own* token later, see §8).
   `access_type=offline` requests a refresh token. A random `state` UUID is
   generated client-side and stashed in `sessionStorage`, but **the Worker's
   `/callback` never validates it** — it's read off the query string and simply
   discarded. This means the OAuth state parameter currently provides no real
   CSRF protection; it's present but non-functional. See §10.
2. Google redirects to `/callback` on `tce-oauth` with an auth `code`.
3. The Worker exchanges the code for tokens directly with Google
   (`oauth2.googleapis.com/token`), using a hardcoded `client_id` +
   `client_secret` (see §7 for the problem with this).
4. It fetches the user's profile (`googleapis.com/oauth2/v2/userinfo`) and
   rejects (403) anyone whose email doesn't end in `@thecontentemporium.co.uk`.
   This is the **only** access control in the whole system — no allowlist, no
   Apps Script check on top (Apps Script re-checks the same domain suffix on
   every request, but trusts whatever email the Worker forwards it — see §8).
5. On success, it builds a session object (`access_token`, `refresh_token`,
   `expires_at`, `email`, `name`, `picture`) and stores it **entirely in the
   cookie** — there is no server-side session store anywhere in this system.
   The cookie is base64-encoded JSON, `HttpOnly; Secure; SameSite=Lax; Max-Age=86400`.
6. Every `/api` call decodes that cookie to get the session. If the Google
   access token is within 60s of expiring, `maybeRefreshToken()` uses the
   `refresh_token` to get a new one and re-issues the cookie via `Set-Cookie`
   on the same response.
7. `/signout` just clears the cookie client-side (`Max-Age=0`). Nothing is
   revoked with Google.

**As of 2026-08-04, the live cookie is unsigned** — anyone can base64-encode
their own JSON with an arbitrary `@thecontentemporium.co.uk` email and the
`/api` proxy accepts it as a valid session (confirmed by testing). A fix
(HMAC-SHA256 signing via a `SESSION_SECRET` Worker secret) exists but is not
yet merged — see §10.

## 7. Configuration and secrets

| Name | Current state (live, `main`) | Where |
|---|---|---|
| `CLIENT_ID` | hardcoded in `tce-oauth-worker.js` and `signin.html` | not sensitive, fine as-is |
| `CLIENT_SECRET` | **hardcoded in `tce-oauth-worker.js`**, and also still present in dead `worker.js` | 🔴 leaked — see §10 |
| `APPS_SCRIPT_URL` | hardcoded in `tce-oauth-worker.js` | fixed `/exec` URL, doesn't change on Apps Script redeploys (see §8) |
| Session signing key | **doesn't exist yet** — cookies are unsigned | pending, see §10 |
| Sage HR feed URL | Apps Script **Script Property** `SAGE_ICS_URL` | correctly kept out of source from the start — see §8 |

The pending security branch (`security/session-signing-and-secret-rotation`,
not yet merged) moves `CLIENT_SECRET` to a `GOOGLE_CLIENT_SECRET` Worker secret
and adds a `SESSION_SECRET` Worker secret for cookie signing. **Do not merge
that branch until both secrets exist on the deployed Worker** (`wrangler secret
put GOOGLE_CLIENT_SECRET` / `wrangler secret put SESSION_SECRET`) — the code
has no fallback, so merging first breaks every login and every `/api` call
instantly.

## 8. The Apps Script backend (`code.gs`)

[apps-script/code.gs](apps-script/code.gs) in this repo is a **reference copy
only, kept for version control and diffing.** The actual system of record is
whatever is currently pasted into the Apps Script web editor
(script.google.com) for the project bound to the Sheet — that live editor
content is what Apps Script actually runs (once deployed, see below), and it
can silently drift from this repo copy if someone edits it directly in the
browser and forgets to also update this file (or vice versa: updating this
file does nothing to the live script by itself). Treat any mismatch between
this file and a fresh paste from the editor as the editor winning — this file
is the one that can be stale.

**Committing to this repo does not deploy anything.** Deploying is a separate,
manual step, entirely disconnected from git and from the Cloudflare Workers
Build pipeline that deploys the Worker/frontend on every push. Saving code in
the Apps Script editor doesn't update the live `/exec` endpoint either — that
needs its own explicit action. To publish a change (whether it originated here
or was edited directly in the browser):

1. Apps Script editor → **Deploy → Manage deployments**.
2. Find the deployment whose Web App URL matches `APPS_SCRIPT_URL` in
   `tce-oauth-worker.js` (currently ends `.../AKfycbyhp7Uf5V4K7q88FheCAizMosGejrnVPVdsI8O9nZJMIf4pbfBaifk7QcSATbCJJo-r/exec`).
3. Edit that deployment → Version: **New version** → Deploy.

This keeps the `/exec` URL stable while pointing it at the latest code. Forgetting
this step is a real, already-observed failure mode: on 2026-08-04 the live
deployment was running an older schema (flat `{desk, name, email}` per booking)
while the editor content (and the frontend) expected a newer one
(`{desk, full, am, pm}`, each a `{name, email, dog}` object or `null`) — bookings
existed and were returned correctly, but the frontend's shape check
(`dk.full||dk.am||dk.pm`) treated every desk as empty, since the JSON didn't
have those keys, rendering the grid as unoccupied.

### How requests reach it

The Worker's `/api` proxy calls `APPS_SCRIPT_URL` and forwards the caller's
identity as query params (GET) or JSON body fields (POST): `workerEmail`,
`workerName`, `workerPicture`, `workerToken` (the user's live Google access
token). `doGet`/`doPost` in `code.gs` re-check the email's domain suffix, then
build a `user` object and dispatch on `action`.

**Design point worth flagging:** the backend does not use a service account or
its own OAuth identity for Calendar/People API calls — it uses `workerToken`,
the actual signed-in user's access token, forwarded all the way from the
browser through the cookie, through the Worker, into Apps Script, and out to
`UrlFetchApp` calls against `googleapis.com`. This is why the OAuth scope list
in `signin.html` includes full `calendar` access: Apps Script is acting *as*
the user, not as itself.

### Actions (dispatch table)

GET (`doGet`): `getAll`, `getGlassBox`, `getMonthSummary`, `getHolidays`.
POST (`doPost`): `bookDesk`, `toggleDog`, `cancelDesk`, `adminCancelDesk`,
`bookMyWeek`, `cancelMyWeek`, `bookGlassBox`, `cancelGlassBox`, `searchPeople`.

Writes go through `withLock()` (a 5s `LockService` script lock) to serialize
concurrent booking changes — except `bookGlassBox`/`cancelGlassBox`/`searchPeople`,
which don't take the lock (they don't touch the Sheet directly, only the
Calendar/People APIs).

### Data model — the Sheet

Spreadsheet `1C1k-ZMmizDFf357fAQvKdKgjmgaP8V_zmGrie-KR0vI`, four tabs
(auto-created by `getSheet()` if missing):

- **`Bookings`** — `Date, Desk, Name, Email, BookedAt, Slot, Dog`. One row per
  desk booking. `Desk` 1–12 are the physical core desks; 13+ is overflow
  (auto-incremented when all core desks are taken). `Slot` is `full`, `AM`, or
  `PM` — a desk can have up to two rows on the same day if split AM/PM, or one
  `full` row. `Dog` is a boolean flag on the booking row itself (cancelling the
  desk removes the flag with it — there's no separate dog record).
- **`DayNotes`** — `Date, Note, UpdatedAt, UpdatedBy`. One optional note per day.
- **`Admins`** — `Email`. One column, one email per row. Presence in this list
  is the *only* authorization check for `adminCancelDesk` — no other admin
  action exists.
- **`SageEvents`** — `Name, Kind, Start, End`. Rebuilt in full every run of
  `refreshHolidaysFromSage()` (see §8's Sage section) — treat it as a cache,
  not a hand-edited source, since the next weekly refresh overwrites it
  entirely.
- **`ArchivedBookings`** — same columns as `Bookings`. Rows older than the
  current week get moved here (see below) — treat it as a permanent archive,
  not a working sheet; nothing in the app reads from it.

Sheet values are sanitized on write (`sanitizeSheetValue`) to stop formula
injection (a name starting with `=+-@` gets a leading `'` so Sheets doesn't
evaluate it) — applied to `Bookings` only (names typed by a signed-in Google
user); `SageEvents`/`ArchivedBookings` don't need it (Sage's feed and
already-sanitized archived rows respectively, not free-text user input).

**`Bookings` is kept to the current week onward — `archiveOldBookings()`
moves anything older into `ArchivedBookings` on a daily trigger.** Every
read of `Bookings` (`getBookingsForRange`, `getMonthSummary`, `bookDesk`'s
own-booking check, `assignDeskForSlot`, etc.) does `getDataRange().getValues()`
— a full-sheet read with in-memory filtering, since Sheets has no
partial/indexed read without rows being sorted by date (they're in append
order, not date order). Left unbounded this only gets slower over time; by
explicit choice, the live sheet only needs to stay accurate for the current
week onward, so:

- The cutoff is **"before the start of the current week,"** recomputed
  fresh on every run (not a fixed day-count) — it rolls forward
  automatically and never needs updating by hand.
- **Trade-off accepted deliberately**: week-back navigation and days
  earlier in the month-summary view will show as empty once their week is
  archived (data isn't lost, just no longer read by the live app — visible
  in `ArchivedBookings` if ever needed by hand), and cancelling a booking
  from before the current week will stop finding it. Nothing was added to
  merge the two sheets on read, since that would reintroduce most of the
  cost this exists to avoid.
- Implementation does one read + up to two batch writes (kept rows
  rewritten in place, stale tail removed via `deleteRows`, old rows
  batch-appended to `ArchivedBookings`) rather than deleting matched rows
  one at a time — `deleteRow` in a loop re-shifts every row below it on
  each call, which is fine for a handful of rows but degrades badly on a
  large one-time backlog. Note it's `deleteRows`, not `clearContent` — a
  cleared-but-not-deleted row still counts toward `getLastRow()`/
  `getDataRange()`, so every future read would iterate it and call
  `parseRowDate('')` on it, which throws (`Utilities.formatDate` on an
  Invalid Date) — this was caught in testing before ever being deployed.
- One-time setup: run `installBookingsArchiveTrigger()` once from the Apps
  Script editor (installs a daily 2am trigger). Safe to re-run.

### Caching

`CacheService.getScriptCache()` (script-wide, shared across all users) fronts
every read path, because a cold Sheets+Calendar round-trip is what caused the
30s timeouts the Worker's `APPS_SCRIPT_TIMEOUT_MS` was later added to guard
against:

| Cache key prefix | What | TTL | Invalidated by |
|---|---|---|---|
| `wk_<mondayOfWeek>` | a week's desk bookings + notes | 300s | any booking write for that week |
| `gb_<mondayOfWeek>` | a week's Glass Box events | 300s | Glass Box book/cancel |
| `ms_<email>_<year-month>` | a user's month summary | 120s | that user's own booking write in that month |
| `soc_<mondayOfWeek>` | social calendar events | 300s | never (rarely changes) |
| `admins` | the admin email list | 600s | never (changes almost never) |

TTLs are a backstop, not the primary freshness mechanism — writes explicitly
invalidate the relevant key so the *actor's own* change is visible immediately;
other users may see a stale cache for up to the TTL. `wk_`/`gb_` were bumped
from their original 90s/45s to 300s (2026-08-04) specifically so
`warmSharedCaches()`'s 5-minute trigger keeps them continuously warm between
runs instead of expiring and sitting cold for most of each interval — at the
old TTLs, `gb_` in particular (backed by a live Google Calendar API call, not
just a sheet read) was cold ~85% of the time, and since `getInitialLoad`
folds it into the same execution as everything else, a cold miss there
delayed the *entire* first render, not just the Glass Box grid.

**This sharing only helps within the TTL window, not across idle periods.**
`CacheService` caps out at 6 hours even if asked for longer, and every TTL
above is far shorter than that (120s–600s) — so after the app sits unused for
hours or days, all of these are guaranteed cold, and whoever loads it next
pays the full cost in one request (multiple sheet reads + the Glass Box
Calendar API + `getSocialEvents`'s slow `CalendarApp` call). `warmSharedCaches()`
exists specifically to prevent this: a trigger re-populates the current
week's `wk_`/`gb_`/`soc_`/`hol_` and the `admins` cache every 5 minutes (see
§11 for the one-time setup step), so no one has to be "the first person of
the day" who eats the cold-start cost. It deliberately only warms the
*current* week, not the ±2-week window the frontend prefetches in the
background — that prefetch is already non-blocking, so warming it wouldn't
fix anything a user actually feels, and `getSocialEvents` is expensive enough
that multiplying it by 5 weeks every 5 minutes isn't worth the added Apps
Script execution quota for no felt benefit. `ms_` (month summary) is
per-user and isn't warmed — proactively warming it for "whoever logs in
next" isn't meaningful, though it's a single cheap sheet read on its own,
not the multi-API bottleneck the others are.

**Unverified interaction worth knowing about**: the concurrency limit
described just below was measured between concurrent `doGet` web requests.
Whether a `warmSharedCaches()` trigger execution firing at the same moment
as a real user's request draws from the same concurrency pool (and could
therefore itself cause the same failure) hasn't been tested. If flakiness
ever correlates with the 5-minute trigger boundary, that's the first thing
to check.

### Apps Script concurrency limit — critical, affects every future change here

**Google's Apps Script `/exec` endpoint cannot reliably handle concurrent
requests to the same script.** This was measured directly (2026-08-04), not
assumed: firing 4 simultaneous requests at the live deployment resulted in 1
succeeding quickly and **3 failing after 30+ seconds** with a generic Google
"Page not found" HTML page — not a `doGet` error, not something our own code
produced or could catch. The failure happens inside Google's own
infrastructure before the request ever reaches `doGet`. Firing 2 concurrent
requests didn't fail outright, but the second one queued behind the first
for ~12s even though a single request in isolation completes in 1-4s warm.

This is the actual root cause of "the app is glitchy, I had to reload three
times" and "still loading 20+ seconds after the loading screen finishes":
the frontend's own initial load fires 3-4 requests at once
(`getAll`/`getGlassBox`/`getMonthSummary`/`getHolidays`), and background
prefetch can fire several more on top of that — comfortably enough to land
in the broken zone. The Worker's `APPS_SCRIPT_TIMEOUT_MS` + retry logic
(§4/§8) can't help here either, since from the Worker's point of view this
is Apps Script returning a slow, malformed (non-JSON) response — which it
already handles by returning a 502 — the problem is upstream of that, in
how many requests hit Apps Script at once in the first place.

**Fix: `app.html`'s `queued()` wrapper.** Every call through `api()`/`apiPost()`
is funneled through a single JS promise chain (`appsScriptQueue`) so exactly
one request to Apps Script is ever in flight app-wide, regardless of how
many places want to fetch at once (initial load, background prefetch, rapid
week-nav clicks, a retry firing while something else is pending). This is
enforced centrally in `api()`/`apiPost()` — no caller needs to coordinate
this itself, and nothing about `loadAll`/`loadGlassBox`/etc.'s own structure
had to change. **Any new code that calls Apps Script must go through
`api()`/`apiPost()`, not a raw `fetch()`** — bypassing the queue reintroduces
this exact failure mode.

### Frontend load sequence

`app.html` calls `getAll` first (desks + notes + social events + user prefs;
returns `glassBox: {}` always, deferred on purpose), renders that immediately,
then separately fires `getGlassBox` to fill in the Glass Box grid.
`getAll`/`getGlassBox`/`getHolidays` each retry up to twice with backoff
(1.5s, 3s) on failure or a null/error result before giving up — this exists
independently of the concurrency queue above, as a defense against genuine
transient failures (real network blips, an actual Apps Script error) that
the queue doesn't prevent. `getAll` and `getGlassBox` show an explicit
"Couldn't load — tap to retry" (clickable, re-triggers the same load) after
retries are exhausted; `getHolidays` gives up quietly since it's informational
only, not a booking action.

On first page load only, the loader stays up until `refresh()` (desks +
Glass Box), `loadMonthSummary()`, and `loadHolidays()` have all resolved
(`Promise.all` — safe now that the queue above serializes the actual
network calls underneath it; the backstop below is unrelated to that and
guards against a genuinely stuck/very slow request instead), with a 12s
safety backstop that reveals the page regardless so a hung call can't trap
the user — this avoids widgets popping in one by one after the loader
animation ends. Subsequent week navigation doesn't wait on Glass Box the
same way; it renders cached/desk data immediately and lets Glass Box fill in
a moment later.

The header widget calls `getHolidays` (no params), which returns
`{ success, holidays, birthdays, anniversaries }` — each an array of
`{ name, start, end }` — from `getHolidaysThisWeek()`.

**Data source: Sage HR, not Google Calendar.** All three categories come from
one Sage HR calendar-sync feed (a plain iCal/.ics URL — see Sage HR's
Settings > Calendar sync). That URL is a bearer secret — anyone who has it
can read the whole company's leave/birthday/anniversary data with no further
auth — so it's a **Script Property**, not a hardcoded constant:
`getSageIcsUrl()` reads it from `PropertiesService.getScriptProperties()`.
Set it once via the Apps Script editor's **Project Settings (gear icon) >
Script Properties > Add script property**, key `SAGE_ICS_URL`. This is the
Apps Script equivalent of a Cloudflare Worker secret — it lives outside the
script's source, so it's never in this repo or visible to anyone reading the
code. There's no separate feed per category,
so `code.gs`'s `classifyCalendarEvent()` buckets each event purely by a
keyword in its title (`anniversary` → anniversaries, `birthday` → birthdays,
anything else → a real absence). Sage's own titles are consistently `<Name> -
<Category>` (e.g. "Jane Smith - Birthday", "Jane Smith - Employment
anniversary"), so `sageEventName()` extracts the display name by splitting on
the first `" - "` rather than stripping keywords — company-wide bank holidays
("Christmas Day") have no `" - "` and pass through unchanged, landing in the
"Away this week" bucket (a company holiday, not a real absence — a known
quirk, not fixed). **This is keyword matching against whatever Sage puts in
the title** — if that wording ever changes, events would silently land in
the wrong bucket with no error.

**Occasionally Sage's feed produces an end date before its start date**
(observed live 2026-08-04: an "away" entry showing a start/end pair whose
weekday labels didn't even match real calendar dates, with the end before
the start). The precise malformed input wasn't confirmed directly against
the live feed, but it's reproducible via a malformed all-day `DTEND` equal to
its own `DTSTART` — the exclusive-end-date adjustment a few lines up (`end =
... - 1`) then pushes the end to one day *before* the start. Both
`refreshHolidaysFromSage()` (on write) and `getHolidaysThisWeek()` (on read,
so an already-corrupted row self-heals without waiting for the next weekly
refresh) now drop any row where `end < start` rather than display a
nonsensical range — a missing "away" entry is a much smaller problem than an
impossible one shown to the whole office.

**Fetching from Sage never happens on a page load.** `getHolidaysThisWeek()`
only reads the `SageEvents` sheet tab — a local snapshot, refreshed weekly by
`refreshHolidaysFromSage()` via a time-driven trigger (installed once by
running `installSageWeeklyTrigger()` from the Apps Script editor — this is
a separate one-time setup step from the deployment itself; re-running it is
safe, it clears any existing trigger for the same function first). This
decouples app responsiveness from Sage's availability entirely: if Sage is
slow, down, or the feed format changes enough to break parsing, the app just
keeps serving last week's snapshot rather than failing live requests. A
failed or empty fetch also leaves the existing sheet data untouched rather
than wiping it — `refreshHolidaysFromSage()` parses fully into memory before
writing anything.

The iCal parsing here is hand-rolled (regex-based VEVENT extraction +
RFC5545 line-unfolding), not a library — Apps Script has no built-in ICS
parser. It only reads `DTSTART`/`DTEND`/`SUMMARY` per event; anything else in
the feed (`DESCRIPTION`, `UID`, the `VTIMEZONE` block) is ignored.

**`refreshHolidaysFromSage()` only mirrors a window into `SageEvents`, not
the whole feed** — Sage's feed itself spans well over a year of past and
future events, but `getHolidaysThisWeek()` never looks beyond the current
Mon–Fri week, so storing all of it would only make the sheet (and every read
of it) bigger for no benefit. The window is today −7 days to +30 days,
hardcoded in `refreshHolidaysFromSage()` — generous enough that a missed
weekly refresh (Sage down, quota, whatever) still leaves the current week's
data in the sheet from a recent-enough prior run, rather than a tight
this-week-only window that would go blank after a single missed refresh.

All three lists are scoped to the current calendar week (Mon–Fri), not the
currently-viewed booking week. "Away this week" filters to `end >= today`
(no reason to show someone who's already back) and sorts by end date
(soonest-ending first). Birthdays/anniversaries deliberately don't apply
that filter — they show for the whole current week even after the day's
passed, since the backend already scopes both to Mon–Fri so this can't leak
into other weeks, and unlike "away," a birthday earlier in the week is still
worth knowing about on Thursday.

Each of the three sections in the widget is independently collapsible
(click the section title). Collapsed/expanded state is saved to
`localStorage` (`tce_section_collapsed`) — per-browser, not tied to the
Google account, so it won't follow someone to a different device or browser.

## 9. Notable gotchas found while deploying (2026-08-04)

These are worth knowing before touching `wrangler.toml` or the Worker's
routing again — each was a real production break, not a hypothetical:

1. **Infinite loop on unmatched paths.** The Worker used to end with
   `return fetch(request)` as a catch-all pass-through. Since the Worker owns
   its own hostname, that re-enters itself on any unmatched path, spinning an
   unbounded subrequest loop that hangs the request and starves the isolate.
   Fixed: unmatched paths now return a plain 404.
2. **`index.html` can't be served at its own path.** Cloudflare's asset server
   treats a file literally named `index.html` as the implicit document for `/`
   and refuses to serve it at `/index.html` directly (307-redirects there,
   which loops given `/` is worker-first). Fixed by renaming the app page to
   `app.html`. Don't reintroduce a file named exactly `index.html` in `public/`.
3. **`html_handling = "none"` trades away clean-URL convenience.** Turning it
   on (default) reintroduces gotcha #2 in a different form: Cloudflare would
   auto-redirect `/app.html` → `/app`, which is worker-first and gated on a
   session check, recreating the same kind of loop. Keeping it `"none"` avoids
   that, but means any bare-word URL (like `/signin` instead of `/signin.html`)
   needs an explicit route added to the Worker by hand — it won't be inferred.
4. **One repo, two Workers.** See §3 — any `wrangler.toml`/Worker change ships
   to both `tce-oauth` and `deskbooking` simultaneously, with no way to target
   just one via this repo.
5. **Apps Script deploys are manual and easy to forget.** See §8 — editor
   changes don't go live until a new deployment version is published. A schema
   mismatch between the editor and the live deployment fails silently (no
   errors, just wrong/empty-looking data), because the API contract isn't
   validated on either side.

## 10. Security status

**Fixed and live (as of 2026-08-04):**
- The three routing/loop bugs in §9.1–9.3.

**Confirmed vulnerabilities, not yet fixed on `main`:**
- 🔴 **Session cookie is unsigned.** Anyone can forge a `tce_session` cookie
  claiming to be any `@thecontentemporium.co.uk` user (verified by testing).
  Fix exists on branch `security/session-signing-and-secret-rotation`
  (HMAC-SHA256 via `crypto.subtle`, constant-time verify) but needs a
  `SESSION_SECRET` Worker secret set before merging.
- 🔴 **Google OAuth client secret (`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`) is
  public** — committed in plaintext across multiple commits of a public GitHub
  repo (also duplicated in dead `worker.js`). Must be treated as compromised
  regardless of any repo-visibility change, since it's already been publicly
  cloneable. **Needs manual rotation in Google Cloud Console** — nothing in
  this repo can do that step. Once rotated, the new value goes into a
  `GOOGLE_CLIENT_SECRET` Worker secret (same pending branch).
- 🟡 **OAuth `state` param isn't validated.** Generated and stored client-side,
  sent to Google, read by the Worker's `/callback`, then discarded — provides
  no actual CSRF protection today. Not yet fixed on any branch.
- 🟡 **Repo visibility.** Was public at least through commit `7c71720`
  (introduces the leaked secret) through the commit that fixed it in code. The
  repo owner needs to flip it to private via GitHub settings — this can't be
  done via the `gh` CLI token available in this environment (lacks admin
  rights on repo settings despite reporting ADMIN permission).

**Not merged, why:** the branch above changes what the Worker *requires* to
function (`GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` must exist as Worker
secrets) with no fallback. Merging before those secrets are set breaks OAuth
token exchange and all session verification immediately — every login and
every `/api` call would fail. Sequence needed: rotate the Google secret →
`wrangler secret put GOOGLE_CLIENT_SECRET` → `wrangler secret put
SESSION_SECRET` (any strong random value, e.g. `openssl rand -base64 32`) →
merge → deploy → verify.

## 11. Quick reference for common changes

- **Add/remove an admin:** edit the `Admins` sheet tab directly (one email per row).
- **Force a Sage refresh outside the weekly schedule:** run `refreshHolidaysFromSage()` once from the Apps Script editor's function dropdown.
- **Change the Sage mirror window** (default: today −7 to +30 days): edit the two `setDate` offsets in `refreshHolidaysFromSage()`.
- **First-time setup after any fresh deploy** (or if load times regress back to "slow after being idle"): run `installCacheWarmingTrigger()` once from the Apps Script editor — installs the 5-minute cache-warming schedule. Safe to re-run.
- **First-time setup for bookings archiving**: run `installBookingsArchiveTrigger()` once — installs the daily archive-old-bookings schedule. Safe to re-run.
- **Look up a booking from before the current week**: check the `ArchivedBookings` tab directly — the app itself doesn't read it.
- **Cache warming interval:** `.everyMinutes(5)` in `installCacheWarmingTrigger()` — valid values are 1, 5, 10, 15, or 30 (Apps Script restriction). Change it, then re-run the function once to apply (it clears the old trigger first).
- **Sage feed URL changed** (e.g. regenerated in Sage HR settings): update the `SAGE_ICS_URL` Script Property (Project Settings > Script Properties) — no code change or redeploy needed, since `getSageIcsUrl()` reads it at call time.
- **Change desk count:** `TOTAL_CORE_DESKS` const in `code.gs`.
- **Change office hours (Glass Box grid):** `OFFICE_START_HOUR`/`OFFICE_END_HOUR`
  in `code.gs`, and `GLASS_HOURS` generation in `app.html`.
- **Rotate the Google OAuth secret:** Google Cloud Console → Credentials →
  regenerate → `wrangler secret put GOOGLE_CLIENT_SECRET` on **both** Workers
  (`tce-oauth` and `deskbooking`, since either could theoretically serve the
  request — in practice only `tce-oauth` uses it today, but keep them in sync).
- **Change which Google account/domain can sign in:** `DOMAIN` const, present
  independently in *both* `tce-oauth-worker.js` and `code.gs` — must be changed
  in both places.
- **Publish a `code.gs` change:** see §8's deploy steps. The `/exec` URL must
  not change unless `APPS_SCRIPT_URL` in `tce-oauth-worker.js` is updated to match.
- **Add a new clean-URL route** (e.g. `/foo` → `foo.html`): add an explicit
  `if (url.pathname === '/foo')` block in `tce-oauth-worker.js`, following the
  existing `/signin` block as a template. Don't rely on `html_handling` to
  infer it — it's deliberately off (§9.3).

## 12. Everything hardcoded, in one place

For a fast "what would I need to change to point this at a different Google
project / domain / spreadsheet" scan:

| Value | Appears in |
|---|---|
| Google OAuth Client ID | `tce-oauth-worker.js`, `signin.html` |
| Google OAuth Client Secret | `tce-oauth-worker.js` (pending: Worker secret instead) |
| OAuth callback URI | `tce-oauth-worker.js` (`CALLBACK_URI`), `signin.html` (`redirect_uri`) — must match a registered redirect URI in Google Cloud Console |
| Allowed email domain | `tce-oauth-worker.js` (`DOMAIN`), `code.gs` (`DOMAIN`) — two independent copies |
| Apps Script `/exec` URL | `tce-oauth-worker.js` (`APPS_SCRIPT_URL`) |
| Spreadsheet ID | `code.gs` (`SHEET_ID`) |
| Glass Box resource calendar ID | `code.gs` (`GLASS_BOX_CALENDAR`) |
| Social calendar ID | `code.gs` (`SOCIAL_CALENDAR_ID`) |
| Sage HR calendar-sync feed URL | **not hardcoded** — Script Property `SAGE_ICS_URL`, read via `getSageIcsUrl()` |
| `deskbooking`/`tce-oauth` hostnames | scattered across `tce-oauth-worker.js`, `signin.html`, `app.html` — see §5's table for exactly which path uses which |
