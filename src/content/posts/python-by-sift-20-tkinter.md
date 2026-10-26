---
title: "GUI（上）：tkinter 与事件循环"
commentId: "post:python-by-sift-20-tkinter"
published: "2026-10-25 21:00:00 +08:00"
description: "用 Sift 重学 Python 第 20 篇：我用 Python 3.14.7 的 tkinter、Tcl/Tk 8.6.16、sv-ttk 2.6.1 和 darkdetect 0.8.0 给 Sift 做了一个浅色深色都能用的搜索窗口。处理函数睡在界面线程里，最坏的 tick 迟到 999.2 毫秒，放进工作线程是 1.1 毫秒；可真实的搜索会和界面线程抢 GIL，在 mainloop 里默认切换间隔下 tick 中位数迟到 25.1 到 46.5 毫秒，缩到 0.5 毫秒是 1.4 到 2.0 毫秒。连发六个查询，第一版要 1284 到 1323 毫秒，让过期的查询不再去跑之后是 632 到 662 毫秒。rust 所有权 从 Enter 到画好要 473.2 毫秒，搜索本身只有 230.2 毫秒，多出来的主要不是 Tk 的绘制，而是同一批正文被分了两遍词。汉字落到等宽的 Maple Mono NF CN 时所有权三个字宽 54 像素，加一条 fontconfig 别名后是 45 像素。"
category: Tutorial
tags:
  - Python
  - Sift
  - GUI
  - tkinter
  - 事件循环
series: "用 Sift 重学 Python"
seriesOrder: 20
draft: false
comment: true
slug: python-by-sift-20-tkinter
---

我想先弄清楚一个窗口“卡住”到底是什么样子，再动手写界面。所以第一个实验很小：一个按钮，点一下让处理函数睡 1 秒，同时让 `after` 每 10 毫秒排一次 tick，记下每个 tick 迟到了多久。处理函数直接睡在界面线程上，最坏的 tick 迟到了 1000 毫秒，整个脚本只记到 5 个 tick；把同样的 1 秒活儿放到工作线程里，最坏的 tick 只迟到 1.1 毫秒，记到了 105 个。这一篇从这两行数字出发：先看 tkinter 里的 Tcl 解释器和事件循环，再看线程加队列怎么把一次真实的搜索挪出界面线程，最后把 Sift 的搜索放进一个浅色深色都能用的窗口。

```text
$ xvfb-run -a -s "-screen 0 1100x700x24" python3 lab/ch20/blocking_ui_gui.py
tick every 10 ms, handler works 1 s
blocking handler  worst tick delay: about 1000 ms
  exact: worst 999.2 ms, median 0.52 ms, ticks 5
worker thread     worst tick delay: about 0 ms
  exact: worst 1.1 ms, median 0.25 ms, ticks 105
UI stalled for the whole second: True
UI kept running with a worker: True
```

> [!NOTE] Note
> 这一篇结束时仓库处于标签 `ch20`（提交 `d22e877`）。改动共 28 个文件，新增的有 `src/sift/gui/__init__.py`、`src/sift/gui/controller.py`（窗口的逻辑，不导入图形库）、`src/sift/gui/tk_app.py`（tkinter 窗口）、`tests/test_gui_controller.py`、`tests/test_tk_window.py`、`tests/tk_display/test_window.py` 和 `lab/ch20/` 下的 11 个脚本加 `extra.sh`。改写的有 `src/sift/cli.py`（多了 `sift gui [--tk]`）、`src/sift/search.py`（多了 `Searcher.highlight_terms`）、`src/sift/snippet.py`（多了 `highlight`）、`pyproject.toml`（多了 `gui` 可选依赖和给 `darkdetect` 的类型检查例外）、`flake.nix`（字体配置多了一条别名）、`README.md`，测试里改了 `tests/conftest.py`、`tests/test_cli.py`、`tests/test_search.py` 和 `tests/test_snippet.py`。
> 后面的章节里，第 21 篇让 `sift gui` 默认走 Qt，会改 `src/sift/cli.py`，给 `pyproject.toml` 的 `gui` 可选依赖加 PySide6 和 qtawesome，在 `tests/conftest.py` 里设置 `QT_QPA_PLATFORM`，并新增 `src/sift/gui/qt/`；第 22 篇给 `src/sift/cli.py` 加 `sift similar` 和 `sift report`，给 `pyproject.toml` 加 `data` 可选依赖；第 23 篇按性能分析的结果优化热点，其中点了名的有 `iter_tokens`；第 24 和 25 篇给 `sift index` 加 `--tokenizer`。
> 涉及的 Python 特性：`tkinter` 与 `_tkinter`、回调与事件循环、线程与 `queue.Queue`、`after`、`StringVar`、`match` 语句分派、`Protocol` 把界面和逻辑隔开。
> 前置：[第 19 篇](/posts/python-by-sift-19-typer-rich-uv/)。命令行已经定型，这一篇不动已有命令的行为，只加一个 `sift gui`。

## 环境

和前几篇同一台机器，仓库在标签 `ch20`，命令都在 `nix develop` 里、仓库根目录下跑。窗口一律开在 Xvfb（一块虚拟屏幕）上，用 `xvfb-run` 启动，所以不碰我自己的桌面。库的版本是 `importlib.metadata` 报的，Tcl 和 Tk 的版本是解释器自己报的：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags; git rev-parse --short HEAD
ch20
d22e877
$ lscpu | sed -n '/Model name/p;/^CPU(s):/p'
CPU(s):                                  16
Model name:                              AMD Ryzen 7 PRO 6850U with Radeon Graphics
$ xvfb-run -a python3 -c "import tkinter as tk, importlib.metadata as m; \
r = tk.Tk(); print('Tcl', r.tk.call('info', 'patchlevel'), 'Tk', \
r.tk.eval('set tk_patchLevel'), 'threaded', \
r.tk.eval('set tcl_platform(threaded)')); \
[print(n, m.version(n)) for n in ('sv-ttk', 'darkdetect')]"
Tcl 8.6.16 Tk 8.6.16 threaded 1
sv-ttk 2.6.1
darkdetect 0.8.0
$ import -version | sed -n 1p
Version: ImageMagick 7.1.2-29 Q16-HDRI x86_64 b919b37fd:20260727 https://imagemagick.org

```

Xvfb 不认 `-version`，所以 `21.1.24` 来自它在 Nix 存储里的包名 `xvfb-21.1.24`；字体的版本同样是 Nix 存储里的包名 (`inter-4.1`, `noto-fonts-cjk-sans-2.004`, `jetbrains-mono-2.304`)。

这台机器的 CPU 有快慢两个状态（第 11 篇测到过约 2.5 倍），所以以 CPU 为主的计时前后我各夹一次 `cpu_state.py`（第 12 篇贴过的固定忙循环，快状态下 5 个数在 110 到 120 毫秒）。下面夹过的读数都在 112 到 126 之间，只有最后一处（连着跑完四次窗口实验之后）收尾时漂到 131 到 146，仍然不是慢状态的 280 毫秒上下。不吃 CPU 的实验（睡 1 秒的那个）没有夹。窗口画在 Xvfb 上，没有显卡参与，真机上的绘制时间会不同，这一点后面再提。

文中引用的第三方源码都是这个环境里的版本：

- CPython `v3.14.7` 的 `Lib/tkinter/__init__.py`：环境里装的那份和标签里的用 `cmp` 比过，一字不差。`Modules/_tkinter.c` 我从标签 `v3.14.7` 下载读的，因为环境里没有 C 源码。
- Tcl 和 Tk 8.6.16：从 `tcltk/tcl` 和 `tcltk/tk` 的标签 `core-8-6-16` 下载，读的是 `generic/` 下的 `tclNotify.c`、`tclTimer.c`、`tkPack.c`、`tkGeometry.c`、`ttk/ttkWidget.c` 和 `doc/text.n`。
- `sv-ttk` 2.6.1 和 `darkdetect` 0.8.0：环境里装的那份，路径相对于 `site-packages`。`darkdetect` 里 `gsettings` 被打包时换成了 Nix 存储里的绝对路径。

仓库这一头，`make ch20` 跑 11 个脚本和 `extra.sh`（`extra.sh` 里做截图和 Enter 到画好的计时），再跑完整测试、类型检查和格式检查：

```text
$ make ch20 > /tmp/ch20_make.txt 2>&1; echo $?; \
    grep -c ^ok /tmp/ch20_make.txt
0
12
$ python3 -m pytest | tail -1
1005 passed, 1 xfailed, 1 warning in 39.73s
$ make typecheck | tail -2
Success: no issues found in 44 source files
0 errors, 0 warnings, 0 informations
$ make lint | tail -3
341 files already formatted
ruff check .
All checks passed!
```

`ok` 是 11 个 Python 脚本加 `extra.sh`；名字以 `_gui.py` 结尾的脚本要开窗口，Makefile 里的运行器会把它们放进 `xvfb-run`。那 1 个 warning 是 Starlette 的 `TestClient` 对 `httpx` 的弃用提示，第 18 篇就有。1 个 xfailed 是第 10 篇留下的行内代码那个已知缺口。

## Tk 是住在 Python 里的 Tcl 解释器

先看一个让我意外的事实：`tkinter` 几乎不是 Python 写的 GUI。`tk.Tk()` 做的是创建一个 Tcl 解释器，然后让 Tk 把窗口系统接进这个解释器里，之后每一个按钮、每一个标签都是这个解释器里的一条 Tcl 命令，名字就是它的路径。Python 这边的 `Button` 对象只是在拼字符串，发给那个解释器。

我写了一个脚本，绕过 `tkinter` 的封装，直接对着 `root.tk`（这个对象的类型叫 `tkapp`）说话：

```python
"""Talk to the Tcl interpreter that lives inside the Tk object."""

import re
import tkinter as tk
from tkinter import ttk


def main() -> None:
    """Run Tcl by hand, show widget names and callback commands."""
    root = tk.Tk()
    interp = root.tk
    print("type of root.tk:", type(interp).__name__)

    print("eval 'expr 6*7'      ->", interp.eval("expr 6*7"))
    print("call set x 5         ->", interp.call("set", "x", 5))
    print("eval 'set x'         ->", interp.eval("set x"))
    print("call info patchlevel ->", interp.call("info", "patchlevel"))
    print("windowingsystem      ->", interp.call("tk", "windowingsystem"))

    # Every widget is a Tcl command named after its path.
    frame = ttk.Frame(root)
    button = ttk.Button(frame, text="hi")
    print("str(root)  :", str(root))
    print("str(frame) :", str(frame))
    print("str(button):", str(button))
    print("Tcl sees   :", interp.eval("winfo children ."))
    print("class      :", interp.call("winfo", "class", str(button)))

    # A widget made by Tcl has no Python object until you ask for one.
    interp.eval("ttk::label .made_in_tcl -text from-tcl")
    print("children   :", sorted(root.children))
    print("Tcl children:", interp.eval("winfo children ."))

    # The button is a command: Python can call it like Tcl would.
    interp.call(str(button), "configure", "-text", "changed")
    print("cget text  :", button.cget("text"))

    # A Python callback becomes a Tcl command with a generated name.
    def callback() -> None:
        print("callback ran")

    name = root.register(callback)
    print("command name:", re.sub(r"\d+", "N", name))
    interp.eval(name)
    print("exists in Tcl:", interp.eval(f"llength [info commands {name}]"))

    # Values cross the border as strings (or Tcl objects).
    root.setvar("answer", 42)
    print("getvar     :", repr(root.getvar("answer")))
    print("tk.call int:", repr(interp.call("expr", "6*7")))
    root.destroy()


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a -s "-screen 0 1100x700x24" \
    python3 lab/ch20/tcl_interpreter_gui.py
