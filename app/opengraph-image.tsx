import { ImageResponse } from 'next/og';

// The social card is static, but ImageResponse does not inherit the fonts loaded
// by the page layout. Embed the same brand faces explicitly so WhatsApp, iMessage
// and Slack see the same typography as the site.
const displayFont = fetch(
  'https://fonts.gstatic.com/s/bricolagegrotesque/v9/3y9U6as8bTXq_nANBjzKo3IeZx8z6up5BeSl5jBNz_19PpbpMXuECpwUxJBOm_OJWiaaD30YfKfjZZoLvZvlyM0.ttf'
).then((response) => response.arrayBuffer());

const bodyFont = fetch(
  'https://fonts.gstatic.com/s/sora/v17/xMQOuFFYT72X5wkB_18qmnndmSeMmX-K.ttf'
).then((response) => response.arrayBuffer());

export const alt =
  'Platefully — find veggie dishes in any restaurant, instantly. No more mushroom risotto.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * The share card people see in WhatsApp / iMessage / Slack. It deliberately
 * mirrors the homepage hero: sprout mark, Bricolage headline, Sora body copy,
 * forest mesh and azalea emphasis.
 */
export default async function OpengraphImage() {
  const [bricolage, sora] = await Promise.all([displayFont, bodyFont]);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: '62px 76px 58px',
          backgroundColor: '#0b241b',
          backgroundImage:
            'radial-gradient(60% 80% at 12% 0%, rgba(15,122,82,0.75), transparent 70%),' +
            'radial-gradient(45% 60% at 92% 8%, rgba(255,45,143,0.42), transparent 72%),' +
            'radial-gradient(50% 65% at 70% 100%, rgba(20,86,60,0.9), transparent 70%)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
          <svg
            width="52"
            height="52"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#3ecf87"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 22v-9" />
            <path d="M12 13c0-4.5 3-6.5 8-6.5 0 4.5-3 6.5-8 6.5z" />
            <path d="M12 10C12 6.5 9.5 5 5 5c0 3.5 2.5 5 7 5z" />
          </svg>
          <div
            style={{
              color: '#fff8f3',
              fontFamily: 'Bricolage Grotesque',
              fontSize: 42,
              fontWeight: 800,
              letterSpacing: -1.2,
            }}
          >
            Platefully
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            marginTop: 62,
            maxWidth: 1050,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              color: '#fff8f3',
              fontFamily: 'Bricolage Grotesque',
              fontSize: 72,
              fontWeight: 800,
              lineHeight: 1.02,
              letterSpacing: -2.5,
            }}
          >
            <span style={{ marginRight: 18 }}>Find</span>
            <span style={{ color: '#ff5fae' }}>veggie dishes</span>
            <span>&nbsp;in any restaurant, instantly.</span>
          </div>

          <div
            style={{
              display: 'flex',
              marginTop: 28,
              color: 'rgba(255,248,243,0.88)',
              fontFamily: 'Sora',
              fontSize: 29,
              fontWeight: 600,
              lineHeight: 1.35,
              letterSpacing: -0.6,
            }}
          >
            No more showing up in places that only offer mushroom risotto.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            marginTop: 'auto',
            color: '#ff5fae',
            fontFamily: 'Sora',
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: 1.4,
            textTransform: 'uppercase',
          }}
        >
          AI-assisted&nbsp;&nbsp;·&nbsp;&nbsp;Human-verified&nbsp;&nbsp;·&nbsp;&nbsp;Made in Dublin
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        {
          name: 'Bricolage Grotesque',
          data: bricolage,
          style: 'normal',
          weight: 800,
        },
        {
          name: 'Sora',
          data: sora,
          style: 'normal',
          weight: 600,
        },
      ],
    }
  );
}
