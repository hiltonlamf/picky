import type { Metadata } from 'next';
import PolicyPage from '@/components/PolicyPage';

export const metadata: Metadata = { title: 'Privacy' };

export default function PrivacyPage() {
  return (
    <PolicyPage title="Privacy" updated="18 August 2026">
      <section>
        <h2>What Picky processes</h2>
        <p>
          You can use Picky without an account. When you search, we process the restaurant name or
          public website link you provide so we can find and read its menu. We also keep operational
          records such as whether a menu analysis succeeded, how long it took, and its cost.
        </p>
      </section>
      <section>
        <h2>Restaurant name search</h2>
        <p>
          Picky checks its own restaurant database first. If no suitable Dublin match exists, the
          restaurant query is sent from our server to Google Places to show matching businesses.
          Google suggestions are not stored by Picky. If you select one, we may store its Google
          place ID and the first-party restaurant information we subsequently obtain from the
          restaurant&apos;s own website.
        </p>
        <p className="mt-2">
          Google processes this use under the{' '}
          <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.
        </p>
      </section>
      <section>
        <h2>Security, analytics and errors</h2>
        <ul>
          <li>Search and abuse limits use a shortened one-way hash of the requesting IP address.</li>
          <li>PostHog analytics runs only after you accept analytics cookies.</li>
          <li>Sentry may receive technical error details needed to diagnose failures.</li>
          <li>Restaurant feedback stores what you submit so it can be reviewed.</li>
        </ul>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>
          You can decline analytics cookies and continue using Picky. To ask about data associated
          with feedback you submitted, use the feedback link in the site footer and include enough
          context for us to locate it.
        </p>
      </section>
    </PolicyPage>
  );
}
