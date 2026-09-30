---
title: "从暂停到理解：GDB 调试完整实践"
commentId: "post:gdb-debugging-guide"
published: "2026-08-25 20:00:00 +08:00"
updated: 2026-09-30
description: "我用一个带有逻辑错误、递归、线程、异常、fork 和崩溃路径的 C++20 小程序，在 NixOS 上从零搭环境，把每条 GDB 命令的真实输出贴出来，并逐段解释这些输出到底在说什么。"
category: Tutorial
tags:
  - Linux
  - C++
  - GDB
  - Debug
  - NixOS
draft: false
comment: true
---

我一直觉得 GDB 很重要，但以前真正遇到崩溃时，第一反应还是加几行 `std::cout`。后来我认真试了几次 GDB，发现卡住我的其实不是命令，而是输出：`Breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:25` 里哪一段是什么意思？`#1  0x0000555555556324 in ...` 的那个地址是谁的地址？为什么 `watch counter` 明明设置成功了，线程改了它却一次都没停？

所以这篇文章换了一种写法。我写了一个故意有错误的小程序，在 NixOS 上用一个 `flake.nix` 固定工具链，然后把一次完整调试过程中的每条命令和它的真实输出原样贴出来，再逐段解释输出的格式。你照着做的时候，可以把自己的终端和文章并排放着对照：地址、PID、LWP 这类运行时数字大概率和我不一样，但输出的"形状"应该完全一致。

我的环境是 NixOS 26.05、x86-64、GNU GDB 17.2、GCC 15.3.0。所有 GDB 会话都用 `gdb -q -nx` 启动：`-q` 去掉版权横幅，`-nx` 不读取 `~/.gdbinit`。后者很重要，我自己的 `~/.gdbinit` 里装了 gdb-dashboard，如果不加 `-nx`，你看到的会是一整屏仪表盘，而不是下面这些文本。

## 准备环境：NixOS 上的 flake.nix

如果你用的是 Debian、Arch 这类发行版，装上 `gdb` 和 `g++` 就可以直接跳到下一节。NixOS 上我更喜欢给实验目录放一个 `flake.nix`，这样工具链版本、调试符号和编译参数都是确定的：

```nix
{
  description = "GDB + C++20 debugging playground";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forEachSystem (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            # mkShell 自带 stdenv 的 gcc/g++、objdump 和 nm，这里只需要补上 gdb 和 gdbserver。
            packages = [ pkgs.gdb ];

            # 关闭 cc-wrapper 默认注入的加固参数（栈保护、FORTIFY、调用后清零寄存器等），
            # 让反汇编更接近普通发行版上 GCC 的输出。
            hardeningDisable = [ "all" ];

            # Nixpkgs 的 gdb 打过补丁，会从这个变量寻找分离的调试符号，这里给 glibc 用。
            NIX_DEBUG_INFO_DIRS = "${pkgs.glibc.debug}/lib/debug";

            shellHook = ''
              g++ --version | head -n 1
              gdb --version | head -n 1
            '';
          };
        });
    };
}
```

这里有三处和普通发行版不一样的地方，每一处我都踩过或者验证过。

**第一，`hardeningDisable`。** Nixpkgs 的 `g++` 不是裸的 GCC，而是一个 cc-wrapper 脚本，它会在你的参数前面悄悄插入一串加固参数。去掉 `hardeningDisable` 之后，用 `NIX_DEBUG=1` 可以看到 wrapper 实际做了什么：

```text
$ NIX_DEBUG=1 g++ -std=c++20 -g3 -O0 -c gdb_demo.cpp -o /dev/null 2>&1 | sed -n '/extra flags before/,/extra flags after/p'
extra flags before to /nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/bin/g++:
  -fPIC
  -fstack-clash-protection
  -O2
  -U_FORTIFY_SOURCE
  -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST
  -Wformat
  -Wformat-security
  -Werror=format-security
  -fzero-call-used-regs=used-gpr
  -fstrict-flex-arrays=1
  -fstack-protector-strong
  --param
  ssp-buffer-size=4
  -fno-strict-overflow
  -fno-omit-frame-pointer
  -mno-omit-leaf-frame-pointer
  -mtls-dialect=gnu2
original flags to /nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/bin/g++:
  -std=c++20
  -g3
  -O0
  -c
  gdb_demo.cpp
  -o
  /dev/null
extra flags after to /nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/bin/g++:
```

`original flags` 才是我写的那一行，`extra flags before` 全是 wrapper 加的。有意思的是里面还有一个 `-O2`，好在它排在我的 `-O0` 前面，GCC 以最后一个 `-O` 为准，所以优化级别没有被覆盖。但 `-fstack-protector-strong`、`-fzero-call-used-regs=used-gpr` 这些会实实在在地改变生成的指令：函数进出时多出栈 canary 的写入和检查，返回前多出清零寄存器的指令。对日常开发这是好事，对一篇要逐条读反汇编的文章就是噪声，所以我把它全关了。关掉之后再看同一条命令，`extra flags before` 里只剩 `-fno-omit-frame-pointer`、`-mno-omit-leaf-frame-pointer` 和 `-mtls-dialect=gnu2` 这三个和加固无关的默认参数。

**第二，`NIX_DEBUG_INFO_DIRS`。** 普通发行版上 glibc 的调试符号通常装在 `/usr/lib/debug`，NixOS 没有这个目录。Nixpkgs 里的 glibc 把调试符号拆到了单独的 `debug` 输出，而 Nixpkgs 的 gdb 打了一个补丁：如果环境变量 `NIX_DEBUG_INFO_DIRS` 存在，就用它作为 `debug-file-directory`。不设置时，`info sharedlibrary` 里每个库都带着 `(*)`：

```text
(gdb) info sharedlibrary
From                To                  Syms Read   Shared Object Library
0x00007ffff7fc4000  0x00007ffff7fff000  Yes (*)     /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/ld-linux-x86-64.so.2
0x00007ffff7c00000  0x00007ffff7e83000  Yes (*)     /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6
0x00007ffff7ec2000  0x00007ffff7fba000  Yes (*)     /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libm.so.6
0x00007ffff7e95000  0x00007ffff7ec2000  Yes (*)     /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libgcc_s.so.1
0x00007ffff7800000  0x00007ffff7a09000  Yes (*)     /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libc.so.6
(*): Shared library is missing debugging information.
```

最后一行就是 `(*)` 的图例：这个库缺少调试信息。设置之后，glibc 家族的 `ld-linux`、`libm`、`libc` 都不再带 `(*)`，只剩 GCC 运行时的 `libstdc++` 和 `libgcc_s`：

```text
(gdb) show debug-file-directory
The directory where separate debug symbols are searched for is "/nix/store/fk98h17sza0xxz9iw0fi5b2nn1h4c0pm-glibc-2.42-84-debug/lib/debug".
(gdb) info sharedlibrary
From                To                  Syms Read   Shared Object Library
0x00007ffff7fc4000  0x00007ffff7fff000  Yes         /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/ld-linux-x86-64.so.2
0x00007ffff7c00000  0x00007ffff7e83000  Yes (*)     /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6
0x00007ffff7ec2000  0x00007ffff7fba000  Yes         /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libm.so.6
0x00007ffff7e95000  0x00007ffff7ec2000  Yes (*)     /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libgcc_s.so.1
0x00007ffff7800000  0x00007ffff7a09000  Yes         /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libc.so.6
(*): Shared library is missing debugging information.
```

区别在调用栈里更明显。同样是主线程卡在 `join()` 里，没有 glibc 调试符号时是这样：

```text
(gdb) thread 1
[Switching to thread 1 (Thread 0x7ffff7e90780 (LWP 138338))]
#0  0x00007ffff78a5a22 in __syscall_cancel_arch () from /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libc.so.6
(gdb) bt
#0  0x00007ffff78a5a22 in __syscall_cancel_arch () from /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libc.so.6
#1  0x00007ffff789912c in __internal_syscall_cancel () from /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libc.so.6
#2  0x00007ffff78998ac in __futex_abstimed_wait_common () from /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libc.so.6
#3  0x00007ffff789ec8c in __pthread_clockjoin_ex () from /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libc.so.6
#4  0x00007ffff7cf2f1b in std::thread::join() () from /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6
#5  0x00005555555565af in main (argc=1, argv=0x7fffffffb868) at gdb_demo.cpp:36
```

有了之后，每一帧都有参数和 glibc 源文件位置：

```text
(gdb) thread 1
[Switching to thread 1 (Thread 0x7ffff7e90780 (LWP 165718))]
#0  __syscall_cancel_arch () at ../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S:56
warning: 56	../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S: No such file or directory
(gdb) bt
#0  __syscall_cancel_arch () at ../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S:56
#1  0x00007ffff789912c in __internal_syscall_cancel (a1=<optimized out>, a2=<optimized out>, a3=<optimized out>, a4=<optimized out>, a5=a5@entry=0,
    a6=a6@entry=4294967295, nr=202) at cancellation.c:49
#2  0x00007ffff78998ac in __futex_abstimed_wait_common64 (private=128, futex_word=0x7ffff77ff990, expected=<optimized out>, op=<optimized out>, abstime=0x0,
    cancel=true) at futex-internal.c:57
#3  __futex_abstimed_wait_common (futex_word=futex_word@entry=0x7ffff77ff990, expected=<optimized out>, clockid=clockid@entry=0, abstime=abstime@entry=0x0,
    private=private@entry=128, cancel=cancel@entry=true) at futex-internal.c:87
#4  0x00007ffff789993f in __GI___futex_abstimed_wait_cancelable64 (futex_word=futex_word@entry=0x7ffff77ff990, expected=<optimized out>,
    clockid=clockid@entry=0, abstime=abstime@entry=0x0, private=private@entry=128) at futex-internal.c:139
#5  0x00007ffff789ec8c in __pthread_clockjoin_ex (threadid=140737345746624, thread_return=0x0, clockid=0, abstime=0x0, block=<optimized out>)
    at pthread_join_common.c:108
#6  0x00007ffff7cf2f1b in std::thread::join() () from /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6
#7  0x00005555555565af in main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:36
```

那行 `warning: 56	../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S: No such file or directory` 不是错误。调试符号里记录了"这条指令来自 glibc 源码的第 56 行"，但我没有下载 glibc 源码，GDB 只是如实告诉我它找不到文件。函数名、参数和行号都已经可用了。

**第三，libstdc++ 的 pretty printer。** 后面你会看到 GDB 把 `std::vector` 打印成 `std::vector of length 4, capacity 4 = {3, 5, 7, 9}`，这不是 GDB 内置的能力，而是 libstdc++ 附带的一段 Python 脚本。GDB 只会从 `auto-load safe-path` 里的目录自动加载脚本，Nixpkgs 在构建 gdb 时把对应 GCC 的库目录写进了这个默认值：

```text
Reading symbols from ./gdb_demo...
(gdb) start
Temporary breakpoint 1 at 0x23ab: file gdb_demo.cpp, line 25.
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Temporary breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:25
25	    const std::string mode = argc > 1 ? argv[1] : "";
(gdb) info auto-load python-scripts
Loaded  Script
Yes     /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6.0.34-gdb.py
(gdb) show auto-load safe-path
List of directories from which it is safe to auto-load files is $debugdir:$datadir/auto-load:/nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib.
```

`Loaded Yes` 说明脚本已经生效。我猜如果你用的 GCC 和 gdb 来自不同的 nixpkgs 版本，store 路径对不上，这里就会变成 `No`，GDB 会打印一条 `auto-loading has been declined` 警告，`vector` 也会退化成原始的结构体。同一个 flake 里取 `pkgs.gdb` 和 mkShell 自带的 GCC，可以避免这个问题。

把 `flake.nix` 放进实验目录之后还有一个小坑。如果这个目录是一个 Git 仓库，flake 必须先被 Git 跟踪，否则 Nix 看不到它：

```text
$ nix develop
error: Path 'flake.nix' in the repository "/tmp/gdb-h2" is not tracked by Git.

       To make it visible to Nix, run:

       git -C "/tmp/gdb-h2" add "flake.nix"
```

`git add flake.nix` 之后再进入，shellHook 会打印两个版本号：

```text
$ git add flake.nix
$ nix develop
warning: Git tree '/tmp/gdb-h2' is dirty
g++ (GCC) 15.3.0
GNU gdb (GDB) 17.2
```

`Git tree is dirty` 只是提醒工作区有未提交的修改，可以忽略。第一次进入会顺便生成 `flake.lock`，把 nixpkgs 固定到某个具体提交。下面所有命令都在这个 shell 里执行。

## 实验对象：一个故意写错的 C++ 程序

我把下面的文件保存为 `gdb_demo.cpp`。文章里提到的所有行号都指这份文件，所以请原样复制，不要调整空行：

```cpp
#include <sys/wait.h>
#include <unistd.h>

#include <iostream>
#include <mutex>
#include <string>
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
    const std::string mode = argc > 1 ? argv[1] : "";
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

    if (mode == "--throw") {
        std::cout << values.at(values.size()) << "\n";
    }

    if (mode == "--fork") {
        const pid_t pid = fork();
        if (pid == 0) {
            std::cout << "child: pid=" << getpid() << "\n";
            return 0;
        }
        waitpid(pid, nullptr, 0);
        std::cout << "parent: child " << pid << " exited\n";
    }

    if (mode == "--crash") {
        int* pointer = nullptr;
        std::cout << "about to dereference a null pointer\n";
        std::cout << *pointer << "\n";
    }
}
```

它有五条值得观察的路径：`recursive_sum` 递归求和；两个线程在互斥锁保护下各把 `counter` 加 1000 次；`--throw` 用 `values.at(4)` 触发越界异常；`--fork` 创建一个子进程；`--crash` 解引用空指针。

编译命令：

```bash
g++ -std=c++20 -g3 -O0 -fno-omit-frame-pointer -Wall -Wextra \
    -o gdb_demo gdb_demo.cpp
```

`-g3` 把源码行号、变量位置、类型，甚至宏定义都写进可执行文件；`-O0` 关闭优化，让每一行源码都老老实实对应一段指令；`-fno-omit-frame-pointer` 保留 `rbp` 帧指针，后面读 `info frame` 和反汇编时会更直观。

在终端里依次运行四种模式：

```text
$ ./gdb_demo
total=24, average=8, expected_average=6
counter=2000
$ ./gdb_demo --crash
total=24, average=8, expected_average=6
counter=2000
about to dereference a null pointer
Segmentation fault         (core dumped) ./gdb_demo --crash
$ echo $?
139
$ ./gdb_demo --throw
total=24, average=8, expected_average=6
counter=2000
terminate called after throwing an instance of 'std::out_of_range'
  what():  vector::_M_range_check: __n (which is 4) >= this->size() (which is 4)
Aborted                    (core dumped) ./gdb_demo --throw
$ ./gdb_demo --fork
total=24, average=8, expected_average=6
counter=2000
child: pid=170023
parent: child 170023 exited
$ ./gdb_demo --crash | cat
$ nm gdb_demo_stripped
nm: gdb_demo_stripped: no symbols
```

`3 + 5 + 7 + 9 = 24`，两个线程各加 1000 次，`counter=2000` 也对。但平均值打印的是 `8`，而我写在输出里的期望值是 `6`。这就是第一个 bug：程序没有崩溃，编译器也没有警告，但状态已经错了。GDB 最擅长的恰恰是这种问题。

退出码 `139` 等于 `128 + 11`，11 是 `SIGSEGV` 的编号。`(core dumped)` 说明 systemd-coredump 已经把现场保存了下来，后面会用到。

最后一条 `./gdb_demo --crash | cat` 什么都没打印，这不是复制错误。当 `stdout` 连到终端时它是行缓冲的，每个 `\n` 都会刷新；连到管道时变成全缓冲，要攒满一块才写出去。程序在刷新之前就崩溃了，缓冲区里的三行输出跟着进程一起消失。后面用 GDB 的批处理模式时会再撞见它一次。

## 第一次会话：逐行读懂 GDB 在说什么

先看一次不加 `-q` 的启动，知道那段横幅长什么样：

```text
$ gdb -nx ./gdb_demo
GNU gdb (GDB) 17.2
Copyright (C) 2025 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.
Type "show copying" and "show warranty" for details.
This GDB was configured as "x86_64-unknown-linux-gnu".
Type "show configuration" for configuration details.
For bug reporting instructions, please see:
<https://www.gnu.org/software/gdb/bugs/>.
Find the GDB manual and other documentation resources online at:
    <http://www.gnu.org/software/gdb/documentation/>.

For help, type "help".
Type "apropos word" to search for commands related to "word"...
Reading symbols from ./gdb_demo...
```

前面是版权和帮助信息，真正有用的只有最后两行。`Reading symbols from ./gdb_demo...` 表示 GDB 在读取可执行文件里的调试信息；如果这里后面跟着 `(No debugging symbols found in ./gdb_demo)`，说明编译时没有加 `-g`，后面的源码级调试基本都用不了。`(gdb)` 是 GDB 的提示符，从这里开始输入的是 GDB 命令，不是 Shell 命令。

从现在开始我都用 `gdb -q -nx`。下面是第一次完整会话，我把它拆成几段来读。

