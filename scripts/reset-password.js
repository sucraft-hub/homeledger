#!/usr/bin/env node
'use strict';
/**
 * 家账簿 · 用户密码重置工具（忘记密码时使用）
 *
 * 用法:
 *   DATA_DIR=<应用数据目录> node scripts/reset-password.js <用户名> <新密码>
 *
 * 说明:
 *   - DATA_DIR 缺省为仓库下的 data/（即应用默认数据目录）；NAS 上请指向应用
 *     数据目录（内含 homeledger.db 的那个目录）
 *   - 需要 Node 22+（使用内置 node:sqlite），可直接用应用内置的 runtime/node
 *   - 重置后立即生效，并清除该用户的全部登录会话
 *   - 密码会出现在命令行/Shell 历史中，重置完成后建议再从网页端改一次
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const [, , username, newPassword] = process.argv;
if (!username || !newPassword) {
  console.error('用法: DATA_DIR=<数据目录> node scripts/reset-password.js <用户名> <新密码>');
  console.error('示例: DATA_DIR=/vol1/@appdata/homeledger/data node scripts/reset-password.js admin "新密码"');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'homeledger.db');
if (!fs.existsSync(dbFile)) {
  console.error(`❌ 找不到数据库文件: ${dbFile}`);
  console.error('   请确认 DATA_DIR 指向应用的数据目录（可用 find /vol1 -name homeledger.db 定位）');
  process.exit(1);
}

/* 与 src/lib/auth.js 完全一致的 scrypt 哈希格式 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const hashPassword = (plain) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }).toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`;
};

const db = new DatabaseSync(dbFile);
const user = db.prepare('SELECT id, username, is_admin, status FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`❌ 用户不存在: ${username}`);
  const names = db.prepare('SELECT username FROM users ORDER BY id').all().map((r) => r.username);
  console.error(`   现有用户: ${names.join(', ') || '(无)'}`);
  process.exit(1);
}

db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

console.log(`✅ 已重置用户 ${user.username}（id=${user.id}${user.is_admin ? '，管理员' : ''}）的密码`);
console.log('   该用户的全部登录会话已清除，请用新密码重新登录。');
console.log('   ⚠️ 建议登录后到「设置 → 账号安全」再自行修改一次密码。');
