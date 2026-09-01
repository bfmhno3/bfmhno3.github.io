---
title: "别再死记 Linux 目录：从 FHS 到运行时文件系统"
commentId: "post:fhs-of-linux"
published: "2026-04-21 15:00:00 +08:00"
updated: 2026-09-01
description: "从 FHS 的两条分类轴出发，拆开持久文件、内核接口与进程视图，再用 5 组命令串起 usr-merge、XDG、namespace、cgroup、容器和嵌入式文件系统。"
category: Note
tags:
  - Linux
draft: false
comment: true
---

我以前理解 Linux 目录的方法，基本等价于背一张巨大的单词表：`/etc` 放配置，`/var` 放变化的数据，`/usr` 放程序，背到 `/sys`、`/proc` 和 `/run` 时，大脑就开始悄悄交换它们的位置。问题不在记忆力，而在模型错了。这次我换一种办法：先把目录树拆成几类性质完全不同的对象，再用几条命令观察一台正在运行的 Linux。

FHS 3.0 发布于 2015 年 3 月 19 日。到 2026 年，它已经 11 岁了。它仍然是理解 Linux 文件布局的好起点，但它不是现代 Linux 根目录的完整地图，更不是内核接口、容器存储和桌面应用数据的总规范。

## 先建立一个能用的模型

根目录 `/` 看起来是一棵树，树枝却不一定来自同一块磁盘。它更像一张总配线架：Ext4、Btrfs、tmpfs、procfs、sysfs 和设备节点都接入同一个路径空间，我们恰好可以用普通的路径去访问它们。

我把这棵树分成三层：

1. **持久文件的放置约定**：FHS 主要回答软件、配置、日志和用户数据应该放在哪里。
2. **内核与运行时接口**：`/proc`、`/sys`、`/dev`、`/run` 往往由内核或早期用户空间在启动时提供。
3. **进程看到的文件系统视图**：挂载命名空间和容器可以让两个进程看到不同的 `/`，即使它们共享同一个内核。

把这三层混在一起，就会得到一篇目录百科；每一项似乎都对，合起来却没有因果关系。下面逐层拆。

## FHS 到底解决什么问题？

FHS 不是为了让根目录看起来整齐。它要让软件、发行版、管理员和脚本能够预测文件的位置。标准用两条彼此独立的轴来组织数据：

- **静态 (static) / 可变 (variable)**：文件是否会在没有管理员干预时变化。
- **可共享 (shareable) / 不可共享 (unshareable)**：同一份文件能否被多台主机使用。

FHS 3.0 自己给出的例子很干净：

| | 可共享 | 不可共享 |
| --- | --- | --- |
| 静态 | `/usr`、`/opt` | `/etc`、`/boot` |
| 可变 | `/var/mail`、`/var/spool/news` | `/var/run`、`/var/lock` |

这张 `2 x 2` 表是设计原则，不是把每个目录硬塞进一个格子的分类游戏。例如 `/home` 是否跨主机共享取决于部署方式，`/srv` 的内容也由站点自己组织。模型负责解释边界，不负责替现实假装整齐。

静态和可变数据分开后，系统资源可以只读挂载，日志和队列可以采用不同的备份策略；可共享和本机专属数据分开后，多台机器可以复用同一份程序而保留各自配置。这才是目录划分真正带来的工程收益。

## 根目录下的持久世界

FHS 3.0 要求根目录包含 14 个目录或指向它们的符号链接，并在对应子系统存在时再提供 3 个可选目录。没必要逐字背诵，我更愿意沿着文件的生命周期来理解它们。

### `/usr`：发行版提供的静态系统资源

`/usr` 是主要的只读、可共享层。发行版或包管理器提供的大部分程序和静态资源都放在这里。

> [!WARNING] `/usr` 到底是什么缩写？
> 网上经常把 `/usr` 解释为 "Universal System Resources"，但这不是 FHS 给出的官方全称，而是后来流传开的一种解释。FHS 3.0 并没有规定 `/usr` 应该展开成哪几个英文单词，它只定义这个目录的用途。因此，与其记忆一个有争议的全称，不如直接记住它的目录语义：`/usr` 主要保存通常可以只读挂载和跨主机共享的系统资源。

