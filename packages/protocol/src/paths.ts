export function resolvePosix(target: string, cwd: string | undefined): string | undefined {
  if (target.startsWith('/')) {
    return normalizePosix(target)
  }
  return cwd ? normalizePosix(`${cwd}/${target}`) : undefined
}

function normalizePosix(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      out.pop()
    } else {
      out.push(part)
    }
  }
  return `/${out.join('/')}`
}
