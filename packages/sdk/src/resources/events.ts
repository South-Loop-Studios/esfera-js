/**
 * `esfera.events` — every conversion event of the last 30 days for the key's
 * team and mode, newest first. Each is the same document a webhook delivers.
 */
import type { HttpClient } from "../http.js";
import { autoPage, LIST_ALL_LIMIT, type CursorOptions } from "../pagination.js";
import type { Event, EventList, EventType, WithRequestId } from "../types.js";

export interface EventListOptions extends CursorOptions {
  type?: EventType;
  /** Only events at or after this time: unix seconds, or a Date. */
  createdGte?: number | Date;
  /** Only events before this time: unix seconds, or a Date. */
  createdLt?: number | Date;
}

function unix(v: number | Date | undefined): number | undefined {
  if (v === undefined) return undefined;
  return v instanceof Date ? Math.floor(v.getTime() / 1000) : v;
}

export class EventsResource {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** One page. Pass `next_cursor` as `startingAfter` for the next while `has_more` is true. */
  list(opts: EventListOptions = {}): Promise<WithRequestId<EventList>> {
    return this.#http.request<EventList>("GET", "/v1/events", {
      query: {
        type: opts.type,
        created_gte: unix(opts.createdGte),
        created_lt: unix(opts.createdLt),
        starting_after: opts.startingAfter,
        limit: opts.limit,
      },
    });
  }

  /** Every matching event, page after page (100 to a page unless `limit` says otherwise). */
  listAll(opts: EventListOptions = {}): AsyncGenerator<Event, void, undefined> {
    const { startingAfter, ...rest } = opts;
    const limit = rest.limit ?? LIST_ALL_LIMIT;
    return autoPage((after) => this.list({ ...rest, limit, startingAfter: after }), startingAfter);
  }

  /** One event by its `evt_…` id. Gone after 30 days (`NotFoundError`). */
  get(id: string): Promise<WithRequestId<Event>> {
    return this.#http.request<Event>("GET", `/v1/events/${encodeURIComponent(id)}`);
  }

  /** Alias of `get`. */
  retrieve(id: string): Promise<WithRequestId<Event>> {
    return this.get(id);
  }
}
