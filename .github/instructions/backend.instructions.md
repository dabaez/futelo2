---
applyTo: "backend/**"
---

# Futelo – Backend Architecture

## Config (`backend/src/config.js`)

**The single source of truth for every game constant.** All other backend files
import from here. The `/api/config` endpoint exposes public values to the
frontend and also includes live values (`heat`, `catchProb`) from the black market engine.
It also exposes `EMOJI_DEFS` — a sanitized array of `{ key, emoji, name }` objects derived from `EMOJI_RECIPES` (no recipes or hint text). The frontend uses this as the single source of truth for which emojis exist; nothing is hardcoded on the frontend.

```js
module.exports = {
  STARTING_COINS:       0,
  STARTING_INVENTORY:   JSON.stringify({ a: 1, h: 1, l: 1, o: 1 }),
  FIRST_MESSAGE_LETTERS: 26,
  TIER1_COINS:          10,
  TIER3_PENALTY:        50,
  LOCK_DURATION_SEC:    5 * 60,

  // ── Lootbox shop ──
  ROLL_COST:            50,         // base cost (scales: +ROLL_COST_SCALE per total inventory level)
  ROLL_COST_SCALE:      2,
  LOOTBOX_TIERS: [
    { name: 'común',      letters: 3,  weight: 40 },
    { name: 'bueno',      letters: 5,  weight: 35 },
    { name: 'raro',       letters: 7,  weight: 18 },
    { name: 'épico',      letters: 11, weight: 6  },
    { name: 'legendario', letters: 16, weight: 1  },
  ],
  MAX_LETTER_LEVEL:     6,
  CAP_OVERFLOW_COINS_PER_LETTER: 15,
  SYMBOL_CHARS:         '!?.,:-()@#&*;<>+~$%/^',

  // ── Prompts ──
  PROMPT_DURATION_SEC:  60 * 60,
  PROMPT_WINNER_BONUS:  100,
  PROMPT_RUNNER_UP_BONUS: 30,
  PROMPT_REPLY_BONUS:   10,
  PROMPT_BUY_COST:      50,
  INACTIVITY_SEC:       24 * 60 * 60,

  // ── P2P market ──
  SELL_BASE_PRICE:      15,
  MARKET_MAX_PRICE:     500,
  MARKET_COMMISSION:    0.20,       // 20% burned; seller receives 80%

  // ── Black market heat ──
  BM_HEAT_MAX:          100,
  BM_HEAT_DECAY_PER_MIN: 3,
  BM_HEAT_CATCH_INCREMENT: 25,
  BM_HEAT_CHAT_INCREMENT: 10,
  BM_BASE_CATCH_PROB:   0.05,
  BM_HEAT_CATCH_SCALE:  0.20,
  BM_CATCH_FINE:        100,
  BM_LISTING_EXPIRY_SEC: 24 * 60 * 60,
  BM_CHECK_INTERVAL_SEC: 60,

  // ── Gambling / lottery ──
  LOTTERY_START_COST:         50,
  LOTTERY_DURATION_SEC:       60,
  GAMBLING_COINS_PER_LETTER:  50,
  GAMBLING_WIN_LETTERS:       2,
  GAMBLING_ERRORS:            [ /* 10 Spanish humorous error messages */ ],

  // ── Letter mines ──
  PICKAXE_COST:       150,
  PICKAXE_COST_SCALE: 1,
  PICKAXE_HITS:       1000,
  MINE_HIT_CHANCE:    0.01,

  // ── Emoji Forge ──
  EMOJI_MERGE_DURATION_SEC:  60 * 60,   // 1 hour
  EMOJI_INSTANT_COST_PER_SEC: 0.02,     // ceil(secsLeft * 0.02) coins to skip
  HINT_COST:          20,               // coins for one crypt hint
  EMOJI_RECIPES:      [ /* key, emoji, name, recipes[][], hint */ ],

  PROMPT_POOL: [ /* Spanish questions */ ],
  GAMBLING_ERRORS: [ /* humorous error messages */ ],
};
```

To change any constant, edit this file and restart the backend. The frontend
picks up new values on next page load via `GET /api/config`.

---

## Runtime

