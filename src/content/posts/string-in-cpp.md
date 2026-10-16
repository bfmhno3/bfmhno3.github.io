---
title: "C++ 中的 string 详解"
commentId: "post:string-in-cpp"
published: "2026-01-03 16:28:00 +08:00"
updated: 2026-10-16
description: "把 std::string 从头讲到尾：构造与赋值、元素访问、容量、修改、查找、比较、数值转换、string_view、编码，再到 SSO、移动语义和迭代器失效。全部示例在 GCC 15.3.0 (libstdc++) 和 Clang 21.1.8 (libc++) 上用 -std=c++23 编译运行。"
category: Note
tags:
  - C++
  - string
  - 标准库
series: "C++ 日拱一卒"
seriesOrder: 1
draft: false
comment: true
---

这是《C++ 日拱一卒》的第 1 篇，目标很具体：把 `std::string` 一次学完整。读完之后，cppreference 上 `std::basic_string` 页面里的每个成员函数你都应该看得懂，知道它的坑在哪，也知道它在内存里长什么样。

读法：每一节先说这组函数解决什么问题，再给一个能直接编译的程序和它的真实输出，最后总结要记住的规则。所有程序都用 `g++ 15.3.0 -std=c++23 -Wall -Wextra -O2` 编译运行 (libstdc++)，同时也用 Clang 21.1.8 加 libc++ 跑了一遍，两边结果不同的地方我会指出来。代码按 Google C++ Style 排版，用 `clang-format --style=Google` 检查过。需要特定标准的函数会标注 (C++17)、(C++20)、(C++23)。

## 1. string 是什么

`std::string` 不是一个独立的类，而是类模板 `std::basic_string` 的别名：

```cpp
template <class CharT, class Traits = std::char_traits<CharT>,
          class Allocator = std::allocator<CharT>>
class basic_string;
```

三个模板参数分别决定字符是什么类型、字符怎么比较和拷贝 (`Traits`)、内存从哪里来 (`Allocator`)。标准库给常用的字符类型各起了一个别名：

| 别名 | 字符类型 | 说明 |
| --- | --- | --- |
| `std::string` | `char` | 最常用，本文的主角 |
| `std::wstring` | `wchar_t` | 宽度由平台决定 |
| `std::u8string` (C++20) | `char8_t` | UTF-8 code unit |
| `std::u16string` | `char16_t` | UTF-16 code unit |
| `std::u32string` | `char32_t` | UTF-32 code unit |
| `std::pmr::string` (C++17) | `char` | 分配器换成 `polymorphic_allocator` |

```cpp
#include <iostream>
#include <memory_resource>
#include <string>
#include <type_traits>

static_assert(std::is_same_v<std::string, std::basic_string<char>>);
static_assert(std::is_same_v<std::wstring, std::basic_string<wchar_t>>);
static_assert(std::is_same_v<std::u8string, std::basic_string<char8_t>>);
static_assert(std::is_same_v<std::u16string, std::basic_string<char16_t>>);
static_assert(std::is_same_v<std::u32string, std::basic_string<char32_t>>);

static_assert(
    std::is_same_v<std::pmr::string,
                   std::basic_string<char, std::char_traits<char>,
                                     std::pmr::polymorphic_allocator<char>>>);

static_assert(std::is_same_v<std::string::value_type, char>);
static_assert(std::is_same_v<std::string::size_type, std::size_t>);
static_assert(std::is_same_v<std::string::difference_type, std::ptrdiff_t>);
static_assert(std::is_same_v<std::string::traits_type, std::char_traits<char>>);
static_assert(
    std::is_same_v<std::string::allocator_type, std::allocator<char>>);

int main() {
  std::cout << "sizeof(char)     = " << sizeof(char) << "\n";
  std::cout << "sizeof(wchar_t)  = " << sizeof(wchar_t) << "\n";
  std::cout << "sizeof(char8_t)  = " << sizeof(char8_t) << "\n";
  std::cout << "sizeof(char16_t) = " << sizeof(char16_t) << "\n";
  std::cout << "sizeof(char32_t) = " << sizeof(char32_t) << "\n";
  std::cout << "npos = " << std::string::npos << "\n";
}
```

```text
sizeof(char)     = 1
sizeof(wchar_t)  = 4
sizeof(char8_t)  = 1
sizeof(char16_t) = 2
sizeof(char32_t) = 4
npos = 18446744073709551615
```

`static_assert` 通过，说明上面这些别名和成员类型的关系都成立。`wchar_t` 在 Linux 上是 4 字节（据我所知在 Windows 上是 2 字节，这是 `wstring` 不适合跨平台文本的原因之一，我没有在 Windows 上验证）。`size_type` 是无符号的 `size_t`，`npos` 是它的最大值，后面会反复遇到。

先建立一个心智模型，后面所有行为都能从它推出来：

- string 是一个**对象**，里面记着三样东西：指向字符的指针、当前长度 (size)、已分配的容量 (capacity)。
- 字符存放在对象**自己拥有**的一块**连续**内存里。拷贝 string 就是拷贝这块内存（值语义），对象销毁时内存随之释放。
- 缓冲区末尾始终有一个 `'\0'`，所以可以安全地交给 C 接口。但长度是单独记录的，不靠 `'\0'` 判断，所以 string 中间可以含 `'\0'`。
- string 存的是 `char`，也就是**字节**，不是“字符”。它对编码一无所知，第 15 节专门讲这件事。

## 2. 构造与赋值

`std::string` 有十几种构造方式，按“从什么构造”分成这几类：

| 写法 | 含义 |
| --- | --- |
| `std::string s;` | 空串 |
| `std::string s(n, ch);` | `n` 个 `ch` |
| `std::string s(str, pos);` `std::string s(str, pos, len);` | 从另一个 string 的 `pos` 开始，取 `len` 个（缺省取到末尾） |
| `std::string s(ptr);` | 从以 `'\0'` 结尾的 C 字符串 |
| `std::string s(ptr, n);` | 从 `ptr` 开始取 `n` 个字符，不要求 `'\0'` 结尾 |
| `std::string s(first, last);` | 从迭代器区间 |
| `std::string s{'H', 'i'};` | 从 `initializer_list<char>` |
| `std::string s(other);` `std::string s(std::move(other));` | 拷贝 / 移动 |
| `std::string s(sv);` | 从 `string_view`（显式构造） |

```cpp
#include <iostream>
#include <string>
#include <string_view>
#include <utility>

using std::string_literals::operator""s;

void Show(const char* label, const std::string& s) {
  std::cout << label << " size=" << s.size() << " [" << s << "]\n";
}

int main() {
  std::string s1;
  std::string s2(5, 'A');
  std::string s3("Hello, World");
  std::string s4("Hello, World", 5);
  std::string s5(s3, 7);
  std::string s6(s3, 7, 3);
  std::string s7(s3.begin(), s3.begin() + 5);
  std::string s8{'H', 'i'};
  std::string s9(s3);
  std::string s10(std::move(s9));
  std::string s11(std::string_view("abcdef").substr(2, 3));

  Show("s1  default       ", s1);
  Show("s2  (5, 'A')      ", s2);
  Show("s3  const char*   ", s3);
  Show("s4  (ptr, 5)      ", s4);
  Show("s5  (str, 7)      ", s5);
  Show("s6  (str, 7, 3)   ", s6);
  Show("s7  iterator pair ", s7);
  Show("s8  {'H', 'i'}    ", s8);
  Show("s10 moved-to      ", s10);
  Show("s9  moved-from    ", s9);
  Show("s11 from view     ", s11);

  std::string t1(3, 'x');
  std::string t2{3, 'x'};
  std::cout << "t1: size=" << t1.size() << "\n";
  std::cout << "t2: size=" << t2.size()
            << ", first char code=" << static_cast<int>(t2[0]) << "\n";

  std::string u1 = "a\0b";
  std::string u2 = "a\0b"s;
  std::cout << "u1.size()=" << u1.size() << ", u2.size()=" << u2.size() << "\n";
}
```

```text
s1  default        size=0 []
s2  (5, 'A')       size=5 [AAAAA]
s3  const char*    size=12 [Hello, World]
s4  (ptr, 5)       size=5 [Hello]
s5  (str, 7)       size=5 [World]
s6  (str, 7, 3)    size=3 [Wor]
s7  iterator pair  size=5 [Hello]
s8  {'H', 'i'}     size=2 [Hi]
s10 moved-to       size=12 [Hello, World]
s9  moved-from     size=0 []
s11 from view      size=3 [cde]
t1: size=3
t2: size=2, first char code=3
u1.size()=1, u2.size()=3
```

这一节有三个坑，都写在程序的后半段里：

**`{}` 和 `()` 不一样。** `std::string t1(3, 'x')` 是三个 `'x'`，但 `std::string t2{3, 'x'}` 优先匹配 `initializer_list<char>`，`3` 被当成字符码，得到的是长度为 2 的串，第一个字符的编码是 3。输出里 `t2` 的 size 是 2，`t2[0]` 是 3，就是这么来的。

**字面量里的 `'\0'`。** `std::string u1 = "a\0b"` 走的是 `const char*` 构造，到第一个 `'\0'` 就停了，size 是 1。要得到 3，用 `"a\0b"s`（C++14，`operator""s`，需要 `using std::string_literals::operator""s;`），或者 `std::string("a\0b", 3)`。

**不要用空指针构造。** `std::string(nullptr)` 是未定义行为。C++23 把这个构造函数显式 `= delete` 了，所以 `std::string s = nullptr;` 在 `-std=c++23` 下直接编译失败：

```text
error: use of deleted function ‘std::basic_string<...>::basic_string(std::nullptr_t)’
```

我同样的代码用 `-std=c++20` 编译，是能通过的（运行时才出事）。

被移动之后的 string（程序里的 `s9`）处于“有效但未指定”的状态。libstdc++ 和 libc++ 在这里都给了空串，但别依赖这一点，要复用就先给它重新赋值。

