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

const BOT_TOKEN  = process.env.BOT_TOKEN;
const APP_URL    = process.env.MINI_APP_URL;
const DIRECT_LINK = process.env.MINI_APP_DIRECT_LINK;

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
    // For administrators, can_delete_messages is either true or undefined (full rights).
    // It is only explicitly false when the admin was granted restricted permissions.
    const ok = member.status === 'administrator' && member.can_delete_messages !== false;
    canDeleteCache.set(chatId, ok);
    return ok;
  } catch (err) {
    // Don't cache on error — transient API failures shouldn't permanently block the feature
    console.warn(`[Bot] checkDeletePermission(${chatId}): ${err.message}`);
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

    // Build the button URL.
    // If MINI_APP_DIRECT_LINK (t.me/botname/appname) is configured, append
    // ?startapp=chatId so the Mini App receives the room ID as start_param
    // and initData is fully populated by the WebApp SDK.
    // Without it we fall back to a plain URL (no initData — dev/fallback only).
    const buttonUrl = DIRECT_LINK
      ? `${DIRECT_LINK}?startapp=${chat.id}`
      : APP_URL;
    const keyboard = new InlineKeyboard().url('🎮 Abrir Futelo', buttonUrl);

    // Check gatekeeper permission and build an optional note line
    let gatekeeperNote = '';
    const room = stmts.getRoomById.get(chat.id);
    if (room?.gatekeeper) {
      const canDelete = await checkDeletePermission(chat.id);
      gatekeeperNote = canDelete
        ? '\n🗑️ _Modo guardián activo: los mensajes del grupo serán borrados._\n'
        : '\n⚠️ _Modo guardián activado pero el bot no tiene permisos para borrar mensajes. Usa /gatekeeper para desactivarlo o házlo administrador con «Eliminar mensajes»._\n';
    }

    const sent = await ctx.reply(
      `👋 ¡Hola, *${tgUser.first_name || 'jugador'}*!\n\n` +
      `*Futelo* es un juego de chat con inventario de letras.\n` +
      `Escribe mensajes usando tu teclado de letras, gana Monedas y construye tu abecedario.\n` +
      gatekeeperNote +
      `\nPulsa el botón para abrir la app ⬇️`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    try {
      await bot.api.pinChatMessage(chat.id, sent.message_id, { disable_notification: true });
    } catch {
      // No pin permission — silently ignore
    }
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



// ── /help ──────────────────────────────────────────────────────────────────
bot.command('help', async (ctx) => {
  const isGroup = ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');
  await ctx.reply(
    `🎮 *Futelo — Guía rápida*\n\n` +
    `*¿Cómo jugar?*\n` +
    `Abre la app con el botón de abajo y escribe mensajes usando el teclado de letras. Cada letra tiene un nivel de inventario — ese nivel es el máximo de veces que puedes usar esa letra en un solo mensaje.\n\n` +
    `*Monedas Anti-Spam*\n` +
    `• +10 🪙 si eres el primero en responder después de otro jugador\n` +
    `• 0 🪙 si repites turno (aviso)\n` +
    `• −50 🪙 y una letra bloqueada si repites turno tres veces seguidas\n\n` +
    `*¿Cómo consigo más letras?*\n` +
    `• 🎰 *Caja* — gasta monedas para abrir una caja con letras\n` +
    `• ⛏️ *Minas* — compra un pico y toca la roca para excavar letras\n` +
    `• 🛒 *Mercado* — compra letras a otros jugadores\n\n` +
    `*Funciones extra*\n` +
    `• 📣 *Prompts* — lanza una pregunta al grupo y vota la mejor respuesta\n` +
    `• 🎲 *Lotería* — apuesta letras a la letra secreta del round\n` +
    `• 🕵️ *Mercado Negro* — accede dando tres toques al botón de la tienda (sin comisión, con riesgo)\n\n` +
    (isGroup ? `*Comandos de admin*\n` +
    `• /gatekeeper — borra mensajes de Telegram y fuerza el chat a la app\n` +
    `• /setthread — espeja mensajes de la app en un hilo de Telegram\n` : '') +
    `\nPulsa */start* para abrir la app. ¡Buena suerte! 🍀`,
    { parse_mode: 'Markdown' }
  );
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
  // Also sync thread-delete so gatekeeper controls both surfaces
  stmts.setNotifyThreadDelete.run(nowEnabled ? 1 : 0, chat.id);
  // Invalidate cached permission so it's re-checked on next use
  canDeleteCache.delete(chat.id);

  const room2 = stmts.getRoomById.get(chat.id);
  const threadNote = nowEnabled && room2?.notify_thread_id !== null && room2?.notify_thread_id !== undefined
    ? '\n_Los mensajes de usuarios en el hilo de espejo también serán eliminados._'
    : '';

  await ctx.reply(
    nowEnabled
      ? `🗑️ *Modo guardián activado.* Los mensajes de Telegram serán borrados; la conversación ocurre en la app.${threadNote}`
      : '✅ *Modo guardián desactivado.* Los mensajes de Telegram ya no serán borrados.',
    { parse_mode: 'Markdown' }
  );
});

// ── /setthread ─────────────────────────────────────────────────────────────
// Run this command from inside the thread (or main chat) you want Futelo to
// mirror messages into. Pass "off" to disable mirroring.
// Only group admins can use it.
bot.command('setthread', async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    await ctx.reply('Este comando solo funciona en grupos.');
    return;
  }

  const member  = await ctx.getChatMember(ctx.from.id);
  const isAdmin = member.status === 'administrator' || member.status === 'creator';
  if (!isAdmin) {
    await ctx.reply('\u26d4 Solo los administradores pueden configurar el hilo de notificaciones.');
    return;
  }

  const arg = ctx.match?.trim().toLowerCase();
  if (arg === 'off') {
    stmts.setNotifyThread.run(null, chat.id);
    await ctx.reply(
      '\u2705 *Espejo de mensajes desactivado.*\n' +
      'Futelo ya no publicar\u00e1 mensajes en ning\u00fan hilo de este grupo.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Use the thread id of the current message (undefined in main chat → 0)
  const threadId = ctx.message?.message_thread_id ?? 0;
  stmts.setNotifyThread.run(threadId, chat.id);

  const where = threadId > 0 ? `hilo #${threadId}` : 'chat principal';
  await ctx.reply(
    `\u2705 *Espejo de mensajes activado.*\n` +
    `Futelo publicar\u00e1 un resumen de cada mensaje en el ${where}.\n\n` +
    `Para que los usuarios no puedan responder en ese hilo activa el modo guardi\u00e1n con */gatekeeper*.`,
    { parse_mode: 'Markdown' }
  );
});



// ── Gatekeeper + per-room thread delete message handler ──────────────────
bot.on('message', async (ctx) => {
  const chat = ctx.chat;
  if (!chat) return;
  if (ctx.from?.is_bot) return;

  if (chat.type !== 'group' && chat.type !== 'supergroup') return;

  const room = stmts.getRoomById.get(chat.id);
  if (!room) return;

  const msgThreadId = ctx.message?.message_thread_id ?? null;

  // ── Per-room thread delete: remove user replies in the mirror thread ──
  if (room.notify_thread_delete === 1 && room.notify_thread_id !== null && room.notify_thread_id !== undefined) {
    const inConfiguredThread =
      (room.notify_thread_id === 0 && msgThreadId === null) ||
      (room.notify_thread_id > 0   && msgThreadId === room.notify_thread_id);
    if (inConfiguredThread) {
      try {
        await ctx.deleteMessage();
      } catch {
        // Message may already be gone — silently ignore
      }
      return;
    }
  }

  // ── Gatekeeper: delete all messages in opted-in groups ────────────────
  if (!room.gatekeeper) return;

  const canDelete = await checkDeletePermission(chat.id);
  if (!canDelete) {
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

