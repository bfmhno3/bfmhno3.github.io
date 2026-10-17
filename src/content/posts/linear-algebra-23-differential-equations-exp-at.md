---
title: "18.06 第 23 讲：微分方程与 exp(At)"
commentId: "post:linear-algebra-23-differential-equations-exp-at"
published: "2026-10-18 15:20:00 +08:00"
description: "MIT 18.06 第 23 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 把 du/dt = Au 的解 exp(At)u(0) 用特征分解、Taylor 级数和缩放平方各算了一遍，t = 20 时 60 项 Taylor 的误差是 3.11e+24，缩放平方是 1.05e-15。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 微分方程
  - 矩阵指数
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 23
draft: false
comment: true
slug: linear-algebra-23-differential-equations-exp-at
---

上一讲 Strang 用特征值算 $A^k$，这一讲把离散的 $k$ 换成连续的 $t$：$\mathrm{d}\mathbf{u}/\mathrm{d}t = A\mathbf{u}$ 的解是 $\mathbf{u}(t) = e^{At}\mathbf{u}(0)$，而 $e^{At} = S e^{\Lambda t} S^{-1}$。公式很漂亮，但我顺手拿“把 Taylor 级数直接加起来”这个定义去算，在 $t = 20$ 时 60 项的结果误差是 3.11e+24，而缩放平方只差 1.05e-15：定义是好定义，拿来当算法就不行了。

