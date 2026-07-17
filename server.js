// 朋友局德州扑克 V2 服务器
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { Hand } = require('./engine');

const PORT = process.env.PORT || 3000;
const NEXT_HAND_DELAY_MS = 7000;
const MAX_PLAYERS = 9;

// ---------- 静态页面 ----------
const server = http.createServer((req, res) => {
  const file = req.url.split('?')[0];
  if (file === '/' || file === '' || file === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else if (file === '/healthz') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end('Not found');
  }
});
const io = new Server(server, { cors: { origin: '*' } });

// ---------- 房间 ----------
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

// 建房参数校验（盲注预设 1/2、5/10、10/20，初始筹码按大盲倍数）
function sanitizeConfig(c) {
  c = c || {};
  const cfg = {};
  cfg.name = String(c.name || '').trim().slice(0, 16) || '朋友局';
  cfg.password = String(c.password || '').trim().slice(0, 12);
  let sb = Math.floor(Number(c.sb)), bb = Math.floor(Number(c.bb));
  if (!Number.isFinite(sb) || sb < 1) sb = 1;
  if (!Number.isFinite(bb) || bb < sb) bb = sb * 2;
  cfg.sb = Math.min(sb, 100000);
  cfg.bb = Math.min(bb, 200000);
  let sc = Math.floor(Number(c.startChips));
  if (!Number.isFinite(sc) || sc < cfg.bb * 10) sc = cfg.bb * 100;
  cfg.startChips = Math.min(sc, cfg.bb * 10000);
  cfg.actionTime = [15, 30, 45, 60].includes(Number(c.actionTime)) ? Number(c.actionTime) : 30;
  cfg.tiers = [50, 100, 150, 200].map(m => m * cfg.bb); // 补码档位 = 大盲倍数
  return cfg;
}

function createRoom(hostToken, config) {
  const room = {
    code: makeCode(), hostToken, config,
    players: [],           // 在座玩家
    ledger: {},            // token -> 全场账本（含已离桌玩家）
    hand: null, handPlayers: null,
    dealerSeat: -1,
    timer: null, nextHandTimer: null, turnEndsAt: null,
    pendingRebuys: [],     // 待房主批准 [{token,name,amount}]
    pendingCredits: [],    // 已批准、待下一手前到账 [{token,amount}]
    chat: [], log: [],
    startedAt: null, handCount: 0,
    ending: false, ended: false, endSummary: null,
  };
  rooms.set(room.code, room);
  return room;
}

function roomLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 100) room.log.shift();
}

function findPlayer(room, token) { return room.players.find(p => p.token === token); }
function inActiveHand(room, token) {
  return !!(room.hand && !room.hand.isOver() && room.handPlayers && room.handPlayers.some(q => q.id === token));
}

// ---------- 账本 ----------
function ledgerRows(room) {
  return Object.entries(room.ledger).map(([token, l]) => {
    const p = findPlayer(room, token);
    const totalIn = l.initial + l.rebuyTotal;
    const chips = p ? p.chips : 0;
    return {
      name: l.name, avatar: l.avatar,
      initial: l.initial, rebuyCount: l.rebuyCount, rebuyTotal: l.rebuyTotal,
      totalIn, chips, carriedOff: l.carriedOff,
      net: chips + l.carriedOff - totalIn,
      seated: !!p, connected: !!p && p.connected,
    };
  }).sort((a, b) => b.net - a.net);
}

// 筹码守恒校验（仅在没有进行中的手牌时有意义）
function checkConservation(room) {
  if (room.hand && !room.hand.isOver()) return;
  const rows = ledgerRows(room);
  const sum = rows.reduce((s, r) => s + r.net, 0);
  const pendingSum = room.pendingCredits.reduce((s, c) => s + c.amount, 0);
  if (sum + pendingSum !== 0) {
    console.error(`[守恒告警] 房间 ${room.code} 净输赢合计 ${sum}（含待到账 ${pendingSum}）`);
    roomLog(room, '⚠️ 系统校验发现筹码总账异常，请联系开发者');
  }
}

