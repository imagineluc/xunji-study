import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "mobile",
  envDir: "..",
  plugins: [react()],
  publicDir: "../public",
  build: {
    outDir: "../desktop-dist",
    emptyOutDir: true,
  },
});
