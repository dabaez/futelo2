# Futelo – Agent Context

This file gives AI coding agents the background needed to work on this codebase
without re-reading every file from scratch. Read it before making changes.

---

## What Futelo Is

A **Telegram Mini App (TMA)** chat game. Players type messages using a custom
on-screen keyboard. Every character in a message consumes from the player's
letter inventory. An **Anti-Spam coin economy** rewards or penalises players
based on who last spoke.

**UI language: Spanish.** All user-facing strings (toasts, labels, error
messages, prompt questions) are in Spanish. The prompt question pool lives in
`config.js` (`PROMPT_POOL`); error messages are inline in the engine files;
UI copy is in the React components.

---

## Repository Layout

```
futelo/
├── agents.md          ← you are here
├── README.md          ← user-facing docs and quick-start
├── deploy.sh          ← production one-shot deploy script
├── .gitignore
│
├── backend/           ← Node.js server (CommonJS, "type": "commonjs")
│   ├── src/
│   │   ├── config.js              ← SINGLE SOURCE OF TRUTH for all game constants
│   │   ├── server.js              Express + Socket.io entry point
│   │   ├── db/
│   │   │   └── database.js        SQLite schema, WAL config, prepared stmts
│   │   ├── engine/
│   │   │   ├── processMessage.js  Game engine + shopRoll() (lootbox)
│   │   │   ├── market.js          P2P marketplace engine (factory pattern; powers BOTH markets)
│   │   │   ├── promptEngine.js    Community prompt lifecycle
│   │   │   ├── lottery.js         Letter-gambling round engine
│   │   │   ├── blackMarket.js     Black market heat / catch mechanic
│   │   │   └── mining.js          Pickaxe / letter-mine engine
│   │   └── bot/
│   │       ├── bot.js             grammY bot (gatekeeper + mirror)
│   │       └── auth.js            Telegram initData HMAC validator
│   ├── .env.example
│   └── package.json
│
├── frontend/          ← React + Vite + Tailwind (ESM, "type": "module")
│   ├── src/
│   │   ├── main.jsx               ReactDOM entry, expands Telegram WebApp
│   │   ├── App.jsx                Root component, wires all state together
│   │   ├── index.css              Tailwind directives + global resets
│   │   ├── components/
│   │   │   ├── Header.jsx         Coin balance, connection dot, Shop button
│   │   │   ├── ChatFeed.jsx       Scrollable feed (REST hydrate + Socket.io)
│   │   │   ├── MessageBubble.jsx  Single chat bubble (own/other + tier badge + system pill)
│   │   │   ├── PromptBanner.jsx   Collapsible prompt panel (timer, replies, votes)
│   │   │   ├── RestrictedKeyboard.jsx  Custom 4-row keyboard with inventory limits
│   │   │   ├── ShopModal.jsx      Lootbox roll + P2P market + prompt + mines (5 tabs)
│   │   │   ├── BlackMarketModal.jsx  Secret P2P market (dark-themed, triple-tap access)
│   │   │   ├── LotteryModal.jsx   Letter-gambling round modal
│   │   │   └── DevUserPicker.jsx  Dev-only user picker (no Telegram needed)
│   │   ├── hooks/
│   │   │   ├── useAuth.js         POST /api/auth on mount, exposes updateUser()
│   │   │   └── useSocket.js       Socket.io connection manager
│   │   ├── __tests__/
│   │   │   ├── RestrictedKeyboard.test.jsx  20 tests (Vitest + RTL)
│   │   │   └── MessageBubble.test.jsx       15 tests (Vitest + RTL)
│   │   └── test/
│   │       └── setup.js           @testing-library/jest-dom import
│   ├── index.html
│   ├── vite.config.js             Proxies /api and /socket.io → :3001 in dev; test config
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── .env.example
│   └── package.json
│
├── nginx/
│   └── futelo.conf    Nginx reverse-proxy, SSL, rate-limits, SPA fallback
│
└── data/              Auto-created at runtime; contains futelo.db (gitignored)
```

---

## Backend Architecture

### Config (`backend/src/config.js`)