赋值有三个 `operator=`（接受 string、`const char*`、单个 `char`、`initializer_list`），外加 `assign()`。`assign()` 的重载和构造函数基本对应，区别只是作用在已有对象上：

```cpp
#include <iostream>
#include <string>
#include <string_view>

int main() {
  std::string s;
  s = "text";
  std::cout << "operator=(const char*): " << s << "\n";
  s = 'c';
  std::cout << "operator=(char):        " << s << "\n";
  s = {'a', 'b', 'c'};
  std::cout << "operator=(init list):   " << s << "\n";

  s.assign(5, 'z');
  std::cout << "assign(5, 'z'):         " << s << "\n";
  s.assign("Hello, World", 5);
  std::cout << "assign(ptr, 5):         " << s << "\n";
  s.assign(std::string("Hello, World"), 7, 5);
  std::cout << "assign(str, 7, 5):      " << s << "\n";
  s.assign(std::string_view("abcdef").substr(1, 3));
  std::cout << "assign(view):           " << s << "\n";
}
```

```text
operator=(const char*): text
operator=(char):        c
operator=(init list):   abc
assign(5, 'z'):         zzzzz
assign(ptr, 5):         Hello
assign(str, 7, 5):      World
assign(view):           bcd
```

## 3. 访问元素

| 函数 | 越界时 | 说明 |
| --- | --- | --- |
| `s[i]` | 未定义行为（`i == size()` 除外） | 不检查，最快 |
| `s.at(i)` | 抛 `std::out_of_range` | 检查 `i < size()` |
| `s.front()` / `s.back()` | 空串上未定义行为 | 首尾字符的引用 |
| `s.data()` | | 指向首字符的指针，C++17 起有非 const 版本，可以写 |
| `s.c_str()` | | 只读指针，和 `data()` 指向同一处，以 `'\0'` 结尾 |
| `std::string_view(s)` | | 隐式转换为 `string_view` |

```cpp
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>

int main() {
  std::string s = "Hello";

  std::cout << "s[1]       = " << s[1] << "\n";
  std::cout << "s.at(1)    = " << s.at(1) << "\n";
  std::cout << "front/back = " << s.front() << "/" << s.back() << "\n";
  std::cout << "s[size()]  = " << static_cast<int>(s[s.size()]) << "\n";

  try {
    [[maybe_unused]] char c = s.at(10);
  } catch (const std::out_of_range& e) {
    std::cout << "at(10) threw: " << e.what() << "\n";
  }

  s.front() = 'J';
  s[s.size() - 1] = 'y';
  std::cout << "after edits: " << s << "\n";

  char* p = s.data();
  p[1] = 'E';
  std::cout << "via data():  " << s << "\n";

  const char* c = s.c_str();
  std::cout << "c_str():     " << c
            << ", c[size()] is NUL: " << (c[s.size()] == '\0') << "\n";

  std::string_view sv = s;
  std::cout << "view:        " << sv << " (size " << sv.size() << ")\n";
}
```

```text
s[1]       = e
s.at(1)    = e
front/back = H/o
s[size()]  = 0
at(10) threw: basic_string::at: __n (which is 10) >= this->size() (which is 5)
after edits: Jelly
via data():  JElly
c_str():     JElly, c[size()] is NUL: 1
view:        JElly (size 5)
```

几点说明：

- `s[s.size()]` 是合法的，返回 `'\0'`（输出里的 `0`）。只读它没问题，往里写任何非 `'\0'` 的值是未定义行为。
- C++11 起 `data()` 和 `c_str()` 都保证以 `'\0'` 结尾，两者等价（`data()` 另有可写的重载）。旧资料里“`data()` 不保证 `'\0'`”已经过时。
- `at()` 的异常信息是实现自己定的：libstdc++ 会写出下标和长度，libc++ 只写 `basic_string`。不要解析 `what()` 的内容。
- `c_str()` 和 `data()` 返回的指针，在 string 被修改或销毁之后就不能再用了，见第 13 节。

## 4. 迭代器与算法

string 提供 `begin()`/`end()`、`cbegin()`/`cend()`、`rbegin()`/`rend()`、`crbegin()`/`crend()`。迭代器是随机访问的，C++20 起还是 `contiguous_iterator`，也就是元素在内存里真的是一个挨一个排的。所以标准算法都能直接用：

```cpp
#include <algorithm>
#include <cctype>
#include <iostream>
#include <iterator>
#include <string>

int main() {
  std::string s = "Hello, World";

  for (char c : s) std::cout << c << ' ';
  std::cout << "\n";

  for (auto it = s.rbegin(); it != s.rend(); ++it) std::cout << *it;
  std::cout << "\n";

  for (char& c : s) {
    c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  }
  std::cout << "upper:   " << s << "\n";

  std::sort(s.begin(), s.end());
  std::cout << "sorted:  [" << s << "]\n";

  std::reverse(s.begin(), s.end());
  std::cout << "reverse: [" << s << "]\n";

  s.erase(std::remove(s.begin(), s.end(), ' '), s.end());
  std::cout << "no space:[" << s << "]\n";

  auto n = std::count(s.begin(), s.end(), 'L');
  std::cout << "count L: " << n << "\n";

  static_assert(std::contiguous_iterator<std::string::iterator>);
  std::cout << "contiguous: " << (&*(s.begin() + 1) == &*s.begin() + 1) << "\n";
}
```

```text
H e l l o ,   W o r l d
dlroW ,olleH
upper:   HELLO, WORLD
sorted:  [ ,DEHLLLOORW]
reverse: [WROOLLLHED, ]
no space:[WROOLLLHED,]
count L: 3
contiguous: 1
```

- 范围 `for` 是遍历的首选。需要改字符时写 `char&`。
- `std::toupper` 的参数是 `int`，必须是能用 `unsigned char` 表示的值（或 `EOF`）。`char` 在多数平台上有符号，直接传负数是未定义行为，所以要先 `static_cast<unsigned char>`。
- 删除所有等于某个值的字符，经典写法是 erase-remove：`s.erase(std::remove(s.begin(), s.end(), ' '), s.end())`。C++20 起可以直接 `std::erase(s, ' ')`，见第 6 节。
- 对 string 排序、反转都是按**字节**操作，遇到 UTF-8 多字节字符会破坏数据，见第 15 节。

## 5. 容量

| 函数 | 作用 |
| --- | --- |
| `size()` / `length()` | 字符个数，完全等价 |
| `empty()` | 是否为空，比 `size() == 0` 更直白 |
| `max_size()` | 理论上限，没有实际意义 |
| `capacity()` | 不重新分配内存就能容纳的字符数，始终 `>= size()` |
| `reserve(n)` | 保证 `capacity() >= n`，只会增长 |
| `shrink_to_fit()` | 请求释放多余内存，不保证成功 |
| `resize(n)` / `resize(n, ch)` | 改变 size，变长时用 `'\0'` 或 `ch` 填充 |
| `resize_and_overwrite(n, op)` (C++23) | 让你直接往缓冲区里写，最后再确定 size |

```cpp
#include <cstdio>
#include <iostream>
#include <string>

void Show(const char* what, const std::string& s) {
  std::cout << what << ": size=" << s.size() << " capacity=" << s.capacity()
            << "\n";
}

int main() {
  std::string s = "hello";
  Show("initial       ", s);
  std::cout << "empty()=" << s.empty()
            << " length()==size(): " << (s.length() == s.size()) << "\n";
  std::cout << "max_size()=" << s.max_size() << "\n";

  s.reserve(100);
  Show("reserve(100)  ", s);
  s.reserve(10);
  Show("reserve(10)   ", s);
  s.shrink_to_fit();
  Show("shrink_to_fit ", s);

  s.resize(8, '!');
  Show("resize(8,'!') ", s);
  std::cout << "  [" << s << "]\n";
  s.resize(3);
  Show("resize(3)     ", s);
  std::cout << "  [" << s << "]\n";
  s.resize(5);
  Show("resize(5)     ", s);
  std::cout << "  size()=" << s.size() << ", s[3]=" << static_cast<int>(s[3])
            << "\n";

  std::string empty;
  std::cout << "empty.size() - 1 = " << empty.size() - 1 << "\n";

  std::string t;
  t.resize_and_overwrite(32, [](char* buf, std::size_t n) {
    return static_cast<std::size_t>(std::snprintf(buf, n, "%d-%s", 42, "ok"));
  });
  std::cout << "resize_and_overwrite: [" << t << "] size=" << t.size() << "\n";
}
```

```text
initial       : size=5 capacity=15
empty()=0 length()==size(): 1
max_size()=9223372036854775806
reserve(100)  : size=5 capacity=100
reserve(10)   : size=5 capacity=100
shrink_to_fit : size=5 capacity=15
resize(8,'!') : size=8 capacity=15
  [hello!!!]
resize(3)     : size=3 capacity=15
  [hel]
resize(5)     : size=5 capacity=15
  size()=5, s[3]=0
empty.size() - 1 = 18446744073709551615
resize_and_overwrite: [42-ok] size=5
```

- `reserve(10)` 没有让 capacity 从 100 降下来。C++20 起标准规定 `reserve` 只增不减（之前是“非约束的缩小请求”），想缩小请用 `shrink_to_fit()`。这里它把 capacity 降回了 15，也就是回到对象内部的小缓冲区（第 12 节）。
- 同一个程序在 libc++ 上，初始 capacity 是 22，`reserve(100)` 之后是 103，`max_size()` 也不同。capacity 的具体数值是实现细节，只能依赖 `capacity() >= size()` 和 `reserve` 之后 `capacity() >= n`。
- `resize(5)` 把 `s` 从 3 变回 5 时，新增的两个字符是 `'\0'`，所以 `s[3]` 是 0，不是原来的 `'l'`。
- `empty.size() - 1` 是 18446744073709551615，因为 `size_type` 无符号。`for (size_t i = 0; i < s.size() - 1; ++i)` 在空串上会循环到天荒地老。写成 `i + 1 < s.size()`。
- `resize_and_overwrite` (C++23) 用来对接 C 风格的“写缓冲区”接口（`snprintf`、`read` 之类）：先 `resize` 再覆盖会多做一次无意义的填零，它省掉了这一步。回调拿到缓冲区指针和你请求的大小，返回实际写入的字符数。

