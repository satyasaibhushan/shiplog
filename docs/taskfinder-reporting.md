# Task Finder reporting bridge and calendar periods

This is a reporting projection into Shiplog's existing log/version/rollup store. Task Finder remains the task and inbox authority. No new task database, network destination, scheduler, credentials, live ingestion, model call, or task execution is introduced by the snapshot mode.

## Offline snapshot reports

Prepare an explicitly reviewed JSON snapshot by combining Task Finder's `/api/tasks` and `/api/projects` response arrays with the envelope below. This implementation does not fetch those endpoints. A caller must supply a stable instance ID to distinguish different Task Finder installations.

```json
{
  "schemaVersion": 1,
  "source": {
    "instanceId": "my-taskfinder",
    "capturedAt": "2026-09-30T12:00:00Z",
    "coverage": "partial"
  },
  "projects": [],
  "tasks": []
}
```

The checked-in [synthetic snapshot](../tests/fixtures/taskfinder-synthetic.json) exercises the contract without confidential work data. Task/project IDs, source URLs, occurrence dates, actor and caveat fields are retained in version metadata and markdown. Projects have one primary stream; overlap links do not add counts. Unknown project IDs and duplicate task/project/evidence IDs are rejected.

Optional task-level `attribution` distinguishes `personal`, `team`, and `unknown`, with a `basis` and `contributors`. A task owner is not evidence of individual contribution. Optional `metrics` carry `name`, nullable `value`, `unit`, `verification` (`verified`, `reported`, `unknown`) and `evidenceIds`. A claimed verified metric requires a non-null value and referenced evidence. These are supplied assertions, never independent verification by Shiplog. No business-impact metric is inferred from diff size, task status or PR merge.

```sh
# Existing storage locations are used unless explicitly overridden.
bun src/cli/index.ts report --daily \
  --taskfinder-snapshot reviewed-snapshot.json --author you@example.test \
  --timezone Asia/Kolkata --at 2026-09-30T18:31:00Z

# Aggregate active daily log versions already stored; no source fetch or model.
bun src/cli/index.ts report --weekly \
  --taskfinder-instance my-taskfinder --author you@example.test \
  --timezone Asia/Kolkata --at 2026-10-01T12:00:00Z
bun src/cli/index.ts report --monthly \
  --taskfinder-instance my-taskfinder --author you@example.test \
  --timezone Asia/Kolkata --at 2026-10-01T12:00:00Z --output json
```

Snapshot mode executes before configuration-driven sync/provider setup, so it never initializes, pulls, or pushes a configured sync remote. The report author scopes report identity; it does not establish contribution attribution. Markdown is default; JSON exposes stable entity IDs, active version IDs, source references and the window. Validation errors preserve existing reports.

Direct snapshot reports can use daily/weekly/monthly windows. `--taskfinder-instance` aggregates stored **daily** reports into weekly/monthly reports. Missing days remain unknown. Each daily source log and selected active version is referenced. Repeated context is not counted as multiple tasks, and metrics are deliberately not summed. Chat-edited active daily versions remain eligible through provenance retained in generated version history.

## Calendar semantics

- Default report timezone: **Asia/Kolkata**. Explicit `--timezone UTC` is also supported. Other timezones are rejected rather than silently applying an incorrect fixed offset.
- Daily: local midnight to next midnight. Weekly: Monday through Sunday, including cross-year weeks. Monthly: the full calendar month, including leap February.
- Windows use `[startInclusive, endExclusive)` UTC instants internally and inclusive local date labels. A timestamp exactly at Kolkata midnight belongs only to the new day.
- `--at` is a reproducible reference instant, not a scheduled execution. Snapshot mode requires an explicit ISO offset when provided.
- Current periods may be incomplete. Reports label coverage and retain the snapshot capture date. The active-work section is current snapshot context, not a reconstruction of historical statuses or calendar commitments.
- GitHub CLI reports now also accept `--monthly` and the timezone option. Existing HTTP log calls keep UTC semantics unless an internal caller supplies a timezone. Source requests receive UTC timestamp bounds; these requests were mock-tested, not live verified.

