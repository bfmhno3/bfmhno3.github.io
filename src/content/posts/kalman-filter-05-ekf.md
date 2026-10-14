---
title: "扩展卡尔曼滤波：把四元数塞进 EKF"
commentId: "post:kalman-filter-05-ekf"
published: "2026-10-14 12:00:00 +08:00"
description: "卡尔曼滤波系列第 5 篇：推导扩展卡尔曼滤波，用四元数加陀螺零偏的 7 维状态做三维姿态估计，手推测量雅可比并用有限差分验证，看它在平静段、线加速度扰动和磁干扰下的表现，并指出四元数协方差的结构性问题。Python、C、C++、Rust 实现。"
category: Tutorial
tags:
  - 卡尔曼滤波
  - 状态估计
  - 姿态估计
  - EKF
series: "卡尔曼滤波：从一维到三维姿态"
seriesOrder: 5
draft: false
comment: true
slug: kalman-filter-05-ekf
---

平静段 20 到 60 秒，上一篇的 Mahony 互补滤波器误差是 0.758 度，这一篇的扩展卡尔曼滤波器是 0.086 度，差了 8.8 倍。同一份数据，同样的传感器。但整段 120 秒算下来，两者的总均方根误差是 4.881 度对 4.719 度，几乎没分出胜负：它们共同被 90 到 100 秒的磁干扰拖到了同一个水平。

这一篇做的事情：把第 1、2 篇推导的滤波器推广到非线性系统，用它估计三维姿态，然后诚实地看它哪里好、哪里不够。

> [!NOTE] 本篇检查点
> 这一篇结束时你会有：`make ch05` 通过，`out/ch05/ekf_{py,c,cpp,rs}.csv`，四张图；C、C++、Rust 各一个四元数 EKF（`kl_ekf_att`、`ekf_attitude.hpp`、`ekf_att.rs`）和一个共用的测量更新模块（`kl_update`、`update.hpp`、`update.rs`）。雅可比的有限差分检查在每个语言的 app 里先于数据处理运行。
> 前置：[第 4 篇](/posts/kalman-filter-04-attitude-imu/)（约定、四元数、IMU 仿真器、Mahony 基线）和[第 2 篇](/posts/kalman-filter-02-multivariate/)（线性卡尔曼滤波、Joseph 形式、Cholesky）。

## 数学

### 非线性系统与线性化

前面的滤波器都是线性的：$x_k = Fx_{k-1}+\dots$，$z = Hx+v$。姿态问题不是：状态方程里有 $q\otimes\exp(\cdot)$，测量方程里有 $C(q)^Tv$。设

$$
x_{k+1} = f(x_k,u_k)+w_k,\qquad z_k = h(x_k)+v_k
$$

扩展卡尔曼滤波（EKF）的想法是：在当前估计附近，把 $f$ 和 $h$ 做一阶泰勒展开，然后把展开式当成线性模型套用线性滤波器。

$$
f(x)\approx f(\hat x)+F(x-\hat x),\quad F = \left.\frac{\partial f}{\partial x}\right|_{\hat x};\qquad h(x)\approx h(\hat x^-)+H(x-\hat x^-),\quad H = \left.\frac{\partial h}{\partial x}\right|_{\hat x^-}
$$

结果是：

$$
\hat x^- = f(\hat x,u),\quad P^- = FPF^T+Q;\qquad y = z-h(\hat x^-),\quad S = HP^-H^T+R,\quad K = P^-H^TS^{-1}
$$

$$
\hat x = \hat x^- + Ky,\qquad P = (I-KH)P^-(I-KH)^T+KRK^T
$$

注意状态和测量的"均值"用的是非线性函数本身（$f(\hat x)$、$h(\hat x^-)$），线性化只用在协方差和增益上。

### EKF 丢掉了什么

线性滤波器的最优性来自高斯分布经过线性变换仍是高斯。非线性函数不保持这个性质，所以 EKF 没有任何最优性保证。具体的损失有三项：

- **线性化误差**：$F$、$H$ 是在估计值处求的，不是在真值处。估计差得越远，线性模型越不准。第 6 篇的大初始误差实验会看到这一点。
- **均值偏差**：非线性函数把高斯变成非高斯，$f(\hat x)$ 不是均值的无偏估计（二阶项）。
- **不一致**：线性化的 $P$ 常常偏小，滤波器过于自信，NEES 超出界限（第 3 篇）。

还有一个工程问题，我觉得是最危险的：**雅可比写错，滤波器通常不会崩溃**，它会给出一个"看着合理但略差"的结果，你可能永远不会发现。所以我强制在每个 app 里先做有限差分检查，用中心差分 $(g(x+\epsilon e_j)-g(x-\epsilon e_j))/2\epsilon$ 对比解析雅可比。检查不通过，程序直接退出。

### 过程模型

状态 $x = [q\ (4),\ b\ (3)]$，7 维，输入是陀螺读数 $\omega_m$。预测：

$$
q^- = q\otimes\exp\big((\omega_m-b)\Delta t\big),\qquad b^- = b
$$

（第 4 篇的记号：$\exp(v)$ 是旋转向量 $v$ 对应的四元数。）

**$F_{qq}$。** 四元数乘法对 $q$ 是线性的：$q\otimes p = R(p)q$，$R(p)$ 是 $p$ 的"右乘矩阵"。展开乘法公式就是（$p = [p_w,p_x,p_y,p_z]$）

$$
R(p) = \begin{bmatrix}p_w&-p_x&-p_y&-p_z\\p_x&p_w&p_z&-p_y\\p_y&-p_z&p_w&p_x\\p_z&p_y&-p_x&p_w\end{bmatrix}
$$

所以 $F_{qq} = R(\exp((\omega_m-b)\Delta t))$，是精确的，不是近似。

**$F_{qb}$。** 类似地，$q\otimes[0,\omega] = \Xi(q)\omega$，

$$
\Xi(q) = \begin{bmatrix}-x&-y&-z\\w&-z&y\\z&w&-x\\-y&x&w\end{bmatrix}
$$

$\exp(\phi)\approx[1,\tfrac12\phi]$（一阶），$\phi = (\omega_m-b)\Delta t$，所以 $q^-\approx q + \tfrac12\Delta t\,\Xi(q)(\omega_m-b)$，对 $b$ 求导：$F_{qb} = -\tfrac{\Delta t}{2}\Xi(q)$。这个是一阶近似，不是精确的：精确的导数含 $\exp$ 的精确雅可比，差一个 $O(\Delta t|\phi|)$ 的量。有限差分检查会量化它：差距是 $2.2\times10^{-5}$，我给这一项的容差是 $10^{-3}$。

$F_{bb} = I$。

**过程噪声。** 陀螺噪声 $n_g\sim\mathcal N(0,\sigma_g^2I)$ 通过 $\omega = \omega_m-b-n_g$ 进入。$q^-$ 对 $\omega$ 的灵敏度和对 $-b$ 的一样，$\tfrac{\Delta t}{2}\Xi(q)$，所以

$$
Q_{qq} = \Big(\frac{\Delta t}2\Big)^2\Xi(q)\,\sigma_g^2I\,\Xi(q)^T,\qquad Q_{bb} = \sigma_{bw}^2\Delta t\,I
$$

$Q_{bb}$ 就是第 2 篇的零偏随机游走。$\sigma_g = 0.005$ rad/s 是每样本噪声，积分一步的角度噪声是 $\sigma_g\Delta t$，和第 1 篇的 $q = (\sigma_n\Delta t)^2$ 同一个意思。

### 测量模型

加速度计（静止时）测到的是 $-C^T\mathbf g_w$，方向是机体系下的 $C(q)^T[0,0,-1]^T$。我们只用它的方向：$z_a = f_m/|f_m|$，预测 $h_a(q) = C(q)^T[0,0,-1]^T$。单位向量的每个分量的噪声约为 $\sigma_a/g$，所以 $R_a = (\sigma_a/g)^2I_3$。

磁力计同理：$z_m = m_m/|m_m|$，$h_m(q) = C(q)^Tm_w$，$R_m = \sigma_m^2I_3$（磁场本身就是单位长度的）。

