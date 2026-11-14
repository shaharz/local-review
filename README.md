# local-review

A Claude Code mod for reviewing a local diff in a pane, tuicr-style: move through the diff, leave inline comments and suggestions, then send them all to Claude as one prompt. Faster than pushing a draft PR to review the agent's work.

## Install

In a Claude Code terminal session:

```
/plugin install local-review --marketplace shaharz/local-review
```

Answer `y` to add the marketplace, then pick the user scope.

Built against Claude Code 2.1.325. The function-hooks API it uses is early access, so a later Claude Code release may need an update here.

## Use

- `/local-review` reviews uncommitted changes in the session's repo (including untracked files).
- `/local-review staged`, `/local-review <commit>`, `/local-review <a>..<b>`, `/local-review branch` (merge-base with `origin/main` to the working tree) or `branch:<base>`.
- `--cwd <dir>` reviews another repo or worktree.
- Claude can open it too, through the `open_review` tool, for example on a worktree it just changed.

Each repo and target is its own review. Open a second one and the pane grows a tab row: every review keeps its own comments and its place in the diff, and a tab shows how many comments it has waiting (`●2`). Opening a review that is already there refreshes its tab. A review that arrives while you are typing a comment waits in its tab instead of taking over the view. Tabs stay until you close them, also across closing the pane.

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
| `S` | send this review's comments to Claude |
| `P` | put this review's comments in the prompt instead |
| `1`–`9`, or a click on a tab | switch review |
| `w` | close this review (its unsent comments go with it) |
| `q` | close the pane |

While typing a comment: Enter saves; ctrl+g or **✕ cancel** cancels (so does Enter on empty text); ctrl+u clears. Esc can't reach the pane: it hands the keyboard back to the prompt and leaves the comment open.

The review in view refreshes after each Claude turn while the pane is open, and when you switch to it. Works in the terminal and the desktop app; not in VS Code or mobile.

## Limits

- Comments are one line each, on single lines (no ranges yet), and are not kept across sessions.
- After a refresh, a comment stays on its line number even if the code moved.

## Develop

```
claude plugin validate .
claude plugin test .
```
