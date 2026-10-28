import * as vscode from 'vscode'
import { modelMatches, modelMenu, type ModelOption } from '@workerdeck/protocol'
import { BACK, CANCEL, showPick, type Answer } from './quick-input.ts'

export type ModelPickOptions = {
  title: string
  placeHolder?: string
  defaultModel?: string
  // The row to preselect and tag, e.g. the session's model or the last session's.
  current?: string
  currentTag?: string
  step?: number
  totalSteps?: number
}

export type ModelPicked = { model: ModelOption }

type Row = vscode.QuickPickItem & { model?: ModelOption; more?: true }

function row(model: ModelOption, options: ModelPickOptions, defaultRow: ModelOption | undefined): Row {
  const tags = [
    model === defaultRow ? 'default' : undefined,
    options.current !== undefined && modelMatches(model, options.current) ? (options.currentTag ?? 'current') : undefined,
  ].filter(Boolean)
  return { label: model.displayName, description: tags.join(', ') || undefined, detail: model.description ?? model.resolvedModel, model }
}

export async function pickModel(models: readonly ModelOption[], options: ModelPickOptions): Promise<Answer<ModelPicked>> {
  const menu = modelMenu(models, options.defaultModel)
  const main: Row[] = menu.main.map((m) => row(m, options, menu.defaultRow))
  if (menu.more.length > menu.main.length) {
    main.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(list-unordered) More models...', detail: `All ${menu.more.length} models`, more: true },
    )
  }
  const all = menu.more.map((m) => row(m, options, menu.defaultRow))
  const isCurrent = (r: Row) =>
    options.current === undefined ? r.model !== undefined && r.model === menu.defaultRow : r.model !== undefined && modelMatches(r.model, options.current)
  let expanded = false
  for (;;) {
    const items: Row[] = expanded ? all : main
    const picked = await showPick(items, {
      title: options.title,
      placeHolder: options.placeHolder,
      activeItem: items.find(isCurrent) ?? items[0],
      step: options.step,
      totalSteps: options.totalSteps,
      back: expanded,
    })
    if (picked === BACK && expanded) {
      expanded = false
      continue
    }
    if (picked === CANCEL || picked === BACK) {
      return picked
    }
    if (picked.more) {
      expanded = true
      continue
    }
    if (picked.model) {
      return { model: picked.model }
    }
  }
}
