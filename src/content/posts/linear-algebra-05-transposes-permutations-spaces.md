---
title: "18.06 第 5 讲：转置、置换与向量空间"
commentId: "post:linear-algebra-05-transposes-permutations-spaces"
published: "2026-10-18 09:20:00 +08:00"
description: "MIT 18.06 第 5 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 数出 4 × 4 置换矩阵共 24 个、手写了带换行的 PA = LU，又在 1e-20 的小主元上看到不换行的解误差是 1.0，换行之后降到 0.0。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 置换矩阵
  - 向量空间
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 5
draft: false
comment: true
slug: linear-algebra-05-transposes-permutations-spaces
---

这一讲前半段收尾第二章，后半段开始第三章，Strang 说那是“真正的线性代数”的开头：不再只盯着几个向量，而是盯着它们所有线性组合构成的空间。收尾的部分有个我没想到的数字：对 $\begin{bmatrix} 10^{-20} & 1 \\ 1 & 1 \end{bmatrix}$ 这样一个代数上毫无问题的矩阵，不换行消元得到的解 $(0, 1)$ 离真解 $(1, 1)$ 差 1.0，先换一次行，误差是 0.0。这就是他随口提到的“Matlab 嫌主元太小”的代价。

> [!NOTE] 本讲速览
> 视频：[Lecture 5: Transposes, permutations, spaces R^n](https://www.youtube.com/watch?v=JibVXBElKL0)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-5-transposes-permutations-spaces-r-n/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §2.4 Permutations and Transposes；§3.1 Vector Spaces and Subspaces
> 前置：[第 4 讲：分解成 A = LU](/posts/linear-algebra-04-lu-factorization/)
> 一句话：需要换行时 $PA = LU$；子空间就是对加法和数乘封闭、且必然含有零向量的向量集合，矩阵的列的所有组合就是一个子空间。

> [!TIP] 配合视频
> - 开头一大段是置换矩阵和转置的收尾，本篇前两节都算过了，倍速即可。他顺口提到 Matlab 会因为主元太小而换行的那几句，我在第三个代码块里做了实验，值得听一遍再看数字。
> - 从“开始讲第三章”往后要认真看：他为什么说“把原点挖掉就不是向量空间”，为什么第一象限不行，为什么不过原点的直线不行。这几个反例比定义本身更有用。
> - R² 的所有子空间（整个平面、过原点的直线、只有零向量）和 R³ 的类似列表，一边看一边自己默写一遍。
> - 最后几分钟他画列空间：两个列向量的所有组合填满一个过原点的平面。本篇最后一个代码块把这个平面的方程算出来了，看完视频再看。

## 置换：换行的记账

上一讲的 $A = LU$ 有一个隐含的前提：消元过程中主元位置上永远不是 0，不用换行。现实里主元可能是 0，这时从下面找一行不为零的换上来，继续。Strang 的做法是把所有换行集中记在一个矩阵 $P$ 里，于是 $A = LU$ 变成

$$
PA = LU
$$

$P$ 把 $A$ 的行先排成“好顺序”，之后消元就不会再遇到零主元，$L$ 和 $U$ 的形状照旧。他说对绝大多数矩阵 $P$ 就是单位矩阵，但总有那么一小撮需要它。对任意可逆的 $A$，这个分解都存在。

**置换矩阵是什么？** 把单位矩阵的行重新排一遍（包括“原样不动”）。$n \times n$ 的置换矩阵有 $n!$ 个，因为 $n$ 行有 $n!$ 种排法。他当场数了 4 × 4 的：24 个，5 × 5 的 120 个，说“把五阶的全列出来就没意思了”。我没有手写，用 `itertools.permutations` 生成再逐个检验：

```python
import itertools
import math

import numpy as np


def perm_matrix(order: tuple[int, ...]) -> np.ndarray:
    """按 order 重排单位矩阵的行。"""
    return np.eye(len(order))[list(order)]


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # n x n 置换矩阵的个数是 n!
    for n in range(1, 6):
        count = sum(1 for _ in itertools.permutations(range(n)))
        print(f"n = {n}：{count} 个，n! = {math.factorial(n)}")

    # 4 x 4 的 24 个置换矩阵：P^T P = 单位矩阵，所以 P^T 就是 P 的逆
    perms = [perm_matrix(p) for p in itertools.permutations(range(4))]
    identity = np.eye(4)
    print(
        "P^T P = 单位矩阵：",
        all(np.allclose(P.T @ P, identity) for P in perms),
    )
    print(
        "P^T 等于 inv(P)：",
        all(np.allclose(P.T, np.linalg.inv(P)) for P in perms),
    )

    # 两个置换矩阵相乘，结果还是置换矩阵：24 个里没有跑出去的
    keys = {tuple(P.flatten()) for P in perms}
    closed = all(
        tuple((P @ Q).flatten()) in keys for P in perms for Q in perms
    )
    print("任意两个相乘仍在这 24 个里：", closed)

    # 那个绕一圈的置换：1 到 2，2 到 3，3 到 4，4 到 1
    cycle = perm_matrix((1, 2, 3, 0))
    print(cycle)
    print(
        "连乘 4 次回到单位矩阵：",
        np.allclose(np.linalg.matrix_power(cycle, 4), identity),
    )


if __name__ == "__main__":
    main()
```

```text
n = 1：1 个，n! = 1
n = 2：2 个，n! = 2
n = 3：6 个，n! = 6
n = 4：24 个，n! = 24
n = 5：120 个，n! = 120
P^T P = 单位矩阵： True
P^T 等于 inv(P)： True
任意两个相乘仍在这 24 个里： True
[[0. 1. 0. 0.]
 [0. 0. 1. 0.]
 [0. 0. 0. 1.]
 [1. 0. 0. 0.]]
连乘 4 次回到单位矩阵： True
```

置换矩阵的逆就是它的转置：$P^\mathsf{T}P = I$，因为每一行的那个 1 恰好撞上转置之后同一位置的那个 1。24 个矩阵全部通过，而且 `P.T` 与 `np.linalg.inv(P)` 一致。两个置换矩阵相乘还是置换矩阵，24 个里没有一个跑到外面去，他说它们像“一个小群”，位于特殊矩阵的中心。绕一圈的那个置换（1 到 2，2 到 3，3 到 4，4 到 1，他口头举过这个例子）连乘四次回到单位矩阵。

他还指出满足 $Q^\mathsf{T}Q = I$ 的矩阵不止置换矩阵（旋转矩阵也是），这个话题后面第 17 讲会正式展开。

一个类比，只用这一次：置换矩阵就像洗牌。每一种洗法对应一个置换矩阵，洗完牌想复原，把洗牌的动作倒过来做一遍就行，而这个“倒过来”恰好就是转置，不需要求逆，不需要任何计算。这也是 $P^{-1} = P^\mathsf{T}$ 在数值计算里受欢迎的原因：它免费。

## 转置与对称

**转置怎么算？** 行变列，列变行。他在黑板上取了一个 3 × 2 的矩阵，两列分别是 $(1, 2, 4)$ 和 $(3, 3, 1)$，把它记作 $R$（rectangular 的 R）：

$$
R = \begin{bmatrix} 1 & 3 \\ 2 & 3 \\ 4 & 1 \end{bmatrix},\quad
R^\mathsf{T} = \begin{bmatrix} 1 & 2 & 4 \\ 3 & 3 & 1 \end{bmatrix}
$$

3 × 2 变成 2 × 3，“又矮又宽”。用符号写就是 $(A^\mathsf{T})_{ij} = A_{ji}$：行号和列号对调。

**对称矩阵是什么？** 转置后不变的矩阵，$A^\mathsf{T} = A$。比如对角线上随便填，对角线上方有个 1，下方对称的位置就必须也是 1。他说这类矩阵在应用里到处都是，原因是下面这个事实：$R$ 本身离对称很远（形状都不一样），但 $R^\mathsf{T}R$ 永远是对称的。

他的验证分两步。先用数字：算出来的 10、11、7 都在对称的位置上重复出现。（字幕里他算的那一排 10、11、7，在我这里是 $RR^\mathsf{T}$ 的第一行，$R^\mathsf{T}R$ 是 2 × 2 的 $\begin{bmatrix} 21 & 13 \\ 13 & 19 \end{bmatrix}$。两个都对称，他选的哪一个都不影响结论。）再用符号：转置要反序，

$$
(R^\mathsf{T}R)^\mathsf{T} = R^\mathsf{T}(R^\mathsf{T})^\mathsf{T} = R^\mathsf{T}R
$$

两行就证完了，和逆矩阵的 $(AB)^{-1} = B^{-1}A^{-1}$ 是同一种反序。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 他黑板上的 3 x 2 矩阵 R：两列分别是 (1, 2, 4) 和 (3, 3, 1)
    R = np.array([[1.0, 3.0], [2.0, 3.0], [4.0, 1.0]])
    print("R 的形状：", R.shape, "，R^T 的形状：", R.T.shape)
    print(R.T)

    # (R^T)[i, j] 就是 R[j, i]
    flipped = all(R.T[i, j] == R[j, i] for i in range(2) for j in range(3))
    print("行列下标对调：", flipped)

    # R^T R 与 R R^T 都是对称的
    print("R^T R =")
    print(R.T @ R)
    print("R R^T =")
    print(R @ R.T)
    print("两个都对称：", np.allclose(R.T @ R, (R.T @ R).T), end=" ")
    print(np.allclose(R @ R.T, (R @ R.T).T))

    # 随机的矩阵也一样：对称性是结构带来的，不是这组数字碰巧
    M = rng.standard_normal((7, 4))
    G = M.T @ M
    print("随机 7 x 4 的 M^T M 不对称程度：", np.abs(G - G.T).max())

    # 转置反序：(AB)^T = B^T A^T，而 A^T B^T 连形状都对不上
    A = rng.standard_normal((3, 2))
    B = rng.standard_normal((2, 5))
    print("(AB)^T = B^T A^T：", np.allclose((A @ B).T, B.T @ A.T))
    try:
        A.T @ B.T
    except ValueError:
        print("A^T B^T：形状 (2, 3) 乘 (5, 2)，乘不了")


if __name__ == "__main__":
    main()
```

```text
R 的形状： (3, 2) ，R^T 的形状： (2, 3)
[[1. 2. 4.]
 [3. 3. 1.]]
行列下标对调： True
R^T R =
[[21. 13.]
 [13. 19.]]
R R^T =
[[10. 11.  7.]
 [11. 13. 11.]
 [ 7. 11. 17.]]
两个都对称： True True
随机 7 x 4 的 M^T M 不对称程度： 0.0
(AB)^T = B^T A^T： True
A^T B^T：形状 (2, 3) 乘 (5, 2)，乘不了
```

$R^\mathsf{T}R$ 和 $RR^\mathsf{T}$ 都对称。随机 7 × 4 矩阵的 $M^\mathsf{T}M$ 与它自己的转置的最大差在这次运行里是 0.0，不是“近似为 0”，而是逐元素完全相等：$(M^\mathsf{T}M)_{ij}$ 与 $(M^\mathsf{T}M)_{ji}$ 是同样两列的点积。最后两行是转置反序：$(AB)^\mathsf{T} = B^\mathsf{T}A^\mathsf{T}$ 成立，而不反序的 $A^\mathsf{T}B^\mathsf{T}$ 连形状都对不上，NumPy 直接报错。

这个“$R^\mathsf{T}R$ 必定对称”的事实后面会反复出现：最小二乘的正规方程、协方差矩阵、奇异值分解，据我所知都是从这个乘积开始的。Strang 的原话大意是：实际应用里的对称矩阵，很多就是这样来的。我觉得这是这一讲前半段最值得记住的一句。

## 换行的另一面：主元太小

回到 $PA = LU$。先在一个第一个主元为 0 的矩阵上走一遍：

$$
A = \begin{bmatrix} 0 & 1 & 1 \\ 1 & 2 & 1 \\ 2 & 7 & 9 \end{bmatrix}
$$

下面的脚本手写了“能不换就不换，主元为零才换”的消元，同一个块里验证 $PA = LU$。

他在讲这一部分时顺嘴提了一句：Matlab 不光检查主元是不是 0，还检查主元是不是“够大”，因为接近 0 的主元在数值上很糟。代数上不需要这些换行，精度需要。我想看看“很糟”有多糟，就用 $\begin{bmatrix} 10^{-20} & 1 \\ 1 & 1 \end{bmatrix}\mathbf{x} = (1, 2)$ 试了一下：不换行，乘子是 $10^{20}$，$u_{22} = 1 - 10^{20}$ 在双精度里就是 $-10^{20}$，那个 1 被吃掉了；换行之后乘子是 $10^{-20}$，什么都没丢。

```python
import numpy as np


def lu_with_exchanges(
    A: np.ndarray, tol: float = 1e-12
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """消元：主元不为零就不换行，为零才向下找一行换上来。"""
    n = A.shape[0]
    U = A.astype(float).copy()
    L = np.zeros((n, n))
    P = np.eye(n)
    for k in range(n):
        if abs(U[k, k]) < tol:
            below = k + 1 + int(np.argmax(np.abs(U[k + 1 :, k])))
            for M in (U, L, P):
                M[[k, below]] = M[[below, k]]
        for i in range(k + 1, n):
            L[i, k] = U[i, k] / U[k, k]
            U[i] -= L[i, k] * U[k]
    return P, L + np.eye(n), U


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 第一个主元是 0：不换行就做不下去
    A = np.array([[0.0, 1.0, 1.0], [1.0, 2.0, 1.0], [2.0, 7.0, 9.0]])
    P, L, U = lu_with_exchanges(A)
    print("P =")
    print(P)
    print("L =")
    print(L)
    print("U =")
    print(U)
    print("P A = L U：", np.allclose(P @ A, L @ U))
    print("P^T P = 单位矩阵：", np.allclose(P.T @ P, np.eye(3)))

    # 他提到 Matlab 会嫌主元太小：1e-20 在代数上不是 0，在浮点里很糟
    B = np.array([[1e-20, 1.0], [1.0, 1.0]])
    b = np.array([1.0, 2.0])
    x_true = np.linalg.solve(B, b)  # LAPACK 内部做了选主元的换行

    # 不换行：乘子是 1e20，U[1, 1] = 1 - 1e20 在浮点里吃掉了 1
    m = B[1, 0] / B[0, 0]
    u22 = B[1, 1] - m * B[0, 1]
    y2 = b[1] - m * b[0]
    x2 = y2 / u22
    x1 = (b[0] - B[0, 1] * x2) / B[0, 0]
    x_naive = np.array([x1, x2])

    # 先换行再消元：乘子是 1e-20
    B_swap, b_swap = B[::-1], b[::-1]
    m = B_swap[1, 0] / B_swap[0, 0]
    u22 = B_swap[1, 1] - m * B_swap[0, 1]
    x2 = (b_swap[1] - m * b_swap[0]) / u22
    x1 = (b_swap[0] - B_swap[0, 1] * x2) / B_swap[0, 0]
    x_swap = np.array([x1, x2])

    print("不换行的解：", x_naive, "，误差", np.linalg.norm(x_naive - x_true))
    print("先换行的解：", x_swap, "，误差", np.linalg.norm(x_swap - x_true))
    print("参考解 x_true：", x_true)


if __name__ == "__main__":
    main()
```

```text
P =
[[0. 0. 1.]
 [0. 1. 0.]
 [1. 0. 0.]]
L =
[[ 1.      0.      0.    ]
 [ 0.5     1.      0.    ]
 [ 0.     -0.6667  1.    ]]
U =
[[ 2.      7.      9.    ]
 [ 0.     -1.5    -3.5   ]
 [ 0.      0.     -1.3333]]
P A = L U： True
P^T P = 单位矩阵： True
不换行的解： [0. 1.] ，误差 1.0
先换行的解： [1. 1.] ，误差 0.0
参考解 x_true： [1. 1.]
```

前半部分，$P$ 把第一行和第三行交换，$L$ 的乘子是 0.5 和 $-0.6667$，$PA = LU$ 与 $P^\mathsf{T}P = I$ 都为真。后半部分：不换行的解是 $(0, 1)$，误差 1.0，也就是误差和解本身一样大；先换行的解 $(1, 1)$，误差 0.0。据我所知 `np.linalg.solve` 背后的 LAPACK 用的就是带选主元换行的 LU，这解释了为什么实际计算里 $PA = LU$ 才是常态，不带 $P$ 的 $A = LU$ 只是把换行拿掉之后最干净的那个版本。（我只是想验证他随口一句话，结果搭进去了一个代码块。）

## 向量空间与子空间

**向量空间是什么？** 一批向量，但不是随便一批：必须能做向量该做的两件事，相加和数乘，并且结果仍留在这批向量里。他把这叫“对线性组合封闭”。教材列了八条运算规则，他说那些规则在 $\mathbb{R}^n$ 里肯定满足，真正需要检查的是封闭性。

最大的例子是 $\mathbb{R}^n$，所有有 $n$ 个实数分量的列向量。$\mathbb{R}^2$ 是 $xy$ 平面，$(3, 2)$、$(0, 0)$、$(\pi, e)$ 都在里面。注意 $(3, 2, 0)$ 在 $\mathbb{R}^3$ 而不在 $\mathbb{R}^2$，它有三个分量，哪怕一个是 0。

他用三个反例讲封闭性。第一个只需要一句话，后两个我变成了代码：

- 把 $xy$ 平面里的原点挖掉：不行。$(3, 2)$ 乘以 0 得到原点，$(3, 2) + (-3, -2)$ 也得到原点。每个向量空间都必须含有零向量。
- 只取第一象限（所有分量不小于 0）：加法没问题，$(3, 2) + (5, 6)$ 还在里面，但乘以 $-5$ 就掉出去了。不是向量空间，因为对数乘不封闭。
- $\mathbb{R}^2$ 里的直线：过原点的才是子空间，不过原点的那条，乘以 0 之后就离开了它。

**子空间是什么？** 向量空间里面的一个、自己也是向量空间的部分。$\mathbb{R}^2$ 的子空间只有三类：整个 $\mathbb{R}^2$，过原点的直线，以及只含零向量的 $\{\mathbf{0}\}$（他叫它 $Z$）。零向量自己够格：它加它还是它，乘以 17 也还是它。$\mathbb{R}^3$ 的子空间是四类：整个空间、过原点的平面、过原点的直线、零向量。（这条直线看起来很像 $\mathbb{R}^1$，但它的向量有两个分量，所以不一样，他特别强调了这一点。）

## 列空间：从矩阵里长出子空间

怎么从矩阵里得到子空间？取它的列。他用的矩阵还是那个 3 × 2 的

$$
A = \begin{bmatrix} 1 & 3 \\ 2 & 3 \\ 4 & 1 \end{bmatrix}
$$

两列是 $\mathbb{R}^3$ 里的向量。只把这两个向量放进去不够：能乘以数，所以 $(0, 0, 0)$ 要在；能相加，所以 $(4, 5, 5)$ 要在；一份第一列加三份第二列也要在。所以要把**所有**线性组合都放进去，这个子空间就叫列空间，记作 $C(A)$。他说这是这一讲的中心思想：有几个向量还不满足，我们要的是它们的组合构成的空间。

两个 $\mathbb{R}^3$ 里的向量，所有组合是什么？比一条线多，比整个空间少：一个过原点的平面。我用叉乘求出这个平面的法向量，然后检查封闭性：

```python
import numpy as np


def in_column_space(A: np.ndarray, v: np.ndarray) -> bool:
    x, *_ = np.linalg.lstsq(A, v, rcond=None)
    return bool(np.allclose(A @ x, v))


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 例一：第一象限（所有分量不小于 0）。加法封闭，数乘不封闭
    def in_quarter(v: np.ndarray) -> bool:
        return bool(np.all(v >= 0))

    u, w = np.array([3.0, 2.0]), np.array([5.0, 6.0])
    print("(3, 2) + (5, 6) 还在第一象限：", in_quarter(u + w))
    print("-5 * (3, 2) 还在第一象限：", in_quarter(-5 * u))

    # 例二：过原点的直线与不过原点的直线
    d = np.array([1.0, 2.0])

    def on_line(v: np.ndarray) -> bool:
        return bool(np.isclose(2 * v[0] - v[1], 0.0))

    def on_shifted(v: np.ndarray) -> bool:
        return bool(np.isclose(2 * v[0] - v[1], 1.0))

    t, s = rng.standard_normal(2)
    print("过原点的线：", on_line(t * d + s * d), on_line(0.0 * d))
    p = np.array([0.0, -1.0])  # 平移后的线上的一点
    print("平移的线：", on_shifted(p), "，乘 0 之后：", on_shifted(0.0 * p))

    # 例三：他的矩阵的列空间，R^3 里的一个平面
    A = np.array([[1.0, 3.0], [2.0, 3.0], [4.0, 1.0]])
    print("A 的秩：", np.linalg.matrix_rank(A))
    n = np.cross(A[:, 0], A[:, 1])  # 平面的法向量
    print("平面的法向量：", n)
    print("列一 + 列二 =", A[:, 0] + A[:, 1])
    print("列一 + 3 * 列二 =", A[:, 0] + 3 * A[:, 1])

    # 随机取 1000 对组合，检查加法和数乘是否出了平面
    worst = 0.0
    for _ in range(1000):
        a = A @ rng.standard_normal(2)
        b = A @ rng.standard_normal(2)
        c = rng.standard_normal() * 10
        worst = max(worst, abs(n @ (a + b)), abs(n @ (c * a)))
    print("1000 次加法和数乘后离平面的最大偏差：", f"{worst:.1e}")
    print("0 向量在列空间里：", in_column_space(A, np.zeros(3)))
    print(
        "(1, 0, 0) 在列空间里：", in_column_space(A, np.array([1.0, 0.0, 0.0]))
    )
    print(
        "(4, 5, 5) 在列空间里：", in_column_space(A, np.array([4.0, 5.0, 5.0]))
    )


if __name__ == "__main__":
    main()
```

```text
(3, 2) + (5, 6) 还在第一象限： True
-5 * (3, 2) 还在第一象限： False
过原点的线： True True
平移的线： True ，乘 0 之后： False
A 的秩： 2
平面的法向量： [-10.  11.  -3.]
列一 + 列二 = [4. 5. 5.]
列一 + 3 * 列二 = [10. 11.  7.]
1000 次加法和数乘后离平面的最大偏差： 5.7e-13
0 向量在列空间里： True
(1, 0, 0) 在列空间里： False
(4, 5, 5) 在列空间里： True
```

法向量是 $(-10, 11, -3)$，所以这个平面是 $-10x + 11y - 3z = 0$。他口头念了 $(4, 5, 5)$，它是两列之和；一份第一列加三份第二列是 $(10, 11, 7)$（他只说了“一份加三份”，数是我算的），两个都落在这个平面上。随机取 1000 对组合，相加、数乘之后离平面的最大偏差是 $5.7 \times 10^{-13}$，是舍入误差，没有一次出平面。零向量在，$(1, 0, 0)$ 不在，所以 $C(A)$ 不是整个 $\mathbb{R}^3$。

他还往 $\mathbb{R}^{10}$ 里推了一步：取五个十维向量，它们的组合不是 $\mathbb{R}^5$（向量有十个分量），而是十维空间里一块过原点的、大概五维的“平的东西”。要是五个向量恰好落在同一条直线上，那就只能得到一条线。这取决于列之间的关系，后面几讲会把它说清楚。

这和第 1 讲其实是同一件事。那一讲里我把第三列改成前两列之和，三列的组合就困在一个平面里，右端项 $(1, 0, 0)$ 够不着，距离是 0.4082。当时我把那个平面叫作“够得着的地方”，现在它有了正式的名字：列空间。同一幅图，换了一套更准确的词。

我觉得这一讲最好的地方，在于它把“解方程”换成了“找子空间”：$A\mathbf{x} = \mathbf{b}$ 有解，当且仅当 $\mathbf{b}$ 在 $C(A)$ 里。他在最后说，下一讲的第一件事就是用这套新语言重新看 $A\mathbf{x} = \mathbf{b}$，并且引入另一个子空间。下一讲继续：[18.06 第 6 讲：列空间与零空间](/posts/linear-algebra-06-column-space-and-nullspace/)。
