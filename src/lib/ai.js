'use strict';
/**
 * AI 记账引擎（双引擎）
 *  1) 视觉大模型：任意 OpenAI 兼容接口（智谱 / 通义 / DeepSeek / OpenAI / 本地 Ollama）
 *  2) 规则解析：未配置 Key 时兜底，纯本地、零依赖，仍能识别常见账单文本
 * 输出统一为「账单草稿」结构，交给用户确认后再落库。
 */
const { all, get, getSetting, setSetting, todayStr } = require('../db');
const { parseAmountToCents, uid } = require('./util');

/* -------------------------------- 配置读取 -------------------------------- */

/* ------------------------ 密钥 / 请求头的安全处理 ------------------------ */

/**
 * 掩码或占位符：整串都是圆点（•  U+2022 / · U+00B7）、星号或空白。
 * 这类值可能是页面上的「已保存」掩码被误当成真实 Key 提交，绝不能当密钥用。
 */
const MASKED_SECRET = /^[•·*\u2022\u00b7\s]+$/;

/**
 * HTTP 头值只能是 Latin-1（≤ 0xFF）。
 * 一旦掺入中文、全角标点、圆点等字符，Node 的 fetch 会直接抛
 * 「Cannot convert argument to a ByteString because the character at index N ...」，
 * 报错信息完全看不出真正原因，所以这里提前拦住并给出可读提示。
 */
function isHeaderSafe(v) {
  const s = String(v == null ? '' : v);
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return false;
  return true;
}

const isMaskedSecret = (v) => MASKED_SECRET.test(String(v == null ? '' : v).trim());

/** 把掩码串 / 含非法字符的密钥统一视为「未配置」 */
function sanitizeSecret(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || isMaskedSecret(s) || !isHeaderSafe(s)) return '';
  return s;
}

/* --------------------------------- 配置读取 -------------------------------- */

function getAiConfig() {
  const rawKey = String(getSetting('ai.api_key', '') || '').trim();
  const apiKey = sanitizeSecret(rawKey);
  // 自愈：清掉历史上被掩码串或非法字符污染的 Key，否则每次请求都会炸
  if (rawKey && !apiKey) setSetting('ai.api_key', '');
  return {
    enabled: String(getSetting('ai.enabled', 'false')) === 'true',
    baseUrl: (getSetting('ai.base_url', '') || '').replace(/\/+$/, ''),
    apiKey,
    model: String(getSetting('ai.model', '') || '').trim(),
    vision: String(getSetting('ai.vision', 'true')) === 'true',
    autoSave: String(getSetting('ai.auto_save', 'false')) === 'true',
    timeoutMs: Number(getSetting('ai.timeout_ms', '90000')) || 90000,
  };
}

/** 局域网 / 本机地址通常不需要 API Key（如自建 Ollama） */
function isLocalUrl(url) {
  const u = String(url || '');
  return /(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|192\.168\.|10\.\d|172\.(1[6-9]|2\d|3[01])\.)/.test(u);
}

/** 配置是否完整：填了地址与模型，且要么有 Key、要么是本地推理 */
function isAiReady() {
  const c = getAiConfig();
  return !!c.baseUrl && !!c.model && (!!c.apiKey || isLocalUrl(c.baseUrl));
}

/** 配置完整且已启用 */
function isAiUsable() {
  return getAiConfig().enabled && isAiReady();
}

/* --------------------------- 规则引擎：关键词分类 --------------------------- */

