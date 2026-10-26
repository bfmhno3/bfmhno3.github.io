---
title: "GUI（下）：用 PySide6 做一个好看的桌面客户端"
commentId: "post:python-by-sift-21-pyside6"
published: "2026-10-26 22:00:00 +08:00"
description: "用 Sift 重学 Python 第 21 篇：我用 PySide6 6.11.1（Qt 6.11.1）和 qtawesome 1.4.1 把上一篇的搜索窗口重做了一遍：Fusion 样式加一份由设计令牌生成的 QSS，结果列表是自绘的卡片委托，搜索跑在 QThreadPool 上，后端一行没改。同一个后端、同一个查询，我的测量脚本量出 522.9 毫秒，Tk 版是 224.8 毫秒；错在脚本用 QTest.qWait 轮询，它把另一个线程里的纯 Python 拖慢了 2.4 到 2.7 倍，换成真正的事件循环后回到 221.6 毫秒。预览用一个编辑块把 1172 次文档变更通知压成 4 次，最长的一篇从 2848.7 毫秒降到 154.7 毫秒。从进程启动到第一帧，Qt 版 828 到 836 毫秒，Tk 版 650 到 696 毫秒；rust 所有权 从 Enter 到画好 Qt 版 295.1 毫秒、Tk 版 461.9 毫秒，20 次的中位数却是 170.5 对 150.1 毫秒。22 个 pytest-qt 测试在离屏平台上跑 4.76 秒。"
category: Tutorial
tags:
  - GUI
  - PySide6
  - Qt
  - UI 设计
series: "用 Sift 重学 Python"
seriesOrder: 21
draft: false
comment: true
slug: python-by-sift-21-pyside6
---

上一篇的 Tk 窗口能用，可我一直没好意思给它放大截图。这一篇我用 PySide6 把同一个窗口重做了一遍，后端一行没改：还是那个 `IndexBackend`，还是那把锁。做完我先量了一个最简单的数，`rust 所有权` 的搜索时间。Tk 版的状态栏写 224.8 毫秒，我的 Qt 版写出来是 522.9 毫秒，慢了 2.3 倍，而后端、索引和查询都是同一份。我在 Qt 这一侧找了很久，最后发现错在我自己：测量脚本用 `QTest.qWait` 一圈一圈地等结果，这种等法本身就让另一个线程里的纯 Python 慢了 2.4 到 2.7 倍。换成真正的事件循环，同一个搜索回到 221.6 毫秒。这一篇讲一个好看的 Qt 窗口是怎么做出来的，也讲这个坑是怎么被我一脚踩进去的（下面输出里的 `qt` 是“环境”一节定义的小函数，它设好离屏平台并滤掉 Gtk 的警告）。

```text
$ python3 /tmp/sift-scratch/cpu_state.py; for w in qwait loop; do echo "--- wait=$w"; WAIT=$w qt python3 /tmp/sift-scratch/ch21/enter_to_paint_qt.py; done; python3 /tmp/sift-scratch/cpu_state.py
113 112 111 112 112 ms
--- wait=qwait
query               search   Enter to painted
rust 所有权           522.9 ms          603.2 ms
kalman filter      169.4 ms          259.0 ms
async await        126.7 ms          265.3 ms
设备树 device          23.5 ms           57.2 ms
median over 20 runs: 262.5 ms, worst 637.3 ms
--- wait=loop
query               search   Enter to painted
rust 所有权           221.6 ms          295.1 ms
kalman filter       70.8 ms          151.3 ms
async await         54.6 ms          185.0 ms
设备树 device          10.5 ms           38.0 ms
median over 20 runs: 170.5 ms, worst 313.2 ms
117 115 115 114 116 ms
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch21`（提交 `2b30ecb`）。改动共 26 个文件，新增的有 `src/sift/gui/qt/` 下的 8 个文件（`theme.py` 是设计令牌和 QSS，`model.py` 和 `delegate.py` 是结果列表，`worker.py` 是线程池上的搜索，`preview.py` 是预览，`window.py` 是主窗口，`app.py` 是入口，外加一个 `__init__.py`）、`tests/test_qt_gui.py`、`typings/qtawesome/__init__.pyi` 和 `lab/ch21/` 下的 8 个脚本加 `extra.sh`。改写的有 `src/sift/cli.py`（`sift gui` 默认开 Qt 窗口，`--tk` 保留上一篇的窗口）、`src/sift/gui/controller.py`（多了 `Catalog` 协议，`IndexBackend` 多了 `find`、`terms`、`document` 和 `log_path`）、`pyproject.toml`（`gui` 可选依赖多了 PySide6 和 qtawesome，类型检查多了 `typings/` 和给 PySide6 的配置）、`Makefile`、`README.md`，测试里改了 `tests/conftest.py` 和 `tests/test_cli.py`。
> 后面的章节里，第 22 篇给 `src/sift/cli.py` 加 `sift similar` 和 `sift report`，给 `pyproject.toml` 加 `data` 可选依赖；第 23 篇按性能分析的结果优化热点，其中点了名的有 `iter_tokens`（这一篇的 `cProfile` 里它也排第一）；第 24 和 25 篇给 `sift index` 加 `--tokenizer`。
> 涉及的 Python 与 Qt 特性：`QObject` 的父子所有权与 Python 引用计数、信号与槽、事件循环、布局、`QAbstractListModel` 与委托、`QPainter` 自绘、QSS 与设计令牌、`QThreadPool` 与 `QRunnable`、`QTimer` 防抖、`QShortcut`、跟随系统的深浅色、`pytest-qt` 与离屏渲染。
> 前置：[第 20 篇](/posts/python-by-sift-20-tkinter/)。后端、命令行和 Tk 窗口都不动，这一篇只加一个新窗口和一个让窗口不依赖具体后端的 `Catalog` 协议。

## 环境

和前几篇同一台机器，仓库在标签 `ch21`，命令都在 `nix develop` 里、仓库根目录下跑。窗口一律开在 Qt 的 `offscreen` 平台上：控件照常创建、布局、绘制，只是画进内存，不碰我的桌面。所以下面的时间都不含显卡、合成器和垂直同步，真机上会不同。

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags; git rev-parse --short HEAD
ch21
2b30ecb
$ lscpu | sed -n '/Model name/p;/^CPU(s):/p'
CPU(s):                                  16
Model name:                              AMD Ryzen 7 PRO 6850U with Radeon Graphics
$ python3 -c "import importlib.metadata as m; from PySide6.QtCore import qVersion; print('Qt', qVersion()); [print(n, m.version(n)) for n in ('PySide6', 'qtawesome', 'pytest-qt')]"
Qt 6.11.1
PySide6 6.11.1
qtawesome 1.4.1
pytest-qt 4.5.0
$ fc-list : file | grep -oE '(inter|noto-fonts-cjk-sans|jetbrains-mono)-[0-9.]+' | sort -u
inter-4.1
jetbrains-mono-2.304
jetbrains-mono-3.4.0
noto-fonts-cjk-sans-2.004
$ magick -version | sed -n 1p
Version: ImageMagick 7.1.2-29 Q16-HDRI x86_64 b919b37fd:20260727 https://imagemagick.org
```

字体是 Nix 存储里的 `inter-4.1`、`noto-fonts-cjk-sans-2.004` 和 `jetbrains-mono-2.304`（`fc-match` 给出的路径都在这三个包里；`fc-list` 还列出宿主机上的 `jetbrains-mono-3.4.0`，它没有被选中）。Qt 没有版本命令，6.11.1 是 `qVersion()` 报的。

这台机器的 CPU 有快慢两个状态（第 11 篇测到过约 2.5 倍），以 CPU 为主的计时前后我各夹一次 `cpu_state.py`（第 12 篇贴过的固定忙循环，快状态下 5 个数在 110 到 120 毫秒）。这一篇夹过的读数都在 111 到 137 之间，没有一次接近慢状态的 280 毫秒上下。Tk 和 Qt 的对比是交替着跑的。

文中的输出都是真跑出来的，只做了一件事：Qt 启动时会读我桌面的 GTK 主题，往 stderr 写几行无害的 `color-mix` 警告，所以我用一个小函数把它们和空行滤掉，同时把平台钉死在 `offscreen`：

```bash
qt() {
    QT_QPA_PLATFORM=offscreen "$@" 2>&1 | grep -v -e Gtk -e '^$'
    return ${PIPESTATUS[0]}
}
```

钉死是有原因的。实验脚本里写的是 `os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")`，可我的 shell 本来就导出了这个变量：

```text
$ echo $QT_QPA_PLATFORM
wayland;xcb
$ python3 -c "import os; os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen'); print(os.environ['QT_QPA_PLATFORM'])"
wayland;xcb
```

`setdefault` 只在变量不存在时才写，所以直接跑脚本会让 Qt 去连 Wayland，在我桌面上开出一个真窗口。`Makefile`（第 7 行）和 `tests/conftest.py`（第 10 行）因此直接赋值，不用 `setdefault`。上面的 `qt` 做的是同一件事。

语料和前几篇一样，123 篇文章。先建一份索引，后面的实验都用它：

```text
$ SIFT_INDEX=/tmp/sift-scratch/ch21/idx-demo sift index --corpus corpus/posts
documents: 123
vocabulary: 81167
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 3111.6 ms
```

```bash
export SIFT_INDEX=/tmp/sift-scratch/ch21/idx
```

## 窗口长什么样

先看结果，再讲怎么做的。四张截图是 `lab/ch21/extra.sh` 调 `qt_screenshot.py` 在 `QT_SCALE_FACTOR=2` 下离屏拍的，2400×1520 像素（相当于 HiDPI 屏上 1200×760 的窗口），用 ImageMagick 转成 WebP（质量 90），大小是 317、292、31 和 28 KB（上限 400 KB）。我把四张都打开看了。第五张是我后面为了看最小尺寸，用 `window.grab()` 在缩放 1 下自己拍的。

浅色，查询 `rust 所有权`，第一条结果被选中：

![浅色的 Sift Qt 窗口：顶栏有“Sift”、浅靛蓝底的“123 篇”小标签、带放大镜和清除按钮的大输入框（内容是 rust 所有权，2 像素靛蓝焦点边框）和右侧的月亮图标按钮；左边是五张圆角结果卡片，第一张被选中（靛蓝边框、浅靛蓝底），每张有标题、右上角的分数药丸（5.80、5.77 等）、灰色的日期分类和标签小药丸、两行摘要，命中词带黄色圆角底；右边是白底预览面板，大标题“第一个 crate：从 cargo new 到 Span”，正文里命中词同样带黄底，终端命令是等宽字；状态栏写着“10 条结果 · 557.3 ms · 查询日志已记录”](/assets/images/python-by-sift/ch21-qt-light.webp)

深色，同一个查询：

![深色的 Sift Qt 窗口：布局与浅色版相同，底色近黑，选中的卡片是深靛蓝底加亮靛蓝边框，命中词是琥珀棕底配浅黄字，右上角按钮的图标是太阳，状态栏写着“10 条结果 · 557.4 ms · 查询日志已记录”](/assets/images/python-by-sift/ch21-qt-dark.webp)

空状态（浅色，没有查询）和语法错误（深色，查询是 `(rust`）：

![浅色的空状态：输入框为空，占位符是“搜索 123 篇文章，试试 rust 所有权 或 tag:Rust”；窗口中央是灰色的“文本加放大镜”大图标、粗体的“输入关键词开始搜索”和四个白底圆角示例按钮（rust 所有权、kalman filter、“device tree”、tag:Rust lifetime）；状态栏写着“共 123 篇文章”](/assets/images/python-by-sift/ch21-qt-empty.webp)

