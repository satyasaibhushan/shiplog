# Architecture

## Overview

A free, open-source CLI tool that spins up a local web UI to show developers **what they actually built** across their GitHub repositories in a given time period. It fetches commits, PRs, and diffs from GitHub, deduplicates them, and uses an LLM (via the user's own Claude Code or Codex CLI) to generate human-readable summaries of the work done.

**No servers. No API keys. No hosting. Everything runs locally.**

---

## Core Flow

```
User runs CLI command
  → Spins up local web server
  → Opens browser at http://localhost:<port>
  → User selects date range, repos, scope
  → Fetches GitHub data via `gh` CLI
  → Deduplicates commits by patch-id
  → Groups into PRs + orphan clusters
  → Summarizes via `claude` or `codex` CLI (map-reduce)
  → Displays rich, interactive summary in browser
```

---

## Tech Stack

### CLI & Server

| Component       | Technology                | Why                                                    |
| --------------- | ------------------------- | ------------------------------------------------------ |
| Language        | TypeScript (Node.js)      | Fast to build, npm distribution, strong ecosystem      |
| Package Manager | pnpm                      | Fast, disk-efficient                                   |
| Build Tool      | tsup                      | Zero-config TypeScript bundler for CLI tools            |
| Server          | Hono + @hono/node-server  | Ultra-lightweight (20k+ req/s), minimal overhead       |
| Browser Launch  | `open` package            | Cross-platform default browser opening                 |

### Frontend (Local Web UI)

| Component          | Technology                    | Why                                           |
| ------------------ | ----------------------------- | --------------------------------------------- |
| Framework          | React 19 + Vite               | Fast HMR, modern tooling                      |
| Styling            | Tailwind CSS                  | Rapid UI development                          |
| Date Range Picker  | react-day-picker              | Lightweight, accessible                       |
| Syntax Highlighting| react-syntax-highlighter      | Prism-based, wide language support             |
| Markdown Rendering | react-markdown + remark       | Render LLM summaries beautifully              |
| Charts/Timeline    | recharts                      | Simple, composable timeline visualizations     |
| Icons              | lucide-react                  | Clean, consistent icon set                    |

### Data & Caching

| Component | Technology                   | Why                                              |
| --------- | ---------------------------- | ------------------------------------------------ |
| Database  | SQLite via better-sqlite3    | Zero setup, local file, synchronous (fast)       |
| ORM       | Drizzle ORM                  | Type-safe queries, lightweight, great migrations  |
| Location  | `~/.gitrecap/cache.sqlite`   | User's home directory, persists across runs       |

### External Dependencies (User's Machine)

| Tool         | Purpose                        | Required? |
| ------------ | ------------------------------ | --------- |
| `gh` CLI     | GitHub API access (user's auth)| Yes       |
| `claude` CLI | LLM summarization              | One of    |
| `codex` CLI  | LLM summarization              | these     |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                   User's Machine                     │
│                                                      │
│  ┌──────────────┐     ┌──────────────────────────┐  │
│  │   CLI Entry   │────▸│   Hono Server (:port)    │  │
│  │  (bin/cli.ts) │     │                          │  │
│  └──────────────┘     │  ┌────────────────────┐  │  │
│                        │  │   React Frontend   │  │  │
│                        │  │   (bundled static)  │  │  │
│                        │  └────────┬───────────┘  │  │
│                        │           │ API calls     │  │
│                        │  ┌────────▼───────────┐  │  │
│                        │  │   API Routes        │  │  │
│                        │  │   /api/repos        │  │  │
│                        │  │   /api/contributions│  │  │
│                        │  │   /api/summary      │  │  │
│                        │  └────────┬───────────┘  │  │
│                        └───────────┼──────────────┘  │
│                                    │                  │
│         ┌──────────────────────────┼───────────┐     │
│         │              │           │            │     │
│    ┌────▼─────┐  ┌─────▼────┐ ┌───▼──────┐         │
│    │  gh CLI  │  │  claude/  │ │  SQLite  │          │
│    │ (GitHub) │  │  codex    │ │  Cache   │          │
│    └──────────┘  └──────────┘ └──────────┘          │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## Data Flow

### 1. GitHub Data Fetching

```
gh api → REST/GraphQL endpoints
  → List user's repos & orgs
  → Fetch commits in date range
  → Fetch PRs (merged/open/closed based on scope)
  → Fetch diffs for each commit
```

### 2. Deduplication Pipeline

```
Raw commits (may include duplicates from branches/cherry-picks)
  → Compute patch-id for each commit (hash of diff content)
  → Deduplicate: one entry per unique patch-id
  → Store in SQLite: commit SHA, patch-id, diff, metadata
```

### 3. Grouping Strategy

```
Deduplicated commits
  ├── Linked to a PR → Group under PR
  └── Orphaned → Cluster by:
        1. File path proximity (same directory)
        2. Time proximity (commits within hours)
        3. Cap at ~15-20 per group
```

### 4. LLM Summarization (Map-Reduce)

```
MAP phase (parallel):
  ├── PR Group 1 → claude/codex → summary_1
  ├── PR Group 2 → claude/codex → summary_2
  ├── Orphan Cluster A → claude/codex → summary_3
  └── Orphan Cluster B → claude/codex → summary_4

REDUCE phase:
  └── All summaries → claude/codex → Final roll-up summary
```

### 5. Diff Filtering (Before LLM)

Excluded from LLM input:
- `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
- `*.lock` files
- Generated code (`.gen.ts`, `.generated.*`)
- Binary files
- Files over a configurable size threshold

Deprioritized (summarized by reference):
- Test files (`*.test.*`, `*.spec.*`)
- Config files (`.eslintrc`, `tsconfig.json`)

Prioritized:
- Source code in `src/`, `lib/`, `app/`, etc.

---

## Caching Architecture

### Two-Layer Cache (SQLite)

```
Layer 1: Commit Cache (raw GitHub data, never expires)
┌─────────────────────────────────────────────────┐
│ commit_sha (PK) │ patch_id │ diff │ files │ ... │
└─────────────────────────────────────────────────┘

Layer 2: Summary Cache (LLM output, never expires)
┌───────────────────────────────────────────────────┐
│ content_hash (PK) │ summary_type │ summary │ ...  │
│                    │ (pr/orphan/  │         │      │
│                    │  rollup)     │         │      │
└───────────────────────────────────────────────────┘

Dedup Index:
┌──────────────────────────────┐
│ patch_id (PK) │ commit_sha   │
│               │ (first seen) │
└──────────────────────────────┘
```

### Cache Key Strategy

| Cache Level        | Key                                     | Immutable? |
| ------------------ | --------------------------------------- | ---------- |
| Commit diff        | `commit SHA`                            | Yes        |
| Dedup index        | `patch-id`                              | Yes        |
| PR summary         | `repo:pr_number`                        | Yes (merged)|
| Orphan group       | `hash(sorted commit SHAs in group)`     | Yes        |
| Roll-up summary    | `hash(sorted underlying summary keys)`  | Yes        |

---

## User Scope Filters

```
Contribution Scope (user-configurable):
  ☑ Merged PRs           — completed, shipped work
  ☐ Open PRs             — work in progress
  ☐ Closed (unmerged) PRs — abandoned/rejected work
  ☐ Direct commits       — pushes without a PR
  ☐ Fork branches        — code not yet PR'd
```

---

## LLM Integration

### Provider Detection (Priority Order)

```
1. claude CLI detected? → Use Claude Code
2. codex CLI detected?  → Use Codex
3. Neither?             → Prompt user to install or provide API key
```

### Invocation

```bash
# Claude Code
echo "<diffs>" | claude -p "Summarize these code changes..."

# Codex CLI
echo "<diffs>" | codex exec "Summarize these code changes..."
```

### Prompt Design

The prompts should instruct the LLM to:
- Focus on WHAT was built/changed, not line counts
- Categorize changes (feature, bugfix, refactor, docs, etc.)
- Use plain English, not code jargon
- Be concise but specific
- Reference file paths and function names where relevant

---

## Project Structure

```
├── package.json
├── tsconfig.json
├── ARCHITECTURE.md
├── TASKS.md
│
├── src/
│   ├── cli/                    # CLI entry point & commands
│   │   ├── index.ts            # Main CLI entry (bin)
│   │   ├── setup.ts            # First-run setup & dependency checks
│   │   └── config.ts           # User configuration management
│   │
│   ├── server/                 # Hono API server
│   │   ├── index.ts            # Server setup & static file serving
│   │   └── routes/
│   │       ├── repos.ts        # GET /api/repos — list user's repos
│   │       ├── contributions.ts # POST /api/contributions — fetch & process
│   │       └── summary.ts      # POST /api/summary — trigger summarization
│   │
│   ├── core/                   # Business logic
│   │   ├── github.ts           # GitHub data fetching via gh CLI
│   │   ├── dedup.ts            # Patch-id deduplication
│   │   ├── grouping.ts         # PR grouping + orphan clustering
│   │   ├── filter.ts           # Diff filtering (lock files, generated, etc.)
│   │   ├── summarizer.ts       # LLM integration (claude/codex abstraction)
│   │   └── cache.ts            # SQLite caching layer
│   │
│   ├── db/                     # Database
│   │   ├── schema.ts           # Drizzle schema definitions
│   │   └── migrations/         # Drizzle migrations
│   │
│   └── web/                    # React frontend (Vite)
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── DateRangePicker.tsx
│       │   ├── RepoSelector.tsx
│       │   ├── ScopeFilter.tsx
│       │   ├── ContributionSummary.tsx
│       │   ├── PRCard.tsx
│       │   ├── DiffViewer.tsx
│       │   └── ExportButton.tsx
│       ├── hooks/
│       │   └── useContributions.ts
│       └── styles/
│           └── globals.css
│
├── prompts/                    # LLM prompt templates
│   ├── pr-summary.txt
│   ├── orphan-summary.txt
│   └── rollup-summary.txt
│
└── tests/
    ├── core/
    └── server/
```

---

## Output Formats

| Format   | How                                          |
| -------- | -------------------------------------------- |
| Web UI   | Default — interactive dashboard in browser   |
| Markdown | `--output markdown` or export button in UI   |
| HTML     | `--output html` or export button in UI       |
| JSON     | `--output json` for programmatic consumption |

---

## Configuration

Stored at `~/.gitrecap/config.json`:

```json
{
  "llm": "claude",
  "defaultScope": ["merged-prs", "direct-commits"],
  "excludePatterns": ["*.lock", "*.generated.*"],
  "port": 3847,
  "theme": "dark"
}
```

---

## Rate Limits & Constraints

| Constraint                          | Mitigation                                  |
| ----------------------------------- | ------------------------------------------- |
| GitHub API: 5,000 req/hr            | Cache aggressively, batch requests          |
| GitHub GraphQL: 5,000 points/hr     | Use pagination, respect rate limit headers  |
| LLM context window                  | Cap groups at ~15-20 commits, filter diffs  |
| Large repos (1000+ commits/quarter) | Stream processing, progress indicators      |
| contributionsCollection: 1yr max    | Batch into yearly chunks for longer ranges  |
