/* ============================================================
 * app/pipeline.js —— 离线确定性管线（AIGC 赛道核心机制）
 * 铁律：同 (导演令 × 世界快照) → 同 seed → 同脚本 → 逐字节一致。
 *   · fnv1a / mulberry32   确定性哈希与随机源（本文件禁用 Math.random）
 *   · parseOrderOffline    关键词路由表：幕次×角色×动作 → 拍摄计划
 *   · offlinePlot/Shots/Lines  三生成器的离线模板通路（锚点插值）
 *   · normalizePlan        在线导演 JSON 的同一套校验/夹紧（与离线同构）
 *   · diffScript           回放 diff：beat/shots/lines/stateDeltas 逐字段
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
/* 键序稳定的序列化——世界哈希的输入（键序不同不算世界变了） */
export function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort()
      .map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
export function worldHash(snapshot) { return fnv1a(stableStringify(snapshot)); }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------- 预算分拨：三整数 ≥floor 且和=total ---------- */
export function clampBudget(v, min = 240, max = 2000) {
  v = Math.round(+v || 0);
  return clamp(v, min, max);
}
export function seededSplit(total, rng, floor = 80) {
  if (!Number.isFinite(total) || total < floor * 3) total = floor * 3;
  total = Math.round(total);
  const base = Math.floor(total / 3), rest = total - base * 3;
  let plot = base + (rest > 0 ? 1 : 0);
  let shots = base + (rest > 1 ? 1 : 0);
  let lines = base;
  /* ±40 步长 20 的确定性抖动，夹紧保 floor，差额全归 lines */
  const jit = () => (Math.floor(rng() * 5) - 2) * 20;
  plot = clamp(plot + jit(), floor, total - floor * 2);
  shots = clamp(shots + jit(), floor, total - plot - floor);
  lines = total - plot - shots;
  return { plot, shots, lines };
}
/* 在线导演给出的 split → 同一套夹紧（防幻觉越界，端点外的约束在应用层兜底） */
export function clampSplit(s, total, floor = 80) {
  if (!Number.isFinite(total) || total < floor * 3) total = floor * 3;
  const int = v => clamp(Math.round(+v || 0), floor, total - floor * 2);
  let plot = int(s && s.plot), shots = int(s && s.shots);
  let lines = total - plot - shots;
  if (lines < floor) { const d = floor - lines; lines = floor; shots -= d; }
  if (shots < floor) { const d = floor - shots; shots = floor; plot -= d; }
  if (plot < floor) { const d = floor - plot; plot = floor; shots -= d; if (shots < floor) { lines -= floor - shots; shots = floor; } }
  return { plot, shots, lines };
}

/* ---------- 离线导演：关键词路由表（幕次×角色×动作） ---------- */
export const ACTIONS = {
  黑化: { re: /黑化|入魔|堕落|走向黑暗|变坏/, state: "黑化" },
  觉醒: { re: /觉醒|顿悟|醒悟|看清|明白/, state: "觉醒" },
  决裂: { re: /决裂|反目|翻脸|决/, state: "决裂" },
  和解: { re: /和解|原谅|和好|言和/, state: "和解" },
  告别: { re: /告别|离别|送别|远行|离开/, state: "远行" },
  重逢: { re: /重逢|再会|相见|回来|现身/, state: "重逢" },
};
const ACT_RE = /第\s*([一二三123])\s*幕/;
const CN_NUM = { "一": 1, "二": 2, "三": 3, "1": 1, "2": 2, "3": 3 };
const normOrder = s => String(s || "").trim().replace(/\s+/g, "");

