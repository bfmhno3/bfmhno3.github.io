---
title: "上车之前：float32、定点数与 CAN 量化"
commentId: "post:pid-control-10-embedded"
published: "2026-10-16 17:00:00 +08:00"
description: "PID 控制系列第 10 篇，也是最后一篇：我用 Python 3.13、gcc 15.3、g++ 15.3、rustc 1.95 和 arm-none-eabi-gcc 15.2，把第 5 篇的 PID 搬到 float32 和 Q16.16 定点，再让它在三种上车会遇到的麻烦里各跑一遍：积分器停滞、CAN 的整数量化、采样周期抖动。Q16.16 在三种语言里和 Python 逐位一致（差异 0），C、C++、Rust 的 float32 也逐位一致；float32 的积分器确实会停，但在 M3508 的速度环上只停在 1.04e-3 rpm 的误差上；CAN 量化把 0.8e-3 rpm 的稳态误差变成 0.298 rpm 的锯齿；±20% 的周期抖动用实测周期补偿，IAE 只差 0.53%。M4F 上 PID 的 float32 版是 556 字节。"
category: Tutorial
tags:
  - PID
  - 控制理论
  - 嵌入式
  - 定点数
series: "PID 控制：从一个电机到 LQR"
seriesOrder: 10
draft: false
comment: true
slug: pid-control-10-embedded
---

