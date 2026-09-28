import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Loader2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { TranslationKeys } from '../i18n/translations';
import { TurnStageKind, TurnStageRecord } from '../types/chat';

interface StageLadderProps {
  messageId: string;
  /** 已记录的阶段（来自消息，随会话持久化） */
  records?: TurnStageRecord[];
  /**
   * 本轮是否由**本窗口**负责生成。只有生成方窗口轮询并记录，
   * 镜像窗口只负责渲染 —— 否则两个窗口会各记一份，互相覆盖。
   */
  recording: boolean;
  /**
   * 阶段是否**仍在进行**（= 消息还 pending 且未出错）。由广播同步，两窗口取值一致。
   * 它决定默认展开/收起：**没完全结束就不收起**（镜像窗口在轮询阶段同样保持展开），
   * 完全结束（首个 token 到达 / 出错 / 中止）后自动收起成一行汇总。
   */
  phasesActive: boolean;
  /** pending 期间的细分阶段：'rag' 知识库检索 / 'prefill' 引擎载入上下文 */
  turnStage?: 'rag' | 'prefill';
  /** prefill 开始时刻（父层打点，用于给「正在载入上下文」这行计时） */
  prefillStartedAt?: number;
  /** 记录变化 → 回写消息（持久化 + 跨窗口同步） */
  onRecordsChange?: (messageId: string, records: TurnStageRecord[]) => void;
}

/** 阶段 → 文案 key（复用已有的阶段文案，两窗口共用同一份映射） */
const KIND_LABEL_KEY: Record<TurnStageKind, TranslationKeys> = {
  planning: 'stagePlanning',
  resolving: 'stageResolving',
  sense: 'stageSense',
  fetching: 'stageFetching',
  routing: 'stageRouting',
  prefill: 'prefillLoading',
};

/** 服务端打点里可成为阶梯行的阶段（'idle' 等一律忽略） */
const RECORDABLE: TurnStageKind[] = ['planning', 'resolving', 'sense', 'fetching', 'routing'];

const secs = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);

/**
 * 知识库 / 引擎**阶段阶梯**（主窗口与浮窗共用同一份实现）。
 *
 * - 生成中：一层一层往下追加，逐行显示「阶段名 · 细节 …… 耗时」，当前行转圈并实时计时；
 * - 结束后：自动折叠成一行汇总（`知识库检索 · 5 步 · 14.6s`），点击可展开看逐行明细；
 * - 汇总文案按**实际发生过的阶段**取：只有 prefill（没开知识库 / 本轮没检索）时
 *   显示「正在载入上下文 · X.Xs」，不写「知识库检索」；
 * - 记录随消息持久化（localStorage）→ 切窗口 / 切会话 / 关掉所有窗口 / 退出 App 再开，都还在。
 * - 顺序上它渲染在思考条**上方**（思考条在最下面），与时间线一致。
 */
