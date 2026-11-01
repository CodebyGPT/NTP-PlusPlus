# NTP++ 开发守则

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
- 浏览器差异只在底层收一次口，不要在调用处分支：站点图标（favicon / 首字母徽章）一律走 `src/icons.js` 的 `createSiteIcon()`，见“图标”一节；调用方不做 `if (Firefox)` 之类判断。

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

### 12. 每轮结束默认本地提交

- 每轮对话结束时，本轮只要有文件改动，就默认执行本地 `git commit`，不需要用户额外确认；用户明确说“不要提交”时除外。
- 提交信息说明本轮改了什么、为什么改；不把无关改动混进同一个提交，不提交 `dist/`、`Doc/`、截图产物等被忽略的内容。
- 只提交到本地仓库，不执行 `git push`（见下一条）。

### 13. 不擅自推送或发布

- 没有明确命令时，禁止把本地代码同步到 GitHub 仓库（`git push`、创建或更新 PR、改动远端分支或标签）。
- 没有明确命令时，禁止发布构建产物到 GitHub Release（上传 asset、创建 Release 或 Tag）。
- 本地提交、本地构建不受此限；同步到远端或对外发布必须由用户明确下令。

## 当前架构

```text
src/
  _locales/
    en/messages.json     默认语言文案
    zh_CN/messages.json  简体中文文案
    ru/messages.json     俄文文案
  manifest.json          公共 manifest 字段
  background.js          后台脚本：截图、1080p 压缩、最近关闭快照槽位
  i18n.js                t()、data-i18n 与 data-i18n-aria
  icons.js               唯一的图标来源：favicon 取值策略 + 首字母徽章降级
  newtab.html            瓦片网格、最近关闭卡片、常驻会话托盘、设置按钮与设置弹窗
  newtab.css             纯色背景、瓦片、卡片、会话托盘、设置弹窗、深浅色回退、视口自适应
  newtab.js              主题同步 + 瓦片渲染 + 卡片渲染 + 托盘渲染 + 设置 + 页面内关闭逻辑
  stack.js               最近关闭会话纯函数（卡片规整、快照配对、字符数上限、托盘行）
  topsites.js            常用网站纯函数（过滤、去重、域名收敛、匹配）
scripts/
  build.mjs              生成 dist/chrome 与 dist/firefox
test/
  i18n.test.mjs          i18n 辅助函数检查
  icons.test.mjs         图标来源策略检查（Chromium / Firefox / 特权页面）
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

### 图标

所有图标只走一条路：`src/icons.js`。调用方只管说“这个站点是什么”，不判断要不要降级：

```js
import { createSiteIcon } from './icons.js';

