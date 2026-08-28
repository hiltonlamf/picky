import type { Metadata } from 'next';
import PolicyPage from '@/components/PolicyPage';

export const metadata: Metadata = { title: 'Legal' };

export default function LegalPage() {
  return (
    <PolicyPage title="Terms of use" updated="18 August 2026">
      <section>
        <h2>What Platefully provides</h2>
        <p>
          Platefully uses automated menu reading and human review to help people explore vegetarian and
          vegan options. Results are informational, may be incomplete, and are not medical or allergy
          advice. Menus and ingredients change, so always confirm dietary requirements directly with
          the restaurant.
        </p>
      </section>
      <section>
        <h2>Acceptable use</h2>
        <p>
          Do not misuse the service, attempt to bypass its limits, interfere with its operation, or
          submit unlawful or private material. Restaurant searches and uploaded menu material must be
          used for their intended purpose.
        </p>
      </section>
      <section>
        <h2>Third-party services and websites</h2>
        <p>
          Restaurant websites and other linked services are controlled by their owners. Dublin place
          suggestions are provided using Google Places. Your use of Google-related features is also
          subject to the{' '}
          <a href="https://maps.google.com/help/terms_maps/">Google Maps/Google Earth Additional Terms</a>{' '}
          and the <a href="https://policies.google.com/terms">Google Terms of Service</a>.
        </p>
      </section>
      <section>
        <h2>Availability and changes</h2>
        <p>
          We may change, suspend, or withdraw parts of Platefully and update these terms as the service
          develops. The service is provided without a guarantee that every restaurant or menu can be
          found, read, or classified correctly.
        </p>
      </section>
    </PolicyPage>
  );
}
