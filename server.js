'use strict';

/*
 * ONEDAY 云端服务
 * 只做三件事：
 *   1) 设备码配对，让多台设备共用同一份世界存档
 *   2) 存档的拉取 / 上传（带版本号，避免静默覆盖）
 *   3) 代理 GLM 请求，Key 只存在服务端
 *
 * 无第三方依赖，Node 18+ 直接运行：node server.js
 * 配置优先读环境变量，其次读同目录 server.config.json，都没有才用默认值：
 *   PORT             监听端口（默认 8000，托管平台用这个）
 *   GLM_API_KEY      智谱 API Key（必填，否则 AI 接口返回 503）
 *   DATA_DIR         存档目录（默认系统临时目录；托管环境建议给持久目录）
 *   AI_DAILY_LIMIT   每个世界每天最多请求模型的次数（默认 200）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function readLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'server.config.json'), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

const LOCAL_CFG = readLocalConfig();
const PORT = Number(process.env.PORT || LOCAL_CFG.port || 8000);
const DATA_DIR = process.env.DATA_DIR || LOCAL_CFG.dataDir || path.join(os.tmpdir(), 'oneday-data');
const DB_FILE = path.join(DATA_DIR, 'worlds.json');
const GLM_KEY = process.env.GLM_API_KEY || String(LOCAL_CFG.glmApiKey || '');
const GLM_URL = process.env.GLM_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 200);
const MAX_STATE = 2 * 1024 * 1024;
const MAX_BODY = 2.2 * 1024 * 1024;
const PAIR_TTL = 7 * 24 * 3600 * 1000;
const MAX_TOKENS_PER_WORLD = 8;
const MODELS = new Set(['glm-4-flash-250414', 'glm-4-flash', 'glm-4-air-250414']);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let db = { worlds: {} };
let saveTimer = null;

function loadDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.worlds) db = parsed;
  } catch (e) {
    db = { worlds: {} };
  }
}

function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('save failed');
    }
  }, 200);
}

function now() { return Date.now(); }
function newId(prefix) { return prefix + crypto.randomBytes(9).toString('hex'); }
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function sha(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

function newCode() {
  let out = '';
  const buf = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) out += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return out;
}

function findWorldByToken(token) {
  if (!token) return null;
  const h = sha(token);
  const ids = Object.keys(db.worlds);
  for (let i = 0; i < ids.length; i++) {
    const w = db.worlds[ids[i]];
    if (w.tokens && w.tokens.indexOf(h) >= 0) return w;
  }
  return null;
}

function issueToken(world) {
  const token = newToken();
  world.tokens.push(sha(token));
  if (world.tokens.length > MAX_TOKENS_PER_WORLD) world.tokens.shift();
  return token;
}

function ensureCode(world, force) {
  if (force || !world.code || !world.codeExpires || world.codeExpires < now()) {
    world.code = newCode();
    world.codeExpires = now() + PAIR_TTL;
  }
  return world.code;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(text);
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  let killed = false;
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) {
      killed = true;
      cb(new Error('TOO_LARGE'));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', function () {
    if (killed) return;
    let body = {};
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { return cb(new Error('BAD_JSON')); }
    }
    cb(null, body);
  });
  req.on('error', function () { cb(new Error('STREAM')); });
}

function validState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (!s.meta || typeof s.meta !== 'object') return false;
  if (!s.rabbit || typeof s.rabbit !== 'object') return false;
  if (!Array.isArray(s.memories) || !Array.isArray(s.diaries)) return false;
  return true;
}

function aiQuota(world) {
  const day = new Date().toISOString().slice(0, 10);
  if (world.aiDay !== day) {
    world.aiDay = day;
    world.aiCount = 0;
  }
  return { used: world.aiCount || 0, left: Math.max(0, AI_DAILY_LIMIT - (world.aiCount || 0)) };
}

function proxyChat(world, body, res) {
  if (!GLM_KEY) {
    json(res, 503, { ok: false, code: 'NO_KEY', message: '服务端还没有配置模型 Key' });
    return;
  }
  const q = aiQuota(world);
  if (q.left <= 0) {
    json(res, 429, { ok: false, code: 'QUOTA', message: '今天的模型额度用完了' });
    return;
  }
  const model = MODELS.has(body.model) ? body.model : 'glm-4-flash-250414';
  const raw = Array.isArray(body.messages) ? body.messages : [];
  if (!raw.length) {
    json(res, 400, { ok: false, code: 'BAD_MESSAGES', message: '缺少对话内容' });
    return;
  }
  const messages = raw.slice(-20).map(function (m) {
    return {
      role: m && m.role === 'assistant' ? 'assistant' : m && m.role === 'system' ? 'system' : 'user',
      content: String((m && m.content) || '').slice(0, 4000)
    };
  }).filter(function (m) { return m.content; });

  const payload = JSON.stringify({
    model: model,
    messages: messages,
    temperature: typeof body.temperature === 'number' ? Math.min(1.2, Math.max(0, body.temperature)) : 0.8,
    max_tokens: Math.min(400, Math.max(16, Number(body.max_tokens) || 220))
  });

  const req = httpsRequest(payload, function (status, text) {
    if (status < 200 || status >= 300) {
      json(res, 502, { ok: false, code: 'UPSTREAM', message: '模型服务没有正常响应' });
      return;
    }
    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      json(res, 502, { ok: false, code: 'UPSTREAM', message: '模型返回格式异常' });
      return;
    }
    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (!content) {
      json(res, 502, { ok: false, code: 'EMPTY', message: '模型这次没有说话' });
      return;
    }
    world.aiCount = (world.aiCount || 0) + 1;
    saveDb();
    json(res, 200, { ok: true, text: String(content).slice(0, 800), left: q.left - 1 });
  });
  req.on('timeout', function () { req.destroy(new Error('TIMEOUT')); });
  req.on('error', function () {
    json(res, 504, { ok: false, code: 'TIMEOUT', message: '模型响应超时' });
  });
  req.write(payload);
  req.end();
}

function httpsRequest(payload, cb) {
  const url = new URL(GLM_URL);
  const lib = url.protocol === 'http:' ? require('http') : require('https');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + GLM_KEY,
    'Content-Length': Buffer.byteLength(payload)
  };
  const req = lib.request({
    hostname: url.hostname,
    port: url.port || (url.protocol === 'http:' ? 80 : 443),
    path: url.pathname + url.search,
    method: 'POST',
    headers: headers,
    timeout: 30000
  }, function (r) {
    const chunks = [];
    let size = 0;
    r.on('data', function (c) {
      size += c.length;
      if (size > 256 * 1024) { r.destroy(); return; }
      chunks.push(c);
    });
    r.on('end', function () {
      cb(r.statusCode || 500, Buffer.concat(chunks).toString('utf8'));
    });
  });
  return req;
}

const server = http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    json(res, 200, { ok: true, service: 'oneday', version: 1, ai: !!GLM_KEY });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/pair/new') {
    const world = {
      id: newId('w_'),
      tokens: [],
      code: '',
      codeExpires: 0,
      rev: 0,
      state: null,
      updatedAt: 0,
      createdAt: now(),
      aiDay: '',
      aiCount: 0
    };
    const token = issueToken(world);
    ensureCode(world);
    db.worlds[world.id] = world;
    saveDb();
    json(res, 200, { ok: true, worldId: world.id, token: token, code: world.code, codeExpires: world.codeExpires });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/pair/join') {
    readBody(req, function (err, body) {
      if (err) { json(res, err.message === 'TOO_LARGE' ? 413 : 400, { ok: false, code: err.message }); return; }
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 6) { json(res, 400, { ok: false, code: 'BAD_CODE', message: '配对码是 6 位' }); return; }
      let found = null;
      const ids = Object.keys(db.worlds);
      for (let i = 0; i < ids.length; i++) {
        const w = db.worlds[ids[i]];
        if (w.code === code && w.codeExpires > now()) { found = w; break; }
      }
      if (!found) { json(res, 404, { ok: false, code: 'NO_WORLD', message: '配对码无效或已过期' }); return; }
      const token = issueToken(found);
      saveDb();
      json(res, 200, { ok: true, worldId: found.id, token: token, rev: found.rev, updatedAt: found.updatedAt });
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/pair/code') {
    const world = findWorldByToken(req.headers['x-token'] || url.searchParams.get('token'));
    if (!world) { json(res, 401, { ok: false, code: 'NO_TOKEN' }); return; }
    const force = url.searchParams.get('force') === '1';
    ensureCode(world, force);
    saveDb();
    json(res, 200, { ok: true, code: world.code, codeExpires: world.codeExpires });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sync') {
    const world = findWorldByToken(req.headers['x-token'] || url.searchParams.get('token'));
    if (!world) { json(res, 401, { ok: false, code: 'NO_TOKEN' }); return; }
    json(res, 200, {
      ok: true,
      rev: world.rev,
      updatedAt: world.updatedAt,
      empty: !world.state,
      state: world.state || null
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/sync') {
    const world = findWorldByToken(req.headers['x-token']);
    if (!world) { json(res, 401, { ok: false, code: 'NO_TOKEN' }); return; }
    readBody(req, function (err, body) {
      if (err) { json(res, err.message === 'TOO_LARGE' ? 413 : 400, { ok: false, code: err.message }); return; }
      if (!validState(body.state)) { json(res, 400, { ok: false, code: 'BAD_STATE', message: '存档格式不对' }); return; }
      const base = Number(body.baseRev || 0);
      if (base !== world.rev) {
        json(res, 409, { ok: false, code: 'CONFLICT', rev: world.rev, updatedAt: world.updatedAt });
        return;
      }
      world.state = body.state;
      world.rev += 1;
      world.updatedAt = now();
      saveDb();
      json(res, 200, { ok: true, rev: world.rev, updatedAt: world.updatedAt });
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ai/chat') {
    const world = findWorldByToken(req.headers['x-token']);
    if (!world) { json(res, 401, { ok: false, code: 'NO_TOKEN' }); return; }
    readBody(req, function (err, body) {
      if (err) { json(res, err.message === 'TOO_LARGE' ? 413 : 400, { ok: false, code: err.message }); return; }
      proxyChat(world, body, res);
    });
    return;
  }

  json(res, 404, { ok: false, code: 'NOT_FOUND' });
});

loadDb();
server.listen(PORT, function () {
  console.log('oneday cloud listening on ' + PORT);
});