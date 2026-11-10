# 花材与材料清单（角色 / 真实课程 / 游戏内资产）

- 整理日期：2026-11-05；资产一节于 2026-11-07 按 V9（30 种花型全部为 Lux3D 模型）重写，2026-11-10 按 V16 §2 补入绣球 / 蝴蝶兰两种真实模型（32 花型 / 57 配色）。
- 用途：给「选花 → 逐枝搭配 → 包装 → 成品」一个真实的材料角色框架，并对照当前游戏内到底有哪些资产、还缺什么。
- 证据：网页抓取文本与视频抽帧在 `experiments/local/research/`（本地，不入 Git）。

## 1. 真实花束里的材料角色

真实花艺把花材按**视觉功能**分三层（不是按植物学分类）：

| 角色 | 作用 | 真实例子 | 游戏内对应 |
| --- | --- | --- | --- |
| 主花 / 焦点花（focal） | 定高度、定视觉中心，通常 3–5 枝 | 玫瑰、牡丹、百合、郁金香 | 10 种真实模型（`kind: main`） |
| 副花 / 次要花（secondary） | 在主花之间补色、补质感 | 小菊、须苞石竹、洋桔梗、金鱼草 | 10 种真实模型（`kind: filler`） |
| 叶材 / 填充（greenery + filler） | 补空隙、把花头托起来、增加空气感 | 尤加利、沙柳尖、熊草、软叶蕨 | 10 种真实模型（`kind: greenery`） |
| 包装纸 | 后高前低、包住花茎、收口 | 牛皮纸、雪梨纸、雾面纸 | 暖白 / 牛皮 / 灰绿三种程序化纸 |
| 丝带 | 系在收口处、固定纸、礼品感 | 缎带、麻绳 | 玫瑰 / 奶油 / 灰绿三种 |
| 卡片 | 礼品留言 | 名片卡、吊牌 | 3D 卡片（收件人/正文/署名） |
| 工具 / 辅料 | 剪刀、麻绳、锚点胶带、绑线 | 花艺剪、12mm 锚点胶带、麻绳 | 未实现（无工具交互） |

角色依据：Fairfax 讲义明确「large flowers as focal, smaller flowers as filler, one or two types of greenery」；Homes & Gardens 的配方是「larger focal + a few varieties of secondary + light filler」；Lacybird 的螺旋指南写「3–5 focal first, then secondaries spiralling around, then filler and greenery」。三处口径一致，可以放心当作分层规则。

## 2. 真实课程的材料清单（可核对的数量）

### 2.1 Triangle Nursery Academy · Hand-tied Bouquet（18:02）

| 数量 | 材料 |
| --- | --- |
| 1 把 | 剪刀 / 修枝剪 |
| 1 卷 | 麻绳 |
| 1 包/卷 | 牛皮纸（Kraft Paper） |
| 1 卷 | 透明胶带（Cellotape） |
| 1 把 | 熊草（Beargrass，线状叶材） |
| 1 把 | 沙柳尖（Salal Tips，叶材） |
| 9 枝 | 黄玫瑰（Rose Yellow） |
| 7 枝 | 白色小菊（Chrysanthemum Santini White） |
| 3 枝 | 白色 LA 百合（2 个花苞） |
| 5 枝 | 白色多头玫瑰（Rose Spray White） |
| 5 枝 | 黄金球（Solidago Golden，填充） |

合计约 29 枝花 + 2 种叶材。**主花 17 枝（玫瑰/百合）+ 副花 7 枝（小菊）+ 填充 10 枝（多头玫瑰/黄金球）**，是典型「大束礼品花」的配比。

### 2.2 Triangle Nursery Academy · Blush Round Bridal Bouquet（26:30）

约 34 枝：粉玫瑰 5、O'hara 花园玫瑰 3、Wedding Pink 玫瑰 5、浅粉玫瑰 3、多头粉玫瑰 3、多头白玫瑰 3、白色洋桔梗 2、白色蓝盆花 5、尤加利 1/2 把、软叶蕨 1/2 把；辅料为剪刀、12mm 锚点胶带、麻绳。**新娘手捧**的配比明显更偏主花（玫瑰 19 枝），叶材只作点缀。

### 2.3 Triangle Nursery Academy · Domed Contemporary Hand-tie（12:41）

