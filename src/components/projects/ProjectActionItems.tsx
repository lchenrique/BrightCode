import { Code2, Copy, FolderOpen, FolderSearch2 } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { runProjectOpenAction } from '@/lib/projects/open-project'
import type { Project } from '@/lib/projects/store'

export function ProjectActionItems({
  project,
  onError,
}: {
  project: Project
  onError?: (message: string) => void
}) {
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(project.path)
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <>
      <DropdownMenuItem
        onSelect={() => void runProjectOpenAction(project, 'vscode', onError)}
      >
        <Code2 />
        Open in VS Code
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => void runProjectOpenAction(project, 'folder', onError)}
      >
        <FolderOpen />
        Open project folder
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => void runProjectOpenAction(project, 'reveal', onError)}
      >
        <FolderSearch2 />
        Show in File Explorer
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => void copyPath()}>
        <Copy />
        Copy project path
      </DropdownMenuItem>
    </>
  )
}