**加速度计门控。** 线性加速度会让 $f_m$ 偏离重力。简单的检测：比力的大小应该接近 $g$，当 $\big||f_m|-g\big|>0.5$ m/s² 时跳过这次加速度计更新。这个门限的效果我在结果里给出，会有意外。

**磁力计在本篇不设门。** 磁干扰窗口故意让磁力计的数据是错的，EKF 照单全收，这个后果留给第 6 篇修。

### 测量雅可比

需要 $\partial h/\partial q$，$h(q) = C(q)^Tv$，$v$ 是常向量。第 4 篇推出过 $C(q)v = (w^2-u\cdot u)v+2(u\cdot v)u+2w(u\times v)$。转置对应共轭 $q^*$，也就是 $u\to-u$：

$$
C(q)^Tv = (w^2-u\cdot u)\,v + 2(u\cdot v)\,u - 2w\,(u\times v)
$$

这个多项式形式对任意 $q$（不限单位长度）都有定义，是 $q$ 的二次齐次函数，我下面求导和做有限差分都用它（实现里的 `rot_inv`）。对 $w$：

$$
\frac{\partial h}{\partial w} = 2wv-2(u\times v)
$$

对 $u$（逐项）：$\partial[(w^2-u\cdot u)v]/\partial u = -2vu^T$；$\partial[2(u\cdot v)u]/\partial u = 2uv^T+2(u\cdot v)I$；$\partial[-2w(u\times v)]/\partial u$，因为 $u\times v = -[v]_\times u$，是 $+2w[v]_\times$。合起来：

$$
\frac{\partial h}{\partial u} = 2(u\cdot v)I+2uv^T-2vu^T+2w[v]_\times
$$

$H = [\partial h/\partial q\ \ 0_{3\times3}]$，$3\times7$。有限差分检查：100 个确定性的状态，两个参考向量（重力方向和磁场），$\max|H-H_{fd}| = 2.25\times10^{-10}$，远小于 $10^{-6}$ 的门槛。

### 归一化和协方差

状态里的 $q$ 要保持单位长度，每次更新之后做 $q\leftarrow q/|q|$。但是 $P$ 里 $4\times4$ 的块没有被相应处理，这是个结构性问题：真实的姿态不确定度只有 3 个自由度，而 $P_{qq}$ 是 $4\times4$ 的，它的第四个方向（沿着 $q$ 本身）在物理上没有意义。后面的数据里可以看到它的特征值。这是第 6 篇换成误差状态表示的主要动机。

### 初值

$q_0$ 取第一个样本的 TRIAD，$b_0 = 0$，$P_0 = \operatorname{diag}(0.01I_4,\ 10^{-3}I_3)$。噪声参数用仿真里的真实值：$\sigma_g = 0.005$，$\sigma_{bw} = 10^{-4}$，$\sigma_a = 0.05$，$\sigma_m = 0.01$。

## Python 实现

### 共用的测量更新

三个非线性滤波器（EKF、ESKF、UKF）都需要同一个动作：给定新息 $y$、$H$、$R$，算增益、算 Joseph 形式的新 $P$、返回修正量 $dx = Ky$。我把它单独拿出来：

```python
"""Measurement update shared by the nonlinear filters (chapters 5 to 7)."""

import numpy as np
from scipy.linalg import cho_factor, cho_solve


def joseph_update(P, H, R, y):
    """Joseph-form covariance update for a given innovation y.

    Returns (dx, P_new, S) with dx = K y, K^T = S^-1 H P, S = H P H^T + R.
    The caller decides what dx means: an additive correction (EKF) or an error
    state to inject (ESKF). Raises LinAlgError if S is not positive definite.
    """
    n = P.shape[0]
    S = H @ P @ H.T + R
    c = cho_factor(S, lower=True)
    K = cho_solve(c, H @ P).T
    A = np.eye(n) - K @ H
    P_new = A @ P @ A.T + K @ R @ K.T
    return K @ y, 0.5 * (P_new + P_new.T), S
```

返回的是 $dx$ 而不是更新后的状态，因为 EKF 把它加到状态上，误差状态滤波器（第 6 篇）要把它"注入"名义状态。`P_new` 是对称化过的。

### EKF

```python
"""Multiplicative-quaternion EKF: state x = [q (4), b (3)], input = gyro."""

import numpy as np

from .imu_sim import G
from .quat import qexp, qmul, qnormalize
from .update import joseph_update


def rot_inv(q, v):
    """C(q)^T v written as a polynomial in q: (w^2 - u.u) v + 2 (u.v) u - 2 w (u x v).

    Equal to qrot(q).T @ v for unit q, and defined (and differentiable) for any q.
    """
    w, u = q[0], q[1:]
    return (w * w - u @ u) * v + 2 * (u @ v) * u - 2 * w * np.cross(u, v)


def h_jac(q, v):
    """d rot_inv(q, v) / d q, a 3x4 matrix [d/dw | d/du]."""
    w, u = q[0], q[1:]
    dw = 2 * w * v - 2 * np.cross(u, v)
    skew_v = np.array([[0.0, -v[2], v[1]], [v[2], 0.0, -v[0]], [-v[1], v[0], 0.0]])
    du = 2 * (u @ v) * np.eye(3) + 2 * np.outer(u, v) - 2 * np.outer(v, u) + 2 * w * skew_v
    return np.column_stack([dw, du])


def xi(q):
    """4x3 matrix with q (x) [0, omega] = xi(q) omega."""
    w, x, y, z = q
    return np.array([[-x, -y, -z], [w, -z, y], [z, w, -x], [-y, x, w]])


def right_mul(p):
    """4x4 matrix with q (x) p = right_mul(p) q."""
    pw, px, py, pz = p
    return np.array([
        [pw, -px, -py, -pz],
        [px, pw, pz, -py],
        [py, -pz, pw, px],
        [pz, py, -px, pw],
    ])


class QuatEKF:
    def __init__(self, sigma_g, sigma_bw, sigma_a, sigma_m, m_w, q0, P0, accel_gate=0.5):
        self.sg, self.sbw, self.sa, self.sm = sigma_g, sigma_bw, sigma_a, sigma_m
        self.m_w = np.asarray(m_w, dtype=float)
        self.q = np.asarray(q0, dtype=float).copy()
        self.b = np.zeros(3)
        self.P = np.asarray(P0, dtype=float).copy()
        self.accel_gate = accel_gate  # m/s^2 on | |f| - g |; None disables gating
        self.last_nis = np.nan

    def predict(self, gyro, dt):
        omega = gyro - self.b
        dq = qexp(omega * dt)
        X = xi(self.q)
        F = np.eye(7)
        F[:4, :4] = right_mul(dq)
        F[:4, 4:] = -0.5 * dt * X
        Q = np.zeros((7, 7))
        Q[:4, :4] = (0.5 * dt) ** 2 * self.sg**2 * X @ X.T
        Q[4:, 4:] = self.sbw**2 * dt * np.eye(3)
        self.q = qmul(self.q, dq)
        self.P = F @ self.P @ F.T + Q

    def _update(self, z, v, r):
        H = np.zeros((3, 7))
        H[:, :4] = h_jac(self.q, v)
        y = z - rot_inv(self.q, v)
        dx, self.P, S = joseph_update(self.P, H, r * np.eye(3), y)
        self.q = qnormalize(self.q + dx[:4])
        self.b = self.b + dx[4:]
        self.last_nis = float(y @ np.linalg.solve(S, y))

    def update_accel(self, accel):
        """Gravity-direction update. Returns False when gated out."""
        norm = np.sqrt(accel @ accel)
        if self.accel_gate is not None and abs(norm - G) > self.accel_gate:
            return False
        self._update(accel / norm, np.array([0.0, 0.0, -1.0]), (self.sa / G) ** 2)
        return True

    def update_mag(self, mag):
        self._update(mag / np.sqrt(mag @ mag), self.m_w, self.sm**2)
        return True
```

`rot_inv`、`h_jac`、`xi`、`right_mul` 是上面四个矩阵的逐字翻译。`predict` 里 `self.q = qmul(self.q, dq)` 没有归一化，`_update` 里才归一化：单位四元数乘单位四元数，舍入误差每步 $10^{-16}$ 量级，用 `qnormalize` 管一管。`update_accel` 的返回值告诉你这次有没有被门控掉。

