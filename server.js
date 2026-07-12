// 德州扑克联机服务器
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { Hand } = require('./engine');

const PORT = process.env.PORT || 3000;
const STATS_FILE = path.join(__dirname, 'stats.json');
const STARTING_CHIPS = 1000;
const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const ACTION_TIMEOUT_MS = 45000; // 45 秒不操作自动过牌/弃牌
const NEXT_HAND_DELAY_MS = 6000;

// ---------- 战绩持久化 ----------
let stats = {};
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (e) { stats = {}; }
function saveStats() {
  fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2), () => {});
}
function statFor(name) {
  if (!stats[name]) stats[name] = { hands: 0, wins: 0, buyIns: 0, chipsNow: 0 };
  return stats[name];
}

// ---------- 静态文件 ----------
const server = http.createServer((req, res) => {
  const file = req.url.split('?')[0];
  // 只对外提供游戏页面本身；socket.io 的请求由 io 自行接管
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
const rooms = new Map(); // code -> room

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(hostToken) {
  const room = {
    code: makeCode(),
    hostToken,
    players: [], // { token, socketId, name, chips, seat, connected, wantsSitOut }
    hand: null,
    handPlayers: null, // 本局参与者引用（与 players 中同对象）
    dealerSeat: -1,
    timer: null,
    nextHandTimer: null,
    log: [],
  };
  rooms.set(room.code, room);
  return room;
}

function roomLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 60) room.log.shift();
  io.to(room.code).emit('log', msg);
}

function leaderboard() {
  return Object.entries(stats)
    .map(([name, s]) => ({
      name,
      hands: s.hands,
      wins: s.wins,
      profit: s.chipsNow - s.buyIns * STARTING_CHIPS,
    }))
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 20);
}

// 向房间内每个人发送各自视角的状态
function broadcast(room) {
  for (const p of room.players) {
    if (!p.connected || !p.socketId) continue;
    io.to(p.socketId).emit('state', viewFor(room, p));
  }
}

function viewFor(room, me) {
  const hand = room.hand;
  const inHand = hand && !hand.isOver();
  return {
    code: room.code,
    youAreHost: me.token === room.hostToken,
    you: { name: me.name, chips: me.chips, seat: me.seat },
    players: room.players.map(p => {
      const hp = hand ? hand.players.find(q => q.id === p.token) : null;
      return {
        name: p.name,
        seat: p.seat,
        chips: p.chips,
        connected: p.connected,
        inHand: !!hp && !hp.folded,
        folded: !!hp && hp.folded,
        allIn: !!hp && hp.allIn,
        bet: hp ? hp.bet : 0,
        isYou: p.token === me.token,
        isDealer: hand ? hand.players[hand.dealerIndex]?.id === p.token : p.seat === room.dealerSeat,
        isTurn: inHand && hand.currentPlayer()?.id === p.token,
      };
    }),
    hand: hand ? {
      street: hand.street,
      pot: hand.pot,
      board: hand.board,
      currentBet: hand.currentBet,
      yourHole: hand.players.find(q => q.id === me.token)?.hole || null,
      yourTurn: inHand && hand.currentPlayer()?.id === me.token,
      legal: inHand && hand.currentPlayer()?.id === me.token ? hand.legalActions() : null,
      yourBet: hand.players.find(q => q.id === me.token)?.bet || 0,
      results: hand.results,
    } : null,
    playing: !!inHand,
    leaderboard: leaderboard(),
    log: room.log.slice(-15),
  };
}

function startHand(room) {
  clearTimeout(room.nextHandTimer);
  const eligible = room.players.filter(p => p.chips > 0 && p.connected);
  if (eligible.length < 2) {
    roomLog(room, '至少需要 2 名有筹码的在线玩家才能开局');
    broadcast(room);
    return;
  }
  // 按座位排序，按钮顺移
  eligible.sort((a, b) => a.seat - b.seat);
  const seats = eligible.map(p => p.seat);
  let next = seats.find(s => s > room.dealerSeat);
  if (next === undefined) next = seats[0];
  room.dealerSeat = next;
  const dealerIdx = eligible.findIndex(p => p.seat === next);

  // 构造牌局玩家对象（id 用 token）
  const handPlayers = eligible.map(p => ({ id: p.token, name: p.name, chips: p.chips, ref: p }));
  room.hand = new Hand(handPlayers, dealerIdx, SMALL_BLIND, BIG_BLIND);
  room.handPlayers = handPlayers;
  for (const p of eligible) statFor(p.name).hands += 1;
  saveStats();
  roomLog(room, `—— 新一局开始（${eligible.length} 人，盲注 ${SMALL_BLIND}/${BIG_BLIND}）——`);
  armTimer(room);
  syncChips(room);
  broadcast(room);
}

// 把牌局中的筹码同步回房间玩家与战绩
function syncChips(room) {
  if (!room.handPlayers) return;
  for (const hp of room.handPlayers) {
    hp.ref.chips = hp.chips;
    statFor(hp.ref.name).chipsNow = hp.chips;
  }
  saveStats();
}