### 设置断点

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break main
Breakpoint 1 at 0x23ab: file gdb_demo.cpp, line 25.
```

这一行要按字段读：

- `Breakpoint 1`：断点编号。后面的 `delete 1`、`disable 1` 都用这个编号。
- `at 0x23ab`：断点所在的指令地址。注意它很小，因为程序还没有运行，这只是函数在可执行文件里的偏移量。
- `file gdb_demo.cpp, line 25.`：GDB 把这个地址映射回的源码位置。

我让它停在 `main`，它却报告第 25 行而不是第 24 行的函数签名。这是因为 GDB 会跳过函数序言（保存 `rbp`、开辟栈空间的那几条指令），直接停在第一行真正的用户代码上。

### 启动程序

```text
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:25
25	    const std::string mode = argc > 1 ? argv[1] : "";
```

- `Starting program: /tmp/gdb-post/gdb_demo`：GDB fork 出一个子进程并执行目标程序。我的实验目录是 `/tmp/gdb-post`，你的路径会不一样。
- `[Thread debugging using libthread_db enabled]` 和下一行：GDB 加载了 glibc 附带的 `libthread_db`，用来理解线程。在 NixOS 上它来自 `/nix/store/...-glibc-.../lib`，只要这两行出现，线程调试就是正常的。
- `Breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:25`：命中了 1 号断点，停在 `main` 函数里，括号里是函数参数的当前值，最后是文件和行号。`argv` 是一个栈地址，它会随环境变量的总长度变化，所以你看到的数字几乎肯定和我不同。
- `25	    const std::string mode = ...`：行号、一个 Tab，然后是源码。

这里有一个我一开始完全理解错的点：**GDB 显示出来的这一行还没有执行**。它表示"下一步将要执行第 25 行"。此时 `mode` 还没有被构造。

### 单步和打印

```text
(gdb) next
26	    std::vector<int> values{3, 5, 7, 9};
(gdb) next
27	    const int total = recursive_sum(values, 0);
(gdb) print values
$1 = std::vector of length 4, capacity 4 = {3, 5, 7, 9}
(gdb) next
28	    const double average = static_cast<double>(total) / (values.size() - 1);
(gdb) print total
$2 = 24
(gdb) print average
$3 = 6.9533558069247378e-310
(gdb) next
29	    std::cout << "total=" << total << ", average=" << average
(gdb) print average
$4 = 8
```

`next` 执行当前行，然后打印下一个将要执行的行。执行两次之后停在第 27 行，此时第 26 行已经执行完，`values` 已经构造好了，所以可以 `print values`。

`$1 = std::vector of length 4, capacity 4 = {3, 5, 7, 9}` 也要拆开读：

- `$1` 是 GDB 的值历史编号。每次 `print` 的结果都会存成 `$1`、`$2`、`$3`……，后面可以当变量用。
- `std::vector of length 4, capacity 4 = {...}` 是 libstdc++ pretty printer 的输出格式：长度、容量、元素。后面我会用 `print/r` 看看它下面的原始结构体。

接着停在第 28 行时打印 `total` 得到 `24`，说明递归求和是对的。然后打印 `average` 得到 `6.9533558069247378e-310`：这不是 GDB 出错，而是第 28 行还没执行，`average` 所在的栈内存里还是上一个使用者留下的残留字节，按 `double` 解释就成了一个极小的数。再 `next` 一次，`average` 变成了 `8`。

到这里第一个 bug 已经定位了：`total` 是对的，`average` 在第 28 行被算成了 `8`，问题只能在 `/ (values.size() - 1)` 里。

### 跨行语句与程序输出

```text
(gdb) next
30	              << ", expected_average=6\n";
(gdb) next
total=24, average=8, expected_average=6
32	    int counter = 0;
```

第 29 到 30 行是一条跨两行的语句，所以 `next` 会先停在第 30 行。直到这条语句真正执行完，`total=24, average=8, expected_average=6` 才出现在屏幕上。程序自己的输出和 GDB 的输出混在同一个终端里，没有任何前缀区分，这一点要习惯。

### 运行到结束

```text
(gdb) continue
Continuing.
[New Thread 0x7ffff77ff6c0 (LWP 154515)]
[Thread 0x7ffff77ff6c0 (LWP 154515) exited]
[New Thread 0x7ffff6ffe6c0 (LWP 154516)]
counter=2000
[Thread 0x7ffff6ffe6c0 (LWP 154516) exited]
[Inferior 1 (process 154466) exited normally]
```

- `Continuing.`：放行，直到下一个断点、信号或进程退出。
- `[New Thread 0x7ffff77ff6c0 (LWP 154515)]`：程序创建了一个线程。`0x7ffff77ff6c0` 是 `pthread_t` 的值，在 glibc 里它是线程控制块的地址；`LWP 154515` 是内核里的线程 ID，也就是 `ps -L` 或 `top -H` 里看到的那个数字。
- `[Thread ... exited]`：线程退出。两个线程的创建和退出顺序每次运行都可能不同。
- `[Inferior 1 (process 154466) exited normally]`：inferior 是 GDB 对"被调试进程"的称呼，`exited normally` 表示退出码为 0。如果退出码非 0，会显示成 `exited with code 01` 这样的形式。

如果进程还活着时输入 `quit`，GDB 会确认一次：

```text
(gdb) quit
A debugging session is active.

	Inferior 1 [process 131334] will be killed.

Quit anyway? (y or n)
```

输入 `y` 就会杀掉被调试进程并退出。

## 断点：先决定在哪里停

我调试时通常先问自己：程序应该在哪些位置停下来？下面这组命令一次性设置了五种断点，然后查看、禁用、删除它们：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break main
Breakpoint 1 at 0x23ab: file gdb_demo.cpp, line 25.
(gdb) break recursive_sum
Breakpoint 2 at 0x22da: file gdb_demo.cpp, line 11.
(gdb) break gdb_demo.cpp:14 if index == 2
Breakpoint 3 at 0x22f8: file gdb_demo.cpp, line 14.
(gdb) tbreak gdb_demo.cpp:38
Temporary breakpoint 4 at 0x25be: file gdb_demo.cpp, line 38.
(gdb) rbreak ^worker
Breakpoint 5 at 0x233c: file gdb_demo.cpp, line 18.
void worker(int&, std::mutex&);
Successfully created breakpoint 5.
(gdb) info breakpoints
Num     Type           Disp Enb Address            What
1       breakpoint     keep y   0x00000000000023ab in main(int, char**) at gdb_demo.cpp:25
2       breakpoint     keep y   0x00000000000022da in recursive_sum(std::vector<int, std::allocator<int> > const&, unsigned long) at gdb_demo.cpp:11
3       breakpoint     keep y   0x00000000000022f8 in recursive_sum(std::vector<int, std::allocator<int> > const&, unsigned long) at gdb_demo.cpp:14
	stop only if index == 2
4       breakpoint     del  y   0x00000000000025be in main(int, char**) at gdb_demo.cpp:38
5       breakpoint     keep y   0x000000000000233c in worker(int&, std::mutex&) at gdb_demo.cpp:18
(gdb) disable 2 4
```

五种写法分别是：按函数名、按函数名、按"文件:行号"加条件、临时断点、正则表达式。`rbreak ^worker` 会给所有名字匹配 `^worker` 的函数下断点，并把匹配到的函数签名 `void worker(int&, std::mutex&);` 打印出来，让你确认它没有误伤别的函数。

`info breakpoints` 是一张表，列的含义是：

- `Num`：断点编号。
- `Type`：`breakpoint` 是普通断点，后面还会看到 `hw watchpoint` 和 `catchpoint`。
- `Disp`：命中后的处置方式。`keep` 表示保留，`del` 表示命中一次就删除，这就是 `tbreak` 的"临时"。
- `Enb`：是否启用，`y` 或 `n`。
- `Address`：指令地址。
- `What`：完整的函数签名和源码位置。C++ 的函数会显示带参数类型的全名，`recursive_sum(std::vector<int, std::allocator<int> > const&, unsigned long)` 就是 `recursive_sum` 展开模板和 `std::size_t` 之后的样子。
- `stop only if index == 2`：条件断点的条件，单独缩进一行。

`disable 2 4` 暂时关掉 2 号和 4 号断点，但保留它们的编号和条件。然后运行：

```text
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:25
25	    const std::string mode = argc > 1 ? argv[1] : "";
(gdb) continue
Continuing.

Breakpoint 3, recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=2) at gdb_demo.cpp:14
14	    return values[index] + recursive_sum(values, index + 1);
(gdb) print index
$1 = 2
(gdb) info breakpoints
Num     Type           Disp Enb Address            What
1       breakpoint     keep y   0x00005555555563ab in main(int, char**) at gdb_demo.cpp:25
	breakpoint already hit 1 time
2       breakpoint     keep n   0x00005555555562da in recursive_sum(std::vector<int, std::allocator<int> > const&, unsigned long) at gdb_demo.cpp:11
3       breakpoint     keep y   0x00005555555562f8 in recursive_sum(std::vector<int, std::allocator<int> > const&, unsigned long) at gdb_demo.cpp:14
	stop only if index == 2
	breakpoint already hit 1 time
4       breakpoint     del  n   0x00005555555565be in main(int, char**) at gdb_demo.cpp:38
5       breakpoint     keep y   0x000055555555633c in worker(int&, std::mutex&) at gdb_demo.cpp:18
```

条件断点只在 `index=2` 那一层递归停下，前面 `index=0` 和 `index=1` 的两次经过都被 GDB 在后台判断后自动放行了。

再看第二次 `info breakpoints`，有两处变化。第一，`Address` 从 `0x00000000000023ab` 变成了 `0x00005555555563ab`：程序是 PIE（位置无关可执行文件），运行时被加载到 `0x555555554000`，`0x555555554000 + 0x23ab = 0x5555555563ab`。GDB 默认关闭了地址空间随机化（`show disable-randomization` 是 `on`），所以每次运行的基址都一样，这也是为什么你的地址很可能和我的一模一样，而栈地址却不一样。第二，多出了 `breakpoint already hit 1 time`，命中计数。2 号和 4 号的 `Enb` 是 `n`。

接着删除条件断点，继续运行到线程里：

```text
(gdb) delete 3
(gdb) continue
Continuing.
total=24, average=8, expected_average=6
[New Thread 0x7ffff77ff6c0 (LWP 154927)]
[Switching to Thread 0x7ffff77ff6c0 (LWP 154927)]

Thread 2 "gdb_demo" hit Breakpoint 5, worker (counter=@0x7fffffffb60c: 0, mutex=...) at gdb_demo.cpp:18
18	    for (int i = 0; i < 1000; ++i) {
(gdb) continue
Continuing.
[New Thread 0x7ffff6ffe6c0 (LWP 154928)]
[Switching to Thread 0x7ffff6ffe6c0 (LWP 154928)]

Thread 3 "gdb_demo" hit Breakpoint 5, worker (counter=@0x7fffffffb60c: 0, mutex=...) at gdb_demo.cpp:18
18	    for (int i = 0; i < 1000; ++i) {
(gdb) info breakpoints
Num     Type           Disp Enb Address            What
1       breakpoint     keep y   0x00005555555563ab in main(int, char**) at gdb_demo.cpp:25
	breakpoint already hit 1 time
2       breakpoint     keep n   0x00005555555562da in recursive_sum(std::vector<int, std::allocator<int> > const&, unsigned long) at gdb_demo.cpp:11
4       breakpoint     del  n   0x00005555555565be in main(int, char**) at gdb_demo.cpp:38
5       breakpoint     keep y   0x000055555555633c in worker(int&, std::mutex&) at gdb_demo.cpp:18
	breakpoint already hit 2 times
```

线程命中断点时的格式和主线程略有不同：

- `[Switching to Thread 0x7ffff77ff6c0 (LWP 154927)]`：GDB 把"当前线程"切换到了命中断点的那个线程。
- `Thread 2 "gdb_demo" hit Breakpoint 5`：`Thread 2` 是 GDB 自己给线程分配的编号（主线程是 1），不是 LWP；`"gdb_demo"` 是线程名，新线程默认继承进程名。
- `counter=@0x7fffffffb60c: 0`：`counter` 是引用，GDB 用 `@地址: 值` 的格式同时显示它指向哪里和当前值。
- `mutex=...`：参数没有被打印，不是出错。GDB 默认的 `print frame-arguments` 是 `scalars`，在停止行和调用栈里只展开标量参数，结构体和类一律折叠成 `...`。前面 `recursive_sum` 的 `values=std::vector of length 4, capacity 4 = {...}` 也是同一条规则，只是 pretty printer 额外给出了长度和容量。

两个线程分别命中一次，所以 5 号断点显示 `already hit 2 times`。

### 还不存在的函数：pending 断点

如果断点要打在一个共享库里，而库还没被加载，GDB 会先问你：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break execute_native_thread_routine
Function "execute_native_thread_routine" not defined.
Make breakpoint pending on future shared library load? (y or [n]) y
Breakpoint 1 (execute_native_thread_routine) pending.
(gdb) info breakpoints
Num     Type           Disp Enb Address    What
1       breakpoint     keep y   <PENDING>  execute_native_thread_routine
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
total=24, average=8, expected_average=6
[New Thread 0x7ffff77ff6c0 (LWP 155304)]
[New Thread 0x7ffff6ffe6c0 (LWP 155305)]
[Switching to Thread 0x7ffff77ff6c0 (LWP 155304)]

Thread 2 "gdb_demo" hit Breakpoint 1, 0x00007ffff7cf2e90 in execute_native_thread_routine ()
   from /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6
(gdb) info breakpoints
Num     Type           Disp Enb Address            What
1       breakpoint     keep y   0x00007ffff7cf2e90 <execute_native_thread_routine>
	breakpoint already hit 1 time
```

`execute_native_thread_routine` 是 libstdc++ 里每个 `std::thread` 的入口函数。程序启动前 libstdc++ 还没加载，GDB 找不到这个符号，所以询问是否设置 pending 断点。回答 `y` 之后，`Address` 列显示 `<PENDING>`；运行后库被加载，断点被解析到真实地址 `0x00007ffff7cf2e90`。

命中时的停止行和之前也不一样：`0x00007ffff7cf2e90 in execute_native_thread_routine () from /nix/store/...libstdc++.so.6`。函数名后面是空括号，最后是 `from 库路径` 而不是 `at 文件:行号`，这就是"没有调试信息"的样子：GDB 只知道符号名，不知道参数和源码。前面讲 flake 时提到 `libstdc++` 依然带着 `(*)`，指的就是这个。

## 控制执行：不止 next 和 continue

`next` 和 `continue` 之外，还有几个命令可以更精确地控制程序跑到哪里：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) start
Temporary breakpoint 1 at 0x23ab: file gdb_demo.cpp, line 25.
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Temporary breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:25
25	    const std::string mode = argc > 1 ? argv[1] : "";
(gdb) advance 29
main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:29
29	    std::cout << "total=" << total << ", average=" << average
(gdb) until 32
total=24, average=8, expected_average=6
main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:32
32	    int counter = 0;
```

- `start` 等于"在 `main` 上设一个临时断点再 `run`"，所以输出里是 `Temporary breakpoint 1`。
- `advance 29` 运行到第 29 行。它的停止行开头没有 `Breakpoint N,`，因为这不是断点命中，只是到达了目标位置。
- `until 32` 在这里的效果和 `advance` 类似；它真正的用途是在循环末尾使用时直接跑完整个循环，而不是一圈一圈地 `next`。中途第 29 到 30 行执行完毕，所以那行输出出现在中间。

`finish`、`return` 和 `jump` 更激进，我用它们做一个反事实实验：如果 `index=2` 那一层递归直接返回 100，会发生什么？

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break recursive_sum if index == 2
Breakpoint 1 at 0x22da: file gdb_demo.cpp, line 11.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Breakpoint 1, recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=2) at gdb_demo.cpp:11
11	    if (index == values.size()) {
(gdb) return 100
Make recursive_sum(std::vector<int, std::allocator<int> > const&, unsigned long) return now? (y or n) y
#0  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=1) at gdb_demo.cpp:14
14	    return values[index] + recursive_sum(values, index + 1);
(gdb) finish
Run till exit from #0  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=1) at gdb_demo.cpp:14
0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=0) at gdb_demo.cpp:14
14	    return values[index] + recursive_sum(values, index + 1);
Value returned is $1 = 105
(gdb) finish
Run till exit from #0  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=0) at gdb_demo.cpp:14
0x000055555555642c in main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:27
27	    const int total = recursive_sum(values, 0);
Value returned is $2 = 108
(gdb) next
28	    const double average = static_cast<double>(total) / (values.size() - 1);
(gdb) print total
$3 = 108
(gdb) jump 32
Continuing at 0x5555555564f4.
[New Thread 0x7ffff77ff6c0 (LWP 156151)]
[New Thread 0x7ffff6ffe6c0 (LWP 156152)]
[Thread 0x7ffff77ff6c0 (LWP 156151) exited]
counter=2000
[Thread 0x7ffff6ffe6c0 (LWP 156152) exited]
[Inferior 1 (process 156113) exited normally]
```

逐段读：

- `return 100` 会先确认，因为它会强制弹出当前栈帧，函数剩下的代码不再执行。确认后 GDB 打印新的当前帧 `#0  0x0000555555556324 in recursive_sum (..., index=1)`，这是调用者那一层。注意行首多了一个地址，后面讲栈帧时会解释。
- `finish` 运行到当前函数返回。`Run till exit from #0 ...` 说明从哪一帧开始，接下来一行是返回到的位置，最后 `Value returned is $1 = 105` 是返回值，同样进入了值历史。`105 = 5 + 100`，`108 = 3 + 105`。
- 回到 `main` 后 `print total` 得到 `108`，被伪造的返回值一路传了上来。
- `jump 32` 让程序从第 32 行继续执行，`Continuing at 0x5555555564f4.` 是第 32 行对应的地址。第 28 到 30 行被整个跳过了，所以这次运行的输出里根本没有 `total=...` 那一行。

`return` 和 `jump` 是实验工具，不是修复手段。跳过构造函数、析构函数或者加锁操作，很容易把程序带进一个真实执行中永远不会出现的状态。

还有一个 `starti`，它停在进程的第一条机器指令：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) starti
Starting program: /tmp/gdb-post/gdb_demo

Program stopped.
0x00007ffff7fe3e00 in _start () from /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/ld-linux-x86-64.so.2
(gdb) x/i $pc
=> 0x7ffff7fe3e00 <_start>:	mov    %rsp,%rdi
```

`Program stopped.` 没有断点编号，因为这是 `starti` 本身的停止。第一条指令不在 `main` 里，也不在 `gdb_demo` 里，而是在动态链接器 `ld-linux-x86-64.so.2` 的 `_start`。`x/i $pc` 的格式后面讲内存时再展开。

## 栈帧：递归时我到底在看谁

这一节我把断点设在第 12 行 `return 0;`，也就是递归最深处：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break gdb_demo.cpp:12
Breakpoint 1 at 0x22f1: file gdb_demo.cpp, line 12.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Breakpoint 1, recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=4) at gdb_demo.cpp:12
12	        return 0;
(gdb) bt
#0  recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=4) at gdb_demo.cpp:12
#1  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=3) at gdb_demo.cpp:14
#2  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=2) at gdb_demo.cpp:14
#3  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=1) at gdb_demo.cpp:14
#4  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=0) at gdb_demo.cpp:14
#5  0x000055555555642c in main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:27
```

`bt` 是 `backtrace` 的缩写，每一行是一个栈帧，从当前帧往调用者方向排列：

- `#0`、`#1`……：帧编号。`#0` 是当前正在执行的函数，编号越大越靠近 `main`。
- `0x0000555555556324`：这一帧的 pc，也就是这一帧"停在哪条指令"。对 `#1` 到 `#5` 来说，它是返回地址：被调用的函数返回后将从这里继续。
- `in recursive_sum (...)`：函数名和参数。
- `at gdb_demo.cpp:14`：pc 对应的源码位置。

`#0` 前面没有地址，是因为当前 pc 恰好是第 12 行的第一条指令，GDB 认为直接显示行号就够了。`#1` 到 `#4` 的地址完全相同，因为它们都是同一条 `call recursive_sum` 指令之后的那条指令，只是属于不同层的递归。4 个元素加上终止那一层，一共 5 层 `recursive_sum`，再加上 `main`，正好 6 帧。

