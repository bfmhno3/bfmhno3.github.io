---
title: "姿态的数学：旋转、四元数与 IMU 仿真器"
commentId: "post:kalman-filter-04-attitude-imu"
published: "2026-10-14 11:00:00 +08:00"
description: "卡尔曼滤波系列第 4 篇：旋转矩阵、欧拉角与万向锁、轴角与指数映射、四元数及其运动学的完整推导；一个带零偏、噪声和两段扰动的 IMU 仿真器；以及纯陀螺积分、TRIAD 和 Mahony 互补滤波三个基线，Python、C、C++、Rust 同步实现。"
category: Tutorial
tags:
  - 卡尔曼滤波
  - 状态估计
  - 姿态估计
  - 四元数
  - IMU
series: "卡尔曼滤波：从一维到三维姿态"
seriesOrder: 4
draft: false
comment: true
slug: kalman-filter-04-attitude-imu
---

先看三个数：同一份 120 秒的 IMU 数据，只用陀螺仪积分，姿态误差最后涨到 41.9 度；只用加速度计加磁力计逐点求解（TRIAD），整段的均方根误差是 5.702 度；Mahony 互补滤波是 4.881 度。这三个数里最有意思的是最后那个：它在 20 到 60 秒的平静段只有 0.758 度，在 90 到 100 秒的磁干扰段是 14.851 度。一个滤波器的好坏，要看它怎么对付"传感器在说谎"的时刻。

这一篇不做卡尔曼滤波。它把后面四篇需要的全部材料备齐：姿态的数学、一个能造出这种谎言的仿真器，和三个不用协方差的基线，卡尔曼滤波器之后要和它们比。

> [!NOTE] 本篇检查点
> 这一篇结束时你会有：`make ch04` 通过，`data/imu_seed1.csv`（12000 个样本的仿真 IMU 日志），`out/ch04/` 下 `gyro`、`triad`、`mahony` 三种方法在四种语言下的输出，三张图；C、C++、Rust 里的四元数模块（`kl_quat`、`quat.hpp`、`quat.rs`）、Mahony 滤波器和 TRIAD。四元数恒等式的自检在每个语言的 app 里先于数据处理运行。
> 前置：[第 3 篇](/posts/kalman-filter-03-tuning-diagnostics/)。需要的数学：向量叉乘、矩阵指数的概念。

## 约定

这些约定在这一篇陈述一次，之后原样沿用。

- 世界系 NED（北东地），机体系 FRD（前右下）。重力加速度 $g = 9.80665$ m/s²，世界系下 $\mathbf g_w = [0,0,g]^T$。
- 四元数用 Hamilton 约定，标量在前：$q = [w,x,y,z]$。$q$ 把机体系向量旋转到世界系：$v_w = q\otimes v_b\otimes q^*$，对应的旋转矩阵记作 $C(q) = C_{wb}$（机体到世界）。
- 运动学 $\dot q = \tfrac12 q\otimes[0,\omega_b]$，离散形式 $q_{k+1} = q_k\otimes\exp(\tfrac12\omega\Delta t)$（这里的 $\exp$ 在下面定义）。
- 误差定义（右乘，局部/机体系误差）：$q_{true} = \hat q\otimes\exp(\tfrac12\delta\theta)$，姿态误差向量 $\delta\theta = 2\log(\hat q^{-1}\otimes q_{true})$，规范化为 $w\ge0$。
- 欧拉角用 ZYX 顺序（偏航、俯仰、横滚），只用于显示和报告误差，误差折到 $[-180^\circ,180^\circ)$。我会报告三个轴各自的欧拉角 RMSE（度）和总的旋转角误差 $|\delta\theta|$ 的 RMSE（度）。
- 传感器模型：
  - 陀螺：$\omega_m = \omega + b + n_g$，$b$ 随机游走。
  - 加速度计测比力：$f_m = C(q)^T(a_w-\mathbf g_w) + n_a$。
  - 磁力计：$m_m = C(q)^Tm_w + n_m$，$m_w = [\cos50^\circ,0,\sin50^\circ]^T$（单位长度，磁倾角 50 度向下，磁偏角 0）。

## 数学

### 旋转矩阵与 SO(3)

一个把机体系坐标变成世界系坐标的旋转，写成矩阵 $C\in\mathbb R^{3\times3}$，满足 $C^TC = I$ 和 $\det C = +1$。所有这样的矩阵组成群 SO(3)：两个旋转相乘还是旋转，逆就是转置。它有 9 个数，但只有 3 个自由度，6 个约束把它压到一个三维曲面上。这个"3 个自由度、不能随便加减"的性质，是整个姿态估计比标量滤波难的原因。

### 欧拉角与万向锁

最直观的 3 参数表示是欧拉角。ZYX 顺序：先绕 $x$ 转横滚角 $\phi$，再绕 $y$ 转俯仰角 $\theta$，再绕 $z$ 转偏航角 $\psi$，

$$
C = R_z(\psi)R_y(\theta)R_x(\phi) = \begin{bmatrix}c_\psi c_\theta & c_\psi s_\theta s_\phi - s_\psi c_\phi & c_\psi s_\theta c_\phi + s_\psi s_\phi\\ s_\psi c_\theta & s_\psi s_\theta s_\phi + c_\psi c_\phi & s_\psi s_\theta c_\phi - c_\psi s_\phi\\ -s_\theta & c_\theta s_\phi & c_\theta c_\phi\end{bmatrix}
$$

（$c$、$s$ 是余弦和正弦的缩写。）它的毛病在 $\theta = 90^\circ$：$c_\theta = 0$，$s_\theta = 1$，矩阵化简成

$$
C = \begin{bmatrix}0 & \sin(\phi-\psi) & \cos(\phi-\psi)\\ 0 & \cos(\phi-\psi) & -\sin(\phi-\psi)\\ -1 & 0 & 0\end{bmatrix}
$$

只依赖 $\phi-\psi$，而不是它们各自的值：偏航和横滚退化成同一个自由度，丢了一个。这就是万向锁。数值验证：$(\psi,\phi) = (20^\circ,10^\circ)$ 和 $(57^\circ,47^\circ)$（差值都是 $-10^\circ$）在 $\theta=90^\circ$ 给出的矩阵，最大元素差是 $8.33\times10^{-17}$，是同一个旋转。

![绕一个接近 y 轴的轴匀速旋转时的欧拉角：俯仰上升到 90 度之后，偏航和横滚在大约 20 度的旋转范围里同时跳变 170 度，而旋转本身是光滑的](/assets/images/kalman-filter/ch04-gimbal-lock.svg)

在奇异点附近，一个很小的旋转会让偏航和横滚剧烈变化。我这份仿真数据里，真值的俯仰角在 $[-77.3^\circ,80.9^\circ]$ 之间摆动，离奇异点不到 10 度，这意味着后面报告的偏航、横滚的欧拉角 RMSE 会被放大。总旋转角误差 $|\delta\theta|$ 没有这个毛病，所以我把它当作主要指标。**结论：欧拉角只用来显示，滤波器内部不用。**

### 轴角、Rodrigues 与指数映射

另一个 3 参数表示是旋转向量 $v = \theta n$：绕单位轴 $n$ 转角度 $\theta$。Rodrigues 公式把它变成矩阵：

$$
C = I + \sin\theta\,[n]_\times + (1-\cos\theta)\,[n]_\times^2,\qquad [n]_\times = \begin{bmatrix}0&-n_z&n_y\\n_z&0&-n_x\\-n_y&n_x&0\end{bmatrix}
$$

$[a]_\times b = a\times b$。推导：把向量 $x$ 分解成沿轴的分量 $(n\cdot x)n$ 和垂直分量 $x_\perp$；沿轴的不变，垂直分量在垂直平面内转 $\theta$：$x_\perp\cos\theta + (n\times x)\sin\theta$。合起来 $Cx = (n\cdot x)n + x_\perp\cos\theta + (n\times x)\sin\theta$，用 $x_\perp = x - (n\cdot x)n$ 和 $[n]_\times^2x = n\times(n\times x) = (n\cdot x)n - x$ 整理即得。

这个 $v\mapsto C$ 就是 SO(3) 上的指数映射 $\exp([v]_\times)$，反方向是对数映射。它是后面所有章节的基本工具：小的旋转，用 3 维向量表示，可以随便加、随便做线性运算；大的旋转，用指数映射接到群上。

### 四元数

四元数是 4 维的 $q = [w,u]$，$u\in\mathbb R^3$。乘法（Hamilton 积）：

$$
a\otimes b = \big[a_wb_w - a_u\cdot b_u,\ \ a_wb_u + b_wa_u + a_u\times b_u\big]
$$

共轭 $q^* = [w,-u]$，范数 $|q|^2 = w^2+u\cdot u$，单位四元数 $|q|=1$ 的逆等于共轭。单位四元数 $q = [\cos\tfrac\theta2,\ n\sin\tfrac\theta2]$ 表示绕 $n$ 转 $\theta$。这里有一个双重覆盖：$q$ 与 $-q$ 是同一个旋转（$\theta$ 与 $\theta+2\pi$ 给出相反符号）。我的约定是误差四元数规范化到 $w\ge0$。

**四元数旋转向量。** 把 $v$ 嵌成 $[0,v]$，计算 $q\otimes[0,v]\otimes q^*$。先算 $p = q\otimes[0,v] = [-u\cdot v,\ wv+u\times v]$，再乘 $q^* = [w,-u]$，向量部分是

$$
p_0(-u) + w\,p_v + p_v\times(-u) = (u\cdot v)u + w^2v + w\,u\times v - w\,v\times u - (u\times v)\times u
$$

$-w\,v\times u = w\,u\times v$；$(u\times v)\times u = (u\cdot u)v - (u\cdot v)u$（三重积展开）。代入得

$$
C(q)v = (w^2-u\cdot u)\,v + 2(u\cdot v)\,u + 2w\,(u\times v)
$$

这个式子很重要：它的第一种写法是 $q\otimes v\otimes q^*$（便于推导），第二种写法是矩阵 $C(q)$（便于实现），对应代码里的 `qrot`。第 5 篇求雅可比时会用到它。

**指数映射与对数映射。** 旋转向量 $v$ 对应的四元数是

