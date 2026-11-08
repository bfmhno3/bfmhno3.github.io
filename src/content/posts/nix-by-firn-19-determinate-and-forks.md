---
title: "Determinate、FlakeHub 与 Nix 的分叉们"
commentId: "post:nix-by-firn-19-determinate-and-forks"
published: "2026-11-08 22:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 19 篇：我用 Nix 2.34.9 在 NixOS 虚拟机里跑 Determinate Nix 3.24.2（基于上游 2.35.3），同一个带 512 MiB 随机文件的 path: flake，默认开着 lazy trees 时 store 增量是 0 MiB、求值中位数 107 ms，加 --no-lazy-trees 就是 512 MiB、888 ms；再把 Firn 发布到 FlakeHub，并在锁定的 nixpkgs 上对照 Lix 2.95.2。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - Determinate
  - FlakeHub
  - Lix
series: "用 Firn 从零学 Nix"
seriesOrder: 19
draft: false
comment: true
slug: nix-by-firn-19-determinate-and-forks
---

我在第 1 篇和第 8 篇各留了一句话：第 1 篇说 Nix 之外还有别的实现，等第 19 篇再逐项量；第 8 篇说上游 2.34.9 求值一个 flake 会把整份源码复制进 store，Determinate Nix 有个叫 lazy trees 的功能可以避开。这一篇兑现这两句话。先摆结果：一个 `outputs = _: { x = 1; }` 的 flake，旁边放一个 512 MiB 的随机文件，求值 `x`。上游 Nix 2.34.9 要往 store 里复制 513 MiB；Determinate Nix 3.24.2 在虚拟机里默认设置下，store 一个 MiB 都没涨，加上 `--no-lazy-trees` 才涨 512 MiB。

```text
$ nix --version
nix (Nix) 2.34.9
$ cat out/ch19/lix_version.stdout
nix (Lix, like Nix) 2.95.2
$ grep -E 'nix_version|store_delta' out/ch19/determinate_vm_host.stdout
firn: nix_version nix (Determinate Nix 3.24.2) 2.35.3
firn: lazy_trees lazy store_delta_mb 0
firn: lazy_trees no_lazy store_delta_mb 512
```

（`nix --version` 是手敲的，不在 `lab/ch19/` 里；其余两条读的是 `make ch19` 留下的输出文件）

三个二进制都叫 `nix`，只有 `--version` 的第一行能把它们分开：括号里是“谁在发行”，括号外是它基于的上游版本（Lix 是自己的 2.95 版本线，所以没有第二个数字）。这篇要回答的是：这几个 `nix` 各是什么、怎么装、差在哪里，FlakeHub 是怎样一个东西、Firn 怎么发布上去，以及 2024 年前后的那些事在官方文字里到底是怎么写的。

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch19` 里：`experiments/determinate/flake.nix`（157 行，Determinate 的 NixOS 模块放进 `runNixOSTest` 的实验）和 `experiments/determinate/flake.lock`（243 行，15 个节点），`.github/workflows/flakehub.yml`（25 行，发布到 FlakeHub），`README.md`（121 行，多一个 “FlakeHub” 小节），以及 `lab/ch19/` 下 7 个实验（没有夹具）。主 `flake.nix` 还是 376 行，没有任何 Determinate 输入。`env -u CI make ch19` 通过。
> 涉及的概念：Determinate Systems 与 Determinate Nix（下游发行版、3.x 版本号），Determinate Nix Installer（receipt、卸载、`--init none`）与社区的 `NixOS/nix-installer`，`determinate-nixd` 与 `nix.custom.conf`，lazy trees，并行求值 (`eval-cores`)，FlakeHub（语义化版本的 flake URL、tagged 与 rolling、`fh`、`flakehub-push`），FlakeHub Cache 只描述不使用，Determinate 的 GitHub Actions，Lix 与 Snix，2024 年的治理事件，以及一张“我该装哪个 Nix”的决策表。
> 前置：[第 18 篇：Home Manager：programs.cairn 与用户级配置](/posts/nix-by-firn-18-home-manager/)。这一篇用到第 16 篇的 `testers.runNixOSTest`，其余是新东西。
> 终稿与中间版本：`experiments/determinate/`、`.github/workflows/flakehub.yml` 和 `lab/ch19/` 在 `ch19` 就是终稿；`README.md` 在之后的章节里还会改。

## 环境

这一篇所有输出来自这台机器：NixOS 26.05 (Yarara)，Linux 6.18.60，`x86_64`，16 个核，30 GiB 内存，上游 Nix 2.34.9，Docker 29.9.2，`/dev/kvm` 存在。Firn 钉的 nixpkgs 还是 `56c02bc00adcf003215cc4bd996d6efaf4cff188`。Determinate 一侧的版本不是我选的，是 FlakeHub 的通配符 `*` 在我锁的那天解析出来的：

```text
$ jq -r '.nodes.determinate.original.url' experiments/determinate/flake.lock
https://flakehub.com/f/DeterminateSystems/determinate/%2A
$ jq -r '.nodes.determinate.locked | "\(.rev) \(.revCount)"' experiments/determinate/flake.lock
558e026d9d3c78351170d8f8a797fa0fac541ccf 457
$ date -u -d @"$(jq '.nodes.determinate.locked.lastModified' experiments/determinate/flake.lock)" +%FT%TZ
2026-11-05T13:30:43Z
$ jq -r '.nodes.determinate.locked.url' experiments/determinate/flake.lock
https://api.flakehub.com/f/pinned/DeterminateSystems/determinate/3.24.2/01a1abec-122b-7762-9bf3-b517e8361a53/source.tar.gz
$ jq '.nodes | length' experiments/determinate/flake.lock
15
```

（手敲，不在 `lab/ch19/` 里）

锁住的是 Determinate 的 3.24.2，`revCount` 是 457，对应的提交时间是 2026-11-05T13:30:43Z。注意 lock 里有两个 URL：`original` 是我写的通配符（`*` 在 URL 里被编码成 `%2A`），`locked` 是 FlakeHub 在那一刻把它解析成的、带版本号和一个 UUID 的固定地址。这就是 FlakeHub 能和 `flake.lock` 配合的全部机制，FlakeHub 一节会把它拆开。

另外一个数字我一开始没预料到：这个只有一个 `determinate` 输入的实验，lock 有 15 个节点，其中名字里带 nixpkgs 的有 5 个 (`nixpkgs`, `nixpkgs_2`, `nixpkgs_3`, `nixpkgs-23-11`, `nixpkgs-regression`)，只有 `nixpkgs_3` 是我钉的那份。Determinate 的 flake 自己带着一份 Nix 源码输入和几个 `determinate-nixd` 二进制，它们的依赖都进了我的 lock。主 flake 不碰这些，这也是我把实验放在 `experiments/determinate/` 里单独一个 flake 的原因。

这篇里那些 `cat`、`grep`、`cut` 读 `out/ch19/` 的命令，只是在看 `make ch19` 留下的输出文件，不是新的实验；真正在 `lab/ch19/` 之外手敲的命令，都带着 “手敲” 的标注。

## 先把名字分清：四个东西，只有一个叫 Nix

这一篇会反复出现四个名字，我先放一张表：

| 名字 | 是什么（来源在各节） | 这篇里的版本 | `--version` 第一行 |
| --- | --- | --- | --- |
| 上游 Nix (CppNix) | `NixOS/nix` | 2.34.9（这台机器） | `nix (Nix) 2.34.9` |
| Determinate Nix | Determinate Systems 的“下游发行版” | 3.24.2 | `nix (Determinate Nix 3.24.2) 2.35.3` |
| Lix | 2024-07-10 发布第一个版本，从 CppNix 2.18 分叉 | 2.95.2 | `nix (Lix, like Nix) 2.95.2` |
| Snix | 用 Rust 重新实现 Nix 的各个组件 | 没有跑 | 没有 |

版本号有一个细节：我在锁定的 nixpkgs 上问了三个 Nix 的版本，`lab/ch19/forks_versions.nix` 只有一个属性集：

```nix
{
  nix = pkgs.nix.version;
  nixVersionsLatest = pkgs.nixVersions.latest.version;
  lix = pkgs.lix.version;
}
```

（节选自 `lab/ch19/forks_versions.nix` 的 L7 到 L11，省略的是 L4 到 L6 的 `let pkgs = import ../../nix/pkgs.nix { }; in`）

```text
$ cat out/ch19/forks_versions.stdout
{ lix = "2.95.2"; nix = "2.34.8"; nixVersionsLatest = "2.35.2"; }
```

在这个 nixpkgs 上，默认的 `nix` 是 2.34.8，`nixVersions.latest` 是 2.35.2，Lix 是 2.95.2。Determinate 3.24.2 报告它基于 2.35.3，比 nixpkgs 这一份最新的上游还新一个补丁版本。Determinate 的 Nix 不在 nixpkgs 里，它来自自己的 flake，这也是为什么实验要单独加一个输入。

`lab/ch19/lix_version.sh` 把 Lix 跑起来，方式是从 store 路径直接执行，不安装：

```bash
main() {
  local out
  out="$(nix build --no-link --print-out-paths --impure --expr \
    "(import ${FIRN_ROOT}/nix/pkgs.nix { }).lix.out")"
  # ...
  "${out}/bin/nix" --version | sed -n 1p
}
```

（节选自 `lab/ch19/lix_version.sh` 的 L13 到 L19，`# ...` 省略的是一行注释）

输出就是开头那一行 `nix (Lix, like Nix) 2.95.2`。我只跑了 `--version`，没有用 Lix 做别的事，所以 Lix 和上游在行为上的差异，这一篇没有一条是我测的。

## Determinate Systems 是谁，Determinate Nix 又是什么

