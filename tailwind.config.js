/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./{App,index,components/*,services/*}.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        risto: {
          primary: '#111827',
          secondary: '#FFEDD5',
          tertiary: '#E0E7FF',
          neutral: '#FFFFFF',
          background: '#FAFAFA',
          surface: '#E5E7EB',
          'surface-light': '#F3F4F6',
          'text-primary': '#6B7280',
          'text-secondary': '#111827',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
      borderRadius: {
        'risto-card': '32px',
        'risto-md': '24px',
        'risto-sm': '20px',
      },
      boxShadow: {
        'risto-card':
          'rgba(0, 0, 0, 0.06) 0px 0px 0px 1px, rgba(0, 0, 0, 0.04) 0px 1px 1px -0.5px, rgba(0, 0, 0, 0.04) 0px 3px 3px -1.5px, rgba(0, 0, 0, 0.04) 0px 6px 6px -3px',
      },
    },
  },
  plugins: [],
}
