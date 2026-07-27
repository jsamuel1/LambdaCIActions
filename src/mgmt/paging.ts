/**
 * Visibility-filtered pagination (spec 04 § Authorization).
 *
 * The run indexes (GSI1 status/time, GSI2 repo/time — ADR-021) are keyed by status/repo, not
 * by installation, so authorization is a filter applied AFTER the query. A naive
 * "query one page, filter, return" leaks that into the API contract: an operator whose
 * installation is a minority of platform traffic gets a nearly-empty list plus a cursor,
 * which reads as "no runs".
 *
 * `collectVisible` keeps pulling index pages until it has a full page of VISIBLE rows, the
 * index is exhausted, or a page budget is spent. Kept pure (no AWS types) so the contract is
 * unit-testable — see `test/mgmt-authz-paging.test.mjs`.
 */

/** How many index pages a single request will walk while filtering for visibility. */
export const MAX_FILTER_PAGES = 5;

export interface Page<T> {
  runs: T[];
  nextCursor?: string;
}

export async function collectVisible<T>(
  fetchPage: (cursor?: string) => Promise<Page<T>>,
  filter: (rows: T[]) => T[],
  limit: number,
  startCursor?: string,
  maxPages: number = MAX_FILTER_PAGES,
): Promise<Page<T>> {
  const out: T[] = [];
  let cursor = startCursor;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(cursor);
    out.push(...filter(res.runs));
    cursor = res.nextCursor;
    // `nextCursor` absent ⇒ the index is genuinely exhausted; a preserved cursor means the
    // client can resume rather than silently losing history.
    if (!cursor || out.length >= limit) break;
  }
  return { runs: out.slice(0, limit), nextCursor: cursor };
}
