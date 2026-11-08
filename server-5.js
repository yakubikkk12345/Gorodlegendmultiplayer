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

// ---------- События: гонки, арена ----------
const RACE_PTS = [4, 4, 4];            // чекпоинтов на круге (совпадает с клиентом)
const RACE_LOOP = [true, true, false];
const nm = (room, id) => { const p = room.players.get(id); return p ? p.name : '?'; };
function clearTimers(o) { if (o && o.timers) o.timers.forEach(clearTimeout); if (o) o.timers = []; }
function raceLobby(room) {
  const r = room.race; if (!r) return;
  bcast(room, { t: 'race-lobby', host: r.host, players: r.joined.map((id, i) => ({ id, name: nm(room, id), slot: i })) });
}
function raceStart(room) {
  const r = room.race; if (!r || r.state !== 'lobby' || !r.joined.length) return;
  clearTimers(r); r.state = 'run'; r.startAt = Date.now() + 5000;
  bcast(room, { t: 'race-go', in: 5000, route: r.route, laps: r.laps, players: r.joined.map((id, i) => ({ id, name: nm(room, id), slot: i })) });
  r.timers.push(setTimeout(() => raceEnd(room), 600000));
}
function raceOrder(r) {
  return r.joined.slice().sort((a, b) => {
    const A = r.prog[a], B = r.prog[b];
    if (A.fin && B.fin) return A.place - B.place; if (A.fin) return -1; if (B.fin) return 1;
    return B.n - A.n || A.t - B.t;
  });
}
function raceEnd(room) {
  const r = room.race; if (!r) return; clearTimers(r);
  const ord = raceOrder(r);
  const results = ord.map((id, i) => ({ id, name: nm(room, id), place: r.prog[id].fin ? r.prog[id].place : 0, time: r.prog[id].fin ? r.prog[id].time : 0 }));
  room.race = null;
  bcast(room, { t: 'race-end', results });
}
function arenaLobby(room) {
  const a = room.arena; if (!a) return;
  bcast(room, { t: 'arena-lobby', host: a.host, players: [...a.teams].map(([id, team]) => ({ id, name: nm(room, id), team })) });
}
function arenaStart(room) {
  const a = room.arena; if (!a || a.state !== 'lobby') return;
  if (a.teams.size < 2) return bcast(room, { t: 'warn', msg: 'Для арены нужно минимум 2 игрока' });
  clearTimers(a); a.state = 'run'; a.score = [0, 0];
  bcast(room, { t: 'arena-go', target: a.target, ms: 300000, players: [...a.teams].map(([id, team]) => ({ id, name: nm(room, id), team })) });
  a.timers.push(setTimeout(() => arenaEnd(room, -2), 300000));
}
function arenaEnd(room, win) {
  const a = room.arena; if (!a) return; clearTimers(a);
  if (win === -2) win = a.score[0] === a.score[1] ? -1 : (a.score[0] > a.score[1] ? 0 : 1);
  room.arena = null;
  bcast(room, { t: 'arena-end', winner: win, s: a.score || [0, 0] });
}
function activityLeave(room, c) {
  const r = room.race;
  if (r && r.joined.includes(c.id)) {
    if (r.state === 'lobby') {
      r.joined = r.joined.filter(i => i !== c.id);
      if (c.id === r.host || !r.joined.length) { clearTimers(r); room.race = null; bcast(room, { t: 'race-cancel' }); } else raceLobby(room);
    } else {
      if (!r.prog[c.id].fin) r.prog[c.id].dnf = true;
      if (r.joined.every(i => i === c.id || r.prog[i].fin || !room.players.has(i))) raceEnd(room);
    }
  }
  const a = room.arena;
  if (a && a.teams.has(c.id)) {
    a.teams.delete(c.id);
    if (a.state === 'lobby') { if (c.id === a.host || !a.teams.size) { clearTimers(a); room.arena = null; bcast(room, { t: 'arena-cancel' }); } else arenaLobby(room); }
    else { const left = new Set([...a.teams.values()]); if (left.size < 2) arenaEnd(room, left.size ? [...left][0] : -1); }
  }
}

