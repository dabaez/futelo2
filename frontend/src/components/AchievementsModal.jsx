import { useState, useEffect } from 'react';

/**
 * AchievementsModal
 * ─────────────────
 * Bottom-sheet panel listing all 26 achievements grouped by category.
 * Earned achievements are highlighted; locked ones are greyed out.
 * Fetches GET /api/achievements on every open so the list stays fresh.
 *
 * Props:
 *   isOpen    – boolean
 *   onClose   – () => void
 *   initData  – string  (auth token)
 *   chatId    – number
 */

const CATEGORY_ORDER = ['Mensajes', 'Teclado', 'Tienda', 'Mercado', 'Mina', 'Apuestas', 'Emojis', 'Community'];

export default function AchievementsModal({ isOpen, onClose, initData, chatId }) {
  const [achievements, setAchievements] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !initData) return;
    setLoading(true);
    const base = import.meta.env.VITE_BACKEND_URL || '';
    fetch(`${base}/api/achievements`, {
      headers: { 'x-init-data': initData },
    })
      .then((r) => r.json())
      .then((data) => Array.isArray(data) && setAchievements(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOpen, initData]);

  if (!isOpen) return null;

  const earnedCount = achievements.filter((a) => a.earned).length;
  const total       = achievements.length;

  // Group by category in canonical order
  const groups = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: achievements.filter((a) => a.category === cat),
  })).filter((g) => g.items.length > 0);

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-40 bg-black/50 flex items-end justify-center"
      onClick={onClose}
    >
      {/* Sheet */}
      <div
        className="w-full max-w-lg bg-tg-bg rounded-t-2xl pb-safe flex flex-col"
        style={{ maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-tg-bg-sec flex-shrink-0">
          <div>
            <h2 className="font-bold text-tg-text text-base">🏆 Logros</h2>
            <p className="text-xs text-tg-hint mt-0.5">{earnedCount} / {total} desbloqueados</p>
          </div>
          <button
            onClick={onClose}
            className="text-tg-hint text-xl leading-none p-1 active:opacity-60"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div className="px-4 py-2 flex-shrink-0">
            <div className="h-2 bg-tg-bg-sec rounded-full overflow-hidden">
              <div
                className="h-full bg-tg-button rounded-full transition-all duration-500"
                style={{ width: `${(earnedCount / total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-4 py-2 space-y-5">
          {loading && (
            <div className="flex justify-center py-10">
              <div className="w-8 h-8 border-4 border-tg-button border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {!loading && groups.map(({ cat, items }) => (
            <section key={cat}>
              <h3 className="text-xs font-semibold text-tg-hint uppercase tracking-wider mb-2">
                {cat}
              </h3>
              <div className="space-y-2">
                {items.map((ach) => (
                  <div
                    key={ach.id}
                    className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                      ach.earned
                        ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-700'
                        : 'bg-tg-bg-sec border-transparent opacity-60'
                    }`}
                  >
                    {/* Icon */}
                    <span className="text-2xl leading-none flex-shrink-0 mt-0.5">{ach.icon}</span>

                    {/* Text */}
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-semibold ${ach.earned ? 'text-tg-text' : 'text-tg-hint'}`}>
                        {ach.name}
                      </p>
                      <p className="text-xs text-tg-hint mt-0.5 leading-snug">{ach.earned ? ach.desc : '???'}</p>
                    </div>

                    {/* Badge */}
                    <div className="flex-shrink-0 text-right mt-0.5">
                      {ach.earned ? (
                        <span className="inline-flex items-center gap-1 bg-emerald-500 text-white text-xs font-bold px-2 py-1 rounded-full">
                          ✓ +{ach.reward} 🪙
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 bg-tg-bg-sec text-tg-hint text-xs px-2 py-1 rounded-full">
                          🔒 +{ach.reward} 🪙
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
