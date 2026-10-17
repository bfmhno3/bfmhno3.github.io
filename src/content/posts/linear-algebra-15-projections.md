---
title: "18.06 第 15 讲：投影到子空间"
commentId: "post:linear-algebra-15-projections"
published: "2026-10-18 12:40:00 +08:00"
description: "MIT 18.06 第 15 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 把 b 投影到一条直线和一个二维列空间上，验证 P² = P 与 Pᵀ = P，再在平面里随机撒 10 万个点，离 b 最近的也有 0.4085，比投影点的 0.4082 远。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 投影
  - 正规方程
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 15
draft: false
comment: true
slug: linear-algebra-15-projections
---

这一讲的核心是一个很朴素的问题：$A\mathbf{x} = \mathbf{b}$ 没有解的时候，$A$ 的列空间里离 $\mathbf{b}$ 最近的点在哪里。Strang 的答案是，找到那个点 $\mathbf{p}$，使得误差 $\mathbf{e} = \mathbf{b} - \mathbf{p}$ 垂直于列空间，由此得到 $A^\mathsf{T}A\hat{\mathbf{x}} = A^\mathsf{T}\mathbf{b}$。我在他的三点例子上算了一遍：投影点到 $\mathbf{b}$ 的距离是 0.4082，我在平面里随机撒了 10 万个点，离 $\mathbf{b}$ 最近的一个也有 0.4085，没有一个能赢过它。