$$
\exp(v) = \big[\cos\tfrac{|v|}2,\ \ \tfrac{v}{|v|}\sin\tfrac{|v|}2\big]
$$

（我写 $\exp(v)$ 指的是旋转向量 $v$ 对应的四元数，在级数记号里它是 $\exp(\tfrac12[0,v])$。）$|v|\to0$ 时 $\sin(|v|/2)/|v|\to\tfrac12$，$\cos\to1-|v|^2/8$，代码里 $|v|<10^{-8}$ 就用这个一阶展开，免得除以零。反方向：$\log q = 2\operatorname{atan2}(|u|,w)\,u/|u|$（先把 $q$ 规范化到 $w\ge0$）。用 $\operatorname{atan2}$ 而不是 $\arccos$，在小角度时数值上稳得多。

**运动学。** 设机体以角速度 $\omega_b$（机体系表示）转动。经过一小段 $dt$，机体系相对于上一时刻的机体系，转了一个小旋转 $\omega_bdt$，所以

$$
q(t+dt) = q(t)\otimes\exp(\omega_bdt)\approx q(t)\otimes\big[1,\tfrac12\omega_bdt\big]
$$

（右乘，因为 $\omega_b$ 是在机体系里表示的。）展开一阶项，$\dot q = \tfrac12q\otimes[0,\omega_b]$。如果 $\omega_b$ 在整个 $\Delta t$ 内恒定，那么 $q_{k+1} = q_k\otimes\exp(\omega\Delta t)$ 是精确的，不是近似：这正是离散模型。这条精确式的好处是不需要小步长假设，也永远保持单位范数（至多舍入误差，代码里再归一化一次）。

**小角度近似。** $\exp(\delta\theta)\approx[1,\tfrac12\delta\theta]$，误差是 $O(|\delta\theta|^2)$。第 6 篇的误差状态滤波器整个建立在它上面。

**斜对称矩阵。** $[v]_\times$ 把叉乘变成矩阵乘法，上面已经定义。后面经常用到性质：$[a]_\times b = -[b]_\times a$。

### 三个传感器测的是什么

- **陀螺仪**测机体系下的角速度，加上零偏和噪声。零偏是缓慢变化的，不能被忽略：我的仿真里初始零偏是 $[0.02,-0.01,0.015]$ rad/s，不处理它，120 秒会积出 $0.02\times120 = 2.4$ rad 的误差。
- **加速度计**测的不是重力加速度，而是比力（specific force）：$f_m = C^T(a_w-\mathbf g_w)+n_a$。静止时 $a_w=0$，$f = -C^T\mathbf g_w$，机体水平时是 $[0,0,-g]$：加速度计"感觉到的"是地面向上的支持力，在 FRD 系下 $z$ 轴向下，所以读数是负的。线性加速度会直接污染它，这是它的致命弱点。
- **磁力计**测地磁场在机体系下的方向。我们已知世界系下的磁场 $m_w$。

### 为什么加速度计只给横滚和俯仰，磁力计给偏航

加速度计提供一个世界系已知方向（竖直方向）在机体系下的观测。一个方向观测只约束两个自由度：把竖直轴对齐之后，绕竖直轴转任意角度，观测都不变，那就是偏航。所以加速度计能得到横滚和俯仰，得不到偏航。磁力计提供第二个方向（磁场方向），它和重力方向不平行（有 50 度磁倾角），两个不平行的方向合起来约束全部 3 个自由度。

TRIAD 就是用这一点的最小方案：用两个方向观测直接构造出姿态。机体系观测 $b_1$（比力的方向）、$b_2$（磁场方向），世界系参考 $r_1 = [0,0,-1]$、$r_2 = m_w$。分别构造正交标架：

$$
t_1 = v_1,\quad t_2 = \frac{v_1\times v_2}{|v_1\times v_2|},\quad t_3 = t_1\times t_2
$$

$C_{wb} = [t_1^r\ t_2^r\ t_3^r]\,[t_1^b\ t_2^b\ t_3^b]^T$，把机体系标架旋转到世界系标架。第一个向量（这里是比力方向）被精确对齐，第二个向量只有垂直于第一个向量的部分被使用，这意味着 TRIAD 把全部可信度给了加速度计，磁力计只用来定偏航。它没有滤波，每个样本独立计算，噪声和扰动直接传进来。

## 仿真器

仿真器只在 Python 里（`python/kl/imu_sim.py`）：C、C++、Rust 的任务是处理已经记录好的数据，这也正是硬件上的工作流。

**真值。** 机体系角速度
$$
\omega_b(t) = \big[0.8\sin(2\pi\cdot0.20\,t),\ 0.6\sin(2\pi\cdot0.13\,t+1.0),\ 1.0\sin(2\pi\cdot0.07\,t+2.0)\big]\ \text{rad/s}
$$
以 1 kHz 用精确四元数指数积分（每步用区间中点的角速度），初始姿态是单位四元数，每 10 步取一个样本，得到 100 Hz 的 IMU 数据，120 秒共 12000 个样本。三个轴用互不通约的频率，是为了让姿态在 120 秒内不重复。

**陀螺。** 陀螺读数是区间平均角速度 $\operatorname{rotvec}(q_{k-1}^{-1}\otimes q_k)/\Delta t$ 加零偏加噪声。用区间平均而不是采样时刻的瞬时值，是因为第 3 篇那个教训：离散滤波模型 $q_k = q_{k-1}\otimes\exp(\omega_m\Delta t)$ 隐含的就是平均角速度，瞬时值会在滤波器和仿真器之间留下一个系统性的模型差。

**噪声与零偏。** 陀螺每样本噪声 $\sigma_g = 0.005$ rad/s，零偏初值 $[0.02,-0.01,0.015]$ rad/s，随机游走 $\sigma_{bw} = 10^{-4}$ rad/s/$\sqrt{\text{s}}$（每样本标准差 $\sigma_{bw}\sqrt{\Delta t}$）。加速度计 $\sigma_a = 0.05$ m/s²，磁力计 $\sigma_m = 0.01$（单位场）。这些是典型消费级 MEMS 的量级，不是某个具体型号的数据手册。

**两段扰动。**

- 线性加速度：$t\in[60,70)$ 秒内加上世界系下 $a_w = [2\sin(2\pi\cdot0.5\,t),0,0]$ m/s²，CSV 里 `acc_dist = 1`。
- 磁干扰：$t\in[90,100)$ 秒内世界系磁场被加上 $[0.3,0.3,0]$，CSV 里 `mag_dist = 1`。

![仿真的陀螺、加速度计、磁力计信号；红色阴影是线加速度扰动，紫色阴影是磁干扰](/assets/images/kalman-filter/ch04-imu-signals.svg)

CSV 的列是 `t,gx,gy,gz,ax,ay,az,mx,my,mz,qw,qx,qy,qz,bx,by,bz,acc_dist,mag_dist`。滤波器不允许读后面的 9 列（真值四元数、真零偏和扰动标志），它们只在评估时用。种子 1 用于单次运行，之后的蒙特卡洛用种子 1 到 50。

## Mahony 互补滤波

第 1 篇留了一个观察：常增益的一维卡尔曼滤波，就是对"陀螺推进后的预测"做一阶低通，加速度计提供低频、陀螺提供高频。Mahony 滤波器是它在 SO(3) 上的非线性版本。

设当前估计 $\hat q$，它预测的世界系方向在机体系下是 $\hat v_a = C(\hat q)^T[0,0,-1]^T$（竖直）和 $\hat v_m = C(\hat q)^Tm_w$（磁场）。实际测到的单位向量 $a_n = f_m/|f_m|$，$m_n = m_m/|m_m|$。我们要一个小的机体系旋转 $\delta$，使预测向量对准测量向量。给 $\hat q$ 右乘 $\exp(\delta)$ 之后，新预测是 $C(\hat q\otimes\exp(\delta))^T v_w = \exp(\delta)^T\hat v\approx\hat v - \delta\times\hat v = \hat v+\hat v\times\delta$。要它等于测量 $v$，解 $\hat v\times\delta = v-\hat v$；对单位向量，垂直于 $\hat v$ 的那部分有解 $\delta = v\times\hat v$（验证：$\hat v\times(v\times\hat v) = v - (\hat v\cdot v)\hat v$，正好是 $v$ 垂直于 $\hat v$ 的分量）。两个观测的修正取和：

$$
e = a_n\times\hat v_a + m_n\times\hat v_m
$$

$e$ 就是"当前估计与测量之间的失配"，是个机体系下的小旋转向量。Mahony 把它当作角速度的修正项，并且对它积分来估计零偏：

$$
b\leftarrow b - k_ie\,\Delta t,\qquad \hat q\leftarrow\hat q\otimes\exp\big((\omega_m - b + k_pe)\Delta t\big)
$$

$b$ 的符号是这么确定的：稳态下 $k_pe = -(b_{true}-\hat b)$（失配平衡掉零偏误差），所以 $e$ 是负的零偏误差的 $1/k_p$ 倍；要让 $\hat b$ 趋向 $b_{true}$，需要 $\hat b$ 沿 $-e$ 方向增长，即 $\hat b\leftarrow\hat b - k_ie\Delta t$。

$k_p$ 控制"多快相信测量"，对应第 1 篇 $K_\infty/\Delta t$（时间常数的倒数）；$k_i$ 控制零偏估计多快。我取 $k_p = 1.0$，$k_i = 0.05$ 作为基线，没有调。

**它的局限也很明显**：$e$ 只是方向失配的几何修正，没有协方差，不知道哪个传感器此刻更可信，加速度计和磁力计的权重固定相等；磁干扰会通过 $m_n\times\hat v_m$ 直接改变横滚和俯仰，而不仅仅是偏航（下面的数据会看到）。第 5 篇之后的卡尔曼滤波器要解决的就是这几件事。

另外两个基线：**纯陀螺积分**（初始姿态用第一个样本的 TRIAD，之后只积分陀螺），**TRIAD**（每个样本独立求解）。

## Python 实现

### 四元数

