# 会话后端化重构方案（Session Backend）

> 决策（已确认）：
> 1. **会话的一切搬到后端**：前端只"实时抓状态 + 发指令"。
> 2. **底层处理层不动**：引擎代理 `/v1/*`、知识库 `wiki_service`（RAG：规划/召回/取全文/路由）、kiwix 全部保持现状。
> 3. **落盘由服务端写**。
> 4. 停止后：**保留用户提问 + 助手消息带一条「已停止」标记**。
> 5. 新建**专门的状态控制服务端文件**，上接前端界面、下接真正的处理服务端。

---

## 一、分层与文件布局

```
App(Swift) ──启动──> node server/proxy.js            （端口 31235，启动方式不变）
                        │
                        ├─ 处理层（**不动**）
                        │    ├─ /v1/*            引擎转发（TTF: /v1/chat/completions 等）
                        │    ├─ /api/wiki/*      知识库服务（RAG 管线 + rag-stage 打点）
                        │    └─ 静态资源 dist/
                        │
                        └─ 【新增】状态控制层 server/sessionService.js
                             上接：HTTP 指令 + SSE 状态流（两个窗口）
                             下接：直接调用上面的处理层（引擎 /v1/*、知识库 /api/wiki/*）
                             持有：会话集合、回合状态机、磁盘落盘
```

| 文件 | 动作 |
| :--- | :--- |
| `server/sessionService.js` | **新增**：会话 CRUD、回合状态机、生成编排、阶梯记账、落盘、SSE 广播 |
| `server/store.js` | **新增（小）**：原子写文件 / 启动恢复 / 损坏容错（也可并入上一文件） |
| `server/proxy.js` | **仅加一行**：`require('./sessionService')` 挂载路由（其余不动） |
| `server/wiki_service.js`、`/v1` 转发 | **不动** |

前端只保留两件事：**订阅状态**、**发指令**。

---

## 二、数据模型

```ts
// 落盘：~/Library/Application Support/SimpleUI/sessions.json
interface Session {
  id: string; title: string; messages: ChatMessage[];
  createdAt: number; updatedAt: number; contextUsed: number;
  enableThinking?: boolean; enableWikiSearch?: boolean;
}

interface ChatMessage {
  id: string; role: 'user' | 'assistant'; content: string;
  images?: string[]; reasoningContent?: string;
  isThinking?: boolean; thinkingDuration?: number;
  pending?: boolean;                    // 回合未产出首个 token
  stage?: 'rag' | 'prefill';
  prefillStartedAt?: number;
  stages?: TurnStageRecord[];           // 知识库/引擎阶段阶梯（服务端记账）
  metrics?: TurnMetrics;
  timestamp: number;
  error?: string;
  /** 【新增】被用户中止：保留提问，助手消息标记"已停止" */
  stopped?: boolean;
  citations?: WikiCitation[];
}

// 内存（不落盘，可从 sessions.json 重建）
interface TurnState {
  turnId: string; sessionId: string; messageId: string;
  phase: 'rag' | 'prefill' | 'thinking' | 'streaming' | 'done' | 'aborted' | 'error';
  stages: TurnStageRecord[];            // 阶梯（含各阶段 startedAt/endedAt/耗时）
  pending: boolean; isThinking: boolean; liveTokens: number;
  abort?: AbortController; upstream?: any;
  startedAt: number;
}
```

**阶梯 `stages` 由服务端记账**（关键）：RAG 各阶段本来就在 `wiki_service` 里产生打点，
服务端直接把「rag-stage 打点 → 阶梯行」这一步做了，前端不再轮询、不再双写 —— 双写问题从根上消失。

---

## 三、接口（全部挂在现有端口上）

### 状态（只读）
| 方法 / 路径 | 说明 |
| :--- | :--- |
| `GET /api/state` | 全量快照：`{ sessions, currentSessionId, turns }`（新窗口、SSE 重连、focus 时用） |
| `GET /api/state/stream` (SSE) | 增量事件流（见下表） |

SSE 事件：
`snapshot` / `session-upsert` / `session-delete` / `current-session` /
`turn-phase`（rag/prefill/thinking/streaming） / `turn-stage`（阶梯新增/结束一行） /
`turn-token`（内容增量，节流 ~50ms） / `turn-metrics` / `turn-done` / `turn-aborted` / `turn-error`