## Identity, versions and active summaries

New GitHub reports derive entity IDs from repository, author, period/window and scope. New Task Finder logs derive IDs from instance, project, author and period. Snapshot rollup identity is instance + author + weekly/monthly period, so adding daily logs updates membership instead of creating another period entity.

Identical generated content/provenance reuses the active version. Changed content or source active versions append a new version. Existing random-ID records are untouched: there is no backfill or dedup migration against user storage. Requests in one process coalesce identical in-flight work. As with the existing datastore, concurrent writers in separate processes are not coordinated; use one report writer per datastore.

`generateLog` and `generateRollup` now return the refreshed record after activation. Rollups re-read each log's actual active pointer, deduplicate input log IDs, reject empty/missing active input, and cache by active source version IDs. This fixes the pre-activation result bug that could omit freshly generated logs. Existing web and HTTP entry points continue using the shared pipeline.

## Validation

Cloud-only commands (Bun 1.4.2 installed into a temporary tool directory):

```sh
bun install --frozen-lockfile
bun test
bun run check
```

95 tests pass, including repeated and concurrent identical snapshot requests, changed content versioning, active-version selection/reversion, period membership expansion, timezone boundary, month/year rollover, duplicate rejection, mock source/model aggregation, and offline CLI subprocesses. `bun run check` runs type-check, lint and frontend/CSS builds. One existing config test was corrected to use `SHIPLOG_CONFIG_DIR` rather than relying on changing HOME, which Bun's homedir lookup did not honor in this cloud environment.

[Full test output](evidence/reporting/tests.txt) · [Check output](evidence/reporting/check.txt) · [Synthetic daily sample](evidence/reporting/synthetic-daily.md) · [Synthetic monthly sample](evidence/reporting/synthetic-monthly.md)

## Limits and next steps

This does not produce or backfill the requested VMock career history from August 1, 2022. Historical evidence collection is a separate project; import only reviewed records with explicit coverage, personal/team attribution, verified metrics versus unknowns, and source links. No confidential career report is included in the repository.

The existing Atlas UI can read persisted reports; no new UI is introduced here. No UI/native screenshot is claimed for this backend/CLI change. Live GitHub/Task Finder access, LLM providers and full career coverage were not exercised. Scheduled execution, automated snapshot collection, historical task-state reconstruction, and storage synchronization remain deferred. No production deployment, user-storage migration, or merge was performed.

## Correctness review fixes

- GitHub summary timelines use the requested reporting timezone for both commit and PR dates. Group and rollup cache identities include timezone semantics; an October 1 Kolkata report places `2026-09-30T18:30:00Z` on October 1 in persisted timelines and downstream prompts.
- Metrics appear only in current snapshot context, with supporting evidence links and occurrence dates (or an explicit unknown support date). They never imply impact in an earlier historical event window.
- Both rollup paths capture active source version IDs before coalescing. Changed versions start a separate request; source membership/pointers are checked again at activation after persistence. Superseded generation rejects with a retry message instead of replacing the newer active output or clearing its stale marker. Selecting/chat-editing a log's active version marks dependent rollups stale.
- Empty project IDs reject validation; omitted project IDs retain tasks in Unassigned.
- CI now runs `bun test` alongside existing lint, typecheck, and builds. Review validation: **95 tests, 0 failures**, including a controlled delayed old generation after newer source activation, plus `bun run check`. See [review tests](evidence/reporting/review-tests.txt) and [review checks](evidence/reporting/review-check.txt).

The residual orphan prompt date issue is also covered: actual ordinary, overview, and expanded model prompts are captured with a mock invocation boundary for UTC and Asia/Kolkata. All use local calendar dates for the single-commit midnight case even when the one-day timeline is omitted. Group cache semantics are bumped to invalidate prior misdated summaries. Final validation: 95 tests, 250 assertions, and full check pass.