**The single source of truth for every game constant.** All other backend files
import from here. The `/api/config` endpoint exposes public values to the
frontend. The response also includes live values (`heat`, `catchProb`) from the
black market engine.

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
    { name: 'común',      letters: 1,  weight: 40 },
    { name: 'bueno',      letters: 3,  weight: 35 },
    { name: 'raro',       letters: 5,  weight: 18 },
    { name: 'épico',      letters: 8,  weight: 6  },
    { name: 'legendario', letters: 12, weight: 1  },
  ],
  MAX_LETTER_LEVEL:     6,
  SYMBOL_CHARS:         '!?.,:-()@#&*',

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
  PICKAXE_COST:     30,   // coins to buy one pickaxe
  PICKAXE_HITS:     10,   // swings granted per purchase
  MINE_HIT_CHANCE:  0.4,  // probability a single swing finds a letter

  PROMPT_POOL: [ /* 20 Spanish questions */ ],
};
```

To change any constant, edit this file and restart the backend. The frontend
picks up the new values on next page load via `GET /api/config`.

### Runtime

- **Node.js 20+**, CommonJS (`require`/`module.exports` throughout).
- **Single process**: Express HTTP server + Socket.io + grammY bot all share the
  same process and the same SQLite connection.
- Entry point: `backend/src/server.js` — `npm run dev` (nodemon) or
  `npm start` (plain node).

### Database (`backend/src/db/database.js`)

- **better-sqlite3** – fully synchronous, single-writer SQLite.
- WAL mode + `synchronous = NORMAL` — safe and fast on the 1 GB droplet.
- DB file lives at `../../data/futelo.db` relative to `database.js`
  (i.e. `futelo/data/futelo.db`). The `data/` directory is created on first run.
- **Current schema version: 8** (migrations v1–v8 applied automatically on startup).

#### Tables

| Table | Purpose |
|---|---|
| `users` | One row per Telegram user. `inventory_json` is a JSON string `{"a":3,"b":1,...}`. `pickaxe_hits` integer counter (migration v7). Special row: `id=0` (`username='sistema'`) for system messages. |
| `rooms` | One row per Telegram group that has ever started the bot (migration v8). Columns: `id` (Telegram `chat_id`, negative int), `title`, `created_at`. Room 0 is the legacy global placeholder. |
| `room_member_streaks` | Per-room streak counter (migration v8). Columns: `room_id`, `user_id`, `streak`. Replaces the old single-value `last_sender_id` in `game_state`. |
| `game_state` | Key/value. Holds BM heat state and per-room last-sender keys (`room:ROOM_ID:last_sender`) and lottery jackpot carry-overs (`room:ROOM_ID:lottery_jackpot`). |
| `messages` | Persisted chat log used to hydrate the feed on load. Has `room_id` column. `user_id=0` rows are system messages (pill UI). |
| `letter_locks` | Active Tier-3 penalties per user. `locked_until` is a Unix timestamp. |
| `prompts` | One row per prompt round. `status`: `active` or `closed`. Has `room_id` column. |
| `prompt_replies` | Replies to a prompt. Each row has `user_id`, `text`, `vote_count`. |
| `prompt_votes` | One vote per `(reply_id, voter_id)` pair — enforces one-vote-per-user. |
| `market_listings` | One row per P2P listing. `status`: `open` / `sold` / `cancelled`. Columns: `seller_id`, `letter`, `price`, `buyer_id`, `listed_at`, `resolved_at`, `room_id`. |
| `black_market_listings` | Identical schema to `market_listings` (incl. `room_id`) but completely separate table. Used by the secret black market. |
| `lottery_rounds` | One row per gambling round. `status`: `active` / `closed`. Has `room_id` column. Holds `secret_letter`, `jackpot`, `started_by`, `closes_at`. |
| `lottery_bets` | Multiple bets per user per round (no uniqueness constraint). Columns: `round_id`, `user_id`, `letter`. |
| `notifications` | Persistent per-user toast queue. `delivered=0` until the user connects and drains them. Pruned 7 days after delivery. |

#### Prepared Statements

All queries are **pre-compiled** on startup in the `stmts` object exported from
`database.js`. Always use these rather than calling `db.prepare()` inline — it
keeps query compilation cost to zero per request and avoids re-parsing.

```js
const { db, stmts, upsertUser, requireUser, upsertRoom, requireRoom } = require('../db/database');
```

New room/streak prepared statements:

| Statement | What it does |
|---|---|
| `upsertRoom` (function) | `INSERT OR IGNORE` into `rooms`; exported as a helper, not a stmt. |
| `getRoomById` | Fetches one room by `id`. |
| `getAllRooms` | Returns all rows from `rooms` — used by the per-room scheduler. |
| `getRoomStreak` | `SELECT streak FROM room_member_streaks WHERE room_id=? AND user_id=?` |
| `upsertRoomStreak` | Inserts or updates a `room_member_streaks` row. |

P2P market prepared statements (also in `stmts`):

| Statement | What it does |
|---|---|
| `insertMarketListing` | Inserts a new `open` listing (incl. `room_id`), returns `lastInsertRowid`. |
| `getMarketListing` | Fetches one listing by `id`. |
| `getOpenMarketListings` | Returns all `open` listings for a given `room_id`, joined with seller username/first_name. |
| `getActiveSellerListing` | Finds an open listing for a `(sellerId, letter, roomId)` triple — used to detect duplicates. |
| `resolveMarketListing` | Updates `status`, `buyer_id`, and `resolved_at` by `id`. |
| `getUserMarketListings` | Returns a user's 20 most recent listings for a given `room_id` (any status). |

Black market prepared statements (mirror set, separate table):

| Statement | What it does |
|---|---|
| `insertBmListing` | Same as `insertMarketListing` but writes to `black_market_listings`. |
| `getBmListing` | Fetches one BM listing by `id`. |
| `getOpenBmListings` | Returns open BM listings for a given `room_id` with seller names. |
| `getAllOpenBmListingsGlobal` | Returns **all** open BM listings regardless of room — used by the global catch check. |
| `resolveBmListing` | Resolves a BM listing (sold / cancelled). |
| `getUserBmListings` | Returns a user's 20 most recent BM listings for a given `room_id`. |

Mining prepared statements (in `stmts`):

| Statement | What it does |
|---|---|
| `addPickaxeHits` | `UPDATE users SET pickaxe_hits = MIN(pickaxe_hits + ?, 9999) WHERE id = ?` |
| `usePickaxeHit` | `UPDATE users SET pickaxe_hits = MAX(0, pickaxe_hits - 1) WHERE id = ?` |

Notification statements (in `stmts`):

| Statement | What it does |
|---|---|
| `insertNotification` | Insert a pending notification for a user. |
| `getPendingNotifications` | All undelivered notifications for a user, oldest first. |
| `markNotificationDelivered` | Mark one notification as delivered by id. |
| `markAllNotificationsDelivered` | Mark all pending notifications for a user as delivered. |
| `pruneOldNotifications` | Delete delivered notifications older than a given Unix timestamp. |

### Game Engine (`backend/src/engine/processMessage.js`)

The **only** place that mutates game state. Rules:

```
Letter inventory[L] = maximum number of character L allowed per message.
Letters are NEVER consumed — they are unlock levels.
```

**Coin tiers** (checked in `processMessage(userId, text)`):

| Condition | Tier | Coins |
|---|---|---|
| `last_sender_id !== userId` | 1 | +`TIER1_COINS` (10) |
| Same user, `streak_count + 1 == 2` | 2 | 0 (warning) |
| Same user, `streak_count + 1 >= 3` | 3 | −`TIER3_PENALTY` (50) + lock 1 random letter for `LOCK_DURATION_SEC` (5 min) |

**No letters are granted by tiers.** Letters are only obtained two ways:
1. **First-message bonus** — on a user's very first message (message count = 0 before insert), `FIRST_MESSAGE_LETTERS` (26) random letters are added to their inventory. One-time per user.
2. **Shop roll** — spending coins via `shopRoll()`.

**The critical invariant** for `processMessage`: streak is now tracked per-room via the `room_member_streaks` table (not a global `last_sender_id`). The last-sender game_state key is `room:${roomId}:last_sender`.

Exported:
- `processMessage(userId, text, roomId = 0)` — throws a user-facing `Error` on validation
  failure; returns a rich result object on success.
- `shopRoll(userId)` — weighted-random lootbox roll. Costs `ROLL_COST` coins (scaled
  by total inventory levels). Picks a tier from `LOOTBOX_TIERS` using `rollRarity()`.
  Returns `{ newLetters, rarity, newCoins, newInventory, rollCost }`.
- `letterRequirements(text)` — pure helper, returns `{a:1, p:2, _numbers:1, _symbols:2, ...}`.
  Digits (0-9) are summed into `_numbers`; characters in `SYMBOL_CHARS` are summed into `_symbols`.

### Mining Engine (`backend/src/engine/mining.js`)

Manages the pickaxe / letter-mine mini-game. All constants come from `config.js`.

- `buyPickaxe(userId)` — deducts `PICKAXE_COST` coins, adds `PICKAXE_HITS` to the user's
  `pickaxe_hits` counter. Multiple purchases stack. Returns `{ newCoins, pickaxeHits }`.
- `swing(userId)` — requires `pickaxe_hits > 0`. Decrements the counter by 1, then rolls
  `Math.random() < MINE_HIT_CHANCE` for a find. On a hit, picks a random letter from
  `'abcdefghijklmnopqrstuvwxyzñ'` and grants +1 inventory level (capped at `MAX_LETTER_LEVEL`).
  Returns `{ found, letter, newInventory, hitsLeft }` — `letter` and `newInventory` are `null`
  on a miss.

Both functions throw a user-facing `Error` on validation failure. All DB writes are wrapped
in `db.transaction()`. Mining is a solo activity — no socket broadcast to other clients.

### P2P Market Engine (`backend/src/engine/market.js`)

Manages both the regular player-to-player market and the secret **black market**.
All constants come from `config.js`.

**Factory pattern**: `makeMarket(stmts, commission)` produces all five functions bound
to a specific set of prepared statements and a commission rate. The two instances are:
- `regularMarket` — 20% commission (`MARKET_COMMISSION`), backed by `market_listings`
- `blackMarket` — 0% commission, backed by `black_market_listings`

Exported functions:

| Function | Market | Description |
|---|---|---|
| `listLetter(sellerId, letter, price, roomId = 0)` | regular | Escrows one letter level, creates an `open` listing for the given room. |
| `buyListing(buyerId, listingId)` | regular | Deducts price from buyer; credits `floor(price*(1−commission))` to seller; grants letter. |
| `cancelListing(sellerId, listingId)` | regular | Returns escrowed letter, cancels listing. |
| `getOpenListings(roomId = 0)` | regular | Open listings for the room with seller names. |
| `getUserListings(userId, roomId = 0)` | regular | User's 20 most recent listings in the room (any status). |
| `bmListLetter(sellerId, letter, price, roomId = 0)` | black | Same as `listLetter` on the BM table. |
| `bmBuyListing(buyerId, listingId)` | black | Same as `buyListing` on the BM table. |
| `bmCancelListing(sellerId, listingId)` | black | Same as `cancelListing` on the BM table. |
| `getBmOpenListings(roomId = 0)` | black | Open BM listings for the room with seller names. |
| `getBmUserListings(userId, roomId = 0)` | black | User's 20 most recent BM listings in the room. |

All buy/list/cancel functions throw a user-facing `Error` on validation failure.
All write operations are wrapped in `db.transaction()` for atomicity.

### Black Market Engine (`backend/src/engine/blackMarket.js`)

Manages the heat/catch mechanic for the secret black market.

- `getCurrentHeat()` — live heat value (decays passively over time based on elapsed minutes).
- `addHeat(delta)` — increases heat, clamped to `[0, BM_HEAT_MAX]`.
- `catchProbability(heat)` — `BM_BASE_CATCH_PROB + (heat / BM_HEAT_MAX) × BM_HEAT_CATCH_SCALE`.
- `runCatchCheck()` — called by the server interval every `BM_CHECK_INTERVAL_SEC`. Expires
  stale listings and runs a catch roll per open listing. Returns
  `{ caught: [{sellerId, listingId, fine, letter}], expired: [...], newHeat }`.

Heat sources: catch events (`+BM_HEAT_CATCH_INCREMENT`), chat mention of
"mercado negro" (`+BM_HEAT_CHAT_INCREMENT`).

### Lottery Engine (`backend/src/engine/lottery.js`)

Manages the letter-gambling mini-game rounds.

- `startLottery(userId, roomId)` — deducts `LOTTERY_START_COST` coins, picks a secret letter,
  creates a `lottery_rounds` row (`room_id = roomId`) with `closes_at = now + LOTTERY_DURATION_SEC`, returns the round.
- `placeBet(userId, roundId, letter)`:
  - Validates round is active and user has `inventory[letter] >= 1`.
  - Counts existing bets `k` from this user in this round.
  - For k > 0: error probability `1 − 0.5^k` — random message from `GAMBLING_ERRORS`
    (bet is still placed).
  - Deducts 1 level from inventory, inserts to `lottery_bets`.
- `closeLottery(roundId)` — reads `room_id` from the round row; distributes winnings; returns `{ roundId, secretLetter, jackpot, winners, carryOver }`.
  Carry-over jackpot is stored in game_state key `room:${roomId}:lottery_jackpot`.
- `getActiveLotteryRound(roomId)` — returns current active round for the room or `null`.

### Prompt Engine (`backend/src/engine/promptEngine.js`)

Manages the community prompt lifecycle. All durations and coin rewards come
from `config.js`.

Exported:
- `startPrompt(roomId, text)` — opens a new prompt for the room (throws if one is already active).
- `getActivePrompt(roomId)` — returns the current active prompt row for the room or `null`.
- `getPromptWithReplies(promptId)` — returns prompt + all replies with vote counts.
- `submitReply(promptId, userId, text)` — adds a reply row, grants `PROMPT_REPLY_BONUS` coins to author.
- `castVote(replyId, voterId)` — records a vote (one per user per prompt).
- `closePrompt(promptId)` — marks prompt closed, distributes coin rewards
  (`PROMPT_WINNER_BONUS`, `PROMPT_RUNNER_UP_BONUS`), returns winner info.
- `buyPrompt(userId, roomId)` — deducts `PROMPT_BUY_COST` from user's coins,
  then picks a random prompt from `PROMPT_POOL` and calls `startPrompt(roomId, text)`.
- `PROMPT_DURATION_SEC`, `WINNER_BONUS`, `RUNNER_UP_BONUS`, `PROMPT_BUY_COST`
  re-exported for use in `server.js`.

### Bot (`backend/src/bot/bot.js`)

- Imported lazily in `server.js`; skipped entirely when `DEV_MODE=true` and
  no `BOT_TOKEN` is set.
- `/start` in a **group**: calls `upsertRoom(chat.id, chat.title)` then replies with Mini App button. Each group that uses `/start` automatically gets its own room.
- `/start` in a **DM**: replies asking the user to add the bot to a group instead.
- `on('message')` in any group: deletes every message from non-bot users (gatekeeper for all groups the bot is a member of).
- No `broadcastToGroup` / Telegram mirroring. The bot only deletes messages; the chat lives entirely in the Mini App.
- Exports: `{ bot }` only.

### Authentication (`backend/src/bot/auth.js`)

- `validateInitData(initDataRaw, botToken)` — returns `{ user, chatId, chatTitle }` after full HMAC-SHA256 check per Telegram spec. `chatId` is parsed from the `chat` field in initData.
- When `DEV_MODE=true`, also accepts tokens of the form
  `dev:USER_ID:username:First Name[:CHAT_ID[:Chat Title]]` and skips the HMAC.
  `CHAT_ID` is detected by integer parsing; if absent, defaults to `-1001` / `'Dev Room'`.
- `validateInitDataDev(token)` — parses dev tokens directly, same return shape.
- Used in **both** the HTTP auth middleware and the Socket.io middleware.

### HTTP API

All endpoints are defined in `server.js`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/config` | none | Public game constants + live BM heat/catchProb |
| POST | `/api/auth` | initData header | Upsert user + room, return `{ user, chatId }` |
| GET | `/api/me` | initData header | Current user profile + locks |
| GET | `/api/messages?limit=N&roomId=R` | none | Last N messages in room R (default 50, max 200) |
| POST | `/api/message` | initData header | Send a message via the engine (roomId from auth token) |
| POST | `/api/shop/roll` | initData header | Open a lootbox — returns `{ newLetters, rarity, newCoins, newInventory, rollCost }` |
| POST | `/api/shop/prompt` | initData header | Buy and fire a community prompt (roomId from auth token) |
| GET | `/api/prompt/active?roomId=R` | none | Active prompt + replies for room R (or `{ prompt: null }`) |
| GET | `/api/market/listings?roomId=R` | none | Open P2P listings for room R (with seller names) |
| GET | `/api/market/my-listings?roomId=R` | initData header | Caller's 20 most recent listings in room R (any status) |
| POST | `/api/market/list` | initData header | Create a listing (body: `{ letter, price }`; roomId from auth token) |
| POST | `/api/market/buy/:id` | initData header | Buy a listing — buyer pays full price, seller receives 80% |
| POST | `/api/market/cancel/:id` | initData header | Cancel own open listing, recover escrowed letter |
| GET | `/api/bm/listings?roomId=R` | none | Open **black market** listings for room R (with seller names) |
| GET | `/api/bm/my-listings?roomId=R` | initData header | Caller's 20 most recent BM listings in room R |
| POST | `/api/bm/list` | initData header | Create a BM listing (body: `{ letter, price }`; roomId from auth token) |
| POST | `/api/bm/buy/:id` | initData header | Buy a BM listing — no commission |
| POST | `/api/bm/cancel/:id` | initData header | Cancel own open BM listing, recover letter |
| POST | `/api/lottery/start` | initData header | Start a lottery round (costs `LOTTERY_START_COST` coins; roomId from auth token) |
| POST | `/api/lottery/bet` | initData header | Place a bet `{ roundId, letter }` |
| GET | `/api/lottery/active?roomId=R` | none | Active round + bets for room R (or `{ round: null }`) |
| POST | `/api/mine/buy` | initData header | Buy a pickaxe — deduct `PICKAXE_COST`, add `PICKAXE_HITS` swings |
| POST | `/api/mine/swing` | initData header | Swing once — 40% chance to find a random letter |

