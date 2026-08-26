# Better Mistakes

`Better Mistakes` is the personal technical blog of `bfmhno3`, built with Astro and the [CuteLeaf/Firefly](https://github.com/CuteLeaf/Firefly) theme. Theme files currently follow upstream commit `c4e37eb418f31d7fbf1bcab8f25eda57902f22da`; Firefly remains distributed under its upstream license.

## Tree

- `src/content/posts/`: 27 migrated posts. Front matter uses `published`, `category`, and `tags`; bodies remain byte-for-byte identical to the Jekyll source.
- `src/content/spec/`: fixed pages such as About.
- `src/config/`: site identity, navigation, profile, and Giscus configuration.
- `src/pages/`: Astro routes and legacy URL compatibility.
- `public/assets/`: reusable identity and article assets.

The site URL is `https://bfmhno3.github.io`. The navigation is Posts, Categories, Tags, Portfolio, and About. The old category/post URLs and pagination remain available; portfolio intentionally remains empty.

## Local development

With Nix and direnv:

```bash
direnv allow
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
```

The development server is available at `http://127.0.0.1:4321`.

```bash
pnpm check
pnpm build
```

Docker uses the same Node/pnpm toolchain:

```bash
docker compose build
docker compose up -d
# http://127.0.0.1:4321
 docker compose down
```

Podman users must use rootful mode.

## Deployment

`.github/workflows/deploy.yml` installs the frozen pnpm lockfile, builds `dist/`, and publishes it to the repository's `pages` branch.

## Updating Firefly

Keep upstream theme code and personal site data separate:

1. Run `git fetch upstream --prune` and compare the current tree with `upstream/master`.
2. Update official components, layouts, styles, utilities, pages, plugins, dependencies, and schemas from upstream.
3. Reapply personal values to the current upstream structures in `src/config/`; never replace that directory wholesale.
4. Preserve personal content in `src/content/`, referenced files in `public/assets/`, and repository-specific deployment, Nix, Docker, and validation files.
5. Run `pnpm install --frozen-lockfile`, `node scripts/validate-content.mjs`, `pnpm check`, and `pnpm build` before accepting the update.

Do not maintain copied theme components or compatibility shims. When upstream changes a configuration field, migrate the personal value once to the new field.
