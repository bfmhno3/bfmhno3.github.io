---
title: "并发（下）：asyncio 与手写 HTTP 服务器"
commentId: "post:python-by-sift-17-asyncio"
published: "2026-10-25 05:00:00 +08:00"
description: "用 Sift 重学 Python 第 17 篇：我用 Python 3.14.7 先用 selectors 写了一个 60 行的事件循环，再拆开 asyncio 的 Future、任务、TaskGroup、取消、执行器和流，最后给 Sift 加了手写 HTTP/1.1 解析的 sift serve --raw。协程里一行 time.sleep(0.3) 让 10 毫秒一次的心跳停了 310 毫秒，换成 asyncio.to_thread 后最长间隔 11 毫秒；100 个客户端打 /search，asyncio 服务器 67.9 req/s，ThreadingHTTPServer 65.0 req/s，搜索是 CPU 活，GIL 下打平；/health 上 7375 对 4421 req/s，但压测脚本自己的上限就在 7400 左右；一个客户端发一阵慢搜索再挂断，没有限制时能让别人的搜索等 28.8 秒。"
category: Tutorial
tags:
  - Python
  - Sift
  - asyncio
  - 异步
  - HTTP
  - 网络编程
series: "用 Sift 重学 Python"
seriesOrder: 17
draft: false
comment: true
slug: python-by-sift-17-asyncio
---

我在一个协程里写了一行 `time.sleep(0.3)`，旁边挂了一个每 10 毫秒醒一次的心跳任务。心跳最长的一次间隔是 310.5 毫秒：这 0.3 秒里整个事件循环什么别的也没做，包括那个只想每 10 毫秒醒一次的任务。把这一行换成 `await asyncio.to_thread(time.sleep, 0.3)`，同一个心跳的最长间隔掉到 10.9 毫秒。两个版本都“阻塞”了 0.3 秒，区别只在谁在等：前一个让唯一的线程等，后一个让另一个线程等。这一篇从这两行输出出发，先用 `selectors` 写一个 60 行的事件循环，再看 asyncio 的任务、`TaskGroup`、取消和流，最后给 Sift 加一个手写 HTTP/1.1 解析的服务器，和标准库的 `ThreadingHTTPServer` 用同一个压测脚本比一比。比的结果有点扫兴，我留到压测那一节说。

```text
$ python3 lab/ch17/blocking_in_loop.py | sed -n 2,3p
time.sleep in a coroutine: longest gap  310.5 ms
asyncio.to_thread        : longest gap   10.9 ms
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch17`（提交 `e91403e`）：新增 `src/sift/server/raw.py`（建在 `asyncio.start_server` 上、请求行和头部都手写解析的服务器，路由是 `/search`、`/docs/<id>`、`/health`，带连接数、排队搜索数和搜索时限三道上限，以及回环地址上的 `Host` 检查）和 `src/sift/server/__init__.py`；`src/sift/cli.py` 多了 `sift serve --raw`（`--host`、`--port`、`--max-pending`、`--quiet`）和 `port_arg`；`README.md` 加了几行；`tests/test_server_raw.py` 是新文件，`tests/test_cli.py` 加了几个用例；`lab/ch17` 下有 15 个脚本加一个 `extra.sh`，其中 `load.py` 是压测脚本，`threaded_http_server.py` 是拿来比较的 `ThreadingHTTPServer` 版本。一共 22 个文件，`git diff --shortstat ch16 ch17` 给出 `22 files changed, 3469 insertions(+), 2 deletions(-)`。`make ch17` 的 15 个脚本全是 `ok`，随后的 `extra.sh` 也是 `ok`，完整测试 765 passed、1 xfailed，`make typecheck` 0 个错误。
> 下一篇给 `sift serve` 加一个 FastAPI 的默认实现，`--raw` 仍然保留。
> 涉及的 Python 特性：`socket`、`selectors`、协程与 `await`、`Future` 与 `asyncio.Task`、`TaskGroup` 与 `except*`、`asyncio.timeout`、取消、异步迭代器与异步生成器、`async with`、`asyncio.Queue` 与 `Semaphore`、`asyncio.to_thread` 与执行器、`contextvars`、`asyncio` 的流、`python -m asyncio ps`。
> 前置：[第 16 篇](/posts/python-by-sift-16-threads-processes-gil/)。上一篇量过线程池对“大部分时间在等”的活有用，因为线程等 I/O 时会放开 GIL；这一篇换一种办法：不开线程，让一个线程自己轮流等很多个连接。

## 环境

和前几篇同一台机器，仓库在标签 `ch17`（提交 `e91403e`），命令都在 `nix develop` 里、仓库根目录 `~/Projects/sift` 下跑：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags
ch17
$ lscpu | sed -n '/Model name/p;/^CPU(s):/p'
CPU(s):                                  16
Model name:                              AMD Ryzen 7 PRO 6850U with Radeon Graphics
$ cat /proc/sys/kernel/yama/ptrace_scope
1
```

最后一行后面会用到：`python -m asyncio ps` 要附加到别的进程上，而这个值是 1，我会在调试那一节看到它的后果。

这台机器的 CPU 有快慢两个状态（前几篇测到过差约 2.5 倍），所以计时前后我各夹一次 `cpu_state.py`（第 12 篇贴过的固定忙循环，快状态下 5 个数在 110 到 120 毫秒附近）。这一篇所有夹出来的数最小 110，最大 171，没有出现过慢状态的 280 毫秒上下；大于 120 的有十来次，多数出现在刚跑完一个起了很多线程的脚本之后，或者一条命令的第一个数上，下一次测都回到 113 上下，我没有追究原因。所以全篇是快状态下的数字。

文中引用的 CPython 源码都指 `v3.14.7` 标签，是我按路径从 GitHub 的 raw 地址拉到 `/tmp/cpython-3.14.7/` 的，行号都是在那份文件里数出来的：

```bash
$ cd /tmp/cpython-3.14.7
$ for f in Lib/asyncio/base_events.py Lib/asyncio/selector_events.py \
      Lib/asyncio/tasks.py Lib/asyncio/taskgroups.py \
      Lib/asyncio/futures.py Lib/asyncio/streams.py \
      Lib/asyncio/timeouts.py Lib/asyncio/runners.py \
      Lib/asyncio/tools.py Lib/asyncio/threads.py Lib/asyncio/events.py \
      Lib/asyncio/__main__.py Lib/concurrent/futures/thread.py \
      Lib/selectors.py Lib/socketserver.py Lib/http/server.py \
      Doc/whatsnew/3.14.rst Doc/howto/remote_debugging.rst \
      Doc/library/asyncio-runner.rst Doc/library/asyncio-queue.rst \
      Doc/library/asyncio-sync.rst; do
    mkdir -p "$(dirname "$f")"
    curl -sfL -o "$f" \
        "https://raw.githubusercontent.com/python/cpython/v3.14.7/$f"
done
```

PEP 的文本取自 `python/peps` 仓库 main 分支的 `peps/pep-0492.rst` 一类路径。我读到的 `Status:` 行：PEP 3156 (asyncio)、492 (`async`/`await`)、525（异步生成器）、567 (`contextvars`)、654（`ExceptionGroup` 和 `except*`）、758（`except` 不加括号）都是 `Final`。

仓库这一头，`make ch17` 先跑 12 个脚本，再跑 `extra.sh`（它起服务器、做 `asyncio ps` 和压测，是后面两节的数字来源），整个过程 2 分 22 秒；完整测试、类型检查和格式检查也都过了：

```text
$ python3 /tmp/sift-scratch/cpu_state.py
121 116 117 110 118 ms
$ make ch17 > /tmp/ch17_make.txt 2>&1; sed -n 1,16p /tmp/ch17_make.txt
python3 scripts/chapter.py ch17
ok   lab/ch17/async_iter_ctx.py
ok   lab/ch17/blocking_in_loop.py
ok   lab/ch17/contextvars_demo.py
ok   lab/ch17/coroutines_basics.py
ok   lab/ch17/executors.py
ok   lab/ch17/executors_ft.py
ok   lab/ch17/forgot_await.py
ok   lab/ch17/futures_basics.py
ok   lab/ch17/load.py
ok   lab/ch17/queues_semaphores.py
ok   lab/ch17/selectors_loop.py
ok   lab/ch17/sockets_blocking.py
ok   lab/ch17/tasks_gather_taskgroup.py
ok   lab/ch17/threaded_http_server.py
ok   lab/ch17/timeouts_cancellation.py
$ grep -n '^ok.*extra' /tmp/ch17_make.txt
175:ok   lab/ch17/extra.sh
$ python3 /tmp/sift-scratch/cpu_state.py
112 113 114 113 113 ms
$ python3 -m pytest | tail -1
765 passed, 1 xfailed in 21.15s
$ make typecheck | tail -2
Success: no issues found in 37 source files
0 errors, 0 warnings, 0 informations
```

`/tmp/sift-scratch/` 里是我这一篇的草稿脚本，不进仓库；正文里它们都整份贴出来。

## 阻塞套接字：一个客户端占一个线程

`recv()` 在没有数据时会睡到有数据为止，这是“阻塞”的全部含义。一个只用阻塞套接字的回声服务器有两种写法：每个连接一个线程，或者所有连接共用一个线程。`sockets_blocking.py` 两种都写了，再各放一个“连上就不说话”的客户端进去：

```python
# lab/ch17/sockets_blocking.py (listen, ask and parts of main omitted)
def echo(conn: socket.socket) -> None:
    """Send back every chunk until the peer closes."""
    with conn:
        while chunk := conn.recv(1024):
            conn.sendall(chunk)


def accept_loop(listener: socket.socket, threaded: bool) -> None:
    """Accept connections; serve each in a new thread or inline."""
    while True:
        try:
            conn, _ = listener.accept()
        except OSError:
            return  # the listener was closed
        if threaded:
            threading.Thread(target=echo, args=(conn,), daemon=True).start()
        else:
            echo(conn)


def main() -> None:
    """Show that a blocking server needs one thread per client."""
    print("-- one thread per client")
    listener, port = listen(threaded=True)
    # this client connects and then says nothing
    idle = socket.create_connection(("127.0.0.1", port))
    # ... a second client asks; its answer is timed ...

    print("-- one thread for everyone")
    listener, port = listen(threaded=False)
    idle = socket.create_connection(("127.0.0.1", port))
    reply = ask(port, "hello", patience=0.3)
    print(f"idle client holds the only thread; second client: {reply!r}")
    idle.close()  # recv() returns b"", the server accepts the next one
    # ... asks once more and prints the answer ...
```

```text
$ python3 lab/ch17/sockets_blocking.py
-- one thread per client
idle client holds a thread; second client: 'hello'
answered in under 0.2 s: True
-- one thread for everyone
idle client holds the only thread; second client: '<no answer>'
after the idle client left: 'hello'
```

第二个版本里，那个沉默的客户端占住了唯一的线程，`ask` 等了 0.3 秒什么也没等到；它一走，`recv()` 返回 `b""`，`echo` 结束，`accept_loop` 才去接下一个连接。第一个版本没有这个问题，代价是每个客户端一个线程。一个线程要一块栈和内核里的一个调度实体，一万个沉默的客户端就是一万个线程在睡觉；这个账我没有量（我没有测一个空闲线程占多少内存），所以“一万个线程撑不住”是我的印象，不是这一篇的结论。

我想要的是另一种东西：不要为每个连接留一个会睡觉的线程，而是让操作系统告诉我“这几个套接字现在有数据了”，我只对它们调用 `recv()`，调用一定不会睡。

## 就绪通知：用 `selectors` 写一个 60 行的事件循环

Linux 上这个“告诉我哪几个好了”的系统调用是 `epoll`，标准库的 `selectors` 把它和 `kqueue`、`poll`、`select` 包成同一个接口。`selectors_loop.py` 用它写了一个事件循环：把套接字和一个回调登记进去，然后不停地问“谁可读”，对可读的那些调回调。

```python
# lab/ch17/selectors_loop.py (client and main omitted)
Callback = Callable[[socket.socket], None]


class Loop:
    """Wait for readable sockets and call their callbacks."""

    def __init__(self) -> None:
        """Create the selector (epoll on Linux)."""
        self.selector = selectors.DefaultSelector()
        self.calls = 0

    def add_reader(self, sock: socket.socket, callback: Callback) -> None:
        """Call callback(sock) whenever sock is readable."""
        self.selector.register(sock, selectors.EVENT_READ, callback)

    def remove_reader(self, sock: socket.socket) -> None:
        """Stop watching sock."""
        self.selector.unregister(sock)

    def run_until(self, done: Callable[[], bool]) -> None:
        """Run callbacks as sockets become ready until done()."""
        while not done():
            for key, _ in self.selector.select(timeout=0.05):
                self.calls += 1
                key.data(key.fileobj)


def serve(loop: Loop, listener: socket.socket) -> None:
    """Accept clients and echo what they send, never blocking."""
    listener.setblocking(False)

    def on_client(conn: socket.socket) -> None:
        chunk = conn.recv(1024)
        if chunk:
            conn.send(chunk)  # fits the socket buffer: no write wait
        else:
            loop.remove_reader(conn)
            conn.close()

    def on_accept(sock: socket.socket) -> None:
        conn, _ = sock.accept()
        conn.setblocking(False)
        loop.add_reader(conn, on_client)

    loop.add_reader(listener, on_accept)
