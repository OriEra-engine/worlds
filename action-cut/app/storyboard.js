/* ============================================================
 * app/storyboard.js —— 确定性分镜卡渲染器（影视赛道核心机制）
 * 铁律：同 (spec × seed × refSeed × cast) → 同一布局 → 同一像素序列。
 *   · mulberry32(seed)      确定性随机源（渲染器内禁用 Math.random）
 *   · computeLayout(...)    纯函数：归一化布局（0~1 坐标），Node 可直接回归
 *   · paintShot(canvas,...) 浏览器绘制：按布局固定顺序落笔 → 像素可复现
 *   · hashCanvas(canvas)    FNV-1a 帧哈希：重放对账的凭证
 * 参考帧复用：refSeed 接管「构图变量」（天际线/人物站位/光源位），
 *   seed 只管「微变量」（雨点/噪点/抖动）——继承构图、换运气。
 * ============================================================ */

export const SHOT_VALUES = {
  "景别": ["大远景", "远景", "中景", "近景", "特写", "双人镜", "过肩镜"],
  "机位": ["平视", "低角度", "高角度", "顶俯", "斜角"],
  "运镜": ["固定", "推近", "拉远", "左摇", "右摇", "横移", "跟拍", "手持", "升起"],
  "天气": ["晴", "阴", "雨", "雾", "雪"],
  "时段": ["白天", "黄昏", "夜", "黎明"],
};
const FALLBACK = { "景别": "中景", "机位": "平视", "运镜": "固定", "天气": "晴", "时段": "夜" };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 规格归一（枚举校验 + 模糊归位 + 缺省兜底） ---------- */
function pickEnum(key, v) {
  if (typeof v === "string") {
    const s = v.trim();
    if (SHOT_VALUES[key].includes(s)) return s;
    const fuzz = SHOT_VALUES[key].find(o => s && (s.includes(o) || o.includes(s)));
    if (fuzz) return fuzz;
    const EN2ZH = {
      "景别": { "extreme wide": "大远景", "wide": "远景", "medium": "中景", "close": "近景", "extreme close": "特写", "two": "双人镜", "over": "过肩镜" },
      "机位": { "eye": "平视", "low": "低角度", "high": "高角度", "overhead": "顶俯", "dutch": "斜角" },
      "运镜": { "static": "固定", "push": "推近", "pull": "拉远", "pan-left": "左摇", "pan-right": "右摇", "track": "横移", "follow": "跟拍", "handheld": "手持", "crane": "升起" },
      "天气": { "clear": "晴", "overcast": "阴", "rain": "雨", "fog": "雾", "snow": "雪" },
      "时段": { "day": "白天", "dusk": "黄昏", "night": "夜", "dawn": "黎明" },
    };
    const lo = s.toLowerCase();
    for (const [en, zh] of Object.entries(EN2ZH[key])) if (lo.includes(en)) return zh;
  }
  return FALLBACK[key];
}
export function normSpec(spec) {
  const s = spec || {};
  return {
    "景别": pickEnum("景别", s["景别"]),
    "机位": pickEnum("机位", s["机位"]),
    "运镜": pickEnum("运镜", s["运镜"]),
    "画面": String(s["画面"] || "（画面待补）").slice(0, 60),
    "出场角色": Array.isArray(s["出场角色"]) ? s["出场角色"].map(n => String(n).slice(0, 8)).slice(0, 3) : [],
    "天气": pickEnum("天气", s["天气"]),
    "时段": pickEnum("时段", s["时段"]),
  };
}

/* ---------- 颜色工具（hex 插值，纯函数） ---------- */
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lerpHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
export function hex8(n) { return (n >>> 0).toString(16).padStart(8, "0"); }

/* 影调关键词 → 色彩倾向（确定性：纯字符串匹配，无随机） */
function styleTint(style) {
  const s = style || "";
  return {
    warm: /暖|金|琥珀|落日|烛|霓虹/.test(s),
    cold: /冷|蓝|青|钢|雪|月/.test(s),
    noir: /黑|noir|高对比|暗|低照/.test(s),
  };
}
const TIME_SKY = {
  "白天": ["#8fa8c8", "#cbb98e"], "黄昏": ["#4a3c66", "#d87a4a"],
  "夜": ["#070b16", "#1c2740"], "黎明": ["#2c3a63", "#d9a878"],
};