- `/usr/bin`：适合从命令行调用的程序。
- `/usr/lib`：库、包的私有数据，以及不打算让用户直接执行的内部程序。
- `/usr/include`：面向用户空间开发的头文件。
- `/usr/share`：与 CPU 架构无关的数据，例如手册、时区和 locale 数据。
- `/usr/local`：系统管理员在本机安装的软件层，避免与发行版管理的 `/usr` 文件发生冲突。

这里有一个容易踩的坑：`/usr/include/linux` 是提供给用户空间使用的 UAPI 头文件，不应该随手链接到任意内核源码树。编译外部内核模块时，常见入口是 `/lib/modules/$(uname -r)/build`；它通常再指向发行版为当前内核准备的构建目录。用户空间 ABI 和内核模块构建环境是两件事。

### `/etc`：本机配置，而不是程序仓库

`/etc` 保存 host-specific system configuration，也就是本机系统配置。主机名、服务配置、账号数据库和网络策略通常落在这里。

FHS 明确要求 `/etc` 不放二进制程序。现代系统还经常把发行版默认值放在 `/usr`，只把管理员覆盖的配置放在 `/etc`。于是配置的含义变得很清楚：`/usr` 是供应方给出的默认状态，`/etc` 是这台机器做出的决定。

### `/var`：需要跨重启保留的变化

`/var` 保存运行中会变化、而且通常要持久化的数据：

- `/var/log`：日志。
- `/var/lib`：应用持久状态，例如数据库、包管理器状态和 `cloud-init` 实例数据。
- `/var/cache`：可以重新生成的缓存。
- `/var/spool`：等待处理的队列，例如邮件和打印任务。
- `/var/tmp`：预期可以跨重启保留的临时文件。

"会变大" 不是判断 `/var` 的充分条件。配置文件也会变化，但它属于 `/etc`；用户文档也会变化，但它属于用户数据。关键问题是：这是不是系统或服务在运行中产生并需要保留的状态？

### `/run`：只服务于本次启动

`/run` 保存从本次启动开始才有意义的运行时数据，例如 PID 文件、Unix socket、锁和服务的瞬时状态。现代系统通常把它挂载为 `tmpfs`，所以重启后自然消失。早期放在 `/var/run` 和 `/var/lock` 的内容，如今通常通过兼容链接指向 `/run`。

`/run` 与 `/var` 的分界不是 "内存对磁盘"，而是生命周期：

- 重启后仍有意义，放 `/var`。
- 只描述当前这次启动，放 `/run`。

这条规则比死记 "PID 文件放哪里" 有用得多。

### 用户、临时文件与服务数据

- `/home`：普通用户的主目录。程序应通过 `$HOME` 或用户数据库查找它，不要假定一定是 `/home/<name>`。
- `/root`：root 的主目录放在 `/home` 外，使 `/home` 尚未挂载时管理员仍可能登录修复。
- `/tmp`：短生命周期临时文件，可能在启动时或定期清理。多用户环境中必须用 `mkstemp(3)`、`mkdtemp(3)` 等安全接口创建文件。
- `/srv`：本机对外提供的服务数据，例如管理员维护的网站内容。
- `/opt`：附加软件包的独立目录。它仍在 FHS 中，但现代发行版是否使用它取决于打包策略。
- `/boot`：内核、initramfs 和引导加载器需要的静态文件。EFI 系统分区可能挂载在 `/boot`、`/boot/efi` 或 `/efi`，这是发行版和引导方案的选择，不是所有 Linux 都固定为 `/boot/efi`。

## 根目录下的运行时接口

现在转向另一类东西。`/dev`、`/proc` 和 `/sys` 看起来也是目录，但它们主要不是用来 "存放普通文件" 的。

### `/dev`：设备访问入口

`/dev` 中的条目是设备节点。它们把文件描述符这套统一接口连接到内核驱动，但 "一切皆文件" 只是一条有用的近似，不是说设备节点等价于磁盘上的普通文件。

例如，读写块设备、终端和随机数设备的语义完全不同。有些设备主要通过 `read`、`write` 工作，有些依赖 `ioctl`，还有些根本不允许普通用户访问。现代发行版通常由 `devtmpfs` 和 `udev` 动态维护这里的内容。

