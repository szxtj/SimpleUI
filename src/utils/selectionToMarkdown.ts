import React from 'react';
import { mml2omml } from 'mathml2omml';

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 从 KaTeX 节点中提取干净的标准 W3C Presentation MathML (<math xmlns="http://www.w3.org/1998/Math/MathML">...)。
 * 移除 <annotation> 与 <semantics> 包装层，并剔除 .katex-html 视觉拆字层。
 * 同时严格将浏览器 outerHTML 序列化的 &nbsp; 替换为 XML 合法实体 &#160;，防止 MSXML 报未定义实体错误。
 */
export function extractCleanMathMlForWord(katexEl: HTMLElement): string {
  const mathEl = katexEl.querySelector('math');
  if (!mathEl) return '';

  const clone = mathEl.cloneNode(true) as Element;
  clone.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
  if (katexEl.classList.contains('katex-display')) {
    clone.setAttribute('display', 'block');
  }

  // 移除 annotation / annotation-xml，避免 Word 把原始 LaTeX 源码当作公式末尾正文拼出来
  clone.querySelectorAll('annotation, annotation-xml').forEach((ann) => ann.remove());

  // 拆开 <semantics> 包装，将其子级 <mrow> 直接提升到 <math> 下，提高 Word 表格单元格内公式识别率
  const semantics = clone.querySelector('semantics');
  if (semantics) {
    while (semantics.firstChild) {
      clone.insertBefore(semantics.firstChild, semantics);
    }
    semantics.remove();
  }

  // 严格替换 &nbsp; 为 XML 标准实体 &#160;
  return clone.outerHTML.replace(/&nbsp;/g, '&#160;');
}

/**
 * 从 KaTeX 节点中提取微软 Office / WPS 原生支持的 OMML (Office Math Markup Language: <m:oMath>...)。
 * 供 Word / WPS 无论是单贴公式块、还是粘贴包含公式的表格时，直接解析为原生公式对象。
 */
export function extractOmmlForWord(katexEl: HTMLElement): string {
  const cleanMml = extractCleanMathMlForWord(katexEl);
  if (!cleanMml) return '';

  try {
    const omml = mml2omml(cleanMml);
    if (omml) {
      return omml;
    }
  } catch (err) {
    console.error('Failed to convert MathML to OMML:', err);
  }

  return cleanMml;
}

/**
 * 将多个 MathML 公式合并为一个符合 W3C 标准的单根 XML 文档（利用 <mtable columnalign="left"> 多行对齐排版）。
 * 杜绝在 Word / WPS / PPT 中粘贴多公式时因“多根节点 XML 语法解析错误”被降级显示为纯代码的缺陷。
 */
export function combineMathMlsForWord(mathmls: string[]): string {
  if (mathmls.length === 0) return '';
  if (mathmls.length === 1) return mathmls[0];

  const rows = mathmls.map((mml) => {
    const inner = mml
      .replace(/^<math[^>]*>/i, '')
      .replace(/<\/math>$/i, '')
      .trim();
    return `<mtr><mtd><mrow>${inner}</mrow></mtd></mtr>`;
  });

  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mtable columnalign="left">${rows.join('')}</mtable></math>`;
}

/**
 * 将 DOM 节点序列化为富文本 HTML（保留加粗、斜体、行内代码，并将 KaTeX 公式输出为 Word / WPS 原生 OMML 数学公式，
 * 使粘贴到 Word / WPS 时自动转换为原生公式块 Equation Block）
 */
export function serializeDomToWordCompatibleHtml(root: Node): string {
  if (root.nodeType === Node.TEXT_NODE) {
    return escapeHtml((root.textContent || '').replace(/▏/g, ''));
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return '';

  const el = root as HTMLElement;
  if (el.getAttribute('data-copy-ignore') === 'true') return '';

  if (el.classList.contains('katex-display') || el.classList.contains('katex')) {
    const omml = extractOmmlForWord(el);
    if (omml) {
      return el.classList.contains('katex-display')
        ? `<p class="MsoNormal"><m:oMathPara>${omml}</m:oMathPara></p>`
        : omml;
    }
    const cleanMathMl = extractCleanMathMlForWord(el);
    if (cleanMathMl) {
      return cleanMathMl;
    }
  }
  if (el.classList.contains('katex-html')) return '';

  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(serializeDomToWordCompatibleHtml).join('');

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `<${tag}>${inner}</${tag}>`;
    case 'p':
      return `<p>${inner}</p>`;
    case 'ul':
    case 'ol':
    case 'li':
    case 'blockquote':
      return `<${tag}>${inner}</${tag}>`;
    case 'strong':
    case 'b':
      return `<strong style="font-weight:600;">${inner}</strong>`;
    case 'em':
    case 'i':
      return `<em>${inner}</em>`;
    case 'del':
    case 's':
      return `<del>${inner}</del>`;
    case 'sub':
      return `<sub>${inner}</sub>`;
    case 'sup':
      return `<sup>${inner}</sup>`;
    case 'code':
      return `<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background-color:#eff1f3;padding:1px 4px;border-radius:3px;font-size:0.9em;">${inner}</code>`;
    case 'br':
      return '<br/>';
    case 'a': {
      const href = el.getAttribute('href') || '';
      return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
    }
    default:
      return inner;
  }
}

