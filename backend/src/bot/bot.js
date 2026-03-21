'use strict';

/**
 * Futelo – grammY Bot
 * ───────────────────
 * Responsibilities:
 *   1. /start           → registers the user + group in SQLite → replies with Mini App button
 *   2. /setthread       → mirrors app messages into a Telegram thread
 *   3. /setthreaddelete → auto-deletes user replies in the mirror thread
 *
 * Default behaviour: the Telegram group chat is left untouched — Futelo runs
 * as a parallel chat alongside the normal group conversation.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { Bot, InlineKeyboard } = require('grammy');
const { upsertUser, upsertRoom, stmts } = require('../db/database');

const BOT_TOKEN  = process.env.BOT_TOKEN;
const APP_URL    = process.env.MINI_APP_URL;
const DIRECT_LINK = process.env.MINI_APP_DIRECT_LINK;

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

    // Build the button URL.
    // If MINI_APP_DIRECT_LINK (t.me/botname/appname) is configured, append
    // ?startapp=chatId so the Mini App receives the room ID as start_param
    // and initData is fully populated by the WebApp SDK.
    // Without it we fall back to a plain URL (no initData — dev/fallback only).
    const buttonUrl = DIRECT_LINK
      ? `${DIRECT_LINK}?startapp=${chat.id}`
      : APP_URL;
    const keyboard = new InlineKeyboard().url('🎮 Abrir Futelo', buttonUrl);

    const sent = await ctx.reply(
      `👋 ¡Hola, *${tgUser.first_name || 'jugador'}*!\n\n` +
      `*Futelo* es un juego de chat con inventario de letras.\n` +
      `Escribe mensajes usando tu teclado de letras, gana Monedas y construye tu abecedario.\n` +
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
    `• /setthread — espeja mensajes de la app en un hilo de Telegram\n` +
    `• /setthreaddelete — borra automáticamente las respuestas en el hilo de espejo\n` : '') +
    `\nPulsa */start* para abrir la app. ¡Buena suerte! 🍀`,
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
    `Opcional: usa */setthreaddelete* para eliminar autom\u00e1ticamente las respuestas de usuarios en ese hilo.`,
    { parse_mode: 'Markdown' }
  );
});

// ── /setthreaddelete ────────────────────────────────────────────────────────
// Toggles auto-deletion of user replies in the configured mirror thread.
// Independent of /gatekeeper — only affects the mirror thread.
bot.command('setthreaddelete', async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    await ctx.reply('Este comando solo funciona en grupos.');
    return;
  }

  const member  = await ctx.getChatMember(ctx.from.id);
  const isAdmin = member.status === 'administrator' || member.status === 'creator';
  if (!isAdmin) {
    await ctx.reply('\u26d4 Solo los administradores pueden cambiar esta opci\u00f3n.');
    return;
  }

  const room       = stmts.getRoomById.get(chat.id);
  const wasEnabled = room?.notify_thread_delete === 1;
  const nowEnabled = !wasEnabled;

  if (nowEnabled && (room?.notify_thread_id === null || room?.notify_thread_id === undefined)) {
    await ctx.reply(
      '\u26a0\ufe0f Primero configura un hilo con */setthread*.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  stmts.setNotifyThreadDelete.run(nowEnabled ? 1 : 0, chat.id);
  await ctx.reply(
    nowEnabled
      ? '\ud83d\uddd1\ufe0f *Borrado autom\u00e1tico activado.* Las respuestas de usuarios en el hilo de espejo ser\u00e1n eliminadas.'
      : '\u2705 *Borrado autom\u00e1tico desactivado.*',
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

});

module.exports = { bot };

