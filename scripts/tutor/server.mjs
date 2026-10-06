#!/usr/bin/env node
// Local tutor service: serves the built simulator and the tutor API on the
// loopback interface only. Node built-ins only; no API keys exist in P1.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mockTutorReply } from '../../src/tutor/mock-tutor.mjs';
import {
  groundTutorReply,
  sanitizeQuestion,
  sanitizeStoveContext,
} from '../../src/tutor/stove-context.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_PORT = 8620;
export const DEFAULT_STATIC_DIR = path.join(ROOT, 'dist-tutor');
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;

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

const ERROR_MESSAGES = {
  INVALID_CONTEXT: '模擬器狀態格式不正確，請重新整理頁面後再試。',
  INVALID_QUESTION: '請用 1～300 個字描述你的想法或卡住的地方。',
  INVALID_MODE: '目前只提供「本機提示」模式；真實模型尚未啟用。',
  INVALID_REPLY: '導師這次沒有產生可用的提示，請換個說法再問一次。',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
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

async function handleTutor(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    if (error.status === 413) {
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
    }
    json(res, error.status ?? 400, { error: error.status === 413 ? '送出的資料太大。' : '請求格式不正確。' });
    return;
  }
  try {
    if (body?.mode !== 'mock') throw new Error('INVALID_MODE');
    const question = sanitizeQuestion(body.question);
    const context = sanitizeStoveContext(body.context);
    const reply = groundTutorReply(mockTutorReply(context, question), context);
    json(res, 200, { source: 'mock', reply });
  } catch (error) {
    const message = ERROR_MESSAGES[error.message];
    if (!message) throw error;
    json(res, 400, { error: message, code: error.message });
  }
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

export function createTutorServer({ port = DEFAULT_PORT, staticDir = DEFAULT_STATIC_DIR } = {}) {
  const root = path.resolve(staticDir);
  const server = http.createServer(async (req, res) => {
    try {
      // The actual port is only known after listen() when port 0 is used.
      const activePort = server.address()?.port ?? port;
      if (!allowedHost(req, activePort)) {
        json(res, 421, { error: '請用 http://127.0.0.1:' + activePort + '/ 開啟。' });
        return;
      }
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/api/tutor/status') {
        if (req.method !== 'GET') return json(res, 405, { error: '不支援的方法。' });
        return json(res, 200, { ok: true, modes: { mock: true, model: false } });
      }
      if (pathname === '/api/tutor') {
        if (req.method !== 'POST') return json(res, 405, { error: '不支援的方法。' });
        if (!sameOrigin(req)) return json(res, 403, { error: '只接受本頁送出的請求。' });
        return await handleTutor(req, res);
      }
      if (pathname.startsWith('/api/')) return json(res, 404, { error: '找不到這個 API。' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支援的方法。' });
      return await serveStatic(req, res, root);
    } catch (error) {
      console.error('Tutor request failed', error);
      if (!res.headersSent) json(res, 500, { error: '本機服務發生錯誤。' });
      else res.destroy();
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
  const server = createTutorServer({ port });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `連接埠 ${port} 已被使用；請先關閉另一個導師視窗，或設定另一個 TUTOR_PORT。`
      : `本機服務無法啟動：${error.message}`);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    console.log(`火箭爐設計導師已啟動：http://${HOST}:${port}/`);
    console.log('目前只提供「本機提示」模式，不會呼叫任何 AI 服務。關閉此視窗即停止服務。');
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
