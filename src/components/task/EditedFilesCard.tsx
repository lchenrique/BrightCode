import { useState } from 'react'
import { FileCode2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type EditedFile = {
  path: string
  added: number
  removed: number
}

const demoFiles: readonly EditedFile[] = [
  { path: 'D:/projetos pessoais/Polytron/src/components/Dashboard/SalesChart.tsx', added: 8, removed: 6 },
  { path: 'D:/projetos pessoais/Polytron/src/hooks/usePolytronData.ts', added: 24, removed: 12 },
  { path: 'D:/projetos pessoais/Polytron/src/lib/formatters.ts', added: 31, removed: 18 },
  { path: 'D:/projetos pessoais/Polytron/src/pages/Reports.tsx', added: 5, removed: 4 },
  { path: 'D:/projetos pessoais/Polytron/src/styles/report.css', added: 4, removed: 6 },
] as const

const visibleCount = 3

function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex items-center gap-1.5 text-[12px] font-medium tabular-nums">
      <span className="text-emerald-400">+{added}</span>
      <span className="text-red-400">-{removed}</span>
    </span>
  )
}

export function EditedFilesCard({ files }: { files?: EditedFile[] }) {
  const [expanded, setExpanded] = useState(false)
  const editedFiles = files && files.length > 0 ? files : demoFiles
  const totalAdded = editedFiles.reduce((sum, f) => sum + f.added, 0)
  const totalRemoved = editedFiles.reduce((sum, f) => sum + f.removed, 0)
  const shown = expanded ? editedFiles : editedFiles.slice(0, visibleCount)
  const hiddenCount = Math.max(0, editedFiles.length - visibleCount)
  const isDemo = !files || files.length === 0

  return (
    <div className="bg-card ring-border/40 overflow-hidden rounded-xl ring-1">
      {/* Header */}
      <div className="border-border/40 flex items-center gap-3 border-b px-4 py-3">
        <span className="bg-secondary flex size-8 shrink-0 items-center justify-center rounded-full">
          <FileCode2 className="text-foreground/80 size-4" />
        </span>
        <span className="flex-1 text-[13px] font-semibold">
          {isDemo ? 'No edits yet' : `Edited ${editedFiles.length} file${editedFiles.length === 1 ? '' : 's'}`}
        </span>
        {!isDemo && <DiffStat added={totalAdded} removed={totalRemoved} />}
        {!isDemo && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-7 px-2 text-[12px]"
              onClick={() => console.log('[files] undo')}
            >
              <Undo2 className="size-3.5" />
              Undo
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-border/60 h-7 px-3 text-[12px]"
              onClick={() => console.log('[files] review')}
            >
              Review
            </Button>
          </>
        )}
      </div>

      {/* File rows */}
      {editedFiles.length > 0 && (
        <ul className="px-4 py-1.5">
          {shown.map((file) => (
            <li
              key={file.path}
              className="flex items-center gap-3 py-1.5 text-[12px]"
            >
              <span
                className="text-muted-foreground min-w-0 flex-1 truncate font-mono"
                title={file.path}
              >
                {file.path}
              </span>
              <DiffStat added={file.added} removed={file.removed} />
            </li>
          ))}
        </ul>
      )}

      {/* Expand row */}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className={cn(
            'text-muted-foreground hover:text-foreground w-full py-2 text-center text-[12px] transition-colors',
            'border-border/40 border-t',
          )}
        >
          {expanded ? 'Show less' : `Show ${hiddenCount} more`}
        </button>
      )}
    </div>
  )
}
