import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#172126",
        muted: "#5d6b73",
        panel: "#f6f8f7",
        line: "#d8e1de",
        brand: "#0d7f6f",
        alert: "#c94b32",
        warn: "#b97917"
      }
    }
  },
  plugins: []
};

export default config;
