'use strict';
/** 表单/页面公共数据加载 */
const { all, get } = require('../db');

function categoryTree(ledgerId, kind = 'expense') {
  const rows = all(
    `SELECT * FROM categories WHERE kind = ? AND is_archived = 0 AND (ledger_id IS NULL OR ledger_id = ?)
     ORDER BY sort_order, id`,
    kind, ledgerId
  );
  const roots = rows.filter((r) => !r.parent_id);
  return roots.map((r) => ({
    ...r,
    children: rows.filter((c) => Number(c.parent_id) === Number(r.id)),
  }));
}

function flatCategories(ledgerId, kind = null) {
  let sql = `SELECT c.*, p.name AS parent_name FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
             WHERE c.is_archived = 0 AND (c.ledger_id IS NULL OR c.ledger_id = ?)`;
  const params = [ledgerId];
  if (kind) { sql += ' AND c.kind = ?'; params.push(kind); }
  sql += ' ORDER BY c.kind DESC, COALESCE(p.sort_order, c.sort_order), c.sort_order, c.id';
  return all(sql, ...params).map((c) => ({
    ...c,
    path: c.parent_name ? `${c.parent_name}/${c.name}` : c.name,
  }));
}

function accounts(ledgerId) {
  return all('SELECT * FROM accounts WHERE ledger_id = ? AND is_archived = 0 ORDER BY sort_order, id', ledgerId);
}
function archivedAccounts(ledgerId) {
  return all('SELECT * FROM accounts WHERE ledger_id = ? AND is_archived = 1 ORDER BY sort_order, id', ledgerId);
}
function members(ledgerId) {
  return all(
    `SELECT m.*, u.display_name, u.username, u.avatar_color, u.last_login_at
     FROM ledger_members m JOIN users u ON u.id = m.user_id
     WHERE m.ledger_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, m.id`,
    ledgerId
  );
}
function tags(ledgerId) {
  return all(
    `SELECT t.*, (SELECT COUNT(*) FROM transaction_tags tt WHERE tt.tag_id = t.id) AS cnt
     FROM tags t WHERE t.ledger_id = ? ORDER BY cnt DESC, t.id LIMIT 100`,
    ledgerId
  );
}

/** 记一笔页面所需的全部下拉数据 */
function txFormData(ledgerId, userId) {
  const cats = flatCategories(ledgerId);
  return {
    expenseCats: cats.filter((c) => c.kind === 'expense'),
    incomeCats: cats.filter((c) => c.kind === 'income'),
    expenseTree: categoryTree(ledgerId, 'expense'),
    incomeTree: categoryTree(ledgerId, 'income'),
    accounts: accounts(ledgerId),
    members: members(ledgerId),
    tags: tags(ledgerId),
  };
}

/** 分析用：该笔交易的收支归属 */
function kindOf(type) {
  return ['income', 'interest', 'refund', 'reimburse'].includes(type) ? 'income' : 'expense';
}

module.exports = { categoryTree, flatCategories, accounts, archivedAccounts, members, tags, txFormData, kindOf };
