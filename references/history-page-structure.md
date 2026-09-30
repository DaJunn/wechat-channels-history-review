# 历史页结构与脚本限制

页面路径：`https://channels.weixin.qq.com/platform/statistic/live?mode=history`。以下是脚本使用的结构，页面升级后应重新核验，不能把历史观测当作接口契约。

## 读取路径

- 主页面可能只有外壳，数据在同源 `iframe[name="statistic"]`。
- store 路径：`iframe.contentWindow._store.statisticStore.liveHistory`。
- `extract_livehistory_store.mjs` 新开历史页，通过 `changePage()`、`loadLiveHistory()` 读取 `history`，默认从第 1 页遍历全部页；`--pages 1` 仅读第 1 页。
- 页面表格可能虚拟滚动，DOM 与 `body.innerText` 都不保证包含未渲染行。旧 `extract_history_sessions.mjs` 曾采到 0 场，不能用空结果直接断言没有直播。
- 同一浏览器已登录账号的新标签页通常复用登录态，但必须检查实际页面；遇到扫码/授权由用户完成。

详情主页面 URL：

```text
https://channels.weixin.qq.com/platform/statistic/dashboardV4?objetctId=<objectId>&entrance_id=3
```

这里的 `objetctId` 是页面现有拼写。不要直接打开或刷新 `/micro/statistic/dashboardV4` 子页面。

## store 列表字段

| 输出字段 | 来源与注意事项 |
|---|---|
| `objectId` | `liveObjectId`，按字符串保留并去重 |
| `title` | `description` |
| `createTime` | 秒时间戳转 UTC 字符串，输出未带时区后缀；按北京时间筛选需明确转换 |
| `durationSec` | `liveStats.liveDurationInSeconds` |
| `viewers` | `liveStats.totalAudienceCount` |
| `gmv` | `payedGmv` 经 `normalizeGmv()`；当前单位判断不可靠，见下 |
| `orders` / `buyers` | `payedNum` / `payedUserUv` |
| `peakOnline` / `heat` | `maxOnlineCount` / `hotQuota` |

旧 DOM 版的 `date` 可能只有月日时分，与 store 版 `createTime` 不同。多次导出的日期字段不能直接混排，先确认时区与年份。

## 使用前必须处理的限制

1. **金额单位启发式。** `normalizeGmv()` 对大于 1000 的值除以 100，小于等于 1000 的值原样返回。不能因此确认单位；从同场可见金额与实际 store 字段核验后再统计。
2. **默认值混入缺失。** 多处 `Number(x) || 0` 将缺失显示为 0。批量收入计算把缺退款当作 0，佣金为 0 又返回空值；报告前需要原始证据，区分未提供与真实 0。
3. **分钟合计不等于概览。** `cross_session_summary.json` 的 GMV/订单来自分钟序列求和；缺序列或使用 `--skip-trends` 时可能显示 0。对照概览或经过单位验证的历史场次值，不盲用合计。
4. **断点不是全量合并。** `--resume` 仅检查 CSV 是否存在，不验证完整性；新汇总只含本次处理的场次，并覆盖同名汇总文件。全量报告须按 ID 合并各次已验证结果并复核数量。仅概览模式没有 CSV，因此不会按该规则跳过。
5. **趋势分析报告未保存。** batch 只输出分析器 stdout 的首行，且没有明确验证分析器退出码；依赖缺失时会跳过。不能仅凭 batch 完成就称完整趋势报告已生成。
6. **两套 raw 格式不同。** batch raw 的 `channelTraffic` 使用 `heatWatchPv` 等驼峰字段，`overview` 是批量解析后的字段；data-reader 分析器预期 `heat_watch_pv` 等字段和原始后台 overview。直接传入会缺渠道/概览指标。需要完整分析时优先用 data-reader 的 `export_live_trend_minutes.mjs` 导出该场配套 raw，再调用其分析器；若转换旧 raw，保留来源，不把缺失补 0。
7. **采集成功需实证。** 无 `error` 不代表所有字段齐全；核对对象 ID、趋势点数、空列和期望场数。失败原因及未覆盖范围保留到交付。

当前未提供日期筛选参数；应在导出后按用户范围构造 `selected_sessions.json`。`--no-gmv-filter` 仍要求观看 ≥100，`--all-sessions` 仅要求有 `objectId`。脚本无独立“导趋势但不分析”模式；不要承诺固定耗时。

## 权限与失败边界

历史账号记录曾遇到订阅窗口限制或字段不可见，是否适用于当前账号以页面返回为准。权限、登录或限流阻断时停止扩大采集并记录断点，不绕过限制。页面结构变化时先只读核对 store/DOM，不凭旧字段名补数据。
