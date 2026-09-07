---
title: "我不想再盲贴正则表达式了: 从语法到 Scoop、Python、CMake、C++ 和 TypeScript"
commentId: "post:regular-expressions-from-syntax-to-automation"
published: "2026-09-07 20:00:00 +08:00"
description: "我从一份包含 4 个版本号的发布页开始，逐步写出可解释、可移植、可测试的正则表达式，再把同一套方法放进 Scoop checkver、Python、CMake、C++ 和 JavaScript/TypeScript。"
category: Tutorial
tags:
  - Regular Expression
  - Scoop
  - Python
  - C++
  - CMake
  - TypeScript
draft: false
comment: true
slug: regular-expressions-from-syntax-to-automation
---

我在日常开发里早就离不开正则表达式了。Scoop 要从非 GitHub 发布页抓版本，Python 脚本要清洗日志，CMake 要从第三方库的 Header 中读版本，TypeScript 又要验证构建产物名称。可我过去的工作流基本是把样本文本扔给 AI，复制一串像线路噪声的字符，再运行一次看看输出对不对。只验证一个成功样本，相当于拿一把只试过一把锁的钥匙去管理整栋楼，多少有点勇。

所以我给自己造了一个很小的正则实验室。我准备了一份同时包含构建日期、预览版、稳定版和依赖版本的文本，再准备 12 个发布物文件名，其中 6 个应该接受，6 个必须拒绝。然后我把同一个问题分别放进 Python、Scoop、CMake、C++ 和 TypeScript，实际运行它们，看看哪些知识可以搬过去，哪些反斜杠会在途中离奇失踪。

## 正则表达式到底是什么

正则表达式不是一段会执行的业务代码，而是一种描述**字符串集合**的小语言。模式 `cat` 描述所有包含连续字符 `cat` 的文本；模式 `^cat$` 则只描述完整等于 `cat` 的文本。

我现在会把一次匹配拆成 4 个对象：

1. **目标文本**：发布页、文件名、日志或源码。
2. **模式**：哪些字符可以出现，以什么顺序出现。
3. **操作**：搜索一处、搜索全部、验证全文、提取分组或替换。
4. **方言和宿主字符串**：Python `re`、JavaScript `RegExp`、C++ ECMAScript、CMake Regex 和 .NET Regex 并不是同一个引擎，模式还可能先经过 Python、JSON 或 CMake 的字符串解析。

最后一项解释了大量 "明明在线网站能匹配，放进项目就坏了"。很多时候正则本身没错，错的是我拿法语词典去查西班牙语，或者字符串解析器先吃掉了一层反斜杠。

大多数本文涉及的引擎会从某个位置出发，沿着模式尝试字符，失败时再换分支或回退。我们可以把它想成一个在迷宫里移动的指针：普通字符是直路，`|` 是岔路，量词是可以重复走的环，回溯则是从死路退回来。这个比喻到这里就够了；真正重要的是，每增加一个含糊分支，引擎可能就多一条要探索的路。

## 先只学 6 组积木

我不再从一张塞满符号的速查表开始。绝大多数日常模式都由下面 6 组积木拼出来。

### 1. 字面字符和转义

普通字符通常匹配自己：

```text
release     -> 匹配 release
v2          -> 匹配 v2
x64         -> 匹配 x64
```

这些字符通常有特殊意义：

```text
. ^ $ * + ? { } [ ] ( ) | \
```

要匹配字面上的点，写 `\.`，因为裸的 `.` 通常表示 "除换行外的任意单个字符"：

```text
2.7.3       -> 既能匹配 2.7.3，也可能匹配 2x7y3
2\.7\.3     -> 只把两个位置当作字面点号
```

这不是美学差异。版本号里的点不转义，模式就比我想象的更宽。

### 2. 字符类

方括号表示 "从这一组字符中取一个"：

| 模式 | 含义 | 示例 |
| --- | --- | --- |
| `[abc]` | `a`、`b`、`c` 中任意一个 | `cat` 中的 `c` |
| `[a-z]` | ASCII 小写字母范围 | `release` |
| `[0-9]` | 一个 ASCII 数字 | `7` |
| `[^0-9]` | 一个非 ASCII 数字字符 | `v` |
| `[._-]` | 点、下划线或连字符之一 | `2.7-rc` |

很多引擎还提供快捷形式：

- `\d`：数字字符。
- `\w`：所谓的 word character。
- `\s`：空白字符。
- 大写版本 `\D`、`\W`、`\S` 表示相反集合。

但快捷形式的 Unicode 语义会随方言变化。Python 3 的 `\d` 默认可以匹配 Unicode 十进制数字，JavaScript 的 `\d` 仍然只匹配 ASCII `0-9`；CMake 的文档则没有定义 `\d` 这套快捷类。版本号、端口、哈希这类协议字段只允许 ASCII 时，我直接写 `[0-9]`。它长了 3 个字符，却少了一个跨语言猜谜游戏。

