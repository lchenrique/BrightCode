import { Presentation, FileText, FileType, Sheet } from 'lucide-react'

const fileTypes = [
  { label: 'Slides', icon: Presentation },
  { label: 'PDF', icon: FileType },
  { label: 'Docs', icon: FileText },
  { label: 'Excel', icon: Sheet },
] as const

export function FileTypeButtons() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {fileTypes.map(({ label, icon: Icon }) => (
        <button
          key={label}
          type="button"
          className="hover:bg-accent/60 text-muted-foreground hover:text-foreground border-border/50 inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] transition-colors"
        >
          <Icon className="size-3.5" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}
