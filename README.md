# shiplog

A free, open-source CLI tool that shows you **what you actually built** across your GitHub repositories. It fetches commits, PRs, and diffs, deduplicates them, and uses an LLM (Claude or Codex) to generate human-readable summaries.

**No servers. No API keys. No hosting. Everything runs locally.**

## Quick Start

> shiplog is not published to npm yet (the `shiplog` package on npm is an
> unrelated project) — install from source:

```bash
git clone https://github.com/satyasaibhushan/shiplog
cd shiplog
bun install
bun run build:all
bun link          # registers a global `shiplog` command

shiplog
```

This opens a local web UI at `http://localhost:3847` where you can select date ranges, repositories, and generate AI summaries.

## Prerequisites

| Tool | Purpose | Required? |
|------|---------|-----------|
| [Bun](https://bun.sh) | Runtime | Yes |
| [`gh` CLI](https://cli.github.com) | GitHub API access | Yes |
| [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) | AI summarization | One of these |
| [`codex` CLI](https://github.com/openai/codex) | AI summarization | |

```bash
# Check your setup
shiplog setup
```

## Usage

### Web UI (default)

```bash
shiplog                          # Opens browser at localhost:3847
shiplog --port 8080              # Custom port
shiplog --no-browser             # Start server without opening browser
```

### Reports (persisted)

`shiplog report` runs the full pipeline for each repo, **saves** a log per
repo (plus a rollup across them) so everything shows up in the web UI, and
prints a project-wise markdown report to stdout. This is the building block
for scheduled daily/weekly routines — point a cron job or a Claude/Codex
routine at it:

```bash
# Set the repos to track once
shiplog config trackedRepos owner/repo1,owner/repo2

shiplog report --daily                       # today's work
shiplog report --weekly                      # last 7 days
shiplog report -f 2024-01-01 -t 2024-03-31   # any range, project-wise

# One-off overrides
shiplog report --weekly -r owner/other-repo --title "Sprint 42"
shiplog report --daily -o json > report.json
```

Repos with no activity in the range are skipped. A rollup (the cross-project
overview) is only created when two or more repos had activity.

### Headless CLI (one-off, nothing saved)

Generate a report without a browser and without persisting anything:

```bash
# Markdown output
shiplog -o markdown -r owner/repo -f 2024-01-01 -t 2024-03-31

# JSON output (pipe to file)
shiplog -o json -r repo1,repo2 -f 2024-01-01 -t 2024-03-31 > report.json

# Standalone HTML report
shiplog -o html -r owner/repo -f 2024-01-01 -t 2024-03-31 > report.html
```

### Options

```
-f, --from <date>        Start date (YYYY-MM-DD, default: 30 days ago)
-t, --to <date>          End date (YYYY-MM-DD, default: today)
-r, --repos <repos>      Comma-separated repo list (owner/repo)
-o, --output <format>    Output: web, markdown, html, json
-p, --port <number>      Server port (default: 3847)
--llm <provider>         LLM: auto, claude, codex
--no-browser             Don't open browser
-h, --help               Show help
-v, --version            Show version
```

### Configuration

Settings are stored at `~/.shiplog/config.json`:

```bash
shiplog config                      # View current config
shiplog config llm claude           # Set LLM provider
shiplog config port 8080            # Set server port
shiplog config --reset              # Reset to defaults
```

| Key | Values | Default |
|-----|--------|---------|
| `llm` | `auto`, `claude`, `codex` | `auto` |
| `port` | `1-65535` | `3847` |
| `theme` | `dark`, `light` | `dark` |
| `defaultScope` | comma-separated | `merged-prs,direct-commits` |
| `excludePatterns` | comma-separated globs | `*.lock,*.generated.*` |
| `trackedRepos` | comma-separated `owner/repo` | (empty) |

## Vision & Roadmap

shiplog is growing from a summary generator into a complete, curated record of
engineering work:

1. **A career-long work log.** Backfill and maintain a log of everything built
   over the last 4 years across company repositories. Each log entry accepts
   review comments, so summaries can be regenerated until the output matches
   what actually happened — the log is curated, not just generated.

2. **Automated reporting routines.** Scheduled Claude/Codex routines generate
   a report every day and every week covering what shipped in that window —
   no manual triggering.

3. **Timerange reports, project-wise.** Given any date range, produce a report
   of all work done in that range, grouped by project — for reviews, appraisal
   cycles, or handoffs.

4. **Task Finder integration.** [Task Finder](https://github.com/satyasaibhushan/Task-Finder)
   is a companion desktop app that aggregates work items from Jira, Gmail, and
   Slack into one prioritized task list. Syncing shiplog task-wise against it
   captures the work GitHub never sees — client tickets, one-off data requests —
   and gives the code produced across repos its business context.

> **Persistence — decision deferred.** Everything currently lives in plain
> local files: JSON entities under `~/.shiplog-data/` plus the SQLite cache at
> `~/.shiplog/cache.sqlite`. There is no git sync or remote datastore. A
> proper datastore (durable journal vs disposable cache, backup story) will be
> chosen once the reporting workflows above have settled — the file layout is
> good enough until then.

## How It Works

```
You run shiplog
  → Fetches your GitHub repos via `gh` CLI
  → You select date range, repos, scope
  → Fetches commits + PRs + diffs
  → Deduplicates by patch-id (catches cherry-picks)
  → Groups into PR groups + orphan clusters
  → Summarizes each group via LLM (map phase)
  → Creates roll-up summary (reduce phase)
  → Displays interactive results in browser
```

### Caching

All data is cached in `~/.shiplog/cache.sqlite`:

- **Commit diffs** are cached by SHA (immutable, never re-fetched)
- **LLM summaries** are cached by content hash (skips LLM on repeat runs)
- Re-running the same query is near-instant after the first run

### Scope Filters

| Scope | What it includes |
|-------|-----------------|
| Merged PRs | Completed, shipped work |
| Open PRs | Work in progress |
| Closed PRs | Abandoned / rejected PRs |
| Direct commits | Pushes not part of any PR |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Server | Hono |
| Frontend | React 19 + Tailwind CSS v4 |
| Database | SQLite (bun:sqlite) + Drizzle ORM |
| Charts | Recharts |
| External | `gh` CLI, `claude`/`codex` CLI |

## Development

```bash
git clone <repo-url>
cd shiplog
bun install

# Build the frontend (use build:all, not build)
bun run build:all

# Run in dev mode
bun run start          # or: bun run dev (hot reload)
```

> **Build the web assets with `bun run build:all`, not `bun run build`.**
> `build` only emits `main.js` and `styles.css`; `build:all` also copies
> `index.html` into `dist/web/`. The server serves the UI from
> `dist/web/index.html`, so without it the page returns `404 Not Found`.
> Note that `dev`/`start` do **not** rebuild assets — re-run `build:all`
> after changing anything under `src/web/`.

### Running from source

The `setup`, `config`, and `sync` commands in this README assume shiplog is
installed globally. When running from a cloned repo, pass the subcommand
through the `start` script instead:

```bash
bun run start setup            # = shiplog setup
bun run start config llm codex # = shiplog config llm codex
```

To use the `shiplog` command directly, link the package globally:

```bash
bun link                       # registers a global `shiplog` -> ./src/cli/index.ts
```

If you then get `zsh: command not found: shiplog`, bun's global bin directory
isn't on your `PATH`. Add it to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

Then reload your shell (`source ~/.zshrc`) or open a new terminal.

## License

MIT
