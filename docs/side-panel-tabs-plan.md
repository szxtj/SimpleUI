# 侧边面板重构方案 · 主窗口多标签 / 浮窗单页

> **主窗口**：把右侧 440px 的「知识库面板」从一个**内部三态机**（empty / results / article），
> 改成**一条标签栏 + 若干互相独立的页面**：知识库搜索、条目阅读、引用原文、发送的图片、回答原文都是标签。
> 谁都不再覆盖谁，点开就留在那儿。
>
> **Spotlight 浮窗**：**不做标签栏**，改成**单页导航**（一页盖满整卡 + 返回栈）。页面组件与主窗口共用，
> 导航与状态完全独立，杜绝大小窗口互切时的状态串味。

**已定决策**：① 主窗口面板左沿**可拖拽改宽**（440 起，持久化）；② `+` **复用单例**搜索页；
③ 关掉最后一个标签 → 面板收起并清空；④ 条目顶部加一颗「参考文本 ↓」跳转；
⑤ 浮窗**独立实现**：没有标签栏、没有侧边栏，只有「搜/条目/原文/图片」四种整页浏览。

---

## 一、现状取证（改之前先确认代码到底怎么长的）

### 1.1 相关文件与真实职责

| 文件 | 现状职责 | 关键事实 |
| :--- | :--- | :--- |
| `src/components/Sidebar.tsx` | 左栏 260px 会话列表 + 服务状态行 | 与本次无关，**不动** |
| `src/components/ChatView.tsx` | 顶栏 52px：左=展开侧栏+模型选择；右=`PanelRightOpen`(知识库面板) + `Minimize2`(缩至浮窗) | 面板开着时把 `PanelRightOpen` 整颗隐藏；DeepSeek 下置灰不可点 |
| `src/components/WikiSidebar.tsx` | 右侧停靠容器，只透传 | 薄壳；由 `SidePanel` 取代 |
| `src/components/WikiPanel.tsx` | **唯一实现**：`mode: empty\|results\|article` + 搜索栏 + 注入原文块 + 全文渲染 | 同一时刻只能显示一件事；注入块在 Body **顶部**；`kbReady = wikiEnabled && wikiConnected`，不可用时搜索栏整条不渲染、也不发请求 |
| `src/components/WikiDrawer.tsx` | Spotlight 的覆盖型容器 | 与主窗口共用 `WikiPanel`（variant=overlay） |
| `src/components/WikiContextView.tsx` | 条目行式文本 → 原生 React 版式 | 无状态，可直接复用 |
| `src/components/MessageItem.tsx` | 引用胶囊 → `onOpenWiki`；`FileText` → 内部弹 `RawMarkdownModal`；图片 → 内部弹 `ImagePreviewModal` | 两个弹窗的开关**在组件内部**（`useState`），外部管不到 |
| `src/components/RawMarkdownModal.tsx` | 672/450px 居中弹窗，复制全部 + 字符/行数 | 自带 Esc 捕获 |
| `src/components/ImagePreviewModal.tsx` | 全屏预览：缩放/拖拽/橡皮筋/画廊/复制/下载（约 800 行） | 主窗口唯一的大图入口 |
| `src/components/SpotlightView.tsx` | 自己写了一份消息渲染（**不用** `MessageItem`）；`WikiDrawer` + 两个 modal；`notifyResize` 驱动原生面板尺寸 | 胶囊 540×88 / 展开 500×640；闲置重置会把面板缩回胶囊 |
| `src/components/ChatInput.tsx` | 输入区 `BookOpen` 知识库开关 | DeepSeek 下 `disabled` 但**仍在**（40% 透明） |
| `src/App.tsx` | `isWikiPanelOpen` 单布尔；`activeWikiArticle/Context` 单槽位；DeepSeek 自动关闭面板 | 面板内容只有一个槽，后开的顶掉先开的 |
| `mac_app/src/MainWindowController.swift` | `TitleBarDragView.hitTest` 把面板区当拖拽区（只放行最右 80px）；`updateWindowMinSize` +440 | 标签栏要能点 → 必须改 hitTest |

### 1.2 现有实现的四个结构性局限

1. **单槽位**：面板只能持有一件事。看条目时点一张图 → 图片 modal 盖满全窗口 → 关掉后回到条目，但想法已经丢了。
2. **modal 与面板互斥**：原始文本 / 图片都是「临时浮层」，不是「可以并排留着的东西」。
3. **入口被掐掉**：DeepSeek 模式下面板 toggle `disabled`，服务未开启/无 ZIM 时搜索栏直接不渲染——用户连"为什么不能看"都看不到。
4. **注入原文在上**：`WikiPanel` 注释写明"注入原文块已上移到 Body 顶部"（`4deed9b`）；现要求放下侧。

---

## 二、主窗口：目标信息架构

### 2.1 标签即页面（四种 kind）

| kind | 图标 | 标签标题 | **去重键（id）** | 打开入口 | 重复点击行为 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `wiki-search` | `Search` | 「知识库搜索」/ 有查询时「搜索：xxx」 | `wiki:search`（全局单例） | 标签栏 `+`、面板 toggle（无标签时） | 激活已有页，不新建 |
| `wiki-article` | `BookOpen` | 条目名 | `wiki:article:<title>` | 引用胶囊、搜索结果行 | 激活已有页；**不覆盖**已有注入文本 |
| `raw-text` | `FileText` | 「原文」+ 字数 | `raw:<messageId>` | 回答底部 `FileText` 按钮 | 激活已有页，内容快照不重建 |
| `image` | `Image` | 「图片 2/3」 | `img:<messageId>`（按消息做画廊） | 用户气泡里的图片 | 激活已有页并把 index 切到点的那张 |

> `wiki-article` 以**条目名**为键：同一胶囊重复点 = 同一页；同名条目从搜索进 / 从胶囊进也合并（注入文本取已有那份，避免把有上下文的页降级成无上下文）。

### 2.2 页面内部状态归属

| 状态 | 归属 | 理由 |
| :--- | :--- | :--- |
| `tabs[]` / `activeId` / `visible` | `usePanelTabs`（App 层） | 唯一权威 |
| 搜索框文字 / 结果列表 / 滚动位置 | `WikiSearchPage` 内部 | 页面不卸载 → 天然保留 |
| 全文内容 / 加载态 | `WikiArticlePage` 内部 + **模块级** `Map<title, string>` 缓存 | 同一条目多标签不重复拉 |
| 图片 index / 缩放 | `ImagePage` 内部 | 点开时传入初始 index |
| 原文快照 | 打开时写进 tab 对象 | 消息被删/重试也不悬空 |

> 模块级缓存**不是跨窗口共享**：主窗口与浮窗是两个独立 WKWebView（各自 JS 运行时），模块级 Map 天然各存一份。

