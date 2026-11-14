import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Review, ReviewComment, ReviewTab, ViewerMessage, ViewerProps } from '../types'
import { branchArgv, buildPrompt, capRows, commitArgv, parseDiff, planTarget, untrackedArgv } from './diff'

const PANE = 'local-review'
const TOOL = 'open_review'
const MAX_UNTRACKED = 100
const FILE_PROPS_LIMIT = 70_000

const tabs = atom({ plugin: 'local-review', key: 'tabs' } as const, [])
const active = atom({ plugin: 'local-review', key: 'active' } as const, '')
const isOpen = atom({ plugin: 'local-review', key: 'isOpen' } as const, false)
const isEditing = atom({ plugin: 'local-review', key: 'isEditing' } as const, false)
const cancelSeq = atom({ plugin: 'local-review', key: 'cancelSeq' } as const, 0)

type $ = EngineInterface

async function git($: $, cwd: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return $.process.run(['git', ...argv], { cwd, timeoutMs: 60_000 })
}

/** Why a git call failed: what it wrote to stderr, or its exit code when it wrote nothing (a child ended by a signal exits 1, silent). */
function failure(command: string, result: { exitCode: number; stderr: string }): string {
  return result.stderr.trim() || `git ${command} exited ${result.exitCode} without an error message; press r to retry`
}

async function loadReview($: $, cwd: string, target: string): Promise<Review> {
  const top = await git($, cwd, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) {
    return { root: cwd, target, label: target || 'uncommitted changes', files: [], error: failure('rev-parse', top) }
  }
  const root = top.stdout.trim()
  const name = root.split('/').pop() ?? root
  const plan = planTarget(target)

  let argv: string[]
  let label: string
  let withUntracked = false

  if (plan.kind === 'diff') {
    argv = plan.argv
    label = `${plan.label} in ${name}`
    withUntracked = plan.withUntracked
  } else if (plan.kind === 'branch') {
    const base = plan.base || ((await git($, root, ['rev-parse', '--verify', '-q', 'origin/main'])).exitCode === 0 ? 'origin/main' : 'main')
    const mb = await git($, root, ['merge-base', base, 'HEAD'])
    if (mb.exitCode !== 0) {
      return { root, target, label: `branch vs ${base}`, files: [], error: failure('merge-base', mb) }
    }
    const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    argv = branchArgv(mb.stdout.trim())
    label = `${branch} vs ${base} (incl. uncommitted) in ${name}`
    withUntracked = true
  } else {
    argv = commitArgv(plan.rev)
    const subject = (await git($, root, ['log', '-1', '--format=%h %s', plan.rev])).stdout.trim()
    label = `commit ${subject || plan.rev} in ${name}`
  }

  const out = await git($, root, argv)
  if (out.exitCode !== 0) return { root, target, label, files: [], error: failure(argv[0] ?? '', out) }
  const files = parseDiff(out.stdout)

  if (withUntracked) {
    const listed = await git($, root, ['ls-files', '--others', '--exclude-standard', '-z'])
    const paths = listed.stdout.split('\0').filter(p => p !== '')
    for (const path of paths.slice(0, MAX_UNTRACKED)) {
      const one = await git($, root, untrackedArgv(path))
      files.push(...parseDiff(one.stdout).map(f => ({ ...f, path, status: f.status === 'binary' ? f.status : ('added' as const) })))
    }
  }

  return { root, target, label, files }
}

/** The tab in view: the active one, or the first while the active id names none. */
async function shown($: $): Promise<ReviewTab | null> {
  const list = await read($, tabs)
  const id = await read($, active)

  return list.find(t => t.id === id) ?? list[0] ?? null
}

async function patch($: $, id: string, fn: (tab: ReviewTab) => ReviewTab): Promise<void> {
  await update($, tabs, list => list.map(t => (t.id === id ? fn(t) : t)))
}

function tabTitle(r: Review): string {
  const name = r.root.split('/').pop() || r.root

  return r.target === '' ? name : `${name} ${r.target}`
}

