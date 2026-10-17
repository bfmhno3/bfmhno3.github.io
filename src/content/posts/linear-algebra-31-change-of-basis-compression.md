---
title: "18.06 第 31 讲：基变换与图像压缩"
commentId: "post:linear-algebra-31-change-of-basis-compression"
published: "2026-10-18 18:20:00 +08:00"
description: "MIT 18.06 第 31 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 在 Haar 小波基下压缩一张合成的 64 × 64 灰度图，只存 516 个数，相对误差 0.0142，同样存储量的 SVD 低秩近似是 0.0795。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 基变换
  - 图像压缩
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 32
draft: false
comment: true
slug: linear-algebra-31-change-of-basis-compression
---

压缩图像在线性代数里只是一件事：把像素向量从标准基换到另一组基，扔掉绝对值小的系数，再换回来。我合成了一张 64 × 64 的灰度图（渐变背景、一个圆盘、一个方块、一点噪声），在 Haar 小波基下只保留 516 个最大的系数，相对误差是 0.0142。同样存 516 个数，SVD 低秩近似（秩 4）的误差是 0.0795，大了 5.6 倍；在标准基里只留 516 个最大的像素，误差是 0.7760，基本等于图被毁了。

> [!NOTE] 本讲速览
> 视频：[Lecture 31: Change of basis; image compression](https://www.youtube.com/watch?v=0h43aV4aH7I)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-31-change-of-basis-image-compression/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §8.3 The Search for a Good Basis；§7.2 Image Processing by Linear Algebra
> 前置：[第 30 讲：线性变换及其矩阵](/posts/linear-algebra-30-linear-transformations/)
> 一句话：换基就是解 $\mathbf{x} = W\mathbf{c}$，好基要又快（$W$ 和 $W^{-1}$ 都容易乘）又省（几个基向量就够），而同一个线性变换在两组基下的矩阵是相似的：$B = M^{-1}AM$。

> [!TIP] 配合视频
> - 前半讲是应用：JPEG、FBI 指纹、视频压缩。他讲得很随意，也很有意思，值得正常速度看，本篇只用代码重做了其中的数学。
> - 他在黑板上写 8 个小波向量（全 1、四个 1 四个 -1、两个 1 两个 -1……）的那一段要看，我的第一个代码块就是照着它建矩阵。
> - 讲到 $\mathbf{P} = W\mathbf{c}$、“好基要有快速的逆”那几分钟是全讲的核心，不要倍速。
> - 后半讲他自己说“这一部分是压缩过的”：用相似矩阵回顾上一讲。如果上一讲已经熟，可以倍速，但最后一分钟的“特征向量基下矩阵是对角阵”要听。

## 压缩从哪里来：标准基是个糟糕的基

Strang 一开口就拿这门课的录像说事：你看到的他的动作有点跳，是因为视频被压缩过了。静止的板书压得很干净，他自己走来走去才吃比特。

静止图像是什么？一张 $512 \times 512$ 的灰度图，每个像素是 0 到 255 之间的一个数（8 位）。把所有像素排成一列就是向量 $\mathbf{x} \in \mathbb{R}^n$，$n = 512^2$；彩色图再乘 3。这个向量用的是标准基：第 $i$ 个坐标就是第 $i$ 个像素的灰度。

问题出在这里：相邻像素的灰度几乎一样。一块蓝衬衫上的像素是 121、124、124、126……领带才会换一种颜色。一块干净的黑板更极端，所有像素都一样，你却要一个一个把它们报出来。他的话是：标准基完全没有利用相邻像素相关这个事实。

所以他的想法是换基。有一个向量几乎是必须在基里的：全 1 向量。一个全 1 向量加一个系数，就能完整描述纯色图。交替的 $(1, -1, 1, -1, \dots)$ 是另一个极端，是棋盘图案。再往中间走，是一半亮一半暗的 $(1, \dots, 1, -1, \dots, -1)$。基是我们可以自由选的，他说这是“十亿美元的决定”，电视台和电影界各有偏好，吵得很凶，而吵架的内容归根到底是一个线性代数问题：选哪组基。

JPEG 的做法是：

1. 把大图切成 $8 \times 8$ 的小块，每块有 64 个像素。
2. 在每块的 64 维空间里换成 Fourier 基，得到 64 个系数 $\mathbf{c}$。这一步无损，只是换了一组坐标。
3. 阈值：把小的系数设成 0，得到有很多零的 $\hat{\mathbf{c}}$。这一步有损，是压缩真正发生的地方。
4. 用留下的几项乘它们的基向量，重建图像。

他估计光滑的块里 64 项只会留下两三项，“64 到 3，压缩 21 比 1”。（据我所知，实际的 JPEG 用的是离散余弦变换，和 Fourier 基是近亲，不过我没有去核对标准文本，这里按他的说法。）

## 小波：他写在黑板上的 8 个向量

Fourier 基的对手是小波。他在 $\mathbb{R}^8$ 里写了最简单的那一组：

- 全 1：$(1, 1, 1, 1, 1, 1, 1, 1)$
- 半正半负：$(1, 1, 1, 1, -1, -1, -1, -1)$
- 前四个里的半正半负：$(1, 1, -1, -1, 0, 0, 0, 0)$，后四个里的：$(0, 0, 0, 0, 1, 1, -1, -1)$
- 最后四个：$(1, -1, 0, \dots)$、$(0, 0, 1, -1, 0, \dots)$ 等，每个只占两个位置

把它们放在矩阵 $W$ 的列里。他问这组向量有什么好性质：首先每个元素都是 1、-1、0，乘起来只有加减。更重要的是它们两两正交：全 1 和半正半负的点积是四个 $+1$ 加四个 $-1$，等于 0。但它们长度不同（$\sqrt{8}$、$\sqrt{4}$、$\sqrt{2}$），所以是正交基，不是标准正交基；每列除以自己的长度就是了。

这个矩阵我不想手敲。观察一下规律：全部小波可以递归地造出来，$n$ 阶矩阵的前一半列是 $n/2$ 阶矩阵的每一行抄两遍，后一半列是 $(1, -1)$ 一对一对地沿对角线排。用 `np.kron` 两行：

```python
import numpy as np


def haar(n: int) -> np.ndarray:
    """返回 n x n 的 Haar 小波矩阵，列是未归一化的基向量。"""
    if n == 1:
        return np.array([[1.0]])
    top = np.kron(haar(n // 2), np.array([[1.0], [1.0]]))
    bottom = np.kron(np.eye(n // 2), np.array([[1.0], [-1.0]]))
    return np.hstack([top, bottom])


def main() -> None:
    np.set_printoptions(precision=4, suppress=True, linewidth=79)
    W = haar(8)
    print(W.astype(int))

    # 列两两正交，但长度不同：根号 8、根号 8、根号 4、根号 2
    G = W.T @ W
    print("W^T W 是对角阵：", np.allclose(G, np.diag(np.diag(G))))
    print("列长的平方：", np.diag(G).astype(int))

    # 每列除以自己的长度，W^{-1} 就是 W^T
    W = W / np.linalg.norm(W, axis=0)
    print("归一化后 W^T W = I：", np.allclose(W.T @ W, np.eye(8)))
    print("inv(W) 等于 W^T：", np.allclose(np.linalg.inv(W), W.T))

    # 最快的向量 (1, -1, 1, -1, ...) 是最后四个小波之和
    fast = np.array([1.0, -1.0] * 4)
    c = W.T @ fast
    print("最快向量的系数 c =", c)
    print("W @ c 还原出原向量：", np.allclose(W @ c, fast))


if __name__ == "__main__":
    main()
```

```text
[[ 1  1  1  0  1  0  0  0]
 [ 1  1  1  0 -1  0  0  0]
 [ 1  1 -1  0  0  1  0  0]
 [ 1  1 -1  0  0 -1  0  0]
 [ 1 -1  0  1  0  0  1  0]
 [ 1 -1  0  1  0  0 -1  0]
 [ 1 -1  0 -1  0  0  0  1]
 [ 1 -1  0 -1  0  0  0 -1]]
W^T W 是对角阵： True
列长的平方： [8 8 4 4 2 2 2 2]
归一化后 W^T W = I： True
inv(W) 等于 W^T： True
最快向量的系数 c = [0.     0.     0.     0.     1.4142 1.4142 1.4142 1.4142]
W @ c 还原出原向量： True
```

打印出来的 $W$ 和他黑板上的 8 列一模一样，包括列的顺序。$W^\mathsf{T}W$ 是对角阵，列长的平方是 $(8, 8, 4, 4, 2, 2, 2, 2)$，所以除以长度之后 $W^\mathsf{T}W = I$，`inv(W)` 和 `W.T` 相等。这是第 17 讲的结论：标准正交列的矩阵，逆就是转置，变基不用解方程。

他还问了一个小问题：交替向量 $(1, -1, 1, -1, \dots)$，用小波基怎么写？答案是最后四个小波之和。最后一行的系数前四个是 0，后四个都是 $\sqrt{2} = 1.4142$（因为归一化之后每个小波的长度从 $\sqrt{2}$ 变成了 1），`W @ c` 确实还原出了原向量。

## 变基就是解 $\mathbf{P} = W\mathbf{c}$

现在可以说线性代数在哪里了。他取一行 8 个像素 $\mathbf{P} = (P_1, \dots, P_8)$，想把它写成小波的组合：

$$
\mathbf{P} = c_1 \mathbf{w}_1 + c_2 \mathbf{w}_2 + \cdots + c_8 \mathbf{w}_8 = W\mathbf{c}
$$

这是这门课里一直在做的事：基向量放在列里，列的组合给出向量。系数是 $\mathbf{c} = W^{-1}\mathbf{P}$。他在这里停下来强调：**好基的标准有两条**。

- **要快。** $W$ 和 $W^{-1}$ 乘向量都得很快，否则变基本身比省下来的还贵。Fourier 基有 FFT（第 26 讲），小波也有快速算法；对我们的 $W$，因为列标准正交，$W^{-1} = W^\mathsf{T}$，逆和正变换一样便宜。
- **要省。** 少数几个基向量就应该接近原信号。最快的变换是不换基，可是标准基里一扔就是丢像素，他说如果扔掉 90% 的像素，图就“黑”了。

下面的块把两条都验一遍。像素行我自己编的：左边四个是蓝衬衫（121 到 126），右边四个是领带（60 到 63）。快速算法不造矩阵，只是反复做平均和差分，每次把长度折半：

```python
import numpy as np


def haar(n: int) -> np.ndarray:
    """返回 n x n 的归一化 Haar 矩阵，列是基向量。"""
    if n == 1:
        return np.array([[1.0]])
    top = np.kron(haar(n // 2), np.array([[1.0], [1.0]]))
    bottom = np.kron(np.eye(n // 2), np.array([[1.0], [-1.0]]))
    W = np.hstack([top, bottom])
    return W / np.linalg.norm(W, axis=0)


def fast_haar(p: np.ndarray) -> np.ndarray:
    """不构造矩阵，用反复的平均与差分算 W^T p。"""
    details = []
    while len(p) > 1:
        average = (p[0::2] + p[1::2]) / np.sqrt(2)
        detail = (p[0::2] - p[1::2]) / np.sqrt(2)
        details = [detail] + details
        p = average
    return np.concatenate([p] + details)


def keep_largest(c: np.ndarray, k: int) -> np.ndarray:
    """只保留绝对值最大的 k 个系数，其余置零。"""
    out = np.zeros_like(c)
    idx = np.argsort(-np.abs(c))[:k]
    out[idx] = c[idx]
    return out


def main() -> None:
    np.set_printoptions(precision=2, suppress=True, linewidth=79)
    W = haar(8)
    # 一行 8 个像素：左边是蓝衬衫，右边是领带
    P = np.array([121.0, 124.0, 124.0, 126.0, 60.0, 62.0, 63.0, 61.0])

    c = W.T @ P
    print("P =", P)
    print("c =", c)
    print("快速算法与 W^T P 一致：", np.allclose(fast_haar(P), c))
    print("乘法次数：矩阵", 8 * 8, "，快速算法的加减次数", 2 * (8 - 1))

    # 同样只留 k 个数：标准基里留最大的像素，小波基里留最大的系数
    print("k  标准基相对误差  小波基相对误差")
    for k in [1, 2, 3, 4]:
        std = np.linalg.norm(P - keep_largest(P, k)) / np.linalg.norm(P)
        wav = np.linalg.norm(P - W @ keep_largest(c, k)) / np.linalg.norm(P)
        print(f"{k}  {std:14.4f}  {wav:14.4f}")


if __name__ == "__main__":
    main()
```

```text
P = [121. 124. 124. 126.  60.  62.  63.  61.]
c = [261.98  88.03  -2.5   -1.    -2.12  -1.41  -1.41   1.41]
快速算法与 W^T P 一致： True
乘法次数：矩阵 64 ，快速算法的加减次数 14
k  标准基相对误差  小波基相对误差
1          0.8901          0.3189
2          0.7687          0.0152
3          0.6243          0.0123
4          0.4451          0.0096
```

先看系数 $\mathbf{c} = (261.98, 88.03, -2.5, \dots)$。第一个是整行的平均（乘了 $\sqrt{8}$），第二个 88.03 是“左半边比右半边亮多少”，两个就带走了几乎全部信息，后面六个都在 $\pm 3$ 以内。

比较是在同样只留 $k$ 个数的前提下做的。$k = 2$ 时，小波基的相对误差是 0.0152，而标准基里只留最大的两个像素，误差是 0.7687，差了 50 倍。到 $k = 4$ 小波基是 0.0096，标准基还有 0.4451，一半的向量没了。

快速算法和 `W.T @ P` 的结果一致：矩阵乘需要 $8 \times 8 = 64$ 次乘法，快速算法只要 14 次加减（再统一乘一个 $1/\sqrt{2}$）。这是 8 个像素，$n = 64$ 时是 4096 比 126，差距随 $n$ 增长：矩阵乘是 $n^2$，快速算法是 $O(n)$。（所以小波在这里的卖点是“又省又便宜”，不是“又准又贵”。）

## 整张图：Haar 对 SVD

接下来把一维换成二维。图像 $X$ 是 $64 \times 64$ 的矩阵，在列方向换一次基，在行方向再换一次：$C = W^\mathsf{T} X W$，反过来 $X = W C W^\mathsf{T}$（因为 $W^{-1} = W^\mathsf{T}$）。$C$ 里每个元素是 $X$ 在一个二维小波“砖块”上的系数。图是合成的，没有读外部文件：灰度从左到右渐变，加一个亮圆盘、一个暗方块，再加标准差为 2 的高斯噪声。

压缩比较什么？我拿三种东西比：

- Haar：保留 $C$ 里最大的 $k$ 个系数。
- 标准基：保留 $X$ 里最大的 $k$ 个像素。
- SVD：保留秩 $r$ 的近似，需要存 $r(64 + 64 + 1) = 129r$ 个数，所以取 $k = 129r$。

```python
import numpy as np


def haar(n: int) -> np.ndarray:
    """返回 n x n 的归一化 Haar 矩阵，列是基向量。"""
    if n == 1:
        return np.array([[1.0]])
    top = np.kron(haar(n // 2), np.array([[1.0], [1.0]]))
    bottom = np.kron(np.eye(n // 2), np.array([[1.0], [-1.0]]))
    W = np.hstack([top, bottom])
    return W / np.linalg.norm(W, axis=0)


def make_image(n: int = 64) -> np.ndarray:
    """合成灰度图：渐变背景、一个圆盘、一个方块、一点噪声。"""
    rng = np.random.default_rng(1806)
    r, c = np.mgrid[0:n, 0:n]
    X = 60.0 + 80.0 * c / (n - 1)
    X[(r - 24) ** 2 + (c - 22) ** 2 < 14**2] = 220.0
    X[40:56, 36:58] = 20.0
    X += rng.normal(0.0, 2.0, size=(n, n))
    return np.clip(X, 0.0, 255.0)


def keep_largest(C: np.ndarray, k: int) -> np.ndarray:
    """只保留绝对值最大的 k 个元素，其余置零。"""
    flat = np.zeros(C.size)
    idx = np.argsort(-np.abs(C).ravel())[:k]
    flat[idx] = C.ravel()[idx]
    return flat.reshape(C.shape)


def rel_err(X: np.ndarray, Y: np.ndarray) -> float:
    return float(np.linalg.norm(X - Y) / np.linalg.norm(X))


def main() -> None:
    W = haar(64)
    X = make_image()

    # 二维变换：先对每一列做 W^T，再对每一行做 W^T
    C = W.T @ X @ W
    print("W^T W = I：", np.allclose(W.T @ W, np.eye(64)))
    print("无损往返的相对误差：", f"{rel_err(X, W @ C @ W.T):.1e}")
    print("能量不变：", np.isclose(np.linalg.norm(X), np.linalg.norm(C)))

    # 公平一点的比较：SVD 秩 r 要存 r * (64 + 64 + 1) = 129 r 个数
    U, s, Vt = np.linalg.svd(X)
    print("存的数  Haar    像素    SVD")
    for r in [1, 2, 4, 8]:
        k = 129 * r
        e_haar = rel_err(X, W @ keep_largest(C, k) @ W.T)
        e_pixel = rel_err(X, keep_largest(X, k))
        e_svd = rel_err(X, (U[:, :r] * s[:r]) @ Vt[:r])
        print(f"{k:6d}  {e_haar:.4f}  {e_pixel:.4f}  {e_svd:.4f}")


if __name__ == "__main__":
    main()
```

```text
W^T W = I： True
无损往返的相对误差： 3.2e-16
能量不变： True
存的数  Haar    像素    SVD
   129  0.0708  0.9479  0.2506
   258  0.0336  0.8937  0.1798
   516  0.0142  0.7760  0.0795
  1032  0.0100  0.6386  0.0295
```

前三行是检查：$W^\mathsf{T}W = I$，不压缩的往返误差是 $3.2 \times 10^{-16}$，$\|X\|_F = \|C\|_F$（标准正交基不改变长度，第 17 讲的事实）。

然后是表。存 516 个数，Haar 的相对误差 0.0142，SVD 0.0795，像素 0.7760。这时 Haar 比 SVD 好 5.6 倍，比像素好 55 倍。存 129 个数时，Haar 是 0.0708，SVD 是 0.2506。再往后到 1032 个数，Haar 误差只降到 0.0100：它碰到了噪声的地板，剩下的系数都是噪声，没必要再存。

![左：原图。中：Haar 基下保留 516 个最大系数，相对误差 0.0142。右：秩 4 的 SVD 近似，同样 516 个数，相对误差 0.0795](/assets/images/linear-algebra/l31-original-haar-svd.svg)

图的右边解释了为什么 SVD 在这里输：秩 4 的近似把圆盘糊成了一团带阴影的方块。SVD 的基是整张图的行和列方向的一维向量，它们必须在整张图上起作用；而圆盘和方块的边缘是局部的、不规则的，需要很多个秩 1 项才能凑出来。小波基是“局部”的，一个边缘只牵连少数几个小波，其余系数都是 0。

![三种方法的相对误差随存储的数的个数 k 变化，纵轴是对数坐标](/assets/images/linear-algebra/l31-error-vs-storage.svg)

上面两张图由下面这个脚本生成（需要 matplotlib，在当前目录写出两个 SVG；图中的数据与前面的代码块完全相同）：

```python
import matplotlib
import matplotlib.pyplot as plt
import numpy as np


def haar(n: int) -> np.ndarray:
    """返回 n x n 的归一化 Haar 矩阵，列是基向量。"""
    if n == 1:
        return np.array([[1.0]])
    top = np.kron(haar(n // 2), np.array([[1.0], [1.0]]))
    bottom = np.kron(np.eye(n // 2), np.array([[1.0], [-1.0]]))
    W = np.hstack([top, bottom])
    return W / np.linalg.norm(W, axis=0)


def make_image(n: int = 64) -> np.ndarray:
    """合成灰度图：渐变背景、一个圆盘、一个方块、一点噪声。"""
    rng = np.random.default_rng(1806)
    r, c = np.mgrid[0:n, 0:n]
    X = 60.0 + 80.0 * c / (n - 1)
    X[(r - 24) ** 2 + (c - 22) ** 2 < 14**2] = 220.0
    X[40:56, 36:58] = 20.0
    X += rng.normal(0.0, 2.0, size=(n, n))
    return np.clip(X, 0.0, 255.0)


def keep_largest(C: np.ndarray, k: int) -> np.ndarray:
    """只保留绝对值最大的 k 个元素，其余置零。"""
    flat = np.zeros(C.size)
    idx = np.argsort(-np.abs(C).ravel())[:k]
    flat[idx] = C.ravel()[idx]
    return flat.reshape(C.shape)


def rel_err(X: np.ndarray, Y: np.ndarray) -> float:
    return float(np.linalg.norm(X - Y) / np.linalg.norm(X))


def main() -> None:
    matplotlib.use("Agg")
    plt.rcParams["svg.hashsalt"] = "la1806"

    W = haar(64)
    X = make_image()
    C = W.T @ X @ W
    U, s, Vt = np.linalg.svd(X)
    k, r = 516, 4
    Xh = W @ keep_largest(C, k) @ W.T
    Xs = (U[:, :r] * s[:r]) @ Vt[:r]

    fig, axes = plt.subplots(1, 3, figsize=(10, 4))
    panels = [
        (X, "original, 4096 numbers"),
        (Xh, f"Haar, top {k} coefficients\nerror {rel_err(X, Xh):.4f}"),
        (Xs, f"SVD, rank {r} ({129 * r} numbers)\nerror {rel_err(X, Xs):.4f}"),
    ]
    for ax, (img, title) in zip(axes, panels):
        ax.imshow(img, cmap="gray", vmin=0, vmax=255)
        ax.set_title(title, fontsize=10)
        ax.axis("off")
    fig.tight_layout()
    fig.savefig("l31-original-haar-svd.svg", metadata={"Date": None})

    ks = [129 * r for r in range(1, 17)]
    fig, ax = plt.subplots(figsize=(6, 4))
    ax.semilogy(
        ks,
        [rel_err(X, W @ keep_largest(C, k) @ W.T) for k in ks],
        "o-",
        label="Haar, top k coefficients",
    )
    ax.semilogy(
        ks,
        [
            rel_err(X, (U[:, : k // 129] * s[: k // 129]) @ Vt[: k // 129])
            for k in ks
        ],
        "s-",
        label="SVD, rank k/129",
    )
    ax.semilogy(
        ks,
        [rel_err(X, keep_largest(X, k)) for k in ks],
        "^-",
        label="standard basis, top k pixels",
    )
    ax.set_xlabel("numbers stored k")
    ax.set_ylabel("relative error")
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig("l31-error-vs-storage.svg", metadata={"Date": None})


if __name__ == "__main__":
    main()
```

我得对这个比较做三点保留，不然就是不公平的广告。一，Haar 的 $k$ 个系数还要加上它们的位置（索引），我没把索引算进存储，所以 5.6 倍是上界，不是实际压缩比。二，这张图是我挑的：分段平滑加锐利边缘，正好是 Haar 的主场；换一张纹理很多的真实照片，我猜差距会小得多。三，Strang 说的是 $8 \times 8$ 分块，我这里是整张 $64 \times 64$ 一起变，分块的好处是局部性和便宜，坏处是块边界可能露出来。

## 同一个变换，两个矩阵：相似矩阵

讲完应用，他回到数学，而且开头就说“这一部分是压缩过的”（大概是时间不够了）。结论是这样的：设 $T$ 是一个线性变换，在基 $\mathbf{v}_1, \dots, \mathbf{v}_n$ 下的矩阵是 $A$，在基 $\mathbf{w}_1, \dots, \mathbf{w}_n$ 下的矩阵是 $B$，那么 $A$ 和 $B$ 相似：

$$
B = M^{-1} A M
$$

$M$ 是换基矩阵，它的列就是新基向量（在旧基下的坐标），和前面的 $W$ 是同一类东西。换基之后两件事同时发生：每个向量有了新坐标（$\mathbf{x} = M\mathbf{c}$），每个线性变换有了新矩阵。

这里有一个类比，我只用这一次：同一句话用两种语言写出来，字数、词序都变了，意思没变。$A$ 和 $B$ 是同一个变换的两种“写法”，所以凡是和写法无关的量（特征值、迹、行列式）两边必须相等。

怎么得到 $A$？他把上一讲的配方重复了一遍：把 $T$ 作用在每个基向量上，把结果写成基向量的组合，系数放进矩阵的一列。我用一个上三角矩阵验证上面的关系：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True, linewidth=79)
    rng = np.random.default_rng(1806)

    # 同一个线性变换：在标准基下的矩阵是 A
    A = np.array([[2.0, 1.0, 0.0], [0.0, 3.0, 1.0], [0.0, 0.0, 1.0]])
    x = np.array([1.0, 2.0, 3.0])

    # 新基的三个向量放在 M 的列里
    M = rng.standard_normal((3, 3))
    c = np.linalg.solve(M, x)  # x 在新基下的坐标，c = M^{-1} x
    print("M c 还原出 x：", np.allclose(M @ c, x))

    # T(x) 的新坐标：先变回旧坐标，用 A，再变回新坐标
    B = np.linalg.inv(M) @ A @ M
    print(
        "B @ c = M^{-1} (A x)：", np.allclose(B @ c, np.linalg.solve(M, A @ x))
    )
    print("A 的特征值：", np.sort(np.linalg.eigvals(A)))
    print("B 的特征值：", np.sort(np.linalg.eigvals(B)))
    print("A 的迹与行列式：", np.trace(A), np.linalg.det(A))
    print("B 的迹与行列式：", np.trace(B), np.linalg.det(B))

    # 新基取特征向量：矩阵变成对角阵
    lam, S = np.linalg.eig(A)
    Lambda = np.linalg.inv(S) @ A @ S
    print("特征向量基下的矩阵：")
    print(Lambda)
    print("它是对角阵：", np.allclose(Lambda, np.diag(lam)))


