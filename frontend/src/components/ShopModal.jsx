import React, { useState, useEffect } from 'react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || '';

/**
 * ShopModal
 * ─────────
 * Slide-up bottom sheet for rolls, letter selling, and prompt firing.
 *
 * Sell section has two tabs:
 *   🏪 Mercado normal – instant sale, SELL_COMMISSION_RATE tax deducted.
 *   🕵️ Mercado negro  – listing system. Letter is escrowed immediately.
 *       Every minute the server rolls for a catch; probability grows with:
 *         • Global heat (catches + "mercado negro" mentions in chat).
 *         • Time spent listed (more rolls = higher cumulative chance).
 *       User collects coins manually while listing is still pending.
 *       Uncollected listings expire after BLACK_MARKET_LISTING_SEC (letter returned).
 */
export default function ShopModal({
  isOpen, onClose, initData, coins, inventory, onPurchase, onPromptFired, socket,
}) {
  /* ── Roll ──────────────────────────────────────────────────────────────── */
  const [rolling,       setRolling]      = useState(false);
  const [lastRoll,      setLastRoll]     = useState(null);
  const [rollError,     setRollError]    = useState(null);

  /* ── Prompt ────────────────────────────────────────────────────────────── */
  const [promptBuying,  setPromptBuying]  = useState(false);
  const [promptSuccess, setPromptSuccess] = useState(false);
  const [promptError,   setPromptError]   = useState(null);

  /* ── Sell tab ──────────────────────────────────────────────────────────── */
  const [sellTab, setSellTab] = useState('normal'); // 'normal' | 'black'

  /* ── Normal sell ───────────────────────────────────────────────────────── */
  const [normalSelling, setNormalSelling] = useState(null);
  const [normalResult,  setNormalResult]  = useState(null);
  const [normalError,   setNormalError]   = useState(null);

  /* ── Black market ──────────────────────────────────────────────────────── */
  const [bmHeat,        setBmHeat]        = useState(0);
  const [bmCatchProb,   setBmCatchProb]   = useState(0.04);
  const [bmListings,    setBmListings]    = useState([]);
  const [bmListing,     setBmListing]     = useState(null);   // letter being listed
  const [bmListResult,  setBmListResult]  = useState(null);
  const [bmListError,   setBmListError]   = useState(null);
  const [bmCollecting,  setBmCollecting]  = useState(null);   // listingId being collected
  const [, setNow]                        = useState(Date.now()); // countdown re-renders

  /* ── Config ────────────────────────────────────────────────────────────── */
  const [cfg, setCfg] = useState({
    ROLL_COST: 50, ROLL_COUNT: 3, PROMPT_BUY_COST: 200,
    SELL_BASE_PRICE: 15, SELL_COMMISSION_RATE: 0.20,
    BLACK_MARKET_FINE: 40, BLACK_MARKET_BASE_PROB: 0.04,
    BLACK_MARKET_LISTING_SEC: 600,
  });

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/config`)
      .then((r) => r.json())
      .then((data) => setCfg((prev) => ({ ...prev, ...data })))
      .catch(() => {});
  }, []);

  /* ── Fetch heat + listings on open ────────────────────────────────────── */
  useEffect(() => {
    if (!isOpen || !initData) return;
    fetch(`${BACKEND_URL}/api/blackmarket/heat`)
      .then((r) => r.json())
      .then((d) => { setBmHeat(d.heat || 0); setBmCatchProb(d.catchProbPerMin || 0.04); })
      .catch(() => {});
    fetch(`${BACKEND_URL}/api/blackmarket/listings`, { headers: { 'x-init-data': initData } })
      .then((r) => r.json())
      .then((d) => setBmListings(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [isOpen, initData]);

  /* ── Socket listeners (in-modal state sync) ────────────────────────────── */
  useEffect(() => {
    if (!socket || !isOpen) return;
    const onHeat    = ({ heat, catchProbPerMin }) => { setBmHeat(heat); setBmCatchProb(catchProbPerMin); };
    const onCaught  = ({ listingId }) => setBmListings((p) => p.map((l) => l.id === listingId ? { ...l, status: 'caught'  } : l));
    const onExpired = ({ listingId }) => setBmListings((p) => p.map((l) => l.id === listingId ? { ...l, status: 'expired' } : l));
    socket.on('bm_heat_update', onHeat);
    socket.on('bm_caught',      onCaught);
    socket.on('bm_expired',     onExpired);
    return () => {
      socket.off('bm_heat_update', onHeat);
      socket.off('bm_caught',      onCaught);
      socket.off('bm_expired',     onExpired);
    };
  }, [socket, isOpen]);

  /* ── Countdown ticker for black market listing times ───────────────────── */
  useEffect(() => {
    if (!isOpen || sellTab !== 'black') return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [isOpen, sellTab]);

  if (!isOpen) return null;

  /* ── Derived values ────────────────────────────────────────────────────── */
  const invEntries    = Object.entries(inventory || {}).sort(([a], [b]) => a.localeCompare(b));
  const canAfford     = coins >= cfg.ROLL_COST;
  const canAffordPmt  = coins >= cfg.PROMPT_BUY_COST;
  const normalEarned  = Math.floor(cfg.SELL_BASE_PRICE * (1 - cfg.SELL_COMMISSION_RATE));
  const pendingBm     = bmListings.filter((l) => l.status === 'pending');
  const recentBm      = bmListings.filter((l) => l.status !== 'pending').slice(0, 5);
  const listedSet     = new Set(pendingBm.map((l) => l.letter));
  const listableEntries = invEntries.filter(([l]) => !listedSet.has(l));
  const nowSec        = Math.floor(Date.now() / 1000);
  const heatPct       = Math.min(bmHeat, 1);
  const heatColor     = heatPct < 0.2 ? 'bg-green-500' : heatPct < 0.5 ? 'bg-amber-500' : 'bg-red-500';
  const heatTextColor = heatPct < 0.2 ? 'text-green-600' : heatPct < 0.5 ? 'text-amber-500' : 'text-red-500';
  const heatLabel     = heatPct < 0.2 ? 'Baja' : heatPct < 0.5 ? 'Media' : 'Alta';

  const fmtAgo = (listed_at) => {
    const mins = Math.floor((nowSec - listed_at) / 60);
    return mins < 1 ? 'hace <1 min' : `hace ${mins} min`;
  };
  const fmtExpiry = (listed_at) => {
    const rem = cfg.BLACK_MARKET_LISTING_SEC - (nowSec - listed_at);
    if (rem <= 0) return 'expirando…';
    return `${Math.ceil(rem / 60)} min restantes`;
  };

  /* ── Actions ───────────────────────────────────────────────────────────── */
  async function handleRoll() {
    setRolling(true); setRollError(null); setLastRoll(null);
    try {
      const res  = await fetch(`${BACKEND_URL}/api/shop/roll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData },
        body: JSON.stringify({ initData }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setLastRoll(data.newLetters);
      onPurchase(data);
    } catch (e) { setRollError(e.message); }
    finally { setRolling(false); }
  }

  async function handleNormalSell(letter) {
    setNormalSelling(letter); setNormalError(null); setNormalResult(null);
    try {
      const res  = await fetch(`${BACKEND_URL}/api/shop/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData },
        body: JSON.stringify({ letter }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setNormalResult(data);
      onPurchase(data);
    } catch (e) { setNormalError(e.message); }
    finally { setNormalSelling(null); }
  }

  async function handleListLetter(letter) {
    setBmListing(letter); setBmListError(null); setBmListResult(null);
    try {
      const res  = await fetch(`${BACKEND_URL}/api/blackmarket/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData },
        body: JSON.stringify({ letter }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setBmListings((prev) => [
        { id: data.listingId, letter: data.letter, listed_at: data.listedAt, status: 'pending', coins_delta: 0 },
        ...prev,
      ]);
      setBmHeat(data.heat);
      setBmCatchProb(data.catchProbPerMin);
      setBmListResult(data.letter);
      onPurchase({ newInventory: data.newInventory });
    } catch (e) { setBmListError(e.message); }
    finally { setBmListing(null); }
  }

  async function handleCollect(listingId) {
    setBmCollecting(listingId); setBmListError(null);
    try {
      const res  = await fetch(`${BACKEND_URL}/api/blackmarket/collect/${listingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setBmListings((prev) => prev.map((l) =>
        l.id === listingId ? { ...l, status: 'collected', coins_delta: data.earned } : l
      ));
      onPurchase({ newCoins: data.newCoins });
    } catch (e) { setBmListError(e.message); }
    finally { setBmCollecting(null); }
  }

  async function handleBuyPrompt() {
    setPromptBuying(true); setPromptError(null); setPromptSuccess(false);
    try {
      const res  = await fetch(`${BACKEND_URL}/api/shop/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData },
        body: JSON.stringify({ initData }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPromptSuccess(true);
      onPromptFired?.(data);
      setTimeout(onClose, 1200);
    } catch (e) { setPromptError(e.message); }
    finally { setPromptBuying(false); }
  }

  /* ── Render ─────────────────────────────────────────────────────────────── */
  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40 animate-fade-in" onClick={onClose} />

      {/* Sheet */}
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-tg-bg rounded-t-2xl shadow-xl animate-slide-up overflow-y-auto max-h-[90vh]">
        {/* Handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 rounded-full bg-gray-300" />
        </div>

        <div className="px-4 pb-8">

          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-tg-text">Tienda de letras 🛒</h2>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-tg-bg-sec text-tg-hint text-lg">×</button>
          </div>

          {/* Coin balance */}
          <div className="bg-tg-bg-sec rounded-xl px-4 py-3 mb-4 flex items-center justify-between">
            <span className="text-tg-hint text-sm">Tu saldo</span>
            <span className="font-bold text-tg-text text-lg">{coins} 🪙</span>
          </div>

          {/* ── Roll card ─────────────────────────────────────────────────── */}
          <div className="border border-tg-bg-sec rounded-xl p-4 mb-4">
            <div className="flex items-start gap-3 mb-3">
              <span className="text-3xl">🎰</span>
              <div>
                <p className="font-semibold text-tg-text">Tirada de letras</p>
                <p className="text-sm text-tg-hint">Obtén {cfg.ROLL_COUNT} letras aleatorias y aumenta tu nivel de desbloqueo.</p>
              </div>
            </div>
            {lastRoll && (
              <div className="flex gap-2 justify-center mb-3">
                {lastRoll.map((letter, i) => (
                  <div key={i} className="w-10 h-10 rounded-lg bg-tg-button text-tg-btn-text flex items-center justify-center text-lg font-bold uppercase animate-bounce-once" style={{ animationDelay: `${i * 0.08}s` }}>
                    {letter}
                  </div>
                ))}
              </div>
            )}
            {rollError && <p className="text-red-500 text-sm text-center mb-2">{rollError}</p>}
            <button onClick={handleRoll} disabled={rolling || !canAfford}
              className={`w-full py-3 rounded-xl font-semibold text-sm transition-opacity ${canAfford ? 'bg-tg-button text-tg-btn-text active:opacity-80' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}>
              {rolling ? 'Tirando…' : !canAfford ? `Necesitas ${cfg.ROLL_COST} monedas` : `Tirar por ${cfg.ROLL_COST} 🪙`}
            </button>
          </div>

          {/* ── Sell card ─────────────────────────────────────────────────── */}
          {invEntries.length > 0 && (
            <div className="border border-tg-bg-sec rounded-xl p-4 mb-4">
              <div className="flex items-start gap-3 mb-3">
                <span className="text-3xl">💰</span>
                <div>
                  <p className="font-semibold text-tg-text">Vender letras</p>
                  <p className="text-sm text-tg-hint">Elige cómo cambiar un nivel de letra por monedas.</p>
                </div>
              </div>

              {/* Tab toggle */}
              <div className="flex gap-2 mb-4">
                <button onClick={() => { setSellTab('normal'); setNormalResult(null); setNormalError(null); }}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${sellTab === 'normal' ? 'bg-tg-button text-tg-btn-text' : 'bg-tg-bg-sec text-tg-hint'}`}>
                  🏪 Mercado normal
                </button>
                <button onClick={() => { setSellTab('black'); setBmListResult(null); setBmListError(null); }}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${sellTab === 'black' ? 'bg-gray-800 text-white' : 'bg-tg-bg-sec text-tg-hint'}`}>
                  🕵️ Mercado negro
                </button>
              </div>

              {/* ── Normal tab ──────────────────────────────────────────── */}
              {sellTab === 'normal' && (
                <>
                  <p className="text-xs text-tg-hint mb-3">
                    Venta inmediata. Recibes <span className="font-semibold text-tg-text">{normalEarned} 🪙</span> por nivel
                    — <span className="text-amber-500">comisión {Math.round(cfg.SELL_COMMISSION_RATE * 100)}% incluida</span>.
                  </p>
                  <div className="grid grid-cols-7 gap-1 mb-2">
                    {invEntries.map(([letter, count]) => (
                      <button key={letter} onClick={() => handleNormalSell(letter)} disabled={normalSelling !== null}
                        className={`flex flex-col items-center rounded-lg py-1.5 px-1 transition-opacity
                          ${normalSelling === letter ? 'bg-tg-button text-tg-btn-text opacity-60' : 'bg-tg-bg-sec text-tg-text active:opacity-70'}
                          ${normalSelling !== null && normalSelling !== letter ? 'opacity-40' : ''}`}>
                        <span className="text-sm font-bold uppercase">{letter}</span>
                        <span className={`text-[10px] font-semibold ${normalSelling === letter ? 'text-tg-btn-text' : 'text-tg-button'}`}>{count}</span>
                      </button>
                    ))}
                  </div>
                  {normalResult && (
                    <p className="text-emerald-600 text-sm text-center font-semibold">
                      ✅ Vendiste &quot;{normalResult.letter.toUpperCase()}&quot; → +{normalResult.earned} 🪙
                    </p>
                  )}
                  {normalError && <p className="text-red-500 text-sm text-center">{normalError}</p>}
                </>
              )}

              {/* ── Black market tab ────────────────────────────────────── */}
              {sellTab === 'black' && (
                <>
                  {/* Heat bar */}
                  <div className="mb-4">
                    <div className="flex justify-between items-center text-xs mb-1">
                      <span className="text-tg-hint font-medium">🌡️ Actividad policial</span>
                      <span className={`font-bold ${heatTextColor}`}>{heatLabel}</span>
                    </div>
                    <div className="h-2.5 bg-tg-bg-sec rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-700 ${heatColor}`}
                        style={{ width: `${Math.max(heatPct * 100, 3)}%` }} />
                    </div>
                    <p className="text-[10px] text-tg-hint mt-1">
                      Prob. de arresto: ~{(bmCatchProb * 100).toFixed(0)}% / min · Sube con capturas y menciones al mercado negro en el chat
                    </p>
                  </div>

                  <p className="text-xs text-tg-hint mb-4 leading-relaxed">
                    Sin comisión: cobras <span className="font-semibold text-tg-text">{cfg.SELL_BASE_PRICE} 🪙</span> cuando recojas.
                    Cada minuto el servidor revisa si te pilla — a más tiempo en el mercado, más riesgo.
                    Si te pillan: multa de <span className="text-red-500 font-semibold">−{cfg.BLACK_MARKET_FINE} 🪙</span>.
                    Los listados expiran automáticamente en{' '}
                    <span className="font-semibold text-tg-text">{cfg.BLACK_MARKET_LISTING_SEC / 60} min</span> y la letra regresa.
                  </p>

                  {/* Active listings */}
                  {pendingBm.length > 0 && (
                    <div className="mb-4">
                      <p className="text-[10px] font-semibold text-tg-hint uppercase tracking-wide mb-2">Listados activos</p>
                      <div className="space-y-2">
                        {pendingBm.map((l) => (
                          <div key={l.id} className="flex items-center justify-between bg-tg-bg-sec rounded-lg px-3 py-2.5">
                            <div>
                              <span className="font-bold text-tg-text uppercase">{l.letter}</span>
                              <span className="text-[10px] text-tg-hint ml-2">{fmtAgo(l.listed_at)} · {fmtExpiry(l.listed_at)}</span>
                            </div>
                            <button onClick={() => handleCollect(l.id)} disabled={bmCollecting === l.id}
                              className="text-xs font-semibold bg-emerald-600 text-white rounded-lg px-3 py-1.5 active:opacity-70 disabled:opacity-50">
                              {bmCollecting === l.id ? '…' : `Cobrar ${cfg.SELL_BASE_PRICE} 🪙`}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recent history */}
                  {recentBm.length > 0 && (
                    <div className="mb-4">
                      <p className="text-[10px] font-semibold text-tg-hint uppercase tracking-wide mb-2">Historial reciente</p>
                      <div className="space-y-1">
                        {recentBm.map((l) => (
                          <div key={l.id}
                            className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-xs
                              ${l.status === 'caught'    ? 'bg-red-100 text-red-700'       : ''}
                              ${l.status === 'collected' ? 'bg-emerald-100 text-emerald-700' : ''}
                              ${l.status === 'expired'   ? 'bg-tg-bg-sec text-tg-hint'       : ''}`}>
                            <span className="font-bold uppercase">{l.letter}</span>
                            <span>
                              {l.status === 'caught'    && `⚠️ Atrapado (−${cfg.BLACK_MARKET_FINE} 🪙)`}
                              {l.status === 'collected' && `✅ Cobrado (+${cfg.SELL_BASE_PRICE} 🪙)`}
                              {l.status === 'expired'   && '⏰ Expirado — letra devuelta'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* List new letter grid */}
                  {listableEntries.length > 0 ? (
                    <>
                      <p className="text-[10px] font-semibold text-tg-hint uppercase tracking-wide mb-2">Listar nueva letra</p>
                      <div className="grid grid-cols-7 gap-1 mb-3">
                        {listableEntries.map(([letter, count]) => (
                          <button key={letter} onClick={() => handleListLetter(letter)} disabled={bmListing !== null}
                            className={`flex flex-col items-center rounded-lg py-1.5 px-1 transition-opacity bg-gray-800 text-white active:opacity-70
                              ${bmListing === letter ? 'opacity-50' : ''}
                              ${bmListing !== null && bmListing !== letter ? 'opacity-30' : ''}`}>
                            <span className="text-sm font-bold uppercase">{letter}</span>
                            <span className="text-[10px] text-gray-400 font-semibold">{count}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-tg-hint text-center py-2">
                      {invEntries.length === 0 ? 'Sin letras en inventario.' : 'Todas las letras ya están listadas.'}
                    </p>
                  )}

                  {bmListResult && (
                    <p className="text-emerald-600 text-sm text-center font-semibold mb-1">
                      🕵️ &quot;{bmListResult.toUpperCase()}&quot; en el mercado negro. ¡Recoge antes de que te pillen!
                    </p>
                  )}
                  {bmListError && <p className="text-red-500 text-sm text-center">{bmListError}</p>}
                </>
              )}
            </div>
          )}

          {/* ── Inventory (read-only) ──────────────────────────────────────── */}
          {invEntries.length > 0 && (
            <>
              <p className="text-xs text-tg-hint mb-2 font-semibold uppercase tracking-wide">Tu inventario</p>
              <div className="grid grid-cols-7 gap-1 mb-4">
                {invEntries.map(([letter, count]) => (
                  <div key={letter} className="flex flex-col items-center bg-tg-bg-sec rounded-lg py-1.5 px-1">
                    <span className="text-sm font-bold text-tg-text uppercase">{letter}</span>
                    <span className="text-[10px] text-tg-button font-semibold">{count}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── Prompt card ───────────────────────────────────────────────── */}
          <div className="border border-tg-bg-sec rounded-xl p-4">
            <div className="flex items-start gap-3 mb-3">
              <span className="text-3xl">📣</span>
              <div>
                <p className="font-semibold text-tg-text">Lanzar un prompt</p>
                <p className="text-sm text-tg-hint">Inicia un prompt comunitario. El ganador recibe +100 🪙.</p>
              </div>
            </div>
            {promptSuccess && <p className="text-emerald-500 text-sm text-center mb-2 font-semibold">🎉 ¡Prompt lanzado!</p>}
            {promptError  && <p className="text-red-500 text-sm text-center mb-2">{promptError}</p>}
            <button onClick={handleBuyPrompt} disabled={promptBuying || !canAffordPmt}
              className={`w-full py-3 rounded-xl font-semibold text-sm transition-opacity ${canAffordPmt ? 'bg-tg-button text-tg-btn-text active:opacity-80' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}>
              {promptBuying ? 'Lanzando…' : !canAffordPmt ? `Necesitas ${cfg.PROMPT_BUY_COST} monedas` : `Lanzar por ${cfg.PROMPT_BUY_COST} 🪙`}
            </button>
          </div>

        </div>
      </div>
    </>
  );
}

