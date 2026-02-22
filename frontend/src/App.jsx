import React, { useState, useEffect, useCallback, useRef } from 'react';
import Header             from './components/Header.jsx';
import ChatFeed           from './components/ChatFeed.jsx';
import RestrictedKeyboard from './components/RestrictedKeyboard.jsx';
import ShopModal          from './components/ShopModal.jsx';
import BlackMarketModal   from './components/BlackMarketModal.jsx';
import LotteryModal       from './components/LotteryModal.jsx';
import PromptBanner       from './components/PromptBanner.jsx';
import DevUserPicker      from './components/DevUserPicker.jsx';
import { useAuth }        from './hooks/useAuth.js';
import { useSocket }      from './hooks/useSocket.js';

/**
 * App
 * ───
 * Root component. Wires together auth, socket, chat feed, keyboard, and shop.
 * Layout (mobile-first, full-height):
 *
 *   ┌──────────────────────┐
 *   │        Header        │  ~48 px
 *   ├──────────────────────┤
 *   │     Chat Feed        │  flex-1 scrollable
 *   ├──────────────────────┤
 *   │  Draft preview bar   │  ~40 px (only when draft non-empty)
 *   ├──────────────────────┤
 *   │ Restricted Keyboard  │  ~220 px
 *   └──────────────────────┘
 *
 * Dev mode:
 *   When there is no real Telegram.WebApp.initData (i.e. running in a plain
 *   browser), the DevUserPicker is shown so testers can pick/create a
 *   synthetic user and generate a "dev:…" token accepted by the backend
 *   when DEV_MODE=true.
 */

// Real initData from Telegram SDK (null when running outside Telegram)
const TG_REAL_INIT_DATA = window.Telegram?.WebApp?.initData || null;

