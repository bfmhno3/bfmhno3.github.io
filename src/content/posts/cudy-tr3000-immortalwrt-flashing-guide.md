---
title: "Cudy TR3000 256 MB 刷入 ImmortalWrt：一次完整的图形化流程"
published: "2026-08-27 09:00:00 +08:00"
description: "记录 Cudy TR3000 256 MB V1 从原厂固件、签名中间固件到 ImmortalWrt 25.12.1 和自定义镜像的完整图形化刷机流程，并介绍官方 TFTP 恢复方法。"
category: Tutorial
tags:
  - Cudy
  - TR3000
  - ImmortalWrt
  - OpenWrt
  - Router
draft: false
comment: true
---

> [!WARNING] 刷机风险提示
> 以下风险提示来自 Cudy 官方京东自营店，具体情况请以官方最新说明为准：
>
> 1. 刷机后遇到的相关问题，需您自主寻求解决方案，店铺不提供技术支持。
> 2. 刷机后不支持退货退款，保修期内最多支持两次因刷机产生的售后。
> 3. 保留权益：除刷机产生的售后外，其他质量问题在保修期内仍可享受正常售后。
>
> 本文只记录我这台 **Cudy TR3000 256 MB V1** 的实际操作。刷机有风险，请确认自己能接受设备无法启动、需要恢复固件，甚至失去部分售后支持的结果。官方政策和设备支持范围可能变化，购买和操作前请以 Cudy 官方说明为准。

我在 2025 年 9 月 1 日买过一台 Cudy TR3000 256 MB V1，刷入 ImmortalWrt 后用了接近一年，网络稳定性和日常体验都还不错。2026 年 8 月 24 日，机缘巧合之下，我又买了一台同型号设备，于是决定把这次从原厂系统到 ImmortalWrt，再到自定义镜像和官方恢复的完整过程记录下来。

这次我没有拆机，也没有进入 UART 或 U-Boot。真正做的事情基本都在浏览器里完成，唯一稍微像“网络工程”的部分是最后用 Tftpd64 通过 TFTP 把官方固件送回路由器。整个过程更像一条网页里的接力赛：原厂网页先交棒给中间固件，中间固件再交棒给 ImmortalWrt，最后我还让它跑了一圈自定义构建。

## 先确认：这是 256 MB 版本

这台设备背面标签右上角明确写着 **256 MB 闪存版**，产品型号是 `TR3000`，管理地址是 `192.168.10.1`。

![2026 年购买的 Cudy TR3000 256 MB V1 原始背面标签照片](/assets/images/cudy-tr3000/2026-08-24-device-label.jpg)

这台设备的 SN 前缀是 `S0001825`。去年那台设备的 SN 前缀则是 `TR3000`。两台机器标签形式不同，但都明确标注了 256 MB 闪存版本。本文只记录这两台 256 MB V1 设备，不把其他批次的 SN 规则推广到本设备之外。

![2025 年购买的 Cudy TR3000 256 MB V1 原始背面标签照片](/assets/images/cudy-tr3000/2025-09-01-device-label.jpg)

> [!IMPORTANT]
> 文章中的文件名、界面和分区选择只适用于明确标注为 **Cudy TR3000 256 MB V1** 的设备。不要只凭 SN 猜测硬件版本，应该先确认机身标签上的容量标识。

## 第一次开机：先把原厂网页走完

我建议全程使用网线，把电脑连接到路由器的 LAN 口。开始前关闭电脑上的其他网络连接，避免电脑通过 Wi-Fi 或另一块网卡走错路由。刷写过程中保持 USB-C 供电稳定，不要碰电源线。

打开：

```text
http://192.168.10.1
```

第一次登录时，原厂页面会要求创建管理员密码。我这里设置成了 `00000000`，只是为了演示方便；实际使用请设置一个强密码，并在发布截图前自行处理其中的敏感信息。

![原厂首次登录时创建管理员密码的页面](/assets/images/cudy-tr3000/01-create-admin-password.jpg)

设置密码后，系统会进入快速设置引导。我按下面的顺序一路点击“下一步”：

1. 选择模式。
2. 选择时区。
3. 配置 WAN。
4. 配置无线网络。
5. 查看概要。
6. 点击“保存&应用”。

