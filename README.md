# skills-manager-desktop

跨 Agent 技能共享库的**桌面管理程序**。用 GUI 管理"一套技能装一次、多个 Agent 共用"这件事。

对应的命令行版本在 [`agent-skills-shared`](https://github.com/JacksenHu/agent-skills-shared)（PowerShell 脚本 + 终端向导）。
本项目是**独立重写**：不调用那些 .ps1，逻辑在 Node 侧重新实现，两边只通过数据耦合——共享技能库目录本身，以及 `{sharedRoot, agents}` 这份配置。

## 技术栈

Electron + React + Vite + TypeScript + Tailwind CSS。UI 与交互参照 [CC Switch](https://github.com/farion1231/cc-switch)：顶部导航 + 卡片列表 + 操作按钮悬停显示 + 明暗主题 + 系统托盘。

## 环境要求

- Windows（Junction 是 Windows 专属能力，建/拆**不需要管理员权限**）
- Node / npm

Electron 二进制走国内镜像，已写进 `.npmrc`：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
（本机访问 github.com 在 Node 侧有 TLS 证书问题，默认源会下载失败。）

## 常用命令

```bash
npm run dev        # 开发模式，热更新
npm run build      # 打包到 out/
npm run typecheck  # 类型检查
npm run dist       # 出安装包（NSIS）
```

## 防漂移

桌面程序在 Node 侧重新实现了逻辑，有三张"事实表"是从 PowerShell 版搬过来的：

| 数据 | 落点 | PowerShell 源 |
|---|---|---|
| 24 项 Agent 路径预设 | `src/shared/data/agent-presets.json` | `scripts/setup-wizard.ps1:702-724`（+Marvis 动态） |
| 9 大分类关键词词典（131 个关键词） | `src/shared/data/category-dict.json` | `setup-wizard.ps1:410-420`、`generate-router-skill.ps1:74-84` |
| 8 个同源多根组（23 条模式） | `src/shared/data/same-source-groups.json` | `scripts/lib/duplicate-guard.ps1:14-23` |

谁先改了一边没跟上另一边，行为就会悄悄分叉。所以：

```bash
npm run check:tables
```

它会**反向解析 PowerShell 源码**再与 JSON 逐项比对，不一致就报错并 exit 1（会指出是哪一项、哪边多/少）。
PowerShell 源码路径可用 `SKILLS_PS_ROOT` 环境变量覆盖。

## 安全约定

- 拆除联接一律用 `fs.rmdirSync(path)`——只删重解析点，**不穿透共享库**；代码里禁止 `fs.rmSync(recursive)`
- 会改本机环境的操作（建/拆联接、安装/移除技能、写 `_meta.json`）在 UI 上二次确认
- 只读操作（探测状态、扫描技能、检测更新）随便点
- 不碰各 Agent 的平台内置技能目录（如豆包 `.skills` 系统根）

## 进度

- [x] P1 脚手架：窗口 + IPC + 配置读写 + 联接状态（只读）
- [x] P2 三张事实表（24 项 Agent 预设 / 9 大分类词典 / 8 个同源组）落 JSON + 防漂移校验
- [ ] P3 联接只读：24 项探测 + 状态机完整对齐
- [ ] P4 联接写：建 / 拆 / 归并
- [ ] P5 技能库：列表 / 分类 / 安装 / 移除 / 翻译简介 / 生成路由
- [ ] P6 更新检测：技能来源仓库 + 工具自身
- [ ] P7 设置 / 主题 / 托盘 / 导入导出
- [ ] P8 打包分发