驱动脚本里每一步依次做三件事：

```python
def run_ekf(gyro, acc, mag, accel_gate=0.5, keep_final=False):
    n = len(gyro)
    f = make_ekf(triad(acc[0], mag[0], MAG_W), accel_gate)
    out = np.empty((n, 14))
    out[0] = [*f.q, *f.b, *np.diag(f.P)]
    for k in range(1, n):
        f.predict(gyro[k], DT)
        f.update_accel(acc[k])
        f.update_mag(mag[k])
        out[k] = [*f.q, *f.b, *np.diag(f.P)]
    return (out, f) if keep_final else out

```

## C、C++、Rust 实现

### 共用的测量更新

三个语言的共用更新，各自约 25 行。C 版：

```c
#include "kl/kl_update.h"

#include "kl/kl_mat.h"

int kl_joseph_update(kl_real *P, const kl_real *H, const kl_real *R, const kl_real *y, int n, int m,
		     kl_real *dx, kl_real *S_out, kl_real *work)
{
	kl_real *HP = work;
	kl_real *S = HP + m * n;
	kl_real *L = S + m * m;
	kl_real *Kt = L + m * m;
	kl_real *K = Kt + m * n;
	kl_real *A = K + n * m;
	kl_real *T = A + n * n;
	kl_real *U = T + n * n;
	kl_real *KR = U + n * n;

	kl_mat_mul(H, P, HP, m, n, n);
	kl_mat_mul_bt(HP, H, T, m, n, m);
	kl_mat_add(T, R, S, m, m);

	kl_mat_copy(S, L, m, m);
	if (kl_chol(L, m) != 0)
		return -1;
	kl_mat_copy(HP, Kt, m, n);
	kl_chol_solve(L, Kt, m, n);
	kl_mat_transpose(Kt, K, m, n);
	if (S_out)
		kl_mat_copy(S, S_out, m, m);
	kl_mat_mul(K, y, dx, n, m, 1);

	/* A = I - K H; P = A P A^T + K R K^T */
	kl_mat_mul(K, H, T, n, m, n);
	kl_mat_identity(U, n);
	kl_mat_sub(U, T, A, n, n);
	kl_mat_mul(A, P, T, n, n, n);
	kl_mat_mul_bt(T, A, U, n, n, n);
	kl_mat_mul(K, R, KR, n, m, m);
	kl_mat_mul_bt(KR, K, T, n, m, n);
	kl_mat_add(U, T, P, n, n);
	kl_mat_symmetrize(P, n);
	return 0;
}
```

C++ 和 Rust 版本的区别：C++ 通过输出引用 `dx` 返回修正量，返回 `bool`；Rust 返回 `Option<(dx, S)>`，`None` 表示 $S$ 不正定，此时 `P` 保持不变。

<details>
<summary>完整源码：c/include/kl/kl_update.h、cpp/include/kl/update.hpp、rust/src/update.rs</summary>

```c
/* Measurement update shared by the nonlinear filters. */
#ifndef KL_UPDATE_H
#define KL_UPDATE_H

#include "kl/kl_real.h"

/* Workspace (kl_real count) of kl_joseph_update, laid out as
 *   HP m*n | S m*m | L m*m | Kt m*n | K n*m | A n*n | T n*n | U n*n | KR n*m */
#define KL_JOSEPH_WORK_LEN(n, m) (4 * (m) * (n) + 2 * (m) * (m) + 3 * (n) * (n))

/* Joseph-form covariance update for a given innovation y (m):
 * S = H P H^T + R, K^T = S^-1 H P (Cholesky), dx = K y,
 * P <- A P A^T + K R K^T with A = I - K H, then symmetrized.
 * The caller decides what dx means: an additive correction (EKF) or an error state to inject.
 * P is n x n (in place), H m x n, R m x m. S_out (m x m) may be NULL.
 * Returns -1 if S is not positive definite (P is then unchanged), else 0. */
int kl_joseph_update(kl_real *P, const kl_real *H, const kl_real *R, const kl_real *y, int n, int m,
		     kl_real *dx, kl_real *S_out, kl_real *work);

#endif
```

```cpp
// Measurement update shared by the nonlinear filters (chapters 5 to 7).
#pragma once
#include "kl/mat.hpp"

namespace kl {

// Joseph-form covariance update for a given innovation y.
// Computes dx = K y with K^T = S^-1 H P and S = H P H^T + R, and updates P in place.
// The caller decides what dx means: an additive correction (EKF) or an error state
// to inject (ESKF). Returns false, leaving P and dx unchanged, if S is not positive
// definite.
template <std::size_t N, std::size_t M, class T>
bool joseph_update(Mat<N, N, T>& P, const Mat<M, N, T>& H, const Mat<M, M, T>& R,
		   const Mat<M, 1, T>& y, Mat<N, 1, T>& dx, Mat<M, M, T>* S_out = nullptr) {
	const Mat<M, N, T> HP = H * P;
	const Mat<M, M, T> S = HP * H.transpose() + R;
	Mat<M, M, T> L = S;
	if (!cholesky(L)) return false;
	const Mat<N, M, T> K = chol_solve(L, HP).transpose();
	const Mat<N, N, T> A = Mat<N, N, T>::identity() - K * H;
	P = (A * P * A.transpose() + K * R * K.transpose()).symmetrized();
	dx = K * y;
	if (S_out) *S_out = S;
	return true;
}

}  // namespace kl
```

```rust
//! Measurement update shared by the nonlinear filters.

use crate::mat::{Mat, chol_solve};

/// Joseph-form covariance update for a given innovation `y`.
/// S = H P H^T + R, K^T = S^-1 (H P) by Cholesky solve. Returns `dx = K y`
/// and replaces `p` with A P A^T + K R K^T, symmetrized, A = I - K H.
/// The caller decides what `dx` means: an additive correction (EKF) or an
/// error state to inject (ESKF). Returns `None` (P unchanged) if S is not
/// positive definite.
pub fn joseph_update<const N: usize, const M: usize>(
    p: &mut Mat<N, N>,
    h: &Mat<M, N>,
    r: &Mat<M, M>,
    y: &Mat<M, 1>,
) -> Option<(Mat<N, 1>, Mat<M, M>)> {
    let hp = *h * *p;
    let s = hp * h.transpose() + *r;
    let l = s.cholesky()?;
    let k = chol_solve(&l, &hp).transpose();
    let a = Mat::<N, N>::identity() - k * *h;
    *p = (a * *p * a.transpose() + k * *r * k.transpose()).symmetrized();
    Some((k * *y, s))
}
```

</details>

### C

C 版的滤波器状态是一个结构体，所有数组都是定长的，包括一块 280 个元素的内联工作区：

```c
typedef struct {
	kl_real q[4], b[3], P[49];
	kl_real sg, sbw, sa, sm; /* gyro, bias random walk, accel, mag noise */
	kl_real m_w[3];
	kl_real accel_gate; /* m/s^2 on | |f| - g |; negative disables gating */
	kl_real work[280];  /* scratch: predict needs 196, accel/mag updates 30 + KL_JOSEPH_WORK_LEN(7, 3) = 279 */
} kl_ekf_att;
```

没有 `malloc`，没有"调用者要提供缓冲区"的负担，代价是每个 `kl_ekf_att` 对象带着一块不一定用满的工作区：`predict` 用到 196 个元素，两个测量更新用到 30 加上 `KL_JOSEPH_WORK_LEN(7, 3)` 共 279 个，所以是 280。（这个数字我第一次写的是 256，更新步骤会越界写 23 个元素，覆盖紧挨着结构体的下一个变量。第 5 篇的 app 里它恰好没有踩到任何有用的东西，输出还是和 Python 对得上；到了第 8 篇，同一份代码链接进另一个程序，邻居变成了一个全局常量，结果变成了 NaN，我才发现。这是 C 里没有边界检查的代价，也是为什么 C++ 和 Rust 版本没有这个问题：矩阵尺寸是类型的一部分。）预测：

