import React, { useEffect, useRef, useState, useCallback } from 'react';
import MessageBubble from './MessageBubble.jsx';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || '';

/**
 * ChatFeed
 * ────────
 * Renders the scrollable message list.
 * Hydrates from REST on mount, then appends real-time socket events.
 *
 * Props:
 *   socket    – Socket.io client instance (or null)
 *   myUserId  – current user's TG id (number)
 *   initData  – raw Telegram initData string (for authenticated reaction calls)
 */
export default function ChatFeed({ socket, myUserId, chatId = 0, initData }) {
  const [messages, setMessages] = useState([]);
  const [loading,  setLoading]  = useState(true);
  // { [messageId]: 'like' | 'dislike' } — the current user's own reactions
  const [myReactions, setMyReactions] = useState({});
  const bottomRef = useRef(null);
  const atBottomRef = useRef(true);

  // ── Hydrate recent messages + my reactions from REST ─────────────────────
  useEffect(() => {
    const roomQ = chatId ? `&roomId=${chatId}` : '';
    fetch(`${BACKEND_URL}/api/messages?limit=50${roomQ}`)
      .then((r) => r.json())
      .then((data) => setMessages(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));

    if (initData && chatId) {
      fetch(`${BACKEND_URL}/api/reactions/my?roomId=${chatId}`, {
        headers: { 'x-init-data': initData },
      })
        .then((r) => r.json())
        .then((data) => { if (data && typeof data === 'object') setMyReactions(data); })
        .catch(() => {});
    }
  }, [chatId, initData]);

  // ── Listen for real-time messages and reaction updates ──────────────────
  useEffect(() => {
    if (!socket) return;

    const handleNew = (msg) => {
      setMessages((prev) => [...prev, { likes: 0, dislikes: 0, ...msg }]);
    };

    const handleReactionUpdate = ({ messageId, likes, dislikes }) => {
      setMessages((prev) =>
        prev.map((m) => m.id === messageId ? { ...m, likes, dislikes } : m)
      );
    };

    socket.on('new_message',    handleNew);
    socket.on('reaction_update', handleReactionUpdate);
    return () => {
      socket.off('new_message',    handleNew);
      socket.off('reaction_update', handleReactionUpdate);
    };
  }, [socket]);

  // ── Reaction handler (optimistic) ───────────────────────────────────────
  const handleReact = useCallback(async (messageId, reaction) => {
    if (!initData) return;

    // Reactions are permanent — ignore if already reacted
    setMyReactions((prev) => {
      if (prev[messageId]) return prev;
      return { ...prev, [messageId]: reaction };
    });

    try {
      await fetch(`${BACKEND_URL}/api/reactions/${messageId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-init-data': initData },
        body: JSON.stringify({ reaction }),
      });
    } catch {
      // On network failure revert by refetching (best-effort)
      if (chatId) {
        fetch(`${BACKEND_URL}/api/reactions/my?roomId=${chatId}`, {
          headers: { 'x-init-data': initData },
        })
          .then((r) => r.json())
          .then((data) => { if (data && typeof data === 'object') setMyReactions(data); })
          .catch(() => {});
      }
    }
  }, [initData, chatId]);

  // ── Auto-scroll to bottom when near it ─────────────────────────────────
  useEffect(() => {
    if (atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleScroll = useCallback((e) => {
    const el = e.currentTarget;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-tg-button border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div
      className="flex-1 overflow-y-auto scrollbar-hidden py-2 flex flex-col gap-1"
      onScroll={handleScroll}
    >
      {messages.length === 0 && (
        <p className="text-center text-tg-hint text-sm mt-16 select-none">
          No messages yet. Be the first to say something!
        </p>
      )}

      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          isOwn={msg.userId === myUserId}
          myReaction={myReactions[msg.id] ?? null}
          onReact={handleReact}
          socket={socket}
        />
      ))}

      <div ref={bottomRef} />
    </div>
  );
}

