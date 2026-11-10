# OriEra Worlds · 潜元世界展厅

OriEra.ai 的发行仓(GitHub Pages):每部作品一个目录、一份 `MANIFEST.json`,入口页
`index.html` 由发布管线生成。

## 许可与来源(2026-11-10 起,「邀请制·许可先行」)

- **仓库管线代码**(`scripts/`):Apache-2.0(见根目录 LICENSE)。
- **各作品许可**:以其 `MANIFEST.json` 的 `license` 块为准——主体为
  CC BY-NC-SA 4.0(可学习二改、不可商用);外部贡献与例外逐作品标注
  (如 memory-atlas,Apache-2.0,作者 @airbate,待作者确认)。
- **来源溯源**:`origin` 块登记 kind/author/authorConfirmed;内嵌第三方组件
  (three.js 等)保留原许可,声明见各作品目录。
- **AI 生成内容**:作品目录不含静态 AI 生成资产;未来 `origin.kind=generated`
  的作品必须带 `aigc` 隐式标识(GB 45438-2025)方可通过门禁。
- 只收录自有或已获作者确认许可的内容,**不做自动搬运**。

## 发布管线

```bash
node scripts/build-manifests.mjs   # 幂等,可重复跑
```

- 数据单一真源:`scripts/works.json`(逐作品 title/description/license/origin)。
- 构建门禁(先全量校验、再写盘,任一不过即 `exit 1`):
  1. `license.spdx` 须为已知 SPDX 标识或 `LicenseRef-*`;
  2. `allowDerivative`/`allowCommercial`/`origin.authorConfirmed` 须为布尔,
     `origin.kind` ∈ original | invited | generated;
  3. `origin.kind=generated` 必须带 `aigc{provider,model,labeled:true}`;
  4. 单个 `*.ply` 泼溅资产 ≤ 5MB。
- 产物:逐作品 `MANIFEST.json`(含许可/来源)+ 发行页 `index.html`
  (原创/受邀/AI 生成计数与「可二改」标)。
- 门禁负向用例(缺 license 块 / 非法 SPDX / 超限 PLY)已于 2026-11-10 实测咬合。
