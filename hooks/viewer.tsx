import type { ClientKeyEvent, ClientModule, ClientSurface } from 'claude-code'

import type { ReviewComment, Row, ViewerMessage, ViewerProps } from '../types'
import { isOnRow } from './diff'

type Edit = { kind: 'comment' | 'suggest' | 'file'; row: number; text: string; pos: number }

type State = {
  fileIndex: number
  cursor: number
  top: number
  mode: 'diff' | 'files'
  fileCursor: number
  edit: Edit | null
  cancelSeq: number
}

type Line = { row: number } | { comment: ReviewComment }

const SPECIAL = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape',
])

const HINTS = 'j/k move  ]/[ file  f files  c comment  C file  s suggest  x delete  r refresh  S send  P to prompt  q close'

function initial(props: ViewerProps): State {
  return { fileIndex: props.fileIndex, cursor: 0, top: 0, mode: 'diff', fileCursor: props.fileIndex, edit: null, cancelSeq: props.cancelSeq }
}

function lines(props: ViewerProps): Line[] {
  const file = props.file
  if (file === null) return []
  const out: Line[] = props.comments.filter(c => c.side === 'file').map(comment => ({ comment }))
  file.rows.forEach((row, i) => {
    out.push({ row: i })
    for (const comment of props.comments) if (isOnRow(comment, file.path, row)) out.push({ comment })
  })

  return out
}

function lineOf(all: Line[], row: number): number {
  const at = all.findIndex(l => 'row' in l && l.row === row)

  return at < 0 ? 0 : at
}

function isCodeRow(row: Row | undefined): row is Row {
  return row !== undefined && (row.k === 'add' || row.k === 'ctx' || row.k === 'del')
}

function pad(n: number | undefined, width: number): string {
  return (n === undefined ? '' : String(n)).padStart(width)
}

