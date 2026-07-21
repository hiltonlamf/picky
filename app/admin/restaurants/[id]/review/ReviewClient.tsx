'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  Restaurant,
  MenuSection,
  Dish,
  MenuCandidate,
  MenuCandidateVerdict,
  DietaryClassification,
  DishReportSummary,
  FeedbackItem,
} from '@/types';
import DietaryBadge from '@/components/DietaryBadge';
import { computeReviewFlags, isPubliclyVisible, MIN_GUIDE_DISHES } from '@/lib/review-flags';

interface Props {
  restaurant: Restaurant;
  candidates: MenuCandidate[];
  candidateVerdicts: Record<string, MenuCandidateVerdict>;
  missedMenusInitial: string;
  menusReviewedAtInitial: string | null;
  dishReports: DishReportSummary[];
  restaurantFeedback: FeedbackItem[];
  inGuideInitial: boolean;
}

// Vercel's serverless request-body cap (4.5MB) leaves headroom of about this
// much raw file data once base64-inflated — see the matching cap in the
// add-menu API route.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

// Mirrors the relative-age formatting in components/FreshnessIndicator.tsx
// (the public-facing equivalent) so "scraped X ago" reads the same way here.
function formatScrapedAt(lastScrapedAt: string | null | undefined): string {
  if (!lastScrapedAt) return 'Never scraped';
  const days = (Date.now() - new Date(lastScrapedAt).getTime()) / (1000 * 60 * 60 * 24);
  const ageText =
    days < 1 ? 'today' :
    days < 2 ? 'yesterday' :
    days < 7 ? `${Math.floor(days)} days ago` :
    days < 30 ? `${Math.floor(days / 7)} week${Math.floor(days / 7) > 1 ? 's' : ''} ago` :
    `${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? 's' : ''} ago`;
  const absolute = new Date(lastScrapedAt).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' });
  return `Scraped ${ageText} (${absolute})`;
}

