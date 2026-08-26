import { ImageResponse } from 'next/og';

// Static card — generated at build time, so it never touches the DB and can't
// break CI's credential-free build.
export const alt = 'Platefully — find veggie dishes in any restaurant, instantly';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * The share card people see in WhatsApp / iMessage / Slack. Built from the same
 * two inks as the site: forest ground, pink accent, with soft mesh fields.
 */
export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          backgroundColor: '#0b241b',
          backgroundImage:
            'radial-gradient(60% 80% at 12% 0%, rgba(15,122,82,0.75), transparent 70%),' +
            'radial-gradient(45% 60% at 92% 8%, rgba(255,45,143,0.42), transparent 72%),' +
            'radial-gradient(50% 65% at 70% 100%, rgba(20,86,60,0.9), transparent 70%)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              backgroundColor: '#00c46a',
              display: 'flex',
            }}
          />
          <div style={{ color: '#fff8f3', fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>
            Platefully
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              color: '#fff8f3',
              fontSize: 76,
              fontWeight: 700,
              lineHeight: 1.08,
              letterSpacing: -2.5,
              maxWidth: 1000,
            }}
          >
            Find veggie dishes in any restaurant, instantly.
          </div>
          <div style={{ display: 'flex', color: '#ff5fae', fontSize: 38, fontWeight: 600 }}>
            AI-assisted. Human-verified.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            color: 'rgba(255,248,243,0.72)',
            fontSize: 26,
            letterSpacing: 2,
            textTransform: 'uppercase',
          }}
        >
          Made in Dublin
        </div>
      </div>
    ),
    size
  );
}
