// 引擎单元测试
'use strict';
const { evaluate5, compareScores, best7, Hand } = require('./engine');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', msg); }
}
function C(r, s) { return { r, s }; }

// ---- 牌型识别 ----
const royal = evaluate5([C(14,0),C(13,0),C(12,0),C(11,0),C(10,0)]);
assert(royal[0] === 8 && royal[1] === 14, '皇家同花顺');

const wheelSF = evaluate5([C(14,1),C(2,1),C(3,1),C(4,1),C(5,1)]);
assert(wheelSF[0] === 8 && wheelSF[1] === 5, 'A-5 同花顺（轮子）');

const quads = evaluate5([C(9,0),C(9,1),C(9,2),C(9,3),C(2,0)]);
assert(quads[0] === 7 && quads[1] === 9 && quads[2] === 2, '四条');

const fh = evaluate5([C(8,0),C(8,1),C(8,2),C(3,0),C(3,1)]);
assert(fh[0] === 6 && fh[1] === 8 && fh[2] === 3, '葫芦');

const flush = evaluate5([C(14,2),C(10,2),C(7,2),C(4,2),C(2,2)]);
assert(flush[0] === 5 && flush[1] === 14, '同花');

const straight = evaluate5([C(10,0),C(9,1),C(8,2),C(7,3),C(6,0)]);
assert(straight[0] === 4 && straight[1] === 10, '顺子');

const wheel = evaluate5([C(14,0),C(2,1),C(3,2),C(4,3),C(5,0)]);
assert(wheel[0] === 4 && wheel[1] === 5, 'A-5 顺子');

const trips = evaluate5([C(7,0),C(7,1),C(7,2),C(14,0),C(2,1)]);
assert(trips[0] === 3 && trips[1] === 7, '三条');

const twoPair = evaluate5([C(11,0),C(11,1),C(4,2),C(4,3),C(14,0)]);
assert(twoPair[0] === 2 && twoPair[1] === 11 && twoPair[2] === 4 && twoPair[3] === 14, '两对');

const pair = evaluate5([C(6,0),C(6,1),C(14,2),C(9,3),C(2,0)]);
assert(pair[0] === 1 && pair[1] === 6, '一对');

const high = evaluate5([C(14,0),C(12,1),C(9,2),C(6,3),C(3,0)]);
assert(high[0] === 0 && high[1] === 14, '高牌');

// ---- 大小比较 ----
assert(compareScores(royal, quads) > 0, '同花顺 > 四条');
assert(compareScores(fh, flush) > 0, '葫芦 > 同花');
assert(compareScores(straight, wheel) > 0, '10 高顺子 > 轮子');
const twoPairB = evaluate5([C(11,0),C(11,1),C(4,2),C(4,3),C(13,0)]);
assert(compareScores(twoPair, twoPairB) > 0, '两对踢脚 A > K');

// ---- 7 选 5 ----
const b = best7([C(14,0),C(13,0),C(12,0),C(11,0),C(10,0),C(2,1),C(3,2)]);
assert(b.score[0] === 8 && b.score[1] === 14, '7 张中找出皇家同花顺');
const b2 = best7([C(9,0),C(9,1),C(5,2),C(5,3),C(9,2),C(5,0),C(2,1)]);
assert(b2.score[0] === 6 && b2.score[1] === 9 && b2.score[2] === 5, '7 张中找出最大葫芦 999+55');

// ---- 完整牌局：3 人打到摊牌 ----
function fixedRng(seq) { let i = 0; return () => seq[i++ % seq.length]; }
{
  const players = [
    { id: 'a', name: 'A', chips: 1000 },
    { id: 'b', name: 'B', chips: 1000 },
    { id: 'c', name: 'C', chips: 1000 },
  ];
  const h = new Hand(players, 0, 5, 10);
  // 翻牌前：依次跟注/过牌直到进入翻牌
  let guard = 0;
  while (h.street === 'preflop' && guard++ < 20) {
    const p = h.currentPlayer();
    const legal = h.legalActions();
    h.act(p.id, legal.check ? { type: 'check' } : { type: 'call' });
  }
  assert(h.street === 'flop', '翻牌前结束后进入翻牌，实际: ' + h.street);
  assert(h.board.length === 3, '翻牌发 3 张公共牌');
  assert(h.pot === 30, '3 人各投 10，彩池 30，实际: ' + h.pot);

  // 打完剩余街
  guard = 0;
  while (!h.isOver() && guard++ < 60) {
    const p = h.currentPlayer();
    const legal = h.legalActions();
    h.act(p.id, legal.check ? { type: 'check' } : { type: 'call' });
  }
  assert(h.isOver(), '牌局正常结束');
  assert(h.board.length === 5, '共 5 张公共牌');
  const total = players.reduce((s, p) => s + p.chips, 0);
  assert(total === 3000, '筹码守恒（总量 3000），实际: ' + total);
  assert(h.results.winners.reduce((s, w) => s + w.amount, 0) === 30, '赢家分得全部彩池');
}

