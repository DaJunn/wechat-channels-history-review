# wechat-channels-history-review

批量读取视频号指定范围的历史直播场次，比较概览、分钟趋势和成交表现，形成跨场复盘与下场动作。

## 安装与依赖

需要 Node.js 18+、Python 3.10+、连接正常的 Kimi WebBridge，以及已登录视频号后台的 Chrome。

```bash
git clone https://github.com/DaJunn/wechat-channels-history-review.git \
  ~/.agents/skills/wechat-channels-history-review
git clone https://github.com/DaJunn/wechat-channels-data-reader.git \
  ~/.agents/skills/wechat-channels-data-reader
```

已有目录时不要重复克隆。批量分析固定从第二个目录查找趋势分析脚本；概览采集无需该依赖。

## 快速使用

对 AI 说：“对比这个带货者近 7 场”“复盘近 30 天直播”“分析全部可访问历史场次”。

```bash
SKILL_DIR="${SKILL_DIR:-$HOME/.agents/skills/wechat-channels-history-review}"
node "$SKILL_DIR/scripts/extract_livehistory_store.mjs" \
  --pages 1 --out ./history_sessions.json
node "$SKILL_DIR/scripts/batch_deep_dive.mjs" \
  --sessions ./history_sessions.json --out ./deep-dive --dry-run
```

示例只读第 1 页并预演分析名单。先核对账号、日期和金额单位，再按用户范围筛选并去掉 `--dry-run` 执行。明确要求全部历史时才去掉 `--pages 1`。

## 输出与限制

- 输出每场 CSV/raw/summary JSON、跨场汇总和运营复盘；实际覆盖取决于权限与页面返回。
- 默认分析看播人数 ≥100 且 GMV>0 的场次；筛选条件不代表其他场次无效。支持 `--no-gmv-filter`、`--all-sessions` 调整样本。
- `--skip-trends` 只读概览，脚本的分钟合计及跨场总数不可直接用；`--resume` 仅按 CSV 跳过，汇总不自动包含已跳过场次。
- 历史金额归一化存在数值阈值猜测，须对照同场后台确认单位。缺退款/渠道数据可能被脚本显示为 0，报告时必须回查并标明缺失。
- 公司侧预估收入需要佣金、分成和退款口径；毛利润还需公司成本。GMV 不能代表公司收益。
- 不代登录、不读凭据、不截图 OCR 金额，不自动发群。

完整流程见 [SKILL.md](SKILL.md)；已知脚本限制与字段结构见 [参考说明](references/history-page-structure.md)。