> [!NOTE] 本讲速览
> 视频：[Lecture 23: Differential equations and exp(At)](https://www.youtube.com/watch?v=IZqwi0wJovM)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-23-differential-equations-and-exp-at/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §6.5 Solving Linear Differential Equations
> 前置：[第 22 讲：对角化与矩阵的幂](/posts/linear-algebra-22-diagonalization-powers/)
> 一句话：$\mathrm{d}\mathbf{u}/\mathrm{d}t = A\mathbf{u}$ 的解由纯指数解 $e^{\lambda t}\mathbf{x}$ 组成，系数由 $S\mathbf{c} = \mathbf{u}(0)$ 决定，是否收敛只看特征值的实部是否为负。

> [!TIP] 配合视频
> - 前半节课的黑板例子（$2 \times 2$ 矩阵，特征值 0 和 $-3$）值得认真看：他怎么先“目测”特征值，再预言解的样子。本篇第一节用代码把它算了一遍。
> - 中间关于稳定性的几分钟（实部为负、复数的虚部只转圈、$2 \times 2$ 看迹与行列式）是整讲的重点，本篇第二节验证了这些结论，不过他的口头论证比我的数字更好懂，建议原速看。
> - 定义 $e^{At}$ 的那段（Taylor 级数、几何级数的旁白、$S e^{\Lambda t} S^{-1}$ 的推导）一步一步推，慢慢写下来最好；我的代码只验证结果，可以倍速。
> - 最后一个例子是把二阶方程变成 $2 \times 2$ 方程组，只有几分钟，本篇最后一节用代码重算了一遍，还顺手做了五阶的情形。

## 一个例子：从特征值预言整条解

Strang 先把方程摆出来：

$$
\frac{\mathrm{d}\mathbf{u}}{\mathrm{d}t} = A\mathbf{u},\qquad
A = \begin{bmatrix} -1 & 2 \\ 1 & -2 \end{bmatrix},\qquad
\mathbf{u}(0) = \begin{bmatrix} 1 \\ 0 \end{bmatrix}
$$

**为什么要从特征值开始？** 因为常系数线性方程的解是指数函数，找指数函数只需要知道“指数上是什么、前面乘什么”，这正是特征值和特征向量。他还没解方程就先看矩阵：第二列是第一列的 $-2$ 倍，所以矩阵奇异，$\lambda_1 = 0$；迹是 $-3$，所以另一个特征值 $\lambda_2 = -3$。他在这里就预言了：解里会有一项 $e^{0t}$（常数，稳态）和一项 $e^{-3t}$（很快消失）。

特征向量：$\lambda_1 = 0$ 对应零空间里的 $\mathbf{x}_1 = (2, 1)$；$\lambda_2 = -3$ 对应 $A + 3I$ 的零空间，$\mathbf{x}_2 = (1, -1)$。解是两个纯指数解的组合：

$$
\mathbf{u}(t) = c_1 e^{0t}\begin{bmatrix} 2 \\ 1 \end{bmatrix} +
c_2 e^{-3t}\begin{bmatrix} 1 \\ -1 \end{bmatrix}
$$

他先验证了纯指数解确实满足方程：左边求导落下一个 $\lambda_1$，右边 $A e^{\lambda_1 t}\mathbf{x}_1 = e^{\lambda_1 t}\lambda_1\mathbf{x}_1$，两边一样。这和上一讲的“纯幂”$\lambda^k\mathbf{x}$ 是同一件事，只是 $\lambda^k$ 换成了 $e^{\lambda t}$。

系数 $c_1, c_2$ 由初值定：$t = 0$ 时 $c_1\mathbf{x}_1 + c_2\mathbf{x}_2 = \mathbf{u}(0)$，矩阵形式就是 $S\mathbf{c} = \mathbf{u}(0)$，$S$ 是特征向量矩阵。解出来 $c_1 = c_2 = \tfrac13$。下面的脚本做这几件事，并且用四阶 Runge-Kutta 直接对微分方程积分，和公式对一次：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # Strang 黑板上的例子：du/dt = A u，u(0) = (1, 0)
    A = np.array([[-1.0, 2.0], [1.0, -2.0]])
    u0 = np.array([1.0, 0.0])

    lam, S = np.linalg.eig(A)
    print("特征值：", lam)
    print("迹 =", np.trace(A), "，行列式 =", round(np.linalg.det(A), 12))

    # 他取的特征向量：lambda = 0 对应 (2, 1)，lambda = -3 对应 (1, -1)
    X = np.array([[2.0, 1.0], [1.0, -1.0]])
    print("A @ x1 =", A @ X[:, 0], "，A @ x2 =", A @ X[:, 1])

    # S c = u(0)：解出每个纯指数解在初值里占多少
    c = np.linalg.solve(X, u0)
    print("c =", c)

    def u_exact(t: float) -> np.ndarray:
        # u(t) = c1 e^{0 t} x1 + c2 e^{-3 t} x2
        return c[0] * X[:, 0] + c[1] * np.exp(-3.0 * t) * X[:, 1]

    # 用四阶 Runge-Kutta 直接积分微分方程，对照公式
    def rk4(u: np.ndarray, h: float) -> np.ndarray:
        k1 = A @ u
        k2 = A @ (u + 0.5 * h * k1)
        k3 = A @ (u + 0.5 * h * k2)
        k4 = A @ (u + h * k3)
        return u + h / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4)

    u = u0.copy()
    h = 0.01
    for step in range(1, 1001):
        u = rk4(u, h)
        if step in (10, 100, 1000):
            t = step * h
            err = np.linalg.norm(u - u_exact(t))
            print(f"t = {t:5.2f}  u = {u_exact(t)}  与 RK4 的差 = {err:.2e}")

    steady = c[0] * X[:, 0]
    print("稳态 u(inf) =", steady)
    print("等于 (2/3, 1/3)：", np.allclose(steady, [2 / 3, 1 / 3]))


if __name__ == "__main__":
    main()
