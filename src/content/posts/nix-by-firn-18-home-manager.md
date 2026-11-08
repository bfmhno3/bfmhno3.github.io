---
title: "Home Manager：programs.cairn 与用户级配置"
commentId: "post:nix-by-firn-18-home-manager"
published: "2026-11-08 00:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 18 篇：我用 Nix 2.34.9 和锁在 cfba7ad 的 Home Manager 写了 programs.cairn，一个只往 $HOME 放 5 个符号链接的 demo 配置，激活包的闭包却有 666,718,104 字节（170 个 store 路径），光 glibc-locales 一项就占 35.0%；同一个模块放进 NixOS 虚拟机跑一遍测试，--rebuild 一次 22 秒。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - Home Manager
  - dotfiles
series: "用 Firn 从零学 Nix"
seriesOrder: 18
draft: false
comment: true
slug: nix-by-firn-18-home-manager
---

我拿第 16 篇的 `services.cairn` 当模板，写了 `programs.cairn`，再配一个只开 cairn 的 `demo` 用户，构建它的激活包。结果有点好笑：这份配置往 `$HOME` 里放 5 个符号链接，激活包的闭包却是 666,718,104 字节、170 个 store 路径；5 个链接里只有 1 个是我写的。

```text
$ nix build .#homeConfigurations.demo.activationPackage --no-link --print-out-paths | sed -E 's|[a-z0-9]{32}|<hash>|'
/nix/store/<hash>-home-manager-generation
$ sed -n '/^== home-files/,/^$/p' out/ch18/hm_activation_package.stdout
== home-files: every link that activation puts into $HOME
.cache/.keep -> /nix/store/<hash>-hm_homedemo.cache.keep
.config/cairn/cairn.conf -> /nix/store/<hash>-hm_cairncairn.conf
.config/environment.d/10-home-manager.conf -> /nix/store/<hash>-hm_environment.d10homemanager.conf
.config/systemd/user/tray.target -> /nix/store/<hash>-tray.target/tray.target
.local/state/.keep -> /nix/store/<hash>-hm_homedemo.localstate.keep

$ grep -E '^(lines|closure)' out/ch18/hm_activation_package.stdout
lines: 389
closure size: 666718104 bytes
closure paths: 170
```

这一篇要回答的是：Home Manager 到底是什么（答案：第 15 篇的模块系统，只是把“输出”从一个系统换成了 `$HOME`），它的激活是怎么排序的，作为 NixOS 模块跑和独立跑差在哪里，以及哪些设置该归 NixOS、哪些该归它。

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch18` 里：`home/modules/cairn.nix`（77 行，`programs.cairn`）、`home/demo.nix`（16 行）、`nixos/tests/home.nix`（108 行，Home Manager 作为 NixOS 模块的虚拟机测试）、`flake.nix`（376 行）和 `flake.lock`（69 行，4 个节点），以及 `lab/ch18/` 下 8 个文件（7 个实验，1 个夹具）。`env -u CI make ch18` 通过。
> 涉及的概念：Home Manager 是 `$HOME` 上的模块系统，`home-files` 与激活包，`writeBoundary` 与激活 DAG，standalone、NixOS 模块、nix-darwin 三种装法，`useGlobalPkgs` 与 `useUserPackages`，generations 与回滚，`programs.*` 与 `home.file`/`xdg.configFile`，systemd 用户单元与 linger，`home.stateVersion`，`mkOutOfStoreSymlink`，NixOS 与 Home Manager 的分工。
> 前置：[第 17 篇：secrets：为什么不能进 store，以及 sops-nix](/posts/nix-by-firn-17-secrets/)。`cairn-settings` 模块在[第 15 篇](/posts/nix-by-firn-15-module-system/)写好，`services.cairn` 和 NixOS 测试框架在[第 16 篇](/posts/nix-by-firn-16-nixos-module-and-vm-test/)；这一篇把后者的设置模块原样搬到 `programs.cairn` 里，并直接使用 `testers.runNixOSTest`。
> 终稿与中间版本：`home/modules/cairn.nix`、`home/demo.nix`、`nixos/tests/home.nix` 和 `lab/ch18/` 在 `ch18` 就是终稿；`flake.nix` 和 `flake.lock` 还会变。

## 环境

这一篇所有输出来自这台机器：NixOS 26.05 (Yarara)，Linux 6.18.60，`x86_64`，16 个核，上游 Nix 2.34.9，`/dev/kvm` 存在。Firn 钉的 nixpkgs 还是 `56c02bc00adcf003215cc4bd996d6efaf4cff188`。新增的输入是 Home Manager，`flake.lock` 把它锁在 `cfba7ad5886b342b8dd63ba74354b3853ea4cfc9`，`lastModified` 是 2026-08-23T12:25:06Z，`follows` 指回我们的 `nixpkgs`：

```text
$ nix --version
nix (Nix) 2.34.9
$ jq -c '.nodes | keys' flake.lock
["home-manager","nixpkgs","root","sops-nix"]
$ jq -c '.nodes["home-manager"] | {rev: .locked.rev, follows: .inputs.nixpkgs}' flake.lock
{"rev":"cfba7ad5886b342b8dd63ba74354b3853ea4cfc9","follows":["nixpkgs"]}
$ date -u -d @"$(jq '.nodes["home-manager"].locked.lastModified' flake.lock)" +%FT%TZ
2026-08-23T12:25:06Z
$ gh api 'repos/nix-community/home-manager/commits?sha=master&until=2026-08-24T00:00:00Z&per_page=1' --jq '.[0] | "\(.sha) \(.commit.committer.date)"'
cfba7ad5886b342b8dd63ba74354b3853ea4cfc9 2026-08-23T12:25:06Z
```

（手敲，不在 `lab/ch18/` 里；最后一条是 2026-11-07 当天查的 GitHub 提交列表：到 2026-08-23 为止，`cfba7ad` 是 `master` 上最后一个提交，之后到 2026-08-24 零点 (UTC) 没有新的。）

文中引用的 Home Manager 行号是 `cfba7ad` 上的，nixpkgs 的行号是 `56c02bc` 上的，sops-nix 的行号是 `a8627b2` 上的，我都在本地的 store 副本里用 `grep -n` 对过。Home Manager 的 `release.json` 在这个提交上写的是 `26.11`，不是发布分支（`isReleaseBranch` 为 `false`）：也就是说我们跟的是 `master`，不是 `release-26.05`。

我的 shell 里设了 `CI=true`，运行器会据此跳过 `_host` 结尾的实验；`lab/ch18/` 里有两个（`home_vm_host.sh` 和 `hm_generations_host.sh`），所以我按惯例跑 `env -u CI make ch18`，在 `nix develop` 里，整条命令（含 `nix develop` 的启动）墙钟 33.0 秒，7 个实验全部 `ok`。虚拟机测试的结果在这之前已经在 store 里，`home_vm_host.sh` 走的是 `--rebuild` 分支，它报的 22 秒是这个分支的样本，不是第一次构建的时间。

实验分两类。一类在 `lab/ch18/` 里，我给出路径、摘录和 `out/ch18/` 里的真实输出。另一类是我为了回答某个问题当场敲的，每条都标着“（手敲，不在 `lab/ch18/` 里）”。后一类里有几个 Nix 文件放在 `/tmp/scratch18/` 下：`global_pkgs.nix`、`plain_pkgs.nix`、`sv.nix`、`nosv.nix`、`timer_files.nix`、`timer_closure.nix`、`two_state_versions.nix` 是只求值或只构建的小配置，`probe_after_link.nix`、`probe_linger.nix` 和 `probe_rollback.nix` 是三个借 `home-vm` 改测试脚本的虚拟机探针；它们都过了 `nixfmt --check`，内容贴在用到它们的小节里。靠 `builtins.getFlake` 读 Firn 的那些，路径用 `toString ./.` 传，要加 `--impure`，不用环境变量。虚拟机探针的结果会被缓存：第二次运行时结果已在 store 里，`-L` 不会再打印日志，要加 `--rebuild`；文中贴的是第一次运行的输出（`probe_after_link.nix` 例外，贴的是加了 `--rebuild` 的那次）。

## 同一个模块系统，换一个宿主

第 15 篇我手写过 `evalModules` 的缩小版，第 16 篇看到 NixOS 的 `system.build.toplevel` 是对一大堆模块求值的结果。Home Manager 做的是同一件事：一组声明 `options` 的模块，一组写 `config` 的用户模块，合并以后，`config` 里有一个特殊的输出属性，`home.activationPackage`。区别只在选项空间：NixOS 的是 `boot.*`、`services.*`、`users.*`，Home Manager 的是 `home.*`、`programs.*`、`xdg.*`、`systemd.user.*`；它管的东西也就跟着缩到一个用户的 `$HOME`：文件、用户 profile 里的包、用户级的 systemd 单元、会话变量。内核、引导、用户账号、系统服务都不在里面。

入口是 `home-manager.lib.homeManagerConfiguration`，源码就在 [`lib/eval-config.nix`](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/lib/eval-config.nix#L1-L8)：

```nix
{
  check ? true,
  extraSpecialArgs ? { },
  lib ? pkgs.lib,
  modules ? [ ],
  pkgs,
  minimal ? false,
}:
```

（节选自 Home Manager 的 `lib/eval-config.nix` 的 L1 到 L8）

对比 `nixpkgs.lib.nixosSystem` 要一个 `system` 字符串，这里要的是一个现成的 `pkgs`。这个差别在“作为 NixOS 模块：虚拟机测试”一节会咬人，先记住：独立模式下，是你把 nixpkgs 实例递给它的。

两个输出的尺寸可以直接比：第 16 篇里 lab 主机的 `system.build.toplevel` 闭包是 1,331,201,328 字节、585 个路径；这一篇 demo 的激活包是 666,718,104 字节、170 个路径，大约一半的字节、不到三成的路径（两个都是单样本，只说明量级）。

## 三种装法：standalone、NixOS 模块、nix-darwin

Home Manager 有三种接进系统的方式，选项几乎相同，不同的是“谁来执行激活”。我把它们并排放在一张表里，每个格子都是我读源码得到的；其中 nix-darwin 一列没有跑过（这台机器是 NixOS），全部来自 [`nix-darwin/default.nix`](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/nix-darwin/default.nix#L19-L32) 和文档，只当参考。

| | standalone | NixOS 模块 | nix-darwin 模块（只读源码，没跑） |
| --- | --- | --- | --- |
| 入口 | `homeConfigurations.<名字>`，`home-manager switch --flake` | `home-manager.nixosModules.home-manager` | `home-manager.darwinModules.home-manager` |
| 谁、以什么身份激活 | 你，以你自己的身份跑 `home-manager switch` | 系统单元 `home-manager-<用户>.service`，`User=` 是那个用户 | 系统激活的 `postActivation` 里，`launchctl asuser` 加 `sudo -u <用户>` |
| `pkgs` 从哪来 | 你传给 `homeManagerConfiguration` | 默认每个用户一份私有的，`useGlobalPkgs` 改成系统的 | 同 NixOS，两者共用 `nixos/common.nix` |
| 会不会登记 home-manager 的 profile | 会，`switch` 里 `nix-env --profile ... --set` | 默认不会（驱动版本 1，`enableLegacyProfileManagement` 为 `false`） | 同 NixOS |
| 要不要 root | 不要 | 要 (`nixos-rebuild`) | 要 (`darwin-rebuild`) |

standalone 的激活在 [`home-manager/home-manager` 的 L828 到 L837](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/home-manager/home-manager#L828-L837)：`switch` 先把新 generation 登记成 profile，再调激活脚本：

```bash
    case $action in
        switch)
            run nix-env $VERBOSE_ARG --profile "$HM_PROFILE_DIR/home-manager" --set "$generation"
            ;;
        rollback)
            run nix-env $VERBOSE_ARG --profile "$HM_PROFILE_DIR/home-manager" --rollback
            ;;
    esac

    "$activateScript" --driver-version 1 || return
```

（节选自 `home-manager/home-manager` 的 L828 到 L837，缩进是原文的）

注意最后那个 `--driver-version 1`：它告诉激活脚本“profile 已经由调用者管了，你别碰”。NixOS 模块用的也是 1，所以它没人登记 profile，这一点在“generations 与回滚”一节会在虚拟机里亲眼看到。NixOS 一侧的单元在 [`nixos/default.nix` 的 L76 到 L120](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/nixos/default.nix#L76-L120)：每个用户一个 `home-manager-<用户>` 系统单元，`wantedBy = [ "multi-user.target" ]`，`before = [ "systemd-user-sessions.service" ]`，`ExecStart` 是用户的 `activationPackage` 里的 `activate`，所以每次开机它都会按用户重跑一遍；`nixos-rebuild switch` 时，只有这个单元的文件变了才会重启它（`ExecStart` 里是用户的 `activationPackage` 路径，配置一变路径就变；`baseUnit` 里还有 `stopIfChanged = false`，在同一个文件的 L22）。后半句是读源码的推断，我没有跑过 `switch`。

我没有在真实主机上做过任何一次 `home-manager switch` 或 `nixos-rebuild switch`：这一篇的 standalone 部分只构建、不激活（`lab/ch18/` 里没有一个实验写 `$HOME`），激活的行为全部在虚拟机里看。

## programs.cairn：把同一个设置模块换一个宿主

`home/modules/cairn.nix` 和第 16 篇的 `nixos/modules/cairn.nix` 共用 `modules/cairn-settings.nix`。选项几乎是复制的：

```nix
{
  options.programs.cairn = {
    enable = lib.mkEnableOption "cairn, snapshot backups with hard links";

    package = lib.mkPackageOption pkgs "cairn" { };

    settings = mkOption {
      type = types.submodule {
        imports = [ ../../modules/cairn-settings.nix ];
        config.cairn.repo = lib.mkDefault "${config.home.homeDirectory}/.local/share/cairn/repo";
      };
      default = { };
      description = "Contents of cairn.conf, see `modules/cairn-settings.nix`.";
    };
    # ...
  };
}
```

（节选自 `home/modules/cairn.nix` 的 L17 到 L42，`# ...` 处是 `timer` 子选项；开头的 `{` 是文件顶层的 L17，结尾单独的 `}` 是我补上的，真正的收尾在 L77）

