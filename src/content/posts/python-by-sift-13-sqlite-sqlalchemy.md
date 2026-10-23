---
title: "数据库：sqlite3、FTS5 与 SQLAlchemy"
commentId: "post:python-by-sift-13-sqlite-sqlalchemy"
published: "2026-10-23 19:00:00 +08:00"
description: "用 Sift 重学 Python 第 13 篇：我用 Python 3.14.7、SQLite 3.53.3 和 SQLAlchemy 2.0.51 把 Sift 的文档表从 4.4 MB 的 docs.json 搬进 sift.db，先用 sqlite3 拆开事务、绑定和注入，再拿 FTS5 的 bm25() 给手写的 BM25 当对照，最后用 SQLAlchemy 的 Core 和 ORM 重写存储层；每条命令的进程耗时因此从约 280 毫秒涨到约 490 毫秒，我把这笔账拆开了。"
category: Tutorial
tags:
  - Python
  - Sift
  - SQLite
  - SQLAlchemy
  - ORM
  - SQL
series: "用 Sift 重学 Python"
seriesOrder: 13
draft: false
comment: true
slug: python-by-sift-13-sqlite-sqlalchemy
---

上一篇留下的尾巴是 `.sift/docs.json`：4.4 MB，每次 `sift search` 都要把它整个 `json.loads` 一遍，才能拿到 123 篇文章的标题和正文。这一篇我把它换成 `.sift/sift.db`，一个 SQLite 文件，顺手让每条 `sift search` 把自己记进同一个文件，再让 `sift stats` 读出来。结果比我预想的无聊（文件只小了 0.45%），也比我预想的贵（每条命令慢了 0.2 秒），原因我要到最后才能说清楚：

```text
$ rm -rf .sift
$ sift index
documents: 123
vocabulary: 81167
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 3076.4 ms
$ sift search --limit 1 kalman | tail -1
8 hits in 123 files: index opened in 134.0 ms, query took 6.947 ms
$ sift search "device tree" | tail -1
4 hits in 123 files: index opened in 132.8 ms, query took 32.069 ms
$ sift stats | tail -3
last 2 queries:
2026-10-23 12:54:23 UTC      4 hits    32.069 ms  device tree
2026-10-23 12:54:22 UTC      8 hits     6.947 ms  kalman
$ wc -c .sift/*
  22080 .sift/manifest.json
2880196 .sift/segment.sft
4378624 .sift/sift.db
7280900 total
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch13`：新增 `src/sift/storage/db.py` 和 `tests/test_db.py`，以及 `lab/ch13` 下 9 个脚本；改动了 `src/sift/storage/store.py`（`docs.json` 换成数据库）、`src/sift/cli.py`（查询日志和 `sift stats`）、`src/sift/storage/segment.py`（一行文档注释）、`pyproject.toml`（依赖 `sqlalchemy>=2.0.51`）、`README.md` 和两个已有的测试文件。`make ch13` 通过。`db.py` 的三张表到第 22 篇画图时还会被读，不会再变；`store.py` 和 `cli.py` 还会随着并行索引和 typer 改写继续动。
> 涉及的 Python 特性：DB-API 2.0 (PEP 249) 和 `sqlite3` 的方方面面（游标、绑定、`sqlite3.Row`、事务模式、`autocommit` 属性、适配器）、SQL 注入、SQLite 的动态类型和 `EXPLAIN QUERY PLAN`、FTS5 和 `bm25()`、SQLAlchemy 2.0 的 Core 与 ORM（`DeclarativeBase`、`Mapped`、`mapped_column`、`TypeDecorator`、`Session`、工作单元、身份映射、`selectinload`、`raiseload`）、Alembic（只讲不做）。
> 前置：[第 12 篇](/posts/python-by-sift-12-files-binary-format/)，需要知道索引目录里有哪几个文件、为什么清单最后写。

字节数差得不多，所以重点不在体积。文档住进数据库以后，Python 里有两层东西可以拆：标准库的 `sqlite3` 是个薄薄的 C 封装，SQLAlchemy 在它上面又盖了两层。我想知道每一层替我做了什么，又悄悄收了什么费。

我先从最底下说起：`sqlite3` 到底实现了 PEP 249 的哪些部分，一条 `INSERT` 在 Python 里什么时候才真的开始事务，这个答案比我想的更依赖语句的第一个单词。然后是注入，以及为什么占位符不能代替表名。接下来是 Sift 自己的三张表和 `replace_documents` 的那个事务，再接下来是 FTS5：它也是个倒排索引，排序也用 BM25，我想知道它的前十名和我手写的那个有多少重合。最后是 SQLAlchemy 的 Core、ORM、会话和加载策略，以及这一层的账单。

## 环境

和前几篇同一台机器，仓库在标签 `ch13`，命令都在 `nix develop` 里、仓库根目录 `~/Projects/sift` 下跑：

```text
$ uname -r; python3 -VV; git describe --tags
6.18.57
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
ch13
$ python3 -c 'import sqlite3, sqlalchemy; \
    print(sqlite3.sqlite_version, sqlalchemy.__version__)'
3.53.3 2.0.51
$ sqlite3 --version | cut -c1-6
3.53.3
```

这台机器的 CPU 有快慢两个状态（前几篇测到过差约 2.5 倍），所以每个计时脚本都让对手轮流跑，并且在前后各跑一遍上一篇的 `cpu_state.py`（一个固定的忙循环，快状态下 5 个数都在 110 到 120 ms 之间）。这一篇贴出的每一组计时，前后两次都落在快状态里；我没有在慢状态下重跑，所以绝对值在慢状态下会偏大，比例才可信。输出里的家目录缩写成 `~`；临时脚本放在 `/tmp/sift-scratch/`，不进仓库，整份贴出，每一份都满足 79 列和 `ruff` 的检查。

## sqlite3：一份只有几十个名字的合同

Python 访问关系数据库的方式，二十多年前就被 PEP 249 (DB-API 2.0) 固定下来了：一个模块，三个全局变量，一个 `connect()`，连接上有 `cursor()`、`commit()`、`rollback()`、`close()`，游标上有 `execute()`、`executemany()`、`fetchone()`、`fetchmany()`、`fetchall()` 和 `description`，再加上一棵固定形状的异常树。`sqlite3`、`psycopg`、`mysqlclient` 都长这样，所以 SQLAlchemy 这种上层库才能只靠换一个驱动就换一种数据库。

`lab/ch13/sqlite3_basics.py` 的第一部分把这份合同的三个全局变量打印出来，然后建表、插入、取回：

```python
def show_module() -> None:
    """Print the DB-API 2.0 module globals and the library versions."""
    print("apilevel     :", sqlite3.apilevel)
    print("paramstyle   :", sqlite3.paramstyle)
    print("threadsafety :", sqlite3.threadsafety)
    print("sqlite       :", sqlite3.sqlite_version)


# ...


def basics(conn: sqlite3.Connection) -> None:
    """Create a table, insert with executemany, fetch three ways."""
    cur = conn.cursor()
    cur.execute("CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT)")
    rows = [("kalman",), ("rust",), ("typst",), ("sqlite",)]
    cur.executemany("INSERT INTO post (title) VALUES (?)", rows)
    print("rowcount     :", cur.rowcount, " lastrowid:", cur.lastrowid)
    cur.execute("SELECT id, title FROM post ORDER BY id")
    print("fetchone     :", cur.fetchone())
    print("fetchmany(2) :", cur.fetchmany(2))
    print("fetchall     :", cur.fetchall())
    print("description  :", [c[0] for c in cur.description])
    # named parameters take a dict, qmark ones a sequence
    cur.execute("SELECT title FROM post WHERE id = :id", {"id": 2})
    print("named bind   :", cur.fetchone())
    # a placeholder is a value, never a table or column name
    try:
        cur.execute("SELECT title FROM ? WHERE id = 1", ("post",))
    except sqlite3.OperationalError as error:
        print("table as ?   :", type(error).__name__, error)
    # wrong number of bindings
    try:
        cur.execute("SELECT title FROM post WHERE id = ?", (1, 2))
    except sqlite3.ProgrammingError as error:
        print("2 for 1 ?    :", type(error).__name__, error)
```

```text
$ python3 lab/ch13/sqlite3_basics.py | sed -n 1,13p
apilevel     : 2.0
paramstyle   : qmark
threadsafety : 3
sqlite       : 3.53.3

rowcount     : 4  lastrowid: 0
fetchone     : (1, 'kalman')
fetchmany(2) : [(2, 'rust'), (3, 'typst')]
fetchall     : [(4, 'sqlite')]
description  : ['id', 'title']
named bind   : ('rust',)
table as ?   : OperationalError near "?": syntax error
2 for 1 ?    : ProgrammingError Incorrect number of bindings supplied. The current statement uses 1, and there are 2 supplied.
```

`apilevel` 是 `"2.0"`；`paramstyle` 是 `qmark`，也就是 `?` 占位符（SQLite 同时接受 `:name`，所以脚本里 `WHERE id = :id` 配一个字典也能跑）。`threadsafety` 是 3，这个数不是 `sqlite3` 自己定的：CPython v3.14.7 的 `Modules/_sqlite/module.c` 第 519 到 539 行把 SQLite 编译时的 `SQLITE_THREADSAFE` 翻译成 PEP 249 的级别，序列化模式 (`1`) 对应 3，多线程模式 (`2`) 对应 1，单线程模式 (`0`) 对应 0。这个数说的是库，不是你的连接：同一个连接要不要跨线程用，另有一个 `check_same_thread` 参数管，我这一篇没有测它。

输出里有三处值得停一下。

第一处，`rowcount: 4  lastrowid: 0`。`executemany` 插了 4 行，`rowcount` 对；`lastrowid` 却是 0，不是第 4 行的 id。`Modules/_sqlite/cursor.c` (v3.14.7) 第 951 到 960 行：只有 `!multiple` 的时候，也就是单条 `execute`，才去问 `sqlite3_last_insert_rowid`。那个 0 是前一条 `CREATE TABLE` 留下来的。想要最后一行的 id，要么单条 `execute`，要么用 `RETURNING`（SQLite 3.35 起支持）。

第二处，`table as ?`：占位符是**值**的位置，不是标识符的位置。`SELECT title FROM ? ...` 在 `prepare` 阶段就是语法错误，连参数都还没轮到绑定。这个限制是后面注入那一节的关键。

第三处，`2 for 1 ?`：绑定的个数不对，抛的是 `ProgrammingError`，不是 `OperationalError`；异常树里这两个都是 `DatabaseError` 的子类，下面会打印出来。

### 行不一定是元组

默认的游标把一行返回成元组，`sqlite3.Row` 把它换成既能按下标、又能按列名取值的对象，`row_factory` 是连接上的一个普通属性：

```python
def row_factory() -> None:
    """Show tuples against sqlite3.Row."""
    # ...
    plain = conn.execute("SELECT a, b FROM t").fetchone()
    print("tuple        :", plain)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT a, b AS letter FROM t").fetchone()
    print("Row          :", tuple(row), row.keys(), row["letter"], row[0])
    print("dict(Row)    :", dict(row))
```

```text
$ python3 lab/ch13/sqlite3_basics.py | sed -n 15,17p
tuple        : (1, 'x')
Row          : (1, 'x') ['a', 'letter'] x 1
dict(Row)    : {'a': 1, 'letter': 'x'}
```

`Row` 不是 `dict`，没有 `.items()`，但 `keys()` 和 `dict(row)` 都能用。`b AS letter` 的别名就是键，这是我给 SQL 里的列取别名时最实用的一个理由。

### 注入：占位符为什么安全

`lab/ch13/sql_injection.py` 里有同一个查询的两种写法，第一种用 f-string 拼，第二种用 `?`：

```python
def formatted(conn: sqlite3.Connection, owner: str) -> list[tuple]:
    """Build the query with an f-string, the way not to."""
    sql = (
        f"SELECT body FROM notes WHERE owner = '{owner}' "  # BAD
        "AND kind = 'public'"
    )
    print("   sql:", sql)
    return conn.execute(sql).fetchall()


def bound(conn: sqlite3.Connection, owner: str) -> list[tuple]:
    """Good: the driver sends owner as a value, never as SQL."""
    sql = "SELECT body FROM notes WHERE owner = ? AND kind = 'public'"
    return conn.execute(sql, (owner,)).fetchall()
```

第一个函数的 f-string 那一行带着 `# BAD` 注释。输入是 `alice` 的时候，两个函数都只返回 alice 的公开笔记；输入换成 `x' OR 1=1 --`，第一个函数就把三个人的笔记全交了出来。这个脚本还试了 `STACKED`，也就是 `x'; DROP TABLE notes; --`：

```text
$ python3 lab/ch13/sql_injection.py
input 'alice'
   sql: SELECT body FROM notes WHERE owner = 'alice' AND kind = 'public'
   formatted -> [('hello',)]
   bound     -> [('hello',)]
input "x' OR 1=1 --"
   sql: SELECT body FROM notes WHERE owner = 'x' OR 1=1 --' AND kind = 'public'
   formatted -> [('hello',), ("alice's diary",), ("bob's password is hunter2",)]
   bound     -> []

a comment cuts the rest of the query off
   sql: SELECT body FROM notes WHERE owner = 'bob' --' AND kind = 'public'
   formatted -> [("bob's password is hunter2",)]
   bound     -> []

input "x'; DROP TABLE notes; --"
   sql: SELECT body FROM notes WHERE owner = 'x'; DROP TABLE notes; --' AND kind = 'public'
   execute     -> ProgrammingError You can only execute one statement at a time.
   executescript -> no such table: notes
```

注意几件事。`formatted` 打印出来的 SQL 里，`OR 1=1` 是语句结构的一部分，`--` 把原来语句后面的 `AND kind = 'public'` 注释掉了，这就是“拼出来的字符串”和“绑定的值”的区别：前者进入了 SQL 的**语法**，后者只进入**数据**。`bound` 一版给出 `[]`，因为数据库里确实没有一个叫 `x' OR 1=1 --` 的用户。

第二件事，`execute` 拒绝了堆叠语句。`Modules/_sqlite/statement.c` (v3.14.7) 第 69 到 73 行：`sqlite3_prepare_v2` 编译完第一条语句后，如果 `tail`（没编译的剩余部分）里还有非空白内容，就抛 `You can only execute one statement at a time.`。这是 `sqlite3` 模块的一道保险。但 `executescript` 不受它限制，脚本的最后三行就是演示：拼出来的 `executescript` 真的把 `notes` 表删了，下一条查询报 `no such table: notes`。

第三件事：既然占位符不能代表表名或列名，需要动态标识符怎么办？我的做法是白名单：把允许的名字写成一个常量集合，`name in ALLOWED` 才拼进字符串。绝不能用“转义”代替白名单；SQLAlchemy 的 Core 把标识符做成 `Table` 和 `Column` 对象，这个问题也就不存在了，下面会看到。

### 抽屉里的杂物：异常、类型和 PRAGMA

`sqlite3` 里还有几样东西，不属于任何一个大主题，但都踩过我一次。我写了一个小脚本把它们放在一起：

