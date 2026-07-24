import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Solar green family — brand lead
        picky: {
          50: '#effaf3',
          100: '#dbf4e4',
          200: '#b8e9cc',
          300: '#86dcab',
          400: '#3ecf87',
          500: '#00c46a',
          600: '#00a35a',
          700: '#0b7a48',
          800: '#0e5138',
          900: '#0d3f2d',
        },
        // Deep green surfaces (AI trace panel, Dublin card) — lightened per founder feedback
        evergreen: {
          DEFAULT: '#0e5138',
          light: '#187552',
          line: '#2a7a56',
        },
        // Riso direction (2026-07-24): forest ground + warm paper, the two
        // surfaces every public page is built from.
        forest: {
          DEFAULT: '#12352a',
          deep: '#0b241b',
          lift: '#1b4a37',
          line: '#2c5a46',
        },
        paper: {
          DEFAULT: '#fff8f3',
          line: '#e6dbd1',
        },
        // Pink accent (Azalea). Split by ground because no single pink is
        // readable on both: 400 on forest = 4.8:1, 700 on paper = 4.9:1.
        azalea: {
          400: '#ff5fae',
          500: '#ff2d8f',
          700: '#ca2286',
        },
        // Irish green — reserved for the city-guide CTA (white on it: 5.4:1).
        irish: '#0b7a48',
        gold: '#c8890b',
        // The "future" accents — the signature gradient + AI layer
        lime: '#c6f542',
        aqua: '#2fd8c4',
        // Soft mint ground/lines on the light canvas
        mint: {
          50: '#f1faf2',
          100: '#e4f5e7',
          200: '#cfe9d6',
        },
        // "Double-check" states
        sun: {
          50: '#fff4c9',
          400: '#ffd23f',
          800: '#6f5a0d',
        },
        // Reserved hue for a future pescatarian filter (one hue per diet)
        ocean: {
          50: '#e8f4fb',
          200: '#a9d3ea',
          700: '#2f7fa8',
        },
      },
      fontFamily: {
        sans: ['var(--font-sora)', 'system-ui', 'sans-serif'],
        // Bricolage Grotesque — headlines and buttons only.
        display: ['var(--font-display)', 'var(--font-sora)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      backgroundImage: {
        // The signature Solar gradient: green → lime → aqua
        'solar-gradient': 'linear-gradient(100deg, #00c46a, #7ee23f 55%, #2fd8c4)',
        // The primary CTA: a pink mesh with a specular sheen over it.
        'liquid-pink': 'linear-gradient(118deg, #ff2d8f 0%, #d81a78 40%, #ff4fa3 72%, #ff86c2 100%)',
        // Same treatment in Irish green for the city-guide CTA. Stops are kept
        // dark enough that white stays ≥4.4:1 across the whole sweep.
        'liquid-green': 'linear-gradient(118deg, #0b7a48 0%, #065c36 40%, #0f8a52 74%, #0d9152 100%)',
      },
      boxShadow: {
        glow: '0 6px 18px rgba(0, 196, 106, 0.28)',
        'glow-pink': '0 16px 38px rgba(255, 45, 143, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.5)',
        'card-soft': '0 4px 14px rgba(5, 44, 28, 0.05)',
        'card-pop': '6px 6px 0 #ff2d8f',
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'pulse-gentle': 'pulseGentle 2s ease-in-out infinite',
        rise: 'rise 0.3s ease-out both',
        blink: 'blink 1.4s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGentle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        rise: {
          '0%': { opacity: '0', transform: 'translateY(5px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
    },
  },
  plugins: [],
};

export default config;