### `/proc`：进程视图与历史形成的内核接口

`procfs` 最初围绕进程信息设计，因此 `/proc/<pid>` 暴露进程的状态、文件描述符、内存映射和命名空间。后来许多全局内核接口也进入 `/proc`，例如 `/proc/cpuinfo`、`/proc/meminfo` 和 `/proc/sys`。

它不是 "硬盘里恰好有很多零字节文件"。读取这些路径时，内核动态生成内容；写入某些路径时，内核把数据解释为控制请求。

### `/sys`：按内核对象组织的设备模型

`sysfs` 导出内核对象、属性以及对象之间的关系。设备、驱动、总线、类和固件信息因此有了比 `/proc` 更结构化的位置。

几个常见入口：

- `/sys/class`：按设备类别组织的视图，例如网络接口、LED 和 hwmon。
- `/sys/bus`：按总线组织设备与驱动。
- `/sys/devices`：设备拓扑。
- `/sys/firmware/devicetree/base`：设备树系统上，内核展开后的设备树视图。
- `/sys/fs`：cgroup、BPF、pstore 等文件系统或内核子系统的挂载入口。

`sysfs` 属性通常是稳定 ABI 的一部分，但并不意味着所有子目录都适合应用程序随意写入。例如旧的 sysfs GPIO 用户接口已经被内核文档标为废弃，新程序应优先使用 GPIO 字符设备接口。能 `echo 1` 不代表应该永远 `echo 1`，这是 Shell 最容易制造的乐观主义。

## 用 5 条命令观察真实系统

到这里，目录名已经不再是一组定义。我们可以直接问正在运行的系统。

### 1. 这个路径来自什么文件系统？

```bash
findmnt -T /
findmnt -T /proc
findmnt -T /sys
findmnt -T /run
```

关注 `SOURCE`、`FSTYPE` 和 `OPTIONS`。一台常见系统可能分别显示磁盘文件系统、`proc`、`sysfs` 和 `tmpfs`，但容器或不可变发行版会给出不同答案。`findmnt` 的输出比凭目录名猜测可靠。

### 2. `/bin` 还是真目录吗？

```bash
readlink -f /bin
readlink -f /sbin
readlink -f /lib
```

这种布局称为 **usr-merge（`/usr` 合并）**：原本分散在根目录和 `/usr` 下的同类目录被合并到一起，文件统一放进 `/usr/bin`、`/usr/sbin`、`/usr/lib`，再让 `/bin`、`/sbin`、`/lib` 成为指向它们的符号链接。旧程序仍然可以访问 `/bin/ls`，系统实际执行的却与 `/usr/bin/ls` 是同一个文件。

早期系统把 `/bin` 和 `/usr/bin` 分开，是为了在 `/usr` 分区尚未挂载时，仍能依靠根分区里的少量工具启动和修复系统。现代 Linux 通常先进入 initramfs，由它准备存储设备并挂载真正的根文件系统，旧边界的实际价值已经很小。usr-merge 因此不是删除兼容路径，而是用符号链接保留旧接口，同时让发行版只维护一套系统文件。

运行上面的 `readlink` 命令，就能判断当前系统是否采用了这种布局。传统系统中的这些路径仍可能是彼此独立的目录。

### 3. 一个程序实际加载了哪些库？

```bash
ldd /usr/bin/ls
```

输出会暴露动态加载器与架构相关库目录。在 Debian 的 Multiarch 系统上，你可能看到 `/lib/x86_64-linux-gnu`；采用 multilib 的系统则常见 `/lib64`。这是发行版 ABI 布局，不应该被简化成 "64 位系统一律使用 `/lib64`"。

> [!NOTE]
> 不要对不可信的可执行文件运行 `ldd`。部分实现可能执行目标程序。分析未知文件时应使用发行版推荐的静态检查工具。

### 4. 当前进程属于哪些命名空间？

```bash
readlink /proc/self/ns/mnt
readlink /proc/self/ns/net
readlink /proc/self/ns/pid
```

