---
title: "操作系统中的进程"
date: 2026-01-27 06:10:00 +08:00
excerpt: "教科书对于进程常定义通常极为简洁凝练，但其诞生是为了解决什么问题？本文通过回顾从 ENIAC 到分时系统的演进历史，探讨进程是如何为了填补人、I/O 与 CPU 之间的速度鸿沟而进化出来的。"
categories:
  - Note
tags:
  - OS
---

在计算机科学的教科书中，关于**进程**（*Process*）的定义往往只有冷冰冰的一句话：

> 进程是程序的一次执行过程。

这句话虽然准确，但它掩盖了太多细节。对于初学者而言，这更像是一个黑盒。为什么要有进程？为什么不能直接操作物理地址？所谓的**上下文切换**到底切换了什么？

要真正理解进程，我们不能只看定义，而必须回到计算机发展的历史，从本质出发，看看是怎样的资源瓶颈和物理限制，逼迫工程师们发明了**进程**这个概念。

## 0. 起点：硬件即程序

|时间背景|代表|
|:-:|:-:|
|1940s - 1950s 初|ENIAC|

在**进程**这个概念诞生之前，计算机的世界是纯粹且静止的。如果非要为这个 “史前时代” 选一个代表，那非 [ENIAC](https://en.wikipedia.org/wiki/ENIAC)（Electroinc Numeric Numerical Integrator and Computer，电子数值计算机）莫属。在这个阶段，软件和硬件之间并没有明显界限，甚至可以说，根本没有现代意义上的“软件”。

想象一下，你面对的是一个占地 167 平方米、重达 27 吨的庞然大物。这就是 ENIAC，它是那个时代算力的巅峰，但对于 “任务管理” 而言，它确实最原始的形态：它没有任何中间层来管理资源；同一时间，这台巨兽只能为解决**一个问题**而存在。

{% include figure popup=true image_path="/assets/images/Glen_Beck_and_Betty_Snyder_program_the_ENIAC_in_building_328_at_the_Ballistic_Research_Laboratory.jpg" alt="Glen Beck and Betty Snyder program the ENIAC" caption="早期的编程：Glen Beck 与 Betty Snyder 正在对 ENIAC 进行硬连线" %}

在 ENIAC 上 “切换任务” 并不是像今天一样双击一个图标一样简单。那是一场体力劳动。当时的 “编程”，实际上就是 “接线”。

程序员（通常是女性数学家）需要拿着粗大的连接线（Patch Cables），在巨大的配线板上进行物理连接。每一个插孔的连接，每一排开关的拨动，都代表着指令的逻辑流向。当你把线插好，这台机器就变成了解决那个特定方程的专用电路。

{% include figure popup=true image_path="/assets/images/Two_women_operating_ENIAC.jpg" alt="Two women operating ENIAC" caption="操作员正在手动更改 ENIAC 的线路配置" %}

> 似乎有点类似于现在的 FPGA。

既然没有操作系统，那谁来切换任务呢？那自然也只能让人来手动切换了。

{% include figure popup=true image_path="/assets/images/Classic_shot_of_the_ENIAC.jpg" alt="Classic shot of the ENIAC" caption="ENIAC 全景：巨大的体积与原始的操作方式" %}

在这个时期，ENIAC 的加法速度已经高达 5000 次/秒，但准备计算的过程确慢得令人发指。而正是这种**极高的计算速度**与**极低的任务切换效率**之间的巨大鸿沟，成为了推动计算机科学向前发展的原动力。

## 1. 第一次进化：消除人的延迟 —— 批处理系统

|时间背景|代表|
|:-:|:-:|
|1955 - 1960s 初|GM-NAA I/O（为 IBM 704 开发）|

1945 年，随着 [John von Neumann](https://en.wikipedia.org/wiki/John_von_Neumann) 在其里程碑式的著作《[First Draft of a Report on the EDVAC](https://en.wikipedia.org/wiki/First_Draft_of_a_Report_on_the_EDVAC)》中正式确立了冯·诺依曼架构，程序终于从繁琐的硬件连线进化为存储在磁带上的指令。虽然这一边个消除了物理插拔线缆的需求，但在早期的 Open Shop（开放式机房）模式依然由人主导：程序员带着磁带走进机房，装带、运行、卸带、离开，然后下一个人进来。

{% include figure popup=true image_path="/assets/images/Von_Neumann_Architecture.svg" alt="Von Neumann Architecture" caption="冯·诺依曼架构：存储程序计算机的基石" %}

当时的 CPU（如 IBM 704）如同黄金般珍贵。人的动作（装磁带、按按钮）可能需要花费几分钟，但 CPU 可能几秒钟就执行完毕。

让一台每秒运行数万次指令的 CPU 停下来等人，这是对计算资源极大的浪费。为了解决 “人太慢，CPU 等人” 的矛盾，**批处理系统**（*Batch Processing*）应运而生。

{% include figure popup=true image_path="/assets/images/batch_processing_system.png" alt="batch processing system" caption="批处理系统的工作流示意图" %}

1956 年，通用汽车（GM）的研究部门为 IBM 704 编写了 [GM-NAA I/O](https://en.wikipedia.org/wiki/GM-NAA_I/O)，这被认为是世界上第一个真正意义上的操作系统。

工程师们发明了一个叫做 [**Monitor**](https://en.wikipedia.org/wiki/Resident_monitor) 监控程序的常驻小软件。它的逻辑非常简单：

1. 它始终停留在内存的一小块区域。
2. 它负责读取磁盘上的下一个**作业**（Job）。
3. 自动加载作业 $\rightarrow$ 运行作业 $\rightarrow$ 作业结束 $\rightarrow$ 把控制权还给 Monitor $\rightarrow$ 加载下一个。

{% include figure popup=true image_path="/assets/images/resident_montior.png" alt="resident monitor" caption="常驻监控程序 (Monitor) 的内存布局" %}

此时，依然没有**进程**的概念，只有**作业**（Job）。内存里依然一次只住一个程序。

## 2. 第二次进化：消除 I/O 的延迟 —— 多道程序设计

|时间背景|代表|
|:-:|:-:|
|1960s 中期|IBM OS/360|

批处理虽然解决了人的问题，但没解决硬件的问题。即使是自动运行，当程序需要读取磁带或磁盘时，由于机械设备的物理限制，I/O 操作的速度比 CPU 慢了几个数量级（毫秒 vs 微秒）。

每当程序发起 I/O 请求（比如读取数据块），CPU 就不得不停下来傻等。这种等待在 CPU 眼里是极其漫长的。

为了解决 “I/O 太慢，CPU 等 I/O” 的矛盾，**多道程序设计**（Multiprogramming）横空出世。IBM 在其传奇的 Systen/360 大型机上大力推行这一概念。

{% include figure popup=true image_path="/assets/images/IBM_System_360_model_30_cpu.jpg" alt="IBM System 360 model 30 cpu" caption="IBM System/360 Model 30 控制台" %}

工程师们想出了一个绝妙的主意：既然内存变大了，为什么不一次性装入多个作业呢？

1. 当 Job A 在等待磁带数据时（阻塞），操作系统把 CPU 切给 Job B 用。
2. 当 Job B 也在等打印机时，再切给 Job C。

{% include figure popup=true image_path="/assets/images/multiprogramming_operating_system.png" alt="multiprogramming operating system" caption="多道程序设计下的内存划分" %}

这一刻，计算机科学迎来了一个关键的转折点：为了在多个程序之间来回切换，我们需要保存每个程序的状态。

在 OS/360 中，出现了用来描述任务状态的数据结构 **TCB**（Task Control Block）。这正是后来 **PCB**（Process Control Block）的前身。

{% include figure popup=true image_path="/assets/images/os_360_system_control_blocks.jpg" alt="os 360 system control blocks" caption="OS/360 中的系统控制块 (TCB) 结构" %}

此时，TCB 主要完成两个任务：

1. **现场保护**：当 CPU 从 A 切到 B 时，A 的寄存器（算到一半的结果、程序计数器 PC 等）必须存进 TCB，否则下次回来状态就全部丢失了（因为寄存器只有一套）。
2. **状态标记**：系统需要记录谁在 Running，谁在 Waiting，谁已经 Ready。

## 3.  终极进化：以人为本 —— 分时系统与进程

|时间背景|代表|
|:-:|:-:|
|1960s 晚期 - 1970|Multics, Unix|

到了 60 年代末，计算机不再仅仅用于科学计算，人们开始通过终端（Teletype/屏幕/键盘）与计算机交互。如果继续沿用多道程序设计的逻辑（只有 I/O 阻塞才切换），会发生什么？

假设 Job A 中写了一个死循环 `while(1)` 且不进行 I/O，它将永远霸占 CPU。坐在终端前的用户 B 敲下键盘，屏幕毫无反应。这对于交互式系统是不可接受的。

为了解决 “响应时间太慢，用户体验差” 的矛盾，MIT、贝尔实验室和通用电气联合开发了 [Multics](https://en.wikipedia.org/wiki/Multics)（虽然它过于复杂，但其思想催生了后来的 [Unix](https://en.wikipedia.org/wiki/Unix)）。

系统引入了**硬件定时器**。这一改变是革命性的：

- **抢占式调度**（Preemptive）：无论程序 A 是否运行完，每隔几十毫秒（一个时间片），操作系统强制打断它，保存上下文，把 CPU 扔给程序 B。
- 幻觉：这种快速的切换，让每个用户都产生了一种 “我独占了一台电脑” 的错觉。

{% include figure popup=true image_path="/assets/images/Round_Robin_Schedule_Example.jpg" alt="Round Robin Schedule Example" caption="轮转调度算法 (Round-Robin) 时间片轮转示意" %}

也就是在这个时期，**进程**这个概念被正式确立，并赋予了现代含义。为了维持这种 “独占的幻觉”，操作系统构建了两道高墙：

1. 时间的虚拟化：通过保存/回复 CPU 寄存器上下文，让每个进程觉得拥有独立的 CPU。
2. 空间的虚拟化：通过 MMU（内存管理的单元）和页表，让每个进程觉得拥有独立的、连续的内存空间（虚拟内存）。

至此，进程不再仅仅是用户的代码，它是：

**代码** + **动态执行上下文**（某一时刻寄存器中的值）+ **虚拟地址空间**
{: .notice}

## 参考资料

本文参考了以下资料，排名无先后顺序：

1. [Timeline of operating systems - Wikipedia](https://en.wikipedia.org/wiki/Timeline_of_operating_systems)
2. [History of operating systems - Wikipedia](https://en.wikipedia.org/wiki/History_of_operating_systems)
3. [ENIAC - Wikipedia](https://en.wikipedia.org/wiki/ENIAC)
4. [John von Neumann - Wikipedia](https://en.wikipedia.org/wiki/John_von_Neumann)
5. [First Draft of a Report on the EDVAC - Wikipedia](https://en.wikipedia.org/wiki/First_Draft_of_a_Report_on_the_EDVAC)
6. [GM-NAA I/O - Wikipedia](https://en.wikipedia.org/wiki/GM-NAA_I/O)
7. [Resident monitor - Wikipedia](https://en.wikipedia.org/wiki/Resident_monitor)
8. [Multics - Wikipedia](https://en.wikipedia.org/wiki/Multics)
9. [Unix - Wikipedia](https://en.wikipedia.org/wiki/Unix)
10. [Types of Operating Systems - BYJU'S](https://byjus.com/gate/types-of-operating-system-notes/)
11. [IBM OS/360 System Control Blocks (PDF)](https://bitsavers.org/pdf/ibm/360/os/R21.7_Apr73/GC28-6628-9_OS_System_Ctl_Blks_R21.7_Apr73.pdf)
12. [Task Control Block - Wikipedia](https://en.wikipedia.org/wiki/Task_Control_Block)
13. [Round-robin scheduling - Wikipedia](https://en.wikipedia.org/wiki/Round-robin_scheduling)