/** 关键词 → 分类（按顺序匹配，越靠前优先级越高） */
const KEYWORD_RULES = [
  // 收入
  [/工资|薪资|薪水|月薪|发薪|代发工资|payroll/i, '工资', 'income'],
  [/年终奖|绩效奖|季度奖|奖金|目标奖/i, '奖金', 'income'],
  [/报销|报账|差旅报销|发票回款/i, '报销回款', 'income'],
  [/退款|退货|退回|返现|价保/i, '退款', 'income'],
  [/红包(收|入)|收到红包|抢红包|微信红包(收)/i, '红包', 'income'],
  [/利息|结息|余额宝收益|零钱通收益/i, '利息收入', 'income'],
  [/基金|股票|理财|债券|黄金.*收益|证券|沪深|ETF/i, '基金收益', 'income'],
  [/房租收|租金收|收租/i, '房租收入', 'income'],
  [/分红|股息/i, '分红', 'income'],
  [/兼职|外快|稿费|劳务/i, '兼职外快', 'income'],
  [/公积金/i, '公积金提取', 'income'],
  [/理赔|赔付/i, '保险理赔', 'income'],
  // 支出 - 餐饮
  [/早餐|豆浆|包子|粥|煎饼/i, '早餐', 'expense'],
  [/午餐|中饭|午饭|快餐|盖饭|兰州|麻辣烫|黄焖/i, '午餐', 'expense'],
  [/晚餐|晚饭|夜宵|烧烤|火锅|烤鱼|西餐|晚餐/i, '晚餐', 'expense'],
  [/外卖|美团|饿了么|饿了|肯德基|麦当劳|汉堡|必胜客|披萨/i, '外卖', 'expense'],
  [/咖啡|星巴克|瑞幸|奶茶|喜茶|蜜雪|霸王茶姬|茶百道|古茗|饮料|可乐|矿泉水|果汁/i, '饮料', 'expense'],
  [/零食|薯片|坚果|巧克力|糖果/i, '零食', 'expense'],
  [/水果|超市水果|生鲜|菜市场|买菜|蔬菜/i, '水果', 'expense'],
  [/饭店|餐厅|酒楼|大排档|宴会|餐饮/i, '下馆子', 'expense'],
  [/香烟|烟草|酒(?!店)|白酒|啤酒|红酒/i, '烟酒', 'expense'],
  // 交通
  [/地铁|轨道交通|公交|巴士|公交车/i, '公交', 'expense'],
  [/出租车|滴滴|网约车|打车|曹操|T3出行|高德打车/i, '打车', 'expense'],
  [/加油|中石化|中石油|壳牌|油费/i, '加油', 'expense'],
  [/停车|停车场|停车费/i, '停车', 'expense'],
  [/高速|过路|ETC|通行费/i, '过路费', 'expense'],
  [/洗车/i, '洗车', 'expense'],
  [/保养|4S店|机油/i, '车辆保养', 'expense'],
  [/修车|维修.*车|汽车维修/i, '车辆维修', 'expense'],
  [/车险|交强险|车辆保险/i, '车险', 'expense'],
  [/高铁|火车|动车|12306|铁路/i, '火车', 'expense'],
  [/机票|航空|航班|机场/i, '飞机', 'expense'],
  [/共享单车|哈啰|青桔|摩拜|美团单车/i, '共享单车', 'expense'],
  // 居住
  [/房租|租房|租金(?!收)|押金.*房/i, '房租', 'expense'],
  [/物业|物业管理/i, '物业费', 'expense'],
  [/水费|自来水/i, '水费', 'expense'],
  [/电费|国网|电力/i, '电费', 'expense'],
  [/燃气|天然气|煤气/i, '燃气费', 'expense'],
  [/取暖|暖气|供暖/i, '取暖费', 'expense'],
  [/宽带|电信|联通|移动.*宽带/i, '宽带费', 'expense'],
  [/保洁|家政|钟点工/i, '家政保洁', 'expense'],
  [/房贷|按揭|还款.*贷/i, '房贷', 'expense'],
  [/装修|建材|瓷砖|家具城/i, '装修', 'expense'],
  // 通讯
  [/话费|充值.*移动|充值.*联通|充值.*电信|手机费/i, '手机话费', 'expense'],
  [/流量|流量包/i, '流量充值', 'expense'],
  [/快递|邮费|顺丰|中通|圆通|韵达|申通|京东物流/i, '快递邮费', 'expense'],
  // 购物
  [/超市|永辉|沃尔玛|家乐福|大润发|盒马|华润万家|便利店|罗森|全家|711/i, '日用百货', 'expense'],
  [/洗发水|沐浴露|牙膏|纸巾|洗衣液|清洁|日化/i, '个护清洁', 'expense'],
  [/淘宝|天猫|京东(?!物流)|拼多多|唯品会|苏宁|商城|网购/i, '其他购物', 'expense'],
  [/宜家|家居|收纳|锅碗|厨具/i, '家居用品', 'expense'],
  [/五金|工具|螺丝/i, '五金工具', 'expense'],
  // 服饰
  [/优衣库|衣服|服装|T恤|衬衫|外套|羽绒|连衣裙|运动服/i, '上衣', 'expense'],
  [/裤子|牛仔|长裤|短裤|瑜伽裤/i, '裤装', 'expense'],
  [/鞋|耐克|阿迪|nike|adidas|安踏|李宁|运动鞋/i, '鞋靴', 'expense'],
  [/内衣|袜子|文胸/i, '内衣袜', 'expense'],
  [/包|箱包|背包|手提包|钱包/i, '箱包', 'expense'],
  [/饰品|项链|戒指|手表|首饰/i, '配饰', 'expense'],
  [/理发|剪发|美发|烫发|染发/i, '理发美发', 'expense'],
  // 娱乐
  [/电影|影城|电影院|万达影|猫眼|淘票票/i, '电影', 'expense'],
  [/游戏|steam|王者荣耀|和平精英|原神|点券|充值.*游戏/i, '游戏', 'expense'],
  [/演唱会|话剧|展览|音乐会|演出/i, '演出展览', 'expense'],
  [/会员|订阅|爱奇艺|腾讯视频|优酷|芒果|网易云|QQ音乐|Netflix|WPS会员|百度网盘/i, '会员订阅', 'expense'],
  [/酒吧|KTV|夜店|清吧/i, '酒吧', 'expense'],
  [/书店|图书|当当|书籍/i, '书籍影音', 'expense'],
  [/景区|门票|游玩|乐园|迪士尼|环球影城/i, '旅游门票', 'expense'],
  // 医疗
  [/医院|门诊|挂号|诊所|急诊/i, '门诊', 'expense'],
  [/药|药店|大药房|医药/i, '药品', 'expense'],
  [/住院|手术|治疗/i, '住院', 'expense'],
  [/体检|健康检查/i, '体检', 'expense'],
  [/牙|口腔|齿科|正畸/i, '牙科', 'expense'],
  [/眼镜|配镜|眼科|视力/i, '眼科', 'expense'],
  [/保健|营养品|维生素/i, '保健品', 'expense'],
  [/保险|保费|重疾|医疗险|寿险|意外险/i, '重疾险', 'expense'],
  // 教育
  [/学费|学杂费/i, '学费', 'expense'],
  [/培训|课程|培训班|辅导|补习|驾校/i, '培训费', 'expense'],
  [/书|教材|文具|笔记本|钢笔/i, '教材文具', 'expense'],
  [/在线课程|网课|知识付费|得到|知乎盐选/i, '在线课程', 'expense'],
  [/考试|报名费|资格证/i, '考试报名', 'expense'],
  // 人情
  [/红包(发|出)|发红包|群收款|转账给/i, '红包', 'expense'],
  [/礼金|份子钱|随礼|婚礼|满月酒/i, '礼金', 'expense'],
  [/请客|聚餐|宴请/i, '请客', 'expense'],
  [/捐赠|公益|慈善|捐款/i, '慈善捐赠', 'expense'],
  [/孝敬|父母|爸妈|长辈/i, '孝敬长辈', 'expense'],
  // 育儿 / 宠物
  [/奶粉|尿不湿|尿布|婴儿|宝宝|童装|儿童/i, '奶粉', 'expense'],
  [/早教|兴趣班|幼儿园|托育/i, '早教', 'expense'],
  [/宠物|猫粮|狗粮|猫砂|宠物医院|宠物店/i, '宠物主粮', 'expense'],
  // 运动
  [/健身|健身房|私教|Keep|乐刻|超级猩猩/i, '健身卡', 'expense'],
  [/球|羽毛球|篮球|足球|网球|乒乓球/i, '球类', 'expense'],
  [/游泳|泳池/i, '游泳', 'expense'],
  [/露营|户外|登山|徒步/i, '户外露营', 'expense'],
  // 旅行
  [/酒店|民宿|住宿|客栈|Airbnb|携程.*酒店/i, '酒店', 'expense'],
  [/旅游|旅行|跟团|自由行|携程|飞猪|去哪儿/i, '跟团游', 'expense'],
  [/签证/i, '签证', 'expense'],
  // 美容
  [/化妆|口红|粉底|彩妆|屈臣氏|丝芙兰/i, '化妆品', 'expense'],
  [/护肤|面膜|精华|乳液|爽肤水/i, '护肤品', 'expense'],
  [/美甲|美睫/i, '美甲', 'expense'],
  [/美容|SPA|按摩|足疗/i, '美容SPA', 'expense'],
  [/医美|整形|瘦脸|光子/i, '医美', 'expense'],
  // 数码
  [/手机|iPhone|华为|小米|OPPO|vivo|荣耀|一加/i, '手机', 'expense'],
  [/电脑|笔记本|MacBook|台式机|显示器/i, '电脑', 'expense'],
  [/耳机|键盘|鼠标|充电|数据线|外设|配件/i, '外设配件', 'expense'],
  [/软件|Adobe|Office|Steam.*买|订阅.*软件/i, '软件购买', 'expense'],
  [/智能家居|扫地机器人|智能门锁|摄像头/i, '智能家居', 'expense'],
  // 办公经营
  [/办公|打印|耗材|硒鼓|A4纸/i, '办公用品', 'expense'],
  [/差旅|出差|住宿.*出差/i, '差旅', 'expense'],
  [/团建|年会/i, '团建', 'expense'],
  [/广告|推广|投放|竞价|直通车/i, '广告推广', 'expense'],
  [/云服务器|域名|服务器|阿里云|腾讯云|华为云|VPS/i, '软件服务', 'expense'],
  // 金融
  [/手续费|服务费|佣金/i, '手续费', 'expense'],
  [/税费|个税|增值税|开票.*税/i, '税费', 'expense'],
  [/罚|违章|违约金/i, '罚款违约金', 'expense'],
  [/年费|卡费/i, '信用卡年费', 'expense'],
];

