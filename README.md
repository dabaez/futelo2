# Futelo — Telegram Mini App

> A letter-economy chat game. Every character costs inventory. Every message has a coin consequence.
>
> **UI language: Spanish.** All user-facing text (labels, toasts, error messages, prompt questions) is in Spanish. To change the language, update the strings in `frontend/src/` components and `backend/src/config.js` (`PROMPT_POOL`).

---

## Project Structure

```
futelo/
├── agents.md             AI agent context (read before making changes)
├── README.md
├── deploy.sh             One-shot deployment script
│
├── backend/              Node.js server (CommonJS, grammY + Socket.io + better-sqlite3)
│   ├── src/
│   │   ├── config.js               ← single source of truth for all game constants
│   │   ├── server.js               Express + Socket.io entry point
│   │   ├── db/
│   │   │   └── database.js         SQLite schema + WAL setup + prepared statements
│   │   ├── engine/
│   │   │   ├── processMessage.js   Futelo game engine (letter validation, coin tiers + normal sell)
│   │   │   ├── promptEngine.js     Community prompt lifecycle (start/vote/close)
│   │   │   └── blackMarket.js      Black market listing/heat/sweep engine
│   │   └── bot/
│   │       ├── bot.js              grammY bot (gatekeeper + Telegram mirror)
│   │       └── auth.js             Telegram initData HMAC validator
│   ├── .env.example
│   └── package.json
│
├── frontend/             React + Vite + Tailwind SPA
│   ├── src/
│   │   ├── components/
│   │   │   ├── Header.jsx            Coin balance + shop button
│   │   │   ├── ChatFeed.jsx          Scrollable message list
│   │   │   ├── MessageBubble.jsx     Single message bubble (own/other)
│   │   │   ├── PromptBanner.jsx      Collapsible prompt panel (timer, replies, votes)
│   │   │   ├── RestrictedKeyboard.jsx Custom 4-row keyboard with inventory badges
│   │   │   ├── ShopModal.jsx         Letter roll, sell (normal + black market), prompt fire bottom sheet
│   │   │   └── DevUserPicker.jsx     Dev-only user picker
│   │   ├── hooks/
│   │   │   ├── useAuth.js            Auth + user state
│   │   │   └── useSocket.js          Socket.io connection manager
│   │   ├── __tests__/
│   │   │   ├── RestrictedKeyboard.test.jsx
│   │   │   └── MessageBubble.test.jsx
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── index.css
│   ├── index.html
│   ├── vite.config.js
│   ├── tailwind.config.js
│   └── package.json
│
├── nginx/
│   └── futelo.conf       Production Nginx reverse-proxy config
│
└── data/                 SQLite WAL files (auto-created, gitignored)
```

---

## Quick Start (Local Dev)

### 1. Backend

```bash
cd backend
cp .env.example .env
# Minimum required for dev: set DEV_MODE=true (no bot token needed)
#   DEV_MODE=true
#   SERVER_PORT=3001
npm install
npm run dev        # nodemon, port 3001
```

### 2. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev        # Vite, port 5173 (proxies /api and /socket.io to :3001)
```

Open [http://localhost:5173](http://localhost:5173) in a browser.

### Testing Without Telegram

When `DEV_MODE=true` in the backend and you open the app in a plain browser
(no `window.Telegram.WebApp.initData`), a **Dev User Picker** screen appears:

1. Click one of the four preset users (Alice, Bob, Charlie, Diana) **or** enter a
   custom User ID / username / name.
2. The app generates a `dev:USER_ID:username:First Name` token and logs you
   straight in — the backend accepts it because `DEV_MODE=true`.
3. Open a **second browser tab** (or window, or incognito), pick a *different*
   user, and start chatting. Both tabs share the same Socket.io room and
   SQLite database, so you can observe the full Tier-1/2/3 economy in action.

A small **amber banner** appears at the top while in dev mode showing who you
are, with a **"cambiar"** link to go back to the picker.

> ⚠️  Never set `DEV_MODE=true` in production — it completely bypasses
> Telegram authentication.

---

## Production Deployment

```bash
bash deploy.sh
```

Requires:
- Node.js 20+, npm, pm2 (`sudo npm i -g pm2`)
- Nginx installed and running
- A valid SSL cert via Certbot (`certbot --nginx -d your-domain.com`)
- `backend/.env` fully populated

### Bot Setup

1. Create a bot via [@BotFather](https://t.me/BotFather).
2. In BotFather, set the Mini App URL: `/newapp` → point to `https://your-domain.com`.
3. Add the bot to your Telegram group as **Admin** with "Delete messages" permission.
4. Set `BOT_MODE=webhook` and `WEBHOOK_DOMAIN=https://your-domain.com` in `.env`.

