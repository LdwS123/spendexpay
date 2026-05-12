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
