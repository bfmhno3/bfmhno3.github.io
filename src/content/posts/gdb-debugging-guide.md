---
title: "从暂停到理解：GDB 调试完整实践"
published: "2026-08-25 20:00:00 +08:00"
description: "我用一个带有逻辑错误、递归、线程和崩溃路径的 C++20 小程序，从第一次启动 GDB 开始，实作源码定位、断点、栈帧、内存、寄存器、异常、线程、远程调试、优化、脚本和反向执行。"
category: Tutorial
tags:
  - Linux
  - C++
  - GDB
  - Debug
draft: false
comment: true
---

我一直觉得 GDB 很重要，但以前真正遇到崩溃时，第一反应还是加几行 `std::cout`。这多少有点像给发动机贴便利贴来寻找异响，所以我决定做一个小实验：写一个可以编译、可以运行、故意有两个错误的 C++ 程序，然后只用 GDB 观察它如何执行、在哪里偏离预期，以及它为什么最终崩溃。

这篇文章不是命令字典。我会从一个实际的 artifact 出发，边运行边解释 GDB 如何暂停、观察、改变并继续一个进程。我的环境是 GNU GDB 17.2 和 GCC 15.3.0；命令在 GDB 13/14 上大概率也成立，但线程、TUI、系统调用捕获和反向执行都可能受到平台限制。

## 先造一个可以被调试的程序

我把下面的文件保存为 `gdb_demo.cpp`。它有四个刻意保留的观察点：动态 `vector`、递归求和、两个受互斥锁保护的线程，以及通过 `--crash` 参数触发的空指针解引用。

```cpp
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>

int recursive_sum(const std::vector<int>& values, std::size_t index) {
    if (index == values.size()) {
        return 0;
    }
    return values[index] + recursive_sum(values, index + 1);
}

void worker(int& counter, std::mutex& mutex) {
    for (int i = 0; i < 1000; ++i) {
        std::lock_guard<std::mutex> lock(mutex);
        ++counter;
    }
}

int main(int argc, char* argv[]) {
    const bool crash = argc > 1 && std::string(argv[1]) == "--crash";
    std::vector<int> values{3, 5, 7, 9};
    const int total = recursive_sum(values, 0);
    const double average = static_cast<double>(total) / (values.size() - 1);

    std::cout << "total=" << total << ", average=" << average
              << ", expected_average=6\n";

    int counter = 0;
    std::mutex mutex;
    std::thread first(worker, std::ref(counter), std::ref(mutex));
    std::thread second(worker, std::ref(counter), std::ref(mutex));
    first.join();
    second.join();
    std::cout << "counter=" << counter << "\n";

    if (crash) {
        int* pointer = nullptr;
        std::cout << "about to dereference a null pointer\n";
        std::cout << *pointer << "\n";
    }
}
```

我先用可调试构建编译它：

```bash
g++ -std=c++20 -g3 -O0 -fno-omit-frame-pointer -Wall -Wextra \
    -o gdb_demo gdb_demo.cpp
```

`-g3` 把源码、变量和宏等调试信息写进可执行文件；`-O0` 关闭优化，让源码行和实际执行顺序尽量保持直觉；`-fno-omit-frame-pointer` 保留帧指针，便于调用栈和低层检查。这里的 `-Wall -Wextra` 是编译器警告，不是 GDB 功能，但我希望在程序进入调试器前先消灭显眼的问题。

正常运行得到：

```text
total=24, average=8, expected_average=6
counter=2000
```

`3 + 5 + 7 + 9 = 24`，两个线程各自增加 `1000` 次，所以 `counter=2000` 是稳定结果。平均值却是 `8`，而我写在输出里的期望值是 `6`。错误就在 `values.size() - 1`，应该除以 `values.size()`。这是一种 GDB 很擅长处理的问题：程序没有崩溃，编译器也没有理由报警，但状态已经错了。

加上参数后，程序会进入另一条路径：

```text
about to dereference a null pointer
Segmentation fault
```

## 第一次完整调试：暂停，观察，继续