function armTimer(room) {
  clearTimeout(room.timer);
  const hand = room.hand;
  if (!hand || hand.isOver()) return;
  const current = hand.currentPlayer();
  if (!current) return;
  room.timer = setTimeout(() => {
    try {
      const legal = hand.legalActions();
      if (legal && legal.check) hand.act(current.id, { type: 'check' });
      else hand.act(current.id, { type: 'fold' });
      roomLog(room, `${current.name} 超时，自动${legal && legal.check ? '过牌' : '弃牌'}`);
      afterAction(room);
    } catch (e) { /* ignore */ }
  }, ACTION_TIMEOUT_MS);
}

function afterAction(room) {
  const hand = room.hand;
  syncChips(room);
  if (hand.isOver()) {
    clearTimeout(room.timer);
    const r = hand.results;
    for (const w of r.winners) {
      statFor(w.name).wins += 1;
      roomLog(room, `${w.name} 赢得 ${w.amount} 筹码${w.handName ? '（' + w.handName + '）' : ''}`);
    }
    saveStats();
    broadcast(room);
    // 几秒后自动开下一局
    room.nextHandTimer = setTimeout(() => {
      room.hand = null;
      room.handPlayers = null;
      startHand(room);
    }, NEXT_HAND_DELAY_MS);
  } else {
    armTimer(room);
    broadcast(room);
  }
}

function findPlayer(room, token) {
  return room.players.find(p => p.token === token);
}

io.on('connection', (socket) => {
  let myRoom = null;
  let myToken = null;

  socket.on('createRoom', ({ name, token }, cb) => {
    name = String(name || '').trim().slice(0, 12);
    if (!name) return cb({ error: '请输入昵称' });
    const room = createRoom(token);
    joinRoomInternal(room, name, token, socket, cb);
  });

  socket.on('joinRoom', ({ code, name, token }, cb) => {
    code = String(code || '').trim().toUpperCase();
    name = String(name || '').trim().slice(0, 12);
    const room = rooms.get(code);
    if (!room) return cb({ error: '房间不存在，请检查房间号' });
    if (!name) return cb({ error: '请输入昵称' });
    joinRoomInternal(room, name, token, socket, cb);
  });

  function joinRoomInternal(room, name, token, socket, cb) {
    let p = findPlayer(room, token);
    if (p) {
      // 重连
      p.socketId = socket.id;
      p.connected = true;
      p.name = p.name; // 保持原名，避免牌局中改名
      roomLog(room, `${p.name} 重新连接`);
    } else {
      if (room.players.length >= 9) return cb({ error: '房间已满（最多 9 人）' });
      if (room.players.some(q => q.name === name)) return cb({ error: '昵称已被占用，换一个吧' });
      const usedSeats = new Set(room.players.map(q => q.seat));
      let seat = 0;
      while (usedSeats.has(seat)) seat++;
      p = { token, socketId: socket.id, name, chips: STARTING_CHIPS, seat, connected: true };
      room.players.push(p);
      const s = statFor(name);
      s.buyIns += 1;
      s.chipsNow = STARTING_CHIPS;
      saveStats();
      roomLog(room, `${name} 加入了牌桌（带入 ${STARTING_CHIPS}）`);
    }
    myRoom = room;
    myToken = token;
    socket.join(room.code);
    cb({ ok: true, code: room.code });
    broadcast(room);
  }

  socket.on('startGame', () => {
    if (!myRoom) return;
    if (myToken !== myRoom.hostToken) return socket.emit('errMsg', '只有房主可以开始游戏');
    if (myRoom.hand && !myRoom.hand.isOver()) return;
    startHand(myRoom);
  });

  socket.on('action', (action) => {
    if (!myRoom || !myRoom.hand) return;
    try {
      const me = myRoom.hand.players.find(q => q.id === myToken);
      if (!me) return;
      myRoom.hand.act(myToken, action);
      const verbs = { fold: '弃牌', check: '过牌', call: '跟注', raise: `加注到 ${action.amount}` };
      roomLog(myRoom, `${me.name} ${verbs[action.type] || action.type}`);
      afterAction(myRoom);
    } catch (e) {
      socket.emit('errMsg', e.message);
    }
  });

  socket.on('rebuy', () => {
    if (!myRoom) return;
    const p = findPlayer(myRoom, myToken);
    if (!p) return;
    if (p.chips > 0) return socket.emit('errMsg', '还有筹码，不能补充');
    const inHand = myRoom.hand && !myRoom.hand.isOver() && myRoom.hand.players.some(q => q.id === myToken && !q.folded);
    if (inHand) return socket.emit('errMsg', '牌局进行中，结束后再补充');
    p.chips = STARTING_CHIPS;
    const s = statFor(p.name);
    s.buyIns += 1;
    s.chipsNow = p.chips;
    saveStats();
    roomLog(myRoom, `${p.name} 补充了 ${STARTING_CHIPS} 筹码`);
    broadcast(myRoom);
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    const p = findPlayer(myRoom, myToken);
    if (p) {
      p.connected = false;
      roomLog(myRoom, `${p.name} 断开连接`);
      broadcast(myRoom);
    }
    // 全员离开且无牌局 → 半小时后回收房间
    setTimeout(() => {
      const room = myRoom;
      if (room && room.players.every(q => !q.connected)) {
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
