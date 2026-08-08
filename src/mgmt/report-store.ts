import { listRepos } from '../shared/install-store.js';
import { listRunsByRepo } from '../shared/run-store.js';
import type { RunRecord } from '../shared/types.js';
import type { SessionPayload } from './session.js';
import type { ReportSpec } from './reports.js';

/**
 * Report row sourcing (spec 04 § Reports, ADR-043).
 *
 * The run table has no aggregate index: rows are per-job, indexed by status/time (GSI1) and
 * repo/time (GSI2). Three options were on the table (see ADR-043): rollup rows written on
 * every run transition, a new time-bucketed index, or a bounded fan-out over GSI2. This is
 * the fan-out, and the deciding reason is **authorization**, not cost:
 *
 * Every other management read queries a status/repo index and filters by installation
 * AFTERWARDS (`collectVisible`). For a list that is merely lossy — you see fewer rows. For
 * an aggregate it is a data-isolation bug waiting to happen: a single missed filter turns a
 * per-tenant total into a platform-wide one, and unlike a leaked row a leaked *number* looks
 * plausible. So reporting inverts the order — it resolves the operator's visible repos FIRST
 * (from the installation partition their session grants) and only queries GSI2 partitions
 * belonging to those repos. A run row from another tenant is never fetched, so there is no
 * filter left to forget.
 *
 * Cost of that choice: reads scale with (visible repos × pages), and a wide window over many
 * repos hits a page budget. We report `complete: false` rather than silently truncating.
 */

/** Per-repo GSI2 pages walked per report. 20 pages × 200 rows ≈ 4 000 jobs per repo. */
export const MAX_PAGES_PER_REPO = 20;

/** Rows fetched per GSI2 page. */
export const PAGE_SIZE = 200;

/**
 * Total rows a single report will read. Bounds Lambda time + DynamoDB spend for an operator
 * with hundreds of repos; hitting it sets `complete: false`.
 */
export const MAX_TOTAL_ROWS = 20_000;

/** Repos queried concurrently. Keeps a wide fan-out from bursting DynamoDB. */
const CONCURRENCY = 8;

export interface FetchResult {
  runs: RunRecord[];
  /** False when a page/row budget was spent before the window was exhausted. */
  complete: boolean;
  /**
   * The authorization SCOPE: every repo the session may report on after the spec's narrowing
   * filter. Echoed for the API's transparency block. This is NOT read coverage — when the row
   * budget trips, workers stop and repos still queued are never queried at all.
   */
  repoIds: number[];
  /**
   * Repos a query was actually issued for. Equals `repoIds` on a complete read; strictly
   * smaller when `MAX_TOTAL_ROWS` cut the fan-out short. Kept separate so the UI can never
   * present the authorization scope as the set the numbers were computed over.
   */
  repoIdsRead: number[];
}

/**
 * Resolve the repos an operator may report on: every repo under every installation their
 * session grants. This — NOT any spec field — is the authorization boundary.
 *
 * `spec.filters.repoIds` can only narrow it: the intersection is taken, so a spec naming a
 * foreign repo (whether typed by a user or hallucinated by the model) contributes nothing
 * rather than widening the scope.
 */
export async function resolveVisibleRepos(
  session: SessionPayload,
  spec?: ReportSpec,
  deps: { listRepos?: typeof listRepos } = {},
): Promise<{ repoId: number; repoFullName: string }[]> {
  const fetchRepos = deps.listRepos ?? listRepos;
  const perInstall = await Promise.all(
    session.installations.map((i) => fetchRepos(i.installationId)),
  );
  let repos = perInstall.flat().map((r) => ({ repoId: r.repoId, repoFullName: r.repoFullName }));
  const requested = spec?.filters.repoIds;
  if (requested?.length) {
    const want = new Set(requested);
    repos = repos.filter((r) => want.has(r.repoId));
  }
  // De-dupe: a repo granted to two installations the operator administers appears twice,
  // and reading it twice would DOUBLE its spend in the report.
  const seen = new Set<number>();
  return repos.filter((r) => (seen.has(r.repoId) ? false : (seen.add(r.repoId), true)));
}

/**
 * Fetch run rows for a report window over the operator's visible repos.
 *
 * GSI2 is (repoId, createdAt) newest-first, so paging stops as soon as a page's oldest row
 * predates the window — a 24 h report over a repo with a year of history reads one page.
 */
export async function fetchReportRuns(
  session: SessionPayload,
  spec: ReportSpec,
  deps: {
    listRepos?: typeof resolveVisibleRepos;
    listRunsByRepo?: typeof listRunsByRepo;
  } = {},
): Promise<FetchResult> {
  const resolve = deps.listRepos ?? resolveVisibleRepos;
  const fetchPage = deps.listRunsByRepo ?? listRunsByRepo;
  const repos = await resolve(session, spec);
  const fromMs = Date.parse(spec.from);
  const toMs = Date.parse(spec.to);

  const runs: RunRecord[] = [];
  let complete = true;
  let budgetSpent = false;
  const read = new Set<number>();

  const queue = [...repos];
  async function worker(): Promise<void> {
    for (;;) {
      const repo = queue.shift();
      if (!repo || budgetSpent) return;
      read.add(repo.repoId);
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES_PER_REPO; page++) {
        const res = await fetchPage(repo.repoId, { limit: PAGE_SIZE, cursor });
        let reachedOlderThanWindow = false;
        for (const r of res.runs) {
          const t = Date.parse(r.createdAt);
          if (!Number.isFinite(t)) continue;
          if (t < fromMs) {
            // Newest-first ⇒ everything after this row is older still.
            reachedOlderThanWindow = true;
            continue;
          }
          if (t >= toMs) continue; // newer than the window (only possible with an explicit `to`)
          runs.push(r);
        }
        if (runs.length >= MAX_TOTAL_ROWS) {
          complete = false;
          budgetSpent = true;
          return;
        }
        cursor = res.nextCursor;
        if (reachedOlderThanWindow || !cursor) break;
        if (page === MAX_PAGES_PER_REPO - 1) complete = false; // budget spent with history left
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(repos.length, 1)) }, () => worker()),
  );

  return {
    runs,
    complete,
    repoIds: repos.map((r) => r.repoId),
    repoIdsRead: repos.map((r) => r.repoId).filter((id) => read.has(id)),
  };
}
