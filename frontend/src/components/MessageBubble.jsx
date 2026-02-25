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

export default function MessageBubble({ message, isOwn }) {
  // System messages (userId === 0) render as a centred info pill
  if (message.userId === 0) {
    return (
      <div className="flex justify-center px-4 py-1 animate-slide-up">
        <span className="text-[11px] text-tg-hint bg-tg-bg-sec rounded-full px-3 py-1 text-center max-w-[90%]">
          {message.text}
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
        {/* Sender name */}
        {!isOwn && (
          <span className="text-xs font-semibold text-tg-link mb-0.5 ml-1">
            {message.username ? `@${message.username}` : message.firstName}
          </span>
        )}

        {/* Bubble */}
        <div
          className={`
            relative px-3 py-2 rounded-2xl shadow-sm text-sm leading-snug
            ${isOwn
              ? 'bg-tg-button text-tg-btn-text rounded-tr-sm'
              : 'bg-tg-bg-sec text-tg-text rounded-tl-sm'}
          `}
        >
          <span className="whitespace-pre-wrap break-words">{message.text}</span>

          {/* Timestamp tail */}
          <span className={`ml-2 text-[10px] align-bottom select-none ${isOwn ? 'text-blue-200' : 'text-tg-hint'}`}>
            {formatTime(message.createdAt)}
          </span>
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