// 放进任何容器即可：有 favicon 就是 <img>，没有就是首字母徽章。
element.append(createSiteIcon({ url, title, favicon, variant: 'tile' }));
```

新增一处放图标的地方，四步就够：

1. 在 `newtab.html`/`newtab.js` 里给容器一个类名，比如 `.ntp-thing-icon`；
2. 在 CSS 里把它设为 `display: grid; place-items: center`，并声明 `--site-icon-size`（和图片尺寸 `--site-icon-image-size`）；
3. 调 `createSiteIcon({ url, title, variant: 'card' })`——需要新外观才在 `icons.js` 的 `VARIANTS` 里加一项；
4. 若要用别的字号，只覆盖 `--site-icon-glyph-scale` / `--site-icon-letter-nudge`，不要复制徽章规则。

`favicon` 参数只在调用方本来就有内联图标时传（例如 `topSites` 的 `favicon`）；不知道就不传。

返回一个 `span.site-icon`：里面要么是加载成功的 `img.site-icon-image`，要么是同样大小的首字母徽章。降级策略全在 `iconSource()` 里——内联 `favicon`（`topSites` 给的 data URL）优先；Firefox 直接 `undefined`，因为 `sessions`/`tabs` 只给远程 `favIconUrl`，加载它等于联网；非 http(s) 的 URL 也 `undefined`，因为 Chromium 的 `/_favicon/` 对特权页面只会吐出同一张通用地球图标。其余情况才拼 `/_favicon/?pageUrl=…&size=64`。

`variant`（`tile` / `card` / `tab` / `placeholder`）只是选一套类名，几何和配色全由 CSS 变量决定：

- `.site-icon` 是方框，尺寸 `--site-icon-size`，图片尺寸 `--site-icon-image-size`。
- 徽章 `.site-icon-letter` 是圆角矩形（`--site-icon-letter-radius`，无描边，`overflow: hidden`），字母 `.site-icon-glyph` 加粗、`rotate(--site-icon-tilt)`、锚在右下（`--site-icon-letter-nudge`）、字号 `--site-icon-glyph-scale` × `--site-icon-size`——刻意大到被徽章自己的圆角切掉，用裁剪代替留白，字才像标志而不是“一个带内边距的字母”。`transform-origin: 100% 100%` 让倾斜绕着右下角转，切掉的量才可预测。
- `img` 加载成功时给 `.site-icon` 加 `has-icon`，CSS 藏起徽章；加载失败就移除 `img`，徽章自动露出。所以图标可以“先乐观地请求，再自然降级”，调用方不需要 try/catch。
- 各处只覆盖变量：瓦片 `0.95`、卡片标题栏 `0.78`、窗口行 `0.72`（小尺寸再切就只剩一条边，得为可读性让步）、快照占位 `0.95` + `opacity: 0.55`。
- 徽章标了 `user-select: none`：它是装饰，不是可复制文本，拖动选中瓦片时不该被框进去。

配色在 `topsites.js`：`LETTER_COLORS` 是 16 色**孟菲斯（Memphis）**色板——八十年代那种高饱和撞色，深浅混着放，白字才有用武之地；`letterColors(key)` 用站点 key 哈希取色（不是 `Math.random()`，否则每次重渲染都换色），字色由 `letterTextColor()` 按 WCAG 相对亮度在黑/白里挑对比度更大的那个。`inset-block-end`/`inset-inline-end` 必须写纯百分比——`calc(长度 * 百分比)` 是非法 CSS，会被静默丢弃，字母就缩回左上角。

“调试：只用单字母图标”就是靠这套结构实现的：给 `body` 加 `ntp-letter-favicons`，CSS 藏掉 `.site-icon-image`、强制露出徽章。

以后加新地方放图标，只要 `createSiteIcon()` + 一个 `variant`，不要另起一套 favicon 逻辑。

### 最近关闭的标签页卡片

- 布局：`main` 是纵向 flex，瓦片固定在上方，`#ntp-recent` 吃掉剩余高度。不再垂直居中，卡片再高也不会把瓦片顶出视口。`main` 用 `overflow: clip`（不是 `hidden`）：卡片会越出下边缘，但 `clip` 不产生可滚动区域，页面始终保持正好一屏、没有滚动条；body 的 `padding-block-end` 也归零，让最上层卡片直接切在视口底边上。
- 卡片层级（视觉）：最新的卡片最大，往回依次等比缩小 `--ntp-card-scale-step`（`transform: scale()`，原点在 `50% 0` 顶部居中，所以缩小时顶端位置不动、只往下收），横向也一起变窄，成塔状。
- 卡片顺序：DOM 顺序是“最旧 → 最新”，靠绘制顺序让最新的在最上层（`z-index` 不用手写，定位元素本身按文档顺序绘制）。每张卡片用内联 `--ntp-card-index` 向上抬 `index × --ntp-card-step`，`--ntp-card-step` = 1.5 倍标题栏高度，所以没被悬停的卡片也露出标题栏加半条标题栏的快照；`#ntp-recent` 的 `margin-block-start` 预留这段被抬上去的高度。
- 最上层卡片越出视口：`#ntp-recent` 用负的 `margin-block-end: calc(-1 × --ntp-card-overhang)` 把舞台向下撑出去，卡片顶部锚定在舞台顶边（`inset-block-start: 0`），底边按比例向下长，于是被视口下边缘切掉一截，看起来是“压在下边缘上”。窗口越矮，切掉的部分越多——这是设计，不要靠压缩卡片去消除它。
- 卡片尺寸：卡片宽度永远是舞台宽度的 100%，高度由屏幕比例（`--ntp-card-aspect`，由 `applyCardAspect()` 从 `window.screen` 写进 `:root`，取不到就退回 `16 / 9`）算出来，所以卡片总是左右铺满、纵向顺着比例长到哪算哪。这里只有一条规则：比例不变形。窗口太矮时卡片会越出视口下边缘（这个可以接受），**不能**为了塞进视口去压扁或缩小它——任何单独 clamp 一条边的 `min-*` / `max-*` 都会破坏比例，`min-inline-size` 加 `max-block-size` 的组合就是把卡片变成条形的元凶。`box-sizing: border-box` 必须写，否则比舞台宽 2px。舞台顶部那段 `margin-block-start`（= 抬起来的卡片占的高度）由被抬起的卡片自己填满，不要拿它去减卡片高度，否则瓦片和卡片之间会空出一条。
- 悬停露出：纯 CSS，`.ntp-card:hover ~ .ntp-card` 把叠在上面（后绘制、盖住它）的卡片往下推，但**不推出视口**：落点由 `inset-block-start: calc(100% - var(--ntp-card-overhang) - var(--ntp-card-peek))` 决定，`100%` 是舞台高度，所以每张被推下去的卡片都正好在视口底边上方留 1.5 倍标题栏高度（`--ntp-card-peek` = 标题栏 + 半条标题栏的快照）在屏幕里，光标可以横移过去继续挑别的卡片；被推下去的卡片不设 `pointer-events: none`，它们停在光标下方不会挡住指针，可以直接悬停/点击。位移用 `inset-block-start` 而不是改 `transform`：`transform` 正被卡片自己的堆叠位移（`--ntp-card-index`）占用，混在一起会丢掉栈间距；另外 `inset-block-start` 的百分比相对舞台高度，才能把落点钉在离视口底边固定距离的地方，而不是“每张卡片各往下走自己的一身半”。过渡用 Material 3 Expressive 的 “default spatial” 曲线 `cubic-bezier(0.38, 1.21, 0.22, 1)` / 500ms（`--ntp-card-ease` / `--ntp-card-transition`，曲线会过冲到 1 以上再回落，就是那点阻尼感）。
- 恢复：整张卡片（标题栏 + 快照）是一个 `<a>`，`click` 时 `preventDefault()` 再 `sessions.restore(sessionId)`；恢复失败（会话已被清理）就退回到 `location.href = url`，仍然能打开这个页面。
- 复制链接按钮是那个 `<a>` 的**兄弟节点**（绝对定位到标题栏右侧），不能嵌在 `<a>` 里——`<a>` 内嵌 `<button>` 是非法结构。图标直接取 `Doc/IconPark-master` 里的 `Edit/copy.svg`（Apache-2.0），去掉 `xmlns` 放进 `newtab.html` 的 `<template id="ntp-card-copy-icon">`：HTML 解析器会自动把它放进 SVG 命名空间，于是 JS 里不需要 `createElementNS` 和 `http://www.w3.org/2000/svg` 这个会被构建规则拦掉的字符串，克隆模板即可。`fill: none` + `stroke: currentcolor` 让它跟随按钮颜色。按下时除了变深还有 `:active` 的 `scale(--ntp-card-copy-active-scale)`，并且把 `transition-duration` 压到 `0ms`，保证按下是即时的、松开才走过渡。指针点击后要 `blur()`（`event.detail > 0` 时）——否则按钮一直持焦点，`.ntp-card:focus-within ~ .ntp-card` 会让卡片组一直保持展开，鼠标移开也不收起；键盘用户保留焦点才能继续 Tab。
- 卡片内容来源：`sessions.getRecentlyClosed()` 里 tab 型条目都算数，**包括 `chrome://`、`about:`、`file://` 这类特权页面**——浏览器本来就能恢复它们，卡片只是不能截图而已。唯一被丢掉的是浏览器自己的空页面（`about:blank`/`about:newtab`/`chrome://newtab` 等，见 `stack.js` 的 `SKIPPED_URLS`），因为“新标签页”这张卡片没有任何信息，还会把真实卡片挤出去；`data:`/`blob:`/`javascript:` 也无法恢复，一并跳过。
- 特权页面的图标：`/_favicon/` 只认网页，问它 `chrome://settings/` 会返回通用的地球图标（实测对任何 URL 都返回同一张 64×64），所以标题栏和快照区都退到**站点首字母徽章**（`icons.js` 里的 `siteInitial()`，取 `hostOf()` 首字母，取不到就用 URL 首字符）。和瓦片走完全相同的路径：徽章始终在，`img` 加载成功才给 `.site-icon` 加 `has-icon` 隐藏徽章，加载失败就移除 `img` 露出徽章。
- 没有快照时（标签页还没机会被截到）快照区居中显示站点图标，尺寸 `--ntp-card-placeholder-size`（2.5rem）比标题栏里的大一圈，但远小于卡片：占位图标**不能**铺满快照区，它同样是 `.site-icon`（`variant: 'placeholder'`），尺寸由 `--site-icon-size` 决定，`opacity: 0.55` 让它退到背景。注意快照图片的 `inline-size: 100%` 规则必须写成 `.ntp-card-snapshot img:not(.ntp-card-placeholder)`，否则同属性选择器的特异度会压过图标尺寸，把它拉满整张卡片。
- 字符数上限：`ResizeObserver`（事件驱动，只在宽度真的变化时触发）监听 `#ntp-recent` 宽度 → 一次布局读 `label.clientWidth`（已扣掉复制按钮让出的位置）→ 隐藏的 `.ntp-card-measure` 量平均字符宽 → `charLimitForWidth()` 得到单侧上限 → 标题和地址各自 `limitLabel()`。CSS 的 `text-overflow: ellipsis` 只是兜底，覆盖“resize 到下一次测量之间”的那一帧。上限不硬编码，宽窄窗口各自算出合适的值。
- 快照褪色：快照区按卡片深度降饱和，暗示“已关掉”。上限 `--ntp-card-saturation-max: 0.6`、下限 `--ntp-card-saturation-min: 0.1`，中间值由 CSS 按深度插值（`saturate(calc(max - (max - min) * index / max(1, count - 1)))`），所以 3 张时是 60% / 35% / 10%，1 张时只有深度 0、落在上限 60%。中间档不写死：加减一张卡片，插值自己就变了。`max(1, …)` 防止单张卡片除零让整个 `calc()` 失效（失效就完全没有滤镜）。
- 快照：`background.js` 在标签页变为可见（`tabs.onActivated`、`tabs.onUpdated` 到 `complete`、`windows.onFocusChanged`）时调用 `tabs.captureVisibleTab`，只截当前可见页——已关闭的标签页事后无法补截，所以必须预热。>1080p 才用 `createImageBitmap` + `OffscreenCanvas` 缩到 1920×1080（卡片最大也就一千多像素宽，720p 再放大就糊了），压缩上限来自“快照尺寸”设置（见“设置弹窗”一节），读不到就用 1080P。任何失败都静默回退原图。截图用 `SNAPSHOT_CAPTURE_QUALITY`（80，唯一一次机会，给足细节），缩放重编码用 `SNAPSHOT_QUALITY`（70）。11 张 1080p 快照远低于 `storage.session` 的 10MB 配额。
- 快照槽位：`storage.session`（浏览器只放内存、不落盘、关闭即清空）里维护两个数组：打开中的标签页（按 `tabId` 去重，上限 8 条）和已关闭的环形槽（上限 3 条，按 `url` 去重后覆盖最旧的）。`tabs.onRemoved` 把开着的条目挪进环形槽，槽位满就自然挤掉最旧的，不需要任何定期清理逻辑，因此不存在“异常没清掉导致内存膨胀”。Firefox < 115 没有 `storage.session`，回退成 worker 内的普通对象。
- 新标签页通过 `runtime.sendMessage({ type: 'ntp:snapshots' })` 取快照，按 `url` 与会话列表配对；同一个 `url` 的多个会话只消费一份快照。
- `background.js` 是不含 `import`/`export` 的经典脚本：Chrome 只能加载 `service_worker`，Firefox 不支持 `service_worker`（109–120 甚至会因为声明了它而完全不启动后台），所以 `build.mjs` 按 target 分别写 `background.service_worker` 与 `background.scripts`。
- 新标签页不自己截图：截图需要标签页可见，而新标签页一出现就是当前页，截到的是它自己。
- 整个窗口的卡片：`sessions.getRecentlyClosed()` 还会返回 window 型条目（关掉的是整个窗口），这种条目变成一张 `kind: 'window'` 的卡片。标题栏**不显示图标**，标题是“包含“<当前标签页的标题 - 链接>”等 N 个标签页的窗口”，N 是窗口里剩下的标签页数（受过滤影响），当前标签页取 `tabs.find((tab) => tab.active) ?? tabs[0]`。卡片正文不是快照，而是标签页列表，每行“标题 - 链接”，横竖都在卡片里居中（`justify-content: center`，行数少时上下留白对称）。
- 窗口卡片的字数与行数上限都是量出来的，不硬编码：`fillWindowCard()` 读 `getComputedStyle(list)` 的 `paddingInline`/`paddingBlock`（内边距本身就是“与卡片边缘保持距离”），字数上限 = `charLimitForWidth(可用宽度, 平均字符宽)`，行数上限 = `floor(可用高度 / 行高)`；行高由 `measureRowHeight()` 用绝对定位的探针量，避免插入可见节点抖一帧。装不下的行直接不生成，最后一行换成 `…`（省略号按正常行参与排版，所以列表依然居中）——和“卡片组只渲染选中的张数”同一个思路：不留隐藏 DOM。
- 窗口卡片的标题整句加粗，只有引号里那段标签页标题保持常规字重，好和“标题 - 链接”的普通卡片一眼分开。为此不能把整句当一个文本节点：`fillWindowTitle()` 先用固定词的长度（`t('windowCardTitle', ['', count]).length`）算出留给标签页标题的字数，单独折叠标题，再把渲染好的整句按标题位置切成三段 `.ntp-card-window-words`（加粗）/ `.ntp-card-window-quote`（常规）/ `.ntp-card-window-words`，引号留在加粗侧。句子在不同语言里词序不同，所以不能靠“前缀 + 标题 + 后缀”硬拼，只能对已渲染的句子做切分。
- 各语言的引号按各自习惯写，不要统一：中文 “ ”、英文 \" \"、俄文 « »（见 `messages.json` 的 `windowCardTitle`）。
- 窗口卡片的复制按钮复制**所有**标签页，每行 `[标题](链接)`（markdown 链接，粘到任何编辑器、聊天框或 issue 里都能还原成可点链接）、`\n` 分隔、不插空行（`tabsText()`）；单标签页卡片仍然只复制那一个 URL。
- 窗口卡片的每一行前面带该标签页的图标，来自同一个 `createSiteIcon()`（见下面的“图标”一节），行里是 `.site-icon` 加一个可折叠的文本。图标宽度与间距从 `--ntp-card-tab-icon-size` / `--ntp-card-tab-gap` 读回，字符上限相应减去这段宽度（图标与首字母徽章同宽，所以两种行折得一样）。行内容用 flex 居中（图标 + 文本一起居中），只有文本允许折叠，所以短行真的落在卡片中间，而不是左对齐。
- 窗口卡片由 `stack.js` 的 `windowCard()` 产出：过滤规则与标签页卡片一致（`webOnly` 时只留 http/https，否则用 `isCardUrl`），过滤后一个标签页都不剩就返回 `undefined`，整张卡片不渲染。窗口卡片与标签页卡片平等占用同一个 `maxCards` 名额。
- 带替换的文案（如 `windowCardTitle`）必须在 `messages.json` 里写 `placeholders`（`{"head": {"content": "$1"}}`），正文写 `$head$`；只写 `$1$` 会让 Chrome **拒绝加载整个扩展**，报 “Variable $1$ used but not defined”。`getMessage(key, [a, b])` 按顺序填 `$1`、`$2`。

