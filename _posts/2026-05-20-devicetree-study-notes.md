---
title: "设备树学习笔记：从基础语法到 DTB"
date: 2026-05-20 11:15:00 +08:00
excerpt: "从设备树产生背景讲起，系统梳理 DTS/DTB 语法、compatible/reg/status、中断路由、系统必选节点与 DTB 二进制结构，形成一条从写法到底层实现的完整学习路径。"
categories:
  - Note
tags:
  - Linux
---

## 0. 引言：为什么我们需要设备树？

想象这样一个场景：你的电脑开机，操作系统启动，它需要知道自己运行在什么硬件之上：有几颗 CPU、多大内存、串口在哪里、网卡是什么型号。操作系统如何获取这些信息？

答案是……看情况。

### 0.1 自发现 vs 非自发现总线

现代计算机系统中，总线大致分为两类。

**自发现总线（Self-Discoverable Bus）**：PCIe、USB 这类总线，操作系统可以向总线发送探测请求，插在总线上的设备会主动回答 "我在这里，我是某某设备"。插上一个 USB 键盘，系统立刻就能知道这个键盘的存在及其设备描述符。这是一种**运行时动态发现**机制。

**非自发现总线（Non-Discoverable Bus）**：I2C、SPI、CAN、系统总线（Processor Bus）等则完全不是这样。在这些总线上，CPU 无法主动 "问" 谁连接在上面。它只知道有一组内存映射的寄存器地址，但对于这些地址背后是什么设备、什么型号、如何配置，CPU 一无所知。这些信息必须由**人为提供**。

嵌入式系统大量使用**非自发现总线**。一个典型的 ARM SoC 上，UART、I2C 控制器、GPIO 控制器、定时器都是通过内存映射连接到处理器总线的，没有任何动态发现机制。

### 0.2 历史的教训：Linus 的愤怒

在设备树出现之前，Linux 对这些非自发现硬件的处理方式简单粗暴：**硬编码**。

ARM 架构的 Linux 内核曾经有一个庞大的 `arch/arm/mach-*` 目录，里面为每一款开发板都写了一份 C 代码，直接在内核源码中描述板上有什么设备、基地址是多少、中断号是多少。如果你买了一块新的开发板，就需要在内核里添加一份新的 `board-*.c` 文件。

这导致了几个严重问题：