```python
"""Poke at SQLite from Python: exceptions, typing and pragmas."""

import sqlite3


def exceptions() -> None:
    """Print the DB-API exception tree as sqlite3 implements it."""
    names = (
        "Warning Error InterfaceError DatabaseError DataError "
        "OperationalError IntegrityError InternalError ProgrammingError "
        "NotSupportedError"
    )
    for name in names.split():
        bases = [base.__name__ for base in getattr(sqlite3, name).__bases__]
        print(f"{name:<18} {bases}")


def typing_rules(conn: sqlite3.Connection) -> None:
    """A column type is an affinity, not a promise; STRICT keeps it."""
    conn.execute("CREATE TABLE loose (n INTEGER)")
    conn.execute("CREATE TABLE tight (n INTEGER) STRICT")
    for value in (7, "7", "seven", 7.5, None, b"\x00\x01"):
        conn.execute("INSERT INTO loose VALUES (?)", (value,))
    rows = conn.execute("SELECT n, typeof(n) FROM loose").fetchall()
    print("loose :", rows)
    try:
        conn.execute("INSERT INTO tight VALUES (?)", ("seven",))
    except sqlite3.IntegrityError as error:
        print("strict:", error)


def foreign_keys(conn: sqlite3.Connection) -> None:
    """Foreign keys are off by default, and a PRAGMA can be a no-op."""
    conn.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
    conn.execute("CREATE TABLE child (p INTEGER REFERENCES parent (id))")
    conn.execute("INSERT INTO child VALUES (99)")
    print("orphan row accepted, in_transaction:", conn.in_transaction)
    conn.execute("PRAGMA foreign_keys = ON")
    print(
        "inside a transaction:", conn.execute("PRAGMA foreign_keys").fetchone()
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    print(
        "after commit        :", conn.execute("PRAGMA foreign_keys").fetchone()
    )
    try:
        conn.execute("INSERT INTO child VALUES (98)")
    except sqlite3.IntegrityError as error:
        print("second orphan       :", error)


def main() -> None:
    """Run the sections on an in-memory database each."""
    exceptions()
    for section in (typing_rules, foreign_keys):
        conn = sqlite3.connect(":memory:")
        section(conn)
        conn.close()


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/sqlite_extras.py
Warning            ['Exception']
Error              ['Exception']
InterfaceError     ['Error']
DatabaseError      ['Error']
DataError          ['DatabaseError']
OperationalError   ['DatabaseError']
IntegrityError     ['DatabaseError']
InternalError      ['DatabaseError']
ProgrammingError   ['DatabaseError']
NotSupportedError  ['DatabaseError']
loose : [(7, 'integer'), (7, 'integer'), ('seven', 'text'), (7.5, 'real'), (None, 'null'), (b'\x00\x01', 'blob')]
strict: cannot store TEXT value in INTEGER column tight.n
orphan row accepted, in_transaction: True
inside a transaction: (0,)
after commit        : (1,)
second orphan       : FOREIGN KEY constraint failed
```

异常树就是 PEP 249 规定的那一棵，`sqlite3.Error` 之下分 `InterfaceError` 和 `DatabaseError`，后者再分六种。记住 `IntegrityError` 是约束违反（唯一键、非空、外键），`OperationalError` 是数据库本身出了问题（锁、语法、文件打不开）；我在 Sift 里捕获的是它们的共同父类。

类型那一段是 SQLite 和别的数据库最不一样的地方：`INTEGER` 只是一个**亲和性**，不是约束。`loose` 表里写进去了整数 7、字符串 `'7'`（被转成整数 7）、字符串 `'seven'`（留作文本）、浮点数、`NULL` 和二进制，`typeof(n)` 逐行证明了它们的真实类型。想要别的数据库那种严格，建表时加 `STRICT`（SQLite 3.37 起支持），上面最后一次插入就被拒绝了。

最后一段是 `PRAGMA foreign_keys`：SQLite 默认不检查外键，要在每条连接上自己打开，而且 **在事务里这条 PRAGMA 是空操作**。输出里的 `inside a transaction: (0,)` 就是它没生效的证据：前面的 `INSERT` 已经让 `sqlite3` 开了事务（下一节解释为什么），`PRAGMA` 悄悄无效，也没有报错；提交之后再设一次，才变成 `(1,)`，孤儿行才被拒绝。

### 日期：3.12 弃用的默认适配器

`sqlite3` 还能自动把 Python 对象转成 SQLite 的值，这叫适配器 (adapter)。`datetime` 以前有默认的适配器，3.12 起弃用了：

```python
def default_adapter() -> None:
    """Bind a datetime with no adapter registered: 3.12 warns."""
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE t (at TEXT)")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        conn.execute("INSERT INTO t VALUES (?)", (WHEN,))
    for w in caught:
        print(f"{w.category.__name__}: {w.message}")
    print("stored       :", conn.execute("SELECT at FROM t").fetchone())
    conn.close()


# ...


def register_your_own() -> None:
    """register_adapter and register_converter, as the docs recipe."""
    sqlite3.register_adapter(datetime, lambda dt: dt.isoformat())
    sqlite3.register_converter(
        "timestamp", lambda raw: datetime.fromisoformat(raw.decode())
    )
    conn = sqlite3.connect(":memory:", detect_types=sqlite3.PARSE_DECLTYPES)
    conn.execute("CREATE TABLE t (at timestamp)")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        conn.execute("INSERT INTO t VALUES (?)", (WHEN,))
    print("warnings     :", len(caught))
    (value,) = conn.execute("SELECT at FROM t").fetchone()
    print("round trip   :", repr(value), value == WHEN)
    conn.close()
```

```text
$ python3 lab/ch13/adapters.py
default adapter (deprecated since 3.12)
DeprecationWarning: The default datetime adapter is deprecated as of Python 3.12; see the sqlite3 documentation for suggested replacement recipes
stored       : ('2026-10-23 08:30:00+00:00',)

explicit conversion
by hand      : 2026-10-23T08:30:00+00:00 -> True

your own adapter and converter
warnings     : 0
round trip   : datetime.datetime(2026, 10, 23, 8, 30, tzinfo=datetime.timezone.utc) True
```

默认适配器存的是 `2026-10-23 08:30:00+00:00`（日期和时间之间是**空格**），而 `isoformat()` 存的是带 `T` 的版本，两种写法在同一列里混着出现，字符串排序就不再等于时间排序。我没有查到官方弃用的原话，猜这是原因之一。文档的建议是“自己注册适配器和转换器”，脚本最后一段 (`register_your_own`) 照着做了，没有警告，往返也相等。不过注册是**全局**的：`sqlite3.register_adapter` 改的是整个进程里所有 `datetime` 的绑定。Sift 不用这个办法，原因在 SQLAlchemy 那一节。

### 事务：`BEGIN` 是什么时候发的

`sqlite3` 的事务模型有几种，我写了一个脚本，让它们各自把真正发给 SQLite 的语句打印出来 (`set_trace_callback`)：

```python
"""Trace the statements sqlite3 sends in each transaction mode."""

import sqlite3


def run(label: str, **options: object) -> None:
    """Connect with options and trace a CREATE, an INSERT and a SELECT."""
    print(label)
    conn = sqlite3.connect(":memory:", **options)
    conn.set_trace_callback(lambda sql: print("   >", sql))
    conn.execute("CREATE TABLE t (n INTEGER)")
    conn.execute("INSERT INTO t VALUES (1)")
    conn.execute("SELECT n FROM t").fetchall()
    print("   in_transaction:", conn.in_transaction)
    conn.commit()
    conn.close()


def sniffing() -> None:
    """Legacy mode decides from the first word whether to BEGIN."""
    cases = {
        "INSERT": "INSERT INTO t SELECT 1",
        "comment + INSERT": "/* hi */ INSERT INTO t SELECT 1",
        "WITH ... INSERT": (
            "WITH v(x) AS (SELECT 1) INSERT INTO t SELECT x FROM v"
        ),
    }
    for label, sql in cases.items():
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE t (n INTEGER)")
        conn.execute(sql)
        began = conn.in_transaction
        conn.rollback()
        rows = conn.execute("SELECT count(*) FROM t").fetchone()[0]
        print(f"{label:<17} BEGIN: {began!s:<5} rows after rollback: {rows}")
        conn.close()


def main() -> None:
    """Run each mode, then the statement sniffing test."""
    run("legacy (the default)")
    run("isolation_level='IMMEDIATE'", isolation_level="IMMEDIATE")
    run("autocommit=False", autocommit=False)
    run("autocommit=True", autocommit=True)
    sniffing()


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/trace_txn.py
legacy (the default)
   > CREATE TABLE t (n INTEGER)
   > BEGIN
   > INSERT INTO t VALUES (1)
   > SELECT n FROM t
   in_transaction: True
   > COMMIT
isolation_level='IMMEDIATE'
   > CREATE TABLE t (n INTEGER)
   > BEGIN IMMEDIATE
   > INSERT INTO t VALUES (1)
   > SELECT n FROM t
   in_transaction: True
   > COMMIT
autocommit=False
   > CREATE TABLE t (n INTEGER)
   > INSERT INTO t VALUES (1)
   > SELECT n FROM t
   in_transaction: True
   > COMMIT
   > BEGIN
   > ROLLBACK
autocommit=True
   > CREATE TABLE t (n INTEGER)
   > INSERT INTO t VALUES (1)
   > SELECT n FROM t
   in_transaction: False
INSERT            BEGIN: True  rows after rollback: 0
comment + INSERT  BEGIN: True  rows after rollback: 0
WITH ... INSERT   BEGIN: False rows after rollback: 1
```

**默认的模式**（`autocommit` 是 `LEGACY_TRANSACTION_CONTROL`，`isolation_level` 是 `""`）：`CREATE TABLE` 不开事务，`INSERT` 之前才发一条 `BEGIN`，`SELECT` 不开。`Modules/_sqlite/cursor.c` (v3.14.7) 第 867 到 877 行说得很清楚：`autocommit` 是旧模式、`isolation_level` 不是 `None`、语句是 DML、并且当前不在事务里，才调 `begin_transaction`。那个“是 DML”是怎么判定的，在 `statement.c` 第 75 到 84 行：

```c
    /* Determine if the statement is a DML statement.
       SELECT is the only exception. See #9924. */
    int is_dml = 0;
    const char *p = lstrip_sql(sql_cstr);
    if (p != NULL) {
        is_dml = (PyOS_strnicmp(p, "insert", 6) == 0)
                  || (PyOS_strnicmp(p, "update", 6) == 0)
                  || (PyOS_strnicmp(p, "delete", 6) == 0)
                  || (PyOS_strnicmp(p, "replace", 7) == 0);
    }
```

也就是看**第一个单词**，跳过空白和注释。脚本里的 `sniffing()` 验证了后果：`INSERT` 和 `/* hi */ INSERT` 都开了事务，`rollback()` 之后表是空的；`WITH v(x) AS (...) INSERT ...` 的第一个单词是 `WITH`，没有开事务，语句立刻自动提交，`rollback()` 撤销不了，表里还剩一行。Sift 里没有这种语句，但习惯用 CTE 开头的人，这条规则会在一个安静的下午咬你一口。

**`isolation_level="IMMEDIATE"`** 只把 `BEGIN` 换成 `BEGIN IMMEDIATE`：写锁在事务一开始就拿，而不是等到第一次写。输出里看得到这一行；两个连接怎么抢锁，我没有在这里演示。

**`autocommit=False`**（3.12 新增）是 PEP 249 的本意：连接创建的时候就开着一个事务，`commit()` 之后立刻开下一个。输出里看得到 `COMMIT` 后面跟着 `BEGIN`，最后 `close()` 时是一条 `ROLLBACK`（连接创建时的第一条 `BEGIN` 发在我设置回调之前，所以看不到）。`autocommit=True` 则什么事务都不自动开。`Modules/_sqlite/connection.c` 第 2657 到 2699 行是这个属性的读写，旧模式下读出来是常量 `LEGACY_TRANSACTION_CONTROL`，也就是 `-1`。

实验室里的 `transactions()` 看 `with conn`：

```python
def transactions() -> None:
    """Commit and roll back with ``with conn``, legacy mode."""
    conn = sqlite3.connect(":memory:")
    print("isolation    :", repr(conn.isolation_level))
    print("autocommit   :", conn.autocommit, "(LEGACY_TRANSACTION_CONTROL)")
    conn.execute("CREATE TABLE t (n INTEGER PRIMARY KEY)")
    with conn:  # commits when the block ends
        conn.execute("INSERT INTO t VALUES (1)")
    print("in_transaction after with:", conn.in_transaction)
    try:
        with conn:  # rolls back when the block raises
            conn.execute("INSERT INTO t VALUES (2)")
            print("in_transaction inside   :", conn.in_transaction)
            conn.execute("INSERT INTO t VALUES (1)")  # duplicate key
    except sqlite3.IntegrityError as error:
        print("rolled back  :", error)
    print("rows         :", conn.execute("SELECT n FROM t").fetchall())
    # ``with conn`` does not close the connection
    conn.execute("SELECT 1")
    conn.close()
```

```text
$ python3 lab/ch13/sqlite3_basics.py | sed -n 19,24p
isolation    : ''
autocommit   : -1 (LEGACY_TRANSACTION_CONTROL)
in_transaction after with: False
in_transaction inside   : True
rolled back  : UNIQUE constraint failed: t.n
rows         : [(1,)]
```

`with conn` 的语义是**提交或回滚**，不是**关闭**：块里有异常就 `rollback`，没有就 `commit`，连接还活着（脚本最后还能在 `conn` 上执行 `SELECT 1`）。它和 `with open(...)` 长得一样（这大概是 `sqlite3` 里最无辜的一个陷阱），意思完全不同。要关闭连接，写 `contextlib.closing(conn)`，或者自己调 `close()`。

还有一个小例外：`executescript` 会先发一条 `COMMIT`（`cursor.c` 第 1046 到 1060 行，`// Commit if needed`），然后才执行脚本。拿它在事务中间跑 DDL，你的未提交修改就悄悄提交了。

## sift.db 里有什么

先看文件，再看生成它的代码。`sqlite3` 命令行在 flake 里，`.schema` 把三张表的 `CREATE TABLE` 原样打印出来（我用 `sed` 去掉行尾空格，`expand` 把制表符换成空格）：

```text
$ sqlite3 .sift/sift.db .schema | sed 's/ *$//' | expand -t4
CREATE TABLE documents (
    doc_id INTEGER NOT NULL,
    path VARCHAR NOT NULL,
    title VARCHAR NOT NULL,
    published VARCHAR NOT NULL,
    updated VARCHAR,
    category VARCHAR,
    series VARCHAR,
    tags JSON NOT NULL,
    body VARCHAR NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    PRIMARY KEY (doc_id)
);
CREATE TABLE meta (
    "key" VARCHAR NOT NULL,
    value VARCHAR NOT NULL,
    PRIMARY KEY ("key")
);
CREATE TABLE query_log (
    id INTEGER NOT NULL,
    at DATETIME NOT NULL,
    "query" VARCHAR NOT NULL,
    total INTEGER NOT NULL,
    took_ms FLOAT NOT NULL,
    PRIMARY KEY (id)
);
$ sqlite3 .sift/sift.db 'PRAGMA page_size; PRAGMA page_count'
4096
1069
```

