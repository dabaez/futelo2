---
applyTo: "frontend/**"
---

# Futelo – Frontend Architecture

## Stack

React 18 + Vite 5 + Tailwind 3. ESM throughout (`import`/`export`).
Mobile-first; designed to run inside Telegram's WebApp container at full viewport height.

---

## Telegram WebApp SDK

Loaded via `<script>` in `index.html` before the React bundle.
Accessed as `window.Telegram.WebApp`. In `main.jsx`:

```js
window.Telegram.WebApp.expand();
window.Telegram.WebApp.disableVerticalSwipes?.();
```

`initData` = `window.Telegram?.WebApp?.initData || null`.

---

## State Flow

```
App.jsx
 ├── initData (useState)          ← null → DevUserPicker; set → chat
 ├── useAuth(initData)            ← user profile, coins, inventory, locks, pickaxeHits, chatId, allows_write_to_pm
 ├── useSocket(initData)          ← socket, connected, sendMessage()
 ├── ChatFeed                     ← chatId prop; reads socket for new_message events
 ├── PromptBanner                 ← prompt, promptReplies, replyMode, handleVote
 ├── RestrictedKeyboard           ← reads inventory + lockedLetters from user; onForgeOpen + unlockedEmojis props
 ├── ShopModal                    ← chatId prop; lootbox roll + P2P market + prompt + mines
 ├── BlackMarketModal             ← chatId prop; secret P2P market (triple-tap)
 ├── LotteryModal                 ← chatId prop; gambling round (auto-opens on new_lottery)
 ├── EmojiForgeModal              ← isOpen, onClose, initData, chatId, coins, inventory, socket, onPurchase, onEmojiInsert, currentDraft, emojiDefs
 ├── AchievementsModal            ← isOpen, onClose, initData, chatId
 ├── DevInfoModal                 ← isOpen, onClose, initData, userId
 └── LeaderboardModal             ← isOpen, onClose, initData, userId, chatId
```

**Triple-tap secret (black market):** `handleShopClick` in `App.jsx` uses
`shopClicksRef` (count) and `shopClickTimerRef` (timeout). Click 1 opens
`ShopModal` and starts a 1500 ms reset timer. If a 3rd click arrives within
that window, `ShopModal` closes and `BlackMarketModal` opens.

**Notifications toggle:** `handleNotificationsToggle` calls
`Telegram.WebApp.requestWriteAccess()`; on approval calls `POST /api/notifications/enable`
and sets `allows_write_to_pm` in state. The 🔕/🔔 bell in `Header.jsx` reflects this flag.
In dev mode (no TG SDK) the permission step is skipped.

**`updateUser(patch)`** (from `useAuth`) is the single function for applying
server-pushed state changes. Call it on `user_update` socket events and
shop/mine AJAX responses. Handles: `newCoins`, `newInventory`, `lockedLetter`,
`pickaxeHits`, `allows_write_to_pm`.

**`emojiDefs` / `emojiDefsRef`** — `App.jsx` fetches emoji definitions from
`/api/config` (field `EMOJI_DEFS: [{key, emoji, name}]`) and stores them in
both `useState` (`emojiDefs`, used as a prop) and `useRef` (`emojiDefsRef`,
used inside socket callbacks to avoid stale closures). The `EMOJI_MAP`
(key → emoji character) is derived on-the-fly from `emojiDefsRef.current`
whenever needed. `emojiDefs` is passed as a prop to `EmojiForgeModal` and
`CelebrationOverlay`.

**`useAuth`** also returns `chatId` from the auth response. `App.jsx` passes it
as a prop to `ChatFeed`, `ShopModal`, `BlackMarketModal`, and `LotteryModal`.

