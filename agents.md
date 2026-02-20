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
│   │   │   ├── processMessage.js  Game engine + shopRoll() + sellLetter()
│   │   │   ├── promptEngine.js    Community prompt lifecycle
│   │   │   └── blackMarket.js     Black market listing / heat / sweep engine
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
│   │   │   ├── MessageBubble.jsx  Single chat bubble (own/other + tier badge)
│   │   │   ├── PromptBanner.jsx   Collapsible prompt panel (timer, replies, votes)
│   │   │   ├── RestrictedKeyboard.jsx  Custom 4-row keyboard with inventory limits
│   │   │   ├── ShopModal.jsx      Letter roll + prompt fire bottom-sheet
│   │   │   └── DevUserPicker.jsx  Dev-only user picker (no Telegram needed)
│   │   ├── hooks/
│   │   │   ├── useAuth.js         POST /api/auth on mount, exposes updateUser()
│   │   │   └── useSocket.js       Socket.io connection manager
│   │   ├── __tests__/
│   │   │   ├── RestrictedKeyboard.test.jsx  14 tests (Vitest + RTL)
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
frontend so `ShopModal` never needs updating when prices change. It also
includes live values: `heat` (current heat level) and `catchProbPerMin`
(current catch probability per minute).

```js
module.exports = {
  STARTING_COINS:       100,
  TIER1_COINS:          10,
  TIER1_LETTERS:        2,
  TIER3_PENALTY:        50,
  LOCK_DURATION_SEC:    5 * 60,
  ROLL_COST:            50,
  ROLL_COUNT:           3,
  PROMPT_DURATION_SEC:  3 * 60,
  PROMPT_WINNER_BONUS:  100,
  PROMPT_RUNNER_UP_BONUS: 30,
  PROMPT_BUY_COST:      200,
  INACTIVITY_SEC:       24 * 60 * 60,
  // ── Letter market ──
  SELL_BASE_PRICE:       15,        // coins for a normal or BM sale
  SELL_COMMISSION_RATE:  0.20,      // tax taken on normal market
  // ── Black market heat system ──
  BLACK_MARKET_FINE:        40,     // coin penalty when caught
  BLACK_MARKET_BASE_PROB:   0.04,   // catch prob/min at heat = 0  (4 %)
  BLACK_MARKET_MAX_PROB:    0.80,   // hard ceiling for catch prob (80 %)
  HEAT_CATCH_INCREMENT:     0.20,   // heat spike per catch
  HEAT_MENTION_INCREMENT:   0.08,   // heat spike per "mercado negro" mention
  HEAT_DECAY_RATE:          0.90,   // multiplier applied each minute
  HEAT_MAX:                 1.0,    // clamp ceiling
  BLACK_MARKET_LISTING_SEC: 10 * 60, // seconds before an uncollected listing expires
  PROMPT_POOL:          [ /* 20 Spanish questions */ ],
};
```

To change any price, edit this file and restart the backend. The frontend
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

#### Tables

| Table | Purpose |
|---|---|
| `users` | One row per Telegram user. `inventory_json` is a JSON string `{"a":3,"b":1,...}`. |
| `game_state` | Key/value. Holds `last_sender_id` and `black_market_heat`. |
| `messages` | Persisted chat log used to hydrate the feed on load. |
| `letter_locks` | Active Tier-3 penalties per user. `locked_until` is a Unix timestamp. |
| `prompts` | One row per prompt round. `status`: `active` or `closed`. |
| `prompt_replies` | Replies to a prompt. Each row has `user_id`, `text`, `vote_count`. |
| `prompt_votes` | One vote per `(reply_id, voter_id)` pair — enforces one-vote-per-user. |
| `black_market_listings` | One row per BM listing. `status`: `pending` / `collected` / `caught` / `expired`. `coins_delta` stores the final payout or fine amount. |

#### Prepared Statements

All queries are **pre-compiled** on startup in the `stmts` object exported from
`database.js`. Always use these rather than calling `db.prepare()` inline — it
keeps query compilation cost to zero per request and avoids re-parsing.

```js
const { db, stmts, upsertUser, requireUser } = require('../db/database');
```

Black-market prepared statements (also in `stmts`):

| Statement | What it does |
|---|---|
| `insertBmListing` | Inserts a new `pending` listing row, returns `lastInsertRowid`. |
| `getBmListing` | Fetches one listing by `id`. |
| `getActiveBmListing` | Finds an active (`pending`) listing for a `(userId, letter)` pair. |
| `getPendingBmListings` | Returns all listings with `status = 'pending'`. |
| `getExpiredBmListings` | Returns pending listings older than the provided Unix cutoff. |
| `resolveBmListing` | Updates `status`, `coins_delta`, and `resolved_at` by `id`. |
| `getUserBmListings` | Returns a user's 20 most recent listings (any status). |

