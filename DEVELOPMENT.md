# Just a NTP 开发守则

## 项目目标

一个尽量安静的新标签页扩展：常用网站瓦片、纯色、跟随浏览器主题、离开即关闭。功能少，行为可预测，代码能被一次读完。

## 硬性规则

### 1. 不联网、无遥测

- 不加载远程字体、脚本、样式、图片或图标，全部资源随扩展打包。
- 运行时不发起任何网络请求：不使用 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`sendBeacon`。
- 不接入统计、崩溃上报、广告或用户标识。
- 权限：Chrome 声明 `tabs`、`topSites`、`favicon` 与 `<all_urls>` 主机权限；Firefox 声明 `theme`、`tabs`、`topSites`、`bookmarks` 与 `<all_urls>` 主机权限。`topSites` 读取常用网站，`favicon` 只用于 `/_favicon/` 图标端点，`bookmarks` 只在开启“排除已收藏的网站”时读取收藏夹主机名。
- `<all_urls>` 是项目要求声明的主机权限；当前代码不注入内容脚本、不读取网页内容。`tabs` 权限仅用于统计同窗口标签页数量；不持久化、不传输浏览记录。
- 新依赖必须离线可用，并在引入前说明为什么标准库/平台 API 不够用。

### 2. 动态自适应布局

- 使用视口单位、`min()`/`max()`/`clamp()`、Flexbox、Grid 等流式方案，不按某个固定分辨率写死布局。
- 新 UI 至少要在窄窗口、超宽屏、浏览器缩放和不同 DPI 下可用。
- 页面内容不豁免规则：背景必须覆盖任意视口，瓦片网格在窄窗口下自动减列，且不产生滚动条。
- 优先使用逻辑属性（`block-size`、`inline-size`、`min-block-size`），避免绑定横竖方向。

### 3. 不写魔法数

- JavaScript 中的数字必须是有语义的具名常量，不使用裸数字表达业务含义。
- CSS 中的尺寸和颜色放进自定义属性，颜色使用有语义的 token 名。
- 允许的例外：`0`、协议/API 规定的固定值、测试数据；如果是例外，注释说明原因。
- 优先使用相对单位和系统能力，而不是调出来的像素值。

### 4. 纯事件驱动，不轮询

- 禁止 `setInterval`、`setTimeout`、递归定时器，以及任何形式的轮询或定时循环。
- 使用浏览器事件：`visibilitychange`、`window.blur`、`theme.onUpdated`、`matchMedia` 的 `change`、页面生命周期事件。
- 需要等待浏览器状态变化时，等待下一个相关事件，而不是设置延迟；不使用硬编码的毫秒数。
- 构建检查同时拒绝 `setInterval` 和 `setTimeout`。如果未来确实需要定时逻辑，必须先修改守则和检查并说明原因，而不是绕过规则。
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

- 仅支持 Chrome 121+ 与 Firefox 109+：两者异步扩展 API 都返回 Promise，统一用 Promise，不再为旧 Chromium 维护回调分支。
- Chrome 清单声明 `minimum_chrome_version: "121"`，低于该版本的 Chromium 内核浏览器拒绝安装；Firefox 清单声明 `strict_min_version: "109.0"`。
- 运行时统一取 `globalThis.browser ?? globalThis.chrome`，两条路径都按 Promise 调用；不检测回调风格。
- 通过特性检测判断可选 API 是否存在，例如 Chromium 没有 `theme` API，就直接使用 CSS 深浅色回退。
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

### 8. 多语言

- 所有用户可见文案通过 `src/i18n.js` 的 `t()` 或 HTML 的 `data-i18n` 获取，不在 JS/HTML 中硬编码。
- 文案统一放在 `src/_locales/<locale>/messages.json`；当前支持 `en`、`zh_CN`、`ru`，默认 `en`。
- 浏览器按界面语言（正常安装时跟随系统语言）自动选择；不支持的界面语言回退到默认英文。
- 新增语言只需增加对应目录并翻译全部 key；构建会校验各语言 key 完全一致且消息非空。
- 诊断日志的事件名和内部错误信息属于开发者输出，可以保持英文；`document.documentElement.lang` 跟随实际显示的文案语言。

### 9. 用户可见文案从简

