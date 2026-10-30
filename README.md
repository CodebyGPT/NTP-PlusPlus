# Just a NTP

一个空白、纯色、跟随浏览器主题的新标签页。切到任意其他标签页（包括其他窗口）后，新标签页自动关闭。

- 无网络请求、无遥测、无远程资源
- Chrome / Firefox：声明 `tabs` 与 `<all_urls>` 主机权限；当前代码只用 `tabs` 统计同窗口标签页数量并关闭自己，不注入内容脚本、不读取网页内容
- Chrome：深浅色跟随 `prefers-color-scheme`
- Firefox：额外读取当前主题色（`ntp_background` → `frame`）
- 纯事件驱动，无轮询：新标签页失去焦点或变为隐藏时，只要同一窗口还有其他标签页就关闭自己；只剩它一个时保留，避免把窗口一起关掉
- 纯色背景铺满任意窗口尺寸

开发规则和设计说明见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 构建

需要 Node.js：

```bash
npm test
npm run build
```

产物在 `dist/chrome/` 和 `dist/firefox/`。

## 加载

**Chrome / Edge**：打开扩展管理页，启用开发者模式，选择“加载已解压的扩展程序”，指向 `dist/chrome/`。

**Firefox**：打开 `about:debugging#/runtime/this-firefox`，点击“临时载入附加组件”，选择 `dist/firefox/manifest.json`。

> Chrome / Firefox 使用 `tabs` 权限识别自己的新标签页并关闭，Firefox 额外使用 `theme` 权限读取当前主题色；两者还声明了 `<all_urls>` 主机权限。都不发起网络请求，也不保存浏览记录。
