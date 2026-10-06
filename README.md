# pi-cc-ui

Claude Code visual identity for [pi](https://pi.dev): themes, welcome banner, status line, spinner, turn footer, and CC-style tool rendering — faithfully aligned against the Claude Code source, line by line.

Fork of [better-claude-code-ui](https://github.com/Demo-0416/my-pi-extensions) (MIT, Copyright (c) 2026 Demo-0416), renamed as a base for custom work.

## Install

From the local checkout:

```bash
pi install .
```

From GitHub (once pushed):

```bash
pi install git:github.com/lit26/pi-cc-ui
```

Try it without installing:

```bash
pi -e .
```

### Recommended setting

This extension draws its own welcome banner, so pi's built-in startup header
becomes redundant. Hide it in `~/.pi/agent/settings.json`:

```json
{ "quietStartup": true }
```

The full two-column banner (extensions + skills) appears the first time you
open a given project, matching CC's `showOnboarding` behavior; later starts in
that project use the condensed logo.

## What you get

**6 themes** (`/themes` to switch, or use `/cc-theme` for a CC-only picker):

- `claude-code-dark` / `claude-code-light` — truecolor, matched key-by-key to CC's palette
- `claude-code-dark-ansi` / `claude-code-light-ansi` — ANSI-16 for terminals without truecolor
- `claude-code-dark-daltonized` / `claude-code-light-daltonized` — color-blind friendly variants

**UI modules**:

- **Welcome banner** — CC's condensed logo on startup, boxed banner for new versions / first run in a project
- **Status line** — model, cwd (with `~` shortening), git branch
- **Spinner** — CC's verb rotation with byline: elapsed time, token count, `esc to interrupt`
- **Turn footer** — per-request cost/duration summary, matching CC v2.1.234 behavior
- **Tool rendering** — CC-style tool rows (no background box), grouped consecutive calls with `⎿` continuation lines, CC-faithful diff rendering with syntax highlighting (shiki)
- **Thinking** — collapsed by default with CC's label treatment; `alt+t` to expand
- **Prompt editor** — CC's `❯` prompt pointer

**Commands**:

- `/cc-theme` — theme picker (CC themes only)
- `/cc-tools` — toggle CC-style tool rendering options
- `/cc-spinner` — spinner options

## Layout

```
extension/
  index.ts          entry point — registers every module
  banner.ts         welcome logo / onboarding box
  spinner.ts        CC verb rotation + byline
  status-line.ts    model, cwd, git branch
  turn-footer.ts    per-request cost/duration summary
  thinking.ts       collapsed thinking label, alt+t to expand
  prompt-editor.ts  CC's ❯ prompt pointer
  palette.ts        color palette helpers
  commands.ts       /cc-theme, /cc-tools, /cc-spinner
  host-patches.ts   prototype-method wraps for two public pi exports
  tools/
    builtins.ts     CC-style rendering for built-in tools
    diff.ts         CC-faithful diff rendering (shiki highlighting)
    grouping.ts     grouped consecutive tool calls (⎿ continuation)
    collapse.ts     collapsed tool output state
theme/              six CC theme JSON files
```

## Requirements

Runs inside pi (`@earendil-works/pi-coding-agent`); pi core packages are peer dependencies provided by the host. Tested against pi 0.84.x.

## License

MIT — see [LICENSE](./LICENSE).