```

```text
特征值： [ 0. -3.]
迹 = -3.0 ，行列式 = 0.0
A @ x1 = [0. 0.] ，A @ x2 = [-3.  3.]
c = [0.3333 0.3333]
t =  0.10  u = [0.9136 0.0864]  与 RK4 的差 = 7.25e-10
t =  1.00  u = [0.6833 0.3167]  与 RK4 的差 = 4.87e-10
t = 10.00  u = [0.6667 0.3333]  与 RK4 的差 = 4.97e-16
稳态 u(inf) = [0.6667 0.3333]
等于 (2/3, 1/3)： True
```

特征值是 $0$ 和 $-3$，和他心算的一样。$c_1 = c_2 = 0.3333$。更值得看的是最后几行：公式和 RK4 在 $t = 0.1$ 时只差 7.25e-10（这差的是 RK4 的截断误差，步长 0.01），$t = 10$ 时 $e^{-30}$ 已经小到两者几乎无差，稳态就是 $c_1\mathbf{x}_1 = (2/3, 1/3)$。

这就是他说的“流”：一开始所有东西都在 $u_1$ 里（$(1, 0)$），随着时间推移，一部分流到 $u_2$，最后停在 $(2/3, 1/3)$。总量 $u_1 + u_2$ 一直是 1，不变，这和零特征值的左零空间有关，下一讲的 Markov 矩阵会把这件事讲透。

![左：A 的轨迹，所有轨迹沿 (1, -1) 方向落到特征值 0 的特征向量那条线上。右：二阶方程 y'' + 0.4y' + 4y = 0 在 (y, y') 平面上的螺旋](/assets/images/linear-algebra/l23-phase-plane.svg)

上面这张图由下面这个脚本生成（需要 matplotlib，在当前目录写出 SVG；图中的数据与前面的代码块相同）：

```python
import matplotlib
import matplotlib.pyplot as plt
import numpy as np


def main() -> None:
    matplotlib.use("Agg")
    plt.rcParams["svg.hashsalt"] = "la1806"

    def rk4_path(A, u0, T, n):
        h = T / n
        path = [u0]
        u = u0
        for _ in range(n):
            k1 = A @ u
            k2 = A @ (u + 0.5 * h * k1)
            k3 = A @ (u + 0.5 * h * k2)
            k4 = A @ (u + h * k3)
            u = u + h / 6.0 * (k1 + 2 * k2 + 2 * k3 + k4)
            path.append(u)
        return np.array(path)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 4))

    # 左：Strang 的例子，特征向量 (2, 1) 与 (1, -1)
    A = np.array([[-1.0, 2.0], [1.0, -2.0]])
    s = np.linspace(-1.5, 1.5, 2)
    ax1.plot(
        2 * s,
        1 * s,
        "--",
        color="tab:red",
        lw=1,
        label=r"$x_1=(2,1)$, $\lambda=0$",
    )
    ax1.plot(
        1 * s + 2 / 3,
        -1 * s + 1 / 3,
        "--",
        color="tab:green",
        lw=1,
        label=r"$x_2=(1,-1)$, $\lambda=-3$",
    )
    for u0 in [
        (1, 0),
        (0, 1),
        (-0.5, 0.2),
        (1.5, 1.0),
        (0.2, -0.8),
        (-1, -0.5),
    ]:
        p = rk4_path(A, np.array(u0, float), 3.0, 300)
        ax1.plot(p[:, 0], p[:, 1], color="tab:blue", lw=1)
        ax1.plot(*u0, "o", color="tab:blue", ms=3)
    p = rk4_path(A, np.array([1.0, 0.0]), 3.0, 300)
    ax1.plot(p[:, 0], p[:, 1], color="k", lw=2)
    ax1.plot(2 / 3, 1 / 3, "k*", ms=10)
    ax1.annotate("u(0) = (1, 0)", (1, 0), (1.25, 0.15))
    ax1.annotate("u(inf) = (2/3, 1/3)", (2 / 3, 1 / 3), (1.0, 0.7))
    ax1.set_xlim(-1.5, 2.0)
    ax1.set_ylim(-1.0, 1.5)
    ax1.set_xlabel("$u_1$")
    ax1.set_ylabel("$u_2$")
    ax1.set_title("Real eigenvalues 0 and -3: trajectories end on a line")
    ax1.legend(loc="lower right", fontsize=8)
    ax1.set_aspect("equal")

    # 右：y'' + 0.4 y' + 4 y = 0，u = (y', y)
    B = np.array([[-0.4, -4.0], [1.0, 0.0]])
    p = rk4_path(B, np.array([0.0, 1.0]), 15.0, 3000)
    ax2.plot(p[:, 1], p[:, 0], color="tab:blue", lw=1.2)
    ax2.plot(1, 0, "o", color="k", ms=4)
    ax2.plot(0, 0, "k*", ms=10)
    ax2.set_xlabel("$y$")
    ax2.set_ylabel("$y'$")
    ax2.set_title(r"Complex eigenvalues $-0.2 \pm 1.99i$: a spiral")
    ax2.set_aspect("equal")
    for ax in (ax1, ax2):
        ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(
        "l23-phase-plane.svg",
        metadata={"Date": None},
    )


