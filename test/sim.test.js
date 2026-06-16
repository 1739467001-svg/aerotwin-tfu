"use strict";
/* 仿真内核单元测试 —— 零依赖，使用 Node 内置 node:test。
   运行：npm test （即 node --test）
   覆盖：确定性 / 活性 / 资源互斥不变量 / falsy-0 回归 / A/B 结论 / golden 基准 */
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../sim.js");
const { createSim, stepSim, snapshotKpi, freeOpenRunways, GATE_COUNT } = S;

const DT = 0.1; // 与 index.html 主循环固定步长 SIM_STEP 保持一致

/* 跑道/机位资源互斥不变量；返回首个违例描述，无违例返回 null */
function invariantViolation(sim) {
  const active = sim.flights.filter((f) => f.phase !== "departed");
  for (const key of ["A", "B"]) {
    const landers = active.filter((f) => f.rwy && f.rwy.key === key && (f.phase === "approach" || f.phase === "landing"));
    if (landers.length > 1) return `t=${sim.t.toFixed(1)} 跑道${key} 同时 ${landers.length} 架进近/着陆`;
    const rw = sim.runways[key];
    if (rw.occupiedBy !== null) {
      const owners = active.filter((f) => f.id === rw.occupiedBy);
      if (owners.length !== 1) return `t=${sim.t.toFixed(1)} 跑道${key} 锁泄漏 occupiedBy=${rw.occupiedBy} 活动占有者=${owners.length}`;
    }
  }
  let used = 0;
  for (const g of sim.gates) {
    if (g.occupiedBy !== null) {
      used++;
      const owners = active.filter((f) => f.id === g.occupiedBy && f.gate === g);
      if (owners.length !== 1) return `t=${sim.t.toFixed(1)} 机位${g.i} 不一致 occupiedBy=${g.occupiedBy} 匹配占有者=${owners.length}`;
    }
  }
  if (used > GATE_COUNT) return `t=${sim.t.toFixed(1)} 机位超发 ${used}>${GATE_COUNT}`;
  return null;
}

/* 推进直到 90 架全部离场（或步数上限）。
   storm 非空时，在该 sim 时刻注入雷暴关闭 02R 5 分钟；onStep 每步回调 */
function runToDrain(strategy, { storm = null, maxSteps = 200000, onStep = null } = {}) {
  const sim = createSim(strategy);
  let stormFired = false, steps = 0;
  for (; steps < maxSteps && sim.stats.departed < 90; steps++) {
    stepSim(sim, DT);
    if (storm !== null && !stormFired && sim.t >= storm) { sim.runways.B.closedUntil = sim.t + 300; stormFired = true; }
    if (onStep) onStep(sim);
  }
  return { sim, drainT: sim.t, steps };
}

test("确定性：同一种子两次仿真结果逐位一致", () => {
  const a = runToDrain("smart");
  const b = runToDrain("smart");
  assert.deepEqual(a.sim.stats, b.sim.stats);
  assert.deepEqual(snapshotKpi(a.sim), snapshotKpi(b.sim));
  assert.equal(a.steps, b.steps);
});

test("活性：四种场景下 90 架航班全部离场、无滞留", () => {
  const cases = [
    ["smart", {}], ["fcfs", {}],
    ["smart", { storm: 1800 }], ["fcfs", { storm: 1800 }],
  ];
  for (const [strat, opt] of cases) {
    const tag = strat + (opt.storm ? "+storm" : "");
    const { sim, steps } = runToDrain(strat, opt);
    assert.equal(sim.stats.departed, 90, `${tag}: 应全部离场`);
    assert.equal(snapshotKpi(sim).active, 0, `${tag}: 不应有滞留航班`);
    assert.ok(steps < 200000, `${tag}: 应在步数上限内排空`);
  }
});

test("资源互斥不变量：全程跑道不双占、机位不超发、无锁泄漏", () => {
  for (const strat of ["smart", "fcfs"]) {
    let viol = null;
    runToDrain(strat, { storm: 1800, onStep: (sim) => { if (!viol) viol = invariantViolation(sim); } });
    assert.equal(viol, null, `${strat} 出现违例：${viol}`);
  }
});