/* 景别 → 人物造型（归一化；base 允许 >1 = 出框裁切） */
const SHOT_FIG = {
  "大远景": { h: 0.08, headY: 0.55 },
  "远景": { h: 0.30, headY: 0.55 },
  "中景": { h: 0.75, headY: 0.44 },
  "近景": { h: 1.00, headY: 0.42 },
  "特写": { h: 1.60, headY: 0.45 },
  "双人镜": { h: 0.80, headY: 0.45 },
  "过肩镜": { h: 0.95, headY: 0.50 },
};
/* 景别 → 取景框内缩（安全框） */
const SHOT_INSET = {
  "大远景": 0.015, "远景": 0.03, "中景": 0.05, "近景": 0.09,
  "特写": 0.13, "双人镜": 0.05, "过肩镜": 0.04,
};

/* ============================================================
 * computeLayout —— 纯函数：归一化布局（0~1 坐标 / 颜色串 / 计数）
 *   comp = mulberry32(refSeed ?? seed)  构图随机源（参考帧复用的继承面）
 *   rnd  = mulberry32(seed ^ 0x9E3779B9) 微随机源（本卡的“抽卡运气”）
 * ============================================================ */
export function computeLayout(spec, seed, refSeed, cast) {
  const S = normSpec(spec);
  const castList = Array.isArray(cast) ? cast : [];
  const colorOf = name => {
    const c = castList.find(x => x.name === name);
    return c ? c.color : "#8a93ad";
  };
  const comp = mulberry32((refSeed == null ? seed : refSeed) >>> 0);
  const rnd = mulberry32(((seed >>> 0) ^ 0x9E3779B9) >>> 0);
  const tint = styleTint(spec && spec.__style);

  /* 天空与时段 */
  let [top, bot] = TIME_SKY[S["时段"]];
  if (tint.warm) { top = lerpHex(top, "#c88a4e", 0.18); bot = lerpHex(bot, "#e8b24e", 0.18); }
  if (tint.cold) { top = lerpHex(top, "#4a6a9e", 0.20); bot = lerpHex(bot, "#7ea8d8", 0.15); }
  if (tint.noir) { top = lerpHex(top, "#000000", 0.30); bot = lerpHex(bot, "#000000", 0.22); }
  if (S["天气"] === "阴") { top = lerpHex(top, "#3a3f4a", 0.45); bot = lerpHex(bot, "#4a505c", 0.35); }
  const overhead = S["机位"] === "顶俯";
  const horizonY = overhead ? 0 : (0.56 + comp() * 0.08);

  /* 光源（晴/黄昏可见；夜=月） */
  const luminary = (S["天气"] === "晴" || S["天气"] === "雪") ? {
    x: 0.15 + comp() * 0.70, y: 0.10 + comp() * 0.26,
    r: 0.040 + comp() * 0.028, moon: S["时段"] === "夜" || S["时段"] === "黎明",
  } : null;

  /* 星空（夜·非雨非阴） */
  const stars = [];
  if ((S["时段"] === "夜" || S["时段"] === "黎明") && S["天气"] !== "雨" && S["天气"] !== "阴" && !overhead)
    for (let i = 0, n = 26 + Math.floor(comp() * 34); i < n; i++)
      stars.push({ x: comp(), y: comp() * 0.5, r: 0.4 + comp() * 1.2, a: 0.25 + comp() * 0.65 });

  /* 天际线剪影（构图变量：参考帧继承） */
  const skyline = [];
  if (!overhead)
    for (let i = 0, n = 3 + Math.floor(comp() * 5); i < n; i++)
      skyline.push({ x: comp(), w: 0.06 + comp() * 0.16, h: 0.08 + comp() * 0.30, win: comp() < 0.5 });

  /* 雾带 */
  const fogBands = [];
  if (S["天气"] === "雾" || tint.noir)
    for (let i = 0, n = 3 + Math.floor(comp() * 3); i < n; i++)
      fogBands.push({ y: 0.45 + comp() * 0.5, a: 0.10 + comp() * 0.16 });

  /* 雨点（微变量：换 seed 即换雨） */
  const rain = [];
  if (S["天气"] === "雨")
    for (let i = 0, n = 70 + Math.floor(rnd() * 70); i < n; i++)
      rain.push({ x: rnd(), y: rnd(), len: 0.02 + rnd() * 0.05, a: 0.18 + rnd() * 0.5 });

  /* 雪点 */
  const snow = [];
  if (S["天气"] === "雪")
    for (let i = 0, n = 40 + Math.floor(rnd() * 60); i < n; i++)
      snow.push({ x: rnd(), y: rnd(), r: 0.6 + rnd() * 1.8, a: 0.25 + rnd() * 0.6 });

  /* 人物剪影（构图面：站位/朝向随 comp；微抖动随 rnd） */
  const names = S["出场角色"].slice();
  if (S["景别"] === "双人镜") { if (names.length === 0) names.push("（未具名）"); while (names.length < 2) names.push(names[0]); names.length = 2; }
  if (S["景别"] === "过肩镜") { if (names.length === 0) names.push("（未具名）"); while (names.length < 2) names.push(names[names.length - 1]); names.length = 2; }
  if (S["景别"] === "近景" || S["景别"] === "特写") names.length = Math.min(1, Math.max(1, names.length));
  const fig = SHOT_FIG[S["景别"]] || SHOT_FIG["中景"];
  const figures = names.map((name, i) => {
    const k = names.length;
    const spread = S["景别"] === "过肩镜" ? [0.26, 0.68] : null;
    const cx = spread ? spread[i] : (k === 1 ? 0.5 : 0.5 + (i - (k - 1) / 2) * (0.34 + comp() * 0.10));
    const h = fig.h * (0.94 + comp() * 0.12);
    const back = S["景别"] === "过肩镜" && i === 0;
    return {
      name, color: back ? "#0d1017" : colorOf(name), rim: back ? colorOf(name) : null,
      cx: Math.min(0.92, Math.max(0.08, cx)),
      h, headY: fig.headY, flip: comp() < 0.5,
      sway: (rnd() - 0.5) * 0.012, back,
    };
  });

  /* 取景框与运镜符号 */
  const inset = SHOT_INSET[S["景别"]] ?? 0.05;
  const bracket = {
    inset, round: overhead,
    dy: S["机位"] === "低角度" ? 0.06 : S["机位"] === "高角度" ? -0.06 : 0,
  };
  const arrow = S["运镜"];
  const jitter = S["运镜"] === "手持" ? (rnd() - 0.5) * 0.05 : S["机位"] === "斜角" ? (comp() < 0.5 ? -1 : 1) * 0.10 : 0;

  /* 胶片颗粒（微变量） */
  const grain = [];
  for (let i = 0; i < 150; i++) grain.push({ x: rnd(), y: rnd(), a: 0.03 + rnd() * 0.07 });

  return {
    spec: S, seedHex: hex8(seed), refHex: refSeed == null ? null : hex8(refSeed),
    sky: [top, bot], horizonY, luminary, stars, skyline, fogBands, rain, snow, figures,
    bracket, arrow, jitter, grain, overhead,
    vignette: 0.42 + comp() * 0.1,
  };
}

