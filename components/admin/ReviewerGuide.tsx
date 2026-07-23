import Link from 'next/link';

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-evergreen text-lime flex items-center justify-center font-bold text-sm">
        {n}
      </div>
      <div className="min-w-0">
        <h3 className="font-bold text-evergreen mb-1">{title}</h3>
        <div className="text-sm text-evergreen/90 space-y-2">{children}</div>
      </div>
    </div>
  );
}

/**
 * The reviewer's how-to. Lives here (not on its own page/tab) so it can be
 * embedded as an expandable section inside the Evaluation dashboard.
 */
export default function ReviewerGuide() {
  return (
    <div>
      <p className="text-sm text-evergreen/80 mb-6">
        This is the human quality-control loop behind Picky. The AI reads menus and classifies dishes automatically;
        your job is to spot-check it, fix what&rsquo;s wrong, and — every time you do — quietly grow a human-verified
        golden set we use to measure whether the app is getting better. You will <strong>not</strong> review every
        restaurant. You&rsquo;ll clear real user complaints, then <em>sample</em>.
      </p>

      {/* The quality bar */}
      <section className="card p-5 mb-6">
        <h2 className="eyebrow mb-3">What &ldquo;working&rdquo; means — in priority order</h2>
        <ol className="text-sm text-evergreen/90 space-y-2 list-decimal pl-5">
          <li>
            <strong>The right menus</strong> — the restaurant&rsquo;s real menus, no more and no fewer. Two menus should
            show as two, not three, and not one. This matters most: showing a 40-dish restaurant with 2 dishes looks
            obviously broken.
          </li>
          <li>
            <strong>It actually fetched the menu</strong> — sometimes a valid link just fails. A restaurant with an error
            or zero dishes is a failure even if nothing looks &ldquo;wrong.&rdquo;
          </li>
          <li>
            <strong>All the dishes</strong> — every dish from those menus, not a tasting menu collapsed into a single
            &ldquo;dish.&rdquo;
          </li>
          <li>
            <strong>Correct classification</strong> — vegan / vegetarian / not-vegetarian / double-check.{' '}
            <em>Least critical</em>: a human confirms these, and we&rsquo;re not feeding anyone. Don&rsquo;t agonise over
            one dish; do fix a meat dish shown as vegan (that&rsquo;s the one that erodes trust).
          </li>
        </ol>
      </section>

      {/* Daily loop */}
      <section className="mb-6">
        <h2 className="eyebrow mb-4">Your loop when you sit down</h2>
        <div className="space-y-6">
          <Step n="1" title="Clear the feedback inbox first">
            <p>
              Open <Link href="/admin/feedback" className="text-picky-700 hover:underline">Feedback</Link>. These are
              real users telling us something is wrong — always worth more than a random sample. For each item decide:
              was the user right?
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Confirm</strong> a dish report → it drops you straight into that restaurant&rsquo;s review screen
                with the reported dish highlighted, so you can fix it.
              </li>
              <li>
                <strong>Dismiss</strong> (with a short note) if the user was mistaken.
              </li>
            </ul>
            <p>Restaurants and dishes with open feedback are also flagged 💬 everywhere else, so you never lose one.</p>
          </Step>

          <Step n="2" title="Then sample restaurants proactively">
            <p>
              Work the problem lists on this dashboard top-down — they&rsquo;re already sorted by what matters:
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Fetch health</strong> — restaurants that errored or came back empty. Fix these first.</li>
              <li><strong>Suspiciously thin menus</strong> — likely a missed menu or a tasting menu read as one dish.</li>
              <li>
                Then pick a handful of <strong>&ldquo;Not reviewed&rdquo;</strong> restaurants at random to spot-check.
              </li>
            </ul>
            <p>
              You don&rsquo;t need to review everything — even 10–20 well-chosen restaurants a week keeps the accuracy
              numbers honest and catches systemic problems early.
            </p>
          </Step>
        </div>
      </section>

      {/* Reviewing one restaurant */}
      <section className="mb-6">
        <h2 className="eyebrow mb-4">Reviewing one restaurant</h2>
        <div className="space-y-6">
          <Step n="1" title="Check the menus are right (menu-level)">
            <p>
              Compare the <strong>Discovered menu candidates</strong> and the actual menu blocks against the real
              restaurant website (open it in another tab). For each candidate mark <strong>Correct</strong>,{' '}
              <strong>Duplicate</strong> (same menu twice), or <strong>Spurious</strong> (not a menu at all). If a real
              menu is missing entirely, note it in <em>&ldquo;Menus we&rsquo;re missing&rdquo;</em> or add it with{' '}
              <em>Add a menu URL or file</em> (you can even upload a photo of the menu).
            </p>
            <p>
              When the set of menus is right, press <strong>&ldquo;Menus look right ✓&rdquo;</strong>. That&rsquo;s what
              counts this restaurant as &ldquo;reviewed&rdquo; in the stats — it&rsquo;s the single most important action
              on the page.
            </p>
          </Step>

          <Step n="2" title="Spot-check the dishes (dish-level)">
            <p>
              Dishes you haven&rsquo;t checked are highlighted and tagged <strong>Needs review</strong>. For each:
              <strong> Confirm</strong> if the AI got it right, <strong>Edit</strong> to fix the label (or the name),
              <strong> Delete</strong> if it isn&rsquo;t a real dish, or <strong>+ Add a dish</strong> the AI missed.
            </p>
            <p>
              You don&rsquo;t have to touch every dish — confirm a representative sample and fix anything obviously wrong.
              Every confirm/edit is remembered, survives the next re-scrape, and feeds the golden set automatically.
            </p>
          </Step>
        </div>
      </section>

      {/* Reading the numbers */}
      <section className="card p-5">
        <h2 className="eyebrow mb-3">Reading the numbers</h2>
        <ul className="text-sm text-evergreen/90 space-y-2">
          <li>
            <strong>Discovery accuracy</strong> — of the restaurants you signed off, how often the AI had the menus
            clean. This is the headline &ldquo;is the app working&rdquo; number.
          </li>
          <li>
            <strong>Dish accuracy</strong> — how often the AI&rsquo;s original guess matched your verdict, measured at the
            moment you reviewed (so it stays honest even after you correct the live label).
          </li>
          <li>
            <strong>Unsafe mislabels</strong> — the AI called a meat/fish dish vegan or vegetarian. Always shown
            separately; this is the trust-breaking error, never averaged away.
          </li>
        </ul>
      </section>
    </div>
  );
}
