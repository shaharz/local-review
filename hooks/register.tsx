import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Review, ReviewComment, ViewerMessage, ViewerProps } from '../types'
import { branchArgv, buildPrompt, capRows, commitArgv, parseDiff, planTarget, untrackedArgv } from './diff'

const PANE = 'local-review'
const TOOL = 'open_review'
const MAX_UNTRACKED = 100
const FILE_PROPS_LIMIT = 70_000

const review = atom({ plugin: 'local-review', key: 'review' } as const, null)
const comments = atom({ plugin: 'local-review', key: 'comments' } as const, [])
const fileIndex = atom({ plugin: 'local-review', key: 'fileIndex' } as const, 0)
const isOpen = atom({ plugin: 'local-review', key: 'isOpen' } as const, false)
const isEditing = atom({ plugin: 'local-review', key: 'isEditing' } as const, false)
const cancelSeq = atom({ plugin: 'local-review', key: 'cancelSeq' } as const, 0)

type $ = EngineInterface

async function git($: $, cwd: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return $.process.run(['git', ...argv], { cwd, timeoutMs: 60_000 })
}

async function loadReview($: $, cwd: string, target: string): Promise<Review> {
  const top = await git($, cwd, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) {
    return { root: cwd, target, label: target || 'uncommitted changes', files: [], error: top.stderr.trim() }
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
      return { root, target, label: `branch vs ${base}`, files: [], error: mb.stderr.trim() }
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
  if (out.exitCode !== 0) return { root, target, label, files: [], error: out.stderr.trim() }
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

async function openReview($: $, cwd: string, target: string): Promise<Review> {
  const loaded = await loadReview($, cwd, target)
  const previous = await read($, review)
  const isSame = previous !== null && previous.root === loaded.root && previous.target === loaded.target
  await update($, review, () => loaded)
  if (!isSame) {
    await update($, comments, () => [])
    await update($, fileIndex, () => 0)
  }
  await update($, isOpen, () => true)
  void $.ui.open({ id: PANE, title: 'Review', focus: true, closeOnEscape: true, columns: 120 })

  return loaded
}

async function refresh($: $): Promise<void> {
  const current = await read($, review)
  if (current === null) return
  const loaded = await loadReview($, current.root, current.target)
  await update($, review, () => loaded)
  await update($, fileIndex, i => Math.min(i, Math.max(0, loaded.files.length - 1)))
}

async function send($: $, mode: 'submit' | 'fill'): Promise<void> {
  const current = await read($, review)
  const list = await read($, comments)
  if (current === null || list.length === 0) {
    $.ui.toast('No review comments to send yet')

    return
  }
  const text = buildPrompt(current, list)
  if (mode === 'submit') await $.prompt.submit({ text, asUser: true })
  else await $.prompt.fill({ text, mode: 'append' })
  await update($, comments, () => [])
  $.ui.toast(mode === 'submit' ? `Sent ${list.length} review comments to Claude` : `Put ${list.length} review comments in the prompt`)
}

function summary(r: Review): string {
  if (r.error) return `Could not load ${r.label}: ${r.error}`

  return `Opened review of ${r.label}: ${r.files.length} file(s).`
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
        "Open the user's local review pane on a diff so they can leave inline comments and suggestions, which arrive later as a prompt. Use it after finishing a change the user should review. target: '' or 'uncommitted' (working tree vs HEAD, with untracked files), 'staged', a commit-ish, a range 'a..b', or 'branch' / 'branch:<base>' (merge-base with base, default origin/main, to the working tree). cwd: the repo or worktree directory, default the session's.",
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
    const loaded = await openReview($, cwd ?? (await $.session.cwd()), target)

    return { text: summary(loaded) }
  })

  on('tool.call', { tool: 'mcp__local-review__open_review' }, async ($, e) => {
    const target = typeof e.target === 'string' ? e.target : ''
    const cwd = typeof e.cwd === 'string' && e.cwd !== '' ? e.cwd : await $.session.cwd()
    const loaded = await openReview($, cwd, target)

    return { result: `${summary(loaded)} The user's comments will arrive as a later prompt; don't wait for them.` }
  })

  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const msg = e.data as ViewerMessage

    if (msg.type === 'file') await update($, fileIndex, () => msg.index)
    else if (msg.type === 'add') {
      const id = crypto.randomUUID()
      await update($, isEditing, () => false)
      await update($, comments, list => [...list, { ...msg.comment, id } as ReviewComment])
    } else if (msg.type === 'delete') await update($, comments, list => list.filter(c => c.id !== msg.id))
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
    const current = await read($, review)

    if (current === null) return <Text dimColor>No review open. Run /local-review.</Text>

    const list = await read($, comments)
    const index = Math.min(await read($, fileIndex), Math.max(0, current.files.length - 1))
    const file = current.files[index] ?? null
    const props: ViewerProps = {
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
