/**
 * 受管服务状态的统一三态。
 *
 * 主界面左下角与状态栏图标菜单共用同一套语义，保证同一时刻两处显示一致：
 *
 *   online    绿灯    就绪
 *   offline   红灯    离线
 *   starting  黄灯    启动中
 *
 * 后端各服务的 /status 都返回 status 字段，但取值集合略有差异
 * （模型 / 语音：running | loading | stopped | starting | stopping | restart；
 *  知识库：running | starting | stopped），在这里统一收敛，避免两处各写一套判断。
 */
export type ServiceState = 'online' | 'offline' | 'starting';

/** 后端 status 字段 → 统一三态（未知 / 缺失一律按离线处理） */
export function toServiceState(status?: string | null): ServiceState {
  switch (status) {
    case 'running':
      return 'online';
    // 'start' / 'restart' 是 pendingOp 的原始值（见 ttf_service/asr_service 的 getStatus）：
    // 启动动作进行中时 status 直接就是这两个词，漏掉会把「正在启动」误判成离线。
    case 'loading':
    case 'starting':
    case 'start':
    case 'restart':
      return 'starting';
    // stopped / stopping / stop 以及接口不可达：一律离线
    default:
      return 'offline';
  }
}

/** 三态 → i18n 文案 key */
export const SERVICE_STATE_LABEL_KEY = {
  online: 'statusReady',
  offline: 'statusOffline',
  starting: 'statusStarting',
} as const;

/** 三态 → 状态圆点样式（颜色语义与状态栏菜单的红 / 绿 / 黄保持一致） */
export const SERVICE_STATE_DOT_CLASS: Record<ServiceState, string> = {
  online: 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.7)]',
  offline: 'bg-red-400',
  starting: 'bg-amber-500 animate-pulse',
};

/** 设置卡片用的圆点样式（比左下角略大、光晕更亮，沿用卡片原有视觉） */
export const SERVICE_STATE_CARD_DOT_CLASS: Record<ServiceState, string> = {
  online: 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]',
  offline: 'bg-red-500',
  starting: 'bg-amber-500 animate-pulse',
};

/** 设置卡片用的状态文字样式（沿用卡片原有的三色文字） */
export const SERVICE_STATE_CARD_TEXT_CLASS: Record<ServiceState, string> = {
  online: 'text-emerald-600 dark:text-emerald-400 font-medium',
  offline: 'text-red-500 font-medium',
  starting: 'text-amber-600 dark:text-amber-400 font-medium',
};
