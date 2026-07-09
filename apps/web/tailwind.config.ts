import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        n: {
          bg:      "var(--bg-primary)",
          side:    "var(--bg-secondary)",
          hover:   "var(--bg-hover)",
          active:  "var(--bg-active)",
          text:    "var(--text-primary)",
          muted:   "var(--text-muted)",
          border:  "var(--border-color)",
          accent:  "var(--accent-color)",
          "accent-h": "var(--accent-hover)",
        },
      },
      fontSize: {
        base: "var(--font-size-base)",
      },
    },
  },
  plugins: [],
};

export default config;
