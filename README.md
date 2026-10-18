# SimpleUI

<p align="center">
  <a href="README.md"><b>简体中文</b></a> · <a href="README_EN.md">English</a>
</p>

<p align="center">
  <strong>本地优先的 macOS AI 工作台</strong><br>
  多模型集成 · 离线维基 RAG · 实时双语字幕 · 原生悬浮窗
</p>

<p align="center">
  React 19 · TypeScript · Vite · Tailwind CSS · KaTeX · Swift / WebKit · Apple Silicon
</p>

SimpleUI 为 [TurboFieldfare](https://github.com/drumih/turbo-fieldfare) 深度适配，支持 [Mference](https://github.com/NeelM0906/Mference) 与 [DeepSeek 官方 API](https://api-docs.deepseek.com/)，并通过 OpenAI 兼容接口连接 Ollama、vLLM、llama.cpp server、LM Studio 等推理服务。

---

## 界面预览

<p align="center">
  <img src="docs/assets/main-cn.png" alt="SimpleUI 中文主界面" width="960" />
</p>

<p align="center">
  <sub>中文主界面 · <a href="docs/assets/main-en.png">English UI</a></sub>
</p>

---

## 核心亮点

- **本地优先**：模型推理、知识库、语音识别、字幕和翻译都在本机完成；无需 Python 虚拟环境、向量数据库或云端 API。
- **模型集成服务**：统一托管基础模型、SenseVoice 语音识别、R2T2 流式字幕、Index-Translate 翻译与 CoreML 断句/端点模型。
- **DeepSeek API 深度适配**：官方 Base URL / API Key / 模型 / 上下文 / 温度 / top_p / 推理强度 / 停止串 / 系统提示词独立配置，直接请求官方接口，并针对缓存命中做上下文修剪。
- **离线维基 RAG**：Kiwix ZIM + 多通道检索 + 原文直注；不摘要、不改写、不机械截断，答案带可点击引用。
- **实时双语字幕**：SOTA SaT 断句、Smart Turn 语义端点、R2T2 流式识别、Index-Translate 整句翻译，原文实时、译文按句追加。
- **强大前端**：Markdown / KaTeX / Mermaid，代码块一键复制，公式块可复制为 Word / WPS 原生公式，表格可保留格式粘贴到 Word。
- **原生 macOS**：主窗口 + Spotlight 浮窗 + 快捷翻译 + 字幕悬浮窗，支持中英文界面与深浅色主题。

---

## 系统架构

```text
React 前端 / Swift 原生窗口
        │
        ▼
Node.js 代理（127.0.0.1:31235）
        │
        ├── 基础模型服务（TTF :1235 / Mference :1241 / OpenAI 兼容）
        ├── DeepSeek 官方 API（云端）
        ├── 离线维基 RAG（Kiwix :31236 + 本地 ZIM）
        ├── 语音输入（SenseVoice · audio.cpp :1236）
        ├── 实时双语字幕
        │     ├── R2T2 Q8_0 流式识别（:1250 · Metal）
        │     ├── SaT-3L-sm CoreML 断句（ANE / CPU）
        │     ├── Index-Translate-2B Q4_K_M（:1249 · Metal）
        │     └── Smart Turn v3.2 CoreML 语义端点（ANE）
        └── 快捷翻译（独立原生悬浮窗）
```

| 服务 | 默认端口 | 职责 |
| :--- | :--- | :--- |
| Node 代理 `proxy.js` | `31235` | 静态托管、SSE 透传、动态路由、受管服务 API |
| Kiwix 离线百科 | `31236` | 本地 ZIM 条目、标题联想、全文检索 |
| SenseVoice 语音输入 | `1236` | 长按右 ⌘ 的本地中英语音转文字 |
| R2T2 字幕识别 | `1250` | 追加式流式识别，原生标点 |
| Index-Translate 字幕翻译 | `1249` | 专精神经机器翻译 |
| 基础模型 | `1235` / `1241` | TTF / Mference / 兼容 OpenAI 的推理服务 |
| DeepSeek API | 云端 | 官方 API：对话、推理与快捷翻译 |

> 基础模型本体与权重不随本仓库分发，需要用户自行准备；语音模型随包内置，字幕模型可在应用内按需下载。

---

## 离线维基 RAG

SimpleUI 使用本地 Kiwix ZIM 构建端到端离线知识库。核心原则是：

> **注入给模型的正文是原文，不是模型摘要；不重写、不截断。**

```text
提问
  → OpenCC 简繁/港台词汇归一
  → 主力模型规划 1~2 个条目名
  → 多通道召回（精确探针 / 标题联想 / 消歧义页 / 全文检索）
  → 命名空间过滤 + 规范路径去重
  → 抓取条目 HTML，DOM 解析
  → 原文直注（Infobox / 引言 / 段落 / 列表 / 表格 / 公式）
  → 生成答案 + 引用胶囊
```

- 条目名由主力模型规划，检索结果按可靠度收敛；不是把整篇维基硬塞进上下文。
- 长条目只做“目录路由”，保留完整引言，不机械截断正文。
- 公式以 LaTeX 保留，表格以管道表/结构化数据保留，图片与图注在知识库面板中还原。
- 知识库面板支持公式、表格、图片、子标题与引用原文查看。
- 需要本地 ZIM 文件；运行时已随包分发，路径可在「服务管理 → 知识库」中配置。

### 中文检索为什么准

1. **中文优先归一**：先用 OpenCC 做简繁与港台词汇归一，再扩展字形变体，避免中文 ZIM 因“鼠標/鼠标/滑鼠”等写法差异漏检。
2. **模型规划 + 多通道召回**：主力模型只负责规划 1~2 个规范条目名；精确探针、标题联想、消歧义页、全文检索按可靠度收敛，全文检索只在必要时启用。
3. **消歧义交给模型**：精确命中消歧义页时，由主力模型从义项列表中选一个；不靠硬编码实体类型打分。
4. **原文直注**：DOM 解析后注入 Infobox、完整引言、段落、列表、表格与 LaTeX 公式；不做模型摘要、不机械截断，答案可直接引用原文。
5. **引用可回看**：答案中的引用胶囊只指向条目名，点开知识库面板可查看注入的原文，便于核对。

---

## 模型集成服务

### 基础模型与 DeepSeek API

- 本地深度适配 **TurboFieldfare**（默认端口 `1235`），同时支持 **Mference**（默认端口 `1241`）。
- **DeepSeek 官方 API 是一等 Provider**：独立配置 Base URL、API Key、模型、上下文窗口、温度、top_p、推理强度、停止串与系统提示词；请求直接发往 `api.deepseek.com`，不经过本地推理进程。
- DeepSeek 模式针对官方缓存行为做上下文修剪（批量修剪到 70% 水位），减少缓存失效与重复 prefill。
- 通过 OpenAI 兼容接口连接 Ollama、vLLM、llama.cpp server、LM Studio 等。
- 服务管理面板提供启停、状态、参数调优、日志与模型目录浏览；切换本地基础引擎时执行显存互斥释放。
- 本地上游项目与模型权重需自行准备，详见 [TurboFieldfare](https://github.com/drumih/turbo-fieldfare) / [Mference](https://github.com/NeelM0906/Mference)；DeepSeek 只需在设置中填写 API Key。
- 说明：DeepSeek 模式会自动关闭知识库入口；离线维基 RAG 面向本地模型链路。

### 全局语音输入

- 模型：SenseVoice-Small Q8_0（audio.cpp），随包内置运行时与模型。
- 操作：长按右侧 `⌘` 说话，松开后转写并写入当前输入框；在其它 App 中通过剪贴板粘贴。
- 支持中英语音、内置 Silero VAD，断网可用。
- 首次使用需授予麦克风、辅助功能、输入监控权限。

### 离线实时双语字幕

SimpleUI 的实时字幕完全在 Apple Silicon 本地运行：**音频不上传，不调用云端 API**，ASR、断句、端点和翻译均由本地模型完成。适用于看剧、会议、演讲、播客等场景。

```text
系统音频（16kHz mono PCM）
  → R2T2 Q8_0 流式识别（audio.cpp · Metal）
  → SaT-3L-sm 断句（CoreML · ANE）
  → Index-Translate-2B 整句翻译（llama.cpp · Metal）
  → 原文实时流 / 译文按句追加
         ↑
   Smart Turn v3.2（CoreML · ANE，旁路判断是否说完）
```

| 组件 | 模型 / 版本 | 体积 | 运行位置 |
| :--- | :--- | ---: | :--- |
| 流式识别 | Confucius4-R2T2 Q8_0 | 2.31 GiB | audiocpp · Metal（`:1250`） |
| 智能断句 | [SaT-3L-sm](https://huggingface.co/segment-any-text/sat-3l-sm) CoreML FP16 | 240 MB | CoreML · ANE / CPU |
| 整句翻译 | [Index-Translate-2B](https://huggingface.co/IndexTeam/Index-Translate-2B-GGUF) Q4_K_M | 1.22 GiB | llama-server · Metal（`:1249`） |
| 语义端点 | [Smart Turn v3.2](https://huggingface.co/aufklarer/Smart-Turn-v3.2-CoreML) CoreML FP16 | 16.8 MB | CoreML · ANE |
| 断句分词 | XLM-R `tokenizer.json` | 9 MB | Node |

> 字幕模型遵循各自上游许可证；SaT 权重为 MIT，其 CoreML 转换包请自行确认分发授权。

工作方式：

- **音频全量直连 R2T2**：不使用能量 VAD、不裁剪静音、不丢帧；Smart Turn 只做旁路语义端点，不门控音频。
- **完整句翻译**：SaT 按完整句切分，翻译只处理完整句；只有收尾时的尾部半句才会单独翻译。
- **智能收尾**：Smart Turn 判断“这一轮说完了”后结束 live 请求；已断出 3 句且停顿 700ms 也可安全轮换，30 秒为硬上限。
- **稳定吐出尾部**：关闭请求前补 1 秒静音，确保 R2T2 返回最后未提交的文本。
- **语言方向**：支持英文→中文/日文、中文→英文/日文；声音源与目标语言在字幕悬浮窗切换。
- **严格按需**：打开字幕窗口才加载，关闭即卸载；失败直接 fatal，不自动重启/重连。
- **模型目录**：`~/Library/Application Support/SimpleUI/models/subtitles_pipeline/`；服务管理面板支持四模型测速下载与断点续传。

### 快捷翻译

- 全局快捷键 `⌃ Control + Space`，原生非激活浮窗，不抢当前应用焦点。
- 支持自动、中→英、英→中、详解四种模式，`Enter` 翻译、`⌘C` 复制、双向 TTS。
- Provider 可选 TTF、Mference、OpenAI 兼容服务或 DeepSeek；独立提示词，默认关闭思考。

---

## 前端

- **轻量**：React 19 + TypeScript + Vite + Tailwind；原生 Swift/WebKit 外壳，无重型前端框架依赖。
- **富文本渲染**：Markdown、KaTeX 公式、Mermaid 图、表格、代码块、图片预览、思考折叠。
- **复制能力（Word 兼容）**：

| 内容 | 复制行为 |
| :--- | :--- |
| 公式块 | 复制为 Word / WPS 原生 OMML 或标准 MathML，粘贴后是可编辑公式 |
| 表格 | 复制为带样式的 DOCX 表格 XML / 富文本，保留表头、边框、合并单元格 |
| 代码块 | 右上角按钮一键复制纯代码；选中代码时只复制选中行 |
| 普通文本 | 复制为干净的 Markdown 原文 |

公式与表格的 Word 兼容序列化位于 `src/utils/selectionToMarkdown.ts`；代码块复制由 `MarkdownRenderer` 的代码块组件提供。

- **原生体验**：主窗口、Spotlight 浮窗、快捷翻译、字幕悬浮窗、语音胶囊；全局快捷键与深浅色主题。
- **双语界面**：中英文文案同步，字幕/服务面板/错误提示均支持中英文。
- **上下文可视化**：实时上下文圆环、阶段阶梯、性能页脚与跨窗口流同步。

---

## 快速开始

### 前提

- Node.js ≥ 18
- macOS 15+（构建原生 App）
- 可选：本地基础模型服务（TTF / Mference / Ollama / vLLM / llama.cpp / LM Studio）
- 可选：DeepSeek API Key（云端对话/翻译）
- 可选：本地 Kiwix ZIM 文件（离线维基）

### 一键启动

```bash
./start.sh
```

首次运行会安装依赖；若 `dist/` 不存在会先构建，然后启动代理并打开 `http://127.0.0.1:31235`。

### 开发模式

```bash
./start.sh dev
# 或
npm run dev
```

### 构建 macOS App

```bash
./build_mac_app.sh install
```

构建 Swift 原生外壳、前端产物与内置运行时，安装到 `/Applications/SimpleUI.app`。修改前端后需要重新执行构建，已安装 App 使用包内副本。

### 模型与知识库

- 基础模型：自行准备 TTF / Mference 本体与权重；也可连接其它 OpenAI 兼容服务，或在设置中直接配置 DeepSeek API Key。
- 语音模型：随包内置 SenseVoice；缺失时可在「服务管理」下载。
- 字幕模型：在「服务管理」下载，包含 R2T2、SaT、Index-Translate、Smart Turn 与 tokenizer。
- 离线维基：在「服务管理 → 知识库」中指定本地 ZIM 文件。

---

## 项目结构

```text
SimpleUI/
├── src/                  React 前端（聊天、Markdown/KaTeX、知识库、字幕、设置）
├── server/               Node 代理与受管服务
│   ├── proxy.js          HTTP/SSE 入口（:31235）
│   ├── subtitle_service.js
│   ├── asr_service.js
│   ├── wiki_service.js
│   └── subtitles/        字幕 helper / 断句 / 翻译模块
├── mac_app/              Swift 原生窗口、悬浮窗、音频采集
├── bin/                  Kiwix / audio.cpp / llama.cpp / 字幕 helper
├── scripts/              构建、同步与测试脚本
└── build_mac_app.sh      macOS App 构建与安装
```

---

## 开源协议

本项目基于 [Apache License 2.0](LICENSE) 开源。