- 只写用户完成操作必需的信息，不写营销语、功能复述、欢迎语或解释性废话。
- 不主动添加用户没有要求的说明文字。`manifest.json` 的 `description` 这类展示元数据默认不写，除非用户明确要求。
- 开发注释、诊断日志和开发者文档不受此限；但注释也只解释“为什么”，不复述代码。

### 10. 重大修改后用无头浏览器验证

- 每次完成重大修改（布局、交互、渲染逻辑、manifest 或构建脚本）并 `npm run build` 后，先执行 `node test/headless/run.mjs`，确认无头浏览器里的实际渲染和交互与预期一致，再继续下一项修改。
- `npm test` 通过、代码读起来没问题、构建成功，都不算验证；必须真正跑起页面并核对断言，必要时用 `--only=<场景>` 定位。
- 断言覆盖不到的行为，先补断言再改代码，不靠肉眼或推测下结论。
- 无头检查没全绿就不算完成：先修到全绿，不在失败结果上叠加新改动。截图产物在 `test/headless/out/`，不入库。
- 无法用无头浏览器覆盖的改动（如 Firefox 真实主题同步），在提交说明里写明手工验证步骤和结论。

### 11. token 管够，不为省成本砍步骤

- 该读的文件、该查的 MDN 文档、该跑的检查、该看的完整失败输出，都要完整读完跑完，不为省 token 跳过或只看片段。
- 多文件改动前先读全所有相关文件再动手；不靠猜测改代码，也不写“应该没问题”当结论。
- 结论要有证据：命令、输出、截图路径或文档位置。宁可多验证几轮，也不要猜错后返工。

## 当前架构

