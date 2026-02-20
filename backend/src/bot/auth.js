'use strict';

/**
 * Validate Telegram WebApp initData according to the official spec:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Returns the parsed user object on success, throws on failure.
 *
 * Dev mode:
 *   When process.env.DEV_MODE === 'true' the server also accepts a lightweight
 *   fake initData string so the whole app can be tested without a real Telegram
 *   session.  Format:  dev:USER_ID:username:First Name
 *   Example:           dev:1001:alice:Alice
 */

const crypto = require('crypto');

/**
 * Parse and validate a "dev:…" initData token.
 * Returns a fake tgUser object that looks like the real one.
 */
function validateInitDataDev(initDataRaw) {
  if (!initDataRaw || !initDataRaw.startsWith('dev:')) {
    throw new Error('Not a dev token');
  }
  // Format: dev:USER_ID:username:First Name
  const parts = initDataRaw.split(':');
  if (parts.length < 4) {
    throw new Error(
      'Invalid dev token. Expected format: dev:USER_ID:username:First Name'
    );
  }
  const id         = parseInt(parts[1], 10);
  const username   = parts[2];
  const first_name = parts.slice(3).join(':'); // allow colons in name

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Dev token USER_ID must be a positive integer');
  }

  return { id, username, first_name, is_bot: false, photo_url: '' };
}

/**
 * Full HMAC-SHA256 validation of real Telegram initData.
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

  return JSON.parse(userJson);
}

module.exports = { validateInitData, validateInitDataDev };
