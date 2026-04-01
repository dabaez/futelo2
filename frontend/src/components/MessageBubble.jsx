import React from 'react';

/**
 * Single chat bubble, rendered to match Telegram's own chat aesthetic.
 *
 *  own  = sent by the authenticated user → right-aligned, blue bubble
 *  other = left-aligned, grey bubble
 *
 * Props:
 *   message  – { id, userId, username, firstName, photoUrl,
 *                text, coinDelta, tier, createdAt }
 *   isOwn    – boolean
 */

const MISO_REPLACEMENT = 'Ⓜ️ℹ️🆘🅾️🆙';
function replaceMiso(text) {
  return text.replace(/miso\s*soup/gi, MISO_REPLACEMENT);
}

const TIER_META = {
  1: { label: null,                  color: 'text-emerald-400' },
  2: { label: '⚠ Aviso de spam',      color: 'text-yellow-400'  },
  3: { label: '🚫 Penalización',       color: 'text-red-400'     },
};

function Avatar({ photoUrl, firstName }) {
  const initials = (firstName || '?').charAt(0).toUpperCase();
  const cls = 'w-8 h-8 rounded-full flex-shrink-0 self-start flex items-center justify-center text-sm font-semibold text-white select-none';

  if (photoUrl) {
    return <img src={photoUrl} alt={firstName} className={`${cls} object-cover`} />;
  }
  // Deterministic colour from first char
  const colours = [
    'bg-blue-500','bg-purple-500','bg-pink-500','bg-rose-500',
    'bg-orange-500','bg-amber-500','bg-teal-500','bg-cyan-500',
  ];
  const bg = colours[initials.charCodeAt(0) % colours.length];
  return <div className={`${cls} ${bg}`}>{initials}</div>;
}