```text
src/
  _locales/
    en/messages.json     默认语言文案
    zh_CN/messages.json  简体中文文案
    ru/messages.json     俄文文案
  manifest.json          公共 manifest 字段
  background.js          后台脚本：截图、720p 压缩、最近关闭快照槽位
  i18n.js                t()、data-i18n 与 data-i18n-aria
  newtab.html            瓦片网格、最近关闭卡片、设置按钮与设置弹窗
  newtab.css             纯色背景、瓦片、卡片、设置弹窗、深浅色回退、视口自适应
  newtab.js              主题同步 + 瓦片渲染 + 卡片渲染 + 设置 + 页面内关闭逻辑
  stack.js               最近关闭卡片纯函数（会话规整、快照配对、字符数上限）
  topsites.js            常用网站纯函数（过滤、去重、域名收敛、匹配）
scripts/
  build.mjs              生成 dist/chrome 与 dist/firefox
test/
  i18n.test.mjs          i18n 辅助函数检查
  stack.test.mjs         最近关闭卡片纯函数检查
  topsites.test.mjs      常用网站纯函数检查
  headless/              无 npm 依赖的 CDP 无头浏览器检查（不入库截图产物）
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

- 只使用页面自己的事件：`window` 的 `blur` 和 `document` 的 `visibilitychange`。失去焦点或变为隐藏时执行同一段关闭判断。
- 关闭前用 `tabs.query({ windowId })` 统计当前窗口的标签页数量；数量大于 1 才关闭自己，只剩自己一个时不关闭，避免把窗口一起关掉。
- 页面加载时如果已经是隐藏状态（后台打开的新标签页），立即执行一次同样的判断。
- 读取同窗口标签页的 `active` 状态，用于区分“切换标签页”和“当前标签页正在导航”；不使用后台 worker，不依赖 URL 匹配，也不使用轮询。
- 关闭动作由页面自己调用 `window.close()`，不再调用 `tabs.remove`；因此不会触发 Chrome 标签栏的 `Tabs cannot be edited right now` 忙锁，也不需要重试或定时器。
- 新标签页保持未导航（`history.length === 1`），满足浏览器允许脚本关闭该标签页的前提。
- `tabs` 权限只用于统计同窗口标签页数量；`<all_urls>` 主机权限按当前要求保留，但代码不注入内容脚本、不读取网页内容。

### 常用网站瓦片

- 浏览器判定用 `navigator.userAgent` 是否含 `Firefox/`。不能依赖 `globalThis.browser` 是否存在：部分 Chromium 构建也暴露该别名；也不能靠特性检测区分，因为两边都有 `topSites`。
- Firefox 调用 `topSites.get({ includeFavicon: true, limit: 100 })` 一次取满溢出池；Chromium 无参调用 `topSites.get()`（Chromium 不支持 options，且最多返回 10 条）。
- 纯函数 `src/topsites.js` 只处理列表：过滤非 http/https、跳过排除主机、跳过已隐藏 origin、按目标 URL 去重、截断到 10 条，便于 Node 直接测试。
- 隐藏记录以 origin 为 key（`ntp-hidden-sites`），切换“只保留域名”不会让已删站点复活；删除后从溢出池补位。
- Chromium 图标走 `runtime.getURL('/_favicon/')` + `pageUrl` + `size=64`（需要 `favicon` 权限）；Firefox 用 `topSites` 返回的 data URL。加载失败就移除 `img`，露出首字母。
- 左键当前标签页打开、右键原生菜单：瓦片就是普通 `<a href>`，不监听 `contextmenu`。
- favicon 尺寸固定 `--ntp-tile-favicon-size: 1.6rem`（25.6px），两套风格共用。Chromium 的圆形底 `--ntp-tile-icon-size: 2.875rem`（46px）比 Firefox 方底的 2.5rem 大一圈，这样方角到圆边有约 5px 余量：正方形内切时角在 70.7% 处，46/2 - 25.6×0.707 ≈ 4.9px。
- 两套风格共用同一套 DOM，只在 CSS 里分叉：`body.ntp-firefox-style` 改图标底圆角（`--ntp-firefox-tile-icon-radius: 8px`）、去掉瓦片底色、悬停时 `scale()` 图标并加 `--ntp-firefox-tile-icon-shadow` 阴影（默认无阴影，dark 下提高不透明度）、标题 `--ntp-tile-title-clamp: 2`；默认（无该类）是 Chromium 风格（圆形图标底 `--ntp-tile-icon-radius: 50%`、悬停出 `3px` 瓦片底、标题单行）。标题统一用 `-webkit-line-clamp` + `text-overflow: ellipsis`，只切 clamp 数字就切换行数。删除按钮固定在图标右上角，靠 CSS `:hover`/`:focus-within` 淡入淡出，不写 JS 悬停逻辑。
- 风格偏好存 `ntp-tile-style`，默认值取 `IS_FIREFOX`：识别不到浏览器时回落 Chromium 风格；改设置只切 body class，无需重渲染。
- 布局用 Flexbox `flex-wrap` + 固定瓦片宽度（`--ntp-tile-width`，上限 7rem，对齐 Chromium 的 112px 瓦片）+ `justify-content: center`，容器宽度上限压到 5 列：窄窗口自动减列、不产生横向滚动，不足 10 个瓦片时最后一行仍然居中。
- 瓦片链接不设左右内边距，标题按满瓦片宽度省略，能被截断的字符更多；相邻标题之间靠 flex `gap` 保持间隔，不会重叠或越出安全区。

### 最近关闭的标签页卡片

- 布局：`main` 是纵向 flex，瓦片固定在上方，`#ntp-recent` 吃掉剩余高度。不再垂直居中，卡片再高也不会把瓦片顶出视口。`main` 用 `overflow: clip`（不是 `hidden`）：卡片会越出下边缘，但 `clip` 不产生可滚动区域，页面始终保持正好一屏、没有滚动条；body 的 `padding-block-end` 也归零，让最上层卡片直接切在视口底边上。
- 卡片层级（视觉）：最新的卡片最大，往回依次等比缩小 `--ntp-card-scale-step`（`transform: scale()`，原点在 `50% 0` 顶部居中，所以缩小时顶端位置不动、只往下收），横向也一起变窄，成塔状。
- 卡片顺序：DOM 顺序是“最旧 → 最新”，靠绘制顺序让最新的在最上层（`z-index` 不用手写，定位元素本身按文档顺序绘制）。每张卡片用内联 `--ntp-card-index` 向上抬 `index × --ntp-card-step`，`--ntp-card-step` = 1.5 倍标题栏高度，所以没被悬停的卡片也露出标题栏加半条标题栏的快照；`#ntp-recent` 的 `margin-block-start` 预留这段被抬上去的高度。
- 最上层卡片越出视口：`#ntp-recent` 用负的 `margin-block-end: calc(-1 × --ntp-card-overhang)` 把舞台向下撑出去，卡片顶部锚定在舞台顶边（`inset-block-start: 0`），底边按比例向下长，于是被视口下边缘切掉一截，看起来是“压在下边缘上”。窗口越矮，切掉的部分越多——这是设计，不要靠压缩卡片去消除它。
- 卡片尺寸：卡片宽度永远是舞台宽度的 100%，高度由屏幕比例（`--ntp-card-aspect`，由 `applyCardAspect()` 从 `window.screen` 写进 `:root`，取不到就退回 `16 / 9`）算出来，所以卡片总是左右铺满、纵向顺着比例长到哪算哪。这里只有一条规则：比例不变形。窗口太矮时卡片会越出视口下边缘（这个可以接受），**不能**为了塞进视口去压扁或缩小它——任何单独 clamp 一条边的 `min-*` / `max-*` 都会破坏比例，`min-inline-size` 加 `max-block-size` 的组合就是把卡片变成条形的元凶。`box-sizing: border-box` 必须写，否则比舞台宽 2px。舞台顶部那段 `margin-block-start`（= 抬起来的卡片占的高度）由被抬起的卡片自己填满，不要拿它去减卡片高度，否则瓦片和卡片之间会空出一条。
- 悬停露出：纯 CSS，`.ntp-card:hover ~ .ntp-card` 把叠在上面的卡片 `translateY(--ntp-card-exit-distance)` 移出视口（`scale()` 原样保留，否则滑走的卡片会突然变大），过渡用 Material 3 Expressive 的 “default spatial” 曲线 `cubic-bezier(0.38, 1.21, 0.22, 1)` / 500ms（`--ntp-card-ease` / `--ntp-card-transition`，曲线会过冲到 1 以上再回落，就是那点阻尼感）。同时给这些卡片 `pointer-events: none`：滑走的卡片会经过光标下方，否则 hover 目标跳到它身上，状态在两个元素之间来回抖动。
- 恢复：整张卡片（标题栏 + 快照）是一个 `<a>`，`click` 时 `preventDefault()` 再 `sessions.restore(sessionId)`；恢复失败（会话已被清理）就退回到 `location.href = url`，仍然能打开这个页面。
- 复制链接按钮是那个 `<a>` 的**兄弟节点**（绝对定位到标题栏右侧），不能嵌在 `<a>` 里——`<a>` 内嵌 `<button>` 是非法结构。图标直接取 `Doc/IconPark-master` 里的 `Edit/copy.svg`（Apache-2.0），去掉 `xmlns` 放进 `newtab.html` 的 `<template id="ntp-card-copy-icon">`：HTML 解析器会自动把它放进 SVG 命名空间，于是 JS 里不需要 `createElementNS` 和 `http://www.w3.org/2000/svg` 这个会被构建规则拦掉的字符串，克隆模板即可。`fill: none` + `stroke: currentcolor` 让它跟随按钮颜色。
- 没有快照时（标签页还没机会被截到）快照区居中显示站点 favicon，尺寸 `--ntp-card-placeholder-size`（2.5rem）比标题栏里的大一圈，但远小于卡片：占位图**不能**铺满快照区，`object-fit: contain` 保持图标比例，`opacity: 0.55` 让它退到背景。注意快照图片的 `inline-size: 100%` 规则必须写成 `.ntp-card-snapshot img:not(.ntp-card-placeholder)`，否则同属性选择器的特异度会压过占位图尺寸，把它拉满整张卡片。Chromium 走 `/_favicon/`；Firefox 的 `sessions` 不带内联图标，而 `favIconUrl` 是远程地址（违反“不加载远程图片”），所以退化成站点首字母。
- 字符数上限：`ResizeObserver`（事件驱动，只在宽度真的变化时触发）监听 `#ntp-recent` 宽度 → 一次布局读 `label.clientWidth`（已扣掉复制按钮让出的位置）→ 隐藏的 `.ntp-card-measure` 量平均字符宽 → `charLimitForWidth()` 得到单侧上限 → 标题和地址各自 `limitLabel()`。CSS 的 `text-overflow: ellipsis` 只是兜底，覆盖“resize 到下一次测量之间”的那一帧。上限不硬编码，宽窄窗口各自算出合适的值。
- 快照：`background.js` 在标签页变为可见（`tabs.onActivated`、`tabs.onUpdated` 到 `complete`、`windows.onFocusChanged`）时调用 `tabs.captureVisibleTab`，只截当前可见页——已关闭的标签页事后无法补截，所以必须预热。>720p 才用 `createImageBitmap` + `OffscreenCanvas` 缩到 1280×720，任何失败都静默回退原图。
- 快照槽位：`storage.session`（浏览器只放内存、不落盘、关闭即清空）里维护两个数组：打开中的标签页（按 `tabId` 去重，上限 8 条）和已关闭的环形槽（上限 3 条，按 `url` 去重后覆盖最旧的）。`tabs.onRemoved` 把开着的条目挪进环形槽，槽位满就自然挤掉最旧的，不需要任何定期清理逻辑，因此不存在“异常没清掉导致内存膨胀”。Firefox < 115 没有 `storage.session`，回退成 worker 内的普通对象。
- 新标签页通过 `runtime.sendMessage({ type: 'ntp:snapshots' })` 取快照，按 `url` 与会话列表配对；同一个 `url` 的多个会话只消费一份快照。
- `background.js` 是不含 `import`/`export` 的经典脚本：Chrome 只能加载 `service_worker`，Firefox 不支持 `service_worker`（109–120 甚至会因为声明了它而完全不启动后台），所以 `build.mjs` 按 target 分别写 `background.service_worker` 与 `background.scripts`。
- 新标签页不自己截图：截图需要标签页可见，而新标签页一出现就是当前页，截到的是它自己。

