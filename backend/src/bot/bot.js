'use strict';

/**
 * Futelo – grammY Bot
 * ───────────────────
 * Responsibilities:
 *   1. /start  → registers the user + group in SQLite → replies with Mini App button
 *   2. Gatekeeper → deletes every non-bot message sent directly in any group
 *      that has the bot, so ALL chat happens inside the Futelo app.
 *
 * The bot NO LONGER mirrors or broadcasts messages back into Telegram.
 * Telegram groups are purely a hub: the bot deletes any message typed there
 * and redirects members to the app.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { Bot, InlineKeyboard } = require('grammy');
const { upsertUser, upsertRoom } = require('../db/database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL   = process.env.MINI_APP_URL;   // e.g. "https://futelo.xyz"

if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing from .env');

const bot = new Bot(BOT_TOKEN);

// ── /start ─────────────────────────────────────────────────────────────────
// Works in both private chats (DMs with the bot) and group chats.
// In a group the command registers the group as a room and shows a button
// that opens the Mini App (Telegram passes the group context automatically).
bot.command('start', async (ctx) => {
  const tgUser = ctx.from;
  const chat   = ctx.chat;

  // Register / update the user in SQLite
  upsertUser({
    id:         tgUser.id,
    username:   tgUser.username   || '',
    first_name: tgUser.first_name || '',
    photo_url:  '',
  });

  const isGroup = chat && (chat.type === 'group' || chat.type === 'supergroup');

  if (isGroup) {
    // Register the group as a Futelo room
    upsertRoom(chat.id, chat.title || '');

    const keyboard = new InlineKeyboard().webApp('🎮 Abrir Futelo', APP_URL);

    await ctx.reply(
      `👋 ¡Hola, *${tgUser.first_name || 'jugador'}*!\n\n` +
      `*Futelo* es un juego de chat con inventario de letras.\n` +
      `Escribe mensajes usando tu teclado de letras, gana Monedas y construye tu abecedario.\n\n` +
      `⚠️ *Los mensajes aquí serán borrados.* Toda la conversación ocurre dentro de la app.\n\n` +
      `Pulsa el botón para abrir la app ⬇️`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  } else {
    // DM with the bot — tell the user to open from a group
    await ctx.reply(
      `👋 ¡Hola, *${tgUser.first_name || 'jugador'}*!\n\n` +
      `Para jugar a *Futelo* añade el bot a un grupo y escribe */start* allí.\n` +
      `El bot creará una sala exclusiva para ese grupo y todos sus miembros podrán chatear en la app.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ── Gatekeeper: delete all non-bot messages in any group ──────────────────
// The app is the only place to chat — messages in the Telegram group itself
// are deleted immediately to keep the group clean and redirect users to the app.
bot.on('message', async (ctx) => {
  const chat = ctx.chat;
  if (!chat) return;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  if (!isGroup) return;

  // Let the bot's own messages through
  if (ctx.from?.is_bot) return;

  try {
    await ctx.deleteMessage();
  } catch {
    // Message may already be gone or bot lacks permission — silently ignore
  }
});

module.exports = { bot };