切换到某一帧再看：

```text
(gdb) frame 2
#2  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=2) at gdb_demo.cpp:14
14	    return values[index] + recursive_sum(values, index + 1);
(gdb) print index
$1 = 2
(gdb) info args
values = std::vector of length 4, capacity 4 = {3, 5, 7, 9}
index = 2
(gdb) info locals
No locals.
(gdb) up
#3  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=1) at gdb_demo.cpp:14
14	    return values[index] + recursive_sum(values, index + 1);
(gdb) down
#2  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=2) at gdb_demo.cpp:14
14	    return values[index] + recursive_sum(values, index + 1);
```

`frame 2` 切换到 2 号帧，打印这一帧的摘要和源码行。之后的 `print index` 读取的是 **当前选中帧** 里的 `index`，所以得到 `2`，而不是程序实际停住的那一帧里的 `4`。`info args` 打印当前帧的参数，这里没有折叠，`values` 完整展开；`info locals` 打印局部变量，`recursive_sum` 没有局部变量，所以是 `No locals.`。`up` 往调用者方向走一帧，`down` 往回走。

`info frame` 的输出最密集：

```text
(gdb) info frame
Stack level 2, frame at 0x7fffffffb550:
 rip = 0x555555556324 in recursive_sum (gdb_demo.cpp:14); saved rip = 0x555555556324
 called by frame at 0x7fffffffb580, caller of frame at 0x7fffffffb520
 source language c++.
 Arglist at 0x7fffffffb540, args: values=std::vector of length 4, capacity 4 = {...}, index=2
 Locals at 0x7fffffffb540, Previous frame's sp is 0x7fffffffb550
 Saved registers:
  rbx at 0x7fffffffb538, rbp at 0x7fffffffb540, rip at 0x7fffffffb548
```

- `Stack level 2`：帧编号。
- `frame at 0x7fffffffb550`：这一帧的 CFA（canonical frame address），可以理解为调用这个函数之前的栈指针值。每一帧有唯一的 CFA。
- `rip = 0x555555556324 in recursive_sum (gdb_demo.cpp:14)`：这一帧的 pc。
- `saved rip = 0x555555556324`：这一帧返回后要跳到的地址。因为它的调用者也是 `recursive_sum`，所以两者相同。
- `called by frame at ...`、`caller of frame at ...`：上一帧和下一帧的 CFA。
- `Arglist at`、`Locals at`：参数和局部变量相对的基址，在 `-O0` 下就是 `rbp`。
- `Saved registers`：这一帧保存了哪些寄存器以及保存在哪里。`rip at 0x7fffffffb548` 就是返回地址在栈上的位置。

最后回到 0 号帧，连续 `finish` 三次，看返回值怎样一层层累加：

```text
(gdb) frame 0
#0  recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=4) at gdb_demo.cpp:12
12	        return 0;
(gdb) finish
Run till exit from #0  recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=4) at gdb_demo.cpp:12
0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=3) at gdb_demo.cpp:14
14	    return values[index] + recursive_sum(values, index + 1);
Value returned is $2 = 0
(gdb) finish
Run till exit from #0  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=3) at gdb_demo.cpp:14
0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=2) at gdb_demo.cpp:14
14	    return values[index] + recursive_sum(values, index + 1);
Value returned is $3 = 9
(gdb) finish
Run till exit from #0  0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=2) at gdb_demo.cpp:14
0x0000555555556324 in recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=1) at gdb_demo.cpp:14
14	    return values[index] + recursive_sum(values, index + 1);
Value returned is $4 = 16
```

`0`、`9 = 9 + 0`、`16 = 7 + 9`。每次 `finish` 之后停在调用者那一行的中间，所以停止行前面都带着地址。

## 数据：让 GDB 替我问问题

停在第 29 行，`total` 和 `average` 都已经算好了：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break 29
Breakpoint 1 at 0x248d: file gdb_demo.cpp, line 29.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:29
29	    std::cout << "total=" << total << ", average=" << average
(gdb) print total
$1 = 24
(gdb) print average
$2 = 8
(gdb) print $
$3 = 8
(gdb) print $1 + 1
$4 = 25
(gdb) print/x total
$5 = 0x18
(gdb) print/t total
$6 = 11000
(gdb) whatis values
type = std::vector<int>
(gdb) whatis values[0]
type = int
(gdb) ptype recursive_sum
type = int (const std::vector<int> &, std::size_t)
(gdb) print values[2]
$7 = 7
(gdb) print values.size()
$8 = 4
(gdb) print values.data()
Cannot evaluate function -- may be inlined
(gdb) print (double) total / values.size()
$9 = 6
```

- `print $` 取最近一次的值，`print $1 + 1` 用值历史做运算，结果依然进入历史，成为 `$4`。
- `print/x` 和 `print/t` 是输出格式，`/x` 十六进制，`/t` 二进制，`/d` 十进制，`/c` 字符。`24` 是 `0x18`，也是 `11000`。
- `whatis` 给出表达式的类型名；`ptype` 会展开类型，对函数就是完整的签名。对 `std::vector` 用 `ptype` 会打印出整个类定义，几百行，一般我用 `whatis`。
- `print values[2]` 和 `print values.size()` 可以工作，`print values.data()` 却报 `Cannot evaluate function -- may be inlined`。这个报错信息有点误导。真正的原因是 `data()` 是一个模板成员函数，我的程序从来没有调用过它，编译器就根本没有生成这个函数的代码，GDB 没有东西可调用。`operator[]` 和 `size()` 在程序里用过，所以它们存在。
- `print (double) total / values.size()` 得到 `6`，这是我对正确公式的一次试算，结果和 `expected_average` 一致。

在 GDB 里调用函数要谨慎。`print some_function()` 会真的在被调试进程里执行这个函数，它可能修改全局状态、申请内存或者拿锁。我优先读取变量和内存，只在确认函数没有副作用时才调用它。

`display` 让某个表达式在每次停下时自动打印：

```text
(gdb) display total
1: total = 24
(gdb) display/x counter
2: /x counter = 0xffffffff
(gdb) next
30	              << ", expected_average=6\n";
1: total = 24
2: /x counter = 0xffffffff
(gdb) info display
Auto-display expressions now in effect:
Num Enb Expression
1:   y  total
2:   y  /x counter
(gdb) undisplay 2
(gdb) next
total=24, average=8, expected_average=6
32	    int counter = 0;
1: total = 24
```

`1: total = 24` 开头的 `1:` 是 display 编号，`/x counter` 会把格式也显示出来。此时 `counter` 还没初始化，`0xffffffff` 是栈上的残留值。`info display` 列出所有自动显示项，`undisplay 2` 删除 2 号。

### pretty printer 下面是什么

pretty printer 很方便，但有时我想知道对象的真实布局。停在第 34 行：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break 34
Breakpoint 1 at 0x2518: file gdb_demo.cpp, line 34.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
total=24, average=8, expected_average=6

Breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:34
34	    std::thread first(worker, std::ref(counter), std::ref(mutex));
(gdb) print/r values
$1 = {<std::_Vector_base<int, std::allocator<int> >> = {
    _M_impl = {<std::allocator<int>> = {<std::__new_allocator<int>> = {<No data fields>}, <No data fields>}, <std::_Vector_base<int, std::allocator<int> >::_Vector_impl_data> = {_M_start = 0x55555556f320, _M_finish = 0x55555556f330, _M_end_of_storage = 0x55555556f330}, <No data fields>}}, <No data fields>}
(gdb) print &values[0]
$2 = (int *) 0x55555556f320
(gdb) print values[0]@4
$3 = {3, 5, 7, 9}
(gdb) print mutex
$4 = {<std::__mutex_base> = {_M_mutex = {__data = {__lock = 0, __count = 0, __owner = 0, __nusers = 0, __kind = 0, __spins = 0, __elision = 0, __list = {
          __prev = 0x0, __next = 0x0}}, __size = '\000' <repeats 39 times>, __align = 0}}, <No data fields>}
(gdb) set print pretty on
(gdb) print mutex
$5 = {
  <std::__mutex_base> = {
    _M_mutex = {
      __data = {
        __lock = 0,
        __count = 0,
        __owner = 0,
        __nusers = 0,
        __kind = 0,
        __spins = 0,
        __elision = 0,
        __list = {
          __prev = 0x0,
          __next = 0x0
        }
      },
      __size = '\000' <repeats 39 times>,
      __align = 0
    }
  }, <No data fields>}
```

`print/r` 的 `r` 是 raw，绕过 pretty printer。原来 `std::vector<int>` 的本体只有三个指针：`_M_start` 指向第一个元素，`_M_finish` 指向最后一个元素之后，`_M_end_of_storage` 指向已分配内存的末尾。`0x...f330 - 0x...f320 = 16` 字节，正好 4 个 `int`，这就是 `length 4, capacity 4` 的来源。尖括号 `<std::_Vector_base<...>>` 表示基类子对象，`<No data fields>` 表示空基类。

`print values[0]@4` 里的 `@` 是 GDB 特有的运算符：从左边这个对象开始，把连续 4 个同类型元素当成数组打印。面对一个裸指针或者 C 数组时它非常有用。

`std::mutex` 没有 pretty printer，默认挤在一行里很难读。`set print pretty on` 之后，每个字段单独一行并且有缩进。这个 `mutex` 里全是 0，因为第 33 行已经构造过它，而且此时还没有人加锁。

## 内存、寄存器与汇编

`x` 命令直接读内存，格式是 `x/nfu 地址`：`n` 是数量，`f` 是格式（`d` 十进制、`x` 十六进制、`s` 字符串、`i` 指令），`u` 是单位（`b` 1 字节、`h` 2 字节、`w` 4 字节、`g` 8 字节）。接着上面的会话：

```text
(gdb) x/4dw &values[0]
0x55555556f320:	3	5	7	9
(gdb) x/16xb &values[0]
0x55555556f320:	0x03	0x00	0x00	0x00	0x05	0x00	0x00	0x00
0x55555556f328:	0x07	0x00	0x00	0x00	0x09	0x00	0x00	0x00
(gdb) x/2xg &values[0]
0x55555556f320:	0x0000000500000003	0x0000000900000007
(gdb) x/s argv[0]
0x7fffffffbf28:	"/tmp/gdb-post/gdb_demo"
(gdb) x/3i $pc
=> 0x555555556518 <main(int, char**)+404>:	lea    -0xf0(%rbp),%rax
   0x55555555651f <main(int, char**)+411>:	mov    %rax,%rdi
   0x555555556522 <main(int, char**)+414>:	call   0x555555557463 <_ZSt3refISt5mutexESt17reference_wrapperIT_ERS2_>
(gdb) print $pc
$6 = (void (*)(void)) 0x555555556518 <main(int, char**)+404>
(gdb) info registers rip rsp rbp
rip            0x555555556518      0x555555556518 <main(int, char**)+404>
rsp            0x7fffffffb5b0      0x7fffffffb5b0
rbp            0x7fffffffb6d0      0x7fffffffb6d0
```

每一行输出都是 `地址:` 加上从这个地址开始的若干个值，用 Tab 分隔。

- `x/4dw` 按 4 字节十进制读 4 个单元，就是 `3 5 7 9`。
- `x/16xb` 按字节读 16 个。`3` 被存成 `0x03 0x00 0x00 0x00`，低位字节在低地址，这是 x86-64 的小端序。一行显示 8 个字节，所以第二行从 `0x...f328` 开始。
- `x/2xg` 按 8 字节读。同样 8 个字节被当成一个整数时，小端序让高地址的 `5` 跑到了高位：`0x0000000500000003`。三种视角看的是完全相同的 16 个字节。
- `x/s argv[0]` 把地址当成 C 字符串读，直到遇到 `\0`。
- `x/3i $pc` 反汇编 3 条指令。`=>` 标出当前 pc，`<main(int, char**)+404>` 是"这条指令距离 `main` 起点 404 字节"。这里用的是 GDB 默认的 AT&T 语法：源操作数在前，目标在后，寄存器带 `%` 前缀，`-0xf0(%rbp)` 表示地址 `rbp - 0xf0`。`call` 后面那个长长的 `_ZSt3ref...` 是 `std::ref<std::mutex>` 被 mangle 之后的符号名。
- `$pc` 是 GDB 对程序计数器的通用名字，x86-64 上等于 `$rip`。
- `info registers` 的三列是：寄存器名、十六进制原始值、"自然"格式。对 `rip` 来说自然格式是符号加偏移，对 `rsp` 这类通用寄存器就是再显示一次数值。

整个函数的反汇编用 `disassemble /s`，它把源码行和指令交错排列。我在 `recursive_sum` 入口处执行：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break recursive_sum
Breakpoint 1 at 0x22da: file gdb_demo.cpp, line 11.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Breakpoint 1, recursive_sum (values=std::vector of length 4, capacity 4 = {...}, index=0) at gdb_demo.cpp:11
11	    if (index == values.size()) {
(gdb) disassemble /s recursive_sum
Dump of assembler code for function _Z13recursive_sumRKSt6vectorIiSaIiEEm:
gdb_demo.cpp:
10	int recursive_sum(const std::vector<int>& values, std::size_t index) {
   0x00005555555562c9 <+0>:	push   %rbp
   0x00005555555562ca <+1>:	mov    %rsp,%rbp
   0x00005555555562cd <+4>:	push   %rbx
   0x00005555555562ce <+5>:	sub    $0x18,%rsp
   0x00005555555562d2 <+9>:	mov    %rdi,-0x18(%rbp)
   0x00005555555562d6 <+13>:	mov    %rsi,-0x20(%rbp)

11	    if (index == values.size()) {
=> 0x00005555555562da <+17>:	mov    -0x18(%rbp),%rax
   0x00005555555562de <+21>:	mov    %rax,%rdi
   0x00005555555562e1 <+24>:	call   0x555555556fae <_ZNKSt6vectorIiSaIiEE4sizeEv>
   0x00005555555562e6 <+29>:	cmp    %rax,-0x20(%rbp)
   0x00005555555562ea <+33>:	sete   %al
   0x00005555555562ed <+36>:	test   %al,%al
   0x00005555555562ef <+38>:	je     0x5555555562f8 <_Z13recursive_sumRKSt6vectorIiSaIiEEm+47>

12	        return 0;
   0x00005555555562f1 <+40>:	mov    $0x0,%eax
   0x00005555555562f6 <+45>:	jmp    0x555555556326 <_Z13recursive_sumRKSt6vectorIiSaIiEEm+93>

13	    }
14	    return values[index] + recursive_sum(values, index + 1);
   0x00005555555562f8 <+47>:	mov    -0x20(%rbp),%rdx
   0x00005555555562fc <+51>:	mov    -0x18(%rbp),%rax
   0x0000555555556300 <+55>:	mov    %rdx,%rsi
   0x0000555555556303 <+58>:	mov    %rax,%rdi
   0x0000555555556306 <+61>:	call   0x555555557186 <_ZNKSt6vectorIiSaIiEEixEm>
   0x000055555555630b <+66>:	mov    (%rax),%ebx
   0x000055555555630d <+68>:	mov    -0x20(%rbp),%rax
   0x0000555555556311 <+72>:	lea    0x1(%rax),%rdx
   0x0000555555556315 <+76>:	mov    -0x18(%rbp),%rax
   0x0000555555556319 <+80>:	mov    %rdx,%rsi
   0x000055555555631c <+83>:	mov    %rax,%rdi
   0x000055555555631f <+86>:	call   0x5555555562c9 <_Z13recursive_sumRKSt6vectorIiSaIiEEm>
   0x0000555555556324 <+91>:	add    %ebx,%eax

15	}
   0x0000555555556326 <+93>:	mov    -0x8(%rbp),%rbx
   0x000055555555632a <+97>:	leave
   0x000055555555632b <+98>:	ret
End of assembler dump.
```

读法和 `x/i` 一样，只是按源码行分了组：`10	int recursive_sum(...)` 下面的 6 条指令是函数序言，保存 `rbp` 和 `rbx`，开辟 `0x18` 字节栈空间，再把两个参数 `rdi`、`rsi` 存到栈上。`=>` 指向第 11 行的第一条指令，这正是断点所在的位置。

这段反汇编顺便解开了前面的一个谜题。第 14 行的 `call 0x5555555562c9 <_Z13recursive_sum...>` 是递归调用本身，紧跟在它后面的是 `0x0000555555556324 <+91>:	add %ebx,%eax`。`0x555555556324` 就是前面 `bt` 里 `#1` 到 `#4` 共用的那个返回地址：递归返回后，把 `values[index]`（之前存进了 `ebx`）加到返回值 `eax` 上。

`stepi` 和 `nexti` 是指令级的单步，区别和 `step`、`next` 一样，`nexti` 不会进入 `call`：

```text
(gdb) stepi
0x00005555555562de	11	    if (index == values.size()) {
(gdb) stepi
0x00005555555562e1	11	    if (index == values.size()) {
(gdb) x/i $pc
=> 0x5555555562e1 <_Z13recursive_sumRKSt6vectorIiSaIiEEm+24>:	call   0x555555556fae <_ZNKSt6vectorIiSaIiEE4sizeEv>
(gdb) nexti
0x00005555555562e6	11	    if (index == values.size()) {
(gdb) info registers rdi rsi
rdi            0x7fffffffb610      140737488336400
rsi            0x0                 0
```

停止行变成了 `0x00005555555562de	11	...`：地址、Tab、行号、源码。行首出现地址，说明 pc 在第 11 行的中间而不是开头。`nexti` 越过了对 `size()` 的调用。`info registers rdi rsi` 显示两个参数寄存器：按照 System V x86-64 调用约定，第一个参数放 `rdi`，第二个放 `rsi`，所以 `rdi` 是 `values` 的地址（引用在底层就是指针），`rsi = 0` 就是 `index`。

## 改变状态：做一个反事实实验

GDB 不仅能看，还能改。我想验证：如果 `average` 算对了，后面的输出会不会正确？

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break 29
Breakpoint 1 at 0x248d: file gdb_demo.cpp, line 29.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:29
29	    std::cout << "total=" << total << ", average=" << average
(gdb) print average
$1 = 8
(gdb) set variable average = 6
(gdb) print average
$2 = 6
(gdb) set $expected = (double) total / values.size()
(gdb) print $expected
$3 = 6
(gdb) print average == $expected
$4 = true
(gdb) next
30	              << ", expected_average=6\n";
(gdb) next
total=24, average=6, expected_average=6
32	    int counter = 0;
(gdb) continue
Continuing.
[New Thread 0x7ffff77ff6c0 (LWP 158570)]
[Thread 0x7ffff77ff6c0 (LWP 158570) exited]
[New Thread 0x7ffff6ffe6c0 (LWP 158571)]
counter=2000
[Thread 0x7ffff6ffe6c0 (LWP 158571) exited]
[Inferior 1 (process 158515) exited normally]
(gdb) print $_exitcode
$5 = 0
```

- `set variable average = 6` 直接改写栈上的变量。`average` 在源码里是 `const`，但 `const` 只是编译期的约束，`-O0` 下它依然老老实实地住在栈上，GDB 照样可以写。
- `set $expected = ...` 创建一个 GDB 自己的 convenience variable，它以 `$` 开头，只存在于 GDB 里，不占用被调试程序的内存。
- `print average == $expected` 得到 `true`。
- 继续执行后，程序打印出 `average=6`。
- `$_exitcode` 是 GDB 内置的便利变量，保存最近一次退出码。

这次实验说明，只要 `average` 的值对了，后面没有其他问题。但这不是修复：真正的修复要改源码并重新编译，被 GDB 改过的进程状态不能当测试结果。

## watchpoint 与线程

断点问的是"程序什么时候走到这里"，watchpoint 问的是"这块内存什么时候被改了"。我想知道 `counter` 从 0 变成 2000 的过程，于是在线程创建之前设置一个 watchpoint：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break 34
Breakpoint 1 at 0x2518: file gdb_demo.cpp, line 34.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
total=24, average=8, expected_average=6

Breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:34
34	    std::thread first(worker, std::ref(counter), std::ref(mutex));
(gdb) watch counter
Hardware watchpoint 2: counter
(gdb) continue
Continuing.
[New Thread 0x7ffff77ff6c0 (LWP 158939)]
[New Thread 0x7ffff6ffe6c0 (LWP 158940)]
[Thread 0x7ffff77ff6c0 (LWP 158939) exited]
counter=2000
[Thread 0x7ffff6ffe6c0 (LWP 158940) exited]

Watchpoint 2 deleted because the program has left the block in
which its expression is valid.
__libc_start_call_main (main=main@entry=0x555555556384 <main(int, char**)>, argc=argc@entry=1, argv=argv@entry=0x7fffffffb7f8)
    at ../sysdeps/nptl/libc_start_call_main.h:74
warning: 74	../sysdeps/nptl/libc_start_call_main.h: No such file or directory
```

`Hardware watchpoint 2: counter` 说明 GDB 用 CPU 的调试寄存器实现了这个 watchpoint，不需要单步模拟。然而线程把 `counter` 改了 2000 次，GDB 一次都没有停，直到 `main` 返回才告诉我 `Watchpoint 2 deleted because the program has left the block in which its expression is valid.`

我第一次看到这个输出时相当困惑。原因在于 `watch counter` 监视的是表达式 `counter`，而这个表达式只在 `main` 的这一帧里有意义。GDB 把 watchpoint 和 `main` 的栈帧绑定在一起。据我观察，工作线程写入时触发的事件，因为发生在另一个线程的调用栈上，没有被报告出来。`main` 返回之后，这一帧消失，watchpoint 就被自动删除了。

解决办法是 `watch -l`，也就是 `-location`：先把表达式求值成一个地址，然后只监视这个地址，不再关心作用域：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break 34
Breakpoint 1 at 0x2518: file gdb_demo.cpp, line 34.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
total=24, average=8, expected_average=6

Breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:34
34	    std::thread first(worker, std::ref(counter), std::ref(mutex));
(gdb) watch -l counter
Hardware watchpoint 2: -location counter
(gdb) continue
Continuing.
[New Thread 0x7ffff77ff6c0 (LWP 159309)]
[Switching to Thread 0x7ffff77ff6c0 (LWP 159309)]

Thread 2 "gdb_demo" hit Hardware watchpoint 2: -location counter

Old value = 0
New value = 1
worker (counter=@0x7fffffffb60c: 1, mutex=...) at gdb_demo.cpp:21
21	    }
(gdb) info threads
  Id   Target Id                                     Frame
  1    Thread 0x7ffff7e90780 (LWP 159290) "gdb_demo" __GI___clone3 () at ../sysdeps/unix/sysv/linux/x86_64/clone3.S:62