启动 GDB 的命令属于 Shell，不属于 GDB：

```bash
gdb ./gdb_demo
```

看到 `(gdb)` 之后，才进入 GDB 命令语言。程序自己的标准输入则是第三种东西，例如程序调用 `std::cin` 时，输入才会被程序读取，而不会自动变成 GDB 命令。这个边界一开始很容易混淆，我也混淆过（把 `run` 输入成程序参数，结果得到了一次相当安静的失败）。

我先走一遍最短路径：

```text
(gdb) break main
(gdb) run
(gdb) next
(gdb) step
(gdb) print values
(gdb) continue
(gdb) backtrace
(gdb) quit
```

`break main` 在 `main` 入口设置断点，`run` 启动程序并停在那里，`next` 执行当前源码行但跳过被调用函数，`step` 则进入函数。`print` 读取当前上下文中的表达式，`continue` 继续运行到下一个断点或信号，`backtrace` 打印调用栈，`quit` 退出。

断点像给程序安装一个可控的闸门。进程跑到闸门前暂停，我可以查看货物，也可以决定放行、改变一件货物，甚至把它送回另一条轨道。类比到这里就够了，后面我会直接使用 GDB 的术语。

### 符号为什么重要

编译器最终生成的是机器指令，CPU 并不知道 `main` 或 `average` 这些名字。`-g3` 让可执行文件额外携带符号表、源码文件、行号和变量位置，GDB 才能把某个指令地址映射回 `gdb_demo.cpp:24`。

没有调试信息时，GDB 仍然可以停在地址、查看寄存器和反汇编，但你会失去大部分源码级语义：

```text
(gdb) file ./gdb_demo_without_debug_info
(gdb) break main
No symbol table is loaded.  Use the "file" command.
```

## 按调试任务使用断点

**我通常先问：程序应该在哪些位置停下来？**

```text
(gdb) break main
(gdb) break recursive_sum
(gdb) break gdb_demo.cpp:24
(gdb) break gdb_demo.cpp:24 if values.size() != 4
(gdb) rbreak worker.*
(gdb) tbreak gdb_demo.cpp:40
(gdb) info breakpoints
(gdb) disable 2
(gdb) enable 2
(gdb) clear gdb_demo.cpp:24
(gdb) delete 1
```

`break` 可以按函数、文件和行号设置，也可以附加条件。`rbreak` 接受正则表达式，`tbreak` 只命中一次。每个断点都有编号，`info breakpoints` 显示位置、启用状态和命中次数；这个实验中 `recursive_sum` 会递归进入 5 个栈帧，但条件断点只在满足条件的那一帧停下。

如果我在共享库加载前设置断点，GDB 可能显示：

```text
Breakpoint 3 (some_library_function) pending.
```

这不是命中。它表示 GDB 暂时找不到符号，等目标共享库加载后再尝试解析。可以用 `set breakpoint pending on` 明确允许这种行为，再用 `info sharedlibrary` 检查库是否已加载。

`clear` 按源码位置清理，`delete` 按断点编号删除，`disable` 只暂时关闭。调试一个复杂程序时，我更常用 `disable`，因为保留编号和条件比重新设置更少出错。

## 控制执行：不要把程序当成黑盒

这些命令的区别值得单独记住：

- `run` 从头启动；可以写成 `run --crash`。
- `start` 在 `main` 的第一行附近停下，适合快速检查参数。
- `starti` 从第一条机器指令开始，适合研究启动代码。
- `continue` 放行直到下一个断点、信号或退出。
- `next` 执行当前源码行，不进入函数。
- `step` 执行当前源码行，并进入函数。
- `finish` 运行到当前函数返回，并显示返回值。
- `until 30` 运行到当前函数中的指定行或更高层位置。
- `advance gdb_demo.cpp:35` 运行到指定位置，不会倒退控制流。
- `jump gdb_demo.cpp:30` 直接改变下一条源码位置，可能跳过初始化。
- `return` 强制当前函数返回，可附加返回值。
- `signal SIGINT` 把信号交给被调试程序。