```python
"""Quaternion helpers. Hamilton convention, scalar first q = [w, x, y, z].

q rotates body to world: v_w = q (x) [0, v_b] (x) q*, and C(q) = C_wb.
`qexp(v)` is the unit quaternion of the rotation by rotation vector v, i.e. the
exp(v/2) of the series notation: [cos(|v|/2), sin(|v|/2) v/|v|].
"""

import numpy as np

SMALL = 1e-8  # below this angle (rad) use the Taylor expansion


def qmul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ])


def qconj(q):
    return np.array([q[0], -q[1], -q[2], -q[3]])


def qnormalize(q):
    return q / np.sqrt(q @ q)


def qexp(v):
    """Rotation vector -> unit quaternion."""
    th = np.sqrt(v @ v)
    if th < SMALL:
        return np.array([1.0 - th * th / 8.0, *(0.5 * v)])
    s = np.sin(0.5 * th) / th
    return np.array([np.cos(0.5 * th), *(s * v)])


def qlog(q):
    """Unit quaternion -> rotation vector, using the sign with w >= 0 (angle in [0, pi])."""
    if q[0] < 0:
        q = -q
    u = q[1:]
    n = np.sqrt(u @ u)
    if n < SMALL:
        return 2.0 * u / q[0]
    return (2.0 * np.arctan2(n, q[0]) / n) * u


def qrot(q):
    """Direction cosine matrix C(q) = C_wb (body -> world)."""
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def dcm_to_quat(C):
    """C_wb -> unit quaternion with w >= 0 (Shepperd's method)."""
    t = C[0, 0] + C[1, 1] + C[2, 2]
    if t > 0:
        s = 2.0 * np.sqrt(1.0 + t)
        q = np.array([0.25 * s, (C[2, 1] - C[1, 2]) / s, (C[0, 2] - C[2, 0]) / s, (C[1, 0] - C[0, 1]) / s])
    elif C[0, 0] >= C[1, 1] and C[0, 0] >= C[2, 2]:
        s = 2.0 * np.sqrt(1.0 + C[0, 0] - C[1, 1] - C[2, 2])
        q = np.array([(C[2, 1] - C[1, 2]) / s, 0.25 * s, (C[0, 1] + C[1, 0]) / s, (C[0, 2] + C[2, 0]) / s])
    elif C[1, 1] >= C[2, 2]:
        s = 2.0 * np.sqrt(1.0 + C[1, 1] - C[0, 0] - C[2, 2])
        q = np.array([(C[0, 2] - C[2, 0]) / s, (C[0, 1] + C[1, 0]) / s, 0.25 * s, (C[1, 2] + C[2, 1]) / s])
    else:
        s = 2.0 * np.sqrt(1.0 + C[2, 2] - C[0, 0] - C[1, 1])
        q = np.array([(C[1, 0] - C[0, 1]) / s, (C[0, 2] + C[2, 0]) / s, (C[1, 2] + C[2, 1]) / s, 0.25 * s])
    return -q if q[0] < 0 else q


def skew(v):
    return np.array([[0.0, -v[2], v[1]], [v[2], 0.0, -v[0]], [-v[1], v[0], 0.0]])


def euler_zyx(q):
    """(yaw, pitch, roll) in radians for C_wb = Rz(yaw) Ry(pitch) Rx(roll)."""
    w, x, y, z = q
    yaw = np.arctan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    pitch = np.arcsin(np.clip(2 * (w * y - z * x), -1.0, 1.0))
    roll = np.arctan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
    return yaw, pitch, roll


def att_error(q_est, q_true):
    """Attitude error vector dtheta = 2 log(q_est^-1 (x) q_true), in the estimate's body frame."""
    return qlog(qmul(qconj(q_est), q_true))


def wrap_pi(a):
    """Wrap an angle to [-pi, pi)."""
    return (a + np.pi) % (2 * np.pi) - np.pi
```

每个函数都对应上面的一条公式。几点实现细节：

- `qexp` 和 `qlog` 在 `SMALL = 1e-8` 以下走泰勒展开，这个阈值在四种语言里完全一致，否则小角度那一支的舍入会出现跨语言差异。
- `qlog` 先把 $w<0$ 的四元数取反，保证返回的是 $[0,\pi]$ 内最短的旋转。
- `dcm_to_quat` 是 Shepperd 方法：对矩阵的迹和三个对角元里最大的那个分情况，避免对接近零的数开方后再相除。
- `euler_zyx` 里 `np.clip` 防止舍入误差把 `arcsin` 的参数推到 $\pm1$ 之外。
- `att_error` 返回 $\log(\hat q^{-1}\otimes q_{true})$，没有乘 2：`qlog` 本身已经返回旋转向量（含了那个 2），它就是约定里的 $\delta\theta$。

### 仿真器

```python
"""IMU simulator: truth attitude, gyro, accelerometer, magnetometer (NED world, FRD body)."""

from pathlib import Path

import numpy as np

from .io import write_csv

ROOT = Path(__file__).resolve().parents[2]

G = 9.80665
GRAVITY_W = np.array([0.0, 0.0, G])
DIP = np.radians(50.0)
MAG_W = np.array([np.cos(DIP), 0.0, np.sin(DIP)])

GYRO_SIGMA = 0.005  # rad/s per sample
BIAS0 = np.array([0.02, -0.01, 0.015])  # rad/s
BIAS_RW = 1e-4  # rad/s/sqrt(s)
ACC_SIGMA = 0.05  # m/s^2
MAG_SIGMA = 0.01  # unit-norm field
ACC_WINDOW = (60.0, 70.0)
MAG_WINDOW = (90.0, 100.0)
MAG_DISTURB = np.array([0.3, 0.3, 0.0])


def rate_b(t):
    """True body angular rate (rad/s)."""
    return np.array([
        0.8 * np.sin(2 * np.pi * 0.20 * t),
        0.6 * np.sin(2 * np.pi * 0.13 * t + 1.0),
        1.0 * np.sin(2 * np.pi * 0.07 * t + 2.0),
    ])


def _qmul(a, b):  # plain-float quaternion product, hot loop
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw)


def _qexp(v):
    th = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) ** 0.5
    if th < 1e-8:
        return (1.0 - th * th / 8.0, 0.5 * v[0], 0.5 * v[1], 0.5 * v[2])
    s = np.sin(0.5 * th) / th
    return (np.cos(0.5 * th), s * v[0], s * v[1], s * v[2])


def a_world(t):
    """Linear acceleration disturbance (world frame, m/s^2)."""
    if ACC_WINDOW[0] <= t < ACC_WINDOW[1]:
        return np.array([2.0 * np.sin(2 * np.pi * 0.5 * t), 0.0, 0.0])
    return np.zeros(3)


def simulate(seed, duration=120.0, imu_rate=100.0, truth_rate=1000.0, write=True):
    from .quat import qconj, qlog, qrot

    rng = np.random.default_rng(seed)
    dt = 1.0 / imu_rate
    sub = int(round(truth_rate / imu_rate))
    h = 1.0 / truth_rate
    n = int(round(duration * imu_rate))

    # truth attitude at the IMU sample instants, integrated at truth_rate
    # (exact quaternion exponential of the mid-interval rate); one extra step
    # before t = 0 gives the first sample its average rate as well.
    q = (1.0, 0.0, 0.0, 0.0)
    qs = np.empty((n, 4))
    for k in range(n):
        qs[k] = q
        for j in range(sub):
            t_mid = k * dt + (j + 0.5) * h
            q = _qmul(q, _qexp(rate_b(t_mid) * h))
        nq = (q[0] ** 2 + q[1] ** 2 + q[2] ** 2 + q[3] ** 2) ** 0.5
        q = tuple(c / nq for c in q)

    # gyro reports the rate averaged over the sample interval: rotvec(q_{k-1}^-1 q_k) / dt.
    # For k = 0 there is no previous sample, so use the instantaneous rate.
    avg = np.empty((n, 3))
    avg[0] = rate_b(0.0)
    for k in range(1, n):
        avg[k] = qlog(_qmul_np(qconj(qs[k - 1]), qs[k])) / dt

    bias = np.empty((n, 3))
    bias[0] = BIAS0
    bias[1:] = BIAS0 + np.cumsum(BIAS_RW * np.sqrt(dt) * rng.standard_normal((n - 1, 3)), axis=0)
    gyro = avg + bias + GYRO_SIGMA * rng.standard_normal((n, 3))

    t = np.arange(n) * dt
    acc = np.empty((n, 3))
    mag = np.empty((n, 3))
    acc_dist = np.zeros(n)
    mag_dist = np.zeros(n)
    na = ACC_SIGMA * rng.standard_normal((n, 3))
    nm = MAG_SIGMA * rng.standard_normal((n, 3))
    for k in range(n):
        C = qrot(qs[k])
        aw = a_world(t[k])
        mw = MAG_W.copy()
        if MAG_WINDOW[0] <= t[k] < MAG_WINDOW[1]:
            mw = mw + MAG_DISTURB
            mag_dist[k] = 1.0
        if ACC_WINDOW[0] <= t[k] < ACC_WINDOW[1]:
            acc_dist[k] = 1.0
        acc[k] = C.T @ (aw - GRAVITY_W) + na[k]
        mag[k] = C.T @ mw + nm[k]

    cols = {
        "t": t,
        "gx": gyro[:, 0], "gy": gyro[:, 1], "gz": gyro[:, 2],
        "ax": acc[:, 0], "ay": acc[:, 1], "az": acc[:, 2],
        "mx": mag[:, 0], "my": mag[:, 1], "mz": mag[:, 2],
        "qw": qs[:, 0], "qx": qs[:, 1], "qy": qs[:, 2], "qz": qs[:, 3],
        "bx": bias[:, 0], "by": bias[:, 1], "bz": bias[:, 2],
        "acc_dist": acc_dist, "mag_dist": mag_dist,
    }
    if write:
        write_csv(ROOT / "data" / f"imu_seed{seed}.csv", cols)
    return cols


def _qmul_np(a, b):
    from .quat import qmul

    return qmul(a, b)
```

热点循环（每个样本里 10 步指数积分）用普通元组实现 `_qmul`、`_qexp`，不走 numpy 小数组，120 秒的数据 4 秒内生成完。`simulate` 的结构：先积分真值，再由真值算出区间平均角速度，再叠加零偏和噪声，最后由真值姿态算加速度计和磁力计读数。

### Mahony 与基线

