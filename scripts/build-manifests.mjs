// 发布管线:为 15 个作品生成 MANIFEST.json + 注入 meta description。
// 用法: node scripts/build-manifests.mjs   (仓库根运行;幂等,可重复跑)
// 数据源: scripts/works.json (slug→title/tagline/description/engineVersion,
//          与官网 data/worlds.json 同源维护;缺 slug 跳过并警告)。
// 关联: issue #2(维护评审遗留项 1、2)。
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const BUILT_AT = new Date().toISOString().slice(0, 10);
const SOURCE_COMMIT = process.env.ORIERA_SOURCE_COMMIT
  || execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim().slice(0, 12);
const GENERATOR = "scripts/build-manifests.mjs v1";

const meta = JSON.parse(readFileSync(join(ROOT, "scripts/works.json"), "utf8"));
const byslug = new Map(meta.map((m) => [m.slug, m]));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push({ path: p, bytes: st.size });
  }
  return out;
}

let ok = 0, skipped = 0;
for (const slug of readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name)) {
  const dir = join(ROOT, slug);
  const index = join(dir, "index.html");
  if (!existsSync(index)) continue;
  const m = byslug.get(slug);
  if (!m) { console.log(`SKIP ${slug}: 无 works.json 元数据`); skipped++; continue; }

  // 1) meta description 注入(幂等:已有则不重复)
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

  // 2) MANIFEST.json
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
    entry: "index.html",
    builtAt: BUILT_AT,
    sourceCommit: SOURCE_COMMIT,
    generator: GENERATOR,
    files: files.length,
    bytes,
  };
  if (snaps.length) {
    manifest.provenance = {
      designSnapshots: snaps.sort(),
      note: "设计源档,与 index.html 内联数据字节同步;运行时零加载,原地保留",
    };
  }
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`OK   ${slug}: ${files.length} files, ${(bytes / 1024).toFixed(0)} KB` + (snaps.length ? `, ${snaps.length} snapshots` : ""));
  ok++;
}
console.log(`\n${ok} manifests written, ${skipped} skipped`);
