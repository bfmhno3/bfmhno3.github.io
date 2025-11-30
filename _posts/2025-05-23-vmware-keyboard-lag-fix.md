---
title: "VMware Workstation 17.x 中的虚拟机按键反应迟钝解决办法"
date: 2025-05-23 22:34:00 +08:00
excerpt: "本文介绍了如何解决 VMware Workstation 17.x 中虚拟机（如 Ubuntu）按键反应迟钝、跟手性差的问题。通过在 .vmx 配置文件中添加 keyboard.vusb.enable = \"TRUE\" 参数，可以有效改善输入延迟，无需降低 CPU 核心数或关闭 3D 图形加速。"
categories:
  - Tutorial
tags:
  - VMware Workstation
---

## 问题描述

在 VMware Workstation 17.x 中的虚拟机按键反映迟钝，具体而言即是屏幕显示的字符速度跟不上手打字的速度，你能很明显得感觉到迟钝。

特别是长按方向键选择时，长按一两秒，光标会移动好几秒，跟手性非常差，非常难受。

笔者这里所说的“**跟手性**”是指：当用户开始输入时，屏幕就开始刷新字符，刷新字符的速度与用户打字的速度不能差太多，并且当用户停止输入时，屏幕能立即停止刷新字符。

## 笔者环境

+ VMware Workstatio 17 Pro：17.6.3 build-24583834
+ 虚拟机：Ubuntu 16.04
+ 操作系统：Windows 11 专业版 26100.4061

## 解决方法

请按照以下步骤操作，修改虚拟机的配置文件：

1. **关闭虚拟机**：确保虚拟机处于完全关闭状态（Power Off），而非挂起（Suspend）。
2. **找到配置文件**：进入虚拟机所在的文件夹，找到后缀为 `.vmx` 的配置文件（通常与虚拟机同名）。
3. **编辑文件**：右键点击该文件，选择使用记事本（Notepad）或 VS Code 打开。
4. **添加配置**：在文件的末尾添加以下代码：
```ini
keyboard.vusb.enable = "TRUE"
```
5. **保存并重启**：保存文件后，重新启动虚拟机即可生效。

> **原理说明**：该配置强制启用了虚拟 USB 键盘设备，绕过了某些导致延迟的输入仿真层。

## 测试环境

+ Ubuntu 16.04
+ Ubuntu 18.04
+ Ubuntu 22.04
+ ElementaryOS 7 Horus

在以上虚拟机中，笔者对此方法进行了测试，都取得了很好的效果。

## FAQ

### 是否需要降低核心数

网上有很多其他的教程说可以降低 CPU 的核心数，具体原理是减少虚拟机等待的时间。

笔者实测，降低 CPU 核心数确实能带来一定速度的提升，但是效果很微弱。

但是当我在 `*.vmx` 文件中添加了 `keyboard.vusb.enable = "TRUE"` 后，我将虚拟机的核心数提高到了 16 个，在虚拟机中打字时的跟手性也非常好，只是整个虚拟机有时候会有点卡顿，完全在可接受的范围内。

不过一般来说，核心数只需要设置为 1-4 即可，不然可能会拖慢宿主机的运行。

终上所述，核心数并无太大影响，读者自己有数就行。

### 是否需要关闭 3D 图形加速

网上还有很多的教程说需要关闭 3D 图形加速，但是有很多软件的运行是需要这个功能的比如 Gazebo，不然就会变得非常卡。

关闭 3D 图形加速后，确实能够比较明显的感觉到在虚拟机中打字时的跟手性有改善，但是也还没有到那种可以忍受的地步（至少对我而言）。

在 `*.vmx` 文件中添加了 `keyboard.vusb.enable = "TRUE"` 后，我开启了 3D 图形加速，笔者实测打字的跟手性依旧非常好，同上的效果，只是虚拟机本身有一点卡顿，但完全在可接受的范围内。

综上所述，无需关闭 3D 图形加速。不过开启了 3D 加速确实会影响虚拟机的运行，如果你的工作不需要大量 3D 渲染的话，笔者还是建议关闭 3D 图形加速功能。

## 参考资料

+ [WS 17.6.1 keyboard lag with Ubuntu guest](https://community.broadcom.com/vmware-cloud-foundation/discussion/ws-1761-keyboard-lag-with-ubuntu-guest)
+ [Experiencing keyboard lag/input delay on any Linux Distribution](https://www.reddit.com/r/vmware/comments/15kx569/experiencing_keyboard_laginput_delay_on_any_linux/)
