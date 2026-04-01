import { useState, useEffect, useCallback, useRef } from 'react';

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

// ── Lootbox rarity metadata ─────────────────────────────────────────────────
// Must match the LOOTBOX_TIERS names in backend/src/config.js.
// Full class names are used (no string interpolation) so Tailwind's purge sees them.
const RARITY_META = {
  'común': {
    label: 'Común', emoji: '📦', shortLabel: 'Común',
    stripBg: 'bg-gray-700', stripBorder: 'border-gray-500', stripText: 'text-gray-200',
    textClass:  'text-gray-400',
    bgClass:    'bg-tg-bg-sec',
    chipClass:  'bg-gray-600/40 text-gray-300',
    celebrationEmoji: null, animated: false, pulse: false, legendary: false,
  },
  'bueno': {
    label: 'Bueno', emoji: '✨', shortLabel: 'Bueno',
    stripBg: 'bg-green-800', stripBorder: 'border-green-500', stripText: 'text-green-100',
    textClass:  'text-green-400',
    bgClass:    'bg-green-900/30 border border-green-600/30',
    chipClass:  'bg-green-800/50 text-green-200',
    celebrationEmoji: '✨  ✨', animated: true, pulse: false, legendary: false,
  },
  'raro': {
    label: 'Raro', emoji: '⭐', shortLabel: 'Raro ⭐',
    stripBg: 'bg-blue-800', stripBorder: 'border-blue-500', stripText: 'text-blue-100',
    textClass:  'text-blue-400',
    bgClass:    'bg-blue-900/30 border border-blue-500/40',
    chipClass:  'bg-blue-800/50 text-blue-200',
    celebrationEmoji: '⭐  ⭐  ⭐', animated: true, pulse: false, legendary: false,
  },
  'épico': {
    label: '¡ÉPICO!', emoji: '💫', shortLabel: '💫 Épico',
    stripBg: 'bg-purple-800', stripBorder: 'border-purple-400', stripText: 'text-purple-100',
    textClass:  'text-purple-300',
    bgClass:    'bg-purple-900/40 border border-purple-500/50',
    chipClass:  'bg-purple-700/60 text-purple-100',
    celebrationEmoji: '💫  🌟  💫', animated: true, pulse: true, legendary: false,
  },
  'legendario': {
    label: '¡¡LEGENDARIO!!', emoji: '🏆', shortLabel: '🏆 LEGENDARIO',
    stripBg: 'bg-yellow-700', stripBorder: 'border-yellow-400', stripText: 'text-yellow-100',
    textClass:  'text-yellow-300',
    bgClass:    'bg-yellow-800/30 border-2 border-yellow-400/60',
    chipClass:  'bg-yellow-600/50 text-yellow-100',
    celebrationEmoji: '🎉  🏆  🎊  🌟  🎊  🏆  🎉', animated: true, pulse: true, legendary: true,
  },
};

// ── Roulette strip helpers ──────────────────────────────────────────────────
const RARITY_WEIGHTS = [
  { name: 'común',      weight: 40 },
  { name: 'bueno',      weight: 35 },
  { name: 'raro',       weight: 18 },
  { name: 'épico',      weight: 6  },
  { name: 'legendario', weight: 1  },
];
const ITEM_W      = 96;  // px – width of each roulette box
const ITEM_GAP    = 8;   // px – gap between boxes
const ITEM_STRIDE = ITEM_W + ITEM_GAP; // 104 px
const WINNER_IDX  = 62;  // index in the spin strip where the winner lands
const STRIP_TOTAL = 70;  // total items in the strip

function randomRarity() {
  let r = Math.random() * 100;
  for (const { name, weight } of RARITY_WEIGHTS) {
    r -= weight;
    if (r <= 0) return name;
  }
  return 'común';
}

function buildSpinStrip(winnerRarity) {
  const items = [];
  for (let i = 0; i < STRIP_TOTAL; i++) {
    items.push(i === WINNER_IDX ? winnerRarity : randomRarity());
  }
  return items;
}

