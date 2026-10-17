---
title: "18.06 第 1 讲：方程组的行图与列图"
commentId: "post:linear-algebra-01-geometry-of-linear-equations"
published: "2026-10-18 08:00:00 +08:00"
description: "MIT 18.06 第 1 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 把 2 × 2 与 3 × 3 方程组分别按行图、列图和 A @ x 解了一遍，再把第三列换成前两列之和，秩从 3 掉到 2，最近的可达点与 b 差了 0.4082。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 线性方程组
  - 列图
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 1
draft: false
comment: true
slug: linear-algebra-01-geometry-of-linear-equations
---

Strang 第一讲想让你带走的只有一句话：解 $A\mathbf{x} = \mathbf{b}$，就是问 $\mathbf{b}$ 能不能写成 $A$ 的各列的线性组合。我把他黑板上的 3 × 3 矩阵的第三列改成前两列之和，行列式从 6 变成 0，秩从 3 掉到 2，右端项 $(1, 0, 0)$ 到最近的可达点的距离是 0.4082：方程组没有解，而且没有解的原因一眼就能在列上看出来。

> [!NOTE] 本讲速览
> 视频：[Lecture 1: The geometry of linear equations](https://www.youtube.com/watch?v=J7DzL2_Na80)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-1-the-geometry-of-linear-equations/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §1.1 Vectors and Linear Combinations；§1.3 Matrices and Their Column Spaces；§2.1 Elimination and Back Substitution
> 前置：没有前置，这是第一篇。
> 一句话：$A\mathbf{x}$ 是 $A$ 的列的线性组合，所以“$A\mathbf{x} = \mathbf{b}$ 有没有解”和“$\mathbf{b}$ 在不在列的组合里”是同一个问题。

> [!TIP] 配合视频
> - 开头几分钟在介绍教材和课程网页，可以跳过。2 × 2 的行图（两条直线相交）很短，本篇已经算过，倍速即可。
> - 他画列图的那一段要认真看：把两个列向量首尾相接，凑出 $\mathbf{b}$。这是整门课最重要的一幅图。
> - 3 × 3 的行图他自己都说画不好，可以快进。紧接着的列图和“如果三列落在同一个平面里会怎样”值得一字不漏地听。
> - 最后讲 $A\mathbf{x}$ 按列算、按行算的那段很短，本篇最后一节用代码重算了一遍。

## 这个系列怎么用

我自己的节奏是这样：先读这一篇（大概 15 分钟），再看视频，遇到 TIP 里写“已经算过”的地方就倍速。视频是他讲，代码是我算，两边对一次，比光看一遍记得牢。

有一件事要提前说：视频是 1999 年秋天的录像，用的是当时的教材。我手上的《Introduction to Linear Algebra》是第 6 版（2023），它把线性无关和列空间（$A = CR$）提到了最前面，录像里没有这个顺序。所以每篇的“教材”一行只告诉你对应哪几节，章节顺序不会一一对上。以视频字幕为准，教材拿来查证明和习题。

### 运行环境

仓库的 `flake.nix` 里只有 Node 和 pnpm，我的 PATH 里也没有 `python3`，所以用 Nix 临时拉一个带 NumPy 和 matplotlib 的 Python：

```bash
nix shell --impure --expr '(builtins.getFlake "nixpkgs").legacyPackages.x86_64-linux.python313.withPackages (p: [ p.numpy p.matplotlib ])' --command python <script.py>
```

打印版本用的是同一个解释器：

```bash
nix shell --impure --expr '(builtins.getFlake "nixpkgs").legacyPackages.x86_64-linux.python313.withPackages (p: [ p.numpy p.matplotlib ])' --command python -c "import sys, numpy, matplotlib; print(sys.version.split()[0], numpy.__version__, matplotlib.__version__)"
```

```text
3.13.15 2.4.4 3.10.9
```

也就是 Python 3.13.15、NumPy 2.4.4、matplotlib 3.10.9。matplotlib 只用来画文中的图，画图脚本贴在各图之后，其余代码块都不用它。

### 代码约定

- 矩阵用大写单字母 `A`、`L`、`U`、`P`、`Q`、`R`、`S`，和 Strang 的黑板一致。这是我有意偏离 PEP 8 变量命名的地方。
- 每个代码块都是能单独运行的完整脚本，只用标准库和 NumPy，不读写文件。块后紧跟的 `text` 块是它的 stdout，逐字拷贝，不手改。
- 随机数一律 `rng = np.random.default_rng(1806)`。浮点比较用 `np.allclose` 或 `np.isclose`，不用 `==`。
- 画图的脚本放在对应的图后面，需要 matplotlib，不带 `text` 输出块。图里的数都来自文中的代码块。

### 系列地图

全系列 35 篇：第 1 到 34 讲，加上第 24 讲和第 25 讲之间的第 24b 讲（第二次测验复习）。

| 篇 | 讲 | 标题 |
| --- | --- | --- |
| 1 | 1 | 方程组的行图与列图 |
| 2 | 2 | [用矩阵做消元](/posts/linear-algebra-02-elimination-with-matrices/) |
| 3 | 3 | [矩阵乘法的四种看法与逆矩阵](/posts/linear-algebra-03-multiplication-and-inverse/) |
| 4 | 4 | [分解成 A = LU](/posts/linear-algebra-04-lu-factorization/) |
| 5 | 5 | [转置、置换与向量空间](/posts/linear-algebra-05-transposes-permutations-spaces/) |
| 6 | 6 | [列空间与零空间](/posts/linear-algebra-06-column-space-and-nullspace/) |
| 7 | 7 | [解 Ax = 0，主变量与特解](/posts/linear-algebra-07-solving-ax-0/) |
| 8 | 8 | [解 Ax = b，行最简形 R](/posts/linear-algebra-08-solving-ax-b/) |
| 9 | 9 | [线性无关、基与维数](/posts/linear-algebra-09-independence-basis-dimension/) |
| 10 | 10 | [四个基本子空间](/posts/linear-algebra-10-four-fundamental-subspaces/) |
| 11 | 11 | [矩阵空间、秩 1 矩阵与小世界图](/posts/linear-algebra-11-matrix-spaces-rank-one/) |
| 12 | 12 | [图、网络与关联矩阵](/posts/linear-algebra-12-graphs-and-incidence-matrices/) |
| 13 | 13 | [第一次测验复习](/posts/linear-algebra-13-quiz-1-review/) |
| 14 | 14 | [正交向量与正交子空间](/posts/linear-algebra-14-orthogonal-subspaces/) |
| 15 | 15 | [投影到子空间](/posts/linear-algebra-15-projections/) |
| 16 | 16 | [投影矩阵与最小二乘](/posts/linear-algebra-16-least-squares/) |
| 17 | 17 | [正交矩阵与 Gram-Schmidt](/posts/linear-algebra-17-orthogonal-matrices-gram-schmidt/) |
| 18 | 18 | [行列式的性质](/posts/linear-algebra-18-determinant-properties/) |
| 19 | 19 | [行列式公式与代数余子式](/posts/linear-algebra-19-determinant-formulas-cofactors/) |
| 20 | 20 | [Cramer 法则、逆矩阵与体积](/posts/linear-algebra-20-cramer-inverse-volume/) |
| 21 | 21 | [特征值与特征向量](/posts/linear-algebra-21-eigenvalues-eigenvectors/) |
| 22 | 22 | [对角化与矩阵的幂](/posts/linear-algebra-22-diagonalization-powers/) |
| 23 | 23 | [微分方程与 exp(At)](/posts/linear-algebra-23-differential-equations-exp-at/) |
| 24 | 24 | [Markov 矩阵与 Fourier 级数](/posts/linear-algebra-24-markov-fourier/) |
| 25 | 24b | [第二次测验复习](/posts/linear-algebra-24b-quiz-2-review/) |
| 26 | 25 | [对称矩阵与正定性](/posts/linear-algebra-25-symmetric-positive-definite/) |
| 27 | 26 | [复矩阵与快速 Fourier 变换](/posts/linear-algebra-26-complex-matrices-fft/) |
| 28 | 27 | [正定矩阵与极小值](/posts/linear-algebra-27-positive-definite-minima/) |
| 29 | 28 | [相似矩阵与 Jordan 标准形](/posts/linear-algebra-28-similar-matrices-jordan/) |
| 30 | 29 | [奇异值分解](/posts/linear-algebra-29-svd/) |
| 31 | 30 | [线性变换及其矩阵](/posts/linear-algebra-30-linear-transformations/) |
| 32 | 31 | [基变换与图像压缩](/posts/linear-algebra-31-change-of-basis-compression/) |
| 33 | 32 | [第三次测验复习](/posts/linear-algebra-32-quiz-3-review/) |
| 34 | 33 | [左逆、右逆与伪逆](/posts/linear-algebra-33-pseudoinverse/) |
| 35 | 34 | [期末复习](/posts/linear-algebra-34-final-review/) |

## 行图：一次看一个方程

先看 Strang 的第一个例子：

$$
\begin{aligned}
2x - y &= 0 \\
-x + 2y &= 3
\end{aligned}
\qquad
A = \begin{bmatrix} 2 & -1 \\ -1 & 2 \end{bmatrix},\
\mathbf{b} = \begin{bmatrix} 0 \\ 3 \end{bmatrix}
$$

**行图是什么？** 一次只看一行。第一个方程 $2x - y = 0$ 是 $xy$ 平面上的一条直线，过原点；第二个方程 $-x + 2y = 3$ 是另一条直线，不过原点。两条直线的交点同时满足两个方程，那就是解。

他在黑板上找了几个点：第一条线上有 $(0, 0)$、$(1, 2)$、$(\frac12, 1)$，第二条线上有 $(-3, 0)$、$(-1, 1)$、$(1, 2)$。交点是 $(1, 2)$。下面的脚本把这些点逐个代入方程，然后分别用“列的组合”和 `A @ x` 验证 $(1, 2)$：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[2.0, -1.0], [-1.0, 2.0]])
    b = np.array([0.0, 3.0])

    # 行图：每一行是 xy 平面上的一条直线，解是两条直线的交点
    for x, y in [(0.0, 0.0), (1.0, 2.0), (0.5, 1.0)]:
        print(f"({x}, {y}) 在第一条直线上：", np.isclose(2 * x - y, 0))
    for x, y in [(-3.0, 0.0), (-1.0, 1.0), (1.0, 2.0)]:
        print(f"({x}, {y}) 在第二条直线上：", np.isclose(-x + 2 * y, 3))

    # 列图：x 份第一列加 y 份第二列，凑出 b
    x = np.linalg.solve(A, b)
    combo = x[0] * A[:, 0] + x[1] * A[:, 1]
    print("解 x =", x)
    print("1 * 列一 + 2 * 列二 =", combo)

    # 矩阵形式：A @ x
    print("A @ x =", A @ x, "等于 b：", np.allclose(A @ x, b))


