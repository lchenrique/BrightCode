import type { Project } from './store'

export type ProjectOpenTarget = 'vscode' | 'folder' | 'reveal'

export async function runProjectOpenAction(
  project: Project,
  target: ProjectOpenTarget,
  onError?: (message: string) => void,
): Promise<void> {
  const api = window.electronAPI?.workspace
  if (!api) {
    onError?.('Project shortcuts are available in the desktop app.')
    return
  }

  try {
    const result = await api.openProject(project.id, target)
    if (!result.ok) onError?.(result.error)
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error))
  }
}