1. **内核膨胀**：同一份内核镜像无法在多块不同板子上运行。每块板子都需要编译一个专用内核。
2. **代码冗余**：不同板子之间共享同一个 SoC，但因为板上外设组合不同，代码大量重复。
3. **维护灾难**：2011 年左右，Linux 内核邮件列表上 Linus Torvalds 公开表达了强烈的[不满](https://lkml.org/lkml/2011/3/17/492)——ARM 架构的 `mach-*` 目录已经变成一个无法维护的垃圾场。

> Gaah. Guys, this whole ARM thing is a f*cking pain in the ass.

问题的根源在于：**硬件描述信息（数据）被硬编码在了操作系统的核心逻辑（代码）中**。

### 0.3 解决办法：数据与代码的剥离

设备树的本质思想总结为一句话：

> **将硬件的拓扑结构和物理参数从操作系统的核心代码中彻底剥离，以结构化的数据文件形式独立存在。**

在这个模型中：

- **引导程序**（Boot Program）如 U-Boot、树莓派固件、QEMU，负责将设备树二进制文件（DTB）加载到内存，并将其地址传递给内核。
- **内核**（Client Program）在启动时解析这份数据，按图施工：发现设备、匹配驱动、配置寄存器。

这是一种**声明式**（Declarative）的硬件描述方式：你告诉内核 "有什么"，而不是 "怎么做"。内核中的驱动程序则负责 "怎么做"。

这个思想和 Web 前端分离 HTML（结构/数据）与 JavaScript（逻辑）如出一辙，或者类比数据库系统中的 DDL（数据定义）与 DML（数据操作）。

设备树最早来自 Open Firmware（IEEE 1275），用在 PowerPC 和 SPARC 平台上。2005 年，PowerPC Linux 在合并 32 位/64 位支持的清理工作中，将设备树设为强制要求——由此诞生了 "扁平化设备树"（Flattened Device Tree, FDT）格式。此后，FDT 被推广到所有架构。

截至本文写作时，arm、arm64、microblaze、mips、powerpc、sparc、x86、riscv 等主流架构均已支持设备树。

---

## 1. 设备树的基础语法

### 1.1 DTS 源码与 DTB 二进制

设备树有两种形态，二者关系类似 C 语言中 `.c` 源文件与编译后的二进制可执行文件：

| 形态                         | 文件名           | 本质                 | 使用者 |
| ---------------------------- | ---------------- | -------------------- | ------ |
| **DTS** (Device Tree Source) | `.dts` / `.dtsi` | 人类可读的文本源码   | 开发者 |
| **DTB** (Device Tree Blob)   | `.dtb`           | 二进制的扁平化树结构 | 内核   |

DTS 通过**设备树编译器**（DTC, Device Tree Compiler）编译成 DTB。同时，DTC 也支持反编译（`dtc -I dtb -O dts`），方便逆向查看既有 DTB 内容。

`.dts` 文件是设备树源文件，通常一个板子一个。`.dtsi` 文件是**可包含的共用文件**（"i" = include），通常描述一个 SoC 的内部结构，然后被多个板子的 `.dts` 以 `/include/` 指令引用——板级 `.dts` 引用 SoC 级 `.dtsi`，只在末尾补充板上特有的外设。

### 1.2 节点（Node）与路径

设备树是一个**树形数据结构**。每个节点描述一个设备或一个总线，节点可以包含属性和子节点。

#### 节点命名规则

```c
node-name@unit-address
```

- `node-name`：1-31 个字符，只能使用数字、大小写字母和 `,._+-`，必须以字母开头。推荐使用描述设备**类别**的通用名称，而非具体型号——例如用 `serial` 而不是 `ns16550`，用 `ethernet` 而不是 `rtl8139`。这种"重类别、轻型号"的命名哲学让设备树在不同硬件平台间保持可读性。
- `@unit-address`：可选的单元地址，必须与 `reg` 属性中的第一个地址值匹配。如果节点没有 `reg` 属性，则必须省略 `@unit-address`。

为什么单元地址必须和 `reg` 首地址一致？因为 DTC 编译器会校验这种一致性，确保设备树的自我完整性——你在节点名中承诺的物理地址，必须和寄存器基地址真正对上，否则树结构本身就是错的。

举例：

```c
cpu@0          —— 0 号 CPU
serial@4600    —— 基地址 0x4600 的串口
i2c@7000c000   —— 基地址 0x7000c000 的 I2C 控制器
```

#### 树状层级与绝对路径

每个节点在树中有唯一路径，从根节点 `/` 开始：

```c
/cpus/cpu@0
/soc/serial@4600
/soc/i2c@7000c000/codec@1a
```

这种层级镜像了硬件的物理拓扑：芯片内部总线（SoC）下挂载着各种外设控制器，而 I2C 控制器下面又挂着连接在 I2C 总线上的设备（如音频编解码器）。

### 1.3 属性（Property）：数据的载体

每个节点由若干属性定义。属性是键值对结构。

DTSpec 定义了以下几种基本的属性值类型：

**〈空值〉（Empty）**：属性的存在本身就是一个布尔信号。例如 `interrupt-controller;` 表示不需要任何值，有这个属性就代表"我是中断控制器"。

**〈u32〉（32 位整数）**：大端序存储的 32 位无符号整数，在 DTS 源码中用尖括号包裹，例如：

```c
clock-frequency = <825000000>;
```

DTS 支持在尖括号内使用 C 风格的算术、位运算和三元表达式：

```c
reg = <(0x1000 + 0x200) 0x100>;
```

**〈u64〉（64 位整数）**：用两个 `<u32>` 表示，高 32 位在前，例如：

```c
clock-frequency = <0x00000001 0x00000000>;
```

这表示的是 64 位值 `0x100000000`：第一个 cell 是高 32 位（`0x00000001`），第二个是低 32 位（`0x00000000`）。

**〈string〉（字符串）**：双引号包裹，以 null 结尾，例如：

```c
compatible = "ns16550";
```

**〈stringlist〉（字符串列表）**：多个字符串拼接，例如：

```c
compatible = "fsl,mpc8641", "ns16550";
```

**〈phandle〉（节点引用）**：一个 `<u32>` 值，指向树中另一个节点。DTC 在编译时自动为有标签的节点分配唯一的 phandle 值。

**〈prop-encoded-array〉（自定义编码数组）**：格式取决于具体属性定义，最常见的就是 `reg` 中的（地址, 长度）对。

### 1.4 语法糖：标签与引用

如果每次都要写 `/soc/i2c@7000c000/codec@1a` 这样的绝对路径来引用一个节点，代码会变得难以阅读。DTS 提供了两个机制来解决这个问题。

**标签（Label）**：在节点或属性前加 `标签名:` 定义，例如：

```c
wm8903: codec@1a {
    compatible = "wlf,wm8903";
    reg = <0x1a>;
};
```

**引用（Reference）**：`&标签名` 引用已定义的节点，例如：

```c
sound {
    compatible = "nvidia,harmony-sound";
    i2s-controller = <&i2s1>;
    i2s-codec = <&wm8903>;   /* 引用上面的 codec 节点 */
};
```

在 DTC 编译时，`&wm8903` 会被展开为该节点的 phandle 值，存入 DTB。

引用语法还有一个常见用法：**引用覆盖**。在板级 `.dts` 中，你可以这样激活或修改 SoC 级 `.dtsi` 中已定义的外设：

```c
/* 在 SoC .dtsi 中，外设默认 disabled */
&uart1 {
    status = "disabled";
};

/* 板级 .dts 中，将它启用 */
&uart1 {
    status = "okay";
};
```

这种 "先定义、后覆盖" 的模式是设备树实际工程中的核心工作流。

---

## 2. 描述硬件的三大核心维度

如果设备树是一份硬件档案，那么描述一个设备至少需要回答三个问题：**你是谁、你在哪里、你还活着吗**。

### 2.1 身份认同：`compatible` 和 `model`

**`compatible`** 是设备树中最重要的属性。它定义了一个设备的 "编程模型"，也就是软件（驱动）应该用哪种接口协议来操作这个硬件。

```c
compatible = "manufacturer,model";
```

格式严格规定为 `<制造商>,<型号>`，全小写，不用下划线。例如：

```c
compatible = "arm,cortex-a72";
compatible = "nvidia,tegra20-uart";
compatible = "wlf,wm8903";        /* Wolfson 的 WM8903 音频编解码器 */
```

**多重兼容性策略**：`compatible` 的值是一个从**最特化**到**最泛化**的字符串列表。内核会按顺序逐一尝试匹配驱动：

```c
compatible = "fsl,mpc8641", "ns16550";
```

这条配置告诉内核：优先找 Freescale MPC8641 专用驱动；如果没找到，就退而求其次，用通用的 NS16550 UART 驱动。这种"回退"（fallback）策略让同一套内核可以在范围极大的硬件上运行。

**`model`** 是一个人类可读的字符串，描述设备的制造商型号：

```c
model = "fsl,MPC8349EMITX";
```

`model` 和 `compatible` 的核心区别在于使用者不同：`model` 是给人（开发者、调试者）看的，`compatible` 是给内核的设备匹配算法用的。也就是说，`model` 可以由开发者自己确定，随意编写，而 `compatible` 则应该遵循一定的规范。

那 `compatible` 字符串从哪里来？`<制造商>,<型号>` 中的每一对合法取值，都有对应的绑定文档（Binding Document）加以规范。Linux 内核源码树的 `Documentation/devicetree/bindings/` 目录就是这份 "字典"：按设备类别分子目录（`serial/`、`i2c/`、`gpio/` 等），每个 `.yaml` 文件精确声明该设备支持哪些 `compatible` 字符串、哪些属性是必须的、哪些属性是可选的、各属性的合法取值范围。

为设备挑选 `compatible` 字符串的正确方式是：先查 `Documentation/devicetree/bindings/` 找到对应 binding，再照着 binding 填写，而不是凭经验猜测或照抄其他设备树。

### 2.2 寻址空间：`reg`、`#address-cells` 与 `#size-cells`

这三个属性构成了设备树寻址系统的核心。

`#address-cells` 和 `#size-cells 由**父节点**定义，告诉子节点：描述一个地址需要几个 32 位 cell，描述一个长度需要几个 cell。

这里的 cell 是设备树规范继承自 Open Firmware 的基本数据单元，固定为一个 **32 位无符号整数**。当硬件的地址或长度超过 32 位时，就用多个连续的 cell 拼接：两个 cell 拼接成 64 位，高位在前。

因此，`#address-cells = <2>` 意味着子节点的地址用两个 32 位整数（合计 64 位）来描述，`#address-cells = <1>` 则是单个 32 位整数就够了。

**这两个属性不会被继承，每个有子节点的节点必须自己显式定义**。

**`reg`** 属性描述设备的寄存器资源，格式为 `<地址 长度>` 对：

```c
soc {
    #address-cells = <1>;
    #size-cells = <1>;

    serial@4600 {
        compatible = "ns16550";
        reg = <0x4600 0x100>;   /* 地址 0x4600，长度 0x100 */
    };
};
```

当 `#size-cells = <0>` 时，`reg` 中只有地址没有长度，这是带独立片选信号的设备（如 I2C 从设备）的常见情况：

```c
i2c@7000c000 {
    #address-cells = <1>;
    #size-cells = <0>;

    codec@1a {
        compatible = "wlf,wm8903";
        reg = <0x1a>;   /* 只有 I2C 从机地址，没有长度 */
    };
};
```

一个设备有多个寄存器块时，`reg` 可以包含多组 `<地址 长度>` 对：

```c
reg = <0x3000 0x20 0xFE00 0x100>;
/*    第一块：offset 0x3000, 长 32 字节
      第二块：offset 0xFE00, 长 256 字节    */
```

#### 进阶：地址映射与 DMA

**`ranges` 属性**：实现父子总线之间的地址翻译。它定义一个 "映射范围"：子总线地址空间的 X，对应父总线地址空间的 Y，长度 Z。

```c
soc {
    compatible = "simple-bus";
    #address-cells = <1>;
    #size-cells = <1>;
    ranges = <0x0 0xe0000000 0x00100000>;
    /* 子地址 0x0 映射到父地址 0xe0000000，范围 1MB */

    serial@4600 {
        reg = <0x4600 0x100>;
        /* 实际物理地址 = 父地址 0xe0000000 + offset 0x4600 = 0xe0004600 */
    };
};
```

当 `ranges` 为空值时，即 `ranges;`，意味着父子地址空间完全一致，不需要任何平移。

`dma-ranges`：与 `ranges` 类似，但从 DMA 设备的视角描述，解决的是 "DMA 控制器看到的地址" 和 "CPU 看到的物理地址" 之间的差异（例如 IOMMU 的存在会制造这种差异）。

`virtual-reg`：当引导程序已经设置了虚拟地址映射时，告知内核虚拟地址到物理地址的转换关系。

<div class="notice--info" markdown="1">
`reg` 和 `ranges` 是设备树中最容易被误解的概念。简单记忆法则：

- `reg` = "我的寄存器在**我所在总线地址空间**的什么位置"
- `ranges` = "**我的总线地址空间**如何映射到**我父亲的总线地址空间**"
- 最终 CPU 看到的物理地址 = 层层 ranges 翻译之和
</div>

### 2.3 运行状态：`status`

`status` 属性标记设备当前的操作状态：

| 值           | 含义                                                     |
| ------------ | -------------------------------------------------------- |
| `"okay"`     | 设备正常工作                                             |
| `"disabled"` | 设备当前不可用，但可能在未来可用（如模块未插入）         |
| `"reserved"` | 设备可用，但不应被本操作系统使用（被固件或其他 OS 控制） |
| `"fail"`     | 设备出现严重错误，不可能恢复                             |
| `"fail-sss"` | 同上，`sss` 为设备特定的错误码                           |

省略 `status` 属性等同于 `status = "okay"`。

在实际工程中最常见的场景是：SoC 级 `.dtsi` 中所有外设默认 `status = "disabled"`，板级 `.dts` 中只启用实际使用的外设——设置为 `status = "okay"`。

---

## 3. 硬件中断的逻辑连线

中断描述是设备树最难理解的部分之一，因为**中断在硬件上的信号流向和在设备树上的描述路径，经常与设备物理层级不同**。

举个典型例子：一颗 I2C 触摸屏控制器挂在 I2C 总线上，所以它在设备树里的物理路径通常是 `soc` -> `i2c` -> `touchscreen`；但它的中断线并不回到 I2C 控制器，而是接到 GPIO 控制器的某个引脚，再由 GPIO 控制器上报给 GIC。于是它的中断路径变成 `touchscreen` -> `gpio-controller` -> `gic`。

这就是 “设备物理层级” 和 “中断描述路径” 不一致的真实场景：你在设备树里看到它在 I2C 下，但它的中断信号却是走的 GPIO/GIC 这条逻辑链路。

### 3.1 中断树：跳出物理层级的逻辑结构

设备树采用**中断树**（Interrupt Tree）模型来表达中断路由。虽然叫做 "树"，但它更准确的描述是一个**有向无环图**（Directed Acyclic Graph）。

```c
Device Tree 层级:             Interrupt Tree 层级:

soc                             open-pic (根)
├── device1 ------------------> (直接连接)
├── pci-host -----------------> (nexus 节点, 中转)
│   ├── slot0 ----------------> (经 pci-host 中转)
│   └── slot1 ----------------> (经 pci-host 中转)
└── gpioctrl -----------------> (nexus 节点, 中转)
    └── device3 --------------> (经 gpioctrl 中转)
```

关键思想：中断信号在硬件上跨越多层物理总线，设备树通过在逻辑上建立直接的中断父子关系来"压平"这个复杂性。

### 3.2 中断信号的属性

**中断产生者（Interrupt-Generating Device）**使用两个核心属性：

```c
device1 {
    interrupts = <0xA 8>;              /* 该设备产生的中断规格（specifier） */
    interrupt-parent = <&open-pic>;     /* 中断发往哪个控制器 */
};
```

`interrupts` 的值格式由目标中断控制器定义的 bindings 决定——对一个 Open PIC 兼容的中断域，两个 cells 分别表示中断号和电平/敏感度信息。

如果设备没有显式的 `interrupt-parent`，中断父节点就**默认向上继承**——沿着设备树向上找，使用第一个声明的中断父节点。所以当中断父节点在 SoC 级别统一指定时，设备可以不写 `interrupt-parent`：

```c
soc {
    interrupt-parent = <&intc>;   /* 所有子设备统一的中断父节点 */

    serial@70006300 {
        interrupts = <122>;       /* 不需要重复 interrupt-parent */
    };
};
```

**`interrupts-extended`** 用于一个设备连接到多个中断控制器的情况：

```c
interrupts-extended = <&pic 0xA 8>, <&gic 0xda>;
```

`interrupts` 和 `interrupts-extended` 互斥。当两者共存时，`interrupts-extended` 优先。

### 3.3 中断控制器

一个节点要成为中断控制器，需要两个属性：

```c
open-pic {
    interrupt-controller;           /* 标记：我是中断控制器（空值属性） */
    #interrupt-cells = <2>;         /* 每个中断 specifier 占几个 cell */
};
```

`#interrupt-cells` 定义了中断规格的"宽度"。对于 Open PIC 这种需要 2 cells（中断号 + 电平/敏感度）的控制器，值就是 `<2>`。对于 ARM GIC (Generic Interrupt Controller)，可能是 `<3>`（中断类型 + 中断号 + 触发类型）。

中断树的根是遍历中断父链直到找到一个**没有 `interrupts` 属性**的中断控制器——这意味着它本身不向更高的控制器报告中断。

### 3.4 中继：Nexus 节点与中断映射

当不同中断域之间需要翻译时（比如 PCI 的 INTA/INTB/INTC/INTD 经过 PCI host bridge 转换到系统中断号），需要一个**nexus 节点**，通过 `interrupt-map` 来做这个翻译。

一条映射表行包含五个部分：

```c
interrupt-map = <
    child-unit-address  child-interrupt-specifier
    interrupt-parent-phandle
    parent-unit-address  parent-interrupt-specifier
>;
```

例如，PCI slot 1 的 INTA（INT #1）映射到 Open PIC 控制器的中断源 2：

```c
interrupt-map = <
    0x8800 0 0  1  &open-pic   2 1
>;
```

`interrupt-map-mask` 在匹配前被 AND 到输入上，作用是屏蔽掉不需要参与匹配的位（如 PCI 总线的 function number 可能不区分）。

### 3.5 GPIO 等非中断信号的通用映射机制

DTSpec 将 nexus 映射机制推广到了所有类型的 "规格（specifier）"：`<specifier>-map`、`<specifier>-map-mask`、`<specifier>-map-pass-thru` 以及 `#<specifier>-cells`。

最常见的例子是 **GPIO 映射**：一个连接器（connector）上的 GPIO 通过 `gpio-map` 路由到 SoC 内部的某个 GPIO 控制器：

```c
connector {
    #gpio-cells = <2>;
    gpio-map = <0 0 &soc_gpio1 1 0>,
               <1 0 &soc_gpio2 4 0>,
               <2 0 &soc_gpio1 3 0>,
               <3 0 &soc_gpio2 2 0>;
    gpio-map-mask = <0xf 0x0>;
    gpio-map-pass-thru = <0x0 0x1>;
};
```

`gpio-map-pass-thru` 的巧妙之处在于允许子 specifier 中的 flags 字段（如 `GPIO_ACTIVE_LOW`）穿越映射表，直接透传到父域，避免映射表需要为每种 flag 组合都写一行。

理解设备树中断子系统的最佳思路：中断信号的路径是一张**独立于设备物理层级的有向图**。遍历从 `interrupts`/`interrupt-parent` 开始，沿链上溯，直到中断树根（没有 `interrupts` 的中断控制器）。每一层可能是中断控制器或 nexus 节点——nexus 节点通过 `interrupt-map` 表提供域间翻译。这一整套设计的目的在于允许同一个设备树描述中的任何节点都能够表达自己的中断路由，机制统一且可扩展。
{: .notice--info}

---

## 4. 拼装一台计算机：系统骨架与必选节点

设备树不只是描述外设。一套完整的设备树必须描述整个系统的骨架 —— CPU 几核、内存多大、控制台在哪。

### 4.1 根节点 `/`

根节点没有名字，用 `/` 表示。它的核心属性包括：

```c
/ {
    model = "fsl,mpc8572ds";
    compatible = "fsl,mpc8572ds";
    #address-cells = <1>;
    #size-cells = <1>;
    serial-number = "PZ123456";      /* 可选：序列号 */
    chassis-type = "embedded";       /* 可选：机箱类型 */
};
```

根节点的 `#address-cells` 和 `#size-cells` 定义了内存地址的编码规则，影响 `/memory` 节点的 `reg` 格式。

`chassis-type` 可取 `"desktop"`、`"laptop"`、`"convertible"`、`"server"`、`"tablet"`、`"handset"`、`"embedded"` 等值。

### 4.2 大脑：`/cpus`

`/cpus` 节点是所有 CPU 节点的容器：

```c
cpus {
    #address-cells = <1>;
    #size-cells = <0>;

    cpu@0 {
        device_type = "cpu";
        reg = <0>;
        clock-frequency = <825000000>;      /* 825 MHz */
        timebase-frequency = <82500000>;    /* 82.5 MHz 时基 */
    };

    cpu@1 {
        device_type = "cpu";
        reg = <1>;
        clock-frequency = <825000000>;
    };
};
```

多核 SMP 系统中，`status` 属性标记每颗 CPU 的运行状态：

- `"okay"`：该 CPU 正常运行
- `"disabled"`：该 CPU 处于**静止状态**（quiescent state），可通过特定方法唤醒
- `"fail"`：该 CPU 不可用或不存在

对于 `disabled` 的 CPU，需要 `enable-method` 属性指定唤醒方式。最常见的是 `"spin-table"`：CPU 在指定物理地址（`cpu-release-addr`）上自旋等待，直到引导 CPU 写入释放信号。

#### 缓存层级

CPU 的缓存层级通过 `next-level-cache` 属性和 phandle 引用串联：

```c
cpu@0 {
    next-level-cache = <&L2_0>;
    L2_0: l2-cache {
        compatible = "cache";
        cache-level = <2>;
        cache-size = <0x40000>;   /* 256 KB */
        next-level-cache = <&L3>;
    };
};
```

这种基于 phandle 的多级缓存描述方式让缓存拓扑可以灵活表达各种共享结构（两核共享 L2、全芯片共享 L3 等）。

### 4.3 物理记忆：`/memory` 和 `/reserved-memory`

**`/memory` 节点**宣告系统的可用物理 RAM。这是每个设备树必须具备的节点之一——所有设备树都必须有 `/cpus` 和至少一个 `/memory` 节点。

```c
memory@0 {
    device_type = "memory";
    reg = <0x00000000 0x80000000>;   /* 0x0 起 2 GB */
};
```

对于 64 位系统（`#address-cells = <2>`, `#size-cells = <2>`）：

```c
memory@0 {
    device_type = "memory";
    reg = <0x00000000 0x00000000  0x00000000 0x80000000>;  /* 低 2GB */
};
memory@100000000 {
    device_type = "memory";
    reg = <0x00000001 0x00000000  0x00000001 0x00000000>;  /* 高 4GB */
};
```

**`/reserved-memory` 节点**划定**不可被内核随意使用的内存禁区**：

```c
reserved-memory {
    #address-cells = <1>;
    #size-cells = <1>;
    ranges;

    display_reserved: framebuffer@78000000 {
        reg = <0x78000000 0x800000>;          /* 8 MB 静态预留 */
    };

    linux,cma {
        compatible = "shared-dma-pool";
        reusable;
        size = <0x4000000>;                    /* 64 MB 动态分配 */
        alignment = <0x2000>;                  /* 8 KB 对齐 */
    };
};
```

- **`no-map`**：操作系统**禁止**为这段区域创建虚拟映射——用于安全隔离（如 TEE/安全飞地）。
- **`reusable`**：系统可临时将这片内存挪作他用（如页面缓存），但当设备驱动需要时，能将其要回来。
- `no-map` 和 `reusable` 是互斥的。

设备通过 `memory-region` 属性引用专属内存：

```c
fb0: video@12300000 {
    memory-region = <&display_reserved>;
};
```

关于与 UEFI 的协作：当通过 UEFI 启动时，`/memory` 和静态 `/reserved-memory` 的内容也必须在 UEFI 内存映射表中体现：带 `no-map` 的区域标记为 `EfiReservedMemoryType`，其他区域标记为 `EfiBootServicesData`。动态预留区域则不应在 UEFI 内存映射表中列出——它们在固件退出后才由操作系统分配。

### 4.4 运行时通道：`/chosen` 和 `/aliases`

**`/chosen`** 节点不代表任何物理设备。它是引导程序向内核传递**运行时配置**的通道：

```c
chosen {
    bootargs = "console=ttyS0,115200 root=/dev/mmcblk0p2 rw";
    stdout-path = "/soc/serial@70006300:115200";
};
```

`bootargs` 就是内核命令行参数，`stdout-path` 指定启动控制台的输出设备。

**`/aliases`** 为冗长的路径起短名：

```c
aliases {
    serial0 = "/soc/serial@70006300";
    ethernet0 = "/soc/ethernet@31c000";
};
```

内核中的 `of_alias_get_id()` 等函数使用这些别名定位设备或标准化设备编号（如 `/dev/ttyS0` 对应 `serial0`）。

### 4.5 典型设备绑定

#### 4.5.1 不可探测的系统总线：`simple-bus`

`compatible = "simple-bus"` 是设备树中的一个重要特殊值。它描述一类最简单的总线：**内存映射、不可探测、子设备的寄存器直接在 CPU 地址空间可见**。

SoC 内部总线通常就是 `simple-bus`。当内核看到 `simple-bus` 兼容的节点时，会自动遍历其子节点并注册 platform_device：

```c
soc {
    compatible = "simple-bus";
    #address-cells = <1>;
    #size-cells = <1>;
    ranges;

    /* 子节点自动被创建为 platform_device */
};
```

#### 4.5.2 串口：以 NS16550 为例

```c
serial@70006300 {
    compatible = "nvidia,tegra20-uart", "ns16550";
    reg = <0x70006300 0x100>;
    clock-frequency = <408000000>;
    interrupts = <122>;
};
```

`clock-frequency` 是 UART 波特率发生器所需的时钟频率——内核 UART 驱动用这个值计算正确的分频系数。

#### 4.5.3 网络：以太网

```c
ethernet@31c000 {
    compatible = "nvidia,tegra20-ehci";
    reg = <0x31c000 0x100>;
    interrupts = <0x6d>;
    local-mac-address = [00 11 22 33 44 55];
    phy-connection-type = "rgmii";
};
```

`local-mac-address` 是 6 字节的 MAC 地址，用方括号格式的字节串表示。`phy-connection-type` 指定 PHY 和 MAC 之间的总线类型（RGMII、RMII、MII 等）——这决定了内核如何配置 MAC 侧的时序和管脚。

---

## 5. 庖丁解牛：DTB 二进制格式的底层设计

虽然大部分开发者只接触 DTS 源码，但理解 DTB 的二进制结构有助于理解设备树的**设计哲学**——为什么某些奇怪的限制存在。

### 5.1 扁平化的哲学：为什么没有 C 风格的指针？

DTSpec 规范开篇第一句就点明了关键前提：

> A boot program loads a devicetree into a client program's memory and passes a pointer to the devicetree to the client.

在这个时刻，MMU（内存管理单元）可能还没开启，虚拟地址的概念不存在。DTB 必须是一块**可以被任意复制、重定位到任意物理地址**的数据块。

如果 DTB 内部使用 C 指针——那在重定位后就全是悬垂指针了。因此 DTB 设计为**完全自包含、位置无关**的格式：所有的跨区块引用都用偏移量而非指针表达。

这就是"扁平化"（Flattened）的核心含义——一个可以平移到任意内存位置、无需解析指针就能直接读取的数据结构。

### 5.2 DTB 的四大内存区块

一个 DTB 文件由四个连续的内存区块组成：

```c
┌───────────────────────┐  ← 低地址
│  Header (头部)         │  40 字节 (10 × uint32_t)
├───────────────────────┤
│  Memory Reservation    │  预留内存列表
│  Block                 │
├───────────────────────┤
│  Structure Block       │  树的线性 Token 序列
│  (FDT_BEGIN_NODE 等)  │
├───────────────────────┤
│  Free Space (可选)     │
├───────────────────────┤
│  Strings Block         │  属性名字符串池
└───────────────────────┘  ← 高地址
```

#### 5.2.1 Header（头部）：设备的身份证

Header 是 40 字节的固定结构，所有字段都是大端 32 位整数：

```c
struct fdt_header {
    uint32_t magic;              /* 0xd00dfeed — 魔数 */
    uint32_t totalsize;          /* DTB 总大小 */
    uint32_t off_dt_struct;      /* Structure Block 偏移 */
    uint32_t off_dt_strings;     /* Strings Block 偏移 */
    uint32_t off_mem_rsvmap;     /* 内存预留块偏移 */
    uint32_t version;            /* 格式版本 (当前为 17) */
    uint32_t last_comp_version;  /* 向后兼容的最低版本 (16) */
    uint32_t boot_cpuid_phys;    /* 引导 CPU 的物理 ID */
    uint32_t size_dt_strings;    /* Strings Block 大小 */
    uint32_t size_dt_struct;     /* Structure Block 大小 */
};
```

几个关键字段：

- **`magic = 0xd00dfeed`**：这个魔数的英文读音就是 "dude feed" —— 是 Open Firmware 工作组留下的一个幽默彩蛋。内核通过比对它来确认"这确实是一个 DTB"。
- **`version = 17`**：当前 DTSpec 标准格式版本。向后兼容的最低版本是 16。
- **`totalsize`**：涵盖所有区块及之间的空格，但不包含 DTB 前后的额外内存。这个字段让解析器提前知道数据边界。
- **`boot_cpuid_phys`**：必须与 `/cpus` 中对应 CPU 节点的 `reg` 值一致。内核通过它确定哪个 CPU 是引导 CPU。

#### 5.2.2 Memory Reservation Block：硬核预留

内核初始化过程的脆弱时刻——代码在未成熟的地址空间中一步步构建完整的虚拟地址系统——必须确保引导程序的关键内存不被覆写。Memory Reservation Block 就是为此而建立的"禁止访问"清单。

```c
struct fdt_reserve_entry {
    uint64_t address;
    uint64_t size;
};
```

每个条目描述一段（物理地址, 大小）的保留区域。列表以 `(0, 0)` 条目终止。这比 `/reserved-memory` 节点更底层——在内核还没解析设备树结构之前，引导程序就已确认这些区域不能被触碰。

#### 5.2.3 Structure Block：用 Token 线性展开的树

这是 DTB 最核心的部分——如何将一个树状结构编码为平直化的字节序列？

结构区块由 5 种 Token 组成，每个 Token 是 32 位大端整数：

| Token            | 值           | 含义                                           |
| ---------------- | ------------ | ---------------------------------------------- |
| `FDT_BEGIN_NODE` | `0x00000001` | 节点开始，后跟节点名（null-terminated string） |
| `FDT_END_NODE`   | `0x00000002` | 节点结束                                       |
| `FDT_PROP`       | `0x00000003` | 属性，后跟 len + nameoff + 值                  |
| `FDT_NOP`        | `0x00000004` | 空操作（用于覆盖已删除的节点/属性）            |
| `FDT_END`        | `0x00000009` | 结构区块结束标记                               |

**`FDT_PROP` 的编码**：

```c
struct {
    uint32_t len;       /* 属性值的字节长度 */
    uint32_t nameoff;   /* 属性名字在 Strings Block 中的偏移量 */
};
/* 后跟 len 字节的属性值，然后 0 填充至 4 字节对齐 */
```

**树的线性化编码**：

```c
FDT_BEGIN_NODE  "/"
  FDT_PROP        属性1
  FDT_PROP        属性2
  FDT_BEGIN_NODE  "soc"
    FDT_PROP      属性
  FDT_END_NODE
FDT_END_NODE
FDT_END           全局结束
```

这种结构的巧妙处：

- 前端解析器从头到尾扫描，遇到 `FDT_BEGIN_NODE` 就是"进入子节点"，遇到 `FDT_END_NODE` 就是"回到父节点"——一个栈结构自然处理整个解析。
- 通过 `FDT_NOP`（覆盖被删除块的开头），DTB 可以在不移动其他数据的情况下"删除"节点或属性——这在 DT overlay 和运行时修改的场景中非常重要。
- 属性名通过偏移量引用 Strings Block，同一个名字字符串被全局共享——这正是下一节要讲的极致压缩策略。

#### 5.2.4 Strings Block：极致压缩的字符串复用池

设备树里有大量相同的属性名——"compatible" 可能出现上百次，"reg" 可能出现几百次。Strings Block 通过**所有属性名统一存储**，只保存一份字符串，然后用偏移量引用来实现极致的空间压缩。

本质上，这就是一个以 null 字节分隔的字符串列表。查找过程：取 `nameoff` 值 → 跳到 Strings Block 开始处 + nameoff 的位置 → 读到 null 为止。这个简单的设计让 20 KB 的 DTS 编译后可能只有 5 KB 的 DTB。

### 5.3 内存对齐：使用 32 位单元但以 8 字节整体看待

DTB 的每一处对齐都有其物理上的现实原因：

- **Structure Block** 按要求 4 字节对齐——每个 Token 是 `uint32_t`
- **Memory Reservation Block** 8 字节对齐——条目是 `uint64_t` 对
- **整个 DTB** 按 8 字节对齐加载——这是所有子块对齐要求的最大公约数

这个 8 字节整体对齐要求意味着引导程序从任何可以 8 字节对齐的地址上加载的 DTB 都能确保在不做额外内存搬运的情况下，被内核安全地按 4 或 8 字节访问。

DTB 的设计体现的是嵌入式引导阶段的现实约束：无 MMU、无动态分配、物理内存可能非连续、引导程序的内存在"交接时刻"不可以被覆盖。那些看似奇怪的限制——没有指针只有偏移量、所有数据平坦排列、必须整体 8 字节对齐——全都是从这个唯一约束推导出来的：**在 MMU 开启前，内核必须安全地解析一个可以被任意重定位的硬件描述块**。
{: .notice--info}

---

## 结语

设备树，归根结底，是一份交给操作系统的"施工图纸"。引导程序拿着蓝图说："这就是这个机器的样子。"操作系统回答说："好的，我知道该怎么做了。"

## 参考资料

1. [Linux Kernel Documentation: Devicetree Usage Model](https://docs.kernel.org/devicetree/usage-model.html)
2. [DeviceTree Specification（devicetree-org）](https://github.com/devicetree-org/devicetree-specification)
