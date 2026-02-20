import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || '';

/**
 * Manages a single Socket.io connection for the lifetime of the app.
 * Automatically reconnects if the connection drops.
 *
 * @param {string|null} initData  – Telegram WebApp initData string
 * @returns {{
 *   socket: import('socket.io-client').Socket | null,
 *   connected: boolean,
 *   sendMessage: (text: string) => void,
 * }}
 */
export function useSocket(initData) {
  const socketRef  = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!initData) return;

    const socket = io(BACKEND_URL, {
      auth:              { initData },
      transports:        ['websocket'],
      reconnectionDelay: 2000,
    });

    socketRef.current = socket;

    socket.on('connect',    () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [initData]);

  const sendMessage = useCallback((text) => {
    socketRef.current?.emit('send_message', { text });
  }, []);

  return { socket: socketRef.current, connected, sendMessage };
}
