'use strict';

/**
 * Futelo – grammY Bot
 * ───────────────────
 * Responsibilities:
 *   1. /start  → registers the user in SQLite → replies with Mini App button
 *   2. Gatekeeper → deletes every non-bot message sent directly in the group
 *   3. Mirror  → exposes broadcastToGroup() so the Socket.io server can
 *                forward validated Futelo messages as a read-only feed
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { Bot, InlineKeyboard } = require('grammy');
const { upsertUser }          = require('../db/database');

const BOT_TOKEN   = process.env.BOT_TOKEN;
const GROUP_ID    = process.env.GROUP_CHAT_ID;   // e.g. "-100123456789"
const APP_URL     = process.env.MINI_APP_URL;    // e.g. "https://futelo.xyz"

if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing from .env');

const bot = new Bot(BOT_TOKEN);

// ── /start ─────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const tgUser = ctx.from;

  // Register / update user in SQLite
  upsertUser({
    id:         tgUser.id,
    username:   tgUser.username   || '',
    first_name: tgUser.first_name || '',
    photo_url:  '',  // populated later via getUserProfilePhotos if needed
  });

  const keyboard = new InlineKeyboard().webApp('🎮 Open Futelo', APP_URL);

  await ctx.reply(
    `👋 Welcome to *Futelo*, ${tgUser.first_name || 'player'}!\n\n` +
    `Chat using your Letter inventory. Earn Coins, avoid spam penalties, ` +
    `and build your alphabet in the Shop.\n\n` +
    `Tap the button below to launch the app ⬇️`,
    { parse_mode: 'Markdown', reply_markup: keyboard }
  );
});

// ── Gatekeeper: delete non-bot messages in the group ──────────────────────
bot.on('message', async (ctx) => {
  const chatId = String(ctx.chat?.id);
  if (chatId !== String(GROUP_ID)) return;   // only apply to our group

  // Let the bot's own messages through
  if (ctx.from?.is_bot) return;

  try {
    await ctx.deleteMessage();
  } catch {
    // Message may already be gone – silently ignore
  }
});

// ── Mirror helper (called from Socket.io server) ───────────────────────────
/**
 * Post a validated Futelo message into the Telegram group as a
 * read-only feed entry.
 *
 * @param {{ username: string, first_name: string, text: string, coinDelta: number, tier: number }} payload
 */
async function broadcastToGroup(payload) {
  if (!GROUP_ID) return;

  const tierLabel = {
    1: '✅',
    2: '⚠️ Spam Warning',
    3: '🚫 Spam Penalty',
  }[payload.tier] || '';

  const displayName = payload.username
    ? `@${payload.username}`
    : payload.first_name;

  const coinStr =
    payload.coinDelta > 0 ? `+${payload.coinDelta}` : String(payload.coinDelta);

  const text =
    `💬 *${displayName}:* ${payload.text}\n` +
    `${tierLabel}  ${coinStr === '0' ? '' : `${coinStr} coins`}`.trim();

  try {
    await bot.api.sendMessage(GROUP_ID, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[Bot] broadcastToGroup error:', err.message);
  }
}

module.exports = { bot, broadcastToGroup };
