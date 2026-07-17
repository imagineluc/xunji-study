import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "mobile",
  plugins: [react()],
  publicDir: "../public",
  build: {
    outDir: "../mobile-dist",
    emptyOutDir: true,
  },
});