```python
"""Mahony explicit complementary filter with an integral bias term."""

import numpy as np

from .imu_sim import MAG_W
from .quat import qexp, qmul, qnormalize, qrot


class Mahony:
    """q <- q (x) exp((w_m - b + kp e) dt), b <- b - ki e dt,
    e = a_meas x a_pred + m_meas x m_pred (unit vectors in the body frame)."""

    def __init__(self, kp, ki, q0, m_w=MAG_W):
        self.kp, self.ki = kp, ki
        self.q = np.asarray(q0, dtype=float).copy()
        self.b = np.zeros(3)
        self.m_w = m_w

    def step(self, gyro, accel, mag, dt):
        C = qrot(self.q)
        a_pred = C.T @ np.array([0.0, 0.0, -1.0])
        m_pred = C.T @ self.m_w
        a_n = accel / np.sqrt(accel @ accel)
        m_n = mag / np.sqrt(mag @ mag)
        e = np.cross(a_n, a_pred) + np.cross(m_n, m_pred)
        self.b = self.b - self.ki * e * dt
        w = gyro - self.b + self.kp * e
        self.q = qnormalize(qmul(self.q, qexp(w * dt)))
        return self.q
```

```python
"""Attitude baselines: TRIAD snapshot and gyro-only integration."""

import numpy as np

from .quat import dcm_to_quat, qexp, qmul, qnormalize


def triad(accel, mag, m_w):
    """Attitude q (body -> world) from one accelerometer + magnetometer snapshot.

    Specific force at rest points opposite to gravity, [0, 0, -1] in the NED world frame.
    """
    r1 = np.array([0.0, 0.0, -1.0])
    r2 = m_w
    b1 = accel / np.sqrt(accel @ accel)
    b2 = mag / np.sqrt(mag @ mag)

    def frame(v1, v2):
        t2 = np.cross(v1, v2)
        t2 = t2 / np.sqrt(t2 @ t2)
        return np.column_stack([v1, t2, np.cross(v1, t2)])

    C = frame(r1, r2) @ frame(b1, b2).T  # world <- body
    return dcm_to_quat(C)


def gyro_only(gyro, dt, q0):
    """Integrate raw gyro samples 1..n-1 starting from q0 at sample 0."""
    n = len(gyro)
    q = np.asarray(q0, dtype=float).copy()
    out = np.empty((n, 4))
    out[0] = q
    for k in range(1, n):
        q = qnormalize(qmul(q, qexp(gyro[k] * dt)))
        out[k] = q
    return out
```

`Mahony.step` 是上面三个公式的逐行翻译。`triad` 里的 `frame` 构造标架（三个列向量），`C = frame(r1, r2) @ frame(b1, b2).T` 是 $C_{wb}$。

## C、C++、Rust 实现

四元数是这一章最典型的"同一个东西，三种语言三种惯用法"。

- **C：** 四元数是 `kl_real[4]`，函数把结果写入调用者给的输出数组，输出不与输入别名。没有类型的区别，`kl_real a[4]` 和 `kl_real v[3]` 在函数签名里只是文档。
- **C++：** `Quat<T>` 是带四个成员的结构体，重载 `operator*`，`Quat::exp(Vec3)` 是静态方法，`q.log()` 返回 `Vec3`。`Vec3<T>` 是第 2 篇的 `Mat<3,1,T>`，所以向量运算（`+`、`-`、`*` 标量）直接可用。
- **Rust：** `Quat` 是 `Copy` 的结构体，`impl Mul`；向量用 `[Real; 3]`，旋转矩阵用 `Mat<3, 3>`。

四元数乘法和指数/对数，三个版本放在一起看：

### C

```c
#include "kl/kl_quat.h"

#define SMALL ((kl_real)1e-8) /* below this angle (rad) use the Taylor expansion */

void kl_quat_mul(const kl_real *a, const kl_real *b, kl_real *out)
{
	out[0] = a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3];
	out[1] = a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2];
	out[2] = a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1];
	out[3] = a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0];
}

void kl_quat_conj(const kl_real *a, kl_real *out)
{
	out[0] = a[0];
	out[1] = -a[1];
	out[2] = -a[2];
	out[3] = -a[3];
}

void kl_quat_normalize(kl_real *q)
{
	kl_real n = KL_SQRT(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
	for (int i = 0; i < 4; i++)
		q[i] /= n;
}

void kl_quat_exp(const kl_real v[3], kl_real q[4])
{
	kl_real th = KL_SQRT(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
	if (th < SMALL) {
		q[0] = 1 - th * th / 8;
		for (int i = 0; i < 3; i++)
			q[1 + i] = (kl_real)0.5 * v[i];
		return;
	}
	kl_real s = KL_SIN((kl_real)0.5 * th) / th;
	q[0] = KL_COS((kl_real)0.5 * th);
	for (int i = 0; i < 3; i++)
		q[1 + i] = s * v[i];
}

void kl_quat_log(const kl_real q[4], kl_real v[3])
{
	kl_real sg = q[0] < 0 ? -1 : 1;
	kl_real w = sg * q[0], u[3] = {sg * q[1], sg * q[2], sg * q[3]};
	kl_real n = KL_SQRT(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
	kl_real k = n < SMALL ? 2 / w : 2 * KL_ATAN2(n, w) / n;
	for (int i = 0; i < 3; i++)
		v[i] = k * u[i];
}
```

`kl_quat_mul(a, b, out)` 的 `out` 不能与 `a`、`b` 是同一块内存：每个分量用到所有输入。Mahony 一步：

```c
		f->m_w[i] = m_w[i];
	}
}

void kl_mahony_step(kl_mahony *f, const kl_real gyro[3], const kl_real accel[3],
		    const kl_real mag[3], kl_real dt)
{
	kl_real C[9], a_pred[3], m_pred[3], a_n[3], m_n[3], e1[3], e2[3], e[3], w[3], dq[4], qn[4];
	kl_quat_to_dcm(f->q, C);
	/* a_pred = C^T [0,0,-1], m_pred = C^T m_w */
	for (int i = 0; i < 3; i++) {
		a_pred[i] = -C[6 + i];
		m_pred[i] = C[i] * f->m_w[0] + C[3 + i] * f->m_w[1] + C[6 + i] * f->m_w[2];
	}
	unit(accel, a_n);
	unit(mag, m_n);
	cross(a_n, a_pred, e1);
	cross(m_n, m_pred, e2);
	for (int i = 0; i < 3; i++) {
		e[i] = e1[i] + e2[i];
		f->b[i] = f->b[i] - f->ki * e[i] * dt;
		w[i] = (gyro[i] - f->b[i] + f->kp * e[i]) * dt;
	}
	kl_quat_exp(w, dq);
	kl_quat_mul(f->q, dq, qn);
	kl_quat_normalize(qn);
	for (int i = 0; i < 4; i++)
		f->q[i] = qn[i];
}
```

`a_pred = -C[6 + i]`：$C^T[0,0,-1]^T$ 就是 $-1$ 乘以 $C$ 的第三行，不需要完整的矩阵向量乘法。

<details>
<summary>完整源码：c/include/kl/kl_quat.h、c/src/kl_quat.c、c/include/kl/kl_mahony.h、c/src/kl_mahony.c、c/src/kl_baselines.c</summary>

```c
/* Quaternions, Hamilton convention, scalar first q = [w, x, y, z].
 * q rotates body to world: v_w = q (x) [0, v_b] (x) q*, and C(q) = C_wb (row-major 3x3).
 * Output buffers never alias inputs unless stated. */
#ifndef KL_QUAT_H
#define KL_QUAT_H

#include "kl/kl_real.h"

/* out = a (x) b */
void kl_quat_mul(const kl_real *a, const kl_real *b, kl_real *out);
void kl_quat_conj(const kl_real *a, kl_real *out);
/* q = q / |q|, in place */
void kl_quat_normalize(kl_real *q);
/* Rotation vector -> unit quaternion [cos(|v|/2), sin(|v|/2) v/|v|]. */
void kl_quat_exp(const kl_real v[3], kl_real q[4]);
/* Unit quaternion -> rotation vector with angle in [0, pi] (q and -q give the same v). */
void kl_quat_log(const kl_real q[4], kl_real v[3]);
/* C(q) = C_wb */
void kl_quat_to_dcm(const kl_real q[4], kl_real C[9]);
/* C_wb -> unit quaternion with w >= 0 (Shepperd's method) */
void kl_dcm_to_quat(const kl_real C[9], kl_real q[4]);
/* S v = [v]x w = v x w */
void kl_skew(const kl_real v[3], kl_real S[9]);
/* C_wb = Rz(yaw) Ry(pitch) Rx(roll) */
void kl_quat_to_euler_zyx(const kl_real q[4], kl_real *yaw, kl_real *pitch, kl_real *roll);
/* v = log(est^* (x) tru): attitude error in the estimate's body frame */
void kl_quat_error(const kl_real est[4], const kl_real tru[4], kl_real v[3]);

#endif
```

