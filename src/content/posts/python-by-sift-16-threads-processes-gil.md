---
title: "并发（上）：线程、进程、GIL 与自由线程"
commentId: "post:python-by-sift-16-threads-processes-gil"
published: "2026-10-25 03:00:00 +08:00"
description: "用 Sift 重学 Python 第 16 篇：我用 Python 3.14.7 和 python3.14t（自由线程构建）给 Sift 的索引器加了 --jobs 和 --mode，在 984 篇文档的语料上比较进程池、线程池和子解释器池。同一行 counter.value += 1，8 个线程在 python3 上丢 0 次更新，在 python3.14t 上丢约 100 万次；8 个工作线程的线程池在带 GIL 的构建上是串行的 0.63 到 0.68 倍，在自由线程构建上是 2.67 到 2.85 倍，进程池和子解释器池最多 1.55 倍，因为父进程要串行地反序列化和合并。"
category: Tutorial
tags:
  - Python
  - Sift
  - 并发
  - 多线程
  - 多进程
  - GIL
series: "用 Sift 重学 Python"
seriesOrder: 16
draft: false
comment: true
slug: python-by-sift-16-threads-processes-gil
---

同一行 `counter.value += 1`，8 个线程各执行 20 万次，一共 160 万次。在 `python3` 上一次更新都没有丢；在 `python3.14t`（自由线程构建）上只有 56 万次落进了计数器，丢了 103 万次。两个解释器都是 3.14.7，这一行编出来的字节码也一样（后面我会用 `dis` 对给你看），区别只在有没有那把全局解释器锁。这一篇从这两行输出出发：拆开线程、锁、进程、子解释器和自由线程构建，最后把 `sift index` 接上 `--jobs` 和 `--mode`，用同一份语料量三种池各快多少，以及为什么都没有快到核数那么多。

```text
$ python3 lab/ch16/race_condition.py | sed -n 4p
  counter.value += 1                 expected 1600000, got 1600000, lost 0
$ python3.14t lab/ch16/race_condition_ft.py | sed -n 4p
  counter.value += 1                 expected 1600000, got 563991, lost 1036009
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch16`：新增 `src/sift/parallel.py`，进程、线程、子解释器三种池共用一套分块并行索引（`Item`、`Part`、`run_ordered`、`index_items`、`bench_index`）；`src/sift/cli.py` 给 `sift index` 加了 `--jobs` 和 `--mode`，把 `sift bench index` 改成 jobs 乘 mode 的计时表，并让存储模块（连同 SQLAlchemy）用到时才导入；`src/sift/index.py` 的 `InvertedIndex` 多了 `merge` 和 pickle 状态，`PostingList` 多了 `extend` 和 `from_sorted`；`src/sift/storage/store.py` 的 `update_index` 改成调用 `index_items`；`src/sift/__init__.py` 在没有安装元数据时给版本号一个后备值；`README.md` 和 `scripts/chapter.py` 各改了几行；`tests` 下有 4 个文件更新；`lab/ch16` 下有 15 个脚本加一个 `extra.sh`。一共 27 个文件，`git diff --shortstat ch15 ch16` 给出 `27 files changed, 2274 insertions(+), 58 deletions(-)`。`make ch16` 的 15 个脚本全是 `ok`，随后的 `extra.sh` 也是 `ok`，完整测试 619 passed、1 xfailed，`make typecheck` 0 个错误。后面的章节还会改 `cli.py`、`log.py`、`search.py`、`cache.py` 和 `config.py`，`pyproject.toml` 和 `Makefile` 也会各添几条。
> 涉及的 Python 特性：`threading`、`queue`、GIL 与切换间隔、`concurrent.futures`、`multiprocessing`（启动方式、pickle、共享内存）、`concurrent.interpreters`、自由线程构建与 `sys._is_gil_enabled`。
> 前置：[第 15 篇](/posts/python-by-sift-15-metaprogramming/)。上一篇结尾我猜 GIL 替 `LRUCache` 挡掉了很多没写出来的问题，这一篇会量出来，猜对了。

## 环境