/* anchors: [{name, role, 性格, 服装, 标志物, 口癖, 当前状态}]（顺序=story.characters） */
export function parseOrderOffline(order, anchors, worldAct, budget, floor, wHash) {
  const n = normOrder(order);
  const cmdHash = fnv1a(n);
  const seed = (cmdHash ^ (wHash >>> 0)) >>> 0;
  const rng = mulberry32(seed);
  const am = n.match(ACT_RE);
  const act = clamp(am ? (CN_NUM[am[1]] || worldAct || 1) : (worldAct || 1), 1, 3);
  const targets = anchors.filter(a => n.includes(a.name));
  let action = null;
  for (const [k, v] of Object.entries(ACTIONS)) if (v.re.test(n)) { action = k; break; }
  const stateDeltas = (action && targets.length)
    ? targets.map(t => ({ character: t.name, key: "当前状态", value: ACTIONS[action].state }))
    : [];
  const split = seededSplit(clampBudget(budget), rng, floor);
  return {
    ok: targets.length > 0,
    reason: targets.length ? "" : "未识别到角色名——令中请点名雁回城的角色（林见鹿/沈听澜/苏鸢）",
    act, targets: targets.map(t => t.name), action: action || "推进",
    stateDeltas, split, seed, cmdHash,
    note: `离线路由：第${act}幕 × ${action || "推进"} × ${targets.map(t => t.name).join("、") || "—"}`,
    source: "offline-router",
  };
}

/* ---------- 在线导演 JSON → 与离线同构的拍摄计划 ---------- */
export function normalizePlan(j, anchors, worldAct, budget, floor) {
  if (!j || typeof j !== "object") return { ok: false, reason: "导演输出不是 JSON 对象" };
  const names = anchors.map(a => a.name);
  const chars = (Array.isArray(j.characters) ? j.characters : [])
    .map(x => String(x || "").trim()).filter(x => names.includes(x));
  if (!chars.length) return { ok: false, reason: "拍摄计划未点名名单内角色" };
  const act = clamp(Math.round(+j.act) || worldAct || 1, 1, 3);
  const seen = new Set();
  const stateDeltas = (Array.isArray(j.stateDeltas) ? j.stateDeltas : [])
    .map(d => ({ character: String(d && d.character || "").trim(), key: "当前状态", value: String(d && d.value || "").trim().slice(0, 8) }))
    .filter(d => chars.includes(d.character) && d.value && !seen.has(d.character + d.value) && seen.add(d.character + d.value));
  return {
    ok: true, reason: "", act, targets: chars, action: "AI 解析",
    stateDeltas, split: clampSplit(j.split, clampBudget(budget), floor),
    note: String(j.note || "").slice(0, 60) || "（导演未附拍摄意图）",
    source: "ai-director",
  };
}

/* ---------- 三生成器·离线模板通路（锚点插值，rng 驱动） ---------- */
const SCENES = ["灯楼底下", "长街尽头", "城门洞里", "茶馆檐下"];
const SIZES = ["大远景", "远景", "中景", "近景", "特写", "双人镜", "过肩镜"];
const MOVES = ["固定", "推近", "拉远", "左摇", "右摇", "横移", "跟拍", "手持", "升起"];
const TWIST = { "灯还亮着": "灯就该灭", "刀不说谎": "刀只认血", "这一段值三贯钱": "这一段分文不值" };
const twist = k => TWIST[k] || ("再不信「" + k + "」了");
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length) % arr.length];