- **Node.js 20+**, CommonJS (`require`/`module.exports` throughout).
- **Single process**: Express HTTP server + Socket.io + grammY bot all share the
  same process and the same SQLite connection.
- Entry point: `backend/src/server.js` — `npm run dev` (nodemon) or `npm start`.

---

## Database (`backend/src/db/database.js`)

- **better-sqlite3** – fully synchronous, single-writer SQLite.
- WAL mode + `synchronous = NORMAL`.
- DB file: `../../data/futelo.db` relative to `database.js` (i.e. `futelo/data/futelo.db`).
- **Current schema version: 20** (migrations v1–v20 applied automatically on startup).

### Tables

| Table | Purpose |
|---|---|
| `users` | One row per Telegram user. `inventory_json` is `{"a":3,"b":1,...}`. `pickaxe_hits` integer (migration v7). `allows_write_to_pm` integer 0/1 (migration v10). Special row: `id=0` (`username='sistema'`) for system messages. |
| `rooms` | One row per Telegram group. `id` is Telegram `chat_id` (negative int). `notify_thread_id` + `notify_thread_delete` (migration v11). Room 0 is the legacy global placeholder. |
| `room_member_streaks` | Per-room streak counter (migration v8). Columns: `room_id`, `user_id`, `streak`. |
| `game_state` | Key/value. Holds BM heat state, per-room last-sender keys (`room:ROOM_ID:last_sender`), lottery carry-overs (`room:ROOM_ID:lottery_jackpot`). |
| `messages` | Persisted chat log. Has `room_id`. `user_id=0` rows are system messages (pill UI). |
| `letter_locks` | Active Tier-3 penalties per user. `locked_until` is a Unix timestamp. |
| `prompts` | One row per prompt round. `status`: `active` or `closed`. Has `room_id`. |
| `prompt_replies` | Replies to a prompt. Each row has `user_id`, `text`, `vote_count`. |
| `prompt_votes` | One vote per `(reply_id, voter_id)`. |
| `market_listings` | P2P listings. `status`: `open` / `sold` / `cancelled`. Has `room_id`. |
| `black_market_listings` | Identical schema to `market_listings` but separate table. |
| `lottery_rounds` | One row per gambling round. `status`: `active` / `closed`. Has `room_id`. |
| `lottery_bets` | Multiple bets per user per round. Columns: `round_id`, `user_id`, `letter`. |
| `notifications` | Persistent per-user toast queue. `delivered=0` until drained. Pruned 7 days after delivery. |
| `emoji_merges` | Active and completed forge merges. Columns: `id`, `user_id`, `ingredients_json`, `finish_at`, `status` (`pending`/`done`/`refunded`), `result_emoji`. (migration v14) |
| `unlocked_emojis` | Per-room emoji unlocks. Columns: `user_id`, `room_id`, `emoji_key`. Unique `(user_id, room_id, emoji_key)`. (migration v15, made per-room in v19) |
| `user_stats` | Aggregate counters per `(user_id, room_id)`. Columns: `user_id`, `room_id`, `msgs_sent`, `coins_earned`, `rolls_done`, `mines_done`, `markets_done`, `lotteries_won`, `prompts_answered`, `emojis_forged`. (migration v16, made per-room in v19) |
| `user_achievements` | Earned achievements per room. Columns: `user_id`, `room_id`, `achievement_id`. Unique `(user_id, room_id, achievement_id)`. (migration v17, made per-room in v19) |
| `message_reactions` | Per-message reactions. Columns: `message_id`, `user_id`, `reaction` (`like`/`dislike`). Unique `(message_id, user_id)`. (migration v18) |
| `emoji_hints` | Purchased forge hints, **global per-user** (not per-room). Columns: `id`, `user_id`, `hint_text`, `created_at`. (migration v20) |

### Prepared Statements

All queries are **pre-compiled** on startup in the `stmts` object from `database.js`.

```js
const { db, stmts, upsertUser, requireUser, upsertRoom, requireRoom } = require('../db/database');
```

**Room/streak:**