`jump` 和 `return` 不是修复代码。它们是实验工具，用来回答如果跳过某个分支会发生什么；跳过构造函数、析构函数或锁操作很容易破坏程序状态。我只在已经知道风险的局部现场使用它们。

## 栈帧：递归时我到底在看谁

程序每调用一个函数，通常就产生一个栈帧。递归调用 `recursive_sum` 时，4 个元素会产生 4 个非终止调用帧，再加上终止帧和 `main`，所以我可以观察到 6 层相关上下文。

```text
(gdb) break recursive_sum
(gdb) run
(gdb) backtrace
(gdb) frame 2
(gdb) info frame
(gdb) info args
(gdb) info locals
(gdb) up
(gdb) down
```

`backtrace` 或 `bt` 从当前帧向调用者打印；`frame 2` 直接切换到编号为 `2` 的帧；`up` 和 `down` 在调用者与被调用者之间移动。关键点是：`print index` 读取的是当前 frame 的 `index`，不是我脑中刚才那个递归层级的 `index`。

崩溃路径的命令更加直接：

```text
(gdb) set args --crash
(gdb) run
(gdb) bt
(gdb) bt full
(gdb) frame 0
(gdb) print pointer
```

本次崩溃稳定停在 `gdb_demo.cpp:40`，`pointer` 的值是 `0x0`。地址本身依赖运行环境，语义不依赖：当前线程在解引用空指针。

## 数据和表达式：让 GDB 替我问问题

```text
(gdb) print total
(gdb) p average
(gdb) display total
(gdb) display /x total
(gdb) undisplay 1
(gdb) ptype values
(gdb) whatis values
(gdb) set print pretty on
(gdb) set print elements 20
(gdb) print values[2]
(gdb) print values.data()
(gdb) print *values.data()
```

`print` 可以求 C++ 表达式。`display` 会在每次停下时自动打印，适合观察循环变量；`ptype` 展开类型定义，`whatis` 给出更短的类型名。对 `vector`、结构体和嵌套对象，`set print pretty on` 通常更容易阅读。

我在第 24 行设置断点后，可以确认 `total` 已经是 `24`，而 `average` 尚未完成初始化。此时打印未初始化的局部变量得到垃圾值不是 GDB 出错，而是程序还没有给它一个有效值。继续到下一行后再打印，才会看到 `average=8`。

表达式也可以带类型转换：

```text
(gdb) print (long) counter
(gdb) print (double) total / values.size()
```

调用函数要谨慎。`print some_function()` 可能修改全局状态、推进迭代器、申请内存或拿锁。GDB 正在观察程序时替我调用函数，结果可能比原始执行更复杂，我优先读取变量和内存。

## 内存、寄存器和汇编

`x/nfu address` 中，`n` 是数量，`f` 是格式，`u` 是单位。例如：

```text
(gdb) x/4dw values.data()
(gdb) x/16xb values.data()
(gdb) x/s pointer
(gdb) x/i $pc
(gdb) info registers
(gdb) disassemble /m recursive_sum
(gdb) disassemble /r main
```

`x/4dw` 按十进制 word 查看 4 个单元，`x/16xb` 按十六进制 byte 查看 16 个字节，`x/s` 把地址解释为字符串，`x/i $pc` 查看程序计数器当前位置的指令。`info registers` 显示寄存器，`$pc` 是当前指令地址，`$sp` 指向当前栈顶，`$fp` 在保留帧指针的构建中帮助定位当前栈帧。

`disassemble /m` 尝试把源码行和机器指令混排，`disassemble /r` 附带原始机器字节。也可以使用：

```text
(gdb) layout asm
```

这时我看到的不是 C++，而是编译器为 C++ 选择的实际指令。源码的第 24 行可能对应多条指令，单步时也可能在同一行内移动。GDB 是源码和 CPU 状态之间的显微镜，不是源码执行动画播放器。

## 改变状态：有时我需要一个反事实

```text
(gdb) set variable average = 6
(gdb) set variable counter = 0
(gdb) set $expected = 6
(gdb) print $expected
(gdb) set $pc = *some_address
(gdb) set $rax = 0
```

