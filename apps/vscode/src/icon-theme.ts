import * as vscode from 'vscode'

type IconDefinition = { iconPath?: string; fontCharacter?: string; fontColor?: string; fontSize?: string; fontId?: string }

type IconAssociations = {
  file?: string
  folder?: string
  folderExpanded?: string
  rootFolder?: string
  rootFolderExpanded?: string
  folderNames?: Record<string, string>
  folderNamesExpanded?: Record<string, string>
  fileExtensions?: Record<string, string>
  fileNames?: Record<string, string>
  languageIds?: Record<string, string>
}

type IconFont = { id: string; src: { path: string; format: string }[]; weight?: string; style?: string; size?: string }

type IconThemeDocument = IconAssociations & {
  iconDefinitions?: Record<string, IconDefinition>
  fonts?: IconFont[]
  light?: IconAssociations
  highContrast?: IconAssociations
  hidesExplorerArrows?: boolean
  showLanguageModeIcons?: boolean
}

type ThemeContribution = { id: string; path: string }

export type IconThemeCss = { css: string; fileIcons: boolean; folderIcons: boolean; hideArrows: boolean; roots: vscode.Uri[] }

export type LanguageIndex = { names: Map<string, string>; extensions: Map<string, string> }

const EXPANDED = '.monaco-tl-twistie.collapsible:not(.collapsed) + .monaco-tl-contents'

// Webview bodies carry vscode-light / vscode-high-contrast(-light), not the workbench's .vs / .hc-black / .hc-light.
const LIGHT = 'body.vscode-light'
const HC_DARK = 'body.vscode-high-contrast:not(.vscode-high-contrast-light)'
const HC_LIGHT = 'body.vscode-high-contrast-light'

export function codiconCss(webview: vscode.Webview): { css: string; root: vscode.Uri } {
  const root = vscode.Uri.joinPath(vscode.Uri.file(vscode.env.appRoot), 'out', 'media')
  const font = webview.asWebviewUri(vscode.Uri.joinPath(root, 'codicon.ttf'))
  return { css: `@font-face { font-family: 'codicon'; font-display: block; src: url('${font.toString()}') format('truetype'); }`, root }
}

function activeIconTheme(): { extension: vscode.Extension<unknown>; theme: ThemeContribution } | undefined {
  const themeId = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme')
  if (!themeId) {
    return undefined
  }
  for (const extension of vscode.extensions.all) {
    const themes = (extension.packageJSON?.contributes?.iconThemes ?? []) as ThemeContribution[]
    const theme = themes.find((t) => t.id === themeId)
    if (theme) {
      return { extension, theme }
    }
  }
  return undefined
}

export function iconThemeRoot(): vscode.Uri | undefined {
  return activeIconTheme()?.extension.extensionUri
}

export async function loadIconTheme(webview: vscode.Webview): Promise<IconThemeCss> {
  const none: IconThemeCss = { css: '', fileIcons: false, folderIcons: false, hideArrows: false, roots: [] }
  const active = activeIconTheme()
  if (!active) {
    return none
  }
  const location = vscode.Uri.joinPath(active.extension.extensionUri, active.theme.path)
  try {
    const document = parseJsonc(new TextDecoder().decode(await vscode.workspace.fs.readFile(location))) as IconThemeDocument
    const dir = vscode.Uri.joinPath(location, '..')
    return {
      ...themeCss(document, (path) => webview.asWebviewUri(vscode.Uri.joinPath(dir, path)).toString()),
      roots: [active.extension.extensionUri],
    }
  } catch {
    return none
  }
}

