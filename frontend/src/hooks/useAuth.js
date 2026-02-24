import { useState, useEffect, useCallback } from 'react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || '';

/**
 * Authenticates the Telegram user against the backend and
 * keeps the local user state (coins, inventory, locks) up to date.
 *
 * @param {string|null} initData
 * @returns {{
 *   user: object|null,
 *   chatId: number,
 *   loading: boolean,
 *   error: string|null,
 *   updateUser: (patch: object) => void,
 * }}
 */
export function useAuth(initData) {
  const [user,    setUser]    = useState(null);
  const [chatId,  setChatId]  = useState(0);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!initData) {
      setLoading(false);
      return;
    }

    fetch(`${BACKEND_URL}/api/auth`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-init-data':  initData,
      },
      body: JSON.stringify({ initData }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setUser({
          ...data.user,
          pickaxeHits: data.user.pickaxe_hits ?? 0,
        });
        setChatId(data.chatId ?? 0);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [initData]);

  // Called by socket 'user_update' events or shop rolls
  const updateUser = useCallback((patch) => {
    setUser((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        coins:         patch.newCoins     ?? prev.coins,
        inventory:     patch.newInventory ?? prev.inventory,
        lockedLetters: patch.lockedLetter
          ? [...(prev.lockedLetters || []), patch.lockedLetter]
          : prev.lockedLetters,
        pickaxeHits:   patch.pickaxeHits  ?? prev.pickaxeHits,
      };
    });
  }, []);

  return { user, chatId, loading, error, updateUser };
}