`documents` 就是上一篇 `docs.json` 里那个数组，一篇文章一行，`tags` 是 JSON 文本，`body` 是整个剥掉 Markdown 的正文。`meta` 是一个键值表，目前只存一个键，`pipeline`，也就是建这个索引时用的分析器名字 (`["mixed", "nfkc", "stopwords"]`)，`sift index` 靠它判断“分析器变了，得整个重建”。`query_log` 是这一章新增的，每次 `sift search` 追加一行。

这三张表没有放的东西更有意思：倒排表，它仍然在 `segment.sft` 里。理由写在 `db.py` 的模块文档里：词典和倒排块是按字节偏移整块读的，从不按列查询，放进表里只会多出一个 B 树。我必须老实说，这个理由我没有实验验证（没有把上一篇数过的 289,357 条 posting 倒进一张表再量），它是设计判断，不是测量结果。清单 `manifest.json` 也留在 JSON 里，理由同一处：它最后写、整个原子替换，所以它同时是一次更新的**提交记录**；段文件写完而数据库还没写完的时候崩了，旧清单还在，下一次 `sift index` 会重做。

文件有多大，是这一章第一个我预想错的数字：

```text
$ rm -rf /tmp/sift-ch12 && mkdir /tmp/sift-ch12
$ git archive ch12 | tar -x -C /tmp/sift-ch12 && \
    ln -s $PWD/corpus /tmp/sift-ch12/corpus
$ (cd /tmp/sift-ch12 && PYTHONPATH=src python3 -m sift index | tail -1)
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 3082.0 ms
$ wc -c /tmp/sift-ch12/.sift/docs.json .sift/sift.db
4398409 /tmp/sift-ch12/.sift/docs.json
4378624 .sift/sift.db
8777033 total
```

`docs.json` 是 4,398,409 字节，`sift.db` 是 4,378,624 字节，只小了 19,785 字节，0.45%。原因是两边装的是同一份东西，而这份东西几乎全是正文：

```text
$ sqlite3 .sift/sift.db 'SELECT count(*), sum(length(CAST(body AS BLOB))) FROM documents'
123|4234896
```

123 篇正文占 4,234,896 字节（UTF-8 字节数，不是字符数），是 `sift.db` 的 96.7%。SQLite 的文件由 4096 字节的页组成 (`PRAGMA page_size`)，上面的 `schema` 转录里 `page_count` 是 1069，1069 × 4096 正好是 4,378,624。JSON 版本多出来的那 19 KB 大概是每个文档重复写一遍的键名和转义，不过我没有拆开数过。所以如果有人跟你说“换成数据库会让文件变小”，在这样的数据上可以怀疑一下。

换成数据库换来的是别的：能用 SQL 回答 JSON 文件没法直接回答的问题。比如 `tags` 虽然存成 JSON 文本，SQLite 自带的 `json_each` 能把它展开成行：

```text
$ sqlite3 .sift/sift.db "SELECT j.value, count(*)
    FROM documents, json_each(tags) AS j
    GROUP BY j.value ORDER BY 2 DESC, 1 LIMIT 3"
线性代数|36
MIT 18.06|35
NumPy|35
```

这个查询不需要把 4 MB 读进 Python；同样的问题用 `docs.json` 只能整个读进来再自己数。

## FTS5：SQLite 里的另一个倒排索引

`sqlite3` 这一节的实验室做完以后，我一直想做的是另一件事：SQLite 自己就带一个全文检索引擎，扩展名叫 FTS5。它做的事情和 Sift 一样：把文本切成词，建倒排索引，`MATCH` 查询，`bm25()` 排序，`snippet()` 出片段。用的是同一份语料，写的是 C，我得知道它的前十名和我手写的这个到底有多像。

`lab/ch13/fts5_compare.py` 在一个临时目录里建两个 FTS5 表，分词器一个是 `unicode61`，一个是 `trigram`，灌进同一批文档，再把 `bench/queries.txt` 的 12 条查询各跑一遍：

```python
def build_fts(
    conn: sqlite3.Connection,
    name: str,
    tokenizer: str,
    docs: list[Document],
) -> bool:
    """Create and fill an FTS5 table; return False if SQLite lacks it."""
    try:
        conn.execute(
            f"CREATE VIRTUAL TABLE {name} USING fts5("
            f"title, body, tags, tokenize='{tokenizer}')"
        )
    except sqlite3.OperationalError as error:
        print(f"{name}: unavailable: {error}")
        return False
    conn.executemany(
        f"INSERT INTO {name} (rowid, title, body, tags) VALUES (?, ?, ?, ?)",
        [(d.doc_id, d.title, d.body, " ".join(d.tags)) for d in docs],
    )
    return True


# ...


def fts_top(conn: sqlite3.Connection, name: str, match: str) -> list[int]:
    """Return the doc ids of the top-10 hits, with a snippet each."""
    sql = (
        f"SELECT rowid, snippet({name}, 1, '[', ']', '…', 24) "
        f"FROM {name} WHERE {name} MATCH ? ORDER BY bm25({name}) LIMIT ?"
    )
    try:
        return [row[0] for row in conn.execute(sql, (match, TOP))]
    except sqlite3.OperationalError as error:
        print(f"  {name}: {match!r}: {error}")
        return []
```

虚拟表有三列：`title`、`body`、`tags`。查询是 `MATCH ? ORDER BY bm25(name) LIMIT 10`，同时取 `snippet()`，这样两边做的是同一件事：排名加十个片段。`TRANSLATED` 字典把 Sift 的查询语法翻成 FTS5 的：`typst -latex` 变成 `typst NOT latex`，`tag:Rust lifetime` 变成 `tags:rust lifetime`，`owner*` 在 `unicode61` 里是前缀查询，在 `trigram` 里没有前缀语法，就变成子串 `owner`。

### bm25() 的算法：不是同一个 BM25

FTS5 的 `bm25()` 是 SQLite 源码里的 C 函数。`ext/fts5/fts5_aux.c` (SQLite version-3.53.3) 第 656 到 677 行的循环给查询里的每个短语算 IDF，公式在第 673 到 675 行：

```c
        double idf = log( (nRow - nHit + 0.5) / (nHit + 0.5) );
        if( idf<=0.0 ) idf = 1e-6;
        p->aIDF[i] = idf;
```

第 727 到 743 行算每一行的分数。`k1 = 1.2` 和 `b = 0.75` 在第 700 到 701 行写死；`D` 是这一行**所有列**的 token 总数（第 730 行的 `xColumnSize(pFts, -1, ...)`），`avgdl` 同样是所有列的总数除以行数（第 652 到 653 行）；最后乘上 `-1.0` 返回（第 738 到 743 行）：

```c
      score += pData->aIDF[i] * (
          ( aFreq[i] * (k1 + 1.0) ) /
          ( aFreq[i] + k1 * (1 - b + b * D / pData->avgdl) )
      );
    }
    sqlite3_result_double(pCtx, -1.0 * score);
```

和我在第 8 篇写的公式比，k1 和 b 的默认值一样，`tf` 的饱和项也一样，差别有四处：

- **符号**：`bm25()` 返回负数，分越小越好，所以是 `ORDER BY bm25(...)` 升序，不是降序。
- **idf**：SQLite 用 `log(x)`，并且小于等于 0 时钳到 `1e-6`；Sift 用 `log(1 + x)`，永远为正。
- **列**：SQLite 的 `D` 和 `avgdl` 数的是整行（我建的表是三列，标题、正文和标签都算）；Sift 的倒排表只有正文，标题另有一个小的标题索引，只给 `title:` 查询用。
- **词**：这是后面要讲的，两边对“什么是一个词”的看法不同。

idf 的差别可以直接算出来（123 篇文档，`df` 是含这个词的文档数；三列依次是 `df`、SQLite 的 `log(x)` 和 Sift 的 `log(1 + x)`，SQLite 还要把小于等于 0 的值钳到 `1e-6`）：

```text
$ python3 -c 'import math
for df in (3, 43, 62):
    x = (123 - df + 0.5) / (df + 0.5)
    print(df, round(math.log(x), 3), round(math.log(1 + x), 3))'
3 3.539 3.568
43 0.615 1.048
62 -0.016 0.685
```

`df` 小的时候两个公式几乎一样（3 篇：3.539 对 3.568）；`df` 大的时候就分开了：`df = 43` 时 Sift 的 idf 是 SQLite 的 1.7 倍；`df = 62`（过半数的文档）时 SQLite 的 `log(x)` 已经是负数，被钳成 `1e-6`，等于说“这个词不提供任何信息”，Sift 还给 0.685。这一点对单个词的查询没有影响（所有文档乘的是同一个 idf，顺序不变），对多个词的查询会改变各个词之间的相对权重。

### 分词器：什么是一个词

我在 FTS5 对比里最想弄清楚的是：同样一句话，三个分词器各切出了什么。我写了一个脚本，用 `fts5vocab` 虚拟表把 FTS5 存下来的词读出来，再用 Sift 的 `mixed` 分析器切一遍：

```python
"""Show how three tokenizers split one mixed Chinese and English line."""

import sqlite3

from sift.analysis import build_pipeline

TEXT = "Rust 的所有权规则；Kalman filter 与卡尔曼滤波，owner_id。"


def vocab(conn: sqlite3.Connection, tokenizer: str) -> list[str]:
    """Return the terms FTS5 stores for TEXT with this tokenizer."""
    conn.execute(
        f"CREATE VIRTUAL TABLE t USING fts5(x, tokenize='{tokenizer}')"
    )
    conn.execute("CREATE VIRTUAL TABLE v USING fts5vocab(t, 'row')")
    conn.execute("INSERT INTO t VALUES (?)", (TEXT,))
    terms = [row[0] for row in conn.execute("SELECT term FROM v")]
    conn.execute("DROP TABLE v")
    conn.execute("DROP TABLE t")
    return terms


def main() -> None:
    """Print the terms of each tokenizer, then try seven MATCH strings."""
    conn = sqlite3.connect(":memory:")
    print("text      :", TEXT)
    for tokenizer in ("unicode61", "trigram"):
        terms = vocab(conn, tokenizer)
        print(f"{tokenizer:<10}: {len(terms)} terms", terms[:12])
    pipeline = build_pipeline(("mixed", "nfkc", "stopwords"))
    print("sift mixed:", pipeline.terms(TEXT))
    for tokenizer, match in (
        ("unicode61", "所有权"),
        ("unicode61", "与卡尔曼滤波"),
        ("unicode61", "owner"),
        ("unicode61", "owner_id"),
        ("trigram", "所有权"),
        ("trigram", "卡尔"),
        ("trigram", "owner"),
    ):
        conn.execute(
            f"CREATE VIRTUAL TABLE t USING fts5(x, tokenize='{tokenizer}')"
        )
        conn.execute("INSERT INTO t VALUES (?)", (TEXT,))
        found = conn.execute(
            "SELECT count(*) FROM t WHERE t MATCH ?", (match,)
        ).fetchone()[0]
        print(f"{tokenizer:<10} MATCH {match!r:<12} -> {found} row(s)")
        conn.execute("DROP TABLE t")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/fts_tokens.py
text      : Rust 的所有权规则；Kalman filter 与卡尔曼滤波，owner_id。
unicode61 : 7 terms ['filter', 'id', 'kalman', 'owner', 'rust', '与卡尔曼滤波', '的所有权规则']
trigram   : 40 terms [' fi', ' 与卡', ' 的所', '_id', 'alm', 'an ', 'er ', 'er_', 'fil', 'id。', 'ilt', 'kal']
sift mixed: ['rust', '的所', '所有', '有权', '权规', '规则', 'kalman', 'filter', '与卡', '卡尔', '尔曼', '曼滤', '滤波', 'owner_id']
unicode61  MATCH '所有权'        -> 0 row(s)
unicode61  MATCH '与卡尔曼滤波'     -> 1 row(s)
unicode61  MATCH 'owner'      -> 1 row(s)
unicode61  MATCH 'owner_id'   -> 1 row(s)
trigram    MATCH '所有权'        -> 1 row(s)
trigram    MATCH '卡尔'         -> 0 row(s)
trigram    MATCH 'owner'      -> 1 row(s)
```

读输出可以归纳出三条规则：

- `unicode61` 把连续的汉字当成**一个词**，直到遇到标点或空格：`的所有权规则` 是一个词，`与卡尔曼滤波` 是一个词。所以查询 `所有权` 找不到这一行（0 行），查询整段 `与卡尔曼滤波` 才找得到。它还把下划线当成分隔符，`owner_id` 被拆成 `owner` 和 `id`；Sift 的拉丁词规则是 `[0-9a-z_]+`，`owner_id` 是一个词。
- `trigram` 不分词，把文本里每 3 个字符滑动一次，都当成一个词（40 个，其中还有带空格和标点的），查询 `所有权` 因为恰好是 3 个字，能找到；`卡尔` 只有两个字，一个三元组都凑不出来，0 行。
- Sift 的 `mixed` 是拉丁词整词、汉字二元组（`的所`、`所有`、`有权`……）。`所有权` 这个词在 Sift 里是 `所有` 加 `有权` 的短语，所以能命中。

### 12 条查询

实验室在快状态下跑（`cpu_state.py` 前后各一次），每条查询 15 轮，Sift 和 FTS5 的各个引擎在每一轮里轮流执行，取中位数：

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    python3 lab/ch13/fts5_compare.py; \
    python3 /tmp/sift-scratch/cpu_state.py
112 115 114 112 115 ms
sqlite 3.53.3
123 documents; 12 queries
sift segment + sift.db: 7,258,820 bytes
fts.db with ['trigram', 'unicode61']: 24,375,296 bytes
latency: median and min of 15 rounds, in ms

...

