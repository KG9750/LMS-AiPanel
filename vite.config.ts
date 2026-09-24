import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/panel/",
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/panel/api": {
        target: "http://127.0.0.1:3777",
        rewrite: (path) => path.replace(/^\/panel/, "")
      },
      "/api": "http://127.0.0.1:3777"
    }
  },
  build: {
    outDir: "dist/client"
  }
});

