import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("health", "routes/health.ts"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.ts"),
  route("setup", "routes/setup.tsx"),
] satisfies RouteConfig;
