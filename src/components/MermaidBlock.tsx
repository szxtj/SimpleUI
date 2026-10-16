import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Check, Copy, Image as ImageIcon, Code2, Eye } from 'lucide-react';
import { useI18n } from '../i18n';

interface MermaidBlockProps {
  code: string;
}

interface FlowNode {
  id: string;
  label: string;
  shape: 'rect' | 'round' | 'stadium' | 'diamond' | 'circle' | 'cylinder' | 'subroutine' | 'hexagon';
  subgraph?: string;
}

interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  style: 'solid' | 'dotted' | 'thick';
  arrow: boolean;
}

interface SubgraphGroup {
  id: string;
  title: string;
  nodeIds: string[];
  depth: number;
}

interface MermaidPalette {
  bg: string;
  nodeFill: string;
  nodeStroke: string;
  diamondFill: string;
  diamondStroke: string;
  circleFill: string;
  circleStroke: string;
  hexFill: string;
  hexStroke: string;
  nodeText: string;
  edgeStroke: string;
  labelBg: string;
  labelBorder: string;
  labelText: string;
  subgraphFill: string;
  subgraphStroke: string;
  subgraphTitle: string;
}

function getMermaidPalette(isDark: boolean): MermaidPalette {
  if (isDark) {
    return {
      bg: '#1a1b1e',
      nodeFill: '#232733',
      nodeStroke: '#4f8ff7',
      diamondFill: '#2a261d',
      diamondStroke: '#f59e0b',
      circleFill: '#1c2b27',
      circleStroke: '#10b981',
      hexFill: '#272134',
      hexStroke: '#a855f7',
      nodeText: '#f1f5f9',
      edgeStroke: '#64748b',
      labelBg: '#1e2028',
      labelBorder: '#3b404d',
      labelText: '#cbd5e1',
      subgraphFill: 'rgba(59, 130, 246, 0.05)',
      subgraphStroke: 'rgba(148, 163, 184, 0.35)',
      subgraphTitle: '#94a3b8',
    };
  }
  return {
    bg: '#ffffff',
    nodeFill: '#f0f6ff',
    nodeStroke: '#3b82f6',
    diamondFill: '#fffbeb',
    diamondStroke: '#d97706',
    circleFill: '#ecfdf5',
    circleStroke: '#059669',
    hexFill: '#faf5ff',
    hexStroke: '#9333ea',
    nodeText: '#1e293b',
    edgeStroke: '#64748b',
    labelBg: '#ffffff',
    labelBorder: '#cbd5e1',
    labelText: '#334155',
    subgraphFill: 'rgba(59, 130, 246, 0.035)',
    subgraphStroke: 'rgba(100, 116, 139, 0.4)',
    subgraphTitle: '#475569',
  };
}

function escapeXml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function measureTextWidth(text: string, fontSize = 13): number {
  let w = 0;
  for (const ch of text) {
    w += /[\u4e00-\u9fa5\u3000-\u30ff\uff00-\uffef]/.test(ch) ? fontSize * 1.02 : fontSize * 0.6;
  }
  return Math.ceil(w);
}

