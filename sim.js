/* ============================================================
   AEROTWIN · 成都天府国际机场 TFU · 仿真内核
   ------------------------------------------------------------
   与渲染解耦的状态机 + 资源调度，纯逻辑、零依赖。
   同一份文件在两处复用：
     · 浏览器：经典 <script src="sim.js">，挂到全局 window.AeroSim
     · Node：require("./sim.js")，供 node:test 单元测试
   自带极简 Vec3，不依赖 three.js；渲染层只读取 .x/.y/.z。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // Node / 测试
  else root.AeroSim = api;                                                   // 浏览器全局
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
"use strict";

/* 极简三维向量：仅实现内核所需子集，语义与 THREE.Vector3 对应方法一致。
   渲染层通过 THREE 的 copy() 读取 .x/.y/.z，故二者可无缝衔接，sim 侧无需 three.js */
class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  distanceTo(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  lerpVectors(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this; }
  normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
  negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
}
const V = (x, y, z) => new Vec3(x, y, z);

const RWY = {
  A: { z: -80, name: "02L", holdZ: -62, exitX: 130, outX: -200 },
  B: { z: -140, name: "02R", holdZ: -122, exitX: 158, outX: -225 },
};
const GATE_COUNT = 14;
const gateX = (i) => -127 + i * 19.5;
const GATE_Z = -10, IN_TAXI_Z = -50, OUT_TAXI_Z = -30;

/* 川航为天府主基地航司，重复列入以提高占比 */
const AIRLINES = [["3U","川航"],["3U","川航"],["3U","川航"],["EU","成都航"],["CA","国航"],["MU","东航"],["CZ","南航"],["TV","西藏航"],["MF","厦航"],["8L","祥鹏"],["HU","海航"],["ZH","深航"]];
const CITIES = ["北京","上海","广州","深圳","西安","重庆","昆明","拉萨","杭州","三亚","贵阳","乌鲁木齐","南京","武汉","哈尔滨","郑州"];

const PHASE_LABEL = {
  holding:"盘旋等待", approach:"进近", landing:"着陆滑跑", taxiIn:"滑行入位",
  atGate:"停靠登机", pushback:"推出", taxiOut:"滑行离场", holdShort:"等待起飞",
  takeoff:"起飞爬升", departed:"已离场",
};
const PHASE_COLOR = {
  holding:"#ffb454", approach:"#5aa9ff", landing:"#5aa9ff", taxiIn:"#7a8aa8",
  atGate:"#3ddc97", pushback:"#7a8aa8", taxiOut:"#7a8aa8", holdShort:"#ffb454",
  takeoff:"#ff5347", departed:"#4a5874",
};
const SPEED = { approach:5.5, landing:6.0, taxiIn:1.5, pushback:0.5, taxiOut:1.6, takeoff:5.2 };

/* ------- 路径 ------- */
function makeRoute(pts) {
  const segs = []; let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = pts[i].distanceTo(pts[i + 1]);
    segs.push({ a: pts[i], b: pts[i + 1], len }); total += len;
  }
  return { segs, total, d: 0 };
}
function sampleRoute(route, outPos, outDir) {
  let d = Math.min(route.d, route.total);
  for (let i = 0; i < route.segs.length; i++) {
    const s = route.segs[i];
    if (d <= s.len || i === route.segs.length - 1) {
      const t = s.len > 0 ? Math.min(d / s.len, 1) : 1;
      outPos.lerpVectors(s.a, s.b, t);
      outDir.subVectors(s.b, s.a).normalize();
      return;
    }
    d -= s.len;
  }
}
const approachRoute = (rz) => makeRoute([V(-470,56,rz), V(-265,13,rz), V(-152,0.7,rz)]);
const landingRoute = (rw) => makeRoute([V(-152,0.7,rw.z), V(rw.exitX,0.7,rw.z)]);
function taxiInRoute(rw, gx) {
  const pts = [V(rw.exitX,0.7,rw.z)];
  if (rw.name === "02R") pts.push(V(205,0.7,rw.z), V(205,0.7,IN_TAXI_Z));
  else pts.push(V(rw.exitX,0.7,IN_TAXI_Z));
  pts.push(V(gx,0.7,IN_TAXI_Z), V(gx,0.7,GATE_Z));
  return makeRoute(pts);
}
const pushbackRoute = (gx) => makeRoute([V(gx,0.7,GATE_Z), V(gx,0.7,OUT_TAXI_Z)]);
const taxiOutRoute = (rw, gx) => makeRoute([V(gx,0.7,OUT_TAXI_Z), V(rw.outX,0.7,OUT_TAXI_Z), V(rw.outX,0.7,rw.holdZ)]);
const takeoffRoute = (rw) => makeRoute([V(rw.outX,0.7,rw.holdZ), V(-176,0.7,rw.z), V(150,0.7,rw.z), V(470,64,rw.z)]);
const taxiInDist = (rw, gx) => rw.name === "02R" ? (205 - rw.exitX) + 90 + (205 - gx) + 40 : (rw.exitX - gx) + 70;