// ---- 弃牌获胜 ----
{
  const players = [
    { id: 'a', name: 'A', chips: 500 },
    { id: 'b', name: 'B', chips: 500 },
  ];
  const h = new Hand(players, 0, 5, 10); // 两人局：庄家 A 是小盲，先行动
  h.act(h.currentPlayer().id, { type: 'fold' });
  assert(h.isOver() && h.results.type === 'fold', '一人弃牌立即结束');
  const winner = players.find(p => p.id === h.results.winners[0].id);
  assert(winner.chips === 505, '弃牌后赢家拿走盲注，实际: ' + winner.chips);
  assert(players[0].chips + players[1].chips === 1000, '筹码守恒');
}

// ---- 加注与最小加注规则 ----
{
  const players = [
    { id: 'a', name: 'A', chips: 1000 },
    { id: 'b', name: 'B', chips: 1000 },
    { id: 'c', name: 'C', chips: 1000 },
  ];
  const h = new Hand(players, 0, 5, 10);
  const first = h.currentPlayer(); // BB 之后 = 庄家 A（3 人局 UTG）
  let threw = false;
  try { h.act(first.id, { type: 'raise', amount: 15 }); } catch (e) { threw = true; }
  assert(threw, '低于最小加注被拒绝');
  h.act(first.id, { type: 'raise', amount: 30 });
  assert(h.currentBet === 30 && h.minRaise === 20, '加注到 30 后最小再加注增量为 20');
}

// ---- 全押 + 边池 ----
{
  const players = [
    { id: 'a', name: 'A', chips: 100 },  // 短码
    { id: 'b', name: 'B', chips: 1000 },
    { id: 'c', name: 'C', chips: 1000 },
  ];
  const h = new Hand(players, 0, 5, 10);
  // 3人局 preflop: SB=B(1), BB=C(2), 先行动 = A(0)
  h.act('a', { type: 'raise', amount: 100 }); // A 全押 100
  h.act('b', { type: 'raise', amount: 300 }); // B 加注到 300
  h.act('c', { type: 'call' });                // C 跟 300
  assert(h.street === 'flop', 'A 全押后 B、C 仍可继续下注，进入翻牌');
  // B、C 一路过牌到摊牌
  let guard2 = 0;
  while (!h.isOver() && guard2++ < 30) {
    h.act(h.currentPlayer().id, { type: 'check' });
  }
  assert(h.isOver(), '过牌到底后摊牌');
  const total = players.reduce((s, p) => s + p.chips, 0);
  assert(total === 2100, '边池结算后筹码守恒，实际: ' + total);
  // A 最多只能赢主池 100*3=300
  if (players[0].chips > 100) {
    assert(players[0].chips <= 300, 'A 赢的不超过主池 300，实际: ' + players[0].chips);
  }
}

// ---- 大量随机牌局：筹码永远守恒、永不崩溃 ----
{
  let ok = true;
  for (let trial = 0; trial < 2000; trial++) {
    const n = 2 + (trial % 5);
    const players = [];
    for (let i = 0; i < n; i++) {
      players.push({ id: 'p' + i, name: 'P' + i, chips: 50 + Math.floor(Math.random() * 500) });
    }
    const before = players.reduce((s, p) => s + p.chips, 0);
    const h = new Hand(players, trial % n, 5, 10);
    let guard = 0;
    while (!h.isOver() && guard++ < 200) {
      const p = h.currentPlayer();
      const legal = h.legalActions();
      const r = Math.random();
      try {
        if (legal.raise && r < 0.3) {
          const amt = legal.raise.min + Math.floor(Math.random() * (legal.raise.max - legal.raise.min + 1));
          h.act(p.id, { type: 'raise', amount: amt });
        } else if (legal.check && r < 0.8) h.act(p.id, { type: 'check' });
        else if (legal.call && r < 0.8) h.act(p.id, { type: 'call' });
        else if (legal.check) h.act(p.id, { type: 'check' });
        else h.act(p.id, { type: 'fold' });
      } catch (e) {
        ok = false;
        console.error('随机牌局异常:', e.message, 'trial', trial);
        break;
      }
    }
    const after = players.reduce((s, p) => s + p.chips, 0);
    if (!h.isOver() || before !== after) {
      ok = false;
      console.error('随机牌局失败: trial', trial, 'over=', h.isOver(), 'before=', before, 'after=', after);
      break;
    }
  }
  assert(ok, '2000 局随机模拟全部通过（筹码守恒 + 正常结束）');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
