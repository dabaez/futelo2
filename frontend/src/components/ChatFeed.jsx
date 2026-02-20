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
 */
export default function ChatFeed({ socket, myUserId }) {
  const [messages, setMessages] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const bottomRef = useRef(null);
  const atBottomRef = useRef(true);

  // ── Hydrate recent messages from REST ──────────────────────────────────
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/messages?limit=50`)
      .then((r) => r.json())
      .then((data) => setMessages(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // ── Listen for real-time messages ───────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    const handleNew = (msg) => {
      setMessages((prev) => [...prev, msg]);
    };

    socket.on('new_message', handleNew);
    return () => socket.off('new_message', handleNew);
  }, [socket]);

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
        />
      ))}

      <div ref={bottomRef} />
    </div>
  );
}
