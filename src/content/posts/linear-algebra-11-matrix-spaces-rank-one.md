---
title: "18.06 第 11 讲：矩阵空间、秩 1 矩阵与小世界图"
commentId: "post:linear-algebra-11-matrix-spaces-rank-one"
published: "2026-10-18 11:20:00 +08:00"
description: "MIT 18.06 第 11 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 验证了 3 × 3 矩阵空间里对称子空间与上三角子空间满足 6 + 6 = 3 + 9，又在 60 个人的圆环上加 6 条随机捷径，最远距离从 30 步降到 17 步。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 矩阵空间
  - 秩 1 矩阵
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 11
draft: false
comment: true
slug: linear-algebra-11-matrix-spaces-rank-one
---

“向量”不一定是一列数。Strang 这一讲把线性代数的词汇搬到矩阵和函数上：3 × 3 矩阵的全体是 9 维空间，对称矩阵是其中 6 维的子空间，上三角矩阵也是 6 维，两者的交集是 3 维的对角阵，两者的和是整个 9 维空间，所以 $6 + 6 = 3 + 9$。我用 NumPy 把这几个维数一个一个算了出来；最后五分钟他讲小世界图，我在一个 60 人的圆环上加了 6 条随机捷径，最远的两个人从相隔 30 步变成相隔 17 步。

