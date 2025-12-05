---
title: "Windows 包管理神器 Scoop：从入门到自定义安装配置"
date: 2025-12-05 21:00:00 +08:00
excerpt: "Windows 下最好用的命令行包管理工具 Scoop 保姆级教程。涵盖自定义安装路径、Aria2 加速配置、常用软件推荐以及常见问题解决。"
categories:
  - Tutorial
tags:
  - Windows
  - Scoop
  - Efficiency
---

如果你习惯了 Linux 下 `apt`、`pacman` 或 macOS 下 `brew` 的爽快体验，那么回到 Windows 面对满屏的安装包和 “下一步” 肯定会感到繁琐。

**Scoop** 是 Windows 下的一款轻量级包管理工具。与 Chocolatey 或 Winget 不同，Scoop 的设计哲学是 **“非侵入式”**：

- **权限洁癖**：默认安装在用户目录，无需 UAC 提权（除非安装全局软件）。
- **绿色环保**：自动处理环境变量（Shim 机制），卸载时瞬间清除，不残留注册表垃圾。
- **版本控制**：利用 Git 管理软件仓库（Bucket），方便版本回退。

本文将带你从零开始配置一个完美的 Scoop 环境。

## 1. 调整 Scoop 安装位置

Scoop 默认将软件安装在 C 盘。作为开发者，我们通常希望将工具链与系统盘分离。在运行安装脚本前，我们需要先设置环境变量。

### 还没有安装 Scoop（推荐）

打开 **PowerShell**（无需管理员权限），依次执行以下命令。假设我们要安装到 `D:\Users\abc\scoop`（请根据你的实际情况修改路径）。

#### 第一步：设置用户安装目录

这是普通软件（Chrome, VSCode 等）的安装位置。

```powershell
$env:SCOOP = 'D:\Users\abc\scoop'
[Environment]::SetEnvironmentVariable('SCOOP', $env::SCOOP, 'User')
````

#### 第二步：设置全局安装目录（可选）

这是需要管理员权限（如驱动、系统级工具）的软件安装位置。

```powershell
$env:SCOOP_GLOBAL = 'D:\ProgramData\scoop'
[Environment]::SetEnvironmentVariable('SCOOP_GLOBAL', $env::SCOOP_GLOBAL, 'Machine')
```

> **注意**：修改 `Machine` 级别的变量通常需要**管理员权限**的 PowerShell。
> {: .notice--info}

> **警告：路径规范**
> Scoop 的安装路径中**严禁包含空格和中文字符**！
>
> - ❌ 错误示例：`D:\Program Files\Scoop` 或 `D:\我的软件\Scoop`
> - ✅ 正确示例：`D:\Users\abc\scoop` 或 `D:\Scoop`


#### 备选方案：通过图形界面设置

如果你不习惯命令行，也可以通过 Windows 设置：

1. 搜索 **“编辑系统环境变量”**。
2. 点击 **“环境变量(N)...”**。
3. 在 **“用户变量”** 中新建 `SCOOP`，值为你的自定义路径。
4. 在 **“系统变量”** 中新建 `SCOOP_GLOBAL`，值为你的全局路径。

### 已经安装了 Scoop（迁移）

如果你已经安装了 Scoop 但想迁移目录，操作稍微繁琐一些，因为 Scoop 不写注册表，它是“绿色”的。

1. 将原目录（默认 `C:\Users\<user_name>\scoop`）**剪切**并**粘贴**到新目录（例如 `D:\Scoop`）。
2. 修改系统环境变量 `Path`：
   - 删除指向旧目录的条目（如 `C:\Users\...\scoop\shims`）。
   - 添加新目录的 shim 路径（如 `D:\Scoop\shims`）。
3. **关键步骤**：打开新的 PowerShell 终端，执行以下命令重置所有软件的链接：

    ```powershell
    scoop reset *
    ```

## 2. 安装 Scoop

环境变量配置完成后，在 PowerShell 中执行以下命令进行安装：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri [https://get.scoop.sh](https://get.scoop.sh) | Invoke-Expression
```

- 第一行：允许当前用户运行本地脚本。
- 第二行：下载并执行 Scoop 官方安装脚本。

安装完成后，输入 `scoop help`，如果有输出，说明安装成功。

如果在新开启一个终端后执行 `scoop` 报错，则需要配置系统 `PATH` 变量，添加例如：`D:\Users\abc\scoop\shims`。