if __name__ == "__main__":
    main()
```

```text
(0.0, 0.0) 在第一条直线上： True
(1.0, 2.0) 在第一条直线上： True
(0.5, 1.0) 在第一条直线上： True
(-3.0, 0.0) 在第二条直线上： True
(-1.0, 1.0) 在第二条直线上： True
(1.0, 2.0) 在第二条直线上： True
解 x = [1. 2.]
1 * 列一 + 2 * 列二 = [0. 3.]
A @ x = [0. 3.] 等于 b： True
```

六个点都满足各自的方程，而 $(1, 2)$ 同时出现在两个列表里。`np.linalg.solve` 给出同样的 $\mathbf{x} = (1, 2)$。

下面这幅图把行图和下一节的列图并排画在一起：

![左：行图，两条直线交于 (1, 2)。右：列图，一份列一加两份列二首尾相接，到达 b = (0, 3)](/assets/images/linear-algebra/l01-row-column.svg)

上面这张图由下面这个脚本生成（需要 matplotlib，在当前目录写出 SVG；图中的数据与前面的代码块相同）：

```python
import matplotlib
import matplotlib.pyplot as plt
import numpy as np


def main() -> None:
    matplotlib.use("Agg")
    plt.rcParams["svg.hashsalt"] = "la1806"

    A = np.array([[2.0, -1.0], [-1.0, 2.0]])
    b = np.array([0.0, 3.0])
    x = np.linalg.solve(A, b)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 4))

    # row picture
    xs = np.linspace(-4, 3, 50)
    ax1.plot(xs, 2 * xs, label="2x - y = 0")
    ax1.plot(xs, (3 + xs) / 2, label="-x + 2y = 3")
    ax1.plot(*x, "ko")
    ax1.annotate("(1, 2)", x, textcoords="offset points", xytext=(8, -14))
    ax1.set_xlim(-4, 3)
    ax1.set_ylim(-3, 5)
    ax1.set_title("Row picture: two lines meet")
    ax1.set_xlabel("x")
    ax1.set_ylabel("y")
    ax1.legend(loc="upper left")
    ax1.grid(alpha=0.3)

    # column picture
    c1, c2 = A[:, 0], A[:, 1]
    kw = {"angles": "xy", "scale_units": "xy", "scale": 1, "width": 0.01}
    ax2.quiver(0, 0, *c1, color="C0", **kw)
    ax2.quiver(*c1, *c2, color="C1", alpha=0.5, **kw)
    ax2.quiver(*(c1 + c2), *c2, color="C1", **kw)
    ax2.quiver(0, 0, *b, color="k", **kw)
    ax2.annotate(
        "1 * col1 = (2, -1)",
        c1 / 2,
        xytext=(-30, -22),
        textcoords="offset points",
        color="C0",
    )
    ax2.annotate(
        "2 * col2 = (-2, 4)",
        c1 + c2,
        xytext=(-135, 6),
        textcoords="offset points",
        color="C1",
    )
    ax2.annotate("b = (0, 3)", b, xytext=(8, 0), textcoords="offset points")
    ax2.set_xlim(-3, 3)
    ax2.set_ylim(-2.5, 4)
    ax2.set_aspect("equal")
    ax2.set_title("Column picture: 1 * col1 + 2 * col2 = b")
    ax2.set_xlabel("first component")
    ax2.set_ylabel("second component")
    ax2.grid(alpha=0.3)

    fig.tight_layout()
    fig.savefig(
        "l01-row-column.svg",
        metadata={"Date": None},
    )