### 2.3 面板可见性

- `visible = isPanelOpen && tabs.length > 0`。
- 关闭最后一个标签 → 面板自动收起、列表清空（浏览器语义）。
- 面板 toggle：`tabs.length === 0` → 新建搜索页并展开；否则只切可见性（**保留原激活项**）。
- 标签**不随会话切换**变化（页面自持快照，看的是"当时那份"，不是"当前会话的"）。

---

## 三、主窗口：交互规范

| 交互 | 行为 |
| :--- | :--- |
| `+` | 复用单例搜索页（已有则激活）。**不**开第二个搜索页——知识库只有一个，两个搜索页无用 |
| 点击标签 | 激活；自动 `scrollIntoView({ inline: 'nearest' })` |
| 标签 `✕` / 中键 | 关闭；激活右邻 → 无右邻取左邻；关完则面板收起 |
| 标签溢出 | 标签区 `overflow-x-auto` + 隐藏滚动条（复用 `.scrollbar-invisible`）；`+` 与收起按钮**固定在最右**，永不被滚走 |
| 面板收起按钮 | 标签栏最右 `PanelRightClose`（原面板头部那颗，语义不变） |
| 缩至浮窗 `Minimize2` | **留在 ChatView 顶栏**，不进标签栏 |
| 放大（参考图的 ⤢） | 不做 |
| DeepSeek 模式 | 入口全活；`kbReady` 强制 false → 搜索页/条目页显示"未连接"统一提示；输入区 `BookOpen` 按钮**整颗移除** |
| 服务未开启 / 无 ZIM | 同上：页面照开、提示照显、**不发任何请求** |
| Esc | 关闭当前标签（面板有焦点且无 modal 时）— P4 |

---

## 四、共享层与文件改动

### 4.1 共享的是「页面」，不是「标签」

| 层 | 共享 | 独立 |
| :--- | :--- | :--- |
| 页面组件 | `WikiSearchPage` / `WikiArticlePage` / `RawTextPage` / `ImagePage` / `WikiContextView` / `KbUnavailable` | — |
| 导航模型 | — | 主窗口：标签列表；浮窗：单页栈 |
| 运行时状态 | — | 各自 `useState`；**不共享 store、不共享 localStorage 键** |
| 原生桥 | — | 主窗口：`setWikiPanelOpen` / `setPanelWidth`；浮窗：`resizePanel` |

页面组件接受一个可选 `chrome?: { leading?: ReactNode; trailing?: ReactNode }`：
主窗口不传（上面就是标签栏），浮窗传 `←` 与 `✕`。这样两窗口都只有**一层页头**，不会出现 44+44 两层。

### 4.2 新增

| 文件 | 行数级 | 内容 |
| :--- | :--- | :--- |
| `src/types/panel.ts` | ~70 | `PanelTab` 判别联合、`SpotlightPage` 联合、id 构造函数 |
| `src/hooks/usePanelTabs.ts` | ~150 | tabs/activeId/visible + open/close/activate/toggle + 去重 |
| `src/hooks/usePanelWidth.ts` | ~70 | 宽度拖拽（pointer capture）+ localStorage 持久化 + 通知原生 |
| `src/hooks/useSpotlightPage.ts` | ~80 | 页面栈 push/pop/clear + 栈顶同页去重 + 上限 6 |
| `src/components/SidePanel.tsx` | ~140 | 容器：标签栏 + `hidden` 切换的页面栈（keep-mounted）+ 左沿把手 |
| `src/components/PanelTabStrip.tsx` | ~150 | 标签条、`+`、收起按钮、横向滚动、中键关闭 |
| `src/components/SpotlightPageLayer.tsx` | ~110 | 浮窗整页层：盖满卡片、`←`/`✕`、Esc、渲染栈顶页面 |
| `src/components/pages/WikiSearchPage.tsx` | ~160 | 搜索输入（IME 绑定）+ 结果列表 + 不可用提示 + `chrome` |
| `src/components/pages/WikiArticlePage.tsx` | ~170 | 拉全文（模块级缓存）+ 条目正文 + **底部**参考文本块 + `参考文本 ↓` |
| `src/components/pages/RawTextPage.tsx` | ~90 | 等宽正文 + 字符/行数 + 复制全部 |
| `src/components/pages/ImagePage.tsx` | ~140 | 适应/1:1、滚轮平移、`在预览中打开`（原生桥）、画廊前后 |
| `src/components/KbUnavailable.tsx` | ~30 | 抽出现有"未连接"提示，两窗口共用一份 |

### 4.3 改动

| 文件 | 改什么 |
| :--- | :--- |
| `ChatView.tsx` | `wikiPanelOpen` → `isPanelOpen`；`PanelRightOpen` 取消 DeepSeek 置灰（变成纯开关）；透传 `onOpenRawText` / `onOpenImage` |
| `MessageItem.tsx` | 新增可选 `onOpenRawText` / `onOpenImage`；**有回调走标签页，无回调退回原 modal**（见下方说明） |
| `ChatInput.tsx` | 知识库按钮：`wikiEnabled && !isDeepSeek` |
| `SpotlightView.tsx` | 删 `WikiDrawer` / `RawMarkdownModal` / `ImagePreviewModal` 三处挂载；新增 `useSpotlightPage` + `<SpotlightPageLayer>`；`initEmptySession` 与会话切换时清空页面栈 |
| `App.tsx` | 接 `usePanelTabs`；删掉「DeepSeek 自动关闭面板」effect；`kbReady` 加 `!isDeepSeek`；`Sidebar`→`SidePanel` |
| `i18n/translations.ts` | 新增约 12 个键（zh/en 同步）：`panelTabSearch`、`panelTabRaw`、`panelTabImage`、`panelNewTab`、`panelCloseTab`、`panelBack`、`rawCharsLines`、`imageZoomFit`、`imageZoomActual`、`openInPreview`、`panelJumpToInjected`、`panelResizeHint` |
| `MainWindowController.swift` | ① `hitTest`：`x >= chatRight` 整块 `return nil`（标签栏全可点）；② 面板宽度改由 `TitleBarDragView` 属性承载；③ 新增 `setPanelWidth` handler；④ `updateWindowMinSize` 用实际宽度 |

### 4.4 删除

- `src/components/WikiPanel.tsx`、`WikiDrawer.tsx`、`WikiSidebar.tsx`（三者的职责被"页面 + 两个容器"取代）。

### 4.5 保留

- `RawMarkdownModal` / `ImagePreviewModal`：`ChatInput`（草稿图预览）与 `MarkdownRenderer`（正文配图）仍在用，**不删**。

### 4.6 关于「无回调就退回旧弹窗」这条兜底

