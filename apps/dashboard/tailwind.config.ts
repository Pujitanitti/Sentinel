/** @type {import('tailwindcss').Config} */
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: {
          bg: "#0A0D11",
          surface: "#12161C",
          raised: "#171C23",
          border: "#232A33",
          borderMuted: "#1A1F26",
        },
        text: {
          primary: "#E7EBEF",
          secondary: "#9AA5B1",
          muted: "#5F6B7A",
        },
        signal: {
          nominal: "#3ED598",
          suspicious: "#F5C244",
          high: "#F58B3C",
          critical: "#F0555C",
        },
        accent: {
          DEFAULT: "#3ED598",
          dim: "#1F6B4E",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(62,213,152,0.15), 0 0 24px -8px rgba(62,213,152,0.35)",
      },
    },
  },
  plugins: [],
};