### 指令（写）
| 方法 / 路径 | 说明 |
| :--- | :--- |
| `POST /api/sessions` | 新建会话 |
| `DELETE /api/sessions/:id` | 删除会话 |
| `POST /api/sessions/:id/select` | 切换当前会话 |
| `PATCH /api/sessions/:id` | 改标题 / 思考开关 / 知识库开关 |
| `POST /api/turns` | **发送**：`{sessionId, text, images}` → 立即建 user + assistant(pending)，返回 `turnId`，后台开跑 |
| `POST /api/turns/:id/abort` | **停止**：掐上游请求 + 助手消息 `stopped: true` |
| `POST /api/turns/:id/retry` | 重试（替换该助手消息重跑） |
| `DELETE /api/turns/:id` | 删除整轮（提问 + 回答） |
| `POST /api/sessions/migrate` | **一次性迁移**：把前端 localStorage 里的旧会话上传（按 id 幂等） |

保持不变：`/api/health`、`/api/wiki/*`、`/v1/*`、静态资源。

---

## 四、回合流程（服务端编排，处理层不动）

1. **建档**：user 消息 + assistant 占位（`pending:true, stage:'rag'`）→ 落盘 → SSE `turn-phase{rag}`
2. **知识库（开关开时）**：调 `/api/wiki/rag-context`（现有管线）→ 期间把 `rag-stage` 打点记成阶梯行 → SSE `turn-stage`
3. **prefill**：`stage:'prefill'` → 调引擎 `/v1/chat/completions`（stream=true）
4. **思考 / 正文**：解析 SSE → `turn-token`（节流）→ 落盘节流 350ms；有 thinking 则 `phase:'thinking'`，正文开始 `phase:'streaming'`
5. **完成**：写 metrics，闭合最后一行阶梯 → 最终落盘 → `turn-done`
6. **中止**（任一窗口发 `abort`）：`abortController.abort()` 掐上游 → **保留用户提问**，助手消息 `stopped:true` + 已生成的思考/正文保留 → 落盘 → `turn-aborted`
7. **出错**：写 `error` → 保留提问 → `turn-error`

---

## 五、前端改造清单（逐文件）

| 文件 | 改成什么 |
| :--- | :--- |
| **新增** `src/services/sessionApi.ts` | 指令封装（send/abort/retry/delete/session CRUD/migrate） |
| **新增** `src/hooks/useAppState.ts` | SSE 订阅 + 全量快照 + 断线重连；对外只暴露 `sessions/currentSession/turns` |
| `App.tsx` | 删：`loadSessions/saveSessions` 作为状态源、`syncChannel` 流式分支、`persistSession`、`handleStagesChange`、`stagesRef`、镜像逻辑；`isGenerating` 由 turn 状态派生 |
| `SpotlightView.tsx` | 删：`executeSend` 里的生成编排、`broadcastStage`、`persistSession`、`STREAM_*` 收发、abort 分支；改为发指令 |
| `ChatView.tsx` | 消息来自 store；`ownsTurn/turnRecording` 不再需要；**滚动跟随逻辑不动** |
| `MessageItem.tsx` | 渲染「已停止」标记；阶梯只读渲染 |
| `StageLadder.tsx` | **删除记录器**（服务端记账），只渲染 `stages`；收起时机由 `pending/phase` 决定 |
| `useFollowBottom.ts` | **不动**（纯 UI） |
| `services/storage.ts` | 会话相关函数退役（保留 settings）；删 `requestAbort`/`clearStalePending` |
| `types/chat.ts` | 新增 `stopped?: boolean`；`TurnStageRecord` 保留 |
| `i18n/translations.ts` | 新增 `stopped`（中英） |
| README / README_EN | 架构章节更新 |

---

## 六、场景矩阵（全覆盖）