* 2    Thread 0x7ffff77ff6c0 (LWP 159309) "gdb_demo" worker (counter=@0x7fffffffb60c: 1, mutex=...) at gdb_demo.cpp:21
(gdb) continue
Continuing.
[New Thread 0x7ffff6ffe6c0 (LWP 159310)]

Thread 2 "gdb_demo" hit Hardware watchpoint 2: -location counter

Old value = 1
New value = 2
worker (counter=@0x7fffffffb60c: 2, mutex=...) at gdb_demo.cpp:21
21	    }
(gdb) info watchpoints
Num     Type           Disp Enb Address            What
2       hw watchpoint  keep y                      -location counter
	breakpoint already hit 2 times
```

这次立刻就停了：

- `Thread 2 "gdb_demo" hit Hardware watchpoint 2: -location counter`：哪个线程、哪个 watchpoint。
- `Old value = 0` / `New value = 1`：写入前后的值。
- `worker (...) at gdb_demo.cpp:21`：停止位置。注意是第 21 行而不是执行 `++counter` 的第 20 行。硬件 watchpoint 在写入指令执行 **之后** 才触发，此时 pc 已经走到了下一条指令，而它属于第 21 行。

`info threads` 是一张线程表：

- 第一列的 `*` 标记当前线程。
- `Id` 是 GDB 线程编号。
- `Target Id` 是 `pthread_t`、LWP 和线程名。
- `Frame` 是这个线程当前所在的帧。1 号主线程此刻停在 `__GI___clone3`，它正在创建第二个线程。

每次 `++counter` 都停一次太慢了，加一个条件，让它在 1500 时再停：

```text
(gdb) delete 2
(gdb) watch -l counter if counter == 1500
Hardware watchpoint 3: -location counter
(gdb) continue
Continuing.
[Thread 0x7ffff77ff6c0 (LWP 159309) exited]
[Switching to Thread 0x7ffff6ffe6c0 (LWP 159310)]

Thread 3 "gdb_demo" hit Hardware watchpoint 3: -location counter

Old value = 1499
New value = 1500
worker (counter=@0x7fffffffb60c: 1500, mutex=...) at gdb_demo.cpp:21
21	    }
(gdb) print i
$1 = 499
(gdb) info threads
  Id   Target Id                                     Frame
  1    Thread 0x7ffff7e90780 (LWP 159290) "gdb_demo" __syscall_cancel_arch () at ../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S:56
* 3    Thread 0x7ffff6ffe6c0 (LWP 159310) "gdb_demo" worker (counter=@0x7fffffffb60c: 1500, mutex=...) at gdb_demo.cpp:21
```

这次命中的是 3 号线程，而且 `i = 499`。换句话说，3 号线程自己加了 500 次，另外 1000 次来自 2 号线程，后者此时已经退出了（`[Thread 0x7ffff77ff6c0 (LWP 159309) exited]`）。互斥锁保证了总数正确，但不保证两个线程的交替顺序。

主线程这时在做什么？

```text
(gdb) thread 1
[Switching to thread 1 (Thread 0x7ffff7e90780 (LWP 159290))]
#0  __syscall_cancel_arch () at ../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S:56
warning: 56	../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S: No such file or directory
(gdb) bt
#0  __syscall_cancel_arch () at ../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S:56
#1  0x00007ffff789912c in __internal_syscall_cancel (a1=<optimized out>, a2=<optimized out>, a3=<optimized out>, a4=<optimized out>, a5=a5@entry=0,
    a6=a6@entry=4294967295, nr=202) at cancellation.c:49
#2  0x00007ffff78998ac in __futex_abstimed_wait_common64 (private=128, futex_word=0x7ffff6ffe990, expected=<optimized out>, op=<optimized out>, abstime=0x0,
    cancel=true) at futex-internal.c:57
#3  __futex_abstimed_wait_common (futex_word=futex_word@entry=0x7ffff6ffe990, expected=<optimized out>, clockid=clockid@entry=0, abstime=abstime@entry=0x0,
    private=private@entry=128, cancel=cancel@entry=true) at futex-internal.c:87
#4  0x00007ffff789993f in __GI___futex_abstimed_wait_cancelable64 (futex_word=futex_word@entry=0x7ffff6ffe990, expected=<optimized out>,
    clockid=clockid@entry=0, abstime=abstime@entry=0x0, private=private@entry=128) at futex-internal.c:139
#5  0x00007ffff789ec8c in __pthread_clockjoin_ex (threadid=140737337353920, thread_return=0x0, clockid=0, abstime=0x0, block=<optimized out>)
    at pthread_join_common.c:108
#6  0x00007ffff7cf2f1b in std::thread::join() () from /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6
#7  0x00005555555565be in main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:37
(gdb) thread apply all bt

Thread 3 (Thread 0x7ffff6ffe6c0 (LWP 159310) "gdb_demo"):
#0  worker (counter=@0x7fffffffb60c: 1500, mutex=...) at gdb_demo.cpp:21
#1  0x000055555555889a in std::__invoke_impl<void, void (*)(int&, std::mutex&), std::reference_wrapper<int>, std::reference_wrapper<std::mutex> > (__f=@0x55555556f8d8: 0x55555555632c <worker(int&, std::mutex&)>) at /nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/include/c++/15.3.0/bits/invoke.h:63
#2  0x00005555555587f0 in std::__invoke<void (*)(int&, std::mutex&), std::reference_wrapper<int>, std::reference_wrapper<std::mutex> > (__fn=@0x55555556f8d8: 0x55555555632c <worker(int&, std::mutex&)>) at /nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/include/c++/15.3.0/bits/invoke.h:98
#3  0x000055555555873d in std::thread::_Invoker<std::tuple<void (*)(int&, std::mutex&), std::reference_wrapper<int>, std::reference_wrapper<std::mutex> > >::_M_invoke<0ul, 1ul, 2ul> (this=0x55555556f8c8) at /nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/include/c++/15.3.0/bits/std_thread.h:303
#4  0x00005555555586da in std::thread::_Invoker<std::tuple<void (*)(int&, std::mutex&), std::reference_wrapper<int>, std::reference_wrapper<std::mutex> > >::operator() (this=0x55555556f8c8) at /nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/include/c++/15.3.0/bits/std_thread.h:310
#5  0x00005555555586be in std::thread::_State_impl<std::thread::_Invoker<std::tuple<void (*)(int&, std::mutex&), std::reference_wrapper<int>, std::reference_wrapper<std::mutex> > > >::_M_run (this=0x55555556f8c0) at /nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/include/c++/15.3.0/bits/std_thread.h:255
#6  0x00007ffff7cf2ea4 in execute_native_thread_routine () from /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6
#7  0x00007ffff789ce73 in start_thread (arg=<optimized out>) at pthread_create.c:448
#8  0x00007ffff79242bc in __GI___clone3 () at ../sysdeps/unix/sysv/linux/x86_64/clone3.S:78

Thread 1 (Thread 0x7ffff7e90780 (LWP 159290) "gdb_demo"):
#0  __syscall_cancel_arch () at ../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S:56
#1  0x00007ffff789912c in __internal_syscall_cancel (a1=<optimized out>, a2=<optimized out>, a3=<optimized out>, a4=<optimized out>, a5=a5@entry=0, a6=a6@entry=4294967295, nr=202) at cancellation.c:49
#2  0x00007ffff78998ac in __futex_abstimed_wait_common64 (private=128, futex_word=0x7ffff6ffe990, expected=<optimized out>, op=<optimized out>, abstime=0x0, cancel=true) at futex-internal.c:57
#3  __futex_abstimed_wait_common (futex_word=futex_word@entry=0x7ffff6ffe990, expected=<optimized out>, clockid=clockid@entry=0, abstime=abstime@entry=0x0, private=private@entry=128, cancel=cancel@entry=true) at futex-internal.c:87
#4  0x00007ffff789993f in __GI___futex_abstimed_wait_cancelable64 (futex_word=futex_word@entry=0x7ffff6ffe990, expected=<optimized out>, clockid=clockid@entry=0, abstime=abstime@entry=0x0, private=private@entry=128) at futex-internal.c:139
#5  0x00007ffff789ec8c in __pthread_clockjoin_ex (threadid=140737337353920, thread_return=0x0, clockid=0, abstime=0x0, block=<optimized out>) at pthread_join_common.c:108
#6  0x00007ffff7cf2f1b in std::thread::join() () from /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6
#7  0x00005555555565be in main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:37
```

`thread 1` 切换到主线程，它停在第 37 行的 `second.join()` 里，一路调到 futex 等待。`thread apply all bt` 对所有线程执行 `bt`，每个线程前面有一行 `Thread N (...)` 标题，这是我遇到死锁或者卡住时第一个执行的命令。3 号线程的栈里那一串 `std::__invoke_impl`、`std::thread::_Invoker` 是 `std::thread` 把你的函数包装起来调用的过程，真正的起点在 `#7 start_thread` 和 `#8 __GI___clone3`。

### next 时其他线程在干什么

GDB 默认工作在 all-stop 模式：任何一个线程停下，所有线程都停下；但当你 `next` 时，所有线程都会被放行。这会产生一些反直觉的输出：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break worker
Breakpoint 1 at 0x233c: file gdb_demo.cpp, line 18.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
total=24, average=8, expected_average=6
[New Thread 0x7ffff77ff6c0 (LWP 159730)]
[Switching to Thread 0x7ffff77ff6c0 (LWP 159730)]