### Game Engine (`backend/src/engine/processMessage.js`)

The **only** place that mutates game state. Rules:

```
Letter inventory[L] = maximum number of character L allowed per message.
Letters are NEVER consumed — they are unlock levels.
```

**Coin tiers** (checked in `processMessage(userId, text)`):

| Condition | Tier | Coins | Letters |
|---|---|---|---|
| `last_sender_id !== userId` | 1 | +`TIER1_COINS` (10) | `TIER1_LETTERS` (2) random |
| Same user, `streak_count + 1 == 2` | 2 | 0 | 0 (warning) |
| Same user, `streak_count + 1 >= 3` | 3 | −`TIER3_PENALTY` (50) | 0 + lock 1 random letter for `LOCK_DURATION_SEC` (5 min) |

**Critical invariant**: every call to `processMessage` wraps **all** DB writes
in a single `db.transaction()`. Do not split the writes — partial state is a
game-breaking bug.

Exported:
- `processMessage(userId, text)` — throws a user-facing `Error` on validation
  failure; returns a rich result object on success.
- `shopRoll(userId)` — costs `ROLL_COST` coins, unlocks `ROLL_COUNT` random
  letters. Both values come from `config.js`.
- `sellLetter(userId, letter)` — normal market sell: deducts one letter level,
  awards `floor(SELL_BASE_PRICE × (1 − SELL_COMMISSION_RATE))` coins instantly.
  Throws on invalid letter or zero inventory.
- `letterRequirements(text)` — pure helper, returns `{a:1, p:2, ...}`.

### Black Market Engine (`backend/src/engine/blackMarket.js`)

Manages the letter escrow/listing lifecycle, global heat, and per-minute catch
sweeps. All constants come from `config.js`.

**Heat formula:**
```
catch_prob / min = min(BASE_PROB × (1 + heat × 15), MAX_PROB)
heat = 0.0  →  4 %    heat = 0.5  →  34 %    heat = 1.0  →  64 %
```

**Heat inputs:**
- Listing caught by server sweep: `heat += HEAT_CATCH_INCREMENT` (0.20)
- "mercado negro" mentioned in chat: `heat += HEAT_MENTION_INCREMENT` (0.08)
- Each sweep cycle (every 60 s): `heat *= HEAT_DECAY_RATE` (0.90)

Exported functions:

| Function | Description |
|---|---|
| `listLetter(userId, letter)` | Escrows one letter level, creates a `pending` listing. Throws if letter is invalid, inventory is zero, or the letter is already listed. Returns `{ listingId, letter, listedAt, heat, catchProbPerMin, expiresIn, newInventory }`. |
| `collectListing(userId, listingId)` | Awards `SELL_BASE_PRICE` coins to the owner while the listing is still `pending`. Throws for wrong owner or non-pending status. |
| `sweepCatchRolls()` | Called every 60 s. Expires stale listings (returns letters), decays heat, rolls pending listings. Returns `{ caught: [...], expired: [...] }`. |
| `getUserListings(userId)` | Returns the user's 20 most recent listings (any status). |
| `addMentionHeat()` | Bumps heat by `HEAT_MENTION_INCREMENT`; called when "mercado negro" appears in chat. |
| `getHeat()` | Reads current heat from `game_state`; returns 0 if no row. |
| `catchProbForHeat(heat)` | Pure formula — returns the per-minute catch probability for a given heat value. |

### Prompt Engine (`backend/src/engine/promptEngine.js`)

Manages the community prompt lifecycle. All durations and coin rewards come
from `config.js`.

Exported:
- `startPrompt(text)` — opens a new prompt (throws if one is already active).
- `getActivePrompt()` — returns the current active prompt row or `null`.
- `getPromptWithReplies(promptId)` — returns prompt + all replies with vote counts.
- `submitReply(promptId, userId, text)` — adds a reply row.
- `castVote(replyId, voterId)` — records a vote (one per user per prompt).
- `closePrompt(promptId)` — marks prompt closed, distributes coin rewards
  (`PROMPT_WINNER_BONUS`, `PROMPT_RUNNER_UP_BONUS`), returns winner info.
- `buyPrompt(userId, text)` — deducts `PROMPT_BUY_COST` from user's coins,
  then calls `startPrompt`.
