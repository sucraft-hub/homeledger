'use strict';
/**
 * 回归（进程内）：图片入参规范化 —— 开放 API/小龙虾传纯 dataURL 字符串时，
 * 必须正确转成 image_url.url 发给模型（曾因只读 img.dataUrl 导致 url 为空、模型 400）
 *
 * 运行：node test/verify-ai-image.js
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-aiimg-'));
process.env.DATA_DIR = dir;

const db = require('../src/db');
db.init();
const ai = require('../src/lib/ai');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

const png = fs.readFileSync(path.join(__dirname, 'fixtures', 'receipt.png'));
const DATA_URL = 'data:image/png;base64,' + png.toString('base64');

/* 桩服务：记录收到的 body，返回一笔结构化条目 */
let lastBody = null;
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    try { lastBody = JSON.parse(raw); } catch { lastBody = null; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            items: [{ type: 'expense', amount_cents: 3500, merchant: '兰州拉面馆', category_name: '餐饮', txn_date: '2026-09-16' }],
          }),
        },
      }],
    }));
  });
});

const imgUrls = () => {
  const msg = lastBody?.messages?.find((m) => Array.isArray(m.content));
  return (msg?.content || []).filter((c) => c.type === 'image_url').map((c) => c.image_url?.url || '');
};

(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;

  db.setSetting('ai.base_url', `http://127.0.0.1:${port}/v1`);
  db.setSetting('ai.model', 'stub-vision');
  db.setSetting('ai.api_key', '');
  db.setSetting('ai.enabled', 'true');
  db.setSetting('ai.vision', 'true');

  console.log('\n=== 图片入参规范化（进程内）===\n');

  /* ① 纯 dataURL 字符串（开放 API / SKILL.md 的形式）—— 曾经的 Bug */
  lastBody = null;
  const r1 = await ai.analyzeBill({ images: [DATA_URL], text: '', ledgerId: 0 });
  check('纯字符串形式：模型被真实调用', lastBody !== null);
  check('纯字符串形式：image_url.url 非空', imgUrls().length === 1 && imgUrls()[0].startsWith('data:image/png;base64,'),
    `url=${(imgUrls()[0] || '').slice(0, 32)}…(${(imgUrls()[0] || '').length} 字符)`);
  check('纯字符串形式：走大模型引擎且解析出条目', r1.engine === 'llm' && r1.items.length === 1,
    `engine=${r1.engine} items=${r1.items.length} 商户=${r1.items[0]?.merchant}`);
  check('纯字符串形式：无「url 为空」类警告', !r1.warnings.some((w) => /image_url|url cannot be empty|失败/i.test(w)),
    JSON.stringify(r1.warnings));

  /* ② { dataUrl } 对象形式（网页端）保持可用 */
  lastBody = null;
  const r2 = await ai.analyzeBill({ images: [{ dataUrl: DATA_URL }], text: '', ledgerId: 0 });
  check('对象形式：image_url.url 非空且引擎为 llm', imgUrls()[0] === DATA_URL && r2.engine === 'llm',
    `engine=${r2.engine}`);

  /* ③ 两者混用 */
  lastBody = null;
  await ai.analyzeBill({ images: [DATA_URL, { dataUrl: DATA_URL }], text: '', ledgerId: 0 });
  check('混合形式：两张图都被带上', imgUrls().length === 2, `count=${imgUrls().length}`);

  /* ④ 空图片不带着空 url 打模型 */
  lastBody = null;
  const r4 = await ai.analyzeBill({ images: [{}, ''], text: '', ledgerId: 0 });
  check('空图片：不调用模型且给出提示', lastBody === null && r4.warnings.some((w) => /图片数据为空/.test(w)),
    JSON.stringify(r4.warnings));

  /* ⑤ 应用内置测试：testConnection 纯文本仍正常 */
  lastBody = null;
  const t = await ai.testConnection();
  check('testConnection 正常返回', t.ok === true, JSON.stringify(t).slice(0, 80));

  stub.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
