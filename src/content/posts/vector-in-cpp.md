---
title: "C++ 中的 vector"
commentId: "post:vector-in-cpp"
published: "2026-01-03 18:50:00 +08:00"
updated: 2026-10-05
description: "不再罗列 API，而是把 std::vector 的每条经验都写成能跑的程序量一遍：扩容系数、reserve 的真实收益、emplace_back 到底省了什么、迭代器失效如何复现、erase-remove 的陷阱、std::vector<bool> 的隐藏代价。代码全部遵循 Google C++ Style。"
category: Note
tags:
  - C++
draft: false
comment: true
---

`std::vector` 是我在 C++ 里用得最多的容器，没有之一。但用了很多年之后，我发现自己对它的理解仍然停在两句口号上：**连续内存**、**自动扩容**。口号记住了，可是"扩容到底拷贝了多少个元素""`reserve` 究竟能省多少时间"这类问题，我从来没真正算过。

所以这篇笔记换了个写法：不再罗列 API，而是写一组能跑的小程序，把每条结论都量一遍。下面的数字都是实机跑出来的：GCC 15.3.0、libstdc++、C++20、x86-64 Linux，计时代码用 `-O2` 编译，抓 bug 的版本另开 sanitizer。代码为了能直接抄走使用，全部按 Google C++ Style 写。

## 本质是三个指针，不是"数组"

libstdc++ 里 `std::vector<T>` 的全部状态就是三个指针。我翻了一下 `bits/stl_vector.h` 确认：

```cpp
pointer _M_start;           // 首元素
pointer _M_finish;          // 尾后位置，size() 的上界
pointer _M_end_of_storage;  // 已分配内存的尾后位置，capacity() 的上界
```

于是 `size() == _M_finish - _M_start`，`capacity() == _M_end_of_storage - _M_start`。在 64 位平台上 `sizeof(std::vector<int>) == 24`，正好三个指针。

我觉得最好用的比喻是租仓库：`capacity` 是你租下的面积，`size` 是里面实际放了多少货。仓库可以是空的，但租金照付。这个区别后面会反复出现。

| 函数 | 改的是什么 | 备注 |
|:---|:---|:---|
| `size()` | 什么都不改 | 当前元素个数 |
| `capacity()` | 什么都不改 | 当前容量，永远 $\geqslant$ `size()` |
| `empty()` | 什么都不改 | 比 `size() == 0` 更达意 |
| `reserve(n)` | 只改 `capacity` | 只申请内存，不构造元素 |
| `resize(n)` | 改 `size` | 变大时构造新元素，变小时析构旧元素 |
| `shrink_to_fit()` | 尝试缩小 `capacity` | 非强制请求（C++11） |

"`resize` 改 `size`、`reserve` 改 `capacity`"这句话，光看定义很容易滑过去，跑一遍才印象深刻：

```cpp
#include <iostream>
#include <vector>

int main() {
  std::vector<int> values;
  for (int i = 0; i < 1000; ++i) {
    values.push_back(i);
  }
  std::cout << "after push_back: size=" << values.size()
            << " capacity=" << values.capacity() << "\n";

  values.erase(values.begin() + 10, values.end());
  std::cout << "after erase:     size=" << values.size()
            << " capacity=" << values.capacity() << "\n";

  values.clear();
  std::cout << "after clear:     size=" << values.size()
            << " capacity=" << values.capacity() << "\n";

  values.shrink_to_fit();
  std::cout << "after shrink:    size=" << values.size()
            << " capacity=" << values.capacity() << "\n";
  return 0;
}
```

```text
after push_back: size=1000 capacity=1024
after erase:     size=10 capacity=1024
after clear:     size=0 capacity=1024
after shrink:    size=0 capacity=0
```

注意后三行：`erase` 删掉了 990 个元素，`clear` 把 `size` 归零，但 `capacity` 一直是 1024，一块内存都没还。想还回去只能显式 `shrink_to_fit()`，而且它只是"请求"，标准不保证实现一定照做。

## 扩容：libstdc++ 每次翻倍

把 `capacity` 每次变化都打出来，规律立刻现形：

```cpp
std::vector<int> values;
std::size_t last_capacity = 0;
for (int i = 0; i < 1025; ++i) {
  values.push_back(i);
  if (values.capacity() != last_capacity) {
    last_capacity = values.capacity();
    std::cout << "size=" << values.size() << " capacity=" << last_capacity
              << "\n";
  }
}
```

```text
size=1 capacity=1
size=2 capacity=2
size=3 capacity=4
size=5 capacity=8
size=9 capacity=16
size=17 capacity=32
...
size=513 capacity=1024
size=1025 capacity=2048
```

