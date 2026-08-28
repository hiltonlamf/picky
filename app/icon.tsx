import { ImageResponse } from 'next/og';

// The site had no favicon at all — browser tabs and bookmarks fell back to a
// blank page glyph. Generated rather than a checked-in .ico so it stays tied
// to the brand tokens: the Sprout mark (components/icons.tsx) in Solar green
// on the forest ground.
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#12352a',
          borderRadius: 7,
        }}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#00c46a"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 22v-9" />
          <path d="M12 13c0-4.5 3-6.5 8-6.5 0 4.5-3 6.5-8 6.5z" />
          <path d="M12 10C12 6.5 9.5 5 5 5c0 3.5 2.5 5 7 5z" />
        </svg>
      </div>
    ),
    size
  );
}