sift-rank: the same search with make_snippet stubbed out
unicode61: mean Jaccard 0.701 over 12 queries, median latency ratio fts/sift 0.063, fts/sift-rank 13.600
trigram: mean Jaccard 0.766 over 12 queries, median latency ratio fts/sift 0.071, fts/sift-rank 21.019
112 114 114 113 113 ms
```

`sift-rank` 是实验室里的对照：把 `make_snippet` 换成空函数，让 `Searcher.search` 只排序、不建片段。每条查询的数字，我从同一次运行的输出里整理成下表（毫秒是中位数；Jaccard 是 Sift 前十名和 FTS5 前十名的 doc id 集合的交集比并集；命中是匹配的文档总数，不是前十）：

| 查询 | Sift 命中 | Sift 毫秒 | unicode61 命中 | Jaccard | 毫秒 | trigram 命中 | Jaccard | 毫秒 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `rust 所有权` | 10 | 221.451 | 3 | 0.300 | 2.501 | 10 | 1.000 | 13.458 |
| `kalman filter` | 5 | 71.300 | 5 | 1.000 | 2.885 | 6 | 0.833 | 4.819 |
| `"device tree"` | 4 | 30.172 | 4 | 1.000 | 1.893 | 4 | 1.000 | 1.967 |
| `pid AND 积分` | 10 | 111.503 | 5 | 0.500 | 3.406 | 0 | 0.000 | 0.107 |
| `tag:Rust lifetime` | 4 | 102.513 | 4 | 1.000 | 5.116 | 4 | 1.000 | 6.281 |
| `矩阵 OR matrix` | 56 | 81.668 | 48 | 0.250 | 10.342 | 48 | 0.250 | 9.786 |
| `typst -latex` | 14 | 84.782 | 14 | 1.000 | 6.789 | 13 | 1.000 | 6.444 |
| `cmake vcpkg` | 3 | 25.141 | 3 | 1.000 | 1.605 | 3 | 1.000 | 1.704 |
| `gdb 断点` | 3 | 51.323 | 1 | 0.333 | 6.001 | 4 | 0.750 | 8.179 |
| `linux kernel module` | 2 | 19.002 | 3 | 0.667 | 1.716 | 4 | 0.500 | 2.275 |
| `奇异值` | 14 | 60.010 | 5 | 0.500 | 1.907 | 14 | 1.000 | 4.443 |
| `owner*` | 6 | 116.738 | 7 | 0.857 | 7.275 | 7 | 0.857 | 8.893 |

`unicode61` 的 Jaccard 平均 0.701，`trigram` 是 0.766。这不是质量指标，只说明这 12 条查询上，两边前十名集合的交集比并集平均是 0.70。平均数混着几种很不同的情形：

- **都是拉丁词、没有特殊字符**：`kalman filter`、`"device tree"`、`cmake vcpkg`、`tag:Rust lifetime` 在 `unicode61` 上都是 1.000，也就是两个引擎在这几条上返回的前十个文档完全一样。`typst -latex` 也是 1.000，`NOT` 和 `-` 的语义一致。
- **汉字**：`奇异值` 在 `trigram` 上是 1.000（14 篇，三个字正好是一个三元组，Sift 的二元组短语 `奇异 异值` 命中的是同一批文档），在 `unicode61` 上只有 0.500，因为 `unicode61` 要求 `奇异值` 单独成词。`rust 所有权` 同理，`unicode61` 只找到 3 篇，`trigram` 找到的 10 篇和 Sift 一致。两个汉字的词在 `trigram` 里凑不出一个三元组，所以表现很怪：`pid AND 积分` 是 0 篇 (Jaccard 0.000)，`gdb 断点` 却返回 4 篇，比 `unicode61` 的 1 篇多，也比 Sift 的 3 篇多。我没有去读 FTS5 怎么处理这种空词，这两种行为是实验观察，不是对源码的解读。
- **`linux kernel module` 和 `owner*`**：差在这两个词在 FTS5 里切得更碎。我写了第二个脚本，列出只有一边返回的文档，并数出对应的词是不是以别的形式出现在正文里：

```python
"""Explain why the top-10 lists of Sift and FTS5 differ for a query."""

import re
import sqlite3

from sift.cli import index_dir
from sift.config import load_config
from sift.search import Searcher
from sift.storage.store import open_index

CASES = [
    (
        "linux kernel module",
        "linux kernel module",
        ["linux", "kernel", "module"],
    ),
    ("owner*", "owner*", ["owner"]),
    ("gdb 断点", "gdb 断点", ["gdb", "断点"]),
]


def main() -> None:
    """Print the documents only one engine returns, and why."""
    with open_index(index_dir(load_config())) as index:
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE VIRTUAL TABLE f USING fts5(title, body, tags)")
        conn.executemany(
            "INSERT INTO f (rowid, title, body, tags) VALUES (?, ?, ?, ?)",
            [
                (d.doc_id, d.title, d.body, " ".join(d.tags))
                for d in index.documents.values()
            ],
        )
        searcher = Searcher(index)
        for query, match, terms in CASES:
            print(f"query {query!r}")
            sift = {h.doc_id for h in searcher.search(query, 10).hits}
            sql = "SELECT rowid FROM f WHERE f MATCH ? ORDER BY bm25(f)"
            fts = {row[0] for row in conn.execute(sql + " LIMIT 10", (match,))}
            for name, ids in (("sift", sift - fts), ("fts5", fts - sift)):
                for doc_id in sorted(ids):
                    doc = index.documents[doc_id]
                    print(f"  only {name}: {doc_id} {doc.title[:30]}")
                    for term in terms:
                        words = re.findall(
                            r"\w*" + term + r"\w*", doc.body, re.I
                        )
                        exact = sum(w.lower() == term for w in words)
                        odd = sorted({w for w in words if w.lower() != term})
                        print(f"      {term!r}: {exact} exact, {odd[:3]}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/fts_diff.py
query 'linux kernel module'
  only fts5: 113 我拆开了 Kconfig: 从一个选项到 U-Boot 和
      'linux': 42 exact, ['vmlinux']
      'kernel': 3 exact, []
      'module': 0 exact, ['CONFIG_MODULES', 'CONFIG_SENSOR_MODULE', 'IS_MODULE']
query 'owner*'
  only fts5: 10 从暂停到理解：GDB 调试完整实践
      'owner': 0 exact, ['__owner', '_owner']
query 'gdb 断点'
  only sift: 0 ARMv7-A 指令体系全解：数据处理、访存、分支与同步
      'gdb': 1 exact, []
      '断点': 0 exact, ['断点指令']
  only sift: 115 一台不存在的计算机：QEMU 工作原理与实践
      'gdb': 21 exact, ['gdb0', 'gdbstub']
      '断点': 0 exact, ['确定性相关选项和软件断点能力', '而不是把断点下在希望它出现的地址']
```

文档 113（Kconfig 那篇）正文里没有单独的 `module` 这个词，只有 `CONFIG_MODULES`、`IS_MODULE` 这样的标识符，`unicode61` 把下划线当分隔符，`IS_MODULE` 就变成了 `is` 和 `module`，于是命中；Sift 把整个标识符当一个词，`module` 一个都没有，不命中。文档 10 同理，`__owner` 和 `_owner` 在 `unicode61` 里都有一个 `owner`，Sift 的前缀 `owner*` 要以 `owner` 开头，`__owner` 不算。`gdb 断点` 的两篇 Sift 独有，是因为正文里的 `断点` 都嵌在没有标点的长串里（`断点指令`，或者一整句话），`unicode61` 不认，Sift 的二元组能切出 `断点`。

我不打算说哪一边“对”：把下划线当分隔符搜 `module` 合理，把 `IS_MODULE` 当整词也合理；二元组能搜到 `断点指令` 里的 `断点`，也会搜到别的无关组合。两边在回答不一样的问题。

### 控制实验：把分词拉平

怎么验证“主要是分词不同，不是评分公式不同”？办法是让 FTS5 吃 Sift 切好的词。第三个脚本把每篇文档用 Sift 的分析器切成词，再用空格连起来灌进 FTS5（`tokenchars '_+#'` 让这三个字符算词的一部分），查询也用 Sift 的分析器切，再各自转成带引号的短语；同时，它也测了 `snippet()` 对 FTS5 耗时的影响：

```python
"""Run two controls on the FTS5 comparison: same tokens, no snippets."""

import sqlite3
import statistics
import time

from sift.analysis import Pipeline, build_pipeline
from sift.cli import index_dir
from sift.config import load_config
from sift.search import Searcher
from sift.storage.store import open_index

QUERIES = [
    "rust 所有权",
    "kalman filter",
    "linux kernel module",
    "奇异值",
    "rust",
    "linux",
    "内存",
    "matrix",
]
RANKED = "SELECT rowid FROM {t} WHERE {t} MATCH ? ORDER BY bm25({t}) LIMIT 10"
SNIPPET = (
    "SELECT rowid, snippet({t}, 1, '[', ']', '...', 24) FROM {t} "
    "WHERE {t} MATCH ? ORDER BY bm25({t}) LIMIT 10"
)
ROUNDS = 15


def to_match(pipeline: Pipeline, query: str) -> str:
    """Return the FTS5 query that asks for the same tokens as Sift."""
    phrases = (" ".join(pipeline.terms(word)) for word in query.split())
    return " ".join(f'"{phrase}"' for phrase in phrases)


def alternate(conn: sqlite3.Connection, match: str) -> tuple[float, float]:
    """Return median ms of the plain and the snippet statement."""
    plain, full = RANKED.format(t="raw"), SNIPPET.format(t="raw")
    times: tuple[list[float], list[float]] = ([], [])
    for _ in range(ROUNDS):  # alternate the two statements
        for sql, bucket in ((plain, times[0]), (full, times[1])):
            start = time.perf_counter_ns()
            conn.execute(sql, (match,)).fetchall()
            bucket.append((time.perf_counter_ns() - start) / 1e6)
    return statistics.median(times[0]), statistics.median(times[1])


def main() -> None:
    """Compare top-10 lists on identical tokens, then time snippet()."""
    pipeline = build_pipeline(("mixed", "nfkc", "stopwords"))
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE VIRTUAL TABLE same USING fts5(body, "
        "tokenize=\"unicode61 tokenchars '_+#'\")"
    )
    conn.execute("CREATE VIRTUAL TABLE raw USING fts5(title, body, tags)")
    with open_index(index_dir(load_config())) as index:
        for doc in index.documents.values():
            conn.execute(
                "INSERT INTO same (rowid, body) VALUES (?, ?)",
                (doc.doc_id, " ".join(pipeline.terms(doc.body))),
            )
            conn.execute(
                "INSERT INTO raw (rowid, title, body, tags) "
                "VALUES (?, ?, ?, ?)",
                (doc.doc_id, doc.title, doc.body, " ".join(doc.tags)),
            )
        searcher = Searcher(index, pipeline=pipeline)
        print("same tokens: Sift bm25 against FTS5 bm25()")
        for query in QUERIES:
            match = to_match(pipeline, query)
            result = searcher.search(query, 10)
            ours = [hit.doc_id for hit in result.hits]
            sql = RANKED.format(t="same")
            theirs = [row[0] for row in conn.execute(sql, (match,))]
            same_set = set(ours) == set(theirs)
            print(
                f"  {query!r:<22} hits {result.total:>3}  "
                f"same set {same_set}  same order {ours == theirs}"
            )
        print("FTS5 with and without snippet(), median ms")
        for query in ("kalman filter", "linux kernel module", "cmake vcpkg"):
            plain, full = alternate(conn, query)
            print(f"  {query!r:<22} plain {plain:.3f}  snippet {full:.3f}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    python3 /tmp/sift-scratch/fts_controls.py; \
    python3 /tmp/sift-scratch/cpu_state.py
113 113 114 113 113 ms
same tokens: Sift bm25 against FTS5 bm25()
  'rust 所有权'             hits  10  same set True  same order False
  'kalman filter'        hits   5  same set True  same order True
  'linux kernel module'  hits   2  same set True  same order True
  '奇异值'                  hits  14  same set True  same order True
  'rust'                 hits  43  same set True  same order True
  'linux'                hits  30  same set True  same order True
  '内存'                   hits  46  same set True  same order True
  'matrix'               hits  24  same set True  same order True
FTS5 with and without snippet(), median ms
  'kalman filter'        plain 0.033  snippet 2.529
  'linux kernel module'  plain 0.044  snippet 1.552
  'cmake vcpkg'          plain 0.031  snippet 1.461
111 114 115 115 114 ms
```

第一段：8 条查询里，7 条的前十名不但是同一批文档，**连顺序都一样**。这些里有单个词（`rust` 43 篇、`linux` 30 篇、`内存` 46 篇、`matrix` 24 篇），说明 k1、b、tf 的饱和项和长度归一化两边是对得上的；还有 `kalman filter` 和 `linux kernel module` 这样的多词查询，只是它们只有 5 篇和 2 篇，样本太小，不足以说明 idf 的差别永远不改变顺序。唯一顺序不同的是 `rust 所有权`：集合一样，名次不一样。我的猜测是 `rust` 和短语 `所有 有权` 的 `df` 差得足够大，`log(x)` 和 `log(1 + x)` 给它们的相对权重不同，没有再往下查。

所以在这 8 条查询上，Jaccard 的下降主要来自“切出了什么词”，而不是“怎么给词打分”。这个对照没有覆盖布尔、前缀和 `tag:` 查询，用的也是只有正文一列的表，所以上面说的列和 `avgdl` 的差别它没有测到。即便如此，这仍是整章里让我最舒服的一个结论：我手写的 BM25 和 SQLite 的 `bm25()` 在同样的 token 上几乎给出同样的排序。

### 延迟：差在哪

回到表里的毫秒数（Python 写的和 C 写的比速度，这个比分不会让任何人意外，包括我）。Sift 一次查询从 19 毫秒（2 篇）到 221 毫秒（10 篇），`unicode61` 的 FTS5 是 1.6 到 10.3 毫秒。12 条查询里 `fts/sift` 的中位数是 0.063，也就是 FTS5 大约快 16 倍（`trigram` 是 0.071，14 倍）。但把 `sift-rank` 那一行放在旁边看：同样的 Sift 只排序、不建片段，0.13 到 0.48 毫秒，比带片段的 FTS5 快 13.6 倍。

差在片段。Sift 一次查询的时间几乎等于“前十名里的篇数乘以每篇正文的分词时间”：`kalman filter` 5 篇 71.3 毫秒，`linux kernel module` 2 篇 19.0 毫秒，`rust 所有权` 10 篇 221.5 毫秒，12 条查询里每篇片段在 6 到 26 毫秒之间。这是第 8 篇就发现过的那个问题：`make_snippet` 要把整篇正文重新分词，一篇 `从暂停到理解：GDB 调试完整实践` 就是 11 万个字符。FTS5 的 `snippet()` 也要扫文档，但那是 C，对照实验的第二段说明：同一条 FTS5 查询，不要 `snippet()` 只要 rowid 是 0.033 毫秒，加上 `snippet()` 是 2.529 毫秒，片段占了 98.7%。

所以公平的说法是：

- 排名本身，Sift 的 0.19 毫秒和 FTS5 的 0.033 毫秒都已经不是瓶颈；
- 片段这部分，Python 的分词器要 6 到 26 毫秒每篇，SQLite 的 C 要 0.5 毫秒每篇左右（`kalman filter` 的 2.5 毫秒除以 5 篇）；
- 这个比较并不严格：Sift 的倒排表在第一轮预热之后留在了内存里，FTS5 读的是 SQLite 自己的页缓存；片段的长度不同（Sift 160 个字符，FTS5 是 24 个词）；两边的语法翻译有损。

我不打算说谁“更好”。FTS5 不需要我写一行分词和排序的代码；Sift 的价值是我知道每一行为什么这么写。换用 FTS5 要接受的是它的分词规则，延迟在这份语料上不是问题。

## SQLAlchemy 2.0：三层

`sqlite3` 能做到的 SQLAlchemy 都能做到，但它在上面盖了两层：最下面是 DB-API 驱动，也就是上一节的 `sqlite3`；中间是 Core，一套用 Python 对象拼 SQL 的表达式语言，加上 `Engine`（连接池）和 `Connection`；最上面是 ORM，把类映射成表，把对象的增删改交给一个 `Session` 去排序、合并、提交。Sift 的 `db.py` 用的是最上面一层，我先从中间一层说起，因为 ORM 的每一步最后都会变成它。

### Core：语句是对象

`lab/ch13/sqlalchemy_core.py` 用 123 篇文章建一张 `posts` 表，然后查它：

```python
    engine = sa.create_engine("sqlite://")  # in memory
    # ...
    # Core statements are objects: printing one shows the SQL text
    stmt = insert(posts)
    print(stmt)
    with engine.begin() as conn:  # commits at the end of the block
        result = conn.execute(stmt, rows)  # a list means executemany
        print("inserted", result.rowcount, "rows")

    longest = (
        select(posts.c.title, posts.c.n_chars)
        .where(posts.c.category == "Tutorial")
        .order_by(posts.c.n_chars.desc())
        .limit(3)
    )
    print()
    print(longest)
    print("params:", longest.compile().params)
    with engine.connect() as conn:  # no commit: read only
        for row in conn.execute(longest):
            print(f"  {row.n_chars:>6}  {row.title}")
```

```text
$ python3 lab/ch13/sqlalchemy_core.py
sqlalchemy 2.0.51
INSERT INTO posts (doc_id, title, category, n_chars) VALUES (:doc_id, :title, :category, :n_chars)
inserted 123 rows

SELECT posts.title, posts.n_chars
FROM posts
WHERE posts.category = :category_1 ORDER BY posts.n_chars DESC
 LIMIT :param_1
params: {'category_1': 'Tutorial', 'param_1': 3}
  112232  从暂停到理解：GDB 调试完整实践
   63924  移植之前：float32、定长内存与每步耗时
   53846  姿态的数学：旋转、四元数与 IMU 仿真器

{'category': 'Note', 'posts': 72, 'mean_chars': 23829.0}
{'category': 'Tutorial', 'posts': 51, 'mean_chars': 24878.0}
title == hostile string -> 0 rows
rows after the rolled back delete: 123
```

`print(stmt)` 打印的是**带命名占位符的 SQL 文本**，参数没有被拼进去：`VALUES (:doc_id, :title, ...)`，`WHERE posts.category = :category_1`，连 `LIMIT` 都是 `:param_1`。参数和语句分开存 (`longest.compile().params`)，到驱动那一层才由 `sqlite3` 绑定，所以前面的注入结论在这里自动成立：脚本后半段把 `x' OR '1'='1` 当标题去比较，找到 0 行，不是全部。`conn.execute(stmt, rows)` 传字典列表就是 `executemany` (`rowcount` 123)；`select(...)` 返回的行既能按属性取 (`row.n_chars`)，也能用 `.mappings()` 变成类字典。最后一段是事务：`with engine.begin()` 块里 `delete()` 之后抛了异常，块退出时回滚，读出来仍然是 123 行。

### `BEGIN (implicit)` 不是 `BEGIN`

SQLAlchemy 2.0 的 `Connection` 在第一次 `execute` 时自动开始 (autobegin) 一个事务，提交要你自己来。这在 `lib/sqlalchemy/engine/base.py` (SQLAlchemy rel_2_0_51) 第 788 到 790 行：`_autobegin` 只在 `_allow_autobegin` 为真、且不在 `begin()` 途中（`__in_begin` 防止重入）时调 `self.begin()`；“当前还没有事务”这个判断在调用它的地方，比如第 1840 到 1841 行的 `if self._transaction is None: self._autobegin()`。但这个“开始”是 SQLAlchemy 的逻辑事务，不等于发给 SQLite 的那条 `BEGIN`。我写了一个小脚本，把 SQLAlchemy 的日志和 `sqlite3` 的 `set_trace_callback` 并排打印：

```python
"""Compare SQLAlchemy's BEGIN (implicit) with what sqlite3 really runs."""

import logging
import sqlite3
import sys

import sqlalchemy as sa
from sqlalchemy import event, text


def main() -> None:
    """Run a SELECT and an INSERT in one transaction, with both logs."""
    logging.basicConfig(stream=sys.stdout, format="%(message)s")
    logging.getLogger("sqlalchemy.engine").setLevel(logging.INFO)
    engine = sa.create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def trace(dbapi_conn: sqlite3.Connection, record: object) -> None:
        """Make sqlite3 print every statement it executes."""
        dbapi_conn.set_trace_callback(lambda sql: print("  sqlite3:", sql))

    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE t (n INTEGER)"))
        conn.execute(text("SELECT count(*) FROM t")).all()
        conn.execute(text("INSERT INTO t VALUES (:n)"), {"n": 1})


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/sa_begin.py
BEGIN (implicit)
CREATE TABLE t (n INTEGER)
[generated in 0.00008s] ()
  sqlite3: CREATE TABLE t (n INTEGER)
SELECT count(*) FROM t
[generated in 0.00007s] ()
  sqlite3: SELECT count(*) FROM t
INSERT INTO t VALUES (?)
[generated in 0.00006s] (1,)
  sqlite3: BEGIN
  sqlite3: INSERT INTO t VALUES (1)
COMMIT
  sqlite3: COMMIT
```

日志里的 `BEGIN (implicit)` 是 SQLAlchemy 的；缩进两格的 `sqlite3:` 才是真正发给 SQLite 的。`CREATE TABLE` 和 `SELECT` 之前没有 `BEGIN`，`INSERT` 之前才有，完全是上一节那条规则：默认设置下，`pysqlite` 方言没有改变驱动的行为。SQLAlchemy 的 SQLite 文档另有一节专讲事务，我没有读，上面的结论只来自这个脚本。

连接池也有 SQLite 特有的一条。`lib/sqlalchemy/dialects/sqlite/pysqlite.py` 第 230 到 246 行：内存库用 `SingletonThreadPool`，每个线程一个连接；文件库在 2.0 里用 `QueuePool`，并把 `check_same_thread` 自动设成 `False`。`db.py` 里每个函数都自己建一个引擎、用完 `dispose()`，原因写在模块文档里：不让任何连接活得比一条命令更久。

### ORM：类就是表

`db.py` 里有三个模型。先看其中两个：

```python

class Base(DeclarativeBase):
    """Declarative base of the Sift tables."""


class DocumentRow(Base):
    """One indexed post. ``tags`` is a JSON list, dates are ISO 8601."""

    __tablename__ = "documents"

    doc_id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False)
    path: Mapped[str]
    title: Mapped[str]
    published: Mapped[str]
    updated: Mapped[str | None]
    category: Mapped[str | None]
    series: Mapped[str | None]
    tags: Mapped[list[str]] = mapped_column(JSON)
    body: Mapped[str]


# ...



class QueryLogRow(Base):
    """One logged search; ``at`` is aware UTC."""

    __tablename__ = "query_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(UtcDateTime)
    query: Mapped[str]
    total: Mapped[int]
```

`DeclarativeBase` 的子类持有所有表共用的元数据 (`Base.metadata`)；每个模型是一个类，每个列是一个 `Mapped[...]` 注解。注解**本身就是列的定义**：`Mapped[str]` 是 `VARCHAR NOT NULL`，`Mapped[str | None]` 是可空的 `VARCHAR`，`mapped_column(primary_key=True)` 是主键。前面 `.schema` 的输出和这些注解一一对应：`updated VARCHAR` 没有 `NOT NULL`，`tags JSON NOT NULL`，`sha256 VARCHAR(64)`。`doc_id` 上的 `autoincrement=False` 是说主键由调用者给（清单里分配，稳定不变），数据库不要自己分配。`tags: Mapped[list[str]] = mapped_column(JSON)`：Python 列表进去，JSON 文本出来，前面的 `json_each` 查询能用就是因为这个。

日期在 SQLite 里最让我头疼，因为它没有时区类型。`QueryLogRow.at` 用了一个自定义的 `UtcDateTime`：

```python

class UtcDateTime(TypeDecorator[datetime]):
    """A DateTime that SQLite stores as UTC and returns as UTC.

    SQLite has no time zone type, and SQLAlchemy would silently drop
    the tzinfo of an aware datetime. This decorator converts to UTC on
    the way in, rejects naive values, and attaches UTC on the way out.
    """

    impl = DateTime
    cache_ok = True

    def process_bind_param(
        self, value: datetime | None, dialect: Dialect
    ) -> datetime | None:
        """Return value as a naive UTC datetime."""
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime: give the time zone")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(
        self, value: datetime | None, dialect: Dialect
    ) -> datetime | None:
        """Return the stored naive value as an aware UTC datetime."""
