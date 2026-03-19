import React from 'react';

/**
 * Top header bar – displays the Futelo logo, coin balance, and connection
 * indicator on a single row.
 */
export default function Header({ coins, connected, onShopOpen, onLotteryOpen, hasActiveLottery }) {
  return (
    <header className="flex items-center justify-between px-3 py-2 bg-tg-bg border-b border-tg-bg-sec">
      {/* Brand */}
      <div className="flex items-center gap-1.5">
        <span className="text-xl">💬</span>
        <span className="font-bold text-base text-tg-text tracking-tight">Futelo</span>
        {/* Connection dot */}
        <span className={`w-2 h-2 rounded-full ml-1 ${connected ? 'bg-emerald-400' : 'bg-gray-400'}`} />
      </div>

      {/* Right side: coins + lottery + shop */}
      <div className="flex items-center gap-2">
        <div className="bg-tg-bg-sec rounded-full px-3 py-1 flex items-center gap-1">
          <span className="text-sm">🪙</span>
          <span className="text-sm font-bold text-tg-text">{coins ?? '…'}</span>
        </div>
        <button
          onClick={onLotteryOpen}
          className={`text-xs font-semibold px-3 py-1.5 rounded-full active:opacity-80 transition-opacity relative
            ${hasActiveLottery ? 'bg-amber-400 text-white' : 'bg-tg-bg-sec text-tg-text'}`}
        >
          🎲{hasActiveLottery && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red-500 rounded-full" />}
        </button>
        <button
          onClick={onShopOpen}
          className="bg-tg-button text-tg-btn-text text-xs font-semibold px-3 py-1.5 rounded-full active:opacity-80 transition-opacity"
        >
          Tienda
        </button>
      </div>
    </header>
  );
}
