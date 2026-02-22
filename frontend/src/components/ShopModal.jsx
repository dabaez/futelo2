import { useState, useEffect, useCallback } from 'react';

/**
 * ShopModal
 * ─────────
 * Four-tab bottom-sheet:
 *  🎰 Tirada  – spend coins to roll random letter unlocks
 *  🛒 Comprar – browse other players' listings and buy letters
 *  💰 Vender  – list own letters for sale; manage open listings
 *  📣 Prompt  – fire a community question (costs PROMPT_BUY_COST coins)
 */
/** Safely parse a fetch Response as JSON; returns null on non-JSON bodies. */
async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

export default function ShopModal({
  isOpen,
  onClose,
  initData,
  coins,
  inventory,
  onPurchase,
  onPromptFired,
  socket,
}) {
  // ── Tab state ────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('roll');

  // ── Config from server ───────────────────────────────────────────────────
  const [cfg, setCfg] = useState({
    ROLL_COST: 50, ROLL_COST_SCALE: 2, ROLL_COUNT: 3,
    SELL_BASE_PRICE: 15, MARKET_MAX_PRICE: 500,
    PROMPT_BUY_COST: 200, PROMPT_WINNER_BONUS: 100,
    PROMPT_RUNNER_UP_BONUS: 30, PROMPT_DURATION_SEC: 180,
  });

  // ── Roll tab state ───────────────────────────────────────────────────────
  const [rolling, setRolling]       = useState(false);
  const [rollResult, setRollResult] = useState(null);
  const [rollError, setRollError]   = useState(null);

  // ── Market: buy tab state ────────────────────────────────────────────────
  const [openListings, setOpenListings]       = useState([]);
  const [loadingListings, setLoadingListings] = useState(false);
  const [buying, setBuying]                   = useState(null); // listingId being purchased
  const [buyError, setBuyError]               = useState(null);

  // ── Market: sell tab state ───────────────────────────────────────────────
  const [myListings, setMyListings]           = useState([]);
  const [loadingMine, setLoadingMine]         = useState(false);
  const [selectedLetter, setSelectedLetter]   = useState(null);
  const [listingPrice, setListingPrice]       = useState('');
  const [listing, setListing]                 = useState(false);
  const [listError, setListError]             = useState(null);
  const [cancelling, setCancelling]           = useState(null); // listingId

  // ── Prompt tab state ─────────────────────────────────────────────────────
  const [firingPrompt, setFiringPrompt] = useState(false);
  const [promptError, setPromptError]   = useState(null);

  // ── Fetch config on mount ────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => {});
  }, []);

  // ── Fetch market data when tab changes or modal opens ───────────────────
  useEffect(() => {
    if (!isOpen) return;
    if (activeTab === 'buy') {
      setLoadingListings(true);
      setBuyError(null);
      fetch('/api/market/listings')
        .then(safeJson)
        .then((data) => setOpenListings(Array.isArray(data) ? data : []))
        .catch(() => setBuyError('Error al cargar los listados.'))
        .finally(() => setLoadingListings(false));
    }
    if (activeTab === 'sell') {
      setLoadingMine(true);
      fetch('/api/market/my-listings', {
        headers: initData ? { 'x-init-data': initData } : {},
      })
        .then(safeJson)
        .then((data) => setMyListings(Array.isArray(data) ? data : []))
        .catch(() => {})
        .finally(() => setLoadingMine(false));
    }
  }, [isOpen, activeTab, initData]);

  // ── Socket listeners for live market updates ─────────────────────────────
  useEffect(() => {
    if (!socket) return;

    const onNewListing = (newListing) => {
      setOpenListings((prev) => {
        if (prev.some((l) => l.id === newListing.id)) return prev;
        return [...prev, newListing];
      });
    };
    const onSold = ({ listingId }) => {
      setOpenListings((prev) => prev.filter((l) => l.id !== listingId));
      setMyListings((prev) =>
        prev.map((l) => l.id === listingId ? { ...l, status: 'sold' } : l)
      );
    };
    const onCancelled = ({ listingId }) => {
      setOpenListings((prev) => prev.filter((l) => l.id !== listingId));
      setMyListings((prev) =>
        prev.map((l) => l.id === listingId ? { ...l, status: 'cancelled' } : l)
      );
    };

    socket.on('new_market_listing',      onNewListing);
    socket.on('market_listing_sold',      onSold);
    socket.on('market_listing_cancelled', onCancelled);

    return () => {
      socket.off('new_market_listing',      onNewListing);
      socket.off('market_listing_sold',      onSold);
      socket.off('market_listing_cancelled', onCancelled);
    };
  }, [socket]);

  // ── Reset on close ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) {
      setRollResult(null);
      setRollError(null);
      setBuyError(null);
      setListError(null);
      setSelectedLetter(null);
      setListingPrice('');
      setPromptError(null);
    }
  }, [isOpen]);

  // ── Derived: dynamic roll cost (base + scale × total levels owned) ──────
  const totalLevels = Object.values(inventory || {}).reduce((s, v) => s + v, 0);
  const rollCost = cfg.ROLL_COST + (cfg.ROLL_COST_SCALE || 0) * totalLevels;

  // ── Roll action ──────────────────────────────────────────────────────────
  const handleRoll = useCallback(async () => {
    if (rolling || coins < rollCost) return;
    setRolling(true);
    setRollResult(null);
    setRollError(null);
    try {
      const r = await fetch('/api/shop/roll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || 'Error en la tienda.');
      setRollResult(data.newLetters);
      onPurchase?.(data);
    } catch (e) {
      setRollError(e.message);
    } finally {
      setRolling(false);
    }
  }, [rolling, coins, rollCost, initData, onPurchase]);

  // ── Buy listing action ───────────────────────────────────────────────────
  const handleBuyListing = useCallback(async (listingId) => {
    if (buying) return;
    setBuying(listingId);
    setBuyError(null);
    try {
      const r = await fetch(`/api/market/buy/${listingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || 'Error al comprar.');
      // user_update socket event will update coins + inventory via App.jsx
    } catch (e) {
      setBuyError(e.message);
    } finally {
      setBuying(null);
    }
  }, [buying, initData]);

  // ── List letter action ───────────────────────────────────────────────────
  const handleListLetter = useCallback(async () => {
    if (!selectedLetter || listing) return;
    const price = parseInt(listingPrice, 10);
    if (!price || price < 1 || price > cfg.MARKET_MAX_PRICE) {
      setListError(`El precio debe ser entre 1 y ${cfg.MARKET_MAX_PRICE}.`);
      return;
    }
    setListing(true);
    setListError(null);
    try {
      const r = await fetch('/api/market/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
        body: JSON.stringify({ letter: selectedLetter, price }),
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || 'Error al listar.');
      // Refresh my listings to show the new entry
      const res2 = await fetch('/api/market/my-listings', {
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
  }, [selectedLetter, listing, listingPrice, cfg.MARKET_MAX_PRICE, initData]);

  // ── Cancel listing action ────────────────────────────────────────────────
  const handleCancelListing = useCallback(async (listingId) => {
    if (cancelling) return;
    setCancelling(listingId);
    try {
      const r = await fetch(`/api/market/cancel/${listingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || 'Error al cancelar.');
      setMyListings((prev) =>
        prev.map((l) => l.id === listingId ? { ...l, status: 'cancelled' } : l)
      );
    } catch (e) {
      // Socket event will sync state
    } finally {
      setCancelling(null);
    }
  }, [cancelling, initData]);

  // ── Buy prompt action ────────────────────────────────────────────────────
  const handleBuyPrompt = useCallback(async () => {
    if (firingPrompt || coins < cfg.PROMPT_BUY_COST) return;
    setFiringPrompt(true);
    setPromptError(null);
    try {
      const r = await fetch('/api/shop/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || 'Error al lanzar el prompt.');
      onPromptFired?.(data);
      onClose();
    } catch (e) {
      setPromptError(e.message);
    } finally {
      setFiringPrompt(false);
    }
  }, [firingPrompt, coins, cfg.PROMPT_BUY_COST, initData, onPromptFired, onClose]);

  // ── Derived: inventory keys + labels ────────────────────────────────────
  const isBroke  = coins < rollCost && totalLevels === 0;

  const inventoryEntries = Object.entries(inventory || {})
    .filter(([, v]) => v > 0)
    .sort(([a], [b]) => {
      if (a.startsWith('_') && !b.startsWith('_')) return 1;
      if (!a.startsWith('_') && b.startsWith('_')) return -1;
      return a.localeCompare(b);
    });

  const letterLabel = (key) => {
    if (key === '_numbers') return '0-9';
    if (key === '_symbols') return '!?…';
    return key.toUpperCase();
  };

  const openMyListings = myListings.filter((l) => l.status === 'open');

  if (!isOpen) return null;

  // ── Tabs config ──────────────────────────────────────────────────────────
  const tabs = [
    { id: 'roll',   label: '🎰' },
    { id: 'buy',    label: '🛒' },
    { id: 'sell',   label: '💰' },
    { id: 'prompt', label: '📣' },
  ];

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="relative z-50 w-full max-w-lg bg-tg-bg rounded-t-2xl shadow-2xl flex flex-col max-h-[85vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-tg-bg-sec shrink-0">
          <h2 className="font-bold text-tg-text text-base">Tienda</h2>
          <button
            onClick={onClose}
            className="text-tg-hint text-xl leading-none active:opacity-60"
          >
            ✕
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-tg-bg-sec shrink-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`
                flex-1 py-2.5 text-lg transition-colors
                ${activeTab === t.id
                  ? 'border-b-2 border-tg-button text-tg-button'
                  : 'text-tg-hint'}
              `}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="overflow-y-auto flex-1 p-4">

          {/* ── 🎰 Roll tab ───────────────────────────────────────────── */}
          {activeTab === 'roll' && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-tg-hint text-center">
                Desbloquea {cfg.ROLL_COUNT} letras aleatorias por {rollCost} 🪙
              </p>

              {rollResult && (
                <div className="bg-tg-bg-sec rounded-xl p-3 text-center">
                  <p className="text-xs text-tg-hint mb-1">¡Obtuviste!</p>
                  <p className="text-lg font-bold text-tg-text tracking-widest">
                    {rollResult.map((l) => letterLabel(l)).join('  ')}
                  </p>
                </div>
              )}

              {rollError && (
                <p className="text-xs text-red-500 text-center">{rollError}</p>
              )}

              <button
                onClick={handleRoll}
                disabled={rolling || coins < rollCost}
                className="bg-tg-button text-tg-btn-text font-semibold rounded-xl py-3 active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {rolling ? 'Tirando…' : `Tirar por ${rollCost} 🪙`}
              </button>

              <p className="text-xs text-tg-hint text-center">
                Saldo actual: {coins} 🪙
              </p>

              {isBroke && (
                <div className="flex flex-col items-center gap-1 pt-2 border-t border-tg-bg-sec">
                  <p className="text-[11px] text-tg-hint text-center">Sin letras ni monedas suficientes</p>
                  <button
                    onClick={() => socket?.emit('beg')}
                    className="bg-amber-500 text-white font-semibold rounded-xl py-2 px-6 active:opacity-80"
                  >
                    🙏 Pedir ayuda
                  </button>
                  <p className="text-[10px] text-tg-hint text-center">
                    Aparece un aviso para que otros jugadores te regalen 10 🪙
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── 🛒 Buy tab ────────────────────────────────────────────── */}
          {activeTab === 'buy' && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-tg-hint text-center pb-1">
                Compra letras de otros jugadores con tus monedas.
              </p>

              {buyError && (
                <p className="text-xs text-red-500 text-center">{buyError}</p>
              )}

              {loadingListings && (
                <p className="text-sm text-tg-hint text-center py-6">Cargando…</p>
              )}

              {!loadingListings && openListings.length === 0 && (
                <p className="text-sm text-tg-hint text-center py-6">
                  No hay letras en venta ahora mismo.
                </p>
              )}

              {!loadingListings && openListings.map((l) => (
                <div
                  key={l.id}
                  className="flex items-center justify-between bg-tg-bg-sec rounded-xl px-4 py-3"
                >
                  <div>
                    <span className="text-2xl font-bold text-tg-text mr-2">
                      {letterLabel(l.letter)}
                    </span>
                    <span className="text-xs text-tg-hint">
                      de {l.seller_first_name || l.seller_username || 'Jugador'}
                    </span>
                  </div>
                  <button
                    onClick={() => handleBuyListing(l.id)}
                    disabled={buying === l.id || coins < l.price}
                    className="bg-tg-button text-tg-btn-text text-sm font-semibold rounded-lg px-3 py-1.5 active:opacity-80 disabled:opacity-40"
                  >
                    {buying === l.id ? '…' : `${l.price} 🪙`}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* ── 💰 Sell tab ───────────────────────────────────────────── */}
          {activeTab === 'sell' && (
            <div className="flex flex-col gap-4">

              {/* Active own listings */}
              {!loadingMine && openMyListings.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-semibold text-tg-hint uppercase tracking-wide">
                    Tus listados activos
                  </p>
                  {openMyListings.map((l) => (
                    <div
                      key={l.id}
                      className="flex items-center justify-between bg-tg-bg-sec rounded-xl px-4 py-3"
                    >
                      <div>
                        <span className="text-xl font-bold text-tg-text mr-2">
                          {letterLabel(l.letter)}
                        </span>
                        <span className="text-sm text-tg-hint">{l.price} 🪙</span>
                      </div>
                      <button
                        onClick={() => handleCancelListing(l.id)}
                        disabled={cancelling === l.id}
                        className="text-xs text-red-500 border border-red-300 rounded-lg px-3 py-1.5 active:opacity-70 disabled:opacity-40"
                      >
                        {cancelling === l.id ? '…' : 'Cancelar'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Create listing: pick letter */}
              <div className="flex flex-col gap-2">
                <p className="text-xs font-semibold text-tg-hint uppercase tracking-wide">
                  Listar nueva letra
                </p>

                {inventoryEntries.length === 0 ? (
                  <p className="text-sm text-tg-hint text-center py-3">
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
                            ? 'bg-tg-button text-tg-btn-text'
                            : 'bg-tg-bg-sec text-tg-text active:opacity-70'}
                        `}
                      >
                        {letterLabel(key)}
                        <span className="absolute -top-1 -right-1 text-[9px] bg-tg-hint text-white rounded-full w-4 h-4 flex items-center justify-center leading-none">
                          {level}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Price input + confirm */}
                {selectedLetter && (
                  <div className="flex flex-col gap-2 mt-1">
                    <p className="text-xs text-tg-hint">
                      Seleccionada: <strong className="text-tg-text">{letterLabel(selectedLetter)}</strong>
                      {' · '}Precio sugerido: {cfg.SELL_BASE_PRICE} 🪙
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min="1"
                        max={cfg.MARKET_MAX_PRICE}
                        value={listingPrice}
                        onChange={(e) => setListingPrice(e.target.value)}
                        placeholder={`Precio (1–${cfg.MARKET_MAX_PRICE})`}
                        className="flex-1 bg-tg-bg-sec text-tg-text rounded-xl px-3 py-2 text-sm outline-none"
                      />
                      <button
                        onClick={handleListLetter}
                        disabled={listing || !listingPrice}
                        className="bg-tg-button text-tg-btn-text text-sm font-semibold rounded-xl px-4 py-2 active:opacity-80 disabled:opacity-40"
                      >
                        {listing ? '…' : 'Listar'}
                      </button>
                    </div>
                    {listError && (
                      <p className="text-xs text-red-500">{listError}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── 📣 Prompt tab ─────────────────────────────────────────── */}
          {activeTab === 'prompt' && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-tg-hint text-center">
                Lanza una pregunta comunitaria. La mejor respuesta gana monedas.
              </p>
              <div className="bg-tg-bg-sec rounded-xl p-3 text-xs text-tg-hint space-y-1">
                <p>🏆 Ganador: +{cfg.PROMPT_WINNER_BONUS} 🪙</p>
                <p>🥈 Segundo puesto: +{cfg.PROMPT_RUNNER_UP_BONUS} 🪙</p>
                <p>⏱ Duración: {cfg.PROMPT_DURATION_SEC / 60} minutos</p>
              </div>

              {promptError && (
                <p className="text-xs text-red-500 text-center">{promptError}</p>
              )}

              <button
                onClick={handleBuyPrompt}
                disabled={firingPrompt || coins < cfg.PROMPT_BUY_COST}
                className="bg-tg-button text-tg-btn-text font-semibold rounded-xl py-3 active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {firingPrompt ? 'Lanzando…' : `Lanzar por ${cfg.PROMPT_BUY_COST} 🪙`}
              </button>

              <p className="text-xs text-tg-hint text-center">
                Saldo actual: {coins} 🪙
              </p>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