Socket events handled in `App.jsx`:
- `user_update` → `updateUser(patch)`
- `notification` → `showToast(text, type, { duration: 5000 })`
- `new_prompt` → sets `prompt` state, clears replies
- `new_prompt_reply` → appends to `promptReplies`
- `vote_update` → updates `voteCount` on matching reply
- `prompt_closed` → clears `prompt`, shows winner toast
- `prompt_error` → shows error in PromptBanner
- `new_lottery` / `lottery_bet_placed` / `lottery_closed`
- `emoji_complete` → updates `unlockedEmojis` state, shows forge result toast
- `achievement_unlocked` → shows achievement toast (one per achievement, 6 s)
- Beg messages arrive as `new_message` (system message with JSON `{type:"beg",...}` payload); rendered as amber cards by `MessageBubble`

**`devInfoOpen` / `leaderboardOpen`** — boolean state in `App.jsx`. `devInfoOpen` is set by `onDevInfoOpen` (passed as a prop to `Header`, triggered by clicking the "💬 Futelo" brand button). `leaderboardOpen` is set by `onLeaderboardOpen` (passed to `Header`, triggered by clicking the coin balance button). Both modals are rendered at the root of the app alongside the other modals.

---

## System Messages in ChatFeed

`MessageBubble.jsx` checks `message.userId === 0`. If true, renders a centered
rounded-pill in `text-tg-hint` colour instead of a normal bubble. System messages
are persisted and appear on feed hydration for all users including those offline
when the event occurred.

---

## ShopModal Tabs

5 tabs: 🎰 Caja (roll), 🛒 Comprar (buy), 💰 Vender (sell), 📣 Prompts, ⛏️ Minas (mine).

**Minas tab** — two sub-views:
- **No pickaxe** (`hitsLeft <= 0`): buy panel with info (hits per pickaxe, hit chance %).
- **Has pickaxe** (`hitsLeft > 0`): rock 🪨 tap interface.
  - `swingState`: `'idle'` | `'swinging'` | `'miss'` | `'found'`
  - `swingResult`: `null` | `{ letter }` — shown as a letter chip on find.
  - Hits counter displayed; secondary "buy more" button available.
  - Haptic `impactOccurred('medium')` on a find.
  - `onPurchase` called with `{ newInventory }` on find, `{ newCoins }` on pickaxe buy.

---

## Lootbox UI (Roll Tab)

`RARITY_META` object defines per-tier visual treatment:
- `bgClass`, `textClass`, `chipClass` — full Tailwind class strings (no interpolation).
- `stripBg`, `stripBorder`, `stripText`, `shortLabel` — used by roulette strip items.
- `animated` — enables `animate-bounce` on letter chips (staggered `animationDelay`).
- `pulse` — enables `animate-pulse` on result card backdrop (`épico`, `legendario`).
- `legendary` — shows extra sparkle row below letters.
- `celebrationEmoji` — emoji row shown above rarity label.

**Roulette strip**: 70-item horizontal strip, RAF-based `easeOutQuint` deceleration
over 4200 ms. Winner lands at `WINNER_IDX = 62`. Constants: `ITEM_W = 96`,
`ITEM_GAP = 8`, `ITEM_STRIDE = 104`, `STRIP_TOTAL = 70`. Built by
`buildSpinStrip(winnerRarity)` and stored in `spinStrip` state **before**
`setSpinPhase('spinning')` so the DOM is ready.

**Card reveal phase**: one face-down card per letter. Click to flip (550 ms CSS
`rotateY(180deg)` with `preserve-3d`). `handleFlipCard` / `handleRevealAll` wait
550 ms before transitioning to `'done'`. `onPurchase` called only at end of this
phase (stored in `onPurchaseRef` so the RAF callback can call it).

**State machine** — `spinPhase`: `'idle'` | `'spinning'` | `'cards'` | `'done'`.
`'done'` re-enables the roll button (`handleRoll` allows `'idle'` OR `'done'`).

**All-capped path**: `pendingResult.allCapped === true` → jumps directly to `'done'`
(no card phase). Shows `+N 🪙` with `animate-bounce`.

Haptic on strip land: `legendario` → `notificationOccurred('success')`;
`épico` → `impactOccurred('heavy')`; `raro` → `impactOccurred('medium')`.

