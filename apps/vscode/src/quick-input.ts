import * as vscode from 'vscode'

export type InputOptions = {
  title: string
  prompt: string
  placeHolder?: string
  value?: string
  password?: boolean
  step: number
  totalSteps: number
  validate?: (value: string) => string | undefined
}

export type PickOptions<T extends vscode.QuickPickItem> = {
  title: string
  placeHolder?: string
  activeItem?: T
  value?: string
  step?: number
  totalSteps?: number
  freeText?: (value: string) => T | undefined
}

export const CANCEL = Symbol('cancel')
export const BACK = Symbol('back')
export type Answer<T> = T | typeof CANCEL | typeof BACK

export function showInput(options: InputOptions): Promise<Answer<string>> {
  return new Promise((resolve) => {
    const input = vscode.window.createInputBox()
    input.title = options.title
    input.prompt = options.prompt
    input.placeholder = options.placeHolder
    input.password = options.password ?? false
    input.step = options.step
    input.totalSteps = options.totalSteps
    input.ignoreFocusOut = true
    if (options.step > 1) {
      input.buttons = [vscode.QuickInputButtons.Back]
    }

    let answered = false
    const finish = (answer: Answer<string>) => {
      answered = true
      resolve(answer)
      input.hide()
    }
    input.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        finish(BACK)
      }
    })
    // `validationMessage` only greys the box out; accepting has to be refused here too.
    input.onDidChangeValue((value) => {
      input.validationMessage = options.validate?.(value)
    })
    input.onDidAccept(() => {
      const problem = options.validate?.(input.value)
      if (problem) {
        input.validationMessage = problem
        return
      }
      finish(input.value)
    })
    // Fires for `esc` and for a real hide alike, so it must not clobber an answer already resolved.
    input.onDidHide(() => {
      if (!answered) {
        resolve(CANCEL)
      }
      input.dispose()
    })
    // After the change handler is registered: assigning `value` fires it, so a prefill that
    // does not validate says so before the first keystroke.
    input.value = options.value ?? ''
    input.show()
  })
}

export function showPick<T extends vscode.QuickPickItem>(items: readonly T[], options: PickOptions<T>): Promise<Answer<T>> {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<T>()
    pick.title = options.title
    pick.placeholder = options.placeHolder
    pick.step = options.step
    pick.totalSteps = options.totalSteps
    pick.ignoreFocusOut = true
    pick.items = [...items]
    if ((options.step ?? 1) > 1) {
      pick.buttons = [vscode.QuickInputButtons.Back]
    }

    let answered = false
    const finish = (answer: Answer<T>) => {
      answered = true
      resolve(answer)
      pick.hide()
    }
    if (options.freeText) {
      const base = [...items]
      pick.onDidChangeValue((value) => {
        const extra = options.freeText?.(value)
        pick.items = extra ? [extra, ...base] : base
      })
    }
    pick.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        finish(BACK)
      }
    })
    pick.onDidAccept(() => {
      const [selected] = pick.selectedItems
      if (selected) {
        finish(selected)
      }
    })
    // Fires for `esc` and for a real hide alike, so it must not clobber an answer already resolved.
    pick.onDidHide(() => {
      if (!answered) {
        resolve(CANCEL)
      }
      pick.dispose()
    })
    // After the change handler is registered: assigning `value` fires it, and the free-text
    // row has to be computed against the prefill rather than an empty box.
    if (options.value) {
      pick.value = options.value
    }
    // …and the active row after *that*: reassigning `items` resets the cursor to the first.
    if (options.activeItem) {
      pick.activeItems = [options.activeItem]
    }
    pick.show()
  })
}
