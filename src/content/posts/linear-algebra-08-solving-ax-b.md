---
title: "18.06 第 8 讲：解 Ax = b，行最简形 R"
commentId: "post:linear-algebra-08-solving-ax-b"
published: "2026-10-18 10:20:00 +08:00"
description: "MIT 18.06 第 8 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 手写 rref，解出 3 × 4 方程组的完全解 x_p + x_n，再用 1000 个随机右端项检验四种秩的情形，秩小于行数的两种情形有解的比例都是 0.000。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 完全解
  - 行最简形
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 8
draft: false
comment: true
slug: linear-algebra-08-solving-ax-b
---

Strang 这一讲把 $A\mathbf{x} = \mathbf{b}$ 彻底解完：先看有没有解，有的话再找一个特解，然后把零空间里的所有向量加上去。我用他上一讲的 3 × 4 矩阵验证，这样得到的所有 $\mathbf{x}$ 都满足方程；而 $A$ 乘以特解的 2 倍就不行，得到 $(2, 10, 12)$，不是 $\mathbf{b} = (1, 5, 6)$。接着我用 1000 个随机右端项数了一遍四种秩的情形：秩小于行数时，随机的 $\mathbf{b}$ 有解的比例是 0.000，秩等于行数时是 1.000。他在最后一句话里说，秩告诉你解的个数的一切。我的实验只量了其中“有没有解”这一半：数出来确实如此。

