// Город легенд — мультиплеер-сервер (без зависимостей, Node 18+)
// Запуск: node server.js   (PORT=8080 по умолчанию)
// На хостинге (Render/Railway/Fly.io) TLS обеспечивает платформа: клиент подключается по wss://ваш-домен
// v51: облачные сохранения по коду (/api/cloud/*, файл cloud-saves.json).
// v44: кооперативные ограбления (heist-*) — ювелирный, банк, хранилище.
// v39: список игроков онлайн, общий чат и приглашения в комнату (лобби без комнаты).
// v34: добавлены покер для игроков (2 стола в казино) и общий джекпот комнаты.
'use strict';
const http = require('http');
const fs = require('fs'), path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const MAX_PLAYERS = 4;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 8192;
const COLORS = ['#ff4d4d', '#3da5ff', '#3dff8a', '#ffd60a'];

const clients = new Set(); let gidSeq = 0;
const sanUid = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
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
  if (room.heist) hxLeave(room, c);
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

// ---------- v34: КАЗИНО — покер для игроков (лимит-холдем, 2 стола) и общий джекпот ----------
// Ставки фиксированные (лимит): блайнды 250/500, ставка 500 на префлопе и флопе, 1000 на тёрне и ривере, не более 4 ставок за круг.
// Максимум, который игрок может внести за раздачу, — 12 000, поэтому за стол пускают со стеком от 12 500 и сайд-потов не бывает.
const PK = { SB: 250, BB: 500, MIN: 12500, BUYMIN: 15000, BUYMAX: 100000, STACKMAX: 200000, TURN: 30000, NEXT: 4500, SHOW: 6000 };
const PK_CAT = ['Старшая карта', 'Пара', 'Две пары', 'Сет', 'Стрит', 'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш'];
function pkShuffle() {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = crypto.randomInt(i + 1); const x = d[i]; d[i] = d[j]; d[j] = x; }
  return d;
}
function pk5(r, s) {
  const cnt = {}; for (const x of r) cnt[x] = (cnt[x] || 0) + 1;
  const grp = Object.keys(cnt).map(Number).sort((a, b) => cnt[b] - cnt[a] || b - a);
  const flush = s.every(x => x === s[0]);
  const u = [...new Set(r)].sort((a, b) => b - a); let st = 0;
  if (u.length === 5) { if (u[0] - u[4] === 4) st = u[0]; else if (u[0] === 14 && u[1] === 5) st = 5; }
  let cat;
  if (st && flush) cat = 8; else if (cnt[grp[0]] === 4) cat = 7; else if (cnt[grp[0]] === 3 && cnt[grp[1]] === 2) cat = 6;
  else if (flush) cat = 5; else if (st) cat = 4; else if (cnt[grp[0]] === 3) cat = 3;
  else if (cnt[grp[0]] === 2 && cnt[grp[1]] === 2) cat = 2; else if (cnt[grp[0]] === 2) cat = 1; else cat = 0;
  const k = st ? [st] : grp; let v = cat; for (let i = 0; i < 5; i++) v = v * 15 + (k[i] || 0);
  return v;
}
function pkBest7(cs) {
  let best = -1;
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 7; b++) {
    const r = [], s = [];
    for (let i = 0; i < 7; i++) if (i !== a && i !== b) { r.push(cs[i] % 13 + 2); s.push(Math.floor(cs[i] / 13)); }
    const v = pk5(r, s); if (v > best) best = v;
  }
  return best;
}
const pkCatOf = sc => Math.floor(sc / 759375);
const pkSz = t => (t.street < 2 ? PK.BB : PK.BB * 2);
function pkTable(room, i) {
  if (!room.pk) room.pk = [null, null];
  return room.pk[i] || (room.pk[i] = { i, seats: [null, null, null, null], watch: new Set(), state: 'wait', dealer: -1, deck: [], board: [], pot: 0, street: 0, cur: -1, bet: 0, raises: 0, timer: null, next: null, deadline: 0, log: 'Ждём игроков' });
}
function pkView(t, id) {
  const me = t.seats.findIndex(s => s && s.id === id), show = t.state === 'show';
  return {
    t: 'pk-state', tbl: t.i, you: me, st: t.state, dealer: t.dealer, cur: t.cur, pot: t.pot, bet: t.bet, street: t.street, board: t.board, sz: pkSz(t), raises: t.raises,
    tleft: t.state === 'play' ? Math.max(0, t.deadline - Date.now()) : 0, log: t.log, min: PK.MIN,
    seats: t.seats.map((s, k) => !s ? null : {
      id: s.id, name: s.name, chips: s.chips, put: s.put, folded: !!s.folded, inHand: !!s.inHand, win: s.win || 0, hn: show && s.inHand && !s.folded ? (s.hn || '') : '',
      hole: s.inHand ? ((k === me || (show && !s.folded)) ? s.hole : [-1, -1]) : null
    })
  };
}
function pkPush(room, t) {
  const ids = new Set(t.watch); for (const s of t.seats) if (s) ids.add(s.id);
  for (const id of ids) { const p = room.players.get(id); if (p) send(p, pkView(t, id)); else t.watch.delete(id); }
}
function pkReset(t) { clearTimeout(t.timer); clearTimeout(t.next); t.timer = null; t.next = null; t.state = 'wait'; t.cur = -1; t.pot = 0; t.board = []; t.bet = 0; t.log = 'Ждём игроков'; }
function pkSchedule(room, t) {
  if (t.state !== 'wait' || t.next) return;
  const n = t.seats.filter(s => s && s.chips >= PK.MIN).length;
  if (n < 2) { t.log = 'Ждём игроков (нужно двое, у каждого от $' + PK.MIN + ')'; return; }
  t.log = 'Новая раздача через несколько секунд…';
  t.next = setTimeout(() => { t.next = null; pkDeal(room, t); }, PK.NEXT);
}
function pkNext(t, from, f) { for (let d = 1; d <= 4; d++) { const k = (from + d) % 4; if (f(t.seats[k], k)) return k; } return -1; }
function pkDeal(room, t) {
  const act = []; t.seats.forEach((s, k) => { if (s && s.chips >= PK.MIN) act.push(k); });
  if (act.length < 2) { t.state = 'wait'; pkSchedule(room, t); pkPush(room, t); return; }
  t.state = 'play'; t.deck = pkShuffle(); t.board = []; t.pot = 0; t.street = 0; t.raises = 1;
  t.seats.forEach(s => { if (s) { s.inHand = false; s.folded = false; s.put = 0; s.tot = 0; s.acted = false; s.win = 0; s.hn = ''; s.hole = []; } });
  act.forEach(k => { const s = t.seats[k]; s.inHand = true; s.hole = [t.deck.pop(), t.deck.pop()]; });
  const inH = s => s && s.inHand;
  t.dealer = pkNext(t, t.dealer < 0 ? 3 : t.dealer, inH);
  const heads = act.length === 2;
  const sb = heads ? t.dealer : pkNext(t, t.dealer, inH), bb = pkNext(t, sb, inH);
  const post = (k, amt) => { const s = t.seats[k]; s.chips -= amt; s.put += amt; s.tot += amt; t.pot += amt; };
  post(sb, PK.SB); post(bb, PK.BB); t.bet = PK.BB;
  t.cur = pkNext(t, bb, inH);
  t.log = 'Раздача: блайнды $' + PK.SB + ' / $' + PK.BB;
  pkTurn(room, t);
}
function pkTurn(room, t) {
  clearTimeout(t.timer); t.deadline = Date.now() + PK.TURN; const k = t.cur;
  t.timer = setTimeout(() => {
    const s = t.seats[k]; if (!s || t.cur !== k || t.state !== 'play') return;
    s.to = (s.to || 0) + 1; if (s.to >= 2) s.kick = true;
    pkAct(room, t, k, t.bet === s.put ? 'call' : 'fold', true);
  }, PK.TURN + 200);
  pkPush(room, t);
}
function pkAct(room, t, k, a, auto) {
  const s = t.seats[k]; if (!s || t.state !== 'play' || t.cur !== k) return;
  let msg; if (!auto) s.to = 0;
  if (a === 'fold') { s.folded = true; msg = s.name + ' — фолд'; }
  else {
    if (a === 'raise' && t.raises >= 4) a = 'call';
    if (a === 'raise') { t.bet += pkSz(t); t.raises++; }
    const need = t.bet - s.put; s.chips -= need; s.put += need; s.tot += need; t.pot += need; s.acted = true;
    if (a === 'raise') { t.seats.forEach((o, j) => { if (o && o.inHand && !o.folded && j !== k) o.acted = false; }); msg = s.name + ' — рейз до $' + t.bet; }
    else msg = s.name + (need ? ' — колл $' + need : ' — чек');
  }
  t.log = msg; pkAdvance(room, t, k);
}
function pkAdvance(room, t, k) {
  const live = []; t.seats.forEach((o, j) => { if (o && o.inHand && !o.folded) live.push(j); });
  if (live.length <= 1) return pkEnd(room, t, live);
  const open = live.filter(j => !t.seats[j].acted || t.seats[j].put !== t.bet);
  if (open.length) {
    t.cur = pkNext(t, k, (o, j) => live.includes(j) && (!o.acted || o.put !== t.bet));
    return pkTurn(room, t);
  }
  if (t.street === 3) return pkShowdown(room, t, live);
  t.street++; t.bet = 0; t.raises = 0; t.seats.forEach(o => { if (o) { o.put = 0; o.acted = false; } });
  const n = t.street === 1 ? 3 : 1; for (let i = 0; i < n; i++) t.board.push(t.deck.pop());
  t.cur = pkNext(t, t.dealer, (o, j) => live.includes(j));
  pkTurn(room, t);
}
function pkPay(t, winners, msg) {
  const share = Math.floor(t.pot / winners.length);
  winners.forEach((j, i) => { const s = t.seats[j]; const g = share + (i === 0 ? t.pot - share * winners.length : 0); s.chips += g; s.win = g; });
  t.pot = 0; t.log = msg;
}
function pkEnd(room, t, live) {
  clearTimeout(t.timer); t.state = 'show'; t.cur = -1;
  if (live.length) pkPay(t, live, t.seats[live[0]].name + ' забирает банк');
  pkAfter(room, t);
}
function pkShowdown(room, t, live) {
  clearTimeout(t.timer); t.state = 'show'; t.cur = -1;
  let best = -1, win = [];
  for (const j of live) {
    const s = t.seats[j]; s.sc = pkBest7(s.hole.concat(t.board)); s.hn = PK_CAT[pkCatOf(s.sc)];
    if (s.sc > best) { best = s.sc; win = [j]; } else if (s.sc === best) win.push(j);
  }
  pkPay(t, win, win.map(j => t.seats[j].name).join(' и ') + (win.length > 1 ? ' делят банк' : ' выигрывает банк') + ' — ' + t.seats[win[0]].hn);
  pkAfter(room, t);
}
function pkAfter(room, t) {
  pkPush(room, t);
  t.timer = setTimeout(() => {
    t.timer = null;
    t.seats.forEach((s, k) => { if (s && s.kick) pkCash(room, t, k, 'Вы вышли из-за стола (бездействие)'); });
    t.state = 'wait'; t.cur = -1; t.board = []; t.bet = 0;
    t.seats.forEach(s => { if (s) { s.inHand = false; s.hole = []; s.put = 0; s.win = 0; s.hn = ''; s.folded = false; } });
    t.log = 'Ждём следующую раздачу'; pkSchedule(room, t); pkPush(room, t);
  }, PK.SHOW);
}
function pkCash(room, t, k, msg) {
  const s = t.seats[k]; if (!s) return;
  const p = room.players.get(s.id); if (p) send(p, { t: 'pk-cash', tbl: t.i, amt: Math.max(0, Math.floor(s.chips)), msg: msg || '' });
  t.seats[k] = null;
  if (!t.seats.some(Boolean)) { pkReset(t); }
  pkPush(room, t);
}
function pkLeave(room, c) {
  if (!room.pk) return;
  for (const t of room.pk) {
    if (!t) continue;
    t.watch.delete(c.id);
    const k = t.seats.findIndex(s => s && s.id === c.id); if (k < 0) continue;
    const s = t.seats[k];
    if (t.state === 'play' && s.inHand && !s.folded) {
      if (t.cur === k) pkAct(room, t, k, 'fold', true);
      else { s.folded = true; t.log = s.name + ' покинул стол'; pkAdvance(room, t, t.cur >= 0 ? t.cur : k); }
    }
    if (t.seats[k] === s) pkCash(room, t, k, '');
  }
  if (!room.players.size) for (const t of room.pk) if (t) pkReset(t);
}
const jpRoom = room => room.jp || (room.jp = { pool: 100000 });
function casinoHandle(c, m, now) {
  const room = c.room;
  if (now - (c.csW || 0) > 1000) { c.csW = now; c.csN = 0; }
  if (++c.csN > 10) return;
  if (m.t === 'jp-get') return send(c, { t: 'jp', pool: jpRoom(room).pool });
  if (m.t === 'jp-bet') {
    const n = Math.floor(num(m.n, 0, 1000000)); if (n < 10) return;
    const jp = jpRoom(room); jp.pool += Math.floor(n * 0.03);
    const p = Math.min(0.004, Math.max(0.00002, n / 4e6));
    if (crypto.randomInt(1000000) < p * 1000000) {
      const amt = jp.pool; jp.pool = 100000;
      bcast(room, { t: 'jp-win', id: c.id, name: c.name, amt, pool: jp.pool });
    } else send(c, { t: 'jp', pool: jp.pool });
    return;
  }
  const ti = m.tbl | 0; if (ti < 0 || ti > 1) return;
  const t = pkTable(room, ti);
  const mine = () => t.seats.findIndex(s => s && s.id === c.id);
  if (m.t === 'pk-peek') { if (mine() < 0) t.watch.add(c.id); return send(c, pkView(t, c.id)); }
  if (m.t === 'pk-unwatch') { t.watch.delete(c.id); return; }
  if (m.t === 'pk-sit') {
    const buy = Math.floor(num(m.buy, 0, PK.BUYMAX));
    if (buy < PK.BUYMIN) return send(c, { t: 'pk-deny', refund: buy > 0 ? buy : 0, msg: 'Минимальный вход — $' + PK.BUYMIN });
    if (room.pk.some(x => x && x.seats.some(s => s && s.id === c.id))) return send(c, { t: 'pk-deny', refund: buy, msg: 'Вы уже за столом' });
    const k = t.seats.findIndex(s => !s);
    if (k < 0) return send(c, { t: 'pk-deny', refund: buy, msg: 'За столом нет мест' });
    t.seats[k] = { id: c.id, name: c.name, chips: buy, hole: [], inHand: false, folded: false, put: 0, tot: 0, acted: false, win: 0, hn: '', to: 0 };
    t.watch.delete(c.id);
    t.log = c.name + ' садится за стол'; send(c, { t: 'pk-seat', tbl: ti });
    if (t.state === 'wait') pkSchedule(room, t);
    return pkPush(room, t);
  }
  const k = mine(); if (k < 0) return;
  if (m.t === 'pk-leave') return pkLeave(room, c);
  if (m.t === 'pk-act') { if (m.a === 'fold' || m.a === 'call' || m.a === 'raise') pkAct(room, t, k, m.a, false); return; }
  if (m.t === 'pk-add') {
    const buy = Math.floor(num(m.buy, 0, PK.BUYMAX)), s = t.seats[k];
    if (buy < 1000 || (t.state === 'play' && s.inHand) || s.chips + buy > PK.STACKMAX) return send(c, { t: 'pk-deny', refund: buy, msg: 'Докупить сейчас нельзя' });
    s.chips += buy; t.log = c.name + ' докупает фишки'; if (t.state === 'wait') pkSchedule(room, t);
    return pkPush(room, t);
  }
}