> [!NOTE] 本讲速览
> 视频：[Lecture 15: Projections onto subspaces](https://www.youtube.com/watch?v=Y_Ac6KiQ1t0)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-15-projections-onto-subspaces/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §4.2 Projections onto Lines and Subspaces
> 前置：[第 14 讲：正交向量与正交子空间](/posts/linear-algebra-14-orthogonal-subspaces/)
> 一句话：投影点 $\mathbf{p} = A\hat{\mathbf{x}}$ 由“误差垂直于列空间”这一个条件决定，投影矩阵是 $P = A(A^\mathsf{T}A)^{-1}A^\mathsf{T}$，它对称，而且 $P^2 = P$。

> [!TIP] 配合视频
> - 他先花了一整块黑板只讲投影到一条直线上，这一段是全讲的骨架，值得认真看。他问“$\mathbf{b}$ 翻倍怎么样，$\mathbf{a}$ 翻倍怎么样”的那几分钟也有用，本篇用代码算了一遍，看完可以对照。
> - “$P$ 是对称的，$P^2 = P$”那一段要认真听。他说这两条性质合起来就是投影矩阵的全部身份。
> - 他想把 $(A^\mathsf{T}A)^{-1}$ 拆成两个逆的乘积、又自己叫停的那一段很短，本篇有一个小实验，看一眼即可。
> - 最后几分钟是三个点的拟合问题，他只列出方程，没有解。数值例子在下一讲，本篇只在最后用代码做了一次预演。

## 先投影到一条直线上

**最近的点在哪里？** Strang 从二维开始：一条过原点的直线，方向是 $\mathbf{a}$；直线外有一个向量 $\mathbf{b}$。直线上离 $\mathbf{b}$ 最近的点记作 $\mathbf{p}$，连接 $\mathbf{b}$ 与 $\mathbf{p}$ 的误差向量 $\mathbf{e} = \mathbf{b} - \mathbf{p}$ 就是垂线。他提了一句，如果用三角函数，会出现 $\theta$、$\sin\theta$、$\cos\theta$，公式很难看；线性代数能让这些都不出现。

条件只有两个：$\mathbf{p}$ 在直线上，所以 $\mathbf{p} = x\mathbf{a}$，$x$ 是个待求的数；误差垂直于 $\mathbf{a}$，所以

$$
\mathbf{a}^\mathsf{T}(\mathbf{b} - x\mathbf{a}) = 0
\quad\Longrightarrow\quad
x\,\mathbf{a}^\mathsf{T}\mathbf{a} = \mathbf{a}^\mathsf{T}\mathbf{b}
\quad\Longrightarrow\quad
x = \frac{\mathbf{a}^\mathsf{T}\mathbf{b}}{\mathbf{a}^\mathsf{T}\mathbf{a}}
$$

$\mathbf{a}^\mathsf{T}\mathbf{a}$ 是一个数（$\mathbf{a}$ 的长度平方），可以直接除。于是投影是

$$
\mathbf{p} = \mathbf{a}\,\frac{\mathbf{a}^\mathsf{T}\mathbf{b}}{\mathbf{a}^\mathsf{T}\mathbf{a}}
= \underbrace{\frac{\mathbf{a}\mathbf{a}^\mathsf{T}}{\mathbf{a}^\mathsf{T}\mathbf{a}}}_{P}\,\mathbf{b}
$$

他强调的是括号放在哪里：把数 $x$ 放在 $\mathbf{a}$ 右边，括号换个位置，$\mathbf{b}$ 前面站着的就是一个矩阵。分子 $\mathbf{a}\mathbf{a}^\mathsf{T}$ 是列乘行，是一个 $n \times n$ 矩阵，分母仍然是一个数。我用他的“字母”配一组数字：$\mathbf{a} = (2, 1)$，$\mathbf{b} = (1, 2)$。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    a = np.array([2.0, 1.0])
    b = np.array([1.0, 2.0])

    # 一维：x = aᵀb / aᵀa，p = a x，误差 e = b - p 与 a 垂直
    x = (a @ b) / (a @ a)
    p = a * x
    e = b - p
    print("x =", x, " p =", p, " e =", e)
    print("aᵀe 等于 0：", np.isclose(a @ e, 0.0))

    # P = a aᵀ / aᵀa 是一个 2 x 2 矩阵，不是数
    P = np.outer(a, a) / (a @ a)
    print("P =")
    print(P)
    print("P @ b 等于 p：", np.allclose(P @ b, p))

    # b 翻倍，投影翻倍；a 翻倍或变号，投影不变
    for name, P_new, b_new in [
        ("2b", P, 2 * b),
        ("2a", np.outer(2 * a, 2 * a) / ((2 * a) @ (2 * a)), b),
        ("-a", np.outer(-a, -a) / ((-a) @ (-a)), b),
    ]:
        print(name, "的投影：", P_new @ b_new)

    # P 的三条性质
    print("秩：", np.linalg.matrix_rank(P))
    print("P.T 等于 P：", np.allclose(P.T, P))
    print("P @ P 等于 P：", np.allclose(P @ P, P))


if __name__ == "__main__":
    main()
```

```text
x = 0.8  p = [1.6 0.8]  e = [-0.6  1.2]
aᵀe 等于 0： True
P =
[[0.8 0.4]
 [0.4 0.2]]
P @ b 等于 p： True
2b 的投影： [3.2 1.6]
2a 的投影： [1.6 0.8]
-a 的投影： [1.6 0.8]
秩： 1
P.T 等于 P： True
P @ P 等于 P： True
```

$x = 0.8$，$\mathbf{p} = (1.6, 0.8)$，误差 $\mathbf{e} = (-0.6, 1.2)$ 与 $\mathbf{a}$ 的点积为零。这一步的所有判断都用 `np.isclose`，因为 $2 \times (-0.6) + 1 \times 1.2$ 在浮点数里剩下一个 $10^{-16}$ 量级的尾巴，直接打印出来很难看。

三个“问题”的答案和他在黑板上说的一致：$\mathbf{b}$ 变成 $2\mathbf{b}$，投影从 $(1.6, 0.8)$ 变成 $(3.2, 1.6)$，也翻倍；$\mathbf{a}$ 变成 $2\mathbf{a}$ 或 $-\mathbf{a}$，投影一点没变，因为直线没变，分子分母各多出来的因子 4 和 $(-1)^2$ 抵消了。

$P$ 的性质他列了三条，我也一并验证：

- 列空间是那条直线，所以秩是 1。它就是“一列乘一行”，也就是第 11 讲里的秩 1 矩阵。
- $P^\mathsf{T} = P$：转置 $\mathbf{a}\mathbf{a}^\mathsf{T}$ 还是 $\mathbf{a}\mathbf{a}^\mathsf{T}$，分母是个数，不受影响。
- $P^2 = P$：投影一次已经落在直线上，再投影原地不动。

他说“对称，且平方等于自己”这两条合起来，就是投影矩阵的全部特征。我没有去查这个说法的严格表述，但这里的 $P$ 两条都满足，这个证据对我够用。

下面的图把这一节和后面的例子放在一起：左边就是这一节的数，$\mathbf{e}$ 与直线之间那个小方块是直角。

![左：b = (1, 2) 投影到过 a = (2, 1) 的直线，p = (1.6, 0.8)，误差 e 与直线垂直。右：三个点 (1, 1)、(2, 2)、(3, 2) 的纵坐标 b 投影到 A 的列空间，得到直线上的三个点 p](/assets/images/linear-algebra/l15-projection.svg)

上面这张图由下面这个脚本生成（需要 matplotlib，在当前目录写出 SVG；图中的数据与前面的代码块相同）：

```python
import matplotlib
import matplotlib.pyplot as plt
import numpy as np


def main() -> None:
    matplotlib.use("Agg")
    plt.rcParams["svg.hashsalt"] = "la1806"

    fig = plt.figure(figsize=(10, 4))

    # 左：投影到直线（与 block1 同一组数）
    ax1 = fig.add_subplot(1, 2, 1)
    a = np.array([2.0, 1.0])
    b = np.array([1.0, 2.0])
    p = a * (a @ b) / (a @ a)
    e = b - p
    t = np.linspace(-0.5, 3.0, 2)
    ax1.plot(t * a[0], t * a[1], color="gray", lw=1, label="line through a")
    ax1.annotate(
        "",
        xy=a,
        xytext=(0, 0),
        arrowprops=dict(arrowstyle="->", color="tab:blue"),
    )
    ax1.annotate(
        "",
        xy=b,
        xytext=(0, 0),
        arrowprops=dict(arrowstyle="->", color="tab:red"),
    )
    ax1.annotate(
        "",
        xy=p,
        xytext=(0, 0),
        arrowprops=dict(arrowstyle="->", color="tab:green", lw=2),
    )
    ax1.plot([p[0], b[0]], [p[1], b[1]], "k--", lw=1)
    ax1.text(a[0] + 0.05, a[1] - 0.15, "a = (2, 1)", color="tab:blue")
    ax1.text(b[0] - 0.55, b[1] + 0.08, "b = (1, 2)", color="tab:red")
    ax1.text(p[0] + 0.05, p[1] - 0.2, "p = (1.6, 0.8)", color="tab:green")
    ax1.text(0.9, 1.35, "e", fontsize=12)
    s = 0.12
    u = a / np.linalg.norm(a)
    v = e / np.linalg.norm(e)
    ax1.plot(
        [p[0] - s * u[0], p[0] - s * u[0] + s * v[0], p[0] + s * v[0]],
        [p[1] - s * u[1], p[1] - s * u[1] + s * v[1], p[1] + s * v[1]],
        color="k",
        lw=0.8,
    )
    ax1.set_xlim(-0.3, 3.0)
    ax1.set_ylim(-0.3, 2.4)
    ax1.set_aspect("equal")
    ax1.set_title("projection onto a line")

    # 右：三个点的拟合（与 block2 同一组数）
    ax2 = fig.add_subplot(1, 2, 2)
    A = np.array([[1.0, 1.0], [1.0, 2.0], [1.0, 3.0]])
    bb = np.array([1.0, 2.0, 2.0])
    xh = np.linalg.solve(A.T @ A, A.T @ bb)
    pp = A @ xh
    tt = A[:, 1]
    tl = np.linspace(0.5, 3.5, 2)
    ax2.plot(tl, xh[0] + xh[1] * tl, color="tab:green", lw=1.5)
    for ti, bi, pi in zip(tt, bb, pp):
        ax2.plot([ti, ti], [bi, pi], "k--", lw=1)
    ax2.plot(tt, bb, "o", color="tab:red", label="b = (1, 2, 2)")
    ax2.plot(tt, pp, "s", color="tab:green", label="p = A x_hat")
    ax2.legend(loc="upper left")
    ax2.set_xlabel("t")
    ax2.set_ylabel("height")
    ax2.set_xlim(0.5, 3.5)
    ax2.set_ylim(0.5, 2.8)
    ax2.set_title("b projected onto the column space of A")

    fig.tight_layout()
    fig.savefig(
        "l15-projection.svg",
        metadata={"Date": None},
    )


if __name__ == "__main__":
    main()
```

## 投影到一个子空间上

**直线换成平面，该怎么办？** 他先说为什么要关心投影：$A\mathbf{x} = \mathbf{b}$ 的方程比未知数多，多半无解。$A\mathbf{x}$ 永远落在 $A$ 的列空间里，而 $\mathbf{b}$ 大概率不在，所以退一步，解一个能解的问题：把 $\mathbf{b}$ 换成列空间里最近的那个向量 $\mathbf{p}$，解 $A\hat{\mathbf{x}} = \mathbf{p}$。$\hat{\mathbf{x}}$ 头上那顶小帽子，是用来提醒自己它不是那个不存在的 $\mathbf{x}$。

平面怎么描述？给两个线性无关的向量 $\mathbf{a}_1$、$\mathbf{a}_2$ 当基，它们不必垂直，但必须无关。把它们作为列拼成 $A$，这个平面就是 $A$ 的列空间，之后的公式都用 $A$ 写出来，两列还是 $n$ 列都不用改。

投影 $\mathbf{p}$ 是列的组合，$\mathbf{p} = A\hat{\mathbf{x}}$，问题变成找 $\hat{\mathbf{x}}$。条件仍然是误差垂直：$\mathbf{e} = \mathbf{b} - A\hat{\mathbf{x}}$ 垂直于平面，所以垂直于 $\mathbf{a}_1$，也垂直于 $\mathbf{a}_2$：

$$
\begin{aligned}
\mathbf{a}_1^\mathsf{T}(\mathbf{b} - A\hat{\mathbf{x}}) &= 0 \\
\mathbf{a}_2^\mathsf{T}(\mathbf{b} - A\hat{\mathbf{x}}) &= 0
\end{aligned}
\qquad\Longrightarrow\qquad
A^\mathsf{T}(\mathbf{b} - A\hat{\mathbf{x}}) = \mathbf{0}
$$

两个方程叠起来，恰好就是 $A^\mathsf{T}$（第一行是 $\mathbf{a}_1^\mathsf{T}$，第二行是 $\mathbf{a}_2^\mathsf{T}$）乘以误差等于零。一条直线时 $A$ 只有一列，这个方程退回到上一节的 $\mathbf{a}^\mathsf{T}\mathbf{e} = 0$。

他接着做了一件我觉得很漂亮的事：把这个方程放回第 14 讲的四个子空间里。$A^\mathsf{T}\mathbf{e} = \mathbf{0}$ 说的是 $\mathbf{e}$ 在 $A^\mathsf{T}$ 的零空间里，也就是左零空间，它和列空间正交。他在黑板上说，推导出来的方程恰好说出了他想要的几何，这很舒服。

整理方程，得到三个要记的公式：

$$
A^\mathsf{T}A\hat{\mathbf{x}} = A^\mathsf{T}\mathbf{b},\qquad
\hat{\mathbf{x}} = (A^\mathsf{T}A)^{-1}A^\mathsf{T}\mathbf{b},\qquad
\mathbf{p} = A\hat{\mathbf{x}},\qquad
P = A(A^\mathsf{T}A)^{-1}A^\mathsf{T}
$$

对照一维：$\mathbf{a}^\mathsf{T}\mathbf{a}$ 是个数，可以直接除；$A^\mathsf{T}A$ 是矩阵，只能写成逆。公式的形状没变。

下面我用他最后一个例子里的矩阵。三个点 $(1, 1)$、$(2, 2)$、$(3, 2)$，想让直线 $b = C + Dt$ 穿过它们，方程是

$$
\begin{bmatrix} 1 & 1 \\ 1 & 2 \\ 1 & 3 \end{bmatrix}
\begin{bmatrix} C \\ D \end{bmatrix}
= \begin{bmatrix} 1 \\ 2 \\ 2 \end{bmatrix}
$$

三个方程两个未知数，无解。$A$ 的两列张成三维空间里的一个平面，$\mathbf{b} = (1, 2, 2)$ 在平面外，正好是用来练习投影的材料：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 三个点 (1, 1)、(2, 2)、(3, 2)，想解 C + D t = b 但解不了
    A = np.array([[1.0, 1.0], [1.0, 2.0], [1.0, 3.0]])
    b = np.array([1.0, 2.0, 2.0])

    # 正规方程 AᵀA x = Aᵀb
    x_hat = np.linalg.solve(A.T @ A, A.T @ b)
    p = A @ x_hat
    e = b - p
    print("x_hat =", x_hat)
    print("p =", p)
    print("e =", e)
    print("Aᵀe 等于 0：", np.allclose(A.T @ e, 0.0))

    # 投影矩阵 P = A (AᵀA)⁻¹ Aᵀ
    P = A @ np.linalg.inv(A.T @ A) @ A.T
    print("P =")
    print(P)
    print("P @ b 等于 p：", np.allclose(P @ b, p))
    print("秩：", np.linalg.matrix_rank(P), "，迹：", round(np.trace(P), 6))
    print("P.T 等于 P：", np.allclose(P.T, P))
    print("P @ P 等于 P：", np.allclose(P @ P, P))
    print("P @ p 等于 p：", np.allclose(P @ p, p))

    # e 在 Aᵀ 的零空间里：Aᵀ 是 2 x 3，零空间由最后一个右奇异向量张成
    _, _, Vt = np.linalg.svd(A.T)
    n = Vt[-1]
    print("零空间基向量 n =", n)
    print("e 平行于 n：", np.allclose(np.cross(e, n), 0))

    # 与 lstsq 对照
    x_lstsq, *_ = np.linalg.lstsq(A, b, rcond=None)
    print("lstsq 的解一致：", np.allclose(x_hat, x_lstsq))


if __name__ == "__main__":
    main()
```

```text
x_hat = [0.6667 0.5   ]
p = [1.1667 1.6667 2.1667]
e = [-0.1667  0.3333 -0.1667]
Aᵀe 等于 0： True
P =
[[ 0.8333  0.3333 -0.1667]
 [ 0.3333  0.3333  0.3333]
 [-0.1667  0.3333  0.8333]]
P @ b 等于 p： True
秩： 2 ，迹： 2.0
P.T 等于 P： True
P @ P 等于 P： True
P @ p 等于 p： True
零空间基向量 n = [ 0.4082 -0.8165  0.4082]
e 平行于 n： True
lstsq 的解一致： True
```

读一下这份输出：

- $\hat{\mathbf{x}} = (2/3, 1/2)$，投影点 $\mathbf{p} = (7/6, 5/3, 13/6)$，误差 $\mathbf{e} = (-1/6, 1/3, -1/6)$。$A^\mathsf{T}\mathbf{e} = \mathbf{0}$ 成立。
- $P$ 是 $3 \times 3$ 的，秩是 2（列空间是平面，二维），$P^\mathsf{T} = P$，$P^2 = P$ 都成立。多补了一行 $P\mathbf{p} = \mathbf{p}$：投影点已经在平面上，再投影不动。
- 迹是 2.0，等于秩。我没有在字幕里看到他说这件事，这是我顺手打印的，下一节的随机矩阵里它也成立，我猜这是投影矩阵的一般性质（据我所知，投影矩阵的特征值只有 0 和 1，迹就是 1 的个数，也就是秩）。
- $\mathbf{e}$ 的方向和 $A^\mathsf{T}$ 的零空间基向量 $\mathbf{n}$ 平行，确认了 $\mathbf{e}$ 在左零空间里，和他在黑板上的话对得上。
- `np.linalg.lstsq` 给出了同一个 $\hat{\mathbf{x}}$。它做的是同一件事，只是据我所知它内部用的是 SVD，不去解 $A^\mathsf{T}A$（$A^\mathsf{T}A$ 的条件数是 $A$ 的平方，数值上不划算）。

$\hat{\mathbf{x}} = (2/3, 1/2)$ 就是这三个点的最佳直线 $b = \frac23 + \frac12 t$ 的系数。Strang 说下一讲才算数值例子，我这里提前把结果打印出来了（图右半边画的就是它）：三个红点是 $\mathbf{b}$，绿方块是 $\mathbf{p}$，虚线是 $\mathbf{e}$ 的三个分量。

## 公式里藏着的几个问题

**为什么不能把逆拆开？** 他在黑板上写完 $P = A(A^\mathsf{T}A)^{-1}A^\mathsf{T}$ 之后，立刻动了一个念头：乘积的逆等于逆的乘积反过来，那 $(A^\mathsf{T}A)^{-1} = A^{-1}(A^\mathsf{T})^{-1}$，代进去全部抵消，$P = I$。他的原话大意是，这件事要上录像了，我写在这里，你们别太认真看。（当场写了错的，然后自己叫停，我觉得这是整门课里很可爱的一段。）

错在哪里：$A$ 是 $3 \times 2$ 的，不是方阵，没有逆。而 $A^\mathsf{T}A$ 是 $2 \times 2$ 的方阵，有逆。反过来，如果 $A$ 本身是可逆方阵，列空间是整个空间，投影到整个空间当然是单位矩阵，这时拆开是合法的。这两件事我都让 NumPy 验证了。

另外两件事也一起验证：我在平面里随机撒点，看没有任何一个点离 $\mathbf{b}$ 更近；我又换一个 $50 \times 5$ 的随机矩阵，看对称和幂等不是三阶小矩阵的巧合。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)
    A = np.array([[1.0, 1.0], [1.0, 2.0], [1.0, 3.0]])
    b = np.array([1.0, 2.0, 2.0])
    P = A @ np.linalg.inv(A.T @ A) @ A.T
    p = P @ b
    dist = np.linalg.norm(b - p)

    # 1. 平面里随机取 100000 个点，没有一个比 p 离 b 更近
    coeffs = rng.standard_normal((100_000, 2)) * 2.0
    others = coeffs @ A.T
    dists = np.linalg.norm(others - b, axis=1)
    print(f"p 到 b 的距离：{dist:.4f}")
    print(f"随机点到 b 的最小距离：{dists.min():.4f}")
    print("p 确实最近：", bool(np.all(dists >= dist - 1e-12)))

    # 2. 想把 (AᵀA)⁻¹ 拆成 A⁻¹ (Aᵀ)⁻¹，A 不是方阵，拆不了
    try:
        np.linalg.inv(A)
    except np.linalg.LinAlgError as err:
        print("inv(A) 失败：", err)

    # 3. A 是可逆方阵时，列空间是整个空间，P 就是单位矩阵
    S = np.array([[2.0, -1.0, 0.0], [-1.0, 2.0, -1.0], [0.0, -1.0, 2.0]])
    P_full = S @ np.linalg.inv(S.T @ S) @ S.T
    print("S 可逆时 P 等于 I：", np.allclose(P_full, np.eye(3)))

    # 4. 更高维：50 x 5 的随机 A，P 仍然是对称幂等，迹等于秩
    M = rng.standard_normal((50, 5))
    Q = M @ np.linalg.inv(M.T @ M) @ M.T
    print("‖Q - Qᵀ‖ =", f"{np.linalg.norm(Q - Q.T):.2e}")
    print("‖Q @ Q - Q‖ =", f"{np.linalg.norm(Q @ Q - Q):.2e}")
    print("迹 =", round(float(np.trace(Q)), 6))