`set variable` 修改程序变量，`$expected` 是 GDB convenience variable，修改寄存器则直接影响后续机器指令。它们适合验证假设：如果平均值已经是 `6`，后续分支是否还会失败？某个寄存器清零后，崩溃位置是否变化？

这不是源代码修复。类型不匹配、越界写入、跳过锁和破坏对象不变量，都可能制造新的假象。实验结束后我会重新启动进程，而不是把被 GDB 改过的状态当成测试结果。

## watchpoint：捕获变化，而不是猜行号

```text
(gdb) break worker
(gdb) run
(gdb) watch counter
(gdb) rwatch counter
(gdb) awatch counter
(gdb) info watchpoints
```

`watch` 在表达式写入后停下，`rwatch` 在读取后停下，`awatch` 在读取或写入后停下。对简单标量，GDB 大概率使用硬件 watchpoint；硬件寄存器数量有限，复杂表达式和大范围内存可能无法使用。

线程版本中 `counter` 最终从 `0` 变化到 `2000`。因为我用 `std::mutex` 保护了自增，结果稳定；普通断点只能说明某个线程停过，不能证明不存在数据竞争。要调查竞争，我会结合 `info threads`、`thread apply all bt`，再使用 ThreadSanitizer 等专门工具，而不是把 GDB 当成竞态检测器。

异常和系统事件也可以捕获，但能力依赖平台：

```text
(gdb) catch throw
(gdb) catch signal SIGSEGV
(gdb) catch syscall write
(gdb) handle SIGPIPE nostop noprint pass
```

`catch throw` 对 C++ 异常很有用；`catch syscall` 只在目标架构和 GDB 支持的系统调用接口上可用。`handle` 控制信号到达时 GDB 是否暂停、打印以及是否传递给程序。不要把某个平台上的 catchpoint 行为写成所有 Linux、BSD 和嵌入式目标都相同。

## 参数、环境、线程与崩溃文件

从命令行复现问题时，我会把参数显式放进调试会话：

```text
(gdb) set args --crash
(gdb) show args
(gdb) set environment MODE debug
(gdb) show environment MODE
(gdb) run
```

也可以在 Shell 中使用重定向：

```bash
echo "input" > input.txt
gdb --args ./gdb_demo --crash
(gdb) run < input.txt
```

线程调试的最小工作流如下：

```text
(gdb) info threads
(gdb) thread 2
(gdb) bt
(gdb) thread apply all bt
(gdb) break worker
(gdb) continue
```

断点可能停在任意命中断点的线程。先看 `info threads`，再用 `thread` 切换，最后用 `frame`、`info locals` 检查那个线程的上下文。线程 ID 是运行时生成的，不应写进教程的固定结论。

如果程序产生 core 文件，可以脱离原始运行现场：

```bash
gdb ./gdb_demo core
```

或者在 GDB 中：

```text
(gdb) core-file core
(gdb) bt full
(gdb) info registers
(gdb) x/16gx $sp
```

可执行文件、core 和调试符号必须匹配。换过二进制后继续解释旧 core，得到的行号和变量很可能完全不可信。

## 子进程、共享库和远程目标

调试共享库先确认加载状态：

```text
(gdb) info sharedlibrary
(gdb) set breakpoint pending on
(gdb) break library_function
```

程序 `fork` 后，GDB 默认行为可以调整：

```text
(gdb) set follow-fork-mode child
(gdb) set detach-on-fork off
(gdb) info inferiors
(gdb) inferior 2
```

`follow-fork-mode` 决定跟随父进程还是子进程，`detach-on-fork off` 保留两个 inferior，代价是调试状态更复杂。

远程调试需要目标端有 `gdbserver`、网络连通和权限允许。最小流程是：

```bash
# 目标机
gdbserver :1234 ./gdb_demo --crash

# 主机
gdb ./gdb_demo
(gdb) target remote TARGET_HOST:1234
(gdb) continue
```