| Statement | What it does |
|---|---|
| `upsertRoom` (function) | `INSERT OR IGNORE` into `rooms` |
| `getRoomById` | Fetches one room by `id` |
| `getAllRooms` | All rows — used by the per-room scheduler |
| `getRoomStreak` | `SELECT streak FROM room_member_streaks WHERE room_id=? AND user_id=?` |
| `upsertRoomStreak` | Inserts or updates a `room_member_streaks` row |
| `setUserWriteAccess` | `UPDATE users SET allows_write_to_pm = 1 WHERE id = ?` |
| `getRoomMembersWithWriteAccess` | Room members (excl. sender) with `allows_write_to_pm = 1` |

**P2P market:**

| Statement | What it does |
|---|---|
| `insertMarketListing` | New `open` listing (incl. `room_id`) |
| `getMarketListing` | One listing by `id` |
| `getOpenMarketListings` | All `open` listings for a `room_id`, with seller names |
| `getActiveSellerListing` | Open listing for `(sellerId, letter, roomId)` — duplicate detection |
| `resolveMarketListing` | Update `status`, `buyer_id`, `resolved_at` by `id` |
| `getUserMarketListings` | User's **open** listings in a room (no LIMIT; open-only filter) |

**Black market (mirror set, separate table):**

| Statement | What it does |
|---|---|
| `insertBmListing` | Same as `insertMarketListing` but on `black_market_listings` |
| `getBmListing` | One BM listing by `id` |
| `getOpenBmListings` | Open BM listings for a `room_id` with seller names |
| `getAllOpenBmListingsGlobal` | **All** open BM listings regardless of room |
| `resolveBmListing` | Resolves a BM listing (sold / cancelled) |
| `getUserBmListings` | User's **open** BM listings in a room (no LIMIT; open-only filter) |

**Mining:**

| Statement | What it does |
|---|---|
| `addPickaxeHits` | `UPDATE users SET pickaxe_hits = MIN(pickaxe_hits + ?, 9999) WHERE id = ?` |
| `usePickaxeHit` | `UPDATE users SET pickaxe_hits = MAX(0, pickaxe_hits - 1) WHERE id = ?` |

**Notifications:**

| Statement | What it does |
|---|---|
| `insertNotification` | Insert a pending notification |
| `getPendingNotifications` | All undelivered for a user, oldest first |
| `markNotificationDelivered` | Mark one delivered by id |
| `markAllNotificationsDelivered` | Mark all pending for a user delivered |
| `pruneOldNotifications` | Delete delivered notifications older than a Unix timestamp |

**Emoji Forge:**

| Statement | What it does |
|---|---|
| `insertEmojiHint` | `INSERT INTO emoji_hints (user_id, hint_text)` — persists a purchased hint |
| `getEmojiHints` | `SELECT hint_text FROM emoji_hints WHERE user_id = ?` — returns all hints for a user (global, not per-room) |

---

## Game Engine (`backend/src/engine/processMessage.js`)

The **only** place that mutates game state.

```
Letter inventory[L] = maximum number of character L allowed per message.
Letters are NEVER consumed — they are unlock levels.
```

**Coin tiers** (checked in `processMessage(userId, text)`):

| Condition | Tier | Coins |
|---|---|---|
| `last_sender_id !== userId` | 1 | +`TIER1_COINS` (10) |
| Same user, `streak_count + 1 == 2` | 2 | 0 (warning) |
| Same user, `streak_count + 1 >= 3` | 3 | −`TIER3_PENALTY` (50) + lock 1 random letter for `LOCK_DURATION_SEC` |

**No letters are granted by tiers.** Letters only come from:
1. **First-message bonus** — `FIRST_MESSAGE_LETTERS` (26) random letters on a user's very first message. One-time.
2. **Shop roll** — via `shopRoll()`.

Streak is tracked per-room via `room_member_streaks`. Last-sender game_state key: `room:${roomId}:last_sender`.

Exported:
- `processMessage(userId, text, roomId = 0)` — throws user-facing `Error` on failure; returns rich result object on success.
- `shopRoll(userId, roomId)` — weighted-random lootbox. Costs `ROLL_COST` (scaled by total inventory levels). Picks letters from **uncapped** slice only. If ALL letters capped: waives cost, awards `tier.letters × CAP_OVERFLOW_COINS_PER_LETTER`. Returns `{ newLetters, rarity, newCoins, newInventory, rollCost, coinBonus, allCapped }`.
- `letterRequirements(text)` — pure helper, returns `{a:1, p:2, _numbers:1, _symbols:2, ...}`. Digits → `_numbers`; `SYMBOL_CHARS` chars → `_symbols`.

