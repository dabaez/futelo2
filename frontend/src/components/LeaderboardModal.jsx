import { useState, useEffect } from 'react';

/**
 * LeaderboardModal
 * ────────────────
 * Three-tab bottom-sheet showing top-10 players per room.
 *
 *   🔤 Letras   — most total letter levels (score shown)
 *   🪙 Monedas  — richest players (no amount shown, rank only)
 *   💬 Mensajes — most messages sent (count shown)
 *
 * Props:
 *   isOpen  – boolean
 *   onClose – () => void
 *   chatId  – number  (room scope)
 *   myUserId – number (highlights the current user's row)
 */

const TABS = [
  { id: 'letters',  label: '🔤 Letras'   },
  { id: 'coins',    label: '🪙 Monedas'  },
  { id: 'messages', label: '💬 Mensajes' },
];

const MEDALS = ['🥇', '🥈', '🥉'];

export default function LeaderboardModal({ isOpen, onClose, chatId, myUserId }) {
  const [tab,     setTab]     = useState('letters');
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);

  const base = import.meta.env.VITE_BACKEND_URL || '';

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    const roomQ = chatId ? `?roomId=${chatId}` : '';
    fetch(`${base}/api/leaderboard${roomQ}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOpen, chatId, base]);

  if (!isOpen) return null;

  const rows = data ? data[tab] ?? [] : [];

  return (
    <div
      className="fixed inset-0 z-40 bg-black/50 flex items-end justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-tg-bg rounded-t-2xl pb-safe flex flex-col"
        style={{ maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-tg-bg-sec flex-shrink-0">
          <h2 className="font-bold text-tg-text text-base">🏅 Tabla de posiciones</h2>
          <button
            onClick={onClose}
            className="text-tg-hint text-xl leading-none p-1 active:opacity-60"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-tg-bg-sec flex-shrink-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 py-2.5 text-xs font-semibold transition-colors
                ${tab === t.id
                  ? 'text-tg-button border-b-2 border-tg-button'
                  : 'text-tg-hint'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-4 py-3">
          {loading && (
            <div className="flex justify-center py-10">
              <div className="w-8 h-8 border-4 border-tg-button border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {!loading && rows.length === 0 && (
            <p className="text-center text-tg-hint text-sm py-10">
              No hay datos todavía.
            </p>
          )}

          {!loading && rows.length > 0 && (
            <ol className="space-y-2">
              {rows.map((player, i) => {
                const isMe   = player.userId === myUserId;
                const medal  = MEDALS[i] ?? null;
                const name   = player.firstName || player.username || 'Anon';

                return (
                  <li
                    key={player.userId}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5
                      ${isMe ? 'bg-tg-button/15 ring-1 ring-tg-button' : 'bg-tg-bg-sec'}`}
                  >
                    {/* Rank */}
                    <span className="w-7 text-center text-base flex-shrink-0">
                      {medal ?? <span className="text-xs font-bold text-tg-hint">{i + 1}</span>}
                    </span>

                    {/* Avatar placeholder */}
                    <div className="w-8 h-8 rounded-full bg-tg-button/20 flex items-center justify-center flex-shrink-0 text-sm font-bold text-tg-button">
                      {name[0]?.toUpperCase()}
                    </div>

                    {/* Name */}
                    <span className={`flex-1 text-sm truncate ${isMe ? 'font-bold text-tg-button' : 'text-tg-text'}`}>
                      {name}{isMe && ' (tú)'}
                    </span>

                    {/* Score — hidden for coins tab */}
                    {tab !== 'coins' && (
                      <span className="text-xs font-semibold text-tg-hint flex-shrink-0">
                        {tab === 'letters'
                          ? `${player.score} niv.`
                          : `${player.score} msg`}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
