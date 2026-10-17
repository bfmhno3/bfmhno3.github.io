---
title: "18.06 第 14 讲：正交向量与正交子空间"
commentId: "post:linear-algebra-14-orthogonal-subspaces"
published: "2026-10-18 12:20:00 +08:00"
description: "MIT 18.06 第 14 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 在一个随机的 4 × 6、秩 3 的矩阵上检查行空间与零空间正交，两组基的点积最大只有 1.0e-16，又在 1000 个随机矩阵上验证了 AᵀA 与 A 的秩始终相同。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 正交
  - 正交补
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 14
draft: false
comment: true
slug: linear-algebra-14-orthogonal-subspaces
---

这一讲开了新的一章，Strang 管它叫“九十度的一章”。核心想法只有一句：行空间和零空间互相垂直，而且维数加起来正好是 $n$。我在一个随机的 4 × 6 秩 3 矩阵上量了一下，行空间的基和零空间的基两两做点积，最大的绝对值是 $1.0 \times 10^{-16}$，也就是舍入误差；同一个矩阵上，3 维的行空间加 3 维的零空间拼起来，秩正好是 6，一点缝都没有。

> [!NOTE] 本讲速览
> 视频：[Lecture 14: Orthogonal vectors and subspaces](https://www.youtube.com/watch?v=YzZUIYRCE38)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-14-orthogonal-vectors-and-subspaces/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §4.1 Orthogonality of Vectors and Subspaces
> 前置：[第 13 讲：第一次测验复习](/posts/linear-algebra-13-quiz-1-review/)
> 一句话：两个向量正交就是 $\mathbf{x}^\mathsf{T}\mathbf{y} = 0$；行空间与零空间是 $\mathbb{R}^n$ 里的正交补；$A^\mathsf{T}A$ 可逆当且仅当 $A$ 的列线性无关。

> [!TIP] 配合视频
> - 开头他指着“四个子空间”的大图说，这一章要证明图里两对子空间之间是九十度。这一段要听，后面全是在兑现它。
> - 用勾股定理推出 $\mathbf{x}^\mathsf{T}\mathbf{y} = 0$ 的那段很短，本篇第一节已经算过，倍速即可。
> - 他拿黑板和地板当例子问“这两个子空间正交吗”，然后投票，再讲为什么不行。这是本讲最有画面感的地方，值得完整看一遍。
> - 讲完 $A\mathbf{x} = \mathbf{0}$ 推出行空间与零空间正交之后，他用一整段铺垫“没有解的方程组怎么办”和 $A^\mathsf{T}A$，这是下一讲的预告。结尾处 $A^\mathsf{T}A$ 的两个小例子要看，本篇最后一节会逐个重算。

## 两个向量什么时候正交

**怎么判断两个向量垂直？** Strang 的答案是：算点积 $\mathbf{x}^\mathsf{T}\mathbf{y}$，等于零就垂直。他先不直接宣布，而是从勾股定理出发。直角三角形的两条直角边是 $\mathbf{x}$ 和 $\mathbf{y}$，斜边是 $\mathbf{x} + \mathbf{y}$，毕达哥拉斯说

$$
\mathbf{x}^\mathsf{T}\mathbf{x} + \mathbf{y}^\mathsf{T}\mathbf{y} = (\mathbf{x} + \mathbf{y})^\mathsf{T}(\mathbf{x} + \mathbf{y}).
$$

右边展开，得到 $\mathbf{x}^\mathsf{T}\mathbf{x} + \mathbf{x}^\mathsf{T}\mathbf{y} + \mathbf{y}^\mathsf{T}\mathbf{x} + \mathbf{y}^\mathsf{T}\mathbf{y}$。实向量的 $\mathbf{x}^\mathsf{T}\mathbf{y}$ 和 $\mathbf{y}^\mathsf{T}\mathbf{x}$ 相等，两边相同的项消掉，剩下 $2\,\mathbf{x}^\mathsf{T}\mathbf{y} = 0$。所以勾股定理成立，当且仅当点积为零。他还特意强调：这个等式不是永远成立，它恰好等价于直角。

他给的数值例子是 $\mathbf{x} = (1, 2, 3)$，再“凑”一个垂直的 $\mathbf{y} = (2, -1, 0)$：$\mathbf{x}$ 的长度平方是 $1 + 4 + 9 = 14$，$\mathbf{y}$ 的是 5，$\mathbf{x} + \mathbf{y} = (3, 1, 3)$ 的是 $9 + 1 + 9 = 19$，$14 + 5 = 19$。（字幕里他口头说成“长度是 14”，指的是长度平方，这是口误。）我加了一个随手取的 $\mathbf{z} = (1, 1, 1)$ 做反例：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    x = np.array([1.0, 2.0, 3.0])
    y = np.array([2.0, -1.0, 0.0])  # 黑板上凑出来的，和 x 垂直
    z = np.array([1.0, 1.0, 1.0])  # 随手取的，大概率不垂直

    for name, v in [("y", y), ("z", z)]:
        lhs = x @ x + v @ v
        rhs = (x + v) @ (x + v)
        cross = x @ v
        angle = np.degrees(
            np.arccos(cross / np.linalg.norm(x) / np.linalg.norm(v))
        )
        print(f"{name}：x^T {name} = {cross}，夹角 = {angle:.2f} 度")
        print(f"  |x|^2 + |{name}|^2 = {lhs}，|x + {name}|^2 = {rhs}")

    # 零向量和任何向量都正交
    print("0^T x =", np.zeros(3) @ x)


if __name__ == "__main__":
    main()
```

```text
y：x^T y = 0.0，夹角 = 90.00 度
  |x|^2 + |y|^2 = 19.0，|x + y|^2 = 19.0
z：x^T z = 6.0，夹角 = 22.21 度
  |x|^2 + |z|^2 = 17.0，|x + z|^2 = 29.0
0^T x = 0.0
```

对 $\mathbf{y}$，两边都是 19，夹角 90.00 度；对 $\mathbf{z}$，点积是 6，勾股定理两边差了 $29 - 17 = 12$，正好是 $2\,\mathbf{x}^\mathsf{T}\mathbf{z} = 12$，夹角只有 22.21 度。“差多少”恰好由点积决定，这比“等不等”多说了一点东西，我觉得值得记住：以后把点积看成“距直角还差多少”会很顺手。

最后一行是他随口带过的一句：零向量和任何向量都正交，因为 $\mathbf{0}^\mathsf{T}\mathbf{y}$ 永远是零。他说“数学里要遵守规则”。这句看着没用，下一节讨论“直线和零子空间”时就要用到。

## 两个子空间什么时候正交

**子空间之间的正交怎么定义？** 他说：子空间 $S$ 与 $T$ 正交，指的是 $S$ 里的每一个向量都和 $T$ 里的每一个向量正交。“每一个”对“每一个”，所以条件比看起来强得多。

他用教室来演示：黑板是一个穿过原点的平面（比如 $xz$ 平面），地板是另一个（$xy$ 平面），两个都是 $\mathbb{R}^3$ 的二维子空间。它们正交吗？直觉上墙和地板成直角，他让大家举手投票，然后给出答案：不正交。理由有两层。一层是黑板上取一个四十五度的向量，地板上取一个不垂直的向量，点积就不为零。更彻底的一层是：这两个平面相交在墙角那条线上，这条线上的向量既在黑板里又在地板里，它得和自己正交，而一个非零向量和自己的点积是长度平方，不是零。所以两个正交子空间一定只在零向量处相交。

我把这个例子照搬进代码。子空间用基向量（作为列）表示，判断正交只需要看两组基两两的点积，因为任何向量都是基向量的组合，点积对组合是线性的：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 黑板是 xz 平面，地板是 xy 平面，各用两个基向量表示（作为列）
    board = np.array([[1.0, 0.0], [0.0, 0.0], [0.0, 1.0]])
    floor = np.array([[1.0, 0.0], [0.0, 1.0], [0.0, 0.0]])

    # 两组基两两做点积：全部为 0 才说明两个子空间正交
    print("黑板基 ^T 地板基：")
    print(board.T @ floor)

    # 黑板上的 45 度向量与地板上的向量
    u = board @ np.array([1.0, 1.0])
    v = floor @ np.array([1.0, 0.0])
    print("u =", u, "v =", v, "u^T v =", u @ v)

    # 两个平面的交线：黑板和地板同时包含 (1, 0, 0)
    crack = np.array([1.0, 0.0, 0.0])
    in_board = np.linalg.matrix_rank(np.column_stack([board, crack])) == 2
    in_floor = np.linalg.matrix_rank(np.column_stack([floor, crack])) == 2
    print("交线向量同时在两个平面里：", in_board and in_floor)
    print("它和自己的点积：", crack @ crack)

    # 平面里的两条直线：只在 0 相交，且互相垂直，才是正交子空间
    line1 = np.array([1.0, 1.0])
    line2 = np.array([1.0, -1.0])
    print("两条直线的方向点积：", line1 @ line2)


if __name__ == "__main__":
    main()
```

```text
黑板基 ^T 地板基：
[[1. 0.]
 [0. 0.]]
u = [1. 0. 1.] v = [1. 0. 0.] u^T v = 1.0
交线向量同时在两个平面里： True
它和自己的点积： 1.0
两条直线的方向点积： 0.0
```

基向量两两点积的矩阵里，左上角那个 1 就是罪魁祸首：黑板的第一个基向量和地板的第一个基向量都是 $(1, 0, 0)$，也就是墙角那条线。只要这个矩阵里有一个非零元素，两个子空间就不正交。黑板上的 $(1, 0, 1)$ 和地板上的 $(1, 0, 0)$ 点积是 1，不垂直，也和字幕说的一致。

他接着在平面 $\mathbb{R}^2$ 里把所有情况穷举了一遍，因为这里的子空间只有三种：零向量、过原点的直线、整个平面。过原点的直线和零子空间永远正交（零向量和谁都正交）；直线和整个平面永远不正交（平面里就有那条直线本身）；两条不同的直线，只有成直角时才正交，最后一行 $(1, 1)$ 和 $(1, -1)$ 的点积是 0 就是一个例子。

## 行空间与零空间正交

前面都是铺垫，这一节才是整讲的核心。Strang 说，大图里的这一对：行空间和零空间，是正交的。证明他只用了一句话：零空间里的 $\mathbf{x}$ 满足 $A\mathbf{x} = \mathbf{0}$，把 $A$ 按行写出来，

$$
\begin{bmatrix} \text{行 } 1 \\ \text{行 } 2 \\ \vdots \\ \text{行 } m \end{bmatrix}
\mathbf{x} =
\begin{bmatrix} 0 \\ 0 \\ \vdots \\ 0 \end{bmatrix}.
$$

每一行和 $\mathbf{x}$ 的点积都是零，所以 $\mathbf{x}$ 和每一行正交。（我喜欢这个证明，因为它是“方程本身就是答案”：$A\mathbf{x} = \mathbf{0}$ 的定义和正交的定义根本是一句话的两种写法。）

不过他随即提醒自己：行空间不只有那几行，还有它们的所有组合。所以还要补一步：$\mathbf{x}$ 与每一行垂直，就与 $c_1(\text{行 }1) + c_2(\text{行 }2) + \cdots$ 垂直，因为零乘常数、零加零还是零。这就是“线性”在起作用。左零空间和列空间那一对，他说不用再证了，把上面的话里 $A$ 换成 $A^\mathsf{T}$ 就行。

然后他问了一个很有用的问题：能不能有两条互相垂直的直线，一条是行空间，一条是零空间，都在 $\mathbb{R}^3$ 里？不行，因为 $r + (n - r) = n$，$1 + 1 \ne 3$。他的例子是

$$
A = \begin{bmatrix} 1 & 2 & 5 \\ 2 & 4 & 10 \end{bmatrix},
$$

两行成比例，行空间是过 $(1, 2, 5)$ 的一条线，维数 1；零空间是一个平面，维数 2，而且就是以 $(1, 2, 5)$ 为法向量的那个平面，“你在微积分里学过的那个叫 N 的法向量，原来就是它”。第二行没起任何作用，去掉后方程是 $x_1 + 2x_2 + 5x_3 = 0$，一个方程三个未知数，一个平面，不奇怪。

光说“正交”还不够。“正交补”要求更多：零空间不只是有一些和行空间垂直的向量，而是包含了**所有**和行空间垂直的向量。线加平面，$1 + 2 = 3$，刚好填满。换成两条互相垂直的线，虽然也正交，但它们不是正交补，空间里还留着一条空缺。下面我用 SVD 求出行空间与零空间的标准正交基（SVD 要到第 29 讲才讲，这里先当作“能给出两组正交基的黑箱”用），先复现他的例子，再在一个随机矩阵上检查：

```python
import numpy as np


def row_and_null_bases(
    A: np.ndarray, tol: float = 1e-10
) -> tuple[np.ndarray, np.ndarray]:
    """用 SVD 求行空间与零空间的标准正交基，各自作为列返回。"""
    _, s, Vt = np.linalg.svd(A)
    r = int(np.sum(s > tol))
    return Vt[:r].T, Vt[r:].T


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # Strang 的例子：两行成比例，行空间是一条线，零空间是一个平面
    A = np.array([[1.0, 2.0, 5.0], [2.0, 4.0, 10.0]])
    Rb, Nb = row_and_null_bases(A)
    print("维数 r =", Rb.shape[1], "，n - r =", Nb.shape[1])
    normal = np.array([1.0, 2.0, 5.0])
    print("零空间基 ^T (1, 2, 5) =", Nb.T @ normal)
    print("A @ 零空间基 = 0：", np.allclose(A @ Nb, 0))

    # 随机的 4 x 6 矩阵，秩为 3：行空间 3 维，零空间 3 维
    rng = np.random.default_rng(1806)
    B = rng.standard_normal((4, 3)) @ rng.standard_normal((3, 6))
    Rb, Nb = row_and_null_bases(B)
    r, nullity = Rb.shape[1], Nb.shape[1]
    print("B 的秩 =", np.linalg.matrix_rank(B), "，r + (n - r) =", r + nullity)
    cross = Rb.T @ Nb
    print(f"行空间基 ^T 零空间基 的最大绝对值：{np.abs(cross).max():.1e}")

    # 行空间里的任意组合也和零空间垂直（行的组合 = B^T @ c）
    c = rng.standard_normal(4)
    combo = B.T @ c
    print(f"行的组合和零空间的点积：{np.abs(combo @ Nb).max():.1e}")

    # 互补：两组基拼在一起正好是 R^6 的一组基
    full = np.column_stack([Rb, Nb])
    print("拼起来的秩 =", np.linalg.matrix_rank(full), "，满秩 6")


if __name__ == "__main__":
    main()
```

```text
维数 r = 1 ，n - r = 2
零空间基 ^T (1, 2, 5) = [0. 0.]
A @ 零空间基 = 0： True
B 的秩 = 3 ，r + (n - r) = 6
行空间基 ^T 零空间基 的最大绝对值：1.0e-16
行的组合和零空间的点积：4.9e-15
拼起来的秩 = 6 ，满秩 6
```

前三行是他的例子：行空间 1 维，零空间 2 维，零空间的两个基向量和法向量 $(1, 2, 5)$ 的点积都是 0，且 $A$ 乘零空间基是零矩阵。后四行是随机的 $B = (4 \times 3)(3 \times 6)$，秩为 3：行空间基和零空间基两两的点积最大是 $1.0 \times 10^{-16}$，随机取的行的组合（$B^\mathsf{T}\mathbf{c}$）与零空间的点积最大是 $4.9 \times 10^{-15}$，都在双精度的舍入范围内。

最后一行才是“补”的含义：把 3 个行空间基向量和 3 个零空间基向量拼成 $6 \times 6$ 的矩阵，秩是 6，也就是说它们合起来是 $\mathbb{R}^6$ 的一组基。如果只是正交而不互补，比如 2 维加 2 维，拼起来的秩最多是 4。

Strang 把这个叫作线性代数基本定理的第二部分：第一部分是维数（$r$、$n-r$、$r$、$m-r$，第 10 讲），第二部分是正交，第三部分将是这些子空间的正交基，下面几讲就会走到那里。

## 无解的方程组与 AᵀA

**$A\mathbf{x} = \mathbf{b}$ 没有解的时候怎么办？** 这是他给这一章定的主问题，听起来荒唐，实际上天天遇到：测一颗卫星的位置，测一千次，参数只有六七个；量脉搏，量很多次，未知数只有一个，但每次都有噪声。方程比未知数多，$\mathbf{b}$ 几乎不可能落在列空间里。他举的办法是先排除一个：扔掉一些方程，直到剩下方阵再解。这不对，因为没有理由说这几次测量完美、那几次一文不值。

他的预告是：不要解 $A\mathbf{x} = \mathbf{b}$，改解

$$
A^\mathsf{T}A\,\hat{\mathbf{x}} = A^\mathsf{T}\mathbf{b}.
$$

这个 $\hat{\mathbf{x}}$ 读作“x 帽”，是“最好的解”。他先直接把方程抛出来，然后把整节课剩下的时间用来研究 $A^\mathsf{T}A$：它一定是方阵（$n \times m$ 乘 $m \times n$），一定对称（转置一次，$(A^\mathsf{T}A)^\mathsf{T} = A^\mathsf{T}A$）。剩下的问题是：什么时候可逆？

他的两个例子在这里。第一个是

$$
A = \begin{bmatrix} 1 & 1 \\ 1 & 2 \\ 1 & 5 \end{bmatrix},\qquad
A^\mathsf{T}A = \begin{bmatrix} 3 & 8 \\ 8 & 30 \end{bmatrix}.
$$

$A$ 是 $3 \times 2$，两列线性无关，秩为 2；$A^\mathsf{T}A$ 的行列式 $3 \times 30 - 8 \times 8 = 26$，可逆。第二个把第二列换成“三份第一列”，$A$ 的秩变成 1，$A^\mathsf{T}A = \begin{bmatrix} 3 & 9 \\ 9 & 27 \end{bmatrix}$，两行成比例，不可逆。他说他不意外，因为秩为 1 的矩阵的乘积秩不会超过 1。

字幕里他对第二个矩阵说的是“9 和 27”，没有把 $A$ 写全；我取的是最自然的候选 $\begin{bmatrix} 1 & 3 \\ 1 & 3 \\ 1 & 3 \end{bmatrix}$，算出来正好是 3、9、9、27，和他念出的数字一致。

下面一块代码把这两个例子都算了一遍，再加两个东西：1000 个随机矩阵上检查秩是否一直相等，以及 $A\mathbf{x} = \mathbf{b}$ 无解时解一次 $A^\mathsf{T}A\hat{\mathbf{x}} = A^\mathsf{T}\mathbf{b}$，看看误差是什么样：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[1.0, 1.0], [1.0, 2.0], [1.0, 5.0]])
    G = A.T @ A
    print("A^T A =")
    print(G)
    print(
        "秩 A =",
        np.linalg.matrix_rank(A),
        "，秩 A^T A =",
        np.linalg.matrix_rank(G),
        "，det =",
        round(np.linalg.det(G), 4),
    )

    # 把第二列换成三份第一列：秩降到 1
    A1 = np.array([[1.0, 3.0], [1.0, 3.0], [1.0, 3.0]])
    G1 = A1.T @ A1
    print("A1^T A1 =")
    print(G1)
    print(
        "秩 A1 =",
        np.linalg.matrix_rank(A1),
        "，秩 A1^T A1 =",
        np.linalg.matrix_rank(G1),
        "，det =",
        np.linalg.det(G1),
    )

    # 随机检查：1000 个秩为 1 到 4 的 5 x 4 矩阵，秩 A^T A 是否总等于秩 A
    rng = np.random.default_rng(1806)
    equal = 0
    for _ in range(1000):
        k = int(rng.integers(1, 5))
        M = rng.standard_normal((5, k)) @ rng.standard_normal((k, 4))
        if np.linalg.matrix_rank(M.T @ M) == np.linalg.matrix_rank(M):
            equal += 1
    print("秩 A^T A == 秩 A 的次数：", equal, "/ 1000")

    # 预告：b 不在列空间时，解 A^T A x = A^T b，误差和每一列垂直
    b = np.array([1.0, 0.0, 3.0])
    print(
        "A x = b 有解吗：", np.linalg.matrix_rank(np.column_stack([A, b])) == 2
    )
    x_hat = np.linalg.solve(G, A.T @ b)
    e = b - A @ x_hat
    print("x_hat =", x_hat, "，误差 e =", e)
    print("A^T e =", A.T @ e, "，|e| =", round(np.linalg.norm(e), 4))


