import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: "#0A1628",
          dark: "#0F172A",
          border: "#1E293B",
        },
        orange: {
          DEFAULT: "#F97316",
          hover: "#EA6C0C",
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
