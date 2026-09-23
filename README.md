# TurboFieldfare Chat (TFF-Chat)

<p align="center">
  <strong>专为 <a href="https://github.com/drumih/turbo-fieldfare">TurboFieldfare</a> (Gemma 4 26B-A4B) 深度定制的轻量级现代化知识问答客户端</strong>
</p>

---

## 🌟 核心特性

- ⚡ **极致轻量、秒开响应**：
  - 基于 React 19 + TypeScript + Vite + Tailwind CSS，包体积极小，冷启动耗时 < 300ms，内存占用仅约 30MB。
  - 告别 Open WebUI 庞大的 Python 虚拟环境、FastAPI、SQLite、ChromaDB 向量数据库及繁重后台。
- ⭕ **发送按钮旁内嵌上下文圆环（Circular Context Ring）**：
  - 发送按钮左侧内嵌微型 SVG 环形进度圈，随当前会话累计的 Context 比例动态填充；
  - 正常状态为优雅暗灰/主题色，接近上限（>75%）变为橙黄预警，>90% 变为警示红；
  - 鼠标悬浮即弹出精致 Tooltip：`已用 2,140 / 32,768 (剩余 30,628 tokens · 6.5%)`。
- 📊 **输入框下方微型性能指标栏**：
  - 实时展现每轮问答的指标信息：`⚡ 380ms TTFT · 18.5 tok/s · 2.45s 生成 · 剩余 30.1K / 32K 上下文`。
- 🧠 **深度思考开关与流式折叠（Thinking）**：
  - 输入框内置“🧠 深度思考”开关，自由切换思考模式（On: `chat_template_kwargs: {enable_thinking: true}` + `reasoning_effort: "high"`；Off: 极速直接回复）；
  - 思考过程以带计时器和呼吸流式指示器的卡片折叠呈现，支持一键展开/折叠。
- 📐 **专业级 Markdown 与 LaTeX 公式渲染**：
  - 基于 `KaTeX` + `remark-math` + `rehype-katex`，高保真解析行内公式 `$x$` 与独占行 `$$...$$` 复杂公式（积分、矩阵、分式、物理符号等）；
  - 表格、引用、强调全支持，代码块带有语言标签与一键复制代码按钮。
- 🖼️ **多模态图文问答 (Vision)**：
  - 支持截图直接粘贴（`Cmd + V`）、拖拽图片至输入框或点击回形针（📎）选择；
  - 发送前提供缩略图预览与一键移除；
  - 自动检测并转换为 TurboFieldfare 严格要求的 Base64 Data URL（PNG/JPEG）。
- ⚙️ **服务端全量参数配置面板**：
  - 实时调节 `temperature`、`top_p`、`top_k`、`repetition_penalty`、`max_tokens`、`seed`、`stop` 序列与 `System Prompt`；
  - 严格剔除未声明字段，杜绝 400 `unknown_parameter` 错误。
- 🛡️ **内置轻量代理，零 CORS 困扰**：
  - 内置极简 Node.js 代理服务与 Vite 开发代理，无缝直连本地 `http://127.0.0.1:1235`，保真透传 SSE 流式传输与 `: ping` 心跳包。

---

## 🚀 快速启动

### 方式一：一键启动脚本（推荐）

在项目目录下运行：

```bash
./start.sh
```

脚本会自动检测 `http://127.0.0.1:1235` 状态，编译前端并拉起服务，自动在系统默认浏览器中打开 `http://127.0.0.1:3000`。

### 方式二：Vite 热重载开发模式

```bash
# 启动 Vite 开发服务器 (支持热重载，自动代理 /v1 到 127.0.0.1:1235)
./start.sh dev
# 或手动执行:
npm run dev
```

浏览器访问：`http://127.0.0.1:5173`

---

## 🛠️ 项目结构

```text
/Users/justinxie/Projects/SimpleUI/
├── package.json                   # 核心依赖 (React 19, Vite, Tailwind CSS, Lucide, KaTeX)
├── tsconfig.json                  # TypeScript 严格模式配置
├── vite.config.ts                 # Vite 开发配置与本地反向代理
├── tailwind.config.js             # 样式与暗色主题配置
├── index.html                     # 网页入口
├── start.sh                       # 一键启动脚本
├── server/
│   └── proxy.js                   # 生产模式极简反向代理 (解决 CORS 与静态托管)
└── src/
    ├── main.tsx                   # 入口文件
    ├── App.tsx                    # 顶层状态与布局
    ├── index.css                  # 全局样式与 KaTeX 样式导入
    ├── types/
    │   └── chat.ts                # 对齐 tff API 的严格 TS 类型定义
    ├── services/
    │   ├── api.ts                 # 严格白名单请求封装与 SSE 流式管道
    │   └── storage.ts             # 本地 LocalStorage 会话与设置持久化
    ├── components/
    │   ├── Sidebar.tsx            # 会话历史侧边栏与服务健康状态
    │   ├── ChatView.tsx           # 消息主视窗与快捷提问建议卡片
    │   ├── MessageItem.tsx        # 消息组件 (含思考折叠、Markdown/公式、复制)
    │   ├── ThinkingAccordion.tsx  # 深度思考过程折叠组件
    │   ├── MarkdownRenderer.tsx   # Markdown + KaTeX + 代码块高亮
    │   ├── ChatInput.tsx          # 现代化复合输入栏 (对齐参考图设计)
    │   ├── ContextRing.tsx        # 动态 SVG 上下文环形进度条组件
    │   ├── PerformanceFooter.tsx  # 输入栏下方微型性能指标栏 (TTFT/速度/时间)
    │   ├── ImageAttachment.tsx    # 待发送图片缩略图组件
    │   └── SettingsModal.tsx      # 高阶采样参数与端口设置模态框
    └── utils/
        └── image.ts               # 图片提取、格式转换与 Base64 编码
```

---

## 📄 开源协议

Apache License 2.0
