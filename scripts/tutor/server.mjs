#!/usr/bin/env node
// Local tutor service: serves the built simulator, the tutor API and the
// teacher settings page on the loopback interface only. Node built-ins only.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mockTutorReply } from '../../src/tutor/mock-tutor.mjs';
import {
  groundTutorReply,
  sanitizeHistory,
  sanitizeQuestion,
  sanitizeStoveContext,
} from '../../src/tutor/stove-context.mjs';
import { ProviderError, providerConfig, requestModelGuidance } from './nmking.mjs';
import { SettingsError, openTeacherConfig } from './teacher-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_PORT = 8620;
export const DEFAULT_STATIC_DIR = path.join(ROOT, 'dist-tutor');
export const DEFAULT_SETTINGS_FILE = path.join(ROOT, 'local-data', 'teacher-settings.json');
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE = 'stove_teacher';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 60 * 1000;
const MODEL_TIMEOUT_MS = 90 * 1000;
const DEFAULT_MODEL_PER_MINUTE = 6;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// [HTTP status, message shown to the student or teacher]
const ERRORS = {
  INVALID_CONTEXT: [400, '模擬器狀態格式不正確，請重新整理頁面後再試。'],
  INVALID_QUESTION: [400, '請用 1～300 個字描述你的想法或卡住的地方。'],
  INVALID_MODE: [400, '不支援的導師模式。'],
  INVALID_REPLY: [400, '導師這次沒有產生可用的提示，請換個說法再問一次。'],
  MODEL_NOT_CONFIGURED: [409, '老師尚未設定 AI 金鑰，請先使用「本機提示」。'],
  LOCAL_BUSY: [429, '導師正在回覆上一個問題，請等它回覆後再問。'],
  LOCAL_QUOTA: [429, '這一分鐘的 AI 提問次數已達上限，請稍後再試，或先用「本機提示」。'],
  AUTH_REJECTED: [502, 'AI 服務拒絕了金鑰，請老師到教師設定確認 NMKING 金鑰。'],
  RATE_LIMITED: [502, 'AI 服務目前太忙或額度已用完，請稍後再試，或改用「本機提示」。'],
  TIMEOUT: [504, 'AI 回覆太久，已停止這次提問；可以再問一次或改用「本機提示」。'],
  UPSTREAM_NETWORK: [502, '連不到 AI 服務，請確認這台電腦可以上網。'],
  NETWORK_BLOCKED: [502, '連線被這台電腦或學校網路擋住，請確認防火牆設定。'],
  PROVIDER_ERROR: [502, 'AI 這次沒有產生可用的提示，請換個說法再問，或改用「本機提示」。'],
  INVALID_PROVIDER_RESPONSE: [502, 'AI 這次沒有產生可用的提示，請換個說法再問，或改用「本機提示」。'],
  MODEL_INCOMPLETE: [502, 'AI 這次沒有產生可用的提示，請換個說法再問，或改用「本機提示」。'],
  INVALID_MODEL_OUTPUT: [502, 'AI 這次沒有產生可用的提示，請換個說法再問，或改用「本機提示」。'],
  INVALID_SETTINGS: [400, '設定格式不正確。'],
  INVALID_PASSWORD: [400, '教師密碼需要 12～256 個字元。'],
  INVALID_API_KEY: [400, 'API 金鑰格式不正確：需 8～512 個英數符號，不能有空白。'],
  ALREADY_INITIALIZED: [409, '這台電腦已設定過教師密碼，請直接登入。'],
  NOT_INITIALIZED: [409, '請先建立教師密碼。'],
  LOGIN_FAILED: [401, '密碼不正確。'],
  LOGIN_LOCKED: [429, '密碼錯誤太多次，請 1 分鐘後再試。'],
  UNAUTHORIZED: [401, '請先登入教師設定。'],
};

class RequestError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function fail(res, code) {
  const [status, message] = ERRORS[code];
  json(res, status, { error: message, code });
}

/** Only accept Host headers naming this loopback service (DNS-rebinding guard). */
function allowedHost(req, port) {
  const host = req.headers.host;
  return host === `${HOST}:${port}` || host === `localhost:${port}`;
}

/** Browser writes must come from this page, not from another site. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${req.headers.host}`) return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      reject(Object.assign(new Error('UNSUPPORTED_MEDIA_TYPE'), { status: 415 }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading; the caller answers 413 and closes the connection.
        req.removeAllListeners('data');
        req.pause();
        reject(Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('INVALID_JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Returns the parsed body, or undefined after answering the request itself. */