Auth is sent as the `x-init-data` HTTP header **or** `body.initData`.

### Socket.io

- Clients authenticate on `connect` via `socket.handshake.auth.initData`.
- On connect each user joins two rooms: `user:USER_ID` (personal events) and `room:CHAT_ID` (group broadcast). `CHAT_ID` comes from the auth token.
- On connect: pending notifications are drained and emitted immediately.

**Client → Server:**

| Event | Payload | Effect |
|---|---|---|
| `send_message` | `{ text }` | Engine validates → `new_message` broadcast to `room:CHAT_ID` |
| `submit_prompt_reply` | `{ promptId, text }` | Adds a reply → `new_prompt_reply` broadcast to `room:CHAT_ID` |
| `vote_reply` | `{ replyId }` | Records vote → `vote_update` broadcast to `room:CHAT_ID` |
| `beg` | — | Broadcasts `new_beg` to `room:CHAT_ID` if user is broke |

**Server → Client (broadcast to `room:CHAT_ID`):**

| Event | Payload |
|---|---|
| `new_message` | Full message object (incl. system messages with `userId=0`) |
| `new_prompt` | Prompt object (new round started) |
| `new_prompt_reply` | Reply object added to active prompt |
| `vote_update` | `{ replyId, voteCount }` |
| `prompt_closed` | `{ promptId, winner, runnerUp }` |
| `new_market_listing` | `{ listingId, letter, price, sellerName }` |
| `market_listing_sold` | `{ listingId }` |
| `market_listing_cancelled` | `{ listingId }` |
| `bm_new_listing` | `{ listingId, letter, price, sellerName }` |
| `bm_listing_sold` | `{ listingId }` |
| `bm_listing_cancelled` | `{ listingId }` |
| `bm_heat_update` | `{ heat, catchProb }` |
| `new_lottery` | Round object (new lottery round started) |
| `lottery_bet_placed` | `{ roundId, userId, username, firstName, letter }` |
| `lottery_closed` | `{ roundId, secretLetter, jackpot, winners, carryOver }` |
| `new_beg` | `{ userId, username, firstName }` |

