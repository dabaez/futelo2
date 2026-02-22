import { useState, useEffect, useCallback } from 'react';

/**
 * BlackMarketModal
 * ────────────────
 * Secret P2P market accessible only via the triple-tap easter egg.
 * Same buy/sell mechanics as the regular market but on a separate listing
 * table — coins flow directly buyer → seller.
 *
 * Intentionally styled dark (hardcoded zinc palette) so it feels
 * visually distinct from the regular shop regardless of Telegram theme.
 *
 * Two tabs:  🛒 Comprar  |  💰 Vender
 */

async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

const LETTER_LABEL = (key) => {
  if (key === '_numbers') return '0-9';
  if (key === '_symbols') return '!?…';
  return key.toUpperCase();
};

export default function BlackMarketModal({
  isOpen,
  onClose,
  initData,
  coins,
  inventory,
  onPurchase,
  socket,
}) {
  const [activeTab, setActiveTab] = useState('buy');
  const [maxPrice,  setMaxPrice]  = useState(500);

  // ── Heat state ────────────────────────────────────────────────────────
  const [heat,        setHeat]        = useState(0);
  const [catchProb,   setCatchProb]   = useState(0.05);
  const [catchFine,   setCatchFine]   = useState(50);
  const [expiryHours, setExpiryHours] = useState(1);
  const [caughtAlert, setCaughtAlert] = useState(null); // { letter, fine }

  // ── Fetch config once ─────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/config').then(safeJson).then((d) => {
      if (d?.MARKET_MAX_PRICE)       setMaxPrice(d.MARKET_MAX_PRICE);
      if (d?.bmHeat        != null)  setHeat(d.bmHeat);
      if (d?.bmCatchProb   != null)  setCatchProb(d.bmCatchProb);
      if (d?.BM_CATCH_FINE != null)  setCatchFine(d.BM_CATCH_FINE);
      if (d?.BM_LISTING_EXPIRY_SEC)  setExpiryHours(Math.round(d.BM_LISTING_EXPIRY_SEC / 3600));
    }).catch(() => {});
  }, []);

  // ── Buy tab state ─────────────────────────────────────────────────────
  const [openListings,    setOpenListings]    = useState([]);
  const [loadingListings, setLoadingListings] = useState(false);
  const [buying,          setBuying]          = useState(null);
  const [buyError,        setBuyError]        = useState(null);

  // ── Sell tab state ────────────────────────────────────────────────────
  const [myListings,    setMyListings]    = useState([]);
  const [loadingMine,   setLoadingMine]   = useState(false);
  const [selectedLetter, setSelectedLetter] = useState(null);
  const [listingPrice,  setListingPrice]  = useState('');
  const [listing,       setListing]       = useState(false);
  const [listError,     setListError]     = useState(null);
  const [cancelling,    setCancelling]    = useState(null);

  // ── Fetch data when tab or modal changes ──────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    if (activeTab === 'buy') {
      setLoadingListings(true);
      setBuyError(null);
      fetch('/api/bm/listings')
        .then(safeJson)
        .then((d) => setOpenListings(Array.isArray(d) ? d : []))
        .catch(() => setBuyError('Error al cargar los listados.'))
        .finally(() => setLoadingListings(false));
    }
    if (activeTab === 'sell') {
      setLoadingMine(true);
      fetch('/api/bm/my-listings', {
        headers: initData ? { 'x-init-data': initData } : {},
      })
        .then(safeJson)
        .then((d) => setMyListings(Array.isArray(d) ? d : []))
        .catch(() => {})
        .finally(() => setLoadingMine(false));
    }
  }, [isOpen, activeTab, initData]);

  // ── Socket: live BM market updates ───────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const onNew = (l) => setOpenListings((p) => p.some((x) => x.id === l.id) ? p : [...p, l]);
    const onSold = ({ listingId }) => {
      setOpenListings((p) => p.filter((l) => l.id !== listingId));
      setMyListings((p) => p.map((l) => l.id === listingId ? { ...l, status: 'sold' } : l));
    };
    const onCancelled = ({ listingId }) => {
      setOpenListings((p) => p.filter((l) => l.id !== listingId));
      setMyListings((p) => p.map((l) => l.id === listingId ? { ...l, status: 'cancelled' } : l));
    };
    const onHeatUpdate = ({ heat: h, catchProb: cp }) => {
      setHeat(h);
      setCatchProb(cp);
    };
    const onCaught = ({ letter, fine, listingId }) => {
      setCaughtAlert({ letter: LETTER_LABEL(letter), fine });
      // Override the 'cancelled' status set by onCancelled with the correct 'caught'
      setMyListings((p) => p.map((l) => l.id === listingId ? { ...l, status: 'caught' } : l));
      setTimeout(() => setCaughtAlert(null), 6000);
    };
    const onExpired = ({ letter, listingId }) => {
      setMyListings((p) => p.map((l) => l.id === listingId ? { ...l, status: 'expired' } : l));
    };
    socket.on('bm_new_listing',       onNew);
    socket.on('bm_listing_sold',       onSold);
    socket.on('bm_listing_cancelled',  onCancelled);
    socket.on('bm_heat_update',        onHeatUpdate);
    socket.on('bm_caught',             onCaught);
    socket.on('bm_listing_expired',    onExpired);
    return () => {
      socket.off('bm_new_listing',       onNew);
      socket.off('bm_listing_sold',       onSold);
      socket.off('bm_listing_cancelled',  onCancelled);
      socket.off('bm_heat_update',        onHeatUpdate);
      socket.off('bm_caught',             onCaught);
      socket.off('bm_listing_expired',    onExpired);
    };
  }, [socket]);

  // ── Reset on close ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) {
      setBuyError(null);
      setListError(null);
      setSelectedLetter(null);
      setListingPrice('');
    }
  }, [isOpen]);

  // ── Buy ───────────────────────────────────────────────────────────────
  const handleBuy = useCallback(async (listingId) => {
    if (buying) return;
    setBuying(listingId);
    setBuyError(null);
    try {
      const r    = await fetch(`/api/bm/buy/${listingId}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || 'Error al comprar.');
      onPurchase?.(data);
    } catch (e) {
      setBuyError(e.message);
    } finally {
      setBuying(null);
    }
  }, [buying, initData, onPurchase]);

  // ── List ──────────────────────────────────────────────────────────────
  const handleList = useCallback(async () => {
    if (!selectedLetter || listing) return;
    const price = parseInt(listingPrice, 10);
    if (!price || price < 1 || price > maxPrice) {
      setListError(`El precio debe ser entre 1 y ${maxPrice}.`);
      return;
    }
    setListing(true);
    setListError(null);
    try {
      const r    = await fetch('/api/bm/list', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
        body:    JSON.stringify({ letter: selectedLetter, price }),
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || 'Error al listar.');
      onPurchase?.(data);
      // Refresh my listings
      const res2 = await fetch('/api/bm/my-listings', {
        headers: initData ? { 'x-init-data': initData } : {},
      });
      const mine = await safeJson(res2);
      setMyListings(Array.isArray(mine) ? mine : []);
      setSelectedLetter(null);
      setListingPrice('');
    } catch (e) {
      setListError(e.message);
    } finally {
      setListing(false);
    }
  }, [selectedLetter, listing, listingPrice, maxPrice, initData, onPurchase]);

  // ── Cancel ────────────────────────────────────────────────────────────
  const handleCancel = useCallback(async (listingId) => {
    if (cancelling) return;
    setCancelling(listingId);
    try {
      const r    = await fetch(`/api/bm/cancel/${listingId}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || 'Error al cancelar.');
      setMyListings((p) => p.map((l) => l.id === listingId ? { ...l, status: 'cancelled' } : l));
    } catch { /* socket event will sync */ } finally {
      setCancelling(null);
    }
  }, [cancelling, initData]);

  // ── Derived ───────────────────────────────────────────────────────────
  const inventoryEntries = Object.entries(inventory || {})
    .filter(([, v]) => v > 0)
    .sort(([a], [b]) => {
      if (a.startsWith('_') && !b.startsWith('_')) return 1;
      if (!a.startsWith('_') &&  b.startsWith('_')) return -1;
      return a.localeCompare(b);
    });

  const openMine = myListings.filter((l) => l.status === 'open');

  if (!isOpen) return null;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Sheet – hardcoded dark palette to emphasise the "secret" feel */}
      <div className="relative z-50 w-full max-w-lg bg-zinc-900 rounded-t-2xl shadow-2xl flex flex-col max-h-[85vh] border-t border-zinc-700">

        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-zinc-700 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">💀</span>
            <h2 className="font-bold text-zinc-100 text-base tracking-wide">Mercado Negro</h2>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 text-xl leading-none active:opacity-60"
          >
            ✕
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-zinc-700 shrink-0">
          {[{ id: 'buy', label: '🛒 Comprar' }, { id: 'sell', label: '💰 Vender' }].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`
                flex-1 py-2.5 text-sm font-medium transition-colors
                ${activeTab === t.id
                  ? 'border-b-2 border-red-500 text-red-400'
                  : 'text-zinc-500'}
              `}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Heat level indicator */}
        <div className="px-4 py-2 border-b border-zinc-800 shrink-0">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1.5">
            <span>🌡️ Calor del mercado</span>
            <span className="tabular-nums">
              {(catchProb * 100).toFixed(0)}% riesgo por chequeo
              {' · '}multa {catchFine} 🪙
              {' · '}expira en {expiryHours}h
            </span>
          </div>
          <div className="w-full h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${Math.min(100, heat)}%`,
                backgroundColor: heat < 33 ? '#22c55e' : heat < 66 ? '#eab308' : '#ef4444',
              }}
            />
          </div>
        </div>

        {/* Tab content */}
        <div className="overflow-y-auto flex-1 p-4 flex flex-col gap-3">

          {/* Caught alert */}
          {caughtAlert && (
            <div className="bg-red-900/70 border border-red-700 rounded-xl px-4 py-3 text-sm text-red-300 animate-pulse">
              ⚠️ ¡Te atraparon vendiendo <strong>{caughtAlert.letter}</strong>! Multado {caughtAlert.fine} 🪙
            </div>
          )}
          {activeTab === 'buy' && (
            <>
              <p className="text-xs text-zinc-500 text-center">
                Letras de otros jugadores — sin preguntas.
              </p>

              {buyError && <p className="text-xs text-red-400 text-center">{buyError}</p>}

              {loadingListings && (
                <p className="text-sm text-zinc-500 text-center py-6">Cargando…</p>
              )}

              {!loadingListings && openListings.length === 0 && (
                <p className="text-sm text-zinc-600 text-center py-6">
                  Nadie ha puesto letras a la venta todavía.
                </p>
              )}

              {!loadingListings && openListings.map((l) => (
                <div
                  key={l.id}
                  className="flex items-center justify-between bg-zinc-800 rounded-xl px-4 py-3"
                >
                  <div>
                    <span className="text-2xl font-bold text-zinc-100 mr-2">
                      {LETTER_LABEL(l.letter)}
                    </span>
                    <span className="text-xs text-zinc-500">
                      de {l.seller_first_name || l.seller_username || 'Anónimo'}
                    </span>
                  </div>
                  <button
                    onClick={() => handleBuy(l.id)}
                    disabled={buying === l.id || coins < l.price}
                    className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-lg px-3 py-1.5 active:opacity-80 disabled:opacity-40 transition-colors"
                  >
                    {buying === l.id ? '…' : `${l.price} 🪙`}
                  </button>
                </div>
              ))}
            </>
          )}

          {/* ── 💰 Sell tab ────────────────────────────────────────────── */}
          {activeTab === 'sell' && (
            <>
              {/* Active own listings */}
              {!loadingMine && openMine.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                    Tus listados activos
                  </p>
                  {openMine.map((l) => (
                    <div
                      key={l.id}
                      className="flex items-center justify-between bg-zinc-800 rounded-xl px-4 py-3"
                    >
                      <div>
                        <span className="text-xl font-bold text-zinc-100 mr-2">
                          {LETTER_LABEL(l.letter)}
                        </span>
                        <span className="text-sm text-zinc-500">{l.price} 🪙</span>
                      </div>
                      <button
                        onClick={() => handleCancel(l.id)}
                        disabled={cancelling === l.id}
                        className="text-xs text-red-400 border border-red-800 rounded-lg px-3 py-1.5 active:opacity-70 disabled:opacity-40"
                      >
                        {cancelling === l.id ? '…' : 'Cancelar'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Pick letter */}
              <div className="flex flex-col gap-2">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Listar nueva letra
                </p>

                {inventoryEntries.length === 0 ? (
                  <p className="text-sm text-zinc-600 text-center py-3">
                    Sin inventario para listar.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {inventoryEntries.map(([key, level]) => (
                      <button
                        key={key}
                        onClick={() => {
                          setSelectedLetter(key === selectedLetter ? null : key);
                          setListError(null);
                        }}
                        className={`
                          relative w-12 h-12 rounded-xl font-bold text-sm flex items-center justify-center transition-colors
                          ${selectedLetter === key
                            ? 'bg-red-700 text-white'
                            : 'bg-zinc-800 text-zinc-200 active:opacity-70'}
                        `}
                      >
                        {LETTER_LABEL(key)}
                        <span className="absolute -top-1 -right-1 text-[9px] bg-zinc-600 text-zinc-300 rounded-full w-4 h-4 flex items-center justify-center leading-none">
                          {level}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {selectedLetter && (
                  <div className="flex flex-col gap-2 mt-1">
                    <p className="text-xs text-zinc-500">
                      Seleccionada: <strong className="text-zinc-200">{LETTER_LABEL(selectedLetter)}</strong>
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min="1"
                        max={maxPrice}
                        value={listingPrice}
                        onChange={(e) => setListingPrice(e.target.value)}
                        placeholder={`Precio (1–${maxPrice})`}
                        className="flex-1 bg-zinc-800 text-zinc-100 placeholder-zinc-600 rounded-xl px-3 py-2 text-sm outline-none border border-zinc-700 focus:border-red-700"
                      />
                      <button
                        onClick={handleList}
                        disabled={listing || !listingPrice}
                        className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-xl px-4 py-2 active:opacity-80 disabled:opacity-40 transition-colors"
                      >
                        {listing ? '…' : 'Listar'}
                      </button>
                    </div>
                    {listError && <p className="text-xs text-red-400">{listError}</p>}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 pb-4 pt-1 shrink-0">
          <p className="text-[11px] text-zinc-700 text-center">
            Saldo actual: {coins} 🪙 · Solo tú sabes que estás aquí
          </p>
        </div>
      </div>
    </div>
  );
}