```

`main()` 在主线程里调 `serve`，另起 5 个线程当客户端（每个发三行、收三行），然后 `loop.run_until(...)`，直到 5 个客户端都收齐：

```text
$ python3 lab/ch17/selectors_loop.py
c0 c0-0 c0-1 c0-2
c1 c1-0 c1-1 c1-2
c2 c2-0 c2-1 c2-2
c3 c3-0 c3-1 c3-2
c4 c4-0 c4-1 c4-2
selector: EpollSelector
server thread: MainThread
callbacks run: 24
```

5 个客户端被同一个线程 (`MainThread`) 服务，没有一个会睡觉的 `recv()`。回调次数我只能算出一个范围：5 次 `on_accept`，5 个客户端各 3 次回声共 15 次，再加上读到 EOF 的次数。`run_until` 在第 5 个客户端收齐回复时就停了，最后几个 EOF 回调可能还没轮到，所以这个数每次是 23 到 25；我连跑 16 次，23 出现 3 次，24 出现 4 次，25 出现 9 次。

这 60 来行里有一处是偷懒：`conn.send(chunk)` 假定内核的发送缓冲放得下。对一行回声这是对的，对一个几百 KB 的响应就不对了，真正的循环还要在 `send` 写不完时登记 `EVENT_WRITE`、把剩下的字节攒在缓冲里。asyncio 的 transport 做的就是这件事（`Lib/asyncio/selector_events.py` 第 1053 行起的 `write`）；我没有拿大响应去测这个玩具循环，所以这里只能说“会出问题”是从原理推的。

`DefaultSelector` 在 Linux 上是 `EpollSelector` 已经在输出里了。源码里选择的顺序写在 `Lib/selectors.py` 第 594 到 603 行：有 `kqueue` 用 `kqueue`，否则 `epoll`，再是 `devpoll`、`poll`，最后才是 `select`。`EpollSelector.select`（第 435 到 463 行）做的事和我的 `run_until` 里那一行一样，把 `epoll.poll` 返回的 `(fd, event)` 翻成 `(key, mask)`；有一处细节值得看（第 441 到 443 行）：`epoll_wait()` 的精度是 1 毫秒，所以超时被向上取整到毫秒，“至少等这么久”。

还有一个我一直想确认的问题：为什么异步 I/O 的故事里总是套接字，不是文件？直接问 epoll：

```text
$ python3 -c "import selectors as s; \
> s.DefaultSelector().register(open('/etc/hostname', 'rb'), s.EVENT_READ)" \
>     2>&1 | tail -1
PermissionError: [Errno 1] Operation not permitted
$ python3 -c "import selectors as s, socket; \
> s.DefaultSelector().register(socket.socket(), s.EVENT_READ); \
> print('socket registered')"
socket registered
```

epoll 拒绝普通文件。我对这个拒绝的解释是：文件“永远是就绪的”，问它有没有数据没有意义，真正慢的是磁盘，而磁盘慢这件事用就绪通知表达不出来（实验只证明了被拒绝，解释是我的）。所以事件循环对文件没有办法，只能把读写丢给线程，这也是后面 `to_thread` 的位置。

## 事件循环的真身

我的玩具循环和 asyncio 的循环是同一个形状，只是后者多了定时器和就绪队列。`BaseEventLoop.run_forever` 就是一个 `while True`（`Lib/asyncio/base_events.py` 第 673 到 682 行），每一圈调一次 `_run_once`（第 1977 到 2058 行）。去掉清理已取消定时器的那一段，核心是这些：

```python
# Lib/asyncio/base_events.py, v3.14.7, lines 2008-2022 and 2040-2057
        timeout = None
        if self._ready or self._stopping:
            timeout = 0
        elif self._scheduled:
            # Compute the desired timeout.
            timeout = self._scheduled[0]._when - self.time()
            if timeout > MAXIMUM_SELECT_TIMEOUT:
                timeout = MAXIMUM_SELECT_TIMEOUT
            elif timeout < 0:
                timeout = 0

        event_list = self._selector.select(timeout)
        self._process_events(event_list)
        # ...
        ntodo = len(self._ready)
        for i in range(ntodo):
            handle = self._ready.popleft()
            if handle._cancelled:
                continue
            if self._debug:
                # ... times handle._run(), warns if slow ...
            else:
                handle._run()
```

读下来是这样一圈：有现成的回调就不等 (`timeout = 0`)，没有就等到最近的定时器，两样都没有就一直等 (`None`)；然后 `select`，`_process_events`（`Lib/asyncio/selector_events.py` 第 746 到 758 行）把就绪的读写回调放进 `_ready`；到期的定时器也放进去；最后只运行 `ntodo` 个，也就是这一圈开始时 `_ready` 里已有的。运行期间新加进来的回调（比如一个任务 `await asyncio.sleep(0)` 之后的下一步）要等下一圈，下一圈开头还要再 `select` 一次。这条“只跑 `ntodo` 个”的规则（源码注释原文是 “We run all currently scheduled callbacks, but not any callbacks scheduled by callbacks run this time around -- they will be run the next time (after another I/O poll).”）就是 `asyncio.sleep(0)` 能“让出一圈”的原因。

回调被调用的地方是 `Handle._run`，它用 `self._context.run(self._callback, *self._args)`（`Lib/asyncio/events.py` 第 92 到 94 行）。回调带着自己的 `contextvars.Context`，后面讲 `contextvars` 时会回到这一行。

我想看到这一圈圈真的发生，所以换一个会记录超时的 selector 给循环。`asyncio.run` 的 `loop_factory` 参数有文档（`Doc/library/asyncio-runner.rst` 第 25 行）；`SelectorEventLoop(selector)` 的 selector 参数文档里没写，我是在源码里看到的（`Lib/asyncio/selector_events.py` 第 59 行 `def __init__(self, selector=None)`），所以这一半只能算半公开：

```python
"""Show what the event loop asks its selector, one poll at a time."""

import asyncio
import selectors


class CountingSelector(selectors.DefaultSelector):
    """The default selector, recording every timeout it is given."""

    def __init__(self) -> None:
        """Start with an empty log."""
        super().__init__()
        self.timeouts: list[float | None] = []

    def select(self, timeout: float | None = None):
        """Log the timeout, then poll as usual."""
        self.timeouts.append(timeout)
        return super().select(timeout)


async def work(selector: CountingSelector) -> int:
    """Yield to the loop three times, sleep 50 ms; count the polls."""
    for _ in range(3):
        await asyncio.sleep(0)
    await asyncio.sleep(0.05)
    return len(selector.timeouts)