图片大图与 MD 原文这两个窗口，现在是**一条消息的组件自己弹的**（开关写在 `MessageItem` 内部 `useState`）。
改成"交给右侧面板开标签页"，等于把这个开关从组件里搬到外面。搬出去的风险是：**哪一层忘了把口子接上，
点按钮会什么都不发生**（不报错、不提示），属于最难查的一类问题。

所以 `MessageItem` 的写法是：

```tsx
onClick={() => (onOpenRawText ? onOpenRawText({...}) : setShowRawModal(true))}
```

漏接一处也只是"还没升级成标签页"，退化成老弹窗，**不会点了没反应**。这是 3 行防御，不是额外复杂度。
（Spotlight 不用 `MessageItem`，它自己写了一份渲染，所以这条兜底只保护主窗口。）

---

## 五、视觉规格（主窗口）

| 项 | 值 |
| :--- | :--- |
| 标签栏高 | 52px（与 ChatView 顶栏**同高同底边**，两栏分隔线连成一条） |
| 标签 pill | 高 28–30，`px-2`，`gap-1.5`，圆角 8，`max-w-[160px]`，图标 13px + 文字 12px truncate |
| 激活态（暗） | `bg-[#2a2c33]` + `border-white/[0.06]` + 文字 `#f1f3f7` |
| 激活态（亮） | `bg-white` + `border-black/[0.06]` + 文字 `#1f2328` |
| 未激活 | 透明底，文字 `zinc-500/400`，`hover:bg-black/5 dark:hover:bg-white/5` |
| 关闭 ✕ | 12px，仅激活或悬停时 100% 不透明，否则 40% |
| `+` / 收起 | 26×26 圆角 8，hover 底色；两者间隔 4px |
| 页面体 | `flex-1 min-h-0 overflow-y-auto`，每页自己滚；非激活页 `display:none`（DOM 保留 → 状态与滚动位置都在） |

### 5.1 左沿拖拽把手

| 项 | 规格 |
| :--- | :--- |
| 轨道 | 面板左侧 `absolute left-0 inset-y-0 w-[6px]`，`cursor: col-resize`，默认透明，悬停/拖拽时 `bg-emerald-500/25` |
| 起止 | 起点 440；`min = 360`；`max = clamp(window.innerWidth - 460, 360, 820)` |
| 拖拽中 | 只改 CSS `width`（`transition-none`）；`setPointerCapture` 挂在手柄自身（手柄不卸载） |
| 松手 | 写 `localStorage['simpleui_side_panel_width']` + `setPanelWidth` 消息 → 原生更新 `minSize` |
| 收起/展开 | 仅可见性切换走 200ms 过渡；宽度变化**不加过渡** |
| 双击把手 | 复位 440 |

> 原生侧两个 440 常量（`hitTest` 的 `wikiPanelWidth`、`updateWindowMinSize` 的 `wikiWidth`）必须读同一份动态值，
> 否则窗口最小宽度会和真实面板宽度脱节。

---

## 六、「参考文本」下移（明确要求）

`WikiArticlePage` 正文顺序改为：

```
[条目标题 + 参考文本 ↓ + 外部打开]
[完整条目内容]        ← WikiContextView
───────────
[本次传给模型的参考文本]  ← 纯文本 pre，胶囊来源时才有
```

条目再长注入块也会被当成"没显示"，所以标题行加一颗极小的 `参考文本 ↓`（`scrollIntoView`），
不改变上下顺序。**已采纳，随 P0 一起做。** 两窗口共用同一个页面组件，顺序一次生效。

---

## 七、Spotlight 浮窗：单页导航（独立实现）

### 7.1 为什么不做标签栏

1. **宽度不够**：浮窗展开只有 500px，标签栏一放，每个标签只剩 ~80px，标题全被截断，标签栏的价值归零。
2. **语义不同**：浮窗是"临时看一眼就回去"，单页 + 返回 比多标签更贴。
3. **零共享状态**：两个窗口是两个 WKWebView / 两个 JS 运行时。只要共享一个 store 或一个 localStorage 键，
   就有了"切窗口互相覆盖"的通道；单页导航用各自本地 state，**没有任何共享可变状态**，这条通道直接不存在。

### 7.2 页面模型

```ts
type SpotlightPage =
  | { kind: 'wiki-search' }
  | { kind: 'wiki-article'; title: string; injected?: string | null }
  | { kind: 'raw-text'; title: string; content: string }
  | { kind: 'image'; images: string[]; index: number };
```

- `pageStack: SpotlightPage[]`，**只渲染栈顶**（浮窗只有一个页面，不需要 keep-mounted）。
- 入口四处：搜索按钮（胶囊态 + 展开态各一颗）、引用胶囊、图片、原文按钮。
- push 前先比对栈顶：`kind` 与去重键相同则**不重复压栈**（同一胶囊/同一图片连点不会堆出两层）。
- `←` 或 Esc → pop；栈空即关闭页面回到对话。`✕` → 清空栈。
- 栈深上限 6，超出丢最早的一层。

### 7.3 安全阀（防"切窗口/闲置重置"错位）

| 场景 | 必须做的事 | 不做的后果 |
| :--- | :--- | :--- |
| `initEmptySession()`（新建对话、15 分钟闲置重置） | 清空页面栈 | 面板被缩回 540×88，页面仍按 640 高渲染 → 内容被裁、按钮错位 |
| `currentSessionId` 变化（含主窗口 handoff 过来） | 清空页面栈 | 用户以为在看新会话，其实被一篇维基条目盖着 |
| 在胶囊态点搜索按钮 | 先 `notifyResize(true)` 再压栈 | 页面塞进 88px 高的小窗 |
| 任何页面交互 | **不写** `localStorage`（除既有 `tff_spotlight_last_active_v1`） | 与主窗口面板宽度键互串 |

### 7.4 页面外观

整层盖满浮窗卡片（`absolute inset-0`、`rounded-[22px]`、与卡片同色同描边、`overflow-hidden`），
页头只有一行：`←` + 图标 + 标题 + `✕`。不再有半透明遮罩 + 居中弹窗（旧 `450×520` 那套），
图片与原文都是**整页**，滚动/缩放都在页面内完成。

---

## 八、分阶段实施（每阶段结束都能 build + 装包自测）