// ---------- v44: КООПЕРАТИВНЫЕ ОГРАБЛЕНИЯ (комната до 4 игроков, этапы и роли проверяет сервер) ----------
// Цели совпадают с магазинами клиента: координаты = центр блока (HALF=640, PITCH=80), метка смещена на -12 по Z.
const HX_BC = i => -640 + (i + 0.5) * 80;
const HEIST_T = {
  jewel: { name: 'Ювелирный «Бриллиант»', ico: '💎', b: [1, 6], min: 2, time: 360, pay: [24000, 34000], need: 'Ювелирный: взлом сигнализации → охрана → витрины → уход',
    st: [{ k: 'hack', ch: 2, ms: 9000 }, { k: 'guards', n: 4, ms: 8000 }, { k: 'vault', ch: 3, ms: 12000 }, { k: 'escape', ms: 15000 }] },
  bank: { name: 'Банк «Столичный»', ico: '🏦', b: [7, 5], min: 2, time: 540, pay: [80000, 110000], need: 'Банк: взлом → охрана → бурение → подкрепление → уход',
    st: [{ k: 'hack', ch: 3, ms: 12000 }, { k: 'guards', n: 6, ms: 12000 }, { k: 'vault', ch: 4, ms: 18000 }, { k: 'guards', n: 7, ms: 12000 }, { k: 'escape', ms: 20000 }] },
  vault: { name: 'Хранилище «Народный»', ico: '💰', b: [12, 12], min: 3, time: 720, pay: [190000, 260000], need: 'Хранилище: минимум 3 игрока. Три волны охраны, сейф с 5 замками',
    st: [{ k: 'hack', ch: 4, ms: 14000 }, { k: 'guards', n: 7, ms: 14000 }, { k: 'vault', ch: 5, ms: 22000 }, { k: 'guards', n: 9, ms: 14000 }, { k: 'vault', ch: 4, ms: 18000 }, { k: 'escape', ms: 25000 }] },
  // v58: БОЛЬШИЕ ДЕЛА — планы (тихо/громко/хитро), выбор ролей, осложнения, дело дня и возможность кинуть команду
  casino: { name: 'Казино «Золотой дракон»', ico: '🎰', b: [10, 10], min: 3, time: 780, pay: [300000, 420000], need: 'Казино: взлом → охрана → хранилище → подкрепление → касса → уход',
    st: [{ k: 'hack', ch: 4, ms: 14000 }, { k: 'guards', n: 8, ms: 14000 }, { k: 'vault', ch: 5, ms: 22000 }, { k: 'guards', n: 9, ms: 14000 }, { k: 'vault', ch: 4, ms: 18000 }, { k: 'escape', ms: 25000 }] },
  port: { name: 'Порт «Старый порт»', ico: '⚓', b: [1, 1], min: 3, time: 840, pay: [420000, 560000], need: 'Порт: два взлома, контейнеры и две волны охраны',
    st: [{ k: 'hack', ch: 4, ms: 14000 }, { k: 'guards', n: 8, ms: 14000 }, { k: 'vault', ch: 5, ms: 22000 }, { k: 'guards', n: 10, ms: 14000 }, { k: 'hack', ch: 4, ms: 14000 }, { k: 'vault', ch: 5, ms: 22000 }, { k: 'escape', ms: 25000 }] },
  tower: { name: 'Небоскрёб «Капитал»', ico: '🏙', b: [5, 5], min: 4, time: 900, pay: [600000, 800000], need: 'Небоскрёб: 4 игрока, три сейфа и три взлома',
    st: [{ k: 'hack', ch: 5, ms: 14000 }, { k: 'guards', n: 9, ms: 14000 }, { k: 'hack', ch: 5, ms: 14000 }, { k: 'vault', ch: 6, ms: 24000 }, { k: 'guards', n: 11, ms: 14000 }, { k: 'vault', ch: 5, ms: 22000 }, { k: 'escape', ms: 28000 }] }
};
const HX_KEYS = ['jewel', 'bank', 'vault', 'casino', 'port', 'tower'];
const hxFeatured = () => HX_KEYS[Math.floor(Date.now() / 86400000) % HX_KEYS.length];
const HX_PLANS = { quiet: { pm: 1.0, tf: 45000, te: 70000, time: 1.2 }, loud: { pm: 1.3, tf: 10000, te: 25000, time: 0.75 }, clever: { pm: 1.15, tf: 35000, te: 55000, time: 1.0 } };
function hxBuild(T, plan) {        // этапы под выбранный план
  let st = T.st.map(x => Object.assign({}, x));
  if (plan === 'quiet') st = st.map(x => x.k === 'guards' ? { k: 'hack', ch: 3, ms: 9000 } : x);
  else if (plan === 'loud') st = st.filter(x => x.k !== 'hack').map(x => x.k === 'guards' ? Object.assign(x, { n: Math.ceil(x.n * 1.4) }) : x);
  else if (plan === 'clever') { st = st.map(x => x.k === 'guards' ? Object.assign(x, { n: Math.max(3, Math.round(x.n * 0.7)) }) : x); st.unshift({ k: 'swap', ch: 2, ms: 8000 }); }
  if (!st.some(x => x.k === 'vault')) st.splice(Math.max(0, st.length - 1), 0, { k: 'vault', ch: 4, ms: 14000 });
  return st;
}
const HX_ROLE = { hack: 'Хакер', guards: 'Стрелок', vault: 'Взломщик', escape: 'Водитель', swap: 'Подмена' };
const HX_PICK = ['hack', 'vault', 'escape', 'guards'];
const STAGE_ROLE = { hack: 'hack', vault: 'vault', swap: 'escape' };
const hxPos = h => ({ x: HX_BC(h.T.b[0]), z: HX_BC(h.T.b[1]) - 12 });
function hxTeam(room, h) { return h.ids.filter(id => room.players.has(id)); }
function hxActor(room, h, k) {      // кто выполняет этап: хакер/взломщик — по ролям, стрелки и побег — любой из команды
  const team = hxTeam(room, h); if (!team.length) return 0;
  const want = STAGE_ROLE[k]; if (!want) return 0;
  const alive = team.filter(i => !h.down || !h.down.has(i)), pool = alive.length ? alive : team;
  const by = pool.filter(i => h.roles && h.roles[i] === want); if (by.length) return by[0];
  const ri = { hack: 0, vault: 1, swap: 2 }[k]; return pool[ri % pool.length];
}
function hxLobby(room) {
  const h = room.heist; if (!h) return;
  bcast(room, { t: 'heist-lobby', kind: h.kind, host: h.host, min: h.T.min, plan: h.plan, feat: hxFeatured() === h.kind, players: h.ids.map(id => ({ id, name: nm(room, id), role: (h.roles && h.roles[id]) || '' })) });
}
function hxStage(room) {
  const h = room.heist; if (!h) return; const s = h.st[h.i];
  h.stAt = Date.now();
  if (!s.cx && h.i > 0 && s.k !== 'escape' && Math.random() < 0.3) {    // осложнение
    s.cx = 1; const r = Math.random();
    if (r < 0.3) { h.st.splice(h.i + 1, 0, { k: 'guards', n: 3, ms: 5000, cx: 1 }); bcast(room, { t: 'heist-note', msg: '⚠ Осложнение: патруль на подходе — придётся отбиться (+1 этап)' }); }
    else if (r < 0.55) { h.alarm = Math.min(4, h.alarm + 1); bcast(room, { t: 'heist-alarm', stars: Math.min(5, h.alarm + 1) }); bcast(room, { t: 'heist-note', msg: '⚠ Осложнение: сработала скрытая сигнализация — розыск растёт' }); }
    else if (r < 0.8 && s.ch) { s.ch++; bcast(room, { t: 'heist-note', msg: '⚠ Осложнение: замок оказался сложнее — на одну попытку больше' }); }
    else { h.fails = Math.max(0, h.fails - 1); bcast(room, { t: 'heist-note', msg: '🍀 Повезло: подкупленный охранник открыл дверь — одна ошибка прощена' }); }
  }
  bcast(room, { t: 'heist-stage', i: h.i, of: h.st.length, k: s.k, ch: s.ch || 0, n: s.n || 0, actor: hxActor(room, h, s.k), aname: nm(room, hxActor(room, h, s.k)), role: HX_ROLE[s.k], left: Math.max(0, h.endAt - Date.now()) });
}
function hxStart(room) {
  const h = room.heist; if (!h || h.state !== 'lobby') return;
  const team = hxTeam(room, h);
  if (team.length < h.T.min) return bcast(room, { t: 'warn', msg: 'Для «' + h.T.name + '» нужно минимум ' + h.T.min + ' игрока' });
  const PL = HX_PLANS[h.plan] || HX_PLANS.quiet; h.plan = HX_PLANS[h.plan] ? h.plan : 'quiet';
  const picked = new Set(team.map(id => h.roles && h.roles[id]).filter(Boolean));
  h.full = HX_PICK.every(r => picked.has(r)) && team.length >= 4;
  h.st = hxBuild(h.T, h.plan); h.cut = new Set(); h.feat = hxFeatured() === h.kind;
  clearTimers(h); h.state = 'run'; h.i = 0; h.fails = 0; h.alarm = 0; h.down = new Set(); h.startAt = Date.now(); h.endAt = h.startAt + h.T.time * PL.time * 1000;
  bcast(room, { t: 'heist-go', kind: h.kind, name: h.T.name, ico: h.T.ico, x: hxPos(h).x, z: hxPos(h).z, total: h.st.length, plan: h.plan, feat: h.feat, time: h.T.time * PL.time * 1000, players: team.map(id => ({ id, name: nm(room, id) })) });
  hxStage(room);
  h.timers.push(setTimeout(() => hxEnd(room, false, 'Время вышло — группа не успела уйти'), h.T.time * PL.time * 1000));
  const tick = () => {      // тревога растёт: каждые 40 с +1 звезда розыска у всей команды
    if (!room.heist || room.heist !== h || h.state !== 'run') return;
    if (h.alarm < 4) { h.alarm++; bcast(room, { t: 'heist-alarm', stars: Math.min(5, h.alarm + 1) }); }
    h.timers.push(setTimeout(tick, PL.te));
  };
  h.timers.push(setTimeout(tick, PL.tf));
}
function hxEnd(room, ok, why) {
  const h = room.heist; if (!h) return; clearTimers(h); room.heist = null;
  const alive = hxTeam(room, h).filter(id => !h.down || !h.down.has(id));
  let total = 0, share = 0, cutters = [], greed = 0;
  if (ok && alive.length) {
    const base = h.T.pay[0] + crypto.randomInt(h.T.pay[1] - h.T.pay[0] + 1);
    const fast = (Date.now() - h.startAt) < h.T.time * 1000 * 0.6 ? 1.15 : 1;
    const cr = 1 + 0.1 * (hxTeam(room, h).length - h.T.min);      // больше людей в деле — выше добыча
    const pm = (HX_PLANS[h.plan] || HX_PLANS.quiet).pm * (h.feat ? 1.5 : 1) * (h.full ? 1.1 : 1);
    total = Math.round(base * Math.max(0.5, 1 - 0.07 * h.fails) * fast * cr * pm / 100) * 100;
    cutters = alive.filter(id => h.cut && h.cut.has(id));
    if (cutters.length && cutters.length < alive.length) { greed = Math.round(total * 0.2 / 100) * 100; share = Math.floor((total - greed * cutters.length) / alive.length / 100) * 100; }
    else { cutters = []; share = Math.floor(total / alive.length / 100) * 100; }
  }
  for (const id of hxTeam(room, h)) { const p = room.players.get(id); if (p) send(p, { t: 'heist-end', ok: !!ok, why: why || '', total, pay: ok && alive.includes(id) ? share + (cutters.includes(id) ? greed : 0) : 0, cut: cutters.map(i => nm(room, i)), mine: cutters.includes(id), plan: h.plan, feat: !!h.feat, full: !!h.full, fails: h.fails, secs: Math.round((Date.now() - h.startAt) / 1000) }); }
}
function hxLeave(room, c) {
  const h = room.heist; if (!h || !h.ids.includes(c.id)) return;
  if (h.state === 'lobby') {
    h.ids = h.ids.filter(i => i !== c.id);
    if (c.id === h.host || !h.ids.length) { clearTimers(h); room.heist = null; bcast(room, { t: 'heist-cancel' }); } else hxLobby(room);
    return;
  }
  const team = hxTeam(room, h).filter(i => i !== c.id);
  if (team.length < 1 || team.every(i => h.down.has(i))) return hxEnd(room, false, 'Команда распалась');
  hxStage(room);
}
function heistHandle(c, m, now) {
  const room = c.room, h = room.heist;
  if (now - (c.hxW || 0) > 1000) { c.hxW = now; c.hxN = 0; }
  if (++c.hxN > 12) return;
  if (m.t === 'heist-open') {
    if (room.race || room.arena || h) return send(c, { t: 'warn', msg: 'В комнате уже идёт событие' });
    const kind = HEIST_T[m.kind] ? m.kind : 'jewel';
    const nh = room.heist = { kind, T: HEIST_T[kind], state: 'lobby', host: c.id, ids: [c.id], timers: [], plan: 'quiet', roles: {} };
    bcast(room, { t: 'heist-open', kind, host: c.id, hname: c.name, name: nh.T.name, ico: nh.T.ico, min: nh.T.min });
    hxLobby(room);
    nh.timers.push(setTimeout(() => { if (room.heist === nh && nh.state === 'lobby') { room.heist = null; bcast(room, { t: 'heist-cancel' }); } }, 180000));
    return;
  }
  if (!h) return;
  if (m.t === 'heist-join') { if (h.state !== 'lobby' || h.ids.includes(c.id) || h.ids.length >= 4) return; h.ids.push(c.id); return hxLobby(room); }
  if (m.t === 'heist-leave') { if (h.ids.includes(c.id)) hxLeave(room, c); return; }
  if (m.t === 'heist-start') { if (h.host === c.id) hxStart(room); return; }
  if (m.t === 'heist-cancel') { if (h.host === c.id && h.state === 'lobby') { clearTimers(h); room.heist = null; bcast(room, { t: 'heist-cancel' }); } return; }
  if (m.t === 'heist-plan') { if (h.state === 'lobby' && h.host === c.id && HX_PLANS[m.p]) { h.plan = m.p; hxLobby(room); } return; }
  if (m.t === 'heist-role') { if (h.state === 'lobby' && h.ids.includes(c.id)) { h.roles = h.roles || {}; if (HX_PICK.includes(m.r)) h.roles[c.id] = m.r; else delete h.roles[c.id]; hxLobby(room); } return; }
  if (h.state !== 'run' || !h.ids.includes(c.id)) return;
  if (m.t === 'heist-cut') {
    if (h.i !== h.st.length - 1 || h.down.has(c.id) || h.cut.has(c.id) || hxTeam(room, h).length < 2) return;
    h.cut.add(c.id); return send(c, { t: 'heist-note', msg: '💀 Вы тайно решили кинуть команду: в конце заберёте лишние 20% добычи' });
  }
  if (m.t === 'heist-down') {
    if (h.down.has(c.id)) return; h.down.add(c.id); bcast(room, { t: 'heist-note', msg: '🚑 ' + c.name + ' ранен и выбывает из дела' });
    if (hxTeam(room, h).every(i => h.down.has(i))) hxEnd(room, false, 'Вся команда выведена из строя');
    return;
  }
  if (m.t === 'heist-done') {
    const s = h.st[h.i]; if ((m.i | 0) !== h.i || !s || h.down.has(c.id)) return;
    if (now - h.stAt < s.ms) return send(c, { t: 'warn', msg: 'Слишком быстро — действие не засчитано' });
    const st = c.state, P = hxPos(h); if (!st) return;
    const d = Math.hypot(st.x - P.x, st.z - P.z);
    if (s.k === 'escape') { if (d < 110) return send(c, { t: 'warn', msg: 'Отъедьте дальше от места ограбления' }); }
    else if (d > 60) return send(c, { t: 'warn', msg: 'Вы слишком далеко от цели' });
    if ((s.k === 'hack' || s.k === 'vault' || s.k === 'swap') && hxActor(room, h, s.k) !== c.id) return;
    const fl = Math.max(0, Math.min(s.ch || 0, m.fails | 0)); h.fails += fl; h.alarm = Math.min(4, h.alarm + (fl ? 1 : 0));
    if (fl) bcast(room, { t: 'heist-alarm', stars: Math.min(5, h.alarm + 1) });
    bcast(room, { t: 'heist-note', msg: '✔ ' + c.name + ': этап «' + HX_ROLE[s.k] + '» выполнен' + (fl ? ' (ошибок: ' + fl + ')' : '') });
    h.i++;
    if (h.i >= h.st.length) return hxEnd(room, true, '');
    return hxStage(room);
  }
}

