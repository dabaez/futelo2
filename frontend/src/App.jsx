import React, { useState, useEffect, useCallback } from 'react';
import Header             from './components/Header.jsx';
import ChatFeed           from './components/ChatFeed.jsx';
import RestrictedKeyboard from './components/RestrictedKeyboard.jsx';
import ShopModal          from './components/ShopModal.jsx';
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
  const [toast,     setToast]     = useState(null); // { text, type }

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
      if (result.winner) {
        showToast(
          `🏆 ¡"${result.winner.firstName || result.winner.username}" ganó el prompt! +${result.winner.bonus} 🪙`,
          'success'
        );
      } else {
        showToast('📣 Prompt cerrado — sin votos.', 'info');
      }
      // Update own coins if winner/runner-up
      if (user) {
        const bonus =
          result.winner?.userId   === user.id ? result.winner.bonus :
          result.runnerUp?.userId === user.id ? result.runnerUp.bonus : 0;
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
    socket.on('prompt_error',      onPromptError);

    // ── Black market events ──────────────────────────────────────────
    const onBmCaught = ({ letter, fine, newCoins, newInventory }) => {
      updateUser({ newCoins, newInventory });
      showToast(`⚠️ ¡Atrapado! Letra "${letter.toUpperCase()}" confiscada. Multa: -${fine} 🪙`, 'error');
    };
    const onBmExpired = ({ letter }) => {
      showToast(`⏰ Listado de "${letter.toUpperCase()}" expirado. Letra devuelta.`, 'warn');
    };

    socket.on('bm_caught',  onBmCaught);
    socket.on('bm_expired', onBmExpired);

    return () => {
      socket.off('user_update',      onUpdate);
      socket.off('rejected_message', onRejected);
      socket.off('new_prompt',        onNewPrompt);
      socket.off('new_prompt_reply',  onNewPromptReply);
      socket.off('vote_update',       onVoteUpdate);
      socket.off('prompt_closed',     onPromptClosed);
      socket.off('prompt_error',      onPromptError);
      socket.off('bm_caught',  onBmCaught);
      socket.off('bm_expired', onBmExpired);
    };
  }, [socket, updateUser]);

  function showToast(text, type = 'info') {
    setToast({ text, type });
    setTimeout(() => setToast(null), 3000);
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

  // ── Shop purchase callback ─────────────────────────────────────────────
  const handlePurchase = useCallback((result) => {
    updateUser({
      newCoins:     result.newCoins,
      newInventory: result.newInventory,
    });
    showToast(`🎰 Resultado: ${result.newLetters.join(', ').toUpperCase()}`, 'success');
  }, [updateUser]);

  // ── Prompt fired from shop ─────────────────────────────────────────────
  const handlePromptFired = useCallback((result) => {
    updateUser({ newCoins: result.newCoins });
    setPrompt(result.prompt);
    setPromptReplies([]);
    setReplyMode(false);
    showToast('📣 ¡Tu prompt está activo! Las respuestas están abiertas.', 'success');
  }, [updateUser]);

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
        onShopOpen={() => setShopOpen(true)}
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

      {/* ── Toast notification ──────────────────────────────────────────── */}
      {toast && (
        <div
          className={`
            fixed top-4 left-1/2 -translate-x-1/2 z-50
            ${toastColour} text-white text-xs font-semibold
            px-4 py-2 rounded-full shadow-lg animate-slide-up
            pointer-events-none
          `}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