if __name__ == "__main__":
    main()
```

左图是 $\mathbf{u}(t)$ 在 $(u_1, u_2)$ 平面上的轨迹。每条线都沿 $\mathbf{x}_2 = (1, -1)$ 的方向走向红色虚线（$\lambda = 0$ 的特征向量，也就是 $A\mathbf{u} = \mathbf{0}$ 的所有点），$e^{-3t}$ 的那个分量被压没了。粗线是从 $(1, 0)$ 出发的那条。右图留到最后一节再说。

## 稳定性：只看实部

**什么时候解会趋于零？** 他的回答是：所有特征值的实部为负。这里他停下来专门讲了复数：如果 $\lambda = -3 + 6i$，那 $e^{\lambda t} = e^{-3t}(\cos 6t + i\sin 6t)$，后面那个因子的模恒为 1，只在单位圆上转，真正管增长和衰减的是 $e^{-3t}$。虚部只负责在两个分量之间来回摆动。

三种情形：

- 所有特征值实部为负：$\mathbf{u}(t) \to \mathbf{0}$，稳定。
- 有一个特征值是 0，其余实部为负：趋于稳态，就像刚才的例子。
- 任何一个特征值实部为正：爆炸。

他还指出把 $A$ 变成 $-A$ 的效果：所有特征值变号，稳定的变成爆炸的，只有 0 还是 0。

对 $2 \times 2$ 矩阵，他给了不用解特征值的判据。两个特征值实部都为负，迹 $= \lambda_1 + \lambda_2$ 必须为负（复数共轭对的虚部相加时消掉）。但光迹为负不够：他举的例子是 $\begin{bmatrix} -2 & 0 \\ 0 & 1 \end{bmatrix}$，迹 $-1$，特征值 $-2$ 和 $1$，照样爆炸。还需要行列式 $= \lambda_1\lambda_2 > 0$，两个都是负的，乘起来才是正的。结论：迹 $< 0$ 且行列式 $> 0$。

我用代码验证这些说法，并且拿 20000 个随机 $2 \times 2$ 矩阵检验迹与行列式的判据：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 复特征值：只有实部决定增长，虚部只负责转圈
    lam = -3.0 + 6.0j
    for t in (0.0, 0.5, 1.0):
        print(
            f"t = {t}：|e^(lam t)| = {abs(np.exp(lam * t)):.4f}，"
            f"e^(-3t) = {np.exp(-3.0 * t):.4f}"
        )

    # 迹为负仍然会爆炸的例子
    B = np.array([[-2.0, 0.0], [0.0, 1.0]])
    print("B 的迹 =", np.trace(B), "，特征值 =", np.linalg.eigvals(B))

    # 反号：A 稳定，-A 就爆炸
    A = np.array([[-1.0, 2.0], [1.0, -2.0]])
    print("A 的特征值：", np.linalg.eigvals(A))
    print("-A 的特征值：", np.linalg.eigvals(-A))

    # 2 x 2 判据：迹 < 0 且 行列式 > 0，等价于两个实部都为负
    count = 20000
    agree = 0
    stable = 0
    for _ in range(count):
        M = rng.standard_normal((2, 2))
        by_eig = np.all(np.linalg.eigvals(M).real < 0)
        by_trace_det = np.trace(M) < 0 and np.linalg.det(M) > 0
        agree += int(by_eig == by_trace_det)
        stable += int(by_eig)
    print(f"随机 2 x 2 矩阵 {count} 个，两种判断一致：{agree} 个")
    print(f"其中稳定的占 {stable / count:.4f}")

    # 只看迹：1 / 2 的随机矩阵迹为负，但稳定的只有大约 1 / 4
    neg_trace = 0
    rng = np.random.default_rng(1806)
    for _ in range(count):
        M = rng.standard_normal((2, 2))
        neg_trace += int(np.trace(M) < 0)
    print(f"迹为负的占 {neg_trace / count:.4f}")


if __name__ == "__main__":
    main()
```

