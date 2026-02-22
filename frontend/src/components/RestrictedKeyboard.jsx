import React, { useState, useCallback, useMemo } from 'react';

/**
 * RestrictedKeyboard
 * ──────────────────
 * A two-layout on-screen keyboard.
 *
 *  Letters mode (default)        Symbols mode (tap "123")
 *  ──────────────────────        ──────────────────────────
 *  Q W E R T Y U I O P          1 2 3 4 5 6 7 8 9 0
 *   A S D F G H J K L           ! ? . , : -
 *  ⌫ Z X C V B N M Ñ           ( ) @ # & *
 *  [123]  [space]  [↵]          [ABC]  [⌫]  [space]  [↵]
 *
 * Props:
 *   draft         – string  (current message being composed)
 *   onDraftChange – (newDraft: string) => void
 *   onSend        – () => void
 *   inventory     – { a: 2, _numbers: 1, _symbols: 3, … }
 *   lockedLetters – string[]  letters currently locked
 *   disabled      – boolean  (sending in progress)
 */

// Characters that use the shared _numbers inventory pool (0-9)
const NUMBER_ROW  = ['1','2','3','4','5','6','7','8','9','0'];
// Characters that use the shared _symbols inventory pool — must match backend SYMBOL_CHARS
const SYMBOL_CHARS = '!?.,:-()@#&*';
const SYMBOL_ROW1 = ['!','?','.',',',':','-'];
const SYMBOL_ROW2 = ['(',')',  '@','#','&','*'];

// Sentinel keys that toggle the layout – never appended to draft
const MODE_TO_SYMBOLS = '123';
const MODE_TO_LETTERS = 'ABC';

const LETTER_ROWS = [
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['⌫','z','x','c','v','b','n','m','ñ'],
  [MODE_TO_SYMBOLS, ' ', '↵'],
];

const SYMBOL_ROWS = [
  NUMBER_ROW,
  SYMBOL_ROW1,
  SYMBOL_ROW2,
  [MODE_TO_LETTERS, '⌫', ' ', '↵'],
];

const SPECIAL_LABELS = {
  '⌫':            '⌫',
  ' ':            '␣',
  '↵':            '↵',
  [MODE_TO_SYMBOLS]: MODE_TO_SYMBOLS,
  [MODE_TO_LETTERS]: MODE_TO_LETTERS,
};

/**
 * Count all inventory-relevant characters used in the draft string.
 * Letters counted individually; digits → _numbers; symbols → _symbols.
 */