```

`TypeDecorator` 在一个现有类型 (`DateTime`) 外面包一层：写的时候 (`process_bind_param`)，带时区的时间转成 UTC，并且**拒绝没有时区的时间**（按 `db.py` 的文档字符串，`DateTime` 会悄悄丢掉 `tzinfo`，我没有单独验证）；读的时候 (`process_result_value`)，把朴素的时间重新贴上 UTC。`cache_ok = True` 是告诉 SQLAlchemy 这个类型可以参与语句缓存。`sift stats` 里每行的 `UTC` 就是这样来的，`tests/test_cli.py` 断言了读出来的 `at.utcoffset()` 等于 `timedelta(0)`。`DocumentRow` 的日期没走这条路：`published` 和 `updated` 存的是 ISO 8601 文本（带 `+08:00`），由 `from_document` 和 `to_document` 转换。

### Session：一张草稿纸

`Session` 最好的比喻是草稿纸：`add` 是写上一笔，改属性是涂改，都是铅笔字，不算数；`flush` 是把铅笔字誊进正式账本，但还没盖章；`commit` 是盖章。这个比喻用这一次，下面回到代码。我写了一个脚本，让一个 `Session` 做一遍“加、改、查、提交”，每一步把真正发出去的语句打印出来：

```python
"""Watch what a Session sends: flush order, autoflush and expiry."""

import sqlalchemy as sa
from sqlalchemy import ForeignKey, event, select
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    Session,
    mapped_column,
    relationship,
)


class Base(DeclarativeBase):
    """Declarative base of the demo models."""


class Author(Base):
    """An author with many posts."""

    __tablename__ = "author"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    posts: Mapped[list[Post]] = relationship(back_populates="author")


class Post(Base):
    """A post with one author."""

    __tablename__ = "post"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str]
    author_id: Mapped[int] = mapped_column(ForeignKey("author.id"))
    author: Mapped[Author] = relationship(back_populates="posts")


def show(
    conn: object,
    cursor: object,
    statement: str,
    parameters: object,
    context: object,
    many: bool,
) -> None:
    """Print one statement on one line, with its parameters."""
    print("   SQL:", " ".join(statement.split()), parameters)


def main() -> None:
    """Add, flush, edit, query and commit; print every statement."""
    engine = sa.create_engine("sqlite://")
    Base.metadata.create_all(engine)
    event.listen(engine, "before_cursor_execute", show)
    session = Session(engine)
    post = Post(title="Ownership", author=Author(name="bfmhno3"))
    session.add(post)  # only the post: the author comes by cascade
    print("added; new =", len(session.new), "objects")
    session.flush()
    post.title = "Ownership and borrowing"
    print("edited; dirty =", len(session.dirty), "object")
    print("query runs autoflush first:")
    session.scalars(select(Post)).all()
    session.commit()
    print("after commit, read post.title (expire_on_commit=True):")
    print("  ", post.title)
    session.close()

    session = Session(engine, expire_on_commit=False)
    post = session.scalars(select(Post)).one()
    session.commit()
    print("after commit, read post.title (expire_on_commit=False):")
    print("  ", post.title)
    session.close()
    print("detached, author not loaded yet:")
    try:
        print(post.author.name)
    except sa.orm.exc.DetachedInstanceError as error:
        print("  ", type(error).__name__)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/session_echo.py
added; new = 2 objects
   SQL: INSERT INTO author (name) VALUES (?) ('bfmhno3',)
   SQL: INSERT INTO post (title, author_id) VALUES (?, ?) ('Ownership', 1)
edited; dirty = 1 object
query runs autoflush first:
   SQL: UPDATE post SET title=? WHERE post.id = ? ('Ownership and borrowing', 1)
   SQL: SELECT post.id, post.title, post.author_id FROM post ()
after commit, read post.title (expire_on_commit=True):
   SQL: SELECT post.id AS post_id, post.title AS post_title, post.author_id AS post_author_id FROM post WHERE post.id = ? (1,)
   Ownership and borrowing
   SQL: SELECT post.id, post.title, post.author_id FROM post ()
after commit, read post.title (expire_on_commit=False):
   Ownership and borrowing
detached, author not loaded yet:
   DetachedInstanceError
