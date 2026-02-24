import React, { useState } from 'react';

/**
 * DevUserPicker
 * ─────────────
 * Shown only in development (when window.Telegram.WebApp.initData is absent).
 * Lets testers instantly become one of several preset users so they can
 * simulate multi-user interactions in the same browser with different tabs/windows.
 *
 * Generates dev initData tokens in the format expected by the backend:
 *   dev:USER_ID:username:First Name:CHAT_ID:Chat Title
 *
 * Props:
 *   onSelect – (initData: string) => void
 */

// Default dev room shared by all preset users
const DEFAULT_CHAT_ID    = -1001001;
const DEFAULT_CHAT_TITLE = 'Dev Room';

const PRESET_USERS = [
  { id: 1001, username: 'alice',   firstName: 'Alice',   color: 'bg-blue-500'   },
  { id: 1002, username: 'bob',     firstName: 'Bob',     color: 'bg-purple-500' },
  { id: 1003, username: 'charlie', firstName: 'Charlie', color: 'bg-emerald-500' },
  { id: 1004, username: 'diana',   firstName: 'Diana',   color: 'bg-rose-500'   },
];

function makeDevToken({ id, username, firstName, chatId = DEFAULT_CHAT_ID, chatTitle = DEFAULT_CHAT_TITLE }) {
  return `dev:${id}:${username}:${firstName}:${chatId}:${chatTitle}`;
}

export default function DevUserPicker({ onSelect }) {
  const [custom, setCustom]   = useState({ id: '', username: '', firstName: '', chatId: String(DEFAULT_CHAT_ID), chatTitle: DEFAULT_CHAT_TITLE });
  const [error,  setError]    = useState('');

  function handleCustom() {
    const id = parseInt(custom.id, 10);
    if (!id || id <= 0) { setError('El ID de usuario debe ser un número positivo'); return; }
    if (!custom.username.trim()) { setError('El nombre de usuario es obligatorio'); return; }
    if (!custom.firstName.trim()) { setError('El nombre es obligatorio'); return; }
    const chatId = parseInt(custom.chatId, 10) || DEFAULT_CHAT_ID;
    const chatTitle = custom.chatTitle.trim() || DEFAULT_CHAT_TITLE;
    setError('');
    onSelect(makeDevToken({ id, username: custom.username.trim(), firstName: custom.firstName.trim(), chatId, chatTitle }));
  }

  return (
    <div className="h-full flex flex-col items-center justify-center bg-tg-bg px-6">
      {/* Banner */}
      <div className="w-full max-w-sm mb-6 text-center">
        <div className="inline-flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-full px-3 py-1 mb-4">
          <span className="text-amber-500 text-xs font-bold uppercase tracking-wide">Modo dev</span>
        </div>
        <h1 className="text-xl font-bold text-tg-text mb-1">Elige un usuario de prueba</h1>
        <p className="text-sm text-tg-hint">
          Sin sesión de Telegram detectada. Elige un usuario o introduce datos personalizados para simular un jugador.
          Abre varias pestañas con distintos usuarios para probar la economía multi-jugador.
          Todos los usuarios predefinidos comparten la misma sala de desarrollo ({DEFAULT_CHAT_ID}).
        </p>
      </div>

      {/* Preset users */}
      <div className="w-full max-w-sm grid grid-cols-2 gap-3 mb-6">
        {PRESET_USERS.map((u) => (
          <button
            key={u.id}
            onClick={() => onSelect(makeDevToken(u))}
            className="flex items-center gap-3 bg-tg-bg-sec rounded-xl px-4 py-3 active:opacity-80 transition-opacity text-left"
          >
            <div className={`w-9 h-9 rounded-full ${u.color} flex items-center justify-center text-white font-bold text-sm flex-shrink-0`}>
              {u.firstName[0]}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-tg-text truncate">{u.firstName}</p>
              <p className="text-xs text-tg-hint truncate">@{u.username}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Custom user */}
      <div className="w-full max-w-sm border border-tg-bg-sec rounded-xl p-4">
        <p className="text-xs font-semibold text-tg-hint uppercase tracking-wide mb-3">Usuario personalizado</p>

        <div className="flex flex-col gap-2 mb-3">
          <input
            type="number"
            placeholder="ID de usuario  (ej. 9001)"
            value={custom.id}
            onChange={(e) => setCustom((p) => ({ ...p, id: e.target.value }))}
            className="w-full bg-tg-bg-sec rounded-lg px-3 py-2 text-sm text-tg-text placeholder-tg-hint outline-none"
          />
          <input
            type="text"
            placeholder="Nombre de usuario  (ej. mallory)"
            value={custom.username}
            onChange={(e) => setCustom((p) => ({ ...p, username: e.target.value }))}
            className="w-full bg-tg-bg-sec rounded-lg px-3 py-2 text-sm text-tg-text placeholder-tg-hint outline-none"
          />
          <input
            type="text"
            placeholder="Nombre  (ej. Mallory)"
            value={custom.firstName}
            onChange={(e) => setCustom((p) => ({ ...p, firstName: e.target.value }))}
            className="w-full bg-tg-bg-sec rounded-lg px-3 py-2 text-sm text-tg-text placeholder-tg-hint outline-none"
          />
          <input
            type="number"
            placeholder={`ID de sala  (ej. ${DEFAULT_CHAT_ID})`}
            value={custom.chatId}
            onChange={(e) => setCustom((p) => ({ ...p, chatId: e.target.value }))}
            className="w-full bg-tg-bg-sec rounded-lg px-3 py-2 text-sm text-tg-text placeholder-tg-hint outline-none"
          />
          <input
            type="text"
            placeholder="Nombre de sala  (ej. Dev Room)"
            value={custom.chatTitle}
            onChange={(e) => setCustom((p) => ({ ...p, chatTitle: e.target.value }))}
            className="w-full bg-tg-bg-sec rounded-lg px-3 py-2 text-sm text-tg-text placeholder-tg-hint outline-none"
          />
        </div>

        {error && <p className="text-red-500 text-xs mb-2">{error}</p>}

        <button
          onClick={handleCustom}
          className="w-full bg-tg-button text-tg-btn-text font-semibold text-sm py-2.5 rounded-lg active:opacity-80 transition-opacity"
        >
          Entrar como usuario personalizado
        </button>
      </div>

      <p className="text-[10px] text-tg-hint mt-6 text-center">
        Esta pantalla solo aparece cuando no hay <code>window.Telegram.WebApp.initData</code>.<br />
        Nunca se muestra dentro de Telegram.
      </p>
    </div>
  );
}
