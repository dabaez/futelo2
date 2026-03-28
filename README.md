# Futelo — Telegram Mini App

> A letter-economy chat game. Every character costs inventory. Every message has a coin consequence.
>
> **UI language: Spanish.** All user-facing text is in Spanish.

---

## Project Structure

```
futelo/
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

---

## Environment Variables

### `backend/.env`

| Variable | Required | Description |
|---|---|---|
| `DEV_MODE` | dev only | Set `true` to skip Telegram auth entirely. Accepts `dev:USER_ID:username:First Name` tokens. **Never `true` in production.** |
| `SERVER_PORT` | yes | Port the Express server listens on. Default: `3001`. |
| `BOT_TOKEN` | prod only | Telegram bot token from [@BotFather](https://t.me/BotFather). Not needed when `DEV_MODE=true`. |
| `BOT_TOKEN_HASH` | prod only | Pre-computed HMAC key used to validate Telegram WebApp `initData`. Set to the same value as `BOT_TOKEN` — the server derives the key itself. Leave blank to have it computed automatically. |
| `BOT_MODE` | prod | `polling` (default, good for local) or `webhook` (required in production). |
| `WEBHOOK_DOMAIN` | prod, webhook | Full HTTPS URL of your server, e.g. `https://your-domain.com`. Used to register the webhook with Telegram. |
| `MINI_APP_URL` | prod | URL where the frontend is served, e.g. `https://your-domain.com`. Shown in the `/start` group reply button. |
| `MINI_APP_DIRECT_LINK` | prod | Direct Mini App deeplink from BotFather (format: `https://t.me/your_bot/your_app`). Without this the `/start` button opens a plain URL with no Telegram context. |
| `DOMAIN` | prod | Bare domain name, e.g. `your-domain.com`. Used by deploy scripts and Nginx config. |
| `NOTIFY_CHANNEL_ID` | optional | Telegram channel ID where game notifications are posted. The bot must be an admin. Leave empty to disable. |

**Minimal dev setup** — only two variables are needed:

```env
DEV_MODE=true
SERVER_PORT=3001
```

**Minimal production setup:**

```env
DEV_MODE=false
SERVER_PORT=3001
BOT_TOKEN=123456:ABC-your-token
BOT_MODE=webhook
WEBHOOK_DOMAIN=https://your-domain.com
MINI_APP_URL=https://your-domain.com
MINI_APP_DIRECT_LINK=https://t.me/your_bot_username/your_app_name
DOMAIN=your-domain.com
```

---

### `frontend/.env`

| Variable | Required | Description |
|---|---|---|
| `VITE_BACKEND_URL` | prod only | Full URL of the backend API, e.g. `https://your-domain.com`. Leave **empty** in local dev — Vite proxies `/api` and `/socket.io` to `localhost:3001` automatically. |

**Local dev** — leave the file empty (or omit it entirely):

```env
VITE_BACKEND_URL=
```

**Production:**

```env
VITE_BACKEND_URL=https://your-domain.com
```

---

### Testing Without Telegram

When `DEV_MODE=true` and you open the app in a plain browser, a **Dev User Picker** screen appears. Preset users (Alice, Bob, etc.) all share a default **Dev Room** (`-1001`). Open a second tab and pick a different user to simulate two players chatting.

The custom user form also accepts a **Chat ID** and **Chat Title** to test multi-room isolation — enter different chat IDs to put users in separate rooms.

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
3. Add the bot to **any Telegram group** as **Admin** with "Delete messages" permission. Each group automatically gets its own isolated room — prompts, market listings, lottery rounds, and chat streaks are all per-group.
4. Set `BOT_MODE=webhook` and `WEBHOOK_DOMAIN=https://your-domain.com` in `.env`.

> `GROUP_CHAT_ID` is **not required**. The bot handles all groups it is a member of automatically.

---

## Game Rules

### Coin Tiers

| Tier | Condición | Monedas | Efecto extra |
|------|-----------|---------|--------------|
| 1 | Diferente usuario habló último | **+10** | — |
| 2 | Propio mensaje, racha = 2 | **0** | Aviso de spam |
| 3 | Propio mensaje, racha ≥ 3 | **−50** | 1 letra del inventario **bloqueada 5 min** |

