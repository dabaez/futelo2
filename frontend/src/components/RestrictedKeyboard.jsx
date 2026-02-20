import React, { useState, useCallback, useMemo } from 'react';

/**
 * RestrictedKeyboard
 * ──────────────────
 * A custom on-screen keyboard that disables keys the user cannot use:
 *   - Letter is locked (Tier-3 penalty)
 *   - The current draft already uses letter X more times than inventory[X]
 *
 * Props:
 *   draft         – string  (current message being composed)
 *   onDraftChange – (newDraft: string) => void
 *   onSend        – () => void
 *   inventory     – { a: 2, b: 1, … }
 *   lockedLetters – string[]  letters currently locked
 *   disabled      – boolean  (sending in progress)
 */

const ROWS = [
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['⌫','z','x','c','v','b','n','m','ñ'],
  [' ','↵'],
];

const SPECIAL_LABELS = {
  '⌫': '⌫',
  ' ': '␣',
  '↵': '↵',
};

/**
 * Count letters already used in the draft string.
 */
function countLetters(str) {
  const counts = {};
  for (const ch of str.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || ch === 'ñ') counts[ch] = (counts[ch] || 0) + 1;
  }
  return counts;
}

export default function RestrictedKeyboard({
  draft,
  onDraftChange,
  onSend,
  inventory     = {},
  lockedLetters = [],
  disabled      = false,
}) {
  const lockedSet = useMemo(() => new Set(lockedLetters), [lockedLetters]);
  const draftCounts = useMemo(() => countLetters(draft), [draft]);

  /**
   * Determine why a letter key is disabled (returns reason string or null).
   */
  const getDisableReason = useCallback((key) => {
    if (key === '⌫' || key === ' ' || key === '↵') return null;
    if (lockedSet.has(key)) return 'locked';
    const used    = draftCounts[key] || 0;
    const allowed = inventory[key]   || 0;
    if (used >= allowed) return 'no-inventory';
    return null;
  }, [lockedSet, draftCounts, inventory]);

  const handleKey = useCallback((key) => {
    if (disabled) return;

    if (key === '⌫') {
      onDraftChange(draft.slice(0, -1));
      return;
    }
    if (key === '↵') {
      if (draft.trim().length > 0) onSend();
      return;
    }
    // All other keys — append to draft
    const disableReason = getDisableReason(key);
    if (disableReason) return;
    onDraftChange(draft + key);
  }, [disabled, draft, onDraftChange, onSend, getDisableReason]);

  return (
    <div
      className="w-full bg-tg-bg-sec px-1 pb-2 pt-1 select-none"
      style={{ touchAction: 'manipulation' }}
    >
      {ROWS.map((row, ri) => (
        <div key={ri} className="flex justify-center gap-1 mb-1">
          {row.map((key) => {
            const isSpecial = key in SPECIAL_LABELS;
            const reason    = isSpecial ? null : getDisableReason(key);
            const isLocked  = reason === 'locked';
            const noStock   = reason === 'no-inventory';
            const isBackspace = key === '⌫';
            const isSend    = key === '↵';
            const isSpace   = key === ' ';

            // Badge: how many more of this letter can be used
            const used     = draftCounts[key] || 0;
            const allowed  = inventory[key]   || 0;
            const remaining = Math.max(0, allowed - used);

            let baseClass = `
              relative flex-shrink-0 flex items-center justify-center
              rounded-lg text-sm font-medium
              transition-all duration-100 key-press
              active:brightness-90
            `;

            // Layout widths
            if (isBackspace || isSend) {
              baseClass += ' w-10 h-11';
            } else if (isSpace) {
              baseClass += ' flex-1 h-11 min-w-0 mx-1';
            } else {
              baseClass += ' w-9 h-11';
            }

            // Colour variants
            if (isSend) {
              baseClass += ` ${draft.trim().length > 0
                ? 'bg-tg-button text-tg-btn-text'
                : 'bg-gray-300 text-gray-500'
              }`;
            } else if (isLocked) {
              baseClass += ' bg-red-100 text-red-400 cursor-not-allowed';
            } else if (noStock) {
              baseClass += ' bg-gray-200 text-gray-400 cursor-not-allowed opacity-50';
            } else if (isBackspace) {
              baseClass += ' bg-gray-300 text-gray-700';
            } else {
              baseClass += ' bg-white text-gray-900 shadow-sm';
            }

            return (
              <button
                key={key}
                type="button"
                disabled={disabled || (noStock && !isSpecial) || isLocked}
                onPointerDown={(e) => {
                  e.preventDefault(); // Prevent focus stealing from main input
                  handleKey(key);
                }}
                className={baseClass}
                aria-label={isLocked ? `${key} locked` : noStock ? `${key} (no stock)` : key}
              >
                {/* Key label */}
                <span>{SPECIAL_LABELS[key] ?? key.toUpperCase()}</span>

                {/* Inventory counter badge (letter keys only) */}
                {!isSpecial && (
                  <span
                    className={`
                      absolute top-0.5 right-0.5
                      text-[8px] leading-none font-bold
                      ${isLocked ? 'text-red-400' : noStock ? 'text-gray-400' : 'text-tg-button'}
                    `}
                  >
                    {isLocked ? '🔒' : remaining}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