**Server → Client (targeted to `user:USER_ID`):**

| Event | Payload |
|---|---|
| `user_update` | `{ newCoins, newInventory, newLetters, lockedLetter, tier, coinDelta, pickaxeHits }` |
| `rejected_message` | `{ reason }` |
| `prompt_error` | `{ reason }` |
| `bm_caught` | `{ letter, fine, listingId }` |
| `bm_listing_expired` | `{ letter, listingId }` |
| `notification` | `{ text, type }` — persistent queued toast (sold listings, etc.) |

---

## Frontend Architecture

### Stack

React 18 + Vite 5 + Tailwind 3. ESM throughout (`import`/`export`).
Mobile-first; designed to run inside Telegram's WebApp container at full
viewport height.

### Telegram WebApp SDK

Loaded via `<script>` in `index.html` **before** the React bundle.
Accessed as `window.Telegram.WebApp`. In `main.jsx`:

```js
window.Telegram.WebApp.expand();           // full-screen
window.Telegram.WebApp.disableVerticalSwipes?.();
```

`initData` = `window.Telegram?.WebApp?.initData || null`.

### State Flow

```
App.jsx
 ├── initData (useState)          ← null → DevUserPicker; set → chat
 ├── useAuth(initData)            ← user profile, coins, inventory, locks, pickaxeHits, chatId
 ├── useSocket(initData)          ← socket, connected, sendMessage()
 ├── ChatFeed                     ← chatId prop; reads socket for new_message events
 ├── PromptBanner                 ← prompt, promptReplies, replyMode, handleVote
 ├── RestrictedKeyboard           ← reads inventory + lockedLetters from user
 ├── ShopModal                    ← chatId prop; lootbox roll + P2P market + prompt + mines
 ├── BlackMarketModal             ← chatId prop; secret P2P market (triple-tap)
 └── LotteryModal                 ← chatId prop; gambling round (auto-opens on new_lottery)
```

