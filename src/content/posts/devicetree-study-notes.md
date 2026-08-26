---
title: "设备树入门：从第一份 DTS 到 Linux 驱动匹配"
published: "2026-05-20 11:15:00 +08:00"
description: "我从一份可编译的最小 DTS 开始，走完 DTS、DTB、boot program 到 Linux 驱动匹配的链路，再用真实工具和内核调试路径验证设备树。"
category: Note
tags:
  - Linux
  - Device Tree
  - Embedded
draft: false
comment: true
---

我以前把设备树当成一堆需要背下来的属性名：`compatible`、`reg`、`interrupts`，还有几个看起来像预处理器产物的 `#*-cells`。后来我决定只做一件事：写一份足够小的 DTS，把它编译成 DTB，再从 Linux 看到它实际收到的内容。设备树一下从名词表变成了一条可以跑通的交接链路。

本文不绑定具体开发板。我们会用一个虚构但自洽的 SoC 和 UART 做实验，所以这份 DTB 不会神奇地让你的电脑多出一个串口（遗憾，但也算避免了一次售后事故）。

## 设备树到底解决什么问题？

PCI 和 USB 这类总线可以通过协议探测设备。Linux 询问总线，设备回答自己的身份，操作系统再加载驱动。SoC 内部的 UART、GPIO、定时器和很多 I2C 设备通常没有这样的自发现协议。CPU 只知道某个地址范围可能连着寄存器，却不知道那里是什么设备，或者这根中断线接到了哪里。

设备树把这份外部知识交给启动链路。把它想成搬家时交接的一张机器清单：清单说明房间里有什么、门牌号是什么、钥匙交给谁；它不会替你操作洗衣机。对应到规范术语，boot program 可以是固件、bootloader 或 hypervisor，client program 可以是 Linux，也可以是另一个 bootloader。boot program 把 devicetree 放进内存，然后把它传给 client program。

因此职责边界很重要：

- **DTS/DTB** 描述硬件的拓扑、资源和连接关系。
- **boot program** 加载 DTB，并把它传给下一个程序。
- **Linux 驱动** 根据描述找到资源，映射寄存器，申请中断，然后真正操作硬件。
- **binding** 规定某类设备允许使用哪些 `compatible` 和属性，是接口约束，不是驱动实现。

设备树不是硬件扫描器，也不是驱动代码。往 `reg` 里写一个地址，不会自动生成对该地址执行读写的驱动。

> [!WARNING]
> **注意：设备树不会替代驱动。** `compatible` 只负责匹配，`reg` 只描述资源。只有对应的 Linux 驱动成功匹配并执行 `probe()`，设备才可能被初始化。

## 先跑通一条 DTS 到 DTB 的链路

我们先写一个只描述 UART 的最小例子。这里的地址 `0x10000000` 是实验数据，不属于任何真实芯片。

```c
/dts-v1/;

/ {
    compatible = "example,hello-board";
    model = "Example Hello Board";

    #address-cells = <1>;
    #size-cells = <1>;

    soc {
        compatible = "simple-bus";
        #address-cells = <1>;
        #size-cells = <1>;
        ranges;

        uart0: serial@10000000 {
            compatible = "example,uart";
            reg = <0x10000000 0x100>;
            status = "okay";
        };
    };
};
```

保存为 `/tmp/devicetree-tutorial.dts` 后，先确认工具是否存在：

```bash
dtc --version
```

`dtc` 是 Device Tree Compiler。它把 DTS 文本转换成 DTB，也能把 DTB 反编译回近似的 DTS。我的实验环境如果没有 `dtc`，这一步就应该明确停下来安装工具，而不是编造一段"成功输出"。在 Debian/Ubuntu 上通常由 `device-tree-compiler` 包提供，其他发行版请查自己的包管理器。

> [!CAUTION]
> **工具检查。** 如果 `dtc` 不在 `PATH` 中，请先安装 Device Tree Compiler。后续编译、反编译和 magic 检查都依赖它们；不要把"命令没有执行"写成"实验成功"。

编译命令的输入是 DTS，输出是 DTB：

```bash
dtc -I dts -O dtb -o /tmp/devicetree-tutorial.dtb \
    /tmp/devicetree-tutorial.dts
```

随后反编译：

```bash
dtc -I dtb -O dts -o /tmp/devicetree-tutorial.roundtrip.dts \
    /tmp/devicetree-tutorial.dtb
```