```

- `session.add(post)` 只加了 `post`，`session.new` 却有 2 个对象：`post.author` 是关系属性，`Author` 通过**级联** (cascade) 一起被加进来。这个阶段没有 SQL。
- `session.flush()` 发了两条 `INSERT`，**先 `author`，后 `post`**，因为 `post.author_id` 引用 `author.id`。这是工作单元 (unit of work) 干的：`lib/sqlalchemy/orm/unitofwork.py` 第 440 到 465 行 `UOWTransaction.execute` 对所有待写的操作做拓扑排序（`topological.sort`；有环才用 `sort_as_subsets` 分批），再依次执行。`Session.flush` 的文档字符串（`orm/session.py` 第 4323 到 4338 行）说得直白：操作由工作单元的依赖求解器自动排序。
- 改 `post.title` 之后，`session.dirty` 里有 1 个对象，仍然没有 SQL。
- 接着执行一个查询，先发了一条 `UPDATE`，再发 `SELECT`：这是自动 flush (autoflush)，查询之前先把未写入的修改刷出去，查询才看得到自己刚做的修改。
- `commit()` 之后，`print(post.title)` 又发了一条 `SELECT ... WHERE post.id = ?`：默认 `expire_on_commit=True`，提交让所有已加载的属性过期，下次访问重新读。第二个会话用 `expire_on_commit=False`，同样读 `post.title` 一条语句也没有。
- 会话关了之后读一个**没加载过**的关系属性 `post.author`，抛 `DetachedInstanceError`：对象已经不属于任何会话，没法再去数据库取。

`db.py` 的 `open_db` 用的就是 `expire_on_commit=False`：

```python

    # ...
    """
    engine = create_engine(
        URL.create("sqlite", database=str(path)),
    # ...
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@contextmanager
def session_scope(path: Path) -> Iterator[Session]:
    """Yield a session on the database at path.

    The transaction commits when the block ends and rolls back when it
    raises; the engine is disposed either way.
    """
    maker = open_db(path)
    try:
```

原因就是倒数第二条：`recent_queries` 在 `session_scope` 的块里取出行再返回，`sift stats` 在会话之外打印 `row.at`；如果提交把属性都过期了，每一行在会话关闭后访问都会要求刷新，而会话已经没有了。`session_scope` 本身是一个 `@contextmanager`：`maker.begin()` 保证块正常结束就提交、抛异常就回滚，`finally` 里 `dispose` 引擎。

### 身份映射：一个主键，一个对象

一个会话里，同一个主键只有一个 Python 对象，这叫身份映射 (identity map)。`lab/ch13/sqlalchemy_orm.py` 的 `lab_models` 验证了它，也顺便把上面的流程用多对多的模型再跑一遍：

```python
def lab_models() -> None:
    # ...
    with Session(engine) as session:
        rust = TagRow(name="rust")
        post = PostRow(title="Ownership", tags=[rust])
        session.add(post)  # cascades to the tag through the relationship
        print("pending       :", len(session.new), "objects, 0 statements")
        session.flush()  # the unit of work orders the INSERTs
        print("after flush   :", statements)
        print("ids           :", post.id, rust.id)

        post.title = "Ownership and borrowing"
        print("dirty         :", [p.title for p in session.dirty])
        session.commit()
        print("commit flushed:", statements[-1])

        # identity map: one object per primary key per session
        first = session.get(PostRow, post.id)
        again = session.scalars(select(PostRow)).one()
        print("same object   :", first is again is post)
        print("back_populates:", [p.title for p in rust.posts])

        # a new TagRow named 'rust' breaks the unique constraint
        session.add(TagRow(name="rust"))
        try:
            session.flush()
        except sa.exc.IntegrityError as error:
            print("IntegrityError:", str(error.orig))
            session.rollback()
    engine.dispose()
```

```text
$ python3 lab/ch13/sqlalchemy_orm.py | sed -n 1,9p
lab models
pending       : 2 objects, 0 statements
after flush   : ['INSERT', 'INSERT', 'INSERT']
ids           : 1 1
dirty         : ['Ownership and borrowing']
commit flushed: UPDATE
same object   : True
back_populates: ['Ownership and borrowing']
IntegrityError: UNIQUE constraint failed: tag.name
```

`first is again is post` 是 `True`：`session.get(PostRow, post.id)` 和 `select(PostRow)` 查出来的，就是刚才 `add` 进去的那一个对象。`rust.posts` 里有 `post`，我没给它赋过值，是 `back_populates` 自动同步的。`after flush` 的三条 `INSERT` 是标签、文章和多对多关联表 `post_tag` 的一行。最后一段把一个重名的 `TagRow` 加进去，`flush` 时 `tag.name` 的唯一约束失败，抛 `sqlalchemy.exc.IntegrityError`，`error.orig` 才是 `sqlite3` 原来的异常。

身份映射的实现在 `lib/sqlalchemy/orm/identity.py` 第 126 到 206 行，类名叫 `WeakInstanceDict`；我读源码看到，`add` 遇到同一个主键的另一个对象时直接抛 `Can't attach instance ...; another instance with key ... is already present in this session.`（第 195 到 200 行）。类名里的 `Weak` 说明引用是弱引用，这一点我没有测。

### 加载策略：124 条语句还是 1 条

ORM 里最著名的陷阱是 N+1：取出 N 个对象，然后对每个对象访问一个关系属性，每次访问发一条 `SELECT`。Sift 的 `tags` 是 JSON 列，不是关系，所以 Sift 本身没有这个问题。`lab/ch13/n_plus_one.py` 为了演示，把 123 篇文章的标签建成一张真正的多对多：

```python
class TagRow(Base):
    """A tag."""

    __tablename__ = "tag"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(unique=True)


class PostRow(Base):
    """A post; tags loads lazily, one SELECT per post, by default."""

    __tablename__ = "post"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str]
    tags: Mapped[list[TagRow]] = relationship(secondary=post_tag)


# ...


def count_statements(engine: sa.Engine, load: object | None) -> list[str]:
    """Return the SQL of every statement run while listing all tags."""
    statements: list[str] = []

    def record(
        conn: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: Any,
        many: bool,
    ) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        with Session(engine) as session:
            stmt = select(PostRow).order_by(PostRow.id)
            if load is not None:
                stmt = stmt.options(load)
            posts = session.scalars(stmt).unique().all()
            total = sum(len(post.tags) for post in posts)
            print(f"  {len(posts)} posts, {total} tag links read")
    finally:
        event.remove(engine, "before_cursor_execute", record)
    return statements
```

```text
$ python3 lab/ch13/n_plus_one.py
123 posts in the database
lazy (the default)
  123 posts, 498 tag links read
  statements: 124
  first: SELECT post.id, post.title FROM post ORDER BY post.id
  last : SELECT tag.id AS tag_id, tag.name AS tag_name FROM tag, post_tag WHERE ? = post_tag.post_i
selectinload
  123 posts, 498 tag links read
  statements: 2
  first: SELECT post.id, post.title FROM post ORDER BY post.id
  last : SELECT post_1.id AS post_1_id, tag.id AS tag_id, tag.name AS tag_name FROM post AS post_1
joinedload
  123 posts, 498 tag links read
  statements: 1
  first: SELECT post.id, post.title, tag_1.id AS id_1, tag_1.name FROM post LEFT OUTER JOIN (post_t
raiseload: touching a relationship that was not loaded
  InvalidRequestError: 'PostRow.tags' is not available due to lazy='raise'
```

`count_statements` 在引擎上挂一个 `before_cursor_execute` 监听器，记下每一条语句。三种策略读的是同样的 123 篇文章、498 条标签连接：

- **默认的懒加载**：1 条查文章，再加每篇文章访问 `post.tags` 时各 1 条，一共 **124** 条。`LazyLoader._load_for_state`（`orm/strategies.py` 第 871 到 935 行）就是属性被访问时才去数据库的那个函数；它在发 SQL 之前先看 `lazy="raise"` 的分支（第 900 到 914 行）、会话是否已分离（`DetachedInstanceError`，第 916 到 926 行），对简单的主键查找还会先查身份映射，“不用生成一个 Query”就能拿到（第 928 到 935 行）。
- **`selectinload`**：先查文章，再发**一条**查询把所有文章的标签一次取回来（脚本只打印了语句的前 90 个字符，`FROM post AS post_1 ...`，它把标签表和文章表连起来），一共 **2** 条。`SelectInLoader` 在 `orm/strategies.py` 第 2946 行，从名字看是用 `IN` 列表取的，我没有贴完整的语句去验证。
- **`joinedload`**：一条 `LEFT OUTER JOIN`，**1** 条。一篇文章对应多行，SQLAlchemy 的文档要求对这种集合的 `joinedload` 调用 `.unique()` 去重，脚本里三种策略统一写了 `.unique().all()`。
- **`raiseload`** 不是一种加载方式，而是把“不小心触发懒加载”变成错误：访问 `post.tags` 直接抛 `InvalidRequestError: 'PostRow.tags' is not available due to lazy='raise'`。我觉得这是写 ORM 代码时最该默认打开的开关，尤其是在要求每个查询显式写出需要什么的代码库里。

这三个数字是语句数，不是时间。SQLite 就在同一个进程里，124 条语句不过是 124 次函数调用，我没有测它慢多少；换成网络数据库，每条多一个往返，差距才会显眼，这是推断，不是测量。

### EXPLAIN QUERY PLAN：SCAN 还是 SEARCH

上面讲的是“发几条语句”，另一半是“每条语句数据库怎么执行”。SQLite 在语句前面加 `EXPLAIN QUERY PLAN` 就能看到。`lab/ch13/explain_query_plan.py` 用 Sift 的两张表做了几组对照（`query_log` 先被灌了 5000 行假数据）：

```python
def plan(conn: sqlite3.Connection, sql: str, *args: object) -> None:
    """Print the SQL and its query plan."""
    print(" ", " ".join(sql.split()))
    for _, _, _, detail in conn.execute("EXPLAIN QUERY PLAN " + sql, args):
        print("     ->", detail)
```

```text
$ python3 lab/ch13/explain_query_plan.py
sqlite 3.53.3

by primary key
  SELECT title FROM documents WHERE doc_id = ?
     -> SEARCH documents USING INTEGER PRIMARY KEY (rowid=?)

by category, no index
  SELECT doc_id FROM documents WHERE category = ?
     -> SCAN documents

by category, after CREATE INDEX
  SELECT doc_id FROM documents WHERE category = ?
     -> SEARCH documents USING COVERING INDEX ix_documents_category (category=?)

LIKE with a leading % cannot use an index
  SELECT doc_id FROM documents WHERE title LIKE ?
     -> SCAN documents

sift stats: the last 10 queries (id is the rowid)
  SELECT * FROM query_log ORDER BY id DESC LIMIT 10
     -> SCAN query_log

the same by time, no index on at
  SELECT * FROM query_log ORDER BY at DESC LIMIT 10
     -> SCAN query_log
     -> USE TEMP B-TREE FOR ORDER BY

the same by time, after CREATE INDEX on at
  SELECT * FROM query_log ORDER BY at DESC LIMIT 10
     -> SCAN query_log USING INDEX ix_query_log_at

covering index: only indexed columns are read
  SELECT at FROM query_log WHERE at > ?
     -> SEARCH query_log USING COVERING INDEX ix_query_log_at (at>?)

the same plan through SQLAlchemy
     -> SCAN query_log
```

- `WHERE doc_id = ?` 是 `SEARCH ... USING INTEGER PRIMARY KEY (rowid=?)`：`doc_id` 是 `INTEGER` 主键，也就是 rowid 的别名，不用另建索引。
- `WHERE category = ?` 没有索引时是 `SCAN documents`，整张表扫一遍；`CREATE INDEX` 之后是 `SEARCH ... USING COVERING INDEX`：只读索引就能回答，不用回表（`doc_id` 是 rowid，本来就在索引里）。`LIKE '%GDB%'` 以通配符开头，索引用不上，仍是 `SCAN`。
- `sift stats` 用的 `SELECT * FROM query_log ORDER BY id DESC LIMIT 10` 是 `SCAN query_log`，**没有** `USE TEMP B-TREE FOR ORDER BY`，因为 `id` 就是 rowid，按它倒着扫天然有序。换成按 `at` 排序，计划里就多了一行临时 B 树排序，建了 `at` 上的索引之后变成 `SCAN ... USING INDEX`，排序没了。所以我没给 `query_log` 加索引：最近 10 条就是 rowid 最大的 10 条（我没量它真正读了几行，计划只说不用排序）。
- 最后一段用 SQLAlchemy 的 `text()` 发 `EXPLAIN QUERY PLAN`，结果和直接用 `sqlite3` 一样：Core 随时能让你退回手写的 SQL。

### 约束：数据库说了算

最后一个实验室脚本故意失败：

```python
# error: sqlalchemy.exc.IntegrityError: (sqlite3.IntegrityError) UNIQUE
# constraint failed: post.id
# [SQL: INSERT INTO post (id, title) VALUES (?, ?)]
# [parameters: (1, 'second')]
# (Background on this error at: https://sqlalche.me/e/20/gkpj)


# ...


def main() -> None:
    """Commit one post, then try to commit another with the same id."""
    engine = sa.create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(PostRow(id=1, title="first"))
        session.commit()
    with Session(engine) as session:  # a new session: empty identity map
        session.add(PostRow(id=1, title="second"))
        session.commit()


if __name__ == "__main__":
    main()
```

```text
$ python3 lab/ch13/integrity_fail.py 2>&1 | tail -4
sqlalchemy.exc.IntegrityError: (sqlite3.IntegrityError) UNIQUE constraint failed: post.id
[SQL: INSERT INTO post (id, title) VALUES (?, ?)]
[parameters: (1, 'second')]
(Background on this error at: https://sqlalche.me/e/20/gkpj)
```

文件开头的注释是从真实的 `stderr` 里复制来的。关键在 `# a new session: empty identity map`：第二个会话的身份映射是空的，SQLAlchemy 在 Python 这一侧不知道 `id=1` 已经存在，没法提前报错，要等 `commit()` 的 `flush` 把 `INSERT` 真发给 SQLite，才由 `PRIMARY KEY` 约束拒绝。完整的回溯有 125 行（从 `Session.commit` 一路向下到 `cursor.execute`），上面只贴了最后 4 行，因为它们才是信息：`sqlalchemy.exc.IntegrityError` 包着 `sqlite3.IntegrityError`，后面是出错的 SQL 和参数，最后一行是 SQLAlchemy 自己的文档链接。按 SQLAlchemy 的约定，`flush` 失败之后要先 `rollback()` 才能继续用这个会话，前面 `lab_models` 里 `except` 中的 `session.rollback()` 就是为了这个。

## 接进 Sift：一个事务和一行日志

前面的零件拼起来，`db.py` 对外有七个函数：`open_db` 和 `session_scope` 管会话，`replace_documents`、`load_documents`、`load_document` 管文档，`log_query`、`recent_queries` 管查询日志。写文档的那个是这样：

```python
    finally:
        maker.kw["bind"].dispose()


def replace_documents(
    path: Path,
    pipeline: Sequence[str],
    fresh: Iterable[Document],
    digests: Mapping[int, str],
    *,
    drop: Collection[int] | None = None,
) -> None:
    """Store the pipeline names and the fresh documents, in one transaction.

    drop lists the doc ids to delete first (changed and deleted
    files); None deletes every document. digests maps a doc id to the
    sha256 of its file. The query log is never touched.
    """
    with session_scope(path) as session:
        if drop is None:
            session.execute(delete(DocumentRow))
        else:
            session.execute(
                delete(DocumentRow).where(DocumentRow.doc_id.in_(drop))
            )
        session.add_all(
```

`drop` 是要先删掉的 `doc_id`：增量更新时，变了的和被删的文件；`None` 表示整个重建，删光再写。`session_scope` 里的 `maker.begin()` 把“先删后写再合并 `pipeline` 这条元数据”放进了**同一个事务**：要么全成功，要么全不变。这是 `docs.json` 时代靠“写临时文件再 `os.replace`”才能做到的事，现在变成数据库自己的保证，也是最该用 SQLite 的地方。`session.merge(MetaRow(...))` 是“有这个主键就更新，没有就插入”，所以 `pipeline` 这一行不用自己先查（`merge` 会先发一条 `SELECT` 再决定插入还是更新）。

这个保证值不值，要看它真的会回滚。我写了一个脚本，让一次替换在写到一半的时候抛 `OSError`：

```python
"""Show that replace_documents is all or nothing."""

import sqlite3
import tempfile
from collections.abc import Iterator
from pathlib import Path

from sift.document import Document
from sift.storage.db import load_documents, replace_documents

PIPELINE = ["mixed", "nfkc", "stopwords"]
SOURCE = Path(".sift/sift.db")


def count(path: Path) -> int:
    """Return the number of rows in documents."""
    with sqlite3.connect(path) as conn:
        return conn.execute("SELECT count(*) FROM documents").fetchone()[0]


def explode_after(docs: list[Document], n: int) -> Iterator[Document]:
    """Yield n documents, then fail like a disk error would."""
    yield from docs[:n]
    raise OSError("disk went away")


def main() -> None:
    """Fill a database, fail halfway through a replace, count rows."""
    _, documents = load_documents(SOURCE)
    docs = list(documents.values())
    digests = {doc.doc_id: "0" * 64 for doc in docs}
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "sift.db"
        replace_documents(path, PIPELINE, docs[:100], digests)
        print(f"{'after the first write':<22}: {count(path)} rows")
        try:
            replace_documents(path, PIPELINE, explode_after(docs, 30), digests)
        except OSError as error:
            print(f"{'replace raised':<22}: {error}")
        print(f"{'after the failed write':<22}: {count(path)} rows")
        replace_documents(path, PIPELINE, docs[100:], digests, drop=[0, 1])
        label = f"drop 2, add {len(docs[100:])}"
        print(f"{label:<22}: {count(path)} rows")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/db_atomic.py
after the first write : 100 rows
replace raised        : disk went away
after the failed write: 100 rows
drop 2, add 23        : 121 rows
```

第二次写入先 `DELETE` 了全部 100 行，再往里加了 30 篇，然后生成器抛了异常；回滚以后表里还是 100 行，一行没丢。最后一行验证增量路径：删 2 个 `doc_id`，加 23 篇，100 − 2 + 23 = 121。

`store.py` 里调它的是 `_write_documents`，它还要回答一个问题：写不进去，是文件坏了，还是文件只是暂时不能写？这两种情况要求完全相反的处理，下面的缺口一节会讲。

`cli.py` 这一章的改动很小：`sift stats` 多打印一段查询日志，`sift search` 在打印结果之前尝试追加一行，写不进去只警告：

```python
def print_recent_queries(directory: Path, limit: int = 10) -> None:
    """Print the last limit logged queries, newest first."""
    rows = recent_queries(directory / DB, limit)
    if not rows:
        print("no queries logged")
        return
    print(f"last {len(rows)} queries:")
    for row in rows:
        stamp = row.at.strftime("%Y-%m-%d %H:%M:%S")
        print(
            f"{stamp} UTC  {row.total:>5} hits  "
            f"{row.took_ms:>8.3f} ms  {row.query}"
        )
    # ...
    if not args.no_log:
        try:
            log_query(directory / DB, query, result.total, result.took_ms)
        except SiftError:
            # the error text can hold the query: say only where
            print(
                f"sift: warning: query not logged, cannot write "
                f"{directory / DB}",
                file=sys.stderr,
            )
    if args.json:
```

查询是用户输入，进数据库走的是参数绑定，注入那一节的结论在这里也成立：`tests/test_db.py` 里 `test_hostile_queries_are_stored_verbatim` 把 5 个恶意字符串（`'; DROP TABLE query_log; --`、`x' OR '1'='1` 等）当查询存进日志，`test_hostile_document_fields_are_data` 把 `'); DROP TABLE documents; --` 当标题存进去，都原样读回，表还在。

`sift show` 也跟着变了。上一版的 `find_document` 调 `load_documents`，把 123 篇正文全读出来、全转成 `Document`，只为取一篇；现在 `db.py` 多了一个函数：

```python
        raise IndexCorruptError(f"{path}: bad database: {error}") from None
    return names, documents


def load_document(path: Path, doc_id: int) -> Document | None:
    """Return the document with doc_id, or None if there is none.

    Only that row is read. Raise IndexCorruptError like
    load_documents.
    """
    if not path.is_file():
        raise IndexCorruptError(f"{path}: bad database: file is missing")
    try:
        with session_scope(path) as session:
```

`session.get(DocumentRow, doc_id)` 按主键只取一行（前面 `EXPLAIN` 里的 `SEARCH ... INTEGER PRIMARY KEY`），`cli.py` 的 `find_document` 现在调它。我只用测试固定了行为：`test_show_reads_one_document` 和 `test_load_document_reads_one_row` 钉住，没有测它省了多少毫秒。

上一篇结尾问过：`sqlite3` 和 SQLAlchemy 各要多少行代码。我没有把存储层再用纯 `sqlite3` 写一遍，没法严格对比，只有这一章自己的账：

```text
$ git diff --numstat ch12 ch13 -- src/sift
38	10	src/sift/cli.py
297	0	src/sift/storage/db.py
1	1	src/sift/storage/segment.py
71	66	src/sift/storage/store.py
```

`db.py` 新增 297 行，其中模块文档 30 行；`store.py` 加 71 行、删 66 行，删掉的主要是手写的 `save_docs` 和 `load_docs`（逐字段拼字典，再逐字段解析回来）。整个 `src/sift` 净增 330 行。

### 三个缺口，修了两个

下面三个行为是我在第一版（提交 `ece976c`）上找到的。前两个后来在仓库里修掉了，所以每处我都对着旧代码（`git archive ece976c` 导出到 `/tmp/ece`）和现在的 `ch13` 各跑一遍：

```text
$ rm -rf /tmp/ece && mkdir /tmp/ece
$ git archive ece976c | tar -x -C /tmp/ece && \
    ln -s $PWD/corpus /tmp/ece/corpus
```

**第一，日志写不进去，搜索就失败。** 把 `sift.db` 变成只读（比如索引放在一个只读的共享目录里）：

```text
$ rm -rf /tmp/ro && cp -r .sift /tmp/ro
$ chmod 444 /tmp/ro/sift.db
$ (cd /tmp/ece && SIFT_INDEX=/tmp/ro \
    PYTHONPATH=src python3 -m sift search kalman 2>&1 | sed -n 1p)
error: cannot log the query in /tmp/ro/sift.db: (sqlite3.OperationalError) attempt to write a readonly database
$ (cd /tmp/ece && SIFT_INDEX=/tmp/ro \
    PYTHONPATH=src python3 -m sift search kalman >/dev/null 2>&1; echo exit $?)
exit 1
$ SIFT_INDEX=/tmp/ro sift search kalman 2>&1 >/dev/null
sift: warning: query not logged, cannot write /tmp/ro/sift.db
$ SIFT_INDEX=/tmp/ro sift search kalman | tail -1; echo exit ${PIPESTATUS[0]}
8 hits in 123 files: index opened in 133.6 ms, query took 108.994 ms
exit 0
sift: warning: query not logged, cannot write /tmp/ro/sift.db
```

旧版的 `sift search` 在打印结果之前先去写日志，失败就整条命令以退出码 1 结束，错误消息还带着完整的 SQL 和参数，包括查询文本。现在 `run_search` 捕获 `SiftError`，只往 `stderr` 打一行 `sift: warning: query not logged, cannot write <路径>`，不带查询文本（注释里写了原因：错误文本里可能有查询），结果照常打印，退出码 0。`tests/test_cli.py` 里 `test_read_only_database_does_not_fail_the_search` 和 `test_unwritable_log_does_not_fail_the_search` 钉住了这一点。

**第二，坏了的数据库被重建时，查询日志会一起消失。** 我把 `sift.db` 的前 16 个字节改成 `X`（文件的其余部分原封不动，所以日志其实还在里面），然后重建。先看旧版：

```text
$ rm -rf /tmp/bad && cp -r .sift /tmp/bad
$ (cd /tmp/ece && PYTHONPATH=src SIFT_INDEX=/tmp/bad python3 -m sift search kalman | tail -1)
8 hits in 123 files: index opened in 134.7 ms, query took 107.905 ms
$ printf 'XXXXXXXXXXXXXXXX' | dd of=/tmp/bad/sift.db bs=1 conv=notrunc 2>/dev/null
$ (cd /tmp/ece && PYTHONPATH=src SIFT_INDEX=/tmp/bad python3 -m sift index 2>&1 | grep replacing)
WARNING sift.storage.store: replacing the unusable database /tmp/bad/sift.db
$ ls /tmp/bad
manifest.json
segment.sft
sift.db
$ (cd /tmp/ece && PYTHONPATH=src SIFT_INDEX=/tmp/bad python3 -m sift stats | tail -1)
no queries logged
```

旧版的 `_write_documents` 在 `DatabaseError` 之后 `path.unlink()`，删掉的不只是 `documents`，还有 `query_log`：日志是这个文件里唯一**无法从语料重新算出来**的东西，却和能重算的东西住在同一个文件里，一起被删了。现在同一件事：

```text
$ rm -rf /tmp/bad && cp -r .sift /tmp/bad
$ (SIFT_INDEX=/tmp/bad sift search kalman | tail -1)
8 hits in 123 files: index opened in 135.5 ms, query took 108.069 ms
$ printf 'XXXXXXXXXXXXXXXX' | dd of=/tmp/bad/sift.db bs=1 conv=notrunc 2>/dev/null
$ (SIFT_INDEX=/tmp/bad sift index 2>&1 | grep replacing)
WARNING sift.storage.store: replacing the unusable database /tmp/bad/sift.db
$ ls /tmp/bad
manifest.json
segment.sft
sift.db
sift.db.corrupt
$ (SIFT_INDEX=/tmp/bad sift stats | tail -1)
no queries logged
$ printf 'SQLite format 3\0' | dd of=/tmp/bad/sift.db.corrupt bs=1 conv=notrunc 2>/dev/null
$ sqlite3 /tmp/bad/sift.db.corrupt 'SELECT count(*) FROM query_log'
1
```

现在的 `_write_documents` 改成 `path.replace(path.with_name(path.name + ".corrupt"))`：坏文件被改名成 `sift.db.corrupt`（已有旧的就覆盖），新的 `sift.db` 照常重建。`sift stats` 仍然说 `no queries logged`，因为那是新数据库；但日志没有丢：把那 16 个字节补回去 (`SQLite format 3`)，`sqlite3` 就能打开 `sift.db.corrupt`，里面有 3 条查询。这是一个人工的恢复步骤，不是自动合并，我没有做自动合并。

**第二（续）：“写不进去”不等于“坏了”。** 这个改动的第一版有一个 bug：它捕获的是 `DatabaseError`，而“数据库被锁住”和“数据库只读”也是它的子类 (`OperationalError`)，于是一个完好的、只是暂时不能写的 `sift.db` 也会被改名成 `.corrupt`，然后从头重建。现在 `store.py` 把两类错误分开（`_is_corrupt` 在第 59 到 70 行，`_write_documents` 在第 72 到 105 行，下面是它的后半段）：

```python
    fresh = list(fresh)
    try:
        replace_documents(path, pipeline, fresh, digests, drop=drop)
    except DatabaseError as error:
        code = getattr(error.orig, "sqlite_errorcode", None)
        if code is not None and code & 0xFF in (_BUSY, _READONLY):
            reason = "locked" if code & 0xFF == _BUSY else "read-only"
            raise SiftError(
                f"cannot write {path}: database is {reason}"
            ) from None
        if drop is not None or not _is_corrupt(error):
            raise
        logger.warning("replacing the unusable database %s", path)
        path.replace(path.with_name(path.name + ".corrupt"))
        replace_documents(path, pipeline, fresh, digests, drop=None)
```

SQLite 在异常的 `sqlite_errorcode` 里给出原因，低 8 位是主错误码：`SQLITE_BUSY` (5) 和 `SQLITE_READONLY` (8) 抛 `SiftError`，文件原封不动；只有 `SQLITE_CORRUPT` (11)、`SQLITE_NOTADB` (26)，或者“no such column / no such table”（模型和库对不上）才改名重试。`db.py` 里还多了一个 `BUSY_TIMEOUT = 5.0`，作为 `connect_args` 的 `timeout` 交给 `sqlite3`，所以遇到锁会先等 5 秒再放弃。我写了一个脚本，把索引复制两份，一份改成只读，一份用 `BEGIN IMMEDIATE` 锁住，然后各跑一次 `sift index --full`：

```python
"""Run sift index on a read-only and on a locked sift.db."""

import os
import shutil
import sqlite3
import subprocess
import time
from pathlib import Path

INDEX = Path(".sift")


def run_index(work: Path) -> None:
    """Run ``sift index --full`` on work and describe what happened."""
    start = time.perf_counter()
    proc = subprocess.run(
        ["sift", "index", "--full"],
        env={**os.environ, "SIFT_INDEX": str(work)},
        capture_output=True,
        text=True,
    )
    took = time.perf_counter() - start
    lines = proc.stderr.strip().splitlines()
    print(f"  exit {proc.returncode} after {took:.1f} s")
    print("  stderr:", lines[-1] if lines else "(empty)")
    print("  .corrupt file:", (work / "sift.db.corrupt").exists())
    with sqlite3.connect(f"file:{work / 'sift.db'}?mode=ro", uri=True) as db:
        count = db.execute("SELECT count(*) FROM documents").fetchone()[0]
    print("  documents in sift.db:", count)


def main() -> None:
    """Copy the index twice and break each copy in a different way."""
    root = Path("/tmp/sift-fail")
    shutil.rmtree(root, ignore_errors=True)
    readonly = root / "readonly"
    shutil.copytree(INDEX, readonly)
    (readonly / "sift.db").chmod(0o444)
    print("read-only sift.db")
    run_index(readonly)

    locked = root / "locked"
    shutil.copytree(INDEX, locked)
    holder = sqlite3.connect(locked / "sift.db", isolation_level=None)
    holder.execute("BEGIN IMMEDIATE")
    print("sift.db locked by BEGIN IMMEDIATE")
    run_index(locked)
    holder.execute("ROLLBACK")
    holder.close()


if __name__ == "__main__":
    main()
```

```text
$ sift index | tail -1
incremental: parsed 0, unchanged 123, removed 0; segment 2880196 bytes; took 30.7 ms
$ python3 /tmp/sift-scratch/write_failures.py
read-only sift.db
  exit 1 after 3.5 s
  stderr: error: cannot write /tmp/sift-fail/readonly/sift.db: database is read-only
  .corrupt file: False
  documents in sift.db: 123
sift.db locked by BEGIN IMMEDIATE
  exit 1 after 8.7 s
  stderr: error: cannot write /tmp/sift-fail/locked/sift.db: database is locked
  .corrupt file: False
  documents in sift.db: 123
```

两份都以退出码 1 结束，错误消息说清了原因，没有 `.corrupt` 文件，`sift.db` 里的 123 篇文档原封不动。被锁的那份花了 8.7 秒：约 3 秒是重建索引，5 秒是等锁。`tests/test_store.py` 里有对应的测试，增量更新也走同一条路。

**第三，三个文件的更新不是原子的。** 这个缺口没有修。它和第 12 篇留下的是同一个：段文件先写、数据库再写、清单最后写，每一步各自原子，三步合起来不是。`db.py` 的模块文档说崩在中间会留下旧清单，下一次 `sift index` 重做；但在崩溃和重做之间，`sift search` 看到的是新段文件配旧数据库。我没有去构造这个崩溃，是读代码看出来的。

测试方面，这一章新增 `tests/test_db.py` 的 25 个测试，`tests/test_cli.py` 从 42 个涨到 49 个（日志写入、`--no-log`、语法错误不记日志、`sift stats` 列最近 10 条、日志写不进去时搜索照常、`show` 只读一行），`tests/test_store.py` 从 22 个涨到 29 个（含坏数据库改名、只读和被锁）。

## 账单

数据库换了，文件小了 0.45%，每个命令的成本呢？我写了一个脚本，把第 12 篇的代码（用 `git archive ch12` 导出到 `/tmp/sift-ch12`）和这一章的代码放在同一份语料副本上轮流跑，每个量跑 9 轮，取最小值和中位数；这一章的 `sift search` 没有加 `--no-log`，所以日志写入也算在里面。它测三样东西：`sift search` 里“打开索引”那一段（命令自己打印的毫秒数）、整个进程的耗时（包括 Python 启动和 `import`）、改一个文件之后的 `sift index`：

```python
"""Compare ch12 (docs.json) and ch13 (sift.db) on open and update."""

import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path.cwd()
OLD = Path("/tmp/sift-ch12")  # git archive ch12 | tar -x -C /tmp/sift-ch12
ROUNDS = 9


def sift(root: Path, env: dict[str, str], *args: str) -> tuple[str, float]:
    """Run ``python3 -m sift`` in root; return stdout and wall ms."""
    start = time.perf_counter()
    out = subprocess.run(
        [sys.executable, "-m", "sift", *args],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return out, (time.perf_counter() - start) * 1000


def number(pattern: str, text: str) -> float:
    """Return the first group of pattern in text as a float."""
    match = re.search(pattern, text)
    assert match, text
    return float(match.group(1))


def main() -> None:
    """Alternate the two versions and print min and median."""
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        shutil.copytree(REPO / "corpus/posts", work / "posts")
        victim = sorted((work / "posts").glob("*.md"))[0]
        versions = {}
        for name, root in (("ch12", OLD), ("ch13", REPO)):
            env = dict(os.environ, SIFT_INDEX=str(work / name))
            env["PYTHONPATH"] = str(root / "src")
            versions[name] = (root, env)
            sift(root, env, "index", "--corpus", str(work / "posts"))
        opened = {name: [] for name in versions}
        wall = {name: [] for name in versions}
        update = {name: [] for name in versions}
        for i in range(ROUNDS):
            for name, (root, env) in versions.items():  # alternate
                out, ms = sift(root, env, "search", "--limit", "1", "kalman")
                opened[name].append(number(r"opened in ([\d.]+) ms", out))
                wall[name].append(ms)
            with victim.open("a", encoding="utf-8") as file:
                file.write(f"\nmarker {i}\n")
            order = list(versions) if i % 2 == 0 else list(versions)[::-1]
            for name in order:
                root, env = versions[name]
                args = ("index", "--corpus", str(work / "posts"))
                out, _ = sift(root, env, *args)
                update[name].append(number(r"took ([\d.]+) ms", out))
        for label, data in (
            ("index opened (ms)", opened),
            ("process wall (ms)", wall),
            ("one-file update (ms)", update),
        ):
            for name, values in data.items():
                print(
                    f"{label:<22}{name}  min {min(values):7.1f}  "
                    f"median {statistics.median(values):7.1f}"
                )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    python3 /tmp/sift-scratch/ch12_vs_ch13.py; \
    python3 /tmp/sift-scratch/cpu_state.py
112 116 112 113 114 ms
index opened (ms)     ch12  min   146.7  median   148.7
index opened (ms)     ch13  min   133.8  median   134.7
process wall (ms)     ch12  min   274.4  median   277.4
process wall (ms)     ch13  min   486.7  median   493.2
one-file update (ms)  ch12  min   627.2  median   631.2
one-file update (ms)  ch13  min   601.0  median   606.8
112 113 113 113 113 ms
```

- 打开索引（命令自己计时）：第 12 篇 148.7 毫秒，这一章 134.7 毫秒，快了 14 毫秒。我猜节省来自读文档：4.4 MB 的 JSON 整个解析，换成数据库里的 123 行，没有拆开量。
- 改一个文件之后的增量更新：631.2 毫秒到 606.8 毫秒，快了 24 毫秒。原来要重写整个 `docs.json`，现在只删一行、插一行。
- **整个进程**：277.4 毫秒到 493.2 毫秒，**慢了 216 毫秒**。

最后一项比前面两项加起来还大得多，也是我在这一章开头说“比我预想的贵”的原因：命令内部明明更快，用户感受到的却更慢了。差额的大头只可能出在命令计时开始之前，也就是 `import`（日志写入发生在计时之后）：

```text
$ for m in sqlite3 json sqlalchemy sqlalchemy.orm sift.storage.db; do \
    python3 -X importtime -c "import $m" 2>&1 | tail -1; done
import time:       144 |       1670 | sqlite3
import time:       186 |       4295 | json
import time:       509 |     156525 | sqlalchemy
import time:       489 |     204026 | sqlalchemy.orm
import time:      5192 |     217309 | sift.storage.db
```

`-X importtime` 的第二列是累计微秒。`sqlite3` 1.7 毫秒，`json` 4.3 毫秒，`sqlalchemy` 156.5 毫秒，`sqlalchemy.orm` 204.0 毫秒，`sift.storage.db`（它 `import` 了 `sqlalchemy`、`sqlalchemy.orm` 和 `sift` 自己的几个模块）217.3 毫秒。217 毫秒的导入和实测的 216 毫秒差额在同一个量级，剩下的几毫秒是打开索引变快和日志写入（一次 `INSERT` 加提交）互相抵消后的零头，我没有再拆。`sqlite3` 是一个 C 扩展加几百行 Python；`sqlalchemy` 是个大包，导入时要把表达式语言、方言、事件系统和 ORM 的元类全部建起来。`docs.json` 时代没有这笔成本。

所以账是这样的：这一章没有让任何一个具体操作变慢，但 `import sqlalchemy` 让每条命令固定多花了 0.2 秒，对原来 277 毫秒的命令来说约 78%。我愿意接受这个代价，但不会假装它不存在。读路径只用 `sqlite3`、写路径才用 SQLAlchemy，`--no-log` 的搜索就能躲开这笔账（默认的 `sift search` 还要写日志，所以躲不开），这是练习 3。

## 迁移：模型变了怎么办

`Base.metadata.create_all(engine)` 只会建**缺的表**，从来不改**已有的表**：给 `DocumentRow` 加一列，老用户的 `sift.db` 里不会长出这一列，查询会直接报 `no such column`。正经的做法是迁移 (migration)：把“从版本 N 到 N+1 要执行的 DDL”写成有版本号的脚本，按顺序执行。SQLAlchemy 的作者写了专门的工具 Alembic：`alembic init` 生成一个目录，`env.py` 里把 `target_metadata` 指向 `Base.metadata`，`alembic revision --autogenerate` 比较模型和真实的数据库，生成一个带 `upgrade()` 和 `downgrade()` 的 Python 脚本，`alembic upgrade head` 依次执行。SQLite 的 `ALTER TABLE` 能力有限，按 Alembic 的文档，它有一个“批处理”模式，用“建新表、拷数据、删旧表、改名”的办法绕过去。这一段我是照文档写的：Alembic 不在这个 flake 里，`python3 -c 'import alembic'` 报 `ModuleNotFoundError`，所以我没有跑过它。

Sift 目前的办法更土：`sift.db` 里除了查询日志，都能从语料重算，模型不对就报 `IndexCorruptError`，`sift index` 整个重建。这个办法在前面第二个缺口那里漏了水，所以如果哪天 `query_log` 的结构要变，我大概会先去装 Alembic。

## 跑一遍

整章一个 `make` 目标，加 `make lint` 和完整的测试：

```text
$ make lint
ruff format --check --line-length 79 .
236 files already formatted
ruff check .
All checks passed!
$ make ch13 2>&1 | grep -E "^ok"
ok   lab/ch13/adapters.py
ok   lab/ch13/explain_query_plan.py
ok   lab/ch13/fts5_compare.py
ok   lab/ch13/integrity_fail.py
ok   lab/ch13/n_plus_one.py
ok   lab/ch13/sql_injection.py
ok   lab/ch13/sqlalchemy_core.py
ok   lab/ch13/sqlalchemy_orm.py
ok   lab/ch13/sqlite3_basics.py
$ python3 -m pytest 2>&1 | tail -1
489 passed, 1 xfailed in 11.12s
$ python3 -m pytest tests/test_db.py 2>&1 | tail -1
25 passed in 1.49s
$ git diff --shortstat ch12 ch13
 18 files changed, 1843 insertions(+), 99 deletions(-)
```

测试从 450 个涨到 489 个，新增的 39 个是前面说的 25 加 7 加 7。

## 本篇文件

这一章动了 18 个文件（`git diff --shortstat ch12 ch13` 的 `18 files changed`）：9 个是 `lab/ch13` 下的脚本，4 个源码文件 (`db.py`, `store.py`, `cli.py`, `segment.py`)，`pyproject.toml` 和 `README.md`，以及 3 个测试文件。上面贴的 `/tmp/sift-scratch/` 里的脚本不在表里，它们不进仓库。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`src/sift/storage/db.py`](https://github.com/bfmhno3/sift/blob/ch13/src/sift/storage/db.py) | `python3 -c 'from sift.storage.db import DocumentRow; print(DocumentRow.__tablename__, len(DocumentRow.__table__.c))'` | 退出码 0，输出 `documents 10` |
| [`src/sift/storage/store.py`](https://github.com/bfmhno3/sift/blob/ch13/src/sift/storage/store.py) | `sift index \| tail -1` | 退出码 0，最后一行以 `incremental: parsed 0, unchanged 123, removed 0` 开头（索引已建好时） |
| [`src/sift/cli.py`](https://github.com/bfmhno3/sift/blob/ch13/src/sift/cli.py) | `sift search --help \| grep -e '^  --no-log'` | 退出码 0，输出 `  --no-log       do not log the query in sift.db` |
| [`src/sift/storage/segment.py`](https://github.com/bfmhno3/sift/blob/ch13/src/sift/storage/segment.py) | `git diff --shortstat ch12 ch13 -- src/sift/storage/segment.py` | 退出码 0，` 1 file changed, 1 insertion(+), 1 deletion(-)`（只改了一行文档注释） |
| [`pyproject.toml`](https://github.com/bfmhno3/sift/blob/ch13/pyproject.toml) | `python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["project"]["dependencies"])'` | 退出码 0，输出 `['sqlalchemy>=2.0.51']` |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch13/README.md) | `git diff --shortstat ch12 ch13 -- README.md` | 退出码 0，` 1 file changed, 1 insertion(+), 1 deletion(-)` |
| [`tests/test_db.py`](https://github.com/bfmhno3/sift/blob/ch13/tests/test_db.py) | `python3 -m pytest tests/test_db.py \| tail -1` | 退出码 0，`25 passed` |
| [`tests/test_store.py`](https://github.com/bfmhno3/sift/blob/ch13/tests/test_store.py) | `python3 -m pytest tests/test_store.py \| tail -1` | 退出码 0，`29 passed`（上一章 22 个） |
| [`tests/test_cli.py`](https://github.com/bfmhno3/sift/blob/ch13/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py \| tail -1` | 退出码 0，`49 passed`（上一章 42 个） |
| [`lab/ch13/sqlite3_basics.py`](https://github.com/bfmhno3/sift/blob/ch13/lab/ch13/sqlite3_basics.py) | `python3 lab/ch13/sqlite3_basics.py` | 退出码 0，第一行 `apilevel     : 2.0`，最后一行 `isolation_level=None -> autocommit: -1` |
| [`lab/ch13/sql_injection.py`](https://github.com/bfmhno3/sift/blob/ch13/lab/ch13/sql_injection.py) | `python3 lab/ch13/sql_injection.py` | 退出码 0，第一行 `input 'alice'`，最后一行 `   executescript -> no such table: notes` |
| [`lab/ch13/adapters.py`](https://github.com/bfmhno3/sift/blob/ch13/lab/ch13/adapters.py) | `python3 lab/ch13/adapters.py` | 退出码 0，第一行 `default adapter (deprecated since 3.12)`，最后一行以 `round trip   : datetime.datetime(2026, 10, 23, 8, 30` 开头 |
| [`lab/ch13/fts5_compare.py`](https://github.com/bfmhno3/sift/blob/ch13/lab/ch13/fts5_compare.py) | `python3 lab/ch13/fts5_compare.py` | 退出码 0，第一行 `sqlite 3.53.3`，最后一行以 `trigram: mean Jaccard 0.766 over 12 queries` 开头；计时每次不同，约 25 秒 |
| [`lab/ch13/sqlalchemy_core.py`](https://github.com/bfmhno3/sift/blob/ch13/lab/ch13/sqlalchemy_core.py) | `python3 lab/ch13/sqlalchemy_core.py` | 退出码 0，第一行 `sqlalchemy 2.0.51`，最后一行 `rows after the rolled back delete: 123` |
| [`lab/ch13/sqlalchemy_orm.py`](https://github.com/bfmhno3/sift/blob/ch13/lab/ch13/sqlalchemy_orm.py) | `python3 lab/ch13/sqlalchemy_orm.py` | 退出码 0，第一行 `lab models`，最后一行以 `columns: ['doc_id', 'path', 'title'` 开头 |
| [`lab/ch13/n_plus_one.py`](https://github.com/bfmhno3/sift/blob/ch13/lab/ch13/n_plus_one.py) | `python3 lab/ch13/n_plus_one.py` | 退出码 0，第一行 `123 posts in the database`，最后一行 `  InvalidRequestError: 'PostRow.tags' is not available due to lazy='raise'` |
| [`lab/ch13/explain_query_plan.py`](https://github.com/bfmhno3/sift/blob/ch13/lab/ch13/explain_query_plan.py) | `python3 lab/ch13/explain_query_plan.py` | 退出码 0，第一行 `sqlite 3.53.3`，最后一行 `     -> SCAN query_log` |
| [`lab/ch13/integrity_fail.py`](https://github.com/bfmhno3/sift/blob/ch13/lab/ch13/integrity_fail.py) | `python3 lab/ch13/integrity_fail.py` | 退出码 1：`sqlalchemy.exc.IntegrityError: (sqlite3.IntegrityError) UNIQUE constraint failed: post.id`（文件里有对应的 `# error:` 注释，标准输出为空） |

## 练习

**1.** `sift.db.corrupt` 现在每次重建都会覆盖上一份。写一个小函数，把坏文件里还读得出的 `query_log` 行并进新的 `sift.db`（先试着修复文件头，再用 `sqlite3` 的 `ATTACH DATABASE`），并想想：自动做这件事，会不会把本来该报警的损坏悄悄吞掉？

**2.** `sift search` 打开索引时仍然读全部 123 篇正文，因为 `Searcher` 只在建片段时才要正文。让文档按需从 `sift.db` 取（`load_document` 已经有了），测打开索引那一段耗时，并看前面 FTS5 一节里的片段耗时会不会因此变化。

**3.** 账单里 `import sqlalchemy` 占了 200 多毫秒。把读路径 (`load_documents`, `recent_queries`) 改成只用标准库 `sqlite3`，写路径留在 SQLAlchemy，并让 `sqlalchemy` 只在写的时候才被导入。测 `sift search --no-log kalman` 的整个进程耗时，对照 277.4 毫秒。两套代码读写同一张表，列的定义要写两遍，怎么保证它们不漂移？

## 下一篇

下一篇是《类型系统：从注解到 mypy --strict》。这一章的 `db.py` 里，类型注解已经不只是文档：`Mapped[str | None]` 既是列的定义也是类型，`session_scope` 的返回类型是 `Iterator[Session]`，`TypeDecorator[datetime]` 带着一个类型参数。我想知道的是：把整个 `src/sift` 都交给 `mypy --strict` 和 `pyright` 会各自抱怨多少次，这些抱怨里有多少是真的 bug，又有多少只是我没把类型说清楚。
