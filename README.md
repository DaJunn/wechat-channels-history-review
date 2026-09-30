# wechat-channels-history-review

**视频号历史直播批量复盘** —— 一次跑完账号历史所有有效场次，输出跨场对比。

让 AI agent（DSH / Codex / Claude Code 等）使用。

## 解决什么问题

之前只能一场一场看，想知道「最近哪几场值得研究」得手动翻历史页、一场场点进数据大屏。

现在能一次跑完，自动过滤掉测试场，汇总成跨场对比——哪场最好、好在哪、什么模式在重复。

## 流程

1. **提场次列表** —— 从历史页 runtime store 读，含 `objectId`
2. **过滤有效场次** —— 看播人数 ≥ 100 **且** GMV > 0（剔除测试/断流场）
3. **逐场深度分析** —— 进 dashboardV4 抓概览 + 分钟趋势 + 趋势分析
4. **汇总跨场复盘** —— 横向对比表 + 逐场诊断 + 跨场模式发现

## 前置依赖

1. **kimi-webbridge daemon** 在跑：
   ```bash
   ~/.kimi-webbridge/bin/kimi-webbridge status
   ```
2. **Chrome 已登录** `channels.weixin.qq.com` 并停在直播数据页
3. **`wechat-channels-data-reader`**（复用它的分钟趋势与趋势分析脚本）：
   ```bash
   git clone https://github.com/DaJunn/wechat-channels-data-reader.git \
     ~/.agents/skills/wechat-channels-data-reader
   ```
4. Node.js、Python 3

## 安装

```bash
git clone https://github.com/DaJunn/wechat-channels-history-review.git \
  ~/.agents/skills/wechat-channels-history-review
```

## 用法

```bash
SKILL_DIR="${SKILL_DIR:-$HOME/.agents/skills/wechat-channels-history-review}"

# ① 提场次列表（推荐用 store 版）
node "$SKILL_DIR/scripts/extract_livehistory_store.mjs" \
  --out /tmp/history_sessions.json --wait-ms 8000

# ② 过滤有效场次
python3 -c "import json; d=json.load(open('/tmp/history_sessions.json')); \
valid=[s for s in d['sessions'] if (s.get('viewers') or 0)>=100 and (s.get('gmv') or 0)>0]; \
print(json.dumps({'count':len(valid),'sessions':valid},indent=2))"

# ③ 逐场深度分析（一键批量）
node "$SKILL_DIR/scripts/batch_deep_dive.mjs" \
  --sessions /tmp/history_sessions.json --out /tmp/deep-dive-results
```

`batch_deep_dive.mjs` 支持：

| 选项 | 作用 |
|---|---|
| `--resume` | 跳过已有输出，**断点续采** |
| `--skip-trends` | 只抓概览，不跑分钟趋势（更快） |
| `--no-gmv-filter` | 不过滤 GMV=0 的场次 |
| `--dry-run` | 预演，不实际执行 |

## 深度可选

| 模式 | 操作 | 耗时/场 |
|---|---|---|
| 全量 | 概览 + 分钟趋势 + 趋势分析 | 2-3 min |
| 标准 | 概览 + 分钟趋势 | 1-1.5 min |
| 快速 | 只概览 | 20-30 s |

有效场次超过 5 个时，建议先用标准模式跑全部，再挑 2-3 场最佳/最差跑全量。

## ⚠️ 已知坑

- **`extract_history_sessions.mjs` 实测返回 0 场，不要用**，改用 `extract_livehistory_store.mjs`（读 runtime store，更稳）。
- 历史接口有**订阅墙**：查询窗口 > 30 天会返回 403「仅限尊享版 Pro」。所以能拿到的场次数可能远少于账号实际场次。
- 「近 N 场」≠「近 N 天」。窗口不够时如实说明，不要自动扩大。

## 触发方式

对 agent 说：「分析这个带货者最近所有场次」「批量复盘历史场次」「近 7 场每场怎么样」「跨场对比」。

## 默认口径

- 公司侧收入 = 预估佣金 × MCN 分成 × (1 − 退款率)
- 默认 MCN 分成 40%
- 不把 GMV 当公司收入，缺字段写「未提供」

## 安全

- 不代登录、不读 cookie / token
- 不截图 OCR 金额
- 不编造接口、字段或商品数据
- 未明确要求时不自动翻页全部历史（默认只分析当前页）
