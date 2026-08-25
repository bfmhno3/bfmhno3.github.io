# bfmhno3.github.io

这是一个基于 Jekyll 和 Minimal Mistakes 主题搭建的个人博客仓库，站点地址配置为 `https://bfmhno3.github.io`。仓库主要内容是技术笔记、学习记录和个人页面；Jekyll 会把 Markdown、页面配置和静态资源构建成最终站点。

## 目录结构

```text
.
├── _config.yml              # Jekyll 站点主配置
├── _data/                   # 结构化数据，例如导航栏配置
│   └── navigation.yml
├── _includes/               # Liquid 片段和主题覆盖文件
│   ├── figure
│   └── head/
│       └── custom.html
├── _pages/                  # 独立页面
│   ├── about.md
│   ├── category-archive.md
│   ├── portfolio.md
│   ├── tag-archive.md
│   ├── year-archive.md
│   └── 404.md
├── _posts/                  # 博客文章，文件名遵循 YYYY-MM-DD-title.md
├── _sass/                   # Sass 样式扩展
│   ├── custom.scss
│   └── custom/
│       └── _figures.scss
├── assets/                  # 站点静态资源
│   ├── css/
│   │   └── main.scss
│   └── images/
│       ├── favicon/
│       └── ...
├── .github/                 # GitHub 配置和自动化工作流
│   ├── dependabot.yml
│   └── workflows/
│       └── build-jekyll.yml
├── .codex/
│   └── config.toml          # Codex 项目级工作区配置
├── .editorconfig            # 编辑器编码、换行和缩进规则
├── .markdownlint-cli2.yaml  # Markdownlint 规则
├── .ruby-version            # Ruby 精确版本
├── scripts/                 # 内容与资产规则检查
├── docker-compose.yaml      # Podman 本地预览环境
├── Dockerfile               # 固定 Ruby 和 Bundler 的开发镜像
├── Gemfile                  # Ruby/Jekyll 依赖声明
├── Gemfile.lock             # Ruby 依赖锁定文件
├── package.json             # Markdown 检查工具声明
├── package-lock.json        # Node.js 依赖锁定文件
├── index.html               # 首页入口
├── AGENTS.md                # 仓库协作和内容规则源
├── CLAUDE.md                # 转发到 AGENTS.md 的兼容入口
└── README.md                # 仓库说明
```

## 主要目录说明

- `_posts/`：博客文章目录。新增文章时使用 `YYYY-MM-DD-title.md` 命名，并在文件头部写 Jekyll front matter。
- `_pages/`：固定页面目录，例如 About、Portfolio、分类归档、标签归档和 404 页面。该目录通过 `_config.yml` 的 `include` 配置纳入构建。
- `_data/`：存放数据文件。目前 `navigation.yml` 定义顶部导航菜单。
- `_includes/`：存放 Liquid include 片段或对主题局部模板的覆盖。适合放需要在多篇文章或多个布局中复用的小组件。
- `_sass/`：自定义 Sass 样式。`assets/css/main.scss` 会导入主题和自定义样式，最终由 Jekyll 编译。
- `assets/`：静态资源目录。图片、favicon、站点 logo、文章配图等放在 `assets/images/`；样式入口放在 `assets/css/`。
- `.github/workflows/`：GitHub Actions 工作流目录，用于自动构建或发布 Jekyll 站点。
- `_site/`：Jekyll 构建输出目录。本地构建后生成，不应手工维护，已由 `.gitignore` 排除。
- `.bundle/`：本地 Bundler 配置目录。属于开发环境产物，已由 `.gitignore` 排除。

## 关键文件说明

- `_config.yml`：站点的核心配置文件，包括主题、站点信息、作者信息、评论、搜索、归档、分页、插件、Markdown 和 Sass 配置。
- `Gemfile` / `Gemfile.lock`：声明并锁定 Ruby gems。当前使用 `github-pages`、`minimal-mistakes-jekyll`、`jekyll-paginate-v2`、`jekyll-spaceship`、`jekyll-archives` 等依赖。
- `Dockerfile` / `docker-compose.yaml`：提供固定版本、非 root 的 Podman 开发环境，仅在 `127.0.0.1:4000` 监听，并使用命名 volume 缓存 gems。
- `index.html`：站点首页入口，具体展示逻辑主要由 Jekyll 布局和主题配置决定。
- `AGENTS.md`：仓库协作、文章格式和资产处理规则源；`CLAUDE.md` 仅作为兼容入口转发到该文件。
- `.codex/config.toml`：Codex 项目级基线，使用 `workspace-write` sandbox 并启用 multi-agent。

## 本地运行

项目固定使用 Ruby 3.3.12 和 Bundler 2.6.9。Dockerfile 通过不可变 digest 固定 Ruby 3.3 Bookworm 基础镜像，`Gemfile.lock` 锁定 gems 和 Bundler 版本。推荐使用 Podman：

```powershell
podman compose build
podman compose up -d
podman compose logs --tail=100 jekyll
```

启动后访问：

```text
http://127.0.0.1:4000
```

停止站点：

