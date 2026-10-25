---
title: "Web：FastAPI、pydantic 与 httpx"
commentId: "post:python-by-sift-18-fastapi-pydantic-httpx"
published: "2026-10-25 09:00:00 +08:00"
description: "用 Sift 重学 Python 第 18 篇：我用 Python 3.14.7、FastAPI 0.139.0、uvicorn 0.51.0、pydantic 2.13.4 和 httpx 0.28.1 给 Sift 加了默认的 sift serve 和 httpx 客户端，再拿它和第 17 篇的手写服务器比。同一个 httpx.Client 复用连接发 100 个 GET /health，监听套接字的协议号是 0 时用了 4237 毫秒，改成 IPPROTO_TCP 后 102 毫秒；/health 上 FastAPI 约 3679 对手写服务器约 7200 req/s，一个 def 写的依赖在真实服务器上让每个请求多花约 117 微秒；300 个什么都不发的连接能让没有读超时的 uvicorn 一直回 503；pydantic 校验一个三字段对象 1114 纳秒，是 dataclass 的 4.7 倍。"
category: Tutorial
tags:
  - Python
  - Sift
  - FastAPI
  - pydantic
  - httpx
  - Web
series: "用 Sift 重学 Python"
seriesOrder: 18
draft: false
comment: true
slug: python-by-sift-18-fastapi-pydantic-httpx
---

我用一个 `httpx.Client` 向跑在 uvicorn 上的 Sift 应用发 100 个 `GET /health`，连接复用。监听套接字用 `socket.create_server` 那种写法（协议号参数是 0）时，100 个请求花了 4237 毫秒，平均每个 42 毫秒；把同一行里的协议号换成 `socket.IPPROTO_TCP`，别的什么都不动，同样 100 个请求 102 毫秒。差了 42 倍，服务器和客户端的 Python 代码一行没变，变的只是内核里一个套接字选项有没有被设上。有意思的是每个请求新开一个连接的时候两种写法几乎一样（135 对 134 毫秒），所以平时的压测看不到它。这一篇从这几行输出出发：先看 WSGI 和 ASGI 到底差在哪，再用 httpx、pydantic 和 FastAPI 把 Sift 的三个接口重写一遍，最后在 uvicorn 上和第 17 篇的手写服务器正面比一次。

```text
$ python3 -W ignore /tmp/sift-scratch/ch18/nagle_pooled.py
proto 0      pooled                  4237 ms for 100 requests
proto 0      new connection each      135 ms for 100 requests
IPPROTO_TCP  pooled                   102 ms for 100 requests
IPPROTO_TCP  new connection each      134 ms for 100 requests
```

> [!NOTE] Note
> 这一篇结束时仓库处于标签 `ch18`（提交 `1fc991c`）。新增 `src/sift/server/app.py`（FastAPI 应用、参数校验、两个手写的 ASGI 中间件、异常处理、lifespan，以及在 uvicorn 上运行的 `serve`）、`src/sift/server/models.py`（五个 pydantic 模型）和 `src/sift/client.py`（httpx 的同步与异步客户端）。改动的有 `src/sift/cli.py`（`sift serve` 默认走 FastAPI，`--raw` 还是第 17 篇的服务器）、`src/sift/server/raw.py`（几个私有名字改成公开的，`parse_params` 和 `limit_from_text` 两个服务器共用）、`pyproject.toml`（多了 `web` 可选依赖）、`README.md`、`tests/conftest.py`，还有 `lab/ch17/load.py`（请求里加了 `Connection: close`）。测试新增 `test_server.py`、`test_client.py` 和 `test_raw_server.py`；`lab/ch18` 下有 8 个脚本加一个 `extra.sh`。一共 23 个文件，`git diff --shortstat ch17 ch18` 给出 `23 files changed, 3145 insertions(+), 66 deletions(-)`。`make ch18` 的 8 个脚本和 `extra.sh` 全是 `ok`，完整测试 886 passed、1 xfailed，`make typecheck` 0 个错误。
> 后面的章节里，第 19 篇把 `src/sift/cli.py` 改写成 typer 版本，让 `src/sift/log.py` 的 `rich=True` 真正起作用，改 `pyproject.toml` 的依赖，并新增 `src/sift/render.py`。
> 涉及的 Python 特性：WSGI 与 ASGI 的可调用对象、`Annotated` 与元数据、pydantic 的校验器和序列化、依赖注入、`asynccontextmanager` 写的 lifespan、`socket` 的协议号与选项。
> 前置：[第 17 篇](/posts/python-by-sift-17-asyncio/)。上一篇的请求头是我自己一行一行解析的；这一篇换成框架来做，看它替我做了多少，又悄悄替我决定了多少。

## 环境

和前几篇同一台机器，仓库在标签 `ch18`，命令都在 `nix develop` 里、仓库根目录下跑。几个库的版本是 `importlib.metadata` 报的：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags; git rev-parse --short HEAD
ch18
1fc991c
$ lscpu | sed -n '/Model name/p;/^CPU(s):/p'
CPU(s):                                  16
Model name:                              AMD Ryzen 7 PRO 6850U with Radeon Graphics
$ python3 -c "import importlib.metadata as m; \
[print(n, m.version(n)) for n in ('fastapi', 'starlette', 'uvicorn', \
'httpx', 'httpcore', 'pydantic', 'pydantic_core', 'h11', 'anyio')]"
fastapi 0.139.0
starlette 1.3.1
uvicorn 0.51.0
httpx 0.28.1
httpcore 1.0.9
pydantic 2.13.4
pydantic_core 2.46.4
h11 0.16.0
anyio 4.14.2
```

uvicorn 的 HTTP 解析默认装了 `httptools` 就用它，没装用纯 Python 的 h11（`uvicorn/protocols/http/auto.py` 第 6 到 15 行）。这个环境里：

```text
$ python3 -c "import importlib.util as u; \
print({n: u.find_spec(n) is not None for n in ('httptools', 'uvloop')})"
{'httptools': False, 'uvloop': False}
```

所以下面所有 uvicorn 的数字都是 h11 加标准 asyncio 事件循环的（`sift serve` 自己还用 `http=` 固定了 h11，下面 uvicorn 一节会看到）。装 `uvicorn[standard]` 会给别的 uvicorn 换成 `httptools` 和 `uvloop`，快多少我没有量。

这台机器的 CPU 有快慢两个状态（第 11 篇测到过约 2.5 倍），所以计时前后我各夹一次 `cpu_state.py`（第 12 篇贴过的固定忙循环，快状态下 5 个数在 110 到 120 毫秒）。`make ch18` 前后是 `111 115 121 114 115` 和 `115 113 117 116 115`；其余脚本前后的数大多在 110 到 123，在几个起了 uvicorn 线程或一堆 socket 的脚本之后有过几次 139 到 171 的暂时读数，下一次测就回到 113 上下，没有出现过慢状态的 280 毫秒上下。所以全篇是快状态的数字。

文中引用的第三方源码都是这个环境里装的版本，我在 nix 存储里按路径读的，行号在读的那份文件里数，路径相对于 `site-packages`：

- `fastapi` 0.139.0、`starlette` 1.3.1、`uvicorn` 0.51.0、`httpx` 0.28.1、`httpcore` 1.0.9、`h11` 0.16.0、`pydantic` 2.13.4。
- `pydantic-core` 2.46.4 是编译好的 `.so`，Rust 源码不在环境里。pydantic-core 自己的仓库里没有 `v2.46.4` 标签（我拉了，404），源码在 `pydantic/pydantic` 仓库的 `pydantic-core/` 目录；我读的是该仓库 `v2.13.4` 标签下的文件，其中 `Cargo.toml` 写着 `version = "2.46.4"`，和环境里一致。
- CPython 的源码用第 17 篇拉到 `/tmp/cpython-3.14.7/` 的 `v3.14.7` 标签。
- PEP 3333 取自 `python/peps` 的提交 `b990d05`（`Status: Final`；这是 `peps/pep-3333.rst` 最后一次被改动的提交）。ASGI 规范取自 `django/asgiref` 的提交 `03dcd19`（读的时候的 `main`），其中 HTTP 规范是 `specs/www.rst`（文件头写 `Version: 2.5 (2024-06-05)`），另外两个是 `specs/lifespan.rst` 和 `docs/introduction.rst`。

仓库这一头，`make ch18` 整个跑下来约 2 分半（压测占了大头：4 次搜索加 6 次 `/health`），完整测试、类型检查和格式检查：

```text
$ make ch18 > /tmp/ch18_make.txt 2>&1; echo $?; \
    grep -c '^ok' /tmp/ch18_make.txt
0
9
$ python3 -m pytest | tail -1
886 passed, 1 xfailed, 1 warning in 32.70s
$ make typecheck | tail -2
Success: no issues found in 40 source files
0 errors, 0 warnings, 0 informations
```

9 个 `ok` 是 8 个脚本加 `extra.sh`。`_fail.py` 结尾的两个脚本按约定必须以非零状态退出，`ok` 表示它们确实失败了。

## WSGI 与 ASGI：同一件事的两种接口

WSGI 的全部内容是一个函数签名：PEP 3333 第 212 到 221 行说，应用对象就是一个接受两个参数的可调用对象，能被反复调用；它调用 `start_response(status, headers)` 报告状态和头，再返回一个产出字节串的可迭代对象（第 233 到 238 行的 `simple_app` 就是这样写的）。服务器每收到一个请求调用它一次，函数返回，请求就结束了。ASGI 是同一件事的异步版本，但接口形状不一样。我不用服务器，直接把两个应用当函数调用一次：

```python
"""Call a WSGI app and an ASGI app by hand, with no server at all."""

import asyncio


def wsgi_app(environ, start_response):
    """Answer like PEP 3333 says: start_response, then an iterable."""
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [b"hello from WSGI at " + environ["PATH_INFO"].encode()]


async def asgi_app(scope, receive, send):
    """Answer like the ASGI spec says: events through send()."""
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/plain")],
        }
    )
    body = b"hello from ASGI at " + scope["path"].encode()
    await send({"type": "http.response.body", "body": body})


def call_wsgi() -> None:
    """Play the server: build environ, pass start_response, join."""
    seen = []

    def start_response(status, headers, exc_info=None):
        seen.append((status, headers))

    environ = {"REQUEST_METHOD": "GET", "PATH_INFO": "/x"}
    body = b"".join(wsgi_app(environ, start_response))
    print("WSGI:", seen[0], body)


async def call_asgi() -> None:
    """Play the server: scope, receive, send; print each event."""
    scope = {"type": "http", "method": "GET", "path": "/x"}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(event):
        print("ASGI send:", event)

    await asgi_app(scope, receive, send)


def main() -> None:
    """Run both."""
    call_wsgi()
    asyncio.run(call_asgi())


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/ch18/wsgi_asgi_by_hand.py
WSGI: ('200 OK', [('Content-Type', 'text/plain')]) b'hello from WSGI at /x'
ASGI send: {'type': 'http.response.start', 'status': 200, 'headers': [(b'content-type', b'text/plain')]}
ASGI send: {'type': 'http.response.body', 'body': b'hello from ASGI at /x'}
```

WSGI 那一边，应用的输出是 `start_response` 的参数加返回值；ASGI 那一边，应用没有返回值，它往 `send` 里一个一个地送事件，每个事件是一个字典，`type` 键说明它是什么。ASGI 的介绍文档（`docs/introduction.rst` 第 20 到 26 行）自己解释了为什么不直接把 WSGI 改成 `async def`：WSGI 是“一个同步的、拿一个请求返回一个响应的可调用对象”，容不下长连接，比如长轮询和 WebSocket；就算改成异步，请求也只有一个入口，WebSocket 帧这种“进来很多次”的事件没处放。ASGI 因此是 `async def app(scope, receive, send)`（第 32 到 36 行）：`scope` 描述这条连接，`receive` 取客户端发来的事件，`send` 往客户端发事件。一个类比，只用这一次：WSGI 像自动售货机，投币、出货，一次交易一进一出；ASGI 像一通电话，两边在挂断之前都可以随时说话。

HTTP 请求用到的事件在规范里是这几个：`http.request`（HTTP 规范 `specs/www.rst` 第 168 行，带 `body` 和 `more_body`）、`http.response.start`（第 203 行，状态和头）、`http.response.body`（第 230 行）和客户端提前走掉时收到的 `http.disconnect`（第 273 行）。除了 `http`，还有一种 `scope["type"]` 是 `lifespan`(`lifespan.rst`)，服务器用它通知应用“启动了”和“要关了”，对应事件 `lifespan.startup` 和 `lifespan.shutdown`，应用回 `.complete` 或 `.failed`。

Sift 的 FastAPI 应用也只是这样一个可调用对象。我不用 uvicorn，自己扮演服务器：先发 `lifespan.startup`，再发一个 `GET /health`，最后发 `lifespan.shutdown`，把应用送出来的东西都打印出来。脚本里要一个 `Searcher`，我把这部分和后面要用的服务器启动代码放进同一个小模块 `mini_app.py`（它读 `tests/fixtures/mini` 里 8 篇夹具文章，所以要在仓库根目录下跑）：

```python
"""Provide a Searcher and a threaded server to the scratch scripts."""

import socket
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from pathlib import Path

import uvicorn

from sift.config import Config
from sift.corpus import iter_documents
from sift.index import IndexWriter, InvertedIndex
from sift.search import Searcher
from sift.server.app import create_app

MINI = Path("tests/fixtures/mini")


def make_searcher() -> Searcher:
    """Index the eight fixture posts; run from the repository root."""
    index = InvertedIndex()
    with IndexWriter(index) as writer:
        for doc in iter_documents(MINI):
            writer.add(doc)
    return Searcher(index)


@contextmanager
def serving(proto: int = socket.IPPROTO_TCP) -> Iterator[str]:
    """Run the Sift app on uvicorn in a thread; yield its base URL.

    The listening socket is made here, with the given protocol number:
    0 is what socket.create_server passes, IPPROTO_TCP is what Sift's
    serve passes.
    """
    searcher = make_searcher()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM, proto)
    sock.bind(("127.0.0.1", 0))
    sock.listen(100)
    app = create_app(lambda: nullcontext(searcher), Config())
    server = uvicorn.Server(uvicorn.Config(app, log_config=None))
    thread = threading.Thread(target=server.run, args=([sock],))
    thread.start()
    while not server.started:
        time.sleep(0.01)
    try:
        yield f"http://127.0.0.1:{sock.getsockname()[1]}"
    finally:
        server.should_exit = True
        thread.join()
        sock.close()