反编译结果不是原文件的文本复制品。标签名、注释和部分源码排版可能消失，但根节点、`compatible`、`reg` 和 `status` 等设备树数据应该还在。若系统安装了 `fdtdump`，还可以查看底层结构；没有它时，至少可以观察 DTB 的头部：

```bash
hexdump -C -n 16 /tmp/devicetree-tutorial.dtb
```

合法 DTB 的前四个字节按大端解释为 magic `0xd00dfeed`。这不是"文件前 40 字节永远是什么"的承诺，后面讲 FDT 结构时会看到，真正可靠的是头部字段里的偏移和长度。

这里的"大端"说的是**多字节数值在内存或文件中的字节排列顺序**。例如数值 `0x12345678` 由四个字节 `12 34 56 78` 组成：大端把高位字节 `12` 放在低地址一侧，小端则把低位字节 `78` 放在低地址一侧。设备树规范要求 DTB 中的 cell 按大端编码，所以用十六进制查看原始字节时，不能直接把字节序列当作当前 CPU 的本地整数来读。

> [!NOTE]
> **大小端提醒。** `0xd00dfeed` 是按大端解释出的 32 位 magic。看到原始字节时，先确认协议规定的字节序，再解释数值；否则很容易把同一组字节读成另一个整数。

**这份小树逐行在说什么？**

`/dts-v1/;` 声明 DTS source format version 1。`/ { ... };` 是根节点，根节点没有 `@unit-address`。`model` 面向人，`compatible` 面向软件匹配；根节点的 `compatible` 也必须来自对应平台的约定，实验值只是实验值。

`soc` 是一个总线节点。`ranges;` 是空属性，在常见的 `simple-bus` 写法里表示子总线地址空间与父地址空间相同。`uart0:` 是源码标签，只服务于 DTS 内部引用，标签本身不会作为标签字符串写入 DTB。

`serial@10000000` 由两部分构成：通用节点名 `serial` 和 unit-address `10000000`。因为节点有 `reg`，unit-address 必须与 `reg` 中的第一个地址相匹配。节点名应使用 1 到 31 个合法字符，并以字母开头；具体总线 binding 还可能增加额外要求。

## DTS 语法的最小心智模型

节点是树，属性是节点里的键值对。属性要写在子节点之前，子节点再继续向下展开。下面把常用值类型放在一处：

```c
empty-property;

one-cell = <42>;
two-cells = <0x00000001 0x00000000>;

one-string = "hello";
string-list = "example,device", "example,bus";

bytes = [00 11 22 aa];
```

尖括号里的每个 cell 是 32 位无符号整数。一个 64 位值由两个 cell 表示，高位在前。方括号表示 bytestring。多个逗号分隔的组件会拼接成同一个属性值。DTS 还支持 C 风格的算术、位运算和逻辑表达式，例如 `reg = <(0x1000 + 0x200) 0x100>;`。

`reg` 不是一种到处一样的"地址加长度"语法。它的 cell 布局由**父节点**的 `#address-cells` 和 `#size-cells` 决定：

```c
mmio-bus {
    #address-cells = <1>;
    #size-cells = <1>;

    device@2000 {
        reg = <0x2000 0x100>;
    };
};

i2c-bus {
    #address-cells = <1>;
    #size-cells = <0>;

    eeprom@50 {
        reg = <0x50>;
    };
};
```

在第一个例子里，每个条目是一个地址 cell 加一个长度 cell。第二个例子里，I2C 子设备的 `reg` 是从设备地址，父总线把 `#size-cells` 设为 0，所以没有长度 cell。不要从某块板子的数值推导普适规则；先看父节点，再看该总线和设备的 binding。

> [!IMPORTANT]
> **`reg` 的关键规则。** 永远先看父节点的 `#address-cells` 和 `#size-cells`，再按照对应 bus binding 解释 `reg`。I2C 从设备地址、MMIO 地址和 PCI 地址不是同一种语义。

`ranges` 描述子总线地址空间到父总线地址空间的翻译。它不是 `reg` 的别名。`dma-ranges` 则描述 DMA 地址视角下的范围，是否需要它取决于平台的 DMA 地址转换。实际填写时必须查 binding 和平台 DTS。

标签和引用让设备树可以把物理层级与逻辑连接分开：

