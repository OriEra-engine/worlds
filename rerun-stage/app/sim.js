/* ============================================================
 * app/sim.js —— 桌面操作确定性模拟器（具身智能赛道核心机制）
 * 铁律：同（场景卡 × 策略 × 种子）→ 同轨迹 → 同帧哈希链，逐帧可复演。
 *   · mulberry32 / fnv1a      确定性随机源与帧哈希（本文件禁用 Math.random）
 *   · runSim                  固定 tick 序列（dt=1/60，≤900 帧）的动力学状态机：
 *                             接近→推杆→到位，接触冲击>阈值即碰倒 fragile 物
 *   · applyOps                导演四算子（shift/distract/tighten/slip）对场景卡的确定性改写
 *   · matchTaskOffline        离线出题：自然语言 → 任务库关键词匹配 → 同一张场景卡
 *   · verifyReplay            复演校验：重跑同种子，逐帧哈希比对「一手不差」
 * 纯函数、无 DOM，Node 可直接 import 做确定性回归（scripts/check.mjs B 段）。
 * ============================================================ */

/* ---------- 确定性原语 ---------- */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort()
      .map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
/* 量化到 1e-3 整数——帧哈希与轨迹落账的最小单位（-0 归一为 0） */
export function q3(v) { return Math.round(v * 1000) + 0; }

/* 帧哈希：量化状态 → FNV-1a 8 位十六进制。轨迹逐帧哈希链 = 复演校验凭据 */
export function frameHash(s) {
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xffff; h = Math.imul(h, 0x01000193); h ^= (n >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
  mix(q3(s.rx)); mix(q3(s.rz)); mix(q3(s.dir * 100));
  for (const o of s.objs) { mix(q3(o.x)); mix(q3(o.z)); mix(o.top ? 1 : 0); mix(o.fell ? 1 : 0); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/* ---------- 场景卡规范化（在线模型输出与离线模板走同一套夹紧） ---------- */
const COLORS = new Set(["red", "blue", "green", "yellow", "white", "gray", "brown", "purple"]);
export function normalizeCard(raw) {
  const notes = [];
  if (!raw || typeof raw !== "object") return { ok: false, reason: "场景卡不是对象" };
  const w = clamp(+raw.table?.w || 10, 4, 12), h = clamp(+raw.table?.h || 6, 3, 8);
  const card = { table: { w, h }, objects: [], goal: { verb: "push", target: "", dest: "", tol: 0.5 }, constraints: ["no_topple", "stay_on_table"], title: String(raw.title || "自定义任务").slice(0, 24), seed: 0 };
  const objs = Array.isArray(raw.objects) ? raw.objects.slice(0, 10) : [];
  if (objs.length < 2) return { ok: false, reason: "场景卡至少需要 2 个物体（目标物+目的地）" };
  let n = 0;
  for (const o of objs) {
    const type = ["cup", "bottle", "box", "can", "coaster", "pad"].includes(o.type) ? o.type : "cup";
    const id = String(o.id || "obj_" + n).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 20) || "obj_" + n;
    card.objects.push({
      id, type,
      color: COLORS.has(o.color) ? o.color : "gray",
      x: clamp(+o.x || 0, -(w / 2 - 0.4), w / 2 - 0.4),
      y: clamp(+o.y || 0, -(h / 2 - 0.4), h / 2 - 0.4),
      r: clamp(+o.r || 0.35, 0.18, 0.8),
      fragile: !!o.fragile,
    });
    n++;
  }
  /* 重名 id 去重（后到者改名） */
  const seen = new Set();
  for (const o of card.objects) { while (seen.has(o.id)) o.id = o.id + "_x"; seen.add(o.id); }
  const flatTypes = new Set(["coaster", "pad"]);
  const goal = raw.goal || {};
  const target = String(goal.target || ""), dest = String(goal.dest || "");
  if (!card.objects.some(o => o.id === target)) return { ok: false, reason: "goal.target 不在物体表中: " + target };
  if (!card.objects.some(o => o.id === dest)) return { ok: false, reason: "goal.dest 不在物体表中: " + dest };
  if (target === dest) return { ok: false, reason: "goal.target 与 dest 不得相同" };
  if (!flatTypes.has(card.objects.find(o => o.id === dest).type)) notes.push("目的地不是 coaster/pad，按普通物体处理（机器人会绕它）");
  card.goal = { verb: "push", target, dest, tol: clamp(+goal.tol || 0.5, 0.15, 0.9) };
  const frag = card.objects.filter(o => o.fragile);
  if (frag.length > 2) { frag.slice(2).forEach(o => o.fragile = false); notes.push("fragile 物体最多 2 个，多余者降级为普通物体"); }
  /* 物体间距 ≥ (r1+r2+0.35)，重叠者沿连线推开（确定性） */
  for (let i = 0; i < card.objects.length; i++)
    for (let j = i + 1; j < card.objects.length; j++) {
      const a = card.objects[i], b = card.objects[j];
      const need = a.r + b.r + 0.35;
      let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d < 1e-6) { dx = 0.5; dy = 0; d = 0.5; }
      if (d < need) {
        const push = (need - d) / 2;
        a.x -= dx / d * push; a.y -= dy / d * push;
        b.x += dx / d * push; b.y += dy / d * push;
      }
    }
  for (const o of card.objects) { o.x = clamp(o.x, -(w / 2 - 0.4), w / 2 - 0.4); o.y = clamp(o.y, -(h / 2 - 0.4), h / 2 - 0.4); }
  card.slipLevel = clamp(Math.round(+raw.slipLevel || 0), 0, 2);
  card.seed = (fnv1a(stableStringify(card)) ^ 0x5a5a) >>> 0; /* 应用层分配种子，模型不碰 */
  return { ok: true, card, notes };
}

/* ---------- 离线出题：自然语言 → 任务库关键词匹配 → 同一张卡 ---------- */
const cjkBigrams = (s) => {
  const out = new Set();
  for (const seg of s.match(/[\u4e00-\u9fa5]+/g) || [])
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.substr(i, 2));
  return out;
};
export function matchTaskOffline(nl, tasks) {
  const s = String(nl || "").toLowerCase();
  let best = null;
  for (const t of tasks) {
    let score = 0; const hit = [];
    for (const kw of t.keywords || []) if (s.includes(String(kw).toLowerCase())) { score += 2; hit.push(kw); }
    const gb = cjkBigrams(s), tb = cjkBigrams(t.nl || "");
    let overlap = 0; for (const g of gb) if (tb.has(g)) overlap++;
    score += overlap * 0.5;
    if (!best || score > best.score) best = { task: t, score: Math.round(score * 10) / 10, hit };
  }
  if (!best || best.score < 2) return null;
  return best;
}

