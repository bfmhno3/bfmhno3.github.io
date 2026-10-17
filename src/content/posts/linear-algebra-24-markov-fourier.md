---
title: "18.06 第 24 讲：Markov 矩阵与 Fourier 级数"
commentId: "post:linear-algebra-24-markov-fourier"
published: "2026-10-18 15:40:00 +08:00"
description: "MIT 18.06 第 24 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 把加州与麻州的人口迁移连乘了 20 年，离稳态 (666.67, 333.33) 只差 0.7523 人，再用 np.trapezoid 把方波和三角波展开成 Fourier 级数，取到 19 次谐波时三角波的误差约为方波的 1/35。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - Markov 矩阵
  - Fourier 级数
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 24
draft: false
comment: true
slug: linear-algebra-24-markov-fourier
---

这一讲其实是两件互不相干的事，共用一个工具：特征值管“乘很多次会怎样”，标准正交基管“系数怎么一步算出来”。Strang 先拿 Markov 矩阵做特征值的应用，再用后半讲把投影推到无穷维，得到 Fourier 级数。我把他的加州和麻州人口迁移连乘了 20 年，离稳态 $(666.67, 333.33)$ 只差 0.7523 人，每多乘一年，差距就缩成原来的 0.7 倍。后半段我用 `np.trapezoid` 算 Fourier 系数，取到 19 次谐波时，连续的三角波误差是 0.0103，带跳变的方波是 0.3558，差了 35 倍。

