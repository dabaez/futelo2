# Futelo — Telegram Mini App

> A letter-economy chat game. Every character costs inventory. Every message has a coin consequence.
>
> **UI language: Spanish.** All user-facing text is in Spanish.

---

## Project Structure

```
futelo/
├── agents.md             AI agent context (read before making changes)
├── README.md
├── deploy.sh             One-shot deployment script
├── backend/              Node.js server
├── frontend/             React + Vite + Tailwind SPA
├── nginx/                Production reverse-proxy config
└── data/                 SQLite files (auto-created, gitignored)
```

---

## Quick Start (Local Dev)

### 1. Backend

```bash
cd backend
cp .env.example .env
# Minimum required for dev: set DEV_MODE=true (no bot token needed)
npm install
npm run dev
```

### 2. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in a browser.

### Testing Without Telegram

When `DEV_MODE=true` and you open the app in a plain browser, a **Dev User Picker** screen appears. Pick a user to log in without a Telegram account. Open a second tab and pick a different user to simulate two players chatting.

> ⚠️  Never set `DEV_MODE=true` in production — it completely bypasses Telegram authentication.

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

| Tier | Condición | Monedas | Efecto extra |
|------|-----------|---------|--------------|
| 1 | Diferente usuario habló último | **+10** | — |
| 2 | Propio mensaje, racha = 2 | **0** | Aviso de spam |
| 3 | Propio mensaje, racha ≥ 3 | **−50** | 1 letra del inventario **bloqueada 5 min** |

**Las letras son niveles de desbloqueo** (no se consumen). `inventory["a"] = 3` significa que puedes usar hasta 3 `a`s por mensaje. Los tiers **nunca** otorgan letras — las letras solo se obtienen con el bono de primer mensaje (26 aleatorias) o comprando tiradas en la Tienda.

### Shop

| Item | Coste | Efecto |
|------|-------|--------|
| Tirada de letras | 50 🪙 | Desbloquea 3 letras aleatorias (+1 nivel cada una) |
| Lanzar un prompt | 200 🪙 | Inicia un prompt comunitario inmediatamente |
| Vender letra (mercado normal) | — | Recibe monedas instantáneamente, sin riesgo |
| Vender letra (mercado negro) | — | Recibe más monedas sin comisión, pero con riesgo de multa |

### Letter Market

**Mercado normal** — instant, no risk: earn a fixed amount immediately.

**Mercado negro** — deferred, risky:
- The letter level is escrowed and listed.
- Earn more coins (no commission) if you collect before being caught.
- The server periodically checks active listings against a catch probability driven by the global **heat level**. Getting caught incurs a coin fine and raises heat further.
- Mentioning "mercado negro" in chat also raises heat.
- Uncollected listings expire after a set time; the letter is returned, no coins awarded.

### Community Prompts

A timed Q&A round that runs inside the chat.

- Triggered automatically after a long period of inactivity, or bought from the shop.
- Any player can reply. Others vote with ❤️.
- When the timer expires, coins are distributed to the top-voted replies.
- Only one prompt runs at a time.

---

## Tests

```bash
cd backend && npm test   # Jest + supertest
cd frontend && npm test  # Vitest + Testing Library
```
