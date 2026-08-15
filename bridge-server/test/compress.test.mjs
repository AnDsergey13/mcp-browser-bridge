// compress.test.mjs — capResponse: регрессия на баг пути в findLongestString
// (2026-08-15: самая длинная строка не под первым ключом → path собирался
// из best.path → setByPath шёл в строку → "Cannot create property 'markdown'
// on string" на page.extract с markdown + большим манифестом images).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capResponse } from '../src/compress.ts';

const bigImages = Array.from({ length: 95 }, (_, i) => ({
  n: i + 1,
  src: `https://files.cdn.thinkific.com/file_uploads/630778/images/71d/e04/b54/img_${i}.png?width=1920&dpr=2`,
  alt: '',
  w: 728,
  h: 270,
}));

test('capResponse: длинная строка НЕ под первым ключом — режется она, без throw', () => {
  const data = {
    url: 'https://course.cpsdrone.com/courses/take/cps-3-course-kit/downloads/74006049-gripper-upgrade',
    title: 't',
    flags: [],
    markdown: 'x'.repeat(15000),
    images: bigImages,
    untrusted_page_content: true,
  };
  const r = capResponse(data);
  assert.equal(r.truncated, true);
  assert.ok(r.data.markdown.includes('RESPONSE_TOO_LARGE'), 'markdown урезан с маркером');
  assert.ok(r.data.markdown.length < 15000, 'markdown стал короче');
  assert.equal(r.data.images.length, 95, 'манифест images не тронут');
  assert.equal(r.data.url, data.url, 'url не тронут');
});

test('capResponse: ответ под лимитом не меняется', () => {
  const data = { url: 'http://x', markdown: 'short' };
  const r = capResponse(data);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.data, data);
});

test('capResponse: data_jpeg_base64 не режется, в лимите не участвует', () => {
  const data = { data_jpeg_base64: 'A'.repeat(100 * 1024), note: 'ok' };
  const r = capResponse(data);
  assert.equal(r.truncated, false);
  assert.equal(r.data.data_jpeg_base64.length, 100 * 1024);
});

test('capResponse: скриншот за жёстким потолком → SCREENSHOT_TOO_LARGE', () => {
  const data = { data_jpeg_base64: 'A'.repeat(1_500_001), note: 'ok' };
  const r = capResponse(data);
  assert.equal(r.truncated, true);
  assert.equal(r.data.error, 'SCREENSHOT_TOO_LARGE');
  assert.equal(r.data.data_jpeg_base64, undefined, 'base64 не отдан');
});