---

## Game Rules

### Coin Tiers

| Tier | Condition | Monedas | Letras |
|------|-----------|---------|--------|
| 1 | Diferente usuario habló último | **+10** | 2 aleatorias |
| 2 | Propio mensaje, racha = 2 | **0** | 0 |
| 3 | Propio mensaje, racha ≥ 3 | **−50** | 1 aleatoria **bloqueada 5 min** |

**Letters** are unlock levels (not consumed). `inventory["a"] = 3` means you can use up to 3 `a`s per message.

### Shop

| Item | Coste | Efecto |
|------|-------|--------|
| Tirada de letras | 50 🪙 | Desbloquea 3 letras aleatorias (+1 nivel cada una) |
| Lanzar un prompt | 200 🪙 | Inicia un prompt comunitario inmediatamente |
| Vender letra (mercado normal) | 0 | Recibe 12 🪙 instantáneamente (precio base 15 menos 20 % de comisión) |
| Vender letra (mercado negro) | 0 | Recibe 15 🪙 sin comisión si cobras antes de ser atrapado — con riesgo de multa |

### Letter Market

Players can sell letter levels from the Shop's **Vender** tab.

**Mercado normal** — instant, no risk:
- Earn `floor(15 × 0.80) = 12` 🪙 immediately.
- The letter level is deducted from inventory right away.

**Mercado negro** — deferred, risky:
- The letter level is escrowed (removed from inventory) and listed immediately.
- While listed you earn **15 🪙** (no commission) if you collect before the listing expires or you get caught.
- Every minute the server rolls each active listing against a catch probability that depends on the **global heat level**:
  - At heat = 0 → **4 % / min**; at heat = 1.0 → **64 % / min** (hard cap 80 %).
  - If caught: pay a **−40 🪙 fine** and heat spikes by +0.20.
  - Every mention of "mercado negro" in chat adds +0.08 heat.
  - Heat decays ×0.90 per minute with no catches.
- Listings expire after 10 minutes if uncollected; the letter is returned to inventory, no coins awarded.

### Community Prompts

A timed Q&A round (3 minutes) that runs inside the chat.

- Triggered automatically after **24 h of inactivity**, or bought from the shop for 200 🪙.
- Any player can reply. Others vote with ❤️.
- When the timer expires: **+100 🪙** to the top-voted reply, **+30 🪙** to the runner-up.
- Only one prompt runs at a time.

### All game constants live in `backend/src/config.js`

Edit that file (and restart the backend) to change any price, reward, or duration — no other file needs touching.

---

## Architecture Notes

- **WAL mode** (`PRAGMA journal_mode = WAL`) allows concurrent Socket.io reads while writes are in progress, critical on a single-core 1 GB droplet.
- Every `processMessage` call wraps all DB mutations in a **single transaction** — zero partial-state bugs.
- The frontend keyboard reads `inventory[letter] - draftCount[letter]` live, greying out or locking keys in real time before the message is sent.
- The Telegram bot is an **in-process grammY instance** (long-polling dev / webhook prod). It acts as a read-only mirror, never letting real users post in the group.

---

## Tests

### Backend (Jest + supertest)

```bash
cd backend && npm test
```

| Suite | Tests | Coverage |
|-------|-------|----------|
| `auth.test.js` | 12 | HMAC-SHA256 validation, dev token bypass |
| `engine.test.js` | 22 | `letterRequirements`, all 3 coin tiers, `shopRoll`, `sellLetter`, ñ support |
| `blackMarket.test.js` | 24 | Heat helpers, `listLetter`, `collectListing`, `sweepCatchRolls` |
| `api.test.js` | 24 | All REST endpoints incl. sell + black market (temp DB, `DEV_MODE=true`) |

Total: **82 tests**. Runs `--runInBand` (single-writer SQLite safety).

### Frontend (Vitest + Testing Library)

```bash
cd frontend && npm test
```

| Suite | Tests | Coverage |
|-------|-------|----------|
| `RestrictedKeyboard.test.jsx` | 14 | Rendering, badges, disabled states, key interactions |
| `MessageBubble.test.jsx` | 15 | Text, sender names, coin deltas, tier badges, layout |

Total: **29 tests**. jsdom environment, no Tailwind processing needed.
