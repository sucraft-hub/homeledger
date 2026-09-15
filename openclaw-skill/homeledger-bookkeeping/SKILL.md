---
name: homeledger-bookkeeping
description: 家账簿（HomeLedger）自动记账。当用户发送账单截图、支付记录截图或口述消费（如"午饭花了 35"）时，调用家账簿开放 API 自动记账并汇报结果。
---

# 家账簿自动记账技能

## 前置配置（技能环境变量或对话中告知）

- `HOMELEDGER_URL`：家账簿地址，例如 `http://192.168.5.250:8080`（NAS 局域网内可达）
- `HOMELEDGER_TOKEN`：API 令牌，在家账簿「设置 → 开放 API」中生成（`hl_` 开头）

两个变量缺一个时，先向用户询问，不要猜。

## 工作流程

### 1. 用户发来账单/支付截图

把截图转为 dataURL（`data:image/png;base64,…`），调用：

```bash
curl -sS -X POST "$HOMELEDGER_URL/api/open/ai/bill" \
  -H "Authorization: Bearer $HOMELEDGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"images":["<dataURL>"],"confirm":true}'
```

- `confirm: true` 表示识别后直接入库；若用户说"先给我看看"，改为 `confirm: false`，
  把返回的 `drafts`（每笔含 `type/txn_date/amount_cents/merchant/note`）列给用户确认后再以 `confirm: true` 重发。
- 返回 `ok: true` 时，用 `created`（笔数）和 `warnings` 向用户汇报；`errors` 非空要如实转述。

### 2. 用户口述消费 / 粘贴账单文字

优先走 AI 识别（能自动归类）：

```bash
curl -sS -X POST "$HOMELEDGER_URL/api/open/ai/bill" \
  -H "Authorization: Bearer $HOMELEDGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"昨天午饭 35 元，打车 26.5 元","confirm":true}'
```

一条明确简单的记录也可以直接记（更稳、更快）：

```bash
curl -sS -X POST "$HOMELEDGER_URL/api/open/transactions" \
  -H "Authorization: Bearer $HOMELEDGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"expense","amount":35,"category":"餐饮","account":"微信零钱","merchant":"面馆","note":"午饭","date":"2026-09-15"}'
```

字段说明：
- `type`：`expense` 支出 / `income` 收入 / `transfer` 转账（也接受中文"支出/收入/转账"）
- `amount`：元（小数）；`category`：分类名，如"餐饮"、"交通/打车"（父/子分类）
- `account`：支付账户名，不存在会自动创建并在响应 `accounts_created` 里提示
- `date`：`YYYY-MM-DD`，缺省为今天

### 3. 查询连通性

```bash
curl -sS "$HOMELEDGER_URL/api/open/ping" -H "Authorization: Bearer $HOMELEDGER_TOKEN"
```

## 汇报格式

记账成功后向用户简要汇报，例如：

> ✅ 已记 2 笔：餐饮/午餐 ¥35.00（微信零钱）、交通/打车 ¥26.50（微信零钱），来自截图识别。

识别失败或 AI 未配置时，把接口返回的 `error` / `warnings` 原样告诉用户，并提醒：
在家账簿「设置 → AI 记账」配置好视觉模型（如 glm-4v-flash）后截图识别更强。
