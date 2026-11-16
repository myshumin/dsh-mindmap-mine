# dsh-mindmap-mine

DSH NEXT 的思维导图插件：以右侧栏标签页运行，人和 AI 在同一棵树上编辑。
基于 [SSShooter/dsh-mindmap-live](https://github.com/SSShooter/dsh-mindmap-live) 0.5.0（MIT）魔改，画布内核为 [MindElixir](https://docs.mind-elixir.com/)。

## 重要功能

- **图属于工作区，不属于会话。** 文件落在 `.dsh/mindmaps/<id>.json`，是唯一真相源；会话只记住在看哪张图。支持多图（新建 / 切换 / 改名 / 删除）、跨会话共享、外部改文件秒级同步，老会话的图自动迁移落盘。
- **节点标注。** 黄色便签随打随存，长说明不塞进节点标题；标注跟着树同步，导出时就是需求细节。
- **节点状态。** 想法 / 待办 / 进行中 / 完成 / 废弃，选中节点按 `1`–`5` 标记、`0` 清除；画布有状态点，任务抽屉按状态分组。
- **和 AI 协作。** `mindmap_live_get` / `mindmap_live_set` / `mindmap_mark` 让 agent 读树、改树、逐条回写进度；选中节点按 `C` 或右键「加入对话框」，用引用 chip 把节点名、层级路径和标注带进输入框。
- **一键导出。** `📄 导出需求` 写出 `specs/<标题>.md`（层级编号、标注、状态）；`📋 任务` 写出 `tasks/<标题>.md/.json` 并把执行指令复制到剪贴板；`⬇ 图片` 导出 PNG。
- **画布体验。** 明暗主题（可跟随系统）、XMind 配色、方格背景、中文右键菜单、拖动排序、聚焦、空格编辑、默认 75% 缩放且增删后不跳；`? 帮助` 是速查表。

## 文件

```
<workspace>/.dsh/mindmaps/
├── <id>.json                # 导图，真相源
├── specs/<标题>.md          # 需求文档
└── tasks/<标题>.md / .json  # 任务清单
```

写入走临时文件 + 原子替换，会话投影只作渲染缓存；HTTP 接口仅接受 loopback 请求。

## 快捷键

| 键 | 作用 |
| --- | --- |
| `Tab` / `Enter` | 加子节点 / 同级节点 |
| `空格` / 双击 | 编辑节点 |
| `C` | 把选中节点加入对话框 |
| `1`–`5` / `0` | 标记 / 清除节点状态 |
| `⌘⇧N` / `⌘⇧F` | 标注 / 聚焦（Windows、Linux 用 Ctrl） |
| `Esc` | 关闭便签 / 退出标签页全屏 |

工具条 `? 帮助` 里有完整速查表。

## 安装

```bash
PROF=~/.dsh/profiles/desktop
cp -R . "$PROF/node_modules/dsh-mindmap-mine"
```

另需在 profile 的 `package.json` 依赖里加 `"dsh-mindmap-mine": "file:<本目录>"`，并在 `dsh.profile.bundles` 里加 `"dsh-mindmap-mine"`；`dsh.bundle.patch.yml` 会自动补 loader 条目。

改 `lib/client.js` 后用 **View ▸ Force Reload**（普通 Reload 可能命中缓存，必要时动一下 `version`）。改 `lib/index.js` 后关开插件即可重载宿主半，无需重启应用：

```
plugin_manager set_plugin target=include:dsh-mindmap-mine enabled=false
plugin_manager set_plugin target=include:dsh-mindmap-mine enabled=true
```

## 结构

- `lib/index.js` — 宿主半：`mindmap` 投影、`/mindmap/*` 路由、文件读写与迁移、三个 agent 工具
- `lib/client.js` — 浏览器半：画布与界面（单文件 bundle，内联 MindElixir）
- `dsh.bundle.patch.yml` — profile loader 条目
- `tools/` — 老会话日志修复（`repair-legacy-records.py`）与恢复校验（`restore-check.mjs`）

老会话（0.7.6 之前）的历史若打不开，先跑修复脚本改写旧事件类型，再用恢复校验确认。

逐版本改动、兼容处理与踩坑记录见 [DEVELOPMENT.md](DEVELOPMENT.md)。
