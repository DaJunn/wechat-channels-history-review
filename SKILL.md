---
name: wechat-channels-history-review
metadata:
  version: "0.1.0"
description: 从已登录视频号后台采集指定范围的历史直播场次，批量读取概览与分钟趋势，生成跨场复盘。适用于近N场、近N天或全部可访问历史的对比；依赖 Kimi WebBridge，默认不扩展到全部历史。
---

# 视频号历史直播批量复盘

比较指定带货者的多场直播，找出货盘、流量承接与公司收益的差异。输出实际覆盖范围和失败清单，不能把可访问样本说成完整账号历史。

## 输入与准备

- 确认当前账号、带货者和范围；“近 N 场”与“近 N 天”分别处理。没有范围时先读取历史第 1 页；要求当前页时只读当前页，不擅自切回第 1 页。
- Chrome 已登录 `channels.weixin.qq.com`；Kimi WebBridge daemon 与扩展连接正常；Node.js 18+、Python 3.10+ 可用。
- 批量趋势分析固定查找 `~/.agents/skills/wechat-channels-data-reader/scripts/analyze_live_trend_minutes.py`，当前不支持用 `DATA_READER_DIR` 环境变量覆盖。缺依赖时说明不能生成自动趋势分析；概览采集仍可独立使用。
- 实施前读 [页面结构与脚本限制](references/history-page-structure.md)，尤其是金额单位、缺失值与断点汇总限制。

## 1. 采集并核对场次列表

```bash
SKILL_DIR="${SKILL_DIR:-$HOME/.agents/skills/wechat-channels-history-review}"
node "$SKILL_DIR/scripts/extract_livehistory_store.mjs" \
  --pages 1 --out ./history_sessions.json --wait-ms 8000
```

该命令新开历史页并读取第 1 页。用户明确要求全部可访问历史时，去掉 `--pages 1`；需要多页但有范围时设置足够的 `--pages N`，随后筛选实际日期/场次。不要把 `N` 当成场次数。`extract_history_sessions.mjs` 旧路径曾返回 0 场，只作排查用；store 失败时按页面结构读取，必要时用 `paginate_all_pages.mjs --pages N`，先核对当前页及截止范围。

输出有 `sessions`，每场含 `objectId`、标题、时长、观看、GMV、订单、详情 URL。先按 `objectId` 去重，核对账号、实际起止日期、金额单位和字段缺失。store 版 `createTime` 为 UTC 字符串，按北京时间筛日期前需转换；旧版本的 `date` 文本可能缺年份，不能猜年份。

**金额不可直接信任归一化：** store 脚本按数值是否大于 1000 决定是否除以 100，这是启发式。必须对照同场 dashboard 的金额单位；不能依据金额大小判断元/分。校验前不汇总收益。

## 2. 选择分析范围与深度

默认筛选 `viewers >= 100 && gmv > 0`，仅是分析样本规则，不能把被排除的场次自动称为测试或无效。保留总场数、筛选后数量、排除原因；零成交场对诊断转化仍有价值。

将用户范围内的场次保存为 `selected_sessions.json`（结构仍为 `{"sessions":[...]}`），先预演：

```bash
node "$SKILL_DIR/scripts/batch_deep_dive.mjs" \
  --sessions ./selected_sessions.json --out ./deep-dive --dry-run
```

核对预演名单后执行同一命令去掉 `--dry-run`。用户明确要求纳入零成交时用 `--no-gmv-filter`；要求不按观看/GMV筛选时用 `--all-sessions`，输入仍须限定为本次授权范围。

| 模式/选项 | 实际行为 |
|---|---|
| 默认 | 逐场概览 + 分钟 CSV；至少 10 点且依赖存在时调用趋势分析 |
| `--skip-trends` | 仅概览；分钟合计为空，跨场总 GMV/订单可能显示 0，不能当成真实 0 |
| `--resume` | 仅按已有 CSV 跳过；不会自动汇总已跳过场次，也不验证 CSV 完整性 |
| `--timeout 90000` | store 轮询超时，单位毫秒 |

脚本没有“只导趋势但不分析”的独立模式，不承诺固定每场耗时。失败场次保留原因后继续；遇登录失效、权限或限流时停止扩大采集。少于 10 个有效分钟点只报概览和缺失。

## 3. 校验、分析与交付

输出目录含每场 CSV、`live_trend_store_<objectId>_raw.json`、`live_trend_store_<objectId>_summary.json`，以及 `cross_session_summary.json`。批处理仅打印趋势分析的首行，完整报告需对相应文件手动运行依赖分析器并保存；详见参考文档的 raw 格式差异。

- 汇总前核对每场 GMV、订单、金额单位和概览。不能相加分钟 UV/买家数冒充跨分钟或跨场去重人数。
- 缺字段与真实 0 分开。批处理会把缺渠道字段或退款率当 0；无法从源数据证实时写“未提供”，不报告真实零退款或零加热。
- 公司侧预估收入 = 未扣退款的预估佣金 × MCN 分成 × (1−退款率)，默认 MCN 分成 40% 需注明。先核对佣金是否净额，避免重复扣退；缺退款不确认净收益。成本缺失则毛利润未计算。
- `--resume` 后如要全量汇总，按 `objectId` 合并本次及先前已验证的逐场结果并复核数量，不能直接采用新生成的局部汇总。

交付保持简洁：

1. 一句话结论，说明观测和待验证原因。
2. 数据来源、采集时间、范围、筛选规则、成功/失败/缺失场次。
3. 按场次列时长、GMV、订单、客单价、预估佣金、退款、公司侧测算及关键流量指标；未知留空并说明。
4. 跨场模式及支持数据，回看片段和下场测试动作，分别落到带货者、运营、选品。
5. 输出文件位置和未完成项。

只读已登录页面，不代登录、不读凭据、不截图 OCR 金额；不编造场次、接口或字段，不发送飞书/群消息。
