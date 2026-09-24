'use strict';
/** AI 记账：截图识别、文本识别、草稿确认入库 */
const express = require('express');
const { all, get, run, todayStr } = require('../db');
const auth = require('../lib/auth');
const ai = require('../lib/ai');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');
const att = require('../lib/attachments');

const router = express.Router();

/* --------------------------------- 页面 ---------------------------------- */

router.get('/ai', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const cfg = ai.getAiConfig();
  const recent = all(
    `SELECT a.*, t.amount_cents, t.txn_date, t.merchant, c.name AS category_name, c.icon AS category_icon
     FROM attachments a LEFT JOIN transactions t ON t.id = a.txn_id
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE a.ledger_id = ? ORDER BY a.id DESC LIMIT 12`,
    ledgerId
  );
  res.render('ai', {
    title: 'AI 截图记账', activeNav: 'ai',
    cfg, ready: ai.isAiReady(), usable: ai.isAiUsable(), recent,
    form: fd.txFormData(ledgerId, req.session.userId),
  });
});

/* ------------------------------- 截图识别 -------------------------------- */

router.post('/api/ai/scan', auth.requireLogin, auth.requireLedgerWrite, async (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  try {
    const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 6) : [];
    const text = String(req.body.text || '').slice(0, 4000);
    if (!images.length && !text) return res.status(400).json({ ok: false, error: '请上传账单截图或输入账单文字' });

    const saved = [];
    for (const img of images) {
      saved.push(att.saveDataUrlImage({ dataUrl: img.dataUrl, ledgerId, userId: req.session.userId, name: img.name }));
    }

    const result = await ai.analyzeBill({ images, text, ledgerId });
    // 把识别结果挂到第一张附件上，便于回溯
    if (saved[0]) run('UPDATE attachments SET ai_status = ? WHERE id = ?', result.engine === 'llm' ? 'recognized' : 'rule', saved[0].id);

    const categories = fd.flatCategories(ledgerId);
    const accounts = fd.accounts(ledgerId);
    const items = result.items.map((it) => ({
      ...it,
      category_path: categories.find((c) => Number(c.id) === Number(it.category_id))?.path || (it.category_name || '未分类'),
      account_name_resolved: accounts.find((a) => Number(a.id) === Number(it.account_id))?.name || '',
      kind: it.type === 'income' ? 'income' : 'expense',
    }));

    auth.audit(req, 'ai.scan', {
      entity: 'attachment', entityId: saved[0]?.id || null, ledgerId,
      detail: `${result.engine} 识别 ${items.length} 笔`,
    });

    res.json({
      ok: true,
      engine: result.engine,
      model: result.model || null,
      items,
      images: saved,
      warnings: result.warnings || [],
      autoSave: ai.getAiConfig().autoSave,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ------------------------------- 确认入库 -------------------------------- */

router.post('/api/ai/confirm', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const imageIds = (Array.isArray(req.body.image_ids) ? req.body.image_ids : []).map(Number).filter(Boolean);
  if (!items.length) return res.status(400).json({ ok: false, error: '没有可保存的记录' });

  const created = [];
  const errors = [];
  for (const it of items) {
    try {
      const id = txn.createTransaction(ledgerId, req.session.userId, {
        type: it.type || 'expense',
        amount_cents: Number(it.amount_cents) || 0,
        currency: it.currency || 'CNY',
        account_id: it.account_id || null,
        category_id: it.category_id || null,
        txn_date: it.txn_date || todayStr(),
        note: it.note || '',
        merchant: it.merchant || '',
        tags: it.tags || '',
        is_reimbursable: it.is_reimbursable ? 1 : 0,
        source: req.body.source || 'ai_screenshot',
        ai_json: JSON.stringify(it.raw || it).slice(0, 4000),
      });
      created.push(id);
    } catch (e) {
      errors.push(`${it.merchant || it.note || '一笔'}：${e.message}`);
    }
  }

  // 附件关联：数量一致时一一对应，否则全部挂到第一笔
  const linked = att.linkImagesToTxns({ ledgerId, imageIds, txnIds: created });

  auth.audit(req, 'ai.confirm', { ledgerId, detail: `入库 ${created.length} 笔，失败 ${errors.length}` });
  res.json({ ok: created.length > 0, created: created.length, ids: created, linked, errors, redirect: errors.length ? null : '/transactions' });
});

/* ------------------------------ 文本快速识别 ------------------------------ */

router.post('/api/ai/text', auth.requireLogin, auth.requireLedgerWrite, async (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  try {
    const text = String(req.body.text || '').slice(0, 4000);
    if (!text.trim()) return res.status(400).json({ ok: false, error: '请输入账单内容' });
    const result = await ai.analyzeBill({ images: [], text, ledgerId });
    const categories = fd.flatCategories(ledgerId);
    res.json({
      ok: true,
      engine: result.engine,
      warnings: result.warnings || [],
      items: result.items.map((it) => ({
        ...it,
        category_path: categories.find((c) => Number(c.id) === Number(it.category_id))?.path || (it.category_name || '未分类'),
      })),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ------------------------------ AI 小助手对话 ------------------------------ */

/**
 * 站内 AI 助手：文字或截图 → 识别 → 直接入库（source=ai_chat）。
 * 与 /api/ai/scan 的区别：一步到位自动记账，面向全局浮动助手的轻量调用。
 */
router.post('/api/ai/chat', auth.requireLogin, auth.requireLedgerWrite, async (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  try {
    const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 6) : [];
    const text = String(req.body.text || '').slice(0, 4000).trim();
    if (!images.length && !text) {
      return res.status(400).json({ ok: false, code: 'empty', error: '说一句消费（如「午饭 35 元」）或发一张账单截图' });
    }

    const saved = [];
    for (const img of images) {
      saved.push(att.saveDataUrlImage({ dataUrl: img.dataUrl, ledgerId, userId: req.session.userId, name: img.name }));
    }

    const result = await ai.analyzeBill({ images, text, ledgerId });
    if (saved[0]) run('UPDATE attachments SET ai_status = ? WHERE id = ?', result.engine === 'llm' ? 'recognized' : 'rule', saved[0].id);

    const categories = fd.flatCategories(ledgerId);
    const accountList = fd.accounts(ledgerId);
    // 规则引擎的识别项可能没有账户，自动落到账本第一个可用账户，保证「发出去就记好」
    const fallbackAccountId = accountList.length ? Number(accountList[0].id) : null;
    const items = result.items.map((it) => {
      const accountId = it.account_id || fallbackAccountId;
      return {
        ...it,
        account_id: accountId,
        category_path: categories.find((c) => Number(c.id) === Number(it.category_id))?.path || (it.category_name || '未分类'),
        account_name_resolved: accountList.find((a) => Number(a.id) === Number(accountId))?.name || '',
      };
    });

    // 自动记账：识别成功即入库，让对话像「发出去就记好了」
    const created = [];
    const errors = [];
    for (const it of items) {
      try {
        created.push(txn.createTransaction(ledgerId, req.session.userId, {
          type: it.type || 'expense',
          amount_cents: Number(it.amount_cents) || 0,
          currency: it.currency || 'CNY',
          account_id: it.account_id || null,
          category_id: it.category_id || null,
          txn_date: it.txn_date || todayStr(),
          note: it.note || '',
          merchant: it.merchant || '',
          tags: it.tags || '',
          is_reimbursable: it.is_reimbursable ? 1 : 0,
          source: 'ai_chat',
          ai_json: JSON.stringify(it.raw || it).slice(0, 4000),
        }));
      } catch (e) {
        errors.push(`${it.merchant || it.note || '一笔'}：${e.message}`);
      }
    }

    // 附件关联：数量一致时一一对应，否则挂到第一笔
    const linked = att.linkImagesToTxns({ ledgerId, imageIds: saved.map((s) => s.id), txnIds: created });

    auth.audit(req, 'ai.chat', {
      ledgerId, entity: 'transaction', entityId: created[0] || null,
      detail: `${result.engine} 识别 ${items.length} 笔，入库 ${created.length}，失败 ${errors.length}`,
    });

    res.json({
      ok: items.length === 0 || errors.length < items.length,
      engine: result.engine,
      model: result.model || null,
      items,
      created: created.length,
      ids: created,
      linked,
      errors,
      warnings: result.warnings || [],
      images: saved,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* -------------------------------- 附件操作 -------------------------------- */

router.get('/attachments', auth.requireLogin, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 36;
  const total = Number(get('SELECT COUNT(*) AS c FROM attachments WHERE ledger_id = ?', ledgerId)?.c || 0);
  const rows = all(
    `SELECT a.*, t.amount_cents, t.txn_date, t.merchant FROM attachments a
     LEFT JOIN transactions t ON t.id = a.txn_id
     WHERE a.ledger_id = ? ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    ledgerId, pageSize, (page - 1) * pageSize
  );
  res.render('attachments', {
    title: '账单截图', activeNav: 'ai', rows, page,
    pages: Math.max(1, Math.ceil(total / pageSize)), total,
  });
});

router.post('/attachments/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  if (att.removeById(ledgerId, req.params.id)) {
    auth.audit(req, 'attachment.delete', { ledgerId, entity: 'attachment', entityId: Number(req.params.id) });
  }
  if (req.body._json === '1') return res.json({ ok: true });
  res.flash('success', '截图已删除');
  res.redirect('/attachments');
});

module.exports = router;
