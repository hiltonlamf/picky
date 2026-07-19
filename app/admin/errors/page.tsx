import AdminNav from '@/components/admin/AdminNav';
import { getCorrectionLog } from '@/lib/db';
import CopyErrorLogButton from './CopyErrorLogButton';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live (never a cached DB read after an edit)

function classPill(c: string) {
  return <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-mint-100 text-evergreen">{c}</span>;
}

export default async function AdminErrorsPage() {
  const log = await getCorrectionLog();
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
    </div>
  );
}
