---
title: "18.06 第 21 讲：特征值与特征向量"
commentId: "post:linear-algebra-21-eigenvalues-eigenvectors"
published: "2026-10-18 14:40:00 +08:00"
description: "MIT 18.06 第 21 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 算了投影、置换、旋转和三角矩阵的特征值，90 度旋转矩阵的特征值是 ±i，而 [[3, 1], [0, 3]] 的特征向量矩阵条件数高达 3.00e+15。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 特征值
  - 特征向量
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 21
draft: false
comment: true
slug: linear-algebra-21-eigenvalues-eigenvectors
---

这一讲要找的是一类特殊的向量：矩阵 $A$ 乘上去以后，方向不变，只是被拉长或压短。一般的向量做不到，但 $\begin{bmatrix} 3 & 1 \\ 1 & 3 \end{bmatrix}$ 有两条这样的直线，沿 $(1, 1)$ 放大 4 倍，沿 $(-1, 1)$ 放大 2 倍，迹 6 和行列式 8 恰好就是这两个倍数的和与积。我把 Strang 黑板上的几个矩阵逐个交给 NumPy：一个旋转矩阵没有任何实特征向量，一个三角矩阵的两个特征向量被压成了同一条线，后者的特征向量矩阵条件数是 $3.00 \times 10^{15}$。

