export type RowKind = 'hunk' | 'ctx' | 'add' | 'del' | 'note'

export type Row = { k: RowKind; t: string; o?: number; n?: number }

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary'

export type FileDiff = {
  path: string
  oldPath?: string
  status: FileStatus
  rows: Row[]
}

export type Anchor = {
  path: string
  side: 'new' | 'old' | 'file'
  line?: number
  code?: string
}

export type ReviewComment = Anchor & {
  id: string
  kind: 'comment' | 'suggest'
  text: string
}

export type Review = {
  root: string
  target: string
  label: string
  files: FileDiff[]
  error?: string
}

export type ViewerFile = { path: string; status: FileStatus; comments: number }

export type ViewerProps = {
  label: string
  fileIndex: number
  files: ViewerFile[]
  file: FileDiff | null
  comments: ReviewComment[]
  total: number
  cancelSeq: number
  error?: string
}

export type ViewerMessage =
  | { type: 'file'; index: number }
  | { type: 'add'; comment: Omit<ReviewComment, 'id'> }
  | { type: 'delete'; id: string }
  | { type: 'refresh' }
  | { type: 'send'; mode: 'submit' | 'fill' }
  | { type: 'close' }
  | { type: 'editing'; on: boolean }

declare module 'claude-code' {
  interface PluginState {
    'local-review': {
      review: Review | null
      comments: ReviewComment[]
      fileIndex: number
      isOpen: boolean
      isEditing: boolean
      cancelSeq: number
    }
  }
}