export default function App() {
  // initData starts as the real Telegram value; set by DevUserPicker in dev
  const [initData, setInitData] = useState(TG_REAL_INIT_DATA);

  const { user, loading, error, updateUser } = useAuth(initData);
  const { socket, connected, sendMessage }   = useSocket(initData);

  const [draft,     setDraft]     = useState('');
  const [sending,   setSending]   = useState(false);
  const [sendError, setSendError] = useState(null);
  const [shopOpen,  setShopOpen]  = useState(false);
  const [bmOpen,    setBmOpen]    = useState(false);
  const [lotteryOpen, setLotteryOpen] = useState(false);
  const [toast,     setToast]     = useState(null); // { text, type }

  // Triple-tap detection for secret black market
  const shopClicksRef  = useRef(0);
  const shopClickTimer = useRef(null);

  // ── Lottery state ─────────────────────────────────────────────────
  const [lotteryRound,    setLotteryRound]    = useState(null);
  const [lotteryCarryOver, setLotteryCarryOver] = useState(0);
  const [lotteryCfg,      setLotteryCfg]      = useState({ LOTTERY_START_COST: 50, GAMBLING_COINS_PER_LETTER: 50, GAMBLING_WIN_LETTERS: 2 });

  // ── Prompt state ────────────────────────────────────────────────────────
  const [prompt,      setPrompt]      = useState(null);   // { id, text, closesAt }
  const [promptReplies, setPromptReplies] = useState([]);
  const [replyMode,   setReplyMode]   = useState(false);  // keyboard targets prompt
  const [promptError, setPromptError] = useState(null);

  // Hydrate active prompt on mount
  useEffect(() => {
    const url = (import.meta.env.VITE_BACKEND_URL || '') + '/api/prompt/active';
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (data.prompt) {
          setPrompt(data.prompt);
          setPromptReplies(data.replies || []);
        }
      })
      .catch(() => {});
  }, []);

  // Hydrate active lottery on mount + fetch cfg
  useEffect(() => {
    const base = import.meta.env.VITE_BACKEND_URL || '';
    fetch(`${base}/api/lottery/active`)
      .then((r) => r.json())
      .then((data) => {
        if (data.round) setLotteryRound(data.round);
        else setLotteryCarryOver(data.carryOver || 0);
      })
      .catch(() => {});
    fetch(`${base}/api/config`)
      .then((r) => r.json())
      .then((data) => setLotteryCfg(data))
      .catch(() => {});
  }, []);

  // ── Show toast notifications for economy events ─────────────────────────
  useEffect(() => {
    if (!socket) return;

    const onUpdate = (patch) => {
      updateUser(patch);
      if (patch.lockedLetter) {
        showToast(`🔒 "${patch.lockedLetter.toUpperCase()}" bloqueada 5 min!`, 'error');
      } else if (patch.coinDelta > 0) {
        showToast(`+${patch.coinDelta} 🪙  ${patch.newLetters?.length ? `+ letras ${patch.newLetters.join(', ').toUpperCase()}` : ''}`, 'success');
      } else if (patch.tier === 2) {
        showToast('⚠️ Aviso de spam – 0 monedas', 'warn');
      } else if (patch.tier === 3) {
        showToast(`🚫 Penalización: -50 🪙 y 1 letra bloqueada!`, 'error');
      }
    };

    const onRejected = ({ reason }) => {
      setSendError(reason);
      setTimeout(() => setSendError(null), 4000);
    };

    // ── Prompt events ──────────────────────────────────────────────────
    const onNewPrompt = (p) => {
      setPrompt(p);
      setPromptReplies([]);
      setReplyMode(false);
      showToast('📣 ¡Nuevo prompt! Escribe una respuesta.', 'info');
    };

    const onNewPromptReply = (reply) => {
      setPromptReplies((prev) => {
        // Replace if same user already replied, otherwise append
        const idx = prev.findIndex((r) => r.userId === reply.userId && r.promptId === reply.promptId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = reply;
          return next;
        }
        return [...prev, reply];
      });
    };

    const onVoteUpdate = ({ replyId, votes }) => {
      setPromptReplies((prev) =>
        prev.map((r) => (r.id === replyId ? { ...r, votes } : r))
      );
    };

    const onPromptClosed = (result) => {
      setPrompt((p) => p ? { ...p, closed: true } : p);
      setReplyMode(false);
      const winners   = result.winners   || [];
      const runnersUp = result.runnersUp || [];
      if (winners.length > 0) {
        const names = winners.map((w) => w.firstName || w.username).join(', ');
        showToast(
          `🏆 ¡${names} ganó el prompt! +${winners[0].bonus} 🪙`,
          'success'
        );
      } else {
        showToast('📣 Prompt cerrado — sin votos.', 'info');
      }
      // Update own coins if winner/runner-up
      if (user) {
        const asWinner   = winners.find((w)   => w.userId === user.id);
        const asRunnerUp = runnersUp.find((r) => r.userId === user.id);
        const bonus = asWinner ? asWinner.bonus : asRunnerUp ? asRunnerUp.bonus : 0;
        if (bonus > 0) {
          updateUser({ newCoins: (user.coins || 0) + bonus });
          showToast(`🎉 ¡Ganaste ${bonus} 🪙 en el prompt!`, 'success');
        }
      }
    };

    const onPromptError = ({ reason }) => {
      setPromptError(reason);
      setTimeout(() => setPromptError(null), 4000);
    };

    socket.on('user_update',      onUpdate);
    socket.on('rejected_message', onRejected);
    socket.on('new_prompt',        onNewPrompt);
    socket.on('new_prompt_reply',  onNewPromptReply);
    socket.on('vote_update',       onVoteUpdate);
    socket.on('prompt_closed',     onPromptClosed);

    // ── Beg events ───────────────────────────────────────────────
    const onNewBeg = ({ userId: beggarId, firstName, username }) => {
      if (beggarId === user?.id) return;
      const name = firstName || username || 'Alguien';
      showToast(`🙏 ${name} necesita monedas`, 'info', {
        duration: 8000,
        action: {
          label: 'Dar 10 🪙',
          fn: () => socket.emit('give_coins', { targetUserId: beggarId }),
        },
      });
    };
    socket.on('new_beg', onNewBeg);
    socket.on('prompt_error',      onPromptError);

    // ── Lottery events ──────────────────────────────────────────
    const onNewLottery = (round) => {
      setLotteryRound(round);
      setLotteryCarryOver(0);
      showToast('🎲 ¡Nueva lotería! Apuesta por tu letra.', 'info');
    };
    const onLotteryBetPlaced = ({ roundId, bet, jackpot }) => {
      setLotteryRound((prev) => {
        if (!prev || prev.id !== roundId) return prev;
        const bets = prev.bets || [];
        return { ...prev, jackpot, bets: [...bets, bet] };
      });
    };
    const onLotteryClosed = (result) => {
      setLotteryRound(null);
      if (result.carryOver) {
        setLotteryCarryOver(result.jackpot);
        showToast(`🎲 Nadie acertó la letra "${result.secretLetter.toUpperCase()}". Bote acumulado: ${result.jackpot} 🪙`, 'warn', { duration: 6000 });
      } else {
        setLotteryCarryOver(0);
        const names = result.winners.map((w) => w.firstName || w.username).join(', ');
        const coins = result.winners[0]?.coinsEarned ?? 0;
        showToast(`🎉 ¡${names} acertó la "${result.secretLetter.toUpperCase()}"! +${coins} 🪙 +letras`, 'success', { duration: 6000 });
        if (user && result.winners.some((w) => w.userId === user.id)) {
          // user_update socket event handles coins + inventory; toast is enough here
        }
      }
    };
    socket.on('new_lottery',        onNewLottery);
    socket.on('lottery_bet_placed', onLotteryBetPlaced);
    socket.on('lottery_closed',     onLotteryClosed);

    const onListingSoldSeller   = ({ letter, price }) =>
      showToast(`💰 ¡Vendiste "${letter.toUpperCase()}" por ${price} 🪙!`, 'success');
    const onBmListingSoldSeller = ({ letter, price }) =>
      showToast(`🕵️ ¡Vendiste "${letter.toUpperCase()}" por ${price} 🪙 (mercado negro)!`, 'success');

    socket.on('listing_sold_seller',    onListingSoldSeller);
    socket.on('bm_listing_sold_seller', onBmListingSoldSeller);

    return () => {
      socket.off('user_update',      onUpdate);
      socket.off('rejected_message', onRejected);
      socket.off('new_prompt',        onNewPrompt);
      socket.off('new_prompt_reply',  onNewPromptReply);
      socket.off('vote_update',       onVoteUpdate);
      socket.off('prompt_closed',     onPromptClosed);
      socket.off('new_beg',           onNewBeg);
      socket.off('new_lottery',        onNewLottery);
      socket.off('lottery_bet_placed', onLotteryBetPlaced);
      socket.off('lottery_closed',     onLotteryClosed);
      socket.off('prompt_error',      onPromptError);
      socket.off('listing_sold_seller',    onListingSoldSeller);
      socket.off('bm_listing_sold_seller', onBmListingSoldSeller);
    };
  }, [socket, updateUser]);

  function showToast(text, type = 'info', { duration = 3000, action } = {}) {
    setToast({ text, type, action });
    setTimeout(() => setToast(null), duration);
  }

  // ── Send message ──────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || sending) return;

    if (replyMode && prompt && !prompt.closed) {
      // Submit as a prompt reply
      setSending(true);
      socket?.emit('submit_prompt_reply', { promptId: prompt.id, text });
      setDraft('');
      setReplyMode(false);
      setSending(false);
    } else {
      // Normal chat message
      setSending(true);
      setSendError(null);
      sendMessage(text);
      setDraft('');
      setSending(false);
    }
  }, [draft, sending, replyMode, prompt, socket, sendMessage]);

  // ── Vote on a prompt reply ────────────────────────────────────────────
  const handleVote = useCallback((replyId) => {
    socket?.emit('vote_reply', { replyId });
  }, [socket]);

  // ── Triple-tap shop button → secret black market ─────────────────────
  const handleShopClick = useCallback(() => {
    shopClicksRef.current += 1;
    if (shopClicksRef.current === 1) {
      shopClickTimer.current = setTimeout(() => { shopClicksRef.current = 0; }, 1500);
      setShopOpen(true);
    }
    if (shopClicksRef.current >= 3) {
      clearTimeout(shopClickTimer.current);
      shopClicksRef.current = 0;
      setShopOpen(false);
      setBmOpen(true);
    }
  }, []);

  // ── Shop purchase callback (roll + regular market) ───────────────────────────────────────────────
  const handlePurchase = useCallback((result) => {
    updateUser({
      newCoins:     result.newCoins,
      newInventory: result.newInventory,
    });
    showToast(`🎰 Resultado: ${result.newLetters.join(', ').toUpperCase()}`, 'success');
  }, [updateUser]);

  // ── Black market purchase callback ──────────────────────────────────────
  const handleBmPurchase = useCallback((result) => {
    updateUser({
      newCoins:     result.newCoins     ?? result.newInventory ? result.newCoins : undefined,
      newInventory: result.newInventory,
    });
    if (result.letter) {
      showToast(`🛒 Compraste "${result.letter.toUpperCase()}" por ${result.price} 🪙`, 'success');
    }
  }, [updateUser]);

  // ── Prompt fired from shop ─────────────────────────────────────────────
  const handlePromptFired = useCallback((result) => {
    updateUser({ newCoins: result.newCoins });
    setPrompt(result.prompt);
    setPromptReplies([]);
    setReplyMode(false);
    showToast('📣 ¡Tu prompt está activo! Las respuestas están abiertas.', 'success');
  }, [updateUser]);
  // ── Lottery callbacks ────────────────────────────────────────────
  const handleLotteryStarted = useCallback((data) => {
    // Immediately apply round from REST response so UI updates even if socket
    // event is delayed or arrives in a different order.
    if (data.round) {
      setLotteryRound(data.round);
      setLotteryCarryOver(0);
    }
    updateUser({ newCoins: data.newCoins });
  }, [updateUser]);

  const handleBetPlaced = useCallback((bet, jackpot) => {
    setLotteryRound((prev) => {
      if (!prev) return prev;
      const bets = prev.bets || [];
      return { ...prev, jackpot, bets: [...bets, bet] };
    });
  }, []);
  // ── Dev mode: show user picker when there is no session yet ──────────────
  if (!initData) {
    return <DevUserPicker onSelect={setInitData} />;
  }

  // ── Loading / error states ─────────────────────────────────────────────
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-tg-bg">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-tg-button border-t-transparent rounded-full animate-spin" />
          <p className="text-tg-hint text-sm">Cargando Futelo…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-tg-bg px-6 text-center">
        <div>
          <p className="text-4xl mb-4">⚠️</p>
          <p className="font-semibold text-tg-text mb-2">Error de autenticación</p>
          <p className="text-sm text-tg-hint">{error}</p>
          {/* In dev mode let the tester switch to a different user */}
          {!TG_REAL_INIT_DATA && (
            <button
              onClick={() => setInitData(null)}
              className="mt-5 bg-tg-button text-tg-btn-text text-sm font-semibold px-5 py-2.5 rounded-full active:opacity-80"
            >
              ← Cambiar usuario dev
            </button>
          )}
          {TG_REAL_INIT_DATA && (
            <p className="text-xs text-tg-hint mt-4">Abre esta app a través del bot de Telegram.</p>
          )}
        </div>
      </div>
    );
  }

  const inventory     = user?.inventory     || {};
  const lockedLetters = user?.lockedLetters  || [];

  const toastColour = {
    success: 'bg-emerald-500',
    warn:    'bg-amber-500',
    error:   'bg-red-500',
    info:    'bg-tg-button',
  }[toast?.type] || 'bg-tg-button';

  return (
    <div className="h-full flex flex-col bg-tg-bg overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <Header
        coins={user?.coins}
        connected={connected}
        onShopOpen={handleShopClick}
        onLotteryOpen={() => setLotteryOpen(true)}
        hasActiveLottery={!!lotteryRound}
      />

      {/* ── Dev identity banner (only shown outside Telegram) ──────────── */}
      {!TG_REAL_INIT_DATA && (
        <div className="flex items-center justify-between bg-amber-50 border-b border-amber-200 px-3 py-1">
          <span className="text-[11px] text-amber-700 font-medium">
            🛠 Dev: <strong>{user?.first_name}</strong> (@{user?.username}, ID {user?.id})
          </span>
          <button
            onClick={() => setInitData(null)}
            className="text-[11px] text-amber-600 underline"
          >
            cambiar
          </button>
        </div>
      )}

      {/* ── Chat feed ──────────────────────────────────────────────────── */}
      <ChatFeed socket={socket} myUserId={user?.id} />

      {/* ── Error bar ──────────────────────────────────────────────────── */}
      {sendError && (
        <div className="bg-red-50 border-t border-red-200 px-4 py-2 text-xs text-red-600 text-center animate-fade-in">
          {sendError}
        </div>
      )}

      {/* ── Prompt banner (above keyboard) ─────────────────────────────── */}
      <PromptBanner
        prompt={prompt}
        replies={promptReplies}
        myUserId={user?.id}
        replyMode={replyMode}
        onToggleReply={() => setReplyMode((v) => !v)}
        onVote={handleVote}
        promptError={promptError}
      />

      {/* ── Draft preview ──────────────────────────────────────────────── */}
      {draft && (
        <div className="bg-tg-bg border-t border-tg-bg-sec px-4 py-2 text-sm text-tg-text truncate animate-fade-in">
          <span className="text-tg-hint mr-1">{replyMode ? 'Respuesta al prompt:' : 'Borrador:'}</span>
          <span>{draft}</span>
        </div>
      )}

      {/* ── Restricted keyboard ────────────────────────────────────────── */}
      <RestrictedKeyboard
        draft={draft}
        onDraftChange={setDraft}
        onSend={handleSend}
        inventory={inventory}
        lockedLetters={lockedLetters}
        disabled={sending}
      />

      {/* ── Shop modal ─────────────────────────────────────────────────── */}
      <ShopModal
        isOpen={shopOpen}
        onClose={() => setShopOpen(false)}
        initData={initData}
        coins={user?.coins ?? 0}
        inventory={inventory}
        onPurchase={handlePurchase}
        onPromptFired={handlePromptFired}
        socket={socket}
      />

      {/* ── Black market modal ─────────────────────────────────────────── */}
      <BlackMarketModal
        isOpen={bmOpen}
        onClose={() => setBmOpen(false)}
        initData={initData}
        coins={user?.coins ?? 0}
        inventory={inventory}
        onPurchase={handleBmPurchase}
        socket={socket}
      />
      {/* ── Lottery modal ─────────────────────────────────────────────── */}
      <LotteryModal
        isOpen={lotteryOpen}
        onClose={() => setLotteryOpen(false)}
        initData={initData}
        coins={user?.coins ?? 0}
        userId={user?.id}
        inventory={inventory}
        lotteryRound={lotteryRound}
        carryOver={lotteryCarryOver}
        onLotteryStarted={handleLotteryStarted}
        onBetPlaced={handleBetPlaced}
        onError={(msg) => showToast(msg, 'warn', { duration: 4000 })}
        cfg={lotteryCfg}
      />
      {/* ── Toast notification ──────────────────────────────────────────── */}
      {toast && (
        <div
          className={`
            fixed top-4 left-1/2 -translate-x-1/2 z-50
            ${toastColour} text-white text-xs font-semibold
            px-4 py-2 rounded-full shadow-lg animate-slide-up
            ${toast.action ? 'pointer-events-auto flex items-center gap-2' : 'pointer-events-none'}
          `}
        >
          <span>{toast.text}</span>
          {toast.action && (
            <button
              onClick={() => { toast.action.fn(); setToast(null); }}
              className="bg-white/25 hover:bg-white/40 rounded-full px-2 py-0.5 font-bold active:opacity-70"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