function formatTime(unixSec) {
  const d = new Date(unixSec * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function MessageBubble({ message, isOwn, socket, myReaction, onReact }) {
  const [reactionMenuOpen, setReactionMenuOpen] = React.useState(false);
  const holdTimerRef = React.useRef(null);

  // April Fools 2026: show gold styling only on April 1, 2026
  const isAprilFools = (() => {
    const d = new Date();
    return d.getFullYear() === 2026 && d.getMonth() === 3 && d.getDate() === 1;
  })();
  const goldLevel = (isAprilFools && message.goldLevel) ? message.goldLevel : 0;

  function startHold(e) {
    // Only trigger on primary pointer (not right-click)
    if (e.button !== undefined && e.button !== 0) return;
    holdTimerRef.current = setTimeout(() => setReactionMenuOpen(true), 400);
  }
  function cancelHold() {
    clearTimeout(holdTimerRef.current);
  }
  function closeMenu() {
    setReactionMenuOpen(false);
  }
  // System messages (userId === 0): check for structured beg payload first
  if (message.userId === 0) {
    let parsed = null;
    try { parsed = JSON.parse(message.text); } catch { /* plain system message */ }

    if (parsed?.type === 'beg') {
      const name = parsed.firstName || parsed.username || 'Alguien';
      return (
        <div className="flex justify-center px-4 py-1 animate-slide-up">
          <div className="flex items-center gap-2 bg-amber-500/15 border border-amber-500/30 rounded-2xl px-3 py-2 max-w-[90%]">
            <span className="text-base">🙏</span>
            <span className="text-xs text-amber-300 flex-1">
              <span className="font-semibold">{name}</span> necesita monedas
              <span className="ml-1 opacity-50">{formatTime(message.createdAt)}</span>
            </span>
            <button
              className="bg-amber-500 text-white text-xs font-semibold rounded-xl px-3 py-1 active:opacity-70 shrink-0"
              onClick={() => socket?.emit('give_coins', { targetUserId: parsed.userId })}
            >
              Dar 10 🪙
            </button>
          </div>
        </div>
      );
    }

    // Plain system message pill
    return (
      <div className="flex justify-center px-4 py-1 animate-slide-up">
        <span className="text-[11px] text-tg-hint bg-tg-bg-sec rounded-full px-3 py-1 text-center max-w-[90%]">
          {replaceMiso(message.text)}
          <span className="ml-1 opacity-50">{formatTime(message.createdAt)}</span>
        </span>
      </div>
    );
  }

  const tier     = TIER_META[message.tier] || TIER_META[1];
  const coinStr  = message.coinDelta > 0
    ? `+${message.coinDelta}`
    : message.coinDelta < 0 ? String(message.coinDelta) : null;

  return (
    <div className={`flex gap-2 px-2 py-0.5 animate-slide-up ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar (only on other side) */}
      {!isOwn && (
        <Avatar
          photoUrl={message.photoUrl}
          firstName={message.firstName || message.username}
        />
      )}

      <div className={`max-w-[78%] flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
        {/* Sender name (other messages only) */}
        {!isOwn && (
          <span className="text-xs font-semibold text-tg-link mb-0.5 ml-1">
            {message.username ? `@${message.username}` : message.firstName}
          </span>
        )}

        {/* Futelo GOLD label — shown for everyone when gold level > 0 */}
        {goldLevel > 0 && (
          <span
            className={`font-black text-yellow-400 break-words ${isOwn ? 'mr-1 text-right' : 'ml-1'}`}
            style={{ fontSize: `${8 + goldLevel * 2}px` }}
          >
            Esta persona tiene Futelo GOLD
          </span>
        )}

        {/* Bubble — long-press to reveal reactions (other messages only) */}
        <div
          className={`
            relative px-3 py-2 rounded-2xl shadow-sm text-sm leading-snug select-none
            ${isOwn
              ? 'bg-tg-button text-tg-btn-text rounded-tr-sm'
              : 'bg-tg-bg-sec text-tg-text rounded-tl-sm'}
          `}
          style={goldLevel > 0 ? { outline: '2px solid #FFD700', outlineOffset: '1px' } : undefined}
          onPointerDown={(!isOwn && !myReaction) ? startHold : undefined}
          onPointerUp={(!isOwn && !myReaction) ? cancelHold : undefined}
          onPointerLeave={(!isOwn && !myReaction) ? cancelHold : undefined}
          onPointerCancel={(!isOwn && !myReaction) ? cancelHold : undefined}
          onContextMenu={(e) => { if (!isOwn) e.preventDefault(); }}
        >
          <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{replaceMiso(message.text)}</span>

          {/* Timestamp tail */}
          <span className={`ml-2 text-[10px] align-bottom select-none ${isOwn ? 'text-blue-200' : 'text-tg-hint'}`}>
            {formatTime(message.createdAt)}
          </span>

          {/* Reaction count badges — always visible when non-zero */}
          {(message.likes > 0 || message.dislikes > 0) && (
            <div className="flex gap-1 mt-1">
              {message.likes > 0 && (
                <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${myReaction === 'like' ? 'bg-tg-button text-tg-btn-text' : 'bg-black/10 text-tg-text'}`}>
                  👍 {message.likes}
                </span>
              )}
              {message.dislikes > 0 && (
                <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${myReaction === 'dislike' ? 'bg-red-500 text-white' : 'bg-black/10 text-tg-text'}`}>
                  👎 {message.dislikes}
                </span>
              )}
            </div>
          )}

          {/* Reaction picker popup — shown on long-press */}
          {reactionMenuOpen && (
            <>
              {/* Backdrop to dismiss */}
              <div className="fixed inset-0 z-40" onPointerDown={closeMenu} />
              <div className={`absolute z-50 bottom-full mb-2 flex gap-1 bg-tg-bg border border-tg-bg-sec rounded-2xl shadow-lg px-2 py-1.5 ${isOwn ? 'right-0' : 'left-0'}`}>
                <button
                  aria-label="like"
                  onPointerDown={(e) => { e.stopPropagation(); onReact?.(message.id, 'like'); closeMenu(); }}
                  className={`text-xl px-2 py-1 rounded-xl transition-colors active:scale-110
                    ${myReaction === 'like' ? 'bg-tg-button/20' : 'hover:bg-tg-bg-sec'}`}
                >
                  👍
                </button>
                <button
                  aria-label="dislike"
                  onPointerDown={(e) => { e.stopPropagation(); onReact?.(message.id, 'dislike'); closeMenu(); }}
                  className={`text-xl px-2 py-1 rounded-xl transition-colors active:scale-110
                    ${myReaction === 'dislike' ? 'bg-red-500/20' : 'hover:bg-tg-bg-sec'}`}
                >
                  👎
                </button>
              </div>
            </>
          )}
        </div>

        {/* Economy badge */}
        {(coinStr || tier.label) && (
          <div className={`flex items-center gap-1 mt-0.5 text-[11px] ${isOwn ? 'mr-1' : 'ml-1'}`}>
            {coinStr && (
              <span className={`font-semibold ${message.coinDelta > 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {coinStr} 🪙
              </span>
            )}
            {tier.label && (
              <span className={`${tier.color} font-medium`}>{tier.label}</span>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
