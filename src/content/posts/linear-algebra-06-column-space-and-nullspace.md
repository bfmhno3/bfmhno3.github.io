---
title: "18.06 第 6 讲：列空间与零空间"
commentId: "post:linear-algebra-06-column-space-and-nullspace"
published: "2026-10-18 09:40:00 +08:00"
description: "MIT 18.06 第 6 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 对 Strang 的 4 × 3 矩阵用最小二乘残差判断右端项在不在列空间，再用 SVD 求零空间，1000 个随机右端项里没有一个落在列空间里，而 Ax = b 的全部解是一条到原点距离 0.8165 的直线。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 列空间
  - 零空间
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 6
draft: false
comment: true
slug: linear-algebra-06-column-space-and-nullspace
---

这一讲 Strang 只用一个 4 × 3 的小矩阵，把“解 $A\mathbf{x} = \mathbf{b}$”拆成两个互不相干的子空间：列空间管右端项 $\mathbf{b}$ 够不够得着，零空间管解 $\mathbf{x}$ 有几个。我用 NumPy 把他心算出来的结论全算了一遍：随机取 1000 个 $\mathbf{b}$，落进列空间的是 0 个；有解的时候，全部解是一条不过原点的直线，到原点的距离是 0.8165。

> [!NOTE] 本讲速览
> 视频：[Lecture 6: Column space and nullspace](https://www.youtube.com/watch?v=8o5Cmfpeo6g)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-6-column-space-and-nullspace/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §1.3 Matrices and Their Column Spaces；§3.1 Vector Spaces and Subspaces
> 前置：[第 5 讲：转置、置换与向量空间](/posts/linear-algebra-05-transposes-permutations-spaces/)
> 一句话：$A\mathbf{x} = \mathbf{b}$ 有解，当且仅当 $\mathbf{b}$ 在 $A$ 的列空间里；$A\mathbf{x} = \mathbf{0}$ 的所有解构成零空间，它是 $\mathbb{R}^n$ 里的子空间。

> [!TIP] 配合视频
> - 开头十来分钟在讲“并集不是子空间、交集是子空间”。他画的平面和直线很直观，我只在第一节做了一次数值检查，你看视频时能跟上就可以倍速。
> - 他让同学心算 $A\mathbf{x} = \mathbf{b}$ 的那一段（“告诉我一个能解的右端项”）要认真看：这是列空间定义最自然的出场方式。随后他问“哪一列可以扔掉”，主列的说法就是从这里来的。
> - 讲零空间的一段，他让同学报解，从 $(1, 1, -1)$ 一路报到“把所有解都告诉我”，值得完整看一遍。验证零空间是子空间的那几句话很短，本篇第三节用代码逐条对过。
> - 最后他把右端项换成 $(1, 2, 3, 4)$，指出解集不是子空间，再总结“描述子空间的两种方式”。这一段是全讲的收束，别快进。

## 并集不是子空间，交集是

上一讲留下了子空间的定义：对加法和数乘封闭，合起来就是对线性组合封闭。Strang 先在 $\mathbb{R}^3$ 里画了一个过原点的平面 $P$ 和一条过原点的直线 $L$，问了两个问题。

**$P$ 与 $L$ 的并集是子空间吗？** 不是。平面里取一个向量，直线上取一个向量，加起来一般既不在平面里也不在直线上，加法出了并集。**交集呢？** 交集是子空间，而且对任意两个子空间 $S$、$T$ 都成立：$\mathbf{v}$、$\mathbf{w}$ 同时在 $S$ 和 $T$ 里，那么 $\mathbf{v} + \mathbf{w}$ 在 $S$ 里（因为 $S$ 是子空间），在 $T$ 里（因为 $T$ 是子空间），所以在交集里；数乘同理。（他举的例子里平面和直线只交于零向量，他问“只有零向量算子空间吗”，答案是算。）

我用同样的思路各做了一次数值检查。$P$ 取 $z = 0$ 平面，$L$ 取沿 $(1, 1, 1)$ 的直线；交集的例子换成两个平面 $x + y + z = 0$ 和 $x = y$。每组都随机抽 1000 次：

```python
import numpy as np


def in_span(M: np.ndarray, v: np.ndarray) -> bool:
    """判断 v 是否在 M 的列张成的空间里。"""
    x, *_ = np.linalg.lstsq(M, v, rcond=None)
    return bool(np.allclose(M @ x, v))


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 平面 P：z = 0，由 e1、e2 张成；直线 L：沿 (1, 1, 1)
    P = np.array([[1.0, 0.0], [0.0, 1.0], [0.0, 0.0]])
    L = np.array([[1.0], [1.0], [1.0]])

    # 并集：P 里取一个向量，L 里取一个向量，相加后还在 P 或 L 里吗
    trials = 1000
    stay = 0
    for _ in range(trials):
        v = P @ rng.standard_normal(2)
        w = L @ rng.standard_normal(1)
        s = v + w
        if in_span(P, s) or in_span(L, s):
            stay += 1
    print(f"P 并 L：{trials} 次相加，留在并集里的有 {stay} 次")

    # 交集：S：x + y + z = 0，T：x = y，交集是一条线
    S_eq = np.array([[1.0, 1.0, 1.0]])
    T_eq = np.array([[1.0, -1.0, 0.0]])
    both = np.vstack([S_eq, T_eq])
    _, _, Vt = np.linalg.svd(both)
    d = Vt[-1] / Vt[-1][0]  # 同时满足两个方程的方向
    print("S 交 T 的方向：", d)

    ok = 0
    for _ in range(trials):
        v = rng.standard_normal() * d
        w = rng.standard_normal() * d
        c = rng.standard_normal()
        s = v + w
        t = c * v
        in_both = np.allclose(both @ s, 0) and np.allclose(both @ t, 0)
        ok += int(in_both)
    print(f"S 交 T：{trials} 次加法与数乘，都还在交集里的有 {ok} 次")


if __name__ == "__main__":
    main()
```

```text
P 并 L：1000 次相加，留在并集里的有 0 次
S 交 T 的方向： [ 1.  1. -2.]
S 交 T：1000 次加法与数乘，都还在交集里的有 1000 次
```

第一组：1000 次相加，没有一次留在并集里（随机浮点数恰好落在平面或直线上的概率是零，这个结果并不意外）。第二组：两个平面的交集是沿 $(1, 1, -2)$ 的一条直线，1000 次加法和数乘全部还在交集里。

这里的“检查”其实是在复述他那三句话，代码不能代替证明，只是让我确认自己没有读错题。（我也不是很确定把这种检查写成代码有多大必要，但不写的话，这一节就只有字没有数。）

## 列空间：$\mathbf{b}$ 够不够得着

接下来是整讲的主角。他的矩阵是

$$
A = \begin{bmatrix} 1 & 1 & 2 \\ 2 & 1 & 3 \\ 3 & 1 & 4 \\ 4 & 1 & 5 \end{bmatrix}
$$

**列空间是什么？** $A$ 的列空间 $C(A)$ 是三列的所有线性组合。三列各自当然在里面，但三个向量不构成子空间，必须把它们的组合都放进来；这是包含这三列的最小的子空间。$A$ 是 4 × 3，每一列有 4 个分量，所以 $C(A)$ 是 $\mathbb{R}^4$ 的子空间。

他立刻问：这个子空间会填满整个 $\mathbb{R}^4$ 吗？同学说不会。三个向量的组合凑不满四维空间，对应到方程组就是四个方程只有三个未知数，大多数 $\mathbf{b}$ 没有解。（他自己替旁观者说了一句“你这个笨蛋，四个方程三个未知数怎么解”，然后话锋一转：有些右端项就是能解。）

**哪些右端项能解？** 他让同学报：全零当然行，$\mathbf{x} = \mathbf{0}$。$(1, 2, 3, 4)$ 行，它是第一列，$\mathbf{x} = (1, 0, 0)$。$(1, 1, 1, 1)$ 行，它是第二列，$\mathbf{x} = (0, 1, 0)$。然后他给出本讲的第一个结论：

$$
A\mathbf{x} = \mathbf{b} \text{ 有解} \iff \mathbf{b} \in C(A)
$$

理由一句话：$C(A)$ 的定义就是所有 $A\mathbf{x}$ 的集合。$\mathbf{b}$ 是列的组合，这个组合的系数就是 $\mathbf{x}$；不是列的组合，就没有 $\mathbf{x}$。

怎么在 NumPy 里判断？我用两种办法。第一种是我在第 1 篇用过的最小二乘残差：`np.linalg.lstsq` 找离 $\mathbf{b}$ 最近的 $A\mathbf{x}$，残差是 0 就说明 $\mathbf{b}$ 在列空间里。第二种是把 $\mathbf{b}$ 拼到 $A$ 右边，看秩有没有涨：秩不变，说明新列没有带来新方向。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    A = np.array(
        [[1.0, 1.0, 2.0], [2.0, 1.0, 3.0], [3.0, 1.0, 4.0], [4.0, 1.0, 5.0]]
    )
    print(
        "A 是", A.shape[0], "x", A.shape[1], "，秩 =", np.linalg.matrix_rank(A)
    )
    print(
        "第三列 = 第一列 + 第二列：", np.allclose(A[:, 2], A[:, 0] + A[:, 1])
    )

    # 扔掉哪一列，列空间都没变
    for j in range(3):
        rest = np.delete(A, j, axis=1)
        print(f"扔掉第 {j + 1} 列后的秩：", np.linalg.matrix_rank(rest))

    # b 在不在列空间：最小二乘残差 + 秩检验
    b_cases = {
        "b = 第一列": A[:, 0],
        "b = (1, 1, 1, 1)": np.ones(4),
        "b = A @ 随机 x": A @ rng.standard_normal(3),
        "b = 随机向量": rng.standard_normal(4),
    }
    for name, b in b_cases.items():
        x, *_ = np.linalg.lstsq(A, b, rcond=None)
        residual = np.linalg.norm(A @ x - b)
        rank_aug = np.linalg.matrix_rank(np.column_stack([A, b]))
        print(f"{name}：残差 = {residual:.4f}，[A b] 的秩 = {rank_aug}")

    # 随机 b 里有多少个落在列空间里
    trials = 1000
    inside = 0
    for _ in range(trials):
        b = rng.standard_normal(4)
        x, *_ = np.linalg.lstsq(A, b, rcond=None)
        inside += int(np.allclose(A @ x, b))
    print(f"{trials} 个随机 b 里，在列空间里的有 {inside} 个")


if __name__ == "__main__":
    main()
```

```text
A 是 4 x 3 ，秩 = 2
第三列 = 第一列 + 第二列： True
扔掉第 1 列后的秩： 2
扔掉第 2 列后的秩： 2
扔掉第 3 列后的秩： 2
b = 第一列：残差 = 0.0000，[A b] 的秩 = 2
b = (1, 1, 1, 1)：残差 = 0.0000，[A b] 的秩 = 2
b = A @ 随机 x：残差 = 0.0000，[A b] 的秩 = 2
b = 随机向量：残差 = 1.5314，[A b] 的秩 = 3
1000 个随机 b 里，在列空间里的有 0 个
```

三个“可解”的右端项残差都是 0.0000，$[A\ \mathbf{b}]$ 的秩仍然是 2；随机向量的残差是 1.5314，$[A\ \mathbf{b}]$ 的秩涨到 3。这个 1.5314 就是那个随机 $\mathbf{b}$ 到 $C(A)$ 的距离。最后一行是整个实验里最干脆的数：1000 个随机 $\mathbf{b}$ 里，落进列空间的有 0 个。二维的平面在四维空间里测度为零，这不是比喻，是实打实的 0 / 1000。

**为什么秩是 2？** Strang 接着问：三列里能不能扔掉一列、列空间还是原来那个？同学说扔第三列，因为第三列是前两列之和。他承认，其实扔第一列也行，只是约定“从左往右，能留就留”，留下来的叫主列，没留下的以后叫相关列。所以 $C(A)$ 是 $\mathbb{R}^4$ 里的一个二维子空间。代码里三种扔法的秩全是 2，第三列等于前两列之和也验证了。他在这里很小心地说“独立”“维数”这些词还不能正式用，“你会看出来我们要往那个方向走”。这就是第 9 讲的内容，我先不展开。

## 零空间：$\mathbf{x}$ 有几个

**零空间是什么？** 换一个角度。列空间里装的是右端项 $\mathbf{b}$，零空间 $N(A)$ 里装的是未知数 $\mathbf{x}$：所有满足 $A\mathbf{x} = \mathbf{0}$ 的 $\mathbf{x}$。$A$ 有 $n$ 列，$\mathbf{x}$ 就有 $n$ 个分量，所以对 $m \times n$ 的矩阵，$C(A)$ 在 $\mathbb{R}^m$ 里，$N(A)$ 在 $\mathbb{R}^n$ 里。这个例子里是 $\mathbb{R}^4$ 对 $\mathbb{R}^3$。

他先让同学找解。零向量是解，不用看矩阵就知道。然后有人报 $(1, 1, -1)$：第一列加第二列减第三列，正好是零。再要一个，有人报 $(2, 2, -2)$。他说“那你干脆告诉我全部”，答案是 $(c, c, -c)$，$c$ 取任意数。零向量是 $c = 0$，$(1, 1, -1)$ 是 $c = 1$。这是 $\mathbb{R}^3$ 里一条过原点的直线。这个例子小，所以零空间一眼就能看出是一条线。

大一点的矩阵靠看是不行的，他说“官方的办法”是消元，下一讲才讲。我这里用 SVD 代替：奇异值为零的那些右奇异向量就是零空间的一组基。SVD 在第 29 讲才登场，我暂时只把它当成一个黑盒，它给出的向量和他心算的是同一条直线：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    A = np.array(
        [[1.0, 1.0, 2.0], [2.0, 1.0, 3.0], [3.0, 1.0, 4.0], [4.0, 1.0, 5.0]]
    )
    zero = np.zeros(4)

    # 他心算出来的：(1, 1, -1) 以及它的倍数
    v = np.array([1.0, 1.0, -1.0])
    for c in [1.0, 2.0, 7.0, -11.0]:
        print(f"A @ ({c} * v) =", A @ (c * v))

    # 用 SVD 找零空间：奇异值为 0 的右奇异向量
    _, s, Vt = np.linalg.svd(A)
    tol = s.max() * max(A.shape) * np.finfo(float).eps
    rank = int(np.sum(s > tol))
    N = Vt[rank:].T  # 每一列是零空间的一个基向量
    print("奇异值：", s)
    print("秩 =", rank, "，零空间维数 =", N.shape[1])
    print("基向量缩放到第一个分量为 1：", (N[:, 0] / N[0, 0]))
    print(f"A @ N 的最大绝对值：{np.abs(A @ N).max():.1e}")

    # 两条封闭性要求，对零空间里的 v、w 逐条验证
    w = -3.0 * v
    print("A @ (v + w) = A @ v + A @ w：", np.allclose(A @ (v + w), zero))
    print("A @ (12 * v) = 12 * (A @ v)：", np.allclose(A @ (12 * v), zero))

    # 列空间在 R^4，零空间在 R^3：秩 + 零空间维数 = 列数
    print("秩 + 零空间维数 =", rank + N.shape[1], "，列数 =", A.shape[1])


if __name__ == "__main__":
    main()
```

```text
A @ (1.0 * v) = [0. 0. 0. 0.]
A @ (2.0 * v) = [0. 0. 0. 0.]
A @ (7.0 * v) = [0. 0. 0. 0.]
A @ (-11.0 * v) = [0. 0. 0. 0.]
奇异值： [9.3441 0.829  0.    ]
秩 = 2 ，零空间维数 = 1
基向量缩放到第一个分量为 1： [ 1.  1. -1.]
A @ N 的最大绝对值：6.7e-16
A @ (v + w) = A @ v + A @ w： True
A @ (12 * v) = 12 * (A @ v)： True
秩 + 零空间维数 = 3 ，列数 = 3
```

前四行是他心算的结果：$(1, 1, -1)$ 的 1、2、7、$-11$ 倍都被 $A$ 映成零向量。奇异值是 9.3441、0.8290 和一个 0，两个非零，所以秩是 2，剩下的一个右奇异向量就是零空间的基，缩放到第一个分量为 1 之后正好是 $(1, 1, -1)$。`A @ N` 的最大绝对值是 6.7e-16，浮点数意义上的零。最后一行：秩 2 加零空间维数 1 等于列数 3，这是第 10 讲会证明的一般结论，我先把它记在这儿。

**凭什么叫“空间”？** 他回到定义，把两条要求检查了一遍。设 $A\mathbf{v} = \mathbf{0}$，$A\mathbf{w} = \mathbf{0}$，那么

$$
A(\mathbf{v} + \mathbf{w}) = A\mathbf{v} + A\mathbf{w} = \mathbf{0} + \mathbf{0} = \mathbf{0}, \qquad
A(12\mathbf{v}) = 12\,A\mathbf{v} = \mathbf{0}
$$

他承认这个证明简单得有点荒谬（说完又收回“荒谬”这个词，说那样讲不太好），而且用的是矩阵乘法的分配律与标量可以提到外面，没有证明就直接用了，“人生有限，这个证明我们跳过”。代码里最后三行对 $\mathbf{v} = (1, 1, -1)$ 和 $\mathbf{w} = -3\mathbf{v}$ 验证了这两条，都是 True。

## 右端项不为零时，解集不是子空间

最后是整讲我最喜欢的一个对比。把右端项换成 $\mathbf{b} = (1, 2, 3, 4)$。上面已经知道它有解：$(1, 0, 0)$。解的全体是不是子空间？

他先问是或不是，答案是不是，一句话就够：零向量不解这个方程，所以解集不过原点，不可能是子空间。接着同学报了第二个解 $(0, -1, 1)$：减去第二列、加上第三列，$-(1, 1, 1, 1) + (2, 3, 4, 5) = (1, 2, 3, 4)$。他说解集“像一条不过原点的直线”。我猜他特意挑 $(1, 2, 3, 4)$ 当右端项，就是因为它恰好是第一列，同学能马上报出解。我把这几件事都算出来：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    A = np.array(
        [[1.0, 1.0, 2.0], [2.0, 1.0, 3.0], [3.0, 1.0, 4.0], [4.0, 1.0, 5.0]]
    )
    b = np.array([1.0, 2.0, 3.0, 4.0])

    x1 = np.array([1.0, 0.0, 0.0])  # 学生一眼看出来的
    x2 = np.array([0.0, -1.0, 1.0])  # 第二个解
    n = np.array([1.0, 1.0, -1.0])  # 零空间里的方向
    print("A @ x1 =", A @ x1, "，是解：", np.allclose(A @ x1, b))
    print("A @ x2 =", A @ x2, "，是解：", np.allclose(A @ x2, b))
    print("x1 - x2 =", x1 - x2, "，在零空间里：", np.allclose(x1 - x2, n))

    # 零向量不是解；两个解相加得到的是 2b，不是 b
    zero_is_solution = np.allclose(A @ np.zeros(3), b)
    print("A @ 0 =", A @ np.zeros(3), "，是解：", zero_is_solution)
    print("A @ (x1 + x2) =", A @ (x1 + x2), "，是 2b：", end=" ")
    print(np.allclose(A @ (x1 + x2), 2 * b))

    # 全部解 = 一个特解加零空间：x1 + c * n，一条不过原点的直线
    ok = all(np.allclose(A @ (x1 + c * n), b) for c in np.linspace(-5, 5, 11))
    print("x1 + c * n 对 11 个 c 都是解：", ok)
    dist = np.linalg.norm(x1 - (x1 @ n) / (n @ n) * n)
    print(f"这条直线到原点的距离：{dist:.4f}")


if __name__ == "__main__":
    main()
```

```text
A @ x1 = [1. 2. 3. 4.] ，是解： True
A @ x2 = [1. 2. 3. 4.] ，是解： True
x1 - x2 = [ 1.  1. -1.] ，在零空间里： True
A @ 0 = [0. 0. 0. 0.] ，是解： False
A @ (x1 + x2) = [2. 4. 6. 8.] ，是 2b： True
x1 + c * n 对 11 个 c 都是解： True
这条直线到原点的距离：0.8165
```

两个解的差是 $(1, 1, -1)$，正好在零空间里；零向量不是解；两个解相加得到的是 $2\mathbf{b}$，不是 $\mathbf{b}$，加法没有封闭。更一般地，$\mathbf{x}_1 + c\,\mathbf{n}$ 对 11 个不同的 $c$ 全部都是解。所以解集是“一个特解加上整个零空间”：一条平行于零空间那条线、但整体平移了的直线。这条直线到原点的距离是 0.8165（也就是 $\sqrt{6}/3$，垂足是 $\mathbf{x}_1$ 去掉沿 $\mathbf{n}$ 的分量之后剩下的 $(\tfrac23, -\tfrac13, \tfrac13)$），这就是它没过原点的具体量。$A\mathbf{x} = \mathbf{b}$ 的完整解他留到第 8 讲，下一讲先系统地算 $A\mathbf{x} = \mathbf{0}$。

## 描述子空间的两种方式

他用最后几分钟把两个子空间并在一起说：描述一个子空间有两种自然的办法。一种是给几个向量，说“取它们的所有组合”，列空间就是这样；另一种是给一组方程，说“满足这些方程的所有向量”，零空间就是这样。两种办法都能造出子空间，他说这是最重要的两种构造方式。

我觉得这像一份菜谱的两种写法：一种写“用这些食材随便搭配”，另一种写“只要不含这些忌口的都可以”。（这个类比我就用这一次。）但数学里这两种写法不是对立的，同一个子空间往往两种写法都有，从一种换到另一种就是后面几讲的主题。

这一讲留下了一个明确的任务：小例子可以靠眼睛看零空间，大例子不行。下一讲他要用消元来系统地算零空间，找出主变量和特解，见 [18.06 第 7 讲：解 Ax = 0，主变量与特解](/posts/linear-algebra-07-solving-ax-0/)。
