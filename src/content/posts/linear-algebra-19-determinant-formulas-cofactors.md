---
title: "18.06 第 19 讲：行列式公式与代数余子式"
commentId: "post:linear-algebra-19-determinant-formulas-cofactors"
published: "2026-10-18 14:00:00 +08:00"
description: "MIT 18.06 第 19 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 以 itertools.permutations 实现行列式的大公式、余子式展开和三对角矩阵的递推，6 × 6 随机矩阵的 720 项之和与 np.linalg.det 都是 -7.439860，61 阶三对角矩阵的行列式则是 1。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 行列式
  - 代数余子式
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 19
draft: false
comment: true
slug: linear-algebra-19-determinant-formulas-cofactors
---

上一讲 Strang 用三条性质推出了十条性质，这一讲他把同样的三条性质用到底，得到一个能直接从 $a_{ij}$ 算出行列式的公式：4 × 4 矩阵有 24 项，6 × 6 有 720 项，每一项都是“每行每列各取一个数”的乘积，再带上正负号。我拿他在黑板上现编的 4 × 4 例子去数，24 项里只有两项不是零，一项 $+1$、一项 $-1$，加起来是 0。之后是第二个公式（余子式展开），以及一个三对角矩阵的行列式：它每六阶重复一次，所以 $\det A_{61} = 1$。