> [!NOTE] 本讲速览
> 视频：[Lecture 24: Markov matrices; Fourier series](https://www.youtube.com/watch?v=lGGDIGizcQ0)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-24-markov-matrices-fourier-series/)）
> 教材：《Introduction to Linear Algebra》第 6 版 Appendix 8 Markov Matrices and Perron-Frobenius；Fourier 级数在第 6 版移到了网站：[ila5fourierseries.pdf](https://math.mit.edu/~gs/linearalgebra/ila6/ila5fourierseries.pdf)
> 前置：[第 23 讲：微分方程与 exp(At)](/posts/linear-algebra-23-differential-equations-exp-at/)
> 一句话：每列和为 1 的非负矩阵必有特征值 1，它的特征向量就是稳态；用标准正交基展开，每个系数只是一次内积，Fourier 级数就是把这个想法用在函数上。

> [!TIP] 配合视频
> - 开头他先写下一个凭空编出来的 3 × 3 Markov 矩阵，然后追问“为什么 1 一定是特征值”。这一段（$A - I$ 的各列加起来是 0，所以各行线性相关）值得认真看，它是本讲唯一需要动脑的论证。
> - 他顺手算出特征向量 $(0.6, 33, 0.7)$ 的那几句，本篇第一节已经用代码验算过，倍速即可。
> - 加州与麻州的例子是全讲的主线，他心算 $c_1 = 1000/3$、$c_2 = 2000/3$ 的过程建议跟着做一遍。
> - 最后一部分是标准正交基展开和 Fourier 级数。时间很赶，他只推了系数公式，没有算具体函数。我在本篇最后一节补了两个函数的数值例子。

## Markov 矩阵：非负、列和为 1

他在黑板上写下的矩阵是

$$
A = \begin{bmatrix}
0.1 & 0.01 & 0.3 \\
0.2 & 0.99 & 0.3 \\
0.7 & 0 & 0.4
\end{bmatrix}
$$

**什么样的矩阵叫 Markov 矩阵？** 两条：每个元素大于等于 0；每一列加起来等于 1。第一条保证做概率用的时候不出现负数，第二条保证“每个人都有去处”，总量不变。它的每个幂依然满足这两条，所以 $A^k$ 也是 Markov 矩阵。

他关心的还是 $\mathbf{u}_{k+1} = A\mathbf{u}_k$，即 $\mathbf{u}_k = A^k\mathbf{u}_0$。上一讲的微分方程里，稳态来自 $\lambda = 0$（$e^{0t} = 1$ 不变）；幂的情形里，$\lambda = 0$ 的分量一步就死了，真正管稳态的是 $\lambda = 1$（$1^k = 1$ 不变）。他预告了两个事实：

- $\lambda = 1$ 一定是特征值；
- 其余特征值的模都小于 1（他留了余地：特殊情形下可能有另一个模等于 1 的，但绝不会大于 1）。

于是 $\mathbf{u}_0 = c_1\mathbf{x}_1 + c_2\mathbf{x}_2 + \cdots$，乘 $k$ 次之后 $\mathbf{u}_k = c_1\mathbf{x}_1 + c_2\lambda_2^k\mathbf{x}_2 + \cdots$，后面的项全部衰减，剩下 $c_1\mathbf{x}_1$：初始条件里沿 $\mathbf{x}_1$ 的那一份就是稳态。（他照例说了一遍每讲一次的良心话：这需要一组完整的特征向量。）

**为什么 1 一定是特征值？** 这是我觉得整讲最漂亮的一步。特征值是把对角线减掉之后能让矩阵变奇异的那些数，所以他检查 $A - I$：每个对角元减 1，每一列的和从 1 变成 0。各列加起来是 0，意味着把三行各乘 1 再相加，得到零行，即 $(1, 1, 1)$ 在 $A - I$ 的左零空间里。方阵的行线性相关，矩阵就奇异，所以 1 是特征值。不用算行列式，对任何 Markov 矩阵都成立。

他接着多说了一句：$A$ 与 $A^T$ 的特征值相同，因为 $\det(A - \lambda I) = \det(A^T - \lambda I)$（行列式性质里的第 10 条，转置不改变行列式）。所以上面其实是在说 $A^T$ 有特征向量 $(1, 1, 1)$，对应特征值 1；而 $A$ 自己的特征向量是 $A - I$ 的零空间里的另一个向量，得另外去找。

我把这些逐条交给 NumPy：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # Strang 黑板上凭空编出来的 Markov 矩阵，每一列是一个概率分布
    A = np.array([[0.1, 0.01, 0.3], [0.2, 0.99, 0.3], [0.7, 0.0, 0.4]])
    print("列和：", A.sum(axis=0))
    print("A^2 的列和：", (A @ A).sum(axis=0))
    print("A^2 的最小元素 >= 0：", (A @ A).min() >= 0)

    # 全 1 向量在左零空间：1^T (A - I) = 0，所以 A - I 奇异
    ones = np.ones(3)
    print("1^T (A - I) =", ones @ (A - np.eye(3)))
    print("det(A - I) =", f"{np.linalg.det(A - np.eye(3)):.2e}")

    vals, vecs = np.linalg.eig(A)
    print("A 的特征值：", vals)
    print("A^T 的特征值：", np.linalg.eigvals(A.T))

    # 他手算的特征向量 (0.6, 33, 0.7)，验证它在 A - I 的零空间里
    x1 = np.array([0.6, 33.0, 0.7])
    print("(A - I) @ (0.6, 33, 0.7) =", (A - np.eye(3)) @ x1)
    k = np.argmin(np.abs(vals - 1.0))
    v = vecs[:, k].real
    print("eig 给出的 λ = 1 的特征向量，缩放后：", v / v[0] * 0.6)

    # 稳态：把特征向量缩放成和为 1 的概率分布
    steady = x1 / x1.sum()
    print("稳态（和为 1）：", steady)
    P = np.linalg.matrix_power(A, 100)
    print("A^100 的每一列：")
    print(P)
    print("每一列都接近稳态：", np.allclose(P, steady[:, None]))


if __name__ == "__main__":
    main()
```

```text
列和： [1. 1. 1.]
A^2 的列和： [1. 1. 1.]
A^2 的最小元素 >= 0： True
1^T (A - I) = [ 0. -0.  0.]
det(A - I) = -2.33e-18
A 的特征值： [-0.2315  0.7215  1.    ]
A^T 的特征值： [-0.2315  0.7215  1.    ]
(A - I) @ (0.6, 33, 0.7) = [-0. -0.  0.]
eig 给出的 λ = 1 的特征向量，缩放后： [ 0.6 33.   0.7]
稳态（和为 1）： [0.0175 0.9621 0.0204]
A^100 的每一列：
[[0.0175 0.0175 0.0175]
 [0.9621 0.9621 0.9621]
 [0.0204 0.0204 0.0204]]
每一列都接近稳态： True
```

- 列和是 $(1, 1, 1)$，$A^2$ 也是；$1^T(A - I)$ 是零向量，$\det(A - I)$ 是 $-2.33 \times 10^{-18}$，浮点意义上的 0。
- $A$ 和 $A^T$ 的特征值都是 $-0.2315$、$0.7215$、$1$：1 在，其余两个模都小于 1。
- 他手算的特征向量 $(0.6, 33, 0.7)$ 通过了检验：他说“这是线性代数史上第一次特征向量里出现 3300 这种分量”，随即发现多读了两位小数，其实只是 33。`np.linalg.eig` 给出的向量缩放后和他的完全一致。
- 缩放成和为 1 的概率分布，稳态是 $(0.0175, 0.9621, 0.0204)$。$A^{100}$ 的三列都收敛到它，三列相同，意味着不管从哪个状态出发，100 步之后都是同一个分布。第二个状态的自留率 0.99 太高了，所以稳态里它占了 96%。

特征向量的分量全是正的，这点他说理论保证，但没有证，我也不证（据我所知这是 Perron-Frobenius 定理的内容，教材的 Appendix 8 讲的就是它）。

## 加州与麻州：特征值管着人口往哪走

**稳态到底有什么用？** 他的例子是两个州的人口迁移：每年 10% 的加州人搬去麻州，20% 的麻州人搬去加州（他说“Red Sox 又输了”），其余的留在原地：

$$
\begin{bmatrix} u_\text{Cal} \\ u_\text{Mass} \end{bmatrix}_{k+1}
= \begin{bmatrix} 0.9 & 0.2 \\ 0.1 & 0.8 \end{bmatrix}
\begin{bmatrix} u_\text{Cal} \\ u_\text{Mass} \end{bmatrix}_k
$$

（我怀疑这两个比例是为了让黑板上的数好算而挑的，现实里大概没有人这么整齐地搬家。）第一列是加州人的去向（0.9 留下，0.1 搬走，合计 1），第二列是麻州人的去向。初始状态：加州 0 人，麻州 1000 人。

一步之后是 $(200, 800)$：200 人去了加州。再乘一次，加州会超过 200，麻州会低于 800，总数仍是 1000。这个矩阵的特征值不用解方程：1 肯定有；迹是 1.7，所以另一个是 0.7（验证：行列式 $0.72 - 0.02 = 0.7$）。特征向量：$A - I$ 的零空间是 $(2, 1)$，$A - 0.7I$ 的零空间是 $(-1, 1)$。

稳态是 $(2, 1)$ 的某个倍数，倍数由“总数 1000”定出：$\frac{1000}{3} \times (2, 1)$，即加州 $666.67$、麻州 $333.33$。再把 $\mathbf{u}_0$ 展开：

$$
\mathbf{u}_k = \frac{1000}{3} \cdot 1^k \begin{bmatrix} 2 \\ 1 \end{bmatrix} +
\frac{2000}{3} \cdot 0.7^k \begin{bmatrix} -1 \\ 1 \end{bmatrix}
$$

$k = 0$ 时第一个分量是 $\frac{2000}{3} - \frac{2000}{3} = 0$，第二个是 $\frac{1000}{3} + \frac{2000}{3} = 1000$，对上了。下面的脚本验算这一整套，并看看闭式公式和直接连乘是不是同一回事、离稳态有多远：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 加州和麻州：每年 10% 的加州人搬去麻州，20% 的麻州人搬去加州
    A = np.array([[0.9, 0.2], [0.1, 0.8]])
    u0 = np.array([0.0, 1000.0])  # (加州, 麻州)

    u = u0.copy()
    for k in range(1, 4):
        u = A @ u
        print(f"第 {k} 年：", u, "总人数：", u.sum())

    vals, vecs = np.linalg.eig(A)
    print("特征值：", vals)  # 迹 1.7，行列式 0.7

    # 他手算的两个特征向量：λ = 1 对应 (2, 1)，λ = 0.7 对应 (-1, 1)
    x1 = np.array([2.0, 1.0])
    x2 = np.array([-1.0, 1.0])
    print("A @ x1 - x1 =", A @ x1 - x1)
    print("A @ x2 - 0.7 * x2 =", A @ x2 - 0.7 * x2)

    # u0 = c1 x1 + c2 x2，他心算得到 c1 = 1000/3，c2 = 2000/3
    S = np.column_stack([x1, x2])
    c = np.linalg.solve(S, u0)
    print("c =", c, "，1000/3 =", 1000 / 3)

    steady = c[0] * x1
    print("稳态：", steady)
    for k in [1, 5, 10, 20, 100]:
        closed = c[0] * x1 + c[1] * 0.7**k * x2
        direct = np.linalg.matrix_power(A, k) @ u0
        gap = np.linalg.norm(direct - steady)
        print(
            f"k = {k:3d}：公式与连乘一致 {np.allclose(closed, direct)}，"
            f"离稳态 {gap:.4f}"
        )


if __name__ == "__main__":
    main()
```

```text
第 1 年： [200. 800.] 总人数： 1000.0
第 2 年： [340. 660.] 总人数： 1000.0
第 3 年： [438. 562.] 总人数： 1000.0
特征值： [1.  0.7]
A @ x1 - x1 = [0. 0.]
A @ x2 - 0.7 * x2 = [0. 0.]
c = [333.3333 666.6667] ，1000/3 = 333.3333333333333
稳态： [666.6667 333.3333]
k =   1：公式与连乘一致 True，离稳态 659.9663
k =   5：公式与连乘一致 True，离稳态 158.4579
k =  10：公式与连乘一致 True，离稳态 26.6320
k =  20：公式与连乘一致 True，离稳态 0.7523
k = 100：公式与连乘一致 True，离稳态 0.0000
```

- 前三年是 $(200, 800)$、$(340, 660)$、$(438, 562)$，每年总数都是 1000。
- `eig` 给出的特征值是 $1$ 和 $0.7$，$c = (333.33, 666.67)$，与他心算的 $1000/3$、$2000/3$ 一致。
- 闭式公式在 $k = 1, 5, 10, 20, 100$ 都与 `matrix_power` 连乘一致。
- 离稳态的距离：第 10 年是 26.6320，第 20 年是 0.7523。二者的比 $0.7523 / 26.6320 \approx 0.0282$，正好是 $0.7^{10} \approx 0.0282$：十年缩小到原来的 2.8% 左右（约 1/35），每年缩小 30%。第 100 年，打印到四位小数已经是 0.0000。

所以他说“波士顿的清教徒现在在哪”，答案和初始条件没有关系：只要总数是 1000，不管一开始 1000 个人全在麻州，还是全在加州，几百年之后都是 $(666.67, 333.33)$。第二个特征值 0.7 只决定走得多快，不决定走向哪里。

他还提醒了一件会让你在别的书里糊涂的事：很多工程课程喜欢用行向量，$\mathbf{u}_{k+1}^T = \mathbf{u}_k^T A$，这时 $A$ 是上面这个矩阵的转置，改成“每一行和为 1”。数学上是同一回事，注意一下约定就行了。我以后在控制和概率的书里碰到“行随机矩阵”，大概就是这个意思。

## 标准正交基：系数只是一次内积

后半讲他说是“投影那一章的一个了不起的应用”。先回到有限维。$\mathbf{q}_1, \dots, \mathbf{q}_n$ 是 $n$ 维空间的一组标准正交基，任何向量 $\mathbf{v}$ 都能写成

$$
\mathbf{v} = x_1\mathbf{q}_1 + x_2\mathbf{q}_2 + \cdots + x_n\mathbf{q}_n
$$

**系数 $x_1$ 怎么求？** 一般的基要解方程组。标准正交基的好处是：两边同时和 $\mathbf{q}_1$ 做内积，$\mathbf{q}_1^T\mathbf{q}_j$ 在 $j \ne 1$ 时是 0，$j = 1$ 时是 1，其余全部消失，得到 $x_1 = \mathbf{q}_1^T\mathbf{v}$。写成矩阵形式，$Q\mathbf{x} = \mathbf{v}$，解是 $\mathbf{x} = Q^{-1}\mathbf{v}$，而 $Q$ 是正交矩阵时 $Q^{-1} = Q^T$，所以 $\mathbf{x} = Q^T\mathbf{v}$，第 $i$ 个分量就是第 $i$ 个 $\mathbf{q}_i$ 与 $\mathbf{v}$ 的内积。他说这时的“展开”和“投影”是一回事：投影的正规方程 $(Q^TQ)\hat{\mathbf{x}} = Q^T\mathbf{b}$ 里 $Q^TQ = I$，直接剩下 $\hat{\mathbf{x}} = Q^T\mathbf{b}$。

我用随机正交基验证一遍：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 随机正交基：对随机矩阵做 QR，取 Q 的列
    Q, _ = np.linalg.qr(rng.standard_normal((5, 5)))
    v = rng.standard_normal(5)
    print("||Q^T Q - I|| =", f"{np.linalg.norm(Q.T @ Q - np.eye(5)):.2e}")

    # 展开系数：x1 = q1^T v，一次点积，不用解方程
    x_dot = np.array([Q[:, i] @ v for i in range(5)])
    x_matrix = Q.T @ v
    x_solve = np.linalg.solve(Q, v)
    print("x =", x_matrix)
    print("逐个点积 = Q^T v：", np.allclose(x_dot, x_matrix))
    print("Q^T v = solve(Q, v)：", np.allclose(x_matrix, x_solve))
    print("Q @ x 还原 v：", np.allclose(Q @ x_matrix, v))


if __name__ == "__main__":
    main()
```

```text
||Q^T Q - I|| = 5.10e-16
x = [-0.1733  0.336  -2.3959  2.6273  0.7986]
逐个点积 = Q^T v： True
Q^T v = solve(Q, v)： True
Q @ x 还原 v： True
```

- 随机矩阵做 QR 得到的 $Q$ 满足 $\lVert Q^TQ - I\rVert = 5.10 \times 10^{-16}$，在舍入误差内是正交的。
- 逐个做点积、一次 `Q.T @ v`、解方程 `solve(Q, v)`，三种做法得到同一个 $\mathbf{x}$，`Q @ x` 能还原 $\mathbf{v}$。

`solve` 要做一次 LU 分解，`Q.T @ v` 只是五个点积。这个差别在 $5 \times 5$ 里看不出来，在 Fourier 里它是决定性的：基向量有无穷多个，不能解无穷个方程，但每个系数仍然只需要一次积分。

## 函数也是向量：Fourier 级数

**怎么把这个想法搬到函数上？** 他的原话大意是：Fourier 意识到，向量 $\mathbf{v}$ 可以换成函数 $f(x)$，正交向量 $\mathbf{q}_1, \mathbf{q}_2, \dots$ 可以换成正交函数 $1, \cos x, \sin x, \cos 2x, \sin 2x, \dots$，只不过无穷多个，因为这个空间是无穷维的。展开式是

$$
f(x) = a_0 + a_1\cos x + b_1\sin x + a_2\cos 2x + b_2\sin 2x + \cdots
$$

“正交”要有内积。向量的内积是 $\mathbf{v}^T\mathbf{w} = v_1w_1 + \cdots + v_nw_n$：把对应分量相乘，再相加。函数有一整条连续的 $x$，“对应分量相乘”就是在每个 $x$ 处取 $f(x)g(x)$，“相加”换成积分：

$$
\langle f, g \rangle = \int_0^{2\pi} f(x)\,g(x)\,dx
$$

积分区间是 $[0, 2\pi]$，因为所有的正弦和余弦都以 $2\pi$ 为周期，$f$ 也得是。他当场检验了一对：$\int_0^{2\pi}\sin x\cos x\,dx = \frac12\sin^2 x \big|_0^{2\pi} = 0$，其余各对“用一点三角恒等式”就能得到。我用 `np.trapezoid` 把五个函数两两做内积，排成 Gram 矩阵：

```python
import numpy as np


def inner(f: np.ndarray, g: np.ndarray, x: np.ndarray) -> float:
    """函数内积：在 [0, 2π] 上对 f(x) g(x) 做数值积分。"""
    return float(np.trapezoid(f * g, x))


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    x = np.linspace(0.0, 2.0 * np.pi, 2001)
    basis = [
        ("1", np.ones_like(x)),
        ("cos x", np.cos(x)),
        ("sin x", np.sin(x)),
        ("cos 2x", np.cos(2 * x)),
        ("sin 2x", np.sin(2 * x)),
    ]

    # 他口算的那一个：sin x 与 cos x 的内积
    print("<sin x, cos x> =", f"{inner(basis[2][1], basis[1][1], x):.2e}")

    # 五个函数两两做内积：对角线是长度的平方，其余应当是 0
    G = np.array([[inner(f, g, x) for _, g in basis] for _, f in basis])
    print(G)
    print("对角线：", np.diag(G))
    print("π =", np.pi, "，2π =", 2 * np.pi)
    off = np.abs(G - np.diag(np.diag(G))).max()
    print("非对角元的最大绝对值：", f"{off:.2e}")


if __name__ == "__main__":
    main()
```

```text
<sin x, cos x> = 0.00e+00
[[ 6.2832 -0.      0.     -0.     -0.    ]
 [-0.      3.1416  0.     -0.      0.    ]
 [ 0.      0.      3.1416  0.      0.    ]
 [-0.     -0.      0.      3.1416 -0.    ]
 [-0.      0.      0.     -0.      3.1416]]
对角线： [6.2832 3.1416 3.1416 3.1416 3.1416]
π = 3.141592653589793 ，2π = 6.283185307179586
非对角元的最大绝对值： 4.44e-16
```

- $\langle \sin x, \cos x \rangle = 0$，与他的黑板一致。
- Gram 矩阵除对角线外全是 0（最大的非对角元绝对值是 $4.44 \times 10^{-16}$），对角线是 $(2\pi, \pi, \pi, \pi, \pi)$：常数函数长度的平方是 $2\pi$，其余是 $\pi$。他说 $\int\cos^2 x\,dx = \pi$，这里印证了。

注意：这五个函数是正交的，但没有归一化，所以它们更像“长度各不相同的正交基”。求系数时要除以长度的平方，这就是 Fourier 公式里 $\frac1\pi$ 的来历。

**$a_1$ 到底是多少？** 套用有限维的做法：两边同时乘 $\cos x$ 再积分，右边只有 $a_1\int\cos^2 x\,dx = a_1\pi$ 这一项活着，所以

$$
a_1 = \frac{1}{\pi}\int_0^{2\pi} f(x)\cos x\,dx
$$

同理 $a_k = \frac1\pi\int f\cos kx\,dx$，$b_k = \frac1\pi\int f\sin kx\,dx$。常数项 $a_0$ 是例外，要除以 $\int 1\,dx = 2\pi$，所以它就是 $f$ 在一个周期里的平均值，他说“那个问题很容易”。

他到这里下课了，没有算一个具体函数。我挑了两个：方波（$[0, \pi)$ 上为 $1$，$[\pi, 2\pi)$ 上为 $-1$）和三角波 $|x - \pi|$。代码里用 20001 个点做梯形积分，求出 $a_0$、前 20 个 $a_k, b_k$，再看取前 $n$ 次谐波的部分和离原函数有多远（用 $L^2$ 距离 $\sqrt{\int (f - s)^2dx}$，也就是函数空间里的“长度”）：

```python
import numpy as np


def inner(f: np.ndarray, g: np.ndarray, x: np.ndarray) -> float:
    """函数内积：在 [0, 2π] 上对 f(x) g(x) 做数值积分。"""
    return float(np.trapezoid(f * g, x))


def fourier(
    f: np.ndarray, x: np.ndarray, n: int
) -> tuple[float, np.ndarray, np.ndarray]:
    """返回 a0（平均值），以及 a_k、b_k（k = 1..n）。"""
    a0 = inner(f, np.ones_like(x), x) / (2.0 * np.pi)
    a = np.array([inner(f, np.cos(k * x), x) / np.pi for k in range(1, n + 1)])
    b = np.array([inner(f, np.sin(k * x), x) / np.pi for k in range(1, n + 1)])
    return a0, a, b


def partial_sum(
    a0: float, a: np.ndarray, b: np.ndarray, x: np.ndarray, n: int
) -> np.ndarray:
    s = np.full_like(x, a0)
    for k in range(1, n + 1):
        s += a[k - 1] * np.cos(k * x) + b[k - 1] * np.sin(k * x)
    return s


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    x = np.linspace(0.0, 2.0 * np.pi, 20001)
    # 方波：跳变点取 0（左右极限的平均），这样 [0, 2π] 两端也对称
    square = np.sign(np.round(np.sin(x), 12))
    tri = np.abs(x - np.pi)  # 三角波，连续但有尖角

    for name, f in [("方波", square), ("三角波", tri)]:
        a0, a, b = fourier(f, x, 20)
        print(f"{name}：a0 = {a0:.4f}")
        print("  a1..a5 =", a[:5])
        print("  b1..b5 =", b[:5])
        for n in [1, 3, 9, 19]:
            s = partial_sum(a0, a, b, x, n)
            err = np.sqrt(inner((f - s) ** 2, np.ones_like(x), x))
            print(f"  取到 {n:2d} 次谐波：L2 误差 = {err:.4f}")

    # 方波的理论值：b_k = 4 / (π k)（k 为奇数），偶数项为 0
    _, _, b = fourier(square, x, 5)
    print("方波 b_k 的数值：", b)
    print("理论 4/(πk)：", [round(4 / (np.pi * k), 4) for k in (1, 3, 5)])

    # 方波在跳变点附近的过冲（Gibbs 现象）
    a0, a, b = fourier(square, x, 19)
    peak = partial_sum(a0, a, b, x, 19).max()
    print(f"方波 19 次部分和的最大值：{peak:.4f}")


if __name__ == "__main__":
    main()
```

```text
方波：a0 = -0.0000
  a1..a5 = [ 0. -0.  0. -0.  0.]
  b1..b5 = [ 1.2732 -0.      0.4244  0.      0.2546]
  取到  1 次谐波：L2 误差 = 1.0907
  取到  3 次谐波：L2 误差 = 0.7898
  取到  9 次谐波：L2 误差 = 0.5032
  取到 19 次谐波：L2 误差 = 0.3558
三角波：a0 = 1.5708
  a1..a5 = [ 1.2732 -0.      0.1415 -0.      0.0509]
  b1..b5 = [-0. -0. -0. -0. -0.]
  取到  1 次谐波：L2 误差 = 0.2734
  取到  3 次谐波：L2 误差 = 0.1090
  取到  9 次谐波：L2 误差 = 0.0289
  取到 19 次谐波：L2 误差 = 0.0103
方波 b_k 的数值： [ 1.2732 -0.      0.4244  0.      0.2546]
理论 4/(πk)： [1.2732, 0.4244, 0.2546]
方波 19 次部分和的最大值：1.1798
```

- 方波是奇函数，所有 $a_k$ 都是 0（打印出来的 $\pm 0$ 是舍入噪声）；偶数次的 $b_k$ 也是 0，只剩奇数次，数值积分给出 $b_1, b_3, b_5 = 1.2732, 0.4244, 0.2546$，与理论值 $4/(\pi k)$ 一致。
- 三角波关于 $x = \pi$ 对称，所有 $b_k$ 都是 0；平均值 $a_0 = 1.5708 = \pi/2$；奇数次的 $a_k$ 是 $1.2732, 0.1415, 0.0509$，即 $4/(\pi k^2)$，衰减得比方波的 $4/(\pi k)$ 快得多。
- 取到 19 次谐波，三角波的误差是 0.0103，方波是 0.3558，相差约 35 倍。尖角还连得上，跳变连不上，高次项就得一直陪着。
- 方波 19 次部分和的最大值是 1.1798，而真值是 1。多取几项过冲不会消失，只是被挤到跳变点附近（Gibbs 现象，我是从别处看到的，这里只验证了 19 项的峰值）。

我觉得这就像一块三棱镜：一束白光进去，按频率分成一排纯色，每一种颜色是多少，就是 $a_k$ 和 $b_k$ 的大小。区别是棱镜分的是光，Fourier 级数分的是函数，而分的依据恰好是“正交”。

这一讲的两部分其实在谈同一个对象：一组特别好用的基。Markov 矩阵的特征向量是让 $A^k$ 变简单的基，$\sin kx$、$\cos kx$ 是让展开变简单的基。第 26 讲讲 Fourier 矩阵时，这两条线会撞到一起：Fourier 矩阵归一化之后是酉矩阵，也就是复数世界里的正交矩阵。

下一讲不是新内容，是第二次测验的复习，他在结尾说周一复习、周三考试。我会逐题用 NumPy 验证他讲的题，见 [18.06 第 24b 讲：第二次测验复习](/posts/linear-algebra-24b-quiz-2-review/)。