/* ===================== v52/v53: ВОЙНА РАЙОНОВ между игроками (экипажи, сохраняется на диск) ===================== */
const TG = { GRID: 16, PITCH: 80, HALF: 640, N: 16, MAXCREW: 4, LOCK: 120000, NEED_FREE: 40, NEED_OWN: 70 };
const TURF_FILE = process.env.TURF_FILE || path.join(__dirname, 'turf-state.json');
let TURF_STORE = {}; try { TURF_STORE = JSON.parse(fs.readFileSync(TURF_FILE, 'utf8')) || {}; } catch (e) { TURF_STORE = {}; }
let turfSaveTimer = null;
function turfFlush() {
  turfSaveTimer = null;
  for (const room of rooms.values()) if (room.turf) TURF_STORE[room.code] = turfExport(room.turf);
  const ks = Object.keys(TURF_STORE); if (ks.length > 400) ks.sort((a, c) => (TURF_STORE[a].at || 0) - (TURF_STORE[c].at || 0)).slice(0, ks.length - 400).forEach(k => delete TURF_STORE[k]);
  try { fs.writeFileSync(TURF_FILE + '.tmp', JSON.stringify(TURF_STORE)); fs.renameSync(TURF_FILE + '.tmp', TURF_FILE); } catch (e) { /* диск недоступен — держим в памяти */ }
}
function turfSave() { if (!turfSaveTimer) turfSaveTimer = setTimeout(turfFlush, 4000); }
function turfExport(T) {
  const crews = {}; for (const k of T.crews.values()) if (k.uids.size) crews[k.id] = { name: k.name, col: k.col, code: k.code, uids: [...k.uids], lead: k.leadUid || null };
  return { at: Date.now(), n: T.nextCrew, d: T.d.map(d => d.o && crews[d.o] ? [d.o, d.df | 0] : null), crews };
}
const tClamp = (v, a, b) => v < a ? a : v > b ? b : v;
function tDist(x, z) {
  if (Math.abs(x) > 660 || Math.abs(z) > 660) return -1;           // интерьеры и вне города
  const bi = tClamp(Math.floor((x + TG.HALF) / TG.PITCH), 0, TG.GRID - 1), bj = tClamp(Math.floor((z + TG.HALF) / TG.PITCH), 0, TG.GRID - 1);
  return Math.floor(bj / 4) * 4 + Math.floor(bi / 4);
}
function turfOf(room) {
  if (!room.turf) {
    const T = { d: Array.from({ length: TG.N }, () => ({ o: null, p: 0, by: null, lock: 0, df: 0, gk: 0 })), crews: new Map(), nextCrew: 1, inc: 0, dirty: true, snapT: 0 };
    const sv = TURF_STORE[room.code];
    if (sv && sv.crews) {
      T.nextCrew = sv.n || 1;
      for (const id in sv.crews) { const k = sv.crews[id]; T.crews.set(id, { id, code: k.code, name: k.name, col: k.col, m: new Set(), uids: new Set(k.uids || []), leadUid: k.lead || null }); }
      (sv.d || []).forEach((o, i) => { const id = Array.isArray(o) ? o[0] : o; if (id && T.crews.has(id) && T.d[i]) { T.d[i].o = id; T.d[i].df = Array.isArray(o) ? (o[1] | 0) : 0; } });
    }
    room.turf = T;
  }
  return room.turf;
}
const cuid = c => c.uid || ('c' + c.gid);
function crewOfPlayer(room, c) { const T = turfOf(room); for (const k of T.crews.values()) if (k.m.has(c.id)) return k; return null; }
function crewNew(room, c) {
  const T = turfOf(room), id = 'K' + (T.nextCrew++), code = Math.random().toString(36).slice(2, 6).toUpperCase();
  const k = { id, code, name: ('Экипаж ' + c.name).slice(0, 18), col: c.col, m: new Set([c.id]), uids: new Set([cuid(c)]), leadUid: cuid(c) };
  T.crews.set(id, k); T.dirty = true; turfSave(); return k;
}
/* игрок вернулся в комнату — подключаем к его прежнему экипажу */
function crewAttach(room, c) {
  const T = turfOf(room); if (crewOfPlayer(room, c)) return;
  for (const k of T.crews.values()) if (k.uids.has(cuid(c)) && k.m.size < TG.MAXCREW) { k.m.add(c.id); T.dirty = true; return; }
  crewNew(room, c);
}
function crewPrune(room, k) {
  const T = turfOf(room); if (k.m.size) return;
  const owns = T.d.some(d => d.o === k.id);
  if (!owns || !k.uids.size) {
    T.crews.delete(k.id);
    for (const d of T.d) { if (d.o === k.id) { d.o = null; d.p = 0; d.by = null; d.df = 0; } if (d.by === k.id) { d.by = null; d.p = 0; } }
  }
}
/* perm=true: игрок сам ушёл из экипажа; false: просто отключился (членство в экипаже сохраняется) */
function crewDrop(room, c, perm) {
  const T = turfOf(room), k = crewOfPlayer(room, c); if (!k) return;
  k.m.delete(c.id);
  if (perm) { k.uids.delete(cuid(c)); if (k.leadUid === cuid(c)) k.leadUid = [...k.uids][0] || null; }
  crewPrune(room, k); T.dirty = true; turfSave();
}
function turfSnap(room) {
  const T = turfOf(room);
  return { t: 'turf', d: T.d.map(d => [d.o, Math.round(d.p * 100) / 100, d.by, d.lock > Date.now() ? Math.ceil((d.lock - Date.now()) / 1000) : 0, d.df | 0]),
    crews: [...T.crews.values()].map(k => {
      const lead = [...k.m].find(id => { const p = room.players.get(id); return p && cuid(p) === k.leadUid; }) || [...k.m][0] || null;
      return { id: k.id, code: k.code, name: k.name, col: k.col, lead, off: !k.m.size, m: [...k.m].map(id => ({ id, name: nm(room, id) })) };
    }) };
}
function turfSend(room, c) {
  crewAttach(room, c);
  const sn = turfSnap(room); sn.me = c.id; send(c, sn);
}
function turfHandle(c, m, now) {
  const room = c.room, T = turfOf(room);
  crewAttach(room, c);
  if (m.t === 'turf-get') { return turfSend(room, c); }
  if (now - (c.lastCrew || 0) < 600) return; c.lastCrew = now;
  if (m.t === 'turf-def') {
    const i = m.i | 0, d = T.d[i], k = crewOfPlayer(room, c);
    if (!d || !k || d.o !== k.id) return send(c, { t: 'turf-msg', msg: 'Усиливать оборону можно только в своём районе' });
    if ((d.df | 0) >= 3) return send(c, { t: 'turf-msg', msg: 'Оборона уже на максимуме' });
    d.df = (d.df | 0) + 1; T.dirty = true; T.snapT = 0; turfSave();
    send(c, { t: 'turf-def-ok', i, lvl: d.df, cost: 2000 * d.df });
    return bcast(room, { t: 'turf-msg', msg: '🛡 Экипаж «' + k.name + '» усилил оборону района (ур. ' + d.df + ')' });
  }
  if (m.t === 'turf-guard') {            // убит страж района: ускоряет захват
    const i = m.i | 0, d = T.d[i], k = crewOfPlayer(room, c), st = c.state;
    if (!d || !k || !d.o || d.o === k.id || !st || tDist(st.x, st.z) !== i || d.by !== k.id) return;
    if (now - (c.lastGuard || 0) < 1500) return; c.lastGuard = now;
    d.p = Math.min(0.99, d.p + 0.04); T.dirty = true; return;
  }
  if (m.t === 'crew-join') {
    const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const tg = [...T.crews.values()].find(k => k.code === code), cur = crewOfPlayer(room, c);
    if (!tg) return send(c, { t: 'turf-msg', msg: 'Экипаж с таким кодом не найден' });
    if (cur === tg) return send(c, { t: 'turf-msg', msg: 'Вы уже в этом экипаже' });
    if (tg.m.size >= TG.MAXCREW) return send(c, { t: 'turf-msg', msg: 'В экипаже нет мест' });
    crewDrop(room, c, true);
    tg.m.add(c.id); tg.uids.add(cuid(c)); if (!tg.leadUid) tg.leadUid = cuid(c); T.dirty = true; turfSave();
    bcast(room, { t: 'turf-msg', msg: '🏴 ' + c.name + ' вступил в экипаж «' + tg.name + '»' });
  } else if (m.t === 'crew-leave') {
    crewDrop(room, c, true); crewNew(room, c); bcast(room, { t: 'turf-msg', msg: '🏴 ' + c.name + ' ушёл из экипажа' });
  } else if (m.t === 'crew-name') {
    const k = crewOfPlayer(room, c); if (!k || k.leadUid !== cuid(c)) return;
    const n = String(m.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18); if (n.length < 2) return;
    k.name = n; T.dirty = true; turfSave();
  }
  T.dirty = true; T.snapT = 0;
}
function turfTick(room, dt) {
  const T = room.turf; if (!T) return;
  const now = Date.now(), pres = Array.from({ length: TG.N }, () => new Map());
  for (const c of room.players.values()) {
    const st = c.state; if (!st || c.dead || !(st.hp > 0)) continue;
    const i = tDist(st.x, st.z); if (i < 0) continue;
    const k = crewOfPlayer(room, c); if (!k) continue;
    const mm = pres[i]; mm.set(k.id, (mm.get(k.id) || 0) + 1);
  }
  for (let i = 0; i < TG.N; i++) {
    const d = T.d[i], mm = pres[i], ks = [...mm.keys()];
    const atk = ks.filter(k => k !== d.o), def = d.o ? (mm.get(d.o) || 0) : 0;
    const was = d.p;
    if (atk.length === 1 && !def && d.lock <= now) {
      const k = atk[0], n = Math.min(3, mm.get(k)), need = d.o ? TG.NEED_OWN * (1 + 0.6 * (d.df | 0)) : TG.NEED_FREE, rate = (1 + 0.55 * (n - 1)) / need;
      if (d.by && d.by !== k && d.p > 0) d.p = Math.max(0, d.p - rate * dt * 1.5);
      else { d.by = k; d.p = Math.min(1, d.p + rate * dt); }
      if (d.p <= 0) d.by = null;
    } else if (atk.length === 0 || (atk.length >= 1 && def)) {
      if (d.p > 0) { d.p = Math.max(0, d.p - dt / (def ? 25 : 40)); if (d.p <= 0) d.by = null; }
    }
    if (d.p >= 1 && d.by) {
      const k = T.crews.get(d.by), prev = d.o && T.crews.get(d.o);
      d.o = d.by; d.p = 0; d.by = null; d.df = 0; d.lock = now + TG.LOCK; T.dirty = true; turfSave();
      if (prev) crewPrune(room, prev);
      if (k) {
        bcast(room, { t: 'turf-cap', i, crew: k.name, prev: prev ? prev.name : null, col: k.col });
        for (const id of k.m) { const p = room.players.get(id); if (p && p.state && tDist(p.state.x, p.state.z) === i) send(p, { t: 'turf-pay', amt: prev ? 1200 : 800, why: 'cap' }); }
      }
    }
    if (Math.abs(d.p - was) > 0.001) T.dirty = true;
  }
  T.inc += dt;
  if (T.inc >= 60) {
    T.inc = 0;
    const cnt = new Map(); for (const d of T.d) if (d.o) cnt.set(d.o, (cnt.get(d.o) || 0) + 1);
    for (const [kid, n] of cnt) { const k = T.crews.get(kid); if (!k) continue; for (const id of k.m) { const p = room.players.get(id); if (p) send(p, { t: 'turf-pay', amt: 120 * Math.min(n, 8), why: 'income', n }); } }
  }
  T.snapT -= dt;
  if (T.dirty && T.snapT <= 0) { T.dirty = false; T.snapT = 1.5; bcast(room, turfSnap(room)); }
}
setInterval(() => { for (const room of rooms.values()) if (room.turf) { try { turfTick(room, 1); } catch (e) { /* не роняем сервер */ } } }, 1000).unref();
process.on('SIGTERM', () => { try { turfFlush(); } catch (e) { } process.exit(0); });
process.on('SIGINT', () => { try { turfFlush(); } catch (e) { } process.exit(0); });