---

## Mining Engine (`backend/src/engine/mining.js`)

- `buyPickaxe(userId)` — deducts scaled cost (`PICKAXE_COST + PICKAXE_COST_SCALE × Σinventory`), adds `PICKAXE_HITS` to `pickaxe_hits`. Returns `{ newCoins, pickaxeHits, pickaxeCost }`.
- `swing(userId, roomId)` — requires `pickaxe_hits > 0`. Decrements counter, rolls `Math.random() < MINE_HIT_CHANCE`. On hit: picks from **uncapped** alphabet. All capped → awards `CAP_OVERFLOW_COINS_PER_LETTER` coins. Returns `{ found, letter, newInventory, hitsLeft, allCapped, coinBonus }`.

All writes in `db.transaction()`. No socket broadcast (solo activity).

---

## P2P Market Engine (`backend/src/engine/market.js`)

**Factory pattern**: `makeMarket(stmts, commission)` — two instances:
- `regularMarket` — 20% commission (`MARKET_COMMISSION`), backed by `market_listings`
- `blackMarket` — 0% commission, backed by `black_market_listings`

| Function | Market | Description |
|---|---|---|
| `listLetter(sellerId, letter, price, roomId)` | regular | Escrows one letter level, creates `open` listing |
| `buyListing(buyerId, listingId)` | regular | Deducts price from buyer; credits `floor(price*(1−commission))` to seller |
| `cancelListing(sellerId, listingId)` | regular | Returns escrowed letter, cancels listing |
| `getOpenListings(roomId)` | regular | Open listings for the room with seller names |
| `getUserListings(userId, roomId)` | regular | User's open listings only (for cancel management) |
| `bmListLetter(sellerId, letter, price, roomId)` | black | Same as `listLetter` on BM table |
| `bmBuyListing(buyerId, listingId)` | black | Same as `buyListing` on BM table |
| `bmCancelListing(sellerId, listingId)` | black | Same as `cancelListing` on BM table |
| `getBmOpenListings(roomId)` | black | Open BM listings with seller names |
| `getBmUserListings(userId, roomId)` | black | User's open BM listings only |

All write operations in `db.transaction()`.

---

## Black Market Engine (`backend/src/engine/blackMarketHeat.js`)

- `getCurrentHeat()` — live heat (decays by `BM_HEAT_DECAY_PER_MIN` per elapsed minute).
- `addHeat(delta)` — increases heat, clamped to `[0, BM_HEAT_MAX]`.
- `catchProbability(heat)` — `BM_BASE_CATCH_PROB + (heat / BM_HEAT_MAX) × BM_HEAT_CATCH_SCALE`.
- `runCatchCheck()` — called every `BM_CHECK_INTERVAL_SEC`. Expires stale listings, runs catch roll per open listing. Returns `{ caught: [{sellerId, listingId, fine, letter}], expired: [...], newHeat }`.

Heat sources: catch events (`+BM_HEAT_CATCH_INCREMENT`), chat mention of "mercado negro" (`+BM_HEAT_CHAT_INCREMENT`). BM heat is **global**, not per-room.

---

## Lottery Engine (`backend/src/engine/lottery.js`)

- `startLottery(userId, roomId)` — deducts `LOTTERY_START_COST`, picks secret letter, creates active round with `closes_at = now + LOTTERY_DURATION_SEC`.
- `placeBet(userId, roundId, letter)` — validates active round + `inventory[letter] >= 1`. For k > 0 prior bets: error prob `1 − 0.5^k` (bet still placed). Deducts 1 inventory level.
- `closeLottery(roundId)` — distributes winnings; stores carry-over in `room:${roomId}:lottery_jackpot` game_state key.
- `getActiveLotteryRound(roomId)` — current active round or `null`.

---

## Prompt Engine (`backend/src/engine/promptEngine.js`)

