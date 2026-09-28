import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '../i18n';

interface TurnStageIndicatorProps {
  /** 当前回合所处阶段：知识库检索 / 引擎 prefill */
  stage: 'rag' | 'prefill';
  /** true = 占位消息尚未收到任何 token */
  active: boolean;
  /** 本次请求的发出时刻（ms epoch）——用于计算已等待秒数 */
  startedAt: number;
}

/** 指示器渲染形态（全部为转圈样式，与思考条一致） */
interface StageView {
  text: string;
  elapsed: string;
}

/**
 * 回合阶段指示器（大窗口 / 浮窗共用，与思考条同风格）。
 *
 * 阶段机（chatTurn.ts）保证**任何时刻最多显示一个阶段指示器**：
 *   rag（检索/消歧/路由）→ prefill → 思考条 → 内容
 *
 * **设计原则（重要）**：prefill 阶段采用**纯本地状态驱动**——消息已发出即显示转圈，
 * 不轮询 TTF 日志、不算百分比/token。此前的 TTF 日志轮询方案（估算百分比、
 * 真实分块计数、归属判定、排队检测）依赖大量时序窗口（SSE 首块时机、
 * 日志归属、串行排队），反复出 bug，已按用户要求整体移除。
 *
 * rag 阶段：轮询 /api/wiki/rag-stage（wiki_service 自身管线的打点，非全局日志，
 * 归属天然正确），显示规划检索词 / 定位条目 / 选择义项 / 抓取原文 / 规划小节。
 * 数据不可用时静默降级为「检索知识库」通用文案。
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

    const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1);

    // ---- prefill 阶段：纯本地驱动（消息已发出 = 正在载入上下文）----
    if (stage === 'prefill') {
      const show = () => {
        if (!stopped) setView({ text: t('prefillLoading'), elapsed: elapsed() });
      };
      show();
      timer = window.setInterval(show, 250);
      return () => {
        stopped = true;
        if (timer) window.clearInterval(timer);
      };
    }

    // ---- rag 阶段：轮询服务端管线打点 ----
    const isFresh = (at?: number) =>
      typeof at === 'number' && !Number.isNaN(at) && at >= startedAt - 1500;

    const poll = async () => {
      let label: string | null = null;
      try {
        const res = await fetch('/api/wiki/rag-stage');
        if (res.ok) {
          const j = await res.json();
          if (j && j.found && isFresh(j.at)) {
            const d = j.detail ? ` · ${j.detail}` : '';
            label =
              j.stage === 'planning'
                ? t('stagePlanning')
                : j.stage === 'resolving'
                  ? t('stageResolving') + d
                  : j.stage === 'sense'
                    ? t('stageSense') + d
                    : j.stage === 'fetching'
                      ? t('stageFetching') + d
                      : j.stage === 'routing'
                        ? t('stageRouting') + d
                        : t('stageSearching');
          }
        }
      } catch {
        // 代理不可达：静默
      }
      if (!stopped) {
        // 仅当服务端报告了新鲜的 rag 阶段才显示；否则不渲染
        // （避免知识库关闭时闪现无意义的「检索知识库」）
        setView(label ? { text: label, elapsed: elapsed() } : null);
      }
    };

    poll();
    timer = window.setInterval(poll, 250);
    return () => {
      stopped = true;
      if (timer) window.clearInterval(timer);
    };
  }, [stage, active, startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active || !view) return null;

  return (
    <div className="my-2.5 flex items-center gap-2 select-none">
      <Loader2 className="w-4 h-4 text-blue-500 dark:text-blue-400 animate-spin flex-shrink-0" />
      <span className="text-[13px] font-medium text-blue-600 dark:text-blue-400">{view.text}</span>
      <span className="text-xs text-zinc-400 dark:text-zinc-500 tabular-nums">{view.elapsed}s</span>
    </div>
  );
};