// ---------- 补码 ----------
function applyCredit(room, token, amount, reason) {
  const l = room.ledger[token];
  if (!l) return;
  l.rebuyCount += 1;
  l.rebuyTotal += amount;
  if (inActiveHand(room, token)) {
    room.pendingCredits.push({ token, amount });
  } else {
    const p = findPlayer(room, token);
    if (p) p.chips += amount;
    else l.carriedOff += amount; // 极端情况：批准时人已离桌，计入其带离
  }
  roomLog(room, `${l.name} ${reason}，+${amount} 筹码`);
}

function settlePendingCredits(room) {
  for (const c of room.pendingCredits) {
    const p = findPlayer(room, c.token);
    if (p) p.chips += c.amount;
    else if (room.ledger[c.token]) room.ledger[c.token].carriedOff += c.amount;
  }
  room.pendingCredits = [];
}

// ---------- 离桌 ----------
function processLeave(room, token, verb) {
  const p = findPlayer(room, token);
  if (!p) return;
  const l = room.ledger[token];
  if (l) l.carriedOff += p.chips;
  room.players = room.players.filter(q => q.token !== token);
  room.pendingRebuys = room.pendingRebuys.filter(r => r.token !== token);
  roomLog(room, `${p.name} ${verb}（带离 ${p.chips} 筹码）`);
  if (p.socketId) io.to(p.socketId).emit('kicked', verb);
  // 房主离桌 → 自动转让给最早入座的玩家
  if (room.hostToken === token && room.players.length > 0) {
    room.hostToken = room.players[0].token;
    roomLog(room, `房主已转让给 ${room.players[0].name}`);
  }
}

// ---------- 牌局流程 ----------
function eligiblePlayers(room) {
  return room.players.filter(p => p.chips > 0 && p.connected && !p.sitOut && !p.kicked && !p.leaving);
}

function startHand(room) {
  clearTimeout(room.nextHandTimer);
  if (room.ended || room.ending) return;
  settlePendingCredits(room);
  const eligible = eligiblePlayers(room);
  if (eligible.length < 2) {
    roomLog(room, '在座且有筹码的玩家不足 2 人，等待中…');
    broadcast(room);
    return;
  }
  if (!room.startedAt) room.startedAt = Date.now();
  room.handCount += 1;

  eligible.sort((a, b) => a.seat - b.seat);
  const seats = eligible.map(p => p.seat);
  let next = seats.find(s => s > room.dealerSeat);
  if (next === undefined) next = seats[0];
  room.dealerSeat = next;
  const dealerIdx = eligible.findIndex(p => p.seat === next);

  const handPlayers = eligible.map(p => ({ id: p.token, name: p.name, chips: p.chips, ref: p }));
  room.hand = new Hand(handPlayers, dealerIdx, room.config.sb, room.config.bb);
  room.handPlayers = handPlayers;
  roomLog(room, `—— 第 ${room.handCount} 手开始（${eligible.length} 人）——`);
  autoFoldGone(room);
  if (room.hand.isOver()) { afterAction(room); return; }
  armTimer(room);
  syncChips(room);
  broadcast(room);
}

function syncChips(room) {
  if (!room.handPlayers) return;
  for (const hp of room.handPlayers) hp.ref.chips = hp.chips;
}

// 被移除/待离桌的玩家轮到时立即自动弃牌
function autoFoldGone(room) {
  const hand = room.hand;
  let guard = 0;
  while (hand && !hand.isOver() && guard++ < 20) {
    const cur = hand.currentPlayer();
    if (!cur) break;
    const ref = findPlayer(room, cur.id);
    if (ref && ref.kicked) {
      try { hand.act(cur.id, { type: 'fold' }); roomLog(room, `${cur.name} 已被移除，自动弃牌`); }
      catch (e) { break; }
    } else break;
  }
}

function armTimer(room) {
  clearTimeout(room.timer);
  const hand = room.hand;
  if (!hand || hand.isOver()) { room.turnEndsAt = null; return; }
  const current = hand.currentPlayer();
  if (!current) { room.turnEndsAt = null; return; }
  const ms = room.config.actionTime * 1000;
  room.turnEndsAt = Date.now() + ms;
  room.timer = setTimeout(() => {
    try {
      const legal = hand.legalActions();
      const canCheck = legal && legal.check;
      hand.act(current.id, canCheck ? { type: 'check' } : { type: 'fold' });
      roomLog(room, `${current.name} 超时，自动${canCheck ? '过牌' : '弃牌'}`);
      afterAction(room);
    } catch (e) { /* ignore */ }
  }, ms);
}

