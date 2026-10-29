# Just a NTP

一个空白、纯色、跟随浏览器主题的新标签页。切到同窗口的任意其他标签页后，新标签页自动关闭。

- 无网络请求、无遥测、无远程资源
- Chrome：不申请权限，深浅色跟随 `prefers-color-scheme`
- Firefox：读取当前主题色（`ntp_background` → `frame`）
- 纯事件驱动，无轮询
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

> Firefox 使用 `theme` 权限读取当前主题色；Chrome 构建不声明任何权限。
