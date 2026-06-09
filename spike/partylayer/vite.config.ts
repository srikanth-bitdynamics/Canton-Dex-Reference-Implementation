import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone throwaway spike — intentionally isolated from app/web's build.
export default defineConfig({
  plugins: [react()],
  server: { port: 5191 },
});
