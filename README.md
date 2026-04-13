# shiplog

A free, open-source CLI tool that shows you **what you actually built** across your GitHub repositories. It fetches commits, PRs, and diffs, deduplicates them, and uses an LLM (Claude or Codex) to generate human-readable summaries.

**No servers. No API keys. No hosting. Everything runs locally.**

## Quick Start

```bash
# Install globally
bun install -g shiplog

# Or run directly
bunx shiplog
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

### Headless CLI

Generate reports without a browser:

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

# Build frontend
bun run build:all

# Run in dev mode
bun run start
```

## License

MIT