### 设置弹窗

- 原生 `<dialog>` + `showModal()`；`::backdrop` 压暗背景；点背景（事件目标就是 dialog 本身）或关闭按钮关闭。
- 没有保存按钮：勾选即写 `localStorage` 并立即重渲染。
- “排除已收藏的网站”：`bookmarks.getTree()` 递归收集 http/https 条目的主机名并去掉 `www.` 前缀，按主机名精确匹配（`baike.baidu.com` 不会被 `baidu.com` 的收藏跳过）。
- Chromium 上该选项置灰禁用：Chromium 的 topSites 只有 10 条，排除后瓦片会留空。这只是前端 `disabled`，不做防止强行开启的防御逻辑。
- “Firefox 风格瓦片”：只切 `body` 的 class，纯视觉开关，不影响任何列表逻辑；默认跟随浏览器判定。
- “最近关闭卡片最大显示数”：下拉 1/2/3，存 `ntp-recent-count`，默认 3。改动后重新取一次列表重渲染，多出的卡片直接不渲染（不是隐藏），所以 DOM 里永远不会超过选中的张数。

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
- [ ] 窄窗口（≥320px）下瓦片自动减列，无横向滚动
- [ ] Chromium 下瓦片无删除按钮、收藏选项置灰；图标走 `/_favicon/`
- [ ] Chromium 默认圆形图标底、悬停出瓦片底、标题单行；Firefox 默认 8px 图标底、悬停图标放大并淡入删除按钮、标题最多两行
- [ ] 设置里切换瓦片风格立即生效，刷新后仍保持
- [ ] Firefox 下删除瓦片后由溢出站点补位，刷新后仍隐藏
- [ ] 设置弹窗即时生效，点背景和关闭按钮都能关闭
- [ ] 瓦片在上方、最近关闭卡片在下方层叠：最新的卡片最大且被视口下边缘切掉一截，往回依次缩小，未选中的卡片露出标题栏 + 半条标题栏的快照
- [ ] 悬停第二/第三张卡片时，压在它上面的卡片带缓动滑出视口（M3 Expressive 阻尼曲线），光标指的那张完整露出（含快照）
- [ ] 瓦片下方到视口底边全被卡片占满，瓦片和卡片之间没有空带；卡片宽度跟着窗口横向拉伸等比缩放，竖向拉伸只改变露出多少、不改变卡片尺寸；卡片长宽比始终等于屏幕长宽比，窗口拉得再扁也不变形（宁可越出视口）
- [ ] 标题与链接共用同一个字符数上限，窗口变窄时不刷新页面也会收得更紧
- [ ] 点卡片恢复被关闭的标签页；点复制按钮只复制链接、不触发恢复
- [ ] 没有快照的卡片在快照区居中显示 favicon（Firefox 显示首字母），不是一片空白，也没有被拉满整张卡片
- [ ] 快照只在内存里（重启浏览器后为空），超 720p 的已压到 720p
- [ ] 设置里改“最近关闭卡片最大显示数”立即生效，刷新后仍保持
- [ ] 窄窗口下瓦片加卡片仍无滚动条、卡片区不被压扁成 0 高
- [ ] `npm test` 与 `npm run build` 通过；`test/headless/run.mjs` 全绿，实际渲染与预期一致
- [ ] 重大修改是逐项验证过的，不是在未验证的改动上继续叠加
