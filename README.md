# SimpleUI

<p align="center">
  <strong>专为 <a href="https://github.com/drumih/turbo-fieldfare">TurboFieldfare</a>（Gemma 4 26B-A4B）深度定制的轻量级现代化 AI 问答客户端</strong>
</p>

<p align="center">
  React 19 · TypeScript · Vite · Tailwind CSS · KaTeX · Node.js 代理
</p>

---

## 目录

- [项目简介](#项目简介)
- [核心特性](#核心特性)
- [快速启动](#快速启动)
- [项目结构](#项目结构)
- [配置参数](#配置参数)
- [多模态图片支持](#多模态图片支持)
- [Spotlight 模式](#spotlight-模式)
- [macOS 原生包装层](#macos-原生包装层)
- [兼容性](#兼容性)
- [开源协议](#开源协议)

---

## 项目简介

SimpleUI 是一款为 [TurboFieldfare](https://github.com/drumih/turbo-fieldfare) 推理服务量身定制的 Web 客户端。相比 Open WebUI 等通用方案，SimpleUI 没有 Python 虚拟环境、FastAPI、SQLite 或 ChromaDB，整个前端冷启动耗时 **< 300 ms**，进程内存占用约 **30 MB**。

SimpleUI 同时提供一个 **macOS 原生包装层**（Swift + WKWebView），将浏览器窗口包装为一个独立的 `.app`，支持全局快捷键唤醒的 Spotlight 悬浮面板。

---

## 核心特性

### ⚡ 极致轻量

- 基于 **React 19 + TypeScript + Vite**，无任何重型框架依赖。
- 内置极简 Node.js 反向代理（`server/proxy.js`），保真透传 SSE 流式传输与 `: ping` 心跳包，彻底告别 CORS 困扰。
- Vite 开发代理同步支持，`/v1` 自动转发至本机推理服务。

### ⭕ 上下文圆环（Context Ring）

- 发送按钮左侧内嵌微型 SVG 环形进度圈，随当前会话累计 Token 比例动态填充。
- 颜色语义：正常 → 橙色预警（> 75%）→ 红色警示（> 90%）。
- 悬浮 Tooltip 精确显示：`已用 2,140 / 32,768（剩余 30,628 tokens · 6.5%）`。

### 📊 实时性能指标栏

每轮对话完成后，在输入框下方展示：

```
⚡ 380ms TTFT · 18.5 tok/s · 2.45s 生成 · 剩余 30.1K / 32K 上下文
```

指标包括：首 Token 延迟（TTFT）、解码速度（tok/s）、本轮生成耗时、Prompt/Completion/Cache 用量及上下文剩余量。

### 🧠 深度思考模式

- 输入框内置「快速 / 思考」一键切换按钮。
  - **思考模式**：随请求发送 `chat_template_kwargs: {enable_thinking: true}` + `reasoning_effort: "high"`。
  - **快速模式**：`enable_thinking: false` + `reasoning_effort: "none"`，极速直接回复。
- 思考过程以带计时器和呼吸动画指示器的折叠卡片呈现，支持一键展开/收起。

### 📐 Markdown 与 LaTeX 渲染

- 基于 **KaTeX + remark-math + rehype-katex**，完整支持行内公式 `$...$` 与独占行 `$$...$$`。
- GitHub Flavored Markdown：表格、引用、强调、删除线全支持。
- 代码块带语言标签与一键复制按钮。

### 🖼️ 多模态图片问答（Vision）

- 支持三种输入方式：截图粘贴（`Cmd + V`）、拖拽至输入框、点击 ＋ 按钮选择文件。
- 发送前提供缩略图预览与一键移除。
- 仅支持图片格式（PNG / JPEG / HEIC / HEIF），与推理服务端白名单完全对齐。

### ⚙️ 完整参数配置面板

- 实时调节 `temperature`、`top_p`、`top_k`、`repetition_penalty`、`max_tokens`、`seed`、`stop` 序列与 `System Prompt`。
- 严格剔除未声明字段，杜绝后端 400 `unknown_parameter` 错误。
- 所有设置通过 `localStorage` 持久化，刷新后自动恢复。

### 📂 多会话管理

- 侧边栏展示历史会话列表，支持新建、重命名、删除。
- 基于 `localStorage` 持久化，通过 `BroadcastChannel` 在多窗口（主窗口 ↔ Spotlight 面板）间实时同步。

---

## 快速启动

### 前提条件

- Node.js ≥ 18
- 已在本机运行 [TurboFieldfare](https://github.com/drumih/turbo-fieldfare) 推理服务（默认端口 `1235`）

### 方式一：一键脚本（推荐生产/演示）

```bash
./start.sh
```

脚本会自动：
1. 探测 `http://127.0.0.1:1235/health` 状态并给出提示。
2. 检测并安装前端依赖（首次运行执行 `npm install`）。
3. 若 `dist/` 目录不存在，自动执行 `npm run build`。
4. 启动 Node.js 代理服务，并在系统浏览器打开 `http://127.0.0.1:3000`。

环境变量覆盖：

```bash
PORT=8080 TURBO_API_URL=http://192.168.1.100:1235 ./start.sh
```

### 方式二：Vite 开发模式（热重载）

```bash
./start.sh dev
# 或
npm run dev
```

访问：`http://127.0.0.1:5173`

Vite 配置（`vite.config.ts`）会将所有 `/v1`、`/health` 请求代理至 `http://127.0.0.1:1235`。

### 方式三：手动构建

```bash
npm install
npm run build       # 输出至 dist/
npm start           # 启动 Node.js 代理，服务 dist/ 静态资源
```

---

## 项目结构

```
SimpleUI/
├── index.html                   # HTML 入口
├── package.json                 # 依赖声明
├── tsconfig.json                # TypeScript 严格模式配置
├── vite.config.ts               # Vite 开发配置与本地反向代理
├── tailwind.config.js           # 暗色主题样式配置
├── start.sh                     # 一键启动脚本
│
├── server/
│   └── proxy.js                 # 生产模式 Node.js 反向代理
│                                #   - 转发 /v1/* → 推理服务
│                                #   - 保真透传 SSE 流与心跳
│                                #   - 静态托管 dist/
│
├── mac_app/                     # macOS 原生包装层（Swift）
│   ├── src/                     # Swift 源码（AppDelegate、窗口管理、WebKit 桥接）
│   └── Resources/               # 图标等资源文件
│
└── src/
    ├── main.tsx                 # 应用入口（React DOM 挂载）
    ├── App.tsx                  # 顶层状态机与布局路由
    ├── index.css                # 全局样式、KaTeX 字体导入
    │
    ├── types/
    │   └── chat.ts              # 严格 TypeScript 类型定义
    │                            #   ChatMessage / ChatSession / AppSettings /
    │                            #   ServerHealthInfo / TurnMetrics
    │
    ├── services/
    │   ├── api.ts               # TurboFieldfareAPI 封装
    │   │                        #   checkHealth / fetchModels / streamChat
    │   └── storage.ts           # localStorage 持久化与跨窗口 BroadcastChannel
    │
    ├── components/
    │   ├── Sidebar.tsx          # 会话历史侧边栏与服务健康状态徽章
    │   ├── ChatView.tsx         # 消息主视窗与欢迎建议卡片
    │   ├── MessageItem.tsx      # 单条消息（思考折叠、Markdown、复制）
    │   ├── ThinkingAccordion.tsx # 深度思考过程折叠展示
    │   ├── MarkdownRenderer.tsx  # Markdown + KaTeX + 代码高亮
    │   ├── ChatInput.tsx        # 复合输入栏（图片上传、快速/思考切换）
    │   ├── ContextRing.tsx      # SVG 上下文环形进度条
    │   ├── PerformanceFooter.tsx # 微型性能指标栏
    │   ├── ImageAttachment.tsx  # 待发送图片缩略图预览
    │   ├── SettingsModal.tsx    # 采样参数与连接设置模态框
    │   └── SpotlightView.tsx    # Spotlight 悬浮面板独立视图
    │
    └── utils/
        └── image.ts             # 图片提取（剪贴板/拖拽）、格式转换、Base64 编码
```

---

## 配置参数

所有参数可在右上角 ⚙️ 设置面板实时调整，保存后立即生效。

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `API 地址` | 推理服务 Base URL | `http://127.0.0.1` |
| `端口` | 推理服务端口 | `1235` |
| `模型 ID` | 当前加载模型（从 `/v1/models` 自动获取） | `gemma-4-26b-a4b-it` |
| `Max Context` | 上下文窗口大小（用于圆环计算） | `32768` |
| `temperature` | 采样温度，越高越随机 | `0.7` |
| `top_p` | 核采样概率阈值 | `0.9` |
| `top_k` | Top-K 候选数 | `50` |
| `repetition_penalty` | 重复惩罚系数 | `1.0` |
| `max_tokens` | 单次最大生成 Token 数 | `8192` |
| `seed` | 随机种子（留空则随机） | — |
| `stop` | 停止词序列（逗号分隔） | — |
| `System Prompt` | 全局系统提示词 | — |
| `reasoning_effort` | 思考模式推理力度 | `high` |
| `深度思考` | 是否开启思考模式 | `false` |

> **注意**：请求体会严格按照 TurboFieldfare 服务端 API 白名单构建，未声明字段不会发送，避免 `unknown_parameter` 错误。

---

## 多模态图片支持

SimpleUI 支持在对话中附带图片，图片以 Base64 Data URL 格式发送至推理服务。

**支持的图片格式**（与服务端白名单完全对齐）：
- `image/jpeg`
- `image/png`
- `image/heic`
- `image/heif`

**输入方式**：

| 方式 | 操作 |
|------|------|
| 剪贴板粘贴 | 截图后在输入框内按 `Cmd + V` |
| 拖拽 | 将图片文件拖入输入框区域 |
| 文件选择 | 点击输入框左下角 ＋ 按钮 |

图片在发送前会显示缩略图预览，支持单独移除任意一张。每次请求最多 64 张图片，单张上限 16 MB，每次请求总量上限 64 MB（服务端限制）。

---

## Spotlight 模式

Spotlight 是一个独立的轻量对话面板，通过 URL hash 或 query 参数路由触发：

```
http://127.0.0.1:3000/#/spotlight
http://127.0.0.1:3000/?mode=spotlight
```

与主窗口的区别：
- 背景透明，适合以悬浮窗形式叠加在桌面之上。
- 不包含侧边栏，界面更紧凑，专注于单次快速问答。
- 支持「展开」按钮跳转至主窗口并加载当前对话。
- 通过 `BroadcastChannel` 与主窗口实时双向同步会话数据。
- 支持动态通知原生 AppKit 面板调整窗口高度（通过 WebKit MessageHandler）。

---

## macOS 原生包装层

`mac_app/` 目录包含一个 Swift 编写的轻量级 macOS 原生包装层，将 Web 前端包装为独立的 `.app`：

- **双窗口架构**：主聊天窗口（常规 `NSWindow`）+ Spotlight 悬浮面板（透明 `NSPanel`）。
- **全局快捷键**：可绑定系统级快捷键唤起/隐藏 Spotlight 面板，无需切换应用。
- **WKWebView 桥接**：
  - `setModalOpen`：主窗口设置面板打开时禁用标题栏拖拽区域。
  - `setSidebarOpen`：侧边栏展开/折叠时通知原生层同步调整拖拽区域。
  - `reloadSessionsFromStorage`：原生层可通过 JavaScript 注入触发会话重载。
- **文件选择器代理**：通过 `WKUIDelegate` 支持在 WKWebView 内唤起系统原生文件选择对话框（用于图片上传）。

构建 macOS 应用：

```bash
./build_mac_app.sh
```

---

## 兼容性

SimpleUI 的 API 客户端层（`src/services/api.ts`）遵循 OpenAI Chat Completions API 规范，理论上可对接任何兼容的推理服务：

| 服务 | 健康检查端点 | Vision 支持 |
|------|------------|-------------|
| TurboFieldfare | `/health` + `/v1/models` | ✅ 自动检测（`data.vision`） |
| Ollama | `/v1/models` | ⚠️ 取决于模型 |
| vLLM | `/v1/models` | ⚠️ 取决于模型 |
| llama.cpp server | `/v1/models` | ⚠️ 取决于模型 |
| LM Studio | `/v1/models` | ⚠️ 取决于模型 |

> **注意**：深度思考模式（`chat_template_kwargs`、`reasoning_effort`）及 `/health` 的 `vision` 字段为 TurboFieldfare 专有扩展，其他服务会忽略这些字段。

---

## 开源协议

Apache License 2.0
