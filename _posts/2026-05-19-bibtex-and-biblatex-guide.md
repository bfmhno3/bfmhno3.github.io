---
title: "BibTeX 与 BibLaTeX 入门：.bib 文件结构、引用与编译流程"
date: 2026-05-19 22:00:00 +08:00
excerpt: "从 .bib 条目结构出发，结合 BibTeX 与 BibLaTeX 两种工作流，梳理引用写法、编译顺序和常见注意事项。"
categories:
  - Note
tags:
  - LaTeX
---

最近恰逢本科阶段的倒数第二个课程设计，初步估计又得三四十页，并且老师不发模板只发排版要求，美其名曰让我们提前适应毕业论文写作（但是我记得毕业论文也是有 Word 模板的吧😂）。

我并非是某一方的狂热爱好者，在我看来两者都是工具，只要能解决我的问题，那就是好工具。显然这种比较专业的排版需求还是使用 LaTeX 比较合适，而我发现我对 LaTeX 的引用数据库还是不太了解，就大概学习了一并下整理了这篇博客，不一定足够专业，但是应该能够应付我的课程设计了。

## 1. `.bib` 文件的基本结构

`.bib` 文件可以理解成一个文献数据库，由多条文献条目组成。每条条目一般是下面这种形式：

```bibtex
@entrytype{citekey,
  field1 = {value1},
  field2 = {value2},
  ...
}
```

- `@entrytype`：文献类型，例如 `@article`、`@book`、`@inproceedings`。
- `citekey`：引用键（citation key），在正文中通过 `\cite{citekey}` 调用。
- `field = {value}`：字段和值，如 `author`、`title`、`year`。

### 1.1 常见条目类型与常用字段

| 条目类型 | 说明 | 常用字段 |
| --- | --- | --- |
| `@article` | 期刊论文 | `author`, `title`, `journal`, `year`, `volume`, `number`, `pages`, `doi` |
| `@inproceedings` | 会议论文 | `author`, `title`, `booktitle`, `year`, `pages`, `organization` |
| `@book` | 书籍 | `author` 或 `editor`, `title`, `publisher`, `year` |
| `@phdthesis` / `@mastersthesis` | 学位论文 | `author`, `title`, `school`, `year` |
| `@misc` / `@online`（BibLaTeX） | 网页、预印本 | `author`, `title`, `year`, `howpublished` 或 `url`, `note` |

不同条目在 BibTeX 与 BibLaTeX 中的必填字段会有差异，建议以所用样式文档为准。可以通过 `texdoc biblatex` 或 `texdoc bibtex` 查看官方说明。
{: .notice--info}

---

## 2. 一个最小可用的 `.bib` 示例

假设你新建一个文件 `references.bib`，内容如下：

```bibtex
@article{einstein1905,
  author  = {Albert Einstein},
  title   = {On the Electrodynamics of Moving Bodies},
  journal = {Annalen der Physik},
  year    = {1905},
  volume  = {17},
  pages   = {891--921},
}

@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984},
}

@inproceedings{he2016resnet,
  author    = {Kaiming He and Xiangyu Zhang and Shaoqing Ren and Jian Sun},
  title     = {Deep Residual Learning for Image Recognition},
  booktitle = {Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (CVPR)},
  year      = {2016},
  pages     = {770--778},
}
```

几个常用写法：

- **多个作者用 `and` 分隔**（BibTeX/BibLaTeX 会自动识别作者列表）：

```bibtex
author = {First Author and Second Author and Third Author},
```

- **页码用 `--` 而不是 `-`**：

```bibtex
pages = {770--778},
```

- **大小写保护**：专有名词或缩写（如 `TeX`、`CNN`）可用 `{}` 包起来，避免被样式改写：

```bibtex
title = {Deep Residual Learning for {CNN} Image Recognition},
```

---

## 3. 在 LaTeX 里如何使用 .bib（两种主流工作流）

1. **传统路线**：LaTeX + BibTeX
2. **现代路线**：LaTeX + BibLaTeX + biber

---

### 3.1 传统：LaTeX + BibTeX 工作流

**文档示例（`main.tex`）：**

```latex
\documentclass{article}
\usepackage[utf8]{inputenc} % 使用 XeLaTeX/LuaLaTeX 时通常不需要

\begin{document}

这是正文中的一条引用 \cite{einstein1905}，再来一条 \cite{knuth1984}。

\bibliographystyle{ieeetr}   % 选择参考文献样式，如 plain, unsrt, alpha, ieeetr 等
\bibliography{references}    % 不写 .bib 后缀

\end{document}
```

