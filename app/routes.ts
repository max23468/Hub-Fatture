import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("health", "routes/health.ts"),
  route("integrations/shopify/auth", "routes/shopify-auth.ts"),
  route("integrations/shopify/callback", "routes/shopify-callback.ts"),
  route("integrations/ebay/auth", "routes/ebay-auth.ts"),
  route("integrations/ebay/callback", "routes/ebay-callback.ts"),
  route("webhooks/shopify", "routes/shopify-webhook.ts"),
  route("webhooks/ebay/account-deletion", "routes/ebay-account-deletion.ts"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.ts"),
  route("ordini", "routes/orders.tsx"),
  route("ordini/preparazione/:caseId", "routes/billing-case-detail.tsx"),
  route("ordini/:orderId", "routes/order-detail.tsx"),
  route("documenti", "routes/documents.tsx"),
  route("documenti/:documentId/xml", "routes/document-xml.ts"),
  route("attivita", "routes/activity.tsx"),
  route("impostazioni", "routes/settings.tsx"),
  route("setup", "routes/setup.tsx"),
] satisfies RouteConfig;