**Las letras son niveles de desbloqueo** (no se consumen). `inventory["a"] = 3` significa que puedes usar hasta 3 `a`s por mensaje. Los tiers **nunca** otorgan letras — las letras solo se obtienen con el bono de primer mensaje (26 aleatorias) o comprando cajas en la Tienda.

### Shop (Tienda)

| Item | Coste | Efecto |
|------|-------|--------|
| Abrir caja | 50 🪙 base + 2 🪙 × niveles totales | Obtén letras según rareza del resultado |
| Lanzar un prompt | configurable 🪙 | Inicia un prompt comunitario inmediatamente |
| Vender letra (mercado normal) | — | Lista la letra; comprador paga; 20% comisión |
| Vender letra (mercado negro) | — | Sin comisión, pero con riesgo de multa |
| Pico (minas) | 150 🪙 base + 2 🪙 × niveles totales | Obtén 1000 golpes para usar en las minas |

#### Cajas — Rareza del resultado

| Rareza | Letras ganadas | Probabilidad |
|--------|---------------|--------------|
| 📦 Común | 3 | ~40% |
| ✨ Bueno | 5 | ~35% |
| ⭐ Raro | 7 | ~18% |
| 💫 Épico | 11 | ~6% |
| 🏆 Legendario | 16 | ~1% |

Media de letras por tirada: **~5**.

Las raridades más altas muestran animaciones, efectos y haptics en la UI de Telegram.

#### Inventario al límite (nivel cap)

Cuando **todas** las letras del inventario están al máximo (`MAX_LETTER_LEVEL = 6`), el servidor:
- **Anula el coste** de la tirada.
- **Otorga monedas** en su lugar (`CAP_OVERFLOW_COINS_PER_LETTER` × letras del tier).

Esto aplica también a las minas (swing con inventario lleno → monedas) y a la lotería (niveles desbordados → monedas). Los niveles de bono **nunca** se desperdician en silencio.

#### Animación de apertura

Al abrir una caja, la interfaz muestra:
1. Una **tira de ruleta** horizontal que decelera hasta la rareza ganada.
2. Cartas boca abajo — una por letra ganada — que el jugador toca para revelarlas.

Si el inventario está lleno, las fases de cartas se omiten y se muestra directamente el bonus de monedas.

### Letter Market

**Mercado normal** — 20% comisión quemada en cada venta. El vendedor recibe el 80% del precio. Las notificaciones de venta se persisten en la DB, así que los vendedores offline las ven al reconectarse.

**Mercado negro** — sin comisión, con riesgo:
- El nivel de letra queda en escrow mientras está listado.
- Algo vigila. Si te atrapan, recibes una multa. Hablar de ello empeora las cosas.
- Los listados no duran para siempre.
- Acceso: triple-toca el botón de la tienda en menos de 1.5 s.

### Community Prompts

Una ronda de preguntas y respuestas con temporizador.

- Se activa automáticamente tras un período de inactividad, o se compra en la tienda.
- Cualquier jugador puede responder; los demás votan con ❤️.
- Al expirar el tiempo, las monedas se distribuyen a las respuestas más votadas.
- Solo un prompt activo a la vez.
- Al cerrarse, se publica un **mensaje del sistema** en el feed indicando el ganador.

### Letter Gambling (Lotería)

Un mini-juego de apuestas periódico:

- Alguien inicia la ronda gastando monedas.
- Los jugadores apuestan letras de su inventario como predicción de la letra secreta.
- La 2ª apuesta en adelante tiene una probabilidad de error escalante (1 − 0.5^k).
- Al cerrarse la ronda se revela la letra secreta.
- Los acertantes reciben +2 niveles de la letra ganada más monedas del bote.
- Si nadie acierta, las letras se convierten en monedas y el bote se acumula.
- Al cerrarse, se publica un **mensaje del sistema** en el feed con el resultado.

### Minas de Letras

Un mini-juego de exploración individual:

- Compra un pico en la tienda por 150 🪙 base + 2 🪙 por cada nivel de inventario que ya tengas (mismo escalado que las cajas). Otorga 1000 golpes.
- Toca la roca en la pestaña ⛏️ Minas para gastar un golpe.
- Cada golpe tiene un **1% de probabilidad** de encontrar una letra aleatoria (+1 nivel en el inventario, máx. 6). De media, ~1 hallazgo cada 100 golpes.
- Si el inventario ya está completo, el golpe otorga monedas en lugar de una letra.
- Los picos se acumulan — puedes comprar varios seguidos.
- Es una actividad en solitario; no se emiten eventos a otros jugadores.

