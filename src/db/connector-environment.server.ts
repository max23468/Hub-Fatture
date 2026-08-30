import { getConfig } from "../config.server.ts";
import type { ConnectionEnvironment, Provider } from "./connector-types.server.ts";

export function activeConnectorEnvironment(provider: Provider): ConnectionEnvironment {
  const config = getConfig();
  if (provider === "SHOPIFY") {
    return config.APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT";
  }
  return config.EBAY_ENVIRONMENT === "production" ? "PRODUCTION" : "SANDBOX";
}