![原厂快速设置中的模式选择页面](/assets/images/cudy-tr3000/02-choose-mode.jpg)

![原厂快速设置中的时区选择页面](/assets/images/cudy-tr3000/03-choose-timezone.jpg)

![原厂快速设置中的 WAN 配置页面](/assets/images/cudy-tr3000/04-configure-wan.jpg)

![原厂快速设置中的无线配置页面](/assets/images/cudy-tr3000/05-configure-wireless.jpg)

![原厂快速设置的概要页面](/assets/images/cudy-tr3000/06-setup-summary.jpg)

完成设置后，进入原厂系统界面。页面底部的浅灰色文字包含版权信息、硬件版本、系统版本、Cudy 官网和售后邮件地址。再进入“系统”，可以看到更完整的系统信息，两处内容能够互相对应。

![原厂系统主页，底部显示硬件版本和系统版本信息](/assets/images/cudy-tr3000/07-cudy-system-page.jpg)

![原厂系统信息页面](/assets/images/cudy-tr3000/08-cudy-system-information.jpg)

## 第一步：刷入签名中间固件

原厂升级入口会检查固件签名。直接把 ImmortalWrt 镜像上传到原厂网页，结果就是报错，这并不奇怪。Cudy 官方提供了一个签名中间固件，先用它绕过原厂网页这一层限制，再从中间系统安装我们真正想用的系统。

我使用的是 Cudy 官方 Google Drive 文件夹中的：

```text
TR3000 256MB Flash V1 (not for TR3000 V1)
```

其中的文件名是：

```text
cudy_tr3000-256mb-v1-sysupgrade.bin
```