`rollResult` shape: `{ letters: string[], rarity: string, coinBonus?: number, allCapped?: boolean }`
— **not a bare array**. Access letters via `rollResult.letters`.

---

## EmojiForgeModal

Two-tab bottom-sheet (`🧪 Forja` + `😊 Emojis`).

**`emojiDefs` prop** — array of `{ key, emoji, name }` objects fetched from `/api/config` and passed down from `App.jsx`. This is the single source of truth for which emojis exist; there is no hardcoded `ALL_EMOJIS` constant inside this component. `CelebrationOverlay` also receives `emojiDefs` as a prop.

**Hint persistence** — `GET /api/forge/status` returns a `hints` array. On modal open (`useEffect` on `isOpen`), the component calls the status endpoint and hydrates `setHints(data.hints || [])`. Hints purchased in previous sessions (stored in the `emoji_hints` DB table) are therefore restored automatically.

**Forja tab** — ingredient picker with 3 row groups: letter rows (A-Z + Ñ), symbol row (`SYMBOL_CHARS`), number row. Max 4 ingredients. Selected chips shown above. Actions:
- **Forjar**: calls `POST /api/forge/start`, disables ingredient picker while merge is running.
- **Completar** (instant): `POST /api/forge/instant` — pays per-second cost; enabled only during active merge.
- **Pista**: `POST /api/forge/hint` — shows hint toast; costs `HINT_COST` coins.
- Active merge countdown timer (re-rendered via `setInterval(1000)`).

**Emojis tab** — grid of all forgeable emojis (driven by `emojiDefs` prop). Unlocked items shown in full colour; locked items shown at reduced opacity with 🔒. Clicking an unlocked emoji calls `onEmojiInsert(emoji)` → appended to draft.

**`SYMBOL_CHARS`** in this file must stay in sync with `config.js` and `RestrictedKeyboard.jsx`. Current value: `'!?.,:-()@#&*;<>+~$%/^'` (22 chars).

`onPurchase` called with `{ newCoins }` after successful instant-complete or hint purchase.

---

## AchievementsModal

Bottom-sheet gallery of all achievements grouped by category. Each item shows: icon emoji, label, description, coin reward, and `✅` or `🔒` earned status.

Data comes from `GET /api/achievements` (returns all achievements with `earned: true/false`). Fetched on modal open (`useEffect` on `isOpen`).

---

## DevInfoModal

Bottom-sheet opened by tapping the **"💬 Futelo"** brand in `Header.jsx` (`onDevInfoOpen` prop). Three tabs:

- **📋 Parches** — reads `PATCH_NOTES` from `GET /api/devinfo/config`.
- **💡 Ideas** — lists open feature requests from `GET /api/devinfo/requests`; vote button `POST /api/devinfo/vote/:id`; submission textarea `POST /api/devinfo/request`.
- **✅ Hechas** — completed (`done=1`) requests from the same endpoint.

Admin users (whose `userId` appears in `adminUserIds` returned by `/api/devinfo/config`) see extra action buttons per card:
- **✓ Listo / ↩ Reabrir** — `PATCH /api/devinfo/request/:id` with `{ done: 0|1 }`.
- **🗑 Borrar** — `DELETE /api/devinfo/request/:id` (votes are cascade-deleted by the backend transaction).

`RequestCard` sub-component receives `{ request, isAdmin, onVote, onToggleDone, onDelete, done }` props.

---

## LeaderboardModal

Bottom-sheet opened by tapping the **coin balance** in `Header.jsx` (`onLeaderboardOpen` prop). Fetches `GET /api/leaderboard?roomId=X` on open. Three tabs:

- **🔤 Letras** — total inventory levels per player; `score` field shown as `"X niv."`.
- **🪙 Monedas** — ranking by coins but **the coin amount is never returned or shown** (privacy). Only rank + name displayed.
- **💬 Mensajes** — message count per player; `score` field shown as is.

Top 3 entries display medal emojis 🥇🥈🥉. Current user row highlighted with `bg-tg-button/15 ring-1 ring-tg-button/30`.

