# local-review

A Claude Code mod for reviewing a local diff in a pane, tuicr-style: move through the diff, leave inline comments and suggestions, then send them all to Claude as one prompt. Faster than pushing a draft PR to review the agent's work.

## Install

In a Claude Code terminal session:

```
/plugin install local-review --marketplace shaharz/local-review
```

Answer `y` to add the marketplace, then pick the user scope.

Built against Claude Code 2.1.295. The function-hooks API it uses is early access, so a later Claude Code release may need an update here.

## Use

- `/local-review` reviews uncommitted changes in the session's repo (including untracked files).
- `/local-review staged`, `/local-review <commit>`, `/local-review <a>..<b>`, `/local-review branch` (merge-base with `origin/main` to the working tree) or `branch:<base>`.
- `--cwd <dir>` reviews another repo or worktree.
- Claude can open it too, through the `open_review` tool, for example on a worktree it just changed.

Click the diff once to give it the keyboard, then:

| Key | Action |
| --- | --- |
| `j` / `k`, arrows, `g` / `G`, pgup / pgdn | move |
| `]` / `[` | next / previous file |
| `f` | file list |
| `c` | comment on the line |
| `C` | comment on the file |
| `s` | suggestion: edit the line into what it should be |
| `x` | delete the comment on the line |
| `r` | refresh the diff |
| `S` | send the comments to Claude |
| `P` | put the comments in the prompt instead |
| `q` | close the pane |

While typing a comment: Enter saves; ctrl+g or **✕ cancel** cancels (so does Enter on empty text); ctrl+u clears. Esc can't reach the pane: it hands the keyboard back to the prompt and leaves the comment open.

The diff refreshes after each Claude turn while the pane is open. Works in the terminal and the desktop app; not in VS Code or mobile.

## Limits

- Comments are one line each, on single lines (no ranges yet), and are not kept across sessions.
- After a refresh, a comment stays on its line number even if the code moved.

## Develop

```
claude plugin validate .
claude plugin test .
```
