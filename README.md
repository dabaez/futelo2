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

**Las letras son niveles de desbloqueo** (no se consumen). `inventory["a"] = 3` significa que puedes usar hasta 3 `a`s por mensaje. Los tiers **nunca** otorgan letras — las letras solo se obtienen con el bono de primer mensaje (26 aleatorias) o comprando cajas en la Tienda.

### Shop (Tienda)

| Item | Coste | Efecto |
|------|-------|--------|
| Abrir caja | 50 🪙 base + 2 🪙 × niveles totales | Obtén letras según rareza del resultado |
| Lanzar un prompt | configurable 🪙 | Inicia un prompt comunitario inmediatamente |
| Vender letra (mercado normal) | — | Lista la letra; comprador paga; 20% comisión |
| Vender letra (mercado negro) | — | Sin comisión, pero con riesgo de multa |
| Pico (minas) | 30 🪙 | Obtén 10 golpes para usar en las minas |

#### Cajas — Rareza del resultado

| Rareza | Letras ganadas | Probabilidad |
|--------|---------------|--------------|
| 📦 Común | 1 | ~40% |
| ✨ Bueno | 3 | ~35% |
| ⭐ Raro | 5 | ~18% |
| 💫 Épico | 8 | ~6% |
| 🏆 Legendario | 12 | ~1% |

Las raridades más altas muestran animaciones, efectos y haptics en la UI de Telegram.

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

- Compra un pico en la tienda por 30 🪙 (otorga 10 golpes).
- Toca la roca en la pestaña ⛏️ Minas para gastar un golpe.
- Cada golpe tiene un 40% de probabilidad de encontrar una letra aleatoria (+1 nivel en el inventario, máx. 6).
- Los picos se acumulan — puedes comprar varios seguidos.
- Es una actividad en solitario; no se emiten eventos a otros jugadores.

### System Messages

Después de cerrar prompts y rondas de lotería, el servidor publica un mensaje de sistema (`userId = 0`) visible para todos, incluidos los jugadores que estaban offline (los mensajes se persisten en la DB y se muestran en el feed como pills centradas).

### Notifications

Las alertas por usuario (p.ej. "tu letra se vendió") se **persisten en la DB**. Si estás offline cuando tu listado se vende, el toast queda en cola y se muestra la próxima vez que te conectes.

---

## Tests

```bash
cd backend && npm test   # Jest + supertest  (118 tests, 5 suites)
cd frontend && npm test  # Vitest + Testing Library  (35 tests, 2 suites)
```