| # | 场景 | 重构后行为 | 验收 |
| :-- | :--- | :--- | :--- |
| 1 | 主窗口发送 / 浮窗发送 | 都是 `POST /api/turns`，无生成方/镜像方之分 | 两窗口都能发 |
| 2 | 本窗口停止 | `abort` → 掐上游、保留提问、`stopped` 标记 | 立刻停 + 提问还在 |
| 3 | **跨窗口停止** | 同上（服务端执行，与哪个窗口无关） | 任一窗口点都停 |
| 4 | 停止后内容 | 保留提问 + 已生成的思考/正文 + 「已停止」标记 | 不再变新对话 |
| 5 | 切会话 / 新建 / 删除 / 改标题 | 指令 → 服务端 → SSE 广播 → 两窗口同步 | 两窗口一致 |
| 6 | 重试（助手 / 用户） | `POST /api/turns/:id/retry`（服务端按 turnId 判过期流） | 旧流不污染新流 |
| 7 | 删除回合 | `DELETE /api/turns/:id` | 两窗口同步 |
| 8 | 会话级 思考 / 知识库 开关 | `PATCH /api/sessions/:id` | 两窗口一致 |
| 9 | 图片上传（多模态） | 随 send 一起提交（base64 走 JSON；注意体积，必要时分片/压缩） | 图片回合正常 |
| 10 | 引用 / 知识库面板 | 读 `message.citations`（服务端写入） | 引用不丢 |
| 11 | 指标 Prefill/Decode | 服务端算，消息里带 `metrics` | 只显示速度、无 prefill 耗时 |
| 12 | 阶梯：生成中 | 服务端逐行记账 → SSE `turn-stage` → 两窗口同时逐行生长 | 两窗口行数/耗时一致 |
| 13 | 阶梯：结束后 | 折叠成一行汇总，点击展开 | 一致 |
| 14 | 阶梯：切窗口 / 关窗口 / 退 App | 状态在服务端 → 重开仍在 | 重开可见 |
| 15 | 滚动跟随 | 前端局部逻辑不变：思考贴底、用户一滚就停、正文不动 | 不变 |
| 16 | **并发**（两窗口同时发） | 见"待确认"：建议**同会话新发送先中止旧回合** | 不出现两个回合交叉写 |
| 17 | 生成中隐藏/关闭窗口 | 生成在服务端继续；重开拉快照看到进行中 | 不中断 |
| 18 | 生成中退出 App | 服务端随 App 退出；下次启动把未完成的回合标记 `stopped`（**不再僵尸**） | 无僵尸 |
| 19 | 引擎/知识库不可用、超时、错误 | 统一 `turn-error`：保留提问 + 错误文案 | 不丢会话 |
| 20 | 首次启动 / 旧数据 | 前端把 localStorage 会话 `POST /api/sessions/migrate`（幂等） | 老数据不丢 |
| 21 | 设置（语言/主题/模型/参数） | **仍在 localStorage**（明确不动，见待确认） | 不变 |
| 22 | 浮窗空闲重置 | 前端局部逻辑保留 | 不变 |

---

## 七、落盘设计

- 路径：`~/Library/Application Support/SimpleUI/sessions.json`
  （可用 `SIMPLEUI_DATA_DIR` 覆盖；目录不存在则创建）
- **原子写**：写 `sessions.json.tmp` → `fs.rename` 覆盖，避免半截文件
- **节流**：回合进行中 ≤ 每 350ms 一次；回合结束/中止/结构变更立即写（flush）
- **启动恢复**：启动时读取；解析失败 → 另存 `sessions.corrupt-<ts>.json` 并以空态启动（不阻塞 App）
- **只写者 = 服务端**：前端不再写会话，彻底消除后写覆盖

---

## 八、分阶段落地（每阶段可独立验收 / 回退）

| 阶段 | 内容 | 验收 |
| :--- | :--- | :--- |
| **S0** | 提交 checkpoint + tag `checkpoint-before-session-backend` | 可回滚基线 |
| **S1** | 新建 `sessionService.js`：会话 CRUD + 落盘 + SSE + 快照；**生成仍由前端驱动，但状态改为上报** | 两窗口会话一致；停止跨窗口生效；阶梯一致 |
| **S2** | 生成编排搬到服务端（引擎/知识库调用、SSE 解析、阶梯记账、metrics）；前端删除镜像与流式编排 | 前端无 owner/mirror 概念；关窗口不影响生成 |
| **S3** | 收尾统一：完成/出错/**中止**三出口（保留提问 + `stopped`）；清理 `storage.ts`/`syncChannel`/`StageLadder` 记录器；i18n + README | 停止不再丢会话；僵尸清零 |
| **S4** | 迁移（localStorage→服务端）+ 容错加固 + 补测试 | 老数据不丢；坏文件可自愈 |

---

## 九、风险与回退

| 风险 | 应对 |
| :--- | :--- |
| SSE 在 WKWebView 断连 | 重连（指数退避）+ `GET /api/state` 全量快照；窗口 focus 强制拉一次 |
| 落盘写坏 / 磁盘满 | 原子写 + 损坏备份 + 空态启动；写失败只告警不中断生成 |
| 大改引入回归 | S1~S4 每阶段独立提交 + tag，出问题 `git revert` 回上一阶段 |
| 图片 base64 体积 | 随 send 提交前压缩（沿用现有前端压缩逻辑） |
| 端口/单实例 | 沿用现有策略（App 复用已就绪的 31235） |

---

## 十、待你确认（4 条）

1. **同会话并发发送**：新发送**先中止旧回合**（推荐）／排队／拒绝新发送？
2. **设置**是否也搬到服务端？（建议：本轮不动，继续 localStorage + storage 事件）
3. **「已停止」展示形式**：助手消息右侧小徽标（推荐）／单独一条灰字提示／错误条样式？
4. **落盘路径**：`~/Library/Application Support/SimpleUI/`（推荐）／项目目录／`~/.simpleui`？