| 阶段 | 内容 | 验收 |
| :--- | :--- | :--- |
| **P0** | 共享页面（`WikiSearchPage` / `WikiArticlePage` / `KbUnavailable` + `chrome` 槽）+ `types/panel.ts` + `usePanelTabs` + `SidePanel` + `PanelTabStrip`；`+`/胶囊接入；注入块下移 + `参考文本 ↓`；删 `WikiSidebar` | 开 2 个条目 + 1 个搜索互不覆盖；重复点胶囊不新增；面板 toggle 正常 |
| **P1** | `RawTextPage` + `ImagePage`；`MessageItem` 回调化（带旧弹窗兜底） | 点原文/图片各开一个标签，重复点不新增；"在预览中打开"生效 |
| **P2** | DeepSeek 语义（`kbReady` 含 `!isDeepSeek`、删自动关闭、输入区按钮移除）+ 原生 `hitTest` + 左沿宽度拖拽 | DeepSeek 下能开面板看未连接提示；标签栏每颗能点；拖把手宽度实时变、重启保留 |
| **P3** | 浮窗：`useSpotlightPage` + `SpotlightPageLayer`；删 `WikiDrawer` 与两处 modal 挂载；接 4 个入口 + 三个安全阀 | 浮窗页面占满整卡、单层页头；返回栈正确；闲置重置清页并缩回胶囊 |
| **P4** | 打磨：中键关闭、激活滚动、标签上限（>8 卸最久未激活正文）、Esc 关标签 | 目测 + 断言 |

---

## 九、风险与权衡

| 风险 | 影响 | 处置 |
| :--- | :--- | :--- |
| 多标签 keep-mounted 的 DOM 体积 | 条目页可能上万节点，8 个标签明显吃内存 | P4 加上限；先实测再定阈值 |
| 浮窗整页盖住卡片头部 | 少了"关整个浮窗"的一步 | 页面 `✕` 回对话 → 再用卡片自带 `✕`；`Esc` 逐级返回 |
| 浮窗闲置重置与页面栈竞争 | 88px 窗口里塞 640 高页面 | `initEmptySession` 里先清栈，再 `notifyResize(false)`（顺序不能反） |
| 原生 hitTest 与标签栏冲突 | 标签点不动 / 顶栏变拖拽 | 面板区整块穿透；`setWikiPanelOpen` 语义保持"面板可见" |
| 面板宽度与原生 minSize 脱节 | 窗口能缩到比面板还窄 | 宽度变更统一走 `setPanelWidth`，`hitTest` 与 `minSize` 读同一属性 |
| 会话删除后标签残留 | 无悬空引用（都是快照） | 不主动关闭；用户自己关 |

---

## 十、验证方案

用 `simpleui-ui-headless-verify` 的 CDP 闭环，新建 `scripts/verify_side_panel.mjs`（`MODE=main|spotlight`）。

**主窗口**

1. 标签栏高 = 52，与 ChatView 顶栏底边齐平；4 个标签时可横滚、`+`/收起仍在视口内。
2. `+` 连点 2 次 → 标签数 +1。
3. 同一胶囊点 2 次 → 标签数不变，激活项不变。
4. 条目页：正文在 `wikiInjectedLabel` 之前（`compareDocumentPosition`）；点 `参考文本 ↓` 后注入块进入视口。
5. 两个不同胶囊 → 两个标签，来回切不丢滚动位置。
6. `FileText` 连点 → 1 个 `raw:` 标签，内容与消息 `content` 全等。
7. 图片连点 → 1 个 `img:` 标签，`naturalWidth > 0`。
8. 关激活标签 → 右邻激活；关完 → 面板收起、`setWikiPanelOpen` 收到 false。
9. 拖把手 → 宽度变化 + localStorage 正确 + `setPanelWidth` 被调用；双击复位 440。
10. DeepSeek：输入区无 `BookOpen`；面板内出现 `wikiPanelServiceOff/NotReady`，无 `/api/wiki` 请求。

**浮窗（500×640）**

11. 点搜索 → 页面盖满整卡，**只有一层页头**（不存在两个 ✕）；无居中弹窗、无遮罩。
12. 搜索结果点条目 → 条目页；`←` 回到结果页且查询/结果仍在。
13. 同一胶囊点 2 次 → 栈深不变（`data-page-depth` 断言）。
14. 点图片 / 原文 → 整页；`Esc` 逐级返回，栈空回对话。
15. 伪造 `tff_spotlight_last_active_v1` 触发闲置重置 → 页面清空 + 窗口回 540×88。
16. 主窗口开 5 个标签 → 缩至浮窗 → 浮窗无标签栏、页面为独立空白；展开回主窗口，标签仍在。

**公共**：暗/亮两套截图人眼复核；`mv dist/assets /tmp` → `npm run build` → `./build_mac_app.sh install` → 重启实测。
原生侧（minSize 跟随、拖拽区）无法在无头环境断言，装包后手动确认。

---

## 十一、决策记录

| # | 决策 | 落地位置 |
| :-- | :--- | :--- |
| 1 | 主窗口面板左沿**可拖拽改宽**（440 默认，360–820，持久化，双击复位） | §5.1、P2 |
| 2 | `+` **复用单例**搜索页 | §2.1、§3 |
| 3 | 关掉最后一个标签 → 面板收起并清空 | §2.3、§3 |
| 4 | 条目顶部加「参考文本 ↓」跳转 | §6、P0 |
| 5 | 浮窗**不做标签栏**，单页导航 + 返回栈，状态与主窗口完全独立 | §7、P3 |
| 6 | 共享「页面组件」，不共享「标签逻辑 / 状态 / localStorage 键」 | §4.1 |

> 仍需实测才能定的数：标签上限（>8 卸最久未激活正文）——P4 看真实内存表现再定。

---

## 十二、实施记录（已落地，2026-10-21）

### 12.1 交付清单

| 新增 | 作用 |
| :--- | :--- |
| `types/panel.ts` | `PanelTab` / `PageChrome` / id 构造 |
| `hooks/usePanelTabs.ts` | 标签状态机（单 updater，纯函数转移） |
| `hooks/usePanelWidth.ts` | 左沿拖拽宽度（抓取偏移、仅松手持久化） |
| `hooks/useSpotlightPage.ts` | 浮窗页面栈（深度 6、栈顶同页去重） |
| `components/SidePanel.tsx` | 主窗口面板容器 + 左沿把手 |
| `components/PanelTabStrip.tsx` | 标签条（`+` / 收起 / 中键关闭 / 激活自动可见） |
| `components/SpotlightPageLayer.tsx` | 浮窗整页层（整栈常驻、只显示栈顶） |
| `components/KbUnavailable.tsx` | 两窗口共用的「未连接」提示 |
| `components/pages/{WikiSearchPage,WikiArticlePage,RawTextPage,ImagePage}.tsx` | 四种页面，两窗口共用 |

删除：`WikiSidebar.tsx`、`WikiPanel.tsx`、`WikiDrawer.tsx`。
保留：`RawMarkdownModal`（输入框草稿图 / 正文配图仍在用）、`ImagePreviewModal`（同上）。

### 12.2 实施中发现的三个坑（务必别踩回去）