```text
t = 0.0：|e^(lam t)| = 1.0000，e^(-3t) = 1.0000
t = 0.5：|e^(lam t)| = 0.2231，e^(-3t) = 0.2231
t = 1.0：|e^(lam t)| = 0.0498，e^(-3t) = 0.0498
B 的迹 = -1.0 ，特征值 = [-2.  1.]
A 的特征值： [ 0. -3.]
-A 的特征值： [0. 3.]
随机 2 x 2 矩阵 20000 个，两种判断一致：20000 个
其中稳定的占 0.2463
迹为负的占 0.5040
```

$|e^{\lambda t}|$ 和 $e^{-3t}$ 在三个时刻一模一样，$t = 1$ 时都是 0.0498：虚部 6 一点贡献也没有。$B$ 的迹是 $-1$，特征值却是 $-2$ 和 $1$。$A$ 的特征值是 $0$ 和 $-3$，换成 $-A$ 就是 $0$ 和 $3$，和他说的“符号一变，稳定变爆炸”对得上，而 $0$ 还是 $0$，稳态那一项不受影响，只是另一项从 $e^{-3t}$ 变成了 $e^{3t}$。最关键的是 20000 个随机矩阵上，“迹 $< 0$ 且行列式 $> 0$”和“两个特征值实部都为负”一致 20000 次，没有一次例外。

另一个数字我觉得有意思：随机矩阵里迹为负的占 0.5040，大约一半，而真正稳定的只有 0.2463，大约四分之一。也就是说只看迹，会把稳定的数量高估一倍左右（我猜这就是他要补一个行列式条件的原因，当然这只是我的解读）。

稳定的区域画在复平面上，Strang 画了两个：对微分方程 $\mathrm{d}\mathbf{u}/\mathrm{d}t = A\mathbf{u}$，特征值要在左半平面，$\operatorname{Re}\lambda < 0$；对差分方程 $\mathbf{u}_{k+1} = A\mathbf{u}_k$（上一讲），特征值要在单位圆内，$|\lambda| < 1$。一个看实部，一个看模。

## 矩阵指数：把 Taylor 级数抄到矩阵上

解的形式是 $\mathbf{u}(t) = S e^{\Lambda t} S^{-1}\mathbf{u}(0)$，他的推导是：令 $\mathbf{u} = S\mathbf{v}$，代进 $\mathbf{u}' = A\mathbf{u}$ 得 $S\mathbf{v}' = AS\mathbf{v}$，左乘 $S^{-1}$ 得 $\mathbf{v}' = \Lambda\mathbf{v}$，也就是 $v_i' = \lambda_i v_i$，$n$ 个互不相干的标量方程。特征向量就是把耦合的方程组“解耦”的基，解是 $\mathbf{v}(t) = e^{\Lambda t}\mathbf{v}(0)$，再换回去。

那 $e^{At}$ 到底是什么？他回到最漂亮的 Taylor 级数：

$$
e^{At} = I + At + \frac{(At)^2}{2} + \frac{(At)^3}{6} + \cdots
= \sum_{n=0}^{\infty}\frac{(At)^n}{n!}
$$

然后把 $A = S\Lambda S^{-1}$ 代进去。$A^2 = S\Lambda^2 S^{-1}$，中间的 $S^{-1}S$ 抵消；把单位矩阵写成 $SS^{-1}$，左边提出一个 $S$，右边提出一个 $S^{-1}$，中间剩下 $I + \Lambda t + (\Lambda t)^2/2 + \cdots = e^{\Lambda t}$，一个对角矩阵，对角线上是 $e^{\lambda_1 t}, \dots, e^{\lambda_n t}$。所以

