---
title: "给 nixpkgs 提 PR：by-name、nixpkgs-review 与 channel"
commentId: "post:nix-by-firn-14-contributing-to-nixpkgs"
published: "2026-11-06 15:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 14 篇：我用 Nix 2.34.9 把 Cairn 按 nixpkgs 的写法放进钉在 56c02bc 的 pkgs/by-name，提交成一个本地 commit，再用 nixpkgs-vet、nixf-diagnose、nixpkgs-hammer 和 nixpkgs-review 检查：nixpkgs-review 花 389.6 秒为这一个新包评估两遍、构建 1 个包；量出来的结果是，合并之后的 commit 在 nixos-unstable 里要等 18.3 小时起、中位数 50 小时，channel 本身每 59.9 小时才前进一次。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - nixpkgs
  - 开源贡献
  - Hydra
series: "用 Firn 从零学 Nix"
seriesOrder: 14
draft: false
comment: true
slug: nix-by-firn-14-contributing-to-nixpkgs
---

第 13 篇结尾我下了一个注：给 nixpkgs 提 PR，最麻烦的大概不是写包，是等 channel 前进。这一篇我把这个注量出来。我把 Cairn 按 nixpkgs 自己的写法重写了一遍，放进一份钉在 56c02bc 的 nixpkgs 工作树，提交成一个本地 commit，再用审稿人会用的四个工具检查它。这个 commit 是整篇文章唯一的产物，我不会把它推到任何地方。先看它现在的样子：

```text
$ cat out/ch14/worktree_host.stdout
== scripts/nixpkgs-worktree.sh
Reset branch 'firn-cairn'
worktree: <FIRN_NIXPKGS>

== git log --oneline -2
<hash> cairn: init at 0.1.0
<hash> nixosTests.hostname: migrate to runTest (#555616)

== git diff --stat firn-base firn-cairn
 pkgs/by-name/ca/cairn/package.nix | 107 ++++++++++++++++++++++++++++++++++++++
 1 file changed, 107 insertions(+)

== git remote -v (nothing is ever pushed)
origin	https://github.com/NixOS/nixpkgs.git (fetch)
origin	https://github.com/NixOS/nixpkgs.git (push)
```

> [!NOTE] 本篇检查点
> 这一篇停在一个本地 commit：没有 fork，没有 `git push`，没有向 `NixOS/nixpkgs` 开 PR、issue 或评论，也没有改任何 GitHub 上的东西。所有网络访问都是只读的。
> 这一篇结束时，Firn 仓库的标签 `ch14` 里：新增 `contrib/nixpkgs/pkgs/by-name/ca/cairn/package.nix`（107 行，Cairn 按 nixpkgs 的写法）和 `scripts/nixpkgs-worktree.sh`（87 行，建工作树并提交）；`lab/ch14/` 下有 9 个实验，全是 `.sh`，其中 7 个以 `_host` 结尾；`README.md` 的目录表多了两行。`git diff --name-only ch13 ch14` 一共列出 12 个文件。`flake.nix`、`pkgs/` 和 `overlays/` 没有变。`make ch14` 通过（9 个 `ok`）。
> 涉及的概念：`pkgs/by-name` 与 RFC 140，`nixpkgs-vet` 的检查与 ratchet，`nixf-diagnose`，`nixpkgs-hammer`，`nixpkgs-review rev`，`passthru.tests` 与 `testers.testVersion`，提交信息与 `maintainers` 约定，GitHub Actions 上的 PR 检查，`master`、`staging`、`staging-next` 与 `release-26.05`，Hydra jobset 与 channel，向 release 分支回移，`nix-update`。这一篇没有新的 Nix 语法。
> 前置：[第 13 篇：开发环境：devShell、direnv 与 templates](/posts/nix-by-firn-13-devshells-direnv-templates/)。Cairn 的打包来自第 11 篇，`callPackage` 和 `fetchFromGitHub` 在第 10 篇讲过；`nix-build -A` 和 `default.nix` 入口见第 9 篇。
> 终稿与否：`contrib/` 和 `lab/ch14/*` 在这里就是终稿；`scripts/nixpkgs-worktree.sh` 是终稿；`README.md` 之后还会随着目录增加而更新。

## 环境

这一篇所有输出来自这台机器：NixOS 26.05 (Yarara)，Linux 6.18.60，`x86_64`，上游 Nix 2.34.9，Firn 钉的 nixpkgs 是 `56c02bc00adcf003215cc4bd996d6efaf4cff188`(2026-08-23T15:22:48Z)。文中引用的 nixpkgs 源码都链接到这个 rev，行号我在本地那份工作树上核对过；这一篇没有引用 Nix 本身的源码。几个工具的版本：`nixpkgs-review` 3.9.0，`nixpkgs-vet` 0.3.4，`nixpkgs-hammering` 0-unstable-2026-08-10，`nix-update` 1.16.0，`nixf-diagnose` 0.1.4。它们从第 1 篇起就在 `flake.nix` 的 dev shell 里，我一直没用过（现在补上）。

我的 shell 里设了 `CI=true`，Firn 的运行器会据此跳过 `_host` 实验，所以我跑的是 `env -u CI make ch14`。我先删掉 `out/ch14`，再在 `nix develop` 里跑，整条命令花了 7 分 51.231 秒，也就是 471.2 秒，其中 `nixpkgs_review_host.sh` 一个就占了 389.6 秒。这个数字没有包含第一次下载工作树的时间：工作树在我开始写这一篇之前就已经建好了，所以我没有量过冷启动的 550 MB 下载。

有三类数字会随日子变：channel 的年龄、Hydra 的状态、GitHub 上的分支。实验把这些行都标成 `volatile:`；我是 2026-11-06(UTC)跑的，你跑出来的会不一样，这正是它们要告诉你的事。本篇里手敲的远程查询（`git ls-remote`、compare、Hydra 的 JSON、channel 的 push 间隔和等待时间、`release-26.05` 的目录数）都是 2026-11-06 那天抓的，和仓库无关；`make ch14` 的输出对应标签 `ch14`(24f80e1)。

文中的命令分两类。一类在 `lab/ch14/` 里，我会给出文件路径、摘录和 `out/ch14/` 里的真实输出。另一类是我为了回答某个问题当场敲的，每一条都标着“（手敲，不在 `lab/ch14/` 里）”，输出也是真跑出来的。这一篇手敲的比前几篇多：nixpkgs 的检查工具有些只在出错时才开口，要让它出错只能自己动手。

## 这一篇停在哪里

先把边界说清楚，因为这个话题最容易写成“教你怎么提交”。我没有提交。我做的事是：

- 在 `~/.cache/firn/nixpkgs` 里建了一个深度为 1 的 nixpkgs 工作树，两个分支，`firn-base` 在钉住的 rev 上，`firn-cairn` 在它之上多一个 commit。
- 用 `nix-build`、`nixpkgs-vet`、`nixf-diagnose`、`nixpkgs-hammer`、`nixpkgs-review` 检查这个 commit。
- 读 `CONTRIBUTING.md` 和 `pkgs/README.md`，查 branch 和 channel 的实际状态。

我没做的事：fork `NixOS/nixpkgs`，加自己的 remote，把分支推上去，开 PR。`git remote -v` 里 `origin` 的 fetch 和 push 地址都是 `NixOS/nixpkgs.git` 本身，没有 fork；让 `git push` 不发生的是脚本里没有这条命令（整份脚本里 `push` 这个词只出现一次，在注释里）。真要提一个 PR，CONTRIBUTING 的流程是先 fork，克隆这个 fork，把上游配成另一个 remote，最后推到 fork（[第 33 到 36 行与第 81 到 84 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L33-L36)）。

