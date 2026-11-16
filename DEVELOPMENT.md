# dsh-mindmap-mine · 开发笔记

> 从 README 精简出来的逐版本改动、实现细节与踩坑记录。功能说明见 [README.md](README.md)。

---

自用魔改版 DSH 思维导图插件。基于 [SSShooter/dsh-mindmap-live](https://github.com/SSShooter/dsh-mindmap-live) 0.5.0（MIT），
按 DSH NEXT 0.2.2 的槽语义重写客户端，并把入口加到了会话顶部工具栏。

## 相对上游的改动

**⓪ 视图形态（0.7.7）**
自绘的 `MindMapDock`（fixed 面板）与 `shell.overlay` 全屏浮层全部删除，改为宿主右侧栏标签页，
见下一节「界面归属」。视图状态不再持久化到 localStorage。

**① 浏览器侧激活（原版在 0.2 上直接不加载）**
`require("@deepseek-ai/dsh-client-runtime/client")` → `require("@deepseek-ai/dsh-client-store")`。
web shell 的 seed 表里没有前者，entry 会 `import failed` 且 `web boot: 1 entry did not activate`。

**② 去掉 session 子槽（原版会整窗黑屏）**
原版把 `scope: "session"` 的子槽挂在 root 级 `shell.overlay` 下直接 `renderSlot()`，
0.2 起 StrictSessionEntry 会抛
`strict session slot 'xxx.autoopen' rendered without a scope binding`，没有 error boundary → 白/黑屏。
改法：`shell.overlay` 不再声明 children，`panelBody()` 直接渲染画布组件。

**③ 当前会话的取法**
root 组件拿不到 session scope binding，改用 shell 自己的写法：

```js
Object.values(state.byId).find((row) => (row.retainedBy.mainView ?? 0) > 0)?.id
```

（本版 sessions store 快照是 `{ids, byId, phase, projectionsBySession}`，**没有** `current` 字段，
原版读 `state.current` 恒 undefined，面板只会显示"无会话"。）

**④ 投影读取与写回**
- 读：`state.projectionsBySession[id].values.mindmap`（fallback `state.byId[id].projectionValues.mindmap`）
- 写：同源 `fetch POST /mindmap/update`，body
  `{type:"client-request", method:"update", rpcId, payload:{sessionId, tree}}`
  —— 宿主 `lib/index.js` 本来就在 webServer 上挂着这个 loopback 路由，不需要 Connection RPC。

**⑤ 自动展开**
改为 root 级 `MindMapAutoOpenRoot`：监听当前会话 projection 由空变非空 → `actions.showDock()`。

**⑥ 顶部工具栏入口（本仓库新增）**
注册 `conversation.session.header.utilities`（`scope: session`, `kind: list`，即会话标题行右侧的
工具区，`会话体检` 旁边），渲染「🧠 思维导图」药丸按钮，与侧边栏按钮共用同一个 view store。
该槽是 session 作用域而 view store 只有一个 root 实例，所以按钮通过
`ctx.slots.resolveStore(uiStore)` 取共享实例（失败不缓存，300ms 轮询直到可用），
不能在这里再声明 `store: uiStore`（一个 handle 只允许一个 scope）。

**⑦ 暗色主题 + 打开即 100%（本仓库新增）**
- `themeFor(Ctor, mode)`：`auto | light | dark`，`auto` 跟随 `prefers-color-scheme` 并实时响应。
  暗色在 MindElixir 的 `DARK_THEME` 上覆盖 `DARK_CSS_OVERRIDES`
  （`--bgcolor:#131316`、`--main-bgcolor:#23232b`、`--root-bgcolor:#2b3550`…），与宿主灰阶对齐。
- 切换按钮现在**并进内置缩放工具条那一排**（挂进 `.mind-elixir-toolbar.rb`，
  与全屏/定位/± 同一枚胶囊），点一下按 `auto → light → dark` 循环，
  mode 存 `localStorage["dsh.mindmap-mine.theme"]`。
- 初始化与每次 refresh 都不再 `scaleFit()`，改 `toCenter()`：打开就是 100%，agent 更新也不动用户缩放。

**⑧ 引用节点进输入框（本仓库新增）**
- 走**原生 reference chip**，不是纯文本：输入框里只显示节点名（蓝色 tag + 图标），
  鼠标悬停/发送时才带出完整路径。
  - 插入接口不在 `InputActions` 里（那里只有 `insertQuote`/`insertText`…），真正的 chip 是
    session 作用域的 bailed 事件：`actx.bail(actx, "slash/input-insert-reference", { reference, span })`，
    `ReferenceInsert = { source, ref, label, appearance: "session"|"file"|"folder", clipboardText }`。
  - canvas 在 root 作用域，因此会话顶部按钮（`conversation.session.header.utilities`）把
    `inputActions` + `sessions.scope(sessionId)` 一起存进模块级 `composerBridge`，canvas 点击时调用。
  - 本次用 `label = 节点名`、`appearance = "file"`（蓝色带图标）、
    `clipboardText = 【导图节点】<topic>（路径：root › … › topic）` —— 于是「看到的是名字，发出去的是带路径的那行」。
- 降级链：reference chip 失败 → `insertText` 插纯文本 → 仍失败则复制到剪贴板 + 画布内提示。
- **触发方式（0.7.1 起）**：选中节点后按 `C` 键；或在节点上右键 →「加入对话框」。
  单纯点击节点**不再插入**（之前单击即插入，误操作太多）。同一节点 900ms 内只插一次；
  正在编辑节点（`#input-box` 打开）或按着修饰键时不触发。
- 注意点击目标必须是 `.me-tpc`（class，不是自定义标签名；内核里是 `<div class="me-tpc">`）。

**⑨ XMind 配色 / 中文右键菜单 / 空格进入编辑（本仓库新增）**

- **XMind 式配色**：`XMIND_PALETTE` 十条高区分度色相，深浅两套主题共用；
  `decorateBranches()` 在 `linkDiv` 之后给主分支（`me-main > me-wrapper > me-parent > me-tpc`）
  按 `borderColor` 取色，节点底染同色 20%（暗）/13%（亮）的淡底并加圆角，子层再淡一档。
  装饰只改 DOM，**不写进 nodeData**，所以不会把样式回推给 agent 的树。
- **右键菜单中文化**：构造时 `contextMenu: { focus, link, locale }`，`locale` 走
  `ZH_MENU` / `EN_MENU`（按 `navigator.language` 是否 zh 选择），同时把 `newTopicName`
  设为「新节点」/「New Node」。MindElixir 的菜单项语言是整对象覆盖，必须给全 12 个 key。
- **主题按钮位置**：挂在缩放条 `.mind-elixir-toolbar.rb` 的**最左**（`insertBefore(bar.firstChild)`），
  后面才是全屏 / 定位 / − / +。
- **空格编辑**：焦点在画布（或刚点过节点、焦点落 body）时按空格 →
  `mind.selectNode(nodeEl, false)` + `mind.editTopic(nodeEl)`，内核会建 `#input-box`
  （`contenteditable="plaintext-only"`）并全选文字，直接打字即替换。
  - 监听必须挂在 `window` 捕获阶段（挂 document 会被宿主先吃掉）。
  - `editTopic` 会 fire `operation{name:"beginEdit"}`：这类「只为编辑态」的操作**不能回推**，
    否则宿主回灌 → `refresh()` 把刚打开的编辑框抹掉。`onOperation` 里已跳过 `beginEdit`。
  - 内核给 `#input-box` 的样式和节点几乎一样，已补虚线描边 + 光晕 + 选中高亮，
    一眼能看出在编辑。

## 文档 / 配置去哪看

- 本插件（上游）：<https://github.com/SSShooter/dsh-mindmap-live>
- 画布内核 MindElixir 文档：<https://docs.mind-elixir.com/>
  - 完整 options（`direction` / `toolBar` / `keypress` / `contextMenu` / `overflowHidden` …）：
    <https://docs.mind-elixir.com/docs/getting-started/quick-start>
  - 主题（`theme = { name, palette[], cssVar{} }` + `mind.changeTheme(theme)`）：
    <https://docs.mind-elixir.com/docs/guides/use-theme>
  - 节点数据结构（`topic` / `style` / `icons` / `tags` / `branchColor` …）：
    <https://docs.mind-elixir.com/docs/guides/node-data>
- 本仓库里主题与缩放的落点：`lib/client.js` 的 `DARK_CSS_OVERRIDES`、`themeFor()`、
  `THEME_MODE_KEY`；改调色板只动 `DARK_CSS_OVERRIDES` 里那几个 CSS 变量即可
  （`--bgcolor` 画布底色、`--main-bgcolor` 节点底色、`--root-bgcolor` 根节点、`--color` 文字、`--selected` 选中描边）。

**⑩ 节点标注（note，本仓库新增）**

长解释不塞进节点正文，单独挂在节点上（黄色便签，边写边存）：

- 节点右侧有一个黄色「注」标签，看到它就说明该节点有标注。
- **单击「注」= 直接在节点下方打开便签编辑**（没有二级弹窗）：黄色标题条写着节点名，下方就是正文，
  随打随存（停止输入 0.6 秒推给宿主），右下角状态点会从「保存中…」变「已保存」。
- 便签自身也是明暗两套皮肤，跟着导图主题走（`auto` 时跟系统）：浅色是奶油纸（`#FDFBF2`），
  深色是深灰卡（`#24242b`），标题条恒为黄，两种底色下都清晰。
- Esc 或点画布空白处关闭；便签会跟着节点走（拖动/缩放时实时定位）。
- 右键节点 → **标注** 是同一个入口，不用先去找那个标签。
- 数据落在该节点的 `note` 字段（`node.note`），随树一起同步：宿主 `repairNode` 与客户端
  `sanitizeNode` 都是展开拷贝，未知字段保留，`getDataString` 会把 nodeObj 上的自定义字段一起序列化。
- 因此 `mindmap_live_get` 读到的树里带 `note`，agent 改树时也必须原样带回来（工具描述规则 5）。
- 选中节点按 `C`（或右键「加入对话框」）引用时，插进输入框的文本是：

  ```
  【导图节点】<节点>
  （路径：根 › … › <节点>）
  标注：<note 原文>
  ```

  所以把节点拖进对话，AI 同时拿到位置和完整标注。

**⑪ 导图文件化 + 跨会话共享 + 导出需求（0.8.0）**

之前导图只存在于会话记录里（`record.rows.mindmap` 这条投影），所以**一个对话一张图，换会话就没了**。
0.8.0 把图挪进工作区，会话只记住"我在看哪张图"：

```
<workspace>/.dsh/mindmaps/
  roadmap.json              # { version, id, title, createdAt, updatedAt, tree }
  specs/路线图.md            # 由导图导出的需求文档
```

- **文件是真相源**，会话投影 `mindmap` 退化为渲染缓存。任何写入都是
  「临时文件 → rename 原子替换」，再 append 一条 record（`{tree, mapId}`）留下审计轨迹。
- **默认图**是 `roadmap`（标题「路线图」）。打开标签页时 `GET /mindmap/state` 会：
  1. 读会话绑定 / 默认 `roadmap`；2. 若工作区还没有这个文件、但会话里已有树 → **把旧树迁移落盘**（老对话自动升级）；
  3. 返回 `{mapId, title, workspace, updatedAt, tree, maps}`，`tree === null` 表示"这个工作区还没有图"，
     客户端据此显示空状态（「创建 / 导入」两个按钮），不会凭空造一张空图。
- **跨会话共享**：客户端每 6 秒 `GET /mindmap/state` 对比 `updatedAt`，发现文件比投影新就把文件
  append 回投影。`document.hidden` 或画布正在编辑（`#input-box` 存在）时跳过，不打断输入。
  因此同一工作区开两个会话，改一张图两边都会收敛。
- **一键导出需求**：头部工具条「📄 导出需求」→ `POST /mindmap/export`，把树按层级写成 markdown：
  顶层 `## 1`、下一层 `### 1.1`，节点的 `note` 变成正文段落（需求细节 / 验收标准），文件落在
  `<workspace>/.dsh/mindmaps/specs/<标题>.md`。只有根节点时导出一张带提示的骨架，不会报错。
- `mindmap_live_get` / `mindmap_live_set` 一并改成读写文件（`set` 多一个可选参数 `map`，默认工作区默认图），
  工具输出里带 `mapId` / `title` / `path`，agent 由此知道自己在改哪张图、文件在哪。
- mapId 只允许单段文件名（无路径分隔符、无控制字符、≤64 字符），`../etc/passwd` 这类一律拒绝。

**⑫ 多图管理（0.9.0）**

一个工作区不再只有一张图。工具条最左边是图选择器（`🗂 <图名> ▾`），菜单里能建、切、改名、删。

- 接口只有一个：`POST /mindmap/maps`，body `{ sessionId, action, mapId?, title? }`，
  `action` 取 `create` / `switch` / `rename` / `delete`。回复和 `/mindmap/state` 同形
  （`{ mapId, title, workspace, updatedAt, tree, maps }`），所以选中后画布和菜单用同一份数据重画。
- `create`：标题默认「新导图」，`mapId` 由标题 slug 化后取第一个空位（同名自动 `-2`、`-3`），
  根节点就是图名，自带「分支 1 / 分支 2」两个占位分支。
- `switch`：只改会话绑定（append 一条 `{tree, mapId}`），画布跟着投影换图。
- `rename`：只改 `title`，**`mapId`（即文件名）不动** —— 文件名是契约，改名不该让旧链接失效。
- `delete`：二次确认后才发请求。**最后一张图拒删**（`error.code === "last-map"`）：删掉它会让会话投影
  指向一个不存在的文件，下次读取又会把旧树迁移回磁盘，等于"删不掉还复活"。删的是当前绑定的图时，
  自动回落到最近编辑的那张并同步投影。
- 外部改文件也会进来：轮询比对到 `updatedAt` 变新就 append 回投影，所以用编辑器直接改
  `.dsh/mindmaps/<id>.json`，6 秒内画布会跟着变（实测）。

**⑬ 节点状态（0.10.0）**

想法 → 待办 → 进行中 → 完成 / 废弃。状态是节点上的一个字段，不是另一份清单。

- 数据：`node.state`，取值 `idea` / `todo` / `doing` / `done` / `dropped`。宿主侧有 `NODE_STATES`
  白名单，`repairNode` 会把非法值直接丢弃；合法值跟 `note` 一样躺在树里，随 map 文件落盘、随投影同步。
- 画布：带状态的节点左侧一个 8px 圆点（灰 / 蓝 / 橙 / 绿 / 红）。`done` 加删除线并淡到 68%，
  `dropped` 删除线 + 42%。工具条最右的五个小点是图例，悬停有说明。
- 快捷键：选中节点按 `1`-`5` 标记，`0` 清除。捕获在 window 上并拦掉默认行为，内核看不到这个键。
- 导出：`specs/<标题>.md` 的标题带 `✅` / `⛔` / `🚧` / `⬜`，完成与废弃的标题加删除线，
  文末追加 `状态分布：待办 3 / 进行中 1`。
- 回写：新工具 `mindmap_mark`，参数 `{ marks: [{ id, state }] }` —— 一次只改几个节点，不必重发整棵树
  （`state: null` 清除）。返回 `{ updated, missing, counts }`，agent 验收完一条打一条，画布 6 秒内跟上。

**⑭ 帮助面板 + 任务清单（0.11.0）**

工具条最右的 `? 帮助` 打开一张速查表：画布操作、节点状态快捷键、三个导出按钮、和 agent 怎么配合。

`📋 任务` 把带状态的节点导成两份文件，并把执行指令塞进剪贴板：

- `.dsh/mindmaps/tasks/<标题>.md` —— 按 `待办 / 进行中`、`已完成`、`想法` 分区，每条一行：
  `- [ ] **1.1 手机号登录** \`n2\``，节点标注以引用块缩在下面。
- `.dsh/mindmaps/tasks/<标题>.json` —— 同样内容加机器可读的 `id` / `state`，agent 打勾时从这里取节点 id。
- 剪贴板里的指令：`读 <path>，逐条实现；每完成一条，调用 mindmap_mark 把对应节点 id 标成 done……`

配合 workflow-lite 的 `mindmap-execute` 图：第一步按清单逐条做、做一条标一条，第二步拿
`specs/<标题>.md` 的标注当验收标准，没过的打回 `todo`。

**⑮ 布局条横排 + 工具条标注按钮（0.12.0）**

- 内核自带的布局切换条（`.mind-elixir-toolbar.lt`：左向 / 右向 / 双向）原本是竖排
  （`span{display:block}` + `margin-top`），本插件用 CSS 覆盖成一行（`display:flex` + `gap`），
  不碰内核 JS。
- 该条最右新增 **标注** 按钮（`span[data-dsh-mindmap-note]`，文档图标）：
  - 点击时取 `.me-tpc.selected` 的 `nodeObj`，打开与右键「标注」同一个浮层
    （`openNoteCard`）——同一个编辑器、同样自动保存、同样复制到需求文档；
  - 没有选中节点时只弹一条提示（`note.needSelect`），不新建标注；
  - 选中节点已有标注时按钮变主题色（`data-has-note="1"`），
    由 `linkDiv` / `selectNodes` / `unselectNodes` 三个事件同步。

## 安装 / 更新

源码在本目录，运行时装在 profile 里：

```bash
PROF=~/.dsh/profiles/desktop
cp -R . "$PROF/node_modules/dsh-mindmap-mine"
# package.json 依赖加 "dsh-mindmap-mine": "file:<本目录>"
# dsh.profile.bundles 里加 "dsh-mindmap-mine"
```

改完客户端代码必须 **View ▸ Reload**（⌘R 被 Electron 窗口吞掉）。

## 结构

- `lib/index.js` — 宿主半：注册 sessionProjections(`mindmap`)、`/mindmap` 前缀路由
  （`GET /mindmap/state`、`POST /mindmap/update`、`POST /mindmap/export`、`POST /mindmap/maps`）、
  工作区 `.dsh/mindmaps/` 的文件读写与迁移、`mindmap_live_get` / `mindmap_live_set` / `mindmap_mark` 三个工具。
- `lib/client.js` — 浏览器半（window.__ModuleLoader__ 单文件 bundle，内联 MindElixir）。
- `dsh.bundle.patch.yml` — 加入 profile 时自动 insert 的 loader 条目。

## 界面归属：DSH 右侧栏的标签页（0.7.7 起）

思维导图是**右侧栏（right dock）里的一个标签页**，不是插件自己画的浮层：

- 注册 `sidebarRightTabs.register({ id, kind: "mindmap", title, guide })`，再往
  `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 两个槽位注册组件，`key` 必须等于
  tab 类型的 `id`（宿主按 `definition.id` 派发 seat）。
- 入口两处：会话头部工具条 + 右侧栏标签页本身，都只做一件事 —— 需要时
  `ctx.sidebarRight.toggleExpanded()`，然后 `ctx.sidebarRight.openTab("mindmap")`。
  （侧边栏底部那个菜单项已按需求移除，0.8.0 起不再注册 `sidebar.footer.action`。）
- 关闭、收起、分栏、全屏、布局持久化全部由宿主负责。插件不再持有 `view` 状态，
  也不再往 localStorage 写视图模式 —— 这正是旧版「全屏后关不掉、重启还卡在那儿」的来源。
- 本插件只补一件事：宿主把全屏的快捷键绑在 ⌘⌥Enter 上，所以在**本标签页内**按 ESC
  会替用户按一下宿主自己的「退出全屏 / 回到分栏」按钮（`[data-sidebar-right-mode="push"]`）。
  画布正在编辑节点时 ESC 先交给 MindElixir 取消编辑，不会连带退出全屏。
- `MindMapBoundary` 把画布异常关在自己的格子里：MindElixir 抛错只会在标签页里显示
  `state.canvasError`，不会把整个 DSH 前端带下去。

## 会话日志里的记录格式（0.7.6 起）

导图不再往会话日志里写自定义事件类型 `mindmap/update`。harness 恢复会话时只承认
`KNOWN_SESSION_EVENT_TYPES` 里的类型，**或者** `ignorable: true` 且名字合 `plugin:` 语法的
记录；`mindmap/update` 两者都不满足，所以一旦日志里有它，重启后整条历史都会打不开
（`contains event type "mindmap/update" ... unknown to this harness and not marked ignorable`）。

现在统一走 harness 的插件记录 API：

```js
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";

appendPluginRecord(session, "plugin:dsh-mindmap-mine/map", { tree }); // 写入（自动 ignorable:true）

const record = pluginRecordOf(event); // 读取；非插件记录返回 undefined
```

读取端（投影 fold、`mindmap_live_get`）同时认旧类型 `mindmap/update`，所以按下面方法
修过的老会话照样能折出导图。修日志：把每条形如
`{"type":"mindmap/update","seq":N,"time":T,"data":{"tree":…}}` 的记录改成
`{"type":"plugin:dsh-mindmap-mine/map","seq":N,"time":T,"ignorable":true,"data":{"tree":…}}`
（其余事件与 seq 顺序一律不动），zstd 重新压缩后原子替换。

两个随包工具（`tools/`）：

```bash
# 改写会话日志里的旧事件（自动备份 .bak-mindmap-<时间戳>，改完自校验）
tools/repair-legacy-records.py ~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd

# 用 harness 自己的 v4 编解码器验证日志真的能恢复（需 Electron-as-node）
ELECTRON_RUN_AS_NODE=1 "/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT" \
  tools/restore-check.mjs <session.v4.jsonl.zstd> [...]
```

宿主半的改动（`lib/index.js`）不参与客户端热更。0.8.0 起不必重开应用，用 plugin_manager
把条目关掉再打开即可重载宿主半（实测 `GET /mindmap/state` 从 404 变 200）：

```
plugin_manager set_plugin target=include:dsh-mindmap-mine enabled=false
plugin_manager set_plugin target=include:dsh-mindmap-mine enabled=true
```

改完调用一次 View ▸ Reload 让浏览器半也重载。只有插件被彻底移除/换目录时才需要完全退出并重开。

## ⑯ 右键菜单：紧凑版面板

内核自带的右键菜单是「200px 宽 + 每行一条分隔线 + 34px 行高」，一开就盖掉画布三分之一。
现在改成小面板（纯 CSS 覆盖，不动内核 JS）：

- 宽度收到内容宽度（约 140px），行高 26–28px，`li` 由分隔线改为圆角 hover 药丸；
- 快捷键提示从「灰底深字贴片」改为淡描边小胶囊，默认 50% 透明、hover 提到 85%，不再抢视线；
- 只在语义分组处留分隔线：`#cm-fucus`（视图类）、`#cm-up`（排序类）、`li:nth-last-child(2)`
  （插件自己的「标注 / 加入对话框」始终是最后两行）；
- 面板本身：10px 圆角、1px 描边、柔和阴影 + 内高光、`backdrop-filter` 模糊、130ms 淡入。

实测尺寸（13 项的子节点菜单，Retina 截图 ÷2）：**194 × 420 → 154 × 340 CSS px**，
宽 -21%、高 -19%；根节点那种 7 项菜单更小（约 150 × 200）。
行内度量（`padding` / `font-size` / `line-height` / `min-height`）必须带 `!important`：
非 `!important` 时被内核后置的 `li`、`li span` 规则吃掉，行高只降到 30px 左右，
看起来「改了但没怎么变」。

写这几条时踩到的两个坑，后来人别重走：

1. **`color-mix()` 在这个渲染进程里会被算成 `unset`**。写成
   `background: rgba(...); background: color-mix(in srgb, var(--panel-color) 14%, transparent);`
   并不会回落到前一条 rgba —— 后一条在「计算值阶段」失效会把属性整个置回初始值，
   于是 hover 背景变透明、看起来像没生效。结论：这里只用 rgba 常量。
2. **改 `lib/client.js` 后 View ▸ Reload 不一定换上新代码**（模块 rev 没变时会取缓存）。
   验收一律用 **View ▸ Force Reload**；最稳的做法是顺手把 `package.json` 的 version 动一下，
   rev 必然变化。文档里「改完调用一次 View ▸ Reload」那句对宿主半（`lib/index.js`）成立，
   对客户端半（`lib/client.js`）要按这条来。

## ⑰ 交互三修：菜单可换节点、增删不卡、新增不抢视线

0.13.x 针对实际使用中暴露的三个问题：

1. **菜单开着也能直接右键别的节点**。内核的 `.context-menu` 是一个盖住整个画布的遮罩，
   不先把它点掉，右键就到不了节点。现在遮罩 `pointer-events: none`、只有 `.menu-list`
   收事件；关闭改由插件自己的 `document` 捕获监听负责（按下点不在菜单内就关），
   于是右键另一个节点 = 旧菜单关掉、新菜单位置跟着过去。
2. **节点多了增删不卡**。两处浪费：
   - 每次本地编辑都会被当成「外部变更」：宿主把树投影回来时键顺序与内核不同，
     `JSON.stringify` 比较永远不等 → 每次都 `refresh()` 全量重建 + `toCenter()`。
     现在改用 `treeSignature()`（内容相关的签名，与键序无关）判定是不是自己刚推上去的那棵，
     是就跳过整棵重建。
   - `layout()` 每次都会触发 `linkDiv`，而它在一次增删里要跑三遍（分支着色 / 状态点 / 标注徽标
     三次全表扫描 + 逐节点 style 写入）。现在合并到一帧（`requestAnimationFrame`）执行一次，
     且给每个节点打 `data-dsh-mm-tint / -sub / -painted` 记忆标记，值没变就整节点跳过。
3. **新增节点不再把视角拉回中央**。`addChild/insertSibling/insertParent` 末尾的
   `selectNode() → scrollIntoView()` 会把画布平移到新节点居中；投影回流时的 `toCenter()`
   再补一刀，导致「刚加完就被甩走、新节点还失去选中」。现在：
   - 插入类操作后 500ms 内不调用原生 `scrollIntoView`，只在**新节点会完全落在视野外**时
     补足必需的最小位移（`mind.move(dx, dy)`，不缩放、不居中）；
   - 投影刷新不再调用 `toCenter()`，改为记录并还原 `.map-canvas` 的 transform 与容器 scroll，
     并按 id 重新选中原节点。

注意（自测教训）：投影里出现的 `el is not defined` 会让整块画布崩成「画布渲染失败」——
在 `useLayoutEffect` 里用 `containerRef.current` 必须就地取。手动改 `.dsh/mindmaps/*.json`
清测试节点时也别用带副作用的一行式过滤，先把备份留在 /tmp 再动手。

## ⑱ 删除与 ⌘Z 卡 1 秒：把内核 linkDiv 的强制重排消掉

现象：删一个节点、或按 ⌘Z 撤销，卡一两秒才看到变化（增删越多越明显）。

定位（临时 `[dsh-mm-perf]` 探针，用 `console.error` 才能落盘）：

| 环节 | 耗时 |
|---|---|
| `getData()` / 宿主推送同步段 | 0.1–0.3ms（无关） |
| 我们的 `runDecorate`（合并 + 记忆标记后） | 0.1ms（无关） |
| 内核 `linkDiv`（连线重绘） | **1036–1079ms** ← 全部在这里 |
| 同一时刻 `addChild` / `removeNodes` / `refresh` | 279 / 1054 / 1053ms |

`linkDiv` 是 `Rt`（`lib/client.js:1403`）：清空 `.lines` 后遍历 `.me-main > .me-wrapper`，
对每个节点走一遍 `_()` —— 它沿 `offsetParent` 累加 `offsetLeft/offsetTop`，**每一步都是一次
强制布局**；再追加主干 `<path>` 与子连线 `<svg>`。87 个节点 ≈ 87 次强制重排 + 数百次 SVG 追加。

关键实验：把这些几何量（`offsetTop/offsetLeft/offsetWidth/offsetHeight/offsetParent`）
在执行前读一遍并 `Object.defineProperty` 挂成自有属性（结束后 `delete` 还原），
`linkDiv` 内部所有读取就命中缓存、不再触发布局 —— **1079ms → <20ms**；
`addChild` 279ms → 30ms，`removeNodes` 1054ms → <20ms，⌘Z 撤销 1053ms → 约 100ms（其中
65ms 是重画后的一次全树装饰）。

配套的三件事（0.13.5–0.14.0）：

1. `linkDiv` 换成延迟合并版（120ms 内多次调用只跑一次，区分 full / only）；
2. 推送合并 400ms（删除→撤销这种连击只落库一次），并在 teardown / window blur /
   `visibilitychange` 时立即 flush，内容签名没变就不推；
3. `runDecorate` 合并到一帧，并给节点打 `data-dsh-mm-tint/-sub/-painted` 记忆标记。

缓存必须覆盖 `mind.nodes` 的全部后代：只缓存 `.me-main/.me-wrapper/.me-tpc` 时，
`offsetParent` 链会经过 `.lhs/.rhs` 等未缓存元素，仍然逐节点触发布局（实测仍是 1070ms）。
另外 `mind.generateMainBranch` 是 `changeTheme` 时才挂到实例上的，
在 `bind()` 里读不到 —— 想在外部包装它，得在绘制时用 `mind.generateMainBranch` 取。

## ⑲ 画布背景：淡淡的方格纸

空白画布原来是一块纯色，看着单调。现在铺一层 24px 的方格（1px 线，深浅主题各一档透明度：
深色 `rgba(255,255,255,.07)`、浅色 `rgba(0,0,0,.055)`）。

实现是一段纯 CSS，挂在**被 `transform` 的那一层**上，所以缩放会跟着放大缩小、平移也不会和节点错位：

```css
.map-container .map-canvas::before {
  content: "";
  position: absolute;
  inset: -1200px;                 /* 覆盖内容四周一大片，避免拖到边缘露出空白 */
  z-index: 0;
  pointer-events: none;
  background-image:
    linear-gradient(to right, var(--dsh-mm-grid-color) 1px, transparent 1px),
    linear-gradient(to bottom, var(--dsh-mm-grid-color) 1px, transparent 1px);
  background-size: 24px 24px;
}
.map-container .map-canvas .me-nodes { position: relative; z-index: 1; }
```

主题色由容器上的 `data-dsh-mm-scheme="dark|light"` 切。

走过的弯路：第一版把网格画在容器上、用 JS 每帧把画布 transform / 容器 scroll 同步成
`background-position`。问题是这个画布的「平移」有两个来源（`transform` 的 translate 与容器的
`scrollLeft/Top`），漏一个就漂；实测拖动后网格和内容错开。改成挂在内层被变换的元素上，
对齐由 CSS 结构本身保证，一行 JS 都不需要。

## ⑳ 默认缩放 75%

打开地图时按 75% 显示（原来是内核按内容 fit 出来的比例，内容多时会被压到 60%–80% 之间）。

- `DEFAULT_ZOOM = 0.75`，在 `mind.init()` resolve 之后先 `mind.scale(0.75)` 再 `mind.toCenter()`；
- 用户之后用 `+ / −`、滚轮改过缩放，就把最新比例记进 `zoomRef`；因为内核 `refresh()`
  会重算 fit 比例，所以 `refresh` 被包了一层：跑完原逻辑后若当前比例和 `zoomRef` 不一致，
  就按 `zoomRef` 恢复（用 `applyingZoomRef` 防止自己触发自己）。
  这样「删一个节点 / ⌘Z 撤销」不会把用户手调的缩放弹回默认值。

实测：重载后网格单元 18 CSS px = 24 × 0.75 → 确认为 75%；增删 + ⌘Z 之后仍是 0.75；
用 `+` 放大到约 0.96 后再增删撤销，仍保持 0.96。

## ㉑ 工具条：聚焦开关 + 整排可点态

左上那排现在是 5 个按钮：**左向 / 右向 / 双向（内核自带）｜分隔线｜标注｜聚焦（眼睛）**。

- **聚焦**：选中任意非根节点后点眼睛 → 只显示该节点这一支（走内核 `mind.focusNode`）；
  再点一次 → `mind.cancelFocus()` 回到全图。没选中节点时点它给一条 toast
  「先选中一个节点再聚焦」，根节点不弹焦点（内核要求有 parent）。
- **活跃态**：进入聚焦后按钮底色变蓝、图标变亮蓝（`rgba(88,166,255,.22)` + `#79b8ff`），
  tooltip 同时从「聚焦（选中节点）」变成「退出聚焦」。状态同步挂在 `linkDiv` 事件上，
  所以从**右键菜单**里进出聚焦，按钮颜色也会跟着变。
- **整排可点态**：5 个按钮统一 26px 见方、6px 圆角、`cursor:pointer`，
  hover 一层浅灰 `rgba(127,127,127,.2)`、按下更深 `.34`、键盘聚焦有描边；
  每个按钮都有 `title` / `aria-label`（左向布局 / 右向布局 / 双向布局 / 标注（选中节点） / 聚焦），
  鼠标悬停即显示名字。

坑：活跃态一开始写成 CSS 规则
`.mind-elixir-toolbar.lt > span[data-active="1"] { background: … }`，属性设上了、tooltip 也变了，
但底色死活不出现（原因没查到底，疑似该渲染进程里这条组合选择器的属性没被采用）。
改成 `syncFocusTool()` 里直接写 `button.style.background / color` 内联样式，立刻生效。

## ㉒ 拖动排序 · 快捷键 · 精简菜单 · 任务抽屉

**1. 拖动排序**：内核拖动只有「拖进节点 = 变成子节点」这一种结果（`moveNodesIn`），
拖到同一层相邻两节点之间也总是变成子节点，所以没法排序。现在把 `moveNodesIn` 包了一层：
落点在目标框的**上 28%** → `moveNodesBefore`、**下 28%** → `moveNodesAfter`、中间 44% 才是变子节点。
向下布局（`direction: 3`，兄弟横向排）时改判左右。指针位置由插件自己在 `pointermove` 里记录
（内核的拖拽 helper 不暴露落点）。
注意：内核的撤销栈不记录 `moveNodes*`，**拖动排序不能用 ⌘Z 撤销**，拖错了要拖回去。

**2. 快捷键**（按桌面软件习惯）：`⌘⇧N`（Windows/Linux 上 `Ctrl+Shift+N`）= 标注、
`⌘⇧F` = 聚焦 / 退出聚焦。监听挂在 document 捕获阶段，命中后 `stopPropagation`，
不会漏给宿主。没选中节点时给 toast；聚焦态再按一次退出。工具条 tooltip 里同步写了按键。

**3. 右键菜单去掉「上移 / 下移」**：CSS 直接 `display: none`（`#cm-up` / `#cm-down`），
键盘 `PgUp` / `PgDn` 仍然可用。分组线从 `#cm-up` 挪到 `#cm-summary`，菜单变成
「结构 ｜ 聚焦 ｜ 连线 ｜ 标注/对话」四段。

**4. 任务抽屉**：顶栏「📋 任务」不再直接导出，而是从画布右侧滑出 300px 抽屉，
按状态分组列出所有带状态的节点（待办 → 进行 → 想法 → 完成 → 废弃），
每行显示状态色条、节点标题（最多两行）、以及两级父级路径；点一行会选中并把该节点滚进视野；
底部「导出清单 · 复制指令」沿用原来的 `/mindmap/tasks` 流程。抽屉状态在插件内用一个小总线
（`taskDrawer`）在顶栏按钮和画布之间共享，不经过宿主。
