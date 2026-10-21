/**
 * 受管服务状态的统一状态定义。
 *
 * 主界面左下角、状态栏菜单与服务控制面板卡片共用统一的语义与样式映射：
 *
 *   online    绿灯    就绪
 *   offline   红灯    离线
 *   starting  黄灯    启动中
 *   standby   天蓝灯  待命（按需服务模型已就绪但未驻留内存）
 */
export type ServiceState = 'online' | 'offline' | 'starting' | 'standby';

/** 后端 status 字段 → 统一状态（未知 / 缺失一律按离线处理） */
export function toServiceState(status?: string | null): ServiceState {
  switch (status) {
    case 'running':
    case 'ready':
      return 'online';
    case 'loading':
    case 'starting':
    case 'start':
    case 'restart':
      return 'starting';
    case 'standby':
      return 'standby';
    default:
      return 'offline';
  }
}

/** 状态 → i18n 文案 key */
export const SERVICE_STATE_LABEL_KEY = {
  online: 'statusReady',
  offline: 'statusOffline',
  starting: 'statusStarting',
  standby: 'statusStandby',
} as const;

/** 状态 → 状态圆点样式（颜色语义与状态栏菜单的红 / 绿 / 黄 / 蓝保持一致） */
export const SERVICE_STATE_DOT_CLASS: Record<ServiceState, string> = {
  online: 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.7)]',
  offline: 'bg-red-400',
  starting: 'bg-amber-500 animate-pulse',
  standby: 'bg-sky-500 shadow-[0_0_6px_rgba(14,165,233,0.6)]',
};

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
