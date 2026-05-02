/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        // A handful of dim accent colors for peer name hashing
        peer: {
          1: "#a5f3fc", // cyan-200
          2: "#fda4af", // rose-300
          3: "#fde68a", // amber-200
          4: "#bbf7d0", // green-200
          5: "#c7d2fe", // indigo-200
          6: "#fdba74", // orange-300
          7: "#fbcfe8", // pink-200
          8: "#a7f3d0", // emerald-200
        },
      },
    },
  },
  plugins: [],
};
