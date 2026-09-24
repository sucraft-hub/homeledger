'use strict';
/**
 * 回归（HTTP 端到端）：账单截图随记账一并保存并关联
 *
 * 需要先在 8099 起一个隔离实例（独立数据目录）：
 *   PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js
 * 然后：node test/verify-ai-attachments.js
 *
 * 覆盖：
 *   · 网页端「获取可用模型」接口（POST /api/ai/models）
 *   · 开放 API 发图入库（confirm:true）→ 图片落盘 + 关联到记录（images[].txn_id）
 *   · 令牌取图 GET /api/open/attachments/:id（无令牌 401）
 *   · 最近记录 GET /api/open/transactions/recent 带 images
 *   · 草稿模式默认不留档，save_images:true 才留档
 *   · 交易编辑页显示关联截图
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:8099';
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data-verify');
const png = fs.readFileSync(path.join(__dirname, 'fixtures', 'receipt.png'));
const DATA_URL = 'data:image/png;base64,' + png.toString('base64');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

/* 桩网关：/v1/models 列表 + /v1/chat/completions 固定识别结果 */
const stub = http.createServer((req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if ((req.url || '').startsWith('/v1/models')) {
    return json(200, { data: [{ id: 'stub-vl-1' }, { id: 'stub-4.6V-flash' }, { id: 'stub-text-only' }] });
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => json(200, {
    choices: [{
      message: {
        content: JSON.stringify({
          items: [{ type: 'expense', amount_cents: 3580, merchant: '兰州拉面馆', category_name: '餐饮', txn_date: '2026-09-16' }],
        }),
      },
    }],
  }));
});

let cookie = '';
async function req(method, p, { form, json, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  if (json) h['content-type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method,
    headers: h,
    body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  // 一次性读成 Buffer，文本与二进制断言都用它（Response body 只能读一次）
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8') };
}
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

/** 递归列出 DATA_DIR/uploads 下的全部文件 */
function uploadFiles(dir = path.join(DATA_DIR, 'uploads')) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...uploadFiles(p));
    else out.push(p);
  }
  return out;
}