### 常驻会话托盘

- 它**不受设置影响**：卡片显示几张、是否排除窗口、是否排除特权页面，都只影响上面的卡片组，托盘永远列出 `sessions.getRecentlyClosed()` 返回的全部条目（无法恢复的 `data:`/`blob:`/`javascript:` 和浏览器空白页照样跳过，这不是设置，是没法恢复）。
- 它**就是塔里的一张普通卡片**，不是另一套布局：元素同时带 `.ntp-card`（同一份框体、圆角、阴影、`aspect-ratio`、阶梯 `transform`）和 `.ntp-session-list`（只负责内部是表头 + 行而不是快照）。渲染上它排在 `#ntp-recent` 的第一个子节点（画在最后面），索引取 `--ntp-card-index` = 卡片张数，也就是比最旧那张卡片再高一级台阶；不过它只露出 **1 倍**标题栏高（`--ntp-session-peek`），补偿量是 `--ntp-card-step - --ntp-session-peek`，同时从舞台的 `margin-block-start` 里扣掉同样多，塔顶才不会空出一条。指针移上去时其余卡片下滑，把它整块让出来。
- 设置里的“最近关闭卡片最大显示数”**只数普通卡片**：详细列表不参与计数、不占名额，设成 1 时照样是“1 张卡片 + 这张列表”。舞台的上边距按 `--ntp-stack-count`（卡片数 + 1）预留，所以塔顶不会空出一条，列表的表头也不会顶到瓦片上。
- 一条会话都没有、或者设置里没打开“显示最近关闭详细列表”时整块 `hidden`（`renderSessionList()` 里按行数 + 开关切），不留一条空表头，舞台也自动少预留一级。隐藏时**节点仍留在 DOM 里**（`renderRecentCards()` 只切 `hidden`，不把它从 `replaceChildren` 里拿掉），否则开关就再也找不回这张卡片。
- 指针移到露出的那条表头上（或键盘 Tab 进托盘）时，其余卡片一起下滑到与悬停其它卡片相同的落点，把列表让出来：`body.ntp-session-open .ntp-card:not(.ntp-session-list) { inset-block-start: calc(100% - var(--ntp-card-overhang) - var(--ntp-card-peek)) }`。这个 class 由 `pointerenter`/`pointerleave`/`focusin`/`focusout` 切换，**不用** `:has()`——列表在卡片后面，Firefox 121 以下没有 `:has()` 时它永远点不到。
- 它不贴着视口底边：和别的卡片一样按屏幕比例算出高度、四角都是 `--ntp-card-radius`，内容多了就在卡片内部滚动（表头 `position: sticky`）。
- 表头一行是列名 + 最右边的“恢复”按钮（`#ntp-session-restore`）；没勾选任何行时 `disabled`，靠 `opacity` 变灰但**不离场**，否则表头会跳一下。这一格 `position: sticky; inset-inline-end: 0` 并带自己的背景色：列宽是固定的，窗口一窄整张表就要横向滚动，按钮必须钉在滚动视口右边才不会滑出去点不到。
- 每一行：左边复选框，然后图标（同一个 `createSiteIcon()`）、标题、链接、类型、关闭时间（`Intl.DateTimeFormat` 的短日期 + 时间，后面跟一个括号里的相对时间；原始时间戳挂在 `title` 上）。相对时间用原生 `Intl.RelativeTimeFormat`，文案由浏览器按界面语言给出、不需要自己翻译；**只有括号本身来自 `sessionRelative` 这个词条**，因为中文用全角 `（ ）`、英文和俄文用半角 `( )`，不能共用一套符号。绝对时间与相对时间的粒度都在 `formatClosedTime()` 里，按秒/分/时/天/周/月/年逐级退化。标签页行是普通行；窗口行默认折叠成一行（类型列显示“窗口 · N”），左侧多一个展开按钮（原生 `<button aria-expanded>` 切换子行的 `hidden`，展开不重新渲染，勾选状态不会丢），展开后逐行列出它包含的标签页。
- 行模型在 `stack.js` 的 `buildSessionRows()` 里，纯函数、可单测：tab 条目 → 一行，window 条目 → 一行外加 `tabs`；`lastModified` 经 `toEpochMillis()` 归一，取不到就是 0（显示为空而不是 NaN）。**文档说是毫秒，但 Chromium 实际给的常常是秒**，直接格式化会显示成 1970 年；小于 `EPOCH_MILLIS_CUTOFF`（1e11，本世纪之前）的值一律乘 1000，两种口径都能落到正确的时刻。
- 列宽可拖：每列表头右边缘有一条 `.ntp-session-resizer`，`pointerdown` + 拖拽只改托盘上的一个自定义属性（`--ntp-session-col-<列>` = `max(3rem, Npx)`），表头与所有行共用同一份 `grid-template-columns`，所以天然对齐；总宽超出托盘时托盘整体横向滚动。注意 **不能** 把整串 `grid-template-columns` 存进一个 `--ntp-session-columns` token：CSS 的 `var()` 间接引用在声明处解析，托盘上拖出来的宽度会被 `:root` 里的旧值吃掉，必须把 track 列表直接写在规则里。
- 恢复：勾选若干行后点表头按钮，逐个 `sessions.restore(sessionId)`（一次失败不影响其余），然后清空勾选、重新取列表。