25–30 枝**同一种康乃馨** + 透明锚点胶带 + 剪刀/花刀 + 麻绳。这是「单花种圆顶」的商业做法：靠长度一致和均匀旋转做出圆顶，不依赖多种花材。

### 2.4 其他课程（只取结构信息）

- Bohemian Hand-tied Bouquet（15:32）：约 26 枝，含 1 把叶材和 1 把线状材料，风格更松散。
- Rustic Cottage Garden Wedding Bouquet（12:19）：约 32 枝，叶材与花园感花材比例更高。

### 2.5 Floral Design Institute · Hand-tied Bouquet（转录）

讲师 Leanne Kesler 的示范花材：quicksand 玫瑰、香豌豆、蓝盆花、须苞石竹、百子莲、gunni 尤加利。强调「所有材料提前去刺、去下部叶」，绑线在虎口下方绕 3 圈，最后剪根。

## 3. 游戏内现有资产（2026-11-10，V16 §2）

`app/public/assets/manifest.json`（`assetsVersion: 2026-11-10.lux3d-hydrangea-orchid`）现有 **57 条配色 / 32 种花型**，57 条只指向 32 个 GLB（同花型变体共用；其中绣球、蝴蝶兰为 2026-11-10 新增），全部来自 Lux3D 生成；57 条都带静态缩略图，程序化几何只作加载失败兜底。

### 3.1 32 种 Lux3D 花材资产表

三角面与文件大小为压缩归一化后的 processed 值；taskId 是该模型的真实生成任务，逐任务证据在 `assets/local/runs/<runId>/`。

| 花型 | 角色 | taskId | 三角面 | 文件大小 | glb | 配色数 |
| --- | --- | --- | --- | --- | --- | --- |
| 牡丹 | main | 4808667 | 26,938 | 6.8 MB → 1.34 MB | lux-peony.glb | 2 |
| 芍药 | main | 4808676 | 34,298 | 7.3 MB → 1.73 MB | lux-herbaceous-peony.glb | 2 |
| 康乃馨 | main | 4808685 | 49,810 | 8.5 MB → 2.40 MB | lux-carnation.glb | 2 |
| 百合 | main | 4808794 | 38,292 | 7.8 MB → 1.56 MB | lux-lily.glb | 2 |
| 向日葵 | main | 4808940 | 37,214 | 8.1 MB → 1.61 MB | lux-sunflower.glb | 2 |
| 大丽花 | main | 4808979 | 35,272 | 7.6 MB → 1.70 MB | lux-dahlia.glb | 2 |
| 马蹄莲 | main | 4808810 | 21,118 | 4.7 MB → 0.77 MB | lux-calla.glb | 2 |
| 绣球 | main | 5722956 | 36,794 | 9.97 MB → 2.15 MB | lux-hydrangea.glb | 2 |
| 蝴蝶兰 | main | 5723543 | 22,402 | 7.28 MB → 1.09 MB | lux-orchid.glb | 2 |
| 非洲菊 | main | 4809022 | 42,534 | 7.9 MB → 1.91 MB | lux-daisy.glb | 2 |
| 多头玫瑰 | filler | 4809269 | 35,536 | 8.6 MB → 1.70 MB | lux-spray.glb | 1 |
| 洋桔梗 | filler | 4809315 | 19,744 | 6.4 MB → 0.93 MB | lux-lisianthus.glb | 2 |
| 六出花 | filler | 4809577 | 34,924 | 9.8 MB → 1.71 MB | lux-alstroemeria.glb | 2 |
| 多头小菊 | filler | 4809602 | 29,956 | 8.7 MB → 1.56 MB | lux-spray-chrysanthemum.glb | 2 |
| 满天星 | filler | 4809615 | 33,764 | 11.2 MB → 1.92 MB | lux-babys-breath.glb | 2 |
| 补血草 | filler | 4809090 | 36,732 | 10.7 MB → 2.20 MB | lux-statice.glb | 2 |
| 澳洲蜡花 | filler | 4809859 | 31,870 | 9.6 MB → 1.65 MB | lux-waxflower.glb | 2 |
| 小米花 | filler | 4809884 | 28,122 | 9.7 MB → 1.61 MB | lux-rice-flower.glb | 2 |
| 婆婆纳 | filler | 4809897 | 28,528 | 8.3 MB → 1.43 MB | lux-veronica.glb | 2 |
| 金鱼草 | filler | 4809149 | 26,396 | 7.5 MB → 1.27 MB | lux-snapdragon.glb | 2 |
| 鲁斯卡斯 | greenery | 4810095 | 33,924 | 8.7 MB → 1.50 MB | lux-ruscus.glb | 1 |
| 沙柳叶 | greenery | 4810111 | 41,102 | 7.0 MB → 1.49 MB | lux-salal.glb | 1 |
| 文竹 | greenery | 4810120 | 25,998 | 10.2 MB → 1.66 MB | lux-asparagus-fern.glb | 1 |
| 皮革蕨 | greenery | 4810422 | 34,968 | 6.6 MB → 1.38 MB | lux-leatherleaf.glb | 1 |
| 肾蕨 | greenery | 4810432 | 38,156 | 7.4 MB → 1.56 MB | lux-boston-fern.glb | 1 |
| 常春藤 | greenery | 4810441 | 33,490 | 8.6 MB → 1.33 MB | lux-ivy.glb | 1 |
| 八角金盘 | greenery | 4810615 | 41,948 | 7.9 MB → 1.52 MB | lux-fatsia.glb | 1 |
| 蜘蛛抱蛋叶 | greenery | 4810630 | 10,788 | 3.9 MB → 0.40 MB | lux-aspidistra.glb | 1 |
| 熊草 | greenery | 4810643 | 32,248 | 8.6 MB → 1.81 MB | lux-bear-grass.glb | 1 |
| 玫瑰 | main | 4690769 | 57,476 | 7.83 MB（既有，未压缩） | rose-pink.glb | 3 |
| 郁金香 | main | 4690306 | 58,820 | 7.00 MB（既有，未压缩） | tulip-pink.glb | 3 |
| 尤加利 | greenery | 4691123 | 37,420 | 7.53 MB（既有，未压缩） | eucalyptus-green.glb | 3 |