```c
#include "kl/kl_quat.h"

#define SMALL ((kl_real)1e-8) /* below this angle (rad) use the Taylor expansion */

void kl_quat_mul(const kl_real *a, const kl_real *b, kl_real *out)
{
	out[0] = a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3];
	out[1] = a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2];
	out[2] = a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1];
	out[3] = a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0];
}

void kl_quat_conj(const kl_real *a, kl_real *out)
{
	out[0] = a[0];
	out[1] = -a[1];
	out[2] = -a[2];
	out[3] = -a[3];
}

void kl_quat_normalize(kl_real *q)
{
	kl_real n = KL_SQRT(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
	for (int i = 0; i < 4; i++)
		q[i] /= n;
}

void kl_quat_exp(const kl_real v[3], kl_real q[4])
{
	kl_real th = KL_SQRT(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
	if (th < SMALL) {
		q[0] = 1 - th * th / 8;
		for (int i = 0; i < 3; i++)
			q[1 + i] = (kl_real)0.5 * v[i];
		return;
	}
	kl_real s = KL_SIN((kl_real)0.5 * th) / th;
	q[0] = KL_COS((kl_real)0.5 * th);
	for (int i = 0; i < 3; i++)
		q[1 + i] = s * v[i];
}

void kl_quat_log(const kl_real q[4], kl_real v[3])
{
	kl_real sg = q[0] < 0 ? -1 : 1;
	kl_real w = sg * q[0], u[3] = {sg * q[1], sg * q[2], sg * q[3]};
	kl_real n = KL_SQRT(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
	kl_real k = n < SMALL ? 2 / w : 2 * KL_ATAN2(n, w) / n;
	for (int i = 0; i < 3; i++)
		v[i] = k * u[i];
}

void kl_quat_to_dcm(const kl_real q[4], kl_real C[9])
{
	kl_real w = q[0], x = q[1], y = q[2], z = q[3];
	C[0] = 1 - 2 * (y * y + z * z);
	C[1] = 2 * (x * y - w * z);
	C[2] = 2 * (x * z + w * y);
	C[3] = 2 * (x * y + w * z);
	C[4] = 1 - 2 * (x * x + z * z);
	C[5] = 2 * (y * z - w * x);
	C[6] = 2 * (x * z - w * y);
	C[7] = 2 * (y * z + w * x);
	C[8] = 1 - 2 * (x * x + y * y);
}

void kl_dcm_to_quat(const kl_real C[9], kl_real q[4])
{
	kl_real t = C[0] + C[4] + C[8], s;
	if (t > 0) {
		s = 2 * KL_SQRT(1 + t);
		q[0] = (kl_real)0.25 * s;
		q[1] = (C[7] - C[5]) / s;
		q[2] = (C[2] - C[6]) / s;
		q[3] = (C[3] - C[1]) / s;
	} else if (C[0] >= C[4] && C[0] >= C[8]) {
		s = 2 * KL_SQRT(1 + C[0] - C[4] - C[8]);
		q[0] = (C[7] - C[5]) / s;
		q[1] = (kl_real)0.25 * s;
		q[2] = (C[1] + C[3]) / s;
		q[3] = (C[2] + C[6]) / s;
	} else if (C[4] >= C[8]) {
		s = 2 * KL_SQRT(1 + C[4] - C[0] - C[8]);
		q[0] = (C[2] - C[6]) / s;
		q[1] = (C[1] + C[3]) / s;
		q[2] = (kl_real)0.25 * s;
		q[3] = (C[5] + C[7]) / s;
	} else {
		s = 2 * KL_SQRT(1 + C[8] - C[0] - C[4]);
		q[0] = (C[3] - C[1]) / s;
		q[1] = (C[2] + C[6]) / s;
		q[2] = (C[5] + C[7]) / s;
		q[3] = (kl_real)0.25 * s;
	}
	if (q[0] < 0)
		for (int i = 0; i < 4; i++)
			q[i] = -q[i];
}

void kl_skew(const kl_real v[3], kl_real S[9])
{
	S[0] = 0;
	S[1] = -v[2];
	S[2] = v[1];
	S[3] = v[2];
	S[4] = 0;
	S[5] = -v[0];
	S[6] = -v[1];
	S[7] = v[0];
	S[8] = 0;
}

void kl_quat_to_euler_zyx(const kl_real q[4], kl_real *yaw, kl_real *pitch, kl_real *roll)
{
	kl_real w = q[0], x = q[1], y = q[2], z = q[3];
	kl_real sp = 2 * (w * y - z * x);
	sp = sp > 1 ? 1 : (sp < -1 ? -1 : sp);
	*yaw = KL_ATAN2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
	*pitch = KL_ASIN(sp);
	*roll = KL_ATAN2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
}

void kl_quat_error(const kl_real est[4], const kl_real tru[4], kl_real v[3])
{
	kl_real c[4], d[4];
	kl_quat_conj(est, c);
	kl_quat_mul(c, tru, d);
	kl_quat_log(d, v);
}
```

```c
/* Mahony explicit complementary filter with an integral bias term.
 * q <- q (x) exp((w_m - b + kp e) dt), b <- b - ki e dt (b is updated first),
 * e = a_meas x a_pred + m_meas x m_pred, unit vectors in the body frame.
 * Quaternion conventions: see kl_quat.h. */
#ifndef KL_MAHONY_H
#define KL_MAHONY_H

#include "kl/kl_real.h"

typedef struct {
	kl_real kp, ki;
	kl_real q[4], b[3], m_w[3];
} kl_mahony;

/* m_w: reference magnetic field in the world frame (NED), e.g. [cos 50deg, 0, sin 50deg]. */
void kl_mahony_init(kl_mahony *f, kl_real kp, kl_real ki, const kl_real q0[4], const kl_real m_w[3]);
void kl_mahony_step(kl_mahony *f, const kl_real gyro[3], const kl_real accel[3],
		    const kl_real mag[3], kl_real dt);

#endif
```

```c
#include "kl/kl_mahony.h"

#include "kl/kl_quat.h"

static void cross(const kl_real *a, const kl_real *b, kl_real *c)
{
	c[0] = a[1] * b[2] - a[2] * b[1];
	c[1] = a[2] * b[0] - a[0] * b[2];
	c[2] = a[0] * b[1] - a[1] * b[0];
}

static void unit(const kl_real *v, kl_real *u)
{
	kl_real n = KL_SQRT(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
	for (int i = 0; i < 3; i++)
		u[i] = v[i] / n;
}

void kl_mahony_init(kl_mahony *f, kl_real kp, kl_real ki, const kl_real q0[4], const kl_real m_w[3])
{
	f->kp = kp;
	f->ki = ki;
	for (int i = 0; i < 4; i++)
		f->q[i] = q0[i];
	for (int i = 0; i < 3; i++) {
		f->b[i] = 0;
		f->m_w[i] = m_w[i];
	}
}

void kl_mahony_step(kl_mahony *f, const kl_real gyro[3], const kl_real accel[3],
		    const kl_real mag[3], kl_real dt)
{
	kl_real C[9], a_pred[3], m_pred[3], a_n[3], m_n[3], e1[3], e2[3], e[3], w[3], dq[4], qn[4];
	kl_quat_to_dcm(f->q, C);
	/* a_pred = C^T [0,0,-1], m_pred = C^T m_w */
	for (int i = 0; i < 3; i++) {
		a_pred[i] = -C[6 + i];
		m_pred[i] = C[i] * f->m_w[0] + C[3 + i] * f->m_w[1] + C[6 + i] * f->m_w[2];
	}
	unit(accel, a_n);
	unit(mag, m_n);
	cross(a_n, a_pred, e1);
	cross(m_n, m_pred, e2);
	for (int i = 0; i < 3; i++) {
		e[i] = e1[i] + e2[i];
		f->b[i] = f->b[i] - f->ki * e[i] * dt;
		w[i] = (gyro[i] - f->b[i] + f->kp * e[i]) * dt;
	}
	kl_quat_exp(w, dq);
	kl_quat_mul(f->q, dq, qn);
	kl_quat_normalize(qn);
	for (int i = 0; i < 4; i++)
		f->q[i] = qn[i];
}
```

```c
/* Attitude baselines: TRIAD snapshot and gyro-only integration. Conventions: see kl_quat.h. */
#ifndef KL_BASELINES_H
#define KL_BASELINES_H

#include "kl/kl_real.h"

/* Attitude q (body -> world) from one accelerometer + magnetometer snapshot.
 * Specific force at rest points opposite to gravity, [0, 0, -1] in the NED world frame. */
void kl_triad(const kl_real accel[3], const kl_real mag[3], const kl_real m_w[3], kl_real q[4]);
/* q = normalize(q (x) exp(gyro dt)), in place */
void kl_gyro_step(kl_real q[4], const kl_real gyro[3], kl_real dt);

#endif
```

```c
#include "kl/kl_baselines.h"

#include "kl/kl_quat.h"

static void cross(const kl_real *a, const kl_real *b, kl_real *c)
{
	c[0] = a[1] * b[2] - a[2] * b[1];
	c[1] = a[2] * b[0] - a[0] * b[2];
	c[2] = a[0] * b[1] - a[1] * b[0];
}

static void unit(const kl_real *v, kl_real *u)
{
	kl_real n = KL_SQRT(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
	for (int i = 0; i < 3; i++)
		u[i] = v[i] / n;
}

/* Columns [v1, t2, v1 x t2] with t2 = unit(v1 x v2), stored row-major in M. */
static void frame(const kl_real *v1, const kl_real *v2, kl_real *M)
{
	kl_real t2[3], t3[3];
	cross(v1, v2, t2);
	unit(t2, t2);
	cross(v1, t2, t3);
	for (int i = 0; i < 3; i++) {
		M[i * 3 + 0] = v1[i];
		M[i * 3 + 1] = t2[i];
		M[i * 3 + 2] = t3[i];
	}
}

void kl_triad(const kl_real accel[3], const kl_real mag[3], const kl_real m_w[3], kl_real q[4])
{
	const kl_real r1[3] = {0, 0, -1};
	kl_real b1[3], b2[3], Fr[9], Fb[9], C[9];
	unit(accel, b1);
	unit(mag, b2);
	frame(r1, m_w, Fr);
	frame(b1, b2, Fb);
	/* C = Fr Fb^T: world <- body */
	for (int i = 0; i < 3; i++)
		for (int j = 0; j < 3; j++) {
			kl_real s = 0;
			for (int k = 0; k < 3; k++)
				s += Fr[i * 3 + k] * Fb[j * 3 + k];
			C[i * 3 + j] = s;
		}
	kl_dcm_to_quat(C, q);
}

void kl_gyro_step(kl_real q[4], const kl_real gyro[3], kl_real dt)
{
	kl_real w[3] = {gyro[0] * dt, gyro[1] * dt, gyro[2] * dt}, dq[4], qn[4];
	kl_quat_exp(w, dq);
	kl_quat_mul(q, dq, qn);
	kl_quat_normalize(qn);
	for (int i = 0; i < 4; i++)
		q[i] = qn[i];
}
```

</details>

### C++