1、2、4、8、16…… 每满一次就翻一倍。原因在 `_M_check_len`：

```cpp
const size_type __len = size() + (std::max)(size(), __n);
```

`push_back` 时 `__n == 1`，所以新容量是 `size() + size()`，也就是两倍。**这是 libstdc++ 的实现选择，不是标准规定**。我记得 MSVC 用的是 1.5 倍；1.5 倍的好处是更容易复用刚刚释放的内存块，翻倍的好处是元素搬移次数更少。这是纯实现层面的权衡，写代码时不该依赖具体系数：

> [!WARNING] 不要依赖扩容系数
> 别写"反正它会翻倍，所以我 push 了 1000 个之后 capacity 一定是 1024"这种代码。换个标准库实现就不成立了。

翻倍的代价可以用等比数列算清楚：容量按 $1, 2, 4, \dots, 2^k$ 增长，元素从 0 涨到 $N$ 的过程中，被搬移的元素总数不超过

$$
N \cdot \frac{r}{r - 1}
$$

其中 $r$ 是增长系数。$r = 2$ 时大约是 $2N$：**每个元素平均被搬移两次**。这个常数不大，代价可控，所以 `push_back` 的均摊复杂度才是 $O(1)$。

## reserve：我量出来是 3.2 倍

既然扩容就是要搬元素，那提前 `reserve` 掉扩容，收益有多大？我写了两个版本，各塞入 2000 万个 `int`（约 80 MB）：

```cpp
double TimePushBack(bool reserve_first) {
  std::vector<int> values;
  if (reserve_first) {
    values.reserve(kCount);
  }
  const auto start = std::chrono::steady_clock::now();
  for (std::size_t i = 0; i < kCount; ++i) {
    values.push_back(static_cast<int>(i));
  }
  const auto end = std::chrono::steady_clock::now();
  const std::chrono::duration<double, std::milli> elapsed = end - start;
  return elapsed.count();
}
```

跑两遍：

```text
no reserve: 124.928 ms      no reserve: 121.734 ms
reserve:    38.6949 ms      reserve:    38.1589 ms
speedup:    3.22855x        speedup:    3.19018x
reallocations for 20000000 push_backs: 26
```

**3.2 倍**，而且 20M 次 `push_back` 期间一共只发生了 26 次重新分配（$1, 2, 4, \dots, 2^{25}$，正好 26 个容量档位），代价是额外搬移了约 3350 万个 `int`，也就是一百多 MB 的内存流量。

所以"能预估大小时先 `reserve`"不是玄学，是一百多 MB 的差别。当然反过来也成立：

> [!CAUTION] 别乱 reserve
> 2000 万个元素你 reserve 两亿，那就是凭空占用八倍内存。`reserve` 的前提是真的能预估，而不是"多多益善"。

## push_back 和 emplace_back：省的到底是哪一次拷贝

教科书式的说法是"`emplace_back` 原地构造，比 `push_back` 高效"。为了看清它到底省了什么，我给一个会数数的类型挂了两个计数器：

```cpp
class Widget {
 public:
  explicit Widget(std::string name) : name_(std::move(name)) {}
  Widget(const Widget& other) : name_(other.name_) { ++copy_count_; }
  Widget(Widget&& other) noexcept : name_(std::move(other.name_)) {
    ++move_count_;
  }
  Widget& operator=(const Widget&) = delete;
  Widget& operator=(Widget&&) = delete;

  static int copy_count() { return copy_count_; }
  static int move_count() { return move_count_; }
  static void Reset() {
    copy_count_ = 0;
    move_count_ = 0;
  }

 private:
  static int copy_count_;
  static int move_count_;
  std::string name_;
};
```

同样的两个元素，分别用两种方式放进去：

```text
push_back:    copies=1 moves=1
emplace_back: copies=1 moves=0
```

结论很清楚：`push_back` 传入临时对象时，多了一次**移动构造**；`emplace_back` 直接拿参数在 `vector` 的尾部原地构造，连那次移动都省了。两者的复制次数相同（那次复制来自传左值 `lvalue`，这点 `emplace_back` 救不了你：参数已经是现成对象时，怎么放进去都得拷一次）。

那么这次省下的移动值多少时间？我用一个带 1 KB 数组的类型，塞 100 万个元素，量了冷启动和预热后的版本：

```text
push_back cold: 513.6 ms      push_back warm: 122.5 ms
emplace   cold: 468.4 ms      emplace   warm: 134.7 ms
cold ratio: 1.096x            warm ratio: 1.18x
```

