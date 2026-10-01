# Private hosted Shiplog

This optional Next.js application runs on Vercel's Node runtime. The existing Bun CLI, local UI, SQLite cache and filesystem history remain unchanged. Hosted mode is a **snapshot reporting projection**, not a new task store or a hosted replacement for every local feature.

Hosted mode provides owner-only Google sign-in, reviewed Task Finder JSON import, daily/weekly/monthly calendar reports, a report list, immutable versions and historical version reading. It shares the existing snapshot validation, deterministic rendering and IANA calendar code. It does not invoke `gh`, ModelBridge, sync, cron, source ingestion, task acceptance or task execution. Monthly/weekly reports here render the supplied snapshot; they do not aggregate local CLI daily versions. Local report history is not automatically uploaded.

## Existing-account deployment prerequisites

Create/import the `satyasaibhushan/shiplog` repository as a Vercel project in the intended existing account, using the repository root. `vercel.json` chooses Next.js and `bun run build:hosted`; local `bun run build` retains its old meaning. Use Node 24 and the committed lockfile. No paid plan or new database allocation is implied.

Required encrypted runtime environment variables (never put values in GitHub/PR text):

| Name | Purpose |
| --- | --- |
| `OWNER_EMAIL` | The only allowed verified Google account. Generic configuration, no email hardcoded. |
| `APP_URL` | Exact HTTPS canonical origin, without trailing slash; POST origin allowlist. |
| `AUTH_URL` | Same canonical origin for Auth.js. |
| `AUTH_SECRET` | Dedicated high-entropy application session secret. Requires approved secure creation/configuration. |
| `AUTH_GOOGLE_ID` | Approved Google OAuth web client ID. |
| `AUTH_GOOGLE_SECRET` | That client's secret. |
| `SHIPLOG_DATABASE_URL` | Existing approved Neon PostgreSQL connection for report storage. Never inferred from another app. |
| `REPORT_TIMEZONE` | Optional IANA zone; default UTC. Calendar inputs can override it. |

Google's authorized redirect URI must be `https://<approved-shiplog-domain>/api/auth/callback/google`. Reusing Task Finder's OAuth client requires explicit approval for this additional callback; do not silently widen OAuth access or copy work credentials. Preview domains should not get production report access by default. Use a separate approved preview database/OAuth callback or leave preview signed-out; the build requires no runtime credentials.

## Database setup and recovery

Confirm the exact database/branch/role before any mutation. Confirm provider backup/PITR or take an approved backup. Apply `hosted/migrations/001-private-reports.sql` explicitly; it adds only two namespaced reporting tables. It is rerunnable and does not alter Task Finder's tables or the local datastore. No DDL executes on startup or during build. Do not run SQLite `db:migrate` against the hosted database.

The PostgreSQL adapter uses Neon HTTP transactions. Report identity includes owner, source instance, employer/context scope and canonical calendar window. A row lock plus expected revision handles writes across serverless instances. Identical active-payload retries reuse the same version; an edited or late stale write receives 409. The browser retains its upload and requires explicit review of the current revision before appending. A transaction failure cannot leave a partial active report. All reads and writes include owner scope; owner configuration changes do not transfer old history.

Rollback the application to the prior deployment and retain both tables. Never drop report history as an application rollback. The initial migration does not transform existing data; restoration of report data uses the confirmed backup procedure. An actual provider backup/restore and live Neon connection are deployment prerequisites, not verified by isolated tests.

## Privacy and operational boundaries

Every report route verifies the owner session before opening storage. Google email must be verified. Missing/wrong owner is denied; unauthorized reads/writes return 401. Writes require the exact configured origin; payloads are limited to 1 MiB and rendered reports to 3 MiB. Report responses are private/no-store. Uploaded Markdown is escaped by the shared renderer and displayed without raw HTML execution. No report body or credential is logged on failure.

The hosted UI lists the latest 200 reports and displays the latest 200 version choices per report; older stored versions remain addressable by revision. No deletion or automatic retention cleanup is implemented. Cloud reports are not edited by the local CLI; the local and hosted stores remain separate report projections, linked to the same Task Finder IDs. This does not duplicate canonical tasks.

Production verification after review: sign in with the approved owner, confirm another account is refused, check report API isolation, import one reviewed scoped snapshot, retry it, inspect historical version preservation, and verify persistence across redeployment. Only then import real owner data. Do not schedule runs or enable paid model providers as part of this adapter deployment.

## Validation

`bun test` includes actual isolated PostgreSQL SQL/transaction tests through PGlite: concurrent competing writers, identical retries, rollback, separate adapter instances, owner isolation, immutable versions, repeatable migration, HTTP auth/origin rejection and calendar boundaries. `bun run check`, `bun run typecheck:hosted` and `bun run build:hosted` validate both modes. CI executes both builds.

`CHROMIUM_PATH=/usr/bin/chromium bun run tests/hosted/verify-browser.ts` exercises the real Dashboard and HTTP/storage handlers with an explicitly synthetic owner session and isolated PGlite. It covers interrupted responses, edited retry/revision acceptance, old-version reading and mobile layout. It is not a live Google OAuth or Neon test. Separately, an actual production Next server was checked for its public sign-in page and private unauthenticated report API responses without database credentials. See `docs/evidence/hosted/`.