Thread 2 "gdb_demo" hit Breakpoint 1, worker (counter=@0x7fffffffb60c: 0, mutex=...) at gdb_demo.cpp:18
18	    for (int i = 0; i < 1000; ++i) {
(gdb) next
[New Thread 0x7ffff6ffe6c0 (LWP 159731)]
[Switching to Thread 0x7ffff6ffe6c0 (LWP 159731)]

Thread 3 "gdb_demo" hit Breakpoint 1, worker (counter=@0x7fffffffb60c: 0, mutex=...) at gdb_demo.cpp:18
18	    for (int i = 0; i < 1000; ++i) {
(gdb) next
[Thread 0x7ffff77ff6c0 (LWP 159730) exited]
19	        std::lock_guard<std::mutex> lock(mutex);
(gdb) info threads
  Id   Target Id                                     Frame
  1    Thread 0x7ffff7e90780 (LWP 159727) "gdb_demo" __syscall_cancel_arch () at ../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S:56
* 3    Thread 0x7ffff6ffe6c0 (LWP 159731) "gdb_demo" worker (counter=@0x7fffffffb60c: 1000, mutex=...) at gdb_demo.cpp:19
```

我在 2 号线程里 `next`，结果停下的却是 3 号线程，因为它在我单步期间命中了同一个断点，GDB 自动切了过去。更夸张的是第二次 `next`：在 3 号线程从第 18 行走到第 19 行的这一小段时间里，2 号线程跑完了整整 1000 次循环并退出，`counter` 已经是 `1000`。

如果我只想专心看一个线程，可以打开 scheduler locking：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break worker
Breakpoint 1 at 0x233c: file gdb_demo.cpp, line 18.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
total=24, average=8, expected_average=6
[New Thread 0x7ffff77ff6c0 (LWP 160100)]
[New Thread 0x7ffff6ffe6c0 (LWP 160101)]
[Switching to Thread 0x7ffff77ff6c0 (LWP 160100)]

Thread 2 "gdb_demo" hit Breakpoint 1, worker (counter=@0x7fffffffb60c: 0, mutex=...) at gdb_demo.cpp:18
18	    for (int i = 0; i < 1000; ++i) {
(gdb) set scheduler-locking step
(gdb) next
19	        std::lock_guard<std::mutex> lock(mutex);
(gdb) next
20	        ++counter;
(gdb) info threads
  Id   Target Id                                     Frame
  1    Thread 0x7ffff7e90780 (LWP 160097) "gdb_demo" __syscall_cancel_arch () at ../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S:56
* 2    Thread 0x7ffff77ff6c0 (LWP 160100) "gdb_demo" worker (counter=@0x7fffffffb60c: 0, mutex=...) at gdb_demo.cpp:20
  3    Thread 0x7ffff6ffe6c0 (LWP 160101) "gdb_demo" worker (counter=@0x7fffffffb60c: 0, mutex=...) at gdb_demo.cpp:18
```

`set scheduler-locking step` 的意思是：`step` 和 `next` 期间只让当前线程运行，`continue` 时照常放行所有线程。这次两次 `next` 都留在 2 号线程里，`info threads` 显示 3 号线程还停在第 18 行，`counter` 仍然是 `0`。

普通断点和 watchpoint 只能告诉我某个线程在某个时刻做了什么，不能证明程序没有数据竞争。如果要调查竞争，我会用 ThreadSanitizer 这类专门工具，而不是在 GDB 里碰运气。

## 崩溃、异常、信号与系统调用

### 段错误

`--args` 让 GDB 把后面的所有内容当成程序和它的参数，省得进入 GDB 后再 `set args`：

```text
$ gdb -q -nx --args ./gdb_demo --crash
Reading symbols from ./gdb_demo...
(gdb) show args
Argument list to give program being debugged when it is started is "--crash".
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo --crash
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
total=24, average=8, expected_average=6
[New Thread 0x7ffff77ff6c0 (LWP 160478)]
[Thread 0x7ffff77ff6c0 (LWP 160478) exited]
[New Thread 0x7ffff6ffe6c0 (LWP 160479)]
counter=2000
about to dereference a null pointer
[Thread 0x7ffff6ffe6c0 (LWP 160479) exited]

Thread 1 "gdb_demo" received signal SIGSEGV, Segmentation fault.
0x000055555555677b in main (argc=2, argv=0x7fffffffb7f8) at gdb_demo.cpp:57
57	        std::cout << *pointer << "\n";
(gdb) bt
#0  0x000055555555677b in main (argc=2, argv=0x7fffffffb7f8) at gdb_demo.cpp:57
(gdb) print pointer
$1 = (int *) 0x0
(gdb) print *pointer
Cannot access memory at address 0x0
(gdb) x/i $pc
=> 0x55555555677b <main(int, char**)+1015>:	mov    (%rax),%eax
(gdb) info registers rax
rax            0x0                 0
(gdb) info locals
pointer = 0x0
mode = "--crash"
values = std::vector of length 4, capacity 4 = {3, 5, 7, 9}
total = 24
average = 8
counter = 2000
mutex = {<std::__mutex_base> = {_M_mutex = {__data = {__lock = 0, __count = 0, __owner = 0, __nusers = 0, __kind = 0, __spins = 0, __elision = 0, __list = {
          __prev = 0x0, __next = 0x0}}, __size = '\000' <repeats 39 times>, __align = 0}}, <No data fields>}
first = {_M_id = {_M_thread = 0}}
second = {_M_id = {_M_thread = 0}}
```

- `show args` 确认参数已经带上。
- 没有设置任何断点，程序一路跑到崩溃。`Thread 1 "gdb_demo" received signal SIGSEGV, Segmentation fault.` 说明 GDB 截获了内核发给程序的信号，在程序被杀死之前停住了它。
- 下一行 `0x000055555555677b in main (...) at gdb_demo.cpp:57` 前面带地址，说明崩溃发生在第 57 行中间的某条指令上。
- `print pointer` 的输出 `(int *) 0x0` 先给类型，再给值。指针类型的值总是这样显示。
- `print *pointer` 得到 `Cannot access memory at address 0x0`，GDB 自己去读这个地址也失败了。
- `x/i $pc` 显示出错的那条指令 `mov (%rax),%eax`：把 `rax` 指向的内存读进 `eax`。`info registers rax` 显示 `rax` 是 0。从源码到指令到寄存器，三层证据都指向同一个结论：空指针解引用。
- `info locals` 列出 `main` 的所有局部变量。`first` 和 `second` 的 `_M_thread = 0` 表示这两个 `std::thread` 已经 `join` 过，不再关联任何线程。

最后一条 `generate-core-file` 把当前进程的完整内存映像保存成文件。两条 `Memory read failed` 警告我没有深究，我猜是读不了的特殊映射：`0xffffffffff600000` 是内核的 vsyscall 页，另一块 1 MiB 的区域看起来像是已退出线程留下的不可读保护区。它们不影响后面的分析。

### core 文件：离开现场之后

core 文件可以在任何时候重新加载，程序不需要再运行：

```text
$ gdb -q -nx ./gdb_demo core.gdb_demo
Reading symbols from ./gdb_demo...
[New LWP 160475]
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
Core was generated by `/tmp/gdb-post/gdb_demo --crash'.
Program terminated with signal SIGSEGV, Segmentation fault.
#0  0x000055555555677b in main (argc=2, argv=0x7fffffffb7f8) at gdb_demo.cpp:57
57	        std::cout << *pointer << "\n";
(gdb) bt
#0  0x000055555555677b in main (argc=2, argv=0x7fffffffb7f8) at gdb_demo.cpp:57
(gdb) print pointer
$1 = (int *) 0x0
(gdb) print values
$2 = std::vector of length 4, capacity 4 = {3, 5, 7, 9}
(gdb) x/4gx $sp
0x7fffffffb5b0:	0x1716151413121110	0x4038000000000000
0x7fffffffb5c0:	0x00007fffffffb7f8	0x00000002f78ab596
(gdb) print *(double *)($sp + 8)
$3 = 24
```

加载时 GDB 会先告诉你这个 core 是怎样产生的：`Core was generated by ...` 是当时的命令行，`Program terminated with signal SIGSEGV` 是致死信号，然后直接显示崩溃时的帧。变量、寄存器、内存都还在，但你不能 `next` 或 `continue`，因为已经没有活着的进程了。

`x/4gx $sp` 读取栈顶 32 个字节。第二个值 `0x4038000000000000` 很有意思：按 IEEE 754 双精度解释，指数部分 `0x403` 是 1027，减去偏置 1023 得 4，尾数是 1.5，`1.5 * 2^4 = 24`。`print *(double *)($sp + 8)` 证实了它就是 `24`。我推测这是第 28 行 `static_cast<double>(total)` 留下的临时值，编译器把它存在了栈上。

core 文件里的地址只对生成它的那个可执行文件有意义。如果重新编译过 `gdb_demo` 再去加载旧 core，GDB 读到的行号和变量位置很可能是错的，而且它不一定会警告你。

NixOS 默认启用 systemd-coredump，所以前面在 Shell 里崩溃的那两次，core 早就被系统收走了：

```text
$ coredumpctl list --no-pager --since "2026-09-30 00:25:00" gdb_demo
TIME                           PID  UID GID SIG     COREFILE EXE                     SIZE
Wed 2026-09-30 00:25:11 CST 167935 1000 100 SIGSEGV present  /tmp/gdb-post/gdb_demo   57K
Wed 2026-09-30 00:25:11 CST 167944 1000 100 SIGABRT present  /tmp/gdb-post/gdb_demo 57.2K
```

`SIG` 列是信号，`COREFILE` 为 `present` 说明文件还在。`coredumpctl debug` 会找到对应的 core，直接用 GDB 打开它，`--debugger-arguments` 把参数传给 GDB：

```text
$ coredumpctl debug --debugger-arguments='-q -nx' 167935
           PID: 167935 (gdb_demo)
        Signal: 11 (SEGV)
  Command Line: ./gdb_demo --crash
    Executable: /tmp/gdb-post/gdb_demo
       Message: Process 167935 (gdb_demo) of user 1000 dumped core.

                Module /tmp/gdb-post/gdb_demo without build-id.
                Module /tmp/gdb-post/gdb_demo
                Module libgcc_s.so.1 without build-id.
                Module libstdc++.so.6 without build-id.
                Stack trace of thread 167935:
                #0  0x000055555555677b n/a (/tmp/gdb-post/gdb_demo + 0x277b)
                #1  0x00007ffff782b285 __libc_start_call_main (libc.so.6 + 0x2b285)
                #2  0x00007ffff782b338 __libc_start_main@@GLIBC_2.34 (libc.so.6 + 0x2b338)
                #3  0x0000555555556205 n/a (/tmp/gdb-post/gdb_demo + 0x2205)
                ELF object binary architecture: AMD x86-64

Reading symbols from /tmp/gdb-post/gdb_demo...
[New LWP 167935]
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
Core was generated by `./gdb_demo --crash'.
Program terminated with signal SIGSEGV, Segmentation fault.
#0  0x000055555555677b in main (argc=2, argv=0x7fffffffb568) at gdb_demo.cpp:57
57	        std::cout << *pointer << "\n";
(gdb) bt
#0  0x000055555555677b in main (argc=2, argv=0x7fffffffb568) at gdb_demo.cpp:57
(gdb) print pointer
$1 = (int *) 0x0
```

我省略了几行机器相关的元数据。`Message` 里的 `Stack trace of thread` 是 systemd-coredump 自己做的简易栈回溯，它不读 DWARF，所以 `main` 显示成 `n/a (/tmp/gdb-post/gdb_demo + 0x277b)`，`0x277b` 正是 `0x55555555677b` 减去加载基址。后面进入 GDB 之后，一切又回到了熟悉的格式。

### C++ 异常

`--throw` 路径里，`values.at(4)` 会抛出 `std::out_of_range`。如果没人捕获，程序会在 `std::terminate` 里 `abort`，那时栈已经展开了一部分，现场不太好看。更好的做法是在抛出的那一刻停下：

```text
$ gdb -q -nx --args ./gdb_demo --throw
Reading symbols from ./gdb_demo...
(gdb) catch throw
Catchpoint 1 (throw)
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo --throw
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
total=24, average=8, expected_average=6
[New Thread 0x7ffff77ff6c0 (LWP 161253)]
[Thread 0x7ffff77ff6c0 (LWP 161253) exited]
[New Thread 0x7ffff6ffe6c0 (LWP 161254)]
counter=2000
[Thread 0x7ffff6ffe6c0 (LWP 161254) exited]

Thread 1 "gdb_demo" hit Catchpoint 1 (exception thrown), 0x00007ffff7cc5590 in __cxa_throw ()
   from /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6
(gdb) bt
#0  0x00007ffff7cc5590 in __cxa_throw () from /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6
#1  0x00007ffff7cb5dd6 in std::__throw_out_of_range_fmt(char const*, ...) () from /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6
#2  0x0000555555557cdd in std::vector<int, std::allocator<int> >::_M_range_check (this=0x7fffffffb610, __n=4)
    at /nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/include/c++/15.3.0/bits/stl_vector.h:1293
#3  0x0000555555557619 in std::vector<int, std::allocator<int> >::at (this=0x7fffffffb610, __n=4)
    at /nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/include/c++/15.3.0/bits/stl_vector.h:1315
#4  0x0000555555556640 in main (argc=2, argv=0x7fffffffb7f8) at gdb_demo.cpp:41
(gdb) frame 4
#4  0x0000555555556640 in main (argc=2, argv=0x7fffffffb7f8) at gdb_demo.cpp:41
41	        std::cout << values.at(values.size()) << "\n";
(gdb) print values.size()
$1 = 4
```

- `Catchpoint 1 (throw)` 是一种新的断点类型：catchpoint，它捕获的是事件，而不是位置。
- 命中时停在 `__cxa_throw ()`，这是 libstdc++ 里所有 `throw` 最终都会调用的函数。`from ...libstdc++.so.6` 表示这里没有源码。
- `bt` 从下往上读：`main` 的第 41 行调用了 `vector::at(__n=4)`，`at` 调用 `_M_range_check`，后者调用 `__throw_out_of_range_fmt`，最后是 `__cxa_throw`。标准库头文件里的帧有源码位置，指向 `/nix/store/...-gcc-15.3.0/include/c++/15.3.0/bits/stl_vector.h`；编译进 `libstdc++.so` 里的帧没有。
- `frame 4` 跳回 `main`，这时可以读 `values`，确认 `size()` 是 4，而我访问的下标也是 4。

### 系统调用和信号

`catch syscall` 在程序进入和离开系统调用时停下：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) catch syscall write
Catchpoint 1 (syscall 'write' [1])
(gdb) info signals SIGSEGV
Signal        Stop	Print	Pass to program	Description
SIGSEGV       Yes	Yes	Yes		Segmentation fault
(gdb) handle SIGSEGV nostop noprint
Signal        Stop	Print	Pass to program	Description
SIGSEGV       No	No	Yes		Segmentation fault
(gdb) handle SIGSEGV stop print
Signal        Stop	Print	Pass to program	Description
SIGSEGV       Yes	Yes	Yes		Segmentation fault
(gdb) set environment MODE=debug
(gdb) show environment MODE
MODE = debug
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Catchpoint 1 (call to syscall write), __internal_syscall_cancel (a1=1, a2=93824992342848, a3=40, a4=a4@entry=0, a5=a5@entry=0, a6=a6@entry=0, nr=1)
    at cancellation.c:44
warning: 44	cancellation.c: No such file or directory
(gdb) bt 3
#0  __internal_syscall_cancel (a1=1, a2=93824992342848, a3=40, a4=a4@entry=0, a5=a5@entry=0, a6=a6@entry=0, nr=1) at cancellation.c:44
#1  0x00007ffff78991a4 in __syscall_cancel (a1=<optimized out>, a2=<optimized out>, a3=<optimized out>, a4=a4@entry=0, a5=a5@entry=0, a6=a6@entry=0, nr=1)
    at cancellation.c:75
#2  0x00007ffff791758e in __GI___libc_write (fd=<optimized out>, buf=<optimized out>, nbytes=<optimized out>) at ../sysdeps/unix/sysv/linux/write.c:26
(More stack frames follow...)
(gdb) continue
Continuing.
total=24, average=8, expected_average=6

Catchpoint 1 (returned from syscall write), __internal_syscall_cancel (a1=1, a2=93824992342848, a3=40, a4=a4@entry=0, a5=a5@entry=0, a6=a6@entry=0, nr=1)
    at cancellation.c:44
44	in cancellation.c
(gdb) continue
Continuing.
[New Thread 0x7ffff77ff6c0 (LWP 161664)]
[New Thread 0x7ffff6ffe6c0 (LWP 161665)]
[Thread 0x7ffff77ff6c0 (LWP 161664) exited]
[Thread 0x7ffff6ffe6c0 (LWP 161665) exited]

Thread 1 "gdb_demo" hit Catchpoint 1 (call to syscall write), __syscall_cancel_arch () at ../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S:56
warning: 56	../sysdeps/unix/sysv/linux/x86_64/syscall_cancel.S: No such file or directory
```

一口气看几件事：

- `Catchpoint 1 (syscall 'write' [1])`：`[1]` 是 `write` 在 x86-64 上的系统调用号。
- `info signals SIGSEGV` 和 `handle` 的输出是同一张表：`Stop` 表示信号到达时 GDB 是否暂停，`Print` 表示是否打印一条消息，`Pass to program` 表示是否把信号继续交给程序。我先把 `SIGSEGV` 设成不停不打印，再改回来，只是为了展示输出。实际中更常见的是 `handle SIGPIPE nostop noprint pass`，给那些故意忽略 `SIGPIPE` 的网络程序用。
- `set environment MODE=debug` 设置被调试程序的环境变量，只在下一次 `run` 时生效。我的程序没有读它，这里只是展示格式。
- 第一次命中是 `call to syscall write`。有了 glibc 的调试符号，参数一目了然：`nr=1` 是系统调用号，`a1=1` 是文件描述符 stdout，`a3=40` 是字节数。`"total=24, average=8, expected_average=6\n"` 正好 40 个字节，就是第一行输出。
- `bt 3` 只打印最内层 3 帧，剩下的用 `(More stack frames follow...)` 提示。
- `continue` 之后，这一行真正写到了终端，然后 GDB 在 `returned from syscall write` 再停一次。每个系统调用都会停两次：进入和返回。
- 第二个 `write` 是 `counter=2000`，它还没写出去，所以屏幕上暂时看不到。

## fork：一个会话，两个进程

GDB 默认在 `fork` 之后继续跟踪父进程，子进程自由运行。`--fork` 路径里我想停在子进程的第 47 行：

```text
$ gdb -q -nx --args ./gdb_demo --fork
Reading symbols from ./gdb_demo...
(gdb) show follow-fork-mode
Debugger response to a program call of fork or vfork is "parent".
(gdb) set follow-fork-mode child
(gdb) set detach-on-fork off
(gdb) break 47
Breakpoint 1 at 0x2697: file gdb_demo.cpp, line 47.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo --fork
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
total=24, average=8, expected_average=6
[New Thread 0x7ffff77ff6c0 (LWP 162029)]
[Thread 0x7ffff77ff6c0 (LWP 162029) exited]
[New Thread 0x7ffff6ffe6c0 (LWP 162030)]
counter=2000
[Thread 0x7ffff6ffe6c0 (LWP 162030) exited]
[Attaching after Thread 0x7ffff7e90780 (LWP 162026) fork to child process 162031]
[New inferior 2 (process 162031)]
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
[Switching to Thread 0x7ffff7e90780 (LWP 162031)]

Thread 2.1 "gdb_demo" hit Breakpoint 1.2, main (argc=2, argv=0x7fffffffb7f8) at gdb_demo.cpp:47
47	            std::cout << "child: pid=" << getpid() << "\n";
(gdb) info inferiors
  Num  Description       Connection           Executable
  1    process 162026    1 (native)           /tmp/gdb-post/gdb_demo
* 2    process 162031    1 (native)           /tmp/gdb-post/gdb_demo
(gdb) print pid
$1 = 0
(gdb) inferior 1
[Switching to inferior 1 [process 162026] (/tmp/gdb-post/gdb_demo)]
[Switching to thread 1.1 (Thread 0x7ffff7e90780 (LWP 162026))]
#0  arch_fork (ctid=0x7ffff7e90a50) at ../sysdeps/unix/sysv/linux/arch-fork.h:50
warning: 50	../sysdeps/unix/sysv/linux/arch-fork.h: No such file or directory
(gdb) bt 2
#0  arch_fork (ctid=0x7ffff7e90a50) at ../sysdeps/unix/sysv/linux/arch-fork.h:50
#1  __GI__Fork () at ../sysdeps/nptl/_Fork.c:33
(More stack frames follow...)
(gdb) inferior 2
[Switching to inferior 2 [process 162031] (/tmp/gdb-post/gdb_demo)]
[Switching to thread 2.1 (Thread 0x7ffff7e90780 (LWP 162031))]
#0  main (argc=2, argv=0x7fffffffb7f8) at gdb_demo.cpp:47
47	            std::cout << "child: pid=" << getpid() << "\n";
(gdb) continue
Continuing.
child: pid=162031
[Inferior 2 (process 162031) exited normally]
(gdb) info inferiors
  Num  Description       Connection           Executable
  1    process 162026    1 (native)           /tmp/gdb-post/gdb_demo
* 2    <null>                                 /tmp/gdb-post/gdb_demo
```

- `set follow-fork-mode child` 让 GDB 跟随子进程；`set detach-on-fork off` 让父进程也保留在 GDB 的控制下，而不是被放走。
- `[Attaching after Thread ... fork to child process 162031]` 和 `[New inferior 2 (process 162031)]`：GDB 为子进程创建了第二个 inferior。
- `Thread 2.1 "gdb_demo" hit Breakpoint 1.2`：多 inferior 时，编号变成两级。`2.1` 是 2 号 inferior 的 1 号线程；`1.2` 是 1 号断点的第 2 个位置，因为同一个断点在两个进程里各有一份。
- `info inferiors` 的 `*` 标记当前 inferior。
- `print pid` 得到 `0`，这正是子进程里 `fork()` 的返回值。
- `inferior 1` 切回父进程，它停在 `arch_fork` 里，`fork()` 还没有返回。
- 子进程 `continue` 后正常退出，`info inferiors` 里 2 号的描述变成 `<null>`。父进程依然停在 `fork` 里，要回到 `inferior 1` 再 `continue` 才会继续。

顺便说一个跟 GDB 无关但我踩到的坑。如果把 `--fork` 的输出接到管道，前两行会出现两次：

```text
$ ./gdb_demo --fork
total=24, average=8, expected_average=6
counter=2000
child: pid=169434
total=24, average=8, expected_average=6
counter=2000
parent: child 169434 exited
```

原因和前面 `--crash | cat` 一样：管道让 `stdout` 变成全缓冲，`fork` 时前两行还在缓冲区里，子进程复制了一份，于是父子进程退出时各刷了一次（hah，这大概是我见过最朴素的"状态被复制"演示）。

## 远程调试：gdbserver

远程调试时，目标机只跑一个很小的 `gdbserver`，符号解析、源码显示都在主机的 GDB 里完成。我在同一台机器上开两个终端模拟这个过程。目标端：

```text
$ gdbserver localhost:1234 ./gdb_demo --crash
Process ./gdb_demo created; pid = 166992
Listening on port 1234
Remote debugging from host ::1, port 47264
total=24, average=8, expected_average=6
counter=2000
about to dereference a null pointer
```

主机端：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) target remote localhost:1234
Remote debugging using localhost:1234
Reading /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/ld-linux-x86-64.so.2 from remote target...
warning: File transfers from remote targets can be slow. Use "set sysroot" to access files locally instead.
Reading /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/ld-linux-x86-64.so.2 from remote target...
Reading symbols from target:/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/ld-linux-x86-64.so.2...
Reading symbols from /nix/store/fk98h17sza0xxz9iw0fi5b2nn1h4c0pm-glibc-2.42-84-debug/lib/debug/.build-id/cd/a09b1b1c97f3bc480e67118d1239e751f6144c.debug...
0x00007ffff7fe3e00 in _start () from target:/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/ld-linux-x86-64.so.2
(gdb) break 57
Breakpoint 1 at 0x555555556777: file gdb_demo.cpp, line 57.
(gdb) continue
Continuing.
Reading /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libstdc++.so.6 from remote target...
Reading /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libm.so.6 from remote target...
Reading /nix/store/604gsr59rj7dzd0nrhp143rpvf7gyiaz-gcc-15.3.0-lib/lib/libgcc_s.so.1 from remote target...
Reading /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libc.so.6 from remote target...

Breakpoint 1, main (argc=2, argv=0x7fffffffb828) at gdb_demo.cpp:57
57	        std::cout << *pointer << "\n";
(gdb) print pointer
$1 = (int *) 0x0
(gdb) continue
Continuing.

Program received signal SIGSEGV, Segmentation fault.
0x000055555555677b in main (argc=2, argv=0x7fffffffb828) at gdb_demo.cpp:57
57	        std::cout << *pointer << "\n";
```

- `gdbserver` 启动进程后先把它停在第一条指令，打印 `Listening on port 1234`，然后等待连接。主机连上后，它打印 `Remote debugging from host ::1, port 47264`。
- 主机端连接后停在 `_start ()`，和前面 `starti` 看到的位置一样。
- `Reading ... from remote target...` 表示 GDB 在通过 gdbserver 的协议把目标机上的共享库一块块传过来读取符号。那条 warning 已经说了：这很慢，建议用 `set sysroot` 读取本地文件。
- 程序的标准输出出现在 **目标端** 的终端里，主机端只能看到 GDB 自己的输出。
- 这次远程会话里没有出现 `[New Thread ...]` 和 `libthread_db` 的消息，线程由 gdbserver 在目标端跟踪。

在 NixOS 上有一个方便之处：两台机器如果部署的是同一个系统闭包，库在两边的 `/nix/store` 路径完全相同，这时可以直接 `set sysroot /`，让 GDB 从本地读：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) set sysroot /
(gdb) target remote localhost:1234
Remote debugging using localhost:1234
Reading symbols from /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/ld-linux-x86-64.so.2...
Reading symbols from /nix/store/fk98h17sza0xxz9iw0fi5b2nn1h4c0pm-glibc-2.42-84-debug/lib/debug/.build-id/cd/a09b1b1c97f3bc480e67118d1239e751f6144c.debug...
0x00007ffff7fe3e00 in _start () from /nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/ld-linux-x86-64.so.2
(gdb) continue
Continuing.