```

```python
"""Drive the Sift app through raw ASGI messages: lifespan, one GET."""

import asyncio
from contextlib import nullcontext

from sift.config import Config
from sift.server.app import create_app

from mini_app import make_searcher


async def main() -> None:
    """Send lifespan.startup, one request and lifespan.shutdown."""
    app = create_app(lambda: nullcontext(make_searcher()), Config())
    inbox: asyncio.Queue[dict] = asyncio.Queue()
    outbox: asyncio.Queue[dict] = asyncio.Queue()
    life = asyncio.create_task(
        app(
            {"type": "lifespan", "asgi": {"version": "3.0"}},
            inbox.get,
            outbox.put,
        )
    )
    await inbox.put({"type": "lifespan.startup"})
    print("lifespan:", (await outbox.get())["type"])

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/health",
        "raw_path": b"/health",
        "root_path": "",
        "query_string": b"",
        "headers": [(b"host", b"127.0.0.1")],
        "client": ("127.0.0.1", 1),
        "server": ("127.0.0.1", 8000),
    }
    request = [{"type": "http.request", "body": b"", "more_body": False}]

    async def receive() -> dict:
        return request.pop() if request else {"type": "http.disconnect"}

    async def send(event: dict) -> None:
        print("send:", event)

    await app(scope, receive, send)
    await inbox.put({"type": "lifespan.shutdown"})
    print("lifespan:", (await outbox.get())["type"])
    await life


if __name__ == "__main__":
    asyncio.run(main())
```

```text
$ python3 /tmp/sift-scratch/ch18/asgi_messages.py
lifespan: lifespan.startup.complete
send: {'type': 'http.response.start', 'status': 200, 'headers': [(b'content-length', b'24'), (b'content-type', b'application/json')]}
send: {'type': 'http.response.body', 'body': b'{"status":"ok","docs":8}'}
lifespan: lifespan.shutdown.complete
```

这里没有 socket，没有 HTTP 解析，没有线程。`lifespan.startup.complete` 之前，应用已经打开了 `Searcher`（lifespan 一节会看到是哪几行）；`/health` 的响应是两个事件，状态行以外的东西全在 `headers` 里：`content-length: 24` 正好是 `{"status":"ok","docs":8}` 的字节数，`content-type` 是 `application/json`，这两个头都不是我写的。`docs` 是 8，因为这里的索引只含 8 篇夹具文章。

“应用”和“服务器”因此是两个可以单独换的东西：uvicorn 负责 socket、HTTP/1.1 解析和把事件翻译成字节，FastAPI 负责路由、校验和 JSON。Starlette 是 FastAPI 下面真正实现 ASGI 的那层，它的 `Router.lifespan`（`starlette/routing.py` 第 629 到 654 行）先 `await receive()` 等启动消息，进入 `lifespan_context`，成功就送出 `lifespan.startup.complete`，异常就送 `lifespan.startup.failed`（第 646 到 652 行）。FastAPI 的应用自己拼中间件栈（`fastapi/applications.py` 第 1020 到 1068 行，改自 `starlette/applications.py` 第 57 到 77 行）：最外层是 `ServerErrorMiddleware`，然后是用户加的中间件，再里面是 `ExceptionMiddleware`，FastAPI 在它里面又加了一层 `AsyncExitStackMiddleware`（第 1061 行），最里面是路由。

Sift 自己加了两个手写的 ASGI 中间件。`HostCheck`（`app.py` 第 291 到 315 行）是一个类：`__init__` 收下一层应用，`__call__(scope, receive, send)` 看 `scope["headers"]`，不合格就自己用 `send` 回一个 400，合格就 `await self.app(scope, receive, send)`。它拦 DNS 重绑定（网页用自己的域名连到 `127.0.0.1` 上的服务器），规则和第 17 篇的手写服务器一样。`QueryCheck`（第 318 到 352 行）同样的写法，只是它看的是 `scope["query_string"]`，下面异常处理一节会说它为什么存在。

## httpx：先用标准库问，再换 httpx

客户端先写，因为它最简单，而且第 17 篇的 `--raw` 服务器已经能回答。`lab/ch18/urllib_client.py` 起一个 `sift serve --raw`（临时目录里建好索引，端口交给系统挑），用标准库的 `urllib.request` 问四个问题：

```python
# lab/ch18/urllib_client.py (imports, show and main trimmed)
def get(url: str) -> tuple[int, dict[str, object]]:
    """Return the status and the JSON object of a GET."""
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:  # 4xx and 5xx raise
        with error:
            return error.code, json.load(error)
```

```text
$ python3 lab/ch18/urllib_client.py
server: http://127.0.0.1:35681
GET /health -> 200
   {'status': 'ok', 'docs': 123}
GET /search?q=rust+lifetime&limit=2 -> 200
  8.800  生命周期：让 token 借用源码
  7.791  所有权：SourceMap 里的 String 归谁
