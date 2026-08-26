import type { Metadata } from 'next';
import PolicyPage from '@/components/PolicyPage';

export const metadata: Metadata = { title: 'Privacy' };

export default function PrivacyPage() {
  return (
    <PolicyPage title="Privacy" updated="18 August 2026">
      <section>
        <h2>What Platefully processes</h2>
        <p>
          You can use Platefully without an account. When you search, we process the restaurant name or
          public website link you provide so we can find and read its menu. We also keep operational
          records such as whether a menu analysis succeeded, how long it took, and its cost.
        </p>
      </section>
      <section>
        <h2>Restaurant name search</h2>
        <p>
          Platefully checks its own restaurant database first. If no suitable Dublin match exists, the
          restaurant query is sent from our server to Google Places to show matching businesses.
          Google suggestions are not stored by Platefully. If you select one, we may store its Google
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
          <li>
            A random anonymous ID is stored in a cookie when you arrive, so we can count visits and
            join up our own operational records. It is never linked to your identity and never used
            for advertising.
          </li>
          <li>
            Before you choose, we count page views only. Nothing is written to your device for
            analytics and no profile is created. Accepting analytics cookies additionally enables
            PostHog product analytics, which records how the site is used and remembers your
            preferences.
          </li>
          <li>
            Search and abuse limits use a salted, shortened one-way hash of the requesting IP
            address rather than the address itself.
          </li>
          <li>Sentry may receive technical error details needed to diagnose failures.</li>
          <li>Restaurant feedback stores what you submit so it can be reviewed.</li>
          <li>
            We keep operational records of how the service performed — whether a menu analysis
            succeeded, how long it took and what it cost to run. These are kept whether or not you
            accept analytics cookies, because they are how the service is operated rather than a way
            of profiling you.
          </li>
        </ul>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>
          You can decline analytics cookies and continue using Platefully. To ask about data associated
          with feedback you submitted, use the feedback link in the site footer and include enough
          context for us to locate it.
        </p>
      </section>
    </PolicyPage>
  );
}