Program received signal SIGSEGV, Segmentation fault.
0x000055555555677b in main (argc=2, argv=0x7fffffffb828) at gdb_demo.cpp:57
57	        std::cout << *pointer << "\n";
```

这次没有 `Reading ... from remote target`，也没有那条 warning。如果两边的库不一样，这样做会让 GDB 用错误的符号解释目标进程，所以这只适合我确信两边一致的情况。

gdbserver 监听的端口没有任何认证，任何能连上这个端口的人都可以控制被调试进程。我这里只绑定了 `localhost`，真实使用时我也会尽量通过 SSH 隧道转发，而不是直接暴露在网络上。

## 优化构建：当源码和指令不再一一对应

用同样的代码编一个 `-O2` 版本：

```bash
g++ -std=c++20 -g3 -O2 -fno-omit-frame-pointer -Wall -Wextra \
    -o gdb_demo_O2 gdb_demo.cpp
```

```text
$ gdb -q -nx ./gdb_demo_O2
Reading symbols from ./gdb_demo_O2...
(gdb) break recursive_sum
Breakpoint 1 at 0x26b0: file /nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/include/c++/15.3.0/bits/stl_vector.h, line 1117.
(gdb) break main
Breakpoint 2 at 0x2200: file gdb_demo.cpp, line 25.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo_O2
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Breakpoint 2, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:25
25	    const std::string mode = argc > 1 ? argv[1] : "";
(gdb) next
26	    std::vector<int> values{3, 5, 7, 9};
(gdb) next
25	    const std::string mode = argc > 1 ? argv[1] : "";
(gdb) next
26	    std::vector<int> values{3, 5, 7, 9};
(gdb) next
29	    std::cout << "total=" << total << ", average=" << average
(gdb) info locals
mode = ""
values = std::vector of length 4, capacity 4 = {3, 5, 7, 9}
total = 24
average = 8
counter = -1
mutex = {<std::__mutex_base> = {_M_mutex = {__data = {__lock = -18808, __count = 32767, __owner = 73728, __nusers = 0, __kind = -18792, __spins = 32767,
        __elision = 0, __list = {__prev = 0x12000, __next = 0x1}},
      __size = "\210\266\377\377\377\177\000\000\000 \001\000\000\000\000\000\230\266\377\377\377\177\000\000\000 \001\000\000\000\000\000\001\000\000\000\000\000\000", __align = 140737488336520}}, <No data fields>}
first = {_M_id = {_M_thread = 208896}}
second = {_M_id = {_M_thread = 13463046263307902464}}
```

这里有三个意外。

第一，`break recursive_sum` 报告的位置不在 `gdb_demo.cpp`，而在 `stl_vector.h` 第 1117 行，那是 `size()` 的定义。`-O2` 把 `values.size()` 内联进了 `recursive_sum`，而且把它的指令排到了函数最前面，所以函数的第一条指令"属于"头文件。

第二，这个断点永远不会命中。我用 `objdump` 查了一下：

```text
$ objdump -d -C gdb_demo_O2 | grep -c 'call.*recursive_sum'
0
$ objdump -d --no-show-raw-insn -C gdb_demo_O2 | grep -B1 -A2 'mov    $0x18,%esi'
    22c7:	call   20e0 <std::basic_ostream<char, std::char_traits<char> >& std::operator<< <std::char_traits<char> >(std::basic_ostream<char, std::char_traits<char> >&, char const*)@plt>
    22cc:	mov    $0x18,%esi
    22d1:	mov    %rax,%rdi
    22d4:	call   2160 <std::ostream::operator<<(int)@plt>
```

整个程序里没有任何一条 `call recursive_sum`。GCC 在编译期就把 `recursive_sum({3, 5, 7, 9}, 0)` 算出来了，`mov $0x18,%esi` 直接把常数 `24` 传给了 `operator<<(int)`。`recursive_sum` 的独立版本依然被生成出来，因为它是一个外部可见的函数，但 `main` 不再需要它。

第三，`next` 在第 25 和 26 行之间来回跳：25、26、25、26、29。编译器把两行代码的指令交错排列了，GDB 每次都如实报告"当前指令属于哪一行"。第 27、28 行直接消失，因为它们已经变成了常数。

`info locals` 在这里还能读到 `total = 24`、`average = 8`，这是 DWARF 记录了"这个变量的值是常数 24"，而不是它真的存在某个地方。

`recursive_sum` 本身的反汇编也很值得一看：

```text
$ gdb -q -nx ./gdb_demo_O2
Reading symbols from ./gdb_demo_O2...
(gdb) disassemble /s recursive_sum
Dump of assembler code for function _Z13recursive_sumRKSt6vectorIiSaIiEEm:
/nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/include/c++/15.3.0/bits/stl_vector.h:
1117	      size() const _GLIBCXX_NOEXCEPT
   0x00000000000026b0 <+0>:	mov    (%rdi),%rdx
   0x00000000000026b3 <+3>:	mov    0x8(%rdi),%rcx
   0x00000000000026b7 <+7>:	sub    %rdx,%rcx
   0x00000000000026ba <+10>:	mov    %rcx,%rax
   0x00000000000026bd <+13>:	sar    $0x2,%rax

gdb_demo.cpp:
11	    if (index == values.size()) {
   0x00000000000026c1 <+17>:	cmp    %rax,%rsi
   0x00000000000026c4 <+20>:	je     0x26e0 <_Z13recursive_sumRKSt6vectorIiSaIiEEm+48>
   0x00000000000026c6 <+22>:	lea    (%rdx,%rsi,4),%rax
   0x00000000000026ca <+26>:	add    %rdx,%rcx
   0x00000000000026cd <+29>:	xor    %edx,%edx
   0x00000000000026cf <+31>:	nop

13	    }
14	    return values[index] + recursive_sum(values, index + 1);
   0x00000000000026d0 <+32>:	add    (%rax),%edx

/nix/store/8sjgd7q3mdks1rb7rbcv0sallhvrhai5-gcc-15.3.0/include/c++/15.3.0/bits/stl_vector.h:
1117	      size() const _GLIBCXX_NOEXCEPT
   0x00000000000026d2 <+34>:	add    $0x4,%rax
   0x00000000000026d6 <+38>:	cmp    %rcx,%rax
   0x00000000000026d9 <+41>:	jne    0x26d0 <_Z13recursive_sumRKSt6vectorIiSaIiEEm+32>

gdb_demo.cpp:
15	}
   0x00000000000026db <+43>:	mov    %edx,%eax
   0x00000000000026dd <+45>:	ret
   0x00000000000026de <+46>:	xchg   %ax,%ax

