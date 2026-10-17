/** Anything with pages: an SDK query. */
export interface Paged<R> {
  page(cursor?: string): Promise<{ readonly items: readonly R[]; readonly nextCursor?: string }>;
}

/** The most rows `all` reads when the read names no limit. */
export const ALL_ROWS_CAP = 10_000;

/**
 * A query's rows (ADR-0082): its first page, or with `all` every page up to
 * `limit` (default `ALL_ROWS_CAP`). A page may be short, even empty, and
 * still have a next one (ADR-0054), so `all` follows the cursor rather than
 * stopping at a short page, and stops when a cursor repeats.
 */
export async function rows<R>(query: Paged<R>, opts: { readonly all?: boolean; readonly limit?: number } = {}): Promise<R[]> {
  if (!opts.all) return [...(await query.page()).items];
  const max = opts.limit ?? ALL_ROWS_CAP;
  const out: R[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await query.page(cursor);
    out.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined && seen.has(cursor)) throw new Error("The query's pages did not end: a cursor repeated");
    if (cursor !== undefined) seen.add(cursor);
  } while (cursor !== undefined && out.length < max);
  // A limit the read names is the author's; the cap is not, so a result it would cut is refused rather than shortened.
  if (opts.limit === undefined && (out.length > max || cursor !== undefined))
    throw new Error(`The query has more than ${ALL_ROWS_CAP} rows: narrow it, or give the read a limit`);
  return out.slice(0, max);
}