官方入口：[Cudy OpenWrt 软件和中间固件下载](https://www.cudy.com/zh-CN/blogs/faq/openwrt-software-download)。页面底部提供了 [Google Drive 中间固件文件夹](https://drive.google.com/drive/folders/1BKVarlwlNxf7uJUtRhuMGUqeCa5KpMnj)，进入 `TR3000 256MB Flash V1 (not for TR3000 V1)` 文件夹后下载对应文件。下载后先把文件保存好，不要等到网页已经打开时才临时寻找。

如果直接上传未签名或不匹配的文件，原厂页面会显示错误。

![原厂网页上传不匹配固件时的报错页面](/assets/images/cudy-tr3000/09-signature-upload-error.jpg)

进入“基本设置”，选择“固件升级”。

![原厂基本设置中的固件升级入口](/assets/images/cudy-tr3000/10-cudy-firmware-upgrade.jpg)

点击上传，选择 `cudy_tr3000-256mb-v1-sysupgrade.bin`。

![原厂网页上传 256 MB 签名中间固件](/assets/images/cudy-tr3000/11-upload-intermediate-firmware.jpg)

点击“继续”后，页面会弹出刷写进度。此时不要关闭页面、拔掉网线或断开电源。

![签名中间固件正在刷写](/assets/images/cudy-tr3000/12-intermediate-flashing.jpg)

刷写完成后，路由器会自动重启。

![签名中间固件刷写完成，路由器正在重启](/assets/images/cudy-tr3000/13-intermediate-rebooting.jpg)

这个过程中指示灯会变红。等到路由器完成重启，指示灯恢复白色，再继续下一步。

## 第二步：进入中间系统

原厂系统的地址是 `192.168.10.1`，中间系统启动后地址变为：

```text
http://192.168.1.1
```

中间系统第一次登录时默认没有密码，直接点击“登录”即可。

![重启后进入中间固件的登录页面](/assets/images/cudy-tr3000/14-intermediate-login.jpg)

登录后可以确认当前系统已经从 Cudy 原厂系统变成了 OpenWrt 中间固件。

![中间固件的系统主页](/assets/images/cudy-tr3000/15-intermediate-system-page.jpg)

这里是一个很容易误判的节点：现在还没有完成 ImmortalWrt 安装，只是完成了从原厂签名系统到 OpenWrt 中间系统的过渡。

## 第三步：刷入 ImmortalWrt 25.12.1

我使用 ImmortalWrt Firmware Selector 的固定地址选择设备：

<https://firmware-selector.immortalwrt.org/?version=25.12.1&target=mediatek%2Ffilogic&id=cudy_tr3000-256mb-v1>

页面中的设备 profile 必须是：

```text
cudy_tr3000-256mb-v1
```

![ImmortalWrt Firmware Selector 中的 256 MB 设备 profile](/assets/images/cudy-tr3000/16-immortalwrt-firmware-selector.jpg)

在下载选项中选择 **SYSUPGRADE**，不要选择下面的 **KERNEL**。我下载到的文件名是：

```text
immortalwrt-25.12.1-mediatek-filogic-cudy_tr3000-256mb-v1-squashfs-sysupgrade.bin
```

回到中间固件管理页面，进入“系统”，选择“备份与升级”。

![中间固件中进入备份与升级的点击顺序](/assets/images/cudy-tr3000/17-openwrt-flash-menu.jpg)

点击最下方的“刷写固件...”，上传刚才下载的 ImmortalWrt `sysupgrade` 文件。

![上传 ImmortalWrt 25.12.1 sysupgrade 固件](/assets/images/cudy-tr3000/18-upload-immortalwrt-firmware.jpg)

上传后取消勾选“保留当前配置”，再点击“继续”。我选择清除旧配置，是因为中间固件和目标系统之间并不存在值得冒险保留的配置兼容性。

![ImmortalWrt 固件正在刷写](/assets/images/cudy-tr3000/19-immortalwrt-flashing.jpg)

刷写时指示灯会变红并闪烁。等到指示灯变白，路由器完成自动重启，就可以重新进入 ImmortalWrt。

![重启后进入 ImmortalWrt 系统界面](/assets/images/cudy-tr3000/20-immortalwrt-system-page.jpg)

## 首次配置和软件包

ImmortalWrt 初次进入时，会询问是否开启“值守式系统升级”。它的含义是让系统自动检查并执行符合条件的系统升级，减少手动维护工作，但自动升级也意味着升级时机和配置变化不再完全由用户控制。

我在演示手动升级，所以选择“否，禁用检查”。如果这是长期运行的设备，请根据自己的备份习惯和风险接受程度决定，不要把“自动”两个字直接等同于“更安全”。

刚刷好的系统功能比较基础，但额外软件可以从 LuCI 图形界面安装。点击顶部“系统”，再进入“软件包”。

![ImmortalWrt 系统菜单中的软件包入口](/assets/images/cudy-tr3000/21-package-menu.jpg)

进入软件包页面后，先点击“更新列表...”，再在左侧“过滤器”中输入软件名，在结果列表中选择安装。

![ImmortalWrt 软件包管理页面](/assets/images/cudy-tr3000/22-package-page.jpg)

这里有一个值得记住的细节：安装和卸载软件包不会直接修改只读系统镜像。系统会在原有镜像上叠加一个 overlay，配置和额外文件通常进入这一层。好处是系统镜像和运行时修改分离，代价是 overlay 空间不是无限的。

## 第四步：申请预装软件的自定义镜像

直接在系统里安装软件已经够用，但我还想记录一次完整的自定义构建流程，于是回到同一个 Firmware Selector 页面，点击“自定义预安装软件包和/或首次启动脚本”。

页面里已经包含一组基础软件包。我保留这些基础包，只在后面追加自己需要的内容。我的校园网使用深澜认证，所以增加了 `bitsrunlogin-go`；为了改善界面，又增加了 Argon 主题：

```text
bitsrunlogin-go luci-app-bitsrunlogin-go luci-i18n-bitsrunlogin-go-zh-cn
luci-theme-argon luci-i18n-argon-config-zh-cn luci-app-argon-config
```

完整的软件包配置如下：

```text
apk-openssl autocore base-files block-mount bridger ca-bundle default-settings-chn dnsmasq-full dropbear firewall4 fitblk fstools kmod-crypto-hw-safexcel kmod-gpio-button-hotplug kmod-leds-gpio kmod-nf-nathelper kmod-nft-offload libc libgcc libustream-openssl logd luci mtd netifd nftables odhcp6c odhcpd-ipv6only ppp ppp-mod-pppoe procd-ujail uboot-envtools uci uclient-fetch urandom-seed urngd wpad-openssl kmod-usb3 kmod-mt7915e kmod-mt7981-firmware mt7981-wo-firmware automount bitsrunlogin-go luci-app-bitsrunlogin-go luci-i18n-bitsrunlogin-go-zh-cn luci-theme-argon luci-i18n-argon-config-zh-cn luci-app-argon-config
```

![ImmortalWrt 自定义预安装软件和首次启动脚本页面](/assets/images/cudy-tr3000/23-custom-build-options.jpg)

我没有自定义首次启动脚本的需求，所以脚本区域保持为空。配置完成后点击“请求构建”。页面会显示请求位于构建队列中。

![ImmortalWrt 自定义镜像请求位于构建队列中](/assets/images/cudy-tr3000/24-build-queued.jpg)

等待构建完成后，页面会出现下载入口。

![ImmortalWrt 自定义镜像构建成功](/assets/images/cudy-tr3000/25-build-succeeded.jpg)

我下载到的文件名类似：

```text
immortalwrt-25.12.1-17179a901f8d-mediatek-filogic-cudy_tr3000-256mb-v1-squashfs-sysupgrade.bin
```

实际文件名应以页面当天生成的结果为准，不要手动猜测或改写中间的构建标识。

## 第五步：刷入自定义镜像

自定义镜像下载完成后，再次进入 ImmortalWrt 的管理页面。系统一般可以通过下面两个地址访问：

```text
http://192.168.1.1
http://immortalwrt.lan
```

先登录管理界面。

![自定义 ImmortalWrt 镜像的登录界面](/assets/images/cudy-tr3000/26-custom-image-login.jpg)

进入系统后确认当前仍然是 ImmortalWrt。

![自定义镜像进入后的系统界面](/assets/images/cudy-tr3000/27-custom-image-system-page.jpg)

按照前面相同的路径进入“系统 → 备份与升级”，上传自定义 `sysupgrade` 文件。

![上传 ImmortalWrt 自定义 sysupgrade 镜像](/assets/images/cudy-tr3000/28-upload-custom-image.jpg)

同样取消勾选“保留设置并继续使用当前配置”，点击“继续”，等待路由器完成重启。这样做的目的仍然是避免把上一套镜像的配置直接带进新的软件包集合。

## 第六步：用 TFTP 恢复 Cudy 官方固件

TFTP 可以理解成一个非常朴素的局域网文件传输方式：路由器启动时主动向电脑请求一个固定名字的文件。它不像网页上传那样由浏览器发起，而是由路由器的 bootloader 在恢复模式中发起请求。

这次恢复使用 Cudy 官方固件，不是把 ImmortalWrt 通过 TFTP 刷回去。根据 [Cudy 官方恢复说明](https://www.cudy.com/zh-cn/blogs/faq/how-to-recovery-the-cudy-router-from-openwrt-firmware-to-cudy-official-firmware)，我使用 Tftpd64 提供恢复文件。

### 准备官方恢复镜像

从 [Cudy TR3000 官方下载页面](https://www.cudy.com/zh-cn/pages/download-center/tr3000-1-0)下载官方固件。本文操作时看到的最新版本是 `2.5.21`，文件名为：

```text
m_upgrade_TR3000_256MB_Flash-R103-2.5.21-20260708-181324-sysupgrade_81571.zip
```

解压后找到 `.bin` 文件，将它重命名为：

```text
recovery.bin
```

我把它放在：

```text
E:\Documents\cudy_tr3000-256mb_v1\official
```

实际路径可以不同，但后面的 Tftpd64 根目录必须指向这个文件所在的目录。

### 配置电脑网卡和防火墙

用网线连接路由器 LAN 口和电脑。在 Windows 网卡 IPv4 设置中手动填写：

| 项目 | 值 |
| --- | --- |
| IP 地址 | `192.168.1.88` |
| 子网掩码 | `255.255.255.0` |
| 默认网关 | 留空 |
| DNS | 留空 |

![Windows 网卡 IPv4 静态地址配置为 192.168.1.88](/assets/images/cudy-tr3000/29-tftp-static-ip.jpg)

为了让 TFTP 请求不被 Windows 拦截，我临时关闭了专用网络和公用网络防火墙。这里只建议在恢复期间短暂关闭，恢复完成后立即重新开启。

![Windows 安全中心中临时关闭专用网络防火墙](/assets/images/cudy-tr3000/30-disable-firewall.jpg)

### 配置 Tftpd64

Tftpd64 可以从 [GitHub Releases](https://github.com/PJO2/tftpd64/releases) 下载。如果使用 Scoop，也可以安装 extras 仓库里的 `tftpd`：

```text
scoop install tftpd
```

打开 Tftpd64 后，设置正确的 Current Directory，也就是包含 `recovery.bin` 的目录，再选择电脑当前使用的 `192.168.1.88` 网卡。

![Tftpd64 的根目录和网卡配置界面](/assets/images/cudy-tr3000/31-tftpd-settings.jpg)

点击“Show Dir”，确认目录列表中确实出现 `recovery.bin`。如果这里看不到文件，先修正目录，不要继续操作路由器。

![Tftpd64 Show Dir 显示 recovery.bin](/assets/images/cudy-tr3000/32-tftpd-show-directory.jpg)

### 触发官方恢复

1. 关闭路由器电源。
2. 按住路由器侧面的 RESET 键不松手。
3. 插入 USB-C 电源。
4. 等待 Tftpd64 界面出现文件传输。
5. 确认开始传输后再松开 RESET 键。

![Tftpd64 正在向路由器传输 recovery.bin](/assets/images/cudy-tr3000/33-tftpd-transfer.jpg)

TFTP 传输完成不代表恢复已经完成。bootloader 还需要校验镜像，并把内容写入 Flash。传输结束后不要断电，等待路由器自动重启。我这次观察到通常在一分钟以内完成重启。

恢复完成后，指示灯常亮红色。把电脑网卡 IPv4 改回自动获取，并重新开启 Windows 专用网络和公用网络防火墙，然后访问：

```text
http://192.168.10.1
```

![恢复完成后进入 Cudy 官方固件页面，版本为 2.5.21](/assets/images/cudy-tr3000/34-official-firmware-page.jpg)

页面底部显示固件版本已经回到 `2.5.21`，这就是我判断官方固件恢复成功的依据。

## 我最后留下的检查点

这次流程没有命令行，也没有改动 bootloader。我的检查点只有几个：

- 标签明确写着 `256 MB 闪存版`。
- 原厂系统地址是 `192.168.10.1`。
- 中间固件启动后地址变成 `192.168.1.1`。
- 中间固件使用 `cudy_tr3000-256mb-v1-sysupgrade.bin`。
- ImmortalWrt Selector 使用 `cudy_tr3000-256mb-v1`。
- 目标镜像选择 `SYSUPGRADE`，不是 `KERNEL`。
- 刷写 ImmortalWrt 时取消保留旧配置。
- TFTP 恢复使用官方 R103 固件，并重命名为 `recovery.bin`。
- TFTP 传输完成后继续等待，不能立即断电。
- 恢复成功后，官方固件页面显示版本 `2.5.21`。

从 2025 年 9 月的第一台，到 2026 年 8 月的第二台，我对这个小路由器的结论没有变：硬件本身并不神秘，真正容易出错的是文件分支和等待时间。选错一次文件，或者在传输完成后过早拔电，都会把一个图形化流程变成维修流程。前者是判断题，后者是耐心题，路由器对此一视同仁。

## 参考资料

1. [Cudy 官方 OpenWrt 软件和中间固件下载说明](https://www.cudy.com/zh-CN/blogs/faq/openwrt-software-download)，256 MB 中间固件下载入口。
2. [Cudy TR3000 官方下载页面](https://www.cudy.com/zh-cn/pages/download-center/tr3000-1-0)，官方固件和恢复镜像。
3. [Cudy 官方从 OpenWrt 恢复官方固件说明](https://www.cudy.com/zh-cn/blogs/faq/how-to-recovery-the-cudy-router-from-openwrt-firmware-to-cudy-official-firmware)，TFTP 恢复流程。
4. [ImmortalWrt Firmware Selector](https://firmware-selector.immortalwrt.org/?version=25.12.1&target=mediatek%2Ffilogic&id=cudy_tr3000-256mb-v1)，选择 `cudy_tr3000-256mb-v1` 和 `SYSUPGRADE` 镜像。
5. [Tftpd64 Releases](https://github.com/PJO2/tftpd64/releases)，Windows TFTP 服务端下载地址。
6. [OpenWrt Wiki：Cudy TR3000](https://openwrt.org/toh/cudy/tr3000)，设备支持背景和原厂恢复风险说明。