唯一的差别是 `repo` 的默认值：NixOS 的是 `/var/lib/cairn/repo`，这里是 `${config.home.homeDirectory}/.local/share/cairn/repo`。注意这个 `config` 是外层模块的参数（Home Manager 的整个配置），不是 submodule 自己的；submodule 里的 `config.cairn.repo` 只是借它来拼路径。设置模块自己对宿主一无所知，这正是能同时进 NixOS 和 Home Manager 的前提。

`config` 一侧有四件事，每件对应 Home Manager 的一个选项：

```nix
  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    xdg.configFile."cairn/cairn.conf".text = cfg.settings.cairn.configText;

    home.activation.cairnInit = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run ${exe} -c ${conf} init ${repo}
    '';

    systemd.user = lib.mkIf cfg.timer.enable {
      services.cairn = {
        # ...
      };
      timers.cairn = {
        # ...
      };
    };
  };
```

（节选自 `home/modules/cairn.nix` 的 L44 到 L76，省略了注释和单元内容）

和第 16 篇对照：`environment.systemPackages` 换成 `home.packages`，`environment.etc."cairn/cairn.conf".text` 换成 `xdg.configFile."cairn/cairn.conf".text`，`systemd.services` 换成 `systemd.user.services`，系统用户和 `tmpfiles` 规则不需要了（仓库建在自己的 `$HOME` 下，不需要先给另一个用户建目录），多出来的是 `home.activation`：NixOS 那边的仓库在 `ExecStartPre` 里初始化；Home Manager 的 `systemd.user.services.<名字>.Service.ExecStartPre` 也存在，所以并不是“只能”放进激活脚本。放进 `home.activation` 的真正原因是：仓库初始化要在每次激活时发生，不管 `timer.enable` 开没开，而定时器的单元只在打开它时才存在。

这个“同一个设置模块”是不是真的一样，我做了一个实验，`lab/ch18/same_module_two_hosts.nix`：给 `services.cairn.settings` 和 `programs.cairn.settings` 同一份设置，分别求值 NixOS 和 Home Manager，比较两边渲染出的 `configText`。核心是两个求值和一条比较：

```nix
  nixosText = nixos.config.services.cairn.settings.cairn.configText;
  homeText = home.config.programs.cairn.settings.cairn.configText;
  fixture = builtins.readFile ../../tests/fixtures/cairn.conf;
in
if nixosText != homeText then
  throw "configText differs between NixOS and Home Manager:\n${nixosText}\n---\n${homeText}"
else
  {
    equal = true;
    # ...
  }
```

（节选自 `lab/ch18/same_module_two_hosts.nix` 的 L55 到 L70，省略了与夹具比较的部分）

```text
$ cat out/ch18/same_module_two_hosts.stdout
{ configText = "repo = /srv/backup/repo\nsource = /srv/data\nsource = /etc\nexclude = *.tmp\nkeep_last = 10\nkeep_daily = 7\nkeep_weekly = 2\n"; equal = true; sameAsFixtureExceptRepo = true; }
```

`equal = true`，而且除了 `repo` 那一行，文本和第 15 篇的夹具 `tests/fixtures/cairn.conf` 一致 (`sameAsFixtureExceptRepo = true`)。如果这个实验求值失败 (`throw`)，运行器会把它标成失败，所以退出码 0 本身就是断言。

## programs.* 还是 home.file、xdg.configFile