老实说，这个结果让我有点意外：冷启动只有 1.1 倍，页面预热之后比例直接掉进噪音里（两次跑出来分别是 0.91 倍和 1.18 倍，`¯\_(ツ)_/¯`）。我的解释是：冷启动那次的时间主要花在新申请内存的**首次触碰缺页**上，那点移动开销被淹没了；而 `Heavy` 是平凡可拷贝类型，一次 1 KB 的移动就是一次 `memcpy`，现代移动语义早就把这种琐碎开销压得很低。

所以我的实践结论是：

- 默认用 `emplace_back`，它逻辑上更准确（"在这里构造一个"而不是"构造一个再搬进来"），习惯也好。
- 但别指望它带来数量级提升。真正的差别是**一次移动构造**，对便宜移动的类型几乎可以忽略。
- 有个容易忽略的细节：`emplace_back` 走的是直接初始化，所以它会调用 `explicit` 构造函数。这是特性还是坑，取决于你想要的语义。
- 顺带一提，`std::vector<T>` 要能增长，`T` 必须是 MoveInsertable。把移动构造函数 `= delete` 掉之后，连 `reserve` 都编不过（我试了，错误信息一路指回 `Immovable::Immovable(Immovable&&)` 被删除）。

（"预热"版本的改动只有一处：计时前先 `resize(kCount)` 把整块内存触碰一遍，再 `clear()` 掉，这样计时期间就不会再发生首次触碰缺页。）

## 访问：operator[] 不做检查

`operator[]` 和 `at()` 的区别只有一句话：`at()` 越界抛 `std::out_of_range`，`operator[]` 越界是未定义行为。日常读写用 `operator[]`，处理外部输入或者调试时用 `at()`。

`data()` 返回底层数组的首指针，是和 C API 打交道的正经通道：

```cpp
int CompareInts(const void* left, const void* right) {
  const int left_value = *static_cast<const int*>(left);
  const int right_value = *static_cast<const int*>(right);
  return left_value - right_value;
}

int main() {
  std::vector<int> values = {5, 3, 1, 4, 2};
  std::qsort(values.data(), values.size(), sizeof(int), CompareInts);
  for (int value : values) {
    std::cout << value << " ";
  }
  std::cout << "\n";
  return 0;
}
```

```text
1 2 3 4 5
```

一个细节：`data()` 返回的指针在容器变化（尤其是扩容）后同样会失效，别缓存它。空 `vector` 上调用 `data()` 得到的指针不可解引用。

## 迭代器失效：连续内存的代价

"连续内存"是所有优点的源头，也是所有 bug 的源头。只要发生扩容，旧内存被释放，指向它的**迭代器、指针、引用**全部悬空。这种 bug 最讨厌的地方是它经常"看起来能跑"，所以我用工具把它抓出来。

先看引用失效。下面这段代码很自然，但它读的是一个已经释放的地址：

```cpp
std::vector<int> values = {1, 2, 3, 4};
const int& first = values[0];
for (int i = 0; i < 100; ++i) {
  values.push_back(i);
}
std::cout << first << "\n";
```

用 `-fsanitize=address` 编译，运行立刻报错：

```text
==25009==ERROR: AddressSanitizer: heap-use-after-free on address 0x6cc39e5e0010
READ of size 4 at 0x6cc39e5e0010 thread T0
    #0 0x586fe2251aa3 in main 04a_dangling.cpp:11
freed by thread T0 here:
    #6 0x586fe2251997 in ...::_M_realloc_append<int const&>(int const&)
SUMMARY: AddressSanitizer: heap-use-after-free 04a_dangling.cpp:11 in main
```

堆已经被 `push_back` 触发的重新分配释放了，`first` 成了悬空引用。关掉 sanitizer 之后这段代码大概率还能打印出"正确"的值，然后在你改代码的那天突然崩。

再看迭代器。这是每个人第一次写 `vector` 删除都会踩的坑：

```cpp
std::vector<int> values = {1, 2, 3, 4};
for (auto it = values.begin(); it != values.end(); ++it) {
  if (*it % 2 == 0) {
    values.erase(it);
  }
}
```

用 `-D_GLIBCXX_DEBUG` 编译（调试迭代器），运行直接终止：

```text
Error: attempt to increment a singular iterator.
```

原因：`erase(it)` 之后，`it` 及其之后的迭代器全部失效，下一轮循环 `++it` 操作的是一个失效迭代器。正确写法是接住 `erase` 的返回值：

