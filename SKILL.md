---
name: wechat-channels-history-review
metadata:
  version: "0.1.0"
description: 批量分析视频号带货者历史所有有效场次的直播数据。从直播历史页提取场次列表（包含 objectId），过滤有效场次（看播人数≥100且GMV大于0），逐场进入 dashboardV4 提取概览指标 + 分钟趋势 + 趋势分析，最后汇总跨场复盘。依赖 Kimi WebBridge + Chrome 已登录 channels.weixin.qq.com。触发词：分析带货者最近/历史所有场次、批量复盘、近7/30/所有场、每个有效场次、批量场次、跨场对比、所有直播场次。
---

# 视频号历史直播批量复盘

用于从 `channels.weixin.qq.com/platform/statistic/live?mode=history` 批量提取多场直播数据，逐场深扒 dashboardV4，输出跨场对比复盘。复用 `wechat-channels-data-reader` 的分钟趋势和趋势分析脚本。

**北极星：公司侧月度毛利润。不只看 GMV。**

---

## 快速流程

### Step 1: 提取场次列表

默认只提取当前历史页，适合先看近一页数据：

```bash
SKILL_DIR="${SKILL_DIR:-$HOME/.agents/skills/wechat-channels-history-review}"
node "$SKILL_DIR/scripts/extract_history_sessions.mjs" \
  --session wch-history-extract \
  --out /tmp/history_sessions.json \
  --wait-ms 12000
```

如果用户明确要求“所有场次 / 全部历史页”，优先用 store 全量提取：

```bash
SKILL_DIR="${SKILL_DIR:-$HOME/.agents/skills/wechat-channels-history-review}"
node "$SKILL_DIR/scripts/extract_livehistory_store.mjs" \
  --out /tmp/history_sessions_all.json \
  --wait-ms 8000
```

如果 store 不可用，再用 UI 翻页兜底：

```bash
SKILL_DIR="${SKILL_DIR:-$HOME/.agents/skills/wechat-channels-history-review}"
node "$SKILL_DIR/scripts/paginate_all_pages.mjs" \
  --out /tmp/history_sessions_all.json \
  --pages 15
```

输出 JSON 示例：
```json
{
  "generatedAt": "2026-06-29T12:00:00Z",
  "sessions": [
    {
      "objectId": "14887277057353779322",
      "title": "中产出国真实现状",
      "date": "03月28日 20:42",
      "durationSec": 11009,
      "durationFormatted": "3小时3分钟29秒",
      "viewers": 9966,
      "peakOnline": 165,
      "heat": 32,
      "gmv": 91.6,
      "dashboardUrl": "https://channels.weixin.qq.com/platform/statistic/dashboardV4?objetctId=14887277057353779322&entrance_id=3",
      "source": "merged"
    }
  ]
}
```

**前提条件：**
1. Chrome 已登录 `channels.weixin.qq.com` 并在直播数据页
2. Kimi WebBridge daemon 在跑
3. 当前选中的带货者正确（历史页显示的是该带货者的场次）

### Step 2: 过滤有效场次

剔除测试/无效场次：`viewers >= 100 && gmv > 0`。命令行快速过滤：

```bash
python3 -c "import json; d=json.load(open('/tmp/history_sessions.json')); valid=[s for s in d['sessions'] if (s.get('viewers') or 0)>=100 and (s.get('gmv') or 0)>0]; print(json.dumps({'count':len(valid),'sessions':valid},indent=2))"
```

输出有效场次列表，确认哪些需要深度分析。

### Step 3: 逐场深度分析（推荐用 batch_deep_dive.mjs 自动化）

**推荐：一键批量处理**

```bash
SKILL_DIR="${SKILL_DIR:-$HOME/.agents/skills/wechat-channels-history-review}"
node "$SKILL_DIR/scripts/batch_deep_dive.mjs" \
  --sessions /tmp/history_sessions.json \
  --out /tmp/deep-dive-results
```

`batch_deep_dive.mjs` 自动完成：
- 过滤 valid sessions（viewers >= 100 且 GMV > 0）
- 逐场串行：navigate → 指数退避轮询 wait store 就绪 → 提取概览（优先 store 对象，fallback innerText）→ 导出分钟趋势 → 跑趋势分析 → save → close
- 输出 `cross_session_summary.json` 汇总全部

选项：
- `--skip-trends`：只抓概览，不跑分钟趋势（更快）
- `--resume`：跳过已有输出文件的场次，支持断点续采
- `--wait-ms 15000`：页面加载等待时间
- `--timeout 90000`：store 轮询超时
- `--inter-session-ms 500`：场间暂停毫秒
- `--no-gmv-filter`：不过滤 GMV=0 的场次
- `--dry-run`：预演，不实际执行

速度优化（v0.1.0）：
- store 轮询采用指数退避（200ms 起步，最高 2s），减少空轮询
- 概览优先读 store 对象，避免 innerText 拉取 + 正则解析
- 场间暂停从 2s 降到 500ms
- `--resume`：重复运行自动跳过已有结果

**手动方案（fallback，以 curl 逐场操作）：**

