/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/index.html",
    "./博士工作台_整合打卡逻辑优化版_fix5_sidebar_trim.html"
  ],
  theme: {
    extend: {
      colors: {
        dopamine: {
          orange: "#FF8C42",
          pink: "#FF6B8B",
          yellow: "#F9C74F",
          mint: "#43AA8B",
          sky: "#4D9DE0",
          purple: "#9B5DE5",
          coral: "#F48C6E",
          lime: "#A7C957"
        },
        calm: {
          ink: "#45495F",
          mute: "#8A8FA6",
          bg: "#F7F8FC",
          line: "#ECEEF5"
        }
      },
      boxShadow: {
        soft: "0 18px 45px -22px rgba(0,0,0,.16)",
        floaty: "0 24px 60px -28px rgba(0,0,0,.22)"
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "Segoe UI", "sans-serif"]
      }
    }
  },
  plugins: []
};