if __name__ == "__main__":
    main()
```

```text
A^T A =
[[ 3.  8.]
 [ 8. 30.]]
秩 A = 2 ，秩 A^T A = 2 ，det = 26.0
A1^T A1 =
[[ 3.  9.]
 [ 9. 27.]]
秩 A1 = 1 ，秩 A1^T A1 = 1 ，det = 0.0
秩 A^T A == 秩 A 的次数： 1000 / 1000
A x = b 有解吗： False
x_hat = [-0.3077  0.6154] ，误差 e = [ 0.6923 -0.9231  0.2308]
A^T e = [0. 0.] ，|e| = 1.1767
```

前两个例子和字幕完全对上：$\begin{bmatrix} 3 & 8 \\ 8 & 30 \end{bmatrix}$ 的行列式是 26.0，秩 2；$\begin{bmatrix} 3 & 9 \\ 9 & 27 \end{bmatrix}$ 的行列式是 0.0，秩 1。1000 个随机矩阵（秩从 1 到 4 不等）里，$A^\mathsf{T}A$ 和 $A$ 的秩相等的有 1000 个，没有一个例外。当然这只是数值上的证据，不是证明。

证明其实很短，他在课上只说了结论，说“等有机会再说明为什么”，我补在这里：如果 $A\mathbf{x} = \mathbf{0}$，那么 $A^\mathsf{T}A\mathbf{x} = \mathbf{0}$，所以 $A$ 的零空间在 $A^\mathsf{T}A$ 的零空间里。反过来，如果 $A^\mathsf{T}A\mathbf{x} = \mathbf{0}$，两边左乘 $\mathbf{x}^\mathsf{T}$，得到 $\mathbf{x}^\mathsf{T}A^\mathsf{T}A\mathbf{x} = (A\mathbf{x})^\mathsf{T}(A\mathbf{x}) = \|A\mathbf{x}\|^2 = 0$，一个向量的长度平方是零，这个向量只能是零，所以 $A\mathbf{x} = \mathbf{0}$。两个零空间相同，$n$ 相同，秩就相同。它用到的恰好是本讲第一节的“$\mathbf{x}^\mathsf{T}\mathbf{x}$ 是长度平方，除了零向量都是正数”。

结论就是他最后念的：$A^\mathsf{T}A$ 可逆，当且仅当它的零空间只有零向量，也就是 $A$ 的列线性无关。

最后几行预告了下一讲：对没有解的 $\mathbf{b} = (1, 0, 3)$，`matrix_rank` 报告增广矩阵的秩是 3，不是 2，所以 $A\mathbf{x} = \mathbf{b}$ 没有解。我还是解了 $A^\mathsf{T}A\hat{\mathbf{x}} = A^\mathsf{T}\mathbf{b}$，得到 $\hat{\mathbf{x}} = (-0.3077, 0.6154)$，误差向量 $\mathbf{e} = \mathbf{b} - A\hat{\mathbf{x}}$ 的长度是 1.1767（不为零，因为 $\mathbf{b}$ 就是不在列空间里），但 $A^\mathsf{T}\mathbf{e}$ 是零向量：$\mathbf{e}$ 和 $A$ 的每一列都垂直，也就是 $\mathbf{e}$ 在左零空间里。这就是为什么今天的“正交”和这一章的主问题连得上：**最好的解让误差落在列空间的正交补里**。

这一步他今天没有讲，我只是顺手把方程解了一次。本篇只验证了 $\hat{\mathbf{x}}$ 满足这个方程、误差与列垂直，没有证明它在什么意义上“最好”（那是第 15、16 讲的事）。

下一讲他会正式回答：既然 $\mathbf{b}$ 不在列空间，那就找列空间里离它最近的点，这个点叫 $\mathbf{b}$ 在列空间上的投影。投影矩阵长什么样，为什么它里面藏着 $(A^\mathsf{T}A)^{-1}$，见 [18.06 第 15 讲：投影到子空间](/posts/linear-algebra-15-projections/)。
