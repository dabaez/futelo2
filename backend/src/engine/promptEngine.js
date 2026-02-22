'use strict';

/**
 * Futelo Prompt Engine
 * ────────────────────
 * Manages timed community prompts:
 *   1. A prompt goes live for PROMPT_DURATION_SEC (3 min).
 *   2. Players submit one reply each using the keyboard.
 *   3. Players vote on each other's replies (one vote per reply, no self-votes).
 *   4. When time is up the server auto-closes: highest-voted reply wins coins.
 *
 * Coin rewards
 *   Winner    +100 🪙  (most votes)
 *   Runner-up  +30 🪙  (second most, if different user)
 */

const { db, stmts, requireUser } = require('../db/database');
const {
  PROMPT_DURATION_SEC,
  PROMPT_WINNER_BONUS,
  PROMPT_RUNNER_UP_BONUS,
  PROMPT_REPLY_BONUS,
  PROMPT_BUY_COST,
  PROMPT_POOL,
} = require('../config');

// Local aliases matching the old names used throughout this file
const WINNER_BONUS    = PROMPT_WINNER_BONUS;
const RUNNER_UP_BONUS = PROMPT_RUNNER_UP_BONUS;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick a prompt that hasn't appeared recently (last 5 prompts are avoided).
 */
function pickNextPrompt() {
  const used   = db.prepare('SELECT text FROM prompts ORDER BY id DESC LIMIT 5').all().map((r) => r.text);
  const pool   = PROMPT_POOL.filter((p) => !used.includes(p));
  const source = pool.length > 0 ? pool : PROMPT_POOL;
  return source[Math.floor(Math.random() * source.length)];
}

/**
 * Start a new prompt. Returns { id, text, closesAt }.
 * Caller is responsible for emitting the socket event.
 */
function startPrompt() {
  const text     = pickNextPrompt();
  const closesAt = Math.floor(Date.now() / 1000) + PROMPT_DURATION_SEC;
  const result   = stmts.insertPrompt.run(text, closesAt);
  return { id: result.lastInsertRowid, text, closesAt };
}

/**
 * Buy and immediately fire a new prompt.
 * Costs PROMPT_BUY_COST coins. Fails if a prompt is already active.
 */
function buyPrompt(userId) {
  requireUser(userId);

  if (getActivePrompt()) {
    throw new Error('Ya hay un prompt activo. Espera a que termine.');
  }

  return db.transaction(() => {
    const user = requireUser(userId);
    if (user.coins < PROMPT_BUY_COST) {
      throw new Error(`Monedas insuficientes. Necesitas ${PROMPT_BUY_COST} 🪙, tienes ${user.coins}.`);
    }
    stmts.updateCoins.run(-PROMPT_BUY_COST, userId);
    const np = startPrompt();
    return {
      newCoins: user.coins - PROMPT_BUY_COST,
      prompt:   np,
    };
  })();
}

/**
 * Returns the single active (non-closed) prompt, or null.
 */
function getActivePrompt() {
  return stmts.getActivePrompt.get() || null;
}

/**
 * Returns the prompt + all replies with vote counts for the given promptId.
 * Used for the REST /api/prompt/active response.
 */
function getPromptWithReplies(promptId) {
  const prompt  = stmts.getPromptById.get(promptId);
  if (!prompt) return null;
  const replies = stmts.getPromptReplies.all(promptId);
  return {
    id:          prompt.id,
    text:        prompt.text,
    closesAt:    prompt.closes_at,
    closed:      Boolean(prompt.closed),
    secondsLeft: Math.max(0, prompt.closes_at - Math.floor(Date.now() / 1000)),
    replies:     replies.map(replyToPayload),
  };
}

/**
 * Submit a reply to an open prompt.
 * Throws a user-facing Error on any validation failure.
 */