/* ---------- 导演四算子：对场景卡的确定性改写 ---------- */
export const OP_NAMES = ["shift", "distract", "tighten", "slip"];
export function applyOps(spec0, ops, rng) {
  const spec = JSON.parse(JSON.stringify(spec0));
  const log = [];
  const flatTypes = new Set(["coaster", "pad"]);
  let distractorN = 0;
  for (const op of ops) {
    if (op === "shift") {
      const tp = spec.objects.find(o => o.id === spec.goal.target);
      for (const o of spec.objects) {
        if (o.id === spec.goal.dest || flatTypes.has(o.type)) continue;
        o.x = clamp(o.x + (rng() - 0.5) * 2.4, -(spec.table.w / 2 - 0.4), spec.table.w / 2 - 0.4);
        o.y = clamp(o.y + (rng() - 0.5) * 1.8, -(spec.table.h / 2 - 0.4), spec.table.h / 2 - 0.4);
      }
      /* 推开重叠（与 normalizeCard 同法，确定性） */
      for (let i = 0; i < spec.objects.length; i++)
        for (let j = i + 1; j < spec.objects.length; j++) {
          const a = spec.objects[i], b = spec.objects[j];
          const need = a.r + b.r + 0.35;
          let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
          if (d < 1e-6) { dx = 0.5; dy = 0; d = 0.5; }
          if (d < need) {
            const push = (need - d) / 2;
            a.x -= dx / d * push; a.y -= dy / d * push;
            b.x += dx / d * push; b.y += dy / d * push;
          }
        }
      if (tp) { tp.x = clamp(tp.x, -(spec.table.w / 2 - 0.4), spec.table.w / 2 - 0.4); tp.y = clamp(tp.y, -(spec.table.h / 2 - 0.4), spec.table.h / 2 - 0.4); }
      log.push("换位：非目的地物体整体扰动");
    } else if (op === "distract") {
      const tp = spec.objects.find(o => o.id === spec.goal.target);
      const dp = spec.objects.find(o => o.id === spec.goal.dest);
      const t0 = 0.25 + rng() * 0.5;
      spec.objects.push({
        id: "distractor_" + (++distractorN), type: "box", color: "brown",
        x: clamp(tp.x + (dp.x - tp.x) * t0, -(spec.table.w / 2 - 0.4), spec.table.w / 2 - 0.4),
        y: clamp(tp.y + (dp.y - tp.y) * t0, -(spec.table.h / 2 - 0.4), spec.table.h / 2 - 0.4),
        r: 0.42, fragile: false,
      });
      log.push("加干扰物：路径走廊中新增木箱");
    } else if (op === "tighten") {
      const old = spec.goal.tol;
      spec.goal.tol = Math.max(0.15, Math.round(spec.goal.tol * 0.6 * 1000) / 1000);
      log.push(`收紧容差：${old} → ${spec.goal.tol}`);
    } else if (op === "slip") {
      spec.slipLevel = Math.min(2, (spec.slipLevel || 0) + 1);
      log.push(`打滑：摩擦噪声升至 L${spec.slipLevel}`);
    }
  }
  /* 变体种子随算子集变化（换位/干扰物才有意义，但哈希统一进种子便于复现记账） */
  spec.seed = (fnv1a(spec0.seed + ":" + stableStringify(ops))) >>> 0;
  return { spec, log };
}

