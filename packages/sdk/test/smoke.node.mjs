// Bare Node, no bundler: the failure class the old CLI shipped (ERR_MODULE_NOT_FOUND
// from extensionless re-exports) is caught here, after `pnpm build`.
import { Esfera, ApiError } from "../dist/index.js";
const esfera = new Esfera({ apiKey: "esf_sk_test_v1_k_s" });
if (typeof esfera.conversions.create !== "function") throw new Error("conversions.create missing");
if (typeof Esfera.webhooks.constructEvent !== "function") throw new Error("constructEvent missing");
if (!(new ApiError({ status: 500, type: "about:blank", title: "t", detail: "d" }) instanceof Error)) throw new Error("ApiError");
console.log("smoke ok");