> [!NOTE] 本讲速览
> 视频：[Lecture 11: Matrix spaces; rank 1; small world graphs](https://www.youtube.com/watch?v=2IdtqGM6KWU)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-11-matrix-spaces-rank-1-small-world-graphs/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §3.1 Vector Spaces and Subspaces；§1.4 Matrix Multiplication AB and CR（第 6 版目录里没有小世界图的独立小节，秩 1 矩阵“一列乘一行”对应 §1.4 的列乘行）
> 前置：[第 10 讲：四个基本子空间](/posts/linear-algebra-10-four-fundamental-subspaces/)
> 一句话：只要能做加法和数乘，矩阵和函数都是向量；任何秩 $r$ 的矩阵都是 $r$ 个秩 1 矩阵（一列乘一行）之和。

> [!TIP] 配合视频
> - 前半段在补第 10 讲末尾的矩阵空间：$S$、$U$、$S \cap U$、$S + U$ 的维数是这一讲最值得认真看的部分，尤其是他最后写出的 $\dim S + \dim U = \dim(S \cap U) + \dim(S + U)$。本篇第一节用代码把四个维数都算了一遍。
> - 微分方程那段只有几分钟，他自己说“五分钟的 18.03”。本篇第二节只做了数值检查，听他讲一遍就够。
> - “秩 1 矩阵是积木”这段要认真听：他在黑板上写出 $A = \mathbf{u}\mathbf{v}^\mathrm{T}$，这是后面特征值、SVD 反复出现的形状。
> - 分量之和为零的子空间那一段，他把四个基本子空间全过了一遍，是第 10 讲的练习，可以倍速。
> - 最后讲朋友关系图的五分钟，大半是在聊“你离 Clinton 有几步”，数学内容很少，可以快进；下一讲才开始真正用矩阵。

## 矩阵也是向量

先回到他在上一讲末尾留下的那个空间：$M$ 是所有 3 × 3 矩阵。它的“向量”是矩阵，只用到两种运算，矩阵加法和乘以一个数（他特意说，两个矩阵相乘不属于向量空间的图景）。这样的空间有基、有维数，和 $\mathbb{R}^9$ 几乎没有区别，只是九个数排成了方阵。

**$M$ 的维数是多少？** 他的做法是写出标准基：九个矩阵，每个只在一个位置上是 1，其余是 0。所以 $\dim M = 9$。

接下来是两个子空间：

- $S$：对称的 3 × 3 矩阵。两个对称矩阵之和还是对称的，所以是子空间（它们的乘积一般不对称，但这里不乘）。
- $U$：上三角的 3 × 3 矩阵。两个上三角矩阵之和还是上三角的。

他先问一个很细的问题：那九个标准基矩阵里，有几个落在 $S$ 里？只有三个，就是对角线上的三个。而落在 $U$ 里的有六个。所以对 $U$ 来说“大空间的基里恰好有一组子空间的基”是个巧合；对 $S$ 就不是：要得到 $S$ 的基，得重新想一遍。对称矩阵由对角线上的三个数和对角线上方的三个数决定，所以 $\dim S = 6$，基里除了三个对角位置，还要三个“关于对角线对称的一对 1”。

然后是子空间的两种组合：

- 交集 $S \cap U$：既对称又上三角，那只能是对角阵，维数 3。
- 并集：不是子空间（“就像在平面里取两条直线，然后就停了”），所以他不要并集，要和 $S + U$：取 $S$ 里任意一个矩阵加上 $U$ 里任意一个矩阵。对称加上三角能凑出所有 3 × 3 矩阵，所以 $S + U = M$，维数 9。

最后他指出，这四个数有一个很漂亮的关系：

$$
\dim S + \dim U = \dim(S \cap U) + \dim(S + U), \qquad 6 + 6 = 3 + 9
$$

下面的代码把九个位置拉成 9 维向量，用矩阵的秩去数这些维数。交集的维数我是这样求的：把 $S$ 的基和 $U$ 的基放在一起得到矩阵 $[B_S\ \ {-B_U}]$，它的零空间里的每个向量对应一个“既能写成 $S$ 的组合、又能写成 $U$ 的组合”的矩阵。

```python
import numpy as np


def unit(i: int, j: int) -> np.ndarray:
    """返回第 (i, j) 个位置为 1、其余为 0 的 3 x 3 矩阵。"""
    E = np.zeros((3, 3))
    E[i, j] = 1.0
    return E


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # M 的标准基：九个只有一个 1 的矩阵，拉成 9 维向量放进列
    std = [unit(i, j) for i in range(3) for j in range(3)]
    print("标准基里对称的有", sum(np.allclose(E, E.T) for E in std), "个")
    print(
        "标准基里上三角的有",
        sum(np.allclose(E, np.triu(E)) for E in std),
        "个",
    )

    # S 的一组基：三个对角位置，加三个“关于对角线对称的一对 1”
    sym = [unit(i, i) for i in range(3)]
    sym += [unit(i, j) + unit(j, i) for i in range(3) for j in range(i + 1, 3)]
    # U 的一组基：对角线及其上方的六个位置
    upper = [unit(i, j) for i in range(3) for j in range(i, 3)]

    Bs = np.column_stack([E.ravel() for E in sym])
    Bu = np.column_stack([E.ravel() for E in upper])
    dim_s = np.linalg.matrix_rank(Bs)
    dim_u = np.linalg.matrix_rank(Bu)
    dim_sum = np.linalg.matrix_rank(np.hstack([Bs, Bu]))

    # 交集：Bs @ a = Bu @ c 的解，对应 [Bs, -Bu] 的零空间
    K = np.hstack([Bs, -Bu])
    _, s, Vt = np.linalg.svd(K)
    null_vectors = Vt[np.sum(s > 1e-10) :]
    dim_cap = null_vectors.shape[0]
    print("dim S =", dim_s, "dim U =", dim_u)
    print("dim (S + U) =", dim_sum, "dim (S 交 U) =", dim_cap)
    print(
        f"{dim_s} + {dim_u} = {dim_cap} + {dim_sum}：",
        dim_s + dim_u == dim_cap + dim_sum,
    )

    # 交集里的矩阵应当都是对角阵
    in_both = [(Bs @ v[:6]).reshape(3, 3) for v in null_vectors]
    print(
        "交集中的矩阵都是对角阵：",
        all(np.allclose(E, np.diag(np.diag(E))) for E in in_both),
    )

    # 并集不是子空间：一个对称的加一个上三角的，两边都不属于
    P = np.array([[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 0.0]])
    T = np.array([[0.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]])
    C = P + T
    print("P + T =")
    print(C)
    print(
        "对称：", np.allclose(C, C.T), "，上三角：", np.allclose(C, np.triu(C))
    )


if __name__ == "__main__":
    main()
```

```text
标准基里对称的有 3 个
标准基里上三角的有 6 个
dim S = 6 dim U = 6
dim (S + U) = 9 dim (S 交 U) = 3
6 + 6 = 3 + 9： True
交集中的矩阵都是对角阵： True
P + T =
[[0. 1. 0.]
 [1. 0. 1.]
 [0. 0. 0.]]
对称： False ，上三角： False
```

第一行和第二行对应他数的三个和六个。六、六、三、九四个数，以及 $6 + 6 = 3 + 9$ 都对上了；从零空间里拿出来的交集矩阵全部是对角阵，也和他的结论一致。最后三行是并集不能成为子空间的原因：一个对称矩阵 `P` 加上一个上三角矩阵 `T`，得到的 `P + T` 既不对称也不是上三角，它不在 $S \cup U$ 里，但在 $S + U$ 里，所以我们才需要“和”而不是“并”。

（这个公式我猜是在刻意让人想起集合里的容斥原理，不过子空间的“并”不是子空间，所以只能用“和”。）

## 微分方程的解空间

他还给了另一个“向量不是一列数”的例子，用了大概五分钟：

$$
\frac{d^2 y}{dx^2} + y = 0
$$

这个方程的所有解构成一个向量空间：两个解相加还是解，解乘以常数还是解。他把它叫作微分方程的零空间。$y = \cos x$ 是一个解，$y = \sin x$ 是另一个，完全解是 $y = c_1 \cos x + c_2 \sin x$。所以 $\cos x$ 和 $\sin x$ 构成一组基，维数是 2，等于方程的阶数。

基不唯一：$e^{ix}$ 和 $e^{-ix}$ 也是一组基。他说线性微分方程这门课，本质上就是在找解空间的一组基。

我没有符号求解，只做了数值检查：用二阶中心差分近似 $y''$，看 $y'' + y$ 的最大绝对值。除了 $\cos$ 和 $\sin$，我还试了一个组合 $3\cos x - 2\sin x$，以及一个不是解的 $y = x$ 作对照。至于 $e^{ix}$ 与 $e^{-ix}$，由欧拉公式，它们在 $(\cos x, \sin x)$ 这组基下的坐标是 $(1, i)$ 和 $(1, -i)$，行列式不为零，所以是另一组基。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 微分方程 y'' + y = 0 的解空间：用 cos 与 sin 两个函数做基
    x = np.linspace(0.0, 2.0 * np.pi, 2001)
    h = x[1] - x[0]
    for name, y in [
        ("cos", np.cos(x)),
        ("sin", np.sin(x)),
        ("3 cos - 2 sin", 3 * np.cos(x) - 2 * np.sin(x)),
        ("x", x),
    ]:
        # 二阶中心差分近似 y''
        y_xx = (y[2:] - 2 * y[1:-1] + y[:-2]) / h**2
        residual = np.max(np.abs(y_xx + y[1:-1]))
        print(f"{name:14s} 的 max|y'' + y| = {residual:.1e}")

    # e^{ix} 和 e^{-ix} 在 (cos, sin) 坐标下是 (1, i) 和 (1, -i)
    E = np.array([[1.0, 1.0], [1.0j, -1.0j]])
    print("另一组基的行列式：", np.linalg.det(E))
    print("它们也线性无关，秩：", np.linalg.matrix_rank(E))


if __name__ == "__main__":
    main()
```

```text
cos            的 max|y'' + y| = 8.2e-07
sin            的 max|y'' + y| = 8.2e-07
3 cos - 2 sin  的 max|y'' + y| = 3.0e-06
x              的 max|y'' + y| = 6.3e+00
另一组基的行列式： -2j
它们也线性无关，秩： 2
```

三个解的残差只有 $10^{-6}$ 量级，那是差分近似本身的误差（步长约 $3 \times 10^{-3}$，截断误差正比于步长平方）；不是解的 $y = x$ 残差是 6.3，差了七个数量级。行列式 $-2i$ 不为零，说明 $(1, i)$ 与 $(1, -i)$ 线性无关，$\{e^{ix}, e^{-ix}\}$ 也是基。

## 秩 1 矩阵：一列乘一行

接下来他回到矩阵的秩，问一个很朴素的问题：秩 1 的 2 × 3 矩阵长什么样？他给第一行 $(1, 4, 5)$，让大家说第二行。答案是它的倍数，比如 $(2, 8, 10)$。这时行空间的基是第一行；列空间的维数也是 1（行秩等于列秩），所有列都是第一列的倍数。他随后写出：

$$
\begin{bmatrix} 1 & 4 & 5 \\ 2 & 8 & 10 \end{bmatrix}
= \begin{bmatrix} 1 \\ 2 \end{bmatrix}
\begin{bmatrix} 1 & 4 & 5 \end{bmatrix}
$$

**每个秩 1 矩阵都能写成** $A = \mathbf{u}\mathbf{v}^\mathrm{T}$：$\mathbf{u}$ 是一个列向量，$\mathbf{v}^\mathrm{T}$ 是一个行向量。$\mathbf{u}$ 张成列空间，$\mathbf{v}$ 张成行空间。（第 6 版教材把这个形状放在 §1.4 的“列乘行”里，所以我把它列在上面的教材行。）

他接着说，秩 1 矩阵是所有矩阵的积木：一个 5 × 17 的秩 4 矩阵可以拆成四个秩 1 矩阵之和。（我觉得拿乐高来比最合适，每块只有一个方向，拼够四块才能撑起一个四维的列空间。）

然后是他很快带过、但容易漏掉的一个问题：秩 4 的 5 × 17 矩阵构成子空间吗？不构成。两个秩 4 矩阵相加，秩可能变成 5。一般的规则是 $\operatorname{rank}(A + B) \le \operatorname{rank} A + \operatorname{rank} B$，但 5 × 17 矩阵的秩上限是 5，所以 4 + 4 的上界 8 根本用不上。秩 1 矩阵也一样：两个秩 1 矩阵相加，多半是秩 2。（他还补了一句：如果想让零矩阵属于这个集合，得说“秩不超过 4”，但这也救不了加法。）

我用固定种子随机生成了四个秩 1 矩阵 $\mathbf{u}_k\mathbf{v}_k^\mathrm{T}$，一个一个往上加，看秩怎么涨；再用 SVD（后面第 29 讲才细讲，这里只当作“把矩阵拆成秩 1 矩阵之和”的现成工具）把 `B` 拆回四项。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 他黑板上的秩 1 矩阵：第二行是第一行的两倍
    A = np.array([[1.0, 4.0, 5.0], [2.0, 8.0, 10.0]])
    u = np.array([[1.0], [2.0]])
    v = np.array([[1.0], [4.0], [5.0]])
    print("秩：", np.linalg.matrix_rank(A))
    print("u @ v.T =")
    print(u @ v.T)
    print("等于 A：", np.allclose(u @ v.T, A))

    # 用秩 1 矩阵搭出 5 x 17、秩为 4 的矩阵
    parts = [
        rng.standard_normal((5, 1)) @ rng.standard_normal((1, 17))
        for _ in range(4)
    ]
    B = sum(parts)
    print(
        "四个秩 1 矩阵的秩：", [int(np.linalg.matrix_rank(p)) for p in parts]
    )
    print(
        "累加到第 k 个之后的秩：",
        [int(np.linalg.matrix_rank(sum(parts[: k + 1]))) for k in range(4)],
    )
    print("B 的形状：", B.shape, "，秩：", np.linalg.matrix_rank(B))

    # 反过来：从 B 里拆出四个秩 1 矩阵（用 SVD，后面会细讲）
    U, s, Vt = np.linalg.svd(B)
    rebuilt = sum(s[k] * np.outer(U[:, k], Vt[k]) for k in range(4))
    print("SVD 拆出的四项加回来等于 B：", np.allclose(rebuilt, B))

    # 秩 4 的矩阵不构成子空间：两个秩 4 相加，秩可以到 5
    C = sum(
        rng.standard_normal((5, 1)) @ rng.standard_normal((1, 17))
        for _ in range(4)
    )
    print(
        "rank(B) =",
        np.linalg.matrix_rank(B),
        "，rank(C) =",
        np.linalg.matrix_rank(C),
    )
    print(
        "rank(B + C) =",
        np.linalg.matrix_rank(B + C),
        "，上界 4 + 4 = 8，但 5 x 17 最多 5",
    )
    # 两个秩 1 矩阵相加，同样不再是秩 1
    p, q = parts[0], parts[1]
    print("rank(p + q) =", np.linalg.matrix_rank(p + q))


if __name__ == "__main__":
    main()
```

```text
秩： 1
u @ v.T =
[[ 1.  4.  5.]
 [ 2.  8. 10.]]
等于 A： True
四个秩 1 矩阵的秩： [1, 1, 1, 1]
累加到第 k 个之后的秩： [1, 2, 3, 4]
B 的形状： (5, 17) ，秩： 4
SVD 拆出的四项加回来等于 B： True
rank(B) = 4 ，rank(C) = 4
rank(B + C) = 5 ，上界 4 + 4 = 8，但 5 x 17 最多 5
rank(p + q) = 2
```

前三行：`u @ v.T` 恰好还原出他黑板上的矩阵，秩为 1。累加的秩依次是 1、2、3、4：每加一块积木，秩涨 1，加到第四块就是 4。SVD 拆出的四项加回去也等于 `B`。然后是不构成子空间的证据：两个随机的秩 4 矩阵相加，秩是 5 而不是 4；两个秩 1 矩阵相加，秩是 2 而不是 1。

## 分量之和为零：一个具体的零空间

下面这个例子他拿来把前几讲的东西过一遍：$\mathbb{R}^4$ 里分量之和为零的向量，

$$
S = \{\mathbf{b} \in \mathbb{R}^4 : b_1 + b_2 + b_3 + b_4 = 0\}
$$

它是子空间：乘以 6，分量之和还是 $6 \times 0 = 0$；两个向量相加，分量之和还是 0。那它的维数和基呢？他先让大家猜，三，然后问：这是哪个矩阵的零空间？

答案是 $A = \begin{bmatrix} 1 & 1 & 1 & 1 \end{bmatrix}$，因为 $A\mathbf{b} = 0$ 就是 $b_1 + b_2 + b_3 + b_4 = 0$。这个矩阵的秩是 1，所以零空间的维数是 $n - r = 4 - 1 = 3$。特解的做法和第 7 讲一样：第一列是主列，后三列是自由列；每次给一个自由变量取 1，主变量就取 $-1$，让总和为零：

$$
\begin{bmatrix} -1 \\ 1 \\ 0 \\ 0 \end{bmatrix},\
\begin{bmatrix} -1 \\ 0 \\ 1 \\ 0 \end{bmatrix},\
\begin{bmatrix} -1 \\ 0 \\ 0 \\ 1 \end{bmatrix}
$$

这就是 $S$ 的一组基。（他说不是唯一的三个，但这三个是“特解”。）剩下三个子空间他也顺手说了：行空间是 $\mathbb{R}^4$ 里这一行的所有倍数，维数 1；列空间是 $\mathbb{R}^1$（因为 $m = 1$，列只有一个分量）整个，维数 1；左零空间是 $A^\mathrm{T}$ 的零空间，只有零向量，他特意花时间讲了零维空间的基是空集，空集里有 0 个向量。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # S = 分量之和为 0 的向量 = 全 1 行矩阵的零空间
    A = np.ones((1, 4))
    m, n = A.shape
    r = int(np.linalg.matrix_rank(A))
    print("m =", m, "，n =", n, "，r =", r)

    # 特解：每个自由变量取 1，主变量取 -1
    N = np.vstack([-np.ones((1, 3)), np.eye(3)])
    print("N =")
    print(N)
    print("A @ N =", A @ N)
    print("N 的秩（零空间的维数）：", np.linalg.matrix_rank(N))

    # 四个子空间的维数：行空间 r、零空间 n - r、列空间 r、左零空间 m - r
    dims = {"行空间": r, "零空间": n - r, "列空间": r, "左零空间": m - r}
    print(dims)
    print("行空间 + 零空间 = n：", dims["行空间"] + dims["零空间"] == n)
    print("列空间 + 左零空间 = m：", dims["列空间"] + dims["左零空间"] == m)


if __name__ == "__main__":
    main()
```

```text
m = 1 ，n = 4 ，r = 1
N =
[[-1. -1. -1.]
 [ 1.  0.  0.]
 [ 0.  1.  0.]
 [ 0.  0.  1.]]
A @ N = [[0. 0. 0.]]
N 的秩（零空间的维数）： 3
{'行空间': 1, '零空间': 3, '列空间': 1, '左零空间': 0}
行空间 + 零空间 = n： True
列空间 + 左零空间 = m： True
```

$A\mathbf{N} = 0$ 验证了三个特解都在 $S$ 里，$\mathbf{N}$ 的秩是 3，所以它们线性无关，正好是三维。四个维数是 1、3、1、0，行空间加零空间是 $1 + 3 = 4 = n$，列空间加左零空间是 $1 + 0 = 1 = m$，和上一讲的结论吻合。

## 小世界图：用邻接矩阵的幂数步数

最后五分钟，他开始介绍图：一个图是一些节点和连接节点的边。他在黑板上画了一个 5 个节点、6 条边的图，说有一个 5 × 6 的矩阵能说明这个图的一切，但把矩阵留到下一讲（关联矩阵，见 [第 12 讲：图、网络与关联矩阵](/posts/linear-algebra-12-graphs-and-incidence-matrices/)）。这一讲他只问一个问题：如果每个人是一个节点，朋友之间连一条边，两个人最少隔几步？他用自己和 Clinton 的距离做例子（两步），然后提到“六度分隔”这个说法，并说有几条捷径，所有距离就会大幅下降。

字幕里没有他给出具体的邻接矩阵，所以下面是我自己的实验。邻接矩阵 $A$ 的 $(i, j)$ 项是 1 当且仅当 $i$ 和 $j$ 是朋友。那么 $A^k$ 的 $(i, j)$ 项数的就是从 $i$ 到 $j$ 的长度恰为 $k$ 的路径条数，所以最小的、使 $A^k$ 的 $(i, j)$ 项非零的 $k$，就是 $i$ 到 $j$ 的距离。我取 60 个人围成一圈，每人只认识左右两个邻居，再随机加 6 条边，每次都用邻接矩阵的幂算全部 $60 \times 60$ 对距离，并和逐层搜索（BFS）的结果对照。（为了不让路径条数溢出，每一步把非零项压成 1。我没有给这 60 个人起名字，名字比代码还难想。）

```python
from collections import deque

import numpy as np


def ring(n: int) -> np.ndarray:
    """n 个人围成一圈，每人只认识左右两个邻居。"""
    A = np.zeros((n, n), dtype=int)
    for i in range(n):
        A[i, (i + 1) % n] = A[(i + 1) % n, i] = 1
    return A


def distances(A: np.ndarray) -> np.ndarray:
    """用邻接矩阵的幂求最短距离：A^k 的 (i, j) 项非零，说明有长 k 的路。"""
    n = A.shape[0]
    dist = np.full((n, n), -1)
    np.fill_diagonal(dist, 0)
    walks = np.eye(n, dtype=int)
    for k in range(1, n):
        walks = (walks @ A > 0).astype(int)
        dist[(walks > 0) & (dist < 0)] = k
        if (dist >= 0).all():
            break
    return dist


def bfs(A: np.ndarray, start: int) -> list[int]:
    """逐层搜索，当作对照。"""
    n = A.shape[0]
    d = [-1] * n
    d[start] = 0
    queue = deque([start])
    while queue:
        i = queue.popleft()
        for j in np.flatnonzero(A[i]):
            if d[j] < 0:
                d[j] = d[i] + 1
                queue.append(j)
    return d


def main() -> None:
    rng = np.random.default_rng(1806)
    n = 60
    A = ring(n)
    D = distances(A)
    print("圆环：最远距离", D.max(), "，平均距离", round(D.mean(), 2))

    # 加 6 条随机的“远距离朋友”
    B = A.copy()
    for _ in range(6):
        i, j = rng.choice(n, size=2, replace=False)
        B[i, j] = B[j, i] = 1
    E = distances(B)
    print("加 6 条捷径：最远距离", E.max(), "，平均距离", round(E.mean(), 2))
    print("平均距离缩小到原来的", round(E.mean() / D.mean(), 2), "倍")

    ok = all(np.array_equal(E[i], bfs(B, i)) for i in range(n))
    print("与逐层搜索一致：", ok)


if __name__ == "__main__":
    main()
```

```text
圆环：最远距离 30 ，平均距离 15.0
加 6 条捷径：最远距离 17 ，平均距离 7.17
平均距离缩小到原来的 0.48 倍
与逐层搜索一致： True
```

没有捷径时，圆环上最远的两个人隔 30 步，平均距离 15.0。加了至多 6 条随机边（相对原来的 60 条边只多 10%）之后，最远距离降到 17，平均距离降到 7.17，缩小到原来的 0.48 倍。矩阵的幂算出的距离和 BFS 逐行一致。这大概就是他说的“几条捷径让距离大幅下降”：边只多了十分之一，平均距离却少了一半多。

他说的 Clinton 笑话、“six degrees of separation”，我就不细讲了。我猜这个结论的关键是：随机捷径把圆环上本来很远的点直接接到了一起。真实的社交网络比这个模型复杂得多，我没有验证任何关于真实网络的说法。

下一讲他会用那个 5 × 6 矩阵说明图与线性代数的关系，我猜零空间和左零空间会在图上有很具体的含义。第 12 讲见：[18.06 第 12 讲：图、网络与关联矩阵](/posts/linear-algebra-12-graphs-and-incidence-matrices/)。