前九篇所有的控制器都跑在 `double` 上，这对一台笔记本是理所当然的，对 RoboMaster 的 C 板不是。据我所知（我查了[C 板的用户手册](https://rm-static.djicdn.com/tem/35228/RoboMaster%20Development%20Board%20Type%20C%20User%20Manual.pdf)，它的供电框图里把主控标成 STM32F407；[ST 的产品页](https://www.st.com/en/microcontrollers-microprocessors/stm32f407ig.html)说这个系列是带 DSP 和 FPU 的 Arm Cortex-M4 内核，168 MHz），C 板上是 Cortex-M4F。据我所知，M4F 的 FPU 只做单精度，一个 `double` 乘法会掉进软件库。所以这一篇要回答的问题是：**把第 5 篇的 `Pid` 搬到 `float`，再搬到 Q16.16 定点，每一步丢了什么？** 我的做法照旧：同一份数据、四种语言、和 Python 的 `double` 版逐位对，然后在三个上车一定会撞上的麻烦里各跑一遍：一个会停住的积分器、CAN 总线上整数化的反馈和命令、抖动的采样周期。计划里我预言 float32 的积分器会停。**停是停了，但停得很轻，轻到我一开始以为自己的实验是错的。**

> [!NOTE] 本篇检查点
> 这一篇结束时你会有：`make ch10` 通过，`out/ch10/` 下 52 个文件（Python 的 5 个浮点算例和 3 个定点算例；C、C++、Rust 各自的 5 个 `double` 算例、3 个定点算例和 5 个 float32 算例；5 个计时文本），`figures/ch10/` 下 5 张图；以及 Q16.16 PID、float32 构建、三个“上车麻烦”的实验，和 Cortex-M4F 的代码体积。
> 新增模块：Python `pidlab.pid_q`，C `pl/pid_q.h` 和 `src/pid_q.c`，C++ `pidlab/pid_q.h`，Rust `pid_q.rs`（Q16.16 的乘法、饱和、`PidQ`）；`cpp/tests/no_heap.cc` 和 `scripts/ch10_checks.sh`（四项静态检查）。`Pid` 本身没有改，只是第一次在 `float` 下被四种语言同时使用。
> 前置：[第 5 篇](/posts/pid-control-05-practical/)的 `Pid`（CLAMP 抗饱和、`cfg` 可在运行时修改）。需要的数学：浮点数的舍入、二进制补码。

## 数学

### 三种数，三种丢法

同一个速度环，我让它在三种数字格式里各算一遍。

- **float32。** 24 位有效数字（23 位存储加一个隐含位），相对精度 $2^{-24}\approx6\times10^{-8}$。数越大，相邻两个数的间隔（ulp）越大：落在 $[2^e,2^{e+1})$ 里的数，ulp 是 $2^{e-23}$。
- **Q16.16 定点。** 一个 `int32`，高 16 位整数、低 16 位小数，实数值是整数除以 65536。间隔永远是 $2^{-16}=1.53\times10^{-5}$，范围是 $[-32768,\,32768)$。间隔不随数的大小变，代价是范围固定。
- **CAN 上的整数。** C620 电调的命令是 $[-16384,\,16384]$ 的整数，对应 $[-20,\,20]$ A，也就是每个单位 $1.22$ mA；反馈里的转子转速以 rpm 为单位的整数。这两条我都核对了[C620 的用户手册](https://github.com/RoboGrinder-ECE/Motor_Control/blob/master/Document/RoboMaster%20C620%20Brushless%20DC%20Motor%20Speed%20Controller%20V1.01.pdf)（我拿到的是 GitHub 上的一份镜像，不是官网的原件）：“controllable current range is -16384 ~ 0 ~ 16384”对应“-20 ~ 0 ~ 20 A”，反馈报文默认 1 kHz，“rotor speed value unit rpm”。手册没有写反馈转速字段有没有符号，我按有符号 16 位处理，这是我的假设。

这一篇所有的 PID 都用“原始单位”：命令是 raw（$\pm16384$），反馈是**转子**侧的 rpm（手册说的是 rotor speed，所以要把输出轴转速乘上 $3591/187\approx19.2$ 的减速比，这个比值是 [M3508 P19 数据手册](https://cdn-hz.robomaster.com/robomasters/public/document/RoboMaster%20M3508%20P19%20Brushless%20DC%20Gear%20Motor.pdf)里的“Reduction Ratio 3591/187”）。第 5 篇的速度环（$\omega_n=30$，$\zeta=0.7$）换算到原始单位是 $k_p=18.614$ raw/rpm，$k_i=402.06$ raw/(rpm·s)，$k_it_s=0.4021$。

这些参数里有一处我没弄明白：数据手册给的转矩常数是 0.3 N·m/A，转速常数是 24.48 rpm/V，后者换成反电势常数是 $60/(2\pi\cdot24.48)=0.390$ V·s/rad。理想电机里两个应该相等，这里差了 30%。我不知道手册的这两个数各自对应哪个轴、哪种电流定义，所以整个系列照用 0.3，把它当作我取的量级，不当作经过验证的参数。

### 积分器为什么会停：半个 ulp

第 5 篇的积分器每个采样做一次 `integral += ki*ts*e`。设积分项现在是 $I$，增量是 $\Delta=k_it_se$。浮点加法先算精确和再舍入到最近的 float32，所以只要 $|\Delta|$ 小于 $I$ 附近 ulp 的一半，$I+\Delta$ 就舍入回 $I$，这一步等于没做。积分器停住了。

稳态下 $I$ 就是负载电流，在这次实验里大约是 10400 raw，落在 $[8192,16384)$，$e=13$，ulp $=2^{-10}=9.77\times10^{-4}$。要让积分器动起来，误差至少得是

$$
e_{\min}=\frac{\text{ulp}(I)/2}{k_it_s}=\frac{4.88\times10^{-4}}{0.4021}=1.21\times10^{-3}\ \text{rpm}
$$

也就是说积分器自己把误差“留”在 $e_{\min}$ 以内：误差再小，I 项就不管了。在这个速度环上这是 2000 rpm 的 $6\times10^{-7}$，没有任何意义。但这个公式里有两个旋钮：$I$ 越大（接近满量程 16384 时 ulp 翻倍）、$k_it_s$ 越小，$e_{\min}$ 越大。RM 代码里把时间常数折进 `ki` 的写法（第 1 篇和第 4 篇提过，我猜很常见）会让 $k_it_s$ 比这里小得多，$k_it_s=0.01$ 对应 0.049 rpm，$0.001$ 对应 0.49 rpm。这个数字我是用真正的 float32 加法二分出来的，不只是公式（见“结果”）。

### Q16.16 的乘法

两个 Q16.16 数的乘积有 32 位小数，要右移 16 位才回到 Q16.16。但乘积本身要 64 位：$k_p$ 的 Q16.16 表示是 $18.614\times65536=1.22\times10^6$（21 位），误差 2000 rpm 是 $1.31\times10^8$（27 位），乘起来 48 位，`int32` 装不下。所以：

$$
\operatorname{qmul}(a,b)=\operatorname{sat}_{32}\Bigl(\bigl\lfloor (a\,b+2^{15})\,/\,2^{16}\bigr\rfloor\Bigr)
$$

加 $2^{15}$ 再向下取整等于四舍五入（平局向 $+\infty$），不加的话每次乘法都向 $-\infty$ 偏半个最低位，积分起来就是一个固定的漂移。右移用算术移位，负数的取整就是向 $-\infty$。这一点三种语言的保证各不相同：C++20 和 Rust 的标准保证，C 只是“实现定义”，GCC 在[手册的 Integers implementation 一页](https://gcc.gnu.org/onlinedocs/gcc/Integers-implementation.html)里明确写了 “Signed ‘>>’ acts on negative numbers by sign extension”。所以 C 版本的可移植性依赖于编译器，这一点我在代码注释里写了。

加法也要饱和：$p+I$ 在 $k_p e$ 超过 32768 raw 时会溢出 `int32`。这里 $k_pe=18.6\times2000=37228$ raw，确实会超，饱和成 32768 raw，但它比输出的钳位 16384 大，所以最后决定输出的还是钳位，积分器的抗饱和判断（`v` 和 `u` 的大小关系）也不受影响。

### CAN 量化：一转的反馈是 18.6 个命令单位

反馈取整到 1 rpm 以后，量化误差在 $\pm0.5$ rpm 之间均匀分布，比例项把它放大 $k_p=18.6$ 倍，所以反馈跳一个 rpm，命令就跳 18.6 raw（22.7 mA）。命令取整到 1 raw 还要再加 $\pm0.5$ raw 的转矩误差。后面的实验里这两个效应会同时出现，而且我能用一个数字把第二个对上，见“结果”。

### 周期抖动：测得的周期只比标称值多一个零均值噪声

采样周期 $t_{s,k}=1\text{ ms}\cdot(1+0.2w_k)$，$w_k\sim U[-1,1]$。控制器在第 $k$ 步看到测量 $y_k$，它是上一个周期（$t_{s,k-1}$ 长）积分的结果，所以积分项正确的矩形近似是 $e_k\,t_{s,k-1}$。标称版本用的是 $e_k\cdot1\text{ ms}$，两者的差是

$$
\sum_k e_k\,(t_{s,k-1}-1\text{ ms})=\sum_k e_k\cdot0.2\,w_{k-1}\cdot1\text{ ms}
$$

$w$ 零均值、互相独立，所以这是一个零均值的噪声项，不是偏差。只有误差 $e_k$ 大的时候它才大，也就是设定值跳变的那几十毫秒。这是我手算的预期：实测周期的补偿应该有用，但用处很小。（“用实测周期”在代码里就是每次更新前把 `cfg.ts` 设成上一个周期，不需要新的接口，第 5 篇已经说过 `cfg` 是可以在运行时改的。）

## Python 实现

先是新模块 `pidlab/pid_q.py`。Python 的整数是任意精度的，不会溢出，所以参考实现必须**主动**模拟 `int32` 的饱和（`sat32`），否则它描述的就不是硬件：

```python
"""Q16.16 fixed-point PI(D): the integer reference the natives must match.

Every value is a Python int standing for an int32 in Q16.16 (real value
= int / 65536). Products go through a 64-bit intermediate with
round-half-up, sums saturate to int32, and the output is an int16 raw
command. The natives must reproduce every bit.
"""

from dataclasses import dataclass

from pidlab.plants import round_half_away

FRAC = 16
ONE = 1 << FRAC
INT32_MIN = -(1 << 31)
INT32_MAX = (1 << 31) - 1
RAW_MAX = 32767  # largest |command| the int16 field can carry


def sat32(x: int) -> int:
    return INT32_MIN if x < INT32_MIN else (INT32_MAX if x > INT32_MAX else x)


def to_q(x: float) -> int:
    """Real to Q16.16: round half away from zero, saturate to int32."""
    return sat32(int(round_half_away(x * ONE)))


def qmul(a: int, b: int) -> int:
    """(a * b) in Q16.16: int64 product, round half up, saturate."""
    return sat32((a * b + (1 << (FRAC - 1))) >> FRAC)


@dataclass
class PidQConfig:
    """Gains already converted to Q16.16 (see make_config)."""

    kp_q: int
    ki_ts_q: int
    kd_over_ts_q: int
    u_min_q: int
    u_max_q: int


def make_config(
    kp: float,
    ki: float,
    kd: float,
    ts: float,
    u_min: float,
    u_max: float,
) -> PidQConfig:
    """Precompute the three gains: kp, ki * ts and kd / ts."""
    if ts <= 0.0 or u_min > u_max:
        raise ValueError("need ts > 0 and u_min <= u_max")
    if max(abs(u_min), abs(u_max)) > RAW_MAX:
        raise ValueError("limits must fit an int16 command")
    return PidQConfig(
        to_q(kp), to_q(ki * ts), to_q(kd / ts), to_q(u_min), to_q(u_max)
    )


class PidQ:
    """Positional PID in Q16.16 with the CLAMP anti-windup rule."""

    def __init__(self, cfg: PidQConfig) -> None:
        self.cfg = cfg
        self.integral = 0
        self.prev_e = 0
        self.primed = False
        self.saturated = False

    def update(self, r_q: int, y_q: int) -> int:
        """One sample; returns the int16 command."""
        c = self.cfg
        e = sat32(r_q - y_q)
        if not self.primed:
            self.prev_e = e
            self.primed = True
        p = qmul(c.kp_q, e)
        d = qmul(c.kd_over_ts_q, sat32(e - self.prev_e))
        self.prev_e = e
        v = sat32(sat32(p + self.integral) + d)
        u = min(max(v, c.u_min_q), c.u_max_q)
        self.saturated = u != v
        if not (self.saturated and (e > 0) == (v > u) and e != 0):
            self.integral = sat32(self.integral + qmul(c.ki_ts_q, e))
        return (u + (ONE >> 1)) >> FRAC
```

`make_config` 把三个增益提前换成 Q16.16：$k_p$、$k_it_s$、$k_d/t_s$，之后每个采样里没有除法。`to_q` 是实数到 Q16.16 的转换，用“四舍五入、平局远离零”（和第 4 篇起所有舍入的约定一样，Python 内置的 `round` 是银行家舍入，不能用）；而 `qmul` 里的舍入是“平局向上”，两处不同是有意的：前者是一次性的转换，后者每个采样都发生，必须便宜。`update` 就是第 5 篇的 CLAMP 规则换成整数：`wind_up` 的条件是“输出被钳位，并且误差把积分往钳位的方向推”。最后一行把 Q16.16 的输出舍入成 `int16` 的命令。

然后是 `python/ch10_embedded.py`，整份贴出来。先是常量和算例表：

```python
#!/usr/bin/env python3
"""Chapter 10 driver: `ch10_embedded.py ref` then `report`."""

import math
import sys
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare import compare_dir  # noqa: E402
from pidlab.io import read_csv, write_csv  # noqa: E402
from pidlab.pid import Pid, PidConfig, Windup  # noqa: E402
from pidlab.pid_q import ONE, PidQ, make_config, to_q  # noqa: E402
from pidlab.plants import MotorSpeedLag, round_half_away  # noqa: E402
from pidlab.plotting import ROOT  # noqa: E402
from pidlab.sim import advance  # noqa: E402

TS = 1e-3
SUBSTEPS = 10
ZETA, WN = 0.7, 30.0
# RM raw units: command +-16384 is +-20 A, feedback is rotor rpm.
RAW_FULL = 16384.0
AMP_PER_RAW = 20.0 / RAW_FULL
RAW_PER_AMP = RAW_FULL / 20.0
RPM_PER_RADS = 60.0 / (2.0 * math.pi) * (3591.0 / 187.0)
JITTER = 0.2
OUT = ROOT / "out" / "ch10"
DATA = ROOT / "data"
FLOAT_COLS = ("t", "r", "y", "u", "ytrue", "integral", "sat")
FIXED_COLS = ("t", "r_q", "y_q", "u", "integral_q", "sat")
LANGS = ("c", "cpp", "rs")
F32_TOL = 1e-4  # float32 across languages, see the post


@dataclass
class Case:
    name: str
    data: str
    quant: bool = False  # CAN: integer rpm feedback, int16 command
    jitter: int = 0  # 0 none, 1 controller assumes 1 ms, 2 measured
    fixed: bool = True  # also run the Q16.16 controller
    quant_u: bool = False  # Python only: round the command, not the feedback


CASES = (
    Case("stall", "ch10_stall"),
    Case("quant_off", "ch10_quant"),
    Case("quant_on", "ch10_quant", quant=True),
    Case("jitter_nominal", "ch10_jitter", jitter=1, fixed=False),
    Case("jitter_measured", "ch10_jitter", jitter=2, fixed=False),
)


def raw_gains() -> tuple[float, float]:
    """The ch05 speed PI (wn = 30, zeta = 0.7) in raw units per rpm."""
    m = MotorSpeedLag()
    kp = (2.0 * ZETA * WN * m.j - m.b) / m.kt
    ki = WN * WN * m.j / m.kt
    scale = RAW_PER_AMP / RPM_PER_RADS
    return kp * scale, ki * scale
```

`RAW_FULL`、`AMP_PER_RAW` 和 `RPM_PER_RADS` 就是前面说的原始单位换算。`Case` 里的 `quant` 同时打开“反馈取整到 1 rpm”和“命令取整到 1 raw”，`jitter` 是 0、1（标称）、2（实测），`quant_u` 是只在 Python 里用的一个开关，只取整命令，后面解释它为什么存在。`raw_gains` 把第 5 篇的速度环搬到原始单位。

数据由 Python 生成，原生程序只读：

```python
def write_data() -> None:
    k = np.arange(30000)

    def table(n, r, d, w=None):
        kk = k[:n]
        return {
            "t": kk * TS,
            "r": r(kk * TS),
            "d": d(kk * TS),
            "w": np.zeros(n) if w is None else w,
        }

    step = lambda t: 2000.0 * (t >= 0.05)  # noqa: E731
    # load ramps to 3.7 N*m in 4.1 s, then holds
    ramp = lambda t: np.clip(0.9 * (t - 1.0), 0.0, 3.7)  # noqa: E731
    write_csv(DATA / "ch10_stall.csv", table(20000, step, ramp))
    write_csv(
        DATA / "ch10_quant.csv",
        table(3000, step, lambda t: 1.0 * (t >= 1.5)),
    )
    rng = np.random.default_rng(10)
    write_csv(
        DATA / "ch10_jitter.csv",
        table(
            3000,
            lambda t: np.where(t < 1.0, step(t), 1000.0),
            lambda t: 2.0 * (t >= 2.0),
            rng.uniform(-1.0, 1.0, 3000),
        ),
    )
```

三份数据：`ch10_stall` 是 2000 rpm 的阶跃加一个从 1 s 开始、每秒 0.9 N·m、到 3.7 N·m 为止的缓升负载（20 s）；`ch10_quant` 是同样的阶跃加 1.5 s 处 1 N·m 的负载（3 s）；`ch10_jitter` 的设定值在 1 s 处从 2000 降到 1000 rpm，2 s 处加 2 N·m 的负载，并带有 $w_k$（numpy 种子 10）。

浮点版本的仿真循环，就是第 5 篇的 `Pid`、一个带电流环的 `MotorSpeedLag`、和上面的单位换算：

```python
def run_float(case: Case) -> dict[str, np.ndarray]:
    """ch05 Pid in doubles, raw units."""
    data = read_csv(DATA / f"{case.data}.csv")
    kp, ki = raw_gains()
    pid = Pid(
        PidConfig(
            kp,
            ki,
            0.0,
            TS,
            u_min=-RAW_FULL,
            u_max=RAW_FULL,
            windup=Windup.CLAMP,
        )
    )
    plant = MotorSpeedLag()
    x = [0.0, 0.0]
    rows = []
    t_act = 0.0
    prev = TS
    for k in range(len(data["t"])):
        r, d, w = data["r"][k], data["d"][k], data["w"][k]
        ts_k = TS * (1.0 + JITTER * w)
        ytrue = x[0] * RPM_PER_RADS
        y = round_half_away(ytrue) if case.quant else ytrue
        if case.jitter == 2:
            pid.cfg.ts = prev
        u = pid.update(r, y)
        if case.quant or case.quant_u:
            u = round_half_away(u)
        t = t_act if case.jitter else data["t"][k]
        rows.append([t, r, y, u, ytrue, pid.integral, float(pid.saturated)])
        x = advance(plant.deriv, x, [u * AMP_PER_RAW, d], ts_k, SUBSTEPS)
        t_act += ts_k
        prev = ts_k
    return dict(zip(FLOAT_COLS, np.array(rows).T))
```

每个采样先把真实转速换算成转子 rpm，需要的话取整成“CAN 反馈”，然后（实测模式下）把 `cfg.ts` 设成上一个周期，更新，需要的话把命令取整，最后用**真实**的周期推进对象（RK4，10 个子步）。`t` 列在抖动算例里是累加的真实时间。

下面这个函数只在 Python 里存在：控制器是 numpy 的 float32，对象仍是 float64。原生的 float32 构建里控制器和对象都是 float32，对象自己的状态也会舍入，两件事混在一起；这个函数把它们分开：

```python
def run_f32_controller(case: Case) -> dict[str, np.ndarray]:
    """Python only: the controller in numpy float32, the plant in float64.

    The native float32 builds run controller and plant in float32, so
    the plant's own state also rounds. This separates the two.
    """
    data = read_csv(DATA / f"{case.data}.csv")
    kp, ki = (np.float32(v) for v in raw_gains())
    ts, lim = np.float32(TS), np.float32(RAW_FULL)
    plant = MotorSpeedLag()
    x = [0.0, 0.0]
    integral = np.float32(0.0)
    rows = []
    for k in range(len(data["t"])):
        r, d = np.float32(data["r"][k]), data["d"][k]
        ytrue = x[0] * RPM_PER_RADS
        y = np.float32(ytrue)
        v = kp * (r - y) + integral
        u = min(max(v, -lim), lim)
        e = r - y
        if not (u != v and e * (v - u) > 0):
            integral = integral + ki * ts * e
        rows.append([data["t"][k], r, y, u, ytrue, integral])
        x = advance(plant.deriv, x, [float(u) * AMP_PER_RAW, d], TS, SUBSTEPS)
    return dict(zip(FLOAT_COLS[:6], np.array(rows, dtype=float).T))
```

Q16.16 版本和主循环：

```python
def run_fixed(case: Case) -> dict[str, np.ndarray]:
    data = read_csv(DATA / f"{case.data}.csv")
    kp, ki = raw_gains()
    pid = PidQ(make_config(kp, ki, 0.0, TS, -RAW_FULL, RAW_FULL))
    plant = MotorSpeedLag()
    x = [0.0, 0.0]
    rows = []
    for k in range(len(data["t"])):
        r, d = data["r"][k], data["d"][k]
        y = x[0] * RPM_PER_RADS
        if case.quant:
            y = round_half_away(y)
        r_q, y_q = to_q(r), to_q(y)
        u = pid.update(r_q, y_q)
        rows.append(
            [data["t"][k], r_q, y_q, u, pid.integral, float(pid.saturated)]
        )
        x = advance(plant.deriv, x, [u * AMP_PER_RAW, d], TS, SUBSTEPS)
    return dict(zip(FIXED_COLS, np.array(rows).T))


def ref() -> None:
    write_data()
    for case in CASES:
        write_csv(OUT / f"{case.name}_py.csv", run_float(case))
        if case.fixed:
            write_csv(OUT / f"fixed_{case.name}_py.csv", run_fixed(case))


def load(name: str) -> dict[str, np.ndarray]:
    return read_csv(OUT / f"{name}.csv")


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x * x)))


def window(d: dict, lo: float, hi: float) -> np.ndarray:
    return (d["t"] >= lo) & (d["t"] < hi)
```

`report` 的第一部分：对比、float32 构建的核对、以及停滞的公式和二分：

```python
# ---------------------------------------------------------------- report


def report_compare() -> None:
    print("natives vs the Python reference (tolerance 1e-9, Q16.16: 0)")
    tol = {f"fixed_{c.name}": 0.0 for c in CASES if c.fixed}
    if not compare_dir(OUT, 1e-9, tol):
        sys.exit(1)


def report_f32() -> None:
    print("\nfloat32 builds: C vs C++ vs Rust, and each vs the f64 reference")
    print(
        f"{'case':16s} {'c-cpp':>9s} {'c-rs':>9s} {'f32-f64 y':>10s} "
        f"{'f32-f64 u':>10s} {'f32-f64 int':>11s}"
    )
    for case in CASES:
        f32 = {lang: load(f"{case.name}_f32_{lang}") for lang in LANGS}
        ref = load(f"{case.name}_py")
        pair = {}
        for lang in ("cpp", "rs"):
            pair[lang] = max(
                float(np.max(np.abs(f32["c"][k] - f32[lang][k])))
                for k in FLOAT_COLS
            )
        dev = {
            k: float(np.max(np.abs(f32["c"][k] - ref[k])))
            for k in ("y", "u", "integral")
        }
        print(
            f"{case.name:16s} {pair['cpp']:9.2e} {pair['rs']:9.2e} "
            f"{dev['y']:10.3e} {dev['u']:10.3e} {dev['integral']:11.3e}"
        )
        assert max(pair.values()) <= F32_TOL, case.name
    print(f"ok   float32 outputs agree across languages within {F32_TOL:.0e}")


def f32_deadband(level: float, ki_ts: float) -> float:
    """Smallest error that still moves a float32 integrator at `level`."""
    base = np.float32(level)
    gain = np.float32(ki_ts)
    lo, hi = 1e-12, 1e3
    for _ in range(200):
        mid = math.sqrt(lo * hi)
        if base + gain * np.float32(mid) != base:
            hi = mid
        else:
            lo = mid
    return hi


def half_ulp_deadband(level: float, ki_ts: float) -> float:
    return float(np.spacing(np.float32(level))) / 2.0 / ki_ts
```

`f32_deadband` 是一个二分：在 float32 里找最小的误差，让 `base + gain*e` 不等于 `base`。`half_ulp_deadband` 是公式。两者对得上，说明我的“半个 ulp”推导没有漏掉东西（舍入到偶数的平局不影响二分的结果，因为 $e$ 是连续的）。

停滞、量化、抖动三个算例的指标：

```python
def report_stall() -> dict:
    kp, ki = raw_gains()
    print(
        f"\nspeed PI in raw units: kp = {kp:.3f} /rpm, ki = {ki:.2f} /rpm/s, "
        f"ki*ts = {ki * TS:.4f}"
    )
    f64 = load("stall_py")
    f32 = load("stall_f32_c")
    q = load("fixed_stall_py")
    tail = f64["t"] >= 15.0
    # controller-only variants, to tell what rounds where
    ctl = run_f32_controller(CASES[0])
    rnd = run_float(replace(CASES[0], quant_u=True))
    e = {
        "f64": f64["r"] - f64["ytrue"],
        "f32": f32["r"] - f32["ytrue"],
        "q16": (q["r_q"] - q["y_q"]) / ONE,
        "f32 ctl": ctl["r"] - ctl["ytrue"],
        "f64 int u": rnd["r"] - rnd["ytrue"],
    }
    print("integrator stall: slow load ramp, last 5 s (load constant)")
    print(f"{'':9s} {'|integral| end':>15s} {'max |e| (rpm)':>14s}")
    print("(f32 ctl: float32 controller on a float64 plant;")
    print(" f64 int u: float64 controller, command rounded to int)")
    ints = {
        "f64": f64["integral"],
        "f32": f32["integral"],
        "q16": q["integral_q"] / ONE,
        "f32 ctl": ctl["integral"],
        "f64 int u": rnd["integral"],
    }
    for k in e:
        print(f"{k:9s} {ints[k][-1]:15.2f} {np.max(np.abs(e[k][tail])):14.3e}")
    print(
        f"integral gap vs f64: f32 {np.max(np.abs(ints['f32'] - ints['f64'])):.3f}"
        f", q16 {np.max(np.abs(ints['q16'] - ints['f64'])):.3f} (raw)"
    )
    level = float(ints["f32"][-1])
    print(f"deadband at integral = {level:.0f} (error that still moves it):")
    print(
        f"{'ki*ts':>8s} {'half ulp / (ki*ts)':>20s} {'float32 bisection':>18s}"
    )
    for kts in (ki * TS, 0.01, 0.001):
        print(
            f"{kts:8.4f} {half_ulp_deadband(level, kts):20.3e} "
            f"{f32_deadband(level, kts):18.3e}"
        )
    end32 = float(np.max(np.abs(e["f32 ctl"][tail])))
    assert max(np.max(np.abs(v)) for v in ints.values()) > 1e4
    assert np.max(np.abs(e["f64"][tail])) < 1e-9
    # the stall exists, at the size the half-ulp argument predicts
    pred = half_ulp_deadband(level, ki * TS)
    assert 0.3 * pred < end32 < 3.0 * pred, (end32, pred)
    assert np.max(np.abs(e["q16"][tail])) < 1e-2
    # the Q16.16 residual is the int16 command rounding, not the integrator
    ratio = np.max(np.abs(e["q16"][tail])) / np.max(
        np.abs(e["f64 int u"][tail])
    )
    assert abs(ratio - 1.0) < 0.1, ratio
    return {"f64": f64, "f32": f32, "q": q, "ints": ints, "e": e}


def report_quant() -> dict:
    off, on = load("quant_off_py"), load("quant_on_py")
    print("\nCAN quantization: integer rpm feedback, int16 command")
    print(
        f"{'':9s} {'rms e [1,1.5)':>14s} {'rms e [2,3)':>12s} "
        f"{'u changes [2,3)':>16s} {'u ptp [2,3)':>12s}"
    )
    res = {}
    for name, d in (("quant_off", off), ("quant_on", on)):
        a, b = window(d, 1.0, 1.5), window(d, 2.0, 3.0)
        ea = d["r"][a] - d["ytrue"][a]
        eb = d["r"][b] - d["ytrue"][b]
        ch = int(np.sum(np.diff(d["u"][b]) != 0))
        ptp = float(np.ptp(d["u"][b]))
        res[name] = (rms(ea), rms(eb), ch, ptp)
        print(
            f"{name:9s} {rms(ea):14.3e} {rms(eb):12.3e} {ch:16d} {ptp:12.1f}"
        )
    kp, _ = raw_gains()
    print(f"one rpm of feedback is kp = {kp:.1f} raw of command")
    assert res["quant_on"][1] > 100.0 * res["quant_off"][1]
    assert res["quant_on"][2] < res["quant_off"][2]
    return {"off": off, "on": on}


def report_jitter() -> dict:
    nom, mea = load("jitter_nominal_py"), load("jitter_measured_py")
    print("\njitter: ts_k = 1 ms * (1 + 0.2 w), w ~ U[-1, 1]")
    print(
        f"{'':16s} {'IAE [1,2) rpm s':>16s} {'IAE [2,3) rpm s':>16s} "
        f"{'late std u':>11s} {'late std e':>11s}"
    )
    iae = {}
    for name, d in (("jitter_nominal", nom), ("jitter_measured", mea)):
        row = []
        for lo, hi in ((1.0, 2.0), (2.0, 3.0)):
            m = window(d, lo, hi)
            row.append(
                float(
                    np.trapezoid(np.abs(d["r"][m] - d["ytrue"][m]), d["t"][m])
                )
            )
        m = window(d, 2.5, 4.0)
        iae[name] = row
        print(
            f"{name:16s} {row[0]:16.3f} {row[1]:16.3f} "
            f"{np.std(d['u'][m]):11.4f} {np.std(d['r'][m] - d['ytrue'][m]):11.2e}"
        )
    rel = abs(iae["jitter_measured"][0] / iae["jitter_nominal"][0] - 1.0)
    print(f"IAE difference after the setpoint step: {100.0 * rel:.2f} %")
    assert rel < 0.05
    return {"nom": nom, "mea": mea}
```

计时、总入口和图：

```python
def read_bench() -> dict[tuple[str, str], float]:
    out = {}
    for f in sorted(OUT.glob("bench_*.txt")):
        for line in f.read_text().splitlines():
            lang, prec, ns = line.split()
            out[(lang, prec)] = float(ns)
    return out


def cpu_model() -> str:
    for line in Path("/proc/cpuinfo").read_text().splitlines():
        if line.startswith("model name"):
            return line.split(":", 1)[1].strip()
    return "unknown"


def report_bench() -> dict:
    bench = read_bench()
    print(f"\nhost timing on: {cpu_model()}")
    print("ns per update, median of 5 runs of 1e6 (host, NOT the MCU)")
    print(f"{'':6s} {'f64':>8s} {'f32':>8s} {'q16':>8s}")
    for lang in ("c", "cpp", "rs"):
        cells = [bench.get((lang, p)) for p in ("f64", "f32", "q16")]
        text = " ".join(
            f"{c:8.2f}" if c is not None else f"{'-':>8s}" for c in cells
        )
        print(f"{lang:6s} {text}")
    assert len(bench) == 9, bench
    return bench


def report() -> None:
    report_compare()
    report_f32()
    stall = report_stall()
    quant = report_quant()
    jit = report_jitter()
    bench = report_bench()
    plot_stall(stall)
    plot_fixed(stall)
    plot_quant(quant)
    plot_jitter(jit)
    plot_timing(bench)
    print("\nch10 OK")


# --------------------------------------------------------------- figures
```

五张图的绘制代码：

```python
def plot_stall(s: dict) -> None:
    import matplotlib.pyplot as plt
    from pidlab.plotting import L, save

    _, ki = raw_gains()
    fig, ax = plt.subplots(1, 2, figsize=(10, 3.8))
    lv = np.logspace(2, math.log10(16000.0), 200)
    for kts, c in ((ki * TS, "C0"), (0.01, "C1"), (0.001, "C2")):
        ax[0].loglog(
            lv,
            [half_ulp_deadband(v, kts) for v in lv],
            c,
            label=f"ki*ts = {kts:.3g}",
        )
    ax[0].plot(
        [s["ints"]["f32 ctl"][-1]],
        [np.max(np.abs(s["e"]["f32 ctl"][-5000:]))],
        "k*",
        ms=10,
        label=L(
            "float32 控制器的残余误差", "residual error, float32 controller"
        ),
    )
    ax[0].set_xlabel(L("积分项大小（原始单位）", "integral size (raw units)"))
    ax[0].set_ylabel(L("积分器卡死的误差带 (rpm)", "stall deadband (rpm)"))
    ax[0].set_title(L("半个 ulp 除以 ki*ts", "half an ulp over ki*ts"))
    ax[0].legend(fontsize=8)
    t = s["f64"]["t"]
    ax[1].plot(t, s["ints"]["f32"] - s["ints"]["f64"], label="float32")
    ax[1].plot(t, s["ints"]["q16"] - s["ints"]["f64"], label="Q16.16")
    ax[1].set_xlabel(L("时间 (s)", "time (s)"))
    ax[1].set_ylabel(
        L("积分项相对 f64 的差（原始单位）", "integral minus f64 (raw)")
    )
    ax[1].set_title(L("负载缓升 3.7 N·m", "slow load ramp to 3.7 N m"))
    ax[1].legend()
    save(fig, "ch10", "float32-stall")


def plot_fixed(s: dict) -> None:
    import matplotlib.pyplot as plt
    from pidlab.plotting import L, save

    fig, ax = plt.subplots(1, 2, figsize=(10, 3.8))
    t = s["f64"]["t"]
    m = (t >= 10.0) & (t < 10.1)
    ax[0].plot(t[m], s["e"]["f32"][m], label="float32")
    ax[0].plot(t[m], s["e"]["q16"][m], label="Q16.16")
    ax[0].plot(t[m], s["e"]["f64"][m], label="float64")
    ax[0].set_xlabel(L("时间 (s)", "time (s)"))
    ax[0].set_ylabel(L("速度误差 (rpm)", "speed error (rpm)"))
    ax[0].set_title(
        L(
            "负载恒定后的残余误差（10 s 起的 0.1 s）",
            "residual error, 0.1 s from t = 10 s",
        )
    )
    ax[0].legend()
    du = s["q"]["u"] - s["f64"]["u"]
    ax[1].plot(t[m], du[m], lw=0.8)
    ax[1].set_xlabel(L("时间 (s)", "time (s)"))
    ax[1].set_ylabel(
        L("Q16.16 命令减 f64 命令 (raw)", "Q16.16 minus f64 command (raw)")
    )
    ax[1].set_title(
        L(
            "整数命令的取整（同一窗口）",
            "integer command rounding (same window)",
        )
    )
    save(fig, "ch10", "fixed-vs-float")


def plot_quant(q: dict) -> None:
    import matplotlib.pyplot as plt
    from pidlab.plotting import L, save

    fig, ax = plt.subplots(2, 1, figsize=(8, 5.5), sharex=True)
    for name, d in (("quant_off", q["off"]), ("quant_on", q["on"])):
        m = window(d, 2.0, 3.0)
        ax[0].plot(d["t"][m], d["r"][m] - d["ytrue"][m], label=name)
        ax[1].plot(d["t"][m], d["u"][m], label=name)
    ax[0].set_ylabel(L("速度误差 (rpm)", "speed error (rpm)"))
    ax[0].set_title(
        L(
            "负载稳定后的 1 s（1.5 s 处加了 1 N·m）",
            "1 s after the 1 N m load settles",
        )
    )
    ax[0].legend()
    ax[1].set_ylabel(L("命令 (raw)", "command (raw)"))
    ax[1].set_xlabel(L("时间 (s)", "time (s)"))
    save(fig, "ch10", "can-quantization")


def plot_jitter(j: dict) -> None:
    import matplotlib.pyplot as plt
    from pidlab.plotting import L, save

    fig, ax = plt.subplots(1, 2, figsize=(10, 3.8))
    for name, d in (
        ("jitter_nominal", j["nom"]),
        ("jitter_measured", j["mea"]),
    ):
        m = window(d, 0.98, 1.3)
        ax[0].plot(d["t"][m], d["ytrue"][m], label=name)
    ax[0].set_xlabel(L("时间 (s)", "time (s)"))
    ax[0].set_ylabel(L("速度 (rpm)", "speed (rpm)"))
    ax[0].set_title(
        L("设定值从 2000 降到 1000 rpm", "setpoint 2000 to 1000 rpm")
    )
    ax[0].legend()
    ax[1].plot(j["nom"]["t"], j["mea"]["ytrue"] - j["nom"]["ytrue"], lw=0.6)
    ax[1].set_xlabel(L("时间 (s)", "time (s)"))
    ax[1].set_ylabel(
        L(
            "实测周期减标称周期的转速差 (rpm)",
            "measured minus nominal speed (rpm)",
        )
    )
    save(fig, "ch10", "jitter")


def plot_timing(b: dict) -> None:
    import matplotlib.pyplot as plt
    from pidlab.plotting import L, save

    fig, ax = plt.subplots(figsize=(7, 3.8))
    precs = ("f64", "f32", "q16")
    for i, lang in enumerate(("c", "cpp", "rs")):
        vals = [b.get((lang, p), 0.0) for p in precs]
        ax.bar(np.arange(3) + 0.27 * (i - 1), vals, 0.27, label=lang)
    ax.set_xticks(range(3), ["float64", "float32", "Q16.16"])
    ax.set_ylim(0, 1.3 * max(b.values()))
    ax.set_ylabel(L("每次更新 (ns，本机)", "ns per update (this host)"))
    ax.set_title(L("主机计时，不是 MCU 计时", "host timing, not MCU timing"))
    ax.legend()
    save(fig, "ch10", "timing")


if __name__ == "__main__":
    {"ref": ref, "report": report}[sys.argv[1]]()
```

## C、C++、Rust 实现

`pid_q` 是 Python 版的逐行翻译，三种语言的 `ch10` 应用是 `ch10_embedded.py` 的 `ref` 的逐行翻译，读同一份数据，写自己的文件。区别在这几处：

- **整数的类型就是规范。** C 用 `int32_t`、`int64_t`、`int16_t`；C++ 用 `std::int32_t` 等；Rust 用 `i32`、`i64`、`i16`，64 位乘法要显式写 `as i64`，漏了编译器不报错，只在溢出的时候 debug 构建报 panic、release 构建回绕。Python 靠 `sat32` 手工模拟。
- **饱和。** `pl_q_sat`（C）、`QSat`（C++）、`q_sat`（Rust，一行 `clamp`）都是把 `int64` 夹进 `int32`。`update` 里每个加减法都过一次，包括 $e=r-y$：两个 `int32` 相减也能溢出。
- **右移。** C 靠 GCC 的保证（上面引的那一页），C++20 和 Rust 靠标准。三种语言的 `qmul` 是同一行。
- **没有堆。** 三种语言的 PID 都没有堆分配，下面的“静态检查”里有证据。
- **标量类型。** 第 5 篇的 `Pid` 在 C 里是 `pl_real`（`-DPL_USE_FLOAT` 时是 `float`）、C++ 是模板参数 `T`（这一次用 `Pid<float>`）、Rust 是 `Real`（`--features f32` 时是 `f32`）。`pid_q` 不受这个开关影响，永远是整数。
- **增益在 double 里算。** 三种语言的 `raw_gains` 都用 double 做算术，输入是对象自己的参数（float32 构建里这些参数本身就是 float32），然后才转成 `pl_real`、`T` 或 `Real`，这样三种语言从同一个数起步。
- **float32 构建的编译方式。** C：`make -C c BUILD=../build/c32 EXTRA_CFLAGS=-DPL_USE_FLOAT ONLY=ch10`；C++：同一个程序里 `RunAll<double>()` 和 `RunAll<float>()` 各跑一遍；Rust：`cargo build --release --features f32 --bin ch10 --target-dir target32`。文件名里 float32 的是 `_f32_c.csv`、`_f32_cpp.csv`、`_f32_rs.csv`。

### C

Q16.16 的两个基本操作都是 `static inline`，放在头文件里。注释里提到了算术移位的依据：

```c
/* Real to Q16.16: round half away from zero, saturate to int32. */
int32_t pl_q_from_real(pl_real x);

/* Saturate a 64-bit value to int32. */
static inline int32_t pl_q_sat(int64_t x)
{
	if (x < INT32_MIN)
		return INT32_MIN;
	if (x > INT32_MAX)
		return INT32_MAX;
	return (int32_t)x;
}

/* a * b in Q16.16: 64-bit product, round half up, saturate. The */
/* right shift of a negative value is an arithmetic shift in GCC. */
static inline int32_t pl_q_mul(int32_t a, int32_t b)
{
	return pl_q_sat(((int64_t)a * b + (1 << (PL_Q_FRAC - 1))) >>
			PL_Q_FRAC);
}
```

`update` 是 Python 的逐行翻译，每个加减都过 `pl_q_sat`：

```c
int16_t pl_pid_q_update(struct pl_pid_q *pid, int32_t r_q, int32_t y_q)
{
	const struct pl_pid_q_config *c = &pid->cfg;
	int32_t e = pl_q_sat((int64_t)r_q - y_q);
	int32_t p, d, v, u;
	bool wind_up;

	if (!pid->primed) {
		pid->prev_e = e;
		pid->primed = true;
	}
	p = pl_q_mul(c->kp_q, e);
	d = pl_q_mul(c->kd_over_ts_q, pl_q_sat((int64_t)e - pid->prev_e));
	pid->prev_e = e;
	v = pl_q_sat((int64_t)pl_q_sat((int64_t)p + pid->integral) + d);
	u = v < c->u_min_q ? c->u_min_q : (v > c->u_max_q ? c->u_max_q : v);
	pid->saturated = u != v;
	wind_up = (e > 0 && v > u) || (e < 0 && v < u);
	if (!wind_up)
		pid->integral = pl_q_sat((int64_t)pid->integral +
					 pl_q_mul(c->ki_ts_q, e));
	return (int16_t)((u + (PL_Q_ONE >> 1)) >> PL_Q_FRAC);
}
```

应用里的仿真循环（浮点版本）。`pid.cfg.ts = prev` 就是“实测周期”：

```c
static int run_float(const struct sim_case *c)
{
	struct pl_motor_speed_lag plant;
	struct pl_pid_config cfg;
	struct pl_pid pid;
	struct pl_csv data;
	pl_real x[PL_MAX_STATES] = { 0 };
	double kp, ki, t_act = 0;
	pl_real prev = ts_nom;
	int cr, cd, cw, ret;
	long k;

	ret = load_data(c, &data, &cr, &cd, &cw);
	if (ret)
		return ret;
	raw_gains(&kp, &ki);
	pl_motor_speed_lag_init(&plant);
	cfg.kp = kp;
	cfg.ki = ki;
	cfg.kd = 0;
	cfg.ts = ts_nom;
	cfg.tf = 0;
	cfg.b = 1;
	cfg.c = 0;
	cfg.u_min = -raw_full;
	cfg.u_max = raw_full;
	cfg.i_limit = INFINITY;
	cfg.tt = 0;
	cfg.windup = PL_WINDUP_CLAMP;
	ret = pl_pid_init(&pid, &cfg);
	for (k = 0; !ret && k < data.nrows; k++) {
		const double *row = &data.data[k * data.ncols];
		double *out = &rows[k * FLOAT_COLS];
		pl_real ts_k = ts_nom * (1 + jitter * (pl_real)row[cw]);
		pl_real ytrue = x[0] * (pl_real)rpm_per_rads;
		pl_real y = c->quant ? PL_ROUND(ytrue) : ytrue;
		pl_real inputs[2], u;

		if (c->jitter == 2)
			pid.cfg.ts = prev;
		u = pl_pid_update(&pid, row[cr], y, 0, false);
		if (c->quant)
			u = PL_ROUND(u);
		out[0] = c->jitter ? t_act : row[0];
		out[1] = row[cr];
		out[2] = y;
		out[3] = u;
		out[4] = ytrue;
		out[5] = pid.integral;
		out[6] = pid.saturated ? 1.0 : 0.0;
		inputs[0] = u * amp_per_raw;
		inputs[1] = row[cd];
		pl_advance(pl_motor_speed_lag_deriv, &plant, x, inputs,
			   PL_MOTOR_SPEED_LAG_N, ts_k, SUBSTEPS);
		t_act += ts_k;
		prev = ts_k;
	}
	if (!ret)
		ret = write_rows("", c, float_names, FLOAT_COLS, data.nrows);
	pl_csv_free(&data);
	return ret;
```

<details>
<summary>完整源码：c/include/pl/pid_q.h</summary>

```c
/* SPDX-License-Identifier: MIT OR Apache-2.0 */
/* Q16.16 fixed-point PI(D): int32 state, int64 products, int16 command. */
#ifndef PL_PID_Q_H
#define PL_PID_Q_H

#include <stdbool.h>
#include <stdint.h>

#include "pl/real.h"

#define PL_Q_FRAC 16
#define PL_Q_ONE (1 << PL_Q_FRAC)
#define PL_Q_RAW_MAX 32767 /* largest |command| an int16 can carry */

/* Real to Q16.16: round half away from zero, saturate to int32. */
int32_t pl_q_from_real(pl_real x);

/* Saturate a 64-bit value to int32. */
static inline int32_t pl_q_sat(int64_t x)
{
	if (x < INT32_MIN)
		return INT32_MIN;
	if (x > INT32_MAX)
		return INT32_MAX;
	return (int32_t)x;
}

/* a * b in Q16.16: 64-bit product, round half up, saturate. The */
/* right shift of a negative value is an arithmetic shift in GCC. */
static inline int32_t pl_q_mul(int32_t a, int32_t b)
{
	return pl_q_sat(((int64_t)a * b + (1 << (PL_Q_FRAC - 1))) >>
			PL_Q_FRAC);
}

/* Gains already converted to Q16.16. */
struct pl_pid_q_config {
	int32_t kp_q, ki_ts_q, kd_over_ts_q;
	int32_t u_min_q, u_max_q;
};

/* The CLAMP anti-windup rule; the first update primes the D term. */
struct pl_pid_q {
	struct pl_pid_q_config cfg;
	int32_t integral, prev_e;
	bool primed, saturated;
};

/* Precompute kp, ki * ts and kd / ts. Returns 0, or -EINVAL unless */
/* ts > 0, u_min <= u_max and both limits fit an int16. */
int pl_pid_q_config_make(struct pl_pid_q_config *cfg, pl_real kp, pl_real ki,
			 pl_real kd, pl_real ts, pl_real u_min, pl_real u_max);

void pl_pid_q_init(struct pl_pid_q *pid, const struct pl_pid_q_config *cfg);

/* One sample; r_q and y_q are Q16.16. Returns the int16 command. */
int16_t pl_pid_q_update(struct pl_pid_q *pid, int32_t r_q, int32_t y_q);

#endif /* PL_PID_Q_H */
```

</details>

<details>
<summary>完整源码：c/src/pid_q.c</summary>

```c
// SPDX-License-Identifier: MIT OR Apache-2.0
#include <errno.h>

#include "pl/pid_q.h"

int32_t pl_q_from_real(pl_real x)
{
	pl_real v = PL_ROUND(x * PL_Q_ONE);

	if (v <= (pl_real)INT32_MIN)
		return INT32_MIN;
	if (v >= (pl_real)INT32_MAX)
		return INT32_MAX;
	return (int32_t)v;
}

int pl_pid_q_config_make(struct pl_pid_q_config *cfg, pl_real kp, pl_real ki,
			 pl_real kd, pl_real ts, pl_real u_min, pl_real u_max)
{
	if (ts <= 0 || u_min > u_max)
		return -EINVAL;
	if (u_min < -PL_Q_RAW_MAX || u_max > PL_Q_RAW_MAX)
		return -EINVAL;
	cfg->kp_q = pl_q_from_real(kp);
	cfg->ki_ts_q = pl_q_from_real(ki * ts);
	cfg->kd_over_ts_q = pl_q_from_real(kd / ts);
	cfg->u_min_q = pl_q_from_real(u_min);
	cfg->u_max_q = pl_q_from_real(u_max);
	return 0;
}

void pl_pid_q_init(struct pl_pid_q *pid, const struct pl_pid_q_config *cfg)
{
	pid->cfg = *cfg;
	pid->integral = 0;
	pid->prev_e = 0;
	pid->primed = false;
	pid->saturated = false;
}

int16_t pl_pid_q_update(struct pl_pid_q *pid, int32_t r_q, int32_t y_q)
{
	const struct pl_pid_q_config *c = &pid->cfg;
	int32_t e = pl_q_sat((int64_t)r_q - y_q);
	int32_t p, d, v, u;
	bool wind_up;

	if (!pid->primed) {
		pid->prev_e = e;
		pid->primed = true;
	}
	p = pl_q_mul(c->kp_q, e);
	d = pl_q_mul(c->kd_over_ts_q, pl_q_sat((int64_t)e - pid->prev_e));
	pid->prev_e = e;
	v = pl_q_sat((int64_t)pl_q_sat((int64_t)p + pid->integral) + d);
	u = v < c->u_min_q ? c->u_min_q : (v > c->u_max_q ? c->u_max_q : v);
	pid->saturated = u != v;
	wind_up = (e > 0 && v > u) || (e < 0 && v < u);
	if (!wind_up)
		pid->integral = pl_q_sat((int64_t)pid->integral +
					 pl_q_mul(c->ki_ts_q, e));
	return (int16_t)((u + (PL_Q_ONE >> 1)) >> PL_Q_FRAC);
}
```

</details>

完整应用：[`c/apps/ch10.c`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/c/apps/ch10.c)。

### C++

`PidQ` 是一个很小的类。`MakePidQConfig` 返回 `std::optional`，没有异常：

```cpp
// The CLAMP anti-windup rule; the first Update primes the D term.
class PidQ {
 public:
  explicit PidQ(const PidQConfig& cfg) : cfg_(cfg) {}

  // One sample; r_q and y_q are Q16.16. Returns the int16 command.
  std::int16_t Update(std::int32_t r_q, std::int32_t y_q) {
    const std::int32_t e = QSat(static_cast<std::int64_t>(r_q) - y_q);
    if (!primed_) {
      prev_e_ = e;
      primed_ = true;
    }
    const std::int32_t p = QMul(cfg_.kp_q, e);
    const std::int32_t d =
        QMul(cfg_.kd_over_ts_q, QSat(static_cast<std::int64_t>(e) - prev_e_));
    prev_e_ = e;
    const std::int32_t v = QSat(static_cast<std::int64_t>(QSat(
                                    static_cast<std::int64_t>(p) + integral_)) +
                                d);
    const std::int32_t u =
        v < cfg_.u_min_q ? cfg_.u_min_q : (v > cfg_.u_max_q ? cfg_.u_max_q : v);
    saturated_ = u != v;
    const bool wind_up = (e > 0 && v > u) || (e < 0 && v < u);
    if (!wind_up) {
      integral_ =
          QSat(static_cast<std::int64_t>(integral_) + QMul(cfg_.ki_ts_q, e));
    }
    return static_cast<std::int16_t>((u + (kQOne >> 1)) >> kQFrac);
  }

  bool saturated() const { return saturated_; }
  std::int32_t integral() const { return integral_; }

 private:
  PidQConfig cfg_;
  std::int32_t integral_ = 0;
  std::int32_t prev_e_ = 0;
  bool primed_ = false;
  bool saturated_ = false;
};
```

应用里的仿真循环是函数模板，`T` 是 `double` 或 `float`；`RunAll<float>()` 用的就是第 5 篇原封不动的 `Pid<float>`：

```cpp
bool RunFloat(const SimCase& c) {
  const auto data = pidlab::ReadCsv(std::string("data/") + c.data + ".csv");
  if (!data) return false;
  const auto* t = data->Col("t");
  const auto* r = data->Col("r");
  const auto* d = data->Col("d");
  const auto* w = data->Col("w");
  if (!t || !r || !d || !w) return false;

  double kp, ki;
  RawGains<T>(&kp, &ki);
  pidlab::PidConfig<T> cfg{static_cast<T>(kp), static_cast<T>(ki), T(0),
                           static_cast<T>(kTsNom)};
  cfg.u_min = -static_cast<T>(kRawFull);
  cfg.u_max = static_cast<T>(kRawFull);
  auto pid = pidlab::Pid<T>::Create(cfg);
  if (!pid) return false;
  const pidlab::MotorSpeedLag<T> plant;
  std::array<T, 2> x = {T(0), T(0)};
  std::vector<std::vector<double>> cols(7);
  double t_act = 0.0;
  T prev = static_cast<T>(kTsNom);
  for (std::size_t k = 0; k < t->size(); ++k) {
    const T ts_k = static_cast<T>(kTsNom) *
                   (T(1) + static_cast<T>(kJitter) * static_cast<T>((*w)[k]));
    const T ytrue = x[0] * static_cast<T>(kRpmPerRads);
    const T y = c.quant ? std::round(ytrue) : ytrue;
    if (c.jitter == 2) pid->mutable_config().ts = prev;
    T u = pid->Update(static_cast<T>((*r)[k]), y);
    if (c.quant) u = std::round(u);
    const double row[7] = {
        c.jitter ? t_act : (*t)[k],  (*r)[k], y, u, ytrue, pid->integral(),
        pid->saturated() ? 1.0 : 0.0};
    for (int i = 0; i < 7; ++i) cols[i].push_back(row[i]);
    const std::array<T, 2> in = {u * static_cast<T>(kAmpPerRaw),
                                 static_cast<T>((*d)[k])};
    pidlab::Advance(
        [&](const auto& s, const auto& v) { return plant.Deriv(s, v); }, x, in,
        ts_k, kSubsteps);
    t_act += ts_k;
    prev = ts_k;
  }
  const std::string suffix = sizeof(T) == 4 ? "_f32_cpp.csv" : "_cpp.csv";
  return pidlab::WriteCsv(std::string("out/ch10/") + c.name + suffix,
                          {"t", "r", "y", "u", "ytrue", "integral", "sat"},
                          cols);
}
```

<details>
<summary>完整源码：cpp/include/pidlab/pid_q.h</summary>

```cpp
// Q16.16 fixed-point PI(D): int32 state, int64 products, int16 command.
#ifndef PIDLAB_PID_Q_H_
#define PIDLAB_PID_Q_H_

#include <cmath>
#include <cstdint>
#include <optional>

namespace pidlab {

inline constexpr int kQFrac = 16;
inline constexpr std::int32_t kQOne = 1 << kQFrac;
inline constexpr int kQRawMax = 32767;  // largest |command| an int16 holds

// Saturate a 64-bit value to int32.
inline std::int32_t QSat(std::int64_t x) {
  if (x < INT32_MIN) return INT32_MIN;
  if (x > INT32_MAX) return INT32_MAX;
  return static_cast<std::int32_t>(x);
}

// Real to Q16.16: round half away from zero, saturate to int32.
template <class T>
std::int32_t QFromReal(T x) {
  const T v = std::round(x * static_cast<T>(kQOne));
  if (v <= static_cast<T>(INT32_MIN)) return INT32_MIN;
  if (v >= static_cast<T>(INT32_MAX)) return INT32_MAX;
  return static_cast<std::int32_t>(v);
}

// a * b in Q16.16: 64-bit product, round half up, saturate. Right shift of
// a negative value is arithmetic since C++20.
inline std::int32_t QMul(std::int32_t a, std::int32_t b) {
  return QSat((static_cast<std::int64_t>(a) * b + (1 << (kQFrac - 1))) >>
              kQFrac);
}

// Gains already converted to Q16.16.
struct PidQConfig {
  std::int32_t kp_q, ki_ts_q, kd_over_ts_q;
  std::int32_t u_min_q, u_max_q;
};

// Precompute kp, ki * ts and kd / ts. Returns std::nullopt unless ts > 0,
// u_min <= u_max and both limits fit an int16.
template <class T>
std::optional<PidQConfig> MakePidQConfig(T kp, T ki, T kd, T ts, T u_min,
                                         T u_max) {
  if (ts <= T(0) || u_min > u_max) return std::nullopt;
  if (u_min < -kQRawMax || u_max > kQRawMax) return std::nullopt;
  return PidQConfig{QFromReal(kp), QFromReal(ki * ts), QFromReal(kd / ts),
                    QFromReal(u_min), QFromReal(u_max)};
}

// The CLAMP anti-windup rule; the first Update primes the D term.
class PidQ {
 public:
  explicit PidQ(const PidQConfig& cfg) : cfg_(cfg) {}

  // One sample; r_q and y_q are Q16.16. Returns the int16 command.
  std::int16_t Update(std::int32_t r_q, std::int32_t y_q) {
    const std::int32_t e = QSat(static_cast<std::int64_t>(r_q) - y_q);
    if (!primed_) {
      prev_e_ = e;
      primed_ = true;
    }
    const std::int32_t p = QMul(cfg_.kp_q, e);
    const std::int32_t d =
        QMul(cfg_.kd_over_ts_q, QSat(static_cast<std::int64_t>(e) - prev_e_));
    prev_e_ = e;
    const std::int32_t v = QSat(static_cast<std::int64_t>(QSat(
                                    static_cast<std::int64_t>(p) + integral_)) +
                                d);
    const std::int32_t u =
        v < cfg_.u_min_q ? cfg_.u_min_q : (v > cfg_.u_max_q ? cfg_.u_max_q : v);
    saturated_ = u != v;
    const bool wind_up = (e > 0 && v > u) || (e < 0 && v < u);
    if (!wind_up) {
      integral_ =
          QSat(static_cast<std::int64_t>(integral_) + QMul(cfg_.ki_ts_q, e));
    }
    return static_cast<std::int16_t>((u + (kQOne >> 1)) >> kQFrac);
  }

  bool saturated() const { return saturated_; }
  std::int32_t integral() const { return integral_; }

 private:
  PidQConfig cfg_;
  std::int32_t integral_ = 0;
  std::int32_t prev_e_ = 0;
  bool primed_ = false;
  bool saturated_ = false;
};

}  // namespace pidlab

#endif  // PIDLAB_PID_Q_H_
```

</details>

完整应用：[`cpp/apps/ch10.cc`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/cpp/apps/ch10.cc)。

### Rust

基本操作和 `update`。Rust 里 `as i64` 是显式的，所以哪里升到了 64 位一眼就看得出来：

```rust
pub const Q_RAW_MAX: Real = 32767.0;

/// Saturate a 64-bit value to `i32`.
pub fn q_sat(x: i64) -> i32 {
    x.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

/// Real to Q16.16: round half away from zero, saturate to `i32`.
pub fn q_from_real(x: Real) -> i32 {
    let v = round(x * Q_ONE as Real);
    if v <= i32::MIN as Real {
        i32::MIN
    } else if v >= i32::MAX as Real {
        i32::MAX
    } else {
        v as i32
    }
}

/// `a * b` in Q16.16: 64-bit product, round half up, saturate.
pub fn q_mul(a: i32, b: i32) -> i32 {
    q_sat((a as i64 * b as i64 + (1 << (Q_FRAC - 1))) >> Q_FRAC)
}
```

```rust
    /// One sample; `r_q` and `y_q` are Q16.16. Returns the `i16` command.
    pub fn update(&mut self, r_q: i32, y_q: i32) -> i16 {
        let c = &self.cfg;
        let e = q_sat(r_q as i64 - y_q as i64);
        if !self.primed {
            self.prev_e = e;
            self.primed = true;
        }
        let p = q_mul(c.kp_q, e);
        let d = q_mul(c.kd_over_ts_q, q_sat(e as i64 - self.prev_e as i64));
        self.prev_e = e;
        let v = q_sat(q_sat(p as i64 + self.integral as i64) as i64 + d as i64);
        let u = v.clamp(c.u_min_q, c.u_max_q);
        self.saturated = u != v;
        let wind_up = (e > 0 && v > u) || (e < 0 && v < u);
        if !wind_up {
            self.integral = q_sat(self.integral as i64 + q_mul(c.ki_ts_q, e) as i64);
        }
        ((u + (Q_ONE >> 1)) >> Q_FRAC) as i16
    }
```

应用里的仿真循环。`Real` 在 `f32` 特性下是 `f32`，所以同一份源码编译出两个版本；定点部分（`run_fixed`）只在默认特性下编译：

```rust
fn run_float(c: &SimCase) -> Result<(), Box<dyn Error>> {
    let data = read_csv(format!("data/{}.csv", c.data))?;
    let (t, r, d, w) = (data.col("t"), data.col("r"), data.col("d"), data.col("w"));
    let (kp, ki) = raw_gains();
    let mut cfg = PidConfig::new(kp as Real, ki as Real, 0.0, TS_NOM);
    cfg.u_min = -RAW_FULL;
    cfg.u_max = RAW_FULL;
    let mut pid = Pid::new(cfg).map_err(|e| format!("{e:?}"))?;
    let plant = MotorSpeedLag::new();
    let mut x = [0.0; 2];
    let mut cols: Vec<Vec<f64>> = vec![Vec::new(); 7];
    let mut t_act = 0.0f64;
    let mut prev = TS_NOM;
    for k in 0..t.len() {
        let ts_k = TS_NOM * (1.0 + JITTER * w[k] as Real);
        let ytrue = x[0] * RPM_PER_RADS as Real;
        let y = if c.quant { round(ytrue) } else { ytrue };
        if c.jitter == 2 {
            pid.cfg.ts = prev;
        }
        let mut u = pid.update(r[k] as Real, y, 0.0, false);
        if c.quant {
            u = round(u);
        }
        let row = [
            if c.jitter != 0 { t_act } else { t[k] },
            r[k],
            y as f64,
            u as f64,
            ytrue as f64,
            pid.integral() as f64,
            if pid.saturated() { 1.0 } else { 0.0 },
        ];
        for (col, v) in cols.iter_mut().zip(row) {
            col.push(v);
        }
        let input = [u * AMP_PER_RAW, d[k] as Real];
        advance(|s, v| plant.deriv(s, v), &mut x, &input, ts_k, SUBSTEPS);
        t_act += ts_k as f64;
        prev = ts_k;
    }
```

<details>
<summary>完整源码：rust/src/pid_q.rs</summary>

```rust
//! Q16.16 fixed-point PI(D): `i32` state, `i64` products, `i16` command.

use crate::real::{Real, round};

pub const Q_FRAC: u32 = 16;
pub const Q_ONE: i32 = 1 << Q_FRAC;
/// Largest `|command|` an `i16` can carry.
pub const Q_RAW_MAX: Real = 32767.0;

/// Saturate a 64-bit value to `i32`.
pub fn q_sat(x: i64) -> i32 {
    x.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

/// Real to Q16.16: round half away from zero, saturate to `i32`.
pub fn q_from_real(x: Real) -> i32 {
    let v = round(x * Q_ONE as Real);
    if v <= i32::MIN as Real {
        i32::MIN
    } else if v >= i32::MAX as Real {
        i32::MAX
    } else {
        v as i32
    }
}

/// `a * b` in Q16.16: 64-bit product, round half up, saturate.
pub fn q_mul(a: i32, b: i32) -> i32 {
    q_sat((a as i64 * b as i64 + (1 << (Q_FRAC - 1))) >> Q_FRAC)
}

/// Gains already converted to Q16.16.
#[derive(Clone, Copy, Debug)]
pub struct PidQConfig {
    pub kp_q: i32,
    pub ki_ts_q: i32,
    pub kd_over_ts_q: i32,
    pub u_min_q: i32,
    pub u_max_q: i32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PidQError {
    InvalidConfig(&'static str),
}

impl PidQConfig {
    /// Precompute `kp`, `ki * ts` and `kd / ts`. Fails unless `ts > 0`,
    /// `u_min <= u_max` and both limits fit an `i16`.
    pub fn make(
        kp: Real,
        ki: Real,
        kd: Real,
        ts: Real,
        u_min: Real,
        u_max: Real,
    ) -> Result<Self, PidQError> {
        if ts <= 0.0 || u_min > u_max {
            return Err(PidQError::InvalidConfig("need ts > 0, u_min <= u_max"));
        }
        if u_min < -Q_RAW_MAX || u_max > Q_RAW_MAX {
            return Err(PidQError::InvalidConfig("limits must fit an i16"));
        }
        Ok(Self {
            kp_q: q_from_real(kp),
            ki_ts_q: q_from_real(ki * ts),
            kd_over_ts_q: q_from_real(kd / ts),
            u_min_q: q_from_real(u_min),
            u_max_q: q_from_real(u_max),
        })
    }
}

/// The CLAMP anti-windup rule; the first `update` primes the D term.
pub struct PidQ {
    cfg: PidQConfig,
    integral: i32,
    prev_e: i32,
    primed: bool,
    saturated: bool,
}

impl PidQ {
    pub fn new(cfg: PidQConfig) -> Self {
        Self {
            cfg,
            integral: 0,
            prev_e: 0,
            primed: false,
            saturated: false,
        }
    }

    /// One sample; `r_q` and `y_q` are Q16.16. Returns the `i16` command.
    pub fn update(&mut self, r_q: i32, y_q: i32) -> i16 {
        let c = &self.cfg;
        let e = q_sat(r_q as i64 - y_q as i64);
        if !self.primed {
            self.prev_e = e;
            self.primed = true;
        }
        let p = q_mul(c.kp_q, e);
        let d = q_mul(c.kd_over_ts_q, q_sat(e as i64 - self.prev_e as i64));
        self.prev_e = e;
        let v = q_sat(q_sat(p as i64 + self.integral as i64) as i64 + d as i64);
        let u = v.clamp(c.u_min_q, c.u_max_q);
        self.saturated = u != v;
        let wind_up = (e > 0 && v > u) || (e < 0 && v < u);
        if !wind_up {
            self.integral = q_sat(self.integral as i64 + q_mul(c.ki_ts_q, e) as i64);
        }
        ((u + (Q_ONE >> 1)) >> Q_FRAC) as i16
    }

    pub fn saturated(&self) -> bool {
        self.saturated
    }

    pub fn integral(&self) -> i32 {
        self.integral
    }
}
```

</details>

完整应用：[`rust/src/bin/ch10.rs`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/rust/src/bin/ch10.rs)。

### 静态检查

`scripts/ch10_checks.sh` 做四件事，都是在 `make ch10` 里自动跑的：

- **C 没有堆。** 对 `build/c/obj/*.o`（除了读写 CSV 的 `csv.o`）跑 `nm -u`，找不到 `malloc`、`calloc`、`realloc`、`free`。
- **C++ 没有堆。** `cpp/tests/no_heap.cc` 实例化 `Pid<float>`、`Pid<double>` 和 `PidQ`，用 `-fno-exceptions -fno-rtti` 编译，`nm -C -u` 里没有 `operator new` 和 `malloc`。
- **Rust 的 `no_std` 构建。** `cargo build --lib --no-default-features --features f32` 通过，库本身不依赖 `std`，也没有 `alloc`。
- **Cortex-M4F 的编译。** `arm-none-eabi-gcc`（15.2.1）用 `-mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard -O2 -std=c11 -DPL_USE_FLOAT -Wdouble-promotion -Werror` 编译 `pid.c` 和 `pid_q.c`，然后 `arm-none-eabi-size`。`-Wdouble-promotion -Werror` 的意思是：任何一处 float 悄悄升成 double 都会让编译失败；脚本最后还数一下目标文件里引用了几个 `__aeabi_d*` 软件双精度函数。

完整脚本：

```bash
#!/usr/bin/env bash
# Chapter 10 static checks: no heap in the controllers, no_std build,
# Cortex-M4F code size.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== C: heap symbols referenced by the library objects (everything except csv.o)"
bad=0
for o in build/c/obj/*.o; do
	[ "$(basename "$o")" = csv.o ] && continue
	if nm -u "$o" | grep -E ' (malloc|calloc|realloc|free)$'; then
		echo "heap symbol in $o"
		bad=1
	fi
done
[ "$bad" = 0 ] || exit 1
echo "ok: no malloc/calloc/realloc/free in $(ls build/c/obj/*.o | grep -vc csv.o) library objects"

echo "== C++: heap symbols in the compiled controllers (-fno-exceptions -fno-rtti)"
mkdir -p build/cpp
g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic -Werror -fno-exceptions -fno-rtti \
	-I cpp/include -c cpp/tests/no_heap.cc -o build/cpp/no_heap.o
if nm -C -u build/cpp/no_heap.o | grep -E 'operator new|malloc'; then
	echo "heap symbol in no_heap.o"
	exit 1
fi
echo "ok: no operator new / malloc; undefined symbols are:"
nm -C -u build/cpp/no_heap.o | sed 's/^ */  /'

echo "== Rust: no_std build of the library (no alloc)"
(cd rust && cargo build --lib --no-default-features --features f32 --quiet)
echo "ok: cargo build --lib --no-default-features --features f32"

echo "== Cortex-M4F code size of the controllers (float, -O2, compile only)"
mkdir -p build/arm
flags="-mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard -O2 -ffunction-sections -fdata-sections -std=c11 -DPL_USE_FLOAT -Wall -Wextra -Wdouble-promotion -Werror -I c/include"
for s in pid pid_q; do
	arm-none-eabi-gcc $flags -c "c/src/$s.c" -o "build/arm/$s.o"
done
arm-none-eabi-size build/arm/pid.o build/arm/pid_q.o
undef=$( (arm-none-eabi-nm -u build/arm/pid.o build/arm/pid_q.o | grep -E '__aeabi_(d|f2d)' || true) | sort -u | wc -l)
echo "soft-double helper symbols (__aeabi_d*, __aeabi_f2d) referenced: $undef"
```

风格检查：C 用内核的 `checkpatch.pl`（`--no-tree`，忽略 SPDX 和 typedef 两项）对 `c/include/pl/*.h`、`c/src/*.c`、`c/apps/*.c` 全部检查，0 errors、0 warnings；C++ 用 clang-format 21.1.8 的 Google 风格（`-Werror`，现在连 `cpp/tests` 也在内）；Python 用 ruff 0.15.14（行宽 79，`ruff format --check` 和 `ruff check`）；Rust 用 `cargo fmt --check` 和 `cargo clippy --release -- -D warnings`（float32 的构建也跑 clippy）。

## 结果

`make ch10` 是第 8 篇那种手写的目标：先 `ref`，再构建 double 和 float32 的 C、Rust，然后各个程序依次运行，再是静态检查，最后跑计时，最后才是 `report`。计时不能和别的东西并行，所以整条链是串行的。构建已经缓存的时候整条链大约 10 秒。完整输出（我只去掉了 `nix develop` 打印的横幅，其余没动）：

```text
$ make -s ch10
ch10: C (f64) wrote 5 cases to out/ch10
ch10: C (f32) wrote 5 cases to out/ch10
ch10: C++ (f64) wrote 5 cases to out/ch10
ch10: C++ (f32) wrote 5 cases to out/ch10
ch10: Rust (f64) wrote 5 cases to out/ch10
ch10: Rust (f32) wrote 5 cases to out/ch10
== C: heap symbols referenced by the library objects (everything except csv.o)
ok: no malloc/calloc/realloc/free in 13 library objects
== C++: heap symbols in the compiled controllers (-fno-exceptions -fno-rtti)
ok: no operator new / malloc; undefined symbols are:
== Rust: no_std build of the library (no alloc)
ok: cargo build --lib --no-default-features --features f32
== Cortex-M4F code size of the controllers (float, -O2, compile only)
   text	   data	    bss	    dec	    hex	filename
    556	      0	      0	    556	    22c	build/arm/pid.o
   1332	      0	      0	   1332	    534	build/arm/pid_q.o
soft-double helper symbols (__aeabi_d*, __aeabi_f2d) referenced: 0
natives vs the Python reference (tolerance 1e-9, Q16.16: 0)
ok   fixed_quant_off_c.csv: max diff 0.000e+00 <= 0.0e+00
ok   fixed_quant_off_cpp.csv: max diff 0.000e+00 <= 0.0e+00
ok   fixed_quant_off_rs.csv: max diff 0.000e+00 <= 0.0e+00
ok   fixed_quant_on_c.csv: max diff 0.000e+00 <= 0.0e+00
ok   fixed_quant_on_cpp.csv: max diff 0.000e+00 <= 0.0e+00
ok   fixed_quant_on_rs.csv: max diff 0.000e+00 <= 0.0e+00
ok   fixed_stall_c.csv: max diff 0.000e+00 <= 0.0e+00
ok   fixed_stall_cpp.csv: max diff 0.000e+00 <= 0.0e+00
ok   fixed_stall_rs.csv: max diff 0.000e+00 <= 0.0e+00
ok   jitter_measured_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   jitter_measured_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   jitter_measured_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   jitter_nominal_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   jitter_nominal_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   jitter_nominal_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   quant_off_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   quant_off_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   quant_off_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   quant_on_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   quant_on_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   quant_on_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   stall_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   stall_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   stall_rs.csv: max diff 0.000e+00 <= 1.0e-09

float32 builds: C vs C++ vs Rust, and each vs the f64 reference
case                 c-cpp      c-rs  f32-f64 y  f32-f64 u f32-f64 int
stall             0.00e+00  0.00e+00  1.432e-02  3.994e-01   3.772e-01
quant_off         0.00e+00  0.00e+00  1.432e-02  3.986e-01   3.886e-01
quant_on          0.00e+00  0.00e+00  1.000e+00  2.300e+01   4.826e+00
jitter_nominal    0.00e+00  0.00e+00  1.234e-02  3.510e-01   3.238e-01
jitter_measured   0.00e+00  0.00e+00  1.295e-02  3.451e-01   3.261e-01
ok   float32 outputs agree across languages within 1e-04

speed PI in raw units: kp = 18.614 /rpm, ki = 402.06 /rpm/s, ki*ts = 0.4021
integrator stall: slow load ramp, last 5 s (load constant)
           |integral| end  max |e| (rpm)
(f32 ctl: float32 controller on a float64 plant;
 f64 int u: float64 controller, command rounded to int)
f64              10401.29      1.137e-12
f32              10401.63      7.324e-04
q16              10401.49      1.129e-03
f32 ctl          10401.31      1.041e-03
f64 int u        10401.49      1.124e-03
integral gap vs f64: f32 0.377, q16 0.364 (raw)
deadband at integral = 10402 (error that still moves it):
   ki*ts   half ulp / (ki*ts)  float32 bisection
  0.4021            1.214e-03          1.214e-03
  0.0100            4.883e-02          4.883e-02
  0.0010            4.883e-01          4.883e-01

CAN quantization: integer rpm feedback, int16 command
           rms e [1,1.5)  rms e [2,3)  u changes [2,3)  u ptp [2,3)
quant_off      6.707e-07    7.964e-04              997          0.1
quant_on       2.731e-01    2.978e-01                4         37.0
one rpm of feedback is kp = 18.6 raw of command

jitter: ts_k = 1 ms * (1 + 0.2 w), w ~ U[-1, 1]
                  IAE [1,2) rpm s  IAE [2,3) rpm s  late std u  late std e
jitter_nominal             30.947           14.796      0.0335    2.16e-03
jitter_measured            30.782           14.991      0.0324    2.18e-03
IAE difference after the setpoint step: 0.53 %

host timing on: AMD Ryzen 7 PRO 6850U with Radeon Graphics
ns per update, median of 5 runs of 1e6 (host, NOT the MCU)
            f64      f32      q16
c          4.71     4.69     3.79
cpp        1.87     2.18     2.00
rs         4.01     4.08     5.41
figure: figures/ch10/float32-stall.svg
figure: figures/ch10/fixed-vs-float.svg
figure: figures/ch10/can-quantization.svg
figure: figures/ch10/jitter.svg
figure: figures/ch10/timing.svg

ch10 OK
```

### 对得上吗：Q16.16 逐位一致，float32 也是

24 个比较文件全部通过。三个 `fixed_*` 算例的容差是 0，每种语言的每一列，包括 `r_q`、`y_q`、`u`、`integral_q`、`sat`，最大差异都是 0（所以三种语言的 Q16.16 和 Python 的整数参考实现逐位一致）。五个 `double` 算例和 Python 的最大差异也是 0.000e+00，比计划里的 $10^{-9}$ 好得多（这五个算例没有三角函数，Rust 的 `libm` 和 glibc 的差异不会出现）。

float32 的构建没有 Python 的 float32 参考，所以我做了两件事：三种语言的 float32 输出两两比较，以及和 Python 的 `double` 参考比较。**C、C++、Rust 的 float32 输出逐位一致**（最大差异 0，计划里的容差是 $10^{-4}$，所以断言是“不超过 $10^{-4}$”，实际是 0）。

这个“逐位一致”不是一次就到的。第一次跑的时候 C 和另外两种语言差了 0.029（积分项），C++ 和 Rust 之间是 0。原因是 `sim.c` 里的 RK4 写的是 `0.5 * h * k1[i]` 和 `h / 6.0`：字面量是 `double`，在 float32 构建里整个表达式被悄悄提升成 double 再舍回 float，而 C++ 和 Rust 是纯 float 运算。我把这几个字面量改成了 `0.5f`、`6.0f`、`2.0f`（在 double 构建里它们是精确可表示的，所以 double 的结果不变）。`freq.c` 里的 `PL_CABS(1.0 + cur)` 在 float32 构建里同样编译不过，改成 `(pl_real)1 + cur`。这两处都是前面章节的文件，改完以后我重跑了第 1、3、9 篇，都通过；其余章节我没有重跑，只是论证了改动不会改变 double 的结果：`0.5f`、`6.0f`、`2.0f` 都是精确可表示的，`(pl_real)1` 在 double 构建里就是 `1.0`。**逐位一致也有前提：** x86-64 的基线指令集没有融合乘加，gcc 和 rustc 都不会把 `a*b+c` 合并成一条指令。如果换到有 FMA 的目标（据我所知 M4F 的 FPU 有融合乘加指令），我猜三种语言的结果会因为编译器的合并策略不同而分开，没有试过。

和 `double` 参考比，float32 在 `stall` 上的最大差异：转速 0.014 rpm、命令 0.40 raw、积分项 0.38 raw。`quant_on` 是个例外：转速差 1.0 rpm、命令差 23 raw，因为取整的分支（`round(y)` 的 0.5 平局）在 float32 和 double 里翻向了不同的一侧，两条轨迹从那个采样起走开了。这就是计划里说的“不连续性在最后一位上翻转”，只是这里翻转发生在 float32 对 double 之间，不是语言之间，所以不需要每个算例的容差覆盖。

### float32 的积分器停了，停在 1 mrpm

![积分器停滞：左图是半个 ulp 除以 ki·ts 给出的误差带随积分项大小的阶梯曲线，右图是缓慢加载时 float32 和 Q16.16 的积分项相对 f64 的差，在 5.6 s 之后冻结在约 0.35 和 0.20](/assets/images/pid-control/ch10-float32-stall.svg)

左图是 $e_{\min}=\text{ulp}(I)/(2k_it_s)$ 的阶梯，三条线是三个 $k_it_s$：这篇用的 0.402、0.01、0.001。每次积分项跨过 2 的幂，误差带翻一倍。黑星是 float32 控制器（对象用 float64）在负载稳定后的实际残余误差。右图是整条回路都在 float32 或 Q16.16 里的积分项和 double 版本的差，大约 5.6 s 之后（负载缓升结束）就冻结了，不再变化。

数字（`report` 输出里的表）：

- 积分项到 10401 raw（超过计划里的 $10^4$），负载在最后 5 s 恒定。
- `f64`：残余误差 $1.1\times10^{-12}$ rpm，没有停滞。
- `f32 ctl`（float32 控制器，float64 对象）：残余误差 $1.041\times10^{-3}$ rpm，积分项 10401.31（`f64` 是 10401.29，差 0.02）。
- 公式 $e_{\min}$ 是 $1.214\times10^{-3}$ rpm，实测是它的 0.86 倍。公式是上限（积分器停在误差带的边缘以内），所以这个比值合理。
- float32 加法二分出来的误差带，和公式在三个 $k_it_s$ 上完全一致：0.4021 对 $1.214\times10^{-3}$，0.01 对 $4.883\times10^{-2}$，0.001 对 $4.883\times10^{-1}$ rpm。

所以结论是：**float32 的积分器停滞是真的，大小和半个 ulp 的推导一致，但对这个速度环它是 $10^{-3}$ rpm 的事，在 2000 rpm 上不值得操心。** 如果 $k_it_s$ 小两个数量级，误差带就是 0.5 rpm，开始有意义；我没有在 RM 的真实固件里核实 $k_it_s$ 通常是多大，所以“RM 代码里 $k_it_s$ 很小”只是我的猜测，不是结论。

这里有一个我差点说错的地方。原生的 float32 构建（控制器和对象都是 float32）残余误差是 $7.32\times10^{-4}$ rpm，积分项 10401.63，和 `double` 差 0.34；而 float32 控制器配 float64 对象的积分项只差 0.02。多出来的那 0.32 raw 来自**对象**：float32 的 `w` 在 10.9 rad/s 附近的 ulp 是 $9.5\times10^{-7}$，RK4 子步的增量 $h\,\dot w$ 小于一半就丢了，对象自己的状态也在停滞。真实的电机不会这样，所以用 float32 仿真去回答“真车上的 float32 控制器会怎样”会掺进仿真器自己的舍入。我把 `f32 ctl` 这一行加进了 `report` 就是为了把它们分开，上面的结论用的是它。

### Q16.16 对 float32：不是更准，是误差换了个地方

![Q16.16 和 float32 的残余误差：左图 10 s 起的 0.1 s，float32 是一条 7.3e-4 rpm 的水平线，Q16.16 是 ±1e-3 rpm 的锯齿，float64 在 0；右图是 Q16.16 命令减 f64 命令，在 -0.29 到 +0.71 raw 之间跳](/assets/images/pid-control/ch10-fixed-vs-float.svg)

负载恒定之后三种格式的残余误差。float32（整条回路）是一条水平线：积分器停了，误差不动。Q16.16 是锯齿：它的最大误差是 $1.129\times10^{-3}$ rpm，比 float32 大，但它不是积分器的问题。Q16.16 的积分项分辨率是 $1.5\times10^{-5}$ raw，比 float32 在 10401 附近的 $9.8\times10^{-4}$ 细 64 倍，积分器根本不会停。锯齿来自最后一步：**命令取整成 `int16`**。我在 Python 里把 `double` 版本的命令也取整成整数（不动反馈，不用定点），残余误差是 $1.124\times10^{-3}$ rpm，和 Q16.16 的 $1.129\times10^{-3}$ 差不到 0.5%。`report` 里断言了这两个数在 10% 以内。右图是 Q16.16 的命令减去 `double` 命令，只在 $-0.29$ 和 $+0.71$ raw 之间跳，就是取整的两侧。

所以“定点数更准”是错的，更准确的说法是：**定点数的分辨率是常数，float32 的分辨率随数的大小变；这个对象里积分项是大数（1 万以上），定点数的分辨率反而更细，但输出最后要变成 `int16`，这一步无论用哪种格式都躲不掉。**

### CAN 量化：不是抖动，是 0.85 秒一个的锯齿

![CAN 量化：负载稳定后的 1 秒，quant_off（蓝）的误差贴着 0，quant_on（橙）的误差从 +0.45 rpm 线性掉到 -0.50 rpm 然后跳回，命令基本不动，在 2.85 s 处有一个单采样的 -19 raw 毛刺](/assets/images/pid-control/ch10-can-quantization.svg)

指标（`report` 输出）：

- 负载稳定后（2 到 3 s）速度误差的均方根：`quant_off` $7.96\times10^{-4}$ rpm，`quant_on` $0.298$ rpm，是 374 倍。
- 这 1 s 里命令变了多少次：`quant_off` 997 次（每个采样都在微调，峰峰值 0.1 raw），`quant_on` 只有 4 次（峰峰值 37 raw：2.001 s 和 2.002 s 是负载瞬态的尾巴，2.849 s 和 2.850 s 是下面要说的翻档毛刺和恢复）。

我预想的是“量化会让命令抖”，**实际是反过来的：量化让命令几乎不动，让速度慢慢漂。** 图里 `quant_on` 的误差从 $+0.45$ rpm 一路线性掉到 $-0.50$ rpm，斜率 1.12 rpm/s（我拟合出来是 1.125），到 2.85 s 反馈的整数 rpm 翻了一档，比例项一步把命令拉低了一个 $k_p\times1\text{ rpm}=18.6$ raw（图里的毛刺，3010 对 3029），然后回到 3028，误差跳回去，下一轮锯齿开始。

斜率可以对上：命令是整数 3029，而需要的电流大约对应 3028.5，差半个 raw。半个 raw 的转矩误差是 $0.5\times\frac{20}{16384}\times0.3=1.83\times10^{-4}$ N·m，除以 $J=0.03$ 得 $6.1\times10^{-3}$ rad/s²，乘 183.4 rpm/(rad/s) 得 1.119 rpm/s。拟合出来的 1.125 rpm/s 对上了。这个对象的转子 rpm 量化（1 rpm）和命令量化（半个 raw）合起来产生了一个 0.85 s 周期、$\pm0.5$ rpm 幅度的极限环，在 2000 rpm 上是 0.025%。在这个 $k_p$ 下，它不是抖，是慢速的锯齿；$k_p$ 再大几倍，每次翻档的毛刺就会更明显。这是一个设定值和负载都是常数的算例，我没有扫 $k_p$。

### 抖动：实测周期只改善了 0.53%

![周期抖动：左图 1 s 处设定值从 2000 降到 1000 rpm，标称版本和实测版本的转速曲线几乎重合；右图是两个版本的转速差，最大约 8 rpm，出现在设定值跳变之后](/assets/images/pid-control/ch10-jitter.svg)

指标：

- 设定值降到 1000 rpm 之后那 1 s 的 IAE：标称 30.947 rpm·s，实测 30.782 rpm·s，差 0.53%。
- 2 到 3 s（负载 2 N·m 加上以后）：标称 14.796，实测 14.991；也就是说**实测并不总是更好**，这一段它多了 1.3%。
- 2.5 s 起的稳态里，命令的标准差 0.0335（标称）对 0.0324（实测），误差的标准差 $2.16\times10^{-3}$ 对 $2.18\times10^{-3}$ rpm。

所以我的数学预期成立：差是一个零均值噪声项，大小取决于误差的大小，设定值跳变的时候最大（图右，最多约 8 rpm 的转速差，占 2000 到 1000 的跳变的 0.8%）。**对这个对象，±20% 的周期抖动用不着补偿。** 这不是说周期抖动永远不用管：这里的抖动是独立同分布、零均值的，真实的抖动（中断被别的任务延迟）往往有偏、有相关，我没有试。

### 计时：主机上的数，不是 MCU 上的数

> [!WARNING]
> 下面所有计时都是在我的笔记本（AMD Ryzen 7 PRO 6850U with Radeon Graphics，来自 `/proc/cpuinfo`）上测的，不是 Cortex-M4F。主机有乱序执行、分支预测和大缓存，更新一次只要几个纳秒；M4F 没有这些，同样的代码要多少时钟周期我没有测。**这些数只能比较实现，不能拿来估计 C 板上的耗时。**

每个程序做 $10^6$ 次更新，重复 5 次，取中位数（纳秒/次），输入是一张 4096 点的带噪声测量表：

| 实现 | float64 | float32 | Q16.16 |
| --- | ---: | ---: | ---: |
| C | 4.71 | 4.69 | 3.79 |
| C++ | 1.87 | 2.18 | 2.00 |
| Rust | 4.01 | 4.08 | 5.41 |

![主机计时：每种实现三种格式每次更新的纳秒数，C++ 最低，Q16.16 在 C 里最快、在 Rust 里最慢](/assets/images/pid-control/ch10-timing.svg)

这张图能读出的东西很少。语言之间的差（C++ 比 C 快 2 倍多）大于格式之间的差；我猜原因是 C++ 的 `Pid` 是头文件里的模板，可以内联进测试循环，而 C 的 `pl_pid_update` 在另一个编译单元里，没有链接时优化，每次是一个真正的函数调用；这是猜测，我没有看汇编。格式之间的差更没有规律：Q16.16 在 C 里最快，在 Rust 里最慢。在 x86-64 上 float32 和 float64 的标量乘加延迟本来就差不多，所以 float32 没有变快也不奇怪。**这些数不能支持“定点比浮点快”或者“float32 比 double 快”。**

在 M4F 上有一个更有意义的数：目标文件的大小。

```text
$ arm-none-eabi-size build/arm/pid.o build/arm/pid_q.o
   text	   data	    bss	    dec	    hex	filename
    556	      0	      0	    556	    22c	build/arm/pid.o
   1332	      0	      0	   1332	    534	build/arm/pid_q.o
```

float32 的 `pid.o` 是 556 字节，Q16.16 的 `pid_q.o` 是 1332 字节，更大。M4F 有硬件的单精度 FPU，浮点乘加是一条指令；定点这边每次乘法要处理 64 位中间值、舍入和饱和，指令更多。脚本最后数到的软件双精度函数（`__aeabi_d*`）是 0 个，所以 `-Wdouble-promotion -Werror` 的意义是实打实的：这两个文件里没有任何一处悄悄用了 double。**这回答了开头的问题：在有单精度 FPU 的 C 板上，float32 的 `Pid` 比 Q16.16 版本更小，我没有测它更快还是更慢（那需要真板子）。定点数的价值在没有 FPU 的核（Cortex-M0、M3 一类）上，那些我没有编译过，所以这是一个推测。**

### 对不上的地方

- **float32 积分器停滞的大小比我预想的小得多。** 计划里的“停滞”是对的，但在这个速度环上它是 $10^{-3}$ rpm。我没有为了让它更明显去降低 $k_i$，那样就不是我手上这个速度环了；二分表里给了 $k_it_s$ 小一到两个数量级时的数字。
- **原生 float32 构建里对象自己也在舍入。** 所以停滞的数字取自 Python 的 `f32 ctl`（控制器 float32，对象 float64），而不是原生构建的 $7.3\times10^{-4}$。这个函数只在 Python 里存在，原生程序不做这个组合。
- **Q16.16 的残余误差来自 `int16` 命令，不来自定点。** 用 `double` 加整数命令复现了同样的数字（$1.124\times10^{-3}$ 对 $1.129\times10^{-3}$）。这个实验不在原生程序里，只在 `report` 里，靠 Python 的 `quant_u` 开关。
- **CAN 量化的“抖”不存在，存在的是锯齿。** 我预想命令会抖，实测命令几乎不动。我只测了一个 $k_p$。
- **周期抖动的补偿只有 0.53%。** 一个算例，一个种子（10）。2 到 3 s 段补偿反而差了 1.3%。
- **三种语言的 float32 逐位一致，容差 $10^{-4}$ 用不上。** 它依赖 x86-64 没有 FMA；换到有 FMA 的目标，我不保证。
- **改了两个旧文件。** `sim.c`（RK4 的字面量加 `f`）和 `freq.c`（`PL_CABS` 的参数类型）。double 构建下 `sim.c` 的改动是精确的，我重跑了第 1、3、9 篇确认没有变化。
- **计时不可靠。** 5 次中位数、一台笔记本、没有锁频；C++ 比 C 快的原因是我猜的。C 的 `pid.o` 和 `pid_q.o` 在 M4F 上的体积是真实的编译结果，但没有在真板子上跑过。
- **板子和电调的参数，我核对了一部分。** M3508 的转矩常数 0.3 N·m/A、减速比 3591/187、空载 482 rpm 和额定 3 N·m 在[数据手册](https://cdn-hz.robomaster.com/robomasters/public/document/RoboMaster%20M3508%20P19%20Brushless%20DC%20Gear%20Motor.pdf)里有；C620 的 $\pm16384\leftrightarrow\pm20$ A 和 rpm 反馈在手册里有（镜像文件）；C 板是 STM32F407 来自 C 板手册的框图（PDF 转文字后读到的，图本身我没有看）。**没有核实的**：数据手册里转矩常数对应哪根轴、反馈转速字段是否有符号、负载惯量 0.03 kg·m²（我取的量级）、电流环时间常数 1 ms（我取的量级）。

## 外推

这一篇我把第 5 篇的 `Pid` 搬到了 float32（C、C++、Rust 三种语言逐位一致，积分器会停，但停在 $1.04\times10^{-3}$ rpm），写了 Q16.16 的 `PidQ`（三种语言和 Python 逐位一致，差异 0），把它们放进三个上车的麻烦里：CAN 量化把 $0.8\times10^{-3}$ rpm 的稳态误差变成 0.298 rpm 的锯齿，周期抖动在实测补偿下 IAE 只变了 0.53%，M4F 上 float32 的 `Pid` 是 556 字节、Q16.16 的是 1332 字节。系列到这里是十篇：一个电机，加上 P、I、D，加上传递函数和频域，加上离散化和工程上的坑，加上整定、串级和多变量，最后是状态反馈和这一篇的嵌入式。

下一步不是再写一篇，是把它们装到真的 C 板上。我手上这些控制器（第 5 篇的 `Pid`、第 7 篇的串级、第 8 篇的矩阵增益、第 9 篇的 LQI）都是 `no_std`、无堆、可以编译到 M4F 的，而 RoboMaster 的云台还缺一样东西：第 7 篇里的角度和陀螺仪噪声是我从[卡尔曼系列的第 4 篇](/posts/kalman-filter-04-attitude-imu/)借来的数（陀螺 0.01 rad/s，角度 $10^{-4}$ rad）。真的上车时，这两个量应该来自那一篇的姿态估计，而不是 `data/` 里的随机数：Kalman 的姿态输出作为第 7 篇串级的角度反馈，它的角速度估计作为内环的陀螺。我不知道真车上这个组合的相位裕度还有多少：滤波器自己有延迟，第 3 篇的延迟裕度那一套数就是为了这一刻准备的，我下一步想做的就是把滤波器的群延迟算进去，再看内环还剩几毫秒。
