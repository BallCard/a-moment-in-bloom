# 花间一刻 · A Moment in Bloom

**3D 花艺创作小游戏** · 把心意，慢慢做成一束花。

群核科技 Aholo 全球 3D AI 黑客松参赛作品。在一间温暖的花艺工作室里，选花、逐枝搭配、包装、系丝带、写卡片，最后为成品拍照；可以随心创作，也可以回应生日、乔迁与纪念日的来信。

![花间一刻](app/public/brand/icon-192.png)

**在线体验**：<https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full>
**90 秒 Demo 视频**：<https://www.modelscope.cn/studios/BallCard/bouquet-demo-video>
**当前版本**：V16 / 0.16.0（提交版本 tag [`v0.16.0`](https://github.com/BallCard/a-moment-in-bloom/tree/v0.16.0)）

## 作品内容

- **花材**：32 种花型 / 57 种配色，全部为 Aholo Lux3D 文生 3D 生成的真实 GLB 模型；配色由同一批模型在运行时换色得到，不把换色算作独立模型。
- **花器与道具**：5 件真实生成花器（花篮 / 礼盒 / 抱抱桶 / 花袋 / 木箱）与 4 件近景拍照道具，同样来自 Lux3D。
- **制作流程**：花材架（12 个商品类目 + 主花/配花/叶材三组入口、名称搜索、9 色系筛选、最近使用）→ 逐枝摆放与微调 → 整理（玫瑰族翻瓣与去刺、玫瑰/郁金香修枝修叶、5 种容器花泥、一键整束整理与恢复）→ 包装与装饰（8 种呈现形态、9 款辅助装饰、丝带、贺卡）→ 拍照（8 个场景、一键适配、相册与导出）。
- **委托与作品展**：6 封带心愿条件的委托信、开屏画册式作品展与「用这个配色开始创作」。
- **声音**：WebAudio 程序化合成的动作音效 + 由 ModelScope ACE-Step 真实生成的循环背景音乐。
- **AI 辅助**：服务端调用魔搭视觉模型读成品照给出主观点评、DeepSeek 生成贺卡润色建议；凭据只保留在服务端。

## Lux3D 的实际使用

Lux3D 资产不是展示图片，而是玩家逐枝挑选、旋转、修剪、包装和拍照的对象：单枝提示词 → 生成导出 → 结构检查 → 包围盒归一化与可见花头测量 → 贴图压缩 → 接入 Three.js 工作台 → 运行时换色窗口按花材实测裁剪（避免把茎叶染成花瓣色）。模型加载失败时由程序化几何兜底，正常运行时全部使用真实 GLB。

后台真实运行 43 个生成任务、860 积分；taskId、三角面、压缩比与哈希见 [`docs/materials-inventory.md`](docs/materials-inventory.md)，生成管线脚本见 [`scripts/`](scripts)（`lux3d_generate.py` / `lux3d_batch.py` / `flower_glb_pipeline.py` / `vessel_glb_pipeline.py` / `prop_glb_pipeline.py`）。

## 技术栈与目录

React + TypeScript + Vite + Three.js；Node.js 服务端负责 AI 点评、贺卡润色与静态资源托管。无登录、无数据库，作品保存在浏览器 localStorage。

```
app/            # 前端（src/）+ Node 服务（server/）+ 资源（public/）+ Dockerfile
scripts/        # Lux3D 生成与资产处理管线、场景/缩略图工具
docs/           # 产品文档、Lux3D 素材清单、各版本发布说明
assets/         # 资产清单示例（真实 GLB 在 app/public/assets）
```

## 本地运行

```powershell
cd app
npm install
npm run dev        # http://127.0.0.1:5173/
npm run server     # 另开终端启动点评/润色服务（可选，需 MODELSCOPE_API_KEY）
npm run build      # 生产构建
```

服务端从环境变量 `MODELSCOPE_API_KEY` 读取凭据（开发模式也可读取本机 `~/.modelscope/api-key.txt`），不会下发到前端。

## 已知边界（如实说明）

- 花枝接触是简化包络 + 轻量形变，不是逐花瓣物理；插得很密时仍可能看到局部穿插。
- 翻瓣是整模外壳形变（玫瑰族），并非逐瓣骨骼；非玫瑰 / 郁金香不支持剪短与逐叶修剪，界面按能力隐藏而不是放假按钮。
- 叶片是程序化几何；包装纸是参数化折叠，不能自由揉皱；装饰参数为按钮步进。
- 背景音乐为 API 生成的循环氛围乐，循环用 3 秒交叉淡化近似。
- 4K、移动端真机、弱网与触屏手势尚未完整验收；本地作品不跨设备同步。

## 版权说明

代码、三维资产与文案版权归作者所有。本仓库公开用于赛事评审与学习参考，**未附带开源许可**，不构成对再分发、修改后发布或商用的授权。第三方组件、模型与素材的许可见各自来源说明。

## 相关文档

- [产品介绍](docs/product-introduction.md) · [品牌说明](docs/brand.md) · [架构起步设计](docs/architecture.md)
- [Lux3D 生成与素材清单](docs/materials-inventory.md)
- 版本发布说明：[V16](docs/releases/v0.16.0.md) · [V15.1](docs/releases/v0.15.1.md) · [V15](docs/releases/v0.15.0.md) · [历史版本](docs/releases)