function submitReply(userId, promptId, text) {
  const prompt = stmts.getPromptById.get(promptId);
  if (!prompt)       throw new Error('Prompt no encontrado.');
  if (prompt.closed) throw new Error('Este prompt ya está cerrado.');
  if (Math.floor(Date.now() / 1000) > prompt.closes_at)
    throw new Error('Se acabó el tiempo de este prompt.');

  const trimmed = text.trim();
  if (!trimmed)          throw new Error('La respuesta no puede estar vacía.');
  if (trimmed.length > 200) throw new Error('Respuesta demasiado larga (máx. 200 caracteres).');

  const result = stmts.insertPromptReply.run(promptId, userId, trimmed);
  if (result.changes === 0) throw new Error('Ya respondiste a este prompt.');

  stmts.updateCoins.run(PROMPT_REPLY_BONUS, userId);
  const fresh = requireUser(userId);

  const reply = stmts.getPromptReplyById.get(result.lastInsertRowid);
  const user  = fresh;
  return {
    id:        reply.id,
    promptId,
    userId,
    text:      trimmed,
    votes:     0,
    username:  user.username,
    firstName: user.first_name,
    photoUrl:  user.photo_url,
    createdAt: reply.created_at,
    replyBonus: PROMPT_REPLY_BONUS,
    newCoins:   fresh.coins,
  };
}

/**
 * Cast a vote for a reply.
 * Throws if the voter already voted, is voting their own reply, etc.
 */
function castVote(voterId, replyId) {
  const reply = stmts.getPromptReplyById.get(replyId);
  if (!reply) throw new Error('Respuesta no encontrada.');
  if (reply.user_id === voterId) throw new Error('No puedes votar tu propia respuesta.');

  const prompt = stmts.getPromptById.get(reply.prompt_id);
  if (!prompt || prompt.closed) throw new Error('La votación de este prompt está cerrada.');
  if (Math.floor(Date.now() / 1000) > prompt.closes_at)
    throw new Error('El tiempo de votación ha terminado.');

  const result = stmts.insertVote.run(replyId, voterId);
  if (result.changes === 0) throw new Error('Ya votaste a esta respuesta.');

  const { votes } = stmts.getVoteCount.get(replyId);
  return { replyId, votes };
}

/**
 * Close a prompt, tally results, and award coins.
 * Returns the result payload for broadcasting, or null if already closed.
 */
function closePrompt(promptId) {
  const prompt = stmts.getPromptById.get(promptId);
  if (!prompt || prompt.closed) return null;

  const replies = stmts.getPromptReplies.all(promptId);

  const result = db.transaction(() => {
    stmts.closePrompt.run(promptId);

    if (replies.length === 0) {
      return { promptId, promptText: prompt.text, winners: [], runnersUp: [], replies: [] };
    }

    // Collect all replies that tie for 1st place (votes > 0)
    const topVotes = replies[0].votes;
    const winners  = topVotes > 0 ? replies.filter((r) => r.votes === topVotes) : [];
    winners.forEach((r) => stmts.updateCoins.run(WINNER_BONUS, r.user_id));

    // Only award runners-up when there is exactly one winner
    let runnersUp = [];
    if (winners.length === 1) {
      const remaining  = replies.filter((r) => r.votes < topVotes);
      if (remaining.length > 0) {
        const secondVotes = remaining[0].votes;
        if (secondVotes > 0) {
          runnersUp = remaining.filter((r) => r.votes === secondVotes);
          runnersUp.forEach((r) => stmts.updateCoins.run(RUNNER_UP_BONUS, r.user_id));
        }
      }
    }

    return {
      promptId,
      promptText: prompt.text,
      winners:   winners.map((r)   => ({ ...replyToPayload(r), bonus: WINNER_BONUS })),
      runnersUp: runnersUp.map((r) => ({ ...replyToPayload(r), bonus: RUNNER_UP_BONUS })),
      replies:   replies.map(replyToPayload),
    };
  })();

  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function replyToPayload(r) {
  return {
    id:        r.id,
    promptId:  r.prompt_id,
    userId:    r.user_id,
    text:      r.text,
    votes:     r.votes || 0,
    username:  r.username,
    firstName: r.first_name,
    photoUrl:  r.photo_url,
    createdAt: r.created_at,
  };
}

module.exports = {
  startPrompt,
  getActivePrompt,
  getPromptWithReplies,
  submitReply,
  castVote,
  closePrompt,
  buyPrompt,
  PROMPT_DURATION_SEC,
  WINNER_BONUS,
  RUNNER_UP_BONUS,
  PROMPT_BUY_COST,
};
