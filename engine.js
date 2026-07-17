// 德州扑克核心引擎：牌、比牌、单局状态机
'use strict';

const crypto = require('crypto');

const SUITS = ['♠', '♥', '♣', '♦'];
const RANK_NAMES = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A' };

const CATEGORY_NAMES = {
  8: '同花顺', 7: '四条', 6: '葫芦', 5: '同花', 4: '顺子',
  3: '三条', 2: '两对', 1: '一对', 0: '高牌',
};

function newDeck() {
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) deck.push({ r, s });
  }
  return deck;
}

function shuffle(deck, rng) {
  // 默认使用加密安全随机数（crypto.randomInt），保证洗牌不可预测
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rng ? Math.floor(rng() * (i + 1)) : crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardText(c) {
  return SUITS[c.s] + RANK_NAMES[c.r];
}

// 评估 5 张牌，返回可字典序比较的数组：[类别, 比较点数...]
function evaluate5(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);

  // 顺子检测（含 A-2-3-4-5）
  let straightHigh = 0;
  const uniq = [...new Set(ranks)];
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // 轮子
  }

  // 点数计数
  const count = {};
  for (const r of ranks) count[r] = (count[r] || 0) + 1;
  // 按（数量，点数）降序排列
  const groups = Object.entries(count)
    .map(([r, n]) => [Number(r), n])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  if (isFlush && straightHigh) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], groups[1][0], groups[2][0], groups[3][0]];
  return [0, ...ranks];
}

function compareScores(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 7 张牌里选出最佳 5 张
function best7(cards) {
  let best = null, bestCombo = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = evaluate5(combo);
            if (!best || compareScores(score, best) > 0) { best = score; bestCombo = combo; }
          }
  return { score: best, combo: bestCombo, name: CATEGORY_NAMES[best[0]] };
}

// ---------------- 单局状态机 ----------------
// players: [{ id, name, chips }]，chips 会被直接修改
class Hand {
  constructor(players, dealerIndex, smallBlind, bigBlind, rng) {
    this.players = players; // 本局参与者（chips > 0）
    this.n = players.length;
    this.dealerIndex = dealerIndex;
    this.sb = smallBlind;
    this.bb = bigBlind;
    this.deck = shuffle(newDeck(), rng);
    this.board = [];
    this.street = 'preflop'; // preflop -> flop -> turn -> river -> showdown
    this.pot = 0;
    this.results = null; // 结算信息
    this.lastAggressorIndex = null;

    for (const p of players) {
      p.hole = [this.deck.pop(), this.deck.pop()];
      p.folded = false;
      p.allIn = false;
      p.bet = 0;        // 本轮已下注
      p.total = 0;      // 本局累计投入
      p.actedThisRound = false;
    }

    // 盲注：两人局按钮位是小盲
    const sbIndex = this.n === 2 ? dealerIndex : (dealerIndex + 1) % this.n;
    const bbIndex = (sbIndex + 1) % this.n;
    this._postBlind(this.players[sbIndex], this.sb);
    this._postBlind(this.players[bbIndex], this.bb);
    this.currentBet = this.bb;
    this.minRaise = this.bb;
    this.bbIndex = bbIndex;
    this.toAct = (bbIndex + 1) % this.n;
    this._skipDead();
  }

  _postBlind(p, amount) {
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.bet += pay;
    p.total += pay;
    this.pot += pay;
    if (p.chips === 0) p.allIn = true;
  }

  currentPlayer() { return this.players[this.toAct]; }

  _skipDead() {
    // 跳过已弃牌 / 全押的玩家；若无人可行动则推进街
    for (let i = 0; i < this.n; i++) {
      const p = this.players[this.toAct];
      if (!p.folded && !p.allIn) return;
      this.toAct = (this.toAct + 1) % this.n;
    }
    this._advanceStreet();
  }

  livePlayers() { return this.players.filter(p => !p.folded); }
  actionablePlayers() { return this.players.filter(p => !p.folded && !p.allIn); }

  legalActions() {
    const p = this.currentPlayer();
    if (!p || this.street === 'showdown') return null;
    const toCall = this.currentBet - p.bet;
    const acts = { fold: true };
    if (toCall <= 0) acts.check = true;
    else acts.call = Math.min(toCall, p.chips);
    if (p.chips > toCall) {
      acts.raise = {
        min: Math.min(this.currentBet + this.minRaise, p.bet + p.chips),
        max: p.bet + p.chips, // raise-to 上限即全押
      };
    }
    return acts;
  }

  // action: {type:'fold'|'check'|'call'|'raise', amount?} amount 为 raise-to 总额
  act(playerId, action) {
    const p = this.currentPlayer();
    if (!p || p.id !== playerId) throw new Error('还没轮到你');
    if (this.street === 'showdown') throw new Error('本局已结束');
    const toCall = this.currentBet - p.bet;

    if (action.type === 'fold') {
      p.folded = true;
    } else if (action.type === 'check') {
      if (toCall > 0) throw new Error('有人下注，不能过牌');
    } else if (action.type === 'call') {
      const pay = Math.min(toCall, p.chips);
      if (pay <= 0) throw new Error('无需跟注');
      p.chips -= pay; p.bet += pay; p.total += pay; this.pot += pay;
      if (p.chips === 0) p.allIn = true;
    } else if (action.type === 'raise') {
      const target = Math.floor(action.amount);
      const maxTo = p.bet + p.chips;
      if (!(target > this.currentBet)) throw new Error('加注额必须高于当前注');
      if (target > maxTo) throw new Error('筹码不足');
      const isAllIn = target === maxTo;
      const fullRaise = target - this.currentBet >= this.minRaise;
      if (!fullRaise && !isAllIn) throw new Error(`最少加注到 ${this.currentBet + this.minRaise}`);
      const pay = target - p.bet;
      p.chips -= pay; p.bet = target; p.total += pay; this.pot += pay;
      if (p.chips === 0) p.allIn = true;
      if (fullRaise) {
        this.minRaise = target - this.currentBet;
        // 完整加注重新打开行动权
        for (const q of this.players) if (q !== p) q.actedThisRound = false;
      }
      this.currentBet = target;
      this.lastAggressorIndex = this.toAct;
    } else {
      throw new Error('未知操作');
    }

    p.actedThisRound = true;

    // 只剩一人 → 直接结束
    if (this.livePlayers().length === 1) {
      this._awardToLastPlayer();
      return;
    }

    // 检查本轮是否结束
    if (this._roundDone()) {
      this._advanceStreet();
    } else {
      this.toAct = (this.toAct + 1) % this.n;
      this._skipDeadForward();
    }
  }