if __name__ == "__main__":
    main()
```

```text
p 到 b 的距离：0.4082
随机点到 b 的最小距离：0.4085
p 确实最近： True
inv(A) 失败： Last 2 dimensions of the array must be square
S 可逆时 P 等于 I： True
‖Q - Qᵀ‖ = 3.76e-16
‖Q @ Q - Q‖ = 6.52e-16
迹 = 5.0
```

四行输出，四个结论：

- 平面上 10 万个随机点，最近的离 $\mathbf{b}$ 是 0.4085，投影点是 0.4082，投影点赢。差距只有 0.0003，是因为随机点已经撒得够密，恰好有一个落在投影点附近（这当然不说明投影“只比随机略好”，要是只撒 100 个点，差距会大得多）。
- `np.linalg.inv(A)` 直接抛出 `LinAlgError`，原话是“最后两个维度必须是方阵”。
- 可逆方阵 $S$ 的 $P$ 等于 $I$，和他说的一致。
- $50 \times 5$ 的随机矩阵上，$\|P^\mathsf{T} - P\|$ 是 $3.76 \times 10^{-16}$，$\|P^2 - P\|$ 是 $6.52 \times 10^{-16}$，都在双精度的舍入误差量级，迹恰好是 5，等于列数，也等于秩。

**为什么随机点永远赢不了？** 这不是运气，是勾股定理。平面里任取一点 $\mathbf{q}$，$\mathbf{b} - \mathbf{q} = \mathbf{e} + (\mathbf{p} - \mathbf{q})$，其中 $\mathbf{e}$ 垂直于平面，$\mathbf{p} - \mathbf{q}$ 在平面里，两者垂直，所以 $\|\mathbf{b} - \mathbf{q}\|^2 = \|\mathbf{e}\|^2 + \|\mathbf{p} - \mathbf{q}\|^2 \ge \|\mathbf{e}\|^2$，等号只在 $\mathbf{q} = \mathbf{p}$ 时成立。用上面的数手算一遍：$\|\mathbf{b}\|^2 = 1 + 4 + 4 = 9$，$\|\mathbf{p}\|^2 = 53/6$，$\|\mathbf{e}\|^2 = 1/6$，两者之和恰好是 9，同样是勾股，$1/6$ 开方就是 0.4082。这也解释了为什么一维、二维、$n$ 维的推导可以用同一个条件：只要误差垂直，剩下的都是勾股。

顺便一提一个类比：这像太阳在头顶正上方时的影子。影子是物体投到地面上的点，光线垂直于地面，这就是“误差垂直于子空间”。影子一旦落在地上，再来一次，它还是在原地，这就是 $P^2 = P$。（我只用这一个类比，再讲下去就要开始解释太阳的位置了。）

## 什么时候 $A^\mathsf{T}A$ 可逆

**公式里的逆什么时候存在？** 他没有在这一讲停下来讨论，我顺手补一句。这个例子里 $A$ 的两列线性无关，$A^\mathsf{T}A = \begin{bmatrix} 3 & 6 \\ 6 & 14 \end{bmatrix}$ 可逆，一切顺利。如果两列线性相关，$A^\mathsf{T}A$ 就奇异，$\hat{\mathbf{x}}$ 不唯一。“$A^\mathsf{T}A$ 可逆当且仅当 $A$ 的列线性无关”这个结论在第 14 讲已经备好，这里是它第一次真正派上用场。

下一讲他说会把今天只写了字母的这些东西算成数，从三个点的拟合接着做下去，见 [18.06 第 16 讲：投影矩阵与最小二乘](/posts/linear-algebra-16-least-squares/)。我猜他也不会再写“eight a's in a row”那样的矩阵了。