$$
e^{At} = S\, e^{\Lambda t}\, S^{-1}
$$

前提是 $A$ 可对角化（有 $n$ 个线性无关的特征向量），这一点他提醒了：不可对角化的矩阵就没有这个公式，那时只能变成三角形，之后再说（第 28 讲的 Jordan 标准形）。

他中间还有一段旁白：另一个“漂亮的 Taylor 级数”是不除阶乘的几何级数 $1 + x + x^2 + \cdots = 1/(1 - x)$，放到矩阵上是 $(I - At)^{-1} = I + At + (At)^2 + \cdots$。但这个级数要特征值的模小于 1 才收敛，而指数级数除了 $n!$，对任何矩阵、任何 $t$ 都收敛。这是指数的一点“特权”。

我把三种算法都写出来：特征分解、直接累加 Taylor 级数、缩放平方（把 $At$ 先除以 $2^s$ 使它足够小，Taylor 之后再平方 $s$ 次，利用 $e^{M} = (e^{M/2})^2$）。

```python
import numpy as np


def expm_eig(A: np.ndarray, t: float) -> np.ndarray:
    """用特征分解算 exp(At) = S exp(Lambda t) S^{-1}。"""
    lam, S = np.linalg.eig(A)
    return (S * np.exp(lam * t)) @ np.linalg.inv(S)


def expm_taylor(A: np.ndarray, t: float, terms: int = 60) -> np.ndarray:
    """直接累加 I + At + (At)^2/2! + ...，共 terms 项。"""
    n = A.shape[0]
    term = np.eye(n)
    total = np.eye(n)
    for k in range(1, terms):
        term = term @ (A * t) / k
        total = total + term
    return total


def expm_scaling(A: np.ndarray, t: float) -> np.ndarray:
    """缩放平方：先把 At 缩小 2^s 倍，Taylor 后再平方 s 次。"""
    B = A * t
    s = max(0, int(np.ceil(np.log2(max(np.linalg.norm(B, 1), 1e-16)))) + 1)
    E = expm_taylor(B / 2**s, 1.0, terms=20)
    for _ in range(s):
        E = E @ E
    return E


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[-1.0, 2.0], [1.0, -2.0]])

    # t = 1：三种方法互相对照
    E1 = expm_eig(A, 1.0)
    E2 = expm_taylor(A, 1.0)
    E3 = expm_scaling(A, 1.0)
    print("exp(A) =\n", E1)
    print(f"Taylor 与特征分解：{np.linalg.norm(E2 - E1):.2e}")
    print(f"缩放平方与特征分解：{np.linalg.norm(E3 - E1):.2e}")

    # Taylor 的项数：t = 1 时每多一项，误差掉多少
    for terms in (3, 6, 9, 12, 16):
        err = np.linalg.norm(expm_taylor(A, 1.0, terms) - E1)
        print(f"  Taylor {terms:2d} 项，误差 {err:.2e}")

    # t 很大时：Taylor 的项先涨到天文数字再被抵消
    t = 20.0
    ref = expm_eig(A, t)
    print("t = 20，exp(At) 的真值（极限）：\n", ref)
    err_taylor = np.linalg.norm(expm_taylor(A, t) - ref)
    err_scaling = np.linalg.norm(expm_scaling(A, t) - ref)
    print(f"  Taylor 60 项误差：{err_taylor:.2e}")
    print(f"  缩放平方误差：{err_scaling:.2e}")
    # exp(A(s+t)) = exp(As) exp(At)
    print(
        "exp(A * 3) = exp(A) @ exp(2A)：",
        np.allclose(expm_eig(A, 3.0), E1 @ expm_eig(A, 2.0)),
    )


if __name__ == "__main__":
    main()
```

```text
exp(A) =
 [[0.6833 0.6335]
 [0.3167 0.3665]]
Taylor 与特征分解：2.00e-16
缩放平方与特征分解：1.57e-16
  Taylor  3 项，误差 2.58e+00
  Taylor  6 项，误差 7.38e-01
  Taylor  9 项，误差 4.38e-02
  Taylor 12 项，误差 9.48e-04
  Taylor 16 项，误差 1.84e-06
t = 20，exp(At) 的真值（极限）：
 [[0.6667 0.6667]
 [0.3333 0.3333]]
  Taylor 60 项误差：3.11e+24
  缩放平方误差：1.05e-15
exp(A * 3) = exp(A) @ exp(2A)： True
```