---

## AchievementsModal

Bottom-sheet gallery of all achievements grouped by category. Each item shows: icon emoji, label, description, coin reward, and `✅` or `🔒` earned status.

Data comes from `GET /api/achievements` (returns all achievements with `earned: true/false`). Fetched on modal open (`useEffect` on `isOpen`).

---

## RestrictedKeyboard Key Logic

4 rows:
```
Row 0: Q W E R T Y U I O P
Row 1:  A S D F G H J K L
Row 2: Z X C V B N M Ñ  ⌫
Row 3: [⇧]  [123]  [space]  [↵]
```

**Caps/shift toggle (`⇧`):** `MODE_CAPS = '⇧'` sentinel. Boolean `caps` state toggled
on each `⇧` press. When `caps=true`, keys append `.toUpperCase()`. Inventory checked
against the **lowercase** key — `countDraftChars` normalises via `.toLowerCase()`.
`⇧` button styled `bg-tg-button` when active, `bg-gray-400` when inactive.

For every letter key `L`:
```
remaining = (inventory[L] ?? 0) - draftCount[L]
disabled  = remaining <= 0  OR  lockedLetters.includes(L)
```

Badge shows `remaining`. Keys disabled via `onPointerDown` suppression (not HTML `disabled`).

**aria-label convention** (critical for tests):
- Available: `"a"` (lowercase letter)
- No stock: `"a (no stock)"`
- Locked: `"a locked"`
- Shift: `"⇧"`
- Special: `"⌫"`, `"␣"`, `"↵"`

---

## Tailwind Theme

CSS variables auto-adapt to the user's Telegram theme. All colour classes prefixed `tg-`:

| Class | Variable | Default |
|---|---|---|
| `bg-tg-bg` | `--tg-theme-bg-color` | #ffffff |
| `bg-tg-bg-sec` | `--tg-theme-secondary-bg-color` | #f0f0f0 |
| `text-tg-text` | `--tg-theme-text-color` | #000000 |
| `text-tg-hint` | `--tg-theme-hint-color` | #999999 |
| `bg-tg-button` | `--tg-theme-button-color` | #2481cc |
| `text-tg-btn-text` | `--tg-theme-button-text-color` | #ffffff |

**Never hardcode hex values.** Use `tg-*` classes so dark-mode works automatically.
Never use dynamic Tailwind class interpolation — the purger won't detect it.

---

## Dev Mode (Frontend)

When `window.Telegram?.WebApp?.initData` is falsy, `App.jsx` renders `<DevUserPicker>`
instead of the chat UI. Picker generates `dev:USER_ID:username:First Name:CHAT_ID:Chat Title`
tokens. Preset users (Alice, Bob, Carol, Dave, Eve) share Dev Room (`-1001001`).
Custom form includes Chat ID + Chat Title fields for multi-room simulation.
An amber banner is shown in chat with a "**cambiar**" link to reset back to the picker.

---

## Testing – Frontend (Vitest + Testing Library)

- Config: `test:` block in `frontend/vite.config.js` (`environment: 'jsdom'`)
- Run: `cd frontend && npm test`
- **55 tests across 2 suites** (all passing)

| File | Tests | What it covers |
|---|---|---|
| `src/__tests__/RestrictedKeyboard.test.jsx` | 28 | Rendering, badges, disabled states, pointer interactions, caps/shift toggle; all 22 symbol chars in symbol mode; ⌫ position stability across modes |
| `src/__tests__/MessageBubble.test.jsx` | 27 | Text, sender names, coin delta badges, tier labels, layout, miso-soup replacement, system pill, beg card + socket interaction |

**Key patterns:**
- Query keys by exact aria-label (`'a'`, `'a (no stock)'`, `'a locked'`) — not uppercase regex.
- `fireEvent.pointerDown` (not `click`) to match `onPointerDown` handlers.
- MessageBubble tier label matchers in Spanish: `/aviso de spam/i` (Tier 2), `/penalizaci/i` (Tier 3).
