'use strict';
/**
 * 开放 API：供小龙虾（OpenClaw / PicoClaw）、快捷指令等外部工具调用。
 * 鉴权：Authorization: Bearer <令牌>（在「设置 → 开放 API」中创建）。
 * 本路由挂在全局 CSRF 中间件之前，不走会话；令牌只存 SHA-256 摘要。
 */
const crypto = require('node:crypto');
const express = require('express');
const { get, run, nowStr, todayStr, TXN_TYPES } = require('../db');
const auth = require('../lib/auth');
const ai = require('../lib/ai');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');

const router = express.Router();

/* ------------------------------- 令牌工具 -------------------------------- */

function hashToken(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

/** 生成新令牌：hl_ + 24 字节随机数的 base64url（约 32 字符） */
function mintToken() {
  return 'hl_' + crypto.randomBytes(24).toString('base64url');
}

/* ------------------------------- 鉴权中间件 ------------------------------- */

function requireToken(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  const plain = m ? m[1].trim() : '';
  if (!plain) return res.status(401).json({ ok: false, error: '缺少 Bearer 令牌（Authorization: Bearer <令牌>）' });

  const row = get(
    `SELECT t.*, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    hashToken(plain)
  );
  if (!row) return res.status(401).json({ ok: false, error: '令牌无效或已吊销' });

  const ledgerId = Number(row.ledger_id) ||
    Number(get('SELECT ledger_id FROM ledger_members WHERE user_id = ? ORDER BY ledger_id LIMIT 1', row.user_id)?.ledger_id) ||
    0;
  if (!ledgerId) return res.status(403).json({ ok: false, error: '该令牌未绑定账本，且用户名下没有可用账本' });

  req.openAuth = { userId: Number(row.user_id), username: row.username, ledgerId, tokenId: Number(row.id), tokenName: row.name };
  run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowStr(), row.id);
  next();
}

router.use(requireToken);

/* --------------------------------- 连通性 -------------------------------- */

router.get('/ping', (req, res) => {
  res.json({
    ok: true,
    app: 'homeledger',
    ledger_id: req.openAuth.ledgerId,
    user: req.openAuth.username,
    token: req.openAuth.tokenName,
    today: todayStr(),
  });
});

/* ------------------------------- 名称解析 -------------------------------- */

/** 中文/英文别名 → 标准 type key */
const TYPE_ALIASES = (() => {
  const map = { 支出: 'expense', 收入: 'income', 转账: 'transfer', 借出: 'lend', 借入: 'borrow' };
  for (const t of TXN_TYPES) map[t.key] = t.key;
  return map;
})();

function resolveCategory(ledgerId, name, kind) {
  const s = String(name || '').trim();
  if (!s) return null;
  const cats = fd.flatCategories(ledgerId);
  const lower = s.toLowerCase();
  return (
    cats.find((c) => c.path.toLowerCase() === lower) ||
    cats.find((c) => c.name.toLowerCase() === lower && (!kind || c.kind === kind)) ||
    cats.find((c) => c.name.toLowerCase() === lower) ||
    null
  );
}

function resolveAccount(ledgerId, name, { autoCreate = true, created = null } = {}) {
  const s = String(name || '').trim();
  if (!s) return null;
  const acc = fd.accounts(ledgerId).find((a) => a.name === s);
  if (acc) return Number(acc.id);
  if (!autoCreate) return null;
  const info = run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, created_at) VALUES (?,?,?,?,?,?)`,
    ledgerId, s.slice(0, 30), 'debit', '🏦', 'CNY', nowStr()
  );
  if (created) created.push(s.slice(0, 30));
  return Number(info.lastInsertRowid);
}

function parseAmount(body) {
  if (body.amount_cents != null) return Math.abs(Math.round(Number(body.amount_cents) || 0));
  const yuan = Number(body.amount);
  if (!Number.isFinite(yuan) || yuan <= 0) return 0;
  return Math.abs(Math.round(yuan * 100));
}

/* -------------------------------- 记一笔 --------------------------------- */

router.post('/transactions', (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const body = req.body || {};
  try {
    const type = TYPE_ALIASES[String(body.type || 'expense').trim()] || 'expense';
    const amountCents = parseAmount(body);
    if (!amountCents) return res.status(400).json({ ok: false, error: '金额无效（请传 amount，单位：元）' });

    const createdAccounts = [];
    const isTransfer = ['transfer', 'invest_buy', 'invest_sell'].includes(type);
    const kind = type === 'income' || ['refund', 'interest', 'repay_receive', 'reimburse'].includes(type) ? 'income' : 'expense';
    const category = resolveCategory(ledgerId, body.category, kind);

    const txnId = txn.createTransaction(ledgerId, userId, {
      type,
      amount_cents: amountCents,
      currency: String(body.currency || 'CNY').toUpperCase().slice(0, 8),
      account_id: resolveAccount(ledgerId, body.account || body.account_name, { created: createdAccounts }),
      to_account_id: isTransfer ? resolveAccount(ledgerId, body.to_account || body.to_account_name, { created: createdAccounts }) : null,
      category_id: category ? Number(category.id) : null,
      txn_date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || body.txn_date || '')) ? String(body.date || body.txn_date) : todayStr(),
      note: body.note || '',
      merchant: body.merchant || '',
      tags: body.tags || '',
      is_reimbursable: body.is_reimbursable ? 1 : 0,
      source: 'api_open',
      ai_json: body.raw ? JSON.stringify(body.raw).slice(0, 4000) : null,
    });

    auth.audit(req, 'api.txn.create', {
      ledgerId, entity: 'transaction', entityId: txnId,
      detail: `开放API·${req.openAuth.tokenName} 记 ${type} ¥${(amountCents / 100).toFixed(2)}`,
    });
    res.json({
      ok: true, id: txnId,
      category_resolved: category ? category.path : null,
      accounts_created: createdAccounts,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ----------------------------- 截图 / 文本识别 ----------------------------- */

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

router.post('/ai/bill', async (req, res) => {
  const { ledgerId, userId } = req.openAuth;
  const body = req.body || {};
  try {
    const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
    const text = String(body.text || '').slice(0, 4000);
    if (!images.length && !text) {
      return res.status(400).json({ ok: false, error: '请提供 images（dataURL 数组）或 text 账单文字' });
    }
    for (const img of images) {
      const m = /^data:[^;]+;base64,(.+)$/.exec(String(img.dataUrl || img || ''));
      if (!m) return res.status(400).json({ ok: false, error: 'images 元素必须是 dataURL（data:image/...;base64,xxx）' });
      if (Buffer.byteLength(m[1], 'base64') > MAX_IMAGE_BYTES) {
        return res.status(400).json({ ok: false, error: '单张图片请小于 8MB' });
      }
    }

    const result = await ai.analyzeBill({ images, text, ledgerId });
    const confirm = body.confirm === true || body.confirm === 'true' || body.confirm === 1;

    if (!confirm) {
      return res.json({
        ok: true, engine: result.engine, model: result.model || null,
        warnings: result.warnings || [], drafts: result.items, confirmed: false,
        hint: '检查 drafts 无误后，用 confirm=true 重新调用即可直接入库',
      });
    }

    // 直接入库。账户解析链：条目自带 → body.default_account（可自动创建）→ 账本第一个账户
    const defaultAccName = body.default_account || body.default_account_name;
    const firstAccount = () =>
      Number(get('SELECT id FROM accounts WHERE ledger_id = ? AND is_archived = 0 ORDER BY sort_order, id LIMIT 1', ledgerId)?.id) || null;
    const createdAccounts = [];
    const created = [];
    const errors = [];
    for (const it of result.items) {
      try {
        const accountId = Number(it.account_id) ||
          resolveAccount(ledgerId, it.account_name || defaultAccName, { created: createdAccounts }) ||
          firstAccount();
        const id = txn.createTransaction(ledgerId, userId, {
          type: it.type || 'expense',
          amount_cents: Number(it.amount_cents) || 0,
          currency: it.currency || 'CNY',
          account_id: accountId,
          category_id: it.category_id || null,
          txn_date: it.txn_date || todayStr(),
          note: it.note || '',
          merchant: it.merchant || '',
          tags: it.tags || '',
          is_reimbursable: it.is_reimbursable ? 1 : 0,
          source: 'api_open_ai',
          ai_json: JSON.stringify(it.raw || it).slice(0, 4000),
        });
        created.push(id);
      } catch (e) {
        errors.push(`${it.merchant || it.note || '一笔'}：${e.message}`);
      }
    }
    auth.audit(req, 'api.ai.bill', {
      ledgerId, detail: `开放API·${req.openAuth.tokenName} ${result.engine} 识别并入库 ${created.length} 笔`,
    });
    res.json({
      ok: created.length > 0,
      engine: result.engine, model: result.model || null,
      warnings: result.warnings || [],
      accounts_created: createdAccounts,
      confirmed: true, created: created.length, ids: created, errors,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
