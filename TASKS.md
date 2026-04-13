# Tasks

Track progress phase-wise. Each phase builds on the previous one.

---

## Phase 0: Project Setup

- [x] Finalize app name → **shiplog**
- [x] Initialize Bun project with TypeScript (`bun init`)
- [x] Setup React frontend with Bun bundler (`bun build`)
- [x] Configure Tailwind CSS (v4 + @tailwindcss/cli)
- [x] Setup Drizzle ORM + bun:sqlite (schema defined)
- [x] Create project directory structure (as per ARCHITECTURE.md)
- [x] Setup ESLint + Prettier
- [x] Add `bin` entry in package.json for CLI command
- [x] Verify local execution works (`bun link` + `shiplog --version`)

---

## Phase 1: CLI Foundation

- [x] Build CLI entry point (`src/cli/index.ts`)
  - [x] Parse CLI arguments (--from, --to, --repos, --output, --port, --llm)
  - [x] `setup` subcommand — check dependencies + auto-install with selectable prompts
  - [x] `config` subcommand — view, set, interactive edit, reset
- [x] Dependency detection
  - [x] Check if `gh` CLI is installed and authenticated
  - [x] Check if `claude` CLI is available
  - [x] Check if `codex` CLI is available
  - [x] Auto-install with interactive selectable lists
- [x] Configuration management
  - [x] Create `~/.shiplog/` directory on first run
  - [x] Read/write `config.json`
  - [x] Initialize SQLite database (bun:sqlite + Drizzle, WAL mode, 4 tables, 5 indexes)
- [x] Spin up Hono server with Bun native runtime and static file serving
- [x] Open browser via `open` package
- [x] Graceful shutdown (Ctrl+C cleanup, DB connection closed)

---

## Phase 2: GitHub Data Fetching

- [x] List user's repositories via `gh` CLI
  - [x] Personal repos
  - [x] Organization repos
  - [x] Forked repos
- [x] List user's organizations
- [x] Fetch commits in date range for selected repos
  - [x] Handle pagination (repos with many commits)
  - [x] Respect GitHub API rate limits
  - [x] Store raw commit data in SQLite cache
- [x] Fetch PRs in date range
  - [x] Merged PRs
  - [x] Open PRs
  - [x] Closed (unmerged) PRs
  - [x] Map commits to their parent PRs
- [x] Fetch diffs/patches for each commit
  - [x] Handle large diffs gracefully (truncate if needed)
  - [x] Store diffs in SQLite by commit SHA
- [x] Build API routes
  - [x] `GET /api/repos` — return user's repos and orgs
  - [x] `POST /api/contributions` — fetch contributions for params

---

## Phase 3: Deduplication & Grouping

- [x] Compute patch-id for each commit
  - [x] Hash diff content (ignoring whitespace/line numbers)
  - [x] Store patch-id → commit SHA mapping
- [x] Deduplicate commits
  - [x] Identify duplicate patches across branches/forks
  - [x] Keep first-seen commit, link others
- [x] Group commits into logical units
  - [x] PR grouping — link commits to their PRs
  - [x] Orphan detection — identify commits not tied to any PR
  - [x] Orphan clustering:
    - [x] By file path proximity (shared directories)
    - [x] By time proximity (commits within configurable window)
    - [x] Cap groups at ~15-20 commits
- [x] Diff filtering
  - [x] Exclude lock files, generated code, binaries
  - [x] Deprioritize test/config files
  - [x] Apply user-configured exclude patterns

---

## Phase 4: LLM Summarization

- [x] LLM abstraction layer
  - [x] Claude Code integration (`claude -p`)
  - [x] Codex CLI integration (`codex exec`)
  - [x] Auto-detect available provider
  - [x] Fallback handling if neither is available
- [x] Prompt templates
  - [x] PR summary prompt (input: grouped diffs + PR metadata)
  - [x] Orphan group summary prompt (input: clustered commit diffs)
  - [x] Roll-up summary prompt (input: all group summaries)
- [x] Map-Reduce pipeline
  - [x] MAP: Summarize each group in parallel (concurrent CLI calls)
  - [x] REDUCE: Combine group summaries into final roll-up
  - [x] Handle LLM errors/timeouts gracefully
- [x] Cache LLM results
  - [x] Store PR summaries by `repo:pr_number`
  - [x] Store orphan group summaries by `hash(sorted SHAs)`
  - [x] Store roll-up by `hash(underlying summary keys)`
  - [x] Skip LLM call on cache hit