```powershell
podman compose down
```

如需使用 Nix 本地工具链，在仓库根目录执行 `nix develop`。首次进入后按需安装锁定的 Ruby 与 npm 依赖：

```bash
nix develop
bundle install
npm ci
bundle exec jekyll serve --watch --future --host 127.0.0.1
```

启动后访问 `http://127.0.0.1:4000`。Nix shell 只提供 Ruby、Node.js 和构建工具，不会自动安装依赖或构建站点；它不改变 GitHub Actions。需要容器隔离或 `watch` / `force_polling` 行为时，仍使用上面的 Podman Compose 流程。

如需临时使用 RubyGems 镜像，可在启动前设置 `RUBYGEMS_MIRROR`；默认使用官方 RubyGems。例如在 PowerShell 中：

```powershell
$env:RUBYGEMS_MIRROR = "https://mirrors.tuna.tsinghua.edu.cn/rubygems/"
podman compose up -d
```

## 验证

Podman 环境中的验证命令如下；在 Nix shell 中去掉 `podman compose run --rm jekyll` 前缀即可运行同一组 Ruby 命令：

```powershell
podman compose run --rm jekyll bundle check
podman compose run --rm jekyll bundle exec bundle-audit check --update
podman compose run --rm jekyll bundle exec ruby scripts/validate_content.rb
podman compose run --rm jekyll bundle exec jekyll build --strict_front_matter --trace
podman compose run --rm jekyll bundle exec htmlproofer ./_site --disable-external --ignore-urls '/mermaid\.ink\/svg/'
npm ci
npm audit --audit-level=high
npm run lint:markdown
```

Nix shell 中对应的构建与校验命令为：

```bash
bundle exec ruby scripts/validate_content.rb
bundle exec jekyll build --strict_front_matter --trace
bundle exec htmlproofer ./_site --disable-external --ignore-urls '/mermaid\.ink\/svg/'
npm run lint:markdown
npm audit --audit-level=high
bundle exec bundle-audit check --update
```

CI 的 Node.js 检查使用 Node.js 24 和锁定的 `markdownlint-cli2 0.23.1`。`validate_content.rb` 会检查全部 Git 已跟踪文章的文件名和 front matter；资产规则只检查相对基线新增或重命名的文件。默认基线为 `HEAD^`，也可以显式指定：

```powershell
podman compose run --rm jekyll bundle exec ruby scripts/validate_content.rb --base origin/main
```

未跟踪文章不会被该脚本检查；新增文章应先执行 `git add`，或在形成提交后再验证。

## 部署

`main` push 和手动 `workflow_dispatch` 由 GitHub 官方 Pages Actions 构建和发布。Pull Request 会运行 npm/Ruby 安全审计、变更 Markdown 检查、内容验证、严格构建和 HTMLProofer，但不会上传或部署 Pages。Actions 使用完整 commit SHA 固定版本，部署权限仅授予独立 deploy job。

首次迁移后，需要在仓库 `Settings > Pages > Source` 中选择 `GitHub Actions`。Dependabot 每月检查 Bundler、npm、GitHub Actions 和 Docker，每个生态最多同时打开 5 个 PR，不自动合并。

## 内容维护流程

1. 在 `_posts/` 中新增或修改文章。
2. 使用必需的 front matter：

   ```yaml
   ---
   title: "中文标题"
   date: YYYY-MM-DD HH:MM:SS +08:00
   description: "摘要"
   categories:
     - category
   tags:
     - tag
   ---
   ```

3. 将文章配图放入 `assets/images/`，使用小写字母、数字和下划线命名；新位图统一使用 `.jpg`，例如 `/assets/images/example.jpg`。转换、压缩或重命名前先备份原图，并同步更新全仓引用。
4. 如需调整导航，修改 `_data/navigation.yml`。
5. 如需新增固定页面，放入 `_pages/`，并确认 front matter 中设置了合适的 `permalink`。
6. 如需调整全站配置、插件、作者信息或主题行为，修改 `_config.yml` 后重启本地 Jekyll 服务。

## 维护注意事项

- `_site/` 是构建结果，优先通过源文件重新生成。
- `.bundle/` 是本地 Bundler 配置，不属于站点源码。
- 文章文件名中的日期会影响 Jekyll 的发布时间和排序。
- `_config.yml` 修改后需要重启 `jekyll serve` 才能完全生效。

## 故障排查

- Jekyll 或 Liquid 报错：运行 `podman compose logs -f jekyll` 查看完整日志。
- 修改 `_config.yml` 后未生效：依次运行 `podman compose down` 和 `podman compose up -d`。
- gem 依赖异常：先运行 `podman compose build`，再运行 `podman compose run --rm jekyll bundle check`。
- Podman named pipe 返回 EOF：重启 Podman machine 后重新执行 Compose 命令。
- RubyGems 镜像异常：运行 `Remove-Item Env:RUBYGEMS_MIRROR -ErrorAction SilentlyContinue` 清除临时镜像变量，再重启容器。
- 端口无法访问：确认没有其他程序占用 `127.0.0.1:4000`。
