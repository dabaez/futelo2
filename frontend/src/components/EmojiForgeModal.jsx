import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * EmojiForgeModal
 * ───────────────
 * Two-tab bottom-sheet for the Emoji Forge feature.
 *
 *  🧪 Forja   – build a recipe from character ingredients, watch a 1-hour
 *               countdown, optionally pay to instant-complete, buy hints.
 *  😊 Emojis  – gallery of all emojis; unlocked ones can be tapped to
 *               insert into the current draft message.
 *
 * Props:
 *   isOpen          – boolean
 *   onClose         – () => void
 *   initData        – string  (auth token)
 *   chatId          – number
 *   coins           – number  (current balance, kept in sync via onPurchase)
 *   inventory       – object  { a: 2, _symbols: 3, … }
 *   socket          – Socket.io client socket (may be null)
 *   onPurchase      – ({ newCoins?, newInventory? }) => void
 *   onEmojiInsert   – (emojiChar: string) => void
 *   currentDraft    – string  (current message draft for duplicate guard)
 */

// ALL_EMOJIS is no longer hardcoded here — it is passed in as the `emojiDefs` prop
// and populated from GET /api/config so config.js is the single source of truth.

// Must match backend SYMBOL_CHARS
const SYMBOL_CHARS = '!?.,:-()@#&*;<>+~$%/^';

// Character picker layout
const LETTER_ROWS = [
  ['a','b','c','d','e','f','g','h','i'],
  ['j','k','l','m','n','ñ','o','p','q'],
  ['r','s','t','u','v','w','x','y','z'],
];
const SYMBOL_ROW = SYMBOL_CHARS.split('');
const NUMBER_ROW = ['1','2','3','4','5','6','7','8','9','0'];

// Coins per remaining second for instant-complete (must match server config)
const INSTANT_COST_PER_SEC = 0.02;
const MERGE_DURATION_SEC   = 3600; // 1 hour

/** Map a character to its inventory key. */
function inventoryKey(ch) {
  const lc = ch.toLowerCase();
  if ((lc >= 'a' && lc <= 'z') || lc === 'ñ') return lc;
  if (ch >= '0' && ch <= '9') return '_numbers';
  if (SYMBOL_CHARS.includes(ch)) return '_symbols';
  return null;
}

