# dsh-mindmap-mine

自用魔改版 DSH 思维导图插件。基于 [SSShooter/dsh-mindmap-live](https://github.com/SSShooter/dsh-mindmap-live) 0.5.0（MIT），
按 DSH NEXT 0.2.2 的槽语义重写客户端，并把入口加到了会话顶部工具栏。

## 相对上游的改动

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
- **单击「注」= 直接在节点下方打开便签编辑**（没有二级弹窗）：黄色标题条（序号 + 节点名）、
  下方就是正文，随打随存（停止输入 0.6 秒推给宿主），右下角状态点会从「保存中…」变「已保存」。
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

- `lib/index.js` — 宿主半：注册 sessionProjections(`mindmap`)、`POST /mindmap/update` 路由、
  `mindmap_live_get` / `mindmap_live_set` 两个工具。
- `lib/client.js` — 浏览器半（window.__ModuleLoader__ 单文件 bundle，内联 MindElixir）。
- `dsh.bundle.patch.yml` — 加入 profile 时自动 insert 的 loader 条目。
