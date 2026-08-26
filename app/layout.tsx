import type { Metadata } from 'next';
import { Sora, JetBrains_Mono, Bricolage_Grotesque } from 'next/font/google';
import './globals.css';
import CookieConsent from '@/components/CookieConsent';
import NPSPrompt from '@/components/NPSPrompt';
import PostHogProvider from '@/components/PostHogProvider';
import SiteHeader from '@/components/SiteHeader';
import SiteFeedbackButton from '@/components/SiteFeedbackButton';
import { HeaderProvider } from '@/lib/header-context';
import { SITE_DESCRIPTION, SITE_TAGLINE, SITE_TITLE } from '@/lib/site-copy';
import Link from 'next/link';
import { SproutIcon } from '@/components/icons';

const sora = Sora({ subsets: ['latin'], variable: '--font-sora' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });
// Display face — headlines and buttons only. 800 is the only weight used.
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['800'],
  variable: '--font-display',
});

export const metadata: Metadata = {
  title: {
    default: SITE_TITLE,
    template: '%s | Platefully',
  },
  description: SITE_DESCRIPTION,
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://platefully.vercel.app'),
  // Shared links (WhatsApp, iMessage, Slack) read these — without them the
  // preview falls back to whatever stale copy was in the page title.
  openGraph: {
    siteName: 'Platefully',
    type: 'website',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${mono.variable} ${display.variable}`}>
      <body className="min-h-screen flex flex-col bg-paper">
        <HeaderProvider>
          <SiteHeader />
          <main className="flex-1">{children}</main>

          <footer className="bg-forest-deep text-paper/75">
            <div className="max-w-5xl mx-auto px-6 py-10">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
                <div className="flex items-center gap-2.5">
                  <SproutIcon className="w-5 h-5 text-picky-400" />
                  <p className="text-sm">{SITE_TAGLINE}</p>
                </div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                  <Link href="/dublin" className="hover:text-paper transition-colors">
                    Dublin Guide
                  </Link>
                  <Link href="/privacy" className="hover:text-paper transition-colors">
                    Privacy
                  </Link>
                  <Link href="/legal" className="hover:text-paper transition-colors">
                    Legal
                  </Link>
                  <SiteFeedbackButton />
                </div>
              </div>
              <p className="mt-6 text-xs text-paper/55">
                Always confirm dietary information with the restaurant. We read menus with AI and
                review them by hand, but menus change and mistakes happen — tell us when you spot one.
              </p>
            </div>
          </footer>

          <CookieConsent />
          <NPSPrompt />
          <PostHogProvider />
        </HeaderProvider>
      </body>
    </html>
  );
}