- `startPrompt(roomId, text)` — opens a new prompt (throws if one already active).
- `getActivePrompt(roomId)` — active prompt row or `null`.
- `getPromptWithReplies(promptId)` — prompt + all replies with vote counts.
- `submitReply(promptId, userId, text)` — adds a reply, grants `PROMPT_REPLY_BONUS` coins.
- `castVote(replyId, voterId)` — one vote per user per prompt.
- `closePrompt(promptId)` — marks closed, distributes `PROMPT_WINNER_BONUS` / `PROMPT_RUNNER_UP_BONUS`.
- `buyPrompt(userId, roomId)` — deducts `PROMPT_BUY_COST`, picks random from `PROMPT_POOL`, calls `startPrompt`.

---

## Emoji Forge Engine (`backend/src/engine/emojiForge.js`)

- `startMerge(userId, ingredients)` — deducts ingredient levels from inventory (one level each), inserts an `emoji_merges` row with `finish_at = now + EMOJI_MERGE_DURATION_SEC`. Throws if user already has an active merge or lacks ingredients.
- `instantComplete(userId)` — pays `EMOJI_INSTANT_COST_PER_SEC × remaining_seconds` coins to finish the active merge immediately.
- `buyHint(userId, mergeId)` — pays `HINT_COST` coins, returns the hint string for the matching recipe (or a generic message if no match).
- `getStatus(userId)` — returns `{ active: mergeRow | null, unlocked: [emoji, …] }`.
- `processFinishedMerges()` — called every minute by scheduler; resolves all `finish_at <= now` pending merges → recipe match → `unlocked_emojis` upsert + coin prize, or full refund on no match.
- `matchRecipe(ingredients)` — pure helper; returns the matching `EMOJI_RECIPES` entry or `null`.
- `inventoryKey(char)` — maps a character to its inventory key (`a`-`z`, digit, or symbol escaped with `s_` prefix).

All writes in `db.transaction()`.

---

## Achievement Engine (`backend/src/engine/achievements.js`)

- `checkAchievements(userId, roomId, event, data)` — evaluates all candidate achievements for the given event, awards any newly-met ones (coins + `user_achievements` insert), and updates `user_stats` counters. All in a single `db.transaction()`. Returns array of awarded achievement objects `{ id, label, coins }`.
- `backfillAchievements(userId, roomId)` — runs every event type against current stats; useful on first login or after stat migration.
- **Events**: `message`, `roll`, `mine_swing`, `market_buy`, `market_sell`, `lottery_win`, `prompt_reply`, `emoji_forged`.
- **Stat counters updated per event**: `msgs_sent`, `rolls_done`, `mines_done`, `markets_done`, `lotteries_won`, `prompts_answered`, `emojis_forged`.
- **Categories**: messages, coins, rolls, mines, market, lottery, prompts, emoji forge. ~50 achievement entries in `ACHIEVEMENTS` map inside the file.
- `checkAchievements` is called from the relevant HTTP handlers in `server.js` after the primary action succeeds.

---

## Bot (`backend/src/bot/bot.js`)

- Skipped when `DEV_MODE=true` and no `BOT_TOKEN` is set.
- `/start` in group: `upsertRoom(chat.id, chat.title)` then replies with Mini App button.
- `/start` in DM: asks user to add bot to a group instead.
- `/setthread` (admin-only): mirrors every app message into the specified Telegram thread (run from inside the target thread; pass `off` to disable). Stores `notify_thread_id`.
- `/setthreaddelete` (admin-only): toggles auto-deletion of user replies in the mirror thread.
- Webhook mode: call `bot.init()` before registering the webhook.
- Exports: `{ bot }` only.

---

## Authentication (`backend/src/bot/auth.js`)

- `validateInitData(initDataRaw, botToken)` — full HMAC-SHA256 check per Telegram spec. Returns `{ user, chatId, chatTitle }`.
- **Dev tokens** (when `DEV_MODE=true`): `dev:USER_ID:username:First Name[:CHAT_ID[:Chat Title]]` — skips HMAC. No `CHAT_ID` → defaults to `-1001` / `'Dev Room'`.
- Used in both HTTP auth middleware and Socket.io middleware.

---

## HTTP API