Home Manager 里写一个配置文件有三个层次。最底层是 `home.file.<目标>`：`source` 或 `text`，`target` 默认是属性名 ([`modules/lib/file-type.nix` L148](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/lib/file-type.nix#L148))，还有 `onChange`、`force`、`executable`。中间层是 `xdg.configFile.<名字>`，同一个文件类型，只是把根换成 `xdg.configHome`，再并进 `home.file` ([`modules/misc/xdg/default.nix` L205](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/misc/xdg/default.nix#L205))。最上层是 `programs.<名字>`：带类型的选项、把选项渲染成文件、装包、挂激活脚本。`programs.cairn` 就是第三层，而它渲染出的文件，走的是第二层。

store 里文件的名字能看到这个关系：`.config/cairn/cairn.conf` 指向 `hm_cairncairn.conf`，名字是 `hm_` 加 `storeFileName "cairn/cairn.conf"`（[`file-type.nix` L154](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/lib/file-type.nix#L154)，斜杠不是 store 名字的合法字符，被丢掉了）；`home.file` 的目标 `.config/...` 到了 `xdg` 层就是相对 `configHome` 的 `cairn/cairn.conf`。

什么时候用哪一层？我给自己定的规矩只有一条：有 `programs.<名字>` 就用它，因为它会替你做类型检查、给包和配置选对默认值、必要时挂激活脚本；没有，才退到 `xdg.configFile`（放在 `~/.config` 下的）或 `home.file`（`$HOME` 根上的点文件）。有多少 `programs.<名字>` 可用？这是 `lab/ch18/hm_option_count.sh` 数的：

```nix
  docs = lib.filter (o: o.visible && !o.internal) (lib.optionAttrSetToDocList options.programs);
```

（节选自 `lab/ch18/fixtures/option_count.nix` 的 L8，用 `optionAttrSetToDocList` 是因为它就是手册的选项列表所用的函数，隐藏和内部选项被排除在外）

```text
$ cat out/ch18/hm_option_count.stdout
{
  "programsModules": 413,
  "programsOptions": 3162,
  "top": [
    {
      "count": 122,
      "name": "zsh"
    },
    {
      "count": 70,
      "name": "librewolf"
    },
    {
      "count": 69,
      "name": "firefox"
    },
    {
      "count": 69,
      "name": "floorp"
    },
    {
      "count": 67,
      "name": "macchina"
    }
  ]
}
```

demo 的求值里有 413 个 `programs.<名字>` 模块、3162 个可见的 `programs.*` 选项；`zsh` 一个就有 122 个。我们自己的 `programs.cairn` 占其中 12 个（`enable`、`package`、`settings`、`settings.cairn.{configText,excludes,repo,sources,keep.daily,keep.last,keep.weekly}`、`timer.{enable,onCalendar}`）：

```text
$ nix eval --impure --json --expr 'let f = builtins.getFlake (toString ./.); inherit (f.inputs.nixpkgs) lib; in map (o: o.name) (lib.filter (o: o.visible && !o.internal) (lib.optionAttrSetToDocList f.homeConfigurations.demo.options.programs.cairn))' | jq length
12
```

（手敲，不在 `lab/ch18/` 里）

12 个选项，占 3162 个的 0.38%。这个数只是“Home Manager 在这个提交上替你写了多少个模块”的量级，换一个提交就会变，别把它当成常量。

## 接进 flake：输入、homeModules、homeConfigurations 与 home-files 检查

先看输入。第 17 篇里 `inputs` 还是一条一条分开写的，这一章它被合成了一个块：

```nix
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # ...
    # 第 18 章：Home Manager，同样锁在 2026-08-23 之前 master 的最后一个提交。
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };
```

（节选自 `flake.nix` 的 L4 到 L18，`# ...` 处是第 17 章的 `sops-nix`）

不是我偏爱这个写法。三个输入各写一行 `inputs.xxx.url = ...`，`statix` 就报 `[20] Warning: Avoid repeated keys in attribute sets`，`make lint` 不会放过。我把这个复现了一遍：

```text
$ cat /tmp/scratch18/repeated.nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.sops-nix.url = "github:Mic92/sops-nix";
  inputs.home-manager.url = "github:nix-community/home-manager";
}
$ statix check /tmp/scratch18/repeated.nix
[20] Warning: Avoid repeated keys in attribute sets
   ╭─[ /tmp/scratch18/repeated.nix:2:3 ]
   │
 2 │   inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
   │   ─────────┬────────  
   │            ╰────────── The key inputs is first assigned here ...
 3 │   inputs.sops-nix.url = "github:Mic92/sops-nix";
   │   ─────────┬─────────  
   │            ╰─────────── ... repeated here ...
 4 │   inputs.home-manager.url = "github:nix-community/home-manager";
   │   ───────────┬───────────  
   │              ╰───────────── ... and here. Try inputs = { nixpkgs.url=...; sops-nix.url=...; home-manager.url=...; } instead.
───╯
```

（手敲，不在 `lab/ch18/` 里；`statix` 0.5.8-unstable-2026-07-17，在 `nix develop` 里）

我另试过只有两个 `inputs.` 键的文件，`statix` 不报，所以触发线大概是三次，这一点我没有去翻 `statix` 的源码确认。

`home-manager.inputs.nixpkgs.follows = "nixpkgs"` 的效果直接读锁文件：Home Manager 自己的 `flake.lock` 锁的是 nixpkgs `391b592` (2026-08-20)，我们的是 `56c02bc` (2026-08-23)；加了 `follows` 以后，`flake.lock` 里 `home-manager` 节点的 `inputs.nixpkgs` 是 `["nixpkgs"]`，整个仓库只有一个 nixpkgs（“环境”一节的 `jq` 输出里已经看到了）。代价 Home Manager 的手册在 [`docs/manual/nix-flakes.md` L38 到 L40](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/docs/manual/nix-flakes.md#L38-L40) 写了：这去掉了“Home Manager 与它自己锁的那个 nixpkgs 版本相互兼容”这个假设，“跟着 unstable 走时要小心”。

接着是输出。独立配置通过一个 `homeFor` 函数构造，`checks` 和 `homeConfigurations` 都用它：

```nix
      # 第 18 章：独立的 Home Manager 配置，pkgs 带 Firn 的 overlay。
      homeFor =
        system:
        home-manager.lib.homeManagerConfiguration {
          pkgs = pkgsFor system;
          modules = [
            self.homeModules.cairn
            ./home/demo.nix
          ];
        };
```

（节选自 `flake.nix` 的 L41 到 L50）

`pkgsFor` 是第 10 篇的那个“每个系统一份、带 Firn overlay 的 pkgs”。模块列表是两项：`self.homeModules.cairn` 和 `./home/demo.nix`。后者整个文件只有 16 行：

```nix
# 一个独立（standalone）的 Home Manager 配置：用户 demo，只装 cairn。
_: {
  home = {
    username = "demo";
    homeDirectory = "/home/demo";
    stateVersion = "26.05";
  };

  programs = {
    cairn = {
      enable = true;
      settings.cairn.sources = [ "/home/demo/Documents" ];
    };
    home-manager.enable = true;
  };
}
```

（`home/demo.nix` 全文，L1 到 L16）

开头的 `_:` 也不是风格选择：写成 `{ ... }:`，`statix` 报 `[10] Warning: Found empty pattern in function argument`（我复现过，`This pattern is empty, use _ instead`）。`home.username`、`home.homeDirectory` 要显式写，是因为它们只在 `stateVersion` 比 20.09 老时才有默认值，而且那个默认值是 `builtins.getEnv "USER"` 和 `builtins.getEnv "HOME"`（[`modules/home-environment.nix` L630 到 L635](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/home-environment.nix#L630-L635)），纯求值下读不到，`home.stateVersion` 本身没有默认值，“home.stateVersion”一节会量。`programs.home-manager.enable = true` 在独立模式下把 `home-manager` 命令行装进用户环境；在 NixOS 模块模式下它什么都不装，这在“generations 与回滚”一节会量到。

两个模块输出放在 flake 的末尾：

```nix
      # 第 18 章：programs.cairn，以及用它搭的独立配置 demo（只构建，不激活）。
      homeModules = {
        cairn = {
          imports = [ ./home/modules/cairn.nix ];
          nixpkgs.overlays = [ self.overlays.default ];
        };
        default = self.homeModules.cairn;
      };

      homeConfigurations.demo = homeFor "x86_64-linux";
```

（节选自 `flake.nix` 的 L362 到 L371）

`homeModules` 是 Home Manager 社区约定的输出名，不是 Nix 自己定义的，我以为 `nix flake check` 会对它警告 `unknown flake output 'homeModules'`。我在 Nix 2.34.9 上跑了，没有看到这条警告（输出在“检查点”一节）；我没有去查 2.34.9 的源码是怎么对待未知输出的，只报告看到的。

`homeModules.cairn` 比裸的 `home/modules/cairn.nix` 多了一行 `nixpkgs.overlays = [ self.overlays.default ]`：独立模式下，用户传进来的可能是一份没有 Firn overlay 的 nixpkgs，模块自己带上 overlay，`pkgs.cairn` 才找得到。这一点我用一份 `nixpkgs.legacyPackages` 验证过：

```nix
{ firnPath, withOverlay }:
let
  firn = builtins.getFlake firnPath;
  inherit (firn.inputs) nixpkgs home-manager;
  home = home-manager.lib.homeManagerConfiguration {
    pkgs = nixpkgs.legacyPackages.x86_64-linux;
    modules = [
      (if withOverlay then firn.homeModules.cairn else "${firn.outPath}/home/modules/cairn.nix")
      "${firn.outPath}/home/demo.nix"
    ];
  };
in
home.config.programs.cairn.package.name
```

（`/tmp/scratch18/plain_pkgs.nix`，全文）

```text
$ for w in true false; do echo "== withOverlay=$w"; nix eval --impure --json --expr "import /tmp/scratch18/plain_pkgs.nix { firnPath = toString ./.; withOverlay = $w; }" 2>&1 | grep -v '^\s*$' | tail -1; done
== withOverlay=true
"cairn-0.1.0"
== withOverlay=false
       error: cairn cannot be found in pkgs
```

（手敲，不在 `lab/ch18/` 里）

传进来的是没有 Firn overlay 的 `legacyPackages`：用 `homeModules.cairn` 找得到包，用裸模块找不到。这一行在 NixOS 模块模式下反而是问题，“作为 NixOS 模块：虚拟机测试”一节会讲，所以那个测试导入的是 `./home/modules/cairn.nix`，不是 `homeModules.cairn`。

而在独立模式的 demo 里，这一行是多余的，而且有个我没预料到的副作用。`homeFor` 传进去的 `pkgs` 已经带了 Firn 的 overlay，`lib/eval-config.nix` 又会把 `pkgs.overlays` 抄进 `nixpkgs.overlays`（[L27 到 L31](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/lib/eval-config.nix#L27-L31)），`homeModules.cairn` 再加一份，结果是同一个 overlay 被加了两次：

```text
$ nix eval --impure --expr 'let f = builtins.getFlake (toString ./.); in builtins.length (import f.inputs.nixpkgs { system = "x86_64-linux"; overlays = [ f.overlays.default ]; }).overlays'
1
$ nix eval .#homeConfigurations.demo.config.nixpkgs.overlays --apply builtins.length
2
```

（手敲，不在 `lab/ch18/` 里）

与 `homeFor` 里同样构造的 `pkgs`，它的 `.overlays` 有 1 项（Firn 的）；到了 Home Manager 的 `nixpkgs.overlays`，是 2 项：另一项来自模块。对这个 overlay 来说，加两次得到的包一样（它只是往包集里加 6 个 `callPackage` 出来的属性，第 10、11 篇的那几个包），所以 `pkgs.cairn` 照样是 `cairn-0.1.0`，我没有发现任何功能上的差别；但这是个“只是碰巧无害”的重复，如果换成一个会累加副作用的 overlay，我会担心。

最后是 `home-files` 检查，它的做法和第 15 篇的 `cairn-settings` 检查一样：

```nix
          # ...
          home-files =
            let
              home = homeFor system;
            in
            pkgs.runCommand "firn-home-files"
              {
                homeFiles = home.config.home-files;
                expected = pkgs.writeText "expected-cairn.conf" ''
                  repo = /home/demo/.local/share/cairn/repo
                  source = /home/demo/Documents
                  keep_last = 5
                  keep_daily = 7
                  keep_weekly = 4
                '';
              }
              ''
                diff -u "$expected" "$homeFiles/.config/cairn/cairn.conf" >&2
                echo ok > $out
              '';
```

（节选自 `flake.nix` 的 L236 到 L255）

它取的是 `home.config.home-files`，也就是“把激活包拆开”一节里那棵 `home-files` 树，不是整个激活包，闭包小得多：7 个路径、233,228,288 字节，其中 `glibc-locales` 一项就占 233,224,472（`10-home-manager.conf` 引用了它）。这个检查比较的是 5 行文本，成本却是先把整份 locales 弄进 store：

```text
$ nix path-info -S "$(nix eval --raw .#homeConfigurations.demo.config.home-files.outPath)" | awk '{ printf "%d bytes\n", $2 }'
233228288 bytes
$ nix path-info -r "$(nix eval --raw .#homeConfigurations.demo.config.home-files.outPath)" | wc -l
7
```

（手敲，不在 `lab/ch18/` 里）

检查本身通过：


```text
$ cat $(nix build .#checks.x86_64-linux.home-files --no-link --print-out-paths)
ok
$ nix eval .#checks --apply 'c: builtins.mapAttrs (_: x: builtins.length (builtins.attrNames x)) c' --json
{"aarch64-linux":13,"x86_64-linux":19}
```

（手敲，不在 `lab/ch18/` 里）

`checks.<系统>.home-files` 是每个系统一份：`homeFor system` 在 `aarch64-linux` 上也会求值（我只验证了它的 `drvPath` 能算出来，没有构建）。x86_64-linux 上一共 19 个检查，比第 17 篇多 `home-files` 和 `home-vm`；aarch64-linux 上 13 个，少的 6 个是 `cairn-vm`、`secrets-vm`、`home-vm` 三个虚拟机测试，加上只在 x86_64-linux 上有的 `pkg-firn-hello-aarch64`、`pkg-firn-hello-musl`、`pkg-firn-hello-static`。`homeConfigurations.demo` 只有一份，固定是 `x86_64-linux`。

## 把激活包拆开

`homeConfigurations.demo` 的求值结果里，真正会被装到机器上的是 `config.home.activationPackage`：一个 store 路径，里面是 `activate` 脚本，加上它要摆进 `$HOME` 的东西。`lab/ch18/hm_activation_package.sh` 构建它，再一层一层看：

```bash
main() {
  local pkg
  pkg="$(nix build "${ATTR}" --no-link --print-out-paths)"

  echo "== top level of the generation (symlinks show their target)"
  find "${pkg}/" -mindepth 1 -maxdepth 1 -printf '%f %l\n' | sed 's/ *$//' | sort | hide_hash
  echo
  echo "== home-files: every link that activation puts into \$HOME"
  find "${pkg}/home-files/" -type l -printf '%P -> %l\n' | sort | hide_hash
  # ...
  echo "== activate"
  echo "lines: $(wc -l <"${pkg}/activate")"
  # ...
}
```

（节选自 `lab/ch18/hm_activation_package.sh` 的 L18 到 L37，`hide_hash` 把 store 哈希换成 `<hash>` 让输出稳定）

```text
$ cat out/ch18/hm_activation_package.stdout
== top level of the generation (symlinks show their target)
activate
bin
extra-dependencies
gen-version
hm-version
home-files /nix/store/<hash>-home-manager-files
home-path /nix/store/<hash>-home-manager-path

== home-files: every link that activation puts into $HOME
.cache/.keep -> /nix/store/<hash>-hm_homedemo.cache.keep
.config/cairn/cairn.conf -> /nix/store/<hash>-hm_cairncairn.conf
.config/environment.d/10-home-manager.conf -> /nix/store/<hash>-hm_environment.d10homemanager.conf
.config/systemd/user/tray.target -> /nix/store/<hash>-tray.target/tray.target
.local/state/.keep -> /nix/store/<hash>-hm_homedemo.localstate.keep

== cairn.conf behind its link
repo = /home/demo/.local/share/cairn/repo
source = /home/demo/Documents
keep_last = 5
keep_daily = 7
keep_weekly = 4

== activate
lines: 389

== closure
closure size: 666718104 bytes
closure paths: 170
```

生成里有两个符号链接：`home-files` 是“要链接进 `$HOME` 的文件”的整棵树，`home-path` 是“要装进用户 profile 的包”的环境（`installPackages` 那一步用的 `${cfg.path}`，我猜就是它）。`home-files` 里一共 5 个链接，其中只有 `.config/cairn/cairn.conf` 来自 `programs.cairn`：两个 `.keep` 是 `xdg.cacheHome` 和 `xdg.stateHome` 目录的占位（[`modules/misc/xdg/default.nix` L208 到 L209](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/misc/xdg/default.nix#L208-L209)），`environment.d/10-home-manager.conf` 是会话变量，`tray.target` 是 Home Manager 在 `xsession.enable` 没开时无条件生成的用户 target（[`modules/wayland.nix` L25 到 L27](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/wayland.nix#L25-L27)）。这就是 `home-files` 检查要对比的地方：`checks.<系统>.home-files` 取的是这个目录里的 `.config/cairn/cairn.conf`，逐字对比期望的文本。

Home Manager 的激活，用一个比方来说，像搬家公司拿着清单进屋：清单 (`home-files`) 在 store 里已经算好，工人 (`activate`) 不做决定，只检查有没有东西撞车、再按清单摆放、最后通知需要重启的服务。这个比方我就用这一次。

### 666,718,104 字节从哪来

5 个链接怎么会是 666,718,104 字节？我把闭包里每个路径的 NAR 大小排了个序：

```text
$ P=$(nix build .#homeConfigurations.demo.activationPackage --no-link --print-out-paths)
$ nix path-info -rs "$P" | sort -k2 -n -r | head -n 4 | sed -E 's|/nix/store/[a-z0-9]{32}-||'
glibc-locales-2.42-67                  	  233224472
systemd-261.1                          	   65103424
icu4c-78.3                             	   41437848
glibc-2.42-67                          	   35073096
$ nix path-info -rs "$P" | awk '{ s += $2 } END { print s }'
666718104
$ nix path-info -rs "$P" | grep glibc-locales | awk '{ printf "%d bytes, %.1f%%\n", $2, 100 * $2 / 666718104 }'
233224472 bytes, 35.0%
$ nix why-depends "$P" "$(nix path-info -r "$P" | grep glibc-locales)" | sed -E 's|/nix/store/[a-z0-9]{32}-||g'
home-manager-generation
└───home-manager-files
    └───hm_environment.d10homemanager.conf
        └───glibc-locales-2.42-67
$ sed -E 's|/nix/store/[a-z0-9]{32}-|/nix/store/<hash>-|g' "$P/home-files/.config/environment.d/10-home-manager.conf"
LOCALE_ARCHIVE_2_27=/nix/store/<hash>-glibc-locales-2.42-67/lib/locale/locale-archive
```

（手敲，不在 `lab/ch18/` 里）

各路径 NAR 大小之和正好是 666718104（和实验里的 `nix path-info -S` 一致）；最大的一项 `glibc-locales` 是 233,224,472 字节，占 35.0%。`nix why-depends` 给出的链很短：激活包到 `home-files`，到 `10-home-manager.conf`，到 `glibc-locales`。那个文件的内容只有一行 `LOCALE_ARCHIVE_2_27=...`，是 [`modules/config/i18n.nix` L31 到 L38](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/config/i18n.nix#L31-L38) 把 `${glibcLocales}/lib/locale/locale-archive` 放进会话变量。一个只有一行文本的文件，让整份 `glibc-locales` 进了闭包。

这提醒我一件事：闭包大小衡量的是“引用了什么”，不是“写了多少”。`programs.cairn` 的整份配置是 5 行文本；我原来押的是 `cairn` 自己会是大头（第 11 篇量过，它的闭包 129.7 MiB），押错了：最大的那一项 `glibc-locales` 是 222.4 MiB，`cairn` 的整个闭包连它的六成都不到 (129.7 / 222.4 = 0.58)。我只量了这一个样本；换一个提交、换一组 `programs.*`，这些数都会变。

### activate 脚本里是什么

`activate` 有 389 行。我数了其中 `_iNote "Activating %s"` 的行：

```text
$ grep -n 'Activating' "$P/activate" | sed -E 's|/nix/store/[a-z0-9]{32}-|<hash>-|g'
236:_iNote "Activating %s" "checkLinkTargets"
247:_iNote "Activating %s" "writeBoundary"
258:_iNote "Activating %s" "cairnInit"
262:_iNote "Activating %s" "checkFilesChanged"
274:_iNote "Activating %s" "installPackages"
304:_iNote "Activating %s" "linkGeneration"
336:_iNote "Activating %s" "onFilesChange"
339:_iNote "Activating %s" "reloadSystemd"
```

（手敲，不在 `lab/ch18/` 里）

8 个块，第一个从 236 行开始：第 236 行之前的 235 行（占 60.4%）是脚本头：设好 `PATH` 和翻译域、解析 `--driver-version`、定义 `nixProfileRemove` 一类的辅助函数、做健全性检查 (`SKIP_SANITY_CHECKS`)，每个块只是 `config.home.activation` 里的一项被翻译成的一小段 shell。这些块的先后顺序，是“激活的顺序：DAG 与 writeBoundary”一节要回答的问题。

## 激活的顺序：DAG 与 writeBoundary

`home.activation` 的类型是 `lib.hm.types.dagOf types.str`：一个属性集，每个值带着 `data`（那段 shell）、`before` 和 `after` 两个名字列表。构造函数在 [`modules/lib/dag.nix` 的 L123 到 L129](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/lib/dag.nix#L123-L129)：

```nix
  entryBetween = before: after: data: { inherit data before after; };

  # Create a DAG entry with no particular dependency information.
  entryAnywhere = entryBetween [ ] [ ];

  entryAfter = entryBetween [ ];
  entryBefore = before: entryBetween before [ ];
```

（节选自 Home Manager 的 `modules/lib/dag.nix`）

`entryAfter [ "x" ] data` 就是 `before = [ ]`、`after = [ "x" ]`。`topoSort` 先把所有 `before` 边翻成对面的 `after`（`after = v.after ++ dagBefore n`，[L98 到 L119](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/lib/dag.nix#L98-L119)），再交给 `lib.toposort`；出环时，激活包的求值直接 `abort`（[`home-environment.nix` L782 到 L787](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/home-environment.nix#L782-L787)）。所以排序是求值期的事，和激活跑在哪里无关。

`lab/ch18/hm_dag.nix` 把 demo 的 `home.activation` 取出来，调用同一个 `topoSort`，打印顺序和边：

```nix
  inherit (flake.inputs.home-manager.lib.hm) dag;
  inherit (flake.inputs.nixpkgs.lib.lists) findFirstIndex;
  inherit (flake.homeConfigurations.demo.config.home) activation;
  order = map (entry: entry.name) (dag.topoSort activation).result;
  position = name: findFirstIndex (entry: entry == name) null order;
in
{
  inherit order;
  edges = builtins.mapAttrs (_: entry: { inherit (entry) before after; }) activation;
  cairnInitBeforeLinkGeneration = position "cairnInit" < position "linkGeneration";
}
```

（节选自 `lab/ch18/hm_dag.nix` 的 L8 到 L18）

```text
$ nix eval --json --file lab/ch18/hm_dag.nix | jq -c '.order, .cairnInitBeforeLinkGeneration'
["checkLinkTargets","writeBoundary","cairnInit","checkFilesChanged","installPackages","linkGeneration","onFilesChange","reloadSystemd"]
true
$ nix eval --json --file lab/ch18/hm_dag.nix | jq -r '.edges | to_entries[] | "\(.key): after=\(.value.after) before=\(.value.before)"'
cairnInit: after=["writeBoundary"] before=[]
checkFilesChanged: after=[] before=["linkGeneration"]
checkLinkTargets: after=[] before=["writeBoundary"]
installPackages: after=["writeBoundary"] before=[]
linkGeneration: after=["writeBoundary"] before=[]
onFilesChange: after=["linkGeneration"] before=[]
reloadSystemd: after=["linkGeneration"] before=[]
writeBoundary: after=[] before=[]
```

（手敲，不在 `lab/ch18/` 里；两条命令是实验同一份输出的 jq 视图，原始输出在 `out/ch18/hm_dag.stdout`）

顺序和 `activate` 里 8 个 `Activating` 的顺序完全一致。几条边值得停一下：

- `checkLinkTargets` 在 `writeBoundary` 之前，`linkGeneration` 在它之后。`writeBoundary` 本身几乎什么都不做（驱动版本 1 时它那个 `if` 不成立），它是个锚点：选项文档在 [`home-environment.nix` L487 到 L496](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/home-environment.nix#L487-L496) 规定，有副作用的块必须放在它之后，之前只能放“检查状态、不满意就退出”的块，`checkLinkTargets` 就是这样一个检查块：它在动手之前看一遍新 generation 的链接会不会覆盖不归 Home Manager 管的文件。
- `checkFilesChanged` 是“`linkGeneration` 之前”，`onFilesChange` 是“`linkGeneration` 之后”：前者在链接之前记下哪些带 `onChange` 的文件变了，后者在链接之后执行那些 `onChange`。
- `reloadSystemd` 在 `linkGeneration` 之后：新单元文件链接进 `~/.config/systemd/user` 之后才去通知用户的 systemd。
- `cairnInit` 只有一条边：`after = [ "writeBoundary" ]`。`linkGeneration` 也只有同样一条。两者之间没有边。

同在 `writeBoundary` 之后的这几个，输出里恰好按名字字母序排，我没有读 `lib.toposort` 的实现去确认这是规则，所以不要依赖它：DAG 只承诺边。

### cairnInit 排在 linkGeneration 之前

没有边的两个节点，顺序就是实现细节，而这里的实现细节是 `cairnInit` 先 (`cairnInitBeforeLinkGeneration = true`)。后果在 `nixos/tests/home.nix` 里量到了：首次激活时，`cairn init` 跑的时候 `~/.config/cairn/cairn.conf` 还没链接。`bin/cairn` 的 `init` 在仓库是新建的、配置文件又不存在时会写一份模板（[`cairn` 仓库 `ch10` 标签的 `bin/cairn` L105 到 L119](https://github.com/bfmhno3/cairn/blob/ch10/bin/cairn#L105-L119)）：

```bash
cmd_init() {
  local dir
  dir="$(cairn::repo::init "$1")" || return
  if [[ -z "${dir}" ]]; then
    return 0
  fi
  local config
  config="$(cairn::config::path)" || return 1
  if [[ -e "${config}" ]]; then
    return 0
  fi
  mkdir -p -- "$(dirname -- "${config}")" || return 1
  cairn::config::template "${dir}" >"${config}" || return 1
  cairn::log::info "wrote ${config}"
}
```

（节选自 `cairn` 仓库 `ch10` 标签的 `bin/cairn`，也就是 `pkgs/cairn` 打包的那个版本）

测试脚本读 `home-manager-alice.service` 的日志，看有没有 `wrote /home/alice/.config/cairn/cairn.conf`，打印的是 `firn: init_wrote_template True`：模板写了。随后 `linkGeneration` 到了，目标已经是一个普通文件。这时不会报错，因为 `checkLinkTargets` 在 `writeBoundary` 之前，模板那时还不存在；`linkGeneration` 那条“目标存在且不是符号链接”的慢路径（[`modules/files.nix` L276 到 L303](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/files.nix#L276-L303)）在没设备份扩展名或备份命令的情况下，先 `cmp -s` 比较，不同就 `ln -Tsf` 直接覆盖：

```bash
            if [[ -e "$targetPath" && ! -L "$targetPath" ]] && cmp -s "$sourcePath" "$targetPath" ; then
              # The target exists but is identical - don't do anything.
              verboseEcho "Skipping '$targetPath' as it is identical to '$sourcePath'"
            else
              # Place that symlink, --force
              # This can still fail if the target is a directory, in which case we bail out.
              run mkdir -p $VERBOSE_ARG "$(dirname "$targetPath")"
              run ln -Tsf $VERBOSE_ARG "$sourcePath" "$targetPath" || exit 1
            fi
```

（节选自 Home Manager 的 `modules/files.nix` L295 到 L303）

所以最终的状态是对的 (`conf_symlink into /nix/store`)，中间多了一次写文件、再被替换。我把它当作这个模块在 `ch18` 的一个已知性质写在这里，不是有意的设计，`home/modules/cairn.nix` 的注释也承认了这一点。Home Manager 自己的模块遇到“要在链接之后做事”时有一个固定写法：[`modules/programs/uv.nix` L237 到 L238](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/programs/uv.nix#L237-L238) 的注释是 `Run after linkGeneration so uv sees the freshly linked uv.toml.`，写成 `lib.hm.dag.entryAfter [ "linkGeneration" ]`。我数了一下这个字面串在 Home Manager 里出现多少次：

```text
$ HM=$(nix flake prefetch --json github:nix-community/home-manager/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9 | jq -r .storePath)
$ grep -rn 'entryAfter \[ "linkGeneration" \]' "$HM/modules" | wc -l
19
$ grep -rln 'entryAfter \[ "linkGeneration" \]' "$HM/modules" | wc -l
13
```

（手敲，不在 `lab/ch18/` 里）

13 个文件里 19 处。换成这个写法以后 `cairn init` 会不会就不写模板了？我在练习 2 里用虚拟机验证了一次。

## 作为 NixOS 模块：虚拟机测试

独立配置只构建、不激活。激活的行为我放进一个 NixOS 虚拟机里看：`nixos/tests/home.nix` 把 Home Manager 作为 NixOS 模块装进一个节点，用户 `alice` 开 linger，`programs.cairn` 开定时器，测试脚本检查文件、定时器、仓库，并把测到的值以 `firn: <key> <value>` 打印。节点的配置是：

```nix
  # ...
  node.pkgsReadOnly = false;

  nodes.machine =
    { ... }:
    {
      imports = [ homeManagerModule ];
      nixpkgs.overlays = [ overlay ];

      users.users.alice = {
        isNormalUser = true;
        linger = true;
      };

      home-manager = {
        # 用系统的 pkgs 求值用户配置，不再为每个用户 import 一遍 nixpkgs。
        useGlobalPkgs = true;
        users.alice =
          { config, ... }:
          {
            imports = [ cairnHomeModule ];
            home.stateVersion = "26.05";
            # ...
            home.packages = [ config.programs.home-manager.package ];
            programs = {
              cairn = {
                enable = true;
                settings.cairn.sources = [ "/home/alice/docs" ];
                timer.enable = true;
              };
            };
          };
      };
    };
```

（节选自 `nixos/tests/home.nix` 的 L14 到 L48）

`home-manager.users.alice` 是 NixOS 的一个选项，类型是 `types.submoduleWith`（[`nixos/common.nix` L25 到 L30](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/nixos/common.nix#L25-L30)）：它里面又是一整个 Home Manager 的 `evalModules`，`specialArgs` 里带着 `osConfig`，也就是外层的 NixOS 配置；`home.username` 和 `home.homeDirectory` 在同一个文件的 L64 起从 `users.users.alice` 取，所以测试里一个都没写。第 15 篇的 submodule 在这里是真的在干活。

### useGlobalPkgs：用户配置里的 overlay 去哪了

这个节点最啰嗦的部分，是对 overlay 的绕行：overlay 加在**系统**上，用户模块导入的是裸的 `./home/modules/cairn.nix`，不是 `homeModules.cairn`；`node.pkgsReadOnly = false` 是因为测试框架默认让 `nixpkgs.*` 只读（[nixpkgs `nixos/lib/testing/nodes.nix` L265 到 L274](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/lib/testing/nodes.nix#L265-L274)，第 16 篇讲过），而这里系统要自己设 `nixpkgs.overlays`。为什么不能让用户模块带 overlay？`useGlobalPkgs` 的选项文档（[`nixos/common.nix` L95 到 L98](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/nixos/common.nix#L95-L98)）写的是：使用系统的 `pkgs`，“这会禁用 Home Manager 的 `nixpkgs.*` 选项”。我写了一个小配置，把四种组合都跑了一遍：

```nix
{
  firnPath,
  systemOverlay,
  rawModule,
  userPackages ? false,
}:
let
  firn = builtins.getFlake firnPath;
  inherit (firn.inputs) nixpkgs home-manager;
  cairnModule =
    if rawModule then "${firn.outPath}/home/modules/cairn.nix" else firn.homeModules.cairn;
  system = nixpkgs.lib.nixosSystem {
    # ...
        nixpkgs.overlays = nixpkgs.lib.optional systemOverlay firn.overlays.default;
        users.users.alice.isNormalUser = true;
        home-manager = {
          useGlobalPkgs = true;
          useUserPackages = userPackages;
          users.alice = {
            imports = [ cairnModule ];
            home.stateVersion = "26.05";
            programs.cairn.enable = true;
          };
        };
    # ...
  };
  alice = system.config.home-manager.users.alice;
in
{
  warnings = map (builtins.substring 0 70) alice.warnings;
  package = alice.programs.cairn.package.name;
  userPackages = map (p: p.name) system.config.users.users.alice.packages;
}
```

（`/tmp/scratch18/global_pkgs.nix`，43 行；两处 `# ...` 省掉了 `system = "x86_64-linux"`、`modules = [`、`home-manager.nixosModules.home-manager`、几层花括号，以及只为让它求值通过的 `system.stateVersion`、`boot.loader.grub.enable = false` 和 `fileSystems."/"`；缩进是原文件的）

```text
$ for v in "false false" "false true" "true false" "true true"; do set -- $v; echo "== systemOverlay=$1 rawModule=$2"; nix eval --impure --json --expr "import /tmp/scratch18/global_pkgs.nix { firnPath = toString ./.; systemOverlay = $1; rawModule = $2; }" 2>&1 | grep -v '^\s*$' | tail -1; done
== systemOverlay=false rawModule=false
       error: cairn cannot be found in pkgs
== systemOverlay=false rawModule=true
       error: cairn cannot be found in pkgs
== systemOverlay=true rawModule=false
{"package":"cairn-0.1.0","userPackages":[],"warnings":["You have set either `nixpkgs.config` or `nixpkgs.overlays` while using"]}
== systemOverlay=true rawModule=true
{"package":"cairn-0.1.0","userPackages":[],"warnings":[]}
```

（手敲，不在 `lab/ch18/` 里；`warnings` 我只截了每条的前 70 个字符）

四行读下来：

- 第一行，系统没有 overlay，用户模块带着 `nixpkgs.overlays` (`rawModule=false`)：`error: cairn cannot be found in pkgs`。用户配置里的 overlay 被无视了，`pkgs` 是系统的，系统里没有 `cairn`。这是 `mkPackageOption` 找不到包时的 `throw` ([nixpkgs `lib/options.nix` L322](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/options.nix#L322))。
- 第二行，两边都没有 overlay：同样的错误。`rawModule` 在没有系统 overlay 时帮不上忙。
- 第三行，系统有 overlay，用户也导入了带 overlay 的模块：求值成功，`package` 是 `cairn-0.1.0`，但 `warnings` 有一条，开头是 `You have set either nixpkgs.config or nixpkgs.overlays while using` ……：成功，是因为包来自**系统**的 overlay，用户那份 overlay 仍然是被无视的。
- 第四行，系统有 overlay，用户导入裸模块：成功，没有警告。这就是测试用的组合。

这个警告和那个“失败”的来源，我读了 [`modules/misc/nixpkgs-disabled.nix` 的 L87 到 L103](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/misc/nixpkgs-disabled.nix#L87-L103)：

```nix
  config = {
    assertions = [
      # TODO: Re-enable assertion after 25.05 (&&)
      {
        assertion = cfg.config == null || cfg.overlays == null;
        message = ''
          `nixpkgs` options are disabled when `home-manager.useGlobalPkgs` is enabled.
          Definitions found in ${lib.showFiles offendingFiles}.
        '';
      }
    ];

    warnings = lib.optional ((cfg.config != null) || (cfg.overlays != null)) ''
      You have set either `nixpkgs.config` or `nixpkgs.overlays` while using `home-manager.useGlobalPkgs`.
      This will soon not be possible. Please remove all `nixpkgs` options when using `home-manager.useGlobalPkgs`.
      Definitions found in ${lib.showFiles offendingFiles}.
    '';
  };
```

断言只在 `nixpkgs.config` 和 `nixpkgs.overlays` **同时**被设置时才失败（注释里的 `(&&)` 是维护者留的，我读到的是它的意思是“以后再改成 `&&`”，没有查提交历史确认）；只设一个，是警告。所以这个模块在 `ch18` 的写法是“能跑但带警告”，直到你把 `nixpkgs.*` 搬到系统里。警告的最后一行是 `Definitions found in ...`，它在我的复现里指向的是 nixpkgs 自己的 `flake.nix`，不是 Firn 的：我没有追为什么，只当它是个靠不住的定位提示。

读到这里，`homeModules.cairn` 带 overlay、`home/modules/cairn.nix` 不带，两个入口的分工就清楚了：独立模式用前者，`useGlobalPkgs` 的 NixOS 模块用后者，overlay 由系统给。

### useUserPackages：包装到哪

测试没有设 `useUserPackages`（默认 `false`），所以 `home.packages` 里的包由激活里的 `installPackages` 装进用户自己的 profile，`~/.nix-profile`；测试里就是靠 `/home/alice/.nix-profile/bin/home-manager` 才找到了命令行。设成 `true`，包就改走 NixOS 的 `users.users.<名字>.packages`（[`nixos/common.nix` L180 到 L183](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/nixos/common.nix#L180-L183)），装到 `/etc/profiles/per-user/<名字>`，Home Manager 手册说这在 `nixos-rebuild build-vm` 里是必须的（[`docs/manual/installation/nixos.md` L127 到 L137](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/docs/manual/installation/nixos.md#L127-L137)）。同一个配置文件，我只改了 `userPackages` 这个参数：

```text
$ nix eval --impure --json --expr "import /tmp/scratch18/global_pkgs.nix { firnPath = toString ./.; systemOverlay = true; rawModule = true; userPackages = true; }"
{"package":"cairn-0.1.0","userPackages":["home-manager-path"],"warnings":[]}
```

（手敲，不在 `lab/ch18/` 里）

上一个表里 `userPackages` 一直是 `[]`；这次变成 `["home-manager-path"]`：整个 `home-path` 环境成了系统用户 `alice` 的一个包。这一项只验证了“包被交给了 NixOS”，我没有启动虚拟机看 `/etc/profiles/per-user` 里是什么。

### 测试脚本和一次 22 秒的运行

脚本检查的东西和刚读到的源码一一对应。核心断言：

```python
      conf = "/home/alice/.config/cairn/cairn.conf"
      machine.succeed(f"test -L {conf}")
      target = machine.succeed(f"readlink {conf}").strip()
      assert target.startswith("/nix/store/"), target
      report("conf_symlink", "into /nix/store")
      # ...
      machine.succeed("test -f /home/alice/.local/share/cairn/repo/cairn.repo")
      report("repo_marker", "cairn.repo")
      # ...
      timers = machine.succeed("systemctl --user -M alice@ list-timers --all")
      assert "cairn" in timers, timers
      report("user_timer", "cairn.timer")
      report("linger_file", machine.succeed("ls /var/lib/systemd/linger").strip())
```

（节选自 `nixos/tests/home.nix` 的 testScript，L68 到 L90；两处 `# ...` 分别省掉 `conf_target` 和 `source` 的检查（L73 到 L75）与 `init_wrote_template`（L79 到 L85）；L92 起的 generations 部分在“generations 与回滚”一节单独引）

`lab/ch18/home_vm_host.sh` 跑这个检查并打印 `firn:` 行。结果已经在 store 里时，Nix 只会打印缓存的结果，所以脚本先查输出路径在不在，在就加 `--rebuild` 强制再跑一遍：

```bash
  local out
  out="$(nix eval --raw "${ATTR}.outPath")"
  local -a flags=(-L --no-link)
  if [[ -e "${out}" ]]; then
    echo "== result already in the store: building with --rebuild"
    flags+=(--rebuild)
  fi
```

（节选自 `lab/ch18/home_vm_host.sh` 的 L17 到 L23；脚本接着用 `date +%s` 夹住 `nix build`，打印秒数）

输出：

```text
$ cat out/ch18/home_vm_host.stdout
== result already in the store: building with --rebuild
volatile: /dev/kvm: present
== lines printed by the test script
firn: conf_symlink into /nix/store
firn: conf_target hm_cairncairn.conf
firn: repo_marker cairn.repo
firn: init_wrote_template True
firn: user_timer cairn.timer
firn: linger_file alice
firn: hm_generations_nixos_module exit 1, 0 lines
firn: hm_generations id 1 -> home-manager-generation (current)
volatile: wall time: 22 s
```

`cairn.conf` 是指进 store 的符号链接，内容来自 `hm_cairncairn.conf`；仓库标记 `cairn.repo` 在；用户定时器 `cairn.timer` 在；`/var/lib/systemd/linger` 里有 `alice`；最后两行留给“generations 与回滚”一节，`init_wrote_template True` 在“激活的顺序”一节讲过。`--rebuild` 的墙钟是 22 秒，这是一个样本；第 17 篇里 `secrets-vm` 同样走 `--rebuild` 量到的是 102 秒，这个测试大约是它的五分之一 (102 / 22 = 4.6)，两个测试做的事不同，只说明这一台机器上这两个样本的差别。

## systemd 用户单元与 linger

`programs.cairn.timer.enable = true` 以后，`home-files` 里多出来什么？我在 demo 上打开它，只构建 `home-files`：

```nix
{ firnPath }:
let
  firn = builtins.getFlake firnPath;
  home = firn.homeConfigurations.demo.extendModules {
    modules = [ { programs.cairn.timer.enable = true; } ];
  };
in
home.config.home-files
```

（`/tmp/scratch18/timer_files.nix`，全文）

```text
$ H=$(nix build --impure --no-link --print-out-paths --expr 'import /tmp/scratch18/timer_files.nix { firnPath = toString ./.; }')
$ find "$H" -type l -printf '%P\n' | sort
.cache/.keep
.config/cairn/cairn.conf
.config/environment.d/10-home-manager.conf
.config/systemd/user/cairn.service
.config/systemd/user/cairn.timer
.config/systemd/user/timers.target.wants/cairn.timer
.config/systemd/user/tray.target
.local/state/.keep
$ find "$H" -type l | wc -l
8
$ cat "$H/.config/systemd/user/cairn.timer"
[Install]
WantedBy=timers.target

[Timer]
OnCalendar=daily
Persistent=true

[Unit]
Description=cairn snapshot timer
$ sed -E 's|/nix/store/[a-z0-9]{32}-|/nix/store/<hash>-|g' "$H/.config/systemd/user/cairn.service"
[Service]
ExecStart=/nix/store/<hash>-cairn-0.1.0/bin/cairn -c /home/demo/.config/cairn/cairn.conf snapshot
ExecStartPost=/nix/store/<hash>-cairn-0.1.0/bin/cairn -c /home/demo/.config/cairn/cairn.conf prune
Type=oneshot

[Unit]
Description=cairn snapshot of /home/demo/Documents
```

（手敲，不在 `lab/ch18/` 里）

5 个链接变成 8 个，多的三个是 `cairn.service`、`cairn.timer` 和 `timers.target.wants/cairn.timer`。第三个是 `Install.WantedBy = [ "timers.target" ]` 的实现：Home Manager 把“启用”做成了一个 `.wants` 目录里的符号链接，就是 `systemctl --user enable` 做的事，只不过是在构建期做好的。unit 文件里各个 `[段]` 的顺序是字母序（`Install`、`Timer`、`Unit`），因为它们来自一个属性集，不是我写的顺序。和 NixOS 的 `serviceConfig` 对照：这里的属性名是 `Unit`、`Service`、`Install`，就是 unit 文件里的节名，直接对应。

这三个链接让闭包涨了多少？练习 3 里量：2,008 字节、2 个路径（666,718,104 变成 666,720,112，170 变成 172）。

### 谁来启动它

链接放好，单元还没被 systemd 看见。这是 `reloadSystemd` 这个激活块的事，它排在 `linkGeneration` 之后，源码在 [`modules/systemd.nix` L519 到 L545](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/systemd.nix#L519-L545)：

```bash
        systemdStatus=$(${systemctl} --user is-system-running 2>&1 || true)

        if [[ $systemdStatus == 'running' || $systemdStatus == 'degraded' ]]; then
          # ...
          ${ensureSystemd} ${systemdCmd}

          unset newUnitsDir oldUnitsDir
        else
          echo "User systemd daemon not running. Skipping reload."
        fi
```

用户的 systemd 实例在跑，就用 `sd-switch`（`systemd.user.startServices` 默认是 `true`，即 `sd-switch`，[L335 到 L346](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/systemd.nix#L335-L346)）比较旧、新两个 generation 的单元目录，启动新增和改变的，停掉没了的；不在跑，就只打印一句 `User systemd daemon not running. Skipping reload.`，什么也不做。

“用户的 systemd 实例在不在跑”由什么决定？这就是 linger。NixOS 的 `users.users.<名字>.linger` 的文档（[nixpkgs `users-groups.nix` L455 到 L471](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/config/users-groups.nix#L455-L471)）写得清楚：不 linger，用户的单元要等到用户登录才会启动，并且可能在登出时被停掉。设成 `true`，是 `loginctl enable-linger` 的声明式版本；实现是一个 `linger-users` 系统服务（[L905 到 L955](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/config/users-groups.nix#L905-L955)），对配置里 `linger = true` 的用户跑 `loginctl enable-linger`，对 `linger = false` 的跑 `loginctl disable-linger`（[L938 到 L943](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/config/users-groups.nix#L938-L943)），并且对 `/var/lib/systemd/linger/` 里已经没有对应用户的残留文件直接 `rm`（L928 到 L936）；`/var/lib/systemd/linger/<用户>` 这个文件本身是 logind 创建或删除的，测试里 `linger_file alice` 看的就是它。

测试里的 `systemctl --user -M alice@ list-timers` 看起来像是在验证 linger，其实不是：`-M alice@` 会自己给 alice 起一个用户会话。我把测试脚本换掉，只改 `linger` 这一个值，两种取值各跑一次，看 `reloadSystemd` 和用户管理器的状态：

```nix
{ firnPath, linger }:
let
  firn = builtins.getFlake firnPath;
  inherit (firn.inputs.nixpkgs) lib;
in
firn.checks.x86_64-linux.home-vm.extend {
  modules = [
    {
      nodes.machine.users.users.alice.linger = lib.mkForce linger;
      testScript = lib.mkForce ''
        machine.wait_for_unit("multi-user.target")
        machine.wait_for_unit("home-manager-alice.service")
        unit = "home-manager-alice.service"
        journal = f"journalctl -u {unit} --no-pager"
        skip = "User systemd daemon not running.*"
        _, reload = machine.execute(f"{journal} | grep -o '{skip}'")
        found = "found a running user manager"
        print("firn: reloadSystemd", reload.strip() or found)
        _, active = machine.execute("systemctl is-active user@1000.service")
        print("firn: before list-timers user@1000.service", active.strip())
        timers = machine.succeed("systemctl --user -M alice@ list-timers --all")
        print("firn: list-timers mentions cairn", "cairn" in timers)
        _, active = machine.execute("systemctl is-active user@1000.service")
        print("firn: after list-timers user@1000.service", active.strip())
      '';
    }
  ];
}
```

（`/tmp/scratch18/probe_linger.nix`，全文；`extend` 是第 17 篇借 `secrets-vm` 用过的办法）

```text
$ for l in false true; do echo "== linger=$l"; nix build --impure --no-link -L --expr "import /tmp/scratch18/probe_linger.nix { firnPath = toString ./.; linger = $l; }" 2>&1 | grep -o 'firn: .*'; done
== linger=false
firn: reloadSystemd User systemd daemon not running. Skipping reload.
firn: before list-timers user@1000.service inactive
firn: list-timers mentions cairn True
firn: after list-timers user@1000.service active
== linger=true
firn: reloadSystemd found a running user manager
firn: before list-timers user@1000.service active
firn: list-timers mentions cairn True
firn: after list-timers user@1000.service active
```

（手敲，不在 `lab/ch18/` 里；`found a running user manager` 是我的脚本在日志里**没找到** `Skipping reload` 那行时打印的字样）

`linger = false` 时：激活的日志里就是 `User systemd daemon not running. Skipping reload.`，`user@1000.service` 在 `list-timers` 之前是 `inactive`，`list-timers` 以后变成了 `active`，也能在 `list-timers` 里看到 `cairn`，因为链接早在 `linkGeneration` 就放好了，新起的用户管理器读到的就是它。`linger = true` 时：日志里没有跳过那行，`user@1000.service` 一开始就是 `active`。

所以没有 linger 的 alice，在没人登录的机器上，`cairn.timer` 不会走，直到她第一次登录（或者有谁像 `-M alice@` 那样给她起一个会话）；`Persistent=true`（在这一节开头那份 `cairn.timer` 里）按 `systemd.timer(5)` 的说法是让错过的触发在下次启动时补上，我没有验证这个补跑。原来的测试在开头有一行 `machine.wait_for_unit("user@1000.service")`，没有 linger 时它大概会一直等到超时；我没有这样跑，我的探针换了脚本。测试里要 `linger = true`，不是装饰。

## generations 与回滚

测试脚本最后做了一件有点绕的事，它是整篇里我最想讲清楚的一处。`lab/ch18/hm_generations_host.sh` 先确保检查已经构建，再用 `nix log` 读测试的构建日志，把脚本打印的两行 `hm_generations` 取出来：

```bash
  nix build --no-link "${ATTR}"
  local lines
  lines="$(nix log "${ATTR}" | grep -o 'firn: hm_generations.*' | sed -E 's|/nix/store/[a-z0-9]{32}-|/nix/store/<hash>-|')"
```

（节选自 `lab/ch18/hm_generations_host.sh` 的 L17 到 L19，`sed` 只是把 store 哈希换成 `<hash>`）

```text
$ cat out/ch18/hm_generations_host.stdout
firn: hm_generations_nixos_module exit 1, 0 lines
firn: hm_generations id 1 -> home-manager-generation (current)
```

第一行：Home Manager 作为 NixOS 模块跑完以后，`home-manager generations` **退出码 1、0 行输出**。第二行：我在测试里手动把激活包登记成 `home-manager` profile 的一代，再跑同一条命令，才打印出 `id 1`，而且标着 `(current)`。

先说为什么命令本身都不一定在：`programs.home-manager.enable` 的实现是 `config = lib.mkIf (cfg.enable && !config.submoduleSupport.enable)` ([`modules/programs/home-manager.nix` L41](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/programs/home-manager.nix#L41))，NixOS 模块把 `submoduleSupport.enable` 设成了 `true`（[`nixos/common.nix` L50 到 L53](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/nixos/common.nix#L50-L53)），所以这个选项在 NixOS 模块模式下什么都不装。`nixos/tests/home.nix` 里自己把 `config.programs.home-manager.package` 放进 `home.packages`，才有了 `/home/alice/.nix-profile/bin/home-manager`。

为什么是退出码 1：`home-manager` 脚本开头是 `set -euo pipefail` (L6)，`doListGens` 的第一件事是 `curProfile=$(readlink home-manager)`（[L853 到 L855](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/home-manager/home-manager#L853-L855)），而 NixOS 模块这一路从来没有创建过 `~/.local/state/nix/profiles/home-manager` 这个链接。我没有用 `strace` 去证实是这一行失败，这是读源码的推断，和“退出码 1、0 行”一致。

为什么没有登记：回到“三种装法”一节引的那段 `switch`：独立模式下是 `home-manager switch` 自己先跑 `nix-env --profile ... --set`；NixOS 模块用 `--driver-version 1` 调激活脚本，`writeBoundary` 那个 `if (( $hmDriverVersion < 1 ))` 不成立，谁也不碰 profile。选项 `home-manager.enableLegacyProfileManagement`（[`nixos/common.nix` L155 到 L165](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/nixos/common.nix#L155-L165)）能改回来，文档说得很直白：打开以后每个用户有一个 `home-manager` profile，“和独立安装一样”，“嵌在系统配置里时通常不需要”。我没有打开它试过。

测试里第二步等于手工做 `switch` 的前半：

```python
      package = "${nodes.machine.home-manager.users.alice.home.activationPackage}"
      profile = "/home/alice/.local/state/nix/profiles/home-manager"
      as_alice(f"nix-env --profile {profile} --set {package}")
      generations = as_alice(f"{hm} generations")
```

（节选自 `nixos/tests/home.nix` 的 L101 到 L104）

`nix-env --profile ... --set` 把 `activationPackage` 登记成这个 profile 的第 1 代，`home-manager generations` 在 `doListGens` 里读 `home-manager-*-link`，加上 `(current)`，才有了 `id 1`。要点是：Home Manager 的“generation”只是 Nix profile 的一代，一个指向激活包的链接，和第 9 篇的 `nix profile` 是同一种东西。

回滚怎么做？独立模式下，`home-manager switch --rollback`（手册的 [`usage/rollbacks.md`](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/docs/manual/usage/rollbacks.md) 有例子）在源码里是 `rollback)` 那一支：`nix-env --profile ... --rollback`，再对回滚后的那一代跑一次 `activate`（`home-manager` 脚本的 L828 到 L837，“三种装法”一节引过）。这里有两个不同的东西：profile 的 generation 指针，和 `activate` 真正改动 `$HOME`。我在虚拟机里只验证了前一个：借 `home-vm.extend`，给 `alice` 的 profile 登记两个不同的激活包（第二个是打开了 `timer.enable` 的 demo 的），再 `nix-env --rollback`，每一步后读 `home-manager generations`。

```nix
{ firnPath }:
let
  # ...
  second =
    (firn.homeConfigurations.demo.extendModules {
      modules = [ { programs.cairn.timer.enable = true; } ];
    }).config.home.activationPackage;
in
firn.checks.x86_64-linux.home-vm.extend {
  modules = [
    (
      { config, ... }:
      let
        first = config.nodes.machine.home-manager.users.alice.home.activationPackage;
      in
      {
        nodes.machine.system.extraDependencies = [ second ];
        testScript = lib.mkForce ''
          machine.wait_for_unit("home-manager-alice.service")
          hm = "/home/alice/.nix-profile/bin/home-manager"
          profile = "/home/alice/.local/state/nix/profiles/home-manager"


          def alice(cmd):
              return machine.succeed(f"runuser -u alice -- {cmd}")


          def show(tag):
              out = alice(f"{hm} generations").strip().splitlines()
              for line in out:
                  num = line.split(": id ")[1].split(" ")[0]
                  which = "first" if "${first}" in line else "second"
                  current = "(current)" in line
                  print("firn:", tag, "id", num, which, current)


          alice(f"nix-env --profile {profile} --set ${first}")
          alice(f"nix-env --profile {profile} --set ${second}")
          show("after two --set:")
          alice(f"nix-env --profile {profile} --rollback")
          show("after --rollback:")
        '';
      }
    )
  ];
}
```

（`/tmp/scratch18/probe_rollback.nix`，两行 `# ...` 处是 `firn = builtins.getFlake firnPath;` 和 `inherit (firn.inputs.nixpkgs) lib;`；`extraDependencies` 是为了让第二个激活包进虚拟机的 store）

```text
$ nix build --impure --no-link -L --rebuild --expr 'import /tmp/scratch18/probe_rollback.nix { firnPath = toString ./.; }' 2>&1 | grep -o 'firn: .*'
firn: after two --set: id 2 second True
firn: after two --set: id 1 first False
firn: after --rollback: id 2 second False
firn: after --rollback: id 1 first True
```

（手敲，不在 `lab/ch18/` 里）

两次 `--set` 以后是 id 2（第二个包，当前）和 id 1；`--rollback` 以后当前变回 id 1，第一个包，id 2 还在。这只证明了 profile 的指针会退回去；这个探针没有再跑 `activate`，也没有调用 `home-manager switch --rollback` 本身，所以“回滚后 `$HOME` 里的链接真的换回旧的”我没有验证。NixOS 模块模式下没有 profile，`home-manager switch --rollback` 无处可回；那里的单元每次激活的是“当前系统 generation 里的那个 `activationPackage`”（`ExecStart` 里写死的 store 路径），所以我猜回滚 Home Manager 的办法是回滚整个系统 generation，再让单元重新跑一遍。这是推断，没有验证，因为我没有做真正的 `nixos-rebuild switch`。

## home.stateVersion

第 16 篇的“system.stateVersion”一节讲过 NixOS 的那个：不是“我在跑哪个版本”，是“有状态数据按哪个版本的默认值创建”。Home Manager 有一个同名的选项，值域是个枚举，`"18.09"` 到 `"26.11"`（[`modules/misc/version.nix` L11 到 L37](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/misc/version.nix#L11-L37)），**没有默认值**：

```text
$ nix eval --impure --raw --expr 'import /tmp/scratch18/nosv.nix { firnPath = toString ./.; }' 2>&1 | grep -v '^\s*$' | tail -1
       error: The option `home.stateVersion' was accessed but has no value defined. Try setting the option.
```

（手敲，不在 `lab/ch18/` 里；`/tmp/scratch18/nosv.nix` 里只有 `homeModules.cairn` 和一个设了 `home.username`、`home.homeDirectory` 的内联模块，没有 `home.stateVersion`，也没有 `programs.cairn.enable`，用 `homeManagerConfiguration` 求值 `activationPackage.drvPath`；18 行，我没有贴全文）

demo 写的是 `"26.05"`，而锁住的 Home Manager 的版本是 26.11 (`home.version.release`)：

```text
$ nix eval .#homeConfigurations.demo.config.home.stateVersion
"26.05"
$ nix eval .#homeConfigurations.demo.config.home.version.release
"26.11"
```

（手敲，不在 `lab/ch18/` 里）

两个版本号再一次碰面，和 NixOS 那边一样。它到底改变什么？我找了一个看得见的：`home.emptyActivationPath`，“激活脚本是否以空的 `PATH` 起步”，默认值是 `lib.versionAtLeast stateVersion "22.11"`（[`modules/home-environment.nix` L453 到 L457](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/home-environment.nix#L453-L457)）。把 demo 的 `stateVersion` 换成三个值，读这个默认值：

```nix
{ firnPath }:
let
  firn = builtins.getFlake firnPath;
  inherit (firn.homeConfigurations) demo;
  at =
    v:
    (demo.extendModules {
      modules = [ { home.stateVersion = firn.inputs.nixpkgs.lib.mkForce v; } ];
    }).config.home.emptyActivationPath;
in
{
  "22.05" = at "22.05";
  "22.11" = at "22.11";
  "26.05" = at "26.05";
}
```

（`/tmp/scratch18/sv.nix`，全文）

```text
$ nix eval --impure --json --expr 'import /tmp/scratch18/sv.nix { firnPath = toString ./.; }'
{"22.05":false,"22.11":true,"26.05":true}
```

（手敲，不在 `lab/ch18/` 里）

同一份 Home Manager、同一份配置，只改 `stateVersion`，`emptyActivationPath` 在 `22.05` 是 `false`，在 `22.11` 起是 `true`。一个影响“激活脚本能不能看到你的 `PATH`”的默认值，被一个你以为只是“版本标签”的选项决定了。结论和 NixOS 一样：写下你**第一次**用这份配置时的版本，别跟着升级改它；要用新默认值，就读发布说明，一个一个显式设。

## mkOutOfStoreSymlink：要一个可以直接编辑的文件

`xdg.configFile` 生成的文件是 store 里的符号链接，只读。想要一个“改了立刻生效、不用重新构建”的配置文件（比如还在调的 `cairn.conf`），Home Manager 提供 `config.lib.file.mkOutOfStoreSymlink`（[`modules/files.nix` L132 到 L138](https://github.com/nix-community/home-manager/blob/cfba7ad5886b342b8dd63ba74354b3853ea4cfc9/modules/files.nix#L132-L138)）：

```nix
    lib.file.mkOutOfStoreSymlink =
      path:
      let
        pathStr = toString path;
        name = lib.hm.strings.storeFileName (baseNameOf pathStr);
      in
      pkgs.runCommandLocal name { } "ln -s ${lib.escapeShellArg pathStr} $out";
```

它构建一个只有一条 `ln -s` 的 derivation：产物是一个指向 `pathStr` 的符号链接，目标在 store **之外**。把它放进 `source`，`~/.config/cairn/cairn.conf` 就是一条两级链接：先指向 store 里那条链接，再指向你的真实文件。（flake 里写 `./bar` 这样的路径会被复制进 store，链接就指不到你的工作目录了，所以练习的答案里我用的是字符串 `"/home/demo/dotfiles/cairn.conf"`；这一点我没有单独验证，是我对纯求值下相对路径行为的理解。）

代价是什么？我做成了练习 1，答案是 `lab/ch18/ex_out_of_store.nix`：同一份 demo，分别用 `programs.cairn` 渲染的文本和一个 out-of-store 链接生成 `cairn.conf`，看生成里有什么、改 `programs.cairn.settings` 以后 `home-files` 会不会跟着变。输出在练习一节，这里先说结论：out-of-store 以后，文件内容不在 store 里，Nix 里的 `programs.cairn.settings` 不再到达这个文件，而且没有任何警告。这是我在这一篇里最想让你自己跑一遍的实验。

## 上一篇留的那个猜测

第 17 篇结尾我猜过：用户级的激活没有 root，大概没法挂 ramfs，sops-nix 的 `MountSecretFs` 在用户模式下直接返回；sops-nix 仓库里确实有 `modules/home-manager`，我当时没有用它，也没有读它。这一篇我读了锁住的 `a8627b2`，没有运行：

- [`pkgs/sops-install-secrets/linux.go` L27 到 L30](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/pkgs/sops-install-secrets/linux.go#L27-L30) 是 `// We can't create a ramfs as user`，接着 `if userMode { return nil }`，和我的猜测一致：用户模式只 `MkdirAll`，不挂文件系统。
- `modules/home-manager/sops.nix` 把 `userMode = true` (L103)，默认挂载点是 `%r/secrets.d`，`%r` 在 Linux 上是 `$XDG_RUNTIME_DIR`（`%r` 的含义在 L40，`defaultSecretsMountPoint` 在 L193），也就是 `/run/user/<uid>`，那个目录本身是 tmpfs，而不是 sops-nix 在 NixOS 上挂的 ramfs；
- 它用一个 `systemd.user.services.sops-nix`（L380 起，`Type = "oneshot"`）跑 `sops-install-secrets`，再用一条 `home.activation.sops-nix`（L408 到 L439）在每次激活时重启这个单元（Linux 上，用户 systemd 在跑的话）。

所以“没有 root 就没有 ramfs”的那半句是对的，但结论要改：它不是用一个更弱的存储，而是借了 `$XDG_RUNTIME_DIR` 这个本来就在内存里的目录。我没有在虚拟机里验证这一点；刚才关于 `/run/user/<uid>` 是 tmpfs 的说法是我对 systemd 的 `user-runtime-dir@` 的了解，不是这一篇量出来的。

## NixOS 还是 Home Manager

读完这些，我给自己列了一张表：一个设置该放哪边。它不是 Home Manager 的规定，是我从这一篇的源码和实验里归纳的偏好；有“没验证”标记的格子，只是我对机制的理解。

| 设置 | 放 NixOS | 放 Home Manager | 我的理由 |
| --- | --- | --- | --- |
| 内核参数、引导、文件系统、硬件 | `boot.*`、`fileSystems.*`、`hardware.*` | 不行 | 要 root，属于整台机器 |
| 用户账号、组、sudo、linger | `users.users.<名字>`、`security.sudo`、`users.users.<名字>.linger` | 不行 | Home Manager 只能在一个已有的用户里做事；linger 由 logind 管（见“systemd 用户单元与 linger”一节） |
| 系统服务（sshd、nginx、第 16 篇的 `services.cairn`） | `services.*` | 不行 | 系统单元、`/etc`、系统用户；配置属于机器 |
| 用户级的定时任务 (`programs.cairn.timer`) | 不行（那是系统定时器） | `systemd.user.*` | 跑在用户自己的 systemd 里，读用户自己的 `$HOME`；没人登录时要不要跑，取决于有没有 linger |
| shell、git、编辑器等 dotfiles | 能写，但是全局的 | `programs.<名字>`、`xdg.configFile`、`home.file` | 每个用户一份，和机器无关，可以带到别的机器 |
| 装包 | `environment.systemPackages`（所有用户）、`users.users.<名字>.packages` | `home.packages` | 给所有人，还是只给这个用户；`useUserPackages = true` 把后者接给前者（“useUserPackages：包装到哪”一节） |
| 环境变量 | `environment.variables`、`environment.sessionVariables` | `home.sessionVariables` | 整个系统，还是只在这个用户的会话里 |
| 窗口管理器、显示管理器 | `services.xserver.*`、显示管理器 | 用户的窗口管理器配置，例如 `wayland.windowManager.*` | 能不能登录是机器的事，登录以后什么样是用户的事 |
| 需要读密钥的服务 | `sops.secrets`，解到 `/run/secrets`（第 17 篇，ramfs） | Home Manager 的 sops 模块，解到 `$XDG_RUNTIME_DIR`（“上一篇留的那个猜测”一节，只读源码） | 谁要读，就放谁那边 |
| 防火墙、网络 | `networking.*` | 不行 | 要 root |
| 不是 NixOS 的机器（别的 Linux、macOS） | 不可用 | standalone；macOS 上还有 nix-darwin 的集成（只读文档，没跑） | 用户层的配置是唯一能带过去的那一部分 |
| 回滚 | 系统 generation | standalone 用 `home-manager switch --rollback`；作为 NixOS 模块时我猜跟着系统走（没验证） | 看“generations 与回滚”一节 |

我用三个问题来决定：这个设置**要不要 root**？它属于**机器**还是属于**用户**？我愿不愿意**带着它换一台机器**，包括一台不是 NixOS 的机器？前两个问题都指向 NixOS 的，就放 NixOS；只有第三个问题的答案是“愿意”，才放 Home Manager。装包这种两边都能写的，我倾向 Home Manager，因为它不需要 root，一个用户的改动不会重建整台机器；代价是多了一层 profile，也多了本篇讲的所有激活语义。

## 让我意外的事

**用户配置里的 `nixpkgs.overlays`，在 `useGlobalPkgs` 下被无视，而且大多数时候只是警告。** 我本来以为 `homeModules.cairn` 带着 overlay，放进 NixOS 模块里也能用。四种组合的结果是：系统没有 overlay 就是 `cairn cannot be found in pkgs`；系统有 overlay 而用户模块也带了，只多一条 `You have set either nixpkgs.config or nixpkgs.overlays while using ...` 的警告，因为断言只在 `nixpkgs.config` 和 `nixpkgs.overlays` 同时被设置时才失败。所以我的测试导入的是不带 overlay 的裸模块，这是为了躲一条警告，而不是为了躲一个错误，这个区别不读源码很难知道。

**`cairn init` 抢在 `linkGeneration` 之前写了一份模板，而且没有任何东西抱怨。** DAG 里两个节点之间没有边，顺序就是实现细节：`init_wrote_template True`。`checkLinkTargets` 在更早的位置，看不到模板；`linkGeneration` 的慢路径比较内容，不同就覆盖。结果是对的，路径是错的。我把它留在 `ch18` 里，写进了文章、模块的注释和练习 2，没有悄悄修掉。

**作为 NixOS 模块跑时，`home-manager generations` 退出码 1，而且命令本身都没装。** 我原来以为“Home Manager 的 generation”是个全局的概念。它不是：它是 `home-manager` 这个 profile 的一代，只有独立模式（或 `enableLegacyProfileManagement`）才会产生。我在测试里手工 `nix-env --profile ... --set` 了一次才看到 `id 1`。

**这份配置只有 1 个链接是我的，闭包的 35.0% 是一份 locales，同一个 overlay 还被加了两次。** 文章开头那个 666,718,104 字节，我原来猜大头是 `cairn` (129.7 MiB)，实际上是 `10-home-manager.conf` 里一行 `LOCALE_ARCHIVE_2_27` 拉进来的 `glibc-locales`，233,224,472 字节。`nixpkgs.overlays` 在 demo 里有 2 项也是我数了才知道的。这些都不是故障，是“你以为你写了 5 行，其实你选择了一整套默认值”。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
env -u CI make ch18
make lint
make check
nix flake check 2>&1 | grep -c 'unknown flake output'
while read -r f; do
  diff <(git -C ~/firn-ref show ch18:"${f}") "${f}" && echo "same ${f}"
done < <(git -C ~/firn-ref diff --name-only ch17 ch18)
```

`make ch18` 在我这里打印这 8 行（命令回显加 7 行 `ok`），整条命令（含 `nix develop` 的启动）花了 33.030 秒；`lab/ch18/` 里有两个 `_host` 实验，`CI=true` 时 `scripts/chapter.sh` 会对它们打印 `skip ... (host only)` 并不运行，我没有在 `CI=true` 下跑过这一条，这是读脚本得出的：

```text
$ env -u CI make ch18
bash scripts/chapter.sh ch18
ok   lab/ch18/ex_out_of_store.nix
ok   lab/ch18/hm_activation_package.sh
ok   lab/ch18/hm_dag.nix
ok   lab/ch18/hm_generations_host.sh
ok   lab/ch18/hm_option_count.sh
ok   lab/ch18/home_vm_host.sh
ok   lab/ch18/same_module_two_hosts.nix
```

`make lint` 没有任何诊断，退出码 0；`make check` 以 `all checks passed!` 结束，退出码 0，x86\_64-linux 上是 19 个检查。`nix flake check` 的输出里没有 `unknown flake output`，我把整份输出存下来数了：

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
$ nix flake check > /tmp/fc18.log 2>&1; echo "rc=$?"; grep -n 'homeModules' /tmp/fc18.log; grep -c 'unknown flake output' /tmp/fc18.log
rc=0
5:checking flake output 'homeModules'...
0
```

（最后一组是手敲的，不在 `lab/ch18/` 里；`/tmp/fc18.log` 只是我存输出的临时文件）

`make check` 里的 `home-vm` 和第 16、17 篇的虚拟机测试一样要用 `/dev/kvm`；这次它的结果已经在 store 里，所以 `make check` 没有重新跑虚拟机，这两条命令的耗时不能用来衡量虚拟机测试，要看的是 `home_vm_host.sh` 里的 22 秒。

整条 `make ci`（`make lint`、所有章节的实验、`make check`）我在 `ch18` 重新打标签之前也在 `nix develop` 里用 `env -u CI` 跑了一遍：233 行 `ok`，0 行 `FAIL`，以 `all checks passed!` 结束，墙钟 30 分 41 秒。那次我同时还在跑别的虚拟机探针，也没有拆开看时间花在哪，只当作一个偏慢的样本。

**必须和标签一致的文件。** 命令清单里最后那个循环对 `git diff --name-only ch17 ch18` 列出的每一个文件做 `diff`，全部应该打印 `same`，一共 13 行。我这台机器上没有 `~/firn-ref`，我在 Firn 仓库里用同一个循环、把 `git -C ~/firn-ref` 换成 `git` 跑的（拿标签里的内容和工作区比）：

```text
same flake.lock
same flake.nix
same home/demo.nix
same home/modules/cairn.nix
same lab/ch18/ex_out_of_store.nix
same lab/ch18/fixtures/option_count.nix
same lab/ch18/hm_activation_package.sh
same lab/ch18/hm_dag.nix
same lab/ch18/hm_generations_host.sh
same lab/ch18/hm_option_count.sh
same lab/ch18/home_vm_host.sh
same lab/ch18/same_module_two_hosts.nix
same nixos/tests/home.nix
```

**中间版本。** `home/modules/cairn.nix`、`home/demo.nix`、`nixos/tests/home.nix` 和 `lab/ch18/` 在这里就是终稿。`flake.nix` 和 `flake.lock` 还会变：之后的章节会继续往 `checks` 里加东西。你自己的 `~/firn` 里，这两个文件可以和标签不一致，只要 `make ch18` 仍然通过就行。

### 文件清单

链接指向标签 `ch18` 上的那一份；`git diff --name-only ch17 ch18` 的 13 个文件一个不少（其中 `lab/ch18/` 下 8 个，含 `fixtures/` 里 1 个夹具）。实验的命令都是 `env -u CI make ch18`，输出在 `out/ch18/`。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`flake.lock`](https://github.com/bfmhno3/firn/blob/ch18/flake.lock) | `jq -c '.nodes \| keys' flake.lock` | 69 行，比 `ch17` 多 21 行、没有删除；`["home-manager","nixpkgs","root","sops-nix"]`，4 个节点；`home-manager` 锁在 `cfba7ad5886b342b8dd63ba74354b3853ea4cfc9` (2026-08-23)，`follows` 指回 `nixpkgs` |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch18/flake.nix) | `nix eval .#checks.x86_64-linux --apply builtins.attrNames --json \| jq length` | 376 行，比 `ch17` 多 66 行、少 5 行；`19`（`ch17` 上是 17），多了 `home-files` 和 `home-vm`；多了输入 `home-manager`，输出 `homeModules.{cairn,default}` 和 `homeConfigurations.demo` |
| [`home/demo.nix`](https://github.com/bfmhno3/firn/blob/ch18/home/demo.nix) | `nix eval --raw .#homeConfigurations.demo.config.programs.cairn.settings.cairn.configText \| wc -l` | 16 行；`5`（渲染出的 `cairn.conf` 有 5 行）；开头是 `_:`，不是 `{ ... }:` |
| [`home/modules/cairn.nix`](https://github.com/bfmhno3/firn/blob/ch18/home/modules/cairn.nix) | `env -u CI make ch18`，由 `same_module_two_hosts.nix` 和 `home_vm_host.sh` 执行 | 77 行；12 个可见的 `programs.cairn.*` 选项；和 `services.cairn` 渲染出同一份 `configText`；`cairnInit` 排在 `linkGeneration` 之前 |
| [`lab/ch18/ex_out_of_store.nix`](https://github.com/bfmhno3/firn/blob/ch18/lab/ch18/ex_out_of_store.nix) | `env -u CI make ch18` | 退出码 0；65 行；`stored.settingsChangeMovesHomeFiles = true`，`writable.settingsChangeMovesHomeFiles = false`，`writable.contentInDrv = false`（练习 1 的答案） |
| [`lab/ch18/fixtures/option_count.nix`](https://github.com/bfmhno3/firn/blob/ch18/lab/ch18/fixtures/option_count.nix) | 由 `hm_option_count.sh` 通过 `nix eval --file` 使用，本身不被运行器执行 | 26 行；用 `optionAttrSetToDocList` 数 `programs.*` 的可见选项，并按模块分组 |
| [`lab/ch18/hm_activation_package.sh`](https://github.com/bfmhno3/firn/blob/ch18/lab/ch18/hm_activation_package.sh) | `env -u CI make ch18` | 退出码 0；39 行；`home-files` 里 5 个链接；`activate` 389 行；闭包 666718104 字节、170 个路径 |
| [`lab/ch18/hm_dag.nix`](https://github.com/bfmhno3/firn/blob/ch18/lab/ch18/hm_dag.nix) | `env -u CI make ch18` | 退出码 0；18 行；8 个激活条目；`cairnInitBeforeLinkGeneration = true` |
| [`lab/ch18/hm_generations_host.sh`](https://github.com/bfmhno3/firn/blob/ch18/lab/ch18/hm_generations_host.sh) | `env -u CI make ch18` | 退出码 0（`_host`，`CI=true` 时跳过）；27 行；`exit 1, 0 lines` 和 `id 1 -> home-manager-generation (current)` |
| [`lab/ch18/hm_option_count.sh`](https://github.com/bfmhno3/firn/blob/ch18/lab/ch18/hm_option_count.sh) | `env -u CI make ch18` | 退出码 0；18 行；`programsOptions` 3162，`programsModules` 413，最大的是 `zsh` 的 122 个 |
| [`lab/ch18/home_vm_host.sh`](https://github.com/bfmhno3/firn/blob/ch18/lab/ch18/home_vm_host.sh) | `env -u CI make ch18` | 退出码 0（`_host`，`CI=true` 时跳过）；45 行；8 行 `firn:`；墙钟 22 秒，`volatile`，`--rebuild` 分支 |
| [`lab/ch18/same_module_two_hosts.nix`](https://github.com/bfmhno3/firn/blob/ch18/lab/ch18/same_module_two_hosts.nix) | `env -u CI make ch18` | 退出码 0；70 行；`equal = true`、`sameAsFixtureExceptRepo = true` |
| [`nixos/tests/home.nix`](https://github.com/bfmhno3/firn/blob/ch18/nixos/tests/home.nix) | `env -u CI make ch18`，由 `home_vm_host.sh` 和 `hm_generations_host.sh` 执行 | 108 行；`conf_symlink into /nix/store`、`init_wrote_template True`、`user_timer cairn.timer`、`linger_file alice`；两次 `hm_generations` |

## 练习

**1.** 让 `~/.config/cairn/cairn.conf` 变成一个可以直接编辑、不用重新构建的文件，并说出代价。

<details>
<summary>参考答案</summary>

答案是 `lab/ch18/ex_out_of_store.nix`（[链接](https://github.com/bfmhno3/firn/blob/ch18/lab/ch18/ex_out_of_store.nix)）。核心是用 `mkOutOfStoreSymlink` 把 `source` 指到一个 store 之外的字符串路径，同时把 `programs.cairn` 渲染的 `text` 让位：

```nix
  outOfStore =
    { config, lib, ... }:
    {
      xdg.configFile."cairn/cairn.conf" = {
        source = lib.mkForce (config.lib.file.mkOutOfStoreSymlink "/home/demo/dotfiles/cairn.conf");
        text = lib.mkForce null;
      };
    };
```

（节选自 `lab/ch18/ex_out_of_store.nix` 的 L28 到 L35）

实验对两种做法各求值一次，比较生成的 `source` 的 derivation，再把 `programs.cairn.settings.cairn.keep.last` 改成 6，看 `home-files` 的 derivation 会不会变：

```text
$ cat out/ch18/ex_out_of_store.stdout
{ stored = { contentInDrv = true; settingsChangeMovesHomeFiles = true; sourceName = "hm_cairncairn.conf"; }; writable = { contentInDrv = false; linkTargetInDrv = true; settingsChangeMovesHomeFiles = false; sourceName = "hm_cairn.conf"; }; }
```

两边对照：`stored`（默认）里，文件内容在 derivation 里 (`contentInDrv = true`)，改设置会换掉 `home-files`；`writable` 里，derivation 只有一条指向 `/home/demo/dotfiles/cairn.conf` 的 `ln -s`（`linkTargetInDrv = true`，`contentInDrv = false`），改 `programs.cairn.settings` 完全不影响 `home-files` (`settingsChangeMovesHomeFiles = false`)。也就是说代价有三项：文件内容不再属于 generation，回滚一个 generation 不会回滚它；`home-files` 检查不再断言它；Nix 里的 `programs.cairn.settings` 被静默忽略，没有警告。要换来的只是“改了立刻生效”。

</details>

**2.** 让 `cairn init` 不再先写一份模板：把 `cairnInit` 排到 `linkGeneration` 之后，在虚拟机里验证。不要改 Firn 仓库里的文件。

<details>
<summary>参考答案</summary>

借 `home-vm.extend` 在 `alice` 的配置里把 `home.activation.cairnInit` 换成 `entryAfter [ "linkGeneration" ]`，并把测试脚本换成只打印三件事的版本。这是 `/tmp/scratch18/probe_after_link.nix`，过了 `nixfmt --check`：

```nix
{ firnPath }:
let
  firn = builtins.getFlake firnPath;
  inherit (firn.inputs.nixpkgs) lib;
in
firn.checks.x86_64-linux.home-vm.extend {
  modules = [
    {
      nodes.machine.home-manager.users.alice =
        { config, lib, ... }:
        let
          cfg = config.programs.cairn;
        in
        {
          home.activation.cairnInit = lib.mkForce (
            lib.hm.dag.entryAfter [ "linkGeneration" ] ''
              run ${lib.getExe cfg.package} -c ${config.xdg.configHome}/cairn/cairn.conf init ${cfg.settings.cairn.repo}
            ''
          );
        };
      testScript = lib.mkForce ''
        machine.wait_for_unit("home-manager-alice.service")
        conf = "/home/alice/.config/cairn/cairn.conf"
        journal = machine.succeed(
            "journalctl -u home-manager-alice.service --no-pager"
        )
        print("firn: init_wrote_template", f"wrote {conf}" in journal)
        print("firn:", machine.succeed(f"readlink {conf}").strip())
        machine.succeed("test -f /home/alice/.local/share/cairn/repo/cairn.repo")
        print("firn: repo_marker cairn.repo")
      '';
    }
  ];
}
```

```text
$ nix build --impure --no-link -L --rebuild --expr 'import /tmp/scratch18/probe_after_link.nix { firnPath = toString ./.; }' 2>&1 | grep -o 'firn: .*' | sed -E 's|/nix/store/[a-z0-9]{32}-|/nix/store/<hash>-|'
firn: init_wrote_template False
firn: /nix/store/<hash>-home-manager-files/.config/cairn/cairn.conf
firn: repo_marker cairn.repo
```

（手敲，不在 `lab/ch18/` 里；结果已经在 store 里时，`-L` 不会打印日志，所以我加了 `--rebuild`）

`init_wrote_template` 从 `True` 变成了 `False`：`cairn init` 跑的时候，`cairn.conf` 已经是指进 `home-manager-files` 的链接，`bin/cairn` 的 `if [[ -e "${config}" ]]` 为真，直接返回；仓库标记 `cairn.repo` 仍然在。这个答案没有改 Firn 的 `home/modules/cairn.nix`；真要改，是把那里的 `[ "writeBoundary" ]` 换成 `[ "linkGeneration" ]`。

</details>

**3.** 打开 `programs.cairn.timer.enable`，`demo` 的激活包闭包涨了多少？

<details>
<summary>参考答案</summary>

用 `extendModules` 在 demo 上叠一个模块，构建激活包再量：

```nix
{ firnPath }:
let
  firn = builtins.getFlake firnPath;
in
(firn.homeConfigurations.demo.extendModules {
  modules = [ { programs.cairn.timer.enable = true; } ];
}).config.home.activationPackage
```

```text
$ P=$(nix build --impure --no-link --print-out-paths --expr 'import /tmp/scratch18/timer_closure.nix { firnPath = toString ./.; }')
$ nix path-info -S "$P" | awk '{ printf "closure size: %d bytes\n", $2 }'
closure size: 666720112 bytes
$ nix path-info -r "$P" | wc -l
172
```

（手敲，不在 `lab/ch18/` 里）

666,720,112 减 666,718,104，涨了 2,008 字节；路径从 170 个变成 172 个。哪两个是新的？我把两边的闭包做了个差集：

```text
$ P1=$(nix build .#homeConfigurations.demo.activationPackage --no-link --print-out-paths)
$ comm -13 <(nix path-info -r "$P1" | sort) <(nix path-info -r "$P" | sort) | sed -E 's|/nix/store/[a-z0-9]{32}-||'
cairn.timer
home-manager-generation
cairn.service
home-manager-files
$ comm -23 <(nix path-info -r "$P1" | sort) <(nix path-info -r "$P" | sort) | sed -E 's|/nix/store/[a-z0-9]{32}-||'
home-manager-files
home-manager-generation
```

（手敲，不在 `lab/ch18/` 里）

新路径是 4 个，消失的是 2 个：`home-manager-files` 和 `home-manager-generation` 各被换成了内容不同的新路径（数量不变），真正多出来的是 `cairn.service` 和 `cairn.timer` 两个单元文件，NAR 大小分别是 624 和 408 字节。`cairn` 包本身早就在闭包里，因为 `programs.cairn.enable` 已经把它放进了 `home.packages`。

</details>

**4.** 把 NixOS 的 `system.stateVersion` 改成 `22.05`，用户的 `home.emptyActivationPath` 会变吗？（`home.stateVersion` 保持 `26.05`。）

<details>
<summary>参考答案</summary>

不会。把 NixOS 作为外层，用 `extendModules` 改 `system.stateVersion`，读用户配置里的 `home.emptyActivationPath`：

```nix
{ firnPath }:
let
  firn = builtins.getFlake firnPath;
  inherit (firn.inputs) nixpkgs home-manager;
  system = nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      home-manager.nixosModules.home-manager
      {
        # ...
        home-manager = {
          useGlobalPkgs = true;
          users.alice.home.stateVersion = "26.05";
        };
      }
    ];
  };
  at =
    v:
    (system.extendModules {
      modules = [ { system.stateVersion = nixpkgs.lib.mkForce v; } ];
    }).config.home-manager.users.alice.home.emptyActivationPath;
in
{
  "system 22.05" = at "22.05";
  "system 26.05" = at "26.05";
}
```

```text
$ nix eval --impure --json --expr 'import /tmp/scratch18/two_state_versions.nix { firnPath = toString ./.; }'
{"system 22.05":true,"system 26.05":true}
```

（手敲，不在 `lab/ch18/` 里；`/tmp/scratch18/two_state_versions.nix`，省略的是 `boot`、`fileSystems`、overlay 和用户那几行，和 `global_pkgs.nix` 里的一样）

两个都是 `true`：这个默认值只看 `home.stateVersion`，不看系统的。两个 `stateVersion` 是各管各的锚；我只验证了这一个默认值，不代表 Home Manager 里别的默认值不会读 NixOS 的配置（比如 `osConfig`），我没有查。

</details>

## 下一篇

[第 19 篇《Determinate、FlakeHub 与 Nix 的分叉们》](/posts/nix-by-firn-19-determinate-and-forks/)退一步，看这 18 篇一直在用却没问过的东西：Nix 本身怎么装、有哪几种发行版、除了上游还有哪些实现。我猜我最先想回答的，是这一篇里那些 `nix flake check`、`--rebuild`、`nix path-info` 的行为，在另一个实现上是不是一模一样；我没有在别的实现上跑过其中任何一条，所以现在只是个问题。
