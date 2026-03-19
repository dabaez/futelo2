'use strict';

/**
 * prompt.test.js
 * ──────────────
 * Unit tests for the community prompt engine (promptEngine.js).
 * All DB interactions are mocked – no SQLite file is needed.
 */

// ── Mock the DB layer ────────────────────────────────────────────────────────
const mockStmts = {
  // Prompt lifecycle
  insertPrompt:       { run: jest.fn() },
  getPromptById:      { get: jest.fn() },
  getActivePrompt:    { get: jest.fn() },
  closePrompt:        { run: jest.fn() },
  getPromptReplies:   { all: jest.fn() },
  // Replies
  insertPromptReply:  { run: jest.fn() },
  getPromptReplyById: { get: jest.fn() },
  getUserPromptReply: { get: jest.fn() },
  // Votes
  insertVote:   { run: jest.fn() },
  getVoteCount: { get: jest.fn() },
  // Room-scoped coin / member stmts
  getRoomMember:       { get: jest.fn() },
  updateRoomCoins:     { run: jest.fn() },
  updateRoomInventory: { run: jest.fn() },
  // game_state (used by pickNextPrompt to avoid repeating recent prompts)
  getState: { get: jest.fn() },
  setState: { run: jest.fn() },
};

jest.mock('../db/database', () => ({
  db: {
    transaction:  jest.fn(),
    prepare:      jest.fn(() => ({ all: jest.fn(() => []) })),
  },
  stmts: mockStmts,
  requireUser: jest.fn(),
  requireRoomMember: jest.fn(),
}));

const {
  buyPrompt,
  getActivePrompt,
  submitReply,
  castVote,
  closePrompt,
} = require('../engine/promptEngine');

const { db, stmts, requireUser, requireRoomMember } = require('../db/database');
const {
  PROMPT_BUY_COST,
  PROMPT_REPLY_BONUS,
  PROMPT_WINNER_BONUS,
  PROMPT_RUNNER_UP_BONUS,
} = require('../config');

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeUser(overrides = {}) {
  return {
    id:             1,
    username:       'alice',
    first_name:     'Alice',
    coins:          500,
    inventory_json: JSON.stringify({ a: 2 }),
    ...overrides,
  };
}

function makePrompt(overrides = {}) {
  return {
    id:        1,
    text:      '¿Qué harías con un millón de monedas?',
    closes_at: Math.floor(Date.now() / 1000) + 3600,
    closed:    0,
    room_id:   0,
    ...overrides,
  };
}

function makeReply(overrides = {}) {
  return {
    id:        1,
    prompt_id: 1,
    user_id:   2,
    text:      'Comprar más letras',
    votes:     0,
    username:  'bob',
    first_name:'Bob',
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  db.transaction.mockImplementation((fn) => () => fn());
  // db.prepare is called by pickNextPrompt – return empty array so any prompt in PROMPT_POOL is eligible
  db.prepare.mockReturnValue({ all: jest.fn(() => []) });
  // insertPrompt returns a row id
  mockStmts.insertPrompt.run.mockReturnValue({ lastInsertRowid: 1 });
});

