'use strict';

/**
 * Validate Telegram WebApp initData according to the official spec:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Returns { user, chatId, chatTitle } on success, throws on failure.
 *   user      – Telegram user object
 *   chatId    – Telegram chat_id (negative for groups). 0 when opened from a DM
 *               or when the chat context is unavailable.
 *   chatTitle – Display name of the group, or '' for DMs.
 *
 * Dev mode:
 *   When process.env.DEV_MODE === 'true' the server also accepts a lightweight
 *   fake initData string so the whole app can be tested without a real Telegram
 *   session.  Format:  dev:USER_ID:username:First Name:CHAT_ID:Chat Title
 *   Minimum: dev:USER_ID:username:First Name  (CHAT_ID defaults to -1001 in dev)
 *   Example: dev:1001:alice:Alice:-1001001:Futelo Group
 */

const crypto = require('crypto');

/**
 * Parse and validate a "dev:…" initData token.
 * Returns a fake result object that looks like the real one.
 */
function validateInitDataDev(initDataRaw) {
  if (!initDataRaw || !initDataRaw.startsWith('dev:')) {
    throw new Error('Not a dev token');
  }
  // Format: dev:USER_ID:username:First Name[:CHAT_ID[:Chat Title]]
  // CHAT_ID (if present) is always a non-zero integer; detect by testing parseInt.
  // Everything between the first_name position and CHAT_ID is part of the name.
  const parts = initDataRaw.split(':');
  if (parts.length < 4) {
    throw new Error(
      'Invalid dev token. Expected format: dev:USER_ID:username:First Name'
    );
  }
  const id       = parseInt(parts[1], 10);
  const username = parts[2];

  // Determine where the chat fields start: look for the first part (index >= 4)
  // that can be parsed as a non-zero integer (negative group id or positive dev id)
  let chatIdPartIdx = -1;
  for (let i = 4; i < parts.length; i++) {
    const n = parseInt(parts[i], 10);
    if (!isNaN(n) && n !== 0 && String(n) === parts[i].trim()) {
      chatIdPartIdx = i;
      break;
    }
  }

  const first_name = chatIdPartIdx === -1
    ? parts.slice(3).join(':')                // rest of token is the name
    : parts.slice(3, chatIdPartIdx).join(':'); // name ends before chatId

  const chatId    = chatIdPartIdx !== -1 ? parseInt(parts[chatIdPartIdx], 10) : -1001;
  const chatTitle = chatIdPartIdx !== -1 && parts.length > chatIdPartIdx + 1
    ? parts.slice(chatIdPartIdx + 1).join(':')
    : 'Dev Room';

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Dev token USER_ID must be a positive integer');
  }

  return {
    user: { id, username, first_name, is_bot: false, photo_url: '' },
    chatId,
    chatTitle,
  };
}

/**
 * Full HMAC-SHA256 validation of real Telegram initData.
 * Returns { user, chatId, chatTitle }.
 */
function validateInitData(initDataRaw, botToken) {
  if (!initDataRaw) throw new Error('No initData provided');

  // Allow dev tokens when DEV_MODE is enabled
  if (process.env.DEV_MODE === 'true' && initDataRaw.startsWith('dev:')) {
    return validateInitDataDev(initDataRaw);
  }

  const params = new URLSearchParams(initDataRaw);
  const hash   = params.get('hash');
  if (!hash) throw new Error('Missing hash in initData');

  // Build check-string: all fields except hash, sorted, joined with \n
  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // HMAC-SHA256(checkString, HMAC-SHA256("WebAppData", botToken))
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const expectedHash = crypto
    .createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex');

  if (expectedHash !== hash) throw new Error('Invalid initData hash');

  // Parse user JSON
  const userJson = params.get('user');
  if (!userJson) throw new Error('No user field in initData');

  const user = JSON.parse(userJson);

  // Extract chat context (present when opened inside a group)
  let chatId    = 0;
  let chatTitle = '';
  const chatJson = params.get('chat');
  if (chatJson) {
    try {
      const chat  = JSON.parse(chatJson);
      chatId    = chat.id ?? 0;
      chatTitle = chat.title ?? '';
    } catch { /* ignore malformed chat JSON */ }
  }

  return { user, chatId, chatTitle };
}

module.exports = { validateInitData, validateInitDataDev };