if __name__ == "__main__":
    main()
```

## 列图：一次看一列

**列图是什么？** 把同一个方程组按列写：

$$
x \begin{bmatrix} 2 \\ -1 \end{bmatrix} +
y \begin{bmatrix} -1 \\ 2 \end{bmatrix}
= \begin{bmatrix} 0 \\ 3 \end{bmatrix}
$$

方程现在问的是：左边两个向量各取几份，加起来等于右边那个向量？“取若干份再相加”叫线性组合，Strang 说这是整门课最基本的运算。

他的做法是先偷看答案：取 $x = 1$、$y = 2$。从原点画出第一列 $(2, -1)$，在箭头尖上接第二列 $(-1, 2)$，再接一次，落点就是 $(0, 3)$。上面的图右半边就是这个过程，浅色的箭头是只接了一份第二列的中间位置。两个分量分别看：第一个分量 $2 - 2 = 0$，第二个分量 $-1 + 4 = 3$。

行图和列图画的是同一个解，但它们回答的问题不一样。行图问“两条直线在哪里相交”，列图问“这些列怎么拼出 $\mathbf{b}$”。往后的内容（列空间、零空间、秩、最小二乘）几乎都是列图的问题，我猜 Strang 在第一讲就特别强调列图，是因为这个。

## 三阶：平面看不清，列还看得清

接下来是三个方程三个未知数。他选的方程组是：

$$
\begin{aligned}
2x - y &= 0 \\
-x + 2y - z &= -1 \\
-3y + 4z &= 4
\end{aligned}
\qquad
A = \begin{bmatrix} 2 & -1 & 0 \\ -1 & 2 & -1 \\ 0 & -3 & 4 \end{bmatrix},\
\mathbf{b} = \begin{bmatrix} 0 \\ -1 \\ 4 \end{bmatrix}
$$

行图里每个方程是三维空间中的一个平面。前两个平面交成一条直线，第三个平面和这条直线再交成一个点。他取第二个方程 $-x + 2y - z = -1$ 的三个点 $(1, 0, 0)$、$(0, 0, 1)$、$(0, -\frac12, 0)$ 确定平面，然后说自己不是 Rembrandt，图会是弱项。（我的图也没有强多少，所以三维的行图我一张都没画。）

列图就清楚得多。三个列向量是 $(2, -1, 0)$、$(-1, 2, -3)$、$(0, -1, 4)$，而右端项 $(0, -1, 4)$ 恰好就是第三列。所以只要取零份第一列、零份第二列、一份第三列：$\mathbf{x} = (0, 0, 1)$。三个平面的交点，行图里看不出来，列图里一眼就看出来了。

他又换了一个右端项：第一列加第二列，得到 $(1, 1, -3)$，解显然是 $(1, 1, 0)$。我把两个右端项都交给 NumPy，同时在行图和列图两种意义下验证：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[2.0, -1.0, 0.0], [-1.0, 2.0, -1.0], [0.0, -3.0, 4.0]])
    b = np.array([0.0, -1.0, 4.0])
    b_new = A[:, 0] + A[:, 1]

    for name, rhs in [("b", b), ("b_new", b_new)]:
        x = np.linalg.solve(A, rhs)
        # 行图：x 同时落在三个平面上，每个平面的残差都是 0
        row_residuals = [A[i] @ x - rhs[i] for i in range(3)]
        # 列图：三列按 x 的系数加起来
        combo = sum(x[j] * A[:, j] for j in range(3))
        print(name, "=", rhs)
        print("  x =", np.round(x, 6) + 0.0)
        print("  三个平面的残差：", np.array(row_residuals))
        print("  列的组合等于右端项：", np.allclose(combo, rhs))
        print("  A @ x 等于右端项：", np.allclose(A @ x, rhs))


if __name__ == "__main__":
    main()
```