const Viewer: ClientModule<ViewerProps, State> = (props, surface: ClientSurface<State>) => {
  const { Box, Text } = surface.elements
  const s0 = surface.state
  const rowCount = props.file?.rows.length ?? 0
  const base = s0 !== undefined && s0.fileIndex === props.fileIndex ? s0 : initial(props)
  const s: State = {
    ...base,
    cursor: Math.min(base.cursor, Math.max(0, rowCount - 1)),
    edit: base.cancelSeq === props.cancelSeq ? base.edit : null,
    cancelSeq: props.cancelSeq,
  }
  const all = lines(props)
  const height = surface.rows > 0 ? surface.rows : 20
  const bodyRows = Math.max(1, height - 3)

  const post = (msg: ViewerMessage) => surface.post(msg)

  const scrolled = (next: State): State => {
    const at = lineOf(all, next.cursor)
    let top = next.top
    if (at < top) top = at
    if (at >= top + bodyRows) top = at - bodyRows + 1
    if (next.cursor === 0) top = 0

    return { ...next, top: Math.max(0, top) }
  }

  const move = (delta: number) => {
    const cursor = Math.max(0, Math.min(rowCount - 1, s.cursor + delta))
    surface.setState(scrolled({ ...s, cursor }))
  }

  const startEdit = (kind: Edit['kind']) => {
    const row = props.file?.rows[s.cursor]
    if (kind !== 'file' && !isCodeRow(row)) return
    const text = kind === 'suggest' && row !== undefined ? row.t : ''
    surface.setState({ ...s, edit: { kind, row: s.cursor, text, pos: text.length } })
    post({ type: 'editing', on: true })
  }

  const commit = (edit: Edit) => {
    const file = props.file
    if (file === null || edit.text.trim() === '') return
    if (edit.kind === 'file') {
      post({ type: 'add', comment: { path: file.path, side: 'file', kind: 'comment', text: edit.text } })

      return
    }
    const row = file.rows[edit.row]
    if (!isCodeRow(row)) return
    const side = row.k === 'del' ? 'old' : 'new'
    const line = row.k === 'del' ? row.o : row.n
    post({ type: 'add', comment: { path: file.path, side, line, code: row.t, kind: edit.kind, text: edit.text } })
  }

  const onEditKey = (edit: Edit, key: ClientKeyEvent) => {
    const set = (next: Edit | null) => surface.setState({ ...s, edit: next })
    const cancel = () => {
      set(null)
      post({ type: 'editing', on: false })
    }
    const { text, pos } = edit

    if (key.key === 'return' || key.key === 'enter') {
      if (edit.text.trim() === '') cancel()
      else {
        commit(edit)
        set(null)
      }
    } else if (key.ctrl && (key.key === 'c' || key.key === 'g')) cancel()
    else if (key.ctrl && key.key === 'u') set({ ...edit, text: '', pos: 0 })
    else if (key.key === 'home' || (key.ctrl && key.key === 'a')) set({ ...edit, pos: 0 })
    else if (key.key === 'end' || (key.ctrl && key.key === 'e')) set({ ...edit, pos: text.length })
    else if (key.key === 'left') set({ ...edit, pos: Math.max(0, pos - 1) })
    else if (key.key === 'right') set({ ...edit, pos: Math.min(text.length, pos + 1) })
    else if (key.key === 'backspace' && pos > 0) set({ ...edit, text: text.slice(0, pos - 1) + text.slice(pos), pos: pos - 1 })
    else if (key.key === 'delete' && pos < text.length) set({ ...edit, text: text.slice(0, pos) + text.slice(pos + 1) })
    else if (!key.ctrl && !key.meta && (key.key === 'space' || !SPECIAL.has(key.key))) {
      const typed = key.key === 'space' ? ' ' : key.key
      set({ ...edit, text: text.slice(0, pos) + typed + text.slice(pos), pos: pos + typed.length })
    }
  }

  const onFilesKey = (key: ClientKeyEvent) => {
    const last = props.files.length - 1
    if (key.key === 'j' || key.key === 'down') surface.setState({ ...s, fileCursor: Math.min(last, s.fileCursor + 1) })
    else if (key.key === 'k' || key.key === 'up') surface.setState({ ...s, fileCursor: Math.max(0, s.fileCursor - 1) })
    else if (key.key === 'return' || key.key === 'enter') {
      surface.setState({ ...s, mode: 'diff' })
      post({ type: 'file', index: s.fileCursor })
    } else if (key.key === 'f' || key.key === 'q') surface.setState({ ...s, mode: 'diff' })
  }

  const onDiffKey = (key: ClientKeyEvent) => {
    const half = Math.max(1, Math.floor(bodyRows / 2))
    const k = key.key

    if (k === 'j' || k === 'down') move(1)
    else if (k === 'k' || k === 'up') move(-1)
    else if (k === 'pagedown' || k === 'space' || k === ' ' || (key.ctrl && k === 'd')) move(half)
    else if (k === 'pageup' || (key.ctrl && k === 'u')) move(-half)
    else if (k === 'g' || k === 'home') move(-rowCount)
    else if (k === 'G' || k === 'end') move(rowCount)
    else if ((k === ']' || k === 'n') && props.fileIndex < props.files.length - 1) post({ type: 'file', index: props.fileIndex + 1 })
    else if ((k === '[' || k === 'p') && props.fileIndex > 0) post({ type: 'file', index: props.fileIndex - 1 })
    else if (k === 'f') surface.setState({ ...s, mode: 'files', fileCursor: props.fileIndex })
    else if (k === 'c') startEdit('comment')
    else if (k === 'C') startEdit('file')
    else if (k === 's') startEdit('suggest')
    else if (k === 'x') {
      const row = props.file?.rows[s.cursor]
      const path = props.file?.path ?? ''
      const onRow = row === undefined ? [] : props.comments.filter(c => isOnRow(c, path, row))
      const target = onRow[onRow.length - 1] ?? (s.cursor === 0 ? props.comments.find(c => c.side === 'file') : undefined)
      if (target !== undefined) post({ type: 'delete', id: target.id })
    } else if (k === 'r') post({ type: 'refresh' })
    else if (k === 'S') post({ type: 'send', mode: 'submit' })
    else if (k === 'P') post({ type: 'send', mode: 'fill' })
    else if (k === 'q') post({ type: 'close' })
  }

  surface.onKey(key => {
    if (s.edit !== null) onEditKey(s.edit, key)
    else if (s.mode === 'files') onFilesKey(key)
    else onDiffKey(key)
  })

  const header = (
    <Text bold wrap="truncate-end">
      {props.file === null
        ? props.label
        : `${props.file.path}  (${props.file.status}${props.file.oldPath ? ` from ${props.file.oldPath}` : ''}) · file ${props.fileIndex + 1}/${props.files.length}`}
    </Text>
  )

  const footer = (
    <Box flexDirection="column">
      {s.edit !== null ? (
        <Text wrap="truncate-start">
          <Text color="claude">{s.edit.kind === 'suggest' ? 'suggest> ' : s.edit.kind === 'file' ? 'file comment> ' : 'comment> '}</Text>
          {s.edit.text.slice(0, s.edit.pos)}
          <Text inverse>{s.edit.text[s.edit.pos] ?? ' '}</Text>
          {s.edit.text.slice(s.edit.pos + 1)}
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {props.total} comment(s) · {props.label} · click here to use keys
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {s.edit !== null ? 'enter save · esc cancel · ctrl+u clear' : s.mode === 'files' ? 'j/k move · enter open · f back' : HINTS}
      </Text>
    </Box>
  )

  if (props.error !== undefined) {
    return (
      <Box flexDirection="column">
        <Text color="error">{props.error}</Text>
        {footer}
      </Box>
    )
  }

  if (s.mode === 'files') {
    const top = Math.max(0, Math.min(s.fileCursor - Math.floor(bodyRows / 2), props.files.length - bodyRows))

    return (
      <Box flexDirection="column" height={height}>
        <Text bold>{props.files.length} files · {props.label}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {props.files.slice(top, top + bodyRows).map((f, i) => (
            <Text inverse={top + i === s.fileCursor} wrap="truncate-end">
              {top + i === props.fileIndex ? '▸ ' : '  '}
              {f.path} <Text dimColor>{f.status}</Text>
              {f.comments > 0 ? <Text color="claude"> ● {f.comments}</Text> : ''}
            </Text>
          ))}
        </Box>
        {footer}
      </Box>
    )
  }

  if (props.file === null) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>No changes in {props.label}.</Text>
        <Box flexGrow={1} />
        {footer}
      </Box>
    )
  }

  const file = props.file
  const width = String(file.rows.reduce((m, r) => Math.max(m, r.o ?? 0, r.n ?? 0), 0)).length
  const at = lineOf(all, s.cursor)
  const top = Math.max(0, at >= Math.min(s.top, at) + bodyRows ? at - bodyRows + 1 : Math.min(s.top, at))

  return (
    <Box flexDirection="column" height={height}>
      {header}
      <Box flexDirection="column" flexGrow={1}>
        {all.slice(top, top + bodyRows).map(line => {
          if ('comment' in line) {
            const c = line.comment

            return (
              <Text color="claude" wrap="truncate-end">
                {' '.repeat(width * 2 + 2)}
                {c.side === 'file' ? '◆ file: ' : c.kind === 'suggest' ? '◆ suggest: ' : '◆ '}
                {c.text}
              </Text>
            )
          }
          const row = file.rows[line.row]
          if (row === undefined) return <Text> </Text>
          const isCursor = line.row === s.cursor
          const hasComment = props.comments.some(c => isOnRow(c, file.path, row))
          const sign = row.k === 'add' ? '+' : row.k === 'del' ? '-' : ' '
          const bg = row.k === 'add' ? 'diffAdded' : row.k === 'del' ? 'diffRemoved' : undefined

          if (row.k === 'hunk' || row.k === 'note') {
            return (
              <Text color="suggestion" dimColor={!isCursor} inverse={isCursor} wrap="truncate-end">
                {row.t}
              </Text>
            )
          }

          return (
            <Text backgroundColor={bg} inverse={isCursor} wrap="truncate-end">
              <Text dimColor>
                {pad(row.o, width)} {pad(row.n, width)}
              </Text>
              {hasComment ? <Text color="claude">●</Text> : ' '}
              {sign}
              {row.t}
            </Text>
          )
        })}
      </Box>
      {footer}
    </Box>
  )
}

export default Viewer
