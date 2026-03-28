# Futelo – Agent Context

This file gives AI coding agents the background needed to work on this codebase
without re-reading every file from scratch.

Scoped instruction files also active:
- `.github/instructions/backend.instructions.md` — applies to `backend/**`
- `.github/instructions/frontend.instructions.md` — applies to `frontend/**`

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
│   │   │   ├── blackMarketHeat.js  Black market heat / catch mechanic
│   │   │   └── mining.js          Pickaxe / letter-mine engine
│   │   └── bot/
│   │       ├── bot.js             grammY bot (/start + /setthread + /setthreaddelete)
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
│   │   │   ├── Header.jsx
│   │   │   ├── ChatFeed.jsx
│   │   │   ├── MessageBubble.jsx
│   │   │   ├── PromptBanner.jsx
│   │   │   ├── RestrictedKeyboard.jsx
│   │   │   ├── ShopModal.jsx
│   │   │   ├── BlackMarketModal.jsx
│   │   │   ├── LotteryModal.jsx
│   │   │   └── DevUserPicker.jsx
│   │   ├── hooks/
│   │   │   ├── useAuth.js
│   │   │   └── useSocket.js
│   │   └── test/
│   │       └── setup.js
│   ├── index.html
│   ├── vite.config.js             Proxies /api and /socket.io → :3001 in dev; test config
│   ├── tailwind.config.js
│   └── package.json
│
├── nginx/
│   └── futelo.conf    Nginx reverse-proxy, SSL, rate-limits, SPA fallback
│
└── data/              Auto-created at runtime; contains futelo.db (gitignored)
```

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
   to `MAX_LETTER_LEVEL` on every increment.

4. **WAL mode.** Do not change `journal_mode`. The server's concurrency model
   (Socket.io events + HTTP requests sharing one DB connection) depends on
   WAL allowing concurrent reads during writes.

5. **Per-Room Economy & Progress.** From schema v19 onwards, `user_achievements`, `unlocked_emojis`, and `user_stats` are strictly scoped by a composite key `(user_id, room_id)`. Never fallback to a global lookup unless handling legacy `room_id = 0` during data migrations.

6. **`DEV_MODE=true` must never reach production.** Auth bypass is intentional
   and total — any token in `dev:…` format is accepted without verification.

7. **All game constants live in `backend/src/config.js`.** Do not hardcode
   values like `50`, `100`, or `200` in engine, database, or server files.
   Import from config. The frontend fetches them via `GET /api/config`.

8. **Coins can never go below zero.** `updateCoins` and `updateUser` statements
   use `MAX(0, coins + ?)` at the SQL level. Do not change these to plain addition.

9. **Market coin transfers are atomic.** `buyListing` wraps debit, credit,
   inventory update, and listing resolution in a single `db.transaction()`.

---

## Adding New Features — Checklist

- **New game constant?** Add to `backend/src/config.js`. Expose in `/api/config` if frontend needs it.
- **Changing UI text / language?** Edit strings in React components or engine files. Update test regex matchers too.
- **New DB write?** Add inside the `processMessage` transaction or a dedicated transaction helper. Add prepared statement to `stmts` in `database.js`.
- **New DB table?** Add a migration to the `migrations` array in `database.js` and bump `SCHEMA_VERSION`.
- **New REST endpoint?** Add to `server.js`, guard with `authMiddleware`.
- **New Socket.io event?** Define in `io.on('connection')`. Emit to `socket` for per-user data, `io.to(room)` for broadcast.
- **Per-user alert (online or offline)?** Use `notifyUser(userId, text, type)` — never emit directly without persisting to `notifications`.
- **System chat message?** Use `broadcastSystemMessage(text, roomId)` — persists as `userId=0` and emits to room.
- **New UI state?** Thread through `App.jsx` → `useAuth`'s `updateUser()`. Do not create separate fetch calls in child components.
- **New Tailwind colour?** Use a `tg-*` CSS variable, not a raw hex value.

---

## Common Pitfalls

| Pitfall | Fix |
|---|---|
| Push notification bell has no effect | User must `/start` the bot in a **private DM** first. Without that, `bot.api.sendMessage` gets a 403 silently. |
| `requireUser(id)` throws "not found" | User must call `/api/auth` before any game action. Dev picker auto-upserts on auth. |
| Socket connects but `user_update` never fires | Personal room is `user:USER_ID` — confirm `socket.join` ran before the message was processed. |
| Letter key stays disabled after shop roll | `ShopModal` → `onPurchase(result)` → `updateUser({ newInventory })` in `App.jsx`. Check prop chain. |
| `db.transaction` wraps async code | `better-sqlite3` is **synchronous only**. Never `await` inside a transaction. |
| Tailwind classes not showing | Never use dynamic class interpolation (e.g. `` `w-${size}` ``). Always use full static class strings. |
| Engine error strings changed | Update the regex matchers in `engine.test.js` and `api.test.js` (Spanish wording: `/vac/i`, `/insuficiente/i`, `/bloqueada/i`). |
| Seller misses sale toast when offline | Use `notifyUser()` — not a direct socket emit — so the notification persists. |
| System messages missing from feed | Requires `id=0` user row (migration v5). Restart server on a fresh DB. |
| Game state bleeds between groups | Every query must pass the correct `roomId`. Room 0 is the legacy placeholder — do not use in new code. |
| BM heat is per-room | It is **not** per-room — BM heat is global. `getAllOpenBmListingsGlobal` scans all rooms. Intentional. |
| Prompt / lottery won't start | Only one active per room at a time. Check `getActivePrompt` / `getActiveLotteryRound` first. |