- 27 个新任务（2026-11-07）合计 **540 积分**（每个 20），raw 218.4 MiB → processed 41.6 MiB（19.1%），合计 883,670 三角面。
- 3 个既有任务生成于 2026-11-05 免费公测期，积分未记录；它们的文件是原始高模，未走本轮的 2048 PNG → JPEG 压缩。
- 数据来源：`assets/local/processed/prepare-all.summary.json`（27 件）、`app/.verify/lux3d-all/*.png` 图头标注、`assets/local/runs/20261105-*/task.json`（3 个既有 taskId）。
- 配色数按 manifest 条目统计；颜色变体共用同一 GLB，不是独立模型。

### 3.2 Lux3D 花器资产（V10，5 件）

2026-11-07 13:32–13:38 真实生成 5 件花器/包装容器，全部下载并接入游戏「包装与花器」的呈现形态。

| 资产 id | 游戏内形态 | taskId | 积分 | 三角面 | processed | raw → processed |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| wicker-basket | 藤编花篮 | 4815066 | 20 | 41,304 | 2,436,508 B | 9,085,584 → 2,436,508（26.8%） |
| gift-box | 花礼盒 | 4815084 | 20 | 32,342 | 1,096,184 B | 5,377,484 → 1,096,184（20.4%） |
| kraft-bucket | 抱抱桶 | 4815099 | 20 | 26,120 | 903,464 B | 6,343,520 → 903,464（14.2%） |
| paper-bag | 手提花袋 | 4815119 | 20 | 24,418 | 793,664 B | 4,600,048 → 793,664（17.3%） |
| wood-crate | 木条花箱 | 4815140 | 20 | 29,578 | 1,204,332 B | 7,051,508 → 1,204,332（17.1%） |

- 合计 **100 积分**；raw 32,463,632 B → processed 6,434,152 B（19.8%），单件最大 2.44 MB，均低于 2.5 MB 目标。
- 加工：`scripts/vessel_glb_pipeline.py` 复用 `flower_glb_pipeline.py` 的 GLB 读写与贴图压缩（baseColor 1024 q82 / normal 1024 q90 / metallicRoughness 512 q75），并把 uint32 索引无损改成 uint16；逐 primitive 校验 `indexIdentical=true`。
- 接入：`app/src/data/presentation.ts` 的 `VESSEL_MODELS`（url + displayHeight），`app/src/three/decor/vessel-load.ts` 运行时按包围盒缩放/居中/落地；加载失败回退程序化容器。manifest 在 `app/public/assets/vessels/manifest.json`（含 taskId、credits、bbox、prompt/sha256、validation）。
- 4 视角核验：`app/.verify/v10-vessels/`（5 张 + overview + report.json）。瑕疵：抱抱桶正面一处细长纸边翘起、背面浅色横带；木箱俯视底板有细透光缝。
- 边界：礼盒/抱抱桶 GLB 的缎带是生成时的固定色，不跟随 `doc.ribbon.colorId`；程序化花篮/礼盒仅作兜底，外观与 GLB 不一致。

