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
npm run dist       # 出安装包（NSIS，产物在 release/）
npm run verify:all # 全量回归：事实表 + P3 对齐 + P4/P5/P6 冒烟
```

## 防漂移

桌面程序在 Node 侧重新实现了逻辑，有三张"事实表"是从 PowerShell 版搬过来的：

| 数据                   | 落点                                        | PowerShell 源                                                 |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| 24 项 Agent 路径预设      | `src/shared/data/agent-presets.json`      | `scripts/setup-wizard.ps1:702-724`（+Marvis 动态）               |
| 9 大分类关键词词典（131 个关键词） | `src/shared/data/category-dict.json`      | `setup-wizard.ps1:410-420`、`generate-router-skill.ps1:74-84` |
| 8 个同源多根组（23 条模式）     | `src/shared/data/same-source-groups.json` | `scripts/lib/duplicate-guard.ps1:14-23`                      |

谁先改了一边没跟上另一边，行为就会悄悄分叉。所以：

```bash
npm run check:tables
npm run verify:align   # P3：真跑 verify.ps1 与 Node 状态机逐行比对
npm run verify:p4      # P4：临时沙箱里真跑 建/拆/归并（24 项断言）
```

它会**反向解析 PowerShell 源码**再与 JSON 逐项比对，不一致就报错并 exit 1（会指出是哪一项、哪边多/少）。  
PowerShell 源码路径可用 `SKILLS_PS_ROOT` 环境变量覆盖。

## 安全约定

- 拆除联接一律用 `fs.rmdirSync(path)`——只删重解析点，**不穿透共享库**；代码里禁止 `fs.rmSync(recursive)`
- 唯一例外：接入时迁移内容的「去重副本」删除与跨盘迁移清理，必须先过 `assertRealDir` 守卫（目标确认不是联接/符号链接才允许递归删），见 `junction-write.ts`
- 会改本机环境的操作（建/拆联接、归并、安装/移除技能、写 `_meta.json`）在 UI 上二次确认；接入前先出预案（迁移清单 / 内容冲突 / 同源多根警告）
- 只读操作（探测状态、扫描技能、检测更新）随便点
- 不碰各 Agent 的平台内置技能目录（如豆包 `.skills` 系统根）

## 进度

- [x] P1 脚手架：窗口 + IPC + 配置读写 + 联接状态（只读）
- [x] P2 三张事实表（24 项 Agent 预设 / 9 大分类词典 / 8 个同源组）落 JSON + 防漂移校验
- [x] P3 联接只读：24 项探测 + 状态机完整对齐
- [x] P4 联接写：建（含内容迁移 + SHA256 去重）/ 拆 / 归并（verify:p4 沙箱 24 项断言全过）
- [x] P5 技能库：列表 / 分类 / 安装（GitHub / owner/repo / skills.sh）/ 移除 / 翻译简介（腾讯 TranSmart → MyMemory → Google gtx）/ 生成路由（verify:p5 离线 27 项断言 + 真机网络安装与翻译验证通过）
- [x] P6 更新检测：技能来源仓库六态判定 + 一键升级（重新安装 -Replace）+ 工具自身版本自检（verify:p6 离线 17 项 + 真机 API 验证：update/latest/gone/自检全过）
- [x] P7 设置 / 主题 / 托盘 / 导入导出：设置页（共享库路径 / Agent 配置管理 / 主题三态 / 关闭行为 / GitHub Token / 翻译邮箱 / TLS 开关 / 导入导出 / 关于）、关闭最小化到托盘、主题持久化跟随系统（nativeTheme 同步渲染进程）
- [x] P8 打包分发：electron-builder NSIS（`npm run dist`），产物 `release/SkillsManager Setup <版本>.exe`（约 108 MB，x64）+ `release/win-unpacked/` 免安装目录；应用图标 / 托盘图标为脚本生成的自绘 PNG/ICO（链环构图）
- [x] 自动更新：electron-updater（GitHub Releases 通道，用户触发下载/安装，更新页有进度条）
- [x] 自动发布：push tag `v*` 触发 GitHub Actions（`.github/workflows/release.yml`），构建 → 校验 tag 与 package.json 版本一致 → `electron-builder --publish always` 发布 Release（含 latest.yml 供自动更新）

## 发布流程

```bash
# 1. 改 package.json 的 version（如 0.1.0 → 0.2.0）
# 2. 提交并打 tag 推送，CI 自动出包发布：
git add . && git commit -m "feat: xxx" && git tag v0.2.0 && git push origin main --tags
# 3. GitHub Actions 跑完后，Release 页出现安装包 + latest.yml
# 4. 已安装的旧版本在「更新」页检测到新版本 → 下载 → 重启安装
```
- [ ] P8 打包分发

### 已知边界（P4 遗留）

- ~~动态预设（Marvis 多用户）接入时配置键派生为 `marvis-<用户ID>`，探测页 `configured` 判定不跟随~~ 已修：detect.ts 现按路径反查实际配置键（含派生键），`configured` 与「拆除」均用真实键名。
- 联接指向别处（other-link）不做自动改向，保持 PowerShell 版「人工处理」语义。