/**
 * 将单元格 DOM 序列化为适合 TSV（Excel / 纯文本）的文本（KaTeX 公式输出为 LaTeX 源码如 $B(\alpha, \beta)$）
 */
function serializeCellDomToLatexText(root: Node): string {
  if (root.nodeType === Node.TEXT_NODE) {
    return (root.textContent || '').replace(/▏/g, '');
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return '';

  const el = root as HTMLElement;
  if (el.getAttribute('data-copy-ignore') === 'true') return '';

  if (el.classList.contains('katex-display')) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    if (ann && ann.textContent) {
      return `$$${ann.textContent.trim()}$$`;
    }
  }
  if (el.classList.contains('katex')) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    if (ann && ann.textContent) {
      return `$${ann.textContent.trim()}$`;
    }
  }
  if (el.classList.contains('katex-html')) return '';

  let out = '';
  el.childNodes.forEach((child) => {
    out += serializeCellDomToLatexText(child);
  });
  return out;
}

/**
 * 将 DOM 表格节点序列化为标准 GFM Markdown 表格字符串
 */
export function serializeTableElementToMarkdown(tableEl: HTMLTableElement): string {
  const rows = Array.from(tableEl.querySelectorAll('tr'));
  if (rows.length === 0) return '';

  const matrix: string[][] = [];
  const alignments: ('left' | 'center' | 'right' | null)[] = [];

  rows.forEach((tr, rowIdx) => {
    const cells = Array.from(tr.querySelectorAll('th, td')) as HTMLElement[];
    if (cells.length === 0) return;
    const rowValues = cells.map((cell, colIdx) => {
      if (rowIdx === 0) {
        const alignAttr = cell.getAttribute('align') || cell.style?.textAlign || '';
        if (alignAttr.includes('center')) alignments[colIdx] = 'center';
        else if (alignAttr.includes('right')) alignments[colIdx] = 'right';
        else if (alignAttr.includes('left')) alignments[colIdx] = 'left';
        else alignments[colIdx] = null;
      }
      const rawCellMd = serializeDomNodesToMarkdown(cell.childNodes)
        .replace(/\r?\n+/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();
      return rawCellMd;
    });
    matrix.push(rowValues);
  });

  if (matrix.length === 0) return '';
  const colCount = Math.max(...matrix.map((r) => r.length), 1);

  const formatRow = (row: string[]) => {
    const padded = Array.from({ length: colCount }, (_, i) => row[i] ?? '');
    return `| ${padded.join(' | ')} |`;
  };

  const headerLine = formatRow(matrix[0]);
  const separatorCells = Array.from({ length: colCount }, (_, i) => {
    const align = alignments[i];
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    if (align === 'left') return ':---';
    return '---';
  });
  const separatorLine = `| ${separatorCells.join(' | ')} |`;

  const bodyLines = matrix.slice(1).map(formatRow);
  return [headerLine, separatorLine, ...bodyLines].join('\n');
}

/**
 * 将单元格 DOM 序列化为带样式的富文本 HTML，公式保留为 LaTeX 原文（如 $B(\alpha, \beta)$），
 * 避免 Mac Office / 其他软件在粘贴 HTML 表格时因无法识别 OMML/MathML 命名空间而发生公式文本破碎或分式线丢失。
 */
function serializeCellDomToRichHtmlWithLatex(root: Node): string {
  if (root.nodeType === Node.TEXT_NODE) {
    return escapeHtml((root.textContent || '').replace(/▏/g, ''));
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return '';

  const el = root as HTMLElement;
  if (el.getAttribute('data-copy-ignore') === 'true') return '';

  if (el.classList.contains('katex-display')) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    if (ann && ann.textContent) {
      return escapeHtml(`$$${ann.textContent.trim()}$$`);
    }
  }
  if (el.classList.contains('katex')) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    if (ann && ann.textContent) {
      return escapeHtml(`$${ann.textContent.trim()}$`);
    }
  }
  if (el.classList.contains('katex-html')) return '';

  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(serializeCellDomToRichHtmlWithLatex).join('');

  switch (tag) {
    case 'strong':
    case 'b':
      return `<strong style="font-weight:600;">${inner}</strong>`;
    case 'em':
    case 'i':
      return `<em>${inner}</em>`;
    case 'del':
    case 's':
      return `<del>${inner}</del>`;
    case 'code':
      return `<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background-color:#eff1f3;padding:1px 4px;border-radius:3px;font-size:0.9em;">${inner}</code>`;
    case 'br':
      return '<br/>';
    case 'a': {
      const href = el.getAttribute('href') || '';
      return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
    }
    default:
      return inner;
  }
}