test("滑行道冲突检测：同车道同向跟随机始终保持 ≈TAXI_SEP 间隔、不叠合", () => {
  const { V, makeRoute, advanceTaxi, TAXI_SEP } = S;
  // 同一条 -x 直线滑行道：慢车在前、快车在后
  const lead = { id: 1, phase: "taxiOut", pos: V(0, 0.7, -30), dir: V(-1, 0, 0), route: makeRoute([V(0, 0.7, -30), V(-200, 0.7, -30)]) };
  const follow = { id: 2, phase: "taxiOut", pos: V(20, 0.7, -30), dir: V(-1, 0, 0), route: makeRoute([V(20, 0.7, -30), V(-200, 0.7, -30)]) };
  const sim = { flights: [lead, follow] };
  let minGap = Infinity;
  for (let i = 0; i < 400; i++) {
    advanceTaxi(sim, lead, 0.5, DT);   // 慢车在前
    advanceTaxi(sim, follow, 2.0, DT); // 快车在后，必然追上
    minGap = Math.min(minGap, follow.pos.distanceTo(lead.pos));
  }
  assert.ok(minGap >= TAXI_SEP - 1, `跟随机最小间距 ${minGap.toFixed(2)} 应 ≥ ${TAXI_SEP - 1}`);
});

test("汇入口防死锁：垂直/反向交汇不触发跟车阻塞，仅同向才阻塞", () => {
  const { V, makeRoute, taxiLeaderAhead } = S;
  const seg = (a, b) => makeRoute([a, b]);
  const self = { id: 1, phase: "taxiIn", pos: V(0, 0.7, -50), dir: V(-1, 0, 0), route: seg(V(0, 0.7, -50), V(-50, 0.7, -50)) };
  const at = self.pos;
  // 垂直交汇（航向 +z）：虽在正前方近距，但不同向 → 不阻塞（否则汇入口会环形死锁）
  const cross = { id: 2, phase: "taxiIn", pos: V(-5, 0.7, -50), dir: V(0, 0, 1), route: seg(V(-5, 0.7, -60), V(-5, 0.7, -40)) };
  assert.equal(taxiLeaderAhead({ flights: [self, cross] }, self, at), false, "垂直交汇不应阻塞");
  // 反向交汇（航向 +x）：不阻塞
  const onc = { id: 3, phase: "taxiIn", pos: V(-5, 0.7, -50), dir: V(1, 0, 0), route: seg(V(-5, 0.7, -50), V(40, 0.7, -50)) };
  assert.equal(taxiLeaderAhead({ flights: [self, onc] }, self, at), false, "反向交汇不应阻塞");
  // 对照：同向、前方、近距 → 应阻塞
  const ld = { id: 4, phase: "taxiIn", pos: V(-5, 0.7, -50), dir: V(-1, 0, 0), route: seg(V(-5, 0.7, -50), V(-50, 0.7, -50)) };
  assert.equal(taxiLeaderAhead({ flights: [self, ld] }, self, at), true, "同向前方近距应阻塞");
});

test("falsy-0 回归：0 号航班能真正占用跑道与机位（occupiedBy 可为 0）", () => {
  const sim = createSim("smart");
  let f0 = null;
  for (let i = 0; i < 3000 && (!f0 || f0.phase === "holding"); i++) {
    stepSim(sim, DT);
    f0 = sim.flights.find((f) => f.id === 0);
  }
  assert.ok(f0 && f0.phase !== "holding", "0 号航班应已获准进近");
  assert.equal(f0.rwy.occupiedBy, 0, "0 号航班应占用其跑道：occupiedBy 必须是 0，而非被真值判断当作空闲");
  assert.ok(!freeOpenRunways(sim).includes(f0.rwy), "occupiedBy=0 的跑道不得被判为空闲");
  assert.equal(f0.gate.occupiedBy, 0);
  assert.ok(!sim.gates.some((g) => g === f0.gate && g.occupiedBy === null), "0 号航班的机位不得被判为空闲");
});

test("A/B：智能调度平均滑入距离短于 FCFS（最短滑入机位分配）", () => {
  const smart = snapshotKpi(runToDrain("smart").sim);
  const fcfs = snapshotKpi(runToDrain("fcfs").sim);
  assert.ok(smart.avgTaxi < fcfs.avgTaxi, `smart avgTaxi=${smart.avgTaxi} 应 < fcfs avgTaxi=${fcfs.avgTaxi}`);
});

test("A/B：雷暴关闭 02R 时智能调度比 FCFS 更快排空", () => {
  const smart = runToDrain("smart", { storm: 1800 });
  const fcfs = runToDrain("fcfs", { storm: 1800 });
  assert.ok(smart.drainT < fcfs.drainT, `storm 下 smart 排空 ${smart.drainT.toFixed(0)}s 应 < fcfs ${fcfs.drainT.toFixed(0)}s`);
});

test("golden 回归：smart 在 t≈3600 的 KPI 基准（有意改动内核时需同步更新此值）", () => {
  const sim = createSim("smart");
  while (sim.t < 3600) stepSim(sim, DT);
  assert.deepEqual(snapshotKpi(sim), {
    active: 36, holding: 18, landed: 43, departed: 26,
    onTime: 56, avgDelay: 237, avgTaxi: 141, utilA: 97, utilB: 97,
  });
});