Cairn 也不应该被提交。`pkgs/README.md` 在“新增一个包之前”列了五个问题，其中一个是“这个包会被别人用到的可能性有多大”，一个是“你愿不愿意至少维护它一个完整的 Nixpkgs 发行周期”（[第 30 到 50 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/README.md#L30-L50)）。Cairn 是我自己的 0.1.0 备份脚本，我对这两条的诚实回答都是“不确定”。所以这一篇是演练：流程是真的，输出是真的，只是终点停在我自己的磁盘上。

接下来的每一节都围绕同一个问题：如果有一个新包要进 nixpkgs，一个维护者会在哪些地方停下来看它，每一处能不能用命令提前量出来。

## nixpkgs 的地图

我先看这份工作树里有什么。这是我在 `~/.cache/firn/nixpkgs` 里手敲的几条命令：

```text
$ cd ~/.cache/firn/nixpkgs && ls
CONTRIBUTING.md
COPYING
README.md
ci
default.nix
doc
flake.nix
lib
maintainers
modules
nixos
pkgs
shell.nix
$ for d in lib nixos pkgs maintainers; do printf '%-12s %s\n' "$d" "$(find "$d" -name '*.nix' | wc -l)"; done
lib          272
nixos        4114
pkgs         39904
maintainers  22
$ wc -l pkgs/top-level/all-packages.nix
10900 pkgs/top-level/all-packages.nix
$ find pkgs/by-name -name '*.nix' | wc -l
22990
```

（手敲，不在 `lab/ch14/` 里）

`lib` 是函数库，272 个 `.nix` 文件，第 5 篇里我写过它的缩小版。`nixos` 是 NixOS 的模块和测试，4114 个。`pkgs` 是包和构建器，39904 个，是前两者加起来（4386 个）的 9.1 倍。`maintainers` 放维护者名单。`ci` 是 CI 要用的脚本和 Nix 文件。`doc` 是 Nixpkgs 手册的源码。`modules` 按它 README 的说法，每个子目录是 `nixpkgs` 提供的一类可以直接 import 的模块；这个我只读了 README 的开头，不展开。

最值得盯着看的是 `pkgs/top-level/all-packages.nix`：10900 行，顶层包的定义大多是一行 `callPackage`，按类别和大致的字母顺序排。它的文件头注释自己承认“严格的排序早就在合并里丢了”（[第 4 到 5 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/all-packages.nix#L4-L5)）。在没有 by-name 的年代，加一个包要做两件事：选一个类别目录，放 `package.nix` 进去；再在这个 10900 行的文件里找个位置，写一行 `callPackage`。RFC 140 的动机一节说，`all-packages.nix` 经常引起合并冲突，每个新包都要碰它。

这就是 `pkgs/by-name` 要解决的问题。`pkgs` 里的 39904 个 `.nix` 文件中，有 22990 个已经在 `pkgs/by-name` 里了。

## by-name：目录就是属性

`pkgs/by-name` 的约定在它自己的 [README](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/README.md#L10-L21) 里只有一句话：顶层包 `pkgs.some-package` 由 `pkgs/by-name/so/some-package/package.nix` 定义，`so` 是属性名的小写前两个字母。`package.nix` 是一个函数，参数是依赖，返回值是一个派生。Cairn 在 nixpkgs 里应该放在 `pkgs/by-name/ca/cairn/package.nix`，下一节会看到工作树里它就在那儿。

怎么从目录变成属性，是 `pkgs/top-level/by-name-overlay.nix` 做的，整个文件 58 行。关键的几行：

```nix
      mapAttrs (name: _: baseDirectory + "/${shard}/${name}/package.nix") (
        readDir (baseDirectory + "/${shard}")
      );
# ...
  packageFiles = mergeAttrsList (mapAttrsToList namesForShard (readDir baseDirectory));
# ...
  _internalCallByNamePackageFile = flip self.callPackage { };
}
// mapAttrs (name: self._internalCallByNamePackageFile) packageFiles
```

`readDir` 读 `pkgs/by-name`，对每个子目录再读一次，把 `name` 映射到 `baseDirectory/shard/name/package.nix`（[第 39 到 41 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/by-name-overlay.nix#L39-L41)，[第 46 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/by-name-overlay.nix#L46)）。然后对每个文件做 `callPackage 文件 { }`（[第 56 到 58 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/by-name-overlay.nix#L56-L58)）。第 10 篇里你写 `callPackage ./package.nix { }` 的那个动作，这里由 overlay 对 21635 个目录各做一遍。

有一点我读到时有点意外：这个 overlay **不检查任何东西**。文件头第 2 到 4 行写得很直白：

```nix
# No validity checks are done here,
# instead this file is optimised for performance,
# and validity checks are done by CI on PRs.
```

也就是说，求值器完全信任目录结构；你把 `cairn` 放进 `pkgs/by-name/xx/cairn`，求值照样成功，`nix-build -A cairn` 照样能用。规则靠 PR 的 CI 来守，守规则的程序叫 `nixpkgs-vet`，在讲审稿工具的那一节会专门跑它。

另一半的约束在 [`stage.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L158-L162)：如果一个属性同时在 `all-packages.nix` 和别处定义了，求值会用断言拦下来，错误信息里特地提到 `pkgs/by-name`。我手敲一次看看：在一个临时工作树里往 `all-packages.nix` 末尾追加一行给 `cairn`，再求值。

```bash
git -C ~/.cache/firn/nixpkgs worktree add --detach /tmp/dup firn-cairn
cd /tmp/dup
head -n -1 pkgs/top-level/all-packages.nix > all-packages.new
printf '  cairn = callPackage ../by-name/ca/cairn/package.nix { };\n}\n' \
  >> all-packages.new
mv all-packages.new pkgs/top-level/all-packages.nix
nix-instantiate --eval -A cairn.name 2>&1 | tail -n 1
```

```text
       error: The following attributes were defined both in `pkgs/top-level/all-packages.nix` and elsewhere, most likely in `pkgs/by-name/`: cairn
```

（手敲，不在 `lab/ch14/` 里）

这一条是求值期的硬错误，不是 CI 的建议。我之后用 `git worktree remove --force /tmp/dup` 把临时工作树删掉了。所以现在的分工是：属性名只能有一个来源，这条由求值器断言；目录名对不对、`package.nix` 有没有，由 vet 管。

### 规则：RFC 140

这套结构出自 [RFC 140(Simple Package Paths)](https://github.com/NixOS/rfcs/blob/master/rfcs/0140-simple-package-paths.md)，作者 Silvan Mosberger，RFC 的 [PR 140](https://github.com/NixOS/rfcs/pull/140) 在 2023-07-12 合并。它要检查的东西列在 RFC 的“File structure”一节（[第 52 到 56 行](https://github.com/NixOS/rfcs/blob/master/rfcs/0140-simple-package-paths.md?plain=1#L52-L56)）：

- `pkgs/by-name` 下只能有 `${shard}/${name}` 形式的子目录，叫 package directory。
- 同一层里的 `name` 转成小写后必须唯一。
- `name` 只能由 ASCII 字符 `a-z`、`A-Z`、`0-9`、`-`、`_` 组成。
- `shard` 是 `name` 的小写前两个字母，RFC 用 Nix 写成 `shard = toLower (substring 0 2 name)`。
- 每个 package directory 里必须有 `package.nix`，可以有别的文件。

RFC 在“Semantics”一节还要求 CI 检查：`package.nix` 不能访问自己目录之外的文件（[第 75 行](https://github.com/NixOS/rfcs/blob/master/rfcs/0140-simple-package-paths.md?plain=1#L75)）。by-name 的 README 说了这条带来的后果：给一个已有的多版本包（`foo_1`、`foo_2` 共用目录外的文件）再加一个实例，会同时撞上“新顶层包必须走 by-name”和“by-name 不能引用目录外文件”两条，README 建议先用 `inherit` 的写法绕开（[第 134 到 165 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/README.md#L134-L165)）。Cairn 是单个包，所有文件都在自己的目录里，碰不到这条。

我让一个实验去数这份工作树，看规则现在的样子。`by_name_host.sh` 先确保工作树在，然后数 `pkgs/by-name`，再用一个循环检查每个 package directory 的 shard 是不是 `name` 的小写前两个字母：

```bash
bad=0
while IFS= read -r dir; do
  shard="${dir#pkgs/by-name/}"
  shard="${shard%%/*}"
  name="${dir##*/}"
  prefix="${name:0:2}"
  if [[ "${shard}" != "${prefix,,}" ]]; then
    echo "BAD ${dir}"
    bad=$((bad + 1))
  fi
done < <(find pkgs/by-name -mindepth 2 -maxdepth 2 -type d | LC_ALL=C sort)
echo "violations: ${bad}"
```

`${name:0:2}` 在名字只有一个字符时就是整个名字，和 RFC 的 `substring 0 2` 对应；`${prefix,,}` 是 Bash 的小写转换。输出：

```text
$ cat out/ch14/by_name_host.stdout
== ls pkgs/by-name | wc -l (entries of by-name, README.md included)
759

== shard directories
758

== package directories (pkgs/by-name/*/*/)
21635

== package directories whose shard is not lowercase(first two letters)
violations: 0

== the shard of cairn, and two shards that start with an underscore
pkgs/by-name/ca/cairn
pkgs/by-name/_0/_010editor
pkgs/by-name/_0/_0x
pkgs/by-name/_0/_0xffff

== names of one character (their shard is the whole name, lowercased)
pkgs/by-name/h/h
pkgs/by-name/j/j
pkgs/by-name/q/q
pkgs/by-name/r/R
pkgs/by-name/t/t
```

`ls pkgs/by-name | wc -l` 是 759，其中 758 个是 shard 目录，剩下的 1 个是 `README.md`；overlay 的注释里也说过，基目录里技术上只允许 `README.md` 这一个文件（[第 31 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/by-name-overlay.nix#L31)）。21635 个 package directory，违规 0 个。这个数字包含了 `firn-cairn` 上多出的 `cairn`，`firn-base` 上少一个：

```text
$ git ls-tree -r -d --name-only firn-base pkgs/by-name | awk -F/ 'NF==4' | wc -l
21634
```

（手敲，不在 `lab/ch14/` 里）

三处细节：

- 单个字符的名字，shard 是整个名字：`h/h`、`j/j`、`q/q`、`t/t`。`r/R` 是同一条规则的另一面：包叫 `R`，shard 是小写的 `r`。
- 以数字开头的包：`_0/_010editor`。包名不能以数字开头（vet 的 README 里有这一条，见[文件结构检查](https://github.com/NixOS/nixpkgs-vet/blob/main/README.md#file-structure-checks)，它是当前 main 分支上的文字，我没有逐版本核对），所以属性名自己带一个下划线，shard 取前两个字符，就是 `_0`。
- RFC 当年量过一次的数字：17305 个顶层属性，分在 726 个 shard 里，最大的是 `li`，1092 个（RFC 的 [Shard distribution 一节](https://github.com/NixOS/rfcs/blob/master/rfcs/0140-simple-package-paths.md?plain=1#L129-L138)）。现在是 21635 个目录，758 个 shard。`li` 我手敲数了一下：

```text
$ find pkgs/by-name -mindepth 2 -maxdepth 2 -type d | cut -d/ -f3 | sort | uniq -c | sort -rn | head -n 3
   1152 li
    400 co
    335 ca
```

（手敲，不在 `lab/ch14/` 里）

`li`（`lib` 开头的一大批库）现在是 1152 个，RFC 写的是 1092 个。这两组数不是同一个量：RFC 数的是迁移之前所有非别名的顶层属性按这个规则会落进的 shard，我数的是现在实际存在的目录，所以只能说量级和结论没变：RFC 说只有 `li` 一个目录会超过 1000 项，也就是 GitHub 网页只显示前 1000 项的限制（RFC [第 138 行](https://github.com/NixOS/rfcs/blob/master/rfcs/0140-simple-package-paths.md?plain=1#L138)）。我没有检查其他 shard 是否超过 1000 项；按数量排，第二名 `co` 是 400。`ca` 的 335 里，有一个是我的 `cairn`。

### 它不是所有包的归宿

README 写得很清楚，`pkgs/by-name` 有两条限制（[第 107 到 121 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/README.md#L107-L121)）：只能放用 `pkgs.callPackage` 定义的包，所以 `pkgs.python3Packages.callPackage ...` 那一类不行；只能放顶层包，所以 `pkgs.pythonPackages.*` 这样的包集合不行。同时它又说：新包应当“尽可能”用这个机制（[第 4 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/README.md#L4)）。所以在 nixpkgs 里加一个顶层的普通包，没有选择，就是 `pkgs/by-name`。Cairn 满足两条：它是顶层包，`callPackage` 就能调。

还有一个把它和合并流程绑在一起的条件。`CONTRIBUTING.md` 描述了一个可以在评论里叫的合并机器人，`@NixOS/nixpkgs-merge-bot merge`，它会逐条验证，不满足就拒绝：PR 作者是 @r-ryantm 或 committer，触发它的人是目标分支上该包的维护者，包在 `pkgs/by-name` 里（[第 328 到 333 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L328-L333)）。by-name 的 README 在“迁移”一节里也引用了这一点：只有 `pkgs/by-name` 里的 PR 才能被自动合并（[第 81 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/README.md#L81)）。所以一个没有维护者的新包用不上它；这一条我没有试，是读文档得出的。

## 把 Cairn 写成 nixpkgs 的样子

第 11 篇里 Cairn 已经是 `pkgs/cairn/package.nix`，用 `stdenvNoCC.mkDerivation (finalAttrs: ...)`，`checkPhase` 跑 81 个 bats 测试。这一章的 `contrib/nixpkgs/pkgs/by-name/ca/cairn/package.nix` 是同一个包按 nixpkgs 的要求改过一遍的样子。我先把两份文件 `diff` 一下，看这一章到底改了什么（在 `~/firn` 里）：

```text
$ diff pkgs/cairn/package.nix contrib/nixpkgs/pkgs/by-name/ca/cairn/package.nix
14a15
>   testers,
27a29,32
>   # nixpkgs-vet (NPV-164、NPV-166) 要求新包打开这两项。
>   strictDeps = true;
>   __structuredAttrs = true;
>
85,90c90,92
<   doInstallCheck = true;
<   installCheckPhase = ''
<     runHook preInstallCheck
<     test "$("$out/bin/cairn" --version)" = 'cairn ${finalAttrs.version}'
<     runHook postInstallCheck
<   '';
---
>   passthru.tests.version = testers.testVersion {
>     package = finalAttrs.finalPackage;
>   };
100a103,105
>     # 真正的 PR 要先把作者加进 maintainers/maintainer-list.nix，
>     # 再把 handle 写进这里；本地演练留空。
>     maintainers = [ ];
```

（手敲，不在 `lab/ch14/` 里）

有四处改动是新的：多了 `testers` 参数；多了 `strictDeps` 和 `__structuredAttrs`；`installCheckPhase` 换成了 `passthru.tests.version`；`meta` 里多了 `maintainers`。`pkgs/cairn` 里解释打包选择的中文注释都原样留着，审稿清单要求这些选择写明理由，所以它们该留。

文件开头和中间的两段摘录，其余和第 11 篇一样：

```nix
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "cairn";
  version = "0.1.0";

  src = fetchFromGitHub {
    owner = "bfmhno3";
    repo = "cairn";
    tag = "ch10";
    hash = "sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=";
  };

  # nixpkgs-vet (NPV-164、NPV-166) 要求新包打开这两项。
  strictDeps = true;
  __structuredAttrs = true;
# ...
```

`tag = "ch10"` 是 Cairn 仓库里一个系列标签，对应那个仓库第 10 章的代码。fetcher 用 `tag` 属性而不是拼 `refs/tags/...` 的 `rev`，哈希是 SRI 形式；第 10 篇讲过这种写法，也讲过标签可以被挪动、`hash` 是它的保险。这个标签写成常量，是这份文件里和 nixpkgs 习惯差得最远的地方：nixpkgs 里的包通常写成 `tag = "v${finalAttrs.version}"`，版本号一变，源就跟着变，`nix-update` 也就知道怎么更新（这是 `nix-update` README 描述的用法，我在讲它的那一节会量一下 Cairn 的写法有什么后果）。

### strictDeps 和 \_\_structuredAttrs：两个 vet 要求的开关

这两行是我第一次跑 `nixpkgs-vet` 之后加的，之后单独做了对照（审稿工具那一节）。它们各自管的事：

`strictDeps = true` 关掉 stdenv 对依赖放错列表的宽容。Nixpkgs 手册说，原生编译时 stdenv 对依赖放进错误的列表很宽松（运行时要用的依赖放在 `nativeBuildInputs` 里也能用），这会破坏交叉编译，打开 `strictDeps` 就不再宽容（[stdenv 章节第 490 到 494 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/doc/stdenv/stdenv.chapter.md#L490-L494)）。第 12 篇做过交叉编译，所以这条的原因你已经见过了。

`__structuredAttrs = true` 让 Nix 把派生的其余属性序列化成一个 JSON 文件交给构建器，而不是塞进环境变量（[Nix 手册的 `__structuredAttrs`](https://nix.dev/manual/nix/2.34/language/advanced-attributes#adv-attr-structuredAttrs)）。对 Cairn 来说，打开这两项之后 `nix-build -A cairn` 仍然是 81 个测试通过，数字在 `nix-build` 那一节。

### passthru.tests：测试作为一个属性

```nix
  passthru.tests.version = testers.testVersion {
    package = finalAttrs.finalPackage;
  };
```

`pkgs/cairn` 里的 `installCheckPhase` 在构建里断言版本号；nixpkgs 的惯用写法是把它挪成 `passthru.tests`，一个单独的派生，用 `nix-build -A cairn.tests.version` 单独构建。`pkgs/README.md` 的提交约定一节还说，如果 `passthru.tests` 存在，CI 会把它们和包一起构建（[第 198 到 209 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/README.md#L198-L209)）。`finalAttrs.finalPackage` 是第 10 篇讲过的“最终的、已经 override 过的那个包”。

`testVersion` 本身是 nixpkgs 里一个很小的 `runCommand`，在 [`pkgs/build-support/testers/default.nix` 第 101 到 128 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/testers/default.nix#L101-L128)：

```nix
  testVersion =
    {
      package,
      command ? "${package.meta.mainProgram or package.pname or package.name} --version",
      version ? package.version,
    }:
    runCommand "${package.name}-test-version"
      {
        nativeBuildInputs = [ package ];
        meta.timeout = 60;
      }
      ''
        if output=$(${command} 2>&1 | sed -e 's|${builtins.storeDir}/[^/ ]*/|{{storeDir}}/|g'); then
          if grep -Fw -- "${version}" - <<< "$output"; then
            touch $out
          else
            # ...
```

运行 `command`，把输出里的 store 路径抹掉，用 `grep -Fw` 找 `version` 这个整词，找到就 `touch $out`。注意两个参数都有默认值：`command` 默认是 `<mainProgram> --version`，`version` 默认是 `package.version`。Cairn 这一份一个都没有写，全用默认值，也就是用包自己的 `version` 去匹配 `cairn --version` 的输出。这个选择是有用的：包的版本一旦漂移，测试就会失败，`nix-update` 一节会看到。

### meta：维护者、许可证、注释

```nix
  meta = {
    description = "Incremental hard-link snapshot backups, written in Bash";
    homepage = "https://github.com/bfmhno3/cairn";
    license = [
      lib.licenses.mit
      lib.licenses.asl20
    ];
    mainProgram = "cairn";
    platforms = lib.platforms.linux;
    # 真正的 PR 要先把作者加进 maintainers/maintainer-list.nix，
    # 再把 handle 写进这里；本地演练留空。
    maintainers = [ ];
  };
})
```

`pkgs/README.md` 的 meta 规则（[第 492 到 516 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/README.md#L492-L516)）我逐条对了一遍：`meta` 写在派生的最后，`passthru` 在它之前，对；`description` 是一句话，首字母大写，不以冠词或包名开头，不以句号结尾，对；`mainProgram` 是字面量字符串，对；`platforms` 设了，对。第 516 行有一条：`meta.maintainers` 对新包是必填的(“must be set for new packages”)。Cairn 这里是空列表，所以按这份文档，这一份还不能提。

要填的话，流程在 `maintainers/README.md` 的“How to become a maintainer”一节（[第 27 到 35 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/maintainers/README.md#L27-L35)）：先把自己加进 `maintainers/maintainer-list.nix`，如果这是另一个 PR 的一部分，就把这一改动单独放进一个 commit，标题是 `maintainers: add <handle>`；`CONTRIBUTING.md` 第 531 到 532 行写了同一条，还加了一句：这个 commit 要放在改包的 commit 之前。`pkgs/README.md` 对第一次贡献的人说得更直接：加自己为维护者，放在单独的 commit 里（[第 145 到 147 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/README.md#L145-L147)）。所以一个第一次贡献的人，一个新包的 PR 至少有两个 commit：先 `maintainers: add <handle>`，再 `cairn: init at 0.1.0`。

### 这份文件留着的缺口

这一节我对着 `pkgs/README.md` 的“新包审稿清单”（[第 1219 到 1247 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/README.md#L1219-L1247)）读 Cairn。解释打包选择的注释留着，测试用默认值，这两点都过了；除了空的 `maintainers`，还剩两处在真 PR 里会被指出来，我如实记在这里，没有去改 `contrib/` 里的文件：

- **许可证是列表。** `license = [ lib.licenses.mit lib.licenses.asl20 ]`。vet 的 main 分支里有一条 ratchet：新的顶层包的 `meta.license` 不能是列表，要单独一个许可证，或者用 `lib.licenses.OR` 这类复合运算符（[commit 813345f，2026-10-31](https://github.com/NixOS/nixpkgs-vet/commit/813345fc195ccfc014bc0751c5f4ec8e7ba17dc2)；这句话是我从那个 commit 里 `src/ratchet.rs` 的文档注释读出来的）。这条不在 0.3.4 里，而 0.3.4 是钉住的 nixpkgs 里的版本，也是审稿工具那一节我跑的版本，所以那一节的 vet 对它是满意的。工作树这个 rev 里已经有 `lib.licenses.OR`：`grep -rl` 数出来，`pkgs/by-name` 里有 1275 个 `package.nix` 的 `license` 是列表（含 `with lib.licenses; [` 的写法，数的是 `grep -rlE 'license = (with [a-zA-Z.]+; )?\['` 命中的单行写法，所以这是个下限，列表形式一点也不罕见），13 个文件用了 `licenses.OR`（数的是文件，不是包）。我还自己构建了那个 commit 的 vet 来试，它在这棵树上先被另一类问题拦住了（56 处 NPV-171，都是 `lib.optional` 的旧用法，在 base 里就有），没有走到检查 `cairn` 的那一步，所以我没有亲眼看到它拒绝 Cairn。结论只能到这里：按那个 commit 的文字，这份文件在新版 vet 下大概会被要求改成 `lib.licenses.OR`。
- **注释是中文。** nixpkgs 的注释是英文；`contrib` 里的中文注释（`strictDeps` 的来由、`buildInputs`、`postFixup`、`preCheck`、`checkPhase` 的说明和 `maintainers` 的说明）进了 PR 就得翻译。内容本身是对的：审稿清单要求用了 `substituteInPlace` 要写为什么、检查被部分关掉要写为什么（[第 1239 到 1241 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/README.md#L1239-L1241)），`preCheck` 和 `checkPhase` 上方的两段注释正好回答了这两条，只是语言不对。

## 工作树：scripts/nixpkgs-worktree.sh

nixpkgs 的 `master` 是一个完整仓库，完整克隆我没有量过，也不需要：这一章只要钉住的那一个 rev。`scripts/nixpkgs-worktree.sh` 是 87 行 Bash，做两件事：第一次运行时建一个深度为 1 的仓库并检出钉住的 rev，之后每次运行都在它之上重新提交 Cairn。两个函数：

```bash
init_worktree() {
  if [[ -d "${WORKTREE}/.git" ]]; then
    return 0
  fi
  mkdir -p "${WORKTREE}" || return 1
  git -C "${WORKTREE}" -c init.defaultBranch=firn-base init --quiet || return 1
  git -C "${WORKTREE}" remote add origin \
    https://github.com/NixOS/nixpkgs.git || return 1
  git -C "${WORKTREE}" fetch --depth 1 origin "${BASE_REV}" || return 1
  git -C "${WORKTREE}" checkout -B firn-base FETCH_HEAD || return 1
}
```

`git fetch --depth 1 origin <完整的 40 位哈希>`：不克隆历史，只拿这一个 commit 和它的树。GitHub 接受按 commit 哈希 fetch，这里是它实际跑通了，我没有去查它的协议细节。`checkout -B firn-base FETCH_HEAD` 把本地分支 `firn-base` 指到这个 commit。工作树在 `${FIRN_NIXPKGS:-${HOME}/.cache/firn/nixpkgs}`，我手敲量一下它的体积：

```text
$ du -sh ~/.cache/firn/nixpkgs
554M	/home/bfmhno3/.cache/firn/nixpkgs
$ du -sh --exclude=.git ~/.cache/firn/nixpkgs
481M	/home/bfmhno3/.cache/firn/nixpkgs
```

（手敲，不在 `lab/ch14/` 里）

554 MB，其中检出的文件占 481 MB，`.git` 占剩下的约 73 MB（这是相减，我没有单独量 `.git`）。第二个函数：

```bash
commit_cairn() {
  git -C "${WORKTREE}" checkout -B firn-cairn firn-base || return 1
  mkdir -p "${WORKTREE}/${CAIRN_PATH%/*}" || return 1
  cp "${FIRN_ROOT}/contrib/nixpkgs/${CAIRN_PATH}" \
    "${WORKTREE}/${CAIRN_PATH}" || return 1
  git -C "${WORKTREE}" add "${CAIRN_PATH}" || return 1
  git -C "${WORKTREE}" \
    -c user.name='Firn Lab' -c user.email='firn@example.invalid' \
    commit --quiet -m 'cairn: init at 0.1.0' || return 1
}
```

每次运行都先 `checkout -B firn-cairn firn-base`：不管 `firn-cairn` 之前指向哪里，都重置到 `firn-base`，再提交一次。这就是幂等：运行两次，`firn-cairn` 上永远是 `firn-base` 加一个 commit，commit 的树不变，只有哈希会随提交时间变（实验里把哈希替换成 `<hash>` 就是为了稳定输出）。身份 `Firn Lab <firn@example.invalid>` 用 `-c` 一次性传进去，所以脚本不依赖也不修改你的全局 git 配置；`.invalid` 是 [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) 保留的顶级域，不会解析到真实的邮箱。提交信息 `cairn: init at 0.1.0` 的格式留到提交约定那一节讲。

回头看这一章开头的输出，第二行 `Reset branch 'firn-cairn'` 是 `git checkout -B` 在分支已存在时打印的，说明我跑的是第二次或更多次；第一次的输出我没有重新演一遍，所以不写。

## nix-build -A：评审的第一步

建好工作树后，审稿人的第一个动作是在 nixpkgs 根目录运行 `nix-build -A cairn`。我先手敲两条，看属性 `cairn` 在这两棵树里分别指向哪个文件：

```text
$ cd ~/firn && nix-instantiate --eval -A cairn.meta.position | sed "s|${HOME}/Projects/firn|~/firn|"
"~/firn/pkgs/cairn/package.nix:93"
$ cd ~/.cache/firn/nixpkgs && nix-instantiate --eval -A cairn.meta.position | sed "s|${HOME}|~|"
"~/.cache/firn/nixpkgs/pkgs/by-name/ca/cairn/package.nix:95"
```

（手敲，不在 `lab/ch14/` 里）

同一个属性名，Firn 的树里它来自第 11 篇的 `pkgs/cairn/package.nix`，nixpkgs 工作树里它来自 `pkgs/by-name/ca/cairn/package.nix`，没有在 `all-packages.nix` 里加过任何一行。这就是 by-name 的全部效果。

然后是 `nix_build_attr_host.sh`。它在工作树里运行 `nix-build -A cairn --no-out-link`，再运行 `cairn --version`，再单独构建 `cairn.tests.version`：

```bash
echo "== nix-build -A cairn"
start="$(date +%s%N)"
out="$(nix-build -A cairn --no-out-link 2>/dev/null)"
end="$(date +%s%N)"
echo "volatile: wall time $(((end - start) / 1000000)) ms"
echo "volatile: ${out}"
"${out}/bin/cairn" --version
```

```text
$ cat out/ch14/nix_build_attr_host.stdout
== nix-build -A cairn
volatile: wall time 966 ms
volatile: /nix/store/9xf4rxa37351qnxy3w925brfhwbgd36n-cairn-0.1.0
cairn 0.1.0

== nix-build -A cairn.tests.version
volatile: wall time 955 ms
volatile: /nix/store/fnwp93pis1124k0xikr2xj4qykhksv9y-cairn-0.1.0-test-version
```

966 毫秒，这不是构建时间：输出路径在我的 store 里已经有了，这次只是求值了 `cairn` 这一个属性，然后发现输出已存在。真正的构建时间要让它重做一遍。`--check` 会重新构建已存在的输出并比较结果是否逐位相同（[`nix-store --realise` 手册](https://nix.dev/manual/nix/2.34/command-ref/nix-store/realise)，`nix-build` 把它不认识的选项都交给它），我手敲它，再看日志：

```text
$ cd ~/.cache/firn/nixpkgs && time (nix-build -A cairn --check --no-out-link 2>&1 | tail -n 1)
/nix/store/9xf4rxa37351qnxy3w925brfhwbgd36n-cairn-0.1.0

real	0m16.035s
user	0m1.623s
sys	0m0.312s
$ p=$(nix-build -A cairn --no-out-link) && nix-store -l "$p" | grep -c '✓'
81
$ nix-store -l "$p" | grep -E '^[0-9]+ tests'
81 tests, 0 failures
```

（手敲，不在 `lab/ch14/` 里）

16.0 秒，其中 81 个测试都过了：`nix-store -l` 读出的日志里有 81 个 `✓`，bats 自己的汇总是 81 个测试，0 个失败。这不是冷启动：源码和依赖已经在 store 里，所以它是“重跑一遍构建加测试”的时间；第一次从零开始我没有量。`user` 只有 1.6 秒，我猜是因为构建跑在 `nix-daemon` 起的进程里，不在 `time` 看得到的 `nix-build` 进程树里。

`cairn.tests.version` 的输出是一个文件：

```text
$ ls -l "$(nix-build -A cairn.tests.version --no-out-link 2>/dev/null)"
-r--r--r-- 1 root root 0 Dec 31  1969 /nix/store/fnwp93pis1124k0xikr2xj4qykhksv9y-cairn-0.1.0-test-version
```

（手敲，不在 `lab/ch14/` 里）

0 字节。`testVersion` 成功时只做 `touch $out`，它的信息全在“有没有构建成功”这一个比特里，所以脚本里写的 `cat "${test_out}"` 什么也不会打印，输出里那一行不存在。

## 审稿工具：四个，各管一段

提 PR 之前，我会在本地过一遍审稿人会用的工具。它们从第 1 篇起就躺在 Firn 的 dev shell 里，我每一个都是第一次真的用。顺序按“越来越贵”排：`nixf-diagnose` 6 毫秒，`nixpkgs-hammer` 1.0 秒（这两个是我在 dev shell 里手敲 `time` 量的），`nixpkgs-vet` 我手敲的两次是 30.4 和 24.5 秒（含 `nix develop` 的启动），`nixpkgs-review` 389.6 秒。

### nixpkgs-vet：目录结构和 ratchet

`nixpkgs-vet` 就是 by-name 的校验器。`pkgs/by-name/README.md` 说，CI 用它检查 `pkgs/by-name` 的结构，本地可以用 `./ci/nixpkgs-vet.sh master` 模拟（[第 123 到 132 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/README.md#L123-L132)）。那个脚本会去拉远端的 `master` 当 base，再把 PR 合进去比较；Firn 的实验不能这样，因为 base 必须是钉住的那个 rev，所以 `nixpkgs_vet_host.sh` 自己搭了这个比较：`firn-base` 是 base，`firn-cairn` 是 head。

`nixpkgs-vet --help` 的用法行是 `nixpkgs-vet --base <BASE> <NIXPKGS>`，两个参数都是目录，所以 base 要有自己的目录。实验用一个临时的 `git worktree` 在 `LAB_TMP` 里检出 `firn-base`：

```bash
base="${LAB_TMP}/base"
git -C "${FIRN_NIXPKGS}" worktree add --detach "${base}" firn-base >/dev/null 2>&1
trap 'git -C "${FIRN_NIXPKGS}" worktree remove --force "${base}"' EXIT

NIXPKGS_VET_NIX_PACKAGE="$(dirname "$(dirname "$(readlink -f "$(command -v nix)")")")"
export NIXPKGS_VET_NIX_PACKAGE
# ...
nixpkgs-vet --base "${base}" "${FIRN_NIXPKGS}" 2>&1 || status=$?
echo "exit status: ${status}"
((status == 0))
```

`NIXPKGS_VET_NIX_PACKAGE` 是一个环境变量，指向求值时用的那个 Nix 的 store 路径。nixpkgs 自己的 CI 在 [`ci/nixpkgs-vet.nix` 第 31 到 37 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/ci/nixpkgs-vet.nix#L31-L37)里设它，还给它开了一个全新的 `NIX_STATE_DIR` 并 `nix-store --init`。没有它，vet 直接停：

```text
$ env -u NIXPKGS_VET_NIX_PACKAGE nixpkgs-vet --base /tmp/vl/base ~/.cache/firn/nixpkgs; echo "exit status: $?"
I/O error:  Could not get environment variable NIXPKGS_VET_NIX_PACKAGE: environment variable not found
exit status: 2
```

（手敲，不在 `lab/ch14/` 里）

这里的 `/tmp/vl/base` 是我临时检出的 `firn-base`，用完就删了。有了它，实验的输出：

```text
$ cat out/ch14/nixpkgs_vet_host.stdout
== nixpkgs-vet --help (usage line)
Usage: nixpkgs-vet --base <BASE> <NIXPKGS>

== nixpkgs-vet --base <firn-base> <firn-cairn>
Validated successfully
exit status: 0
```

通过了。但是“通过”在这里说明不了多少，因为我不知道它在不通过时会说什么。所以我故意弄坏 Cairn，各做一次（在 `~/.cache/firn/nixpkgs` 里，在 dev shell 之内，已经设好了 `NIXPKGS_VET_NIX_PACKAGE`）。第一次：把 `strictDeps` 和 `__structuredAttrs` 两行删掉，这是 `contrib` 文件最初的样子。

```bash
git worktree add --detach /tmp/vetlab/base firn-base
git worktree add --detach /tmp/vetlab/head firn-cairn
f=/tmp/vetlab/head/pkgs/by-name/ca/cairn/package.nix
grep -v -e '^  strictDeps = true;$' -e '^  __structuredAttrs = true;$' "${f}" \
  > "${f}.new"
mv "${f}.new" "${f}"
nixpkgs-vet --base /tmp/vetlab/base /tmp/vetlab/head
echo "exit status: $?"
```

```text
- Attribute `pkgs.cairn` is a new package with `strictDeps` unset or set to `false`.
  Please enable `strictDeps = true;` in pkgs/by-name/ca/cairn/package.nix.
 (https://github.com/NixOS/nixpkgs-vet/wiki/NPV-164)
- Attribute `pkgs.cairn` is a new package with `__structuredAttrs` unset or set to `false`.
  Please enable `__structuredAttrs = true;` in pkgs/by-name/ca/cairn/package.nix.
 (https://github.com/NixOS/nixpkgs-vet/wiki/NPV-166)
This PR introduces additional instances of discouraged patterns as listed above. Please fix them before merging.
exit status: 1
```

（手敲，不在 `lab/ch14/` 里）

两条错误，两个编号，都带一个 wiki 链接：[NPV-164](https://github.com/NixOS/nixpkgs-vet/wiki/NPV-164) 是 `strictDeps`，[NPV-166](https://github.com/NixOS/nixpkgs-vet/wiki/NPV-166) 是 `__structuredAttrs`。这就是 `contrib` 文件里那两行和那条注释的来历：它们不是我的偏好，是 vet 的 ratchet。vet 的 README 解释 ratchet：已有的旧写法放行，不允许新增，所以“新的顶层包必须开 `strictDeps`”只对新包生效，旧包里没开的不算违规（[README 的 Ratchet checks 一节](https://github.com/NixOS/nixpkgs-vet/blob/main/README.md#ratchet-checks)）。注意最后一句话的不同：ratchet 说的是“引入了额外的、被劝阻的写法”，下一个实验里的结构错误说的是“否则 base 分支会坏”。

第二次：恢复这个文件，再把包搬进错的 shard。`cairn` 的前两个字母是 `ca`，我把它放进 `cr`（这个 shard 本来就存在）。

```bash
git -C /tmp/vetlab/head checkout -- .
mv /tmp/vetlab/head/pkgs/by-name/ca/cairn /tmp/vetlab/head/pkgs/by-name/cr/cairn
nixpkgs-vet --base /tmp/vetlab/base /tmp/vetlab/head
echo "exit status: $?"
```

```text
- pkgs/by-name/cr/cairn: Incorrect directory location, should be pkgs/by-name/ca/cairn instead. (https://github.com/NixOS/nixpkgs-vet/wiki/NPV-142)
This PR introduces the problems listed above. Please fix them before merging, otherwise the base branch would break.
exit status: 1
```

（手敲，不在 `lab/ch14/` 里）

[NPV-142](https://github.com/NixOS/nixpkgs-vet/wiki/NPV-142)：目录位置不对，而且它直接告诉你应该放哪儿。在 by-name 一节我说过，overlay 不检查任何东西，规则都在 CI 里；这就是“CI 里”的那部分：一个放错 shard 的包，求值照样成功，`nix-build -A cairn` 照样能用，只有 vet 会拦它。两次实验之后我用 `git worktree remove --force` 把两个临时工作树删了。

### nixf-diagnose：只看语法和明显的坏味道

`nixf-diagnose` 不需要 nixpkgs 工作树，它是 `nixf` 的命令行外壳。`nixf` 的描述是 “Nix language frontend, parser & semantic analysis”，主页是 nixd 的仓库；`nixf-diagnose` 的描述是 “CLI wrapper for nixf-tidy with fancy diagnostic output”。nixpkgs 的 CI 也在用它：`ci/treefmt.nix` 里定义了一个 `nixf-diagnose` 格式化器，带 `--auto-fix`，处理所有 `*.nix`，优先级 -1，紧跟着是 `nixfmt` 格式化器（[第 106 到 143 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/ci/treefmt.nix#L106-L143)），PR 的 Lint 工作流跑 `-A fmt.check`（[`lint.yml` 第 25 行起](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/lint.yml#L25)）。它的配置还带着一串 `--ignore=`，其中有 `sema-unused-def-let`，所以我故意写坏的文件里的那条警告，nixpkgs 的 CI 并不看。

实验跑两遍，一遍是 `contrib` 文件，一遍是一个故意写坏的文件。它输出的是带颜色的文本，即使 stdout 不是终端也一样，所以实验里先用一个 `sed` 把 ANSI 转义去掉：

```bash
# nixf-diagnose colors its output even when stdout is not a terminal.
strip_ansi() {
  sed -E 's/\x1b\[[0-9;]*m//g'
}
```

```text
$ cat out/ch14/nixf_diagnose.stdout
== nixf-diagnose contrib/nixpkgs/pkgs/by-name/ca/cairn/package.nix
exit status: 0

== the same on a file with an unused binding and a missing semicolon
[parse-expected] Error: expected ;
   ╭─[bad.nix:3:8]
   │
 3 │   a = x
   ·        │ 
   ·        ╰─ expected ;
───╯
[sema-unused-def-let] Warning: definition `unused` in let-expression is not used
   ╭─[bad.nix:2:5]
   │
 2 │ let unused = 1; in {
   ·     ───┬──  
   ·        ╰──── definition `unused` in let-expression is not used
───╯
```

`contrib` 文件什么也没有，退出码 0。故意写坏的那一个（文件内容是 `printf '{ x }:\nlet unused = 1; in {\n  a = x\n}\n'`，实验里标了 `# BAD`）有两条：`parse-expected` 是解析错误，少一个分号；`sema-unused-def-let` 是语义警告，`let` 里定义了没用的 `unused`。解析错误排在前，警告排在后，位置都精确到行和列。这和 Firn 的 `make lint` 里 `deadnix` 有重叠：`deadnix` 找没用的绑定，nixf 也找；差别是 nixf 同时是解析器，文件还不合法的时候，它照样把没用的绑定报了出来，这一点输出里已经能看到。

### nixpkgs-hammer：挑刺

`nixpkgs-hammer` 按它自己 README 的说法，是“一组吹毛求疵的规则”，指出新手打包常犯的错。它有两类检查：一类是 overlay，替换 `stdenv.mkDerivation` 等函数，给结果挂上一份报告；另一类是单独运行的程序，会拿到属性路径、文件路径，和“如果有的话”构建日志。在 nixpkgs 根目录里运行，它从当前目录求值：

```text
$ cat out/ch14/hammering_host.stdout
== nixpkgs-hammer --help (usage line)
Usage: nixpkgs-hammer [OPTIONS] <attr-path>...

== nixpkgs-hammer cairn
got build log for 'cairn-0.1.0' from 'daemon'
When evaluating attribute ‘cairn’:
notice: no-build-output
‘cairn’ has not yet been built. Checks that rely on the presence of build logs are skipped.

exit status: 0

== the same on a variant whose output is not in the store
When evaluating attribute ‘cairn’:
No issues found.
```

没有任何规则命中 Cairn，退出码 0。有意思的是两段输出的差别。第一段是 `cairn` 本身：一条 notice 说 `cairn` 还没有被构建，依赖构建日志的检查被跳过，可是同一段的第一行说它已经从守护进程拿到了 `cairn-0.1.0` 的构建日志，我的 store 里也早有构建好的 `cairn`。第二段是实验的另一部分：它在临时工作树里往 `preCheck` 加一条带进程号的注释，让派生每次都不同，输出路径一定不在 store 里，这一次 hammer 只说 `No issues found.`，没有 notice。实验脚本的头注释对原因只写了“没有查出来，不当结论”。我去读了源码，钉在 `nixpkgs-hammering` 的那个 rev（`259202d`，也就是钉住的 nixpkgs 里的版本）的 [`src/lib.rs` 第 60 到 64 行](https://github.com/jtojnar/nixpkgs-hammering/blob/259202d424fa9793f2c212b380be047b83daa34f/src/lib.rs#L60-L64)：

```rust
    if !excluded_rules.contains("no-build-output") {
        let names_without_outputs = attrs
            .iter()
            .filter(|a| a.output.as_ref().is_some_and(|o| o.exists()))
            .map(|a| a.name.clone());
```

变量叫 `names_without_outputs`，过滤条件却是 `o.exists()`：选出来的是输出**已经存在**的属性。这和实验里的两段输出一致：输出在 store 里就有 notice，不在就没有。我只验证了这一个 rev、这一个包，所以结论只到“这个 rev 上，这个检查的条件看起来写反了”。后果也很小，它只是一条 notice，不改变退出码。但它说明实验输出会随 store 的状态变：我没有在一个没有 `cairn` 的 store 里重演第一段，不写别的。

### nixpkgs-review：把改动真的构建一遍

前三个工具都不构建东西。`nixpkgs-review` 构建。`CONTRIBUTING.md` 的 PR 模板里有一项：“用 `nixpkgs-review` 测试了所有依赖这个改动的包的编译”，它给的三种用法是评审别人的 PR(`pr 12345`)、评审没提交的改动(`wip`)、评审最后一个 commit(`rev HEAD`)（[第 172 到 199 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L172-L199)）。`firn-cairn` 是一个本地 commit，所以用 `rev HEAD`。实验是这样调它的：

```bash
base="$(jq -r '.nodes.nixpkgs.locked.rev' "${FIRN_ROOT}/flake.lock")"

echo "== nixpkgs-review rev HEAD -b <pin> --no-shell --print-result"
start="$(date +%s%N)"
nixpkgs-review rev HEAD -b "${base}" --no-shell --print-result \
  --build-graph nix >"${LAB_TMP}/review.out" 2>"${LAB_TMP}/review.err"
end="$(date +%s%N)"
```

几个参数都是从 `nixpkgs-review rev --help` 里读来的：`-b` 是“要比较的分支”，我给的是钉住的 rev，不是 `master`，这样比较的就只有我的一个 commit，而不是 74.7 天里 master 的全部变化；`--no-shell` 是“只评估和构建，不进 `nix-shell`”；`--print-result` 打印报告；`--build-graph nix` 不用 `nom`。输出（实验把几行 git 和 nix 命令行去掉了）：

```text
$ cat out/ch14/nixpkgs_review_host.stdout
== nixpkgs-review rev HEAD -b <pin> --no-shell --print-result
volatile: wall time 389635 ms

== result (git, nix-eval-jobs and nix build command lines left out)
Local evaluation for computing rebuilds
--------- Impacted packages on 'x86_64-linux' ---------
1 package added:
cairn (init at 0.1.0)

--------- Report for 'x86_64-linux' ---------
1 package built:
cairn

## `nixpkgs-review` result

Generated using [`nixpkgs-review`](https://github.com/Mic92/nixpkgs-review).

Command: `nixpkgs-review`

---
### `x86_64-linux`
<details>
  <summary>:white_check_mark: 1 package built:</summary>
  <ul>
    <li>cairn</li>
  </ul>
</details>


volatile: review commit 82aad2c288435a2ffe02d77276d6e886588f2885
```

389.6 秒，换来的结论是：1 个包新增，`cairn (init at 0.1.0)`，1 个包构建成功，`cairn`。六分半钟，为了知道“加了一个叶子包，没有别的包受影响”，这个答案本来可以从 `git diff --stat` 里猜出来。它值钱的地方是在你改一个别的包依赖着的东西的时候：它会找出所有重新构建的包。

这 389.6 秒花在哪儿，我没有分段计时。读 3.9.0 的源码，`rev` 做的是这样一串事（[`review.py` 第 397 到 456 行](https://github.com/Mic92/nixpkgs-review/blob/3.9.0/nixpkgs_review/review.py#L397-L456)）：先用 `git worktree add` 在它自己的缓存目录里检出 base（第 408 行）；打印 `Local evaluation for computing rebuilds`（第 416 行），在 base 上对整份 nixpkgs 求值，列出所有包（第 418 到 423 行）；把我的 commit `git merge` 进去（第 430 行）；再求值一遍（第 432 到 438 行）；两次结果做差，得到新增、删除、改变的包；最后构建它们。所以最大的两块我猜是两次全量求值，加上检出那个 554 MB 的树；这是我读代码得到的猜测，不是量出来的。实验把它的缓存目录通过 `XDG_CACHE_HOME` 放进了 `LAB_TMP`，所以不会读到上一次留下的东西。`pr` 子命令不一样：它先试着拿 GitHub 上 CI 已经算好的结果，成功就打印 `Successfully fetched rebuilds: no local evaluation needed`，跳过本地求值（[`review.py` 第 499 到 525 行](https://github.com/Mic92/nixpkgs-review/blob/3.9.0/nixpkgs_review/review.py#L499-L525)）。`rev` 没有 PR 可以复用，所以才有这 6 分多钟。

还有一个和这一节无关、却值得记下的细节：`nixpkgs` 的 `pkgs/top-level/release.nix` 里有一个叫 `unstable` 的聚合任务，它的 constituents 里有一行 `jobs.nixpkgs-review.x86_64-linux`，旁边的注释是“Needed by contributors to test PRs (by inclusion of the PR template)”（[第 165 到 185 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/release.nix#L165-L185)，`nixpkgs-review` 在第 183 行）。也就是说，我刚才用的这个工具，自己就是聚合任务的一个成员：按聚合任务的语义，我猜它在 Hydra 上构建失败会拦住 `nixpkgs-unstable` 前进；这一条我没有在 nixpkgs 里找到明说的文字，只有 nixos 一侧的 `release-combined.nix` 文件头写了“`tested` 成功才更新 channel”。channel 一节会用到这一点。

## 提交信息、PR 模板和 CI

### commit 的格式，和 CI 里的一个脚本

`pkgs/README.md` 规定了提交信息的形状（[第 171 到 191 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/README.md#L171-L191)）：

```text
(pkg-name): (from -> to | init at version | refactor | etc)

(Motivation for change. Link to release notes. Additional information.)
```

例子里有 `nginx: init at 2.0.1`、`qt6Packages.qtdeclarative: fix build`、`firefox: 54.0.1 -> 55.0`。`cairn: init at 0.1.0` 就是第一个例子的形状。同一节还有一句话：`(pkg-name):` 这个前缀不只是习惯，它会让 CI 排队自动构建，PR 里有多个 commit 时只会合成一个构建任务，如果有 `passthru.tests`，也会一起构建；PR 标题以 `WIP:` 开头或者含 `[WIP]` 就不会自动构建，草稿状态不影响这一点（[第 198 到 213 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/README.md#L198-L213)）。所以提交信息的第一行是机器要读的。

机器读到什么程度，我去看了 PR 里“Lint”工作流的 `commits` 任务（[`lint.yml` 第 128 行起](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/lint.yml#L128-L150)），它调用 `ci/github-script/lint-commits.js`。这个脚本在 [第 117 到 152 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/ci/github-script/lint-commits.js#L117-L152)对每个 commit 的标题检查四件事：必须含一个冒号加空格；不能以句号结尾；不能以 `amend!`、`fixup!` 或 `squash!` 开头；不能看起来像 Conventional Commits，这一条报错信息的后半句是：

```text
it seems to use conventional commit (conventionalcommits.org) formatting. Nixpkgs has its own, different, commit message formatting standards.
```

这是我读脚本得到的，没有跑它。第四条让我笑了一下：Firn 仓库的 `ch14` 标签，最后一个 commit 的标题是 `fix(ch14): test version with defaults, document checks, measure hammer notice, rename update lab`，写的正是 Conventional Commits，我这个博客仓库也要求这种格式；提到 nixpkgs，同一条标题就是违规。而 `firn-cairn` 上那个 commit，`cairn: init at 0.1.0`，是合格的：有冒号和空格，没有句号，不是 fixup，开头的 `cairn` 也不在脚本的 conventional 类型列表里（`feat`、`fix`、`chore` 这一类词）。

这也解释了为什么 `scripts/nixpkgs-worktree.sh` 里的提交信息写死成 `cairn: init at 0.1.0`，而 Firn 自己的 commit 不是。两个仓库，两套约定，各自的 CI 各自检查。

### PR 模板：六个勾，我勾了几个

`CONTRIBUTING.md` 说 PR 创建时会预填一串复选框（[第 132 到 211 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L132-L211)）。我把每一项对照这一章做过的事，诚实地勾一遍：

- **用沙箱构建。** 文档说 Linux 上沙箱默认开着。我这台机器：

  ```text
  $ nix config show sandbox
  true
  ```

  （手敲，不在 `lab/ch14/` 里）这一项勾。`nix-build -A cairn` 的 81 个测试是在沙箱里跑的，第 11 篇里 `install.bats` 在沙箱里过不了，所以没有列进 `checkPhase`。
- **在哪些平台构建过。** 只有 `x86_64-linux`。`meta.platforms = lib.platforms.linux` 声称 `aarch64-linux` 等也行，我没有试。文档自己说，不是每个平台都要测，也不要求（[第 158 到 163 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L158-L163)）。只勾 `x86_64-linux`。
- **NixOS 测试。** Cairn 不是服务，没有模块，没有对应的 NixOS 测试。不适用。
- **用 `nixpkgs-review` 构建所有受影响的包。** 做了，389.6 秒，1 个包。勾。
- **运行所有可执行文件。** 我跑了 `cairn --version`，和 `checkPhase` 里的 81 个测试，但没有手动跑过 `cairn snapshot` 一类的子命令。文档说“至少跑主程序”（[第 201 到 205 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L201-L205)）。`cairn --version` 算是跑了主程序，但这一项我不敢全勾。
- **符合贡献标准。** 这一项涵盖了前文留着的缺口：空的 `maintainers`、列表形式的许可证、中文注释。所以按这份文档，这一项我也勾不了。

六个，勾了三个半，这就是诚实的进度。我愿意在这里停，是因为“演练到哪里为止”本来就应该由这张表决定。

### 提交之后，CI 做什么

PR 一旦开出来，你看不到的那一半就开始了。`.github/workflows/pull-request-target.yml` 的名字是 `PR`，它的任务有 Check、Lint、Eval、Bot、Build（[第 74 到 140 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/pull-request-target.yml#L74-L140)）。我挑和 Cairn 有关的：

- **Lint** 里有四个任务：`treefmt`（格式，用 `nixfmt`）、`parse`（解析所有 Nix 文件）、`nixpkgs-vet`（[`lint.yml` 第 89 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/lint.yml#L89)），还有刚才说的 `commits`。`.github/workflows/README.md` 说必需的检查由这个 PR 工作流定义（[第 69 到 70 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/README.md#L69-L70)），所以我手敲让它报 NPV-164 的那个检查，在 PR 里就是一个要过的关；失败时它还会打印本地怎么跑。
- **Eval** 在 PR 的合并 commit 和目标 commit 上各求值一遍所有系统的输出路径，再比较（[`eval.yml` 第 201 到 246 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/eval.yml#L201-L246)）；把结果摘要写进一个叫 `Eval Summary` 的提交状态，内容是“Package: added N, removed N, changed N”加上 linux 和 darwin 各自的重建数（[第 317 到 355 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/eval.yml#L317-L355)）；如果 PR 指向了不合适的分支，它还会请求修改（[第 372 到 383 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/eval.yml#L372-L383)）。这是 `nixpkgs-review rev` 在我本地做的那件事（求值两遍，做差）的服务端版本。
- **Build** 构建的是 `shell`、手册、`lib-tests` 和 `tarball`（[`build.yml` 第 38 到 46 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/build.yml#L38-L46)），不是你的包。包的构建是另一回事，见下一段。

合并之前必须过的是哪些？`CONTRIBUTING.md` 说：必需的状态检查(“PR / ...” 这些任务)失败的 PR 不能合并，而 “Ofborg is not required by the checks”（[第 335 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L335)）。

那 ofborg 呢？这是一个有历史的名字，我只写我能指到出处的部分。

- 这个 rev 的 `CONTRIBUTING.md` 仍然写着：ofborg 会检查代码质量，结果显示在 PR 底部（[第 101 到 103 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L101-L103)）；ofborg 的构建经常卡住，尤其是目标分支是 `staging` 的 PR 和 Darwin 构建器，审稿人知道怎么处理（[第 797 到 801 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L797-L801)）。
- 2024-11-14，Jörg Thalheim 在 NixOS Discourse 发了一篇基础设施公告《[The future of OfBorg](https://discourse.nixos.org/t/infrastructure-announcement-the-future-of-ofborg-your-help-needed/56025)》。它先列了 ofborg 做的三件事：验证 PR 不会弄坏 Nixpkgs 的求值；按 PR 引起的重建数量给 PR 打标签；按提交信息构建包和测试。接着说 Equinix Metal 的赞助在那一年结束，团队人手少，“决定不再自己维护 OfBorg 的基础设施”（原文是 “have decided to no longer maintain OfBorg infrastructure on our own”），提出用 GitHub Actions 替代。
- 对应的[跟踪 issue #355847](https://github.com/NixOS/nixpkgs/issues/355847)（2024-11-14 创建，2025-06-12 关闭）里有一张待办清单，我今天读到的状态是：求值检查、重建标签、通知维护者、`lib` 测试、性能报告已勾；“求值 NixOS options”和“（可选）为 Linux/macOS 重建选定的包”没勾。
- `NixOS/ofborg` 这个仓库没有归档，我查 GitHub API，最近一次 push 是 2026-09-29。

我从这些出处能得到的只有：求值检查和重建标签已经由 GitHub Actions 承担（Eval 那一条就是证据），而“按提交信息构建包”那一项在清单里没勾；至于今天谁在为 `cairn: init at 0.1.0` 这样的标题排队构建，我没有找到一份明说的文字，不写。我也没有去验证 ofborg 现在是否还在 PR 上留言，那需要一个真的 PR。

### 评审的人在看什么

最后是人。`pkgs/README.md` 的“新包”审稿流程一共十几条（[第 1219 到 1247 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/README.md#L1219-L1247)）：路径、名字、版本是否合规；提交信息是否合规；源码是否来自官方位置、是否用了合适的 fetcher；`meta` 的许可证是否和上游一致，`platforms`、`maintainers`、`mainProgram` 是否设了；特殊的打包选择有没有注释；有拼写错误报告；本地构建；运行每个可执行文件。这些里，机器能帮忙的是 vet、`nixf-diagnose`、hammer 和 review，剩下的（许可证对不对，注释说没说清楚，维护者愿不愿意）只有人能判断。我没有测过一个 PR 从开出来到有人回复要多久，这个量要真提了才有，我不提，所以这个数字这一篇里没有。

## 分支和 channel：合并之后，它去哪儿

假设 `cairn: init at 0.1.0` 被合并了。我的 Firn 钉在 2026-08-23 的一个固定 rev 上，不会自己动；真正想用到它的人，是在 `nixos-unstable` 或者 `nixos-26.05` 上。从“合并”到“能用”，中间隔着一套我一直糊里糊涂的东西。这一节把它拆开，每一步都去量。

### 分支：谁往哪儿合

`CONTRIBUTING.md` 的“Flow of merged pull requests”一节开头就把对应关系写清楚了（[第 346 到 358 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L346-L358)）：

- `master` 是主分支，对应不稳定的 channel：`nixos-unstable`、`nixos-unstable-small` 和 `nixpkgs-unstable`。
- `release-YY.MM` 是发行分支，对应稳定的 channel：`nixos-YY.MM`、`nixos-YY.MM-small` 和 `nixpkgs-YY.MM-darwin`。
- Hydra 定期评估并构建 Nixpkgs，jobset 成功时更新官方 channel；而“channel 更新时，对应的分支也会更新到同一个 commit”（第 357 行）。

最后一句是个好用的事实：channel 不只是一个 URL，GitHub 上有同名的分支。所以我可以用 `git ls-remote`（只读）直接看每一个 channel 现在在哪个 commit，不需要任何 channel 专用的工具（`status.nixos.org` 也是这么一个页面）。

```text
$ git ls-remote --heads https://github.com/NixOS/nixpkgs.git master staging staging-next staging-nixos release-26.05 nixos-unstable nixos-unstable-small nixpkgs-unstable nixos-26.05 | awk '{print substr($1,1,9), $2}'
802047276 refs/heads/master
7dcdd8737 refs/heads/nixos-26.05
1d060086d refs/heads/nixos-unstable
9bb2612fd refs/heads/nixos-unstable-small
6dadaf437 refs/heads/nixpkgs-unstable
daeef707f refs/heads/release-26.05
bc8821fdf refs/heads/staging
0c5a63ff7 refs/heads/staging-next
5b791cfbc refs/heads/staging-nixos
```

（手敲，不在 `lab/ch14/` 里）

这九行是 2026-11-06 07:25 UTC 取的。九个分支，九个不同的 commit：`master` 最新，`nixos-unstable` 和 `nixpkgs-unstable` 落在它之后，`release-26.05` 和 `nixos-26.05` 也不一样。落后多少，`gh api` 的 compare 能直接给：

```text
$ for p in nixos-unstable...master nixpkgs-unstable...master nixos-26.05...release-26.05; do printf '%s ' "$p"; gh api "repos/NixOS/nixpkgs/compare/${p}" --jq '[.status, .ahead_by, .behind_by] | @tsv'; done
nixos-unstable...master ahead	1717	0
nixpkgs-unstable...master ahead	954	0
nixos-26.05...release-26.05 ahead	237	0
```

（手敲，不在 `lab/ch14/` 里）

这是 07:26 UTC 的结果：此刻 `master` 比 `nixos-unstable` 多 1717 个 commit，比 `nixpkgs-unstable` 多 954 个，`release-26.05` 比 `nixos-26.05` 多 237 个。这些 commit 都已经合并了，只是还没有被某个 channel 接受。新合并的 `cairn: init at 0.1.0` 如果今天合并，就排在这 1717 个的末尾。

钉住的 rev 上，`master` 的版本是 `26.11`，最老的受支持发行版是 `2605`：

```text
$ nix-instantiate --eval -A lib.trivial.release
"26.11"
$ nix-instantiate --eval -A lib.trivial.oldestSupportedRelease
2605
```

（手敲，不在 `lab/ch14/` 里）

后者来自 [`lib/trivial.nix` 第 475 到 477 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/trivial.nix#L475-L477)的 `oldestSupportedRelease`，所以那时稳定线上只有 26.05。

那些改动应该进哪个分支？`CONTRIBUTING.md` 的“Branch conventions”给了决策树（[第 449 到 470 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L449-L470)）：先问这个改动能不能进发行版，不能就 `master`；能而且 `master` 和发行分支上实现一样，就进 `master` 再回移；如果引起大规模重建，就走 `staging`。“大规模”没有正式的定义，CI 会按重建数量自动打标签，经验法则是 500 个以上考虑 `staging`，1000 个以上必须走 `staging`（[第 496 到 497 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L496-L497)）。

`staging` 本身是个批处理机制：引起大规模重建的 commit 先进 `staging`，Hydra 不直接构建它；定期手动合并到 `staging-next`，Hydra 构建 `staging-next` 这个 jobset，验证没有大问题后，`staging-next` 再通过一个 PR 合进 `master`（[第 370 到 373 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L370-L373)）；同时 `master` 自动合进 `staging-next`，`staging-next` 自动合进 `staging`，这两个自动合并由 [`periodic-merge-6h.yml`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/periodic-merge-6h.yml) 和 [`periodic-merge-24h.yml`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/periodic-merge-24h.yml) 实现（[第 377 到 378 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L377-L378)）。Cairn 是一个叶子包：`nixpkgs-review` 报告说只新增 1 个包，没有任何已有包被它重建，所以它走 `master`，不涉及 `staging`。

### Hydra：谁说了算

channel 什么时候前进，不是人决定的。`nixos/release-combined.nix` 的文件头直接写着（[第 1 到 3 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/release-combined.nix#L1-L3)）：

```nix
# This jobset defines the main NixOS channels (such as nixos-unstable
# and nixos-14.04). The channel is updated every time the ‘tested’ job
# succeeds, and all other jobs have finished (they may fail).
```

“每当 `tested` 这个任务成功，并且其他任务都跑完了（它们可以失败），channel 就更新。”`tested` 是一个聚合任务，在同一个文件的第 54 行，它的 `constituents` 列表从第 70 行持续到第 220 行：`nixos.channel`，最小 ISO，图形 ISO，手册，加上一长串 NixOS 测试（`acme`、`boot`、`chromium`、`docker`、`firewall`、`gnome`、`installer` 的各种分区方案……）和几个必须能构建的软件包，比如 `firefox-unwrapped`。聚合任务的所有成员都构建成功，它才成功。所以 `nixos-unstable` 要求的是：整套 NixOS 的关键测试在这个 commit 上都过。

对应 `nixpkgs-unstable` 的是 `pkgs/top-level/release.nix` 里的 `unstable` 聚合任务（[第 165 到 185 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/release.nix#L165-L185)），描述是 “Release-critical builds for the Nixpkgs unstable channel”，成员比 `tested` 少得多：源码 tarball、release 检查、metrics、手册、`lib` 的测试，加上 `stdenv`、`cargo`、`go`、`linux`、`nix`、`pandoc`、`python3` 这几个有代表性的包，以及刚才提过的 `nixpkgs-review`。这段列表里没有 NixOS 的集成测试。

两个 channel 的区别，nix.dev 的 FAQ 写得很清楚([Which channel branch should I use?](https://nix.dev/concepts/faq#channel-branches))：`nixos-*` 指向的 commit，大部分 Linux 包已经预先构建好、可以从二进制缓存拿，而且通过了完整的 NixOS 测试套件；macOS 用 `nixpkgs-*-darwin`；`*-small` 通过的是更小的测试套件，所以更新更及时，稳定性保证更少。

那 Hydra 是怎么知道“该评估了”？它的 jobset 有一个 `checkinterval` 字段。我从 Hydra 的 JSON 接口读了四个 jobset（只读）：

```text
$ for j in nixos/unstable nixpkgs/unstable nixos/release-26.05 nixpkgs/staging-next; do curl -sSL -H 'Accept: application/json' "https://hydra.nixos.org/jobset/${j}" | jq -c '{project,name,checkinterval,nixexprpath,description}'; done
{"project":"nixos","name":"unstable","checkinterval":146800,"nixexprpath":"nixos/release-combined.nix","description":"NixOS Unstable"}
{"project":"nixpkgs","name":"unstable","checkinterval":28800,"nixexprpath":"pkgs/top-level/release.nix","description":"master branch"}
{"project":"nixos","name":"release-26.05","checkinterval":111200,"nixexprpath":"nixos/release-combined.nix","description":"NixOS 26.05 release branch"}
{"project":"nixpkgs","name":"staging-next","checkinterval":0,"nixexprpath":"pkgs/top-level/release.nix","description":"staging-next branch"}
```

（手敲，不在 `lab/ch14/` 里）

这是 2026-11-06 读到的。四行把这一节所有的对应关系串起来了：`nixos:unstable` 用的是 `release-combined.nix`，也就是 `nixos-unstable` 的那个 jobset（`https://hydra.nixos.org/jobset/nixos/trunk-combined` 会 301 跳转到它）；`nixpkgs:unstable` 描述是 “master branch”，用 `release.nix`；`nixos:release-26.05` 是稳定的那一个；`staging-next` 是第四个。`checkinterval` 是 Hydra 数据库模式里的一个整数字段，默认值 300（[Hydra 的 `Jobsets.pm`](https://github.com/NixOS/hydra/blob/master/subprojects/hydra/lib/Hydra/Schema/Result/Jobsets.pm)），我没有在 Hydra 手册里找到对它的定义文字，只能按字面读成“隔多少秒检查一次输入”：`nixos:unstable` 是 146800 秒，40.8 小时；`nixpkgs:unstable` 是 28800 秒，8 小时；`nixos:release-26.05` 是 111200 秒，30.9 小时；`staging-next` 是 0，我猜是不定期检查，只在有人手动触发时才评估。这些数字在实测的 channel 前进间隔那一小节会再出现，我留到那里说。

### channel_status.sh：今天每个 channel 有多旧

`channel_status.sh` 问 `channels.nixos.org` 每个 channel 现在指向哪个 commit，再问 GitHub 那个 commit 的日期，算出它有多旧、比我钉住的 rev 新多少。核心是一个 `curl` 加一个 `gh api`：

```bash
commit_epoch() {
  local iso
  if ! iso="$(gh api "${API}/$1" --jq .commit.committer.date 2>/dev/null)"; then
    echo unavailable
    return 0
  fi
  date -u -d "${iso}" +%s
}
# ...
  for ch in "${CHANNELS[@]}"; do
    rev="$(curl -sSL "https://channels.nixos.org/${ch}/git-revision")" || rev=""
    if [[ ! "${rev}" =~ ^[0-9a-f]{40}$ ]]; then
      echo "volatile: ${ch}: no git-revision (${rev:0:60})"
      continue
    fi
    epoch="$(commit_epoch "${rev}")"
    echo "volatile: ${ch}: ${rev}"
    echo "volatile: ${ch}: age in days $(days_between "${now}" "${epoch}")"
    echo "volatile: ${ch}: commit date minus pin commit date, days $(days_between "${epoch}" "${pin_epoch}")"
  done
```

`curl` 带了 `-L`，因为 channel 的 `git-revision` 地址不直接返回内容，它先 302 跳转到 `releases.nixos.org` 上一个带版本号的路径。我手敲看一下头：

```text
$ curl -sSI https://channels.nixos.org/nixos-unstable/git-revision | grep -i -e '^HTTP' -e '^location'
HTTP/2 302
location: https://releases.nixos.org/nixos/unstable/nixos-26.11pre1107793.1d060086d60c/git-revision
```

（手敲，不在 `lab/ch14/` 里）

那个路径里的 `nixos-26.11pre1107793.1d060086d60c` 是这个 channel 的版本字符串，最后 12 位十六进制是 commit 的前 12 位。`1107793` 我猜是 commit 数；版本号的后缀来自仓库根目录的 `.version-suffix` 文件（[`lib/trivial.nix` 第 512 到 516 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/trivial.nix#L512-L516)），那个文件由发布流程写入，我没有去查它怎么生成。实验输出：

```text
$ cat out/ch14/channel_status.stdout
pin: 56c02bc00adcf003215cc4bd996d6efaf4cff188
volatile: today 2026-11-06
volatile: pin age in days 74.7
volatile: nixos-unstable: 1d060086d60cb76a40cf37109f979d88a5bd6396
volatile: nixos-unstable: age in days 2.6
volatile: nixos-unstable: commit date minus pin commit date, days 72.0
volatile: nixpkgs-unstable: 6dadaf4375be35033e1c84395adbd53ff5fded96
volatile: nixpkgs-unstable: age in days 1.4
volatile: nixpkgs-unstable: commit date minus pin commit date, days 73.2
volatile: nixos-26.05: 7dcdd87373d72e7a2173e4db02e20d3d7f495cfd
volatile: nixos-26.05: age in days 3.7
volatile: nixos-26.05: commit date minus pin commit date, days 71.0
```

我钉的 rev 是 74.7 天前的。三个 channel 比它新得多：`nixos-unstable` 的头 commit 有 2.6 天，`nixpkgs-unstable` 是 1.4 天，`nixos-26.05` 是 3.7 天。这些数字要小心读：“age”是那个头 commit 的**提交日期**离今天多久，不是 channel 上一次前进离今天多久。

另一个要小心的是最后一列。它是两个提交日期相减，对 `nixos-26.05` 是 71.0 天，但这不是“包含关系”，实验脚本的头注释也这么写。我用 compare 接口看三个 channel 和钉住的 rev 之间的真实关系：

```text
$ for c in nixos-unstable nixpkgs-unstable nixos-26.05; do printf '%s ' "$c"; gh api "repos/NixOS/nixpkgs/compare/56c02bc00adcf003215cc4bd996d6efaf4cff188...${c}" --jq '[.status, .ahead_by, .behind_by] | @tsv'; done
nixos-unstable ahead	47342	0
nixpkgs-unstable ahead	48105	0
nixos-26.05 diverged	13446	56160
```

（手敲，不在 `lab/ch14/` 里）

两个 unstable channel 是钉住 rev 的后代：`ahead` 47342 和 48105 个 commit，`behind` 是 0。`nixos-26.05` 是 `diverged`：它比钉住的 rev 多 13446 个 commit，同时少 56160 个。钉住的 rev 在 `master` 上，26.05 是从 `master` 切出去的一个分支，切出去之后各走各的，所以钉住的 rev **不在** `nixos-26.05` 里。“比它新 71 天”只是日历上的新，不是代码上的新。这是实验里一个容易读错的数字，我把它放在这里。

### 一个 commit 合并之后，要等多久

Firn 钉住的 rev 不会自己动，但对一个新合并的 PR，我要的答案是：多久以后某个 channel 才包含它。

GitHub 的“仓库活动”接口记录每个分支的 push([List repository activities](https://docs.github.com/en/rest/repos/repos#list-repository-activities))。channel 更新时对应分支会被更新到同一个 commit（`CONTRIBUTING.md` 第 357 行），所以 channel 分支的 push 时间就是 channel 前进的时间。我写了一个小脚本，对最近 N 次 push 打印：push 时间，新头 commit，这个 commit 在 push 的那一刻已经多旧（小时），以及距离上一次 push 过了多久，最后给两个中位数。脚本不在 `lab/ch14/` 里，是手写的 `/tmp/chan_lag.sh`，分两块贴出来。先是取数据的函数：

```bash
pushes() {
  local ts sha when
  gh api "repos/NixOS/nixpkgs/activity?ref=refs/heads/$1&per_page=$2" \
    --jq '.[] | [.timestamp, .after] | @tsv' \
    | while IFS=$'\t' read -r ts sha; do
      when="$(gh api "repos/NixOS/nixpkgs/commits/${sha}" \
        --jq .commit.committer.date)"
      printf '%s %s %s\n' "${ts}" "${sha:0:9}" "${when}"
    done
}
```

再是计算的 `jq` 程序，`main` 里把 `pushes` 的输出送给它：

```bash
main() {
  pushes "$1" "$2" | jq -R -s -r '
    def hours: . / 3600 * 10 | round / 10;
    def median: sort | .[length / 2 | floor];
    (split("\n") | map(select(length > 0) | split(" "))) as $r
    | [range(0; $r | length)
       | ($r[.][0] | fromdateiso8601) as $p
       | {push: $r[.][0], head: $r[.][1],
          age: (($p - ($r[.][2] | fromdateiso8601)) | hours),
          gap: (if . + 1 < ($r | length)
                then (($p - ($r[. + 1][0] | fromdateiso8601)) | hours)
                else null end)}] as $rows
    | ($rows[] | [.push, .head, .age, .gap // "-"] | @tsv),
      "median head age \($rows | map(.age) | median) h",
      "median gap \($rows | map(.gap | select(. != null)) | median) h"'
}
```

完整的 `/tmp/chan_lag.sh` 是 47 行，除了这两块，还有头部注释、`set` 选项和最后的 `main "$@"`；`shellcheck` 和 `shfmt -i 2 -bn -ci -d` 都没有输出。中位数取的是排序后第 `n/2` 个（偶数个时取较大的那个）。我对三个 channel 各跑了一次：

```text
$ bash /tmp/chan_lag.sh nixos-unstable 12
2026-11-04T11:34:26Z	1d060086d	18.3	51.3
2026-11-02T08:14:42Z	0bb2eedc2	18.6	59.9
2026-10-30T20:20:31Z	1c89083e4	14	65.4
2026-10-28T02:53:39Z	31ecbaca1	12.6	79.4
2026-10-24T19:30:45Z	3ec636362	26.9	96.4
2026-10-20T19:06:36Z	02c087f3f	5.6	19.2
2026-10-19T23:55:56Z	09063bd1f	67.8	48.5
2026-10-17T23:26:24Z	fe1324228	51.4	63.6
2026-10-15T07:52:52Z	55bfb4d74	26.3	60.6
2026-10-12T19:19:15Z	7fd4004d0	27.4	46.2
2026-10-10T21:04:22Z	6510408d1	20	54.4
2026-10-08T14:39:18Z	e7439b6b1	4	-
median head age 20 h
median gap 59.9 h
$ bash /tmp/chan_lag.sh nixpkgs-unstable 12
2026-11-05T20:52:16Z	6dadaf437	23.7	17.8
2026-11-05T03:03:49Z	13e53762c	14.5	15.5
2026-11-04T11:36:26Z	9d3b8db48	15.7	20
2026-11-03T15:36:38Z	ea9e3ef34	3.9	5.7
2026-11-03T09:57:08Z	9a6cbf472	6.7	10
2026-11-02T23:57:28Z	f9887a8a4	5	2.7
2026-11-02T21:17:16Z	df1e6651c	10.6	12.2
2026-11-02T09:02:20Z	5c9de89ec	7.6	23.9
2026-11-01T09:10:01Z	d357a2b54	8.2	5.8
2026-11-01T03:24:24Z	a0788123a	10.4	0.2
2026-11-01T03:11:51Z	5772e1998	19.1	30.8
2026-10-30T20:22:32Z	885ba4d03	12.9	-
median head age 10.6 h
median gap 12.2 h
$ bash /tmp/chan_lag.sh nixos-26.05 8
2026-11-02T22:24:17Z	7dcdd8737	6.8	16.3
2026-11-02T06:07:47Z	9bb52223f	20.2	32.6
2026-10-31T21:34:08Z	fa1373130	20	37
2026-10-30T08:34:23Z	6f06d204d	15.1	35.1
2026-10-28T21:25:56Z	08d3a9758	11	38
2026-10-27T07:23:20Z	718f670e8	19.7	42.7
2026-10-25T12:40:44Z	1f607aa79	9.3	78.9
2026-10-22T05:46:21Z	da6dc0e7b	8.9	-
median head age 15.1 h
median gap 37 h
```

（手敲，不在 `lab/ch14/` 里）

这三次运行都在 2026-11-06，之后再有新的 push，只会在列表顶端多一行，不会改变更早的行。三个 channel 的节奏完全不同：

- `nixpkgs-unstable`：12 次 push，中位间隔 12.2 小时，也就是一天两次左右；push 的时候头 commit 中位已经 10.6 小时。
- `nixos-unstable`：12 次 push，中位间隔 59.9 小时，一次隔两天半；push 的时候头 commit 中位 20 小时。最长的一次间隔是 96.4 小时，最短的一次 19.2 小时。
- `nixos-26.05`：8 次 push，中位间隔 37 小时，头 commit 中位 15.1 小时。

这些数字和 Hydra 的 `checkinterval` 能对上一些：`nixpkgs:unstable` 的 8 小时对中位间隔 12.2 小时，`nixos:release-26.05` 的 30.9 小时对 37 小时，`nixos:unstable` 的 40.8 小时对 59.9 小时。每一对里间隔都比 `checkinterval` 长，多出来的部分我猜是构建和测试的时间，加上有时候聚合任务失败、要等下一次评估；这只是一种读法，我没有去看具体某一次评估是怎么失败的。

回到最初那个问题。一个具体的 commit 在合并之后要等多久才能被这个 channel 包含：对最近一次 push，我把它带进 channel 的所有 commit 的提交日期，和 push 时间相减：

```bash
main() {
  local ts before after push
  read -r ts before after < <(
    gh api "repos/NixOS/nixpkgs/activity?ref=refs/heads/$1&per_page=1" \
      --jq '.[0] | [.timestamp, .before, .after] | @tsv'
  )
  push="$(date -u -d "${ts}" +%s)"
  echo "push ${ts} ${before:0:9}...${after:0:9}"
  gh api "repos/NixOS/nixpkgs/compare/${before}...${after}?per_page=100" \
    --paginate --jq '.commits[].commit.committer.date' \
    | jq -R --argjson p "${push}" 'fromdateiso8601 | ($p - .) / 3600' \
    | jq -s -c '{
        commits: length,
        min: (min * 10 | round / 10),
        median: (sort | .[length / 2 | floor] * 10 | round / 10),
        max: (max * 10 | round / 10)}'
}
```

```text
$ bash /tmp/chan_wait.sh nixos-unstable
push 2026-11-04T11:34:26Z 0bb2eedc2...1d060086d
{"commits":1433,"min":18.3,"median":50,"max":3395}
$ bash /tmp/chan_wait.sh nixpkgs-unstable
push 2026-11-05T20:52:16Z 13e53762c...6dadaf437
{"commits":287,"min":23.7,"median":31.5,"max":5814.2}
```

（手敲，不在 `lab/ch14/` 里）

`/tmp/chan_wait.sh` 是这个函数加上和 `chan_lag.sh` 一样的头部，用之前也过了 `shellcheck` 和 `shfmt`，没有输出。读法是：最近一次 `nixos-unstable` 前进，带进来 1433 个 commit，最新的那个等了 18.3 小时（这就是 head age），中位数 50 小时；`nixpkgs-unstable` 那一次带进 287 个，最短 23.7 小时，中位 31.5 小时。`max` 的 3395 小时（141 天）和 5814.2 小时（242 天）不是这些 commit “等了”那么久，我猜是 `staging` 合进来时带进的老 commit，它们的提交日期远早于合并日期，所以这一列只看 `min` 和 `median`。这两个中位数也只是这两次 push 的值，不是什么稳定的分布。

我在第 13 篇里的赌是：最麻烦的不是写包，是等 channel 前进。量出来的 channel 等待是几十个小时：最近一次 `nixpkgs-unstable` 前进带进 287 个 commit，最新的等了 23.7 小时，中位数 31.5 小时；最近一次 `nixos-unstable` 前进带进 1433 个 commit，最新的等了 18.3 小时，中位数 50 小时。这 12 次里 `nixos-unstable` 最长的间隔是 96.4 小时。真正没法量的是另一段：从 PR 开出来到有 committer 合并它。`CONTRIBUTING.md` 自己说，PR 在没有任何反馈的情况下放上几天、几周甚至几个月都“完全正常”（[第 705 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L705)），committer 是按“推”的方式工作的，要靠 PR 本身写得容易看懂来加快（[第 702 到 713 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L702-L713)）。这一段我不能用一个演练量出来，所以我的赌只能判一半：channel 的等待量出来了；整条路上最长的那一段，我没有量，这一篇里没有这个数字。

如果非要找一个比喻，channel 像一班固定间隔才发一次车的班车，不是到站就走的出租车：一个 commit 到站之后，要等下一班，而这一班本身还要先过“检票”（聚合任务全部成功）才发车。`nixpkgs-unstable` 是一天两班的短途车，检票项少；`nixos-unstable` 是两天半一班的长途车，检票项是整套 NixOS 测试。这个比喻我就用这一次。

### 回移：提 PR 到 release-26.05

如果 Cairn 想进 26.05，它不会自动去。`CONTRIBUTING.md` 的“How to backport pull requests”（[第 244 到 278 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/CONTRIBUTING.md#L244-L278)）有两条路：

- **自动。** 给 `master` 上已合并（或者还开着）的 PR 加一个 `backport release-26.05` 标签，一个 GitHub Action([`backport.yml`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/.github/workflows/backport.yml))几分钟后会开一个到 `release-26.05` 的新 PR。但是只有 Nixpkgs 维护者才能这样做（第 249 到 256 行）。我没有这个权限，所以对我来说这条路不通。
- **手动。** 走和普通 PR 一样的流程，只是本地分支和 PR 的 base 都用 `release-26.05`（第 262 行）；用 `git cherry-pick -x` 把 `master` 上的 commit 摘过来，原因不明显时用 `-xe` 加一句理由（第 268 到 270 行）；PR 描述里要链回 `master` 上的原 PR，标题带上 `[26.05]`（第 277 到 278 行）。

文档里有一个醒目的警告：不要用 `nixos-YY.MM` 分支，因为它“指向最近一次*测试过的* channel commit”（第 264 到 266 行）。分支一节的 `ls-remote` 已经把这件事摆出来了：`nixos-26.05` 在 `7dcdd8737`，`release-26.05` 在 `daeef707f`，后者领先 237 个 commit。往 `nixos-26.05` 摘，起点就落后 237 个 commit；更要紧的是，那个分支是随 channel 更新的，不是给人推的。

能不能回移，取决于改动种类。`CONTRIBUTING.md` 第 482 行把“新的包、模块和函数”列在可以回移的改动里。新包回移时，by-name 目录也得在 `release-26.05` 上存在：RFC 140 的第一个 PR 特地写了，它“会被回移到稳定版，以保证新包的回移能工作”（[RFC 第 45 行](https://github.com/NixOS/rfcs/blob/master/rfcs/0140-simple-package-paths.md?plain=1#L45)）。我用 `gh api` 看了一眼 `release-26.05` 上的 `pkgs/by-name`：

```text
$ gh api 'repos/NixOS/nixpkgs/contents/pkgs/by-name?ref=release-26.05' --jq length
756
```

（手敲，不在 `lab/ch14/` 里）

756 项，对比钉住的 `master` 上的 759 项，数量接近（两个数字都含 `README.md`），目录在。所以如果 Cairn 真的被合并，它大概可以回移；这一条我没有试，也不会试：它需要 `master` 上一个真的 PR。

## nix-update：让版本号替你动

nixpkgs 里的包大多不是人手升级的。`pkgs/README.md` 说社区机器人 `r-ryantm` 会定期尝试更新所有包，运行 `nixpkgs-update`，找新版本、改文件、开 PR；设了 `passthru.updateScript` 的包，更新步骤更可靠（[第 912 到 918 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/README.md#L912-L918)）。我手敲数了一下这个习惯有多普遍（只数 `pkgs/by-name` 下的 `package.nix` 文件）：

```text
$ cd ~/.cache/firn/nixpkgs
$ grep -rl 'nix-update-script' pkgs/by-name --include=package.nix | wc -l
3790
$ grep -rl 'updateScript' pkgs/by-name --include=package.nix | wc -l
5817
$ grep -rc 'tag = "v${finalAttrs.version}"' pkgs/by-name --include=package.nix | awk -F: '$2>0' | wc -l
4744
```

（手敲，不在 `lab/ch14/` 里）

4744 个文件把 `tag` 写成 `"v${finalAttrs.version}"`，版本号一变，源跟着变。Cairn 的标签是 `ch10`，不是这个形状。`ex_update_script_host.sh` 去试 `nix-update`，它在一个临时工作树里跑 `nix-update cairn --version-regex 'ch(.*)'`，再 `git diff`：

```bash
tree="${LAB_TMP}/update"
git -C "${FIRN_NIXPKGS}" worktree add --detach "${tree}" firn-cairn >/dev/null 2>&1
trap 'git -C "${FIRN_NIXPKGS}" worktree remove --force "${tree}"' EXIT
cd "${tree}"
# ...
nix-update cairn --version-regex 'ch(.*)' 2>&1 | grep -v '^\$ ' \
  | sed -E "s|${tree}|<worktree>|g"
```

```text
$ sed -n '/^== nix-update cairn/,/^== why/p' out/ch14/ex_update_script_host.stdout
== nix-update cairn --version-regex 'ch(.*)'
fetch https://github.com/bfmhno3/cairn/releases.atom
Update 0.1.0 -> 10 in <worktree>/pkgs/by-name/ca/cairn/package.nix
exit status: 0

== git diff
diff --git a/pkgs/by-name/ca/cairn/package.nix b/pkgs/by-name/ca/cairn/package.nix
index 15e2af3d4..2a62b25d8 100644
--- a/pkgs/by-name/ca/cairn/package.nix
+++ b/pkgs/by-name/ca/cairn/package.nix
@@ -17,7 +17,7 @@
 
 stdenvNoCC.mkDerivation (finalAttrs: {
   pname = "cairn";
-  version = "0.1.0";
+  version = "10";
 
   src = fetchFromGitHub {
     owner = "bfmhno3";

== nix-build -A cairn.tests.version (after the bump)
Version string '10' not found!
cairn 0.1.0
error: Cannot build 'cairn-10-test-version.drv'.
       Reason: builder failed with exit code 1.
exit status: 1

== why
```

它没有失败。它把正则的第一个捕获组（最新标签 `ch10` 里的 `10`）当版本，写进 `version = "10"`；`src.tag` 是字面量 `"ch10"`，所以源和哈希都没动。包现在声称自己是 10，而 `cairn --version` 打印 0.1.0。

实验的最后一段把这个后果量了出来：升级之后单独构建 `cairn.tests.version`，退出码 1，信息是 `Version string '10' not found!`，输出是 `cairn 0.1.0`。这正是 `testVersion` 的两个默认值（包自己的 `version` 和 `<mainProgram> --version`）该干的事：版本一漂移，测试就红。如果当初 `version` 写成字面量 `"0.1.0"`，这个测试会通过，漂移就没人发现；这是用默认值的理由。真正的修法在 `nix-update` 一侧：nixpkgs 里 4744 个文件用的是 `tag = "v${finalAttrs.version}"`，上游标签要是 `v0.1.0` 这种形状，`nix-update` 才知道同时改 `version` 和源。Cairn 仓库的标签是 `chNN`，我不改它们。

## 让我意外的事

**求值器不检查 by-name，CI 检查。** 把 `cairn` 放进 `pkgs/by-name/cr/cairn`，`nix-build -A cairn` 照样能用；拦它的只有 `nixpkgs-vet` 的 NPV-142。overlay 文件头自己写着“不做校验，校验交给 CI”。

**`nixpkgs-hammer` 的 `no-build-output` 条件看起来写反了。** 变量叫 `names_without_outputs`，过滤的却是输出已存在的属性：构建过的 `cairn` 被说成“还没构建”，输出不在 store 里的变体什么也不说。实验的输出因此取决于我的 store。

**升级工具会让版本号和源脱节。** `nix-update` 在 `chNN` 标签上不报错，只把 `version` 写成 `"10"`；是 `testVersion` 的默认值把它抓了出来，实验把这个失败打印了出来。

**channel 的节奏和 `checkinterval` 同量级。** `nixos-unstable` 中位每 59.9 小时前进一次，`nixpkgs-unstable` 每 12.2 小时，和 Hydra 的 `checkinterval`（40.8 小时和 8 小时）量级对得上（我猜是它决定的，没有验证）；而 `nixpkgs-review` 本身就是 `nixpkgs-unstable` 聚合任务的一个成员。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
env -u CI make ch14
make lint
make check
while read -r f; do
  diff <(git -C ~/firn-ref show ch14:"${f}") "${f}" && echo "same ${f}"
done < <(git -C ~/firn-ref diff --name-only ch13 ch14 \
  | grep -v -e '^README.md$')
```

`make ch14` 在我这里打印这 10 行（命令回显加 9 行 `ok`），整条命令（含 `nix develop` 的启动）花了 7 分 51.231 秒，其中 `nixpkgs_review_host.sh` 占 389.6 秒；7 个 `_host` 实验在 `CI=true` 时会被跳过，剩下的 2 个(`channel_status.sh` 和 `nixf_diagnose.sh`)照常运行：

```text
$ env -u CI make ch14
bash scripts/chapter.sh ch14
ok   lab/ch14/by_name_host.sh
ok   lab/ch14/channel_status.sh
ok   lab/ch14/ex_update_script_host.sh
ok   lab/ch14/hammering_host.sh
ok   lab/ch14/nix_build_attr_host.sh
ok   lab/ch14/nixf_diagnose.sh
ok   lab/ch14/nixpkgs_review_host.sh
ok   lab/ch14/nixpkgs_vet_host.sh
ok   lab/ch14/worktree_host.sh
```

第一次跑还要下载约 550 MB 的工作树，那一段时间不在这个数字里。`make lint` 回显它跑的几条命令，没有任何诊断，退出码 0。`make check` 以 `all checks passed!` 结束，退出码 0，x86\_64-linux 上仍是 14 个检查（`nix eval .#checks.x86_64-linux --apply 'x: builtins.length (builtins.attrNames x)'` 得到 14）：

```text
$ make check 2>&1 | tail -n 5; echo "rc=${PIPESTATUS[0]}"
derivation evaluated to /nix/store/sxj15y2pgk96v1kv2si52j1i2dqbbd5q-nixfmt-tree-2.5.0.drv
running 0 flake checks...
all checks passed!
warning: The check omitted these incompatible systems: aarch64-linux
Use '--all-systems' to check all.
rc=0
```

`diff` 循环应当打印 11 行 `same ...`（12 个文件减去 `README.md`）。

**必须和标签一致的文件：** `contrib/nixpkgs/pkgs/by-name/ca/cairn/package.nix`、`scripts/nixpkgs-worktree.sh`，以及 `lab/ch14/` 下全部 9 个实验。

**中间版本：** [`README.md`](https://github.com/bfmhno3/firn/blob/ch14/README.md) 的目录表每多一个顶层目录就会更新。

### 文件清单

链接指向标签 `ch14` 上的那一份；`git diff --name-only ch13 ch14` 的 12 个文件一个不少。实验的命令都是 `env -u CI make ch14`，输出在 `out/ch14/`。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/firn/blob/ch14/README.md) | `git diff ch13 ch14 -- README.md` | 目录表多 2 行，分别是 `scripts/nixpkgs-worktree.sh` 和 `contrib/nixpkgs/` |
| [`contrib/nixpkgs/pkgs/by-name/ca/cairn/package.nix`](https://github.com/bfmhno3/firn/blob/ch14/contrib/nixpkgs/pkgs/by-name/ca/cairn/package.nix) | 工作树里 `nix-build -A cairn` | 107 行；81 个测试，0 个失败；`nixpkgs-vet` 输出 `Validated successfully`；`nixf-diagnose` 无输出 |
| [`lab/ch14/by_name_host.sh`](https://github.com/bfmhno3/firn/blob/ch14/lab/ch14/by_name_host.sh) | `env -u CI make ch14` | 退出码 0；759 项，758 个 shard，21635 个 package directory，违规 0 |
| [`lab/ch14/channel_status.sh`](https://github.com/bfmhno3/firn/blob/ch14/lab/ch14/channel_status.sh) | `env -u CI make ch14` | 退出码 0；钉住的 rev 74.7 天；`nixos-unstable` 2.6、`nixpkgs-unstable` 1.4、`nixos-26.05` 3.7 天；最后一列是提交日期之差，不是包含关系 |
| [`lab/ch14/ex_update_script_host.sh`](https://github.com/bfmhno3/firn/blob/ch14/lab/ch14/ex_update_script_host.sh) | `env -u CI make ch14` | 退出码 0；`Update 0.1.0 -> 10`，`src.tag` 不变；升级后 `cairn.tests.version` 退出码 1，`Version string '10' not found!`（练习 1 的答案） |
| [`lab/ch14/hammering_host.sh`](https://github.com/bfmhno3/firn/blob/ch14/lab/ch14/hammering_host.sh) | `env -u CI make ch14` | 退出码 0；没有规则命中；`cairn` 一条 `no-build-output` notice，输出不在 store 里的变体是 `No issues found.` |
| [`lab/ch14/nix_build_attr_host.sh`](https://github.com/bfmhno3/firn/blob/ch14/lab/ch14/nix_build_attr_host.sh) | `env -u CI make ch14` | 退出码 0；`cairn 0.1.0`；两次 `nix-build` 各约 1 秒（966 和 955 毫秒，输出已在 store 里） |
| [`lab/ch14/nixf_diagnose.sh`](https://github.com/bfmhno3/firn/blob/ch14/lab/ch14/nixf_diagnose.sh) | `env -u CI make ch14` | 退出码 0；`contrib` 文件无诊断，坏文件 2 条(`parse-expected` 和 `sema-unused-def-let`) |
| [`lab/ch14/nixpkgs_review_host.sh`](https://github.com/bfmhno3/firn/blob/ch14/lab/ch14/nixpkgs_review_host.sh) | `env -u CI make ch14` | 退出码 0；389635 ms；1 个包新增，1 个包构建成功 |
| [`lab/ch14/nixpkgs_vet_host.sh`](https://github.com/bfmhno3/firn/blob/ch14/lab/ch14/nixpkgs_vet_host.sh) | `env -u CI make ch14` | 退出码 0；`Validated successfully` |
| [`lab/ch14/worktree_host.sh`](https://github.com/bfmhno3/firn/blob/ch14/lab/ch14/worktree_host.sh) | `env -u CI make ch14` | 退出码 0；`firn-cairn` 上 `cairn: init at 0.1.0`，1 个文件 107 行；`origin` 指向 `NixOS/nixpkgs.git` |
| [`scripts/nixpkgs-worktree.sh`](https://github.com/bfmhno3/firn/blob/ch14/scripts/nixpkgs-worktree.sh) | `bash scripts/nixpkgs-worktree.sh` | 87 行；打印工作树路径；重复运行幂等，从不 push |

## 练习

**1.** `nix-update` 能升级标签是 `chNN` 的 Cairn 吗？它改了什么，没改什么？

<details>
<summary>参考答案</summary>

答案是 `lab/ch14/ex_update_script_host.sh`（[链接](https://github.com/bfmhno3/firn/blob/ch14/lab/ch14/ex_update_script_host.sh)）。它不报错，只把 `version` 改成 `"10"`，`src.tag` 和哈希不动；升级之后单独构建 `cairn.tests.version`，退出码 1，`Version string '10' not found!`，因为 `testVersion` 用的是默认值，包自己的 `version` 和 `cairn --version` 的输出对不上了。

</details>

**2.** 在 `pkgs/by-name/ca/` 里再放一份 `Cairn`（和 `cairn` 只差大小写），`nixpkgs-vet` 会拒绝吗？

<details>
<summary>参考答案</summary>

RFC 140 写着同层的 `name` 小写后必须唯一。我把 `cairn` 目录复制成 `Cairn`，用 0.3.4 的 `nixpkgs-vet` 对比 `firn-base`：

```text
Validated successfully
exit status: 0
```

（手敲，不在 `lab/ch14/` 里）

通过了，和 RFC 的文字不符。我不知道原因：可能是 0.3.4 的检查按文件系统实际行为只在大小写不敏感时才发现，也可能是检查有缺口，我没有去查源码，所以不下结论。

</details>

**3.** 小 channel `nixos-unstable-small` 比 `nixos-unstable` 前进得快多少？

<details>
<summary>参考答案</summary>

对它跑同一个脚本（手写的 `/tmp/chan_lag.sh`）：

```text
$ bash /tmp/chan_lag.sh nixos-unstable-small 12
median head age 1.6 h
median gap 7.7 h
```

（手敲，不在 `lab/ch14/` 里；只列出两行中位数，12 行明细省略）

中位间隔 7.7 小时，对比 `nixos-unstable` 的 59.9 小时；push 时头 commit 中位只有 1.6 小时，对比 20 小时。和 nix.dev FAQ 说的“`*-small` 通过更小的测试套件，所以更及时”一致。

</details>

## 下一篇

第 15 篇《模块系统：从零写一个，再读懂 lib.evalModules》要把 Cairn 的配置从一个手写的 `configText` 换成真正的模块：`options` 和 `config`，类型，优先级，`mkIf`。我猜写完这一篇的 PR 流程之后，最需要的是一套能说清“这个选项从哪儿来、被谁改过”的工具，模块系统恰好是这个。
