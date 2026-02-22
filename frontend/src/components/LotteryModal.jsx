import { useState, useEffect, useCallback } from 'react';

/**
 * LotteryModal
 * ─────────────
 * The letter gambling bottom-sheet.
 *
 * Betting costs a letter from your inventory (not coins).
 * Players can throw multiple letters into the pot per round.
 * Each bet after the first risks being rejected by the
 * gambling-protection system (escalating random chance).
 *
 * States:
 *  – No active round: shows jackpot carry-over + "Start" button
 *  – Active round:    shows countdown, bets by letter, multi-bet letter picker
 *  – Closed:         parent handles via lottery_closed socket event
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzñ';

async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

function formatSecs(sec) {
  if (sec <= 0) return '00:00';
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function LotteryModal({
  isOpen,
  onClose,
  initData,
  coins,
  userId,
  inventory,     // { a: 3, b: 1, ... }
  lotteryRound,  // { id, jackpot, closes_at, bets:[...] } or null
  carryOver,     // accumulated jackpot from previous rounds
  onLotteryStarted,
  onBetPlaced,
  cfg,
}) {
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [pick, setPick]               = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // ── Countdown timer ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!lotteryRound) return;
    const tick = () => {
      const left = lotteryRound.closes_at - Math.floor(Date.now() / 1000);
      setSecondsLeft(Math.max(0, left));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lotteryRound?.closes_at]);

  // Reset error/pick on close
  useEffect(() => {
    if (!isOpen) { setError(null); setPick(null); }
  }, [isOpen]);

  // ── Start round ─────────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    const startCost = cfg?.LOTTERY_START_COST ?? 50;
    if (loading || coins < startCost) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/lottery/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || 'Error al iniciar.');
      onLotteryStarted?.(data);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [loading, coins, cfg, initData, onLotteryStarted]);

  // ── Throw a letter ──────────────────────────────────────────────────────
  const handleBet = useCallback(async () => {
    if (!pick || loading || !lotteryRound) return;
    const inv = inventory || {};
    if ((inv[pick] || 0) < 1) {
      setError(`No tienes "${pick.toUpperCase()}" en tu inventario.`);
      return;
    }
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/lottery/bet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
        body: JSON.stringify({ roundId: lotteryRound.id, letter: pick }),
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || 'Error al apostar.');
      onBetPlaced?.(data.bet, data.jackpot);
      setPick(null);
    } catch (e) {
      setError(e.message);
    }
    finally { setLoading(false); }
  }, [pick, loading, lotteryRound, inventory, initData, onBetPlaced]);

  if (!isOpen) return null;

  const startCost = cfg?.LOTTERY_START_COST ?? 50;
  const coinsPerLetter = cfg?.GAMBLING_COINS_PER_LETTER ?? 50;
  const winLetters     = cfg?.GAMBLING_WIN_LETTERS ?? 2;
  const inv            = inventory || {};
  const isExpired      = !!lotteryRound && Math.floor(Date.now() / 1000) >= lotteryRound.closes_at;

  // My bets in this round
  const myBets = (lotteryRound?.bets || []).filter((b) => b.userId === userId);

  // Group ALL bets by letter for the overview
  const betsByLetter = {};
  (lotteryRound?.bets || []).forEach((b) => {
    if (!betsByLetter[b.letter]) betsByLetter[b.letter] = [];
    betsByLetter[b.letter].push(b.firstName || b.username || '?');
  });

  // Potential jackpot if nobody wins (all bets × 50 coins + current jackpot seed)
  const betCount = lotteryRound?.bets?.length ?? 0;
  const potentialCarry = (lotteryRound?.jackpot ?? 0) + betCount * coinsPerLetter;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Sheet */}
      <div className="relative z-50 w-full max-w-lg bg-tg-bg rounded-t-2xl shadow-2xl flex flex-col max-h-[85vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-tg-bg-sec shrink-0">
          <div>
            <h2 className="font-bold text-tg-text text-base">🎲 Apuestas de letras</h2>
            {lotteryRound && (
              <p className="text-[11px] text-tg-hint">
                Bote: <strong className="text-tg-text">{lotteryRound.jackpot} 🪙</strong>
                {betCount > 0 && (
                  <span className="ml-1 text-emerald-500 font-semibold">
                    · {betCount} {betCount === 1 ? 'letra' : 'letras'} en juego
                  </span>
                )}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-tg-hint text-xl leading-none active:opacity-60">✕</button>
        </div>

        {/* Error banner — sits outside the scroll area so it's always visible */}
        {error && (
          <div className="mx-4 mt-3 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-center shrink-0">
            <p className="text-xs text-amber-800 font-semibold">⚠️ {error}</p>
          </div>
        )}

        <div className="overflow-y-auto flex-1 p-4 flex flex-col gap-4">

          {/* ── No active round ─────────────────────────────────────────── */}
          {!lotteryRound && (
            <div className="flex flex-col items-center gap-3">
              {carryOver > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-center w-full">
                  <p className="text-xs text-amber-700 font-semibold">🏦 Bote acumulado</p>
                  <p className="text-2xl font-bold text-amber-600">{carryOver} 🪙</p>
                </div>
              )}
              <div className="bg-tg-bg-sec rounded-xl px-4 py-3 text-sm text-tg-hint text-center w-full space-y-1">
                <p>🎲 Cada apuesta cuesta <strong className="text-tg-text">una letra</strong> de tu inventario.</p>
                <p>Adivina la letra secreta y gana <strong className="text-tg-text">+{winLetters} niveles</strong> de esa letra más <strong className="text-tg-text">{coinsPerLetter} 🪙</strong> por cada letra de los demás.</p>
                <p className="text-[11px]">Segunda apuesta en adelante: protección antiapuestas activa.</p>
              </div>
              <button
                onClick={handleStart}
                disabled={loading || coins < startCost}
                className="bg-tg-button text-tg-btn-text font-semibold rounded-xl py-3 px-8 active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? 'Iniciando…' : `Iniciar ronda por ${startCost} 🪙`}
              </button>
              <p className="text-xs text-tg-hint">Saldo: {coins} 🪙</p>
            </div>
          )}

          {/* ── Active round ─────────────────────────────────────────────── */}
          {lotteryRound && (
            <>
              {/* Timer */}
              <div className="flex items-center justify-center gap-3">
                <div className={`text-2xl font-mono font-bold ${secondsLeft < 30 ? 'text-red-500' : 'text-tg-text'}`}>
                  {formatSecs(secondsLeft)}
                </div>
                <div className="text-xs text-tg-hint">
                  {isExpired ? '⏰ Cerrando…' : 'para adivinar'}
                </div>
              </div>

              {/* Bets summary by letter */}
              {Object.keys(betsByLetter).length > 0 && (
                <div className="bg-tg-bg-sec rounded-xl p-3">
                  <p className="text-[11px] text-tg-hint mb-2 font-semibold">
                    Letras en juego ({betCount})
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(betsByLetter).map(([letter, names]) => (
                      <div key={letter} className="bg-tg-bg rounded-lg px-2 py-1 flex items-center gap-1">
                        <span className="font-bold text-tg-text text-sm">{letter.toUpperCase()}</span>
                        <span className="text-[10px] text-tg-hint">×{names.length}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* My bets this round */}
              {myBets.length > 0 && (
                <div className="bg-tg-bg-sec rounded-xl p-3">
                  <p className="text-[11px] text-tg-hint mb-1 font-semibold">Tus apuestas ({myBets.length})</p>
                  <div className="flex flex-wrap gap-1.5">
                    {myBets.map((b, i) => (
                      <span key={i} className="bg-tg-bg border border-tg-button/30 rounded-lg px-2 py-1 text-sm font-bold text-tg-button">
                        {b.letter.toUpperCase()}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Letter picker (hidden if expired) */}
              {!isExpired && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-tg-hint text-center">
                    {myBets.length === 0
                      ? 'Primera apuesta: siempre funciona'
                      : `Apuesta #${myBets.length + 1}: mayor riesgo de protección antiapuestas`}
                  </p>
                  <div className="grid grid-cols-7 gap-1.5">
                    {ALPHABET.split('').map((l) => {
                      const stock = inv[l] || 0;
                      const sel   = pick === l;
                      const noStock = stock < 1;
                      return (
                        <button
                          key={l}
                          onClick={() => !noStock && setPick(sel ? null : l)}
                          disabled={noStock}
                          className={`
                            relative rounded-lg py-2 text-sm font-bold transition-colors
                            ${noStock
                              ? 'bg-tg-bg-sec text-tg-hint opacity-30 cursor-not-allowed'
                              : sel
                                ? 'bg-tg-button text-tg-btn-text ring-2 ring-tg-button'
                                : 'bg-tg-bg-sec text-tg-text active:opacity-70'}
                          `}
                        >
                          {l.toUpperCase()}
                          {!noStock && (
                            <span className="block text-[8px] leading-none text-current opacity-70">{stock}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    onClick={handleBet}
                    disabled={!pick || loading}
                    className="bg-tg-button text-tg-btn-text font-semibold rounded-xl py-3 active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {loading
                      ? 'Apostando…'
                      : pick
                        ? `Lanzar "${pick.toUpperCase()}" al bote`
                        : 'Elige una letra'}
                  </button>

                  <p className="text-[11px] text-tg-hint text-center">
                    Ganador: +{winLetters} del acierto · +{coinsPerLetter} 🪙 por cada letra de los demás
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