### System Messages

Después de cerrar prompts y rondas de lotería, el servidor publica un mensaje de sistema (`userId = 0`) visible para todos, incluidos los jugadores que estaban offline (los mensajes se persisten en la DB y se muestran en el feed como pills centradas).

El mensaje de **pedir ayuda** ("🙏 Pedir ayuda" en la tienda cuando el jugador no tiene letras ni monedas) también se publica como mensaje de sistema persistente con un payload JSON `{type:"beg", ...}`. El feed lo renderiza como una tarjeta ámbar con un botón **Dar 10 🪙** — así todos los jugadores, incluyendo los que se conecten después, pueden donar.

### Emoji Forge

Un taller de creación de emojis:

- Abre la interfaz desde el botón 🧪 en el teclado.
- Elige entre 2 y 6 caracteres del inventario como "ingredientes".
- El nivel de cada ingrediente queda reservado durante 1 hora mientras la mezcla está activa.
- Si la combinación coincide con una receta conocida, el emoji queda **desbloqueado permanentemente** y usable en cualquier sala.
- Si no hay receta, los niveles se devuelven (+1 por ingrediente, máx. `MAX_LETTER_LEVEL`).
- **Completar al instante**: paga `ceil(segundos_restantes × 0.02) 🪙`.
- **Pista**: compra una pista críptica por 20 🪙 sobre un emoji que aún no tienes.
- Una vez desbloqueado, el emoji aparece en la barra rápida del teclado para insertarlo con un toque.
- Solo una mezcla activa a la vez (global, no por sala).

### Achievements (Logros)

Sistema de logros que recompensa hitos del juego con monedas.

- 50+ logros distribuidos en categorías: Mensajes, Teclado, Tienda, Mercado, Mina, Apuestas, Emojis, Community.
- Se otorgan automáticamente cuando se cumple la condición (tras cada acción relevante).
- El premio se acredita en la sala donde ocurrió el evento.
- Los logros ya ganados no se repiten.
- Ver el panel de logros desde el icono 🏅 en el header.

### Notifications

Las alertas por usuario (p.ej. "tu letra se vendió") se **persisten en la DB**. Si estás offline cuando tu listado se vende, el toast queda en cola y se muestra la próxima vez que te conectes.

---

## Tests

```bash
cd backend && npm test   # Jest + supertest  (280 tests, 10 suites)
cd frontend && npm test  # Vitest + Testing Library  (55 tests, 2 suites)
```

### Backend test suites

| Suite | Tests | What it covers |
|-------|-------|---------------|
| `auth.test.js` | 18 | Telegram HMAC + dev-token validation |
| `engine.test.js` | 34 | `letterRequirements`, all tiers, first-message bonus (cap-ceiling), coin floor, `shopRoll` (allCapped path, steering to uncapped) |
| `market.test.js` | 27 | Regular and black-market list/buy/cancel, commission, `bmBuyListing` |
| `blackMarket.test.js` | 16 | Heat decay, `catchProbability`, `runCatchCheck`, expiry |
| `mining.test.js` | 18 | `buyPickaxe` (scaled cost), `swing`, hit/miss probability, all-caps coin fallback |
| `prompt.test.js` | 21 | `buyPrompt`, `submitReply`, `castVote`, `closePrompt` with all edge cases |
| `lottery.test.js` | 14 | `startLottery`, `placeBet`, `closeLottery`, `getActiveLottery`, cap overflow coins |
| `api.test.js` | 64 | All REST endpoints end-to-end with a real SQLite DB; includes regression for `my-listings` open-only filter |
| `emojiForge.test.js` | 27 | `inventoryKey`, `matchRecipe`, `startMerge` (validation + deduction), `instantComplete`, `buyHint`, `getStatus` |
| `achievements.test.js` | 40 | `checkAchievements` – all event types, already-earned guard, multi-award transaction, stat counter updates |

### Frontend test suites

| Suite | Tests | What it covers |
|-------|-------|---------------|
| `RestrictedKeyboard.test.jsx` | 28 | Rendering, badges, disabled states, pointer interactions, caps/shift toggle, all 22 symbol keys, ⌫ position stability across modes |
| `MessageBubble.test.jsx` | 27 | Text, sender names, coin delta badges, tier labels, layout, miso-soup replacement, system pill, beg card + socket interaction |
