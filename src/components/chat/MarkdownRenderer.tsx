import { useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, Terminal, Code2 } from 'lucide-react'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || '')
          const language = match ? match[1] : ''
          const codeString = String(children).replace(/\n$/, '')

          if (!inline && (match || codeString.includes('\n'))) {
            return (
              <CodeBlock
                language={language || 'code'}
                code={codeString}
              />
            )
          }

          return (
            <code
              className="bg-muted/80 text-foreground font-mono text-[12.5px] px-1.5 py-0.5 rounded border border-border/40 font-semibold"
              {...props}
            >
              {children}
            </code>
          )
        },
        h1({ children }) {
          return <h1 className="text-base font-bold text-foreground mt-4 mb-2 pb-1 border-b border-border/40">{children}</h1>
        },
        h2({ children }) {
          return <h2 className="text-[15px] font-bold text-foreground mt-3.5 mb-1.5 pb-0.5 border-b border-border/30">{children}</h2>
        },
        h3({ children }) {
          return <h3 className="text-[14px] font-semibold text-foreground mt-3 mb-1">{children}</h3>
        },
        p({ children }) {
          return <p className="mb-2 leading-relaxed text-foreground/90 last:mb-0">{children}</p>
        },
        ul({ children }) {
          return <ul className="list-disc list-inside mb-3 space-y-1 text-foreground/90 pl-1">{children}</ul>
        },
        ol({ children }) {
          return <ol className="list-decimal list-inside mb-3 space-y-1 text-foreground/90 pl-1">{children}</ol>
        },
        li({ children }) {
          return <li className="leading-normal">{children}</li>
        },
        blockquote({ children }) {
          return (
            <blockquote className="border-l-2 border-primary/60 bg-muted/30 pl-3 py-1 my-2 italic text-muted-foreground rounded-r">
              {children}
            </blockquote>
          )
        },
        table({ children }) {
          return (
            <div className="my-3 overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full text-left text-[13px]">{children}</table>
            </div>
          )
        },
        thead({ children }) {
          return <thead className="bg-muted/60 text-foreground font-medium border-b border-border/50">{children}</thead>
        },
        th({ children }) {
          return <th className="px-3 py-2 font-semibold">{children}</th>
        },
        td({ children }) {
          return <td className="px-3 py-2 border-t border-border/30">{children}</td>
        },
        a({ href, children }) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
            >
              {children}
            </a>
          )
        },
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const highlightedHtml = useMemo(() => {
    if (language && language !== 'code' && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value
      } catch {
        // fallback to auto
      }
    }
    try {
      return hljs.highlightAuto(code).value
    } catch {
      return null
    }
  }, [code, language])

  const isTerminal =
    language === 'bash' ||
    language === 'sh' ||
    language === 'zsh' ||
    language === 'powershell' ||
    language === 'cmd'

  return (
    <div className="my-3.5 rounded-lg border border-border/60 bg-card/90 overflow-hidden text-[13px] font-mono shadow-sm">
      {/* Header bar */}
      <div className="flex items-center justify-between bg-muted/50 px-3.5 py-1.5 text-[11.5px] border-b border-border/40 text-muted-foreground select-none">
        <div className="flex items-center gap-1.5 font-medium">
          {isTerminal ? (
            <Terminal className="size-3.5 text-primary" />
          ) : (
            <Code2 className="size-3.5 text-muted-foreground" />
          )}
          <span className="uppercase tracking-wider font-sans text-[11px] font-bold text-foreground/80">
            {language}
          </span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-foreground hover:bg-accent/60 px-2 py-0.5 rounded transition-colors text-[11px] cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="size-3 text-emerald-500" />
              <span className="text-emerald-500 font-sans font-medium">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="size-3" />
              <span className="font-sans">Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code content */}
      <div className="p-3.5 overflow-x-auto leading-relaxed bg-[#0d1117] text-foreground/90 selection:bg-primary/30">
        {highlightedHtml ? (
          <pre
            className="m-0 font-mono text-[12.5px] whitespace-pre leading-relaxed hljs"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre className="m-0 font-mono text-[12.5px] whitespace-pre leading-relaxed">{code}</pre>
        )}
      </div>
    </div>
  )
}
