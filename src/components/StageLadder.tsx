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

/**
 * 阶梯分**两块**独立渲染，与「知识库检索」和「引擎载入上下文」的分工一致：
 *   - `rag`    ：服务端打点的检索阶段（规划检索词 / 定位条目 / 选义项 / 抓原文 / 规划小节）；
 *   - `prefill`：引擎 prefill（客户端打点），**不是检索的一步** —— 因此它不参与
 *                「知识库检索 · N 步 · X.Xs」的步数与耗时。
 */
type LadderBlockKey = 'rag' | 'prefill';
const BLOCK_ORDER: LadderBlockKey[] = ['rag', 'prefill'];

/** 记录属于哪一块 */
const blockOf = (r: TurnStageRecord): LadderBlockKey => (r.kind === 'prefill' ? 'prefill' : 'rag');

const secs = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);

/** 行的图标：进行中转圈 / 结束打勾（汇总行与明细行只有尺寸差异） */
const RowIcon: React.FC<{ done: boolean; small?: boolean }> = ({ done, small }) => {
  const cls = small ? 'w-3.5 h-3.5' : 'w-4 h-4';
  return done ? (
    <Check className={`${cls} text-blue-500 dark:text-blue-400 flex-shrink-0`} />
  ) : (
    <Loader2 className={`${cls} text-blue-500 dark:text-blue-400 animate-spin flex-shrink-0`} />
  );
};

interface LadderRowProps {
  /** `阶段名 · 细节`，或汇总行文案（步数汇总） */
  text: string;
  ms: number;
  done: boolean;
  /** 行是否"活着"（= 阶段还在进行）：决定配色，与 done 是同一件事的两面 */
  active: boolean;
  /** 摘要行 / 单步行（13px 字，耗时长在文案里）；明细行（12px，耗时右对齐） */
  headline?: boolean;
  /** 有子行时才给箭头；点击由外层 button 负责 */
  expandable?: boolean;
  open?: boolean;
}

/**
 * 阶梯里的一行。三处用它：块汇总行、单步行、缩进明细行 —— 视觉语言统一，
 * 只靠 `headline` / `small` 两级尺寸区分层级（summary/single 走 headline，明细走另一级）。
 */
const LadderRow: React.FC<LadderRowProps> = ({ text, ms, done, active, headline, expandable, open }) => (
  <>
    <RowIcon done={done} small={!headline} />
    <span
      className={
        headline
          ? `text-[13px] font-medium transition-colors ${
              active
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-zinc-500 dark:text-zinc-400 group-hover/ladder:text-zinc-700 dark:group-hover/ladder:text-zinc-300'
            }`
          : 'text-zinc-600 dark:text-zinc-400 truncate'
      }
    >
      {headline ? `${text} · ${secs(ms)}s` : text}
    </span>
    {expandable && (
      <ChevronRight
        className={`w-4 h-4 text-zinc-400 dark:text-zinc-500 transition-transform duration-200 ${
          open ? 'rotate-90' : ''
        }`}
      />
    )}
    {!headline && (
      <span className="ml-auto pl-2 tabular-nums text-zinc-400 dark:text-zinc-500">{secs(ms)}s</span>
    )}
  </>
);