**编译顺序（非常关键）：**

1. `pdflatex main`
2. `bibtex main`
3. `pdflatex main`
4. `pdflatex main`

很多编辑器可以自动完成这些步骤，但底层顺序仍然是这 4 步。

**特点**：

- **优点**：历史悠久、兼容性好，很多旧模板和投稿模板仍要求 BibTeX。
- **缺点**：对 UTF-8、多语种姓名支持相对有限；`.bst` 样式定制门槛较高；对 URL、DOI、在线资源的处理不如 BibLaTeX 灵活。

---

### 3.2 现代：BibLaTeX + biber 工作流

**文档示例（`main.tex`）：**

```latex
\documentclass{article}
\usepackage[utf8]{inputenc} % 使用 XeLaTeX/LuaLaTeX 时可省略
\usepackage[backend=biber,style=authoryear,sorting=nyt]{biblatex}

\addbibresource{references.bib} % 指定 .bib 文件

\begin{document}

这是正文中的一条引用 \parencite{einstein1905}，
以及一条行文引用 \textcite{knuth1984}。

\printbibliography

\end{document}
```

- **`backend=biber`：**指定后端为 `biber`（而不是 `bibtex`）。
- **`style=authoryear`：**作者-年份格式（如 “Einstein 1905”），也可改为 `numeric`、`ieee` 等。
- **`sorting=nyt`：**按 `name-year-title` 排序。

**编译顺序：**

1. `pdflatex main`
2. `biber main`
3. `pdflatex main`
4. `pdflatex main`

如果你用的是 XeLaTeX/LuaLaTeX，则把 `pdflatex` 换成 `xelatex` 或 `lualatex` 即可。

**特点**：

- **优点**：对 UTF-8 与多语言支持更好；字段更丰富（如 `@online`、`url`、`doi`、`eprint`）；样式可通过 LaTeX 宏定制，可维护性更高；支持按章节、按类型分组等高级功能。
- **缺点**：某些期刊/会议模板仍明确要求 BibTeX。

---

## 4. 该如何选择？

如果模板没有明确限制，通常可以优先考虑 `XeLaTeX/LuaLaTeX + BibLaTeX + biber`。
{: .notice--important}

---

## 5. 写 `.bib` 时的一些实用小技巧

- **优先从数据库导出 BibTeX**：例如 Google Scholar、arXiv、ACM、IEEE、Springer，可减少手写错误。
- **统一命名规则（citekey）**：

比如 `authorYearShortTitle`：

```text
vaswani2017attention
he2016resnet
knuth1984texbook
```

- **中文文献的处理**：在 BibLaTeX + biber + UTF-8 工作流中，可直接使用中文 `title`、`author`；若投稿要求英文参考文献，可将英文信息写入主要字段，中文信息放在 `note` 或 `language`。
- **注意特殊字符转义**：`&`, `%`, `_`, `#` 等应转义为 `\&`, `\%`, `\_`, `\#`。

---

## 6. 完整示例（BibLaTeX + biber）

下面给出一套可直接实验的最小流程。

### 6.1 新建 `references.bib`

```bibtex
@article{vaswani2017attention,
  author  = {Ashish Vaswani and Noam Shazeer and Niki Parmar and Jakob Uszkoreit
             and Llion Jones and Aidan N. Gomez and Lukasz Kaiser and Illia Polosukhin},
  title   = {Attention Is All You Need},
  journal = {Advances in Neural Information Processing Systems},
  volume  = {30},
  year    = {2017},
}

@book{knuth1984texbook,
  author    = {Donald E. Knuth},
  title     = {The {TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984},
}
```

### 6.2 新建 `main.tex`

```latex
\documentclass{article}
\usepackage[utf8]{inputenc}
\usepackage[backend=biber,style=authoryear,sorting=nyt]{biblatex}

\addbibresource{references.bib}

\begin{document}

这是对 Transformer 的引用 \parencite{vaswani2017attention}，
这是对 \textcite{knuth1984texbook} 的引用。

\printbibliography

\end{document}
```

### 6.3 编译顺序

1. `pdflatex main`
2. `biber main`
3. `pdflatex main`
4. `pdflatex main`

如果你用的是 XeLaTeX，就把 `pdflatex` 换成 `xelatex`。