const ACCOUNT_KEYWORDS = [
  [/支付宝|花呗|余额宝|蚂蚁|alipay/i, '支付宝'],
  [/微信|零钱通|财付通|wechat/i, '微信'],
  [/京东|白条/i, '京东'],
  [/云闪付|银联/i, '银行卡'],
  [/银行卡|储蓄卡|借记卡|提现到卡|转到卡/i, '银行卡'],
  [/现金|钞/i, '现金'],
  [/信用卡|贷记/i, '信用卡'],
];

/** 关键词取分类名 */
function classifyByKeywords(text) {
  const s = String(text || '');
  for (const [re, cat, kind] of KEYWORD_RULES) {
    if (re.test(s)) return { category: cat, kind };
  }
  return null;
}

/** 从文本猜测账户 */
function guessAccountName(text) {
  for (const [re, name] of ACCOUNT_KEYWORDS) {
    if (re.test(String(text || ''))) return name;
  }
  return null;
}

/** 解析自然语言日期 */
function parseDateWords(text, today = todayStr()) {
  const s = String(text || '');
  const shift = (n) => {
    const d = new Date(`${today}T00:00:00`);
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  if (/前天/.test(s)) return shift(2);
  if (/昨天|昨晚|昨日/.test(s)) return shift(1);
  if (/今天|刚刚|今早|今晚|刚才/.test(s)) return today;
  let m = s.match(/(20\d{2})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[-\/月](\d{1,2})/);
  if (m) {
    const y = today.slice(0, 4);
    return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  m = s.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (m) {
    const y = today.slice(0, 4);
    return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  return today;
}

/** 从一行文本里抽金额 */
function extractAmount(text) {
  const s = String(text || '');
  const m =
    s.match(/(?:¥|￥|RMB|CNY)\s*([\d,]+(?:\.\d{1,2})?)/i) ||
    s.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:元|块钱|块|圆)/) ||
    s.match(/(?:金额|总计|合计|实付|支付|付款|收入|支出)[:：\s]*([\d,]+(?:\.\d{1,2})?)/);
  if (m) return parseAmountToCents(m[1]);
  const nums = s.match(/\d+(?:\.\d{1,2})?/g);
  if (!nums) return 0;
  return parseAmountToCents(nums.sort((a, b) => Number(b) - Number(a))[0]);
}

/** 规则引擎：纯文本 → 账单草稿数组 */
function parseTextByRules(text, { today = todayStr() } = {}) {
  const lines = String(text || '')
    .split(/\n|;|；/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const amount = extractAmount(line);
    if (!amount) continue;
    const cls = classifyByKeywords(line);
    const kind = /收入|工资|报销|退款|收|入账/.test(line) && !cls ? 'income' : (cls?.kind || 'expense');
    out.push({
      type: /转账|转出|转到/.test(line) ? 'transfer' : kind === 'income' ? 'income' : 'expense',
      amount_cents: amount,
      currency: 'CNY',
      txn_date: parseDateWords(line, today),
      merchant: cleanMerchant(line),
      note: line.slice(0, 120),
      category_name: cls?.category || null,
      account_name: guessAccountName(line),
      confidence: 0.45,
      engine: 'rule',
    });
  }
  return out;
}

function cleanMerchant(line) {
  let s = String(line)
    .replace(/(?:¥|￥|RMB|CNY)\s*[\d,]+(?:\.\d{1,2})?/gi, ' ')
    .replace(/[\d,]+(?:\.\d{1,2})?\s*(?:元|块钱|块|圆)/g, ' ')
    .replace(/(今天|昨天|前天|昨晚|今早|刚刚|刚才|上午|下午|晚上|中午)/g, ' ')
    .replace(/(支付宝|微信支付|微信|花呗|余额宝|云闪付|信用卡|现金|银行卡|零钱通|白条)/g, ' ')
    .replace(/[，,。.、:：!！?？\-—_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 40) || null;
}

/* ------------------------------ 大模型调用 ------------------------------- */

function extractJson(text) {
  if (!text) return null;
  const s = String(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  try { return JSON.parse(body.trim()); } catch { /* 继续尝试 */ }
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(body.slice(first, last + 1)); } catch { /* ignore */ }
  }
  const arrFirst = body.indexOf('[');
  const arrLast = body.lastIndexOf(']');
  if (arrFirst >= 0 && arrLast > arrFirst) {
    try { return JSON.parse(body.slice(arrFirst, arrLast + 1)); } catch { /* ignore */ }
  }
  return null;
}

async function callModel(messages, cfg = getAiConfig()) {
  if (!cfg.baseUrl || !cfg.model) throw new Error('未配置 AI 模型');
  if (!isHeaderSafe(cfg.baseUrl) || !isHeaderSafe(cfg.model)) {
    throw new Error('接口地址或模型名含有非法字符（可能是复制粘贴带入了中文或全角符号），请在「设置 → AI 识别」中重新填写');
  }
  if (cfg.apiKey && !isHeaderSafe(cfg.apiKey)) {
    throw new Error('API Key 含有非法字符（可能复制时带入了全角符号或占位圆点），请在「设置 → AI 识别」中重新粘贴');
  }
  const url = `${cfg.baseUrl}/chat/completions`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 90000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0.1,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw.slice(0, 400);
      try { msg = JSON.parse(raw).error?.message || msg; } catch { /* ignore */ }
      // 局域网地址被当作「无需 Key」，但有些网关（one-api / LiteLLM 之类）其实要鉴权，
      // 直接报 401 会让人摸不着头脑，这里补一句可操作的提示
      if (!cfg.apiKey && (res.status === 401 || res.status === 403)) {
        msg += '（该接口需要 API Key，请到「设置 → AI 识别」填写后再试）';
      }
      throw new Error(`模型返回 ${res.status}：${msg}`);
    }
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('模型返回内容无法解析为 JSON'); }
    const content = data.choices?.[0]?.message?.content;
    if (content === undefined) throw new Error('模型未返回内容：' + raw.slice(0, 200));
    return typeof content === 'string' ? content : JSON.stringify(content);
  } finally {
    clearTimeout(timer);
  }
}