1. **`hidden` 属性会被 Tailwind 的 `flex` 覆盖**：非激活页用 `hidden` + `className="flex"` 时，
   `.flex{display:flex}` 优先于 `[hidden]{display:none}`，结果是两页叠在一起、标题互相压字。
   现在统一用**内联 `display`** 控制显隐。
2. **浮窗整页层必须 `fixed`**：JSX 层叠在卡片内部，`absolute inset-0` 会被卡片 1px 描边内缩成
   498×638 且露出双层描边；`fixed inset-0` 直接对齐整个 webview（= 原生面板）。
3. **浮窗返回栈要「整栈常驻」**：只渲染栈顶会让返回后的搜索页被重新挂载 → 关键词与结果全丢；
   现在每层都挂载、只切 `display`，`←` 回去查询词与结果原样还在。

### 12.3 后续修正（用户实测反馈，2026-10-21 晚）

| 反馈 | 处理 |
| :--- | :--- |
| 标签多时要有横向滚动条 | 原生 overlay 滚动条在 macOS 上**不占位且常驻不可见**，改用**自定义 3px 滑轨 + 可拖动滑块**（只在真正溢出时出现，`data-tab-scrollbar`） |
| MD 原文 / 图片查看功能缺失 | 图片页改为**复用 `ImagePreviewModal` 的 `embedded` 模式**（缩放、平移、橡皮筋、双击还原、方向键翻页、复制、下载、在「预览」中打开全部原样）；原文页补回底部脚注，复制全部 / 字数行数保留 |
| 不要标签上限 | 不做（`>8 卸最久` 取消） |
| 主窗口不要 Esc 关标签 | 不做；图片页嵌入模式也显式忽略 Esc |

### 12.4 与方案的差异

| 项 | 方案 | 实际 | 原因 |
| :-- | :--- | :--- | :--- |
| 图片页缩放 | 滚动缩放 + 平移 | **复用 `ImagePreviewModal` 的嵌入模式**（缩放/平移/滚轮/捏合/双击/画廊/复制/下载/预览全保留） | 简化版会丢功能（用户实测反馈）；嵌入模式只换外壳，键盘快捷键按「是否可见」门控 |
| DeepSeek 语义 | P2 | 随 P0 一起做 | 只有 4 处小改，拆开反而要动两遍 ChatView/ChatInput |
| 浮窗页面层 | P3 单页 | 整栈常驻 | 见 12.2 第 3 条 |

### 12.5 验证结果

| 脚本 | 断言 | 结果 |
| :--- | :--- | :--- |
| `scripts/verify_side_panel.mjs` | 33 项（开合 / `+` 单例 / 胶囊去重 / 注入块在正文后 / 跳转 / 搜索↔条目 / 切标签保状态 / 横向滚动条 / Esc 不关标签 / 关闭语义 / 原文（复制·统计·脚注）/ 图片（缩放链路·复制·下载·预览）/ 宽度拖拽 / 未连接） | 33/33（暗、亮各跑一遍） |
| `scripts/verify_spotlight_page.mjs` | 9 项（无标签栏 / 整页 500×640 单层页头 / 返回栈保查询 / Esc / 胶囊注入在正文后 / 同胶囊不叠层 / 图片整页） | 9/9 |

`npm run build` → `./build_mac_app.sh install` 已执行；包内 `dist/index.html` 与项目一致，
`codesign -v` 通过。原生侧（`hitTest` 全穿透、`setPanelWidth` → `minSize`）需在真实 App 中手动确认。

---

## 十三、页头等高（2026-10-21 二次修正）

### 13.1 实测（`getBoundingClientRect`，含各自 1px 底边）

| 位置 | 修正前 | 修正后 |
| :--- | :--: | :--: |
| 主窗口 · 对话区顶栏 | 52 | 52 |
| 主窗口 · 标签栏 | 52 | 52 |
| 主窗口 · 页面二级头 | **44** | **52** |
| 浮窗 · 卡片自带头 | **53**（`py-3` + 内容 28 + 底边） | **52** |
| 浮窗 · 页面二级头 | **44** | **52** |

两处错位方向不同：主窗口是「二级头比标签栏矮 8px」；浮窗是「开页面时头部 53→44，下面内容整体上跳 9px」。
上一版四个页面各写一遍 `h-[44px]`，一个常量套两个窗口必然对不齐。

### 13.2 规则

**一个常量管四处**（`src/components/pageHeader.ts` 的 `PAGE_HEADER_HEIGHT = 52` / `pageHeaderClass()`）：

```
主窗口：对话顶栏 52 ┐
        标签栏   52 ├─ 面板里上下两条带等高
        页面头   52 ┘
浮窗：  卡片头   52
        页面头   52 → 开合页面顶部带子厚度不变，内容不跳
```

附带两条对齐（同样是「无缝」的一部分）：

1. **材质同一份**：页面头也用 `bg-[#f8f9fb]/80 + backdrop-blur dark:bg-[#18191c]/80`，不只是高度相同；
2. **内边距同一份**：`PageChrome.padding`（`tight` 主窗口 `px-2.5` / `comfy` 浮窗 `px-4`），
   浮窗里页头图标与卡片头 ✕ 起始 x 一致，不会突然左移 6px。

### 13.3 断言

- `verify_side_panel.mjs`：`chatHeader === strip === pageHeader === 52`，且页面头背景为半透明材质（35/35）。
- `verify_spotlight_page.mjs`：开页面**之前**量卡片头、开页面**之后**量页面头，两者必须都是 52（10/10）。

---

## 十四、小标题栏收紧 + i18n / 主题审计（2026-10-21 三次修正）

### 14.1 「完整条目内容」小栏

`pt-3 + pb-1 + 11px 行高` ≈ 33px → `py-1.5 + leading-none` ≈ **24px**；
注入块标签同步收紧（`pt-2 + pb-1`），两条小标题栏节奏一致。

### 14.2 i18n

| 检查 | 结果 |
| :--- | :--- |
| zh / en 键数量 | 564 / 564，无缺失、无多余 |
| en 值里含中文 | 0 |
| 新增 17 个键 | 全部双语（`panelTab*` / `panelBack` / `imageZoom(Fit|Actual)` / `openInPreview` / `rawMarkdownPageHint` / `imagePreviewPageHint` …） |
| 新组件里的硬编码中文 | 0（只有 JSDoc 注释） |
| **运行时**：`LANG=en` + 全 ASCII 合成数据 | `[data-side-panel]` 内**没有任何中文字符**（漏翻必现） |

> 审计脚本 `scripts/audit_panel_i18n.mjs`：`LANG_PREF=en|zh THEME=light|dark node scripts/audit_panel_i18n.mjs`，
> 依次打开 搜索 / 条目 / 原文 / 图片 四页并截图。