type of root.tk: tkapp
eval 'expr 6*7'      -> 42
call set x 5         -> 5
eval 'set x'         -> 5
call info patchlevel -> 8.6.16
windowingsystem      -> x11
str(root)  : .
str(frame) : .!frame
str(button): .!frame.!button
Tcl sees   : .!frame
class      : TButton
children   : ['!frame']
Tcl children: .!frame .made_in_tcl
cget text  : changed
command name: Ncallback
callback ran
exists in Tcl: 1
getvar     : 42
tk.call int: 42
```

逐行看。`interp.eval("expr 6*7")` 把一整段 Tcl 脚本交给解释器，得到 `42`；`interp.call("set", "x", 5)` 则是已经拆好的参数列表，不经过 Tcl 的解析。两者之间的差别在引号和空格上：`eval` 要自己负责 Tcl 的转义，`call` 不用，所以 `Lib/tkinter/__init__.py` 里 `tk.call(` 出现 379 次，`tk.eval(` 一次都没有（我用 `grep -c` 数的）。`info patchlevel` 报 `8.6.16`，`tk windowingsystem` 报 `x11`，窗口系统是 Tk 在运行时问出来的。

控件名是整个设计里最有意思的一块。`str(root)` 是 `.`，`str(frame)` 是 `.!frame`，`str(button)` 是 `.!frame.!button`：这是 Tk 的路径名，点分隔，一层一层嵌套。`!frame` 这种名字是 `tkinter` 起的。`Lib/tkinter/__init__.py` 里的 `BaseWidget._setup`（第 2782 到 2812 行）取类名的小写，第一个叫 `!button`，第二个叫 `!button2`，所以两个同类控件放在同一个父控件下不会重名；如果显式传 `name=` 而且重名，旧的控件会被销毁（第 2810 到 2811 行那个 `if self._name in self.master.children`）。`winfo children .` 在 Tcl 那边看到的也是同一份：`.!frame`。

脚本里最值得停一下的是 `ttk::label .made_in_tcl`。我直接用 Tcl 造了一个控件，Python 这边的 `root.children` 里没有它 (`['!frame']`)，Tcl 那边却有 (`.!frame .made_in_tcl`)。两边各有一份账：Python 的对象只是一个句柄，真正的控件在解释器里。我猜这就是 `tkinter` 的 `destroy()` 要同时清理两边的原因，它也解释了为什么忘了把 `StringVar` 存在变量里，它被回收时标签就变空（`Variable.__del__` 会在 Tcl 里把变量 `unset`，`Lib/tkinter/__init__.py` 第 412 到 421 行）。我没有为这一条单独做实验，它是读源码得到的。

回调反过来走。`root.register(callback)` 在 Tcl 里造一条新命令，名字是 `repr(id(f))` 加函数名（`_register`，第 1718 到 1738 行；输出里我把数字换成了 `N`，因为地址每次不同），解释器执行这条命令时，由 `_tkinter.c` 里的 `PythonCmd`（第 2438 到 2480 行）把 Tcl 参数转成 Python 对象，调用你的函数，再把返回值转回 Tcl。`interp.eval(name)` 就是手动触发了一次回调，输出里的 `callback ran` 是它打的。所有的“事件处理函数”都是这个机制，没有别的。

最后两行说的是类型：`root.setvar("answer", 42)` 之后 `getvar` 得到 `42` (`int`)，`tk.call("expr", "6*7")` 得到 `42`。Tcl 的值本质上是字符串，但 `_tkinter` 在 `wantobjects` 打开时（默认）会把 Tcl 对象转回 Python 的 `int`、`str` 之类；如果关掉，你拿到的全是字符串。我只测了默认值。

## 控件、父子关系和三个几何管理器

控件造出来只是存在，要让它出现在窗口里，得告诉父控件怎么摆它。Tk 给了三个几何管理器：`pack`、`grid` 和 `place`。它们的区别我在 `hello_tk_gui.py` 里并排放了一遍，窗口开 500 毫秒后自己关：

```python
"""Open a window with a few widgets, run the main loop, close it."""

import tkinter as tk
from tkinter import ttk


def main() -> None:
    """Show pack, grid and place side by side, then close itself."""
    root = tk.Tk()
    root.title("hello tk")
    root.geometry("640x240")

    clicks = tk.IntVar(root, value=0)

    def on_click() -> None:
        clicks.set(clicks.get() + 1)

    pack_box = ttk.LabelFrame(root, text="pack", padding=8)
    pack_box.pack(side="left", fill="both", expand=True)
    ttk.Label(pack_box, text="top").pack()
    button = ttk.Button(pack_box, text="click me", command=on_click)
    button.pack(pady=4)
    ttk.Label(pack_box, textvariable=clicks).pack(side="bottom")

    grid_box = ttk.LabelFrame(root, text="grid", padding=8)
    grid_box.pack(side="left", fill="both", expand=True)
    for row in range(2):
        for col in range(2):
            ttk.Label(grid_box, text=f"{row},{col}").grid(
                row=row, column=col, padx=6, pady=6
            )

    place_box = ttk.LabelFrame(root, text="place", padding=8)
    place_box.pack(side="left", fill="both", expand=True)
    ttk.Label(place_box, text="x=0.5").place(relx=0.5, rely=0.0, anchor="n")
    ttk.Label(place_box, text="corner").place(relx=1.0, rely=1.0, anchor="se")

    # invoke() is what a click does: it runs the command.
    root.after(100, lambda: [button.invoke() for _ in range(2)])
    root.after(500, root.destroy)
    count = len(root.winfo_children())
    root.mainloop()
    print("frames in the window:", count)
    print("clicks counted by the callback:", clicks.get())
    print("mainloop returned: the window is closed")


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a -s "-screen 0 1100x700x24" python3 lab/ch20/hello_tk_gui.py
frames in the window: 3
clicks counted by the callback: 2
mainloop returned: the window is closed
```

`mainloop()` 返回了，说明窗口真的关了（关窗口、`root.destroy` 都会让最后一个主窗口消失，`mainloop` 的循环条件 `Tk_GetNumMainWindows() > threshold` 就不成立，见 `_tkinter.c` 第 2956 到 2958 行）。`button.invoke()` 的作用和点击一样：执行 `command`。两次 `invoke` 后回调数到 2，这个计数存在一个 `IntVar` 里，标签通过 `textvariable` 显示它，我没有在回调里去碰那个标签。

我另写了一个脚本，在同一块 400×200 的区域里各摆两个 100×40 的盒子，读回它们的位置：

```python
"""Measure where pack, grid and place put the same two widgets."""

import tkinter as tk


def box(master: tk.Misc, name: str, width: int, height: int) -> tk.Frame:
    """Return a Frame of a fixed size that keeps it."""
    frame = tk.Frame(master, width=width, height=height, name=name)
    frame.pack_propagate(False)
    frame.grid_propagate(False)
    return frame


def where(widget: tk.Misc) -> str:
    """Return x, y, width and height of widget as text."""
    return (
        f"x={widget.winfo_x():<4} y={widget.winfo_y():<4} "
        f"w={widget.winfo_width():<4} h={widget.winfo_height()}"
    )


def main() -> None:
    """Lay out a 400x200 area three ways and print the numbers."""
    root = tk.Tk()
    root.geometry("+0+0")

    area = box(root, "pack_area", 400, 200)
    area.pack()
    one = box(area, "one", 100, 40)
    two = box(area, "two", 100, 40)
    # expand=True shares the 160 px left over between the widgets
    # that expand: 'two' sits in the middle of them.
    one.pack(side="top", anchor="w")
    two.pack(side="top", fill="x", expand=True)
    root.update()
    print("pack top, 'two' fill=x expand=True")
    print("  one:", where(one))
    print("  two:", where(two))
    area.destroy()

    area = box(root, "grid_area", 400, 200)
    area.pack()
    one = box(area, "one", 100, 40)
    two = box(area, "two", 100, 40)
    area.columnconfigure(1, weight=1)
    one.grid(row=0, column=0)
    two.grid(row=0, column=1, sticky="ew", padx=10)
    root.update()
    print("grid, column 1 weight=1, 'two' sticky=ew padx=10")
    print("  one:", where(one))
    print("  two:", where(two))
    area.destroy()

    area = box(root, "place_area", 400, 200)
    area.pack()
    one = box(area, "one", 100, 40)
    two = box(area, "two", 100, 40)
    one.place(x=10, y=10)
    two.place(relx=1.0, rely=1.0, anchor="se", x=-10, y=-10)
    root.update()
    print("place x=10 y=10 / relx=1 rely=1 anchor=se")
    print("  one:", where(one))
    print("  two:", where(two))

    # Two managers in one master would fight for ever; Tk refuses.
    area.destroy()
    area = box(root, "mixed_area", 400, 200)
    area.pack()
    box(area, "packed", 10, 10).pack()
    try:
        box(area, "gridded", 10, 10).grid()
    except tk.TclError as error:
        print("pack and grid in one master:", error)
    root.destroy()


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a -s "-screen 0 1100x700x24" \
    python3 lab/ch20/geometry_managers_gui.py
pack top, 'two' fill=x expand=True
  one: x=0    y=0    w=100  h=40
  two: x=0    y=100  w=400  h=40
grid, column 1 weight=1, 'two' sticky=ew padx=10
  one: x=0    y=0    w=100  h=40
  two: x=110  y=0    w=280  h=40
place x=10 y=10 / relx=1 rely=1 anchor=se
  one: x=10   y=10   w=100  h=40
  two: x=290  y=150  w=100  h=40
```

`pack` 是“沿着一条边往里塞”。`one` 靠上，高 40，占掉顶部 40 像素；`two` 也靠上，剩下的空腔是 160 像素高，它自己 40 高，`expand=True` 让它拿走空腔里多出来的空间，`fill="x"` 让它横向铺满，于是它在空腔里居中，`y = 40 + (160 - 40) / 2 = 100`，宽度 400。这个算法在 `tkPack.c`：`ArrangePacking` 从第 589 行开始，纵向的扩展量由 `YExpansion`（第 982 到 1020 行）算，调用处在第 731 行。顺序很要紧：先 `pack` 的先拿空间。这是 `pack` 难调的原因，也是它短小场合好用的原因。

`grid` 是表格：行列由 `grid(row=, column=)` 定，`columnconfigure(1, weight=1)` 让第 1 列吃掉剩余宽度 (400 - 100 = 300)，`two` 贴着 `sticky="ew"` 在格子里左右撑满，再减去两侧各 10 的 `padx`，得到 `x=110, w=280`。`place` 是绝对定位：`x=10, y=10` 就是字面意思，`relx=1.0, rely=1.0, anchor="se"` 是“右下角对齐右下角”，再偏 -10，得到 `x=290, y=150`。

脚本最后一段想演示另一件事：同一个父控件里先 `pack` 一个子控件，再 `grid` 另一个，Tk 会拒绝。但上面的输出到 `two: x=290  y=150  w=100  h=40` 就结束了，那一行 `pack and grid in one master:` 根本没有出现，也就是说 Tk 没有拒绝，这个演示是失败的（脚本只在抛异常时才打印，我写的时候没有给“没抛”留输出）。差别很可能在 `box()` 上：它对每个新 Frame 都调用了 `pack_propagate(False)` 和 `grid_propagate(False)`，包括接下来要当父控件的 `area`。我把变量拆开试：

```python
"""Find out which call makes Tk accept pack and grid in one master."""

import tkinter as tk


def main() -> None:
    """Try pack then grid, with and without grid_propagate(False)."""
    root = tk.Tk()
    for call in (None, "pack_propagate", "grid_propagate"):
        master = tk.Frame(root)
        if call:
            getattr(master, call)(False)
        tk.Frame(master).pack()
        try:
            tk.Frame(master).grid()
        except tk.TclError as error:
            print(f"{call}: refused ({str(error)[:40]}...)")
        else:
            print(f"{call}: accepted")
    root.destroy()


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a python3 /tmp/sift-scratch/ch20/mixing_propagate.py
None: refused (cannot use geometry manager grid inside ...)
pack_propagate: accepted
grid_propagate: accepted
```

第一行是对照：不关传播时，Tk 拒绝混用。关掉任意一种传播，它就放行。源码能解释到这一步：拒绝的错误信息来自 `tkGeometry.c` 第 321 到 346 行的 `TkSetGeometryContainer`，而 `tkPack.c` 第 1303 到 1309 行只在 `!(containerPtr->flags & DONT_PROPAGATE)` 时才调用它，所以传播一关，这道检查就被跳过。`tkGrid.c` 第 3418 行有同样的调用，那一侧的条件我没有读，只有上面这个实验作证。再往下是我的推测，没有实验也没有源码支持：Tk 设这道检查，大概是不想让两个管理器同时通过传播去决定父控件的大小；传播关掉之后两个管理器各摆各的。结论只取能验证的那一半：拒绝是个保险丝，不是规则，不要指望它替你发现混用。仓库里这个脚本的最后一段因此是个没有输出的演示，我在文末列为遗留。

## 事件循环：mainloop 到底在转什么

`root.mainloop()` 在 `tkinter` 里只有一行：`self.tk.mainloop(n)`（`Lib/tkinter/__init__.py` 第 1623 到 1625 行）。真正的循环在 `_tkinter.c`，第 2956 行起：

它的循环条件是 `Tk_GetNumMainWindows() > threshold && !quitMainLoop && !errorInCmd`，循环体里调用 `Tcl_DoOneEvent(0)`（线程版 Tcl 的分支，`_tkinter.c` 第 2956 到 2967 行）。`0` 表示“要等就等”，整个事件循环就是不停地调用它。`Tcl_DoOneEvent` 在 `tclNotify.c` 第 844 行，我把它的骨架抄成了一张表，行号是 Tcl 8.6.16 的：

```text
while (1) {                                          tclNotify.c:887
    if (Tcl_ServiceEvent(flags)) break;              tclNotify.c:903
        # 事件队列里已有的事件: 按键, 鼠标, 窗口系统来的
    for each source: setupProc(...)                  tclNotify.c:927-932
    Tcl_WaitForEvent(timePtr)                        tclNotify.c:946
        # 睡在这里, 直到有事件或者最近的定时器到点
    for each source: checkProc(...)                  tclNotify.c:956-961
    if (Tcl_ServiceEvent(flags)) break;              tclNotify.c:967
    idleEvents:                                      tclNotify.c:978
    if (TclServiceIdle()) break;                     tclNotify.c:980
}
```

一次 `Tcl_DoOneEvent` 处理**一个**事件就返回；`mainloop` 在外面套了个 `while`。没有事件时它睡在 `Tcl_WaitForEvent`（第 946 行）里，不吃 CPU，睡多久由“最近的定时器还有多久到点”决定（这一半我是从 `TimerCheckProc` 里同样的计算推的，没有逐行读 `TimerSetupProc`）。有事件时先服务事件，其次是定时器（定时器本身也是个事件源：`tclTimer.c` 的 `TimerCheckProc`，第 458 行起，发现最早的定时器已到点，就往队列尾部塞一个事件），最后才是“空闲回调”，这个名字很要紧：只有队列里、定时器里都没东西了，空闲回调才轮到。

控件重画就是空闲回调。`ttk` 控件需要重画时调用的 `TtkRedisplayWidget`（`ttkWidget.c` 第 106 到 116 行）只做一件事：如果没有排队，就 `Tcl_DoWhenIdle(DrawWidget, corePtr)` 排一个。我只读了 `ttk` 这一份，经典的 Tk 控件 (`tk.Text`) 怎么重画我没读；不过后面的实验不依赖这个。

### 绑定、事件对象和变量

这个模型直接决定了回调长什么样。我写了一个脚本，用 `event_generate` 往一个输入框里“按键”“点击”，看回调收到什么、按什么顺序：

```python
"""Watch a StringVar, key and mouse events, and a virtual event."""

import tkinter as tk
from tkinter import ttk


def main() -> None:
    """Drive an Entry with generated events and print what arrives."""
    root = tk.Tk()
    root.geometry("320x120+0+0")
    text = tk.StringVar(root)
    entry = ttk.Entry(root, textvariable=text)
    entry.pack(padx=16, pady=16)
    log: list[str] = []

    # A variable is a Tcl variable; trace_add runs a callback when
    # it is written, whoever wrote it.
    def on_write(name: str, index: str, mode: str) -> None:
        log.append(f"trace {mode}: {text.get()!r}")

    text.trace_add("write", on_write)

    def on_key(event: tk.Event[ttk.Entry]) -> None:
        log.append(
            f"key keysym={event.keysym} char={event.char!r} "
            f"type={event.type.name}"
        )

    def on_return(event: tk.Event[ttk.Entry]) -> str:
        log.append(f"Return in {event.widget}, text={text.get()!r}")
        return "break"  # stop here: no class binding, no later tag

    def on_click(event: tk.Event[ttk.Entry]) -> None:
        log.append(f"click x={event.x} y={event.y} num={event.num}")

    def on_virtual(event: tk.Event[ttk.Entry]) -> None:
        log.append(f"virtual {event.type.name} on {event.widget}")

    entry.bind("<KeyPress>", on_key)
    entry.bind("<Return>", on_return)
    entry.bind("<Button-1>", on_click)
    # A virtual event is a name for a set of real events.
    # Tk runs only the most specific binding of a tag: <Return> is
    # bound to on_return, so <<Search>> does not fire for it.
    root.event_add("<<Search>>", "<Return>", "<Control-s>")
    entry.bind("<<Search>>", on_virtual)

    root.update()
    entry.focus_force()
    root.update()
    for char in "ab":
        entry.event_generate(f"<KeyPress-{char}>")
    entry.event_generate("<Button-1>", x=5, y=6)
    entry.event_generate("<Return>")
    entry.event_generate("<<Search>>")
    text.set("set from Python")
    entry.event_generate("<Control-s>")
    root.update()

    for line in log:
        print(line)
    print("bindtags:", entry.bindtags())
    root.destroy()


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a -s "-screen 0 1100x700x24" \
    python3 lab/ch20/variables_and_events_gui.py
key keysym=a char='a' type=KeyPress
trace write: 'a'
key keysym=b char='b' type=KeyPress
trace write: 'ab'
click x=5 y=6 num=1
Return in .!entry, text='ab'
virtual VirtualEvent on .!entry
trace write: 'set from Python'
virtual KeyPress on .!entry
bindtags: ('.!entry', 'TEntry', '.', 'all')
```

按键 `a` 的两行：先是 `key keysym=a`，然后才是 `trace write: 'a'`。我自己的绑定先跑，`Entry` 把字符真正插进去、触发变量的 `write` 跟踪是后来的事。这就是为什么在 `<KeyPress>` 回调里读 `text.get()` 永远少一个字符，经典的坑。顺序由最后一行说明：`bindtags` 是 `('.!entry', 'TEntry', '.', 'all')`，一个事件依次交给这四个“标签”上的绑定，自己的实例在最前面，`TEntry` 是 ttk 的类绑定（插入字符的就是它）。

`Return` 的回调返回了 `"break"`：输出里 `Return in .!entry, text='ab'` 之后没有别的字符被插入，也没有触发后面的标签。这个字符串不是 Tcl 的魔法，是 `tkinter` 自己包的：`_bind`（第 1514 到 1530 行）把回调包成 `if {"[funcid %# %b ...]" == "break"} break`，回调返回的字符串经过 Tcl 的命令结果传回来，等于 `break` 就中断标签链。`%#`、`%b` 这一串是 Tk 替换进来的事件字段，`tkinter` 的 `_substitute` 再把它们拼成 `Event` 对象；`event.type.name` 打印出来的 `KeyPress`、`VirtualEvent` 就是从那里来的。

虚拟事件是“一个名字对应一组真实事件”。`event_add("<<Search>>", "<Return>", "<Control-s>")` 之后，按 `Control-s` 能触发 `on_virtual`（输出的倒数第二行，`event.type` 是 `KeyPress`，因为它背后是真的按键），直接 `event_generate("<<Search>>")` 也能 (`VirtualEvent`)。但 `<Return>` 没有触发它：同一个标签上，Tk 只执行最具体的那个绑定，而 `<Return>` 已经绑给了 `on_return`。这一条我是从输出推出来的，没有去读 `bind` 的手册。

变量那一行是 `trace write: 'set from Python'`：`StringVar` 是 Tcl 变量，名字是 `PY_VAR` 加序号（`Variable.__init__`，第 373 到 396 行），`set` 和 `get` 是对 Tcl 变量的读写 (`globalsetvar`, `globalgetvar`)，`trace_add` 则用 Tcl 的 `trace add variable` 登记一条回调（第 454 到 465 行），不管是 `Entry` 的类绑定还是你自己的 `set` 写它，都会触发。`textvariable` 把控件和变量连起来，控件显示变量的当前值，所以前面 `hello_tk` 里的计数标签不用回调去碰。

### after：不是定时器，是“不早于”

最常用的另一个工具是 `after`。我把几个调用故意乱序排队：

```python
"""Show in which order after, after_idle and events are served."""

import time
import tkinter as tk


def main() -> None:
    """Schedule callbacks in a scrambled order and print the order."""
    root = tk.Tk()
    root.geometry("200x60+0+0")
    order: list[str] = []
    start = time.perf_counter()

    def note(name: str) -> None:
        """Record name and the time since the start."""
        late = (time.perf_counter() - start) * 1000
        order.append(f"{name} @{late:5.1f} ms")

    root.after(20, note, "after 20")
    root.after_idle(note, "after_idle")
    root.after(0, note, "after 0")
    root.after(5, note, "after 5")
    cancelled = root.after(10, note, "cancelled")
    root.after_cancel(cancelled)
    print(
        "Tcl knows",
        len(root.tk.splitlist(root.tk.call("after", "info"))),
        "pending callbacks",
    )
    root.after(60, root.destroy)
    root.mainloop()
    print("\n".join(order))


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a python3 /tmp/sift-scratch/ch20/after_order.py
Tcl knows 4 pending callbacks
after 0 @  0.6 ms
after_idle @  0.8 ms
after 5 @  5.1 ms
after 20 @ 20.1 ms
```

`after(ms, func)` 在 `tkinter` 里（第 871 到 897 行）把 `func` 包成一个会在执行后自己删除的回调，再对 Tcl 说 `after ms 回调名`。Tcl 那边（`tclTimer.c` 第 869 到 883 行）算出一个绝对的唤醒时刻，登记一个定时器；`after idle` (`after_idle`) 走另一条路，`Tcl_DoWhenIdle`（第 947 行）。到点的回调由 `AfterProc` 执行（第 1199 行）。所以输出里先是 `after 0`（它是定时器，已到点，事件源先于空闲回调），然后是 `after_idle`（此时队列空了），然后才是 5 毫秒和 20 毫秒的。`after_cancel` 取消的那个没有出现，“Tcl 知道 4 个待执行回调”也不含它（5 个排队，1 个取消）。

最要紧的一点藏在时间戳里：`after 5` 实际在 5.1 毫秒，`after 20` 在 20.1 毫秒。`after` 只保证“不早于”，不保证“准点”：事件循环要是正忙着执行别的东西，到点的回调只能排队等。第一个实验的 tick 就是靠这个量出阻塞的。

## 为什么界面会卡住

现在可以把开头的实验摊开了。整个脚本在这里：

```python
"""Block the UI thread for a second, then do the same on a worker."""

import statistics
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk

TICK_MS = 10
WORK_S = 1.0
ROUND_TO_MS = 100


class Ticker:
    """Schedule after(TICK_MS) over and over; record how late it ran."""

    def __init__(self, root: tk.Tk) -> None:
        """Keep root and start the first tick."""
        self.root = root
        self.late_ms: list[float] = []
        self.running = True
        self._due = time.perf_counter() + TICK_MS / 1000
        root.after(TICK_MS, self._tick)

    def _tick(self) -> None:
        """Record the delay and schedule the next tick."""
        now = time.perf_counter()
        self.late_ms.append((now - self._due) * 1000)
        if self.running:
            self._due = now + TICK_MS / 1000
            self.root.after(TICK_MS, self._tick)

    def worst(self) -> float:
        """Return the largest delay seen, in ms."""
        return max(self.late_ms)


def rounded(ms: float) -> int:
    """Round ms to the nearest ROUND_TO_MS, for stable output."""
    return round(ms / ROUND_TO_MS) * ROUND_TO_MS


def run_case(root: tk.Tk, button: ttk.Button, threaded: bool) -> Ticker:
    """Click the button, wait for the work, return the ticker."""
    done = tk.BooleanVar(root, value=False)

    def work() -> None:
        time.sleep(WORK_S)

    def on_click() -> None:
        if threaded:
            # The thread sleeps; the UI thread goes back to the loop.
            # It only sets a flag: a variable is not touched from the
            # thread, the `after` below polls a plain Python object.
            thread = threading.Thread(target=work)
            thread.start()

            def check() -> None:
                if thread.is_alive():
                    root.after(30, check)
                else:
                    done.set(True)

            root.after(30, check)
        else:
            work()  # BAD: the UI thread sleeps, nothing is redrawn
            done.set(True)

    button.configure(command=on_click)
    root.update()
    ticker = Ticker(root)
    root.after(50, button.invoke)
    root.wait_variable(done)
    root.after(100, lambda: None)
    root.update()
    ticker.running = False
    root.update()
    return ticker


def main() -> None:
    """Measure the worst tick delay with each kind of handler."""
    root = tk.Tk()
    root.geometry("200x80+0+0")
    button = ttk.Button(root, text="work")
    button.pack(padx=16, pady=16)
    root.update()
    print(f"tick every {TICK_MS} ms, handler works {WORK_S:g} s")
    results: dict[str, float] = {}
    for name, threaded in (
        ("blocking handler", False),
        ("worker thread", True),
    ):
        ticker = run_case(root, button, threaded)
        results[name] = ticker.worst()
        typical = statistics.median(ticker.late_ms)
        print(
            f"{name:<17} worst tick delay: about {rounded(ticker.worst())} ms"
        )
        # exact values differ every run: stderr, not the checked text
        print(
            f"  exact: worst {ticker.worst():.1f} ms, "
            f"median {typical:.2f} ms, ticks {len(ticker.late_ms)}",
            file=sys.stderr,
        )
    stall = results["blocking handler"]
    worker = results["worker thread"]
    print("UI stalled for the whole second:", stall > 0.9 * WORK_S * 1000)
    print("UI kept running with a worker:", worker < 0.1 * WORK_S * 1000)
    root.destroy()


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a -s "-screen 0 1100x700x24" python3 lab/ch20/blocking_ui_gui.py
tick every 10 ms, handler works 1 s
blocking handler  worst tick delay: about 1000 ms
  exact: worst 999.2 ms, median 0.52 ms, ticks 5
worker thread     worst tick delay: about 0 ms
  exact: worst 1.1 ms, median 0.25 ms, ticks 105
UI stalled for the whole second: True
UI kept running with a worker: True
```

`Ticker` 每 10 毫秒让 `after` 叫醒自己一次，记下“实际叫醒时刻减去应该叫醒的时刻”。两种处理函数的区别只有 `on_click` 里那个 `if threaded`：

- 阻塞的那条，`work()` 直接在界面线程里 `time.sleep(1.0)`。这就是 `# BAD` 的写法，它让事件循环卡在“正在执行你的回调”这一步。回调是 `PythonCmd` 从 Tcl 里调进来的（`_tkinter.c` 第 2438 到 2480 行），在它返回之前，`Tcl_DoOneEvent` 没有机会走到下一次循环，到点的定时器、鼠标、重画的空闲回调都排在后面。最坏的那个 tick 因此晚了 999.2 毫秒，整个脚本只记到 5 个 tick，那 1 秒里没有一个按时跑。
- 线程的那条，线程睡 1 秒，界面线程只登记一个每 30 毫秒检查一次 `thread.is_alive()` 的 `after`，然后回到循环里。最坏的 tick 迟了 1.1 毫秒，tick 总数 105 个。

`median` 在两种情形下几乎一样（0.52 与 0.25 毫秒），也说明“事件循环本身”很快，慢的从来不是循环，是占住循环不放的回调。

窗口在这 1 秒里应该是不重画的（重画是空闲回调，排在后面），但我没有在卡住的时候截图验证这一点，只有 tick 的数据，所以这是推论，不是观察。

这个 1 秒是我人为睡出来的。真实的 Sift 里，`rust 所有权` 一次搜索就要 230 毫秒左右，后面会量到。230 毫秒不算久，但已经是 14 帧（按 60 帧每秒算）的卡顿，足够让人觉得窗口“粘”。

## 线程和队列

线程能解决卡住，但引入一个新问题：工作线程算完了，怎么把结果交给界面？直觉是在线程里直接 `label.configure(text=...)`。我先试了最朴素的版本，在 `mainloop` 开始之前：

```python
"""Hand results from worker threads to Tk through a Queue."""

import queue
import threading
import time
import tkinter as tk
from tkinter import ttk

POLL_MS = 30


def main() -> None:
    """Start three workers; the UI thread drains the queue."""
    root = tk.Tk()
    root.geometry("320x120+0+0")
    label = ttk.Label(root, text="waiting")
    label.pack(padx=16, pady=16)
    results: queue.Queue[tuple[int, str, str]] = queue.Queue()

    # 1. A widget call from another thread, while the main loop is not
    #    running, is refused.
    def touch() -> None:
        try:
            label.configure(text="from a thread")
        except RuntimeError as error:
            results.put((-1, threading.current_thread().name, str(error)))

    probe = threading.Thread(target=touch, name="probe")
    probe.start()
    probe.join()
    _, name, message = results.get_nowait()
    print(f"widget call from {name} before mainloop: RuntimeError")
    print(f"  {message}")

    # 2. The pattern: workers put plain data, the UI thread reads it.
    def worker(number: int) -> None:
        time.sleep(0.05 * (4 - number))
        results.put((number, threading.current_thread().name, "done"))

    threads = [
        threading.Thread(target=worker, args=(n,), name=f"worker-{n}")
        for n in (1, 2, 3)
    ]
    for thread in threads:
        thread.start()

    arrived: list[str] = []
    ui_thread = threading.current_thread().name

    def poll() -> None:
        try:
            while True:
                number, name, state = results.get_nowait()
                label.configure(text=f"{name} {state}")
                arrived.append(f"{number}:{name}")
        except queue.Empty:
            pass
        if len(arrived) < 3:
            root.after(POLL_MS, poll)
        else:
            root.destroy()

    root.after(POLL_MS, poll)
    root.mainloop()
    for thread in threads:
        thread.join()
    print("polled by:", ui_thread)
    print("arrival order (slowest started first):", ", ".join(arrived))
    print("all results seen on the UI thread:", len(arrived) == 3)


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a -s "-screen 0 1100x700x24" \
    python3 lab/ch20/thread_safe_queue_gui.py
widget call from probe before mainloop: RuntimeError
  main thread is not in main loop
polled by: MainThread
arrival order (slowest started first): 3:worker-3, 2:worker-2, 1:worker-1
all results seen on the UI thread: True
```

前两行：在 `mainloop` 还没起来的时候从另一个线程碰控件，得到 `RuntimeError: main thread is not in main loop`。出处在 `_tkinter.c` 第 453 到 467 行的 `WaitForMainloop`：它每 100 毫秒看一次界面线程是不是已经在 `mainloop` 里，最多看 10 次（也就是最多等 1 秒），然后抛这个错。后面三行是我真正用的模式：三个工作线程各睡一会儿，把 `(编号, 线程名, "done")` 放进 `queue.Queue`，界面线程每 30 毫秒用 `after` 排一次 `poll`，`get_nowait` 把队列抽空，在界面线程里改标签。`polled by: MainThread` 说明所有控件操作都发生在界面线程。

这里有一个我原先没想到的事，所以又做了一个实验：**`mainloop` 起来之后，别的线程碰控件是能行的**。

```python
"""Call a widget from a thread while the main loop is running."""

import threading
import time
import tkinter as tk
from tkinter import ttk


def main() -> None:
    """Time a configure() from a worker, idle UI and busy UI."""
    root = tk.Tk()
    root.geometry("320x80+0+0")
    label = ttk.Label(root, text="start")
    label.pack(padx=16, pady=16)
    seen: dict[str, float | str] = {}

    def worker() -> None:
        """Call the widget twice and time each call."""
        for name in ("idle UI", "busy UI"):
            if name == "busy UI":
                time.sleep(0.1)  # the UI thread is asleep by then
            start = time.perf_counter()
            label.configure(text=name)  # BAD: a widget, off-thread
            seen[name] = (time.perf_counter() - start) * 1000
        seen["text"] = label.cget("text")
        root.after(0, root.destroy)

    def busy() -> None:
        """Hold the UI thread for 300 ms, like a slow handler."""
        time.sleep(0.3)

    thread = threading.Thread(target=worker, name="worker")
    root.after(100, thread.start)
    root.after(150, busy)  # still asleep when the second call comes
    root.mainloop()
    thread.join()
    for name in ("idle UI", "busy UI"):
        print(f"configure from the worker, {name}: {seen[name]:6.1f} ms")
    print("label text at the end:", seen["text"])


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a python3 /tmp/sift-scratch/ch20/thread_call_in_loop.py
configure from the worker, idle UI:    0.4 ms
configure from the worker, busy UI:  249.7 ms
label text at the end: busy UI
```

工作线程调 `label.configure` 成功了，标签最后确实变成了 `busy UI`。机制在 `_tkinter.c` 的 `Tkapp_Call`（第 1565 行起）：如果 Tcl 是线程版（`tcl_platform(threaded)` 在这台机器上是 `1`），而调用者不是创建解释器的线程，它不直接执行，而是等界面线程进了 `mainloop` (`WaitForMainloop`)，把参数打包成一个事件塞进界面线程的队列（第 1580 到 1603 行），然后**让调用者的线程睡在一个条件变量上等结果**。所以界面空闲时这次调用只要 0.4 毫秒，界面忙着睡觉时（我让界面线程从 150 毫秒起睡 300 毫秒）同一个调用要等 249.7 毫秒。

所以我不用“控件不能跨线程碰”这个说法了，它不准确。但“能碰”有一个比慢更坏的后果：互相等待。`Tkapp_ThreadSend`（`_tkinter.c` 第 824 到 835 行）把事件塞进界面线程的队列之后，调的是 `Tcl_ConditionWait(cond, mutex, NULL)`，超时参数是 `NULL`，也就是一直等。如果界面线程这时正在等这个工作线程，两边就都不会再动了。我写了最短的复现，并用 `faulthandler.dump_traceback_later` 让它 3 秒后自己倒出栈退出，免得真的挂住：

```python
"""Hang the UI thread in join() while the worker calls a widget."""

import faulthandler
import threading
import tkinter as tk
from tkinter import ttk


def main() -> None:
    """Start a worker that touches a label; wait for it. Do not."""
    faulthandler.dump_traceback_later(3, exit=True)
    root = tk.Tk()
    root.geometry("320x80+0+0")
    label = ttk.Label(root, text="start")
    label.pack(padx=16, pady=16)

    def work() -> None:
        label.configure(text="from the worker")

    def handler() -> None:
        thread = threading.Thread(target=work, name="worker")
        thread.start()
        thread.join()  # BAD: the UI thread waits for the worker
        print("joined")

    root.after(100, handler)
    root.mainloop()
    print("mainloop returned")


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a python3 /tmp/sift-scratch/ch20/join_deadlock.py; \
    echo "exit $?"
Timeout (0:00:03)!
Thread 0x00007ffff528f6c0 [worker] (most recent call first):
  File "/nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/lib/python3.14/tkinter/__init__.py", line 1847 in _configure
  File "/nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/lib/python3.14/tkinter/__init__.py", line 1863 in configure
  File "/tmp/sift-scratch/ch20/join_deadlock.py", line 18 in work

Thread 0x00007ffff7f83780 [python3.14] (most recent call first):
  File "/nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/lib/python3.14/threading.py", line 1133 in join
  File "/tmp/sift-scratch/ch20/join_deadlock.py", line 23 in handler
  File "/nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/lib/python3.14/tkinter/__init__.py", line 885 in callit
exit 1
```

输出完整有 20 行，我只留了每个线程最上面的三帧。工作线程停在 `tkinter/__init__.py` 第 1847 行的 `_configure`（那一行是 `self.tk.call`，它睡在上面说的条件变量里），界面线程停在 `threading.py` 的 `join`，`mainloop` 永远回不来，进程最后是被 `faulthandler` 以退出码 1 结束的。`# BAD` 的是 `thread.join()`。界面线程换成等 `queue.get()` 或等一把锁，只要对面的工作线程在碰控件，结果按同一个机制应该相同，但我只复现了 `join` 这一种。

所以“工作线程只往队列里放数据”我还是坚持，理由有四条：

- 慢：界面线程忙的时候，工作线程的调用要等到它回到循环，上面是 249.7 毫秒的白等。
- 挂：界面线程只要在等工作线程，上面那个互等就会发生，而且没有任何超时。
- 它依赖线程版的 Tcl 构建；非线程版靠一把全局锁（`tcl_lock`，`_tkinter.c` 第 316 到 352 行），行为不同，我只有线程版，没有测。
- 几个线程各自改控件，改的顺序是它们抢到的顺序；只有一个地方 (`poll`) 按队列顺序改，才能保证“最新的查询才算数”这类规则好写。

### 把它做进 Sift：Controller 和 View

`Controller` 在 `src/sift/gui/controller.py` 里，开头的文档字符串就是约定：搜索永远不在界面线程跑；工作线程只往队列里放消息；`poll` 是唯一把答案交给视图的代码；一次只跑一个搜索，只有最新的查询算数（排在后面等锁的旧查询不再去跑）；Sift 的错误变成状态栏里的一条消息。它不导入 `tkinter`，所以测试用假的视图和假的后端就能驱动它，不需要显示器。三个关键方法（第 229 到 292 行）：

```python
    def submit(self, text: str) -> bool:
        """Start a search for text; return False if it is blank.

        Runs on the UI thread and returns before the search is done.
        ``pending`` counts the searches whose message has not been
        read by ``poll`` yet.
        """
        query = text.strip()
        if not query:
            self.view.show_status("请输入查询", error=False)
            return False
        self._latest += 1
        ident = self._latest
        self.pending += 1
        self.view.show_busy(True)
        self.view.show_status("搜索中…", error=False)
        self._spawn(lambda: self._work(ident, query))
        return True

    def _work(self, ident: int, query: str) -> None:
        """Search and queue the answer. Runs on the worker thread.

        One search runs at a time. A request that waited for the lock
        and is no longer the newest is skipped: its answer would be
        dropped anyway, and the newest must not wait behind it.
        """
        message: Message
        with self._search_lock:
            if ident != self._latest:
                message = Skipped(ident)
            else:
                try:
                    message = Done(ident, self.backend.search(query))
                except QuerySyntaxError as error:
                    message = Failed(ident, error.render())
                except SiftError as error:
                    message = Failed(ident, f"error: {error}")
                except Exception as error:
                    # a bug must reach the status line, not die here
                    log.exception("search failed")
                    message = Failed(
                        ident, f"error: {type(error).__name__}: {error}"
                    )
        self._messages.put(message)

    def poll(self) -> int:
        """Apply every message that has arrived; return how many.

        Runs on the UI thread, from ``root.after``. An answer for a
        query that is no longer the newest is read and dropped.
        """
        count = 0
        while True:
            try:
                message = self._messages.get_nowait()
            except queue.Empty:
                break
            count += 1
            self.pending -= 1
            if message.ident == self._latest:
                self._apply(message)
        if count and self.pending == 0:
            self.view.show_busy(False)
        return count
```

`submit` 在界面线程里递增请求号、`pending` 加一、通知视图“忙”，然后把 `_work` 交给 `spawn`，立刻返回。默认的 `spawn` 是 `start_thread`（第 193 到 199 行），开一个守护线程，这样关窗口不会等一个还没算完的搜索。`_work` 在工作线程里先拿 `_search_lock`，拿到之后看自己是不是还是最新的请求：不是就发一条 `Skipped`，不搜；是就搜，把结果或者错误包进 `Done` 或 `Failed`；`QuerySyntaxError` 用它的 `render()`，也就是带插入符那一行的文字。`poll` 回到界面线程，抽空队列，只有请求号等于最新的才 `_apply`，旧的读掉扔掉。`Done`、`Failed`、`Skipped` 是冻结的数据类，`_apply` 用 `match` 分派它们；`Skipped` 属于旧请求（`_latest` 只增不减），`poll` 把它当旧答案读掉扔掉，到不了 `_apply`；`_apply` 里那一支 `case Skipped(): pass` 只是让 `match` 写全。已经开始跑的搜索没法取消，只有还在排队等锁的会被跳过。

窗口这一头的轮询只有十来行（`tk_app.py` 第 345 到 355 行）：

```python
    def _schedule_poll(self) -> None:
        """Poll the controller in POLL_MS ms, unless that is planned."""
        if self._poll_id is None:
            self._poll_id = self.root.after(POLL_MS, self._tick)

    def _tick(self) -> None:
        """Apply the answers; poll again while a search is pending."""
        self._poll_id = None
        self.controller.poll()
        if self.controller.pending:
            self._schedule_poll()
```

`submit` 之后窗口调 `_schedule_poll`；`_tick` 抽一次队列，只要还有 `pending` 就再排一次，没有了就不再排。这样空闲时一个 `after` 都没有，测试 `test_polling_stops_when_idle` 断言的就是这一点 (`window._poll_id is None`)。`IndexBackend` 里还有一把锁（`controller.py` 第 107 到 139 行）：`Searcher` 里有 LRU 缓存，不是线程安全的，所以不管谁来调，搜索都串行。

测试这头，`test_gui_controller.py` 的 18 个测试不开窗口。我挑一个最能说明设计的：

```python
def test_a_burst_runs_only_the_newest_query(view: FakeView) -> None:
    gate = threading.Event()
    entered = threading.Event()
    calls: list[str] = []

    class Slow:
        def search(self, query: str) -> Outcome:
            calls.append(query)
            entered.set()
            assert gate.wait(5)
            return outcome(query, [query])

    threads: list[threading.Thread] = []

    def spawn(work: Callable[[], None]) -> None:
        thread = threading.Thread(target=work, daemon=True)
        threads.append(thread)
        thread.start()

    controller = Controller(Slow(), view, spawn=spawn)
    controller.submit("q1")
    assert entered.wait(5)  # q1 holds the lock
    for n in range(2, 7):
        controller.submit(f"q{n}")
    assert controller.pending == 6
    gate.set()
    for thread in threads:
        thread.join(5)
        assert not thread.is_alive()
    assert controller.poll() == 6
    assert controller.pending == 0
    # q1 had started; q2 to q5 were skipped; q6 ran
    assert calls == ["q1", "q6"]
    assert [r.title for r in view.rows] == ["q6"]
    assert view.statuses[-1] == ("1 条结果，1.5 ms", False)
    assert view.busy[-1] is False
```

这个测试用真线程。`Slow.search` 在 `gate` 打开之前不返回，所以 `q1` 拿到锁后就卡在里面；这时再提交 `q2` 到 `q6`，它们都在锁上排队。放开 `gate`，六个请求都读完 (`poll() == 6`) ，但真正进后端的只有 `calls == ["q1", "q6"]`：`q1` 已经开始，没法取消，`q6` 是最新的，中间四个拿到锁时发现自己过期，发的是 `Skipped`。同一个文件里还有 `test_the_search_runs_on_another_thread`（断言搜索在名为 `sift-search` 的线程上跑）和 `test_one_search_renders_the_preview_once`，后面量绘制时用得到。

### 一连串查询

“只有最新的查询算数”这条规则，我的第一版只做到了显示那一层：`poll` 丢掉旧答案，可旧查询本身都会跑完，每个一个线程，`IndexBackend` 的锁让它们排队，最后一个要等前面所有的。我把同一个脚本在提交 `8d83c38`（`d22e877` 的上一个提交，我用 `git archive` 解出来放在 `/tmp/sift-before`）和现在的树上各跑两遍，每遍连发六个不同的查询，数后端真正执行了几次：

```python
"""Submit six different queries back to back and time the last."""

import sys
import time
import tkinter as tk
from pathlib import Path

sys.path.insert(0, "lab/ch20")

from tk_screenshot_gui import backend  # noqa: E402

import sift  # noqa: E402
from sift.gui.tk_app import HEIGHT, WIDTH, SearchWindow  # noqa: E402

QUERIES = [
    "rust 所有权",
    "kalman filter",
    '"device tree"',
    "pid AND 积分",
    "tag:Rust lifetime",
    "矩阵 OR matrix",
]


def settle(window: SearchWindow) -> None:
    """Run the main loop until every answer has been read."""
    root = window.root

    def check() -> None:
        if window.controller.pending:
            root.after(2, check)
        else:
            root.quit()

    root.after(2, check)
    root.mainloop()


def main() -> None:
    """Press Enter on six queries in a row; count the searches."""
    home = str(Path.home())
    print("sift from", sift.__file__.replace(home, "~"))
    with backend() as searching:
        ran: list[str] = []
        real_search = searching.search

        def counted(query: str):
            ran.append(query)
            return real_search(query)

        searching.search = counted  # type: ignore[method-assign]
        root = tk.Tk()
        root.geometry(f"{WIDTH}x{HEIGHT}+0+0")
        window = SearchWindow(root, searching, theme="light")
        window.query.set("warm up")
        window.submit()
        settle(window)
        for _ in range(3):
            ran.clear()
            start = time.perf_counter()
            for query in QUERIES:
                window.query.set(query)
                window.submit()
            settle(window)
            ms = (time.perf_counter() - start) * 1000
            print(
                f"last answer after {ms:4.0f} ms, "
                f"{len(ran)} searches ran, "
                f"status {window.status_text.get()!r}"
            )
        root.destroy()


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; for i in 1 2; do \
    echo '--- before (8d83c38)'; \
    PYTHONPATH=/tmp/sift-before/src xvfb-run -a -s "-screen 0 1100x700x24" \
    python3 /tmp/sift-scratch/ch20/burst.py; \
    echo '--- after (d22e877)'; \
    xvfb-run -a -s "-screen 0 1100x700x24" \
    python3 /tmp/sift-scratch/ch20/burst.py; done; \
    python3 /tmp/sift-scratch/cpu_state.py
114 115 113 114 114 ms
--- before (8d83c38)
sift from /tmp/sift-before/src/sift/__init__.py
last answer after 1323 ms, 6 searches ran, status '56 条结果，85.1 ms'
last answer after 1312 ms, 6 searches ran, status '56 条结果，83.3 ms'
last answer after 1301 ms, 6 searches ran, status '56 条结果，84.6 ms'
--- after (d22e877)
sift from ~/Projects/sift/src/sift/__init__.py
last answer after  635 ms, 2 searches ran, status '56 条结果，87.7 ms'
last answer after  662 ms, 2 searches ran, status '56 条结果，86.9 ms'
last answer after  632 ms, 2 searches ran, status '56 条结果，86.9 ms'
--- before (8d83c38)
sift from /tmp/sift-before/src/sift/__init__.py
last answer after 1284 ms, 6 searches ran, status '56 条结果，84.3 ms'
last answer after 1314 ms, 6 searches ran, status '56 条结果，85.9 ms'
last answer after 1310 ms, 6 searches ran, status '56 条结果，82.2 ms'
--- after (d22e877)
sift from ~/Projects/sift/src/sift/__init__.py
last answer after  649 ms, 2 searches ran, status '56 条结果，85.8 ms'
last answer after  660 ms, 2 searches ran, status '56 条结果，85.6 ms'
last answer after  652 ms, 2 searches ran, status '56 条结果，84.0 ms'
114 114 114 117 117 ms
```

第一版：1284 到 1323 毫秒，六个搜索全跑；现在：632 到 662 毫秒，跑两个（第一个，和最后一个）。最后显示的答案一样，都是 56 条结果。6 个查询时间约等于 6 个单独搜索的总和，这就是“按下回车的人要等多久”：快速改字、连按回车的时候，旧的版本线性变慢。

### 线程真的让界面不卡了吗

开头的 1 秒睡眠是理想化的：睡着的线程不占 CPU。真实的搜索是纯 Python 的计算，会占着 GIL。我在窗口里按下 Enter 提交 `rust 所有权`，同时让 `after(10)` 照常 tick。窗口真实的运行方式是 `mainloop`，所以脚本也在 `mainloop` 里等答案（用 `after(2, check)` 轮询，答案到了 `root.quit()`），然后交替用 5 毫秒（默认）和 0.5 毫秒的 `sys.setswitchinterval`，各 5 次：

```python
"""Watch the UI ticks while a real search runs on the worker."""

import statistics
import sys
import time
import tkinter as tk

sys.path.insert(0, "lab/ch20")

from tk_screenshot_gui import backend  # noqa: E402

from sift.gui.tk_app import HEIGHT, WIDTH, SearchWindow  # noqa: E402

TICK_MS = 10
RUNS = 5


def one_run(window: SearchWindow) -> tuple[float, int, float, float]:
    """Search once under mainloop; return ms, ticks, median, worst."""
    root = window.root
    late: list[float] = []
    due = [0.0]
    running = [True]

    def tick() -> None:
        if not running[0]:
            return
        now = time.perf_counter()
        late.append((now - due[0]) * 1000)
        due[0] = now + TICK_MS / 1000
        root.after(TICK_MS, tick)

    def check() -> None:
        if window.controller.pending or not window.tree.get_children():
            root.after(2, check)
        else:
            root.quit()

    window.tree.delete(*window.tree.get_children())
    window.query.set("rust 所有权")
    root.update()
    window.entry.focus_force()
    root.update()
    due[0] = time.perf_counter() + TICK_MS / 1000
    root.after(TICK_MS, tick)
    start = time.perf_counter()
    window.entry.event_generate("<Return>")
    root.after(2, check)
    root.mainloop()
    ms = (time.perf_counter() - start) * 1000
    running[0] = False  # the pending tick ends the chain
    return ms, len(late), statistics.median(late), max(late)


def main() -> None:
    """Search RUNS times at each switch interval, alternating."""
    with backend() as searching:
        root = tk.Tk()
        root.geometry(f"{WIDTH}x{HEIGHT}+0+0")
        window = SearchWindow(root, searching, theme="light")
        one_run(window)  # warm up
        for interval in (0.005, 0.0005) * RUNS:
            sys.setswitchinterval(interval)
            ms, ticks, median, worst = one_run(window)
            print(
                f"switch {interval * 1000:3g} ms: {ms:4.0f} ms, "
                f"{ticks:2d} ticks, tick delay median {median:5.2f} ms, "
                f"worst {worst:5.2f} ms"
            )
        root.destroy()


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    xvfb-run -a -s "-screen 0 1100x700x24" \
    python3 /tmp/sift-scratch/ch20/ticks_during_search.py; \
    python3 /tmp/sift-scratch/cpu_state.py
112 114 115 116 118 ms
switch   5 ms:  468 ms, 11 ticks, tick delay median 27.56 ms, worst 65.09 ms
switch 0.5 ms:  487 ms, 40 ticks, tick delay median  1.85 ms, worst  5.09 ms
switch   5 ms:  482 ms, 14 ticks, tick delay median 25.10 ms, worst 45.45 ms
switch 0.5 ms:  483 ms, 40 ticks, tick delay median  1.56 ms, worst  4.07 ms
switch   5 ms:  473 ms,  9 ticks, tick delay median 46.45 ms, worst 65.02 ms
switch 0.5 ms:  487 ms, 40 ticks, tick delay median  1.41 ms, worst  5.93 ms
switch   5 ms:  476 ms, 10 ticks, tick delay median 43.33 ms, worst 65.54 ms
switch 0.5 ms:  488 ms, 39 ticks, tick delay median  1.98 ms, worst  6.22 ms
switch   5 ms:  485 ms, 12 ticks, tick delay median 31.62 ms, worst 59.89 ms
switch 0.5 ms:  486 ms, 41 ticks, tick delay median  1.51 ms, worst  3.58 ms
112 115 114 116 122 ms
```

界面没有“卡住”，但差得远：默认切换间隔下，tick 的中位数迟到 25.1 到 46.5 毫秒，最坏 45.5 到 65.5 毫秒，每次 470 毫秒上下只跑了 9 到 14 个 tick，本来该有 47 个左右。把切换间隔缩到 0.5 毫秒，中位数迟到降到 1.4 到 2.0 毫秒，最坏 3.6 到 6.2 毫秒，tick 数是 39 到 41。代价是整个搜索加绘制的中位数从 476 毫秒变成 487 毫秒，慢了大约 2%。

我的解释是：工作线程在算，持有 GIL；界面线程每次要从 Tcl 回到 Python（调用你的回调、`_tkinter` 的 `ENTER_PYTHON`）都得先拿到 GIL，而拿到之前要等工作线程让出，默认每 5 毫秒才让一次。这是推测：我没有用别的方法排除别的原因，支持它的证据是缩小切换间隔之后迟到几乎成比例地消失。自由线程版的 `python3.14t` 本来可以直接验证，但那个解释器里没有 `sv-ttk`，我没有试。这一节的数字也提醒我：把搜索放到线程里是必要的，但不是充分的，界面线程和工作线程的 GIL 争用要单独量。

## ttk 和主题

Tk 的老控件 (`tk.Button`, `tk.Text`) 自己带着外观；`ttk` 把外观拆了出去：控件只管行为，外观由当前的“主题”决定，主题是一组元素 (element) 加每种控件的布局 (layout)。换主题不用改任何控件。`sv-ttk` 就是一个这样的主题包：它把 Windows 11 的 Sun Valley 外观做成了 Tcl 写的 ttk 主题，浅色深色各一套。我写了个脚本，把主题的内部翻出来看：

```python
"""List the ttk themes before and after sv-ttk, and what a theme is."""

import tkinter as tk
from tkinter import ttk

import sv_ttk


def main() -> None:
    """Print theme names, the layout of a button and style lookups."""
    root = tk.Tk()
    style = ttk.Style(root)
    print("themes at start:", sorted(style.theme_names()))
    print("current:", style.theme_use())

    sv_ttk.set_theme("light", root)
    print("themes after sv-ttk:", sorted(style.theme_names()))
    print(
        "current:", style.theme_use(), "-> sv_ttk says", sv_ttk.get_theme(root)
    )

    # A theme is a set of elements plus a layout per widget class.
    print("layout of TButton:", style.layout("TButton"))
    print("layout of Accent.TButton:", style.layout("Accent.TButton"))
    print("padding of TButton:", style.lookup("TButton", "padding"))
    print("font of TLabel:", style.lookup("TLabel", "font"))

    # A style is the same widget class with other options: here the
    # derived style "Accent.TButton" comes from the theme file.
    print(
        "has Accent.TButton:",
        "Accent.TButton" in style.element_names()
        or bool(style.layout("Accent.TButton")),
    )

    # The colors live in Tcl arrays of the theme.
    for theme in ("light", "dark"):
        array = f"::ttk::theme::sv_{theme}::colors"
        pairs = {
            key: root.tk.eval(f"set {array}(-{key})")
            for key in ("bg", "fg", "accent")
        }
        print(f"sv_{theme} colors:", pairs)

    sv_ttk.set_theme("dark", root)
    print("after set_theme('dark'):", sv_ttk.get_theme(root))
    root.destroy()


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a -s "-screen 0 1100x700x24" python3 lab/ch20/ttk_themes_gui.py
themes at start: ['alt', 'clam', 'classic', 'default']
current: default
themes after sv-ttk: ['alt', 'clam', 'classic', 'default', 'sun-valley-dark', 'sun-valley-light']
current: sun-valley-light -> sv_ttk says light
layout of TButton: [('Button.button', {'sticky': 'nswe', 'children': [('Button.padding', {'sticky': 'nswe', 'children': [('Button.label', {'expand': '1', 'sticky': 'nswe'})]})]})]
layout of Accent.TButton: [('AccentButton.button', {'sticky': 'nswe', 'children': [('AccentButton.padding', {'sticky': 'nswe', 'children': [('AccentButton.label', {'expand': '1', 'sticky': 'nswe'})]})]})]
padding of TButton: 8 2 8 3
font of TLabel: 
has Accent.TButton: True
sv_light colors: {'bg': '#fafafa', 'fg': '#1c1c1c', 'accent': '#005fb8'}
sv_dark colors: {'bg': '#1c1c1c', 'fg': '#fafafa', 'accent': '#57c8ff'}
after set_theme('dark'): dark
```

开始时有四个主题：`alt`、`clam`、`classic`、`default`，当前是 `default`。`sv_ttk.set_theme("light", root)` 之后多出 `sun-valley-dark` 和 `sun-valley-light`。`sv_ttk/__init__.py` 里这件事只有几行：`_load_theme`（第 11 到 17 行）第一次用时对解释器执行 `source sv.tcl`，`set_theme`（第 28 到 37 行）再 `style.theme_use("sun-valley-" + theme)`。`sv.tcl` 又 `source` 两个主题文件（第 3 到 4 行），几百行 `ttk::style` 在那里面。

`TButton` 的布局是一棵嵌套的元素树：`Button.button` 里面是 `Button.padding`，里面是 `Button.label`。`Accent.TButton` 是同一个控件类的另一种样式，布局里把元素换成了 `AccentButton.*`，也就是“强调色按钮”，这是搜索按钮用的样式。`TButton` 的内边距是 `8 2 8 3`（`light.tcl` 第 37 行）。

颜色在 Tcl 数组里。`light.tcl` 第 6 到 13 行：`-bg #fafafa`、`-fg #1c1c1c`、`-accent #005fb8`，深色相反，强调色是 `#57c8ff`。数组名是 `::ttk::theme::sv_light::colors`，Sift 就从这里读：不在 Python 里抄一份色值，主题怎么改，预览窗格和斑马纹就怎么跟。

`sv-ttk` 管不到的只有不属于 `ttk` 的控件：预览用的 `tk.Text` 是老控件，它的底色、选中色、命中高亮都得自己设。Sift 用 `Palette` 读主题色，再用 `mix` 在两个颜色之间插值（`tk_app.py` 第 119 到 145 行，没有贴代码）。`root.winfo_rgb` 让 Tcl 把颜色名换成 16 位的三元组，`mix` 在上面插值，`/ 257` 再换回 8 位。命中背景是背景色向强调色走 30% (`self.hit`)，斑马纹是背景色向前景色走 5%。

还有一处：`sv.tcl` 第 13 到 20 行定义了 8 个命名字体，家族是 `Segoe UI Variable static Text` 之类，这是 Windows 11 的字体，Linux 上没有。我没有再往下查它们落到了哪个家族，`SearchWindow._make_fonts`（`tk_app.py` 第 193 到 203 行）把 `TkDefaultFont`、`SunValleyBodyFont` 等六个命名字体统一改成 Inter 11。`Font.configure` 改的是 Tcl 里那个命名字体对象，按 Tk 命名字体的约定，用它的控件会跟着变，不需要逐个控件改；这一条我没有单独做实验。

## 字体与 CJK

标签、输入框、列表都用 Inter，中文呢？Inter 没有汉字。Tk 的字体是“一个家族”，遇到这个家族没有的字符，它去问系统（在 Linux 上是 fontconfig）借一个。借谁，由 fontconfig 的匹配顺序定。我写了个脚本，问 Tk 每个字符最后是谁画的：

```python
"""Check which fonts Tk finds and who draws a CJK character."""

import os
import tkinter as tk
from tkinter import font


def main() -> None:
    """Print the families, a named font and the fallback for 所."""
    root = tk.Tk()
    families = set(font.families(root))
    print("FONTCONFIG_FILE set:", "FONTCONFIG_FILE" in os.environ)
    for name in ("Inter", "Noto Sans CJK SC", "JetBrains Mono"):
        print(f"family {name!r} known to Tk:", name in families)

    # A named font is a Tcl object: change it, and every widget that
    # uses it follows.
    body = font.Font(root, name="DemoBody", family="Inter", size=11)
    print("DemoBody:", body.actual("family"), body.actual("size"))
    print("named fonts include DemoBody:", "DemoBody" in font.names(root))

    # Inter has no CJK glyphs. Tk asks fontconfig for another family
    # per missing character; `font actual ... -- CHAR` names it.
    for char in ("a", "所", "é"):
        drawn_by = root.tk.call("font", "actual", "DemoBody", "--", char)
        print(f"{char!r} is drawn with {drawn_by[1]!r}")

    cjk = font.Font(root, family="Noto Sans CJK SC", size=11)
    print("width of 所有权 in Inter  :", body.measure("所有权"))
    print("width of 所有权 in Noto CJK:", cjk.measure("所有权"))
    print(
        "same width (the fallback is the CJK font):",
        body.measure("所有权") == cjk.measure("所有权"),
    )
    root.destroy()


if __name__ == "__main__":
    main()
```

```text
$ xvfb-run -a -s "-screen 0 1100x700x24" python3 lab/ch20/fonts_cjk_gui.py
FONTCONFIG_FILE set: True
family 'Inter' known to Tk: True
family 'Noto Sans CJK SC' known to Tk: True
family 'JetBrains Mono' known to Tk: True
DemoBody: Inter 11
named fonts include DemoBody: True
'a' is drawn with 'Inter'
'所' is drawn with 'Noto Sans CJK SC'
'é' is drawn with 'Inter'
width of 所有权 in Inter  : 45
width of 所有权 in Noto CJK: 45
same width (the fallback is the CJK font): True
```

脚本里的 `font actual DemoBody -- 字符` 回答“这个字符实际用哪个家族画”：`a` 和 `é` 是 Inter，`所` 是 `Noto Sans CJK SC`。`所有权` 三个字在 Inter 字体下量出来是 45 像素，和直接用 Noto Sans CJK SC 量的一样，说明借来的确实是它。

这个结果不是白来的。我开发这个窗口时，窗口里的中文字距松得离谱。原因是我机器上有一个等宽的 CJK 字体 `Maple Mono NF CN`，fontconfig 把它排在了 Noto 前面。`flake.nix` 里的字体配置只列出了 Inter、Noto Sans CJK 和 JetBrains Mono，但 `makeFontsConf` 还会扫描宿主机的字体，宿主的字体因此进了候选（这里的 `Maple Mono NF CN` 就不在 flake 的列表里）。我造了一份没有别名的配置做对比，内容就是 `flake.nix` 生成的那份去掉 `<alias>` 一段：

```text
$ cat /tmp/sift-scratch/ch20/noalias.conf
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig><include>/nix/store/pjsqmg31sj0lp78n7r8v9nh1kk3wjnxj-fonts.conf</include></fontconfig>
```

两份配置下，字符 `所`（码位 U+6240，十六进制 `6240`）的 fontconfig 候选排序：

```text
$ fc-match -s 'Inter:charset=6240' | sed -n 1,3p
NotoSansCJK-VF.otf.ttc: "Noto Sans CJK SC" "Regular"
MapleMono-NF-CN-Regular.ttf: "Maple Mono NF CN" "Regular"
MapleMono-NF-CN-Italic.ttf: "Maple Mono NF CN" "Italic"
$ FONTCONFIG_FILE=/tmp/sift-scratch/ch20/noalias.conf \
    fc-match -s 'Inter:charset=6240' | sed -n 1,3p
MapleMono-NF-CN-Regular.ttf: "Maple Mono NF CN" "Regular"
NotoSansCJK-VF.otf.ttc: "Noto Sans CJK JP" "Regular"
MapleMono-NF-CN-Italic.ttf: "Maple Mono NF CN" "Italic"
```

不带别名，`fc-match` 的第一名是 `Maple Mono NF CN`，Noto 排第二，还变成了 `Noto Sans CJK JP`。同一个 `fonts_cjk_gui.py` 在没有别名的配置下跑：

```text
$ FONTCONFIG_FILE=/tmp/sift-scratch/ch20/noalias.conf \
    xvfb-run -a -s "-screen 0 1100x700x24" python3 lab/ch20/fonts_cjk_gui.py
FONTCONFIG_FILE set: True
family 'Inter' known to Tk: True
family 'Noto Sans CJK SC' known to Tk: True
family 'JetBrains Mono' known to Tk: True
DemoBody: Inter 11
named fonts include DemoBody: True
'a' is drawn with 'Inter'
'所' is drawn with 'Maple Mono NF CN'
'é' is drawn with 'Inter'
width of 所有权 in Inter  : 54
width of 所有权 in Noto CJK: 45
same width (the fallback is the CJK font): False
```

`所` 由 `Maple Mono NF CN` 来画，`所有权` 三个字宽 54 像素，对 45 像素。每个字 18 像素对 15 像素，差了 20%，我猜是等宽字体把汉字做成两个字符格宽，一个字符格 0.6 em，所以是 1.2 em。这就是松的来源。`flake.nix` 里那一条别名就是修它的：

```nix
          # makeFontsConf also scans the fonts of the host, and a host
          # font (a mono CJK family, say) can then win the fallback for
          # a character that Inter lacks. The alias puts Noto Sans CJK
          # SC right after Inter, so Tk (chapter 20) draws Chinese with
          # it on every machine.
          fontsConf = pkgs.writeText "sift-fonts.conf" ''
            <?xml version="1.0"?>
            <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
            <fontconfig>
              <include>${
                pkgs.makeFontsConf {
                  fontDirectories = [
                    pkgs.inter
                    pkgs.noto-fonts-cjk-sans
                    pkgs.jetbrains-mono
                  ];
                }
              }</include>
              <alias binding="same">
                <family>Inter</family>
                <accept><family>Noto Sans CJK SC</family></accept>
              </alias>
            </fontconfig>
          '';
```

`<alias binding="same">` 里 `Inter` 的 `<accept>` 列出 `Noto Sans CJK SC`，等于告诉 fontconfig：凡是要 Inter 的地方，Noto Sans CJK SC 是紧跟其后的备选。`FONTCONFIG_FILE` 由 `nix develop` 的 `shellHook` 设（第 102 行），Makefile 开头那个 `ifndef FONTCONFIG_FILE` 保证不在 Nix 外面跑。我没有读 Tk 的 X11 字体代码 (`tkUnixRFont.c`) 去确认它是怎么问 fontconfig 的，“Tk 向 fontconfig 借字”是从 `font actual` 的结果加上 `FONTCONFIG_FILE` 改变了结果这两件事推的。

## 深色模式检测

窗口一打开，要决定用浅色还是深色。`darkdetect` 是做这件事的小库，在 Linux 上它的全部逻辑是 `_linux_detect.py` 第 9 到 29 行这 21 行（我没有贴，里面 `gsettings` 被打包时换成了 Nix 存储的绝对路径）。

它用 `subprocess` 跑 `gsettings get org.gnome.desktop.interface color-scheme`，输出里只要带 `-dark`（`prefer-dark` 就带）就是 `Dark`，其他一律 `Light`。输出为空的时候，退回去问旧的 `gtk-theme`。我给它喂几种 `gsettings` 可能的回答，看它怎么判断：

```python
"""Feed darkdetect the answers gsettings can give."""

import subprocess
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import darkdetect

ANSWERS = [b"'prefer-dark'\n", b"'default'\n", b"'prefer-light'\n", b""]


def fake_run(answer: bytes, asked: list[str]) -> Callable[..., Any]:
    """Return a subprocess.run that answers and notes the key."""

    def run(command: list[str], **kwargs: Any) -> SimpleNamespace:
        asked.append(command[-1])
        return SimpleNamespace(stdout=answer)

    return run


def main() -> None:
    """Replace subprocess.run and print what theme() decides."""
    real_run = subprocess.run
    for answer in ANSWERS:
        asked: list[str] = []
        subprocess.run = fake_run(answer, asked)
        try:
            result = darkdetect.theme()
        finally:
            subprocess.run = real_run
        print(f"gsettings says {answer!r:<20} -> {result:<5} {asked}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/ch20/darkdetect_answers.py
gsettings says b"'prefer-dark'\n"   -> Dark  ['color-scheme']
gsettings says b"'default'\n"       -> Light ['color-scheme']
gsettings says b"'prefer-light'\n"  -> Light ['color-scheme']
gsettings says b''                  -> Light ['color-scheme', 'gtk-theme']
```

`prefer-dark` 是 `Dark`；`default`、`prefer-light` 是 `Light`；空回答是 `Light`，并且问了两次，第二次问的是 `gtk-theme`。我这台机器是 niri（Wayland 合成器），没有装 GNOME 的 `gsettings` 模式，所以 `gsettings` 本身就出错了：

```text
$ gsettings get org.gnome.desktop.interface color-scheme
No schemas installed
exit 1
```

然后 `darkdetect` 回 `Light`，不管我的桌面实际是亮是暗。Sift 的包装在 `tk_app.py` 第 63 到 72 行：

```python
def detect_theme() -> Theme:
    """Return the theme of the desktop, "light" if it cannot tell.

    darkdetect asks the desktop (gsettings on Linux). Under Xvfb, in
    a container or without gsettings it answers "Light" or None.
    """
    name = str(darkdetect.theme())
    if name.lower() == "dark":
        return "dark"
    return "light"
```

它的验证脚本：

```python
"""Ask the desktop for light or dark and show what Sift picks."""

import os
import shutil

import darkdetect

from sift.gui.tk_app import detect_theme


def main() -> None:
    """Print what darkdetect sees on this machine."""
    print("darkdetect.theme():", darkdetect.theme())
    print("darkdetect.isDark():", darkdetect.isDark())
    print("detect_theme():", detect_theme())
    print("gsettings found:", shutil.which("gsettings") is not None)
    print("DISPLAY set:", "DISPLAY" in os.environ)
    print("XDG_CURRENT_DESKTOP:", os.environ.get("XDG_CURRENT_DESKTOP"))


if __name__ == "__main__":
    main()
```

```text
$ python3 lab/ch20/dark_mode_gui.py
darkdetect.theme(): Light
darkdetect.isDark(): False
detect_theme(): light
gsettings found: True
DISPLAY set: True
XDG_CURRENT_DESKTOP: niri
```

`detect_theme()` 把 `darkdetect.theme()` 的结果（`Light` 或 `Dark`，按 `detect_theme` 的文档字符串也可能是 `None`）归一到 `"light"` 或 `"dark"`，认不出就当浅色。在 Xvfb 下跑同一个脚本结果也是 `Light`；我在 Xvfb 下和用 `env -u DISPLAY` 去掉显示各跑了一次，只有 `DISPLAY set:` 一行不同（`True` 和 `False`），其余一样，只贴一份。所以我没有办法在这台机器上看到“检测到深色”的真实路径，只能看到上面伪造回答的那一组；`prefer-dark` 一路通到 `Dark`，这条链在我的机器上没有端到端地跑过。窗口的右上角另有一个按钮，可以手动在浅色和深色之间切，两张截图靠 `--theme` 参数直接指定，没有走检测。

`darkdetect` 只在启动时问一次。它其实有个 `listener`（`_linux_detect.py` 第 38 到 45 行，起一个 `gsettings monitor` 子进程），可以跟随系统切换。但要留意它监听的是 `gtk-theme`（第 40 行），而 `theme()` 先读的是 `color-scheme`（第 13 行）：只改 `color-scheme` 的桌面，`listener` 不会收到通知，两者可能不一致。这一点我没有测，这台机器没有 GNOME 的 `gsettings` 模式，我是读源码得到的。Sift 没有用它：监听要一个线程，回调又要回到界面线程，我留给练习。

## 把它们拼成一个窗口

材料齐了：一个不卡的控制器，一个 ttk 窗口，一套主题，一套字体。窗口是个 1100×700 的网格，16 像素边距。窗口是 `SearchWindow._build`（`tk_app.py` 第 208 行起）搭的，我只贴最值得看的预览那一块，其余在仓库里。

`_build` 里 `columnconfigure(..., weight=)` 和 `rowconfigure` 是 `grid` 的拉伸系数：根窗口的 0 行 0 列权重都是 1，所以主框架随窗口缩放；主框架里两列的权重是 2 比 3，`uniform="panes"` 让两列的比例严格按权重而不是内容。顶栏一行：输入框随宽度拉伸，搜索按钮用 `Accent.TButton`，右边是主题切换按钮，三个控件用 `padx=(PAD, 0)` 隔开。

右边的预览是个只读的 `tk.Text`：

```python
        # ...
        line = self.body_font.metrics("linespace")
        self.preview = tk.Text(
            right,
            wrap="word",
            state="disabled",
            font=self.body_font,
            spacing1=line // 2,
            spacing2=line // 2,
            padx=PAD,
            pady=PAD,
            borderwidth=0,
            insertwidth=0,
            highlightthickness=1,
            cursor="arrow",
            width=10,
            height=10,
        )
        self.preview.grid(row=0, column=0, sticky="nsew")
        text_bar = ttk.Scrollbar(right, command=scroll_command(self.preview))
        text_bar.grid(row=0, column=1, sticky="ns")
        self.preview.configure(yscrollcommand=text_bar.set)
        # ...
```

`state="disabled"` 让它只读，所以每次改内容前要先切回 `normal`，改完再切回去（`show_preview`，第 398 到 409 行）。行距有两个选项，我都设成行高的一半：`spacing2` 管“一行文字折行以后，显示出来的各行之间”，`spacing1` 管每一行（用 `\n` 分开的行）上方，折行时只算第一段显示行（`text.n` 第 63 到 73 行）。只设 `spacing2` 的时候，用 `\n` 分开的行贴得很紧，我是在第一版的截图里看到的，后来加了 `spacing1`。

命中高亮是 `Text` 的 `tag`。`show_preview` 先插标题和元信息，再按 `Preview.parts()` 拆出的 `(文本, 是否命中)` 逐段插入，命中的段带上 `hit` 标签，标签的背景色在 `_style` 里设（第 303 行）。偏移是 `IndexBackend.search` 在工作线程里算的：先用 `Searcher.highlight_terms` 取查询里正面词的索引项（分析过的词），再用 `snippet.highlight` 把整篇正文分词一遍，把落在这些词里的每个词元的 `(start, end)` 放进 `Preview.spans`，`Preview.parts()` 再按它们把正文切开。这两个是 `Searcher` 和 `snippet` 新加的公开函数，各有测试：`test_highlight_terms_follow_the_positive_words`、`test_highlight_keeps_the_whole_text_and_line_breaks`、`test_highlight_maps_offsets_after_nfkc`、`test_highlight_without_hits`。

命令行这头是 `sift gui`（`cli.py` 第 667 到 702 行）：

```python
@app.command("gui", help="Open the search window.")
def run_gui(
    tk: Annotated[
        bool,
        typer.Option(
            "--tk",
            help="Use the tkinter window (the only one until chapter 21).",
        ),
    ] = False,
) -> None:
    """Open the search window on the index and run it until it closes.

    Raise IndexMissingError (exit 4) if there is no index and
    SiftError (exit 1) if there is no display, the Python has no
    tkinter or the gui extra is not installed. ``--tk`` is the
    default and the only toolkit for now.
    """
    from sift.config import load_config

    config = load_config()
    directory = index_dir(config)
    require_index(directory)
    try:
        from sift.gui.controller import IndexBackend
        from sift.gui.tk_app import run
    except ModuleNotFoundError as error:
        if error.name in ("tkinter", "_tkinter"):
            raise SiftError(
                "sift gui needs tkinter, and this Python was built without it"
            ) from None
        raise SiftError(
            f"sift gui needs the gui extra ({error.name} is missing): "
            "pip install 'sift[gui]'"
        ) from None
    with searching(directory, config) as searcher:
        run(IndexBackend(searcher, config.limit))
```

懒导入放在函数里：`import sift.gui` 本来就什么都不导入，`sift --version` 也不碰 `tkinter`；只有真的运行 `sift gui` 才去找 `sv_ttk` 和 `tkinter`，找不到就退出码 1 并给出提示。几种失败我各跑了一遍：

```text
$ export SIFT_INDEX=/tmp/ch20-idx
$ sift gui; echo "exit $?"
sift: no index at /tmp/ch20-idx, run 'sift index' first
exit 4
$ sift index --corpus corpus/posts | tail -1
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 3441.0 ms
$ env -u DISPLAY sift gui; echo "exit $?"
error: cannot open a display: no display name and no $DISPLAY environment variable
exit 1
$ python3 -c 'import sys; sys.modules["sv_ttk"] = None; \
    sys.argv = ["sift", "gui"]; \
    from sift.cli import main; main()'; echo "exit $?"
error: sift gui needs the gui extra (sv_ttk is missing): pip install 'sift[gui]'
exit 1
$ python3 -c 'import sys; sys.argv = ["sift", "--version"]; \
    from sift.cli import main; main(); \
    print("tkinter imported:", "tkinter" in sys.modules)'
sift 0.1.0
tkinter imported: False
```

按顺序：没有索引，退出码 4，窗口压根没开；`env -u DISPLAY` 去掉显示，退出码 1，提示 `cannot open a display`（这一句是 `tk_app.run` 把 `tk.Tk()` 的 `TclError` 包成 `SiftError`，同时它还吞掉了 `_tkinter` 自己打印到 stderr 的 `Tk_Init error`，免得同一件事说两遍）；用 `sys.modules["sv_ttk"] = None` 模拟没装 `gui` 可选依赖，退出码 1，提示 `pip install 'sift[gui]'`；最后一条证明 `--version` 之后 `tkinter` 没有被导入。

测试分三层。`tests/test_gui_controller.py` 的 18 个，不开窗口，不要显示器。`tests/tk_display/test_window.py` 的 11 个要开窗口，`tests/conftest.py` 让普通的 `pytest` 跳过这个目录（`collect_ignore_glob`，设了环境变量 `SIFT_TK_DISPLAY_TESTS` 才收集），免得在开发者的桌面上弹窗；`tests/test_tk_window.py` 的 1 个测试负责在 `xvfb-run` 里启动一个子 `pytest` 去跑那个目录。没有 `xvfb-run` 时它跳过：

```text
$ PATH=<the PATH without xvfb-run> \
    python3 -m pytest tests/test_tk_window.py -rs
=========================== short test summary info ============================
SKIPPED [1] tests/test_tk_window.py:28: xvfb-run is not installed
============================== 1 skipped in 0.60s ==============================
```

加上 `test_cli.py` 里 5 个（没有索引、没有显示、没有 `gui` 可选依赖、没有 `tkinter`、`--version` 不导入图形库），整个套件是 1005 个通过，1 个预期失败。

### 窗口长什么样

两张截图是 `make ch20` 里 `extra.sh` 在 1100×700 的 Xvfb 屏幕上用 ImageMagick 的 `import -window root` 截的，查询是 `rust 所有权`，每张 150 KB 左右（上限是 400 KB）。我把两张都打开看了。浅色：

![浅色的 Sift 搜索窗口：顶栏是输入框（内容 rust 所有权）、蓝色的“搜索”按钮和白底的“深色模式”按钮；左边是一个三列的表格，列头是排名、分数、标题，共 10 行，行底色深浅交替，标题在列边缘被截断；右边是预览，标题“第一个 crate：从 cargo new 到 Span”，下面一行灰色的日期和标签，正文里 Rust、所有 Rust 等词带着浅蓝色的底，行距均匀；底部状态栏写着“10 条结果，228.0 ms”](/assets/images/python-by-sift/ch20-tk-light.png)

深色：

![深色的 Sift 搜索窗口：布局和浅色完全一样，底色是近黑的深灰，“搜索”按钮是浅蓝色，切换按钮写着“浅色模式”，预览里命中的词带着深青蓝色的底，状态栏写着“10 条结果，229.5 ms”](/assets/images/python-by-sift/ch20-tk-dark.png)

我看到的：汉字都是字形，没有方框；表格有三列，10 行的底色深浅交替，第一行是选中态；预览的命中词有淡色底，浅色和深色各有各的底色，都看得清；输入框下面有一条强调色的线，我猜是焦点标记；右上角按钮的文字是对方模式的名字（浅色里写“深色模式”，深色里写“浅色模式”）。预览现在每一行之间的间距都一样，包括用 `\n` 分开的两条 `$ cargo run` 命令和它们的输出 `6765`，这是加上 `spacing1` 之后的样子。

也有几处不对劲，我如实记下。标题那一列的内容在列右缘被直接截断 (“Spa”“AST”)，没有省略号，也没有横向滚动条。预览里标题“第一个 crate：从 cargo new 到 Span”只比正文大一点点，我看不出加粗，字距也比正文松；代码里 `SiftTitle` 要的是 15 号 Inter 粗体，我只验证过 Tk 为“第”选了 `Noto Sans CJK SC`、量出的宽度和直接量一致，没有追查为什么看起来不粗。预览窗格的底部，最后一行 `[!NOTE] 本篇检查点` 只露出上半截，被窗格边缘切掉了，这对一个滚动区域是正常的，右边滚动条的滑块在最上面。高亮的方式也要说明：`所有权` 在索引里是 `所有`、`有权` 两个二元组，预览里“所有 Rust 知识”的“所有”也被标了，因为高亮是按词元，不是按查询短语；这是第 8 篇记下的已知局限。

## 一次搜索花在哪

我拿这个窗口量了从按下 Enter 到行画好的时间。`enter_to_paint.py` 对四个查询各重复 5 次，每次清空表格、填入查询、给输入框发一个 `<Return>`，一直转事件循环直到表格里有行，再做最后一轮 `update` 把它画出来（脚本在 `lab/ch20/enter_to_paint.py`，它里面测一次的 `one_round` 和下面 `paint_breakdown.py` 里的是同一段）：

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    xvfb-run -a -s "-screen 0 1100x700x24" python3 lab/ch20/enter_to_paint.py; \
    python3 /tmp/sift-scratch/cpu_state.py
110 116 119 120 120 ms
query               search   Enter to painted
rust 所有权           230.2 ms          473.2 ms
kalman filter       74.5 ms          168.4 ms
async await         57.4 ms          129.0 ms
设备树 device          11.1 ms           45.9 ms
median over 20 runs: 143.7 ms, worst 502.4 ms
110 111 112 112 112 ms
```

`search` 一栏是状态栏里显示的那个数（`Searcher.search` 自己量的 `took_ms`），`Enter to painted` 是我从按键量到画好。`rust 所有权` 查询要 230.2 毫秒，画好却要 473.2 毫秒，多出一倍多；四个查询无一例外，画好的时间都比搜索多。20 次的中位数 143.7 毫秒，最坏 502.4 毫秒。这个中位数每次不太一样：`make ch20` 里那一次是 145.2 毫秒，最坏 484.5。

多出来的那部分是“画”吗？我的第一个猜想确实是：Tk 往 `Treeview` 里插 10 行，往 `Text` 里插一篇正文再打标签，那应该不便宜。我把这条路径拆成五段，每一段打时间戳：搜索本身 (`took_ms`)、工作线程里搜索之后的事（`previews`，也就是 `IndexBackend.search` 里为每个命中建预览）、工作线程放进队列到 `poll` 来取的间隔 (`wait`)、`poll` 里调视图的时间 (`apply`)、`poll` 结束到最后一轮 `update` 返回的时间 (`draw`)：

```python
"""Split Enter-to-painted into the steps between key and pixels."""

import statistics
import sys
import time
import tkinter as tk

sys.path.insert(0, "lab/ch20")

from tk_screenshot_gui import backend  # noqa: E402

from sift.gui.tk_app import HEIGHT, WIDTH, SearchWindow  # noqa: E402

QUERIES = ["rust 所有权", "kalman filter", "async await", "设备树 device"]
ROUNDS = 5
STEPS = ("search", "previews", "wait", "apply", "draw", "total")


def now_ms() -> float:
    """Return a clock in ms."""
    return time.perf_counter() * 1000


def one_round(window: SearchWindow, query: str, marks: dict[str, float]):
    """Press Enter on query and return the steps, in ms."""
    root = window.root
    window.tree.delete(*window.tree.get_children())
    window.query.set(query)
    root.update()
    window.entry.focus_force()
    root.update()
    marks["enter"] = now_ms()
    window.entry.event_generate("<Return>")
    while window.controller.pending or not window.tree.get_children():
        root.update()
        time.sleep(0.001)
    root.update_idletasks()
    root.update()
    marks["painted"] = now_ms()
    return {
        "search": marks["took"],
        "previews": marks["worker"] - marks["enter"] - marks["took"],
        "wait": marks["poll"] - marks["worker"],
        "apply": marks["applied"] - marks["poll"],
        "draw": marks["painted"] - marks["applied"],
        "total": marks["painted"] - marks["enter"],
    }


def main() -> None:
    """Print the median of each step for each query."""
    marks: dict[str, float] = {}
    with backend() as searching:
        real_search = searching.search

        def search(query: str):
            outcome = real_search(query)
            marks["worker"] = now_ms()
            marks["took"] = outcome.took_ms
            return outcome

        searching.search = search  # type: ignore[method-assign]
        root = tk.Tk()
        root.geometry(f"{WIDTH}x{HEIGHT}+0+0")
        window = SearchWindow(root, searching, theme="light")
        poll = window.controller.poll

        def timed_poll() -> int:
            begin = now_ms()
            count = poll()
            if count:
                marks["poll"], marks["applied"] = begin, now_ms()
            return count

        window.controller.poll = timed_poll  # type: ignore[method-assign]
        root.update()
        one_round(window, "warm up", marks)
        head = " ".join(f"{step:>8}" for step in STEPS)
        print(f"{'query':<14} {head}   (ms, median of {ROUNDS})")
        for query in QUERIES:
            rounds = [one_round(window, query, marks) for _ in range(ROUNDS)]
            cells = " ".join(
                f"{statistics.median(r[s] for r in rounds):8.1f}"
                for s in STEPS
            )
            print(f"{query:<14} {cells}")
        root.destroy()


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    xvfb-run -a -s "-screen 0 1100x700x24" \
    python3 /tmp/sift-scratch/ch20/paint_breakdown.py; \
    python3 /tmp/sift-scratch/cpu_state.py
116 115 115 119 129 ms
query            search previews     wait    apply     draw    total   (ms, median of 5)
rust 所有权          231.2    225.3     30.4      2.0      6.6    494.8
kalman filter      74.4     72.0     18.7      1.5      5.9    174.5
async await        56.5     55.3     10.5      2.3      6.6    131.8
设备树 device         12.9     10.1     12.6      1.3      6.1     43.2
112 112 113 116 115 ms
```

猜错了。`apply` 加 `draw` 一共只有 7 到 9 毫秒（`rust 所有权` 是 2.0 加 6.6），`wait` 是 10 到 30 毫秒，落在“每 30 毫秒轮询一次”的一个周期之内（我不知道为什么 `rust 所有权` 的中位数偏到 30.4，没有追）。吃掉时间的是 `previews`：225.3 毫秒，几乎和搜索本身（231.2 毫秒）一样长。

这张表里 `draw` 比第一版低（我最初量到的是 6 到 8 毫秒），原因之一在 `Controller.select`：`_apply` 先自己选中第 0 行并画预览，再让窗口选中这一行，窗口回报“选中变了”，控制器又被叫了一次，同一个预览在第一版里画了两遍（我在一个临时版本里数到 `show_preview` 两次）。现在 `select` 记下“预览现在显示的是哪一次结果的哪一行”，没变就不画（`test_one_search_renders_the_preview_once` 断言的就是这个）。这个“一次”我只在假视图上用单元测试验证了，没有在真窗口里重新数。

为什么预览要这么久？`IndexBackend.search` 在搜索之后，对每个命中取正文，调 `snippet.highlight`，它得把整篇正文分一遍词才知道哪些词元命中。而 `Searcher.search` 为了做摘要，已经对这十篇正文分过一遍词了（`search.py` 第 187 到 198 行，`make_snippet(doc.body, terms)` 在 `took_ms` 之内）。我把这几段单独量了，看是不是同样的活做了两遍：

```python
"""Time the pieces of a search that the window waits for."""

import statistics
import sys
import time
from collections.abc import Callable
from typing import Any

sys.path.insert(0, "lab/ch20")

from tk_screenshot_gui import backend  # noqa: E402

from sift.analysis import iter_tokens  # noqa: E402
from sift.snippet import highlight  # noqa: E402

QUERIES = ["rust 所有权", "kalman filter", "async await", "设备树 device"]
ROUNDS = 5


def median_ms(function: Callable[..., Any], *args: Any) -> float:
    """Return the median time of function(*args) in ms."""
    times = []
    for _ in range(ROUNDS):
        start = time.perf_counter()
        function(*args)
        times.append((time.perf_counter() - start) * 1000)
    return statistics.median(times)


def highlight_all(bodies: list[str], terms: set[str]) -> None:
    """Highlight every body, as the preview of each row does."""
    for body in bodies:
        highlight(body, terms)


def tokenize_all(bodies: list[str]) -> None:
    """Only tokenize every body."""
    for body in bodies:
        list(iter_tokens(body))


def main() -> None:
    """Print search, highlight and bare tokenizing times per query."""
    with backend() as searching_backend:
        searcher = searching_backend.searcher
        documents = searcher.index.documents
        searcher.search("warm up", 10)
        print(
            f"{'query':<14} {'search':>8} {'terms':>7} "
            f"{'highlight x10':>14} {'tokenize x10':>13}  chars"
        )
        for query in QUERIES:
            hits = searcher.search(query, 10).hits
            bodies = [documents[hit.doc_id].body for hit in hits]
            terms = searcher.highlight_terms(query)
            print(
                f"{query:<14} "
                f"{median_ms(searcher.search, query, 10):8.1f} "
                f"{median_ms(searcher.highlight_terms, query):7.2f} "
                f"{median_ms(highlight_all, bodies, terms):14.1f} "
                f"{median_ms(tokenize_all, bodies):13.1f}  "
                f"{sum(map(len, bodies))}"
            )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    python3 /tmp/sift-scratch/ch20/where_time_goes.py; \
    python3 /tmp/sift-scratch/cpu_state.py
113 113 114 116 114 ms
query            search   terms  highlight x10  tokenize x10  chars
rust 所有权          232.5    0.01          233.4         173.5  687378
kalman filter      72.5    0.01           71.5          46.7  221081
async await        55.4    0.01           55.5          36.7  155358
设备树 device         10.2    0.01            9.7           6.5  19511
119 116 118 117 121 ms
```

`highlight x10` 就是对十篇正文各调一次 `highlight`；`tokenize x10` 只是 `list(iter_tokens(body))`，什么都不比较。两件事互相印证：`highlight` 十篇的时间几乎等于 `Searcher.search` 的时间（233.4 对 232.5，71.5 对 72.5，55.5 对 55.4，9.7 对 10.2），因为它们做的是同一件重活；而纯分词就占了 `highlight` 的 65% 到 74%（173.5 对 233.4，46.7 对 71.5，36.7 对 55.5，6.5 对 9.7）。`rust 所有权` 的十个命中加起来有 687,378 个字符，`highlight` 平均每个字符 0.34 微秒，分词本身占 0.25 微秒。`terms` 一栏证明 `highlight_terms` 不是问题：0.01 毫秒，它走的是 `Searcher` 的词缓存。

所以结论是：窗口里的“多出来的一倍”，主要是同一批正文被分词了两遍，窗口的绘制只占 7 到 9 毫秒。有两点要说清楚。一，Xvfb 没有显卡参与，真机上绘制多半会更慢一点；我在真桌面上没有量，所以“绘制只占 7 到 9 毫秒”只对这块虚拟屏幕成立。二，状态栏里的 `X ms` 是 `Searcher.search` 里面量的，不包含预览，用户等的其实是它的 2 到 4 倍（上面四个查询的比值是 2.1、2.3、2.2 和 4.1）；这是这一篇留下的一个仓库问题（文末列出），修法不复杂，要么把分词结果在摘要和高亮之间共享，要么把时间量在 `IndexBackend.search` 外面。

回头看，这一篇开头的 1 秒睡眠是编的，而真实的 230 毫秒就摆在那里。线程让窗口能动，但没让搜索变快；GIL 的争用又让“能动”打了折扣。下一步该做什么，要看分词能不能变快，这是第 23 篇性能分析的事。

## 本篇文件

这一章动了 28 个文件，`git diff --shortstat ch19 ch20` 给出 `28 files changed, 2265 insertions(+), 13 deletions(-)`。表里的 `+N -M` 来自 `git diff --numstat ch19 ch20`，命令是跑它对应的测试或脚本，结果是我在标签 `ch20` 上最后一次实际跑出来的；`/tmp/sift-scratch/ch20/` 里的草稿脚本不进仓库，不在表里。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch20/README.md) | `grep -c 'sift gui' README.md` | 退出码 0，`3` 行提到 `sift gui`；`+11 -1` |
| [`flake.nix`](https://github.com/bfmhno3/sift/blob/ch20/flake.nix) | `grep -c '<alias binding' "$FONTCONFIG_FILE"` | 退出码 0，`1`；`+25 -9` |
| [`blocking_ui_gui.py`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/blocking_ui_gui.py) | `xvfb-run -a python3 lab/ch20/blocking_ui_gui.py \| tail -1` | 退出码 0，`UI kept running with a worker: True`；`+115 -0` |
| [`dark_mode_gui.py`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/dark_mode_gui.py) | `python3 lab/ch20/dark_mode_gui.py \| sed -n 3p` | 退出码 0，`detect_theme(): light`；`+22 -0` |
| [`enter_to_paint.py`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/enter_to_paint.py) | `xvfb-run -a ... python3 lab/ch20/enter_to_paint.py \| sed -n 1p` | 退出码 0，表头 `query               search   Enter to painted`；`+66 -0` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/extra.sh) | `make ch20 > /tmp/ch20_make.txt 2>&1` | 退出码 0，最后一行 `ok   lab/ch20/extra.sh`；`+49 -0` |
| [`fonts_cjk_gui.py`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/fonts_cjk_gui.py) | `xvfb-run -a python3 lab/ch20/fonts_cjk_gui.py \| tail -1` | 退出码 0，`same width (the fallback is the CJK font): True`；`+39 -0` |
| [`geometry_managers_gui.py`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/geometry_managers_gui.py) | `xvfb-run -a python3 lab/ch20/geometry_managers_gui.py \| tail -1` | 退出码 0，`  two: x=290  y=150  w=100  h=40`；`+78 -0` |
| [`hello_tk_gui.py`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/hello_tk_gui.py) | `xvfb-run -a python3 lab/ch20/hello_tk_gui.py \| tail -1` | 退出码 0，`mainloop returned: the window is closed`；`+49 -0` |
| [`tcl_interpreter_gui.py`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/tcl_interpreter_gui.py) | `xvfb-run -a python3 lab/ch20/tcl_interpreter_gui.py \| tail -1` | 退出码 0，`tk.call int: 42`；`+55 -0` |
| [`thread_safe_queue_gui.py`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/thread_safe_queue_gui.py) | `xvfb-run -a python3 lab/ch20/thread_safe_queue_gui.py \| tail -1` | 退出码 0，`all results seen on the UI thread: True`；`+73 -0` |
| [`tk_screenshot_gui.py`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/tk_screenshot_gui.py) | `xvfb-run -a -s "-screen 0 1100x700x24" python3 lab/ch20/tk_screenshot_gui.py --theme dark --out /tmp/x.png` | 退出码 0，`rows: 10`；`+93 -0` |
| [`ttk_themes_gui.py`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/ttk_themes_gui.py) | `xvfb-run -a python3 lab/ch20/ttk_themes_gui.py \| tail -1` | 退出码 0，`after set_theme('dark'): dark`；`+51 -0` |
| [`variables_and_events_gui.py`](https://github.com/bfmhno3/sift/blob/ch20/lab/ch20/variables_and_events_gui.py) | `xvfb-run -a python3 lab/ch20/variables_and_events_gui.py \| tail -1` | 退出码 0，`bindtags: ('.!entry', 'TEntry', '.', 'all')`；`+67 -0` |
| [`pyproject.toml`](https://github.com/bfmhno3/sift/blob/ch20/pyproject.toml) | `python3 -c "import tomllib; ..."` 读 `gui` 可选依赖 | 退出码 0，`['sv-ttk>=2.6', 'darkdetect>=0.8']`；`+11 -0` |
| [`cli.py`](https://github.com/bfmhno3/sift/blob/ch20/src/sift/cli.py) | `python3 -m pytest tests/test_cli.py` | 退出码 0，`149 passed in 10.41s`；`+40 -1` |
| [`__init__.py`](https://github.com/bfmhno3/sift/blob/ch20/src/sift/gui/__init__.py) | `python3 -c "import sys, sift.gui; print('tkinter' in sys.modules)"` | 退出码 0，`False`；`+7 -0` |
| [`controller.py`](https://github.com/bfmhno3/sift/blob/ch20/src/sift/gui/controller.py) | `python3 -m pytest tests/test_gui_controller.py` | 退出码 0，`18 passed in 0.66s`；`+332 -0` |
| [`tk_app.py`](https://github.com/bfmhno3/sift/blob/ch20/src/sift/gui/tk_app.py) | `python3 -m pytest tests/test_tk_window.py` | 退出码 0，`1 passed in 6.19s`；`+425 -0` |
| [`search.py`](https://github.com/bfmhno3/sift/blob/ch20/src/sift/search.py) | `python3 -m pytest tests/test_search.py` | 退出码 0，`19 passed in 0.68s`；`+10 -0` |
| [`snippet.py`](https://github.com/bfmhno3/sift/blob/ch20/src/sift/snippet.py) | `python3 -m pytest tests/test_snippet.py` | 退出码 0，`22 passed in 0.61s`；`+19 -0` |
| [`conftest.py`](https://github.com/bfmhno3/sift/blob/ch20/tests/conftest.py) | `python3 -m pytest --collect-only -q tests/tk_display` | 退出码 0，`no tests collected in 0.58s`；`+7 -0` |
| [`test_cli.py`](https://github.com/bfmhno3/sift/blob/ch20/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py` | 退出码 0，`149 passed in 10.41s`；`+61 -1` |
| [`test_gui_controller.py`](https://github.com/bfmhno3/sift/blob/ch20/tests/test_gui_controller.py) | `python3 -m pytest tests/test_gui_controller.py` | 退出码 0，`18 passed in 0.66s`；`+327 -0` |
| [`test_search.py`](https://github.com/bfmhno3/sift/blob/ch20/tests/test_search.py) | `python3 -m pytest tests/test_search.py` | 退出码 0，`19 passed in 0.68s`；`+9 -0` |
| [`test_snippet.py`](https://github.com/bfmhno3/sift/blob/ch20/tests/test_snippet.py) | `python3 -m pytest tests/test_snippet.py` | 退出码 0，`22 passed in 0.61s`；`+25 -1` |
| [`test_tk_window.py`](https://github.com/bfmhno3/sift/blob/ch20/tests/test_tk_window.py) | `python3 -m pytest tests/test_tk_window.py` | 退出码 0，`1 passed in 6.19s`；`+53 -0` |
| [`test_window.py`](https://github.com/bfmhno3/sift/blob/ch20/tests/tk_display/test_window.py) | `SIFT_TK_DISPLAY_TESTS=1 xvfb-run -a ... python3 -m pytest tests/tk_display` | 退出码 0，`11 passed in 1.37s`；`+146 -0` |

整个测试套件是 `1005 passed, 1 xfailed, 1 warning in 39.73s`，类型检查和格式检查的结果在正文开头。计时类的数每次都不一样，表里挑的是不带计时的那一行或我最后一次跑出的值。

这一章留下的几处，仓库里还没有改：

- `lab/ch20/geometry_managers_gui.py` 的最后一段在 `box()` 关掉了传播，Tk 因此不再拒绝混用 `pack` 和 `grid`，脚本只在抛异常时打印，所以那一段什么都没输出。
- 同一批命中的正文在 `make_snippet` 和 `highlight` 里各被分词一遍；状态栏的 `X ms` 只含前一遍，用户实际等的是它的 2 到 4 倍。
- 结果表的标题列在列边缘直接截断，没有省略号，也没有横向滚动条。
- 工作线程搜索时，界面线程的 tick 在默认的 5 毫秒 GIL 切换间隔下中位数迟到 25 到 46 毫秒；缩短切换间隔能改善，要付出大约 2% 的总时间，我没有把它放进 `sift gui`。
- 开始了的搜索没法取消，连按回车时最多有一个旧搜索白跑完。
- 深色检测只在启动时问一次，只认 GNOME 的 `gsettings`；窗口不会跟随系统切换。
- 字体靠 `flake.nix` 里的别名固定；不在 Nix 里运行时，汉字由用户机器上的 fontconfig 决定，我没有处理。

## 练习

**1.** 让 `Searcher.search` 把每个命中的词元表留下来（比如放进 `Hit`，或者由 `make_snippet` 返回），`IndexBackend.search` 用它们直接算高亮，不再对正文分词。先写下预测：`rust 所有权` 的 `previews` 会降到多少？再重跑 `paint_breakdown.py` 对照。

**2.** 把 `after(30)` 轮询换成事件：工作线程把消息放进队列之后调用 `root.event_generate("<<SearchDone>>", when="tail")`，界面线程绑定这个虚拟事件去抽队列。`paint_breakdown.py` 里的 `wait` 一栏会怎么变？这是对“工作线程不碰控件”的一个有意的例外，`event_generate` 也是一次跨线程的控件调用，要付出上面说的代价：界面线程忙时它要等（我量到 249.7 毫秒），界面线程在等这个工作线程时它会永远挂住。所以界面线程里不要 `join`，也不要在锁里等它。我在 `after_order.py` 的早期版本里试过在 `mainloop` 之前生成一个自己的虚拟事件，回调没有运行，我没有追查原因，动手前先用小实验确认你的版本能送达。

**3.** 用 `darkdetect.listener` 让窗口跟随系统的深浅色实时切换。它的回调在 `listener` 所在的线程里运行，那个线程又在 `gsettings monitor` 的输出上阻塞着；先想清楚它放在哪个线程、靠什么交给界面线程。注意它只监听 `gtk-theme`，而 `theme()` 先读 `color-scheme`，所以验证要在真正有 GNOME 设置的桌面上用 `gsettings set org.gnome.desktop.interface color-scheme prefer-dark` 和改 `gtk-theme` 各试一次，看两者会不会不一致。我的机器上没有这些模式，检测永远是 `Light`，只能像 `darkdetect_answers.py` 那样伪造 `gsettings` 的回答。

## 下一篇

下一篇是《[GUI（下）：用 PySide6 做一个好看的桌面客户端](/posts/python-by-sift-21-pyside6/)》。同样的搜索，换成 Qt 来画，我想看一套设计令牌和自绘的结果卡片能把这个窗口做成什么样。