### 3.3 Lux3D 近景道具资产（V13，4 件）

2026-11-09 11:47–11:53 真实生成 4 件拍照布景的近景道具（用户选择「混合试点」：程序化搭空间、Lux3D 出近景质感），全部下载并接入节日暖光/家居客厅/咖啡馆三个布景。

| 资产 id | 游戏内用途 | taskId | 积分 | 三角面 | processed | raw → processed |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| candle | 节日暖光 · 黄铜烛台蜡烛 ×2 | 4957573 | 20 | 31,706 | 989,332 B | 5,711,160 → 989,332（17.3%） |
| coffee-set | 咖啡馆 · 咖啡杯碟勺 | 4957581 | 20 | 29,530 | 944,132 B | 4,551,940 → 944,132（20.7%） |
| table-lamp | 家居客厅 · 布罩台灯 | 4957596 | 20 | 24,098 | 891,152 B | 6,145,012 → 891,152（14.5%） |
| dried-bouquet | 家居客厅 · 陶瓶干花 | 4957617 | 20 | 44,438 | 1,381,476 B | 10,818,932 → 1,381,476（12.8%） |

- 合计 **80 积分**；raw 27,227,044 B → processed 4,206,092 B（15.45%），单件均低于 1.5 MB 目标。task/list 由 35 任务/700 积分变为 **39 任务/780 积分**。
- 加工：`scripts/prop_glb_pipeline.py`（由花器管线复制改造，importlib 复用 `flower_glb_pipeline.py`）；dry-bouquet 额外做了 root-alpha 铺白转 JPEG、NORMAL/TEXCOORD 16-bit 量化与贴图降档（baseColor 512 q80 / MR 256 q70），达到 1.38 MB。
- 接入：`app/src/data/props.ts`（`PROP_MODELS`：url/displayHeight/rotation）与 `app/src/three/decor/scene-props.ts`（按包围盒归一化、底面落地、失败回退程序化、按需在布景首次可见时加载）；manifest 在 `app/public/assets/props/manifest.json`。
- 4 视角核验：`app/.verify/v12-props/`（4 张 views + overview + detail + report.json）。生成侧瑕疵：dried-bouquet 贴图降档后 2× 近看花瓣偏软；table-lamp 底座自带一条细电源线（默认机位不可见）。脚本的「bbox 宽>高 → 躺倒」启发式把扁平咖啡杯碟误判过一次，已按四视角目检订正为 `rotation 0°/displayHeight 0.085m`。
- 边界：4 件道具只在 8 个拍照布景中的 3 个使用；GLB 有烘焙材质，不能像程序化道具那样跟随作品配色；加载失败时原程序化道具继续兜底（有专门的断网验证）。

### 3.4 内置程序化回退清单

`app/src/data/builtin.ts` 仍保留一套程序化目录：32 花型 / 57 配色，每条只有程序化几何 + 基础色，参数化生成，不依赖任何 GLB。它只在 manifest 缺失、解析失败或单个模型加载失败时顶替，**不属于正常运行时花材**，也不在本轮资产统计内。包装纸、丝带、卡片同样是程序化几何（3 色纸 / 3 色丝带 / 3D 卡片）。

包装 / 成品材料：包装纸 3 色（ivory / kraft / sage）、丝带 3 色（rose / cream / sage）、3D 卡片（收件人 ≤20 字、正文 ≤120 字、署名 ≤20 字）。

### 3.5 V16 §2 新增两种主花：绣球 / 蝴蝶兰（2026-11-10，2 件真实生成）

用户明确授权「3d模型也做直接加进去」后，按现有 Lux3D 接口**严格顺序**生成（同一批次 max-concurrent=1：前一个下载完成才创建下一个），两次 create 均一次成功、无重试、无失败请求。