/** 组装给模型的上下文（分类、账户、成员） */
function buildContext(ledgerId) {
  const cats = all(
    `SELECT c.id, c.name, c.kind, p.name AS parent FROM categories c
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE (c.ledger_id IS NULL OR c.ledger_id = ?) AND c.is_archived = 0`,
    ledgerId
  );
  const expensePaths = cats
    .filter((c) => c.kind === 'expense')
    .map((c) => (c.parent ? `${c.parent}/${c.name}` : c.name));
  const incomePaths = cats.filter((c) => c.kind === 'income').map((c) => (c.parent ? `${c.parent}/${c.name}` : c.name));
  const accounts = all('SELECT id, name, type FROM accounts WHERE ledger_id = ? AND is_archived = 0', ledgerId);
  const members = all(
    `SELECT u.display_name AS name FROM ledger_members m JOIN users u ON u.id = m.user_id WHERE m.ledger_id = ?`,
    ledgerId
  );
  return { cats, expensePaths, incomePaths, accounts, members };
}

const SYSTEM_PROMPT = `你是一个专业的记账助手，负责把「账单截图」或「账单文字」转换成结构化记账数据。
要求：
1. 只输出 JSON，不要输出任何解释文字，不要使用 Markdown 代码块。
2. 一张截图里可能包含多笔交易（例如账单列表），必须逐笔提取。
3. 金额一律为数字（元），不要带货币符号；支出/付款为正常正数。
4. 日期格式 YYYY-MM-DD；若截图只有月日则补齐为今年；无法确定则用今天。
5. type 只能取：expense（支出）、income（收入）、transfer（转账）。
6. category_name 必须从给定的分类列表中选择最贴近的「完整路径」，若都不合适则选「其他支出/其他」这类兜底项。
7. 若能识别出付款方式，acct 填对应账户名。
8. confidence 为 0~1 的小数，表示你对这笔提取的把握。
输出格式：
{"items":[{"type":"expense","amount":35.00,"txn_date":"2026-09-15","merchant":"肯德基","note":"午餐","category_name":"餐饮/午餐","acct":"支付宝","currency":"CNY","confidence":0.95}]}`;

