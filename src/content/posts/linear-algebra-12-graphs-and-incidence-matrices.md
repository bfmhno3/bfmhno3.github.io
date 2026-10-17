---
title: "18.06 第 12 讲：图、网络与关联矩阵"
commentId: "post:linear-algebra-12-graphs-and-incidence-matrices"
published: "2026-10-18 11:40:00 +08:00"
description: "MIT 18.06 第 12 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 搭了 Strang 的 4 节点 5 条边的关联矩阵，验证零空间是常数电势、左零空间是两个回路，又在 30 × 30 的网格上数出 841 个回路，节点数减边数加回路数恰好是 1。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 关联矩阵
  - 图与网络
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 12
draft: false
comment: true
slug: linear-algebra-12-graphs-and-incidence-matrices
---

前十一讲里，Strang 的矩阵都是他在黑板上现编的，他自己在这一讲开头也承认了，还说有点内疚。这一讲他给了一个“有来历”的矩阵：画一张 4 个节点、5 条边的图，每条边一行，记下它从哪个节点出发、到哪个节点结束。这个 5 × 4 的矩阵每行只有两个非零元，四个基本子空间里的两个各自对应图上一个看得见的东西：零空间是“所有节点电势相等”，左零空间是“回路”。我把这个图放大成 30 × 30 的网格（900 个节点，1740 条边），左零空间的维数是 841，恰好等于网格里小方格的个数。

