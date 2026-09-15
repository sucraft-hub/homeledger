'use strict';
/** 通用格式化 / 日期 / 金额辅助函数（服务端与模板共用） */

const CURRENCY_SYMBOL = {
  CNY: '¥', USD: '$', EUR: '€', HKD: 'HK$', JPY: '¥', GBP: '£',
  KRW: '₩', SGD: 'S$', AUD: 'A$', CAD: 'C$', TWD: 'NT$',
};

function currencySymbol(code) {
  return CURRENCY_SYMBOL[code] || (code ? code + ' ' : '¥');
}

/** 分 → 1,234.56 */
function fmtAmount(cents, decimals = 2) {
  const n = Number(cents || 0) / 100;
  const neg = n < 0;
  const s = Math.abs(n).toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return (neg ? '-' : '') + s;
}

/** 带币种符号 */
function money(cents, code = 'CNY') {
  return currencySymbol(code) + fmtAmount(cents);
}

/** 带正负号（用于收入/支出展示） */
function signedMoney(cents, code = 'CNY') {
  const n = Number(cents || 0);
  return (n > 0 ? '+' : n < 0 ? '-' : '') + currencySymbol(code) + fmtAmount(Math.abs(n));
}

/** 万元/亿 缩写，用于大额卡片 */
function compactMoney(cents, code = 'CNY') {
  const n = Math.abs(Number(cents || 0)) / 100;
  const s = currencySymbol(code);
  const sign = Number(cents) < 0 ? '-' : '';
  if (n >= 100000000) return `${sign}${s}${(n / 100000000).toFixed(2)}亿`;
  if (n >= 10000) return `${sign}${s}${(n / 10000).toFixed(2)}万`;
  return `${sign}${s}${n.toFixed(2)}`;
}

/** "12.5" / "¥12.50" / "1,234" → 分 */
function parseAmountToCents(input) {
  if (input === null || input === undefined) return 0;
  const cleaned = String(input).replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0;
  const v = Number(cleaned);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100);
}

const pad = (n) => String(n).padStart(2, '0');

function fmtDate(d) {
  if (!d) return '';
  return String(d).slice(0, 10);
}
function fmtDateTime(d) {
  return d ? String(d).slice(0, 16) : '';
}

/** 相对时间：今天 / 昨天 / 3天前 / 5月12日 */
function relDate(dateStr, today) {
  const d = fmtDate(dateStr);
  const t = today || new Date();
  const todayStr = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  const y = new Date(t.getTime() - 86400000);
  const yStr = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
  const tm = new Date(t.getTime() - 2 * 86400000);
  const tmStr = `${tm.getFullYear()}-${pad(tm.getMonth() + 1)}-${pad(tm.getDate())}`;
  if (d === todayStr) return '今天';
  if (d === yStr) return '昨天';
  if (d === tmStr) return '前天';
  const [yy, mm, dd] = d.split('-');
  if (yy === String(t.getFullYear())) return `${Number(mm)}月${Number(dd)}日`;
  return `${yy}年${Number(mm)}月${Number(dd)}日`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function weekdayOf(dateStr) {
  const d = new Date(`${fmtDate(dateStr)}T00:00:00`);
  return WEEKDAYS[d.getDay()];
}

function addDays(dateStr, n) {
  const d = new Date(`${fmtDate(dateStr)}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addMonths(monthStr, n) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
const monthOf = (dateStr) => fmtDate(dateStr).slice(0, 7);
function monthStart(monthStr) { return `${monthStr}-01`; }
function monthEnd(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${monthStr}-${pad(last)}`;
}
function daysInMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function monthLabel(monthStr) {
  const [y, m] = monthStr.split('-');
  return `${y}年${Number(m)}月`;
}
function monthShort(monthStr) {
  return `${Number(monthStr.split('-')[1])}月`;
}
/** 最近 n 个月（含当月），升序 */
function lastMonths(n, ref = new Date()) {
  const base = `${ref.getFullYear()}-${pad(ref.getMonth() + 1)}`;
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(base, -i));
  return out;
}
/** 某月的日期数组 */
function monthDays(monthStr) {
  const total = daysInMonth(monthStr);
  const out = [];
  for (let i = 1; i <= total; i++) out.push(`${monthStr}-${pad(i)}`);
  return out;
}
/** 该月第一天是周几（0=周日） */
function firstWeekday(monthStr) {
  const d = new Date(`${monthStr}-01T00:00:00`);
  return d.getDay();
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** HTML 转义 */
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s, n = 24) {
  if (!s) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/** 由字符串稳定生成一个颜色，用于成员/标签默认色 */
const PALETTE = ['#4f7cff', '#13c2c2', '#52c41a', '#fa8c16', '#eb2f96', '#722ed1', '#fa541c', '#1677ff', '#a0d911', '#f5222d'];
function colorFor(str) {
  if (!str) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 99991;
  return PALETTE[h % PALETTE.length];
}

function initials(name) {
  if (!name) return '?';
  const s = String(name).trim();
  if (/[\u4e00-\u9fa5]/.test(s)) return s.slice(-2);
  return s.slice(0, 2).toUpperCase();
}

/** 生成随机 id */
function uid(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** 汇率换算 */
function toBase(amountCents, rate) {
  return Math.round(amountCents * (Number(rate) || 1));
}

/** 数字百分比，用于预算进度条 */
function barPct(used, total) {
  return clamp(pct(used, total), 0, 100);
}

module.exports = {
  currencySymbol, fmtAmount, money, signedMoney, compactMoney, parseAmountToCents,
  pad, fmtDate, fmtDateTime, relDate, weekdayOf, WEEKDAYS,
  addDays, addMonths, monthOf, monthStart, monthEnd, daysInMonth,
  monthLabel, monthShort, lastMonths, monthDays, firstWeekday,
  pct, clamp, esc, truncate, colorFor, initials, uid, toBase, barPct,
  PALETTE,
};