def main() -> None:
    """Print the implementations in use and the poll log."""
    selector = CountingSelector()
    done = asyncio.run(
        work(selector),
        loop_factory=lambda: asyncio.SelectorEventLoop(selector),
    )
    print("Task class     :", asyncio.Task.__module__)
    print("Future class   :", asyncio.Future.__module__)
    print("selector       :", type(selector).__mro__[1].__name__)
    print(f"polls until work() returned: {done}")
    for i, timeout in enumerate(selector.timeouts[:done]):
        print(f"  poll {i}: timeout {timeout:.3f}")
    print(f"polls in asyncio.run() cleanup: {len(selector.timeouts) - done}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/loop_peek.py
Task class     : _asyncio
Future class   : _asyncio
selector       : EpollSelector
polls until work() returned: 6
  poll 0: timeout 0.000
  poll 1: timeout 0.000
  poll 2: timeout 0.000
  poll 3: timeout 0.000
  poll 4: timeout 0.050
  poll 5: timeout 0.000
polls in asyncio.run() cleanup: 5
```

三次 `sleep(0)` 加上最初那一步，前四圈的超时都是 0，因为每一圈结束时 `_ready` 里都有下一步在等。第五圈 (poll 4) 只剩一个 50 毫秒的定时器，`select` 带着 0.050 的超时睡下去，这 50 毫秒里线程在内核的 `epoll_wait` 里，什么也没占；定时器一到，唤醒任务的回调进 `_ready`，poll 5 的超时又是 0。`asyncio.run` 收尾还要几圈：`Runner.close`（`Lib/asyncio/runners.py` 第 66 到 81 行）依次取消剩下的任务、`shutdown_asyncgens`、`shutdown_default_executor`，所以多出 5 次；我没有把这 5 圈一一对应到这三步，只数了个数。

输出的第一行还有个细节：`Task` 和 `Future` 的类来自 `_asyncio`，是 C 实现。`Lib/asyncio/tasks.py` 第 380 到 386 行在能导入 `_asyncio` 时把 `Task` 换成 `_asyncio.Task`；下面引用的 `tasks.py` 里的 `Task.__step` 是留在那里的纯 Python 版本 (`_PyTask`)。逻辑我是读 Python 版本读的，C 版本我没有读（`_asynciomodule.c` 不在我拉的文件里），按理说语义一致，但这是推断。

## 协程、Future 和 Task

调用一个 `async def` 函数不会运行它的函数体，只会造出一个协程对象。事件循环是怎么让它跑起来的，`coroutines_basics.py` 用手动 `send(None)` 演示了一遍：

```python
# lab/ch17/coroutines_basics.py (main trimmed)
async def add(a: int, b: int) -> int:
    """Return a + b, after one trip through the event loop."""
    await asyncio.sleep(0)
    return a + b


class Ready:
    """An awaitable: __await__ returns an iterator."""

    def __await__(self) -> Generator[None, None, int]:
        """Yield to the loop once, then finish with 42."""
        yield
        return 42


def drive(coro: Coroutine[None, None, int]) -> None:
    """Run a coroutine by hand, the way an event loop does."""
    steps = 0
    try:
        while True:
            coro.send(None)
            steps += 1
    except StopIteration as stop:
        print(f"  finished after {steps} suspension(s): {stop.value}")


def main() -> None:
    """Call, inspect, drive and run coroutines."""
    coro = add(1, 2)
    print("calling add(1, 2) returns:", type(coro).__name__)
    print("iscoroutine:", inspect.iscoroutine(coro))
    print("state:", inspect.getcoroutinestate(coro))
    print("nothing ran yet; drive it by hand:")
    drive(coro)
    print("state:", inspect.getcoroutinestate(coro))
    # ... a custom awaitable, then asyncio.run(total()) ...
    print("-- await only works inside async def")
    try:
        compile("await add(1, 2)", "<top>", "exec")
    except SyntaxError as error:
        print("SyntaxError:", error.msg)
```

```text
$ python3 lab/ch17/coroutines_basics.py
calling add(1, 2) returns: coroutine
iscoroutine: True
state: CORO_CREATED
nothing ran yet; drive it by hand:
  finished after 1 suspension(s): 3
state: CORO_CLOSED
a custom awaitable, driven by hand:
  finished after 1 suspension(s): 42
asyncio.run(total()): 10
-- await only works inside async def
SyntaxError: 'await' outside function
```

`drive` 就是事件循环最小的内核。`coro.send(None)` 跑到第一个让出点（这里是 `asyncio.sleep(0)` 里那个裸 `yield`）就回来；再 `send` 一次，协程 `return`，函数的返回值以 `StopIteration.value` 的形式出来，这里是 3。`await x` 的语义大致是把 `x.__await__()` 返回的迭代器里的值原样让出去，返回值作为 `await` 表达式的结果，所以 `Ready` 这种只有 `__await__` 的对象就是 awaitable。`async`/`await` 语法来自 PEP 492（`Python-Version: 3.5`，状态 `Final`）。

真正的 `Task` 是这个 `drive` 加上和事件循环的接线。`Task.__step_run_and_handle_result`（`Lib/asyncio/tasks.py` 第 283 到 357 行）里，第 289 行是 `result = coro.send(None)`，之后看协程让出了什么：

```python
# Lib/asyncio/tasks.py, v3.14.7, lines 309-329 and 341-343 (trimmed,
# the comment on line 342 is wrapped to fit)
            blocking = getattr(result, '_asyncio_future_blocking', None)
            if blocking is not None:
                # Yielded Future must come from Future.__iter__().
                # ... checks: same loop, not the task itself ...
                        futures.future_add_to_awaited_by(result, self)
                        result._asyncio_future_blocking = False
                        result.add_done_callback(
                            self.__wakeup, context=self._context)
                        self._fut_waiter = result
            # ...
            elif result is None:
                # Bare yield relinquishes control for one event loop
                # iteration.
                self._loop.call_soon(self.__step, context=self._context)
```

让出一个 Future，Task 就在它上面挂一个 `__wakeup`（第 359 到 373 行，Future 完成时调用，继续 `__step`）；让出 `None`，Task 就 `call_soon` 自己，下一圈再来。所以 `asyncio.sleep(0)` 是一个裸 `yield`（第 678 到 687 行的 `__sleep0`），而 `asyncio.sleep(1)` 是这样（第 699 到 707 行）：建一个 Future，用 `loop.call_later` 安排 1 秒后把它置成完成，然后 `await` 这个 Future。整个机器就这两个动作：让出 Future 就等它，让出 `None` 就让一圈。

Future 是任务背后那个更小的东西：一个装结果的空格子，由别人来填。`futures_basics.py` 手动填它，四种填法各一个演示：

```python
# lab/ch17/futures_basics.py (exception and cancel demos trimmed)
async def wait_for_it(future: asyncio.Future[int]) -> int:
    """Await a Future that somebody else will complete."""
    print("  waiter: awaiting, done =", future.done())
    value = await future
    print("  waiter: woke up with", value)
    return value * 2


async def result_demo() -> None:
    """A loop.call_later callback completes the Future."""
    print("-- set_result from a call_later callback")
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    waiter = asyncio.create_task(wait_for_it(future))
    await asyncio.sleep(0)  # let the waiter reach its await
    future.add_done_callback(lambda f: print("  callback: got", f.result()))
    loop.call_later(0.05, future.set_result, 21)
    print("  main: waiter returned", await waiter)
    print("  done =", future.done(), "result =", future.result())
    print("-- a Task is a Future: it has the same methods")
    print("  isinstance(waiter, Future):", isinstance(waiter, asyncio.Future))


async def cancel_demo() -> None:
    """cancel() ends a pending Future; awaiting it raises."""
    print("-- cancel")
    future: asyncio.Future[int] = asyncio.get_running_loop().create_future()
    print("  cancel() returned", future.cancel())
    # ... prints cancelled() and done(), awaits it, cancels again ...


async def thread_demo() -> None:
    """Another thread completes a Future through the loop."""
    print("-- set_result from another thread: call_soon_threadsafe")
    loop = asyncio.get_running_loop()
    future: asyncio.Future[str] = loop.create_future()
    threading.Thread(
        target=lambda: loop.call_soon_threadsafe(future.set_result, "hi")
    ).start()
    print("  awaited:", await future)
```

```text
$ python3 lab/ch17/futures_basics.py
-- set_result from a call_later callback
  waiter: awaiting, done = False
  waiter: woke up with 21
  callback: got 21
  main: waiter returned 42
  done = True result = 21
-- a Task is a Future: it has the same methods
  isinstance(waiter, Future): True
-- set_exception
  exception(): ValueError('boom')
  await raised: boom
  a second set_result raises InvalidStateError
-- cancel
  cancel() returned True
  cancelled(): True done(): True
  await raised CancelledError
  cancel() again returned False
-- set_result from another thread: call_soon_threadsafe
  awaited: hi
```

`await future` 把 Future 一路让出给 `Task`，也就是前面那个挂 `__wakeup` 的分支。`set_result`（`Lib/asyncio/futures.py` 第 257 到 267 行）只改状态，然后调 `__schedule_callbacks`，回调是用 `call_soon` 排进 `_ready` 的，不会在 `set_result` 里当场运行；`add_done_callback`（第 226 到 238 行）按加入的顺序记回调。所以输出里 `waiter: woke up` 排在 `callback: got` 前面：任务 `await` 的时候就登记了 `__wakeup`，我的 lambda 是后来才加的。`isinstance(waiter, Future)` 是 `True`：`Task` 是 `Future` 的子类，`cancel`、`done`、`add_done_callback` 它都有。`set_exception` 之后每个 `await` 都会抛同一个异常，再填一次是 `InvalidStateError`；`cancel()` 让 `await` 抛 `CancelledError`，第二次 `cancel()` 返回 `False`。

最后一个演示是线程。`Future` 不是线程安全的，别的线程不能直接 `set_result`，要通过 `loop.call_soon_threadsafe`（`Lib/asyncio/base_events.py` 第 871 到 883 行）：它把回调放进 `_ready`，然后调 `_write_to_self()`。这个名字让我猜它是往循环自己的一个套接字对里写一个字节，好把睡在 `select` 里的循环叫醒；我没有读 `_write_to_self` 的实现，这一半是猜的。

忘了写 `await` 是最常见的错，它不是语法错误，Python 在协程对象被回收时警告。`forgot_await.py`：

```python
# lab/ch17/forgot_await.py (main trimmed)
async def fetch() -> str:
    """Pretend to fetch something for a second."""
    await asyncio.sleep(1)
    return "data"


async def forgetful() -> float:
    """Call fetch() without await; return the seconds it took."""
    start = time.perf_counter()
    fetch()  # BAD: creates the coroutine and drops it
    return time.perf_counter() - start

# ... main() runs forgetful() under tracemalloc and catches warnings ...
```

```text
$ python3 lab/ch17/forgot_await.py 2> /dev/null
fetch() 'took' 0.021 ms instead of 1000 ms
RuntimeWarning: coroutine 'fetch' was never awaited
warnings captured: 1
-- again, uncaught: the warning goes to stderr, with the
-- traceback of the line that created the coroutine
$ python3 lab/ch17/forgot_await.py 2>&1 > /dev/null | sed "s|$PWD/||"
lab/ch17/forgot_await.py:19: RuntimeWarning: coroutine 'fetch' was never awaited
  fetch()  # BAD: creates the coroutine and drops it
Object allocated at (most recent call last):
  File "lab/ch17/forgot_await.py", lineno 19
    fetch()  # BAD: creates the coroutine and drops it
```

`fetch()` “花了” 0.021 毫秒，因为什么也没跑。`Object allocated at` 那几行只在 `tracemalloc` 开着时才有，没开的话警告只有第一行，提示你去找 `fetch()` 在哪被丢掉的。不运行也能发现这个错：我对同一个文件跑了 `mypy --strict` 和 `pyright`，两个都报了第 19 行。

```text
$ mypy --strict lab/ch17/forgot_await.py
lab/ch17/forgot_await.py:19: error: Value of type "Coroutine[Any, Any, str]" must be used  [unused-coroutine]
lab/ch17/forgot_await.py:19: note: Are you missing an await?
$ pyright lab/ch17/forgot_await.py
  lab/ch17/forgot_await.py:19:5 - error: Result of async function call is not used; use "await" or assign result to variable (reportUnusedCoroutine)
```

`make typecheck` 只检查 `src`，所以这个故意写错的实验脚本不会让它变红。

## 结构化并发：`gather` 与 `TaskGroup`

一个协程要和别的协程同时往前走，就得变成任务：`asyncio.create_task(coro)` 造一个 `Task`，它的第一步排进 `_ready`，下一圈开始跑。`tasks_gather_taskgroup.py` 把三种组织方式放在一起，对比它们在出错时的行为：

```python
# lab/ch17/tasks_gather_taskgroup.py (create_task demo trimmed)
async def work(name: str, seconds: float, fail: bool = False) -> str:
    """Sleep, then return a result or raise."""
    try:
        await asyncio.sleep(seconds)
        if fail:
            raise ValueError(f"{name} failed")
        return f"{name} done"
    except asyncio.CancelledError:
        print(f"    {name} was cancelled")
        raise


async def gather_demo() -> None:
    """gather returns results in argument order."""
    print("-- gather: results in the order of the arguments")
    print(" ", await asyncio.gather(work("slow", 0.2), work("fast", 0.0)))
    # ... then return_exceptions=True: errors become results ...
    print("-- gather without it: first error raised, siblings run on")
    try:
        await asyncio.gather(work("x", 0.0, fail=True), work("y", 0.1))
    except ValueError as error:
        print("  raised", error)
    await asyncio.sleep(0.2)  # y finishes unobserved, never cancelled


async def taskgroup_demo() -> None:
    """A failing child cancels its siblings; errors come grouped."""
    print("-- TaskGroup: one failing child cancels the others")
    try:
        async with asyncio.TaskGroup() as group:
            group.create_task(work("ok", 0.3))
            group.create_task(work("bad", 0.05, fail=True))
            group.create_task(work("bad2", 0.05, fail=True))
    except* ValueError as errors:
        print("  ExceptionGroup:", errors.exceptions)
        print("  message:", errors.message)
    print("-- TaskGroup: all children done, results via .result()")
    async with asyncio.TaskGroup() as group:
        tasks = [group.create_task(work(n, 0.0)) for n in "pq"]
    print(" ", [task.result() for task in tasks])
```

```text
$ python3 lab/ch17/tasks_gather_taskgroup.py
-- create_task: both run at once, 0.2 s in total
  a done and b done
  elapsed 0.20 s
-- gather: results in the order of the arguments
  ['slow done', 'fast done']
-- gather(return_exceptions=True): errors become results
   'a done'
   ValueError('b failed')
   'c done'
-- gather without it: first error raised, siblings run on
  raised x failed
-- TaskGroup: one failing child cancels the others
    ok was cancelled
  ExceptionGroup: (ValueError('bad failed'), ValueError('bad2 failed'))
  message: unhandled errors in a TaskGroup
-- TaskGroup: all children done, results via .result()
  ['p done', 'q done']
```

三个观察。一是两个 0.2 秒的任务一共用了 0.20 秒，因为它们的 `sleep` 同时在定时器堆里。二是 `gather` 不加 `return_exceptions=True` 时，第一个错误被抛给调用者，但 `y` 没有被取消：如果它被取消，`work` 会打印 `y was cancelled`，而输出里没有。它没有被取消，在后台接着跑，没有人等它的结果。这就是“非结构化”的意思：任务的生命期和创建它的那段代码脱钩了。三是 `TaskGroup` 里 `bad` 和 `bad2` 的失败都被收集进了一个 `ExceptionGroup`，`ok` 被取消了，而且 `async with` 块在所有子任务都结束之前不会退出。

`TaskGroup` 的实现不长，我顺着读了一遍 (`Lib/asyncio/taskgroups.py`)。子任务结束时的回调 `_on_task_done`（第 228 到 280 行）把异常记进 `_errors`，如果父任务没有在被取消，就 `_abort()`（第 221 到 226 行，取消所有还没结束的兄弟）并取消父任务本身，这样 `async with` 里正在 `await` 的那一行会收到 `CancelledError`，不会傻等。`__aexit__` 进入 `_aexit`（第 83 行起）后有一个循环，直到 `self._tasks` 空了才往下走：

```python
# Lib/asyncio/taskgroups.py, v3.14.7, lines 116-121 and 166-177
        while self._tasks:
            if self._on_completed_fut is None:
                self._on_completed_fut = self._loop.create_future()

            try:
                await self._on_completed_fut
            # ...
        if self._errors:
            # ...
            try:
                raise BaseExceptionGroup(
                    'unhandled errors in a TaskGroup',
                    self._errors,
                ) from None
```

这就是输出里 `message: unhandled errors in a TaskGroup` 的来源，也是“进了 `async with` 就一定会等齐所有子任务”的保证。`except*` 来自 PEP 654（`Python-Version: 3.11`，状态 `Final`）：它按类型把异常组拆开，`except* ValueError` 拿到的是只含 `ValueError` 的子组，所以我才能对 `errors.exceptions` 迭代。顺带一提，Sift 的服务器里有一处 `except TimeoutError, OSError:`（`raw.py` 第 476 行），不加括号，这是 PEP 758（`Python-Version: 3.14`，`Final`）；PEP 文本里说的限制是用了 `as` 就必须加括号。

## 取消与超时

asyncio 里的取消，就是在任务停着的那个 `await` 处抛一个 `CancelledError`。`Task.cancel`（`Lib/asyncio/tasks.py` 第 183 到 223 行）自己的文档字符串说得很直白：它只是“请求”任务取消，协程可以 `except` 掉它，推迟甚至拒绝；任务只有在协程以 `CancelledError` 结束时才被标记为已取消（第 197 到 201 行）。`timeouts_cancellation.py` 把这几个后果都演了一遍：

```python
# lab/ch17/timeouts_cancellation.py (shield demo and main trimmed)
async def slow(name: str, seconds: float = 1.0) -> str:
    """Sleep for seconds, and report if cancelled on the way."""
    try:
        await asyncio.sleep(seconds)
        return f"{name} finished"
    except asyncio.CancelledError:
        print(f"    {name}: CancelledError raised at the await")
        raise  # always re-raise, or the cancel is swallowed
    finally:
        print(f"    {name}: cleanup runs")


async def timeout_demo() -> None:
    """asyncio.timeout cancels the block, then raises TimeoutError."""
    print("-- asyncio.timeout(0.1) around a 1 s sleep")
    try:
        async with asyncio.timeout(0.1):
            await slow("job")
    except TimeoutError:
        print("  TimeoutError, the block was cancelled")
    print("-- wait_for is the one-call form")
    try:
        await asyncio.wait_for(slow("job2"), timeout=0.1)
    except TimeoutError:
        print("  TimeoutError")


async def cancel_demo() -> None:
    """task.cancel() asks; the task decides when it stops."""
    print("-- task.cancel()")
    task = asyncio.create_task(slow("victim"))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        print(
            "  await task raised CancelledError, cancelled():",
            task.cancelled(),
        )
    print("-- swallowing it is a bug: the task looks finished")

    async def swallow() -> str:
        try:
            await asyncio.sleep(1)
        except asyncio.CancelledError:
            return "swallowed"  # BAD
        return "not reached"
    # ... cancels a task running swallow() and prints the result ...
```

```text
$ python3 lab/ch17/timeouts_cancellation.py
-- asyncio.timeout(0.1) around a 1 s sleep
    job: CancelledError raised at the await
    job: cleanup runs
  TimeoutError, the block was cancelled
-- wait_for is the one-call form
    job2: CancelledError raised at the await
    job2: cleanup runs
  TimeoutError
-- task.cancel()
    victim: CancelledError raised at the await
    victim: cleanup runs
  await task raised CancelledError, cancelled(): True
-- swallowing it is a bug: the task looks finished
  result: swallowed cancelled(): False
-- shield: the waiter is cancelled, the work is not
  waiter cancelled; inner done: False
    inner: cleanup runs
  inner finished
```

`asyncio.timeout` 做的事在 `Lib/asyncio/timeouts.py` 里一目了然。进入时 `reschedule` 用 `loop.call_at` 排一个 `_on_timeout`；时间到了，`_on_timeout`（第 126 到 131 行）对当前任务调 `cancel()` 并把状态改成 `EXPIRING`；块里的 `await` 收到 `CancelledError`，`finally` 清理，异常一路冒到 `__aexit__`，它发现状态是 `EXPIRING`，并且 `uncancel()` 之后的取消计数没有超过进入时的值（说明没有别人也在取消这个任务），就把 `CancelledError` 换成 `TimeoutError`（第 108 到 115 行）。所以 `TimeoutError` 是“被我自己的超时取消了”的翻译，不是另一种失败。`wait_for` 在 3.14 里除了超时小于等于 0 的特例，剩下就是 `async with timeouts.timeout(timeout): return await fut`（`Lib/asyncio/tasks.py` 第 487 到 488 行），我在输出里看到两种写法的现象一样，和源码对得上。

`swallow` 是我故意写的 `# BAD`：吃掉 `CancelledError` 并正常返回，任务就“成功”了，`cancelled()` 是 `False`，调用者以为它没被取消。后果在 `TaskGroup` 和 `timeout` 里更严重，因为它们靠取消计数判断“是我取消的还是别人取消的”，一个吞掉取消的子任务会让 `timeout` 的 `__aexit__` 没机会转换。最后这一句是我读 `__aexit__` 的推断，没有写实验去复现。

`shield` 是反过来的：外层的等待者被取消，里层的任务继续。输出里 `waiter cancelled; inner done: False`，随后 `inner: cleanup runs`，`inner finished`，里层确实跑完了。要小心的是 `asyncio.run` 退出时 `_cancel_all_tasks`（`Lib/asyncio/runners.py` 第 208 到 216 行）会取消所有还没完成的任务，包括被 `shield` 保护过的，所以 `shield` 只能挡住“这个等待者被取消”，挡不住事件循环关闭。这点我是读 `runners.py` 读来的，没有写一个实验去看 `shield` 的任务在 `asyncio.run` 退出时是不是真被取消了。

## 异步迭代器、异步生成器与异步上下文管理器

`async for` 每取一个元素就是一次 `await`（对 `__anext__()`），所以取下一个元素的过程中可以让出事件循环。`async with` 的 `__aenter__` 和 `__aexit__` 也一样可以 `await`。`async_iter_ctx.py` 把它们都过一遍：

```python
# lab/ch17/async_iter_ctx.py (Countdown, Connection and main trimmed)
async def ticker(count: int, delay: float) -> AsyncIterator[int]:
    """Yield 0 to count - 1, pausing delay seconds before each."""
    try:
        for i in range(count):
            await asyncio.sleep(delay)
            yield i
    finally:
        print("    ticker closed")


@asynccontextmanager
async def transaction(name: str) -> AsyncIterator[str]:
    """The same idea as a generator: code before and after yield."""
    print(f"    begin {name}")
    try:
        yield name
    except ValueError:
        print(f"    rollback {name}")
        raise
    else:
        print(f"    commit {name}")


async def main() -> None:
    """Use each of them."""
    print("-- async for over an async generator")
    async for number in ticker(3, 0.01):
        print("   ", number)
    print("-- break, then aclosing() closes the generator")
    async with aclosing(ticker(5, 0.01)) as stream:
        async for number in stream:
            if number == 1:
                break
    # ... Countdown, a comprehension, anext(), Connection ...
    print("-- asynccontextmanager, commit and rollback")
    async with transaction("t1"):
        pass
    try:
        async with transaction("t2"):
            raise ValueError("boom")
    except ValueError:
        print("    error reached the caller")
```

```text
$ python3 lab/ch17/async_iter_ctx.py
-- async for over an async generator
    0
    1
    2
    ticker closed
-- break, then aclosing() closes the generator
    ticker closed
-- an async iterator class
    [3, 2, 1]
-- async comprehension with a condition, and anext()
    ticker closed
    [0, 2, 4]
    anext: 0 1
    ticker closed
-- async with
    connection open
    using it
    connection closed
-- asynccontextmanager, commit and rollback
    begin t1
    commit t1
    begin t2
    rollback t2
    error reached the caller
```

异步生成器来自 PEP 525（`Python-Version: 3.6`，`Final`）。读输出时有一处要对照代码：第二段 `break` 之后 `ticker closed` 是在 `async with aclosing(...)` 退出时打印的，因为 `aclosing` 的 `__aexit__` 里调了 `aclose()`，生成器的 `finally` 这时才运行。不套 `aclosing` 的话，`break` 以后生成器只是被丢在那里，`finally` 要等垃圾回收或者 `asyncio.run` 收尾时的 `shutdown_asyncgens` 才会运行，具体是哪一个、什么时候，我没有单独测，所以这是读文档的印象。`transaction` 的写法和同步的 `contextlib.contextmanager` 一模一样，`yield` 之前是 `__aenter__`，`yield` 之后是 `__aexit__`，异常从 `yield` 那里抛出来，`except` 分支就是回滚。

## 队列、信号量和锁

单线程不等于没有竞态。第 16 篇里一个线程可以在任意两条字节码之间被换走；协程只会在 `await` 处被换走，所以窗口小得多，但“读、让出、写”这种形状照样丢更新。`queues_semaphores.py` 里有三个演示，最后一个是故意让它出错的：

```python
# lab/ch17/queues_semaphores.py (semaphore demo and Event trimmed)
async def producer(queue: asyncio.Queue[int], count: int) -> None:
    """Put count items; put() waits when the queue is full."""
    for i in range(count):
        await queue.put(i)
    queue.shutdown()  # new in 3.13: consumers see QueueShutDown


async def consumer(
    name: str, queue: asyncio.Queue[int], seen: dict[str, list[int]]
) -> None:
    """Take items until the queue is shut down and empty."""
    while True:
        try:
            item = await queue.get()
        except asyncio.QueueShutDown:
            return
        await asyncio.sleep(0.01)
        seen[name].append(item)
        queue.task_done()


async def lock_event_demo() -> None:
    """Show a Lock around a read-modify-write, and an Event."""
    print("-- Lock around a read-modify-write that awaits")
    counter = 0
    lock = asyncio.Lock()

    async def bump(use_lock: bool) -> None:
        nonlocal counter
        if use_lock:
            async with lock:
                value = counter
                await asyncio.sleep(0)
                counter = value + 1
        else:
            value = counter
            await asyncio.sleep(0)
            counter = value + 1  # BAD: another task ran in between
    # ... runs 100 bump tasks per variant, then the Event demo ...
```

```text
$ python3 lab/ch17/queues_semaphores.py
-- Queue(maxsize=2): backpressure on the producer
  consumer a took [0, 3, 6]
  consumer b took [1, 4, 7]
  consumer c took [2, 5, 8]
  all 9 taken once: True
-- Semaphore(3) around 10 jobs
  most tasks inside at once: 3
-- Lock around a read-modify-write that awaits
  lock=False counter = 1 of 100
  lock=True  counter = 100 of 100
-- Event: one task waits for a signal
  before set: done = False
  after set: released
```

`Queue(maxsize=2)` 满了以后 `put` 会等，生产者因此不可能跑到消费者前面太远，这是“背压”，也是我在服务器里想用有界队列而不是无界列表的理由。`queue.shutdown()` 是 3.13 加的（`Doc/library/asyncio-queue.rst` 里标了 `versionadded:: 3.13`），消费者收到 `QueueShutDown` 就知道不会再有新活了，不需要再塞哨兵值。三个消费者拿到的是 `[0, 3, 6]`、`[1, 4, 7]`、`[2, 5, 8]`，这个整齐的轮转是这一次的输出，我没有查文档是否保证这个顺序，别当成规范。

最后一个演示最有教育意义：100 个任务各读一次 `counter`，然后 `await asyncio.sleep(0)` 让出，再写回 `value + 1`。没有锁时，100 个任务都在别人写之前读到了 0，最后全写成 1，结果是 `counter = 1 of 100`，丢了 99 次；加上 `asyncio.Lock` 后是 100。文档说这些原语都不是线程安全的（`Doc/library/asyncio-sync.rst` 第 16 行），它们保护的是任务之间的次序，不是线程之间的内存。

## 在循环里阻塞：`to_thread` 与调试模式

回到开头那两行输出。事件循环像一家只有一个服务员的餐厅：他可以同时照看一百桌，只要他从不站在某一桌旁边等；`time.sleep` 是他站在厨房门口干等了 0.3 秒，`to_thread` 是让后厨去等，他接着跑堂。比喻到此为止，下面是数字。`blocking_in_loop.py` 在事件循环里放一个每 10 毫秒记一次时间的心跳，然后分别用 `time.sleep(0.3)` 和 `to_thread` 去“干活”：

```python
# lab/ch17/blocking_in_loop.py (debug demo and main trimmed)
BLOCK = 0.3  # seconds a coroutine holds the loop
BEAT = 0.01  # seconds between two heartbeats


async def heartbeat(gaps: list[float]) -> None:
    """Record how long each sleep(BEAT) really took."""
    loop = asyncio.get_running_loop()
    last = loop.time()
    while True:
        await asyncio.sleep(BEAT)
        now = loop.time()
        gaps.append(now - last)
        last = now


async def blocking() -> None:
    """BAD: time.sleep holds the thread, so the loop cannot run."""
    time.sleep(BLOCK)


async def threaded() -> None:
    """Move the blocking call to a worker thread."""
    await asyncio.to_thread(time.sleep, BLOCK)


async def stall(work: Callable[[], Awaitable[None]]) -> float:
    """Run work next to a heartbeat; return the longest gap in ms."""
    gaps: list[float] = []
    beat = asyncio.create_task(heartbeat(gaps))
    await asyncio.sleep(0.05)  # let the heartbeat settle
    await work()
    await asyncio.sleep(0.05)
    beat.cancel()
    return max(gaps) * 1000
```

我把整个脚本连跑三次，前后夹 `cpu_state.py`：

```text
$ python3 /tmp/sift-scratch/cpu_state.py; for i in 1 2 3; do \
>     python3 lab/ch17/blocking_in_loop.py | sed -n 2,3p; done; \
>     python3 /tmp/sift-scratch/cpu_state.py
111 111 111 111 128 ms
time.sleep in a coroutine: longest gap  310.5 ms
asyncio.to_thread        : longest gap   10.9 ms
time.sleep in a coroutine: longest gap  309.3 ms
asyncio.to_thread        : longest gap   12.5 ms
time.sleep in a coroutine: longest gap  310.7 ms
asyncio.to_thread        : longest gap   11.2 ms
170 171 138 113 113 ms
```

阻塞版本的最长间隔是 309.3 到 310.7 毫秒，也就是 0.3 秒加一次心跳；线程版本是 10.9 到 12.5 毫秒，比 10 毫秒的节拍多出 1 到 2.5 毫秒的调度抖动。收尾那次 `cpu_state` 出了 170 171 138，是前面说的零星偏高之一，下一次就是 113，三次计时都是在它之前跑的。

`to_thread` 只有四条语句（`Lib/asyncio/threads.py` 第 23 到 26 行）：

```python
# Lib/asyncio/threads.py, v3.14.7, lines 23-26
    loop = events.get_running_loop()
    ctx = contextvars.copy_context()
    func_call = functools.partial(ctx.run, func, *args, **kwargs)
    return await loop.run_in_executor(None, func_call)
```

`run_in_executor(None, ...)` 用循环的默认执行器，第一次用到时才建一个 `ThreadPoolExecutor`（`Lib/asyncio/base_events.py` 第 885 到 899 行）。默认的线程数公式在 `Lib/concurrent/futures/thread.py` 第 181 行：`min(32, (os.process_cpu_count() or 1) + 4)`，这台机器上是 20（`_max_workers` 是私有属性，我用下面的命令看了一眼，循环建的执行器除了线程名前缀，用的是同一个默认值）：

```text
$ python3 -c "import concurrent.futures as c; \
> print(c.ThreadPoolExecutor()._max_workers)"
20
```

这个上限后面有用：100 个并发搜索请求同时到达，只有 20 个会进入线程，其余在执行器的队列里排队。

`to_thread` 只是 `run_in_executor` 的一个方便包装，真正的接口是后者：可以传自己的执行器，线程池或者进程池都行。`executors.py` 把几种写法放在一起，同时看看上下文变量跟不跟过去：

```python
# lab/ch17/executors.py (imports, helpers, process demo, main cut)
async def thread_demo() -> None:
    """Four sleeps of 0.2 s on different thread pools."""
    loop = asyncio.get_running_loop()
    print("-- four time.sleep(0.2) calls")
    await timed(
        "run_in_executor(None, ...)  default pool",
        *(loop.run_in_executor(None, time.sleep, 0.2) for _ in range(4)),
    )
    with ThreadPoolExecutor(2) as pool:
        await timed(
            "run_in_executor(pool of 2, ...)",
            *(loop.run_in_executor(pool, time.sleep, 0.2) for _ in range(4)),
        )
    await timed(
        "asyncio.to_thread (the default pool again)",
        *(asyncio.to_thread(time.sleep, 0.2) for _ in range(4)),
    )


# ... process_demo: pid_and_square runs in a ProcessPoolExecutor ...


async def context_demo() -> None:
    """Which thread sees the ContextVar of the coroutine?"""
    loop = asyncio.get_running_loop()
    request_id.set("req-1")
    print("-- ContextVar set to 'req-1' before the call")
    print(
        "  run_in_executor sees:",
        await loop.run_in_executor(None, read_request_id),
    )
    print("  to_thread sees      :", await asyncio.to_thread(read_request_id))
    copied = contextvars.copy_context()
    print(
        "  run_in_executor(ctx.run, ...) sees:",
        await loop.run_in_executor(None, copied.run, read_request_id),
    )
```

脚本的 `main()` 先打印构建信息，再依次跑 `context_demo`、`thread_demo`、`process_demo`。`executors_ft.py` 只有一个 `import` 加一个 `asyncio.run`，让同一份代码跑在 `python3.14t` 上：

```text
$ python3 lab/ch17/executors.py
python 3.14.7, GIL enabled: True
sys.flags.thread_inherit_context: 0
-- ContextVar set to 'req-1' before the call
  run_in_executor sees: -
  to_thread sees      : req-1
  run_in_executor(ctx.run, ...) sees: req-1
-- four time.sleep(0.2) calls
  run_in_executor(None, ...)  default pool: 0.2 s
  run_in_executor(pool of 2, ...): 0.4 s
  asyncio.to_thread (the default pool again): 0.2 s
-- ProcessPoolExecutor(2)
  squares: [9, 16]
  ran in another process: True
$ python3.14t lab/ch17/executors_ft.py
python 3.14.7, GIL enabled: False
sys.flags.thread_inherit_context: 1
-- ContextVar set to 'req-1' before the call
  run_in_executor sees: req-1
  to_thread sees      : req-1
  run_in_executor(ctx.run, ...) sees: req-1
-- four time.sleep(0.2) calls
  run_in_executor(None, ...)  default pool: 0.2 s
  run_in_executor(pool of 2, ...): 0.4 s
  asyncio.to_thread (the default pool again): 0.2 s
-- ProcessPoolExecutor(2)
  squares: [9, 16]
  ran in another process: True
```

三个观察。一，默认池 4 个 0.2 秒的 `sleep` 一共 0.2 秒，因为 4 个线程同时睡；只有 2 个线程的池要 0.4 秒，两批；`to_thread` 又回到默认池，0.2 秒。二，`ProcessPoolExecutor` 的函数跑在另一个进程里（`pid` 不同），参数和返回值都要能 pickle，CPU 活该用它，第 16 篇讲过代价。三，上下文：带 GIL 的 `python3` 上，裸 `run_in_executor` 里读到的是默认值 `-`，`to_thread` 读到 `req-1`，手动 `copy_context().run` 也读到 `req-1`；在 `python3.14t` 上三种写法都读到 `req-1`，因为自由线程构建的 `sys.flags.thread_inherit_context` 默认是 1，新线程会拷贝创建者的上下文（`Doc/whatsnew/3.14.rst` 第 503 到 509 行）。

这里有个顺序陷阱，`executors.py` 的注释里写了：线程池的线程是第一个任务创建的，创建时拷贝（或不拷贝）当时的上下文，之后一直沿用。所以 `main()` 把 `context_demo` 放在最前面。我把顺序换过来试了一次（`thread_demo` 先跑），`python3.14t` 上裸 `run_in_executor` 读到的就变成了 `-`：池里的线程在 `request_id` 设上之前就建好了，带着空的上下文。这个现象我只在一份临时改过顺序的拷贝上看到，没有留成脚本。

调试模式能直接指出谁卡住了循环。`PYTHONASYNCIODEBUG=1` 打开后，`_run_once` 走的是带计时的那一支（上面引用的第 2045 到 2055 行），某个回调超过 `slow_callback_duration`（第 438 行初始化为 `0.1` 秒）就记一条警告。脚本里的 `debug_demo` 用环境变量重跑自己，把那一行挑出来（路径里的 Nix 存储前缀我用 `sed` 换成了 `<stdlib>`）：

```text
$ python3 lab/ch17/blocking_in_loop.py | sed -n 4,5p | \
>     sed "s|/nix/store/[^ ]*/lib/python3.14/|<stdlib>/|"
-- PYTHONASYNCIODEBUG=1 names the slow callback:
  WARNING asyncio: Executing <Task finished name='Task-1' coro=<blocking() done, defined at lab/ch17/blocking_in_loop.py:26> result=None created at <stdlib>/asyncio/runners.py:110> took 0.301 seconds
```

它指到了任务、协程名和定义它的文件行号，是“谁”卡住循环的最快线索。它的代价（调试模式下每个回调都要计时、任务创建要记栈）我没有量，别在压测的时候开它。

## `contextvars`：请求号怎么跟着任务走

服务器里每个请求都想带一个请求号进日志，线程里可以用 `threading.local`，协程里一个线程跑很多个请求，不行。`contextvars` 就是为这个做的（PEP 567，`Python-Version: 3.7`，`Final`）。`contextvars_demo.py`：

```python
# lab/ch17/contextvars_demo.py (main trimmed)
request_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id", default="-"
)


class RequestIdFilter(logging.Filter):
    """Stamp every log record with the current request id."""

    def filter(self, record: logging.LogRecord) -> bool:
        """Add record.request_id; keep the record."""
        record.request_id = request_id.get()
        return True


def blocking_step() -> str:
    """Run in a worker thread: the context was copied there."""
    return f"thread sees {request_id.get()}"


async def child() -> str:
    """Read the id set by whoever created this task."""
    await asyncio.sleep(0)
    return f"child sees {request_id.get()}"


async def handle(name: str) -> list[str]:
    """Set the id, then call a task, a thread and a log line."""
    request_id.set(name)
    logging.getLogger("demo").info("handling")
    lines = [await asyncio.create_task(child())]
    lines.append(await asyncio.to_thread(blocking_step))
    lines.append(f"{name} still has {request_id.get()}")
    return lines


async def writer() -> str:
    """Set the id inside a task: the parent never sees it."""
    request_id.set("set-in-task")
    return request_id.get()
```

```text
$ python3 lab/ch17/contextvars_demo.py
  [-] before any request
  [req-1] handling
  [req-2] handling
  child sees req-1
  thread sees req-1
  req-1 still has req-1
  child sees req-2
  thread sees req-2
  req-2 still has req-2
-- a task works on a copy of the context
  task set: set-in-task
  parent has: -
  after reset(token): -
```

（日志行走标准错误，`print` 走标准输出。我是把输出接到管道里跑的，标准输出按块缓冲，所以三行日志排在最前面；直接在终端里跑，两者的先后可能不同，我没有试。）

`req-1` 和 `req-2` 同时在一个线程里交错运行，各自的日志行、子任务和工作线程看到的请求号都是自己的。机制有三处：`Task` 创建时拷贝一份当前的上下文（`Lib/asyncio/tasks.py` 第 105 行）；事件循环调回调用的是 `self._context.run(...)`（前面引用的 `events.py` 第 92 到 94 行），所以任务的每一步都在自己的上下文里跑；`to_thread` 自己 `copy_context()` 再用 `ctx.run` 在线程里调函数（上面的 `threads.py`）。这也说明了 `writer` 任务里的 `set` 为什么不会漏到父任务：它改的是拷贝。`ContextVar.set` 返回的 `token` 可以用 `reset` 还原，最后一行就是这个。

线程这一头就是上一节 `executors.py` 的结果：带 GIL 的 `python3` 上，线程池里的线程不会自动继承你的上下文，裸 `run_in_executor` 读到默认值，`to_thread` 替你做了拷贝；`python3.14t` 上默认继承，三种写法都读到 `req-1`。写要在两个构建上都对的代码，就用 `to_thread`，或者像脚本里那样自己 `copy_context().run`。

## 流：一个连接一个协程

前面都是玩具，服务器要用的是 asyncio 的流。`asyncio.start_server(cb, host, port, limit=...)` 只有几行（`Lib/asyncio/streams.py` 第 76 到 84 行）：造一个 `StreamReader` 和一个 `StreamReaderProtocol`，交给 `loop.create_server`。一个连接到来时的路径是这样的：循环里监听套接字可读，`_accept_connection`（`Lib/asyncio/selector_events.py` 第 167 到 215 行）在一圈里最多 `backlog + 1` 次 `accept()`，每接到一个就 `create_task` 一个 `_accept_connection2`；它建好 transport 后调协议的 `connection_made`，后者调你的回调，如果回调是协程，就再把它包成任务（`Lib/asyncio/streams.py` 第 241 到 259 行，第 258 行是 `self._task = self._loop.create_task(res)`）。

所以这里的对应关系是：线程版的“一个连接一个线程”，变成了“一个连接一个任务”。一个任务比一个线程便宜多少我没有量，但我量过的是上一节的 `selectors_loop.py`：5 个客户端，一个线程。

读请求头用的是 `readuntil`，我把它的行为读了一遍（`Lib/asyncio/streams.py` 第 581 到 693 行）：

```python
# Lib/asyncio/streams.py, v3.14.7, lines 668-672 and 686-693 (trimmed,
# the call on line 688 is wrapped to fit)
                offset = max(0, buflen + 1 - max_seplen)
                if offset > self._limit:
                    raise exceptions.LimitOverrunError(
                        'Separator is not found, and chunk exceed the limit',
                        offset)
            # ...
        if match_start > self._limit:
            raise exceptions.LimitOverrunError(
                'Separator is found, but chunk is longer than limit',
                match_start)

        chunk = self._buffer[:match_end]
        del self._buffer[:match_end]
        self._maybe_resume_transport()
        return bytes(chunk)
```

三种结果：找到分隔符且分隔符之前的数据不超过 `limit`，返回（含分隔符）；缓冲里还没有分隔符而已超过 `limit`，抛 `LimitOverrunError`；连接在找到之前就关了，抛 `IncompleteReadError`，它的 `partial` 属性是已收到的字节（第 678 到 681 行）。`limit` 默认是 64 KiB（第 23 行）。`raw.py` 把它设成 `MAX_HEAD - len(END_OF_HEAD)`，也就是 16 KiB 减去分隔符的 4 个字节，这样“请求头加上空行一共不超过 16 KiB”正好是边界。测试里有这个边界：`test_a_head_just_under_the_limit_is_served` 发一个正好 16 KiB 的头得到 200，多一个字节得到 400，`test_a_huge_head_gets_400_and_the_client_can_read_it` 发 128 KiB 的头，客户端读得到 400。

写的一头是 `writer.write(data)` 加 `await writer.drain()`。`write` 不会等；`drain`（第 366 到 389 行）在 transport 的写缓冲超过高水位时才真的挂起，这是给慢客户端的背压。关闭是 `writer.close()` 加 `await writer.wait_closed()`。

## HTTP/1.1 报文：一次请求长什么样

HTTP/1.1 是一段文本。请求是一行请求行 (`GET /health HTTP/1.1`)，若干行 `名字: 值` 的头，然后一个空行；响应是状态行、头、空行、正文。每一行以 CRLF (`\r\n`) 结束。响应怎么知道正文到哪儿为止，靠头里的 `Content-Length`。`Connection: close` 的意思是“这一次响应之后我就关连接”（RFC 9112 第 9.6 节：发送方打算关连接时应当发这个选项，收到它的服务器在发完最终响应后必须开始关闭连接）。Sift 的服务器每个响应都带它，一个连接只处理一个请求，客户端读到 EOF 就知道完了，不需要处理流水线，也不会把一个没读的请求体当成下一个请求。请求体本身不解析：声明了 `Content-Length` 或 `Transfer-Encoding` 的请求，服务器答完后先半关闭，再把还在来的输入读掉丢掉，最多读 `LINGER`（1 秒），然后才关连接。为什么要这样，后面讲关连接时有实验；1 秒到了客户端还在发的话，仍然可能收到复位，这是这个办法的边界。

比读规范更快的办法是直接跟它说话。`http_session.sh` 起一个 `sift serve --raw`，一部分用 `curl`，一部分用 bash 的 `/dev/tcp` 把原始字节写进去：

```bash
#!/usr/bin/env bash
# Start sift serve --raw and talk to it with curl and raw bytes.
set -u
work=$(mktemp -d)
export SIFT_INDEX="$work/idx"
sift index --corpus corpus/posts > /dev/null
sift serve --raw --port 0 > "$work/out" 2> "$work/err" &
pid=$!
until grep -q '^listening on ' "$work/out"; do sleep 0.1; done
base=$(sed 's/^listening on //' "$work/out")
port=${base##*:}

title() { printf '\n== %s\n' "$*"; }

# send: copy stdin to the port, print what comes back (2 s at most).
send() {
    exec 3<> "/dev/tcp/127.0.0.1/$port"
    cat >&3
    timeout 2 cat <&3
    exec 3>&-
}

# brief: keep the status line, an Allow header and the JSON body.
brief() { tr -d '\r' | sed -n '1p;/^Allow:/p;/^{/p' | cut -c1-100; }

title "banner"
cat "$work/out"
title "the bytes of GET /health, CR shown as ^M"
printf 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' | send | cat -A
title "HEAD /health: the same head, no body"
curl -sI "$base/health" | tr -d '\r'
title "a search, and a POST"
curl -si "$base/search?q=asyncio&limit=1" | brief
curl -si -X POST "$base/search" | brief
title "no Host header, and a Host that is not this machine"
printf 'GET /health HTTP/1.1\r\n\r\n' | send | brief
curl -si -H 'Host: evil.example' "$base/health" | brief
title "a bare LF inside a head that ends in CRLF CRLF"
printf 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\nX: y\r\n\r\n' | send | brief
title "20000 bytes of header"
{
    printf 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nX: '
    head -c 20000 /dev/zero | tr '\0' a
    printf '\r\n\r\n'
} | send | brief
title "POST with a 5 MB body: the 405 still arrives"
{
    printf 'POST /search HTTP/1.1\r\nHost: 127.0.0.1\r\n'
    printf 'Content-Length: 5000000\r\n\r\n'
    head -c 5000000 /dev/zero
} | send | brief
title "an all-LF request: the head never ends, the client gives up"
printf 'GET /health HTTP/1.1\nHost: 127.0.0.1\n\n' | send | brief
kill -TERM "$pid"
wait "$pid"
title "exit status after SIGTERM: $?"
title "the last two lines the server logged"
sed 's/^[0-9-]* [0-9:,.]* //' "$work/err" | tail -n 2
rm -rf "$work"
```

```text
$ nix develop --command bash /tmp/sift-scratch/http_session.sh
== banner
listening on http://127.0.0.1:41479

== the bytes of GET /health, CR shown as ^M
HTTP/1.1 200 OK^M$
Date: Sat, 24 Oct 2026 23:36:29 GMT^M$
Content-Type: application/json; charset=utf-8^M$
Content-Length: 29^M$
Connection: close^M$
^M$
{"status": "ok", "docs": 123}
== HEAD /health: the same head, no body
HTTP/1.1 200 OK
Date: Sat, 24 Oct 2026 23:36:29 GMT
Content-Type: application/json; charset=utf-8
Content-Length: 29
Connection: close


== a search, and a POST
HTTP/1.1 200 OK
{"query": "asyncio", "total": 1, "took_ms": 16.471467999508604, "hits": [{"doc_id": 75, "title": "操作
HTTP/1.1 405 Method Not Allowed
Allow: GET, HEAD
{"error": "method POST not allowed"}

== no Host header, and a Host that is not this machine
HTTP/1.1 400 Bad Request
{"error": "missing Host header"}
HTTP/1.1 400 Bad Request
{"error": "Host not allowed"}

== a bare LF inside a head that ends in CRLF CRLF
HTTP/1.1 400 Bad Request
{"error": "bare CR or LF in the request head"}

== 20000 bytes of header
HTTP/1.1 400 Bad Request
{"error": "request head too large"}

== POST with a 5 MB body: the 405 still arrives
HTTP/1.1 405 Method Not Allowed
Allow: GET, HEAD
{"error": "method POST not allowed"}

== an all-LF request: the head never ends, the client gives up

== exit status after SIGTERM: 0

== the last two lines the server logged
INFO sift.server.raw: 127.0.0.1:55562 POST /search 405 36B 1.3ms
INFO sift.server.raw: 127.0.0.1:55578 - 400 36B 2004.0ms
```

输出里（`nix develop` 的横幅行我去掉了）有几处值得停下来看。`cat -A` 把 CR 显示成 `^M`，每行头和空行都以 `^M$` 结尾，这就是 CRLF。`HEAD` 的头和 `GET` 一样，`Content-Length: 29` 也在，只是没有那 29 个字节的正文（RFC 9110 第 9.3.2 节）。`POST` 得到 405 并带 `Allow: GET, HEAD`，规范要求 405 必须带 `Allow`（RFC 9110 第 15.5.6 节）。没有 `Host` 的 HTTP/1.1 请求得到 400（RFC 9112 第 3.2 节要求如此）。`Host: evil.example` 也是 400，消息是 `Host not allowed`：服务器绑在回环地址上时只认 `127.0.0.1`、`localhost`、`[::1]`（可带端口），这是为了挡 DNS 重绑定，让网页不能借自己的域名去连本机的服务器；绑在别的地址上就不检查。带 5 MB 请求体的 `POST` 仍然拿到完整的 405，这是排空输入的效果。日志每个请求一行，我用 `sed` 去掉了时间戳；没解析出请求行的（头太大、头不完整），请求行就是 `-`。

最后几个是我故意挑的“严格”选择。一，RFC 9112 第 2.2 节允许接收方把单独的 LF 当行结束符，这个服务器不允许：头只在 `\r\n\r\n` 处结束，头里出现单独的 `\r` 或 `\n` 就是 400（输出里 `a bare LF inside a head` 那一段）。二，全是 LF 的请求，头永远不结束，服务器就一直等：脚本里 `timeout 2 cat` 两秒后放弃，服务器看到连接关闭、手里有半截数据，记了一条 400（最后一行日志，耗时 2004.0 毫秒）；客户端不走的话，`READ_TIMEOUT`（10 秒）一到服务器就不回答直接关连接，契约里是这么写的，这一条我是读 `raw.py` 和 `test_a_silent_client_is_dropped_and_not_logged` 得到的，没有等满 10 秒。三，RFC 9112 第 3 节说宽松解析在多个接收者各有解释时会带来请求走私 (request smuggling)；手写解析器最容易犯的错就是“宽松一点”，所以我选了严格，这是设计选择，不是规范的要求。

## `sift serve --raw`：把搜索放到手写的服务器后面

`src/sift/server/raw.py` 有 730 行，开头 93 行是模块文档字符串里写的契约（路由、状态码、拒绝请求的条件、几道上限、安全说明），其余是实现。我挑五处讲。

第一处是解析。`parse_head` 拿到一整段请求头的字节（含最后的空行），要么返回 `Request`，要么抛 400，没有第三种结果：

```python
# src/sift/server/raw.py, lines 271-312 (header loop trimmed)
def parse_head(head: bytes) -> Request:
    """Parse a request head (up to and with the blank line).

    Raise HttpError(400) if it breaks the rules of the module
    docstring.
    """
    try:
        text = head.decode("ascii")
    except UnicodeDecodeError:
        raise _bad("request head is not ASCII") from None
    lines = text.removesuffix("\r\n\r\n").split("\r\n")
    if any("\r" in line or "\n" in line for line in lines):
        raise _bad("bare CR or LF in the request head")
    method, target, version = _parse_request_line(lines[0])
    head_only = method == "HEAD"
    if len(lines) - 1 > MAX_HEADERS:
        raise _bad("too many headers", head_only=head_only)
    headers: dict[str, str] = {}
    for line in lines[1:]:
        name, colon, value = line.partition(":")
        value = value.strip(" \t")
        if not colon or not _TOKEN.fullmatch(name):
            raise _bad("malformed header line", head_only=head_only)
        # ... value check, lower-casing, repeated Host, merging ...
    if version == "HTTP/1.1" and not headers.get("host"):
        raise _bad("missing Host header", head_only=head_only)
    path, _, rest = target.partition("#")[0].partition("?")
    return Request(
        method,
        target,
        path,
        version,
        headers,
        _parse_params(rest, head_only),
    )
```

`name` 要匹配 `_TOKEN` 正则，所以 `Host : x`（冒号前有空格）不是合法的头名，会得到 `malformed header line`，这正是 RFC 9112 第 5.1 节要求服务器拒绝的情形（冒号前不许有空白）；折行的头（obs-fold，下一行以空白开头）同理：续行没有冒号，也是 400，规范（第 5.2 节）允许 400 或替换成空格，这里选了前者。`test_parse_rejects_with_400` 里这两种写法各有一个用例，期望的消息都是 `malformed header line`。HEAD 请求的错误响应也不带正文，所以每个 `_bad` 都要带着 `head_only`。

第二处是读头，三个 `except` 控制了三种失败：

```python
# src/sift/server/raw.py, lines 518-532
    async def _read_head(self, reader: asyncio.StreamReader) -> bytes | None:
        """Read one head; None if the client left without a byte."""
        try:
            async with asyncio.timeout(self.read_timeout):
                return await reader.readuntil(END_OF_HEAD)
        except asyncio.IncompleteReadError as error:
            if not error.partial:
                return None
            raise _bad("incomplete request head") from None
        except asyncio.LimitOverrunError:
            raise HttpError(
                HTTPStatus.BAD_REQUEST,
                "request head too large",
                unread=True,
            ) from None
```

`asyncio.timeout(10)` 管“客户端连上了但不把头说完”（慢速攻击的最简单形式，也是上面那个全 LF 请求的下场），`IncompleteReadError` 管“说了一半就走了”，`LimitOverrunError` 管“头大得不像话”。第三个带 `unread=True`，意思是“还有输入没读，别急着关”，原因在第四处。

第三处是搜索，也是这个服务器改得最多的一处。`Searcher` 里有一个 `LRUCache`，它的文档字符串写着不是线程安全的（`src/sift/cache.py` 第 13 到 15 行）；搜索又是 CPU 活，直接在协程里算会像开头那个 `time.sleep` 一样卡住循环。所以搜索放进线程池，线程里用一把锁保证同一时间只有一个搜索在跑。第一版我用的是 `to_thread`，后来发现这样不行：线程池的队列没有上限，一把锁后面可以排任意多个搜索，而且一个搜索一旦交给线程就停不下来，即使发请求的客户端早就挂了。现在的版本是这样：

```python
# src/sift/server/raw.py, lines 384-395, 422-447 and 461-463 (trimmed)
    def _search(
        self, query: str, limit: int, gone: Callable[[], bool]
    ) -> SearchResult:
        """Run one search, alone: the Searcher is not thread-safe.

        Runs in a pool thread. gone() is asked once the lock is held;
        if it is true nobody waits for the answer and no work is done.
        """
        with self._lock:
            if gone():
                raise ClientGone
            return self.searcher.search(query, limit)
    # ...
        if self._pending >= self.max_pending:
            raise HttpError(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "server busy",
                head_only=head_only,
                headers=(("Retry-After", "1"),),
            )
        abandoned = threading.Event()
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(
            None,
            self._search,
            query,
            limit,
            lambda: abandoned.is_set() or gone(),
        )
        self._pending += 1
        future.add_done_callback(self._search_done)
        try:
            result = await asyncio.wait_for(future, self.search_timeout)
        except TimeoutError:
            raise HttpError(
                HTTPStatus.GATEWAY_TIMEOUT,
                f"search took more than {self.search_timeout:g} s",
                head_only=head_only,
            ) from None
        # ... ClientGone becomes 503, QuerySyntaxError becomes 400 ...
        finally:
            abandoned.set()
        return Response(HTTPStatus.OK, search_payload(result))
```

三道上限一起管这件事（常量在 `raw.py` 第 123 到 125 行）：同时打开的连接最多 `MAX_CONNECTIONS` = 256，再来的连接直接得到 503 然后关；正在跑或在排队的搜索最多 `MAX_PENDING` = 32，再来的搜索得到 503 加 `Retry-After: 1`；一个搜索从被接受起最多 `SEARCH_TIMEOUT` = 10 秒，超了是 504。`wait_for` 超时只能取消“等待”，线程停不下来，所以已经在跑的搜索会跑完；还没拿到锁的搜索醒来以后问一句 `gone()`，调用方已经走了（`abandoned` 被 `finally` 置位，或者连接已读到 EOF）就直接丢掉，不算搜索。`_pending` 是在 Future 完成时才减的 (`add_done_callback`)，所以超时返回 504 的搜索在线程真正结束之前仍然占着名额。这也解释了为什么这里不用 `to_thread`：我需要拿到那个 Future 来挂回调。`--max-pending N` 可以改第二道上限。

这三道上限值得量一下，因为没有它们时的后果很具体。`burst.py` 对服务器发 60 个 `limit=100` 的慢搜索（一个这样的搜索约 0.47 秒，`curl -w '%{time_total}'` 量了三次：0.59、0.47、0.47），0.3 秒后把 60 个连接全部挂断，然后立刻问一次 `limit=1` 的搜索要多久：

```python
"""Hang up on a burst of slow searches, then time fresh requests."""

import asyncio
import sys
import time

HOST = "127.0.0.1"
CLIENTS = 60
SLOW = "/search?q=python&limit=100"
FRESH = "/search?q=python&limit=1"


async def get(port: int, target: str) -> float:
    """Return the seconds a complete GET takes."""
    start = time.perf_counter()
    reader, writer = await asyncio.open_connection(HOST, port)
    writer.write(f"GET {target} HTTP/1.1\r\nHost: {HOST}\r\n\r\n".encode())
    await writer.drain()
    await reader.read()
    writer.close()
    return time.perf_counter() - start


async def burst(port: int) -> None:
    """Send CLIENTS slow searches and close every socket after 0.3 s."""
    pairs = []
    for _ in range(CLIENTS):
        reader, writer = await asyncio.open_connection(HOST, port)
        request = f"GET {SLOW} HTTP/1.1\r\nHost: {HOST}\r\n\r\n"
        writer.write(request.encode())
        pairs.append(writer)
    await asyncio.sleep(0.3)
    for writer in pairs:
        writer.close()


async def main(port: int) -> None:
    """Time a search and /health before and after the burst."""
    print(f"before: limit=1 search {await get(port, FRESH):6.3f} s")
    print(f"before: /health        {await get(port, '/health'):6.3f} s")
    await burst(port)
    print(f"after:  limit=1 search {await get(port, FRESH):6.3f} s")
    print(f"after:  /health        {await get(port, '/health'):6.3f} s")


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1])))
```

对照的两台服务器：一台是这一章修改之前的提交 `5b40d3a`（`git archive 5b40d3a | tar -x -C /tmp/sift_old`，用 `PYTHONPATH` 指过去），一台是现在的 `ch17`，索引是同一份：

```text
$ python3 /tmp/sift-scratch/cpu_state.py
112 114 114 115 115 ms
$ SIFT_INDEX=/tmp/p17/idx PYTHONPATH=/tmp/sift_old/src \
>     python3 -m sift serve --raw --port 0 --quiet > old.out &
$ SIFT_INDEX=/tmp/p17/idx python3 -m sift serve --raw --port 0 --quiet \
>     > new.out &
$ port=$(sed -n 's/^listening on .*:\([0-9]*\)$/\1/p' old.out)
$ python3 /tmp/sift-scratch/burst.py $port
before: limit=1 search  0.021 s
before: /health         0.001 s
after:  limit=1 search 28.538 s
after:  /health         0.001 s
$ port=$(sed -n 's/^listening on .*:\([0-9]*\)$/\1/p' new.out)
$ python3 /tmp/sift-scratch/burst.py $port
before: limit=1 search  0.015 s
before: /health         0.001 s
after:  limit=1 search  0.669 s
after:  /health         0.003 s
$ python3 /tmp/sift-scratch/cpu_state.py
113 113 116 116 116 ms
```

没有上限时，60 个慢搜索一个不落地全跑完了：$60 \times 0.47 \approx 28.2$ 秒，和 28.5 秒对得上，别人的 `limit=1` 搜索白等了 28.5 秒，而发起者早就走了。现在是 0.669 秒。按上限算，60 个里 32 个进队、28 个当场得到 503（我没有去数实际的 503 个数）；已经在跑的那个跑完，其余的发现客户端已经走了，直接丢掉，这是我从代码和这个耗时推出来的，没有给丢掉的搜索计数。`/health` 在两台上都没有受影响，因为它不经过线程池。这两个数是我在修改前后的两棵树上各量了一次，只量了一次。

第四处是关连接，也是手写服务器里最容易写错的一处。服务器已经决定回答，但客户端还在往里写（头太大，或者带着一个大的请求体）。如果服务器直接 `close()`，内核发现接收缓冲里还有没读的数据，会给对端发 RST，而 RFC 9112 第 9.6 节写得明白：这个复位可能抹掉客户端还没读走的数据，包括刚发出的那个响应（规范推荐的办法是先半关闭写的一端，继续读到客户端关闭或者确信客户端收到了响应，最后才完全关闭）。头太大的情形一开始就处理了，请求体的情形是后来补的：第一版只对头太大排空，一个 5 MB 请求体的 `POST` 会收到连接复位而不是 405。现在 `answer` 在请求声明了请求体时就把结果标成 `unread`，`handle` 对 `unread` 的连接先半关闭再排空：

```python
# src/sift/server/raw.py, lines 555-558, 612-614 and 624-632
            unread = (
                "content-length" in request.headers
                or "transfer-encoding" in request.headers
            )
    # ...
                if unread:
                    writer.write_eof()
                    await self._discard(reader)
    # ...
    @staticmethod
    async def _discard(reader: asyncio.StreamReader) -> None:
        """Read and drop input for a moment, so close sends no RST."""
        try:
            async with asyncio.timeout(LINGER):
                while await reader.read(MAX_HEAD):
                    pass
        except TimeoutError, OSError:
            pass
```

上一节的会话里，5 MB 请求体的 `POST` 现在拿到了完整的 405。同样的请求打到修改前的提交上，我用一段没有保留的临时 Python 代码试过，得到 `ConnectionResetError`。我想亲眼看到 RST 吃掉响应，所以另写了一个最小的服务器，只有 `drain` 这一个变量不同，客户端发 1 MB 的头：

```python
"""Answer an oversized request head, with and without draining."""

import asyncio

MAX_HEAD = 16 * 1024
ANSWER = (
    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\n"
    b"Connection: close\r\n\r\n{}"
)


def make_handler(drain: bool):
    """Return a client handler that drains the input or does not."""

    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            await reader.readuntil(b"\r\n\r\n")
        except asyncio.LimitOverrunError:
            writer.write(ANSWER)
            await writer.drain()
            if drain:
                writer.write_eof()
                async with asyncio.timeout(1):
                    while await reader.read(MAX_HEAD):
                        pass
        writer.close()

    return handle


async def attempt(drain: bool) -> str:
    """Send 1 MB of head to a fresh server; say what the client saw."""
    server = await asyncio.start_server(
        make_handler(drain), "127.0.0.1", 0, limit=MAX_HEAD
    )
    port = server.sockets[0].getsockname()[1]
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        writer.write(b"GET / HTTP/1.1\r\nX: " + b"a" * 1_000_000)
        await writer.drain()
        answer = await reader.read()
        result = answer.split(b"\r\n", 1)[0].decode()
    except OSError as error:
        result = f"{type(error).__name__}: {error.strerror}"
    writer.close()
    server.close()
    return result


async def main() -> None:
    """Try each variant five times."""
    for drain in (False, True):
        print(f"drain before close: {drain}")
        for _ in range(5):
            print("  client saw:", await attempt(drain))


if __name__ == "__main__":
    asyncio.run(main())
```

```text
$ python3 /tmp/sift-scratch/rst_demo.py | uniq -c
      1 drain before close: False
      5   client saw: ConnectionResetError: Connection reset by peer
      1 drain before close: True
      5   client saw: HTTP/1.1 400 Bad Request
```

十次里没有一次例外：不排空就关，客户端只看到 `ConnectionResetError`，服务器写了 400 也没用；排空以后 5 次都收到 400。这个现象是在本机回环上量的，跨网络的时序不同，我没有试。排空本身也有边界：`LINGER` 是 1 秒，一个超过 1 秒还没发完的请求体，服务器关连接时仍然可能有没读的数据，客户端还是可能收到复位；而且半关闭之后读不到 EOF 的客户端会占着连接 1 秒，连接数上限 (256) 就是为这类占用准备的。这两句是读代码得到的，我没有写实验去复现。

第五处是命令行入口和安全。`sift serve --raw` 在 `cli.py` 里是 `asyncio.run(serve(...))`，`serve` 注册 `SIGTERM` 处理器 (`loop.add_signal_handler`)，收到信号后先停止接收新连接，最多等 `GRACE`（5 秒）让手头的请求收尾，再把剩下的连接中止。上面会话里的 `exit status after SIGTERM: 0` 就是这条路径。两种出错的退出码（端口超出范围由参数解析拒绝，退出码 2）：

```text
$ SIFT_INDEX=/tmp/p17/none sift serve --raw --port 0; echo "exit $?"
sift: no index at /tmp/p17/none, run 'sift index' first
exit 4
$ sift serve --raw --port $busy; echo "exit $?"
error: cannot listen on 127.0.0.1:42849: address already in use
exit 1
```

这里 `$busy` 是我另外起的一个占着端口的 Python 进程的端口号。

安全上要说清楚几件事。这个服务器没有任何认证，也没有 TLS，没有 keep-alive，没有限速。默认只绑 `127.0.0.1`，这时它会检查 `Host`（上面那次 `Host: evil.example` 得到 400），挡住 DNS 重绑定：否则一个网页可以让浏览器把自己的域名解析到 127.0.0.1，再带着这个域名的 `Host` 来读 `/docs/<id>`。绑在别的地址上就不再检查，并且启动时记一条警告：

```text
$ sift serve --raw --host 0.0.0.0 --port 0
WARNING sift.server.raw: listening on 0.0.0.0: no authentication, and responses carry document paths; anyone who can connect can read them
listening on http://0.0.0.0:36237
```

警告里说的“文档路径”是另一个问题：`/search` 和 `/docs/<id>` 的 JSON 里带着索引里存的 `path`，如果建索引时给的是绝对路径，就会把服务器磁盘的布局告诉每一个客户端。我试了一下（用 `sed` 把我的家目录换成 `~` 再显示）：

```text
$ export SIFT_INDEX=$(mktemp -d)/idx
$ sift index --corpus "$PWD/corpus/posts" | tail -1
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 2997.8 ms
$ sift serve --raw --port 0 --quiet > l.out &
$ url=$(sed 's/^listening on //' l.out)
$ curl -s "$url/docs/1" | grep -o '"path": "[^"]*"' | sed "s|$HOME|~|"
"path": "~/Projects/sift/corpus/posts/bibtex-and-biblatex-guide.md"
```

这一版的处理是写进文档：模块文档字符串、`README.md` 和 `--host` 的帮助里都说了。没有改成相对路径，所以用这个服务器的时候，要么用相对路径建索引（本篇所有会话都是这样），要么别把它放到别人能连的地方。文档 id 另有一个小改动：`/docs/0001` 现在按数值当成文档 1，前导零先去掉再判断长度（`raw.py` 第 471 行）。

## 压测：asyncio 对 `ThreadingHTTPServer`

比较用的对手是标准库的 `http.server.ThreadingHTTPServer`。`ThreadingMixIn.process_request` 对每个请求新建一个线程（`Lib/socketserver.py` 第 703 到 711 行），`BaseHTTPRequestHandler` 默认是 `HTTP/1.0`（`Lib/http/server.py` 第 698 行），每个响应后关连接，这一点和 `raw.py` 的 `Connection: close` 对等，所以两边都是“一个请求一个连接”。`lab/ch17/threaded_http_server.py` 用同一个 `Searcher`、同一把锁、同一个 `search_payload` 实现 `/search` 和 `/health`，不打日志，监听队列设成 128（`socketserver` 默认的 `request_queue_size` 是 5，第 444 行，100 个客户端同时连会丢）：

```python
# lab/ch17/threaded_http_server.py (server class, reply, main trimmed)
class Handler(BaseHTTPRequestHandler):
    """Answer GET /search?q=... and GET /health."""

    def search(self, query: str, limit_text: str | None) -> None:
        """Run the query in this thread, one search at a time.

        The errors have the status and the JSON body of the asyncio
        server, so the two can be compared byte for byte.
        """
        # ... 400 for a blank q, "limit must be an integer", or the
        # ConfigError message for a limit out of range ...
        try:
            with self.server.lock:
                result = self.server.searcher.search(query, limit)
        except QuerySyntaxError as error:
            self.reply(
                400,
                {
                    "error": str(error),
                    "query": error.query,
                    "position": error.position,
                },
            )
            return
        self.reply(200, search_payload(result))
```

要比，两边就得回答一样的问题。`extra.sh` 里有一段小脚本，把 15 个请求（基准查询、各种坏的 `limit`、坏的查询、缺 `q`、不存在的路径）先后发给两个服务器，去掉 `took_ms` 以后比较状态码和 JSON，不一样就让整个 `extra.sh` 失败。线程版一开始处理 `limit` 的方式和 asyncio 版不同，现在它们的错误文案和状态码是一样的（线程版没有 `/docs` 路由，所以不比）：

```text
$ cat out/ch17/compare_bodies.txt
  identical 200 /health
  identical 200 /search?q=rust&limit=1
  identical 200 /search?q=kalman+filter&limit=2
  identical 200 /search?q=%22device+tree%22&limit=1
  identical 200 /search?q=%E5%A5%87%E5%BC%82%E5%80%BC&limit=1
  identical 200 /search?q=owner*&limit=1
  identical 400 /search
  identical 400 /search?q=
  identical 400 /search?q=rust&limit=0
  identical 400 /search?q=rust&limit=101
  identical 400 /search?q=rust&limit=x
  identical 400 /search?q=rust&limit=
  identical 400 /search?q=(rust
  identical 400 /search?q=rust+AND
  identical 404 /nope
15 of 15 identical (status and JSON, no took_ms)
```

压测脚本 `load.py` 是 asyncio 写的客户端：N 个客户端同时开始，每个按顺序发 M 个请求，每个请求新开一个连接，读到服务器关连接为止，记每个请求从开始到读完的时间，最后给出 req/s 和 p50、p99（最近排名法）。完整的脚本在仓库里。

压测工具自己有上限，量服务器之前得先量它。不带 `--port`，`load.py` 会在同一个进程里起一个立即回 `{}` 的桩服务器；我另外写了一个把同样的桩放进独立进程的版本，两个都量：

```python
"""Serve {} to every request from a process of its own."""

import asyncio


async def stub(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    """Answer any request with an empty JSON object."""
    await reader.readuntil(b"\r\n\r\n")
    writer.write(
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
    )
    await writer.drain()
    writer.close()


async def main() -> None:
    """Listen on a free port, print it, serve until killed."""
    server = await asyncio.start_server(stub, "127.0.0.1", 0, backlog=1024)
    port = server.sockets[0].getsockname()[1]
    print(f"listening on http://127.0.0.1:{port}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
```

```text
$ python3 lab/ch17/load.py
no --port: loading a stub server in this process
100 clients x 20 requests, 2000 answered
wall      0.378 s
req/s    5287.0
p50        18.7 ms
p99        23.2 ms
max        23.3 ms
errors        0
$ python3 /tmp/sift-scratch/stub_server.py > stub.out &
$ port=$(sed -n 's/^listening on .*:\([0-9]*\)$/\1/p' stub.out)
$ for i in 1 2 3; do python3 lab/ch17/load.py --port $port \
>     --target /health | sed -n 3p; done
req/s    7379.4
req/s    6959.3
req/s    7387.4
```

同一个桩，放在客户端自己的进程里是 5287 req/s，放在另一个进程里是 6959 到 7387 req/s。差别很好解释：同一个进程里，客户端和桩共用一个事件循环，一个核干两份活。所以进程内桩的数字只是下界，不是别的服务器的上限（`load.py` 的文档字符串现在就是这么写的：a floor for the generator, not a ceiling for servers），独立进程里的服务器可以比 5287 快，下面 `/health` 的 7000 多就是例子。真正的上限是第二段：这台机器上，这个生成器压一个什么也不做的服务器，最多 7400 req/s 上下。

现在是正题。`extra.sh` 起一个 `sift serve --raw` 和一个 `threaded_http_server.py`，两个都先预热，然后两个服务器轮流跑，`/search` 跑 2 轮，`/health` 跑 3 轮，每轮 100 个客户端各发 20 个请求，一共 2000 个。这是第一轮 raw 的完整输出，之后是 `extra.sh` 打印的汇总（只贴汇总，每一轮的完整输出在仓库的 `out/ch17/load_compare.txt` 里）：

```text
$ python3 lab/ch17/load.py --port <port> --clients 100 --requests 20 --limit 1
100 clients x 20 requests, 2000 answered
wall     29.456 s
req/s      67.9
p50      1454.4 ms
p99      1841.6 ms
max      1883.3 ms
errors        0
$ grep -E '^(summary|raw|threaded) ' out/ch17/load_compare.txt
summary of GET /search?q=...&limit=1
raw       round 1      67.9 req/s  p50  1454.4 ms  p99  1841.6 ms
raw       round 2      67.6 req/s  p50  1453.6 ms  p99  1964.5 ms
threaded  round 1      65.0 req/s  p50  1534.2 ms  p99  1652.6 ms
threaded  round 2      64.7 req/s  p50  1542.7 ms  p99  1672.2 ms
summary of GET /health
raw       round 1    7375.0 req/s  p50    13.4 ms  p99    15.5 ms
raw       round 2    7319.1 req/s  p50    13.4 ms  p99    16.4 ms
raw       round 3    7353.8 req/s  p50    13.4 ms  p99    19.3 ms
threaded  round 1    4421.4 req/s  p50    22.2 ms  p99    23.9 ms
threaded  round 2    4449.0 req/s  p50    22.2 ms  p99    23.5 ms
threaded  round 3    4466.4 req/s  p50    22.1 ms  p99    23.5 ms
```

`<port>` 是 `extra.sh` 打印命令说明时写的占位，真实端口是它启动服务器时从标准输出读来的；`/search` 那一组的 raw 服务器启动时带了 `--max-pending 128`，原因下面讲；这一整段跑在 `make ch17` 里，前后夹的 `cpu_state` 在环境一节贴过，是快状态。

两件事。第一件是搜索：asyncio 服务器 67.6 到 67.9 req/s，线程服务器 64.7 到 65.0 req/s，asyncio 快 4.5% 左右，而且它的 p99 反而更差（1.84 到 1.96 秒对 1.65 到 1.67 秒）。第二件是 `/health`：asyncio 7319 到 7375 req/s，线程 4421 到 4466 req/s，是线程服务器的 1.64 到 1.67 倍。

raw 服务器启动时那个 `--max-pending 128` 是有原因的。默认的 `MAX_PENDING` 是 32，100 个客户端同时发搜索，多出来的会得到 503；我用默认值跑了一次同样的负载：

```text
$ python3 lab/ch17/load.py --port $port --clients 100 --requests 20 \
>     --limit 1 | grep -v '^error:'
100 clients x 20 requests, 2000 answered
wall     20.353 s
req/s      98.3
p50      1022.4 ms
p99      1420.6 ms
max      1559.7 ms
errors      640
```

2000 个请求有 640 个得到 503，所谓 98.3 req/s 里一大块是被拒绝的请求，没有意义。线程服务器没有这道上限（也就没有这个保护），公平比较只能把 raw 的上限抬到 128，让两边都接受全部请求。

搜索那一组我一开始很失望，然后发现它可以算出来。一次搜索 (`limit=1`) 在这个进程里要多久？`search_cost.py` 量了 12 条基准查询各 5 轮的中位数：

```python
"""Time the 12 bench queries at limits 1 and 10, then profile 10."""

import cProfile
import pstats
import statistics
import time
from pathlib import Path

from sift import cli
from sift.analysis import build_pipeline
from sift.config import load_config
from sift.search import Searcher
from sift.storage.store import open_index

QUERIES = Path("bench/queries.txt")
ROUNDS = 5


def cost(searcher: Searcher, queries: list[str], limit: int) -> float:
    """Return the median milliseconds per query over ROUNDS rounds."""
    rounds = []
    for _ in range(ROUNDS):
        start = time.perf_counter()
        for query in queries:
            searcher.search(query, limit)
        rounds.append((time.perf_counter() - start) * 1000 / len(queries))
    return statistics.median(rounds)


def main() -> None:
    """Print the cost per query and the top of the profile."""
    config = load_config()
    queries = [q for q in QUERIES.read_text().splitlines() if q.strip()]
    with open_index(cli.index_dir(config)) as index:
        searcher = Searcher(
            index,
            k1=config.k1,
            b=config.b,
            pipeline=build_pipeline(index.pipeline_names),
        )
        cost(searcher, queries, 1)  # warm up the analyzer cache
        for limit in (1, 10, 1, 10):
            print(f"limit={limit:<2} {cost(searcher, queries, limit):6.1f} ms")
        profile = cProfile.Profile()
        profile.runcall(lambda: [searcher.search(q, 10) for q in queries])
    stats = pstats.Stats(profile).strip_dirs().sort_stats("cumulative")
    stats.print_stats("search.py|snippet.py", 6)


if __name__ == "__main__":
    main()
```

```text
$ SIFT_INDEX=/tmp/p17/idx python3 /tmp/sift-scratch/search_cost.py
limit=1    13.6 ms
limit=10   82.9 ms
limit=1    13.5 ms
limit=10   82.9 ms
         5503061 function calls (5502966 primitive calls) in 1.851 seconds

   Ordered by: cumulative time
   List reduced from 108 to 11 due to restriction <'search.py|snippet.py'>
   List reduced from 11 to 6 due to restriction <6>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
       12    0.018    0.001    1.851    0.154 search.py:142(search)
       77    0.017    0.000    1.828    0.024 snippet.py:82(make_snippet)
       77    0.155    0.002    1.167    0.015 snippet.py:54(_hit_spans)
       77    0.457    0.006    0.642    0.008 snippet.py:25(_origin)
  2166692    0.104    0.000    0.104    0.000 snippet.py:49(<genexpr>)
      615    0.000    0.000    0.001    0.000 snippet.py:77(_squeeze)
```

`limit=1` 一次搜索 13.5 到 13.6 毫秒。搜索被锁串行化，又是纯 CPU 活，吞吐的天花板就是 $1000 / 13.55 \approx 74$ req/s，两个服务器分别跑到了天花板的 92% 和 88% 左右。再用 Little 定律验算延迟：100 个客户端各有一个请求在途，p50 应当接近 $100 / 67.9 = 1.473$ 秒，实测 1454.4 毫秒。所以搜索那一组不是 asyncio 慢，也不是线程快：两边在同一把锁、同一个 GIL 后面排同一个队，事件循环和线程池只决定谁在队里。这是这一篇里我觉得最有用的一个结论：并发模型救不了 CPU 活。

`limit=10` 更夸张：82.9 毫秒一次，其中 `make_snippet` 占累计时间的 1.828/1.851，也就是 98.8%（`cProfile` 自己有开销，比例大致可信，绝对时间不能信）。按同样的算法，`limit=10` 的天花板是 $1000/82.9 \approx 12$ req/s。这个数我只是算出来的，没有把 `limit=10` 放进这一篇的压测，所以它是推算，不是测量。

`/health` 那一组才是事件循环能赢的地方：没有 CPU 活，只有“同时有 100 个连接要接、要读、要写、要关”。asyncio 服务器是线程服务器的 1.64 到 1.67 倍。但是上面量过生成器本身的上限是 6959 到 7387 req/s，asyncio 服务器的 7319 到 7375 已经在这个范围里。所以 1.6 倍是个下界：asyncio 服务器真实能跑多快，这个生成器量不出来。线程服务器为什么慢，我的猜测是每个请求都新建一个线程 (`ThreadingMixIn.process_request`) 再加上 `http.server` 通用的请求解析，没有拆开量，这是猜测。

还有一个我没有解释清楚的地方，如实写下来：asyncio 搜索的 p99（1.84 到 1.96 秒）比线程的（1.65 到 1.67 秒）差：asyncio 的默认执行器只有 20 个线程（前面量到的 `_max_workers`），100 个请求里 20 个进到线程里抢锁，80 个在执行器的队列里排队；线程服务器是 100 个线程一起抢。我猜 `threading.Lock` 不保证先来先得，20 个线程抢锁时有的运气差，尾部变长，但我没有给锁加计数或计时去验证，这只是猜测。

## 用 `asyncio ps` 看一台跑着的服务器

3.14 加了两个命令行工具：`python -m asyncio ps PID` 列出另一个进程里所有挂起的任务，`pstree PID` 画成调用树（`Doc/whatsnew/3.14.rst` 第 691 到 712 行，实现在 `Lib/asyncio/tools.py`，第 143 到 145 行就是 `RemoteUnwinder(pid).get_all_awaited_by()`，也就是从另一个进程的内存里读）。既然是读别的进程的内存，权限就是第一个问题。`extra.sh` 的前半段做了对照实验：先起一个 `sift serve --raw`，再从它的兄弟进程（同一个脚本启动的另一个命令）去附加；然后换成让附加的进程成为服务器的父进程（一个子 shell 先把服务器放到后台，再 `exec` 成 `python3 -m asyncio ps`）。两个客户端连上服务器，一个发了半截 `GET /health HTTP/1.1\r\nHo` 就不说话，一个发了请求行没发头，服务器因此有两个卡在读头的任务：

```text
$ tr -s ' ' < out/ch17/asyncio_ps.txt | grep -v '^---'
ptrace_scope: 1

# attach from a sibling process (refused when scope is 1)
$ python3 -m asyncio ps 491372
Error: The specified process cannot be attached to due to insufficient permissions.
See the Python documentation for details on required privileges and troubleshooting:
https://docs.python.org/3.14/howto/remote_debugging.html#permission-requirements

(exit status 1)

# attach from the parent of the server
$ python3 -m asyncio ps 491385
tid task id task name coroutine stack awaiter chain awaiter name awaiter id 
491385 0x7ffff4a13a70 Task-1 Event.wait -> serve 0x0 
491385 0x7ffff4b5f4d0 Task-5 StreamReader._wait_for_data -> StreamReader.readuntil -> RawServer._read_head -> RawServer.answer -> RawServer.handle 0x0 
491385 0x7ffff4b5f850 Task-6 StreamReader._wait_for_data -> StreamReader.readuntil -> RawServer._read_head -> RawServer.answer -> RawServer.handle 0x0 
```

（`tr -s ' '` 把对齐用的重复空格压成一个，`grep` 去掉了表头下的一行减号，其余是 `extra.sh` 的原始输出。）`Task-1` 是 `serve`，停在 `Event.wait` 上，等的是 SIGTERM；`Task-5` 和 `Task-6` 是两个卡在 `readuntil` 里的连接处理器。兄弟进程那一次被拒了，`ptrace_scope` 是 1；错误信息指向的文档（`Doc/howto/remote_debugging.rst` 第 21 到 47 行）说附加需要 `CAP_SYS_PTRACE` 或等价权限，Yama 这样的安全模块会进一步限制，放宽的办法是把 `ptrace_scope` 写成 0。我没有改这个系统设置，它会降低整台机器的防护。附加到后代进程是允许的，实验里第二段成功了，这符合 Yama 在 1 上“只许跟踪后代”的行为，不过这条规则是我从实验结果倒推的，没有读内核文档。

`pstree` 带文件和行号，比 `ps` 更容易对回源码（又是另一次服务器，所以 PID 不同；路径里我用 `sed` 去掉了仓库根目录的前缀，Nix 存储的前缀换成了 `<stdlib>`）：

```text
$ sed "s|$PWD/||; s|/nix/store/[^/]*/lib/python3.14|<stdlib>|" \
>     out/ch17/asyncio_pstree.txt | sed -n 1,11p
$ python3 -m asyncio pstree 491407
└── (T) Task-1
    └──  serve src/sift/server/raw.py:723
        └──  Event.wait <stdlib>/asyncio/locks.py:213
└── (T) Task-5
    └──  RawServer.handle src/sift/server/raw.py:599
        └──  RawServer.answer src/sift/server/raw.py:548
            └──  RawServer._read_head src/sift/server/raw.py:522
                └──  StreamReader.readuntil <stdlib>/asyncio/streams.py:684
                    └──  StreamReader._wait_for_data <stdlib>/asyncio/streams.py:546
```

（只贴前 11 行，`Task-6` 那一棵和 `Task-5` 一模一样。）

每个数字都能对上：`raw.py:723` 是 `serve` 里的 `await stop.wait()`，`599` 是 `handle` 里的 `done = await self.answer(reader)`，`548` 是 `answer` 里的 `head = await self._read_head(reader)`，`522` 是 `_read_head` 里的 `return await reader.readuntil(END_OF_HEAD)`；`streams.py:684` 和 `546` 就是前面引用的 `readuntil` 里的 `await self._wait_for_data('readuntil')` 和 `_wait_for_data` 里的 `await self._waiter`。这棵树不需要事先打日志，也不需要重启，线上排查“一堆连接为什么不动了”的时候比日志有用。文档建议读解释器内部状态之前先挂起目标进程（`remote_debugging.rst` 第 396 到 403 行）；`asyncio ps` 会不会让服务器停一下，我没有查，也没有量。

## 往前看

如果搜索能真并行，这个服务器的上限会立刻变：自由线程构建加上一个线程安全的 `LRUCache`，`to_thread` 里的搜索就会同时跑在好几个核上，p50 就不再是 100 除以单线程吞吐，而那三道上限也就该重新定数了。这是我的推测，这一篇没有在 `python3.14t` 上跑服务器，所以不要当成结果。

## 本篇文件

这一章动了 22 个文件（`git diff --shortstat ch16 ch17`：`22 files changed, 3469 insertions(+), 2 deletions(-)`）。表里的 `+N -M` 来自 `git diff --numstat ch16 ch17`，源文件的命令是跑它对应的测试文件，测试结果是我最后一次在仓库里实际跑出来的；`/tmp/sift-scratch/` 里的脚本不进仓库，不在表里。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch17/README.md) | `git diff --numstat ch16 ch17 -- README.md \| awk '{print "+"$1, "-"$2}'` | 退出码 0，`+6 -1` |
| [`async_iter_ctx.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/async_iter_ctx.py) | `python3 lab/ch17/async_iter_ctx.py` | 退出码 0，最后一行 `    error reached the caller`；`+97 -0` |
| [`blocking_in_loop.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/blocking_in_loop.py) | `python3 lab/ch17/blocking_in_loop.py` | 退出码 0，第一行 `heartbeat every 10 ms, work blocks 300 ms`，`time.sleep` 那一行的最长间隔我看到 309.3 到 311.0 毫秒，`asyncio.to_thread` 那一行 10.9 到 13.6 毫秒；`+89 -0` |
| [`contextvars_demo.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/contextvars_demo.py) | `python3 lab/ch17/contextvars_demo.py` | 退出码 0，标准输出最后一行 `  after reset(token): -`，标准错误里有 `  [req-1] handling`；`+67 -0` |
| [`coroutines_basics.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/coroutines_basics.py) | `python3 lab/ch17/coroutines_basics.py` | 退出码 0，最后一行 `SyntaxError: 'await' outside function`；`+63 -0` |
| [`executors.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/executors.py) | `python3 lab/ch17/executors.py` | 退出码 0，第一行 `python 3.14.7, GIL enabled: True`，最后一行 `  ran in another process: True`；`+97 -0` |
| [`executors_ft.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/executors_ft.py) | `python3.14t lab/ch17/executors_ft.py` | 退出码 0，第一行 `python 3.14.7, GIL enabled: False`，最后一行 `  ran in another process: True`；`+8 -0` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/extra.sh) | `bash lab/ch17/extra.sh` | 退出码 0（`make ch17` 里是 `ok   lab/ch17/extra.sh`），它打印的最后一行是 `threaded  round 3    4466.4 req/s  p50    22.1 ms  p99    23.5 ms`（取自 `make ch17` 那一次，整个 `make ch17` 用了 2 分 22 秒）；`+235 -0` |
| [`forgot_await.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/forgot_await.py) | `python3 lab/ch17/forgot_await.py` | 退出码 0，第一行 `fetch() 'took' 0.021 ms instead of 1000 ms`（毫秒数每次不同），标准错误里有 `RuntimeWarning: coroutine 'fetch' was never awaited`；`+42 -0` |
| [`futures_basics.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/futures_basics.py) | `python3 lab/ch17/futures_basics.py` | 退出码 0，最后一行 `  awaited: hi`；`+79 -0` |
| [`load.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/load.py) | `python3 lab/ch17/load.py` | 退出码 0，第一行 `no --port: loading a stub server in this process`，最后一行 `errors        0`；`+140 -0` |
| [`queues_semaphores.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/queues_semaphores.py) | `python3 lab/ch17/queues_semaphores.py` | 退出码 0，最后一行 `  after set: released`；`+110 -0` |
| [`selectors_loop.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/selectors_loop.py) | `python3 lab/ch17/selectors_loop.py` | 退出码 0，最后一行 `callbacks run: N`（N 在 23 到 25 之间，连跑 16 次出现过这三个值）；`+88 -0` |
| [`sockets_blocking.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/sockets_blocking.py) | `python3 lab/ch17/sockets_blocking.py` | 退出码 0，最后一行 `after the idle client left: 'hello'`；`+75 -0` |
| [`tasks_gather_taskgroup.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/tasks_gather_taskgroup.py) | `python3 lab/ch17/tasks_gather_taskgroup.py` | 退出码 0，最后一行 `  ['p done', 'q done']`；`+75 -0` |
| [`threaded_http_server.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/threaded_http_server.py) | `python3 lab/ch17/threaded_http_server.py` | 退出码 0，最后一行 `GET /search?q=rust+lifetime -> 200: query, total, took_ms, hits`；`+175 -0` |
| [`timeouts_cancellation.py`](https://github.com/bfmhno3/sift/blob/ch17/lab/ch17/timeouts_cancellation.py) | `python3 lab/ch17/timeouts_cancellation.py` | 退出码 0，最后一行 `  inner finished`；`+87 -0` |
| [`cli.py`](https://github.com/bfmhno3/sift/blob/ch17/src/sift/cli.py) | `python3 -m pytest tests/test_cli.py \| tail -1` | 退出码 0，`76 passed in 4.69s`；`+88 -1` |
| [`__init__.py`](https://github.com/bfmhno3/sift/blob/ch17/src/sift/server/__init__.py) | `python3 -c "import sift.server; print(sift.server.__doc__)"` | 退出码 0，输出 `HTTP servers of Sift.`；`+1 -0` |
| [`raw.py`](https://github.com/bfmhno3/sift/blob/ch17/src/sift/server/raw.py) | `python3 -m pytest tests/test_server_raw.py \| tail -1` | 退出码 0，`135 passed in 6.21s`（`raw.py` 里的 doctest 用 `python3 -m pytest src/sift/server/raw.py` 另跑，`2 passed`）；`+730 -0` |
| [`test_cli.py`](https://github.com/bfmhno3/sift/blob/ch17/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py \| tail -1` | 退出码 0，`76 passed in 4.69s`；`+88 -0` |
| [`test_server_raw.py`](https://github.com/bfmhno3/sift/blob/ch17/tests/test_server_raw.py) | `python3 -m pytest tests/test_server_raw.py \| tail -1` | 退出码 0，`135 passed in 6.21s`；`+1029 -0` |

## 练习

**1.** `load.py` 压一个什么也不做的独立进程桩，自己就到了 7000 到 7400 req/s，asyncio 服务器 `/health` 的 7319 到 7375 已经在这个范围里。想办法让生成器不再是瓶颈（比如起几个 `load.py` 进程各压一部分，或者换一个压测工具），重新量 asyncio 服务器和线程服务器的 `/health`，看 1.6 倍的下界变成多少。

**2.** 服务器里的锁把搜索串行化了，原因是 `LRUCache` 不是线程安全的。只给 `Searcher.term_cache` 的访问加一把小锁，把整个 `search` 外面的大锁去掉，在 `python3`（带 GIL）上重新量 `limit=1` 的吞吐。先写下你的预测，再看结果：我的预测是几乎没有变化，理由是 CPU 活在 GIL 下本来就不能并行；但这是预测，我没有做这个实验。

**3.** `limit=10` 的搜索 98.8% 的时间在 `make_snippet`，`cProfile` 里 `snippet.py` 第 49 行的生成器表达式被调了 216 万次。读 `_hit_spans` 和 `_origin`，找出为什么一次搜索会重复算这么多次，改成每个文档只算一次偏移，然后用 `search_cost.py` 量 `limit=10` 能降到多少毫秒，并确认 `tests/test_snippet.py` 还是全绿。

## 下一篇

下一篇是《[Web：FastAPI、pydantic 与 httpx](/posts/python-by-sift-18-fastapi-pydantic-httpx/)》。这一篇的请求头是我自己一行一行解析的，下一篇想看框架替我做了多少、又悄悄替我决定了多少。