| 花型 | taskId | 积分 | 创建 → 下载 | 耗时 | 三角面 / 顶点 | raw → processed | 归一化 |
| --- | ---: | ---: | --- | ---: | --- | --- | --- |
| 绣球 hydrangea | 5722956 | 20 | 11:32:55 → 11:38:57 | 359 s（轮询终态） | 36,794 / 46,502 | 9,970,452 B → 2,153,364 B（21.6%） | target 0.5 m，scale 1.111111，headOffsetY 0.40441，headRadius 0.18493 |
| 蝴蝶兰 orchid | 5723543 | 20 | 11:39:07 → 11:43:51 | 282 s（轮询终态） | 22,402 / 19,450 | 7,278,688 B → 1,088,920 B（15.0%） | target 0.5 m，scale 0.769231，headOffsetY 0.392274，headRadius 0.09011 |

- 合计 **40 积分**；`task/list` 由 39 任务 / 780 积分变为 **41 任务 / 820 积分**（2026-11-10 11:44 核对）。
- 提示词：`assets/local/prompts/20261110-hydrangea.txt`（天蓝圆顶花球、四瓣小花、单枝正面完整）与 `assets/local/prompts/20261110-orchid.txt`（单枝微拱花茎、3–4 朵白花 + 淡紫唇瓣 + 顶端花苞 + 2 片基叶），沿用 2026-11-07 批次的「单一主体居中 / 纯白背景 / 无容器」结构。
- 证据目录：`assets/local/runs/20261110-hydrangea/`、`assets/local/runs/20261110-orchid/`（intent / create_response / task.json / polls.jsonl / task_result / downloads / generation）与 `assets/local/runs/batch-20261110/summary.json`。
- 加工：`scripts/flower_glb_pipeline.py prepare`（贴图 baseColor 2048→1024 JPEG q82、metallicRoughness 2048→512 q75，无 normal map；几何 bufferView 原字节不动，4 字节对齐重排，`glb_valid=true`、三角面与原始一致）。
- 哈希：绣球 raw `ee958539c99f11c510ee681356b0af84757bec386d4685aeaebec8872318b17f` → processed `98bbb06f03fbd77c1383c1e4e92d3d6bc3d91a3fb5861a5cd23b34a9cbf979e9`；蝴蝶兰 raw `ddc3a99a9e2d7a6f668f209ad37c4c5b2b113d31d6e18ef7b30b536a35dcb8eb` → processed `c1669c807768158a4af4ec5b5468ad8de44c45526c0ceb2d32319cec44f834f4`。
- 接入：`manifest.json` 4 条配色（hydrangea-1/2、orchid-1/2）指向 `lux-hydrangea.glb` / `lux-orchid.glb`，缩略图 `thumbs/hydrangea-1|2.png`、`thumbs/orchid-1|2.png`；`assetsVersion` 更新为 `2026-11-10.lux3d-hydrangea-orchid`（32 花型 / 57 配色，`species-plan → builtin.ts` 差异 0）。程序化几何保留为加载失败兜底，卡片与知识卡不再标「占位」。
- 形态核验（4 视角接触表）：`app/.verify/lux3d-all/hydrangea.png`（正/左/背/俯）、`app/.verify/lux3d-all/orchid.png`；配色变体 `hydrangea-variants.png` / `orchid-variants.png`；游戏内 `app/.verify/v16-models/`（花材架、工作台、知识卡、与牡丹同机位比例对比）。
- 已知边界：绣球花球直径约 0.37–0.44 m，是主花里最大的花头（接触包络按实测 headRadius 0.185 m，比牡丹 0.176 m 略大）；蝴蝶兰一次生成只含 3 朵开放花 + 1–2 个花苞，基叶与气生根在茎底有交叠；两件都是单几何，第二配色靠运行时 recolor（绣球窗口 [151,271]、蝴蝶兰 [303,69]，后者端点被截在茎叶绿色带外）；2048 贴图压到 1024 后 2× 近看略软。

## 4. 角色覆盖与缺口（V16 §2）

