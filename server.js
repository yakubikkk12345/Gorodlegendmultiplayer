// Город легенд — мультиплеер-сервер (без зависимостей, Node 18+)
// Запуск: node server.js   (PORT=8080 по умолчанию)
// На хостинге (Render/Railway/Fly.io) TLS обеспечивает платформа: клиент подключается по wss://ваш-домен
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const MAX_PLAYERS = 4;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 8192;
const COLORS = ['#ff4d4d', '#3da5ff', '#3dff8a', '#ffd60a'];

const rooms = new Map(); // code -> { code, players: Map(id->client), nextId }

function sanitizeName(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 16);
  return s || 'Игрок';
}
function sanitizeCode(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let t = 0; t < 50; t++) {
    let c = ''; for (let i = 0; i < 5; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const num = (v, lo, hi, d = 0) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : d;

// ---------- WebSocket (RFC 6455) ----------
function encode(str, op = 1) {
  const payload = Buffer.from(str);
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}
function send(c, obj) {
  if (c.dead || c.socket.destroyed) return;
  try { c.socket.write(encode(JSON.stringify(obj))); } catch (e) { /* ignore */ }
}
function bcast(room, obj, exceptId) {
  const frame = encode(JSON.stringify(obj));
  for (const p of room.players.values()) {
    if (p.id === exceptId || p.dead || p.socket.destroyed) continue;
    try { p.socket.write(frame); } catch (e) { /* ignore */ }
  }
}

function leave(c) {
  if (c.dead) return;
  c.dead = true;
  const room = c.room;
  if (room && room.players.get(c.id) === c) {
    room.players.delete(c.id);
    bcast(room, { t: 'leave', id: c.id, name: c.name });
    if (!room.players.size) rooms.delete(room.code);
  }
  try { c.socket.destroy(); } catch (e) { /* ignore */ }
}

function handle(c, m) {
  if (!m || typeof m !== 'object') return;
  const now = Date.now();
  if (m.t === 'join') {
    if (c.room) return;
    c.name = sanitizeName(m.name);
    let code = sanitizeCode(m.room);
    let room;
    if (m.create || !code) {
      code = genCode();
      if (!code) return send(c, { t: 'err', msg: 'Сервер занят, попробуйте позже' });
      room = { code, players: new Map(), nextId: 1 };
      rooms.set(code, room);
    } else {
      room = rooms.get(code);
      if (!room) return send(c, { t: 'err', msg: 'Комната ' + code + ' не найдена' });
    }
    if (room.players.size >= MAX_PLAYERS) return send(c, { t: 'err', msg: 'Комната заполнена (макс. ' + MAX_PLAYERS + ')' });
    let slot = 0; const used = new Set([...room.players.values()].map(p => p.slot));
    while (used.has(slot)) slot++;
    c.id = room.nextId++; c.slot = slot; c.room = room; c.col = COLORS[slot % COLORS.length];
    room.players.set(c.id, c);
    send(c, {
      t: 'welcome', id: c.id, room: room.code, col: c.col,
      players: [...room.players.values()].filter(p => p !== c).map(p => ({ id: p.id, name: p.name, col: p.col, s: p.state }))
    });
    bcast(room, { t: 'join', id: c.id, name: c.name, col: c.col }, c.id);
    return;
  }
  if (!c.room) return;
  if (m.t === 's') { // снимок состояния
    if (now - c.lastS < 40) return; // не чаще ~25 Гц
    c.lastS = now;
    const s = {
      x: num(m.x, -5000, 5000), y: num(m.y, -100, 2000), z: num(m.z, -5000, 5000), h: num(m.h, -20, 20),
      ph: num(m.ph, -1e6, 1e6), am: num(m.am, 0, 3),
      car: typeof m.car === 'string' ? m.car.slice(0, 24) : null,
      cc: typeof m.cc === 'string' ? m.cc.slice(0, 9) : null,
      st: num(m.st, -2, 2), sp: num(m.sp, -200, 200), pi: num(m.pi, -2, 2), ro: num(m.ro, -2, 2),
      n: m.n ? 1 : 0, b: m.b ? 1 : 0, v: m.v ? 1 : 0, hp: num(m.hp, 0, 100, 100), pv: m.pv ? 1 : 0
    };
    c.state = s;
    bcast(c.room, { t: 's', id: c.id, s }, c.id);
  } else if (m.t === 'hit') {
    if (now - c.hitW > 1000) { c.hitW = now; c.hitN = 0; }
    if (++c.hitN > 60) return;
    const tg = c.room.players.get(+m.id); if (!tg || tg === c || tg.dead) return;
    const dmg = num(m.dmg, 0, 45); if (dmg <= 0) return;
    if (!c.state || !tg.state || !c.state.pv || !tg.state.pv) return;
    if (Math.hypot(c.state.x - tg.state.x, c.state.z - tg.state.z) > 260) return;
    send(tg, { t: 'hurt', from: c.id, dmg });
  } else if (m.t === 'died') {
    if (now - c.lastDied < 3000) return; c.lastDied = now;
    const k = c.room.players.get(+m.by), kk = k && k !== c && !k.dead ? k : null;
    bcast(c.room, { t: 'kill', victim: c.id, vname: c.name, killer: kk ? kk.id : 0, kname: kk ? kk.name : '' });
  } else if (m.t === 'chat') {
    if (now - c.lastChat < 600) return;
    c.lastChat = now;
    const text = String(m.text == null ? '' : m.text).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
    if (!text) return;
    bcast(c.room, { t: 'chat', id: c.id, name: c.name, col: c.col, text });
  } else if (m.t === 'ping') {
    send(c, { t: 'pong', ts: m.ts });
  }
}

function onData(c, buf) {
  c.buf = c.buf.length ? Buffer.concat([c.buf, buf]) : buf;
  if (c.buf.length > MAX_FRAME * 4) return leave(c);
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) return leave(c); len = Number(big); off = 10; }
    if (len > MAX_FRAME || !masked) return leave(c);
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4);
    const data = Buffer.alloc(len);
    for (let i = 0; i < len; i++) data[i] = b[off + 4 + i] ^ mask[i & 3];
    c.buf = b.subarray(off + 4 + len);
    if (op === 8) { try { c.socket.write(encode('', 8)); } catch (e) { /* */ } return leave(c); }
    if (op === 9) { try { c.socket.write(encode(data.toString('latin1'), 10)); } catch (e) { /* */ } continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1) {
      let m = null; try { m = JSON.parse(data.toString('utf8')); } catch (e) { /* */ }
      c.alive = true;
      if (m) handle(c, m);
    }
  }
}