- `PROMPT_DURATION_SEC`, `WINNER_BONUS`, `RUNNER_UP_BONUS`, `PROMPT_BUY_COST`
  re-exported for use in `server.js`.

### Bot (`backend/src/bot/bot.js`)

- Imported lazily in `server.js`; skipped entirely when `DEV_MODE=true` and
  no `BOT_TOKEN` is set.
- `/start` command: upserts the user, replies with Mini App button.
- `on('message')` in the group: deletes every message from non-bot users.
- `broadcastToGroup(payload)` — called by `server.js` after every validated
  message to mirror the chat as a read-only feed in Telegram. Fire-and-forget.

### Authentication (`backend/src/bot/auth.js`)

- `validateInitData(initDataRaw, botToken)` — full HMAC-SHA256 check per
  Telegram spec.
- When `DEV_MODE=true`, also accepts tokens of the form
  `dev:USER_ID:username:First Name` and skips the HMAC.
- Used in **both** the HTTP auth middleware and the Socket.io middleware.

### HTTP API

All endpoints are defined in `server.js`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/config` | none | Public game constants (prices, rewards, durations, live heat) |
| POST | `/api/auth` | initData header | Upsert user, return profile |
| GET | `/api/me` | initData header | Current user profile + locks |
| GET | `/api/messages?limit=N` | none | Last N messages (default 50, max 200) |
| POST | `/api/message` | initData header | Send a message via the engine |
| POST | `/api/shop/roll` | initData header | Buy a letter roll |
| POST | `/api/shop/sell` | initData header | Sell a letter on the normal market (body: `{ letter }`) |
| POST | `/api/shop/prompt` | initData header | Buy and fire a community prompt |
| GET | `/api/prompts/active` | none | Active prompt + replies (or 404) |
| POST | `/api/prompts/:id/reply` | initData header | Submit a reply to a prompt |
| POST | `/api/prompts/replies/:replyId/vote` | initData header | Cast a vote on a reply |
| GET | `/api/blackmarket/heat` | none | Current heat level + catch probability |
| GET | `/api/blackmarket/listings` | initData header | Caller's 20 most recent BM listings |
| POST | `/api/blackmarket/list` | initData header | Escrow a letter on the black market (body: `{ letter }`) |
| POST | `/api/blackmarket/collect/:id` | initData header | Collect coins from a pending listing |

Auth is sent as the `x-init-data` HTTP header **or** `body.initData`.

### Socket.io

- Clients authenticate on `connect` via `socket.handshake.auth.initData`.
- Each user joins a personal room `user:USER_ID` for targeted events.

**Client → Server:**

| Event | Payload | Effect |
|---|---|---|
| `send_message` | `{ text }` | Engine validates → `new_message` broadcast |
| `vote_reply` | `{ replyId }` | Records vote → `vote_update` broadcast |

**Server → Client (broadcast to all):**

| Event | Payload |
|---|---|
| `new_message` | Full message object |
| `new_prompt` | Prompt object (new round started) |
| `new_prompt_reply` | Reply object added to active prompt |
| `vote_update` | `{ replyId, voteCount }` |
| `prompt_closed` | `{ promptId, winner, runnerUp }` |
| `bm_heat_update` | `{ heat, catchProbPerMin }` — emitted when heat changes (mention, catch, sweep) |

**Server → Client (sender only):**

| Event | Payload |
|---|---|
| `user_update` | `{ newCoins, newInventory, newLetters, lockedLetter, tier, coinDelta }` |
| `rejected_message` | `{ reason }` |
| `prompt_error` | `{ reason }` |
| `bm_caught` | `{ listingId, letter, fine, newCoins, newInventory }` — listing caught in sweep |
| `bm_expired` | `{ listingId, letter, newInventory }` — listing expired, letter returned |

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
 ├── useAuth(initData)            ← user profile, coins, inventory, locks
 ├── useSocket(initData)          ← socket, connected, sendMessage()
 ├── ChatFeed                     ← reads socket for new_message events
 ├── PromptBanner                 ← prompt, promptReplies, replyMode, handleVote
 ├── RestrictedKeyboard           ← reads inventory + lockedLetters from user
 └── ShopModal                    ← calls /api/shop/roll or /api/shop/prompt
```

Socket events App.jsx handles for prompts:
- `new_prompt` → sets `prompt` state, clears replies.
- `new_prompt_reply` → appends to `promptReplies`.
- `vote_update` → updates `voteCount` on matching reply.
- `prompt_closed` → clears `prompt`, shows winner toast.
- `prompt_error` → shows error in PromptBanner.

