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
        // Subtle accent colors for peer name hashing — readable on slate-950.
        peer: {
          1: "#67e8f9", // cyan-300
          2: "#fda4af", // rose-300
          3: "#fcd34d", // amber-300
          4: "#86efac", // green-300
          5: "#a5b4fc", // indigo-300
          6: "#fdba74", // orange-300
          7: "#f9a8d4", // pink-300
          8: "#6ee7b7", // emerald-300
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