> [!NOTE] 本讲速览
> 视频：[Lecture 12: Graphs, networks, incidence matrices](https://www.youtube.com/watch?v=6-wh6yvk6uc)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-12-graphs-networks-incidence-matrices/)）
> 教材：《Introduction to Linear Algebra》第 6 版把这部分内容拆散了，我没有在目录里找到独立的一节
> 前置：[第 11 讲：矩阵空间、秩 1 矩阵与小世界图](/posts/linear-algebra-11-matrix-spaces-rank-one/)
> 一句话：图的关联矩阵 $A$ 把节点电势变成边上的电势差，$A$ 的零空间是常数电势，$A^\mathsf{T}$ 的零空间是回路，两者的维数合起来就是 Euler 公式。

> [!TIP] 配合视频
> - 开头一段是他讲化学教授怎么做行化简、MathWorks 的生日聚会，可以跳过。从他说“我感觉好多了，今天要讲应用数学里最重要的模型”开始看。
> - 他画图、给边编号、写出 5 × 4 矩阵的那一段要认真看，他边写边改编号，自己也被绕了一下（编号数了两遍）。我的代码里的边序和他最后定下来的一致。
> - 他用“势差、电流、基尔霍夫电流定律”解释 $A\mathbf{x}$ 和 $A^\mathsf{T}\mathbf{y} = \mathbf{0}$ 的那一段，是这一讲的核心。找两个回路当基的那几分钟本篇算过，可以倍速，但“为什么外圈那个回路不是第三个基向量”值得停一下。
> - 最后他把 $A$、$C$、$A^\mathsf{T}$ 串成一条链，并问 $A^\mathsf{T}CA$ 有什么性质。我在最后一节用代码解了一个小电路，可以对照着看。

## 一张图，一个矩阵

**图是什么？** 节点加边，仅此而已。Strang 说他先随手画一个小的：四个节点，五条边。他提醒过，真实的图可以是所有网页、所有电话、所有人，这个只是玩具。

他给每条边定了一个方向，写在箭头上：

- 边 1：节点 1 到节点 2
- 边 2：节点 2 到节点 3
- 边 3：节点 1 到节点 3
- 边 4：节点 1 到节点 4
- 边 5：节点 3 到节点 4

方向是任意定的，只用来区分正负：电流顺着箭头流算正，逆着算负。接着是关联矩阵（incidence matrix）：每条边一行，每个节点一列，起点处写 $-1$，终点处写 $+1$，其余是 $0$。图里 $n = 4$ 个节点、$m = 5$ 条边，所以是 $m \times n = 5 \times 4$ 的矩阵：

$$
A = \begin{bmatrix}
-1 & 1 & 0 & 0 \\
0 & -1 & 1 & 0 \\
-1 & 0 & 1 & 0 \\
-1 & 0 & 0 & 1 \\
0 & 0 & -1 & 1
\end{bmatrix}
$$

每行恰好两个非零元，所以全矩阵的非零元个数是 $2m$。图一大，矩阵就是个又大又稀疏的矩阵，而且结构是图给的，不是我们编的。他的原话大意是：来自真实问题的矩阵有结构，用的人会利用这个结构。

脚本里我写了一个 `incidence` 函数，把边表变成矩阵。后面几个脚本都复用它（每个脚本得能单独跑，所以每次重贴）。先看矩阵本身，再验证他在黑板上做的几件事：

```python
import numpy as np


def incidence(n: int, edges: list[tuple[int, int]]) -> np.ndarray:
    """每条边一行：起点 -1，终点 +1（节点编号从 1 开始）。"""
    A = np.zeros((len(edges), n))
    for k, (tail, head) in enumerate(edges):
        A[k, tail - 1] = -1.0
        A[k, head - 1] = 1.0
    return A


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    edges = [(1, 2), (2, 3), (1, 3), (1, 4), (3, 4)]
    A = incidence(4, edges)
    print(A)
    print("形状：", A.shape, "，非零元个数：", np.count_nonzero(A))

    # A @ x 就是每条边两端的电势差
    rng = np.random.default_rng(1806)
    x = rng.standard_normal(4)
    diff = np.array([x[head - 1] - x[tail - 1] for tail, head in edges])
    print("A @ x 等于逐边电势差：", np.allclose(A @ x, diff))

    # 零空间：常数电势
    ones = np.ones(4)
    print("A @ (1, 1, 1, 1) =", A @ ones)
    print("全体电势加 7.5，电势差不变：", np.allclose(A @ (x + 7.5), A @ x))
    print("秩 =", np.linalg.matrix_rank(A), "，零空间维数 =", 4 - 3)

    # 接地：删掉最后一列（令 x4 = 0），剩下三列线性无关
    grounded = A[:, :3]
    print("接地后的秩 =", np.linalg.matrix_rank(grounded))


if __name__ == "__main__":
    main()
```

```text
[[-1.  1.  0.  0.]
 [ 0. -1.  1.  0.]
 [-1.  0.  1.  0.]
 [-1.  0.  0.  1.]
 [ 0.  0. -1.  1.]]
形状： (5, 4) ，非零元个数： 10
A @ x 等于逐边电势差： True
A @ (1, 1, 1, 1) = [0. 0. 0. 0. 0.]
全体电势加 7.5，电势差不变： True
秩 = 3 ，零空间维数 = 1
接地后的秩 = 3
```

$A\mathbf{x}$ 的第 $k$ 个分量是 $x_{\text{head}} - x_{\text{tail}}$，也就是第 $k$ 条边两端的差。把 $\mathbf{x} = (x_1, x_2, x_3, x_4)$ 看成四个节点上的**电势**，$A\mathbf{x}$ 就是五条边上的**电势差**，这是他整讲的第一条线索。上面的脚本里我用固定种子取了一个随机的 $\mathbf{x}$，逐边算差和 `A @ x` 对比，结果是 `True`。

## 零空间：只有常数电势

**$A\mathbf{x} = \mathbf{0}$ 什么时候成立？** 五个差都是零：$x_2 - x_1 = 0$，$x_3 - x_2 = 0$，$x_3 - x_1 = 0$，$x_4 - x_1 = 0$，$x_4 - x_3 = 0$。结论是四个电势全相等。所以 $(1, 1, 1, 1)$ 是零空间里的向量，它的所有倍数 $(c, c, c, c)$ 是整个零空间，维数是 1。输出里 `A @ (1, 1, 1, 1)` 是五个 0，把全体电势加 7.5，电势差没有变化，这两条是同一件事。

物理上这说的是：电势只有差才有意义，整体抬高或降低一个常数，什么都不会动。他举了温度（摄氏度和从绝对零度算起），也提到了微积分里不定积分的 $+ C$。我再补一个自己的类比：这像海拔，珠峰有多高取决于从哪里算零点，但山顶和山脚差多少米，和零点放在哪里无关。

那个任意常数在实际计算里要处理掉，办法是**接地**：随便挑一个节点，规定它的电势是零。这等于把 $A$ 的那一列删掉。输出里接地之后（删掉第 4 列），$5 \times 3$ 矩阵的秩是 3，三列线性无关，也就是说剩下三个电势都能被唯一确定。

秩本身也顺带有了答案：$n = 4$ 列里有一个相关关系，所以 $r = n - 1 = 3$。输出的“秩 = 3，零空间维数 = 1”和他在黑板上说的一致，而且任意三列都是线性无关的（他说“任意三个电势都是好变量”）。

## 左零空间：基尔霍夫电流定律

**$A^\mathsf{T}\mathbf{y} = \mathbf{0}$ 是什么？** 他说这大概是应用数学里最基本的方程。先写出 $A^\mathsf{T}$，它是 $n \times m = 4 \times 5$：

$$
A^\mathsf{T} = \begin{bmatrix}
-1 & 0 & -1 & -1 & 0 \\
1 & -1 & 0 & 0 & 0 \\
0 & 1 & 1 & 0 & -1 \\
0 & 0 & 0 & 1 & 1
\end{bmatrix}
$$

$\mathbf{y} = (y_1, \ldots, y_5)$ 是五条边上的电流。逐行读：

- 第 1 行：$-y_1 - y_3 - y_4 = 0$。边 1、3、4 都是从节点 1 流出，流出量之和为零。
- 第 2 行：$y_1 - y_2 = 0$，节点 2 流进多少流出多少。
- 第 3 行：$y_2 + y_3 - y_5 = 0$，节点 3 流进的是 $y_2$ 与 $y_3$，流出 $y_5$。
- 第 4 行：$y_4 + y_5 = 0$。

每个节点一个方程，说的都是“流进等于流出”，电荷不会堆积在节点上。这就是基尔霍夫电流定律（KCL）：守恒定律，$A^\mathsf{T}\mathbf{y} = \mathbf{0}$。

零空间的维数公式他强调了一次：$A^\mathsf{T}$ 是 $n \times m$，有 $m$ 列，$r$ 个主元列，所以 $\dim N(A^\mathsf{T}) = m - r = 5 - 3 = 2$。他不用消元，直接在图上找：让 1 安培顺着边 1 走，节点 2 上必须从边 2 走掉（$y_2 = 1$），到了节点 3，再取 $y_3 = -1$，也就是 1 安培逆着边 3 回到节点 1，$y_4 = y_5 = 0$。这是绕着上面那个三角形（节点 1、2、3）转一圈：$\mathbf{y}_1 = (1, 1, -1, 0, 0)$。另一个绕着节点 1、3、4 的三角形：$y_3 = 1$、$y_5 = 1$、$y_4 = -1$，即 $\mathbf{y}_2 = (0, 0, 1, -1, 1)$。

有人会问，绕外圈那一大圈（边 1、2、5，再逆着边 4 回来）呢？它是 $(1, 1, 0, -1, 1)$，确实也满足 KCL。但它不是第三个基向量，因为它等于前两个相加：边 3 上两个回路的电流方向相反，抵消了。下面验证：

```python
import numpy as np


def incidence(n: int, edges: list[tuple[int, int]]) -> np.ndarray:
    """每条边一行：起点 -1，终点 +1（节点编号从 1 开始）。"""
    A = np.zeros((len(edges), n))
    for k, (tail, head) in enumerate(edges):
        A[k, tail - 1] = -1.0
        A[k, head - 1] = 1.0
    return A


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    edges = [(1, 2), (2, 3), (1, 3), (1, 4), (3, 4)]
    A = incidence(4, edges)
    print("Aᵀ =")
    print(A.T)

    # 基尔霍夫电流定律 Aᵀy = 0 的两个回路解
    y_left = np.array([1.0, 1.0, -1.0, 0.0, 0.0])  # 1 -> 2 -> 3 -> 1
    y_right = np.array([0.0, 0.0, 1.0, -1.0, 1.0])  # 1 -> 3 -> 4 -> 1
    y_outer = np.array([1.0, 1.0, 0.0, -1.0, 1.0])  # 外圈
    for name, y in [("左", y_left), ("右", y_right), ("外圈", y_outer)]:
        print(f"{name}回路：Aᵀy =", A.T @ y)
    print("外圈 = 左 + 右：", np.allclose(y_outer, y_left + y_right))

    # 用 SVD 独立地算出左零空间的维数
    _, s, Vt = np.linalg.svd(A.T)
    rank = int(np.sum(s > 1e-10))
    print("rank =", rank, "，m - r =", A.shape[0] - rank)
    N = Vt[rank:].T  # 左零空间的一组标准正交基，5 x 2
    print(
        "两个回路都在这个空间里：",
        np.allclose(N @ (N.T @ y_left), y_left)
        and np.allclose(N @ (N.T @ y_right), y_right),
    )

    # 逐列加入 Aᵀ，只有让秩增加的列才是主元列
    pivots = []
    for k in range(A.shape[0]):
        if np.linalg.matrix_rank(A.T[:, pivots + [k]]) > len(pivots):
            pivots.append(k)
    print("主元列（边的编号）：", [k + 1 for k in pivots])
    loop_rank = np.linalg.matrix_rank(A[[0, 1, 2]])
    print("边 1、2、3 组成回路，这三行的秩 =", loop_rank)
    print(
        "边 1、2、4 是一棵树，这三行的秩 =", np.linalg.matrix_rank(A[pivots])
    )


if __name__ == "__main__":
    main()
```

```text
Aᵀ =
[[-1.  0. -1. -1.  0.]
 [ 1. -1.  0.  0.  0.]
 [ 0.  1.  1.  0. -1.]
 [ 0.  0.  0.  1.  1.]]
左回路：Aᵀy = [0. 0. 0. 0.]
右回路：Aᵀy = [0. 0. 0. 0.]
外圈回路：Aᵀy = [0. 0. 0. 0.]
外圈 = 左 + 右： True
rank = 3 ，m - r = 2
两个回路都在这个空间里： True
主元列（边的编号）： [1, 2, 4]
边 1、2、3 组成回路，这三行的秩 = 2
边 1、2、4 是一棵树，这三行的秩 = 3
```

三条回路的 $A^\mathsf{T}\mathbf{y}$ 全是零，外圈等于左加右。独立的 SVD 算出 $A^\mathsf{T}$ 的秩是 3，$m - r = 2$，我再把两个回路投影到 SVD 给出的左零空间基上，投影不改变它们，说明它们确实躺在这个二维空间里。

输出的最后几行是这一讲我最喜欢的部分。他顺手把 $A^\mathsf{T}$ 的主元列也问了：消元之后主元列是第 1、2、4 列，对应边 1、2、4。我没有写手动消元，而是逐列加进去、看秩有没有涨；结果和他的答案一样，`[1, 2, 4]`。这三条边把四个节点连在一起，但没有回路。没有回路的图叫**树**。反过来，边 1、2、3 组成回路，这三行的秩只有 2：三行线性相关（第 1 行加第 2 行等于第 3 行）。**行的相关关系对应图里的回路**，行无关的边集合就是树。

## Euler 公式

**回路到底有几个？** 左零空间的维数 $m - r$ 就是独立回路的个数。而 $r = n - 1$（有一个常数电势要扣掉）。代进去：

$$
\text{回路数} = m - (n - 1)
\quad\Longrightarrow\quad
n - m + \text{回路数} = 1
$$

节点数减边数加回路数等于 1。节点是零维的点，边是一维的线，回路围出一块二维的面积，所以这个交替和就是 Euler 公式。他顺口说：我们又看到 Euler 了，这个人从没停过。线性代数在这里“证明”了图论里的一个事实。（这个证明用到了 $r = n - 1$，而这一步要求图是连通的。视频里我没有听到他特别点出这一点，我猜他默认画的图都是连通的。）

他随手画了第二个图（5 个节点、7 条边、3 个回路）来验证，没有给出每条边的端点。我自己画了一个 5 节点 7 边的图，又加了两个反例：两个互不相连的三角形，以及一个 30 × 30 的网格：

```python
import numpy as np


def incidence(n: int, edges: list[tuple[int, int]]) -> np.ndarray:
    """每条边一行：起点 -1，终点 +1（节点编号从 1 开始）。"""
    A = np.zeros((len(edges), n))
    for k, (tail, head) in enumerate(edges):
        A[k, tail - 1] = -1.0
        A[k, head - 1] = 1.0
    return A


def euler(name: str, n: int, edges: list[tuple[int, int]]) -> None:
    A = incidence(n, edges)
    m = len(edges)
    r = np.linalg.matrix_rank(A)
    loops = m - r  # 左零空间的维数
    print(f"{name}：n = {n}，m = {m}，r = {r}，回路数 = {loops}，", end="")
    print(f"n - m + 回路数 = {n - m + loops}")


def grid_edges(side: int) -> list[tuple[int, int]]:
    edges = []
    for i in range(side):
        for j in range(side):
            node = i * side + j + 1
            if j + 1 < side:
                edges.append((node, node + 1))
            if i + 1 < side:
                edges.append((node, node + side))
    return edges


def main() -> None:
    # Strang 的图
    euler("Strang 的图", 4, [(1, 2), (2, 3), (1, 3), (1, 4), (3, 4)])
    # 我自己画的一个 5 节点 7 边的图
    euler(
        "5 节点图",
        5,
        [(1, 2), (2, 3), (3, 4), (4, 5), (5, 1), (1, 3), (2, 4)],
    )
    # 两个互不相连的三角形：零空间是二维的，公式右边变成连通块数
    triangle = [(1, 2), (2, 3), (1, 3), (4, 5), (5, 6), (4, 6)]
    euler("两个三角形", 6, triangle)

    # 30 x 30 的网格：关联矩阵很大，非零元很少
    side = 30
    edges = grid_edges(side)
    euler("30 x 30 网格", side * side, edges)
    A = incidence(side * side, edges)
    print("网格关联矩阵的形状：", A.shape)
    nonzero = np.count_nonzero(A)
    print(f"非零元：{nonzero}，占比 {nonzero / A.size:.4%}")
    print("小方格的个数 (side - 1)² =", (side - 1) ** 2)


if __name__ == "__main__":
    main()
```

```text
Strang 的图：n = 4，m = 5，r = 3，回路数 = 2，n - m + 回路数 = 1
5 节点图：n = 5，m = 7，r = 4，回路数 = 3，n - m + 回路数 = 1
两个三角形：n = 6，m = 6，r = 4，回路数 = 2，n - m + 回路数 = 2
30 x 30 网格：n = 900，m = 1740，r = 899，回路数 = 841，n - m + 回路数 = 1
网格关联矩阵的形状： (1740, 900)
非零元：3480，占比 0.2222%
小方格的个数 (side - 1)² = 841
```

四个图里，Strang 的图、我的 5 节点图和网格都给出 1。两个互不相连的三角形给出 2：零空间现在是二维的（每个连通块一个常数电势），$r = n - 2$，右边于是变成连通块的个数。所以 Euler 公式里的 1，实际上是“连通块数”，这是我跑完才注意到的细节。

30 × 30 的网格才是我真正想放在这里的数字：关联矩阵是 $1740 \times 900$，一共 3480 个非零元，占 0.2222%，其余 99.78% 都是零。左零空间的维数 $m - r = 1740 - 899 = 841$，和网格里的小方格数 $29^2 = 841$ 完全一致。每个小方格是一个基本回路，大回路都可以由它们相加得到。这个计算的时候我并没有告诉程序“有多少方格”，它只看秩。

## $A^\mathsf{T}CA$：把三步连起来

最后他把前面散着的东西连成一条链：

$$
\mathbf{x}
\;\xrightarrow{\;A\;}\;
\mathbf{e} = A\mathbf{x}
\;\xrightarrow{\;C\;}\;
\mathbf{y} = C\mathbf{e}
\;\xrightarrow{\;A^\mathsf{T}\;}\;
\mathbf{f} = A^\mathsf{T}\mathbf{y}
$$

- $A$：节点电势变成边上的电势差 $\mathbf{e}$。
- $C$：欧姆定律。边上的电流等于电导（电阻的倒数）乘以电势差，这里 $C$ 是对角矩阵，每条边一个电导。
- $A^\mathsf{T}$：基尔霍夫电流定律。电流在每个节点上求净流量，等于外部电流源 $\mathbf{f}$。

他说外部电流源是他一直没放进去的东西：在 $A^\mathsf{T}\mathbf{y} = \mathbf{f}$ 的右边加一个 $\mathbf{f}$，比如往一个节点送进 1 安培，从另一个节点取走。他还说，这些是平衡态的方程，时间不在里面，牛顿定律也不在里面，只问“一切稳定下来之后，电流怎样分布”。三式合起来：$A^\mathsf{T}CA\,\mathbf{x} = \mathbf{f}$。

最后他问：$A^\mathsf{T}CA$ 有什么性质？（他自己只答了 $A^\mathsf{T}A$ 总是对称的，然后就下课了。它还是半正定的，那是第 25 讲的内容。）下面用同一个图和一组电导 $C = \operatorname{diag}(1, 2, 1, 2, 1)$ 解一个小电路：

```python
import numpy as np


def incidence(n: int, edges: list[tuple[int, int]]) -> np.ndarray:
    """每条边一行：起点 -1，终点 +1（节点编号从 1 开始）。"""
    A = np.zeros((len(edges), n))
    for k, (tail, head) in enumerate(edges):
        A[k, tail - 1] = -1.0
        A[k, head - 1] = 1.0
    return A


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = incidence(4, [(1, 2), (2, 3), (1, 3), (1, 4), (3, 4)])
    C = np.diag([1.0, 2.0, 1.0, 2.0, 1.0])  # 每条边的电导 1 / R

    print("AᵀA =")
    print(A.T @ A)
    K = A.T @ C @ A
    print("AᵀCA =")
    print(K)
    print("对称：", np.allclose(K, K.T), "，秩 =", np.linalg.matrix_rank(K))

    # 外部电流源 f：节点 1 送进 1 安，节点 4 取走 1 安
    f = np.array([-1.0, 0.0, 0.0, 1.0])
    print("f 的分量之和 =", f.sum())

    # 接地节点 4：删掉第 4 行第 4 列，剩下的 3 x 3 可逆
    K3 = K[:3, :3]
    x = np.zeros(4)
    x[:3] = np.linalg.solve(K3, f[:3])
    print("电势 x =", x)
    print("接地后的秩 =", np.linalg.matrix_rank(K3))

    # 三步：x -> 电势差 e = A x -> 电流 y = C e -> f = Aᵀ y
    e = A @ x
    y = C @ e
    print("电势差 e =", e)
    print("电流 y =", y)
    print("Aᵀy 等于 f：", np.allclose(A.T @ y, f))

    # 分量之和不为 0 的 f 无解：电荷没处去
    f_bad = np.array([1.0, 0.0, 0.0, 0.0])
    x_bad, *_ = np.linalg.lstsq(K, f_bad, rcond=None)
    print("f = (1, 0, 0, 0) 的残差：", np.linalg.norm(K @ x_bad - f_bad))


if __name__ == "__main__":
    main()
```

```text
AᵀA =
[[ 3. -1. -1. -1.]
 [-1.  2. -1.  0.]
 [-1. -1.  3. -1.]
 [-1.  0. -1.  2.]]
AᵀCA =
[[ 4. -1. -1. -2.]
 [-1.  3. -2.  0.]
 [-1. -2.  4. -1.]
 [-2.  0. -1.  3.]]
对称： True ，秩 = 3
f 的分量之和 = 0.0
电势 x = [-0.381  -0.2857 -0.2381  0.    ]
接地后的秩 = 3
电势差 e = [0.0952 0.0476 0.1429 0.381  0.2381]
电流 y = [0.0952 0.0952 0.1429 0.7619 0.2381]
Aᵀy 等于 f： True
f = (1, 0, 0, 0) 的残差： 0.5
```

分几步看这个输出。

- $A^\mathsf{T}A$ 的对角线是 3, 2, 3, 2，正好是每个节点连着几条边（度数），非对角线上，相邻的节点是 $-1$，不相邻的是 0。节点 2 和 4 之间没有边，输出里第 (2, 4) 位置确实是 0。带权的 $A^\mathsf{T}CA$ 同样是对称的。
- $A^\mathsf{T}CA$ 的秩是 3，而不是 4：它是 $4 \times 4$ 的奇异矩阵。零空间向量还是 $(1, 1, 1, 1)$，因为 $A\mathbf{x}$ 已经是零，乘 $C$ 和 $A^\mathsf{T}$ 之后还是零。
- 接地节点 4，删掉第 4 行第 4 列，得到可逆的 $3 \times 3$ 矩阵，解出 $\mathbf{x} = (-0.381, -0.2857, -0.2381, 0)$。电流源是 $\mathbf{f} = (-1, 0, 0, 1)$，意思是从节点 1 送进 1 安培、在节点 4 取走（$A^\mathsf{T}\mathbf{y}$ 算的是净流入减去净流出，所以注入处是负的）。
- 电流 $\mathbf{y} = (0.0952, 0.0952, 0.1429, 0.7619, 0.2381)$。边 4 直接连着节点 1 和节点 4，电导是 2，分得 0.7619 安培，最多，合理。从节点 1 流出的电流之和 $0.0952 + 0.1429 + 0.7619 = 1$，正好是送进去的那 1 安培。最后一行检验 $A^\mathsf{T}\mathbf{y} = \mathbf{f}$ 是 `True`。

最后一个数字是 0.5：给一个分量和不为零的 $\mathbf{f}$（比如只往节点 1 送 1 安培、不取走），最小二乘能做到的最好残差是 0.5，不是零。这等于说：这个方程组无解。道理很直接，电荷没地方去。线性代数的说法是：$A^\mathsf{T}CA\,\mathbf{x} = \mathbf{f}$ 有解，当且仅当 $\mathbf{f}$ 和零空间里的 $(1, 1, 1, 1)$ 垂直，即分量之和为零。“行空间和零空间垂直”要到第 14 讲才系统地讲，我这里先露个头。

我猜 Strang 反复说“结构”，是想让我们看到：前十一讲那些现编的矩阵，换一层外壳就是电路、管网和桥。（我得承认，我也是画了这几张图，才第一次觉得左零空间不是一个拿来考试的名词。）

他最后说下次是这几章的完整复习，也就是 [18.06 第 13 讲：第一次测验复习](/posts/linear-algebra-13-quiz-1-review/)。我会把他讲的题逐道用 NumPy 过一遍。
