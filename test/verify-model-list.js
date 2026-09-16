'use strict';
/**
 * 回归（进程内）：可用模型列表 listModels()
 *
 * 覆盖：
 *   · 正常解析 /models（data 数组、裸数组两种形态）
 *   · 排序稳定、视觉能力启发式标注（能读图 true / 非对话模型 false / 未知 null）
 *   · 鉴权失败、网关未实现 /models、空列表 的可读错误
 *   · 页面掩码串不会被当成真 Key 发出去（必须回落到已保存的 Key）
 *
 * 运行：node test/verify-model-list.js
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-models-'));
process.env.DATA_DIR = dir;

const db = require('../src/db');
db.init();
const ai = require('../src/lib/ai');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

const MODEL_IDS = ['GLM-4.6V-Flash', 'agnes-3.0-flash', 'glm-4.7-flash', 'qwen2.5vl:7b', 'text-embedding-3'];

let lastAuth = null;
const stub = http.createServer((req, res) => {
  lastAuth = req.headers.authorization || null;
  const url = req.url || '';
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (url.startsWith('/v1/models')) {
    return json(200, { object: 'list', data: MODEL_IDS.map((id) => ({ id, object: 'model', owned_by: 'stub' })) });
  }
  if (url.startsWith('/bare/models')) return json(200, MODEL_IDS);
  if (url.startsWith('/empty/models')) return json(200, { data: [] });
  if (url.startsWith('/auth/models')) return json(401, { error: { message: 'invalid api key' } });
  if (url.startsWith('/notfound/models')) return json(404, { error: { message: 'not found' } });
  return json(404, { error: { message: 'unexpected path' } });
});

(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  const base = `http://127.0.0.1:${port}`;

  console.log('\n=== 可用模型列表（进程内）===\n');

  /* ① 正常解析 */
  let r = await ai.listModels({ baseUrl: `${base}/v1` });
  check('读取模型列表成功', r.count === MODEL_IDS.length, `count=${r.count}`);
  check('返回按名称排序', JSON.stringify(r.models.map((m) => m.id)) === JSON.stringify([...MODEL_IDS].sort((a, b) => a.localeCompare(b))),
    r.models.map((m) => m.id).join(', '));
  const vision = Object.fromEntries(r.models.map((m) => [m.id, m.vision]));
  check('GLM-4.6V-Flash 判定为可读图', vision['GLM-4.6V-Flash'] === true, String(vision['GLM-4.6V-Flash']));
  check('qwen2.5vl:7b 判定为可读图', vision['qwen2.5vl:7b'] === true, String(vision['qwen2.5vl:7b']));
  check('text-embedding-3 判定为非对话模型', vision['text-embedding-3'] === false, String(vision['text-embedding-3']));
  check('glm-4.7-flash 不误判（未知）', vision['glm-4.7-flash'] === null, String(vision['glm-4.7-flash']));
  check('无法判断的模型不硬猜', vision['agnes-3.0-flash'] === null, String(vision['agnes-3.0-flash']));

  /* ② 裸数组形态 */
  r = await ai.listModels({ baseUrl: `${base}/bare` });
  check('兼容裸数组返回', r.count === MODEL_IDS.length, `count=${r.count}`);

  /* ③ 空列表 */
  r = await ai.listModels({ baseUrl: `${base}/empty` });
  check('空列表返回 count=0（不报错）', r.count === 0, `count=${r.count}`);

  /* ④ 未填地址（库里也没有）→ 可读提示 */
  const savedBaseUrl = db.getSetting('ai.base_url', '');
  const savedKey = db.getSetting('ai.api_key', '');
  db.setSetting('ai.base_url', '');
  db.setSetting('ai.api_key', '');
  let err = '';
  try { await ai.listModels({ baseUrl: '' }); } catch (e) { err = e.message; }
  db.setSetting('ai.base_url', savedBaseUrl);
  db.setSetting('ai.api_key', savedKey);
  check('未填地址给出可读提示', /请先填写接口地址/.test(err), err);

  /* ⑤ 鉴权失败（无 Key → 提示需要 Key） */
  err = '';
  try { await ai.listModels({ baseUrl: `${base}/auth` }); } catch (e) { err = e.message; }
  check('401 时报错含 HTTP 401', /HTTP 401/.test(err), err);
  check('401 且无 Key 时补充「需要 API Key」提示', /需要 API Key/.test(err), err);

  /* ⑥ 网关未实现 /models */
  err = '';
  try { await ai.listModels({ baseUrl: `${base}/notfound` }); } catch (e) { err = e.message; }
  check('404 时提示网关可能未实现该接口', /未实现 \/models/.test(err), err);

  /* ⑦ 掩码串不能被当成真 Key（必须回落到库里已保存的 Key） */
  db.setSetting('ai.base_url', `${base}/v1`);
  db.setSetting('ai.api_key', 'real-key-123');
  db.setSetting('ai.model', 'GLM-4.6V-Flash');
  lastAuth = null;
  await ai.listModels({ apiKey: '••••••' });
  check('页面掩码串被视为「未传」，改用已保存 Key', lastAuth === 'Bearer real-key-123', String(lastAuth));

  /* ⑧ 传了真实新 Key 时优先用它 */
  lastAuth = null;
  await ai.listModels({ apiKey: 'new-key-456' });
  check('传入真实新 Key 时优先使用', lastAuth === 'Bearer new-key-456', String(lastAuth));

  /* ⑨ 含全角圆点等非法字符的 Key 会被安全丢弃，绝不拼进 HTTP 头 */
  db.setSetting('ai.api_key', '');
  lastAuth = null;
  err = '';
  let threw = false;
  try { await ai.listModels({ apiKey: 'key\u2022with\u2022dots' }); } catch (e) { threw = true; err = e.message; }
  check('非法字符 Key 被丢弃后请求仍可正常完成', !threw, err);
  check('非法字符未进入请求头', lastAuth === null, String(lastAuth));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  stub.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