`updateUser(patch)` (from `useAuth`) is the single function for applying
server-pushed state changes. Call it whenever a socket `user_update` event
or a shop AJAX response arrives.

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
renders `<DevUserPicker>` instead of the chat UI. The picker generates
`dev:USER_ID:username:First Name` tokens. Once picked, `initData` is set in
`useState` and the normal auth + socket flow starts.

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
1. Open `http://localhost:5173` → pick **Alice**.
2. Open a second tab/incognito → pick **Bob**.
3. Both use the same SQLite DB and Socket.io room.

---

## Key Invariants – Do Not Break

1. **`processMessage` must be the only path that writes game state.** Never
   update `coins`, `streak_count`, `inventory_json`, or `letter_locks` outside
   of that function.

2. **All game-state DB writes happen in one `db.transaction()`.** If you add a
   new write inside `processMessage`, add it inside the existing transaction
   closure, not after it.

3. **Letters are unlock levels, not consumables.** `inventory[L]` is never
   decremented by sending a message. It only increases (from Tier-1 rewards or
   shop rolls). The keyboard disables a key when `draftCount[L] >= inventory[L]`,
   but sending the message leaves the inventory unchanged.

4. **WAL mode.** Do not change `journal_mode`. The server's concurrency model
   (Socket.io events + HTTP requests sharing one DB connection) depends on
   WAL allowing concurrent reads during writes.

5. **`DEV_MODE=true` must never reach production.** Auth bypass is intentional
   and total — any token in `dev:…` format is accepted without verification.

6. **All game constants live in `backend/src/config.js`.** Do not hardcode
   values like `50`, `100`, or `200` in engine, database, or server files.
   Import from config. The frontend fetches them via `GET /api/config`.

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
- **New REST endpoint?** Add to `server.js`, guard with `authMiddleware`.
- **New Socket.io event?** Define in the `io.on('connection')` block; emit
  `user_update` or a new named event back to `socket` (not `io`) for
  per-user data, `io.emit` for broadcast.
- **New UI state?** Thread it through `App.jsx` → `useAuth`'s `updateUser()`.
  Do not create separate fetch calls inside child components that could
  race with socket events.
- **New Tailwind colour?** Use a `tg-*` CSS variable, not a raw hex value.

---

## Testing

### Backend — Jest + supertest

- Config: `backend/jest.config.js` (`testEnvironment: 'node'`, `maxWorkers: 1`)
- Run: `cd backend && npm test`
- **82 tests across 4 suites** (all passing)

| File | Tests | What it covers |
|---|---|---|
| `src/__tests__/auth.test.js` | 12 | `validateInitData` HMAC, `validateInitDataDev` dev tokens |
| `src/__tests__/engine.test.js` | 22 | `letterRequirements`, all 3 tiers, `shopRoll`, `sellLetter`, ñ support, transaction shape |
| `src/__tests__/blackMarket.test.js` | 24 | Heat helpers, `listLetter`, `collectListing`, `sweepCatchRolls`, Math.random spy |
| `src/__tests__/api.test.js` | 24 | All REST endpoints incl. sell + black market, end-to-end with temp SQLite DB |

**Key patterns:**
- `FUTELO_DATA_DIR` env override points the DB to a temp directory per test run.
- `server.js` is guarded with `require.main === module` so supertest can import it without binding a port.
- `jest.resetAllMocks()` in `beforeEach` (not `clearAllMocks`) to wipe `mockReturnValueOnce` queues.
- API tests set `process.env.BOT_TOKEN = ''` before `jest.resetModules()` to prevent grammY from starting.
- User token constants: `ALICE='dev:1001:…'`, `BOB='dev:1002:…'`, `DAVE='dev:1004:…'` (sell tests), `EVE='dev:1005:…'` (BM tests). Use fresh users for new suites to avoid state conflicts with earlier tests.

### Frontend — Vitest + Testing Library

- Config: `test:` block in `frontend/vite.config.js` (`environment: 'jsdom'`)
- Run: `cd frontend && npm test`
- **29 tests across 2 suites** (all passing)

| File | Tests | What it covers |
|---|---|---|
| `src/__tests__/RestrictedKeyboard.test.jsx` | 14 | Rendering, badges, disabled states, pointer interactions |
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
| Prompt won't start | Only one prompt can be active at a time. Call `getActivePrompt()` first; if it returns non-null, the previous round must close before a new one starts. |
| Engine error strings changed | Test regexes in `engine.test.js` and `api.test.js` must match the Spanish wording — e.g. `/vac/i` for empty, `/insuficiente/i` for not-enough, `/bloqueada/i` for locked. |
