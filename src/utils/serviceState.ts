/**
 * 受管服务状态的统一判定与文案（服务管理面板 6 个板块 + 主界面左下角 + 状态栏菜单共用）。
 *
 * 四态语义：
 *
 *   online    绿灯    就绪（在线时带端口，写法固定为 `就绪 : 端口`）
 *   offline   红灯    离线
 *   starting  黄灯    启动中
 *   standby   天蓝灯  待命（按需服务模型已就绪但未驻留内存）
 *
 * 判定只有一个入口 `deriveServiceState()`，优先级自上而下：
 *
 *   ① loading 标志 / status ∈ {loading, starting, start, restart} → 启动中
 *   ② status == standby                                          → 待命
 *   ③ status ∈ {running, ready} / running 或 paused 标志          → 就绪
 *   ④ loaded（模型齐备但未驻留）                                   → 待命
 *   ⑤ 其余（stopped / incomplete / 接口不可达）                    → 离线
 *
 * 每个服务只传自己接口里真实存在的字段，不再为任何服务写特例、也不给端口兜底常量：
 * 六个 status 负载都必带端口（服务端在读取配置时就做了 Number + 范围校验），缺端口时
 * 宁可只显示「就绪」，也不要编一个端口出来。
 */
import type { TranslationKeys } from '../i18n/translations';

export type ServiceState = 'online' | 'offline' | 'starting' | 'standby';

export interface ServiceStateInput {
  /** 后端 status 字段（知识库 / 基础模型 / 语音识别 / 语音合成 / 视觉识别有；字幕没有） */
  status?: string | null;
  /** 进程存活（tts / ocr / 字幕） */
  running?: boolean;
  /** 正在加载模型（字幕） */
  loading?: boolean;
  /** 模型齐备但未驻留：tts / ocr 的 model.ready、字幕的 allReady */
  loaded?: boolean;
  /** 字幕悬浮窗开启但已暂停 */
  paused?: boolean;
}

/** 唯一的状态判定入口 */
export function deriveServiceState(input: ServiceStateInput = {}): ServiceState {
  const { status, running = false, loading = false, loaded = false, paused = false } = input;

  if (loading) return 'starting';

  switch (status) {
    case 'loading':
    case 'starting':
    case 'start':
    case 'restart':
      return 'starting';
    case 'standby':
      return 'standby';
    case 'running':
    case 'ready':
      return 'online';
    default:
      break;
  }

  // 字幕暂停只是停掉「收听」（abort ASR session、清定时器），模型、子进程与端口都还在，
  // 所以暂停按「就绪」处理，而不是掉到「待命」。
  if (running || paused) return 'online';
  if (loaded) return 'standby';
  return 'offline';
}

/** 状态 → i18n 文案 key（仅本文件使用，不对外暴露，避免再长出第二套文案映射） */
const SERVICE_STATE_LABEL_KEY = {
  online: 'statusReady',
  offline: 'statusOffline',
  starting: 'statusStarting',
  standby: 'statusStandby',
} as const;

type Translate = (key: TranslationKeys) => string;

/**
 * 状态 → 展示文案，六个板块与状态栏菜单共用同一条规则：
 *   就绪时带端口 → `就绪 : 1255`（端口缺省则只写「就绪」）；其余状态只写状态词。
 * 端口允许字符串形态（历史配置里出现过 `":1236"`），这里统一去掉前导冒号。
 */
export function formatServiceStateText(
  state: ServiceState,
  t: Translate,
  port?: number | string | null
): string {
  if (state !== 'online') {
    return t(SERVICE_STATE_LABEL_KEY[state]);
  }
  const normalized = port === undefined || port === null ? '' : String(port).replace(/^:/, '').trim();
  return normalized ? `${t('statusReady')} : ${normalized}` : t('statusReady');
}

/** 设置卡片用的圆点样式（比左下角略大、光晕更亮，沿用卡片原有视觉） */
export const SERVICE_STATE_CARD_DOT_CLASS: Record<ServiceState, string> = {
  online: 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]',
  offline: 'bg-red-500',
  starting: 'bg-amber-500 animate-pulse',
  standby: 'bg-sky-500 shadow-[0_0_6px_rgba(14,165,233,0.7)]',
};

/** 设置卡片用的状态文字样式（沿用卡片原有的文字配色） */
export const SERVICE_STATE_CARD_TEXT_CLASS: Record<ServiceState, string> = {
  online: 'text-emerald-600 dark:text-emerald-400 font-medium',
  offline: 'text-red-500 font-medium',
  starting: 'text-amber-600 dark:text-amber-400 font-medium',
  standby: 'text-sky-600 dark:text-sky-400 font-medium',
};
