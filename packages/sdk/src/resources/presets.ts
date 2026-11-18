/** `esfera.presets.get()` — the profiles and presets this deployment's encoder accepts, and its OrbitCore version. */
import type { HttpClient } from "../http.js";
import type { PresetsResponse, WithRequestId } from "../types.js";

export class PresetsResource {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }
  get(): Promise<WithRequestId<PresetsResponse>> {
    return this.#http.request<PresetsResponse>("GET", "/v1/presets");
  }
}