function buildUserPrompt({ text, ctx, today }) {
  return [
    `今天是 ${today}。`,
    `可选支出分类（完整路径）：${ctx.expensePaths.join('、')}`,
    `可选收入分类（完整路径）：${ctx.incomePaths.join('、')}`,
    `可用账户：${ctx.accounts.map((a) => a.name).join('、') || '（无）'}`,
    `账本成员：${ctx.members.map((m) => m.name).join('、') || '（无）'}`,
    text ? `需要识别的账单文字：\n${text}` : '请识别随附的账单截图。若有多张图片，请合并提取所有交易。',
  ].join('\n');
}

/** 修正模型输出的分类名到真实分类 id */
function resolveCategoryId(ledgerId, nameHint, kind) {
  if (!nameHint) return null;
  const hint = String(nameHint).trim();
  const rows = all(
    `SELECT c.id, c.name, c.kind, p.name AS parent FROM categories c
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE (c.ledger_id IS NULL OR c.ledger_id = ?) AND c.kind = ? AND c.is_archived = 0`,
    ledgerId, kind
  );
  const norm = (s) => String(s || '').replace(/\s/g, '');
  const target = norm(hint);
  // 1) 完整路径精确匹配
  for (const r of rows) {
    const full = r.parent ? `${r.parent}/${r.name}` : r.name;
    if (norm(full) === target) return Number(r.id);
  }
  // 2) 叶子名精确匹配
  for (const r of rows) if (norm(r.name) === target) return Number(r.id);
  // 3) 末段匹配（"餐饮/午餐" → "午餐"）
  const tail = target.includes('/') ? target.split('/').pop() : target;
  for (const r of rows) if (norm(r.name) === norm(tail)) return Number(r.id);
  // 4) 包含匹配
  for (const r of rows) {
    if (norm(r.name).includes(tail) || tail.includes(norm(r.name))) return Number(r.id);
    if (r.parent && (norm(r.parent).includes(tail) || tail.includes(norm(r.parent)))) return Number(r.id);
  }
  // 5) 关键词兜底
  const kw = classifyByKeywords(hint);
  if (kw) {
    for (const r of rows) if (norm(r.name) === norm(kw.category)) return Number(r.id);
    for (const r of rows) if (r.parent && norm(r.parent) === norm(kw.category)) return Number(r.id);
  }
  return null;
}

