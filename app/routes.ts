import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("health", "routes/health.ts"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.ts"),
  route("ordini", "routes/orders.tsx"),
  route("ordini/preparazione/:caseId", "routes/billing-case-detail.tsx"),
  route("ordini/:orderId", "routes/order-detail.tsx"),
  route("attivita", "routes/activity.tsx"),
  route("impostazioni", "routes/settings.tsx"),
  route("setup", "routes/setup.tsx"),
] satisfies RouteConfig;
