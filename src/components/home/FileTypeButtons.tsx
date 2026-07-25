import { Presentation, FileText, FileType, Sheet } from 'lucide-react'

const fileTypes = [
  { label: 'Slides', icon: Presentation },
  { label: 'PDF', icon: FileType },
  { label: 'Docs', icon: FileText },
  { label: 'Excel', icon: Sheet },
] as const

export function FileTypeButtons() {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
      {fileTypes.map(({ label, icon: Icon }) => (
        <button
          key={label}
          type="button"
          className="hover:bg-accent text-muted-foreground hover:text-foreground border-border/60 bg-card/40 inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-[13px] transition-colors"
        >
          <Icon className="size-3.5" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}