> [!NOTE]
> 字符类只消费一个字符。`[abc]+` 才是一个或多个；`[abc]` 也不表示字符串 `abc`。方括号是候选集合，圆括号才组合一段模式。

### 3. 量词

量词控制它前面的一个字符、字符类或分组重复多少次：

| 量词 | 次数 | 例子 |
| --- | --- | --- |
| `*` | 0 次或更多 | `ab*` 匹配 `a`、`ab`、`abbb` |
| `+` | 1 次或更多 | `[0-9]+` 匹配一串数字 |
| `?` | 0 次或 1 次 | `v?2` 匹配 `2` 或 `v2` |
| `{3}` | 恰好 3 次 | `[0-9]{3}` |
| `{2,4}` | 2 到 4 次 | `[a-f0-9]{2,4}` |
| `{2,}` | 至少 2 次 | `[0-9]{2,}` |

量词默认通常是**贪婪**的，它会先吃尽可能多的字符，再在后续匹配失败时回退：

```text
输入: <a>one</a><b>two</b>
模式: <.*>
结果: <a>one</a><b>two</b>
```

给量词加 `?` 会变成懒惰版本：

```text
模式: <.*?>
第一处结果: <a>
```

不过，用 `<.*?>` 解析 HTML 仍然不是好主意。引号、注释、嵌套标签和脚本内容很快就会把问题升级。能用 HTML Parser 取得节点时，我不会逼正则假装自己是一棵 DOM 树。

### 4. 锚点和边界

锚点不消费字符，它只断言当前位置：

| 模式 | 常见含义 |
| --- | --- |
| `^` | 字符串开头；多行模式下也可能是每行开头 |
| `$` | 字符串结尾；多行模式下也可能是每行结尾 |
| `\b` | 单词边界 |
| `\B` | 非单词边界 |

假设我要验证发布物名称：

```text
tool-v2.7.3-windows-x64.zip
```

不加锚点的模式可能在下面这个校验和文件名内部找到一段成功匹配：

```text
tool-v2.7.3-windows-x64.zip.sha256
```

如果我的问题是 "字符串里有没有一个发布物名称"，内部匹配没问题。如果问题是 "整个文件名是否合法"，就要用完整匹配 API，或者使用 `^...$`。搜索和验证不是同一件事。

### 5. 分组、捕获和或分支

圆括号把多段模式组合起来：

```text
(windows|linux)
```

`|` 表示二选一。它的优先级很低，所以：

```text
^cat|dog$      -> 以 cat 开头，或者以 dog 结尾
^(cat|dog)$    -> 全文只能是 cat 或 dog
```

普通圆括号同时会保存捕获内容。第 0 组通常是完整匹配，第 1 组开始才是我写的括号：

```text
模式: ^tool-v([0-9]+\.[0-9]+\.[0-9]+)-(windows|linux)$
输入: tool-v2.7.3-windows
组 0: tool-v2.7.3-windows
组 1: 2.7.3
组 2: windows
```

只想组合但不想捕获时，很多方言支持非捕获分组 `(?:...)`。需要在代码里取值时，我更喜欢命名分组，因为插入一个新括号不会把 `group(3)` 悄悄变成 `group(4)`。遗憾的是命名语法并不统一：

| 环境 | 命名捕获 |
| --- | --- |
| Python | `(?P<version>...)` |
| JavaScript/TypeScript | `(?<version>...)` |
| .NET / Scoop | `(?<version>...)` |
| C++ `std::regex` 默认 ECMAScript | 不支持命名捕获 |
| CMake Regex | 不支持命名捕获 |

这张表值得记住。模式的主要结构可以迁移，方言细节必须重新核对。

### 6. Lookaround 和反向引用

Lookaround 检查旁边是否存在某段文本，但不把它放进最终匹配：

```text
[0-9]+(?= MiB)       -> 只取 MiB 前面的数字
(?<=version=)[0-9.]+ -> 只取 version= 后面的数字
foo(?!bar)           -> foo 后面不能紧跟 bar
```

反向引用则要求后面再次出现前面捕获过的文本：

```text
\b([A-Za-z]+)\s+\1\b
```

它能找到 `the the` 这样的连续重复词。Python 和 JavaScript 还支持按名称引用，但语法仍然不同。

我把 Lookaround 和反向引用放在后面，不是因为它们不重要，而是因为它们最容易降低可移植性。CMake Regex 不支持 Lookaround，C++ 默认 ECMAScript 方言也不该假设拥有现代 JavaScript 的全部能力。能用捕获分组取得值，或者先定位再做第二步判断时，朴素方案通常更容易搬家。

