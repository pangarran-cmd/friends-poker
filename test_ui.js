// 用无头浏览器模拟 3 个玩家联机打牌并截图
'use strict';
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

  // 三个独立的浏览器上下文 = 三个玩家（各自的 localStorage）
  const ctxA = await browser.newContext(mobile);
  const ctxB = await browser.newContext(mobile);
  const ctxC = await browser.newContext(mobile);
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const C = await ctxC.newPage();

  const url = 'http://localhost:3000';
  const errors = [];
  for (const [p, nm] of [[A,'A'],[B,'B'],[C,'C']]) {
    p.on('pageerror', e => errors.push(`${nm} pageerror: ${e.message}`));
    p.on('console', m => { if (m.type() === 'error') errors.push(`${nm} console: ${m.text()}`); });
  }

  // 玩家 A 创建房间
  await A.goto(url);
  await A.fill('#inName', '小明');
  await A.screenshot({ path: 'shot_lobby.png' });
  await A.click('#btnCreate');
  await A.waitForSelector('#game', { state: 'visible' });
  const code = await A.textContent('#roomCode');
  console.log('房间号:', code);

  // B、C 加入
  for (const [p, name] of [[B, '阿强'], [C, '老王']]) {
    await p.goto(url);
    await p.fill('#inName', name);
    await p.fill('#inCode', code);
    await p.click('#btnJoin');
    await p.waitForSelector('#game', { state: 'visible' });
  }
  await A.waitForTimeout(500);

  // 房主开始游戏
  await A.click('#btnStart');
  await A.waitForTimeout(800);
  await A.screenshot({ path: 'shot_table_A.png' });

  // 验证：每人都能看到自己的两张手牌
  for (const [p, nm] of [[A,'A'],[B,'B'],[C,'C']]) {
    const n = await p.locator('#myCards .card').count();
    console.log(`玩家${nm} 手牌数量: ${n}`);
    if (n !== 2) errors.push(`${nm} 手牌数量错误: ${n}`);
  }

  // 打一整局：轮到谁谁就 过牌/跟注
  const pages = [A, B, C];
  let actions = 0;
  for (let i = 0; i < 40; i++) {
    let acted = false;
    for (const p of pages) {
      const visible = await p.locator('#actionBtns').isVisible().catch(() => false);
      if (!visible) continue;
      const checkVisible = await p.locator('#btnCheck').isVisible();
      const callVisible = await p.locator('#btnCall').isVisible();
      if (checkVisible) { await p.click('#btnCheck'); acted = true; actions++; }
      else if (callVisible) { await p.click('#btnCall'); acted = true; actions++; }
      if (acted) break;
    }
    await A.waitForTimeout(350);
    const ann = await A.locator('#announce').isVisible();
    if (ann) break;
  }
  console.log('总操作次数:', actions);
  await A.waitForTimeout(600);
  const annText = await A.textContent('#announce').catch(() => '');
  console.log('结算公告:', annText.trim());
  await A.screenshot({ path: 'shot_showdown.png' });

  // 测试一次加注流程（下一局开始后）
  await A.waitForTimeout(6500); // 等自动开下一局
  let raised = false;
  for (const p of pages) {
    const visible = await p.locator('#actionBtns').isVisible().catch(() => false);
    if (!visible) continue;
    const raiseVisible = await p.locator('#btnRaise').isVisible();
    if (raiseVisible) {
      await p.click('#btnRaise');
      await p.waitForTimeout(200);
      await p.click('#btnRaiseConfirm');
      raised = true;
      console.log('加注操作成功');
    }
    break;
  }
  if (!raised) errors.push('未能完成加注操作测试');
  await A.waitForTimeout(400);

  // 排行榜
  await A.click('#btnLb');
  await A.waitForTimeout(300);
  const lbRows = await A.locator('#lbBody tr').count();
  console.log('排行榜行数:', lbRows);
  await A.screenshot({ path: 'shot_leaderboard.png' });
  if (lbRows < 3) errors.push('排行榜数据不足');

  // 测试断线重连：B 刷新页面后应自动可重进
  await B.reload();
  await B.waitForTimeout(400);
  // 刷新后回到大厅，但房间号已在 URL，token 相同 → 重新加入
  await B.fill('#inName', '阿强');
  await B.click('#btnJoin');
  await B.waitForSelector('#game', { state: 'visible' });
  console.log('B 刷新后重连成功');

  if (errors.length) {
    console.error('\n发现问题:');
    errors.forEach(e => console.error(' -', e));
    process.exit(1);
  }
  console.log('\nUI 测试全部通过 ✓');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