```c
intc: interrupt-controller {
    compatible = "example,intc";
    interrupt-controller;
    #interrupt-cells = <2>;
};

serial@10000000 {
    interrupt-parent = <&intc>;
    interrupts = <5 4>;
};
```

`&intc` 最终会被编码为 phandle 相关信息。`&node { ... };` 是对已经定义节点的覆盖，板级 `.dts` 经常用它启用 SoC `.dtsi` 中默认禁用的外设：

```c
&uart0 {
    status = "okay";
};
```

共享定义通常放进 `.dtsi`，再通过 `/include/ "soc.dtsi"` 引入。源码标签只存在于 DTS 语言；DTB 里保存的是供运行时解析的结构和 phandle 值。

## 描述一个真实设备需要回答的问题

我写设备节点时会按下面的顺序检查，而不是看到属性名就往里塞：

1. **设备是谁？** 用 binding 规定的 `compatible`。列表通常从特化到通用，但只有当内核确实存在对应匹配项时，回退字符串才有意义。
2. **资源在哪里？** 用该总线语义下的 `reg`、`ranges`、内存区域和时钟资源。
3. **设备怎么连？** 用 phandle 引用表达时钟、reset、GPIO、DMA 和中断控制器。
4. **现在是否使用？** 通常通过 binding 允许的 `status` 值表达，常见值是 `okay` 和 `disabled`。

一个稍微完整的 SoC 节点可能长这样：

```c
soc {
    compatible = "simple-bus";
    #address-cells = <1>;
    #size-cells = <1>;
    ranges;

    uart0: serial@10000000 {
        compatible = "example,uart-v2", "example,uart";
        reg = <0x10000000 0x100>;
        interrupts-extended = <&intc 5 4>;
        clocks = <&clk 3>;
        resets = <&reset 7>;
        pinctrl-names = "default";
        pinctrl-0 = <&uart0_pins>;
        dmas = <&dma 2>;
        status = "okay";
    };
};
```

这段代码只是展示属性之间的关系，不是某个可直接提交的 Linux binding。`interrupts-extended` 的 cell 数量由被引用的中断控制器定义，`clocks`、`resets` 和 `dmas` 的参数也分别由 provider 的 `#*-cells` 和对应 binding 定义。设备树不是"把所有可能的属性都填上"竞赛。

`compatible` 列表的顺序有意义：更特化的字符串在前，更通用的字符串在后。它不是承诺任意平台都存在一个通用回退驱动。正确流程是先查 Linux 内核 `Documentation/devicetree/bindings/` 下的 YAML，再决定字符串和必需属性。`make dtbs_check` 会用这些 schema 检查编译后的设备树，但 schema 检查通过也不等于硬件接线正确。

> [!WARNING]
> **不要凭感觉填写属性。** `compatible`、中断 specifier、clock/reset/DMA 参数都由 binding 规定。`make dtbs_check` 通过，只说明描述符合 schema，不证明芯片接线、时钟或电源真的正确。

## I2C 设备和中断：两棵逻辑树

I2C 触摸控制器在设备树的物理拓扑中是 I2C 控制器的子节点，但它的中断线可能接到 GPIO 控制器，再由 GPIO 控制器连接到 GIC。于是"设备在哪"和"中断怎么走"是两种不同的关系。

```c
&i2c0 {
    #address-cells = <1>;
    #size-cells = <0>;

    touch@38 {
        compatible = "example,touch";
        reg = <0x38>;
        interrupt-parent = <&gpio0>;
        interrupts = <12 8>;
    };
};

gpio0: gpio-controller {
    compatible = "example,gpio";
    gpio-controller;
    #gpio-cells = <2>;
    interrupt-controller;
    #interrupt-cells = <2>;
    interrupt-parent = <&gic>;
};
```

`interrupt-controller;` 是空属性，表示该节点提供中断域。`#interrupt-cells` 告诉消费者一个 interrupt specifier 有几个 cell，但具体每个 cell 的含义不能猜。ARM GIC、GPIO 控制器和其他中断域的数量可能不同。

简单设备通常写 `interrupt-parent` 和 `interrupts`。如果设备连接多个中断控制器，可以使用 `interrupts-extended`，它把每个中断控制器的 phandle 和对应 specifier 放在一起。复杂的 PCI host bridge 等 nexus 节点还会使用 `interrupt-map` 做域间翻译；入门阶段只需要记住：中断引用可以跨越设备树的物理父子关系，详细格式必须回到 binding。