## 6. 修改

修改函数很多，但绝大多数遵循同一套参数约定：**位置用下标 `pos`，长度用 `len`，来源可以是 string、C 字符串、字符加次数、迭代器区间**。

| 函数 | 常用形式 | 说明 |
| --- | --- | --- |
| `append` | `(str)` `(str, subpos, sublen)` `(ptr, n)` `(n, ch)` | 追加到末尾 |
| `operator+=` | `(str)` `(ptr)` `(ch)` `(init_list)` | 追加，最常用 |
| `push_back` / `pop_back` | `(ch)` / `()` | 追加 / 删除一个字符 |
| `insert` | `(pos, str)` `(pos, n, ch)` `(it, ch)` `(pos, str, subpos, sublen)` | 在 `pos` 之前插入 |
| `erase` | `(pos, len)` `(it)` `(first, last)` | `len` 缺省为到末尾 |
| `replace` | `(pos, len, str)` `(first, last, str)` `(pos, len, n, ch)` | 用新内容替换一段，长度不必相等 |
| `clear` | `()` | size 变 0，capacity 通常不变 |
| `copy` | `(dest, count, pos)` | 拷到字符数组，**不写 `'\0'`**，返回拷贝的个数 |
| `swap` | `(other)` | 交换内容，不拷贝字符 |
| `std::erase` / `std::erase_if` (C++20) | `(s, value)` / `(s, pred)` | 删除所有匹配的字符，返回删除个数 |

```cpp
#include <iostream>
#include <string>

void Show(const char* op, const std::string& s) {
  std::cout << op << " -> [" << s << "]\n";
}

int main() {
  std::string s = "Hello";

  s.insert(0, ">> ");
  Show("insert(0, \">> \")        ", s);
  s.insert(s.size(), 3, '!');
  Show("insert(size, 3, '!')    ", s);
  s.insert(s.begin() + 3, '_');
  Show("insert(iterator, '_')   ", s);
  s.insert(3, "abcdef", 1, 2);
  Show("insert(3, \"abcdef\", 1, 2)", s);

  s.erase(3, 2);
  Show("erase(3, 2)             ", s);
  s.erase(s.begin() + 3);
  Show("erase(iterator)         ", s);
  s.erase(s.size() - 3);
  Show("erase(size - 3) to end  ", s);
  s.erase(s.begin(), s.begin() + 3);
  Show("erase(first, last)      ", s);

  s.push_back('!');
  Show("push_back('!')          ", s);
  s.pop_back();
  Show("pop_back()              ", s);

  s.append(", World");
  s.append(2, '.');
  s.append("xyz", 1);
  s.append(std::string("0123456789"), 2, 3);
  Show("append x4               ", s);
  s += '?';
  s += " ok";
  Show("+= char, +=  C string   ", s);

  std::string r = "Hello, World";
  r.replace(7, 5, "C++");
  Show("replace(7, 5, \"C++\")    ", r);
  r.replace(r.begin(), r.begin() + 5, "Bye");
  Show("replace(first,last,str) ", r);
  r.replace(0, 3, 2, '#');
  Show("replace(0, 3, 2, '#')   ", r);

  char buf[8] = {};
  std::size_t n = r.copy(buf, 3, 4);
  std::cout << "copy(buf, 3, 4) -> " << n << " chars: " << buf << "\n";

  std::string a = "left";
  std::string b = "right";
  a.swap(b);
  std::cout << "swap -> a=" << a << ", b=" << b << "\n";

  std::string c = "banana";
  auto removed = std::erase(c, 'a');
  std::cout << "std::erase(c, 'a') removed " << removed << " -> " << c << "\n";
  std::string d = "a1b2c3";
  std::erase_if(d, [](char ch) { return ch >= '0' && ch <= '9'; });
  std::cout << "std::erase_if digits -> " << d << "\n";
}
```

```text
insert(0, ">> ")         -> [>> Hello]
insert(size, 3, '!')     -> [>> Hello!!!]
insert(iterator, '_')    -> [>> _Hello!!!]
insert(3, "abcdef", 1, 2) -> [>> bc_Hello!!!]
erase(3, 2)              -> [>> _Hello!!!]
erase(iterator)          -> [>> Hello!!!]
erase(size - 3) to end   -> [>> Hello]
erase(first, last)       -> [Hello]
push_back('!')           -> [Hello!]
pop_back()               -> [Hello]
append x4                -> [Hello, World..x234]
+= char, +=  C string    -> [Hello, World..x234? ok]
replace(7, 5, "C++")     -> [Hello, C++]
replace(first,last,str)  -> [Bye, C++]
replace(0, 3, 2, '#')    -> [##, C++]
copy(buf, 3, 4) -> 3 chars: C++
swap -> a=right, b=left
std::erase(c, 'a') removed 3 -> bnn
std::erase_if digits -> abc
```

- `pos > size()` 时 `insert`、`erase`、`replace`、`copy` 都会抛 `std::out_of_range`；`pos == size()` 是合法的（在末尾插入）。
- `erase(it)` 和 `erase(first, last)` 返回指向被删位置之后的迭代器，在循环里删元素要用返回值。
- `copy` 的目标缓冲区要自己保证够大，也要自己补 `'\0'`。上面的例子里 `buf` 事先清零，所以能直接当 C 字符串打印。
- C++23 还新增了 `assign_range`、`append_range`、`insert_range`、`replace_with_range`，参数是任意字符区间。

## 7. 查找与子串

查找函数一共六个，加上三个判断函数。区别只有两点：**找什么**（子串，还是“一组字符里的任意一个”）和**往哪个方向找**：

| 函数 | 找什么 | 方向 |
| --- | --- | --- |
| `find(x, pos = 0)` | 子串 / 单个字符，第一次出现 | 从 `pos` 往后 |
| `rfind(x, pos = npos)` | 子串 / 单个字符，最后一次出现 | 匹配**起点**不超过 `pos` |
| `find_first_of(set, pos = 0)` | `set` 中**任意一个**字符 | 往后 |
| `find_last_of(set, pos = npos)` | `set` 中任意一个字符 | 往前 |
| `find_first_not_of(set, pos = 0)` | **不在** `set` 中的字符 | 往后 |
| `find_last_not_of(set, pos = npos)` | 不在 `set` 中的字符 | 往前 |

找不到一律返回 `std::string::npos`。

```cpp
#include <iostream>
#include <string>

void Show(const char* call, std::size_t pos) {
  std::cout << call << " = ";
  if (pos == std::string::npos) {
    std::cout << "npos\n";
  } else {
    std::cout << pos << "\n";
  }
}

int main() {
  std::string s = "archive.tar.gz";

  Show("find(\".\")           ", s.find("."));
  Show("find(\".\", 8)        ", s.find(".", 8));
  Show("find(\"zip\")         ", s.find("zip"));
  Show("find('t', 3)        ", s.find('t', 3));
  Show("rfind(\".\")          ", s.rfind("."));
  Show("rfind(\".\", 7)       ", s.rfind(".", 7));
  Show("find_first_of(\"aeiou\")    ", s.find_first_of("aeiou"));
  Show("find_last_of(\"aeiou\")     ", s.find_last_of("aeiou"));
  Show("find_first_not_of(\"arch\") ", s.find_first_not_of("arch"));
  Show("find_last_not_of(\"gz\")    ", s.find_last_not_of("gz"));
  Show("find(\"\", 5)         ", s.find("", 5));
  Show("find(\"\", 99)        ", s.find("", 99));

  std::size_t dot = s.rfind('.');
  std::cout << "stem=" << s.substr(0, dot) << " ext=" << s.substr(dot + 1)
            << "\n";
  std::cout << "substr(8)=" << s.substr(8) << ", substr(14)=[" << s.substr(14)
            << "]\n";

  std::cout << std::boolalpha;
  std::cout << "starts_with(\"arch\") = " << s.starts_with("arch") << "\n";
  std::cout << "ends_with(\".gz\")    = " << s.ends_with(".gz") << "\n";
  std::cout << "starts_with('a')     = " << s.starts_with('a') << "\n";
  std::cout << "contains(\"tar\")     = " << s.contains("tar") << "\n";
}
```

```text
find(".")            = 7
find(".", 8)         = 11
find("zip")          = npos
find('t', 3)         = 8
rfind(".")           = 11
rfind(".", 7)        = 7
find_first_of("aeiou")     = 0
find_last_of("aeiou")      = 9
find_first_not_of("arch")  = 4
find_last_not_of("gz")     = 11
find("", 5)          = 5
find("", 99)         = npos
stem=archive.tar ext=gz
substr(8)=tar.gz, substr(14)=[]
starts_with("arch") = true
ends_with(".gz")    = true
starts_with('a')     = true
contains("tar")     = true
```

- `find_first_of("aeiou")` 找的是“第一个元音字母”，不是找子串 `"aeiou"`。这组函数的参数是字符集合，很多人（包括我）一开始都会看错。
- `rfind(".", 7)` 的 7 是匹配起点的上限：下标 7 处的 `.` 刚好能匹配，所以返回 7。
- 空串总是能在 `pos <= size()` 的位置找到，所以 `find("", 5)` 返回 5，`find("", 99)` 是 `npos`。
- 返回值是 `size_type`。别把它存进 `int`，也别和 `-1` 比较，永远写 `!= std::string::npos`。
- `substr(pos, len)` 返回的是拷贝。`pos > size()` 抛 `out_of_range`，`pos == size()` 返回空串，`len` 太大会被截断到末尾，不会报错。
- `starts_with` 和 `ends_with` 是 C++20。`contains` 是 **C++23**，我用 `-std=c++20` 编译 `s.contains("name")`，GCC 报 `error: ‘std::string’ ... has no member named ‘contains’`，换成 `-std=c++23` 才通过。

## 8. 比较