function countDraftChars(str) {
  const counts = {};
  for (const ch of str) {
    const lc = ch.toLowerCase();
    if ((lc >= 'a' && lc <= 'z') || lc === 'ñ') {
      counts[lc] = (counts[lc] || 0) + 1;
    } else if (ch >= '0' && ch <= '9') {
      counts._numbers = (counts._numbers || 0) + 1;
    } else if (SYMBOL_CHARS.includes(ch)) {
      counts._symbols = (counts._symbols || 0) + 1;
    }
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
  const [mode, setMode]   = useState('letters'); // 'letters' | 'symbols'
  const lockedSet         = useMemo(() => new Set(lockedLetters), [lockedLetters]);
  const draftCounts       = useMemo(() => countDraftChars(draft), [draft]);

  const activeRows = mode === 'letters' ? LETTER_ROWS : SYMBOL_ROWS;

  const isMode = (key) => key === MODE_TO_SYMBOLS || key === MODE_TO_LETTERS;

  /**
   * Returns the reason a key is disabled, or null if it's usable.
   * Mode-toggle and backspace/space/enter are never disabled via inventory.
   */
  const getDisableReason = useCallback((key) => {
    if (isMode(key) || key === '⌫' || key === ' ' || key === '↵') return null;
    if (key >= '0' && key <= '9') {
      if (lockedSet.has('_numbers')) return 'locked';
      return (draftCounts._numbers || 0) >= (inventory._numbers || 0) ? 'no-inventory' : null;
    }
    if (SYMBOL_CHARS.includes(key)) {
      if (lockedSet.has('_symbols')) return 'locked';
      return (draftCounts._symbols || 0) >= (inventory._symbols || 0) ? 'no-inventory' : null;
    }
    if (lockedSet.has(key)) return 'locked';
    return (draftCounts[key] || 0) >= (inventory[key] || 0) ? 'no-inventory' : null;
  }, [lockedSet, draftCounts, inventory]);

  const handleKey = useCallback((key) => {
    if (disabled) return;
    if (key === MODE_TO_SYMBOLS) { setMode('symbols'); return; }
    if (key === MODE_TO_LETTERS) { setMode('letters'); return; }
    if (key === '⌫') { onDraftChange(draft.slice(0, -1)); return; }
    if (key === '↵') { if (draft.trim().length > 0) onSend(); return; }
    if (getDisableReason(key)) return;
    onDraftChange(draft + key);
  }, [disabled, draft, onDraftChange, onSend, getDisableReason]);

  return (
    <div
      className="w-full bg-tg-bg-sec px-1 pb-2 pt-1 select-none"
      style={{ touchAction: 'manipulation' }}
    >
      {activeRows.map((row, ri) => (
        <div key={ri} className="flex justify-center gap-1 mb-1">
          {row.map((key) => {
            const isSpecial   = key in SPECIAL_LABELS;
            const isModeKey   = isMode(key);
            const isBackspace = key === '⌫';
            const isSend      = key === '↵';
            const isSpace     = key === ' ';
            const isNumber    = key >= '0' && key <= '9';
            const isSymbol    = SYMBOL_CHARS.includes(key);

            const reason    = (isSpecial && !isNumber && !isSymbol) ? null : getDisableReason(key);
            const isLocked  = reason === 'locked';
            const noStock   = reason === 'no-inventory';

            // Remaining-uses badge value
            let remaining = 0;
            if (isNumber) {
              remaining = Math.max(0, (inventory._numbers || 0) - (draftCounts._numbers || 0));
            } else if (isSymbol) {
              remaining = Math.max(0, (inventory._symbols || 0) - (draftCounts._symbols || 0));
            } else if (!isSpecial) {
              remaining = Math.max(0, (inventory[key] || 0) - (draftCounts[key] || 0));
            }

            // Base class
            let cls = `
              relative flex-shrink-0 flex items-center justify-center
              rounded-lg font-medium transition-all duration-100
              active:brightness-90
            `;

            // Size
            if (isModeKey || isBackspace) {
              cls += ' w-10 h-11 text-xs';
            } else if (isSend) {
              cls += ' w-10 h-11 text-sm';
            } else if (isSpace) {
              cls += ' flex-1 h-11 min-w-0 mx-1 text-sm';
            } else if (isNumber || isSymbol) {
              cls += ' w-9 h-11 text-sm';
            } else {
              cls += ' w-9 h-11 text-sm';
            }

            // Colour
            if (isSend) {
              cls += ` ${draft.trim().length > 0
                ? 'bg-tg-button text-tg-btn-text'
                : 'bg-gray-300 text-gray-500'}`;
            } else if (isModeKey) {
              cls += ' bg-gray-400 text-white';
            } else if (isLocked) {
              cls += ' bg-red-100 text-red-400 cursor-not-allowed';
            } else if (noStock) {
              cls += ' bg-gray-200 text-gray-400 cursor-not-allowed opacity-50';
            } else if (isBackspace) {
              cls += ' bg-gray-300 text-gray-700';
            } else {
              cls += ' bg-white text-gray-900 shadow-sm';
            }

            const ariaLabel = isModeKey  ? key
              : isLocked  ? `${key} locked`
              : noStock   ? `${key} (no stock)`
              : (SPECIAL_LABELS[key] ?? key);

            return (
              <button
                key={key}
                type="button"
                disabled={disabled || (!isModeKey && !isSpecial && (noStock || isLocked))}
                onPointerDown={(e) => {
                  e.preventDefault();
                  handleKey(key);
                }}
                className={cls}
                aria-label={ariaLabel}
              >
                <span>{SPECIAL_LABELS[key] ?? key.toUpperCase()}</span>

                {/* Inventory badge — shown on all non-special keys */}
                {!isSpecial && !isModeKey && (
                  <span className={`
                    absolute top-0.5 right-0.5
                    text-[8px] leading-none font-bold
                    ${isLocked ? 'text-red-400' : noStock ? 'text-gray-400' : 'text-tg-button'}
                  `}>
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