GPIO、clock、reset、DMA 的写法也是同一类 phandle 思路：消费者引用 provider，provider 通过 `#gpio-cells` 等属性声明 specifier 的宽度。真正的 flags 和参数解释来自各自 binding，不来自属性名字的直觉。

## Linux 收到 DTB 后发生什么？

bootloader 把 DTB 地址交给内核后，Linux 解析扁平化设备树，建立自己的 device model。对于 `simple-bus` 下的 platform 设备，内核会根据节点创建设备对象；驱动注册时提供 `of_match_table`，其中的 `compatible` 与节点属性进行匹配。

匹配成功以后，驱动才会读取资源。常见的 platform driver 代码大致是：

```c
static const struct of_device_id example_uart_of_match[] = {
    { .compatible = "example,uart-v2" },
    { .compatible = "example,uart" },
    { }
};

static int example_uart_probe(struct platform_device *pdev)
{
    struct resource *mem;
    void __iomem *base;
    int irq;

    mem = platform_get_resource(pdev, IORESOURCE_MEM, 0);
    base = devm_ioremap_resource(&pdev->dev, mem);
    if (IS_ERR(base))
        return PTR_ERR(base);

    irq = platform_get_irq(pdev, 0);
    if (irq < 0)
        return irq;

    return devm_request_irq(&pdev->dev, irq, example_uart_irq,
                            0, dev_name(&pdev->dev), pdev);
}
```

这里的关键不是背 API，而是看清边界：设备树提供资源描述，驱动通过 Linux API 取得并使用资源。`devm_ioremap_resource()` 不会验证地址背后真的焊了一块 UART；它只负责在内核资源模型允许的前提下建立映射。`devm_request_irq()` 也不替你修复接错的中断线。

> [!NOTE]
> **排错边界。** 设备树描述"有什么"和"资源在哪里"，驱动决定"怎么操作"。匹配失败、资源获取失败和硬件本身不工作，应分别从 `compatible`、资源属性以及时钟/复位/pinmux/接线排查。

因此排错时要区分三类失败：

- `compatible` 不匹配：设备可能根本没有进入目标驱动的 `probe()`。
- `reg`、clock、reset 或中断描述错误：驱动进入 `probe()`，但获取资源失败。
- DTS 和 binding 都正确，硬件仍不工作：继续检查时钟、复位、pinmux、电源和真实接线。

## 系统节点：不要把惯例写成绝对规则

完整系统描述通常还会出现这些节点：

```c
/ {
    chosen {
        stdout-path = &uart0;
    };

    aliases {
        serial0 = &uart0;
    };

    cpus {
        #address-cells = <1>;
        #size-cells = <0>;

        cpu@0 {
            device_type = "cpu";
            reg = <0>;
        };
    };

    memory@80000000 {
        device_type = "memory";
        reg = <0x80000000 0x40000000>;
    };
};
```

`/chosen` 是 boot program 向 client program 传递运行时选择的地方，例如 `bootargs` 和 `stdout-path`。`/aliases` 为长路径提供短名字。`/cpus` 描述 CPU 集合，`/memory` 描述可用 RAM。某种架构和启动方式可能要求这些节点，但不能脱离上下文说所有设备树在任何场景都必须有完全相同的节点。

`/reserved-memory` 节点和 FDT 的 memory reservation block 也不是同一个东西。前者是设备树结构里的内存区域描述，常用于 CMA、framebuffer 或固件共享内存；后者是 DTB 二进制中的底层保留表，boot program 可以用它避免 client program 覆写仍在使用的区域。两者都和"这段内存不能随便拿来用"有关，但出现的阶段和表达层次不同。

## 从 Linux 现场反查设备树

拿到一台正在运行的 Linux 后，我会按这个顺序排查，而不是先盯着驱动源码：

1. 查看内核实际展开的设备树：

   ```bash
   ls /sys/firmware/devicetree/base
   ls /proc/device-tree
   ```

   两个路径通常指向内核提供的设备树视图，具体挂载方式取决于系统配置。

2. 查看某个节点的属性。字符串属性以 NUL 结尾，不能总用普通文本工具直读：

   ```bash
   tr -d '\0' < /sys/firmware/devicetree/base/model
   printf '\n'
   xxd /sys/firmware/devicetree/base/soc/serial@10000000/reg
   ```

3. 查看驱动和设备的启动日志：

   ```bash
   dmesg | grep -i -E 'of|firmware|uart|probe'
   ```