```cpp
std::vector<int> values = {1, 2, 3, 4, 5, 6};
for (auto it = values.begin(); it != values.end();) {
  if (*it % 2 == 0) {
    it = values.erase(it);  // erase 返回下一个有效位置
  } else {
    ++it;
  }
}
```

```text
1 3 5
```

失效规则可以压缩成两条：

- **扩容**：所有迭代器、指针、引用全部失效（内存整个换了一块）。
- **`insert` / `erase`**：操作位置及其之后的全部失效，之前的仍然有效。

由此推出两条经验：

1. 需要长期持有指向元素的引用或指针时，先 `reserve` 到不会再扩容，或者干脆存**下标**，用的时候再 `values[i]` 取。
2. 涉及 `insert` / `erase` 的循环，永远用返回值刷新迭代器。

编译器可以在编译期帮你挡掉一部分这类问题：日常开发给 libstdc++ 加 `-D_GLIBCXX_DEBUG`（Clang 配 libstdc++ 时同样可用），提交前再跑一遍 `-fsanitize=address`。这类工具抓悬空引用是降维打击。

## erase-remove：为什么 remove 之后 size 还是 8

C++20 之前，从 `vector` 里删掉所有偶数要写 `erase(remove_if(...), end())`。这个组合看着别扭，是因为 `std::remove_if` **根本不删除元素**：

```cpp
std::vector<int> values = {1, 2, 3, 4, 5, 6, 7, 8};
const auto new_end =
    std::remove_if(values.begin(), values.end(),
                   [](int x) { return x % 2 == 0; });
std::cout << "after std::remove_if: size=" << values.size()
          << " logical size=" << (new_end - values.begin()) << "\n";
```

```text
after std::remove_if: size=8 logical size=4
1 3 5 7 5 6 7 8
after erase: size=4
1 3 5 7
```

`remove_if` 只是把要保留的元素向前挪，返回新的逻辑尾位置，容器本身的大小没变。所以那串 `5 6 7 8` 是留下来的残渣，必须靠 `erase(new_end, values.end())` 才真正清掉。算法和容器各司其职，这是 STL "算法不改变容器大小" 原则的直接体现。

C++20 起，标准库直接提供了封装好的版本，不用再手写这个组合：

```cpp
const std::size_t removed =
    std::erase_if(values, [](int x) { return x % 2 == 0; });
```

```text
removed=4 size=4
1 3 5 7
```

返回被删除的元素个数。按值删除用 `std::erase(values, value)`。这两个函数（`<vector>` 里就能用）是我个人认为 C++20 日常收益最高的几个特性之一。

## std::vector<bool>：一个真正的坑

`std::vector<bool>` 是标准库里的历史遗留特化：为了省空间，它不存 `bool`，而是把每个元素压成 1 bit。省是省了，代价也实打实。

**省下八分之七的内存，代价是丢掉一个正常容器该有的行为。** 8388608 个元素：

```text
vector<bool> payload: 1048576 bytes
vector<char> payload: 8388608 bytes
sizeof(std::vector<bool>::reference)=16
```

内存正好是 `std::vector<char>` 的八分之一。好处到此为止。因为单个 bit 没有地址，`operator[]` 不能返回 `bool&`，只能返回一个 16 字节的**代理对象**：

```cpp
std::vector<bool> flags = {true, false};
bool& ref = flags[0];  // 编不过
```

错误信息很直白：

```text
错误：无法将类型为 'bool&' 的非 const 左值引用绑定到类型为 'bool' 的右值
```

代理对象还有个更阴险的地方。用 `auto` 接住它时，你拿到的不是一份 `bool` 快照，而是一个指向该 bit 的活引用：

```cpp
std::vector<bool> flags = {true, false};
auto bit = flags[0];  // 推导出的是代理类型，不是 bool
flags[0] = false;
std::cout << "flags[0]=" << flags[0] << " bit=" << bit << "\n";
```

```text
flags[0]=0 bit=0
```

`bit` 跟着 `flags[0]` 一起变成了 0。它能用，但它的类型不是 `bool`，把它传给模板或者 `auto&&` 全展开的代码时，报错会非常难读。

**真正危险的是并发。** 标准明确规定：同一个容器不同元素被并发修改是安全的，但这条保证**明确把 `std::vector<bool>` 排除在外**。原因是多个 bit 共享同一个机器字。用 ThreadSanitizer 跑两个线程分别翻转第 0 位和第 1 位：

```cpp
std::vector<bool> bits(2, false);
std::thread first([&bits] {
  for (int i = 0; i < 1000000; ++i) {
    bits[0] = !bits[0];
  }
});
std::thread second([&bits] {
  for (int i = 0; i < 1000000; ++i) {
    bits[1] = !bits[1];
  }
});
first.join();
second.join();
```

