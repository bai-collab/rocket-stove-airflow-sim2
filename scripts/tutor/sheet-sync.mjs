// Optional sync of learning records with the teacher's own Google Sheet
// through a Google Apps Script web app (scripts/tutor/sheets/Code.gs).
// Local records are pushed; records from other computers are pulled in and
// never pushed back.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeGoal } from '../../src/tutor/goals.mjs';
import { TUTOR_METRICS, sanitizeStoveContext } from '../../src/tutor/stove-context.mjs';
import { STUDENT_ID_PATTERN, endReason } from './record-store.mjs';

export const SHEET_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,200}\/exec$/;
export const TOKEN_MIN = 16;
export const TOKEN_MAX = 200;
const PUSH_BATCH = 50;
const READ_PAGE = 100;
const MAX_PAGES_PER_SYNC = 20;
const MAX_RESPONSE_BYTES = 8_000_000;
const AUTO_PUSH_DELAY_MS = 15_000;
const ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

export class SyncError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function isValidSheetToken(value) {
  return typeof value === 'string' && value.length >= TOKEN_MIN && value.length <= TOKEN_MAX && /^[\x21-\x7e]+$/.test(value);
}

const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);
const num = (value) => (Number.isFinite(value) ? value : null);

/** Strict check of a record coming back from the spreadsheet. Returns null when unusable. */
export function cleanSyncedRecord(raw) {
  if (!plain(raw) || !ID_PATTERN.test(raw.id ?? '') || !STUDENT_ID_PATTERN.test(raw.studentId ?? '') ||
      typeof raw.timestamp !== 'string' || Number.isNaN(Date.parse(raw.timestamp)) || !plain(raw.design)) {
    return null;
  }
  let design;
  try {
    const context = sanitizeStoveContext({ version: 1, ...raw.design, run: {} });
    design = { preset: context.preset, edited: context.edited, walls: context.walls, fuels: context.fuels };
  } catch {
    return null;
  }
  const base = {
    id: raw.id, studentId: raw.studentId, timestamp: new Date(raw.timestamp).toISOString(),
    goal: normalizeGoal(raw.goal), design,
    computer: typeof raw.computer === 'string' && /^[0-9a-f]{8}$/.test(raw.computer) ? raw.computer : '',
  };
  if (raw.type === 'test') {
    const s = raw.summary;
    if (!plain(s)) return null;
    const summary = {
      durationSec: num(s.durationSec), samples: num(s.samples),
      finalPhase: ['unlit', 'burning', 'extinguished'].includes(s.finalPhase) ? s.finalPhase : null,
      burnFraction: num(s.burnFraction), peakFuelTemperature: num(s.peakFuelTemperature),
      averageFuelOxygen: num(s.averageFuelOxygen), peakSmoke: num(s.peakSmoke), smokeOut: num(s.smokeOut),
      secondaryObserved: typeof s.secondaryObserved === 'boolean' ? s.secondaryObserved : null,
      charRetention: num(s.charRetention), carbonizationIndex: num(s.carbonizationIndex), pyrolysisFraction: num(s.pyrolysisFraction),
    };
    if (Object.values(summary).some((value) => value === null)) return null;
    return { ...base, type: 'test', endReason: endReason(raw.endReason), backend: raw.backend === 'gpu' ? 'gpu' : 'cpu', summary };
  }
  if (raw.type === 'tutor') {
    const question = text(raw.question, 300);
    if (!question || !['mock', 'model'].includes(raw.mode) || !['completed', 'failed'].includes(raw.status)) return null;
    const record = { ...base, type: 'tutor', mode: raw.mode, status: raw.status, question };
    if (raw.status === 'failed') {
      record.errorCode = /^[A-Z_]{1,40}$/.test(raw.errorCode ?? '') ? raw.errorCode : 'UNKNOWN';
    } else {
      const guidance = text(raw.guidance, 400);
      const followup = text(raw.followup, 400);
      if (guidance === null || followup === null) return null;
      Object.assign(record, {
        guidance, followup,
        relatedMetrics: (Array.isArray(raw.relatedMetrics) ? raw.relatedMetrics : [])
          .filter((key) => typeof key === 'string' && Object.hasOwn(TUTOR_METRICS, key)).slice(0, 3),
      });
    }
    return record;
  }
  return null;
}

/** What a local record looks like in the spreadsheet: no local bookkeeping fields. */
export function wireRecord(record, computer) {
  const { seq: _seq, source: _source, ...rest } = record;
  return { ...rest, computer };
}

