/**
 * Cursor paging, shared by every `listAll()`.
 *
 * Every /v1 list answers `{ object: "list", data, has_more, next_cursor }`,
 * newest first. A page starts strictly after `starting_after`, so a walk never
 * repeats an item and rows created after it began (they are newer) never
 * appear in it.
 */
import type { List } from "./types.js";

/** The cursor options every list takes. */
export interface CursorOptions {
  /** Items per page, 1 to 100. The API's default is 25. */
  limit?: number;
  /** The `next_cursor` of the previous page. */
  startingAfter?: string;
}

/** What `listAll()` asks for per page unless told otherwise: the API's maximum, so a walk takes as few requests as it can. */
export const LIST_ALL_LIMIT = 100;

/**
 * Yield every item, fetching the next page with `starting_after` while
 * `has_more` is true. Stops at the first page whose `has_more` is false, and
 * also when a page has no items, no cursor to continue from, or a cursor this
 * walk has already used (a misbehaving server must not loop it forever).
 */
export async function* autoPage<T extends { id: string }>(
  fetchPage: (startingAfter: string | undefined) => Promise<List<T>>,
  startingAfter?: string,
): AsyncGenerator<T, void, undefined> {
  let cursor = startingAfter;
  const used = new Set<string>();
  if (cursor) used.add(cursor);
  for (;;) {
    const page = await fetchPage(cursor);
    for (const item of page.data) yield item;
    if (!page.has_more || page.data.length === 0) return;
    const next = page.next_cursor ?? page.data[page.data.length - 1].id;
    if (!next || used.has(next)) return;
    used.add(next);
    cursor = next;
  }
}