/* ------- 同种子时刻表 ------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20260611;

function createSim(strategy) {
  const rng = mulberry32(SEED);
  const sim = {
    strategy, t: 0, clockBase: 6 * 3600,
    flights: [], schedule: [], schedIdx: 0, nextHoldSlot: 0,
    runways: {
      A: Object.assign({}, RWY.A, { key:"A", occupiedBy:null, closedUntil:0, busy:0 }),
      B: Object.assign({}, RWY.B, { key:"B", occupiedBy:null, closedUntil:0, busy:0 }),
    },
    gates: Array.from({ length: GATE_COUNT }, (_, i) => ({ i, x: gateX(i), occupiedBy: null })),
    stats: { landed:0, departed:0, onTime:0, delaySum:0, taxiInSum:0, taxiInN:0 },
    events: [],
  };
  let t = 15;
  for (let i = 0; i < 90; i++) {
    const pick = AIRLINES[Math.floor(rng() * AIRLINES.length)];
    sim.schedule.push({
      id: i, callsign: pick[0] + (1000 + Math.floor(rng() * 8999)),
      airline: pick[1], origin: CITIES[Math.floor(rng() * CITIES.length)],
      sched: t, turnaround: 320 + rng() * 260,
    });
    t += 38 + rng() * 40;
  }
  return sim;
}

const rwOpen = (rw, t) => t >= rw.closedUntil;
const log = (sim, msg) => { sim.events.unshift({ t: sim.t, msg }); if (sim.events.length > 40) sim.events.pop(); };
/* 注意：occupiedBy 取航班 id，而 id 可以是 0；故空闲判断一律用 === null，
   不能用 !occupiedBy（!0 为 true 会把 0 号航班占用的资源误判为空闲，导致双占） */
const freeOpenRunways = (sim) => ["A","B"].map((k) => sim.runways[k]).filter((r) => rwOpen(r, sim.t) && r.occupiedBy === null);

function pickLandingRunway(sim) {
  const free = freeOpenRunways(sim);
  if (!free.length) return null;
  if (sim.strategy === "fcfs")
    return free.find((r) => r.key === "A") || free.find((r) => r.key === "B") || null;
  return free.sort((a, b) => a.busy - b.busy)[0];
}
function pickTakeoffRunway(sim, currentKey) {
  if (sim.strategy === "fcfs") {
    const rw = sim.runways.B;
    return rwOpen(rw, sim.t) && rw.occupiedBy === null ? rw : null;
  }
  const free = freeOpenRunways(sim);
  if (!free.length) return null;
  const cur = free.find((r) => r.key === currentKey);
  return cur || free.sort((a, b) => a.busy - b.busy)[0];
}
function pickGate(sim, rw) {
  const free = sim.gates.filter((g) => g.occupiedBy === null);
  if (!free.length) return null;
  if (sim.strategy === "fcfs") return free[0];
  return free.sort((a, b) => taxiInDist(rw, a.x) - taxiInDist(rw, b.x))[0];
}
function advance(f, speed, dt) {
  f.route.d += speed * dt;
  sampleRoute(f.route, f.pos, f.dir);
  return f.route.d >= f.route.total;
}

