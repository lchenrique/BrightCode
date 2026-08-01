import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker'

type MonacoEnvironmentShape = {
  getWorker: (_moduleId: string, label: string) => Worker
}

;(globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironmentShape })
  .MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new HtmlWorker()
    }
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker()
    return new EditorWorker()
  },
}

export interface EditorFile {
  path: string
  content: string
  language: string
}

export function CodeEditor({
  file,
  visible = true,
  readOnly = false,
  onChange,
  onSave,
}: {
  file: EditorFile
  visible?: boolean
  readOnly?: boolean
  onChange: (content: string) => void
  onSave: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const fileRef = useRef(file)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const readOnlyRef = useRef(readOnly)
  const ownedModelsRef = useRef(new Set<monaco.editor.ITextModel>())

  fileRef.current = file
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  readOnlyRef.current = readOnly

  useEffect(() => {
    if (!containerRef.current) return
    const ownedModels = ownedModelsRef.current

    const editor = monaco.editor.create(containerRef.current, {
      automaticLayout: true,
      fontFamily: 'DM Mono, Consolas, "Courier New", monospace',
      fontLigatures: true,
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: true, scale: 0.8 },
      padding: { top: 12, bottom: 12 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      wordWrap: document.documentElement.dataset.wordWrap === 'true' ? 'on' : 'off',
      readOnly: readOnlyRef.current,
      theme: document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
    })
    editorRef.current = editor

    const changeSubscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue())
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current()
    })

    const themeObserver = new MutationObserver(() => {
      monaco.editor.setTheme(
        document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
      )
      const wrap = document.documentElement.dataset.wordWrap === 'true' ? 'on' : 'off'
      if (editor.getOption(monaco.editor.EditorOption.wordWrap) !== wrap) {
        editor.updateOptions({ wordWrap: wrap })
      }
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    })

    return () => {
      themeObserver.disconnect()
      changeSubscription.dispose()
      editor.dispose()
      for (const model of ownedModels) model.dispose()
      ownedModels.clear()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const uri = monaco.Uri.from({
      scheme: 'brightcode',
      path: `/${file.path.replace(/\\/g, '/')}`,
    })
    let model = monaco.editor.getModel(uri)
    if (!model) {
      model = monaco.editor.createModel(file.content, file.language, uri)
      ownedModelsRef.current.add(model)
    } else {
      monaco.editor.setModelLanguage(model, file.language)
      if (model.getValue() !== file.content) model.setValue(file.content)
    }

    if (editor.getModel() !== model) editor.setModel(model)
    editor.focus()
  }, [file.content, file.language, file.path])

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => editorRef.current?.layout())
    return () => cancelAnimationFrame(frame)
  }, [visible])

  return <div ref={containerRef} className="h-full min-h-0 w-full" />
}