**Triple-tap secret (black market):** `handleShopClick` in `App.jsx` uses
`shopClicksRef` (count) and `shopClickTimerRef` (timeout) refs. Click 1 opens
`ShopModal` and starts a 1500 ms reset timer. If a 3rd click arrives within
that window, `ShopModal` is closed and `BlackMarketModal` opens instead.

Socket events App.jsx handles:
- `user_update` → `updateUser(patch)`.
- `notification` → `showToast(text, type, { duration: 5000 })` — fires for both online (immediate) and offline (drained on reconnect) notifications.
- `new_prompt` → sets `prompt` state, clears replies.
- `new_prompt_reply` → appends to `promptReplies`.
- `vote_update` → updates `voteCount` on matching reply.
- `prompt_closed` → clears `prompt`, shows winner toast.
- `prompt_error` → shows error in PromptBanner.
- `new_lottery` / `lottery_bet_placed` / `lottery_closed`.
- `new_beg` → toast with name.

`updateUser(patch)` (from `useAuth`) is the single function for applying
server-pushed state changes. Call it whenever a socket `user_update` event
or a shop/mine AJAX response arrives. Handles: `newCoins`, `newInventory`,
`lockedLetter`, `pickaxeHits`.

`useAuth(initData)` now also returns `chatId` (Telegram `chat_id` from the auth
response). `App.jsx` passes `chatId` as a prop to `ChatFeed`, `ShopModal`,
`BlackMarketModal`, and `LotteryModal` so each component queries the correct room.

