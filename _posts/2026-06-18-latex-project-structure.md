---
title: "LaTeX 项目结构与 latexmk 配置"
date: 2026-06-18 11:20:00 +08:00
excerpt: "我用 LaTeX 写东西时的项目目录结构、main.tex 模板，以及一份跨平台的 .latexmkrc 配置。"
categories:
  - Note
tags:
  - LaTeX
---

## 目录结构

```bash
C:.
│  .gitignore
│  .latexmkrc
│  LICENSE
│  main.tex
│
├─contents
├─docs
├─figs
└─settings
    format.tex
    packages.tex
```

- `main.tex`：入口文件，只负责把各部分拼起来。
- `contents/`：章节内容，按章（`book`/`report` 类）或按节（`article` 类）建子文件夹。
- `figs/`：图片资源。配合 `\graphicspath{{figs/}}` 使用，正文里直接写文件名就行。
- `docs/`：项目文档，比如编译好的 PDF、使用说明等。
- `settings/packages.tex`：宏包导入。
- `settings/format.tex`：格式配置（页面布局、标题样式、字体等）。
- `.latexmkrc`：latexmk 的编译配置，后面会详细讲。
- `.gitignore`：LaTeX 项目的忽略模板可以参考 [github/gitignore/TeX.gitignore](https://github.com/github/gitignore/blob/main/TeX.gitignore)。注意官方模板里没有 `build/` 目录，如果你像我一样把编译产物输出到 `build/`，记得手动加上。

`packages.tex` 和 `format.tex` 的最小示例：

```tex
% settings/packages.tex -- 只管导入，不管配置
\usepackage{fontspec}
\usepackage{xeCJK}
\usepackage{geometry}
\usepackage{fancyhdr}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{amsfonts}
\usepackage{mathtools}
\usepackage{graphicx}
\usepackage{tabularray}
\usepackage{subcaption}
\usepackage{listings}
\usepackage{enumitem}
\usepackage{siunitx}
\usepackage[backend=biber, style=gb7714-2015]{biblatex}
\usepackage[colorlinks=true, linkcolor=blue, citecolor=blue, urlcolor=blue]{hyperref}
\usepackage[capitalise]{cleveref}
```

```tex
% settings/format.tex -- 字体、布局、宏包的后续配置
\setmainfont{TeX Gyre Termes}
\setsansfont{TeX Gyre Heros}
\setmonofont{TeX Gyre Cursor}
\setCJKmainfont{Source Han Serif SC}
\setCJKsansfont{Source Han Sans SC}
\setCJKmonofont{Source Han Mono SC}

\geometry{a4paper, margin=2.5cm}

\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\leftmark}
\fancyfoot[C]{\thepage}
\renewcommand{\headrulewidth}{0.4pt}

\UseTblrLibrary{booktabs, siunitx}

\graphicspath{{figs/}}
\sisetup{range-phrase=\ensuremath{\sim}, range-units=single}
\addbibresource{refs.bib}

% tabularray 常用全局设置
\SetTblrStyle{firsthead}{font=\bfseries}
\SetTblrStyle{firstfoot}{font=\small}
\SetTblrStyle{middlefoot}{font=\small}
\SetTblrStyle{lastfoot}{font=\small}
```

实际使用时按需增减。宏包的加载顺序有讲究，后面"常用宏包"一节会说明。

## `main.tex` 模板

### `book` 类

```tex
\documentclass{book}

\input{settings/packages}
\input{settings/format}

\begin{document}

\maketitle
\frontmatter

\tableofcontents

\mainmatter

% \input{contents/chap_01}

\appendix
% \input{contents/appendix}

\backmatter

\end{document}
```

### `article` 类

```tex
\documentclass{article}

\input{settings/packages}
\input{settings/format}

\begin{document}

\maketitle

\tableofcontents

% \input{contents/sec_01}

\appendix
% \input{contents/appendix}

\end{document}
```

### `report` 类

```tex
\documentclass{report}

\input{settings/packages}
\input{settings/format}

\begin{document}

\maketitle

\tableofcontents

% \input{contents/chap_01}

\appendix
% \input{contents/appendix}

\end{document}
```

### 三者差在哪

| | `article` | `report` | `book` |
|---|---|---|---|
| 最高章节 | `\section` | `\chapter` | `\chapter` |
| 默认排版 | 单面 | 单面 | 双面 |
| 标题页 | 正文内 | 独立一页 | 独立一页 |
| `\frontmatter` / `\backmatter` | 无 | 无 | 有 |
| 典型用途 | 短文、笔记、报告 | 课程报告、毕业论文 | 书籍、学位论文 |

`report` 和 `book` 都有 `\chapter`，区别主要在排版方式和文档结构命令。`book` 多了 `\frontmatter`、`\mainmatter`、`\backmatter`，默认双面排版，适合正式出版物。`report` 默认单面，没有前言/正文/后记的划分，适合不需要装订的长文档。

`article` 没有 `\chapter`，从 `\section` 开始。写短文、笔记够用了。

三者的标题页也不同。`book` 和 `report` 的 `\maketitle` 都是独立一页，`article` 的只是在正文开头插一行。

## 工具简介

在看 `.latexmkrc` 之前，先简单介绍一下涉及的几个工具。

**XeLaTeX**

LaTeX 的编译引擎之一。相比传统的 pdfLaTeX，XeLaTeX 原生支持 Unicode 和系统字体（通过 fontspec），处理中文要方便得多。如果你主要写中文文档，XeLaTeX（或 LuaLaTeX）基本是必选的。

**latexmk**

一个 Perl 写的自动化编译工具。LaTeX 的编译经常需要跑多遍（交叉引用、目录、参考文献），手动执行很烦。latexmk 会自动判断需要跑几遍、要不要调用 BibTeX/Biber，直到所有引用都稳定为止。配合 `-pvc` 参数还能监控文件变化，保存即编译。

**BibTeX 和 Biber**

两者都是处理参考文献的工具。BibTeX 是老方案，Biber 是配合 biblatex 宏包的新方案，功能更强（支持 Unicode、更灵活的样式定制）。latexmk 的 `$bibtex_use = 2` 会自动检测你用的是哪个，不用手动切换。

**SyncTeX**

在编辑器和 PDF 阅读器之间做双向跳转的数据格式。加了 `-synctex=1` 之后，你可以在编辑器里点一个位置，PDF 阅读器自动翻到对应页面，反过来也行。

## `.latexmkrc`

```perl
# 主文件
$root = 'main.tex';

# 输出目录
$out_dir = 'build';
$aux_dir = 'build';

# 编译引擎: XeLaTeX
$pdf_mode = 5;
$xelatex = 'xelatex -interaction=nonstopmode -file-line-error -synctex=1 %O %S';

# 自动运行 BibTeX 或 Biber
$bibtex_use = 2;

# 清理时保留 PDF
$clean_ext = 'aux bbl bcf blg fdb_latexmk fls log out run.xml synctex.gz toc';

# 跨平台 PDF 预览器
if ($^O eq 'MSWin32') {
    $pdf_previewer = 'start %S';
} elsif ($^O eq 'darwin') {
    $pdf_previewer = 'open %S';
} else {
    $pdf_previewer = 'xdg-open %S 2>/dev/null || evince %S';
}

# Windows 下清理时不删除被占用的文件
if ($^O eq 'MSWin32') {
    $cleanup_includes_generated = 0;
}

# 自定义依赖示例（取消注释即可用）
# add_cus_dep('glo', 'gls', 0, 'makeglos');
# sub makeglos {
#     system("makeindex -s $_[0].ist -t $_[0].glg -o $_[0].gls $_[0].glo");
# }
```

### 逐项说明

- `$root`：主文件名。latexmk 从这里开始分析依赖。改成你的实际文件名就行。
- `$out_dir` / `$aux_dir`：编译产物放哪。设成 `build` 能让根目录干净一些，PDF 会出现在 `build/main.pdf`。记得在 `.gitignore` 里加上 `build/`。
- `$pdf_mode`：选择编译引擎。1 是 pdfLaTeX，4 是 LuaLaTeX，5 是 XeLaTeX。
- `$xelatex`：XeLaTeX 的调用参数。`-interaction=nonstopmode` 让它遇到错误继续编译而不是停下来等你按回车；`-file-line-error` 让报错信息带上文件名和行号；`-synctex=1` 生成编辑器跳转用的数据。`%O` 和 `%S` 是 latexmk 的占位符，分别代表额外选项和源文件。
- `$bibtex_use`：设为 2 就行，自动检测 BibTeX 还是 Biber。设为 0 关闭自动处理，1 只在 `.bbl` 已存在时才跑。
- `$clean_ext`：`latexmk -c` 会删掉这些后缀的文件。PDF 不在里面，所以清理后 PDF 还在。注意区分 `-c`（清理中间文件，保留 PDF）和 `-C`（连 PDF 一起删），别手滑用了 `-C`。
- **跨平台预览器**：Perl 的 `$^O` 变量存着操作系统类型：Windows 是 `MSWin32`，macOS 是 `darwin`，Linux 就是 `linux`。`start`、`open`、`xdg-open` 分别是三个平台打开文件的命令。`%S` 会被替换成 PDF 路径。配合 `latexmk -pvc` 使用，保存文件后自动编译并刷新 PDF 预览，不用手动跑命令。
- `$cleanup_includes_generated`：Windows 上文件锁比较死板，latexmk 清理时可能删不掉正在被占用的文件。设为 0 可以避免这个问题。
- **自定义依赖**：`add_cus_dep` 用来告诉 latexmk "如果某个 `.glo` 文件变了，要重新生成对应的 `.gls`"。示例里是术语表的场景，取消注释就能用。

## 常用宏包

以下是写中文 LaTeX 文档时经常会用到的宏包，以及它们的典型配置。

加载顺序需要注意几点：`fontspec` 和 `xeCJK` 要在大多数宏包之前加载；`amsmath` 要在 `mathtools` 之前；`tabularray` 的 `\UseTblrLibrary` 要在 `siunitx` 之后（因为 `siunitx` 库需要 siunitx 已加载）；`hyperref` 几乎总是放在最后，唯一的例外是 `cleveref`，它必须在 `hyperref` 之后。上面 `packages.tex` 示例中的顺序可以直接用。

### 字体与编码

**fontspec**

配合 XeLaTeX/LuaLaTeX 使用，用来设置系统字体。

```tex
\usepackage{fontspec}
\setmainfont{TeX Gyre Termes}          % 正文衬线字体
\setsansfont{TeX Gyre Heros}           % 无衬线字体
\setmonofont{TeX Gyre Cursor}          % 等宽字体
```

**xeCJK**

处理中文排版的核心宏包，自动处理中英文之间的间距、标点挤压等。

```tex
\usepackage{xeCJK}
\setCJKmainfont{Source Han Serif SC}   % 中文衬线（思源宋体）
\setCJKsansfont{Source Han Sans SC}    % 中文无衬线（思源黑体）
\setCJKmonofont{Source Han Mono SC}    % 中文等宽
```

### 页面布局

**geometry**

控制页面尺寸和边距，比 LaTeX 默认的布局参数好用得多。

```tex
\usepackage[a4paper, margin=2.5cm]{geometry}
% 也可以精细控制
% \usepackage[a4paper, top=3cm, bottom=2.5cm, left=2.8cm, right=2.2cm]{geometry}
```

**fancyhdr**

自定义页眉页脚。

```tex
\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}                             % 清空默认设置
\fancyhead[L]{\leftmark}               % 页眉左侧放章节名
\fancyfoot[C]{\thepage}                % 页脚中间放页码
\renewcommand{\headrulewidth}{0.4pt}   % 页眉横线粗细
```

### 数学与代码

**amsmath / amssymb / amsfonts**

数学排版的基础三件套，基本上写公式就得用。

```tex
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{amsfonts}
```

**mathtools**

amsmath 的扩展包，修复了一些设计问题并增加了实用工具。

```tex
\usepackage{mathtools}
% 例如：可以给公式加编号标签
% \usetagform{default}
```

**listings**

排版代码块。支持语法高亮，可以指定语言和样式。

```tex
\usepackage{listings}
\lstset{
    basicstyle=\ttfamily\small,
    breaklines=true,
    frame=single,
    numbers=left,
    numberstyle=\tiny\color{gray},
    keywordstyle=\color{blue},
    commentstyle=\color{green!60!black},
    stringstyle=\color{red!70!black},
}
```

**minted**

基于 Pygments 的代码排版，高亮效果比 listings 好，但需要 Python 环境且编译时要加 `-shell-escape`。

```tex
\usepackage{minted}
% 使用示例：
% \begin{minted}{python}
% def hello():
%     print("world")
% \end{minted}
```

### 图表与浮动体

**graphicx**

插入图片。

```tex
\usepackage{graphicx}
\graphicspath{{figs/}}                 % 指定图片搜索路径
```

**tabularray**

现代表格宏包，统一了表格的样式配置和内容分离。用 `tblr` 环境替代传统的 `tabular`，样式参数写在 `\begin{tblr}{...}` 的花括号里，正文和样式彻底分开。配合 `booktabs` 库可以使用 `\toprule`、`\midrule`、`\bottomrule`。

```tex
\usepackage{tabularray}
\UseTblrLibrary{booktabs, siunitx}
% \begin{table}
% \begin{tblr}{
%   colspec = {lrc},
%   row{1} = {font=\bfseries},
% }
%   \toprule
%   姓名 & 分数 & 等级 \\
%   \midrule
%   张三 & 95 & A \\
%   李四 & 82 & B \\
%   \bottomrule
% \end{tblr}
% \end{table}
```

`booktabs` 库提供三线表的线条命令，`siunitx` 库让列可以用 `S` 类型对齐数字。tabularray 还支持 `longtblr`（跨页长表格）和 `talltblr`（不跨页但可加脚注的表格），基本覆盖了所有表格场景。

**subcaption**

在一个浮动体里放多张子图，每个子图独立编号和引用。

```tex
\usepackage{subcaption}
% \begin{figure}[htbp]
%   \begin{subfigure}{0.48\textwidth}
%     \includegraphics[width=\textwidth]{fig_a}
%     \caption{子图 A}
%   \end{subfigure}
%   \hfill
%   \begin{subfigure}{0.48\textwidth}
%     \includegraphics[width=\textwidth]{fig_b}
%     \caption{子图 B}
%   \end{subfigure}
%   \caption{总标题}
% \end{figure}
```

### 参考文献

**biblatex**

现代的参考文献管理方案，配合 Biber 后端使用。比 BibTeX 灵活很多，支持多语言、多文献列表等。

```tex
\usepackage[backend=biber, style=gb7714-2015]{biblatex}
\addbibresource{refs.bib}              % 指定 .bib 文件
% 正文中用 \cite{key} 引用
% 文末用 \printbibliography 输出
```

`style=gb7714-2015` 是中文文献常用的国标样式，需要 `biblatex-gb7714-2015` 宏包。英文文档常用 `style=ieee`、`style=apa` 或 `style=alphabetic`。

**hyperref**

给交叉引用、目录、参考文献加上超链接。通常放在 `\usepackage` 的最后（少数例外，如 cleveref 要在 hyperref 之后）。

```tex
\usepackage[
    colorlinks=true,
    linkcolor=blue,
    citecolor=blue,
    urlcolor=blue,
]{hyperref}
```

### 其他实用工具

**ctex**

如果不想手动配 xeCJK，直接用 ctex 宏包或 `ctexart`/`ctexbook` 文档类，一键搞定中文支持。

```tex
\usepackage[UTF8, heading=true]{ctex}
% 或者直接用 \documentclass{ctexart}
```

**enumitem**

定制列表环境（enumerate、itemize、description）的间距和标签样式。

```tex
\usepackage{enumitem}
\setlist{nosep}                        % 去掉列表的多余间距
% \begin{enumerate}[label=(\arabic*)]
%   \item 第一项
%   \item 第二项
% \end{enumerate}
```

**tikz**

画矢量图。学习曲线陡峭，但画出来的东西质量很高，跟 LaTeX 文档浑然一体。

```tex
\usepackage{tikz}
\usetikzlibrary{arrows.meta, positioning}
% 简单示例：画一个带箭头的直线
% \begin{tikzpicture}
%   \draw[->] (0,0) -- (2,1) node[right] {$y = x/2$};
% \end{tikzpicture}
```

**siunitx**

处理数值和单位的排版。数字的千分位、科学记数法、单位的正体和间距，它都能管。

```tex
\usepackage{siunitx}
\sisetup{
    range-phrase = \ensuremath{\sim},
    range-units = single,
}
% \qty{10}{\metre}           -> 10 m
% \qty{1.23e5}{\pascal}      -> 1.23 × 10⁵ Pa
% \qtyrange{1}{10}{\metre}   -> 1~10 m（单位只出现一次，用 ~ 连接）
```

`range-units=single` 让范围表达中单位只出现一次，而不是"1 m 到 10 m"。`range-phrase` 设成 `\ensuremath{\sim}` 把分隔符换成 `~`（波浪号），`\ensuremath` 确保它在数学模式和文本模式下都能正确渲染。

**cleveref**

智能引用，自动加上"图""表""公式"等前缀，不用自己写 `\ref{fig:xxx} 的图`。注意要放在 hyperref 之后加载。

```tex
\usepackage[capitalise]{cleveref}
% 使用 \cref{fig:example} 会自动输出"图 1"
% \cref{eq:main,eq:sub} 会输出"公式 (1) 和 (2)"
```
