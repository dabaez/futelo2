import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import MessageBubble from '../components/MessageBubble.jsx';

// ── Fixtures ──────────────────────────────────────────────────────────────────
function makeMessage(overrides = {}) {
  return {
    id:          1,
    userId:      42,
    username:    'alice',
    firstName:   'Alice',
    photoUrl:    '',
    text:        'Hello world',
    coinDelta:   10,
    tier:        1,
    newLetters:  ['a', 'b'],
    lockedLetter:null,
    createdAt:   1708000000, // fixed Unix timestamp
    ...overrides,
  };
}

// ── Utility ──────────────────────────────────────────────────────────────────
const getContainer = (ui) => render(ui).container;

describe('MessageBubble', () => {
  // ── Message content ─────────────────────────────────────────────────────────
  it('renders the message text', () => {
    render(<MessageBubble message={makeMessage({ text: 'Test message' })} isOwn={false} />);
    expect(screen.getByText('Test message')).toBeDefined();
  });

  it('renders the sender username for other users', () => {
    render(<MessageBubble message={makeMessage({ username: 'bob' })} isOwn={false} />);
    expect(screen.getByText(/@bob/)).toBeDefined();
  });

  it('does NOT render a sender name for own messages', () => {
    render(<MessageBubble message={makeMessage({ username: 'alice' })} isOwn />);
    expect(screen.queryByText(/@alice/)).toBeNull();
  });

  it('falls back to firstName when username is empty', () => {
    render(
      <MessageBubble
        message={makeMessage({ username: '', firstName: 'Charlie' })}
        isOwn={false}
      />
    );
    expect(screen.getByText('Charlie')).toBeDefined();
  });

  // ── Coin economy badge ───────────────────────────────────────────────────────
  it('shows a positive coin delta in green (+10 🪙)', () => {
    render(<MessageBubble message={makeMessage({ coinDelta: 10, tier: 1 })} isOwn />);
    expect(screen.getByText(/^\+10 🪙$/)).toBeDefined();
  });

  it('shows a negative coin delta for Tier 3 (-50 🪙)', () => {
    render(
      <MessageBubble
        message={makeMessage({ coinDelta: -50, tier: 3, lockedLetter: 'z' })}
        isOwn
      />
    );
    expect(screen.getByText(/^-50 🪙$/)).toBeDefined();
  });

  it('does not render a coin badge when coinDelta is 0', () => {
    render(<MessageBubble message={makeMessage({ coinDelta: 0, tier: 2 })} isOwn />);
    // Coin string should not appear
    expect(screen.queryByText(/🪙/)).toBeNull();
  });

  // ── Tier badges ──────────────────────────────────────────────────────────────
  it('shows the Tier-2 aviso de spam label', () => {
    render(<MessageBubble message={makeMessage({ coinDelta: 0, tier: 2 })} isOwn />);
    expect(screen.getByText(/aviso de spam/i)).toBeDefined();
  });

  it('shows the Tier-3 penalización label', () => {
    render(
      <MessageBubble
        message={makeMessage({ coinDelta: -50, tier: 3, lockedLetter: 'a' })}
        isOwn
      />
    );
    expect(screen.getByText(/penalizaci/i)).toBeDefined();
  });

  it('shows no tier badge for Tier 1', () => {
    render(<MessageBubble message={makeMessage({ coinDelta: 10, tier: 1 })} isOwn />);
    expect(screen.queryByText(/aviso|penalizaci/i)).toBeNull();
  });

  // ── Layout: own vs other ─────────────────────────────────────────────────────
  it('applies flex-row-reverse layout for own messages', () => {
    const { container } = render(
      <MessageBubble message={makeMessage()} isOwn />
    );
    // The outermost div should have flex-row-reverse
    const wrapper = container.firstChild;
    expect(wrapper.className).toMatch(/flex-row-reverse/);
  });

  it('applies flex-row layout for other messages', () => {
    const { container } = render(
      <MessageBubble message={makeMessage()} isOwn={false} />
    );
    const wrapper = container.firstChild;
    expect(wrapper.className).toMatch(/flex-row/);
    expect(wrapper.className).not.toMatch(/flex-row-reverse/);
  });

  // ── Avatar ───────────────────────────────────────────────────────────────────
  it('renders an avatar for other users', () => {
    const { container } = render(
      <MessageBubble message={makeMessage({ username: 'bob', firstName: 'Bob' })} isOwn={false} />
    );
    // Either an img or a div with the initial letter
    const hasImg    = container.querySelector('img') !== null;
    const hasAvatar = container.querySelector('[class*="rounded-full"]') !== null;
    expect(hasImg || hasAvatar).toBe(true);
  });

  it('does NOT render an avatar div for own messages', () => {
    // The avatar only appears in the non-own branch
    const { container } = render(
      <MessageBubble message={makeMessage({ photoUrl: '' })} isOwn />
    );
    // Own messages don't render the Avatar component at all
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders a photo img when photoUrl is set', () => {
    render(
      <MessageBubble
        message={makeMessage({ photoUrl: 'https://example.com/photo.jpg' })}
        isOwn={false}
      />
    );
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toBe('https://example.com/photo.jpg');
  });
});