## 把一个版本模式从宽改窄

我的实验页面抽取成纯文本后是这样：

```text
Build date: 2026.09.07
Preview: v2.8.0-beta.1
Latest stable: v2.7.3
Requires Runtime 1.4.0
```

如果我只写：

```regex
[0-9]+(?:\.[0-9]+)+
```

Python 实际找到了 4 项：

```text
['2026.09.07', '2.8.0', '2.7.3', '1.4.0']
```

模式没有错，它忠实找出了所有 "由点分隔的数字"。错的是需求只有 7 个字，"从页面提取版本"。页面上有 4 个都像版本的数字时，正则不可能读心。

我先把需求改写成人话：

> 找到以 `Latest stable:` 开头的完整行，允许冒号后有空白和一个 `v`，捕获恰好 3 段 ASCII 数字组成的稳定版号，不接受任何尾随字符。

然后逐块翻译：

```text
^Latest stable:                锚定标签和行首
\s*                            允许 0 个或更多空白
v                              要求 v
([0-9]+\.[0-9]+\.[0-9]+)      捕获三段版本号
$                              到行尾必须结束
```

最终模式是：

```regex
^Latest stable:\s*v([0-9]+\.[0-9]+\.[0-9]+)$
```

加上多行模式后，它从 4 个候选收窄到 1 个，得到 `2.7.3`。这里不是正则突然变聪明了，而是我终于把上下文也写进了规格。

> [!IMPORTANT]
> 先写清输入契约，再写正则。`[\d.]+` 甚至允许只有点号的字符串，`[0-9]+(?:\.[0-9]+)+` 也分不清日期和版本。上下文、锚点和负例比再堆一个字符类更有用。

## 反斜杠为什么总像在繁殖

屏幕上看到的模式经常要穿过两层语言：先由宿主语言生成字符串，再由正则引擎解释这个字符串。

我想交给正则引擎的内容是：

```regex
[0-9]+\.[0-9]+
```

在不同宿主里可能写成：

```python
# Python raw string
pattern = r"[0-9]+\.[0-9]+"
```

```ts
// JavaScript 正则字面量
const pattern = /[0-9]+\.[0-9]+/;

// RegExp 构造函数还要经过字符串解析
const dynamicPattern = new RegExp("[0-9]+\\.[0-9]+");
```

```cpp
// C++ raw string literal
const std::regex pattern{R"([0-9]+\.[0-9]+)"};

// 普通 C++ 字符串
const std::regex noisy{"[0-9]+\\.[0-9]+"};
```

```json
{
  "regex": "[0-9]+\\.[0-9]+"
}
```

这几行最终送给引擎的是同一个模式。JSON 文件中的 `\\` 不是正则需要两个反斜杠，而是 JSON 先把它还原为一个 `\`，正则再把 `\.` 解释为字面点号。

我现在调试这类问题时会打印宿主字符串的真实值，而不是盯着源码数斜杠。源码是包装盒，引擎收到的字符串才是货物。

## Python: 把模式写成可执行规格

Python 的 [`re` 文档](https://docs.python.org/3/library/re.html)明确建议用 raw string 表示模式。我的完整实验如下：

```python
import re

page = """Build date: 2026.09.07
Preview: v2.8.0-beta.1
Latest stable: v2.7.3
Requires Runtime 1.4.0
"""

loose = re.compile(r"[0-9]+(?:\.[0-9]+)+")
scoped = re.compile(
    r"^Latest stable:\s*v(?P<version>[0-9]+\.[0-9]+\.[0-9]+)$",
    re.MULTILINE,
)

print("loose:", loose.findall(page))

match = scoped.search(page)
if match is None:
    raise RuntimeError("stable version not found")

