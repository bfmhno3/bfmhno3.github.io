---
title: "NixOS：services.cairn、VM 测试与一次 switch"
commentId: "post:nix-by-firn-16-nixos-module-and-vm-test"
published: "2026-11-07 02:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 16 篇：我用 Nix 2.34.9 写了 services.cairn，在 KVM 加速的 NixOS 虚拟机里让 cairn 跑两次快照，整个测试脚本 20.71 秒；lab 主机的 system.build.toplevel 闭包是 1,331,201,328 字节，systemd-analyze 给这个单元打 8.4 分 (EXPOSED)，加两行加固后是 4.4 (OK)。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - systemd
  - VM 测试
series: "用 Firn 从零学 Nix"
seriesOrder: 16
draft: false
comment: true
slug: nix-by-firn-16-nixos-module-and-vm-test
---

我在这台 NixOS 上敲过很多次 `nixos-rebuild switch`：回车，等一会儿，服务就换好了。回车之后到底发生了什么，我从来没有认真看过。所以这一篇我自己写一个服务，`services.cairn`，让 cairn 按定时器做快照，再起一台 KVM 加速的虚拟机，让它在里面真的跑两次。标题里的“一次 switch”要说清楚：这一篇没有在任何机器上执行过 `switch`，虚拟机里只是冷启动，`switch` 做什么是我读 `switch-to-configuration` 的源码得出的（“从 toplevel 到运行中的系统”那一节）。先看测试的结果：

```text
$ cat out/ch16/vm_test_host.stdout
== result already in the store: building with --rebuild
volatile: /dev/kvm: present
== lines printed by the test script
firn: snapshots_after_first 1
firn: verify ok
firn: snapshots_after_second 2
firn: hardlinks_unchanged 2
firn: hardlinks_changed 1
firn: timer cairn.timer
firn: exposure 8.4
firn: exposure_level EXPOSED
volatile: wall time: 21 s
```

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch16` 里：`nixos/modules/cairn.nix`（85 行，`services.cairn` 本体）、`nixos/tests/cairn.nix`（78 行，虚拟机测试）和 `nixos/hosts/lab.nix`（33 行，只用来求值和构建的实验主机）；`flake.nix` 多了 24 行，对外提供 `nixosModules.cairn`、`nixosModules.default`、`nixosConfigurations.lab` 和 `checks.x86_64-linux.cairn-vm`，x86\_64-linux 上的检查是 16 个（`ch15` 标签上是 15 个）；`lab/ch16/` 下 8 个实验（6 个 `.sh` 和 2 个 `.nix`，其中 3 个 `_host` 实验在 `CI=true` 时被跳过），没有 fixture，`env -u CI make ch16` 通过（8 个 `ok`）。`git diff --name-only ch15 ch16` 一共列出 12 个文件：11 个新文件，加上 `flake.nix` 的 24 行新增，没有删行。
> 涉及的概念：NixOS 配置是 `evalModules` 的结果，`system.build.toplevel`，`/etc` 的生成，激活脚本和 `switch-to-configuration` 的四种模式，generation 与引导项，`nixos-rebuild` 和 `nh os`，`build-vm`，写一个服务模块（`mkEnableOption`、`mkPackageOption`、`mkIf`、用户、tmpfiles、systemd 单元与定时器），systemd 加固与 `systemd-analyze security`，NixOS 测试框架，`system.stateVersion`，以及和 nixpkgs 里 `restic.nix` 的对照。
> 前置：[第 15 篇：模块系统：从零写一个，再读懂 lib.evalModules](/posts/nix-by-firn-15-module-system/)。`modules/cairn-settings.nix` 和它渲染的 `configText` 在那一篇写好，这一篇原样放进 `services.cairn.settings`；`mkIf`、优先级和子模块的合并规则也都在那里讲过。cairn 这个包在[第 11 篇](/posts/nix-by-firn-11-packaging-real-projects/)打好，overlay 在[第 10 篇](/posts/nix-by-firn-10-callpackage-overrides-overlays/)写好，flake 的 `checks` 在[第 8 篇](/posts/nix-by-firn-08-flakes/)讲过。
> 终稿与否：`nixos/modules/cairn.nix`、`nixos/tests/cairn.nix`、`nixos/hosts/lab.nix` 和 `lab/ch16/` 在这里就是终稿；`flake.nix` 之后的章节还会改。

## 环境

这一篇所有输出来自这台机器：NixOS 26.05 (Yarara)，Linux 6.18.60，`x86_64`，上游 Nix 2.34.9，`/dev/kvm` 存在，`nix config show system-features` 打印 `benchmark big-parallel kvm nixos-test`。Firn 钉的 nixpkgs 是 `56c02bc00adcf003215cc4bd996d6efaf4cff188`，它的版本串是 `26.11.20260823.56c02bc`，也就是说这一篇构建出来的 NixOS 是 26.11 的开发版，而我这台机器跑的是 26.05；这两个版本号在“`system.stateVersion`”那一节还会碰面。文中引用的 nixpkgs 源码行号都是这个 rev 上的行号，我在本地那份源码上逐条核对过，链接指向同一个 rev。这一篇没有引用 Nix 本身的源码。

我的 shell 里设了 `CI=true`，Firn 的运行器会据此跳过名字以 `_host` 结尾的实验。`lab/ch16/` 里有 3 个这样的实验，是 `build_vm_host.sh`、`switch_anatomy_host.sh` 和 `vm_test_host.sh`，所以我按惯例跑 `env -u CI make ch16`，在 `nix develop` 里，整条命令（含 `nix develop` 的启动）花了 33.231 秒，8 个实验全部 `ok`。其中虚拟机测试的结果在这之前已经在 store 里，所以 `vm_test_host.sh` 走的是 `--rebuild` 分支，“`volatile: wall time`”那一行的 21 秒是这个分支的墙钟时间，不是第一次构建的时间；每次跑都不同，只当作一个样本。

实验分两类。一类在 `lab/ch16/` 里，我给出文件路径、摘录和 `out/ch16/` 里的真实输出。另一类是我为了回答某个问题当场敲的，每一条都标着“（手敲，不在 `lab/ch16/` 里）”，输出同样是真跑出来的。手敲的命令都假设你在 `~/firn` 里。其中六个虚拟机或求值实验用的 Nix 文件，分别是 `readonly.nix`、`no_tmpfiles.nix`、`probe.nix`、`hardened.nix`、`hardened_more.nix` 和 `dash_path.nix`，我放在 `/tmp/scratch16/` 下，内容贴在对应的小节里，`hardened_more.nix` 只贴了 `serviceConfig` 的节选，六个文件都过了 `nixfmt --check`；它们靠 `builtins.getFlake (toString ./.)` 把当前目录当 flake 读进来，所以要加 `--impure`，也不用 `builtins.getEnv`。

还有一点要先说清楚：虚拟机测试和 `build-vm` 都要用 `/dev/kvm`。`run-nixos-vm` 里的参数是 `-machine accel=kvm:tcg`，也就是有 KVM 就用 KVM，没有就退回 TCG 软件模拟；这个回退我只在脚本里看到，没有试过，不知道会慢多少；“NixOS 测试框架”那一节会指出 nixpkgs 里哪几行在要求 KVM。

## 这一篇停在哪里

先看 flake 对外多了什么：

```text
$ nix eval .#nixosModules --apply builtins.attrNames --json
["cairn","default"]
$ nix eval .#nixosConfigurations --apply builtins.attrNames --json
["lab"]
$ nix eval .#checks.x86_64-linux --apply builtins.attrNames --json
["cairn-settings","cairn-vm","dev-shell","lib-tests","mini-site","pkg-cairn","pkg-cairn-report","pkg-firn-hello","pkg-firn-hello-aarch64","pkg-firn-hello-hallo","pkg-firn-hello-musl","pkg-firn-hello-static","pkg-firn-tools","pkg-pebble","pkg-sift","readme-table"]
```

（手敲，不在 `lab/ch16/` 里）

三处改动在 `flake.nix` 里，一共 24 行，都是新增：

```nix
        # 第 16 章：cairn 的 NixOS 模块在虚拟机里跑一遍，需要 KVM。
        // pkgs.lib.optionalAttrs (system == "x86_64-linux") {
          cairn-vm = import ./nixos/tests/cairn.nix {
            inherit pkgs;
            cairnModule = self.nixosModules.default;
          };
        }
```

```nix
      # 第 16 章：services.cairn，以及用它搭的实验主机（只求值和构建，不装到真机）。
      nixosModules = {
        cairn = {
          imports = [ ./nixos/modules/cairn.nix ];
          nixpkgs.overlays = [ self.overlays.default ];
        };
        default = self.nixosModules.cairn;
      };

      nixosConfigurations.lab = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          self.nixosModules.default
          ./nixos/hosts/lab.nix
        ];
      };
```

`nixosModules.cairn` 不是直接指向 `nixos/modules/cairn.nix`，而是一个包了一层的模块：它 `imports` 那个文件，同时设 `nixpkgs.overlays`。原因在 `mkPackageOption` 那一行：`services.cairn.package` 的默认值是 `pkgs.cairn`，而钉住的 nixpkgs 里没有这个包（第 11 篇的 cairn 是 Firn 自己的 `pkgs/cairn`，由 `overlays.default` 加进 `pkgs`）。把模块文件单独拿去求值，会得到这个：

```text
$ nix eval --impure --expr 'let firn = builtins.getFlake (toString ./.); in (firn.inputs.nixpkgs.lib.nixosSystem { system = "x86_64-linux"; modules = [ ./nixos/modules/cairn.nix ./nixos/hosts/lab.nix ]; }).config.systemd.services.cairn.serviceConfig.ExecStart' 2>&1 | tail -n 1
       error: cairn cannot be found in pkgs
```

（手敲，不在 `lab/ch16/` 里）

这条错误文本来自 `lib/options.nix` 的 [L322](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/options.nix#L322)：`mkPackageOption` 用 `attrByPath` 去 `pkgs` 里找 `default`，找不到就 `throw "${defaultText} cannot be found in ${pkgsText}"`。所以模块和 overlay 绑在一起发布，用的人写一句 `imports = [ firn.nixosModules.default ];` 就够了。这个设计有一个代价：模块自己设了 `nixpkgs.overlays`，而 NixOS 测试框架默认把 `nixpkgs.*` 选项锁成只读，两件事会打架，“NixOS 测试框架”那一节会讲这个。

## 一个 NixOS 配置是 evalModules 的结果

第 15 篇我数过最小的 NixOS 配置有 16555 个选项。选项从哪里来？每一个 NixOS 求值都从同一份清单开始：`nixos/modules/module-list.nix`。`lab/ch16/module_count.nix` 数这份清单，再数 `nixosConfigurations.lab` 实际收集到的模块图：

```nix
let
  pkgs = import ../../nix/pkgs.nix { };
  lab = (builtins.getFlake (toString ../..)).nixosConfigurations.lab;
in
{
  moduleList = builtins.length (import "${pkgs.path}/nixos/modules/module-list.nix");
  labGraph = builtins.length lab.graph;
}
```

```text
$ cat out/ch16/module_count.stdout
{ labGraph = 2098; moduleList = 2093; }
```

2093 个模块，在你写第一行配置之前就已经被导入了；`lab` 的模块图是 2098 个，多出来的 5 个是 `lab` 自己的模块（`nixosModules.default` 和 `nixos/hosts/lab.nix`）加上 `nixosSystem` 和 `eval-config.nix` 自己塞进去的几个，我没有逐个核对是哪 5 个。第 15 篇里 `module-list.nix` 的条目数也是 2093，两篇的数字对得上。

`nixosSystem` 是一层很薄的包装。[`flake.nix` 的 L64 到 L66](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/flake.nix#L64-L66) 里它只是把参数交给 `nixos/lib/eval-config.nix`，并把一个自己的模块追加在你的 `modules` 之后，在 L74。`eval-config.nix` 才是真正干活的地方：

```nix
  baseModules ? import ../modules/module-list.nix,
# ...
  noUserModules = evalModulesMinimal {
    inherit prefix specialArgs;
    modules =
      baseModules
      ++ extraModules
      ++ [
        pkgsModule
        modulesModule
      ];
  };
# ...
  nixosWithUserModules = noUserModules.extendModules { modules = userModules; };
```

（节选自 [`nixos/lib/eval-config.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/lib/eval-config.nix) 的 L22、L81 到 L90 和 L106）