4. 如果手里只有 DTB，先反编译，再把结果和板级 `.dts`、SoC `.dtsi` 以及对应 YAML binding 对照。

5. 在 Linux 内核源码树中运行 schema 检查：

   ```bash
   make dtbs_check
   ```

`dtbs_check` 主要检查设备树是否符合 binding schema。它不能替代 `dtc` 的语法检查，也不能替代示波器、逻辑分析仪或一双确认过连接器的眼睛。

> [!TIP]
> **验证顺序。** 先看 Linux 实际展开的设备树，再看 `dmesg`，然后对照 DTB、板级 DTS 和 binding。`dtbs_check` 是约束检查，不是硬件功能测试。

## DTB 为什么可以被搬到别的地址？

DTS 是源码，DTB 是给 client program 消费的紧凑二进制表示。FDT 的设计目标之一是让 boot program 能把它放入内存并传递给下一个程序，因此结构内部使用偏移和长度，而不是依赖加载地址的 C 裸指针。

DTB 头部包含 magic、总大小，以及 memory reservation block、structure block 和 strings block 的偏移与大小等字段。字段按规范使用大端编码。解析器应该读取这些字段，而不是假设某个区块永远位于固定位置。

structure block 把树线性化为 token 序列，常见 token 包括：

- `FDT_BEGIN_NODE`：进入节点，后面跟节点名。
- `FDT_END_NODE`：离开节点。
- `FDT_PROP`：属性，包含长度、属性名在 strings block 中的偏移和属性值。
- `FDT_NOP`：保留的空操作 token。
- `FDT_END`：structure block 结束。

属性名集中存放在 strings block，`FDT_PROP` 用偏移引用它们。节点和属性数据按 4 字节边界对齐；memory reservation entry 使用 64 位地址和大小。这里的数字和布局规则来自 FDT 结构规范及其头部定义，不应该简化成"固定 40 字节所以永远如此"。

我第一次看到这套布局时，感觉它像一个没有指针的压缩内存快照：解析器带着 offset 在几个区块之间走，遇到 begin/end token 用栈恢复树。这个设计牺牲了一点随机访问的舒服感，却换来了可复制、可重定位和早期启动阶段可解析的格式，算是很合理的嵌入式取舍。

## 下一次动手做什么

如果你已经能读懂上面的最小例子，下一步不要继续收藏属性清单。找一块真实开发板，按下面的路径走一遍：

1. 找到它的板级 `.dts` 和 SoC `.dtsi`。
2. 沿着节点路径确认父节点的 `#address-cells`、`#size-cells` 和 `ranges`。
3. 在内核 `Documentation/devicetree/bindings/` 中找到设备对应的 YAML。
4. 只修改一个 `status` 或一个资源属性，重新编译 DTB。
5. 用 `dtc` 反编译产物，确认修改确实进入 DTB。
6. 启动 Linux，从 `/sys/firmware/devicetree/base` 和 `dmesg` 确认内核实际拿到的内容。

未来同一份硬件描述继续被不同 client program 使用并不奇怪，但这不意味着设备树自动带来跨平台兼容。真正可移植的是清晰的描述接口；地址、时钟、中断和 binding 仍然属于具体硬件。至于我自己，下一步大概会挑一个真实 GPIO binding 做实验。先把一盏灯点亮，再考虑宇宙级抽象，yolo。

## 参考资料

1. [Devicetree Specification: Introduction](https://devicetree-specification.readthedocs.io/en/stable/intro.html)
2. [Devicetree Specification: The Devicetree](https://devicetree-specification.readthedocs.io/en/stable/devicetree-basics.html)
3. [Devicetree Specification: Flattened Devicetree](https://devicetree-specification.readthedocs.io/en/stable/flattened-format.html)
4. [Devicetree Specification: Devicetree Source Format](https://devicetree-specification.readthedocs.io/en/stable/devicetree-source.html)
5. [Linux Kernel Documentation: Linux and the Devicetree](https://docs.kernel.org/devicetree/usage-model.html)
6. [Linux Kernel Documentation: Devicetree Bindings](https://docs.kernel.org/devicetree/bindings/index.html)
7. [Device Tree Compiler 官方仓库](https://git.kernel.org/pub/scm/utils/dtc/dtc.git/)
8. [Linux 内核 dtc 文档入口](https://docs.kernel.org/devicetree/)