> [!NOTE] 本讲速览
> 视频：[Lecture 21: Eigenvalues and eigenvectors](https://www.youtube.com/watch?v=cdZnhQjJu4I)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-21-eigenvalues-and-eigenvectors/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §6.1 Introduction to Eigenvalues : Ax = λx
> 前置：[第 20 讲：Cramer 法则、逆矩阵与体积](/posts/linear-algebra-20-cramer-inverse-volume/)
> 一句话：特征向量是满足 $A\mathbf{x} = \lambda\mathbf{x}$ 的非零向量，$\lambda$ 是使 $A - \lambda I$ 奇异的数，也就是 $\det(A - \lambda I) = 0$ 的根。

> [!TIP] 配合视频
> - 开头他先说这是特征值与特征向量这个大主题的第一讲，后面要占掉课程的大半。这一讲只回答“它们是什么”，“为什么要它们”留给后面，所以不必着急。
> - 投影矩阵和置换矩阵那两段（先猜答案，再回头验证）值得认真看：他在不写任何行列式的情况下，靠图和直觉把特征值说了出来。本篇第二节用代码算过一遍，看视频时可以快一点。
> - 他推导 $\det(A - \lambda I) = 0$ 和 $2 \times 2$ 例子的那段要认真听，特别是他指出“6 是迹，8 是行列式”的地方，这是这一讲里最容易用上的结论。
> - 旋转矩阵和三角矩阵两个“出问题”的例子在视频最后，本篇第四、五节有对应的数值。他说重复特征值是“18.06 里一切麻烦的来源”，这句话下一讲就会兑现。

## 方向不变的向量

**矩阵对向量做了什么？** Strang 的开场是这样的：矩阵 $A$ 像函数，微积分里放进去一个数 $x$，出来 $f(x)$；线性代数里放进去一个向量 $\mathbf{x}$，出来 $A\mathbf{x}$。大多数向量进去和出来的方向不一样。但有一些向量，出来的 $A\mathbf{x}$ 和进去的 $\mathbf{x}$ 平行，这些就是特征向量：

$$
A\mathbf{x} = \lambda\mathbf{x}
$$

“平行”被他放宽到包括方向相反（$\lambda$ 为负）和压成零（$\lambda = 0$）。这个倍数 $\lambda$ 叫特征值。$\lambda = 0$ 并没有什么特别：它说的是 $A\mathbf{x} = \mathbf{0}$，所以特征值为 0 的特征向量就是零空间里的非零向量，$A$ 奇异等价于 0 是它的一个特征值。这是前面几讲的旧账，现在换了个说法。

方程里 $\lambda$ 和 $\mathbf{x}$ 都未知，还乘在一起，消元派不上用场。他说需要一个好办法，那个办法要用到行列式。在讲办法之前，他先挑了几个“已经知道矩阵在干什么”的例子，看看答案长什么样。

先放一张图，把“方向不变”画出来。矩阵是后面要算的 $\begin{bmatrix} 3 & 1 \\ 1 & 3 \end{bmatrix}$，灰圈是单位圆上的所有 $\mathbf{x}$，蓝色椭圆是它们的像 $A\mathbf{x}$。黑色箭头是一个普通向量 $(1, 0)$ 和它的像 $(3, 1)$，方向转了；绿色和红色是两个特征向量，浅色是进去的，深色是出来的，同一条线上，只是长度变了。图里的 4 和 2 来自第三节的代码输出：

![特征向量方向不变：A 把 (1, 1) 方向拉长 4 倍，把 (-1, 1) 方向拉长 2 倍，普通向量 (1, 0) 被转向 (3, 1)](/assets/images/linear-algebra/l21-eigen-directions.svg)

上面这张图由下面这个脚本生成（需要 matplotlib，在当前目录写出 SVG；图中的数据与前面的代码块相同）：

```python
import matplotlib
import matplotlib.pyplot as plt
import numpy as np


def main() -> None:
    matplotlib.use("Agg")
    plt.rcParams["svg.hashsalt"] = "la1806"

    A = np.array([[3.0, 1.0], [1.0, 3.0]])
    values, vectors = np.linalg.eigh(A)

    theta = np.linspace(0.0, 2.0 * np.pi, 400)
    circle = np.vstack([np.cos(theta), np.sin(theta)])
    ellipse = A @ circle

    fig, ax = plt.subplots(figsize=(6, 4))
    ax.plot(*circle, color="0.6", lw=1.2, label="unit circle $x$")
    ax.plot(*ellipse, color="C0", lw=1.2, label="image $Ax$")

    arrow = dict(arrowstyle="-|>", lw=1.8, shrinkA=0, shrinkB=0)
    for lam, v, c in zip(values, vectors.T, ["C3", "C2"]):
        ax.annotate(
            "", xy=lam * v, xytext=(0, 0), arrowprops=dict(color=c, **arrow)
        )
        ax.annotate(
            "",
            xy=v,
            xytext=(0, 0),
            arrowprops=dict(color=c, alpha=0.5, **arrow),
        )
        ax.text(
            *(lam * v * 1.08),
            f"$\\lambda={lam:.0f}$",
            color=c,
            ha="center",
            va="center",
        )

    x = np.array([1.0, 0.0])
    ax.annotate(
        "", xy=A @ x, xytext=(0, 0), arrowprops=dict(color="k", **arrow)
    )
    ax.annotate(
        "", xy=x, xytext=(0, 0), arrowprops=dict(color="k", alpha=0.5, **arrow)
    )
    ax.text(*(A @ x + np.array([0.3, -0.45])), "$Ax$ turns", ha="left")

    ax.set_aspect("equal")
    ax.set_xlim(-4.6, 4.6)
    ax.set_ylim(-4.6, 4.6)
    ax.axhline(0, color="0.85", lw=0.6)
    ax.axvline(0, color="0.85", lw=0.6)
    ax.legend(loc="lower right", fontsize=8)
    fig.tight_layout()
    fig.savefig(
        "l21-eigen-directions.svg",
        metadata={"Date": None},
    )


if __name__ == "__main__":
    main()
```

椭圆的两条轴恰好落在两个特征向量的方向上。这是对称矩阵才有的整齐性质，第 25 讲会回来解释。

## 投影矩阵：先猜后验

**投影矩阵的特征值是多少？** 这是他的第一个问题。取三维空间里的一个平面，$P$ 把任意向量 $\mathbf{b}$ 投到平面上。$\mathbf{b}$ 本身不是特征向量，因为 $P\mathbf{b}$ 方向变了。什么向量投影之后方向不变？本来就在平面里的向量：$P\mathbf{x} = \mathbf{x}$，$\lambda = 1$。整个平面都是 $\lambda = 1$ 的特征向量。垂直于平面的向量被投成零：$P\mathbf{x} = \mathbf{0}$，$\lambda = 0$。三维空间里两个在平面里、一个垂直于平面，三个独立的特征向量，特征值是 1、1、0。

用代码验证。平面取 $M = \begin{bmatrix} 1 & 0 \\ 0 & 1 \\ 1 & 1 \end{bmatrix}$ 的两列张成的平面，投影矩阵 $P = M(M^\mathsf{T}M)^{-1}M^\mathsf{T}$ 是第 15 讲的内容，这里先当现成的用：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 投影到 R^3 里的一个平面：平面由 M 的两列张成
    M = np.array([[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]])
    P = M @ np.linalg.inv(M.T @ M) @ M.T
    print("P =")
    print(P)

    values, vectors = np.linalg.eig(P)
    order = np.argsort(-values)
    print("特征值：", values[order])

    # 平面里的向量原样不动，垂直于平面的向量被压成 0
    in_plane = 2.0 * M[:, 0] - 3.0 * M[:, 1]
    normal = np.array([1.0, 1.0, -1.0])
    print("M.T @ normal =", M.T @ normal)
    print("P @ in_plane == in_plane：", np.allclose(P @ in_plane, in_plane))
    print("P @ normal == 0：", np.allclose(P @ normal, 0.0))

    # 一个一般的 b：投影之后方向变了
    b = np.array([1.0, 2.0, 4.0])
    Pb = P @ b
    cosine = b @ Pb / (np.linalg.norm(b) * np.linalg.norm(Pb))
    print("b 与 Pb 的夹角余弦：", round(cosine, 4))

    # 每一对 (lambda, x) 都满足 A x = lambda x
    residual = np.linalg.norm(P @ vectors - vectors * values)
    print("||P X - X Lambda|| =", f"{residual:.1e}")


if __name__ == "__main__":
    main()
```

```text
P =
[[ 0.6667 -0.3333  0.3333]
 [-0.3333  0.6667  0.3333]
 [ 0.3333  0.3333  0.6667]]
特征值： [1. 1. 0.]
M.T @ normal = [0. 0.]
P @ in_plane == in_plane： True
P @ normal == 0： True
b 与 Pb 的夹角余弦： 0.992
||P X - X Lambda|| = 1.7e-16
```

特征值是 $1, 1, 0$，和他从图上读出来的一样。平面里的 $2\,\text{列一} - 3\,\text{列二}$ 原样不动，垂直于平面的 $(1, 1, -1)$ 被压成零。随手取的 $\mathbf{b} = (1, 2, 4)$，$\mathbf{b}$ 与 $P\mathbf{b}$ 的夹角余弦是 0.992，不是 1，方向确实变了（偏得不多，因为我挑的 $\mathbf{b}$ 离平面本来就不远）。最后一行把 `np.linalg.eig` 给的整套 $(\lambda, \mathbf{x})$ 代回方程，残差 $1.7 \times 10^{-16}$，也就是舍入误差。

## 先求 λ，再求 x

**怎么找？** 他的技巧很短：把 $\lambda\mathbf{x}$ 移到左边，

$$
(A - \lambda I)\,\mathbf{x} = \mathbf{0}
$$

我们要的 $\mathbf{x}$ 不是零向量，所以矩阵 $A - \lambda I$ 必须奇异，行列式必须为零：

$$
\det(A - \lambda I) = 0
$$

这叫特征方程。它里面已经没有 $\mathbf{x}$ 了，是 $\lambda$ 的 $n$ 次多项式，有 $n$ 个根（可能有重根）。他的顺序是先求 $\lambda$，再对每个 $\lambda$ 解 $(A - \lambda I)\mathbf{x} = \mathbf{0}$：$A - \lambda I$ 是个奇异矩阵，要的是零空间，第 7 讲已经熟练地做过。自由变量取 1，得到一个特征向量。

他的主例子是

$$
A = \begin{bmatrix} 3 & 1 \\ 1 & 3 \end{bmatrix}, \qquad
\det(A - \lambda I) =
\begin{vmatrix} 3 - \lambda & 1 \\ 1 & 3 - \lambda \end{vmatrix}
= \lambda^2 - 6\lambda + 8 = (\lambda - 4)(\lambda - 2)
$$

特征值是 4 和 2。$A - 4I$ 是 $\begin{bmatrix} -1 & 1 \\ 1 & -1 \end{bmatrix}$，零空间里是 $(1, 1)$；$A - 2I$ 是 $\begin{bmatrix} 1 & 1 \\ 1 & 1 \end{bmatrix}$，零空间里是 $(-1, 1)$。零空间是一整条直线，所以严格说不存在“那个”特征向量，而是一条线上的所有向量，我们只要选一个当代表。

方程里的 6 和 8 他特意问过学生：6 是 $3 + 3$，对角线之和，叫迹；8 是行列式。所以 $2 \times 2$ 的特征方程就是

$$
\lambda^2 - (\text{迹})\,\lambda + (\text{行列式}) = 0
$$

两个根的和等于迹，积等于行列式。一般的 $n \times n$ 也一样：**特征值之和等于迹，特征值之积等于行列式**。不过 $n$ 大了没有现成公式去解多项式，这个事实更多是拿来检查的。（他也说了，$n \geq 3$ 之后求根就不好玩了，这部分交给计算机。）

下面这个脚本做四件事：置换矩阵 $\begin{bmatrix} 0 & 1 \\ 1 & 0 \end{bmatrix}$ 的两个特征向量；加 $3I$ 得到上面的 $A$；`np.poly` 取出特征多项式的系数，和迹、行列式对照；最后验证他警告的那件事，知道 $A$ 和 $B$ 的特征值，不等于知道 $A + B$ 的特征值。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 置换矩阵：交换两个分量
    P = np.array([[0.0, 1.0], [1.0, 0.0]])
    x1 = np.array([1.0, 1.0])
    x2 = np.array([-1.0, 1.0])
    print("P @ (1, 1) =", P @ x1, "，P @ (-1, 1) =", P @ x2)
    print("特征值：", np.sort(np.linalg.eigvals(P)))
    print("迹 =", np.trace(P), "，行列式 =", round(np.linalg.det(P), 4))

    # 加上 3 * 单位矩阵：特征值各加 3，特征向量不变
    A = P + 3.0 * np.eye(2)
    print("A =", A.tolist())
    print("特征值：", np.sort(np.linalg.eigvals(A)))
    print("A @ (1, 1) =", A @ x1, "，A @ (-1, 1) =", A @ x2)

    # 特征方程 lambda^2 - 迹 * lambda + 行列式 = 0 的系数
    print("np.poly(A) =", np.poly(A))
    print("迹 =", np.trace(A), "，行列式 =", round(np.linalg.det(A), 4))
    print("两个特征向量的内积：", x1 @ x2)

    # 特征值的和与积并不能拆开：A + B 的特征值不是两边特征值的和
    B = np.array([[1.0, 2.0], [0.0, 1.0]])
    print("eig(A) =", np.sort(np.linalg.eigvals(A)))
    print("eig(B) =", np.sort(np.linalg.eigvals(B)))
    print("eig(A + B) =", np.sort(np.linalg.eigvals(A + B)))
    print("eig(A @ B) =", np.sort(np.linalg.eigvals(A @ B)))


if __name__ == "__main__":
    main()
```

```text
P @ (1, 1) = [1. 1.] ，P @ (-1, 1) = [ 1. -1.]
特征值： [-1.  1.]
迹 = 0.0 ，行列式 = -1.0
A = [[3.0, 1.0], [1.0, 3.0]]
特征值： [2. 4.]
A @ (1, 1) = [4. 4.] ，A @ (-1, 1) = [-2.  2.]
np.poly(A) = [ 1. -6.  8.]
迹 = 6.0 ，行列式 = 8.0
两个特征向量的内积： 0.0
eig(A) = [2. 4.]
eig(B) = [1. 1.]
eig(A + B) = [2.2679 5.7321]
eig(A @ B) = [1.1716 6.8284]
```

读几个结果。

- 置换矩阵交换两个分量，$(1, 1)$ 交换后不变，$\lambda = 1$；$(-1, 1)$ 交换后变成 $(1, -1)$，$\lambda = -1$。迹是 0，所以知道一个特征值是 1，另一个就必须是 $-1$。他还特意指出：一个元素全不为负的矩阵，也可以有负的特征值。
- 加 $3I$ 以后，特征值 $-1, 1$ 变成 $2, 4$，各加了 3；两个特征向量 $(1, 1)$ 和 $(-1, 1)$ 完全没动。原因是 $P\mathbf{x} = \lambda\mathbf{x}$ 两边各加 $3\mathbf{x}$，就得到 $(P + 3I)\mathbf{x} = (\lambda + 3)\mathbf{x}$。`np.poly(A)` 给出 $[1, -6, 8]$，对应 $\lambda^2 - 6\lambda + 8$，迹 6.0，行列式 8.0，全部对上。
- 两个特征向量的内积是 0.0，垂直。他提前剧透过：对称矩阵的特征值是实数，特征向量互相垂直，这不是巧合，是定理，第 25 讲证明。
- 最后一组：$A$ 的特征值是 2 和 4，我取的 $B = \begin{bmatrix} 1 & 2 \\ 0 & 1 \end{bmatrix}$ 的特征值是 1 和 1。如果特征值能拆开相加，$A + B$ 的特征值应该落在 $2 + 1 = 3$ 和 $4 + 1 = 5$ 上，实际算出来是 2.2679 和 5.7321。$AB$ 的特征值 1.1716 和 6.8284 也不是 $2 \times 1$ 和 $4 \times 1$。

最后这点在他的黑板上写成一个“错误论证”：$A\mathbf{x} = \lambda\mathbf{x}$，$B\mathbf{x} = \alpha\mathbf{x}$，相加得 $(A + B)\mathbf{x} = (\lambda + \alpha)\mathbf{x}$。毛病在于 $A$ 的特征向量一般不是 $B$ 的特征向量，$B$ 有自己的 $\mathbf{y}$。特征值不是线性的，也不能相乘。只有 $B = 3I$ 这种每个向量都是特征向量的矩阵，论证才成立。

## 旋转：实矩阵，复特征值

**什么情况下没有特征向量？** 取 90 度旋转矩阵 $Q = \begin{bmatrix} 0 & -1 \\ 1 & 0 \end{bmatrix}$（他写成 $\begin{bmatrix} \cos 90° & -\sin 90° \\ \sin 90° & \cos 90° \end{bmatrix}$ 的形式，并说它是“非常正交”的矩阵）。把每个向量转 90 度，哪个向量会和自己平行？没有。

方程给出同样的警告。迹是 0，所以两个特征值加起来是 0，一正一负；行列式是 1，所以乘起来是 $+1$。两个实数一正一负，积不可能是正的。特征方程是 $\lambda^2 + 1 = 0$，根是 $\pm i$：实矩阵出现了复特征值。他在这里半开玩笑地说，复数到底还是要进 18.06 了（“Boo”）。

```python
import numpy as np


def rotation(theta: float) -> np.ndarray:
    c, s = np.cos(theta), np.sin(theta)
    return np.array([[c, -s], [s, c]])


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # Strang 的 90 度旋转：他写成 [[0, -1], [1, 0]]
    Q = rotation(np.pi / 2)
    values, vectors = np.linalg.eig(Q)
    print("Q =")
    print(Q)
    print("特征值：", values)
    print("特征向量（按列）：")
    print(vectors)
    print("Q.T == -Q：", np.allclose(Q.T, -Q))
    print(
        "迹 =", round(np.trace(Q), 4), "，行列式 =", round(np.linalg.det(Q), 4)
    )
    print("lambda^2 + 1 = 0 的根：", np.roots([1.0, 0.0, 1.0]))

    # 复特征向量满足 Q v = lambda v
    v = vectors[:, 0]
    print("Q @ v == lambda * v：", np.allclose(Q @ v, values[0] * v))

    # 转 30 度：特征值是 exp(+-i theta)，模长是 1，幅角是 +-30 度
    R = rotation(np.deg2rad(30.0))
    mu = np.linalg.eigvals(R)
    print("30 度旋转的特征值：", mu)
    print("模长：", np.abs(mu), "，幅角（度）：", np.rad2deg(np.angle(mu)))


if __name__ == "__main__":
    main()
```

```text
Q =
[[ 0. -1.]
 [ 1.  0.]]
特征值： [0.+1.j 0.-1.j]
特征向量（按列）：
[[0.7071+0.j     0.7071-0.j    ]
 [0.    -0.7071j 0.    +0.7071j]]
Q.T == -Q： True
迹 = 0.0 ，行列式 = 1.0
lambda^2 + 1 = 0 的根： [-0.+1.j  0.-1.j]
Q @ v == lambda * v： True
30 度旋转的特征值： [0.866+0.5j 0.866-0.5j]
模长： [1. 1.] ，幅角（度）： [ 30. -30.]
```

三点。

- `np.linalg.eig` 对实矩阵 $Q$ 返回了复数特征值 $\pm i$，特征向量是复向量 $(1, -i)/\sqrt{2}$ 和它的共轭，$Q\mathbf{v} = \lambda\mathbf{v}$ 验证通过。复特征值总是成共轭对出现，这对实矩阵是定理。
- $Q^\mathsf{T} = -Q$：反对称。他的结论是：对称矩阵特征值是实的，反对称矩阵特征值是纯虚数，两者之间的一般矩阵是实部与虚部的混合。
- 我顺手把 90 度换成 30 度：特征值是 $\cos 30° \pm i\sin 30° = 0.866 \pm 0.5i$，模长是 1，幅角是 $\pm 30°$。旋转矩阵的特征值就是 $e^{\pm i\theta}$，模长为 1，意味着只转不伸缩。

## 重复特征值：特征向量不够用

**还有更糟的情况吗？** 把 $\begin{bmatrix} 3 & 1 \\ 1 & 3 \end{bmatrix}$ 左下角的 1 改成 0，得到三角矩阵 $\begin{bmatrix} 3 & 1 \\ 0 & 3 \end{bmatrix}$。三角矩阵的行列式是对角线之积，特征值直接读出来：3 和 3，重复的特征值。他说，重复特征值是 18.06 里一切麻烦的来源。

麻烦在特征向量上。$A - 3I = \begin{bmatrix} 0 & 1 \\ 0 & 0 \end{bmatrix}$，零空间只有 $(1, 0)$ 这一条线。第二个 $\lambda = 3$ 要找一个和 $(1, 0)$ 无关的特征向量，找不到。这个矩阵是 $2 \times 2$，却只有一个独立的特征向量，他管它叫“退化”矩阵。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # Strang 把 [[3, 1], [1, 3]] 的左下角改成 0，得到三角矩阵
    A = np.array([[3.0, 1.0], [0.0, 3.0]])
    values, vectors = np.linalg.eig(A)
    print("特征值（读对角线就行）：", values)
    print("np.linalg.eig 给的特征向量（按列）：")
    print(vectors)

    # A - 3I 的零空间只有一条线：秩是 1，不是 0
    shifted = A - 3.0 * np.eye(2)
    print("A - 3I 的秩：", np.linalg.matrix_rank(shifted))
    print(
        "(1, 0) 是特征向量：",
        np.allclose(A @ [1.0, 0.0], 3.0 * np.array([1.0, 0.0])),
    )
    print(
        "(0, 1) 是特征向量：",
        np.allclose(A @ [0.0, 1.0], 3.0 * np.array([0.0, 1.0])),
    )

    # 两列特征向量几乎平行：行列式接近 0，矩阵几乎不可逆
    print("特征向量矩阵的行列式：", f"{np.linalg.det(vectors):.2e}")
    print("特征向量矩阵的秩：", np.linalg.matrix_rank(vectors))
    print("特征向量矩阵的条件数：", f"{np.linalg.cond(vectors):.2e}")

    # 对照：特征值不同的矩阵，特征向量矩阵可逆得很好
    S = np.array([[3.0, 1.0], [1.0, 3.0]])
    _, sv = np.linalg.eig(S)
    print(
        "[[3, 1], [1, 3]] 的特征向量矩阵条件数：", round(np.linalg.cond(sv), 4)
    )


if __name__ == "__main__":
    main()
```

```text
特征值（读对角线就行）： [3. 3.]
np.linalg.eig 给的特征向量（按列）：
[[ 1. -1.]
 [ 0.  0.]]
A - 3I 的秩： 1
(1, 0) 是特征向量： True
(0, 1) 是特征向量： False
特征向量矩阵的行列式： 6.66e-16
特征向量矩阵的秩： 1
特征向量矩阵的条件数： 3.00e+15
[[3, 1], [1, 3]] 的特征向量矩阵条件数： 1.0
```

`np.linalg.eig` 不会告诉你“找不到”，它老老实实地返回了两列：$(1, 0)$ 和 $(-1, 0)$，第二列只是第一列的相反数。行列式 $6.66 \times 10^{-16}$，秩 1，条件数 $3.00 \times 10^{15}$，已经逼近双精度的极限 $1/\varepsilon \approx 4.5 \times 10^{15}$。对照一下，$\begin{bmatrix} 3 & 1 \\ 1 & 3 \end{bmatrix}$ 的特征向量矩阵条件数是 1.0，两个特征向量垂直，不能更好了。

下一讲会看到，这个“特征向量不够”的矩阵为什么不能对角化。教训是：函数返回了一个矩阵，不代表里面的列真的构成了基，要自己看秩或条件数。（我的运气好一点：它至少没有崩溃。）

## 在控制里

离散系统 $\mathbf{x}[k+1] = A\mathbf{x}[k]$ 的解是 $\mathbf{x}[k] = A^k\mathbf{x}[0]$，它会不会衰减，看的就是 $A$ 的特征值。如果 $\mathbf{x}[0]$ 恰好是特征向量，$A^k\mathbf{x}[0] = \lambda^k\mathbf{x}[0]$，每一步乘一个 $\lambda$。所以 $|\lambda| < 1$ 衰减，$|\lambda| > 1$ 发散，$|\lambda| = 1$ 不增不减；复特征值的幅角只管转，不影响模长。稳定性的判据是谱半径（特征值模长的最大值）是否小于 1，也就是所有特征值都在复平面的单位圆内。

我用三个形如 $\begin{bmatrix} a & b \\ -b & a \end{bmatrix}$ 的矩阵验证。这种矩阵等于 $r$ 倍的旋转，$r = \sqrt{a^2 + b^2}$，特征值是 $a \pm bi$，所以 $\|\mathbf{x}[k]\| = r^k\|\mathbf{x}[0]\|$ 是精确的。最后一个例子是视频里没有的，我自己加的：特征值全在单位圆内，但矩阵远离对称，状态的模长依然可以先涨后落。

```python
import numpy as np


def simulate(A: np.ndarray, x0: np.ndarray, steps: int) -> np.ndarray:
    """返回 x[0], x[1], ..., x[steps] 的模长。"""
    x = x0.copy()
    norms = [np.linalg.norm(x)]
    for _ in range(steps):
        x = A @ x
        norms.append(np.linalg.norm(x))
    return np.array(norms)


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    x0 = np.array([1.0, 1.0])

    systems = {
        "稳定": np.array([[0.9, 0.2], [-0.2, 0.9]]),
        "临界": np.array([[0.0, 1.0], [-1.0, 0.0]]),
        "发散": np.array([[1.0, 0.2], [-0.2, 1.0]]),
    }
    for name, A in systems.items():
        radius = np.max(np.abs(np.linalg.eigvals(A)))
        norms = simulate(A, x0, 100)
        print(
            f"{name}：谱半径 = {radius:.4f}，"
            f"||x[100]|| = {norms[-1]:.4g}，"
            f"radius^100 * ||x[0]|| = {radius**100 * norms[0]:.4g}"
        )

    # 特征值在单位圆内，模长也可能先涨后落
    N = np.array([[0.9, 5.0], [0.0, 0.9]])
    norms = simulate(N, x0, 100)
    print("非对称的例子：谱半径 =", np.max(np.abs(np.linalg.eigvals(N))))
    print(
        f"  峰值 ||x[k]|| = {norms.max():.2f}（k = {norms.argmax()}），"
        f"||x[100]|| = {norms[-1]:.4f}"
    )


if __name__ == "__main__":
    main()
```

```text
稳定：谱半径 = 0.9220，||x[100]|| = 0.0004183，radius^100 * ||x[0]|| = 0.0004183
临界：谱半径 = 1.0000，||x[100]|| = 1.414，radius^100 * ||x[0]|| = 1.414
发散：谱半径 = 1.0198，||x[100]|| = 10.05，radius^100 * ||x[0]|| = 10.05
非对称的例子：谱半径 = 0.9
  峰值 ||x[k]|| = 19.76（k = 9），||x[100]|| = 0.0148
```

稳定的那个谱半径 0.9220，100 步后模长 0.0004183；发散的那个谱半径 1.0198，100 步后涨到 10.05；临界的（90 度旋转）转了 100 步也只是转，模长一直是 $\sqrt{2} = 1.414$。前三行里实际模长和“谱半径的 100 次方乘初始模长”完全一致。

最后一个例子需要小心。$\begin{bmatrix} 0.9 & 5 \\ 0 & 0.9 \end{bmatrix}$ 就是上一节那类“重复特征值、一条特征向量”的矩阵，特征值只有 0.9，模长最终一定会衰减，但中间先冲到了 19.76（第 9 步），100 步后才回落到 0.0148。所以特征值回答的是“最终去哪里”，不回答“途中走多远”。对控制来说，这就是为什么只看极点位置有时不够。第 28 讲会把这种矩阵正式叫作 Jordan 块。

下一讲 Strang 会把特征向量收集成矩阵 $S$，把特征值放进对角矩阵 $\Lambda$，写出 $A = S\Lambda S^{-1}$，矩阵的幂 $A^k$ 一下子就变得简单。刚才那个特征向量不够用的三角矩阵为什么写不成这种形式，也会在那里解释：[18.06 第 22 讲：对角化与矩阵的幂](/posts/linear-algebra-22-diagonalization-powers/)。
