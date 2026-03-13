import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          bg: "#140D03",
          card: "#2B1D09",
          input: "#1C1306",
          border: "#4A3318",
          muted: "#9A7A4A",
        },
        gold: {
          DEFAULT: "#C9A84C",
          hover: "#A8842A",
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
