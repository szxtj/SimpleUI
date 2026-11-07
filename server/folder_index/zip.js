import fs from 'fs';
import zlib from 'zlib';

/**
 * 极简 ZIP 读取器（只读、按需解压单个条目）。
 *
 * 为什么不用 adm-zip：它没装在本项目里，而 Electron / Node 侧也没有内置解压。
 * docx / pptx / xlsx 都是 ZIP（stored 或 deflate），我们只需要按名字取一两个
 * XML 出来，自己解析中央目录就够了 —— 一个依赖能省就省。
 *
 * 支持：method 0（store）、method 8（deflate）。不支持 zip64 与加密，
 * 这两种在 Office 文档里基本不会出现（超过 4GB 才会 zip64）。
 */
export function readZipEntries(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const tailLen = Math.min(stat.size, 66 * 1024);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, stat.size - tailLen);

    // 找 EOCD（End Of Central Directory）签名 0x06054b50，从尾部向前扫
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file');

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);

    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const rawSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      entries.push({ name, method, compSize, rawSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }

    return {
      names: entries.map((e) => e.name),
      read(name) {
        const e = entries.find((x) => x.name === name);
        if (!e) return null;
        // 本地文件头长度可变（文件名 + extra），必须重读一次拿真实数据偏移
        const head = Buffer.alloc(30);
        fs.readSync(fd, head, 0, 30, e.localOffset);
        if (head.readUInt32LE(0) !== 0x04034b50) return null;
        const dataStart = e.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
        const buf = Buffer.alloc(e.compSize);
        fs.readSync(fd, buf, 0, e.compSize, dataStart);
        if (e.method === 0) return buf;
        if (e.method === 8) return zlib.inflateRawSync(buf);
        return null;
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}
