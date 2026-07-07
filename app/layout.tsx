import type { Metadata } from 'next';
import { Sora, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import CookieConsent from '@/components/CookieConsent';
import PostHogProvider from '@/components/PostHogProvider';
import SiteHeader from '@/components/SiteHeader';
import { HeaderProvider } from '@/lib/header-context';
import Link from 'next/link';
import { SproutIcon } from '@/components/icons';

const sora = Sora({ subsets: ['latin'], variable: '--font-sora' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: {
    default: 'Picky — Find your food, your way',
    template: '%s | Picky',
  },
  description:
    'Instantly discover vegetarian and vegan dishes at any restaurant. Paste a restaurant link and Picky analyses the menu for you.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://picky.ie'),
  openGraph: {
    siteName: 'Picky',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${mono.variable}`}>
      <body className="min-h-screen flex flex-col">
        <HeaderProvider>
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <footer className="border-t-[1.5px] border-mint-200 mt-16">
            <div className="max-w-5xl mx-auto px-4 py-8">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-evergreen/80">
                <div className="flex items-center gap-2">
                  <SproutIcon className="w-5 h-5 text-picky-600" />
                  <span className="font-bold text-evergreen">Picky</span>
                  <span>— Find what you can eat. Instantly.</span>
                </div>
                <div className="flex gap-4">
                  <Link href="/dublin" className="hover:text-evergreen transition-colors">Dublin Guide</Link>
                  <span className="text-evergreen/80 cursor-default" title="Coming soon">Privacy</span>
                  <span className="text-evergreen/80 cursor-default" title="Coming soon">Legal</span>
                </div>
              </div>
              <p className="mt-4 text-xs text-evergreen/80 text-center sm:text-left">
                Always confirm dietary information with the restaurant. AI classification may not catch all ingredients.
              </p>
            </div>
          </footer>
          <CookieConsent />
          <PostHogProvider />
        </HeaderProvider>
      </body>
    </html>
  );
}