/** Count occurrences of each inventory key in a char array. */
function countKeys(chars) {
  const counts = {};
  for (const ch of chars) {
    const k = inventoryKey(ch);
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/** Format seconds as mm:ss */
function fmtTime(secs) {
  const s = Math.max(0, secs);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** Safely parse a fetch Response as JSON; returns null on error. */
async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

// ── Sub-component: celebration overlay ───────────────────────────────────────
function CelebrationOverlay({ event, onDone, emojiDefs = [] }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!event) return;
    setVisible(true);
    const t = setTimeout(() => { setVisible(false); onDone(); }, 2800);
    return () => clearTimeout(t);
  }, [event, onDone]);

  if (!visible || !event) return null;

  const success = event.success;
  const emojiDef = success ? emojiDefs.find((e) => e.key === event.emoji?.key) : null;

  const sparks = success
    ? ['top-4 left-6', 'top-8 right-8', 'bottom-12 left-12', 'bottom-8 right-10',
       'top-1/2 left-4', 'top-1/2 right-4', 'top-1/4 left-1/2', 'bottom-1/4 left-1/3']
    : [];

  return (
    <div className={`
      absolute inset-0 z-50 flex flex-col items-center justify-center rounded-t-2xl
      ${success ? 'bg-black/75' : 'bg-black/70'}
      transition-opacity duration-300
    `}>
      {/* Sparkles (success only) */}
      {sparks.map((pos, i) => (
        <span
          key={i}
          className={`absolute ${pos} text-xl animate-ping`}
          style={{ animationDelay: `${i * 120}ms`, animationDuration: '0.9s' }}
        >
          {i % 3 === 0 ? '✨' : i % 3 === 1 ? '🌟' : '💫'}
        </span>
      ))}

      {/* Main emoji */}
      <div className="text-8xl animate-bounce mb-4">
        {success ? (emojiDef?.emoji ?? '✨') : '💨'}
      </div>

      {success ? (
        <>
          <p className="text-white font-bold text-2xl mb-1">
            {event.alreadyHad ? '¡Ya lo tenías!' : '¡Desbloqueado!'}
          </p>
          <p className="text-tg-hint text-sm">
            {emojiDef ? `${emojiDef.emoji} ${emojiDef.name}` : ''}
          </p>
        </>
      ) : (
        <>
          <p className="text-white font-bold text-xl mb-1">La mezcla falló</p>
          <p className="text-tg-hint text-sm">Tus letras fueron devueltas 🔁</p>
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function EmojiForgeModal({
  isOpen,
  onClose,
  initData,
  chatId,
  coins,
  inventory,
  socket,
  onPurchase,
  onEmojiInsert,
  currentDraft = '',
  emojiDefs = [],
}) {
  const [inputChars,    setInputChars]    = useState([]);        // current recipe being built
  const [activeMerge,   setActiveMerge]   = useState(null);      // pending merge from server
  const [unlockedEmojis, setUnlockedEmojis] = useState([]);      // user's unlocked emoji_keys
  const [secsLeft,      setSecsLeft]      = useState(0);
  const [loading,       setLoading]       = useState(false);
  const [err,           setErr]           = useState(null);
  const [hints,         setHints]         = useState([]);        // array of mystery hint strings
  const [hintLoading,   setHintLoading]   = useState(false);
  const [hintCost,      setHintCost]      = useState(20);        // from config
  const [celebEvent,    setCelebEvent]    = useState(null);      // celebration trigger
  const timerRef = useRef(null);

  const BASE_URL = import.meta.env.VITE_BACKEND_URL || '';

  // ── Auth header ─────────────────────────────────────────────────────────
  const authHeaders = { 'Content-Type': 'application/json', 'x-init-data': initData };

  // ── Hydrate status on open ───────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;

    // Fetch config for hint cost
    fetch(`${BASE_URL}/api/config`)
      .then(safeJson)
      .then((data) => {
        if (data?.HINT_COST != null) setHintCost(data.HINT_COST);
      })
      .catch(() => {});

    if (!initData) return;
    fetch(`${BASE_URL}/api/emoji/status`, { headers: { 'x-init-data': initData } })
      .then(safeJson)
      .then((data) => {
        if (!data) return;
        setActiveMerge(data.merge || null);
        setUnlockedEmojis(data.unlockedEmojis || []);
        setHints(data.hints || []);
      })
      .catch(() => {});
  }, [isOpen, initData]);

  // ── Countdown timer ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeMerge) { setSecsLeft(0); clearInterval(timerRef.current); return; }

    const tick = () => {
      const left = Math.max(0, activeMerge.finishes_at - Math.floor(Date.now() / 1000));
      setSecsLeft(left);
    };
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => clearInterval(timerRef.current);
  }, [activeMerge]);

  // ── Socket: emoji_complete ───────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const handler = (result) => {
      setCelebEvent(result);
      if (result.success) {
        setUnlockedEmojis((prev) =>
          prev.includes(result.emoji?.key) ? prev : [...prev, result.emoji?.key]
        );
      }
      setActiveMerge(null);
    };
    socket.on('emoji_complete', handler);
    return () => socket.off('emoji_complete', handler);
  }, [socket]);

  // ── Reset on close ───────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    setErr(null);
    onClose();
  }, [onClose]);

  // ── Character picker ─────────────────────────────────────────────────────
  const inUseCounts = countKeys(inputChars);

  const canAddChar = useCallback((ch) => {
    if (inputChars.length >= 6) return false;
    const k = inventoryKey(ch);
    if (!k) return false;
    const used = inUseCounts[k] || 0;
    const have = inventory[k] || 0;
    return used < have;
  }, [inputChars, inUseCounts, inventory]);

  const handleAddChar = useCallback((ch) => {
    if (!canAddChar(ch)) return;
    setInputChars((prev) => [...prev, ch]);
    setErr(null);
  }, [canAddChar]);

  const handleBackspace = useCallback(() => {
    setInputChars((prev) => prev.slice(0, -1));
    setErr(null);
  }, []);

  // ── Start merge ──────────────────────────────────────────────────────────
  const handleStartMerge = useCallback(async () => {
    if (inputChars.length < 2 || loading) return;
    setLoading(true);
    setErr(null);
    try {
      const res  = await fetch(`${BASE_URL}/api/emoji/start`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ ingredients: inputChars, chatId }),
      });
      const data = await safeJson(res);
      if (!res.ok) { setErr(data?.error || 'Error al iniciar la mezcla.'); return; }
      setActiveMerge(data.merge);
      setInputChars([]);
      if (data.newInventory) onPurchase({ newInventory: data.newInventory });
    } catch {
      setErr('Error de conexión.');
    } finally {
      setLoading(false);
    }
  }, [inputChars, loading, chatId, authHeaders, onPurchase]);

  // ── Instant complete ─────────────────────────────────────────────────────
  const handleInstant = useCallback(async () => {
    if (!activeMerge || loading) return;
    setLoading(true);
    setErr(null);
    try {
      const res  = await fetch(`${BASE_URL}/api/emoji/instant`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ chatId }),
      });
      const data = await safeJson(res);
      if (!res.ok) { setErr(data?.error || 'Error al completar.'); return; }
      // Celebration is triggered via the socket event emitted by the server.
      // But in case the socket is slow, also handle it here:
      if (data.success !== undefined) {
        setCelebEvent(data);
        if (data.success) {
          setUnlockedEmojis((prev) =>
            prev.includes(data.emoji?.key) ? prev : [...prev, data.emoji?.key]
          );
        }
        setActiveMerge(null);
      }
      onPurchase({ newCoins: data.newCoins, newInventory: data.newInventory });
    } catch {
      setErr('Error de conexión.');
    } finally {
      setLoading(false);
    }
  }, [activeMerge, loading, chatId, authHeaders, onPurchase]);

  // ── Buy hint ─────────────────────────────────────────────────────────────
  const handleHint = useCallback(async () => {
    if (hintLoading) return;
    setHintLoading(true);
    setErr(null);
    try {
      const res  = await fetch(`${BASE_URL}/api/emoji/hint`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ chatId }),
      });
      const data = await safeJson(res);
      if (!res.ok) { setErr(data?.error || 'Error al comprar pista.'); return; }
      setHints((prev) => [...prev, data.hint]);
      onPurchase({ newCoins: data.newCoins });
    } catch {
      setErr('Error de conexión.');
    } finally {
      setHintLoading(false);
    }
  }, [hintLoading, chatId, authHeaders, onPurchase]);

  if (!isOpen) return null;

  // Derived values
  const instantCost     = Math.ceil(secsLeft * INSTANT_COST_PER_SEC);
  const progressPct     = activeMerge
    ? Math.min(100, ((MERGE_DURATION_SEC - secsLeft) / MERGE_DURATION_SEC) * 100)
    : 0;
  const canAffordInstant = coins >= instantCost;
  const mergeIngredients = activeMerge ? JSON.parse(activeMerge.ingredients || '[]') : [];

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={handleClose} />

      {/* Sheet */}
      <div className="relative w-full max-w-lg bg-tg-bg rounded-t-2xl shadow-2xl overflow-hidden"
           style={{ maxHeight: '88vh' }}>

        {/* Celebration overlay */}
        <CelebrationOverlay event={celebEvent} onDone={() => setCelebEvent(null)} emojiDefs={emojiDefs} />

        {/* Handle + header */}
        <div className="sticky top-0 bg-tg-bg z-10 pt-3 pb-2 px-4 border-b border-tg-bg-sec">
          <div className="w-10 h-1 bg-tg-hint/40 rounded-full mx-auto mb-3" />
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-tg-text text-base">🧪 Forja de Emojis</h2>
            <button onClick={handleClose}
                    className="text-tg-hint text-xl w-8 h-8 flex items-center justify-center">
              ✕
            </button>
          </div>
        </div>

        {/* Error banner */}
        {err && (
          <div className="mx-4 mt-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2
                          text-xs text-red-600 text-center">
            {err}
          </div>
        )}

        {/* Scrollable content */}
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(88vh - 120px)' }}>

          {/* ── FORGE CONTENT ─────────────────────────────────────────────── */}
          <div className="px-4 py-3 space-y-4">

              {activeMerge ? (
                /* ── Active merge view ─────────────────────────────────── */
                <div className="space-y-4">
                  <div className="bg-tg-bg-sec rounded-xl p-4 space-y-3">
                    <p className="text-xs text-tg-hint text-center font-medium uppercase tracking-wide">
                      Mezcla en progreso
                    </p>

                    {/* Ingredients display */}
                    <div className="flex flex-wrap justify-center gap-2">
                      {mergeIngredients.map((ch, i) => (
                        <span key={i}
                              className="w-9 h-9 flex items-center justify-center
                                         bg-tg-button/20 text-tg-button border border-tg-button/40
                                         rounded-lg font-bold text-sm">
                          {ch}
                        </span>
                      ))}
                    </div>

                    {/* Progress bar */}
                    <div className="w-full bg-tg-bg rounded-full h-2.5 overflow-hidden">
                      <div
                        className="h-full bg-tg-button rounded-full transition-all duration-1000"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>

                    {/* Countdown */}
                    <div className="text-center">
                      {secsLeft > 0 ? (
                        <>
                          <p className="text-2xl font-mono font-bold text-tg-text">
                            {fmtTime(secsLeft)}
                          </p>
                          <p className="text-xs text-tg-hint mt-0.5">tiempo restante</p>
                        </>
                      ) : (
                        <p className="text-sm font-semibold text-emerald-500 animate-pulse">
                          ✅ ¡Listo! Revelando resultado…
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Instant complete */}
                  {secsLeft > 0 && (
                    <button
                      onClick={handleInstant}
                      disabled={loading || !canAffordInstant}
                      className={`w-full py-3 rounded-xl font-semibold text-sm transition-all
                        ${canAffordInstant && !loading
                          ? 'bg-amber-500 text-white active:brightness-90'
                          : 'bg-gray-300 text-gray-400 cursor-not-allowed'}`}
                    >
                      {loading ? '⏳ Procesando…' : `⚡ Completar ahora — ${instantCost} 🪙`}
                    </button>
                  )}

                  <p className="text-center text-xs text-tg-hint">
                    Solo puede haber una mezcla activa a la vez.
                  </p>
                </div>

              ) : (
                /* ── Recipe builder ────────────────────────────────────── */
                <div className="space-y-3">

                  {/* Current recipe pills + backspace */}
                  <div className="flex items-center gap-1.5 min-h-[44px] flex-wrap">
                    {inputChars.length === 0 ? (
                      <p className="text-xs text-tg-hint italic">
                        Toca caracteres abajo para armar la receta…
                      </p>
                    ) : (
                      inputChars.map((ch, i) => (
                        <span key={i}
                              className="px-2.5 py-1.5 bg-tg-button text-tg-btn-text rounded-lg
                                         font-bold text-sm shadow-sm">
                          {ch}
                        </span>
                      ))
                    )}
                    {inputChars.length > 0 && (
                      <button
                        onClick={handleBackspace}
                        className="ml-auto px-3 py-1.5 bg-tg-bg-sec text-tg-hint rounded-lg
                                   text-sm font-semibold active:brightness-90">
                        ⌫
                      </button>
                    )}
                  </div>

                  {/* Character picker */}
                  <div className="bg-tg-bg-sec rounded-xl p-3 space-y-2">
                    {/* Letters */}
                    {LETTER_ROWS.map((row, ri) => (
                      <div key={ri} className="flex gap-1 flex-wrap justify-center">
                        {row.map((ch) => {
                          const can = canAddChar(ch);
                          const k   = inventoryKey(ch);
                          const lvl = inventory[k] || 0;
                          return (
                            <button
                              key={ch}
                              onPointerDown={(e) => { e.preventDefault(); handleAddChar(ch); }}
                              className={`relative w-8 h-8 rounded-md text-xs font-semibold
                                         transition-all active:scale-95
                                ${can
                                  ? 'bg-white text-gray-800 shadow-sm'
                                  : 'bg-gray-200 text-gray-400 cursor-not-allowed opacity-50'}`}
                            >
                              {ch.toUpperCase()}
                              <span className="absolute top-0 right-0.5 text-[7px] leading-none
                                               font-bold text-tg-button">{lvl}</span>
                            </button>
                          );
                        })}
                      </div>
                    ))}

                    {/* Symbols */}
                    <div className="flex gap-1 flex-wrap justify-center">
                      {SYMBOL_ROW.map((ch) => {
                        const can = canAddChar(ch);
                        const lvl = inventory._symbols || 0;
                        return (
                          <button
                            key={ch}
                            onPointerDown={(e) => { e.preventDefault(); handleAddChar(ch); }}
                            className={`relative w-8 h-8 rounded-md text-sm font-bold
                                       transition-all active:scale-95
                              ${can
                                ? 'bg-white text-gray-700 shadow-sm'
                                : 'bg-gray-200 text-gray-400 cursor-not-allowed opacity-50'}`}
                          >
                            {ch}
                            {/* Only show level once on the first symbol key */}
                            {ch === SYMBOL_CHARS[0] && (
                              <span className="absolute top-0 right-0 text-[7px] leading-none
                                               font-bold text-tg-button">{lvl}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    {/* Numbers */}
                    <div className="flex gap-1 flex-wrap justify-center">
                      {NUMBER_ROW.map((ch) => {
                        const can = canAddChar(ch);
                        const lvl = inventory._numbers || 0;
                        return (
                          <button
                            key={ch}
                            onPointerDown={(e) => { e.preventDefault(); handleAddChar(ch); }}
                            className={`relative w-8 h-8 rounded-md text-xs font-semibold
                                       transition-all active:scale-95
                              ${can
                                ? 'bg-white text-gray-700 shadow-sm'
                                : 'bg-gray-200 text-gray-400 cursor-not-allowed opacity-50'}`}
                          >
                            {ch}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Forge button */}
                  <button
                    onClick={handleStartMerge}
                    disabled={inputChars.length < 2 || loading}
                    className={`w-full py-3 rounded-xl font-bold text-sm transition-all
                      ${inputChars.length >= 2 && !loading
                        ? 'bg-tg-button text-tg-btn-text active:brightness-90'
                        : 'bg-gray-300 text-gray-400 cursor-not-allowed'}`}
                  >
                    {loading ? '⏳ Iniciando…' : `🔥 Forjar (${inputChars.length}/6 ingredientes)`}
                  </button>

                  {/* Hint section */}
                  <HintSection
                    hints={hints}
                    hintLoading={hintLoading}
                    coins={coins}
                    hintCost={hintCost}
                    allUnlocked={emojiDefs.length > 0 && unlockedEmojis.length === emojiDefs.length}
                    onHint={handleHint}
                  />
                </div>
              )}
            </div>

          <div className="h-6" />
        </div>
      </div>
    </div>
  );
}

// ── Hint section sub-component ────────────────────────────────────────────────
function HintSection({ hints, hintLoading, coins, hintCost, allUnlocked, onHint }) {
  const [expanded, setExpanded] = useState(false);

  if (allUnlocked) return null;

  return (
    <div className="border border-tg-bg-sec rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-tg-bg-sec text-left"
      >
        <span className="text-xs font-semibold text-tg-text">
          🔮 Pistas misteriosas
          {hints.length > 0 && (
            <span className="ml-1.5 text-tg-hint font-normal">({hints.length})</span>
          )}
        </span>
        <span className="text-tg-hint text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="p-3 space-y-3">
          {hints.length === 0 && (
            <p className="text-xs text-tg-hint italic text-center py-1">
              Ninguna pista adquirida aún. Los secretos esperan...
            </p>
          )}
          {hints.map((text, i) => (
            <div key={i} className="flex gap-2 items-start">
              <span className="text-[10px] text-tg-hint font-semibold mt-0.5 shrink-0">
                #{i + 1}
              </span>
              <p className="text-xs text-tg-hint bg-tg-bg rounded-lg px-2.5 py-2
                             leading-relaxed italic flex-1">
                {text}
              </p>
            </div>
          ))}
          <button
            onClick={onHint}
            disabled={hintLoading || coins < hintCost}
            className={`w-full text-xs px-3 py-2 rounded-lg font-semibold transition-colors
              ${hintLoading || coins < hintCost
                ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                : 'bg-tg-button text-tg-btn-text active:brightness-90'}`}
          >
            {hintLoading ? '🔮 Consultando las sombras…' : `Comprar pista misteriosa — ${hintCost} 🪙`}
          </button>
        </div>
      )}
    </div>
  );
}
