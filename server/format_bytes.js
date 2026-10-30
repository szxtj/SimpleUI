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
