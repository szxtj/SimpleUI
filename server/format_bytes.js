// 模型体积的唯一格式化入口（所有服务的 status 都用它生成 sizeDesc）。
//
// 为什么要有这个文件：以前 sizeDesc 是各服务各自写死的字符串（'2.31 GB' / '1.25 GB' /
// '1.09 GB'…），前端还会再自己按字节算一遍（toFixed(2) 当 GiB），于是同一个模型在字幕页
// 显示 1.22 GB、在快速翻译页显示 1.25 GB —— 两个口径各说各话。现在只在这里算：
//   * 输入永远是真实字节数（expectedBytes 优先，未下载时也能给出正确大小）；
//   * 1024 进制（模型权重的通行口径），单位写 GB / MB / KB；
//   * 去掉无意义的尾零：964 MB 不写成 964.0 MB，2.31 GB 不写成 2.310 GB。

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  const GiB = 1024 ** 3;
  const MiB = 1024 ** 2;
  const trim = (v) => String(parseFloat(v));
  if (n >= GiB) return `${trim((n / GiB).toFixed(2))} GB`;
  if (n >= MiB) return `${Math.round(n / MiB)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/**
 * 十进制体积（1 GB = 10^9 B）—— 与 HuggingFace 页面、访达「显示简介」、系统设置同一口径。
 *
 * 只给「用户会拿去和外部数字对照」的地方用（目前仅 3D 场景构建的模型体积）。
 * 其它服务继续用 formatBytes（1024 进制），两套不要混用、也不要互相替换：
 * 同一个 3,568,995,926 B，这里显示 3.57 GB，formatBytes 显示 3.32 GB（GiB）。
 */
export function formatBytesSI(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  const digits = i >= 3 ? 2 : i === 2 ? 1 : 0;
  return `${parseFloat(v.toFixed(digits))} ${units[i]}`;
}