和前几篇同一台机器，仓库在标签 `ch16`，命令都在 `nix develop` 里、仓库根目录 `~/Projects/sift` 下跑：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ python3.14t -VV
Python 3.14.7 free-threading build (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags
ch16
$ lscpu | sed -n \
    '/Model name/p;/^CPU(s):/p;/Thread(s) per core/p;/Core(s) per socket/p'
CPU(s):                                  16
Model name:                              AMD Ryzen 7 PRO 6850U with Radeon Graphics
Thread(s) per core:                      2
Core(s) per socket:                      8
```

8 个物理核、16 个逻辑线程，这个数字后面解释加速比的时候要用：我猜 4 个线程大多各占一个物理核，8 个线程开始和同核的另一半争用执行单元，16 个就是满载。

这台机器的 CPU 有快慢两个状态（前几篇测到过差约 2.5 倍），所以计时脚本都让对手轮流跑，每一组前后各夹一次 `cpu_state.py`（第 12 篇贴过的固定忙循环，快状态下 5 个数在 110 到 120 ms 附近）。这一篇夹出来的数最小 112 ms，最大 143 ms，偶尔有 130 多的单个数字，但没有出现过慢状态的 280 ms 上下，所以全篇都是快状态下的数字。我没有在慢状态下重跑，慢状态下的绝对值应该整体偏大，比值我不敢担保。

另外，Nix 的 Python 不带 C 源码，文中引用的 CPython 源码（文件和行号都指 `v3.14.7` 标签）是我按路径从 GitHub 的 raw 地址拉下来放在 `/tmp/cpython-3.14.7/` 的，每一段 C 代码都是按行号切出来的。这一篇用到的 25 个文件：

```bash
$ cd /tmp/cpython-3.14.7
$ for f in Python/ceval_gil.c Include/internal/pycore_gil.h \
      Python/bytecodes.c Python/lock.c Python/gc_free_threading.c \
      Python/crossinterp.c Modules/_threadmodule.c \
      Modules/_interpretersmodule.c Objects/listobject.c \
      Objects/clinic/listobject.c.h \
      Include/internal/pycore_critical_section.h Include/object.h \
      Lib/threading.py Lib/queue.py Lib/concurrent/futures/process.py \
      Lib/concurrent/futures/thread.py \
      Lib/concurrent/futures/interpreter.py \
      Lib/concurrent/interpreters/__init__.py \
      Lib/multiprocessing/context.py Lib/multiprocessing/forkserver.py \
      Lib/multiprocessing/queues.py Lib/multiprocessing/shared_memory.py \
      Doc/whatsnew/3.14.rst Doc/library/queue.rst \
      Doc/library/multiprocessing.shared_memory.rst; do
    mkdir -p "$(dirname "$f")"
    curl -sfL -o "$f" \
        "https://raw.githubusercontent.com/python/cpython/v3.14.7/$f"
done
```

PEP 703、PEP 779 和 PEP 734 我取的是 `python/peps` 仓库 main 分支上的文本（`https://raw.githubusercontent.com/python/peps/main/peps/pep-0703.rst`，另两篇同理），三篇的 `Status:` 行写的都是 `Final`，文中对它们的转述都以这几份文本为准。

最后是仓库的状态。`make ch16` 先跑 15 个脚本（第 1 行是命令头，其后 15 行是脚本，如下），然后跑 `extra.sh`，它的输出是后面基准一节的第一组数字，整个过程 8 分钟左右；完整测试和类型检查也都过了：

```text
$ make ch16 | sed -n 1,16p
python3 scripts/chapter.py ch16
ok   lab/ch16/deadlock_timeout_fail.py
ok   lab/ch16/free_threading_check_ft.py
ok   lab/ch16/futures_tour.py
ok   lab/ch16/gil_cpu_bound.py
ok   lab/ch16/gil_cpu_bound_ft.py
ok   lab/ch16/io_bound_threads.py
ok   lab/ch16/lambda_pickle_fail.py
ok   lab/ch16/locks.py
ok   lab/ch16/multiprocessing_basics.py
ok   lab/ch16/queue_workers.py
ok   lab/ch16/race_condition.py
ok   lab/ch16/race_condition_ft.py
ok   lab/ch16/shared_memory.py
ok   lab/ch16/subinterpreters.py
ok   lab/ch16/threads_basics.py
$ python3 -m pytest | tail -1
619 passed, 1 xfailed in 14.60s
$ make typecheck | tail -2
Success: no issues found in 35 source files
0 errors, 0 warnings, 0 informations
```

`*_fail.py` 要求退出码非零，`*_ft.py` 用 `python3.14t` 跑，`scripts/chapter.py` 按文件名后缀分派，规则写在仓库的 `README.md` 里。

## 线程：一个 OS 线程加一个线程状态

`threading.Thread` 是 `_thread` 的外壳。`Thread.start()` 最终调用 `_start_joinable_thread`（`Lib/threading.py` 第 1005 行），C 这一边是 `Modules/_threadmodule.c` 的 `ThreadHandle_start`（第 403 到 470 行）：先 `_PyThreadState_New` 造一个线程状态（第 428 行），再让操作系统起一个真正的线程（Linux 上是 pthread，第 445 行）。新线程跑的是 `thread_run`，核心是这几行（第 355 到 359 行）：

```c
    _PyThreadState_Bind(tstate);
    PyEval_AcquireThread(tstate);
    _Py_atomic_add_ssize(&tstate->interp->threads.count, 1);

    PyObject *res = PyObject_Call(boot->func, boot->args, boot->kwargs);
```

把线程状态绑到当前 OS 线程上，排队拿 GIL（`PyEval_AcquireThread`），然后才调你的函数。`start()` 在返回前还会 `self._started.wait()`（`threading.py` 第 1011 行），等新线程报到，所以 `start()` 之后 `is_alive()` 立刻是 `True`。`lab/ch16/threads_basics.py` 把线程的生命周期过了一遍，先看启动和 `join` 的那段，以及检查守护线程用的子进程：

```python
CHILD_DAEMON = (
    "import threading, time;"
    "threading.Thread(target=time.sleep, args=(60,), daemon=%s).start();"
    "print('main is done')"
)


def work(label: str, seconds: float, out: list[str]) -> None:
    """Sleep, then record who ran this in which thread."""
    time.sleep(seconds)
    out.append(f"{label} ran in {threading.current_thread().name}")


def run_child(daemon: bool) -> str:
    """Run a child interpreter; say if it exits within one second."""
    argv = [sys.executable, "-c", CHILD_DAEMON % daemon]
    try:
        done = subprocess.run(
            argv, capture_output=True, text=True, timeout=1.0
        )
    except subprocess.TimeoutExpired:
        return "still running after 1 s (a non-daemon thread blocks exit)"
    return f"exit {done.returncode}, stdout {done.stdout.strip()!r}"
```

`main()` 里三个线程睡的时间是 0.15、0.1、0.05 秒，其余部分是下面输出里的各个小节，整份输出：

```text
$ python3 lab/ch16/threads_basics.py
-- start and join
  before start: [False, False, False]
  after start : [True, True, True]
  after join  : [False, False, False]
  finished in the order of the sleeps, not of the starts:
    job2 ran in w2
    job1 ran in w1
    job0 ran in w0
-- the main thread is a thread too
  current is main: True
  main name      : MainThread
  active threads : 1
-- join(timeout) returns, it does not say if the thread ended
  still alive after join(0.01): True
  alive after join()          : False
-- an exception ends the thread, not the program
  join returned; excepthook saw: ['RuntimeError: worker failed in failing']
-- daemon threads do not keep the interpreter alive
  daemon=False: still running after 1 s (a non-daemon thread blocks exit)
  daemon=True : exit 0, stdout 'main is done'
-- the daemon flag is fixed once the thread has started
  RuntimeError: cannot set daemon status of active thread
```

三个线程按睡眠时间的顺序收工，和启动顺序无关。`join(timeout)` 超时后只是返回，不告诉你线程有没有结束，要自己看 `is_alive()`。线程里的异常只终结这个线程，主线程继续；默认的 `threading.excepthook` 会把回溯打到标准错误，这里我换成了一个收集器。最后一组：解释器退出时要等所有非守护线程，`threading._shutdown`（第 1559 到 1583 行）最后一句就是 `_thread_shutdown()`，注释写得很直白，“Wait for all non-daemon threads to exit”，所以 `daemon=False` 的子进程在 1 秒内没有退出；`daemon=True` 的则直接结束。守护线程的代价是它会在退出时被直接丢掉。我写了一个子进程小实验：守护线程在 `try` 里睡觉，`finally` 里打印一行，主线程 0.2 秒后结束：

```python
"""Show that a daemon thread's finally block never runs at exit."""

import subprocess
import sys

CHILD = """
import threading, time
def work():
    try:
        time.sleep(60)
    finally:
        print("finally ran")
threading.Thread(target=work, daemon=True).start()
time.sleep(0.2)
print("main is done")
"""


def main() -> None:
    """Run a child whose daemon thread sleeps inside try/finally."""
    done = subprocess.run(
        [sys.executable, "-c", CHILD],
        capture_output=True,
        text=True,
        timeout=10,
    )
    print("exit", done.returncode, "stdout", done.stdout.splitlines())


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/daemon_finally.py
exit 0 stdout ['main is done']
```

`finally ran` 没有出现，所以 `finally` 里的清理不会跑。持有的锁会不会一起丢，我没有做实验，按同一个机制我猜是的，当成未验证。守护线程只适合真的可以随时丢弃的后台活。

## GIL：保护的是解释器，不是你的程序

上一篇我拆过 `Py_DECREF`，它的主体是一个朴素的 `--op->ob_refcnt`，不是原子操作。两个线程同时对同一个对象做这一步，计数会错，对象要么提前释放要么泄漏。GIL 的出发点就是这个：同一个解释器里，同一时刻只有一个线程在执行 Python 字节码，对象内部的所有朴素读写因此都不会交错。这把锁的状态很小（`Include/internal/pycore_gil.h` 第 40 到 53 行）：一个原子的布尔 `locked`，一个条件变量 `cond`，一个切换计数 `switch_number`，记着上一个持有者的 `last_holder`，外加一个时间片 `interval`（微秒）。线程怎么轮流，在 `Python/ceval_gil.c` 的 `take_gil` 里（第 323 到 339 行，省略的第 340 到 358 行是取持有者 `holder_tstate` 和一个“解释器正在退出”的检查，后面接第 359 和 360 行）：

```c
    int drop_requested = 0;
    while (_Py_atomic_load_int_relaxed(&gil->locked)) {
        unsigned long saved_switchnum = gil->switch_number;

        unsigned long interval = _Py_atomic_load_ulong_relaxed(&gil->interval);
        if (interval < 1) {
            interval = 1;
        }
        int timed_out = 0;
        COND_TIMED_WAIT(gil->cond, gil->mutex, interval, timed_out);

        /* If we timed out and no switch occurred in the meantime, it is time
           to ask the GIL-holding thread to drop it. */
        if (timed_out &&
            _Py_atomic_load_int_relaxed(&gil->locked) &&
            gil->switch_number == saved_switchnum)
        {
            /* ... */
            _Py_set_eval_breaker_bit(holder_tstate, _PY_GIL_DROP_REQUEST_BIT);
            drop_requested = 1;
        }
```

想拿锁的线程先在条件变量上等 `interval` 微秒（默认 5000，`DEFAULT_INTERVAL`，第 147 行，也就是 `sys.getswitchinterval()` 的 0.005 秒）；醒来发现锁还被占着、这段时间里也没人换过手，就在持有者的 `eval_breaker` 上置一个“请放手”的位。注意这只是一个请求，持有者什么时候看到，要看它什么时候去查。查的地方是 `Python/bytecodes.c` 的 `_CHECK_PERIODIC`（第 155 到 162 行）：

```c
        op(_CHECK_PERIODIC, (--)) {
            _Py_CHECK_EMSCRIPTEN_SIGNALS_PERIODICALLY();
            QSBR_QUIESCENT_STATE(tstate);
            if (_Py_atomic_load_uintptr_relaxed(&tstate->eval_breaker) & _PY_EVAL_EVENTS_MASK) {
                int err = _Py_HandlePending(tstate);
                ERROR_IF(err != 0);
            }
        }
```

不是每条字节码之后都查。它挂在三类指令上：`JUMP_BACKWARD`（循环回跳，第 2927 到 2931 行）、`RESUME`（函数入口，第 224 到 228 行，它的特化形式 `RESUME_CHECK` 在第 230 到 243 行）、以及 `CALL` 一族（`macro(CALL)` 在第 3836 行，末尾是 `_CHECK_PERIODIC`）。查到以后进 `_Py_HandlePending`（`ceval_gil.c` 第 1357 到 1434 行），其中处理 GIL 请求的那一段（第 1408 到 1416 行）只有三步：`_PyThreadState_Detach` 放手，让别的线程跑，再 `_PyThreadState_Attach` 回来排队。

`drop_gil` 还有一个 `FORCE_SWITCHING`（`pycore_gil.h` 第 19 和 20 行打开，`ceval_gil.c` 第 251 到 273 行使用）：放手的线程要等到 `last_holder` 变成别人才继续，防止它一放手又马上抢回来、让时间片长得比约定的久。会阻塞的 C 调用（`time.sleep`、读文件、`socket`）在等待期间会主动放掉 GIL，所以后面 I/O 密集的线程能随着线程数线性变快。

这套机制有一个推论：线程切换只会发生在上面那几个“检查点”上。一个语句如果编出来的字节码里没有检查点，它在 3.14.7 里就恰好是原子的，不是因为语言保证，是因为没处可切。`lab/ch16/race_condition.py` 里的两种写法差别就在这里。我写了一个小脚本把它们的字节码并排打出来：

```python
"""Disassemble the two update styles of the race lab."""

import dis


class Counter:
    """A number in an attribute."""

    def __init__(self) -> None:
        self.value = 0


def bump(value: int) -> int:
    """Add one."""
    return value + 1


def plain(counter: Counter) -> None:
    """One read-modify-write statement."""
    for _ in range(3):
        counter.value += 1


def with_call(counter: Counter) -> None:
    """The same with a call in the middle."""
    for _ in range(3):
        seen = counter.value
        counter.value = bump(seen)


def main() -> None:
    """Print the bytecode of both loops."""
    dis.dis(plain)
    print("-----")
    dis.dis(with_call)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/dis_increment.py
 18           RESUME                   0

 20           LOAD_GLOBAL              1 (range + NULL)
              LOAD_SMALL_INT           3
              CALL                     1
              GET_ITER
      L1:     FOR_ITER                28 (to L2)
              STORE_FAST               1 (_)

 21           LOAD_FAST_BORROW         0 (counter)
              COPY                     1
              LOAD_ATTR                2 (value)
              LOAD_SMALL_INT           1
              BINARY_OP               13 (+=)
              SWAP                     2
              STORE_ATTR               1 (value)
              JUMP_BACKWARD           30 (to L1)

 20   L2:     END_FOR
              POP_ITER
              LOAD_CONST               1 (None)
              RETURN_VALUE
-----
 24           RESUME                   0

 26           LOAD_GLOBAL              1 (range + NULL)
              LOAD_SMALL_INT           3
              CALL                     1
              GET_ITER
      L1:     FOR_ITER                31 (to L2)
              STORE_FAST               1 (_)

 27           LOAD_FAST_BORROW         0 (counter)
              LOAD_ATTR                2 (value)
              STORE_FAST               2 (seen)

 28           LOAD_GLOBAL              5 (bump + NULL)
              LOAD_FAST_BORROW         2 (seen)
              CALL                     1
              LOAD_FAST_BORROW         0 (counter)
              STORE_ATTR               1 (value)
              JUMP_BACKWARD           33 (to L1)

 26   L2:     END_FOR
              POP_ITER
              LOAD_CONST               1 (None)
              RETURN_VALUE
```

自由线程构建上同一个脚本的输出和上面一字不差：

```text
$ python3 /tmp/sift-scratch/dis_increment.py > /tmp/dis.py3.txt
$ python3.14t /tmp/sift-scratch/dis_increment.py > /tmp/dis.py314t.txt
$ diff /tmp/dis.py3.txt /tmp/dis.py314t.txt && echo identical
identical
```

`plain` 里从 `LOAD_ATTR` 读到 `STORE_ATTR` 写，中间只有 `BINARY_OP`，整数加法在 C 里完成，不进 Python 函数，也不是检查点；下一个检查点是写完以后的 `JUMP_BACKWARD`。读和写之间没有可切的缝。`with_call` 在读和写之间多了一次 `CALL`，调用 `bump` 会进入它的 `RESUME`，那里就是检查点。这解释了本篇开头那条输出里 `python3` 一次都不丢，也预告了下面 `with_call` 要丢。

想验证“切换是由时间片驱动的”，可以去动 `sys.setswitchinterval`。下面这个脚本对两种写法各跑 8 个线程、每个 20 万次，改四种切换间隔：

```python
"""Count lost updates of two counter loops per switch interval."""

import sys
import threading
from collections.abc import Callable

THREADS = 8
PER_THREAD = 200_000


class Counter:
    """A number in an attribute."""

    def __init__(self) -> None:
        self.value = 0


def bump(value: int) -> int:
    """Add one; calling it gives the eval loop a place to switch."""
    return value + 1


def plain(counter: Counter) -> None:
    """Read, add, write back in one statement."""
    for _ in range(PER_THREAD):
        counter.value += 1


def with_call(counter: Counter) -> None:
    """Read, call, write back."""
    for _ in range(PER_THREAD):
        seen = counter.value
        counter.value = bump(seen)


def lost(target: Callable[[Counter], None], interval: float) -> int:
    """Return the updates THREADS threads of target lose."""
    sys.setswitchinterval(interval)
    counter = Counter()
    threads = [
        threading.Thread(target=target, args=(counter,))
        for _ in range(THREADS)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return THREADS * PER_THREAD - counter.value


def main() -> None:
    """Print the lost updates for each interval."""
    print(f"default interval: {sys.getswitchinterval()} s")
    print("  interval      plain  with_call")
    for interval in (1.0, 0.005, 0.0001, 0.000001):
        a = lost(plain, interval)
        b = lost(with_call, interval)
        print(f"  {interval:<9} {a:>9} {b:>10}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/switch_interval.py
default interval: 0.005 s
  interval      plain  with_call
  1.0               0          0
  0.005             0     327490
  0.0001            0    1090069
  1e-06             0    1259330
$ python3.14t /tmp/sift-scratch/switch_interval.py
default interval: 0.005 s
  interval      plain  with_call
  1.0         1102803    1115770
  0.005       1074752    1100741
  0.0001      1122987    1088398
  1e-06       1070915    1121381
```

`python3` 这一栏的 `plain` 在 1 微秒的间隔下也是 0，因为切换请求再频繁，持有者也只会在 `JUMP_BACKWARD` 上响应，那里不在读和写之间。`with_call` 则随间隔变小而一路恶化：1 秒时是 0（我没有单独量每个线程的用时，只知道这个脚本一次运行的 8 次测量平均不到 1 秒，所以每个线程的 20 万次循环用不了 1 秒，切换请求根本发不出来，8 个线程实际上是一个接一个跑的），默认的 5 毫秒是 33 万，到 1 微秒时 160 万次里丢了 126 万次。同一台机器上再跑一遍，5 毫秒那一行是 14 万，所以这一栏只能说量级，不能当精确值。`python3.14t` 一栏不管间隔取多少都是 107 万到 112 万上下，因为它没有 GIL 可交接：`take_gil` 开头有一段 `#ifdef Py_GIL_DISABLED`，`gil->enabled` 为 0 时直接返回（`ceval_gil.c` 第 312 到 316 行）。这时线程是真的在同时跑，间隔是个没人用的旋钮。

## 竞态：`+=` 不是原子的，只是有时看起来是

`lab/ch16/race_condition.py` 让 8 个线程对同一个 `Counter` 各加 20 万次，三种写法：裸的 `+=`、读和写之间夹一次函数调用、`+=` 外面套一把 `Lock`。前两个函数就是上一节 `dis` 脚本里的 `plain` 和 `with_call`，第三个是（`run` 负责起线程并报告丢了多少）：

```python
def locked(counter: Counter, lock: threading.Lock) -> None:
    """Same as plain, with the update under a Lock."""
    for _ in range(PER_THREAD):
        with lock:
            counter.value += 1
```

两个构建上各跑一遍，完整输出：

```text
$ python3 lab/ch16/race_condition.py
python 3.14.7, GIL enabled: True
switch interval: 0.005 s
lost-update counts vary from run to run; 0 is possible:
  counter.value += 1                 expected 1600000, got 1600000, lost 0
  read, bump() call, write back      expected 1600000, got 1463186, lost 136814
  counter.value += 1 under a Lock    expected 1600000, got 1600000, lost 0
$ python3.14t lab/ch16/race_condition_ft.py
python 3.14.7, GIL enabled: False
switch interval: 0.005 s
lost-update counts vary from run to run; 0 is possible:
  counter.value += 1                 expected 1600000, got 517080, lost 1082920
  read, bump() call, write back      expected 1600000, got 489246, lost 1110754
  counter.value += 1 under a Lock    expected 1600000, got 1600000, lost 0
```

这个数每次不一样，所以我两个构建交替跑了 3 次，前后夹 `cpu_state.py`（`117 118 121 143 113 ms` 和 `114 115 116 117 133 ms`，快状态），丢失的更新数：

| 写法 | python3 三次 | python3.14t 三次 |
| --- | --- | --- |
| `counter.value += 1` | 0、0、0 | 1082920、1055974、1082430 |
| 读、`bump()`、写 | 136814、155919、400762 | 1110754、1118302、1124188 |
| `+=` 加 `Lock` | 0、0、0 | 0、0、0 |

三件事。第一，自由线程构建上，裸 `+=` 丢了 66% 到 68%，计数器停在大约三分之一处。我猜的原因是 8 个线程真的在同一时刻读到同一个旧值，各自加一再写回，一轮重叠里只有最后写的那个生效，不过我没有去验证这个解释，只验证了数字。第二，带 GIL 的构建上，裸 `+=` 在 3 次里一次没丢，`with_call` 丢 9% 到 25%，而且 3 次里差了近 3 倍，这个量级取决于操作系统什么时候调度、什么时候发出切换请求。第三，`Lock` 在两个构建上都是 0，`threading.Lock` 在两边是同一个对象：`Modules/_threadmodule.c` 第 743 到 748 行，一个只装着 `PyMutex lock` 的结构；`acquire` 走 `_PyMutex_LockTimed`（第 826 行）。`PyMutex` 的快路径是一次比较并交换（`Python/lock.c` 第 55 到 60 行）：

```c
    uint8_t v = _Py_atomic_load_uint8_relaxed(&m->_bits);
    if ((v & _Py_LOCKED) == 0) {
        if (_Py_atomic_compare_exchange_uint8(&m->_bits, &v, v|_Py_LOCKED)) {
            return PY_LOCK_ACQUIRED;
        }
    }
```

整把锁只有一个字节。抢不到时，自由线程构建会先自旋最多 40 次（`MAX_SPIN_COUNT`，第 24 到 31 行，注释说带 GIL 的构建上自旋没用，所以那边是 0），再挂起；等了超过 1 毫秒的线程，解锁的一方会直接把锁交给它（`TIME_TO_BE_FAIR_NS`，第 19 到 22 行），防止饿死。

### 内建类型的操作呢

“带 GIL 时 `list.append` 是原子的”这种说法我听过很多遍，自由线程构建上它还成立吗？`d["n"] += 1` 在 GIL 下为什么看起来也没事？我写了一个小脚本，把一次方法调用和一次读改写放在一起量：

```python
"""Check which dict and list operations stay whole under 8 threads."""

import sys
import threading
from collections.abc import Callable

THREADS = 8
PER_THREAD = 100_000


def run(work: Callable[[], object]) -> None:
    """Run work on THREADS threads and wait for them."""
    threads = [threading.Thread(target=work) for _ in range(THREADS)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()


def main() -> None:
    """Compare one method call with a read-modify-write on a dict."""
    gil = getattr(sys, "_is_gil_enabled", lambda: True)()
    print(f"python {sys.version.split()[0]}, GIL enabled: {gil}")
    items: list[int] = []
    run(lambda: [items.append(i) for i in range(PER_THREAD)])
    print(f"  list.append: {len(items)} of {THREADS * PER_THREAD}")
    counts = {"n": 0}

    def bump() -> None:
        for _ in range(PER_THREAD):
            counts["n"] += 1  # BAD: read, add, write back

    run(bump)
    print(f"  d['n'] += 1: {counts['n']} of {THREADS * PER_THREAD}")
    lock = threading.Lock()
    safe = {"n": 0}

    def bump_locked() -> None:
        for _ in range(PER_THREAD):
            with lock:
                safe["n"] += 1

    run(bump_locked)
    print(f"  under a Lock: {safe['n']} of {THREADS * PER_THREAD}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/builtin_atomicity.py
python 3.14.7, GIL enabled: True
  list.append: 800000 of 800000
  d['n'] += 1: 800000 of 800000
  under a Lock: 800000 of 800000
$ python3.14t /tmp/sift-scratch/builtin_atomicity.py
python 3.14.7, GIL enabled: False
  list.append: 800000 of 800000
  d['n'] += 1: 126771 of 800000
  under a Lock: 800000 of 800000
```

`list.append` 在两个构建上都一个不少；`d["n"] += 1` 在带 GIL 的构建上也一个不少（同样是因为读和写之间没有检查点），在自由线程构建上 80 万次只剩 126771 次。我另外把 `d["n"] += 1` 单独编译再 `dis`，两个构建的输出逐行相同：读是 `BINARY_OP []`，加是 `BINARY_OP +=`，写是 `STORE_SUBSCR`。字节码一样，保证不一样。

自由线程构建怎么让 `list.append` 保持正确？每个对象头里有一个 `PyMutex ob_mutex`，注释写着 `// per-object lock`（`Include/object.h` 第 152 到 163 行，上一篇讲对象头时提到过），内建类型的方法用“临界区” (critical section) 把自己包起来。`list.append` 在 `Objects/listobject.c` 里只多了一行 `@critical_section`（第 1166 到 1168 行的 Argument Clinic 输入），Clinic 据此生成的包装函数是（`Objects/clinic/listobject.c.h` 第 116 到 125 行）：

```c
static PyObject *
list_append(PyObject *self, PyObject *object)
{
    PyObject *return_value = NULL;

    Py_BEGIN_CRITICAL_SECTION(self);
    return_value = list_append_impl((PyListObject *)self, object);
    Py_END_CRITICAL_SECTION();

    return return_value;
```

带 GIL 的构建上这两个宏什么也不做（`Include/internal/pycore_critical_section.h` 第 66 和 67 行：“The critical section APIs are no-ops with the GIL.”）。所以规则是：自由线程构建上，每个内建方法调用自己是安全的，一连串调用合起来仍然不是。`d["n"] += 1` 是三次各自安全的操作，中间谁都可能插进来。这也是为什么“靠 GIL 才没出事”的代码，换到 `python3.14t` 上会一次性暴露。

### 上一篇留下的 `LRUCache`

上一篇结尾我说 `LRUCache` 不是线程安全的，猜 GIL 替我挡掉了很多没写出来的问题。现在可以量了：8 个线程共用一个容量 8、键空间 16 的缓存，每个线程做 10 万次 `get_or_set`，数一数从 `get_or_set` 里漏出来多少个 `KeyError`、计数器对不对、缓存有没有超过容量：

```python
"""Share one LRUCache among 8 threads and count what goes wrong."""

import sys
import threading

from sift.cache import LRUCache
from sift.parallel import gil_enabled

THREADS = 8
LOOKUPS = 100_000
KEYS = 16


def hammer(cache: LRUCache[int, str], seed: int, errors: list[int]) -> None:
    """Look up LOOKUPS keys; count the KeyErrors that escape."""
    for i in range(LOOKUPS):
        try:
            cache.get_or_set((seed * 7 + i * 13) % KEYS, str)
        except KeyError:
            errors[seed] += 1


def main() -> None:
    """Run the threads on a cache smaller than the key range."""
    print(f"python {sys.version.split()[0]}, GIL enabled: {gil_enabled()}")
    cache = LRUCache[int, str](8)
    errors = [0] * THREADS
    threads = [
        threading.Thread(target=hammer, args=(cache, i, errors))
        for i in range(THREADS)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    total = THREADS * LOOKUPS
    counted = cache.hits + cache.misses
    print(f"  KeyError out of get_or_set: {sum(errors)} of {total} calls")
    print(f"  hits + misses: {counted}, lookups made: {total}")
    print(f"  entries: {len(cache)}, maxsize {cache.maxsize}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/shared_cache.py
python 3.14.7, GIL enabled: True
  KeyError out of get_or_set: 0 of 800000 calls
  hits + misses: 800000, lookups made: 800000
  entries: 8, maxsize 8
$ PYTHONPATH=src python3.14t /tmp/sift-scratch/shared_cache.py
python 3.14.7, GIL enabled: False
  KeyError out of get_or_set: 26448 of 800000 calls
  hits + misses: 775931, lookups made: 800000
  entries: 9, maxsize 8
```

带 GIL 的构建上，80 万次里零个错误，计数也精确；自由线程构建上有 26448 次（3.3%）`KeyError` 漏了出来，`hits + misses` 少了约 2.4 万，缓存一度有 9 个条目，超过了容量 8。我又各跑了一遍，第二次是 26032 次、774211、8 个条目，量级一致。`get_or_set` 的第一行是 `if key in self._data: return self[key]`，检查和使用之间可以被别的线程驱逐掉那个键（经典的先检查后动作），`self.hits += 1` 是读改写，和计数器同理。这两处问题在带 GIL 的构建上并不是不存在：`self[key]` 是一次 Python 方法调用，我从字节码推断进入 `__getitem__` 的 `RESUME` 是个检查点，也就是被切走的窗口是有的，只是 5 毫秒的时间片在 80 万次调用里一次也没碰到（这个推断我没有单独验证）。零不是证明，是运气好。这就是我说“GIL 替我挡掉了问题”的具体样子。修法最朴素：给缓存配一把锁，练习 1 让你做。`Searcher` 里另一个缓存是 `WeakValueDictionary`，我没有量它，这里只说 `LRUCache`。

## 同步原语：锁、条件、事件、信号量

要让多个线程可靠地协作，标准库给了一组原语，`lab/ch16/locks.py` 把它们逐个跑了一遍，每个函数几十行。先看条件变量那个：

```python
def condition_demo() -> None:
    """A Condition lets a thread sleep until a predicate holds."""
    print("-- Condition")
    box: list[int] = []
    cond = threading.Condition()
    log: list[str] = []

    def consumer() -> None:
        with cond:
            cond.wait_for(lambda: len(box) >= 3)
            log.append(f"consumer woke with {box}")

    thread = threading.Thread(target=consumer)
    thread.start()
    for value in (1, 2, 3):
        time.sleep(0.02)
        with cond:
            box.append(value)
            log.append(f"producer put {value}")
            cond.notify()
    thread.join()
    for line in log:
        print("  ", line)
```

整份输出（`RLock`、`Event`、`Semaphore`、`Barrier` 的代码也在 `locks.py` 里）：

```text
$ python3 lab/ch16/locks.py
-- Lock
  4 threads x 20000 increments under a Lock -> 80000
  locked() inside the with: True
  acquire(blocking=False)  : False
  acquire(timeout=0.05)    : False
  locked() after the with  : False
-- RLock
  inner got the lock the outer already holds
  the same shape with a Lock times out: True
-- Condition
   producer put 1
   producer put 2
   producer put 3
   consumer woke with [1, 2, 3]
-- Event
  waiters so far: [] is_set: False
  after set(): ['t0', 't1', 't2'] is_set: True
  wait(0.01) on an unset Event: False
-- Semaphore
  6 threads, Semaphore(2): at most inside at once -> 2
  BoundedSemaphore released too often: Semaphore released too many times
-- Barrier
  all arrivals come before every departure: True
```

逐个说一句它们各自解决什么：

- `Lock`：互斥。不可重入，持有者自己再 `acquire` 也会卡住（输出里持有时 `acquire(timeout=0.05)` 返回 `False`，同一个线程也一样）；`acquire(blocking=False)` 和 `acquire(timeout=...)` 是不想无限等的出口。
- `RLock`：记着持有者是谁和重入了几层，同一个线程可以再拿，适合递归调用的方法。输出里同样的“外层拿锁、内层再拿”，换成 `Lock` 就超时。
- `Condition`：一把锁加一个等待队列。`consumer` 被通知了 3 次，但只有第 3 次以后 `len(box) >= 3` 才成立，`wait_for` 才返回，因为它是个循环（`Lib/threading.py` 第 385 到 406 行）：先看谓词，不成立才 `wait`，醒来再看。写 `if` 加 `wait()` 是错的，别的消费者可能已经把东西取走了。
- `Event`：一个标志，`wait` 的线程在 `set()` 之前都睡着，`set()` 之后全部放行。
- `Semaphore(n)`：一个计数器，最多让 n 个线程同时进。峰值是 2，不是 6。`BoundedSemaphore` 多了一道检查：释放次数超过获取次数会抛 `ValueError`，用来抓住漏配对的 `release`。
- `Barrier(n)`：n 个线程都到了才一起放行，输出里所有“到达”都在任何“离开”之前。

### 队列：别自己拿锁拼

生产者和消费者之间最省心的结构不是上面这些原语，而是 `queue.Queue`。它是“一把锁加三个条件”拼出来的（`Lib/queue.py` 第 54 到 70 行：一个 `self.mutex = threading.Lock()`，`not_empty`、`not_full`、`all_tasks_done` 三个 `Condition` 共用它），你不用自己写这套逻辑。`lab/ch16/queue_workers.py` 里的工作线程是这样的，主线程往 `tasks` 里放 10 个数、再放 3 个哨兵，3 个线程取数算平方：

```python
STOP = None


def worker(tasks: queue.Queue[int | None], results: queue.Queue[int]) -> None:
    """Square numbers until the sentinel arrives."""
    while True:
        item = tasks.get()
        try:
            if item is STOP:
                return
            results.put(item * item)
        finally:
            tasks.task_done()
```

`task_done()` 放在 `finally` 里，`join()` 才不会因为某个任务抛异常而永远等不到。每个工作线程一个哨兵 `STOP`，是 3.13 之前结束一批工作线程的惯用法；3.13 起有 `Queue.shutdown()`，`queue_workers.py` 最后一段演示了它。完整输出：

```text
$ python3 lab/ch16/queue_workers.py
-- producer / consumer with sentinels
  squares (sorted, arrival order is not defined): [0, 1, 4, 9, 16, 25, 36, 49, 64, 81]
-- maxsize and the two ways to fail
  put(block=False) on a full queue -> queue.Full
  put(timeout=0.05) on a full queue -> queue.Full
  get(block=False) on an empty queue -> queue.Empty
-- LifoQueue and PriorityQueue
  LifoQueue  : ['c', 'b', 'a']
  Priority   : ['urgent', 'normal', 'low']
-- Queue.shutdown() replaces the sentinels
  processed then told to stop: [100, 101, 102, -1]
  put after shutdown -> queue.ShutDown
```

`maxsize` 给队列加了容量，满了以后 `put` 要么阻塞要么抛 `queue.Full`，这就是背压：生产者比消费者快的时候，慢下来的应该是生产者，而不是内存。`shutdown()` 之后 `put` 抛 `queue.ShutDown`，已经在队列里的东西仍然会被取完，取空以后 `get` 才抛，所以不用再算哨兵的个数。

### 死锁，以及用超时把它抓出来

两把锁，两个线程以相反的顺序拿，是最小的死锁。`lab/ch16/deadlock_timeout_fail.py` 用一个 `Barrier` 保证两个线程各自拿到第一把锁以后才去要第二把，再用 `acquire(timeout=1)` 代替无限期的 `with`：

```python
def grab(name: str, first: threading.Lock, second: threading.Lock) -> None:
    """Hold first, wait for the other thread to hold its first, then
    ask for second with a timeout instead of forever."""
    with first:
        both_hold_one.wait()
        if second.acquire(timeout=1):
            second.release()
            verdicts.append(f"{name}: got both locks")
        else:
            verdicts.append(f"{name}: gave up after 1 s, deadlock")
```

```text
$ python3 lab/ch16/deadlock_timeout_fail.py; echo "exit $?"
t1: gave up after 1 s, deadlock
t2: gave up after 1 s, deadlock
lock order t1: a, b; t2: b, a -> take locks in one order
exit 1
```

两个线程都等满 1 秒才放弃，退出码是 1（`*_fail.py` 要求非零）。超时只是诊断手段，真正的解法是所有线程按同一个全局顺序拿锁。如果这里不设超时，程序会安静地挂住，没有任何输出，这是死锁最讨厌的地方。

## CPU 密集和 I/O 密集：线程在哪里有用

原语讲完了，回到最初的问题：线程能不能让程序变快。`lab/ch16/gil_cpu_bound.py` 用纯 Python 的试除法数 200 万以内的素数，总工作量固定，分给 1 个线程或 4 个线程。线程 i 拿第 i、i+4、i+8……个小块，保证每个线程都分到大数和小数：

```python
def count_primes(lo: int, hi: int) -> int:
    """Count the primes in [lo, hi) by trial division; pure Python."""
    count = 0
    for n in range(max(lo, 2), hi):
        if n % 2 == 0:
            count += n == 2
            continue
        divisor = 3
        while divisor * divisor <= n:
            if n % divisor == 0:
                break
            divisor += 2
        else:
            count += 1
    return count
```

两个构建交替跑 3 次（前后夹 `cpu_state.py`：`125 121 118 119 120 ms` 和 `136 131 123 119 120 ms`），这里给第一次的完整输出，三次的汇总在后面：

```text
$ python3 lab/ch16/gil_cpu_bound.py
python 3.14.7, GIL enabled: True
primes below 2000000: 148933 (1 thread)
primes below 2000000: 148933 (4 threads)
timing lines (vary between runs):
  1 thread  :  4.732 s
  4 threads :  4.998 s
  speedup   :   0.95x
$ python3.14t lab/ch16/gil_cpu_bound_ft.py
python 3.14.7, GIL enabled: False
primes below 2000000: 148933 (1 thread)
primes below 2000000: 148933 (4 threads)
timing lines (vary between runs):
  1 thread  :  5.493 s
  4 threads :  1.818 s
  speedup   :   3.02x
```

| 构建 | 1 线程（三次，秒） | 4 线程（三次，秒） | 加速比（三次） |
| --- | --- | --- | --- |
| `python3` | 4.732、4.813、5.215 | 4.998、4.977、4.979 | 0.95、0.97、1.05 |
| `python3.14t` | 5.493、5.560、5.587 | 1.818、1.794、1.638 | 3.02、3.10、3.41 |

GIL 构建上，4 个线程和 1 个线程一样快（0.95 到 1.05 倍）：每次只有一个线程在跑字节码，多出来的 3 个只是在轮流。自由线程构建上 4 个线程是 3.02 到 3.41 倍，没到 4 倍。我猜有两个原因，一是单线程时 CPU 可以跑在更高的睿频上，4 个线程同时跑时频率会降一点；二是 4 条线虽然每条都分到了大小数，但各块的试除成本并不完全相等。我没有去分别验证。同一张表里还有一个数字：`python3.14t` 的 1 线程比 `python3` 慢 7% 到 16%（5.493 对 4.732，5.560 对 4.813，5.587 对 5.215），这是自由线程构建的“单线程税”，后面还会在更大的负载上量一次。

**线程的另一个用处：等待。** 一个线程在 `time.sleep` 或者读文件这类阻塞调用里时，会放掉 GIL，别的线程可以接着跑。`lab/ch16/io_bound_threads.py` 对比了 16 次 0.1 秒的 `sleep`（假装在等网络）和读完 123 个语料文件，线程数从 1 到 16：

```text
$ python3 lab/ch16/io_bound_threads.py
python 3.14.7, GIL enabled: True
123 files, 16 sleeps of 0.1 s
timing lines (vary between runs):
  workers  16 sleeps (ideal)    reads of all files
        1   1.603 s (1.600 s)       5.35 ms
        2   0.802 s (0.800 s)       5.02 ms
        4   0.402 s (0.400 s)       4.65 ms
        8   0.202 s (0.200 s)       6.16 ms
       16   0.103 s (0.100 s)       7.35 ms
bytes read, the same for every worker count: {4614185}
active threads at the end: 1
```

右边一列读文件就不一样了：全部 123 个文件加起来 4,614,185 字节，在页缓存里读完只要 5 毫秒上下，2 到 8 个线程和 1 个线程在噪声以内（4.65 到 6.16 ms），16 个线程才明显变慢（7.35 ms），我猜是线程启动成本，没有验证。线程帮得上忙的前提是“真的在等”，页缓存里的文件没有可等的。（`python3.14t` 上同一个脚本的 `sleep` 一列几乎一样，读文件一列是 5.30、3.39、2.42、2.99、4.31 ms，在 2 到 4 个线程时快了一点，因为没有 GIL 挡着，但绝对值小到不值得。）

## 进程：各有各的解释器

线程不行就换进程：每个进程有自己的解释器、自己的 GIL，用管道传数据。代价是数据要先序列化。`lab/ch16/multiprocessing_basics.py` 先看启动方式。三种方式都让子进程去报告“我是不是另一个进程”和“我看到的全局 `STATE` 是什么”，而 `STATE` 在 `main()` 里被改过一次：

```python
STATE = {"value": "set at import time"}


def look(_: int) -> tuple[bool, str]:
    """Report if this is another process and what STATE says there."""
    return os.getpid() != PARENT_PID, STATE["value"]


def main() -> None:
    """Show the start methods, Pool.map and what pickling costs."""
    print("-- start method")
    print("  multiprocessing.get_start_method():", mp.get_start_method())
    print("  get_all_start_methods():", mp.get_all_start_methods())
    # ...
    STATE["value"] = "changed in main() after the import"
    for method in ("fork", "spawn", "forkserver"):
        with mp.get_context(method).Pool(1) as pool:
            other, seen = pool.map(look, [0])[0]
            print(f"  {method:<10} other process: {other}, STATE: {seen!r}")
```

```text
$ python3 lab/ch16/multiprocessing_basics.py | sed -n 1,10p
-- start method
  multiprocessing.get_start_method(): forkserver
  get_all_start_methods(): ['forkserver', 'fork', 'spawn']
-- Pool.map with the default context
  squares: [0, 1, 4, 9, 16, 25, 36, 49, 64, 81]
  imap, chunksize 3: [0, 1, 4, 9, 16, 25]
-- what each start method gives a child
  fork       other process: True, STATE: 'changed in main() after the import'
  spawn      other process: False, STATE: 'set at import time'
  forkserver other process: True, STATE: 'set at import time'
```

三件事。第一，3.14 在 Linux 上的默认启动方式是 `forkserver`（`get_start_method()` 打出来的就是它）。`Lib/multiprocessing/context.py` 第 328 到 334 行：

```python
    # bpo-33725: running arbitrary code after fork() is no longer reliable
    # on macOS since macOS 10.14 (Mojave). Use spawn by default instead.
    # gh-84559: We changed everyones default to a thread safeish one in 3.14.
    if reduction.HAVE_SEND_HANDLE and sys.platform != 'darwin':
        _default_context = DefaultContext(_concrete_contexts['forkserver'])
    else:
        _default_context = DefaultContext(_concrete_contexts['spawn'])
```

注释里的“thread safeish”是整件事的动机：`fork` 只复制调用它的那个线程，别的线程当时持有的锁会原样留在子进程里，永远没人释放。一个多线程的程序（比如这一篇的任何线程池）再 `fork`，就可能在子进程里死锁。我没有去复现这种死锁，只是引用 CPython 自己的注释。第二，三种方式的差别就是输出里 `STATE` 那一列：`fork` 复制父进程此刻的内存，看到的是 `main()` 里改过的值；`spawn` 起一个全新的解释器，重新导入主模块，看到的是导入时的值；`forkserver` 在第一次需要时起一个干净的服务进程（预加载 `__main__`，`Lib/multiprocessing/forkserver.py` 第 44 行 `self._preload_modules = ['__main__']`），之后每个子进程都是从这个服务进程 `os.fork()` 出来的（第 342 行），所以看到的是服务进程起来时的状态，也是导入时的值。第三，这就是为什么进程池要求你的函数在模块顶层：子进程要按名字去 `__main__`（或者别的模块）里找它。

**序列化的价格。** 参数和返回值都要经过 pickle 再走管道。脚本后半段对一个 200 万个整数的列表量了这笔账：

```text
$ python3 lab/ch16/multiprocessing_basics.py | sed -n 11,17p
-- pickling cost: the argument is copied through a pipe
  list of 2000000 ints pickles to 9874036 bytes
timing lines (vary between runs):
  pickle.dumps    29.94 ms
  pickle.loads    97.22 ms
  apply(length, data)   110.05 ms
  apply(square, 1)       34.23 ms
```

序列化 30 毫秒，反序列化 97 毫秒，整数列表在管道里是将近 10 MB，一次 `apply(length, data)` 往返 110 毫秒，而 `length` 本身只有一行 `len(data)`。再跑 3 次，往返是 97 到 102 毫秒，`dumps` 约 28 毫秒，`loads` 86 到 98 毫秒，数量级稳定。往返约等于一次 `dumps` 加一次 `loads`，也就是说这 110 毫秒几乎全是搬运，不是计算。紧随其后那个平凡的 `apply(square, 1)` 还要 29 到 34 毫秒，我猜是工作进程还在释放刚收到的 200 万元素的列表，不过没有验证。进程的并行收益要大于这笔搬运费才算数，这是后面 `Part` 的设计要绕着走的地方。

**lambda 为什么不行。** pickle 按名字记函数（模块加限定名），一个 lambda 没有可以按名字找回的位置。`lab/ch16/lambda_pickle_fail.py` 就两行有效代码：

```python
def main() -> None:
    """Ask a worker process to run a lambda; result() re-raises."""
    print("submitting a lambda to a ProcessPoolExecutor")
    with ProcessPoolExecutor(1) as pool:
        future = pool.submit(lambda x: x * 2, 21)
        # error: _pickle.PicklingError: Can't pickle <function <lambda>>
        print(future.result())
```

仓库里的 `# error:` 注释写的就是真实信息：`Can't pickle local object <function main.<locals>.<lambda> at 0x...>`（这个 lambda 还是个局部对象）。完整的回溯很长，我用 `grep` 只留下关键的几行，同一个异常出现了两遍：第一遍是挂在 `__cause__` 上的 `_RemoteTraceback`，名字叫“远程”，但这个 lambda 其实从没离开过父进程，是父进程的喂入线程在 `_on_queue_feeder_error` 里把异常格式化成文字挂上去的；第二遍是在主线程里重新抛出：

```text
$ python3 lab/ch16/lambda_pickle_fail.py 2>&1 | \
    grep -E '^(submitting|_pickle|when serializing)'; \
    echo "exit ${PIPESTATUS[0]}"
submitting a lambda to a ProcessPoolExecutor
_pickle.PicklingError: Can't pickle local object <function main.<locals>.<lambda> at 0x7ffff6be52d0>
when serializing dict item 'fn'
when serializing concurrent.futures.process._CallItem state
when serializing concurrent.futures.process._CallItem object
_pickle.PicklingError: Can't pickle local object <function main.<locals>.<lambda> at 0x7ffff6be52d0>
when serializing dict item 'fn'
when serializing concurrent.futures.process._CallItem state
when serializing concurrent.futures.process._CallItem object
exit 1
```

完整回溯里有意思的是它指向 `queues.py` 第 262 行的 `_feed`，不是 `submit`：`submit` 只是把任务放进一个本地缓冲，真正做 pickle 的是后台的“喂入线程”（`Lib/multiprocessing/queues.py` 第 261 到 262 行，`obj = _ForkingPickler.dumps(obj)`，注释说“serialize the data before acquiring the lock”），出错以后由 `Lib/concurrent/futures/process.py` 的 `_SafeQueue._on_queue_feeder_error`（第 179 到 189 行）把异常挂到对应的 `Future` 上，所以你要到 `future.result()` 才看到。`submit` 本身不报错，这是新手最容易困惑的一点。

**共享内存：不拷贝。** 要在进程之间共享大块数据，`multiprocessing.shared_memory` 让两个进程映射同一块物理内存。`lab/ch16/shared_memory.py` 创建一块 800 万字节的块，让两个子进程各填一半（写下标的平方），父进程再读回来：

```python
def fill(name: str, start: int, stop: int) -> None:
    """Attach to the block by name and write squares into a slice."""
    shm = shared_memory.SharedMemory(name=name, track=False)
    try:
        numbers = shm.buf.cast("Q")
        for i in range(start, stop):
            numbers[i] = i * i
        numbers.release()
    finally:
        shm.close()
```

```text
$ python3 lab/ch16/shared_memory.py
created a block of 8000000 bytes (name not printed)
size >= requested: True
exit codes: [0, 0]
view[3], view[999], view[999999]: 9 998001 999998000001
sum of the first ten: 285
timing line (varies): 88.8 ms
-- ShareableList: a small fixed-size shared list
  written through the other handle: [100, 2.5, 'three']
block unlinked
```

块的名字是 `shm_open` 的名字，所以别的进程只要知道名字就能附加：在 POSIX 上它就是 `_posixshmem.shm_open`，然后 `os.ftruncate` 定大小，再 `mmap.mmap` 映射（`Lib/multiprocessing/shared_memory.py` 第 95 到 117 行）。子进程里我传了 `track=False`：`track` 参数是 3.13 加的，为 `True` 时 `__init__` 会向 `resource_tracker` 登记（第 121 和 122 行），由追踪进程负责在没人清理时删除这块内存；这里是由创建者统一 `unlink`，附加者没必要再登记一次。`ShareableList` 是个小得多的东西，固定长度，元素只能是几种基本类型，输出最后两段演示了通过另一个句柄改动能被原句柄看到。共享内存要靠你自己保证不会同时写同一处，没有任何锁在背后替你看着。

## `concurrent.futures`：把线程和进程换成同一个接口

手写 `Thread` 加 `Queue` 加哨兵是为了看清楚发生了什么，写业务代码我会用 `concurrent.futures`。`submit` 返回一个 `Future`，`map` 按输入顺序给结果，`as_completed` 按完成顺序给，`ThreadPoolExecutor`、`ProcessPoolExecutor` 和这一篇后面的 `InterpreterPoolExecutor` 共用这套接口，换池只改一个类名，这也是 `sift index --mode` 能用一行 `match` 切换的原因。`lab/ch16/futures_tour.py` 把常用的东西跑了一遍，这里选三段：完成顺序、取消、异常。

```python
    print("-- as_completed yields in the order of finishing")
    with ThreadPoolExecutor(3) as pool:
        futures = {
            pool.submit(nap, name, secs): name
            for name, secs in (("slow", 0.6), ("fast", 0.1), ("mid", 0.35))
        }
        print("  ", [futures[f] for f in as_completed(futures)])
    ...
def cancelling() -> None:
    """Only queued futures can be cancelled."""
    print("-- cancel()")
    with ThreadPoolExecutor(1) as pool:
        running = pool.submit(nap, "running", 0.3)
        queued = [pool.submit(nap, f"q{i}", 0.01) for i in range(3)]
        time.sleep(0.05)
        print("  running.cancel():", running.cancel(), running.running())
        print("  queued.cancel() :", [f.cancel() for f in queued])
        print("  cancelled()     :", [f.cancelled() for f in queued])
    ...
        slow = pool.submit(nap, "slow", 0.3)
        try:
            slow.result(timeout=0.05)
        except TimeoutError:
            print("  result(timeout=0.05): TimeoutError (the job goes on)")
```

完整输出：

```text
$ python3 lab/ch16/futures_tour.py
-- ThreadPoolExecutor: submit, map
  submit(square, 12).result(): 144
  map keeps the input order  : [0, 1, 4, 9, 16, 25]
-- as_completed yields in the order of finishing
   ['fast', 'mid', 'slow']
-- wait(return_when=FIRST_COMPLETED)
  done: ['b'] pending: 1
  after wait(all): done 2 pending 0
-- cancel()
  running.cancel(): False True
  queued.cancel() : [True, True, True]
  cancelled()     : [True, True, True]
-- shutdown(cancel_futures=True)
  first: first | rest cancelled: [True, True, True]
-- exceptions
  fail(0): ok
  fail(1): ValueError('1 is odd')
  fail(2): ok
  fail(3): ValueError('3 is odd')
  result() re-raises: 1 is odd
  map raises at the failing item: 3 is odd
  result(timeout=0.05): TimeoutError (the job goes on)
  done callback ran: ['slow']
-- ProcessPoolExecutor
  map(square): [0, 1, 4, 9, 16, 25]
  remote error: ValueError('3 is odd')
  its cause is a text traceback: _RemoteTraceback
  worker died -> BrokenProcessPool
  the pool is broken for every later submit
```

读输出有四个要点。一，只有还在排队的 `Future` 能取消：正在跑的 `running.cancel()` 返回 `False`（`running()` 是 `True`），排队的三个都取消成功；`shutdown(cancel_futures=True)` 是一次性取消所有排队的。二，`result(timeout=...)` 超时抛 `TimeoutError`，但不会中止任务，它还在后台跑，后面的回调照样触发。三，`map` 是在迭代到出错的那一项时才抛异常（`[2, 3, 4]` 里的 3），前面的结果已经取走了。四，进程池里的异常要先 pickle 回来，原始的回溯对象是带不过来的，所以 `_ExceptionWithTraceback` 先把回溯格式化成一段文字，在父进程重建异常时挂成 `__cause__`（`Lib/concurrent/futures/process.py` 第 135 到 148 行，`_rebuild_exc` 里 `exc.__cause__ = _RemoteTraceback(tb)`）。输出里 `its cause is a text traceback: _RemoteTraceback` 就是这个。如果工作进程不是抛异常而是直接死了（`die` 里的 `os._exit(1)`），池会变成 `BrokenProcessPool`，之后任何 `submit` 都直接失败。

另外有两个默认值，写并行代码时值得先知道。`ThreadPoolExecutor` 不指定 `max_workers` 时用 `min(32, process_cpu_count + 4)`（`Lib/concurrent/futures/thread.py` 第 181 行；第 174 到 178 行的注释说这个值同时照顾“释放 GIL 的 CPU 密集任务”和 I/O 密集任务，上限 32 是为了不在多核机器上吃掉意外多的资源），`ProcessPoolExecutor` 用 `os.process_cpu_count()`（`process.py` 第 759 行）。`map` 在进程池里还有个 `chunksize`，把输入切成块再发，减少往返次数（第 919 到 953 行），这一点 Sift 的 `Part` 也用了，不过是自己切。

## 子解释器：进程的隔离，线程的价格

一个进程里可以同时有好几个解释器。3.12 的 PEP 684 让每个解释器可以有自己的 GIL，3.14 的 PEP 734 把它们放进标准库（`concurrent.interpreters`），同时新增 `concurrent.futures.InterpreterPoolExecutor`。PEP 734 的 `Status:` 行是 `Final`，`Python-Version: 3.14`。先确认这个类在 3.14.7 里真的存在：

```text
$ python3 -c \
    "from concurrent.futures import InterpreterPoolExecutor"; echo "exit $?"
exit 0
```

“自己的 GIL”在 CPython 里是真东西，`Python/ceval_gil.c` 第 498 到 517 行：

```c
void
_PyEval_InitGIL(PyThreadState *tstate, int own_gil)
{
    assert(tstate->interp->ceval.gil == NULL);
    if (!own_gil) {
        /* The interpreter will share the main interpreter's instead. */
        PyInterpreterState *main_interp = _PyInterpreterState_Main();
        assert(tstate->interp != main_interp);
        struct _gil_runtime_state *gil = main_interp->ceval.gil;
        init_shared_gil(tstate->interp, gil);
        assert(!current_thread_holds_gil(gil, tstate));
    }
    else {
        PyThread_init_thread();
        init_own_gil(tstate->interp, &tstate->interp->_gil);
    }
```

要么共用主解释器的那把，要么 `init_own_gil` 为这个解释器造一把新的，所以两个子解释器里的线程可以真的同时跑 Python 代码。`lab/ch16/subinterpreters.py` 走了一遍 API：

```python
    interp = interpreters.create()
    interp.exec("greeting = 'hello from a subinterpreter'")
    interp.exec("print(greeting)")
    try:
        interp.exec("print(missing)")
    except interpreters.ExecutionFailed as error:
        print("  exec failed:", str(error).splitlines()[0])
    print("  here the name is unknown:", "greeting" not in globals())
    # ...
    interp.prepare_main(count=3, label="spam", flag=True, blob=b"xyz")
    interp.exec("print('  main namespace there:', count, label, flag, blob)")
    try:
        interp.prepare_main(items=[1, 2])
    except interpreters.NotShareableError as error:
        print("  a list is not shareable:", error)
    # ...
    with InterpreterPoolExecutor(2) as pool:
        print("  map(double):", list(pool.map(double, range(5))))
        print("  a lambda without closure:", pool.submit(lambda: 1).result())
        print(
            "  a list argument (pickled):", pool.submit(len, [1, 2]).result()
        )
        offset = 3
        try:
            pool.submit(lambda: offset).result()
        except interpreters.NotShareableError:
            print("  a lambda with a closure: NotShareableError")
```

```text
$ python3 lab/ch16/subinterpreters.py
-- an interpreter is a separate world
  main: 0 list_all ids: [0]
hello from a subinterpreter
  exec failed: NameError: name 'missing' is not defined
  here the name is unknown: True
-- call(): run a function there, get its result back
  interp.call(double, 21): 42
-- prepare_main(): pass shareable data in
  main namespace there: 3 spam True b'xyz'
  a list is not shareable: [1, 2] does not support cross-interpreter data
-- a Queue carries values between interpreters
  got: ['one', 2, None]
  closed; list_all ids: [0]
-- call_in_thread(): the interpreter runs on its own thread
  thread was a Thread
-- InterpreterPoolExecutor: the futures API over interpreters
  map(double): [0, 2, 4, 6, 8]
  a lambda without closure: 1
  a list argument (pickled): 2
  a lambda with a closure: NotShareableError
threads alive at the end: 1
```

一个子解释器是一个隔离的世界：在里面 `exec` 出来的名字，这边看不见；里面抛的异常变成一个只有摘要的 `ExecutionFailed`，原对象带不过来。数据要显式传过去，而传法有两层，这里有一处和 PEP 的字面说法不一致，我是跑出来才看到的。PEP 734 的“Shareable Objects”一节写的是“All objects that can be pickled are shareable”。可是 3.14.7 里 `prepare_main` 的文档字符串只说“The values must be shareable”（`Lib/concurrent/interpreters/__init__.py` 第 189 到 195 行），传一个 `[1, 2]` 就是 `NotShareableError`；而 `call` 的文档字符串写着“Nearly all callables, args, kwargs, and return values are supported”，还有“This method will fall back to pickle”（第 225 到 231 行），所以同样的 `[1, 2]` 作为 `pool.submit(len, [1, 2])` 的参数就行。`prepare_main` 我实测放得进去的有整数、字符串、布尔和 `bytes`，列表不行；PEP 还提到 `interpreters.Queue` 和 `memoryview` 天生可共享，这两个我没有逐个验证。回退到 pickle 的路径在 `Python/crossinterp.c` 第 569 到 690 行，pickle 的结果用一个不拷贝的 `memoryview` 包着传（第 730 行的注释：“We avoid copying the pickled data by wrapping it in a memoryview.”）。

`call` 在 C 里（`Modules/_interpretersmodule.c` 的 `interp_call`，第 1294 到 1346 行）先在调用方的线程里打包参数（`_interp_call_pack`，第 1323 行），再交给 `_run_in_interpreter`：它把当前线程“切”进目标解释器（`_PyXI_Enter`，第 669 行），在那里调函数（`_make_call`，第 690 行），把结果存起来（`_PyXI_Preserve`，第 692 行）。`Python/crossinterp.c` 的 `_PyXI_Exit` 先把结果取出来（`_pop_preserved`，第 2771 行），再退出会话切回来（`_exit_session`，第 2793 行），最后在调用方这边把对象还原出来（`_finish_preserved`，第 2798 行）。也就是说参数的序列化和结果的反序列化都发生在调用方的线程里，这一点我是读代码读出来的，没有单独用计时验证。记住它，基准那一节我要用它解释子解释器为什么比进程池慢。`InterpreterPoolExecutor` 本身很薄（`Lib/concurrent/futures/interpreter.py` 第 100 到 123 行就是 `ThreadPoolExecutor` 的子类，每个工作线程一个解释器），工作线程是普通线程，只是在里面调用 `interp.call`（第 82 到 91 行）。

最后一行输出：带闭包的 lambda `lambda: offset` 在 `InterpreterPoolExecutor` 里是 `NotShareableError`，因为它引用了外层变量，没法在另一个解释器里按名字重建；不带闭包的 `lambda: 1` 就可以，这是 `call` 文档里“stateless functions”的意思，非闭包而且不用任何全局变量的函数。

启动也不是白送的：3.14 的 whatsnew 自己列出的限制里就有“starting each interpreter has not been optimized yet”（`Doc/whatsnew/3.14.rst` 第 258 行）。线程池没有这笔账，子解释器池要为每个工作线程建一个解释器，进程池要起进程。我没有单独量这笔固定开销；基准表里 `bench_index` 的计时包含了池的启动，所以它已经算在里面。

## 自由线程构建：去掉 GIL 以后

前面几节的 `python3.14t` 一直在拿来对比，现在正面看它。`lab/ch16/free_threading_check_ft.py` 先确认“我跑的到底是不是自由线程构建”，再试几件会让 GIL 回来的事：

```python
def gil_state(*args: str) -> str:
    """Return sys._is_gil_enabled() of a child started with args."""
    code = "import sys; print(sys._is_gil_enabled())"
    done = subprocess.run(
        [sys.executable, *args, "-c", code],
        capture_output=True,
        text=True,
        check=True,
    )
    return done.stdout.strip()


def main() -> None:
    """Print the facts that tell a free-threaded build apart."""
    print("version         :", sys.version.split()[0])
    print("abiflags        :", repr(sys.abiflags))
    print("Py_GIL_DISABLED :", sysconfig.get_config_var("Py_GIL_DISABLED"))
    print("_is_gil_enabled :", sys._is_gil_enabled())
    print("-- importing extension modules does not turn the GIL back on")
    for name in ("sqlite3", "decimal", "zlib", "ssl", "unicodedata", "mmap"):
        __import__(name)
        print(f"  after import {name:<12}:", sys._is_gil_enabled())
    # ...
```

```text
$ python3.14t lab/ch16/free_threading_check_ft.py
version         : 3.14.7
abiflags        : 't'
Py_GIL_DISABLED : 1
_is_gil_enabled : False
-- importing extension modules does not turn the GIL back on
  after import sqlite3     : False
  after import decimal     : False
  after import zlib        : False
  after import ssl         : False
  after import unicodedata : False
  after import mmap        : False
-- PYTHON_GIL and -X gil switch it for one run
  default      : False
  -X gil=1     : True
  -X gil=0     : False
switch interval: 0.005 s (unused without a GIL)
```

`sys.abiflags` 是 `'t'`，`Py_GIL_DISABLED` 是 1，`sys._is_gil_enabled()` 是 `False`，带下划线说明它是个私有接口，但目前就是判断这件事的办法。第二段验证的是 PEP 703 的“`Py_mod_gil` Slot”一节：自由线程构建加载扩展模块时，如果模块没有声明自己能在没有 GIL 的环境里跑，解释器会暂停所有线程、把 GIL 重新打开，并发出警告。导入这 6 个标准库 C 扩展以后 GIL 仍然是关着的，说明它们都声明过。第三段：`-X gil=1` 能为这一次运行把 GIL 打开，`-X gil=0` 关掉。有一处文字和实现不一致：PEP 703 把这个环境变量写成 `PYTHONGIL`，我实测 3.14.7 认的是 `PYTHON_GIL`：

```text
$ PYTHON_GIL=1 python3.14t -c "import sys; print(sys._is_gil_enabled())"
True
$ PYTHONGIL=1 python3.14t -c "import sys; print(sys._is_gil_enabled())"
False
```

在带 GIL 的 `python3` 上，这个脚本在 `-X gil=0` 那一步失败，退出码是 1。这是预期的，所以文件名带 `_ft` 后缀，`scripts/chapter.py` 只让 `python3.14t` 去跑它：

```text
$ python3 -X gil=0 -c pass; echo "exit $?"
Fatal Python error: config_read_gil: Disabling the GIL is not supported by this build
Python runtime state: preinitialized

exit 1
```

### 没有 GIL，靠什么保证对象不被写坏

上一篇的 `Py_DECREF` 只是减一，那是带 GIL 的构建。自由线程构建把 GIL 的活拆给了四样东西，PEP 703 各有一节：

- 引用计数改成偏向引用计数（“Reference Counting”一节）：每个对象有一个“所属线程”，所属线程用非原子指令改“本地”计数，别的线程用原子指令改“共享”计数。这就是我在上一篇预告过的对象头，`Include/object.h` 第 152 到 163 行里的 `ob_tid`（线程 id）、`ob_ref_local`、`ob_ref_shared`，以及前面见过的 `ob_mutex`。不朽对象仍然免计数。
- 容器的线程安全靠上面那个每对象的互斥锁加“临界区”，`list.append` 的包装就是例子。
- 内存分配器从 pymalloc 换成 mimalloc，因为 PEP 说 pymalloc“is not thread-safe without the GIL”（“Memory Management”一节）。
- 循环垃圾回收改成非分代的、靠“stop-the-world”暂停所有线程来保证一致性（“Garbage Collection”一节）；`Python/gc_free_threading.c` 的 `gc_collect_internal` 第一句就是 `_PyEval_StopTheWorld(interp)`（第 2189 行）。

`PyMutex`、临界区这些我前面都贴过了，不重复。这套东西有价钱。

### 它值多少：这台机器上的账单

PEP 779 为“把自由线程构建升格为受支持（阶段 II）”定了标准：单线程性能损失以 `pyperformance` 衡量，硬指标是 15%（“we propose 15% as a hard performance target”），内存的目标是 20%；3.14 的 whatsnew 说单线程代码的损失“is now roughly 5-10%”（`Doc/whatsnew/3.14.rst` 第 489 和 490 行），同时宣布自由线程构建“officially supported but still optional”（第 3217 到 3219 行）。这些是 `pyperformance` 的几何平均，不是我这个负载。我拿 Sift 的串行索引（语料复制 2 遍，246 篇文档，不用池）在两个构建上各量了 3 次，交替跑，顺便记录峰值内存：

```python
"""Time one serial index build of the corpus, copied twice."""

import resource
import sys
from pathlib import Path
from time import perf_counter

from sift.parallel import gil_enabled, index_items, read_items, replicate

PIPELINE = ("mixed", "nfkc", "stopwords")


def main() -> None:
    """Print the seconds and peak memory of a serial build."""
    items = replicate(read_items(Path("corpus/posts")), 2)
    start = perf_counter()
    index = index_items(items, PIPELINE)
    took = perf_counter() - start
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    version = sys.version.split()[0]
    print(
        f"{version} GIL enabled: {gil_enabled()!s:<5} "
        f"{index.n_docs} docs {took:6.3f} s  peak {peak:5.0f} MiB"
    )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; for i in 1 2 3; do \
>     python3 /tmp/sift-scratch/serial_build.py; \
>     PYTHONPATH=src python3.14t /tmp/sift-scratch/serial_build.py; done; \
>     python3 /tmp/sift-scratch/cpu_state.py
112 121 123 120 116 ms
3.14.7 GIL enabled: True  246 docs  3.572 s  peak   183 MiB
3.14.7 GIL enabled: False 246 docs  4.182 s  peak   218 MiB
3.14.7 GIL enabled: True  246 docs  3.642 s  peak   184 MiB
3.14.7 GIL enabled: False 246 docs  4.383 s  peak   218 MiB
3.14.7 GIL enabled: True  246 docs  3.736 s  peak   183 MiB
3.14.7 GIL enabled: False 246 docs  4.155 s  peak   218 MiB
112 136 121 114 117 ms
```

`python3.14t` 慢 11% 到 20%（4.182 对 3.572 是 1.17 倍，4.383 对 3.642 是 1.20 倍，4.155 对 3.736 是 1.11 倍），平均约 1.16 倍；峰值内存 218 MiB 对 183 到 184 MiB，多 19%。内存和 PEP 779 说的“15-20% higher”一致，速度比 whatsnew 的 5 到 10% 要差，略超 PEP 779 的 15% 目标，不过这是一个负载，不是 `pyperformance`，不能拿来推翻它们，只能说在内存分配密集、满是小对象的索引构建上，这是我实际付的价钱。前面素数计数的 7% 到 16% 也在这个范围里。

还有一笔账不在性能里，而在生态里：这台机器上的 `python3.14t` 没有 SQLAlchemy。第 13 篇把存储换成了 SQLAlchemy，所以 `import sift.storage.store` 在 `python3.14t` 上会直接失败，这是 `sift/cli.py` 改成按需导入存储模块的原因（`from sift.storage.store import ...` 现在都在用到它的函数里）：

```text
$ python3.14t -c "import sqlalchemy" 2>&1 | tail -1
ModuleNotFoundError: No module named 'sqlalchemy'
$ PYTHONPATH=src python3.14t -m sift --version
sift 0.0.0+source
$ PYTHONPATH=src python3.14t -m sift index --jobs 2 2>&1 | tail -1
ModuleNotFoundError: No module named 'sqlalchemy'
```

`sift --version` 和 `sift bench index` 能在 `python3.14t` 上跑，`sift index` 不能，`0.0.0+source` 是 `__init__.py` 在没有安装元数据时的后备版本号（`PYTHONPATH=src` 没有装包）。也就是说在自由线程构建里测 Sift 的线程模式，我只能走 `bench`；我没有去查是这个包的 3.14t 轮子缺失还是我这个 Nix 环境没带，只知道在这台机器上没有。

## 回到 Sift：并行索引

建索引的主要时间花在“读文件、解析前置元数据、分词、建倒排表”上，每篇文档之间互不相干，天然可以并行，只有最后把各份结果合起来这一步是串行的。我给 `src/sift/parallel.py` 先定了一条契约（模块文档字符串的开头）：

```text
``index_items(items, pipeline_names, jobs=..., mode=...)`` returns the
InvertedIndex of the items. For the same items and pipeline it returns
an index equal to the serial one (jobs=1), with the same doc_ids,
the same postings and the same term order, whatever jobs and mode are.
The segment file written from it is byte for byte the same.
```

不管 `jobs` 和 `mode` 取什么，结果必须和串行一样，连词的出现顺序都一样，写出来的段文件逐字节相同。这条我在命令行上验证了：四种配置各建一次全量索引，比较 `segment.sft` 的校验和。

```text
$ for spec in "1 process" "4 process" "4 thread" "4 interp"; do \
>     set -- $spec; d=$(mktemp -d); \
>     SIFT_INDEX=$d sift index --full --jobs $1 --mode $2 | tail -1; \
>     sha256sum $d/segment.sft | cut -c1-16; rm -rf $d; done
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 3443.0 ms
ec3c74c4cdcaf49d
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 2547.9 ms
ec3c74c4cdcaf49d
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 4003.8 ms
ec3c74c4cdcaf49d
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 2491.2 ms
ec3c74c4cdcaf49d
```

四次的校验和前 16 位都是 `ec3c74c4cdcaf49d`，段文件都是 2,880,196 字节。耗时是单次的，只当参考：串行 3.44 秒，`process` 4 个工作者 2.55 秒，`thread` 4.00 秒（比串行慢），`interp` 2.49 秒。这些是整条 `sift index`，里面还有写段文件、写数据库，所以和后面只计时 `index_items` 的基准表不是同一把尺。

### 切块、并行、按序合并

工作的单位是一块连续的文档，而不是一篇：每个工人拿到一块，解析并分析完，返回一个小的 `InvertedIndex`（`Part`），调用方按块的顺序把它们合起来，哪个工人先完成对结果没有影响。数据结构只有两个：

```python
@dataclass(frozen=True, slots=True)
class Item:
    """One document to index: its id, its file and maybe its text.

    With text None the worker reads path as UTF-8; otherwise it
    parses text and uses path only to name the file in errors.
    """

    doc_id: int
    path: str
    text: str | None = None


@dataclass(frozen=True, slots=True)
class Part:
    """What a worker sends back for one chunk."""

    index: InvertedIndex
    errors: tuple[SiftError, ...]


```

`Item` 里的 `text` 为 `None` 时由工人自己读文件（`sift index` 走这条路，文件读取也并行了），否则直接解析传来的文本（基准走这条路，不把磁盘算进去）。两个类都是冻结加槽位的数据类，pickle 按值传。一个工人要做的事是 `_index_chunk`：

```python
def _index_chunk(items: tuple[Item, ...], names: tuple[str, ...]) -> Part:
    """Return the Part of items, with the collector already paused."""
    index = InvertedIndex()
    errors: list[SiftError] = []
    with IndexWriter(index, build_pipeline(names)) as writer:
        for item in items:
            path = Path(item.path)
            try:
                text = item.text
                if text is None:
                    text = path.read_text(encoding="utf-8")
                doc = Document.from_markdown(item.doc_id, path, text)
            except FrontMatterError as error:
                errors.append(error)
            except (OSError, UnicodeDecodeError) as error:
                errors.append(SiftError(f"cannot read {path}: {error}"))
            else:
                writer.add(doc)
    return Part(index, tuple(errors))

```

一篇文档解析失败不会停掉整块：错误收集在 `Part.errors` 里，最后由 `index_items` 汇总成一个 `ExceptionGroup`（第 9 篇的做法，按文档顺序）。调度这些块的是 `run_ordered`，它按输入顺序产出结果，这是整个契约里“确定性”的来源（`jobs=1` 或者块数不到 2 个时，在调用线程里直接 `map`，不建池）：

```python
def _run_ordered[T, R](
    func: Callable[[T], R], items: Sequence[T], workers: int, mode: Mode
) -> Iterator[R]:
    """Yield the results of run_ordered, on workers workers."""
    if workers <= 1:
        yield from map(func, items)
        return
    pool = make_executor(mode, workers)
    try:
        yield from pool.map(func, items)
    except BrokenExecutor as error:
        raise SiftError(f"a worker died: {error}") from error
    finally:
        pool.shutdown(cancel_futures=True)

```

`pool.map` 本身就是按输入顺序产出，`finally` 里的 `shutdown(cancel_futures=True)` 保证出异常时尚未开始的块被取消、池被关掉以后异常才离开。工人死掉（`BrokenExecutor`）统一转成 `SiftError`。三种池只在 `make_executor` 里用一个 `match` 分叉，选 `ProcessPoolExecutor`、`ThreadPoolExecutor` 或 `InterpreterPoolExecutor`（第 128 到 137 行）。

把它们串起来的是 `index_items`：切成最多 `jobs * 4` 块（`CHUNKS_PER_JOB = 4`，块多一点，工人之间的负载就均匀一点），逐块合并。

```python
def index_items(
    items: Iterable[Item],
    pipeline_names: Sequence[str],
    *,
    jobs: int = 1,
    mode: Mode = "process",
) -> InvertedIndex:
    """Return the index of items, built by jobs workers of mode.

    The items must come in increasing doc_id order. See the module
    docstring for the guarantees and the errors.
    """
    check_jobs(jobs, mode)
    ordered = list(items)
    names = tuple(pipeline_names)
    chunks = split(ordered, jobs * CHUNKS_PER_JOB if jobs > 1 else 1)
    merged: InvertedIndex | None = None
    errors: list[SiftError] = []
    with gc_paused():
        for part in run_ordered(
            partial(index_chunk, names=names), chunks, jobs=jobs, mode=mode
        ):
            errors.extend(part.errors)
            if errors:
                continue
            if merged is None:
                merged = part.index
            else:
                merged.merge(part.index)
    if errors:
        noun = "file" if len(errors) == 1 else "files"
        raise ExceptionGroup(f"{len(errors)} {noun} failed", errors)
    return merged if merged is not None else InvertedIndex()
```

有两个细节。第一，只要出现过错误，后面的块就不再合并（`continue`），但仍然把剩下的结果取完，错误才能按文档顺序收齐。第二，`jobs=1` 不建池：`_run_ordered` 在 `workers <= 1` 时直接 `yield from map(func, items)`（就是上面 `run_ordered` 那段的第一个分支），这个分支在选 mode 之前，所以三种 mode 一样；`tests/test_parallel.py` 里的 `test_run_ordered_with_one_job_runs_in_this_thread` 用 `mode="process"` 守着它，断言函数跑在调用线程里。

### 为什么要给 `InvertedIndex` 加 pickle 状态

进程和子解释器要把 `Part` 用 pickle 传回来，默认的 pickle 会把每一个 `Posting` 当成对象逐个重建，每个对象一次 Python 层的调用。我给 `InvertedIndex` 写了 `__getstate__` 和 `__setstate__`：`_pack` 把每个 `PostingList` 压成 `[(doc_id, positions), ...]` 这样的纯元组列表，`_unpack` 再包回 `Posting`（`src/sift/index.py` 第 174 到 193 行）。

`__getstate__` 的文档字符串（`index.py` 第 268 行起）现在写着自己的测量：60 篇文档上 `pickle.dumps` 65 毫秒对 284 毫秒，纯元组的 `pickle.loads` 74 毫秒对 270 毫秒（约 4 倍），连 `__setstate__` 里重建 `Posting` 一起的完整加载 197 毫秒对 270 毫秒（约 1.4 倍）。我自己另量了一遍，只对倒排表本身，看 pickle 和重建（脚本里 `index._postings` 和 `_pack`/`_unpack` 是私有名，只在这个实验里用）：

```python
"""Compare pickling postings as objects and as plain tuples."""

import gc
import pickle
from pathlib import Path
from time import perf_counter

from sift.index import _pack, _unpack
from sift.parallel import _index_chunk, read_items

PIPELINE = ("mixed", "nfkc", "stopwords")
ROUNDS = 3


def measure(obj: object) -> tuple[int, float, float]:
    """Return (bytes, best dumps seconds, best loads seconds)."""
    dumps = loads = float("inf")
    blob = b""
    for _ in range(ROUNDS):
        start = perf_counter()
        blob = pickle.dumps(obj)
        dumps = min(dumps, perf_counter() - start)
        start = perf_counter()
        pickle.loads(blob)
        loads = min(loads, perf_counter() - start)
    return len(blob), dumps, loads


def main() -> None:
    """Pickle the postings of 60 documents both ways."""
    items = tuple(read_items(Path("corpus/posts"))[:60])
    gc.disable()
    index = _index_chunk(items, PIPELINE).index
    objects = measure(index._postings)
    wire = _pack(index._postings)
    tuples = measure(wire)
    start = perf_counter()
    _unpack(wire)
    rebuild = perf_counter() - start
    print(f"{index.n_docs} documents, {len(index)} terms")
    print(f"  {'':<10} {'bytes':>9} {'dumps':>9} {'loads':>9}")
    for label, (size, dumps, loads) in (
        ("objects", objects),
        ("tuples", tuples),
    ):
        print(
            f"  {label:<10} {size:>9} {dumps * 1000:6.0f} ms "
            f"{loads * 1000:6.0f} ms"
        )
    print(f"  _unpack after loads: {rebuild * 1000:.0f} ms")
    print(
        f"  loads + _unpack vs objects: {(tuples[2] + rebuild) * 1000:.0f}"
        f" ms vs {objects[2] * 1000:.0f} ms"
    )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/pickle_postings.py
60 documents, 40955 terms
                 bytes     dumps     loads
  objects      3362021    342 ms    218 ms
  tuples       2055271     85 ms     43 ms
  _unpack after loads: 107 ms
  loads + _unpack vs objects: 151 ms vs 218 ms
```

元组形式小了 39%，`dumps` 快 4 倍，`loads` 快 5 倍，文档字符串说的“五分之一”对 C 里的 `pickle.loads` 成立（43 对 218 毫秒）。但 `__setstate__` 随后还要调 `_unpack` 用一个 Python 循环把元组再包回 `Posting`，这一步 107 毫秒，把大部分收益吃了回去，净结果是 151 毫秒对 218 毫秒，约 1.4 倍，不是 5 倍。而 `_unpack` 恰恰跑在父进程里，是下面那堵串行的墙的一部分。

### 暂停垃圾回收

`index_chunk` 外面包着 `gc_paused()`，`index_items` 里合并那一段也包着。它是个 `contextmanager`（`src/sift/parallel.py` 第 177 到 213 行）。回收器是整个解释器共用的一个开关，而 `index_chunk` 在线程模式下会被好几个线程同时调用，所以它用一把锁 `_gc_lock` 保护一个深度计数 `_gc_depth`：第一个进入的线程记下回收器原来是不是开着（`_gc_was_on`）再关掉，只要还有线程在里面就一直关着，最后一个离开的线程只在原来是开着的时候才重新打开。进入和退出可以任意交错、嵌套。

文档字符串现在写的是它自己的测量：分析几块要 3.4 秒（关）对 4.4 秒（开），父进程解包并合并 16 个结果要 1.2 秒对 2.6 到 2.8 秒，约 2.2 倍。我用一个脚本在这台机器上又量了两处（分析一块 246 篇文档；父进程把 16 个 `Part` 的 pickle 依次 `loads` 并 `merge`，共 79,179,842 字节），回收开和关交替做 3 轮取最小：

```python
"""Time chunk analysis and the parent's merge loop, collector on/off."""

import gc
import pickle
from pathlib import Path
from time import perf_counter

from sift.index import InvertedIndex
from sift.parallel import Item, _index_chunk, read_items, replicate, split

PIPELINE = ("mixed", "nfkc", "stopwords")
ROUNDS = 3


def analyze(items: list[Item], collector: bool) -> float:
    """Return the seconds _index_chunk takes on items."""
    gc.enable() if collector else gc.disable()
    start = perf_counter()
    _index_chunk(tuple(items), PIPELINE)
    took = perf_counter() - start
    gc.enable()
    return took


def parent_loop(blobs: list[bytes], collector: bool) -> float:
    """Return the seconds to unpickle and merge every blob in order."""
    gc.enable() if collector else gc.disable()
    merged: InvertedIndex | None = None
    start = perf_counter()
    for blob in blobs:
        part = pickle.loads(blob)
        if merged is None:
            merged = part.index
        else:
            merged.merge(part.index)
    took = perf_counter() - start
    gc.enable()
    return took


def main() -> None:
    """Alternate collector on and off; print the best of each."""
    base = read_items(Path("corpus/posts"))
    small = replicate(base, 2)
    gc.disable()
    blobs = [
        pickle.dumps(_index_chunk(chunk, PIPELINE))
        for chunk in split(replicate(base, 8), 16)
    ]
    gc.enable()
    best: dict[str, float] = {}
    for _ in range(ROUNDS):
        for label, collector in (("gc on", True), ("gc off", False)):
            for what, took in (
                ("analyze", analyze(small, collector)),
                ("parent", parent_loop(blobs, collector)),
            ):
                key = f"{what:<8} {label}"
                best[key] = min(best.get(key, took), took)
    print(f"analyze: {len(small)} documents in one chunk")
    print(f"parent : {len(blobs)} blobs, {sum(map(len, blobs))} bytes")
    for key, seconds in best.items():
        print(f"  {key:<16} {seconds:7.3f} s")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/gc_pause.py
analyze: 246 documents in one chunk
parent : 16 blobs, 79179842 bytes
  analyze  gc on     5.193 s
  parent   gc on    11.906 s
  analyze  gc off    4.160 s
  parent   gc off    4.384 s
```

分析：开着回收 5.193 秒，关掉 4.160 秒，也就是开着慢 25%，或者说关掉省 20%（这两个说法是同一个数，别混着用）。父进程这一段：11.906 秒对 4.384 秒，是 2.7 倍；文档字符串里量的是 2.2 倍，绝对值不同是因为机器当时的状态和块的大小不同，方向和量级一致。机制是同一个：分代回收默认每净增约 2000 个容器对象（`gc.get_threshold()` 在这个构建上是 `(2000, 10, 10)`）就做一次年轻代回收，而索引里的元组、列表、`Posting` 一旦建出来就活到最后，也不成环，每次回收都白白扫一遍；父进程手里的合并结果越大，扫得越久。自由线程构建的回收是非分代的，靠暂停全部线程来保证一致性，暂停回收在那边能省多少我没有单独量。

## 基准：jobs 乘 mode

`sift bench index` 把语料在内存里复制 `--repeat` 份（文档编号重排，文本共享不复制），读文件的时间不算进去，对每个 jobs 和 mode 的组合跑 `index_items`，取 `--rounds` 轮里最快的一次，换算成相对串行的倍数。串行（`jobs=1`，不建池）只量一次，同时充当每个 mode 的第一行。各组合的轮次是交错的，所以机器的快慢状态会同等地落在每个格子上；每个组合还要和串行索引的指纹（文档数、词数、词元数）对一遍，不一致就抛 `SiftError`。命令和 `extra.sh` 里的一样：984 篇文档，jobs 取 1、2、4、8。

第一组数字是 `make ch16` 里 `extra.sh` 跑出来的（前后夹的 `cpu_state.py` 是 `117 116 118 119 119 ms` 和 `119 121 124 126 126 ms`）：

```text
$ python3 -m sift bench index --repeat 8 --jobs 1,2,4,8 --rounds 2 \
    --mode process,thread,interp
corpus: 123 files x 8 = 984 documents, pipeline mixed,nfkc,stopwords
python 3.14.7, GIL enabled, 16 CPUs, best of 2 rounds
jobs            process             thread             interp
   1    15.132 s  1.00x    15.132 s  1.00x    15.132 s  1.00x
   2    14.014 s  1.08x    18.995 s  0.80x    19.560 s  0.77x
   4    10.161 s  1.49x    21.389 s  0.71x    12.968 s  1.17x
   8    10.704 s  1.41x    24.063 s  0.63x    12.350 s  1.23x
$ PYTHONPATH=src python3.14t -m sift bench index --repeat 8 \
    --jobs 1,2,4,8 --rounds 2 --mode thread
corpus: 123 files x 8 = 984 documents, pipeline mixed,nfkc,stopwords
python 3.14.7, GIL disabled, 16 CPUs, best of 2 rounds
jobs             thread
   1    19.789 s  1.00x
   2    10.622 s  1.86x
   4     8.826 s  2.24x
   8     7.400 s  2.67x
serial build, 1 thread: python3 15.132 s, python3.14t 19.789 s, python3.14t / python3 = 1.31
```

最后一行是 `extra.sh` 自己用 `awk` 从两张表的 `jobs=1` 行算出来的单线程开销。因为这一组是先 `python3` 后 `python3.14t` 各跑一次，没有交替，我又单独跑了第二组，顺序反过来（先 `python3.14t`，后 `python3`），前后夹 `cpu_state.py`（`115 115 116 119 123 ms`、`122 116 117 118 124 ms`、`116 120 117 118 121 ms`）：

```text
$ PYTHONPATH=src python3.14t -m sift bench index --repeat 8 \
    --jobs 1,2,4,8 --rounds 2 --mode thread
corpus: 123 files x 8 = 984 documents, pipeline mixed,nfkc,stopwords
python 3.14.7, GIL disabled, 16 CPUs, best of 2 rounds
jobs             thread
   1    18.013 s  1.00x
   2    10.014 s  1.80x
   4     8.244 s  2.19x
   8     6.314 s  2.85x
$ python3 -m sift bench index --repeat 8 --jobs 1,2,4,8 --rounds 2 \
    --mode process,thread,interp
corpus: 123 files x 8 = 984 documents, pipeline mixed,nfkc,stopwords
python 3.14.7, GIL enabled, 16 CPUs, best of 2 rounds
jobs            process             thread             interp
   1    15.188 s  1.00x    15.188 s  1.00x    15.188 s  1.00x
   2    14.336 s  1.06x    18.439 s  0.82x    18.568 s  0.82x
   4    10.397 s  1.46x    21.295 s  0.71x    12.039 s  1.26x
   8     9.814 s  1.55x    22.277 s  0.68x    10.573 s  1.44x
```

两组汇总成一张表（每格两个数，前面是第一组，后面是第二组）：

| jobs=8 | 秒 | 相对本构建串行的倍数 | 相对 `python3` 串行（15.1 秒）的倍数 |
| --- | --- | --- | --- |
| `python3` 进程池 | 10.7、9.8 | 1.41、1.55 | 1.41、1.55 |
| `python3` 线程池 | 24.1、22.3 | 0.63、0.68 | 0.63、0.68 |
| `python3` 子解释器池 | 12.4、10.6 | 1.23、1.44 | 1.23、1.44 |
| `python3.14t` 线程池 | 7.4、6.3 | 2.67、2.85 | 2.04、2.41 |

四条观察，都是从这两张表里直接读出来的，原因在下面逐条解释。

- 带 GIL 的线程池比串行还慢：2 个线程 0.80 到 0.82 倍，8 个线程 0.63 到 0.68 倍。
- 进程池和子解释器池最多 1.55 倍，8 个工作者并没有比 4 个好多少。
- 自由线程的线程池 8 个线程快到 2.67 到 2.85 倍，但这个倍数是相对它自己更慢的串行（15.1 秒对 18.0 到 19.8 秒）算的；相对 `python3` 的串行，只有 2.04 到 2.41 倍。
- 按绝对时间，6.3 到 7.4 秒的自由线程线程池，比 9.8 到 10.7 秒的 `python3` 进程池快 1.5 倍上下。

### 为什么带 GIL 的线程池更慢

八个线程轮流等同一把锁，每次切换都要唤醒另一个线程（上一节读过的 `take_gil` 的等待和 `FORCE_SWITCHING` 的握手），这是纯开销。`thread_switch.py` 去掉别的变量，只改切换间隔：语料复制 2 遍，4 个线程，间隔 5 毫秒、50 毫秒、0.5 秒，三种配置和串行交错跑 3 轮取最小：

```python
"""Time a thread-mode index build at several switch intervals."""

import sys
from pathlib import Path
from time import perf_counter

from sift.parallel import index_items, read_items, replicate

PIPELINE = ("mixed", "nfkc", "stopwords")
ROUNDS = 3
CONFIGS = [(1, 0.005), (4, 0.005), (4, 0.05), (4, 0.5)]


def main() -> None:
    """Print serial and 4-thread times, rounds interleaved."""
    items = replicate(read_items(Path("corpus/posts")), 2)
    best: dict[tuple[int, float], float] = {}
    for _ in range(ROUNDS):
        for jobs, interval in CONFIGS:
            sys.setswitchinterval(interval)
            start = perf_counter()
            index_items(items, PIPELINE, jobs=jobs, mode="thread")
            took = perf_counter() - start
            best[jobs, interval] = min(best.get((jobs, interval), took), took)
    serial = best[1, 0.005]
    print(f"serial (no pool)       {serial:6.3f} s")
    for (jobs, interval), took in best.items():
        if jobs > 1:
            print(
                f"{jobs} threads, {interval:5.3f} s   {took:6.3f} s  "
                f"{serial / took:4.2f}x"
            )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    python3 /tmp/sift-scratch/thread_switch.py; \
    python3 /tmp/sift-scratch/cpu_state.py
117 124 131 122 118 ms
serial (no pool)        4.179 s
4 threads, 0.005 s    4.833 s  0.86x
4 threads, 0.050 s    4.399 s  0.95x
4 threads, 0.500 s    4.345 s  0.96x
134 135 130 129 125 ms
```

默认的 5 毫秒下 4 个线程是 0.86 倍，间隔拉到 50 毫秒是 0.95 倍，0.5 秒是 0.96 倍。也就是说，切换的开销能解释大约 10 个百分点；拉到 0.5 秒以后还剩下约 4% 的亏空，我没有查出来，可能是块的合并和线程创建，也可能是缓存。要说明的是这个实验的语料只有表里的四分之一，表里 4 个线程是 0.71 倍，比这里的 0.86 倍更差，我猜是堆更大、缓存更不友好，没有去验证。顺带一提，别拿“把间隔调大”当修法：间隔大了，别的线程等锁的延迟就变成了几百毫秒，这是用响应性换吞吐，而且在自由线程构建上它压根没用。

### 为什么进程池封顶在 1.5 倍

进程池的每一块都要走三步：工人里分析，工人里 `pickle.dumps`，父进程里 `pickle.loads` 再 `merge`。前两步在 8 个工人里并行，最后一步只有父进程一个，也在主解释器的 GIL 下，是串行的。`parts_cost.py` 把这几步在一个进程里各自计时（16 块，984 篇文档），并按阿姆达尔定律估一个上限：

```python
"""Time the serial steps the parent pays for every worker result."""

import gc
import pickle
from pathlib import Path
from time import perf_counter

from sift.index import InvertedIndex
from sift.parallel import _index_chunk, read_items, replicate, split

PIPELINE = ("mixed", "nfkc", "stopwords")
CHUNKS = 16


def main() -> None:
    """Split the corpus, then time analyze, dumps, loads and merge."""
    items = replicate(read_items(Path("corpus/posts")), 8)
    chunks = split(items, CHUNKS)
    gc.disable()
    analyze = dumps = loads = merge = 0.0
    sizes: list[int] = []
    merged: InvertedIndex | None = None
    for chunk in chunks:
        start = perf_counter()
        part = _index_chunk(chunk, PIPELINE)
        analyze += perf_counter() - start
        start = perf_counter()
        blob = pickle.dumps(part)
        dumps += perf_counter() - start
        sizes.append(len(blob))
        start = perf_counter()
        back = pickle.loads(blob)
        loads += perf_counter() - start
        start = perf_counter()
        if merged is None:
            merged = back.index
        else:
            merged.merge(back.index)
        merge += perf_counter() - start
    gc.enable()
    print(f"{len(items)} documents in {len(chunks)} chunks")
    print(f"  analyze (parallel part) {analyze:7.3f} s")
    print(f"  pickle.dumps (workers)  {dumps:7.3f} s")
    print(f"  pickle.loads (parent)   {loads:7.3f} s")
    print(f"  merge        (parent)   {merge:7.3f} s")
    print(f"  bytes through the pipe  {sum(sizes):>9}")
    serial = loads + merge
    print(f"  parent-only share of the serial build: {serial / analyze:.1%}")
    for n in (2, 4, 8, 16):
        limit = analyze / (analyze / n + dumps / n + serial)
        print(f"  {n:>2} workers: at most {limit:4.2f}x")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/parts_cost.py
984 documents in 16 chunks
  analyze (parallel part)  16.563 s
  pickle.dumps (workers)    4.158 s
  pickle.loads (parent)     3.753 s
  merge        (parent)     1.312 s
  bytes through the pipe   79179842
  parent-only share of the serial build: 30.6%
   2 workers: at most 1.07x
   4 workers: at most 1.62x
   8 workers: at most 2.16x
  16 workers: at most 2.60x
```

分析占 16.6 秒，父进程独占的 `loads` 加 `merge` 共 5.1 秒，是分析时间的 30.6%。这条直线给的上限是：2 个工人 1.07 倍，4 个 1.62 倍，8 个 2.16 倍，16 个 2.60 倍，无限多个工人也只有 16.563 除以 5.065 约 3.3 倍。实测是 2 个工人 1.06 到 1.08，4 个 1.46 到 1.49，8 个 1.41 到 1.55：2 个和 4 个与上限很接近，8 个明显低于上限，没到 2.16。差的那部分我没有建模，嫌疑有三个：8 个工人起进程和各自载入语料的启动开销，79 MB 的数据过管道，以及 8 个进程和父进程挤同样的 8 个物理核。这里的 `loads` 还包括 `__setstate__` 里那个 Python 循环，上一节量过：对 60 篇文档的倒排表，`_unpack` 要 107 毫秒，`pickle.loads` 本身只要 43 毫秒，我没有把这一步单独拆开看占多大比例。

### 为什么子解释器比进程池慢

子解释器池 4 个工作者是 1.17 到 1.26 倍，8 个是 1.23 到 1.44 倍，进程池是 1.46 到 1.49 倍（4 个）和 1.41 到 1.55 倍（8 个）。数据路径上它们的差别是：进程池里只有一个管理线程在父进程里读结果、`loads`；子解释器池里是 4 个或 8 个工作线程，每个都在自己调用 `interp.call` 返回时在调用线程里还原对象（上一节读 `_PyXI_Exit` 得到的结论），也就是 4 到 8 个线程在抢主解释器那一把 GIL 做 `loads`，和带 GIL 的线程池同一种症状。这是我的推断，没有用实验证实（比如把 `loads` 那一步单独计时）。另外池的启动也更贵（上一节引过 whatsnew 的话，每个解释器的启动还没有优化），不过这笔固定开销我没有单独量。

### 为什么自由线程的线程池没有线性加速

没有 GIL，没有 `pickle`，父进程只剩一次 `merge`（上面在 `python3` 上量过是 1.3 秒）。2 个线程 1.80 到 1.86 倍，接近 2；4 个线程 2.19 到 2.24 倍，8 个 2.67 到 2.85 倍，效率从 90% 掉到 35% 上下。我没有查清楚是什么挡住了它，怀疑项有这些：8 个工作线程加上做合并的主线程已经超过 8 个物理核，索引构建又是满是小对象分配的负载，内存带宽和分配器争用都可能挡路。这几条我都没有单独拆开，只能说 2 倍以后的每一份线程，换来的越来越少。

再说单线程的账，前面素数计数是 7% 到 16%，串行索引是 11% 到 20%，这里的两组 `jobs=1` 一行是 1.31 倍和 1.19 倍，五次测量合起来是 11% 到 31%。区间这么宽，我只敢说“量级 10% 到 30%”，比 3.14 的 whatsnew 写的 5% 到 10% 差，我这个负载是满手小对象的。

## 怎么选

把前面的数字压成一张选择表。每一行的依据都是这一篇里量过的东西，没有量过的我写了“没量”：

| 工作的样子 | 我会选 | 依据 |
| --- | --- | --- |
| 大部分时间在等（网络、`sleep`、慢 I/O） | 线程池 | 16 个 0.1 秒的 `sleep`，1 个线程 1.603 秒，16 个线程 0.103 秒，带 GIL 也一样 |
| 页缓存里的小文件读取 | 不并行 | 全部语料 5 毫秒上下，2 到 8 个线程在噪声以内，16 个线程才变慢（4.65 到 7.35 毫秒） |
| CPU 密集，输入输出都小，互相独立 | 进程池 | 能绕开 GIL，序列化的账（200 万整数 10 MB，往返约 100 毫秒）不大 |
| CPU 密集，每块的结果很大，还要在父进程合并 | 进程池或子解释器池，别指望超过 1.5 倍 | 984 篇的索引：父进程的 `loads` 加 `merge` 占分析时间的 30.6%，8 个工作者 1.41 到 1.55 倍 |
| 同上，而且你能用自由线程构建 | 线程池 | 8 个线程 2.67 到 2.85 倍，没有序列化；但单线程慢 11% 到 31%，内存多 19%，依赖要自己确认 |
| 需要进程的隔离，又不想要进程的内存和管道 | 子解释器 | 同一个进程，各有各的 GIL；启动比线程贵（whatsnew 承认还没优化），数据要能共享或者走 pickle 回退 |
| 大块数值数据在进程之间只读或分区写 | `shared_memory` | 800 万字节两个进程各写一半，不拷贝；同步要自己做 |
| 带 GIL 的线程池做 CPU 密集 | 不要 | 0.63 到 0.82 倍，比串行还慢 |

同样是并行，三个构建的差别不在“哪个更先进”，而在数据怎么走：线程共享内存，所以没有搬运费，但要么靠 GIL 排队，要么靠每对象的锁；进程和子解释器隔离，所以要把数据搬来搬去。Sift 的索引恰好是搬运费最高的那种：每一块的输出是一整棵倒排表。

这一篇我最意外的是两件事。一是 GIL 其实是个很弱的保证，弱到我用了 `LRUCache` 里的先检查后动作、一个裸的 `+=`，在 3.14.7 上跑了几十万次都没有出事，不是我写对了，是切换点不在那儿；换到 `python3.14t` 上，这些问题一下子全冒出来。二是并行的天花板几乎总是串行的那一小段：进程池的串行段是父进程的 `loads` 和 `merge`，带 GIL 的线程池的串行段是 GIL 本身，自由线程构建里挡路的是什么我没有查清楚，嫌疑是分配器和内存带宽。前两个的共同点是“我以为是计算在挡路，其实是搬运和排队”。

## 本篇文件

这一章动了 27 个文件（`git diff --shortstat ch15 ch16`：`27 files changed, 2274 insertions(+), 58 deletions(-)`）。表里的 `+N -M` 来自 `git diff --numstat ch15 ch16`，源文件的命令是跑它对应的测试文件，测试结果是我最后一次在仓库里实际跑出来的；`/tmp/sift-scratch/` 里的脚本不进仓库，不在表里。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch16/README.md) | `git diff --numstat ch15 ch16 -- README.md \| awk '{print "+"$1, "-"$2}'` | 退出码 0，`+4 -1` |
| [`deadlock_timeout_fail.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/deadlock_timeout_fail.py) | `python3 lab/ch16/deadlock_timeout_fail.py` | 退出码 1，第一行 `t1: gave up after 1 s, deadlock`，最后一行 `lock order t1: a, b; t2: b, a -> take locks in one order`；`+42 -0` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/extra.sh) | `bash lab/ch16/extra.sh \| tail -1` | 退出码 0，最后一行 `serial build, 1 thread: python3 15.132 s, python3.14t 19.789 s, python3.14t / python3 = 1.31`（取自 `make ch16` 那一次，整个脚本跑 8 分钟左右）；`+32 -0` |
| [`free_threading_check_ft.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/free_threading_check_ft.py) | `python3.14t lab/ch16/free_threading_check_ft.py` | 退出码 0，第一行 `version         : 3.14.7`，最后一行 `switch interval: 0.005 s (unused without a GIL)`；`+40 -0` |
| [`futures_tour.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/futures_tour.py) | `python3 lab/ch16/futures_tour.py` | 退出码 0，第一行 `-- ThreadPoolExecutor: submit, map`，最后一行 `  the pool is broken for every later submit`；`+145 -0` |
| [`gil_cpu_bound.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/gil_cpu_bound.py) | `python3 lab/ch16/gil_cpu_bound.py` | 退出码 0，第一行 `python 3.14.7, GIL enabled: True`，最后一行 `speedup` 是 0.95 到 1.05 之间的数；`+67 -0` |
| [`gil_cpu_bound_ft.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/gil_cpu_bound_ft.py) | `python3.14t lab/ch16/gil_cpu_bound_ft.py` | 退出码 0，第一行 `python 3.14.7, GIL enabled: False`，最后一行 `speedup` 是 3.02 到 3.41 之间的数；`+6 -0` |
| [`io_bound_threads.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/io_bound_threads.py) | `python3 lab/ch16/io_bound_threads.py` | 退出码 0，第一行 `python 3.14.7, GIL enabled: True`，最后一行 `active threads at the end: 1`；`+60 -0` |
| [`lambda_pickle_fail.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/lambda_pickle_fail.py) | `python3 lab/ch16/lambda_pickle_fail.py` | 退出码 1，标准输出一行 `submitting a lambda to a ProcessPoolExecutor`，标准错误里有 `_pickle.PicklingError: Can't pickle local object`；`+17 -0` |
| [`locks.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/locks.py) | `python3 lab/ch16/locks.py` | 退出码 0，第一行 `-- Lock`，最后一行 `  all arrivals come before every departure: True`；`+165 -0` |
| [`multiprocessing_basics.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/multiprocessing_basics.py) | `python3 lab/ch16/multiprocessing_basics.py` | 退出码 0，第一行 `-- start method`，最后一行是 `apply(square, 1)` 的耗时（我看到的是 29 到 34 毫秒）；`+69 -0` |
| [`queue_workers.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/queue_workers.py) | `python3 lab/ch16/queue_workers.py` | 退出码 0，第一行 `-- producer / consumer with sentinels`，最后一行 `  put after shutdown -> queue.ShutDown`；`+115 -0` |
| [`race_condition.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/race_condition.py) | `python3 lab/ch16/race_condition.py` | 退出码 0，第一行 `python 3.14.7, GIL enabled: True`，最后一行 `  counter.value += 1 under a Lock    expected 1600000, got 1600000, lost 0`；`+78 -0` |
| [`race_condition_ft.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/race_condition_ft.py) | `python3.14t lab/ch16/race_condition_ft.py` | 退出码 0，第一行 `python 3.14.7, GIL enabled: False`，最后一行同上；`+6 -0` |
| [`shared_memory.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/shared_memory.py) | `python3 lab/ch16/shared_memory.py` | 退出码 0，第一行 `created a block of 8000000 bytes (name not printed)`，最后一行 `block unlinked`；`+62 -0` |
| [`subinterpreters.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/subinterpreters.py) | `python3 lab/ch16/subinterpreters.py` | 退出码 0，第一行 `-- an interpreter is a separate world`，最后一行 `threads alive at the end: 1`；`+70 -0` |
| [`threads_basics.py`](https://github.com/bfmhno3/sift/blob/ch16/lab/ch16/threads_basics.py) | `python3 lab/ch16/threads_basics.py` | 退出码 0，第一行 `-- start and join`，最后一行 `  RuntimeError: cannot set daemon status of active thread`；`+97 -0` |
| [`chapter.py`](https://github.com/bfmhno3/sift/blob/ch16/scripts/chapter.py) | `git diff --numstat ch15 ch16 -- scripts/chapter.py \| awk '{print "+"$1, "-"$2}'` | 退出码 0，`+2 -1`（给 `extra.sh` 一个单独的 900 秒超时 `EXTRA_TIMEOUT`） |
| [`__init__.py`](https://github.com/bfmhno3/sift/blob/ch16/src/sift/__init__.py) | `PYTHONPATH=src python3.14t -m sift --version` | 退出码 0，输出 `sift 0.0.0+source`；`+6 -2` |
| [`cli.py`](https://github.com/bfmhno3/sift/blob/ch16/src/sift/cli.py) | `python3 -m pytest tests/test_cli.py \| tail -1` | 退出码 0，`67 passed in 3.71s`；`+133 -23` |
| [`index.py`](https://github.com/bfmhno3/sift/blob/ch16/src/sift/index.py) | `python3 -m pytest tests/test_index.py \| tail -1` | 退出码 0，`34 passed in 0.66s`；`+98 -0` |
| [`parallel.py`](https://github.com/bfmhno3/sift/blob/ch16/src/sift/parallel.py) | `python3 -m pytest tests/test_parallel.py \| tail -1` | 退出码 0，`40 passed in 2.06s`；`+381 -0` |
| [`store.py`](https://github.com/bfmhno3/sift/blob/ch16/src/sift/storage/store.py) | `python3 -m pytest tests/test_store.py \| tail -1` | 退出码 0，`36 passed in 3.24s`；`+14 -27` |
| [`test_cli.py`](https://github.com/bfmhno3/sift/blob/ch16/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py \| tail -1` | 退出码 0，`67 passed in 3.71s`；`+90 -4` |
| [`test_index.py`](https://github.com/bfmhno3/sift/blob/ch16/tests/test_index.py) | `python3 -m pytest tests/test_index.py \| tail -1` | 退出码 0，`34 passed in 0.66s`；`+90 -0` |
| [`test_parallel.py`](https://github.com/bfmhno3/sift/blob/ch16/tests/test_parallel.py) | `python3 -m pytest tests/test_parallel.py \| tail -1` | 退出码 0，`40 passed in 2.06s`；`+326 -0` |
| [`test_store.py`](https://github.com/bfmhno3/sift/blob/ch16/tests/test_store.py) | `python3 -m pytest tests/test_store.py \| tail -1` | 退出码 0，`36 passed in 3.24s`；`+59 -0` |

## 练习

**1.** `LRUCache` 配一把锁。先用 `shared_cache.py` 在 `python3.14t` 上确认现在的故障（`KeyError` 和超出容量），再加锁修好，把 `KeyError` 压到 0、`len(cache)` 压回 `maxsize` 以内。想一想该用 `Lock` 还是 `RLock`（提示：`get_or_set` 里面调用了 `self[key]`），再在两个构建上量单线程命中时加锁多付了多少纳秒。

**2.** 父进程的 `__setstate__` 里有一个 Python 循环把元组包回 `Posting`，上面量出它吃掉了大部分收益。想一个办法让 `merge` 不用先建 `Posting`（比如让 `PostingList` 先持有元组，被读到时再展开），用 `pickle_postings.py` 的办法量一次，并检查 `tests/test_index.py` 里的哪些测试会因此失败、为什么。

**3.** 把 `make_executor` 里的 `ProcessPoolExecutor(workers)` 换成 `ProcessPoolExecutor(workers, mp.get_context("fork"))`，在 `sift bench index` 的 `process` 一列上重新量。`fork` 省掉了子进程重新导入模块的时间，那它能让 8 个工作者的 1.4 到 1.55 倍变成多少？为什么 CPython 在 3.14 里把默认值从 `fork` 改成了 `forkserver`，而你的线程池又在哪一步会让 `fork` 变得危险？

## 下一篇

下一篇是《[并发（下）：asyncio 与手写 HTTP 服务器](/posts/python-by-sift-17-asyncio/)》。一个线程怎么同时等很多个连接，我想从 `selectors` 写一个小的事件循环开始，再把 `sift` 的搜索放到一个手写的 HTTP 服务器后面。