### 设置弹窗

- 原生 `<dialog>` + `showModal()`；`::backdrop` 压暗背景；点背景（事件目标就是 dialog 本身）或关闭按钮关闭。
- 没有保存按钮：勾选即写 `localStorage` 并立即重渲染。
- “排除已收藏的网站”：`bookmarks.getTree()` 递归收集 http/https 条目的主机名并去掉 `www.` 前缀，按主机名精确匹配（`baike.baidu.com` 不会被 `baidu.com` 的收藏跳过）。
- Chromium 上该选项置灰禁用：Chromium 的 topSites 只有 10 条，排除后瓦片会留空。这只是前端 `disabled`，不做防止强行开启的防御逻辑。
- “Firefox 风格瓦片”：只切 `body` 的 class，纯视觉开关，不影响任何列表逻辑；默认跟随浏览器判定。
- “快照尺寸”：下拉 720P/1080P/2K/4K，存 `ntp-snapshot-cap`（值就是短边像素 720/1080/1440/2160），默认 1080。它同时被镜像到 `storage.local`，因为真正做缩放的是后台脚本，而 service worker 读不到新标签页的 `localStorage`——两处都写，任一处被清掉都还能自愈。不检测屏幕分辨率，所有机器默认 1080P。
- “最近关闭卡片最大显示数”：下拉 1/2/3，存 `ntp-recent-count`，默认 1。改动后重新取一次列表重渲染，多出的卡片直接不渲染（不是隐藏），所以 DOM 里永远不会超过选中的张数。
- “排除特权页面”：勾选（默认）时只收 http/https 会话，退回到“卡片只放网页”的老行为；取消勾选就让 `chrome://`、`about:`、`file://` 也进卡片。存 `ntp-exclude-privileged`，改动后立刻重新取列表重渲染。实现是一条 `{ webOnly }` 选项穿过 `buildRecentCards()` → `toRecentSessions()`，两套过滤规则都在 `stack.js` 里，UI 只负责传布尔值。
- “排除窗口”：勾选后 window 型条目不再变成卡片；默认**不勾选**（关掉整个窗口通常比关掉一个标签页更值得恢复）。存 `ntp-exclude-windows`，同样即时重渲染。窗口卡片内部的标签页过滤与“排除特权页面”共用同一个 `webOnly` 开关。
- “显示最近关闭详细列表”（`#opt-session-list`）：默认**不勾选**，勾上才把详细列表这张卡片放进塔里。存 `ntp-session-list`，改动后立刻重新取列表重渲染。它是独立的开关，不受“最近关闭卡片最大显示数”影响——那个只数普通卡片。行数据也是只在这个开关打开时才从 `sessions` 列表构建（关着的时候连 DOM 都不填）。
- “调试：只用单字母图标”（`#opt-letter-favicons`）：给 `body` 加 `ntp-letter-favicons`，CSS 把 `.ntp-tile-icon img` 藏起来、强制露出 `.ntp-tile-letter`，用来在图标都能加载的页面上直接看首字母兜底的效果。**故意不存**，刷新即回到真实图标——它只是开发期的一副眼镜，不是设置项。

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
- [ ] 悬停第二/第三张卡片时，压在它上面的卡片带缓动往下推、只在视口底边留 1.5 倍标题栏高度（M3 Expressive 阻尼曲线），光标指的那张完整露出（含快照）；把光标横移过去能直接悬停那些露头的卡片
- [ ] 瓦片下方到视口底边全被卡片占满，瓦片和卡片之间没有空带；卡片宽度跟着窗口横向拉伸等比缩放，竖向拉伸只改变露出多少、不改变卡片尺寸；卡片长宽比始终等于屏幕长宽比，窗口拉得再扁也不变形（宁可越出视口）
- [ ] 标题与链接共用同一个字符数上限，窗口变窄时不刷新页面也会收得更紧
- [ ] 点卡片恢复被关闭的标签页；点复制按钮只复制链接、不触发恢复
- [ ] 关掉一个 `chrome://settings` 页面后照样出现卡片，标题栏和快照区都显示首字母；`chrome://newtab` 这类空页面不出卡片
- [ ] 快照按深度褪色：3 张时 60% / 35% / 10%，只显示 1 张时是 60%
- [ ] 没有快照的卡片在快照区居中显示 favicon（Firefox 显示首字母），不是一片空白，也没有被拉满整张卡片
- [ ] 快照只在内存里（重启浏览器后为空），超 1080p 的已压到 1080p
- [ ] 设置里“显示最近关闭详细列表”默认不勾选，勾上后详细列表这张卡片出现在塔底、取消勾选后消失且不占名额，刷新后记住选择；
- [ ] 详细列表就是塔里最靠后的一张卡（同一套框体/圆角/阴影/阶梯缩放），默认只露出 1 倍标题栏高的一条表头，其余被前面的卡片盖住；行数、类型（窗口/标签页）、关闭时间都对得上 `sessions.getRecentlyClosed()`
- [ ] 列表不受设置影响：把“最近关闭卡片最大显示数”改成 1、勾上“排除窗口”，列表里照样是完整内容，且卡片只有 1 张 + 这张列表
- [ ] 勾选若干行后“恢复”按钮才可用，点它能把选中的会话恢复回来并刷新；未勾选时是灰的但仍在原位
- [ ] 关闭时间显示的是真实时刻而不是 1970 年（Chromium 的 `lastModified` 是秒，`toEpochMillis()` 会补齐），后面跟着“（3 分钟前）”这种相对时间，中文是全角括号、英文/俄文是半角括号
- [ ] 窗口行能展开/收起它包含的标签页，展开时勾选状态不丢
- [ ] 拖动表头列边缘能改列宽，表头和数据行始终对齐，内容超宽时列表横向滚动，而“恢复”按钮始终钉在右侧可见可点
- [ ] 指针移到列表露出的表头（或 Tab 进去）时其余卡片下滑、列表完整露出；指针移开后又滑回原位
- [ ] 设置里改“最近关闭卡片最大显示数”立即生效，刷新后仍保持
- [ ] 设置里改“快照尺寸”后，新截的快照按新上限缩放（720P 明显更小、4K 几乎不缩），刷新后保持；从没打开过设置时默认 1080P
- [ ] “排除特权页面”默认勾选时 `chrome://` 页面不出卡片，取消勾选后立刻出现；刷新后保持上次的选择
- [ ] 关掉一个窗口后出现窗口卡片：标题栏无图标、标题是“包含“… - …”等 N 个标签页的窗口”，整句加粗、引号内的标题不加粗，正文是横竖居中的标签页列表，装不下的行换成最后一行 `…`
- [ ] 窗口卡片的每一行前面有该标签页的 favicon，整行（图标 + 文本）在卡片里横竖居中
- [ ] 窗口卡片的复制按钮复制所有标签页（每行 `[标题](链接)`，不插空行）；点卡片能恢复整个窗口
- [ ] “排除窗口”默认不勾选；勾上后窗口卡片立刻消失，刷新后保持
- [ ] 调试开关勾上后所有瓦片图标立刻换成首字母，取消勾选恢复；刷新后回到真实图标（不持久化）
- [ ] 首字母徽章是圆角矩形无描边，字号大到被徽章切掉、逆时针倾斜、压在右下角；同一站点刷新后颜色不变，浅色底用深字、深色底用白字
- [ ] 徽章配色是孟菲斯色系的饱和撞色，不再是灰扑扑的莫兰迪；徽章里的字母拖选不上
- [ ] 窄窗口下瓦片加卡片仍无滚动条、卡片区不被压扁成 0 高
- [ ] `npm test` 与 `npm run build` 通过；`test/headless/run.mjs` 全绿，实际渲染与预期一致
- [ ] 重大修改是逐项验证过的，不是在未验证的改动上继续叠加
- [ ] 瓦片、卡片标题栏、窗口卡片每一行、快照占位这四处的图标是同一套徽章外观（只有尺寸不同），没有哪一处还是老样式
