# BrightCode ⚡

> **Open-source, Multi-Provider AI Coding Workspace**

BrightCode é uma aplicação desktop de alta performance construída em **Electron + React 19 + TypeScript + Vite + Tailwind CSS v4**. Ela oferece um workspace completo para pares de programação com IA (estilo MiniMax Code, Claude Code e Cursor) com suporte a múltiplos provedores de LLM sem *lock-in*.

---

## 🌟 Principais Recursos

- **Multi-Provedor Transparente**: Alterne dinamicamente entre modelos da **OpenAI**, **Anthropic**, **Google Gemini**, **Antigravity CLI**, **OpenCode Zen / Go**, **MiniMax** e **PayPerQ**.
- **Autenticação em 3 Modalidades**:
  1. **API Keys Estáticas**: Salvas de forma segura no `electron-store`.
  2. **Detecção Automática de CLI Local**: Lê credenciais de ferramentas já instaladas na sua máquina (`Codex CLI`, `Claude Code`, `Gemini CLI`, `Antigravity CLI`).
  3. **OAuth Direct App (PKCE Flow)**: Autenticação direta via navegador com servidor HTTP local efêmero (`http://127.0.0.1:<port>/callback`) e resposta visual com auto-close.
- **Navegação & Gestão de Projetos Estilo MiniMax Code**:
  - Organização de tarefas e conversas por projeto no sidebar.
  - Seleção de projetos integrada na tela inicial (*Welcome Hero*).
  - Highlight reativo da sessão ativa.
- **Persistência Completa (Fase 2 IPC)**:
  - Registro de projetos, tarefas e histórico de mensagens mantidos no processo principal (`electron-store`).
- **Sandboxing & Tools do Agente**:
  - Ferramentas locais (`read_file`, `write_file`, `edit_file`, `list_files`, `search_files`) executadas com validação de escopo.

---

## 🚀 Como Executar

### Pré-requisitos
- **Node.js**: `v20+`
- **npm** / **bun**

### Instalação e Desenvolvimento
```bash
# Instalar dependências
npm install

# Iniciar o modo Desktop Dev (Vite + Electron com Hot-Reload)
npm run electron:dev

# Verificar tipagem TypeScript
npx tsc --noEmit

# Executar o linter (Oxlint)
npm run lint
```

### Build de Produção
```bash
# Build do instalador desktop (Windows NSIS / macOS DMG / Linux AppImage)
npm run electron:build
```

---

## 📂 Arquitetura do Projeto

```text
BrightCode/
├── electron/
│   ├── main/
│   │   ├── cli-detect.ts     # Leitura de credenciais de CLIs (Codex, gcloud, Antigravity)
│   │   ├── oauth.ts          # Servidor HTTP local temporário + fluxo PKCE
│   │   ├── projects.ts       # Gestão e persistência de projetos no electron-store
│   │   ├── tasks.ts          # Persistência IPC de tarefas e mensagens
│   │   ├── provider-proxy.ts # Proxy seguro HTTP/SSE para requisições aos modelos
│   │   └── tools.ts          # Ferramentas sandboxed do agente
│   └── preload/              # Ponte segura IPC (window.electronAPI)
│
├── src/
│   ├── components/
│   │   ├── chat/             # UI de Chat, AssistantTurn, ToolTimeline, ChatSurface
│   │   ├── home/             # WelcomeScreen, ChatInput
│   │   ├── layout/           # AppShell, AppSidebar, ViewTopBar
│   │   └── settings/         # ProvidersSettings, SettingsDialog
│   ├── hooks/                # Hooks reativos (useProjects, useTasks, useCliDetection)
│   └── lib/providers/        # Adaptações SSE, Registry, Factory e Modelos LLM
```

---

## 📄 Licença

MIT License.