```cpp
template <class T = double>
struct Quat {
	static constexpr T SMALL = T(1e-8);  // below this angle (rad) use the Taylor expansion

	T w = 1, x = 0, y = 0, z = 0;

	static constexpr Quat identity() { return Quat{}; }

	constexpr Quat operator*(const Quat& b) const {
		return {w * b.w - x * b.x - y * b.y - z * b.z, w * b.x + x * b.w + y * b.z - z * b.y,
			w * b.y - x * b.z + y * b.w + z * b.x, w * b.z + x * b.y - y * b.x + z * b.w};
	}

	constexpr Quat conj() const { return {w, -x, -y, -z}; }

	Quat normalized() const {
		const T n = std::sqrt(w * w + x * x + y * y + z * z);
		return {w / n, x / n, y / n, z / n};
	}

	// Rotation vector -> unit quaternion.
	static Quat exp(const Vec3<T>& v) {
		const T th = std::sqrt(dot(v, v));
		if (th < SMALL) return {1 - th * th / 8, v(0, 0) / 2, v(1, 0) / 2, v(2, 0) / 2};
		const T s = std::sin(th / 2) / th;
		return {std::cos(th / 2), s * v(0, 0), s * v(1, 0), s * v(2, 0)};
	}

	// Unit quaternion -> rotation vector, using the sign with w >= 0 (angle in [0, pi]).
	Vec3<T> log() const {
		const Quat q = w < 0 ? Quat{-w, -x, -y, -z} : *this;
		const Vec3<T> u{{q.x, q.y, q.z}};
		const T n = std::sqrt(dot(u, u));
		if (n < SMALL) return u * (2 / q.w);
		return u * (2 * std::atan2(n, q.w) / n);
	}
```

```cpp
	Mahony(T kp, T ki, const Quat<T>& q0, const Vec3<T>& m_w = default_mag_w<T>())
	    : kp(kp), ki(ki), q(q0), m_w(m_w) {}

	const Quat<T>& step(const Vec3<T>& gyro, const Vec3<T>& accel, const Vec3<T>& mag, T dt) {
		const Mat<3, 3, T> Ct = q.dcm().transpose();
		const Vec3<T> a_pred = Ct * Vec3<T>{{0, 0, -1}};
		const Vec3<T> m_pred = Ct * m_w;
		const Vec3<T> a_n = accel * (1 / std::sqrt(dot(accel, accel)));
		const Vec3<T> m_n = mag * (1 / std::sqrt(dot(mag, mag)));
		const Vec3<T> e = cross(a_n, a_pred) + cross(m_n, m_pred);
		b = b - e * (ki * dt);  // update the bias before forming the rate
		const Vec3<T> w = gyro - b + e * kp;
		q = (q * Quat<T>::exp(w * dt)).normalized();
		return q;
	}
};
```

`step` 读起来几乎就是公式：`cross(a_n, a_pred) + cross(m_n, m_pred)` 是 $e$，`b - e * (ki * dt)` 是零偏更新，`(q * Quat<T>::exp(w * dt)).normalized()` 是姿态更新。算术都是第 2 篇的 `Mat<3,1,T>` 运算符，没有手写循环。

<details>
<summary>完整源码：cpp/include/kl/quat.hpp、mahony.hpp、baselines.hpp</summary>

```cpp
// Hamilton quaternions, scalar first q = [w, x, y, z].
// q rotates body to world: v_w = q (x) [0, v_b] (x) q*, and dcm() is C(q) = C_wb.
// exp(v) maps a rotation vector to the unit quaternion [cos(|v|/2), sin(|v|/2) v/|v|].
#pragma once
#include <cmath>

#include "kl/mat.hpp"

namespace kl {

template <class T = double>
using Vec3 = Mat<3, 1, T>;

template <class T = double>
constexpr Vec3<T> cross(const Vec3<T>& a, const Vec3<T>& b) {
	return Vec3<T>{{a(1, 0) * b(2, 0) - a(2, 0) * b(1, 0), a(2, 0) * b(0, 0) - a(0, 0) * b(2, 0),
			a(0, 0) * b(1, 0) - a(1, 0) * b(0, 0)}};
}

template <class T = double>
constexpr T dot(const Vec3<T>& a, const Vec3<T>& b) {
	return a(0, 0) * b(0, 0) + a(1, 0) * b(1, 0) + a(2, 0) * b(2, 0);
}

// [v]_x, so that skew(a) * b = a x b
template <class T = double>
constexpr Mat<3, 3, T> skew(const Vec3<T>& v) {
	return Mat<3, 3, T>{{0, -v(2, 0), v(1, 0), v(2, 0), 0, -v(0, 0), -v(1, 0), v(0, 0), 0}};
}

template <class T = double>
struct Quat {
	static constexpr T SMALL = T(1e-8);  // below this angle (rad) use the Taylor expansion

	T w = 1, x = 0, y = 0, z = 0;

	static constexpr Quat identity() { return Quat{}; }

	constexpr Quat operator*(const Quat& b) const {
		return {w * b.w - x * b.x - y * b.y - z * b.z, w * b.x + x * b.w + y * b.z - z * b.y,
			w * b.y - x * b.z + y * b.w + z * b.x, w * b.z + x * b.y - y * b.x + z * b.w};
	}

	constexpr Quat conj() const { return {w, -x, -y, -z}; }

	Quat normalized() const {
		const T n = std::sqrt(w * w + x * x + y * y + z * z);
		return {w / n, x / n, y / n, z / n};
	}

	// Rotation vector -> unit quaternion.
	static Quat exp(const Vec3<T>& v) {
		const T th = std::sqrt(dot(v, v));
		if (th < SMALL) return {1 - th * th / 8, v(0, 0) / 2, v(1, 0) / 2, v(2, 0) / 2};
		const T s = std::sin(th / 2) / th;
		return {std::cos(th / 2), s * v(0, 0), s * v(1, 0), s * v(2, 0)};
	}

	// Unit quaternion -> rotation vector, using the sign with w >= 0 (angle in [0, pi]).
	Vec3<T> log() const {
		const Quat q = w < 0 ? Quat{-w, -x, -y, -z} : *this;
		const Vec3<T> u{{q.x, q.y, q.z}};
		const T n = std::sqrt(dot(u, u));
		if (n < SMALL) return u * (2 / q.w);
		return u * (2 * std::atan2(n, q.w) / n);
	}

	// C(q) = C_wb, body to world.
	constexpr Mat<3, 3, T> dcm() const {
		return Mat<3, 3, T>{{1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
				     2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
				     2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)}};
	}

	// C_wb -> unit quaternion with w >= 0 (Shepperd's method).
	static Quat from_dcm(const Mat<3, 3, T>& C) {
		const T t = C(0, 0) + C(1, 1) + C(2, 2);
		Quat q;
		if (t > 0) {
			const T s = 2 * std::sqrt(1 + t);
			q = {s / 4, (C(2, 1) - C(1, 2)) / s, (C(0, 2) - C(2, 0)) / s, (C(1, 0) - C(0, 1)) / s};
		} else if (C(0, 0) >= C(1, 1) && C(0, 0) >= C(2, 2)) {
			const T s = 2 * std::sqrt(1 + C(0, 0) - C(1, 1) - C(2, 2));
			q = {(C(2, 1) - C(1, 2)) / s, s / 4, (C(0, 1) + C(1, 0)) / s, (C(0, 2) + C(2, 0)) / s};
		} else if (C(1, 1) >= C(2, 2)) {
			const T s = 2 * std::sqrt(1 + C(1, 1) - C(0, 0) - C(2, 2));
			q = {(C(0, 2) - C(2, 0)) / s, (C(0, 1) + C(1, 0)) / s, s / 4, (C(1, 2) + C(2, 1)) / s};
		} else {
			const T s = 2 * std::sqrt(1 + C(2, 2) - C(0, 0) - C(1, 1));
			q = {(C(1, 0) - C(0, 1)) / s, (C(0, 2) + C(2, 0)) / s, (C(1, 2) + C(2, 1)) / s, s / 4};
		}
		return q.w < 0 ? Quat{-q.w, -q.x, -q.y, -q.z} : q;
	}

	// (yaw, pitch, roll) in radians for C_wb = Rz(yaw) Ry(pitch) Rx(roll).
	Vec3<T> euler_zyx() const {
		const T yaw = std::atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
		const T sp = std::fmax(T(-1), std::fmin(T(1), 2 * (w * y - z * x)));
		const T roll = std::atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
		return Vec3<T>{{yaw, std::asin(sp), roll}};
	}
};

// Attitude error vector log(est^-1 (x) truth), in the estimate's body frame.
template <class T>
Vec3<T> att_error(const Quat<T>& est, const Quat<T>& truth) {
	return (est.conj() * truth).log();
}

}  // namespace kl
```

```cpp
// Mahony explicit complementary filter with an integral bias term.
// q <- q (x) exp((w_m - b + kp e) dt), b <- b - ki e dt,
// e = a_meas x a_pred + m_meas x m_pred (unit vectors in the body frame).
#pragma once
#include "kl/quat.hpp"

namespace kl {

// Reference magnetic field in the NED world frame: unit norm, 50 deg dip, no declination.
template <class T = double>
Vec3<T> default_mag_w() {
	const T dip = T(50) * T(3.14159265358979323846) / 180;
	return Vec3<T>{{std::cos(dip), 0, std::sin(dip)}};
}

template <class T = double>
class Mahony {
public:
	T kp, ki;
	Quat<T> q;
	Vec3<T> b{};
	Vec3<T> m_w;

	Mahony(T kp, T ki, const Quat<T>& q0, const Vec3<T>& m_w = default_mag_w<T>())
	    : kp(kp), ki(ki), q(q0), m_w(m_w) {}

	const Quat<T>& step(const Vec3<T>& gyro, const Vec3<T>& accel, const Vec3<T>& mag, T dt) {
		const Mat<3, 3, T> Ct = q.dcm().transpose();
		const Vec3<T> a_pred = Ct * Vec3<T>{{0, 0, -1}};
		const Vec3<T> m_pred = Ct * m_w;
		const Vec3<T> a_n = accel * (1 / std::sqrt(dot(accel, accel)));
		const Vec3<T> m_n = mag * (1 / std::sqrt(dot(mag, mag)));
		const Vec3<T> e = cross(a_n, a_pred) + cross(m_n, m_pred);
		b = b - e * (ki * dt);  // update the bias before forming the rate
		const Vec3<T> w = gyro - b + e * kp;
		q = (q * Quat<T>::exp(w * dt)).normalized();
		return q;
	}
};

}  // namespace kl
```