> [!NOTE] 本讲速览
> 视频：[Lecture 8: Solving Ax = b: row reduced form R](https://www.youtube.com/watch?v=9Q1q7s1jTzU)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-8-solving-ax-b-row-reduced-form-r/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §3.3 The Complete Solution to Ax = b
> 前置：[第 7 讲：解 Ax = 0，主变量与特解](/posts/linear-algebra-07-solving-ax-0/)
> 一句话：$A\mathbf{x} = \mathbf{b}$ 的完全解是一个特解 $\mathbf{x}_p$ 加上零空间里的任意向量 $\mathbf{x}_n$，有没有解、有几个解，只看秩 $r$ 与行数 $m$、列数 $n$ 的关系。

> [!TIP] 配合视频
> - 开头他用上一讲的矩阵讲“消元怎么发现无解”，我在第一节用代码重做了一遍，这一段可以倍速。
> - “解集不是子空间，它是一个被平移过的东西”那一段他在黑板上画四维空间，自己都说画得不行。听他说的话比看图重要。
> - 后半段的 $r = m$、$r = n$、$r = m = n$ 四个格子是本讲的主角，他边问边答，节奏很快，建议暂停下来自己先填一遍。
> - 他在中途写错过一次 $R$ 的形状又自己改了过来，这个小插曲值得看：它说明“$I$ 在左上角”这件事只在主列恰好排在前面时才成立。

## 先问：有没有解

他先不急着解，而是拿上一讲的矩阵

$$
A = \begin{bmatrix}
1 & 2 & 2 & 2 \\
2 & 4 & 6 & 8 \\
3 & 6 & 8 & 10
\end{bmatrix}
$$

问了一个问题：$A\mathbf{x} = \mathbf{b}$ 对哪些 $\mathbf{b}$ 有解？第三行等于前两行之和，所以三个方程左边加起来有一个现成的关系：第一行加第二行减第三行是零。如果左边的一个组合给出全零，右边的同一个组合也必须给出零，所以要有 $b_1 + b_2 = b_3$。他举的数是 $(1, 5, 17)$，不行；$(1, 5, 6)$ 可以。

**消元怎么发现这件事？** 把 $\mathbf{b}$ 当作多出来的一列，贴在 $A$ 右边，这就是增广矩阵。对增广矩阵做行运算，也就是对方程两边同时做同样的事。消元到最后一行，左边全零，右边剩下 $b_3 - b_2 - b_1$，方程变成 $0 = b_3 - b_2 - b_1$。这就是可解条件。

我没有用符号计算，而是在 $A$ 右边并排放了一个 $3 \times 3$ 的单位矩阵，让右边三列记录消元对 $\mathbf{b}$ 的三个分量做了什么：做完消元，右边那块就是 $E$，满足 $EA = R$。$E$ 的最后一行，就是“把行组合成零行”的那组系数。

下面的脚本里有一个手写的 `rref`，带容差，和上一篇的思路一样（每个代码块都要能单独运行，所以会重复贴一遍。贴三遍有点蠢，但我宁愿蠢一点，也不想让你去翻别的文件）：

```python
import numpy as np


def rref(M: np.ndarray, tol: float = 1e-10) -> tuple[np.ndarray, list[int]]:
    """化成行最简形，返回 R 和主列下标。"""
    R = M.astype(float).copy()
    rows, cols = R.shape
    pivots: list[int] = []
    r = 0
    for c in range(cols):
        if r == rows:
            break
        p = r + int(np.argmax(np.abs(R[r:, c])))
        if abs(R[p, c]) < tol:
            continue
        R[[r, p]] = R[[p, r]]
        R[r] /= R[r, c]
        for i in range(rows):
            if i != r:
                R[i] -= R[i, c] * R[r]
        pivots.append(c)
        r += 1
    return np.round(R, 10) + 0.0, pivots


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[1, 2, 2, 2], [2, 4, 6, 8], [3, 6, 8, 10]], dtype=float)

    # 在 A 右边并排放一个单位矩阵：消元对 b 做的事，都记在这三列里
    R, pivots = rref(np.hstack([A, np.eye(3)]))
    R_A, E = R[:, :4], R[:, 4:]
    print("R =")
    print(R_A)
    print("A 的主列：", [c for c in pivots if c < 4])
    print("E @ A 等于 R：", np.allclose(E @ A, R_A))

    # R 的零行对应的那一行 E，就是“行的组合给出零行”的系数
    y = E[2]
    print("y =", y, "，y @ A =", np.round(y @ A, 10) + 0.0)

    for b in ([1.0, 5.0, 6.0], [1.0, 5.0, 17.0]):
        b = np.array(b)
        print(f"b = {b}，y @ b = {y @ b:.1f}，可解：{np.isclose(y @ b, 0)}")


if __name__ == "__main__":
    main()
```

```text
R =
[[ 1.  2.  0. -2.]
 [ 0.  0.  1.  2.]
 [ 0.  0.  0.  0.]]
A 的主列： [0, 2]
E @ A 等于 R： True
y = [ 1.  1. -1.] ，y @ A = [0. 0. 0. 0.]
b = [1. 5. 6.]，y @ b = 0.0，可解：True
b = [ 1.  5. 17.]，y @ b = -11.0，可解：False
```

$R$ 的第三行是零行，主列是第 1 列和第 3 列，所以秩是 2。$E$ 的最后一行 $\mathbf{y} = (1, 1, -1)$ 满足 $\mathbf{y}^\top A = \mathbf{0}$，也就是他说的“某个行的组合给出零行”。同一个组合作用在 $\mathbf{b}$ 上，$\mathbf{y}^\top \mathbf{b} = b_1 + b_2 - b_3$：对 $(1, 5, 6)$ 是 0，有解；对 $(1, 5, 17)$ 是 $-11$，无解。和他在黑板上说的一致。

他把可解条件用了两种语言说出来。一种是列空间的语言：$\mathbf{b}$ 恰好在 $A$ 的列空间里时有解。另一种是行的语言：若行的某个组合给出零行，则 $\mathbf{b}$ 的同一个组合必须是零。他说这两句话等价并不显然，但它们都等价于“方程组有解”，所以必须等价。（这个论证偷了点懒：不证明，只指出两边都等于同一个东西。我猜后面讲四个基本子空间的时候会回到这里。）

## 特解加零空间

假设 $\mathbf{b} = (1, 5, 6)$，有解。怎么找？他的算法只有两步，第一步找一个特解 $\mathbf{x}_p$：

1. 把所有自由变量设为 0。
2. 解主变量。

对这个例子，自由列是第 2 列和第 4 列，所以 $x_2 = x_4 = 0$，方程只剩下主列：$x_1 + 2x_3 = 1$ 与 $2x_3 = 3$。回代得 $x_3 = \frac32$，$x_1 = 1 - 2 \cdot \frac32 = -2$，所以 $\mathbf{x}_p = (-2, 0, \frac32, 0)$。他特意说：做测验时请把它代回原方程验一下，这是好习惯。

第二步，加上零空间。上一讲的两个特解是 $(-2, 1, 0, 0)$ 和 $(2, 0, -2, 1)$。他在黑板上一开始没记清，凭方程当场推了一遍，最后确认：第二个特解里的 $2$、$-2$、$1$ 对得上。所以完全解是

$$
\mathbf{x} = \mathbf{x}_p + \mathbf{x}_n =
\begin{bmatrix} -2 \\ 0 \\ \frac32 \\ 0 \end{bmatrix} +
c_1 \begin{bmatrix} -2 \\ 1 \\ 0 \\ 0 \end{bmatrix} +
c_2 \begin{bmatrix} 2 \\ 0 \\ -2 \\ 1 \end{bmatrix}
$$

理由一句话就够：$A\mathbf{x}_p = \mathbf{b}$，$A\mathbf{x}_n = \mathbf{0}$，两个加起来 $A(\mathbf{x}_p + \mathbf{x}_n) = \mathbf{b} + \mathbf{0} = \mathbf{b}$。（零空间对 $A$ 来说像调音台上被静音的旋钮：怎么拧，输出都不变。）

**$\mathbf{x}_p$ 前面有没有系数 $c$？** 没有。$\mathbf{x}_p$ 是一个具体的解，我不能把它乘 3，因为 $A(3\mathbf{x}_p) = 3\mathbf{b} \ne \mathbf{b}$。零空间里的向量可以随便乘、随便加，因为它们总是给出 $\mathbf{0}$。

用代码把这几句话都过一遍。我在 $[A\ \mathbf{b}]$ 上做消元，最后一列 $\mathbf{d}$ 就是消元后的右端项，$\mathbf{x}_p$ 的主变量直接从 $\mathbf{d}$ 里读；特解矩阵 $N$ 的每一列由自由列 $F$ 取负填进去。然后随机抽几组 $c$ 看 $\mathbf{x}_p + N\mathbf{c}$ 是不是解，最后和 `np.linalg.lstsq` 对照：

```python
import numpy as np


def rref(M: np.ndarray, tol: float = 1e-10) -> tuple[np.ndarray, list[int]]:
    """化成行最简形，返回 R 和主列下标。"""
    R = M.astype(float).copy()
    rows, cols = R.shape
    pivots: list[int] = []
    r = 0
    for c in range(cols):
        if r == rows:
            break
        p = r + int(np.argmax(np.abs(R[r:, c])))
        if abs(R[p, c]) < tol:
            continue
        R[[r, p]] = R[[p, r]]
        R[r] /= R[r, c]
        for i in range(rows):
            if i != r:
                R[i] -= R[i, c] * R[r]
        pivots.append(c)
        r += 1
    return np.round(R, 10) + 0.0, pivots


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)
    A = np.array([[1, 2, 2, 2], [2, 4, 6, 8], [3, 6, 8, 10]], dtype=float)
    b = np.array([1.0, 5.0, 6.0])
    m, n = A.shape

    # 对 [A b] 做消元，最后一列就是消元后的右端项 d
    Rb, pivots = rref(np.hstack([A, b[:, None]]))
    pivots = [c for c in pivots if c < n]
    free = [c for c in range(n) if c not in pivots]
    d = Rb[:, n]
    print("[R d] =")
    print(Rb)
    print("主列：", pivots, "，自由列：", free)

    # 特解：自由变量取 0，主变量直接读 d
    x_p = np.zeros(n)
    x_p[pivots] = d[: len(pivots)]
    print("x_p =", x_p, "，A @ x_p = b：", np.allclose(A @ x_p, b))

    # 零空间：每个自由变量取 1，其余自由变量取 0，主变量取 -F 的对应列
    N = np.zeros((n, len(free)))
    for k, c in enumerate(free):
        N[c, k] = 1.0
        N[pivots, k] = -Rb[: len(pivots), c]
    N = N + 0.0
    print("N =")
    print(N)
    print("A @ N = 0：", np.allclose(A @ N, 0))

    # 完全解：x_p 加上任意的零空间向量
    for _ in range(3):
        c = rng.standard_normal(len(free))
        x = x_p + N @ c
        print("c =", c, "，A @ x = b：", np.allclose(A @ x, b))

    # 解集不是子空间：2 * x_p 不再是解
    print("A @ (2 * x_p) =", A @ (2 * x_p), "，不等于 b")

    # 对照：lstsq 给出所有解里范数最小的那一个
    x_min = np.linalg.lstsq(A, b, rcond=None)[0]
    print("lstsq 解 =", x_min, "，A @ x = b：", np.allclose(A @ x_min, b))
    print(f"|x_p| = {np.linalg.norm(x_p):.4f}")
    print(f"|x_min| = {np.linalg.norm(x_min):.4f}")


if __name__ == "__main__":
    main()
```

```text
[R d] =
[[ 1.   2.   0.  -2.  -2. ]
 [ 0.   0.   1.   2.   1.5]
 [ 0.   0.   0.   0.   0. ]]
主列： [0, 2] ，自由列： [1, 3]
x_p = [-2.   0.   1.5  0. ] ，A @ x_p = b： True
N =
[[-2.  2.]
 [ 1.  0.]
 [ 0. -2.]
 [ 0.  1.]]
A @ N = 0： True
c = [ 0.6679 -0.2323] ，A @ x = b： True
c = [-0.284  -0.5004] ，A @ x = b： True
c = [-0.0221 -1.0333] ，A @ x = b： True
A @ (2 * x_p) = [ 2. 10. 12.] ，不等于 b
lstsq 解 = [-0.1379 -0.2759  0.1897  0.6552] ，A @ x = b： True
|x_p| = 2.5000
|x_min| = 0.7486
```

$[R\ \mathbf{d}]$ 的第三行是 $0 = 0$，所以方程没问题；$\mathbf{d} = (-2, 1.5, 0)$ 的前两个数就是主变量 $x_1$、$x_3$ 的值，$\mathbf{x}_p = (-2, 0, 1.5, 0)$ 和黑板上一样。$N$ 的两列是 $(-2, 1, 0, 0)$ 和 $(2, 0, -2, 1)$，和他当场推的那两个一致，$AN = 0$ 通过。三组随机的 $c$ 全部给出解，而 $2\mathbf{x}_p$ 给出的是 $(2, 10, 12)$，不是 $\mathbf{b}$。

`lstsq` 也给了一个解，但它是另一个：$(-0.1379, -0.2759, 0.1897, 0.6552)$。它是所有解里长度最小的那个，$\|\mathbf{x}_{\min}\| = 0.7486$，比我手算的 $\mathbf{x}_p$ 的 $\|\mathbf{x}_p\| = 2.5000$ 短了约 3.3 倍。两者都在同一个“解的平面”上，只相差一个零空间里的向量。选自由变量为 0 只是“最方便”，不是“最短”；这个差别要到第 33 讲讲伪逆的时候才会派上用场。

**解集长什么样？** 他打算画出所有解的集合。四个未知数就是四维空间，黑板只有两维，他先说了一句 Einstein 能画，然后画了四条垂直的轴。结论比图好懂：零空间是 $\mathbb{R}^4$ 里的一个二维子空间（两个自由参数），完全解集是把它整体平移，平移到穿过 $\mathbf{x}_p$。它很像子空间，但不过原点（$\mathbf{x} = \mathbf{0}$ 不是解，因为 $A\mathbf{0} = \mathbf{0} \ne \mathbf{b}$），所以不是子空间。他说着说着把“它是个子空间”改口成“它像个子空间，只是被移开了原点”，我觉得这个改口比任何定义都清楚。

## 秩决定一切

后半讲他退一步，看一般情形：$m \times n$ 矩阵，秩为 $r$。他先问了 $r$ 与 $m$、$n$ 的关系：$r \le m$（每行至多一个主元），$r \le n$（每列至多一个主元）。然后问最有意思的情形：$r$ 取到上限，也就是满秩。

**满列秩 $r = n$。** 每列都有主元，没有自由变量，零空间只有零向量。如果有解，完全解就是 $\mathbf{x}_p$，没有第二项，所以解是唯一的；但不一定有解，因为行数多于列数，会出现零行，$\mathbf{b}$ 要满足条件。他的例子是又高又瘦的

$$
A = \begin{bmatrix} 1 & 3 \\ 2 & 1 \\ 6 & 1 \\ 5 & 1 \end{bmatrix}
$$

秩是 2，$R$ 是上面一个 $2 \times 2$ 的单位矩阵、下面两行零。四个方程两个未知数，随便取一个 $\mathbf{b}$ 大概率没解；但如果取成两列之和 $(4, 3, 7, 6)$，那解就是 $(1, 1)$，而且是唯一解。

**满行秩 $r = m$。** 每行都有主元，消元不会出零行，对 $\mathbf{b}$ 没有任何条件，所以任何 $\mathbf{b}$ 都有解。自由变量有 $n - r = n - m$ 个，所以有无穷多个解。例子他是把上面那个矩阵转置：

$$
A = \begin{bmatrix} 1 & 2 & 6 & 5 \\ 3 & 1 & 1 & 1 \end{bmatrix}
$$

秩 2，$R$ 是 $[I\ F]$ 的形状，$F$ 是自由列。他在这里卡了一下：主列不一定排在前面，所以 $I$ 和 $F$ 可能是交错的，不能总写成左边一块 $I$、右边一块 $F$。他发现自己写错了，当场改了过来，这一段比标准答案更有教益。

**满秩的方阵 $r = m = n$。** 这是第二章的情形：$R = I$，零空间只有零向量，对每个 $\mathbf{b}$ 恰有一个解，也就是可逆矩阵。他的例子是 $\begin{bmatrix} 1 & 2 \\ 3 & 1 \end{bmatrix}$。

**其余情形 $r < m$ 且 $r < n$。** $R$ 是 $\begin{bmatrix} I & F \\ 0 & 0 \end{bmatrix}$，有零行，所以 $\mathbf{b}$ 要满足条件才有解；有自由列，所以有解就有无穷多个。我们的 3 × 4 例子就属于这类。

他把四种情形写在黑板上的表，我整理成这样：

| 情形 | $R$ 的形状 | 零空间 | 解的个数 |
| --- | --- | --- | --- |
| $r = m = n$ | $I$ | 只有 $\mathbf{0}$ | 恰好 1 个 |
| $r = n < m$ | $\begin{bmatrix} I \\ 0 \end{bmatrix}$ | 只有 $\mathbf{0}$ | 0 个或 1 个 |
| $r = m < n$ | $\begin{bmatrix} I & F \end{bmatrix}$ | $n - r$ 维 | 无穷多个 |
| $r < m$ 且 $r < n$ | $\begin{bmatrix} I & F \\ 0 & 0 \end{bmatrix}$ | $n - r$ 维 | 0 个或无穷多个 |

四个矩阵都交给 NumPy。对每个矩阵，我抽 1000 个随机的 $\mathbf{b}$，数有多少个在列空间里（判据是：把 $\mathbf{b}$ 并到 $A$ 右边之后秩不变）：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)
    cases = {
        "r = m = n（方阵，可逆）": np.array([[1.0, 2.0], [3.0, 1.0]]),
        "r = n < m（又高又瘦）": np.array(
            [[1.0, 3.0], [2.0, 1.0], [6.0, 1.0], [5.0, 1.0]]
        ),
        "r = m < n（又矮又胖）": np.array(
            [[1.0, 2.0, 6.0, 5.0], [3.0, 1.0, 1.0, 1.0]]
        ),
        "r < m 且 r < n": np.array(
            [[1.0, 2.0, 2.0, 2.0], [2.0, 4.0, 6.0, 8.0], [3.0, 6.0, 8.0, 10.0]]
        ),
    }

    trials = 1000
    for name, A in cases.items():
        m, n = A.shape
        r = np.linalg.matrix_rank(A)
        solvable = 0
        for _ in range(trials):
            b = rng.standard_normal(m)
            # b 在列空间里，等价于加上 b 之后秩不变
            aug = np.hstack([A, b[:, None]])
            solvable += np.linalg.matrix_rank(aug) == r
        print(f"{name}：m = {m}，n = {n}，r = {r}，自由变量 {n - r} 个")
        print(f"  随机 b 有解的比例：{solvable / trials:.3f}")

    # 高瘦矩阵：挑一个在列空间里的 b，解唯一
    A = cases["r = n < m（又高又瘦）"]
    b = A[:, 0] + A[:, 1]
    x = np.linalg.lstsq(A, b, rcond=None)[0]
    print("b =", b, "，解 x =", x, "，A @ x = b：", np.allclose(A @ x, b))


