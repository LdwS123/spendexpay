import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // SpendexAI brand palette (2026 refresh)
        spendex: {
          purple: "#6D5BFF",   // primary accent — CTAs, active states, indicator dot
          blue: "#3B82F6",     // secondary accent — links, secondary CTAs
          cyan: "#00D4FF",     // tertiary accent — gradient stops, decorative
          light: "#E6E8EE",    // soft surfaces, dividers
          dark: "#0D0F14",     // headings, primary text on light bg
        },
        // Legacy palette — kept for unmigrated surfaces. Prefer `spendex.*`
        // for new code; remove these once the V1 refresh is fully shipped.
        navy: {
          950: "#070d18",
          900: "#0a1220",
          800: "#0f1c30",
          700: "#162540",
        },
        mint: {
          DEFAULT: "#00e5b4",
          50: "#f0fdf9",
          100: "#ccfbef",
          400: "#2dffc0",
          500: "#00e5b4",
          600: "#00c49a",
        },
        brand: {
          50: "#f0fdf9",
          100: "#ccfbef",
          500: "#00e5b4",
          600: "#00c49a",
          700: "#00a882",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      backgroundImage: {
        "hero-fade": "linear-gradient(to bottom, #070d18 0%, #070d18 60%, transparent 100%)",
      },
    },
  },
  plugins: [],
};

export default config;