print("stable:", match.group("version"))
```

输出：

```text
loose: ['2026.09.07', '2.8.0', '2.7.3', '1.4.0']
stable: 2.7.3
```

这里有 5 个常用 API，名字很像，但契约不同：

| API | 做什么 | 我会在何时使用 |
| --- | --- | --- |
| `re.search()` | 在任意位置找第一处 | 从页面或日志提取一个字段 |
| `re.match()` | 只从字符串开头尝试 | 解析有固定前缀的行 |
| `re.fullmatch()` | 整个字符串必须匹配 | 校验文件名、ID、版本格式 |
| `re.findall()` | 返回所有匹配或捕获值 | 只需要结果列表 |
| `re.finditer()` | 迭代带位置和分组的 Match | 需要每一处的上下文 |
| `re.sub()` | 替换匹配内容 | 规范化文本 |

`findall()` 有一个容易忽略的行为：没有捕获组时返回完整匹配；有一个捕获组时返回该组；有多个捕获组时返回 Tuple。维护代码时，这种返回形状会因为加一个括号而变化。我需要稳定的详细结果时会用 `finditer()`，只用于结构的括号则写成 `(?:...)`。

替换也可以复用命名组：

```python
versioned = "tool_2.7.3_windows.zip"
normalized = re.sub(
    r"^(?P<name>[a-z]+)_(?P<version>[0-9.]+)_(?P<os>[a-z]+)\.zip$",
    r"\g<name>-v\g<version>-\g<os>.zip",
    versioned,
)
assert normalized == "tool-v2.7.3-windows.zip"
```

### 用 `re.VERBOSE` 拆掉一行咒语

模式一长，我宁愿让它多占几行：

```python
artifact = re.compile(
    r"""
    ^tool-v
    (?P<version>[0-9]+\.[0-9]+\.[0-9]+)
    -(?P<os>windows|linux)
    -(?P<arch>x64|arm64)
    \.zip$
    """,
    re.VERBOSE,
)
```

`re.VERBOSE` 会忽略模式中的大部分空白，并允许 `#` 注释。字符类里的空白仍有意义，需要匹配字面空格时也要明确写出。它没有改变正则能力，只是把一条压缩后的机器指令恢复成了可以审查的规格。

### Flags 不是装饰

我最常用的 Python Flags 是：

- `re.IGNORECASE` 或 `re.I`：忽略大小写。
- `re.MULTILINE` 或 `re.M`：让 `^` 和 `$` 作用于每一行。
- `re.DOTALL` 或 `re.S`：让 `.` 也匹配换行。
- `re.VERBOSE` 或 `re.X`：允许分行和注释。
- `re.ASCII` 或 `re.A`：让 `\w`、`\d`、`\s` 等使用 ASCII 语义。

`MULTILINE` 改的是锚点，`DOTALL` 改的是点号。二者名字都容易让我脑内自动补全成 "跨行匹配"，但它们控制的是两件不同的事。

## Scoop: 从非 GitHub 页面提取稳定版

GitHub Releases 可以让 Scoop 直接使用 `"checkver": "github"`。真正逼我写正则的，通常是厂商自己的下载页。

假设页面源码中有 3 个链接：

```html
<a href="/downloads/tool-v2.8.0-beta.1-windows-x64.zip">Preview</a>
<a href="/downloads/tool-v2.7.3-windows-x64.zip">Latest stable</a>
<a href="/runtime/runtime-v1.4.0-windows-x64.zip">Runtime</a>
```

我的 Manifest 可以这样写：

```json
{
  "version": "2.7.3",
  "homepage": "https://vendor.example/tool",
  "architecture": {
    "64bit": {
      "url": "https://vendor.example/downloads/tool-v2.7.3-windows-x64.zip",
      "hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  },
  "checkver": {
    "url": "https://vendor.example/tool/downloads",
    "regex": "href=\"/downloads/tool-v(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)-windows-x64\\.zip\""
  },
  "autoupdate": {
    "architecture": {
      "64bit": {
        "url": "https://vendor.example/downloads/tool-v$version-windows-x64.zip"
      }
    }
  }
}
```

这里我没有只抓 `[\d.]+`，而是把路径前缀、产品名、平台、架构和 `.zip` 后缀都放进模式。预览版因为版本后紧跟 `-beta.1`，无法满足 `-windows`；Runtime 又没有正确的路径和产品名。3 个链接只剩 1 个候选。