function leave(c) {
  if (c.dead) return;
  c.dead = true;
  const room = c.room;
  if (room && room.players.get(c.id) === c) {
    room.players.delete(c.id);
    activityLeave(room, c);
    bcast(room, { t: 'leave', id: c.id, name: c.name });
    if (!room.players.size) { clearTimers(room.race); clearTimers(room.arena); rooms.delete(room.code); }
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
      n: m.n ? 1 : 0, b: m.b ? 1 : 0, v: m.v ? 1 : 0, hp: num(m.hp, 0, 100, 100), pv: m.pv ? 1 : 0, ar: num(m.ar, -1.5, 1.5), wp: typeof m.wp === 'string' ? m.wp.replace(/[^a-z]/g, '').slice(0, 12) : '', sh: m.sh ? 1 : 0
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
    const ar = c.room.arena;
    if (ar && ar.state === 'run') { const ta = ar.teams.get(c.id), tb = ar.teams.get(tg.id); if (ta === undefined || tb === undefined || ta === tb) return; }
    send(tg, { t: 'hurt', from: c.id, dmg });
  } else if (m.t === 'died') {
    if (now - c.lastDied < 3000) return; c.lastDied = now;
    const k = c.room.players.get(+m.by), kk = k && k !== c && !k.dead ? k : null;
    bcast(c.room, { t: 'kill', victim: c.id, vname: c.name, killer: kk ? kk.id : 0, kname: kk ? kk.name : '' });
    const ar = c.room.arena;
    if (ar && ar.state === 'run' && kk && ar.teams.has(c.id) && ar.teams.has(kk.id) && ar.teams.get(c.id) !== ar.teams.get(kk.id)) {
      ar.score[ar.teams.get(kk.id)]++;
      bcast(c.room, { t: 'arena-score', s: ar.score });
      if (ar.score[ar.teams.get(kk.id)] >= ar.target) arenaEnd(c.room, ar.teams.get(kk.id));
    }
  } else if (m.t === 'race-open') {
    const room = c.room; if (room.race || room.arena) return send(c, { t: 'warn', msg: 'В комнате уже идёт событие' });
    const route = Math.max(0, Math.min(RACE_PTS.length - 1, m.route | 0)), laps = RACE_LOOP[route] ? Math.max(1, Math.min(3, m.laps | 0 || 1)) : 1;
    const r = room.race = { state: 'lobby', route, laps, host: c.id, joined: [c.id], prog: {}, fin: 0, timers: [] };
    r.prog[c.id] = { n: 0, t: 0 };
    bcast(room, { t: 'race-open', route, laps, host: c.id, hname: c.name });
    raceLobby(room);
    r.timers.push(setTimeout(() => raceStart(room), 60000));
  } else if (m.t === 'race-join') {
    const r = c.room.race; if (!r || r.state !== 'lobby' || r.joined.includes(c.id) || r.joined.length >= 4) return;
    r.joined.push(c.id); r.prog[c.id] = { n: 0, t: 0 }; raceLobby(c.room);
  } else if (m.t === 'race-leave') {
    const r = c.room.race; if (r && r.joined.includes(c.id)) activityLeave(c.room, c);
  } else if (m.t === 'race-start') {
    const r = c.room.race; if (r && r.host === c.id) raceStart(c.room);
  } else if (m.t === 'race-cancel') {
    const r = c.room.race; if (r && r.host === c.id && r.state === 'lobby') { clearTimers(r); c.room.race = null; bcast(c.room, { t: 'race-cancel' }); }
  } else if (m.t === 'race-cp') {
    const room = c.room, r = room.race; if (!r || r.state !== 'run' || now < r.startAt) return;
    const pr = r.prog[c.id]; if (!pr || pr.fin || pr.dnf) return;
    if ((m.n | 0) !== pr.n + 1 || now - pr.t < 1500) return;
    pr.n++; pr.t = now;
    const total = RACE_PTS[r.route] * r.laps;
    if (pr.n >= total) {
      pr.fin = true; pr.time = now - r.startAt; pr.place = ++r.fin;
      bcast(room, { t: 'race-fin', id: c.id, name: c.name, place: pr.place, time: pr.time });
      if (pr.place === 1) r.timers.push(setTimeout(() => raceEnd(room), 40000));
    }
    bcast(room, { t: 'race-pos', order: raceOrder(r), n: Object.fromEntries(r.joined.map(i => [i, r.prog[i].n])) });
    if (r.joined.every(i => r.prog[i].fin || r.prog[i].dnf || !room.players.has(i))) raceEnd(room);
  } else if (m.t === 'arena-open') {
    const room = c.room; if (room.race || room.arena) return send(c, { t: 'warn', msg: 'В комнате уже идёт событие' });
    const target = [5, 10, 15, 20].includes(m.target | 0) ? m.target | 0 : 10;
    const a = room.arena = { state: 'lobby', host: c.id, teams: new Map([[c.id, 0]]), score: [0, 0], target, timers: [] };
    bcast(room, { t: 'arena-open', target, host: c.id, hname: c.name });
    arenaLobby(room);
    a.timers.push(setTimeout(() => arenaStart(room), 90000));
  } else if (m.t === 'arena-join') {
    const a = c.room.arena; if (!a || a.state !== 'lobby' || a.teams.has(c.id)) return;
    const cnt = [0, 0]; for (const t of a.teams.values()) cnt[t]++;
    a.teams.set(c.id, cnt[0] <= cnt[1] ? 0 : 1); arenaLobby(c.room);
  } else if (m.t === 'arena-leave') {
    const a = c.room.arena; if (a && a.teams.has(c.id)) activityLeave(c.room, c);
  } else if (m.t === 'arena-start') {
    const a = c.room.arena; if (a && a.host === c.id) arenaStart(c.room);
  } else if (m.t === 'arena-cancel') {
    const a = c.room.arena; if (a && a.host === c.id && a.state === 'lobby') { clearTimers(a); c.room.arena = null; bcast(c.room, { t: 'arena-cancel' }); }
  } else if (m.t === 'trade') {
    if (now - c.trW > 1000) { c.trW = now; c.trN = 0; }
    if (++c.trN > 8) return;
    const tg = c.room.players.get(+m.to); if (!tg || tg === c || !m.d || typeof m.d !== 'object') return;
    let js; try { js = JSON.stringify(m.d); } catch (e) { return; }
    if (js.length > 900) return;
    send(tg, { t: 'trade', from: c.id, name: c.name, d: m.d });
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
  const c = { socket, buf: Buffer.alloc(0), room: null, id: 0, name: '', alive: true, dead: false, lastS: 0, lastChat: 0, state: null, hitW: 0, hitN: 0, lastDied: 0, trW: 0, trN: 0 };
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
