// 发布管线 v2:为作品生成 MANIFEST.json + 注入 meta description + 生成发行页。
// 用法: node scripts/build-manifests.mjs   (仓库根运行;幂等,可重复跑)
// 数据源: scripts/works.json (slug→title/tagline/description/engineVersion
//          + v2 新增 license/origin/aigc,与 MANIFEST 单一真源)。
// v2 新增(PLAN-splat §五 / 2026-11-10 拍板「邀请制·许可先行」):
//   1. 许可硬门禁:license.spdx 必须是已知 SPDX 或 LicenseRef-*,缺失/非法 → 构建失败(exit 1);
//   2. origin 溯源:kind ∈ original|invited|generated,generated 必须带 aigc 隐式标识(GB 45438-2025);
//   3. 单个 *.ply ≤ 5MB 门禁(泼溅资产体积上界);
//   4. 生成发行页 index.html:原创/受邀计数 + 逐作品许可与「可二改」标。
// 关联: engine PR #189 评审(发行平台负责人/生态战略官角色意见)。
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const BUILT_AT = new Date().toISOString().slice(0, 10);
const SOURCE_COMMIT = process.env.ORIERA_SOURCE_COMMIT
  || execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim().slice(0, 12);
const GENERATOR = "scripts/build-manifests.mjs v2";
const MAX_PLY_MB = 5;

const SPDX_KNOWN = new Set([
  "MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "CC0-1.0",
  "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-ND-4.0",
]);
const isSpdx = (s) => SPDX_KNOWN.has(s) || /^LicenseRef-[A-Za-z0-9.-]+$/.test(s);
const KINDS = new Set(["original", "invited", "generated"]);
const KIND_ZH = { original: "原创", invited: "受邀", generated: "AI 生成" };

const meta = JSON.parse(readFileSync(join(ROOT, "scripts/works.json"), "utf8"));
const byslug = new Map(meta.map((m) => [m.slug, m]));