### System Messages in ChatFeed

`MessageBubble.jsx` checks `message.userId === 0`. If true, renders a centered
rounded-pill in `text-tg-hint` colour instead of a normal bubble. System messages
are persisted in the `messages` table and appear on hydration for all users,
including those who were offline when the event occurred.

### ShopModal Tabs

`ShopModal` has **5 tabs**: 🎰 Caja (roll), 🛒 Comprar (buy), 💰 Vender (sell),
📣 Prompts, ⛏️ Minas (mine).

**Minas tab** — two sub-views:
- **No pickaxe** (`hitsLeft <= 0`): buy panel with info (hits per pickaxe, hit chance %).
- **Has pickaxe** (`hitsLeft > 0`): rock 🪨 tap interface.
  - `swingState`: `'idle'` | `'swinging'` | `'miss'` | `'found'`.
  - `swingResult`: `null` | `{ letter }` — shown as a letter chip on find.
  - Hits counter displayed; secondary "buy more" button available.
  - Haptic `impactOccurred('medium')` on a find.
  - `onPurchase` is called with `{ newInventory }` on find, `{ newCoins }` on pickaxe buy.

### Lootbox UI (`ShopModal` — Roll Tab)

`RARITY_META` object at module level defines per-tier visual treatment. Key fields:
- `bgClass`, `textClass`, `chipClass` — full Tailwind class strings (no interpolation).
- `animated` — enables `animate-bounce` on letter chips (staggered `animationDelay`).
- `pulse` — enables `animate-pulse` on the result card backdrop (`épico`, `legendario`).
- `legendary` — shows extra sparkle row below the letters.
- `celebrationEmoji` — emoji row shown above the rarity label.

Haptic feedback on roll result: `legendario` → `notificationOccurred('success')`;
`épico` → `impactOccurred('heavy')`; `raro` → `impactOccurred('medium')`.

`rollResult` state is `{ letters: string[], rarity: string }` — **not a bare array**.

### RestrictedKeyboard Key Logic

The keyboard has **4 rows**:

```
Row 0: Q W E R T Y U I O P
Row 1:  A S D F G H J K L
Row 2: ⌫  Z X C V B N M Ñ
Row 3:    [  space bar  ]  ↵
```

Row 3 (space + enter) is intentionally separate from the letter rows so the
space bar never visually merges with the letter keys.

For every letter key `L`:

```
remaining = (inventory[L] ?? 0) - draftCount[L]
disabled  = remaining <= 0  OR  lockedLetters.includes(L)
```

The badge number on each key shows `remaining`. Keys are disabled via
`onPointerDown` suppression (not the HTML `disabled` attribute alone) so
the native focus behaviour stays clean on mobile.

**aria-label convention** (important for tests):
- Available key: `"a"` (just the lowercase letter)
- No-stock key: `"a (no stock)"`
- Locked key: `"a locked"`
- Special keys: `"⌫"`, `"␣"`, `"↵"`

### Tailwind Theme

Custom colours via CSS variables so the UI automatically adapts to the user's
Telegram theme (light/dark). All colour classes are prefixed `tg-`:

| Class | Variable | Default |
|---|---|---|
| `bg-tg-bg` | `--tg-theme-bg-color` | #ffffff |
| `bg-tg-bg-sec` | `--tg-theme-secondary-bg-color` | #f0f0f0 |
| `text-tg-text` | `--tg-theme-text-color` | #000000 |
| `text-tg-hint` | `--tg-theme-hint-color` | #999999 |
| `bg-tg-button` | `--tg-theme-button-color` | #2481cc |
| `text-tg-btn-text` | `--tg-theme-button-text-color` | #ffffff |

Do not hardcode colour hex values. Use `tg-*` classes so dark-mode works.

### Dev Mode (Frontend)

When `window.Telegram?.WebApp?.initData` is falsy (plain browser), `App.jsx`
renders `<DevUserPicker>` instead of the chat UI. The picker generates tokens in
the format `dev:USER_ID:username:First Name:CHAT_ID:Chat Title`.
Preset users (Alice, Bob, Carol, Dave, Eve) all share **Dev Room** (`-1001001`,
"Dev Room"). Once picked, `initData` is set in `useState` and the normal auth +
socket flow starts.