### 14.3 深浅色

| 检查 | 结果 |
| :--- | :--- |
| 面板底色 | light `rgb(248,249,251)` lum 249 / dark `rgb(27,28,32)` lum 28（按主题翻转） |
| 页面二级头 vs 标签栏 | 两主题下**完全同色**（`rgba(248,249,251,.8)` / `rgba(24,25,28,.8)`） |
| 四页截图 | light+en / light+zh / dark+en 逐页人眼复核：文字、徽标、棋盘格画布、滚动条滑块都有对应 dark 变体 |

### 14.4 顺带修掉的窄面板问题

图片页在 440px 里右侧按钮占掉大半宽度，统计文字被截成 `1 / 2…`：
改为**标题先截断、尺寸信息不截断**，页面形态标题用短名词（`图片` / `Image`，与标签同名），
于是完整显示 `1 / 2 · 1 × 1`；同时页面形态也显示统计数据（原来只有弹窗形态显示）。

---

## 十五、窄面板图片页头 + 拖拽性能（2026-10-21 四次修正）

### 15.1 图片页头：窄到 400px 只留图标

- 新增容器查询变体 `cq-sm`（`@container (min-width: 25rem)` = 400px，`tailwind.config.js`），
  容器是 `ImagePreviewModal` 卡片自身的 `containerType: inline-size`。
- 标题（`图片` / `Image`）与尺寸统计 `hidden cq-sm:block/inline`：
  ≥400 显示，<400（最窄 360）只剩左侧图标，右侧工具按钮拿回全部宽度。

### 15.2 拖拽卡顿：拖的时候不渲染

**根因**：旧实现每次 `pointermove` 都 `setWidth` → `SidePanel` 整体重渲染 →
所有常驻标签页（含图片画布的 `ResizeObserver → setContainerSize → applyTransform`）逐帧重排。
图片页在场时最明显（画布尺寸观察器每帧都会回写一次），实测长任务观察器在 headless 里抓不到，
但链路是确定的：一次 pointermove = 一次 React 提交 + 一次全页重排。

**改法（与主窗口「调窗口尺寸」同款体验）**：

| 阶段 | 行为 |
| :--- | :--- |
| pointerdown | `dragging=true`（**唯一一次** React 渲染）→ 页面区 `content-visibility: hidden`（跳过内部布局与绘制）+ 盖上不透明遮罩 |
| pointermove | 只把宽度写进 `aside.style.width/minWidth` + 更新胶囊数字，**不 setState** |
| 遮罩 | 与主窗口原生 `ResizeOverlayView` 同一套语言：面板底色铺满 + 居中 38px 圆角胶囊，等宽数字 `500 px` |
| pointerup | 提交一次 `setWidth` + localStorage + `setPanelWidth` 原生桥 → 只重排一次 |

`usePanelWidth({ onLiveWidth })` 只在松手时提交 state；`SidePanel` 用 `useLayoutEffect`
在「拖拽期间意外重渲染」时把实时宽度补回 DOM（React 会按 state 重写 style）。

> `content-visibility` 在 Safari 18+ / Chromium 均支持；万一不支持则退化为「遮罩盖住、内容照常重排」，
> 视觉仍然一致，只是没省掉重排。

### 15.3 断言

`verify_side_panel.mjs` **38/38**，新增 4 条：
拖拽中「遮罩存在 + 胶囊显示 `\\d+ px` + 页面 `contentVisibility === hidden`」、
松手后遮罩消失、最窄（360）时图片页标题与尺寸 `display:none` 且图标仍在。

---

## 十六、拖拽遮罩：对话区一起盖 + 延时淡出（2026-10-21 五次修正）

### 16.1 为什么对话区也要盖

卡的主因不只是面板内容：**对话列是 `flex-1`**，面板每帧变宽 → 对话列每帧变窄 →
Markdown 段落/代码块/表格重新折行、`MarkdownRenderer` 重渲染。所以只盖面板等于什么都没解决。

现在拖拽时：

| 区域 | 处理 |
| :--- | :--- |
| 对话列（`ChatView`） | 加 `.freeze-children`（直接子元素 `content-visibility: hidden`，盒子照旧、内部布局与绘制全跳过）+ 盖同底色遮罩 |
| 面板页面区 | `content-visibility: hidden` + 盖遮罩 + 尺寸胶囊 |
| 左侧会话栏 | 宽度固定不变形，**不盖**（保留定位感） |
| 标签栏 | 保留可见（能看到面板边界在动） |

拖拽期间 React **零 setState**（宽度只写 DOM），浏览器也跳过两侧内部布局——
一次拖动只在松手时重排一次。

### 16.2 淡出时序（对齐原生 `ResizeOverlayView.hideAnimated`）

原生是「显示 0.10s easeOut / 隐藏 delay 0.08s + 0.27s easeInEaseOut」，这里照抄：

| 时刻 | 状态 |
| :--- | :--- |
| 松手瞬间 | 提交宽度、解除 `content-visibility`（内容在遮罩底下完成一次重排），遮罩仍 `opacity: 1` |
| +80ms 起 | 两块遮罩同时 `opacity → 0`（270ms ease-in-out），**淡出过程中内容已经被盖住并完成适配** |
| +350ms | 两块遮罩一起卸载 |

实现：`hooks/useFadeOverlay.ts`（`mounted` 与 `visible` 分开），面板与对话区共用同一口径，
`data-veil-visible` 供回归脚本断言。

### 16.3 顺带修掉一个真 bug（图片页缩放偶发失效）

`ImagePreviewModal` 在「打开/切索引」的 effect 里 `setNaturalSize(null)`，
一旦父级 render 让 `images` 换了身份，就会把**已经量好的尺寸清空** →
按钮点了没反应、`transform` 被 React 的 style diff 清掉。
现在尺寸只由「按 `currentUrl` 预读」的 effect 负责重置，缩放链路稳定。

### 16.4 断言

`verify_side_panel.mjs` **40/40**（连跑两次稳定）。拖拽中：
面板遮罩 + 胶囊 `\d+ px` + 面板 `contentVisibility=hidden` + 对话遮罩存在 + `.chat-container` 带 `freeze-children`；
松手后：两块遮罩 `data-veil-visible=false` 且对话已解冻；+500ms 后两块都卸载。

---

## 十七、三列独立宽度模型（2026-10-21 六次修正）

### 17.1 宽度模型

```
┌──────────┬────────────────────┬──────────────┐
│ 左栏 260 │ 中部 flex（≥460）  │ 右栏 360–820 │
└──────────┴────────────────────┴──────────────┘
窗口宽 = 左(0|260) + 中部 + 右(0|面板宽)
窗口最小宽 = 左 + 460 + 右
```