![深色的语法错误状态：输入框里是 (rust，紧贴在下面的是深红底、红边框、红色等宽字的提示条，三行内容是 expected ')'、缩进的 (rust 和落在 rust 之后的 ^；提示条下面仍是空状态的图标和示例按钮，整体被顶低了一截；状态栏写着“查询有误”](/assets/images/python-by-sift/ch21-qt-error.webp)

我看到的，先说好的：

- 汉字都是字形，没有方框；Inter 没有的字落到了 Noto Sans CJK SC。
- 卡片间距一致，每张的高度由内容决定，没有文字被裁。
- 命中词在两种主题里都看得清，圆角 3 像素。
- 摘要里 `所有权` 整个被标了出来，而第五张卡片里的“所有实验文件”只标了 `所有`。原因在分词：我跑了 `Searcher.highlight_terms("rust 所有权")`，给出 `['rust', '所有', '有权']`，汉字两个一切，`所有权` 命中两个相叠的片段，合起来是三个字。
- 错误提示条用等宽字，`^` 落在 `(rust` 之后，也就是解析器报错的位置（输入在那里结束，它期待一个 `)`）。

再说不那么好的，我如实记下：

- 预览里 `[!NOTE]` 引用块是字面显示的：Qt 的 Markdown 解析器不认 GitHub 的提示块语法。围栏代码也没有底色和边框，`setMarkdown` 只把它变成等宽字。
- 状态栏的 `557.3 ms` 是错的，或者说是拍截图的脚本自己测出来的数，不属于真实应用。后面的“一次错误的测量”一节会讲：真实的事件循环里同一个查询是 220 毫秒上下。图我没有重拍，脚本也没有改，这个缺陷留在仓库里当作练习 1。

第五张图是 900×600 的最小尺寸，缩放 1：

![最小尺寸 900×600 下的浅色窗口：左边卡片变窄，第四张卡片的标题被省略号截断，摘要仍是两行；右边预览面板变窄，终端命令那两行在右边缘被直接切掉（examples/fib.pebb），没有横向滚动条；状态栏写着“10 条结果 · 232.7 ms · 查询日志已记录”](/assets/images/python-by-sift/ch21-qt-min.webp)

卡片没有被裁，长标题带着省略号。预览里的终端命令却在右边缘被切掉了，没有横向滚动条：`PreviewBrowser` 把横向滚动条设成了 `ScrollBarAlwaysOff`，而围栏代码行不会折行。我读了横向滚动条的范围，窗口宽 900 时是 738 像素，1200 时是 570，1800 时是 445（都是 `rust 所有权` 第一篇文章的数）。这是个真缺口，留作练习。这张图的状态栏写的是 232.7 毫秒，因为这次是在真正的事件循环里等结果的，和前四张图里的 557 毫秒对照看就明白了。

## 对象树：谁来删这个 QLabel

Qt 的窗口是一棵树。每个 `QObject` 可以有一个父对象，父对象被删除时，它所有的子对象一并被删除。这和 Python 的引用计数是两套互不知情的生命周期规则，PySide6 要做的就是让它们别打架。我先用 `hello_qt.py` 看最小的情形：一个应用、一个窗口、一个布局、两个控件，窗口显示 100 毫秒后由 `QTimer.singleShot` 让事件循环退出。

```python
# lab/ch21/hello_qt.py, lines 25-42
    app = QApplication(sys.argv)  # one per process, before any widget
    window = QWidget()
    window.setWindowTitle("hello")
    layout = QVBoxLayout(window)  # the layout takes `window` as owner
    layout.addWidget(QLabel("你好, Qt"))
    layout.addWidget(QPushButton("OK"))
    window.show()

    # ownership: the label is a child of the window, not of Python.
    # Dropping the Python name does not delete it.
    label = QLabel("kept alive by its parent", window)
    label.setObjectName("child")
    del label
    print(
        "children:",
        [c.objectName() or type(c).__name__ for c in window.children()],
    )
    print("found by name:", window.findChild(QLabel, "child") is not None)
```

```text
$ qt python3 lab/ch21/hello_qt.py; echo "exit $?"
children: ['QVBoxLayout', 'QLabel', 'QPushButton', 'child']
found by name: True
platform: offscreen
visible: True
size hint: True
exec returned 0
exit 0
```

有两处值得停一下。一是 `children` 里有 `QVBoxLayout`：布局本身也是窗口的子对象，而 `layout.addWidget` 把“你好, Qt”标签和按钮改认窗口做父亲（我没有给它们传过父对象，它们还是出现在了窗口的 `children()` 里）。二是 `label` 在 Python 里被我 `del` 掉了，`findChild` 还是能按名字把它找回来：这个标签的 C++ 对象由父对象窗口持有，Python 变量只是一个指向它的包装。这有点像把房子租出去：房东（父对象）决定房客什么时候搬走，你手里那把钥匙复印件（Python 变量）丢了，房客还住在里面。

反过来的情形，以及钥匙复印件在房子被拆之后的下场，我写了一个小脚本把四种情形各看一遍：

```python
# /tmp/sift-scratch/ch21/ownership.py, lines 26-62
    # 1. no parent: Python owns it, so dropping the name deletes it
    orphan = QLabel("orphan")
    orphan.destroyed.connect(lambda: log.append("orphan destroyed"))
    del orphan
    gc.collect()
    print("1. no parent, name dropped  ->", log)

    # 2. with a parent: the parent owns it, the name is just a wrapper
    log.clear()
    window = QWidget()
    child = QLabel("child", window)
    child.destroyed.connect(lambda: log.append("child destroyed"))
    del child
    gc.collect()
    kids = len(window.findChildren(QLabel))
    print("2. parent set, name dropped ->", log or "alive", f"({kids} child)")

    # 3. the parent dies: the child goes too, and a kept name goes stale
    log.clear()
    kept = QLabel("kept", window)
    kept.destroyed.connect(lambda: log.append("kept destroyed"))
    print("3. before the parent dies   -> isValid:", shiboken6.isValid(kept))
    shiboken6.delete(window)
    print("   parent deleted           ->", log)
    print("                               isValid:", shiboken6.isValid(kept))
    try:
        kept.text()
    except RuntimeError as error:
        print("   kept.text()              ->", error)

    # 4. a QRunnable given to the pool belongs to the pool afterwards
    job = Job()
    print("4. autoDelete by default    ->", job.autoDelete())
    pool = QThreadPool.globalInstance()
    pool.start(job)
    pool.waitForDone()
    print("   after the pool ran it    -> isValid:", shiboken6.isValid(job))
```

```text
$ qt python3 /tmp/sift-scratch/ch21/ownership.py
1. no parent, name dropped  -> ['orphan destroyed']
2. parent set, name dropped -> alive (1 child)
3. before the parent dies   -> isValid: True
   parent deleted           -> ['child destroyed', 'kept destroyed']
                               isValid: False
   kept.text()              -> libshiboken: Internal C++ object (PySide6.QtWidgets.QLabel) already deleted.
4. autoDelete by default    -> True
   after the pool ran it    -> isValid: False
```

情形 1 没有父对象，Python 持有 C++ 对象，名字一丢，`gc.collect()` 之后 `destroyed` 信号就来了。情形 2 有父对象，同样的 `del` 什么都没发生，窗口的子标签还在。情形 3 是我在项目里最该警惕的一种：我手里还留着 `kept`，窗口被删了，它的 C++ 对象跟着没了，之后碰它就是一个 `RuntimeError`，而不是一个悬空指针。情形 4 是 `QRunnable`：它默认 `autoDelete` 为真，交给线程池跑完后，C++ 对象归线程池管、跑完即删，Python 的 `job` 名字还在，包装已经失效。

这一条直接决定了 `SearchWorker` 的写法：它是一次性的，`run` 结束后没人再读它的任何属性，结果全部通过信号送出。`delegate` 是 `ResultDelegate(tokens, self.list_view)`，把列表视图传给它当父对象，窗口就不用额外为它操心生死。整个项目里我没有手动 `deleteLater` 过任何东西，这不是因为我聪明，而是因为每个控件要么有父对象，要么是 `MainWindow` 的属性。

## 信号与槽

信号是发送者手里的一串可调用对象，`emit` 按连接的顺序调用它们。要紧的是“什么时候调”：直接连接就在 `emit` 里调，排队连接把调用变成一个事件，投到接收者所在线程的事件循环里，等循环转到它时再调。`signals_slots.py` 把这两种放在一个对象上，看顺序：

```python
# lab/ch21/signals_slots.py, lines 23-52
class Counter(QObject):
    """An object with one signal that carries an int."""

    changed = Signal(int)

    def __init__(self) -> None:
        super().__init__()
        self.value = 0

    def bump(self) -> None:
        self.value += 1
        self.changed.emit(self.value)


def connection_types(app: QCoreApplication) -> None:
    """Direct runs inside emit, queued after the loop gets control."""
    counter = Counter()
    log: list[str] = []
    counter.changed.connect(
        lambda v: log.append(f"direct {v}"),
        Qt.ConnectionType.DirectConnection,
    )
    counter.changed.connect(
        lambda v: log.append(f"queued {v}"),
        Qt.ConnectionType.QueuedConnection,
    )
    counter.bump()
    log.append("bump returned")
    app.processEvents()  # the queued call is delivered here
    print("order:", log)
```

```text
$ qt python3 lab/ch21/signals_slots.py; echo "exit $?"
order: ['direct 1', 'bump returned', 'queued 1']
late binding: [2, 2, 2]
default arg: [0, 1, 2]
after disconnect: [1]
exit 0
```

第一行是 `direct 1`，接着是 `bump returned`，最后才是 `queued 1`，要等 `processEvents` 才投递。默认的 `AutoConnection` 在 `emit` 时看发射线程和接收者所在线程是不是同一个：同一个就直接调，不同就排队（这是 Qt 文档的说法，我在下面线程一节用 2000 次跨线程发射验证了“槽确实跑在主线程”）。

还有一个 PySide6 里很容易踩的坑，是 lambda 的晚绑定。脚本里把它和修法并排放着，注释里的 `BAD` 是故意写坏的：

```python
# lab/ch21/signals_slots.py, lines 55-71
def lambda_pitfall() -> None:
    """A lambda closes over the variable, not over its value."""
    counter = Counter()
    seen: list[int] = []
    for i in range(3):
        # BAD: every lambda reads the same `i`, 2 after the loop
        counter.changed.connect(lambda _v: seen.append(i))  # noqa: B023
    counter.bump()
    print("late binding:", seen)

    counter2 = Counter()
    seen2: list[int] = []
    for i in range(3):
        # good: a default argument freezes the value of `i`
        counter2.changed.connect(lambda _v, i=i: seen2.append(i))
    counter2.bump()
    print("default arg:", seen2)
```

输出里 `late binding: [2, 2, 2]` 和 `default arg: [0, 1, 2]` 就是答案：三个 lambda 读的是同一个循环变量 `i`，循环结束时它是 2；默认参数 `i=i` 在定义 lambda 时就把值冻住了。主窗口里“示例查询”按钮踩的是同一个坑的变种，修法也一样，只多一个 `_=False` 吞掉 `clicked` 带来的 `checked` 参数：

```python
# src/sift/gui/qt/window.py, lines 175-186
        chips = QHBoxLayout()
        chips.setSpacing(SPACE_2)
        chips.addStretch(1)
        self.chips: list[QPushButton] = []
        for query in examples:
            chip = QPushButton(query)
            chip.setObjectName("exampleChip")
            chip.setCursor(Qt.CursorShape.PointingHandCursor)
            chip.clicked.connect(lambda _=False, q=query: self.chosen.emit(q))
            chips.addWidget(chip)
            self.chips.append(chip)
        chips.addStretch(1)
```

## 线程：QThreadPool、QRunnable 和 GUI 线程规则

搜索要跑 200 多毫秒，不能占着界面线程。这 200 多毫秒花在哪，我用 `cProfile` 看了一眼（`cProfile` 自己有开销，所以总数比 227 毫秒高）：

```text
$ python3 /tmp/sift-scratch/ch21/longcalls.py
warm find 227 ms, took_ms 227, total 10
terms 0.06 ms
         1162978 function calls (1162966 primitive calls) in 0.411 seconds
   Ordered by: internal time
   List reduced from 93 to 6 due to restriction <6>
   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
   152791    0.136    0.000    0.222    0.000 sift/analysis/tokenize.py:38(iter_tokens)
       10    0.108    0.011    0.147    0.015 sift/snippet.py:25(_origin)
       34    0.034    0.001    0.034    0.001 {built-in method unicodedata.normalize}
       10    0.033    0.003    0.255    0.026 sift/snippet.py:54(_hit_spans)
   152773    0.023    0.000    0.044    0.000 <string>:1(<lambda>)
   152776    0.021    0.000    0.021    0.000 {built-in method __new__ of type object at 0x7ffff7e2d620}
```

`iter_tokens` 被调了 15.2 万次，总耗时排第一；`_origin` 和 `_hit_spans` 都在 `snippet.py` 里，是 `make_snippet` 为 10 条结果的正文找命中位置的循环。也就是说窗口等的主要是给结果的正文再分一遍词，不是打分。这正是第 23 篇要拿来开刀的热点之一。

Qt 给了两条路来把它挪出界面线程：自己建 `QThread`，或者把活儿包成 `QRunnable` 交给 `QThreadPool`。我选了后者，因为线程池替我管线程的创建、复用和回收。`QRunnable` 不是 `QObject`，没有信号，所以结果得由另一个 `QObject` 来发：`SearchSignals` 是个只装两个信号的小容器，`SearchWorker` 拥有它。

```python
# src/sift/gui/qt/worker.py, lines 25-33
class SearchSignals(QObject):
    """The signals of one search; the QRunnable cannot have its own.

    ``finished`` carries the SearchResult and the request id,
    ``failed`` the text to show and the request id.
    """

    finished = Signal(SearchResult, int)
    failed = Signal(str, int)
```

```python
# src/sift/gui/qt/worker.py, lines 36-62
class SearchWorker(QRunnable):
    """Run one query and report it, tagged with its request id."""

    def __init__(self, catalog: Catalog, query: str, request_id: int) -> None:
        """Keep what ``run`` needs; the signals are connected later."""
        super().__init__()
        self.catalog = catalog
        self.query = query
        self.request_id = request_id
        self.signals = SearchSignals()

    @override
    def run(self) -> None:
        """Search on the pool thread and emit one of the signals."""
        try:
            result = self.catalog.find(self.query)
        except QuerySyntaxError as error:
            self.signals.failed.emit(error.render(), self.request_id)
        except SiftError as error:
            self.signals.failed.emit(f"error: {error}", self.request_id)
        except Exception as error:
            # a bug must reach the banner, not die on a pool thread
            log.exception("search failed")
            text = f"error: {type(error).__name__}: {error}"
            self.signals.failed.emit(text, self.request_id)
        else:
            self.signals.finished.emit(result, self.request_id)
```

`run` 在池线程里跑。它做三件事：调 `catalog.find`；把语法错误变成带 `^` 的文本；把任何别的异常记进日志并变成横幅文字，而不是让它死在池线程里（那样就没有任何信号发出，`searching` 永远为真，窗口会一直转着进度条等一个不会来的答案）。它从不碰控件。`finished` 和 `failed` 都带着 `request_id`，窗口靠它丢掉过期的答案：

```python
# src/sift/gui/qt/window.py, lines 505-518, 525-529
    def search_now(self) -> None:
        """Start a search for the text of the box, without waiting."""
        self.debounce.stop()
        text = self.search_edit.text().strip()
        if not text:
            return
        self._request_id += 1
        self._searched = text
        self._started = time.perf_counter()
        self.busy.setRange(0, 0)
        worker = SearchWorker(self.catalog, text, self._request_id)
        worker.signals.finished.connect(self._on_finished)
        worker.signals.failed.connect(self._on_failed)
        self.pool.start(worker)
    # ...
    def _on_finished(self, result: SearchResult, request_id: int) -> None:
        """Show the answer, unless a newer request has been made."""
        if request_id != self._request_id:
            return
        self._answered = request_id
        # ...
```

用户连敲几个字，每次回车或者防抖到点都会发出一个新请求，`_request_id` 加 1；一个请求的答案回来时，`request_id` 不等于当前最新的，就直接丢。这里没有任何取消机制：旧的搜索照样会跑完，只是结果被扔掉（上一篇的 Tk 窗口里我做过“让过期的查询不再去跑”，这一篇没有做，它是练习 3）。测试里用一个带门的假目录把这件事钉住：请求 1 卡在门口，请求 2 先答，再放行请求 1，最后界面上必须是请求 2 的结果。

```python
# tests/test_qt_gui.py, lines 304-320
def test_a_stale_answer_is_dropped(
    qtbot: QtBot, backend: IndexBackend
) -> None:
    catalog = GatedCatalog(backend, slow="kalman")
    win = MainWindow(catalog, scheme="light")
    qtbot.addWidget(win)
    win.search_edit.setText("kalman")
    win.search_now()  # request 1 waits at the gate
    win.search_edit.setText("water")
    win.search_now()  # request 2 is newer and answers first
    wait_for_rows(qtbot, win)
    catalog.gate.set()  # request 1 answers now, and must be ignored
    qtbot.wait(300)
    card = win.model.card(0)
    assert card is not None and card.title == "Tea"
    assert win.model.rowCount() == 1
    win.close()
```

关窗的时候也要等线程池，否则池线程可能在窗口已经销毁之后才发出信号：

```python
# src/sift/gui/qt/window.py, lines 659-664
    @override
    def closeEvent(self, event: QCloseEvent) -> None:
        """Wait for a running search: it must not outlive the window."""
        self.debounce.stop()
        self.pool.waitForDone(2000)
        super().closeEvent(event)
```

### 线程池比线程快吗

`qthread_vs_pool.py` 把两种写法各跑 200 个什么都不做的任务，每个任务发一个信号回主线程，各跑 5 轮取中位数。我前后夹了 `cpu_state.py`，连跑三次：

```text
$ python3 /tmp/sift-scratch/cpu_state.py; for i in 1 2 3; do qt python3 lab/ch21/qthread_vs_pool.py | sed -n '2,3p;4,6p'; done; python3 /tmp/sift-scratch/cpu_state.py
114 118 119 119 137 ms
slots ran: 2000 of 2000
slots ran on: ['MainThread']
QThread         17.45 ms for 200 jobs
QThreadPool      8.18 ms for 200 jobs
ratio QThread / pool: 2.1x
slots ran: 2000 of 2000
slots ran on: ['MainThread']
QThread         17.60 ms for 200 jobs
QThreadPool      8.14 ms for 200 jobs
ratio QThread / pool: 2.2x
slots ran: 2000 of 2000
slots ran on: ['MainThread']
QThread         16.76 ms for 200 jobs
QThreadPool      8.25 ms for 200 jobs
ratio QThread / pool: 2.0x
117 112 114 113 112 ms
```

线程池是线程的 2.0 到 2.2 倍快，单个任务 0.041 毫秒对 0.087 毫秒。但这个差别和一次 227 毫秒的搜索相比是可以忽略的，选线程池的理由是生命周期，不是速度：我不用 `start`、`wait`、`deleteLater` 一套收尾，也不用担心线程对象在任务还没跑完时被回收。另外 `slots ran on: ['MainThread']` 那一行是这一节要的证据：2000 次发射全是从池线程发出的，所有槽却都在主线程里运行，这就是排队连接。

### 在工作线程里碰控件会怎样

规则只有一条：控件只能在 GUI 线程里碰。我写了一个故意违反它的脚本，`gui_thread_violation_fail.py`，它在一个 Python 线程里先给已有的标签 `setText`，再在窗口下面新建一个子标签，同时装了一个 `qInstallMessageHandler` 收集 Qt 的警告：

```python
# lab/ch21/gui_thread_violation_fail.py, lines 31-34
def worker(window: QWidget, label: QLabel) -> None:
    """Do what a worker must never do: use a widget."""
    label.setText("written from a worker thread")  # silent, and wrong
    QLabel("child made in the worker", window)  # Qt warns here
```

```text
$ qt python3 lab/ch21/gui_thread_violation_fail.py; echo "exit $?"
qt QtWarningMsg: QObject::setParent: Cannot set parent, new parent is in a different thread
cross-thread warnings: 1
exit 1
```

退出码是 1，是脚本在收到跨线程警告之后自己返回的（预期的失败）。有意思的是第一行违规 `label.setText(...)` 一点声音都没有，Qt 只对第二行（建子控件）报了警告。也就是说“没有警告”不等于“没有违规”。Qt 文档说控件不是线程安全的，我没试着让它真崩溃，在我这台机器上它只是悄悄地做错了事。

## 一次错误的测量

回到开头。`qt_screenshot.py` 打印的数里有一行 `warm request to rows, median of 7`，状态栏上的 `took_ms` 是同一次搜索的耗时。我跑了一次，前后夹了 `cpu_state.py`：

```text
$ python3 /tmp/sift-scratch/cpu_state.py; qt python3 lab/ch21/qt_screenshot.py --theme light --out /tmp/sift-scratch/ch21/shot.png; python3 /tmp/sift-scratch/cpu_state.py
112 113 114 114 115 ms
platform: offscreen
query: 'rust 所有权' rows: 10
status: 10 条结果 · 555.2 ms · 查询日志已记录
first paint: 280 ms after start
request to rows on screen: 672.8 ms (pool thread, signal back, cards, first preview)
frame interval at 60 Hz: 16.7 ms
saved /tmp/sift-scratch/ch21/shot.png 2400x1520 (660933 bytes)
warm request to rows, median of 7: 425.3 ms
UI thread work per answer (cards, preview): 67.9 ms median
UI thread: 209 ticks of 4 ms, longest gap 260.1 ms
114 114 114 115 115 ms
```

状态栏 555.2 毫秒，第一次请求到画面 672.8 毫秒，连续 7 次的中位数 425.3 毫秒。而 Tk 窗口里同一个查询的搜索只要 224.8 毫秒（下面 Tk 那张表的第一行）。后端是同一个 `IndexBackend`，我先怀疑线程池和 GIL，于是写了一个脱离窗口的探针：纯 `QCoreApplication`，一个 4 毫秒的 `QTimer` 记间隔，同时在池线程里跑真的 `find`：

```text
$ python3 /tmp/sift-scratch/cpu_state.py; qt python3 /tmp/sift-scratch/ch21/gil_probe3.py; python3 /tmp/sift-scratch/cpu_state.py
111 112 112 113 112 ms
find, 5 ms switch          job    226 ms  ticks   44  median   5.1  max   14.6 ms
find, 5 ms switch          job    225 ms  ticks   42  median   5.1  max    9.3 ms
110 111 111 112 111 ms
```

任务 225 到 226 毫秒，和在主线程里单独跑 `find` 一样；4 毫秒的定时器每次的中位间隔是 5.1 毫秒，最大 9.3 到 14.6 毫秒。上一篇里，Tk 的 `mainloop` 在默认 5 毫秒切换间隔下 tick 的中位迟到是 25.1 到 46.5 毫秒（两边的 tick 间隔和测法不同，只能当量级参考），这里的定时器只晚了约 1 毫秒。Qt 的事件循环在 C++ 里等事件，轮到要跑 Python 时才来要 GIL，而 GIL 在 5 毫秒的切换间隔内就让给了它。所以线程池和 GIL 都没毛病，慢的另有原因。

差别在等待的方式。`qt_screenshot.py` 的 `wait_until` 是这样等答案的，它的文档字符串还写着“运行事件循环”：

```python
# lab/ch21/qt_screenshot.py, lines 55-61
def wait_until(window: MainWindow, seconds: float = 30.0) -> None:
    """Run the event loop until the newest search has an answer."""
    deadline = time.monotonic() + seconds
    while window.searching:
        QTest.qWait(5)
        if time.monotonic() > deadline:
            raise TimeoutError("the search did not finish")
```

`QTest.qWait(5)` 听起来像是一个事件循环，实际用起来是一圈一圈轮询的睡眠。我把被测对象换成一个只烧 CPU 的纯 Python 线程，主线程分别用五种方式等它（`Event.wait`、带 2 毫秒轮询定时器的 `QEventLoop`、`time.sleep(0.002)` 的循环、`qWait(2)` 的循环、`qWait(5)` 的循环），各跑两遍。下面只贴其中的两种等法，完整的脚本在 `/tmp/sift-scratch/ch21/qwait_gil.py`：

```python
# /tmp/sift-scratch/ch21/qwait_gil.py, lines 45-52, 61-64
def event_loop(done: threading.Event) -> None:
    """Run a QEventLoop that a 2 ms timer stops when the worker is done."""
    loop = QEventLoop()
    poll = QTimer()
    poll.setInterval(2)
    poll.timeout.connect(lambda: loop.quit() if done.is_set() else None)
    poll.start()
    loop.exec()
# ...
def qwait_2(done: threading.Event) -> None:
    """Call QTest.qWait(2) until the worker is done."""
    while not done.is_set():
        QTest.qWait(2)
```

```text
$ python3 /tmp/sift-scratch/ch21/qwait_gil.py
join only                      worker finished in   467 ms
QEventLoop + 2 ms poll timer   worker finished in   464 ms
time.sleep(2 ms) loop          worker finished in   459 ms
QTest.qWait(2) loop            worker finished in  1246 ms
QTest.qWait(5) loop            worker finished in  1110 ms
join only                      worker finished in   460 ms
QEventLoop + 2 ms poll timer   worker finished in   463 ms
time.sleep(2 ms) loop          worker finished in   452 ms
QTest.qWait(2) loop            worker finished in  1246 ms
QTest.qWait(5) loop            worker finished in  1129 ms
```

`join` 只等、`QEventLoop` 加一个 2 毫秒的轮询定时器、`time.sleep(2 ms)` 这三种等法，工人线程在 452 到 467 毫秒之间完成；`QTest.qWait(2)` 和 `qWait(5)` 轮询时，同一个工人线程要 1110 到 1246 毫秒，是前者的 2.4 到 2.7 倍。我猜多出来的这部分时间，是工人线程拿不到 GIL：`qWait` 在睡眠和处理事件的整段时间里没有放掉它（PySide 的绑定代码是生成的，我没有去读，所以这只是个推测，证据是上面的计时）。

那么真搜索的差别就清楚了。我照着上一篇的 `enter_to_paint.py` 写了一份 Qt 版，一轮的步骤相同（清空、发起搜索、等行出现、再强制画一遍），只把“等”分成两种，其余全一样：

```python
# /tmp/sift-scratch/ch21/enter_to_paint_qt.py, lines 26-37
def wait_polling(window: MainWindow) -> None:
    """Poll with QTest.qWait until the newest search has an answer."""
    while window.searching:
        QTest.qWait(5)


def wait_event_loop(window: MainWindow) -> None:
    """Run a real event loop until the model has been replaced."""
    loop = QEventLoop()
    window.model.modelReset.connect(loop.quit)
    loop.exec()
    window.model.modelReset.disconnect(loop.quit)
```

4 个查询、每个 5 轮共 20 轮。Qt 的两种等法的结果就是开头那张表（`wait=qwait` 和 `wait=loop`），Tk 版在 Xvfb 上跑，前后同样夹了 `cpu_state.py`：

```text
$ (cd lab/ch20 && PYTHONPATH=. xvfb-run -a -s "-screen 0 1100x700x24" python3 enter_to_paint.py); python3 /tmp/sift-scratch/cpu_state.py
query               search   Enter to painted
rust 所有权           224.8 ms          461.9 ms
kalman filter       71.9 ms          172.9 ms
async await         55.2 ms          137.0 ms
设备树 device          11.3 ms           44.0 ms
median over 20 runs: 150.1 ms, worst 487.6 ms
113 114 113 114 113 ms
```

用 `qWait` 轮询，`rust 所有权` 的搜索是 522.9 毫秒；用真正的事件循环是 221.6 毫秒，和 Tk 的 224.8 毫秒几乎一样。其他三个查询也是同样的幅度（169.4 对 70.8、126.7 对 54.6、23.5 对 10.5）。所以：

- 状态栏上的 555 毫秒、`qt_screenshot.py` 报的 `warm request to rows`，都是被轮询拖慢的数，不是窗口的真实延迟。真实延迟是 220 毫秒上下。
- 我在截图脚本里看到的“UI 线程最长间隔 260 毫秒”也和这个有关，后面一节单独讲。
- pytest-qt 不受这个影响：`qtbot.wait` 做的是 `MultiSignalBlocker(timeout=ms, raising=False)` 再 `blocker.wait()`（`pytestqt/qtbot.py` 第 493 到 503 行），`wait` 里是 `qt_api.exec(self._loop)`，一个真的 `QEventLoop`（`pytestqt/wait_signal.py` 第 25 到 37 行建循环和计时器，第 39 到 58 行等待，pytest-qt 4.5.0）；`waitUntil` 每圈调 `self.wait(10)`（`qtbot.py` 第 600 行）。测试里的 `waitUntil` 因此是事件循环式的等待。

这件事对我是个教训：量延迟的脚本自己就会改变被量的东西，尤其是两个线程抢同一把锁的时候。我能发现，是因为 Tk 那份数我已经有了，两个窗口的搜索时间本该一样。如果手里没有那个对照，我大概会把 555 毫秒当成“Qt 就是慢”写下来。

## 布局：每个状态是一页

窗口的骨架是几层嵌套的布局。最外面是竖排：头部、2 像素的忙碌线、正文、状态栏。头部是一行横排：品牌（“Sift”加文档数小标签）、搜索框、主题按钮。正文用 `QStackedWidget` 放三个页面：起始页、没有结果页、和装着结果列表加预览的分割器。切状态就是切页，没有一处靠 `hide()` 和 `show()` 去凑状态，这样“错误横幅出现时不会有半个旧结果还露在外面”这类事不用我操心。

头部那一行是整个窗口里最费脑筋的布局，因为错误横幅会长在搜索框正下方，把头部撑高，而品牌和主题按钮得待在原地：

```python
# src/sift/gui/qt/window.py, lines 323-330
        row = QHBoxLayout(self.header)
        row.setContentsMargins(SPACE_4, SPACE_3, SPACE_4, SPACE_3)
        row.setSpacing(SPACE_3)
        row.addWidget(brand, 0, Qt.AlignmentFlag.AlignTop)
        row.addSpacing(SPACE_5)
        row.addWidget(field_box, 1, Qt.AlignmentFlag.AlignTop)
        row.addStretch(0)
        row.addWidget(self.theme_button, 0, Qt.AlignmentFlag.AlignTop)
```

办法是三件事。横幅和搜索框放在同一个竖排的 `field_box` 里，所以横幅出现时只有它长高；品牌和主题按钮都以 `AlignTop` 加进这一行，不随它拉伸；品牌固定成和搜索框一样的 44 像素，让“Sift”和输入框的中线对齐。`field_box.setMaximumWidth(760)` 让大窗口里搜索框不会拉成一条线。

主体用 `QSplitter`，初始 44% 比 56%，之后随窗口等比缩放：

```python
# src/sift/gui/qt/window.py, lines 373-382
        self.splitter = QSplitter(Qt.Orientation.Horizontal)
        self.splitter.setChildrenCollapsible(False)
        self.splitter.setHandleWidth(SPACE_3)
        self.splitter.addWidget(self.list_view)
        self.splitter.addWidget(panel)
        body_width = WIDTH - 2 * SPACE_4
        left = body_width * RESULTS_SHARE // 100
        self.splitter.setSizes([left, body_width - left])
        self.splitter.setStretchFactor(0, RESULTS_SHARE)
        self.splitter.setStretchFactor(1, 100 - RESULTS_SHARE)
```

我在三个窗口尺寸下读了分割器的实际尺寸和预览视口宽度：

```text
$ qt python3 /tmp/sift-scratch/ch21/layout.py
window 1200x760: splitter [508, 648] (44% / 56%), preview viewport 584 px, hscroll max 570, card 0 496x124, card 1 starts at y=124
window 900x600: splitter [376, 480] (44% / 56%), preview viewport 416 px, hscroll max 738, card 0 364x124, card 1 starts at y=124
window 1800x900: splitter [771, 985] (44% / 56%), preview viewport 709 px, hscroll max 445, card 0 759x124, card 1 starts at y=124
minimum size: 900 x 600
```

三个尺寸下都是 44% 对 56%（508 对 648、376 对 480、771 对 985），最小尺寸 900×600 也守住了。在 1800 宽的窗口里预览视口是 709 像素，没有超过 720 的上限（`tests/test_qt_gui.py` 里另有一个把窗口拉到 2000 宽的测试专门断言这件事）。卡片宽度跟着视口走，所以窄窗口里每张卡片比宽窗口里高：这一点要让委托知道，下面讲。

## Model、View、Delegate

Qt 把一个列表拆成三个角色。模型管数据，并在数据变了的时候通知别人；视图管滚动、选择和布局，决定哪些行可见；委托管一行长什么样。一个比方就够了：模型是仓库，视图是橱窗，委托是橱窗里的陈列师。仓库不知道橱窗多宽，陈列师不知道仓库里还有什么，橱窗只管问陈列师“这一件要占多高”再把它摆上去。

最小的例子是 `model_view.py`：一个只要实现 `rowCount` 和 `data` 的列表模型，一个自定义的角色（role）。角色回答的是“你要这一项的哪一面”：显示文字、提示文字，或者我自己定义的值。

```python
# lab/ch21/model_view.py, lines 25-37, 54-59
class Words(QAbstractListModel):
    """Words with a score; the view shows the word."""

    def __init__(self, items: list[tuple[str, float]]) -> None:
        super().__init__()
        self.items = items

    @override
    def rowCount(
        self,
        parent: QModelIndex | QPersistentModelIndex = QModelIndex(),  # noqa: B008
    ) -> int:
        return 0 if parent.isValid() else len(self.items)
    # ...
    def set_score(self, row: int, score: float) -> None:
        """Change one score and tell the views which cell changed."""
        word, _ = self.items[row]
        self.items[row] = (word, score)
        index = self.index(row)
        self.dataChanged.emit(index, index, [ScoreRole])
```

```text
$ qt python3 lab/ch21/model_view.py; echo "exit $?"
rows: 3
0 rust 2.5
1 kalman 4.25
2 tea 0.5
dataChanged: [(1, [257])]
rows after reset: 0
exit 0
```

`dataChanged: [(1, [257])]` 里的 257 就是 `ScoreRole`，也就是 `Qt.UserRole`（256）加 1：模型改了第 1 行的分数，只通知“第 1 行的 257 号角色变了”，视图只需要重画这一格。最后的 `beginResetModel` 和 `endResetModel` 是批量替换：视图在这一对调用之间不会来问数据，之后丢掉自己的选择和滚动状态，从头开始。

真正的结果模型沿用这个套路。一张卡片的所有内容放进一个冻结的数据类 `Card`，模型用 `CardRole` 把整个 `Card` 对象交给委托；`Qt.DisplayRole` 和 `Qt.ToolTipRole` 另外返回标题和路径，是给不认识卡片的那部分 Qt（辅助功能桥和工具提示）用的：

```python
# src/sift/gui/qt/model.py, lines 25-26, 31-51
CardRole = Qt.ItemDataRole.UserRole + 1
MAX_TAGS = 3
# ...
@dataclass(frozen=True, slots=True)
class Card:
    """Everything one result card shows."""

    doc_id: int
    title: str
    score: float
    date: str
    category: str
    tags: tuple[str, ...]
    snippet: list[tuple[str, bool]]
    path: Path

    @property
    def score_text(self) -> str:
        """Return the score as the pill shows it.

        >>> Card(1, "t", 2.345, "", "", (), [], Path("a.md")).score_text
        '2.35'
        """
        return f"{self.score:.2f}"
```

```python
# src/sift/gui/qt/model.py, lines 81-92, 118-122
class ResultsModel(QAbstractListModel):
    """A flat list of cards; the rows are replaced as a whole."""

    def __init__(self) -> None:
        """Start with no rows."""
        super().__init__()
        self._cards: list[Card] = []

    @override
    def rowCount(self, parent: Index = QModelIndex()) -> int:  # noqa: B008
        """Return the number of cards; a flat list has no children."""
        return 0 if parent.isValid() else len(self._cards)
    # ...
    def set_cards(self, cards: list[Card]) -> None:
        """Replace every row; views reset and drop their selection."""
        self.beginResetModel()
        self._cards = cards
        self.endResetModel()
```

`set_cards` 是整体替换，所以选择会被丢掉，窗口在 `_on_finished` 里紧接着把当前行设成第 0 行（`self.list_view.setCurrentIndex(self.model.index(0))`），预览才有东西可看。`Card.score_text` 带一个 doctest，用 `--doctest-modules` 单独跑它：

```text
$ python3 -m pytest --doctest-modules src/sift/gui/qt/model.py 2>&1 | tail -1
1 passed in 0.62s
exit 0
```

### 让卡片知道自己有多高

模型一换，视图就问委托每一行的 `sizeHint`。这是整个自绘里最容易出错的地方：高度如果算少了，文字被裁；算多了，卡片下面一片空白。我的做法是让 `sizeHint` 和 `paint` 用同一套算术，这样两者不可能不一致。关键是摘要的排版：先用 `QTextLayout` 按宽度断行，最多两行，超出的部分截掉并补一个 `…`。

```python
# src/sift/gui/qt/delegate.py, lines 81-102
def lay_out(text: str, font: QFont, width: float) -> QTextLayout:
    """Break text into lines of at most width pixels.

    Lines may break between any two CJK characters and at spaces in
    Latin text; a word longer than a line is cut.
    """
    layout = QTextLayout(text, font)
    option = QTextOption()
    option.setWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
    layout.setTextOption(option)
    layout.setCacheEnabled(True)
    layout.beginLayout()
    y = 0.0
    while True:
        line = layout.createLine()
        if not line.isValid():
            break
        line.setLineWidth(width)
        line.setPosition(QPointF(0.0, y))
        y += line.height()
    layout.endLayout()
    return layout
```

`WrapAtWordBoundaryOrAnywhere` 是给中文准备的：拉丁文在空格处断行，汉字在任意两个字之间断，一个比一行还长的单词才被硬切。`QTextLayout` 手动断行的写法有点老派（`createLine`、`setLineWidth`、`setPosition` 一路循环），好处是我能在不画任何东西的情况下得到每行的起止位置和高度，`sizeHint` 要的恰好是这个。

```python
# src/sift/gui/qt/delegate.py, lines 115-148
def fit_snippet(
    parts: list[tuple[str, bool]],
    font: QFont,
    width: float,
    max_lines: int = SNIPPET_LINES,
) -> Snippet:
    """Lay out the snippet parts in at most max_lines lines.

    If the text is longer, it is cut at the end of the last line and
    ends with an ellipsis; the cut is made on the text, and the hit
    spans are clipped to it, so the painted text is the laid out
    text.
    """
    text = "".join(piece for piece, _ in parts).replace("\n", " ")
    spans: list[tuple[int, int]] = []
    cursor = 0
    for piece, is_hit in parts:
        if is_hit:
            spans.append((cursor, cursor + len(piece)))
        cursor += len(piece)
    layout = lay_out(text, font, width)
    if layout.lineCount() > max_lines:
        last = layout.lineAt(max_lines - 1)
        end = last.textStart() + last.textLength()
        while True:
            text = text[:end].rstrip() + "…"
            layout = lay_out(text, font, width)
            if layout.lineCount() <= max_lines or end <= 1:
                break
            end -= 1
        limit = len(text) - 1
        spans = [(a, min(b, limit)) for a, b in spans if a < limit]
    height = sum(layout.lineAt(i).height() for i in range(layout.lineCount()))
    return Snippet(layout, spans, height)
```

截断的逻辑要多看一眼。文字超过两行时，从第二行末尾开始，每次把文字往回缩一个字符、补上 `…`，重新排版，直到两行装得下。命中片段（`spans`）是按字符位置记的，截断之后必须跟着剪：落在被截掉部分里的命中直接丢，跨过截断点的命中缩到 `limit`。如果只截文字不剪片段，画出来的高亮框会超出文字。有一个测试专门钉这件事，一个 400 个 `x` 后面跟一个命中词的摘要，截断后 `snippet.spans == []`。

`sizeHint` 把这些加起来（上下内边距、标题行、标签行、摘要高度、卡片之间的 8 像素间隙），标题行取 15 像素粗体字高和 22 像素分数药丸的较大者：

```python
# src/sift/gui/qt/delegate.py, lines 186-197
    @override
    def sizeHint(self, option: QStyleOptionViewItem, index: Index) -> QSize:
        """Return the size of the card of index, gap included."""
        card = index.data(CardRole)
        width = self.row_width(option)
        if not isinstance(card, Card):
            return QSize(width, 0)
        snippet = self.snippet_for(card, width)
        height = 2 * PAD_Y + self.top_height() + SPACE_1 + CHIP_H
        if snippet.spans or snippet.layout.text():
            height += SPACE_2 + snippet.height
        return QSize(width, int(height + 0.999) + GAP)
```

测试里放了两张卡：一张摘要只有一行，一张有一个很长的标题和两行摘要，断言它们的高度差等于 `fit_snippet` 算出的两个摘要的高度差（误差 1 像素以内），长摘要的最后一个字符是 `…`，不存在的行得到高度 0：

```text
$ python3 -m pytest tests/test_qt_gui.py -k "as_tall or ellipsis" 2>&1 | tail -1
2 passed, 20 deselected in 0.82s
exit 0
```

整个 Qt 测试文件有 22 个测试，下一节讲，先说委托里最后一件事：绘制。

## 用 QPainter 画一张卡片

`paint` 拿到一个 `QPainter`，一个已经裁成这一行大小的矩形。我给每张卡片从上到下画四样东西：卡片底和边框、标题行、元信息行、摘要。

卡片底的画法里有个绕不开的细节。`QPen` 的线宽是以路径为中心向两边各扩一半的，1 像素的边框如果直接沿着矩形边画，会有一半画到矩形外面，被这一行的裁剪区域切掉。所以我把矩形向内缩半个线宽：1 像素的边框缩 0.5，选中态 2 像素的边框缩 1.0：

```python
# src/sift/gui/qt/delegate.py, lines 227-256
    def paint_card_box(
        self,
        painter: QPainter,
        rect: QRectF,
        selected: bool,
        hover: bool,
    ) -> None:
        """Fill the card and draw its border.

        Selected: 2 px accent border on ``accent_soft``. Hover: the
        accent at 40% alpha. Otherwise 1 px ``border`` on ``surface``.
        """
        t = self.tokens
        if selected:
            fill, pen, half = (
                QColor(t.accent_soft),
                QPen(QColor(t.accent), 2),
                1.0,
            )
        elif hover:
            edge = QColor(t.accent)
            edge.setAlphaF(0.4)
            fill, pen, half = QColor(t.surface), QPen(edge, 1), 0.5
        else:
            fill, pen, half = QColor(t.surface), QPen(QColor(t.border), 1), 0.5
        painter.setPen(pen)
        painter.setBrush(fill)
        painter.drawRoundedRect(
            rect.adjusted(half, half, -half, -half), RADIUS_CARD, RADIUS_CARD
        )
```

三种状态一目了然：选中是 2 像素的强调色边框加强调色的软底；悬停是强调色的 40% 透明度边框（`setAlphaF(0.4)`）；平时是 1 像素的 `border` 色加 `surface` 底。分数药丸和标签小药丸画法相同，一个圆角矩形，圆角半径取高度的一半，字居中。选中的卡片里药丸和标签的底色换成 `surface`，免得和 `accent_soft` 的卡片底撞色。

最有意思的是命中词的高亮。我想要的是带 3 像素圆角的底色块，可 `QTextLayout.draw` 只能改字符的前景色，不会画圆角背景。所以分两步：先对每一行的每个命中片段算出它的左右 x 坐标，画一个圆角矩形，然后再把整段文字画上去，命中的部分用 `mark_text` 色。

```python
# src/sift/gui/qt/delegate.py, lines 334-372
    def paint_snippet(
        self, painter: QPainter, snippet: Snippet, x: float, y: float
    ) -> None:
        """Draw the snippet lines; hits sit on a rounded mark_bg box.

        The boxes go first, the text over them in ``mark_text``:
        a ``QTextLayout`` draws text with the colors of its format
        ranges, and has no notion of a rounded background.
        """
        t = self.tokens
        layout = snippet.layout
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(t.mark_bg))
        for i in range(layout.lineCount()):
            line = layout.lineAt(i)
            first = line.textStart()
            last = first + line.textLength()
            for start, end in snippet.spans:
                a, b = max(start, first), min(end, last)
                if a >= b:
                    continue
                left = x_of(line, a)
                right = x_of(line, b)
                box = QRectF(
                    x + left - 1,
                    y + line.y() + 1,
                    right - left + 2,
                    line.height() - 2,
                )
                painter.drawRoundedRect(box, MARK_RADIUS, MARK_RADIUS)
        formats: list[QTextLayout.FormatRange] = []
        for start, end in snippet.spans:
            fmt_range = QTextLayout.FormatRange()
            fmt_range.start = start
            fmt_range.length = end - start
            fmt_range.format.setForeground(QColor(t.mark_text))
            formats.append(fmt_range)
        painter.setPen(QColor(t.text))
        snippet.layout.draw(painter, QPointF(x, y), formats)
```

`x_of` 值得单说一句。`QTextLine.cursorToX` 在 PySide6 的类型声明里返回 `object`，真实返回的是 `(x, 光标位置)` 这一对，所以 `delegate.py` 里有一个只做 `cast` 的 `x_of`，让类型检查器闭嘴，并且把这个事实写在了一个地方。

画布本身的最小实验是 `delegate_paint.py`：两张纯色卡片，把视图 `grab` 成图片，再读两个像素。

```text
$ qt python3 lab/ch21/delegate_paint.py; echo "exit $?"
size: 240 x 140
inside card: #4f46e5
in the gap : #111319
card color painted: True
exit 0
```

卡片中心 `#4f46e5` 就是我画的颜色。两张卡片之间的缝隙里是 `#111319`，这不是我画的：这个实验里的视图没有任何样式表，它露出的是系统调色板的窗口色，而这台机器的系统方案是深色（`scheme.py` 的输出里 `system colorScheme(): Dark`，后面讲深色模式时会看到）。这也是项目里“不留默认灰”的由来：只要有一个控件没被样式表覆盖，它就会在浅色主题里露出一块深色，或者反过来。

## QSS 与设计令牌

“好看”我是这样落地的：所有颜色放进一个冻结的数据类，所有尺寸放进几个常量，整个窗口的外观由一个函数从这两样东西生成一份 QSS。颜色不会出现在别处。

```python
# src/sift/gui/qt/theme.py, lines 39-74
@dataclass(frozen=True, slots=True)
class Tokens:
    """The colors of one theme, as ``#RRGGBB`` strings."""

    name: Scheme
    bg: str
    surface: str
    surface_alt: str
    border: str
    text: str
    muted: str
    accent: str
    accent_hover: str
    accent_soft: str
    mark_bg: str
    mark_text: str
    error: str
    error_soft: str


LIGHT = Tokens(
    name="light",
    bg="#F7F8FA",
    surface="#FFFFFF",
    surface_alt="#F1F3F7",
    border="#E4E7EC",
    text="#1D2433",
    muted="#667085",
    accent="#4F46E5",
    accent_hover="#4338CA",
    accent_soft="#EEF2FF",
    mark_bg="#FDE68A",
    mark_text="#1D2433",
    error="#DC2626",
    error_soft="#FEF2F2",
)
```

深色那一份 `DARK` 的结构一模一样，只有颜色值不同。命中色最需要想：浅色用 `#FDE68A` 黄底配 `#1D2433` 深字，深色用 `#854D0E` 棕底配 `#FEF3C7` 浅字，和强调色的靛蓝不抢（我看了截图确认过）。“够不够清楚”我不想只凭眼睛说，所以按 WCAG 的相对亮度公式算了令牌里几对文字和底色的对比度：

```python
# /tmp/sift-scratch/ch21/contrast.py, lines 6-19
def luminance(color: str) -> float:
    """Return the WCAG relative luminance of a #RRGGBB color."""
    channels = [int(color[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [
        c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
        for c in channels
    ]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast(a: str, b: str) -> float:
    """Return the contrast ratio of two colors, from 1 to 21."""
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)
```

```text
$ python3 /tmp/sift-scratch/ch21/contrast.py
light text on surface        15.53
light muted on surface        4.97
light mark_text on mark_bg   12.47
light accent on accent_soft   5.62
light error on error_soft     4.41
dark  text on surface        14.21
dark  muted on surface        6.76
dark  mark_text on mark_bg    6.15
dark  accent on accent_soft   5.36
dark  error on error_soft     5.93
```

命中色是 12.47 和 6.15，正文对卡片底 15.53 和 14.21，都很宽裕。淡灰的 `muted` 在浅色里是 4.97，只刚过 4.5 这条常被引用的线。最低的一对是浅色的错误红对错误底，4.41，略低于那条线。这几个数是我算的，不等于做过无障碍评估：完整的验证需要辅助技术上的人工测试和专业评审。这一对我没有改，记在文末的清单里。

QSS 是 Qt 的 CSS 子集，选择器、盒模型和伪状态都像网页，生成它的就是一个大 f-string（下面只贴前半，到输入框为止）：

```python
# src/sift/gui/qt/theme.py, lines 128-163
def generate_qss(t: Tokens) -> str:
    """Return the style sheet of the whole window for tokens t."""
    sans = _families(FAMILIES)
    mono = _families(MONO_FAMILIES)
    return f"""
QWidget {{
    background: {t.bg};
    color: {t.text};
    font-family: {sans};
    font-size: {SIZE_BODY}px;
    selection-background-color: {t.accent_soft};
    selection-color: {t.text};
}}
QLabel {{ background: transparent; }}
QMainWindow, QStackedWidget, QSplitter {{ background: {t.bg}; }}

/* header */
#header {{
    background: {t.surface};
    border: 0;
    border-bottom: 1px solid {t.border};
}}
#brand, #fieldBox {{ background: transparent; }}
#appName {{
    font-size: {SIZE_HEADER}px;
    font-weight: 600;
    color: {t.text};
}}
#chip {{
    background: {t.accent_soft};
    color: {t.accent};
    border-radius: 11px;
    padding: 2px 10px;
    font-size: {SIZE_META}px;
    font-weight: 600;
}}
```

f-string 里 `{{` 和 `}}` 是转义的花括号，刚开始读很吵，但换来的好处是一个函数能同时生成两份样式表。`qss_tokens.py` 把两份都打出来，我拿它做了一个检查：把两份里所有 `#RRGGBB` 都替换成 `#` 之后做 `diff`，结果是 0 行，也就是说两份样式表除了颜色，字字相同。

```text
$ python3 lab/ch21/qss_tokens.py | awk '/^\/\* =====/ {n++; print; next} {print > ("/tmp/sift-scratch/ch21/qss_" n ".txt")}'; wc -l /tmp/sift-scratch/ch21/qss_1.txt /tmp/sift-scratch/ch21/qss_2.txt | sed -n '1,2p'; diff <(sed 's/#[0-9A-Fa-f]\{6\}/#/g' /tmp/sift-scratch/ch21/qss_1.txt) <(sed 's/#[0-9A-Fa-f]\{6\}/#/g' /tmp/sift-scratch/ch21/qss_2.txt) | wc -l; diff /tmp/sift-scratch/ch21/qss_1.txt /tmp/sift-scratch/ch21/qss_2.txt | grep -c '^<'
/* ===== light: 196 lines ===== */
/* ===== dark: 196 lines ===== */
 197 /tmp/sift-scratch/ch21/qss_1.txt
 197 /tmp/sift-scratch/ch21/qss_2.txt
0
61
```

每份 196 行（`wc` 数出 197，是因为 `print` 在末尾多补了一个换行），原始 `diff` 有 61 行不同，全是颜色。这就是“深色模式不是另写一套样式”的含义：一个函数，两组令牌。

### 调色板和样式表都得管

只有样式表是不够的。样式表给它点名的控件上色，而 `window()`、工具提示，以及没有对应规则的控件部件，用的是 `QPalette`。所以 `apply_theme` 一次装三样东西：Fusion 样式、调色板、样式表：

```python
# src/sift/gui/qt/theme.py, lines 361-373
def apply_theme(app: QApplication, scheme: Scheme) -> Tokens:
    """Install Fusion, the palette and the style sheet of scheme.

    Return the tokens, which the delegate and the preview need. The
    style is set only once: ``setStyle`` builds a new style object
    and repolishes every widget, which a theme switch does not need.
    """
    if app.style().objectName().lower() != "fusion":
        app.setStyle("Fusion")
    tokens = TOKENS[scheme]
    app.setFont(make_font(SIZE_BODY))
    app.setPalette(make_palette(tokens))
    app.setStyleSheet(generate_qss(tokens))
```

`setStyle("Fusion")` 只在第一次调用，因为它会重建样式对象并重新给每个控件上一遍样式，主题切换不需要这个（切换时只重装调色板和样式表）。测试里有一条断言钉着这件事：调色板的 `Window` 色必须等于令牌里的 `bg`，切换后等于另一份令牌的 `bg`。换句话说，“浅色主题”不只是样式表里写了浅色，而是 `window.palette().color(Window)` 真的是 `#F7F8FA`。

### 选择器的优先级，以及一次吃掉横幅的规则

QSS 和 CSS 一样有层叠和特异性，更具体的选择器赢。我第一版的错误横幅就是这么没的：头部有一条后代选择器的规则把里面的标签背景设成了透明，而它比 `#banner` 更具体，横幅的红底就没了。第一版的原始规则我没有保留，下面的小脚本复现的是这个机制，不是当时的代码：

```text
$ qt python3 /tmp/sift-scratch/ch21/qss_specificity.py
#banner alone                                        banner pixel #fef2f2 alpha 255
QLabel { background: transparent } added             banner pixel #fef2f2 alpha 255
#header QLabel { background: transparent } added     banner pixel #000000 alpha 0
```

`#banner` 单独存在时像素是 `#fef2f2`、不透明；再加一条 `QLabel { background: transparent }`，它输给 `#banner`（ID 选择器比类型选择器具体），像素没变；加一条 `#header QLabel { background: transparent }`，ID 加类型的组合比单个 ID 更具体，像素变成完全透明（alpha 为 0）。所以现在的 QSS 里，所有会被后代规则波及的东西，我都给了自己的 ID。

### 字体：Inter 不认识的字

字体设置是一个有序的家族列表，Inter 在前，Noto Sans CJK SC 在后；Qt 逐字符找字形，第一个家族没有的字落到下一个。

拉丁字用 Inter，汉字用 Noto：这台机器上 `fc-match` 把两个名字都指到了 Nix 存储里的文件（环境一节），别的机器上我没有验证。等宽字也一样：`JetBrains Mono` 在前，`DejaVu Sans Mono` 在后。等宽字里有个坑我特意查了：错误横幅依赖等宽对齐，查询里有汉字时，`QuerySyntaxError.render()` 用显示宽度（汉字占 2 格）算出 `^` 前面该有几个空格。这只有在汉字的宽度恰好是拉丁字母的 2 倍时才对得齐。我用 `QFontMetricsF` 量了 `^` 所在的 x 坐标和查询末尾的 x 坐标，先在默认的字体配置下：

```text
$ qt python3 /tmp/sift-scratch/ch21/caret_cjk.py
"expected ')'\n  (rust\n       ^"
  caret x = 50.3 px, text ends at x = 50.3 px (query is expected to end where the caret is)
"expected ')'\n  (所有权\n         ^"
  caret x = 64.7 px, text ends at x = 64.7 px (query is expected to end where the caret is)
"expected ')'\n  (rust 所有权\n              ^"
  caret x = 100.6 px, text ends at x = 100.7 px (query is expected to end where the caret is)
```

对得上，差 0.1 像素。可这是侥幸。`flake.nix` 里的 `makeFontsConf` 会把宿主机的字体也扫进来，我这台机器上有一款等宽的中文字体 Maple Mono NF CN。让 `fc-match` 在 JetBrains Mono 和通用的 `monospace` 里各找一个带“所”字的字体（`charset=6240` 里的 6240 是它的十六进制码点 U+6240）：

```text
$ for p in "JetBrains Mono:charset=6240" "monospace:charset=6240"; do fc-match -f "%{family}: %{file}\n" "$p"; done
Maple Mono NF CN: /nix/store/...-MapleMono-NF-CN-7.9/share/fonts/truetype/MapleMono-NF-CN-Regular.ttf
Maple Mono NF CN: /nix/store/...-MapleMono-NF-CN-7.9/share/fonts/truetype/MapleMono-NF-CN-Regular.ttf
```

两次都选了它，它的汉字宽度正好是拉丁字母的 2 倍。把宿主机的字体拿掉，只留 Inter、Noto Sans CJK SC 和 JetBrains Mono 三个包（我手写了一份 `fonts.conf`，只列这三个包的字体目录，用 `FONTCONFIG_FILE` 指过去）再量一遍：

```text
$ FONTCONFIG_FILE=/tmp/sift-scratch/ch21/nohost-fonts.conf qt python3 /tmp/sift-scratch/ch21/caret_cjk.py
"expected ')'\n  (rust\n       ^"
  caret x = 49.0 px, text ends at x = 49.0 px (query is expected to end where the caret is)
"expected ')'\n  (所有权\n         ^"
  caret x = 63.0 px, text ends at x = 57.0 px (query is expected to end where the caret is)
"expected ')'\n  (rust 所有权\n              ^"
  caret x = 98.0 px, text ends at x = 92.0 px (query is expected to end where the caret is)
```

从 x 坐标可以反推：`(rust` 前面两个空格加五个字符是 49.0 像素，每个拉丁字符 7 像素；`(所有权` 的 `^` 前面是 63.0 像素，而文字末尾只有 57.0，三个汉字合计 36 像素，每个 12 像素，是拉丁字母的 1.71 倍而不是 2 倍。三个汉字之后，`^` 比实际的末尾靠右 6 像素，差不多一个字符。这是个真缺口：我没有修，只在这里记下，修法留作练习。

### 图标

图标用 `qtawesome`，它把图标字体里的字形按颜色画成 `QIcon`。它没有类型信息，我在 `typings/qtawesome/__init__.pyi` 里写了一份 5 行的桩，只声明用到的那一个函数，让 `mypy` 和 `pyright` 都认；`theme.py` 里的 `icon()` 是整个项目里唯一调它的地方。图标要等 `QApplication` 存在才能画。`import qtawesome` 本身要花多少，我量了：

```text
$ python3 -c "import time; t = time.perf_counter(); import PySide6.QtWidgets; a = time.perf_counter() - t; t = time.perf_counter(); import qtawesome; b = time.perf_counter() - t; print(f'PySide6.QtWidgets {a * 1000:.0f} ms, qtawesome {b * 1000:.0f} ms')"
PySide6.QtWidgets 101 ms, qtawesome 132 ms
```

## 预览：一个编辑块省了 2.7 秒

右边的预览是个 `QTextBrowser`，正文用 `QTextDocument.setMarkdown` 渲染原始 Markdown，标题和元信息行是我在文档前面插进去的两个块，命中词用 `QTextDocument.find` 找到后合并一个带背景的字符格式。

```python
# src/sift/gui/qt/preview.py, lines 66-88
    def show_post(
        self,
        title: str,
        meta: str,
        markdown: str,
        terms: set[str],
        tokens: Tokens,
    ) -> None:
        """Replace the document by one post and mark the terms."""
        doc = self.document()
        doc.setMarkdown(markdown)
        # One edit block for every format change below: each change
        # inside it would otherwise lay the whole post out again, a
        # second of work on the UI thread for a long post.
        edit = QTextCursor(doc)
        edit.beginEditBlock()
        self._put_header(doc, title, meta, tokens)
        self._set_line_height(doc)
        self._use_mono_for_code(doc)
        self.marks = mark_terms(doc, terms, tokens)
        edit.endEditBlock()
        self.moveCursor(QTextCursor.MoveOperation.Start)
        self.verticalScrollBar().setValue(0)
```

那对 `beginEditBlock` 和 `endEditBlock` 是整个预览里最值钱的两行。没有它们，每一次 `mergeCharFormat`、每一次 `insertText` 都是一次独立的文档修改，`QTextDocument` 每次都发一个 `contentsChange` 通知，文档布局随之重算。一篇文章命中几十处，再加上给每个等宽片段单独设字体、插两个标题块，修改次数轻易上千。编辑块把它们合成一次。我数了通知的次数，也量了时间。

先看通知：

```text
$ qt python3 /tmp/sift-scratch/ch21/preview_signals.py
ch21 show_post                       contentsChange emitted     4x  scroll 0 of 26248
no edit block                        contentsChange emitted  1172x  scroll 0 of 26248
edit block, no cursor/scroll reset   contentsChange emitted     4x  scroll 0 of 26248
```

同一篇文章（`rust 所有权` 的第一条），带编辑块是 4 次，不带是 1172 次。时间方面，我把 `show_post` 去掉两行 `beginEditBlock`/`endEditBlock` 之后另存成一个函数，对三篇文章各跑三遍取中位数：

```python
# /tmp/sift-scratch/ch21/preview_cost.py, lines 16-32
def show_without_block(
    self: P.PreviewBrowser,
    title: str,
    meta: str,
    markdown: str,
    terms: set[str],
    tokens: Tokens,
) -> None:
    """Run show_post of ch21 minus beginEditBlock/endEditBlock."""
    doc = self.document()
    doc.setMarkdown(markdown)
    self._put_header(doc, title, meta, tokens)
    self._set_line_height(doc)
    self._use_mono_for_code(doc)
    self.marks = P.mark_terms(doc, terms, tokens)
    self.moveCursor(QTextCursor.MoveOperation.Start)
    self.verticalScrollBar().setValue(0)
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; qt python3 /tmp/sift-scratch/ch21/preview_cost.py; python3 /tmp/sift-scratch/cpu_state.py
111 112 114 117 113 ms
123 posts, markdown chars: median 17150, max 127275
first hit      37515 chars  one edit block (ch21)  show_post    58.0 ms  marks 108
first hit      37515 chars  no edit block          show_post   585.5 ms  marks 108
median post    17150 chars  one edit block (ch21)  show_post    27.3 ms  marks 19
median post    17150 chars  no edit block          show_post    78.8 ms  marks 19
longest post  127275 chars  one edit block (ch21)  show_post   154.7 ms  marks 66
longest post  127275 chars  no edit block          show_post  2848.7 ms  marks 66
112 113 113 113 113 ms
```

第一条结果（37515 个字符）从 585.5 毫秒降到 58.0 毫秒，快了 10 倍；中位数大小的文章从 78.8 降到 27.3 毫秒，2.9 倍；整个语料里最长的一篇（127275 个字符）从 2848.7 毫秒降到 154.7 毫秒，快了 18 倍。58 毫秒大约是 `_on_finished` 里“界面线程每个答案做的事”的绝大部分（后面一节量总数）。我相信代价来自每次修改后的重新布局，但我只数了通知，没有去剖析 Qt 的布局代码，所以这是个有数字撑腰的推断。

另外两行值得说一句：`show_post` 结尾的 `moveCursor(Start)` 和 `verticalScrollBar().setValue(0)`。没有它们，换了文章以后，文本光标会留在文档末尾。我在几篇文章上试了：去掉这两行，光标位置是 75178（文档末尾），保留时是 0。但不管有没有这两行，滚动条的位置我都读到 0，无论预览有没有焦点。我之前在窗口里遇到过“预览一打开就停在文章底部”，这两行就是那时加的，可这一次我没能在小实验里让它重现，所以我把它们当作防御，不当作“已证实的修复”：

```text
$ qt python3 /tmp/sift-scratch/ch21/preview_scroll.py
focus=False ch21 show_post                       scroll after each post: ['0/26248', '0/32207', '0/60231']  cursor at 0
focus=False edit block, no cursor/scroll reset   scroll after each post: ['0/26248', '0/32207', '0/60231']  cursor at 75178
focus=True  ch21 show_post                       scroll after each post: ['0/26248', '0/32207', '0/60231']  cursor at 0
focus=True  edit block, no cursor/scroll reset   scroll after each post: ['0/26248', '0/32207', '0/60231']  cursor at 75178
```

命中词的标注在 `preview.py` 的 `mark_terms` 里（`preview.py` 第 165 到 184 行）：`find` 默认不分大小写，`mergeCharFormat` 把背景和前景叠在文字原有的格式上，所以标题、代码、列表的格式不会丢。`MAX_MARKS = 2000` 是一道保险：一个单字的汉字词在长文章里可以命中几千次，每次选择都要布局。`rust 所有权` 的词项是 `rust`、`所有`、`有权`（前面讲过中日韩文字两字一切），第一篇里一共标了 108 处（见上面 `preview_cost` 的 `marks 108`）。

最后是 720 像素的文字列。`QTextBrowser` 自己没有“最大文字宽度”，我用 `setViewportMargins` 在窗口宽时把两边的边距撑大：

```python
# src/sift/gui/qt/preview.py, lines 55-58
    def _apply_margins(self) -> None:
        """Center the text column: 24 px, or more in a wide pane."""
        side = max(SPACE_5, (self.width() - MAX_TEXT_WIDTH) // 2)
        self.setViewportMargins(side, SPACE_5, side, SPACE_5)
```

边距取 24 像素和 `(宽度 - 720) // 2` 的较大者，随 `resizeEvent` 更新。窗口再宽，文字列也不超过 720 像素。窄窗口里文字列自己收窄到视口宽，这时代码行就超出去了，也就是前面截图里被切掉的那几行。

## 防抖、快捷键和深色模式

### 防抖：一个会被重启的计时器

用户每敲一个字就搜一次，既浪费又会让结果列表闪个不停。办法是防抖（debounce）：每次按键都把一个单次计时器重新拨到 200 毫秒，计时器真到点了，才去搜。

```python
# src/sift/gui/qt/window.py, lines 243-246
        self.debounce = QTimer(self)
        self.debounce.setSingleShot(True)
        self.debounce.setInterval(DEBOUNCE_MS)
        self.debounce.timeout.connect(self.search_now)
```

```python
# src/sift/gui/qt/window.py, lines 488-498
    def _on_text_changed(self, text: str) -> None:
        """Restart the debounce timer, or go idle on an empty box."""
        self.clear_action.setVisible(bool(text))
        if text.strip():
            self.debounce.start()
        else:
            self.debounce.stop()
            self._request_id += 1  # whatever is still running is stale
            self._answered = self._request_id
            self.busy.setRange(0, 1)
            self.show_idle()
```

`QTimer.start()` 对一个正在计时的计时器就是重启，不需要先 `stop()` 再 `start()`。文本被清空时是另一条路：停掉计时器，把 `_request_id` 加 1，并把 `_answered` 追上它（这样任何还在路上的答案都被判为过期，`searching` 也立刻变回假），再回到起始页。

回车则是“现在就搜”：

```python
# src/sift/gui/qt/window.py, lines 633-639
    def _on_enter(self) -> None:
        """Search now if the text is new, else go into the preview."""
        text = self.search_edit.text().strip()
        if self.debounce.isActive() or text != self._searched:
            self.search_now()
        elif self.model.rowCount():
            self._focus_preview()
```

文字是新的、或者防抖计时器还在跑，就立刻搜；文字没变而且已经有结果，回车把焦点交给预览，以便用方向键滚动文章。测试把防抖的两面都钉住了：一个测试敲 `kalman`，断言计时器在转、模型里还没有行，等到点之后有行；另一个每隔 50 毫秒敲一个字母，把计时器的 `timeout` 换成一个记录者，断言六次按键只触发了一次搜索，内容是完整的 `kalman`（`tests/test_qt_gui.py` 第 141 到 157 行）。这个测试里的 `qtbot.wait(50)` 是一个真的事件循环，所以计时器照常转，不会出现上一节那种被轮询拖慢的情况。

### 快捷键

快捷键是三个 `QShortcut`（`Ctrl+K`、`Ctrl+O`、`Esc`），挂在主窗口上，默认的上下文是整个窗口，焦点在窗口里的哪个控件都生效：

```python
# src/sift/gui/qt/window.py, lines 439-445
        for keys, slot in (
            ("Ctrl+K", self.focus_search),
            ("Ctrl+O", self.open_current),
            ("Esc", self.clear_search),
        ):
            shortcut = QShortcut(QKeySequence(keys), self)
            shortcut.activated.connect(slot)
```

上下方向键是另一种机制。我想让焦点留在搜索框里（用户还在打字），选择却在列表里动。办法是给搜索框装一个事件过滤器，在按键事件到达输入框之前把上下键截下来：

```python
# src/sift/gui/qt/window.py, lines 609-621
    @override
    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        """Let Up and Down in the search box move the selection."""
        if (
            watched is self.search_edit
            and event.type() == QEvent.Type.KeyPress
            and isinstance(event, QKeyEvent)
            and event.key() in (Qt.Key.Key_Up, Qt.Key.Key_Down)
        ):
            step = -1 if event.key() == Qt.Key.Key_Up else 1
            self.move_selection(step)
            return True
        return super().eventFilter(watched, event)
```

过滤器返回 `True` 表示“这个事件我处理了，不要再往下传”。`Ctrl+K`、`Esc`、上下键、回车、`Ctrl+O` 各有一个测试，用的是 `qtbot.keyClick`，把按键事件真的发给窗口或搜索框，不是直接调槽。

`Ctrl+O` 是个例外，它没被完整地验证过。窗口接收一个 `opener` 参数，默认是 `open_in_desktop`（`QDesktopServices.openUrl` 加 `QUrl.fromLocalFile`），测试传进去的是 `opened.append`：断言按下 `Ctrl+O` 后收到的路径是 `kalman.md`，没选中任何行时什么也没收到。真正的 `open_in_desktop` 会在我的桌面上拉起一个应用，我没有跑它。所以我知道快捷键接到了 `open_current`、路径是对的，不知道桌面是否真的打开了文件。

### 深色模式：跟随系统，直到用户自己点过

主题的状态有三件：当前方案 `scheme`、是否被用户覆盖 `_override`、以及系统方案。窗口启动时问系统（`QGuiApplication.styleHints().colorScheme()`），系统一变（`colorSchemeChanged` 信号）就跟着变，除非用户点过切换按钮，从那一刻起这个会话里不再跟随：

```python
# src/sift/gui/qt/window.py, lines 449-466
    def set_scheme(self, scheme: Scheme, *, manual: bool = False) -> None:
        """Switch to scheme; manual stops following the system."""
        if manual:
            self._override = True
        self.scheme = scheme
        self.tokens = apply_theme(self._app(), scheme)
        self._restyle()

    def toggle_theme(self) -> None:
        """Switch light and dark for the rest of the session."""
        self.set_scheme(
            "light" if self.scheme == "dark" else "dark", manual=True
        )

    def _on_system_scheme(self, _scheme: Qt.ColorScheme) -> None:
        """Follow the desktop unless the user chose a theme."""
        if not self._override:
            self.set_scheme(self.system_scheme())
```

切换主题要重画的东西分两类。样式表和调色板由 `apply_theme` 一次装好，控件自己会重新上色；样式表够不着的是图标（`qtawesome` 的图标是按颜色画好的位图）、委托里的令牌、起始页的大图标，这些由 `window.py` 第 468 到 484 行的 `_restyle` 手动刷。

我没法在真桌面上切系统主题（这台机器上 `gsettings get org.gnome.desktop.interface color-scheme` 只回 `No schemas installed`），所以用 `QStyleHints.setColorScheme` 冒充桌面发信号，观察窗口的反应：

```text
$ qt python3 /tmp/sift-scratch/ch21/scheme.py
platform: offscreen  system colorScheme(): Dark
start (system says above)          window.scheme=dark  Window palette=#0f1117  dark QSS=True
setColorScheme(Dark)               window.scheme=dark  Window palette=#0f1117  dark QSS=True
setColorScheme(Light)              window.scheme=light Window palette=#f7f8fa  dark QSS=False
user clicks the toggle             window.scheme=dark  Window palette=#0f1117  dark QSS=True
system flips twice afterwards      window.scheme=dark  Window palette=#0f1117  dark QSS=True
```

启动时系统说“深色”，窗口就是深色，调色板的 `Window` 色是令牌里的 `#0f1117`。`setColorScheme(Light)` 之后窗口跟着变浅；点了切换按钮之后窗口变深，之后系统再来回切两次，窗口不动。它在 `offscreen` 平台上报的系统方案是深色，我没有查是从哪来的（我猜是平台主题读了我桌面的 GTK 设置，因为 Qt 在这台机器上启动时确实在读 GTK 的主题）。真桌面上的信号我没有验证。

## 测试：pytest-qt 和离屏平台

22 个测试，在 `offscreen` 平台上跑：控件是真的，布局、事件、绘制也都是真的，只是没有屏幕。`tests/conftest.py` 在任何地方导入 Qt 之前强制设平台（第 10 行，前面“环境”一节讲过为什么不是 `setdefault`）：

```text
$ grep -n "QT_QPA_PLATFORM" tests/conftest.py
10:os.environ["QT_QPA_PLATFORM"] = "offscreen"
exit 0
```

窗口夹具把“显示、等它暴露、激活”都做完才交给测试：

```python
# tests/test_qt_gui.py, lines 103-115
@pytest.fixture
def window(
    qtbot: QtBot, backend: IndexBackend, opened: list[Path]
) -> Iterator[MainWindow]:
    """Return a shown, light window on the three posts."""
    win = MainWindow(backend, scheme="light", opener=opened.append)
    qtbot.addWidget(win)
    win.show()
    qtbot.waitExposed(win)
    win.activateWindow()
    qtbot.waitActive(win)
    yield win
    win.close()
```

`qtbot.addWidget` 保证窗口在测试结束时被清理，`waitExposed` 和 `waitActive` 等到窗口真的出现、被激活。整个文件开头有 `pytest.importorskip("PySide6")` 和 `pytest.importorskip("pytestqt")`，没装 `gui` 可选依赖的机器上这个文件整个被跳过，不是失败。测试分几组：防抖和搜索（敲 `kalman` 出一行、`(rust` 出带 `^` 的横幅、`zzzzqqqq` 出“没有结果”页、过期答案被丢）、键盘（`Ctrl+K`、`Esc`、上下键、回车、`Ctrl+O`）、主题（切换后样式表和调色板都等于另一份令牌、手动覆盖后不再跟随系统）、预览（命中被标上、`mark_terms` 不分大小写且计数正确、文字列不超过 720 像素、中文查询也有标注）、委托（卡片高度、截断时命中被剪掉）和令牌。有个限制：`QTest.keyClicks` 没法一个字一个字敲汉字（那是输入法的事），所以中文查询那个测试直接 `setText`，就像输入法提交了一串文字。

跑一遍，加上最慢的三个：

```text
$ python3 -m pytest tests/test_qt_gui.py -v --durations=3 2>&1 | grep -v -e Gtk -e '^$' | sed -n '/collected/,$p'
collected 22 items
tests/test_qt_gui.py ......................                              [100%]
============================= slowest 3 durations ==============================
0.47s call     tests/test_qt_gui.py::test_every_key_restarts_the_timer
0.44s call     tests/test_qt_gui.py::test_a_syntax_error_shows_the_banner_with_a_caret
0.38s call     tests/test_qt_gui.py::test_a_stale_answer_is_dropped
============================== 22 passed in 4.76s ==============================
```

整个测试套件和检查：

```text
$ python3 -m pytest 2>&1 | tail -1
1030 passed, 1 xfailed, 1 warning in 43.45s
```

```text
$ ruff format --check --line-length 79 . | tail -1; ruff check . | tail -1; mypy | tail -1; pyright | tail -1
359 files already formatted
All checks passed!
Success: no issues found in 52 source files
0 errors, 0 warnings, 0 informations
```

另外一件在测试里没法覆盖、但同样重要的事是命令行的隔离：只有 `sift gui` 才加载 Qt，`sift --version` 和其余命令都不该付这笔进口税。

```text
$ python3 -c "import sys, sift.cli, sift.gui.qt; print('PySide6' in sys.modules, 'qtawesome' in sys.modules)"
False False
```

`False False` 是说导入 `sift.cli` 和 `sift.gui.qt` 之后，`PySide6` 和 `qtawesome` 都不在 `sys.modules` 里（`sift/gui/qt/__init__.py` 里什么都没导入）。`tests/test_cli.py` 里有三个相关的测试：`test_version_does_not_import_the_gui` 在子进程里跑 `sift --version`，断言 `tkinter`、`sv_ttk`、`darkdetect`、`PySide6`、`qtawesome` 一个都没被加载；`test_gui_without_pyside6_exits_1` 把 `PySide6` 在 `sys.modules` 里设成 `None` 来模拟没装，断言退出码 1 和那句 `pip install 'sift[gui]'`；`test_gui_qt_without_a_display_exits_1` 断言没有显示时的错误行。那个文件的 151 个测试全过。

### 没有显示器会怎样

Qt 在 Linux 上选 xcb 或 wayland 插件，两个都连不上时，它不抛异常，直接终止进程：

```text
$ env -u DISPLAY -u WAYLAND_DISPLAY -u QT_QPA_PLATFORM python3 -c 'from PySide6.QtWidgets import QApplication; QApplication([])' 2>&1 | grep -v -e Gtk -e '^$'; echo "exit ${PIPESTATUS[0]}"
exit 134
```

退出码 134 是 128 加 6，也就是被 `SIGABRT` 杀掉，终端上一个 Python 异常都没有。所以 `sift gui` 在创建 `QApplication` 之前先检查有没有显示：

```python
# src/sift/gui/qt/app.py, lines 15-28
def has_display() -> bool:
    """Return False if Qt would abort for want of a display.

    On Linux Qt picks the xcb or wayland plugin and aborts the
    process, with no exception, if neither can connect. A set
    ``QT_QPA_PLATFORM`` (offscreen, say) is trusted.
    """
    if not sys.platform.startswith("linux"):
        return True
    return bool(
        os.environ.get("QT_QPA_PLATFORM")
        or os.environ.get("DISPLAY")
        or os.environ.get("WAYLAND_DISPLAY")
    )
```

`run` 的开头就是 `if not has_display(): raise SiftError("cannot open a display: DISPLAY is not set")`（`app.py` 第 37 到 38 行）。没有显示时抛一个 `SiftError`，命令行把它变成一行错误和退出码 1，和 `--tk` 的行为一致：

```text
$ env -u DISPLAY -u WAYLAND_DISPLAY -u QT_QPA_PLATFORM sift gui; echo "exit $?"; env -u DISPLAY -u WAYLAND_DISPLAY -u QT_QPA_PLATFORM sift gui --tk; echo "exit $?"
error: cannot open a display: DISPLAY is not set
exit 1
error: cannot open a display: no display name and no $DISPLAY environment variable
exit 1
```

两条信息措辞不一样，因为第二条后半句是 Tk 自己的 `TclError` 文本（`tk_app.py` 第 423 行把它拼进 `cannot open a display:` 后面），第一条是我写的；`has_display` 对设了 `QT_QPA_PLATFORM` 的环境一律信任（离屏就是这么进来的）。

## 和 Tk 版并排放

后端完全相同，所以这是一个难得干净的对比。Qt 版不复用上一篇的 `Controller`，那是个为 Tk 写的东西：队列加 `root.after` 轮询，因为 Tk 不允许别的线程碰它。Qt 有信号，跨线程投递是它自带的，用不着队列。真正共用的只有 `IndexBackend` 和它那把锁，我给它多加了三个方法（`find`、`terms`、`document`）和一个协议 `Catalog`，让 Qt 窗口不认识具体的后端，测试里放一个带门的假后端进去就行。

```python
# src/sift/gui/controller.py, lines 109-137
class Catalog(Protocol):
    """What the Qt window asks of an index.

    ``find`` runs on a worker thread of the pool; ``terms`` and
    ``document`` run on the UI thread, once per answer and once per
    selected row. Any of them may raise SiftError.
    """

    @property
    def n_docs(self) -> int:
        """Return how many documents the index holds."""
        ...

    @property
    def logs_queries(self) -> bool:
        """Return True if ``find`` writes the query log."""
        ...

    def find(self, query: str) -> SearchResult:
        """Search; raise QuerySyntaxError for a bad query."""
        ...

    def terms(self, query: str) -> set[str]:
        """Return the analyzed positive words of a good query."""
        ...

    def document(self, doc_id: int) -> Document:
        """Return the document with this id."""
        ...
```

这一版的 `IndexBackend.find` 做的事比 Tk 那条路多一件：搜完把查询记进查询日志，状态栏才有“查询日志已记录”。我验证了它真的写：

```text
$ export SIFT_INDEX=/tmp/sift-scratch/ch21/idx-demo; sift stats | tail -1; qt python3 /tmp/sift-scratch/ch21/log_check.py; sift stats | tail -3
no queries logged
status: 5 条结果 · 73.8 ms · 查询日志已记录
   2056  pebble
last 1 queries:
2026-10-26 14:36:06 UTC      5 hits    73.786 ms  kalman filter
```

日志一开始是空的（`no queries logged`），窗口搜了一次 `kalman filter` 之后多了一行，命中数 5，耗时 73.786 毫秒，状态栏的 73.8 毫秒是同一个数。

下面这张表里的数，都是这一篇里量出来的，Tk 和 Qt 交替跑过：

| 项目 | Tk（第 20 篇） | Qt（这一篇） |
| --- | --- | --- |
| 窗口代码行数 | `tk_app.py` 425 | `qt/` 共 1833：`window.py` 664、`theme.py` 374、`delegate.py` 372、`preview.py` 184、`model.py` 122、`worker.py` 62、`app.py` 46、`__init__.py` 9 |
| 第三方包 | `sv-ttk`、`darkdetect` | `PySide6`、`qtawesome` |
| 进程启动到第一帧（含导入和开索引） | 650 到 696 毫秒 | 828 到 836 毫秒 |
| 其中导入 | 120 到 122 毫秒 | 294 到 311 毫秒 |
| 其中 `Tk()`／`QApplication` 加窗口到第一帧 | 92 到 111 毫秒 | 131 到 132 毫秒 |
| `rust 所有权`，Enter 到画好 | 461.9 毫秒 | 295.1 毫秒 |
| 20 次中位数／最坏 | 150.1／487.6 毫秒 | 170.5／313.2 毫秒 |
| 搜索本身（`rust 所有权`） | 224.8 毫秒 | 221.6 毫秒 |

第一帧那几行来自两个小脚本，每个跑三遍，一个 Qt 一个 Tk：

```text
$ python3 /tmp/sift-scratch/cpu_state.py; for i in 1 2 3; do qt python3 /tmp/sift-scratch/ch21/startup_qt.py; xvfb-run -a -s '-screen 0 1100x700x24' python3 /tmp/sift-scratch/ch21/startup_tk.py 2>&1 | grep '^Tk'; done; python3 /tmp/sift-scratch/cpu_state.py
115 113 114 114 116 ms
Qt: imports  301 ms, open index  389 ms, QApplication+window to first paint 132 ms (QElapsedTimer), process start to paint  828 ms
Tk: imports  120 ms, open index  466 ms, Tk()+window to first update  111 ms, process start to paint  696 ms
Qt: imports  311 ms, open index  381 ms, QApplication+window to first paint 131 ms (QElapsedTimer), process start to paint  829 ms
Tk: imports  122 ms, open index  436 ms, Tk()+window to first update   95 ms, process start to paint  652 ms
Qt: imports  294 ms, open index  404 ms, QApplication+window to first paint 132 ms (QElapsedTimer), process start to paint  836 ms
Tk: imports  120 ms, open index  437 ms, Tk()+window to first update   92 ms, process start to paint  650 ms
113 114 125 118 113 ms
```

Qt 比 Tk 晚 132 到 186 毫秒出第一帧，主要花在导入上：整个进程的导入 Qt 版 294 到 311 毫秒，Tk 版 120 到 122 毫秒；单看 `import PySide6.QtWidgets` 约 100 毫秒，`import qtawesome` 约 132 毫秒（前面量过）。真正建窗口、画第一帧，Qt 只比 Tk 多了二三十毫秒。

表里最容易被误读的是 Enter 到画好那两行。`rust 所有权` Qt 版快了 166 毫秒，这是因为 Tk 版把同一批正文分了两遍词（上一篇的结论），而 Qt 版的高亮是在预览里用 `find` 找的，不重新分词。可 20 次的中位数 Qt 版反而慢了 20 毫秒：另外三个查询里，`async await` 在 Qt 版要 185.0 毫秒而 Tk 版要 137.0 毫秒。我猜是预览：Tk 的预览是把文本和标签插进一个 `Text` 控件，Qt 的预览要解析 Markdown、做富文本布局，一篇长文章的 `show_post` 光是布局就要几十到一百多毫秒（前面量的最长一篇是 154.7 毫秒）。这个猜测我没有对 `async await` 的第一条结果单独验证。

所以老实说：搜索速度这件事，两个窗口一样快，因为它们跑的是同一份 Python；Enter 到画好，平局偏 Tk；启动，Tk 快 130 到 190 毫秒。Qt 买到的是别的东西。

- 自绘的卡片：圆角、悬停、选中、药丸、芯片、带圆角底的命中词，这些是我在 Tk 的 `Treeview` 里根本画不出来的东西。
- 一份令牌生成两个主题：切换时不用换主题包，也不用重建控件。
- 富文本预览：Markdown 的标题、列表、代码都有，命中词标在原有格式上。
- 字体回退、HiDPI（`QT_SCALE_FACTOR=2` 一个环境变量）和键盘快捷键都是现成的。
- 模型和视图分开，视图只画看得见的行：前面 `paint_vs_gil` 里 7 次搜索共 42 次卡片绘制，每次 6 张，而结果有 10 张。

它的价格也不小：

- 代码多了 4.3 倍（1833 行对 425 行），其中委托和主题加起来占四成（372 加 374 行）。
- 要学的规则多了一层：父子所有权、控件只能在 GUI 线程里碰、QSS 的特异性、样式表和调色板的分工。
- 一个我自己踩进去的陷阱：量时间的脚本会改变被量的东西。
- 进口税：每次 `sift gui` 多花约 180 毫秒在导入上（294 到 311 对 120 到 122）。

## 界面线程每次回答付出什么

搜索在池线程里，界面线程在这期间照常转；可答案回来之后，界面线程要建卡片、换模型、渲染预览。我用一个 4 毫秒的定时器当探针，每次搜索之后休息 400 毫秒（让上一个答案画完），记所有超过 20 毫秒的间隔：

```text
$ python3 /tmp/sift-scratch/cpu_state.py; REST=400 qt python3 /tmp/sift-scratch/ch21/gaps7.py | sed -n '/gaps over/,$p'; python3 /tmp/sift-scratch/cpu_state.py
112 112 112 115 127 ms
gaps over 20 ms (end time, length):
     317.4   80.7
    1023.5   81.3
    1719.9   76.8
    2426.1   75.2
    3132.6   76.0
    3837.3   79.9
    4530.6   71.2
ticks 581 median gap 7.2
112 113 113 113 113 ms
```

581 个 tick 里超过 20 毫秒的只有七个，每个答案一个，长度 71.2 到 81.3 毫秒；搜索那 220 毫秒里界面线程没有一次超过 20 毫秒的卡顿。按 60 赫兹算（`offscreen` 平台上报的刷新率，真屏幕不一定），每个答案大约丢 4 到 5 帧。这 75 毫秒里，`show_post` 占了 58 毫秒（前面量的），其余是建卡片、换模型和第一次画。

但 `qt_screenshot.py` 打印的“UI thread: 209 ticks of 4 ms, longest gap 260.1 ms”（前面截图那次输出里）说的是 260 毫秒，不是 80 毫秒。差别在它连着发搜索，不让上一个答案画完。上一个答案的布局和绘制被推迟到下一次事件循环里，恰好和新的搜索撞在一起，于是卡片的绘制代码要和池线程抢 GIL。我把卡片绘制的耗时按“有没有搜索在跑”分开量，同一个脚本跑了四个变体：

```text
$ python3 /tmp/sift-scratch/cpu_state.py; for v in 'REST=150' 'REST=none' 'REST=none CACHE=1' 'REST=none SWITCH=0.0005'; do echo "--- $v"; eval "$v qt python3 /tmp/sift-scratch/ch21/paint_vs_gil.py"; done; python3 /tmp/sift-scratch/cpu_state.py
112 113 113 113 112 ms
--- REST=150
paint of one card, no search running:  42 calls, median   0.68 ms, max    1.0 ms, sum     29 ms
paint of one card, search running   : none
request to rows, median of 7: 234 ms
--- REST=none
paint of one card, no search running: none
paint of one card, search running   :  36 calls, median   4.39 ms, max   44.3 ms, sum    375 ms
request to rows, median of 7: 245 ms
--- REST=none CACHE=1
paint of one card, no search running: none
paint of one card, search running   :  36 calls, median   3.82 ms, max   12.7 ms, sum    167 ms
request to rows, median of 7: 246 ms
--- REST=none SWITCH=0.0005
paint of one card, no search running: none
paint of one card, search running   :  36 calls, median   2.92 ms, max    5.3 ms, sum    111 ms
request to rows, median of 7: 246 ms
113 115 117 115 115 ms
```

没有搜索时，画一张卡片的中位数是 0.68 毫秒；和搜索重叠时变成 4.39 毫秒，最大 44.3 毫秒，36 次绘制总共 375 毫秒。这个数字很不稳，我把同一个脚本一共跑了四遍，重叠时的中位数在 4.4 到 9.8 毫秒之间，上面是最后一遍。后面两个变体动了两个旋钮：给 `snippet_for` 加缓存（同一张卡片同一个宽度只排一次版），总耗时降到 167 毫秒；把 GIL 的切换间隔从 5 毫秒缩到 0.5 毫秒，降到 111 毫秒，而搜索本身没有变慢（245 对 246 毫秒的中位数）。

我对这件事的解释是个推测。`ResultDelegate.paint` 是 Python 代码，它一路调用 Qt 的绘制函数，每次调用进出 C++ 都要放掉再重新拿 GIL；池线程里的搜索是纯 Python，抢到 GIL 之后要等 5 毫秒的切换间隔才让出来，于是绘制里每一次“重新拿 GIL”都可能等上一段。证据是缩短切换间隔后绘制总耗时降了七成（375 到 111 毫秒），缓存让它降了一多半（375 到 167 毫秒）。但我没有去数每次绘制放了多少次 GIL，所以仍然是推测。

对 `sift gui` 来说，这个影响很小：用户不会在上一个答案还没画完时就按回车（防抖要 200 毫秒），而且这个重叠只出现在“答案刚落、下一个搜索立刻开始”的瞬间。委托现在每次 `sizeHint` 和 `paint` 都重新排版摘要，缓存它是练习 3。

## 打包

我没有打包这个应用，也没打算在这一篇里做。Qt for Python 官方的工具叫 `pyside6-deploy`，它是 Nuitka 的一层包装，把 Python 代码编译成 C，再和 libpython 链接成可执行文件，默认产出一个文件夹，`--mode onefile` 则是单个文件。文档里写着从 6.12 起默认的打包模式从 `onefile` 改成了 `standalone`，当前文档默认的 Nuitka 版本是 4.1.1（<https://doc.qt.io/qtforpython-6/deployment/deployment-pyside6-deploy.html>）。有一条我觉得值得抄下来的提醒：Nuitka 会跟着 import 往下走，所以部署一个项目会执行它模块级的代码，只该部署你信任的项目，`pysidedeploy.spec` 也算项目的一部分，它决定装哪些包、给 Nuitka 传什么参数。我这台环境里装的是 PySide6 6.11.1，包里没有这个命令（`which pyside6-deploy` 找不到，包文件里也没有叫 deploy 的），所以我没有、也没法在这里验证它。

## 本篇文件

这一章动了 26 个文件，`git diff --shortstat ch20 ch21` 给出 `26 files changed, 3178 insertions(+), 31 deletions(-)`。表里的 `+N -M` 来自 `git diff --numstat ch20 ch21`，命令是跑它对应的测试或脚本，结果是我在标签 `ch21` 上最后一次实际跑出来的（计时类的脚本，表里挑的是不带计时的那一行）；`/tmp/sift-scratch/ch21/` 里的草稿脚本不进仓库，不在表里。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`Makefile`](https://github.com/bfmhno3/sift/blob/ch21/Makefile) | `grep -n QT_QPA_PLATFORM Makefile` | 退出码 0，`7:export QT_QPA_PLATFORM := offscreen`；`+4 -0` |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch21/README.md) | `grep -c 'sift gui' README.md` | 退出码 0，`7` 行提到 `sift gui`；`+12 -5` |
| [`delegate_paint.py`](https://github.com/bfmhno3/sift/blob/ch21/lab/ch21/delegate_paint.py) | `qt python3 lab/ch21/delegate_paint.py \| tail -1` | 退出码 0，`card color painted: True`；`+84 -0` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch21/lab/ch21/extra.sh) | `bash lab/ch21/extra.sh`（在 `git archive` 出来的副本里） | 退出码 0，4 个 WebP，最后一行 `out/figures/ch21-qt-error.webp: 27516 bytes`；`+42 -0` |
| [`gui_thread_violation_fail.py`](https://github.com/bfmhno3/sift/blob/ch21/lab/ch21/gui_thread_violation_fail.py) | `qt python3 lab/ch21/gui_thread_violation_fail.py` | 退出码 1（预期的失败），`cross-thread warnings: 1`；`+54 -0` |
| [`hello_qt.py`](https://github.com/bfmhno3/sift/blob/ch21/lab/ch21/hello_qt.py) | `qt python3 lab/ch21/hello_qt.py \| tail -1` | 退出码 0，`exec returned 0`；`+55 -0` |
| [`model_view.py`](https://github.com/bfmhno3/sift/blob/ch21/lab/ch21/model_view.py) | `qt python3 lab/ch21/model_view.py \| tail -1` | 退出码 0，`rows after reset: 0`；`+94 -0` |
| [`qss_tokens.py`](https://github.com/bfmhno3/sift/blob/ch21/lab/ch21/qss_tokens.py) | `python3 lab/ch21/qss_tokens.py \| grep -c "^QWidget {"` | 退出码 0，`2`（浅色、深色各一份）；`+20 -0` |
| [`qt_screenshot.py`](https://github.com/bfmhno3/sift/blob/ch21/lab/ch21/qt_screenshot.py) | `qt python3 lab/ch21/qt_screenshot.py --theme dark --out /tmp/x.png \| sed -n 2p` | 退出码 0，`query: 'rust 所有权' rows: 10`；`+166 -0` |
| [`qthread_vs_pool.py`](https://github.com/bfmhno3/sift/blob/ch21/lab/ch21/qthread_vs_pool.py) | `qt python3 lab/ch21/qthread_vs_pool.py \| tail -1` | 退出码 0，`ratio QThread / pool: 2.1x`；`+107 -0` |
| [`signals_slots.py`](https://github.com/bfmhno3/sift/blob/ch21/lab/ch21/signals_slots.py) | `qt python3 lab/ch21/signals_slots.py \| tail -1` | 退出码 0，`after disconnect: [1]`；`+99 -0` |
| [`pyproject.toml`](https://github.com/bfmhno3/sift/blob/ch21/pyproject.toml) | `python3 -c "import tomllib; ..."` 读 `gui` 可选依赖 | 退出码 0，`['sv-ttk>=2.6', 'darkdetect>=0.8', 'PySide6>=6.11', 'qtawesome>=1.4']`；`+9 -1` |
| [`cli.py`](https://github.com/bfmhno3/sift/blob/ch21/src/sift/cli.py) | `python3 -m pytest tests/test_cli.py` | 退出码 0，`151 passed in 10.08s`；`+35 -17` |
| [`controller.py`](https://github.com/bfmhno3/sift/blob/ch21/src/sift/gui/controller.py) | `python3 -m pytest tests/test_gui_controller.py` | 退出码 0，`18 passed in 0.60s`；`+85 -5` |
| [`__init__.py`](https://github.com/bfmhno3/sift/blob/ch21/src/sift/gui/qt/__init__.py) | `python3 -c "import sys, sift.gui.qt; print('PySide6' in sys.modules)"` | 退出码 0，`False`；`+9 -0` |
| [`app.py`](https://github.com/bfmhno3/sift/blob/ch21/src/sift/gui/qt/app.py) | `env -u DISPLAY -u WAYLAND_DISPLAY -u QT_QPA_PLATFORM sift gui` | 退出码 1，`error: cannot open a display: DISPLAY is not set`；`+46 -0` |
| [`delegate.py`](https://github.com/bfmhno3/sift/blob/ch21/src/sift/gui/qt/delegate.py) | `python3 -m pytest tests/test_qt_gui.py -k "as_tall or ellipsis"` | 退出码 0，`2 passed, 20 deselected in 0.82s`；`+372 -0` |
| [`model.py`](https://github.com/bfmhno3/sift/blob/ch21/src/sift/gui/qt/model.py) | `python3 -m pytest --doctest-modules src/sift/gui/qt/model.py` | 退出码 0，`1 passed in 0.62s`；`+122 -0` |
| [`preview.py`](https://github.com/bfmhno3/sift/blob/ch21/src/sift/gui/qt/preview.py) | `python3 -m pytest tests/test_qt_gui.py -k "preview or mark"` | 退出码 0，`4 passed, 18 deselected in 1.43s`；`+184 -0` |
| [`theme.py`](https://github.com/bfmhno3/sift/blob/ch21/src/sift/gui/qt/theme.py) | `python3 -m pytest tests/test_qt_gui.py -k "theme or tokens or system"` | 退出码 0，`4 passed, 18 deselected in 1.05s`；`+374 -0` |
| [`window.py`](https://github.com/bfmhno3/sift/blob/ch21/src/sift/gui/qt/window.py) | `python3 -m pytest tests/test_qt_gui.py` | 退出码 0，`22 passed in 4.70s`；`+664 -0` |
| [`worker.py`](https://github.com/bfmhno3/sift/blob/ch21/src/sift/gui/qt/worker.py) | `python3 -m pytest tests/test_qt_gui.py -k stale` | 退出码 0，`1 passed, 21 deselected in 1.19s`；`+62 -0` |
| [`conftest.py`](https://github.com/bfmhno3/sift/blob/ch21/tests/conftest.py) | `grep -n "QT_QPA_PLATFORM" tests/conftest.py` | 退出码 0，`10:os.environ["QT_QPA_PLATFORM"] = "offscreen"`；`+6 -0` |
| [`test_cli.py`](https://github.com/bfmhno3/sift/blob/ch21/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py` | 退出码 0，`151 passed in 10.08s`；`+27 -3` |
| [`test_qt_gui.py`](https://github.com/bfmhno3/sift/blob/ch21/tests/test_qt_gui.py) | `python3 -m pytest tests/test_qt_gui.py` | 退出码 0，`22 passed in 4.70s`；`+441 -0` |
| [`__init__.pyi`](https://github.com/bfmhno3/sift/blob/ch21/typings/qtawesome/__init__.pyi) | `mypy \| tail -1` | 退出码 0，`Success: no issues found in 52 source files`；`+5 -0` |

整个测试套件是 `1030 passed, 1 xfailed, 1 warning in 43.45s`，格式、静态检查和两个类型检查器的结果在上面“测试”一节。

这一章留下的几处，仓库里还没有改：

- `lab/ch21/qt_screenshot.py` 的 `wait_until` 用 `QTest.qWait` 轮询，它让搜索慢了 2 倍多：截图状态栏的 557 毫秒、脚本报的 `warm request to rows` 和 “longest gap” 都因此不是真实延迟。
- 错误横幅的 `^` 靠“汉字宽度恰好是拉丁字母的两倍”这个假设；没有宿主机的等宽中文字体时，每个汉字会让 `^` 往右偏约 2 像素。
- 预览关掉了横向滚动条，而围栏代码行不折行：在我量的 900、1200、1800 三个宽度下，第一篇文章都有一部分长代码行看不见。
- 开始了的搜索没法取消，快速输入时旧搜索白跑完，只是结果被扔掉。
- `ResultDelegate` 在每次 `sizeHint` 和 `paint` 都重新排版摘要；和搜索重叠时一张卡片的绘制比平时慢一个数量级左右。
- 浅色主题里错误红对错误底的对比度是 4.41，略低于常被引用的 4.5；我没有改。
- `Ctrl+O` 只用注入的打开函数测过；深浅色跟随系统只用 `setColorScheme` 冒充桌面测过，没有在真桌面上验证。
- 预览里 GitHub 的提示块（`> [!NOTE]`）按字面显示，围栏代码没有底色；`setMarkdown` 做的是 Qt 自己那一套。
- `run` 收的是 `argv` 加一个 `catalog`，而不是只收 `argv`：索引在 `sift gui` 里打开、关闭，窗口只借用它。`typings/qtawesome` 是我手写的一个函数的桩，`pyproject.toml` 里 `mypy_path` 加了 `typings`，pyright 的 `stubPath` 也指向它。
- 平台上我只在 `offscreen` 上画过窗口。HiDPI 靠 `QT_SCALE_FACTOR=2` 模拟，没有在真正的高分屏上看过；Qt 启动时那几行 Gtk 的 `color-mix` 警告是无害的。

## 练习

**1.** 给 `qt_screenshot.py` 的 `wait_until` 换一个真的事件循环（`QEventLoop` 加 `modelReset` 或 `failed` 的信号），先写下预测：状态栏会写多少？`UI thread: ... longest gap` 会降到多少？再重拍 `rust 所有权` 的浅色图对照。想一想为什么 `report_responsiveness` 里每次搜索之间也该加一个休息。

**2.** 把错误横幅里的 `^` 换成不依赖列数的做法：用 `QFontMetricsF.horizontalAdvance` 量 `查询[:位置]` 的像素宽度，再把 `^` 画在那个 x 上（比如一个单独的 `QLabel`，或在横幅的 `paintEvent` 里画）。在 `nohost-fonts.conf` 那种没有宿主机字体的配置下验证它真的对齐了，别只在自己的机器上看。

**3.** 在 `ResultDelegate` 里缓存 `snippet_for` 的结果（键是文档编号和卡片宽度，`set_cards` 和视口变宽时让缓存作废）。先预测 `paint_vs_gil.py` 里“搜索时绘制”的总耗时会降到多少，再对照我量的 375 到 167 毫秒。再想想：缓存以后，绘制里还有什么会和搜索抢 GIL？

**4.** 让开始了的搜索能被取消：`SearchWorker` 里放一个 `threading.Event`，`catalog.find` 的循环里检查它（需要改 `Searcher` 的接口），或者在 `search_now` 里发现旧请求还没完就先不发新的。重跑上一篇的“连发六个查询”实验，看总时间能不能回到 632 到 662 毫秒那个量级。

**5.** 在一台真桌面上验证两件事：`Ctrl+O` 真的拉起了编辑器；用 `gsettings set org.gnome.desktop.interface color-scheme prefer-dark`（或你的桌面里等价的开关）切系统主题时，窗口是否跟着变，以及点过切换按钮之后是否不再跟随。我的机器上 `gsettings` 没装这些模式，所以这两件事我都只能间接地测。

## 下一篇

下一篇是《[数据分析：numpy、pandas、matplotlib 与齐夫定律](/posts/python-by-sift-22-numpy-pandas-matplotlib/)》。这一篇的窗口把搜索做得好看了，下一篇换个方向，退一步看整个语料：词频是不是服从齐夫定律，词表随文章数怎么增长，哪几篇文章彼此最像，我想用 numpy 的矩阵运算和 pandas 的表把这些数一个一个量出来。
