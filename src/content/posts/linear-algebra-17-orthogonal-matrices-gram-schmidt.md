---
title: "18.06 第 17 讲：正交矩阵与 Gram-Schmidt"
commentId: "post:linear-algebra-17-orthogonal-matrices-gram-schmidt"
published: "2026-10-18 13:20:00 +08:00"
description: "MIT 18.06 第 17 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 手写了经典与修正两种 Gram-Schmidt，在 8 × 8 的 Hilbert 矩阵上，经典版的 ‖QᵀQ - I‖ 是 1.4，修正版是 3.6e-07，np.linalg.qr 是 1.5e-15。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 正交矩阵
  - Gram-Schmidt
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 17
draft: false
comment: true
slug: linear-algebra-17-orthogonal-matrices-gram-schmidt
---

这一讲是“正交”这一章的收尾，Strang 想说的其实只有一句：如果一组基两两垂直、长度为 1，那么前面几讲里所有麻烦的公式都会塌缩成点积。他的 Gram-Schmidt 例子只有两个向量，我把同样的算法写成代码，丢给 8 × 8 的 Hilbert 矩阵，结果有点出乎意料：手写的经典版算出的 $Q$ 连正交都谈不上（$\lVert Q^TQ - I \rVert = 1.4$，本该是 0），而 `np.linalg.qr` 是 $1.5 \times 10^{-15}$。