```text
WARNING: ThreadSanitizer: data race
  Read of size 8 at 0x720400000000 by thread T2:
    #0 std::_Bit_reference::operator bool() const stl_bvector.h:106
  Previous write of size 8 at 0x720400000000 by thread T1:
    #0 std::_Bit_reference::operator=(bool) stl_bvector.h:113
SUMMARY: ThreadSanitizer: data race 05b_bool_race.cpp:14
```

看清楚读写大小：**8 字节**，也就是一个机器字。libstdc++ 的代理每次都要读改写整个机器字来翻转一个 bit，两个线程自然就撞上了。把类型换成 `std::vector<char>`（两个线程各写自己的字节），同样的测试静默通过。

所以要用的时候：

- 只是存一堆开关，不缺那八分之一内存，用 `std::vector<char>`，行为和普通容器一致。
- 确实要位操作，用 `std::bitset`（大小固定）或者自己封装 `uint64_t` 数组（需要注意并发和边界）。
- `std::vector<bool>` 只在"元素极多、只读或单线程、并且真的在乎内存"时才值得。

## 什么时候别用它

`vector` 的软肋是头部和中间插入，因为要搬动后面所有元素。20,000 次插入，只改插入位置：

```text
insert at front: 8.21697 ms      insert at front: 8.16348 ms
push_back:       0.04288 ms      push_back:       0.040175 ms
ratio:           191.627x        ratio:           203.198x
```

**约 200 倍**，还只是在两万元素这个规模。这个量级没有悬念：需要在头部或中间频繁插入删除，就换 `std::deque` 或 `std::list`。

另一面是缓存。连续内存的真正优势在这里，我给 `vector` 和 `list` 各塞 1000 万个 `int`，只做一次求和：

```text
vector: 5.84785 ms      vector: 6.32172 ms
list:   25.3419 ms      list:   26.7437 ms
ratio:  4.33354x        ratio:  4.23046x
```

**4.3 倍**。`list` 的每个节点都散在堆上，遍历就是一路 cache miss；`vector` 是顺序读取，CPU 预取器全程满载。这也解释了一个常见的反直觉现象：即使是在中间插入，对于小对象（比如 `int`），`vector` 往往仍然比 `list` 快。链表的 $O(1)$ 是指针层面的，但指针本身要跳内存。

所以默认选择永远先问自己：**真的需要中间插入吗？** 大多数"需要"其实是"我没想清楚"。真需要时，再考虑 `deque`、`list` 或者干脆换数据结构。

## 一份可以直接抄的清单

- 能预估大小时先 `reserve`，我实测尾部插入快 3.2 倍。
- 默认用 `emplace_back`，但别指望它比 `push_back` 快很多，差别只有一次移动构造。
- 头部或中间频繁插入，换 `std::deque` 或 `std::list`。
- 长期持有元素引用或指针时，先 `reserve` 或者改存下标。
- 涉及 `insert` / `erase` 的循环，用返回值刷新迭代器。
- 删除满足条件的元素，优先用 C++20 的 `std::erase_if`。
- 慎用 `std::vector<bool>`。并发场景下直接换 `std::vector<char>`。
- 开发期开 `-D_GLIBCXX_DEBUG`，提交前跑一遍 `-fsanitize=address`。

## 写在最后

如果这篇笔记只能留一句话，我会留这句：**`vector` 的几乎所有性能问题，都能翻译成"这次操作拷贝了多少字节"。** 扩容是拷贝，中间插入是拷贝，`reserve` 是省掉拷贝，`emplace_back` 是省掉一次构造。想清楚拷贝量，剩下的都是推论。

顺着这个思路，你还可以接着往下量：换 MSVC 验证一下扩容系数是不是 1.5，把 `std::vector<bool>` 的并发程序换成 `std::vector<char>` 再看 TSan，或者把自己项目里最热的那个 `vector` 的 `reserve` 去掉跑一遍基准。这次实验用的每个程序都不超过四十行，文中列出的代码加上几行计时脚手架就能复现，花不了十分钟。真正让我对 `vector` 放心的，不是这篇文章，是那十几个程序。

参考：

- [cppreference: std::vector](https://en.cppreference.com/w/cpp/container/vector)
- [cppreference: std::vector\<bool\>](https://en.cppreference.com/w/cpp/container/vector_bool)
- libstdc++ 源码：`bits/stl_vector.h`、`bits/stl_bvector.h`
- 《Effective STL》，第 14 条（`reserve`）与第 17、18 条（`erase-remove`）