远程 GDB 不是把本地文件复制过去；主机上的符号和目标机上的实际可执行文件、库、架构必须对应。端口、防火墙、路径映射和权限都是前置条件，我不会把这条命令伪装成离线环境中的必然成功路径。

## 优化构建为什么会和源码吵架

确认逻辑后，我再编译优化版本：

```bash
g++ -std=c++20 -g3 -O2 -fno-omit-frame-pointer -Wall -Wextra \
    -o gdb_demo_O2 gdb_demo.cpp
```

`-O2` 可能内联 `recursive_sum`、合并变量、改变生命周期和重排指令。于是 GDB 可能显示：

```text
(gdb) print some_local
$1 = <optimized out>
```

也可能出现源码行跳跃、多个变量共享一个寄存器，或者断点虽然设置成功却没有在我预期的行停下。这不是调试器随机失忆，而是编译器已经改变了程序的机器级形状。

我的流程是：先用 `-O0 -g3` 复现和定位，再用 `-O2 -g3` 确认优化环境中的行为。如果只在优化版本崩溃，优先保存 core、检查汇编和寄存器，不要为了让 GDB 显示漂亮变量而误称 `-O0` 的结果代表生产环境。

## TUI、命令脚本和一点自动化

终端界面可以把源码、汇编和寄存器放在同一屏：

```text
(gdb) layout src
(gdb) layout split
(gdb) layout regs
(gdb) focus cmd
(gdb) refresh
```

窗口布局只改变显示，不改变被调试程序。退出 TUI 可以按 `Ctrl-x Ctrl-a`。

重复操作适合放进脚本，例如 `debug.gdb`：

```text
set pagination off
set print pretty on
break main
commands
  silent
  printf "stopped in main, argc=%d\n", argc
  info locals
  continue
end
run
```

执行：

```text
(gdb) source debug.gdb
```

我也可以在 `~/.gdbinit` 中放通用设置，或定义一个小命令：

```text
def btfull
  set pagination off
  thread apply all bt full
end
```

GDB 支持 Python API，可以访问 inferior、断点和事件对象。但我把它留在自动化边界内：先用 `source` 和 `define` 解决 80% 的重复操作，只有当重复逻辑确实需要状态管理时才写 Python。调试器已经够复杂了，没必要为了打印一行栈信息再造一个框架。

## 记录与反向执行

在支持的本地目标上，我可以尝试：

```text
(gdb) record full
(gdb) continue
(gdb) reverse-step
(gdb) reverse-continue
(gdb) record stop
```

它通过记录执行状态，让我在某个错误发生后反向回到之前的指令。代价是额外的时间、内存和记录存储；系统调用、设备访问、线程和某些架构并不都能被完整重放。它不是所有程序都适用的时间机器，尤其不是网络服务的万能撤销按钮。

## 一张按任务分组的功能地图

| 任务 | 常用命令 | 最短用途 |
| --- | --- | --- |
| 运行控制 | `run`, `start`, `starti` | 启动并选择初始停点 |
| 继续执行 | `continue`, `next`, `step` | 放行、越过或进入函数 |
| 改变流程 | `finish`, `until`, `advance` | 运行到返回或指定位置 |
| 实验跳转 | `jump`, `return`, `signal` | 改变下一步、强制返回、发送信号 |
| 断点 | `break`, `rbreak`, `tbreak` | 按函数、正则或位置暂停 |
| 断点管理 | `info breakpoints`, `clear`, `delete`, `disable`, `enable` | 查看和管理断点 |
| 数据 | `print`, `display`, `ptype`, `whatis` | 求表达式、自动显示、查看类型 |
| 栈 | `bt`, `frame`, `up`, `down`, `info frame` | 查看和切换调用上下文 |
| 局部状态 | `info locals`, `info args` | 查看当前帧变量和参数 |
| 内存 | `x`, `find` | 按格式查看或搜索内存 |
| CPU | `info registers`, `disassemble` | 检查寄存器和机器指令 |
| 改状态 | `set variable`, `set $name` | 修改变量或 GDB 便利变量 |
| 变化捕获 | `watch`, `rwatch`, `awatch` | 在读写发生时暂停 |
| 异常信号 | `catch throw`, `catch signal`, `handle` | 捕获异常和信号 |
| 系统调用 | `catch syscall` | 在支持的平台捕获系统调用 |
| 线程 | `info threads`, `thread`, `thread apply all bt` | 列出、切换和批量查看线程 |
| 进程 | `set follow-fork-mode`, `set detach-on-fork`, `info inferiors` | 控制 fork 后的跟随对象 |
| 共享库 | `info sharedlibrary`, `set breakpoint pending on` | 检查库和延迟断点 |
| 远程 | `target remote` | 连接 `gdbserver` |
| TUI | `layout src`, `layout split`, `layout regs`, `focus` | 查看源码、汇编和寄存器 |
| 自动化 | `source`, `define`, `commands` | 加载脚本和定义命令 |
| 反向 | `record full`, `reverse-step`, `reverse-continue` | 在记录数据中回退执行 |