```c
void kl_ekf_att_predict(kl_ekf_att *f, const kl_real gyro[3], kl_real dt)
{
	kl_real *F = f->work, *Q = F + 49, *T = Q + 49, *U = T + 49;
	kl_real omega[3], dq[4], X[12], Rm[16], Xs[12], qn[4];
	for (int i = 0; i < 3; i++)
		omega[i] = (gyro[i] - f->b[i]) * dt;
	kl_quat_exp(omega, dq);
	kl_ekf_att_xi(f->q, X);
	kl_ekf_att_right_mul(dq, Rm);

	/* F = [[right_mul(dq), -dt/2 Xi], [0, I]] */
	kl_mat_identity(F, 7);
	for (int i = 0; i < 4; i++) {
		for (int j = 0; j < 4; j++)
			F[i * 7 + j] = Rm[i * 4 + j];
		for (int j = 0; j < 3; j++)
			F[i * 7 + 4 + j] = -(kl_real)0.5 * dt * X[i * 3 + j];
	}
	/* Q = blkdiag((dt/2)^2 sg^2 Xi Xi^T, sbw^2 dt I) */
	for (int i = 0; i < 49; i++)
		Q[i] = 0;
	kl_mat_scale(X, ((kl_real)0.5 * dt) * ((kl_real)0.5 * dt) * f->sg * f->sg, Xs, 4, 3);
	kl_mat_mul_bt(Xs, X, Rm, 4, 3, 4);
	for (int i = 0; i < 4; i++)
		for (int j = 0; j < 4; j++)
			Q[i * 7 + j] = Rm[i * 4 + j];
	for (int i = 4; i < 7; i++)
		Q[i * 8] = f->sbw * f->sbw * dt;

	kl_quat_mul(f->q, dq, qn);
	kl_mat_copy(qn, f->q, 4, 1);
	kl_mat_mul(F, f->P, T, 7, 7, 7);
	kl_mat_mul_bt(T, F, U, 7, 7, 7);
	kl_mat_add(U, Q, f->P, 7, 7);
}
```

更新（加速度计和磁力计共用一个内部函数，差别只在 `z`、`v`、`r`）：

```c
/* H = [dh/dq | 0], y = z - h(q); the correction dx is added to the state. */
static int update(kl_ekf_att *f, const kl_real z[3], const kl_real v[3], kl_real r)
{
	kl_real *H = f->work, *R = H + 21, *jw = R + 9;
	kl_real Hq[12], hq[3], y[3], dx[7], qn[4];
	kl_ekf_att_h_jac(f->q, v, Hq);
	for (int i = 0; i < 3; i++)
		for (int j = 0; j < 7; j++)
			H[i * 7 + j] = j < 4 ? Hq[i * 4 + j] : 0;
	kl_ekf_att_rot_inv(f->q, v, hq);
	for (int i = 0; i < 3; i++) {
		y[i] = z[i] - hq[i];
		for (int j = 0; j < 3; j++)
			R[i * 3 + j] = (i == j) ? r : 0;
	}
	if (kl_joseph_update(f->P, H, R, y, 7, 3, dx, NULL, jw) != 0)
		return -1;
	for (int i = 0; i < 4; i++)
		qn[i] = f->q[i] + dx[i];
	kl_quat_normalize(qn);
	kl_mat_copy(qn, f->q, 4, 1);
	for (int i = 0; i < 3; i++)
		f->b[i] += dx[4 + i];
	return 1;
}

static void unit(const kl_real *v, kl_real *u, kl_real *norm)
{
	*norm = KL_SQRT(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
	for (int i = 0; i < 3; i++)
		u[i] = v[i] / *norm;
}

int kl_ekf_att_update_accel(kl_ekf_att *f, const kl_real accel[3])
{
	kl_real z[3], norm;
	const kl_real down[3] = {0, 0, -1};
	unit(accel, z, &norm);
	if (f->accel_gate >= 0 && KL_FABS(norm - (kl_real)KL_GRAVITY) > f->accel_gate)
		return 0;
	return update(f, z, down, (f->sa / (kl_real)KL_GRAVITY) * (f->sa / (kl_real)KL_GRAVITY));
}

int kl_ekf_att_update_mag(kl_ekf_att *f, const kl_real mag[3])
{
	kl_real z[3], norm;
	unit(mag, z, &norm);
	return update(f, z, f->m_w, f->sm * f->sm);
}
```

### C++

```cpp
	void predict(const Vec3<T>& gyro, T dt) {
		const Quat<T> dq = Quat<T>::exp((gyro - b) * dt);
		const Mat<4, 3, T> X = xi(q);
		Mat<7, 7, T> F = Mat<7, 7, T>::identity();
		Mat<7, 7, T> Q{};
		const Mat<4, 4, T> Qq = X * X.transpose() * ((T(0.5) * dt) * (T(0.5) * dt) * sg * sg);
		const Mat<4, 4, T> Fq = right_mul(dq);
		for (std::size_t i = 0; i < 4; i++) {
			for (std::size_t j = 0; j < 4; j++) {
				F(i, j) = Fq(i, j);
				Q(i, j) = Qq(i, j);
			}
			for (std::size_t j = 0; j < 3; j++) F(i, 4 + j) = -T(0.5) * dt * X(i, j);
		}
		for (std::size_t i = 4; i < 7; i++) Q(i, i) = sbw * sbw * dt;
		q = q * dq;  // not normalized here
		P = F * P * F.transpose() + Q;
	}

	// Gravity-direction update. Returns false when gated out or when S is not
	// positive definite (state unchanged in both cases).
	bool update_accel(const Vec3<T>& accel) {
		const T norm = std::sqrt(dot(accel, accel));
		if (accel_gate >= 0 && std::fabs(norm - T(GRAVITY)) > accel_gate) return false;
		return update(accel * (1 / norm), Vec3<T>{{0, 0, -1}}, (sa / T(GRAVITY)) * (sa / T(GRAVITY)));
	}

	// Magnetic-field update; false if S is not positive definite (state unchanged).
	bool update_mag(const Vec3<T>& mag) {
		return update(mag * (1 / std::sqrt(dot(mag, mag))), m_w, sm * sm);
	}

private:
	bool update(const Vec3<T>& z, const Vec3<T>& v, T r) {
		Mat<3, 7, T> H{};
		const Mat<3, 4, T> J = h_jac(q, v);
		for (std::size_t i = 0; i < 3; i++)
			for (std::size_t j = 0; j < 4; j++) H(i, j) = J(i, j);
		const Vec3<T> y = z - rot_inv(q, v);
		Mat<7, 1, T> dx;
		if (!joseph_update(P, H, Mat<3, 3, T>::identity() * r, y, dx)) return false;
		q = Quat<T>{q.w + dx(0, 0), q.x + dx(1, 0), q.y + dx(2, 0), q.z + dx(3, 0)}.normalized();
		b = b + Vec3<T>{{dx(4, 0), dx(5, 0), dx(6, 0)}};
		return true;
	}
```

C++ 版几乎是对着公式写的：`F`、`Q` 是 $7\times7$ 的 `Mat`，`F * P * F.transpose() + Q` 一行完成协方差预测。`update_accel` 和 `update_mag` 共用私有的 `update`，`dx` 用 `Mat<7,1,T>`，修正 `q` 的四个分量，再 `normalized()`。

### Rust