function afterAction(room) {
  const hand = room.hand;
  syncChips(room);
  if (hand.isOver()) {
    clearTimeout(room.timer);
    room.turnEndsAt = null;
    const r = hand.results;
    if (r.pots && r.pots.length > 1) {
      r.pots.forEach((pot, i) => roomLog(room, `${i === 0 ? '主池' : '边池' + i} ${pot.amount} → ${pot.winners.join('、')}`));
    }
    for (const w of r.winners) {
      roomLog(room, `🏆 ${w.name} 赢得 ${w.amount}${w.handName ? '（' + w.handName + '）' : ''}`);
    }
    // 结算离桌/被移除的玩家
    for (const p of [...room.players]) {
      if (p.kicked) processLeave(room, p.token, '被房主移除');
      else if (p.leaving) processLeave(room, p.token, '离开了牌桌');
    }
    settlePendingCredits(room);
    checkConservation(room);
    if (room.ending) { finalizeGame(room); return; }
    broadcast(room);
    room.nextHandTimer = setTimeout(() => {
      room.hand = null; room.handPlayers = null;
      startHand(room);
    }, NEXT_HAND_DELAY_MS);
  } else {
    autoFoldGone(room);
    if (hand.isOver()) return afterAction(room);
    armTimer(room);
    broadcast(room);
  }
}

function finalizeGame(room) {
  room.ended = true;
  room.ending = false;
  room.hand = null; room.handPlayers = null;
  clearTimeout(room.timer); clearTimeout(room.nextHandTimer);
  room.turnEndsAt = null;
  room.endSummary = {
    durationMs: room.startedAt ? Date.now() - room.startedAt : 0,
    hands: room.handCount,
    rows: ledgerRows(room),
  };
  roomLog(room, `牌局结束：共 ${room.handCount} 手`);
  broadcast(room);
}

// ---------- 视图 ----------
function broadcast(room) {
  for (const p of room.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', viewFor(room, p));
  }
}

function viewFor(room, me) {
  const hand = room.hand;
  const inHand = hand && !hand.isOver();
  const cfg = room.config;
  return {
    code: room.code,
    config: { name: cfg.name, sb: cfg.sb, bb: cfg.bb, startChips: cfg.startChips, actionTime: cfg.actionTime, tiers: cfg.tiers, hasPassword: !!cfg.password },
    youAreHost: me.token === room.hostToken,
    you: {
      name: me.name, avatar: me.avatar, chips: me.chips, seat: me.seat, sitOut: !!me.sitOut,
      leaving: !!me.leaving,
      pendingRebuy: room.pendingRebuys.some(r => r.token === me.token),
      pendingCredit: room.pendingCredits.filter(c => c.token === me.token).reduce((s, c) => s + c.amount, 0),
    },
    players: room.players.map(p => {
      const hp = hand ? hand.players.find(q => q.id === p.token) : null;
      return {
        name: p.name, avatar: p.avatar, seat: p.seat, chips: p.chips,
        connected: p.connected, sitOut: !!p.sitOut,
        inHand: !!hp && !hp.folded, folded: !!hp && hp.folded, allIn: !!hp && hp.allIn,
        waiting: !!inHand && !hp, // 牌局进行中但未参与（下局加入）
        bet: hp ? hp.bet : 0,
        isYou: p.token === me.token,
        isHost: p.token === room.hostToken,
        isDealer: hand ? hand.players[hand.dealerIndex]?.id === p.token : p.seat === room.dealerSeat,
        isTurn: !!inHand && hand.currentPlayer()?.id === p.token,
      };
    }),
    hand: hand ? {
      handId: room.handCount,
      street: hand.street, pot: hand.pot, board: hand.board,
      currentBet: hand.currentBet,
      yourHole: hand.players.find(q => q.id === me.token)?.hole || null,
      yourTurn: !!inHand && hand.currentPlayer()?.id === me.token,
      legal: inHand && hand.currentPlayer()?.id === me.token ? hand.legalActions() : null,
      results: hand.results,
    } : null,
    playing: !!inHand,
    turnEndsAt: room.turnEndsAt,
    serverNow: Date.now(),
    ledger: ledgerRows(room),
    pendingRebuys: room.pendingRebuys.map(r => ({ seat: r.seat, name: r.name, avatar: r.avatar, amount: r.amount })),
    chat: room.chat.slice(-30),
    log: room.log.slice(-25),
    ending: room.ending, ended: room.ended, endSummary: room.endSummary,
  };
}