/* ---------- 确定性策略机器人 × 固定 tick 动力学 ---------- */
export const ROBOT_R = 0.45, DT = 1 / 60, MAX_FRAMES = 1500, IMPACT = 0.5;
const SLIP_AMP = [0, 0.1, 0.22];

/* 机器人起点：桌面左缘中部（cfg 的一部分，参与确定性） */
export function robotStart(table) { return { x: -(table.w / 2 - 0.7), z: 0 }; }

/* 线段到点距离（避障前扫用） */
function segDist(ax, az, bx, bz, px, pz) {
  const vx = bx - ax, vz = bz - az;
  const len2 = vx * vx + vz * vz;
  const t = len2 < 1e-9 ? 0 : clamp(((px - ax) * vx + (pz - az) * vz) / len2, 0, 1);
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

export function runSim(spec0, policy, seed) {
  const rng = mulberry32(seed);
  const spec = JSON.parse(JSON.stringify(spec0));
  const slipAmp = SLIP_AMP[clamp(spec.slipLevel || 0, 0, 2)];
  /* 场景卡用 2D 桌面坐标 {x,y}，模拟器内部统一为 {x,z}（渲染时 z 即世界 z） */
  const objs = spec.objects.map(o => ({ ...o, z: o.y, top: false, fell: false }));
  const target = objs.find(o => o.id === spec.goal.target);
  const dest = objs.find(o => o.id === spec.goal.dest);
  const flat = new Set(objs.filter(o => o.type === "coaster" || o.type === "pad").map(o => o.id));
  const st = robotStart(spec.table);
  const robot = { x: st.x, z: st.z, dir: 0 };
  const v = clamp(+policy.params?.v || 0.8, 0.2, 1.4);
  const detour = +policy.params?.detour || 0;
  const probe = +policy.params?.probe || 0;
  const margin = 0.1 + 0.35 * detour;

  const frames = [], hashes = [];
  let outcome = null; /* {status:'pass'|'fail', reason, frame} */
  const failEvent = (reason, frame) => { if (!outcome) outcome = { status: "fail", reason, frame }; };
  let detourCmt = null; /* 已提交的绕行计划 {id,x,z}——两段式：先摆动点后原目标；
                           到达摆动点即切回原目标且对该障碍停止重扫（否则贴着背入点抖振/折返） */

  for (let t = 0; t < MAX_FRAMES && !outcome; t++) {
    /* ---- 1. 决策（两段式推杆）：机器人不在目标「背后线」上时先驶向背入点
            （目标背对目的地一侧、贴着接触面），上了背后线才直指目的地顶推——
            防止从正面/侧面接触时接触法线背向目的地造成顶牛死锁 ---- */
    const ddx = dest.x - target.x, ddz = dest.z - target.z;
    const dd = Math.hypot(ddx, ddz) || 1e-9;
    const ux = ddx / dd, uz = ddz / dd;
    const reached = dist(target.x, target.z, dest.x, dest.z) <= spec.goal.tol;
    const trX = robot.x - target.x, trZ = robot.z - target.z;
    const trD = Math.hypot(trX, trZ) || 1e-9;
    const align = -(trX * ux + trZ * uz) / trD; /* 1=机器人恰在目标背后 */
    const onBackLine = !reached && align > 0.75 && trD < ROBOT_R + target.r + 0.35;
    let gx, gz;
    if (onBackLine) { gx = dest.x; gz = dest.z; }
    else {
      gx = target.x - ux * (ROBOT_R + target.r + 0.04); gz = target.z - uz * (ROBOT_R + target.r + 0.04);
      /* 近乎正对目标（align<-0.7）时给背入点加横向偏置破对称——否则顶牛会把目标越推越远 */
      if (align < -0.7) {
        const side0 = (trX * uz - trZ * ux) > 0 ? 1 : -1;
        gx += -uz * side0 * 0.8; gz += ux * side0 * 0.8;
      }
    }

    /* ---- 2. 避障前扫（仅接近段、仅非目标物）：去背入点的直连段被 blocking 物压住 →
            提交一个绕行计划（先摆动点、到达后切回原目标且对该障碍停止重扫直到其落到
            身后或拉距充分）——逐帧重扫会在摆动点到达后折返抖振，必须带滞回。 ---- */
    const segVX = gx - robot.x, segVZ = gz - robot.z;
    const segLen2 = segVX * segVX + segVZ * segVZ || 1e-9;
    /* 绕行承诺两阶段：swing（走向摆动点）→ clear（切回原目标、对该障碍停扫直到其身后/拉距） */
    if (detourCmt) {
      const ob = objs.find(o => o.id === detourCmt.id);
      const behind = ob ? ((ob.x - robot.x) * segVX + (ob.z - robot.z) * segVZ) / segLen2 < -0.02 : true;
      const clear = !ob || ob.fell || ob.top || dist(robot.x, robot.z, ob.x, ob.z) > ob.r + ROBOT_R + margin + 0.6;
      if (detourCmt.phase === "swing" && dist(robot.x, robot.z, detourCmt.x, detourCmt.z) < 0.3) detourCmt.phase = "clear";
      else if (detourCmt.phase === "clear" && (behind || clear)) detourCmt = null;
      else if (!ob) detourCmt = null;
    }
    const following = !!(detourCmt && detourCmt.phase === "swing");
    if (!following && detour > 0 && !onBackLine) {
        let worst = null, wd = Infinity;
        for (const o of objs) {
          if (flat.has(o.id) || o.fell || o.top || o.id === target.id) continue;
          if (detourCmt && o.id === detourCmt.id) continue; /* clear 阶段对已承诺障碍停扫 */
          const tp = ((o.x - robot.x) * segVX + (o.z - robot.z) * segVZ) / segLen2;
          if (tp < 0.05 || tp > 1.02) continue;
          const d = segDist(robot.x, robot.z, gx, gz, o.x, o.z);
          if (d < o.r + ROBOT_R + margin && d < wd) { worst = o; wd = d; }
        }
        if (worst) {
          const len = Math.sqrt(segLen2);
          const tproj = clamp(((worst.x - robot.x) * segVX + (worst.z - robot.z) * segVZ) / segLen2, 0, 1);
          const px = robot.x + segVX * tproj, pz = robot.z + segVZ * tproj;
          const off = worst.r + ROBOT_R + margin + 0.45;
          /* 两侧各算一个候选摆动点，取「机器人→摆动点连线对全部障碍保持净空」的那侧；
             两侧都通/都不通时取叉号侧（几何最短绕行侧）——确定性、不折返 */
          const mk = (sd) => ({
            x: clamp(px + (-segVZ / len) * sd * off, -(spec.table.w / 2 - 0.4), spec.table.w / 2 - 0.4),
            z: clamp(pz + (segVX / len) * sd * off, -(spec.table.h / 2 - 0.4), spec.table.h / 2 - 0.4),
          });
          const clearTo = (w) => {
            for (const o of objs) {
              if (flat.has(o.id) || o.fell || o.top || o.id === target.id) continue;
              if (segDist(robot.x, robot.z, w.x, w.z, o.x, o.z) < o.r + ROBOT_R + 0.05) return false;
            }
            return segDist(robot.x, robot.z, w.x, w.z, worst.x, worst.z) > worst.r + ROBOT_R + 0.05;
          };
          const crossSide = ((worst.x - robot.x) * segVZ - (worst.z - robot.z) * segVX) > 0 ? -1 : 1;
          const cA = mk(crossSide), cB = mk(-crossSide);
          const w = clearTo(cA) ? cA : (clearTo(cB) ? cB : cA);
          detourCmt = { id: worst.id, phase: "swing", x: w.x, z: w.z };
        }
    }
    const goalPt = following ? { x: detourCmt.x, z: detourCmt.z } : { x: gx, z: gz };

    /* ---- 3. 速度规划：probe 在近物时减速试探（冲击<碰倒阈值） ---- */
    let speed = v;
    if (probe > 0) {
      for (const o of objs) {
        if (flat.has(o.id) || o.id === target.id || o.fell || o.top) continue;
        if (dist(robot.x, robot.z, o.x, o.z) < ROBOT_R + o.r + 0.85) { speed = v * 0.5; break; }
      }
    }

    /* ---- 4. 运动：方向 + 打滑角噪声（PRNG 每帧恰一次消费，流序固定） ---- */
    let ang = Math.atan2(goalPt.z - robot.z, goalPt.x - robot.x);
    if (slipAmp > 0) ang += (rng() - 0.5) * 2 * slipAmp;
    robot.dir = ang;
    robot.x += Math.cos(ang) * speed * DT;
    robot.z += Math.sin(ang) * speed * DT;
    robot.x = clamp(robot.x, -(spec.table.w / 2 + 0.3), spec.table.w / 2 + 0.3);
    robot.z = clamp(robot.z, -(spec.table.h / 2 + 0.3), spec.table.h / 2 + 0.3);

    /* ---- 5. 接触解算：冲击超阈值碰倒 fragile；推杆沿接触法线滑移；箱子重推得慢 ---- */
    for (const o of objs) {
      if (flat.has(o.id) || o.fell) continue;
      const dx = o.x - robot.x, dz = o.z - robot.z;
      const d = Math.hypot(dx, dz) || 1e-9;
      const overlap = ROBOT_R + o.r - d;
      if (overlap <= 0) continue;
      const nx = dx / d, nz = dz / d;
      if (o.fragile && !o.top && speed > IMPACT) { o.top = true; failEvent(`碰倒${o.id}(fragile)@速度${speed.toFixed(2)}`, t); }
      /* 机器人钉在接触面后侧——推杆方向稳定且确定性；非目标的箱子按重物慢推 */
      const pushSpeed = (o.type === "box" && o.id !== target.id) ? speed * 0.55 : speed;
      o.x += nx * pushSpeed * DT; o.z += nz * pushSpeed * DT;
      /* 机器人钉在接触面后侧——推杆方向稳定且确定性 */
      robot.x = o.x - nx * (ROBOT_R + o.r);
      robot.z = o.z - nz * (ROBOT_R + o.r);
    }
    /* 物体-物体分离（被推物挤入邻物时双方各让一半） */
    for (let i = 0; i < objs.length; i++)
      for (let j = i + 1; j < objs.length; j++) {
        const a = objs[i], b = objs[j];
        if (flat.has(a.id) || flat.has(b.id) || a.fell || b.fell) continue;
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1e-9;
        const overlap = a.r + b.r - d;
        if (overlap > 0) {
          const hx = dx / d * overlap / 2, hz = dz / d * overlap / 2;
          a.x -= hx; a.z -= hz; b.x += hx; b.z += hz;
        }
      }
    /* 越界即掉桌 */
    for (const o of objs) {
      if (o.fell || flat.has(o.id)) continue;
      if (Math.abs(o.x) > spec.table.w / 2 + 0.1 || Math.abs(o.z) > spec.table.h / 2 + 0.1) { o.fell = true; failEvent(`${o.id}掉桌`, t); }
    }

    /* ---- 6. 判定与落账 ---- */
    if (!outcome && dist(target.x, target.z, dest.x, dest.z) <= spec.goal.tol) outcome = { status: "pass", reason: "到位", frame: t };
    const fr = {
      t, rx: q3(robot.x) / 1000, rz: q3(robot.z) / 1000, dir: q3(robot.dir * 100) / 100,
      objs: objs.map(o => [q3(o.x) / 1000, q3(o.z) / 1000, o.top ? 1 : 0, o.fell ? 1 : 0]),
    };
    fr.h = frameHash({ rx: fr.rx, rz: fr.rz, dir: fr.dir, objs: fr.objs.map(o => ({ x: o[0], z: o[1], top: o[2], fell: o[3] })) });
    frames.push(fr); hashes.push(fr.h);
    if (outcome && outcome.frame === t) break;
  }
  if (!outcome) outcome = { status: "fail", reason: "超时(25s 预算耗尽)", frame: frames.length - 1 };
  return { frames, hashes, outcome, total: frames.length };
}

/* ---------- 复演校验：同种子重跑，逐帧哈希比对「一手不差」 ---------- */
export function verifyReplay(run) {
  const t0 = Date.now();
  const again = runSim(run.spec, run.policy, run.seed);
  const total = Math.max(run.hashes.length, again.hashes.length);
  let match = 0, firstBad = -1;
  for (let i = 0; i < total; i++) {
    if (run.hashes[i] !== undefined && run.hashes[i] === again.hashes[i]
      && JSON.stringify(run.frames[i]?.objs) === JSON.stringify(again.frames[i]?.objs)) match++;
    else if (firstBad === -1) firstBad = i;
  }
  const framesIdentical = JSON.stringify(run.frames) === JSON.stringify(again.frames);
  return { ok: match === total && framesIdentical, match, total, firstBad, framesIdentical, ms: Date.now() - t0, replay: again };
}

/* ---------- 离线导演：算子表 × 预算 × 失败复测优先级 → 下一轮变体 ---------- */
export function deriveRoundOffline({ roundIdx, lastResults, budgetLeft, variantsCfg, task, memNudge }) {
  const pr = variantsCfg.priority || {};
  const pool = (lastResults && lastResults.some(r => r.outcome.status === "fail")) ? (pr.on_fail || OP_NAMES) : (pr.on_pass || OP_NAMES);
  /* 依优先级表选第一个还买得起的算子；记忆补测（memNudge）优先取其点名算子 */
  const order = memNudge ? [memNudge, ...pool] : pool;
  for (const name of order) {
    const op = (variantsCfg.ops || []).find(o => o.name === name);
    if (!op) continue;
    if (op.cost <= budgetLeft) return { ok: true, ops: [name], cost: op.cost, reason: (memNudge ? `记忆短板定向补测：` : "常规扰动：") + op.label + "——" + op.desc, label: op.label };
  }
  return { ok: false, reason: "预算不足（剩余 " + budgetLeft + " 分，最便宜算子也要 8 分）" };
}
/* 变体运行种子：任务种子 × 轮次（确定性，策略间同轮共享同一世界抖动流） */
export function runSeed(baseSeed, roundIdx) { return ((baseSeed >>> 0) + roundIdx * 7919) >>> 0; }

/* ---------- 评测汇总：一轮 3 策略的通过面 ---------- */
export function roundSummary(results) {
  const pass = results.filter(r => r.outcome.status === "pass").length;
  const worst = results.slice().sort((a, b) => (a.outcome.status === "pass") - (b.outcome.status === "pass"))[0];
  return { pass, total: results.length, worst: worst ? worst.policyId : null };
}
