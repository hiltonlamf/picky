import AdminNav from '@/components/admin/AdminNav';
import { getCorrectionLog, getFeedbackInbox } from '@/lib/db';
import { REPORT_ISSUE_TYPES, GENERAL_FEEDBACK_TYPES, GUIDE_FEEDBACK_TYPES, SITE_FEEDBACK_TYPES } from '@/lib/dietary-config';
import CopyErrorLogButton from './CopyErrorLogButton';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live (never a cached DB read after an edit)

const FEEDBACK_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  [...REPORT_ISSUE_TYPES, ...GENERAL_FEEDBACK_TYPES, ...GUIDE_FEEDBACK_TYPES, ...SITE_FEEDBACK_TYPES].map((t) => [t.value, t.label])
);

function classPill(c: string) {
  return <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-mint-100 text-evergreen">{c}</span>;
}

export default async function AdminErrorsPage() {
  const [log, feedback] = await Promise.all([getCorrectionLog(), getFeedbackInbox()]);
  const openFeedback = feedback.filter((f) => f.status === 'open');
  const unsafe = log.dishErrors.filter((e) => e.shouldBe === 'neither' && (e.aiSaid === 'vegan' || e.aiSaid === 'vegetarian'));
  const spuriousTotal = log.discovery.reduce((n, d) => n + d.spurious.length, 0);
  const duplicateTotal = log.discovery.reduce((n, d) => n + d.duplicate.length, 0);
  const missedTotal = log.discovery.filter((d) => d.missedMenus).length;

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <AdminNav active="errors" />

      <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
        <h1 className="text-xl font-bold text-evergreen">AI error log</h1>
        <div className="flex gap-2">
          <a href="/api/admin/errors/export" className="btn-secondary text-sm px-4 py-2">
            Download .md
          </a>
          <CopyErrorLogButton />
        </div>
      </div>
      <p className="text-sm text-evergreen/80 mb-8">
        Every case a reviewer corrected the AI on, pulled from the golden set. Hand this to Claude Code to fix the
        pipeline (the prompts in <span className="font-mono text-xs">lib/ai.ts</span>) at the root, instead of correcting
        the same mistake restaurant by restaurant. <strong>Copy for Claude</strong> puts a Markdown version on your
        clipboard.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
        <div className="card p-4">
          <p className="eyebrow mb-1">Dish errors</p>
          <p className="text-2xl font-bold text-evergreen">{log.dishErrors.length}</p>
          <p className="text-xs text-evergreen/70 mt-1">{unsafe.length} unsafe</p>
        </div>
        <div className="card p-4">
          <p className="eyebrow mb-1">Hallucinated dishes</p>
          <p className="text-2xl font-bold text-evergreen">{log.hallucinatedDishes.length}</p>
          <p className="text-xs text-evergreen/70 mt-1">AI invented, admin removed</p>
        </div>
        <div className="card p-4">
          <p className="eyebrow mb-1">Spurious / dup menus</p>
          <p className="text-2xl font-bold text-evergreen">{spuriousTotal + duplicateTotal}</p>
        </div>
        <div className="card p-4">
          <p className="eyebrow mb-1">Missed menus</p>
          <p className="text-2xl font-bold text-evergreen">{missedTotal}</p>
        </div>
      </div>

      {/* Dish misclassifications */}
      <h2 className="eyebrow mb-3">Dish misclassifications</h2>
      {log.dishErrors.length === 0 ? (
        <p className="text-sm text-evergreen/70 mb-10">None recorded yet — correct a dish on a review screen and it shows up here.</p>
      ) : (
        <div className="card divide-y divide-mint-100 mb-10">
          {log.dishErrors.map((e, i) => {
            const isUnsafe = e.shouldBe === 'neither' && (e.aiSaid === 'vegan' || e.aiSaid === 'vegetarian');
            const where = [e.menuLabel, e.sectionName].filter(Boolean).join(' / ');
            return (
              <div key={i} className={`p-3 ${isUnsafe ? 'bg-sun-50/40' : ''}`}>
                <p className="text-sm text-evergreen">
                  {isUnsafe && <span className="mr-1">⚠️</span>}
                  <span className="font-semibold">{e.name}</span> — AI said {classPill(e.aiSaid)} → should be{' '}
                  {classPill(e.shouldBe)}
                </p>
                <p className="text-xs text-evergreen/70 mt-0.5">
                  {e.restaurantName ?? e.url}
                  {where ? ` · ${where}` : ''}
                  {e.notes ? ` · ${e.notes}` : ''}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* Hallucinated dishes */}
      {log.hallucinatedDishes.length > 0 && (
        <>
          <h2 className="eyebrow mb-3">Hallucinated dishes (AI invented, admin removed)</h2>
          <div className="card divide-y divide-mint-100 mb-10">
            {log.hallucinatedDishes.map((h, i) => (
              <div key={i} className="p-3">
                <p className="text-sm text-evergreen">
                  <span className="font-semibold line-through decoration-sun-500">{h.name}</span>{' '}
                  <span className="text-xs text-evergreen/70">— {h.restaurantName ?? h.url}</span>
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Discovery mistakes */}
      <h2 className="eyebrow mb-3">Menu-discovery mistakes</h2>
      {log.discovery.length === 0 ? (
        <p className="text-sm text-evergreen/70">None recorded yet.</p>
      ) : (
        <div className="space-y-3">
          {log.discovery.map((d, i) => (
            <div key={i} className="card p-4">
              <p className="font-semibold text-evergreen text-sm">{d.restaurantName ?? d.url}</p>
              <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-xs text-picky-700 hover:underline break-all">
                {d.url}
              </a>
              <ul className="text-sm text-evergreen/90 mt-2 space-y-1">
                {d.spurious.length > 0 && (
                  <li>
                    <strong>Wrongly treated as a menu:</strong> {d.spurious.map((s) => `"${s}"`).join(', ')}
                  </li>
                )}
                {d.duplicate.length > 0 && (
                  <li>
                    <strong>Double-counted:</strong> {d.duplicate.map((s) => `"${s}"`).join(', ')}
                  </li>
                )}
                {d.missedMenus && (
                  <li>
                    <strong>Missed entirely:</strong> {d.missedMenus}
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* User-reported errors — the deterministic feedback ledger. Accepted ones
          also flow into the dish/discovery sections above via the golden set;
          this is the full accept/reject record in one place. */}
      <h2 className="eyebrow mb-3 mt-10">User-reported errors ({feedback.length})</h2>
      <p className="text-sm text-evergreen/80 mb-3">
        Everything users flagged, with how it was resolved. Work the{' '}
        <a href="/admin/feedback" className="text-picky-700 hover:underline">Feedback inbox</a> to accept or reject the{' '}
        {openFeedback.length} still open.
      </p>
      {feedback.length === 0 ? (
        <p className="text-sm text-evergreen/70">None yet.</p>
      ) : (
        <div className="card divide-y divide-mint-100">
          {feedback.map((f) => (
            <div key={`${f.kind}-${f.id}`} className="p-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <p className="text-sm text-evergreen">
                  <span className="font-semibold">{FEEDBACK_TYPE_LABELS[f.issueOrFeedbackType] ?? f.issueOrFeedbackType}</span>
                  {f.dishName && <span className="text-evergreen/70"> · {f.dishName}</span>}
                  {f.restaurantName && <span className="text-evergreen/70"> · {f.restaurantName}</span>}
                  {!f.restaurantId && f.city && <span className="text-evergreen/70"> · {f.city}</span>}
                </p>
                <span className={`text-xs font-mono uppercase px-2 py-0.5 rounded-full flex-shrink-0 ${
                  f.status === 'open' ? 'bg-sun-50 text-sun-800' : f.status === 'confirmed' ? 'bg-mint-100 text-picky-700' : 'bg-mint-100 text-evergreen/70'
                }`}>{f.status}</span>
              </div>
              {(f.proposedClassification || f.proposedName || f.proposedDishName) && (
                <p className="text-xs text-evergreen/80 mt-0.5">
                  {f.proposedClassification && <>should be {classPill(f.proposedClassification)} </>}
                  {f.proposedName && <>rename → &ldquo;{f.proposedName}&rdquo; </>}
                  {f.proposedDishName && <>missing dish: &ldquo;{f.proposedDishName}&rdquo; </>}
                </p>
              )}
              {f.notes && <p className="text-xs text-evergreen/70 mt-0.5 italic">&ldquo;{f.notes}&rdquo;</p>}
              <p className="text-[11px] text-evergreen/60 mt-0.5">
                {new Date(f.createdAt).toLocaleDateString()}
                {f.resolutionAction ? <> · <span className="font-mono">{f.resolutionAction}</span></> : ''}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