```cpp
// Attitude baselines: TRIAD snapshot and gyro-only integration.
#pragma once
#include "kl/quat.hpp"

namespace kl {

// Attitude q (body -> world) from one accelerometer + magnetometer snapshot.
// Specific force at rest points opposite to gravity, [0, 0, -1] in the NED world frame.
template <class T>
Quat<T> triad(const Vec3<T>& accel, const Vec3<T>& mag, const Vec3<T>& m_w) {
	auto frame = [](const Vec3<T>& v1, const Vec3<T>& v2) {
		Vec3<T> t2 = cross(v1, v2);
		t2 = t2 * (1 / std::sqrt(dot(t2, t2)));
		const Vec3<T> t3 = cross(v1, t2);
		Mat<3, 3, T> f{};
		for (std::size_t i = 0; i < 3; i++) {
			f(i, 0) = v1(i, 0);
			f(i, 1) = t2(i, 0);
			f(i, 2) = t3(i, 0);
		}
		return f;
	};
	const Vec3<T> b1 = accel * (1 / std::sqrt(dot(accel, accel)));
	const Vec3<T> b2 = mag * (1 / std::sqrt(dot(mag, mag)));
	const Mat<3, 3, T> C = frame(Vec3<T>{{0, 0, -1}}, m_w) * frame(b1, b2).transpose();
	return Quat<T>::from_dcm(C);
}

// One gyro-only integration step, q <- normalize(q (x) exp(gyro dt)).
template <class T>
void gyro_step(Quat<T>& q, const Vec3<T>& gyro, T dt) {
	q = (q * Quat<T>::exp(gyro * dt)).normalized();
}

}  // namespace kl
```

</details>

### Rust

```rust
#[derive(Clone, Copy, Debug)]
pub struct Quat {
    pub w: Real,
    pub x: Real,
    pub y: Real,
    pub z: Real,
}

impl Mul for Quat {
    type Output = Quat;
    fn mul(self, b: Quat) -> Quat {
        let a = self;
        Quat {
            w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
            x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        }
    }
}

impl Quat {
    pub const fn identity() -> Self {
        Quat {
            w: 1.0,
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }
    }

    pub fn conj(self) -> Quat {
        Quat {
            w: self.w,
            x: -self.x,
            y: -self.y,
            z: -self.z,
        }
    }

    pub fn normalized(self) -> Quat {
        let n = sqrt(self.w * self.w + self.x * self.x + self.y * self.y + self.z * self.z);
        Quat {
            w: self.w / n,
            x: self.x / n,
            y: self.y / n,
            z: self.z / n,
        }
    }

    /// Rotation vector -> unit quaternion.
    pub fn exp(v: [Real; 3]) -> Quat {
        let th = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        if th < SMALL {
            return Quat {
                w: 1.0 - th * th / 8.0,
                x: 0.5 * v[0],
                y: 0.5 * v[1],
                z: 0.5 * v[2],
            };
        }
        let s = sin(0.5 * th) / th;
        Quat {
            w: cos(0.5 * th),
            x: s * v[0],
            y: s * v[1],
            z: s * v[2],
        }
    }

    /// Unit quaternion -> rotation vector, using the sign with w >= 0.
    pub fn log(self) -> [Real; 3] {
        let q = if self.w < 0.0 {
            Quat {
                w: -self.w,
                x: -self.x,
                y: -self.y,
                z: -self.z,
            }
        } else {
            self
        };
        let n = sqrt(q.x * q.x + q.y * q.y + q.z * q.z);
        let k = if n < SMALL {
            2.0 / q.w
        } else {
            2.0 * atan2(n, q.w) / n
        };
        [k * q.x, k * q.y, k * q.z]
    }
```

```rust
    pub fn step(&mut self, gyro: [Real; 3], accel: [Real; 3], mag: [Real; 3], dt: Real) {
        // Predicted body-frame directions: C^T v
        let ct = self.q.dcm().transpose();
        let pred = |v: [Real; 3]| -> [Real; 3] {
            let mut o = [0.0; 3];
            for (i, oi) in o.iter_mut().enumerate() {
                *oi = ct.m[i][0] * v[0] + ct.m[i][1] * v[1] + ct.m[i][2] * v[2];
            }
            o
        };
        let ea = cross(unit(accel), pred([0.0, 0.0, -1.0]));
        let em = cross(unit(mag), pred(self.m_w));
        let mut w = [0.0; 3];
        for i in 0..3 {
            let e = ea[i] + em[i];
            self.b[i] -= self.ki * e * dt;
            w[i] = (gyro[i] - self.b[i] + self.kp * e) * dt;
        }
        self.q = (self.q * Quat::exp(w)).normalized();
    }
}
```

`Quat` 派生 `Copy`，所以 `self.q * Quat::exp(w)` 不会"移动走" `self.q`，赋值回 `self.q` 也没问题。`step` 里 `pred` 是个闭包，用 `ct`（$C^T$）把世界系向量映射到机体系。Rust 版和 C++ 版的数学一样，差别在于：Rust 没有运算符重载到 `[Real; 3]` 上（数组不是我定义的类型，孤儿规则不允许），所以向量运算是显式的循环；C++ 的 `Vec3` 是自己的类型，运算符想怎么重载都行。

<details>
<summary>完整源码：rust/src/quat.rs、mahony.rs、baselines.rs</summary>

```rust
//! Hamilton quaternions, scalar first q = [w, x, y, z].
//! q rotates body to world, C(q) = C_wb. `exp(v)` maps a rotation vector to the
//! unit quaternion [cos(|v|/2), sin(|v|/2) v/|v|].

use crate::mat::Mat;
use crate::real::{Real, asin, atan2, cos, sin, sqrt};
use core::ops::Mul;

/// Below this angle (rad) use the Taylor expansion.
const SMALL: Real = 1e-8;

#[derive(Clone, Copy, Debug)]
pub struct Quat {
    pub w: Real,
    pub x: Real,
    pub y: Real,
    pub z: Real,
}

impl Mul for Quat {
    type Output = Quat;
    fn mul(self, b: Quat) -> Quat {
        let a = self;
        Quat {
            w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
            x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        }
    }
}

impl Quat {
    pub const fn identity() -> Self {
        Quat {
            w: 1.0,
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }
    }

    pub fn conj(self) -> Quat {
        Quat {
            w: self.w,
            x: -self.x,
            y: -self.y,
            z: -self.z,
        }
    }

    pub fn normalized(self) -> Quat {
        let n = sqrt(self.w * self.w + self.x * self.x + self.y * self.y + self.z * self.z);
        Quat {
            w: self.w / n,
            x: self.x / n,
            y: self.y / n,
            z: self.z / n,
        }
    }

    /// Rotation vector -> unit quaternion.
    pub fn exp(v: [Real; 3]) -> Quat {
        let th = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        if th < SMALL {
            return Quat {
                w: 1.0 - th * th / 8.0,
                x: 0.5 * v[0],
                y: 0.5 * v[1],
                z: 0.5 * v[2],
            };
        }
        let s = sin(0.5 * th) / th;
        Quat {
            w: cos(0.5 * th),
            x: s * v[0],
            y: s * v[1],
            z: s * v[2],
        }
    }

    /// Unit quaternion -> rotation vector, using the sign with w >= 0.
    pub fn log(self) -> [Real; 3] {
        let q = if self.w < 0.0 {
            Quat {
                w: -self.w,
                x: -self.x,
                y: -self.y,
                z: -self.z,
            }
        } else {
            self
        };
        let n = sqrt(q.x * q.x + q.y * q.y + q.z * q.z);
        let k = if n < SMALL {
            2.0 / q.w
        } else {
            2.0 * atan2(n, q.w) / n
        };
        [k * q.x, k * q.y, k * q.z]
    }

    /// Direction cosine matrix C(q) = C_wb (body -> world).
    pub fn dcm(self) -> Mat<3, 3> {
        let Quat { w, x, y, z } = self;
        Mat {
            m: [
                [
                    1.0 - 2.0 * (y * y + z * z),
                    2.0 * (x * y - w * z),
                    2.0 * (x * z + w * y),
                ],
                [
                    2.0 * (x * y + w * z),
                    1.0 - 2.0 * (x * x + z * z),
                    2.0 * (y * z - w * x),
                ],
                [
                    2.0 * (x * z - w * y),
                    2.0 * (y * z + w * x),
                    1.0 - 2.0 * (x * x + y * y),
                ],
            ],
        }
    }

    /// C_wb -> unit quaternion with w >= 0 (Shepperd's method).
    pub fn from_dcm(c: &Mat<3, 3>) -> Quat {
        let c = &c.m;
        let t = c[0][0] + c[1][1] + c[2][2];
        let q = if t > 0.0 {
            let s = 2.0 * sqrt(1.0 + t);
            Quat {
                w: 0.25 * s,
                x: (c[2][1] - c[1][2]) / s,
                y: (c[0][2] - c[2][0]) / s,
                z: (c[1][0] - c[0][1]) / s,
            }
        } else if c[0][0] >= c[1][1] && c[0][0] >= c[2][2] {
            let s = 2.0 * sqrt(1.0 + c[0][0] - c[1][1] - c[2][2]);
            Quat {
                w: (c[2][1] - c[1][2]) / s,
                x: 0.25 * s,
                y: (c[0][1] + c[1][0]) / s,
                z: (c[0][2] + c[2][0]) / s,
            }
        } else if c[1][1] >= c[2][2] {
            let s = 2.0 * sqrt(1.0 + c[1][1] - c[0][0] - c[2][2]);
            Quat {
                w: (c[0][2] - c[2][0]) / s,
                x: (c[0][1] + c[1][0]) / s,
                y: 0.25 * s,
                z: (c[1][2] + c[2][1]) / s,
            }
        } else {
            let s = 2.0 * sqrt(1.0 + c[2][2] - c[0][0] - c[1][1]);
            Quat {
                w: (c[1][0] - c[0][1]) / s,
                x: (c[0][2] + c[2][0]) / s,
                y: (c[1][2] + c[2][1]) / s,
                z: 0.25 * s,
            }
        };
        if q.w < 0.0 {
            Quat {
                w: -q.w,
                x: -q.x,
                y: -q.y,
                z: -q.z,
            }
        } else {
            q
        }
    }

    /// (yaw, pitch, roll) in radians for C_wb = Rz(yaw) Ry(pitch) Rx(roll).
    pub fn euler_zyx(self) -> (Real, Real, Real) {
        let Quat { w, x, y, z } = self;
        let yaw = atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z));
        let s = (2.0 * (w * y - z * x)).clamp(-1.0, 1.0);
        let roll = atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y));
        (yaw, asin(s), roll)
    }

    /// Attitude error rotation vector log(est^-1 (x) truth), in the estimate's body frame.
    pub fn att_error(est: Quat, truth: Quat) -> [Real; 3] {
        (est.conj() * truth).log()
    }
}

/// Cross-product matrix [v]_x.
pub fn skew(v: [Real; 3]) -> Mat<3, 3> {
    Mat {
        m: [[0.0, -v[2], v[1]], [v[2], 0.0, -v[0]], [-v[1], v[0], 0.0]],
    }
}
```

