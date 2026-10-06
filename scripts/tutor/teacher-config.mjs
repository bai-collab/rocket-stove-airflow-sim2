// Teacher settings kept on this computer only: a scrypt password hash and the
// NMKING API key. The key is stored as plain text in a 0600 file; this guards
// against students using the browser, not against someone who controls the PC.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CLASS_GOALS, DEFAULT_GOAL } from '../../src/tutor/goals.mjs';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
const SCRYPT_BYTES = 64;

export class SettingsError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** API keys: 8-512 visible ASCII characters, no spaces. */
export function isValidApiKey(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, SCRYPT_BYTES).toString('hex');
}

function parseStored(raw) {
  const value = JSON.parse(raw);
  if (value?.version !== 1 || !/^[0-9a-f]{32}$/.test(value.salt ?? '') ||
      !/^[0-9a-f]{128}$/.test(value.passwordHash ?? '') ||
      typeof value.aiKey !== 'string' || (value.aiKey !== '' && !isValidApiKey(value.aiKey))) {
    throw new SettingsError('SETTINGS_CORRUPT');
  }
  // Files written before class goals existed have no goal field.
  const goal = value.goal === undefined ? DEFAULT_GOAL : value.goal;
  if (!Object.hasOwn(CLASS_GOALS, goal)) throw new SettingsError('SETTINGS_CORRUPT');
  return { version: 1, salt: value.salt, passwordHash: value.passwordHash, aiKey: value.aiKey, goal };
}

export async function openTeacherConfig(file) {
  let stored = null;
  try {
    stored = parseStored(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new SettingsError('SETTINGS_CORRUPT');
  }
  let saving = Promise.resolve();

  async function persist(next) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(next));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    stored = next;
  }

  /**
   * First save needs a password. Later saves: blank fields keep the stored
   * value, `clearAi` removes the key explicitly.
   */
  function update({ password, aiKey, clearAi, goal } = {}) {
    const run = async () => {
      if ((password !== undefined && typeof password !== 'string') ||
          (aiKey !== undefined && typeof aiKey !== 'string')) {
        throw new SettingsError('INVALID_SETTINGS');
      }
      const newPassword = password ?? '';
      if ((!stored || newPassword) && (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX)) {
        throw new SettingsError('INVALID_PASSWORD');
      }
      const newKey = (aiKey ?? '').trim();
      if (newKey && !isValidApiKey(newKey)) throw new SettingsError('INVALID_API_KEY');
      if (goal !== undefined && (typeof goal !== 'string' || !Object.hasOwn(CLASS_GOALS, goal))) {
        throw new SettingsError('INVALID_SETTINGS');
      }

      const next = {
        version: 1, salt: stored?.salt, passwordHash: stored?.passwordHash,
        aiKey: stored?.aiKey ?? '', goal: goal ?? stored?.goal ?? DEFAULT_GOAL,
      };
      if (newPassword) {
        next.salt = randomBytes(16).toString('hex');
        next.passwordHash = hashPassword(newPassword, next.salt);
      }
      if (clearAi === true) next.aiKey = '';
      else if (newKey) next.aiKey = newKey;
      await persist(next);
      return status();
    };
    // Serialize writes so two quick saves cannot interleave.
    const result = saving.then(run, run);
    saving = result.catch(() => {});
    return result;
  }

  function status() {
    return { initialized: stored !== null, aiConfigured: Boolean(stored?.aiKey) };
  }

  function verify(password) {
    if (!stored || typeof password !== 'string' || password.length > PASSWORD_MAX) return false;
    const expected = Buffer.from(stored.passwordHash, 'hex');
    return timingSafeEqual(Buffer.from(hashPassword(password, stored.salt), 'hex'), expected);
  }

  return { status, verify, update, apiKey: () => stored?.aiKey ?? '', goal: () => stored?.goal ?? DEFAULT_GOAL };
}
