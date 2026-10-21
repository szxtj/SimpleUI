import assert from 'node:assert/strict';
import {
  buildOffsets,
  coreRange,
  desiredRange,
  fillRange,
  findIndexAtOffset,
  shouldMountAll,
  tailRange,
  trimRange,
} from '../src/utils/virtualWindow.ts';

const CFG = {
  viewport: 800,
  padTurns: 2,
  overscan: 960,
  maxTurns: 24,
  maxHeight: 2800,
};

function msg(id, role, content) {
  return { id, role, content, timestamp: 0 };
}

function turn(i, role = 'assistant') {
  return {
    key: `t${i}`,
    index: i,
    user: msg(`u${i}`, 'user', 'q'.repeat(10 + (i % 5) * 4)),
    assistant: msg(`a${i}`, role, 'a'.repeat(80 + (i % 11) * 90)),
    startMessageIndex: i * 2,
    endMessageIndex: i * 2 + 1,
  };
}

function assertInvariants(offsets, range, scrollTop, label) {
  const n = offsets.length - 1;
  assert.ok(range.start >= 0, `${label}: start >= 0`);
  assert.ok(range.end <= n - 1, `${label}: end <= last`);
  assert.ok(range.start <= range.end, `${label}: start <= end`);

  const visibleStart = findIndexAtOffset(offsets, scrollTop + 1);
  const visibleEnd = findIndexAtOffset(offsets, scrollTop + CFG.viewport - 1);
  const protectedStart = Math.max(0, visibleStart - CFG.padTurns);
  const protectedEnd = Math.min(n - 1, visibleEnd + CFG.padTurns);

  assert.ok(range.start <= protectedStart, `${label}: keeps ${CFG.padTurns} above`);
  assert.ok(range.end >= protectedEnd, `${label}: keeps ${CFG.padTurns} below`);
  assert.ok(
    range.end - range.start + 1 <= CFG.maxTurns,
    `${label}: max turn cap (${range.end - range.start + 1})`
  );
  assert.ok(
    offsets[range.end + 1] - offsets[range.start] <= CFG.maxHeight || range.start === protectedStart,
    `${label}: max height cap`
  );
}

// 1) 200 轮估算 offsets
const turns = Array.from({ length: 200 }, (_, i) => turn(i));
const sizes = new Map();
let { offsets } = buildOffsets(turns, sizes, 800);
assert.equal(offsets.length, 201);
assert.ok(offsets[200] > 0);
for (let i = 1; i < offsets.length; i++) {
  assert.ok(offsets[i] > offsets[i - 1], `offsets strictly increasing at ${i}`);
}

// 2) 各位置窗口不变式
let lastEnd = -1;
for (let scrollTop = 0; scrollTop < offsets[200] - CFG.viewport; scrollTop += 173) {
  const range = desiredRange(offsets, scrollTop, CFG);
  assertInvariants(offsets, range, scrollTop, `scroll ${scrollTop}`);
  assert.ok(range.end >= lastEnd, 'scrolling down never loses the lower edge');
  lastEnd = range.end;
}

// 3) 首尾
const top = desiredRange(offsets, 0, CFG);
assert.equal(top.start, 0);
const bottom = desiredRange(offsets, offsets[200] - CFG.viewport, CFG);
assert.equal(bottom.end, 199);

// 4) 尾部窗口覆盖一屏 + overscan + pad
const tail = tailRange(offsets, CFG.viewport, CFG.padTurns, CFG.overscan);
assert.equal(tail.end, 199);
assert.ok(offsets[200] - offsets[tail.start] >= CFG.viewport + CFG.overscan);
assert.ok(199 - tail.start >= CFG.padTurns);

// 5) 实测高度替换估算后，spacer 总和守恒
const measured = new Map(sizes);
for (let i = 90; i <= 110; i++) {
  measured.set(`t${i}`, { h: 40 + (i % 7) * 130, w: 800, visited: true });
}
({ offsets } = buildOffsets(turns, measured, 800));
assert.equal(offsets.length, 201);
for (let i = 0; i < 200; i++) {
  const expected = measured.get(`t${i}`)?.h;
  if (expected != null) {
    assert.ok(Math.abs(offsets[i + 1] - offsets[i] - expected) < 0.001, `measured height used at ${i}`);
  }
}

// 6) 收拢只缩不放
const current = { start: 80, end: 100 };
const core = { start: 85, end: 95 };
assert.deepEqual(trimRange(current, core), { start: 85, end: 95 });
assert.equal(trimRange({ start: 85, end: 95 }, { start: 80, end: 100 }), null);
assert.equal(trimRange({ start: 80, end: 100 }, { start: 78, end: 102 }), null);

// 7) 短会话全量挂载 / 填充
assert.equal(shouldMountAll(12, 12000, 800, 16, 4), true);
assert.equal(shouldMountAll(40, 1000, 800, 16, 4), true);
assert.equal(shouldMountAll(40, 9000, 800, 16, 4), false);

const shortOffsets = [0, 100, 200, 300];
const filled = fillRange(shortOffsets, { start: 2, end: 2 }, 800);
assert.deepEqual(filled, { start: 0, end: 2 });

// 8) 宽度变化后按比例估算
const scaled = buildOffsets(turns, new Map([['t0', { h: 400, w: 800 }]]), 400);
assert.ok(Math.abs(scaled.offsets[1] - 200) < 0.001, 'width scaling clamps to 0.5x');

// 9) coreRange 永远包含可见区
for (let scrollTop = 0; scrollTop < offsets[200]; scrollTop += 311) {
  const core = coreRange(offsets, scrollTop, CFG.viewport, CFG.padTurns);
  const visibleStart = findIndexAtOffset(offsets, scrollTop + 1);
  const visibleEnd = findIndexAtOffset(offsets, scrollTop + CFG.viewport - 1);
  assert.ok(core.start <= visibleStart && core.end >= visibleEnd);
  assert.ok(core.start <= Math.max(0, visibleStart - CFG.padTurns));
}

console.log('✅ virtualWindow tests passed');