/** 账户名 → 账户 id（宽松匹配） */
function resolveAccountId(ledgerId, nameHint) {
  if (!nameHint) return null;
  const accounts = all('SELECT id, name FROM accounts WHERE ledger_id = ? AND is_archived = 0', ledgerId);
  const hint = String(nameHint).replace(/\s/g, '');
  for (const a of accounts) if (hint.includes(a.name.replace(/\s/g, '')) || a.name.replace(/\s/g, '').includes(hint)) return Number(a.id);
  for (const a of accounts) {
    if ((hint.includes('支付宝') || hint.includes('花呗')) && /支付宝|花呗/.test(a.name)) return Number(a.id);
    if (hint.includes('微信') && /微信/.test(a.name)) return Number(a.id);
    if (hint.includes('现金') && /现金/.test(a.name)) return Number(a.id);
    if (hint.includes('信用') && /信用/.test(a.name)) return Number(a.id);
  }
  return null;
}

/** 规范化单条草稿 */
function normalizeItem(raw, ledgerId) {
  const type = ['expense', 'income', 'transfer'].includes(raw.type) ? raw.type : 'expense';
  const kind = type === 'income' ? 'income' : 'expense';
  const amountCents = Number.isFinite(Number(raw.amount_cents))
    ? Number(raw.amount_cents)
    : parseAmountToCents(raw.amount);
  const catName = raw.category_name || raw.category || null;
  let categoryId = resolveCategoryId(ledgerId, catName, kind);
  if (!categoryId && type !== 'transfer') {
    const kw = classifyByKeywords(`${raw.merchant || ''} ${raw.note || ''} ${catName || ''}`);
    if (kw) categoryId = resolveCategoryId(ledgerId, kw.category, kw.kind === 'income' ? 'income' : kind);
    if (!categoryId) categoryId = resolveCategoryId(ledgerId, kind === 'income' ? '其他收入' : '其他支出', kind);
  }
  return {
    draft_id: uid(10),
    type,
    amount_cents: Math.abs(amountCents || 0),
    currency: raw.currency || 'CNY',
    txn_date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.txn_date || '')) ? raw.txn_date : todayStr(),
    merchant: raw.merchant ? String(raw.merchant).slice(0, 60) : null,
    note: raw.note ? String(raw.note).slice(0, 200) : null,
    category_id: categoryId,
    category_name: catName,
    account_id: resolveAccountId(ledgerId, raw.acct || raw.account || raw.account_name),
    account_name: raw.acct || raw.account || raw.account_name || null,
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0.8,
    raw,
  };
}