/* 剧情卡：开场 × 中段（按动作） × 收尾，锚点必须落进文字 */
const PLOT_OPEN = [
  (c, sc) => `${c.name}立在${sc}，${c.服装}上落了层未扫的雪。`,
  (c, sc) => `${sc}的风把灯影压得很低，${c.name}按着${c.标志物}没有动。`,
];
const PLOT_MID = {
  黑化: [
    (c) => `他还是「${c.当前状态}」的人，可这一幕拍的正是他不再是的瞬间——「${c.口癖}」说出口，尾音先冷了下去。`,
    (c) => `从「${c.当前状态}」往黑化走的那半步，他走得没有一点犹豫。${c.标志物}的影子钉在墙上，像另一个他。`,
  ],
  告别: [
    (c) => `他把要留的话折进怀里，只说了句「${c.口癖}」——告别这件事，${c.name}做得比谁都干净。`,
    (c) => `从「${c.当前状态}」到转身出城，隔着的不过是半条雪街，${c.服装}的背影一寸寸小下去。`,
  ],
  重逢: [
    (c, sc, b) => `雪街两端两人同时停步。三年不见，${c.name}先认出的是对方背上的${b ? b.标志物 : "旧影"}——重逢的开场白，笨拙得可信。`,
    (c) => `「${c.口癖}」——重逢的第一句话，从「${c.当前状态}」的旧日子那头递了过来。`,
  ],
  觉醒: [
    (c) => `「${c.口癖}」这句话他念了半辈子，这一刻才第一次听懂。${c.name}怔在原地，像被人从雪里捞起来。`,
    (c) => `顿悟来得没有预兆。他忽然明白「${c.当前状态}」守的不是规矩，是没人敢先放下。`,
  ],
  决裂: [
    (c) => `「${c.口癖}。」他说完这句就把话说完了。决裂不用第二句，${c.标志物}横在两人中间就是界碑。`,
    (c) => `从「${c.当前状态}」到翻脸，只用了一个名字的工夫。雪落在${c.标志物}上，再没人去拂。`,
  ],
  和解: [
    (c) => `道歉只有三个字，说完他松了半口气。「${c.口癖}」这回说得比哪一次都软。`,
    (c) => `和解不是原谅，是把「${c.当前状态}」那一页翻过去。两人隔着${c.标志物}碰了一下拳。`,
  ],
  推进: [
    (c) => `这一幕按部就班地走：${c.name}守着${c.标志物}，把「${c.口癖}」又说了一遍，像给整场戏定了调。`,
    (c, sc) => `戏往前挪了一格。「${c.当前状态}」的${c.name}在${sc}站定，等下一条导演令来改写他。`,
  ],
};
const PLOT_TAIL = [
  (c) => `镜头收在${c.标志物}上，剩下的话留给分镜与台词。`,
  (c) => `风雪未停，${c.标志物}仍在画面里——下一条导演令决定${c.name}往哪走。`,
];
export function offlinePlot({ t1, t2, action, act, beatTitle }, rng) {
  const sc = pick(SCENES, rng);
  const mid = pick(PLOT_MID[action] || PLOT_MID["推进"], rng)(t1, sc, t2);
  return `【第${act}幕·${beatTitle}】${pick(PLOT_OPEN, rng)(t1, sc)}${mid}${pick(PLOT_TAIL, rng)(t1)}`;
}

/* 分镜表：3~5 格，景别/运镜不连格重复，画面必带锚点 */
const SHOT_VISUAL = {
  黑化: [
    (c) => `${c.name}瞳孔里${c.标志物}的倒影熄了一半`,
    (c, sc) => `低角度：${c.name}立在${sc}，${c.服装}被风压向黑暗一侧`,
    (c) => `越过${c.name}的肩，灯楼在画面里第一次显得很远`,
  ],
  告别: [
    (c) => `${c.name}独自走向城门，${c.服装}缩成一个点`,
    (c) => `${c.标志物}被搁在界石上，落雪半掩`,
  ],
  重逢: [
    (c, sc, b) => `雪街两端${c.name}与${b ? b.name : "来人"}同时停步`,
    (c) => `两件旧物在画面中央相认——${c.标志物}与来人的影`,
  ],
  觉醒: [
    (c) => `${c.name}的脸从阴影里亮起来，眼神换了个人`,
    (c, sc) => `${sc}上方灯焰忽然立直，像被谁看穿`,
  ],
  决裂: [
    (c) => `${c.标志物}横在两人中间，界碑一样`,
    (c) => `${c.name}收手入袖，指节白了`,
  ],
  和解: [
    (c) => `两只手隔着${c.标志物}握在一起，雪落无声`,
    (c) => `${c.name}眉间旧结松开半分`,
  ],
  推进: [
    (c, sc) => `${sc}全景，灯焰与落雪对峙`,
    (c) => `${c.name}沿长街走完这一幕的路，${c.标志物}随步轻晃`,
  ],
};
export function offlineShots({ t1, t2, action, act }, rng) {
  const pool = SHOT_VISUAL[action] || SHOT_VISUAL["推进"];
  const n = 3 + Math.floor(rng() * 3);
  let prevS = -1, prevM = -1; const shots = [];
  for (let i = 0; i < n; i++) {
    let si = Math.floor(rng() * SIZES.length);
    if (si === prevS) si = (si + 1) % SIZES.length;      /* 景别不连格重复 */
    let mi = Math.floor(rng() * MOVES.length);
    if (mi === prevM) mi = (mi + 1) % MOVES.length;      /* 运镜不连格重复 */
    prevS = si; prevM = mi;
    shots.push({
      id: i + 1, size: SIZES[si], move: MOVES[mi],
      visual: pool[(i + Math.floor(rng() * pool.length)) % pool.length](t1, pick(SCENES, rng), t2),
    });
  }
  return shots;
}