// ---------- Socket ----------
io.on('connection', (socket) => {
  let myRoom = null;
  let myToken = null;

  function guard(fn) {
    return (...args) => { try { fn(...args); } catch (e) { socket.emit('errMsg', e.message || '操作失败'); } };
  }

  socket.on('createRoom', guard(({ name, avatar, token, config }, cb) => {
    name = String(name || '').trim().slice(0, 12);
    if (!name) return cb({ error: '请输入昵称' });
    const room = createRoom(token, sanitizeConfig(config));
    joinRoomInternal(room, { name, avatar, token, password: room.config.password }, cb);
  }));

  socket.on('joinRoom', guard(({ code, name, avatar, token, password }, cb) => {
    code = String(code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ error: '房间不存在，请检查房间号' });
    joinRoomInternal(room, { name: String(name || '').trim().slice(0, 12), avatar, token, password }, cb);
  }));

  function joinRoomInternal(room, { name, avatar, token, password }, cb) {
    let p = findPlayer(room, token);
    if (!p) {
      if (room.ended) return cb({ error: '这场牌局已经结束了' });
      if (room.config.password && String(password || '') !== room.config.password) {
        return cb({ error: '房间密码错误', needPassword: true });
      }
      if (!name) return cb({ error: '请输入昵称' });
      if (room.players.length >= MAX_PLAYERS) return cb({ error: `房间已满（最多 ${MAX_PLAYERS} 人）` });
      if (room.players.some(q => q.name === name)) return cb({ error: '昵称已被占用，换一个吧' });
      avatar = String(avatar || '🙂').slice(0, 8);
      const usedSeats = new Set(room.players.map(q => q.seat));
      let seat = 0;
      while (usedSeats.has(seat)) seat++;
      p = { token, socketId: socket.id, name, avatar, chips: 0, seat, connected: true, sitOut: false, leaving: false, kicked: false };
      room.players.push(p);
      const l = room.ledger[token];
      if (l) {
        // 曾离桌又回来：重新带入记为一次补充，累计同一场总账
        l.name = name; l.avatar = avatar;
        p.chips = 0;
        applyCredit(room, token, room.config.startChips, '重新入座带入');
      } else {
        room.ledger[token] = { name, avatar, initial: room.config.startChips, rebuyCount: 0, rebuyTotal: 0, carriedOff: 0 };
        p.chips = room.config.startChips;
        roomLog(room, `${name} 加入了牌桌（带入 ${room.config.startChips}）`);
      }
    } else {
      p.socketId = socket.id;
      p.connected = true;
      roomLog(room, `${p.name} 重新连接`);
    }
    myRoom = room;
    myToken = token;
    socket.join(room.code);
    cb({ ok: true, code: room.code });
    broadcast(room);
  }

  function requireHost() {
    if (!myRoom || myToken !== myRoom.hostToken) throw new Error('只有房主可以执行此操作');
  }

  socket.on('startGame', guard(() => {
    requireHost();
    if (myRoom.ended) return;
    if (myRoom.hand && !myRoom.hand.isOver()) return;
    myRoom.hand = null; myRoom.handPlayers = null;
    startHand(myRoom);
  }));

  socket.on('action', guard((action) => {
    if (!myRoom || !myRoom.hand || myRoom.hand.isOver()) return;
    const me = myRoom.hand.players.find(q => q.id === myToken);
    if (!me) return;
    myRoom.hand.act(myToken, action);
    const verbs = { fold: '弃牌', check: '过牌', call: '跟注', raise: `加注到 ${action.amount}` };
    roomLog(myRoom, `${me.name} ${verbs[action.type] || action.type}`);
    afterAction(myRoom);
  }));

  // 申请补码（tierIndex 对应房间档位）
  socket.on('requestRebuy', guard((tierIndex) => {
    if (!myRoom || myRoom.ended) return;
    const p = findPlayer(myRoom, myToken);
    if (!p) return;
    const amount = myRoom.config.tiers[Number(tierIndex)];
    if (!amount) throw new Error('无效的补码档位');
    if (myRoom.pendingRebuys.some(r => r.token === myToken)) throw new Error('你已有一笔待批准的补码申请');
    if (myToken === myRoom.hostToken) {
      applyCredit(myRoom, myToken, amount, '补码（房主，免批公开）');
    } else {
      myRoom.pendingRebuys.push({ token: myToken, seat: p.seat, name: p.name, avatar: p.avatar, amount });
      roomLog(myRoom, `${p.name} 申请补码 ${amount}，等待房主批准`);
    }
    broadcast(myRoom);
  }));

  socket.on('resolveRebuy', guard(({ seat, approve }) => {
    requireHost();
    const idx = myRoom.pendingRebuys.findIndex(r => r.seat === Number(seat));
    if (idx === -1) return;
    const req = myRoom.pendingRebuys.splice(idx, 1)[0];
    if (approve) applyCredit(myRoom, req.token, req.amount, `补码获批`);
    else roomLog(myRoom, `${req.name} 的补码申请被房主婉拒`);
    broadcast(myRoom);
  }));

  socket.on('sitOut', guard((flag) => {
    if (!myRoom) return;
    const p = findPlayer(myRoom, myToken);
    if (!p) return;
    p.sitOut = !!flag;
    roomLog(myRoom, `${p.name} ${flag ? '暂离牌桌（新牌局不参与）' : '回到了牌桌'}`);
    broadcast(myRoom);
  }));

  socket.on('leaveTable', guard(() => {
    if (!myRoom) return;
    const p = findPlayer(myRoom, myToken);
    if (!p) return;
    if (inActiveHand(myRoom, myToken)) {
      p.leaving = true;
      roomLog(myRoom, `${p.name} 将在本手牌结束后离桌`);
    } else {
      processLeave(myRoom, myToken, '离开了牌桌');
      checkConservation(myRoom);
    }
    broadcast(myRoom);
  }));

  socket.on('kickPlayer', guard((seat) => {
    requireHost();
    const p = myRoom.players.find(q => q.seat === Number(seat));
    if (!p) return;
    const token = p.token;
    if (token === myToken) throw new Error('不能移除自己，请用「离桌」');
    if (inActiveHand(myRoom, token)) {
      p.kicked = true;
      roomLog(myRoom, `${p.name} 已被房主标记移除，本手牌轮到时自动弃牌`);
      autoFoldGone(myRoom);
      if (myRoom.hand.isOver()) return afterAction(myRoom);
    } else {
      processLeave(myRoom, token, '被房主移除');
      checkConservation(myRoom);
    }
    broadcast(myRoom);
  }));

  socket.on('transferHost', guard((seat) => {
    requireHost();
    const p = myRoom.players.find(q => q.seat === Number(seat));
    if (!p) throw new Error('该玩家不在牌桌上');
    myRoom.hostToken = p.token;
    roomLog(myRoom, `房主已转让给 ${p.name}`);
    broadcast(myRoom);
  }));

  socket.on('endGame', guard(() => {
    requireHost();
    if (myRoom.ended) return;
    if (myRoom.hand && !myRoom.hand.isOver()) {
      myRoom.ending = true;
      roomLog(myRoom, '房主已宣布结束：本手牌打完后结算');
      broadcast(myRoom);
    } else {
      finalizeGame(myRoom);
    }
  }));

  socket.on('chat', guard((text) => {
    if (!myRoom) return;
    const p = findPlayer(myRoom, myToken);
    if (!p) return;
    text = String(text || '').trim().slice(0, 100);
    if (!text) return;
    const msg = { name: p.name, avatar: p.avatar, text, t: Date.now() };
    myRoom.chat.push(msg);
    if (myRoom.chat.length > 50) myRoom.chat.shift();
    io.to(myRoom.code).emit('chat', msg);
  }));

  socket.on('disconnect', () => {
    if (!myRoom) return;
    const p = findPlayer(myRoom, myToken);
    if (p) {
      p.connected = false;
      roomLog(myRoom, `${p.name} 断开连接`);
      broadcast(myRoom);
    }
    const room = myRoom;
    setTimeout(() => {
      if (room && rooms.has(room.code) && room.players.every(q => !q.connected)) {
        clearTimeout(room.timer);
        clearTimeout(room.nextHandTimer);
        rooms.delete(room.code);
      }
    }, 30 * 60 * 1000);
  });
});

server.listen(PORT, () => {
  console.log(`德州扑克服务器已启动: http://localhost:${PORT}`);
});