/** Opens the review of `target` in `cwd` as a tab: a new one, or the tab already on that repo and target, refreshed. */
async function openReview($: $, cwd: string, target: string): Promise<string> {
  const t = target.trim()
  const loaded = await loadReview($, cwd, t === 'uncommitted' || t === 'wt' ? '' : t)
  const isSame = (tab: ReviewTab) => tab.review.root === loaded.root && tab.review.target === loaded.target
  const fresh: ReviewTab = { id: crypto.randomUUID(), review: loaded, comments: [], fileIndex: 0 }
  await update($, tabs, list => (list.some(isSame) ? list.map(tab => (isSame(tab) ? { ...tab, review: loaded } : tab)) : [...list, fresh]))
  const list = await read($, tabs)
  const at = list.findIndex(isSame)
  const isTyping = (await read($, isOpen)) && (await read($, isEditing))
  if (!isTyping) await update($, active, () => list[at]?.id ?? '')
  await update($, isOpen, () => true)
  void $.ui.open({ id: PANE, title: 'Review', focus: true, closeOnEscape: true, columns: 120 })

  if (loaded.error) return `Could not load ${loaded.label}: ${loaded.error}`
  const where = list.length > 1 ? ` It is tab ${at + 1} of ${list.length} in the review pane${isTyping ? ', waiting behind the one the user is commenting on' : ''}.` : ''

  return `Opened review of ${loaded.label}: ${loaded.files.length} file(s).${where}`
}

async function refresh($: $): Promise<void> {
  const tab = await shown($)
  if (tab === null) return
  const loaded = await loadReview($, tab.review.root, tab.review.target)
  await patch($, tab.id, t => ({ ...t, review: loaded, fileIndex: Math.min(t.fileIndex, Math.max(0, loaded.files.length - 1)) }))
}

async function send($: $, mode: 'submit' | 'fill'): Promise<void> {
  const tab = await shown($)
  if (tab === null || tab.comments.length === 0) {
    $.ui.toast('No review comments to send yet')

    return
  }
  const count = tab.comments.length
  const text = buildPrompt(tab.review, tab.comments)
  if (mode === 'submit') await $.prompt.submit({ text, asUser: true })
  else await $.prompt.fill({ text, mode: 'append' })
  await patch($, tab.id, t => ({ ...t, comments: [] }))
  $.ui.toast(mode === 'submit' ? `Sent ${count} review comments to Claude` : `Put ${count} review comments in the prompt`)
}

/** Drops the tab in view with its unsent comments; the pane goes with the last one. */
async function closeTab($: $): Promise<void> {
  const tab = await shown($)
  if (tab === null) return
  const list = await read($, tabs)
  const rest = list.filter(t => t.id !== tab.id)
  const next = rest[Math.min(list.findIndex(t => t.id === tab.id), rest.length - 1)]
  await update($, tabs, l => l.filter(t => t.id !== tab.id))
  await update($, active, () => next?.id ?? '')
  if (tab.comments.length > 0) $.ui.toast(`Closed ${tabTitle(tab.review)} with ${tab.comments.length} unsent comment(s)`)
  if (next === undefined) await $.ui.close({ id: PANE })
  else await refresh($)
}