常量唯一来源 `src/layout.ts`；原生 `updateWindowMinSize` 与之一致（`left + 460 + panel`）。

| 动作 | 中部 | 右栏 | 窗口 | 遮罩 |
| :--- | :--- | :--- | :--- | :--- |
| 展开/收起左栏 | **不变** | 不变 | 向左 ±260 | 中部（+右栏若可见） |
| 展开/收起右栏 | **不变** | 0 ↔ 面板宽 | 向右 ±面板宽 | 中部 + 右栏 |
| 拖右栏把手 | 变 | 变 | 不动 | 中部 + 右栏 |
| 拖窗口边缘 | 变 | 锁死 | — | 原生整窗遮罩（已有） |
| 关掉最后一个标签 | 不变 | → 0 | 向右收缩 | 中部 + 右栏 |

### 17.2 窗口联动（**已废弃，见 §18**）

新增桥 `growWindow({ delta, anchor })`（`anchor: 'left' | 'right'`）：

- 原生 `growWindow(by:anchor:)`：`visibleFrame` 钳制 → 0.2s 同缓动改 frame → 完成前保持
  `isInternalFrameChange`（避免与原生遮罩叠加）；全屏态不动 frame；自定义缩放态先回原尺寸；
- 前端只有一个出口：`App` 的 layout effect **只在左右栏「可见性」变化时**发 `growWindow`。
  改右栏宽度（拖拽/复位）属于「有意让中部吸收」，绝不能动窗口。

### 17.3 尺寸 HUD（两块遮罩各自显示宽度）

- 中部显示中部宽、右栏显示右栏宽，都是等宽数字 + `px`；
- 零重渲染：`src/utils/resizeHud.ts` 用模块级注册表直接改 `textContent`，
  拖拽每帧只写 DOM（宽度、数字），开合时写一次目标值。

### 17.4 本轮修掉的两个真 bug

1. **右栏拖拽没扣左栏**：`max = innerWidth - 460` → 左栏开着时中部能被压到 200。
   现在 `max = innerWidth - 左栏 - 460`。
2. **对话区遮罩被自己冻掉**：`.freeze-children > *` 把遮罩也设成 `content-visibility: hidden`，
   于是遮罩+数字根本画不出来（只看到一片空白）。现在给 `[data-chat-resize-veil]` 单独
   `content-visibility: visible`。

### 17.5 断言（45/45）

- 收起左栏 → `growWindow(-260,'left')` + 中部遮罩 + 冻结 + 胶囊有数字；展开 → `+260`；
- 展开右栏 → `growWindow(+, 'right')` + 两块遮罩 + 两块胶囊各有数字；
- 拖拽 → 宽度不越过 `innerWidth - 左 - 460`；
- 松手 → 遮罩先转透明、内容解冻、+350ms 卸载。

> 真实窗口伸缩无法在无头环境验证（没有原生窗口），装包后需手动确认：
> 展开/收起两侧时中部宽度不变、窗口向对应方向长。

---

## 十八、改为「挤压模型」（2026-10-21 七次修正，取代 §17.2）

§17.2 的「窗口始终跟着侧边栏等量伸缩」在实际使用中引入了大量问题（窗口猛跳、缩放态被还原、
全屏异常）。现改为现代桌面应用常见的**挤压模型**：

### 18.1 规则

1. **开合侧边栏时窗口尺寸尽量不动** —— 侧边栏向中间挤，中部让出/收回空间；
2. 左右两栏各自保持自身宽度（右栏用它记住的宽度 360–820）；
3. 只有当「中部会被压到 < 460」时，才把**整个窗口**扩出**缺口那一段**
   （`growWindow(shortfall, anchor)`，左栏 `left` / 右栏 `right`）；
4. 收起侧边栏时窗口不缩回，中部自己长回来；
5. 拖拽右栏宽度是「有意让中部吸收」，永远不动窗口。

### 18.2 全屏 / 缩放态

- 原生 `growWindow` 在**全屏**下直接 return：不退出全屏、不改 frame；
- **不再**碰 `preZoomFrame`：展开侧栏不会"顺手还原成原始尺寸"；
- `updateWindowMinSize` 里**删掉了主动 setFrame**（原来 minSize 一跳变就把窗口硬撑，
  表现为"点一下侧栏窗口猛跳"，还会连带触发缩放态还原）。minSize 只约束用户手动拖窗口的下限。

### 18.3 遮罩

只要中部或右栏尺寸变化，中部 + 右栏两块遮罩照旧一起上（含胶囊：中部显示目标宽度，
不足最小宽度时显示 `460 px`）；淡出仍是 +80ms / 270ms / +350ms 卸载。

### 18.4 断言（47/47）

- 窗口够宽（1280）时：收起/展开左栏、展开右栏 —— `growWindow` **一次都不发**，但遮罩都在；
- 视口压到 1000、右栏 360 时展开右栏：中部只剩 380 → 只发 `growWindow(80, 'right')`，
  中部胶囊显示 `460 px`；
- 关右栏（中部变宽）同样不动窗口。

---

## 十九、整块滑入 + 只在拖拽时显示数字（2026-10-21 八次修正）

针对「开合时下层还在实时刷新」「实时算尺寸没用」的两点调整：

### 19.1 侧边栏 = 固定宽度的整块，滑入而不是缩放

| 层 | 职责 |
| :--- | :--- |
| 外层（`aside`） | 只让出/收回空间：`width` 0 ↔ 260（左）/ 0 ↔ 面板宽（右），`transition-[width]` |
| 内层（`[data-sidebar-surface]` / `[data-panel-surface]`） | **固定宽度**（左 260 / 右 = 面板宽），`translateX(±100%)` ↔ `0` |

内层宽度恒定 → 开合时侧边栏内部**一次都不重排**（只有 transform，合成层动画）；
右栏的 `container-type: inline-size` 也因此始终等于最终宽度，图片页头之类的容器查询不会中途跳变。
拖拽改宽时由 `applyLiveWidth` 同步内层宽度，保证"整块"与外框一致。

### 19.2 开合只盖中部，且不显示数字

- 开合：只有**中部**盖遮罩（两侧是整块滑入，本身不需要盖），遮罩**没有胶囊**；
- 拖拽：中部 + 右栏都盖，**两块都有胶囊**（这是真正的连续尺寸变化，数字有意义）；
- 实现：`ChatView` 拆成 `resizing`（拖拽，带胶囊）与 `layoutMask`（开合，无胶囊）；
  `SidePanel` 去掉 `masked`，右栏遮罩只在拖拽时出现。

### 19.3 遮罩期间下层确实不参与布局

