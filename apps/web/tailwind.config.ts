import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          bg: "#1C1917",
          card: "#28221E",
          input: "#211B17",
          border: "#3D3530",
          muted: "#A09890",
        },
        gold: {
          DEFAULT: "#D97757",
          hover: "#C4623D",
        },
        success: "#22C55E",
        warning: "#EAB308",
        danger: "#EF4444",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
