'use strict';

/**
 * Futelo – grammY Bot
 * ───────────────────
 * Responsibilities:
 *   1. /start        → registers the user + group in SQLite → replies with Mini App button
 *   2. /gatekeeper   → toggles message deletion on/off for that specific group
 *                      (only group admins can use it; bot must be admin with delete permission)
 *
 * Default behaviour: the Telegram group chat is left untouched — Futelo runs
 * as a parallel chat alongside the normal group conversation.
 * Run /gatekeeper in a group to enable deletion for that group only.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { Bot, InlineKeyboard } = require('grammy');
const { upsertUser, upsertRoom, stmts, setRoomGatekeeper } = require('../db/database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL   = process.env.MINI_APP_URL;   // e.g. "https://futelo.xyz"

if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing from .env');

const bot = new Bot(BOT_TOKEN);

// ── Permission cache ────────────────────────────────────────────────────────
// Stores whether the bot has delete-message permission per chat.
// Values: true (can delete) | false (cannot) | undefined (not yet checked).
const canDeleteCache = new Map();

/**
 * Returns true if the bot has `can_delete_messages` in the given group.
 * Result is cached per chatId for the lifetime of the process.
 */
async function checkDeletePermission(chatId) {
  if (canDeleteCache.has(chatId)) return canDeleteCache.get(chatId);
  try {
    // bot.botInfo is populated after bot.init() / bot.start(); fall back to getMe() if needed
    const botId  = bot.botInfo?.id ?? (await bot.api.getMe()).id;
    const member = await bot.api.getChatMember(chatId, botId);
    const ok     = member.status === 'administrator' && member.can_delete_messages === true;
    canDeleteCache.set(chatId, ok);
    return ok;
  } catch {
    canDeleteCache.set(chatId, false);
    return false;
  }
}

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

    // Check gatekeeper permission and build an optional note line
    let gatekeeperNote = '';
    const room = stmts.getRoomById.get(chat.id);
    if (room?.gatekeeper) {
      const canDelete = await checkDeletePermission(chat.id);
      gatekeeperNote = canDelete
        ? '\n🗑️ _Modo guardián activo: los mensajes del grupo serán borrados._\n'
        : '\n⚠️ _Modo guardián activado pero el bot no tiene permisos para borrar mensajes. Usa /gatekeeper para desactivarlo o házlo administrador con «Eliminar mensajes»._\n';
    }

    await ctx.reply(
      `👋 ¡Hola, *${tgUser.first_name || 'jugador'}*!\n\n` +
      `*Futelo* es un juego de chat con inventario de letras.\n` +
      `Escribe mensajes usando tu teclado de letras, gana Monedas y construye tu abecedario.\n` +
      gatekeeperNote +
      `\nPulsa el botón para abrir la app ⬇️`,
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



// ── /gatekeeper ────────────────────────────────────────────────────────────
// Toggles message deletion for this specific group.
// Only group admins can use it. Checks bot permissions when enabling.
bot.command('gatekeeper', async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    await ctx.reply('Este comando solo funciona en grupos.');
    return;
  }

  // Only allow group admins to toggle this
  const member = await ctx.getChatMember(ctx.from.id);
  const isAdmin = member.status === 'administrator' || member.status === 'creator';
  if (!isAdmin) {
    await ctx.reply('⛔ Solo los administradores del grupo pueden cambiar esta opción.');
    return;
  }

  const room       = stmts.getRoomById.get(chat.id);
  const wasEnabled = room?.gatekeeper === 1;
  const nowEnabled = !wasEnabled;

  if (nowEnabled) {
    const canDelete = await checkDeletePermission(chat.id);
    if (!canDelete) {
      await ctx.reply(
        '⚠️ No puedo activar el modo guardián porque no tengo permiso para borrar mensajes.\n' +
        'Házme administrador con «Eliminar mensajes» e inténtalo de nuevo.',
        { parse_mode: 'Markdown' }
      );
      return;
    }
  }

  setRoomGatekeeper(chat.id, nowEnabled);
  // Invalidate cached permission so it's re-checked on next use
  canDeleteCache.delete(chat.id);

  await ctx.reply(
    nowEnabled
      ? '🗑️ *Modo guardián activado.* Los mensajes de Telegram serán borrados; la conversación ocurre en la app.'
      : '✅ *Modo guardián desactivado.* Los mensajes de Telegram ya no serán borrados.',
    { parse_mode: 'Markdown' }
  );
});

// ── Gatekeeper message handler ─────────────────────────────────────────────
// Deletes non-bot messages only in groups where gatekeeper is enabled.
bot.on('message', async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
  if (ctx.from?.is_bot) return;

  const room = stmts.getRoomById.get(chat.id);
  if (!room?.gatekeeper) return;

  const canDelete = await checkDeletePermission(chat.id);
  if (!canDelete) {
    // Permission was revoked after enabling — notify once and auto-disable
    canDeleteCache.delete(chat.id);
    setRoomGatekeeper(chat.id, false);
    await ctx.reply(
      '⚠️ Ya no tengo permiso para borrar mensajes, así que he desactivado el modo guardián automáticamente.\n' +
      'Usa /gatekeeper para volver a activarlo una vez que me hayas dado los permisos necesarios.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  try {
    await ctx.deleteMessage();
  } catch {
    // Message may already be gone — silently ignore
  }
});

module.exports = { bot };