// ---------- 门禁:先全量校验,再动笔写(不产生半成品) ----------
const errors = [];
for (const m of meta) {
  const L = m.license, O = m.origin;
  if (!L || typeof L !== "object") { errors.push(`${m.slug}: 缺 license 块`); }
  else {
    if (!isSpdx(L.spdx)) errors.push(`${m.slug}: license.spdx 非法(${L.spdx});须为已知 SPDX 或 LicenseRef-*`);
    if (typeof L.allowDerivative !== "boolean") errors.push(`${m.slug}: license.allowDerivative 须为布尔`);
    if (typeof L.allowCommercial !== "boolean") errors.push(`${m.slug}: license.allowCommercial 须为布尔`);
  }
  if (!O || typeof O !== "object") { errors.push(`${m.slug}: 缺 origin 块`); }
  else {
    if (!KINDS.has(O.kind)) errors.push(`${m.slug}: origin.kind 非法(${O.kind});须 original|invited|generated`);
    if (!O.author || typeof O.author !== "string") errors.push(`${m.slug}: origin.author 缺失`);
    if (typeof O.authorConfirmed !== "boolean") errors.push(`${m.slug}: origin.authorConfirmed 须为布尔`);
    if (O.kind === "generated") {
      const A = m.aigc;
      if (!A || typeof A !== "object" || !A.provider || !A.model || A.labeled !== true) {
        errors.push(`${m.slug}: origin.kind=generated 必须带 aigc{provider,model,labeled:true}(GB 45438-2025)`);
      }
    }
  }
}
if (errors.length) {
  console.error(`许可/来源门禁未通过(${errors.length} 处):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push({ path: p, bytes: st.size });
  }
  return out;
}

const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const plyHits = [];
let ok = 0, skipped = 0;
for (const slug of readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name)) {
  const dir = join(ROOT, slug);
  const index = join(dir, "index.html");
  if (!existsSync(index)) continue;
  const m = byslug.get(slug);
  if (!m) { console.log(`SKIP ${slug}: 无 works.json 元数据`); skipped++; continue; }

  // 1) 泼溅资产体积门禁(PLAN-splat §五:单 PLY ≤ 5MB)
  for (const f of walk(dir)) {
    if (f.path.endsWith(".ply") && f.bytes > MAX_PLY_MB * 1024 * 1024) {
      plyHits.push(`${slug}/${f.path.split(/[\\/]/).pop()}: ${(f.bytes / 1048576).toFixed(1)}MB 超过 ${MAX_PLY_MB}MB 上限`);
    }
  }

  // 2) meta description 注入(幂等:已有则不重复)
  let html = readFileSync(index, "utf8");
  if (!/<meta\s+name=["']description["']/i.test(html)) {
    const desc = m.description.zh.replaceAll('"', "&quot;");
    const tag = `<meta name="description" content="${desc}" />`;
    if (/<title>[^<]*<\/title>/.test(html)) {
      html = html.replace(/(<title>[^<]*<\/title>)/, `$1\n    ${tag}`);
    } else {
      html = html.replace(/<head>/i, `<head>\n    ${tag}`);
    }
    writeFileSync(index, html);
  }

  // 3) MANIFEST.json(许可/来源为 v2 必填字段)
  const files = walk(dir);
  const bytes = files.reduce((a, f) => a + f.bytes, 0);
  // 设计源档(非 MANIFEST 的 *.json):与 index.html 内联数据字节同步的
  // 设计记录,运行时零加载(2026-10-29 维护评审逐文件实测)——按评审
  // issue #2 项 3 的拍板原地保留,在 provenance 里登记,不做运行时体量。
  const snaps = readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "MANIFEST.json");
  const manifest = {
    slug,
    title: m.title,
    tagline: m.tagline,
    engineVersion: m.engineVersion,
    license: { spdx: m.license.spdx, allowDerivative: m.license.allowDerivative, allowCommercial: m.license.allowCommercial },
    origin: { kind: m.origin.kind, author: m.origin.author, authorConfirmed: m.origin.authorConfirmed },
    entry: "index.html",
    builtAt: BUILT_AT,
    sourceCommit: SOURCE_COMMIT,
    generator: GENERATOR,
    files: files.length,
    bytes,
  };
  if (m.license.note) manifest.license.note = m.license.note;
  if (m.origin.note) manifest.origin.note = m.origin.note;
  if (m.aigc) manifest.aigc = { provider: m.aigc.provider, model: m.aigc.model, labeled: true };
  if (snaps.length) {
    manifest.provenance = {
      designSnapshots: snaps.sort(),
      note: "设计源档,与 index.html 内联数据字节同步;运行时零加载,原地保留",
    };
  }
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`OK   ${slug}: ${files.length} files, ${(bytes / 1024).toFixed(0)} KB, ${m.license.spdx}` + (snaps.length ? `, ${snaps.length} snapshots` : ""));
  ok++;
}
if (plyHits.length) {
  console.error(`\n泼溅资产体积门禁未通过(${plyHits.length} 处):`);
  for (const e of plyHits) console.error(`  - ${e}`);
  process.exit(1);
}

// ---------- 发行页 index.html(原创/受邀计数 + 许可标) ----------
const counts = { original: 0, invited: 0, generated: 0, derivative: 0 };
for (const m of meta) {
  counts[m.origin.kind]++;
  if (m.license.allowDerivative) counts.derivative++;
}
const cards = meta.map((m) => {
  const kind = KIND_ZH[m.origin.kind];
  const badges = [
    `<span class="lic" title="许可以该作品 MANIFEST.json 为准">${esc(m.license.spdx)}</span>`,
    m.license.allowDerivative ? `<span class="ok">可二改</span>` : `<span class="no">不可二改</span>`,
    m.license.allowCommercial ? `<span class="ok">可商用</span>` : `<span class="no">非商用</span>`,
    `<span class="kind">${kind}</span>`,
  ].join("\n      ");
  const conf = m.origin.authorConfirmed ? "" : `<span class="warn" title="作者尚未明确确认许可归属,以仓库许可与 DCO 为准">·待作者确认</span>`;
  return `    <a class="card" href="./${esc(m.slug)}/">
      <span class="t">${esc(m.title.zh)}<i>${esc(m.title.en)}</i></span>
      <span class="s">${esc(m.tagline.zh)}</span>
      <span class="b">${badges}</span>
      <span class="a">by ${esc(m.origin.author)}${conf}</span>
    </a>`;
}).join("\n");

const hub = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OriEra Worlds · 潜元世界展厅</title>
  <meta name="description" content="OriEra AI 原生世界展厅:${meta.length} 部作品,逐作品许可与来源可审计。" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #070b16; color: #e8eefc; font: 16px/1.6 system-ui, "Microsoft YaHei", sans-serif; }
    main { max-width: 1080px; margin: 0 auto; padding: 48px 24px 64px; }
    h1 { margin: 0; font-size: 28px; letter-spacing: .04em; }
    h1 b { color: #3ee6ff; font-weight: 600; }
    .sub { color: #9db0d0; margin: 8px 0 4px; }
    .count { color: #ffc861; margin-bottom: 28px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
    .card { display: flex; flex-direction: column; gap: 8px; padding: 18px; border: 1px solid #1d2a45; border-radius: 14px;
            background: #0b1222; color: inherit; text-decoration: none; transition: border-color .15s; }
    .card:hover { border-color: #3ee6ff; }
    .card .t { font-weight: 600; }
    .card .t i { display: block; font-style: normal; font-weight: 400; font-size: 12px; color: #9db0d0; }
    .card .s { font-size: 13px; color: #b9c7e2; }
    .card .b { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
    .card .b span { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #2a3a5f; color: #9db0d0; }
    .card .b .lic { color: #3ee6ff; border-color: #17435a; }
    .card .b .ok { color: #7dde9b; border-color: #1d4a33; }
    .card .b .no { color: #ff6b2b; border-color: #5a2a17; }
    .card .b .warn { color: #ffc861; }
    .card .a { font-size: 12px; color: #9db0d0; }
    footer { margin-top: 36px; font-size: 12px; color: #6f83a8; }
    footer code { color: #9db0d0; }
  </style>
</head>
<body>
  <main>
    <h1>OriEra <b>Worlds</b></h1>
    <p class="sub">AI 原生世界展厅 · 每一部都由自然语言驱动,逐作品许可与来源可审计(见各作品 MANIFEST.json)。</p>
    <p class="count">原创 ${counts.original} · 受邀 ${counts.invited} · AI 生成 ${counts.generated} · 其中可二改 ${counts.derivative}</p>
    <div class="grid">
${cards}
    </div>
    <footer>仓库管线代码 Apache-2.0;各作品许可以其 MANIFEST.json 为准,内嵌第三方组件保留原许可。
      由 <code>${GENERATOR}</code> 生成 · source <code>${SOURCE_COMMIT}</code> · ${BUILT_AT}</footer>
  </main>
</body>
</html>
`;
writeFileSync(join(ROOT, "index.html"), hub);

console.log(`\n${ok} manifests written, ${skipped} skipped`);
console.log(`发行页 index.html 已生成:原创 ${counts.original} · 受邀 ${counts.invited} · AI 生成 ${counts.generated} · 可二改 ${counts.derivative}`);
