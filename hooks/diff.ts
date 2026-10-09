import type { FileDiff, Review, ReviewComment, Row } from '../types'

const FLAGS = ['--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/']

export type GitPlan =
  | { kind: 'diff'; argv: string[]; withUntracked: boolean; label: string }
  | { kind: 'branch'; base: string; label: string }
  | { kind: 'commit'; rev: string }

/** Maps a review target as typed (`staged`, `abc123`, `main..HEAD`, `branch:origin/main`) to the git call that produces it. */
export function planTarget(target: string): GitPlan {
  const t = target.trim()

  if (t === '' || t === 'uncommitted' || t === 'wt') {
    return { kind: 'diff', argv: ['diff', ...FLAGS, 'HEAD'], withUntracked: true, label: 'uncommitted changes' }
  }
  if (t === 'staged') {
    return { kind: 'diff', argv: ['diff', ...FLAGS, '--cached'], withUntracked: false, label: 'staged changes' }
  }
  if (t === 'branch' || t.startsWith('branch:')) {
    return { kind: 'branch', base: t.slice('branch:'.length) || '', label: 'branch' }
  }
  if (t.includes('..')) {
    return { kind: 'diff', argv: ['diff', ...FLAGS, t], withUntracked: false, label: t }
  }

  return { kind: 'commit', rev: t }
}

export function branchArgv(mergeBase: string): string[] {
  return ['diff', ...FLAGS, mergeBase]
}

export function commitArgv(rev: string): string[] {
  return ['show', ...FLAGS, '--format=', '--diff-merges=first-parent', rev]
}

export function untrackedArgv(path: string): string[] {
  return ['diff', ...FLAGS, '--no-index', '--', '/dev/null', path]
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '')
}

/** Parses `git diff`/`git show` output into files of display rows. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let o = 0
  let n = 0
  let inHunk = false

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      const next: FileDiff = { path: m?.[2] ?? line.slice(11), status: 'modified', rows: [] }
      files.push(next)
      file = next
      inHunk = false
      continue
    }
    if (file === null) continue

    if (!inHunk) {
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        file.oldPath = line.slice('rename from '.length)
        file.status = 'renamed'
      } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length)
      else if (line.startsWith('Binary files ')) {
        file.status = 'binary'
        file.rows.push({ k: 'note', t: 'Binary file' })
      } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = stripPrefix(line.slice(4))
    }

    const hunk = HUNK.exec(line)
    if (hunk) {
      o = Number(hunk[1])
      n = Number(hunk[2])
      inHunk = true
      file.rows.push({ k: 'hunk', t: line })
      continue
    }
    if (!inHunk) continue

    if (line.startsWith('+')) file.rows.push({ k: 'add', t: line.slice(1), n: n++ })
    else if (line.startsWith('-')) file.rows.push({ k: 'del', t: line.slice(1), o: o++ })
    else if (line.startsWith(' ')) file.rows.push({ k: 'ctx', t: line.slice(1), o: o++, n: n++ })
    else if (line.startsWith('\\')) continue
    else inHunk = false
  }

  return files
}

/** Whether a comment is anchored on this row. */
export function isOnRow(c: ReviewComment, path: string, row: Row): boolean {
  if (c.path !== path) return false
  if (c.side === 'new') return (row.k === 'add' || row.k === 'ctx') && row.n === c.line
  if (c.side === 'old') return row.k === 'del' && row.o === c.line

  return false
}

/** Keeps a file's rows under `limit` characters so the viewer's props stay within the Client bound. */
export function capRows(file: FileDiff, limit: number): FileDiff {
  let size = 0
  const rows: Row[] = []

  for (const row of file.rows) {
    size += row.t.length + 24
    if (size > limit) {
      rows.push({ k: 'note', t: `… ${file.rows.length - rows.length} more lines not shown (diff too large for the pane)` })

      return { ...file, rows }
    }
    rows.push(row)
  }

  return file
}

function inlineCode(code: string | undefined): string {
  const text = (code ?? '').trim()

  return text === '' ? '(blank line)' : '`' + text.replace(/`/g, 'ˋ') + '`'
}

function quote(text: string): string {
  return text
    .split('\n')
    .map(line => `  > ${line}`)
    .join('\n')
}

/** The prompt Claude receives: comments grouped by file, each citing its line and code. */
export function buildPrompt(review: Review, comments: ReviewComment[]): string {
  const byPath = new Map<string, ReviewComment[]>()
  for (const c of comments) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c])

  const sections = [...byPath.entries()].map(([path, list]) => {
    const sorted = [...list].sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    const items = sorted.map(c => {
      if (c.side === 'file') return `- **File**:\n${quote(c.text)}`

      const where = c.side === 'old' ? `L${c.line} (removed line)` : `L${c.line}`
      if (c.kind === 'suggest') {
        return `- **${where} suggestion**: replace ${inlineCode(c.code)} with:\n  \`\`\`\n${c.text
          .split('\n')
          .map(l => `  ${l}`)
          .join('\n')}\n  \`\`\``
      }

      return `- **${where}** ${inlineCode(c.code)}\n${quote(c.text)}`
    })

    return `### ${path}\n${items.join('\n')}`
  })

  return [
    `Review comments on ${review.label} (repo: ${review.root}).`,
    'Address each one. For a suggestion, apply the replacement unless you disagree, and then say why.',
    '',
    sections.join('\n\n'),
  ].join('\n')
}