// ─────────────────────────────────────────────────────────────────────────────
// buyPrompt
// ─────────────────────────────────────────────────────────────────────────────
describe('buyPrompt', () => {
  test('throws when user has insufficient coins', () => {
    requireUser.mockReturnValue(makeUser({ coins: PROMPT_BUY_COST - 1 }));
    stmts.getActivePrompt.get.mockReturnValue(null);
    requireRoomMember.mockReturnValue(makeUser({ coins: PROMPT_BUY_COST - 1 }));

    expect(() => buyPrompt(1, 0)).toThrow(/insuficiente/i);
  });

  test('throws when a prompt is already active', () => {
    requireUser.mockReturnValue(makeUser());
    stmts.getActivePrompt.get.mockReturnValue(makePrompt());

    expect(() => buyPrompt(1, 0)).toThrow(/activo/i);
  });

  test('deducts PROMPT_BUY_COST and returns the new prompt', () => {
    const user = makeUser({ coins: PROMPT_BUY_COST + 100 });
    requireUser.mockReturnValue(user);
    stmts.getActivePrompt.get.mockReturnValue(null);
    requireRoomMember.mockReturnValue(user);
    stmts.getRoomMember.get.mockReturnValue({ ...user, coins: user.coins - PROMPT_BUY_COST });

    const result = buyPrompt(1, 0);

    expect(stmts.updateRoomCoins.run).toHaveBeenCalledWith(-PROMPT_BUY_COST, 0, 1);
    expect(result.newCoins).toBe(user.coins - PROMPT_BUY_COST);
    expect(result.prompt).toMatchObject({ id: 1 });
    expect(typeof result.prompt.text).toBe('string');
    expect(result.prompt.text.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getActivePrompt
// ─────────────────────────────────────────────────────────────────────────────
describe('getActivePrompt', () => {
  test('returns null when no prompt is active', () => {
    stmts.getActivePrompt.get.mockReturnValue(null);
    expect(getActivePrompt(0)).toBeNull();
  });

  test('returns the active prompt row', () => {
    const prompt = makePrompt();
    stmts.getActivePrompt.get.mockReturnValue(prompt);
    expect(getActivePrompt(0)).toEqual(prompt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// submitReply
// ─────────────────────────────────────────────────────────────────────────────
describe('submitReply', () => {
  test('throws when prompt not found', () => {
    stmts.getPromptById.get.mockReturnValue(null);
    expect(() => submitReply(1, 99, 'hola')).toThrow(/encontrado/i);
  });

  test('throws when prompt is closed', () => {
    stmts.getPromptById.get.mockReturnValue(makePrompt({ closed: 1 }));
    expect(() => submitReply(1, 1, 'hola')).toThrow(/cerrado/i);
  });

  test('throws when prompt time has expired', () => {
    const expired = makePrompt({ closes_at: Math.floor(Date.now() / 1000) - 10 });
    stmts.getPromptById.get.mockReturnValue(expired);
    expect(() => submitReply(1, 1, 'hola')).toThrow(/tiempo/i);
  });

  test('throws when reply text is empty', () => {
    stmts.getPromptById.get.mockReturnValue(makePrompt());
    stmts.insertPromptReply.run.mockReturnValue({ lastInsertRowid: 1, changes: 1 });
    expect(() => submitReply(1, 1, '   ')).toThrow(/vac/i);
  });

  test('throws when reply text exceeds 200 characters', () => {
    stmts.getPromptById.get.mockReturnValue(makePrompt());
    expect(() => submitReply(1, 1, 'x'.repeat(201))).toThrow(/larga/i);
  });

  test('grants PROMPT_REPLY_BONUS and returns reply payload', () => {
    const prompt = makePrompt({ room_id: 0 });
    const user   = makeUser({ id: 1 });
    const reply  = makeReply({ id: 5, user_id: 1, text: 'Mi respuesta' });

    stmts.getPromptById.get.mockReturnValue(prompt);
    stmts.insertPromptReply.run.mockReturnValue({ lastInsertRowid: 5, changes: 1 });
    stmts.getPromptReplyById.get.mockReturnValue(reply);
    stmts.updateRoomCoins.run.mockReturnValue(undefined);
    stmts.getRoomMember.get.mockReturnValue({ ...user, coins: user.coins + PROMPT_REPLY_BONUS });

    const result = submitReply(1, 1, 'Mi respuesta');

    expect(stmts.updateRoomCoins.run).toHaveBeenCalledWith(PROMPT_REPLY_BONUS, 0, 1);
    expect(result.text).toBe('Mi respuesta');
    expect(result.replyBonus).toBe(PROMPT_REPLY_BONUS);
    expect(result.newCoins).toBe(user.coins + PROMPT_REPLY_BONUS);
  });

  test('throws when user already replied (insertOrIgnore returns changes=0)', () => {
    stmts.getPromptById.get.mockReturnValue(makePrompt());
    stmts.insertPromptReply.run.mockReturnValue({ lastInsertRowid: 0, changes: 0 });
    expect(() => submitReply(1, 1, 'ya respondí')).toThrow(/ya respondiste/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// castVote
// ─────────────────────────────────────────────────────────────────────────────
describe('castVote', () => {
  test('throws when reply not found', () => {
    stmts.getPromptReplyById.get.mockReturnValue(null);
    expect(() => castVote(99, 1)).toThrow(/encontrada/i);
  });

  test('throws when voter tries to vote their own reply', () => {
    stmts.getPromptReplyById.get.mockReturnValue(makeReply({ user_id: 10 }));
    stmts.getPromptById.get.mockReturnValue(makePrompt());
    expect(() => castVote(10, 1)).toThrow(/propia/i);
  });

  test('throws when the prompt is already closed', () => {
    stmts.getPromptReplyById.get.mockReturnValue(makeReply({ user_id: 2 }));
    stmts.getPromptById.get.mockReturnValue(makePrompt({ closed: 1 }));
    expect(() => castVote(99, 1)).toThrow(/cerrada/i);
  });

  test('throws when user votes the same reply twice', () => {
    stmts.getPromptReplyById.get.mockReturnValue(makeReply({ user_id: 2 }));
    stmts.getPromptById.get.mockReturnValue(makePrompt());
    stmts.insertVote.run.mockReturnValue({ changes: 0 }); // OR IGNORE fired
    expect(() => castVote(99, 1)).toThrow(/ya votaste/i);
  });

  test('returns replyId and updated vote count on success', () => {
    stmts.getPromptReplyById.get.mockReturnValue(makeReply({ user_id: 2 }));
    stmts.getPromptById.get.mockReturnValue(makePrompt());
    stmts.insertVote.run.mockReturnValue({ changes: 1 });
    stmts.getVoteCount.get.mockReturnValue({ votes: 3 });

    const result = castVote(99, 1);

    expect(result.replyId).toBe(1);
    expect(result.votes).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// closePrompt
// ─────────────────────────────────────────────────────────────────────────────
describe('closePrompt', () => {
  test('returns null when prompt not found or already closed', () => {
    stmts.getPromptById.get.mockReturnValue(null);
    expect(closePrompt(99)).toBeNull();

    stmts.getPromptById.get.mockReturnValue(makePrompt({ closed: 1 }));
    expect(closePrompt(1)).toBeNull();
  });

  test('returns empty winners when no replies', () => {
    stmts.getPromptById.get.mockReturnValue(makePrompt());
    stmts.getPromptReplies.all.mockReturnValue([]);

    const result = closePrompt(1);

    expect(stmts.closePrompt.run).toHaveBeenCalledWith(1);
    expect(result.winners).toEqual([]);
    expect(result.runnersUp).toEqual([]);
  });

  test('awards PROMPT_WINNER_BONUS to the reply with the most votes', () => {
    const prompt  = makePrompt({ room_id: 0 });
    const winner  = makeReply({ id: 1, user_id: 10, votes: 5 });
    const loser   = makeReply({ id: 2, user_id: 20, votes: 2 });

    stmts.getPromptById.get.mockReturnValue(prompt);
    stmts.getPromptReplies.all.mockReturnValue([winner, loser]);

    closePrompt(1);

    expect(stmts.updateRoomCoins.run).toHaveBeenCalledWith(PROMPT_WINNER_BONUS, 0, 10);
  });

  test('awards PROMPT_RUNNER_UP_BONUS to second place when there is exactly one winner', () => {
    const prompt  = makePrompt({ room_id: 0 });
    const winner  = makeReply({ id: 1, user_id: 10, votes: 5 });
    const runnerUp = makeReply({ id: 2, user_id: 20, votes: 2 });
    const other   = makeReply({ id: 3, user_id: 30, votes: 0 });

    stmts.getPromptById.get.mockReturnValue(prompt);
    stmts.getPromptReplies.all.mockReturnValue([winner, runnerUp, other]);

    closePrompt(1);

    expect(stmts.updateRoomCoins.run).toHaveBeenCalledWith(PROMPT_WINNER_BONUS,    0, 10);
    expect(stmts.updateRoomCoins.run).toHaveBeenCalledWith(PROMPT_RUNNER_UP_BONUS, 0, 20);
  });

  test('does NOT award runner-up bonus when multiple replies tie for first', () => {
    const prompt  = makePrompt({ room_id: 0 });
    const tie1    = makeReply({ id: 1, user_id: 10, votes: 4 });
    const tie2    = makeReply({ id: 2, user_id: 20, votes: 4 });

    stmts.getPromptById.get.mockReturnValue(prompt);
    stmts.getPromptReplies.all.mockReturnValue([tie1, tie2]);

    closePrompt(1);

    // Both tied winners receive the winner bonus
    expect(stmts.updateRoomCoins.run).toHaveBeenCalledWith(PROMPT_WINNER_BONUS, 0, 10);
    expect(stmts.updateRoomCoins.run).toHaveBeenCalledWith(PROMPT_WINNER_BONUS, 0, 20);
    // Runner-up bonus must NOT be awarded in a tie
    expect(stmts.updateRoomCoins.run).not.toHaveBeenCalledWith(PROMPT_RUNNER_UP_BONUS, expect.anything(), expect.anything());
  });

  test('does NOT award runner-up when second place has 0 votes', () => {
    const prompt   = makePrompt({ room_id: 0 });
    const winner   = makeReply({ id: 1, user_id: 10, votes: 3 });
    const zeroVotes = makeReply({ id: 2, user_id: 20, votes: 0 });

    stmts.getPromptById.get.mockReturnValue(prompt);
    stmts.getPromptReplies.all.mockReturnValue([winner, zeroVotes]);

    closePrompt(1);

    expect(stmts.updateRoomCoins.run).toHaveBeenCalledWith(PROMPT_WINNER_BONUS, 0, 10);
    expect(stmts.updateRoomCoins.run).not.toHaveBeenCalledWith(PROMPT_RUNNER_UP_BONUS, expect.anything(), expect.anything());
  });
});