- [x] Build API route
  - [x] `POST /api/summary` — trigger summarization pipeline
  - [x] Stream progress updates to frontend (SSE or polling)

---

## Phase 5: Frontend — Core UI

- [ ] Layout & navigation
  - [ ] App shell with header, sidebar, main content
  - [ ] Dark/light theme support
  - [ ] Responsive design
- [ ] Setup screen (first-run)
  - [ ] Dependency status display (gh, claude/codex)
  - [ ] Link to install instructions
- [ ] Input controls
  - [ ] Date range picker (presets: this week, this month, this quarter, custom)
  - [ ] Repository multi-select with search (grouped by org)
  - [ ] Scope filter checkboxes (merged PRs, open PRs, direct commits, etc.)
  - [ ] "Generate Summary" button
- [ ] Progress indicators
  - [ ] Fetching commits... (with count)
  - [ ] Deduplicating...
  - [ ] Summarizing group X of Y...
  - [ ] Overall progress bar

---

## Phase 6: Frontend — Results Display

- [ ] Summary dashboard
  - [ ] Roll-up summary card (the big picture)
  - [ ] Per-repo expandable sections
  - [ ] Per-PR summary cards with metadata (title, date, status)
  - [ ] Orphan commit group summaries
- [ ] Detail views
  - [ ] Click on PR → show full summary + file list
  - [ ] Click on file → syntax-highlighted diff viewer
  - [ ] Commit timeline visualization
- [ ] Markdown rendering
  - [ ] Render LLM summaries with proper formatting
  - [ ] Code blocks with syntax highlighting
- [ ] Statistics sidebar
  - [ ] Repos touched
  - [ ] PRs (by status)
  - [ ] Files changed
  - [ ] Lines added/removed
  - [ ] Active days

---

## Phase 7: Export & Output

- [ ] Export from Web UI
  - [ ] "Export as Markdown" button → downloads .md file
  - [ ] "Export as HTML" button → downloads styled .html file
  - [ ] "Export as JSON" button → downloads raw data
  - [ ] "Copy to clipboard" for summaries
- [ ] CLI-only output (no browser)
  - [ ] `--output markdown` → print to stdout or file
  - [ ] `--output html` → generate standalone HTML file
  - [ ] `--output json` → structured JSON output
  - [ ] `--no-browser` flag → fetch, summarize, output, exit

---

## Phase 8: Polish & DX

- [ ] Error handling
  - [ ] Friendly error messages for common failures
  - [ ] GitHub rate limit detection and retry with backoff
  - [ ] LLM timeout handling
  - [ ] Network connectivity checks
- [ ] Performance
  - [ ] Concurrent GitHub API requests (with rate limit awareness)
  - [ ] Concurrent LLM calls for map phase
  - [ ] Lazy loading in frontend (don't fetch everything upfront)
  - [ ] SQLite WAL mode for concurrent read/write
- [ ] User experience
  - [ ] Remember last-used settings (date range, repos, scope)
  - [ ] Keyboard shortcuts in web UI
  - [ ] Loading skeletons
  - [ ] Empty states with helpful messages

---

## Phase 9: Distribution & Docs

- [ ] Package distribution
  - [ ] Proper `bin` configuration
  - [ ] Bundle frontend assets into package
  - [ ] Test `bunx <app-name>` works
  - [ ] Test `bun install -g <app-name>` works
  - [ ] Test `npx <app-name>` works (npm compatibility)
- [ ] Documentation
  - [ ] README.md with screenshots/GIFs
  - [ ] Installation instructions
  - [ ] Usage examples
  - [ ] Configuration reference
  - [ ] Contributing guide
- [ ] CI/CD
  - [ ] GitHub Actions for testing
  - [ ] Automated publishing on release (npm + bun compatible)
  - [ ] Version bumping

---

## Phase 10: Nice-to-Haves (Future)

- [ ] Multiple GitHub accounts support
- [ ] GitLab / Bitbucket support
- [ ] Team mode — summarize work for multiple people
- [ ] Compare periods — "Q1 vs Q2"
- [ ] AI-powered categorization (features vs bugs vs refactors)
- [ ] Integration with Notion/Linear/Jira for cross-referencing
- [ ] Shareable HTML reports (self-contained single file)
- [ ] Homebrew formula for macOS distribution
- [ ] Caching invalidation for open PRs (they can still change)
- [ ] Custom LLM prompt templates (user-configurable)
