import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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

// ── Miso soup replacement ─────────────────────────────────────────────────────
describe('miso soup replacement', () => {
  const EMOJI = 'Ⓜ️ℹ️🆘🅾️🆙';

  it('replaces "miso soup" (with space) in message text', () => {
    render(<MessageBubble message={makeMessage({ text: 'I love miso soup today' })} isOwn={false} />);
    expect(screen.getByText(`I love ${EMOJI} today`)).toBeDefined();
  });

  it('replaces "misosoup" (no space) in message text', () => {
    render(<MessageBubble message={makeMessage({ text: 'misosoup is great' })} isOwn={false} />);
    expect(screen.getByText(`${EMOJI} is great`)).toBeDefined();
  });

  it('is case-insensitive (MISO SOUP)', () => {
    render(<MessageBubble message={makeMessage({ text: 'MISO SOUP rules' })} isOwn={false} />);
    expect(screen.getByText(`${EMOJI} rules`)).toBeDefined();
  });

  it('replaces "miso soup" inside system message pills too', () => {
    render(
      <MessageBubble
        message={makeMessage({ userId: 0, text: 'Someone mentioned miso soup here' })}
        isOwn={false}
      />
    );
    expect(screen.getByText(new RegExp(EMOJI))).toBeDefined();
  });
});

// ── System message pill ───────────────────────────────────────────────────────
describe('system message (userId === 0)', () => {
  it('renders as a centred pill (not a chat bubble)', () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({ userId: 0, text: 'Prompt closed.' })}
        isOwn={false}
      />
    );
    // Should have a justify-center wrapper, not flex-row / flex-row-reverse
    const wrapper = container.firstChild;
    expect(wrapper.className).toMatch(/justify-center/);
    expect(wrapper.className).not.toMatch(/flex-row-reverse/);
  });

  it('shows the system message text', () => {
    render(
      <MessageBubble
        message={makeMessage({ userId: 0, text: 'Lotería cerrada.' })}
        isOwn={false}
      />
    );
    expect(screen.getByText(/loter/i)).toBeDefined();
  });
});

// ── Beg card ─────────────────────────────────────────────────────────────────
describe('beg card (system message with type=beg payload)', () => {
  function makeBegMessage(overrides = {}) {
    return {
      id:        99,
      userId:    0,
      text:      JSON.stringify({ type: 'beg', userId: 77, firstName: 'Carlos', username: 'carlos77' }),
      coinDelta: 0,
      createdAt: 1708000000,
      ...overrides,
    };
  }

  it('renders the beggar name and call-to-action text', () => {
    render(<MessageBubble message={makeBegMessage()} isOwn={false} />);
    expect(screen.getByText(/Carlos/)).toBeDefined();
    expect(screen.getByText(/necesita monedas/i)).toBeDefined();
  });

  it('renders a "Dar 10 🪙" button', () => {
    render(<MessageBubble message={makeBegMessage()} isOwn={false} />);
    expect(screen.getByRole('button', { name: /dar 10/i })).toBeDefined();
  });

  it('calls socket.emit("give_coins", { targetUserId }) when button is clicked', () => {
    const mockSocket = { emit: vi.fn() };
    render(<MessageBubble message={makeBegMessage()} isOwn={false} socket={mockSocket} />);
    fireEvent.click(screen.getByRole('button', { name: /dar 10/i }));
    expect(mockSocket.emit).toHaveBeenCalledWith('give_coins', { targetUserId: 77 });
  });

  it('uses username as fallback when firstName is absent', () => {
    const msg = makeBegMessage({
      text: JSON.stringify({ type: 'beg', userId: 77, firstName: '', username: 'nocname' }),
    });
    render(<MessageBubble message={msg} isOwn={false} />);
    expect(screen.getByText(/nocname/)).toBeDefined();
  });

  it('falls back to "Alguien" when both firstName and username are absent', () => {
    const msg = makeBegMessage({
      text: JSON.stringify({ type: 'beg', userId: 77, firstName: '', username: '' }),
    });
    render(<MessageBubble message={msg} isOwn={false} />);
    expect(screen.getByText(/Alguien/)).toBeDefined();
  });

  it('does NOT show the "Dar" button when no socket is provided', () => {
    render(<MessageBubble message={makeBegMessage()} isOwn={false} />);
    // Button still renders but emitting via undefined socket should not throw
    const btn = screen.getByRole('button', { name: /dar 10/i });
    expect(() => fireEvent.click(btn)).not.toThrow();
  });
});