interface DocxRunStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

function escapeXml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlTextRun(text: string, style: DocxRunStyle = {}): string {
  if (!text) return '';
  const escaped = escapeXml(text);
  let rPr = '';
  if (style.bold) rPr += '<w:b/>';
  if (style.italic) rPr += '<w:i/>';
  if (style.code) {
    rPr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F0F0F0"/>';
  }
  const spaceAttr = text.startsWith(' ') || text.endsWith(' ') ? ' xml:space="preserve"' : '';
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t${spaceAttr}>${escaped}</w:t></w:r>`;
}

function serializeCellDomToDocxRuns(root: Node, currentStyle: DocxRunStyle = {}): string {
  if (root.nodeType === Node.TEXT_NODE) {
    const text = (root.textContent || '').replace(/▏/g, '');
    return xmlTextRun(text, currentStyle);
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return '';

  const el = root as HTMLElement;
  if (el.getAttribute('data-copy-ignore') === 'true') return '';

  // KaTeX formula
  if (el.classList.contains('katex-display') || el.classList.contains('katex')) {
    const rawOmml = extractOmmlForWord(el);
    if (rawOmml) {
      // 关键点：剔除 KaTeX 生成的 \u2061 (Function Application) 以及零宽字符，彻底杜绝 Word 中的 [fo] 乱码框
      // 并确保不会嵌套 block 级别的 <m:oMathPara>
      const cleanOmml = rawOmml
        .replace(/\u2061/g, '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/<\/?m:oMathPara[^>]*>/g, '');
      return cleanOmml;
    }
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    const tex = ann?.textContent?.trim() || el.textContent || '';
    return xmlTextRun(`$${tex}$`, currentStyle);
  }
  if (el.classList.contains('katex-html')) return '';

  const tag = el.tagName.toLowerCase();
  let nextStyle = { ...currentStyle };
  if (tag === 'strong' || tag === 'b') {
    nextStyle.bold = true;
  } else if (tag === 'em' || tag === 'i') {
    nextStyle.italic = true;
  } else if (tag === 'code') {
    nextStyle.code = true;
  } else if (tag === 'br') {
    return '<w:r><w:br/></w:r>';
  }

  let result = '';
  el.childNodes.forEach((child) => {
    result += serializeCellDomToDocxRuns(child, nextStyle);
  });
  return result;
}

/**
 * 将 DOM 表格节点序列化为符合 OpenXML 标准的 document.xml 字符串。
 * 内嵌完整的原生 Word 表格边框、底纹、文字样式，并将 KaTeX 公式转换为原生的 <m:oMath> 可编辑公式块。
 */
export function serializeTableElementToDocxXml(tableEl: HTMLTableElement): string {
  const rows = Array.from(tableEl.querySelectorAll('tr'));
  if (rows.length === 0) return '';

  const rowsXml: string[] = [];

  rows.forEach((tr, rowIndex) => {
    const cells = Array.from(tr.querySelectorAll('th, td')) as HTMLElement[];
    if (cells.length === 0) return;

    const cellsXml = cells.map((cell) => {
      const isHeader = cell.tagName.toLowerCase() === 'th' || rowIndex === 0;
      const align = (cell.style?.textAlign || cell.getAttribute('align') || 'left').toLowerCase();

      let jcVal = 'left';
      if (align === 'center') jcVal = 'center';
      else if (align === 'right') jcVal = 'right';

      let tcPr = '<w:tcPr><w:tcW w:w="0" w:type="auto"/>';
      if (isHeader) {
        tcPr += '<w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/>';
      }
      tcPr += '</w:tcPr>';

      const pPr = jcVal !== 'left' ? `<w:pPr><w:jc w:val="${jcVal}"/></w:pPr>` : '';
      const runs = serializeCellDomToDocxRuns(cell, { bold: isHeader });
      const cellBody = runs.length > 0 ? runs : '<w:r><w:t/></w:r>';

      return `<w:tc>${tcPr}<w:p>${pPr}${cellBody}</w:p></w:tc>`;
    });

    rowsXml.push(`<w:tr>${cellsXml.join('')}</w:tr>`);
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="0" w:type="auto"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>
          <w:left w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>
          <w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>
          <w:right w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>
          <w:insideH w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>
          <w:insideV w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>
        </w:tblBorders>
      </w:tblPr>
      ${rowsXml.join('')}
    </w:tbl>
    <w:p/>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

/**
 * 将 DOM 表格节点序列化为 TSV（制表符分隔，公式为 LaTeX 原文）纯文本与保留 LaTeX 的 HTML 表格（供粘贴到 Excel / Numbers / 飞书 / 网页）
 */
export function serializeTableElementToRichData(tableEl: HTMLTableElement): {
  tsv: string;
  html: string;
} {
  const rows = Array.from(tableEl.querySelectorAll('tr'));
  const tsvRows: string[] = [];
  const htmlRows: string[] = [];

  rows.forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('th, td')) as HTMLElement[];
    if (cells.length === 0) return;

    const tsvCells = cells.map((cell) => {
      return serializeCellDomToLatexText(cell)
        .replace(/\r?\n+/g, ' ')
        .replace(/\t/g, ' ')
        .trim();
    });
    tsvRows.push(tsvCells.join('\t'));

    const htmlCells = cells.map((cell) => {
      const isHeader = cell.tagName.toLowerCase() === 'th';
      const tag = isHeader ? 'th' : 'td';
      const align = cell.style?.textAlign || cell.getAttribute('align') || 'left';
      const richInner = serializeCellDomToRichHtmlWithLatex(cell).trim();
      const style = isHeader
        ? `border:1px solid #d0d7de;padding:8px 12px;background-color:#f6f8fa;font-weight:600;text-align:${align};color:#1f2328;`
        : `border:1px solid #d0d7de;padding:8px 12px;text-align:${align};color:#1f2328;`;
      return `<${tag} style="${style}">${richInner}</${tag}>`;
    });
    htmlRows.push(`<tr>${htmlCells.join('')}</tr>`);
  });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body><table style="border-collapse:collapse;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;">${htmlRows.join('')}</table></body></html>`;
  return {
    tsv: tsvRows.join('\n'),
    html,
  };
}


/**
 * 递归将选中的 DOM 节点列表反解为干净的 Markdown 源码（包含 KaTeX 公式还原为 $...$ / $$...$$）
 */
export function serializeDomNodesToMarkdown(
  nodes: NodeListOf<ChildNode> | ChildNode[] | Node[],
  listDepth: number = 0
): string {
  let result = '';
  const nodeArray = Array.from(nodes);

  for (let i = 0; i < nodeArray.length; i++) {
    const node = nodeArray[i];

    if (node.nodeType === Node.TEXT_NODE) {
      result += (node.textContent || '').replace(/▏/g, '');
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const el = node as HTMLElement;

    // 1. 忽略工具栏按钮等非内容节点
    if (el.getAttribute('data-copy-ignore') === 'true') {
      continue;
    }

    // 2. 交互式公式块容器 (.interactive-math) 与 KaTeX 块级公式 (.katex-display)
    if (el.classList.contains('interactive-math')) {
      const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation && annotation.textContent) {
        const isDisplay =
          el.tagName.toLowerCase() === 'div' ||
          el.classList.contains('katex-display') ||
          el.querySelector('.katex-display') !== null;
        result += isDisplay
          ? `\n$$\n${annotation.textContent.trim()}\n$$\n\n`
          : `$${annotation.textContent.trim()}$`;
        continue;
      }
    }

    if (el.classList.contains('katex-display')) {
      const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation && annotation.textContent) {
        result += `\n$$\n${annotation.textContent.trim()}\n$$\n\n`;
        continue;
      }
    }

    // 3. KaTeX 行内公式 (.katex) 或局部选中的 .katex-mathml / math
    if (
      el.classList.contains('katex') ||
      el.classList.contains('katex-mathml') ||
      el.tagName.toLowerCase() === 'math'
    ) {
      const annotation =
        el.tagName.toLowerCase() === 'annotation'
          ? el
          : el.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation && annotation.textContent) {
        result += `$${annotation.textContent.trim()}$`;
        continue;
      }
    }

    // 4. 彻底跳过 KaTeX 视觉渲染层 (.katex-html)，杜绝公式字符重影乱码
    if (el.classList.contains('katex-html')) {
      continue;
    }

    // 5. 自定义代码块 / Mermaid 块容器
    if (el.getAttribute('data-md-codeblock') === 'true') {
      const lang = el.getAttribute('data-language') || '';
      const rawCode = el.getAttribute('data-raw-code');
      const codeEl = el.querySelector('code');
      const codeText = codeEl ? codeEl.textContent || '' : rawCode || '';
      result += `\n\`\`\`${lang}\n${codeText.replace(/\n$/, '')}\n\`\`\`\n\n`;
      continue;
    }

    const tag = el.tagName.toLowerCase();

    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = parseInt(tag.slice(1), 10);
        const inner = serializeDomNodesToMarkdown(el.childNodes, listDepth).trim();
        if (inner) {
          result += `\n${'#'.repeat(level)} ${inner}\n\n`;
        }
        break;
      }

      case 'p': {
        const inner = serializeDomNodesToMarkdown(el.childNodes, listDepth).trim();
        if (inner) {
          result += `${inner}\n\n`;
        }
        break;
      }

      case 'br': {
        result += '\n';
        break;
      }

      case 'strong':
      case 'b': {
        const inner = serializeDomNodesToMarkdown(el.childNodes, listDepth);
        result += inner ? `**${inner}**` : '';
        break;
      }

      case 'em':
      case 'i': {
        const inner = serializeDomNodesToMarkdown(el.childNodes, listDepth);
        result += inner ? `*${inner}*` : '';
        break;
      }

      case 'del':
      case 's': {
        const inner = serializeDomNodesToMarkdown(el.childNodes, listDepth);
        result += inner ? `~~${inner}~~` : '';
        break;
      }

      case 'code': {
        if (
          el.closest('[data-md-codeblock="true"]') ||
          el.parentElement?.tagName.toLowerCase() === 'pre'
        ) {
          result += (el.textContent || '').replace(/▏/g, '');
        } else {
          const inner = serializeDomNodesToMarkdown(el.childNodes, listDepth);
          result += inner ? `\`${inner}\`` : '';
        }
        break;
      }

      case 'pre': {
        const codeChild = el.querySelector('code');
        const langMatch = /language-([\w+-]+)/.exec(codeChild?.className || '');
        const lang = langMatch ? langMatch[1] : '';
        const text = (codeChild ? codeChild.textContent : el.textContent) || '';
        result += `\n\`\`\`${lang}\n${text.replace(/\n$/, '')}\n\`\`\`\n\n`;
        break;
      }

      case 'a': {
        const href = el.getAttribute('href') || '';
        const inner = serializeDomNodesToMarkdown(el.childNodes, listDepth).trim();
        result += href ? `[${inner || href}](${href})` : inner;
        break;
      }

      case 'img': {
        const alt = el.getAttribute('alt') || '';
        const src = el.getAttribute('src') || '';
        if (src) {
          result += `![${alt}](${src})`;
        }
        break;
      }

      case 'blockquote': {
        const inner = serializeDomNodesToMarkdown(el.childNodes, listDepth).trim();
        if (inner) {
          const quoted = inner
            .split('\n')
            .map((line) => (line.trim() ? `> ${line}` : '>'))
            .join('\n');
          result += `\n${quoted}\n\n`;
        }
        break;
      }

      case 'ul':
      case 'ol': {
        const isOrdered = tag === 'ol';
        const startAttr = parseInt(el.getAttribute('start') || '1', 10);
        const items = Array.from(el.children).filter(
          (c) => c.tagName.toLowerCase() === 'li'
        );
        let listOut = '';
        items.forEach((li, idx) => {
          const indent = '  '.repeat(listDepth);
          const prefix = isOrdered ? `${startAttr + idx}. ` : '- ';
          const itemContent = serializeDomNodesToMarkdown(li.childNodes, listDepth + 1)
            .trim()
            .replace(/\n{2,}/g, '\n' + indent + '  ');
          listOut += `${indent}${prefix}${itemContent}\n`;
        });
        result += (listDepth === 0 ? '\n' : '') + listOut + (listDepth === 0 ? '\n' : '');
        break;
      }

      case 'li': {
        const parentTag = el.parentElement?.tagName.toLowerCase();
        const prefix = parentTag === 'ol' ? '1. ' : '- ';
        const inner = serializeDomNodesToMarkdown(el.childNodes, listDepth + 1).trim();
        result += `${prefix}${inner}\n`;
        break;
      }

      case 'table': {
        const tableMd = serializeTableElementToMarkdown(el as HTMLTableElement);
        if (tableMd) {
          result += `\n${tableMd}\n\n`;
        }
        break;
      }

      case 'tr': {
        const cells = Array.from(el.querySelectorAll('th, td'));
        if (cells.length > 0) {
          const rowStr = cells
            .map((c) =>
              serializeDomNodesToMarkdown(c.childNodes, listDepth)
                .replace(/\r?\n+/g, ' ')
                .trim()
            )
            .join(' | ');
          result += `| ${rowStr} |\n`;
        }
        break;
      }

      case 'hr': {
        result += `\n---\n\n`;
        break;
      }

      default: {
        result += serializeDomNodesToMarkdown(el.childNodes, listDepth);
        break;
      }
    }
  }

  return result;
}

