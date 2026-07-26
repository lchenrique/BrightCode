/**
 * Persistent tasks/conversations registry backed by electron-store.
 */

import { BrowserWindow, ipcMain } from 'electron'
import Store from 'electron-store'
import { IPC } from '../shared/ipc-channels'

const StoreCtor = (Store as unknown as { default?: typeof Store }).default ?? Store

export type Task = {
  id: string
  projectId: string | null
  title: string
  selectedModel?: string
  createdAt: number
  updatedAt: number
}

type StoredTasksState = {
  tasks: Task[]
  messagesByTaskId: Record<string, unknown[]>
}

const tasksStore = new StoreCtor<StoredTasksState>({
  name: 'tasks',
  defaults: { tasks: [], messagesByTaskId: {} },
})

export function listTasks(): Task[] {
  return tasksStore.get('tasks')
}

export function createTask(input: {
  id?: string
  projectId: string | null
  title: string
  selectedModel?: string
  createdAt?: number
  updatedAt?: number
}): Task {
  const now = Date.now()
  const task: Task = {
    id: input.id || crypto.randomUUID(),
    projectId: input.projectId,
    title: input.title,
    selectedModel: input.selectedModel,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
  const existing = tasksStore.get('tasks')
  if (!existing.some((t) => t.id === task.id)) {
    tasksStore.set('tasks', [task, ...existing])
    broadcastChanged()
  }
  return task
}

export function removeTask(id: string): void {
  const existing = tasksStore.get('tasks')
  tasksStore.set('tasks', existing.filter((t) => t.id !== id))
  const msgs = tasksStore.get('messagesByTaskId')
  if (id in msgs) {
    delete msgs[id]
    tasksStore.set('messagesByTaskId', msgs)
  }
  broadcastChanged()
}

export function updateTask(
  id: string,
  patch: Partial<Pick<Task, 'title' | 'projectId' | 'selectedModel'>>,
): void {
  const existing = tasksStore.get('tasks')
  tasksStore.set(
    'tasks',
    existing.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t)),
  )
  broadcastChanged()
}

export function getTaskMessages(taskId: string): unknown[] {
  const msgs = tasksStore.get('messagesByTaskId')
  return msgs[taskId] ?? []
}

export function saveTaskMessages(taskId: string, messages: unknown[]): void {
  const msgs = tasksStore.get('messagesByTaskId')
  msgs[taskId] = messages
  tasksStore.set('messagesByTaskId', msgs)
}

function broadcastChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.TASKS_CHANGED)
  }
}

export function registerTasksIpc(): void {
  ipcMain.handle(IPC.TASKS_LIST, () => listTasks())
  ipcMain.handle(
    IPC.TASKS_CREATE,
    (
      _e,
      input: {
        projectId: string | null
        title: string
        selectedModel?: string
      },
    ) => createTask(input),
  )
  ipcMain.handle(IPC.TASKS_REMOVE, (_e, id: string) => removeTask(id))
  ipcMain.handle(
    IPC.TASKS_UPDATE,
    (
      _e,
      id: string,
      patch: Partial<Pick<Task, 'title' | 'projectId' | 'selectedModel'>>,
    ) => updateTask(id, patch),
  )
  ipcMain.handle(IPC.TASKS_GET_MESSAGES, (_e, taskId: string) => getTaskMessages(taskId))
  ipcMain.handle(IPC.TASKS_SAVE_MESSAGES, (_e, taskId: string, messages: unknown[]) =>
    saveTaskMessages(taskId, messages),
  )
}