输出类似 `mnt:[4026531832]`。两个进程对应条目的设备号和 inode 相同，才说明它们处在同一个该类型命名空间。方括号里的数字是 namespace inode，不是所谓的 "物理隔离宇宙哈希值"。

### 5. cgroup v2 怎样表达资源边界？

```bash
findmnt -T /sys/fs/cgroup
cat /proc/self/cgroup
```

现代 cgroup v2 通常呈现一棵统一层级。控制器通过 `cpu.max`、`memory.max` 等接口设置限制，进程通过 `cgroup.procs` 加入 cgroup。Docker 和 Kubernetes 会使用这些内核机制，但 `/sys/fs/cgroup` 本身不属于 FHS 的文件放置规则。

## 开发程序时，文件应该落在哪里？

如果我在写一个系统服务，比背目录更实用的是按所有者和生命周期做决定。

FHS 主要安排系统级文件，但桌面和命令行程序还需要保存每个用户自己的配置、数据、缓存和运行状态。过去很多程序直接在 `$HOME` 下创建 `.vim`、`.mozilla`、`.cache-of-something` 等隐藏目录，久而久之，用户主目录就变成了应用程序各自圈地的现场。

**XDG Base Directory 规范**解决的就是这个问题。XDG 是 freedesktop.org 规范体系沿用的历史名称；这里真正需要记住的是 Base Directory：它不强迫所有程序使用几个写死的路径，而是通过一组环境变量，为不同生命周期的数据指定基础目录。程序优先读取环境变量，变量未设置时再使用规范给出的默认值。

例如，主题偏好属于配置，应放进 `$XDG_CONFIG_HOME`；下载后可以重新生成的缩略图属于缓存，应放进 `$XDG_CACHE_HOME`；Unix socket 只在当前登录会话中有效，应放进 `$XDG_RUNTIME_DIR`。这样备份配置时不必带上缓存，退出登录时也不必保留 socket。目录分类最终对应的是数据生命周期，而不是单纯为了让 `$HOME` 看起来漂亮。

| 内容 | 系统级位置 | 用户级默认位置 |
| --- | --- | --- |
| 可执行程序 | 发行版包用 `/usr/bin`，本机安装常用 `/usr/local/bin` | `~/.local/bin` |
| 静态数据 | `/usr/share/<app>` 或 `/usr/local/share/<app>` | `$XDG_DATA_HOME/<app>`，默认 `~/.local/share/<app>` |
| 管理员配置 | `/etc/<app>` | `$XDG_CONFIG_HOME/<app>`，默认 `~/.config/<app>` |
| 持久状态 | `/var/lib/<app>` | `$XDG_STATE_HOME/<app>`，默认 `~/.local/state/<app>` |
| 可重建缓存 | `/var/cache/<app>` | `$XDG_CACHE_HOME/<app>`，默认 `~/.cache/<app>` |
| 本次启动的 socket、PID | `/run/<app>` | `$XDG_RUNTIME_DIR/<app>`，常见于 `/run/user/<uid>` |
| 日志 | `/var/log/<app>` 或日志服务 | 用户状态目录或日志服务 |

XDG Base Directory 规范定义的不是三个固定隐藏目录，而是一组环境变量和回退值。尤其容易漏掉的是 `$XDG_STATE_HOME` 和 `$XDG_RUNTIME_DIR`：前者保存跨重启但不值得当用户数据同步的状态，后者只在登录会话期间有效，权限必须是 `0700`。

如果程序支持命令行参数或环境变量覆盖路径，优先级也应明确。目录规范解决的是默认位置，不应该剥夺管理员部署软件的能力。

## 容器为什么能看到另一棵 `/`？

容器没有发明一套新的 FHS。它组合了几种内核机制：

1. **Mount namespace** 给进程一张独立的挂载表。
2. **OverlayFS** 把只读 lower layer 和可写 upper layer 合并成一个视图。
3. **PID、network、UTS、IPC、user 等 namespace** 隔离其他全局资源。
4. **cgroup** 统计并限制一组进程的资源。

因此，容器里的 `/etc` 仍然表达该容器视图中的配置，`/var` 仍然表达该视图中的可变状态。变化的是目录树背后的挂载来源和可见范围，不是路径语义凭空消失了。