```text
b = [ 0. -1.  4.]
  x = [0. 0. 1.]
  三个平面的残差： [0. 0. 0.]
  列的组合等于右端项： True
  A @ x 等于右端项： True
b_new = [ 1.  1. -3.]
  x = [1. 1. 0.]
  三个平面的残差： [0. 0. 0.]
  列的组合等于右端项： True
  A @ x 等于右端项： True
```

“三个平面的残差”是 $A$ 的每一行点乘 $\mathbf{x}$ 再减去右端项的对应分量，三个都是 0 说明 $\mathbf{x}$ 同时落在三个平面上。“列的组合”是三列按 $\mathbf{x}$ 的分量加权相加。同一个 $\mathbf{x}$ 通过了两种检验，因为这两句话本来就是同一个方程组的两种写法。

## 能不能填满整个空间

**这才是第一讲真正的问题：** 保持 $A$ 不变，$\mathbf{b}$ 取遍三维空间里的所有向量，$A\mathbf{x} = \mathbf{b}$ 每次都有解吗？换成列的说法：三列的所有线性组合，能不能填满整个三维空间？

对 Strang 选的这个 $A$，答案是能。它的秩是 3，行列式是 6，是他说的“好矩阵”：非奇异，可逆。

什么时候不行？三个列向量落在同一个平面里。他的例子是第三列等于第一列加第二列：这时三列的所有组合还是困在那个平面里，只有平面里的 $\mathbf{b}$ 够得着，平面外的 $\mathbf{b}$ 够不着。我就用这个办法，把上面的 $A$ 改成奇异矩阵 $S$，看看“够不着”有多远：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    A = np.array([[2.0, -1.0, 0.0], [-1.0, 2.0, -1.0], [0.0, -3.0, 4.0]])
    # 奇异的情形：第三列等于第一列加第二列，三列落在同一个平面里
    S = A.copy()
    S[:, 2] = S[:, 0] + S[:, 1]

    b_in = 2.0 * S[:, 0] - S[:, 1]  # 在平面里的右端项
    b_out = np.array([1.0, 0.0, 0.0])  # 大概率在平面外

    print("A 的秩：", np.linalg.matrix_rank(A), "，det =", np.linalg.det(A))
    print("S 的秩：", np.linalg.matrix_rank(S), "，det =", np.linalg.det(S))
    for name, rhs in [("b_in", b_in), ("b_out", b_out)]:
        x, *_ = np.linalg.lstsq(S, rhs, rcond=None)
        residual = np.linalg.norm(S @ x - rhs)
        print(f"{name}：最接近的组合的残差 = {residual:.4f}")

    # 九维：随机的 9 x 9 矩阵，与最后一列抄倒数第二列的 9 x 9 矩阵
    M = rng.standard_normal((9, 9))
    M_dup = M.copy()
    M_dup[:, 8] = M_dup[:, 7]
    print("随机 9 x 9 的秩：", np.linalg.matrix_rank(M))
    print("第九列抄第八列后的秩：", np.linalg.matrix_rank(M_dup))
    print(
        "条件数：", f"{np.linalg.cond(M):.1f}", f"{np.linalg.cond(M_dup):.1e}"
    )