> [!NOTE] 本讲速览
> 视频：[Lecture 17: Orthogonal matrices and Gram-Schmidt](https://www.youtube.com/watch?v=0MtwqhIwdrI)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-17-orthogonal-matrices-and-gram-schmidt/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §4.4 Orthonormal Bases and Gram-Schmidt
> 前置：[第 16 讲：投影矩阵与最小二乘](/posts/linear-algebra-16-least-squares/)
> 一句话：列向量标准正交的 $Q$ 满足 $Q^TQ = I$，投影和最小二乘都不用求逆；Gram-Schmidt 把任意一组无关的列变成这样的 $Q$，用矩阵写出来就是 $A = QR$，$R$ 是上三角矩阵。

> [!TIP] 配合视频
> - 开头他在抱怨“orthonormal matrix”这个名字没人用，只有方阵才叫 orthogonal matrix。这段是在定义术语，值得听一遍，后面的符号全靠它。接下来的置换、旋转、Hadamard 例子本篇已经验证过，可以倍速。
> - 他回头把投影公式 $Q(Q^TQ)^{-1}Q^T$ 简化成 $QQ^T$、把正规方程简化成 $\hat{x} = Q^T\mathbf{b}$ 的那几分钟要认真看，这是“为什么要有 $Q$”的全部理由。
> - 讲 Gram-Schmidt 的一段（他先画 $\mathbf{a}$ 和 $\mathbf{b}$，再算 $(1,1,1)$ 和 $(1,0,2)$）建议跟着他在纸上做一遍，我用代码只是对答案。
> - 最后几句话讲 $A = QR$ 为什么 $R$ 是上三角，说得很快，教材里写得更完整。

## 正交基与正交矩阵

先把名字说清楚。向量 $\mathbf{q}_1, \dots, \mathbf{q}_n$ 如果满足

$$
\mathbf{q}_i^T\mathbf{q}_j =
\begin{cases}
0 & i \ne j \\
1 & i = j
\end{cases}
$$

就叫标准正交（orthonormal）：两两垂直，长度为 1。把它们当列放进矩阵 $Q$，$Q^TQ$ 的第 $(i, j)$ 个元素正好是 $\mathbf{q}_i^T\mathbf{q}_j$，所以

$$
Q^TQ = I
$$

这里 $Q$ 不必是方阵。两列、每列四个分量也行，只要列标准正交，$Q^TQ$ 就是单位矩阵。**什么时候才叫正交矩阵？** Strang 吐槽过这个约定：叫“标准正交矩阵”本来最贴切，但习惯上只有方阵才叫正交矩阵。方阵的情形有额外的好处：$Q^TQ = I$ 说明 $Q^T$ 就是 $Q^{-1}$，逆矩阵不用算，转置一下就是。

他在黑板上给了一串例子，我挑着写成同一个检查脚本：

- 置换矩阵：把 1 放在不同位置，列当然垂直，长度当然是 1。他自己说这个例子“太容易了”。
- 旋转矩阵 $\begin{bmatrix} \cos\theta & -\sin\theta \\ \sin\theta & \cos\theta \end{bmatrix}$。$\begin{bmatrix} 1 & 1 \\ 1 & -1 \end{bmatrix}$ 的两列垂直，但长度是 $\sqrt{2}$，除以 $\sqrt{2}$ 之后它就是 $\theta = \pi/4$ 的旋转加一个翻转（他说“大概是 $-\pi/4$ 之类的”，符号他没细究）。
- Hadamard 矩阵：把上面的 2 × 2 放在左上角，重复到右上和左下，右下角取负，每列长度是 2，所以除以 2。（字幕里把名字转写成了 Adhemar，我猜是 Hadamard 被听岔了。）他说 2、4、16、64 阶都知道怎么造，哪些阶数存在这样的 $\pm 1$ 矩阵，至今没有完全搞清。
- 矩形的例子：两列 $(1, 2, 2)$ 和 $(-2, -1, 2)$，每列长度是 $\sqrt{1 + 4 + 4} = 3$，所以除以 3。他还想再凑一个第三列，让整个 3 × 3 矩阵没有平方根，试着用 $1, 2, 2$ 的模式调符号。我取 $(2, -2, 1)$ 做第三列，三对点积都是 0。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    theta = np.pi / 4
    examples = {
        "置换矩阵": np.array(
            [[0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
        ),
        "旋转 pi/4": np.array(
            [
                [np.cos(theta), -np.sin(theta)],
                [np.sin(theta), np.cos(theta)],
            ]
        ),
        "[[1, 1], [1, -1]] / sqrt(2)": np.array([[1.0, 1.0], [1.0, -1.0]])
        / np.sqrt(2),
        "4 x 4 Hadamard / 2": np.array(
            [
                [1.0, 1.0, 1.0, 1.0],
                [1.0, -1.0, 1.0, -1.0],
                [1.0, 1.0, -1.0, -1.0],
                [1.0, -1.0, -1.0, 1.0],
            ]
        )
        / 2.0,
        "3 x 3，元素 1, 2, 2 / 3": np.array(
            [[1.0, -2.0, 2.0], [2.0, -1.0, -2.0], [2.0, 2.0, 1.0]]
        )
        / 3.0,
    }
    for name, Q in examples.items():
        identity = np.eye(Q.shape[1])
        ok = np.allclose(Q.T @ Q, identity)
        inv_ok = np.allclose(np.linalg.inv(Q), Q.T)
        print(f"{name}：Q^T Q = I {ok}，Q^-1 = Q^T {inv_ok}")

    # 矩形的例子：两列，三个分量
    Q = np.array([[1.0, -2.0], [2.0, -1.0], [2.0, 2.0]]) / 3.0
    print("矩形 3 x 2：Q^T Q = I", np.allclose(Q.T @ Q, np.eye(2)))
    print("矩形 3 x 2：Q Q^T = I", np.allclose(Q @ Q.T, np.eye(3)))
    P = Q @ Q.T
    print("P = Q Q^T 对称：", np.allclose(P, P.T))
    print("P @ P = P：", np.allclose(P @ P, P))

    # 投影：正规方程 Q^T Q x = Q^T b 退化成 x = Q^T b
    b = np.array([1.0, 2.0, 3.0])
    x = Q.T @ b
    x_ls, *_ = np.linalg.lstsq(Q, b, rcond=None)
    print("x = Q^T b =", x)
    print("lstsq 给出的 x =", x_ls, np.allclose(x, x_ls))
    print("投影 P @ b =", P @ b, "，Q @ x =", Q @ x)


if __name__ == "__main__":
    main()
```

```text
置换矩阵：Q^T Q = I True，Q^-1 = Q^T True
旋转 pi/4：Q^T Q = I True，Q^-1 = Q^T True
[[1, 1], [1, -1]] / sqrt(2)：Q^T Q = I True，Q^-1 = Q^T True
4 x 4 Hadamard / 2：Q^T Q = I True，Q^-1 = Q^T True
3 x 3，元素 1, 2, 2 / 3：Q^T Q = I True，Q^-1 = Q^T True
矩形 3 x 2：Q^T Q = I True
矩形 3 x 2：Q Q^T = I False
P = Q Q^T 对称： True
P @ P = P： True
x = Q^T b = [3.6667 0.6667]
lstsq 给出的 x = [3.6667 0.6667] True
投影 P @ b = [0.7778 2.2222 2.8889] ，Q @ x = [0.7778 2.2222 2.8889]
```

五个方阵都满足 $Q^TQ = I$，而且 `np.linalg.inv(Q)` 和 `Q.T` 一致，这就是“逆就是转置”。矩形的 3 × 2 矩阵不一样：$Q^TQ = I$ 成立，但 $QQ^T = I$ 不成立。道理很直接，三维空间里只有两个方向，填不满，所以 $QQ^T$ 不可能是 $3 \times 3$ 的单位矩阵。它是什么呢？接着往下看。

## 为什么 Q 好用：投影只剩转置

前两讲的投影矩阵是 $A(A^TA)^{-1}A^T$。Strang 开玩笑说，这是“一行里四个 $A$”。现在列向量标准正交，把 $A$ 换成 $Q$：

$$
P = Q(Q^TQ)^{-1}Q^T = QQ^T
$$

中间那个 $Q^TQ$ 就是单位矩阵，求逆没了。他顺手验证了投影矩阵的两条性质：对称（$QQ^T$ 转置之后还是自己），以及投影两次等于一次，$(QQ^T)(QQ^T) = Q(Q^TQ)Q^T = QQ^T$，中间的 $Q^TQ = I$ 一抵消就得到。如果 $Q$ 是方阵，列空间就是整个空间，投影到整个空间什么都不用动，所以 $QQ^T = I$，这正是上面“方阵的逆就是转置”的另一种说法。

正规方程也一样。原来是 $A^TA\hat{x} = A^T\mathbf{b}$，要把一堆“笨拙的内积”算出来再解方程组；现在是

$$
Q^TQ\hat{x} = Q^T\mathbf{b} \quad\Longrightarrow\quad \hat{x} = Q^T\mathbf{b}
$$

$\hat{x}$ 的第 $i$ 个分量就是 $\mathbf{q}_i^T\mathbf{b}$，一个点积。他说这大概是数学很多分支里最重要的一个公式：有了标准正交基，一个向量在每个方向上的分量，就是它和这个方向的点积。（之后的 Fourier 级数用的就是这一条，只是“向量”换成了函数。）

上面那段脚本最后几行对这两件事做了数值验证：$P = QQ^T$ 对称，$P^2 = P$；用 $\hat{x} = Q^T\mathbf{b}$ 得到的 $(3.6667, 0.6667)$ 和 `np.linalg.lstsq` 给出的完全一致，$P\mathbf{b}$ 与 $Q\hat{x}$ 也一致，都是 $(0.7778, 2.2222, 2.8889)$。同一个答案，一个要解方程组，一个只做了两次点积。

他还提到一点：标准正交的向量一定线性无关，因为互相垂直，没有任何组合能凑出零。反过来就不一定了，所以下面要做的事才有意义。

## Gram-Schmidt：把投影扔掉

**如果给我的向量不是标准正交的呢？** 这是后半讲的问题：已知无关的 $\mathbf{a}, \mathbf{b}$，想得到标准正交的 $\mathbf{q}_1, \mathbf{q}_2$。他的做法分两步，先造垂直的，最后再统一除以长度（他说“除以长度是 Schmidt 的贡献”，语气是玩笑）。

为了不和矩阵 $A$ 混淆，下面把他黑板上的大写向量写成粗体 $\mathbf{A}, \mathbf{B}, \mathbf{C}$。第一个方向无所谓，$\mathbf{A} = \mathbf{a}$。第二个方向要从 $\mathbf{b}$ 里把平行于 $\mathbf{A}$ 的那一块拿掉，剩下的就是垂直部分，也就是讲投影时的误差向量 $\mathbf{e}$：

$$
\mathbf{B} = \mathbf{b} - \frac{\mathbf{A}^T\mathbf{b}}{\mathbf{A}^T\mathbf{A}}\,\mathbf{A}
$$

检查一下：两边左乘 $\mathbf{A}^T$，第一项是 $\mathbf{A}^T\mathbf{b}$，第二项减掉的也是 $\mathbf{A}^T\mathbf{b}$，所以 $\mathbf{A}^T\mathbf{B} = 0$。第三个向量 $\mathbf{c}$ 要同时扣掉 $\mathbf{A}$ 和 $\mathbf{B}$ 方向的分量：

$$
\mathbf{C} = \mathbf{c} - \frac{\mathbf{A}^T\mathbf{c}}{\mathbf{A}^T\mathbf{A}}\,\mathbf{A} - \frac{\mathbf{B}^T\mathbf{c}}{\mathbf{B}^T\mathbf{B}}\,\mathbf{B}
$$

他的数值例子是 $\mathbf{a} = (1, 1, 1)$，$\mathbf{b} = (1, 0, 2)$。他先算 $\mathbf{a}^T\mathbf{b}$，发现是 3，又算 $\mathbf{a}^T\mathbf{a}$，也是 3，他自己都笑了：“没想到会这样”。投影系数是 1，所以 $\mathbf{B} = (1, 0, 2) - (1, 1, 1) = (0, -1, 1)$。然后 $\mathbf{A}$ 除以 $\sqrt{3}$，$\mathbf{B}$ 除以 $\sqrt{2}$，得到

$$
Q = \begin{bmatrix}
1/\sqrt{3} & 0 \\
1/\sqrt{3} & -1/\sqrt{2} \\
1/\sqrt{3} & 1/\sqrt{2}
\end{bmatrix}
$$

他还特别问了一个问题：$A$ 和 $Q$ 的列空间是什么关系？答案是同一个平面。$\mathbf{B}$ 是 $\mathbf{b}$ 和 $\mathbf{a}$ 的组合，我们始终没有离开原来的空间，只是把基掰成了直角。

## A = QR：Gram-Schmidt 的矩阵形式

他拿消元类比：消元学完之后，有人告诉你“用矩阵写就是 $A = LU$”。Gram-Schmidt 也有一个这样的矩阵形式，$A = QR$。$A$ 的列是原来的向量，$Q$ 的列是标准正交的新向量，两者有相同的列空间，所以 $A$ 的每一列都是 $Q$ 的列的组合，组合系数放进 $R$：

$$
\begin{bmatrix} \mathbf{a}_1 & \mathbf{a}_2 \end{bmatrix}
= \begin{bmatrix} \mathbf{q}_1 & \mathbf{q}_2 \end{bmatrix}
\begin{bmatrix}
\mathbf{q}_1^T\mathbf{a}_1 & \mathbf{q}_1^T\mathbf{a}_2 \\
\mathbf{q}_2^T\mathbf{a}_1 & \mathbf{q}_2^T\mathbf{a}_2
\end{bmatrix}
$$

$R$ 的元素就是点积，这是 $\hat{x} = Q^T\mathbf{b}$ 的又一次出场。他最后说的要点：$\mathbf{q}_2^T\mathbf{a}_1 = 0$，因为每个新 $\mathbf{q}$ 都是对前面所有向量垂直造出来的，所以 $R$ 的左下角为零，$R$ 是上三角矩阵。他在课上只口头猜了 $R$ 的元素，没有写出数值，并说为什么 $R$ 是上三角，请去书里看。我用代码算了：

```python
import numpy as np


def gram_schmidt(A: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """经典 Gram-Schmidt，返回 Q 和 R。"""
    n = A.shape[1]
    Q = np.zeros_like(A)
    R = np.zeros((n, n))
    for j in range(n):
        v = A[:, j].copy()
        for i in range(j):
            R[i, j] = Q[:, i] @ A[:, j]
            v -= R[i, j] * Q[:, i]
        R[j, j] = np.linalg.norm(v)
        Q[:, j] = v / R[j, j]
    return Q, R


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[1.0, 1.0], [1.0, 0.0], [1.0, 2.0]])
    a, b = A[:, 0], A[:, 1]

    # 按 Strang 在黑板上的步骤
    B = b - (a @ b) / (a @ a) * a
    print("a^T b =", a @ b, "，a^T a =", a @ a)
    print("B =", B, "，a^T B =", a @ B)

    Q, R = gram_schmidt(A)
    print("Q =")
    print(np.round(Q, 6) + 0.0)
    print("R =")
    print(R)
    print("A = QR：", np.allclose(Q @ R, A))
    print("Q^T Q = I：", np.allclose(Q.T @ Q, np.eye(2)))

    # 两个列空间相同：Q 的列可以由 A 的列组合出来，反过来也行
    both = np.hstack([A, Q])
    print("[A Q] 的秩：", np.linalg.matrix_rank(both))

    # 和 NumPy 自带的 QR 对比，符号可能整列相反
    Q_np, R_np = np.linalg.qr(A)
    print("np.linalg.qr 的 R =")
    print(R_np)
    signs = np.sign(np.diag(R_np))
    print("统一符号后 Q 相同：", np.allclose(Q_np * signs, Q))
    print("统一符号后 R 相同：", np.allclose(R_np * signs[:, None], R))


if __name__ == "__main__":
    main()
```

```text
a^T b = 3.0 ，a^T a = 3.0
B = [ 0. -1.  1.] ，a^T B = 0.0
Q =
[[ 0.5774  0.    ]
 [ 0.5774 -0.7071]
 [ 0.5774  0.7071]]
R =
[[1.7321 1.7321]
 [0.     1.4142]]
A = QR： True
Q^T Q = I： True
[A Q] 的秩： 2
np.linalg.qr 的 R =
[[-1.7321 -1.7321]
 [ 0.      1.4142]]
统一符号后 Q 相同： True
统一符号后 R 相同： True
```

几件事值得一看。

- $\mathbf{a}^T\mathbf{b} = \mathbf{a}^T\mathbf{a} = 3$，和他黑板上的一模一样，$\mathbf{B} = (0, -1, 1)$，$\mathbf{a}^T\mathbf{B} = 0$。
- $R = \begin{bmatrix} \sqrt{3} & \sqrt{3} \\ 0 & \sqrt{2} \end{bmatrix}$，左下角确实是 0。对角线是 $\mathbf{A}$ 和 $\mathbf{B}$ 的长度。
- $[A\ Q]$ 的秩还是 2：把 $Q$ 的两列拼到 $A$ 旁边，没有多出新方向，说明列空间是同一个。
- `np.linalg.qr` 给出的 $R$ 对角线是负的（$-1.7321$），$Q$ 的对应列也反号。$A = QR$ 的分解并不是唯一的，把 $Q$ 的某一列和 $R$ 的对应行同时乘 $-1$ 之后还是一个分解，LAPACK 的 Householder 实现碰巧选了另一种符号。统一符号之后，$Q$ 和 $R$ 都和我手写的一致。

## 经典与修正：同一个公式，两种舍入

这一段是课上没有讲的，我自己加的实验。（他的例子只有两个向量，看不出差别。）

上面手写的版本，对第 $j$ 列，是拿原来的 $\mathbf{a}_j$ 分别减去它在 $\mathbf{q}_1, \dots, \mathbf{q}_{j-1}$ 上的分量。教科书上叫经典 Gram-Schmidt。数学上还有一种写法，每减掉一个方向，就用减过之后的向量去算下一个投影系数，叫修正 Gram-Schmidt（modified Gram-Schmidt）。在精确运算里，两种写法一模一样，差别只在浮点：经典版的 $\mathbf{q}_i^T\mathbf{a}_j$ 用的是没有被修正过的原向量，前面的舍入误差没有机会被后面的步骤“看见”。

测试矩阵我选了随机矩阵和 Hilbert 矩阵 $H_{ij} = 1/(i + j - 1)$，后者是线性代数里的经典病态矩阵，列几乎共线。度量标准是 $\lVert Q^TQ - I \rVert$（Frobenius 范数）：如果 $Q$ 真的标准正交，它应该在 $10^{-15}$ 左右。（拿 Hilbert 矩阵折磨 Gram-Schmidt，有点不厚道，但病态矩阵本来就是干这个用的。）

```python
import numpy as np


def classical(A: np.ndarray) -> np.ndarray:
    """经典 Gram-Schmidt：用原来的 a_j 去减每个 q_i 上的分量。"""
    Q = np.zeros_like(A)
    for j in range(A.shape[1]):
        v = A[:, j].copy()
        for i in range(j):
            v -= (Q[:, i] @ A[:, j]) * Q[:, i]
        Q[:, j] = v / np.linalg.norm(v)
    return Q


def modified(A: np.ndarray) -> np.ndarray:
    """修正 Gram-Schmidt：每减掉一个方向，就用减过的 v 继续。"""
    Q = np.zeros_like(A)
    for j in range(A.shape[1]):
        v = A[:, j].copy()
        for i in range(j):
            v -= (Q[:, i] @ v) * Q[:, i]
        Q[:, j] = v / np.linalg.norm(v)
    return Q


def main() -> None:
    rng = np.random.default_rng(1806)
    n = 12
    mats = {
        "random 12x12": rng.standard_normal((n, n)),
        "Hilbert 8x8": 1.0 / (np.arange(8)[:, None] + np.arange(8) + 1.0),
        "Hilbert 12x12": 1.0 / (np.arange(n)[:, None] + np.arange(n) + 1.0),
    }
    header = ["matrix", "cond", "classical", "modified", "np QR"]
    print(f"{header[0]:<16}" + "".join(f"{h:>12}" for h in header[1:]))
    for name, A in mats.items():
        k = A.shape[1]
        identity = np.eye(k)
        errs = []
        for Q in (classical(A), modified(A), np.linalg.qr(A)[0]):
            errs.append(np.linalg.norm(Q.T @ Q - identity))
        cond = np.linalg.cond(A)
        print(
            f"{name:<16}{cond:>10.1e}"
            f"{errs[0]:>12.1e}{errs[1]:>12.1e}{errs[2]:>12.1e}"
        )


if __name__ == "__main__":
    main()
```

```text
matrix                  cond   classical    modified       np QR
random 12x12       9.5e+01     2.3e-14     5.0e-15     2.1e-15
Hilbert 8x8        1.5e+10     1.4e+00     3.6e-07     1.5e-15
Hilbert 12x12      1.8e+16     5.5e+00     3.3e-01     2.1e-15
```

- 随机的 12 × 12 矩阵条件数只有 95，三种方法都不错：经典 $2.3 \times 10^{-14}$，修正 $5.0 \times 10^{-15}$，`np.linalg.qr` $2.1 \times 10^{-15}$。
- Hilbert 8 × 8，条件数 $1.5 \times 10^{10}$：经典版 1.4，$Q$ 已经不是正交矩阵；修正版 $3.6 \times 10^{-7}$，差了约 $4 \times 10^6$ 倍；`np.linalg.qr` 仍然是 $1.5 \times 10^{-15}$，比经典版小了 15 个数量级。
- Hilbert 12 × 12，条件数 $1.8 \times 10^{16}$，超过了 $1/\varepsilon \approx 4.5 \times 10^{15}$：经典 5.5，修正 0.33，`np.linalg.qr` 还是 $2.1 \times 10^{-15}$。修正版也败了，只是败得没那么惨。

据我所知，`np.linalg.qr` 底层调用的是 LAPACK 的 Householder 反射，它不是在“扣投影”，而是把 $A$ 逐列乘上一连串的正交矩阵变成上三角，每一步本身就是正交变换，所以 $Q$ 的正交性不依赖于 $A$ 的条件数。我没有读 LAPACK 源码，这个解释来自教科书。读到这里你大概能猜到数值线性代数里为什么很少有人直接用 Gram-Schmidt 去分解大矩阵，但它依然是理解 $A = QR$ 的最短路径：$R$ 的每个元素是什么、为什么是上三角，Gram-Schmidt 一眼就能看出来。

## 在控制里

旋转矩阵是正交矩阵，而且行列式是 $+1$。第 4 篇卡尔曼滤波里的姿态表示就是这样（见 [姿态的数学：旋转、四元数与 IMU 仿真器](/posts/kalman-filter-04-attitude-imu/) 里的 SO(3) 一节）：机体系到世界系的 $C$ 满足 $C^TC = I$，所以反过来转换只需转置，旋转之后向量的长度不变。这些在上面验证过，下面的脚本再用两个旋转的乘积确认一次。

麻烦出在积分上：姿态是一次一次乘上去的小旋转，每乘一次，舍入误差就会让 $C$ 离正交更远一点。我用 `float32` 把一个很小的旋转连乘 100000 次，$\lVert C^TC - I \rVert$ 涨到 $6.78 \times 10^{-3}$，“逆就是转置”已经不再严格成立。补救办法是对 $C$ 做一次 QR，取 $Q$（再按 $R$ 对角线的符号对齐，让行列式保持 $+1$），拉回之后的正交误差是 $4.26 \times 10^{-16}$，代价是姿态被改了 $3.45 \times 10^{-3}$（Frobenius 范数）。

```python
import numpy as np


def rot_z(angle: float) -> np.ndarray:
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def rot_y(angle: float) -> np.ndarray:
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    C = rot_z(0.3) @ rot_y(-0.5)
    v = np.array([1.0, 2.0, 3.0])
    print("C^T C = I：", np.allclose(C.T @ C, np.eye(3)))
    print("det C =", round(float(np.linalg.det(C)), 6))
    len_v, len_Cv = np.linalg.norm(v), np.linalg.norm(C @ v)
    print(f"|v| = {len_v:.6f}，|C v| = {len_Cv:.6f}")

    # 每一步乘一个带舍入误差的小旋转，累积 100000 次，看正交性漂移
    step = rot_z(0.001) @ rot_y(0.0007)
    C32 = np.eye(3, dtype=np.float32)
    step32 = step.astype(np.float32)
    for _ in range(100_000):
        C32 = C32 @ step32
    I3 = np.eye(3)
    drift = np.linalg.norm(C32.T.astype(np.float64) @ C32 - I3)
    print(f"float32 连乘 100000 次后 |C^T C - I| = {drift:.2e}")

    # 用 QR 把它拉回最近的正交矩阵（符号对齐，保持行列式为正）
    Q, R = np.linalg.qr(C32.astype(np.float64))
    Q = Q * np.sign(np.diag(R))
    print(f"QR 之后 |Q^T Q - I| = {np.linalg.norm(Q.T @ Q - I3):.2e}")
    print(f"拉回的距离 |Q - C32| = {np.linalg.norm(Q - C32):.2e}")
    print("det Q =", round(float(np.linalg.det(Q)), 6))


if __name__ == "__main__":
    main()
```

```text
C^T C = I： True
det C = 1.0
|v| = 3.741657，|C v| = 3.741657
float32 连乘 100000 次后 |C^T C - I| = 6.78e-03
QR 之后 |Q^T Q - I| = 4.26e-16
拉回的距离 |Q - C32| = 3.45e-03
det Q = 1.0
```

严格地说，QR 给出的是一个正交矩阵，不一定是离 $C$ 最近的那个，最近的要用后面几讲的 SVD 来求。（我没有拿它和别的重正交化方案做过比较，实际工程里怎么选我不确定。）另外，那一篇的 TRIAD 把两个方向观测变成正交标架，用的是叉积：$\mathbf{t}_1 = \mathbf{v}_1$，$\mathbf{t}_2 \propto \mathbf{v}_1 \times \mathbf{v}_2$，$\mathbf{t}_3 = \mathbf{t}_1 \times \mathbf{t}_2$。三维里叉积是 Gram-Schmidt 的一个捷径，它直接给出“垂直于前两个”的方向，不用减投影。

投影、$A = QR$ 这些都是在“垂直”这个概念上打转，正交这一章到此为止。下一讲换一个词：行列式。一个方阵有没有逆，能不能用一个数回答？见 [18.06 第 18 讲：行列式的性质](/posts/linear-algebra-18-determinant-properties/)。
