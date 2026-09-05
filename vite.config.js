import { defineConfig } from "vite";

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: {
    allowedHosts: true,
    headers: isolationHeaders,
  },
  preview: {
    allowedHosts: true,
    headers: isolationHeaders,
  },
});
