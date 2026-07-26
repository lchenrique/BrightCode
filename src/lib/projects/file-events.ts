export const PROJECT_FILES_CHANGED_EVENT = 'brightcode:project-files-changed'
export const OPEN_PROJECT_FILE_EVENT = 'brightcode:open-project-file'

export type ProjectFilesChangedDetail = {
  projectId: string
  path?: string
}

export type OpenProjectFileDetail = {
  projectId: string
  path: string
  name: string
}

let pendingFileOpen: OpenProjectFileDetail | null = null

export function notifyProjectFilesChanged(
  projectId: string,
  path?: string,
): void {
  window.dispatchEvent(
    new CustomEvent<ProjectFilesChangedDetail>(PROJECT_FILES_CHANGED_EVENT, {
      detail: { projectId, path },
    }),
  )
}

export function requestProjectFileOpen(detail: OpenProjectFileDetail): void {
  pendingFileOpen = detail
  window.dispatchEvent(
    new CustomEvent<OpenProjectFileDetail>(OPEN_PROJECT_FILE_EVENT, {
      detail,
    }),
  )
}

export function consumePendingProjectFileOpen(
  projectId: string,
): OpenProjectFileDetail | null {
  if (pendingFileOpen?.projectId !== projectId) return null
  const pending = pendingFileOpen
  pendingFileOpen = null
  return pending
}
