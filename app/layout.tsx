import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import CookieConsent from '@/components/CookieConsent';
import SiteHeader from '@/components/SiteHeader';
import { HeaderProvider } from '@/lib/header-context';
import Link from 'next/link';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

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
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen flex flex-col">
        <HeaderProvider>
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <footer className="border-t border-gray-100 bg-white mt-16">
            <div className="max-w-5xl mx-auto px-4 py-8">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-500">
                <div className="flex items-center gap-2">
                  <span className="text-picky-600">🥦</span>
                  <span className="font-medium text-gray-700">Picky</span>
                  <span>— Find your food, your way.</span>
                </div>
                <div className="flex gap-4">
                  <Link href="/dublin" className="hover:text-gray-700 transition-colors">Dublin Guide</Link>
                  <a href="#" className="hover:text-gray-700 transition-colors">Privacy</a>
                  <a href="#" className="hover:text-gray-700 transition-colors">Legal</a>
                </div>
              </div>
              <p className="mt-4 text-xs text-gray-400 text-center sm:text-left">
                Always confirm dietary information with the restaurant. AI classification may not catch all ingredients.
              </p>
            </div>
          </footer>
          <CookieConsent />
        </HeaderProvider>
      </body>
    </html>
  );
}