if __name__ == "__main__":
    main()
```

```text
A 的秩： 3 ，det = 6.0
S 的秩： 2 ，det = 0.0
b_in：最接近的组合的残差 = 0.0000
b_out：最接近的组合的残差 = 0.4082
随机 9 x 9 的秩： 9
第九列抄第八列后的秩： 8
条件数： 127.6 3.7e+17
```

三个数字值得停一下。

- 秩从 3 掉到 2，行列式从 6.0 掉到 0.0：第三列没有给出任何新方向。
- 在平面里的右端项 $\mathbf{b}_\text{in} = 2\,\text{列一} - \text{列二}$，最小二乘能找到精确组合，残差是 0.0000。
- 平面外的 $(1, 0, 0)$，最好的组合也差 0.4082（恰好是 $1/\sqrt{6}$，也就是这个点到平面的距离），再怎么调系数都追不上。

后面几讲会再回到这里：列的所有组合构成的这个平面，叫列空间。现在先把它叫作“够得着的地方”。

他还往上推了一步：九个方程九个未知数，每一列是九维空间里的向量。如果列是随机取的，几乎一定能填满九维空间（他说用 MATLAB 的随机命令取一个 9 × 9 矩阵，保证可逆）。如果第九列抄了第八列，九个列的组合就只能填满一个八维的“平面”。代码里我用固定种子的随机矩阵验证了这两句：随机矩阵秩是 9，条件数 127.6；抄了一列之后秩是 8，条件数涨到 3.7e+17。后者比 $1/\varepsilon \approx 4.5 \times 10^{15}$（双精度的机器精度 $\varepsilon$ 约为 $2.2 \times 10^{-16}$）还大，数值上和奇异没有区别。

顺便一提一个类比：我觉得这像调色。三管颜料能混出多少种颜色，取决于三管颜料是不是真的各不相同；如果第三管恰好是前两管调出来的，你就没有多一种颜色。

## $A\mathbf{x}$ 是列的组合

最后他回到矩阵形式 $A\mathbf{x} = \mathbf{b}$，问了一个很小的问题：矩阵乘以向量，怎么乘？他的例子是

$$
\begin{bmatrix} 2 & 5 \\ 1 & 3 \end{bmatrix}
\begin{bmatrix} 1 \\ 2 \end{bmatrix}
= 1 \begin{bmatrix} 2 \\ 1 \end{bmatrix} +
2 \begin{bmatrix} 5 \\ 3 \end{bmatrix}
= \begin{bmatrix} 12 \\ 7 \end{bmatrix}
$$

他说有两种算法，他自己喜欢按列：一份第一列加两份第二列，得到 $(12, 7)$。也可以按行：每一行和 $\mathbf{x}$ 做点积，$2 \times 1 + 5 \times 2 = 12$，$1 \times 1 + 3 \times 2 = 7$。结果一样，但看法不一样，往后“列的组合”这个看法要用到底：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[2.0, 5.0], [1.0, 3.0]])
    x = np.array([1.0, 2.0])

    by_columns = x[0] * A[:, 0] + x[1] * A[:, 1]
    by_rows = np.array([A[0] @ x, A[1] @ x])
    print("按列：", by_columns)
    print("按行：", by_rows)
    print("A @ x：", A @ x)
    print(
        "三者相等：",
        np.allclose(by_columns, by_rows) and np.allclose(by_rows, A @ x),
    )

    # 反过来：右端项是 (12, 7) 时，解就是 (1, 2)
    print("解：", np.linalg.solve(A, np.array([12.0, 7.0])))


if __name__ == "__main__":
    main()
```

```text
按列： [12.  7.]
按行： [12.  7.]
A @ x： [12.  7.]
三者相等： True
解： [1. 2.]
```

按列、按行、`A @ x` 三种算法得到同一个向量。最后一行反过来把 $(12, 7)$ 当作右端项，解出来是 $(1, 2)$，和他在这一讲最后一句说的一致。

下一讲他说要讲系统地求解任意大小方程组的办法：消元。今天我们靠“特意挑过的右端项”和肉眼找到了解，下一讲就不能再靠运气了，我会把消元的每一步写成一个矩阵，见 [18.06 第 2 讲：用矩阵做消元](/posts/linear-algebra-02-elimination-with-matrices/)。
