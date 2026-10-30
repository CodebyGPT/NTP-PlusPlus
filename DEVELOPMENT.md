# Just a NTP 开发守则

## 项目目标

一个尽量安静的新标签页扩展：纯色、跟随浏览器主题、离开即关闭。功能少，行为可预测，代码能被一次读完。

## 硬性规则

### 1. 不联网、无遥测

- 不加载远程字体、脚本、样式、图片或图标，全部资源随扩展打包。
- 运行时不发起任何网络请求：不使用 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`sendBeacon`。
- 不接入统计、崩溃上报、广告或用户标识。
- 权限：Chrome / Firefox 声明 `tabs` 与 `<all_urls>` 主机权限；Firefox 额外申请读取主题的 `theme`。
- `<all_urls>` 是项目要求声明的主机权限；当前代码不注入内容脚本、不读取网页内容。`tabs` 权限仅用于比较标签页 URL 是否等于本扩展的 `newtab.html`；不持久化、不传输浏览记录。
- 新依赖必须离线可用，并在引入前说明为什么标准库/平台 API 不够用。

### 2. 动态自适应布局

- 使用视口单位、`min()`/`max()`/`clamp()`、Flexbox、Grid 等流式方案，不按某个固定分辨率写死布局。
- 新 UI 至少要在窄窗口、超宽屏、浏览器缩放和不同 DPI 下可用。
- 当前页面是空白纯色页，但这不豁免规则：背景必须覆盖任意视口，且不产生滚动条。
- 优先使用逻辑属性（`block-size`、`inline-size`、`min-block-size`），避免绑定横竖方向。

### 3. 不写魔法数

- JavaScript 中的数字必须是有语义的具名常量，不使用裸数字表达业务含义。
- CSS 中的尺寸和颜色放进自定义属性，颜色使用有语义的 token 名。
- 允许的例外：`0`、协议/API 规定的固定值、测试数据；如果是例外，注释说明原因。
- 优先使用相对单位和系统能力，而不是调出来的像素值。

### 4. 纯事件驱动，不轮询

- 禁止用 `setInterval`、`setTimeout` 或递归定时器轮询/调度状态。
- 使用浏览器事件：`tabs.onActivated`、`windows.onFocusChanged`、`theme.onUpdated`、`matchMedia` 的 `change`、页面生命周期事件。
- 构建检查会拒绝 `setInterval` / `setTimeout`。如果未来确实需要，先修改守则和检查并说明原因，而不是绕过规则。
- 事件监听器必须在对应上下文销毁时移除（当前页面级监听器随标签页关闭自然结束）。

### 5. 以本地 MDN 文档为准

- `Doc/developer.mozilla.org/` 是完整的离线 MDN 镜像，开发时优先查它，不凭记忆写 API。
- 常用入口：
  - `Doc/developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/`
  - `Doc/developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/`
  - `Doc/developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/theme/`
  - `Doc/developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/`
- `Doc/` 体积很大，只作为本地参考，不提交到 Git。
- 本项目的浏览器兼容结论要能落到具体文档或实际测试，不写“应该可以”。

### 6. 跨浏览器但不做无谓抽象

- 优先使用 `browser.*`（Firefox Promise API），在 Chromium 中回退到 `chrome.*` 回调。
- 通过特性检测判断 API 是否存在，例如 Chromium 没有 `browser.theme`，就直接使用 CSS 深浅色回退。
- 不引入 polyfill 库、构建框架或状态管理；两种 manifest 由构建脚本生成即可。

### 7. 代码与验证

- 保持小文件、短函数、明确命名；能删的代码优先删。
- 非平凡逻辑至少留一个可运行的检查。
- 提交前执行：

```bash
npm test
npm run build
```

构建会校验源码中是否出现轮询/网络 API、manifest 是否可解析、产物文件是否齐全。

## 当前架构

```text
src/
  manifest.json       公共 manifest 字段
  background.js       后台事件：关闭切走后仍存活的新标签页
  newtab.html         空白新标签页
  newtab.css          纯色背景、深浅色回退、视口自适应
  newtab.js           主题同步 + 页面内快速关闭路径
  auto-close.js       可测试的“是否应关闭”判断
scripts/
  build.mjs           生成 dist/chrome 与 dist/firefox
test/
  auto-close.test.js  自动关闭判断的测试
```

### 主题色

- Firefox 支持 `browser.theme.getCurrent()`，读取顺序为：
  1. `colors.ntp_background`（Firefox 主题为新标签页定义的颜色）
  2. `colors.frame`（没有新标签页颜色时跟随浏览器外框）
  3. 都没有则移除内联变量，退回 CSS 的深浅色 token。
- 主题变化通过 `browser.theme.onUpdated` 响应。
- Chromium 没有主题读取 API，因此不执行 JS 分支；`prefers-color-scheme` 媒体查询自动选择浅色或深色 token。
- 默认浅色/深色值是 token，不是散落的魔法颜色。

### 离开新标签页时自动关闭

- 后台 `background.js` 是跨窗口和页面被冻结时的兜底路径：监听 `tabs.onActivated` 和 `windows.onFocusChanged`，查询标签页并关闭除当前激活页以外的所有 NTP 页面。
- 页面内的 `visibilitychange` 是同窗口切换的主路径：新标签页变为隐藏后，先读取自身标签页的 `active` 状态；只有该标签页已不在前台（`active === false`）才调用 `tabs.remove()` 关闭自己。正在通过书签/地址导航离开时，标签页仍处于前台（`active === true`），此时保留标签页，避免把正在加载的目标页连同窗口一起关掉。
- 页面加载时如果已经处于隐藏状态且不在前台（后台打开的新标签页），立即关闭，不等事件。
- 判断 NTP 页面时同时检查 `tab.url` / `tab.pendingUrl`，兼容 Chromium 的 `chrome://newtab`（带/不带结尾斜杠）、Edge 的 `edge://newtab` 和 Firefox 的 `about:newtab`（以及扩展自身 URL）。URL 只在本机比较，不保存、不传输。
- 新标签页自身保留 `tabs.onActivated` / `windows.onFocusChanged` 快速路径；即使页面被隐藏，后台仍会兜底关闭。
- 后台与页面都只响应事件，不使用轮询或定时器。
- `windows.onFocusChanged` 收到 `WINDOW_ID_NONE`（切到其他应用）时忽略，只处理浏览器窗口之间的切换。

## 构建与加载

```bash
npm run build
```

产物：

- `dist/chrome/`：Chrome / Edge，加载已解压的扩展程序。
- `dist/firefox/`：Firefox，临时加载 `manifest.json`。

`dist/` 和 `Doc/` 不进入版本库。

## 提交前检查

- [ ] 没有新增网络 API、远程资源或遥测代码
- [ ] 没有轮询定时器
- [ ] 窄窗口和宽窗口下背景都铺满，无滚动条
- [ ] Firefox 下切换主题后新标签页颜色正确
- [ ] Chromium 下深浅色模式跟随系统
- [ ] 从新标签页切到任意其他标签页后（含其他窗口），新标签页关闭
- [ ] `npm test` 与 `npm run build` 通过
