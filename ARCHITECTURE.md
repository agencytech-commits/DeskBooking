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

Sheet values are sanitized on write (`sanitizeSheetValue`) to stop formula
injection (a name starting with `=+-@` gets a leading `'` so Sheets doesn't
evaluate it) — applied to `Bookings` only (names typed by a signed-in Google
user); `SageEvents` doesn't need it since its content comes from a trusted
internal HR feed, not free-text user input.

**`Bookings` has no retention limit or archiving — this is a known,
currently-unaddressed growth problem.** Every read of it (`getBookingsForRange`,
`getMonthSummary`, `bookDesk`'s own-booking check, `assignDeskForSlot`, etc.)
calls `sheet.getDataRange().getValues()`, which reads *every row ever
written*, then filters to the relevant date range in memory — there's no
partial/indexed read, because Sheets doesn't support one without the rows
already being sorted by date (they're in append order, not date order, since
`bookMyWeek`/admin actions/etc. can append a booking for any date at any
time). This means every operation's cost scales with the sheet's total
row count, not with how much data is actually relevant, and it will keep
getting slower as historical bookings accumulate with no ceiling. Fixing this
properly needs a retention/archiving decision (how far back to keep live,
archive vs. delete outright) that hasn't been made as of 2026-08-04 — not
implemented here without that decision, since it means permanently moving or
removing real booking history.

### Caching

`CacheService.getScriptCache()` (script-wide, shared across all users) fronts
every read path, because a cold Sheets+Calendar round-trip is what caused the
30s timeouts the Worker's `APPS_SCRIPT_TIMEOUT_MS` was later added to guard
against:

| Cache key prefix | What | TTL | Invalidated by |
|---|---|---|---|
| `wk_<mondayOfWeek>` | a week's desk bookings + notes | 90s | any booking write for that week |
| `gb_<mondayOfWeek>` | a week's Glass Box events | 45s | Glass Box book/cancel |
| `ms_<email>_<year-month>` | a user's month summary | 120s | that user's own booking write in that month |
| `soc_<mondayOfWeek>` | social calendar events | 300s | never (rarely changes) |
| `admins` | the admin email list | 600s | never (changes almost never) |

TTLs are a backstop, not the primary freshness mechanism — writes explicitly
invalidate the relevant key so the *actor's own* change is visible immediately;
other users may see a stale cache for up to the TTL.

**This sharing only helps within the TTL window, not across idle periods.**
`CacheService` caps out at 6 hours even if asked for longer, and every TTL
above is far shorter than that (45s–600s) — so after the app sits unused for
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

### Frontend load sequence

`app.html` calls `getAll` first (desks + notes + social events + user prefs;
returns `glassBox: {}` always, deferred on purpose), renders that immediately,
then separately fires `getGlassBox` to fill in the Glass Box grid. If the
second call fails, it fails **silently** (`loadGlassBox()` just returns on
error, no console output) — so an Apps Script hiccup on that specific call
looks identical to "nobody's booked the Glass Box this week," not an error.
Reloading (or switching weeks and back) retries it. `getHolidays` (see below)
has the same silent-failure behavior.

On first page load only, the loader stays up until `refresh()` (desks +
Glass Box), `loadMonthSummary()`, and `loadHolidays()` have all resolved
(`Promise.all`, with a 12s safety backstop that reveals the page regardless
so a hung call can't trap the user) — this avoids widgets popping in one by
one after the loader animation ends. Subsequent week navigation doesn't wait
on Glass Box the same way; it renders cached/desk data immediately and lets
Glass Box fill in a moment later.

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
