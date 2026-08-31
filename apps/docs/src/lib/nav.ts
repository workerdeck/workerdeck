import { getCollection } from 'astro:content'

export interface NavItem {
  slug: string
  title: string
  href: string
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

const GROUPS: Array<{ dir: string; label: string }> = [
  { dir: 'getting-started', label: 'Getting started' },
  { dir: 'guides', label: 'Guides' },
  { dir: 'reference', label: 'Reference' },
]

const base = import.meta.env.BASE_URL.replace(/\/$/, '')

export function docHref(slug: string): string {
  return `${base}/docs/${slug}/`
}

export async function buildNav(): Promise<NavGroup[]> {
  const entries = await getCollection('docs')
  return GROUPS.map(({ dir, label }) => ({
    label,
    items: entries
      .filter((e) => e.id.startsWith(`${dir}/`))
      .sort((a, b) => a.data.order - b.data.order)
      .map((e) => ({ slug: e.id, title: e.data.title, href: docHref(e.id) })),
  })).filter((g) => g.items.length > 0)
}

/** Flat ordered list for prev/next pagination. */
export async function flatNav(): Promise<NavItem[]> {
  const groups = await buildNav()
  return groups.flatMap((g) => g.items)
}
