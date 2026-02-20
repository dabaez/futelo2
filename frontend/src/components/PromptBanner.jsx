import React, { useState, useEffect } from 'react';

/**
 * PromptBanner
 * ────────────
 * Appears above the keyboard when a prompt is active.
 * Shows the prompt text, countdown, existing replies with vote buttons,
 * and a toggle to switch the keyboard into "reply to prompt" mode.
 *
 * Props:
 *   prompt        – { id, text, closesAt } | null
 *   replies       – [{ id, userId, text, votes, username, firstName }]
 *   myUserId      – number
 *   replyMode     – boolean (keyboard is currently targeting the prompt)
 *   onToggleReply – () => void
 *   onVote        – (replyId) => void
 *   promptError   – string | null  (error from server)
 */
export default function PromptBanner({
  prompt,
  replies,
  myUserId,
  replyMode,
  onToggleReply,
  onVote,
  promptError,
}) {
  const [expanded,  setExpanded]  = useState(true);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // ── Countdown timer ────────────────────────────────────────────────────
  useEffect(() => {
    if (!prompt) return;
    const tick = () => {
      setSecondsLeft(Math.max(0, prompt.closesAt - Math.floor(Date.now() / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [prompt?.closesAt]);

  // Auto-expand when a new prompt arrives
  useEffect(() => {
    if (prompt) setExpanded(true);
  }, [prompt?.id]);

  if (!prompt) return null;

  const mm  = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss  = String(secondsLeft % 60).padStart(2, '0');
  const hasReplied = replies.some((r) => r.userId === myUserId);
  const isExpired  = secondsLeft === 0;

  return (
    <div className="border-t border-tg-bg-sec bg-tg-bg select-none">
      {/* ── Header row ─────────────────────────────────────────────── */}
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-left"
        onPointerDown={() => setExpanded((v) => !v)}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-base leading-none">📣</span>
          <span className="text-xs font-semibold text-tg-text truncate">
            {prompt.text}
          </span>
        </span>
        <span className="flex items-center gap-2 flex-shrink-0 ml-2">
          {!isExpired ? (
            <span className={`text-[11px] font-mono font-bold tabular-nums ${secondsLeft < 30 ? 'text-red-500' : 'text-tg-hint'}`}>
              {mm}:{ss}
            </span>
          ) : (
            <span className="text-[11px] text-tg-hint">cerrado</span>
          )}
          <span className={`text-tg-hint text-xs transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>▾</span>
        </span>
      </button>

      {/* ── Expanded content ────────────────────────────────────────── */}
      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          {/* Error */}
          {promptError && (
            <p className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1">{promptError}</p>
          )}

          {/* Reply mode toggle */}
          {!isExpired && (
            <div className="flex gap-2">
              <button
                onPointerDown={replyMode ? onToggleReply : undefined}
                className={`flex-1 text-xs font-semibold py-1.5 rounded-lg transition-colors ${
                  !replyMode
                    ? 'bg-tg-button text-tg-btn-text'
                    : 'bg-tg-bg-sec text-tg-hint'
                }`}
              >
                💬 Chat
              </button>
              <button
                onPointerDown={!replyMode ? onToggleReply : undefined}
                className={`flex-1 text-xs font-semibold py-1.5 rounded-lg transition-colors ${
                  replyMode
                    ? 'bg-tg-button text-tg-btn-text'
                    : 'bg-tg-bg-sec text-tg-hint'
                }`}
              >
                {hasReplied ? '✏️ Editar respuesta' : '✍️ Responder al prompt'}
              </button>
            </div>
          )}

          {/* Replies list */}
          {replies.length === 0 ? (
            <p className="text-[11px] text-tg-hint text-center py-1">
              No hay respuestas aún — ¡sé el primero!
            </p>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
              {replies.map((reply) => {
                const isOwn    = reply.userId === myUserId;
                const canVote  = !isOwn && !isExpired;
                return (
                  <div
                    key={reply.id}
                    className="flex items-start gap-2 bg-tg-bg-sec rounded-lg px-2.5 py-2"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-[10px] font-semibold text-tg-button mr-1">
                        {reply.username ? `@${reply.username}` : reply.firstName}
                        {isOwn && ' (tú)'}
                      </span>
                      <span className="text-xs text-tg-text break-words">{reply.text}</span>
                    </div>
                    <button
                      onPointerDown={canVote ? () => onVote(reply.id) : undefined}
                      disabled={!canVote}
                      className={`flex-shrink-0 flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full transition-colors ${
                        canVote
                          ? 'text-pink-500 hover:bg-pink-50 active:scale-110'
                          : 'text-tg-hint cursor-default'
                      }`}
                    >
                      ❤️ {reply.votes}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