`==`、`!=`、`<`、`<=`、`>`、`>=` 都能直接用，两边可以是 string 或 `const char*`。C++20 起它们由 `operator==` 和 `operator<=>` 合成。它们都做**字典序**比较：从头开始逐字节比，第一个不同的字节决定大小，其中一个是另一个的前缀时，短的更小。

另有成员函数 `compare()`，可以比较子串：`s.compare(pos, len, other)`。

```cpp
#include <compare>
#include <iostream>
#include <string>

int main() {
  std::string a = "apple";
  std::string b = "banana";
  std::string z = "Zebra";

  std::cout << std::boolalpha;
  std::cout << "a == b : " << (a == b) << "\n";
  std::cout << "a <  b : " << (a < b) << "\n";
  std::cout << "z <  a : " << (z < a) << "  (uppercase sorts first)\n";
  std::cout << "a == \"apple\" : " << (a == "apple") << "\n";
  std::cout << "a.compare(b) = " << a.compare(b) << "\n";
  std::cout << "b.compare(a) = " << b.compare(a) << "\n";
  std::cout << "a.compare(a) = " << a.compare(a) << "\n";
  std::cout << "\"app\" vs a  = " << std::string("app").compare(a) << "\n";

  std::string path = "/usr/local/bin";
  std::cout << "path.compare(0, 4, \"/usr\") = " << path.compare(0, 4, "/usr")
            << "\n";

  auto order = a <=> b;
  std::cout << "a <=> b is less: " << (order < 0) << "\n";

  std::string high = "\xe9";
  std::string low = "a";
  std::cout << "\"\\xe9\" > \"a\": " << (high > low) << "\n";
}
```

```text
a == b : false
a <  b : true
z <  a : true  (uppercase sorts first)
a == "apple" : true
a.compare(b) = -1
b.compare(a) = 1
a.compare(a) = 0
"app" vs a  = -2
path.compare(0, 4, "/usr") = 0
a <=> b is less: true
"\xe9" > "a": true
```

- 大写字母的编码比小写字母小，所以 `"Zebra" < "apple"`。标准库没有不区分大小写的比较，需要的话自己写比较器。
- `compare()` 只保证返回负数、零、正数。libstdc++ 对 `"app"` 和 `"apple"` 返回 -2（长度之差），libc++ 返回 -1。**只能判断符号，不要和具体的 -1/1 比较。**
- 字符按 `unsigned char` 比较（这是 `char_traits<char>::compare` 规定的）。所以字节 `0xE9` 比 `'a'` 大，尽管在 `char` 有符号的平台上 `static_cast<char>(0xE9)` 是负数。这保证了 UTF-8 字符串的字节序比较和码点顺序一致。

## 9. 拼接、输入输出与格式化

### 拼接

`operator+` 要求**至少一边是 `std::string`**。两个 `const char*` 相加是指针运算，不是拼接：

```text
error: invalid operands of types ‘const char [2]’ and ‘const char [2]’ to binary ‘operator+’
```

解决办法是让其中一个变成 string：`std::string("x") + "y"`，或者 `"x"s + "y"`。

### 输入输出

- `std::cin >> s`(`operator>>`) 跳过前导空白，读到下一个空白为止。
- `std::getline(in, s)` 读一整行，丢弃行尾的 `'\n'`，不存进 `s`。第三个参数可以换分隔符。
- `std::format` (C++20) 支持对齐和填充：`{:>8}` 右对齐，`{:<8}` 左对齐，`{:^8}` 居中，`{:*^9}` 用 `*` 填充居中。
- 需要拼很多片段时，也可以用 `std::ostringstream`，最后 `.str()`。

```cpp
#include <format>
#include <iostream>
#include <sstream>
#include <string>

using std::string_literals::operator""s;

int main() {
  std::string a = "foo";
  std::string b = "bar";

  std::cout << (a + b) << "\n";
  std::cout << (a + "-" + b) << "\n";
  std::cout << (a + '!') << "\n";
  std::cout << ("x"s + "y") << "\n";
  // auto bad = "x" + "y";  // error: two const char* cannot be added

  std::istringstream in("  hello   world 42\nsecond line here\nlast,field,x");
  std::string word;
  in >> word;
  std::cout << "operator>> -> [" << word << "]\n";
  in >> word;
  std::cout << "operator>> -> [" << word << "]\n";
  std::getline(in, word);
  std::cout << "getline rest of line -> [" << word << "]\n";
  std::getline(in, word);
  std::cout << "getline next line -> [" << word << "]\n";
  std::getline(in, word, ',');
  std::cout << "getline delim ',' -> [" << word << "]\n";

  std::cout << std::format("[{:>8}] [{:<8}] [{:^8}] [{:*^9}]\n", a, a, a, a);
  std::cout << std::format("{} has {} chars\n", b, b.size());

  std::ostringstream out;
  out << "x=" << 1 << ", y=" << 2.5;
  std::cout << out.str() << "\n";
}
```

```text
foobar
foo-bar
foo!
xy
operator>> -> [hello]
operator>> -> [world]
getline rest of line -> [ 42]
getline next line -> [second line here]
getline delim ',' -> [last]
[     foo] [foo     ] [  foo   ] [***foo***]
bar has 3 chars
x=1, y=2.5
```

`getline` 那几行值得对照输入看一遍：两次 `>>` 读走了 `hello` 和 `world`，第一次 `getline` 读的是这一行剩下的 ` 42`（前导空格保留），第二次才是下一整行，第三次用逗号做分隔符，只读到 `last`。

## 10. 与数字互转

数字转字符串有三种选择，字符串转数字有两种：

| 方向 | 函数 | 特点 |
| --- | --- | --- |
| 数字 → string | `std::to_string` (C++11) | 等价于 `printf` 的 `%d`、`%f` 等，浮点数固定 6 位小数 |
| 数字 → string | `std::format("{}", x)` (C++20) | 浮点数输出最短的、能还原原值的表示 |
| 数字 → 字符数组 | `std::to_chars` (C++17，`<charconv>`) | 不分配内存，不抛异常，可指定进制 |
| string → 数字 | `std::stoi` `stol` `stoll` `stoul` `stoull` `stof` `stod` `stold` | 抛异常，跳过前导空白，遇到非法字符就停 |
| 字符数组 → 数字 | `std::from_chars` (C++17) | 不抛异常，不跳空白，返回 `ec` 和停止位置 |

```cpp
#include <charconv>
#include <climits>
#include <format>
#include <iostream>
#include <stdexcept>
#include <string>
#include <system_error>

int main() {
  std::cout << std::to_string(42) << " " << std::to_string(-7L) << " "
            << std::to_string(3.14) << " " << std::to_string(0.1) << " "
            << std::to_string(1e-7) << "\n";
  std::cout << std::format("{} {} {}", 3.14, 0.1, 1e-7) << "\n";

  std::size_t used = 0;
  std::cout << "stoi(\"  42abc\")  = " << std::stoi("  42abc", &used)
            << ", used " << used << "\n";
  std::cout << "stoi(\"ff\", 16)   = " << std::stoi("ff", nullptr, 16) << "\n";
  std::cout << "stoi(\"0x1A\", 0)  = " << std::stoi("0x1A", nullptr, 0) << "\n";
  std::cout << "stoi(\"052\", 0)   = " << std::stoi("052", nullptr, 0) << "\n";
  std::cout << "stod(\"1e3x\")     = " << std::stod("1e3x") << "\n";
  std::cout << "stoul(\"-1\")      = " << std::stoul("-1")
            << " (ULONG_MAX=" << ULONG_MAX << ")\n";

  try {
    std::stoi("abc");
  } catch (const std::invalid_argument& e) {
    std::cout << "stoi(\"abc\")      -> invalid_argument\n";
  }
  try {
    std::stoi("3000000000");
  } catch (const std::out_of_range& e) {
    std::cout << "stoi(\"3000000000\") -> out_of_range\n";
  }

  const std::string text = "42abc";
  int value = 0;
  auto [ptr, ec] =
      std::from_chars(text.data(), text.data() + text.size(), value);
  std::cout << "from_chars(\"42abc\"): value=" << value
            << ", ec ok=" << (ec == std::errc()) << ", rest=" << ptr << "\n";

  const std::string bad = "abc";
  auto [ptr2, ec2] =
      std::from_chars(bad.data(), bad.data() + bad.size(), value);
  std::cout << "from_chars(\"abc\"): invalid_argument="
            << (ec2 == std::errc::invalid_argument) << "\n";

  const std::string spaced = " 7";
  auto [ptr3, ec3] =
      std::from_chars(spaced.data(), spaced.data() + spaced.size(), value);
  std::cout << "from_chars(\" 7\"): invalid_argument="
            << (ec3 == std::errc::invalid_argument) << "\n";

  char buf[32];
  auto [end, ec4] = std::to_chars(buf, buf + sizeof(buf), 255, 16);
  std::cout << "to_chars(255, 16) = " << std::string(buf, end) << "\n";
  auto [end2, ec5] = std::to_chars(buf, buf + sizeof(buf), 0.1);
  std::cout << "to_chars(0.1)     = " << std::string(buf, end2) << "\n";
}
```

```text
42 -7 3.140000 0.100000 0.000000
3.14 0.1 1e-07
stoi("  42abc")  = 42, used 4
stoi("ff", 16)   = 255
stoi("0x1A", 0)  = 26
stoi("052", 0)   = 42
stod("1e3x")     = 1000
stoul("-1")      = 18446744073709551615 (ULONG_MAX=18446744073709551615)
stoi("abc")      -> invalid_argument
stoi("3000000000") -> out_of_range
from_chars("42abc"): value=42, ec ok=1, rest=abc
from_chars("abc"): invalid_argument=1
from_chars(" 7"): invalid_argument=1
to_chars(255, 16) = ff
to_chars(0.1)     = 0.1
```

