# Agent Instructions: `bfmhno3.github.io`

The project `bfmhno3.github.io` is my personal blog website powered by Jekyll and the Minimal Mistakes theme.

## 1. Project Architecture & Scope

```bash
.
├── _config.yml             # Core site & plugin configuration (Verify compatibility before editing)
├── _data/navigation.yml     # Top navigation menu data structures
├── _includes/              # Liquid template snippets and layout overrides
├── _pages/                 # Independent static pages (about, portfolio, archives)
├── _posts/                 # Blog posts. Filename format: YYYY-MM-DD-title.md
├── _sass/                  # Custom SCSS extensions and style variables
├── assets/                 # Static assets (css/main.scss entrypoint, images, favicons)
├── docker-compose.yaml     # Local multi-container development configuration
└── Gemfile                 # Ruby gem dependency declarations
```

*Note: The `_site/` directory is an automated build artifact. Never modify or commit files within it directly.*

## 2. Content & Syntax Standards

### Blog Post Front Matter

Every new post in `_posts/` must begin with the following YAML block structure:

```yaml
---
title: "中文标题"
date: YYYY-MM-DD HH:MM:SS +08:00
description: "摘要"
categories:
  - 
tags:
  - 
---
```

### Formatting Guardrails

- **Unordered Lists**: Use the `-` marker exclusively. Do not use `*` or `+`.
- **Typesetting**: Always insert a single space between Chinese and English/numeric characters.
- **Quotes & Dashes**: Use plain straight quotes (`'` or `"`) and standard hyphens. Do not emit smart quotes (`“”`, `‘’`) or em dashes (`—`).

### Mathematical Expressions

- **Inline Math**: Wrap exactly in single dollar signs: `$f(x)$`.
- **Block Math**: Wrap in double dollar signs on separate lines:

```latex
$$
f(X) = x^2
$$
```

### Kramdown Notice Boxes

Apply theme-specific alert styling by placing the attribute tracker `{: .notice--<type>}` immediately below the target paragraph or block.

Available types: `notice` (gray), `primary` (theme color), `info` (blue), `warning` (yellow), `success` (green), `danger` (red).

```markdown
#### <i class="fas fa-info-circle"></i> Info Box Title

This is the description text matching the notice layout block.
{: .notice--info}
```

### Asset Naming & Optimization

- **Naming Convention**: All non-content assets (e.g., images, documents), excluding `.md` files within `_posts/` and `_pages/`, must strictly use lowercase alphanumeric characters separated by underscores (`_`).
- **Bitmap Processing Workflow**: Convert all bitmap images to `.jpg` format and compress them using `ffmpeg` to maximize site loading speed. Apply a quality factor of `-q:v 6` (or equivalent configuration) to achieve maximum compression while ensuring all text and technical details remain completely legible to human readers.
- **Backup & Link Synchronization**:
  1. **Mandatory Backup Prompt**: Before executing any image conversion, renaming, or compression, the agent must explicitly prompt the user to back up the original asset files.
  2. **Reference Integrity**: Immediately after renaming or converting an asset, the agent must scan the entire repository to locate and update all corresponding Markdown image links (`![]()`) and HTML `<img>` tags to prevent broken links.

## 3. Environment & Lifecycle

Use local environments in the following priority order:

1. **Nix flake + direnv (preferred)**: When entering the repository, `.envrc` automatically loads the development environment provided by `flake.nix`. If it does not load automatically, run `direnv allow`; if the environment is still not loaded, run `nix develop` to enter the same environment.
2. **Docker (second choice)**: Prefer Docker over Podman when Docker is available. Use Docker Compose to run the site.
3. **Podman (last choice)**: Use Podman only when Docker is unavailable. Podman MUST run in rootful mode; prefix every Podman command with `sudo` and do not use rootless Podman.

### Nix flake Environment

Run these commands from the repository root:

```bash
# First use, or when .envrc has not been trusted yet
direnv allow

# Fallback when direnv does not load the environment automatically
nix develop
```

After entering the Nix environment, install dependencies as needed and start the site:

```bash
bundle install
npm ci
bundle exec jekyll serve --watch --future --host 127.0.0.1
```

Stop the foreground Jekyll process with `Ctrl-C`. The site is available at `http://127.0.0.1:4000`.

### Docker Compose Environment

When Docker is available, use these commands:

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 jekyll
docker compose logs -f jekyll
docker compose run --rm jekyll bundle check
docker compose exec jekyll bundle exec jekyll build --strict_front_matter --trace
docker compose down
```

Use the live logs to diagnose Jekyll or Liquid rendering errors. Run `docker compose down` to stop and clean up the site containers.

### Podman Compose Environment

Use Podman only when Docker is unavailable. Podman MUST run in rootful mode, so every command must use `sudo`:

```bash
sudo podman compose build
sudo podman compose up -d
sudo podman compose ps
sudo podman compose logs --tail=100 jekyll
sudo podman compose logs -f jekyll
sudo podman compose run --rm jekyll bundle check
sudo podman compose exec jekyll bundle exec jekyll build --strict_front_matter --trace
sudo podman compose down
```

Do not mix Docker and Podman containers or named volumes. Before switching runtimes, run `compose down` with the runtime currently in use.

## 4. Core Execution & Diagnostics Protocol

### Code-First Interaction

- **Minimal Prose**: Omit conversational text, pleasantries, or speculative summaries. Provide the functional code blocks or configuration updates immediately.
- **Inline Documentation**: Restrict comments to highly ambiguous internal logic. Do not generate verbose docstrings or code annotations for existing structures.
- **Diagnostic Precision**: Do not guess or theorize. Read the exact source code or system build logs first. State what was located, the specific line file path, and apply the exact structural patch.
- **Code Reviews**: Identify the absolute location of the defect, present the fixed snippet, and stop execution immediately without architectural tangents.

### Git Workflow Requirements

- **Atomic Commits**: Segment individual logical updates into isolated, sequential commits. Avoid massive, single-batch structural changes.
- **Conventional Commits**: Commit messages must match the structural specification explicitly:
- `feat(contents): add new freeRTOS tutorial post`
- `fix(styles): repair notice box margin misalignment`

### Tooling & Infrastructure Safeguards

- **Pattern Matching & Processing**: Utilize high-performance system tools (`ripgrep`/`rg` for text strings, `ast-grep` for AST structural searches, and `ffmpeg` for image asset processing).
- **Hard Block Safeguard**: If `rg`, `ast-grep`, or `ffmpeg` are missing from the system environment path, pause execution immediately and instruct the user to install the missing dependencies before attempting any file modifications or asset processing.

### Modification Safety Barriers

- **Additive Bias**: Prioritize adding files or expanding styles. Never silently alter or delete pre-existing working logic.
- **Destructive Changes**: If a structural change requires file deletion or logic deprecation, halt and prompt the user for explicit confirmation.
- **Accountability**: State the exact configuration parameter changed or file removed immediately following user approval.