// Group sections by menuLabel, preserving order of first appearance (the
// sections array is already ordered by display_order).
function groupSections(sections: MenuSection[]): Array<{ label: string | null; sections: MenuSection[] }> {
  const order: Array<string | null> = [];
  const map = new Map<string | null, MenuSection[]>();
  for (const s of sections) {
    const key = s.menuLabel ?? null;
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(s);
  }
  return order.map((label) => ({ label, sections: map.get(label)! }));
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

export default function ReviewClient({
  restaurant,
  candidates,
  candidateVerdicts,
  missedMenusInitial,
  menusReviewedAtInitial,
  dishReports,
  restaurantFeedback,
  inGuideInitial,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missedMenus, setMissedMenus] = useState(missedMenusInitial);
  const [menusReviewedAt, setMenusReviewedAt] = useState<string | null>(menusReviewedAtInitial);
  const [inGuide, setInGuide] = useState(inGuideInitial);
  const [approvedAt, setApprovedAt] = useState<string | null>(restaurant.guideApprovedAt ?? null);
  const [copied, setCopied] = useState(false);
  // Local copy of recorded verdicts so a click reflects immediately (the server
  // value is refreshed on router.refresh()).
  const [verdicts, setVerdicts] = useState<Record<string, MenuCandidateVerdict>>(candidateVerdicts);
  // Candidates the user added as live menus this session (label set).
  const [addedCandidates, setAddedCandidates] = useState<Set<string>>(new Set());
  const [addResult, setAddResult] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuMode, setAddMenuMode] = useState<'url' | 'upload'>('url');
  const [addMenuUrl, setAddMenuUrl] = useState('');
  const [addMenuFile, setAddMenuFile] = useState<File | null>(null);
  const [addMenuLabel, setAddMenuLabel] = useState('');
  const [addMenuError, setAddMenuError] = useState<string | null>(null);
  const [addMenuResult, setAddMenuResult] = useState<string | null>(null);
  // No-menu confirmation: the reason the admin will sign off on (defaults to
  // whatever the pipeline detected).
  const [noMenuReason, setNoMenuReason] = useState<'not_listed' | 'unavailable' | 'closed'>(
    restaurant.noMenuReason ?? 'not_listed'
  );
  const [confirmedAt, setConfirmedAt] = useState<string | null>(restaurant.noMenuConfirmedAt ?? null);

  const groups = groupSections(restaurant.sections);

  // Central wrapper: every mutation shows a visible error on failure instead of
  // silently resetting the button (the original bug that made the whole
  // dashboard look broken).
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — the change was not saved.');
    } finally {
      setBusy(null);
    }
  }

  async function confirmNoMenuOutcome() {
    await run('confirm-no-menu', async () => {
      await postJson(`/api/admin/restaurants/${restaurant.id}/confirm-no-menu`, { reason: noMenuReason });
      setConfirmedAt(new Date().toISOString());
    });
  }

  async function confirmDish(dish: Dish, section: MenuSection) {
    await run(dish.id, () =>
      postJson('/api/admin/dish-verdict', {
        restaurantId: restaurant.id,
        action: 'upsert',
        dishId: dish.id,
        name: dish.name,
        classification: dish.classification,
        // The AI's current guess is being confirmed as correct — capture it as
        // the original so it counts as a hit in the accuracy stats.
        aiOriginalClassification: dish.classification,
        confidence: dish.confidence,
        sectionName: section.name,
        menuLabel: section.menuLabel ?? null,
      })
    );
  }

  async function correctDish(dish: Dish, section: MenuSection, classification: DietaryClassification, note: string) {
    await run(dish.id, () =>
      postJson('/api/admin/dish-verdict', {
        restaurantId: restaurant.id,
        action: 'upsert',
        dishId: dish.id,
        name: dish.name,
        classification,
        // The label shown before this edit is what the AI had — capture it so a
        // correction counts as an AI miss in the accuracy stats.
        aiOriginalClassification: dish.classification,
        confidence: 1,
        reviewerNotes: note || null,
        sectionName: section.name,
        menuLabel: section.menuLabel ?? null,
      })
    );
  }

  async function deleteDish(dish: Dish) {
    if (!window.confirm(`Remove "${dish.name}"? It won't be deleted permanently — it's marked removed and kept as a record.`)) return;
    await run(dish.id, () =>
      postJson('/api/admin/dish-verdict', { restaurantId: restaurant.id, action: 'delete', dishId: dish.id })
    );
  }

  async function restoreDish(dish: Dish) {
    await run(dish.id, () =>
      postJson('/api/admin/dish-verdict', { restaurantId: restaurant.id, action: 'restore', dishId: dish.id })
    );
  }

  async function addDish(section: MenuSection, name: string, classification: DietaryClassification, note: string) {
    await run(`add-${section.id}`, () =>
      postJson('/api/admin/dish-verdict', {
        restaurantId: restaurant.id,
        action: 'upsert',
        sectionId: section.id === 'unsectioned' ? null : section.id,
        sectionName: section.name,
        menuLabel: section.menuLabel ?? null,
        name,
        classification,
        // Admin-added dish — the AI never guessed one, so no original to capture.
        confidence: 1,
        reviewerNotes: note || null,
      })
    );
  }

  async function verdictCandidate(candidate: MenuCandidate, verdict: 'correct' | 'spurious' | 'duplicate') {
    await run(`cand-${candidate.id}`, async () => {
      await postJson('/api/admin/menu-candidate', { restaurantId: restaurant.id, label: candidate.label, verdict });
      setVerdicts((prev) => ({ ...prev, [candidate.label]: verdict }));
    });
  }

  // One-click: pull a discovered candidate in as a live menu by extracting its
  // URL. Costs real LLM money (an extraction + veg audit), so it's cost-gated
  // like the manual add-menu form.
  async function addCandidateMenu(candidate: MenuCandidate) {
    if (!candidate.ref) return;
    if (
      !window.confirm(
        `Add "${candidate.label}" as a menu? This reads and classifies it with AI — a small real cost (roughly $0.01–0.05).`
      )
    ) {
      return;
    }
    setAddResult(null);
    await run(`add-cand-${candidate.id}`, async () => {
      const data = await postJson(`/api/admin/restaurants/${restaurant.id}/add-menu`, {
        mode: 'url',
        url: candidate.ref,
        label: candidate.label,
      });
      // Adding a candidate confirms it was a real menu — record that verdict too.
      await postJson('/api/admin/menu-candidate', { restaurantId: restaurant.id, label: candidate.label, verdict: 'correct' }).catch(
        () => {}
      );
      setVerdicts((prev) => ({ ...prev, [candidate.label]: 'correct' }));
      setAddedCandidates((prev) => new Set(prev).add(candidate.label));
      setAddResult(`Added “${candidate.label}” — ${data.addedDishCount} dish(es), cost $${Number(data.costUsd ?? 0).toFixed(4)}.`);
    });
  }

  async function saveMissedMenus() {
    await run('missed-menus', () => postJson('/api/admin/missed-menus', { restaurantId: restaurant.id, missedMenus }));
  }

  async function toggleMenusReviewed() {
    const nextReviewed = !menusReviewedAt;
    await run('menus-reviewed', async () => {
      await postJson('/api/admin/menus-reviewed', { restaurantId: restaurant.id, reviewed: nextReviewed });
      setMenusReviewedAt(nextReviewed ? new Date().toISOString() : null);
    });
  }

  async function toggleGuide() {
    const next = !inGuide;
    await run('guide', async () => {
      await postJson(`/api/admin/restaurants/${restaurant.id}/guide`, { city: restaurant.city, featured: next });
      setInGuide(next);
    });
  }

  async function toggleApprove() {
    const next = !approvedAt;
    await run('approve', async () => {
      await postJson(`/api/admin/restaurants/${restaurant.id}/approve`, { approved: next });
      setApprovedAt(next ? new Date().toISOString() : null);
    });
  }

  async function deleteRestaurant() {
    if (
      !window.confirm(
        `Delete "${restaurant.name ?? restaurant.url}" and all its menus & dishes for good? This removes it from every guide too and can't be undone. (User feedback and cost history are kept.)`
      )
    ) {
      return;
    }
    setBusy('delete-restaurant');
    setError(null);
    try {
      const res = await fetch(`/api/admin/restaurants/${restaurant.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Delete failed');
      router.push('/admin/restaurants');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this restaurant.');
      setBusy(null);
    }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(restaurant.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — the id stays visible & selectable as a fallback
    }
  }

  async function removeMenuGroup(label: string | null) {
    const displayLabel = label ?? 'this menu';
    if (!window.confirm(`Remove ${displayLabel} entirely — all its sections and dishes? This can't be undone.`)) return;
    await run(`remove-${label ?? 'null'}`, () =>
      postJson(`/api/admin/restaurants/${restaurant.id}/remove-menu`, { menuLabel: label })
    );
  }

  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Strip the "data:<mime>;base64," prefix — we only want the payload.
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  async function submitAddMenu() {
    if (!addMenuLabel) return;
    if (addMenuMode === 'url' && !addMenuUrl) return;
    if (addMenuMode === 'upload' && !addMenuFile) return;
    if (
      !window.confirm(
        'This classifies one menu directly with AI — a small real cost (roughly $0.01–0.05, occasionally more for a long menu). Continue?'
      )
    ) {
      return;
    }
    setBusy('add-menu');
    setAddMenuError(null);
    setAddMenuResult(null);
    try {
      const body =
        addMenuMode === 'url'
          ? { mode: 'url' as const, url: addMenuUrl, label: addMenuLabel }
          : {
              mode: 'upload' as const,
              kind: (addMenuFile!.type === 'application/pdf' || addMenuFile!.name.toLowerCase().endsWith('.pdf')
                ? 'pdf'
                : 'image') as 'pdf' | 'image',
              fileBase64: await readFileAsBase64(addMenuFile!),
              label: addMenuLabel,
            };
      const data = await postJson(`/api/admin/restaurants/${restaurant.id}/add-menu`, body);
      setAddMenuResult(`Added ${data.addedDishCount} dish(es) — cost $${Number(data.costUsd ?? 0).toFixed(4)}.`);
      setAddMenuUrl('');
      setAddMenuFile(null);
      setAddMenuLabel('');
      router.refresh();
    } catch (err) {
      setAddMenuError(err instanceof Error ? err.message : 'Failed to add menu');
    } finally {
      setBusy(null);
    }
  }

  const reportsByDish = new Map<string, DishReportSummary[]>();
  for (const r of dishReports) {
    if (!reportsByDish.has(r.dishId)) reportsByDish.set(r.dishId, []);
    reportsByDish.get(r.dishId)!.push(r);
  }
  const openDishReports = dishReports.filter((r) => r.status === 'open').length;
  const openRestaurantFeedback = restaurantFeedback.filter((f) => f.status === 'open').length;
  const totalOpenFeedback = openDishReports + openRestaurantFeedback;

  const allDishes = restaurant.sections.flatMap((s) => s.dishes);
  const liveDishes = allDishes.filter((d) => !d.deletedAt);
  const totalDishes = liveDishes.length;
  const reviewedDishes = liveDishes.filter((d) => d.humanVerified).length;
  const removedCount = allDishes.length - liveDishes.length;

  // Review flags + live public-visibility (uses the local approvedAt so the
  // banner updates the moment you approve, before the server refresh).
  const reviewFlags = computeReviewFlags(restaurant);
  const publiclyVisible = isPubliclyVisible({ ...restaurant, guideApprovedAt: approvedAt });

  // Map a live menu group's label back to the source URL of the candidate it
  // came from, so each live menu can show a clickable "verify this menu" link.
  const candidateRefByLabel = new Map<string, string>();
  for (const c of candidates) {
    if (c.ref) candidateRefByLabel.set(c.label.toLowerCase(), c.ref);
  }
  function menuSourceLink(label: string | null): string | null {
    if (label && candidateRefByLabel.has(label.toLowerCase())) return candidateRefByLabel.get(label.toLowerCase())!;
    // Fall back to the restaurant's own URL for the primary/unlabelled menu.
    return restaurant.canonicalUrl ?? restaurant.url ?? null;
  }

  return (
    <div>
      {/* Sticky error banner — a failed action must never look like success. */}
      {error && (
        <div
          role="alert"
          className="sticky top-2 z-20 mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          <span>
            <strong>Couldn&rsquo;t save that.</strong> {error}
          </span>
          <button onClick={() => setError(null)} className="text-red-700 font-bold flex-shrink-0" aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="mb-6">
        <h1 className="text-xl font-bold text-evergreen">{restaurant.name ?? restaurant.url}</h1>
        <p className="text-sm text-evergreen/80">{restaurant.canonicalUrl ?? restaurant.url}</p>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[11px] font-mono text-evergreen/50 select-all" title="Restaurant ID">
            ID {restaurant.id}
          </span>
          <button
            onClick={copyId}
            className="text-[11px] font-medium text-picky-700 hover:underline"
            aria-label="Copy restaurant ID"
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <p className="text-xs text-evergreen/60 mt-1">{formatScrapedAt(restaurant.lastScrapedAt)}</p>
        {totalOpenFeedback > 0 && (
          <p className="mt-2 inline-block rounded-full bg-sun-50 text-sun-800 text-xs font-medium px-3 py-1">
            💬 {totalOpenFeedback} open feedback item{totalOpenFeedback > 1 ? 's' : ''} for this restaurant
          </p>
        )}
      </div>

      {/* No-menu / dead-site sign-off. The pipeline landed this restaurant in the
          'no_menu' state (site has no readable menu, or is down/closed). Confirm
          it to make the outcome STICKY — future searches return the cached
          answer with zero AI spend, past the 30-day window. To overturn it (the
          site DOES have a menu), use "Add a missing menu" below — that reads the
          real menu and flips the restaurant back to live. */}
      {restaurant.status === 'no_menu' && (
        <div className="mb-4 rounded-xl border border-sun-400/50 bg-sun-50/50 px-4 py-3">
          <p className="text-sm font-semibold text-evergreen">
            {confirmedAt ? '✓ Confirmed: no menu here' : '⚠ Flagged “no menu / dead site” — please confirm'}
          </p>
          <p className="text-xs text-evergreen/70 mt-0.5 mb-3">
            {confirmedAt
              ? 'Sticky — searches return this answer without re-analyzing. Adding a menu below will overturn it.'
              : 'We couldn’t read a menu here. Confirm what’s true so we stop paying to re-check it, or add the real menu below if we missed it.'}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={noMenuReason}
              onChange={(e) => setNoMenuReason(e.target.value as 'not_listed' | 'unavailable' | 'closed')}
              className="px-3 py-1.5 rounded-full border-2 border-mint-200 bg-white text-sm text-evergreen focus:outline-none focus:border-picky-500"
            >
              <option value="not_listed">No menu listed online</option>
              <option value="unavailable">Website down / not live</option>
              <option value="closed">Restaurant closed</option>
            </select>
            <button
              disabled={busy === 'confirm-no-menu'}
              onClick={confirmNoMenuOutcome}
              className="btn-secondary text-sm px-4 py-1.5"
            >
              {busy === 'confirm-no-menu' ? 'Saving…' : confirmedAt ? 'Update reason' : 'Confirm no menu'}
            </button>
          </div>
        </div>
      )}

      {/* Guide membership — curate which restaurants appear on the public city guide. */}
      <div
        className={`mb-4 rounded-xl border px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap ${
          inGuide ? 'border-picky-500/40 bg-mint-50' : 'border-mint-200'
        }`}
      >
        <div>
          <p className="text-sm font-semibold text-evergreen">
            {inGuide ? `⭐ In the ${restaurant.city} guide` : `Not in the ${restaurant.city} guide`}
          </p>
          <p className="text-xs text-evergreen/70">
            {inGuide
              ? `Shown to everyone browsing the ${restaurant.city} guide — keep its menus & labels correct.`
              : `Feature this restaurant on the public ${restaurant.city} guide.`}
            {inGuide && restaurant.status !== 'done' && (
              <span className="text-sun-800"> ⚠ This restaurant isn&rsquo;t fully classified — consider removing it until it&rsquo;s fixed.</span>
            )}
          </p>
        </div>
        <button
          disabled={busy === 'guide'}
          onClick={toggleGuide}
          className={inGuide ? 'btn-ghost text-sm px-4 py-1.5' : 'btn-secondary text-sm px-4 py-1.5'}
        >
          {busy === 'guide' ? 'Saving…' : inGuide ? 'Remove from guide' : 'Add to guide'}
        </button>
      </div>

      {/* Public-visibility review gate: an odd-but-featured restaurant (too few
          dishes, or a tasting/dim-sum menu captured as one "dish") is withheld
          from the public guide until an admin approves it here. */}
      {restaurant.status === 'done' && reviewFlags.length > 0 && (
        <div className="mb-4 rounded-xl border border-sun-400/50 bg-sun-50/50 px-4 py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-evergreen">
                {publiclyVisible
                  ? '⭐ Approved — clears the public-guide bar'
                  : '⚠ Held for review — hidden from the public guide'}
              </p>
              <ul className="mt-1 text-xs text-evergreen/80 list-disc pl-4 space-y-0.5">
                {reviewFlags.map((f, i) => (
                  <li key={i}>{f.detail}</li>
                ))}
              </ul>
              {totalDishes < MIN_GUIDE_DISHES && (
                <p className="mt-1 text-xs text-sun-800">
                  This needs at least {MIN_GUIDE_DISHES} dishes to be shown — approval can&rsquo;t override too few dishes.
                  Add the missing dishes/menus, or delete the restaurant if the site can&rsquo;t be read.
                </p>
              )}
            </div>
            {totalDishes >= MIN_GUIDE_DISHES && (
              <button
                disabled={busy === 'approve'}
                onClick={toggleApprove}
                className={approvedAt ? 'btn-ghost text-sm px-4 py-1.5' : 'btn-primary text-sm px-4 py-2'}
              >
                {busy === 'approve' ? 'Saving…' : approvedAt ? 'Un-approve (hide)' : 'Approve for public'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Menu-level review sign-off (B2): the countable "restaurant reviewed" action. */}
      <div
        className={`mb-8 rounded-xl border px-4 py-3 flex items-center justify-between gap-3 flex-wrap ${
          menusReviewedAt ? 'border-picky-500/40 bg-mint-50' : 'border-sun-400/50 bg-sun-50/50'
        }`}
      >
        <div>
          <p className="text-sm font-semibold text-evergreen">
            {menusReviewedAt ? 'Menus reviewed ✓' : 'Menus not reviewed yet'}
          </p>
          <p className="text-xs text-evergreen/70">
            {menusReviewedAt
              ? `You confirmed this restaurant has the right menus on ${new Date(menusReviewedAt).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })}.`
              : 'First check the menu candidates below are right (no missing, duplicate, or spurious menus), then sign off here.'}
          </p>
        </div>
        <button
          disabled={busy === 'menus-reviewed'}
          onClick={toggleMenusReviewed}
          className={menusReviewedAt ? 'btn-ghost text-sm px-4 py-1.5' : 'btn-primary text-sm px-4 py-2'}
        >
          {busy === 'menus-reviewed'
            ? 'Saving…'
            : menusReviewedAt
              ? 'Undo review'
              : 'Menus look right ✓'}
        </button>
      </div>

      {/* Restaurant-level user feedback (B7) — surfaced where you review, not just in the inbox. */}
      {restaurantFeedback.length > 0 && (
        <section className="mb-10">
          <h2 className="eyebrow mb-3">User feedback on this restaurant</h2>
          <div className="space-y-2">
            {restaurantFeedback.map((f) => (
              <div key={f.id} className="card p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono uppercase px-2 py-0.5 rounded-full bg-mint-100 text-picky-700">
                    {f.issueOrFeedbackType}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${f.status === 'open' ? 'bg-sun-50 text-sun-800' : 'bg-mint-100 text-evergreen/70'}`}
                  >
                    {f.status}
                  </span>
                  <span className="text-xs text-evergreen/50">
                    {new Date(f.createdAt).toLocaleDateString('en-IE', { dateStyle: 'medium' })}
                  </span>
                </div>
                {f.notes && <p className="text-sm text-evergreen/90 mt-1">{f.notes}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Menu candidates the AI discovered — mark each and pull in any we missed. */}
      <section className="mb-10">
        <h2 className="eyebrow mb-3">Menu candidates the AI found</h2>
        {candidates.length === 0 && (
          <p className="text-sm text-evergreen/80 mb-4">No candidate list stored for this restaurant.</p>
        )}
        {candidates.length > 0 && (
          <p className="text-xs text-evergreen/60 mb-3">
            These are the menus the AI spotted on the site. <strong>Add this menu</strong> pulls one in as a live menu
            (its dishes appear below). Then tell us whether the AI was right: <strong>Correct</strong> — a real, distinct
            menu. <strong>Duplicate</strong> — the same menu as another one here. <strong>Spurious</strong> — not a real
            menu at all (a nav/about page, gallery, wrong link).
          </p>
        )}
        {addResult && <p className="text-sm text-picky-700 mb-3">{addResult}</p>}
        <div className="space-y-2 mb-4">
          {candidates.map((c) => {
            const verdict = verdicts[c.label];
            const added = addedCandidates.has(c.label);
            const vClass = (v: MenuCandidateVerdict, danger?: boolean) =>
              verdict === v
                ? 'text-xs px-3 py-1 rounded-full bg-evergreen text-lime font-medium'
                : `btn-ghost text-xs px-3 py-1 ${danger ? 'text-sun-800' : ''}`;
            return (
              <div key={c.id} className="card p-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="font-semibold text-evergreen text-sm">
                      {c.label}{' '}
                      <span className="text-[10px] font-mono uppercase text-evergreen/50">{c.type}</span>
                    </p>
                    {c.description && <p className="text-xs text-evergreen/80">{c.description}</p>}
                    {c.ref && (
                      <a
                        href={c.ref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-picky-700 hover:underline break-all"
                      >
                        {c.ref} ↗
                      </a>
                    )}
                  </div>
                  {c.ref ? (
                    added ? (
                      <span className="text-xs text-picky-700 font-medium flex-shrink-0">Added ✓</span>
                    ) : (
                      <button
                        disabled={busy === `add-cand-${c.id}`}
                        onClick={() => addCandidateMenu(c)}
                        className="btn-secondary text-xs px-3 py-1 flex-shrink-0"
                      >
                        {busy === `add-cand-${c.id}` ? 'Adding…' : '+ Add this menu'}
                      </button>
                    )
                  ) : (
                    <span className="text-[10px] text-evergreen/40 flex-shrink-0">part of the main page</span>
                  )}
                </div>
                <div className="mt-2 pt-2 border-t border-mint-100 flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-evergreen/60">Was this a real menu?</span>
                  <button disabled={busy === `cand-${c.id}`} onClick={() => verdictCandidate(c, 'correct')} className={vClass('correct')}>
                    Correct
                  </button>
                  <button disabled={busy === `cand-${c.id}`} onClick={() => verdictCandidate(c, 'duplicate')} className={vClass('duplicate')}>
                    Duplicate
                  </button>
                  <button disabled={busy === `cand-${c.id}`} onClick={() => verdictCandidate(c, 'spurious')} className={vClass('spurious', true)}>
                    Spurious
                  </button>
                  {verdict && <span className="text-xs text-picky-700">✓ saved</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="card p-4">
          <label className="text-sm font-semibold text-evergreen block mb-2">Menus we&rsquo;re missing entirely</label>
          <textarea
            value={missedMenus}
            onChange={(e) => setMissedMenus(e.target.value)}
            placeholder="e.g. There's a separate brunch menu at /brunch we never found"
            rows={2}
            className="w-full rounded-lg border border-mint-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-picky-500 mb-2"
          />
          <button disabled={busy === 'missed-menus'} onClick={saveMissedMenus} className="btn-secondary text-sm px-4 py-1.5">
            Save
          </button>
        </div>
      </section>

      {/* Add a missing menu — the one action here that costs real LLM money */}
      <section className="mb-10">
        <h2 className="eyebrow mb-3">Add a missing menu</h2>
        <div className="card p-4">
          {!addMenuOpen ? (
            <button className="btn-secondary text-sm px-4 py-1.5" onClick={() => setAddMenuOpen(true)}>
              Add a menu URL or file
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-sun-800 bg-sun-50 rounded-lg px-3 py-2">
                This classifies the menu directly with AI — costs real money (roughly $0.01–0.05 per
                menu). You&rsquo;ll be asked to confirm before it runs.
              </p>
              <div className="flex gap-2 text-xs">
                <button
                  onClick={() => setAddMenuMode('url')}
                  className={addMenuMode === 'url' ? 'btn-secondary px-3 py-1' : 'btn-ghost px-3 py-1'}
                >
                  Paste a URL
                </button>
                <button
                  onClick={() => setAddMenuMode('upload')}
                  className={addMenuMode === 'upload' ? 'btn-secondary px-3 py-1' : 'btn-ghost px-3 py-1'}
                >
                  Upload a photo or PDF
                </button>
              </div>
              {addMenuMode === 'url' ? (
                <input
                  type="url"
                  placeholder="https://example.com/brunch-menu"
                  value={addMenuUrl}
                  onChange={(e) => setAddMenuUrl(e.target.value)}
                  className="w-full rounded-full border border-mint-200 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-picky-500"
                />
              ) : (
                <div>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,.pdf"
                    onChange={(e) => {
                      const file = e.target.files?.[0] ?? null;
                      if (file && file.size > MAX_UPLOAD_BYTES) {
                        setAddMenuError('That file is too large (max ~3MB) — try a lower-resolution photo or a smaller PDF.');
                        setAddMenuFile(null);
                        e.target.value = '';
                        return;
                      }
                      setAddMenuError(null);
                      setAddMenuFile(file);
                    }}
                    className="w-full text-sm"
                  />
                  <p className="text-xs text-evergreen/60 mt-1">
                    A clear photo (e.g. from Google Maps) or a scanned/exported PDF, up to ~3MB — a single
                    flat image or PDF file, not a link.
                  </p>
                </div>
              )}
              <input
                type="text"
                placeholder="Label, e.g. Brunch"
                value={addMenuLabel}
                onChange={(e) => setAddMenuLabel(e.target.value)}
                className="w-full rounded-full border border-mint-200 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-picky-500"
              />
              {addMenuError && <p className="text-sm text-red-500">{addMenuError}</p>}
              {addMenuResult && <p className="text-sm text-picky-700">{addMenuResult}</p>}
              <div className="flex gap-2">
                <button
                  disabled={
                    busy === 'add-menu' ||
                    !addMenuLabel ||
                    (addMenuMode === 'url' ? !addMenuUrl : !addMenuFile)
                  }
                  onClick={submitAddMenu}
                  className="btn-primary text-sm px-4 py-2"
                >
                  {busy === 'add-menu' ? 'Reading & classifying…' : 'Classify & add'}
                </button>
                <button className="btn-ghost text-sm" onClick={() => setAddMenuOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Dish-level review progress (B5). */}
      {totalDishes > 0 && (
        <div className="mb-4 text-sm text-evergreen/80">
          <span className="font-semibold text-evergreen">
            {reviewedDishes} / {totalDishes} dishes reviewed
          </span>{' '}
          — the highlighted rows below still need a human check. Confirm the ones the AI got right, edit the rest.
          {removedCount > 0 && <span className="text-evergreen/60"> · {removedCount} removed (kept as a record).</span>}
        </div>
      )}

      {/* Live menus — what users actually see; the editable list (remove per menu). */}
      <h2 className="eyebrow mb-1">Menus on this restaurant ({groups.length})</h2>
      <p className="text-xs text-evergreen/60 mb-4">
        These are live — what diners see. Remove any that shouldn&rsquo;t be here; add missing ones above.
      </p>

      {/* Current menu groups */}
      {groups.length === 0 && (
        <p className="text-sm text-evergreen/80 mb-8">
          No menus live yet — add one from the candidates above, or via &ldquo;Add a missing menu.&rdquo;
        </p>
      )}
      {groups.map(({ label, sections }) => (
        <section key={label ?? '(none)'} className="mb-10">
          <div className="flex items-center justify-between mb-1 gap-3 flex-wrap">
            <h2 className="eyebrow">{label ?? 'Menu'}</h2>
            <button
              disabled={busy === `remove-${label ?? 'null'}`}
              onClick={() => removeMenuGroup(label)}
              className="text-xs text-sun-800 hover:underline"
            >
              Remove this menu
            </button>
          </div>
          {menuSourceLink(label) && (
            <a
              href={menuSourceLink(label)!}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-picky-700 hover:underline break-all inline-block mb-3"
            >
              {menuSourceLink(label)} ↗
            </a>
          )}

          {sections.map((section) => (
            <div key={section.id} className="mb-6">
              <h3 className="text-sm font-bold text-evergreen mb-2">{section.name}</h3>
              <div className="space-y-2">
                {section.dishes.map((dish) => (
                  <DishRow
                    key={dish.id}
                    dish={dish}
                    busy={busy === dish.id}
                    reports={reportsByDish.get(dish.id) ?? []}
                    onConfirm={() => confirmDish(dish, section)}
                    onCorrect={(classification, note) => correctDish(dish, section, classification, note)}
                    onDelete={() => deleteDish(dish)}
                    onRestore={() => restoreDish(dish)}
                  />
                ))}
              </div>
              <AddDishForm
                busy={busy === `add-${section.id}`}
                onAdd={(name, classification, note) => addDish(section, name, classification, note)}
              />
            </div>
          ))}
        </section>
      ))}

      {/* Danger zone — permanently remove a restaurant (e.g. an unreadable site
          or a bad duplicate). Cascades to its menus, dishes and guide entries. */}
      <section className="mt-12 rounded-xl border border-red-300 bg-red-50/50 px-4 py-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-red-700">Delete this restaurant</p>
            <p className="text-xs text-red-700/80">
              Removes it and all its menus & dishes, and drops it from every guide. Can&rsquo;t be undone.
            </p>
          </div>
          <button
            disabled={busy === 'delete-restaurant'}
            onClick={deleteRestaurant}
            className="text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-full px-4 py-1.5 disabled:opacity-60"
          >
            {busy === 'delete-restaurant' ? 'Deleting…' : 'Delete restaurant'}
          </button>
        </div>
      </section>
    </div>
  );
}

function DishRow({
  dish,
  busy,
  reports,
  onConfirm,
  onCorrect,
  onDelete,
  onRestore,
}: {
  dish: Dish;
  busy: boolean;
  reports: DishReportSummary[];
  onConfirm: () => void;
  onCorrect: (classification: DietaryClassification, note: string) => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [classification, setClassification] = useState<DietaryClassification>(dish.classification);
  const [note, setNote] = useState(dish.reviewerNotes ?? '');

  const deleted = !!dish.deletedAt;
  const isAdminAdded = dish.origin === 'admin';
  const aiChanged =
    dish.humanVerified && dish.origin === 'ai' && !!dish.aiClassification && dish.aiClassification !== dish.classification;

  // Removed dish: keep it visible as an audit record — struck-through, dimmed,
  // with a Restore action instead of Confirm/Edit/Delete.
  if (deleted) {
    return (
      <div id={`dish-${dish.id}`} className="card p-3 opacity-60 border-l-4 border-l-evergreen/20 scroll-mt-24">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="font-semibold text-evergreen text-sm line-through decoration-evergreen/40">
              {dish.name}{' '}
              <span className="text-xs font-medium text-evergreen/60 bg-mint-100 rounded-full px-2 py-0.5 no-underline">
                Removed by admin
              </span>
            </p>
            {dish.reviewerNotes && <p className="text-xs text-evergreen/60 mt-1">{dish.reviewerNotes}</p>}
          </div>
          <button disabled={busy} onClick={onRestore} className="btn-ghost text-xs px-3 py-1 flex-shrink-0">
            Restore
          </button>
        </div>
      </div>
    );
  }

  const stale = !!dish.reviewerNotes && dish.reviewerNotes.includes('no longer matched the latest extraction');
  const needsReview = !dish.humanVerified;
  const hasReport = reports.length > 0;

  // Un-reviewed dishes get an amber left-border so the reviewer's eye goes
  // straight to what's left; a dish with user feedback is highlighted stronger.
  const borderClass = stale
    ? 'border-sun-400/50 bg-sun-50/30'
    : hasReport
      ? 'border-l-4 border-l-sun-500 bg-sun-50/30'
      : needsReview
        ? 'border-l-4 border-l-sun-300'
        : 'opacity-80';

  return (
    <div id={`dish-${dish.id}`} className={`card p-3 scroll-mt-24 ${borderClass}`}>
      {stale && (
        <p className="text-xs text-sun-800 bg-sun-50 rounded-lg px-2 py-1 mb-2">
          Verified dish no longer matched the latest extraction — kept from a previous review.
        </p>
      )}
      {hasReport && (
        <div className="mb-2 space-y-1">
          {reports.map((r) => (
            <p key={r.id} className="text-xs text-sun-800 bg-sun-50 rounded-lg px-2 py-1">
              💬 <strong>User reported</strong> ({r.issueType}
              {r.status !== 'open' ? `, ${r.status}` : ''}){r.notes ? `: “${r.notes}”` : ''}
            </p>
          ))}
        </div>
      )}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-semibold text-evergreen text-sm">
            {dish.name}{' '}
            {isAdminAdded && (
              <span className="text-xs font-medium text-picky-700 bg-mint-100 rounded-full px-2 py-0.5">Added by admin</span>
            )}{' '}
            {dish.humanVerified ? (
              <span className="text-xs text-picky-700">✓ verified</span>
            ) : (
              <span className="text-xs font-medium text-sun-800 bg-sun-50 rounded-full px-2 py-0.5">Needs review</span>
            )}
          </p>
          {dish.description && <p className="text-xs text-evergreen/80">{dish.description}</p>}
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <DietaryBadge classification={dish.classification} size="sm" />
            {aiChanged && (
              <span className="text-xs text-evergreen/60">
                (AI said <span className="font-mono">{dish.aiClassification}</span> → you changed it)
              </span>
            )}
          </div>
          {!stale && dish.reviewerNotes && (
            <p className="mt-1 text-xs text-evergreen/80">
              <span className="font-medium">Note:</span> {dish.reviewerNotes}
            </p>
          )}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button disabled={busy} onClick={onConfirm} className="btn-ghost text-xs px-3 py-1">
            Confirm
          </button>
          <button disabled={busy} onClick={() => setEditing((v) => !v)} className="btn-ghost text-xs px-3 py-1">
            Edit
          </button>
          <button disabled={busy} onClick={onDelete} className="btn-ghost text-xs px-3 py-1 text-sun-800">
            Remove
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-3 pt-3 border-t border-mint-100 flex items-center gap-2 flex-wrap">
          <select
            value={classification}
            onChange={(e) => setClassification(e.target.value as DietaryClassification)}
            className="rounded-full border border-mint-200 px-3 py-1.5 text-sm"
          >
            <option value="vegan">Vegan</option>
            <option value="vegetarian">Vegetarian</option>
            <option value="neither">Not vegetarian</option>
            <option value="unknown">Double-check</option>
          </select>
          <input
            type="text"
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="flex-1 min-w-[140px] rounded-full border border-mint-200 px-3 py-1.5 text-sm"
          />
          <button
            disabled={busy}
            onClick={() => {
              onCorrect(classification, note);
              setEditing(false);
            }}
            className="btn-secondary text-xs px-4 py-1.5"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function AddDishForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (name: string, classification: DietaryClassification, note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [classification, setClassification] = useState<DietaryClassification>('vegetarian');
  const [note, setNote] = useState('');

  if (!open) {
    return (
      <button className="text-xs text-picky-700 hover:underline mt-2" onClick={() => setOpen(true)}>
        + Add a dish
      </button>
    );
  }

  return (
    <div className="mt-2 card p-3 flex items-center gap-2 flex-wrap">
      <input
        type="text"
        placeholder="Dish name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="flex-1 min-w-[140px] rounded-full border border-mint-200 px-3 py-1.5 text-sm"
      />
      <select
        value={classification}
        onChange={(e) => setClassification(e.target.value as DietaryClassification)}
        className="rounded-full border border-mint-200 px-3 py-1.5 text-sm"
      >
        <option value="vegan">Vegan</option>
        <option value="vegetarian">Vegetarian</option>
        <option value="neither">Not vegetarian</option>
        <option value="unknown">Double-check</option>
      </select>
      <input
        type="text"
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="flex-1 min-w-[120px] rounded-full border border-mint-200 px-3 py-1.5 text-sm"
      />
      <button
        disabled={busy || !name}
        onClick={() => {
          onAdd(name, classification, note);
          setName('');
          setNote('');
          setOpen(false);
        }}
        className="btn-secondary text-xs px-4 py-1.5"
      >
        Add
      </button>
      <button className="btn-ghost text-xs" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