## 3. 初始化配置

### 安装必备组件

Scoop 依赖 Git 来管理仓库，同时强烈建议安装 Aria2 来进行多线程下载加速。

```powershell
scoop install git aria2
```

安装完成后，建议对 Aria2 进行调优，关闭警告并开启多线程：

```powershell
scoop config aria2-warning-enabled false
scoop config aria2-retry-wait 4
scoop config aria2-max-connection-per-server 16
scoop config aria2-split 16
scoop config aria2-min-split-size 1M
```

### 添加常用软件仓库 (Buckets)

Scoop 默认的 `main` 仓库软件较少且由于标准严格，通常只包含 CLI 工具。我们需要添加社区仓库来扩展生态。

```powershell
scoop bucket add extras      # 包含大量 GUI 软件 (Chrome, VSCode 等)
scoop bucket add versions    # 包含旧版本软件
scoop bucket add java        # Java 开发相关
scoop bucket add nerd-fonts  # 编程字体 (FiraCode NF, JetBrainsMono NF)
```

## 4. 装机必备软件清单

这里列出了一份高频使用的软件清单，涵盖了开发、系统增强和效率工具。

你可以一次性复制执行：

```powershell
# 系统工具与命令行增强
scoop install gsudo everything scoop-search starship fzf ripgrep bat powertoys everything-powertoys

# 开发工具
scoop install uv neovim vscode jetbrains-toolbox
```

**软件清单详解：**

- `gsudo`: Windows 下的 `sudo`，比官方的更强，体验与 Linux 一致。
- `scoop-search`: 秒级搜索 Scoop 仓库软件（比原生 `scoop search` 快几十倍）。
- `everything`: Windows 文件搜索神器。
- `powertoys`: 微软官方出品的系统增强工具集。
- `everything-powertoys`: 让 PowerToys 的启动器调用 Everything 的索引。
- `starship`: 极速、高颜值的终端提示符（Prompt），支持显示 Git 状态、Python 版本等。
- `fzf`: 命令行模糊查找工具。
- `ripgrep` (`rg`): 速度极快的 `grep` 替代品。
- `bat`: 带语法高亮和 Git 集成的 `cat` 替代品。
- `uv`: Rust 编写的 Python 包版本管理器，速度飞快。
- `neovim`: 现代化 Vim 编辑器。
- `vscode`: 最流行的代码编辑器。
- `jetbrains-toolbox`: 管理 IDEA, PyCharm 等 JetBrains 全家桶。

## 5. 日常维护与进阶

### 更新软件

Scoop 的更新分为两步：先更新仓库列表，再更新软件。

```powershell
scoop update           # 更新 scoop 本身和 bucket
scoop update *         # 更新所有已安装的软件
```

### 清理旧版本

Scoop 默认会保留软件的旧版本（为了方便回退）。如果你的磁盘空间紧张，可以清理旧包：

```powershell
scoop cleanup *        # 清理所有软件的旧版本
```

### 软件备份与迁移

这是我最喜欢 Scoop 的一点：你可以导出一份列表，在另一台电脑上瞬间还原你的工作环境。

**导出列表：**

```powershell
scoop export > scoop-apps.json
```

**在另一台电脑恢复：**

```powershell
scoop import scoop-apps.json
```

## 6. 常见问题解决

### Windows 搜索找不到安装的软件

**现象**：安装了 Chrome 或 VS Code，但按 Win 键搜索不到。

**原因**：Windows 索引默认只覆盖特定的开始菜单目录，具体路径为：`C:\Users\<user>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs`（在运行窗口中输入 `shell:programs` 后点击 <kbd>Enter</kbd> 也可直接打开）。

**解决方法**：
Scoop 实际上会自动创建快捷方式到 `C:\Users\<user>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Scoop Apps`。如果搜索不到，通常是因为索引未更新或快捷方式未正确生成。

尝试执行以下命令重置：

```powershell
# 重置指定软件的快捷方式
scoop reset <package-name>

# 或者重置所有软件（推荐）
scoop reset *
```

`reset` 命令会重新执行安装脚本中的 “链接” 步骤，重建 `.exe` 的 shim 和开始菜单快捷方式。

此外，也可以使用 Scoop 自带的体检工具来发现路径或权限问题：

```powershell
scoop checkup
```
