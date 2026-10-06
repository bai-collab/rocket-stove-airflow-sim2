// Learning records: one JSON object per line in local-data/records/events.jsonl.
// Ids and timestamps are assigned here, never taken from the browser.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeGoal } from '../../src/tutor/goals.mjs';

export const STUDENT_ID_PATTERN = /^[\p{L}\p{N}_-]{1,20}$/u;
export const MAX_RECORDS_IN_MEMORY = 50_000;
const RECORD_TYPES = new Set(['test', 'tutor']);
const END_REASONS = new Set(['reset', 'edit', 'clear', 'leave', 'checkpoint']);

export class RecordError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function cleanStudentId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!STUDENT_ID_PATTERN.test(id)) throw new RecordError('INVALID_STUDENT_ID');
  return id;
}

export function endReason(value) {
  return END_REASONS.has(value) ? value : 'leave';
}

/** Design part of a sanitized stove context, as stored with every record. */
export function designOf(context) {
  return { preset: context.preset, edited: context.edited, walls: context.walls, fuels: context.fuels };
}

function newId(now) {
  return `r_${now.toString(36)}_${randomBytes(6).toString('hex')}`;
}

function looksLikeRecord(value) {
  return value && typeof value === 'object' && RECORD_TYPES.has(value.type) &&
    typeof value.id === 'string' && typeof value.studentId === 'string' &&
    typeof value.timestamp === 'string' && Number.isSafeInteger(value.seq);
}

export async function openRecordStore(file, { now = Date.now } = {}) {
  const records = [];
  let skipped = 0;
  try {
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (looksLikeRecord(record)) records.push(record);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (records.length > MAX_RECORDS_IN_MEMORY) records.splice(0, records.length - MAX_RECORDS_IN_MEMORY);
  let seq = records.reduce((max, record) => Math.max(max, record.seq), 0);
  let writing = Promise.resolve();

  const ids = new Set(records.map((record) => record.id));

  function write(record) {
    const run = async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      records.push(record);
      ids.add(record.id);
      if (records.length > MAX_RECORDS_IN_MEMORY) ids.delete(records.shift().id);
      return record;
    };
    const result = writing.then(run, run);
    writing = result.catch(() => {});
    return result;
  }

  /** Adds a new local record (fields already validated by the caller) and returns it. */
  function append(fields) {
    const time = now();
    return write({ ...fields, id: newId(time), seq: ++seq, timestamp: new Date(time).toISOString(), goal: normalizeGoal(fields.goal) });
  }

  /**
   * Adds a record pulled from the class spreadsheet. It keeps its id and time,
   * gets a local sequence number and is marked so it is never pushed back.
   */
  function importRecord(record) {
    if (ids.has(record.id)) return Promise.resolve(null);
    ids.add(record.id);
    return write({ ...record, seq: ++seq, source: 'sheet', goal: normalizeGoal(record.goal) });
  }

  return {
    append,
    importRecord,
    has: (id) => ids.has(id),
    all: () => records.slice(),
    skipped: () => skipped,
  };
}