先说人和公司，只写我读到的原文。Determinate Systems 的[关于页面](https://determinate.systems/about/)（2026-11 读）写着公司由 Eelco Dolstra（Nix 的作者）和 Graham Christensen 创立，Graham 是 CTO，页面还说 Eelco 同时是 Nix 团队的成员。公司发文介绍自己的[那篇文章](https://determinate.systems/blog/we-want-to-make-nix-better/)是 2022-09-02 发的，它的摘要 (meta description) 写着 “Introducing Determinate Systems, a company devoted to bringing the immense benefits of Nix to the software world”，我只能说这是我找得到的最早的官方文字，不知道公司成立的确切日期。

Determinate Nix 是什么，官方[文档](https://docs.determinate.systems/determinate-nix/)（2026-11 读）的说法是：“Determinate Systems’ validated and secure downstream distribution of NixOS/nix designed for enterprise use cases”，“fully compatible with and includes everything in upstream Nix, while adding a range of special features on top”。2025-03-05 的 [Determinate Nix 3.0 公告](https://determinate.systems/blog/determinate-nix-30/)的小标题是 “Not a fork, a future-proof foundation”，正文先说 “Determinate Nix 3.0 isn’t a fork of Nix”，接着说它是 “a downstream distribution”。这几句我原样引用，是因为“分叉”这个词在本篇的治理一节里会有不同的用法，Determinate 自己选了另一个词。

版本号 3 不是随便取的。同一篇公告写着：“The Nix project has long intended to release version 3.0 when flakes are stable. With Determinate Nix 3.0, we’ve fulfilled that promise by offering a formal stability guarantee for flakes”。所以 3.x 是 Determinate 自己的版本线，和上游的 2.x 不是一回事，`nix --version` 的两个数字就是这样来的：括号里的 `3.24.2` 是 Determinate 的发行版本，括号外的 `2.35.3` 是它基于的上游版本（我是拿公告里的示例 `nix (Determinate Nix 3.0.0) 2.26.3` 和实际输出对照出来的，文档没有逐字解释这两个数字）。

文档列出的“在上游之上加的功能”分成性能、开发体验、可观测性、安全、以及 “Serving and exporting store paths” 五类。这一篇我会量其中的两个：lazy trees 和并行求值。另一个我会看的是 `determinate-nixd`，因为它决定了 `/etc/nix/nix.conf` 是谁写的。

## 安装器：receipt、卸载和 `--init none`

Nix 本身怎么装，第 1 篇列过三条路，这里把后两条拆开。我没有在这台 NixOS 上跑任何一个安装器（NixOS 不需要，而且我不想让它改 `/nix`），这一节写的安装器行为都来自它们的 README（2026-11 读），唯一一次真跑是练习 1 里放在 Docker 容器里的那次。

[Determinate Nix Installer](https://github.com/DeterminateSystems/nix-installer) 的一行命令是 `curl -fsSL https://install.determinate.systems/nix | sh -s -- install`，默认装的是 Determinate Nix，README 说它也能装上游 Nix (`--prefer-upstream-nix`)，但“Not a supported configuration”，并且 “we may remove it in a future release”。它做事的方式是“规划器” (planner) 先产出一份计划，再按计划逐个动作执行，所以在真的动手之前可以 `--explain` 看它要改什么。几个我觉得值得知道的点：

- 安装收据 (receipt)：README 写着 “an installation receipt (for uninstalling) is stored at `/nix/receipt.json` as well as a copy of the install binary at `/nix/nix-installer`”。卸载就是 `/nix/nix-installer uninstall`，默认读的就是这份收据。
- `--init none`：没有 systemd 的环境（Docker 容器、没开 systemd 的 WSL2、GitLab 的 Docker runner）要加这个选项，README 的警告是 “When `--init none` is used, only `root` or users who can elevate to `root` privileges can run Nix”。也就是说，装完之后只有 root（或者能提权成 root 的用户）能用 Nix。
- 默认写进 `nix.conf` 的东西：`nix-command` 和 `flakes` 两个特性、`always-allow-substitutes = true`、`max-jobs = auto`、`extra-nix-path = nixpkgs=flake:nixpkgs` 等，完整的列表在 README 的 “Installation differences” 一节。

社区这边另有一个 [`NixOS/nix-installer`](https://github.com/NixOS/nix-installer)。它的 README（2026-11 读）开头写着 “This is the official Nix installer maintained by the NixOS community. It is different from the Determinate Nix Installer and the `nixos.org/nix/install` shell script bundled with Nix”，标题下是 `Status: Beta`，还有一条提示说这个仓库正在改成并入 Nix 自己的发布流程，产物位置可能变。仓库的描述是 “NG installer for Nix, forked from DetSys/nix-installer”，命令是 `curl -sSfL https://artifacts.nixos.org/nix-installer | sh -s -- install`，要开 flakes 得另加 `--enable-flakes`。Determinate 的 README 里提到过 Nix Installer Working Group 维护着一个“foundation-owned fork”，链接指向 `nixos/experimental-nix-installer`；GitHub 把这个地址重定向到 `NixOS/nix-installer`，两者的仓库 ID 都是 639002175，也就是同一个仓库。什么时候改的名，我没有查。

两个安装器的接口很像（都是 planner、`--init none`、`/nix/nix-installer uninstall`），区别在默认值：前者默认装 Determinate Nix 并默认开 flakes，后者装上游并要你显式开。至于哪个“更好”，我没有数据，决策表那一节我会写我自己会怎么选。

## 把 Determinate 放进一台虚拟机

要看 Determinate Nix 的行为，最干净的办法是给它一台自己的机器。我不想在这台 NixOS 上换掉系统的 Nix（见决策表那一节），第 16 篇又刚好教过 `runNixOSTest`，所以实验是一个独立的 flake：`experiments/determinate/flake.nix`，把 Determinate 的 NixOS 模块放进一台测试虚拟机，让测试脚本读出版本、配置文件、systemd 单元，再量两个性能功能。

先是输入和 `nixConfig`：

```nix
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188";
    determinate.url = "https://flakehub.com/f/DeterminateSystems/determinate/*";
  };

  nixConfig = {
    extra-substituters = [ "https://install.determinate.systems" ];
    extra-trusted-public-keys = [
      "cache.flakehub.com-3:hJuILl5sVK4iKm86JzgdXW12Y2Hwd5G07qKtHTOcDCM="
    ];
  };
```

（节选自 `experiments/determinate/flake.nix` 的 L8 到 L18）

`nixpkgs` 是 Firn 一直钉着的那个提交；`determinate` 是 FlakeHub 上的 `DeterminateSystems/determinate`，版本要求是通配符 `*`，也就是“当前最新”，具体是哪一个由 `flake.lock` 记下来。`nixConfig` 里的两行是 Determinate 文档给的：不加这个缓存，Nix 会想自己从源码构建 Determinate Nix，文档的说法是这两个选项让你 “don’t have to build Determinate Nix yourself”。

问题是 `nixConfig` 里的这两项默认不被信任，Nix 只会警告然后忽略。`make ch19` 里真实的 stderr 是这样的：

```text
$ cat out/ch19/determinate_vm_host.stderr
warning: ignoring untrusted flake configuration setting 'extra-substituters'.
Pass '--accept-flake-config' to trust it
warning: ignoring untrusted flake configuration setting 'extra-trusted-public-keys'.
Pass '--accept-flake-config' to trust it
```

所以 `lab/ch19/determinate_vm_host.sh` 不依赖 `nixConfig`，而是把同样的两个选项直接放在命令行上，这也是 Determinate 文档里 `nixos-rebuild` 那条命令的写法：

```bash
readonly FLAKE="${FIRN_ROOT}/experiments/determinate"
readonly ATTR="${FLAKE}#checks.x86_64-linux.determinate-vm"
readonly LOG="${LAB_TMP}/vm-test.log"
readonly -a OPTIONS=(
  --option extra-substituters https://install.determinate.systems
  --option extra-trusted-public-keys
  cache.flakehub.com-3:hJuILl5sVK4iKm86JzgdXW12Y2Hwd5G07qKtHTOcDCM=
)
```

（节选自 `lab/ch19/determinate_vm_host.sh` 的 L18 到 L25）

我留着 `nixConfig` 没删，是因为它写明了“这个 flake 想要这个缓存”，别人用 `--accept-flake-config` 就能直接采用；脚本自己不能依赖它，因为我没有让 `make ch19` 去接受一个 flake 提出的配置。

测试本身是一个 `runNixOSTest`，节点里只有一行 `imports`：

```nix
      checks.x86_64-linux.determinate-vm = pkgs.testers.runNixOSTest {
        name = "determinate";

        nodes.machine =
          { pkgs, ... }:
          {
            imports = [ determinate.nixosModules.default ];

            virtualisation = {
              diskSize = 8192;
              memorySize = 4096;
              cores = 4;
              # 虚拟机里没有网络，<nixpkgs/nixos> 要的源码得自带。
              additionalPaths = [ pkgs.path ];
            };
            nix.nixPath = [ "nixpkgs=${pkgs.path}" ];
          };
```

（节选自 `experiments/determinate/flake.nix` 的 L41 到 L57）

没有写 `determinate.enable = true`，因为模块里 `enable` 的默认值就是 `true`（模块源码 L56 到 L58，下一小节会引用这个文件）。`virtualisation` 的三个数字是为之后的测量留的：虚拟机 4 个核、4096 MiB 内存，磁盘 8192 MiB。磁盘要这么大，是因为惰性树的测量要在虚拟机里放 11 份 512 MiB 的目录（1 份原件加 2 组各 5 份拷贝，共 5632 MiB），再加上非惰性模式往 store 里写的 512 MiB，一共约 6144 MiB；这是我算的，不是量的。`additionalPaths = [ pkgs.path ]` 加上 `nix.nixPath` 是因为测试虚拟机里没有网络：要让 `<nixpkgs/nixos>` 能用，nixpkgs 源码得随虚拟机一起带进去，等一下并行求值的测量要用它。

## `nix.conf` 是谁写的：虚拟机里的第一手观察

测试脚本先读版本，再读配置文件。有一个细节我一开始没想到：`/etc/nix/nix.conf` 在虚拟机刚起来的时候并不存在。脚本里的相关部分（Python，已按 Nix 的 `''` 字符串规则去掉公共缩进）：

```python
def key_lines(path):
    text = machine.succeed(f"grep -v '^#' {path} | grep .")
    for line in text.splitlines():
        yield line if len(line) <= 90 else line[:87] + "..."


machine.wait_for_unit("multi-user.target")

report("nix_version", machine.succeed("nix --version").strip())

# Both sockets are up, but determinate-nixd, which writes
# /etc/nix/nix.conf, only starts on the first connection.
status, _ = machine.execute("test -e /etc/nix/nix.conf")
report("nix.conf first", "absent" if status else "present")
machine.succeed("nix store info --store daemon")
machine.wait_for_unit("nix-daemon.service")
for path in ("/etc/nix/nix.conf", "/etc/nix/nix.custom.conf"):
    for line in key_lines(path):
        report(path, line)
```

（节选自 `experiments/determinate/flake.nix` 的 L82 到 L100）

`machine.execute("test -e /etc/nix/nix.conf")` 先问一次文件在不在，然后 `nix store info --store daemon` 连一下守护进程，再读两个文件的非注释行。脚本里那句英文注释是实验开始前的假设，我用输出和模块源码把它验过一遍。输出里的几行：

```text
$ grep -E '^firn: (nix_version|nix.conf first|nix-daemon|determinate-nixd|default)' out/ch19/determinate_vm_host.stdout
firn: nix_version nix (Determinate Nix 3.24.2) 2.35.3
firn: nix.conf first absent
firn: nix-daemon.service ExecStart { path=/nix/store/zwp0jizbh6i4qmdd5vhj0an7bz4b2h0v-determinate-nixd-3.24.2/bin/determinate-nixd
firn: determinate-nixd.socket active
firn: nix-daemon.socket active
firn: nix-daemon.service active
firn: default lazy-trees true
firn: default eval-cores 0
```

`nix.conf first absent`：连守护进程之前，文件不存在。接着，`nix-daemon.service` 的 `ExecStart` 指向的是 `determinate-nixd`（路径里是 `determinate-nixd-3.24.2`），而不是上游的 `nix daemon`。两个套接字单元都是 `active`。这些都是模块配出来的，源码在 FlakeHub 上那个提交对应的 [`modules/nixos.nix`](https://github.com/DeterminateSystems/determinate/blob/558e026d9d3c78351170d8f8a797fa0fac541ccf/modules/nixos.nix)，我读的是这几处：

```nix
    # NOTE(cole-h): Move the generated nix.conf to /etc/nix/nix.custom.conf, which is included from
    # the Determinate Nixd-managed /etc/nix/nix.conf.
    environment.etc."nix/nix.conf".target = "nix/nix.custom.conf";
```

（节选自 `DeterminateSystems/determinate` 的 `modules/nixos.nix` 的 L75 到 L77，提交 `558e026d9d3c78351170d8f8a797fa0fac541ccf`）

```nix
      services.nix-daemon.serviceConfig = {
        ExecStart = [
          ""
          "@${
            inputs.self.packages.${pkgs.stdenv.system}.default
          }/bin/determinate-nixd determinate-nixd --nix-bin ${config.nix.package}/bin daemon"
        ];
```

（节选自同一个文件的 L86 到 L92）

```nix
        determinate-nixd = {
          description = "Determinate Nixd Daemon Socket";
          wantedBy = [ "sockets.target" ];
          before = [ "multi-user.target" ];
          # ...
          socketConfig = {
            Service = "nix-daemon.service";
            FileDescriptorName = "determinate-nixd.socket";
            ListenStream = "/nix/var/determinate/determinate-nixd.socket";
            DirectoryMode = "0755";
          };
        };
```

（节选自同一个文件的 L102 到 L120，`# ...` 省略的是 L106 到 L113 的空行和 `unitConfig`）

这三段合起来就是整个机制：

- 第 1 篇讲过 NixOS 的 `nix.settings` 渲染成 `/etc/nix/nix.conf`。Determinate 的模块没有改渲染的内容，只把这个文件的目标路径改成 `nix/nix.custom.conf`。所以 NixOS 生成的配置原样保留，只是挪了位置，`/etc/nix/nix.conf` 这个名字空了出来。
- `ExecStart` 先写一个空字符串，这是 systemd 的惯例：给列表型选项赋空字符串会清掉此前累积的值（包括 NixOS 原来的 `nix daemon`），再写新的一项，开头的 `@` 表示路径之后的第一个词是 `argv[0]`。所以守护进程的命令行是 `determinate-nixd --nix-bin <nix 的 bin 目录> daemon`，它自己再去调用 Nix。
- 额外的套接字单元 `determinate-nixd.socket` 监听 `/nix/var/determinate/determinate-nixd.socket`，它和 NixOS 本来就有的 `nix-daemon.socket` 一样，激活的都是 `nix-daemon.service` (`Service = "nix-daemon.service"`)。
- 套接字激活的意思是：服务要等有人连上来才起。脚本的注释说虚拟机启动完成的时候两个套接字都已经在监听、服务还没起（我只在连接之后查过它们的状态），所以我第一次读 `nix.conf` 时它不存在；连一次 `--store daemon` 之后，服务起来，文件出现。我猜是 `determinate-nixd` 启动时写的（文档对安装器路径写着 “the installer writes a `nix.conf` configuration file to `/etc/nix/nix.conf`”，对 NixOS 这条路径没有逐字说），但我观察到的只有顺序：连之前不存在，连之后存在。

读出来的两个文件，先看 Determinate 管的 `nix.conf`（13 行，原样输出，长的行被测试脚本截到 90 个字符）：

```text
$ grep -F 'firn: /etc/nix/nix.conf ' out/ch19/determinate_vm_host.stdout
firn: /etc/nix/nix.conf always-allow-substitutes = true
firn: /etc/nix/nix.conf bash-prompt-prefix = (nix:$name)\040
firn: /etc/nix/nix.conf eval-cores = 0
firn: /etc/nix/nix.conf extra-nix-path = nixpkgs=flake:https://flakehub.com/f/DeterminateSystems/nixpkgs-weekly...
firn: /etc/nix/nix.conf max-jobs = auto
firn: /etc/nix/nix.conf lazy-trees = true
firn: /etc/nix/nix.conf !include nix.custom.conf
firn: /etc/nix/nix.conf extra-experimental-features = nix-command flakes
firn: /etc/nix/nix.conf netrc-file = /nix/var/determinate/netrc
firn: /etc/nix/nix.conf extra-substituters = https://install.determinate.systems/
firn: /etc/nix/nix.conf extra-trusted-substituters = https://cache.flakehub.com/ https://install.determinate.sy...
firn: /etc/nix/nix.conf extra-trusted-public-keys = cache.flakehub.com-3:hJuILl5sVK4iKm86JzgdXW12Y2Hwd5G07qKtHT...
firn: /etc/nix/nix.conf upgrade-nix-store-path-url = https://install.determinate.systems/determinate-nix/stable...
```

然后是 NixOS 生成、被挪过去的 `nix.custom.conf`（14 行）：

```text
$ grep -F 'firn: /etc/nix/nix.custom.conf ' out/ch19/determinate_vm_host.stdout
firn: /etc/nix/nix.custom.conf allowed-users = *
firn: /etc/nix/nix.custom.conf auto-optimise-store = false
firn: /etc/nix/nix.custom.conf builders =
firn: /etc/nix/nix.custom.conf cores = 0
firn: /etc/nix/nix.custom.conf max-jobs = auto
firn: /etc/nix/nix.custom.conf require-sigs = true
firn: /etc/nix/nix.custom.conf sandbox = true
firn: /etc/nix/nix.custom.conf sandbox-fallback = false
firn: /etc/nix/nix.custom.conf substituters = https://cache.nixos.org/
firn: /etc/nix/nix.custom.conf system-features = nixos-test benchmark big-parallel kvm
firn: /etc/nix/nix.custom.conf trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=
firn: /etc/nix/nix.custom.conf trusted-substituters =
firn: /etc/nix/nix.custom.conf trusted-users = root
firn: /etc/nix/nix.custom.conf extra-sandbox-paths =
```

几件我觉得有意思的事：

- 第 1 篇我读本机的 `nix.conf` 时说过它是 NixOS 的 `nix.settings` 生成的。这里的 `nix.custom.conf` 就是同一类文件：`sandbox = true`、`trusted-users = root`、`system-features` 里的 `nixos-test` 和 `kvm`（`runNixOSTest` 要的）都是 NixOS 的默认值，一个字没改。区别只是它现在是被 `!include nix.custom.conf` 拉进来的。Determinate 的文档（2026-11 读）对此的规则是：不要改 `nix.conf` 里它生成的值，`nix.custom.conf` “is the only supported way” 提供自定义配置。在 NixOS 上你继续写 `nix.settings`，模块替你写这个文件。
- `lazy-trees = true` 和 `eval-cores = 0` 都写在 Determinate 管的文件里；至少 `eval-cores` 不是二进制自己的默认值（二进制的默认是 1，并行求值一节里有输出）。后两行 `default lazy-trees true`、`default eval-cores 0` 是 `nix config show` 读出来的当前生效值，确认它们真的生效了。
- 管理文件里的 `extra-experimental-features = nix-command flakes` 还在。文档说 Determinate Nix 有 “Stable flakes and a stable `nix` CLI, with no experimental features to enable”，所以我原以为这一行不会出现。我的理解是：稳定性保证是 Determinate 对你的承诺，用户不用自己写这一行，但文件里仍然列着两个名字；我没有测去掉它会怎样，这只是对输出的解读。
- 管理文件里已经有 `extra-substituters = https://install.determinate.systems/`，也就是说，第一次构建时我得靠命令行选项才能从这个缓存下载 Determinate Nix，装好之后它自己就把这个缓存配好了；和 Determinate 文档里 “Once you’re on Determinate Nix version 3.6.0 or later, however, you don’t need to configure any extra substituters to upgrade” 一致。

## 惰性树：512 MiB 的 `x = 1`

第 8 篇留下的问题是：`nix eval path:...` 求值一个 flake，上游 Nix 会把整个目录复制进 store，不管表达式用到了其中的几个文件。Determinate 文档（2026-11 读）对 lazy trees 的说法是 “With lazy trees enabled, Nix scopes file copying to what the specific expression demands”，做法是用一个虚拟文件系统先收集需要的文件状态，再复制，把惰性的源输入 “mounting” 到 `/nix/store/<random-hash>` 这样的虚拟路径上。它自 Determinate Nix 3.5.2 起可用，文档说现在是 stable 并且对所有用户默认开启；单次命令可以用 `--no-lazy-trees` 关掉。

打个比方：上游的行为是把整本书复印一遍再开始读，惰性树是读到哪页复印哪页。（这是这篇里我唯一的比方，之后只用数字。）

我要的实验尽量极端：一个目录，里面有 `flake.nix` (`outputs = _: { x = 1; }`) 和一个 512 MiB 的随机文件 `blob.bin`。求值 `x` 根本用不着 `blob.bin`。脚本在虚拟机里放好这个目录，然后分别用默认设置和 `--no-lazy-trees` 求值，每种 5 次，每次都对一份新的拷贝求值：

```python
# Lazy trees: a flake whose only output is 1, next to a 512 MiB blob.
machine.succeed("mkdir /root/big")
machine.succeed(
    "echo '{ outputs = _: { x = 1; }; }' > /root/big/flake.nix"
)
machine.succeed(
    "dd if=/dev/urandom of=/root/big/blob.bin bs=1M count=512 "
    "status=none"
)

for label, flag in (("lazy", ""), ("no_lazy", "--no-lazy-trees")):
    times = []
    delta = None
    for i in range(RUNS):
        # Every run evaluates a fresh copy of the directory. The
        # store grows on the first run only: later copies have the
        # same content, hence the same store path.
        copy = f"/root/big-{label}-{i}"
        machine.succeed(f"cp -r /root/big {copy}")
        before = store_mb() if i == 0 else None
        times.append(wall_ms(f"nix eval {flag} path:{copy}#x"))
        if i == 0:
            delta = store_mb() - before
    report(f"lazy_trees {label} first_ms", times[0])
    report(f"lazy_trees {label} median_ms", statistics.median(times))
    report(f"lazy_trees {label} store_delta_mb", delta)
```

（节选自 `experiments/determinate/flake.nix` 的 L116 到 L141，已去掉公共缩进）

两个测量的口径要说清楚。时间是 `nix eval` 这一条命令的墙钟毫秒（`wall_ms` 在虚拟机里用 `date +%s%3N` 前后各取一次），报告首次和 5 次的中位数；store 增量只在第一次测，是 `du -sm /nix/store` 前后的差，因为之后的拷贝内容相同，对应同一个 store 路径，不会再增长。`volatile:` 前缀是 `determinate_vm_host.sh` 加的：带 `_ms` 的行是计时，每次都不一样，不能当成不变量；store 增量是不变量。结果：

```text
$ grep -E 'lazy_trees' out/ch19/determinate_vm_host.stdout
volatile: firn: lazy_trees lazy first_ms 136
volatile: firn: lazy_trees lazy median_ms 107
firn: lazy_trees lazy store_delta_mb 0
volatile: firn: lazy_trees no_lazy first_ms 846
volatile: firn: lazy_trees no_lazy median_ms 888
firn: lazy_trees no_lazy store_delta_mb 512
```

默认（惰性）：中位数 107 ms，store 增量 0 MiB。`--no-lazy-trees`：中位数 888 ms，store 增量 512 MiB。同一台虚拟机里差 8.3 倍，store 多了整整一份 512 MiB（这个目录是我专门挑的最坏情况，8.3 倍别当成成绩单）。我跑了两次 `make ch19`，另一次的数字是惰性 106 ms、非惰性 975 ms（9.2 倍），store 增量同样是 0 和 512，所以时间的量级稳，个位数毫秒不稳。

对照组是上游。`lab/ch19/upstream_baseline_host.sh` 在宿主机上用 Nix 2.34.9 做同一件事：同样的 `flake.nix` 加 512 MiB 的 `blob.bin`，每次对一份新拷贝求值 `x`，最后用 `nix flake metadata` 找出 Nix 复制出来的源路径，量大小，再 `nix store delete` 删掉它：

```bash
  local big="${LAB_TMP}/big"
  mkdir "${big}"
  echo '{ outputs = _: { x = 1; }; }' >"${big}/flake.nix"
  dd if=/dev/urandom of="${big}/blob.bin" bs=1M count=512 status=none

  local -a times=()
  local i copy
  for ((i = 0; i < RUNS; i++)); do
    copy="${LAB_TMP}/big-${i}"
    cp -r "${big}" "${copy}"
    times+=("$(time_ms nix eval "path:${copy}#x")")
  done
  echo "volatile: first eval: ${times[0]} ms"
  echo "volatile: median of ${RUNS}: $(printf '%s\n' "${times[@]}" | median) ms"
```

（节选自 `lab/ch19/upstream_baseline_host.sh` 的 L51 到 L64）

```bash
  local store_path
  store_path="$(nix flake metadata --json "path:${LAB_TMP}/big-0" \
    | jq --raw-output '.path')" || {
    # ...
  }
  # ...
  echo "source path size: $(du --summarize --block-size=1M "${store_path}" \
    | cut -f1) MiB"
  nix store delete "${store_path}"
  # ...
  echo "store path deleted"
```

（节选自同一个文件的 L68 到 L85，`# ...` 省略的是出错分支和对路径前缀、删除结果的检查）

```text
$ cat out/ch19/upstream_baseline_host.stdout
nix: nix (Nix) 2.34.9
volatile: first eval: 569 ms
volatile: median of 5: 592 ms
source path size: 513 MiB
1 store paths deleted, 512.0 MiB freed
store path deleted
```

我把三个数字并排放：

| 配置 | 首次 | 中位数 | store 里多出来的 |
| --- | --- | --- | --- |
| Determinate 3.24.2，默认 (lazy trees) | 136 ms | 107 ms | 0 MiB |
| 同一台虚拟机，`--no-lazy-trees` | 846 ms | 888 ms | 512 MiB |
| 上游 2.34.9，宿主机 | 569 ms | 592 ms | 513 MiB（`du` 量的单个源路径） |

这张表有两处不能乱比。一是上游那一行在宿主机上跑，Determinate 两行在虚拟机里跑，环境不同，所以真正干净的对照是同一台虚拟机里的两行；第三行只证明一件事：上游 2.34.9 确实把 513 MiB 复制进了 store（`nix store delete` 释放了 512.0 MiB，和虚拟机里非惰性那行的 512 MiB 一致）。二是 512 和 513 量的不是同一个东西：前者是整个 `/nix/store` 的增量，后者是那一个路径的大小，`du` 按 MiB 向上取整，我没有追究那 1 MiB。

还有一个我没预料到的细节：非惰性那一行，首次 846 ms 和中位数 888 ms 几乎一样，上游宿主机也是 569 对 592。首次是唯一往 store 里写 512 MiB 的一次，其余 4 次内容相同，路径已经在 store 里，不用再写。这大概说明那 800 多毫秒的大头不是写，而是把 512 MiB 读一遍、算哈希，好确定路径是哪个。惰性树省掉的正是这一步，因为 `blob.bin` 压根没被表达式碰过。这是我读数字得出的猜测，没有用 `strace` 或 `perf` 证实。

文档自己的说法是在 Nixpkgs 仓库里求值，“we’ve frequently seen reductions in wall time of 3x or more and reductions in disk usage of 20x or more”，我的是人为造出来的极端例子：目录里最大的文件恰好一个字节都不读。真实的 flake 把 `src = ./.` 交给一个 derivation 时，构建仍然需要整个目录，所以别把 8 倍当成你项目的数字。我也没有测过惰性树在需要真实路径的场景里怎么处理，文档说用的是虚拟路径，我没有验证需要真实路径时会发生什么。

## 并行求值：`eval-cores`

第二个性能功能是并行求值。Determinate 文档（2026-11 读）的说法是 “For most of its history, Nix has been a single-threaded tool across all of its operations”，Determinate Nix 自 3.11.1 起能把求值分到多个核上。设置的名字我是从 3.11.1 的[更新日志](https://determinate.systems/blog/changelog-determinate-nix-3111/)里读到的：“set `eval-cores` to 0 in your `/etc/nix/nix.custom.conf`”，注释写着 “Evaluate across all cores”。虚拟机里 `nix.conf` 的 `eval-cores = 0`，和 `nix config show` 读出的默认值 `0`，在虚拟机那一节的输出里都出现过了。

这个设置到底影响哪些命令，更新日志和文档页都列了一个清单。我更信二进制自己的描述，所以把虚拟机用的那个 Determinate Nix 直接从 store 里拿出来问它（这个路径是 `determinate` 输入的 `nix` 输入的默认包，虚拟机测试构建的时候已经在 store 里了）：

```text
$ N="$(nix eval --raw --impure --expr '(builtins.getFlake (toString ./experiments/determinate)).inputs.determinate.inputs.nix.packages.x86_64-linux.default.outPath')"
$ echo "$N"
/nix/store/p4nj9nkdd1rkj1bymh99wqdp857rnhy8-determinate-nix-3.24.2
$ "$N/bin/nix" config show --json | jq -r '."eval-cores" | .description, .defaultValue'
The number of threads used to evaluate Nix expressions. This currently affects the following commands:

* `nix search`
* `nix flake check`
* `nix flake show`
* `nix eval --json`
* Any evaluation that uses `builtins.parallel`

The value `0` causes Nix to use all available CPU cores in the system.

Note that enabling the debugger (`--debugger`) disables multi-threaded evaluation.


1
```

（手敲，不在 `lab/ch19/` 里）

两点：二进制里的默认值是 `1`（单线程），是 Determinate 管的 `nix.conf` 把它改成了 `0`；受影响的命令是个清单，里面有 `nix eval --json`，没有 `nix eval --raw`。

实验里的对照是 `--eval-cores 1`（关，也就是二进制的默认）对 `--eval-cores 0`（开，所有核）。被求值的是一个最小的 NixOS 的 `toplevel.drvPath`。最小是因为 `configuration = { }` 过不了断言，我拿 nixpkgs 钉住的版本试过：

```text
$ P=$(nix eval --raw --impure --expr '(import ./nix/pkgs.nix { }).path')
$ NIX_PATH=nixpkgs=$P nix-instantiate --eval --expr '(import <nixpkgs/nixos> { configuration = { }; }).config.system.build.toplevel.drvPath' 2>&1 | grep -A2 'Failed assertions'
       Failed assertions:
       - The ‘fileSystems’ option does not specify your root file system.
       - You must set the option ‘boot.loader.grub.devices’ or 'boot.loader.grub.mirroredBoots' to make the system bootable.
```

（手敲，不在 `lab/ch19/` 里）

所以实验里那段表达式补上了根文件系统、关掉 GRUB、写上 `stateVersion`：

```nix
      # 一个能求值的最小 NixOS：configuration = { } 会因为缺根文件系统和引导
      # 加载器的断言失败。
      minimalOs = pkgs.writeText "minimal-os.nix" ''
        (import <nixpkgs/nixos> {
          configuration = {
            boot.loader.grub.enable = false;
            fileSystems."/" = {
              device = "none";
              fsType = "tmpfs";
            };
            system.stateVersion = "26.05";
          };
        }).config.system.build.toplevel.drvPath
      '';
```

（节选自 `experiments/determinate/flake.nix` 的 L25 到 L38）

测试脚本对 `off` 和 `on` 各量 5 次：

```python
# Parallel evaluation: eval-cores 1 is off, 0 uses every core.
for label, cores in (("off", 1), ("on", 0)):
    times = [
        wall_ms(
            f"nix eval --raw --eval-cores {cores} "
            "--file ${minimalOs}"
        )
        for _ in range(RUNS)
    ]
    report(f"parallel_eval {label} first_ms", times[0])
    report(f"parallel_eval {label} median_ms", statistics.median(times))
```

（节选自同一个文件的 L143 到 L153，已去掉公共缩进；`${minimalOs}` 是 Nix 在构建测试脚本时插进去的文件路径）

```text
$ grep parallel_eval out/ch19/determinate_vm_host.stdout
volatile: firn: parallel_eval off first_ms 12670
volatile: firn: parallel_eval off median_ms 9402
volatile: firn: parallel_eval on first_ms 8292
volatile: firn: parallel_eval on median_ms 8309
```

关：中位数 9402 ms，开：8309 ms，快了 1093 ms，也就是 11.6%。另一次运行是 9490 对 8360，快 11.9%。这是个很小的收益。文档说 “5x or more”，原文是 “in some scenarios”，3.11.1 更新日志里的例子是 `nix search` 快 2.5 倍、`nix flake check` 快 3.7 倍，我这个实验离它们都远。

先说什么不能读：首次那两个数字（12670 和 8292）不能比。脚本先量 `off`，再量 `on`，我猜第一次求值要把 nixpkgs 读进文件缓存，这笔成本记在了 `off` 的头上（没有验证）。5 次的中位数缓和了这个顺序效应，但没有消除它，所以 11.6% 不是一个干净的比值。

再说为什么小。二进制的描述列出的命令里没有 `nix eval --raw`，而我的表达式求出来是一个字符串，`toplevel.drvPath` 背后是一条很长的依赖链，没有几块互不相干的活可以同时做。我猜这是收益小的主要原因：这个实验量的是“一条链”，而不是并行求值擅长的东西。但我没有证明这一点，11.6% 里有多少来自并行、多少来自噪声，我也不知道。

要证明，就得换一个并行求值该有用的场景：同一个 `nix eval --json` 里有几块互相独立的活。我在宿主机上拿同一个 Determinate Nix 二进制，把 4 台只有主机名不同的最小 NixOS 放进一个属性集，用 `--json` 求值（这个文件过了 `nixfmt --check`，不在 `lab/ch19/` 里）：

```nix
let
  mk =
    name:
    (import <nixpkgs/nixos> {
      configuration = {
        boot.loader.grub.enable = false;
        fileSystems."/" = {
          device = "none";
          fsType = "tmpfs";
        };
        system.stateVersion = "26.05";
        networking.hostName = name;
      };
    }).config.system.build.toplevel.drvPath;
in
{
  a = mk "a";
  b = mk "b";
  c = mk "c";
  d = mk "d";
}
```

（手敲，不在 `lab/ch19/` 里；`/tmp/scratch19/four_hosts.nix`）

```text
$ NIX_PATH="nixpkgs=$P"; export NIX_PATH
$ hyperfine -w 1 -r 5 -N -L cores 1,0 "$N/bin/nix eval --json --eval-cores {cores} --file /tmp/scratch19/four_hosts.nix" --export-json /tmp/scratch19/hf.json | grep Time
  Time (mean ± σ):      9.655 s ±  0.082 s    [User: 7.909 s, System: 1.712 s]
  Time (mean ± σ):      3.733 s ±  0.118 s    [User: 12.180 s, System: 2.592 s]
$ jq -r '.results[] | "eval-cores \(.parameters.cores): median \(.median * 1000 | round) ms, mean \(.mean * 1000 | round) ms"' /tmp/scratch19/hf.json
eval-cores 1: median 9609 ms, mean 9655 ms
eval-cores 0: median 3699 ms, mean 3733 ms
```

（手敲，不在 `lab/ch19/` 里；`hyperfine` 1.20.0，16 个核的宿主机，不是虚拟机）

同一个二进制，4 个互相独立的求值，墙钟从 9655 ms 掉到 3733 ms，2.59 倍；`User` 时间从 7.9 秒涨到 12.2 秒，也就是说并行不是白来的，总的 CPU 时间多花了大约 54%，换来了更短的等待。4 台机器在 16 个核上没有拿到 4 倍而是 2.59 倍，我猜是因为 `nixpkgs` 本身的求值和属性集的收尾是共享、串行的部分，这同样是猜测。

这一节的结论就是：`eval-cores = 0` 在列出的命令和合适的表达式上能明显省时间（4 台机器的例子是 2.59 倍），在 `nix eval --raw` 一条依赖链上几乎没有（11.6%，而且不干净）。我没有测 `nix flake check`、`nix search`、`builtins.parallel`，也没有测 `--debugger` 关掉多线程这一条。

## FlakeHub：把版本号写进 URL

FlakeHub 是 Determinate Systems 做的 flake 注册表（installer 的 README 脚注把它列在公司做过的产品里）。我先只讲它的 URL，因为所有别的东西都挂在 URL 上。形式是 `https://flakehub.com/f/<组织>/<项目>/<版本要求>`，版本要求是[官方文档](https://docs.determinate.systems/flakehub/concepts/semver/)（2026-11 读）说的 “a subset of Semantic Versioning”：

- `=0.1.15` 精确匹配，版本不存在就失败。
- `*` 通配：单独一个 `*` 是已发布的最高版本，`1.*` 是主版本 1 的最高版本，`1.2.*` 是 1.2 的最高补丁。
- 发布方式分两种：tagged（作者自己的 SemVer，例子是 `fh` 自己）和 rolling（主版本 0，次版本 1，补丁号是该分支上的提交数）。rolling 的版本形如 `0.1.<提交数>+rev-<sha>`，`flakehub-push` 的 README 给的例子是 `0.1.1924+rev-ebfe2c639111d7e82972a12711206afaeeda2450`；README 说默认的次版本是 1，`rolling-major` 和 `rolling-minor` 可以改。

这个注册表不需要 Nix 懂 FlakeHub：它就是一个会重定向的 HTTP 服务，Nix 把它当普通的 tarball 输入处理。我把前两跳重定向手工看了一遍：

```text
$ curl -sI 'https://flakehub.com/f/DeterminateSystems/determinate/*' | grep -iE '^(HTTP|location)'
HTTP/2 301
location: https://api.flakehub.com/f/DeterminateSystems/determinate/*
$ curl -sI 'https://api.flakehub.com/f/DeterminateSystems/determinate/*' | grep -iE '^(HTTP|location)'
HTTP/2 307
location: https://api.flakehub.com/f/pinned/DeterminateSystems/determinate/3.24.2/01a1abec-122b-7762-9bf3-b517e8361a53/source.tar.gz
$ nix flake metadata --json 'https://flakehub.com/f/DeterminateSystems/determinate/3.24.2' 2>/dev/null | jq -c '{resolvedUrl, lockedUrl: .locked.url, rev: .locked.rev, revCount: .locked.revCount}'
{"resolvedUrl":"https://flakehub.com/f/DeterminateSystems/determinate/3.24.2","lockedUrl":"https://api.flakehub.com/f/pinned/DeterminateSystems/determinate/3.24.2/01a1abec-122b-7762-9bf3-b517e8361a53/source.tar.gz","rev":"558e026d9d3c78351170d8f8a797fa0fac541ccf","revCount":457}
```

（手敲，不在 `lab/ch19/` 里；`2>/dev/null` 丢掉的是 Nix 的进度信息）

第一跳是 301（永久），把域名换成 `api.flakehub.com`；第二跳是 307（临时），把版本要求 `*` 解析成一个带具体版本号 `3.24.2` 和 UUID 的 `pinned` 地址。我猜用 307 是故意的：`*` 今天指向 3.24.2，明天指向别的，这一跳的结果不该被缓存，而 `pinned` 地址是不变的。`flake.lock` 记的就是 `pinned` 那个地址（环境一节里的 `locked.url`），加上 `rev` 和 `revCount`；`original` 里保留的是我写的 `*`。所以只有 `nix flake update determinate` 才会让它前进，平时按 lock 取的人拿到的永远是同一个 tarball。第 8 篇里 `original` 是 `flake.nix` 要的东西、`locked` 是被钉住的东西，在 FlakeHub 上就是版本要求和固定地址。

注意取回 FlakeHub 的 flake 本身不需要账号。我这台机器上的 `fh status` 其实是已登录的，nix.conf 里也配了 netrc，所以我用一个全新的 `HOME`、去掉 XDG 变量、并且不给 netrc 重跑了一遍 `nix flake metadata`：

```text
$ cd /tmp
$ HOME="$(mktemp -d)" env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME nix flake metadata --json 'https://flakehub.com/f/DeterminateSystems/determinate/3.24.2' --option netrc-file /dev/null 2>/dev/null | jq -c '{resolvedUrl, rev: .locked.rev, revCount: .locked.revCount}'
{"resolvedUrl":"https://flakehub.com/f/DeterminateSystems/determinate/3.24.2","rev":"558e026d9d3c78351170d8f8a797fa0fac541ccf","revCount":457}
```

（手敲，不在 `lab/ch19/` 里）

### `fh`：FlakeHub 的命令行

[`fh`](https://docs.determinate.systems/flakehub/cli/) 是 FlakeHub 的命令行客户端，dev shell 里的是 0.1.27。我只用读命令。`lab/ch19/fh_cli.sh` 把 `HOME` 指到一个新目录（这样它找不到我自己的 token），每条命令只留前 6 行输出和退出码：

```bash
run_fh() {
  local out status=0
  echo "\$ fh $*"
  out="$(timeout 120 fh "$@" 2>&1)" || status=$?
  printf '%s\n' "${out}" | head -n "${LINES_PER_COMMAND}" | cut -c1-160 \
    | sed 's/^/volatile: /'
  echo "exit status: ${status}"
}
```

（节选自 `lab/ch19/fh_cli.sh` 的 L26 到 L33）

```bash
  fh --version
  run_fh status
  run_fh search firn
  run_fh list releases DeterminateSystems/determinate
  run_fh list versions DeterminateSystems/determinate '3.2.*'
  # 没有登录时：FlakeHub 找不到这个输出引用，fh 报 not found（不是认证错误）。
  run_fh resolve \
    'DeterminateSystems/flake-checker/0.1#packages.x86_64-linux.default'
```

（节选自同一个文件的 L40 到 L47）

列表和搜索的内容每天都在变，所以脚本把每一行输出都标成 `volatile:`。这次的输出如下，我用 `cut -c1-110` 截短了过宽的行：

```text
$ cut -c1-110 out/ch19/fh_cli.stdout
fh 0.1.27
$ fh status
volatile: Logged in: false
volatile: To log in, run `fh login`.
exit status: 0
$ fh search firn
volatile: name,url,name,url,name,url,name,url,name,url,name,url,name,url,name,url,name,url,name,url
volatile: amarbel-llc/doppelgang,https://flakehub.com/flake/amarbel-llc/doppelgang,amarbel-llc/purse-first,htt
exit status: 0
$ fh list releases DeterminateSystems/determinate
volatile: simplified_version,version,revision,published_at,updated_at,commit_count
volatile: 3.24.2,3.24.2,558e026d9d3c78351170d8f8a797fa0fac541ccf,2026-11-05T13:35:38.100921Z,2026-11-05T13:35:
volatile: 3.24.1,3.24.1,7dce88a77ee0f714f81f988fd35329dc9b54cdfa,2026-10-26T00:47:40.268476Z,2026-10-26T00:47:
volatile: 3.24.0,3.24.0,c362c7c911ecf67570b2f19565b1bacc37de9ce8,2026-10-22T21:05:10.796685Z,2026-10-22T21:05:
volatile: 3.23.3,3.23.3,5f516660eb6faa93f5cb83ef493345967ca719ef,2026-10-17T01:21:10.324237Z,2026-10-17T01:21:
volatile: 3.23.2,3.23.2,4fecae08ae68ce3e620b0eba9234e33227820730,2026-10-13T22:41:43.652492Z,2026-10-13T22:41:
exit status: 0
$ fh list versions DeterminateSystems/determinate 3.2.*
volatile: simplified_version,flakehub_url,full_version
volatile: 3.2.0,https://flakehub.com/flake/DeterminateSystems/determinate/3.2.0,3.2.0
volatile: 3.2.1,https://flakehub.com/flake/DeterminateSystems/determinate/3.2.1,3.2.1
exit status: 0
$ fh resolve DeterminateSystems/flake-checker/0.1#packages.x86_64-linux.default
volatile: Error: 
volatile:    0: output reference DeterminateSystems/flake-checker/0.1#packages.x86_64-linux.default not found
volatile: 
volatile: Backtrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.
volatile: Run with RUST_BACKTRACE=full to include source snippets.
volatile: 
exit status: 1
```

几处值得读：

- `fh status` 打印 `Logged in: false`，所以接着的三条列表命令都是在没登录的情况下跑的，退出码都是 0。
- `fh list releases` 的第一行是 3.24.2，`revision` 是 `558e026d9d3c78351170d8f8a797fa0fac541ccf`，`commit_count` 是 457：和我 `flake.lock` 里的 `rev` 与 `revCount` 完全对得上。这就是“版本号写进 URL”的另一个后果：注册表里的一行记录，等于 lock 里的一个节点。
- `fh search firn` 返回的是一行表头加一行 CSV，名字和链接交替排列；脚本只留前 6 行，这次留下的前几项里没有 Firn。
- `fh resolve` 是唯一失败的：退出码 1，错误是 `output reference ... not found`，不是认证错误。它的用途是把 flake 引用换成一个 “resolved store path”。fh 的文档说它只能用于把 `include-store-paths` 设成 `true` 的发布，并链到 `flakehub-push` README 的参数表；那张表里参数名写的是 `include-output-paths`，说明里有 “only makes a difference if you’re using FlakeHub Cache”。两个名字是不是同一个参数，我没有核对。我没有登录去对比，所以不知道登录之后这一条会不会成功。

### 发布：`flakehub-push` 与 Firn 的 workflow

把 Firn 发布上去的是 `.github/workflows/flakehub.yml`。文件头三行注释写了意图，主体如下：

```yaml
name: Publish to FlakeHub

on:
  push:
    branches: [main]
    tags:
      - "ch*"
      - "v?[0-9]+.[0-9]+.[0-9]+*"

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write # 向 FlakeHub 证明身份
      contents: read
    steps:
      - uses: actions/checkout@v7
      - uses: DeterminateSystems/determinate-nix-action@v3
      - uses: DeterminateSystems/flakehub-push@v7
        with:
          visibility: public
          rolling: true
```

（节选自 `.github/workflows/flakehub.yml` 的 L4 到 L25，省略的是 L1 到 L3 的注释）

逐项说：

- 触发条件有三类：推送 `main`、推送 `ch*` 标签（也就是这个系列的每一章）、以及形如 `v1.2.3` 的语义化版本标签（最后这个模式是 `flakehub-push` 的 README 里的原样写法）。
- `permissions.id-token: write` 是认证的全部：GitHub 为这个 job 签发一个 OIDC 令牌，`flakehub-push` 拿它向 FlakeHub 证明“我是 `bfmhno3/firn` 这个仓库的 workflow”。README 的注释是 “Necessary for authenticating against FlakeHub”。所以仓库里没有任何密钥，这条 workflow 里也没有 `secrets.`。`contents: read` 是让 `actions/checkout` 能读代码。
- `determinate-nix-action@v3` 在 runner 上装 Determinate Nix。installer 的 README（2026-11 读）写着：这个 action 每个 Determinate 发布都打标签，`@v3.5.2` 永远装 3.5.2，而 `@v3` 这个主版本标签始终指向最新的 3.x.y。我写的是 `@v3`，所以 runner 上的 Nix 版本会随时间变，这次发布到底用了哪个我得到 workflow 日志里看，我现在没有这个信息。
- `visibility: public` 是 README 列出的三个取值之一（另外两个是 `unlisted` 和 `private`；README 说 `private` 只在付费计划里可用）：公开的 flake 在搜索结果和列表里都能看到。
- `rolling: true` 让版本号取 rolling 的形式 `0.1.<提交数>+rev-<sha>`，而不是要求我给每次发布打 SemVer 标签。因为触发条件里有 `ch*` 标签，每推一个章节的标签，FlakeHub 上就会多出一个对应那个提交的 rolling 版本（这是按 README 的规则和 workflow 头部的注释推的，我没有看过 `ch01` 到 `ch18` 的发布结果）。

还有一个我没有试过的地方：如果我真的推一个 `v0.1.0` 标签，会得到什么版本？`flakehub-push` README 里第一个手动配置的例子就是 `v?[0-9]+.[0-9]+.[0-9]+*` 标签触发加 `rolling: true`，注释写着 “Release rolling versions of the form 0.1.* instead of tagged releases”，所以按 README，`rolling: true` 下推语义化版本标签应该得到 rolling 版本；tagged 版本在 README 里是另一份 workflow，要用 `tag:` 参数。我没有推过这样的标签。

README 里的 “FlakeHub” 小节告诉别人怎么用这个发布结果：

```nix
{
  inputs.firn.url = "https://flakehub.com/f/bfmhno3/firn/0.1.*";
  # or, from the command line:
  #   nix flake metadata "https://flakehub.com/f/bfmhno3/firn/0.1.*"
}
```

（节选自 `README.md` 的 L100 到 L106）

### 解析：Firn 在 FlakeHub 上的版本

发布之后有没有成功，验证的办法是让一个完全不认识 Firn 的 Nix 去解析 `0.1.*`，看它锁到哪个提交。这是 `lab/ch19/flakehub_resolve_host.sh`，前半段解析：

```bash
readonly REF='https://flakehub.com/f/bfmhno3/firn/0.1.*'

main() {
  local meta
  if ! meta="$(nix flake metadata --json "${REF}" 2>&1)"; then
    echo "volatile: not resolvable yet: $(grep -m 1 'HTTP error' <<<"${meta}" \
      | sed 's/.*\(HTTP error [0-9]*\).*/\1/')"
    return 0
  fi
  local url rev
  url="$(jq --raw-output '.locked.url' <<<"${meta}")"
  rev="$(jq --raw-output '.locked.rev' <<<"${meta}")"
  echo "volatile: locked url: ${url}"
  echo "volatile: version: $(sed -E 's#.*/firn/([^/]*)/.*#\1#' <<<"${url}" \
    | sed 's/%2B/+/')"
  echo "volatile: locked rev: ${rev}"
```

（节选自 `lab/ch19/flakehub_resolve_host.sh` 的 L16 到 L31）

后半段把锁到的提交和标签 `ch19` 的提交比较：

```bash
  local tag_rev
  if ! tag_rev="$(git -C "${FIRN_ROOT}" rev-parse 'ch19^{commit}' \
    2>/dev/null)"; then
    echo "volatile: tag ch19 does not exist yet"
    return 0
  fi
  echo "ch19 commit: ${tag_rev}"
  if [[ "${rev}" == "${tag_rev}" ]]; then
    echo "match: the rolling release is the ch19 commit"
  elif git -C "${FIRN_ROOT}" merge-base --is-ancestor "${tag_rev}" "${rev}" \
    2>/dev/null; then
    echo "volatile: the rolling release moved past ch19"
  else
    echo "mismatch: ${rev} is not ch19 or a descendant of it" >&2
    return 1
  fi
```

（节选自同一个文件的 L33 到 L48）

三种结局：解析不了（打印 HTTP 状态，退出码 0，因为那只说明还没发布）；锁到的就是 `ch19` 的提交 (`match:`)；锁到的是 `ch19` 的后代（`0.1.*` 是滚动的，之后每推一次 `main` 它都会前进，这也算对，只标 `volatile:`）。只有锁到一个既不是 `ch19` 也不是它后代的提交，才退出码 1。推送之后我跑了这个脚本，输出如下（`out/ch19/` 里留着的是推送之前的 404 那次，因为 `out/` 不进 git，所以以这里的输出为准）：

```text
volatile: locked url: https://api.flakehub.com/f/pinned/bfmhno3/firn/0.1.43%2Brev-3464bc38d38c96ed08bcf4db976cef86e96dc881/01a1bbd1-a19e-7051-ac31-7385a7fe49b0/source.tar.gz
volatile: version: 0.1.43+rev-3464bc38d38c96ed08bcf4db976cef86e96dc881
volatile: locked rev: 3464bc38d38c96ed08bcf4db976cef86e96dc881
ch19 commit: 3464bc38d38c96ed08bcf4db976cef86e96dc881
match: the rolling release is the ch19 commit
```

推送 `main` 和 `ch19` 之后，发布工作流在 38 秒内跑完，`0.1.*` 解析出的版本是 `0.1.43+rev-3464bc38d38c96ed08bcf4db976cef86e96dc881`。按 README 的规则，版本号的第三段是提交数：本地 `git rev-list --count ch19` 数出 43 个提交（`ch19` 是 `3464bc38d38c96ed08bcf4db976cef86e96dc881`，它的父提交是第 42 个），和这个 `0.1.43` 对得上，`match:` 那一行也确认锁到的就是 `ch19` 的提交。注意这个输出是推送之后才跑出来的，之后每推一次 `main`，`0.1.*` 都会往前走。

### FlakeHub Cache：只描述，不使用

FlakeHub 的另一半是 FlakeHub Cache。官方[文档](https://docs.determinate.systems/flakehub/cache/)（2026-11 读）说：“FlakeHub Cache is available only on paid plans”，它是一个二进制缓存，特点是访问控制能细到 flake 一级，认证用 JWT 而不是静态密钥；推送被限制在 “trusted builders” 上（GitHub Actions、GitLab CI/CD、Semaphore、Buildkite 的 runner），文档明说 “no pushing from your laptop or from one of your servers”；拉取需要认证，在 Actions 上自动完成，在自己的机器上要先 `determinate-nixd login`。

Firn 不用它：它要付费，而且这个系列的二进制缓存留给第 20 篇的 Cachix。`fh resolve` 那一行里的 “resolved store path” 也属于这一块，我没有碰。

## Determinate 的 GitHub Actions 一家

`flakehub.yml` 里用到了两个 Determinate 的 Action，它们是一个家族的一部分。官方[文档](https://docs.determinate.systems/guides/github-actions/)（2026-11 读）列了五个，表里没有 `flakehub-push`，文档没有说为什么；它有自己的 README：

| Action | 文档的说法 | Firn |
| --- | --- | --- |
| `determinate-nix-action` | Quickly and reliably installs Nix in your workflow | 用，`@v3` |
| `flakehub-push` | 把 flake 发布到 FlakeHub（自己的 README） | 用，`@v7` |
| `flakehub-cache-action` | Automatically caches all Nix builds in FlakeHub Cache | 不用（要付费） |
| `flake-checker-action` | Performs health checks for your `flake.lock` file | 不用 |
| `update-flake-lock` | Automatically updates your `flake.lock` at the specified time interval | 不用 |
| `ci` | A “one-stop shop” Action for using Nix in CI | 不用 |

其中 `flake-checker-action` 和 `update-flake-lock` 文档都写了 “Especially useful in conjunction with” 对方：前者检查你的 nixpkgs 是不是太旧，后者定期开 PR 更新 lock。它们属于第 20 篇谈 CI 的范围，我在这一篇不展开。

这家人里有一个有历史的：`magic-nix-cache-action`。我读到的原文是三件事：2025-01-21 Determinate 发文宣布它的免费 GitHub Actions 缓存要终止，原因是 GitHub 要在 2025-02-01 关掉那个旧的缓存 API（[公告](https://determinate.systems/blog/magic-nix-cache-free-tier-eol/)）；2025-06-13 又发文说它回来了，一个社区用户提交了适配新 API 的 PR，同时列了限制：只在同一个仓库的同一个 workflow 的多次运行之间共享缓存，而且新 API 是逆向出来的，“the rug could in principle be pulled at any time”（[文章](https://determinate.systems/blog/bringing-back-magic-nix-cache-action/)）；到我 2026-11 读的时候，这一节开头那张文档里的 Actions 表里没有它，它的仓库 README 仍然写着 “totally free”。所以我不会说它“已下线”，只能说它被宣布终止过，又被救回来过，而官方现在的 Actions 文档没有列它。我没有用它。

## 2024 年前后：治理事件与分叉，只写官方文字里写了的

第 1 篇我答应过：2024 年的事每一件都链接一手来源再讲。这一节是兑现。规则是：只写我读到的原文，每条标日期和来源，来源都是 2026-11 读的；不写动机，不替任何人下判断；原文是英文的，我引用原文，不翻译成我自己的话再当作引文。

| 日期 | 官方文字里写的 | 来源 |
| --- | --- | --- |
| 2021-12-01 | TVL 的博客宣布 Tvix，目标是 “an alternative implementation of Nix that is fully compatible with nixpkgs”，并写明 “Tvix is not intended to replace Nix” | [TVL 的博客](https://tvl.fyi/blog/rewriting-nix) |
| 2022-09-02 | Determinate Systems 发文介绍公司 | [博客](https://determinate.systems/blog/we-want-to-make-nix-better/) |
| 2024-02 下旬 | Lix 的开发开始，公告里写 “since we begun in late February 2024” | [Lix 2.90 公告](https://lix.systems/blog/2024-07-10-lix-2.90-release) |
| 2024-05-01 | NixOS 基金会董事会发帖，承认 “a series of recent crises in our community, which are related to issues with communication, leadership, moderation, representation, and decision making power”；帖子说 Eelco Dolstra 决定正式退出董事会，“This decision was made amicably and in mutual agreement with the board”；宣布 14 天内任命一个 constitutional assembly，为社区设计一个新的治理结构 | [Discourse](https://discourse.nixos.org/t/nixos-foundation-board-giving-power-to-the-community/44552) |
| 2024-05-16 | 董事会任命 7 人的 constitutional assembly，收到 27 份申请 | [Discourse](https://discourse.nixos.org/t/nixos-foundation-board-constitutional-assembly-appointment/45504) |
| 2024-07-10 | Lix 发布第一个版本 2.90，“Lix forks from CppNix version 2.18” | [Lix 2.90 公告](https://lix.systems/blog/2024-07-10-lix-2.90-release) |
| 2024-09-16 | 第一届 Nix Steering Committee 选举启动（投票 2024-10-07 才开始），委员会 “will be the primary community leadership body, responsible for steering the official Nix projects” | [nixos.org](https://nixos.org/blog/announcements/2024/sc-election-2024/) |
| 2024-11-05 | 选举结果：450 张选票，56% 的投票率，产生 7 位委员 | [nixos.org](https://nixos.org/blog/announcements/2024/sc-election-2024-result/) |
| 2024-11-11 | constitutional assembly 宣布完成使命并解散 | [Discourse](https://discourse.nixos.org/t/concluding-the-nix-constitutional-assembly-nca/55896) |
| 2025-03-05 | Determinate Nix 3.0 发布，“isn’t a fork of Nix” | [博客](https://determinate.systems/blog/determinate-nix-30/) |
| 2025-03-16 | Snix 项目宣布，从 Tvix 分出来，换新名字、新的托管位置 | [Snix 博客](https://snix.dev/blog/announcing-snix) |

时间上的先后我只能原样排出来。我不在这些事件之间画因果线：我读到的 Lix 2.90 公告通篇没有提到董事会的任何事件，它写的开发起点（2024 年 2 月下旬）也早于 2024-05-01 那篇董事会的帖子。哪件事是哪件事的原因，我读到的原文里没有一篇这样写，所以我不写。

### Lix

Lix 2.90 公告 (2024-07-10) 的自我描述是 “a Nix implementation focused on reliability, predictability, friendliness, developed by a community of people from around the world”。技术上的定位写得很具体：从 CppNix 2.18 分叉，“Our goal with Lix 2.90 is to create a better Nix 2.18: faster, more user friendly, with fewer bugs, and fully compatible with previously-valid Nix code including flakes”。工程上它换了构建系统（公告写 “Lix builds exclusively with the Meson build system”）、用 Gerrit 做代码审查、用 Forgejo 托管代码。

它和基金会的关系，[Lix 的 FAQ](https://lix.systems/faq)（页面日期 2024-05-01，但正文提到了 2025-03-16 才出现的 Snix，所以内容后来改过）原文是 “Lix does not fall under the NixOS Foundation umbrella, is funded independently of the foundation, and is not in any way controlled by its leadership”，同一段还说他们和基金会 “in communication with” 并 “open to collaboration”。关于 flakes，FAQ 的说法是：flakes 仍是实验性技术，但因为用得太广，Lix 把它们算进兼容性保证。

我自己对 Lix 做的只有一件事：在锁定的 nixpkgs 上 `nix build` 出来，跑 `--version`，得到 `nix (Lix, like Nix) 2.95.2`。它和上游行为上的任何差别，这一篇我都没有测。

第 18 篇结尾留的那个问题（`nix flake check`、`--rebuild`、`nix path-info` 在别的实现上是不是一模一样）因此仍然是个问题：这一篇没有在 Lix 上跑它们，在 Determinate Nix 上我也只跑过 `nix eval`、`nix config show` 和 `nix store info`。

### Snix

Snix 的[关于页面](https://snix.dev/about/)（2026-11 读）写的是 “a modern Rust re-implementation of the components of the Nix package manager”，并且直接承认：“Snix still is in its early stages of development. None of our current APIs should be considered stable in any way. There is no full-featured drop-in replacement for Nix on your machine yet.” 它用 GPLv3，页面写着由 NLnet 资助。它的来历在 2025-03-16 的[公告](https://snix.dev/blog/announcing-snix)里：Tvix 的开发 “has been a bit of a tug-of-war between differing priorities”，所以 “I think it’s better to put the project on its own legs, not only in terms of community, but also in terms of where it’s hosted, using a new name, Snix”。Lix 的 FAQ 里也提到 Snix，说它是 “ground-up re-implementation of the Nix language in Rust”，而 Lix 自己计划 “top-down, piecewise” 地引入 Rust。我没有跑过 Snix，决策表里它只作为一个选项出现。

别的实现和分叉我没有读一手资料，所以不写。

### 三者放在一起

这张表只放我读到或测到的东西，空缺就是我不知道：

| | 上游 Nix | Determinate Nix | Lix |
| --- | --- | --- | --- |
| 自称 | CppNix，`NixOS/nix` | “downstream distribution”，“isn’t a fork” | “a Nix implementation”，从 CppNix 2.18 分叉 |
| flakes | 默认要手动打开（第 1 篇在 2.34.9 上测过） | “formal stability guarantee for flakes” | 实验性，但算进兼容性保证 |
| 在锁定的 nixpkgs 里 | `nix` 2.34.8，`nixVersions.latest` 2.35.2 | 不在，来自自己的 flake | `lix` 2.95.2 |
| 我测过的 | 全部输出 | 虚拟机里的配置、惰性树、并行求值 | 只有 `--version` |

## 我该装哪个 Nix

决策表。这是我自己会怎么选，依据列出我读到的出处，不是普遍结论：

| 场景 | 我会选 | 依据 |
| --- | --- | --- |
| NixOS（这台机器） | 系统自带的上游 Nix（`nix.package`，现在是 2.34.9） | 模块把 `nix.package` 换成 Determinate 的包，把 `nix.conf` 交给 `determinate-nixd`（模块源码 L31、L77、L87 到 L92），要为这个付出的改动不小，而我现在没有需要它的理由 |
| NixOS，想要惰性树和并行求值 | 引入 `determinate.nixosModules.default`，先照这篇的虚拟机测试验证再上真机 | 虚拟机里同一个目录 888 ms 对 107 ms；`nix eval --json` 的四个独立求值 2.59 倍 |
| 非 NixOS 的 Linux 或 macOS，个人机器 | 想要 receipt 和 `uninstall`：Determinate Nix Installer；想要装上游并且接受 Beta：`NixOS/nix-installer`；想要最少的东西：手册里的官方脚本 | 各自的 README；Determinate 的装的默认是 Determinate Nix，装上游要 `--prefer-upstream-nix` 而且 “Not a supported configuration” |
| 容器、没有 systemd 的环境 | 两个安装器都支持 `--init none`，只有 root 能用 | 两个 README 的同一条警告 |
| GitHub Actions | `determinate-nix-action@v3`（这篇的 workflow）；另一个选择放到第 20 篇 | 这篇的 `flakehub.yml` |
| 把 flakes 当作稳定接口来依赖 | Determinate Nix 3.x | 3.0 公告的 “formal stability guarantee”；上游是实验性 |
| 想试 Lix | 先 `nix build` 出 `pkgs.lix`，从 store 路径运行，不要先换系统 | `lix_version.sh` 的做法；我只跑过 `--version` |
| 想读或嵌入 Nix 的 Rust 实现 | Snix | “early stages”，“no full-featured drop-in replacement” |

这台机器继续用上游 Nix 2.34.9，这个系列的所有输出都以它为准。

## 让我意外的事

**`/etc/nix/nix.conf` 在虚拟机启动完成的时候并不存在。** 我原来以为 NixOS 模块会在启动时把两个配置文件都放好。结果是：NixOS 生成的那份被挪到了 `nix.custom.conf`，而 `nix.conf` 这个名字要等第一个连接把 `determinate-nixd` 拉起来才有 (`firn: nix.conf first absent`)。所以测试脚本得先连一次守护进程再读文件，不然读到的是“不存在”。

**非惰性那 888 ms 的大头不是写，是读。** 我本来猜 512 MiB 往 store 里复制是主要成本，所以猜第一次（要写）应该比其余 4 次（不用写）慢得多。数字不是这样：846 对 888。路径已经在 store 里的时候，Nix 还是要把 512 MiB 读一遍、算出哈希才知道它在不在，这一步大概才是 800 多毫秒的大头，惰性树整个跳过了它（这是猜测，没有用别的工具证实）。

**并行求值在一条依赖链上只让耗时少了 11.6%，在 4 个独立求值上少了 61.3%（2.59 倍），代价是多花 54% 的 CPU。** 同一个二进制、同一个设置，两个表达式，结果差五倍多。我原来以为“打开并行求值就会快”只是个设置的事，其实它是设置加表达式的形状。

**同一个 Docker 脚本，一次失败，一次成功。** `ex_installer_receipt_host.sh` 在 `make ch19` 那一次打印了 `docker run failed with exit status 1`，输出里是安装器下载超时 (`curl: (28) Operation too slow`)；我单独再跑一次就成功了，花了 5 分 42 秒。这个脚本在设计时就把“网络失败”当成一个合法的答案，所以第一次它也退出了 0，`make ch19` 照样打印 `ok`。这让我想起 `ok` 只说明脚本按设计结束，不说明它做成了它想做的事。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
env -u CI make ch19
make lint
make check
nix flake check 2>&1 | grep -c 'unknown flake output'
while read -r f; do
  diff <(git -C ~/firn-ref show ch19:"${f}") "${f}" && echo "same ${f}"
done < <(git -C ~/firn-ref diff --name-only ch18 ch19)
```

`make ch19` 在我这里打印这 8 行（命令回显加 7 行 `ok`），整条命令（含 `nix develop` 的启动）花了 611 秒，其中大头是虚拟机测试（脚本自己记的墙钟是 295 秒）：

```text
$ env -u CI make ch19
bash scripts/chapter.sh ch19
ok   lab/ch19/determinate_vm_host.sh
ok   lab/ch19/ex_installer_receipt_host.sh
ok   lab/ch19/fh_cli.sh
ok   lab/ch19/flakehub_resolve_host.sh
ok   lab/ch19/forks_versions.nix
ok   lab/ch19/lix_version.sh
ok   lab/ch19/upstream_baseline_host.sh
```

`lab/ch19/` 里有 4 个 `_host` 实验（虚拟机、Docker、FlakeHub 解析、上游基线）。我的 shell 里 `CI=true`，不加 `env -u CI` 的话，`scripts/chapter.sh` 会对它们打印 `skip ... (host only)` 并不运行，只跑另外 3 个，整条命令 28 秒：

```text
$ make ch19
bash scripts/chapter.sh ch19
skip lab/ch19/determinate_vm_host.sh (host only)
skip lab/ch19/ex_installer_receipt_host.sh (host only)
ok   lab/ch19/fh_cli.sh
skip lab/ch19/flakehub_resolve_host.sh (host only)
ok   lab/ch19/forks_versions.nix
ok   lab/ch19/lix_version.sh
skip lab/ch19/upstream_baseline_host.sh (host only)
```

`make lint` 没有任何诊断，退出码 0；`make check` 以 `all checks passed!` 结束，退出码 0，x86\_64-linux 上是 19 个检查，和 `ch18` 一样，因为这一章没有碰主 flake。`experiments/determinate` 是另一个 flake，`make check` 不会跑它的虚拟机测试，它的检查是单独的 `determinate-vm`。`nix flake check` 的输出里没有 `unknown flake output`：

```text
$ make lint >/dev/null 2>&1; echo "lint rc=$?"
lint rc=0
$ make check 2>&1 | tail -n 5; echo "rc=${PIPESTATUS[0]}"
derivation evaluated to /nix/store/sxj15y2pgk96v1kv2si52j1i2dqbbd5q-nixfmt-tree-2.5.0.drv
running 0 flake checks...
all checks passed!
warning: The check omitted these incompatible systems: aarch64-linux
Use '--all-systems' to check all.
rc=0
$ nix flake check > /tmp/fc19.log 2>&1; echo "rc=$?"; grep -c 'unknown flake output' /tmp/fc19.log
rc=0
0
```

（最后一组是手敲的，不在 `lab/ch19/` 里；`/tmp/fc19.log` 只是我存输出的临时文件）

`make check` 里那行 `running 0 flake checks...` 说明 19 个检查的结果都已经在 store 里，这次没有重新跑虚拟机测试，所以这两条命令的耗时不能用来衡量检查本身。

整条 `make ci`（`make lint`、所有章节的实验、`make check`）我在 `ch19` 标签上也在 `nix develop` 里用 `env -u CI` 跑了一遍，它没有跑完：在第 11 章的 `lab/ch11/cargo_hash.sh` 退出了 1，此前已经有 166 行 `ok`，墙钟 33 分 28 秒。这个脚本期望构建失败，并在日志里找到 `got:` 那一行；这一次那一行没有出现，运行器已经把 `LAB_TMP` 和构建日志删掉，所以我不知道原因。我单独再跑它，2 分 21 秒通过，`committed:` 和 `got:` 是同一个哈希；我猜是下载 crate 时的一次网络故障，这只是猜测。之后我用 `env -u CI make ch11 ch12 ch13 ch14 ch15 ch16 ch17 ch18` 补跑了其余的章节：76 行 `ok`，0 行 `FAIL`，17 分 20 秒。第 1 到 10 章的 157 行，加上这 76 行，再加上 `make ch19` 的 7 行，正好是 240 行 `ok`，不过这是三次运行拼出来的，不是一次干净的 `make ci`。

**必须和标签一致的文件。** 命令清单里最后那个循环对 `git diff --name-only ch18 ch19` 列出的每一个文件做 `diff`，全部应该打印 `same`，一共 11 行。我这台机器上没有 `~/firn-ref`，我在 Firn 仓库里用同一个循环、把 `git -C ~/firn-ref show ch19:"${f}"` 换成 `git show ch19:"${f}"` 跑的（拿标签里的内容和工作区比）：

```text
same .github/workflows/flakehub.yml
same README.md
same experiments/determinate/flake.lock
same experiments/determinate/flake.nix
same lab/ch19/determinate_vm_host.sh
same lab/ch19/ex_installer_receipt_host.sh
same lab/ch19/fh_cli.sh
same lab/ch19/flakehub_resolve_host.sh
same lab/ch19/forks_versions.nix
same lab/ch19/lix_version.sh
same lab/ch19/upstream_baseline_host.sh
```

**中间版本。** `experiments/determinate/`、`.github/workflows/flakehub.yml` 和 `lab/ch19/` 在这里就是终稿。`README.md` 之后的章节还会改。你自己的 `~/firn` 里，`flake.lock` 里的 Determinate 版本会比我的新（`*` 每次重新锁都会前进），这没关系，只要 `env -u CI make ch19` 仍然通过就行；Docker 那个实验依赖网络，失败也算它设计内的一种结果。

### 文件清单

链接指向标签 `ch19` 上的那一份；`git diff --name-only ch18 ch19` 的 11 个文件一个不少（其中 `lab/ch19/` 下 7 个，没有夹具）。实验的命令都是 `env -u CI make ch19`，输出在 `out/ch19/`。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`.github/workflows/flakehub.yml`](https://github.com/bfmhno3/firn/blob/ch19/.github/workflows/flakehub.yml) | `grep -c 'uses:' .github/workflows/flakehub.yml` | 25 行；`3`，分别是 `actions/checkout@v7`、`determinate-nix-action@v3`、`flakehub-push@v7`；触发是推送 `main`、`ch*` 标签和语义化版本标签；`visibility: public`、`rolling: true` |
| [`README.md`](https://github.com/bfmhno3/firn/blob/ch19/README.md) | `git diff --stat ch18 ch19 -- README.md` | 121 行；`1 file changed, 18 insertions(+)`：目录里多 2 行，多一个 “FlakeHub” 小节，用法是 `https://flakehub.com/f/bfmhno3/firn/0.1.*` |
| [`experiments/determinate/flake.lock`](https://github.com/bfmhno3/firn/blob/ch19/experiments/determinate/flake.lock) | `jq '.nodes \| length' experiments/determinate/flake.lock` | 243 行；`15`；`determinate` 锁在 `558e026d9d3c78351170d8f8a797fa0fac541ccf`，即 3.24.2，`revCount` 是 457，`nixpkgs` 还是 `56c02bc00adcf003215cc4bd996d6efaf4cff188` |
| [`experiments/determinate/flake.nix`](https://github.com/bfmhno3/firn/blob/ch19/experiments/determinate/flake.nix) | `nix eval ./experiments/determinate#checks.x86_64-linux --apply builtins.attrNames --json` | 157 行；`["determinate-vm"]`；测试脚本打印 45 行 `firn:`，其中 8 行是计时 |
| [`lab/ch19/determinate_vm_host.sh`](https://github.com/bfmhno3/firn/blob/ch19/lab/ch19/determinate_vm_host.sh) | `env -u CI make ch19` | 退出码 0（`_host`，`CI=true` 时跳过）；59 行；`nix (Determinate Nix 3.24.2) 2.35.3`；惰性树 107 ms、0 MiB 对 888 ms、512 MiB；并行求值 9402 ms 对 8309 ms；墙钟 295 秒，`volatile` |
| [`lab/ch19/ex_installer_receipt_host.sh`](https://github.com/bfmhno3/firn/blob/ch19/lab/ch19/ex_installer_receipt_host.sh) | `env -u CI make ch19`，另外单独跑过一次 | 退出码 0（`_host`，`CI=true` 时跳过）；57 行；`make` 那一次走了失败分支（`docker run failed with exit status 1`，下载超时）；单独跑成功：`Determinate Nix 3.24.2`、`["actions","planner","version"]`、8 个 action（练习 1 的答案） |
| [`lab/ch19/fh_cli.sh`](https://github.com/bfmhno3/firn/blob/ch19/lab/ch19/fh_cli.sh) | `env -u CI make ch19` | 退出码 0；50 行；`fh 0.1.27`，`Logged in: false`；3.24.2 的 `commit_count` 是 457；`fh resolve` 退出码 1，`not found` |
| [`lab/ch19/flakehub_resolve_host.sh`](https://github.com/bfmhno3/firn/blob/ch19/lab/ch19/flakehub_resolve_host.sh) | `env -u CI make ch19` | 退出码 0（`_host`，`CI=true` 时跳过）；51 行；版本 `0.1.43+rev-3464bc38d38c96ed08bcf4db976cef86e96dc881`，输出见 “解析：Firn 在 FlakeHub 上的版本” 一节 |
| [`lab/ch19/forks_versions.nix`](https://github.com/bfmhno3/firn/blob/ch19/lab/ch19/forks_versions.nix) | `env -u CI make ch19` | 退出码 0；11 行；`{ lix = "2.95.2"; nix = "2.34.8"; nixVersionsLatest = "2.35.2"; }` |
| [`lab/ch19/lix_version.sh`](https://github.com/bfmhno3/firn/blob/ch19/lab/ch19/lix_version.sh) | `env -u CI make ch19` | 退出码 0；21 行；`nix (Lix, like Nix) 2.95.2` |
| [`lab/ch19/upstream_baseline_host.sh`](https://github.com/bfmhno3/firn/blob/ch19/lab/ch19/upstream_baseline_host.sh) | `env -u CI make ch19` | 退出码 0（`_host`，`CI=true` 时跳过）；88 行；首次 569 ms、中位数 592 ms (`volatile`)；源路径 513 MiB；`store path deleted` |

## 练习

**1.** 在一个一次性的 Ubuntu 容器里装 Determinate Nix，打印 `nix --version` 和安装收据 `/nix/receipt.json` 的 key，并说出卸载入口在哪里。不要碰宿主机的 `/nix`。

<details>
<summary>参考答案</summary>

答案是 `lab/ch19/ex_installer_receipt_host.sh`（[链接](https://github.com/bfmhno3/firn/blob/ch19/lab/ch19/ex_installer_receipt_host.sh)）。容器里跑的那段脚本是：

```bash
set -o errexit
set -o nounset
set -o pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq curl ca-certificates jq >/dev/null
curl --proto '=https' --tlsv1.2 -sSf -L \
  https://install.determinate.systems/nix \
  | sh -s -- install linux --init none --no-confirm >/tmp/install.log 2>&1 || {
  tail -n 20 /tmp/install.log
  exit 1
}
export PATH="${PATH}:/nix/var/nix/profiles/default/bin"
echo "nix --version: $(nix --version)"
echo "receipt keys: $(jq --compact-output 'keys' /nix/receipt.json)"
echo "action count: $(jq '.actions | length' /nix/receipt.json)"
echo "uninstaller: $(ls /nix/nix-installer)"
```

（节选自 `lab/ch19/ex_installer_receipt_host.sh` 的 L23 到 L39，容器里的 `bash -c` 执行它）

宿主机一侧只负责用 `docker run --rm` 启动容器、限时、并把失败当成一种合法的结果：

```bash
main() {
  local out status=0
  out="$(
    timeout "${TIMEOUT}" docker run --rm "${IMAGE}" bash -c "${INNER}" 2>&1
  )" || status=$?
  if ((status == 0)); then
    printf '%s\n' "${out}"
  else
    echo "volatile: docker run failed with exit status ${status}"
    printf '%s\n' "${out}" | tail -n 10 | sed 's/^/volatile: /'
  fi
}
```

（节选自同一个文件的 L44 到 L55；镜像是 `ubuntu:24.04`，超时 600 秒）

`install linux --init none --no-confirm` 就是 README 对 Docker 容器的写法：容器里没有 systemd，所以不配守护进程，只有 root 能用 Nix。单独跑一次的结果，我没有经过 `make`，直接用 `bash` 执行这个脚本：

```text
$ export FIRN_ROOT="$PWD" LAB_TMP="$(mktemp -d)"
$ time bash lab/ch19/ex_installer_receipt_host.sh
debconf: delaying package configuration, since apt-utils is not installed
nix --version: nix (Determinate Nix 3.24.2) 2.35.3
receipt keys: ["actions","planner","version"]
action count: 8
uninstaller: /nix/nix-installer

real	5m42.172s
user	0m43.345s
sys	0m8.435s
```

（手敲，不在 `lab/ch19/` 里；命令运行的是 `lab/ch19/ex_installer_receipt_host.sh`，这一次没有经过 `make ch19`）

收据有 3 个顶层 key：`actions`、`planner` 和 `version`；`actions` 数组有 8 项（`planner` 里装了什么，我没有展开看）。卸载入口是安装时顺带放进 `/nix/nix-installer` 的那份二进制，`/nix/nix-installer uninstall` 默认读 `/nix/receipt.json`（README 的说法）。我只验证了“收据存在、key 是这三个、动作数是 8、二进制在 `/nix/nix-installer`”，没有在容器里真的跑 `uninstall`，所以卸载能不能干净撤销，我没有测。

同一个脚本在 `make ch19` 那一次的结果是失败分支：

```text
$ cat out/ch19/ex_installer_receipt_host.stdout
volatile: docker run failed with exit status 1
volatile: debconf: delaying package configuration, since apt-utils is not installed
volatile: info: downloading the Determinate Nix Installer
volatile: warn: curl: (28) Operation too slow. Less than 250000 bytes/sec transferred the last 15 seconds
volatile: curl: (28) Operation too slow. Less than 250000 bytes/sec transferred the last 15 seconds
volatile: curl: (28) Operation too slow. Less than 250000 bytes/sec transferred the last 15 seconds
volatile: curl: (28) Operation too slow. Less than 250000 bytes/sec transferred the last 15 seconds
volatile: error: command failed: downloader https://install.determinate.systems/nix/tag/v3.24.2/nix-installer-x86_64-linux /tmp/tmp.Kk5prQcRth/nix-installer x86_64-linux
```

这是下载慢到超过 curl 的低速阈值（15 秒内低于 250000 字节每秒），不是脚本的问题；那是在 `install.determinate.systems` 上取安装器二进制这一步。所以这个实验的耗时和成败都取决于网络，不要把 5 分 42 秒当成安装器本身的耗时。

</details>

**2.** 用 `fh convert --dry-run` 看看它会怎么处理 Firn 钉死的那个 nixpkgs 输入，再对照一个指向 `nixos-unstable` 分支的输入。文件不要真的改。

<details>
<summary>参考答案</summary>

写两个只有一个输入的临时 flake，各自 `--dry-run`。第一个指向分支，过了 `nixfmt --check`：

```nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = _: { };
}
```

第二个是同样的结构，URL 换成 Firn 钉的提交 `github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188`。

```text
$ fh convert --dry-run --flake-path /tmp/scratch19/flake.nix
{
  inputs.nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1.1108983.tar.gz";
  outputs = _: { };
}

$ fh convert --dry-run --flake-path /tmp/scratch19/pinned.nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188";
  outputs = _: { };
}

$ head -3 /tmp/scratch19/flake.nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = _: { };
```

（手敲，不在 `lab/ch19/` 里；两个文件在 `/tmp/scratch19/`，`fh` 来自 Firn 的 dev shell）

对分支，`fh convert` 把它换成了一个固定到提交数的 FlakeHub 地址 `0.1.1108983`，也就是把“跟着分支走”变成了“钉在当前这一个”，`--dry-run` 把转换后的整个文件打印到标准输出，文件本身没变（最后一条 `head` 证明了这一点）。对 Firn 钉死的提交，它原样输出，什么也没转换。这就是 Firn 不能直接用 `fh convert` 把 nixpkgs 换成 FlakeHub 输入的原因：我只试了这两个输入，所以“钉死的提交一律不转换”是我对这一个例子的读法，不是我验证过的规则。

</details>

**3.** 不安装 Determinate Nix，问出锁在 `experiments/determinate/flake.lock` 里的那一份的版本。

<details>
<summary>参考答案</summary>

Determinate 的 flake 把它的 Nix 包放在它自己的 `nix` 输入里，`builtins.getFlake` 取出输入，拿到包的 `outPath`，直接运行里面的二进制，不装进任何 profile，也不碰系统的 `/etc/nix`：

```text
$ N="$(nix eval --raw --impure --expr '(builtins.getFlake (toString ./experiments/determinate)).inputs.determinate.inputs.nix.packages.x86_64-linux.default.outPath')"
$ "$N/bin/nix" --version
nix (Determinate Nix 3.24.2) 2.35.3
```

（手敲，不在 `lab/ch19/` 里；这条路径在 store 里，是因为虚拟机测试构建过它）

这是 `forks_versions.nix` 那种“先问再装”的办法的变体：上游和 Lix 在 nixpkgs 里，用属性就能问；Determinate 不在 nixpkgs 里，要先拿到它的 flake 的输入。

</details>

**4.** `lab/ch19/flakehub_resolve_host.sh` 在 `0.1.*` 已经解析到 `ch19` 之后的提交时为什么仍然退出 0？哪种情况才会退出 1？

<details>
<summary>参考答案</summary>

答案在脚本后半段（本篇解析一节引过 L33 到 L48）。`0.1.*` 是滚动的：`flakehub.yml` 每推一次 `main` 就会产生新的 rolling 版本，所以过一阵子，它锁到的提交会是 `ch19` 之后的某个提交。脚本用 `git merge-base --is-ancestor "${tag_rev}" "${rev}"` 判断 `ch19` 的提交是不是锁到的那个提交的祖先：是，就只打印 `volatile: the rolling release moved past ch19`，退出码 0；只有锁到的提交既不等于 `ch19`，也不是它的后代，才会打印 `mismatch:` 并退出 1，那说明 FlakeHub 上的版本和这个仓库的历史对不上。这个脚本不负责证明“发布成功”，它证明的是“FlakeHub 上的东西没有岔开我的历史”。

</details>

## 下一篇

第 20 篇《工程化：CI、Cachix、lint 与可复现性》要把这 19 篇攒下来的东西放进持续集成：这一篇的 `flakehub.yml` 只是 Firn 的第一条 workflow，它没有测试，也没有缓存。我猜我最先想回答的是一个这篇没有量的问题：`determinate-nix-action@v3` 和上游的安装方式在一次 CI 里各自花多少时间，Cachix 又能把一次完整的 `make ci` 缩短多少；我这篇只在虚拟机和本机量过 Determinate Nix，CI 上的数字我一个也没有。

