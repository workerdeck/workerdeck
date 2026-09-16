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

export function showPick<T extends vscode.QuickPickItem>(
  items: readonly T[],
  options: { title: string; placeHolder?: string; step?: number; totalSteps?: number },
): Promise<Answer<T>> {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<T>()
    pick.title = options.title
    pick.placeholder = options.placeHolder
    pick.items = items
    pick.ignoreFocusOut = true
    if (options.step !== undefined) {
      pick.step = options.step
      pick.totalSteps = options.totalSteps
      if (options.step > 1) {
        pick.buttons = [vscode.QuickInputButtons.Back]
      }
    }
    let answered = false
    const finish = (answer: Answer<T>) => {
      answered = true
      resolve(answer)
      pick.hide()
    }
    pick.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        finish(BACK)
      }
    })
    pick.onDidAccept(() => {
      const selected = pick.selectedItems[0]
      if (selected) {
        finish(selected)
      }
    })
    pick.onDidHide(() => {
      if (!answered) {
        resolve(CANCEL)
      }
      pick.dispose()
    })
    pick.show()
  })
}