```rust
    pub fn predict(&mut self, gyro: [Real; 3], dt: Real) {
        let omega = [
            gyro[0] - self.b[0],
            gyro[1] - self.b[1],
            gyro[2] - self.b[2],
        ];
        let dq = Quat::exp([omega[0] * dt, omega[1] * dt, omega[2] * dt]);
        let xq = xi(self.q);
        let mut f = Mat::<7, 7>::identity();
        let mut q = Mat::<7, 7>::zeros();
        let rm = right_mul(dq);
        let qq = (xq * xq.transpose()) * ((0.5 * dt) * (0.5 * dt) * self.sg * self.sg);
        for i in 0..4 {
            for j in 0..4 {
                f.m[i][j] = rm.m[i][j];
                q.m[i][j] = qq.m[i][j];
            }
            for j in 0..3 {
                f.m[i][4 + j] = -0.5 * dt * xq.m[i][j];
            }
        }
        for i in 4..7 {
            q.m[i][i] = self.sbw * self.sbw * dt;
        }
        self.q = self.q * dq;
        self.p = f * self.p * f.transpose() + q;
    }

    /// Returns false (state unchanged) if S is not positive definite.
    fn update(&mut self, z: [Real; 3], v: [Real; 3], r: Real) -> bool {
        let mut h = Mat::<3, 7>::zeros();
        let hq = h_jac(self.q, v);
        for i in 0..3 {
            h.m[i][..4].copy_from_slice(&hq.m[i]);
        }
        let pred = rot_inv(self.q, v);
        let y = Mat {
            m: [[z[0] - pred[0]], [z[1] - pred[1]], [z[2] - pred[2]]],
        };
        let Some((dx, _)) = joseph_update(&mut self.p, &h, &(Mat::<3, 3>::identity() * r), &y)
        else {
            return false;
        };
        self.q = Quat {
            w: self.q.w + dx.m[0][0],
            x: self.q.x + dx.m[1][0],
            y: self.q.y + dx.m[2][0],
            z: self.q.z + dx.m[3][0],
        }
        .normalized();
        for i in 0..3 {
            self.b[i] += dx.m[4 + i][0];
        }
        true
    }

    /// Gravity-direction update. Returns false when gated out or on Cholesky failure.
    pub fn update_accel(&mut self, accel: [Real; 3]) -> bool {
        let norm = sqrt(dot(accel, accel));
        if self.accel_gate >= 0.0 && fabs(norm - G) > self.accel_gate {
            return false;
        }
        let z = [accel[0] / norm, accel[1] / norm, accel[2] / norm];
        self.update(z, [0.0, 0.0, -1.0], (self.sa / G) * (self.sa / G))
    }

    /// Returns false on Cholesky failure.
    pub fn update_mag(&mut self, mag: [Real; 3]) -> bool {
        let n = sqrt(dot(mag, mag));
        self.update(
            [mag[0] / n, mag[1] / n, mag[2] / n],
            self.m_w,
            self.sm * self.sm,
        )
    }
```

Rust 版里 `q` 是 `Mat<7,7>` 的局部变量名和 `self.q`（`Quat`）并存，读起来有点绕，这是我给自己挖的坑。`let Some((dx, _)) = joseph_update(...) else { return false; };` 是 `let-else`：失败分支必须发散（这里是提前返回），所以 `update` 不会在 $S$ 不正定时悄悄修改 `self.p`，因为 `joseph_update` 在 Cholesky 失败时不动 `p`。

<details>
<summary>完整源码：c/include/kl/kl_ekf_att.h、c/src/kl_ekf_att.c</summary>

```c
/* Multiplicative-quaternion EKF: state x = [q (4), b (3)], input = gyro.
 * Quaternion conventions: see kl_quat.h. All storage is inline; nothing is allocated. */
#ifndef KL_EKF_ATT_H
#define KL_EKF_ATT_H

#include "kl/kl_real.h"

#define KL_GRAVITY 9.80665

/* C(q)^T v as a polynomial in q: (w^2 - u.u) v + 2 (u.v) u - 2 w (u x v).
 * Equals the DCM transpose for unit q and is defined (and differentiable) for any q. */
void kl_ekf_att_rot_inv(const kl_real q[4], const kl_real v[3], kl_real out[3]);
/* d rot_inv(q, v) / d q, 3x4 row-major [d/dw | d/du] */
void kl_ekf_att_h_jac(const kl_real q[4], const kl_real v[3], kl_real J[12]);
/* 4x3 row-major matrix with q (x) [0, omega] = xi(q) omega */
void kl_ekf_att_xi(const kl_real q[4], kl_real Xi[12]);
/* 4x4 row-major matrix with q (x) p = right_mul(p) q */
void kl_ekf_att_right_mul(const kl_real p[4], kl_real M[16]);

typedef struct {
	kl_real q[4], b[3], P[49];
	kl_real sg, sbw, sa, sm; /* gyro, bias random walk, accel, mag noise */
	kl_real m_w[3];
	kl_real accel_gate; /* m/s^2 on | |f| - g |; negative disables gating */
	kl_real work[280];  /* scratch: predict needs 196, accel/mag updates 30 + KL_JOSEPH_WORK_LEN(7, 3) = 279 */
} kl_ekf_att;

/* p0_diag: initial diagonal of P (7). The bias starts at zero. */
void kl_ekf_att_init(kl_ekf_att *f, const kl_real q0[4], const kl_real p0_diag[7], kl_real sigma_g,
		     kl_real sigma_bw, kl_real sigma_a, kl_real sigma_m, const kl_real m_w[3],
		     kl_real accel_gate);
void kl_ekf_att_predict(kl_ekf_att *f, const kl_real gyro[3], kl_real dt);
/* Return 1 if applied, 0 if gated out, -1 on Cholesky failure (state unchanged). */
int kl_ekf_att_update_accel(kl_ekf_att *f, const kl_real accel[3]);
/* Return 1 if applied, -1 on Cholesky failure (state unchanged). */
int kl_ekf_att_update_mag(kl_ekf_att *f, const kl_real mag[3]);

#endif
```