/* 台词表：旁白开场（半数）＋主角 1~2 句＋副角 1 句，口癖/状态变味 */
const LINE_MAIN = {
  黑化: [(c) => `「${twist(c.口癖)}。」`, (c) => `「${c.当前状态}？那已经是上一幕的事了。」`],
  告别: [(c) => `「${c.口癖}。灯替我看着城。」`, (c) => `「不必送，雪会盖掉脚印。」`],
  重逢: [(c) => `「三年了。${c.口癖}——这话我替你留着。」`, (c) => `「先别提旧案，让我看看灯还亮不亮。」`],
  觉醒: [(c) => `「原来${c.口癖}，说的不是灯，是人。」`, (c) => `「我守错了东西，但还来得及改。」`],
  决裂: [(c) => `「${c.口癖}。从今往后，两清。」`, (c) => `「刀不出鞘，也划得清界线。」`],
  和解: [(c) => `「旧账翻篇。${c.口癖}，这话还作数。」`, (c) => `「灯还亮着——就还来得及。」`],
  推进: [(c) => `「${c.口癖}。今晚也一样。」`, (c) => `「雪还要下，戏还要拍。」`],
};
const LINE_SUB = {
  重逢: (b) => `「${b.口癖}——三年，就等这一句开场。」`,
  决裂: (b) => `「那就别怪${b.标志物}先开口。」`,
  和解: (b) => `「这拳我接了。${b.口癖}。」`,
  推进: (b) => `「（把这一幕记下）${b.口癖}。」`,
};
export function offlineLines({ t1, t2, action, act, beatTitle }, rng) {
  const lines = [];
  if (rng() < 0.5) lines.push({ speaker: "旁白", text: `第${act}幕，${beatTitle}。这一令，改的是${t1.name}。` });
  const pool = LINE_MAIN[action] || LINE_MAIN["推进"];
  const li = Math.floor(rng() * pool.length);
  lines.push({ speaker: t1.name, text: pool[li](t1) });
  if (t2 && LINE_SUB[action]) lines.push({ speaker: t2.name, text: LINE_SUB[action](t2) });
  else if (rng() < 0.4) lines.push({ speaker: t1.name, text: pool[(li + 1) % pool.length](t1) });
  return lines;
}

/* ---------- 回放 diff：diffFields[beat, shots, lines, stateDeltas] ---------- */
export function diffScript(a, b) {
  const J = x => JSON.stringify(x);
  const fields = ["beat", "shots", "lines", "stateDeltas"].map(f => ({
    field: f, same: J(a && a[f]) === J(b && b[f]),
  }));
  const items = (arr, other) => (arr || []).map((s, i) => ({ i, same: J(s) === J((other || [])[i]) }));
  return {
    fields,
    shots: items(a && a.shots, b && b.shots),
    lines: items(a && a.lines, b && b.lines),
    identical: fields.every(f => f.same),
  };
}

/* ---------- 离线整令一键通路（在线失败时的逐生成器兜底也走这里） ---------- */
export function runOffline({ order, anchors, worldAct, beatTitle, budget, floor, wHash }) {
  const plan = parseOrderOffline(order, anchors, worldAct, budget, floor, wHash);
  if (!plan.ok) return plan;
  const s = plan.seed;
  const t1 = anchors.find(a => a.name === plan.targets[0]);
  const t2 = anchors.find(a => a.name === plan.targets[1]) || null;
  const args = { t1, t2, action: plan.action, act: plan.act, beatTitle, split: plan.split };
  const script = {
    beat: offlinePlot(args, mulberry32(s ^ 0x9e3779b9)),
    shots: offlineShots(args, mulberry32(s ^ 0x85ebca6b)),
    lines: offlineLines(args, mulberry32(s ^ 0xc2b2ae35)),
    stateDeltas: plan.stateDeltas,
  };
  const ledger = [["plot", "织文·剧情"], ["shots", "格画·分镜"], ["lines", "声线·台词"]]
    .map(([k, label]) => ({ gen: k, label, allocated: plan.split[k], used: plan.split[k], degraded: false }));
  return { ok: true, plan, script, ledger, mode: "offline", seed: s };
}