/* ============================================================
 * paintShot —— 浏览器侧：按布局固定顺序落笔（像素可复现的另一半）
 * canvas 尺寸任意（归一化布局 ×w/h），帧哈希须在固定尺寸下计算。
 * ============================================================ */
export function paintShot(canvas, spec, seed, refSeed, cast) {
  const L = computeLayout(spec, seed, refSeed, cast);
  paintLayout(canvas, L);
  return L;
}
export function paintLayout(canvas, L) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const X = v => v * w, Y = v => v * h;
  ctx.save();
  ctx.clearRect(0, 0, w, h);

  /* 手持/斜角：整框微旋转（jitter 在布局内确定） */
  if (L.jitter) {
    ctx.translate(w / 2, h / 2); ctx.rotate(L.jitter); ctx.translate(-w / 2, -h / 2);
  }

  /* 1. 天空 */
  const sky = ctx.createLinearGradient(0, 0, 0, Y(L.overhead ? 0.25 : L.horizonY || 1));
  sky.addColorStop(0, L.sky[0]); sky.addColorStop(1, L.sky[1]);
  ctx.fillStyle = sky; ctx.fillRect(-w * 0.2, -h * 0.2, w * 1.4, h * 1.4);

  /* 2. 星空 */
  for (const s of L.stars) {
    ctx.globalAlpha = s.a; ctx.fillStyle = "#dfe8ff";
    ctx.fillRect(X(s.x), Y(s.y), s.r, s.r);
  }
  ctx.globalAlpha = 1;

  /* 3. 光源（日/月） */
  if (L.luminary) {
    const g = ctx.createRadialGradient(X(L.luminary.x), Y(L.luminary.y), 0, X(L.luminary.x), Y(L.luminary.y), X(L.luminary.r * 4));
    g.addColorStop(0, "rgba(255,240,200,.9)"); g.addColorStop(1, "rgba(255,240,200,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = L.luminary.moon ? "#e8ecf5" : "#fff2c8";
    ctx.beginPath(); ctx.arc(X(L.luminary.x), Y(L.luminary.y), X(L.luminary.r), 0, 7); ctx.fill();
    if (L.luminary.moon) {  /* 月牙：叠一个天空色圆 */
      ctx.fillStyle = L.sky[0];
      ctx.beginPath(); ctx.arc(X(L.luminary.x + L.luminary.r * 0.4), Y(L.luminary.y - L.luminary.r * 0.2), X(L.luminary.r * 0.9), 0, 7); ctx.fill();
    }
  }

  /* 4. 天际线剪影 */
  const groundTop = L.overhead ? 0 : L.horizonY;
  for (const b of L.skyline) {
    ctx.fillStyle = "rgba(10,13,20,.85)";
    ctx.fillRect(X(b.x), Y(groundTop - b.h), X(b.w), Y(b.h));
    if (b.win) {  /* 窗灯 */
      ctx.fillStyle = "rgba(232,178,78,.55)";
      ctx.fillRect(X(b.x + b.w * 0.2), Y(groundTop - b.h + 0.03), X(b.w * 0.18), Y(0.02));
      ctx.fillRect(X(b.x + b.w * 0.6), Y(groundTop - b.h + 0.08), X(b.w * 0.18), Y(0.02));
    }
  }

  /* 5. 地面 */
  const gnd = ctx.createLinearGradient(0, Y(groundTop), 0, h);
  gnd.addColorStop(0, L.sky[1]); gnd.addColorStop(1, "#0a0d12");
  ctx.fillStyle = gnd;
  if (L.overhead) { ctx.fillRect(-w * 0.2, -h * 0.2, w * 1.4, h * 1.4); }
  else ctx.fillRect(0, Y(groundTop), w, h);
  if (L.overhead) {  /* 顶俯：地面网格（片场地贴） */
    ctx.strokeStyle = "rgba(232,178,78,.14)"; ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(X(i / 8), 0); ctx.lineTo(X(i / 8), h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, Y(i / 8)); ctx.lineTo(w, Y(i / 8)); ctx.stroke();
    }
  }

  /* 6. 人物剪影（头 + 收肩躯干，识别色填充） */
  for (const f of L.figures) {
    const fh = Y(f.h), fy = Y(f.headY) + (f.h > 1 ? Y(f.h) * 0.0 : 0);
    const cx = X(f.cx) + X(f.sway || 0);
    const base = fy + fh * 0.86;  /* headY 定头部，base 随高度下探（可出框） */
    ctx.save();
    if (f.flip) { ctx.translate(cx, 0); ctx.scale(-1, 1); ctx.translate(-cx, 0); }
    /* 头 */
    ctx.beginPath(); ctx.arc(cx, fy, fh * 0.13, 0, 7);
    ctx.fillStyle = f.color; ctx.globalAlpha = f.back ? 0.96 : 0.88; ctx.fill();
    /* 躯干（圆肩梯形） */
    ctx.beginPath();
    ctx.moveTo(cx - fh * 0.30, base);
    ctx.quadraticCurveTo(cx - fh * 0.34, fy + fh * 0.22, cx - fh * 0.20, fy + fh * 0.16);
    ctx.lineTo(cx + fh * 0.20, fy + fh * 0.16);
    ctx.quadraticCurveTo(cx + fh * 0.34, fy + fh * 0.22, cx + fh * 0.30, base);
    ctx.closePath(); ctx.fill();
    /* 背影角色的识别色描边（过肩镜前景暗影） */
    if (f.rim) { ctx.globalAlpha = 0.9; ctx.strokeStyle = f.rim; ctx.lineWidth = Math.max(1.5, fh * 0.02); ctx.stroke(); }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* 7. 雾带 */
  for (const b of L.fogBands) {
    ctx.fillStyle = "rgba(180,190,210," + b.a.toFixed(3) + ")";
    ctx.fillRect(0, Y(b.y), w, Y(0.05));
  }

  /* 8. 雨 */
  if (L.rain.length) {
    ctx.strokeStyle = "rgba(190,205,230,.55)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of L.rain) {
      ctx.moveTo(X(d.x), Y(d.y));
      ctx.lineTo(X(d.x) - X(d.len * 0.35), Y(d.y) + Y(d.len));
    }
    ctx.stroke();
  }

  /* 9. 雪 */
  for (const s of L.snow) {
    ctx.globalAlpha = s.a; ctx.fillStyle = "#eef3fa";
    ctx.beginPath(); ctx.arc(X(s.x), Y(s.y), s.r, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();  /* 结束 jitter 旋转（取景框/字幕不随框转） */

  /* 10. 取景框（安全框角标 + 三分线） */
  const bi = L.bracket.inset, dy = L.bracket.dy * h;
  const bx = X(bi), by = Y(bi) + dy, bw = X(1 - bi * 2), bh = Y(1 - bi * 2);
  ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 2;
  const cl = Math.min(bw, bh) * 0.14;
  if (L.bracket.round) {
    ctx.beginPath(); ctx.ellipse(bx + bw / 2, by + bh / 2, bw / 2, bh / 2, 0, 0, 7); ctx.stroke();
  } else {
    [[bx, by, 1, 1], [bx + bw, by, -1, 1], [bx, by + bh, 1, -1], [bx + bw, by + bh, -1, -1]].forEach(([x, y, sx, sy]) => {
      ctx.beginPath(); ctx.moveTo(x + sx * cl, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * cl); ctx.stroke();
    });
  }
  ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 1;
  if (!L.bracket.round) {
    for (const t of [1 / 3, 2 / 3]) {
      ctx.beginPath(); ctx.moveTo(X(t), by); ctx.lineTo(X(t), by + bh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx, Y(t) + dy); ctx.lineTo(bx + bw, Y(t) + dy); ctx.stroke();
    }
  }

  /* 11. 运镜符号（框边箭头 + 斜体标注） */
  const AX = "rgba(255,220,120,.9)";
  ctx.strokeStyle = AX; ctx.fillStyle = AX; ctx.lineWidth = 2.5;
  const cx0 = bx + bw / 2, cy0 = by + bh / 2;
  const arrowLine = (x1, y1, x2, y2) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const a = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 9 * Math.cos(a - 0.45), y2 - 9 * Math.sin(a - 0.45));
    ctx.lineTo(x2 - 9 * Math.cos(a + 0.45), y2 - 9 * Math.sin(a + 0.45));
    ctx.closePath(); ctx.fill();
  };
  const arrows = {
    "推近": [[bx - 14, cy0, bx + 4, cy0], [bx + bw + 14, cy0, bx + bw - 4, cy0], [cx0, by - 14, cx0, by + 4], [cx0, by + bh + 14, cx0, by + bh - 4]],
    "拉远": [[bx + 4, cy0, bx - 14, cy0], [bx + bw - 4, cy0, bx + bw + 14, cy0], [cx0, by + 4, cx0, by - 14], [cx0, by + bh - 4, cx0, by + bh + 14]],
    "左摇": [[bx + bw - 20, by - 12, bx + bw - 44, by - 12], [bx + bw - 20, by + bh + 12, bx + bw - 44, by + bh + 12]],
    "右摇": [[bx + 20, by - 12, bx + 44, by - 12], [bx + 20, by + bh + 12, bx + 44, by + bh + 12]],
    "横移": [[bx + 16, cy0 - 26, bx + 52, cy0 - 26], [bx + bw - 16, cy0 + 26, bx + bw - 52, cy0 + 26]],
    "跟拍": [[bx + 16, cy0, bx + 60, cy0], [bx + bw - 16, cy0, bx + bw - 60, cy0]],
    "升起": [[cx0, by + bh + 22, cx0, by + bh - 22]],
    "手持": [[bx - 12, by + 10, bx - 12, by + 44], [bx - 12, by + 26, bx - 26, by + 18], [bx - 12, by + 26, bx + 2, by + 18]],
  }[L.arrow];
  if (arrows) for (const [x1, y1, x2, y2] of arrows) arrowLine(x1, y1, x2, y2);

  /* 12. 胶片颗粒 */
  for (const g of L.grain) {
    ctx.globalAlpha = g.a; ctx.fillStyle = "#fff";
    ctx.fillRect(X(g.x), Y(g.y), 1, 1);
  }
  ctx.globalAlpha = 1;

  /* 13. 暗角 */
  const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85);
  vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0," + L.vignette.toFixed(3) + ")");
  ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);

  /* 14. 字幕条（镜号 · 景别/机位/运镜 · 画面 · seed） */
  const barH = Math.max(20, h * 0.115);
  ctx.fillStyle = "rgba(7,10,16,.78)"; ctx.fillRect(0, h - barH, w, barH);
  ctx.fillStyle = "#e8b24e"; ctx.font = "bold " + Math.max(10, h * 0.045) + "px 'Segoe UI','Microsoft YaHei',sans-serif";
  const cap = L.spec;
  ctx.fillText(`No.${String(L.idx ?? 0).padStart(2, "0")} ${cap["景别"]}·${cap["机位"]}·${cap["运镜"]}`, 8, h - barH * 0.36);
  ctx.fillStyle = "#b6bfd6"; ctx.font = Math.max(9, h * 0.038) + "px 'Segoe UI','Microsoft YaHei',sans-serif";
  const desc = cap["画面"].length > 26 ? cap["画面"].slice(0, 26) + "…" : cap["画面"];
  ctx.fillText(desc, 8, h - barH * 0.14 + 2);
  ctx.fillStyle = "#7c86a3"; ctx.textAlign = "right";
  ctx.fillText(`seed ${L.seedHex}${L.refHex ? " · ref " + L.refHex : ""}`, w - 8, h - barH * 0.14 + 2);
  ctx.textAlign = "left";

  /* 15. 片场板角标（导演轮次） */
  ctx.fillStyle = "rgba(232,178,78,.9)"; ctx.font = "bold " + Math.max(10, h * 0.05) + "px monospace";
  ctx.fillText("● REC", w - 74, 20);
  return L;
}

/* FNV-1a 帧哈希（对 RGBA 的 R 通道逐字节）——同会话像素复核凭证 */
export function hashCanvas(canvas) {
  const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i += 4) { h ^= d[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/* FNV-1a 布局摘要（对归一化布局 JSON 逐字符）——跨表面/跨时间的参数凭证：
 * 布局由 (spec×seed×refSeed×cast) 经 mulberry32 纯函数生成、字段序固定，
 * 摘要一致 ⇔ 拍摄参数与构图产物逐字段一致（不依赖任何画布光栅路径）。 */
export function hashLayout(L) {
  const s = JSON.stringify(L);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