const fs = require('fs'), path = require('path');
const GAME_FILES = ['index.html', 'gorod-legend-v27.html'];
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    for (const n of GAME_FILES) {
      const p = path.join(__dirname, n);
      if (fs.existsSync(p)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(p).pipe(res); }
    }
  }
  const ST = { '/manifest.json': 'application/manifest+json', '/sw.js': 'application/javascript', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' };
  if (ST[url]) {
    const p = path.join(__dirname, url.slice(1));
    if (fs.existsSync(p)) { res.writeHead(200, { 'Content-Type': ST[url], 'Cache-Control': 'no-cache' }); return fs.createReadStream(p).pipe(res); }
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  let n = 0; for (const r of rooms.values()) n += r.players.size;
  res.end('Город легенд: сервер работает. Комнат: ' + rooms.size + ', игроков: ' + n + '\n');
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { socket, buf: Buffer.alloc(0), room: null, id: 0, name: '', alive: true, dead: false, lastS: 0, lastChat: 0, state: null, hitW: 0, hitN: 0, lastDied: 0 };
  socket.on('data', d => { try { onData(c, d); } catch (e) { leave(c); } });
  socket.on('end', () => leave(c));
  socket.on('close', () => leave(c));
  socket.on('error', () => leave(c));
  // таймаут на вход в комнату
  setTimeout(() => { if (!c.room) leave(c); }, 15000).unref();
  c.hb = true;
  const iv = setInterval(() => {
    if (c.dead) return clearInterval(iv);
    if (!c.alive) return leave(c);
    c.alive = false;
    try { socket.write(encode('', 9)); } catch (e) { /* */ }
  }, 20000);
  iv.unref();
});
server.listen(PORT, () => console.log('Город легенд: мультиплеер-сервер на порту ' + PORT));
module.exports = server;
