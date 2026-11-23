import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) {
            return "vendor-react";
          }
          if (id.includes("node_modules/motion") || id.includes("node_modules/framer-motion")) {
            return "vendor-motion";
          }
          if (id.includes("node_modules/gsap") || id.includes("node_modules/@gsap")) {
            return "vendor-gsap";
          }
          if (id.includes("node_modules/three/examples")) {
            return "vendor-three-fx";
          }
          if (id.includes("node_modules/three")) {
            return "vendor-three";
          }
          if (id.includes("node_modules/lucide-react")) {
            return "vendor-icons";
          }
          if (id.includes("node_modules/@iconify")) {
            return "vendor-iconify";
          }
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5179,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8085",
    },
  },
});
