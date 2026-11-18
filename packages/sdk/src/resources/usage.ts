/** `esfera.usage.get()` — the allowance, period and limits for the key's team and mode. Read `limits.perFileMinutes` before a long upload. */
import type { HttpClient } from "../http.js";
import type { Usage, WithRequestId } from "../types.js";

export class UsageResource {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }
  get(): Promise<WithRequestId<Usage>> {
    return this.#http.request<Usage>("GET", "/v1/usage");
  }
}
