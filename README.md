# TaskbarLyrics-BetterNCM

在 Windows 任务栏上实时显示网易云音乐歌词的 BetterNCM 插件

![preview](./preview.png)

## 功能特性

- 任务栏歌词窗口：不遮挡任务栏交互（点击穿透），支持窗口对齐方式（自动 / 左对齐 / 居中 / 右对齐）、左右边距
- 主 / 副歌词（翻译或下一句）双行显示，颜色、字号、粗细、斜体、下划线、删除线、文本对齐均可配置
- 行间距可调（-10 ~ +20 px），设置页滑杆实时预览
- 字体下拉框仅列出**真正支持中文**的系统字体（DirectWrite 字形覆盖检测），显示本地化中文名
- 高 DPI 适配：Per-Monitor-V2 DPI 感知，125% / 150% 等缩放下文字清晰不模糊，支持跨显示器拖动
- 配置通过 BetterNCM 文件 API（config.json）持久化，避免客户端退出时 localStorage 写入丢失
- 基于 UI Automation 跟踪任务栏布局变化（图标居中 / 小组件开关 / 分辨率变化时自动重定位）
- 歌词切换淡入淡出动画

## 安装（普通用户）

下载 Release 中的 `taskbar_lyrics.plugin`，放入 BetterNCM 插件目录betterncm\plugins中，重启网易云音乐即可。

## 构建（开发者）

```bash
# JS 侧（dist/main.js）
npm install
npm run build

# C++ 侧（native.dll，需要 VS2022+ 与 CMake）
cd cpp
cmake --build build --config Release
```

打包：将 `manifest.json`、`native.dll`、`preview.png`、`dist/main.js` 打为 zip 并重命名为 `taskbar_lyrics.plugin`。

## 项目结构

```
cpp/src/          C++ native 插件（Direct2D/DirectWrite 渲染 + UI Automation 任务栏定位）
src/              TypeScript 前端（歌词获取、配置界面、与 native 通信）
dist/             构建产物（main.js）
manifest.json     BetterNCM 插件清单
```

## 致谢 / Acknowledgements

本项目**复刻自 BetterNCM 插件 [Taskbar-Lyrics](https://github.com/mo-jinran/Taskbar-Lyrics)（作者 mo-jinran ）**，在其设计与代码基础上修改和扩展而来。感谢原作者的工作，以及：

- [BetterNCM / chromatic](https://github.com/std-microblock/chromatic) —— 插件运行框架
- [BetterNCM ts-framework](https://github.com/BetterNCM)（BetterNCM Team，GPL-3.0）—— 部分参考其插件配置界面与框架代码

本项目遵循原项目的 **GPL-3.0-or-later** 许可证开源，修改内容同样以 GPL-3.0-or-later 分发。
