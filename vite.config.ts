import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __DEBUG_BUILD__: JSON.stringify(process.env.TAURI_ENV_DEBUG === "true"
      || (process.env.TAURI_ENV_DEBUG === undefined && command === "serve")),
  },

  build: {
    target: "es2021",
    cssMinify: "lightningcss",
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react") && !id.includes("react-i18next") && !id.includes("react-markdown")) return "react-vendor";
            if (id.includes("antd") || id.includes("@ant-design")) return "antd-vendor";
            if (id.includes("i18next")) return "i18n-vendor";
          }
        },
      },
    },
  },

  oxc: {
    legalComments: "none",
    drop: ["debugger"],
    removeConsole: ["log", "debug", "info"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