```c
#include "kl/kl_ekf_att.h"

#include <stddef.h>

#include "kl/kl_mat.h"
#include "kl/kl_quat.h"
#include "kl/kl_update.h"

void kl_ekf_att_rot_inv(const kl_real q[4], const kl_real v[3], kl_real out[3])
{
	kl_real w = q[0], u[3] = {q[1], q[2], q[3]};
	kl_real uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
	kl_real uv = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
	kl_real c[3] = {u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]};
	for (int i = 0; i < 3; i++)
		out[i] = (w * w - uu) * v[i] + 2 * uv * u[i] - 2 * w * c[i];
}

void kl_ekf_att_h_jac(const kl_real q[4], const kl_real v[3], kl_real J[12])
{
	kl_real w = q[0], u[3] = {q[1], q[2], q[3]};
	kl_real uv = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
	kl_real c[3] = {u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]};
	kl_real S[9];
	kl_skew(v, S);
	for (int i = 0; i < 3; i++) {
		J[i * 4] = 2 * w * v[i] - 2 * c[i];
		for (int j = 0; j < 3; j++)
			J[i * 4 + 1 + j] = 2 * uv * (i == j) + 2 * u[i] * v[j] - 2 * v[i] * u[j] +
					   2 * w * S[i * 3 + j];
	}
}

void kl_ekf_att_xi(const kl_real q[4], kl_real Xi[12])
{
	kl_real w = q[0], x = q[1], y = q[2], z = q[3];
	const kl_real X[12] = {-x, -y, -z, w, -z, y, z, w, -x, -y, x, w};
	kl_mat_copy(X, Xi, 4, 3);
}

void kl_ekf_att_right_mul(const kl_real p[4], kl_real M[16])
{
	kl_real pw = p[0], px = p[1], py = p[2], pz = p[3];
	const kl_real R[16] = {pw, -px, -py, -pz, px, pw, pz, -py, py, -pz, pw, px, pz, py, -px, pw};
	kl_mat_copy(R, M, 4, 4);
}

void kl_ekf_att_init(kl_ekf_att *f, const kl_real q0[4], const kl_real p0_diag[7], kl_real sigma_g,
		     kl_real sigma_bw, kl_real sigma_a, kl_real sigma_m, const kl_real m_w[3],
		     kl_real accel_gate)
{
	kl_mat_copy(q0, f->q, 4, 1);
	kl_mat_copy(m_w, f->m_w, 3, 1);
	for (int i = 0; i < 3; i++)
		f->b[i] = 0;
	for (int i = 0; i < 49; i++)
		f->P[i] = 0;
	for (int i = 0; i < 7; i++)
		f->P[i * 8] = p0_diag[i];
	f->sg = sigma_g;
	f->sbw = sigma_bw;
	f->sa = sigma_a;
	f->sm = sigma_m;
	f->accel_gate = accel_gate;
}

void kl_ekf_att_predict(kl_ekf_att *f, const kl_real gyro[3], kl_real dt)
{
	kl_real *F = f->work, *Q = F + 49, *T = Q + 49, *U = T + 49;
	kl_real omega[3], dq[4], X[12], Rm[16], Xs[12], qn[4];
	for (int i = 0; i < 3; i++)
		omega[i] = (gyro[i] - f->b[i]) * dt;
	kl_quat_exp(omega, dq);
	kl_ekf_att_xi(f->q, X);
	kl_ekf_att_right_mul(dq, Rm);

	/* F = [[right_mul(dq), -dt/2 Xi], [0, I]] */
	kl_mat_identity(F, 7);
	for (int i = 0; i < 4; i++) {
		for (int j = 0; j < 4; j++)
			F[i * 7 + j] = Rm[i * 4 + j];
		for (int j = 0; j < 3; j++)
			F[i * 7 + 4 + j] = -(kl_real)0.5 * dt * X[i * 3 + j];
	}
	/* Q = blkdiag((dt/2)^2 sg^2 Xi Xi^T, sbw^2 dt I) */
	for (int i = 0; i < 49; i++)
		Q[i] = 0;
	kl_mat_scale(X, ((kl_real)0.5 * dt) * ((kl_real)0.5 * dt) * f->sg * f->sg, Xs, 4, 3);
	kl_mat_mul_bt(Xs, X, Rm, 4, 3, 4);
	for (int i = 0; i < 4; i++)
		for (int j = 0; j < 4; j++)
			Q[i * 7 + j] = Rm[i * 4 + j];
	for (int i = 4; i < 7; i++)
		Q[i * 8] = f->sbw * f->sbw * dt;

	kl_quat_mul(f->q, dq, qn);
	kl_mat_copy(qn, f->q, 4, 1);
	kl_mat_mul(F, f->P, T, 7, 7, 7);
	kl_mat_mul_bt(T, F, U, 7, 7, 7);
	kl_mat_add(U, Q, f->P, 7, 7);
}

/* H = [dh/dq | 0], y = z - h(q); the correction dx is added to the state. */
static int update(kl_ekf_att *f, const kl_real z[3], const kl_real v[3], kl_real r)
{
	kl_real *H = f->work, *R = H + 21, *jw = R + 9;
	kl_real Hq[12], hq[3], y[3], dx[7], qn[4];
	kl_ekf_att_h_jac(f->q, v, Hq);
	for (int i = 0; i < 3; i++)
		for (int j = 0; j < 7; j++)
			H[i * 7 + j] = j < 4 ? Hq[i * 4 + j] : 0;
	kl_ekf_att_rot_inv(f->q, v, hq);
	for (int i = 0; i < 3; i++) {
		y[i] = z[i] - hq[i];
		for (int j = 0; j < 3; j++)
			R[i * 3 + j] = (i == j) ? r : 0;
	}
	if (kl_joseph_update(f->P, H, R, y, 7, 3, dx, NULL, jw) != 0)
		return -1;
	for (int i = 0; i < 4; i++)
		qn[i] = f->q[i] + dx[i];
	kl_quat_normalize(qn);
	kl_mat_copy(qn, f->q, 4, 1);
	for (int i = 0; i < 3; i++)
		f->b[i] += dx[4 + i];
	return 1;
}

static void unit(const kl_real *v, kl_real *u, kl_real *norm)
{
	*norm = KL_SQRT(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
	for (int i = 0; i < 3; i++)
		u[i] = v[i] / *norm;
}

int kl_ekf_att_update_accel(kl_ekf_att *f, const kl_real accel[3])
{
	kl_real z[3], norm;
	const kl_real down[3] = {0, 0, -1};
	unit(accel, z, &norm);
	if (f->accel_gate >= 0 && KL_FABS(norm - (kl_real)KL_GRAVITY) > f->accel_gate)
		return 0;
	return update(f, z, down, (f->sa / (kl_real)KL_GRAVITY) * (f->sa / (kl_real)KL_GRAVITY));
}

int kl_ekf_att_update_mag(kl_ekf_att *f, const kl_real mag[3])
{
	kl_real z[3], norm;
	unit(mag, z, &norm);
	return update(f, z, f->m_w, f->sm * f->sm);
}
```

</details>

<details>
<summary>完整源码：cpp/include/kl/ekf_attitude.hpp</summary>

```cpp
// Multiplicative-quaternion EKF: state x = [q (4), b (3)], input = gyro.
// Quaternion conventions as in quat.hpp. P is 7x7 over the raw quaternion
// components and the bias; q is renormalized after every update.
#pragma once
#include "kl/quat.hpp"
#include "kl/update.hpp"

namespace kl {

constexpr double GRAVITY = 9.80665;

// C(q)^T v written as a polynomial in q: (w^2 - u.u) v + 2 (u.v) u - 2 w (u x v).
// Equals q.dcm().transpose() * v for unit q, and is defined for any q.
template <class T>
Vec3<T> rot_inv(const Quat<T>& q, const Vec3<T>& v) {
	const Vec3<T> u{{q.x, q.y, q.z}};
	return v * (q.w * q.w - dot(u, u)) + u * (2 * dot(u, v)) - cross(u, v) * (2 * q.w);
}

// d rot_inv(q, v) / d q, a 3x4 matrix [d/dw | d/du].
template <class T>
Mat<3, 4, T> h_jac(const Quat<T>& q, const Vec3<T>& v) {
	const Vec3<T> u{{q.x, q.y, q.z}};
	const Vec3<T> dw = v * (2 * q.w) - cross(u, v) * 2;
	Mat<3, 3, T> du = Mat<3, 3, T>::identity() * (2 * dot(u, v)) + skew(v) * (2 * q.w);
	for (std::size_t i = 0; i < 3; i++)
		for (std::size_t j = 0; j < 3; j++) du(i, j) += 2 * u(i, 0) * v(j, 0) - 2 * v(i, 0) * u(j, 0);
	Mat<3, 4, T> J{};
	for (std::size_t i = 0; i < 3; i++) {
		J(i, 0) = dw(i, 0);
		for (std::size_t j = 0; j < 3; j++) J(i, j + 1) = du(i, j);
	}
	return J;
}

// 4x3 matrix with q (x) [0, omega] = xi(q) omega.
template <class T>
constexpr Mat<4, 3, T> xi(const Quat<T>& q) {
	return Mat<4, 3, T>{{-q.x, -q.y, -q.z, q.w, -q.z, q.y, q.z, q.w, -q.x, -q.y, q.x, q.w}};
}

// 4x4 matrix with q (x) p = right_mul(p) q.
template <class T>
constexpr Mat<4, 4, T> right_mul(const Quat<T>& p) {
	return Mat<4, 4, T>{{p.w, -p.x, -p.y, -p.z, p.x, p.w, p.z, -p.y,
			     p.y, -p.z, p.w, p.x, p.z, p.y, -p.x, p.w}};
}

template <class T = double>
class QuatEKF {
public:
	Quat<T> q;
	Vec3<T> b{};
	Mat<7, 7, T> P{};
	T sg, sbw, sa, sm;
	Vec3<T> m_w;
	T accel_gate;  // m/s^2 on | |f| - g |; negative disables gating

	QuatEKF(T sigma_g, T sigma_bw, T sigma_a, T sigma_m, const Vec3<T>& m_w, const Quat<T>& q0,
		const Mat<7, 7, T>& P0, T accel_gate = T(0.5))
	    : q(q0), P(P0), sg(sigma_g), sbw(sigma_bw), sa(sigma_a), sm(sigma_m), m_w(m_w),
	      accel_gate(accel_gate) {}

	void predict(const Vec3<T>& gyro, T dt) {
		const Quat<T> dq = Quat<T>::exp((gyro - b) * dt);
		const Mat<4, 3, T> X = xi(q);
		Mat<7, 7, T> F = Mat<7, 7, T>::identity();
		Mat<7, 7, T> Q{};
		const Mat<4, 4, T> Qq = X * X.transpose() * ((T(0.5) * dt) * (T(0.5) * dt) * sg * sg);
		const Mat<4, 4, T> Fq = right_mul(dq);
		for (std::size_t i = 0; i < 4; i++) {
			for (std::size_t j = 0; j < 4; j++) {
				F(i, j) = Fq(i, j);
				Q(i, j) = Qq(i, j);
			}
			for (std::size_t j = 0; j < 3; j++) F(i, 4 + j) = -T(0.5) * dt * X(i, j);
		}
		for (std::size_t i = 4; i < 7; i++) Q(i, i) = sbw * sbw * dt;
		q = q * dq;  // not normalized here
		P = F * P * F.transpose() + Q;
	}

	// Gravity-direction update. Returns false when gated out or when S is not
	// positive definite (state unchanged in both cases).
	bool update_accel(const Vec3<T>& accel) {
		const T norm = std::sqrt(dot(accel, accel));
		if (accel_gate >= 0 && std::fabs(norm - T(GRAVITY)) > accel_gate) return false;
		return update(accel * (1 / norm), Vec3<T>{{0, 0, -1}}, (sa / T(GRAVITY)) * (sa / T(GRAVITY)));
	}

	// Magnetic-field update; false if S is not positive definite (state unchanged).
	bool update_mag(const Vec3<T>& mag) {
		return update(mag * (1 / std::sqrt(dot(mag, mag))), m_w, sm * sm);
	}

private:
	bool update(const Vec3<T>& z, const Vec3<T>& v, T r) {
		Mat<3, 7, T> H{};
		const Mat<3, 4, T> J = h_jac(q, v);
		for (std::size_t i = 0; i < 3; i++)
			for (std::size_t j = 0; j < 4; j++) H(i, j) = J(i, j);
		const Vec3<T> y = z - rot_inv(q, v);
		Mat<7, 1, T> dx;
		if (!joseph_update(P, H, Mat<3, 3, T>::identity() * r, y, dx)) return false;
		q = Quat<T>{q.w + dx(0, 0), q.x + dx(1, 0), q.y + dx(2, 0), q.z + dx(3, 0)}.normalized();
		b = b + Vec3<T>{{dx(4, 0), dx(5, 0), dx(6, 0)}};
		return true;
	}
};

}  // namespace kl
```

