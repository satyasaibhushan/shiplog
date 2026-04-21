// Adapter: merge /api/repos + /api/atlas into repo-oriented rows the UI needs.
// The prototype treats each row as { id, name, owner, logs: [...] }, so we
// build that shape here and derive display fields (langColor, lastPush, etc.).

import type {
  AtlasResponse,
  LogRecord,
  Repo,
  ReposResponse,
} from "./types.ts";
import { fmtRelative, langColor } from "./theme.ts";

export interface DisplayLog extends LogRecord {
  label: string;
  range: [string, string];
  add: number;
  rem: number;
  prs: number;
  commits: number;
  isNew: boolean;
}

export interface DisplayRepo {
  id: string; // owner/repo
  name: string; // owner/repo
  owner: string;
  short: string; // repo
  org: string; // owner
  description?: string;
  lang?: string;
  langColor: string;
  lastPush: string;
  firstSeen?: string;
  totalLogs: number;
  logs: DisplayLog[];
  _raw?: Repo;
}

export interface DisplayOrg {
  id: string;
  name: string;
  avatar: string;
  repoIds: string[];
}

export interface AtlasModel {
  repos: DisplayRepo[];
  orgs: DisplayOrg[];
  rollups: AtlasResponse["rollups"];
  username?: string;
}

function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
}

function deriveLabel(log: LogRecord, _allLogsForRepo: LogRecord[]): string {
  if (log.title) return log.title;
  const start = new Date(log.rangeStart);
  const end = new Date(log.rangeEnd);
  const days = Math.round(
    (end.getTime() - start.getTime()) / 86400000,
  );
  const sameMonth =
    start.getMonth() === end.getMonth() &&
    start.getFullYear() === end.getFullYear();
  if (sameMonth && days >= 25) {
    return start.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  }
  const q = Math.floor(start.getMonth() / 3) + 1;
  if (days >= 80 && days <= 100) {
    return `Q${q} ${start.getFullYear()}`;
  }
  if (days >= 5 && days <= 8) {
    return `Week ${isoWeekNumber(start)}`;
  }
  return "Log";
}

function buildDisplayLog(
  log: LogRecord,
  allLogsForRepo: LogRecord[],
): DisplayLog {
  const stats = log.stats ?? null;
  const now = Date.now();
  const isNew = now - log.updatedAt < 48 * 3600 * 1000;
  return {
    ...log,
    label: deriveLabel(log, allLogsForRepo),
    range: [log.rangeStart, log.rangeEnd],
    add: stats?.additions ?? 0,
    rem: stats?.deletions ?? 0,
    prs: stats?.prs ?? 0,
    commits: stats?.commits ?? 0,
    isNew,
  };
}

export function buildAtlasModel(
  repos: ReposResponse | null,
  atlas: AtlasResponse | null,
): AtlasModel {
  const byKey = new Map<string, DisplayRepo>();
  const orgsById = new Map<string, DisplayOrg>();

  // Seed repos from /api/repos
  if (repos) {
    for (const r of repos.repos) {
      const id = r.fullName;
      byKey.set(id, {
        id,
        name: r.fullName,
        owner: r.owner,
        short: r.name,
        org: r.owner,
        description: r.description,
        lang: r.language,
        langColor: langColor(r.language),
        lastPush: fmtRelative(r.updatedAt),
        totalLogs: 0,
        logs: [],
        _raw: r,
      });
    }
    for (const org of repos.orgs) {
      for (const r of org.repos) {
        const id = r.fullName;
        byKey.set(id, {
          id,
          name: r.fullName,
          owner: r.owner,
          short: r.name,
          org: r.owner,
          description: r.description,
          lang: r.language,
          langColor: langColor(r.language),
          lastPush: fmtRelative(r.updatedAt),
          totalLogs: 0,
          logs: [],
          _raw: r,
        });
      }
    }
  }

  // Overlay atlas logs — also creates synthetic repo rows for logs whose
  // owner/repo doesn't match any GitHub repo the user currently has access to.
  if (atlas) {
    const bucket = new Map<string, LogRecord[]>();
    for (const log of atlas.logs) {
      const key = `${log.owner}/${log.repo}`;
      const arr = bucket.get(key) ?? [];
      arr.push(log);
      bucket.set(key, arr);
    }
    for (const [key, logs] of bucket) {
      const [owner = "", short = ""] = key.split("/");
      let repo = byKey.get(key);
      if (!repo) {
        repo = {
          id: key,
          name: key,
          owner,
          short,
          org: owner,
          langColor: langColor(undefined),
          lastPush: fmtRelative(
            new Date(Math.max(...logs.map((l) => l.updatedAt))).toISOString(),
          ),
          totalLogs: 0,
          logs: [],
        };
        byKey.set(key, repo);
      }
      const display = logs.map((l) => buildDisplayLog(l, logs));
      repo.logs = display;
      repo.totalLogs = display.length;
    }
  }

  // Build orgs from repos
  if (repos) {
    if (repos.username) {
      orgsById.set(repos.username, {
        id: repos.username,
        name: repos.username,
        avatar: repos.username.slice(0, 1).toUpperCase(),
        repoIds: [],
      });
    }
    for (const o of repos.orgs) {
      orgsById.set(o.login, {
        id: o.login,
        name: o.login,
        avatar: o.login.slice(0, 1).toUpperCase(),
        repoIds: [],
      });
    }
    for (const repo of byKey.values()) {
      let org = orgsById.get(repo.owner);
      if (!org) {
        org = {
          id: repo.owner,
          name: repo.owner,
          avatar: repo.owner.slice(0, 1).toUpperCase(),
          repoIds: [],
        };
        orgsById.set(repo.owner, org);
      }
      org.repoIds.push(repo.id);
    }
  } else {
    // No /api/repos data — derive orgs from logs only.
    for (const repo of byKey.values()) {
      let org = orgsById.get(repo.owner);
      if (!org) {
        org = {
          id: repo.owner,
          name: repo.owner,
          avatar: repo.owner.slice(0, 1).toUpperCase(),
          repoIds: [],
        };
        orgsById.set(repo.owner, org);
      }
      org.repoIds.push(repo.id);
    }
  }

  return {
    repos: Array.from(byKey.values()),
    orgs: Array.from(orgsById.values()),
    rollups: atlas?.rollups ?? [],
    username: repos?.username,
  };
}