if __name__ == "__main__":
    main()
```

```text
M c 还原出 x： True
B @ c = M^{-1} (A x)： True
A 的特征值： [1. 2. 3.]
B 的特征值： [1. 2. 3.]
A 的迹与行列式： 6.0 6.0
B 的迹与行列式： 6.0 6.000000000000001
特征向量基下的矩阵：
[[2. 0. 0.]
 [0. 3. 0.]
 [0. 0. 1.]]
它是对角阵： True
```

$B$ 是用随机的 $M$（固定种子）得到的，看起来和 $A$ 毫无关系，但特征值都是 $(1, 2, 3)$，迹都是 6，行列式都是 6（$B$ 的行列式那一个末位是 $10^{-15}$ 量级的浮点噪声）。向量的坐标也对得上：`B @ c` 等于 $M^{-1}(A\mathbf{x})$，也就是先在旧坐标里作用 $A$，再换成新坐标。

最后一个例子是他留到最后一分钟的：如果基向量 $\mathbf{v}_i$ 是特征向量，$T(\mathbf{v}_i) = \lambda_i \mathbf{v}_i$，第 $i$ 列的描述就是“$\lambda_i$ 份 $\mathbf{v}_i$，其他基向量 0 份”，所以矩阵是对角阵。代码里最后几行就是这个：用 `np.linalg.eig` 的特征向量当 $M$，$M^{-1}AM$ 是对角阵 $\mathrm{diag}(2, 3, 1)$。这是第 22 讲的 $A = S\Lambda S^{-1}$ 换一种说法。

他说这是“最好的基”，但求图像矩阵的特征向量太贵，所以工程里退一步，用小波或 Fourier 这种便宜、接近的基。“接近”能不能量化？拿一个 64 阶的平滑算子（每个像素换成它和左右邻居的 $(1, 2, 1)/4$ 加权平均）来试：

```python
import numpy as np


