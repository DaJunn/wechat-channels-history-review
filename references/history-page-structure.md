# 视频号直播历史页结构

> 本文档记录 `channels.weixin.qq.com/platform/statistic/live?mode=history` 页面的技术结构。用于理解数据读取方式和 Vue store 访问路径。

## 架构概览

历史页使用 **qiankun 微前端架构**，主页面（main SPA）只是一个空壳，实际内容由子应用（micro-app）在 `iframe[name="statistic"]` 中渲染。

```
channels.weixin.qq.com
  └── iframe[name="statistic"]  (同源)
       ├── 左侧：导航栏（全部数据 / 单场数据）
       ├── 中间：虚拟滚动表格
       │   ├── 列：直播时长 / 观看人数 / 最高在线 / 总热度 / 成交金额
       │   └── 操作列：数据详情（可点击进入 dashboardV4）
       └── 底部：分页
```

## 关键特征

### 1. 主页面 DOM 为空壳

主页面 `document.body.innerHTML` 只包含 SVG 图标和 `<script>` 标签，不包含任何可见 UI 元素。所有用户可见内容在子应用 iframe 中。

### 2. iframe 同源

`iframe[name="statistic"]` 同源（`channels.weixin.qq.com`），可以通过 `iframe.contentDocument` 直接访问其 DOM。

```js
const iframe = document.querySelector('iframe[name="statistic"]');
const doc = iframe.contentDocument;
```

### 3. Vue 2 组件实例

表格是 Vue 2 + Ant Design Vue 组件。每个 `<td>` 元素上挂载了 Vue 组件实例 `__vue__`：

```js
td.__vue__.record = {
  key: "14887277057353779322",         // liveObjectId
  info: {
    desc: "中产出国真实现状",           // 直播标题
    cover: "https://..."              // 封面图 URL
  }
}
```

每行的 6 个 `<td>` 共享同一个 `record` 对象，但 `key` 只在第 0 个 TD 上确保不重复。

### 4. 虚拟滚动

表格使用虚拟滚动（virtual scroll），只渲染视口可见的行。不可见的行 DOM 被移除。滚动后新行会被异步渲染。

要通过 Vue store 提取所有行，直接 `querySelectorAll('td')` 只能获取当前渲染行。但 `extract_history_sessions.mjs` 的 fallback 方式通过 `body.innerText` 可以拿到所有行（含未渲染行的文本）。

### 5. 表格文本结构（fallback 方式）

```text
直播时长  观看人数  最高在线  总热度  成交金额
3小时3分钟29秒  9966  165  32  ¥91.6
1分钟5秒  2  2  0  ¥0
...
直播信息
中产出国真实现状  03月28日 20:42
欢迎来到我的直播间  03月28日 20:37
...
操作
数据详情
数据详情
...
```

每行 6 列（5 个数据 + 1 个操作），按行顺序与"直播信息"部分的标题/日期一一对应。

### 6. 表格行 → 对象 ID 映射

行顺序 = 标题顺序。第 0 行数据对应第 0 个标题（"中产出国真实现状 03月28日 20:42"）。

## dashboardV4 URL 构造

```js
const dashboardUrl = `https://channels.weixin.qq.com/platform/statistic/dashboardV4?objetctId=${objectId}&entrance_id=3`;
```

注意 URL 参数是 `objetctId`（拼写错误，不是 `objectId`），compat 逻辑已内置。

## 数据详情导航

点击"数据详情"在 SPA 内部通过 Vue Router 导航，非真实页面跳转。理论上可以通过：
- `window._router.push({ path: '/micro/statistic/dashboardV4', query: { objetctId } })` 导航
- 但直接 `navigate` 到 dashboardV4 URL 更可靠（新开标签页会丢失登录态，用 `find_tab --active` 复用现有 tab）

## 登录态说明

- 在用户已登录的 Chrome 中打开新 tab 到 `channels.weixin.qq.com` 会自动保持登录
- 从 weixin 域外的普通 tab 新开窗口可能需要扫码登录
- 优先使用 `find_tab` 复用用户当前打开的 tab，而不是 `navigate` 新开

## 字段映射

| 表格列 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 直播时长 | durationSec | number | 转换为秒 |
| 观看人数 | viewers | number | 累计看播人数 |
| 最高在线 | peakOnline | number | 峰值在线 |
| 总热度 | heat | number | 热度值 |
| 成交金额 | gmv | number | 去除 ¥ 符号 |
| 直播信息.标题 | title | string | 直播标题 |
| 直播信息.日期 | date | string | "03月28日 20:42" |
| Vue record.key | objectId | string | 用于构造 dashboardV4 URL |
