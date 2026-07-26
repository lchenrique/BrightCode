const LAST_SELECTED_MODEL_KEY = 'brightcode:last-selected-model'

export function readLastSelectedModel(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(LAST_SELECTED_MODEL_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function saveLastSelectedModel(model: string): void {
  if (typeof window === 'undefined' || !model.trim()) return
  try {
    window.localStorage.setItem(LAST_SELECTED_MODEL_KEY, model)
  } catch {
    // A disabled storage backend should not prevent the user from chatting.
  }
}
