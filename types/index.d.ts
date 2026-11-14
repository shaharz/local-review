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

/** One open review: a repo and target, with the comments not yet sent and the file in view. */
export type ReviewTab = {
  id: string
  review: Review
  comments: ReviewComment[]
  fileIndex: number
}

export type ViewerFile = { path: string; status: FileStatus; comments: number }

export type ViewerTab = { id: string; title: string; comments: number }

export type ViewerProps = {
  tab: string
  tabs: ViewerTab[]
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
  | { type: 'tab'; id: string }
  | { type: 'closeTab' }

declare module 'claude-code' {
  interface PluginState {
    'local-review': {
      tabs: ReviewTab[]
      active: string
      isOpen: boolean
      isEditing: boolean
      cancelSeq: number
    }
  }
}