`(?<version>...)` 是命名捕获。Scoop 会把它作为版本使用，并能把其他命名组暴露成 `$matchName` 一类变量。官方的 [Autoupdate 文档](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifest-Autoupdate#using-regex-in-checkver)列出了 `regex`、`replace`、`reverse` 以及命名捕获的用法。

### 先在 PowerShell 里看清每一组

在写入 JSON 之前，我会先绕开 JSON 转义，直接用 PowerShell 验证 .NET Regex：

```powershell
$page = Get-Content .\fixture.html -Raw
$pattern = 'href="/downloads/tool-v(?<version>[0-9]+\.[0-9]+\.[0-9]+)-windows-x64\.zip"'
$match = [regex]::Match($page, $pattern)

if (-not $match.Success) {
    throw 'stable version not found'
}

$match.Value
$match.Groups['version'].Value
```

我用 PowerShell 7.6.5 运行后得到：

```text
href="/downloads/tool-v2.7.3-windows-x64.zip"
2.7.3
```

再把模式放进 Manifest，并运行真正的 Scoop 工具：

```powershell
$checkver = "$(scoop prefix scoop)\bin\checkver.ps1"
& $checkver tool .\bucket
& $checkver tool .\bucket -Update
scoop install .\bucket\tool.json
```

`checkver` 成功只证明版本提取成功，`-Update` 才会检查新 URL 能否生成并下载，最后的本地安装才覆盖解压、哈希和入口。验证链从 "一个 Match" 变成了 "提取 -> 更新 -> 下载 -> 安装"。

> [!TIP]
> 页面如果提供稳定 JSON API、XML、RSS 或可预测的目录索引，优先用结构化来源。Scoop `checkver` 支持 JSONPath 和 XPath。HTML 文案和 CSS Class 是给人和前端看的，通常比机器接口更容易变化。

### `reverse` 不是排序

Scoop 的 `"reverse": true` 会取最后一个匹配，而不是比较语义版本后取最大值。如果页面按时间倒序排列，默认第一项可能正好是最新；如果按升序排列，最后一项可能正好是最新。但这依赖页面顺序，不是版本排序算法。

我会先问自己：页面是否承诺顺序？如果没有，我更愿意寻找 `Latest stable` 上下文或结构化接口，而不是把偶然的 DOM 顺序写进更新逻辑。

## CMake: 从第三方 Header 读取版本

CMake 自己有一套较小的 Regex 方言。[`string(REGEX)` 文档](https://cmake.org/cmake/help/latest/command/string.html#regex-specification)列出的核心能力包括锚点、点号、字符类、`*`、`+`、`?`、`|` 和捕获组。它没有列出 `\d`、`{m,n}`、非捕获组或 Lookaround，所以我不会把 Python 模式原样粘进去。

假设一个 vendored 第三方库只在 `version.h` 暴露版本：

```c
#define MYLIB_VERSION_MAJOR 2
#define MYLIB_VERSION_MINOR 7
#define MYLIB_VERSION_PATCH 3
#define MYLIB_ABI_VERSION 4
```

我只筛选前三行，再取每行末尾数字：

```cmake
file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/vendor/mylib/version.h" version_lines
    REGEX [[^#define MYLIB_VERSION_(MAJOR|MINOR|PATCH) [0-9]+$]])

set(parts)
foreach(line IN LISTS version_lines)
    string(REGEX MATCH [[([0-9]+)$]] _ "${line}")
    list(APPEND parts "${CMAKE_MATCH_1}")
endforeach()

list(JOIN parts "." MYLIB_VERSION)

if(NOT MYLIB_VERSION MATCHES [[^[0-9]+\.[0-9]+\.[0-9]+$]])
    message(FATAL_ERROR "Cannot parse mylib version: ${MYLIB_VERSION}")
endif()

message(STATUS "MYLIB_VERSION=${MYLIB_VERSION}")
```

我实际用 CMake 4.1.6 运行了这段脚本，输出是：

```text
-- MYLIB_VERSION=2.7.3
```

`[[...]]` 是 CMake Bracket Argument。它不处理反斜杠转义，因此模式里的 `\.` 可以原样到达正则引擎。若改用普通双引号，某些反斜杠还要经过 CMake 语言解析。CMake 官方文档也用 Bracket Argument 展示如何避免这层噪声。

这里还有两个边界：

1. `CMAKE_MATCH_1` 到 `CMAKE_MATCH_9` 保存捕获组，组数有限，而且没有命名捕获。
2. CMake 4.1 通过 Policy `CMP0186` 调整了重复搜索中 `^` 的行为。跨版本维护时，应该让 `cmake_minimum_required()` 明确策略范围，并针对项目最低版本验证。

### CMake 中不要把 Glob 当 Regex

`file(GLOB)` 的 `*.cpp` 是 Glob，不是 Regex：

```cmake
file(GLOB sources CONFIGURE_DEPENDS "src/*.cpp")
```

`*` 在 Glob 中表示任意字符序列；在 Regex 中，它只重复前一个模式。相似的符号掩盖了不同的语法。顺带一提，CMake 官方仍不建议用 Glob 收集构建系统的源文件，因为新增或删除文件可能让生成系统何时重新配置变得不直观；显式列出源文件通常更稳。

## vcpkg: 正则应该待在哪一层

vcpkg Port 的 `portfile.cmake` 使用 CMake 语言，因此真要匹配文本时，面对的还是 CMake Regex 方言。但我不会让每次构建都抓网页，再用正则猜今天的最新版本。Port 构建需要可复现输入，"最新" 是一个会随时间移动的目标。

非 GitHub 上游通常使用 [`vcpkg_download_distfile()`](https://learn.microsoft.com/en-us/vcpkg/maintainers/functions/vcpkg_download_distfile)：

```cmake
set(VERSION "2.7.3")

vcpkg_download_distfile(ARCHIVE
    URLS "https://vendor.example/releases/mylib-${VERSION}.tar.gz"
    FILENAME "mylib-${VERSION}.tar.gz"
    SHA512 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
)

vcpkg_extract_source_archive(
    SOURCE_PATH
    ARCHIVE "${ARCHIVE}"
)
```

这里的版本和 SHA512 都是固定输入。更新机器人或维护脚本可以在上游页面用正则发现 `2.7.4`，但它应该生成一次明确变更，重新计算哈希，经过审查后提交。构建阶段只消费已经确定的版本。

如果源码在 GitHub，优先使用 [`vcpkg_from_github()`](https://learn.microsoft.com/en-us/vcpkg/maintainers/functions/vcpkg_from_github)，并把 `REF` 固定到 Tag 或 Commit；官方文档也明确说 `REF` 不应是 Branch。正则适合发现候选版本，不适合替代依赖锁定。

> [!WARNING]
> 不要为了让 CI 继续跑而跳过哈希。正则回答 "哪个文本像版本"，SHA512 回答 "下载到的字节是不是维护者审查过的那一份"。它们解决的是两个完全不同的问题。

## C++: `std::regex_search` 和 `std::regex_match` 不是一回事

C++11 在 `<regex>` 中提供了标准正则库。根据 [cppreference 的正则库总览](https://en.cppreference.com/w/cpp/regex.html)，`std::regex` 默认使用修改过的 ECMAScript Grammar，也可以显式选择 Basic、Extended、awk、grep 或 egrep 方言。

我用完整匹配验证发布物名称：

```cpp
#include <iostream>
#include <regex>
#include <string>

int main() {
    static const std::regex artifact{
        R"(^tool-v([0-9]+\.[0-9]+\.[0-9]+)-(windows|linux)-(x64|arm64)\.zip$)",
        std::regex::ECMAScript
    };

    const std::string filename = "tool-v2.7.3-windows-x64.zip";
    std::smatch match;

    if (!std::regex_match(filename, match, artifact)) {
        std::cerr << "invalid artifact name\n";
        return 1;
    }

    std::cout << "version=" << match[1]
              << " os=" << match[2]
              << " arch=" << match[3] << '\n';
}
```

我用 GCC 15.3.0 编译运行，得到：

```text
version=2.7.3 os=windows arch=x64
```

`std::regex_match()` 要求整个序列匹配，适合校验。`std::regex_search()` 只要求某个子序列匹配，适合从一段文本提取。即使模式已经有 `^` 和 `$`，我仍会选择表达意图的 API，让下一位读代码的人不用先审计两个锚点。

C++ 标准 Regex 没有命名捕获，所以 `match[1]`、`match[2]`、`match[3]` 的顺序就是接口。只用于结构的括号要尽量少；修改模式时，也要同步检查消费这些下标的代码。

`std::regex` 构造可能做明显多于字符串比较的工作。我不会在处理每一行的循环里重新构造同一个模式：

```cpp
// 不要把固定模式放进热循环
for (const auto& line : lines) {
    std::regex pattern{R"(... )"};
    // ...
}

// 构造一次，重复使用
static const std::regex pattern{R"(... )"};
for (const auto& line : lines) {
    // std::regex_search(line, pattern)
}
```

如果需求只是判断固定前缀、后缀或单个分隔符，`starts_with()`、`ends_with()`、`find()`、`from_chars()` 往往更直接，也更容易得到稳定性能。正则是工具，不是加入项目后的强制税种。

## JavaScript/TypeScript: 字面量、全局状态和动态模式

JavaScript 中的正则是对象。[MDN Regular Expressions Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions)列出了两种构造方法：

```ts
// 固定模式，优先使用字面量
const fixed = /tool-v([0-9]+\.[0-9]+\.[0-9]+)/;

// 模式来自运行时数据时使用构造函数
const prefix = "tool";
const dynamic = new RegExp(`${prefix}-v([0-9]+\\.[0-9]+\\.[0-9]+)`);
```

构造函数接收字符串，所以 `\.` 要写成 `\\.`。如果变量可能包含 `.`、`*`、`[` 等元字符，不能直接插值。现代运行时提供 `RegExp.escape()`：

```ts
const product = "tool.next";
const pattern = new RegExp(`^${RegExp.escape(product)}-v([0-9]+\\.[0-9]+\\.[0-9]+)$`);
```

`RegExp.escape()` 在较新的 JavaScript Runtime 中可用；项目的 Runtime 和 TypeScript `lib` 较旧时，要先核对兼容性，不要用手写的不完整替换冒充同等实现。

命名捕获让 TypeScript 端更清楚：

```ts
const page = `Build date: 2026.09.07
Preview: v2.8.0-beta.1
Latest stable: v2.7.3
Requires Runtime 1.4.0`;

const stable = /^Latest stable:\s*v(?<version>[0-9]+\.[0-9]+\.[0-9]+)$/m.exec(page);

if (!stable?.groups) {
  throw new Error("stable version not found");
}

console.log(stable.groups.version);
```

输出为：

```text
2.7.3
```

常用 Flags：

| Flag | 作用 |
| --- | --- |
| `g` | 查找全部，并让 Regex 对象维护 `lastIndex` |
| `i` | 忽略大小写 |
| `m` | 多行锚点 |
| `s` | 点号匹配换行 |
| `u` | 按 Unicode Code Point 解释模式 |
| `v` | 更完整的 Unicode Set 能力，不能和 `u` 同时使用 |
| `y` | Sticky，从 `lastIndex` 指定位置开始匹配 |
| `d` | 为匹配和捕获组生成索引 |

### 带 `g` 的 `test()` 有状态

这是 JavaScript 最容易制造幽灵 Bug 的地方之一：

```ts
const digits = /[0-9]+/g;

digits.test("v2"); // true, lastIndex 前进
digits.test("v2"); // false, 从上次位置继续
```

同一个输入，连续调用两次可能得到不同结果，因为 `g` 或 `y` 模式会更新 `lastIndex`。只做布尔校验时，我不用 `g`：

```ts
const digits = /[0-9]+/;
console.log(digits.test("v2"));
console.log(digits.test("v2"));
```

需要所有匹配及其分组时，`matchAll()` 更直观：

```ts
const text = "tool-v2.7.3 and runtime-v1.4.0";
const versions = [...text.matchAll(/v(?<version>[0-9]+\.[0-9]+\.[0-9]+)/g)]
  .map((match) => match.groups?.version);

console.log(versions); // ["2.7.3", "1.4.0"]
```

## 同一模式为什么不能到处复制

我把本文几个环境放在一起：

| 能力 | Python `re` | JavaScript | C++ ECMAScript | CMake | .NET / Scoop |
| --- | --- | --- | --- | --- | --- |
| `[0-9]`、`* + ?`、捕获组 | 是 | 是 | 是 | 是 | 是 |
| `{m,n}` | 是 | 是 | 是 | 文档未定义 | 是 |
| 非捕获组 `(?:...)` | 是 | 是 | 是 | 否 | 是 |
| 命名捕获 | `(?P<n>...)` | `(?<n>...)` | 否 | 否 | `(?<n>...)` |
| 懒惰量词 | 是 | 是 | 是 | 文档未定义 | 是 |
| Lookbehind | 有限制 | 现代引擎支持 | 不应依赖 | 否 | 是 |
| 完整匹配 API | `fullmatch` | 用锚点 | `regex_match` | 用锚点 | API 或锚点 |

"文档未定义" 不等于 "我的机器试了一次没报错，所以可以用"。可移植代码依赖的是目标方言承诺的语法，不是某次实现恰好接受的字符。

这也解释了在线测试网站的局限。它非常适合高亮匹配和观察分组，但我必须把 Flavor 设成真正的引擎。即便网站上看起来正确，最终测试仍要回到项目使用的 Python、Node.js、C++ 标准库、CMake 或 PowerShell。

## 我现在怎样从零写一个模式

我把过去的 "AI 生成 -> 跑一下" 改成下面 7 步。

### 1. 先写输入契约

不要写 "提取版本"。要写：

```text
输入是发布页源码。
只接受 Latest stable 下载链接。
版本必须是 3 段 ASCII 数字。
拒绝 Preview、Runtime、校验和链接和其他架构。
```

### 2. 收集正例和负例

正例告诉模式应该接受什么，负例决定它不会宽到哪里去。我的文件名矩阵是：

```text
应该接受:
tool-v2.7.3-windows-x64.zip
tool-v10.0.0-linux-arm64.zip
tool-v0.1.0-windows-arm64.zip
tool-v3.12.5-linux-x64.zip
tool-v1.0.0-windows-x64.zip
tool-v99.8.7-linux-arm64.zip

必须拒绝:
tool-v2.7-windows-x64.zip
tool-v2.7.3-macos-x64.zip
tool-v2.7.3-windows-riscv64.zip
prefix-tool-v2.7.3-windows-x64.zip
tool-v2.7.3-windows-x64.zip.sha256
tool-v2.7.3.4-linux-x64.zip
```

它不是随机样本。6 个负例分别攻击版本段数、OS、架构、前缀、后缀和额外版本段。

### 3. 从字面骨架开始

先写不会变化的部分：

```regex
^tool-v-VERSION-(windows|linux)-(x64|arm64)\.zip$
```

再把 `VERSION` 换成：

```regex
[0-9]+\.[0-9]+\.[0-9]+
```

最终得到：

```regex
^tool-v([0-9]+\.[0-9]+\.[0-9]+)-(windows|linux)-(x64|arm64)\.zip$
```

### 4. 明确我要搜索还是验证

- 提取页面字段：Search。
- 校验完整文件名：Full Match。
- 收集所有版本：Find All / Iterator。
- 重写名称：Replace。

不要用一个模糊的 "Match" 代替操作语义。

### 5. 逐组读取结果

我至少检查完整匹配、每个捕获组和匹配位置。只打印版本号会藏住模式实际吞掉的前后文本。

### 6. 在真实 Runtime 建表测试

Python 版本：

```python
import re

artifact = re.compile(
    r"^tool-v(?P<version>[0-9]+\.[0-9]+\.[0-9]+)-"
    r"(?P<os>windows|linux)-(?P<arch>x64|arm64)\.zip$"
)

cases = [
    ("tool-v2.7.3-windows-x64.zip", True),
    ("tool-v10.0.0-linux-arm64.zip", True),
    ("tool-v2.7-windows-x64.zip", False),
    ("tool-v2.7.3-macos-x64.zip", False),
    ("tool-v2.7.3-windows-x64.zip.sha256", False),
]

for text, expected in cases:
    actual = artifact.fullmatch(text) is not None
    assert actual == expected, text
```

我在完整实验里运行了 12 个案例，结果是 `12/12 passed`。同一矩阵也通过了 Node.js 24.19.0 的 TypeScript 实现和 GCC 15.3.0 的 C++ 实现。一次成功输出升级成 3 个 Runtime、12 个边界案例；这才开始像验证，而不是占卜。

### 7. 最后才压缩或搬进配置

可读版本通过后，再把它放进 JSON、CMake 或一行配置。如果压缩过程引入双重转义，我会同时保留分块注释或测试脚本。正则短不等于简单，往往只代表空白被删了。

## AI 应该怎样参与

我没有打算停止让 AI 帮我写正则。变化在于，我不再把输出当答案，而是当候选实现。

我现在会给 AI 这些材料：

```text
目标引擎: .NET Regex，由 Scoop checkver 使用
宿主格式: JSON，所以反斜杠需要 JSON 转义
要提取: 命名组 version
正例: ...
负例: ...
要求: 解释每一段，不使用 Lookbehind
输出: 原始 Regex、JSON 字符串、PowerShell 验证脚本
```

然后我会反问 4 件事：

1. 哪个输入会被意外接受？
2. 哪个方言特性不可移植？
3. 模式交给引擎前的真实字符串是什么？
4. 是否存在不用正则的结构化方案？

AI 很擅长快速枚举语法，但它看不到我没有提供的页面变化，也不会自动知道这段字符串最终经过 JSON、CMake 还是 C++ Raw String。规格和反例仍然在我手里。

## 正则什么时候会变成第二个问题

有些任务本身有明确语法树：HTML、JSON、XML、C++、URL。正则可以在局部定位文本，但通常不该承担完整解析。

我会在这些情况停下来：

- 需要处理任意层级嵌套，例如括号或 HTML Element。
- 输入已有成熟 Parser，例如 JSON、YAML、XML、URL。
- 模式开始依赖大量 `.*?` 跨越不受控内容。
- 每修一个负例就增加一条互相覆盖的 Lookaround。
- 输入来自不可信用户，而模式有嵌套、含糊的重复。

经典危险形状是：

```regex
^(a+)+$
```

对一长串 `a` 加一个结尾 `!`，某些回溯引擎会反复尝试把同一串 `a` 切成不同分组，组合数迅速增长。这类 ReDoS 不需要模式看起来很长，只需要路径足够含糊。

实用规则很朴素：避免在重复里再放可以用多种方式消费同一字符的重复；给输入长度设上限；不要让攻击者同时控制模式和超长文本；对外部输入做性能验证。若场景要求线性时间保证，可以考虑 RE2、Rust `regex` 这类限制部分高级能力以换取更可预测执行时间的引擎。

## 从今天往后

我怀疑正则表达式短期内不会消失。结构化 API 会越来越多，但版本页、日志、构建输出、旧式 Header 和文件名仍然是一大片半结构化文本。模型会继续生成越来越像答案的模式，可真正的进步不是让我更快复制它，而是让我能读出 `^` 在约束什么、哪个括号在捕获什么、为什么 CMake 不接受 Python 的写法，以及负例会从哪条缝里钻进来。

这篇文章最后留下的不是一条万能正则，而是一套比较无聊但可靠的循环：写契约，收集正反例，选择方言，分块构造，在真实 Runtime 运行，再接入自动化。现在 AI 仍然可以写第一稿，只是那串线路噪声终于需要接受 Code Review 了。
