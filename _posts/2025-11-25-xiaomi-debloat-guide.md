---
title: "小米手机 (HyperOS/MIUI) 深度优化指南：移除 AI 组件与去广告"
date: 2025-11-25 22:00:00 +08:00
excerpt: "通过 ADB 移除小米手机中冗余的 AI 组件、广告服务及臃肿软件，并调整系统设置以提升流畅度和续航。"
categories:
  - Tutorial
tags:
  - XiaoMi
  - RedMi
  - HyperOS
  - MIUI
  - Android
  - ADB
toc: true
toc_label: "目录"
toc_icon: "cog"
---

随着 HyperOS 和 MIUI 的更新，系统集成了越来越多的 AI 功能和后台服务。虽然部分功能很实用，但对于追求极致流畅、隐私保护或老机型用户来说，这些组件可能意味着额外的耗电和卡顿。

本文将介绍如何通过 ADB (Android Debug Bridge) 安全地移除这些组件，并进行系统级优化。

## 通过 ADB 卸载 AI 及冗余组件

此操作**不需要 ROOT 权限**，但需要一台电脑（Windows/Mac/Linux 均可）。

### 1. 准备工作

1. **开启开发者模式**：

   - 进入**设置** $\rightarrow$ **我的设备** $\rightarrow$ **全部参数**。
   - 连续点击“OS 版本号”约 5-7 次，直到提示“您已处于开发者模式”。

2. **开启 USB 调试**：

   - 进入**设置** $\rightarrow$ **更多设置** $\rightarrow$ **开发者选项**。
   - 开启**“USB 调试”**。
   - 开启 **“USB 调试（安全设置）”**（重要：如果不开启此项，部分系统应用无法被卸载，提示 `Permission denied`）。

3. **连接电脑**：

   - 使用数据线连接手机与电脑。
   - 在电脑上下载并解压 [SDK Platform Tools](https://developer.android.com/studio/releases/platform-tools) (ADB 工具包)。

### 2. 执行卸载命令

在电脑终端（CMD 或 Powershell）进入 ADB 工具目录，输入以下命令确认连接：

```bash
adb devices
```

如果手机弹出授权窗口，请点击“允许”。看到设备序列号后，即可使用以下格式卸载应用：

```bash
adb shell pm uninstall --user 0 <包名>
```

> **注意**：`--user 0` 表示仅针对当前用户卸载，不会破坏系统分区。如果出现问题，可以通过恢复出厂设置完全还原。

### 3. 建议卸载的清单

以下是小米系统中常见的 AI 相关及“臃肿”组件的包名。请根据你的需求**选择性**执行：

#### 🤖 核心 AI 与语音组件

如果你不使用小爱同学，这些服务在后台占用大量资源。

| 组件名称 | 包名 | 说明 |
| :--- | :--- | :--- |
| **小爱同学** | `com.miui.voiceassist` | 语音助手主程序 |
| **小米 AI 引擎** | `com.xiaomi.aiasst.service` | 场景识别、AI 调度 |
| **AI 视觉/传送门** | `com.miui.contentextension` | 屏幕识别、选词搜索 |
| **小爱建议/负一屏** | `com.miui.personalassistant` | 桌面左侧的负一屏 |
| **小爱翻译** | `com.xiaomi.scanner` | 包含扫一扫和翻译功能 |

#### 📢 广告与分析组件 (推荐删除)

这些组件主要用于推送广告和收集数据，删除后系统更清爽。

| 组件名称 | 包名 | 说明 |
| :--- | :--- | :--- |
| **系统广告服务 (MSA)** | `com.miui.systemAdSolution` | MIUI System Ads，广告核心 |
| **小米分析** | `com.miui.analytics` | 数据采集与分析 |
| **用户反馈** | `com.miui.miservice` | 反馈服务 |
| **智能服务** | `com.miui.hybrid` | 混合推送服务 |
| **快应用服务框架** | `com.miui.hybrid.accessory` | 经常误触打开快应用 |

#### 📦 其他常见臃肿软件

| 组件名称 | 包名 | 说明 |
| :--- | :--- | :--- |
| **小米浏览器** | `com.android.browser` | 建议使用 Chrome 或 Edge 替代 |
| **小米视频** | `com.miui.video` | 包含大量在线内容 |
| **小米音乐** | `com.miui.player` | QQ 音乐简化版，可以试一试 |
| **小米钱包** | `com.mipay.wallet` | 如果不用 NFC 刷卡可删 |

### 4. 如何恢复误删的应用？

如果你不小心删除了重要组件，可以通过以下命令恢复（无需重置手机）：

```bash
adb shell cmd package install-existing <包名>
```

例如恢复小爱同学：`adb shell cmd package install-existing com.miui.voiceassist`

### 5. 推荐工具：UAD

如果你觉得敲命令太麻烦，可以使用开源图形化工具 **[UAD (Universal Android Debloater)](https://github.com/0x192/universal-android-debloater)**。

UAD 是一个跨平台的图形界面软件，能自动识别小米手机的臃肿软件，并标注“安全删除”、“谨慎删除”，非常适合新手。

> **⚠️ 警告**：绝对不要卸载 `com.miui.home`（系统桌面）或 `com.android.systemui`，否则手机会黑屏或无法进入系统。

---

## 系统设置优化

除了卸载软件，正确的设置也能显著提升体验。

### 1. 关闭内存扩展 (Memory Extension)

- **路径**：**设置** $\rightarrow$ **更多设置** $\rightarrow$ **内存扩展**
- **建议**：**关闭**
- **原因**：这个功能使用闪存（Flash Storage）模拟内存（SWAP）。手机闪存的随机读写速度远低于物理内存（RAM）。开启后不仅不会让手机变快，反而会增加 I/O 负担，导致系统在切换应用时掉帧，并增加发热和耗电。对于 8GB 及以上内存的机型，此功能完全是副作用。

### 2. 关闭系统广告开关

虽然卸载了 MSA，但部分开关仍建议手动关闭以防漏网之鱼。

- **系统工具广告**：**设置** $\rightarrow$ **账号** $\rightarrow$ **关于小米账号** $\rightarrow$ **系统广告** $\rightarrow$ 关闭。
- **应用内推荐**：分别进入**天气、日历、下载管理、应用商店、文件管理**的设置中，找到并关闭“内容推荐”、“个性化服务”或“资讯”。

### 3. 调整动画速度

- **路径**：**开发者选项** $\rightarrow$ 向下滚动找到**绘图**栏目。
- **设置**：
  - 窗口动画缩放 $\rightarrow$ **0.5x**
  - 过渡动画缩放 $\rightarrow$ **0.5x**
  - Animator 时长缩放 $\rightarrow$ **0.5x**
- **效果**：这不会改变手机的实际处理速度，但会缩短 UI 动画的持续时间，让手机在体感上响应更加迅速干脆。

---

*免责声明：本文提供的操作涉及系统层面的修改。虽然通过 `pm uninstall --user 0` 卸载应用通常是安全的且可逆的，但操作不当仍可能导致系统不稳定。