export default function ShopModal({
  isOpen,
  onClose,
  initData,
  chatId = 0,
  coins,
  inventory,
  pickaxeHits: initialPickaxeHits = 0,
  goldLevel: initialGoldLevel = 0,
  goldActive: initialGoldActive = 1,
  onPurchase,
  onPromptFired,
  socket,
}) {
  // ── Tab state ────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('roll');

  // ── April Fools date gate (April 1, 2026) ────────────────────────────────
  const isAprilFools = (() => {
    const d = new Date();
    return d.getFullYear() === 2026 && d.getMonth() === 3 && d.getDate() === 1;
  })();

  // ── Futelo GOLD tab state ────────────────────────────────────────────────
  const [localGoldLevel, setLocalGoldLevel] = useState(initialGoldLevel);
  const [localGoldActive, setLocalGoldActive] = useState(initialGoldActive);
  const [goldBuying,   setGoldBuying]         = useState(false);
  const [goldToggling, setGoldToggling]       = useState(false);
  const [goldError,    setGoldError]          = useState(null);
  // Keep in sync when parent updates (e.g. socket user_update)
  useEffect(() => { setLocalGoldLevel(initialGoldLevel); }, [initialGoldLevel]);
  useEffect(() => { setLocalGoldActive(initialGoldActive); }, [initialGoldActive]);

  // ── Config from server ───────────────────────────────────────────────────
  const [cfg, setCfg] = useState({
    ROLL_COST: 100, ROLL_COST_SCALE: 1, ROLL_COUNT: 3,
    SELL_BASE_PRICE: 15, MARKET_MAX_PRICE: 500,
    PROMPT_BUY_COST: 200, PROMPT_WINNER_BONUS: 100,
    PROMPT_RUNNER_UP_BONUS: 30, PROMPT_DURATION_SEC: 180,
    PICKAXE_COST: 150, PICKAXE_COST_SCALE: 1, PICKAXE_HITS: 1000, MINE_HIT_CHANCE: 0.01,
  });

  // ── Roll tab state ───────────────────────────────────────────────────────
  const [rolling, setRolling]           = useState(false);
  const [rollResult, setRollResult]     = useState(null);   // { letters, rarity } after reveal
  const [rollError, setRollError]       = useState(null);
  // Roulette animation
  const [spinPhase, setSpinPhase]       = useState('idle'); // 'idle'|'spinning'|'cards'
  const [spinStrip, setSpinStrip]       = useState([]);     // array of rarity names
  const [pendingResult, setPendingResult] = useState(null); // server response held during spin
  const [revealedCards, setRevealedCards] = useState([]);   // which card indices are face-up
  const stripRef                        = useRef(null);
  const spinRafRef                      = useRef(null);
  // Stable ref so the RAF callback can call onPurchase without being in its dep array
  const onPurchaseRef                   = useRef(onPurchase);
  useEffect(() => { onPurchaseRef.current = onPurchase; }, [onPurchase]);

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

  // ── Mining tab state ─────────────────────────────────────────────────────
  const [hitsLeft, setHitsLeft]       = useState(initialPickaxeHits);
  const [buyingPickaxe, setBuyingPickaxe] = useState(false);
  const [swinging, setSwinging]       = useState(false);
  const [swingResult, setSwingResult] = useState(null); // { found, letter } | null
  const [mineError, setMineError]     = useState(null);
  const [swingState, setSwingState]   = useState('idle'); // 'idle'|'swinging'|'miss'|'found'
  const [rockShaking, setRockShaking] = useState(false);
  const [tapCount, setTapCount]       = useState(0);
  const foundTimerRef                 = useRef(null);

  const MISS_MESSAGES = [
    '💨', '🪨', '💥', '⚡', '🔨', '💢', '🌑', '⛏️', '🫨', '😤',
  ];

  // ── Prompt tab state ─────────────────────────────────────────────────────
  const [firingPrompt, setFiringPrompt] = useState(false);
  const [promptError, setPromptError]   = useState(null);

  // Scaled pickaxe cost — mirrors the lootbox roll cost formula
  const pickaxeCost = cfg.PICKAXE_COST + cfg.PICKAXE_COST_SCALE * Object.values(inventory || {}).reduce((s, v) => s + v, 0);

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
    const roomQ = chatId ? `?roomId=${chatId}` : '';
    if (activeTab === 'buy') {
      setLoadingListings(true);
      setBuyError(null);
      fetch(`/api/market/listings${roomQ}`)
        .then(safeJson)
        .then((data) => setOpenListings(Array.isArray(data) ? data : []))
        .catch(() => setBuyError('Error al cargar los listados.'))
        .finally(() => setLoadingListings(false));
    }
    if (activeTab === 'sell') {
      setLoadingMine(true);
      fetch(`/api/market/my-listings${roomQ}`, {
        headers: initData ? { 'x-init-data': initData } : {},
      })
        .then(safeJson)
        .then((data) => setMyListings(Array.isArray(data) ? data : []))
        .catch(() => {})
        .finally(() => setLoadingMine(false));
    }
  }, [isOpen, activeTab, initData, chatId]);

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
      setSpinPhase('idle');
      setSpinStrip([]);
      setPendingResult(null);
      setRevealedCards([]);
      setBuyError(null);
      setListError(null);
      setSelectedLetter(null);
      setListingPrice('');
      setPromptError(null);
      setMineError(null);
      setSwingResult(null);
      setSwingState('idle');
      setTapCount(0);
      setGoldError(null);
      cancelAnimationFrame(spinRafRef.current);
    }
  }, [isOpen]);

  // ── Roulette spin animation (CSS transform via requestAnimationFrame) ────
  // Guard: only start once the strip items are in the DOM (spinStrip.length > 0)
  useEffect(() => {
    if (spinPhase !== 'spinning' || !stripRef.current || !pendingResult || spinStrip.length === 0) return;

    const strip = stripRef.current;
    const winnerRarity = pendingResult.rarity;

    // Target: center the winner box exactly under the viewport center pointer.
    // Measure the actual container width at runtime so it works on any screen size.
    const viewportCenter = strip.parentElement.offsetWidth / 2;
    // strip translateX needed so winner's center aligns to viewportCenter:
    // winner center from strip left = paddingLeft(8) + WINNER_IDX * ITEM_STRIDE + ITEM_W/2
    const targetX = viewportCenter - (8 + WINNER_IDX * ITEM_STRIDE + ITEM_W / 2);

    // Start 15 items to the right of the landing position for travel distance.
    const startX = targetX + ITEM_STRIDE * 15;
    const DURATION = 4200; // ms

    let startTime = null;
    strip.style.transform = `translateX(${startX}px)`;

    function easeOutQuint(t) {
      return 1 - Math.pow(1 - t, 5);
    }

    function frame(ts) {
      if (!startTime) startTime = ts;
      const elapsed = ts - startTime;
      const t = Math.min(elapsed / DURATION, 1);
      const ease = easeOutQuint(t);
      const x = startX + (targetX - startX) * ease;
      strip.style.transform = `translateX(${x}px)`;

      if (t < 1) {
        spinRafRef.current = requestAnimationFrame(frame);
      } else {
        const haptic = window.Telegram?.WebApp?.HapticFeedback;
        if      (winnerRarity === 'legendario') haptic?.notificationOccurred('success');
        else if (winnerRarity === 'épico')      haptic?.impactOccurred('heavy');
        else if (winnerRarity === 'raro')       haptic?.impactOccurred('medium');

        if (pendingResult.allCapped) {
          // Skip card reveal — go straight to the coin-bonus summary
          setRollResult({
            letters:   [],
            rarity:    winnerRarity,
            coinBonus: pendingResult.coinBonus,
            allCapped: true,
          });
          setSpinPhase('done');
          onPurchaseRef.current?.(pendingResult);
        } else {
          setSpinPhase('cards');
          setRevealedCards([]);
        }
      }
    }

    spinRafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(spinRafRef.current);
  }, [spinPhase, pendingResult, spinStrip]);  // spinStrip dep ensures DOM is ready

  // Keep hitsLeft in sync when parent pushes a new value (socket user_update)
  useEffect(() => {
    setHitsLeft(initialPickaxeHits);
  }, [initialPickaxeHits]);

  // ── Derived: dynamic roll cost (base + scale × total levels owned) ──────
  const totalLevels = Object.values(inventory || {}).reduce((s, v) => s + v, 0);
  const rollCost = cfg.ROLL_COST + (cfg.ROLL_COST_SCALE || 0) * totalLevels;

  // ── Roll action ──────────────────────────────────────────────────────────
  const handleRoll = useCallback(async () => {
    // Allow re-rolling from 'done' state as well as 'idle'
    if (rolling || coins < rollCost || (spinPhase !== 'idle' && spinPhase !== 'done')) return;
    setRolling(true);
    setRollResult(null);
    setRollError(null);
    setRevealedCards([]);
    setPendingResult(null);
    setSpinStrip([]);    // clear old strip
    setSpinPhase('idle'); // reset in case coming from 'done'
    try {
      const r = await fetch('/api/shop/roll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || 'Error en la tienda.');
      // Build the strip NOW so React batches it with setSpinPhase('spinning').
      // The useEffect waits for spinStrip.length > 0, so the DOM will have
      // the items rendered before the RAF animation touches the ref.
      const newStrip = buildSpinStrip(data.rarity);
      setSpinStrip(newStrip);
      setPendingResult(data);
      setSpinPhase('spinning');
      // NOTE: onPurchase is intentionally deferred until the player reveals
      // all cards, so coins/inventory/toasts don't appear mid-animation.
    } catch (e) {
      setRollError(e.message);
    } finally {
      setRolling(false);
    }
  }, [rolling, coins, rollCost, spinPhase, initData]);  // onPurchase removed — called on reveal

  // Called when cards phase: user taps a card to flip it
  const handleFlipCard = useCallback((idx) => {
    setRevealedCards((prev) => {
      if (prev.includes(idx)) return prev;
      const next = [...prev, idx];
      // When ALL cards are revealed, wait for the last flip animation (500ms)
      // to finish before switching to the summary view.
      if (pendingResult && next.length === pendingResult.newLetters.length) {
        setTimeout(() => {
          setRollResult({ letters: pendingResult.newLetters, rarity: pendingResult.rarity });
          setSpinPhase('done');
          onPurchase?.(pendingResult);
        }, 550);
      }
      return next;
    });
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  }, [pendingResult, onPurchase]);

  const handleRevealAll = useCallback(() => {
    if (!pendingResult) return;
    const allIdx = pendingResult.newLetters.map((_, i) => i);
    setRevealedCards(allIdx);
    // Give the batch of flip animations a moment before switching views
    setTimeout(() => {
      setRollResult({ letters: pendingResult.newLetters, rarity: pendingResult.rarity });
      setSpinPhase('done');
      onPurchase?.(pendingResult);
    }, 550);
  }, [pendingResult, onPurchase]);

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
      const roomQ = chatId ? `?roomId=${chatId}` : '';
      const res2 = await fetch(`/api/market/my-listings${roomQ}`, {
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
  }, [selectedLetter, listing, listingPrice, cfg.MARKET_MAX_PRICE, initData, chatId]);

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
    { id: 'mine',   label: '⛏️' },
    ...(isAprilFools ? [{ id: 'gold', label: '✨' }] : []),
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

              {/* ── Idle / done state: show CTA ── */}
              {(spinPhase === 'idle' || spinPhase === 'done') && (
                <>
                  <p className="text-sm text-tg-hint text-center">
                    Abre una caja de letras — ¡la rareza es sorpresa!
                  </p>

                  {/* Result summary (after all cards flipped) */}
                  {spinPhase === 'done' && rollResult && (() => {
                    const meta = RARITY_META[rollResult.rarity] || RARITY_META['común'];
                    return (
                      <div className={`rounded-2xl p-4 text-center ${meta.bgClass} ${rollResult.allCapped ? '' : meta.pulse ? 'animate-pulse' : ''}`}>
                        {rollResult.allCapped ? (
                          // ── All-capped path: show coin bonus ────────────────────
                          <>
                            <p className={`text-xl font-black tracking-wider mb-1 ${meta.textClass}`}>
                              {meta.emoji} {meta.label}
                            </p>
                            <p className="text-sm text-tg-hint mb-3">¡Todo al máximo! Tirada sin costo.</p>
                            <p className="text-4xl font-black text-yellow-400 animate-bounce">+{rollResult.coinBonus} 🪙</p>
                          </>
                        ) : (
                          // ── Normal path: show letters ───────────────────────────
                          <>
                            {meta.celebrationEmoji && (
                              <p className={`text-2xl mb-2 ${meta.animated ? 'animate-bounce' : ''}`}>
                                {meta.celebrationEmoji}
                              </p>
                            )}
                            <p className={`text-xl font-black tracking-wider mb-3 ${meta.textClass}`}>
                              {meta.emoji} {meta.label}
                            </p>
                            <div className="flex flex-wrap justify-center gap-2">
                              {rollResult.letters.map((l, i) => (
                                <span
                                  key={i}
                                  className={`font-black text-xl px-3 py-2 rounded-xl ${meta.chipClass} ${meta.animated ? 'animate-bounce' : ''}`}
                                  style={meta.animated ? { animationDelay: `${i * 100}ms` } : {}}
                                >
                                  {letterLabel(l)}
                                </span>
                              ))}
                            </div>
                            {meta.legendary && (
                              <p className="text-2xl mt-3 animate-bounce">🌟  ✨  🌟  ✨  🌟</p>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })()}

                  {rollError && (
                    <p className="text-xs text-red-500 text-center">{rollError}</p>
                  )}

                  <button
                    onClick={handleRoll}
                    disabled={rolling || coins < rollCost}
                    className="bg-tg-button text-tg-btn-text font-semibold rounded-xl py-3 active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {rolling ? 'Sorteando…' : spinPhase === 'done' ? `Otra tirada — ${rollCost} 🪙` : `Abrir caja por ${rollCost} 🪙`}
                  </button>

                  <p className="text-xs text-tg-hint text-center">Saldo actual: {coins} 🪙</p>

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
                </>
              )}

              {/* ── Roulette spinning phase ── */}
              {spinPhase === 'spinning' && (
                <div className="flex flex-col items-center gap-4">
                  <p className="text-sm text-tg-hint text-center animate-pulse">¡Girando la ruleta…!</p>

                  {/* Roulette viewport */}
                  <div
                    className="relative w-full overflow-hidden rounded-xl border-2 border-tg-button/50"
                    style={{ height: '80px' }}
                  >
                    {/* Center pointer */}
                    <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-tg-button z-10 pointer-events-none" />
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-8 border-l-transparent border-r-transparent border-t-tg-button z-10 pointer-events-none" />

                    {/* Scrolling strip */}
                    <div
                      ref={stripRef}
                      className="flex gap-2 items-center absolute top-0 left-0 h-full will-change-transform"
                      style={{ paddingLeft: '8px' }}
                    >
                      {spinStrip.map((rarity, i) => {
                        const m = RARITY_META[rarity] || RARITY_META['común'];
                        return (
                          <div
                            key={i}
                            className={`shrink-0 flex flex-col items-center justify-center rounded-lg border-2 ${m.stripBg} ${m.stripBorder} select-none`}
                            style={{ width: `${ITEM_W}px`, height: '64px' }}
                          >
                            <span className="text-xl leading-none">{m.emoji}</span>
                            <span className={`text-[11px] font-bold leading-tight mt-0.5 ${m.stripText}`}>{m.shortLabel}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <p className="text-xs text-tg-hint text-center">Saldo actual: {coins} 🪙</p>
                </div>
              )}

              {/* ── Card reveal phase ── */}
              {spinPhase === 'cards' && pendingResult && (() => {
                const meta = RARITY_META[pendingResult.rarity] || RARITY_META['común'];
                const letters = pendingResult.newLetters;
                const allRevealed = revealedCards.length === letters.length;
                return (
                  <div className="flex flex-col items-center gap-4">
                    {/* Rarity banner */}
                    <div className={`w-full rounded-xl py-2 text-center ${meta.bgClass}`}>
                      <p className={`text-lg font-black tracking-wider ${meta.textClass}`}>
                        {meta.emoji} {meta.label}
                      </p>
                      {meta.celebrationEmoji && (
                        <p className="text-xl animate-bounce">{meta.celebrationEmoji}</p>
                      )}
                    </div>

                    <p className="text-sm text-tg-hint text-center">
                      {allRevealed ? '¡Todas las letras reveladas!' : 'Toca cada carta para revelarla'}
                    </p>

                    {/* Cards grid */}
                    <div className="flex flex-wrap justify-center gap-3">
                      {letters.map((letter, i) => {
                        const flipped = revealedCards.includes(i);
                        return (
                          <button
                            key={i}
                            onClick={() => handleFlipCard(i)}
                            disabled={flipped}
                            className="relative select-none"
                            style={{
                              width: '64px',
                              height: '80px',
                              perspective: '400px',
                            }}
                            aria-label={flipped ? `Letra ${letter}` : 'Carta oculta'}
                          >
                            {/* Card inner (flip container) */}
                            <div
                              style={{
                                position: 'absolute', inset: 0,
                                transformStyle: 'preserve-3d',
                                transition: 'transform 0.5s cubic-bezier(0.4,0,0.2,1)',
                                transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
                              }}
                            >
                              {/* Card back */}
                              <div
                                style={{ backfaceVisibility: 'hidden' }}
                                className={`absolute inset-0 rounded-xl border-2 ${meta.stripBorder} ${meta.stripBg} flex items-center justify-center`}
                              >
                                <span className="text-2xl">🎴</span>
                              </div>
                              {/* Card front (shown when flipped) */}
                              <div
                                style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
                                className={`absolute inset-0 rounded-xl border-2 ${meta.stripBorder} ${meta.chipClass} flex items-center justify-center`}
                              >
                                <span className="text-2xl font-black">{letterLabel(letter)}</span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Reveal all shortcut — always in DOM to avoid layout shift */}
                    <button
                      onClick={handleRevealAll}
                      className={`text-xs text-tg-hint underline active:opacity-60 mt-1 transition-opacity duration-300 ${allRevealed ? 'opacity-0 pointer-events-none' : ''}`}
                    >
                      Revelar todo
                    </button>
                  </div>
                );
              })()}

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

          {/* ── ⛏️ Minas tab ───────────────────────────────────────── */}
          {activeTab === 'mine' && (
            <div className="flex flex-col gap-4">
              {/* ── No pickaxe sub-view ─── */}
              {hitsLeft <= 0 && (
                <>
                  <div className="text-center text-5xl py-4">🪨</div>
                  <p className="text-sm text-tg-hint text-center">
                    Golpea la roca rápido. Cada toque tiene un 1% de chance de revelar una letra.
                  </p>
                  <div className="bg-tg-bg-sec rounded-xl p-3 text-xs text-tg-hint space-y-1">
                    <p>⛏️ Golpes por pico: {cfg.PICKAXE_HITS}</p>
                    <p>💎 1% de probabilidad por toque</p>
                  </div>
                  {mineError && (
                    <p className="text-xs text-red-500 text-center">{mineError}</p>
                  )}
                  <button
                    onClick={async () => {
                      if (buyingPickaxe || coins < pickaxeCost) return;
                      setBuyingPickaxe(true);
                      setMineError(null);
                      try {
                        const r = await fetch('/api/mine/buy', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
                        });
                        const data = await safeJson(r);
                        if (!r.ok) throw new Error(data?.error || 'Error al comprar el pico.');
                        setHitsLeft(data.pickaxeHits);
                        onPurchase?.({ newCoins: data.newCoins });
                      } catch (e) {
                        setMineError(e.message);
                      } finally {
                        setBuyingPickaxe(false);
                      }
                    }}
                    disabled={buyingPickaxe || coins < pickaxeCost}
                    className="bg-tg-button text-tg-btn-text font-semibold rounded-xl py-3 active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {buyingPickaxe ? '…' : `Comprar pico — ${pickaxeCost} 🪙`}
                  </button>
                  <p className="text-xs text-tg-hint text-center">Saldo actual: {coins} 🪙</p>
                </>
              )}

              {/* ── Mining sub-view ─── */}
              {hitsLeft > 0 && (
                <>
                  {/* Tappable rock */}
                  <div className="flex flex-col items-center gap-3 py-4">
                    <div
                      role="button"
                      aria-label="Golpear roca"
                      className={`text-8xl select-none cursor-pointer transition-transform active:scale-90 ${
                        rockShaking ? 'animate-rock-shake' : ''
                      }`}
                      onPointerDown={async () => {
                        if (swinging) return;
                        setSwinging(true);
                        setRockShaking(true);
                        setMineError(null);
                        let foundLetter = false;
                        try {
                          const r = await fetch('/api/mine/swing', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
                          });
                          const data = await safeJson(r);
                          if (!r.ok) throw new Error(data?.error || 'Error al excavar.');
                          setHitsLeft(data.hitsLeft);
                          setTapCount(n => n + 1);
                          if (data.found) {
                            foundLetter = true;
                            setSwingResult({ letter: data.letter });
                            setSwingState('found');
                            onPurchase?.({ newInventory: data.newInventory });
                            window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
                            // Hold the found display for 2.5 s before allowing next tap
                            clearTimeout(foundTimerRef.current);
                            foundTimerRef.current = setTimeout(() => {
                              setSwingState('idle');
                              setSwinging(false);
                            }, 2500);
                          } else {
                            setSwingResult(null);
                            setSwingState('miss');
                          }
                        } catch (e) {
                          setMineError(e.message);
                          setSwingState('idle');
                        } finally {
                          if (!foundLetter) setSwinging(false);
                        }
                      }}
                      onAnimationEnd={() => setRockShaking(false)}
                    >
                      🪨
                    </div>

                    {/* Status messages */}
                    <div className="min-h-[5rem] flex flex-col items-center justify-center gap-2">
                      {swingState === 'miss' && (
                        <p className="text-3xl">{MISS_MESSAGES[tapCount % MISS_MESSAGES.length]}</p>
                      )}
                      {swingState === 'found' && swingResult && (
                        <>
                          <p className="text-xs font-semibold text-yellow-500 tracking-widest uppercase">
                            {swingResult.letter === '_numbers' ? '✨ ¡Números desbloqueados!' : swingResult.letter === '_symbols' ? '✨ ¡Símbolos desbloqueados!' : '✨ ¡Letra encontrada!'}
                          </p>
                          <div className="bg-yellow-400/20 border border-yellow-400/50 rounded-xl px-6 py-2 text-center">
                            <span className="text-4xl font-bold text-yellow-400 uppercase">
                              {swingResult.letter === '_numbers' ? '0-9' : swingResult.letter === '_symbols' ? '!@#' : swingResult.letter}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Hit counter */}
                  <div className="flex justify-center">
                    <span className="text-sm text-tg-hint">⛏️ Golpes restantes: <strong className="text-tg-text">{hitsLeft}</strong></span>
                  </div>

                  {mineError && (
                    <p className="text-xs text-red-500 text-center">{mineError}</p>
                  )}

                  {/* Buy more pickaxes inline */}
                  <button
                    onClick={async () => {
                      if (buyingPickaxe || coins < pickaxeCost) return;
                      setBuyingPickaxe(true);
                      setMineError(null);
                      try {
                        const r = await fetch('/api/mine/buy', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
                        });
                        const data = await safeJson(r);
                        if (!r.ok) throw new Error(data?.error || 'Error al comprar el pico.');
                        setHitsLeft(data.pickaxeHits);
                        onPurchase?.({ newCoins: data.newCoins });
                      } catch (e) {
                        setMineError(e.message);
                      } finally {
                        setBuyingPickaxe(false);
                      }
                    }}
                    disabled={buyingPickaxe || coins < pickaxeCost}
                    className="text-sm text-tg-hint border border-tg-bg-sec rounded-xl py-2.5 active:opacity-60 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {buyingPickaxe ? '…' : `+${cfg.PICKAXE_HITS} golpes — ${pickaxeCost} 🪙`}
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── ✨ Futelo GOLD tab (April 1, 2026 only) ─────────────────── */}
          {activeTab === 'gold' && isAprilFools && (
            <div className="flex flex-col gap-5">

              {/* Title */}
              <div className="text-center">
                <p className="text-2xl font-black tracking-wide"
                   style={{ color: '#FFD700', textShadow: '0 0 12px #FFD70088' }}>
                  ✨ Futelo GOLD ✨
                </p>
                <p className="text-xs text-tg-hint mt-1">Edición especial — 1 de abril de 2026</p>
              </div>

              {/* Current level */}
              {localGoldLevel > 0 && (
                <div className="rounded-2xl border-2 border-yellow-400 bg-yellow-400/10 p-4 text-center flex flex-col gap-1">
                  <p className="text-xs text-yellow-400 font-semibold uppercase tracking-widest">Tu nivel actual</p>
                  <p className="text-4xl font-black text-yellow-300">Nivel {localGoldLevel}</p>
                  <p className="text-xs text-tg-hint mt-1">
                    Tus mensajes tienen borde dorado y el texto
                    {' '}
                    <span style={{ fontSize: `${10 + Math.floor(localGoldLevel / 5)}px` }}
                          className="text-yellow-400 font-bold">
                      Esta persona tiene Futelo GOLD
                    </span>
                    {' '}aparece junto a tu nombre.
                  </p>
                  {/* Active toggle */}
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-yellow-400/20">
                    <p className="text-xs text-tg-hint">{localGoldActive ? 'GOLD visible para todos' : 'GOLD oculto'}</p>
                    <button
                      onClick={async () => {
                        if (goldToggling) return;
                        setGoldToggling(true);
                        setGoldError(null);
                        try {
                          const r = await fetch('/api/gold/toggle', {
                            method: 'POST',
                            headers: { 'x-init-data': initData || '' },
                          });
                          const data = await safeJson(r);
                          if (!r.ok) throw new Error(data?.error || 'Error al procesar.');
                          setLocalGoldActive(data.goldActive);
                        } catch (e) {
                          setGoldError(e.message);
                        } finally {
                          setGoldToggling(false);
                        }
                      }}
                      disabled={goldToggling}
                      aria-label={localGoldActive ? 'Desactivar GOLD' : 'Activar GOLD'}
                      className={`relative w-10 h-6 rounded-full transition-colors duration-200 disabled:opacity-50 flex-shrink-0 ${
                        localGoldActive ? 'bg-yellow-400' : 'bg-tg-bg-sec border border-tg-hint/30'
                      }`}
                    >
                      <span className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white shadow transition-all duration-200 ${
                        localGoldActive ? 'left-[22px]' : 'left-[2px]'
                      }`} />
                    </button>
                  </div>
                </div>
              )}

              {/* What you get card (only for first purchase) */}
              {localGoldLevel === 0 && (
                <div className="rounded-xl bg-tg-bg-sec border border-yellow-500/30 p-4 flex flex-col gap-2 text-sm text-tg-hint">
                  <p className="font-semibold text-tg-text">¿Qué incluye Futelo GOLD?</p>
                  <p>✅ Borde dorado en todos tus mensajes</p>
                  <p>✅ El texto <span className="text-yellow-400 font-bold text-xs">Esta persona tiene Futelo GOLD</span> junto a tu nombre</p>
                  <p>✅ Cuanto más mejores, más grande y molesto se vuelve el texto</p>
                  <p className="text-[10px] opacity-60 mt-1">* Solo disponible hoy, 1 de abril de 2026. Los logros se mantienen para siempre.</p>
                </div>
              )}

              {/* Buy/Upgrade button */}
              <button
                onClick={async () => {
                  if (goldBuying || coins < 1) return;
                  setGoldBuying(true);
                  setGoldError(null);
                  try {
                    const r = await fetch('/api/gold/upgrade', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'x-init-data': initData || '' },
                    });
                    const data = await safeJson(r);
                    if (!r.ok) throw new Error(data?.error || 'Error al procesar.');
                    setLocalGoldLevel(data.goldLevel);
                    onPurchase?.({ newCoins: data.newCoins });
                  } catch (e) {
                    setGoldError(e.message);
                  } finally {
                    setGoldBuying(false);
                  }
                }}
                disabled={goldBuying || coins < 1}
                className="w-full py-3 rounded-2xl font-black text-base active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg, #FFD700, #FFA500)', color: '#000' }}
              >
                {goldBuying
                  ? '…'
                  : localGoldLevel === 0
                    ? '✨ Comprar Futelo GOLD — 1 🪙'
                    : `✨ Mejorar a Nivel ${localGoldLevel + 1} — 1 🪙`}
              </button>

              {goldError && (
                <p className="text-xs text-red-500 text-center">{goldError}</p>
              )}

              {coins < 1 && (
                <p className="text-xs text-tg-hint text-center">Necesitas al menos 1 🪙 para continuar.</p>
              )}

            </div>
          )}

        </div>
      </div>
    </div>
  );
}
