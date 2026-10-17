---
title: "18.06 第 26 讲：复矩阵与快速 Fourier 变换"
commentId: "post:linear-algebra-26-complex-matrices-fft"
published: "2026-10-18 16:40:00 +08:00"
description: "MIT 18.06 第 26 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 验证了归一化的 Fourier 矩阵是酉矩阵，又手写了递归 FFT，n = 1024 时乘法次数从 1048576 降到 5120，差 204.8 倍。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 复矩阵
  - FFT
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 27
draft: false
comment: true
slug: linear-algebra-26-complex-matrices-fft
---

这一讲有两个想法。第一，向量一旦有了复数分量，凡是“转置”都要顺手取共轭，$\mathbf{z}^T\mathbf{z}$ 就换成 $\mathbf{z}^H\mathbf{z}$。第二，Fourier 矩阵 $F_n$ 是满矩阵，乘一次要 $n^2$ 次乘法，但它能拆成两个一半大小的 $F_{n/2}$ 加几个几乎全是零的因子。我手写了这个递归：$n = 1024$ 时，$n^2 = 1048576$ 次乘法被压到 5120 次，比值 204.8。Strang 在黑板上算 $2^{10}$ 的时候说“大约 200 倍”，代码给的数是 204.8。

> [!NOTE] 本讲速览
> 视频：[Lecture 26: Complex matrices; fast fourier transform](https://www.youtube.com/watch?v=M0Sa8fLOajA)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-26-complex-matrices-fast-fourier-transform/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §6.4 Complex Numbers and Vectors and Matrices（FFT 在第 6 版目录里没有独立小节，我没有找到对应的页码，所以不标）
> 前置：[第 25 讲：对称矩阵与正定性](/posts/linear-algebra-25-symmetric-positive-definite/)
> 一句话：复数世界里把“转置”换成“共轭转置”，Fourier 矩阵就成了酉矩阵，逆矩阵就是它的共轭转置；而把它拆成偶数项和奇数项两半，乘法次数从 $n^2$ 降到 $\frac{1}{2}n\log_2 n$。

> [!TIP] 配合视频
> - 开头几分钟是动机：特征值可能是复数，所以复数迟早要进来。这一段字幕里讲得很直白，可以倍速。
> - 他讲 $\mathbf{z}^T\mathbf{z}$ 为什么不行的那段（向量 $(1, i)$ 的“长度”居然是 0）很短，值得认真听；Hermitian 矩阵和酉矩阵只是改了两个词，本篇第一节已经用代码算过。
> - 他在黑板上写 $F_4$、检查两列正交时当场卡了一下，然后想起要取共轭。这段看着有点乱，但它恰好是整讲最容易犯错的地方，别跳。
> - 最后一段的 $F_{64}$ 到 $F_{32}$ 的分解是重点，建议先看完再回来读本篇第三、第四节；他最后算 $2^{10}$ 的那几句，我在第四节用代码重算了一遍。

## 复向量：长度、内积与 Hermitian 矩阵

复数是被特征值带进这门课的：即使矩阵的元素全是实数，特征值也可能是复数，比如把平面旋转 $90°$ 的矩阵，特征值是 $\pm i$，对应的特征向量也是复向量。他说迟早要正面看一次：向量和矩阵的元素变成复数以后，哪些定义要改，哪些不用改。答案是只改一件事，下面从长度开始。

**复向量的长度怎么算？** 他的做法是先给一个反例。取 $\mathbf{z} = (1, i)$，如果照老办法算 $\mathbf{z}^T\mathbf{z}$，得到 $1 \cdot 1 + i \cdot i = 0$，一个非零向量的长度平方居然是零。问题出在 $i^2 = -1$。他的修正是：每个分量先取共轭再相乘，$\bar{z}_1 z_1 + \cdots + \bar{z}_n z_n = |z_1|^2 + \cdots + |z_n|^2$，这样每一项都不是负数。

所以规则只有一条：只要转置，就同时取共轭。他用一个符号 $H$ 同时表示这两件事（取自 Hermite，他顺便说这位先生自己不发 H 的音）：

$$
\mathbf{z}^H = \bar{\mathbf{z}}^T,\qquad
\|\mathbf{z}\|^2 = \mathbf{z}^H\mathbf{z},\qquad
\text{内积 } \mathbf{y}^H\mathbf{x}
$$

内积一般是复数，交换两个向量的位置得到的是共轭：$\mathbf{x}^H\mathbf{y} = \overline{\mathbf{y}^H\mathbf{x}}$。

同样的规则改写了另外两个词。“对称”（$A^T = A$）对复矩阵不再合适，要换成 $A^H = A$，叫 Hermitian 矩阵。他的例子是

$$
A = \begin{bmatrix} 2 & 3 + i \\ 3 - i & 5 \end{bmatrix}
$$

对角线必须是实数（翻过去再取共轭还得回到原位），非对角线上的 $3 + i$ 和 $3 - i$ 互为共轭。“正交矩阵”（$Q^TQ = I$）换成 $Q^HQ = I$，叫酉矩阵（unitary）。Hermitian 矩阵的特征值是实数，特征向量互相垂直，这是上一讲实对称矩阵那套结论的复数版本。

下面的脚本把这几件事都算一遍。NumPy 里 `np.vdot(y, x)` 正好是 $\mathbf{y}^H\mathbf{x}$（第一个参数取共轭），`np.linalg.eigh` 是专门给 Hermitian 矩阵用的特征值求解器：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 复向量的长度：z^T z 不行，要用 z^H z
    z = np.array([1.0, 1.0j])
    print("z^T z =", z @ z)
    print("z^H z =", z.conj() @ z, "，长度 =", np.linalg.norm(z))

    # 内积 y^H x 一般是复数，np.vdot 会对第一个参数取共轭
    y = np.array([1.0 + 2.0j, 3.0])
    x = np.array([2.0, 1.0 - 1.0j])
    print("y^H x =", np.vdot(y, x), "，x^H y =", np.vdot(x, y))

    # Hermitian 矩阵：对角线是实数，转置后取共轭等于自己
    A = np.array([[2.0, 3.0 + 1.0j], [3.0 - 1.0j, 5.0]])
    print("A^H = A：", np.allclose(A.conj().T, A))
    lam, Q = np.linalg.eigh(A)
    print("特征值（实数）：", np.round(lam, 6) + 0.0)
    print("Q^H Q = I：", np.allclose(Q.conj().T @ Q, np.eye(2)))
    print("A = Q Λ Q^H：", np.allclose(Q @ np.diag(lam) @ Q.conj().T, A))
    print("两个特征向量的内积：", np.abs(np.vdot(Q[:, 0], Q[:, 1])))


if __name__ == "__main__":
    main()
```

```text
z^T z = 0j
z^H z = (2+0j) ，长度 = 1.4142135623730951
y^H x = (5-7j) ，x^H y = (5+7j)
A^H = A： True
特征值（实数）： [0. 7.]
Q^H Q = I： True
A = Q Λ Q^H： True
两个特征向量的内积： 1.457167719820518e-16
```

三处输出对应三个结论。`z^T z = 0j`，而 `z^H z = 2`，长度是 $\sqrt{2}$，和他在黑板上写的完全一致。$\mathbf{y}^H\mathbf{x} = 5 - 7i$，反过来 $\mathbf{x}^H\mathbf{y} = 5 + 7i$，互为共轭。他的 Hermitian 矩阵 $A$ 的特征值是 0 和 7：迹是 $2 + 5 = 7$，行列式是 $10 - (3 + i)(3 - i) = 10 - 10 = 0$，两个数都对得上；`eigh` 给出的两个特征向量内积的模是 $1.5 \times 10^{-16}$，就是舍入误差。

这里有个我自己踩过的坑：写 `a @ b` 的时候，NumPy 不会替你取共轭。复向量的内积忘了 `.conj()`，程序不报错，只是答案不对。

## Fourier 矩阵：满矩阵，却有正交的列

**Fourier 矩阵是什么样的？** 他先宣布一个约定：下标从 0 数起，因为电气系这么数（数学系从 1 开始；我是写代码的，毫无悬念站电气系）。$n \times n$ 的 Fourier 矩阵第 $(j, k)$ 项是 $w^{jk}$，其中

$$
w = e^{2\pi i/n},\qquad w^n = 1
$$

$w$ 落在复平面的单位圆上，是圆周的 $n$ 分之一。他取 $n = 6$ 画了六个点，每个是上一个转 $60°$，$w^6$ 回到 1，它们是 1 的六个六次方根，$w$ 是第一个，叫本原的。取 $n = 4$ 更方便：$w = e^{i\pi/2} = i$，各次幂是 $i, -1, -i, 1$，于是

$$
F_4 = \begin{bmatrix}
1 & 1 & 1 & 1 \\
1 & i & i^2 & i^3 \\
1 & i^2 & i^4 & i^6 \\
1 & i^3 & i^6 & i^9
\end{bmatrix}
= \begin{bmatrix}
1 & 1 & 1 & 1 \\
1 & i & -1 & -i \\
1 & -1 & 1 & -1 \\
1 & -i & -1 & i
\end{bmatrix}
$$

指数就是行号乘列号。它是满矩阵，一个零都没有，乘一次向量要 16 次乘法；一般地是 $n^2$ 次。

**它的列为什么正交？** 看第 1 列 $(1, i, -1, -i)$ 与第 3 列 $(1, -i, -1, i)$。他的第一反应是直接逐项相乘：$1 \cdot 1 + i(-i) + (-1)(-1) + (-i)(i) = 1 + 1 + 1 + 1 = 4$，看上去不是零。然后他想起来要给其中一列取共轭，第 1 列变成 $(1, -i, -1, i)$，再逐项相乘：$1 + (-i)(-i) + (-1)(-1) + i \cdot i = 1 - 1 + 1 - 1 = 0$。这个“看上去不是零，其实是零”的瞬间，就是复内积和实内积的差别。每一列的长度平方是 4，所以除以 2 就是标准正交列：$\frac{1}{2}F_4$ 是酉矩阵，$F_4^HF_4 = 4I$，逆矩阵就是共轭转置除以 4。

我把这些全部交给 NumPy，同时也检查 $n = 4, 16, 64, 256$ 的归一化版本 $F_n/\sqrt{n}$，并确认它和 `np.fft` 的关系。后一点很实用：NumPy 的 `fft` 用的是 $e^{-2\pi i jk/n}$（负号），Strang 用的是正号，所以他的 $F_n \mathbf{x}$ 等于 NumPy 的 `n * ifft(x)`：

```python
import numpy as np


def fourier(n: int) -> np.ndarray:
    """返回 Strang 约定的 Fourier 矩阵：F[j, k] = w^(j k)，w = e^(2 pi i/n)。"""
    w = np.exp(2j * np.pi / n)
    j = np.arange(n)
    return w ** (np.outer(j, j) % n)


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    F = fourier(4)
    print("F4 =")
    print(np.round(F, 4) + 0.0)

    # 第 1 列和第 3 列：直接相乘不是 0，取共轭之后是 0
    print("列 1 与列 3，不取共轭：", np.round(F[:, 1] @ F[:, 3], 10))
    print("列 1 与列 3，取共轭：", np.round(np.vdot(F[:, 1], F[:, 3]), 10))

    G = F.conj().T @ F
    print("F^H F =")
    print(np.round(G, 4) + 0.0)

    U = F / 2.0
    print("F4 / 2 是酉矩阵：", np.allclose(U.conj().T @ U, np.eye(4)))
    print("逆 = 共轭转置：", np.allclose(np.linalg.inv(F), F.conj().T / 4.0))

    for n in [4, 16, 64, 256]:
        Un = fourier(n) / np.sqrt(n)
        err = np.linalg.norm(Un.conj().T @ Un - np.eye(n))
        print(f"n = {n:3d}，||U^H U - I|| = {err:.2e}")

    # 与 np.fft 的关系：NumPy 的指数是负号，Strang 的是正号
    rng = np.random.default_rng(1806)
    x = rng.standard_normal(8) + 1j * rng.standard_normal(8)
    print(
        "F8 @ x = n * ifft(x)：",
        np.allclose(fourier(8) @ x, 8 * np.fft.ifft(x)),
    )
    print(
        "conj(F8) @ x = fft(x)：",
        np.allclose(fourier(8).conj() @ x, np.fft.fft(x)),
    )


if __name__ == "__main__":
    main()
```

```text
F4 =
[[ 1.+0.j  1.+0.j  1.+0.j  1.+0.j]
 [ 1.+0.j  0.+1.j -1.+0.j  0.-1.j]
 [ 1.+0.j -1.+0.j  1.+0.j -1.+0.j]
 [ 1.+0.j  0.-1.j -1.+0.j  0.+1.j]]
列 1 与列 3，不取共轭： (4-0j)
列 1 与列 3，取共轭： 0j
F^H F =
[[4.+0.j 0.+0.j 0.+0.j 0.+0.j]
 [0.+0.j 4.+0.j 0.+0.j 0.+0.j]
 [0.+0.j 0.+0.j 4.+0.j 0.+0.j]
 [0.+0.j 0.+0.j 0.+0.j 4.+0.j]]
F4 / 2 是酉矩阵： True
逆 = 共轭转置： True
n =   4，||U^H U - I|| = 1.85e-16
n =  16，||U^H U - I|| = 1.44e-15
n =  64，||U^H U - I|| = 2.90e-14
n = 256，||U^H U - I|| = 1.24e-13
F8 @ x = n * ifft(x)： True
conj(F8) @ x = fft(x)： True
```

读输出：第 1 列与第 3 列不取共轭的内积是 4，取共轭之后是 0。$F^HF$ 是 $4I$。四个尺寸的 $\|U^HU - I\|$ 从 $1.85 \times 10^{-16}$ 慢慢涨到 $1.24 \times 10^{-13}$，矩阵越大累积的舍入误差越多，但始终在机器精度的几百倍以内。最后两行证实了符号约定：$F_8\mathbf{x} = 8\,\text{ifft}(\mathbf{x})$，$\overline{F_8}\mathbf{x} = \text{fft}(\mathbf{x})$。

（顺带一个我实际碰到的数字：我第一次写 `w ** np.outer(j, j)`，没有对 $n$ 取模，$n = 256$ 时误差是 $2 \times 10^{-11}$，比现在大两个数量级。指数大到几万的时候，`w` 的乘方在浮点里已经不是精确的单位复数了。代码里的 `% n` 就是为这个加的。）

这就是为什么逆变换这么便宜：求逆矩阵通常要 $O(n^3)$，这里什么都不用算，转置再取共轭就是逆。正变换用 $F_n$，逆变换用 $\overline{F_n}/n$，两者几乎一样，他说它们很近，近到容易搞混。

## 把 F64 拆成两个 F32

**快在哪里？** 他从一个看似不相干的观察开始：把 $w_{64}$ 平方，角度翻倍，正好得到 $w_{32}$。所以 $F_{64}$ 和 $F_{32}$ 用的是同一族数，应该能连起来。连接的公式是

$$
F_{64} =
\begin{bmatrix} I & D \\ I & -D \end{bmatrix}
\begin{bmatrix} F_{32} & 0 \\ 0 & F_{32} \end{bmatrix}
P
$$

三个因子各管一件事。最右边的 $P$ 是置换矩阵：把向量的偶数下标分量 $x_0, x_2, x_4, \ldots$ 排在前面，奇数下标分量 $x_1, x_3, x_5, \ldots$ 排在后面。中间是两份 $F_{32}$，分别处理偶数部分和奇数部分，中间两块零是关键。最左边是“修补”：$D$ 是对角矩阵，对角线是 $1, w, w^2, \ldots, w^{31}$，上半部分用 $+D$ 合并，下半部分用 $-D$ 合并。

他说这个公式要检查，不过只是核对一堆求和，没有当场推。我补一下推导，只要三行。输出的第 $j$ 项是 $\sum_k w^{jk}x_k$，把 $k$ 拆成偶数 $2k'$ 和奇数 $2k'+1$：

$$
y_j = \underbrace{\sum_{k'} w_{n/2}^{jk'}\, x_{2k'}}_{\text{偶数部分的 } F_{n/2}} +
w^{j} \underbrace{\sum_{k'} w_{n/2}^{jk'}\, x_{2k'+1}}_{\text{奇数部分的 } F_{n/2}}
$$

这里用了 $w_n^2 = w_{n/2}$。而对 $j$ 与 $j + n/2$ 来说，两个 $F_{n/2}$ 的结果相同（因为 $w_{n/2}^{n/2} = 1$），$w^{n/2} = -1$ 只让奇数部分变号。所以前一半输出是“偶数 $+ D \cdot$ 奇数”，后一半是“偶数 $- D \cdot$ 奇数”，这正是 $\begin{bmatrix} I & D \\ I & -D \end{bmatrix}$ 做的事。

下面的脚本把三个因子真的造出来，对 $n = 4, 8, 64$ 验证乘积等于 $F_n$，并数一数每个因子里有多少个非零元：

```python
import numpy as np


def fourier(n: int) -> np.ndarray:
    """返回 F[j, k] = w^(j k)，w = e^(2 pi i/n)。"""
    w = np.exp(2j * np.pi / n)
    j = np.arange(n)
    return w ** (np.outer(j, j) % n)


def split_factors(n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """返回 F_n = B @ blockdiag(F_m, F_m) @ P 中的 B、blockdiag 和 P。"""
    m = n // 2
    w = np.exp(2j * np.pi / n)
    D = np.diag(w ** np.arange(m))
    identity = np.eye(m)
    B = np.block([[identity, D], [identity, -D]])
    Fm = fourier(m)
    zero = np.zeros((m, m))
    blocks = np.block([[Fm, zero], [zero, Fm]])
    # 置换：先取偶数下标，再取奇数下标
    P = np.zeros((n, n))
    P[np.arange(m), 2 * np.arange(m)] = 1.0
    P[m + np.arange(m), 2 * np.arange(m) + 1] = 1.0
    return B, blocks, P


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    B, blocks, P = split_factors(4)
    print("P4 =")
    print(P)
    print("D = diag", np.round(np.diag(B[:2, 2:]), 4) + 0.0)
    print("F4 = B @ blocks @ P：", np.allclose(B @ blocks @ P, fourier(4)))

    for n in [8, 64]:
        B, blocks, P = split_factors(n)
        ok = np.allclose(B @ blocks @ P, fourier(n))
        print(f"F{n} = B @ blocks @ P：", ok)

    # 零的个数：B 和 P 几乎全是零，blocks 一半是零
    n = 64
    B, blocks, P = split_factors(n)
    for name, M in [("B", B), ("blocks", blocks), ("P", P)]:
        print(f"{name} 的非零元个数：{np.count_nonzero(M)} / {n * n}")


if __name__ == "__main__":
    main()
```

```text
P4 =
[[1. 0. 0. 0.]
 [0. 0. 1. 0.]
 [0. 1. 0. 0.]
 [0. 0. 0. 1.]]
D = diag [1.+0.j 0.+1.j]
F4 = B @ blocks @ P： True
F8 = B @ blocks @ P： True
F64 = B @ blocks @ P： True
B 的非零元个数：128 / 4096
blocks 的非零元个数：2048 / 4096
P 的非零元个数：64 / 4096
```

$n = 4$ 时 $D = \text{diag}(1, i)$，$P_4$ 把下标顺序 $0, 1, 2, 3$ 变成 $0, 2, 1, 3$。三个尺寸的分解都对得上。再看 $n = 64$ 的非零元：$B$ 只有 128 个，$P$ 只有 64 个，中间的两份 $F_{32}$ 有 $2 \times 32^2 = 2048$ 个，正好是 $64^2 = 4096$ 的一半。置换不用乘法，$B$ 里真正要乘的只有 $D$ 的 32 个对角元，所以乘一次向量的代价从 4096 次降到 $2048 + 32 = 2080$ 次，大约少了一半（$4096/2080 \approx 1.97$）。

一半还不算惊人。真正的收益在下一步。

## 一直拆下去：递归与 n log n

**为什么不在这里停下？** 因为中间那两个 $F_{32}$ 也可以用同一个公式各自拆成两个 $F_{16}$，再拆成 $F_8$、$F_4$、$F_2$、$F_1$。他的原话大意是：递归是关键词。每拆一层，中间的块越来越小，而左边多出来的修补因子每层都只花 $n/2$ 次乘法，右边多出来的只是置换。从 64 到 1 要拆 $\log_2 64 = 6$ 层，每层 32 次乘法，总数是 $6 \times 32 = 192$，也就是 $\frac{1}{2}n\log_2 n$。

我在这一类问题里总会想起归并排序：一份工作切成两半，各自递归，再花线性的代价合并，$n \log n$ 就是这么来的。（类比只用这一次，FFT 的合并步骤是乘 $D$ 再加减，不是比大小。）

手写递归版本只要十来行。每层把偶数下标和奇数下标分别交给自己，拿回两半结果，乘上 $D$ 的对角元再加减拼起来。我还在里面放了一个计数器，每次乘 $D$ 就加 $n/2$，然后把 $n = 2$ 到 $1024$ 的计数列成表，和公式 $\frac{n}{2}\log_2 n$ 对比：

```python
import numpy as np


def fft(x: np.ndarray, counter: list[int]) -> np.ndarray:
    """递归 FFT（Strang 约定，指数为正号），counter[0] 累计对 D 的乘法。"""
    n = len(x)
    if n == 1:
        return x.astype(complex)
    even = fft(x[0::2], counter)
    odd = fft(x[1::2], counter)
    d = np.exp(2j * np.pi / n) ** np.arange(n // 2)
    counter[0] += n // 2
    return np.concatenate([even + d * odd, even - d * odd])


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    x = rng.standard_normal(64)
    counter = [0]
    y = fft(x, counter)
    print("与 n * ifft 一致：", np.allclose(y, 64 * np.fft.ifft(x)))
    print("最大误差：", f"{np.max(np.abs(y - 64 * np.fft.ifft(x))):.2e}")

    print(
        f"{'n':>6} {'n^2':>9} {'递归计数':>8} {'n/2*log2(n)':>12} {'比值':>8}"
    )
    for k in range(1, 11):
        n = 2**k
        counter = [0]
        fft(rng.standard_normal(n), counter)
        formula = n // 2 * k
        print(
            f"{n:6d} {n * n:9d} {counter[0]:8d} {formula:12d} "
            f"{n * n / counter[0]:8.1f}"
        )


if __name__ == "__main__":
    main()
```

```text
与 n * ifft 一致： True
最大误差： 2.44e-14
     n       n^2     递归计数  n/2*log2(n)       比值
     2         4        1            1      4.0
     4        16        4            4      4.0
     8        64       12           12      5.3
    16       256       32           32      8.0
    32      1024       80           80     12.8
    64      4096      192          192     21.3
   128     16384      448          448     36.6
   256     65536     1024         1024     64.0
   512    262144     2304         2304    113.8
  1024   1048576     5120         5120    204.8
```

第一行：手写的 FFT 与 `64 * np.fft.ifft(x)` 最大差 $2.44 \times 10^{-14}$，是同一个变换（符号约定同上）。表里“递归计数”与“$n/2 \cdot \log_2 n$”两列在十个尺寸上逐行相等，包括 $n = 64$ 时的 192。最后一列的比值 $n^2$ 除以计数，是他在黑板上算的那个数：$n = 1024$ 时是 $1048576 / 5120 = 204.8$。他说的“减少约 200 倍”、“原来做一次变换的时间现在能做 200 次”，就是这行。比值还随 $n$ 增长，$n = 64$ 时 21.3，$n = 1024$ 时 204.8，尺寸每翻一倍，收益接近翻一倍。

需要说明两点，免得读者高估。第一，我数的是“乘 $D$ 的次数”，沿用了他的口径：$D$ 的第一个元素是 1，其实不必乘；加减法也没算；真实库的常数因子（还有 radix-4、split-radix 这些变种）比这复杂。我只计数，没有计时，所以不敢说“实际快了 200 倍”。第二，这个递归要求 $n$ 是 2 的幂；$n = 6$ 这样的尺寸他提到过 $F_6$ 与 $F_3$ 的联系，但拆到 $F_3$ 就拆不动了；据我所知，实际的库对这种尺寸另有办法，那是 FFT 实现的话题，这一讲没有展开。

回头看，整件事靠的是 $F_n$ 的结构：它的元素全是同一个数的幂，$w^2$ 恰好是更小的 Fourier 矩阵里的数。他在最后一句说得很对，整个想法取决于一个“特别的矩阵”，而不是什么通用技巧。我猜这就是 FFT 能到处用的原因：它不改变任何结果，只是把同一个矩阵换了一种乘法。他顺便提到，据他所知高斯早就注意到了这个分解，只是没有强调（这是他的说法，我没有去查文献）。

下一讲回到实数世界：什么是正定矩阵，为什么应用里遇到的矩阵多半是它。接着往下读：[18.06 第 27 讲：正定矩阵与极小值](/posts/linear-algebra-27-positive-definite-minima/)。
