import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Loader2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { TranslationKeys } from '../i18n/translations';
import { TurnStageKind, TurnStageRecord } from '../types/chat';

interface StageLadderProps {
  messageId: string;
  /** 已记录的阶段（由服务端 session_service.js 权威记账并随消息推送） */
  records?: TurnStageRecord[];
  /**
   * 阶段是否**仍在进行**（= 消息还 pending 且未出错）。
   * 决定默认展开/收起：没完全结束就不收起，完全结束（首个 token 到达 / 出错 / 中止）后自动收起成一行汇总。
   */
  phasesActive: boolean;
  /** pending 期间的细分阶段：'rag' 知识库检索 / 'prefill' 引擎载入上下文 */
  turnStage?: 'rag' | 'prefill';
  /** prefill 开始时刻（用于给「正在载入上下文」这行计时） */
  prefillStartedAt?: number;
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

/**
 * 阶梯分**两块**独立渲染，与「知识库检索」和「引擎载入上下文」的分工一致：
 *   - `rag`    ：服务端打点的检索阶段（规划检索词 / 定位条目 / 选义项 / 抓原文 / 规划小节）；
 *   - `prefill`：引擎 prefill（载入上下文），**不是检索的一步** —— 因此它不参与
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
 * 知识库 / 引擎**阶段阶梯**（主窗口与浮窗共用同一份纯受控展示实现）。
 *
 * 阶段记录由服务端 `server/session_service.js` 直接监听 `wiki_service` 进程内事件生成，
 * 通过 SSE 实时广播到所有窗口；前端不再轮询 `/api/wiki/rag-stage`，从根源上消除双写与闪烁。
 */
export const StageLadder: React.FC<StageLadderProps> = ({
  records,
  phasesActive,
  turnStage,
  prefillStartedAt,
}) => {
  const { t } = useI18n();
  const [now, setNow] = useState<number>(() => Date.now());
  /** 逐块记录用户的展开/收起选择（未点过时按 phasesActive 取默认） */
  const [userOpen, setUserOpen] = useState<Partial<Record<LadderBlockKey, boolean>>>({});

  /**
   * 时钟：只要阶段还在进行就每 250ms 刷一次，使进行中那行的耗时实时跳动。
   */
  useEffect(() => {
    if (!phasesActive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [phasesActive]);

  const list = useMemo(() => {
    let cur = records ?? [];
    if (turnStage === 'prefill' && !cur.some((r) => r.kind === 'prefill')) {
      const t0 = prefillStartedAt ?? Date.now();
      const closed = cur.map((r) =>
        r.endedAt === undefined ? { ...r, endedAt: t0, durationMs: Math.max(0, t0 - r.startedAt) } : r
      );
      cur = [...closed, { kind: 'prefill' as TurnStageKind, startedAt: t0 }];
    }
    if (phasesActive && cur.length === 0) {
      const t0 = prefillStartedAt ?? Date.now();
      const fallbackKind: TurnStageKind = turnStage === 'rag' ? 'planning' : 'prefill';
      cur = [{ kind: fallbackKind, startedAt: t0 }];
    }
    if (!phasesActive) {
      cur = cur.map((r) =>
        r.endedAt === undefined
          ? { ...r, endedAt: r.startedAt + (r.durationMs ?? 0), durationMs: r.durationMs ?? 0 }
          : r
      );
    }
    return cur;
  }, [records, turnStage, prefillStartedAt, phasesActive]);

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

  const blocks = BLOCK_ORDER.map((key) => ({
    key,
    rows: list.filter((r) => blockOf(r) === key),
  })).filter((b) => b.rows.length > 0);

  return (
    <div className="my-2.5 text-sm space-y-2.5" data-stage-ladder>
      {blocks.map(({ key, rows }) => {
        const single = rows.length === 1;
        if (single) {
          const r = rows[0];
          const isRowActive = phasesActive && (r.endedAt === undefined || turnStage === key);
          const isRowDone = !phasesActive || (!isRowActive && r.endedAt !== undefined);
          return (
            <div key={key} data-stage-ladder-single={key} className="flex items-center gap-2">
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

        const open = userOpen[key] ?? phasesActive;
        const isBlockActive =
          phasesActive && (turnStage === key || rows.some((r) => r.endedAt === undefined));
        const isBlockDone = !phasesActive || !isBlockActive;
        const totalMs = totalOf(rows);
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

            {open && (
              <div className="mt-1.5 mb-1 ml-[7px] pl-3.5 border-l-2 border-black/[0.07] dark:border-white/[0.09] space-y-1 select-text">
                {rows.map((r, i) => {
                  const isCurrentStep =
                    isBlockActive && (i === rows.length - 1 || r.endedAt === undefined);
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
