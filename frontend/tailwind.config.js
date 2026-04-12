/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'revit-dark': '#0a0c10',
        'revit-panel': '#151820',
        'revit-border': '#1e2535',
        'revit-blue': '#4f8ef7',
        'revit-green': '#3ecf8e',
      },
      animation: {
        'cursor-blink': 'blink 1s step-end infinite',
        'dot-pulse': 'dotPulse 1.4s infinite ease-in-out both',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        dotPulse: {
          '0%, 80%, 100%': { transform: 'scale(0)', opacity: '0.5' },
          '40%': { transform: 'scale(1)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
