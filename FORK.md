# About this fork

This is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) with two
additions: it renders **LaTeX math in chat** with KaTeX (`$…$` for inline, `$$…$$` for
display), turned down upstream in
[issue #1784](https://github.com/pingdotgg/t3code/issues/1784), and it adds an experimental
**Claude PTY provider** (see below). Everything else is stock T3 Code.

Grab a desktop build from this repo's
[Releases](https://github.com/hongjiaherng/t3code/releases). Installed copies
auto-update from this fork, not from upstream.

## How it keeps up with upstream

A GitHub Action checks upstream once a day. When there is a new stable release it rebases
the KaTeX patch on top of it and builds a fresh `v<version>-katex.*` release. Rebasing
keeps the history linear (upstream, then our patch), which means the patch branch gets
force-pushed on every sync. If you ever check it out, use `git fetch && git reset --hard`
rather than `git pull`.

The only file that tends to conflict is `apps/web/src/components/ChatMarkdown.tsx`. When
it does, the bot opens an issue and steps back so it does not keep retrying. To sort it
out by hand:

```bash
git fetch upstream --tags && git fetch origin
git checkout feat/chat-math-katex
git rebase --onto v<version> "$(git merge-base @ v<version>)"   # tag from the issue
# fix ChatMarkdown.tsx, then:
git rebase --continue
vp install --lockfile-only && git add pnpm-lock.yaml && git commit --amend --no-edit
git push --force-with-lease origin feat/chat-math-katex
```

The force-push kicks off the release build. Close the issue once the tag has landed.

## Claude PTY provider (experimental)

Lives on the `feat/claude-pty` branch (branched from `feat/chat-math-katex`), kept off the
default branch because it is large. A new `claudePty` provider runs the interactive `claude`
CLI in a pseudo-terminal, types prompts in via bracketed paste, and tails Claude's
`~/.claude/projects/.../<session>.jsonl` transcript to turn assistant text, tool calls, and
results into normal chat activity. So you get Claude Code's subscription login and interactive
mode, rendered inside T3.

Where it lives:

- Server: `provider/Drivers/ClaudePtyDriver.ts`, `provider/Layers/ClaudePtyAdapter.ts` +
  `ClaudePtyProvider.ts`, `provider/Services/ClaudePtyAdapter.ts`, `provider/ptyTerminalText.ts`,
  wired up in `provider/builtInDrivers.ts`.
- Contracts: `ClaudePtySettings` in `packages/contracts/src/settings.ts`.
- Web: the picker, settings, and icons learn about `claudePty`.

It is off by default. Turn it on under Settings > Providers, with the `claude` CLI installed
and signed in. It only works locally, does not handle attachments, and shares Claude's model
list.

## Remotes

```
origin    https://github.com/hongjiaherng/t3code.git   (this fork)
upstream  https://github.com/pingdotgg/t3code.git       (read-only, where updates come from)
```

## Setup notes

The automation relies on three one-time settings, all already in place:

- `feat/chat-math-katex` is the default branch. GitHub only schedules workflows there,
  and the release build triggers on pushes to it.
- Upstream's own `release.yml` is disabled in this fork's Actions tab. It cannot run here
  anyway, since it needs T3's private secrets.
- A `RELEASE_PAT` secret (Contents + Pull requests, read/write) lets the bot land each
  sync and fire the build with no clicks. Without it the sync still opens a PR; you just
  land it yourself.

Builds are unsigned and local-only by default. Code signing and the optional cloud login
turn on only if you add the matching secrets; see `release-fork.yml`.