11	    if (index == values.size()) {
   0x00000000000026e0 <+48>:	xor    %edx,%edx

12	        return 0;
   0x00000000000026e2 <+50>:	mov    %edx,%eax
   0x00000000000026e4 <+52>:	ret
End of assembler dump.
```

`<+32>` 到 `<+41>` 是一个循环：`add (%rax),%edx` 累加当前元素，`add $0x4,%rax` 前进 4 个字节，`cmp` 和 `jne` 判断是否到达末尾。GCC 把尾部递归改写成了循环，一共 53 字节，`-O0` 版本是 99 字节，而且递归深度从 5 层变成了 0 层。源码行号在这段反汇编里被切成了好几块，`size()` 的行号 1117 出现了两次，这就是为什么在优化代码里单步会显得乱跳。

要看到经典的 `<optimized out>`，得去 `worker` 里：

```text
$ gdb -q -nx ./gdb_demo_O2
Reading symbols from ./gdb_demo_O2...
(gdb) break worker
Breakpoint 1 at 0x2660: file gdb_demo.cpp, line 18.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo_O2
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
total=24, average=8, expected_average=6
[New Thread 0x7ffff77ff6c0 (LWP 163471)]
[New Thread 0x7ffff6ffe6c0 (LWP 163472)]
[Switching to Thread 0x7ffff77ff6c0 (LWP 163471)]

Thread 2 "gdb_demo_O2" hit Breakpoint 1, worker (counter=@0x7fffffffb60c: 0, mutex=...) at gdb_demo.cpp:18
18	    for (int i = 0; i < 1000; ++i) {
(gdb) set scheduler-locking step
(gdb) next
19	        std::lock_guard<std::mutex> lock(mutex);
(gdb) next
20	        ++counter;
(gdb) info locals
lock = {_M_device = @0x7fffffffb670}
i = <optimized out>
(gdb) print i
$1 = <optimized out>
```

循环变量 `i` 被优化成了一个寄存器里的计数器，甚至可能被改写成倒数计数，DWARF 在这个位置无法描述它的值，GDB 只能显示 `<optimized out>`。这不是 GDB 丢了数据，而是编译器已经改变了程序在机器层面的形状。

我的流程是：先用 `-O0 -g3` 复现和定位逻辑错误，再用 `-O2 -g3` 确认优化后的行为。如果问题只在优化版本里出现，我会保存 core，直接看寄存器和反汇编，而不是为了让变量显示得漂亮一点就退回 `-O0`，那样很可能把问题本身也一起"修"掉了。

## 没有调试信息时

再编两个版本：不加 `-g` 的，以及 `strip` 过的：

```bash
g++ -std=c++20 -O0 -o gdb_demo_nodebug gdb_demo.cpp
cp gdb_demo_nodebug gdb_demo_stripped
strip gdb_demo_stripped
```

```text
$ ls -l gdb_demo gdb_demo_nodebug gdb_demo_stripped
-rwxr-xr-x 1 bfmhno3 users 417648 Sep 30 00:00 gdb_demo
-rwxr-xr-x 1 bfmhno3 users  55760 Sep 30 00:18 gdb_demo_nodebug
-rwxr-xr-x 1 bfmhno3 users  35280 Sep 30 00:18 gdb_demo_stripped
$ nm gdb_demo_stripped
/etc/profiles/per-user/bfmhno3/bin/bash: line 1: nm: 未找到命令
```

`-g3` 版本是 417648 字节，不带调试信息的是 55760 字节，差了大约 7.5 倍，多出来的全是 DWARF。`strip` 又去掉了符号表，剩下 35280 字节。

没有 `-g` 时 GDB 依然能用，只是降级到符号级：

```text
$ gdb -q -nx ./gdb_demo_nodebug
Reading symbols from ./gdb_demo_nodebug...
(No debugging symbols found in ./gdb_demo_nodebug)
(gdb) break main
Breakpoint 1 at 0x2396
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo_nodebug
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Breakpoint 1, 0x0000555555556396 in main ()
(gdb) info locals
No symbol table info available.
(gdb) print total
No symbol "total" in current context.
(gdb) next
Single stepping until exit from function main,
which has no line number information.
total=24, average=8, expected_average=6
[New Thread 0x7ffff77ff6c0 (LWP 166296)]
[Thread 0x7ffff77ff6c0 (LWP 166296) exited]
[New Thread 0x7ffff6ffe6c0 (LWP 166297)]
[Thread 0x7ffff6ffe6c0 (LWP 166297) exited]
counter=2000
__libc_start_call_main (main=main@entry=0x555555556384 <main>, argc=argc@entry=1, argv=argv@entry=0x7fffffffb7e8) at ../sysdeps/nptl/libc_start_call_main.h:74
warning: 74	../sysdeps/nptl/libc_start_call_main.h: No such file or directory
```

`Reading symbols` 后面跟着 `(No debugging symbols found in ...)`，这是第一个信号。`break main` 仍然成功，因为 `main` 在 ELF 符号表里，但输出只有地址，没有 `file ..., line ...`。停止行是 `0x0000555555556396 in main ()`：有地址，空括号，没有源码。局部变量、`total` 都不存在，`next` 找不到行号信息，只能一直运行到 `main` 返回。

`strip` 过的版本连 `main` 这个名字都没有了：

```text
$ gdb -q -nx ./gdb_demo_stripped
Reading symbols from ./gdb_demo_stripped...
(No debugging symbols found in ./gdb_demo_stripped)
(gdb) break main
Function "main" not defined.
Make breakpoint pending on future shared library load? (y or [n]) n
(gdb) info functions recursive
All functions matching regular expression "recursive":
```

`Function "main" not defined.` 之后 GDB 以为它可能在某个还没加载的共享库里，所以询问是否设置 pending 断点，我回答了 `n`。这时只能按地址下断点、读寄存器和反汇编，工作量会大很多。发布版本通常是 strip 过的，这也是为什么值得把调试符号单独保存下来，就像 Nixpkgs 对 glibc 做的那样。

## TUI：同一屏里看源码

`layout src` 把终端分成源码窗口和命令窗口。下面是我停在第 28 行、执行一次 `next` 之后的屏幕，窗口宽 100 列：

```text
┌─gdb_demo.cpp─────────────────────────────────────────────────────────────────────────────────────┐
│       22 }                                                                                       │
│       23                                                                                         │
│       24 int main(int argc, char* argv[]) {                                                      │
│       25     const std::string mode = argc > 1 ? argv[1] : "";                                   │
│       26     std::vector<int> values{3, 5, 7, 9};                                                │
│       27     const int total = recursive_sum(values, 0);                                         │
│B+     28     const double average = static_cast<double>(total) / (values.size() - 1);            │
│  >    29     std::cout << "total=" << total << ", average=" << average                           │
│       30               << ", expected_average=6\n";                                              │
│       31                                                                                         │
│       32     int counter = 0;                                                                    │
│       33     std::mutex mutex;                                                                   │
│       34     std::thread first(worker, std::ref(counter), std::ref(mutex));                      │
│       35     std::thread second(worker, std::ref(counter), std::ref(mutex));                     │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
multi-thre Thread 0x7ffff7e907 (src) In: main                              L29   PC: 0x55555555648d
(gdb) next
```

- `B+` 是断点标记：`B` 表示这个断点至少命中过一次（从没命中过是小写 `b`），`+` 表示它处于启用状态（禁用是 `-`）。
- `>` 标出下一条将要执行的行。
- 底部状态栏依次是：目标类型（`multi-thre` 是被截断的 `multi-threaded process`）、当前线程、当前布局 `(src)`、当前函数、行号 `L29`，以及当前 pc。

`layout asm` 显示反汇编，`layout split` 同时显示源码和反汇编，`layout regs` 在上方加一个寄存器窗口。TUI 模式下方向键会滚动源码窗口，而不是翻命令历史，`focus cmd` 可以把焦点切回命令窗口；`Ctrl-x a` 退出 TUI。窗口布局只影响显示，不改变被调试程序。

## 命令脚本与批处理

重复的调试步骤可以写进文件。我的 `debug.gdb`：

```text
set pagination off
set print pretty on

break recursive_sum
commands
  silent
  printf "recursive_sum(index=%lu), values[index]=%d\n", index, index < values.size() ? values[index] : -1
  continue
end

break 29
commands
  printf "total=%d average=%g\n", total, average
end

define btall
  thread apply all bt
end
document btall
Print the backtrace of every thread.
end

run
```

- `commands ... end` 给最近定义的断点挂一段命令，每次命中时执行。第一段以 `silent` 开头，所以命中时不会打印平时那两行停止信息；最后的 `continue` 让它自动放行。
- `printf` 的用法和 C 一样，参数是 GDB 表达式。`index < values.size() ? values[index] : -1` 避免在最后一层越界读取。
- 第二个断点的命令没有 `continue`，所以会停在那里等我。
- `define` 定义一个新命令，`document` 给它写帮助文本。

用 `-x` 加载：

```text
$ gdb -q -nx -x debug.gdb ./gdb_demo
Reading symbols from ./gdb_demo...
Breakpoint 1 at 0x22da: file gdb_demo.cpp, line 11.
Breakpoint 2 at 0x248d: file gdb_demo.cpp, line 29.
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
recursive_sum(index=0), values[index]=3
recursive_sum(index=1), values[index]=5
recursive_sum(index=2), values[index]=7
recursive_sum(index=3), values[index]=9
recursive_sum(index=4), values[index]=-1

Breakpoint 2, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:29
29	    std::cout << "total=" << total << ", average=" << average
total=24 average=8
(gdb) help btall
Print the backtrace of every thread.
(gdb) btall

Thread 1 (Thread 0x7ffff7e90780 (LWP 164565) "gdb_demo"):
#0  main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:29
```

5 次递归调用各打印一行，`index=4` 那一层是终止条件，打印 `-1`。然后停在第 29 行，执行了挂在上面的 `printf`。注意输出里没有 `Starting program:`，从脚本里执行 `run` 时 GDB 会省略这一行。我在交互提示符下再调用自定义命令 `help btall` 和 `btall`，它们和内置命令用起来没有区别。

通用设置可以放进 `~/.gdbinit`，但我会把项目相关的断点放在项目目录里的脚本里，用 `-x` 显式加载。GDB 默认不会自动执行当前目录下的 `.gdbinit`，这是出于安全考虑：一个恶意仓库可以借此在你的机器上运行任意命令。

在 CI 或者脚本里，`-batch` 让 GDB 执行完 `-ex` 命令后直接退出：

```text
$ gdb -q -nx -batch -ex run -ex bt --args ./gdb_demo --crash 2>&1 | cat
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
[New Thread 0x7ffff77ff6c0 (LWP 169488)]
[Thread 0x7ffff77ff6c0 (LWP 169488) exited]
[New Thread 0x7ffff6ffe6c0 (LWP 169489)]
[Thread 0x7ffff6ffe6c0 (LWP 169489) exited]

Thread 1 "gdb_demo" received signal SIGSEGV, Segmentation fault.
0x000055555555677b in main (argc=2, argv=0x7fffffffb928) at gdb_demo.cpp:57
57	        std::cout << *pointer << "\n";
#0  0x000055555555677b in main (argc=2, argv=0x7fffffffb928) at gdb_demo.cpp:57
```

输出里有栈回溯，但程序自己的那三行 `total=...`、`counter=2000`、`about to dereference ...` 全都不见了。和前面的 `| cat` 是同一个原因：程序的 `stdout` 接到了管道上，崩溃时缓冲区还没刷新。在批处理里抓崩溃现场时，程序输出不可信，要看的是 GDB 打印的栈。

## 反向执行：谁写了这个值

`record full` 会记录之后每一条指令对寄存器和内存的修改，于是可以倒着执行。我用它回答一个具体的问题：`average` 是在哪条指令被写成 `8` 的？

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break 27
Breakpoint 1 at 0x2418: file gdb_demo.cpp, line 27.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".

Breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:27
27	    const int total = recursive_sum(values, 0);
(gdb) record full
(gdb) next
28	    const double average = static_cast<double>(total) / (values.size() - 1);
(gdb) next
29	    std::cout << "total=" << total << ", average=" << average
(gdb) print average
$1 = 8
(gdb) watch average
Hardware watchpoint 2: average
(gdb) reverse-continue
Continuing.

Hardware watchpoint 2: average

Old value = 8
New value = 6.9533558069247378e-310
0x0000555555556488 in main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:28
28	    const double average = static_cast<double>(total) / (values.size() - 1);
(gdb) x/i $pc
=> 0x555555556488 <main(int, char**)+260>:	movsd  %xmm1,-0x30(%rbp)
(gdb) info record
Active record target: record-full
Replay mode:
Lowest recorded instruction number is 1.
Current instruction number is 391.
Highest recorded instruction number is 392.
Log contains 392 instructions.
Max logged instructions is 200000.
```

- `record full` 本身没有输出，但从这里开始的每一步都会被记录。
- 两次 `next` 之后 `average` 是 `8`。在它上面设 watchpoint，然后 `reverse-continue`。
- 倒着执行时 `Old value` 和 `New value` 也是按倒退的方向说的：倒退之前是 `8`，撤销那次写入之后变回了栈上的残留值。
- 停止位置是 `0x0000555555556488`，`x/i $pc` 显示那条指令是 `movsd %xmm1,-0x30(%rbp)`：把 `xmm1` 里算好的双精度结果写到 `average` 在栈上的位置。
- `info record` 显示这两行源码一共记录了 392 条指令，当前停在第 391 条。`Replay mode` 表示此刻是在回放记录，而不是在真实执行。

`record full` 的代价是每条指令都要被 GDB 截获，而且它不认识所有系统调用。在第 34 行创建线程之前打开它：

```text
$ gdb -q -nx ./gdb_demo
Reading symbols from ./gdb_demo...
(gdb) break 34
Breakpoint 1 at 0x2518: file gdb_demo.cpp, line 34.
(gdb) run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libthread_db.so.1".
total=24, average=8, expected_average=6

Breakpoint 1, main (argc=1, argv=0x7fffffffb7f8) at gdb_demo.cpp:34
34	    std::thread first(worker, std::ref(counter), std::ref(mutex));
(gdb) record full
(gdb) next
Process record and replay target doesn't support syscall number 435
Process record: failed to record execution log.

Program stopped.
__GI___clone3 () at ../sysdeps/unix/sysv/linux/x86_64/clone3.S:60
warning: 60	../sysdeps/unix/sysv/linux/x86_64/clone3.S: No such file or directory
```

`syscall number 435` 是 `clone3`，glibc 用它创建线程，而 GDB 17.2 的 process record 不支持它。所以在这个 demo 里，反向执行只能用在单线程的那一段。需要对多线程程序做可靠的录制回放时，我会去看 rr，它是专门为此设计的工具。

## 修复

回到第一个 bug。GDB 帮我确认了：`total` 是对的，`average` 在第 28 行被算错了，而 `total / values.size()` 能得到期望的 `6`。修复只需要改一行：

```diff
-    const double average = static_cast<double>(total) / (values.size() - 1);
+    const double average = static_cast<double>(total) / values.size();
```

重新编译并运行：

```text
$ ./gdb_demo_fixed
total=24, average=6, expected_average=6
counter=2000
```

另外两个错误路径是我故意留下的，`--crash` 的修复就是不要解引用空指针，`--throw` 的修复是不要访问 `values.at(values.size())`。

## 常见输出速查

最后把这一路遇到的输出整理成一张表，下次看到它们时可以直接对照：

| 输出 | 含义 | 下一步 |
| --- | --- | --- |
| `(No debugging symbols found in ...)` | 编译时没有 `-g` | 重新用 `-g3 -O0` 编译 |
| `Function "main" not defined.` | 可执行文件被 strip 过 | 找到对应的调试符号，或按地址下断点 |
| `Breakpoint 1 (xxx) pending.` | 符号还没加载，可能在共享库里 | 运行后用 `info breakpoints` 确认已解析 |
| `Breakpoint 1, main (...) at file:line` | 命中断点，显示的这一行尚未执行 | `next`、`step`、`print` |
| `0x... in func (...) at file:line` | pc 在这一行的中间 | 正常，通常出现在返回或信号之后 |
| `0x... in func () from /path/lib.so` | 这一帧没有调试信息 | `frame N` 跳回自己的代码 |
| `$N = ...` | 值历史，可以用 `$N` 引用 | |
| `x = @0x...: 5` | 引用，`@` 后是它指向的地址 | |
| `mutex=...` | 帧参数被折叠 | `info args` 或 `print mutex` |
| `<optimized out>` | 优化后该位置无法恢复变量的值 | 用 `-O0` 复现，或读寄存器和反汇编 |
| `Cannot access memory at address 0x0` | 地址无效 | `x/i $pc`、`info registers` |
| `Cannot evaluate function -- may be inlined` | 函数被内联或根本没有生成 | 直接读成员或用 `@` 运算符 |
| `Watchpoint N deleted because the program has left the block` | watchpoint 的作用域已结束 | 用 `watch -l` 监视地址 |
| `Old value = ... New value = ...` | watchpoint 触发，停在写入之后 | `bt` 看是谁写的 |
| `[Switching to Thread ...]` | 当前线程被切换 | `info threads` |
| `Thread 2.1 ... Breakpoint 1.2` | 多 inferior 时的两级编号 | `info inferiors` |
| `(*): Shared library is missing debugging information.` | 共享库没有调试符号 | NixOS 上设置 `NIX_DEBUG_INFO_DIRS` |
| `warning: 56	xxx.S: No such file or directory` | 有调试符号但没有源码 | 可以忽略，或用 `directory` 指定源码 |
| `Process record ... doesn't support syscall number N` | 录制遇到不支持的系统调用 | 缩小录制范围，或换用 rr |

## 我以后会怎样使用 GDB

这次实验里，错误的平均值从输出里的 `8` 一路追到了第 28 行的一条 `movsd` 指令；两个线程把 `counter` 从 `0` 加到 `2000` 的过程，被一个 `watch -l` 拆成了 `1000 + 500 + 500`；空指针崩溃则被源码、指令和寄存器三层证据同时指认。真正改变我习惯的不是记住了多少命令，而是终于能读懂 GDB 在每一步说了什么：哪一行已经执行、哪一行还没执行，这个地址是谁的地址，那个 `...` 为什么是 `...`。

写这篇文章时让我最意外的是 `-O2` 那一节。我原本以为会看到满屏的 `<optimized out>`，结果编译器直接把整个递归算成了一个常数 `0x18`，函数一次都没有被调用。源码和机器指令之间的距离，已经比我脑子里的模型远得多。

再往前看，这个距离大概只会继续变长：编译器更激进，LTO 跨文件内联，异步运行时把一个函数切成好几个状态机片段，越来越多的代码也不是人一行一行写出来的。调试器也许会被接到更聪明的前端上，但我怀疑底层问题不会变：暂停一个进程，然后把寄存器和内存里的字节翻译回人能理解的名字和行号。能读懂这层翻译，就能在任何前端失灵的时候退回来自己看。

现在我可以把 `values.size() - 1` 改回来，重新编译，然后去吃点东西。GDB 不会替我修 bug，它只是非常耐心地证明我确实写错了。

## 题外话：我平时用的 gdb-dashboard

前面所有会话我都加了 `-nx`，因为我想让你看到 GDB 最原始的输出。但我日常调试时并不这样用。我的 `~/.gdbinit` 由 home-manager 生成，里面加载了 [gdb-dashboard](https://github.com/cyrus-and/gdb-dashboard)：每次程序停下，它都会在终端里重画一整屏状态，源码、汇编、寄存器、调用栈、线程、变量一次看全。

::github{repo="cyrus-and/gdb-dashboard"}

### 配置

这是我 NixOS 配置里的 `home/dev/gdb.nix`：

```nix
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.myHome.dev.gdb;
in
{
  options.myHome.dev.gdb.enable = lib.mkEnableOption "GDB configuration";
  config = lib.mkIf cfg.enable {
    home.packages = [ pkgs.gdb ];
    home.file.".gdbinit".text = ''
      source ${pkgs.gdb-dashboard}/share/gdb-dashboard/gdbinit
      set pagination off
      set print pretty on
      set confirm off
      set history save on
      set history size 1000
      set history filename ~/.gdb_history
    '';
  };
}
```

`home.file.".gdbinit".text` 让 home-manager 把这段文本写成 `~/.gdbinit`，第一行 `source` 加载 Nixpkgs 打包的 gdb-dashboard 0.17.4，它是一个 2388 行的 gdbinit 文件，主体是一大段 Python。后面几行是我自己的偏好：

- `set pagination off`：关掉分页。前面 `-O2` 那节里 `disassemble /s main` 输出太长，GDB 停下来问 `--Type <RET> for more, q to quit, c to continue without paging--`，就是分页在起作用。
- `set print pretty on`：结构体按缩进多行打印，效果和前面 `print mutex` 那节一样。
- `set confirm off`：不再确认。前面 `quit`、`return 100`、`delete` 时的 `(y or n)` 提问都会消失，GDB 直接照做。这很省事，也意味着手滑的 `delete` 会一次删光所有断点。
- `set history save on` 和后两行：把命令历史存进 `~/.gdb_history`，下次启动 GDB 还能用上方向键翻到上一次的命令。

### 在本文的 flake 里它坏了

我把这套配置带进本文的 flake shell，第一次 `run` 就得到了一屏 Python 异常：

```text
$ gdb -q ./gdb_demo
Reading symbols from ./gdb_demo...
>>> break 29
Breakpoint 1 at 0x248d: file gdb_demo.cpp, line 29.
>>> run
Starting program: /tmp/gdb-post/gdb_demo
Traceback (most recent call last):
  File "<string>", line 430, in on_continue
  File "<string>", line 616, in get_term_size
SystemError: buffer overflow
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libth
read_db.so.1".

Breakpoint 1, main (argc=1, argv=0x7fffffffb808) at gdb_demo.cpp:29
29	    std::cout << "total=" << total << ", average=" << average
Cannot write the dashboard
Traceback (most recent call last):
  File "<string>", line 522, in render
  File "<string>", line 616, in get_term_size
SystemError: buffer overflow

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "<string>", line 524, in render
  File "<string>", line 616, in get_term_size
SystemError: buffer overflow
```

`get_term_size` 是 dashboard 读取终端宽高的函数，它失败之后整个 dashboard 都画不出来（`Cannot write the dashboard`），只剩 GDB 原本的输出。奇怪的是，同一个 `~/.gdbinit` 在我平时的系统 gdb 里一直正常。两个 gdb 都是 17.2，区别在嵌入的 Python 版本上：

```text
$ /etc/profiles/per-user/bfmhno3/bin/gdb -nx -batch -ex 'python import sys; print(sys.version)'
3.13.15 (main, Aug  5 2026, 12:25:43) [GCC 15.3.0]
$ /etc/profiles/per-user/bfmhno3/bin/gdb -nx -batch -ex 'python import fcntl, termios, struct; print(struct.unpack("hh", fcntl.ioctl(0, termios.TIOCGWINSZ, " " * 4)))'
(40, 120)
$ nix develop -c gdb -nx -batch -ex 'python import sys; print(sys.version)' 2>/dev/null | tail -n 1
3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ nix develop -c gdb -nx -batch -ex 'python import fcntl, termios, struct; print(struct.unpack("hh", fcntl.ioctl(0, termios.TIOCGWINSZ, " " * 4)))' 2>&1 | tail -n 2
Python Exception <class 'SystemError'>: buffer overflow
Error occurred in Python: buffer overflow
$ nix develop -c gdb -nx -batch -ex 'python import fcntl, termios, struct; print(struct.unpack("hhhh", fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))))' 2>&1 | tail -n 1
(40, 120, 1920, 1280)
```

我的系统配置还停在 Python 3.13，本文 flake 锁定的 nixpkgs 里 gdb 已经换成了 Python 3.14。dashboard 调用 `fcntl.ioctl(fd, termios.TIOCGWINSZ, ' ' * 4)` 时只准备了 4 个字节的缓冲区，但内核返回的 `struct winsize` 是 4 个 `unsigned short`，一共 8 字节：行数、列数，再加上两个像素尺寸（上面的 `1920, 1280` 就是 tmux 报告的像素宽高）。在 Python 3.13 里这 4 个多出来的字节会被悄悄丢掉；从我的测试看，Python 3.14 改成了直接抛出 `SystemError: buffer overflow`。缓冲区换成 8 字节就恢复正常。

修复不需要改 dashboard 本身。dashboard 启动时会按顺序遍历几个配置目录，其中之一是 `$XDG_CONFIG_HOME/gdb-dashboard`（默认是 `~/.config/gdb-dashboard`），`.py` 文件会先于普通 GDB 命令文件加载，而且和 dashboard 运行在同一个 Python 命名空间里。所以我放一个很小的补丁文件 `~/.config/gdb-dashboard/00-term-size.py`，把 `Dashboard.get_term_size` 换掉：

```python
# gdb-dashboard 0.17.4 只给 TIOCGWINSZ 传了 4 字节缓冲区，
# Python 3.14 会因为内核写回 8 字节的 struct winsize 而抛出 SystemError。
import fcntl
import struct
import termios


def _get_term_size(fd=1):
    try:
        raw = fcntl.ioctl(fd, termios.TIOCGWINSZ, bytes(8))
        height, width, _, _ = struct.unpack("hhhh", raw)
        return int(width), int(height)
    except OSError:
        return 80, 24


Dashboard.get_term_size = staticmethod(_get_term_size)
```

在 home-manager 里，可以把这个文件保存成 `gdb.nix` 旁边的 `gdb-dashboard-term-size.py`，然后在上面的 `config = lib.mkIf cfg.enable { ... }` 里加上一项：

```nix
xdg.configFile."gdb-dashboard/00-term-size.py".source = ./gdb-dashboard-term-size.py;
```

我是用 `XDG_CONFIG_HOME` 指向一个临时目录来验证这个补丁的，下面的截图和输出都在打了补丁的 flake shell 里生成。home-manager 那一行我还没有在自己的配置里 rebuild 过，写法是 home-manager 的标准 `xdg.configFile` 选项。

### 一屏里有什么

补丁生效后，同样停在第 29 行，终端变成了这样（100 列宽的终端，颜色是 dashboard 的默认配色）：

![gdb-dashboard 停在 gdb_demo.cpp 第 29 行时的完整界面，从上到下依次是 Output/messages、Assembly、Breakpoints、Expressions、History、Memory、Registers、Source、Stack、Threads 和 Variables 模块](/assets/images/gdb-dashboard-overview.webp)

纯文本版本如下，方便复制对照：

```text
─── Output/messages ────────────────────────────────────────────────────────────────────────────────
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libth
read_db.so.1".

Breakpoint 1, main (argc=1, argv=0x7fffffffb7e8) at gdb_demo.cpp:29
29	    std::cout << "total=" << total << ", average=" << average
─── Assembly ───────────────────────────────────────────────────────────────────────────────────────
 0x0000555555556473  main(int, char**)+239 cvtsi2sd %rdx,%xmm0
 0x0000555555556478  main(int, char**)+244 addsd  %xmm0,%xmm0
 0x000055555555647c  main(int, char**)+248 movsd  -0x118(%rbp),%xmm1
 0x0000555555556484  main(int, char**)+256 divsd  %xmm0,%xmm1
 0x0000555555556488  main(int, char**)+260 movsd  %xmm1,-0x30(%rbp)
!0x000055555555648d  main(int, char**)+265 lea    0x2bae(%rip),%rdx        # 0x555555559042
 0x0000555555556494  main(int, char**)+272 lea    0x5c65(%rip),%rax        # 0x55555555c100 <_ZSt4co
ut@GLIBCXX_3.4>
 0x000055555555649b  main(int, char**)+279 mov    %rdx,%rsi
 0x000055555555649e  main(int, char**)+282 mov    %rax,%rdi
 0x00005555555564a1  main(int, char**)+285 call   0x555555556130 <_ZStlsISt11char_traitsIcEERSt13bas
ic_ostreamIcT_ES5_PKc@plt>
─── Breakpoints ────────────────────────────────────────────────────────────────────────────────────
[1] break at 0x000055555555648d in gdb_demo.cpp:29 for gdb_demo.cpp:29 hit 1 time
─── Expressions ────────────────────────────────────────────────────────────────────────────────────
─── History ────────────────────────────────────────────────────────────────────────────────────────
─── Memory ─────────────────────────────────────────────────────────────────────────────────────────
─── Registers ──────────────────────────────────────────────────────────────────────────────────────
          rax 0x0000000000000003          rbx 0x0000000000000000         rcx 0x0000555555559380
          rdx 0x0000000000000010          rsi 0x0000000000000004         rdi 0x00007fffffffb600
          rbp 0x00007fffffffb6c0          rsp 0x00007fffffffb5a0          r8 0x0000000000000000
           r9 0x0000000000000000          r10 0x0000000000000000         r11 0x00007ffff797f0c0
          r12 0x0000555555559380          r13 0x0000000000000004         r14 0x00007ffff7ffd000
          r15 0x000055555555bd20          rip 0x000055555555648d      eflags [ PF IF ]
           cs 0x00000033                   ss 0x0000002b                  ds 0x00000000
           es 0x00000000                   fs 0x00000000                  gs 0x00000000
      fs_base 0x00007ffff7e90780      gs_base 0x0000000000000000
─── Source ─────────────────────────────────────────────────────────────────────────────────────────
 24  int main(int argc, char* argv[]) {
 25      const std::string mode = argc > 1 ? argv[1] : "";
 26      std::vector<int> values{3, 5, 7, 9};
 27      const int total = recursive_sum(values, 0);
 28      const double average = static_cast<double>(total) / (values.size() - 1);
!29      std::cout << "total=" << total << ", average=" << average
 30                << ", expected_average=6\n";
 31
 32      int counter = 0;
 33      std::mutex mutex;
─── Stack ──────────────────────────────────────────────────────────────────────────────────────────
[0] from 0x000055555555648d in main(int, char**)+265 at gdb_demo.cpp:29
─── Threads ────────────────────────────────────────────────────────────────────────────────────────
[1] id 207278 name gdb_demo from 0x000055555555648d in main(int, char**)+265 at gdb_demo.cpp:29
─── Variables ──────────────────────────────────────────────────────────────────────────────────────
arg argc = 1, argv = 0x7fffffffb7e8: 47 '/'
loc mode = "", values = std::vector of length 4, capacity 4 = {[0] = 3, [1] = 5, [2] = 7, [3] = 9},
total = 24, average = 8, counter = -1, mutex = {<std::__mutex_base> = {_M_mutex = {__data = {__lock
= 1128415552,__count = 1195787588,__owner = 143…, first = {_M_id = {_M_thread = 140737346454874}}, s
econd = {_M_id = {_M_thread = 140737488336448}}
────────────────────────────────────────────────────────────────────────────────────────────────────
```

有了前面的铺垫，这一屏里几乎每一块都能对应到一个已经读过的命令：

- `Output/messages`：每次继续执行前，dashboard 会清屏并画出这个分隔线，之后 GDB 自己的输出和程序的输出都落在这里。`Breakpoint 1, main (...) at gdb_demo.cpp:29` 和之前的格式完全一样。
- `Assembly`：相当于在 pc 附近自动执行 `x/10i`。行首的红色 `!` 表示这条指令上有一个启用的断点，绿色高亮的是当前 pc。紧挨在当前指令上面的那条，就是前面反向执行那一节找到的 `movsd %xmm1,-0x30(%rbp)`，`average` 就是在那里被写成 `8` 的。
- `Breakpoints`：精简版的 `info breakpoints`，`hit 1 time` 是命中次数。
- `Expressions`、`History`、`Memory`：默认是空的，需要自己添加监视项，后面会用到。
- `Registers`：`info registers` 的紧凑版，三列排列。单步之后值发生变化的寄存器会被高亮，这是我最喜欢的功能之一：一眼就能看出上一条指令改了哪个寄存器。
- `Source`：自动执行的 `list`，`!` 依然是断点，当前行用绿色标出。
- `Stack`：`bt` 的精简版。`[0] from 0x000055555555648d in main(int, char**)+265 at gdb_demo.cpp:29` 里，`+265` 和 `x/i` 输出里的 `<main(int, char**)+265>` 是同一个意思。
- `Threads`：`info threads`。`id 207278` 是 LWP，不是 GDB 线程编号，GDB 编号在方括号里。
- `Variables`：`info args` 加 `info locals`，`arg` 前缀是参数，`loc` 前缀是局部变量。`argv = 0x7fffffffb7e8: 47 '/'` 是 dashboard 顺手对指针做了一次解引用：`argv` 指向的第一个字节是 `'/'`，ASCII 码 47，也就是 `argv[0]` 字符串 `/tmp/gdb-post/gdb_demo` 的第一个字符。太长的值会用 `…` 截断，所以 `mutex` 那一串残留值没显示完。

`next` 两次之后，其他模块在原地刷新，新内容只出现在 `Output/messages` 里（下面只截取了这一块）：

```text
─── Output/messages ────────────────────────────────────────────────────────────────────────────────
total=24, average=8, expected_average=6
32	    int counter = 0;
```

程序的输出 `total=24, average=8, expected_average=6` 和 GDB 打印的 `32	    int counter = 0;` 挤在一起，这是一次 `next` 期间全部的新输出。

### 定制布局

默认 11 个模块一屏放不下，小终端上源码会被挤到很下面。我通常只留几个，接着上面停在第 29 行的会话输入：

```text
>>> dashboard -layout source variables expressions memory
>>> dashboard source -style height 8
>>> dashboard variables -style compact False
>>> dashboard expressions watch (double) total / values.size()
>>> dashboard memory watch &values[0] 16
>>> next
>>> next
```

最后一次 `next` 之后，屏幕上是这样：

```text
─── Output/messages ────────────────────────────────────────────────────────────────────────────────
total=24, average=8, expected_average=6
32	    int counter = 0;
─── Source ─────────────────────────────────────────────────────────────────────────────────────────
 28      const double average = static_cast<double>(total) / (values.size() - 1);
!29      std::cout << "total=" << total << ", average=" << average
 30                << ", expected_average=6\n";
 31
 32      int counter = 0;
 33      std::mutex mutex;
 34      std::thread first(worker, std::ref(counter), std::ref(mutex));
 35      std::thread second(worker, std::ref(counter), std::ref(mutex));
─── Variables ──────────────────────────────────────────────────────────────────────────────────────
arg argc = 1
arg argv = 0x7fffffffb7e8: 47 '/'
loc mode = ""
loc values = std::vector of length 4, capacity 4 = {[0] = 3, [1] = 5, [2] = 7, [3] = 9}
loc total = 24
loc average = 8
loc counter = -1
loc mutex = {<std::__mutex_base> = {_M_mutex = {__data = {__lock = 1128415552,__count = 1195787588,_
_owner = 143…
loc first = {_M_id = {_M_thread = 140737346454874}}
loc second = {_M_id = {_M_thread = 140737488336448}}
─── Expressions ────────────────────────────────────────────────────────────────────────────────────
[1] (double) total / values.size() = 6
─── Memory ─────────────────────────────────────────────────────────────────────────────────────────
─── &values[0] ─────────────────────────────────────────────────────────────────────────────────────
0x000055555556f320  03 00 00 00 05 00 00 00 07 00 00 00 09 00 00 00  ················
────────────────────────────────────────────────────────────────────────────────────────────────────
```

- `dashboard -layout` 后面跟模块名，只显示这些模块，顺序也按这里排。
- `dashboard source -style height 8` 把源码窗口限制为 8 行。每个模块都有自己的一组 style。
- `dashboard variables -style compact False` 让每个变量独占一行，而不是挤成一段。
- `dashboard expressions watch ...` 添加一个监视表达式，每次停下都重新求值，效果类似前面的 `display`，但它固定显示在自己的面板里。我把正确公式 `(double) total / values.size()` 放了进去，它一直显示 `6`，而旁边的 `average` 是 `8`，这个 bug 就摆在屏幕上。
- `dashboard memory watch &values[0] 16` 监视从 `&values[0]` 开始的 16 个字节，格式和前面的 `x/16xb` 一样，右边还附带了 ASCII 列，不可打印字符显示成 `·`。被修改的字节会高亮。
- 单独执行 `dashboard` 会立即重画一次。

调好之后，`dashboard -configuration` 会把当前布局和样式导出成 GDB 命令：

```text
>>> dashboard -configuration /tmp/gdb-post/dash-config
dashboard -layout source variables expressions memory !assembly !breakpoints !history !registers !st
ack !threads
dashboard source -style height 8
dashboard variables -style compact False
```

前面带 `!` 的模块是被关掉的。把这几行存进 `~/.config/gdb-dashboard/` 里的某个文件（不带 `.py` 后缀，按普通 GDB 命令加载），下次启动就是这个布局。监视表达式不会被导出，因为它们通常和具体程序绑定，我会把它们写进项目自己的 `debug.gdb`。

我还试过 `dashboard -style ansi False` 关掉颜色，想让复制出来的文本带上 `>` 这样的纯文本标记。结果在 0.17.4 里，这个模式下 `Variables` 模块直接抛出 `TypeError: unsupported operand type(s) for +: 'gdb.Symbol' and 'str'`，`Breakpoints` 还把一个启用的断点标成了 `disabled`。读源码看，两处都是 `ansi=False` 分支里的小 bug，所以我一直用默认的彩色模式。

### 把 dashboard 放到另一个终端

dashboard 最舒服的用法是把它输出到另一个终端窗口，GDB 的命令行就能保持干净。我在 tmux 里左右分屏，右边的 pane 只运行一个 `sleep`，让它的终端空着，然后在左边的 GDB 里把 dashboard 指过去。右边 pane 的终端设备可以用 tmux 的 `#{pane_tty}` 格式变量查到，我这里是 `/dev/pts/4`。然后在左边：

```text
$ gdb -q ./gdb_demo
Reading symbols from ./gdb_demo...
>>> dashboard -output /dev/pts/4
>>> dashboard -layout source variables stack
 Dashboard    /dev/pts/4

 source       (default TTY)
 variables    (default TTY)
 stack        (default TTY)
!assembly     (default TTY)
!breakpoints  (default TTY)
!expressions  (default TTY)
!history      (default TTY)
!memory       (default TTY)
!registers    (default TTY)
!threads      (default TTY)
>>> dashboard source -style height 8
>>> dashboard variables -style compact False
>>> break 29
Breakpoint 1 at 0x248d: file gdb_demo.cpp, line 29.
>>> run
Starting program: /tmp/gdb-post/gdb_demo
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/libth
read_db.so.1".

Breakpoint 1, main (argc=1, argv=0x7fffffffb7e8) at gdb_demo.cpp:29
29	    std::cout << "total=" << total << ", average=" << average
>>> next
30	              << ", expected_average=6\n";
```

右边的 pane 里是这样：

```text
─── Source ─────────────────────────────────────────────────────────────────────────────────────────
 26      std::vector<int> values{3, 5, 7, 9};
 27      const int total = recursive_sum(values, 0);
 28      const double average = static_cast<double>(total) / (values.size() - 1);
!29      std::cout << "total=" << total << ", average=" << average
 30                << ", expected_average=6\n";
 31
 32      int counter = 0;
 33      std::mutex mutex;
─── Variables ──────────────────────────────────────────────────────────────────────────────────────
arg argc = 1
arg argv = 0x7fffffffb7e8: 47 '/'
loc mode = ""
loc values = std::vector of length 4, capacity 4 = {[0] = 3, [1] = 5, [2] = 7, [3] = 9}
loc total = 24
loc average = 8
loc counter = -1
loc mutex = {<std::__mutex_base> = {_M_mutex = {__data = {__lock = 1128415552,__count = 1195787588,_
_owner = 143…
loc first = {_M_id = {_M_thread = 140737346454874}}
loc second = {_M_id = {_M_thread = 140737488336448}}
─── Stack ──────────────────────────────────────────────────────────────────────────────────────────
[0] from 0x00005555555564e2 in main(int, char**)+350 at gdb_demo.cpp:30
```

`dashboard -output /dev/pts/4` 把整个 dashboard 写到那个终端，`dashboard -layout` 的输出第一行 `Dashboard    /dev/pts/4` 确认了这一点。左边的 GDB 会话看起来和前面 `-nx` 的会话几乎一样，只是提示符变成了 `>>>`；每次停下，右边原地刷新。单个模块也可以分别输出，比如 `dashboard source -output /dev/pts/5`，把源码放到第三个窗口。

说到底，dashboard 并没有给 GDB 增加新的能力。它只是在每次停下时替我执行了一遍 `x/i`、`info registers`、`list`、`bt`、`info threads`、`info locals`，再加上几个 `display`，然后把结果排好版。正因为前面把这些命令的原始输出一行行读过，这一屏信息才不是噪声：我知道 `+265` 是什么，知道为什么 `argv` 后面跟着一个 `'/'`，也知道当 dashboard 自己坏掉时，退回 `gdb -nx` 依然能把事情做完。

## 参考资料

下面是我写这篇文章时实际查阅过的资料。GDB 手册链接指向当前版本的在线文档，行为细节以你手里的 GDB 版本为准。

### GDB 手册

- [Debugging with GDB](https://sourceware.org/gdb/current/onlinedocs/gdb.html/)：GDB 官方手册首页。
- [Breakpoints](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Breakpoints.html)、[Set Watchpoints](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Set-Watchpoints.html)、[Set Catchpoints](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Set-Catchpoints.html)：断点、watchpoint（包括 `watch -location`）和 catchpoint。
- [Continuing and Stepping](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Continuing-and-Stepping.html)、[Returning](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Returning.html)：`next`、`step`、`until`、`advance`、`finish` 和 `return`。
- [Frames](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Frames.html)：栈帧、`backtrace` 和 `info frame`。
- [Memory](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Memory.html)、[Output Formats](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Output-Formats.html)、[Print Settings](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Print-Settings.html)：`x/nfu`、`print/x` 等格式，以及 `print pretty`、`print frame-arguments`。
- [Automatic Display](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Auto-Display.html)、[Convenience Variables](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Convenience-Vars.html)：`display` 与 `$_exitcode` 这类便利变量。
- [Registers](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Registers.html)、[Source and Machine Code](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Machine-Code.html)：`info registers`、`$pc` 和 `disassemble /s`。
- [Signals](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Signals.html)：`handle` 和 `info signals` 那张表。
- [Threads](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Threads.html)、[All-Stop Mode](https://sourceware.org/gdb/current/onlinedocs/gdb.html/All_002dStop-Mode.html)、[Stopping and Starting Multi-thread Programs](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Thread-Stops.html)：线程编号、all-stop 模式和 `set scheduler-locking`。
- [Debugging Forks](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Forks.html)：`follow-fork-mode`、`detach-on-fork` 和多 inferior。
- [Debugging Remote Programs](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Remote-Debugging.html)：`gdbserver`、`target remote` 与 `set sysroot`。
- [Core File Generation](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Core-File-Generation.html)：`generate-core-file`。
- [Debugging Optimized Code](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Optimized-Code.html)：内联函数和 `<optimized out>`。
- [Process Record and Replay](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Process-Record-and-Replay.html)：`record full` 与各种 `reverse-*` 命令。
- [TUI](https://sourceware.org/gdb/current/onlinedocs/gdb.html/TUI.html)：`layout`、`focus` 和 TUI 快捷键。
- [Command Files](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Command-Files.html)：`source`、`-x`、`-batch` 和 `define`。
- [Debugging Information in Separate Files](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Separate-Debug-Files.html)、[The auto-load safe-path](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Auto_002dloading-safe-path.html)：`debug-file-directory` 和脚本自动加载的安全路径。

### 编译器与平台

- [GCC: Options for Debugging Your Program](https://gcc.gnu.org/onlinedocs/gcc/Debugging-Options.html)：`-g3` 等调试信息选项。
- [GCC: Options That Control Optimization](https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html)：`-O0`、`-O2` 与 `-fno-omit-frame-pointer`。
- [libstdc++: Debugging Support](https://gcc.gnu.org/onlinedocs/libstdc++/manual/debug.html)：libstdc++ 的 GDB pretty printer。
- [x86-64 psABI](https://gitlab.com/x86-psABIs/x86-64-ABI)：System V x86-64 调用约定，参数寄存器 `rdi`、`rsi` 的来源。
- [TIOCGWINSZ(2const)](https://man7.org/linux/man-pages/man2/TIOCGWINSZ.2const.html)：`struct winsize` 的定义，gdb-dashboard 那个 4 字节缓冲区问题的根源。
- [coredumpctl(1)](https://man7.org/linux/man-pages/man1/coredumpctl.1.html)：`coredumpctl list` 和 `coredumpctl debug`。
- [Python fcntl 模块文档](https://docs.python.org/3/library/fcntl.html)：`fcntl.ioctl` 的缓冲区参数语义。

### Nix 与 NixOS

- [Nixpkgs 手册：Hardening in Nixpkgs](https://nixos.org/manual/nixpkgs/stable/#sec-hardening-in-nixpkgs)：cc-wrapper 默认启用的加固参数和 `hardeningDisable`。
- [Nixpkgs cc-wrapper 源码](https://github.com/NixOS/nixpkgs/tree/master/pkgs/build-support/cc-wrapper)：`NIX_DEBUG=1` 打印的 `extra flags before` 就来自这里。
- [Nixpkgs gdb 包定义](https://github.com/NixOS/nixpkgs/blob/master/pkgs/by-name/gd/gdb/package.nix) 和 [debug-info-from-env.patch](https://github.com/NixOS/nixpkgs/blob/master/pkgs/by-name/gd/gdb/debug-info-from-env.patch)：`auto-load safe-path` 的默认值，以及 `NIX_DEBUG_INFO_DIRS` 是怎么被读取的。
- [NixOS Wiki: Debug Symbols](https://wiki.nixos.org/wiki/Debug_Symbols)：在 NixOS 上获取分离调试符号的几种方式。
- [nix develop](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-develop)：flake 开发环境。
- [Home Manager 选项手册](https://nix-community.github.io/home-manager/options.xhtml)：`home.file` 与 `xdg.configFile`。

### 其他工具

- [gdb-dashboard](https://github.com/cyrus-and/gdb-dashboard)、[它的 Wiki](https://github.com/cyrus-and/gdb-dashboard/wiki) 与 [.gdbinit 源码](https://github.com/cyrus-and/gdb-dashboard/blob/master/.gdbinit)：题外话一节里的配置目录、`-layout`、`-output` 和 `get_term_size` 都能在源码里找到。
- [rr](https://rr-project.org/)：面向多线程程序的录制与回放调试器。
- [ThreadSanitizer](https://clang.llvm.org/docs/ThreadSanitizer.html)：数据竞争检测工具。