/**
 * 拦截 Markdown 渲染容器的 onCopy 事件：
 * 表面上用户划选的是渲染后的富文本/公式/表格/代码，实际写入剪贴板的是干净的 Markdown 原文。
 */
export function handleMarkdownCopyEvent(
  e: React.ClipboardEvent<HTMLElement>,
  rawMarkdown?: string
): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return;
  }

  const container = e.currentTarget;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) {
    return;
  }

  const ancestorEl =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as HTMLElement)
      : range.commonAncestorContainer.parentElement;

  // 情况 1：选区完全落在某个 KaTeX / InteractiveMath 公式内部 -> 直接提取该公式的 TeX 原文 (LaTeX)
  const mathContainer = ancestorEl?.closest(
    '.interactive-math, .katex-display, .katex'
  ) as HTMLElement | null;
  if (mathContainer && container.contains(mathContainer)) {
    const ann = mathContainer.querySelector('annotation[encoding="application/x-tex"]');
    if (ann?.textContent) {
      const isDisplay =
        mathContainer.tagName.toLowerCase() === 'div' ||
        mathContainer.classList.contains('katex-display') ||
        mathContainer.querySelector('.katex-display') !== null;
      e.preventDefault();
      e.clipboardData.setData(
        'text/plain',
        isDisplay ? `$$\n${ann.textContent.trim()}\n$$` : `$${ann.textContent.trim()}$`
      );
      return;
    }
  }

  // 情况 2：选区完全落在某个代码块内部（用户只拖选了代码中的几行）-> 直接复制选中的纯代码文本
  const codeEl = ancestorEl?.closest('code');
  if (codeEl && codeEl.closest('[data-md-codeblock="true"]')) {
    const selectedCode = selection.toString().replace(/▏/g, '');
    if (selectedCode) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', selectedCode);
      return;
    }
  }

  // 情况 3：若用户全选了整个当前 Markdown 容器的内容，直接输出最精准的原始 Markdown
  if (rawMarkdown) {
    const cleanRaw = rawMarkdown.replace(/▏$/g, '').trim();
    const containerText = (container.textContent || '').replace(/\s+/g, '');
    const selectedText = selection.toString().replace(/\s+/g, '');
    if (containerText.length > 0 && selectedText.length >= containerText.length * 0.98) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', cleanRaw);
      return;
    }
  }

  // 情况 4：局部跨节点富文本选择 -> 克隆选区 DOM，统一输出干净的 Markdown 原文
  const fragment = range.cloneContents();
  const markdown = serializeDomNodesToMarkdown(fragment.childNodes)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (markdown) {
    e.preventDefault();
    e.clipboardData.setData('text/plain', markdown);
  }
}