function stepFlight(sim, f, dt) {
  switch (f.phase) {
    case "holding": {
      f.holdAngle += 0.16 * dt;
      const cx = -480, cz = -110 + (f.holdSlot % 3) * 26, cy = 58 + (f.holdSlot % 4) * 7, r = 52;
      f.pos.set(cx + Math.cos(f.holdAngle) * r, cy, cz + Math.sin(f.holdAngle) * r * 0.55);
      f.dir.set(-Math.sin(f.holdAngle), 0, Math.cos(f.holdAngle) * 0.55).normalize();
      const rw = pickLandingRunway(sim);
      if (!rw) break;
      const gate = pickGate(sim, rw);
      if (!gate) break;
      gate.occupiedBy = f.id; f.gate = gate;
      rw.occupiedBy = f.id; f.rwy = rw;
      f.delay = sim.t - f.sched;
      f.phase = "approach"; f.route = approachRoute(rw.z);
      log(sim, f.callsign + " 获准进近 跑道" + rw.name + " → 机位" + (gate.i + 1));
      break;
    }
    case "approach":
      if (advance(f, SPEED.approach, dt)) {
        f.phase = "landing"; f.route = landingRoute(f.rwy);
        log(sim, f.callsign + " 跑道" + f.rwy.name + " 接地");
      }
      break;
    case "landing":
      if (advance(f, SPEED.landing, dt)) {
        f.rwy.occupiedBy = null;
        sim.stats.landed++; sim.stats.delaySum += Math.max(0, f.delay);
        if (f.delay < 90) sim.stats.onTime++;
        f.taxiStart = sim.t;
        f.phase = "taxiIn"; f.route = taxiInRoute(f.rwy, f.gate.x);
      }
      break;
    case "taxiIn":
      if (advance(f, SPEED.taxiIn, dt)) {
        sim.stats.taxiInSum += sim.t - f.taxiStart; sim.stats.taxiInN++;
        f.phase = "atGate"; f.boardUntil = sim.t + f.turnaround;
        log(sim, f.callsign + " 停靠机位 " + (f.gate.i + 1));
      }
      break;
    case "atGate":
      if (sim.t >= f.boardUntil) { f.phase = "pushback"; f.backward = true; f.route = pushbackRoute(f.gate.x); }
      break;
    case "pushback":
      if (advance(f, SPEED.pushback, dt)) {
        f.backward = false; f.gate.occupiedBy = null;
        if (sim.strategy === "fcfs") f.outRwyKey = "B";
        else {
          f.outRwyKey = (sim.runways.A.busy <= sim.runways.B.busy && rwOpen(sim.runways.A, sim.t)) ? "A" : "B";
          if (!rwOpen(sim.runways[f.outRwyKey], sim.t)) f.outRwyKey = "A";
        }
        f.phase = "taxiOut"; f.route = taxiOutRoute(sim.runways[f.outRwyKey], f.gate.x);
      }
      break;
    case "taxiOut":
      if (advance(f, SPEED.taxiOut, dt)) {
        f.phase = "holdShort";
        const n = sim.flights.filter((o) => o !== f && o.phase === "holdShort" && o.outRwyKey === f.outRwyKey).length;
        f.pos.z += Math.min(n, 4) * 9;
      }
      break;
    case "holdShort": {
      if (sim.strategy === "smart") {
        const cur = sim.runways[f.outRwyKey];
        if (!rwOpen(cur, sim.t)) {
          const altKey = f.outRwyKey === "B" ? "A" : "B";
          const alt = sim.runways[altKey];
          if (rwOpen(alt, sim.t)) {
            f.outRwyKey = altKey; f.phase = "taxiOut";
            f.route = makeRoute([V(cur.outX,0.7,cur.holdZ), V(alt.outX,0.7,alt.holdZ)]);
            log(sim, f.callsign + " 改道跑道" + alt.name + " 离场");
            break;
          }
        }
      }
      const rw = pickTakeoffRunway(sim, f.outRwyKey);
      if (rw) {
        f.outRwyKey = rw.key;
        rw.occupiedBy = f.id; f.rwy = rw;
        f.phase = "takeoff"; f.route = takeoffRoute(rw);
        log(sim, f.callsign + " 跑道" + rw.name + " 起飞");
      }
      break;
    }
    case "takeoff":
      if (f.pos.x > 200 && f.rwy.occupiedBy === f.id) f.rwy.occupiedBy = null;
      if (advance(f, SPEED.takeoff, dt)) { f.phase = "departed"; sim.stats.departed++; }
      break;
  }
}

function stepSim(sim, dt) {
  sim.t += dt;
  while (sim.schedIdx < sim.schedule.length && sim.t >= sim.schedule[sim.schedIdx].sched) {
    const s = sim.schedule[sim.schedIdx++];
    sim.flights.push(Object.assign({}, s, {
      phase: "holding", holdAngle: (s.id * 1.7) % (Math.PI * 2),
      holdSlot: sim.nextHoldSlot++, pos: V(-480, 60, -110), dir: V(1, 0, 0),
      route: null, gate: null, rwy: null, delay: 0, backward: false, outRwyKey: "B",
    }));
  }
  for (const f of sim.flights) if (f.phase !== "departed") stepFlight(sim, f, dt);
  for (const k of ["A","B"]) if (sim.runways[k].occupiedBy !== null) sim.runways[k].busy += dt;
}

function snapshotKpi(sim) {
  const active = sim.flights.filter((f) => f.phase !== "departed");
  return {
    active: active.length,
    holding: active.filter((f) => f.phase === "holding").length,
    landed: sim.stats.landed, departed: sim.stats.departed,
    onTime: sim.stats.landed ? Math.round((sim.stats.onTime / sim.stats.landed) * 100) : 100,
    avgDelay: sim.stats.landed ? Math.round(sim.stats.delaySum / sim.stats.landed) : 0,
    avgTaxi: sim.stats.taxiInN ? Math.round(sim.stats.taxiInSum / sim.stats.taxiInN) : 0,
    utilA: sim.t > 1 ? Math.round((sim.runways.A.busy / sim.t) * 100) : 0,
    utilB: sim.t > 1 ? Math.round((sim.runways.B.busy / sim.t) * 100) : 0,
  };
}

return {
  Vec3, V, RWY, GATE_COUNT, gateX, GATE_Z, IN_TAXI_Z, OUT_TAXI_Z,
  AIRLINES, CITIES, PHASE_LABEL, PHASE_COLOR, SPEED, SEED, mulberry32,
  makeRoute, sampleRoute, approachRoute, landingRoute, taxiInRoute,
  pushbackRoute, taxiOutRoute, takeoffRoute, taxiInDist,
  createSim, rwOpen, log, freeOpenRunways,
  pickLandingRunway, pickTakeoffRunway, pickGate, advance, stepFlight, stepSim, snapshotKpi,
};
});