$t = 1$ 的时候三种方法一致：Taylor 级数和特征分解差 2.00e-16，缩放平方差 1.57e-16，都在机器精度上。Taylor 的收敛速度也能读出来：3 项误差 2.58，6 项 0.738，12 项 9.48e-04，16 项 1.84e-06，项数越多，每多一项误差降得越快：从 12 项到 16 项，误差降了大约 500 倍。

接着看 $t = 20$。$e^{At}$ 此时应该已经是极限矩阵（两列都是 $(2/3, 1/3)$），Taylor 级数 60 项却给出 3.11e+24 的误差。原因：$\|At\|$ 约为 63，$(At)^n/n!$ 的项要到 $n \approx 60$ 才到峰值（约 $10^{25}$），60 项根本没加完，截断误差就是 $10^{24}$ 量级；项数再加多，一正一负的大数相减又会丢光有效数字。（Strang 说的“级数总是收敛”是数学上的事，“数值上好算”是另一回事。我猜这就是没人真的用定义来写 `expm` 的原因。）缩放平方只差 1.05e-15，仍然在机器精度上。（“60 项总够了吧”是我写这段代码时的想法，事实证明这是个糟糕的想法。）如果要把 $e^{At}$ 当成工具来用，我会直接调现成的矩阵指数函数，自己手写这三种只是为了知道它里面发生了什么。

最后一行验证了 $e^{A\cdot 3} = e^{A}e^{2A}$，这条规则对一个矩阵的指数成立，$e^{At}e^{As} = e^{A(t+s)}$，和标量指数一样。（对两个不同的矩阵 $e^{A}e^{B} \ne e^{A+B}$，一般不成立，这里不用管。）

## 二阶方程变成一阶方程组

最后一个例子，他用的是和 Fibonacci 一样的技巧。一个二阶方程 $y'' + by' + ky = 0$，加一条平凡的方程 $y' = y'$，令 $\mathbf{u} = (y', y)$，则

$$
\frac{\mathrm{d}}{\mathrm{d}t}\begin{bmatrix} y' \\ y \end{bmatrix}
= \begin{bmatrix} -b & -k \\ 1 & 0 \end{bmatrix}
\begin{bmatrix} y' \\ y \end{bmatrix}
$$

第一行是方程本身（$y'' = -by' - ky$），第二行是那条平凡的 $y' = y'$。（字幕里他写符号有些混乱，把 $y'' - by' - ky$ 当成了方程，这里我按 $y'' + by' + ky = 0$ 写，得到的就是上面的矩阵。）五阶方程就是 $5 \times 5$，第一行放系数，下面是一条斜线的 1。特征值“自然地”和微分方程联系在一起：这个矩阵的特征多项式正好就是 $\lambda^2 + b\lambda + k$。

下面的脚本取 $b = 0.4$、$k = 4$（阻尼很小的振子），把解和解析解对比，再做一个五阶的例子：多项式 $(s+1)(s+2)(s+3)(s+4)(s+5)$ 的伴随矩阵，特征值应该正好是 $-1$ 到 $-5$。