第一行的默认值就是那份 2093 条的清单，在 L22。`evalModulesMinimal`（L35 到 L40）是 `lib.evalModules` 的一个变体，第 15 篇读过它；`noUserModules` 是“只有 NixOS 自带模块”的求值结果，用户的模块（你的 `configuration.nix`、这里的 `lab.nix`）在 L106 用 `extendModules` 追加上去。这样做的好处我猜是：自带模块那部分的求值可以被共享，比如 `virtualisation.vmVariant` 就是靠 `extendModules` 在同一份配置上再叠一层（`nixos/modules/virtualisation/build-vm.nix` 的 [L13 到 L15](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/virtualisation/build-vm.nix#L13-L15)），“`build-vm`”那一节会回到这里。

所以 `nixosConfigurations.lab` 就是第 15 篇那个 `lib.evalModules` 调用的一个具体实例：2098 个模块，`lab.config` 是合并后的整棵选项树，`lab.options` 是声明，`lab.config.system.build.toplevel` 是树里的一个叶子。这个叶子的值是什么，看“system.build.toplevel 是一个 store 路径”那一节。

## system.build.toplevel 是一个 store 路径

`lab/ch16/toplevel.sh` 构建这个叶子，列出结果，量闭包：

```bash
main() {
  local top
  top="$(nix build "${FIRN_ROOT}#nixosConfigurations.lab.config.system.build.toplevel" \
    --no-link --print-out-paths)"
  echo "== ls of the toplevel"
  ls "${top}"
  # ...
  echo "== closure"
  nix path-info -S "${top}" | awk '{ printf "closure size: %d bytes\n", $2 }'
  echo "closure paths: $(nix path-info -r "${top}" | wc -l)"
}
```

```text
$ cat out/ch16/toplevel.stdout
== ls of the toplevel
activate
bin
boot.json
configuration-name
dry-activate
etc
extra-dependencies
firmware
init
init-interface-version
initrd
kernel
kernel-modules
kernel-params
nixos-version
prepare-root
specialisation
sw
switch-inhibitors
system
systemd

== nixos-version
26.11.20260823.56c02bc

== closure
closure size: 1331201328 bytes
closure paths: 585
```

整个“系统”是一个 store 路径，里面是 21 个条目：8 个符号链接，分别是 `etc`、`firmware`、`initrd`、`kernel`、`kernel-modules`、`sw`、`switch-inhibitors` 和 `systemd`，两个目录，是 `bin` 和 `specialisation`，其余是脚本和小文本文件。`activate` 和 `dry-activate` 是激活脚本，`init` 是内核启动后跑的第一个程序，`bin/switch-to-configuration` 是“从 toplevel 到运行中的系统”那一节的主角，`etc` 指向这份配置生成的全部 `/etc` 文件，`sw` 是 `environment.systemPackages` 合成的一个 profile，`systemd` 是 systemd 包本身，`kernel`、`initrd`、`kernel-modules` 是启动要用的东西。这个路径的构建脚本在 [`nixos/modules/system/activation/top-level.nix` 的 L34 到 L41](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/system/activation/top-level.nix#L34-L41)：

```bash
    ln -s ${config.system.build.etc}/etc $out/etc

    ln -s ${config.system.path} $out/sw
    ln -s "$systemd" $out/systemd

    echo -n "systemd ${toString config.systemd.package.interfaceVersion}" > $out/init-interface-version
    echo -n "$nixosLabel" > $out/nixos-version
    echo -n "${config.boot.kernelPackages.stdenv.hostPlatform.system}" > $out/system
```

读完这几行我才意识到，NixOS 的“系统”没有任何神秘之处：它是一个 `stdenvNoCC.mkDerivation`（[`top-level.nix` 的 L58](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/system/activation/top-level.nix#L58) 起），`buildCommand` 主要是往 `$out` 里 `ln -s`，再 `cp` 几个脚本，如 `init` 和 `prepare-root`，`echo` 几个小文件，区别只是这个字符串是模块系统拼出来的。我给它配一个类比，一张索引卡片柜：卡片本身几乎不占地方，书全在 store 的书架上。

闭包是 1,331,201,328 字节，即 1.24 GiB，585 个路径。这是一台没有桌面、也没有 sshd 的最小主机；我这台日常机器的 `/run/current-system`，第 1 篇量过，是 57.3 GiB、8747 个路径（那是另一天的单个样本，现在的数字不同），差了大约 46 倍（我每次 `switch` 之前，原来都在默默背着那 57 GiB）。我想知道这 1.24 GiB 里最大的几块是什么：

```text
$ nix path-info -r --json --json-format 1 "$(nix build .#nixosConfigurations.lab.config.system.build.toplevel --no-link --print-out-paths)" | jq -r 'to_entries | map({p: .key, s: .value.narSize}) | sort_by(-.s) | .[:6][] | "\(.s)\t\(.p)"' | sed 's|/nix/store/[a-z0-9]*-|…-|'
212583408	…-source
150766776	…-linux-6.18.45-modules
142028848	…-python3-3.14.7
65103424	…-systemd-261.1
57724016	…-perl-5.42.0
41437848	…-icu4c-78.3
```

（手敲，不在 `lab/ch16/` 里）

最大的是一个叫 `source` 的路径，212,583,408 字节，占闭包的 16%，比内核模块还大。我没认出它，`nix why-depends` 给了答案：

```text
$ nix why-depends "$(nix build .#nixosConfigurations.lab.config.system.build.toplevel --no-link --print-out-paths)" /nix/store/z4wkdlk69gck09s64a8ghpn6h7bxhkyy-source | sed 's|/nix/store/[a-z0-9]*-|…-|g'
…-nixos-system-nixos-26.11.20260823.56c02bc
└───…-etc
    └───…-etc-nix-registry.json
        └───…-source
```

（手敲，不在 `lab/ch16/` 里）

它就是钉住的 nixpkgs 源码本身，经由 `/etc/nix/registry.json` 进了闭包。来源在 [`nixos/modules/misc/nixpkgs-flake.nix` 的 L60 到 L78](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/misc/nixpkgs-flake.nix#L60-L78)：选项 `nixpkgs.flake.setFlakeRegistry` 把系统级 flake registry 里的 `nixpkgs` 钉到“构建这个系统所用的 nixpkgs 源码”上，让 `nix run nixpkgs#hello` 复用系统里已有的依赖；它的说明文字自己承认，这会让 NixOS 闭包依赖 nixpkgs 源码，可能增加闭包体积。`nixosSystem` 把源码路径设成 `self.outPath`（`flake.nix` 的 [L89](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/flake.nix#L89)）。我把这个选项和依赖它的 `setNixPath` 一起关掉，看闭包变多少：

```text
$ nix build --impure --no-link --print-out-paths --expr 'let firn = builtins.getFlake (toString ./.); in (firn.nixosConfigurations.lab.extendModules { modules = [ { nixpkgs.flake.setFlakeRegistry = false; nixpkgs.flake.setNixPath = false; } ]; }).config.system.build.toplevel' | xargs nix path-info -S | awk '{ printf "closure size: %d bytes\n", $2 }'
closure size: 1118617944 bytes
```

（手敲，不在 `lab/ch16/` 里）

1,118,617,944 字节，比 1,331,201,328 少了 212,583,384 字节，和 `source` 的 212,583,408 字节几乎一样（差 24 字节，我没有追究）。代价我只量了闭包，没有测对使用的影响：这台主机上 `nix run nixpkgs#...` 不再解析到系统自带的那份源码。

## /etc 是怎么生成的

服务模块里有一行 `environment.etc."cairn/cairn.conf".text = ...`。它怎么变成机器上的 `/etc/cairn/cairn.conf`？`lab/ch16/etc_generated.sh` 沿着 toplevel 里的 `etc` 链接看：

```bash
  echo "== etc/cairn/cairn.conf is a link"
  readlink "${top}/etc/cairn/cairn.conf" | sed 's|^/nix/store/[a-z0-9]*-||'
  echo
  echo "== cat etc/cairn/cairn.conf"
  cat "${top}/etc/cairn/cairn.conf"
```

```text
$ sed -n '1,10p' out/ch16/etc_generated.stdout
== etc/cairn/cairn.conf is a link
etc-cairn-cairn.conf

== cat etc/cairn/cairn.conf
repo = /var/lib/cairn/repo
source = /srv/data
keep_last = 5
keep_daily = 7
keep_weekly = 4

```

`etc/cairn/cairn.conf` 是一个链接，指向 store 里一个叫 `etc-cairn-cairn.conf` 的文件，内容是第 15 篇的 `configText` 渲染出来的 5 行：`repo` 是 `services.cairn` 给的默认值 `/var/lib/cairn/repo`，`source` 是 `lab.nix` 里设的 `/srv/data`，三个 `keep_*` 是 `cairn-settings` 的默认值。这是一份真正的文件系统内容，而不是“配置对象”：模块系统一路算下来，终点是一个字符串。

这些链接怎么出现在真正的 `/etc`？`switch-to-configuration` 要先跑 toplevel 里的 `activate`，它是一个按“片段”拼起来的 shell 脚本，其中的 `etc` 片段是这样的：

```text
$ sed -n '68,77p' "$(nix build .#nixosConfigurations.lab.config.system.build.toplevel --no-link --print-out-paths)/activate" | sed 's|/nix/store/[a-z0-9]*-|/nix/store/<hash>-|g'
#### Activation script snippet etc:
_localstatus=0
# Set up the statically computed bits of /etc.
echo "setting up /etc..."
/nix/store/<hash>-perl-5.42.0-env/bin/perl /nix/store/<hash>-setup-etc.pl /nix/store/<hash>-etc/etc

if (( _localstatus > 0 )); then
  printf "Activation script snippet '%s' failed (%s)\n" "etc" "$_localstatus"
fi

```

（手敲，不在 `lab/ch16/` 里）

这几行的来源是 [`nixos/modules/system/etc/etc.nix` 的 L378 到 L380](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/system/etc/etc.nix#L378-L380)。走哪个分支由 `system.etc.overlay.enable` 决定，我查它在 `lab` 上的值：

```text
$ nix eval .#nixosConfigurations.lab.config.system.etc.overlay.enable
false
```

（手敲，不在 `lab/ch16/` 里）

它是 `false`，所以走的是这个 perl 脚本的分支，而不是 overlayfs 的分支。`setup-etc.pl` 的做法在文件开头的注释里：先用一次原子的符号链接替换把 `/etc/static` 指向新的 `etc` 目录，见 [L27](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/system/etc/setup-etc.pl#L27)，再给 `/etc` 里的每个文件建一个指向 `/etc/static/...` 的符号链接，并清掉指向 `/etc/static` 却已经不存在的旧链接（L57 起）。所以 `/etc/cairn/cairn.conf` 其实是 `/etc/static/cairn/cairn.conf` 的链接，`/etc/static` 才是随 generation 换的那一个。我在这台机器上看到的是：

```text
$ readlink /etc/os-release; readlink /etc/static | sed 's|/nix/store/[a-z0-9]*-|/nix/store/<hash>-|'; readlink /run/current-system/etc | sed 's|/nix/store/[a-z0-9]*-|/nix/store/<hash>-|'
/etc/static/os-release
/nix/store/<hash>-etc/etc
/nix/store/<hash>-etc/etc
```

（手敲，不在 `lab/ch16/` 里）

这是这台主机的输出，每台机器、每次 switch 之后都不同，只当作形状的例子。

`/etc/static` 和 `/run/current-system/etc` 指向同一个 store 路径，这和 `setup-etc.pl` 的描述一致。`activate` 是由许多“片段”拼起来的，`etc` 只是其中一段，我把片段的标题列出来：

```text
$ grep -n '^#### Activation script snippet' "$(nix build .#nixosConfigurations.lab.config.system.build.toplevel --no-link --print-out-paths)/activate"
21:#### Activation script snippet binsh:
34:#### Activation script snippet users:
46:#### Activation script snippet specialfs:
68:#### Activation script snippet etc:
78:#### Activation script snippet modprobe:
90:#### Activation script snippet udevd:
106:#### Activation script snippet usrbinenv:
```

（手敲，不在 `lab/ch16/` 里）

`users` 片段排在 `etc` 之前，是 `users.users.cairn` 真正变成系统用户的地方：它调用 `update-users-groups.pl`，把 `users-groups.json` 里的声明应用到系统上。我在 toplevel 里看到的 `cairn` 条目是这样的：

```text
$ jq -c '.users[] | select(.name=="cairn")' "$(grep -o '/nix/store/[a-z0-9]*-users-groups.json' "$(nix build .#nixosConfigurations.lab.config.system.build.toplevel --no-link --print-out-paths)/activate" | head -n 1)"
{"autoSubUidGidRange":false,"createHome":false,"description":"cairn snapshot service","expires":null,"group":"cairn","hashedPassword":null,"hashedPasswordFile":null,"home":"/var/empty","homeMode":"700","initialHashedPassword":null,"initialPassword":null,"isSystemUser":true,"name":"cairn","password":null,"shell":"/run/current-system/sw/bin/nologin","subGidRanges":[],"subUidRanges":[],"uid":null}
```

（手敲，不在 `lab/ch16/` 里）

`uid` 是 `null`：模块里我没有指定数字，所以 uid 是激活时由脚本在系统用户范围里分配的，每台机器上可能不同。`shell` 是 `nologin`，`home` 是 `/var/empty`，这个用户不能登录，只能被 systemd 当作 `User=` 用。

## 写一个服务模块

`services.cairn` 在 `nixos/modules/cairn.nix` 里，85 行。第 15 篇的 `cairn-settings` 已经会声明 `cairn.repo`、`cairn.sources` 这些选项并渲染 `configText`，这一篇要做的是把它放进 NixOS 的壳子里：开关、包、设置、定时器，再加上用户、`/etc` 文件和 systemd 单元。先看这个模块对外有哪几个选项：

```text
$ nix eval .#nixosConfigurations.lab.options.services.cairn --apply 'o: builtins.filter (n: n != "_module") (builtins.attrNames o)' --json
["enable","onCalendar","package","settings"]
```

（手敲，不在 `lab/ch16/` 里）

四个。声明在文件的前 38 行：

```nix
# services.cairn：把 cairn 做成 NixOS 服务。
# 设置模块 cairn-settings（第 15 章）原样放进 settings 子模块，
# 渲染出的配置文本写进 /etc/cairn/cairn.conf，systemd 定时器按 onCalendar 触发快照。
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkOption types;
  cfg = config.services.cairn;
  exe = lib.getExe cfg.package;
  conf = "/etc/cairn/cairn.conf";
  inherit (cfg.settings.cairn) repo;
in
{
  options.services.cairn = {
    enable = lib.mkEnableOption "periodic cairn snapshots";

    package = lib.mkPackageOption pkgs "cairn" { };

    settings = mkOption {
      type = types.submodule {
        imports = [ ../../modules/cairn-settings.nix ];
        config.cairn.repo = lib.mkDefault "/var/lib/cairn/repo";
      };
      default = { };
      description = "Contents of cairn.conf, see `modules/cairn-settings.nix`.";
    };

    onCalendar = mkOption {
      type = types.str;
      default = "daily";
      description = "When the timer starts a snapshot, in `systemd.time(7)` syntax.";
      example = "03:00";
    };
  };
```

文件头的参数 `{ config, lib, pkgs, ... }:` 是所有 NixOS 模块的固定开头，`pkgs` 是第 15 篇讲过的 `_module.args.pkgs`。`let` 里的 `exe` 用 `lib.getExe`，它读包的 `meta.mainProgram`（[`lib/meta.nix` 的 L525 到 L537](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/meta.nix#L525-L537)），第 11 篇给 cairn 写了这个字段，它现在的值是：

```text
$ nix eval .#packages.x86_64-linux.cairn.meta.mainProgram
"cairn"
```

（手敲，不在 `lab/ch16/` 里）

`enable` 是 `lib.mkEnableOption`，在 [`lib/options.nix` 的 L187 到 L194](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/options.nix#L187-L194)：一个 `default = false` 的 `bool`，描述是 `"Whether to enable ${name}."`。`package` 是 `lib.mkPackageOption pkgs "cairn" { }`（同一文件的 L309 到 L346），它替你写好类型 `package`、默认值 `pkgs.cairn` 和描述 `"The cairn package to use."`。我把这三样查出来：

```text
$ nix eval --json .#nixosConfigurations.lab.options.services.cairn.package.defaultText
{"_type":"literalExpression","text":"pkgs.cairn"}
$ nix eval --json .#nixosConfigurations.lab.options.services.cairn.package.description
"The cairn package to use."
$ nix eval --json .#nixosConfigurations.lab.options.services.cairn.enable.description
"Whether to enable periodic cairn snapshots."
```

（手敲，不在 `lab/ch16/` 里）

`settings` 是整个模块最有意思的一个选项：它的类型是 `types.submodule`，子模块里 `imports` 了第 15 篇的 `cairn-settings.nix`，再用 `config.cairn.repo = lib.mkDefault "/var/lib/cairn/repo"` 给出这个宿主上的默认仓库位置。`mkDefault` 是优先级 1000，用户随手写的 `services.cairn.settings.cairn.repo = "/srv/backup";` 是 100，自然赢；两边都用 `mkDefault` 又给了不同的值，才会冲突（第 15 篇讲过）。这样设置模块本身不用改一个字，NixOS 的壳子只管默认值。`lab.nix` 里 `settings.cairn.sources = [ "/srv/data" ];` 就是通过这个选项进来的，“/etc 是怎么生成的”那一节看过渲染出来的 `cairn.conf`。

文件的第二部分是 `config`，用 `lib.mkIf cfg.enable` 包起来：

```nix
  config = lib.mkIf cfg.enable {
    users.users.cairn = {
      isSystemUser = true;
      group = "cairn";
      description = "cairn snapshot service";
    };
    users.groups.cairn = { };

    environment.etc."cairn/cairn.conf".text = cfg.settings.cairn.configText;
    environment.systemPackages = [ cfg.package ];
```

`mkIf` 的作用第 15 篇的练习 1 讲过：`config = if cfg.enable then ... else { }` 会无限递归，`mkIf` 把条件留在定义里。这里没有 `else` 分支：`enable = false` 时整个 `config` 不贡献任何定义，`services.cairn.*` 的其它选项仍然存在、仍可设置，只是什么都不会生成。`users.users.cairn` 声明一个系统用户和同名的组，`isSystemUser = true` 意味着不创建家目录、uid 在系统范围里分配，“/etc 是怎么生成的”那一节看过它在 `users-groups.json` 里的样子。`environment.etc` 的右边是 `configText`，所以 `cairn.conf` 一路都是纯字符串；`environment.systemPackages` 把包放进 `/run/current-system/sw/bin`，这样测试脚本里直接敲 `cairn` 就能找到它。

第三部分是 systemd，文件的最后 35 行：

```nix
    systemd = {
      # ReadWritePaths 在服务启动前就要挂载仓库目录，而 init 在 ExecStartPre
      # 里才创建它：没有这条规则，首次启动会因为目录不存在而 226/NAMESPACE。
      tmpfiles.rules = [ "d ${repo} 0750 cairn cairn -" ];

      services.cairn = {
        description = "cairn snapshot of ${lib.concatStringsSep ", " cfg.settings.cairn.sources}";
        serviceConfig = {
          Type = "oneshot";
          User = "cairn";
          Group = "cairn";
          StateDirectory = "cairn";
          ExecStartPre = "${exe} -c ${conf} init ${repo}";
          ExecStart = "${exe} -c ${conf} snapshot";
          ExecStartPost = "${exe} -c ${conf} prune";

          # 只读整个文件系统，仓库目录除外。
          ProtectSystem = "strict";
          ReadWritePaths = [ repo ];
          ProtectHome = "read-only";
          PrivateTmp = true;
          NoNewPrivileges = true;
        };
      };

      timers.cairn = {
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnCalendar = cfg.onCalendar;
          Persistent = true;
        };
      };
    };
  };
}
```

单元的 `Type = "oneshot"`：进程退出，单元就结束，`systemctl start cairn.service` 会一直阻塞到它跑完，这正是测试里“`start` 之后立刻查仓库”能成立的原因（日志里这条命令用了 0.48 秒）。三个 `Exec*` 的顺序是 `ExecStartPre` 跑 `cairn init`，`ExecStart` 跑 `cairn snapshot`，`ExecStartPost` 跑 `cairn prune`，按 `keep_*` 清理旧快照；测试里第二次 `start` 时 `init` 又跑了一遍，测试照样通过，说明它对已存在的仓库不报错。`User`/`Group` 让它们都用 `cairn` 用户跑，`StateDirectory = "cairn"` 让 systemd 在启动时创建 `/var/lib/cairn` 并交给这个用户。`ProtectSystem` 到 `NoNewPrivileges` 这五行是加固，“systemd 加固”那一节专门讲。

定时器：`wantedBy = [ "timers.target" ]` 让它随系统启动，`OnCalendar` 来自 `onCalendar` 选项，默认 `"daily"`；`Persistent = true`：按 `systemd.timer(5)`，这会把上次触发的时间存在磁盘上，定时器重新激活时如果错过了触发就立刻补跑一次，这对笔记本一类会关机的机器是对的。我用 `lab/ch16/option_query.sh` 把三个值从配置里读出来，不用构建任何东西：

```text
$ cat out/ch16/option_query.stdout
== services.cairn.settings.cairn.sources
["/srv/data"]

== systemd.services.cairn.serviceConfig.ExecStart
/nix/store/<hash>-cairn-0.1.0/bin/cairn -c /etc/cairn/cairn.conf snapshot

== systemd.timers.cairn.timerConfig
{"OnCalendar":"daily","Persistent":true}
```

`ExecStart` 里的 `/nix/store/<hash>-cairn-0.1.0` 就是 `lib.getExe cfg.package` 展开的结果，`-c /etc/cairn/cairn.conf` 指向“/etc 是怎么生成的”那一节生成的文件。这三条都是纯求值：我没有构建 toplevel，也没有启动任何东西，`nix eval` 沿着 `nixosConfigurations.lab.config` 读选项就够了。`etc_generated.sh` 打印的单元文件，是同一批选项渲染成 systemd 的 `ini` 之后的样子：

```ini
[Unit]
Description=cairn snapshot of /srv/data

[Service]
Environment="LOCALE_ARCHIVE=/nix/store/<hash>-glibc-locales-2.42-67/lib/locale/locale-archive"
Environment="PATH=/nix/store/<hash>-coreutils-9.11/bin:/nix/store/<hash>-findutils-4.11.0/bin:/nix/store/<hash>-gnugrep-3.12/bin:/nix/store/<hash>-gnused-4.10/bin:/nix/store/<hash>-systemd-261.1/bin:/nix/store/<hash>-coreutils-9.11/sbin:/nix/store/<hash>-findutils-4.11.0/sbin:/nix/store/<hash>-gnugrep-3.12/sbin:/nix/store/<hash>-gnused-4.10/sbin:/nix/store/<hash>-systemd-261.1/sbin"
Environment="TZDIR=/nix/store/<hash>-tzdata-2026c/share/zoneinfo"
ExecStart=/nix/store/<hash>-cairn-0.1.0/bin/cairn -c /etc/cairn/cairn.conf snapshot
ExecStartPost=/nix/store/<hash>-cairn-0.1.0/bin/cairn -c /etc/cairn/cairn.conf prune
ExecStartPre=/nix/store/<hash>-cairn-0.1.0/bin/cairn -c /etc/cairn/cairn.conf init /var/lib/cairn/repo
Group=cairn
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=/var/lib/cairn/repo
StateDirectory=cairn
Type=oneshot
User=cairn
```

（节选自 `out/ch16/etc_generated.stdout` 中 `cat etc/systemd/system/cairn.service` 的输出）

我没有写的三条 `Environment` 是 NixOS 的 `systemd.services` 模块自动加的：一个只含 coreutils、findutils、grep、sed 和 systemd 的 `PATH`，locale 和时区数据。这里要留意 `PATH`：它没有 rsync、gawk、util-linux，但 cairn 的包用 `wrapProgram` 给自己的 `PATH` 加了运行时依赖（`pkgs/cairn/package.nix` 的 L45 起，第 11 篇写的），所以 `cairn` 能跑，单元的 `PATH` 里缺它们不要紧。键的顺序是字母序（`ExecStart` 排在 `ExecStartPost` 和 `ExecStartPre` 之前），与我在 Nix 里写的顺序无关：`serviceConfig` 是一个 attrset，attrset 的键就是排好序的（第 2 篇讲过）。定时器的单元文件在同一份输出的最后：

```ini
[Unit]

[Timer]
OnCalendar=daily
Persistent=true


[Install]
WantedBy=timers.target
```

（节选自 `out/ch16/etc_generated.stdout` 中 `cat etc/systemd/system/cairn.timer` 的输出）

## 对照 restic.nix

写完以后，我想拿一个真实的、别人写的、做类似事情的模块对一对。nixpkgs 里的 `nixos/modules/services/backup/restic.nix` 正好是：定时备份，一个 oneshot 服务加一个定时器。它有 534 行，我只摘和 cairn 对得上的几处。先是声明：

```nix
            package = lib.mkPackageOption pkgs "restic" { };
```

（`restic.nix` 的 [L301](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/services/backup/restic.nix#L301)）

和我写的那一行只差一个包名，缩进多一层，因为它在子模块里。多出来的这层是第一个区别：restic 的选项是 `services.restic.backups.<name>`，一个 `attrsOf submodule`，每个备份有自己的仓库、密码文件、定时器，一份模块可以同时管任意多个备份；`services.cairn` 只有一个实例。所以 restic 的 `config` 不是 `mkIf enable`，而是 [L366](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/services/backup/restic.nix#L366) 的一个无条件 `config = {`，生成单元的那些语句对 `config.services.restic.backups` 做 `lib.mapAttrs'`（L390 和 L503）：没有备份，就没有单元。然后是服务的 `serviceConfig`：

```nix
          serviceConfig = {
            Type = "oneshot";
            ExecStart =
              # ...
              ++ checkCmd;
            User = backup.user;
            RuntimeDirectory = "restic-backups-${name}";
            CacheDirectory = "restic-backups-${name}";
            CacheDirectoryMode = "0700";
            PrivateTmp = true;
          }
          // lib.optionalAttrs (backup.environmentFile != null) {
            EnvironmentFile = backup.environmentFile;
          };
```

（`restic.nix` 的 [L451 到 L473](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/services/backup/restic.nix#L451-L473)，`# ...` 处省掉了 L454 到 L463，即 `ExecStart` 的命令列表和 `++ pruneCmd`）

读这一段，我看到三件事。第一，`Type = "oneshot"` 一样。第二，它用 `RuntimeDirectory` 和 `CacheDirectory` 让 systemd 自己创建要写的目录，没有 tmpfiles 规则；`CacheDirectoryMode = "0700"` 把权限也一起交给 systemd。第三，**它没有 `ProtectSystem`**：这一段里（L451 到 L473）加固类的指令只有 `PrivateTmp = true`，而 `User` 的默认值是 `"root"`（[L198 到 L200](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/services/backup/restic.nix#L198-L200)）。我猜这是有原因的：restic 要备份用户指定的任意路径，还可能要读密码文件和 rclone 配置，沙盒越紧，用户越容易撞墙；cairn 的 `sources` 是显式列出的，写目标只有仓库，所以可以收得更紧。这只是我的猜测，我没有去读 restic 模块的提交历史。

最后是定时器：

```nix
    systemd.timers = lib.mapAttrs' (
      name: backup:
      lib.nameValuePair "restic-backups-${name}" {
        wantedBy = [ "timers.target" ];
        inherit (backup) timerConfig;
        unitConfig.X-OnlyManualStart = true;
      }
    ) (lib.filterAttrs (_: backup: backup.timerConfig != null) config.services.restic.backups);
```

（`restic.nix` 的 [L503 到 L510](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/services/backup/restic.nix#L503-L510)）

`wantedBy = [ "timers.target" ]` 和我的一样。区别是 `timerConfig` 直接是用户可写的整个 attrset（类型 `attrsOf unitOption`，默认值 `{ OnCalendar = "daily"; Persistent = true; }`，在 [L180 到 L185](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/services/backup/restic.nix#L180-L185)），可以写 `RandomizedDelaySec`；`null` 表示不建定时器；我的 `onCalendar` 只开放一个字符串，默认值和它一样，但想加 `RandomizedDelaySec` 就得改模块，这是 restic 这一处设计比我灵活的地方。`unitConfig.X-OnlyManualStart = true` 我在 `switch-to-configuration` 的源码里找到了它被读取的地方（`pkgs/by-name/sw/switch-to-configuration-ng/src/main.rs` 的 L740、L995、L1006 和 L1265），带这个键的单元在切换配置时会被跳过，不被自动启动或重启；它对 restic 的定时器意味着什么，我没有再往下追，cairn 的单元没有设它。

读 `restic.nix` 的另一个收获是我找到了 `borgbackup.nix` 的 [L237](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/services/backup/borgbackup.nix#L237) 的一行注释：`# Paths listed in ReadWritePaths must exist before service is started`。这正是我撞上的墙，“为什么要一条 tmpfiles 规则”那一节讲它。

## NixOS 测试框架

`nixos/tests/cairn.nix` 的开头 15 行：

```nix
# services.cairn 的虚拟机测试：启动一个 NixOS 节点，跑两次快照，
# 检查硬链接、定时器，并把测得的数值以 `firn: <key> <value>` 打印出来。
{ pkgs, cairnModule }:
pkgs.testers.runNixOSTest {
  name = "cairn";

  # 默认节点共用测试的只读 pkgs，不允许再设 nixpkgs.overlays；
  # nixosModules.cairn 要自己加 overlay，所以关掉只读。
  node.pkgsReadOnly = false;

  nodes.machine = {
    imports = [ cairnModule ];
    services.cairn.enable = true;
    services.cairn.settings.cairn.sources = [ "/srv/data" ];
  };
```

`pkgs.testers.runNixOSTest` 在 [`pkgs/build-support/testers/default.nix` 的 L196 到 L210](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/testers/default.nix#L196-L210)：它把你给的模块交给 `nixos/lib` 的 `runTest`，并设 `hostPkgs = pkgs` 和 `node.pkgs = pkgsLinux`。所以一个 NixOS 测试本身又是一次 `evalModules`：`nodes.machine` 是一个完整的 NixOS 配置（和 `nixosConfigurations.lab` 一样是完整的 NixOS 配置），`testScript` 是另一个选项，它的值是一段 Python。这个测试的结果是一个 derivation，名字是 `vm-test-run-cairn`，**构建它就是跑它**：构建过程里用 QEMU 启动节点，执行脚本，脚本抛异常，构建就失败。

`node.pkgsReadOnly = false` 这一行不能省。`nixos/lib/testing/nodes.nix` 的 [L265 到 L274](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/lib/testing/nodes.nix#L265-L274) 说，只要 `node.pkgs` 不是 `null`（`runNixOSTest` 设了），默认就把 `nixpkgs.*` 选项全部锁成只读（L314 到 L317 引入 `read-only.nix`）。`nixosModules.cairn` 恰好要设 `nixpkgs.overlays`，两边就打架。我写了一个去掉那一行的精简测试，求值 `drvPath`，文件是 `/tmp/scratch16/readonly.nix`；它和 `nixos/tests/cairn.nix` 不止差 `pkgsReadOnly`：名字不同，没设 `sources`，`testScript` 只有一行，`pkgs` 取自 `firn.inputs`：

```nix
# The VM test of cairn-vm, minus `node.pkgsReadOnly = false`.
{ firn }:
let
  pkgs = firn.inputs.nixpkgs.legacyPackages.x86_64-linux;
in
pkgs.testers.runNixOSTest {
  name = "cairn-readonly";
  nodes.machine = {
    imports = [ firn.nixosModules.default ];
    services.cairn.enable = true;
  };
  testScript = ''
    machine.wait_for_unit("multi-user.target")
  '';
}
```

```text
$ nix eval --impure --raw --expr '(import /tmp/scratch16/readonly.nix { firn = builtins.getFlake (toString ./.); }).drvPath' 2>&1 | grep -E 'is defined multiple times|is set to read-only'
       error: The option `nodes.machine.nixpkgs.overlays' is defined multiple times while it's expected to be unique.
       nixpkgs.overlays is set to read-only
```

（手敲，不在 `lab/ch16/` 里）

第二行的文字来自 `nixos/modules/misc/nixpkgs/read-only.nix` 的 [L36 到 L38](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/misc/nixpkgs/read-only.nix#L36-L38)：`overlays` 的类型是 `types.unique { message = ... } types.anything`，“恰好一个定义”，谁再写一个就冲突。代价写在 `node.pkgsReadOnly` 的说明里，在 L269：关掉只读会让测试的求值慢一点。

节点里没有 `boot.loader`、没有 `fileSystems`，也没有 `virtualisation.memorySize`，这些由测试框架的节点模块提供，所以和 `lab.nix` 比，测试节点短得多；`nodes.machine` 也是从同一份 `module-list.nix` 起步，这是我的推断，没有单独数它的模块数。`testScript` 的开头是普通的 Python（我按 PEP 8 排的，Nix 的 `''` 字符串把它原样交给驱动）：

```python
    import re

    conf = "/etc/cairn/cairn.conf"
    # root 直接跑会在仓库里留下 root 的文件，所以命令行也用 cairn 用户。
    cairn = f"runuser -u cairn -- cairn -c {conf}"


    def report(key, value):
        print(f"firn: {key} {value}")


    machine.wait_for_unit("multi-user.target")
    machine.succeed("mkdir -p /srv/data")
    machine.succeed("echo alpha > /srv/data/a.txt")
    machine.succeed("echo beta > /srv/data/b.txt")
```

（节选自 `nixos/tests/cairn.nix` 的 L18 到 L32，这段代码在 `''` 字符串里，缩进是 4 个空格）

`machine` 是测试驱动注入的全局名字，就是 `nodes.machine` 那台虚拟机。驱动在 `nixos/lib/test-driver`，是一个 Python 程序：`machine.wait_for_unit(...)` 在 [`machine/__init__.py` 的 L372](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/lib/test-driver/src/test_driver/machine/__init__.py#L372)，它轮询 unit 的 `ActiveState`，遇到 `failed` 就抛 `RequestedAssertionFailed`，默认超时 15 分钟；`machine.succeed(*commands)` 在 [L479](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/lib/test-driver/src/test_driver/machine/__init__.py#L479)，在虚拟机里执行命令，退出码非零就抛异常，否则返回标准输出，所以 `listing = machine.succeed(...)` 可以拿来继续断言。第二次快照的部分：

```python
    machine.succeed("echo gamma > /srv/data/b.txt")
    machine.succeed("sleep 1")
    machine.succeed("systemctl start cairn.service")
    listing = machine.succeed(f"{cairn} list")
    snapshots = listing.strip().splitlines()[1:]
    assert len(snapshots) == 2, listing
    report("snapshots_after_second", len(snapshots))

    links = machine.succeed(
        "stat -c %h /var/lib/cairn/repo/latest/srv/data/a.txt"
    ).strip()
    assert links == "2", links
    report("hardlinks_unchanged", links)
```

（节选自 `nixos/tests/cairn.nix` 的 L44 到 L56）

`sleep 1` 是因为 cairn 的快照名带时间戳，我没有读 cairn 怎么取名，所以按最保守的猜测等一秒，避免两次快照撞名。`stat -c %h` 打印硬链接数：`a.txt` 在两次快照之间没变，第二次快照里的 `a.txt` 和第一次的是同一个 inode（硬链接），所以链接数是 2；`b.txt` 被我改过，是新文件，链接数是 1。测试输出里的 `hardlinks_unchanged 2`、`hardlinks_changed 1` 就是这个。我没有把 `sleep 1` 去掉验证这个猜测。

虚拟机测试要跑多久？`nix log` 保留了最近一次构建的日志，我从里面把每条命令的耗时抠出来：

```text
$ nix log .#checks.x86_64-linux.cairn-vm | grep -E 'must succeed|waiting for unit|run the VM|test script finished' | grep -E 'finished|^vm' | sed 's/^[^ ]*> //'
machine: (finished: waiting for unit multi-user.target, in 18.27 seconds)
machine: (finished: must succeed: mkdir -p /srv/data, in 0.02 seconds)
machine: (finished: must succeed: echo alpha > /srv/data/a.txt, in 0.02 seconds)
machine: (finished: must succeed: echo beta > /srv/data/b.txt, in 0.01 seconds)
machine: (finished: must succeed: systemctl start cairn.service, in 0.48 seconds)
machine: (finished: must succeed: runuser -u cairn -- cairn -c /etc/cairn/cairn.conf list, in 0.11 seconds)
machine: (finished: must succeed: runuser -u cairn -- cairn -c /etc/cairn/cairn.conf verify, in 0.07 seconds)
machine: (finished: must succeed: echo gamma > /srv/data/b.txt, in 0.01 seconds)
machine: (finished: must succeed: sleep 1, in 1.02 seconds)
machine: (finished: must succeed: systemctl start cairn.service, in 0.44 seconds)
machine: (finished: must succeed: runuser -u cairn -- cairn -c /etc/cairn/cairn.conf list, in 0.11 seconds)
machine: (finished: must succeed: stat -c %h /var/lib/cairn/repo/latest/srv/data/a.txt, in 0.02 seconds)
machine: (finished: must succeed: stat -c %h /var/lib/cairn/repo/latest/srv/data/b.txt, in 0.02 seconds)
machine: (finished: must succeed: systemctl list-timers, in 0.02 seconds)
machine: (finished: must succeed: systemd-analyze security cairn.service --no-pager, in 0.06 seconds)
(finished: run the VM test script, in 20.67 seconds)
test script finished in 20.71s
```

（手敲，不在 `lab/ch16/` 里）

20.67 秒的脚本里，等 `multi-user.target` 就占了 18.27 秒，约 88%；两次 `systemctl start cairn.service` 各用不到半秒（含 `init`、`snapshot`、`prune` 三步）。除开等待开机，所有其余步骤加起来是 2.4 秒，其中 1.02 秒是我自己写的 `sleep 1`。这是一个样本。`vm_test_host.sh` 报告的是 `nix build --rebuild` 的墙钟 21 秒，和日志里的 20.71 秒对得上；同一个测试的一个新变体（`hardened.nix`，见练习 1）第一次构建，要先构建新配置的 `etc`、单元文件和测试驱动，我用 `time` 量到 52.5 秒，同一个变体之后用 `--rebuild` 重跑量到过 25.1 秒和 23.9 秒。这些都是单次采样，只说明量级。

测试需要什么机器？`nix derivation show` 能看到这个测试 derivation 声明的 `requiredSystemFeatures`：

```text
$ nix derivation show .#checks.x86_64-linux.cairn-vm | jq -r '.derivations | to_entries[0].value.env.requiredSystemFeatures'
kvm nixos-test
```

（手敲，不在 `lab/ch16/` 里）

`kvm nixos-test` 来自 `nixos/lib/testing/run.nix`：L162 把 `requiredFeatures` 里为真的名字都放进 `requiredSystemFeatures`，L59 到 L64 里 `kvm` 的默认值是 `isLinux`，也就是在 Linux 上默认要求 KVM。构建这个 derivation 的机器必须在 `system-features` 里声明 `kvm`；“环境”那一节写过我这台机器的 `system-features` 是 `benchmark big-parallel kvm nixos-test`，所以能跑。没有 `kvm` 的机器上，Nix 会因为找不到满足 `requiredSystemFeatures` 的构建机而拒绝构建，这是我读代码得出的推断，我没有在一台没有 KVM 的机器上试过。

## 为什么要一条 tmpfiles 规则

模块里有这样一行，带着一条注释：

```nix
      # ReadWritePaths 在服务启动前就要挂载仓库目录，而 init 在 ExecStartPre
      # 里才创建它：没有这条规则，首次启动会因为目录不存在而 226/NAMESPACE。
      tmpfiles.rules = [ "d ${repo} 0750 cairn cairn -" ];
```

这条规则看起来多余，把它去掉就知道为什么了：别的都不动，把同一个测试再跑一遍。Nix 文件放在 `/tmp/scratch16/no_tmpfiles.nix`，复用仓库里的 `nixos/tests/cairn.nix`，只把模块换成“`nixosModules.default` 加一条清空 tmpfiles 规则的定义”：

```nix
# Same VM test, but with the module's tmpfiles rule thrown away.
{ firn }:
let
  pkgs = firn.inputs.nixpkgs.legacyPackages.x86_64-linux;
in
import "${firn}/nixos/tests/cairn.nix" {
  inherit pkgs;
  cairnModule = {
    imports = [ firn.nixosModules.default ];
    systemd.tmpfiles.rules = pkgs.lib.mkForce [ ];
  };
}
```

```text
$ nix build --impure -L --no-link --expr 'import /tmp/scratch16/no_tmpfiles.nix { firn = builtins.getFlake (toString ./.); }' 2>&1 | sed 's/^[^ ]*> //' | grep -E '^machine #.*(cairn.service: (Failed|Control)|Failed to start)|^!!! Req'
machine # [   18.514821] (cairn)[915]: cairn.service: Failed to set up mount namespacing: /var/lib/cairn/repo: No such file or directory
machine # [   18.519081] (cairn)[915]: cairn.service: Failed at step NAMESPACE spawning /nix/store/08miknl7zqxj4xrcvp27jjcpf9grfaj8-cairn-0.1.0/bin/cairn: No such file or directory
machine # [   18.527181] systemd[1]: cairn.service: Control process exited, code=exited, status=226/NAMESPACE
machine # [   18.530496] systemd[1]: cairn.service: Failed with result 'exit-code'.
machine # [   18.534300] systemd[1]: Failed to start cairn snapshot of /srv/data.
!!! RequestedAssertionFailed: command `systemctl start cairn.service` failed (exit code 1)
```

（手敲，不在 `lab/ch16/` 里）

`status=226/NAMESPACE` 是 systemd 在给进程搭挂载命名空间时失败：`Failed to set up mount namespacing: /var/lib/cairn/repo: No such file or directory`。`ReadWritePaths = [ repo ]` 要求 systemd 在 `exec` 任何进程之前，在新的命名空间里把 `/var/lib/cairn/repo` 单独挂成可写；这个目录不存在，就挂不了。而创建它的 `cairn init` 偏偏是 `ExecStartPre`，自己也要在这个命名空间里跑，鸡和蛋。`StateDirectory = "cairn"` 只替我创建了 `/var/lib/cairn`，没有创建作为子目录的 `repo`。`tmpfiles.rules` 里的 `d /var/lib/cairn/repo 0750 cairn cairn -` 在开机时由 `systemd-tmpfiles` 建出这个目录，属主 `cairn:cairn`，权限 0750，最后的 `-` 是留空的 age 字段：`tmpfiles.d(5)` 说 `d` 类型的目录内容只有在写了 age 时才会按时间清理。我在 toplevel 里查了，这条规则确实进了 `etc/tmpfiles.d/00-nixos.conf`：

```text
$ cat "$(nix build .#nixosConfigurations.lab.config.system.build.toplevel --no-link --print-out-paths)/etc/tmpfiles.d/00-nixos.conf" | grep -n cairn
4:d /var/lib/cairn/repo 0750 cairn cairn -
```

（手敲，不在 `lab/ch16/` 里）

同一个坑 `borgbackup.nix` 已经踩过，它的做法也是用 tmpfiles 建目录，它的 `mkTmpfiles` 紧跟在那行注释之后。

这不是唯一的解法，`systemd.exec(5)` 说 `ReadWritePaths=` 里的路径可以加 `-` 前缀，“不存在时忽略”；我在练习 2 里试了这条路。新的 tmpfiles 规则在 `switch` 之后什么时候被创建，我没有在真机上验证，我手上的验证全部来自虚拟机里的冷启动：它每次从开机开始，我猜 `systemd-tmpfiles-setup` 在 `multi-user.target` 之前就把目录建好了。

## systemd 加固：8.4 分是怎么来的

模块里有五行加固：`ProtectSystem = "strict"`、`ReadWritePaths`、`ProtectHome = "read-only"`、`PrivateTmp`、`NoNewPrivileges`。它们够不够？我不想靠感觉判断，systemd 自带一个打分器，`systemd-analyze security <unit>`：它把一个单元用到的沙盒指令逐条对照，每一行打 ✓ 或 ✗，✗ 的行带一个 0.1 到 0.5 的权重，最后给出一个 0 到 10 的“Overall exposure level”。测试脚本在最后一步跑它，用一个正则把分数和等级抠出来：

```python
    security = machine.succeed(
        "systemd-analyze security cairn.service --no-pager"
    )
    match = re.search(
        r"Overall exposure level for cairn.service: ([0-9.]+) (\w+)",
        security,
    )
    assert match, security
    report("exposure", match.group(1))
    report("exposure_level", match.group(2))
```

（节选自 `nixos/tests/cairn.nix` 的 L67 到 L76；它在虚拟机里跑的是 systemd 261.1，我这台机器上的 `systemd-analyze` 是 260.5，两者打分可能不同，所以我只引用虚拟机里的数字）

文章开头那份输出已经给了答案：`firn: exposure 8.4`，`firn: exposure_level EXPOSED`。我想看到每一行，而不只是总分，所以写了第二个测试：开机，起一次服务，把整张表打印出来，给每行加上 `SEC|` 前缀方便过滤。Nix 文件放在 `/tmp/scratch16/probe.nix`，参数 `hardened` 默认 `false`，等下还要用它：

```nix
# Boots the cairn node, starts the service once and prints the whole
# `systemd-analyze security` table, one `SEC|` line per row.
{
  firn,
  hardened ? false,
}:
let
  pkgs = firn.inputs.nixpkgs.legacyPackages.x86_64-linux;
in
pkgs.testers.runNixOSTest {
  name = "cairn-probe";
  node.pkgsReadOnly = false;
  nodes.machine = {
    imports = [ firn.nixosModules.default ];
    services.cairn.enable = true;
    services.cairn.settings.cairn.sources = [ "/srv/data" ];
    systemd.services.cairn.serviceConfig = pkgs.lib.optionalAttrs hardened {
      CapabilityBoundingSet = "";
      SystemCallFilter = [
        "@system-service"
        "~@privileged"
      ];
    };
  };
  testScript = ''
    machine.wait_for_unit("multi-user.target")
    machine.succeed("mkdir -p /srv/data && echo a > /srv/data/a.txt")
    machine.succeed("systemctl start cairn.service")
    out = machine.succeed("systemd-analyze security cairn.service --no-pager")
    for line in out.splitlines():
        print("SEC|" + line)
  '';
}
```

```text
$ nix build --impure -L --no-link --expr 'import /tmp/scratch16/probe.nix { firn = builtins.getFlake (toString ./.); }' 2>&1 | grep -o 'SEC|.*' | awk '!s[$0]++' > before.txt
$ grep -c '^SEC|✗' before.txt; grep -c '^SEC|✓' before.txt; tail -n 1 before.txt
71
10
SEC|→ Overall exposure level for cairn.service: 8.4 EXPOSED :-(
```

（手敲，不在 `lab/ch16/` 里）

`awk '!s[$0]++'` 去重，因为同一行输出会在日志里出现不止一次，我没有追究原因。81 行里 71 行是 ✗，10 行是 ✓。✓ 的 10 行里有我写的 `User=`、`ProtectSystem=`、`PrivateTmp=`、`NoNewPrivileges=`，另外 6 行是默认值就满足的：`AmbientCapabilities=`、`SupplementaryGroups=`、`KeyringMode=`、`Delegate=`、`NotifyAccess=` 和 `PrivateMounts=`。`ProtectHome = "read-only"` 那一行仍然是 ✗，权重 0.1，它的说明文字是“Service has read-only access to home directories”；我猜换成 `ProtectHome = true` 才会变成 ✓，没有试。我把 ✗ 行的权重按值数一下：

```text
$ grep -E '^SEC\|✗' before.txt | sed 's/^SEC|//' | awk '{ print $NF }' | sort | uniq -c
     36 0.1
     28 0.2
      6 0.3
      1 0.5
```

（手敲，不在 `lab/ch16/` 里）

71 个 ✗，权重总和是 $36 \times 0.1 + 28 \times 0.2 + 6 \times 0.3 + 0.5 = 11.5$，而总分是 8.4，所以总分不是这些权重的简单求和，它怎么从 11.5 缩成 8.4，我没有去读 `systemd-analyze` 的源码，不下结论。权重最大的那一行是 `PrivateNetwork=`（0.5，服务能访问宿主网络），然后是 6 个 0.3 的行：`RestrictNamespaces=~user`、`CapabilityBoundingSet=~CAP_SET(UID|GID|PCAP)`、`RestrictAddressFamilies=~…`、`RestrictAddressFamilies=~AF_(INET|INET6)`、`CapabilityBoundingSet=~CAP_SYS_PTRACE` 和 `CapabilityBoundingSet=~CAP_SYS_ADMIN`。cairn 只做本地的 `rsync`，用不到网络、用不到 ptrace、用不到任何 capability，这些 ✗ 是我白白留着的权限。怎么把它们收掉，是练习 1 的内容，答案里有“之后”的分数。

## 从 toplevel 到运行中的系统：switch-to-configuration

之前的小节全是“在 store 里造出一个系统”，没有碰运行中的机器。这一节是我最想弄懂的部分：`nixos-rebuild switch` 的“switch”。`toplevel` 里的 `bin/switch-to-configuration` 是一个程序，不带参数运行它，打印用法（在这台机器上，当前系统的那一份，不需要 root）：

```text
$ /run/current-system/bin/switch-to-configuration; echo "exit: $?"
Usage: switch-to-configuration [check|switch|boot|test|dry-activate]
check:        run pre-switch checks and exit
switch:       make the configuration the boot default and activate now
boot:         make the configuration the boot default
test:         activate the configuration, but don't make it the boot default
dry-activate: show what would be done if this configuration were activated

exit: 1
```

（手敲，不在 `lab/ch16/` 里）

这段文本就是 [`pkgs/by-name/sw/switch-to-configuration-ng/src/main.rs` 的 L1746 到 L1757](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/sw/switch-to-configuration-ng/src/main.rs#L1746-L1757) 里的 `usage` 函数。这个程序现在是 Rust 写的（`-ng` 后缀），`nixos/modules/system/activation/switchable-system.nix` 的 [L54 到 L66](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/system/activation/switchable-system.nix#L54-L66) 把它软链到 `$out/bin/switch-to-configuration`，再用 `wrapProgram` 设一串环境变量：`OUT`、`TOPLEVEL`、`INSTALL_BOOTLOADER`、`PRE_SWITCH_CHECK`、`SYSTEMD` 等，所以同一个二进制在不同的 generation 里“知道”自己属于哪个 toplevel。我在 `lab/ch16/switch_anatomy_host.sh` 里看了这台机器上它的外壳：

（节选自 `lab/ch16/switch_anatomy_host.sh` 的 L17 到 L28）

```bash
show() {
  echo "== $1"
  bash -c "$1" 2>&1 | sed 's/^/volatile: /'
  echo
}

main() {
  show 'file /run/current-system/bin/switch-to-configuration'
  show 'ls -l /nix/var/nix/profiles | grep system | tail -3'
  show 'cat /run/current-system/nixos-version'
  show 'ls /run/current-system'
}
```

```text
$ cat out/ch16/switch_anatomy_host.stdout
== file /run/current-system/bin/switch-to-configuration
volatile: /run/current-system/bin/switch-to-configuration: a /nix/store/hc49zakwkkyp9zlyl80b71jhxkpn4hsx-bash-5.3p9/bin/bash -e script, ASCII text executable

== ls -l /nix/var/nix/profiles | grep system | tail -3
volatile: lrwxrwxrwx 1 root root   93 Oct 31 07:18 system-129-link -> /nix/store/zp5jcnrsl501dmpwv5gmlbk2rzd6l29s-nixos-system-thinkpad-t14s-26.05.20261029.6f06d20
volatile: lrwxrwxrwx 1 root root   93 Oct 31 07:35 system-130-link -> /nix/store/h3q7fvkv2hr55av2jkdbgd6na0yr79na-nixos-system-thinkpad-t14s-26.05.20261029.6f06d20
volatile: lrwxrwxrwx 1 root root   93 Nov  4 04:07 system-131-link -> /nix/store/8affpvfdhawnps4q3zw7yvdn0kh4fl6d-nixos-system-thinkpad-t14s-26.05.20261102.7dcdd87

== cat /run/current-system/nixos-version
volatile: 26.05.20261102.7dcdd87
== ls /run/current-system
volatile: activate
volatile: bin
volatile: boot.json
volatile: configuration-name
volatile: dry-activate
volatile: etc
volatile: extra-dependencies
volatile: firmware
volatile: init
volatile: init-interface-version
volatile: initrd
volatile: kernel
volatile: kernel-modules
volatile: kernel-params
volatile: nixos-version
volatile: prepare-root
volatile: specialisation
volatile: sw
volatile: switch-inhibitors
volatile: system
volatile: systemd
```

每一行都带 `volatile:`，因为它们全是这台机器当下的状态：换一台机器、换一天，输出都不同，我只当作形状的例子。`file` 说它是一个 `bash -e` 脚本，对，`wrapProgram` 把 Rust 二进制包成了一个设环境变量再 `exec` 的 bash 脚本。`ls -l /nix/var/nix/profiles | grep system` 列出的是 generation：`system-131-link` 是一个符号链接，指向一个 `nixos-system-...` 的 store 路径，也就是一个 toplevel；`/run/current-system` 的内容和 `lab` 的 toplevel（见“system.build.toplevel 是一个 store 路径”那一节）完全同形，21 个条目，一一对应。

那四个动作到底各做了什么？我读 `main.rs` 的结果如下，行号都是这个 rev 上的：

- 动作的枚举在 [L111 到 L117](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/sw/switch-to-configuration-ng/src/main.rs#L111-L117)，`from_str` 在 L119 到 L132，认五个字：`switch`、`boot`、`test`、`dry-activate`、`check`。不带参数或认不出来就 `usage` 并以 1 退出（L2713 到 L2715）；不是 root 就 `must be run as the root user`（L2717 到 L2721）。
- 先跑预切换检查（L1829 到 L1836，除非 `NIXOS_NO_CHECK=1`）；`check` 在这里就返回（L1838 到 L1840）。
- `switch` 和 `boot` 会安装引导项：`do_install_bootloader`（L1843 到 L1846），也就是执行 toplevel 的 `INSTALL_BOOTLOADER` 脚本，把这个 generation 写进引导菜单；`test` 不会。然后 `syncfs` 一次 `/nix/store`（L1848 到 L1857）。
- `boot` 到此为止：`std::process::exit(0)`（L1859 到 L1861）。引导项写好了，当前系统一点没动，下次重启才生效。
- 接着比较当前和新系统的 `init-interface-version`，不一样就警告“要重启才生效”并以 100 退出（L1863 到 L1879）。
- 然后算出要停、要重启、要重载的单元；`dry-activate` 在这里只打印：`would stop the following units: ...`、`would NOT stop the following changed units: ...`、`would activate the configuration...`，再跑 toplevel 里的 `dry-activate` 脚本（L2045 到 L2071），不改任何东西。
- 其余动作（`switch` 和 `test`）先停单元，再执行 toplevel 里的 `activate`（L2230 到 L2244，`eprintln!("activating the configuration...")`），最后启动、重启、重载单元。所以 `switch` 和 `test` 的区别只有一处：`switch` 在激活之前多做了“写引导项”这一步。

`activate` 这个脚本就是“/etc 是怎么生成的”那一节看过的东西：它按片段依次执行，片段名是 `binsh`、`users`、`specialfs`、`etc`、`modprobe`、`udevd` 和 `usrbinenv`。`switch-to-configuration` 负责“哪些单元要动”，`activate` 负责“系统状态本身”。

怎么处理“单元该不该动”也有规则：`restic.nix` 给定时器设的 `X-OnlyManualStart` 就是在 L740 到 L742 的分支里被读到，被标记的单元放进 `units_to_skip`，L995 的 `MigrationAction::for_active_unit` 对它返回 `Self::Skip`；没有标记的单元默认按 `X-RestartIfChanged = true` 处理：改了就重启，对应 L738 和 L993。`cairn.service` 是一个 oneshot，没有 `wantedBy`，不在“启动中的单元”里，我猜它在 `switch` 时不会被动；`cairn.timer` 是新单元、`wantedBy = timers.target`，会被启动。这是我读代码的推断，我没有在真机上 `switch` 验证，更没有让它改动这台机器。

## generation 与引导项

`nixos-rebuild` 在调用 `switch-to-configuration` 之前，还做一件事，决定了“generation”是什么。看 `pkgs/by-name/ni/nixos-rebuild-ng/src/nixos_rebuild/services.py` 的 [L225 到 L250](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/ni/nixos-rebuild-ng/src/nixos_rebuild/services.py#L225-L250)：

```python
        case Action.SWITCH | Action.BOOT if not args.rollback:
            nix.set_profile(
                profile,
                path_to_config,
                target_host=target_host,
                elevate=args.elevator,
            )
            nix.switch_to_configuration(
                path_to_config,
                action,
                target_host=target_host,
                elevate=args.elevator,
                specialisation=args.specialisation,
                install_bootloader=args.install_bootloader,
            )
            print_result("Done. The new configuration is", path_to_config)
        case Action.SWITCH | Action.BOOT | Action.TEST | Action.DRY_ACTIVATE:
            nix.switch_to_configuration(
                path_to_config,
                action,
                target_host=target_host,
                elevate=args.elevator,
                specialisation=args.specialisation,
                install_bootloader=args.install_bootloader,
            )
            print_result("Done. The new configuration is", path_to_config)
```

只有 `switch` 和 `boot` 会先 `set_profile`；`test` 和 `dry-activate` 直接去 `switch_to_configuration`。`set_profile` 在 `nix.py` 的 [L693 到 L697](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/ni/nixos-rebuild-ng/src/nixos_rebuild/nix.py#L693-L697)，核心是一句 `nix-env -p /nix/var/nix/profiles/system --set <toplevel>`，它之前会先检查 `<toplevel>/nixos-version` 是否存在（L666 到 L691）：第 9 篇讲过的 profile，把一个 store 路径设成 `system` 这个 profile 的新 generation，也就是在 `/nix/var/nix/profiles` 里多一个 `system-N-link`。所以 **generation 就是 profile 的一次 `--set`**，`test` 不 `--set`，不留下 generation。真正执行切换的是 L738 到 L739：`<toplevel>/bin/switch-to-configuration <action>`，外面包着 `systemd-run`（L37 到 L53；宿主上没有 `/run/systemd/system` 或设了 `NIXOS_REBUILD_NO_SYSTEMD_RUN` 时不包，见 L723 到 L737，单元名 `nixos-rebuild-switch-to-configuration`；我猜是为了让切换在你的终端断开时继续跑，没有验证）。

引导项是另一回事：`switch-to-configuration` 的 `INSTALL_BOOTLOADER` 脚本读 profile 里的所有 generation，为每个写一个条目。systemd-boot 的构建脚本用 `nix-env --list-generations -p /nix/var/nix/profiles/system` 枚举（`systemd-boot-builder.py` 的 L436 到 L441），generation 的目录名是 `system-<N>-link`（L278 到 L284）；GRUB 的 `install-grub.pl` 在 [L606](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/system/boot/loader/grub/install-grub.pl#L606) 为 `/nix/var/nix/profiles/system` 加一个“All configurations”子菜单。`boot.loader.systemd-boot.configurationLimit` 可以限制菜单里保留的 generation 数（[`systemd-boot.nix` 的 L234 到 L245](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/system/boot/loader/systemd-boot/systemd-boot.nix#L234-L245)），默认 `null`，没有上限。我没有权限读这台机器的 `/boot`（`ls /boot` 报 `Permission denied`），所以没有看到真实的引导项；`lab` 用的是 `boot.loader.grub`，`device = "nodev"`，也不会真的装。

generation 也是垃圾回收的根。我用 `nix-store --gc --print-roots`（它只列根，不回收任何东西）数这台机器上的 `system-N-link`：

```text
$ nix-store --gc --print-roots | grep -c 'system-[0-9]*-link'
5
$ ls -l /nix/var/nix/gcroots | grep -c 'booted-system\|current-system'
2
```

（手敲，不在 `lab/ch16/` 里；这台机器上的值，每台机器都不同）

5 个 generation 链接各是一个根，外加 `gcroots` 里的 `booted-system` 和 `current-system` 两个。所以回滚的“后悔药”不是魔法：旧 generation 的整个闭包被这些符号链接钉在 store 里，直到有人删掉链接再 GC。我的这台机器上还有多少个 generation，我用 `nh` 看（它只读 profile，不改任何东西）：

```text
$ nh os info | head -n 5
NixOS 26.05.20261102.7dcdd87
Generation No Build Date           NixOS Version          Kernel  Closure Size
131 (current) 2026-11-04 04:07:12  26.05.20261102.7dcdd87 6.18.60 57.4 GB     
130           2026-10-31 07:33:46  26.05.20261029.6f06d20 6.18.59 57.3 GB     
129           2026-10-31 06:42:43  26.05.20261029.6f06d20 6.18.59 57.2 GB     
```

（手敲，不在 `lab/ch16/` 里；volatile，每台机器不同）

每个 generation 是 57 GB 上下，这个数是闭包大小，不是新增占用，我猜相邻 generation 之间的大部分路径是共享的。我没有量过删掉旧 generation 能回收多少，这条命令也不会去量。

## nixos-rebuild 还是 nh

我这台机器上同时有两个工具，`nixos-rebuild`（`nixos-rebuild-ng`，Python 重写的版本）和 `nh` 4.4.2。`nixos-rebuild` 先构建 toplevel，在 `switch` 或 `boot` 时再设 profile 并调 `switch-to-configuration`（上一小节“generation 与引导项”读过源码）；`nh` 的内部实现我没有读，这里只能比较子命令和它们的说明文字。`nixos-rebuild` 的动作，用 `man` 页里的标题数出来：

```text
$ nixos-rebuild --help 2>/dev/null | grep -E '^     [a-z][a-z-]+$' | tr -d ' ' | paste -sd' '
switch boot test build dry-build dry-activate edit repl build-image build-vm build-vm-with-bootloader
```

（手敲，不在 `lab/ch16/` 里）

`nh os` 的子命令：

```text
$ nh os --help 2>&1 | sed -n '/^Commands:/,/^$/p'
Commands:
  switch       Build and activate the new configuration, and make it the boot default
  boot         Build the new configuration and make it the boot default
  test         Build and activate the new configuration
  build        Build the new configuration
  repl         Load system in a repl
  info         List available generations from profile path
  rollback     Rollback to a previous generation
  build-vm     Build a `NixOS` VM image
  build-image  Build a `NixOS` disk-image variant

```

（手敲，不在 `lab/ch16/` 里）

两份单子的交集是 `switch`、`boot`、`test`、`build`、`repl`、`build-vm`、`build-image`。`nixos-rebuild` 多出来的是 `dry-activate`、`dry-build`、`edit`、`build-vm-with-bootloader` 以及 `list-generations`（它出现在用法行里，没有出现在我这条命令抠出来的单子里）；`nh os` 多出来的是 `info` 和 `rollback`（`nixos-rebuild` 有对应的 `--rollback` 选项，我在 man 页里数到了它）。差别更在选项上：`nh os switch --help` 列了 `-n/--dry`（只打印动作）、`-a/--ask`（要求确认）、`-d/--diff`（显示包的差异）、`-H/--hostname`（选 `nixosConfigurations` 里的哪个）、`-u/--update`（更新全部 flake 输入），默认通过 `nix-output-monitor` 显示构建进度，`--no-nom` 关掉。这些我只读了 `--help` 和手册，没有让 `nh` 去改我的系统，它内部怎么调用 `switch-to-configuration`，我没有读 `nh` 的源码，所以不下结论；它的 `test`、`boot` 动作最终都是 `switch-to-configuration` 的 `test`、`boot`，这是 `--help` 里的描述给出的，不是我验证过的实现。

我的选择取决于用法：想看 `dry-activate`，只能用 `nixos-rebuild`；想要构建进度条和切换前的包差异，`nh` 更舒服。但这一篇没有执行过任何一次切换：虚拟机里只是冷启动，宿主上只跑了不带参数的 `switch-to-configuration`（打印用法），我自己的系统一次也没有 `switch` 过。

## build-vm：把同一份配置启动成虚拟机

`nixos-rebuild build-vm` 构建的是 `config.system.build.vm`，这在 `services.py` 的 [L113 到 L114](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/ni/nixos-rebuild-ng/src/nixos_rebuild/services.py#L113-L114) 里一行 `case Action.BUILD_VM: attr = "config.system.build.vm"`。而 `system.build.vm` 来自 `nixos/modules/virtualisation/build-vm.nix` 的 L57：`vm = lib.mkDefault config.virtualisation.vmVariant.system.build.vm`。“一个 NixOS 配置是 evalModules 的结果”那一节提到的 `vmVariant`（L13 到 L15）是 `extendModules { modules = [ ./qemu-vm.nix ]; }`：同一份配置，再叠上 QEMU 虚拟机的模块，得到另一棵选项树，取它的 `system.build.vm`。`lab.nix` 里有一行：

```nix
  virtualisation.vmVariant.virtualisation.memorySize = 2048;
```

它只对 `vmVariant` 这棵树生效：普通的 `lab.config` 里 `virtualisation.memorySize` 根本不会被用到。`lab/ch16/build_vm_host.sh` 构建这个 `vm`，不启动它：

```bash
main() {
  local vm
  vm="$(nix build "${FIRN_ROOT}#nixosConfigurations.lab.config.system.build.vm" \
    --no-link --print-out-paths)"
  echo "== bin/ of the vm output"
  ls "${vm}/bin"
  # ...
  echo "== closure"
  nix path-info -S "${vm}" | awk '{ printf "closure size: %d bytes\n", $2 }'
  echo "closure paths: $(nix path-info -r "${vm}" | wc -l)"
}
```

```text
$ cat out/ch16/build_vm_host.stdout
== bin/ of the vm output
run-nixos-vm

== run script
/nix/store/<hash>-nixos-vm/bin/run-nixos-vm

== closure
closure size: 2451944408 bytes
closure paths: 810
```

闭包是 2,451,944,408 字节，即 2.28 GiB，810 个路径，比 toplevel 的 1.24 GiB 和 585 个路径多出 1.04 GiB 和 225 个路径，是 toplevel 的 1.84 倍；多出来的部分我猜主要是 QEMU 和它的依赖，没有逐项拆。启动脚本 `run-nixos-vm` 就是一个 shell 脚本，我从里面把关键的几个参数抠出来：

```text
$ grep -o -E '(-m [0-9]+|accel=[a-z:]+|path=/nix/store,[^ ]*)' "$(nix build .#nixosConfigurations.lab.config.system.build.vm --no-link --print-out-paths)/bin/run-nixos-vm"
accel=kvm:tcg
-m 2048
path=/nix/store,security_model=none,mount_tag=nix-store
```

（手敲，不在 `lab/ch16/` 里）

`-m 2048` 就是 `lab.nix` 里的 2048 MiB（`virtualisation.memorySize` 的默认值是 1024，`qemu-vm.nix` 的 [L433 到 L439](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/virtualisation/qemu-vm.nix#L433-L439)）；`accel=kvm:tcg` 说明有 KVM 就用 KVM，否则退回 TCG（脚本里看到的，我没有跑过回退）；最后一项是 9p 共享：虚拟机直接把宿主的 `/nix/store` 挂进去，`mount_tag` 是 `nix-store`，所以 `build-vm` 的结果不是磁盘镜像，而是“一份配置加一个启动脚本”，启动时用宿主的 store。`nixos-rebuild` 的 man 页也这么说：“The VM mounts the Nix store of the host through the 9P file system”，并提醒宿主的 store 对虚拟机是只读的，虚拟机里的 `nix` 命令改不了它。我没有把这台虚拟机启动起来，这一篇的实验都不需要交互式的虚拟机；想启动的话，`./result/bin/run-*-vm`，`lab.nix` 里给了用户 `firn` 和口令 `firn`，那行 `initialPassword = "firn"` 旁边有一条注释，写着“只给虚拟机里登录用；真机上永远不要把明文口令写进配置”。

## system.stateVersion

`lab.nix` 的最后一行：

```nix
  # 记录首次安装时的 NixOS 版本，决定有状态数据的默认布局；装好以后不要改。
  system.stateVersion = "26.05";
```

而钉住的 nixpkgs 的版本是 26.11，我用 `nix eval` 看了 `lab` 两个选项的值：

```text
$ nix eval .#nixosConfigurations.lab.config.system.stateVersion
"26.05"
$ nix eval .#nixosConfigurations.lab.config.system.nixos.release
"26.11"
```

（手敲，不在 `lab/ch16/` 里）

`system.stateVersion` 是 `"26.05"`，`system.nixos.release` 是 `"26.11"`。这就是两个版本号碰面：`stateVersion` 不是“我在跑哪个 NixOS”，它是“这台机器的有状态数据（数据库目录、各种格式的约定）是按哪个版本的默认值创建的”。选项的声明在 [`nixos/modules/misc/version.nix` 的 L216 到 L225](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/misc/version.nix#L216-L225)：默认值是 `cfg.release`，但没显式设置就会 `lib.warnIf` 警告；描述里举了例子：版本 XX.YY 带的数据库是 N，升级到 XX.YY+1 带 N+1，老数据库就可能不兼容。模块里到底怎么用？`services.postgresql.package` 的默认值就是例子，[`postgresql.nix` 的 L206 到 L217](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/services/databases/postgresql.nix#L206-L217) 是它的 `defaultText`：

```nix
          if versionAtLeast config.system.stateVersion "26.11" then
            pkgs.postgresql_18
          else if versionAtLeast config.system.stateVersion "25.11" then
            pkgs.postgresql_17
          else if versionAtLeast config.system.stateVersion "24.11" then
            pkgs.postgresql_16
          else if versionAtLeast config.system.stateVersion "23.11" then
            pkgs.postgresql_15
          else
            pkgs.postgresql_14
```

（节选自 `nixos/modules/services/databases/postgresql.nix` 的 L207 到 L216，这是 `defaultText` 字符串里的内容）

我用 `lab` 配置验证：只改 `stateVersion`、打开 `services.postgresql`，看默认选了哪个包：

```text
$ for v in 25.11 26.05 26.11; do echo -n "${v}: "; nix eval --impure --raw --expr "let firn = builtins.getFlake (toString ./.); in (firn.nixosConfigurations.lab.extendModules { modules = [ ({ lib, ... }: { system.stateVersion = lib.mkForce \"${v}\"; services.postgresql.enable = true; }) ]; }).config.services.postgresql.package.name"; echo; done
25.11: postgresql-17.11
26.05: postgresql-17.11
26.11: postgresql-18.6
```

（手敲，不在 `lab/ch16/` 里）

同一份 nixpkgs，只把 `stateVersion` 从 26.05 改成 26.11，PostgreSQL 就从 17.11 变成了 18.6，大版本变了，旧数据目录就读不了。所以“装好以后不要改”的真正含义是：`stateVersion` 不跟着你升级，它是你升级时的锚；要升级 PostgreSQL，应该自己显式写 `package`，做完数据迁移再说。`cairn` 这个模块不依赖 `stateVersion`（它没有任何随版本变的默认值），但我还是在 `lab.nix` 里设了它：不设的话，`version.nix` 的 L222 到 L223 会在求值时发出一条 `system.stateVersion is not set` 的警告（我没有真的去掉它验证）。

## 让我意外的事

**虚拟机测试的 88% 是开机。** 我以为“起一台虚拟机，跑 cairn 两次”会慢在 cairn 上。`nix log` 里的数字相反：脚本总共 20.67 秒，`waiting for unit multi-user.target` 一项就是 18.27 秒；两次 `systemctl start cairn.service`（含 `init`、`snapshot`、`prune`）各不到半秒；除开等待开机，所有其余步骤（含我自己写的 `sleep 1`）加起来是 2.4 秒。所以往测试里加断言几乎是免费的，加一台节点才是花钱的（我写的整个测试脚本加起来，还不到 `wait_for_unit` 一行的零头）。这是一个样本，我没有量过别的配置。

**`ProtectSystem = "strict"` 配 `ReadWritePaths`，教科书写法也会在首次启动时失败。** 去掉 tmpfiles 规则的单元就是这样，结果是 `226/NAMESPACE`：`ReadWritePaths` 要在进程启动之前挂载，而创建目录的 `init` 本身就是这个单元的第一个进程。我在 `borgbackup.nix` 的 L237 找到了同一个坑的注释，才知道这是个老问题；练习 2 里还有一个不用 tmpfiles 的解法。这件事最让我觉得“VM 测试值得写”：在 `nix eval` 和 `nix build` 里它一点错也没有，只有真的启动 systemd 才会撞到。

**一个 NixOS 系统里，最大的一个 store 路径是 nixpkgs 的源码。** 212,583,408 字节，占 `lab` 的 toplevel 闭包的 16%，比内核模块还大。我一开始以为是我哪个模块拖进来的，`nix why-depends` 指向 `/etc/nix/registry.json`。关掉 `nixpkgs.flake.setFlakeRegistry` 和 `setNixPath` 之后闭包是 1,118,617,944 字节。

**那个只给虚拟机用的口令，真的在 store 里。** `lab.nix` 给用户 `firn` 设了 `initialPassword = "firn"`，注释写着“只给虚拟机里登录用”。我想知道它到底会去哪里：

```text
$ jq -c '.users[] | select(.name=="firn") | {name, initialPassword}' "$(grep -o '/nix/store/[a-z0-9]*-users-groups.json' "$(nix build .#nixosConfigurations.lab.config.system.build.toplevel --no-link --print-out-paths)/activate" | head -n 1)"
{"name":"firn","initialPassword":"firn"}
$ ls -l "$(grep -o '/nix/store/[a-z0-9]*-users-groups.json' "$(nix build .#nixosConfigurations.lab.config.system.build.toplevel --no-link --print-out-paths)/activate" | head -n 1)" | awk '{ print $1 }'
-r--r--r--
```

（手敲，不在 `lab/ch16/` 里）

明文，进了 store，权限是 `-r--r--r--`：任何能在这台机器上跑 `cat` 的用户都能读到。这个口令是我故意写成演示用的，所以无所谓；但同样的写法换成真密码，就是第 17 篇要讲的那个问题。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
env -u CI make ch16
make lint
make check
while read -r f; do
  diff <(git -C ~/firn-ref show ch16:"${f}") "${f}" && echo "same ${f}"
done < <(git -C ~/firn-ref diff --name-only ch15 ch16)
```

`make ch16` 在我这里打印这 9 行（命令回显加 8 行 `ok`），整条命令（含 `nix develop` 的启动）花了 33.231 秒；`lab/ch16/` 里有 3 个 `_host` 实验，`CI=true` 时 `scripts/chapter.sh` 的 L100 到 L103 对它们打印 `skip lab/ch16/<name> (host only)`，也就是 `build_vm_host.sh`、`switch_anatomy_host.sh` 和 `vm_test_host.sh`，不运行；我没有在 `CI=true` 下跑过它，这一条是读脚本得出的：

```text
$ env -u CI make ch16
bash scripts/chapter.sh ch16
ok   lab/ch16/build_vm_host.sh
ok   lab/ch16/etc_generated.sh
ok   lab/ch16/ex_hardening.nix
ok   lab/ch16/module_count.nix
ok   lab/ch16/option_query.sh
ok   lab/ch16/switch_anatomy_host.sh
ok   lab/ch16/toplevel.sh
ok   lab/ch16/vm_test_host.sh
```

`make lint` 回显它跑的几条命令，没有任何诊断，退出码 0；`make check` 以 `all checks passed!` 结束，退出码 0，x86\_64-linux 上是 16 个检查：

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
```

（手敲，不在 `lab/ch16/` 里）

16 这个数来自这一篇开头那条 `nix eval .#checks.x86_64-linux --apply builtins.attrNames --json` 的输出：列出的名字正好 16 个。`make check` 打印的 `running 0 flake checks...` 我没有去查它的含义，不拿它下结论。

`diff` 循环应当打印 12 行 `same ...`，和 `git diff --name-only ch15 ch16` 的 12 个文件一一对应。我这里没有单独的 `~/firn-ref`，拿 Firn 仓库自己的 `ch16` 标签当参照跑了一遍，打印的行数是：

```text
$ while read -r f; do
  diff <(git show ch16:"${f}") "${f}" && echo "same ${f}"
done < <(git diff --name-only ch15 ch16) | wc -l
12
```

（手敲，不在 `lab/ch16/` 里）

**必须和标签一致的文件：** `nixos/modules/cairn.nix`、`nixos/tests/cairn.nix`、`nixos/hosts/lab.nix` 和 `lab/ch16/` 下全部 8 个文件。

**中间版本：** [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch16/flake.nix) 之后的章节还会改，到那时 `diff` 循环里它会和 `ch16` 标签对不上。

### 文件清单

链接指向标签 `ch16` 上的那一份；`git diff --name-only ch15 ch16` 的 12 个文件一个不少（其中 `lab/ch16/` 下 8 个，没有 fixture）。实验的命令都是 `env -u CI make ch16`，输出在 `out/ch16/`。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch16/flake.nix) | `nix eval .#checks.x86_64-linux --apply builtins.attrNames --json` | 退出码 0；16 个检查（`ch15` 上是 15 个），多了 `cairn-vm`；比 `ch15` 多 24 行、没有删行；`nixosModules` 是 `cairn` 和 `default`，`nixosConfigurations` 是 `lab` |
| [`lab/ch16/build_vm_host.sh`](https://github.com/bfmhno3/firn/blob/ch16/lab/ch16/build_vm_host.sh) | `env -u CI make ch16` | 退出码 0（`_host`，`CI=true` 时跳过）；27 行；`bin/` 里只有 `run-nixos-vm`；闭包 2451944408 字节、810 个路径；不启动虚拟机 |
| [`lab/ch16/etc_generated.sh`](https://github.com/bfmhno3/firn/blob/ch16/lab/ch16/etc_generated.sh) | `env -u CI make ch16` | 退出码 0；29 行；`etc/cairn/cairn.conf` 是链接，内容 5 行（`repo`、`source`、三个 `keep_*`）；`cairn.service` 和 `cairn.timer` 的单元文件 |
| [`lab/ch16/ex_hardening.nix`](https://github.com/bfmhno3/firn/blob/ch16/lab/ch16/ex_hardening.nix) | `env -u CI make ch16` | 退出码 0；35 行；只求值，打印的 `serviceConfig` 里有 `CapabilityBoundingSet = ""` 和 `SystemCallFilter = [ "@system-service" "~@privileged" ]`（练习 1 的答案） |
| [`lab/ch16/module_count.nix`](https://github.com/bfmhno3/firn/blob/ch16/lab/ch16/module_count.nix) | `env -u CI make ch16` | 退出码 0；12 行；`{ labGraph = 2098; moduleList = 2093; }` |
| [`lab/ch16/option_query.sh`](https://github.com/bfmhno3/firn/blob/ch16/lab/ch16/option_query.sh) | `env -u CI make ch16` | 退出码 0；26 行；`["/srv/data"]`，`ExecStart` 是 `<store>/bin/cairn -c /etc/cairn/cairn.conf snapshot`，`{"OnCalendar":"daily","Persistent":true}` |
| [`lab/ch16/switch_anatomy_host.sh`](https://github.com/bfmhno3/firn/blob/ch16/lab/ch16/switch_anatomy_host.sh) | `env -u CI make ch16` | 退出码 0（`_host`，`CI=true` 时跳过）；30 行；四段输出每行都带 `volatile:`，内容取决于机器；只读，不改任何东西 |
| [`lab/ch16/toplevel.sh`](https://github.com/bfmhno3/firn/blob/ch16/lab/ch16/toplevel.sh) | `env -u CI make ch16` | 退出码 0；27 行；toplevel 有 21 个条目，`nixos-version` 是 `26.11.20260823.56c02bc`，闭包 1331201328 字节、585 个路径 |
| [`lab/ch16/vm_test_host.sh`](https://github.com/bfmhno3/firn/blob/ch16/lab/ch16/vm_test_host.sh) | `env -u CI make ch16` | 退出码 0（`_host`，`CI=true` 时跳过）；46 行；8 行 `firn:`，依次是 `snapshots_after_first 1`、`verify ok`、`snapshots_after_second 2`、`hardlinks_unchanged 2`、`hardlinks_changed 1`、`timer cairn.timer`、`exposure 8.4` 和 `exposure_level EXPOSED`；墙钟 21 秒，`volatile`，`--rebuild` 分支 |
| [`nixos/hosts/lab.nix`](https://github.com/bfmhno3/firn/blob/ch16/nixos/hosts/lab.nix) | `nix eval .#nixosConfigurations.lab.config.system.stateVersion` | 33 行；`"26.05"`；`lab` 的 toplevel 构建成功 |
| [`nixos/modules/cairn.nix`](https://github.com/bfmhno3/firn/blob/ch16/nixos/modules/cairn.nix) | `env -u CI make ch16` | 85 行；4 个选项：`enable`、`onCalendar`、`package` 和 `settings`；`option_query.sh` 和 `etc_generated.sh` 读的就是它生成的配置 |
| [`nixos/tests/cairn.nix`](https://github.com/bfmhno3/firn/blob/ch16/nixos/tests/cairn.nix) | `env -u CI make ch16`，由 `vm_test_host.sh` 执行 | 78 行；`nix derivation show` 里 `requiredSystemFeatures` 是 `kvm nixos-test`；测试脚本 20.71 秒，其中等开机 18.27 秒 |

## 练习

**1\.** 给 `cairn.service` 加 `CapabilityBoundingSet` 和 `SystemCallFilter`，重新测量 `systemd-analyze security` 的分数。

<details>
<summary>参考答案</summary>

答案是 `lab/ch16/ex_hardening.nix`（[链接](https://github.com/bfmhno3/firn/blob/ch16/lab/ch16/ex_hardening.nix)）。它求值一个带额外模块的 NixOS 配置，把加固选项写进去，打印出来的 `serviceConfig` 里能看到它们：

```nix
  hardening = {
    systemd.services.cairn.serviceConfig = {
      # 不需要任何 capability：rsync 以 cairn 用户读写自己的文件。
      CapabilityBoundingSet = "";
      SystemCallFilter = [
        "@system-service"
        "~@privileged"
      ];
    };
  };
```

```text
$ cat out/ch16/ex_hardening.stdout
{ CapabilityBoundingSet = ""; ExecStart = "/nix/store/08miknl7zqxj4xrcvp27jjcpf9grfaj8-cairn-0.1.0/bin/cairn -c /etc/cairn/cairn.conf snapshot"; ExecStartPost = "/nix/store/08miknl7zqxj4xrcvp27jjcpf9grfaj8-cairn-0.1.0/bin/cairn -c /etc/cairn/cairn.conf prune"; ExecStartPre = "/nix/store/08miknl7zqxj4xrcvp27jjcpf9grfaj8-cairn-0.1.0/bin/cairn -c /etc/cairn/cairn.conf init /var/lib/cairn/repo"; Group = "cairn"; NoNewPrivileges = true; PrivateTmp = true; ProtectHome = "read-only"; ProtectSystem = "strict"; ReadWritePaths = [ "/var/lib/cairn/repo" ]; StateDirectory = "cairn"; SystemCallFilter = [ "@system-service" "~@privileged" ]; Type = "oneshot"; User = "cairn"; }
```

这个实验只求值，不跑虚拟机，所以它打印不出分数：分数要在虚拟机里量。我另写了一个 Nix 文件，复用仓库里的 `nixos/tests/cairn.nix`，只把节点的模块换成“`nixosModules.default` 加这两个选项”。它放在 `/tmp/scratch16/hardened.nix`：

```nix
# Same VM test as checks.x86_64-linux.cairn-vm, plus two hardening options.
{ firn }:
let
  pkgs = firn.inputs.nixpkgs.legacyPackages.x86_64-linux;
in
import "${firn}/nixos/tests/cairn.nix" {
  inherit pkgs;
  cairnModule = {
    imports = [ firn.nixosModules.default ];
    systemd.services.cairn.serviceConfig = {
      CapabilityBoundingSet = "";
      SystemCallFilter = [
        "@system-service"
        "~@privileged"
      ];
    };
  };
}
```

```text
$ nix build --impure -L --no-link --rebuild --expr 'import /tmp/scratch16/hardened.nix { firn = builtins.getFlake (toString ./.); }' 2>&1 | grep -o 'firn: .*' | awk '!s[$0]++'
firn: snapshots_after_first 1
firn: verify ok
firn: snapshots_after_second 2
firn: hardlinks_unchanged 2
firn: hardlinks_changed 1
firn: timer cairn.timer
firn: exposure 4.4
firn: exposure_level OK
```

（手敲，不在 `lab/ch16/` 里）

**答案：exposure 从 8.4 (EXPOSED) 降到 4.4 (OK)**，`exposure` 和 `exposure_level` 之外的六行和不加固时完全一样，说明这两个选项没有破坏测试覆盖的行为。我想知道那 4.0 分是被哪些行拿走的，所以用“systemd 加固”那一节的 `probe.nix`（参数 `hardened = true`）再打印一次整张表，和不加固时的表比较：

```text
$ nix build --impure -L --no-link --expr 'import /tmp/scratch16/probe.nix { firn = builtins.getFlake (toString ./.); hardened = true; }' 2>&1 | grep -o 'SEC|.*' | awk '!s[$0]++' > after.txt
$ grep -c '^SEC|✗' after.txt; grep -c '^SEC|✓' after.txt; tail -n 1 after.txt
35
46
SEC|→ Overall exposure level for cairn.service: 4.4 OK :-)
$ for f in before after; do
  grep -E '^SEC\|[✗✓] ' "${f}.txt" | awk '{ print $2, $1 }' | sed 's/SEC|//' | sort >"${f}.st"
done
$ join before.st after.st | awk '$2 != $3' | cut -d= -f1 | sort | uniq -c
     26 CapabilityBoundingSet
     10 SystemCallFilter
$ join before.st after.st | awk '$2 != $3' | wc -l
36
$ join before.st after.st | awk '$2 == $3 && $2 == "✗"' | wc -l
35
```

（手敲，不在 `lab/ch16/` 里）

71 个 ✗ 变成 35 个：36 行翻成了 ✓，全部来自这两个选项，其中 `CapabilityBoundingSet = ""` 一口气翻了 26 行（每一种 capability 一行），`SystemCallFilter` 翻了 10 行；还剩 35 个 ✗。权重 0.3 以上的行从 7 个剩下 4 个：

```text
$ grep -E '^SEC\|✗' after.txt | sed 's/^SEC|//' | awk '$NF >= 0.3 { print $2, $NF }'
RestrictNamespaces=~user 0.3
RestrictAddressFamilies=~… 0.3
RestrictAddressFamilies=~AF_(INET|INET6) 0.3
PrivateNetwork= 0.5
```

（手敲，不在 `lab/ch16/` 里）

剩下的这 35 行里还有 `SystemCallFilter=~@resources`，权重 0.2：`@system-service` 这个组本身包含 `@resources`，所以光写它不够。下一步我把剩下的“普通开关”也加上：`PrivateNetwork`、`PrivateUsers`、`PrivateDevices`、七个 `Protect*`（含 `ProtectProc`）、`ProcSubset`、`LockPersonality`、`MemoryDenyWriteExecute`、`RestrictNamespaces`、`RestrictRealtime`、`RestrictSUIDSGID`、`RestrictAddressFamilies = [ "AF_UNIX" ]`、`SystemCallArchitectures` 和 `UMask`，一共 21 个指令（含最初那两个）。`/tmp/scratch16/hardened_more.nix` 的 `serviceConfig` 部分：

```nix
    systemd.services.cairn.serviceConfig = {
      CapabilityBoundingSet = "";
      SystemCallFilter = [
        "@system-service"
        "~@privileged"
      ];
      PrivateDevices = true;
      PrivateNetwork = true;
      PrivateUsers = true;
      # ...
      RestrictAddressFamilies = [ "AF_UNIX" ];
      SystemCallArchitectures = "native";
      UMask = "0077";
    };
```

（`# ...` 处省掉了 `ProtectClock`、`ProtectControlGroups`、`ProtectHostname`、`ProtectKernelLogs`、`ProtectKernelModules`、`ProtectKernelTunables`、`ProtectProc = "invisible"`、`ProcSubset = "pid"`、`LockPersonality`、`MemoryDenyWriteExecute`、`RestrictNamespaces`、`RestrictRealtime` 和 `RestrictSUIDSGID` 共 13 行，值都是 `true`，除了 `ProtectProc` 和 `ProcSubset` 两个字符串。文件头和 `imports` 与 `hardened.nix` 相同）

```text
$ nix build --impure -L --no-link --expr 'import /tmp/scratch16/hardened_more.nix { firn = builtins.getFlake (toString ./.); }' 2>&1 | grep -o 'firn: .*' | awk '!s[$0]++'
firn: snapshots_after_first 1
firn: verify ok
firn: snapshots_after_second 2
firn: hardlinks_unchanged 2
firn: hardlinks_changed 1
firn: timer cairn.timer
firn: exposure 0.6
firn: exposure_level SAFE
```

（手敲，不在 `lab/ch16/` 里）

0.6，SAFE，测试还是过的。这是对这个测试的工作负载（两次本地快照，数据在 `/srv/data`）成立的结论；`PrivateNetwork` 和 `RestrictAddressFamilies = [ "AF_UNIX" ]` 对一个通过网络备份的 cairn 就不对了，`ProtectHome` 对备份 `/home` 的 cairn 也不对，所以这一组选项不该原样放进模块的默认值，是用户按需加的。它们每个都只在一个样本上测过，我没有逐个删掉看是哪一个拿走了最多的分。

</details>

**2\.** 把 `tmpfiles.rules` 去掉，但让测试还能通过。

<details>
<summary>参考答案</summary>

`ReadWritePaths=` 里的路径可以加 `-` 前缀，表示不存在时忽略，见 `systemd.exec(5)`。把仓库路径改成 `"-/var/lib/cairn/repo"`，同时清空 tmpfiles 规则，`/tmp/scratch16/dash_path.nix`：

```nix
# Same VM test, tmpfiles rule removed, ReadWritePaths made tolerant with "-".
{ firn }:
let
  pkgs = firn.inputs.nixpkgs.legacyPackages.x86_64-linux;
in
import "${firn}/nixos/tests/cairn.nix" {
  inherit pkgs;
  cairnModule = {
    imports = [ firn.nixosModules.default ];
    systemd.tmpfiles.rules = pkgs.lib.mkForce [ ];
    systemd.services.cairn.serviceConfig.ReadWritePaths = pkgs.lib.mkForce [ "-/var/lib/cairn/repo" ];
  };
}
```

```text
$ nix build --impure -L --no-link --expr 'import /tmp/scratch16/dash_path.nix { firn = builtins.getFlake (toString ./.); }' 2>&1 | grep -o 'firn: .*' | awk '!s[$0]++'
firn: snapshots_after_first 1
firn: verify ok
firn: snapshots_after_second 2
firn: hardlinks_unchanged 2
firn: hardlinks_changed 1
firn: timer cairn.timer
firn: exposure 8.4
firn: exposure_level EXPOSED
```

（手敲，不在 `lab/ch16/` 里）

测试通过，分数不变，还是 8.4。我猜它能行，是因为 `StateDirectory = "cairn"` 本来就把 `/var/lib/cairn` 排除在 `ProtectSystem=strict` 之外，仓库目录在它之下，`ReadWritePaths` 这一项对默认的 `repo` 其实是多余的；`systemd.exec(5)` 对 `ProtectSystem=` 的描述里写着 `StateDirectory=` 声明的目录不受它影响。我没有把 `ReadWritePaths` 整个去掉验证这一点。把 `repo` 改到 `/var/lib/cairn` 之外（比如 `/srv/backup`）时 `ReadWritePaths` 就不再多余了，那时 `-` 前缀会让不存在的路径被静默忽略，我猜错误会推迟到 `init` 去报；用哪个解法，看你愿意在哪里发现问题。

</details>

**3\.** 把 `services.cairn.onCalendar` 改成 `"03:00"`，不构建任何东西，确认定时器的设置变了。

<details>
<summary>参考答案</summary>

和 `option_query.sh` 一样只求值，用 `extendModules` 给 `lab` 再叠一个模块：

```text
$ nix eval --impure --json --expr 'let firn = builtins.getFlake (toString ./.); in (firn.nixosConfigurations.lab.extendModules { modules = [ { services.cairn.onCalendar = "03:00"; } ]; }).config.systemd.timers.cairn.timerConfig'
{"OnCalendar":"03:00","Persistent":true}
```

（手敲，不在 `lab/ch16/` 里）

`OnCalendar` 变成了 `03:00`，`Persistent` 不变。我没有构建 toplevel，`extendModules` 只是在同一份模块图上再追加一个定义。

</details>

**4\.** 为什么 `nixos-rebuild test` 之后，`ls -l /nix/var/nix/profiles | grep system` 不会多出一项？

<details>
<summary>参考答案</summary>

`nixos-rebuild-ng` 的 `services.py` 在 L225 到 L250 里分两个 `case`：`switch` 和 `boot` 先调 `nix.set_profile`，也就是 `nix-env -p /nix/var/nix/profiles/system --set <toplevel>`（`nix.py` 的 L693 到 L697），再调 `switch_to_configuration`；`test` 和 `dry-activate` 只有第二步。generation 就是 profile 的一次 `--set`，没 `--set`，就没有新的 `system-N-link`。所以 `test` 激活的那个系统不在引导菜单里，也没有 generation 可以回滚到；重启后机器回到上一个 `switch` 或 `boot` 的 generation。这一条我读源码得出，没有在真机上跑 `test` 验证，因为这一篇我没有改自己的系统。

</details>

## 下一篇

[第 17 篇：secrets：为什么不能进 store，以及 sops-nix](/posts/nix-by-firn-17-secrets/)要处理“让我意外的事”里最后那个明文口令：为什么这种东西不能进 store，以及 sops-nix 怎么绕开它。我猜最难的不是 sops 的语法，而是别让解密后的文件，又被某个 `builtins.readFile` 悄悄拉回 store。