function leave(c) {
  if (c.dead) return;
  c.dead = true; clients.delete(c);
  const room = c.room;
  if (room && room.players.get(c.id) === c) {
    room.players.delete(c.id);
    pkLeave(room, c);
    if (room.turf) { crewDrop(room, c, false); room.turf.dirty = true; turfSave(); }
    activityLeave(room, c);
    bcast(room, { t: 'leave', id: c.id, name: c.name });
    if (!room.players.size) { if (room.turf) { try { turfFlush(); } catch (e) { } } clearTimers(room.race); clearTimers(room.arena); clearTimers(room.heist); rooms.delete(room.code); }
  }
  try { c.socket.destroy(); } catch (e) { /* ignore */ }
}

function onlineList() {
  const by = new Map();
  for (const c of clients) {
    if (c.dead || !c.name) continue;
    const uid = c.uid || ('c' + c.gid), cur = by.get(uid);
    if (!cur || (c.room && !cur.room)) by.set(uid, c);
  }
  return [...by.entries()].slice(0, 60).map(([u, c]) => ({ u, name: c.name, room: c.room ? c.room.code : '', n: c.room ? c.room.players.size : 0 }));
}
let lastSig = '';
setInterval(() => {
  const list = onlineList(), sig = JSON.stringify(list);
  if (sig === lastSig) return;
  lastSig = sig;
  for (const c of clients) if (c.watch && !c.dead) send(c, { t: 'online', list });
}, 3000).unref();

