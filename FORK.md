# Fork notes - hongjiaherng/t3code

This is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that adds
**LaTeX / KaTeX math rendering in the chat view**, which upstream declined in
[issue #1784](https://github.com/pingdotgg/t3code/issues/1784).

The goal: track upstream closely and keep enjoying the latest T3 Code, while shipping
our own builds that render math equations.

## What this fork changes

A single, isolated change in the chat markdown renderer:

- `apps/web/package.json` - adds `remark-math`, `rehype-katex`, `katex`
  (all from the same `remarkjs` / KaTeX ecosystem that already powers this app).
- `apps/web/src/components/ChatMarkdown.tsx` - wires `remarkMath` + `rehypeKatex`
  into the existing react-markdown pipeline and lets the math wrappers survive
  `rehype-sanitize` (KaTeX runs _after_ sanitize; see the schema comment).
- `apps/web/src/components/ChatMarkdown.browser.tsx` - tests for inline (`$…$`)
  and display (`$$…$$`) math.

`$…$` is inline math, `$$…$$` is display math. Math inside inline code / fenced
code blocks is **not** rendered (remark-math ignores code), so shell snippets like
`` `$PATH` `` are safe. Bare `$` in prose can occasionally be misread as math; if
that becomes annoying, disable single-dollar math by passing
`[remarkMath, { singleDollarTextMath: false }]` in `ChatMarkdown.tsx`.

## Git topology

```
origin    https://github.com/hongjiaherng/t3code.git   (this fork - we push here)
upstream  https://github.com/pingdotgg/t3code.git       (read-only - we pull updates)
```

The feature lives on the branch **`feat/chat-math-katex`** as a thin set of commits on
top of upstream `main`. Keep `main` as a clean mirror of upstream so rebases stay easy.

## Syncing with upstream

Because the change is tiny and isolated, rebasing it onto new upstream releases is
usually conflict-free (only the plugin-array line in `ChatMarkdown.tsx` can conflict,
and it's a trivial resolve).

```bash
# 1. Refresh the upstream mirror
git fetch upstream
git checkout main
git merge --ff-only upstream/main      # main stays a pure mirror
git push origin main

# 2. Replay our feature on top of the latest upstream
git checkout feat/chat-math-katex
git rebase main
# (resolve the ChatMarkdown.tsx plugin-array conflict if prompted, then:)
#   git add -A && git rebase --continue

# 3. Refresh the lockfile in case upstream changed deps, then push
vp install
git push --force-with-lease origin feat/chat-math-katex
```

Then cut a release (below). Tag from `feat/chat-math-katex`, not `main`.

## Releasing your own builds

Releases are produced by **`.github/workflows/release-fork.yml`** (added by this fork).
It builds macOS / Linux / Windows desktop artifacts and publishes a GitHub Release on
this repo, using the built-in `GITHUB_TOKEN`.

**The auto-updater is already repo-relative.** `resolveGitHubPublishConfig` in
`scripts/build-desktop-artifact.ts` reads `T3CODE_DESKTOP_UPDATE_REPOSITORY` /
`GITHUB_REPOSITORY`, so an app built in this fork's CI embeds an `app-update.yml`
pointing at `hongjiaherng/t3code` releases - no code change needed. Installed builds
update from this fork.

### To cut a release

```bash
git checkout feat/chat-math-katex
git tag v0.0.27-katex.1      # any vX.Y.Z[-suffix] tag
git push origin v0.0.27-katex.1
```

…or run the **Release (fork)** workflow manually (Actions tab → Run workflow → enter a
version). The tag/`workflow_dispatch` triggers the build; artifacts land on the
GitHub Release for that tag.

### One-time fork setup in GitHub

1. **Disable upstream's `release.yml`** in this fork: Actions tab → "Release" workflow →
   `•••` → _Disable workflow_. (Doing it via the UI means no file edit, so it never
   causes rebase conflicts.) Upstream's workflow can't run here anyway - it needs T3's
   private `production` environment, npm/Vercel/Discord secrets, and a GitHub App token.
2. Nothing else is required for a **local-only** build (cloud features off).

### Cloud features (optional)

Cloud login / sync / mobile linking are gated on `hasCloudPublicConfig`
(`apps/server/src/cloud/publicConfig.ts`). With no config they're simply disabled and
the app runs as a local coding agent - which is all that math rendering needs.

To enable them, set these as **repo secrets** to T3's public client values (they're
embedded in the official builds / hosted app, hence discoverable):
`T3CODE_RELAY_URL`, `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`. The release workflow already passes them through
when present.

### Code signing (optional)

`release-fork.yml` auto-detects signing secrets (same names as upstream) and falls back
to **unsigned** builds when they're absent. Unsigned means macOS Gatekeeper and Windows
SmartScreen will warn on first launch - fine for personal use. To sign, add the Apple
(`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY*`) and/or Azure Trusted Signing
(`AZURE_*`) secrets.

> First CI run: watch it. Runner labels were switched from upstream's private
> `blacksmith-*` fleet to GitHub-hosted runners (`macos-14`, `macos-13`, `ubuntu-latest`,
> `windows-latest`); adjust if your account has different runners available.