/**
 * 知识库 / 引擎**阶段阶梯**（主窗口与浮窗共用同一份实现）。
 *
 * - 生成中：一层一层往下追加，逐行显示「阶段名 · 细节 …… 耗时」，当前行转圈并实时计时；
 * - 结束后：每块自动折叠成一行汇总（`知识库检索 · 5 步 · 14.6s`），点击可展开看逐行明细；
 * - **两块分列**：知识库检索与「正在载入上下文」（引擎 prefill）各自成块 ——
 *   prefill 不算检索的一步，步数与耗时都不混入「知识库检索」；
 * - **只有一行时不套壳**：任何一块只记到一行（例如本轮没检索、只有 prefill）就直接显示
 *   那一行本身，不再渲染「汇总行 + 缩进里一行一模一样的明细」这种重复结构；
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
  const [live, setLive] = useState<TurnStageRecord[]>(() => {
    const init = records ?? [];
    let cur = init;
    if (turnStage === 'prefill' && !cur.some((r) => r.kind === 'prefill')) {
      const t0 = prefillStartedAt ?? Date.now();
      const closed = cur.map((r) =>
        r.endedAt === undefined ? { ...r, endedAt: t0, durationMs: t0 - r.startedAt } : r
      );
      cur = [...closed, { kind: 'prefill', startedAt: t0 }];
    }
    if (!phasesActive) {
      cur = cur.map((r) =>
        r.endedAt === undefined
          ? { ...r, endedAt: r.startedAt + (r.durationMs ?? 0), durationMs: r.durationMs ?? 0 }
          : r
      );
    }
    return cur;
  });
  const [now, setNow] = useState<number>(() => Date.now());
  /** 逐块记录用户的展开/收起选择（未点过时按 phasesActive 取默认） */
  const [userOpen, setUserOpen] = useState<Partial<Record<LadderBlockKey, boolean>>>({});

  // 供记录器在 interval 里读取最新值（避免把依赖塞进 effect 导致定时器每 token 重启）
  const liveRef = useRef(live);
  liveRef.current = live;
  const turnStageRef = useRef(turnStage);
  turnStageRef.current = turnStage;
  const prefillStartRef = useRef(prefillStartedAt);
  prefillStartRef.current = prefillStartedAt;
  const onRecordsChangeRef = useRef(onRecordsChange);
  onRecordsChangeRef.current = onRecordsChange;
  const phasesActiveRef = useRef(phasesActive);
  phasesActiveRef.current = phasesActive;

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

  // 当 phasesActive 为 false 时，确保所有尚未结束的行都打上 endedAt 和 durationMs 并回写
  useEffect(() => {
    if (!phasesActive) {
      const tEnd = Date.now();
      const cur = liveRef.current;
      const hasUnclosed = cur.some((r) => r.endedAt === undefined);
      if (hasUnclosed) {
        const finalized = cur.map((r) =>
          r.endedAt === undefined
            ? { ...r, endedAt: tEnd, durationMs: Math.max(0, tEnd - r.startedAt) }
            : r
        );
        setLive(finalized);
        onRecordsChangeRef.current?.(messageId, finalized);
      }
    }
  }, [phasesActive, messageId]);

  /**
   * 观察到进入 prefill 就**立刻**开一行（不等下一次轮询）：
   * prefill 有可能只持续几十毫秒，靠 250ms 轮询会整行漏掉。
   */
  useEffect(() => {
    if (turnStage !== 'prefill') return;
    const t0 = prefillStartedAt ?? Date.now();
    const cur = liveRef.current;
    const last = cur[cur.length - 1];
    if (last && last.kind === 'prefill') return;
    const closed =
      last && last.endedAt === undefined
        ? [...cur.slice(0, -1), { ...last, endedAt: t0, durationMs: t0 - last.startedAt }]
        : cur;
    const next = [...closed, { kind: 'prefill' as TurnStageKind, startedAt: prefillStartRef.current ?? t0 }];
    setLive(next);
    if (recording) {
      onRecordsChangeRef.current?.(messageId, next);
    }
  }, [recording, turnStage, prefillStartedAt, messageId]);

  // 记录器（生成方窗口或主窗口生成中）
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
      // 收尾：仅在 phasesActive 为 false（即阶段真正结束：首个 token 到达 / 中止 / 出错）时，
      // 才关掉最后一行的 endedAt。
      // 若 phasesActive 仍为 true（只是浮窗切大窗口 unmount 或重新渲染），
      // 绝不能提前打上 endedAt，否则会把还在进行中的阶段冻结，导致大窗口停止转圈！
      if (!phasesActiveRef.current) {
        const cur = liveRef.current;
        const last = cur[cur.length - 1];
        if (last && last.endedAt === undefined) {
          const tEnd = Date.now();
          onRecordsChangeRef.current?.(messageId, [
            ...cur.slice(0, -1),
            { ...last, endedAt: tEnd, durationMs: tEnd - last.startedAt },
          ]);
        }
      }
    };
  }, [recording, messageId]);

  const list = live;
  if (list.length === 0) return null;

  /** 每行的耗时：已结束取记录值，进行中实时算 */
  const elapsed = (r: TurnStageRecord, isActive?: boolean) => {
    if (isActive) return Math.max(0, now - r.startedAt);
    if (r.durationMs !== undefined) return r.durationMs;
    if (r.endedAt !== undefined) return Math.max(0, r.endedAt - r.startedAt);
    return 0;
  };
  const totalOf = (rows: TurnStageRecord[]) =>
    rows.reduce(
      (acc, r) =>
        acc +
        (r.durationMs ??
          (r.endedAt !== undefined
            ? Math.max(0, r.endedAt - r.startedAt)
            : phasesActive
            ? Math.max(0, now - r.startedAt)
            : 0)),
      0
    );
  const rowText = (r: TurnStageRecord) => {
    const label = t(KIND_LABEL_KEY[r.kind]);
    return r.detail ? `${label} · ${r.detail}` : label;
  };

  const blocks = BLOCK_ORDER.map((key) => ({ key, rows: list.filter((r) => blockOf(r) === key) })).filter(
    (b) => b.rows.length > 0
  );

  return (
    // `space-y-2.5`：块与块之间统一 10px。
    // 这个值必须与「阶梯 → 思考条」的间距一致 —— 思考条是独立组件，
    // 它的 mt-2.5 与本容器的 mb-2.5 折叠后正好也是 10px，于是三行（检索 / 载入上下文 / 思考）
    // 的间距完全一致。行内**不再各自加 py**，否则会在这个间距上再叠 2+2px，破坏一致性。
    <div className="my-2.5 text-sm space-y-2.5" data-stage-ladder>
      {blocks.map(({ key, rows }) => {
        const single = rows.length === 1;
        // 单步不套壳：直接显示那一行，连箭头都不给（没有可展开的东西）
        if (single) {
          const r = rows[0];
          // 如果 phasesActive 为 true，且本块还在进行中（或最后一项），则为活动状态（持续转圈）
          const isRowActive = phasesActive && (r.endedAt === undefined || turnStage === key);
          const isRowDone = !phasesActive || (!isRowActive && r.endedAt !== undefined);
          return (
            <div
              key={key}
              data-stage-ladder-single={key}
              className="flex items-center gap-2"
            >
              <LadderRow
                text={rowText(r)}
                ms={elapsed(r, isRowActive)}
                done={isRowDone}
                active={isRowActive}
                headline
              />
            </div>
          );
        }

        const open = userOpen[key] ?? phasesActive; // 进行中默认展开；结束后默认折叠成一行汇总
        const isBlockActive = phasesActive && (turnStage === key || rows.some((r) => r.endedAt === undefined));
        const isBlockDone = !phasesActive || !isBlockActive;
        const totalMs = totalOf(rows);
        /*
         * 汇总文案按**实际发生过的阶段**取：只有检索阶段时才写「知识库检索 · N 步 · X.Xs」，
         * 单块 prefill 永远走上面的单步行分支，因此没人会误以为偷偷检索了知识库。
         * 耗时由 LadderRow 拼在文案后（`知识库检索 · 2 步 · 14.6s`）。
         */
        const summaryText = `${t('stageSummaryLabel')} · ${rows.length}${t('stageStepsUnit')}`;
        return (
          <div key={key} data-stage-ladder-block={key}>
            <button
              onClick={() => setUserOpen((prev) => ({ ...prev, [key]: !open }))}
              data-stage-ladder-summary={key}
              className="w-full flex items-center gap-2 group/ladder text-left cursor-pointer select-none"
            >
              <LadderRow
                text={summaryText}
                ms={totalMs}
                done={isBlockDone}
                active={isBlockActive}
                headline
                expandable
                open={open}
              />
            </button>

            {/* 逐行明细：左侧细竖线，与思考条同样的视觉语言 */}
            {open && (
              <div className="mt-1.5 mb-1 ml-[7px] pl-3.5 border-l-2 border-black/[0.07] dark:border-white/[0.09] space-y-1 select-text">
                {rows.map((r, i) => {
                  const isCurrentStep = isBlockActive && (i === rows.length - 1 || r.endedAt === undefined);
                  const isStepDone = !phasesActive || (!isCurrentStep && r.endedAt !== undefined);
                  return (
                    <div
                      key={`${r.kind}-${i}`}
                      data-stage-ladder-row
                      className="flex items-center gap-2 text-xs leading-relaxed"
                    >
                      <LadderRow
                        text={rowText(r)}
                        ms={elapsed(r, isCurrentStep)}
                        done={isStepDone}
                        active={isCurrentStep}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
