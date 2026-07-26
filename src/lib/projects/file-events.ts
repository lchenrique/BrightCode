export const PROJECT_FILES_CHANGED_EVENT = 'brightcode:project-files-changed'

export type ProjectFilesChangedDetail = {
  projectId: string
  path?: string
}

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