> [!NOTE] 本讲速览
> 视频：[Lecture 19: Determinant formulas and cofactors](https://www.youtube.com/watch?v=23LLB9mNJvc)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-19-determinant-formulas-and-cofactors/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §5.1 3 by 3 Determinants and Cofactors；§5.2 Computing and Using Determinants
> 前置：[第 18 讲：行列式的性质](/posts/linear-algebra-18-determinant-properties/)
> 一句话：行列式等于 $n!$ 项“每行每列各取一个”的带符号乘积（大公式），也等于沿一行的 $a_{1j}$ 乘以各自的代数余子式之和，后者把 $n$ 阶行列式拆成 $n - 1$ 阶的。

> [!TIP] 配合视频
> - 开头他先用三条性质把 2 × 2 的 $ad - bc$ 重新推了一遍，只是为了展示方法。这一段值得认真听，后面全是这个套路的重复。
> - 3 × 3 的“幸存者”那段是整讲的核心：把每一行拆开，二十七块里只有每行每列各一个的才活下来，他还逐个判断了正负号。我把它写成了 `itertools.permutations`，本篇第一个代码块里算过。
> - 现编的 4 × 4 例子（二十四项里二十二项为零）他自己说“以前没算过”，可以认真看他怎么把整个过程走下来。矩阵他写在黑板上，字幕里没有，我按他描述的路径还原了一个。
> - 代数余子式的定义和符号规则（棋盘格）也要看；最后三对角矩阵的例子很短，周期是 6 那里是整讲最有意思的地方，我在最后一个代码块里算过。

## 把三条性质用到底：大公式

**行列式到底由什么构成？** 回忆上一讲的三条性质：$\det I = 1$；交换两行，行列式变号；对每一行单独看，行列式是线性的。Strang 先在 2 × 2 上演示怎么用它们算出一个公式。

做法是把第一行 $(a, b)$ 拆成 $(a, 0) + (0, b)$，再把第二行 $(c, d)$ 拆成 $(c, 0) + (0, d)$，用性质三（对每一行线性）得到四个行列式：

$$
\begin{aligned}
\begin{vmatrix} a & b \\ c & d \end{vmatrix}
&= \begin{vmatrix} a & 0 \\ c & 0 \end{vmatrix} +
\begin{vmatrix} a & 0 \\ 0 & d \end{vmatrix} \\
&\quad +
\begin{vmatrix} 0 & b \\ c & 0 \end{vmatrix} +
\begin{vmatrix} 0 & b \\ 0 & d \end{vmatrix}
\end{aligned}
$$

第一个和第四个有一整列是 0，是奇异矩阵，行列式为 0，他说“它死了”。第二个是对角矩阵，行列式 $ad$。第三个要换一次行才变成对角矩阵，行列式是 $-bc$。四项里两项活下来，$ad - bc$ 就这么出来了。

重点是方法，不是这个答案。3 × 3 时，第一行拆成三块，第二行再拆成三块，第三行再来一次，一共 $3^3 = 27$ 块。我数了一下，4 × 4 是 $4^4 = 256$ 块。这些块里，只要某一列没被任何一行选到，那一列全是零，整块的行列式为 0。

**幸存者是谁？** 每一行选一个位置，每一列也恰好被选一次的那些块。他的 3 × 3 里有六个幸存者，对应列号 $(1,2,3)$、$(1,3,2)$、$(2,1,3)$、$(2,3,1)$、$(3,1,2)$、$(3,2,1)$ 的排列。每一块把选中的数提出来，剩下的是一个只有 0 和 1 的置换矩阵，它的行列式是 $\pm 1$，由把它换回单位矩阵需要的行交换次数的奇偶决定。$(1,3,2)$ 要换一次，所以是 $-1$；$(2,3,1)$ 要换两次，所以是 $+1$。合起来：

$$
\begin{aligned}
\det A &= a_{11}a_{22}a_{33} - a_{11}a_{23}a_{32} -
a_{12}a_{21}a_{33} \\
&\quad + a_{12}a_{23}a_{31} + a_{13}a_{21}a_{32} -
a_{13}a_{22}a_{31}
\end{aligned}
$$

正号三项沿着“往下”的方向，负号三项沿着“反方向”，这是他口中去迈阿密和洛杉矶的那两条线。他立刻说这个口诀只对 3 × 3 成立：4 × 4 的反对角线（全是 1 的那条）行列式是 $+1$，因为交换第 1、4 行和第 2、3 行共两次就回到单位矩阵。

推广到 $n$ 阶，就是他书里的大公式（big formula）：

$$
\det A = \sum_{\text{所有排列 }(\alpha,\beta,\ldots,\omega)}
\pm\, a_{1\alpha}\, a_{2\beta} \cdots a_{n\omega}
$$

第一行有 $n$ 种选法，选完占掉一列，第二行剩 $n - 1$ 种，依此类推，一共 $n!$ 项，一半正一半负。正负号看排列的奇偶。我猜这条公式如果做成棋盘上的游戏，就是在 $n \times n$ 的棋盘上放 $n$ 个互不攻击的车，每种放法对应一项（这个类比我只用这一次）。

下面把它实现出来。`itertools.permutations` 给出所有列号排列，符号用逆序对的个数的奇偶判断（相邻两个数交换一次，逆序对数恰好变 1，所以它的奇偶和“交换次数的奇偶”是同一回事）。脚本先打印 3 × 3 的六个排列和符号，再数反对角线的行列式，数 $n!$ 的项数，最后在一个 6 × 6 的随机矩阵上对比 `np.linalg.det`：

```python
import itertools

import numpy as np


def perm_sign(perm: tuple[int, ...]) -> int:
    """数逆序对的个数，奇数个就是奇置换。"""
    inversions = sum(
        1
        for i in range(len(perm))
        for j in range(i + 1, len(perm))
        if perm[i] > perm[j]
    )
    return -1 if inversions % 2 else 1


def big_formula(A: np.ndarray) -> float:
    """行列式的大公式：每行每列各取一个数，共 n! 项。"""
    n = A.shape[0]
    total = 0.0
    for perm in itertools.permutations(range(n)):
        term = perm_sign(perm)
        for row, col in enumerate(perm):
            term *= A[row, col]
        total += term
    return total


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 3 x 3 的六项：列号的排列、符号
    for perm in itertools.permutations(range(3)):
        cols = tuple(c + 1 for c in perm)
        print(cols, "符号", f"{perm_sign(perm):+d}")

    # 反对角线：4 x 4 是 +1，3 x 3 是 -1
    for n in (2, 3, 4):
        J = np.fliplr(np.eye(n))
        print(n, "阶反对角线的行列式：", round(np.linalg.det(J)))

    # 项数：n!
    for n in (2, 3, 4, 5, 6):
        count = sum(1 for _ in itertools.permutations(range(n)))
        print(f"n = {n}：{count} 项")

    rng = np.random.default_rng(1806)
    A = rng.standard_normal((6, 6))
    print(f"大公式：{big_formula(A):.6f}")
    print(f"np.linalg.det：{np.linalg.det(A):.6f}")
    print("一致：", np.isclose(big_formula(A), np.linalg.det(A)))


if __name__ == "__main__":
    main()
```

```text
(1, 2, 3) 符号 +1
(1, 3, 2) 符号 -1
(2, 1, 3) 符号 -1
(2, 3, 1) 符号 +1
(3, 1, 2) 符号 +1
(3, 2, 1) 符号 -1
2 阶反对角线的行列式： -1
3 阶反对角线的行列式： -1
4 阶反对角线的行列式： 1
n = 2：2 项
n = 3：6 项
n = 4：24 项
n = 5：120 项
n = 6：720 项
大公式：-7.439860
np.linalg.det：-7.439860
一致： True
```

六个排列里三正三负，和他黑板上写的一致；反对角线单位矩阵的行列式是 2 阶 $-1$、3 阶 $-1$、4 阶 $+1$，确认了“口诀只对 3 × 3 成立”。6 × 6 矩阵用 720 项算出的 $-7.439860$ 和 `np.linalg.det` 完全对上。

他还指出，大公式可以反推所有性质：$A = I$ 时，只有 $a_{11}a_{22}\cdots a_{nn}$ 这一项（排列是 $1,2,\ldots,n$，符号为正）不为零，所以 $\det I = 1$。同样可以看出 $\det A = \det A^{\mathsf{T}}$，因为转置只是把“行选列”换成“列选行”。至于 $\det AB = \det A \det B$，他说从这条公式出发证明会弄到“下个星期还在做”，大概就是不会再提了。

## 一个例子：二十四项里只有两项活着

Strang 现场编了一个 4 × 4 的 0-1 矩阵，说“我不知道它的行列式，数学正在你们眼前第一次被做出来”。字幕里没有写出矩阵，只有他的走法：第一条路取出排列 $(4,3,2,1)$，交换两次回到 $(1,2,3,4)$，是 $+1$；第二条路是 $(3,2,1,4)$，只要交换 1 和 3 一次，是 $-1$；从别的位置出发都走不通。两条路加起来是 0，所以奇异。他接着发现第一行加第三行是全 1 的行，第二行加第四行也是，所以“行一减行二加行三减行四”是零行。

我按这些线索还原了一个满足所有描述的矩阵（我的版本可能没有他的那么有戏剧性）：

$$
A = \begin{bmatrix}
0 & 0 & 1 & 1 \\
0 & 1 & 1 & 0 \\
1 & 1 & 0 & 0 \\
1 & 0 & 0 & 1
\end{bmatrix}
$$

把 24 个排列都过一遍，看有哪些乘积不为零：

```python
import itertools

import numpy as np


def perm_sign(perm: tuple[int, ...]) -> int:
    inversions = sum(
        1
        for i in range(len(perm))
        for j in range(i + 1, len(perm))
        if perm[i] > perm[j]
    )
    return -1 if inversions % 2 else 1


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 字幕里没有写出矩阵，这是我按他的两条路径还原的 0-1 矩阵
    A = np.array(
        [
            [0, 0, 1, 1],
            [0, 1, 1, 0],
            [1, 1, 0, 0],
            [1, 0, 0, 1],
        ],
        dtype=float,
    )

    survivors = []
    for perm in itertools.permutations(range(4)):
        term = np.prod([A[row, col] for row, col in enumerate(perm)])
        if term != 0:
            survivors.append((tuple(c + 1 for c in perm), perm_sign(perm)))
    print("24 项里不为零的：", survivors)
    total = sum(sign for _, sign in survivors)
    print("它们的和：", total)
    print("np.linalg.det：", round(np.linalg.det(A), 10) + 0.0)

    # 奇异的另一个证据：行的组合给出零行，列的组合给出零向量
    print("行一 - 行二 + 行三 - 行四：", A[0] - A[1] + A[2] - A[3])
    print("列一 - 列二 + 列三 - 列四：", A[:, 0] - A[:, 1] + A[:, 2] - A[:, 3])
    print("秩：", np.linalg.matrix_rank(A))


if __name__ == "__main__":
    main()
```

```text
24 项里不为零的： [((3, 2, 1, 4), -1), ((4, 3, 2, 1), 1)]
它们的和： 0
np.linalg.det： 0.0
行一 - 行二 + 行三 - 行四： [0. 0. 0. 0.]
列一 - 列二 + 列三 - 列四： [0. 0. 0. 0.]
秩： 3
```

24 项里恰好两项不为零，列号 $(3,2,1,4)$ 带 $-1$，$(4,3,2,1)$ 带 $+1$，和他的说法一致。和为 0，`np.linalg.det` 也给出 0.0，秩是 3。行组合和列组合都能凑出零，所以零空间和左零空间各有一个非零向量。这就是“零多的矩阵可以直接用大公式”的好处：一眼看出来的结构，比消元更快。

## 代数余子式：把 $n$ 阶拆成 $n - 1$ 阶

**怎样把大公式拆开？** 还是从 3 × 3 开始。把含有 $a_{11}$ 的两项合并：

$$
a_{11}\left(a_{22}a_{33} - a_{23}a_{32}\right)
$$

括号里正好是划掉第 1 行第 1 列之后剩下的 2 × 2 矩阵的行列式。含 $a_{12}$ 的两项是 $-a_{12}(a_{21}a_{33} - a_{23}a_{31})$，括号里同样是划掉第 1 行第 2 列后的 2 × 2 行列式，但前面多了一个负号。含 $a_{13}$ 的是 $+a_{13}(a_{21}a_{32} - a_{22}a_{31})$。

Strang 把“划掉后剩下的子矩阵行列式”连同这个符号一起叫作 $a_{ij}$ 的代数余子式（cofactor）：

$$
C_{ij} = (-1)^{i + j} \det M_{ij}
$$

$M_{ij}$ 是划掉第 $i$ 行第 $j$ 列后的 $(n-1) \times (n-1)$ 矩阵。符号由 $i + j$ 的奇偶决定，是一张棋盘格，左上角是加号。不带符号的 $\det M_{ij}$ 叫余子式（minor），他说那个词他不在乎，直接把符号收进去叫代数余子式。沿第一行展开：

$$
\det A = a_{11}C_{11} + a_{12}C_{12} + \cdots + a_{1n}C_{1n}
$$

沿第 $i$ 行同理，只是把下标 1 换成 $i$。2 × 2 的例子最小：$a$ 的余子式是 $d$，$b$ 的余子式是 $c$，加上符号后是 $-c$，所以 $\det = a \cdot d + b \cdot (-c) = ad - bc$。

他还提到，既然余子式能把 $n$ 阶拆成 $n - 1$ 阶，再拆成 $n - 2$ 阶，一路拆到 1 × 1，那么整门行列式的课完全可以从这个公式开始讲，有人就是这么讲的。他选择先讲性质，原因我猜是性质更容易看出行列式“为什么”这样。

他接着把三种算法的位置交代清楚：主元的乘积把所有繁琐的东西已经折进了消元里，效率最高；大公式把所有繁琐的东西摊开写出来；余子式公式介于两者之间，“容易的东西乘以可怕的东西”，它的用处是把大行列式拆成小行列式。

下面是余子式展开的递归实现。`det_cofactor` 沿指定的一行展开，每次调用时全局的计数器加一，用来数递归调用次数；我还对 6 × 6 矩阵每一行都展开一次，确认结果相同，并和 `np.linalg.det` 对照：

```python
import numpy as np

calls = 0


def minor(A: np.ndarray, i: int, j: int) -> np.ndarray:
    """划掉第 i 行第 j 列。"""
    return np.delete(np.delete(A, i, axis=0), j, axis=1)


def cofactor(A: np.ndarray, i: int, j: int) -> float:
    """代数余子式 C_ij = (-1)^(i+j) det(M_ij)。"""
    return (-1) ** (i + j) * det_cofactor(minor(A, i, j))


def det_cofactor(A: np.ndarray, row: int = 0) -> float:
    """沿第 row 行做余子式展开。"""
    global calls
    calls += 1
    n = A.shape[0]
    if n == 1:
        return A[0, 0]
    return sum(A[row, j] * cofactor(A, row, j) for j in range(n))


def main() -> None:
    global calls
    np.set_printoptions(precision=4, suppress=True)

    # 符号是棋盘格
    signs = np.array([[(-1) ** (i + j) for j in range(5)] for i in range(5)])
    print(signs)

    # 2 x 2：a * d + b * (-c)
    B = np.array([[3.0, 5.0], [2.0, 7.0]])
    print("2 x 2：", det_cofactor(B), "，np.linalg.det：", np.linalg.det(B))

    # 沿任意一行展开，结果相同
    rng = np.random.default_rng(1806)
    A = rng.standard_normal((6, 6))
    for row in range(6):
        print(f"沿第 {row + 1} 行：{det_cofactor(A, row):.6f}")
    print(f"np.linalg.det：{np.linalg.det(A):.6f}")

    # 递归调用次数，对比 n!
    print("n    调用次数")
    for n in (3, 4, 5, 6, 7, 8):
        calls = 0
        det_cofactor(rng.standard_normal((n, n)))
        print(f"{n}    {calls}")


if __name__ == "__main__":
    main()
```

```text
[[ 1 -1  1 -1  1]
 [-1  1 -1  1 -1]
 [ 1 -1  1 -1  1]
 [-1  1 -1  1 -1]
 [ 1 -1  1 -1  1]]
2 x 2： 11.0 ，np.linalg.det： 11.000000000000002
沿第 1 行：-7.439860
沿第 2 行：-7.439860
沿第 3 行：-7.439860
沿第 4 行：-7.439860
沿第 5 行：-7.439860
沿第 6 行：-7.439860
np.linalg.det：-7.439860
n    调用次数
3    10
4    41
5    206
6    1237
7    8660
8    69281
```

棋盘格的符号和他说的一样（第二行从减号开始）。沿六行中任意一行展开都得到 $-7.439860$，与 `np.linalg.det` 一致，也与上一节用大公式算出的同一个矩阵的值一致。

代价是另一回事：3 阶调用 10 次，8 阶调用 69281 次。这个调用次数已经比 $8! = 40320$ 大了 1.7 倍，因为余子式展开除了叶子还有中间层。这是稠密矩阵的情形；到 20 阶，$20!$ 约 $2.4 \times 10^{18}$，而消元只需要大约 $20^3/3 \approx 2667$ 次乘法（见[第 4 讲](/posts/linear-algebra-04-lu-factorization/)）。所以在实际计算里算行列式用消元，大公式和余子式的价值在于它们给出了结构：零很多的时候可以一眼读出结论，符号规则也是后面逆矩阵公式的基础。

## 三对角矩阵：行列式每六阶重复一次

**零很多的时候，余子式能做出什么？** Strang 的最后一个例子是对角线和两条副对角线全是 1 的 $n$ 阶矩阵 $A_n$，4 阶是

$$
A_4 = \begin{bmatrix}
1 & 1 & 0 & 0 \\
1 & 1 & 1 & 0 \\
0 & 1 & 1 & 1 \\
0 & 0 & 1 & 1
\end{bmatrix}
$$

小的先算：$\det A_1 = 1$，$\det A_2 = 1 \cdot 1 - 1 \cdot 1 = 0$。$A_3$ 的大公式有六项，其中三项非零，$+1$、$-1$、$-1$，和是 $-1$；也可以先用第二行减第三行，再沿新的行展开，得到 $-1$。

到 $A_4$，沿第一行展开，只有两个非零元素。$a_{11} = 1$ 的余子式是 $A_3$ 的行列式，符号为正。$a_{12} = 1$ 在 $(1,2)$ 位置，符号为负，划掉第一行第二列后的 3 × 3 矩阵的第一列是 $(1, 0, 0)^{\mathsf{T}}$，对这一列再展开一次（转置规则允许按列展开），剩下的是 $A_2$，符号是正。所以 $\det A_4 = \det A_3 - \det A_2$。这个论证对任何 $n$ 都成立：

$$
\det A_n = \det A_{n-1} - \det A_{n-2}
$$

他说这些数你大概猜不到，然后一路往下算：1、0、$-1$、$-1$、0、1、1、……，到这里又开始重复，周期是 6（$A_5$ 是 0，$A_6$ 和 $A_7$ 都是 1）。所以 $\det A_{61} = \det A_1 = 1$（$61 = 6 \times 10 + 1$）。

我把递推写成循环，从 1 阶到 12 阶与 `np.linalg.det` 逐个对照，再算 61 阶：

```python
import numpy as np


def tridiagonal_ones(n: int) -> np.ndarray:
    """对角线与两条副对角线全是 1 的 n 阶矩阵。"""
    return np.eye(n) + np.eye(n, k=1) + np.eye(n, k=-1)


def det_recurrence(n: int) -> int:
    """D_n = D_{n-1} - D_{n-2}，D_0 = 1，D_1 = 1。"""
    prev, curr = 1, 1
    if n == 0:
        return prev
    for _ in range(n - 1):
        prev, curr = curr, curr - prev
    return curr


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    print(tridiagonal_ones(4))

    print("n   递推   np.linalg.det")
    for n in range(1, 13):
        D = round(np.linalg.det(tridiagonal_ones(n)))
        print(f"{n:<3d} {det_recurrence(n):>3d}    {D:>3d}")

    n = 61
    exact = det_recurrence(n)
    numeric = np.linalg.det(tridiagonal_ones(n))
    print(f"n = {n}：递推 = {exact}，np.linalg.det = {numeric:.6f}")


if __name__ == "__main__":
    main()
```

```text
[[1. 1. 0. 0.]
 [1. 1. 1. 0.]
 [0. 1. 1. 1.]
 [0. 0. 1. 1.]]
n   递推   np.linalg.det
1     1      1
2     0      0
3    -1     -1
4    -1     -1
5     0      0
6     1      1
7     1      1
8     0      0
9    -1     -1
10   -1     -1
11    0      0
12    1      1
n = 61：递推 = 1，np.linalg.det = 1.000000
```

12 阶以内每一阶的递推值和数值行列式都一致：1、0、$-1$、$-1$、0、1，然后 1、0、$-1$、$-1$、0、1。61 阶的 $61 \times 61$ 矩阵让 `np.linalg.det` 也给出 1.000000，和递推相同。注意 $A_2$ 的行列式是 0，说明直接消元的话第二个主元会出问题，需要换行；NumPy 内部是带行交换的 LU，所以不受影响。

这个例子我觉得挺漂亮的：一个看起来只能一阶一阶硬算的行列式，因为余子式的递推，变成了一个周期为 6 的数列。余子式在这里比消元好用，是因为矩阵的零恰好让每次展开只剩两项。

下一讲是行列式的最后一讲，他会用余子式给出逆矩阵的公式，再把 Cramer 法则和体积放进来：[Cramer 法则、逆矩阵与体积](/posts/linear-algebra-20-cramer-inverse-volume/)。
