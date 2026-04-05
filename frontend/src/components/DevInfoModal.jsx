import { useState, useEffect, useCallback } from 'react';

/**
 * DevInfoModal
 * ────────────
 * Bottom-sheet with three tabs:
 *   📋 Parches   — patch notes, newest first
 *   💡 Ideas     — open feature requests with voting
 *   ✅ Hechas    — feature requests already implemented
 *
 * Admin users (IDs listed in ADMIN_USER_IDS on the server) see a toggle
 * button on every idea/done card to flip its done status.
 *
 * Props:
 *   isOpen   – boolean
 *   onClose  – () => void
 *   initData – string  (auth token; null = not authenticated yet)
 *   userId   – number  (current user's Telegram ID, for admin check)
 */

const TABS = [
  { id: 'parches', label: '📋 Parches' },
  { id: 'ideas',   label: '💡 Ideas'   },
  { id: 'hechas',  label: '✅ Hechas'  },
];

/** Safely parse a fetch Response as JSON; returns null on error. */
async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

export default function DevInfoModal({ isOpen, onClose, initData, userId }) {
  const [tab,          setTab]          = useState('parches');
  const [patchNotes,   setPatchNotes]   = useState([]);
  const [adminIds,     setAdminIds]     = useState([]);
  const [requests,     setRequests]     = useState([]);
  const [newText,      setNewText]      = useState('');
  const [submitting,   setSubmitting]   = useState(false);
  const [submitError,  setSubmitError]  = useState(null);
  const [loadingReqs,  setLoadingReqs]  = useState(false);

  const base     = import.meta.env.VITE_BACKEND_URL || '';
  const isAdmin  = adminIds.includes(userId);

  // Fetch static config (patch notes + admin IDs) once on open
  useEffect(() => {
    if (!isOpen) return;
    fetch(`${base}/api/devinfo/config`)
      .then((r) => safeJson(r))
      .then((d) => {
        if (d?.patchNotes)   setPatchNotes(d.patchNotes);
        if (d?.adminUserIds) setAdminIds(d.adminUserIds);
      })
      .catch(() => {});
  }, [isOpen, base]);

  // Fetch feature requests whenever the modal opens or the tab changes to ideas/hechas
  const fetchRequests = useCallback(() => {
    setLoadingReqs(true);
    fetch(`${base}/api/devinfo/requests`)
      .then((r) => safeJson(r))
      .then((d) => Array.isArray(d) && setRequests(d))
      .catch(() => {})
      .finally(() => setLoadingReqs(false));
  }, [base]);

  useEffect(() => {
    if (!isOpen || tab === 'parches') return;
    fetchRequests();
  }, [isOpen, tab, fetchRequests]);

  // Submit a new feature request
  const handleSubmit = useCallback(async () => {
    if (!initData || submitting) return;
    const text = newText.trim();
    if (text.length < 5) { setSubmitError('La idea debe tener al menos 5 caracteres.'); return; }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res  = await fetch(`${base}/api/devinfo/request`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData },
        body:    JSON.stringify({ text }),
      });
      const data = await safeJson(res);
      if (!res.ok) { setSubmitError(data?.error || 'Error al enviar.'); return; }
      setNewText('');
      fetchRequests();
    } catch {
      setSubmitError('Error de conexión.');
    } finally {
      setSubmitting(false);
    }
  }, [initData, submitting, newText, base, fetchRequests]);

  // Vote on a request (unlimited)
  const handleVote = useCallback(async (id) => {
    if (!initData) return;
    try {
      const res  = await fetch(`${base}/api/devinfo/vote/${id}`, {
        method:  'POST',
        headers: { 'x-init-data': initData },
      });
      if (res.ok) fetchRequests();
    } catch { /* ignore */ }
  }, [initData, base, fetchRequests]);

  // Admin: delete request
  const handleDelete = useCallback(async (id) => {
    if (!initData) return;
    try {
      const res = await fetch(`${base}/api/devinfo/request/${id}`, {
        method:  'DELETE',
        headers: { 'x-init-data': initData },
      });
      if (res.ok) fetchRequests();
    } catch { /* ignore */ }
  }, [initData, base, fetchRequests]);

  // Admin: toggle done
  const handleToggleDone = useCallback(async (id, currentDone) => {
    if (!initData) return;
    try {
      const res = await fetch(`${base}/api/devinfo/request/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData },
        body:    JSON.stringify({ done: currentDone ? 0 : 1 }),
      });
      if (res.ok) fetchRequests();
    } catch { /* ignore */ }
  }, [initData, base, fetchRequests]);

  if (!isOpen) return null;

  const openReqs = requests.filter((r) => !r.done);
  const doneReqs = requests.filter((r) =>  r.done);

  return (
    <div
      className="fixed inset-0 z-40 bg-black/50 flex items-end justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-tg-bg rounded-t-2xl pb-safe flex flex-col"
        style={{ maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-tg-bg-sec flex-shrink-0">
          <div>
            <h2 className="font-bold text-tg-text text-base">💬 Futelo Dev</h2>
            <p className="text-xs text-tg-hint mt-0.5">Parches, ideas y más</p>
          </div>
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
        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-3">

          {/* ── Patch Notes ─────────────────────────────────────── */}
          {tab === 'parches' && (
            <>
              {patchNotes.length === 0 && (
                <p className="text-center text-tg-hint text-sm py-8">Cargando…</p>
              )}
              {patchNotes.map((patch) => (
                <div
                  key={patch.version}
                  className="bg-tg-bg-sec rounded-xl px-4 py-3"
                >
                  <div className="flex items-baseline gap-2 mb-2">
                    <span className="font-bold text-tg-text text-sm">{patch.version}</span>
                    <span className="text-xs text-tg-hint">{patch.date}</span>
                  </div>
                  <ul className="space-y-1">
                    {patch.changes.map((c, i) => (
                      <li key={i} className="text-xs text-tg-text flex gap-2">
                        <span className="text-tg-hint mt-0.5">•</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}

          {/* ── Feature Ideas ────────────────────────────────────── */}
          {tab === 'ideas' && (
            <>
              {/* Submit form */}
              {initData && (
                <div className="bg-tg-bg-sec rounded-xl px-4 py-3 space-y-2">
                  <p className="text-xs font-semibold text-tg-text">Proponer una idea</p>
                  <textarea
                    value={newText}
                    onChange={(e) => setNewText(e.target.value)}
                    maxLength={300}
                    placeholder="Describe tu idea (máx. 300 caracteres)…"
                    rows={3}
                    className="w-full bg-tg-bg text-tg-text text-xs rounded-lg px-3 py-2 resize-none border border-tg-bg-sec focus:outline-none focus:border-tg-button placeholder-tg-hint"
                  />
                  {submitError && (
                    <p className="text-xs text-red-500">{submitError}</p>
                  )}
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-tg-hint">{newText.length}/300</span>
                    <button
                      onClick={handleSubmit}
                      disabled={submitting || newText.trim().length < 5}
                      className="bg-tg-button text-tg-btn-text text-xs font-semibold px-4 py-1.5 rounded-full active:opacity-80 disabled:opacity-40"
                    >
                      {submitting ? 'Enviando…' : 'Enviar'}
                    </button>
                  </div>
                </div>
              )}

              {loadingReqs && (
                <div className="flex justify-center py-6">
                  <div className="w-6 h-6 border-2 border-tg-button border-t-transparent rounded-full animate-spin" />
                </div>
              )}

              {!loadingReqs && openReqs.length === 0 && (
                <p className="text-center text-tg-hint text-sm py-6">
                  No hay ideas todavía. ¡Sé el primero!
                </p>
              )}

              {openReqs.map((r) => (
                <RequestCard
                  key={r.id}
                  request={r}
                  isAdmin={isAdmin}
                  onVote={handleVote}
                  onToggleDone={handleToggleDone}
                  onDelete={handleDelete}
                />
              ))}
            </>
          )}

          {/* ── Completed requests ───────────────────────────────── */}
          {tab === 'hechas' && (
            <>
              {loadingReqs && (
                <div className="flex justify-center py-6">
                  <div className="w-6 h-6 border-2 border-tg-button border-t-transparent rounded-full animate-spin" />
                </div>
              )}

              {!loadingReqs && doneReqs.length === 0 && (
                <p className="text-center text-tg-hint text-sm py-6">
                  Aún no se han implementado ideas enviadas aquí.
                </p>
              )}

              {doneReqs.map((r) => (
                <RequestCard
                  key={r.id}
                  request={r}
                  isAdmin={isAdmin}
                  onVote={handleVote}
                  onToggleDone={handleToggleDone}
                  onDelete={handleDelete}
                  done
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Card sub-component ────────────────────────────────────────────────────────
function RequestCard({ request, isAdmin, onVote, onToggleDone, onDelete, done = false }) {
  const authorName = request.first_name || request.username || 'Anon';

  return (
    <div className={`rounded-xl px-4 py-3 flex gap-3 items-start ${done ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-tg-bg-sec'}`}>
      {/* Vote column */}
      <div className="flex flex-col items-center gap-1 flex-shrink-0 min-w-[2.5rem]">
        <button
          onClick={() => onVote(request.id)}
          className="text-lg leading-none active:scale-125 transition-transform"
          aria-label="Votar"
        >
          🔥
        </button>
        <span className="text-xs font-bold text-tg-text">{request.votes ?? 0}</span>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-tg-text leading-snug">{request.text}</p>
        <p className="text-xs text-tg-hint mt-1">
          {done && <span className="text-emerald-500 font-semibold mr-1">✅ Implementado</span>}
          por {authorName}
        </p>
      </div>

      {/* Admin actions */}
      {isAdmin && (
        <div className="flex flex-col gap-1 flex-shrink-0">
          <button
            onClick={() => onToggleDone(request.id, done)}
            className={`text-xs font-semibold px-2 py-1 rounded-full border transition-colors
              ${done
                ? 'border-amber-400 text-amber-500 active:bg-amber-50'
                : 'border-emerald-500 text-emerald-600 active:bg-emerald-50'}`}
            title={done ? 'Marcar como pendiente' : 'Marcar como implementado'}
          >
            {done ? '↩ Reabrir' : '✓ Listo'}
          </button>
          <button
            onClick={() => onDelete(request.id)}
            className="text-xs font-semibold px-2 py-1 rounded-full border border-red-500 text-red-500 active:bg-red-50 transition-colors"
            title="Eliminar solicitud"
          >
            🗑 Borrar
          </button>
        </div>
      )}
    </div>
  );
}