- `to_string(0.1)` 是 `"0.100000"`，`to_string(1e-7)` 是 `"0.000000"`，精度全丢了。要完整输出用 `std::format` 或 `to_chars`。
- `stoi("  42abc")` 返回 42，**并不会因为尾部的 `abc` 抛异常**，只能通过第二个参数（`used`，停在下标 4）发现还有剩余。只有开头就没有数字才抛 `invalid_argument`，数值超出范围抛 `out_of_range`。
- 第三个参数是进制，`0` 表示按前缀自动判断（`0x` 十六进制、`0` 开头八进制）。
- `stoul("-1")` 不会失败，而是回绕成 `ULONG_MAX`。这是 `strtoul` 的行为，`stoul` 原样继承。
- `from_chars` 不跳空白，所以 `" 7"` 直接是 `invalid_argument`。要校验整串是否都是数字，检查返回的 `ptr == text.data() + text.size()` 和 `ec == std::errc()`。
- 选择：解析用户输入、不希望异常影响流程时用 `from_chars`；一次性脚本、能接受异常时 `stoi` 更省事。

## 11. string 与 string_view

`std::string_view` (C++17) 是“指针加长度”的只读视图，不拥有字符，拷贝和 `substr` 都不分配内存。它是 string 的搭档：**函数参数只读 string 时，用 `string_view`**。

```cpp
#include <cstdio>
#include <functional>
#include <iostream>
#include <string>
#include <string_view>
#include <unordered_map>

struct StringHash {
  using is_transparent = void;
  std::size_t operator()(std::string_view sv) const {
    return std::hash<std::string_view>{}(sv);
  }
};

void Greet(std::string_view name) {
  std::cout << "hello, " << name << " (" << name.size() << ")\n";
}

int main() {
  std::string s = "world";
  Greet(s);
  Greet("literal");
  Greet(std::string_view(s).substr(1, 3));

  std::string_view sv = s;
  // std::string t = sv;     // error: the conversion is explicit
  std::string t(sv);
  t += sv;
  t.append(sv.substr(0, 2));
  std::cout << t << "\n";

  std::string_view word = std::string_view("hello world").substr(0, 5);
  std::printf("size=%zu, printf(\"%%s\") prints: %s\n", word.size(),
              word.data());

  std::unordered_map<std::string, int, StringHash, std::equal_to<>> counts;
  counts["apple"] = 1;
  std::string_view key = "apple";
  auto it = counts.find(key);
  std::cout << "lookup by view: " << (it != counts.end() ? it->second : -1)
            << "\n";
}
```

```text
hello, world (5)
hello, literal (7)
hello, orl (3)
worldworldwo
size=5, printf("%s") prints: hello world
lookup by view: 1
```

- string 到 `string_view` 是**隐式**转换，反过来是**显式**的 (`std::string t(sv)`)，因为要分配内存拷贝。`std::string t = sv;` 不能编译。
- `string + string_view` 在 C++23 下也不能编译（GCC 报 `no match for ‘operator+’`），要用 `+=` 或 `append`，上面的 `t += sv` 和 `t.append(...)` 就是这么用的。
- `string_view` **不保证以 `'\0'` 结尾**。程序里 `word` 是 `"hello world"` 的前 5 个字符，但 `word.data()` 交给 `printf("%s")` 会一直打印到字面量的 `'\0'`，输出的是整个 `hello world`。把它传给 C 接口前，必须先构造成 string。
- `std::unordered_map<std::string, ...>` 默认查找必须构造一个 string 作为 key。C++20 起可以配上透明哈希和 `std::equal_to<>`，直接用 `string_view` 查找，避免临时 string，程序最后几行就是这个写法。

`string_view` 的代价是所有权：谁来保证它指向的内存还活着，是调用者的事。

```cpp
#include <iostream>
#include <string>
#include <string_view>

std::string MakeName() { return std::string(30, 'a') + ".txt"; }

int main() {
  std::string_view sv = MakeName();  // BAD: the temporary dies at the ';'.
  std::cout << sv.substr(0, 5) << "\n";
}
```

用 `-g -fsanitize=address` 编译运行，输出开头是：

```text
==719322==ERROR: AddressSanitizer: heap-use-after-free on address 0x6d03f1de0020 at pc 0x70a3f328835f bp 0x7ffc744fcee0 sp 0x7ffc744fc6b0
READ of size 5 at 0x6d03f1de0020 thread T0
```

`MakeName()` 返回的是一个 34 字节的临时 string，超过 SSO 的容量，字符在堆上；临时对象在分号处销毁，`sv` 就指向了已释放的内存。如果名字短到能放进 SSO（比如 `"a.txt"`），字符在临时对象内部，同样是悬空，ASan 会报 `stack-use-after-scope` 而不是 `heap-use-after-free`。

规则很简单：`string_view` 当函数参数随便用；要把它存进成员、放进容器或者当返回值，先问一句“谁是 owner”。

## 12. 内部实现：SSO、扩容、拷贝与移动

### 小字符串优化

每次创建字符串都 `malloc` 一次太贵，而绝大多数字符串都很短。所以实现把一小块缓冲区直接放进 string 对象里：字符串短的时候，字符就存在对象内部（口袋），长到放不下才去堆上申请（仓库），对象里只留一个指针（取货单）。这就是 SSO(Small String Optimization)。

读 libstdc++ 的 `bits/basic_string.h`，`sizeof(std::string)` 的 32 字节是：8 字节指针、8 字节 size，加一个 16 字节的 union，里面要么是 15 个字符加 `'\0'` 的本地缓冲区，要么是堆缓冲区的 capacity。

```cpp
#include <cstdint>
#include <iostream>
#include <string>

bool IsInline(const std::string& s) {
  auto begin = reinterpret_cast<std::uintptr_t>(&s);
  auto data = reinterpret_cast<std::uintptr_t>(s.data());
  return data >= begin && data < begin + sizeof(s);
}

int main() {
  std::cout << "sizeof(std::string) = " << sizeof(std::string) << "\n";

  std::string s;
  std::cout << "empty: capacity=" << s.capacity() << " inline=" << IsInline(s)
            << "\n";

  for (int i = 0; i < 70; ++i) {
    std::size_t old_capacity = s.capacity();
    s.push_back('x');
    if (s.capacity() != old_capacity) {
      std::cout << "size=" << s.size() << ": capacity " << old_capacity
                << " -> " << s.capacity() << ", inline=" << IsInline(s) << "\n";
    }
  }

  std::string exact(20, 'a');
  std::cout << "string(20, 'a'): capacity=" << exact.capacity() << "\n";
}
```

```text
sizeof(std::string) = 32
empty: capacity=15 inline=1
size=16: capacity 15 -> 30, inline=0
size=31: capacity 30 -> 60, inline=0
size=61: capacity 60 -> 120, inline=0
string(20, 'a'): capacity=20
```

同一个程序在 Clang 21.1.8 加 libc++ 上的结果：

| 项目 | libstdc++ (GCC 15.3.0) | libc++ (Clang 21.1.8) |
| --- | --- | --- |
| `sizeof(std::string)` | 32 | 24 |
| 空串的 capacity | 15 | 22 |
| 增长路径 | 15 → 30 → 60 → 120 | 22 → 47 → 95 |
| `std::string(20, 'a')` 的 capacity | 20（堆上） | 22（还在对象内部） |

结论：SSO 的容量取决于标准库实现，15 和 22 都不是标准规定的。扩容都近似翻倍，这保证了 `push_back` 的均摊复杂度是 $O(1)$。

### 拷贝与移动

SSO 有一个反直觉的后果：**移动一个短字符串其实是拷贝**，因为数据就在对象里，没有指针可偷。

```cpp
#include <iostream>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

static_assert(std::is_nothrow_move_constructible_v<std::string>);
static_assert(std::is_nothrow_move_assignable_v<std::string>);
static_assert(std::is_nothrow_swappable_v<std::string>);

int main() {
  std::cout << std::boolalpha;

  const std::string small = "hello";
  const std::string big(40, 'x');
  std::string small_copy = small;
  std::string big_copy = big;
  std::cout << "copy, small: shares buffer = "
            << (small.data() == small_copy.data()) << "\n";
  std::cout << "copy, big:   shares buffer = "
            << (big.data() == big_copy.data()) << "\n";

  std::string a = "hello";
  std::string b(40, 'x');
  const char* a_ptr = a.data();
  const char* b_ptr = b.data();
  std::string a_moved = std::move(a);
  std::string b_moved = std::move(b);
  std::cout << "move, small: steals buffer = " << (a_moved.data() == a_ptr)
            << ", moved-from size = " << a.size() << "\n";
  std::cout << "move, big:   steals buffer = " << (b_moved.data() == b_ptr)
            << ", moved-from size = " << b.size() << "\n";

  std::vector<std::string> v;
  v.push_back(std::string(40, 'y'));
  const char* before = v[0].data();
  v.reserve(1000);  // reallocates the vector's storage
  std::cout << "vector regrowth keeps the string's buffer = "
            << (v[0].data() == before) << "\n";
}
```

```text
copy, small: shares buffer = false
copy, big:   shares buffer = false
move, small: steals buffer = false, moved-from size = 0
move, big:   steals buffer = true, moved-from size = 0
vector regrowth keeps the string's buffer = true
```

- 拷贝：不管长短，都有独立的缓冲区。长串是 `malloc` 加 `memcpy`，短串是拷对象内部的字节。
- 移动大串：直接偷走指针，$O(1)$。
- 移动小串：只能拷。所以“需要所有权就按值传参再 `std::move`”这条建议仍然成立，但对短串它不是白送的。
- 移动构造、移动赋值和 `swap` 都是 `noexcept`（程序开头的 `static_assert` 验证了）。所以 `std::vector<std::string>` 重新分配存储时会移动元素而不是拷贝：程序最后几行里，`reserve` 之后元素的缓冲区地址没变。

### COW：旧 ABI 里的 8 字节 string