export const StageLadder: React.FC<StageLadderProps> = ({
  messageId,
  records,
  recording,
  phasesActive,
  turnStage,
  prefillStartedAt,
  onRecordsChange,
}) => {
  const { t } = useI18n();
  const [live, setLive] = useState<TurnStageRecord[]>(records ?? []);
  const [now, setNow] = useState<number>(() => Date.now());
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  // 供记录器在 interval 里读取最新值（避免把依赖塞进 effect 导致定时器每 token 重启）
  const liveRef = useRef(live);
  liveRef.current = live;
  const turnStageRef = useRef(turnStage);
  turnStageRef.current = turnStage;
  const prefillStartRef = useRef(prefillStartedAt);
  prefillStartRef.current = prefillStartedAt;
  const onRecordsChangeRef = useRef(onRecordsChange);
  onRecordsChangeRef.current = onRecordsChange;

  // 非生成方（或本轮已结束）：跟随消息里的记录
  useEffect(() => {
    if (recording) return;
    const incoming = records ?? [];
    // 只在消息里的记录不少于本地时同步，避免收尾那一帧把最后一行耗时抹掉
    setLive((prev) => (incoming.length >= prev.length ? incoming : prev));
  }, [records, recording]);

  /**
   * 时钟：只要**阶段还在进行**就每 250ms 刷一次（生成方与镜像窗口都要）。
   * 镜像窗口不轮询，不在这里补时钟的话，进行中那行的耗时会冻结在最后一次渲染的值上。
   */
  useEffect(() => {
    if (!phasesActive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [phasesActive]);

  /**
   * 观察到进入 prefill 就**立刻**开一行（不等下一次轮询）：
   * prefill 有可能只持续几十毫秒，靠 250ms 轮询会整行漏掉。
   */
  useEffect(() => {
    if (!recording || turnStage !== 'prefill') return;
    const t0 = Date.now();
    const cur = liveRef.current;
    const last = cur[cur.length - 1];
    if (last && last.kind === 'prefill') return;
    const closed =
      last && last.endedAt === undefined
        ? [...cur.slice(0, -1), { ...last, endedAt: t0, durationMs: t0 - last.startedAt }]
        : cur;
    const next = [...closed, { kind: 'prefill' as TurnStageKind, startedAt: prefillStartRef.current ?? t0 }];
    setLive(next);
    onRecordsChangeRef.current?.(messageId, next);
  }, [recording, turnStage, prefillStartedAt, messageId]);

  // 记录器（仅生成方窗口）
  useEffect(() => {
    if (!recording) return;
    const turnStartedAt = Date.now();
    let stopped = false;
    const push = (next: TurnStageRecord[]) => {
      setLive(next);
      onRecordsChangeRef.current?.(messageId, next);
    };

    const tick = async () => {
      if (stopped) return;
      const t0 = Date.now();
      setNow(t0);
      const cur = liveRef.current;
      const last = cur[cur.length - 1];

      // —— 引擎 prefill 阶段：不看服务端打点，直接维持一行「正在载入上下文」——
      if (turnStageRef.current === 'prefill') {
        if (!last || last.kind !== 'prefill') {
          const closed =
            last && last.endedAt === undefined
              ? [...cur.slice(0, -1), { ...last, endedAt: t0, durationMs: t0 - last.startedAt }]
              : cur;
          push([...closed, { kind: 'prefill', startedAt: prefillStartRef.current ?? t0 }]);
        }
        return;
      }

      // —— 知识库检索阶段：轮询服务端真实打点 ——
      try {
        const res = await fetch('/api/wiki/rag-stage');
        if (!res.ok) return;
        const j = await res.json();
        const fresh = j && j.found && typeof j.at === 'number' && j.at >= turnStartedAt - 1500;
        if (!fresh) return;
        const kind = j.stage as TurnStageKind;
        if (!RECORDABLE.includes(kind)) return;
        const detail: string | undefined = j.detail ? String(j.detail) : undefined;
        const lastKind = last?.kind;
        const lastDetail = last?.detail;
        if (!last || lastKind !== kind || lastDetail !== detail) {
          const closed =
            last && last.endedAt === undefined
              ? [...cur.slice(0, -1), { ...last, endedAt: t0, durationMs: t0 - last.startedAt }]
              : cur;
          push([...closed, { kind, detail, startedAt: Date.now() }]);
        }
      } catch {
        // 代理不可达：静默（不打断生成）
      }
    };

    tick();
    const timer = window.setInterval(tick, 250);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      // 收尾：关掉还没结束的那一行（正常拿到首个 token / 中止 / 出错都走这里）
      const cur = liveRef.current;
      const last = cur[cur.length - 1];
      if (last && last.endedAt === undefined) {
        const tEnd = Date.now();
        onRecordsChangeRef.current?.(messageId, [
          ...cur.slice(0, -1),
          { ...last, endedAt: tEnd, durationMs: tEnd - last.startedAt },
        ]);
      }
    };
  }, [recording, messageId]);

  const list = live;
  if (list.length === 0) return null;

  const open = userOpen ?? phasesActive; // 阶段进行中默认展开；完全结束后默认折叠成一行汇总
  const totalMs = list.reduce(
    (acc, r) => acc + (r.endedAt !== undefined ? r.durationMs ?? 0 : now - r.startedAt),
    0
  );

  /**
   * 汇总文案按**实际发生过的阶段**取标签：
   * 只有 prefill（没开知识库 / 本轮没检索）时不能写成「知识库检索」，
   * 否则用户会以为系统偷偷检索了知识库。
   */
  const hasRetrievalStages = list.some((r) => r.kind !== 'prefill');
  const steps = list.length === 1 ? `1${t('stageStepUnit')}` : `${list.length}${t('stageStepsUnit')}`;
  const summaryText = hasRetrievalStages
    ? `${t('stageSummaryLabel')} · ${steps} · ${secs(totalMs)}s`
    : `${t('prefillLoading')} · ${secs(totalMs)}s`;

  return (
    <div className="my-2.5 text-sm" data-stage-ladder>
      {/* 汇总行（与思考条同款交互：图标 + 灰字 + 箭头）。
          图标/配色看的是 **phasesActive**（阶段是否还在进行），不是“本窗口是否在记录”——
          镜像窗口同样要显示“进行中”的转圈，否则会出现“汇总已完成、行还在转圈”的矛盾。 */}
      <button
        onClick={() => setUserOpen(!open)}
        data-stage-ladder-summary
        className="w-full flex items-center gap-2 py-0.5 group/ladder text-left cursor-pointer select-none"
      >
        {phasesActive ? (
          <Loader2 className="w-4 h-4 text-blue-500 dark:text-blue-400 animate-spin flex-shrink-0" />
        ) : (
          <Check className="w-4 h-4 text-blue-500 dark:text-blue-400 flex-shrink-0" />
        )}
        <span
          className={`text-[13px] font-medium transition-colors ${
            phasesActive
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-zinc-500 dark:text-zinc-400 group-hover/ladder:text-zinc-700 dark:group-hover/ladder:text-zinc-300'
          }`}
        >
          {summaryText}
        </span>
        <ChevronRight
          className={`w-4 h-4 text-zinc-400 dark:text-zinc-500 transition-transform duration-200 ${
            open ? 'rotate-90' : ''
          }`}
        />
      </button>

      {/* 逐行明细：左侧细竖线，与思考条同样的视觉语言 */}
      {open && (
        <div className="mt-1.5 mb-1 ml-[7px] pl-3.5 border-l-2 border-black/[0.07] dark:border-white/[0.09] space-y-1 select-text">
          {list.map((r, i) => {
            const done = r.endedAt !== undefined;
            const ms = done ? r.durationMs ?? 0 : now - r.startedAt;
            const label = t(KIND_LABEL_KEY[r.kind]);
            return (
              <div key={`${r.kind}-${i}`} data-stage-ladder-row className="flex items-center gap-2 text-xs leading-relaxed">
                {done ? (
                  <Check className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400 flex-shrink-0" />
                ) : (
                  <Loader2 className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400 animate-spin flex-shrink-0" />
                )}
                <span className="text-zinc-600 dark:text-zinc-400 truncate">
                  {r.detail ? `${label} · ${r.detail}` : label}
                </span>
                <span className="ml-auto pl-2 tabular-nums text-zinc-400 dark:text-zinc-500">{secs(ms)}s</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
