'use strict';
/**
 * 回归：AI 记账助手（POST /api/ai/chat + 前端挂载）
 *
 * 需先在 8099 起隔离实例：
 *   PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js
 * 覆盖：未登录拒绝、空载荷、纯文字自动记账（规则引擎）、文字+图片附件关联、
 *       仅图片零结果的友好返回、页面挂载（FAB/面板/脚本/CSS）、明细页 AI 筛选可见
 *
 * 运行：node test/verify-ai-chat.js
 */
const BASE = 'http://127.0.0.1:8099';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

let jar = ''; // 简易 cookie jar：自动携带会话
let csrf = ''; // 从页面 meta 提取，JSON POST 需带 x-csrf-token
async function req(method, p, { form, json, headers = {}, cookie } = {}) {
  const h = { ...headers };
  h.cookie = cookie || jar;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  if (json) {
    h['content-type'] = 'application/json';
    if (csrf) h['x-csrf-token'] = csrf;
  }
  const res = await fetch(BASE + p, {
    method, headers: h,
    body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length && !cookie) jar = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), json: (() => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } })(), setCookie: sc };
}

const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];
// 1x1 透明 PNG
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  console.log('\n=== AI 记账助手（HTTP 端到端）===\n');

  /* --- 未登录拒绝 --- */
  let r = await req('POST', '/api/ai/chat', { json: { text: '午饭 10 元' } });
  check('未登录 POST 被拒', r.status !== 200, `HTTP ${r.status}`);

  /* --- 登录 --- */
  r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);
  const cookie = loginRes.setCookie.map((c) => c.split(';')[0]).join('; ');

  /* --- 页面挂载 --- */
  r = await req('GET', '/');
  csrf = (r.text.match(/name="csrf" content="([^"]+)"/) || [])[1] || '';
  check('已取得页面 CSRF 令牌', !!csrf);
  check('总览页渲染助手 FAB', r.text.includes('id="aiFab"'));
  check('总览页渲染助手面板', r.text.includes('id="aiPanel"') && r.text.includes('id="aiMsgs"'));
  check('面板带状态提示（已连接或规则解析）', r.text.includes('规则解析') || r.text.includes('AI 模型已连接'));
  check('layout 引入 assistant.js', r.text.includes('/static/js/assistant.js'));
  r = await req('GET', '/static/js/assistant.js');
  check('assistant.js 可访问', r.status === 200 && r.text.includes('/api/ai/chat'), `HTTP ${r.status}`);
  r = await req('GET', '/static/css/app.css');
  check('助手样式已发布', r.status === 200 && r.text.includes('.ai-fab') && r.text.includes('.ai-bubble'));

  /* --- 参数校验 --- */
  r = await req('POST', '/api/ai/chat', { json: { text: '   ' }, cookie });
  check('空载荷返回 400 + code=empty', r.status === 400 && r.json && r.json.code === 'empty', `HTTP ${r.status}`);

  /* --- 纯文字自动记账（规则引擎兜底）--- */
  const chat = await req('POST', '/api/ai/chat', { json: { text: '昨天午饭 35 元，打车 26.5 元' }, cookie });
  check('纯文字识别 ok', chat.status === 200 && chat.json.ok === true, `HTTP ${chat.status}`);
  check('识别出 2 笔且已入库', chat.json.items && chat.json.items.length === 2 && chat.json.created === 2,
    `items=${(chat.json.items || []).length} created=${chat.json.created}`);
  check('规则引擎标记 engine=rule', chat.json.engine === 'rule');
  check('未配置模型时有降级提示', (chat.json.warnings || []).some((w) => /规则解析|尚未配置/.test(w)),
    (chat.json.warnings || []).join(' | '));
  const lunch = (chat.json.items || []).find((it) => /午/.test(it.category_path || '') || /午饭/.test(it.merchant || it.note || ''));
  check('金额解析正确（3500 分）', lunch && Number(lunch.amount_cents) === 3500, lunch && String(lunch.amount_cents));
  // 本地今天（不能用 toISOString：那是 UTC 日期，凌晨 0-8 点会比本地慢一天，断言必挂）
  const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  check('相对日期解析为昨天', lunch && lunch.txn_date && lunch.txn_date < localToday(), lunch && lunch.txn_date);

  /* --- 数据落库：source=ai_chat --- */
  const list = await req('GET', '/transactions?source=ai_chat', { cookie });
  check('明细页「ai_chat」筛选可访问', list.status === 200, `HTTP ${list.status}`);
  check('明细列表出现 35.00', list.text.includes('35.00'));

  /* --- 文字 + 图片：附件关联 --- */
  const chat2 = await req('POST', '/api/ai/chat', { json: { text: '奶茶 18 元', images: [{ dataUrl: TINY_PNG, name: 'bill.png' }] }, cookie });
  check('图文混合识别 ok', chat2.status === 200 && chat2.json.ok === true, `HTTP ${chat2.status}`);
  check('图片已存档', (chat2.json.images || []).length === 1, `images=${(chat2.json.images || []).length}`);
  check('图片已关联到生成的流水', (chat2.json.linked || []).length >= 1, JSON.stringify(chat2.json.linked || []));
  const createdId = (chat2.json.ids || [])[0];
  if (createdId) {
    r = await req('GET', `/transactions/${createdId}/edit`, { cookie });
    check('详情页可见关联原图', r.status === 200 && r.text.includes('/uploads/'));
  }

  /* --- 仅图片（无文字）：零结果友好返回 --- */
  const chat3 = await req('POST', '/api/ai/chat', { json: { images: [{ dataUrl: TINY_PNG }] }, cookie });
  check('仅图片不报 500/400', chat3.status === 200, `HTTP ${chat3.status}`);
  check('零结果 ok=true 不算失败', chat3.json.ok === true && (chat3.json.items || []).length === 0 && chat3.json.created === 0);
  check('零结果带降级提示', (chat3.json.warnings || []).length >= 1, (chat3.json.warnings || []).join(' | '));

  /* --- 超限裁剪 --- */
  const many = Array.from({ length: 9 }, () => ({ dataUrl: TINY_PNG }));
  const chat4 = await req('POST', '/api/ai/chat', { json: { text: '测试', images: many }, cookie });
  check('图片最多收 6 张（9 张入参被裁剪）', (chat4.json.images || []).length === 6, `images=${(chat4.json.images || []).length}`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