(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = stub.address().port;
  const stubBase = `http://127.0.0.1:${stubPort}/v1`;

  console.log('\n=== 账单截图保存与关联（HTTP 端到端）===\n');

  /* 登录 + 建令牌 */
  let r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);
  r = await req('GET', '/settings');
  await req('POST', '/settings/api-tokens', { form: { _csrf: csrfOf(r.text), name: 'attach-check' } });
  r = await req('GET', '/settings');
  const token = (r.text.match(/data-token="(hl_[A-Za-z0-9_-]+)"/) || [])[1];
  check('创建开放 API 令牌', !!token, token ? token.slice(0, 10) + '…' : '未取到');
  const H = { authorization: `Bearer ${token}` };

  /* 配置 AI 指向桩网关 */
  r = await req('GET', '/settings');
  const saveAi = await req('POST', '/settings/ai', { form: {
    _csrf: csrfOf(r.text), 'ai.enabled': '1', 'ai.vision': '1',
    'ai.base_url': stubBase, 'ai.model': 'stub-vl-1', 'ai.api_key': 'stub-key', 'ai.timeout_ms': '30000',
  } });
  check('保存 AI 配置（指向桩网关）', saveAi.status === 302, `HTTP ${saveAi.status}`);

  /* ① 网页端「获取可用模型」 */
  r = await req('GET', '/settings');
  const modelsRes = await req('POST', '/api/ai/models', { json: { _csrf: csrfOf(r.text), base_url: stubBase, api_key: 'stub-key' } });
  let mj = {};
  try { mj = JSON.parse(modelsRes.text); } catch { /* ignore */ }
  check('POST /api/ai/models 返回模型列表', mj.ok === true && mj.count === 3, `count=${mj.count}`);
  const stubVision = Object.fromEntries((mj.models || []).map((m) => [m.id, m.vision]));
  check('列表中可读图模型被标注', stubVision['stub-4.6V-flash'] === true, String(stubVision['stub-4.6V-flash']));

  /* ② 开放 API 发图入库 —— 图片应随记录保存并关联 */
  const before = uploadFiles().length;
  let res = await req('POST', '/api/open/ai/bill', { headers: H, json: { images: [DATA_URL], confirm: true } });
  let j = JSON.parse(res.text);
  check('发图入库成功', j.ok === true && j.created === 1, `engine=${j.engine} created=${j.created}`);
  const txnId = (j.ids || [])[0];
  check('响应返回已保存的图片', Array.isArray(j.images) && j.images.length === 1, JSON.stringify(j.images));
  const img = (j.images || [])[0] || {};
  check('图片已关联到该笔记录', Number(img.txn_id) === Number(txnId), `image.txn_id=${img.txn_id} txn=${txnId}`);
  check('图片已落盘', uploadFiles().length === before + 1, `上传目录 ${before} → ${uploadFiles().length} 个文件`);
  const disk = uploadFiles().filter((f) => f.includes(String(img.path || '').split('/').pop()));
  check('落盘文件与返回的 path 一致', disk.length === 1, img.path || '(无 path)');

  /* ③ 带令牌取图 */
  res = await req('GET', `/api/open/attachments/${img.id}`, { headers: H });
  const got = res.buf;
  check('令牌取图返回 200', res.status === 200, `HTTP ${res.status}`);
  check('取图内容与上传一致（PNG）', got.length === png.length && got.slice(0, 8).toString('hex') === png.slice(0, 8).toString('hex'),
    `${got.length} vs ${png.length} 字节`);
  check('取图 Content-Type 正确', /image\/png/.test(res.headers.get('content-type') || ''), res.headers.get('content-type') || '');

  /* ④ 无令牌取图必须被拒 */
  const savedCookie = cookie; cookie = '';
  res = await req('GET', `/api/open/attachments/${img.id}`);
  check('无令牌取图返回 401', res.status === 401, `HTTP ${res.status}`);
  cookie = savedCookie;

  /* ⑤ 最近记录带图片 */
  res = await req('GET', '/api/open/transactions/recent?limit=5', { headers: H });
  j = JSON.parse(res.text);
  const rec = (j.transactions || []).find((t) => Number(t.id) === Number(txnId));
  check('recent 能取到该笔记录', !!rec, `共 ${j.count} 笔`);
  check('recent 记录带 images', !!(rec && rec.images && rec.images.length === 1), JSON.stringify(rec && rec.images));

  /* ⑥ 草稿模式默认不留档 */
  const beforeDraft = uploadFiles().length;
  res = await req('POST', '/api/open/ai/bill', { headers: H, json: { images: [DATA_URL], confirm: false } });
  j = JSON.parse(res.text);
  check('草稿模式返回 drafts', j.confirmed === false && (j.drafts || []).length === 1, `drafts=${(j.drafts || []).length}`);
  check('草稿模式默认不留档', (j.images || []).length === 0 && uploadFiles().length === beforeDraft,
    `images=${(j.images || []).length} 文件数=${uploadFiles().length}`);

  /* ⑦ 草稿模式显式 save_images 才留档 */
  res = await req('POST', '/api/open/ai/bill', { headers: H, json: { images: [DATA_URL], confirm: false, save_images: true } });
  j = JSON.parse(res.text);
  check('save_images:true 时草稿也留档', (j.images || []).length === 1 && j.images[0].txn_id === null,
    JSON.stringify(j.images));

  /* ⑧ 网页端能看到关联截图 */
  res = await req('GET', `/transactions/${txnId}/edit`);
  check('交易编辑页显示关联截图', res.status === 200 && /关联账单截图/.test(res.text), `HTTP ${res.status}`);
  check('交易编辑页内嵌图片地址', res.text.includes(String(img.path || '')), img.path || '');
  res = await req('GET', '/transactions');
  check('交易列表显示 📎 标记', /📎/.test(res.text));

  /* ⑨ 网页端截图记账链路（/api/ai/scan → /api/ai/confirm）同样要保存并关联 */
  r = await req('GET', '/settings');
  const csrf = csrfOf(r.text);
  const post = async (p, body) => {
    const x = await fetch(BASE + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie },
      body: JSON.stringify(body),
    });
    return { status: x.status, json: JSON.parse(await x.text()) };
  };
  const scan = await post('/api/ai/scan', { images: [{ dataUrl: DATA_URL, name: 'receipt.png' }], text: '' });
  check('网页端识别成功并落盘图片', scan.json.ok === true && (scan.json.images || []).length === 1,
    `HTTP ${scan.status} images=${(scan.json.images || []).length}`);
  const scanImg = (scan.json.images || [])[0] || {};
  // 网页端确认流程要求条目带账户，这里补一个账本里真实存在的账户（等价于用户在页面上选择）
  const accPage = await req('GET', '/accounts');
  const accId = Number((accPage.text.match(/data-id="(\d+)"/) || [])[1]) || null;
  check('取到可用于入账的账户', !!accId, String(accId));
  const conf = await post('/api/ai/confirm', {
    items: (scan.json.items || []).map((it) => ({ ...it, account_id: it.account_id || accId })),
    image_ids: [scanImg.id], source: 'ai_screenshot',
  });
  check('网页端确认入库', conf.json.ok === true && conf.json.created >= 1,
    `created=${conf.json.created} errors=${JSON.stringify(conf.json.errors || [])}`);
  check('网页端确认后图片已关联到记录', (conf.json.linked || []).length === 1, JSON.stringify(conf.json.linked || []));
  const webTxnId = (conf.json.ids || [])[0];
  res = await req('GET', `/transactions/${webTxnId}/edit`);
  check('网页端记录详情含关联截图', /关联账单截图/.test(res.text) && res.text.includes(String(scanImg.url || '')),
    scanImg.url || '');
  res = await req('GET', '/attachments');
  check('附件库能看到已关联截图', res.status === 200 && res.text.includes(String(scanImg.url || '')), `HTTP ${res.status}`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  stub.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
