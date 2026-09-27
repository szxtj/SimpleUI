import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '../i18n';

interface TurnStageIndicatorProps {
  /** 当前回合所处阶段：知识库检索 / 引擎 prefill */
  stage: 'rag' | 'prefill';
  /** true = 占位消息尚未收到任何 token */
  active: boolean;
  /** 本次请求的发出时间（ms epoch）——用于过滤掉日志/状态里上一轮的残留记录 */
  startedAt: number;
}

/** 指示器的渲染形态：spinner = 无百分比阶段；ring = 有百分比阶段（圆环填充） */
interface StageView {
  kind: 'spinner' | 'ring';
  text: string;
  percent?: number;
  tokens?: string;
  /** rag 阶段的累计已等待秒数 */
  elapsed?: string;
}

/**
 * 回合阶段指示器（大窗口 / 浮窗共用，与思考条同风格）。
 *
 * 阶段机（chatTurn.ts）保证**任何时刻只有一个阶段指示器**：
 *   rag（检索/消歧/路由，spinner）→ prefill（圆环填充百分比）→ 思考条 → 内容
 *
 * - rag 阶段：轮询 /api/wiki/rag-stage（服务端在管线各步打点：规划/定位/组装），
 *   这些阶段会调用主力模型、时长不可预测 → 只转圈不显示百分比。
 * - prefill 阶段：轮询 /api/ttf/prefill。TTF server 不暴露实时进度，百分比按
 *   「已等待秒数 × 近期实测速率 ÷ prompt 总数」估算（封顶 99）。实测估算与真实
 *   prefill 计数的偏差很小（速率来自同机同模型的连续实测），足够精确。
 * - 任一数据源不可用 → 静默不渲染。
 */
export const TurnStageIndicator: React.FC<TurnStageIndicatorProps> = ({ stage, active, startedAt }) => {
  const { t } = useI18n();
  const [view, setView] = useState<StageView | null>(null);

  useEffect(() => {
    if (!active) {
      setView(null);
      return;
    }
    let stopped = false;
    let timer: number | undefined;

    const poll = async (
      url: string,
      interpret: (j: any) => StageView | null
    ) => {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const j = await res.json();
          const v = interpret(j);
          // 每次轮询直接提交（阶段是单调前进的，不存在来回闪烁；
          // 任何驻留/防抖都会把短于驻留期的真实阶段吞掉——那比闪烁更糟）
          if (!stopped) setView(v);
          return;
        }
      } catch {
        // 代理不可达 / 非对应引擎：静默降级
      }
      if (!stopped) setView(null);
    };

    // 记录时间戳必须是本次请求发出之后写入的，否则是上一轮的残留。
    // ⚠️ 两种类型都要支持：rag-stage 的 at 是 epoch 毫秒数（Node Date.now()），
    // ttf 日志的 at 是 ISO 字符串（Swift 写入，带 Z）。按单一类型处理会让
    // 其中一路的时间戳判定永远失败 → 阶段指示器静默不渲染。
    const isFresh = (at?: string | number) => {
      if (at === undefined || at === null || at === '') return false;
      const ts = typeof at === 'number' ? at : Date.parse(at.endsWith('Z') ? at : at + 'Z');
      return !Number.isNaN(ts) && ts >= startedAt - 1500;
    };

    const tick = () => {
      if (stage === 'rag') {
        return poll('/api/wiki/rag-stage', (j) => {
          if (!j || !j.found || !isFresh(j.at)) return null;
          const d = j.detail ? ` · ${j.detail}` : '';
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          switch (j.stage) {
            case 'planning':
              return { kind: 'spinner', text: t('stagePlanning'), elapsed };
            case 'resolving':
              return { kind: 'spinner', text: t('stageResolving') + d, elapsed };
            case 'sense':
              return { kind: 'spinner', text: t('stageSense') + d, elapsed };
            case 'fetching':
              return { kind: 'spinner', text: t('stageFetching') + d, elapsed };
            case 'routing':
              return { kind: 'spinner', text: t('stageRouting'), elapsed };
            default:
              return { kind: 'spinner', text: t('stageSearching'), elapsed };
          }
        });
      }
      return poll('/api/ttf/prefill', (j) => {
        if (!j || !j.found || !j.inFlight || !(j.promptTokens > 0) || !isFresh(j.at)) return null;
        const tokens = j.promptTokens as number;
        // 估算：已等待秒数 × 近期实测速率 ÷ prompt 总数（封顶 99，真实值未知）
        const elapsedSec = Math.max(0, (Date.now() - startedAt) / 1000);
        const rate = (j.rate ?? 0) > 0 ? j.rate : 30;
        const percent = Math.min(99, Math.round((elapsedSec * rate * 100) / tokens));
        return {
          kind: 'ring',
          text: `${t('prefillLoading')} ${percent}%`,
          percent,
          tokens: tokens.toLocaleString(),
        };
      });
    };

    tick();
    timer = window.setInterval(tick, 250);
    return () => {
      stopped = true;
      if (timer) window.clearInterval(timer);
    };
  }, [stage, active, startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active || !view) return null;

  return (
    <div className="my-2.5 flex items-center gap-2 select-none">
      {view.kind === 'ring' && view.percent !== undefined ? (
        <RingGauge percent={view.percent} />
      ) : (
        <Loader2 className="w-4 h-4 text-blue-500 dark:text-blue-400 animate-spin flex-shrink-0" />
      )}
      <span className="text-[13px] font-medium text-blue-600 dark:text-blue-400">{view.text}</span>
      {view.tokens && (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{view.tokens} tokens</span>
      )}
      {view.kind === 'spinner' && view.elapsed && (
        <span className="text-xs text-zinc-400 dark:text-zinc-500 tabular-nums">{view.elapsed}s</span>
      )}
    </div>
  );
};

/** 圆环进度（填充比例 = 百分比），替代横向进度条 */
const RingGauge: React.FC<{ percent: number }> = ({ percent }) => {
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90 flex-shrink-0">
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        className="stroke-black/15 dark:stroke-white/20"
      />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
        className="stroke-blue-500 dark:stroke-blue-400 transition-all duration-300 ease-out"
      />
    </svg>
  );
};