`/proc/<pid>/ns` 只是命名空间对象的句柄。命名空间由 `clone(2)`、`unshare(2)` 或 `setns(2)` 等系统调用创建或加入，不是 Docker "创建了一套文件链接"。文件系统在这里提供观察与引用对象的接口，而不是机制本身。

## 嵌入式系统为什么看起来不太一样？

资源受限设备通常保留 FHS 的大致语义，却会改变底层存储方式。OpenWrt 常见的根文件系统就是一个好例子：只读 SquashFS 作为 lower layer，可写 JFFS2 或 UBIFS 作为 upper layer，再通过 overlay 组合成可写的 `/`。

这解释了两个看似矛盾的现象：用户可以修改 `/etc/config`，恢复出厂设置又能回到固件中的初始状态。修改通常进入可写层，而不是改写只读固件镜像。

原始 NAND 或 NOR Flash 则由 MTD 子系统暴露。`/dev/mtdX` 是字符设备接口，`/dev/mtdblockX` 提供受限的块设备视图。后者并不会凭空提供完整的磨损均衡；需要处理坏块和磨损时，应使用适合原始 Flash 的 UBI/UBIFS 等层。把 `mtdblock` 当成 "内核替我把 Flash 变成普通硬盘"，大概是数据最不希望听到的一句话。

设备树、MTD、OverlayFS 都是 Linux 机制，不属于 FHS。它们出现在同一棵目录树里，是因为 VFS 允许不同文件系统和内核对象共享统一的路径空间。

## 最后保留这张判断表

遇到陌生目录时，我现在依次问 5 个问题：

1. 它是普通持久文件，还是一个挂载出来的运行时接口？
2. 谁拥有它：发行版、管理员、服务、用户，还是内核？
3. 内容是静态资源、配置、持久状态、缓存，还是瞬时状态？
4. 它是否需要跨重启、跨用户或跨主机存在？
5. 当前进程看到的路径，是否受 mount namespace 或 overlay 影响？

这 5 个问题足以推导大多数目录的意义。FHS 提供第一层坐标，XDG 把同样的思想延伸到用户目录，内核伪文件系统暴露运行状态，namespace 和 VFS 再决定某个进程最终看见哪棵树。

再往下走，就不再是 "文件应该放哪里" 的问题了，而是 dentry、inode、mount、superblock 和内核对象如何把不同世界接到同一个 `/` 上。到这里目录表终于变成了一套系统模型，而不是 30 个待背单词。很好，我的大脑可以下班了。

## 参考资料

1. [Filesystem Hierarchy Standard 3.0](https://refspecs.linuxfoundation.org/FHS_3.0/fhs-3.0.html)，FHS 的正式规范与二维分类定义。
2. [UAPI.9 Linux File System Hierarchy](https://uapi-group.org/specifications/specs/linux_file_system_hierarchy/)，面向现代 Linux 的目录布局说明，目前标记为 work in progress。
3. [Linux manual page: hier(7)](https://man7.org/linux/man-pages/man7/hier.7.html)，典型 Linux 目录层次的手册页。
4. [systemd: The Case for the `/usr` Merge](https://systemd.io/THE_CASE_FOR_THE_USR_MERGE/)，usr-merge 的布局、兼容性和历史背景。
5. [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/)，用户配置、数据、状态、缓存与运行时目录规范。
6. [Linux Kernel Documentation: The `/proc` Filesystem](https://docs.kernel.org/filesystems/proc.html)，procfs 的内核文档。
7. [Linux Kernel Documentation: sysfs](https://docs.kernel.org/filesystems/sysfs.html)，sysfs 与内核对象模型。
8. [Linux Kernel Documentation: Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)，cgroup v2 层级、控制器与接口文件。
9. [Linux manual page: namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html)，Linux namespace 类型、系统调用与 `/proc/<pid>/ns` 接口。
10. [Linux Kernel Documentation: Overlay Filesystem](https://docs.kernel.org/filesystems/overlayfs.html)，OverlayFS 的 lower、upper、work 与 merged 视图。
11. [Linux Kernel Documentation: Memory Technology Device](https://docs.kernel.org/driver-api/mtd/index.html)，MTD 子系统与原始 Flash 设备接口。