GET /search?q=(rust -> 400
   {'error': "expected ')'", 'query': '(rust', 'position': 5}
POST /health -> 405, Allow: GET, HEAD
```

urllib 够用，但什么都得自己来：拼 URL，读字节，解 JSON，4xx 变成 `HTTPError` 异常（所以 `get` 里要 `except` 一遍把状态码和响应体取出来），没有连接池，超时每次调用都要传。最后一行 `POST /health -> 405, Allow: GET, HEAD` 是第 17 篇服务器对不认识的方法的回答。

### Client 是什么：连接池，和一笔出乎意料的账

`httpx.Client` 是一个连接池加一组默认设置；`httpx.get()` 这类顶层函数每次调用都新建一个 `Client` 用完就关（`httpx/_api.py` 第 102 行 `with Client(`）。这个“新建”不便宜，我没有想到它这么不便宜。下面的脚本把 100 个 `GET /health` 的代价拆成三份：造 `Client`、新建连接、发请求。服务器是 `mini_app.serving()` 起的、跑在线程里的 uvicorn，监听套接字用 `IPPROTO_TCP`（原因在 uvicorn 一节）：

```python
"""Split the cost of 100 requests: client, connection, request."""

import time
from collections.abc import Callable

import httpx
from mini_app import serving

COUNT = 100


def per_call(label: str, work: Callable[[], object]) -> None:
    """Print the best of 3 runs of COUNT calls, in ms per call."""
    best = float("inf")
    for _ in range(3):
        start = time.perf_counter()
        for _ in range(COUNT):
            work()
        best = min(best, time.perf_counter() - start)
    print(f"{label:<40} {best / COUNT * 1000:6.2f} ms")


def main() -> None:
    """Measure each way of asking /health."""
    with serving() as base:
        per_call(
            "httpx.Client() and close, no request",
            lambda: httpx.Client().close(),
        )
        per_call(
            "httpx.Client(verify=False) and close",
            lambda: httpx.Client(verify=False).close(),
        )

        def new_client(**options: object) -> None:
            """Ask with a client of its own."""
            with httpx.Client(base_url=base, **options) as client:
                client.get("/health")

        per_call("new Client per request", new_client)
        per_call(
            "new Client(verify=False) per request",
            lambda: new_client(verify=False),
        )
        with httpx.Client(base_url=base) as shared:
            close = {"Connection": "close"}
            per_call(
                "one Client, a new connection each",
                lambda: shared.get("/health", headers=close),
            )
            per_call(
                "one Client, one connection reused",
                lambda: shared.get("/health"),
            )


if __name__ == "__main__":
    main()
```

```text
$ python3 -W ignore /tmp/sift-scratch/ch18/client_cost.py
httpx.Client() and close, no request       9.44 ms
httpx.Client(verify=False) and close       0.19 ms
new Client per request                    12.46 ms
new Client(verify=False) per request       1.05 ms
one Client, a new connection each          0.83 ms
one Client, one connection reused          0.60 ms
```

造一个什么都不做的 `httpx.Client()` 再关掉要 9.44 毫秒，加上 `verify=False` 只要 0.19 毫秒。`Client()` 默认 `verify=True`，`HTTPTransport.__init__` 会调 `create_ssl_context`（`httpx/_transports/default.py` 第 153 行，异步版第 297 行），走到 `ssl.create_default_context(cafile=certifi.where())`（`httpx/_config.py` 第 40 行）：每个新 `Client` 都要为 `certifi` 的 CA 证书包做一遍这件事，时间具体花在读文件还是解析证书上，我没有再拆。这个请求是明文 HTTP，一个证书也用不上，照样付这笔钱。

所以“每个请求一个新 Client”的 12.46 毫秒里，9.44 毫秒是造 `Client`，剩下约 3 毫秒才是连接和请求。同一个 `Client` 每次都新建 TCP 连接 (`Connection: close`) 是 0.83 毫秒，复用连接是 0.60 毫秒，只差 0.23 毫秒。回环上的明文连接便宜得很；换成远端 HTTPS，握手要多几个往返，差会大得多，我没有测。所以“复用 `Client`”这条建议在这个场景里主要省的是造它的钱，不是省连接。

`lab/ch18/httpx_sync_async.py` 用 `SiftClient`（`sift/client.py` 里的同步客户端）和一个真实的 `sift serve` 再做一遍：100 个请求每次一个新 `Client`，对共用一个，后半段是 50 个搜索一起发。这里只贴后半段的代码：

```python
# lab/ch18/httpx_sync_async.py (imports, first half, main omitted)
async def fifty_at_once(base: str) -> None:
    """Search 50 times at once, over a pool of 100 and of 5."""
    words = ["rust", "kalman", "kernel", "device tree", "async"]
    async with AsyncSiftClient(base) as client:
        start = time.perf_counter()
        results = await asyncio.gather(
            *(client.search(words[i % 5], limit=1) for i in range(50))
        )
        wall = time.perf_counter() - start
    print(f"50 searches, pool of 100: {wall:.2f} s")
    print("totals:", sorted({r.total for r in results}))
    limits = httpx.Limits(max_connections=5)
    async with httpx.AsyncClient(base_url=base, limits=limits) as http:
        start = time.perf_counter()
        answers = await asyncio.gather(
            *(
                http.get("/search", params={"q": words[i % 5], "limit": 1})
                for i in range(50)
            )
        )
        wall = time.perf_counter() - start
    print(f"50 searches, pool of 5:   {wall:.2f} s")
    print("statuses:", {a.status_code for a in answers})
```

```text
$ python3 lab/ch18/httpx_sync_async.py
server: http://127.0.0.1:41661
timeout default: Timeout(timeout=5.0)
100 requests, a client each:  1209.3 ms
100 requests, one client:      108.0 ms
50 searches, pool of 100: 0.83 s
totals: [4, 7, 8, 43]
50 searches, pool of 5:   0.81 s
statuses: {200}
```

前半段的结果：100 个请求，每次一个新 `Client` 是 1209.3 毫秒，共用一个是 108.0 毫秒，11.2 倍，每个请求 12.1 毫秒对 1.1 毫秒。前者和上面拆出来的 12.46 毫秒对得上；后者比复用连接的 0.60 毫秒高，多出来的部分是独立的服务器进程和 `SiftClient.health()` 里把响应解析成模型的时间，我没有拆开量。

50 个搜索那一半：`AsyncSiftClient` 默认的连接池最多 100 个连接（`httpx/_config.py` 第 247 行，`Limits(max_connections=100, max_keepalive_connections=20)`），50 个请求各占一个连接，共 0.83 秒；换成只允许 5 个连接的 `httpx.AsyncClient`，另外 45 个请求在客户端排队，结果 0.81 秒，没有区别。原因在服务器：搜索是 CPU 活，`Runtime` 里一把锁让一次只跑一个，50 个搜索排队，每个约 16 毫秒，50 × 16 ≈ 0.8 秒，客户端同时开 5 个还是 50 个连接都一样。`totals: [4, 7, 8, 43]` 是 5 个查询词的命中数（有两个词命中数相同），用来确认两种客户端拿到的是同一批答案。客户端的池再大，也帮不了一个串行的服务器。

### 超时和异常

默认超时是 `Timeout(timeout=5.0)`（`httpx/_config.py` 第 246 行，上面输出的 `timeout default` 那一行）：连接、读、写、从池里拿连接各 5 秒。`lab/ch18/httpx_timeout_fail.py` 在脚本里起一个小 asyncio 服务器，`/slow` 在发出第一个字节之前睡 2 秒，客户端把读超时设成 0.3 秒：

```python
# lab/ch18/httpx_timeout_fail.py (server handler omitted)
async def main() -> None:
    """Ask /fast, then /slow with a read timeout of 0.3 s."""
    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    timeout = httpx.Timeout(5.0, read=0.3)
    print("timeout:", timeout)
    async with server, httpx.AsyncClient(timeout=timeout) as client:
        base = f"http://127.0.0.1:{port}"
        fast = await client.get(f"{base}/fast")
        print("/fast ->", fast.status_code, fast.json())
        # error: httpx.ReadTimeout, after 0.3 s of silence
        slow = await client.get(f"{base}/slow")
        print("unreachable:", slow.status_code)

```

```text
$ python3 -u lab/ch18/httpx_timeout_fail.py 2>&1 | grep -v '^ \|^$'
timeout: Timeout(connect=5.0, read=0.3, write=5.0, pool=5.0)
/fast -> 200 {'ok': True}
Traceback (most recent call last):
httpcore.ReadTimeout
The above exception was the direct cause of the following exception:
Traceback (most recent call last):
httpx.ReadTimeout
```

脚本故意不捕获这个异常，退出码是 1。回溯有 97 行，我用 `grep` 去掉缩进的帧，只留标题行。先打印的是 `httpcore.ReadTimeout`（`httpcore` 是 httpx 下面真正管连接的库），它是原因；最后一行是 `httpx.ReadTimeout`，调用方看到的是这个；中间那句“直接原因”说明后者是 `raise ... from` 出来的。`httpx/_transports/default.py` 第 96 到 118 行的 `map_httpcore_exceptions` 做的就是这个翻译，并且挑最具体的 httpx 异常类（注释举的例子正是 `httpcore.ReadTimeout` 要变成 `httpx.ReadTimeout`，不是它的父类 `TimeoutException`）。调用方只认 httpx 的异常，不必知道底下换过库。

### Sift 的客户端：把状态码翻译回 Sift 的异常

`sift/client.py` 的 `SiftClient` 和 `AsyncSiftClient` 各持有一个 `httpx.Client` 或 `AsyncClient`，方法返回 pydantic 模型而不是字典。核心是两个函数：

核心是 `check` 和 `parse` 两个函数（`src/sift/client.py` 第 67 到 87 行）：

200 以外的响应先试着按 `ErrorResponse` 解析：带 `query` 和 `position` 的 400 变回 `QuerySyntaxError`，也就是 `sift search` 在本地会抛的那个异常，其余变成带状态码的 `ApiError`。响应体根本不是 JSON（比如 uvicorn 自己拒绝一个坏请求时回的纯文本 400），`model_validate_json` 抛 `ValidationError`，就退回用状态行里的原因短语。`parse` 用 `model_validate_json(response.content)` 直接从字节解析，不先过 `json.loads`，下一节会量这条路径。

这个客户端有两组测试：`tests/test_client.py` 用 `httpx.MockTransport` 在不开 socket 的情况下测 13 个用例；`tests/test_raw_server.py` 在夹具里起第 17 篇的服务器，用 `AsyncSiftClient` 真的连上去问，7 个用例，其中有 `test_a_slow_search_is_a_read_timeout` 和 `test_a_closed_port_is_a_connect_error`。这些用例我只跑了，没有逐行重读，结果在文件表里。`sift/client.py` 自己的超时是 15 秒 (`TIMEOUT`)，比服务器的 `SEARCH_TIMEOUT` 10 秒长，这样太慢的搜索回来的是服务器的 504，客户端抛 `ApiError`，不是自己先超时抛 `httpx.ReadTimeout`；`test_the_client_waits_longer_than_the_server` 守着这个关系，我没有另外做实验。

## pydantic v2：类型注解变成校验，校验跑在 Rust 里

第 15 篇我用描述符写了 `Config`：每个设置赋值时检查范围，拒绝就抛 `ConfigError`。pydantic 做同一类事，只是规则写在类型注解里，检查的代码不是我写的。`lab/ch18/pydantic_models.py` 定义一个 `Hit` 模型，规则和 `Config` 差不多：

```python
# lab/ch18/pydantic_models.py (imports and main omitted)
class Hit(BaseModel):
    """One search hit; the rules live in the annotations."""

    model_config = ConfigDict(frozen=True)

    doc_id: Annotated[int, Field(ge=0)]
    title: str = Field(min_length=1, max_length=120)
    score: float = 0.0
    tags: list[str] = Field(default_factory=list)
    path: str | None = None

    @field_validator("title")
    @classmethod
    def strip_title(cls, value: str) -> str:
        """Strip the spaces around the title; reject a blank one."""
        value = value.strip()
        if not value:
            raise ValueError("title is blank")
        return value

    @model_validator(mode="after")
    def tags_are_unique(self) -> Hit:
        """Reject a tag that appears twice."""
        if len(set(self.tags)) != len(self.tags):
            raise ValueError("tags repeat")
        return self


class Counts(BaseModel):
    """The same field, lax by default and strict on request."""

    lax: int
    strict: StrictInt


def try_hit(**data: object) -> None:
    """Build a Hit; print it or the first error."""
    try:
        print("  ok:", Hit(**data))
    except ValidationError as error:
        first = error.errors(include_url=False)[0]
        print(f"  error at {first['loc']}: {first['msg']}")
```

```text
$ python3 lab/ch18/pydantic_models.py | sed -n 1,12p
defaults:
  ok: doc_id=1 title='Rust lifetimes' score=0.0 tags=[] path=None
lax coercion (str to int and float):
  ok: doc_id=7 title='x' score=1.5 tags=[] path=None
constraints:
  error at ('doc_id',): Input should be greater than or equal to 0
  error at ('title',): String should have at most 120 characters
validators:
  error at ('title',): Value error, title is blank
  error at (): Value error, tags repeat
not a number:
  error at ('doc_id',): Input should be a valid integer, unable to parse string as an integer
```

逐行看。`title="  Rust lifetimes  "` 进去，出来是 `'Rust lifetimes'`：`field_validator` 默认在 pydantic 自己的类型检查之后运行，拿到的已经是 `str`，返回什么字段就是什么。`doc_id="7"` 和 `score="1.5"` 是字符串，模型照样收下并转成 `7` 和 `1.5`，这是默认的“宽松”模式；`"seven"` 转不了，才报 `unable to parse string as an integer`。`title="   "` 三个空格能通过 `min_length=1`，到了 `strip_title` 才被拒绝，位置还是 `('title',)`。`model_validator(mode="after")` 看整个模型，错误位置是空元组。`frozen=True`、严格模式和 `model_dump_json` 这些脚本后半段也演示了，输出在仓库的 `out/ch18/pydantic_models.stdout` 里，这里不贴。

### 错误是数据

失败的时候 `ValidationError` 不是一句话，是一个错误列表。`pydantic_validation_fail.py` 先把错误当数据读，再不捕获地抛一次：

```python
# lab/ch18/pydantic_validation_fail.py (imports omitted)
class SearchRequest(BaseModel):
    """What a client may ask: a non-blank query and 1 to 100 hits."""

    q: str = Field(min_length=1)
    limit: int = Field(default=10, ge=1, le=100)
    page: int = 1


BAD = {"q": "", "limit": "lots", "page": 2.5}


def main() -> None:
    """Show the error twice: as data, then uncaught."""
    try:
        SearchRequest(**BAD)
    except ValidationError as error:
        print(f"{error.error_count()} errors")
        for problem in error.errors(include_url=False):
            print(" ", problem["loc"], problem["type"], "-", problem["msg"])
    # error: pydantic_core._pydantic_core.ValidationError:
    # 3 validation errors for SearchRequest
    SearchRequest(**BAD)
    print("unreachable")
```

```text
$ python3 -u lab/ch18/pydantic_validation_fail.py 2>&1 | sed -n '1,4p;14,17p'
3 errors
  ('q',) string_too_short - String should have at least 1 character
  ('limit',) int_parsing - Input should be a valid integer, unable to parse string as an integer
  ('page',) int_from_float - Input should be a valid integer, got a number with a fractional part
pydantic_core._pydantic_core.ValidationError: 3 validation errors for SearchRequest
q
  String should have at least 1 character [type=string_too_short, input_value='', input_type=str]
    For further information visit https://errors.pydantic.dev/2.13/v/string_too_short
```

输出只留了开头四行和异常头的前几行（完整回溯 23 行）。三个字段各出一个错：空字符串违反 `min_length`，`"lots"` 解析不成整数，`2.5` 给 `int` 字段被拒绝，原因是带小数部分（宽松模式收 `2.0`，不收 `2.5`：我另外跑了 `TypeAdapter(int).validate_python`，`2.0` 给出 `2`，`2.5` 报 `int_from_float`）。`errors()` 的每一项有 `loc`、`type` 和 `msg`，`type` 是稳定的机器可读标识，`msg` 给人看。退出码是 1。脚本里 `# error:` 注释写的就是这个类全名和消息的第一行。

### 校验器是 Rust 对象

`Hit(...)` 干了什么？`BaseModel.__init__`（`pydantic/main.py` 第 253 到 263 行）只做一件事：把关键字参数收成字典，交给 `self.__pydantic_validator__.validate_python(data, self_instance=self)`。这个校验器是类创建的时候按注解建好的，每个模型类一个（`pydantic/_internal/_model_construction.py` 第 690 行 `cls.__pydantic_validator__ = create_schema_validator(`）。我把它拿出来看看：

```python
"""Look at what a pydantic model owns: a validator made in Rust."""

import pydantic_core
from pydantic import BaseModel, Field


class Settings(BaseModel):
    """Two constrained fields."""

    limit: int = Field(default=10, ge=1, le=100)
    b: float = Field(default=0.75, ge=0.0, le=1.0)


def main() -> None:
    """Print the validator, its schema and where the code lives."""
    validator = Settings.__pydantic_validator__
    print("validator type:", type(validator))
    print("module file   :", pydantic_core._pydantic_core.__file__[-48:])
    print("core version  :", pydantic_core.__version__)
    schema = Settings.__pydantic_core_schema__
    print("schema keys   :", sorted(schema))
    fields = schema["schema"]["fields"]["limit"]["schema"]
    print("limit field   :", fields)
    state = validator.validate_python({"limit": "7"})
    print("validated     :", state)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/ch18/pydantic_core_peek.py
validator type: <class 'pydantic_core._pydantic_core.SchemaValidator'>
module file   : e/_pydantic_core.cpython-314-x86_64-linux-gnu.so
core version  : 2.46.4
schema keys   : ['cls', 'config', 'custom_init', 'metadata', 'ref', 'root_model', 'schema', 'type']
limit field   : {'type': 'default', 'schema': {'type': 'int', 'ge': 1, 'le': 100}, 'default': 10}
validated     : limit=7 b=0.75
```

校验器的类型是 `pydantic_core._pydantic_core.SchemaValidator`，来自一个编译好的 `.so`（第二行只留了路径的最后 48 个字符），版本 2.46.4。`__pydantic_core_schema__` 是一个字典：`limit` 字段是 `{'type': 'default', 'schema': {'type': 'int', 'ge': 1, 'le': 100}, 'default': 10}`，注解里的 `Field(ge=1, le=100)` 成了 `ge`、`le` 两个键。这个字典交给 Rust 一次，Rust 把它编译成一棵校验器对象树，以后每次 `validate_python` 都在树上走。

Rust 这边我读了 `pydantic/pydantic` 仓库 `v2.13.4` 标签下的 `pydantic-core/`：`src/lib.rs` 第 109 到 118 行用 `#[pymodule]` 导出 `SchemaValidator`；`src/validators/mod.rs` 第 112 到 124 行是 `SchemaValidator` 结构体，里面是一个 `Arc<CombinedValidator>`，第 181 到 213 行是 `validate_python`；带 `ge`、`le` 约束的整数校验器是 `src/validators/int.rs` 第 116 到 183 行的 `ConstrainedIntValidator`：它的 `validate` 先 `input.validate_int(...)` 把输入变成整数（`"7"` 能不能当 7 由这一步决定），再比较 `multiple_of`、`le`、`lt`、`ge`、`gt`。`Cargo.toml` 第 30 行依赖 `pyo3 = "0.28"`，第 48 行依赖 `jiter = "0.14.0"`。PyO3 是写 Python 扩展的 Rust 库；Rust 编成动态库、别的语言来调用，这个最小版本我在 Pebble 系列的 [FFI 那一篇里“让 C 调用 Rust”的 `cdylib` 一节]（/posts/rust-by-pebble-13-ffi-nostd/#no_mangle-与-cdylib做一个-c-能链接的共享库）里用 C 程序走过一遍，PyO3 在这之上多做的，是让 Rust 函数直接拿 Python 对象当参数，第 25 篇我会自己写一个。

JSON 这条路径更直接：`validate_json`（`mod.rs` 第 257 到 290 行）把字节交给 `jiter::JsonValue::parse_with_config`（第 480 行），得到的是 Rust 一侧的 JSON 值，校验器直接在上面走，中间不产生 Python 的 `dict`。

### 校验一个对象多少钱

“Rust 写的”听着像“快”，但它得和 Python 对象打交道：输入是 Python 对象，输出也是，每个字段要跨一次边界。我想知道这笔账。`pydantic_vs_dataclass.py` 用三个类装同样的三个设置 (`limit`, `k1`, `b`)：第 15 篇的描述符版 `Config`，pydantic 的 `Model`，和什么都不检查的 `dataclass`；每个格子取 5 次测量的最小值，单位纳秒每个对象：

```python
# lab/ch18/pydantic_vs_dataclass.py (second half of main omitted)
def per_object(
    label: str, call: Callable[[], object], base: float | None
) -> float:
    """Time call() N times; print ns per object; return that number."""
    best = min(timeit.repeat(call, number=N, repeat=REPEAT)) / N * 1e9
    ratio = "" if base is None else f"  {best / base:5.1f}x plain"
    print(f"{label:<38} {best:8.0f} ns{ratio}")
    return best


def main() -> None:
    """Print the cost of building one object each way."""
    values = VALUES
    plain = per_object("dataclass(**dict)", lambda: Plain(**values), None)
    per_object(
        "Config(**dict)   (descriptors)", lambda: Config(**values), plain
    )
    per_object("Model(**dict)", lambda: Model(**values), plain)
    per_object(
        "Model.model_validate(dict)",
        lambda: Model.model_validate(values),
        plain,
    )
    per_object(
        "TypeAdapter(Model).validate_python",
        lambda: ADAPTER.validate_python(values),
        plain,
    )
    per_object(
        "Model.model_construct(**dict)  (no check)",
        lambda: Model.model_construct(**values),
        plain,
    )
```

```text
$ python3 lab/ch18/pydantic_vs_dataclass.py
dataclass(**dict)                           238 ns
Config(**dict)   (descriptors)             2440 ns   10.3x plain
Model(**dict)                               991 ns    4.2x plain
Model.model_validate(dict)                 1114 ns    4.7x plain
TypeAdapter(Model).validate_python          930 ns    3.9x plain
Model.model_construct(**dict)  (no check)     2041 ns    8.6x plain
-- from JSON text
json.loads + dataclass(**d)                1763 ns    7.4x plain
json.loads + Config(**d)                   4108 ns   17.3x plain
Model.model_validate_json(text)            1210 ns    5.1x plain
-- a bad value (limit=0): cost of the refusal
Config(limit=0) raises ConfigError         2633 ns
Model(limit=0) raises ValidationError      1457 ns
```

这些数出自 `make ch18` 里的一次运行：

- 什么都不检查的 `dataclass(**dict)` 238 纳秒；`Model.model_validate(dict)` 1114 纳秒，4.7 倍；`TypeAdapter(Model).validate_python` 930 纳秒，3.9 倍，我猜是因为它省掉了建模型实例的外壳，这一点没有拆开量。这 1114 纳秒买的是三个字段的类型转换和范围检查，dataclass 的 238 纳秒什么也没买。
- 第 15 篇的 `Config(**dict)` 2440 纳秒，10.3 倍，比 pydantic 慢一倍多：同样的规则，Python 写的检查比 Rust 写的慢。
- `Model.model_construct(**dict)` 是“不校验”的入口，我以为它该是最快的：2041 纳秒，比校验的版本还慢近一倍。`pydantic/main.py` 第 317 到 391 行解释了：它是一段纯 Python，一个字段一个字段地查别名、查默认值、往 `__dict__` 里塞，没有一步在 Rust 里。校验的版本一次进 Rust 做完，反而更快。“跳过校验会更快”在这个版本上不成立。
- 从 JSON 文本开始：`json.loads` 再 `Config(**d)` 是 4108 纳秒，`Model.model_validate_json(text)` 是 1210 纳秒，3.4 倍，走的是上面说的 `jiter` 路径。

放进更大的账里：一个 FastAPI 请求在进程内要 48 微秒左右（后面会量），pydantic 的 1 微秒约占 2%。贵不贵取决于拿什么比：和不做检查的 `dataclass` 比它是 4.7 倍，和自己写的 Python 检查比它是一半。

### Sift 的五个模型

`sift/server/models.py` 把 HTTP 契约写成五个模型：`HitModel`、`SearchResponse`、`DocumentResponse`、`HealthResponse`、`ErrorResponse`。服务器用它们当响应模型，客户端用它们解析答案，两头是同一份定义，除 `ErrorResponse` 外都是 `ConfigDict(frozen=True)`，`HitModel.from_hit` 这类类方法把第 8 篇的 `Hit` 数据类转成模型。值得看的是 `ErrorResponse`：

```python
# src/sift/server/models.py
class ErrorResponse(BaseModel):
    """The body of every 4xx and 5xx answer.

    ``query`` and ``position`` are there for a malformed query only.
    """

    error: str
    query: str | None = None
    position: int | None = None
```

`query` 和 `position` 默认是 `None`，只有语法错误的 400 才带它们；序列化时 `model_dump(exclude_none=True)`（`app.py` 的 `error_response`）把 `None` 去掉，别的错误就只剩 `{"error": ...}`。`HealthResponse.status` 的类型是 `Literal["ok"]`，别的值构造不出来。

## FastAPI：路由、参数和响应模型

三个接口的契约在第 17 篇定过了，这一篇的目标是让 FastAPI 的实现对同样的请求给出同样的状态码和同样的 JSON。参数的规则写在类型别名里（`src/sift/server/app.py` 第 153 到 172 行）：

```python
# src/sift/server/app.py
QueryText = Annotated[
    str,
    AfterValidator(not_blank),
    Query(description="the query, in the Sift query language"),
]
# The order matters: pydantic puts a constraint on the schema built so
# far, and after BeforeValidator that schema is the validator, which
# does not know "ge" (the OpenAPI document would say "ge", not
# "minimum"). So Field(ge, le) goes first.
Limit = Annotated[
    int,
    Field(ge=LIMIT_MIN, le=LIMIT_MAX),
    BeforeValidator(parse_limit),
    Query(description="most hits to return (default: [search] limit)"),
]
DocId = Annotated[
    str,
    Path(pattern=r"^[0-9]+$", description="document id, ASCII digits"),
]

```

`Annotated[str, ..., Query(...)]` 是 FastAPI 读参数的方式：类型是 `str`，元数据里的 `Query()` 说这个参数来自查询字符串，`AfterValidator(not_blank)` 是 pydantic 的校验器，空白的 `q` 在这里变成 `ValueError`。`DocId` 用 `Path(pattern=...)`，因为路径里的 `{doc_id}` 会被 Starlette 编译成 `(?P<doc_id>[^/]+)`（`starlette/routing.py` 第 110 到 163 行的 `compile_path`，`[^/]+` 在 `starlette/convertors.py` 第 20 到 21 行），不加 `pattern`，`/docs/abc` 也会进到路由里。路由函数本身只剩业务（第 453 到 461 行）：

```python
# src/sift/server/app.py (inside create_app)
    async def search(
        q: QueryText, runtime: RuntimeDep, limit: Limit = config.limit
    ) -> SearchResponse:
        """Return the best documents for the query q.

        A malformed query is 400 with `query` and `position`.
        """
        result = await runtime.search(q, limit)
        return SearchResponse.from_result(result)
```

返回类型 `SearchResponse` 和注册时的 `response_model=SearchResponse`（第 492 到 498 行的 `app.add_api_route`）告诉 FastAPI 响应长什么样。注册路由时 FastAPI 只做一次的事，是把函数签名读成一棵依赖树（`fastapi/routing.py` 第 839 到 853 行），`APIRoute` 在第 1208 行把处理函数包成 ASGI 应用；每个请求都走的路径在 `get_request_handler` 里：第 398 行定义的内层函数 `app(request)` 先调 `solve_dependencies`（第 473 行）解出所有参数并校验，再 `run_endpoint_function`（第 690 行）调我的函数，最后 `serialize_response`（第 711 行）。最后一步（`serialize_response`，第 293 到 334 行）我只读了源码：它先用响应模型的字段把我返回的对象**再校验一遍**，通过了才序列化；没有自定义响应类的时候（第 703 到 731 行，变量 `use_dump_json`）直接走 pydantic 的 `serialize_json`，源码注释的大意是：经由 pydantic 的 Rust 核心直接序列化成 JSON 字节，跳过中间的 Python dict 和 `json.dumps()`。“再校验一遍”这一点我没有另写实验，算未验证。

`Limit` 别名里有个顺序问题，源码留了一段注释（第 158 到 161 行），我想确认它说的是真的。下面的脚本做两个别名，`Field(ge=1, le=100)` 放在 `BeforeValidator` 前面和后面，看 FastAPI 为同一个参数生成的 OpenAPI 模式：

```python
"""Show how the order of Field and BeforeValidator changes OpenAPI."""

import json
from typing import Annotated

from fastapi import FastAPI, Query
from pydantic import BeforeValidator, Field


def to_int(value: object) -> int:
    """Turn a query string into an int."""
    return int(str(value))


FIELD_FIRST = Annotated[
    int, Field(ge=1, le=100), BeforeValidator(to_int), Query()
]
VALIDATOR_FIRST = Annotated[
    int, BeforeValidator(to_int), Field(ge=1, le=100), Query()
]


def schema_of(alias: object) -> str:
    """Return the OpenAPI schema FastAPI writes for the parameter."""
    app = FastAPI()

    @app.get("/")
    def route(limit: alias = 10) -> None:  # type: ignore[valid-type]
        """Take one parameter."""

    spec = app.openapi()
    parameter = spec["paths"]["/"]["get"]["parameters"][0]
    return json.dumps(parameter["schema"])


def main() -> None:
    """Print the two schemas."""
    print("Field first:         ", schema_of(FIELD_FIRST))
    print("BeforeValidator first:", schema_of(VALIDATOR_FIRST))


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/ch18/annotated_order.py
Field first:          {"type": "integer", "maximum": 100, "minimum": 1, "default": 10, "title": "Limit"}
BeforeValidator first: {"type": "integer", "ge": 1, "le": 100, "default": 10, "title": "Limit"}
```

`Field` 在前，OpenAPI 里是 `minimum` 和 `maximum`，这是 JSON Schema 认的关键字；`BeforeValidator` 在前，输出里是 `ge` 和 `le`，不是 OpenAPI 的关键字，文档生成器和客户端代码生成器都不认。原因照注释说的：pydantic 把约束加到“到目前为止的模式”上，`BeforeValidator` 之后当前的模式是一个函数校验器，它没有 `ge` 这个概念，约束就被原样塞进去，变成一个没有意义的键。`Annotated` 里元数据的顺序是有语义的，从左到右一层层套上去。

`parse_limit`（第 135 到 150 行）是 `limit` 的 `BeforeValidator`，为什么不直接用 `int`？因为第 17 篇的服务器只认 ASCII 数字，pydantic 的整数解析会多收一些：

```text
$ python3 -c "from pydantic import TypeAdapter; ta = TypeAdapter(int); \
print([ta.validate_python(x) for x in (' 5 ', '1_0', '1.0')])"
[5, 10, 1]
```

`" 5 "`、`"1_0"` 和 `"1.0"` 都被收下了。两个服务器要给同样的答案，字符串就交给第 17 篇服务器的 `limit_from_text`：只认 ASCII 数字，超过三位的数不转换直接按越界处理（`int()` 对几千位的数字符串会抛错，原来的写法在两个服务器上都会因此回 500，现在 `test_a_limit_of_thousands_of_digits_is_400_in_both_servers` 守着），范围检查交给 `Config.limit.validate`，也就是第 15 篇的描述符。这是框架“悄悄替我决定了”的一个例子：默认值合理，但它不是我契约里的值。

## 依赖注入

`Depends` 是 FastAPI 里我最先觉得别扭、后来离不开的东西。`lab/ch18/fastapi_di.py` 是脱离 Sift 的小例子，三种依赖：一个类（`Paging`，`__init__` 的参数就是查询参数），一个带 `yield` 的生成器（`get_index`，`yield` 之后的部分在响应发出之后运行），一个依赖于另一个依赖的函数 (`get_user`)：

```python
# lab/ch18/fastapi_di.py (docstrings, imports and EVENTS omitted)
class Paging:
    """A class as a dependency: __init__ takes the query parameters."""

    def __init__(self, page: int = 1, size: int = 10) -> None:
        """Turn page and size into an offset and a limit."""
        self.offset = (page - 1) * size
        self.limit = size


def get_index() -> Iterator[list[str]]:
    """Open the 'index' for one request; close it after the response."""
    EVENTS.append("open")
    try:
        yield ["tea", "river", "bicycle", "compiler", "bridges"]
    finally:
        EVENTS.append("close")


def get_user(index: Annotated[list[str], Depends(get_index)]) -> str:
    """A dependency of a dependency: FastAPI resolves index first."""
    return f"reader of {len(index)} posts"


Index = Annotated[list[str], Depends(get_index)]
# Depends() with no argument means the class of the annotation
PagingDep = Annotated[Paging, Depends()]
UserDep = Annotated[str, Depends(get_user)]

app = FastAPI()


@app.get("/posts")
def posts(index: Index, paging: PagingDep, user: UserDep) -> dict[str, object]:
    """List a page of posts."""
    page = index[paging.offset : paging.offset + paging.limit]
    return {"user": user, "offset": paging.offset, "posts": page}


def main() -> None:
    """Call the route, then call it with an overridden dependency."""
    with TestClient(app) as client:
        print(client.get("/posts?page=2&size=2").json())
        print("events after one request:", EVENTS)
        print(client.get("/posts?size=x").json()["detail"][0]["msg"])

        def two_posts() -> Iterator[list[str]]:
            yield ["only", "two"]

        app.dependency_overrides[get_index] = two_posts
        print(client.get("/posts").json())
        app.dependency_overrides.clear()
    print("events at the end:", EVENTS)
```

```text
$ python3 lab/ch18/fastapi_di.py
{'user': 'reader of 5 posts', 'offset': 2, 'posts': ['bicycle', 'compiler']}
events after one request: ['open', 'close']
Input should be a valid integer, unable to parse string as an integer
{'user': 'reader of 2 posts', 'offset': 0, 'posts': ['only', 'two']}
events at the end: ['open', 'close', 'open', 'close']
```

第一行：`page=2&size=2` 变成 `offset` 2。第二行是我最想看的：一个请求之后 `EVENTS` 是 `['open', 'close']`，只有一次 `open`。路由自己要 `index`，`get_user` 也要 `index`，但 FastAPI 在同一个请求里按依赖函数缓存结果（`fastapi/dependencies/utils.py` 第 664 到 684 行：`use_cache` 且 `cache_key` 已在 `dependency_cache` 里就直接用），所以 `get_index` 只调一次，`close` 排在响应之后。第三行是 `size=x` 的校验错误，和 pydantic 的消息一字不差。`size=x` 那个请求虽然报了错，`get_index` 已经解出来过，所以最后一行 `EVENTS` 里有两对 `open`、`close`。`app.dependency_overrides[get_index] = two_posts` 在不改路由的情况下换掉依赖，测试里换索引、换时钟都靠它，被换掉的那次请求不调 `get_index`，所以没有第三对。

### 一个 `def` 依赖的代价

Sift 的路由用的依赖叫 `RuntimeDep`，它是 `Annotated[Runtime, Depends(get_runtime)]`，`get_runtime`（`app.py` 第 234 到 247 行）从 `request.app.state.runtime` 取出 lifespan 里放进去的对象。我第一次写它的时候写成了 `def`，现在的版本是 `async def`，函数里的文档字符串解释了原因：FastAPI 对不是协程的依赖用 `run_in_threadpool`（`fastapi/dependencies/utils.py` 第 680 行，`starlette/concurrency.py` 第 32 到 34 行，里面是 `anyio.to_thread.run_sync`），每个请求把这个只读一个属性的函数送进工作线程，再唤醒事件循环取回结果。发现它是因为我想知道框架本身一个请求要多少钱，就在进程内测：不开 socket，不开 uvicorn，直接把 ASGI 事件喂给应用，和第 17 篇手写服务器里“解析请求头、分派、编码响应”这一段比：

```python
"""Time GET /health in process: FastAPI's ASGI call against the raw one.

No socket and no uvicorn on either side. The FastAPI side runs the
whole ASGI app (routing, dependencies, response model, JSON). The raw
side parses the head, dispatches and encodes the answer to bytes.
"""

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, nullcontext

from fastapi import FastAPI
from mini_app import make_searcher

from sift.config import Config
from sift.server.app import create_app
from sift.server.raw import RawServer, parse_head

COUNT = 20_000
HEAD = b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
SCOPE = {
    "type": "http",
    "asgi": {"version": "3.0"},
    "http_version": "1.1",
    "method": "GET",
    "scheme": "http",
    "path": "/health",
    "raw_path": b"/health",
    "root_path": "",
    "query_string": b"",
    "headers": [(b"host", b"127.0.0.1")],
    "client": ("127.0.0.1", 1),
    "server": ("127.0.0.1", 8000),
}


async def receive() -> dict:
    """Return the whole (empty) request body."""
    return {"type": "http.request", "body": b"", "more_body": False}


async def send(event: dict) -> None:
    """Drop what the application sends."""


@asynccontextmanager
async def started(app: FastAPI) -> AsyncIterator[None]:
    """Run the lifespan of app around the body."""
    inbox: asyncio.Queue[dict] = asyncio.Queue()
    outbox: asyncio.Queue[dict] = asyncio.Queue()
    scope = {"type": "lifespan"}
    life = asyncio.create_task(app(scope, inbox.get, outbox.put))
    await inbox.put({"type": "lifespan.startup"})
    await outbox.get()
    yield
    await inbox.put({"type": "lifespan.shutdown"})
    await life


async def micros(call) -> float:
    """Return the best of 5 runs of COUNT calls, in us per call."""
    best = float("inf")
    for _ in range(5):
        start = time.perf_counter()
        for _ in range(COUNT):
            await call()
        best = min(best, time.perf_counter() - start)
    return best / COUNT * 1e6


async def main() -> None:
    """Print the two costs."""
    searcher = make_searcher()
    app = create_app(lambda: nullcontext(searcher), Config())
    raw = RawServer(searcher, Config())

    async def fastapi() -> None:
        """Run the application once."""
        await app(SCOPE, receive, send)

    async def hand_written() -> None:
        """Parse, dispatch and encode once."""
        response = await raw.dispatch(parse_head(HEAD))
        response.encode()

    async with started(app):
        print(f"FastAPI  ASGI call      {await micros(fastapi):7.1f} us")
        print(f"raw      parse + encode {await micros(hand_written):7.1f} us")


if __name__ == "__main__":
    asyncio.run(main())
```

```text
$ python3 -W ignore /tmp/sift-scratch/ch18/asgi_overhead.py
FastAPI  ASGI call         47.7 us
raw      parse + encode    12.8 us
```

现在的 FastAPI 应用一个 `GET /health` 是 47.7 微秒，手写服务器同样的工作 12.8 微秒，约 4 倍（手写的一侧没有路由表，没有 OpenAPI，只有一个 `if`，这个比较是故意不公平的）。同一个脚本放到第一个提交 `9843488` 的树上跑（我把那个提交解到了 `/tmp/ch18-old`，用 `PYTHONPATH` 指过去），那时 `get_runtime` 还是 `def`：

```text
$ PYTHONPATH=/tmp/ch18-old/src \
    python3 -W ignore /tmp/sift-scratch/ch18/asgi_overhead.py
FastAPI  ASGI call        132.4 us
raw      parse + encode    12.7 us
```

同一个请求是 132.4 微秒，现在 47.7 微秒。

这 85 微秒有多少该归到 `def` 这一处，我没有单独隔离。我试过用 `dependency_overrides` 在 `def` 和 `async def` 之间切换做对照，但覆盖机制自己也要付钱：有覆盖时 FastAPI 每个请求都为替换的函数重新分析一次签名（`fastapi/dependencies/utils.py` 第 632 到 648 行），对照的两边都带着这笔钱，数字不干净，我没有把它放进这一篇。能说的只有这些：源码里 `def` 依赖走线程池；进程内两个提交差 85 微秒；后面对比一节里同一个压测脚本量到每个请求少了约 98 微秒；两个提交之间还有别的改动（`QueryCheck` 等）。所以 `get_runtime` 很可能是主要原因，不能说是唯一原因。

## lifespan：索引只打开一次

应用没有全局变量。`create_app` 接受一个“打开 Searcher 的函数”，`lifespan` 处理器在服务器启动时调它，在服务器停止时退出这个上下文：

```python
# src/sift/server/app.py (inside create_app)
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        """Open the Searcher for the life of the server."""
        with open_searcher() as searcher:
            runtime = Runtime(searcher, config, max_pending, search_timeout)
            app.state.runtime = runtime
            try:
                yield
            finally:
                # A search that still runs (uvicorn waits GRACE seconds
                # for requests, a search may take SEARCH_TIMEOUT) must
                # not find the index closed: wait for the lock, then
                # forbid new searches and let the index close.
                await anyio.to_thread.run_sync(runtime.lock.acquire)
                runtime.closed = True
                runtime.lock.release()
```

`@asynccontextmanager` 把一个带 `yield` 的异步生成器变成异步上下文管理器：`yield` 之前是启动，之后是关闭。关闭这一段是最后加的：uvicorn 关机时最多等 `GRACE` 秒让请求做完，一个搜索可能还要跑 `SEARCH_TIMEOUT` 那么久，不能让它跑到一半发现索引被关了。所以 `finally` 里先拿 `runtime.lock`，等正在跑的搜索让出来，再把 `closed` 设成 `True`，之后启动的搜索看到它就不跑。打开索引的上下文管理器是 `cli.py` 里的 `searching`，退出时由它收尾。`Runtime` 是路由之间共享的状态，下面是它的 `search`：

```python
# src/sift/server/app.py (inside Runtime; only search)
    async def search(self, query: str, limit: int) -> SearchResult:
        """Search in a worker thread; 503 if full, 504 if too slow.

        The caller is the loop thread, which owns ``pending``. A
        thread cannot be stopped: a search that already runs finishes
        and its answer is dropped.
        """
        if self.pending >= self.max_pending:
            raise HTTPException(
                503, "server busy", headers={"Retry-After": "1"}
            )
        abandoned = threading.Event()
        self.pending += 1
        try:
            with anyio.fail_after(self.search_timeout):
                return await anyio.to_thread.run_sync(
                    self._search,
                    query,
                    limit,
                    abandoned,
                    abandon_on_cancel=True,
                )
        except TimeoutError:
            raise HTTPException(
                504, f"search took more than {self.search_timeout:g} s"
            ) from None
        finally:
            abandoned.set()
            self.pending -= 1
```

这一段把第 17 篇的三道上限搬了过来。`pending` 超过上限直接 `HTTPException(503)`；搜索是 CPU 活，放进 `anyio.to_thread.run_sync` 的工作线程，不然会堵住事件循环（`abandon_on_cancel=True` 让等待方超时后不再等，线程里的搜索会跑完，结果丢掉）；`anyio.fail_after(self.search_timeout)` 到点抛 `TimeoutError`，变成 504。测试里每个用例都造一个新应用和一个新 `Searcher`，不共享状态，这是没有全局变量的好处。

## 异常处理：把框架的语言翻译回契约的语言

FastAPI 对坏的参数默认回 422，对没有的路由回 `{"detail": "Not Found"}`，对没捕获的异常回纯文本 500（这是它的默认行为，我没有单独跑）。契约要的是 400 加 `{"error": ..., "position": ...}`。`create_app` 注册了四个处理器（第 482 到 485 行）：

```python
# src/sift/server/app.py (inside create_app)
    app.add_exception_handler(QuerySyntaxError, syntax_error)
    app.add_exception_handler(RequestValidationError, invalid_request)
    app.add_exception_handler(HTTPException, http_error)
    app.add_exception_handler(Exception, crashed)
```

`QuerySyntaxError` 变成带 `query` 和 `position` 的 400；`RequestValidationError`（FastAPI 的参数校验失败，默认 422）变成 400，文案由 `validation_message` 按第一个错误翻成第 17 篇的原话；`HTTPException` 加上契约的形状；`Exception` 兜底成 JSON 500。前三个注册在 Starlette 的 `ExceptionMiddleware` 上，`Exception` 这一个不一样：FastAPI 自己的 `build_middleware_stack`（`fastapi/applications.py` 第 1027 到 1031 行）把键为 `500` 或 `Exception` 的处理器单独拿出来给最外层的 `ServerErrorMiddleware`，它在送出响应**之后重新抛出**异常（`starlette/middleware/errors.py` 第 183 到 186 行的注释说：这样服务器可以记日志，测试客户端可以选择在测试里抛出）。这条路径我没有另写实验，外部表现 (JSON 500) 由 `test_a_crash_is_a_json_500` 守着，重新抛出这一点只有源码注释为证，算未验证。

最初的版本到这里还差得远。同样的 19 个请求在两个服务器上答案一样，但换几个不那么规矩的请求就不一样了。后来补的几处都是从“再问一些”开始的：

- 尾部斜杠：Starlette 默认对 `/health/` 回 307 重定向到 `/health`，第 17 篇的服务器回 404。`create_app` 现在 `app.router.redirect_slashes = False`（第 478 行）。
- 文档路径：文档路由现在注册成 `/docs/{doc_id:path}`，`DocId` 的 `pattern` 再把 `/docs/`、`/docs/1/2` 变成 400 `bad document id`，和第 17 篇一致；OpenAPI 里它仍然叫 `/docs/{doc_id}`（下面 `openapi_dump.py` 的输出可以看到）。
- 查询串：Starlette 读查询串很宽松，不是 UTF-8 的字节变成 U+FFFD，没有等号的参数丢掉，同名参数取最后一个。第 17 篇的服务器一概拒绝，还限制最多 20 个参数。`QueryCheck`（第 318 到 352 行）是第三个 ASGI 中间件，它把第 17 篇的 `parse_params` 原样用在 `scope["query_string"]` 上，两个服务器因此接受同样的请求。

`extra.sh` 现在用 27 个请求把两个服务器各问一遍，去掉 `took_ms`，比较状态码和 JSON，不一样就让脚本失败。下面是开头两行和后来加的 8 行：

```text
$ sed -n '1,2p;20,28p' out/ch18/compare_bodies.txt
  identical 200 /health
  identical 200 /search?q=rust&limit=1
  identical 404 /health/
  identical 404 /search/?q=a
  identical 400 /docs/1/
  identical 400 /docs/
  identical 400 /docs/1/2
  identical 400 /docs/oauth2-redirect
  identical 400 /search?q=%FF
  identical 400 /search?q=a&x
27 of 27 identical (status and JSON, no took_ms)
```

最后一行是 `27 of 27 identical (status and JSON, no took_ms)`。单元测试 `tests/test_server.py` 里同样的比较有 47 个目标，直接把第 17 篇服务器的 `dispatch` 和 FastAPI 的 `TestClient` 答案并排。

## OpenAPI：文档是路由表的副产品

FastAPI 对每个路由都已经知道参数的类型和位置、响应模型的结构，所以文档不用写：`app.openapi()` 现成给出一个 OpenAPI 3.1 的 JSON。`lab/ch18/openapi_dump.py` 把它写到 `out/ch18/openapi.json` 并打印里面有什么：

```text
$ python3 lab/ch18/openapi_dump.py | sed -n 1,10p
wrote out/ch18/openapi.json (10108 bytes)
openapi: 3.1.0 - title: Sift
GET /health: -
    responses: 200
GET /search: q (query), limit (query, optional)
    responses: 200, 400, 4XX, 503, 504
GET /docs/{doc_id}: doc_id (path)
    responses: 200, 400, 404, 4XX
schemas: DocumentResponse, ErrorResponse, HealthResponse, HitModel, SearchResponse
limit parameter: {"type": "integer", "maximum": 100, "minimum": 1, "description": "most hits to return (default: [search] limit)", "default": 10, "title": "Limit"}
```

`limit` 的 `minimum` 和 `maximum`（`limit parameter` 那一行）来自 `Field(ge=1, le=100)`，响应的描述来自 `ERRORS` 字典。`ERRORS` 里有个奇怪的键 `"4XX"`，源码注释说它是为了让 FastAPI 别加上它自己的 422。我试一试：

```python
"""List the response codes OpenAPI shows with and without "4XX"."""

from fastapi import FastAPI
from pydantic import BaseModel


class Error(BaseModel):
    """The one error body."""

    error: str


def codes(responses: dict[int | str, dict[str, object]]) -> list[str]:
    """Return the response codes of GET /items?n=1 in the document."""
    app = FastAPI()

    @app.get("/items", responses=responses)
    def items(n: int) -> None:
        """Take one required integer."""

    spec = app.openapi()
    return list(spec["paths"]["/items"]["get"]["responses"])


def main() -> None:
    """Print the codes for three declarations."""
    body = {"model": Error}
    print("no responses:  ", codes({}))
    print("400 only:      ", codes({400: body}))
    print("400 and 4XX:   ", codes({400: body, "4XX": body}))


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/ch18/openapi_422.py
no responses:   ['200', '422']
400 only:       ['200', '400', '422']
400 and 4XX:    ['200', '400', '4XX']
```

不声明任何响应，FastAPI 给带参数的路由加 `422`；只声明 `400` 还是加（第二行）；声明了 `4XX` 才不加（第三行）。`fastapi/openapi/utils.py` 第 454 到 467 行写得很清楚：路由有参数或请求体字段，并且 `responses` 里没有 `422`、`4XX` 或 `default`，才补一个 422。契约里没有 422，文档就不该说有。

最后一个：Swagger 页面。`FastAPI()` 默认把它放在 `/docs`，而 Sift 的文档路由是 `/docs/{doc_id}`。`create_app` 把文档挪到了 `/api/docs`。起初我以为这两个不冲突，写了脚本验证，结果我错了一半。脚本对 Sift 的应用问六个路径，一次用 `PYTHONPATH` 指向解开的旧提交 `9843488`，一次用现在的树：

```python
"""Ask the Sift app for /docs paths that are not documents."""

from contextlib import nullcontext

from fastapi.testclient import TestClient
from mini_app import make_searcher

import sift
from sift.config import Config
from sift.server.app import create_app

PATHS = [
    "/api/docs",
    "/docs/5",
    "/docs/",
    "/docs/1/2",
    "/docs/oauth2-redirect",
    "/health/",
]


def main() -> None:
    """Print the status and the content type of each path."""
    print("tree:", "9843488" if "ch18-old" in sift.__file__ else "ch18")
    app = create_app(lambda: nullcontext(make_searcher()), Config())
    with TestClient(app) as client:
        for path in PATHS:
            response = client.get(path, follow_redirects=False)
            kind = response.headers.get("content-type", "-")
            kind = kind.split(";")[0]
            where = response.headers.get("location", "")
            print(f"GET {path:<22} -> {response.status_code} {kind} {where}")


if __name__ == "__main__":
    main()
```

```text
$ PYTHONPATH=/tmp/ch18-old/src \
    python3 -W ignore /tmp/sift-scratch/ch18/docs_route_clash.py
tree: 9843488
GET /api/docs              -> 200 text/html 
GET /docs/5                -> 200 application/json 
GET /docs/                 -> 404 application/json 
GET /docs/1/2              -> 404 application/json 
GET /docs/oauth2-redirect  -> 200 text/html 
GET /health/               -> 307 - http://testserver/health
$ python3 -W ignore /tmp/sift-scratch/ch18/docs_route_clash.py
tree: ch18
GET /api/docs              -> 200 text/html 
GET /docs/5                -> 200 application/json 
GET /docs/                 -> 400 application/json 
GET /docs/1/2              -> 400 application/json 
GET /docs/oauth2-redirect  -> 400 application/json 
GET /health/               -> 404 application/json 
```

`/api/docs` 是 Swagger 页面，`/docs/5` 是我的路由，两棵树都一样。不一样的在后面：旧树里 `GET /docs/oauth2-redirect` 回 200 的 HTML，那是 FastAPI 为 Swagger 的 OAuth2 登录放在 `/docs/oauth2-redirect` 的回调页（`fastapi/applications.py` 第 1139 到 1148 行，默认值第 458 行），它先于我的路由注册，所以第 17 篇服务器的 `400 bad document id` 在 FastAPI 这边变成了一个 HTML 页面。这是一个真实的冲突，不管文档 id 是不是只有数字：它抢的是路径，不是 id。旧树里 `/docs/` 和 `/docs/1/2` 回 404，`/health/` 回 307。现在的树里这些都和第 17 篇一致：`FastAPI(...)` 传了 `swagger_ui_oauth2_redirect_url=None` 关掉回调页，`redirect_slashes` 关了，文档路由接 `{doc_id:path}`，`/docs/oauth2-redirect` 就是 400 `bad document id`。

## TestClient：不开 socket 测应用

`fastapi.testclient.TestClient` 是 Starlette 的，用 `httpx` 当客户端，但不走网络，直接调 ASGI 应用。`with TestClient(app) as client` 很关键：进入 `with` 才会发 `lifespan.startup`（`tests/test_server.py` 开头的文档字符串就这么写），不用 `with`，lifespan 不跑，`app.state.runtime` 不存在。`fastapi_di.py` 的 stderr 里那条警告的来源是 `starlette/testclient.py` 第 34 到 51 行：它先试 `import httpx2`，找不到才退到 `httpx`，退的时候发一个 `StarletteDeprecationWarning`，文案是 ``Using `httpx` with `starlette.testclient` is deprecated; install `httpx2` instead.``。按警告的文字，以后 `TestClient` 要用一个叫 `httpx2` 的包。`httpx2` 是什么、是不是同一个项目的新名字，我没查，环境里也没有，所以这一篇的 `TestClient` 用的是 `httpx` 加警告；pytest 的 `1 warning` 就是它。

`tests/test_server.py` 一共 90 个用例，其中有 47 个目标的“和第 17 篇一样”，还有守着下一节两个问题的 `test_the_listening_socket_is_tcp_so_that_asyncio_sets_nodelay` 和 `test_idle_sockets_are_closed_and_do_not_lock_the_server_out`。

## uvicorn：从 socket 到 ASGI 事件，和三个没写在文档里的坑

应用有了，还差一个能让它收到 socket 上字节的东西。uvicorn 是 ASGI 服务器：监听、接受连接、用 h11 解析 HTTP/1.1，把请求翻译成 `scope` 和事件，再把应用 `send` 出来的事件翻译回字节。最直接的用法是 `uvicorn.run(app, host=..., port=...)`，但 `sift serve` 没有这样做：`uvicorn.run` 自己绑端口，绑不上就记一条日志然后 `sys.exit(3)`（`uvicorn/server.py` 第 180 行），而 Sift 的约定是绑不上退出码 1 加一行 `error: ...`；它还会装信号处理器，并在结束时重新发出信号。所以 `serve` 自己造 `uvicorn.Server`，自己绑好 socket 再交给它（`app.py` 第 513 到 537 行）：

```python
# src/sift/server/app.py
def listen(host: str, port: int, backlog: int) -> socket.socket:
    """Bind and listen; raise SiftError if that is not possible.

    uvicorn's own bind would log the error and exit 3, so the socket
    is made here and handed to uvicorn. It is made with the TCP
    protocol number, not 0 as ``socket.create_server`` does:
    asyncio sets TCP_NODELAY only on sockets whose ``proto`` is TCP,
    and an accepted socket inherits the ``proto`` of the listening
    one. With 0, Nagle's algorithm stays on and every answer on a
    kept-alive connection waits 40 ms for a delayed ACK.
    """
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        sock.listen(backlog)
    except OSError as error:
        sock.close()
        if error.errno == errno.EADDRINUSE:
            reason = "address already in use"
        else:
            reason = error.strerror or str(error)
        raise SiftError(f"cannot listen on {host}:{port}: {reason}") from None
    return sock
```

这个函数里有开头那 42 倍的答案，先放一放。`serve` 的主体（第 650 到 726 行）把 `uvicorn.Server` 配起来：关掉 uvicorn 自己的日志配置，不发 `Server` 头，不信任代理头，不要 WebSocket，`limit_concurrency` 用 `MAX_CONNECTIONS`，`backlog` 和 `listen()` 用同一个数（uvicorn 拿到现成的 socket 时是否还会自己再 `listen`，我没有查，所以两边传同一个值），`http=` 传的是下面那个子类，等于固定用 h11，装不装 `httptools` 对 `sift serve` 都没有影响。结尾是：

```python
# src/sift/server/app.py (the end of serve)
    try:
        task = asyncio.create_task(run_server(server, sock))
        while not server.started and not task.done():
            await asyncio.sleep(0.01)
        if server.started:
            bound_host, bound_port = sock.getsockname()[:2]
            shown = f"[{bound_host}]" if ":" in bound_host else bound_host
            announce(f"listening on http://{shown}:{bound_port}")
        await task
    finally:
        sock.close()
        if before is not None:
            signal.signal(signal.SIGTERM, before)
    if failures:
        raise failures[0]
    if not server.started:
        raise SiftError("the server did not start, see the log")
```

第 709 行（79 个字符，我没贴）先把 `SIGTERM` 设成 `SIG_IGN`，`finally` 里再设回去。`run_server`（第 639 到 647 行）把 `server.serve([sock])` 包在 `contextlib.suppress(SystemExit)` 里。这两处都是 uvicorn 的行为逼出来的，下面用实验确认。

### 退出码：143、3 和 1

`hello_asgi.py` 是对所有请求回 200 的最小 ASGI 应用，`bad_lifespan.py` 的启动总是失败：

```python
"""Answer 200 to every request, as an ASGI app."""


async def app(scope, receive, send):
    """Answer HTTP; acknowledge the lifespan messages."""
    if scope["type"] == "lifespan":
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            else:
                await send({"type": "lifespan.shutdown.complete"})
                return
    await receive()
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})
```

```python
"""Fail the startup of the lifespan, as an ASGI app."""


async def app(scope, receive, send):
    """Fail on lifespan.startup, like a lifespan handler that raises."""
    assert scope["type"] == "lifespan"
    await receive()
    await send({"type": "lifespan.startup.failed", "message": "no index"})
```

`exit_codes.sh` 起 uvicorn，等 2 秒，发 `SIGTERM`，看退出码；再看启动失败的退出码；最后对 `sift serve` 做同样两件事（第二件用一个被截断的段文件当损坏的索引）：

```bash
#!/usr/bin/env bash
# Exit status of uvicorn and of sift serve after SIGTERM, and when the
# startup fails. Run from the repository root.
set -u
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# term_status LABEL CMD...: run CMD, let it start, send SIGTERM.
term_status() {
    local label=$1
    shift
    "$@" > /dev/null 2>&1 &
    local pid=$!
    sleep 2
    kill -TERM "$pid"
    wait "$pid"
    echo "$label: exit $?"
}

(cd "$here" && term_status "uvicorn, SIGTERM" \
    python3 -m uvicorn hello_asgi:app --port 8765)
(cd "$here" && python3 -m uvicorn bad_lifespan:app --port 8766 2>&1)
echo "uvicorn, startup failed: exit $?"

export SIFT_INDEX="$work/idx"
python3 -m sift index > /dev/null
term_status "sift serve, SIGTERM" python3 -m sift serve --port 8767 --quiet
truncate -s 100 "$SIFT_INDEX/segment.sft"
python3 -m sift serve --port 8767 --quiet 2> "$work/err.txt" > /dev/null
echo "sift serve, corrupt index: exit $?"
echo "stderr: $(wc -l < "$work/err.txt") lines, the last one:"
tail -n 1 "$work/err.txt" | sed "s#$work#<tmp>#"
```

```text
$ bash /tmp/sift-scratch/ch18/exit_codes.sh
uvicorn, SIGTERM: exit 143
INFO:     Started server process [606177]
INFO:     Waiting for application startup.
ERROR:    no index
ERROR:    Application startup failed. Exiting.
uvicorn, startup failed: exit 3
sift serve, SIGTERM: exit 0
sift serve, corrupt index: exit 1
stderr: 1 lines, the last one:
error: <tmp>/idx/segment.sft: offsets outside the file
```

- 光秃秃的 uvicorn 收到 `SIGTERM` 以 143 退出，也就是 128 加 15：它是被 `SIGTERM` 杀死的。`uvicorn/server.py` 第 320 到 337 行的 `capture_signals` 在服务期间把 `SIGINT` 和 `SIGTERM` 换成自己的处理器，服务结束后恢复原处理器，然后对捕获过的信号再 `signal.raise_signal` 一次（第 336 到 337 行），注释说这是为了触发预期的行为：进程管理器发 `SIGTERM`，期望进程因它而终止。默认处理器一接到这第二次 `SIGTERM`，进程就死了。
- `sift serve` 在服务期间把 `SIGTERM` 设成 `SIG_IGN`，uvicorn 恢复的“原处理器”就是忽略，再发一次也没事，干净关闭，退出码 0，和第 17 篇一致。
- uvicorn 的启动失败：lifespan 回 `lifespan.startup.failed`，`Server.startup`（第 103 到 106 行）看到 `lifespan.should_exit` 就 `sys.exit(STARTUP_FAILURE)`，`STARTUP_FAILURE` 是 3（`uvicorn/config.py` 第 79 行）。输出里是 `ERROR:    no index` 和 `Application startup failed. Exiting.`，退出码 3。
- `sift serve` 遇到损坏的索引退出码是 1，stderr 只有一行 `error: ...segment.sft: offsets outside the file`。这靠两处：`run_server` 里的 `suppress(SystemExit)`，因为 `sys.exit(3)` 抛出的 `SystemExit` 在 asyncio 任务里不会被任务吞掉，`Task.__step_run_and_handle_result`（从第 283 行开始）看到 `SystemExit` 和 `KeyboardInterrupt` 会重新抛出（`Lib/asyncio/tasks.py` 第 303 到 305 行），事件循环随之停下，整个进程以 3 退出；`serve` 先捕获它，再检查 `server.started` 和 `noting()` 记下的 `SiftError`，抛出 Sift 自己的错误。第二处是 `QuietStartup`：一个日志过滤器，`failures` 里有了 `SiftError` 之后，uvicorn 就不再往 stderr 打这次失败的回溯。第一个提交里没有这个过滤器，那时 stderr 有 33 行，`error:` 在最后。

### 安静的连接：没有 `READ_TIMEOUT` 的 uvicorn

第 17 篇的手写服务器有个 `READ_TIMEOUT`：一个连接上来之后 10 秒内没发完请求头，服务器就把它关掉。我在 `extra.sh` 的注释里写过“两边的连接数上限都是 256，所以不动”，以为这样两边就等价了。后来我拿 300 个什么都不发的 socket 去试：

```python
"""Open 300 silent sockets, then ask GET /health at once and at 12 s.

Each target is a ``sift serve`` process over the same index: the
FastAPI server before the head timeout (an unpacked copy of commit
9843488), the FastAPI server of ch18, and the raw server. A socket
that sends nothing is idle; the cap on open connections is 256.
"""

import os
import socket
import subprocess
import sys
import tempfile
import time

OLD = {"PYTHONPATH": "/tmp/ch18-old/src"}
TARGETS = [
    ("fastapi, 9843488", OLD, []),
    ("fastapi, ch18", {}, []),
    ("raw, ch18", {}, ["--raw"]),
]


def health(port: int) -> str:
    """Return the status code of GET /health."""
    request = b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n"
    request += b"Connection: close\r\n\r\n"
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        sock.sendall(request)
        return sock.recv(4096).split(b" ", 2)[1].decode()


def main() -> None:
    """Measure each target."""
    with tempfile.TemporaryDirectory() as index:
        env = os.environ | {"SIFT_INDEX": index}
        subprocess.run(
            [sys.executable, "-m", "sift", "index"],
            env=env,
            check=True,
            capture_output=True,
        )
        for name, extra_env, flags in TARGETS:
            server = subprocess.Popen(
                [sys.executable, "-m", "sift", "serve", "--port", "0"]
                + ["--quiet", *flags],
                env=env | extra_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            assert server.stdout is not None
            line = server.stdout.readline().strip()
            port = int(line.rsplit(":", 1)[1])
            silent = [
                socket.create_connection(("127.0.0.1", port))
                for _ in range(300)
            ]
            first = health(port)
            time.sleep(12)
            print(f"{name:<17} at 0 s: {first}  at 12 s: {health(port)}")
            for sock in silent:
                sock.close()
            server.terminate()
            server.wait()


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/ch18/idle_sockets.py
fastapi, 9843488  at 0 s: 503  at 12 s: 503
fastapi, ch18     at 0 s: 503  at 12 s: 200
raw, ch18         at 0 s: 503  at 12 s: 200
```

三个服务器，每个都先开 300 个沉默的 socket，然后马上问一次 `GET /health`，12 秒之后再问一次。第一个是 `9843488` 的 FastAPI，两次都是 503；第二个是现在的 FastAPI，先 503，12 秒后 200；第三个是手写服务器，结果和第二个一样。

原因在 uvicorn 的两个设计叠在一起。`limit_concurrency` 在请求被解析时检查（`uvicorn/protocols/http/h11_impl.py` 第 224 到 230 行）：连接数达到上限，就把这个请求交给回 503 的 `service_unavailable`，而它数的是所有打开的连接，包括沉默的。uvicorn 的 keep-alive 定时器只在一个响应结束后才启动（同一个文件第 322 到 331 行的 `on_response_complete`），一个从没发过请求的连接没有定时器，永远不会被关。256 个沉默的连接就能让之后的每个请求都是 503，一直到它们自己走掉。

修法是给第一个请求头也配一个定时器，`head_timeout_protocol` 做的就是这个，一个 `H11Protocol` 的子类（`app.py` 第 576 到 623 行）：

```python
# src/sift/server/app.py (inside head_timeout_protocol)
    class HeadTimeoutProtocol(H11Protocol):
        """H11Protocol that closes a connection that stays silent."""

        _head_timer: asyncio.TimerHandle | None = None

        def connection_made(self, transport: asyncio.BaseTransport) -> None:
            """Start the timer."""
            if not isinstance(transport, asyncio.Transport):
                raise TypeError("uvicorn gives a stream transport")
            super().connection_made(transport)
            loop = asyncio.get_running_loop()
            self._head_timer = loop.call_later(seconds, self._give_up)

        def _give_up(self) -> None:
            """Close the connection: no request head came in time."""
            self._head_timer = None
            self.transport.close()

        def _stop_timer(self) -> None:
            """Cancel the timer, if it is still armed."""
            if self._head_timer is not None:
                self._head_timer.cancel()
                self._head_timer = None

        def handle_events(self) -> None:
            """Stop the timer once a request has been parsed."""
            super().handle_events()
            if self.cycle:  # None until the first request is parsed
                self._stop_timer()

        def connection_lost(self, exc: Exception | None) -> None:
            """Stop the timer with the connection."""
            self._stop_timer()
            super().connection_lost(exc)

    return HeadTimeoutProtocol
```

`connection_made` 里 `loop.call_later(seconds, self._give_up)` 起一个定时器，到点就关 transport；`handle_events` 在父类解析完事件之后看 `self.cycle`（解析出第一个请求之前它是 `None`），有了就取消定时器；`connection_lost` 也取消它。第一个请求之后 uvicorn 自己的 5 秒 keep-alive 接手，所以这个子类只管第一个请求，不管之后的连接上的慢请求。`serve` 把 `read_timeout` 传给它，默认是第 17 篇的 `READ_TIMEOUT`。

### 4237 毫秒：Nagle 加延迟确认

回到开头的实验。`nodelay_flag.py` 先确认一个前提，再看被接受的 socket 上 `TCP_NODELAY` 是不是真的被设了：

```python
"""Print TCP_NODELAY of an accepted socket, per listener protocol."""

import asyncio
import socket


async def accepted_nodelay(proto: int) -> int:
    """Accept one connection on a pre-bound socket; read TCP_NODELAY."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM, proto)
    sock.bind(("127.0.0.1", 0))
    flags = asyncio.Queue[int]()

    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """Record the option of the accepted socket."""
        accepted = writer.get_extra_info("socket")
        value = accepted.getsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY)
        await flags.put(value)
        writer.close()

    server = await asyncio.start_server(handle, sock=sock)
    async with server:
        port = sock.getsockname()[1]
        _, writer = await asyncio.open_connection("127.0.0.1", port)
        value = await flags.get()
        writer.close()
    return value


def main() -> None:
    """Compare proto 0 with IPPROTO_TCP."""
    with socket.create_server(("127.0.0.1", 0)) as sock:
        print(f"socket.create_server: proto={sock.proto}")
    for name, proto in [("proto 0", 0), ("IPPROTO_TCP", socket.IPPROTO_TCP)]:
        value = asyncio.run(accepted_nodelay(proto))
        print(f"{name:<12} listener.proto={proto}  TCP_NODELAY={value}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/ch18/nodelay_flag.py
socket.create_server: proto=0
proto 0      listener.proto=0  TCP_NODELAY=0
IPPROTO_TCP  listener.proto=6  TCP_NODELAY=1
```

第一行：`socket.create_server` 造出的 socket，`proto` 是 0，不是 `IPPROTO_TCP` (6)。asyncio 只在 `proto == IPPROTO_TCP` 的 socket 上设 `TCP_NODELAY`（`Lib/asyncio/base_events.py` 第 191 到 196 行的 `_set_nodelay`，接受连接时由 `selector_events.py` 第 948 行调用，旁边的注释是关掉 Nagle 算法：小的写操作不再等 TCP 的 ACK）。被接受的 socket 继承监听 socket 的 `proto`，后两行是实测：监听 socket 的 `proto` 是 0 时，被接受的 socket 上 `TCP_NODELAY` 是 0；是 6 的时候是 1。

为什么没设 `TCP_NODELAY` 会慢到 42 毫秒一个请求？两个各自合理的机制撞在了一起。Nagle 算法：一个连接上已经有数据发出去还没被确认，后面的小数据就攒着，等确认回来再发。延迟确认：接收方收到数据后不立刻回 ACK，等一等（Linux 上常见的上限是 40 毫秒），希望能捎带在自己的数据上。uvicorn 的 h11 实现发一个响应是**两次**写：`transport.write` 先写状态行和头（`uvicorn/protocols/http/h11_impl.py` 第 491 到 495 行），再写正文（第 505 到 508 行）。头先出去了，正文是小数据，要等头的 ACK；客户端是 httpx，没有话要说，ACK 就被延迟了。大约 40 毫秒之后 ACK 到，正文才发出。42 毫秒的平均值是实测，40 毫秒这个上限我没有读内核源码确认，写的是印象。

`nagle_pooled.py` 把这件事做成四种组合，监听 socket 的协议号和连接是否复用：

```python
"""Time 100 GET /health against a listening socket made two ways.

With proto 0 (what socket.create_server passes) asyncio does not set
TCP_NODELAY on the accepted sockets; with IPPROTO_TCP it does. The
client is one httpx.Client: once pooled, so every request after the
first reuses a connection, and once with Connection: close, so every
request opens a new one.
"""

import socket
import time

import httpx
from mini_app import serving

MODES = {"pooled": {}, "new connection each": {"Connection": "close"}}


def main() -> None:
    """Print the timings of the four combinations."""
    for name, proto in [("proto 0", 0), ("IPPROTO_TCP", socket.IPPROTO_TCP)]:
        for mode, headers in MODES.items():
            with serving(proto) as base:
                with httpx.Client(base_url=base, headers=headers) as client:
                    start = time.perf_counter()
                    for _ in range(100):
                        client.get("/health").raise_for_status()
                    ms = (time.perf_counter() - start) * 1000
            print(f"{name:<12} {mode:<20} {ms:7.0f} ms for 100 requests")


if __name__ == "__main__":
    main()
```

```text
$ python3 -W ignore /tmp/sift-scratch/ch18/nagle_pooled.py
proto 0      pooled                  4237 ms for 100 requests
proto 0      new connection each      135 ms for 100 requests
IPPROTO_TCP  pooled                   102 ms for 100 requests
IPPROTO_TCP  new connection each      134 ms for 100 requests
```

协议号为 0 并且复用连接，100 个请求 4237 毫秒；改成 `IPPROTO_TCP`，102 毫秒。每个请求新开连接时两种写法都是 135 毫秒左右，不受影响。我的解释是新连接上头一两个包 Linux 会立刻确认，等不到延迟确认起作用，所以问题只在连接被复用时出现；这个解释我没有抓包验证，实验只证明了现象。

这也是为什么第 17 篇的 `load.py` 看不到它：`load.py` 每个请求新开一个连接。它还引出另一个必须改的地方：`load.py` 读响应一直读到服务器关连接 (`await reader.read()`)，手写服务器每个响应后都关，没问题；uvicorn 默认保持连接 5 秒（`uvicorn/config.py` 第 228 行 `timeout_keep_alive: int = 5`），不关，`load.py` 就会等满这 5 秒。我把 ch17 的版本和现在的版本各对一个 `sift serve` 问 2 个请求：

```bash
#!/usr/bin/env bash
# Run lab/ch17/load.py as it was at ch17 and as it is now against
# sift serve: 2 clients, 1 request each. Run from the repository root.
set -euo pipefail
work=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$work"' EXIT
export SIFT_INDEX="$work/idx"
python3 -m sift index > /dev/null
python3 -m sift serve --port 0 --quiet > "$work/log" &
until grep -q '^listening on' "$work/log"; do sleep 0.1; done
port=$(sed 's/.*://' "$work/log")
git show ch17:lab/ch17/load.py > "$work/load_ch17.py"

run_load() {
    echo "== $1"
    python3 "$2" --port "$port" --clients 2 --requests 1 \
        --target /health | sed -n '2,3p'
}
run_load "load.py at ch17" "$work/load_ch17.py"
run_load "load.py at ch18" lab/ch17/load.py
```

```text
$ bash /tmp/sift-scratch/ch18/keepalive_load.sh
== load.py at ch17
wall      5.004 s
req/s       0.4
== load.py at ch18
wall      0.002 s
req/s     838.4
```

ch17 的 `load.py` 2 个请求用了 5.004 秒，一个请求等了整整一个 keep-alive 超时；现在的版本加了 `Connection: close`，0.002 秒。这就是 `git diff ch17 ch18 -- lab/ch17/load.py` 里那两行的来历。第 17 篇的数字不受影响：手写服务器本来就关连接，请求里多一个头不改变它的行为。

## 对比：FastAPI 对手写的 asyncio 服务器

回到本篇的题目。`lab/ch18/extra.sh` 做三件事：把 27 个请求发给两个服务器，比较答案（上面看过）；用第 17 篇的 `load.py`（100 个客户端各发 20 个请求，每个请求新开连接）压 `GET /search?q=...&limit=1`，FastAPI 和手写服务器交替，各 2 轮；再压 `GET /health`，交替 3 轮。两个服务器都用 `--max-pending 128`，因为默认的 32 会让 100 个并发客户端大半拿到 503；连接数上限两边都是 256，高于 100 个客户端，所以不动。现在这两边的“连接上限”才真的等价：沉默的连接 10 秒后都会被关。脚本里的注释写明了这些：

```bash
# lab/ch18/extra.sh (the helpers and the comparison of bodies are omitted)
# --- load_compare.sh ------------------------------------------------
# A search costs 5 to 20 ms with limit=1, all of it CPU under the GIL.
# /health costs nothing: it measures only how each server handles 100
# connections at once.
#
# One cap is lifted for both servers: the default of 32 pending
# searches would answer 503 to most of the 100 clients, so they run
# with --max-pending 128. The cap on open connections is 256 for both
# (uvicorn's limit_concurrency, the MAX_CONNECTIONS of the raw server),
# above the 100 clients, so it stays.
start_server fastapi python3 -m sift serve --port 0 --quiet \
    --max-pending 128
fastapi_pid=$server_pid fastapi_port=$server_port
start_server raw python3 -m sift serve --raw --port 0 --quiet \
    --max-pending 128
raw_pid=$server_pid raw_port=$server_port
```

```text
$ sed -n '40,44p;103,109p' out/ch18/load_compare.txt
summary of GET /search?q=...&limit=1
fastapi   round 1      65.3 req/s  p50  1521.6 ms  p99  1796.0 ms
fastapi   round 2      64.9 req/s  p50  1533.1 ms  p99  1802.3 ms
raw       round 1      67.8 req/s  p50  1458.5 ms  p99  1849.1 ms
raw       round 2      67.4 req/s  p50  1463.1 ms  p99  1893.0 ms
summary of GET /health
fastapi   round 1    3446.5 req/s  p50    26.1 ms  p99    70.2 ms
fastapi   round 2    3801.1 req/s  p50    25.6 ms  p99    33.8 ms
fastapi   round 3    3788.1 req/s  p50    25.9 ms  p99    32.7 ms
raw       round 1    7280.6 req/s  p50    13.4 ms  p99    17.4 ms
raw       round 2    7217.5 req/s  p50    13.4 ms  p99    19.1 ms
raw       round 3    7100.5 req/s  p50    13.7 ms  p99    16.7 ms
```

`make ch18` 前后的 `cpu_state.py` 是 `111 115 121 114 115` 和 `115 113 117 116 115`，快状态。

**搜索基本打平。** `limit=1` 的搜索是 CPU 活，一次一个，每个约 15 毫秒，吞吐的上限由它决定：FastAPI 两轮 65.3 和 64.9（平均 65.1），手写服务器 67.8 和 67.4（平均 67.6）。手写的快 3.8%，每边两轮之间只差 0.6%，所以这个差距比噪声大一点，但只有两轮，我不敢说它稳定。框架本身一个请求约 0.05 毫秒（下面会看到），和 15 毫秒的搜索比不到 1%；3.8% 对应每个搜索多 0.6 毫秒左右，比框架的开销大，多出来的部分来自哪里，我没有查。p50 在 1.5 秒上下，不是因为一个请求要 1.5 秒，而是 100 个客户端排一条每秒 65 个的队，100 除以 65 约 1.5。p99 反而 FastAPI 略低（1796、1802 对 1849、1893），同样排在噪声里。

**`/health` 上差了 2 倍。** FastAPI 三轮平均 3679 req/s，手写服务器 7200，比值 1.96。手写服务器已经贴着压测脚本自己的上限（第 17 篇量过，一个什么都不做的桩进程也只到 7000 到 7400），所以 2 倍是下界。每个请求的耗时倒过来：FastAPI 约 272 微秒，手写服务器不超过 139 微秒。

这 272 微秒是怎么来的？前面进程内测过 FastAPI 的 ASGI 调用，47.7 微秒。剩下的应该是 uvicorn：接受连接、h11 解析、把事件翻成字节、关连接。我用 `hello_asgi.py`（对什么请求都回 200，没有路由，没有校验）在 uvicorn 上跑同一个压测，和 `sift serve` 交替；脚本里还多起了一个第一个提交 `9843488` 的 `sift serve` (`old`) 做参照：

```bash
#!/usr/bin/env bash
# load.py on /health: sift serve of ch18 and of the first commit of the
# chapter (an unpacked copy in /tmp/ch18-old) against a bare uvicorn
# that runs the app of hello_asgi.py. Run from the repository root.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$work"' EXIT
export SIFT_INDEX="$work/idx"
sift index --corpus corpus/posts > /dev/null

start() {  # start NAME COMMAND...: sets port_NAME
    local name=$1
    shift
    "$@" --port 0 --quiet > "$work/$name.log" &
    until grep -q '^listening on' "$work/$name.log"; do sleep 0.1; done
    printf -v "port_$name" %s "$(sed 's/.*://' "$work/$name.log")"
}
start sift python3 -m sift serve
PYTHONPATH=/tmp/ch18-old/src start old python3 -m sift serve
(cd "$here" && exec python3 -m uvicorn hello_asgi:app --port 8771 \
    --no-access-log --log-level warning) &
sleep 1.5
port_bare=8771

for round in 1 2 3; do
    for name in sift old bare; do
        port=port_$name
        rate=$(python3 lab/ch17/load.py --port "${!port}" --clients 100 \
            --requests 20 --target /health | awk '$1 == "req/s" {print $2}')
        printf '%-5s round %d  %7.1f req/s\n' "$name" "$round" "$rate"
    done
done
```

```text
$ bash /tmp/sift-scratch/ch18/bare_uvicorn_load.sh
sift  round 1   3572.7 req/s
old   round 1   2631.9 req/s
bare  round 1   4505.9 req/s
sift  round 2   3841.0 req/s
old   round 2   2905.5 req/s
bare  round 2   4299.9 req/s
sift  round 3   3831.6 req/s
old   round 3   2689.5 req/s
bare  round 3   4406.2 req/s
```

三轮平均：裸 uvicorn 4404 req/s，每个请求 227 微秒；现在的 `sift serve` 3748 req/s，267 微秒；第一个提交的 `old` 2742 req/s，365 微秒。现在比裸 uvicorn 多 40 微秒，进程内量到的是 47.7 微秒，同一个量级；`old` 多 138 微秒，那一版进程内是 132.4 微秒。也就是说 `/health` 的约 270 微秒，大致是 227 微秒 uvicorn（h11 是纯 Python 写的解析器）加上 40 到 50 微秒 FastAPI。这是把独立的测量拼起来的估计，拼法假设它们能相加，我没有做更严格的实验。

手写服务器的不超过 139 微秒包括接受连接、解析、分派、写响应、关连接，一个请求的全部，比裸 uvicorn 的 227 微秒还快，因为它只处理这三个路由，请求头只检查需要的几项，没有 ASGI 的字典和事件。这是“框架替我做了多少”的另一半：它替我做的，大部分是我这个小服务器用不上的通用性。

### 其余的差别：框架替我决定的事

契约的 27 个请求完全一致，剩下的差别在更底层。`fastapi_vs_raw.py` 往两个服务器各发四种请求，打印状态行、响应数和 `Content-Type`：

```python
"""Send the same odd requests to FastAPI and to the raw server."""

import os
import re
import socket
import subprocess
import sys
import tempfile

MANY = b"".join(b"X-%d: v\r\n" % n for n in range(150))
REQUESTS = {
    "HEAD /health": b"HEAD /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
    "150 headers": b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n"
    b"Connection: close\r\n" + MANY + b"\r\n",
    "bad request line": b"GET\r\n\r\n",
    "two on one connection": b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
    b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
}


def talk(port: int, data: bytes) -> bytes:
    """Send data, read until the server closes or 1 s passes."""
    with socket.create_connection(("127.0.0.1", port), timeout=1) as sock:
        sock.sendall(data)
        chunks = []
        try:
            while chunk := sock.recv(65536):
                chunks.append(chunk)
        except TimeoutError:
            chunks.append(b"<still open after 1 s>")
    return b"".join(chunks)


def start(env: dict[str, str], *flags: str) -> tuple[subprocess.Popen, int]:
    """Start sift serve; return the process and its port."""
    command = [sys.executable, "-m", "sift", "serve", "--port", "0"]
    server = subprocess.Popen(
        [*command, "--quiet", *flags],
        env=env,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert server.stdout is not None
    line = server.stdout.readline().strip()
    return server, int(line.rsplit(":", 1)[1])


def main() -> None:
    """Print status line and body size of every answer, both servers."""
    with tempfile.TemporaryDirectory() as index:
        env = os.environ | {"SIFT_INDEX": index}
        subprocess.run(
            [sys.executable, "-m", "sift", "index"],
            env=env,
            check=True,
            capture_output=True,
        )
        for name, flags in [("fastapi", ()), ("raw", ("--raw",))]:
            server, port = start(env, *flags)
            print(f"== {name}")
            for label, data in REQUESTS.items():
                answer = talk(port, data)
                first = answer.split(b"\r\n", 1)[0].decode()
                kinds = re.findall(rb"(?i)content-type: ([^\r]*)", answer)
                count = answer.count(b"HTTP/1.1 ")
                kind = kinds[0].decode() if kinds else "-"
                print(f"  {label:<22} {first:<27} {count} {kind}")
            server.terminate()
            server.wait()


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/ch18/fastapi_vs_raw.py
== fastapi
  HEAD /health           HTTP/1.1 405 Method Not Allowed 1 application/json
  150 headers            HTTP/1.1 200 OK             1 application/json
WARNING uvicorn.error: Invalid HTTP request received.
  bad request line       HTTP/1.1 400 Bad Request    1 text/plain; charset=utf-8
  two on one connection  HTTP/1.1 200 OK             2 application/json
== raw
  HEAD /health           HTTP/1.1 200 OK             1 application/json; charset=utf-8
  150 headers            HTTP/1.1 400 Bad Request    1 application/json; charset=utf-8
  bad request line       HTTP/1.1 400 Bad Request    1 application/json; charset=utf-8
  two on one connection  HTTP/1.1 200 OK             1 application/json; charset=utf-8
```

- `HEAD /health`：手写服务器回 200（第 17 篇实现了 `HEAD`），FastAPI 只路由了 `GET`，回 405。
- 150 个请求头：手写服务器最多收 100 个 (`MAX_HEADERS`)，回 400；h11 的限制不一样，FastAPI 回 200。
- 不合法的请求行 `GET`：手写服务器回 JSON 的 400；FastAPI 这边是 uvicorn 在 h11 层就拒绝了，回 `text/plain` 的 400，应用根本没见到这个请求，stderr 里是 `Invalid HTTP request received.`（`uvicorn/protocols/http/h11_impl.py` 第 182 到 186 行）。
- 同一个连接上两个请求：手写服务器答一个就关，FastAPI 答两个。

`app.py` 开头的文档字符串还列了两条我没有做实验：连接数超过 `limit_concurrency` 时 uvicorn 回的 503 是纯文本 `Service Unavailable`（我读了 `uvicorn/protocols/http/h11_impl.py` 第 224 到 230 行和 `flow_control.py` 第 42 到 54 行，没有真的把连接压到 256 以上去看响应），以及“客户端已经走了的搜索不会被跳过”（文档字符串这么写，我没有测）。这两条我标作未验证。

## 本篇文件

这一章动了 23 个文件，`git diff --shortstat ch17 ch18` 给出 `23 files changed, 3145 insertions(+), 66 deletions(-)`。表里的 `+N -M` 来自 `git diff --numstat ch17 ch18`，命令是跑它对应的测试或脚本，结果是我最后一次在仓库里实际跑出来的；`/tmp/sift-scratch/ch18/` 里的草稿脚本不进仓库，不在表里。
| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch18/README.md) | `git diff --numstat ch17 ch18 -- README.md \| awk '{print "+"$1, "-"$2}'` | 退出码 0，输出 `+12 -2` |
| [`pyproject.toml`](https://github.com/bfmhno3/sift/blob/ch18/pyproject.toml) | `python3 -c "import tomllib; print(tomllib.load(open('pyproject.toml', 'rb'))['project']['optional-dependencies']['web'])"` | 退出码 0，`['fastapi>=0.139', 'uvicorn>=0.51', 'httpx>=0.28', 'pydantic>=2.13']`；`+8 -0` |
| [`load.py`](https://github.com/bfmhno3/sift/blob/ch18/lab/ch17/load.py) | `python3 lab/ch17/load.py` | 退出码 0，`errors 0`；`+7 -2` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch18/lab/ch18/extra.sh) | `bash lab/ch18/extra.sh` | 退出码 0，最后一行 `raw round 3 7100.5 req/s p50 13.7 ms p99 16.7 ms`（取自 `make ch18` 那一次）；`+187 -0` |
| [`fastapi_di.py`](https://github.com/bfmhno3/sift/blob/ch18/lab/ch18/fastapi_di.py) | `python3 lab/ch18/fastapi_di.py` | 退出码 0，`events at the end: ['open', 'close', 'open', 'close']`；`+74 -0` |
| [`httpx_sync_async.py`](https://github.com/bfmhno3/sift/blob/ch18/lab/ch18/httpx_sync_async.py) | `python3 lab/ch18/httpx_sync_async.py` | 退出码 0，`statuses: {200}`；`+106 -0` |
| [`httpx_timeout_fail.py`](https://github.com/bfmhno3/sift/blob/ch18/lab/ch18/httpx_timeout_fail.py) | `python3 lab/ch18/httpx_timeout_fail.py` | 退出码 1，`/fast -> 200 {'ok': True}`；`+49 -0` |
| [`openapi_dump.py`](https://github.com/bfmhno3/sift/blob/ch18/lab/ch18/openapi_dump.py) | `python3 lab/ch18/openapi_dump.py` | 退出码 0，`wrote out/ch18/openapi.json (10108 bytes)`；`+54 -0` |
| [`pydantic_models.py`](https://github.com/bfmhno3/sift/blob/ch18/lab/ch18/pydantic_models.py) | `python3 lab/ch18/pydantic_models.py` | 退出码 0，`strict=True: Input should be a valid integer`；`+107 -0` |
| [`pydantic_validation_fail.py`](https://github.com/bfmhno3/sift/blob/ch18/lab/ch18/pydantic_validation_fail.py) | `python3 lab/ch18/pydantic_validation_fail.py` | 退出码 1，`3 errors`；`+37 -0` |
| [`pydantic_vs_dataclass.py`](https://github.com/bfmhno3/sift/blob/ch18/lab/ch18/pydantic_vs_dataclass.py) | `python3 lab/ch18/pydantic_vs_dataclass.py` | 退出码 0，`dataclass(**dict) 240 ns`；`+117 -0` |
| [`urllib_client.py`](https://github.com/bfmhno3/sift/blob/ch18/lab/ch18/urllib_client.py) | `python3 lab/ch18/urllib_client.py` | 退出码 0，`POST /health -> 405, Allow: GET, HEAD`；`+79 -0` |
| [`cli.py`](https://github.com/bfmhno3/sift/blob/ch18/src/sift/cli.py) | `python3 -m pytest tests/test_cli.py \| tail -1` | 退出码 0，`86 passed in 8.44s`；`+65 -27` |
| [`client.py`](https://github.com/bfmhno3/sift/blob/ch18/src/sift/client.py) | `python3 -m pytest tests/test_client.py \| tail -1` | 退出码 0，`13 passed in 0.73s`；`+206 -0` |
| [`app.py`](https://github.com/bfmhno3/sift/blob/ch18/src/sift/server/app.py) | `python3 -m pytest tests/test_server.py \| tail -1` | 退出码 0，`90 passed, 1 warning in 7.43s`；`+726 -0` |
| [`models.py`](https://github.com/bfmhno3/sift/blob/ch18/src/sift/server/models.py) | `python3 -m pytest --doctest-modules src/sift/server/models.py \| tail -1` | 退出码 0，`1 passed in 0.66s`；`+113 -0` |
| [`raw.py`](https://github.com/bfmhno3/sift/blob/ch18/src/sift/server/raw.py) | `python3 -m pytest tests/test_server_raw.py \| tail -1` | 退出码 0，`135 passed in 6.20s`（`raw.py` 里的 doctest 另跑，`2 passed in 0.59s`）；`+25 -8` |
| [`conftest.py`](https://github.com/bfmhno3/sift/blob/ch18/tests/conftest.py) | `python3 -m pytest tests/test_server.py tests/test_server_raw.py \| tail -1` | 退出码 0，`225 passed, 1 warning in 13.00s`（夹具 `searcher` 被这两个文件共用）；`+7 -0` |
| [`test_cli.py`](https://github.com/bfmhno3/sift/blob/ch18/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py \| tail -1` | 退出码 0，`86 passed in 8.44s`；`+91 -21` |
| [`test_client.py`](https://github.com/bfmhno3/sift/blob/ch18/tests/test_client.py) | `python3 -m pytest tests/test_client.py \| tail -1` | 退出码 0，`13 passed in 0.73s`；`+152 -0` |
| [`test_raw_server.py`](https://github.com/bfmhno3/sift/blob/ch18/tests/test_raw_server.py) | `python3 -m pytest tests/test_raw_server.py \| tail -1` | 退出码 0，`7 passed in 1.48s`；`+174 -0` |
| [`test_server.py`](https://github.com/bfmhno3/sift/blob/ch18/tests/test_server.py) | `python3 -m pytest tests/test_server.py \| tail -1` | 退出码 0，`90 passed, 1 warning in 7.43s`；`+749 -0` |
| [`test_server_raw.py`](https://github.com/bfmhno3/sift/blob/ch18/tests/test_server_raw.py) | `python3 -m pytest tests/test_server_raw.py \| tail -1` | 退出码 0，`135 passed in 6.20s`；`+0 -6` |

表里的结果是每个脚本输出里挑出的一行，空格折叠成了一个；计时类的数每次都不同（这张表里 `dataclass(**dict)` 是 `240 ns`，正文用的 `make ch18` 那一次是 `238 ns`）。

## 练习

**1.** `idle_sockets.py` 只试了一个字节都没发的连接。写一个脚本，让连接先发一个正常请求、读完响应，然后沉默，量 uvicorn 的 5 秒 keep-alive 多久把它关掉；再让连接只发半个请求头，看 `head_timeout_protocol` 的定时器会不会在第 10 秒关它。先写下预测，再看结果。

**2.** `Limit` 别名里把 `Field(ge=..., le=...)` 和 `BeforeValidator(parse_limit)` 的顺序调换，跑 `openapi_dump.py`，对照 `annotated_order.py` 的结论。然后在 `tests/` 里找有没有测试会因此失败；如果没有，补一个，让这个顺序有人看守。

**3.** 我对 4237 毫秒的解释是 Nagle 加延迟确认，没有抓包验证。用 `tcpdump -i lo` 或 `strace` 看 uvicorn 的两次 `write` 和客户端的 ACK 之间的时间间隔，确认是不是 40 毫秒左右；再试一个不改监听 socket 的修法：给每个被接受的 socket 单独设 `TCP_NODELAY`，或者让响应头和正文合成一次写。

## 下一篇

下一篇是《命令行体验与分发：typer、rich、uv 与 wheel》。`cli.py` 里的选项和退出码越攒越多，我想看看把 argparse 换成类型注解驱动的 typer 之后，它们能不能一个字都不变。
