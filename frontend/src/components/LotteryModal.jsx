import { useState, useEffect, useCallback } from 'react';

/**
 * LotteryModal
 * ─────────────
 * The letter lottery bottom-sheet.
 *
 * States:
 *  – No active round: shows jackpot carryover + "Start lottery" button
 *  – Active round:    shows countdown, current bets grid, letter picker + bet button
 *  – Closed (brief):  parent handles via lottery_closed socket event
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
  lotteryRound,      // { id, jackpot, closesAt, bets:[...] } or null
  carryOver,         // accumulated jackpot from previous rounds
  onLotteryStarted,  // (roundData) => void
  onBetPlaced,       // (bet, jackpot) => void
  cfg,
}) {
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [pick, setPick]         = useState(null);   // letter user is about to bet
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

  // Reset on close
  useEffect(() => {
    if (!isOpen) { setError(null); setPick(null); }
  }, [isOpen]);

  // ── Start lottery ───────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (loading || coins < (cfg?.LOTTERY_START_COST || 200)) return;
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

  // ── Place bet ───────────────────────────────────────────────────────────
  const handleBet = useCallback(async () => {
    if (!pick || loading || !lotteryRound) return;
    if (coins < (cfg?.LOTTERY_BET_AMOUNT || 50)) {
      setError(`Necesitas ${cfg?.LOTTERY_BET_AMOUNT || 50} 🪙 para apostar.`);
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
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [pick, loading, lotteryRound, coins, cfg, initData, onBetPlaced]);

  if (!isOpen) return null;

  const startCost  = cfg?.LOTTERY_START_COST || 200;
  const betAmount  = cfg?.LOTTERY_BET_AMOUNT  || 50;
  const myBet      = lotteryRound?.bets?.find((b) => b.userId === userId);
  // Compare against real timestamp so this is never wrong on first render
  // (secondsLeft starts at 0, which would incorrectly flag as expired).
  const isExpired  = !!lotteryRound && Math.floor(Date.now() / 1000) >= lotteryRound.closes_at;

  // Group bets by letter for display
  const betsByLetter = {};
  (lotteryRound?.bets || []).forEach((b) => {
    if (!betsByLetter[b.letter]) betsByLetter[b.letter] = [];
    betsByLetter[b.letter].push(b.firstName || b.username);
  });

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Sheet */}
      <div className="relative z-50 w-full max-w-lg bg-tg-bg rounded-t-2xl shadow-2xl flex flex-col max-h-[85vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-tg-bg-sec shrink-0">
          <div>
            <h2 className="font-bold text-tg-text text-base">🎲 Lotería de letras</h2>
            {lotteryRound && (
              <p className="text-[11px] text-tg-hint">
                Bote: <strong className="text-tg-text">{lotteryRound.jackpot} 🪙</strong>
                {lotteryRound.jackpot > 0 && (
                  <span className="ml-1 text-emerald-500 font-bold">
                    → Premio: {lotteryRound.jackpot * 2} 🪙
                  </span>
                )}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-tg-hint text-xl leading-none active:opacity-60">✕</button>
        </div>

        <div className="overflow-y-auto flex-1 p-4 flex flex-col gap-4">

          {error && (
            <p className="text-xs text-red-500 text-center bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}

          {/* ── No active round ─────────────────────────────────────────── */}
          {!lotteryRound && (
            <div className="flex flex-col items-center gap-3">
              {carryOver > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-center w-full">
                  <p className="text-xs text-amber-700 font-semibold">
                    🏦 Bote acumulado de rondas anteriores
                  </p>
                  <p className="text-2xl font-bold text-amber-600">{carryOver} 🪙</p>
                  <p className="text-[11px] text-amber-600 mt-0.5">
                    → Premio si alguien gana: {(carryOver + startCost) * 2} 🪙
                  </p>
                </div>
              )}
              <p className="text-sm text-tg-hint text-center">
                Paga {startCost} 🪙 para iniciar una nueva ronda.{' '}
                Se elige una letra al azar y los jugadores apuestan.
              </p>
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
                  {isExpired ? '⏰ Cerrando…' : 'para apostar'}
                </div>
              </div>

              {/* Current bets summary */}
              {Object.keys(betsByLetter).length > 0 && (
                <div className="bg-tg-bg-sec rounded-xl p-3">
                  <p className="text-[11px] text-tg-hint mb-2 font-semibold">
                    Apuestas ({lotteryRound.bets?.length || 0})
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(betsByLetter).map(([letter, names]) => (
                      <div key={letter} className="bg-tg-bg rounded-lg px-2 py-1 flex items-center gap-1">
                        <span className="font-bold text-tg-text text-sm">{letter.toUpperCase()}</span>
                        <span className="text-[10px] text-tg-hint">{names.join(', ')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Already bet */}
              {myBet && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-center">
                  <p className="text-xs text-emerald-700 font-semibold">
                    ✓ Tu apuesta: <span className="text-xl font-black">{myBet.letter.toUpperCase()}</span>
                  </p>
                  <p className="text-[11px] text-emerald-600 mt-0.5">
                    Premio si aciertas:{' '}
                    <strong>{Math.floor((lotteryRound.jackpot * 2) / (betsByLetter[myBet.letter]?.length || 1))} 🪙</strong>
                  </p>
                </div>
              )}

              {/* Letter picker (hidden if already bet or expired) */}
              {!myBet && !isExpired && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-tg-hint text-center">
                    Elige una letra y apuesta {betAmount} 🪙
                  </p>
                  <div className="grid grid-cols-7 gap-1.5">
                    {ALPHABET.split('').map((l) => {
                      const taken = betsByLetter[l] !== undefined;
                      const sel   = pick === l;
                      return (
                        <button
                          key={l}
                          onClick={() => setPick(sel ? null : l)}
                          className={`
                            rounded-lg py-2 text-sm font-bold transition-colors
                            ${sel
                              ? 'bg-tg-button text-tg-btn-text ring-2 ring-tg-button'
                              : taken
                                ? 'bg-tg-bg-sec text-tg-hint'
                                : 'bg-tg-bg-sec text-tg-text active:opacity-70'}
                          `}
                        >
                          {l.toUpperCase()}
                          {taken && <span className="block text-[8px] leading-none">●</span>}
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
                        ? `Apostar por "${pick.toUpperCase()}" — ${betAmount} 🪙`
                        : 'Elige una letra'}
                  </button>

                  <p className="text-xs text-tg-hint text-center">Saldo: {coins} 🪙</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
