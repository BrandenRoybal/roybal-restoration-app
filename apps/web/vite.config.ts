import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@roybal/shared": path.resolve(__dirname, "../../packages/shared/src"),
    },
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    host: true,
  },
});