The custom user form includes **Chat ID** and **Chat Title** fields, allowing
developers to simulate multiple rooms by entering different chat IDs.

An amber banner is shown at the top of the chat while in dev mode with a
"**cambiar**" link that resets `initData` to `null`.

---

## Dev Mode (End-to-End)

Minimum `.env` to run everything without Telegram:

```
DEV_MODE=true
SERVER_PORT=3001
```

`BOT_TOKEN`, `GROUP_CHAT_ID`, and `MINI_APP_URL` are **not required** in dev
mode. The bot is simply not started.

To simulate two players:
1. Open `http://localhost:5173` → pick **Alice** (Dev Room, `chatId = -1001001`).
2. Open a second tab/incognito → pick **Bob** (same Dev Room).
3. Both use the same SQLite DB and Socket.io room `room:-1001001`.

To simulate **multiple rooms**, use the custom user form and enter different
Chat IDs for different tabs.

---

## Key Invariants – Do Not Break

1. **`processMessage` must be the only path that writes game state.** Never
   update `coins`, `streak_count`, `inventory_json`, or `letter_locks` outside
   of that function.

2. **All game-state DB writes happen in one `db.transaction()`.** If you add a
   new write inside `processMessage`, add it inside the existing transaction
   closure, not after it.

3. **Letters are unlock levels, not consumables, and are capped at `MAX_LETTER_LEVEL` (6).**
   `inventory[L]` is never decremented by sending a message. It only increases (from the
   first-message bonus or shop rolls — tiers never grant letters), and is always clamped
   to `MAX_LETTER_LEVEL` on every increment. The keyboard disables a key when
   `draftCount[L] >= inventory[L]`, but sending the message leaves the inventory unchanged.

4. **WAL mode.** Do not change `journal_mode`. The server's concurrency model
   (Socket.io events + HTTP requests sharing one DB connection) depends on
   WAL allowing concurrent reads during writes.

5. **`DEV_MODE=true` must never reach production.** Auth bypass is intentional
   and total — any token in `dev:…` format is accepted without verification.

6. **All game constants live in `backend/src/config.js`.** Do not hardcode
   values like `50`, `100`, or `200` in engine, database, or server files.
   Import from config. The frontend fetches them via `GET /api/config`.

7. **Coins can never go below zero.** Both `updateCoins` and `updateUser`
   prepared statements use `MAX(0, coins + ?)` / `MAX(0, coins + @coinDelta)`
   at the SQL level, so no engine path (Tier-3 penalty, market purchase) can
   produce a negative balance. Do not change these statements to plain addition.

8. **Market coin transfers are atomic.** `buyListing` wraps the debit (buyer),
   credit (seller), inventory update, and listing resolution inside a single
   `db.transaction()`. Do not add awaits or split the writes.

---

## Adding New Features — Checklist

- **New game constant?** Add it to `backend/src/config.js`. Import it wherever
  needed. If the frontend needs it, expose it in the `/api/config` response in
  `server.js`.
- **Changing UI text / language?** Edit strings directly in the React components
  (`frontend/src/`). Error messages are inline in the engine files. The prompt
  question pool is `PROMPT_POOL` in `config.js`. When changing an error string,
  also update the regex matcher in the corresponding test file.
- **New DB write?** Add it inside the `processMessage` transaction or in a
  dedicated transaction-wrapped helper. Add the prepared statement to `stmts`
  in `database.js`.
- **New DB table?** Add a migration to the `migrations` array in `database.js` and bump `SCHEMA_VERSION`.
- **New REST endpoint?** Add to `server.js`, guard with `authMiddleware`.
- **New Socket.io event?** Define in the `io.on('connection')` block; emit
  `user_update` or a new named event back to `socket` (not `io`) for
  per-user data, `io.emit` for broadcast.
- **Per-user alert (online or offline)?** Use `notifyUser(userId, text, type)` — never emit
  directly without persisting to `notifications`. Offline users will miss un-persisted events.
- **System chat message?** Use `broadcastSystemMessage(text, roomId)` — persists to DB as `userId=0`
  and emits to all active clients in `room:${roomId}`. Becomes visible to late joiners on feed hydration.
- **New UI state?** Thread it through `App.jsx` → `useAuth`'s `updateUser()`.
  Do not create separate fetch calls inside child components that could
  race with socket events.
- **New Tailwind colour?** Use a `tg-*` CSS variable, not a raw hex value.

---

## Testing

### Backend — Jest + supertest

- Config: `backend/jest.config.js` (`testEnvironment: 'node'`, `maxWorkers: 1`)
- Run: `cd backend && npm test`
- **150 tests across 6 suites** (all passing)

| File | Tests | What it covers |
|---|---|---|
| `src/__tests__/auth.test.js` | 18 | `validateInitData` HMAC, `validateInitDataDev` dev tokens, chatId return values |
| `src/__tests__/engine.test.js` | 30 | `letterRequirements` (incl. `_numbers`/`_symbols`), all 3 tiers, coin floor, letter level cap, `shopRoll` (lootbox rarity), ñ support, transaction shape |
| `src/__tests__/market.test.js` | 23 | `listLetter`, `buyListing`, `cancelListing`, `getOpenListings`, `getUserListings`, coin/letter cap invariants; BM factory isolation (`bmListLetter`, `bmCancelListing`, `getBmOpenListings`, `getBmUserListings`) |
| `src/__tests__/blackMarket.test.js` | 16 | Heat decay, `addHeat`, `catchProbability`, `runCatchCheck`, listing expiry |
| `src/__tests__/mining.test.js` | 18 | `buyPickaxe`, `swing`, hit/miss probability, coin deduction, inventory cap |
| `src/__tests__/api.test.js` | 45 | All REST endpoints incl. P2P market + full BM endpoint flow + mining, end-to-end with temp SQLite DB |

