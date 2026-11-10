# app/ · 花间一刻工作台（前端 + Node 服务）

React + TypeScript + Vite + Three.js 前端，外加一个 Node 服务端（静态资源托管、AI 点评、贺卡润色）。产品说明、截图与总体介绍见[仓库根 README](../README.md)。

## 快速开始

```powershell
npm install
npm run dev        # 前端 http://127.0.0.1:5173/（Vite 固定 127.0.0.1，strictPort）
npm run server     # 点评/润色服务，默认 8787；需要 MODELSCOPE_API_KEY
npm run dev:all    # 前端与评分服务一起起
npm run build      # 生产构建（dist/）
```

服务端凭据只从环境变量 `MODELSCOPE_API_KEY` 读取（开发模式也可读本机 `~/.modelscope/api-key.txt`），不会下发到前端。生成背景音乐时用 `../scripts/make_music_api.py`。

## 健康检查

```powershell
curl http://127.0.0.1:8787/api/health
```

返回版本号与依赖状态；`credentials` 只表示服务端是否读到密钥，不返回密钥内容。

## 目录结构

```
src/three/      Three.js 场景、花材装配、接触与整理、包装与拍照布景
src/data/       花材目录、尺寸、委托、场景、文案等数据
src/components/ 工作台、花材架、包装面板、相册、知识卡等界面
src/store/      作品文档与编辑器状态
server/         Node 服务（点评、润色、静态托管、压缩缓存）
public/         manifest.json、真实 GLB 花材/花器/道具、缩略图、音频、场景图
scripts/        本地回归脚本（Playwright 驱动真实 Chrome）
qa/             手工验收页
```

## 资产接入契约（manifest）

`public/assets/manifest.json` 描述花型、配色、模型文件与换色窗口；前端按 `assetsVersion` 加载。清单缺失、解析失败或单个 GLB 加载失败时回退到程序化几何兜底，正常运行时全部使用真实 GLB。字段与生成方式见 [`../docs/materials-inventory.md`](../docs/materials-inventory.md) 与 [`../scripts/flower_glb_pipeline.py`](../scripts/flower_glb_pipeline.py)。

## 构建与验证

```powershell
npx tsc --noEmit     # 类型检查
npm run build        # 生产构建
npm run smoke        # Chrome 回归（默认连 5173，需要 dev 已启动；SMOKE_URL 可覆盖）
```

开发记录与历史验收证据保存在作者本机，不在本仓库内。

## 已知限制

见根 README「已知边界」一节：碰撞为简化包络、翻瓣为整模形变、纸包为参数化折叠、移动端与 4K 未完整验收。