def haar(n: int) -> np.ndarray:
    """返回 n x n 的归一化 Haar 矩阵，列是基向量。"""
    if n == 1:
        return np.array([[1.0]])
    top = np.kron(haar(n // 2), np.array([[1.0], [1.0]]))
    bottom = np.kron(np.eye(n // 2), np.array([[1.0], [-1.0]]))
    W = np.hstack([top, bottom])
    return W / np.linalg.norm(W, axis=0)


def off_diagonal_share(B: np.ndarray) -> float:
    """非对角元素的能量占全部能量的比例。"""
    off = B - np.diag(np.diag(B))
    return float(np.linalg.norm(off) ** 2 / np.linalg.norm(B) ** 2)


def main() -> None:
    np.set_printoptions(precision=4, suppress=True, linewidth=79)
    n = 64
    # 一个平滑算子：每个像素换成自己与左右邻居的加权平均 (1, 2, 1) / 4
    A = 0.5 * np.eye(n) + 0.25 * (np.eye(n, k=1) + np.eye(n, k=-1))
    A[0, 0] = A[-1, -1] = 0.75

    W = haar(n)
    _, S = np.linalg.eigh(A)  # 对称矩阵，特征向量正交，S^{-1} = S^T

    print("标准基下非对角能量占比：", f"{off_diagonal_share(A):.4f}")
    print(
        "Haar 基下非对角能量占比：", f"{off_diagonal_share(W.T @ A @ W):.4f}"
    )
    print(
        "特征向量基下非对角能量占比：",
        f"{off_diagonal_share(S.T @ A @ S):.2e}",
    )


if __name__ == "__main__":
    main()
```

```text
标准基下非对角能量占比： 0.3214
Haar 基下非对角能量占比： 0.1382
特征向量基下非对角能量占比： 1.32e-30
```

用非对角元素的能量占比来衡量离对角阵有多远。标准基下是 0.3214，Haar 基下降到 0.1382，不到一半；特征向量基是 $10^{-30}$，也就是对角阵。Haar 没有做到对角，但把约 57% 的非对角能量搬回了对角线，我觉得这个“便宜又接近”的取舍，才是 Strang 说的“十亿美元的决定”的实质。（对称矩阵用 `np.linalg.eigh`，特征向量标准正交，所以逆也是转置，和 $W$ 一样。）

下一讲是第三次测验的复习，用 NumPy 把字幕里的题再过一遍，见 [18.06 第 32 讲：第三次测验复习](/posts/linear-algebra-32-quiz-3-review/)。