这张表把日常源码调试能力串起来，但不把架构专用命令、IDE 前端、Valgrind 或 AddressSanitizer 冒充成 GDB 功能。它们可以协作，边界仍然存在。

## 常见故障排查

| 症状 | 大概率原因 | 先执行什么 |
| --- | --- | --- |
| `No symbol table is loaded` | 没有 `-g`，或加载了错误文件 | `file ./gdb_demo` |
| `Breakpoint pending` | 共享库尚未加载或符号名不匹配 | `info sharedlibrary` |
| `Cannot access memory` | 地址无效、对象已释放或当前 frame 不对 | `info registers`、`frame 0` |
| `<optimized out>` | 优化消除了变量或改变了生命周期 | 用 `-O0 -g3` 重建 |
| 程序直接退出 | 没有断点，或断点位置不在实际路径 | `start`、`break main` |
| 断点不命中 | 行没有生成可执行代码、条件不成立或库未加载 | `info breakpoints` |
| `print` 看起来不对 | 当前停在错误的栈帧或变量尚未初始化 | `bt`、`frame`、`info locals` |

我把“断点不命中”分成状态问题而不是玄学问题。先看断点编号、启用状态和命中次数，再确认控制流是否真的经过那里；不要一上来就重新编译十次，然后把所有的不确定性归咎于 GDB（虽然这样做有一种很强的仪式感）。

我把第 24 行改成下面这样，再重新编译，而不是在 GDB 里永久修改变量：

```cpp
const double average = static_cast<double>(total) / values.size();
```

修正后的稳定输出是：

```text
total=24, average=6, expected_average=6
counter=2000
```

这两个版本的线程计数相同，只有平均值从 `8` 变成 `6`。这正是我想要的调试闭环：GDB 帮我定位原因，源代码和编译器才负责产生修复后的程序。

## 我以后会怎样使用 GDB

这次实验里，错误平均值从输出中的 `8` 追到了第 24 行，线程计数从 `0` 走到了稳定的 `2000`，崩溃则被定位到空指针解引用的第 40 行。真正改变我习惯的不是记住了多少命令，而是把调试变成一个循环：提出一个关于状态的猜测，设置最窄的停点，观察证据，再决定是否继续。

以后我会先保留一个带 `-g3 -O0` 的可调试构建，把 `gdb ./program` 当成和 `./program` 一样自然的动作。等程序在优化、线程或远程机器上表现不同，我再逐层打开 `info threads`、寄存器、汇编和记录功能，而不是继续往代码里撒 `printf`。

再往前看，调试器大概不会消失。编译器会更激进，异步任务会更多，机器学习生成的代码也会让源码与机器指令之间的距离继续变长。能暂停一个进程只是起点，真正有价值的是保留一条从现象到状态、从状态到原因的证据链。好的调试工具会缩短这条链；好的调试习惯则让我在按下 `run` 之前，已经知道自己准备验证什么。

现在我可以删掉这个实验里的错误，重新编译，然后去吃点东西。GDB 不会替我修复 `values.size() - 1`，它只是非常耐心地证明我确实写错了。