function parseNodeToken(
  rawToken: string,
  nodesMap: Map<string, FlowNode>,
  currentSubgraph?: string
): string {
  const token = rawToken.trim();
  if (!token) return '';

  const patterns: {
    regex: RegExp;
    shape: FlowNode['shape'];
  }[] = [
    { regex: /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\(\[([\s\S]+)\]\)$/, shape: 'stadium' },
    { regex: /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\[\[([\s\S]+)\]\]$/, shape: 'subroutine' },
    { regex: /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\[\(([\s\S]+)\)\]$/, shape: 'cylinder' },
    { regex: /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\(\(([\s\S]+)\)\)$/, shape: 'circle' },
    { regex: /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\{\{([\s\S]+)\}\}$/, shape: 'hexagon' },
    { regex: /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\{([\s\S]+)\}$/, shape: 'diamond' },
    { regex: /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\(([\s\S]+)\)$/, shape: 'round' },
    { regex: /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\[([\s\S]+)\]$/, shape: 'rect' },
  ];

  for (const { regex, shape } of patterns) {
    const m = token.match(regex);
    if (m) {
      const id = m[1].trim();
      const rawLabel = m[2]
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/<br\s*\/?>/gi, '\n');
      const existing = nodesMap.get(id);
      nodesMap.set(id, {
        id,
        label: rawLabel || id,
        shape,
        subgraph: currentSubgraph || existing?.subgraph,
      });
      return id;
    }
  }

  if (token === '[*]') {
    const id = '__state_star__';
    if (!nodesMap.has(id)) {
      nodesMap.set(id, { id, label: '●', shape: 'circle', subgraph: currentSubgraph });
    }
    return id;
  }

  const cleanId = token.replace(/^["']|["']$/g, '').split(/\s+/)[0];
  if (!nodesMap.has(cleanId)) {
    nodesMap.set(cleanId, {
      id: cleanId,
      label: cleanId,
      shape: 'rect',
      subgraph: currentSubgraph,
    });
  } else if (currentSubgraph && !nodesMap.get(cleanId)!.subgraph) {
    nodesMap.get(cleanId)!.subgraph = currentSubgraph;
  }
  return cleanId;
}

function renderFlowchartSvg(code: string, isDark: boolean): string | null {
  const palette = getMermaidPalette(isDark);
  const lines = code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('%%'));
  if (lines.length === 0) return null;

  const header = lines[0];
  let direction: 'TD' | 'LR' | 'BT' | 'RL' = 'TD';
  const dirMatch = header.match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)/i);
  if (dirMatch) {
    const d = dirMatch[1].toUpperCase();
    direction = d === 'TB' ? 'TD' : (d as 'TD' | 'LR' | 'BT' | 'RL');
  }

  const nodesMap = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const subgraphs: SubgraphGroup[] = [];
  const subgraphStack: SubgraphGroup[] = [];

  const registerNodeInActiveSubgraphs = (nodeId: string) => {
    if (!nodeId) return;
    for (const sg of subgraphStack) {
      if (!sg.nodeIds.includes(nodeId)) {
        sg.nodeIds.push(nodeId);
      }
    }
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/;$/, '').trim();
    if (!line || /^(classDef|class|style|linkStyle|click|direction)\b/i.test(line)) {
      continue;
    }

    const subMatch = line.match(/^subgraph\s+([^\[]+?)(?:\s*\[(.+)\])?$/i);
    if (subMatch) {
      const rawId = subMatch[1].trim().replace(/^["']|["']$/g, '');
      const rawTitle = (subMatch[2] || rawId).trim().replace(/^["']|["']$/g, '');
      const sg: SubgraphGroup = {
        id: rawId,
        title: rawTitle,
        nodeIds: [],
        depth: subgraphStack.length,
      };
      subgraphs.push(sg);
      subgraphStack.push(sg);
      continue;
    }
    if (/^end$/i.test(line)) {
      subgraphStack.pop();
      continue;
    }

    const topSubgraph = subgraphStack[subgraphStack.length - 1];

    const stateAlias = line.match(/^state\s+"([^"]+)"\s+as\s+([A-Za-z0-9_.\-]+)/i);
    if (stateAlias) {
      const id = stateAlias[2];
      nodesMap.set(id, {
        id,
        label: stateAlias[1],
        shape: 'round',
        subgraph: topSubgraph?.id,
      });
      registerNodeInActiveSubgraphs(id);
      continue;
    }

    const edgeRegex =
      /^(.+?)\s*(?:--\s*([^>-][^>]*?)\s*-->|-\.\s*([^.]*?)\s*\.->|==\s*([^=]*?)\s*==>|--+>|-\.->|==+>|---)\s*(?:\|([^|]*)\|\s*)?(.+)$/;
    const m = line.match(edgeRegex);
    if (m) {
      const leftRaw = m[1].trim();
      let rightRaw = m[6].trim();
      let trailingLabel = '';
      const colonSplit = rightRaw.match(/^(.+?)\s*:\s*(.+)$/);
      if (colonSplit && !colonSplit[1].includes('[')) {
        rightRaw = colonSplit[1].trim();
        trailingLabel = colonSplit[2].trim();
      }
      const label = (m[2] || m[3] || m[4] || m[5] || trailingLabel || '').trim();
      const rawConnector = line.slice(leftRaw.length, line.length - m[6].length);
      const style: FlowEdge['style'] = rawConnector.includes('.')
        ? 'dotted'
        : rawConnector.includes('=')
        ? 'thick'
        : 'solid';
      const arrow = rawConnector.includes('>');

      const fromId = parseNodeToken(leftRaw, nodesMap, topSubgraph?.id);
      const toId = parseNodeToken(rightRaw, nodesMap, topSubgraph?.id);
      if (fromId && toId) {
        registerNodeInActiveSubgraphs(fromId);
        registerNodeInActiveSubgraphs(toId);
        edges.push({ from: fromId, to: toId, label: label || undefined, style, arrow });
      }
      continue;
    }

    const nodeId = parseNodeToken(line, nodesMap, topSubgraph?.id);
    if (nodeId) {
      registerNodeInActiveSubgraphs(nodeId);
    }
  }

  if (nodesMap.size === 0) return null;

  // Assign layers (longest-path DAG layering for clean vertical/horizontal hierarchy)
  const nodes = Array.from(nodesMap.values());
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  nodes.forEach((n) => {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  });
  edges.forEach((e) => {
    if (adj.has(e.from) && inDegree.has(e.to) && e.from !== e.to) {
      adj.get(e.from)!.push(e.to);
      inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    }
  });

  const layerMap = new Map<string, number>();
  const queue: string[] = [];
  nodes.forEach((n) => {
    if ((inDegree.get(n.id) || 0) === 0) {
      layerMap.set(n.id, 0);
      queue.push(n.id);
    }
  });
  if (queue.length === 0 && nodes.length > 0) {
    layerMap.set(nodes[0].id, 0);
    queue.push(nodes[0].id);
  }

  const visited = new Set<string>(queue);
  while (queue.length > 0) {
    const u = queue.shift()!;
    const uLayer = layerMap.get(u) || 0;
    for (const v of adj.get(u) || []) {
      const nextLayer = Math.min(nodes.length, uLayer + 1);
      if (!layerMap.has(v) || layerMap.get(v)! < nextLayer) {
        layerMap.set(v, nextLayer);
      }
      if (!visited.has(v)) {
        visited.add(v);
        queue.push(v);
      }
    }
  }
  nodes.forEach((n) => {
    if (!layerMap.has(n.id)) layerMap.set(n.id, 0);
  });

  const layers = new Map<number, FlowNode[]>();
  nodes.forEach((n) => {
    const l = layerMap.get(n.id) || 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(n);
  });

  const sortedLayerIndices = Array.from(layers.keys()).sort((a, b) => a - b);
  if (direction === 'BT' || direction === 'RL') {
    sortedLayerIndices.reverse();
  }

  const isHorizontal = direction === 'LR' || direction === 'RL';
  const hasEdgeLabels = edges.some((e) => Boolean(e.label));

  // Compute node dimensions
  const nodeDims = new Map<string, { w: number; h: number }>();
  nodes.forEach((n) => {
    const linesOfLabel = n.label.split('\n');
    const maxLineW = Math.max(...linesOfLabel.map((l) => measureTextWidth(l, 13)), 36);
    const padX = n.shape === 'diamond' ? 44 : 28;
    const padY = n.shape === 'diamond' ? 26 : 18;
    const w = Math.max(78, maxLineW + padX);
    const h = Math.max(40, linesOfLabel.length * 18 + padY);
    nodeDims.set(n.id, { w, h });
  });

  const layerGap = isHorizontal ? (hasEdgeLabels ? 115 : 90) : (hasEdgeLabels ? 96 : 72);
  const siblingGap = isHorizontal ? 40 : 54;
  const margin = 48;

  const posMap = new Map<string, { cx: number; cy: number; w: number; h: number }>();
  let maxCrossSpan = 0;
  const layerMainSize: number[] = [];

  sortedLayerIndices.forEach((layerIdx) => {
    const group = layers.get(layerIdx)!;
    if (isHorizontal) {
      const maxW = Math.max(...group.map((n) => nodeDims.get(n.id)!.w));
      const totalH =
        group.reduce((acc, n) => acc + nodeDims.get(n.id)!.h, 0) +
        Math.max(0, group.length - 1) * siblingGap;
      layerMainSize.push(maxW);
      if (totalH > maxCrossSpan) maxCrossSpan = totalH;
    } else {
      const maxH = Math.max(...group.map((n) => nodeDims.get(n.id)!.h));
      const totalW =
        group.reduce((acc, n) => acc + nodeDims.get(n.id)!.w, 0) +
        Math.max(0, group.length - 1) * siblingGap;
      layerMainSize.push(maxH);
      if (totalW > maxCrossSpan) maxCrossSpan = totalW;
    }
  });

  let currentMainOffset = margin;
  sortedLayerIndices.forEach((layerIdx, idx) => {
    const group = layers.get(layerIdx)!;
    const mainSize = layerMainSize[idx];

    if (isHorizontal) {
      const totalH =
        group.reduce((acc, n) => acc + nodeDims.get(n.id)!.h, 0) +
        Math.max(0, group.length - 1) * siblingGap;
      let cursorY = margin + (maxCrossSpan - totalH) / 2;
      group.forEach((n) => {
        const { w, h } = nodeDims.get(n.id)!;
        posMap.set(n.id, {
          cx: currentMainOffset + mainSize / 2,
          cy: cursorY + h / 2,
          w,
          h,
        });
        cursorY += h + siblingGap;
      });
    } else {
      const totalW =
        group.reduce((acc, n) => acc + nodeDims.get(n.id)!.w, 0) +
        Math.max(0, group.length - 1) * siblingGap;
      let cursorX = margin + (maxCrossSpan - totalW) / 2;
      group.forEach((n) => {
        const { w, h } = nodeDims.get(n.id)!;
        posMap.set(n.id, {
          cx: cursorX + w / 2,
          cy: currentMainOffset + mainSize / 2,
          w,
          h,
        });
        cursorX += w + siblingGap;
      });
    }

    currentMainOffset += mainSize + layerGap;
  });

  const totalMainSpan = currentMainOffset - layerGap + margin;
  const svgWidth = Math.max(260, Math.ceil(isHorizontal ? totalMainSpan : maxCrossSpan + margin * 2));
  const svgHeight = Math.max(120, Math.ceil(isHorizontal ? maxCrossSpan + margin * 2 : totalMainSpan));

  // Subgraph boxes (outermost drawn first, nested subgraphs inset cleanly so headers never collide)
  const subgraphEls = subgraphs
    .map((sg) => {
      const pts = sg.nodeIds.map((id) => posMap.get(id)).filter(Boolean) as {
        cx: number;
        cy: number;
        w: number;
        h: number;
      }[];
      if (pts.length === 0) return '';
      const maxDepth = Math.max(...subgraphs.map((s) => s.depth), 0);
      const outerExtra = (maxDepth - sg.depth) * 14;
      const minX = Math.min(...pts.map((p) => p.cx - p.w / 2)) - 18 - outerExtra;
      const maxX = Math.max(...pts.map((p) => p.cx + p.w / 2)) + 18 + outerExtra;
      const minY = Math.min(...pts.map((p) => p.cy - p.h / 2)) - 30 - outerExtra * 1.3;
      const maxY = Math.max(...pts.map((p) => p.cy + p.h / 2)) + 16 + outerExtra * 0.8;
      return `<g>
        <rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="10" fill="${palette.subgraphFill}" stroke="${palette.subgraphStroke}" stroke-dasharray="5,4" stroke-width="1.25" />
        <text x="${minX + 12}" y="${minY + 18}" fill="${palette.subgraphTitle}" font-size="11.5" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeXml(sg.title)}</text>
      </g>`;
    })
    .join('\n');

  // Track placed boxes (starting with all node boxes) so edge labels avoid overlapping nodes or each other
  const occupiedBoxes: { x: number; y: number; w: number; h: number }[] = [];
  posMap.forEach((p) => {
    occupiedBoxes.push({ x: p.cx - p.w / 2 - 4, y: p.cy - p.h / 2 - 4, w: p.w + 8, h: p.h + 8 });
  });

  const boxesOverlap = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number }
  ) => {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  };

  const cubicPoint = (t: number, p0: number, p1: number, p2: number, p3: number) => {
    const mt = 1 - t;
    return (
      mt * mt * mt * p0 +
      3 * mt * mt * t * p1 +
      3 * mt * t * t * p2 +
      t * t * t * p3
    );
  };

  const edgePathEls: string[] = [];
  const edgeLabelEls: string[] = [];

  edges.forEach((e) => {
    const p1 = posMap.get(e.from);
    const p2 = posMap.get(e.to);
    if (!p1 || !p2) return;

    let x1 = p1.cx;
    let y1 = p1.cy;
    let x2 = p2.cx;
    let y2 = p2.cy;

    if (isHorizontal) {
      if (p1.cx <= p2.cx) {
        x1 = p1.cx + p1.w / 2;
        x2 = p2.cx - p2.w / 2 - (e.arrow ? 5 : 0);
      } else {
        x1 = p1.cx - p1.w / 2;
        x2 = p2.cx + p2.w / 2 + (e.arrow ? 5 : 0);
      }
    } else {
      if (p1.cy <= p2.cy) {
        y1 = p1.cy + p1.h / 2;
        y2 = p2.cy - p2.h / 2 - (e.arrow ? 5 : 0);
      } else {
        y1 = p1.cy - p1.h / 2;
        y2 = p2.cy + p2.h / 2 + (e.arrow ? 5 : 0);
      }
    }

    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const cx1 = isHorizontal ? midX : x1;
    const cy1 = isHorizontal ? y1 : midY;
    const cx2 = isHorizontal ? midX : x2;
    const cy2 = isHorizontal ? y2 : midY;

    const d = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
    const dash = e.style === 'dotted' ? 'stroke-dasharray="5,4"' : '';
    const strokeW = e.style === 'thick' ? '2.5' : '1.65';
    const marker = e.arrow ? 'marker-end="url(#mermaid-arrow)"' : '';

    edgePathEls.push(
      `<path d="${d}" fill="none" stroke="${palette.edgeStroke}" stroke-width="${strokeW}" ${dash} ${marker} />`
    );

    if (e.label) {
      const lw = measureTextWidth(e.label, 11.5) + 14;
      const lh = 20;
      const candidateTs = [0.5, 0.36, 0.64, 0.26, 0.74, 0.43, 0.57];
      let bestX = cubicPoint(0.5, x1, cx1, cx2, x2);
      let bestY = cubicPoint(0.5, y1, cy1, cy2, y2);

      for (const t of candidateTs) {
        const px = cubicPoint(t, x1, cx1, cx2, x2);
        const py = cubicPoint(t, y1, cy1, cy2, y2);
        const box = { x: px - lw / 2 - 2, y: py - lh / 2 - 2, w: lw + 4, h: lh + 4 };
        if (!occupiedBoxes.some((b) => boxesOverlap(box, b))) {
          bestX = px;
          bestY = py;
          break;
        }
      }

      occupiedBoxes.push({ x: bestX - lw / 2, y: bestY - lh / 2, w: lw, h: lh });
      edgeLabelEls.push(`<g>
        <rect x="${bestX - lw / 2}" y="${bestY - lh / 2}" width="${lw}" height="${lh}" rx="5" fill="${palette.labelBg}" stroke="${palette.labelBorder}" stroke-width="1" />
        <text x="${bestX}" y="${bestY + 4}" text-anchor="middle" fill="${palette.labelText}" font-size="11.5" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeXml(e.label)}</text>
      </g>`);
    }
  });

  const nodeEls = nodes
    .map((n) => {
      const pos = posMap.get(n.id);
      if (!pos) return '';
      const { cx, cy, w, h } = pos;
      const x = cx - w / 2;
      const y = cy - h / 2;

      let shapeSvg = '';
      const sw = '1.5';

      if (n.shape === 'diamond') {
        const pts = `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`;
        shapeSvg = `<polygon points="${pts}" fill="${palette.diamondFill}" stroke="${palette.diamondStroke}" stroke-width="${sw}" />`;
      } else if (n.shape === 'circle') {
        const r = Math.max(w, h) / 2;
        shapeSvg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${palette.circleFill}" stroke="${palette.circleStroke}" stroke-width="${sw}" />`;
      } else if (n.shape === 'stadium') {
        shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${palette.circleFill}" stroke="${palette.circleStroke}" stroke-width="${sw}" />`;
      } else if (n.shape === 'round') {
        shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${palette.nodeFill}" stroke="${palette.nodeStroke}" stroke-width="${sw}" />`;
      } else if (n.shape === 'hexagon') {
        const inset = 14;
        const pts = `${x + inset},${y} ${x + w - inset},${y} ${x + w},${cy} ${x + w - inset},${y + h} ${x + inset},${y + h} ${x},${cy}`;
        shapeSvg = `<polygon points="${pts}" fill="${palette.hexFill}" stroke="${palette.hexStroke}" stroke-width="${sw}" />`;
      } else {
        shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${palette.nodeFill}" stroke="${palette.nodeStroke}" stroke-width="${sw}" />`;
      }

      const labelLines = n.label.split('\n');
      const startY = cy - ((labelLines.length - 1) * 17) / 2 + 4.5;
      const textSvg = labelLines
        .map(
          (lineText, idx) =>
            `<text x="${cx}" y="${startY + idx * 17}" text-anchor="middle" fill="${palette.nodeText}" font-size="13" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeXml(lineText)}</text>`
        )
        .join('');

      return `<g>${shapeSvg}${textSvg}</g>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}" style="max-width:100%;height:auto;display:block;margin:0 auto;">
    <defs>
      <marker id="mermaid-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="${palette.edgeStroke}" />
      </marker>
    </defs>
    ${subgraphEls}
    ${edgePathEls.join('\n')}
    ${nodeEls}
    ${edgeLabelEls.join('\n')}
  </svg>`;
}

function renderSequenceDiagramSvg(code: string, isDark: boolean): string | null {
  const palette = getMermaidPalette(isDark);
  const lines = code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('%%'));
  if (lines.length <= 1) return null;

  const participants: { id: string; label: string }[] = [];
  const pMap = new Map<string, string>();
  const messages: { from: string; to: string; text: string; dashed: boolean }[] = [];

  const ensureParticipant = (id: string, label?: string) => {
    const cleanId = id.trim().replace(/^["']|["']$/g, '');
    if (!cleanId) return '';
    if (!pMap.has(cleanId)) {
      const finalLabel = (label || cleanId).trim().replace(/^["']|["']$/g, '');
      pMap.set(cleanId, finalLabel);
      participants.push({ id: cleanId, label: finalLabel });
    }
    return cleanId;
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const pMatch = line.match(/^(?:participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i);
    if (pMatch) {
      ensureParticipant(pMatch[1], pMatch[2]);
      continue;
    }
    const msgMatch = line.match(/^([^-:]+?)\s*(--?>?>?|--?[x)])\s*([^:]+?)\s*:\s*(.*)$/);
    if (msgMatch) {
      const from = ensureParticipant(msgMatch[1]);
      const arrow = msgMatch[2];
      const to = ensureParticipant(msgMatch[3]);
      const text = msgMatch[4].trim();
      if (from && to) {
        messages.push({ from, to, text, dashed: arrow.startsWith('--') });
      }
    }
  }

  if (participants.length === 0) return null;

  const colGap = 150;
  const marginX = 70;
  const topY = 30;
  const boxH = 36;
  const rowH = 52;
  const svgWidth = Math.max(320, marginX * 2 + (participants.length - 1) * colGap + 120);
  const bottomBoxY = topY + boxH + 28 + messages.length * rowH + 16;
  const svgHeight = bottomBoxY + boxH + 24;

  const xOf = (id: string) => {
    const idx = participants.findIndex((p) => p.id === id);
    return marginX + 60 + Math.max(0, idx) * colGap;
  };

  const lifelines = participants
    .map((p) => {
      const cx = xOf(p.id);
      const w = Math.max(88, measureTextWidth(p.label, 13) + 28);
      return `<g>
        <line x1="${cx}" y1="${topY + boxH}" x2="${cx}" y2="${bottomBoxY}" stroke="${palette.edgeStroke}" stroke-width="1.4" stroke-dasharray="5,5" />
        <rect x="${cx - w / 2}" y="${topY}" width="${w}" height="${boxH}" rx="7" fill="${palette.nodeFill}" stroke="${palette.nodeStroke}" stroke-width="1.5" />
        <text x="${cx}" y="${topY + 23}" text-anchor="middle" fill="${palette.nodeText}" font-size="13" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeXml(p.label)}</text>
        <rect x="${cx - w / 2}" y="${bottomBoxY}" width="${w}" height="${boxH}" rx="7" fill="${palette.nodeFill}" stroke="${palette.nodeStroke}" stroke-width="1.5" />
        <text x="${cx}" y="${bottomBoxY + 23}" text-anchor="middle" fill="${palette.nodeText}" font-size="13" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeXml(p.label)}</text>
      </g>`;
    })
    .join('\n');

  const msgEls = messages
    .map((m, idx) => {
      const y = topY + boxH + 40 + idx * rowH;
      const x1 = xOf(m.from);
      const x2 = xOf(m.to);
      const dash = m.dashed ? 'stroke-dasharray="5,4"' : '';
      if (m.from === m.to) {
        return `<g>
          <path d="M ${x1} ${y - 8} L ${x1 + 36} ${y - 8} L ${x1 + 36} ${y + 12} L ${x1 + 6} ${y + 12}" fill="none" stroke="${palette.edgeStroke}" stroke-width="1.6" ${dash} marker-end="url(#seq-arrow)" />
          <text x="${x1 + 42}" y="${y + 4}" fill="${palette.labelText}" font-size="12" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeXml(m.text)}</text>
        </g>`;
      }
      const dir = x2 > x1 ? 1 : -1;
      const targetX = x2 - dir * 6;
      const midX = (x1 + x2) / 2;
      return `<g>
        <line x1="${x1}" y1="${y}" x2="${targetX}" y2="${y}" stroke="${palette.edgeStroke}" stroke-width="1.65" ${dash} marker-end="url(#seq-arrow)" />
        <text x="${midX}" y="${y - 8}" text-anchor="middle" fill="${palette.labelText}" font-size="12" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeXml(m.text)}</text>
      </g>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}" style="max-width:100%;height:auto;display:block;margin:0 auto;">
    <defs>
      <marker id="seq-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="${palette.edgeStroke}" />
      </marker>
    </defs>
    ${lifelines}
    ${msgEls}
  </svg>`;
}

function renderPieChartSvg(code: string, isDark: boolean): string | null {
  const palette = getMermaidPalette(isDark);
  const lines = code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('%%'));
  let title = '';
  const slices: { label: string; value: number }[] = [];

  for (const line of lines) {
    const titleMatch = line.match(/^(?:pie\s+)?title\s+(.+)$/i);
    if (titleMatch) {
      title = titleMatch[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const sliceMatch = line.match(/^"([^"]+)"\s*:\s*([0-9.]+)$/);
    if (sliceMatch) {
      const val = parseFloat(sliceMatch[2]);
      if (val > 0) {
        slices.push({ label: sliceMatch[1], value: val });
      }
    }
  }

  if (slices.length === 0) return null;
  const total = slices.reduce((acc, s) => acc + s.value, 0);
  const colors = ['#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4', '#f97316'];

  const svgWidth = 460;
  const svgHeight = Math.max(240, (title ? 44 : 16) + Math.max(180, slices.length * 28 + 20));
  const cx = 125;
  const cy = (title ? 32 : 10) + 100;
  const r = 78;

  let startAngle = -Math.PI / 2;
  const paths = slices
    .map((s, idx) => {
      const fraction = s.value / total;
      const angle = fraction * Math.PI * 2;
      const endAngle = startAngle + angle;
      const x1 = cx + r * Math.cos(startAngle);
      const y1 = cy + r * Math.sin(startAngle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy + r * Math.sin(endAngle);
      const largeArc = angle > Math.PI ? 1 : 0;
      const color = colors[idx % colors.length];
      startAngle = endAngle;
      if (slices.length === 1) {
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" />`;
      }
      return `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${color}" stroke="${palette.bg}" stroke-width="2" />`;
    })
    .join('\n');

  const legend = slices
    .map((s, idx) => {
      const pct = ((s.value / total) * 100).toFixed(1);
      const ly = (title ? 52 : 32) + idx * 26;
      const color = colors[idx % colors.length];
      return `<g>
        <rect x="240" y="${ly - 10}" width="12" height="12" rx="3" fill="${color}" />
        <text x="260" y="${ly}" fill="${palette.nodeText}" font-size="12.5" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeXml(s.label)} (${pct}%)</text>
      </g>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}" style="max-width:100%;height:auto;display:block;margin:0 auto;">
    ${title ? `<text x="${svgWidth / 2}" y="26" text-anchor="middle" fill="${palette.nodeText}" font-size="14" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeXml(title)}</text>` : ''}
    ${paths}
    ${legend}
  </svg>`;
}

export function renderMermaidToSvg(code: string, isDark: boolean = true): string | null {
  const trimmed = (code || '').trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/)[0].trim();

  if (/^sequenceDiagram\b/i.test(firstLine)) {
    return renderSequenceDiagramSvg(trimmed, isDark);
  }
  if (/^pie\b/i.test(firstLine)) {
    return renderPieChartSvg(trimmed, isDark);
  }
  if (/^(?:flowchart|graph|stateDiagram(?:-v2)?)\b/i.test(firstLine)) {
    return renderFlowchartSvg(trimmed, isDark);
  }
  if (/-->|---|-\.->|==>/.test(trimmed)) {
    return renderFlowchartSvg(`flowchart TD\n${trimmed}`, isDark);
  }
  return null;
}

export const MermaidBlock: React.FC<MermaidBlockProps> = React.memo(({ code }) => {
  const { lang } = useI18n();
  const [viewMode, setViewMode] = useState<'diagram' | 'code'>('diagram');
  const [copiedSource, setCopiedSource] = useState(false);
  const [copiedImage, setCopiedImage] = useState(false);
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== 'undefined' ? document.documentElement.classList.contains('dark') : true
  );
  const svgContainerRef = useRef<HTMLDivElement | null>(null);

  // Observe html.dark class changes so switching Light/Dark theme immediately updates the SVG diagram
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const updateTheme = () => setIsDark(root.classList.contains('dark'));
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const svgMarkup = useMemo(() => renderMermaidToSvg(code, isDark), [code, isDark]);

  const handleCopySource = async () => {
    try {
      const fenced = `\`\`\`mermaid\n${code.replace(/\n$/, '')}\n\`\`\``;
      await navigator.clipboard.writeText(fenced);
      setCopiedSource(true);
      setTimeout(() => setCopiedSource(false), 2000);
    } catch (e) {
      console.error('Failed to copy mermaid source:', e);
    }
  };

  const handleCopyImage = async () => {
    try {
      const svgEl = svgContainerRef.current?.querySelector('svg');
      if (!svgEl) return;

      const serializer = new XMLSerializer();
      let svgString = serializer.serializeToString(svgEl);
      if (!svgString.includes('xmlns="http://www.w3.org/2000/svg"')) {
        svgString = svgString.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      }

      const viewBox = svgEl.getAttribute('viewBox')?.split(/\s+/).map(Number);
      const width = (viewBox && viewBox[2]) || svgEl.clientWidth || 600;
      const height = (viewBox && viewBox[3]) || svgEl.clientHeight || 400;
      const scale = 2; // 2x Retina resolution

      const img = new Image();
      const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (err) => reject(err);
        img.src = url;
      });

      const canvas = document.createElement('canvas');
      const pad = 24;
      canvas.width = (width + pad * 2) * scale;
      canvas.height = (height + pad * 2) * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        return;
      }

      ctx.scale(scale, scale);
      ctx.fillStyle = isDark ? '#1a1b1e' : '#ffffff';
      ctx.fillRect(0, 0, width + pad * 2, height + pad * 2);
      ctx.drawImage(img, pad, pad, width, height);
      URL.revokeObjectURL(url);

      const pngBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/png')
      );
      if (pngBlob && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        setCopiedImage(true);
        setTimeout(() => setCopiedImage(false), 2000);
      }
    } catch (e) {
      console.error('Failed to copy mermaid image:', e);
    }
  };

  const isEn = lang === 'en';

  return (
    <div
      data-md-codeblock="true"
      data-language="mermaid"
      data-raw-code={code}
      className="relative my-3 rounded-lg overflow-hidden border border-[#d0d7de] dark:border-[#33363d] bg-white dark:bg-[#1a1b1e]"
    >
      {/* Header Toolbar (non-selectable, ignored by selection-to-markdown serializer) */}
      <div
        data-copy-ignore="true"
        className="flex items-center justify-between px-3.5 py-1.5 bg-[#f6f8fa] dark:bg-[#22242a] border-b border-[#d0d7de] dark:border-[#33363d] text-xs text-zinc-500 dark:text-[#9aa0a6] select-none"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono uppercase font-semibold text-[11px] tracking-wider text-zinc-600 dark:text-[#abb2bf]">
            MERMAID
          </span>
          {svgMarkup && (
            <div className="flex items-center bg-black/[0.04] dark:bg-[#18191e] rounded-md p-0.5 border border-black/5 dark:border-white/5">
              <button
                type="button"
                onClick={() => setViewMode('diagram')}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
                  viewMode === 'diagram'
                    ? 'bg-white dark:bg-[#32363e] text-zinc-900 dark:text-white font-medium shadow-xs'
                    : 'text-zinc-500 dark:text-[#8b929e] hover:text-zinc-900 dark:hover:text-white'
                }`}
              >
                <Eye className="w-3 h-3" />
                <span>{isEn ? 'Diagram' : '图表'}</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('code')}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
                  viewMode === 'code'
                    ? 'bg-white dark:bg-[#32363e] text-zinc-900 dark:text-white font-medium shadow-xs'
                    : 'text-zinc-500 dark:text-[#8b929e] hover:text-zinc-900 dark:hover:text-white'
                }`}
              >
                <Code2 className="w-3 h-3" />
                <span>{isEn ? 'Code' : '源码'}</span>
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {svgMarkup && (
            <button
              type="button"
              onClick={handleCopyImage}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-black/5 dark:hover:bg-[#32363e] text-zinc-600 dark:text-[#b0b4bd] transition-colors cursor-pointer"
              title={isEn ? 'Copy rendered diagram image' : '复制渲染后的图表图像'}
            >
              {copiedImage ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                  <span className="text-emerald-600 dark:text-emerald-400 text-[11px]">
                    {isEn ? 'Image Copied' : '已复制图像'}
                  </span>
                </>
              ) : (
                <>
                  <ImageIcon className="w-3.5 h-3.5" />
                  <span className="text-[11px]">{isEn ? 'Copy Image' : '复制图像'}</span>
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={handleCopySource}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-black/5 dark:hover:bg-[#32363e] text-zinc-600 dark:text-[#b0b4bd] transition-colors cursor-pointer"
            title={isEn ? 'Copy Mermaid Markdown source' : '复制 Mermaid Markdown 源码'}
          >
            {copiedSource ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                <span className="text-emerald-600 dark:text-emerald-400 text-[11px]">
                  {isEn ? 'Copied' : '已复制'}
                </span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span className="text-[11px]">{isEn ? 'Copy Source' : '复制源码'}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Body: Rendered SVG Diagram or Selectable Raw Code */}
      {svgMarkup && viewMode === 'diagram' ? (
        <div
          ref={svgContainerRef}
          className="p-4 overflow-x-auto overflow-y-hidden flex justify-center items-center bg-white dark:bg-[#1a1b1e]"
          dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
      ) : (
        <pre className="!m-0 !p-3.5 overflow-x-auto overflow-y-hidden text-[0.88em] font-mono leading-relaxed bg-[#f8f9fb] dark:bg-[#1a1b1e] text-[#1f2328] dark:text-[#f0f3f6] border-0 whitespace-pre cursor-text">
          <code className="!bg-transparent !p-0 !text-inherit font-mono whitespace-pre">{code}</code>
        </pre>
      )}
    </div>
  );
});

MermaidBlock.displayName = 'MermaidBlock';
