const test = require('node:test');
const assert = require('node:assert/strict');

const {
  visibleLength,
  fillLineToWidth,
  packFieldsByWidth,
  paginateFields,
  clampPageIndex,
  layoutPinnedEdges,
  segmentRatios,
  layoutThreeColumns
} = require('../src/tools/status-bar');

test('packFieldsByWidth keeps left-first order and respects width', () => {
  const fields = ['CPU 20%', 'GPU 10%', 'MEM 30%', 'DISK 2.0TB/500G', 'NET 10KB/s'];
  const packed = packFieldsByWidth(fields, 28, ' | ');
  assert.equal(packed.startsWith('CPU 20% | GPU 10%'), true);
  assert.equal(packed.includes('DISK 2.0TB/500G'), false);
  assert.equal(visibleLength(packed) <= 28, true);
});

test('paginateFields splits fields into multiple pages within width budget', () => {
  const fields = ['CPU 20%', 'GPU 10%', 'MEM 30%', 'NET 12KB/s', 'MODEL gpt-5.3-codex', 'DATE 03-07 Sat 10:03:12'];
  const pages = paginateFields(fields, 26, ' | ');
  assert.equal(pages.length > 1, true);
  pages.forEach((page) => {
    assert.equal(visibleLength(page) <= 26, true);
  });
});

test('clampPageIndex keeps index within page bounds', () => {
  assert.equal(clampPageIndex(-1, 3), 0);
  assert.equal(clampPageIndex(0, 3), 0);
  assert.equal(clampPageIndex(2, 3), 2);
  assert.equal(clampPageIndex(9, 3), 2);
  assert.equal(clampPageIndex(1, 1), 0);
});

test('fillLineToWidth fully fills the requested visible width', () => {
  const line = fillLineToWidth('ABC', 10);
  assert.equal(visibleLength(line), 10);
  assert.equal(line.startsWith('ABC'), true);
});

test('segmentRatios always sum to 1', () => {
  [100, 120, 150, 180, 240].forEach((width) => {
    const ratios = segmentRatios(width);
    const sum = ratios.reduce((acc, n) => acc + n, 0);
    assert.equal(Number(sum.toFixed(6)), 1);
  });
});

test('layoutThreeColumns keeps right segment visible on wide screens', () => {
  const left = 'CPU 12% MEM 40% DISK 2.0TB/500G NET 10KB/s';
  const middle = 'MODEL gpt-5.3 TOK T 55.2K TPS 22.5';
  const right = 'UP 103h LA 4.1 BAT 98% DATE 03-05 21:16';
  const line = layoutThreeColumns(left, middle, right, 180);
  assert.equal(line.includes('UP 103h'), true);
  assert.equal(line.includes('DATE 03-05 21:16'), true);
  assert.equal(visibleLength(line) <= 180, true);
});

test('layoutPinnedEdges keeps right part visible and within max width', () => {
  const left = 'CPU 21% GPU 13% MEM 97% PING 185ms NET ↓2.4KB/s ↑16.7KB/s';
  const right = 'MODEL gpt-5';
  const line = layoutPinnedEdges(left, right, 72, 3);
  assert.equal(line.includes('gpt-5'), true);
  assert.equal(visibleLength(line) <= 72, true);
});
