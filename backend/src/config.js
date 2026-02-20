'use strict';

/**
 * Futelo – Game Configuration
 * ════════════════════════════
 * All tuneable game constants live here.
 * Edit this file to adjust prices, rewards, timings, and limits.
 *
 * The object is also served at GET /api/config so the frontend
 * always reflects the same values without duplication.
 */
module.exports = {
  // ── Starting economy ───────────────────────────────────────────────────────
  /** Coins every new user starts with. */
  STARTING_COINS: 100,

  // ── Anti-spam coin tiers ────────────────────────────────────────────────────
  /** Coins awarded when a different user spoke last (Tier 1). */
  TIER1_COINS: 10,
  /** Number of random letters awarded on a Tier-1 message. */
  TIER1_LETTERS: 2,
  // Tier 2: same user, streak == 2 → 0 coins, 0 letters (warning only)
  /** Coins deducted when the same user sends 3+ consecutive messages (Tier 3). */
  TIER3_PENALTY: 50,
  /** How long (seconds) a locked letter stays locked after a Tier-3 penalty. */
  LOCK_DURATION_SEC: 5 * 60,        // 5 minutes

  // ── Letter shop (roll) ──────────────────────────────────────────────────────
  /** Coin cost of a letter roll in the shop. */
  ROLL_COST: 50,
  /** Number of random letters unlocked per roll. */
  ROLL_COUNT: 3,

  // ── Prompt feature ──────────────────────────────────────────────────────────
  /** How long (seconds) a prompt stays open for replies and votes. */
  PROMPT_DURATION_SEC: 3 * 60,      // 3 minutes
  /** Coins awarded to the reply with the most votes. */
  PROMPT_WINNER_BONUS: 100,
  /** Coins awarded to the second-place reply (different user). */
  PROMPT_RUNNER_UP_BONUS: 30,
  /** Coin cost for a player to manually fire a prompt from the shop. */
  PROMPT_BUY_COST: 200,
  /** Chat silence (seconds) before the auto-scheduler fires a prompt. */
  INACTIVITY_SEC: 24 * 60 * 60,     // 24 hours

  // ── Letter market (sell) ────────────────────────────────────────────────────
  /** Base coins earned when selling one level of a letter. */
  SELL_BASE_PRICE: 15,
  /** Fraction of the base price taken as tax on the normal market (0–1). */
  SELL_COMMISSION_RATE: 0.20,

  // ── Black market heat system ─────────────────────────────────────────────
  /** Coin fine applied when a black-market listing is caught. */
  BLACK_MARKET_FINE: 40,
  /**
   * Base catch probability **per minute** per active listing at zero heat.
   * Formula: prob = min(BASE * (1 + heat * 15), MAX)
   *   heat=0.0 → 4 %   heat=0.3 → 22 %   heat=1.0 → 64 %
   */
  BLACK_MARKET_BASE_PROB: 0.04,
  /** Hard ceiling on the per-minute catch probability. */
  BLACK_MARKET_MAX_PROB: 0.80,
  /** Heat boost applied globally whenever any listing is caught. */
  HEAT_CATCH_INCREMENT: 0.20,
  /** Heat boost applied whenever "mercado negro" is mentioned in chat. */
  HEAT_MENTION_INCREMENT: 0.08,
  /**
   * Fraction heat is multiplied by each minute with no catches (cooling).
   * 0.90 → 10 % decay / min; after ~20 min with no catches heat ≈ 0.
   */
  HEAT_DECAY_RATE: 0.90,
  /** Absolute maximum heat value (clamp). */
  HEAT_MAX: 1.0,
  /** Seconds before an uncollected listing automatically expires (letter returned). */
  BLACK_MARKET_LISTING_SEC: 10 * 60,  // 10 minutes

  // ── Prompt question pool ────────────────────────────────────────────────────
  /**
   * The pool of questions the auto-scheduler (and pickNextPrompt) draws from.
   * Add, remove, or edit entries freely — no other file needs changing.
   * The last 5 used prompts are skipped to avoid immediate repetition.
   */
  PROMPT_POOL: [
    "¿Cuál sería el superpoder más inútil?",
    "Nombra algo que suene ilegal pero no lo sea.",
    "¿Qué harías con una hora extra al día?",
    "Describe tu personalidad usando solo comida.",
    "¿Cuál es la habilidad más inútil que tienes?",
    "¿Qué cosa des-inventarías si pudieras?",
    "¿Cuál es la mejor excusa para llegar tarde al trabajo?",
    "Describe internet a alguien del siglo XIX.",
    "¿Cuál es la palabra más graciosa de cualquier idioma?",
    "¿En qué eres irracionalmente bueno/a?",
    "Si tu mascota pudiera hablar, ¿qué sería lo primero que diría?",
    "¿Qué regla debería existir pero no existe?",
    "Nombra una combinación de comida que suene rara pero esté deliciosa.",
    "¿Qué teoría conspirativa podría ser cierta?",
    "Tu vida es ahora una película. ¿Cómo se titula?",
    "¿Qué hace en secreto absolutamente todo el mundo?",
    "Invéntate un día festivo. ¿Cómo se llama y cómo se celebra?",
    "Si los animales pudieran votar, ¿cuál se presentaría a presidente?",
    "¿Cuál es la comida más sobrevalorada?",
    "Da un consejo terrible para tener un gran día.",
  ],
};
