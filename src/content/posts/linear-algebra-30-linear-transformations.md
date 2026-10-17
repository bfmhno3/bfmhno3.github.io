---
title: "18.06 第 30 讲：线性变换及其矩阵"
commentId: "post:linear-algebra-30-linear-transformations"
published: "2026-10-18 18:00:00 +08:00"
description: "MIT 18.06 第 30 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 把一座房子的六个顶点交给翻转、旋转和投影三个矩阵，又把多项式求导写成 2 × 3 矩阵，平移的线性性误差是 3.1623，而投影把房子的面积压成了 0 倍。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 线性变换
  - 矩阵表示
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 31
draft: false
comment: true
slug: linear-algebra-30-linear-transformations
---

Strang 说，线性代数课以前就是从这一讲开始的：先有变换，后有矩阵。变换是“把每个输入变成一个输出”的规则，矩阵只是你选定了坐标之后，这条规则写在纸上的样子。我把他黑板上的投影、旋转和那座“房子”都交给 NumPy：对“平移整个平面”这个看上去很无辜的变换，线性性的误差是 3.1623，对投影是 0.0000；而同一个投影，在标准基下是满的矩阵，在特征向量基下就变成了 $\mathrm{diag}(1, 0)$。

> [!NOTE] 本讲速览
> 视频：[Lecture 30: Linear transformations and their matrices](https://www.youtube.com/watch?v=Ts3o2I8_Mxc)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-30-linear-transformations-and-their-matrices/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §8.1 The Idea of a Linear Transformation；§8.2 The Matrix of a Linear Transformation
> 前置：[第 29 讲：奇异值分解](/posts/linear-algebra-29-svd/)
> 一句话：选定输入基和输出基之后，线性变换对应唯一的矩阵，它的第 $j$ 列就是第 $j$ 个输入基向量被变换之后，在输出基下的坐标。

> [!TIP] 配合视频
> - 开头他先不画坐标轴，用投影和旋转讲“什么是线性变换”，再举平移和取长度两个反例。这一段是整讲的概念核心，值得认真听，本篇第一节只是把它们数值化。
> - “房子”那段很短，他把矩阵 $\mathrm{diag}(1, -1)$ 作用在房子上。本篇第二节算过，可以倍速。
> - 他在黑板上写“造矩阵的规则”（先变换第一个基向量，再把结果写成输出基的组合，系数放进第一列）的那几分钟要停下来跟着写一遍，它是后面所有内容的依据。
> - 最后的求导例子很快，本篇最后一节用代码重做了一遍。结尾两句（逆矩阵对应逆变换、乘积对应复合）是下一讲的伏笔。

## 什么样的变换算线性

**先说变换是什么。** 它就是一个函数：你给一个输入向量 $\mathbf{v}$，它给一个输出向量 $T(\mathbf{v})$。Strang 的第一个例子是投影：平面上画一条直线，把每个向量投影到这条直线上。他特意说他不想画坐标轴，规则里没有矩阵，只有“垂直落到直线上”这个几何动作。

线性的要求只有两条：$T(\mathbf{v} + \mathbf{w}) = T(\mathbf{v}) + T(\mathbf{w})$ 和 $T(c\mathbf{v}) = cT(\mathbf{v})$。他把两条合成一条：对任意线性组合，$T(c\mathbf{v} + d\mathbf{w}) = cT(\mathbf{v}) + dT(\mathbf{w})$。向量加法和数乘是变换必须“尊重”的两种运算，别的什么都不用管。

他给了两个例子和两个反例：

- 投影：线性。向量变成两倍，投影也是两倍；$\mathbf{v}$ 变成 $-\mathbf{v}$，投影也变号。
- 旋转 45 度：线性。先加再转，和先转再加，结果一样。
- 平移整个平面，$T(\mathbf{v}) = \mathbf{v} + \mathbf{v}_0$：不线性。向量变成两倍，它只多加了一个 $\mathbf{v}_0$，而不是两个。
- 取长度，$T(\mathbf{v}) = \|\mathbf{v}\|$：不线性。$T(\mathbf{0}) = 0$ 成立，$c = 2$ 也成立，但 $c = -2$ 的时候长度不会乘 $-2$，只会翻倍。

他还顺手指出一个很便宜的检查：取 $c = 3$、$\mathbf{v} = \mathbf{0}$，线性要求 $T(\mathbf{0}) = 3T(\mathbf{0})$，所以线性变换必须把零向量送到零向量。平移一上来就没过这关。

下面用固定种子的随机向量把四个变换逐一测一遍。四个变换都是用几何或函数规则直接写的，没有矩阵，和黑板上一致：

```python
import numpy as np


def project(v: np.ndarray) -> np.ndarray:
    # 投影到 45 度的直线上，不涉及任何矩阵，只用几何规则
    u = np.array([1.0, 1.0]) / np.sqrt(2.0)
    return (u @ v) * u


def rotate(v: np.ndarray) -> np.ndarray:
    # 逆时针转 45 度，同样直接用三角函数描述
    t = np.pi / 4
    return np.array(
        [
            np.cos(t) * v[0] - np.sin(t) * v[1],
            np.sin(t) * v[0] + np.cos(t) * v[1],
        ]
    )


def shift(v: np.ndarray) -> np.ndarray:
    return v + np.array([3.0, 1.0])


def length(v: np.ndarray) -> np.ndarray:
    return np.array([np.linalg.norm(v)])


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)
    v = rng.standard_normal(2)
    w = rng.standard_normal(2)
    c, d = 2.0, -2.0

    for name, T in [
        ("投影", project),
        ("旋转", rotate),
        ("平移", shift),
        ("取长度", length),
    ]:
        zero = np.allclose(T(np.zeros(2)), 0.0)
        # 线性的两条要求合成一条：T(c v + d w) = c T(v) + d T(w)
        err = np.linalg.norm(T(c * v + d * w) - (c * T(v) + d * T(w)))
        print(f"{name}：T(0) = 0 吗？{zero}，线性性的误差 = {err:.4f}")

    # 取长度：乘 -2 之后长度还是正的，不会乘 -2
    print("|v| =", length(v), "，|-2v| =", length(-2.0 * v))


if __name__ == "__main__":
    main()
```

```text
投影：T(0) = 0 吗？True，线性性的误差 = 0.0000
旋转：T(0) = 0 吗？True，线性性的误差 = 0.0000
平移：T(0) = 0 吗？False，线性性的误差 = 3.1623
取长度：T(0) = 0 吗？True，线性性的误差 = 1.7145
|v| = [0.7072] ，|-2v| = [1.4144]
```

投影和旋转的误差是 0.0000，平移是 3.1623（恰好是 $\|\mathbf{v}_0\| = \sqrt{10}$：我取的 $c + d = 0$，线性组合里的 $\mathbf{v}_0$ 全部抵消，变换自己却多添了一个）。取长度的误差是 1.7145，而它的 $T(\mathbf{0}) = 0$ 是通过的：我故意把这一栏打印出来，是想让你看到“$T(\mathbf{0}) = 0$”只是必要条件，不是充分条件。最后一行把 $c = -2$ 的问题摆出来：$\|\mathbf{v}\| = 0.7072$，$\|-2\mathbf{v}\| = 1.4144$，是 $+2$ 倍，不是 $-2$ 倍。

## 矩阵乘法给出一大族线性变换

**怎么造一个一定线性的变换？** 取一个矩阵 $A$，规定 $T(\mathbf{v}) = A\mathbf{v}$。$A(\mathbf{v} + \mathbf{w}) = A\mathbf{v} + A\mathbf{w}$ 和 $A(c\mathbf{v}) = cA\mathbf{v}$ 就是矩阵乘法的基本性质，不用再检查。他说：每个矩阵都是一个线性变换，所以这是一大族例子。

他想让你看的是整个平面一起动。画一座房子，轮廓是一圈顶点，对每个顶点做同一个变换，就看到整个房子怎么变。他取了 $A = \begin{bmatrix} 1 & 0 \\ 0 & -1 \end{bmatrix}$：$x$ 分量不变，$y$ 分量变号，房子倒过来，门也跟着到了下面。

我用同样的思路，给房子定了六个顶点（最后一个回到起点，轮廓是个五边形，屋顶尖在 $(1, 3)$），然后依次交给翻转、旋转 45 度和投影到 45 度线上这三个矩阵。一次矩阵乘法就把六个顶点全部变了：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 房子的轮廓：每一列是一个顶点，最后回到起点
    house = np.array(
        [
            [0.0, 2.0, 2.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 2.0, 3.0, 2.0, 0.0],
        ]
    )
    t = np.pi / 4
    flip = np.array([[1.0, 0.0], [0.0, -1.0]])
    rot = np.array([[np.cos(t), -np.sin(t)], [np.sin(t), np.cos(t)]])
    proj = np.array([[0.5, 0.5], [0.5, 0.5]])

    # 一次矩阵乘法，整座房子的 6 个顶点同时变换
    for name, A in [("翻转", flip), ("旋转 45 度", rot), ("投影", proj)]:
        out = A @ house
        print(name, "之后的顶点：")
        print(out)
        print("  房顶尖 (1, 3) 变成：", A @ house[:, 3])
        print("  房子的“面积”变成原来的", f"{abs(np.linalg.det(A)):.4f}", "倍")


if __name__ == "__main__":
    main()
```

```text
翻转 之后的顶点：
[[ 0.  2.  2.  1.  0.  0.]
 [ 0.  0. -2. -3. -2.  0.]]
  房顶尖 (1, 3) 变成： [ 1. -3.]
  房子的“面积”变成原来的 1.0000 倍
旋转 45 度 之后的顶点：
[[ 0.      1.4142  0.     -1.4142 -1.4142  0.    ]
 [ 0.      1.4142  2.8284  2.8284  1.4142  0.    ]]
  房顶尖 (1, 3) 变成： [-1.4142  2.8284]
  房子的“面积”变成原来的 1.0000 倍
投影 之后的顶点：
[[0. 1. 2. 2. 1. 0.]
 [0. 1. 2. 2. 1. 0.]]
  房顶尖 (1, 3) 变成： [2. 2.]
  房子的“面积”变成原来的 0.0000 倍
```

翻转之后屋顶尖 $(1, 3)$ 变成 $(1, -3)$，和他说的一样。旋转之后变成 $(-1.4142, 2.8284)$：长度没变（都是 $\sqrt{10}$），方向转了 45 度。最后一行的“面积倍数”是 $|\det A|$：翻转和旋转都是 1.0000，房子没有变大变小；投影是 0.0000，整座房子被压成了一条线段，输出里两行数字一模一样，所有顶点都落在 $y = x$ 上。

翻转和旋转放在一起看更直观：

![左：矩阵 diag(1, -1) 把蓝色的房子变成红色的倒房子。右：旋转 45 度的矩阵把房子绕原点转了一个角度，虚线连着屋顶尖的输入与输出](/assets/images/linear-algebra/l30-house.svg)

上面这张图由下面这个脚本生成（需要 matplotlib，在当前目录写出 SVG；图中的数据与前面的代码块相同）：

```python
import matplotlib
import matplotlib.pyplot as plt
import numpy as np


def main() -> None:
    matplotlib.use("Agg")
    plt.rcParams["svg.hashsalt"] = "la1806"

    house = np.array(
        [
            [0.0, 2.0, 2.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 2.0, 3.0, 2.0, 0.0],
        ]
    )
    t = np.pi / 4
    flip = np.array([[1.0, 0.0], [0.0, -1.0]])
    rot = np.array([[np.cos(t), -np.sin(t)], [np.sin(t), np.cos(t)]])

    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    for ax, A, title in [
        (axes[0], flip, "A = diag(1, -1)"),
        (axes[1], rot, "A = rotation by 45 degrees"),
    ]:
        out = A @ house
        ax.plot(house[0], house[1], "o-", color="tab:blue", label="input")
        ax.plot(out[0], out[1], "o-", color="tab:red", label="output")
        ax.plot(
            [house[0, 3], out[0, 3]],
            [house[1, 3], out[1, 3]],
            ":",
            color="gray",
        )
        ax.set_aspect("equal")
        ax.grid(alpha=0.3)
        ax.axhline(0, color="black", lw=0.6)
        ax.axvline(0, color="black", lw=0.6)
        ax.set_title(title)
        ax.legend(loc="lower right")
        ax.set_xlim(-3.5, 3.5)
        ax.set_ylim(-3.5, 3.5)
    fig.tight_layout()
    fig.savefig(
        "l30-house.svg",
        metadata={"Date": None},
    )


if __name__ == "__main__":
    main()
```

他在这里说的一句话我觉得是全讲的主旨：线性变换是矩阵乘法的抽象描述，我们的目标是“找出它背后的矩阵”。要做到这一点，就得引入坐标，也就是选基。

## 只需要知道变换对基做了什么

**要完全确定一个线性变换，要知道多少信息？** 他一步一步地问。只告诉你 $T(\mathbf{v}_1)$，你只知道一个向量的去向。再告诉你 $T(\mathbf{v}_2)$，你就知道了 $\mathbf{v}_1$、$\mathbf{v}_2$ 张成的整个平面里每个向量的去向，因为线性：$T(c_1\mathbf{v}_1 + c_2\mathbf{v}_2) = c_1T(\mathbf{v}_1) + c_2T(\mathbf{v}_2)$，没有别的选择。前提是 $\mathbf{v}_1$、$\mathbf{v}_2$ 无关：如果 $\mathbf{v}_2$ 是 $\mathbf{v}_1$ 的 6 倍，$T(\mathbf{v}_2)$ 里没有新信息。

所以答案是：只要输入空间的一组基 $\mathbf{v}_1, \dots, \mathbf{v}_n$ 和每个基向量的像 $T(\mathbf{v}_1), \dots, T(\mathbf{v}_n)$，就知道了所有输入的像。无限多个输入，$n$ 个输出就够了，我觉得这相当省事。

坐标又是什么？他说坐标来自基：向量 $\mathbf{v}$ 在基 $\mathbf{v}_1, \dots, \mathbf{v}_n$ 下的坐标，就是 $\mathbf{v} = c_1\mathbf{v}_1 + \cdots + c_n\mathbf{v}_n$ 里的那些 $c_i$，在一组基下这种表示是唯一的。我们平时写 $(3, 2, 4)$，默认的是标准基。换一组基（比如某个矩阵的特征向量），坐标就变了，向量本身没变。这有点像同一栋房子在不同城市的地址系统里有不同的门牌号，房子没动，动的是编号方式。

于是，从线性变换 $T$（输入在 $\mathbf{R}^n$，输出在 $\mathbf{R}^m$）造矩阵 $A$，他的规则是：

- 选输入基 $\mathbf{v}_1, \dots, \mathbf{v}_n$ 和输出基 $\mathbf{w}_1, \dots, \mathbf{w}_m$。（要选两组，因为输入和输出可以不在同一个空间里。）
- 第 1 列：对 $\mathbf{v}_1$ 做变换，得到 $T(\mathbf{v}_1)$，把它写成输出基的组合 $T(\mathbf{v}_1) = a_{11}\mathbf{w}_1 + \cdots + a_{m1}\mathbf{w}_m$，系数 $a_{11}, \dots, a_{m1}$ 就是 $A$ 的第 1 列。
- 第 2 列同理，对 $\mathbf{v}_2$ 做同样的事。依此类推。

为什么这样造的矩阵一定对？输入坐标是 $(1, 0, \dots, 0)$ 的时候，输入就是 $\mathbf{v}_1$，矩阵乘出来恰好是第 1 列，也就是 $T(\mathbf{v}_1)$ 的坐标。第 2 列、第 3 列……都对，所以对所有基向量都对，所以对所有向量都对。结论：输入坐标乘 $A$，得到输出坐标。

## 同一个投影，不同的基，不同的矩阵

他用投影当例子，输入输出用同一组基。第一次选的基很讲究：第一个基向量 $\mathbf{v}_1$ 落在要投影的直线上（单位向量），第二个 $\mathbf{v}_2$ 垂直于直线。看规则：

- $T(\mathbf{v}_1) = \mathbf{v}_1$：投影不动直线上的向量，所以第 1 列是 $(1, 0)$。
- $T(\mathbf{v}_2) = \mathbf{0}$：投影把垂直方向消灭，第 2 列是 $(0, 0)$。

矩阵是 $\begin{bmatrix} 1 & 0 \\ 0 & 0 \end{bmatrix}$，对角的。他提醒我们，这组基其实就是投影的特征向量，特征值是 1 和 0，所以矩阵就是特征值矩阵 $\Lambda$。这才是“好基”：他说，物理学家不情愿地引入坐标时，选的就是这种。

如果偏要用标准基（直线取 45 度），就是第 15 讲里的 $P = \dfrac{\mathbf{a}\mathbf{a}^\mathsf{T}}{\mathbf{a}^\mathsf{T}\mathbf{a}}$，$\mathbf{a} = (1, 1)$，他说算出来是四个 $\frac12$。输入 $(1, 0)$，输出 $(\frac12, \frac12)$，是对的，只是不对角。我把造矩阵的规则写成函数 `matrix_in_bases`，用它在三组基下造矩阵，再验证“输入坐标乘矩阵得输出坐标”：

```python
import numpy as np


def matrix_in_bases(T: np.ndarray, V: np.ndarray, W: np.ndarray) -> np.ndarray:
    """按 Strang 的规则造矩阵：第 j 列是 T(v_j) 在输出基 W 下的坐标。"""
    cols = []
    for j in range(V.shape[1]):
        out = T @ V[:, j]  # 先对第 j 个输入基向量施加变换
        cols.append(np.linalg.solve(W, out))  # 再求它在输出基下的坐标
    return np.column_stack(cols)


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 投影到 45 度直线上，用标准基时，这就是第 15 讲的 P
    a = np.array([[1.0], [1.0]])
    P = a @ np.linalg.inv(a.T @ a) @ a.T
    print("标准基下的矩阵 P：")
    print(P)
    print("P @ (1, 0) =", P @ np.array([1.0, 0.0]))

    # 换成特征向量基：一个在直线上，一个垂直于直线
    q1 = np.array([1.0, 1.0]) / np.sqrt(2.0)
    q2 = np.array([-1.0, 1.0]) / np.sqrt(2.0)
    Q = np.column_stack([q1, q2])
    Lam = matrix_in_bases(P, Q, Q)
    print("特征向量基下的矩阵：")
    print(Lam)

    # 输入基和输出基不必相同，换一组斜着的基，矩阵就不再对角
    V = np.array([[1.0, 1.0], [0.0, 1.0]])
    M = matrix_in_bases(P, V, V)
    print("斜基下的矩阵：")
    print(M)

    # 验证：输入坐标乘矩阵，得到输出坐标
    v = np.array([3.0, -1.0])
    c_in = np.linalg.solve(Q, v)
    c_out = Lam @ c_in
    print("输入坐标", c_in, "，输出坐标", c_out)
    print("还原成向量后与 P @ v 一致：", np.allclose(Q @ c_out, P @ v))
    print("特征值：", np.linalg.eigvalsh(P))


if __name__ == "__main__":
    main()
```

```text
标准基下的矩阵 P：
[[0.5 0.5]
 [0.5 0.5]]
P @ (1, 0) = [0.5 0.5]
特征向量基下的矩阵：
[[1. 0.]
 [0. 0.]]
斜基下的矩阵：
[[0.  0. ]
 [0.5 1. ]]
输入坐标 [ 1.4142 -2.8284] ，输出坐标 [1.4142 0.    ]
还原成向量后与 P @ v 一致： True
特征值： [0. 1.]
```

标准基下是四个 0.5，特征向量基下是 $\mathrm{diag}(1, 0)$，`eigvalsh` 打印出来的特征值也是 0 和 1，对得上。第三个矩阵是我自己加的：用一组斜着的基 $(1, 0)$、$(1, 1)$，造出来的矩阵是 $\begin{bmatrix} 0 & 0 \\ 0.5 & 1 \end{bmatrix}$，既不对称也不对角。这三个矩阵描述的是同一个变换，差别全在基上。

倒数第二行验证规则本身：取 $\mathbf{v} = (3, -1)$，在特征向量基下的坐标是 $(1.4142, -2.8284)$，乘上 $\mathrm{diag}(1, 0)$ 得到 $(1.4142, 0)$，再用 $Q$ 还原回标准坐标，和直接算 $P\mathbf{v}$ 一致。（这就是第 22 讲对角化的回顾：$A = S\Lambda S^{-1}$，不过是同一件事换了说法。）

他还说了一句我觉得很对的话：整门课其实一直在用“最顺手的基”，也就是标准基，然后对付得到的矩阵。这个矩阵不坏：对称，$P^2 = P$。但在最好的基里，对角、对称、$P^2 = P$ 这三件事一眼都能看出来。

## 求导是线性的，它的矩阵是 2 × 3

最后一个例子不再是平面上的箭头。输入空间是所有形如 $c_1 + c_2x + c_3x^2$ 的多项式，基是 $1, x, x^2$；变换是求导，输出是 $c_2 + 2c_3x$，输出基取 $1, x$。三维到二维，所以矩阵是 2 × 3。

他的话很实在：你大概没想过求导是线性的，但如果它不是，求导会花上很长时间。正是因为线性，我们只要知道 $\sin x$、$\cos x$、$e^x$ 这几个小清单上的导数，就能对它们的所有组合求导。

套上造矩阵的规则：$1$ 求导是 $0$，坐标 $(0, 0)$；$x$ 求导是 $1$，坐标 $(1, 0)$；$x^2$ 求导是 $2x$，坐标 $(0, 2)$。三列并起来：

$$
D = \begin{bmatrix} 0 & 1 & 0 \\ 0 & 0 & 2 \end{bmatrix}
$$

乘上输入坐标 $(c_1, c_2, c_3)$，得 $(c_2, 2c_3)$，正是他黑板上要的。我让代码也走一遍规则：对三个基向量分别用 `numpy.polynomial` 求导，把结果当作列拼起来，再和直接求导对照：

```python
import numpy as np
from numpy.polynomial import polynomial as poly


def derivative_coords(c: np.ndarray) -> np.ndarray:
    """多项式系数 (c1, c2, c3) 求导，输出系数补成长度 2。"""
    return np.pad(poly.polyder(c), (0, 2 - (len(c) - 1)))


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 输入基 1, x, x^2；输出基 1, x。按规则造矩阵：
    # 第 j 列 = 求导作用在第 j 个输入基向量上的输出坐标
    basis = np.eye(3)
    D = np.column_stack([derivative_coords(basis[:, j]) for j in range(3)])
    print("D =")
    print(D)
    print("D 的形状：", D.shape)

    c = np.array([5.0, -3.0, 4.0])  # 5 - 3x + 4x^2
    print("D @ c =", D @ c, "，直接求导：", derivative_coords(c))

    # 线性性：对和求导等于对导数求和
    rng = np.random.default_rng(1806)
    p = rng.standard_normal(3)
    q = rng.standard_normal(3)
    print("D(p + q) = D(p) + D(q)：", np.allclose(D @ (p + q), D @ p + D @ q))

    # 零空间：导数为 0 的多项式只有常数
    print("D 的秩：", np.linalg.matrix_rank(D))
    print("D @ (7, 0, 0) =", D @ np.array([7.0, 0.0, 0.0]))


if __name__ == "__main__":
    main()
```

```text
D =
[[0. 1. 0.]
 [0. 0. 2.]]
D 的形状： (2, 3)
D @ c = [-3.  8.] ，直接求导： [-3.  8.]
D(p + q) = D(p) + D(q)： True
D 的秩： 2
D @ (7, 0, 0) = [0. 0.]
```

`D` 就是上面那个矩阵，$5 - 3x + 4x^2$ 的导数 $-3 + 8x$，两种算法都是 $(-3, 8)$。零空间也很好看：$D$ 的秩是 2，$(7, 0, 0)$（也就是常数 7）被送到 $(0, 0)$，所以求导的零空间正好是常数函数，这是“导数为零的函数是常数”的线性代数版本。

他最后留了两句：逆矩阵给出逆变换，矩阵的乘积给出变换复合的矩阵。矩阵乘法本来就是从线性变换来的，不是先有一个奇怪的乘法规则再去凑。这个话题他说要等感恩节假期之后再讲，我猜下一讲会从“换一组基，同一个变换的矩阵怎么变”切入，见 [18.06 第 31 讲：基变换与图像压缩](/posts/linear-algebra-31-change-of-basis-compression/)。到时候，今天那个斜基下的矩阵 $\begin{bmatrix} 0 & 0 \\ 0.5 & 1 \end{bmatrix}$ 和 $\mathrm{diag}(1, 0)$ 之间的关系就有名字了。
