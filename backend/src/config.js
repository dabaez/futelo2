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
  TIER3_PENALTY: 30,
  /** How long (seconds) a locked letter stays locked after a Tier-3 penalty. */
  LOCK_DURATION_SEC: 5 * 60,        // 5 minutes

  // ── Letter shop (roll) ──────────────────────────────────────────────────────
  /** Base coin cost of a letter roll (before scaling). */
  ROLL_COST: 100,
  /**
   * Extra coins added to the roll cost per total letter level the player owns.
   * cost = ROLL_COST + ROLL_COST_SCALE × sum(inventory values)
   * Makes rolling progressively more expensive as players near the cap.
   */
  ROLL_COST_SCALE: 1,
  /**
   * Lootbox rarity tiers for the letter roll shop.
   * Each tier defines how many letter levels are awarded and its relative
   * selection weight. Weights are relative — they don't need to sum to 100.
   * Average letters per roll ≈ 5.03 (common floor raised from 1 → 3).
   */
  LOOTBOX_TIERS: [
    { name: 'común',      letters: 3,  weight: 40 },
    { name: 'bueno',      letters: 5,  weight: 35 },
    { name: 'raro',       letters: 7,  weight: 18 },
    { name: 'épico',      letters: 11, weight: 6  },
    { name: 'legendario', letters: 16, weight: 1  },
  ],
  /** Maximum unlock level any single letter can reach in a player's inventory. */
  MAX_LETTER_LEVEL: 6,
  /**
   * Coins awarded per letter-slot of a roll when ALL inventory slots are at MAX_LETTER_LEVEL.
   * In that case the roll cost is waived and coins are given instead of letters.
   * e.g. a Raro roll (7 slots) gives 7 × 15 = 105 coins.
   */
  CAP_OVERFLOW_COINS_PER_LETTER: 15,
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
    'Tu familia te ha pedido que dejes de apostar',
    'Se casho el sistema',
    'Fallo critico: intenta de nuevo',
    'Fallo critico: no intentes de nuevo xD',
    'Deja de apostar weon, te hace mal',
    'Error 67: six seven',
    'Tu cuenta fue borrada pero una exactamente igual fue creada un instante despues',
    'Erorr: Es como un error pero con las rs mal puestas',
    'Error: Es como un error pero con las es mal puestas',
    'Aqui tienes 10 mensajes de error comicos que puedes poner en tu aplicacion',
    'Iba a poner un error aqui pero me cayo una flecha en la rodilla',
    'All your bug are belong to us',
    'Que levante la mano, el que no tuvo un error',
    'Y Jesus dijo: "el que nunca haya tenido un error, que lanze la primera piedra"',
    '🚶‍♂️‍➡️⛏️🪨🪨💎 KEEP GAMBLING',
    '⬜️⛏️🚶‍♂️🪨💎 KEEP GAMBLING',
    'Un alien abdujo al TI',
    'Papelucho y los errores del sistema',
    'Mr Beast compro futelo y esta haciendo un upgrade',
    '$1 error vs $1000000 error',
    'El misterio del error de futelo',
    'El pequeño error que si pudo (botar todo el sistema)',
    'Dr Strangebug: Or how I learned to stop caring and love testing in production',
    'Deploy del viernes',
    'Hoy no se arreglan errores, mañana si',
    'Este error esta contemplado en el proximo ciclo de trabajo',
    'Gracias por informarmos de este error! Nuestro equipo de desarrollo va a trabajar en solucionarlo',
    'Para solucionar este error, por favor contrata Futelo VIP',
    'Necesitas Futelo GOLD para ver este contenido',
    'Lo siento usuario, pero la princesa se echo el sistema',
    'Todo este codigo fue hecho por una IA, no se que esperabas',
    'Si estas confundido, tenemos un sistema puesto en pie para que no se puedan apostar demasiadas letras. La probabilidad de que haya un error al apostar es 1/2^k donde k es la cantidad de letras que has apostado',
    'Tenemos a un desarrollador que a penas sabe lo que es una variable trabajando en resolver esto',
    'Nuestro ultimo desarrollador fue despedido y reemplazado por un wrapper de ChatGPT, intenta mas tarde',
    'Por favor, escribe a soporte diciendoles que encontraste el error #504 junto a tu nombre, rut y una foto de tu carnet por ambos lados',
    'Errores cachondos en tu area quieren hacerte cagar el telefono, haz click aqui para saber mas',
    'Este error se echo todo el sistema como un torojano y SIN PASTILLAS',
  ],
  // ── Letter mines / pickaxe ─────────────────────────────────────────────────
  // ── Mining balance ───────────────────────────────────────────────────────
  // cost = PICKAXE_COST + PICKAXE_COST_SCALE × Σ(inventory values)
  // Same scaling formula as the lootbox roll — gets more expensive as a player
  // builds up their letter collection.
  // 150 base + 2×30-level player = 210 coins → 1000 hits → 0.01 chance
  // → ~10 expected letters/pickaxe, average ~100 swings between finds.
  /** Base coin cost of one pickaxe (before inventory scaling). */
  PICKAXE_COST: 150,
  /** Extra coins added to pickaxe cost per total inventory level (mirrors ROLL_COST_SCALE). */
  PICKAXE_COST_SCALE: 1,
  /** Number of swings a single pickaxe purchase provides. */
  PICKAXE_HITS: 1000,
  /** Probability (0–1) that a single swing uncovers a letter. */
  MINE_HIT_CHANCE: 0.01,

  // ── Prompt question pool ────────────────────────────────────────────────────
  /**
   * The pool of questions the auto-scheduler (and pickNextPrompt) draws from.
   * Add, remove, or edit entries freely — no other file needs changing.
   * The last 5 used prompts are skipped to avoid immediate repetition.
   */
  MOVIE_POOL: [
    "Matrix",
    "El Joker",
    "Titanic",
    "Star Wars",
    "Lord of the Rings",
    "Jurassic Park",
    "Avengers",
    "Harry Potter",
  ],
  SERIES_POOL: [
    "Breaking Bad",
    "Los Simpsons",
    "Padre de Familia",
    "Steven Universe",
    "One Piece",
    "Rick y Morty",
  ],
  JUEGOS_POOL: [
    "Super Mario",
    "Sonic",
    "Celeste",
    "Tetris",
    "Minecraft",
    "League of Legends",
  ],
  PROMPT_POOL: [
    "Describe tu dia en un futelo",
    "Que desayunaste hoy?",
    "Como describiras a tu familia en un futelo?",
    "Que harias con un millon de dolares del 2012 ajustados a la inflacion actual?",
    "Solo te queda un dia de vida, que es lo primero que haces?",
    "Cuenta un chiste en un futelo",
    "Que harias si fueras presidente?",
    "Cuales serian tus ultimas palabras?",
    "Cual es la wea mas chilena?",
    "El mejor tip para ser exitoso:",
    "El crossover mas ambicisio de la historia:",
    "La secuela que todos estaban esperando:",
    "Un plot twist que nadie vio venir:",
    "Cual es el trabajo que jamas sera reemplazado por la IA?",
    "Un pajarito me conto...",
    "Sin importar cuantas personas lo digan, yo jamas voy a creer que...",
  ],
};
