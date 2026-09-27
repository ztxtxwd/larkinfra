import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/ui/",
  server: {
    port: 5173,
    proxy: {
      "/admin": "http://127.0.0.1:18787",
      "/healthz": "http://127.0.0.1:18787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