```bash
# 先 snapshot 看页面是否加载
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"snapshot\",\"args\":{},\"session\":\"$SESSION_NAME\"}"

# 如果 snapshot 有内容，提取所有文本
python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
def xt(n):
    t=[]
    if isinstance(n,dict):
        if n.get('role')=='StaticText' and n.get('name'): t.append(n['name'])
        if 'children' in n:
            for c in n['children']: t.extend(xt(c))
    elif isinstance(n,list):
        for i in n: t.extend(xt(i))
    return t
t=list(dict.fromkeys(xt(data.get('data',{}).get('tree',[]))))
print('\n'.join(t))
"
```

从文本中提取关键字段：
- 累计成交金额 / GMV
- 成交订单数 / 成交单量
- 预估佣金
- 退款率
- 累计看播人数
- 最高在线人数
- 人均观看时长
- 新增关注
- 有效进房率
- 直播有效进房率
- 商品成交榜（#1 商品名 / 价格 / 店铺 / GMV贡献）

也可用 evaluate 直接读 iframe 内文本：
```js
const iframe = document.querySelector('iframe[name="statistic"]');
const doc = iframe.contentDocument;
return doc.body.innerText;
```

### Step 4: 汇总跨场复盘

按以下格式输出：

```text
结论：
【一句话总结：这些场次值不值得继续做，核心卡点是什么】

数据口径：
- 来源：直播历史页 + 逐场 dashboardV4
- 采集时间：
- 有效场次：X 场（过滤条件：看播 >= 100 且 GMV > 0）
- 缺失字段：

三场横向对比表：
| 指标 | S1: 日期 标题 | S2: 日期 标题 | S3: 日期 标题 |
|------|:---:|:---:|:---:|
| 时长 | | | |
| GMV | | | |
| 订单 | | | |
| ATV | | | |
| 佣金率 | | | |
| 退款率 | | | |
| 公司收入 | | | |
| 看播 | | | |
| 峰值在线 | | | |
| 商品 | | | |

逐场诊断：
1. 【场次标签】— 一句话判断
2. ...

跨场模式发现：
1. 【佣金 / 退款 / 人群 / 成交节奏】模式
2. ...

风险：
- ...

下一步：
1. 【选品动作】
2. 【转化节奏动作】
3. 【投流/人群测试】
4. 【退款管控】
```

## 有效场次定义

- 看播人数 >= 100（过滤测试/断流场次）
- GMV > 0（只看有成交的场次）
- 两者都满足才算有效

建议先列出所有场次给用户确认，再逐个深扒。

## 弹性的分析深度

本 Skill 支持三种深度模式，SKILL.md 执行过程中按需选择：

| 模式 | 操作 | 耗时/场 |
|------|------|:-------:|
| 全量 | 概览 + 分钟趋势 + 趋势分析 | 2-3min |
| 标准 | 概览 + 分钟趋势（不跑趋势分析） | 1-1.5min |
| 快速 | 只概览（不跑分钟趋势/趋势分析） | 20-30s |

默认推荐全量。如有效场次超过 5 个，可先用标准模式跑全部，再挑 2-3 场最佳/最差跑全量。

## 复用脚本路径

本 Skill 依赖 `wechat-channels-data-reader` 的以下脚本：

```bash
DATA_READER_DIR="${DATA_READER_DIR:-$HOME/.agents/skills/wechat-channels-data-reader}"

# 分钟趋势导出
node "$DATA_READER_DIR/scripts/export_live_trend_minutes.mjs"

# 趋势分析
python3 "$DATA_READER_DIR/scripts/analyze_live_trend_minutes.py" [csv-path] --raw [raw-json-path]

# 公司侧收入计算（可选）
python3 "$DATA_READER_DIR/scripts/calc_channels_metrics.py" /path/to/input.json
```

脚本路径用环境变量配置，不硬编码。

## 默认经营口径

- 公司侧收入 = 预估佣金 × MCN 分成 × (1 - 退款率)
- 默认 MCN 分成 40%（用户可覆盖）
- 使用 dashboard 的「预估佣金」实际值，而非 GMV × 默认佣金率
- 缺字段写"未提供"
- 如提供公司成本：毛利润 = 公司侧收入 - 成本；否则写"未计算"

## 失败处理

- 🔴 STOP 历史页 iframe 内容为空：让用户确认已登录并在直播数据页，刷新后重试
- 🔴 STOP `extract_history_sessions.mjs` 找不到活跃 tab：让用户打开 channels.weixin.qq.com
- 🔴 STOP 有效场次为 0：输出全部场次列表，让用户判断哪些是有效场次
- 🔴 STOP 某场 dashboardV4 加载失败：跳过该场，继续下一场，最后标注失败
- 分钟点 < 10：不跑趋势分析，只出概览
- 不编造字段、不截图 OCR 金额、不代登录

## 输出要求

每次执行最后追加「简版同步」：

```text
简版同步：
- 数据源：历史页 + X 场 dashboardV4
- 关键结果：总 GMV / 公司收入 / 有效场次数
- 核心发现：一句话
- 最该做的：一句话
```

## 禁止做什么

- 不在用户未明确要求时自动翻页全部历史（默认只分析当前页）
- 不代登录、不读 cookie/token
- 不截图 OCR
- 不编造接口、字段或商品数据
- 不把 GMV 当公司收入
- 不发送飞书/群消息
