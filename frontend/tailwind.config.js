/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        tg: {
          bg:         'var(--tg-theme-bg-color, #ffffff)',
          'bg-sec':   'var(--tg-theme-secondary-bg-color, #f0f0f0)',
          text:       'var(--tg-theme-text-color, #000000)',
          hint:       'var(--tg-theme-hint-color, #999999)',
          link:       'var(--tg-theme-link-color, #2481cc)',
          button:     'var(--tg-theme-button-color, #2481cc)',
          'btn-text': 'var(--tg-theme-button-text-color, #ffffff)',
          destructive:'var(--tg-theme-destructive-text-color, #cc2424)',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      animation: {
        'slide-up':    'slideUp 0.2s ease-out',
        'fade-in':     'fadeIn 0.15s ease-out',
        'bounce-once': 'bounceOnce 0.4s ease-out',
      },
      keyframes: {
        slideUp:    { from: { transform: 'translateY(10px)', opacity: 0 }, to: { transform: 'translateY(0)', opacity: 1 } },
        fadeIn:     { from: { opacity: 0 }, to: { opacity: 1 } },
        bounceOnce: { '0%,100%': { transform: 'scale(1)' }, '50%': { transform: 'scale(1.15)' } },
      },
    },
  },
  plugins: [],
};