- 中部：`.freeze-children` → 直接子元素 `content-visibility: hidden`（遮罩自身除外）；
- 右栏拖拽：页面栈 `content-visibility: hidden`；
- 侧边栏开合：内层宽度恒定，天然不重排；
- 断言新增：`收起左栏` 时 `.chat-container` 的**每个非遮罩子元素** computed `contentVisibility === 'hidden'`；
  `展开右栏动画中途`：`asideW < 440` 而 `surfaceW === 440` 且 transform 非 none（证明是滑入不是缩放）。

### 19.4 遮罩结束：先 hold 再淡出（本轮补充）

`useFadeOverlay` 原来是「一结束就开始淡出」，即使 `mounted` 留了一会儿，**不透明度也是立刻往下掉**，
观感就是"刚点完就闪掉"。现在拆成两段（与原生 `hideAnimated` 同构）：

| 阶段 | 时长 | 行为 |
| :--- | :--- | :--- |
| hold | 开合 140ms / 拖拽 100ms | 保持 `opacity: 1`，内容在遮罩底下完成那一次重排 |
| fade | 开合 300ms / 拖拽 280ms | `ease-in-out` 淡出 |
| 卸载 | hold + fade | 移除遮罩节点 |

开合的 hold 之所以更长：滑入/滑出本身 200ms，`layoutBusy` 在 240ms 结束，
若 240ms 就开始淡出，正好压在内容刚解锁的那一帧，容易看到闪。

### 19.5 断言（51/51）

`verify_side_panel.mjs` 49 项连跑两次稳定；`verify_spotlight_page.mjs` 10/10。

---

## 二十、刻度条卡死 / 内容闪现的根因（2026-10-21 十次修正）

### 20.1 根因：冻结会让所有 rect 变 0，而窗口化钩子正是靠 rect 定位

上一轮为了"遮罩期间不重排"，给对话列加了 `.freeze-children { > * { content-visibility: hidden } }`。
但 `useTurnWindow` 的 `readCurrentTurn()` 是这样定位的：

```ts
const lineY = el.getBoundingClientRect().top + READING_LINE;
// 逐轮比较 rect.top <= lineY → 当前轮
```

**冻结子树的 `getBoundingClientRect()` 全部返回 0**（Chromium 返回缓存值，WebKit 返回 0，
所以只有真实 App 里复现）。此时：

- `lineY ≈ 0 + READING_LINE`，所有 turn 的 `rect.top` 都是 0 → 判定"当前轮 = 最后一个已挂载轮"；
- 中心被写错 → 700ms 后"收拢"把挂载区间收到错误位置 → **内容闪现/消失**；
- 中心一直停在末尾 → **刻度条看起来完全不动**。

这就是「大窗口往下滚闪现、小窗口只剩一个来回且刻度不动」的同一根因。

### 20.2 修法（三层）

1. `readCurrentTurn()`：`el.clientHeight === 0` 或首个 turn 的 `rect.height === 0` → **直接返回原中心**，
   不做任何推断（这条对 WebKit 尤其关键）；
2. `useTurnWindow({ frozen })`：冻结期间 `scroll` 的 rAF 与"收拢"effect 全部跳过；
3. 解冻后（`frozen` false）补测一次，让中心回到真实位置。

`ChatView` 传入 `frozen: masked`（拖拽面板 + 开合侧边栏都会设它）。

### 20.3 断言

`verify_turn_rail.mjs` **33/33**（新增：开合侧栏后刻度不回跳 —— `before === during === after`）；
`MODE=spot` 32/32；`verify_side_panel.mjs` 51/51。

> 对照实验：用 `git worktree` 把 HEAD 单独跑起来，同一套滚动探针在 HEAD 与当前代码上**结果一致**，
> 说明窗口化逻辑本身没被改坏，问题出在"新加的冻结"与"依赖 rect 的测量"相撞。

---

## 二十一、撤销「对话列冻结」+ 钩子回退（2026-10-21 十一次修正）

`content-visibility: hidden` 这条路对对话列是**错的**：它会让子树的 `getBoundingClientRect()`
全部返回 0，而 `useTurnWindow` / `TurnRail` 的定位完全依赖 rect。加了一层又一层"保险"
（frozen 跳过、零高 bail、解冻补测）反而把滚动监听的重挂逻辑改坏了 —— 实测出现"挂载区间完全不动"。

处理：

1. `useTurnWindow.ts` **整份回退到 HEAD**（`git show HEAD:src/hooks/useTurnWindow.ts`）；
2. 对话列**不再冻结**：只盖遮罩，动画期间照常重排（遮罩盖着，看不到）；
3. `index.css` 的 `.freeze-children` 只保留给**右侧面板**（面板里没有依赖 rect 的测量），
   并写明"对话列绝不能使用"；
4. `scripts/verify_side_panel.mjs` 去掉关于"对话列被冻结"的断言（50/50）。

### 21.1 对照验证

用**真实会话数据**（`~/Library/Application Support/SimpleUI/sessions.json` 最近一条，26 条消息，
图片走真实 media 文件）跑滚动探针，与 HEAD 逐项对比：

| | HEAD | 回退后（当前） |
| :--- | :--- | :--- |
| 向下滚 mountChanges | 3 | 3 |
| 向上滚 mountChanges | 1 | 1 |
| scrollTop 反向次数 | 0（下）/ 23（上，方向使然） | 0 / 23 |
| 区间跟随 | 正常 | 正常 |

结论：滚动行为已与"改动前"完全一致。

### 21.2 顺带发现（未改）

真实会话里气泡图片在滚动/重挂时会改变高度（探针记录 `imgHeights` 12→67、125→185），
这是图片没有预留尺寸导致的布局位移，属于**独立于本次重构的既有行为**，需要单独决定是否加占位框。

### 21.3 真正的跳因：空闲"收拢"会顺手补挂轮次

用真实会话 + 打开右栏图片页（复现截图状态）逐帧记录 `scrollTop` / `scrollHeight`：

| 指标 | 修复前 | 修复后 |
| :--- | :--- | :--- |
| 向上滚 20 格（2400px）实际位移 | 771px | 2280px |
| `scrollHeight` 变化 | 5665 → 7294（+1629） | 5665（不变） |
| 挂载区间变化次数 | 1（凭空多挂一轮在上方） | 0 |

原因：收拢调的是 `setViewAround(centerIndex)`（中心 ± 2）。当中心偏到区间边缘时，
它不只是"收"，还会**在视口上方补挂轮次**；插入内容要靠原生锚定抵消，滚轮打的位移被吃掉，
体感就是"滚不动 / 乱跳"。

修法（一处、两行）：收拢只允许**缩小**
`nextStart = max(startIndex, center-2)`、`nextEnd = min(endIndex, center+2)`。
补挂仍然只由"贴近视口边缘（<0.6 屏）"那条路径负责，语义不再混淆。