function handle(c, m) {
  if (!m || typeof m !== 'object') return;
  const now = Date.now();
  if (m.t === 'hello') {
    if (c.name) return;
    c.name = sanitizeName(m.name); c.uid = sanUid(m.uid) || ('c' + c.gid); c.lobby = true; c.watch = true;
    return send(c, { t: 'online', list: onlineList(), me: c.uid });
  }
  if (m.t === 'who' && c.name) { c.watch = true; return send(c, { t: 'online', list: onlineList() }); }
  if (m.t === 'who-off') { if (c.lobby) return; c.watch = false; return; }
  if (m.t === 'gchat' && c.name) {
    if (now - (c.lastG || 0) < 800) return;
    c.lastG = now;
    const text = String(m.text == null ? '' : m.text).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
    if (!text) return;
    for (const o of clients) if (o.watch && !o.dead) send(o, { t: 'gchat', name: c.name, u: c.uid || ('c' + c.gid), text });
    return;
  }
  if (m.t === 'invite' && c.room) {
    if (now - (c.lastInv || 0) < 2000) return;
    c.lastInv = now;
    const to = sanUid(m.to); let tg = null;
    for (const o of clients) if (!o.dead && o.uid === to && o.room !== c.room) { if (!tg || o.lobby) tg = o; }
    if (!tg) return send(c, { t: 'invited', ok: false, msg: 'Игрок не в сети' });
    if (c.room.players.size >= MAX_PLAYERS) return send(c, { t: 'invited', ok: false, msg: 'Ваша комната заполнена' });
    send(tg, { t: 'invite', from: c.name, room: c.room.code, n: c.room.players.size });
    return send(c, { t: 'invited', ok: true, name: tg.name });
  }
  if (m.t === 'join') {
    if (c.room) return;
    c.name = sanitizeName(m.name); if (m.uid) c.uid = sanUid(m.uid);
    let code = sanitizeCode(m.room);
    let room;
    if (m.create || !code) {
      code = genCode();
      if (!code) return send(c, { t: 'err', msg: 'Сервер занят, попробуйте позже' });
      room = { code, players: new Map(), nextId: 1 };
      rooms.set(code, room);
    } else {
      room = rooms.get(code);
      if (!room && TURF_STORE[code]) { room = { code, players: new Map(), nextId: 1 }; rooms.set(code, room); }   // комната с сохранёнными районами оживает по тому же коду
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
  if (typeof m.t === 'string' && (m.t.startsWith('turf-') || m.t.startsWith('crew-'))) return turfHandle(c, m, now);
  if (m.t === 's') { // снимок состояния
    if (now - c.lastS < 40) return; // не чаще ~25 Гц
    c.lastS = now;
    const s = {
      x: num(m.x, -5000, 5000), y: num(m.y, -100, 2000), z: num(m.z, -5000, 5000), h: num(m.h, -20, 20),
      ph: num(m.ph, -1e6, 1e6), am: num(m.am, 0, 3),
      car: typeof m.car === 'string' ? m.car.slice(0, 24) : null,
      cc: typeof m.cc === 'string' ? m.cc.slice(0, 9) : null,
      st: num(m.st, -2, 2), sp: num(m.sp, -200, 200), pi: num(m.pi, -2, 2), ro: num(m.ro, -2, 2),
      n: m.n ? 1 : 0, b: m.b ? 1 : 0, v: m.v ? 1 : 0, hp: num(m.hp, 0, 100, 100), pv: m.pv ? 1 : 0, ar: num(m.ar, -1.5, 1.5), wp: typeof m.wp === 'string' ? m.wp.replace(/[^a-z]/g, '').slice(0, 12) : '', sh: m.sh ? 1 : 0, ik: typeof m.ik === 'string' ? m.ik.replace(/[^a-z]/g, '').slice(0, 12) : ''
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
    const room = c.room; if (room.race || room.arena || room.heist) return send(c, { t: 'warn', msg: 'В комнате уже идёт событие' });
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
    const room = c.room; if (room.race || room.arena || room.heist) return send(c, { t: 'warn', msg: 'В комнате уже идёт событие' });
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
  } else if (typeof m.t === 'string' && m.t.startsWith('heist-')) {
    heistHandle(c, m, now);
  } else if (typeof m.t === 'string' && (m.t.startsWith('pk-') || m.t.startsWith('jp-'))) {
    casinoHandle(c, m, now);
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

const GAME_FILES = ['index.html', 'gorod-legend-v27.html'];
/* ---- v51: облачные сохранения по коду-ключу (HTTP, вне Telegram) ---- */
const CLOUD_FILE = process.env.CLOUD_FILE || path.join(__dirname, 'cloud-saves.json');
const CLOUD_MAX = 400000, CLOUD_KEEP = 5000;
let CLOUD = {}; try { CLOUD = JSON.parse(fs.readFileSync(CLOUD_FILE, 'utf8')) || {}; } catch (e) { CLOUD = {}; }
let cloudTimer = null;
function cloudFlush() { cloudTimer = null; try { fs.writeFileSync(CLOUD_FILE + '.tmp', JSON.stringify(CLOUD)); fs.renameSync(CLOUD_FILE + '.tmp', CLOUD_FILE); } catch (e) { /* диск недоступен — храним в памяти */ } }
const cloudRate = new Map();
function cloudOk(ip) { const n = Date.now(), r = cloudRate.get(ip) || { t: n, c: 0 }; if (n - r.t > 60000) { r.t = n; r.c = 0; } r.c++; cloudRate.set(ip, r); if (cloudRate.size > 2000) cloudRate.clear(); return r.c <= 40; }
function cloudApi(req, res, url) {
  const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const out = (st, o) => { res.writeHead(st, H); res.end(JSON.stringify(o)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, H); return res.end(); }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!cloudOk(ip)) return out(429, { ok: false, err: 'rate' });
  const okCode = c => typeof c === 'string' && /^[A-Z0-9]{10,16}$/.test(c);
  if (url === '/api/cloud/get') {
    const q = new URL(req.url, 'http://x').searchParams, code = String(q.get('code') || '').toUpperCase();
    if (!okCode(code)) return out(400, { ok: false, err: 'code' });
    const r = CLOUD[code]; if (!r) return out(404, { ok: false, err: 'none' });
    return out(200, { ok: true, t: r.t, data: r.data });
  }
  if (url === '/api/cloud/put' && req.method === 'POST') {
    let size = 0; const parts = [];
    req.on('data', d => { size += d.length; if (size > CLOUD_MAX) { out(413, { ok: false, err: 'big' }); req.destroy(); } else parts.push(d); });
    req.on('end', () => {
      if (size > CLOUD_MAX) return;
      let b; try { b = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (e) { return out(400, { ok: false, err: 'json' }); }
      const code = String(b && b.code || '').toUpperCase();
      if (!okCode(code) || typeof b.data !== 'string') return out(400, { ok: false, err: 'bad' });
      let s; try { s = JSON.parse(b.data); } catch (e) { return out(400, { ok: false, err: 'data' }); }
      if (!s || s.v !== 1 || typeof s.money !== 'number') return out(400, { ok: false, err: 'data' });
      CLOUD[code] = { t: Date.now(), data: b.data };
      const ks = Object.keys(CLOUD); if (ks.length > CLOUD_KEEP) { ks.sort((a, c) => CLOUD[a].t - CLOUD[c].t).slice(0, ks.length - CLOUD_KEEP).forEach(k => delete CLOUD[k]); }
      if (!cloudTimer) cloudTimer = setTimeout(cloudFlush, 3000);
      out(200, { ok: true, t: CLOUD[code].t });
    });
    return;
  }
  out(404, { ok: false });
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url.startsWith('/api/cloud/')) return cloudApi(req, res, url);
  if (url === '/' || url === '/index.html') {
    for (const n of GAME_FILES) {
      const p = path.join(__dirname, n);
      if (fs.existsSync(p)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' }); return fs.createReadStream(p).pipe(res); }
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
  const c = { socket, buf: Buffer.alloc(0), room: null, id: 0, name: '', alive: true, dead: false, lastS: 0, lastChat: 0, state: null, hitW: 0, hitN: 0, lastDied: 0, trW: 0, trN: 0, gid: ++gidSeq, uid: '', lobby: false, watch: false };
  clients.add(c);
  socket.on('data', d => { try { onData(c, d); } catch (e) { leave(c); } });
  socket.on('end', () => leave(c));
  socket.on('close', () => leave(c));
  socket.on('error', () => leave(c));
  // таймаут на вход в комнату
  setTimeout(() => { if (!c.room && !c.lobby) leave(c); }, 15000).unref();
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
