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

**`feat/chat-math-katex`** is the patched line and is the fork's **default branch**
(required so the scheduled sync workflow runs and so merging a sync PR triggers a
build). Upstream releases are merged into it via automated PRs (below), so its history
is the KaTeX patch plus upstream merge commits.

## Syncing with upstream (automated)

`.github/workflows/sync-upstream.yml` runs daily. When upstream publishes a new
**stable** release it:

1. merges that release into the patch branch on a `sync/upstream-<version>` branch,
   auto-resolving the inevitable `pnpm-lock.yaml` conflict and refreshing the lockfile,
2. opens a **pull request** into the default branch.

With `RELEASE_PAT` configured the bot **auto-merges** that PR (it stays in the PR list
as a record of the sync), which pushes to the default branch and triggers
`release-fork.yml` to build and publish `v<version>-katex.*`. Zero clicks. Without
`RELEASE_PAT` the PR is left open for you to merge by hand (a merge done with the
built-in token can't trigger the build, so the PAT is what makes it hands-off). If the
merge hits a conflict the bot can't resolve (usually only `ChatMarkdown.tsx`), it opens
an **issue** instead.

### Manual sync (fallback, when the bot opens an issue)

```bash
git fetch upstream --tags
git checkout feat/chat-math-katex
git merge v<version>            # the upstream tag named in the issue
# resolve conflicts (usually just ChatMarkdown.tsx), then:
vp install                      # refresh the lockfile
git commit
git push origin feat/chat-math-katex
```

Pushing to the default branch triggers the release build directly.

## Releasing your own builds

Releases are produced by **`.github/workflows/release-fork.yml`** (added by this fork).
It builds macOS / Linux / Windows desktop artifacts and publishes a GitHub Release on
this repo, using the built-in `GITHUB_TOKEN`.

**The auto-updater is already repo-relative.** `resolveGitHubPublishConfig` in
`scripts/build-desktop-artifact.ts` reads `T3CODE_DESKTOP_UPDATE_REPOSITORY` /
`GITHUB_REPOSITORY`, so an app built in this fork's CI embeds an `app-update.yml`
pointing at `hongjiaherng/t3code` releases - no code change needed. Installed builds
update from this fork.

### How a release is cut

A release is published automatically whenever the default branch is pushed (i.e. when
you merge a sync PR): `release-fork.yml` reads the merged-in upstream app version and
publishes `v<version>-katex.<run>`. It no-ops if that upstream version was already
released. You can also trigger it manually:

```bash
# Manual tag (first release, or to re-cut one)
git tag v0.0.27-katex.1
git push origin v0.0.27-katex.1
```

...or run the **Release (fork)** workflow from the Actions tab (Run workflow, enter a
version). Artifacts land on the GitHub Release for that tag.

### One-time fork setup in GitHub

1. **Set `feat/chat-math-katex` as the fork's default branch** (Settings, Branches).
   Required: GitHub only runs scheduled workflows from the default branch, and the
   release build triggers on pushes to it.
2. **Disable upstream's `release.yml`** in this fork: Actions tab, "Release" workflow,
   `...`, _Disable workflow_. (Doing it via the UI means no file edit, so it never
   causes merge conflicts.) Upstream's workflow can't run here anyway - it needs T3's
   private `production` environment, npm/Vercel/Discord secrets, and a GitHub App token.
3. **(For hands-off auto-merge)** Add a repo secret `RELEASE_PAT`: a fine-grained PAT
   scoped to this fork with **Contents: read/write** and **Pull requests: read/write**.
   The sync bot uses it to merge each PR so the build fires automatically. Skip this and
   the PR is opened but waits for you to merge it by hand.
4. Nothing else is required for a **local-only** build (cloud features off).

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