| 角色 | 真实工作流需要 | 游戏现状 | 缺口 |
| --- | --- | --- | --- |
| 主花 | 2–3 种、可重复 | 12 种真实模型（玫瑰、郁金香、非洲菊、牡丹、芍药、康乃馨、百合、向日葵、大丽花、马蹄莲、绣球、蝴蝶兰） | 每个花型只有 1 个几何，花色靠换色 |
| 副花 | 2–3 种小体量花 | 10 种（多头玫瑰、洋桔梗、六出花、多头小菊、满天星、补血草、澳洲蜡花、小米花、婆婆纳、金鱼草） | 穗状花型 headRadius 偏小，包络近似 |
| 叶材 | 1–2 种 + 线状材料 | 10 种（尤加利、鲁斯卡斯、沙柳叶、文竹、皮革蕨、肾蕨、常春藤、八角金盘、蜘蛛抱蛋叶、熊草） | 线状叶材已补（熊草），但仍是刚性包络 |
| 包装纸 | 2–4 张分层、深浅两色 | 1 层程序化锥面、3 色 | 不做分层与裁剪（见 packaging-breakdown.md） |
| 呈现容器 | 花瓶 / 陶罐 / 花篮 / 花盒 / 桶 / 袋 | 8 种形态：纸片包装 + 7 种容器；其中花篮/礼盒/抱抱桶/花袋/木箱为 Lux3D GLB，花瓶/陶罐为程序化 | 容器无花泥/内衬碰撞体；礼盒缎带不跟色 |
| 近景道具（V13） | 拍照场景里的烛台/杯碟/台灯/干花 | 4 件 Lux3D GLB：节日暖光蜡烛 ×2、咖啡馆咖啡杯碟、家居客厅台灯与陶瓶干花；程序化版本继续兜底 | 只在 3 个拍照场景使用；烘焙材质不跟作品配色 |
| 丝带 | 缎带/麻绳 | 3 色程序化丝带 | 没有绳结/提手 |
| 卡片 | 名片/吊牌 | 3D 卡片 | 没有吊牌形态 |
| 工具 | 剪刀、胶带、绑线 | 无 | 不做工具交互 |

**结论**：V9 之后「主花 + 副花 + 叶材」三类都有真实模型，V0.7 时「副花角色为空」的短板已补齐；V10 又把呈现容器扩到 7 种，其中 5 种为 Lux3D 生成的真实 GLB；V13 起拍照布景里的近景道具（4 件）也用 Lux3D 真实生成；V16 §2 再把 V0.7 起只做程序化占位的绣球、蝴蝶兰补成真实模型，目录到 **32 花型 / 57 配色全部指向真实 GLB**，程序化只负责空间骨架与加载失败兜底。剩下的问题不是数量，而是每个花型只有一种几何、颜色靠运行时换色，以及接触与穿插仍是近似；容器仍是摆设 + 支点约束，没有花泥/内衬碰撞。再扩花材的收益低于补包装分层、容器手感和真机验收。

## 5. 证据与局限

- 材料数量来自课程页面的材料表原文（抓取文本见 `experiments/local/research/pages/www.trianglenurseryacademy.com_tutorials_*.txt`），不是估算。
- 游戏内资产一节来自 `app/public/assets/manifest.json`、`assets/local/processed/prepare-all.summary.json` 与各 `lux-*.measure.json`，可复现；花型形态见 `app/.verify/lux3d-all/`（32 个花型 4 视角 + 变体对比；绣球 / 蝴蝶兰为 2026-11-10 新增）。
- 2026-11-10 两件新模型另有独立验证：`app/scripts/v16-models.mjs` **39/39**（fixture:false 真实清单、花架无占位标签、知识卡、工作台放花且 `loaded.source=glb`、网络 200、无页面错误），证据 `app/.verify/v16-models/results.json` 与 5 张截图；回归 `v14-shelf` 48/48、`iteration5` 45/45、`v16-catalog` 113/113（其中 4 条「占位」断言按真实模型落地同步更新）、`tsc` 0。
- 课程页面标题里的「18:02 / 26:30 / 12:41 / 15:32 / 12:19」是页面标注的视频时长，不是本项目实测。
- 27 件新资产的真实生成耗时、积分与压缩比可在 `assets/local/runs/` 与 `assets/local/processed/` 逐件核对；2026-11-10 两件（taskId 5722956 / 5723543，各 20 积分）同理；3 个既有任务积分未知。
- 未做真实花材采购、养护或成本核算；未核实任何花材的商业授权。