async function bodyOrReply(req, res) {
  try {
    return await readJson(req);
  } catch (error) {
    if (error.status === 413) {
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
    }
    json(res, error.status ?? 400, { error: error.status === 413 ? '送出的資料太大。' : '請求格式不正確。' });
    return undefined;
  }
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

async function serveStatic(req, res, staticDir) {
  const url = new URL(req.url, 'http://localhost');
  let relative;
  try {
    relative = decodeURIComponent(url.pathname);
  } catch {
    json(res, 400, { error: '路徑格式錯誤。' });
    return;
  }
  if (relative.endsWith('/')) relative += 'index.html';
  const file = path.resolve(staticDir, `.${relative}`);
  if (!file.startsWith(staticDir + path.sep) || relative.split('/').some((part) => part.startsWith('.'))) {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  try {
    const data = await fs.readFile(file);
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    send(res, 200, req.method === 'HEAD' ? undefined : data, {
      'Content-Type': type,
      'Cache-Control': relative.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

export async function createTutorServer({
  port = DEFAULT_PORT,
  staticDir = DEFAULT_STATIC_DIR,
  settingsFile = DEFAULT_SETTINGS_FILE,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const root = path.resolve(staticDir);
  const settings = await openTeacherConfig(settingsFile);
  const aiConfig = providerConfig(env);
  const perMinute = Number.parseInt(env.TUTOR_AI_PER_MINUTE ?? '', 10) || DEFAULT_MODEL_PER_MINUTE;
  const sessions = new Map();
  const login = { failures: 0, lockedUntil: 0 };
  let modelInFlight = false;
  let modelCalls = [];

  function sessionCookie(token, maxAgeSeconds) {
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/teacher; Max-Age=${maxAgeSeconds}`;
  }

  function startSession() {
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, now() + SESSION_TTL_MS);
    return token;
  }

  function currentSession(req) {
    const token = readCookie(req, SESSION_COOKIE);
    const expires = token ? sessions.get(token) : undefined;
    if (!expires) return '';
    if (expires <= now()) {
      sessions.delete(token);
      return '';
    }
    return token;
  }

  function teacherState(req) {
    return { ...settings.status(), loggedIn: Boolean(currentSession(req)) };
  }

  async function modelReply(req, res, context, question, history) {
    const apiKey = settings.apiKey();
    if (!apiKey) throw new RequestError('MODEL_NOT_CONFIGURED');
    if (modelInFlight) throw new RequestError('LOCAL_BUSY');
    const minuteAgo = now() - 60_000;
    modelCalls = modelCalls.filter((time) => time > minuteAgo);
    if (modelCalls.length >= perMinute) throw new RequestError('LOCAL_QUOTA');
    modelCalls.push(now());
    modelInFlight = true;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    // A student who closes the page should not keep the upstream call open.
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      return await requestModelGuidance({
        apiKey, context, question, history, signal: controller.signal, config: aiConfig, fetchImpl,
      });
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      modelInFlight = false;
    }
  }

  async function handleTutor(req, res) {
    const body = await bodyOrReply(req, res);
    if (body === undefined) return;
    if (body?.mode !== 'mock' && body?.mode !== 'model') throw new RequestError('INVALID_MODE');
    let question;
    let context;
    try {
      question = sanitizeQuestion(body.question);
      context = sanitizeStoveContext(body.context);
    } catch (error) {
      throw new RequestError(error.message);
    }
    if (body.mode === 'mock') {
      const reply = groundTutorReply(mockTutorReply(context, question), context);
      json(res, 200, { source: 'mock', reply });
      return;
    }
    const reply = await modelReply(req, res, context, question, sanitizeHistory(body.history));
    json(res, 200, { source: 'model', reply });
  }

  async function handleTeacher(req, res, pathname) {
    if (pathname === '/api/teacher/session') {
      if (req.method !== 'GET') return json(res, 405, { error: '不支援的方法。' });
      return json(res, 200, teacherState(req));
    }
    if (req.method !== 'POST') return json(res, 405, { error: '不支援的方法。' });
    if (!sameOrigin(req)) return json(res, 403, { error: '只接受本頁送出的請求。' });
    const body = await bodyOrReply(req, res);
    if (body === undefined) return undefined;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('INVALID_SETTINGS');

    if (pathname === '/api/teacher/setup') {
      if (settings.status().initialized) throw new RequestError('ALREADY_INITIALIZED');
      if (typeof body.password !== 'string' || !body.password) throw new RequestError('INVALID_PASSWORD');
      await settings.update({ password: body.password, aiKey: body.aiKey });
      const token = startSession();
      return json(res, 200, { ...settings.status(), loggedIn: true },
        { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
    }
    if (pathname === '/api/teacher/login') {
      if (!settings.status().initialized) throw new RequestError('NOT_INITIALIZED');
      if (login.lockedUntil > now()) throw new RequestError('LOGIN_LOCKED');
      if (!settings.verify(body.password)) {
        login.failures += 1;
        if (login.failures >= LOGIN_MAX_FAILURES) {
          login.failures = 0;
          login.lockedUntil = now() + LOGIN_LOCK_MS;
        }
        throw new RequestError('LOGIN_FAILED');
      }
      login.failures = 0;
      const token = startSession();
      return json(res, 200, { ...settings.status(), loggedIn: true },
        { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
    }
    if (pathname === '/api/teacher/logout') {
      const token = currentSession(req);
      if (token) sessions.delete(token);
      return json(res, 200, { ...settings.status(), loggedIn: false }, { 'Set-Cookie': sessionCookie('', 0) });
    }
    if (pathname === '/api/teacher/settings') {
      const token = currentSession(req);
      if (!token) throw new RequestError('UNAUTHORIZED');
      await settings.update({ password: body.password || undefined, aiKey: body.aiKey, clearAi: body.clearAi === true });
      // A new password signs out every other open teacher page.
      if (body.password) for (const other of sessions.keys()) if (other !== token) sessions.delete(other);
      return json(res, 200, { ...settings.status(), loggedIn: true });
    }
    return json(res, 404, { error: '找不到這個 API。' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      // The actual port is only known after listen() when port 0 is used.
      const activePort = server.address()?.port ?? port;
      if (!allowedHost(req, activePort)) {
        json(res, 421, { error: `請用 http://${HOST}:${activePort}/ 開啟。` });
        return;
      }
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/api/tutor/status') {
        if (req.method !== 'GET') return json(res, 405, { error: '不支援的方法。' });
        return json(res, 200, { ok: true, modes: { mock: true, model: settings.status().aiConfigured } });
      }
      if (pathname === '/api/tutor') {
        if (req.method !== 'POST') return json(res, 405, { error: '不支援的方法。' });
        if (!sameOrigin(req)) return json(res, 403, { error: '只接受本頁送出的請求。' });
        return await handleTutor(req, res);
      }
      if (pathname.startsWith('/api/teacher/')) return await handleTeacher(req, res, pathname);
      if (pathname.startsWith('/api/')) return json(res, 404, { error: '找不到這個 API。' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支援的方法。' });
      return await serveStatic(req, res, root);
    } catch (error) {
      const code = error instanceof RequestError || error instanceof ProviderError || error instanceof SettingsError
        ? error.code : null;
      if (code && ERRORS[code] && !res.headersSent) return fail(res, code);
      console.error('Tutor request failed', error);
      if (!res.headersSent) json(res, 500, { error: '本機服務發生錯誤。' });
      else res.destroy();
      return undefined;
    }
  });
  return server;
}

async function main() {
  const port = Number(process.env.TUTOR_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('TUTOR_PORT 必須介於 1024 與 65535。');
    process.exit(1);
  }
  try {
    await fs.access(path.join(DEFAULT_STATIC_DIR, 'index.html'));
  } catch {
    console.error('找不到 dist-tutor/index.html；請先執行 npm run tutor:build。');
    process.exit(1);
  }
  let server;
  try {
    server = await createTutorServer({ port });
  } catch (error) {
    console.error(error instanceof SettingsError
      ? `教師設定檔 ${DEFAULT_SETTINGS_FILE} 無法讀取；請改名備份後重新設定。`
      : `本機服務無法啟動：${error.message}`);
    process.exit(1);
  }
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `連接埠 ${port} 已被使用；請先關閉另一個導師視窗，或設定另一個 TUTOR_PORT。`
      : `本機服務無法啟動：${error.message}`);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const config = providerConfig();
    console.log(`火箭爐設計導師已啟動：http://${HOST}:${port}/`);
    console.log(`教師設定：http://${HOST}:${port}/teacher.html`);
    console.log(`真實模型：${config.model}（${config.endpoint}）；學生每次提問只呼叫一次，不自動重試。`);
    console.log('服務只在這台電腦提供；關閉此視窗即停止服務。');
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
