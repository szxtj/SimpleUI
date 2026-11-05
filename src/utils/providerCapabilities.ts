import { ApiProvider } from '../types/chat';

/**
 * 各 provider 的「能力」判定，集中一处，避免每个界面各写一份 if。
 *
 * 目前只有一条：Maple MLX 的思考能不能关。
 * 依据（2026-11 核实）：
 *   1. 模型自带 chat_template.jinja 的 add_generation_prompt 分支是
 *      `{{- '<|im_start|>assistant\n<think>\n' }}` —— **无条件**写入，模板里没有任何
 *      enable_thinking / thinking 变量；
 *   2. 运行时 mlx_lm.server 也没有关闭思考的开关（只有 --max-tokens 等生成参数）。
 * 所以思考对 Maple 是强制的：界面上把开关锁成「开」，点击无动作。
 *
 * 思考内容本身由服务端以 `delta.reasoning` 返回（不是 OpenAI 的 reasoning_content），
 * 解析统一在 services/api.ts 的流式处理里完成。
 */
export function isThinkingForced(provider?: ApiProvider): boolean {
  return provider === 'maple';
}

/**
 * 视觉（图片输入）支持。Maple 是纯文本 MoE（config.json 无 vision tower，
 * 引擎元数据 vision:false），不支持 image_url；此前该判断以 `isMference` 布尔
 * 散落在三个界面里，现集中到这里，加新引擎时改这一处。
 *
 * Qwen 3.5 9B 底座本身是多模态，但我们的运行时是 **mlx-lm（纯文本）**，
 * 视觉塔根本没被加载，所以按「不支持」处理 —— 传 image_url 进去只会报错或静默丢图。
 * 将来若改用 mlx-vlm 起服务，把这里去掉即可。
 */
const VISION_UNSUPPORTED = new Set<ApiProvider>(['maple', 'qwen-qa']);

export function supportsVision(provider?: ApiProvider): boolean {
  return provider ? !VISION_UNSUPPORTED.has(provider) : true;
}