function parseArgs(args: string): { target: string; cwd?: string } {
  const tokens = args.trim().split(/\s+/).filter(t => t !== '')
  const cwdAt = tokens.indexOf('--cwd')
  if (cwdAt >= 0) {
    const cwd = tokens[cwdAt + 1]
    tokens.splice(cwdAt, 2)

    return { target: tokens.join(' '), cwd }
  }

  return { target: tokens.join(' ') }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'local-review',
      description: 'Review a local diff with inline comments: [staged | <commit> | <a>..<b> | branch[:<base>]] [--cwd <dir>]',
      argumentHint: '[staged|<commit>|<a>..<b>|branch[:<base>]] [--cwd <dir>]',
    })
    await $.tool.register({
      name: TOOL,
      description:
        "Open the user's local review pane on a diff so they can leave inline comments and suggestions, which arrive later as a prompt. Use it after finishing a change the user should review. Each repo and target gets its own tab, so several reviews (one per worktree, say) can be open at once; a repeat call refreshes its tab and keeps the comments. target: '' or 'uncommitted' (working tree vs HEAD, with untracked files), 'staged', a commit-ish, a range 'a..b', or 'branch' / 'branch:<base>' (merge-base with base, default origin/main, to the working tree). cwd: the repo or worktree directory, default the session's.",
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: "What to review; default 'uncommitted'." },
          cwd: { type: 'string', description: 'Repository or worktree directory, absolute.' },
        },
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('command.run', { command: 'local-review' }, async ($, e) => {
    const { target, cwd } = parseArgs(e.args)

    return { text: await openReview($, cwd ?? (await $.session.cwd()), target) }
  })

  on('tool.call', { tool: 'mcp__local-review__open_review' }, async ($, e) => {
    const target = typeof e.target === 'string' ? e.target : ''
    const cwd = typeof e.cwd === 'string' && e.cwd !== '' ? e.cwd : await $.session.cwd()

    return { result: `${await openReview($, cwd, target)} The user's comments will arrive as a later prompt; don't wait for them.` }
  })

  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const msg = e.data as ViewerMessage
    const tab = await shown($)

    if (msg.type === 'tab') {
      await update($, isEditing, () => false)
      await update($, active, () => msg.id)
      await refresh($)
    } else if (msg.type === 'closeTab') await closeTab($)
    else if (tab === null) return next(e)
    else if (msg.type === 'file') await patch($, tab.id, t => ({ ...t, fileIndex: msg.index }))
    else if (msg.type === 'add') {
      const comment = { ...msg.comment, id: crypto.randomUUID() } as ReviewComment
      await update($, isEditing, () => false)
      await patch($, tab.id, t => ({ ...t, comments: [...t.comments, comment] }))
    } else if (msg.type === 'delete') await patch($, tab.id, t => ({ ...t, comments: t.comments.filter(c => c.id !== msg.id) }))
    else if (msg.type === 'refresh') await refresh($)
    else if (msg.type === 'send') await send($, msg.mode)
    else if (msg.type === 'close') await $.ui.close({ id: PANE })
    else if (msg.type === 'editing') await update($, isEditing, () => msg.on)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (await read($, isOpen)) await refresh($)

    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person' && (await read($, isEditing))) {
      // Esc never reaches the viewer; its close while a comment is open cancels the comment instead.
      await update($, isEditing, () => false)
      await update($, cancelSeq, n => n + 1)

      return { value: undefined }
    }
    if (e.id === PANE) await update($, isOpen, () => false)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile' || e.surface === 'vscode') {
      const { Text } = $.ui.resolve(e)

      return <Text dimColor>The review pane needs the terminal or the desktop app.</Text>
    }
    const { Box, Text, Client } = $.ui.resolve(e)
    const tab = await shown($)

    if (tab === null) return <Text dimColor>No review open. Run /local-review.</Text>

    const current = tab.review
    const list = tab.comments
    const index = Math.min(tab.fileIndex, Math.max(0, current.files.length - 1))
    const file = current.files[index] ?? null
    const props: ViewerProps = {
      tab: tab.id,
      tabs: (await read($, tabs)).map(t => ({ id: t.id, title: tabTitle(t.review), comments: t.comments.length })),
      label: current.label,
      fileIndex: index,
      files: current.files.map(f => ({ path: f.path, status: f.status, comments: list.filter(c => c.path === f.path).length })),
      file: file === null ? null : capRows(file, FILE_PROPS_LIMIT),
      comments: file === null ? [] : list.filter(c => c.path === file.path),
      total: list.length,
      cancelSeq: await read($, cancelSeq),
      ...(current.error === undefined ? {} : { error: current.error }),
    }

    return (
      <Box flexDirection="column">
        <Client key="viewer" module="./viewer.tsx" props={props} height={Math.max(6, e.props.scroll.bodyRows)} />
      </Box>
    )
  })
}