export function createSheetClient({ url, token, fetchImpl = fetch, timeoutMs = 20_000 }) {
  if (!SHEET_URL_PATTERN.test(url ?? '') || !isValidSheetToken(token)) throw new SyncError('SHEET_NOT_CONFIGURED');

  async function call(payload) {
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST', redirect: 'manual', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, token }),
      });
      // Apps Script answers with a one-time redirect to googleusercontent.com.
      // It is followed with GET only, so the token never goes anywhere else.
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = new URL(response.headers.get('location') ?? '', url);
        if (location.protocol !== 'https:' || location.hostname !== 'script.googleusercontent.com' ||
            location.username || location.password) {
          throw new SyncError('SHEET_BAD_REDIRECT');
        }
        response = await fetchImpl(location.href, { method: 'GET', redirect: 'error', signal });
      }
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError(signal.aborted ? 'SHEET_TIMEOUT' : 'SHEET_NETWORK');
    }
    if (!response.ok) throw new SyncError('SHEET_HTTP_ERROR');
    let body;
    try {
      body = await response.text();
    } catch {
      throw new SyncError('SHEET_NETWORK');
    }
    if (body.length > MAX_RESPONSE_BYTES) throw new SyncError('SHEET_BAD_RESPONSE');
    let result;
    try {
      result = JSON.parse(body);
    } catch {
      // A login page or quota page instead of JSON usually means the web app
      // is not deployed for "Anyone".
      throw new SyncError('SHEET_BAD_RESPONSE');
    }
    if (result?.ok !== true) throw new SyncError(result?.code === 'AUTH_REJECTED' ? 'SHEET_AUTH_REJECTED' : 'SHEET_REJECTED');
    return result;
  }

  return {
    async push(records) {
      const result = await call({ action: 'append', records });
      const sent = records.map((record) => record.id);
      if (!Array.isArray(result.ids) || result.ids.length !== sent.length || result.ids.some((id, i) => id !== sent[i])) {
        throw new SyncError('SHEET_BAD_RESPONSE');
      }
    },
    async read(offset) {
      const result = await call({ action: 'read', offset, limit: READ_PAGE });
      if (!Array.isArray(result.records) || result.records.length > READ_PAGE || !Number.isSafeInteger(result.nextOffset) ||
          result.nextOffset !== offset + result.records.length || typeof result.more !== 'boolean' ||
          (result.more && result.records.length === 0)) {
        throw new SyncError('SHEET_BAD_RESPONSE');
      }
      return result;
    },
  };
}

const scopeOf = (url) => createHash('sha256').update(url).digest('hex').slice(0, 16);

export async function openSheetSync({ store, stateFile, getConfig, fetchImpl = fetch, now = Date.now }) {
  let state = null;
  try {
    const value = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (value?.version === 1 && /^[0-9a-f]{8}$/.test(value.computer ?? '')) state = value;
  } catch {
    // Missing or damaged: start over; records are de-duplicated by id anyway.
  }
  state ??= { version: 1, computer: randomBytes(4).toString('hex') };
  state = {
    scope: '', pushedSeq: 0, readOffset: 0, lastSyncAt: '', lastError: '', lastPushed: 0, lastImported: 0, ...state,
  };
  let running = null;
  let timer = null;

  async function save() {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const temp = `${stateFile}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temp, stateFile);
  }

  function pendingRecords() {
    return store.all().filter((record) => !record.source && record.seq > state.pushedSeq);
  }

  function status() {
    const { url, token } = getConfig();
    const configured = Boolean(url && token);
    const scopeMatches = configured && state.scope === scopeOf(url);
    return {
      configured,
      computer: state.computer,
      pending: !configured ? 0 : scopeMatches ? pendingRecords().length
        : store.all().filter((record) => !record.source).length,
      lastSyncAt: scopeMatches ? state.lastSyncAt : '',
      lastError: scopeMatches ? state.lastError : '',
      lastPushed: scopeMatches ? state.lastPushed : 0,
      lastImported: scopeMatches ? state.lastImported : 0,
      running: running !== null,
    };
  }

  async function run({ pull }) {
    const { url, token } = getConfig();
    const client = createSheetClient({ url, token, fetchImpl });
    const scope = scopeOf(url);
    if (state.scope !== scope) {
      // A different spreadsheet: push everything there and read it from the start.
      Object.assign(state, { scope, pushedSeq: 0, readOffset: 0, lastSyncAt: '', lastError: '' });
    }
    let pushed = 0;
    let imported = 0;
    let skipped = 0;
    let more = false;
    try {
      const pending = pendingRecords();
      for (let i = 0; i < pending.length; i += PUSH_BATCH) {
        const batch = pending.slice(i, i + PUSH_BATCH);
        await client.push(batch.map((record) => wireRecord(record, state.computer)));
        state.pushedSeq = batch.at(-1).seq;
        pushed += batch.length;
        await save();
      }
      if (pull) {
        for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
          const result = await client.read(state.readOffset);
          for (const raw of result.records) {
            const record = cleanSyncedRecord(raw);
            if (!record) skipped += 1;
            else if (record.computer !== state.computer && await store.importRecord(record)) imported += 1;
          }
          state.readOffset = result.nextOffset;
          await save();
          more = result.more;
          if (!more) break;
        }
      }
      Object.assign(state, { lastSyncAt: new Date(now()).toISOString(), lastError: '', lastPushed: pushed, lastImported: imported });
      await save();
      return { pushed, imported, skipped, more };
    } catch (error) {
      state.lastError = error instanceof SyncError ? error.code : 'SHEET_FAILED';
      await save().catch(() => {});
      throw error instanceof SyncError ? error : new SyncError('SHEET_FAILED');
    }
  }

  /** One sync at a time; a second caller waits for the running one. */
  function sync({ pull = true } = {}) {
    if (running) return running;
    running = run({ pull }).finally(() => { running = null; });
    return running;
  }

  /** After new local records: push a little later, in the background. */
  function schedulePush() {
    const { url, token } = getConfig();
    if (!url || !token || timer) return;
    timer = setTimeout(() => {
      timer = null;
      sync({ pull: false }).catch(() => {});
    }, AUTO_PUSH_DELAY_MS);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { status, sync, schedulePush, stop, computer: () => state.computer };
}
