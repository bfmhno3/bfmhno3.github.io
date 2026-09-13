---
title: "我把同一份 Agent 配置写了 4 遍: JSON、TOML、YAML 与配置文件的语法和选择"
commentId: "post:configuration-file-formats-for-ai-agents"
published: "2026-09-13 20:00:00 +08:00"
description: "我把同一份包含 16 个叶子值的 Agent 配置分别写成 JSON、TOML、YAML 和 INI，实际解析并比较它们，再解释 JSONC、.env、XML、Schema、覆盖顺序、密钥管理与常见陷阱。"
category: Tutorial
tags:
  - Configuration
  - AI Agent
  - JSON
  - TOML
  - YAML
  - INI
draft: false
comment: true
slug: configuration-file-formats-for-ai-agents
---

AI Agent 已经开始替我读代码、调用工具、运行命令和修改文件，但它们似乎在配置格式上召开了一次没有邀请用户参加的会议。一个工具要 `settings.json`，另一个要 `config.toml`，CI 又塞来一份 YAML，项目规则偏偏写在 `AGENTS.md`。默认配置通常只能证明程序能启动，真正决定效率和安全边界的模型、权限、沙箱、工具、目录规则与环境变量，最后还是要我自己写。

所以我做了一个很小的配置实验室。我先设计一份包含 **16 个叶子值**的 Agent 配置，再把它等价地写成 JSON、TOML、YAML 和 INI，用真实解析器读回内存，比较它们到底表达了什么。4 份文件合计只有 71 行，却已经足够踩到注释、尾逗号、字符串推断、重复键、日期类型和数组表这些坑。配置文件大概就是这样一种东西: 看起来像便签，实际上更像驾驶舱接线板，少一个引号可能只关掉音乐，也可能打开网络和写权限（多少有点刺激）。

