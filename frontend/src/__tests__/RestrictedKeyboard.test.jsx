import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RestrictedKeyboard from '../components/RestrictedKeyboard.jsx';

// Tailwind isn't processed in tests – component behaviour is what we're testing

describe('RestrictedKeyboard', () => {
  const noop     = () => {};
  const alphabet = 'abcdefghijklmnopqrstuvwxyzñ';

  // ── Rendering ──────────────────────────────────────────────────────────────
  it('renders all 27 letter keys', () => {
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={noop}
        onSend={noop}
        inventory={{}}
        lockedLetters={[]}
      />
    );
    for (const letter of alphabet) {
      // With empty inventory every key is labelled "<letter> (no stock)"
      expect(screen.getByRole('button', { name: `${letter} (no stock)` })).toBeDefined();
    }
  });

  it('renders the special keys ⌫, ␣, ↵', () => {
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={noop}
        onSend={noop}
        inventory={{}}
        lockedLetters={[]}
      />
    );
    expect(screen.getByRole('button', { name: '⌫' })).toBeDefined();
    expect(screen.getByRole('button', { name: '␣' })).toBeDefined();
    expect(screen.getByRole('button', { name: '↵' })).toBeDefined();
  });

  // ── Inventory badges ────────────────────────────────────────────────────────
  it('shows remaining count badge on each letter key', () => {
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={noop}
        onSend={noop}
        inventory={{ a: 3, b: 1 }}
        lockedLetters={[]}
      />
    );
    // The badge showing "3" should appear for the 'a' key
    const badges = screen.getAllByText('3');
    expect(badges.length).toBeGreaterThan(0);
  });

  it('decrements the badge count based on the current draft', () => {
    // 'a' is in the draft once → remaining should be inventory[a] - 1 = 2
    render(
      <RestrictedKeyboard
        draft="a"
        onDraftChange={noop}
        onSend={noop}
        inventory={{ a: 3 }}
        lockedLetters={[]}
      />
    );
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
  });

  // ── Disabled state ──────────────────────────────────────────────────────────
  it('disables a letter key when inventory is 0', () => {
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={noop}
        onSend={noop}
        inventory={{ a: 0 }}
        lockedLetters={[]}
      />
    );
    // inventory 0 → component labels the key "a (no stock)"
    const aBtn = screen.getByRole('button', { name: 'a (no stock)' });
    expect(aBtn).toBeDisabled();
  });

  it('disables a letter key when inventory is exhausted by the draft', () => {
    render(
      <RestrictedKeyboard
        draft="bb"
        onDraftChange={noop}
        onSend={noop}
        inventory={{ b: 2 }}
        lockedLetters={[]}
      />
    );
    // draft exhausted inventory → remaining 0 → component labels the key "b (no stock)"
    const bBtn = screen.getByRole('button', { name: 'b (no stock)' });
    expect(bBtn).toBeDisabled();
  });

  it('disables a locked letter', () => {
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={noop}
        onSend={noop}
        inventory={{ c: 5 }}
        lockedLetters={['c']}
      />
    );
    const cBtn = screen.getByRole('button', { name: /C.*locked/i });
    expect(cBtn).toBeDisabled();
  });

  it('shows 🔒 badge for locked letters', () => {
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={noop}
        onSend={noop}
        inventory={{ d: 3 }}
        lockedLetters={['d']}
      />
    );
    expect(screen.getByText('🔒')).toBeDefined();
  });

  // ── Key interactions ────────────────────────────────────────────────────────
  it('calls onDraftChange with letter appended when a key is pressed', () => {
    const onDraftChange = vi.fn();
    render(
      <RestrictedKeyboard
        draft="he"
        onDraftChange={onDraftChange}
        onSend={noop}
        inventory={{ h: 1, e: 1, l: 2 }}
        lockedLetters={[]}
      />
    );
    // l has remaining 2 → component labels the key 'l' (just lowercase)
    const lBtn = screen.getByRole('button', { name: 'l' });
    fireEvent.pointerDown(lBtn);
    expect(onDraftChange).toHaveBeenCalledWith('hel');
  });

  it('calls onDraftChange with last char removed when ⌫ is pressed', () => {
    const onDraftChange = vi.fn();
    render(
      <RestrictedKeyboard
        draft="hello"
        onDraftChange={onDraftChange}
        onSend={noop}
        inventory={{}}
        lockedLetters={[]}
      />
    );
    const backspace = screen.getByRole('button', { name: '⌫' });
    fireEvent.pointerDown(backspace);
    expect(onDraftChange).toHaveBeenCalledWith('hell');
  });

  it('calls onSend when ↵ is pressed with a non-empty draft', () => {
    const onSend = vi.fn();
    render(
      <RestrictedKeyboard
        draft="hi"
        onDraftChange={noop}
        onSend={onSend}
        inventory={{}}
        lockedLetters={[]}
      />
    );
    const enter = screen.getByRole('button', { name: '↵' });
    fireEvent.pointerDown(enter);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onSend when ↵ is pressed with empty draft', () => {
    const onSend = vi.fn();
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={noop}
        onSend={onSend}
        inventory={{}}
        lockedLetters={[]}
      />
    );
    const enter = screen.getByRole('button', { name: '↵' });
    fireEvent.pointerDown(enter);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does nothing when a disabled letter key is pressed', () => {
    const onDraftChange = vi.fn();
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={onDraftChange}
        onSend={noop}
        inventory={{ z: 0 }}
        lockedLetters={[]}
      />
    );
    // inventory 0 → component labels the key "z (no stock)"
    const zBtn = screen.getByRole('button', { name: 'z (no stock)' });
    // The button is disabled, so click is suppressed
    fireEvent.pointerDown(zBtn);
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it('does nothing on any key when disabled=true', () => {
    const onDraftChange = vi.fn();
    const onSend        = vi.fn();
    render(
      <RestrictedKeyboard
        draft="a"
        onDraftChange={onDraftChange}
        onSend={onSend}
        inventory={{ a: 5 }}
        lockedLetters={[]}
        disabled
      />
    );
    // inventory 5, draft 'a' → remaining 4 → component labels the key 'a' (just lowercase)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'a' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: '⌫' }));
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  // ── Number row ──────────────────────────────────────────────────────────────────────────
  it('renders all 10 digit keys (0-9) after switching to symbols mode', () => {
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={noop}
        onSend={noop}
        inventory={{ _numbers: 2 }}
        lockedLetters={[]}
      />
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: '123' }));
    for (const d of '0123456789') {
      expect(screen.getByRole('button', { name: d })).toBeDefined();
    }
  });

  it('shows group badge from inventory._numbers on digit keys', () => {
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={noop}
        onSend={noop}
        inventory={{ _numbers: 4 }}
        lockedLetters={[]}
      />
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: '123' }));
    // All digit keys show the same pool remaining (4)
    const badges = screen.getAllByText('4');
    expect(badges.length).toBeGreaterThanOrEqual(10); // one per digit key
  });

  it('disables all digit keys when _numbers pool is exhausted', () => {
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={noop}
        onSend={noop}
        inventory={{ _numbers: 0 }}
        lockedLetters={[]}
      />
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: '123' }));
    for (const d of '0123456789') {
      expect(screen.getByRole('button', { name: `${d} (no stock)` })).toBeDisabled();
    }
  });

  it('pressing a digit key appends it to draft when pool allows', () => {
    const onDraftChange = vi.fn();
    render(
      <RestrictedKeyboard
        draft="hi"
        onDraftChange={onDraftChange}
        onSend={noop}
        inventory={{ h: 1, i: 1, _numbers: 3 }}
        lockedLetters={[]}
      />
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: '123' }));
    const btn5 = screen.getByRole('button', { name: '5' });
    fireEvent.pointerDown(btn5);
    expect(onDraftChange).toHaveBeenCalledWith('hi5');
  });

  // ── Symbol row ──────────────────────────────────────────────────────────────────────────
  it('disables all symbol keys when _symbols pool is exhausted', () => {
    render(
      <RestrictedKeyboard
        draft=""
        onDraftChange={noop}
        onSend={noop}
        inventory={{ _symbols: 0 }}
        lockedLetters={[]}
      />
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: '123' }));
    expect(screen.getByRole('button', { name: '! (no stock)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '? (no stock)' })).toBeDisabled();
  });

  it('pressing a symbol key appends it to draft when pool allows', () => {
    const onDraftChange = vi.fn();
    render(
      <RestrictedKeyboard
        draft="hola"
        onDraftChange={onDraftChange}
        onSend={noop}
        inventory={{ h: 1, o: 1, l: 1, a: 1, _symbols: 2 }}
        lockedLetters={[]}
      />
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: '123' }));
    const qBtn = screen.getByRole('button', { name: '?' });
    fireEvent.pointerDown(qBtn);
    expect(onDraftChange).toHaveBeenCalledWith('hola?');
  });
});
