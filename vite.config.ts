import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  server: {
    allowedHosts: [".trycloudflare.com"],
    port: Number(process.env.PORT) || 5173,
  },
});