**Key patterns:**
- `FUTELO_DATA_DIR` env override points the DB to a temp directory per test run.
- `server.js` is guarded with `require.main === module` so supertest can import it without binding a port.
- `jest.resetAllMocks()` in `beforeEach` (not `clearAllMocks`) to wipe `mockReturnValueOnce` queues. Also re-set `db.transaction.mockImplementation(fn => () => fn())` at the top of each `beforeEach` in `market.test.js`.
- API tests set `process.env.BOT_TOKEN = ''` before `jest.resetModules()` to prevent grammY from starting.
- User token constants: `ALICE='dev:1001:…'`, `BOB='dev:1002:…'`, `DAVE='dev:1004:…'` (market buyer), `EVE='dev:1005:…'` (market seller), `FRANK='dev:1006:…'` (BM tests only), `GINA='dev:1007:…'` / `HANK='dev:1008:…'` (mining tests, defined inline). Use fresh users for new suites to avoid state conflicts with earlier tests.

### Frontend — Vitest + Testing Library

- Config: `test:` block in `frontend/vite.config.js` (`environment: 'jsdom'`)
- Run: `cd frontend && npm test`
- **35 tests across 2 suites** (all passing)

| File | Tests | What it covers |
|---|---|---|
| `src/__tests__/RestrictedKeyboard.test.jsx` | 20 | Rendering, badges (letters + number/symbol group pools), disabled states, pointer interactions |
| `src/__tests__/MessageBubble.test.jsx` | 15 | Text, sender names, coin delta badges, tier labels, layout |

**Key patterns:**
- Query keys by their exact aria-label (`'a'`, `'a (no stock)'`, `'a locked'`) — not uppercase regex.
- `fireEvent.pointerDown` (not `click`) to match the component's `onPointerDown` handlers.
- MessageBubble tier label matchers use Spanish: `/aviso de spam/i` (Tier 2), `/penalizaci/i` (Tier 3), `/aviso|penalizaci/i` (none expected).

---

## Common Pitfalls

| Pitfall | Fix |
|---|---|
| `requireUser(id)` throws "not found" | The user must call `/start` (or `/api/auth`) before any game action. In dev mode the picker auto-upserts on `POST /api/auth`. |
| Socket connects but `user_update` never fires | Check that the client joined before the message was processed. The personal room is `user:USER_ID` — confirm `socket.join` ran. |
| Letter key stays disabled after shop roll | `ShopModal` calls `onPurchase(result)` → `updateUser({ newInventory })` in `App.jsx`. If the prop chain breaks, the keyboard won't re-render. |
| `db.transaction` wraps async code | `better-sqlite3` is **synchronous only**. Never `await` inside a transaction. |
| Tailwind classes not showing | Purge is based on `content: ['./src/**/*.{js,jsx}']` in `tailwind.config.js`. Dynamically constructed class strings (string interpolation) won't be detected — use full class names. |
| Keyboard row layout | Space and Enter live on **row 3** (their own row). Do not move them onto the letter rows. The `ROWS` constant in `RestrictedKeyboard.jsx` is the single source of truth. |
| `ShopModal` shows wrong prices | It fetches `/api/config` on mount. If the fetch fails it falls back to the hardcoded defaults in `useState`. Always restart the backend after editing `config.js`. |
| Prompt won't start | Only one prompt can be active at a time per room. Call `getActivePrompt(roomId)` first; if it returns non-null, the previous round must close before a new one starts. |
| Lottery won't start | Only one round can be active at a time per room. Same pattern — check `getActiveLotteryRound(roomId)` first. |
| Engine error strings changed | Test regexes in `engine.test.js` and `api.test.js` must match the Spanish wording — e.g. `/vac/i` for empty, `/insuficiente/i` for not-enough, `/bloqueada/i` for locked. |
| Seller misses sale toast when offline | Use `notifyUser()` — not a direct socket emit — so the notification persists until delivered. |
| System messages missing from feed | Requires `id=0` user row (migration v5). Restart the server to re-run migrations on a fresh DB. |
| `rollResult` shape changed | `rollResult` in `ShopModal` is `{ letters: string[], rarity: string }` — not a bare `string[]`. Access letters via `rollResult.letters`. |
| `pickaxeHits` not updating after mine | `ShopModal` maintains its own `hitsLeft` state synced from `initialPickaxeHits` prop via `useEffect`. The prop flows: server response → `onPurchase` → `updateUser` → `App.jsx` state → `pickaxeHits` prop → `ShopModal`. |
| BM list fires "Compraste" toast | The buy toast in `handleBmPurchase` checks `result.newCoins !== undefined` — list responses omit `newCoins` so no toast fires. Do not add `newCoins` to the list response. |
| Game state bleeds between groups | Every query that reads/writes game state (prompts, market, lottery, messages, streaks) must pass the correct `roomId`. Room 0 is the legacy global placeholder — do not use it in new code. |
| BM heat is per-room | It is **not** per-room — BM heat is global. `getAllOpenBmListingsGlobal` scans all rooms. This is intentional. |