/* -------------------------------- 对外主接口 ------------------------------- */

/**
 * 识别账单（图片 + 文字）
 * @param {object} o
 * @param {Array<{dataUrl:string}>} o.images
 * @param {string} o.text
 * @param {number} o.ledgerId
 */
async function analyzeBill({ images = [], text = '', ledgerId }) {
  const cfg = getAiConfig();
  const ctx = buildContext(ledgerId);
  const today = todayStr();
  const warnings = [];

  // 1) 有模型且（有图 or 想更聪明的文本解析）→ 走大模型
  const canUseModel = isAiUsable() && ((images.length > 0 && cfg.vision) || text);
  if (canUseModel) {
    try {
      const content = [{ type: 'text', text: buildUserPrompt({ text, ctx, today }) }];
      for (const img of images.slice(0, 6)) {
        content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      }
      const out = await callModel(
        [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }],
        cfg
      );
      const parsed = extractJson(out);
      const items = Array.isArray(parsed) ? parsed : parsed?.items;
      if (Array.isArray(items) && items.length) {
        return {
          engine: 'llm',
          model: cfg.model,
          items: items.map((it) => normalizeItem(it, ledgerId)),
          warnings,
        };
      }
      warnings.push('模型未返回可识别的交易，已尝试规则解析兜底。');
    } catch (e) {
      warnings.push(`AI 调用失败（${e.message}），已降级为规则解析。`);
    }
  } else if (images.length && !cfg.vision) {
    warnings.push('当前模型未开启视觉能力，无法读取截图内容。');
  } else if (!isAiReady()) {
    warnings.push('尚未配置 AI 模型，当前使用内置规则解析（在「设置 → AI 记账」中配置后可获得更强识别能力）。');
  }

  // 2) 规则兜底
  if (text) {
    const items = parseTextByRules(text, { today }).map((it) => normalizeItem(it, ledgerId));
    if (items.length) return { engine: 'rule', model: null, items, warnings };
  }
  return { engine: 'rule', model: null, items: [], warnings };
}

/** 测试连接 */
async function testConnection() {
  const cfg = getAiConfig();
  if (!cfg.baseUrl || !cfg.model) return { ok: false, error: '请先填写接口地址与模型名称' };
  try {
    const out = await callModel(
      [
        { role: 'system', content: '你是一个测试助手，只输出 JSON。' },
        { role: 'user', content: '请输出 {"ok":true,"msg":"连接正常"}' },
      ],
      { ...cfg, timeoutMs: 30000 }
    );
    return { ok: true, raw: out.slice(0, 300) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  getAiConfig, isAiReady, isAiUsable, isLocalUrl, analyzeBill, testConnection,
  classifyByKeywords, guessAccountName, parseDateWords, parseTextByRules,
  resolveCategoryId, resolveAccountId, normalizeItem, buildContext,
  extractAmount, cleanMerchant, callModel,
  isHeaderSafe, isMaskedSecret, sanitizeSecret,
};