```python
import numpy as np


def companion(coeffs: np.ndarray) -> np.ndarray:
    """首项系数为 1 的多项式 -> 伴随矩阵：第一行是 -系数，下面是 1。"""
    n = len(coeffs) - 1
    C = np.zeros((n, n))
    C[0] = -coeffs[1:]
    C[1:, :-1] = np.eye(n - 1)
    return C


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # y'' + b y' + k y = 0，令 u = (y', y)，则 u' = A u
    b, k = 0.4, 4.0
    A = companion(np.array([1.0, b, k]))
    print("A =\n", A)
    print("特征值：", np.linalg.eigvals(A))
    print("特征多项式 s^2 + b s + k 的根：", np.roots([1.0, b, k]))

    # 初值 y(0) = 1，y'(0) = 0：用特征分解算 u(t) = exp(At) u(0)
    u0 = np.array([0.0, 1.0])
    lam, S = np.linalg.eig(A)
    c = np.linalg.solve(S, u0)
    w = np.sqrt(k - b**2 / 4)
    worst = 0.0
    for t in np.linspace(0.0, 10.0, 101):
        u = (S @ (c * np.exp(lam * t))).real
        y = np.exp(-b * t / 2) * (np.cos(w * t) + b / (2 * w) * np.sin(w * t))
        worst = max(worst, abs(u[1] - y))
    print(f"101 个时刻上，与解析解 y(t) 的最大差：{worst:.2e}")

    # 五阶：(s+1)(s+2)(s+3)(s+4)(s+5)，系数从根得到
    coeffs = np.poly([-1.0, -2.0, -3.0, -4.0, -5.0])
    C = companion(coeffs)
    print("五阶多项式系数：", coeffs)
    print("5 x 5 伴随矩阵：\n", C)
    print("特征值：", np.sort(np.linalg.eigvals(C).real))


if __name__ == "__main__":
    main()
```

```text
A =
 [[-0.4 -4. ]
 [ 1.   0. ]]
特征值： [-0.2+1.99j -0.2-1.99j]
特征多项式 s^2 + b s + k 的根： [-0.2+1.99j -0.2-1.99j]
101 个时刻上，与解析解 y(t) 的最大差：3.33e-16
五阶多项式系数： [  1.  15.  85. 225. 274. 120.]
5 x 5 伴随矩阵：
 [[ -15.  -85. -225. -274. -120.]
 [   1.    0.    0.    0.    0.]
 [   0.    1.    0.    0.    0.]
 [   0.    0.    1.    0.    0.]
 [   0.    0.    0.    1.    0.]]
特征值： [-5. -4. -3. -2. -1.]
```

$A$ 的特征值是 $-0.2 \pm 1.99i$，和多项式的根一样。用特征分解算出的 $y(t)$ 与解析解 $e^{-bt/2}\left(\cos\omega t + \tfrac{b}{2\omega}\sin\omega t\right)$ 在 101 个时刻上最大只差 3.33e-16。实部 $-0.2$ 管衰减，虚部 $1.99$ 管振荡，和上一节讲的一致，右边那幅相平面图里的螺旋就是它。五阶的情形，伴随矩阵的特征值回到 $-1, \dots, -5$，系数 `[1, 15, 85, 225, 274, 120]` 就是展开后的多项式。

## 在控制里

控制里的状态方程 $\dot{\mathbf{x}} = A\mathbf{x} + B\mathbf{u}$ 就是这一讲的方程再加一个输入。没有输入时 $\mathbf{x}(t) = e^{At}\mathbf{x}(0)$，系统的“极点”就是 $A$ 的特征值，稳定性判据是所有极点在左半平面，也就是本讲第二节的结论。二阶方程变成一阶方程组的那一步，换个名字就是“把传递函数里的高阶微分方程写成状态空间形式”。相关的背景可以看 [传递函数那一篇](/posts/pid-control-02-transfer-functions/)。

LQR 在这个基础上选反馈 $\mathbf{u} = -K\mathbf{x}$，闭环矩阵 $A - BK$ 的特征值就是闭环极点，设计 $K$ 的过程就是在移动这些特征值，我把它放在 [LQR 那一篇](/posts/pid-control-09-lqr/)里讲。顺便一提，数字控制器是离散的，这时稳定区域从左半平面换成单位圆内部，也就是上一讲的 $|\lambda| < 1$。

## 下一步

这一讲留了一个小线索：零特征值带来稳态，而且总量不变。下一讲 Strang 用 Markov 矩阵（特征值 1 的离散版）把这件事讲清楚，再加上 Fourier 级数，见 [18.06 第 24 讲：Markov 矩阵与 Fourier 级数](/posts/linear-algebra-24-markov-fourier/)。