function themeCss(document: IconThemeDocument, resolve: (path: string) => string): Omit<IconThemeCss, 'roots'> {
  const selectorsByDefinition = new Map<string, string[]>()
  const result = { fileIcons: false, folderIcons: false }
  const add = (selector: string, definition: string | undefined) => {
    if (definition) {
      selectorsByDefinition.set(definition, [...(selectorsByDefinition.get(definition) ?? []), selector])
    }
  }
  const collect = (associations: IconAssociations | undefined, base?: string) => {
    if (!associations) {
      return
    }
    const qualifier = base ? `${base} .show-file-icons` : '.show-file-icons'
    if (associations.folder) {
      add(`${qualifier} .folder-icon::before`, associations.folder)
      result.folderIcons = true
    }
    if (associations.folderExpanded) {
      add(`${qualifier} ${EXPANDED} .folder-icon::before`, associations.folderExpanded)
      result.folderIcons = true
    }
    if (associations.file) {
      add(`${qualifier} .file-icon::before`, associations.file)
      result.fileIcons = true
    }
    for (const [key, definition] of Object.entries(associations.folderNames ?? {})) {
      const selectors: string[] = []
      const name = parentFolder(key.toLowerCase(), selectors)
      selectors.push(`.${cssEscape(name)}-name-folder-icon`)
      add(`${qualifier} ${selectors.join('')}.folder-icon::before`, definition)
      result.folderIcons = true
    }
    for (const [key, definition] of Object.entries(associations.folderNamesExpanded ?? {})) {
      const selectors: string[] = []
      const name = parentFolder(key.toLowerCase(), selectors)
      selectors.push(`.${cssEscape(name)}-name-folder-icon`)
      add(`${qualifier} ${EXPANDED} ${selectors.join('')}.folder-icon::before`, definition)
      result.folderIcons = true
    }
    const languageIds = { ...associations.languageIds }
    if (!languageIds.jsonc && languageIds.json) {
      languageIds.jsonc = languageIds.json
    }
    for (const [languageId, definition] of Object.entries(languageIds)) {
      add(`${qualifier} .${cssEscape(languageId)}-lang-file-icon.file-icon::before`, definition)
      result.fileIcons = true
    }
    for (const [key, definition] of Object.entries(associations.fileExtensions ?? {})) {
      const selectors: string[] = []
      const segments = parentFolder(key.toLowerCase(), selectors).split('.')
      for (let i = 0; i < segments.length; i++) {
        selectors.push(`.${cssEscape(segments.slice(i).join('.'))}-ext-file-icon`)
      }
      selectors.push('.ext-file-icon')
      add(`${qualifier} ${selectors.join('')}.file-icon::before`, definition)
      result.fileIcons = true
    }
    for (const [key, definition] of Object.entries(associations.fileNames ?? {})) {
      const selectors: string[] = []
      const name = parentFolder(key.toLowerCase(), selectors)
      selectors.push(`.${cssEscape(name)}-name-file-icon`, '.name-file-icon')
      const segments = name.split('.')
      for (let i = 1; i < segments.length; i++) {
        selectors.push(`.${cssEscape(segments.slice(i).join('.'))}-ext-file-icon`)
      }
      selectors.push('.ext-file-icon')
      add(`${qualifier} ${selectors.join('')}.file-icon::before`, definition)
      result.fileIcons = true
    }
  }
  collect(document)
  collect(document.light, LIGHT)
  collect(document.highContrast, HC_DARK)
  collect(document.highContrast, HC_LIGHT)

  const rules: string[] = []
  const fontSizes = new Map<string, string>()
  const fonts = document.fonts ?? []
  if (fonts.length > 0) {
    const defaultSize = fonts[0]!.size ?? '150%'
    for (const font of fonts) {
      const src = font.src.map((s) => `url('${resolve(s.path)}') format('${s.format}')`).join(', ')
      rules.push(
        `@font-face { src: ${src}; font-family: '${font.id}'; font-weight: ${font.weight ?? 'normal'}; font-style: ${font.style ?? 'normal'}; font-display: block; }`,
      )
      if (font.size !== undefined && font.size !== defaultSize) {
        fontSizes.set(font.id, font.size)
      }
    }
    rules.push(
      `.show-file-icons .file-icon::before, .show-file-icons .folder-icon::before { font-family: '${fonts[0]!.id}'; font-size: ${defaultSize}; }`,
    )
  }
  const languageModeIcons = document.showLanguageModeIcons === true || (result.fileIcons && document.showLanguageModeIcons !== false)
  for (const [id, selectors] of selectorsByDefinition) {
    const definition = document.iconDefinitions?.[id]
    if (!definition) {
      continue
    }
    if (definition.iconPath) {
      rules.push(`${selectors.join(', ')} { content: ' '; background-image: url('${resolve(definition.iconPath)}'); }`)
      continue
    }
    if (definition.fontCharacter || definition.fontColor) {
      const body: string[] = []
      if (definition.fontColor) {
        body.push(`color: ${definition.fontColor};`)
      }
      if (definition.fontCharacter) {
        body.push(`content: '${definition.fontCharacter}';`)
      }
      const size = definition.fontSize ?? (definition.fontId ? fontSizes.get(definition.fontId) : undefined)
      if (size) {
        body.push(`font-size: ${size};`)
      }
      if (definition.fontId) {
        body.push(`font-family: ${definition.fontId};`)
      } else if (languageModeIcons) {
        body.push('background-image: unset;')
      }
      rules.push(`${selectors.join(', ')} { ${body.join(' ')} }`)
    }
  }
  return { css: rules.join('\n'), ...result, hideArrows: document.hidesExplorerArrows === true }
}

function parentFolder(key: string, selectors: string[]): string {
  const slash = key.lastIndexOf('/')
  if (slash < 0) {
    return key
  }
  selectors.push(`.${cssEscape(key.slice(0, slash))}-name-dir-icon`)
  return key.slice(slash + 1)
}

export function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_ -￿-]/g, (ch) => `\\${ch}`).replace(/^(\d)/, (d) => `\\3${d} `)
}

export function languageIndex(): LanguageIndex {
  const names = new Map<string, string>()
  const extensions = new Map<string, string>()
  for (const extension of vscode.extensions.all) {
    const languages = (extension.packageJSON?.contributes?.languages ?? []) as { id: string; extensions?: string[]; filenames?: string[] }[]
    for (const language of languages) {
      for (const ext of language.extensions ?? []) {
        extensions.set(ext.toLowerCase().replace(/^\./, ''), language.id)
      }
      for (const name of language.filenames ?? []) {
        names.set(name.toLowerCase(), language.id)
      }
    }
  }
  const associations = vscode.workspace.getConfiguration('files').get<Record<string, string>>('associations') ?? {}
  for (const [pattern, id] of Object.entries(associations)) {
    if (/^\*\.[^*?/[\]{}]+$/.test(pattern)) {
      extensions.set(pattern.slice(2).toLowerCase(), id)
    } else if (!/[*?/[\]{}]/.test(pattern)) {
      names.set(pattern.toLowerCase(), id)
    }
  }
  return { names, extensions }
}

// Longest extension wins, the way the language service resolves `.d.ts` before `.ts`.
export function languageOf(index: LanguageIndex, name: string): string | undefined {
  const lower = name.toLowerCase()
  const byName = index.names.get(lower)
  if (byName) {
    return byName
  }
  const segments = lower.split('.')
  for (let i = 1; i < segments.length; i++) {
    const match = index.extensions.get(segments.slice(i).join('.'))
    if (match) {
      return match
    }
  }
  return undefined
}

function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[++i] ?? ''
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++
      }
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) {
        break
      }
      i++
    } else {
      out += ch
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}