</details>

<details>
<summary>完整源码：rust/src/ekf_att.rs</summary>

```rust
//! Multiplicative-quaternion EKF: state x = [q (4), b (3)], input = gyro.

use crate::mat::Mat;
use crate::quat::{Quat, skew};
use crate::real::{Real, fabs, sqrt};
use crate::update::joseph_update;

/// Standard gravity (m/s^2).
pub const G: Real = 9.80665;

fn cross(a: [Real; 3], b: [Real; 3]) -> [Real; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [Real; 3], b: [Real; 3]) -> Real {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// C(q)^T v as a polynomial in q: (w^2 - u.u) v + 2 (u.v) u - 2 w (u x v).
/// Equal to dcm(q)^T v for unit q, and defined (and differentiable) for any q.
pub fn rot_inv(q: Quat, v: [Real; 3]) -> [Real; 3] {
    let u = [q.x, q.y, q.z];
    let c = cross(u, v);
    let (a, b) = (q.w * q.w - dot(u, u), 2.0 * dot(u, v));
    [
        a * v[0] + b * u[0] - 2.0 * q.w * c[0],
        a * v[1] + b * u[1] - 2.0 * q.w * c[1],
        a * v[2] + b * u[2] - 2.0 * q.w * c[2],
    ]
}

/// d rot_inv(q, v) / d q, a 3x4 matrix [d/dw | d/du].
pub fn h_jac(q: Quat, v: [Real; 3]) -> Mat<3, 4> {
    let u = [q.x, q.y, q.z];
    let c = cross(u, v);
    let uv = dot(u, v);
    let sv = skew(v);
    let mut j = Mat::zeros();
    for i in 0..3 {
        j.m[i][0] = 2.0 * q.w * v[i] - 2.0 * c[i];
        for k in 0..3 {
            let id = if i == k { 2.0 * uv } else { 0.0 };
            j.m[i][k + 1] = id + 2.0 * u[i] * v[k] - 2.0 * v[i] * u[k] + 2.0 * q.w * sv.m[i][k];
        }
    }
    j
}

/// 4x3 matrix with q (x) [0, omega] = xi(q) omega.
pub fn xi(q: Quat) -> Mat<4, 3> {
    let Quat { w, x, y, z } = q;
    Mat {
        m: [[-x, -y, -z], [w, -z, y], [z, w, -x], [-y, x, w]],
    }
}

/// 4x4 matrix with q (x) p = right_mul(p) q.
pub fn right_mul(p: Quat) -> Mat<4, 4> {
    let Quat { w, x, y, z } = p;
    Mat {
        m: [[w, -x, -y, -z], [x, w, z, -y], [y, -z, w, x], [z, y, -x, w]],
    }
}

pub struct QuatEkf {
    pub q: Quat,
    pub b: [Real; 3],
    pub p: Mat<7, 7>,
    sg: Real,
    sbw: Real,
    sa: Real,
    sm: Real,
    m_w: [Real; 3],
    /// Accel gate on | |f| - g | in m/s^2; negative disables gating.
    accel_gate: Real,
}

impl QuatEkf {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        q0: Quat,
        p0_diag: [Real; 7],
        sigma_g: Real,
        sigma_bw: Real,
        sigma_a: Real,
        sigma_m: Real,
        m_w: [Real; 3],
        accel_gate: Real,
    ) -> Self {
        let mut p = Mat::zeros();
        for (i, d) in p0_diag.iter().enumerate() {
            p.m[i][i] = *d;
        }
        Self {
            q: q0,
            b: [0.0; 3],
            p,
            sg: sigma_g,
            sbw: sigma_bw,
            sa: sigma_a,
            sm: sigma_m,
            m_w,
            accel_gate,
        }
    }

    pub fn predict(&mut self, gyro: [Real; 3], dt: Real) {
        let omega = [
            gyro[0] - self.b[0],
            gyro[1] - self.b[1],
            gyro[2] - self.b[2],
        ];
        let dq = Quat::exp([omega[0] * dt, omega[1] * dt, omega[2] * dt]);
        let xq = xi(self.q);
        let mut f = Mat::<7, 7>::identity();
        let mut q = Mat::<7, 7>::zeros();
        let rm = right_mul(dq);
        let qq = (xq * xq.transpose()) * ((0.5 * dt) * (0.5 * dt) * self.sg * self.sg);
        for i in 0..4 {
            for j in 0..4 {
                f.m[i][j] = rm.m[i][j];
                q.m[i][j] = qq.m[i][j];
            }
            for j in 0..3 {
                f.m[i][4 + j] = -0.5 * dt * xq.m[i][j];
            }
        }
        for i in 4..7 {
            q.m[i][i] = self.sbw * self.sbw * dt;
        }
        self.q = self.q * dq;
        self.p = f * self.p * f.transpose() + q;
    }

    /// Returns false (state unchanged) if S is not positive definite.
    fn update(&mut self, z: [Real; 3], v: [Real; 3], r: Real) -> bool {
        let mut h = Mat::<3, 7>::zeros();
        let hq = h_jac(self.q, v);
        for i in 0..3 {
            h.m[i][..4].copy_from_slice(&hq.m[i]);
        }
        let pred = rot_inv(self.q, v);
        let y = Mat {
            m: [[z[0] - pred[0]], [z[1] - pred[1]], [z[2] - pred[2]]],
        };
        let Some((dx, _)) = joseph_update(&mut self.p, &h, &(Mat::<3, 3>::identity() * r), &y)
        else {
            return false;
        };
        self.q = Quat {
            w: self.q.w + dx.m[0][0],
            x: self.q.x + dx.m[1][0],
            y: self.q.y + dx.m[2][0],
            z: self.q.z + dx.m[3][0],
        }
        .normalized();
        for i in 0..3 {
            self.b[i] += dx.m[4 + i][0];
        }
        true
    }

    /// Gravity-direction update. Returns false when gated out or on Cholesky failure.
    pub fn update_accel(&mut self, accel: [Real; 3]) -> bool {
        let norm = sqrt(dot(accel, accel));
        if self.accel_gate >= 0.0 && fabs(norm - G) > self.accel_gate {
            return false;
        }
        let z = [accel[0] / norm, accel[1] / norm, accel[2] / norm];
        self.update(z, [0.0, 0.0, -1.0], (self.sa / G) * (self.sa / G))
    }

    /// Returns false on Cholesky failure.
    pub fn update_mag(&mut self, mag: [Real; 3]) -> bool {
        let n = sqrt(dot(mag, mag));
        self.update(
            [mag[0] / n, mag[1] / n, mag[2] / n],
            self.m_w,
            self.sm * self.sm,
        )
    }
}
```