All endpoints in `server.js`. Auth sent as `x-init-data` header or `body.initData`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/config` | none | Public game constants + live BM heat/catchProb |
| POST | `/api/auth` | initData | Upsert user + room, return `{ user, chatId }` |
| GET | `/api/me` | initData | Current user profile + locks |
| GET | `/api/messages?limit=N&roomId=R` | none | Last N messages in room R (default 50, max 200) |
| POST | `/api/message` | initData | Send a message via the engine |
| POST | `/api/shop/roll` | initData | Lootbox roll |
| POST | `/api/shop/prompt` | initData | Buy and fire a community prompt |
| GET | `/api/prompt/active?roomId=R` | none | Active prompt + replies |
| GET | `/api/market/listings?roomId=R` | none | Open P2P listings |
| GET | `/api/market/my-listings?roomId=R` | initData | Caller's **open** listings only (cancel panel) |
| POST | `/api/market/list` | initData | Create a listing `{ letter, price }` |
| POST | `/api/market/buy/:id` | initData | Buy a listing |
| POST | `/api/market/cancel/:id` | initData | Cancel own listing |
| GET | `/api/bm/listings?roomId=R` | none | Open BM listings |
| GET | `/api/bm/my-listings?roomId=R` | initData | Caller's **open** BM listings only (cancel panel) |
| POST | `/api/bm/list` | initData | Create a BM listing |
| POST | `/api/bm/buy/:id` | initData | Buy a BM listing (no commission) |
| POST | `/api/bm/cancel/:id` | initData | Cancel own BM listing |
| POST | `/api/lottery/start` | initData | Start a lottery round |
| POST | `/api/lottery/bet` | initData | Place a bet `{ roundId, letter }` |
| GET | `/api/lottery/active?roomId=R` | none | Active round + bets |
| POST | `/api/mine/buy` | initData | Buy a pickaxe |
| POST | `/api/mine/swing` | initData | Swing once |
| POST | `/api/notifications/enable` | initData | Set `allows_write_to_pm = 1` |
| POST | `/api/forge/start` | initData | Start a merge `{ ingredients: [char, …] }` |
| POST | `/api/forge/instant` | initData | Instant-complete active merge (pays coins) |
| POST | `/api/forge/hint` | initData | Buy a hint for active merge `{ mergeId }` |
| GET | `/api/forge/status` | initData | Active merge + unlocked emojis |
| GET | `/api/achievements` | initData | All achievements with `earned` flag |

---

## Socket.io

- Auth on `connect` via `socket.handshake.auth.initData`.
- Each user joins `user:USER_ID` (personal events) and `room:CHAT_ID` (group broadcast).
- Pending notifications drained on connect.

**Client → Server:**

| Event | Payload | Effect |
|---|---|---|
| `send_message` | `{ text }` | Engine validates → `new_message` broadcast to room |
| `submit_prompt_reply` | `{ promptId, text }` | Adds reply → `new_prompt_reply` broadcast |
| `vote_reply` | `{ replyId }` | Records vote → `vote_update` broadcast |
| `beg` | — | Calls `broadcastSystemMessage` with JSON `{type:"beg",userId,username,firstName}` so the card is visible to all users, including those offline |

**Server → Client (broadcast to `room:CHAT_ID`):**

| Event | Payload |
|---|---|
| `new_message` | Full message object (incl. system messages with `userId=0`) |
| `new_prompt` | Prompt object |
| `new_prompt_reply` | Reply object |
| `vote_update` | `{ replyId, voteCount }` |
| `prompt_closed` | `{ promptId, winner, runnerUp }` |
| `new_market_listing` | `{ listingId, letter, price, sellerName }` |
| `market_listing_sold` | `{ listingId }` |
| `market_listing_cancelled` | `{ listingId }` |
| `bm_new_listing` | `{ listingId, letter, price, sellerName }` |
| `bm_listing_sold` | `{ listingId }` |
| `bm_listing_cancelled` | `{ listingId }` |
| `bm_heat_update` | `{ heat, catchProb }` |
| `new_lottery` | Round object |
| `lottery_bet_placed` | `{ roundId, userId, username, firstName, letter }` |
| `lottery_closed` | `{ roundId, secretLetter, jackpot, winners, carryOver }` |

**Server → Client (targeted to `user:USER_ID`):**

| Event | Payload |
|---|---|
| `user_update` | `{ newCoins, newInventory, newLetters, lockedLetter, tier, coinDelta, pickaxeHits }` |
| `rejected_message` | `{ reason }` |
| `prompt_error` | `{ reason }` |
| `bm_caught` | `{ letter, fine, listingId }` |
| `bm_listing_expired` | `{ letter, listingId }` |
| `notification` | `{ text, type }` |
| `emoji_complete` | `{ emoji, coins }` — forge finished (recipe match) or `{ refunded: true }` (no match) |
| `achievement_unlocked` | `{ id, label, description, coins }` — fired for each newly earned achievement |

---

## Testing – Backend (Jest + supertest)

- Config: `backend/jest.config.js` (`testEnvironment: 'node'`, `maxWorkers: 1`)
- Run: `cd backend && npm test`
- **291 tests across 10 suites** (all passing)

| File | Tests | What it covers |
|---|---|---|
| `src/__tests__/auth.test.js` | 18 | `validateInitData` HMAC, dev tokens, chatId return values |
| `src/__tests__/engine.test.js` | 34 | `letterRequirements`, all 3 tiers, first-message bonus, `shopRoll`, ñ support |
| `src/__tests__/market.test.js` | 27 | `listLetter`, `buyListing`, `cancelListing`, BM factory isolation |
| `src/__tests__/blackMarket.test.js` | 16 | Heat decay, `addHeat`, `catchProbability`, `runCatchCheck`, expiry |
| `src/__tests__/mining.test.js` | 18 | `buyPickaxe` (scaled cost), `swing`, all-capped coin fallback |
| `src/__tests__/prompt.test.js` | 22 | `buyPrompt`, `submitReply` (incl. username sourced from users table), `castVote`, `closePrompt` |
| `src/__tests__/lottery.test.js` | 14 | `startLottery`, `placeBet`, `closeLottery`, carry-over |
| `src/__tests__/api.test.js` | 68 | All REST endpoints end-to-end with temp SQLite DB; `my-listings` open-only regression; reaction coin correctness; hint persistence |
| `src/__tests__/emojiForge.test.js` | 27 | `inventoryKey`, `matchRecipe`, `startMerge` (7 cases), `instantComplete` (4), `buyHint` (persists to DB), `getStatus` (returns hints array) |
| `src/__tests__/achievements.test.js` | 40 | Already-earned guard, stat counter updates, all 8 event types, transaction integrity |

**Key patterns:**
- `FUTELO_DATA_DIR` env override — temp directory per test run.
- `server.js` guarded with `require.main === module` — safe to import without binding a port.
- `jest.resetAllMocks()` in `beforeEach` (not `clearAllMocks`). Re-set `db.transaction.mockImplementation(fn => () => fn())` in `market.test.js`.
- API tests: set `process.env.BOT_TOKEN = ''` before `jest.resetModules()`.
- User tokens: `ALICE='dev:1001:…'`, `BOB='dev:1002:…'`, `DAVE='dev:1004:…'` (market buyer), `EVE='dev:1005:…'` (market seller), `FRANK='dev:1006:…'` (BM), `GINA/HANK` (mining), `IAN/JANE` (lottery), `KATE/LEON` (prompt). Use fresh users per suite to avoid state conflicts.
- Dev tokens without Chat ID default to `chatId = -1001`. Pass `?roomId=-1001` to GET endpoints when asserting on resources created by authenticated POSTs.
- `prompt.test.js` `mockStmts` must include `getUser: { get: jest.fn() }` — `submitReply` reads `username`/`first_name`/`photo_url` from `users` (not `room_members`).
- `emojiForge.test.js` `mockStmts` must include `insertEmojiHint: { run: jest.fn() }` and `getEmojiHints: { all: jest.fn() }`. Both `getStatus` calls must pass `roomId` as second argument.

---

## ⚠️ Critical: Coin State Lives in `room_members`

Since migration v12, player coins are stored in `room_members.coins`, **not** `users.coins`. The `users.coins` column is legacy and always 0.

- **Reactions endpoint** (`POST /api/reactions`): must use `stmts.updateRoomCoins(delta, roomId, authorId)` and read back `stmts.getRoomMember.get(roomId, authorId).coins` for the `user_update` socket event. Never use `stmts.updateCoins` or `requireUser(id).coins` in reaction handlers — they read the stale `users` table and will zero out the player's coins.
- Same rule applies to any new endpoint that awards or deducts coins outside `processMessage`.
