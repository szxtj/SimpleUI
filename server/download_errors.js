// 下载失败的规范化错误码。
//
// 以前前端靠 `err.includes('所有下载源均不可达')` 这类**文案匹配**来判断错误类型：
// 后端改一个字，前端的分类就失效，界面会退化成「直接显示后端原始消息」。
// 现在由下载方在抛错时带上 code，前端只认 code，与文案彻底解耦。
//
// 只有三类前端需要区别对待的失败；具体细节（哪个文件、HTTP 多少）仍放在 message 里，
// 用于排查日志，不参与分类。

export const DOWNLOAD_ERROR = {
  /** 官方源与镜像都连不上（或探测阶段就失败） */
  ALL_SOURCES_UNREACHABLE: 'ALL_SOURCES_UNREACHABLE',
  /** 下载完成但字节数不足/超出（截断的坏文件） */
  FILE_SIZE_MISMATCH: 'FILE_SIZE_MISMATCH',
  /** 其它失败：HTTP 状态异常、连接中断、磁盘错误等 */
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
};

/** 造一个带 code 的 Error（message 仍保留细节，供日志排查） */
export function downloadError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/**
 * 归类一个已经抛出的错误。
 *
 * 下载器在已知节点会显式用 downloadError()，这里主要兜住底层异常
 * （ECONNRESET / ENOSPC / ENOENT…）。保留对历史消息的识别，是为了兼容
 * 那些还没改成显式 code 的分支，而不是让调用方去解析文案。
 */
export function classifyDownloadError(err) {
  if (err && typeof err.code === 'string' && err.code.startsWith('DOWNLOAD')) return err.code;
  if (err && typeof err.code === 'string' && DOWNLOAD_ERROR[err.code]) return err.code;
  const msg = String((err && err.message) || '');
  if (msg.includes(DOWNLOAD_ERROR.ALL_SOURCES_UNREACHABLE)) return DOWNLOAD_ERROR.ALL_SOURCES_UNREACHABLE;
  if (msg.includes(DOWNLOAD_ERROR.FILE_SIZE_MISMATCH)) return DOWNLOAD_ERROR.FILE_SIZE_MISMATCH;
  return DOWNLOAD_ERROR.DOWNLOAD_FAILED;
}
