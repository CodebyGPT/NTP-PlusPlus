# NTP++

一个跟随浏览器主题的极简新标签页：常用网站瓦片 + 纯色背景。切到任意其他标签页（包括其他窗口）后，新标签页自动关闭。

- 无网络请求、无遥测、无远程资源
- 支持 Chrome 121+ / Firefox 109+，统一使用 Promise API；低于 Chrome 121 的 Chromium 内核浏览器会被清单拒绝安装
- 常用网站 5×2 共十个瓦片：左键在当前标签页打开，右键弹出浏览器原生菜单；取不到有效图标时显示首字母
- 两套瓦片风格，按浏览器自动选择，也可在设置里手动切换：Chromium 是圆形图标底，悬停时整块瓦片出现 3px 圆角的底色，标题单行省略；Firefox 是 8px 圆角图标底，悬停时图标底略微放大并在图标右上角显示删除按钮，标题最多两行后省略。识别不到浏览器时回退 Chromium 风格
- Chromium：`topSites` API 最多返回十条，因此不显示删除按钮；站点图标通过 `/_favicon/` 读取
- Firefox：使用 `topSites.get` 的 `includeFavicon`；每个瓦片可删除，删除后由溢出站点补位
- 右下角设置弹窗：点背景或关闭按钮关闭，改完即时生效，没有保存按钮
  - 只保留域名（默认关闭）：瓦片链接收窄到站点根地址
  - 排除已收藏的网站（默认关闭，Chromium 上置灰）：按主机名精确匹配跳过收藏过的站点
  - Firefox 风格瓦片（默认跟随浏览器）：手动在两种瓦片风格之间切换
- Chrome：深浅色跟随 `prefers-color-scheme`
- Firefox：额外读取当前主题色（`ntp_background` → `frame`）
- 纯事件驱动，无轮询、无定时器：新标签页失去焦点或变为隐藏时，只要同一窗口还有其他标签页就用 `window.close()` 关闭自己；只剩它一个时保留，避免把窗口一起关掉；不调用 `tabs.remove`，不会遇到标签栏忙锁
- 纯色背景铺满任意窗口尺寸
- 瓦片下方是最近关闭的标签页卡片：最新的在最上层且最大，往回依次等比缩小叠在下面，只露出标题栏和一点网页快照；最新的那张故意被视口下边缘切掉一截
- 卡片标题栏显示站点图标、网页标题和网址（中间用 ` - ` 连接，两段共用一个按标题栏宽度算出来的字数上限，超出以省略号折叠），最右侧是复制链接按钮
- 鼠标移到被压住的卡片上，压着它的卡片带 Material 3 Expressive 阻尼曲线往下推，在视口底边留 1.5 倍标题栏高度，方便横移过去继续挑
- 点卡片的任意位置（标题栏或快照）用 `sessions.restore()` 恢复那个标签页；卡片比例始终等于显示器比例，只有横向拉伸浏览器窗口才会等比缩放，窗口太矮时宁可越出视口也不变形
- 后台脚本在标签页可见时静默截图（`captureVisibleTab`，超过 1280×720 先缩放），最近关闭的三个槽位只放在 `storage.session`（仅内存、不落盘，旧数据被新数据覆盖）；取不到快照时在快照区居中显示站点图标
- 设置里「最近关闭卡片最大显示数」可选 1 / 2 / 3，默认 3
- 支持简体中文、英文、俄文，按浏览器界面语言自动选择；不支持的界面语言回退英文

开发规则和设计说明见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 权限

- Chrome / Edge：`sessions`、`storage`、`tabs`、`topSites`、`favicon`、`<all_urls>` 主机权限
- Firefox：`sessions`、`storage`、`theme`、`tabs`、`topSites`、`bookmarks`、`<all_urls>` 主机权限

`topSites` 用于读取常用网站；`favicon` 只用于按网址读取站点图标；`bookmarks` 只在开启“排除已收藏的网站”时读取收藏夹里的主机名；`tabs` 只用于统计同窗口标签页数量并关闭自己；`sessions` 只用于列出最近关闭的标签页并恢复其中被点开的那一个；`storage` 只用于 `storage.session`（仅内存）暂存标签页快照。后台脚本会调用 `captureVisibleTab` 给当前可见的标签页截图，截图只留在内存里、不写入磁盘、不上传。不注入内容脚本、不读取网页内容、不上传任何数据。

## 诊断日志

诊断面板默认隐藏，避免遮挡瓦片。需要在扩展页面地址后加 `?debug`（例如 `chrome-extension://<扩展ID>/newtab.html?debug`）才会显示底部日志面板，记录加载状态、`topSites` 渲染、设置变更、焦点/可见性事件、标签页数量、关闭尝试和失败原因。选中文本后右键即可复制，也可以点击面板上的复制按钮。日志始终输出到扩展页面的 DevTools Console。

## 本地数据

设置项和已删除的站点保存在扩展页面的 `localStorage`（`ntp-domain-only`、`ntp-exclude-bookmarks`、`ntp-tile-style`、`ntp-hidden-sites`），不随浏览记录同步、不发送到任何服务器。

## 构建

需要 Node.js：

```bash
npm test
npm run build
```

产物在 `dist/chrome/` 和 `dist/firefox/`。

## 加载

**Chrome / Edge 121+**：打开扩展管理页，启用开发者模式，选择“加载已解压的扩展程序”，指向 `dist/chrome/`。低于所需版本的 Chromium 内核浏览器会拒绝安装。

**Firefox**：打开 `about:debugging#/runtime/this-firefox`，点击“临时载入附加组件”，选择 `dist/firefox/manifest.json`。