if __name__ == "__main__":
    main()
```

```text
r = m = n（方阵，可逆）：m = 2，n = 2，r = 2，自由变量 0 个
  随机 b 有解的比例：1.000
r = n < m（又高又瘦）：m = 4，n = 2，r = 2，自由变量 0 个
  随机 b 有解的比例：0.000
r = m < n（又矮又胖）：m = 2，n = 4，r = 2，自由变量 2 个
  随机 b 有解的比例：1.000
r < m 且 r < n：m = 3，n = 4，r = 2，自由变量 2 个
  随机 b 有解的比例：0.000
b = [4. 3. 7. 6.] ，解 x = [1. 1.] ，A @ x = b： True
```

表里的“0 个或 1 个”“0 个或无穷多个”，在这里变成了两个干净的数字。$r = m$ 的两行（方阵、又矮又胖），随机 $\mathbf{b}$ 有解的比例是 1.000；$r < m$ 的两行（又高又瘦、$r < m$ 且 $r < n$），比例是 0.000。1000 次一次都没有撞上，这并不奇怪：列空间是 $\mathbb{R}^m$ 里的一个真子空间（4 维空间里的一个平面，或 3 维空间里的一个平面），随机向量落在上面的概率是 0。要想有解，$\mathbf{b}$ 必须由我挑，就像最后一行里的 $\mathbf{b} = (4, 3, 7, 6)$，解 $(1, 1)$ 唯一。

再看自由变量的个数：$r = n$ 的两行是 0 个，$r < n$ 的两行都是 2 个。把“有解吗”（看 $r$ 和 $m$）与“解几个”（看 $r$ 和 $n$）合在一起，就是他在最后一句话里说的：秩告诉你关于解的个数的全部信息，唯一不知道的是解的具体数值，那要回到矩阵本身去算。

这一讲他说“二维子空间”“两个独立的自由常数”的时候，其实已经在用“维数”这个还没定义的词了，他自己也说下次再讲。下一讲就把“线性无关”“基”“维数”补上，见 [18.06 第 9 讲：线性无关、基与维数](/posts/linear-algebra-09-independence-basis-dimension/)。
