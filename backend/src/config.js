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
  STARTING_COINS: 0,
  /** Starting letter inventory (JSON string). Contains only the letters for "HOLA". */
  STARTING_INVENTORY: JSON.stringify({ a: 1, h: 1, l: 1, o: 1 }),
  /** Number of random letters granted after a user's first ever message. One-time bonus. */
  FIRST_MESSAGE_LETTERS: 26,

  // ── Anti-spam coin tiers ────────────────────────────────────────────────────
  /** Coins awarded when a different user spoke last (Tier 1). */
  TIER1_COINS: 10,
  // Tier 2: same user, streak == 2 → 0 coins, 0 letters (warning only)
  /** Coins deducted when the same user sends 3+ consecutive messages (Tier 3). */
  TIER3_PENALTY: 50,
  /** How long (seconds) a locked letter stays locked after a Tier-3 penalty. */
  LOCK_DURATION_SEC: 5 * 60,        // 5 minutes

  // ── Letter shop (roll) ──────────────────────────────────────────────────────
  /** Base coin cost of a letter roll (before scaling). */
  ROLL_COST: 50,
  /**
   * Extra coins added to the roll cost per total letter level the player owns.
   * cost = ROLL_COST + ROLL_COST_SCALE × sum(inventory values)
   * Makes rolling progressively more expensive as players near the cap.
   */
  ROLL_COST_SCALE: 2,
  /**
   * Lootbox rarity tiers for the letter roll shop.
   * Each tier defines how many letter levels are awarded and its relative
   * selection weight. Weights are relative — they don't need to sum to 100.
   * Average letters per roll ≈ 2.95 (same as the old fixed ROLL_COUNT: 3).
   */
  LOOTBOX_TIERS: [
    { name: 'común',      letters: 1,  weight: 40 },
    { name: 'bueno',      letters: 3,  weight: 35 },
    { name: 'raro',       letters: 5,  weight: 18 },
    { name: 'épico',      letters: 8,  weight: 6  },
    { name: 'legendario', letters: 12, weight: 1  },
  ],
  /** Maximum unlock level any single letter can reach in a player's inventory. */
  MAX_LETTER_LEVEL: 6,
  /**
   * Characters treated as symbols for the shared _symbols inventory group.
   * Must match the SYMBOL_CHARS constant in RestrictedKeyboard.jsx.
   */
  SYMBOL_CHARS: '!?.,:-()@#&*',

  // ── Prompt feature ──────────────────────────────────────────────────────────
  /** How long (seconds) a prompt stays open for replies and votes. */
  PROMPT_DURATION_SEC: 60 * 60,      // 1 hour
  /** Coins awarded to the reply with the most votes. */
  PROMPT_WINNER_BONUS: 100,
  /** Coins awarded to the second-place reply (different user). */
  PROMPT_RUNNER_UP_BONUS: 30,
  /** Coins awarded to any player just for submitting a reply to a prompt. */
  PROMPT_REPLY_BONUS: 10,
  /** Coin cost for a player to manually fire a prompt from the shop. */
  PROMPT_BUY_COST: 50,
  /** Chat silence (seconds) before the auto-scheduler fires a prompt. */
  INACTIVITY_SEC: 24 * 60 * 60,     // 24 hours

  // ── P2P letter market ───────────────────────────────────────────────────────
  /** Default suggested listing price when a player puts a letter up for sale. */
  SELL_BASE_PRICE: 15,
  /** Maximum price a seller can set for a listing. */
  MARKET_MAX_PRICE: 500,
  /** Fraction of the sale price burned on the regular market (0.20 = 20% commission). Black market = 0. */
  MARKET_COMMISSION: 0.20,

  // ── Black market heat system ────────────────────────────────────────────────
  /** Maximum heat value (0–100 scale). */
  BM_HEAT_MAX: 100,
  /** Heat points lost per real minute (passive decay toward 0). */
  BM_HEAT_DECAY_PER_MIN: 3,
  /** Heat gained when a seller is caught in the black market. */
  BM_HEAT_CATCH_INCREMENT: 25,
  /** Heat gained when someone mentions "mercado negro" in chat. */
  BM_HEAT_CHAT_INCREMENT: 10,
  /** Minimum catch probability per check cycle (at heat = 0). */
  BM_BASE_CATCH_PROB: 0.05,
  /** Extra catch probability added at maximum heat (heat = 100). */
  BM_HEAT_CATCH_SCALE: 0.25,
  /** Coins fined from a seller when they are caught. */
  BM_CATCH_FINE: 50,
  /** How often (seconds) the server rolls the catch check. */
  BM_CHECK_INTERVAL_SEC: 2 * 60,
  /** An open BM listing auto-expires after this many seconds (letter returned, no coins). */
  BM_LISTING_EXPIRY_SEC: 60 * 60,

  // ── Beg system ─────────────────────────────────────────────────────────────
  /** Coins transferred when a player gives to a beggar. */
  BEG_GIFT_AMOUNT: 10,
  /** Minimum seconds between two beg requests from the same user. */
  BEG_COOLDOWN_SEC: 60,
  // ── Letter lottery / gambling ───────────────────────────────────────────────
  /** Coins paid to start a gambling round (added to the jackpot seed). */
  LOTTERY_START_COST: 50,
  /** How long (seconds) a gambling round stays open for guesses. */
  LOTTERY_DURATION_SEC: 5 * 60,   // 5 minutes
  /** Coins created per letter in the loser-pot (winner payout or jackpot carry). */
  GAMBLING_COINS_PER_LETTER: 50,
  /** Inventory levels added to the winning letter for a correct guess. */
  GAMBLING_WIN_LETTERS: 2,
  /**
   * Error messages shown when the anti-gambling protection check fires.
   * One is chosen at random on each escalated bet attempt.
   */
  GAMBLING_ERRORS: [
    'Protección antiapuestas activada.',
    'Un cerdo tropezó y desenchufó el cable.',
    'El sistema de lotería está en mantenimiento.',
    'Tu conexión fue bloqueada por el crupier.',
    'Alguien tiró el café encima del servidor.',
    'Error 403: Suerte denegada.',
    'El reglamento prohíbe esta apuesta adicional.',
    'La señal de TV interrumpió las comunicaciones.',
    'El crupier salió a fumar. Intenta de nuevo.',
    'Apuesta rechazada por exceso de optimismo.',
  ],
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