本文以 [JSON RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)、[TOML 1.0.0](https://toml.io/en/v1.0.0)、[YAML 1.2.2](https://yaml.org/spec/1.2.2/) 为主要语法依据。具体 Agent 工具的字段会持续变化，本文不会猜某个工具明天还认不认今天的字段，而是先把所有配置背后的数据模型讲清楚。

## 配置文件不是配置本身

我先区分 4 个经常混在一起的东西:

1. **格式**回答文本怎样变成数据，例如 JSON 的 `{}`、TOML 的 `[table]` 和 YAML 的缩进。
2. **Schema** 回答数据应该长什么样，例如 `temperature` 必须是 `0` 到 `2` 之间的数字。
3. **语义**回答字段会做什么，例如 `network = false` 到底禁止 Agent 联网，还是只禁止它启动的子进程联网。
4. **加载策略**回答多份配置如何合并，例如命令行、项目配置和用户配置谁覆盖谁。

语法正确，只说明 Parser 能读。下面这段 JSON 完全合法:

```json
{
  "temperature": 9000,
  "sandbox_mode": "banana"
}
```

它在 Schema 层和业务语义层大概率都不合法。反过来，字段和值全写对了，放错文件路径也等于没有配置。Parser、Validator 和 Loader 是 3 个不同部件，不要指望其中一个替另外两个值夜班。

```mermaid
graph LR
    A[配置文本] --> B[Parser 解析语法]
    B --> C[内存数据]
    C --> D[Schema 验证结构]
    D --> E[应用检查语义]
    E --> F[多来源合并]
    F --> G[Agent 实际行为]
```

JSON、TOML 和 YAML 的表面差异很大，但日常配置最终大多落到同一棵树上:

- **Mapping**: 键到值的映射，也叫 Object、Table、Map 或 Dictionary。
- **Sequence**: 有顺序的值列表，也叫 Array 或 List。
- **Scalar**: 字符串、数字、布尔值、空值、日期等单个值。

理解这 3 类节点，比背下 3 张标点符号表有用得多。

## 我先造一份 Agent 配置

我希望这份配置足够小，又能覆盖实际需求:

- 选择模型和温度。
- 设置工作目录与包含规则。
- 控制读、写、网络 3 种权限。
- 注册 2 个 MCP Server，每个 Server 有命令和参数数组。

它对应的概念结构如下:

```text
root
├── model: string
├── temperature: number
├── dry_run: boolean
├── workspace: string
├── include: array<string>
├── permissions: object
│   ├── read: boolean
│   ├── write: boolean
│   └── network: boolean
└── mcp_servers: array<object>
    ├── docs
    │   ├── command: string
    │   └── args: array<string>
    └── repo
        ├── command: string
        └── args: array<string>
```

这里一共有 16 个叶子值。根节点有对象、数组和标量，已经是一份很典型的 Agent 配置了。

## JSON: 标点很多，但歧义很少

JSON 是最小的一门。它只有 6 类值:

| 类型 | 示例 |
| --- | --- |
| Object | `{"read": true}` |
| Array | `["src", "tests"]` |
| String | `"reasoning-large"` |
| Number | `0.2` |
| Boolean | `true`、`false` |
| Null | `null` |

同一份配置写成 JSON 是这样:

```json
{
  "model": "reasoning-large",
  "temperature": 0.2,
  "dry_run": false,
  "workspace": "/work/demo",
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "permissions": {
    "read": true,
    "write": false,
    "network": false
  },
  "mcp_servers": [
    {"name": "docs", "command": "node", "args": ["server.js", "--stdio"]},
    {"name": "repo", "command": "python", "args": ["repo.py"]}
  ]
}
```

这份文件是 **16 行、396 Bytes**。标点占了不少位置，但每个值的边界都很明确。

### Object、Array 与逗号

Object 用花括号，成员写成 `"key": value`。Array 用方括号，元素按顺序排列。成员或元素之间放逗号，最后一个后面不能放逗号:

```json
{
  "tools": ["read", "write"]
}
```

下面不是标准 JSON:

```json
{
  "tools": ["read", "write"],
}
```

我用 Python 3.13 的 `json` 模块解析一份带注释和尾逗号的文本，得到的是:

```text
JSONDecodeError: Expecting property name enclosed in double quotes
```

这两个限制常让手写配置变得烦，但也让生成器和不同语言的 Parser 更容易达成一致。

### Key 和 String 必须使用双引号

标准 JSON 的 Object Key 是 String，所以必须加双引号。String 本身也只能使用双引号:

```json
{"model": "reasoning-large"}
```

下面 3 种都不是标准 JSON:

```javascript
{model: "reasoning-large"}   // 裸 key
{'model': 'reasoning-large'} // 单引号
{"model": undefined}        // JSON 没有 undefined
```

它们可能是合法 JavaScript，却不是合法 JSON。JSON 源自 JavaScript 对象字面量，但今天二者不是同一种语言。

### 转义: 反斜杠会再收一次税

JSON String 中常用转义包括:

| 写法 | 值中的字符 |
| --- | --- |
| `\"` | 双引号 |
| `\\` | 反斜杠 |
| `\n` | 换行 |
| `\t` | 制表符 |
| `\u4e2d` | Unicode 字符 `中` |

Windows 路径和正则表达式最容易暴露双层解析:

```json
{
  "workspace": "C:\\Users\\me\\project",
  "pattern": "^src\\/.*\\.ts$"
}
```

文件里写 `\\`，Parser 读出来才是一个 `\`。如果这段字符串随后还要进入正则 Parser，它又会解释一遍。每套 Parser 都像机场安检，再过一层就再开一次箱。

### Number 没有 `int64` 这回事

JSON Grammar 允许负数、小数和指数形式:

```json
{
  "retries": 3,
  "temperature": 0.2,
  "threshold": 1e-6
}
```

但 JSON 只定义 Number 的文本语法，不承诺宿主语言使用哪种数值类型。JavaScript 通常把它读成 IEEE 754 双精度 Number，因此超过安全整数范围的 ID 可能丢精度:

```json
{
  "job_id": 9007199254740993
}
```

跨语言传递大整数、雪花 ID 或精确 Decimal 时，我会写成字符串，再由应用按明确类型解析:

```json
{
  "job_id": "9007199254740993"
}
```

### `null`、缺失与空字符串不同

这 3 份配置表达不同状态:

```json
{}
```

```json
{"proxy": null}
```

```json
{"proxy": ""}
```

它们通常分别表示未提供、显式置空、提供了空字符串。具体工具可能赋予别的语义，但格式本身没有把三者合并。配置合并时这一区别尤其重要: `null` 有时会删除继承值，有时会覆盖成空值，有时直接不合法。只能查工具文档或 Schema，不能靠气氛判断。

### 重复 Key 和成员顺序

RFC 8259 说 Object 中的名称**应该唯一**，因为重复时不同实现可能保留第一个、保留最后一个、全部保留或报错:

```json
{
  "network": false,
  "network": true
}
```

人类可能从上往下读成 "最后一次覆盖"，安全审计却不该建立在 "可能" 上。不要写重复 Key。

JSON Object 在数据模型上是无序映射。Parser 经常保留源码顺序，但业务逻辑不应该依赖顺序。需要顺序时使用 Array。

### JSON 为什么没有注释

标准 JSON 没有注释。对机器生成、API 交换和锁文件来说，这是优点；对手写的长期配置来说，这很痛苦。常见解决方案有 3 种:

1. 工具明确支持 **JSONC**，也就是带 `//` 或 `/* ... */` 注释的 JSON 方言。
2. 用 `$comment`、`description` 之类的普通字段，前提是 Schema 允许未知字段。
3. 攬弃 JSON，改用工具支持的 TOML 或 YAML。

> [!WARNING]
> `.json` 扩展名不等于支持 JSONC。`tsconfig.json` 等工具接受注释，是对应 Parser 的扩展能力，不是 JSON 标准突然心软了。必须以消费该文件的工具为准。

JSONC 也不是 JSON5。JSON5 还可能允许单引号、裸 Key、`Infinity` 等更多 JavaScript 风格语法。方言名称看起来只差一个字符，能力边界却不同。

### 我什么时候选 JSON

我会把 JSON 用在这些地方:

- 工具或 API 强制要求 JSON。
- 文件主要由程序生成，而不是长期手写。
- 需要成熟的 JSON Schema、编辑器补全和跨语言互操作。
- 希望语法保持很小，不接受隐式类型或复杂别名。

对于一份需要大量解释的 Agent 权限配置，纯 JSON 不是我最喜欢的手写格式。对一份 MCP 进程注册表或机器生成的状态文件，它通常很合适。

## TOML: 配置文件开始像配置文件了

TOML 的目标就是映射到 Hash Table，并让含义尽量明显。它增加了注释、Table、日期时间和更丰富的 String，同时仍然保持相当严格。

同一份配置写成 TOML:

```toml
model = "reasoning-large"
temperature = 0.2
dry_run = false
workspace = "/work/demo"
include = ["src/**/*.ts", "tests/**/*.ts"]

[permissions]
read = true
write = false
network = false

[[mcp_servers]]
name = "docs"
command = "node"
args = ["server.js", "--stdio"]

[[mcp_servers]]
name = "repo"
command = "python"
args = ["repo.py"]
```

这份文件是 **20 行、334 Bytes**。它比 JSON 多 4 行，却少了 62 Bytes，主要因为不再重复花括号和大量双引号。

### Key/Value Pair

TOML 最基本的语句是:

```toml
key = value
```

等号左右的空格不影响含义。Bare Key 只能包含 ASCII 字母、数字、下划线和连字符:

```toml
model = "reasoning-large"
max_tokens = 8192
sandbox-mode = "workspace-write"
```

特殊 Key 要加引号:

```toml
"server name" = "docs"
"127.0.0.1" = "local"
```

TOML 区分大小写，所以 `model` 和 `Model` 是两个 Key。为了少给自己制造一种区别，我通常统一使用 `snake_case`。

### 注释

`#` 到行尾是注释，String 内部的 `#` 仍然是普通字符:

```toml
model = "reasoning-large" # 用于代码任务
color = "#ff8800"
```

注释是 TOML 很适合手写 Agent 配置的原因。权限字段旁边可以解释为什么关闭，而不是期待 6 个月后的自己心灵感应。

### 4 种 String

TOML 有 Basic、Literal 以及它们各自的多行形式。

**Basic String** 使用双引号并处理转义:

```toml
message = "first line\nsecond line"
path = "C:\\Users\\me\\project"
```

**Literal String** 使用单引号，不处理反斜杠转义，很适合 Windows 路径和正则:

```toml
path = 'C:\Users\me\project'
pattern = '^src/.*\.ts$'
```

单引号不是 Shell 的单引号，只是 TOML Literal String 的定界符。

**Multiline Basic String** 使用 3 个双引号:

```toml
instructions = """
Read the repository rules first.
Run the narrowest relevant check.
Do not print secrets.
"""
```

**Multiline Literal String** 使用 3 个单引号，内容中的反斜杠仍然保持原样:

```toml
windows_example = '''
C:\Users\me\project
'''
```

多行 String 的首个紧邻换行会被裁掉，结尾换行是否保留要看定界符位置和具体写法。放长 Prompt 时，我会用一个实际 Parser 打印 `repr()`，不靠目测数换行。

### Integer、Float 与可读分隔符

TOML 区分 Integer 和 Float，并允许下划线分组数字:

```toml
max_tokens = 128_000
ratio = 0.25
threshold = 1e-6
hex_mask = 0xFF_A0
```

布尔值只能小写:

```toml
enabled = true
dry_run = false
```

`True`、`FALSE` 都不合法。严格其实挺好，少一种写法就少一种会议议题。

### 日期与时间是原生类型

TOML 比 JSON 多出 Offset Date-Time、Local Date-Time、Local Date 和 Local Time:

```toml
expires_at = 2026-09-13T08:30:00Z
maintenance_date = 2026-09-13
quiet_time = 08:30:00
```

我用 Python 3.13 标准库 `tomllib` 解析后，3 个值分别变成:

```text
expires_at       datetime  2026-09-13 08:30:00+00:00
maintenance_date date      2026-09-13
quiet_time       time      08:30:00
```

这不是字符串格式化糖。Parser 确实产生了不同宿主类型。需要原样保留时间文本时应该加引号。

### Array 与 Inline Table

普通 Array:

```toml
include = ["src/**/*.ts", "tests/**/*.ts"]
ports = [3000, 3001, 3002]
```

TOML 1.0 Array 允许混合不同类型，但配置中的同类列表通常更容易验证和消费。Array 可以跨行，并允许最后一个元素后带逗号:

```toml
allowed_tools = [
  "read",
  "search",
  "browser",
]
```

Inline Table 适合很小的对象:

```toml
limits = { requests = 10, timeout_seconds = 30 }
```

TOML 1.0 的 Inline Table 要放在一行内，而且最后一项后不能有尾逗号。对象一旦开始增长，我就把它改成正式 Table。

### Table 与 Dotted Key

Table Header 建立嵌套对象:

```toml
[permissions]
read = true
write = false
```

它等价于:

```json
{
  "permissions": {
    "read": true,
    "write": false
  }
}
```

Dotted Key 可以写同一结构:

```toml
permissions.read = true
permissions.write = false
```

再深一层也可以:

```toml
mcp.docs.command = "node"
mcp.docs.enabled = true
```

但不要同时用多种写法重复定义同一个 Key。TOML 禁止重复 Key，我实际把下面文本交给 `tomllib`:

```toml
key = 1
key = 2
```

结果是:

```text
TOMLDecodeError: Cannot overwrite a value (at line 2, column 8)
```

这比 JSON 的 "各 Parser 自行发挥" 更安全。

### Array of Tables: MCP Server 的关键语法

`[[mcp_servers]]` 每出现一次，就向 `mcp_servers` Array 追加一个 Table:

```toml
[[mcp_servers]]
name = "docs"
command = "node"
args = ["server.js", "--stdio"]

[[mcp_servers]]
name = "repo"
command = "python"
args = ["repo.py"]
```

它对应 JSON 的:

```json
{
  "mcp_servers": [
    {
      "name": "docs",
      "command": "node",
      "args": ["server.js", "--stdio"]
    },
    {
      "name": "repo",
      "command": "python",
      "args": ["repo.py"]
    }
  ]
}
```

一个方括号 `[x]` 是 Table，两个方括号 `[[x]]` 是 Array of Tables。少写一层方括号，不是少了一点装饰，而是换了数据类型。

### Table 之后的归属陷阱

TOML 依赖 Header 改变后续 Key 的归属:

```toml
model = "reasoning-large"

[permissions]
read = true
write = false
```

`model` 在根 Table，`read` 和 `write` 在 `permissions`。如果把 `model` 放到 Header 后面:

```toml
[permissions]
read = true
model = "reasoning-large"
```

那么 `model` 也属于 `permissions`，不是回到根节点。缩进不改变归属，最近的 Table Header 才改变。TOML 看起来平坦，但 Parser 记得自己当前站在哪个房间。

### TOML 没有 `null`

TOML 没有通用 Null。可选字段通常直接省略，或者由应用定义一个明确的哨兵字符串。不要擅自写:

```toml
proxy = null
```

它不合法。省略和显式清除必须由工具的合并协议另行设计，这也是 TOML 在多层覆盖场景中的一个真实限制。

### 我什么时候选 TOML

如果工具允许我自己选择格式，我通常把 TOML 用于:

- 人类长期维护的应用或 Agent 设置。
- 结构以 Key/Value 和中等深度 Table 为主。
- 需要注释、明确类型和严格重复键检查。
- 包含日期时间、路径、正则或多行 Prompt。

当嵌套非常深、对象数组很多时，TOML 的 Header 会让我在文件里频繁确认当前位置。这时 YAML 或 JSON 可能更直观。

## YAML: 最少的标点，最大的语法表面积

YAML 用缩进表达层次，用 `key: value` 表达 Mapping，用 `- value` 表达 Sequence。它看起来最接近人写的提纲，也因此最容易让人忘记它是一门完整的数据序列化语言，而不是 "JSON 去掉括号"。

同一份配置写成 YAML:

```yaml
model: reasoning-large
temperature: 0.2
dry_run: false
workspace: /work/demo
include:
  - src/**/*.ts
  - tests/**/*.ts
permissions:
  read: true
  write: false
  network: false
mcp_servers:
  - name: docs
    command: node
    args: [server.js, --stdio]
  - name: repo
    command: python
    args: [repo.py]
```

这份文件是 **18 行、310 Bytes**，比 JSON 少 86 Bytes，缩短约 **21.7%**。视觉噪声确实最低，但这 86 Bytes 不是免费午餐，它把一部分结构责任交给了空格和类型推断。

### Mapping、Sequence 与缩进

Mapping 是 `key: value`:

```yaml
model: reasoning-large
dry_run: false
```

Sequence 的每项以 `- ` 开头:

```yaml
tools:
  - read
  - search
  - browser
```

Sequence Item 也可以是 Mapping:

```yaml
servers:
  - name: docs
    command: node
  - name: repo
    command: python
```

缩进表示父子关系。YAML 规范要求缩进使用空格，不能用 Tab:

```yaml
permissions:
  read: true
  write: false
```

`read` 和 `write` 比 `permissions` 多缩进 2 个空格，所以属于它。2 个空格不是 YAML 的强制宽度，只是一种最常见约定；同一级必须保持一致。

下面的视觉差异很小，数据结构却不同:

```yaml
# 一个对象，里面有两个字段
permissions:
  read: true
  write: false
```

```yaml
# 两个对象组成的数组
permissions:
  - read: true
  - write: false
```

第 2 份通常不是权限配置想要的结构。横杠不是 Bullet 的装饰，它创建了 Array Item。

### Block Style 与 Flow Style

YAML 也支持类似 JSON 的 Flow Style:

```yaml
include: [src/**/*.ts, tests/**/*.ts]
permissions: {read: true, write: false, network: false}
```

这和 Block Style 表达同类数据。我的规则很简单:

- 小型标量数组可以用 Flow Style。
- 嵌套对象和对象数组使用 Block Style。
- 不为了省 2 行把整份 YAML 压成括号迷宫。

YAML 1.2 的目标之一是让 JSON 成为它的严格子集。因此，一份标准 JSON 文本通常也是合法 YAML 1.2 文本。不过，工具实际使用的 YAML Parser、Schema 和扩展版本仍可能不同，不能由这个包含关系推断所有实现行为一致。

### Plain、单引号与双引号 Scalar

不加引号的是 Plain Scalar:

```yaml
model: reasoning-large
workspace: /work/demo
```

单引号主要按字面保留内容，内部单引号写两次:

```yaml
pattern: '^src/.*\.ts$'
message: 'It''s ready'
```

双引号会处理 `\n`、`\t`、`\uXXXX` 等转义:

```yaml
message: "first line\nsecond line"
path: "C:\\Users\\me\\project"
```

YAML 的 Plain Scalar 方便，但某些开头字符和 `: `、` #` 组合具有结构意义。遇到 URL、时间、通配符、正则、冒号后空格或看起来像布尔值和数字的文本，我倾向于加引号:

```yaml
url: "https://example.com/api"
pattern: "*.ts"
answer: "null"
version: "1.0"
```

这里的引号不是为了让文件看起来正式，而是为了固定类型和边界。

### 隐式类型: YAML 最著名的脚趾捕捉器

YAML 会根据 Schema 解析 Plain Scalar。YAML 1.1 中 `yes`、`no`、`on`、`off` 经常被解析成 Boolean；YAML 1.2 Core Schema 把 Boolean 收窄为大小写组合的 `true` 和 `false`。问题是现实工具不一定使用同一规范版本或同一 Schema。

我用 `yq 4.53.2` 实际解析了 6 个值:

| 源文本 | 解析后的值 | 类型 |
| --- | --- | --- |
| `on` | `"on"` | String |
| `yes` | `"yes"` | String |
| `null` | `null` | Null |
| `2026-09-13` | `"2026-09-13"` | String |
| `0123` | `123` | Integer |
| `1e3` | `1000` | Integer |

这组结果描述的是本次 `yq` 实验，不是宇宙中所有 YAML Parser 的共同誓言。比如某些 Parser 会把日期构造成 Date 对象，旧版 YAML 1.1 Parser 可能把 `on` 读成 `true`。

跨工具配置里，我会遵循 3 条保守规则:

1. Boolean 只写 `true` 和 `false`。
2. Null 只写 `null`，需要字符串时写 `"null"`。
3. 版本号、ID、端口前导零、日期和类似科学计数法的文本都加引号。

### Null 有很多写法，但不要炫技

YAML Core Schema 可以识别 `null`、`Null`、`NULL` 和 `~`。空 Value 也可能解析为空节点:

```yaml
proxy: null
cache: ~
optional:
```

它们是否在应用合并时表示 "删除继承值"，仍由应用定义。我只写小写 `null`，因为清楚比展示语言掌握程度重要。

### 多行文本: `|` 与 `>`

Agent 配置经常包含 Prompt 或 Instructions，YAML 的 Block Scalar 很方便。

Literal Style `|` 保留换行:

```yaml
instructions: |
  Read repository rules first.
  Run the narrowest relevant check.
  Do not print secrets.
```

解析结果近似:

```text
Read repository rules first.\nRun the narrowest relevant check.\nDo not print secrets.\n
```

Folded Style `>` 会把多数普通换行折叠为空格:

```yaml
instructions: >
  Read repository rules first.
  Run the narrowest relevant check.
  Do not print secrets.
```

解析结果近似:

```text
Read repository rules first. Run the narrowest relevant check. Do not print secrets.\n
```

末尾 Chomping Indicator 控制结尾换行:

| 写法 | 末尾行为 |
| --- | --- |
| `\|` / `>` | 通常保留 1 个结尾换行 |
| `\|-` / `>-` | 删除结尾换行 |
| `\|+` / `>+` | 保留所有结尾空行 |

Prompt 对空格和换行敏感时，`|` 和 `>` 不是排版选择，而是数据选择。我通常用 `|-` 表示 "保留内部行，不额外添加末尾换行"。

### Anchor 与 Alias

YAML 可以用 Anchor `&name` 标记节点，再用 Alias `*name` 引用同一节点:

```yaml
safe_permissions: &safe
  read: true
  write: false
  network: false

agents:
  reviewer:
    permissions: *safe
  researcher:
    permissions: *safe
```

这能减少重复，但也增加了追踪成本。更微妙的是，常见的 Merge Key `<<` 并不属于 YAML 1.2 Core Schema 的普通能力，很多工具把它作为额外约定支持:

```yaml
researcher:
  <<: *defaults
  network: true
```

除非目标工具明确支持，我不会在可移植 Agent 配置里依赖 Merge Key。几十行重复配置可能不优雅，但一次静默忽略的权限覆盖更不优雅。

Alias 还可能让反序列化后的数据成为共享引用，而不是两个完全独立的副本。应用若修改其中一个节点，另一个是否跟着变化取决于加载器和后续转换。配置只是静态输入时影响不大，直接在内存中变更解析结果时要留意。

### Tag 与反序列化安全

YAML 支持显式 Tag，用来说明节点类型:

```yaml
port: !!int "4321"
label: !!str 4321
```

某些语言生态还支持构造本地对象的自定义 Tag。历史上，不安全加载任意 YAML 可能触发对象构造甚至代码执行。处理不可信 YAML 时，要使用目标库的 Safe Loader，并限制 Alias 数量、文档大小和嵌套深度。

这不是 YAML 独有的问题。任何支持扩展类型、引用或对象构造的反序列化格式都需要资源与类型边界。只是 YAML 的友好外观很容易让人忘记 Parser 后面可能站着一台对象工厂。

### 多文档 Stream

YAML 可以在一个 Stream 中放多份 Document:

```yaml
---
name: reviewer
permissions:
  write: false
---
name: implementer
permissions:
  write: true
...
```

`---` 开始新 Document，`...` 显式结束 Document。很多 Kubernetes 文件使用这种能力，但不是所有 Agent 配置 Loader 都接受多文档。工具只期待一个 Mapping 时，不要因为 YAML 能写就写。

### 重复 Key

YAML Mapping 的 Key 必须唯一，但现实 Parser 对重复 Key 的处理并不统一。有的报错，有的保留最后值:

```yaml
permissions:
  network: false
  network: true
```

这在权限配置里尤其危险。Lint 应当把重复 Key 当错误，而不是把它当覆盖机制。

### 我什么时候选 YAML

我会用 YAML 处理:

- 人类频繁编辑、嵌套层次明显的配置。
- CI Pipeline、部署清单等生态已经统一使用 YAML 的地方。
- 需要大量多行文本或对象数组。
- 目标工具提供严格 Schema、编辑器支持和明确 Parser 版本。

如果配置涉及安全权限、隐式类型很多，且没有 Schema 或 Lint，我反而更偏向 TOML 或 JSON。YAML 的简洁来自上下文，机器和人都必须把上下文读对。

## INI: 简单到每个实现都想补一点

INI 没有一份像 RFC 8259 那样统治所有实现的统一规范。它通常由 Section 和 Key/Value 组成:

```ini
[agent]
model = reasoning-large
temperature = 0.2
dry_run = false
workspace = /work/demo
include = src/**/*.ts, tests/**/*.ts

[permissions]
read = true
write = false
network = false

[mcp:docs]
command = node
args = server.js, --stdio

[mcp:repo]
command = python
args = repo.py
```

这是实验中最短的文件: **19 行、280 Bytes**。但短的原因之一是它没有直接表达 Array 和对象数组，我把它们压成了逗号分隔字符串与命名 Section。应用必须自己约定怎么拆。

### 值通常都是 String

Python 3.13 的 `ConfigParser` 读取上面的值后:

```text
temperature -> '0.2'  type: str
dry_run     -> 'false' type: str
```

`getfloat()` 和 `getboolean()` 可以显式转换，但文件格式本身没有给每个值统一定型。尤其不要这样写:

```python
bool(config["agent"]["dry_run"])
```

因为 `bool("false")` 仍然是 `True`。应该使用 Parser 提供的布尔转换 API，或者自己定义严格词汇表。

### Section、Key 大小写和重复项依赖实现

以 Python `ConfigParser` 默认行为为例:

- Section 名称区分大小写。
- Section 内的 Key 不区分大小写，并会规范成小写。
- `#` 和 `;` 可以开始整行注释。
- `=` 和 `:` 都能分隔 Key 与 Value。
- 读取多份文件时，后读文件的冲突值优先。

换一个 INI Parser，这些细节可能改变。INI 的核心优势是简单，核心风险也是没有足够统一的边界。

### 嵌套与 Array 都是应用协议

下面 3 种都有人使用:

```ini
[permissions]
read = true
```

```ini
permissions.read = true
```

```ini
[agent.permissions]
read = true
```

INI 本身没有告诉我们哪一种代表嵌套对象。逗号分隔也无法无歧义表达参数本身包含逗号的 Array:

```ini
args = --message, hello, world
```

这是 3 个参数，还是 `--message` 加上 `hello, world` 一个参数？只有应用知道。结构复杂到需要发明转义规则时，INI 已经不再简单，换 TOML、YAML 或 JSON 更省事。

### 我什么时候选 INI

INI 适合:

- 兼容已有工具或 Windows 风格配置。
- 配置本质上是少量分组后的 String Key/Value。
- 不需要深层嵌套、复杂 Array 或严格跨语言类型。

它不适合作为我从零设计的复杂 Agent 编排格式。两个 MCP Server 尚且能靠 Section 命名约定表达，等到 Server 还有环境变量、超时、权限和传输方式时，这套约定很快会长成一门没有规范的新语言。

## `.env`: 它解决密钥注入，不解决结构化配置

`.env` 文件通常是一行一个环境变量:

```dotenv
AGENT_API_KEY=replace-me
AGENT_BASE_URL=https://api.example.com
AGENT_TIMEOUT_SECONDS=30
AGENT_DEBUG=false
```

它最重要的特征不是扩展名，而是最终进入进程环境的 **String 到 String 映射**。`30` 和 `false` 仍然是 String，应用必须转换。

`.env` 生态也不是完全统一的规范。是否支持 `export`、单双引号、行尾注释、变量展开和多行 Value，取决于具体 Dotenv 实现。下面这些行为不能脱离 Loader 讨论:

```dotenv
export AGENT_MODE=review
ROOT=/work/demo
CACHE_DIR=${ROOT}/.cache
PASSWORD='pa$sword'
```

某些 Loader 会展开 `${ROOT}`，某些不会；某些会接受 `export`，某些只把它当作 Key 的一部分。Shell 能 `source .env` 也不代表 Dotenv Parser 与 Shell 语法完全相同。

### 不要把 `.env` 变成小型 YAML

我不会这样塞复杂数据:

```dotenv
AGENT_PERMISSIONS={"read":true,"write":false}
AGENT_TOOLS=read,search,browser
```

第一项变成嵌套 JSON，第二项发明逗号数组。现在一次配置要经过 Dotenv Parser、环境变量传递，再经过 JSON 或 CSV Parser。可以工作，但边界和错误信息都变差。

更清楚的分工是:

```toml
# config.toml, 可以提交
model = "reasoning-large"
api_key_env = "AGENT_API_KEY"

[permissions]
read = true
write = false
```

```dotenv
# .env.local, 不提交
AGENT_API_KEY=actual-secret-value
```

结构、默认值和权限放版本控制中的配置文件；密钥从环境、操作系统 Keychain 或 Secret Manager 注入。配置保存密钥的**名字**，不保存密钥本身。

> [!CAUTION]
> `.env` 不是保险箱，只是普通文本文件。把它加入 `.gitignore` 能降低误提交概率，不能防止本机其他进程、备份软件、Shell 历史或日志读取它。生产环境优先使用平台的 Secret Store，并限制 Agent 能读取和输出哪些环境变量。

## XML: 冗长，但结构和工具链都很成熟

XML 在新 Agent CLI 中不算主流，但 Maven、MSBuild、IDE、企业集成和许多旧系统仍大量使用。它用 Element、Attribute 和 Text 表达树:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<agent>
  <model>reasoning-large</model>
  <temperature>0.2</temperature>
  <dryRun>false</dryRun>
  <permissions read="true" write="false" network="false" />
  <mcpServers>
    <server name="docs" command="node">
      <arg>server.js</arg>
      <arg>--stdio</arg>
    </server>
  </mcpServers>
</agent>
```

XML 的问题不是不能表达，而是同一概念经常既能用 Attribute，也能用 Child Element:

```xml
<permission name="network" enabled="false" />
```

```xml
<permission>
  <name>network</name>
  <enabled>false</enabled>
</permission>
```

格式只提供机制，Schema 或应用约定才规定哪一种合法。XML Schema、XPath、Namespace 和成熟 Validator 是它的强项；标签闭合、实体转义和较高的文本体积是代价。

XML 中 `<` 和 `&` 等字符要转义:

```xml
<condition>tokens &lt; 1000 &amp;&amp; safe</condition>
```

处理不可信 XML 时还要防范外部实体、实体扩展和资源消耗问题。使用禁用外部实体与 DTD 的安全 Parser 配置，不要把任意 XML 交给默认全功能解析器。

我不会因为 XML 老就把它翻译成 YAML。消费工具原生要求 XML 时，保留 XML 通常最可靠。格式迁移只有在整个读写链路一起迁移时才有意义。

## JSONC、JSON5 与 JavaScript 配置不是一个东西

文件长得像 JSON，不代表它遵守 JSON RFC。

### JSONC

JSONC 通常表示允许 JavaScript 风格注释的 JSON:

```jsonc
{
  // 禁止 Agent 修改文件
  "write": false,
  "network": false
}
```

是否允许尾逗号仍由 Parser 选项决定。微软的 `jsonc-parser` 就把 `allowTrailingComma` 做成独立选项，所以 "支持注释" 不能推出 "支持尾逗号"。

### JSON5

JSON5 通常进一步允许单引号、裸 Key、尾逗号、十六进制数等:

```json5
{
  model: 'reasoning-large',
  tools: ['read', 'search'],
}
```

它更适合人手写，但标准 JSON Parser 不会接受。

### JavaScript 或 TypeScript 配置

可执行配置甚至可以计算值:

```javascript
export default {
  model: process.env.AGENT_MODEL ?? "reasoning-large",
  timeout: 10 * 1000,
  include: ["src", ...(process.env.CI ? ["tests"] : [])],
};
```

优点是组合、条件、变量和类型系统都现成。代价也非常具体:

- 加载配置等于执行代码。
- 静态分析与跨语言消费更困难。
- 配置结果依赖环境和执行时机。
- 不可信仓库中的配置可能直接成为代码执行入口。

当工具明确设计成加载代码配置时，我会用它的能力；当数据文件已经够用时，我不会为了少写 4 行复制而引入一台 JavaScript VM。

## Markdown: Agent Instructions 不是结构化 Settings

`AGENTS.md`、项目规则和 System Prompt 解决的是自然语言指令，而不是严格的运行时配置。Markdown 很适合表达:

```markdown
## Verification

- Read repository rules before editing.
- Run the narrowest command that exercises the changed behavior.
- Never print credentials.
```

但它不适合替代:

```toml
sandbox_mode = "workspace-write"
network_access = false
```

自然语言里的 "不要联网" 是模型要遵循的指令，Runtime 中的 `network_access = false` 是执行环境可以强制的能力边界。前者像门上的告示，后者像门锁。对安全属性，我两个都写，但绝不把告示当锁。

我现在把 Agent 定制分成 4 层:

| 层 | 适合的载体 | 例子 |
| --- | --- | --- |
| 行为指令 | Markdown | 编码风格、工作流、验证要求 |
| 结构化设置 | JSON/TOML/YAML | 模型、工具、超时、权限 |
| 敏感值 | Environment/Secret Store | API Key、Token、证书口令 |
| 强制策略 | Sandbox/Policy | 可写目录、网络、命令审批 |

这种分层避免了两个常见误区: 用自然语言假装权限隔离，以及把几百行团队规范塞进一个转义严重的 JSON String。

## 同一份数据，4 个 Parser 实际读一次

只对着代码块比较很容易产生一种虚假的掌控感，所以我真的解析了它们。实验环境是 Python 3.13.15 与 `yq 4.53.2`。

JSON 由 Python 标准库读取:

```python
import json

with open("agent.json", encoding="utf-8") as file:
    json_config = json.load(file)
```

TOML 由 Python 3.11 起进入标准库的 `tomllib` 读取:

```python
import tomllib

with open("agent.toml", "rb") as file:
    toml_config = tomllib.load(file)
```

YAML 用 `yq` 规范化成 JSON 后读取:

```bash
yq -o=json agent.yaml > agent-from-yaml.json
```

我最后比较 3 棵结构化数据树:

```python
assert json_config == toml_config == yaml_config
```

断言通过。也就是说，396 Bytes 的 JSON、334 Bytes 的 TOML 和 310 Bytes 的 YAML 最终表达了相同的 16 个叶子值。INI 没参加这个等价断言，因为 Array、对象数组和类型转换已经需要应用自定义协议。硬把它也转换成同一棵树，只会证明我写了一个 INI 方言，不会证明 INI 本身有这些语义。

实验数字汇总:

| 格式 | 行数 | UTF-8 Bytes | 相对 JSON |
| --- | ---: | ---: | ---: |
| JSON | 16 | 396 | 基准 |
| TOML | 20 | 334 | 少 15.7% |
| YAML | 18 | 310 | 少 21.7% |
| INI | 19 | 280 | 少 29.3%，但丢失原生结构 |

Bytes 不是选择配置格式的主要指标，毕竟 116 Bytes 还装不下一张很有说服力的猫图。它真正说明的是: 简洁有两种来源，一种是去掉冗余标点，另一种是把语义工作推给应用。前者通常很好，后者要计入复杂度。

## 语法正确之后，还有 Schema

假设这两份 JSON 都能解析:

```json
{
  "model": "reasoning-large",
  "temperature": 0.2,
  "permissions": {"read": true, "write": false}
}
```

```json
{
  "model": 42,
  "temperature": "cold",
  "permissions": ["everything"]
}
```

Parser 只会说两份都合法。JSON Schema 可以描述应用期待的结构:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["model", "permissions"],
  "additionalProperties": false,
  "properties": {
    "model": {"type": "string", "minLength": 1},
    "temperature": {"type": "number", "minimum": 0, "maximum": 2},
    "permissions": {
      "type": "object",
      "required": ["read", "write", "network"],
      "additionalProperties": false,
      "properties": {
        "read": {"type": "boolean"},
        "write": {"type": "boolean"},
        "network": {"type": "boolean"}
      }
    }
  }
}
```

Schema 能检查:

- 必填字段是否存在。
- Value 类型是否正确。
- Number 范围与 String Pattern。
- Array Item 的结构。
- 是否允许未知 Key。

但 Schema 通常不能完整回答这些语义问题:

- `workspace` 是否真的存在。
- `command` 是否能在当前机器执行。
- `write = true` 与当前 Sandbox 是否冲突。
- 两个 MCP Server 是否用了重复名称。
- 某个模型是否支持工具调用。

因此完整验证通常分两阶段: Schema 做结构检查，应用代码做语义检查。JSON Schema 本身虽然用 JSON 编写，但也常被拿来验证 YAML，因为 YAML 可以先加载成同样的 Mapping、Sequence 与 Scalar 树。关键是先固定 YAML 的类型解析规则。

### `additionalProperties` 要不要关

把 `additionalProperties` 设为 `false` 可以抓住拼写错误:

```yaml
permisions: # 少写了一个 s
  write: false
```

否则错误 Key 可能被静默忽略，用户以为权限已关闭，Agent 则按默认值运行。这对安全字段很危险。

代价是向前兼容性降低。旧 Validator 遇到新字段会拒绝配置。我会对安全敏感、内部控制的配置使用严格 Schema；对需要插件扩展的区域，则明确留出 `extensions` 或命名空间，而不是允许任意 Key 混在根节点。

## 覆盖顺序比文件格式更容易制造事故

现实 Agent 工具通常不只读一份文件。常见来源包括:

1. 内置默认值。
2. 系统或组织策略。
3. 用户级配置。
4. 项目级配置。
5. 本机未提交配置。
6. 环境变量。
7. 命令行参数。

但这个列表不是通用优先级。每个工具可以采用不同顺序，有些来源甚至禁止覆盖某些字段。例如 Codex 当前官方配置参考明确区分用户级 `~/.codex/config.toml` 与项目级 `.codex/config.toml`，并限制项目配置覆盖 Provider、通知与遥测等机器本地字段。这个限制来自 Loader 和安全策略，不来自 TOML。

### Scalar 覆盖容易，Mapping 与 Array 合并困难

假设用户配置是:

```yaml
permissions:
  read: true
  write: false
tools:
  - read
  - search
```

项目配置是:

```yaml
permissions:
  write: true
tools:
  - browser
```

至少存在 4 种合理策略:

1. **浅覆盖**: 整个 `permissions` 被项目对象替换，`read` 消失。
2. **深合并**: 只把 `write` 改成 `true`，保留 `read`。
3. **Array 替换**: `tools` 最后只有 `browser`。
4. **Array 追加**: `tools` 变成 `read`、`search`、`browser`。

格式没有规定答案。YAML Anchor、TOML Dotted Key 和 JSON Merge Patch 是不同机制，也不能自动代表工具的加载策略。

我在修改 Agent 配置前会先找 4 个信息:

- 文件搜索路径。
- 来源优先级。
- Object 是替换还是深合并。
- Array 是替换、追加还是按 ID 合并。

找不到官方说明时，我会做一个无害实验: 在低优先级配置中放唯一值，在高优先级配置中只覆盖一个兄弟字段，然后运行工具的 `config show`、诊断命令或最小启动路径观察最终值。不要拿网络和写权限当实验字段。

## 一份实际可维护的 Agent 配置应该怎样分层

我倾向于下面的目录布局:

```text
project/
├── AGENTS.md                 # 团队行为指令，可提交
├── .agent/
│   ├── config.toml           # 项目结构化设置，可提交
│   └── config.local.toml     # 本机覆盖，不提交
├── .env.example              # 环境变量名称与示例，可提交
├── .env.local                # 本地密钥，不提交
└── schemas/
    └── agent.schema.json     # 如果工具支持自定义 Schema
```

文件名只是示意，真实工具要求什么就用什么，不要为了统一外观擅自改名。

项目配置只放团队可共享且确定的内容:

```toml
model = "reasoning-large"
sandbox_mode = "workspace-write"

[permissions]
network = false

[verification]
commands = ["pnpm check", "pnpm build"]
```

本地覆盖放机器路径或个人偏好:

```toml
workspace = "/home/me/src/project"
editor = "nvim"
```

Secret 只通过名字引用:

```toml
[provider]
api_key_env = "AGENT_API_KEY"
```

自然语言规则留在 Markdown:

```markdown
## Editing

- Reuse existing repository conventions.
- Do not modify generated files by hand.
- Run the command that exercises the changed behavior.
```

这 4 类内容更新频率、读者和安全边界都不同。把它们拆开，不是为了多造文件，而是为了让 Git Diff、Secret 扫描、Schema 和 Agent 各自处理擅长的对象。

## 权限配置必须默认拒绝

Agent 和普通格式化工具不同，它可能执行 Shell、访问网络、读取整个 Home Directory 或修改仓库。配置格式的可读性在这里直接影响安全。

我会明确写出最小权限，而不是依赖版本升级后可能变化的默认值:

```toml
[permissions]
read_workspace = true
write_workspace = false
read_home = false
network = false
```

然后只在具体任务需要时扩大:

```toml
[profiles.implementation.permissions]
write_workspace = true
network = false
```

注意，这只是概念示例，不是某个具体工具的字段参考。实际 Key、Profile 语法与强制能力必须查工具官方文档。最重要的设计原则是:

- 权限字段使用 Boolean 或封闭 Enum，不用含糊 String。
- 未知权限值让启动失败，不静默回退到更宽权限。
- 项目配置不能放宽组织强制策略。
- 日志展示最终生效来源，但对 Secret 做脱敏。
- 权限提升需要显式、局部、可审计。

自然语言 Prompt 可以改善行为，Sandbox 才能限制能力。两者一起用，但不要混为一谈。

## 常见错误，我现在怎样定位

### 1. `Unexpected token` 或 `Expected comma`

这通常是 JSON 的引号、逗号或括号错误。先让 Parser 报准确行列:

```bash
jq empty config.json
```

不要从文件开头人工数括号。格式化器和 Parser 专门干这个。

### 2. TOML Key 跑进错误 Table

检查它前面最近的 `[table]` 或 `[[array_of_tables]]`。缩进不会把 Key 拉回根节点。可以用 Python 标准库打印解析结果:

```bash
python -c 'import pathlib,tomllib,pprint; pprint.pp(tomllib.loads(pathlib.Path("config.toml").read_text()))'
```

### 3. YAML `mapping values are not allowed here`

优先检查:

- 缩进层级是否一致。
- 是否混入 Tab。
- Plain Scalar 中是否出现 `: `。
- 上一行是否漏了 `-` 或 `:`。
- 多行 Block 是否缩进不足。

用 Parser 看结构，而不是只看语法高亮:

```bash
yq -o=json config.yaml
```

### 4. 值看起来对，类型却错

打印 Value 及其类型。典型错误包括:

- JSON 中把 `false` 写成 `"false"`。
- YAML 中把版本号解析成 Number。
- TOML 日期没加引号，变成 Date。
- INI 中把所有 String 当成自动带类型。

### 5. 配置合法但完全没生效

这通常不是格式问题。检查:

- 文件名和路径。
- 当前工作目录。
- 项目是否被工具标记为可信。
- Profile 是否真的选中。
- 更高优先级来源是否覆盖。
- 字段是否已弃用或只在特定版本支持。

### 6. Agent 启动后才报 MCP Server 失败

配置语法只证明 `command` 是 String、`args` 是 Array。还要检查:

- Executable 是否存在。
- 工作目录是否正确。
- 参数是否被拆成独立 Array Item。
- 环境变量是否传入。
- Transport 是 stdio、HTTP 还是其他方式。
- Server 是否向 stdout 打了破坏协议的日志。

这是语义验证，不是 Parser 能提前推断的内容。

## 一张够用的格式选择表

| 需求 | JSON | TOML | YAML | INI | `.env` | XML |
| --- | --- | --- | --- | --- | --- | --- |
| 跨语言数据交换 | 很强 | 强 | 强 | 弱 | 弱 | 很强 |
| 人工长期维护 | 一般 | 很强 | 强 | 简单场景强 | 仅少量变量 | 一般 |
| 标准注释 | 无 | 有 | 有 | 通常有 | 实现相关 | 有 |
| 原生嵌套 | 有 | 有 | 有 | 无统一方式 | 无 | 有 |
| 原生 Array | 有 | 有 | 有 | 无统一方式 | 无 | 有 |
| Null | 有 | 无 | 有 | 无统一方式 | 无 | 可通过 Schema 约定 |
| 日期时间类型 | 无 | 有 | Schema/Parser 相关 | 无 | 无 | Schema 相关 |
| 隐式类型风险 | 低 | 低 | 较高 | 值常为 String | 值为 String | 由 Schema 决定 |
| Schema 工具链 | 很强 | 可借助应用 Schema | 很强 | 分散 | 应用自检 | 很强 |
| 适合 Secret 本体 | 不适合 | 不适合 | 不适合 | 不适合 | 仅本地开发 | 不适合 |

我的实际决策顺序不是 "我喜欢哪种语法"，而是:

1. **消费工具要求什么格式？** 要求 JSON 就不要喂 TOML。
2. **官方示例和 Schema 使用什么版本与方言？** YAML 1.1 和 1.2、JSON 与 JSONC 不能混叫。
3. **文件主要由人写还是机器生成？** 人写偏 TOML/YAML，机器交换偏 JSON。
4. **结构有多深，对象数组有多少？** 平坦配置偏 TOML，深层清单偏 YAML/JSON。
5. **是否需要注释、多行 Prompt 或日期？** 这些会改变选择。
6. **如何验证、合并和保护 Secret？** 没有这一步，格式选得再漂亮也只是一份漂亮的风险。

## 我的保守写法

跨 Agent、跨 Parser 工作时，我尽量使用每种格式中最无聊的子集。

### JSON

- 所有 Key 与 String 使用双引号。
- 不写注释和尾逗号，除非工具明确声明 JSONC 方言。
- 不写重复 Key，不依赖 Object 顺序。
- 大整数 ID 写成 String。
- 区分缺失、`null` 和空 String。

### TOML

- Key 使用统一的 `snake_case`。
- 根 Key 放在第一个 Table Header 之前。
- 用 `[table]` 表示对象，用 `[[table]]` 表示对象数组。
- 路径和正则优先考虑 Literal String。
- 不重复定义 Key，不用不存在的 `null`。

### YAML

- 每层 2 个空格，禁止 Tab。
- Boolean 只写 `true` 和 `false`。
- 日期、版本、ID、通配符和可疑 Scalar 加引号。
- 多行 Prompt 明确选择 `|`、`>` 和 Chomping Indicator。
- 避免 Merge Key、自定义 Tag 和复杂 Anchor，除非目标工具明确支持。
- 用 Linter 拒绝重复 Key。

### INI 与 `.env`

- 假设所有 Value 都是 String，再显式转换。
- 不发明深层对象和复杂 Array 协议。
- 查清注释、引号、展开与覆盖行为属于哪个实现。
- Secret 不提交，示例文件只提交变量名称和安全占位值。

## 我会怎样配置一个新 Agent 工具

现在遇到新工具，我不会直接复制一份 300 行 "ultimate config"。我会按下面顺序建立配置:

1. 从官方最小示例启动，确认文件路径、格式版本和当前工具版本。
2. 先配置模型与只读工作区，让工具输出或表现出最终生效值。
3. 加入一个工具或 MCP Server，实际调用一次。
4. 显式关闭网络与写权限，再做一个应当被拒绝的无害操作。
5. 只对确实需要的 Profile 开放局部权限。
6. 把行为规则移到项目 Markdown，把 Secret 移到环境或 Secret Store。
7. 给配置加 Parser 检查、Schema 验证和 Secret 扫描。
8. 升级工具时先读配置变更，再让旧字段悄悄退休。

OpenAI Codex 当前使用 TOML 配置，并把用户级、项目级和 Profile 配置分开；其他工具可能使用 JSON、JSONC、YAML 或自己的组合。这个生态大概不会很快统一。我反而觉得真正可迁移的能力不是背住所有文件名，而是看见任何新格式时，立即问出同一组问题: 这是什么数据树，Scalar 怎样定型，Schema 在哪，来源怎样覆盖，最终权限由谁强制？

再往前看几年，我怀疑 Agent 配置会越来越像编译系统: 人写一层相对友好的源码，Schema 和 Policy 做静态检查，Loader 合并组织、项目与个人配置，Runtime 再把它编译成一个可审计的能力图。JSON、TOML 和 YAML 大概都不会赢得终局，它们只是不同的源语言。真正重要的产物，是 Agent 最后到底能看什么、能改什么、能调用什么。

我现在至少不会再因为 YAML 少了 86 Bytes 就宣布它 "更现代" 了。机器已经很聪明，配置文件不必跟着耍聪明。

## 参考资料

- [RFC 8259: The JavaScript Object Notation (JSON) Data Interchange Format](https://www.rfc-editor.org/rfc/rfc8259)
- [TOML v1.0.0 Specification](https://toml.io/en/v1.0.0)
- [YAML 1.2.2 Specification](https://yaml.org/spec/1.2.2/)
- [Python `json` Documentation](https://docs.python.org/3/library/json.html)
- [Python `tomllib` Documentation](https://docs.python.org/3/library/tomllib.html)
- [Python `configparser` Documentation](https://docs.python.org/3/library/configparser.html)
- [JSON Schema: What is a schema?](https://json-schema.org/understanding-json-schema/about)
- [Microsoft `jsonc-parser`](https://github.com/microsoft/node-jsonc-parser)
- [W3C XML 1.0 Fifth Edition](https://www.w3.org/TR/xml/)
- [OpenAI Codex Configuration Reference](https://developers.openai.com/codex/config-reference/)
- [Dotenv README](https://github.com/bkeepers/dotenv)