GCC 5.1 之前，libstdc++ 的 string 是引用计数的 COW (Copy-On-Write) 实现。C++11 的迭代器和引用失效规则不再允许它，GCC 5.1 因此引入了新实现（也就是上面的 32 字节加 SSO），旧实现通过 `_GLIBCXX_USE_CXX11_ABI=0` 保留，详见 [libstdc++ 手册的 Dual ABI 一节](https://gcc.gnu.org/onlinedocs/libstdc++/manual/using_dual_abi.html)。

```cpp
#include <iostream>
#include <string>

int main() {
  const std::string a(40, 'x');
  std::string b = a;
  std::cout << "ABI=" << _GLIBCXX_USE_CXX11_ABI << ", sizeof=" << sizeof(a)
            << ", copy shares buffer: " << (a.c_str() == b.c_str()) << "\n";
  b[0] = 'y';  // The non-const operator[] detaches b.
  std::cout << "after write, shares buffer: " << (a.c_str() == b.c_str())
            << ", a[0]=" << a[0] << "\n";
}
```

分别用 `-D_GLIBCXX_USE_CXX11_ABI=1` 和 `=0` 编译，输出是：

```text
ABI=1, sizeof=32, copy shares buffer: 0
after write, shares buffer: 0, a[0]=x
ABI=0, sizeof=8, copy shares buffer: 1
after write, shares buffer: 0, a[0]=x
```

旧 ABI 下对象只有一个 8 字节的指针；拷贝只是共享缓冲区，第一次写才真正复制。我最早写这个实验时拿到的是“不共享”，因为我对非 const 的 `b` 调用了 `data()`，COW 实现里非 const 访问会先把缓冲区分离出来。今天默认用的是新 ABI，只有链接旧的二进制或库时才会撞上旧的，链接报错里出现 `__cxx11` 就是两个 ABI 混用了。

## 13. 迭代器、指针和引用什么时候失效

string 的字符存在一块可能被重新分配的缓冲区里，所以任何指向它的迭代器、指针（包括 `c_str()` 和 `data()` 的结果）和引用，都可能在你修改 string 之后变成野指针。标准规定，它们**只会**被这些操作作废：

- 调用任何以**非 const `std::string&`** 为参数的标准库函数，例如 `std::getline`、`std::swap`、`operator>>`。
- 调用任何**非 const 成员函数**，**除了** `operator[]`、`at`、`data`、`front`、`back`、`begin`、`rbegin`、`end`、`rend`。

也就是说 `push_back`、`append`、`insert`、`erase`、`resize`、`reserve`、`shrink_to_fit`、`clear`、`assign`、`operator=` 都可能让旧指针失效，哪怕你觉得“反正容量够”。所有 const 成员函数（`size`、`find`、`substr`、`c_str`……）都不会。

```cpp
#include <iostream>
#include <string>

int main() {
  std::string s(40, 'a');
  char& first = s[0];
  const char* p = s.c_str();

  s.append(1000, 'b');  // exceeds capacity: the buffer is reallocated

  std::cout << "same buffer: " << (p == s.c_str()) << "\n";
  first = 'z';  // BAD: first refers to the freed buffer
  std::cout << s[0] << "\n";
}
```

用 ASan 运行：

```text
==719362==ERROR: AddressSanitizer: heap-use-after-free on address 0x771dee1e0010 at pc 0x5b7c60ad67c7 bp 0x7ffe70b04bb0 sp 0x7ffe70b04ba8
WRITE of size 1 at 0x771dee1e0010 thread T0
```

不加 ASan 直接运行，程序也不会崩溃：

```text
same buffer: 0
a
```

它悄悄写进了已释放的内存，后面读到的还是 `a`，没有任何症状。这类 bug 只有在内存被别人重用时才爆发。需要稳定引用字符串里的某个位置时，保存下标，不要保存指针、引用或迭代器。

## 14. 异常

| 情况 | 结果 |
| --- | --- |
| `at(pos)`，`pos >= size()` | `std::out_of_range` |
| `operator[]`，`pos > size()` | 未定义行为，不抛异常 |
| `substr` / `insert` / `erase` / `replace` / `copy`，`pos > size()` | `std::out_of_range` |
| `find` 系列，`pos` 过大 | 不抛，返回 `npos` |
| 长度超过 `max_size()` | `std::length_error` |
| 内存分配失败 | `std::bad_alloc` |

```cpp
#include <iostream>
#include <new>
#include <stdexcept>
#include <string>

template <typename F>
void Try(const char* what, F f) {
  try {
    f();
    std::cout << what << ": no exception\n";
  } catch (const std::out_of_range& e) {
    std::cout << what << ": out_of_range: " << e.what() << "\n";
  } catch (const std::length_error& e) {
    std::cout << what << ": length_error: " << e.what() << "\n";
  } catch (const std::bad_alloc& e) {
    std::cout << what << ": bad_alloc\n";
  }
}

int main() {
  std::string s = "hello";
  Try("at(5)            ", [&] { [[maybe_unused]] char c = s.at(5); });
  Try("s[5]             ", [&] { [[maybe_unused]] char c = s[5]; });
  Try("substr(5)        ", [&] { [[maybe_unused]] auto t = s.substr(5); });
  Try("substr(6)        ", [&] { [[maybe_unused]] auto t = s.substr(6); });
  Try("substr(1, 999)   ", [&] { [[maybe_unused]] auto t = s.substr(1, 999); });
  Try("insert(9, \"x\")   ", [&] {
    std::string t = s;
    t.insert(9, "x");
  });
  Try("erase(9)         ", [&] {
    std::string t = s;
    t.erase(9);
  });
  Try("find(\"l\", 99)    ",
      [&] { [[maybe_unused]] auto i = s.find("l", 99); });
  Try("copy(buf, 3, 9)  ", [&] {
    char buf[8];
    s.copy(buf, 3, 9);
  });
  Try("reserve(max + 1) ", [&] {
    std::string t;
    t.reserve(t.max_size() + 1);
  });
}
```

```text
at(5)            : out_of_range: basic_string::at: __n (which is 5) >= this->size() (which is 5)
s[5]             : no exception
substr(5)        : no exception
substr(6)        : out_of_range: basic_string::substr: __pos (which is 6) > this->size() (which is 5)
substr(1, 999)   : no exception
insert(9, "x")   : out_of_range: basic_string::replace: __pos (which is 9) > this->size() (which is 5)
erase(9)         : out_of_range: basic_string::erase: __pos (which is 9) > this->size() (which is 5)
find("l", 99)    : no exception
copy(buf, 3, 9)  : out_of_range: basic_string::copy: __pos (which is 9) > this->size() (which is 5)
reserve(max + 1) : length_error: basic_string::_M_create
```

注意 `substr(5)` 在长度为 5 的串上不抛异常（返回空串），`substr(6)` 才抛。`what()` 的文本在 libc++ 上只有 `basic_string`，再次说明不要依赖它。移动构造、移动赋值和 `swap` 不会抛异常，见第 12 节。

## 15. 编码：size() 数的是字节

`std::string` 只管 `char`，也就是字节。源文件是 UTF-8 的话，`"你好"` 就是 6 个字节，`size()` 返回 6。

```cpp
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <iostream>
#include <string>
#include <string_view>

std::size_t CountCodePoints(std::string_view utf8) {
  std::size_t n = 0;
  for (char c : utf8) {
    if ((static_cast<unsigned char>(c) & 0xC0) != 0x80) ++n;
  }
  return n;
}

void Hex(const char* label, std::string_view s) {
  std::cout << label;
  for (char c : s) std::printf(" %02x", static_cast<unsigned char>(c));
  std::cout << "\n";
}

int main() {
  std::string s = "你好";
  std::cout << "size() = " << s.size()
            << ", code points = " << CountCodePoints(s) << "\n";
  Hex("bytes:   ", s);

  std::u8string u8 = u8"你好";
  std::u32string u32 = U"你好";
  std::cout << "u8string size  = " << u8.size() << "\n";
  std::cout << "u32string size = " << u32.size() << "\n";

  std::string mixed = "a你b";
  std::cout << "mixed size = " << mixed.size()
            << ", code points = " << CountCodePoints(mixed) << "\n";

  std::reverse(s.begin(), s.end());
  Hex("reversed:", s);

  std::string e = "\xc3\xa9";  // U+00E9, e with acute accent
  std::transform(e.begin(), e.end(), e.begin(), [](unsigned char c) {
    return static_cast<char>(std::toupper(c));
  });
  Hex("toupper on UTF-8 e-acute:", e);
}
```

```text
size() = 6, code points = 2
bytes:    e4 bd a0 e5 a5 bd
u8string size  = 6
u32string size = 2
mixed size = 5, code points = 3
reversed: bd a5 e5 a0 bd e4
toupper on UTF-8 e-acute: c3 a9
```

- `std::u8string` 的 size 也是 6，它的单位是 UTF-8 的 code unit（字节），不是字符。`std::u32string` 的 size 是 2，因为 UTF-32 里一个 code unit 就是一个码点。
- 数码点个数：UTF-8 的后续字节形如 `10xxxxxx`，所以数“不是后续字节”的字节即可，程序里的 `CountCodePoints` 就是这么做的。显示宽度又是另一回事（中文通常占两列），标准库不管。
- 用 `std::reverse` 反转 `"你好"`，得到的字节是 `bd a5 e5 a0 bd e4`，已经不是合法的 UTF-8 了。下标、`substr`、排序、`erase` 都是按字节操作的，对多字节字符的串要当心切在字符中间。
- `toupper`、`tolower` 只能处理 ASCII。输入 `é` 的 UTF-8 字节 `c3 a9`，输出不变。
- `u8"..."` 字面量在 C++20 里是 `char8_t` 数组，不能直接初始化 `std::string`：`std::string s = u8"hello";` 会报 `conversion from ‘const char8_t [6]’ to non-scalar type ‘std::string’ requested`。
- 需要真正的 Unicode 处理（规范化、大小写折叠、按字素切分），应该用 ICU 之类的专门的库，`std::string` 本身不提供。

## 16. 标准库没有的：trim、split、join、replace_all

`std::string` 没有这几个常用函数。自己写时有两个原则：**参数和返回值尽量用 `string_view`**，避免不必要的拷贝；字符串操作前 `unsigned char` 转换不能忘。

```cpp
#include <algorithm>
#include <cctype>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

std::string_view Trim(std::string_view s) {
  const char* spaces = " \t\r\n\f\v";
  std::size_t first = s.find_first_not_of(spaces);
  if (first == std::string_view::npos) return {};
  std::size_t last = s.find_last_not_of(spaces);
  return s.substr(first, last - first + 1);
}

std::vector<std::string_view> Split(std::string_view s, char delim) {
  std::vector<std::string_view> parts;
  std::size_t start = 0;
  while (true) {
    std::size_t end = s.find(delim, start);
    if (end == std::string_view::npos) {
      parts.push_back(s.substr(start));
      return parts;
    }
    parts.push_back(s.substr(start, end - start));
    start = end + 1;
  }
}

std::string Join(const std::vector<std::string_view>& parts,
                 std::string_view sep) {
  std::string out;
  for (std::size_t i = 0; i < parts.size(); ++i) {
    if (i > 0) out += sep;
    out += parts[i];
  }
  return out;
}

std::string ReplaceAll(std::string s, std::string_view from,
                       std::string_view to) {
  if (from.empty()) return s;
  std::size_t pos = 0;
  while ((pos = s.find(from, pos)) != std::string::npos) {
    s.replace(pos, from.size(), to);
    pos += to.size();
  }
  return s;
}

std::string ToLowerAscii(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return s;
}

int main() {
  std::cout << "[" << Trim("  \t hello world \n") << "]\n";
  std::cout << "[" << Trim("   ") << "]\n";

  auto parts = Split("a,b,,c", ',');
  std::cout << "split into " << parts.size() << ":";
  for (auto p : parts) std::cout << " [" << p << "]";
  std::cout << "\n";

  std::cout << Join(parts, "|") << "\n";
  std::cout << ReplaceAll("a.b.c", ".", "::") << "\n";
  std::cout << ReplaceAll("aaaa", "aa", "a") << "\n";
  std::cout << ToLowerAscii("Hello, WORLD") << "\n";
}
```

```text
[hello world]
[]
split into 4: [a] [b] [] [c]
a|b||c
a::b::c
aa
hello, world
```

- `Trim` 和 `Split` 返回的是原字符串的视图，所以结果的生命周期不能超过原字符串。
- `Split` 保留了空字段（`a,b,,c` 得到 4 段，第 3 段是空的），这是对的，不要在这里悄悄丢数据。
- `ReplaceAll` 里每次替换后 `pos += to.size()`，否则当 `to` 包含 `from` 时会死循环。`"aaaa"` 替换 `"aa"` 为 `"a"` 得到 `"aa"`，而不是 `"a"`，因为替换结果不会被再次扫描。

## 17. 性能与传参

先看几个数字。这个程序重载了 `operator new` 来数分配次数：

```cpp
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <string>
#include <string_view>

namespace {

std::size_t g_allocs = 0;

template <typename F>
double Ms(F f) {
  auto t0 = std::chrono::steady_clock::now();
  f();
  std::chrono::duration<double, std::milli> dt =
      std::chrono::steady_clock::now() - t0;
  return dt.count();
}

void Sink(const char* p) { asm volatile("" : : "r"(p) : "memory"); }

[[gnu::noipa]] std::size_t LenRef(const std::string& s) { return s.size(); }
[[gnu::noipa]] std::size_t LenView(std::string_view s) { return s.size(); }

}  // namespace

void* operator new(std::size_t n) {
  ++g_allocs;
  if (void* p = std::malloc(n)) return p;
  throw std::bad_alloc();
}

void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

int main() {
  constexpr int kN = 100000;

  std::string a;
  double t_plus = Ms([&] {
    for (int i = 0; i < kN; ++i) a = a + "x";
  });
  std::string b;
  double t_append = Ms([&] {
    for (int i = 0; i < kN; ++i) b += "x";
  });
  std::printf("%d times, s = s + \"x\": %8.2f ms\n", kN, t_plus);
  std::printf("%d times, s += \"x\":    %8.2f ms (%.0fx faster)\n", kN,
              t_append, t_plus / t_append);

  const std::string x(30, 'x');
  const std::string y(30, 'y');
  const std::string z(30, 'z');

  g_allocs = 0;
  std::string r1 = x + "," + y + "," + z;
  std::size_t chain = g_allocs;

  g_allocs = 0;
  std::string r2;
  r2.reserve(x.size() + y.size() + z.size() + 2);
  r2 += x;
  r2 += ',';
  r2 += y;
  r2 += ',';
  r2 += z;
  std::size_t reserved = g_allocs;
  std::printf("x + \",\" + y + \",\" + z: %zu allocs; reserve + append: %zu\n",
              chain, reserved);

  constexpr int kPushes = 10'000'000;
  g_allocs = 0;
  double t_plain = Ms([] {
    std::string s;
    for (int i = 0; i < kPushes; ++i) s.push_back('x');
    Sink(s.data());
  });
  std::size_t plain_allocs = g_allocs;
  g_allocs = 0;
  double t_reserve = Ms([] {
    std::string s;
    s.reserve(kPushes);
    for (int i = 0; i < kPushes; ++i) s.push_back('x');
    Sink(s.data());
  });
  std::size_t reserve_allocs = g_allocs;
  std::printf(
      "%d push_back: %.2f ms / %zu allocs; with reserve: %.2f ms / "
      "%zu allocs\n",
      kPushes, t_plain, plain_allocs, t_reserve, reserve_allocs);

  const char* lit = "this literal is definitely longer than fifteen bytes";
  std::size_t sum = 0;
  g_allocs = 0;
  for (int i = 0; i < 1000; ++i) sum += LenRef(lit);
  std::size_t ref_allocs = g_allocs;
  g_allocs = 0;
  for (int i = 0; i < 1000; ++i) sum += LenView(lit);
  std::size_t view_allocs = g_allocs;
  std::printf(
      "1000 calls with a 52-byte literal: const std::string& -> %zu "
      "allocs, std::string_view -> %zu allocs\n",
      ref_allocs, view_allocs);

  std::string big(1000, 'a');
  std::string_view big_view = big;
  g_allocs = 0;
  for (int i = 0; i < 1000; ++i) Sink(big.substr(0, 500).data());
  std::size_t substr_allocs = g_allocs;
  g_allocs = 0;
  for (int i = 0; i < 1000; ++i) Sink(big_view.substr(0, 500).data());
  std::size_t view_substr_allocs = g_allocs;
  std::printf(
      "1000 substr(0, 500): string -> %zu allocs, string_view -> %zu "
      "allocs\n",
      substr_allocs, view_substr_allocs);
  return (r1 != r2) || sum == 0;
}
```

```text
100000 times, s = s + "x":   115.03 ms
100000 times, s += "x":        0.19 ms (620x faster)
x + "," + y + "," + z: 3 allocs; reserve + append: 1
10000000 push_back: 27.97 ms / 20 allocs; with reserve: 17.64 ms / 1 allocs
1000 calls with a 52-byte literal: const std::string& -> 1000 allocs, std::string_view -> 0 allocs
1000 substr(0, 500): string -> 1000 allocs, string_view -> 0 allocs
```

（计时每次略有波动，分配次数是确定的。同一程序在 libc++ 上：`+=` 比 `s = s + "x"` 快 142 倍，`push_back` 的分配次数是 19 而不是 20。）

- **`s = s + "x"` 每次都构造一个新 string**，把旧内容整个拷一遍，10 万次循环是 $O(n^2)$。`s += "x"` 只在尾部追加。这里差了 601 倍。
- **`reserve`** 把 1000 万次 `push_back` 的分配从 20 次降到 1 次（从 15 开始翻倍，$15 \times 2^{20} \approx 1.6 \times 10^7$ 才够），耗时从 26 ms 降到 17 ms。这是单次测量，波动不小，我猜省下的时间主要是每次扩容时的拷贝，没有单独测。
- **`x + "," + y + "," + z`** 要分配 3 次，先 `reserve` 再 `+=` 只要 1 次。单次拼接无所谓，循环里值得改。
- **`const std::string&` 接收长字面量**，每次调用都要先构造一个临时 string：1000 次调用 1000 次分配。`string_view` 是 0。`substr` 同理，string 版拷贝，view 版只改指针和长度。

这个实验我第一次跑时，`const std::string&` 那一项也是 0 次分配，我差点就信了。原因是 `-O2` 把整个调用内联并常量传播掉了，string 压根没被构造，所以程序里给两个函数加了 `[[gnu::noipa]]`（GCC 专有，Clang 会警告并忽略它，但 Clang 在这里本来就没有优化掉）。0 看着很美，但那不是 string 的功劳。

函数参数的选择，可以按这张表判断：

| 函数要对字符串做什么 | 参数类型 |
| --- | --- |
| 只读，不保存 | `std::string_view` |
| 只读，且要传给需要 `'\0'` 结尾的 C 接口 | `const std::string&`（或 `const char*`） |
| 修改调用者的字符串 | `std::string&` |
| 要保存下来（存进成员、容器） | 按值传 `std::string`，内部 `std::move` |
| 返回新字符串 | 按值返回，编译器会优化掉拷贝 |

## 18. 常见陷阱清单

- `"hello" + 1` 不是拼接，是指针算术。GCC 对它一声不吭，Clang 在 `-Wall` 下会警告 `adding 'int' to a string does not append to the string`：

```cpp
#include <iostream>
#include <string>

int main() {
  // "hello" + 1 is pointer arithmetic on a const char[6], not concatenation.
  std::string t = "hello" + 1;
  std::cout << "\"hello\" + 1 -> [" << t << "]\n";

  // The argument aliases the object itself; the library handles that.
  std::string a = "abc";
  a.append(a);
  a.insert(0, a);
  std::cout << "append and insert of itself -> " << a << "\n";
}
```

```text
"hello" + 1 -> [ello]
append and insert of itself -> abcabcabcabc
```

- 临时 string 的 `c_str()` 在分号处就悬空了：

```cpp
#include <iostream>
#include <string>

int main() {
  std::string first = "a";
  std::string second = "b";
  const char* p = (first + second).c_str();  // BAD: temporary dies at ';'
  std::cout << p << "\n";
}
```

```text
==719494==ERROR: AddressSanitizer: stack-use-after-scope on address 0x76378bc00130 at pc 0x7a378e28604f bp 0x7fffa44df900 sp 0x7fffa44df0d0
READ of size 3 at 0x76378bc00130 thread T0
```

- 其余陷阱前面都讲过：
  - `std::string t{3, 'x'}` 是两个字符，不是三个（第 2 节）。
  - `"a\0b"` 在 `const char*` 构造下只有 1 个字符（第 2 节）。
  - `s.size() - 1` 在空串上回绕（第 5 节）。
  - `find` 的返回值要和 `npos` 比较，不能存进 `int`（第 7 节）。
  - `compare()` 只有符号有意义（第 8 节）。
  - `stoi` 不会因为尾部的垃圾字符抛异常，`stoul("-1")` 不会失败（第 10 节）。
  - `string_view` 不拥有内存，也不保证 `'\0'` 结尾（第 11 节）。
  - 修改 string 后，旧的指针、引用、迭代器全都不能用（第 13 节）。
  - `toupper` 要先转 `unsigned char`；UTF-8 字符串按字节操作会破坏数据（第 4、15 节）。

## 19. 速查表

| 类别 | 成员 | 版本 | 备注 |
| --- | --- | --- | --- |
| 构造/赋值 | 构造函数、`operator=`、`assign` | | `assign_range` (C++23) |
| | `get_allocator` | | |
| 元素访问 | `at`、`operator[]`、`front`、`back` | | `at` 检查越界 |
| | `data`、`c_str` | | 都以 `'\0'` 结尾 |
| | `operator string_view` | C++17 | 隐式转换 |
| 迭代器 | `begin` `end` `rbegin` `rend` 及 `c` 版本 | C++11 | C++20 起为 contiguous |
| 容量 | `empty`、`size`、`length`、`max_size` | | |
| | `capacity`、`reserve`、`shrink_to_fit` | C++11 | `reserve` C++20 起不缩小 |
| 修改 | `clear`、`insert`、`erase` | | `insert_range` (C++23) |
| | `push_back`、`pop_back` | | |
| | `append`、`operator+=` | | `append_range` (C++23) |
| | `replace`、`copy`、`swap` | | `replace_with_range` (C++23) |
| | `resize`、`resize_and_overwrite` | C++23 | 后者写缓冲区 |
| 查找 | `find`、`rfind` | | 返回 `npos` |
| | `find_first_of`、`find_last_of` | | 参数是字符集合 |
| | `find_first_not_of`、`find_last_not_of` | | |
| 操作 | `compare`、`substr` | | `substr` 返回拷贝 |
| | `starts_with`、`ends_with` | C++20 | |
| | `contains` | C++23 | |
| 非成员 | `operator+`、比较运算符、`operator<=>` | C++20 | `<=>` 合成比较 |
| | `operator<<`、`operator>>`、`getline` | | |
| | `std::erase`、`std::erase_if` | C++20 | 返回删除个数 |
| | `stoi` 系列、`to_string` | C++11 | |
| | `operator""s` | C++14 | `"..."s` |
| | `std::hash<std::string>` | C++11 | |

## 参考与练习

- [cppreference: std::basic_string](https://cppreference.com/cpp/string/basic_string)，成员函数全表和每个函数的重载细节。
- [libstdc++ 手册：Dual ABI](https://gcc.gnu.org/onlinedocs/libstdc++/manual/using_dual_abi.html)，第 12 节 COW 的来龙去脉。

练习，答案折叠在每题下面，先自己想一想再点开：

1. 把第 13 节程序里的 `first = 'z';` 改成 `s[0] = 'z';`，程序就合法了。为什么？

<details>
<summary>参考答案</summary>

`first` 是在 `append` 之前取的引用，指向旧缓冲区。`append(1000, 'b')` 超出了 capacity，缓冲区被重新分配，旧缓冲区被释放，`first` 就悬空了。`s[0]` 每次调用都从**当前**缓冲区里取字符，所以不受影响。规则是：不要跨过修改操作保存引用，每次用的时候重新取，或者保存下标。

```cpp
#include <iostream>
#include <string>

int main() {
  std::string s(40, 'a');
  s.append(1000, 'b');  // may reallocate; any old reference is now invalid
  s[0] = 'z';           // OK: operator[] looks at the current buffer
  std::cout << s[0] << s.size() << "\n";
}
```

用 `-g -fsanitize=address` 编译运行，ASan 没有报告，输出是首字符 `z` 加 size 1040：

```text
z1040
```

</details>

2. `Split` 现在只能按单个字符切。改成按子串切，并写出会让朴素实现死循环的输入。

<details>
<summary>参考答案</summary>

按子串切时，每段之后要跳过整个分隔符：`start = end + delim.size()`。朴素实现会死循环的输入是**空分隔符**：`find("", start)` 返回 `start` 本身，`delim.size()` 是 0，`start` 永远不前进。所以必须先判断 `delim.empty()`，这里选择把整个串当作一段返回。

另外两点：分隔符从左到右**不重叠**地匹配，`"aaa"` 按 `"aa"` 切得到 `[] [a]`；结尾紧跟分隔符时保留末尾的空段，和第 16 节的行为一致。

```cpp
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

std::vector<std::string_view> SplitBy(std::string_view s,
                                      std::string_view delim) {
  if (delim.empty()) return {s};  // nothing to split on
  std::vector<std::string_view> parts;
  std::size_t start = 0;
  while (true) {
    std::size_t end = s.find(delim, start);
    if (end == std::string_view::npos) {
      parts.push_back(s.substr(start));
      return parts;
    }
    parts.push_back(s.substr(start, end - start));
    start = end + delim.size();
  }
}

// BAD: without the empty-delimiter check, find("", start) returns start and
// start never advances. The cap makes the hang visible instead of real.
int NaiveIterations(std::string_view s, std::string_view delim, int cap) {
  std::size_t start = 0;
  int n = 0;
  while (n < cap) {
    std::size_t end = s.find(delim, start);
    if (end == std::string_view::npos) return n;
    start = end + delim.size();
    ++n;
  }
  return n;
}

void Show(std::string_view s, std::string_view delim) {
  auto parts = SplitBy(s, delim);
  std::cout << "\"" << s << "\" by \"" << delim << "\" -> " << parts.size()
            << ":";
  for (auto p : parts) std::cout << " [" << p << "]";
  std::cout << "\n";
}

int main() {
  Show("a--b--c", "--");
  Show("a--b--", "--");
  Show("aaa", "aa");
  Show("aaaa", "aa");
  Show("abc", "");
  std::cout << "naive loop with empty delimiter: still running after "
            << NaiveIterations("abc", "", 1000000) << " iterations\n";
}
```

```text
"a--b--c" by "--" -> 3: [a] [b] [c]
"a--b--" by "--" -> 3: [a] [b] []
"aaa" by "aa" -> 2: [] [a]
"aaaa" by "aa" -> 3: [] [] []
"abc" by "" -> 1: [abc]
naive loop with empty delimiter: still running after 1000000 iterations
```

最后一行是故意写的 BAD 版本：给循环加了一个上限，否则它就真的不会停。

</details>

3. libc++ 的增长路径是 22 → 47 → 95 → ...，用它算一算 1000 万次 `push_back` 为什么是 19 次分配，再对照 libstdc++ 的 20 次。

<details>
<summary>参考答案</summary>

libstdc++ 每次容量翻倍，从 15 开始：$15 \times 2^{k} \ge 10^7$ 的最小 $k$ 是 20（$15 \times 2^{19} = 7864320$ 不够，$15 \times 2^{20} = 15728640$ 够），所以 20 次。

libc++ 的数列 22、47、95 不是纯翻倍。我拟合出的规律是：新容量 = 把 $2c + 1$ 向上取整到 16 的倍数，再减 1（$22 \to 45 \to 48 \to 47$，$47 \to 95 \to 96 \to 95$）。这个规律是我从数字里反推的，没有读 libc++ 的源码确认，但它预测的增长次数和最终容量都和实际观察完全一致。从 22 开始需要 19 次才到 $\ge 10^7$，所以是 19 次。起点高（22 对 15）加上每次略多于翻倍，省了一次。

```cpp
#include <iostream>
#include <string>
#include <vector>

std::vector<std::size_t> Observe(std::size_t n) {
  std::vector<std::size_t> caps;
  std::string s;
  caps.push_back(s.capacity());
  for (std::size_t i = 0; i < n; ++i) {
    s.push_back('x');
    if (s.capacity() != caps.back()) caps.push_back(s.capacity());
  }
  return caps;
}

int main() {
  constexpr std::size_t kN = 10'000'000;
  std::vector<std::size_t> caps = Observe(kN);
  std::cout << "observed:";
  for (std::size_t i = 0; i < 5; ++i) std::cout << " " << caps[i];
  std::cout << " ... " << caps.back() << "\n";
  std::cout << "growths to reach " << kN << ": " << caps.size() - 1 << "\n";

  std::size_t cap = caps.front();
  int n = 0;
  while (cap < kN) {
    cap = (2 * cap + 1 + 15) / 16 * 16 - 1;  // round the block up to 16 bytes
    ++n;
  }
  std::cout << "model (2 * cap + 1 rounded up to 16, minus 1): " << n
            << " growths, final capacity " << cap << "\n";
}
```

在 libc++ 上的输出（`observed` 是真实观察，`model` 是上面的规律算出来的）：

```text
observed: 22 47 95 191 383 ... 12582911
growths to reach 10000000: 19
model (2 * cap + 1 rounded up to 16, minus 1): 19 growths, final capacity 12582911
```

同一个程序在 libstdc++ 上，`observed` 两行是真实的，`model` 那行不适用（它是 libc++ 的规律）：

```text
observed: 15 30 60 120 240 ... 15728640
growths to reach 10000000: 20
model (2 * cap + 1 rounded up to 16, minus 1): 20 growths, final capacity 16777215
```

</details>