```rust
//! Mahony explicit complementary filter with an integral bias term.
//! q <- q (x) exp((w_m - b + kp e) dt), b <- b - ki e dt,
//! e = a_meas x a_pred + m_meas x m_pred (unit vectors in the body frame).

use crate::quat::Quat;
use crate::real::{Real, cos, sin, sqrt};

/// Reference magnetic field in NED: unit norm, dip 50 deg down, declination 0.
pub fn mag_w() -> [Real; 3] {
    let dip = 50.0 * core::f64::consts::PI as Real / 180.0;
    [cos(dip), 0.0, sin(dip)]
}

pub struct Mahony {
    pub kp: Real,
    pub ki: Real,
    pub q: Quat,
    pub b: [Real; 3],
    pub m_w: [Real; 3],
}

fn cross(a: [Real; 3], b: [Real; 3]) -> [Real; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn unit(v: [Real; 3]) -> [Real; 3] {
    let n = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    [v[0] / n, v[1] / n, v[2] / n]
}

impl Mahony {
    pub fn new(kp: Real, ki: Real, q0: Quat, m_w: [Real; 3]) -> Self {
        Self {
            kp,
            ki,
            q: q0,
            b: [0.0; 3],
            m_w,
        }
    }

    pub fn step(&mut self, gyro: [Real; 3], accel: [Real; 3], mag: [Real; 3], dt: Real) {
        // Predicted body-frame directions: C^T v
        let ct = self.q.dcm().transpose();
        let pred = |v: [Real; 3]| -> [Real; 3] {
            let mut o = [0.0; 3];
            for (i, oi) in o.iter_mut().enumerate() {
                *oi = ct.m[i][0] * v[0] + ct.m[i][1] * v[1] + ct.m[i][2] * v[2];
            }
            o
        };
        let ea = cross(unit(accel), pred([0.0, 0.0, -1.0]));
        let em = cross(unit(mag), pred(self.m_w));
        let mut w = [0.0; 3];
        for i in 0..3 {
            let e = ea[i] + em[i];
            self.b[i] -= self.ki * e * dt;
            w[i] = (gyro[i] - self.b[i] + self.kp * e) * dt;
        }
        self.q = (self.q * Quat::exp(w)).normalized();
    }
}
```

```rust
//! Attitude baselines: TRIAD snapshot and gyro-only integration.

use crate::mat::Mat;
use crate::quat::Quat;
use crate::real::{Real, sqrt};

fn cross(a: [Real; 3], b: [Real; 3]) -> [Real; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn unit(v: [Real; 3]) -> [Real; 3] {
    let n = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    [v[0] / n, v[1] / n, v[2] / n]
}

/// Orthonormal triad with columns [v1, t2, v1 x t2].
fn frame(v1: [Real; 3], v2: [Real; 3]) -> Mat<3, 3> {
    let t2 = unit(cross(v1, v2));
    let t3 = cross(v1, t2);
    let mut f = Mat::zeros();
    for i in 0..3 {
        f.m[i] = [v1[i], t2[i], t3[i]];
    }
    f
}

/// Attitude q (body -> world) from one accelerometer + magnetometer snapshot.
/// Specific force at rest points opposite to gravity, [0, 0, -1] in NED.
pub fn triad(accel: [Real; 3], mag: [Real; 3], m_w: [Real; 3]) -> Quat {
    let c = frame([0.0, 0.0, -1.0], m_w) * frame(unit(accel), unit(mag)).transpose();
    Quat::from_dcm(&c)
}

/// One gyro-only integration step: q <- normalize(q (x) exp(gyro dt)).
pub fn gyro_step(q: Quat, gyro: [Real; 3], dt: Real) -> Quat {
    (q * Quat::exp([gyro[0] * dt, gyro[1] * dt, gyro[2] * dt])).normalized()
}
```

</details>

### 四元数恒等式自检

三个 app（[`c/apps/ch04.c`](https://github.com/bfmhno3/kalman-lab/tree/tutorial-v1/c/apps/ch04.c)、[`cpp/apps/ch04.cpp`](https://github.com/bfmhno3/kalman-lab/tree/tutorial-v1/cpp/apps/ch04.cpp)、[`rust/src/bin/ch04.rs`](https://github.com/bfmhno3/kalman-lab/tree/tutorial-v1/rust/src/bin/ch04.rs)）在读数据之前先做一轮自检，任何一项失败就以非零码退出。1000 个确定性的旋转向量（长度从接近 0 一直到 $0.99\pi$）：

- $\log(\exp(v)) = v$。
- $C(q)$ 正交：$|CC^T-I|$ 和 $|\det C-1|$ 都小于容差。
- $q\otimes q^* = [1,0,0,0]$。

容差 double 下是 $10^{-12}$（第 8 篇的 float 构建里是 $10^{-4}$）。

## 结果

```text
$ make -s ch04
quaternion identities hold to 1.78e-15
ch04 self-checks passed (worst 1.89e-15)
ok   gyro_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   gyro_cpp.csv: max diff 3.469e-18 <= 1.0e-09
ok   gyro_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   mahony_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   mahony_cpp.csv: max diff 4.441e-16 <= 1.0e-09
ok   mahony_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   triad_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   triad_cpp.csv: max diff 3.331e-16 <= 1.0e-09
ok   triad_rs.csv: max diff 0.000e+00 <= 1.0e-09

truth pitch range: [-77.3, 80.9] deg (gimbal lock is at +-90)
pitch = 90 deg: (yaw, roll) = (20, 10) deg and (57, 47) deg give the same rotation: max|C1 - C2| = 8.33e-17

RMSE over 120 s (deg), seed 1
method        yaw    pitch     roll    total
gyro       30.183   10.738   20.931   25.979
triad       5.312    1.523    2.190    5.702
mahony      4.390    1.489    2.250    4.881

Mahony total error by period (deg RMS)
  calm  [20,60) s : 0.758
  accel disturbance [60,70) s: 2.331
  mag   disturbance [90,100) s: 14.851  (roll/pitch only: 8.437)
```

C 和 Rust 对 Python 的差是精确的 0：这三个滤波器只用 `sin`、`cos`、`atan2`、`sqrt` 和加减乘除，我这台机器上这几个函数的结果在 Python 和这两个语言里逐位相同（C++ 有 $10^{-16}$ 量级的差异，大概是编译器对表达式的合并方式不同）。换一个 libm 实现，这个 0 就不一定能保持，所以容差还是 $10^{-9}$。

![三个基线在偏航、俯仰、横滚上的误差。红带：线加速度扰动；紫带：磁干扰](/assets/images/kalman-filter/ch04-baselines-error.svg)

**纯陀螺积分。** 误差随时间单调变坏：10 秒时总误差 6.6 度，60 秒 23.6 度，120 秒 41.9 度，RMSE 25.979 度。零偏 $0.02$ rad/s 的量级，一阶估算 120 秒会积出 2.4 rad（约 137 度）；实际只有 41.9 度，我猜是因为机体一直在转，零偏造成的误差在世界系里方向不断变化，一部分互相抵消了（这是推测，我没有单独验证）。图里偏航和横滚曲线上的尖峰是欧拉角折到 $\pm180^\circ$ 的缠绕，加上俯仰接近 80 度时的万向锁放大，不是旋转本身的突变。

**TRIAD。** 没有漂移，没有记忆，每个样本的噪声直接进来，所以横滚和俯仰的"毛刺"最大。线加速度扰动段 $[60,70)$，总误差 8.247 度，对比平静段 1.044 度：加速度计把线加速度当成了重力的偏转。磁干扰段，TRIAD 的偏航被拉偏，平均偏 $-17.63^\circ$。可以手算验证：磁场的水平分量从 $[\cos50^\circ,0] = [0.643,0]$ 变成 $[0.943,0.3]$，方向偏转 $\arctan(0.3/0.943) = 17.65^\circ$。

**Mahony。** 平静段 0.758 度，线加速度段 2.331 度（比 TRIAD 的 8.247 度好得多：陀螺在这十秒里主导，加速度计的坏数据只通过 $k_p$ 慢慢渗进来）。但磁干扰段的总误差是 14.851 度，其中横滚和俯仰部分是 8.437 度。TRIAD 在这一段，横滚和俯仰不受磁力计影响；Mahony 却会：它把磁干扰当作一个"姿态失配"，用 $m_n\times\hat v_m$ 去修正，而这个叉乘有一部分落在横滚和俯仰方向上。偏航被拉偏平均 $-11.36^\circ$，比 TRIAD 的少，但没有消除。

整体 RMSE 4.881 度对比 TRIAD 的 5.702 度，好得有限，因为它们共同的最大误差来源是磁干扰那 10 秒。这件事需要的不是更好的增益，而是让滤波器理解"磁力计只能影响偏航"，并在传感器不可信的时候知道。这是第 5、6 篇的主题。

## 下一篇

Mahony 滤波器已经能用，但它的两个增益 $k_p$ 和 $k_i$ 是我选的，没有来由，也不会随工况变化。下一篇我们用第 1、2 篇的推导重新做一遍：状态是四元数加陀螺零偏共 7 维，过程模型是 $q\otimes\exp(\tfrac12(\omega_m-b)\Delta t)$，测量是加速度计和磁力计的方向向量，非线性，所以要线性化，这就是扩展卡尔曼滤波。它能不能赢过 Mahony，以及为什么 $4\times4$ 的四元数协方差天生有一个方向的特征值是 0，是第 5 篇的内容。
