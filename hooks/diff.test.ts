import { describe, expect, test } from 'claude-code/testing'

import { buildPrompt, isOnRow, parseDiff, planTarget } from './diff'

const DIFF = [
  'diff --git a/lib/a.ex b/lib/a.ex',
  'index 1..2 100644',
  '--- a/lib/a.ex',
  '+++ b/lib/a.ex',
  '@@ -10,3 +10,3 @@ defmodule A do',
  '   def x, do: 1',
  '-  def y, do: 2',
  '+  def y, do: 3',
  '   def z, do: 4',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+hello',
  '\\ No newline at end of file',
  'diff --git a/old.ex b/renamed.ex',
  'similarity index 100%',
  'rename from old.ex',
  'rename to renamed.ex',
  '',
].join('\n')

describe('parseDiff', () => {
  test('reads files, statuses and line numbers', () => {
    const [a, added, renamed] = parseDiff(DIFF)
    expect(a).toEqual({
      path: 'lib/a.ex',
      status: 'modified',
      rows: [
        { k: 'hunk', t: '@@ -10,3 +10,3 @@ defmodule A do' },
        { k: 'ctx', t: '  def x, do: 1', o: 10, n: 10 },
        { k: 'del', t: '  def y, do: 2', o: 11 },
        { k: 'add', t: '  def y, do: 3', n: 11 },
        { k: 'ctx', t: '  def z, do: 4', o: 12, n: 12 },
      ],
    })
    expect(added).toEqual({ path: 'new.txt', status: 'added', rows: [{ k: 'hunk', t: '@@ -0,0 +1 @@' }, { k: 'add', t: 'hello', n: 1 }] })
    expect(renamed).toEqual({ path: 'renamed.ex', oldPath: 'old.ex', status: 'renamed', rows: [] })
  })
})

describe('planTarget', () => {
  test('maps each target form', () => {
    expect(planTarget('')).toMatchObject({ kind: 'diff', withUntracked: true })
    expect(planTarget('staged')).toMatchObject({ kind: 'diff', withUntracked: false, label: 'staged changes' })
    expect(planTarget('branch:origin/dev')).toEqual({ kind: 'branch', base: 'origin/dev', label: 'branch' })
    expect(planTarget('main..HEAD')).toMatchObject({ kind: 'diff', label: 'main..HEAD' })
    expect(planTarget('abc123')).toEqual({ kind: 'commit', rev: 'abc123' })
  })
})

describe('buildPrompt', () => {
  test('groups comments by file with line, code and suggestion', () => {
    const review = { root: '/repo', target: '', label: 'uncommitted changes in repo', files: [] }
    const text = buildPrompt(review, [
      { id: '1', path: 'lib/a.ex', side: 'new', line: 11, code: '  def y, do: 3', kind: 'comment', text: 'why 3?' },
      { id: '2', path: 'lib/a.ex', side: 'old', line: 11, code: '  def y, do: 2', kind: 'comment', text: 'keep this' },
      { id: '3', path: 'lib/b.ex', side: 'new', line: 4, code: 'x = 1', kind: 'suggest', text: 'x = 2' },
      { id: '4', path: 'lib/b.ex', side: 'file', kind: 'comment', text: 'split this file' },
    ])
    expect(text).toContain('Review comments on uncommitted changes in repo (repo: /repo).')
    expect(text).toContain('### lib/a.ex\n- **L11** `def y, do: 3`\n  > why 3?')
    expect(text).toContain('- **L11 (removed line)** `def y, do: 2`\n  > keep this')
    expect(text).toContain('- **L4 suggestion**: replace `x = 1` with:\n  ```\n  x = 2\n  ```')
    expect(text).toContain('- **File**:\n  > split this file')
  })
})

describe('isOnRow', () => {
  test('anchors new-side comments on added and context rows, old-side on removed rows', () => {
    const c = { id: '1', path: 'a', side: 'new' as const, line: 5, kind: 'comment' as const, text: '' }
    expect(isOnRow(c, 'a', { k: 'add', t: '', n: 5 })).toBe(true)
    expect(isOnRow(c, 'a', { k: 'del', t: '', o: 5 })).toBe(false)
    expect(isOnRow({ ...c, side: 'old' }, 'a', { k: 'del', t: '', o: 5 })).toBe(true)
    expect(isOnRow(c, 'b', { k: 'add', t: '', n: 5 })).toBe(false)
  })
})