</details>

## 结果

```text
$ make -s ch05
Jacobian checks: max|H - H_fd| = 2.25e-10, max|F_qb - F_qb_fd| = 2.22e-05
Jacobian checks: max|H - H_fd| = 2.25e-10, max|F_qb - F_qb_fd| = 2.22e-05
jacobian check: max|H - H_fd| = 2.249e-10, max|F_qb - F_qb_fd| = 2.216e-05
Jacobian checks: max|H - H_fd| = 2.25e-10, max|F_qb - F_qb_fd| = 2.22e-5
ok   ekf_c.csv: max diff 9.992e-16 <= 1.0e-09
ok   ekf_cpp.csv: max diff 1.221e-15 <= 1.0e-09
ok   ekf_rs.csv: max diff 1.665e-15 <= 1.0e-09

RMSE over 120 s (deg), seed 1
method        yaw    pitch     roll    total
mahony      4.390    1.489    2.250    4.881
ekf         4.504    0.684    1.127    4.719

Total error by period (deg RMS)
                     mahony      ekf
calm  [20,60) s       0.758    0.086
accel [60,70) s       2.331    2.640
mag   [90,100) s     14.851   14.820
roll/pitch RMS in [90,100): mahony 8.437, ekf 3.214
peak roll/pitch error in [90,100): mahony 22.52, ekf 8.78 deg
```

三个语言的雅可比检查打出同样的数：$\max|H-H_{fd}| = 2.25\times10^{-10}$，$\max|F_{qb}-F_{qb,fd}| = 2.2\times10^{-5}$。滤波输出和 Python 的最大差异都在 $2\times10^{-15}$ 以下。

### 对比 Mahony

平静段 [20, 60) 秒，EKF 的总误差是 0.086 度，Mahony 是 0.758 度。这是卡尔曼滤波器的价值：它根据陀螺和加速度计各自的噪声水平自己算出增益，不需要我选 $k_p$、$k_i$。整段 RMSE 4.719 对 4.881 度的小差距，来自磁干扰窗口：两个滤波器在那 10 秒里的总误差都是 14.8 度，因为磁力计的数据是错的，它们都相信了。

但是**细看磁干扰窗口里的横滚和俯仰**，EKF 的 RMS 是 3.214 度，Mahony 是 8.437 度；峰值 8.78 度对 22.52 度。EKF 的磁力计更新对横滚俯仰的污染比 Mahony 轻得多，原因我猜是它知道加速度计的置信度很高（$P$ 在横滚俯仰方向上很小），磁力计的修正主要落在偏航上；Mahony 对两个传感器的权重固定。偏航方向它俩都没有办法，那是 14.8 度总误差的主要来源。

![EKF 与 Mahony 的总姿态误差；红色阴影为线加速度扰动，紫色阴影为磁干扰](/assets/images/kalman-filter/ch05-ekf-vs-mahony.svg)

![磁干扰期间的俯仰和横滚误差：EKF（橙）比 Mahony（蓝）小得多，但也不是零](/assets/images/kalman-filter/ch05-mag-disturbance.svg)

### 加速度计门控：我设的门限从来没触发

线性加速度段 [60, 70) 秒，EKF 的总误差 RMS 是 2.640 度，比平静段的 0.086 度差 30 倍，比 Mahony 的 2.331 度还差一点。我的加速度计门控把 $\big||f_m|-g\big|>0.5$ m/s² 的样本排除。结果：

```text
accel gating (|f| - g test)
 gate (m/s^2)  gated samples  [60,70) RMS  whole run RMS
          0.5              0        2.640          4.719
          0.1           1018        0.961          4.668
          off              0        2.640          4.719
max | |f| - g | over the run: 0.332 m/s^2 (horizontal acceleration a adds only about a^2/(2 g): 2^2/(2 g) = 0.204)
```

**门限 0.5 一个样本都没有拦住**，12000 个样本里 0 个。原因是几何：扰动是水平方向的，$|f| = \sqrt{g^2+a^2}\approx g+a^2/(2g)$，$a=2$ m/s² 时只多出 0.204 m/s²，加上噪声也只有 0.332 m/s²，远没到 0.5。比力的模长对水平加速度几乎是二阶不敏感的。门限收紧到 0.1 之后，1018 个样本被拦住，该段 RMS 从 2.640 降到 0.961 度，整段 4.719 降到 4.668 度。这 1018 个里，507 个落在扰动窗口内（窗口共 1000 个样本，拦住一半），511 个是窗口外 11000 个正常样本的误拦，误拦率 4.6%。

这件事我是跑完才发现的：门控"开着"和"没有门控"的曲线完全重合（下图的蓝线和橙色虚线）。**一个检测器没有触发，不代表它在工作。** 门限 0.1 能拦住，是因为它已经紧到接近噪声水平（单个样本的噪声就有 0.05 m/s²），所以才有上面 4.6% 的误拦，这是个典型的权衡，不是白拿的收益。用模长检测水平线加速度本来就不是个好办法；第 6 篇我仍然沿用 0.5 的门限（保持可比），用的是同一份数据，所以它在那里同样不会触发。

![60 到 70 秒的总误差，三条曲线：不设门、门限 0.5、门限 0.1。前两条完全重合](/assets/images/kalman-filter/ch05-accel-gating.svg)

### 零偏估计

```text
bias error after 30 s (rad/s): max 0.02121, RMS per axis [0.00411 0.00597 0.00573]
final bias: true [ 0.01953 -0.01146  0.01275], EKF [ 0.02066 -0.01307  0.01142]
```

平静段里零偏估计非常好，在真值附近几乎重合。两次扰动之后它飘了：线加速度窗口里零偏估计跟着加速度计的错误摆动，磁干扰窗口里更厉害，偏离真值最大 0.021 rad/s（和零偏本身一个量级）。道理一样：偏航被错误的磁力计数据拉偏了，滤波器把"偏航在漂"解释成"零偏变了"。扰动结束之后，估计慢慢回到真值附近（最后 0.002 以内），但那需要几十秒。

![零偏估计与真值；两段阴影时间内估计被扰动带走，之后慢慢回来](/assets/images/kalman-filter/ch05-bias.svg)

### $4\times4$ 四元数协方差

```text
final 4x4 quaternion covariance block
  eigenvalues: [1.412e-09 6.411e-08 7.028e-08 2.728e-07]
  variance along q: 1.420e-09   (the manifold only has 3 directions)
```

最后一步 $P_{qq}$ 的四个特征值里有一个小得多：$1.4\times10^{-9}$，另外三个是 $6.4\times10^{-8}$ 到 $2.7\times10^{-7}$，差了 45 到 190 倍，而且这个最小特征值对应的方向就是 $q$ 自己（沿着 $q$ 的方差是 $1.420\times10^{-9}$）。物理上，四元数的长度根本不是一个待估计的量，$P$ 在这个方向上的数值没有意义；它小，是因为测量函数是 $q$ 的二次齐次函数，滤波器以为自己"测到了"长度。这个多出来的方向是个自由度的"幽灵"，它会吃掉信息，也让 $P$ 变得接近奇异（条件数大 190 倍），这是数值上的风险。

我没有证明这个幽灵会让滤波器变差，我只是不喜欢它。下一篇的方案是干脆不要在四元数上做加减：把状态拆成"名义的四元数"和"3 维的误差向量"，协方差只对 3 维误差定义。

## 下一篇

EKF 的问题已经够明确了：4 维四元数的协方差不对，磁力计整个 3 维向量都参与更新所以会污染横滚俯仰，门控检测的方式有盲区。下一篇的误差状态卡尔曼滤波（ESKF）一次处理前两个：误差用 3 维旋转向量表示，协方差是 $6\times6$ 满秩；磁力计只用来更新偏航。它还多了一个 EKF 做不到的好处，我们会用一个 90 度的初始偏航误差来测试它。