  _skipDeadForward() {
    for (let i = 0; i < this.n; i++) {
      const p = this.players[this.toAct];
      if (!p.folded && !p.allIn) return;
      this.toAct = (this.toAct + 1) % this.n;
    }
    this._advanceStreet();
  }

  _roundDone() {
    const actionable = this.actionablePlayers();
    if (actionable.length === 0) return true;
    return actionable.every(p => p.actedThisRound && p.bet === this.currentBet);
  }

  _advanceStreet() {
    for (const p of this.players) { p.bet = 0; p.actedThisRound = false; }
    this.currentBet = 0;
    this.minRaise = this.bb;

    // 可行动玩家不足 2 人时直接发完公共牌摊牌
    const runOut = this.actionablePlayers().length < 2;

    const dealNext = () => {
      if (this.street === 'preflop') {
        this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        this.street = 'flop';
      } else if (this.street === 'flop') {
        this.board.push(this.deck.pop());
        this.street = 'turn';
      } else if (this.street === 'turn') {
        this.board.push(this.deck.pop());
        this.street = 'river';
      } else {
        this._showdown();
        return false;
      }
      return true;
    };

    if (runOut) {
      while (this.street !== 'showdown') { if (!dealNext()) break; }
      return;
    }

    if (!dealNext()) return;
    // 翻牌后从按钮位后第一个存活玩家开始行动
    this.toAct = (this.dealerIndex + 1) % this.n;
    this._skipDeadForwardNoAdvance();
  }

  _skipDeadForwardNoAdvance() {
    for (let i = 0; i < this.n; i++) {
      const p = this.players[this.toAct];
      if (!p.folded && !p.allIn) return;
      this.toAct = (this.toAct + 1) % this.n;
    }
  }

  _awardToLastPlayer() {
    const winner = this.livePlayers()[0];
    winner.chips += this.pot;
    this.street = 'showdown';
    this.results = {
      type: 'fold',
      winners: [{ id: winner.id, name: winner.name, amount: this.pot }],
      reveal: [],
    };
  }

  _showdown() {
    this.street = 'showdown';
    const live = this.livePlayers();
    const evals = new Map();
    for (const p of live) {
      evals.set(p.id, best7([...p.hole, ...this.board]));
    }

    // 依据每人投入构建边池
    const contributions = this.players.map(p => ({ p, amt: p.total }));
    const pots = [];
    let remaining = contributions.filter(c => c.amt > 0);
    while (remaining.length > 0) {
      const minAmt = Math.min(...remaining.map(c => c.amt));
      const potAmt = minAmt * remaining.length;
      const eligible = remaining.filter(c => !c.p.folded).map(c => c.p);
      pots.push({ amount: potAmt, eligible });
      for (const c of remaining) c.amt -= minAmt;
      remaining = remaining.filter(c => c.amt > 0);
    }

    const winnings = new Map();
    const potsInfo = []; // 每个底池的金额与归属（主池在前）
    for (const pot of pots) {
      if (pot.eligible.length === 0) continue; // 理论上不会发生
      let best = null, winners = [];
      for (const p of pot.eligible) {
        const s = evals.get(p.id).score;
        if (!best || compareScores(s, best) > 0) { best = s; winners = [p]; }
        else if (compareScores(s, best) === 0) winners.push(p);
      }
      const share = Math.floor(pot.amount / winners.length);
      let leftover = pot.amount - share * winners.length;
      for (const w of winners) {
        let amt = share;
        if (leftover > 0) { amt += 1; leftover -= 1; } // 余数给靠前的赢家
        winnings.set(w.id, (winnings.get(w.id) || 0) + amt);
      }
      potsInfo.push({ amount: pot.amount, winners: winners.map(w => w.name) });
    }

    for (const p of live) {
      const amt = winnings.get(p.id) || 0;
      p.chips += amt;
    }

    this.results = {
      type: 'showdown',
      winners: [...winnings.entries()].map(([id, amount]) => {
        const p = live.find(q => q.id === id);
        return { id, name: p.name, amount, handName: evals.get(id).name };
      }).filter(w => w.amount > 0),
      pots: potsInfo,
      reveal: live.map(p => ({
        id: p.id, name: p.name, hole: p.hole,
        handName: evals.get(p.id).name,
        bestCombo: evals.get(p.id).combo,
      })),
    };
  }

  isOver() { return this.street === 'showdown'; }
}

module.exports = { newDeck, shuffle, cardText, evaluate5, compareScores, best7, Hand, CATEGORY_NAMES, SUITS, RANK_NAMES };
