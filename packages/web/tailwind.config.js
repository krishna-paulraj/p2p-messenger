/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      colors: {
        ripple: {
          bg: "#0c0c14",
          surface: "#15151f",
          "surface-2": "#1c1c28",
          border: "#262635",
          "border-strong": "#33334a",
          muted: "#6b6b85",
          "muted-2": "#4a4a60",
        },
        peer: {
          1: "#fda4af",
          2: "#fdba74",
          3: "#fcd34d",
          4: "#a3e635",
          5: "#5eead4",
          6: "#93c5fd",
          7: "#c4b5fd",
          8: "#f0abfc",
        },
      },
      keyframes: {
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
      },
      animation: {
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};
