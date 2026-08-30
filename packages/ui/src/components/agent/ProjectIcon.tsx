import type { ProjectIcon as ProjectIconSpec } from '@workerdeck/protocol'
import {
  Anchor,
  Atom,
  Beaker,
  Bike,
  Binary,
  Blocks,
  Bot,
  Box,
  Brain,
  Briefcase,
  Brush,
  Bug,
  Building2,
  Cable,
  Camera,
  Car,
  Cat,
  CircuitBoard,
  Cloud,
  Code,
  Coffee,
  Cog,
  Compass,
  Container,
  Cpu,
  CreditCard,
  Database,
  Diamond,
  Dog,
  Feather,
  Film,
  Flame,
  FlaskConical,
  Folder,
  Gamepad2,
  Gauge,
  Gem,
  Ghost,
  Gift,
  GitBranch,
  Globe,
  GraduationCap,
  Hammer,
  Hexagon,
  House,
  Image,
  Key,
  Landmark,
  Laptop,
  Layers,
  Leaf,
  Library,
  Lightbulb,
  Lock,
  Mail,
  Map,
  MessageCircle,
  Mic,
  Monitor,
  Moon,
  Mountain,
  Music,
  Network,
  Newspaper,
  Notebook,
  Orbit,
  Package,
  Palette,
  PenTool,
  Phone,
  PiggyBank,
  Plane,
  Plug,
  Puzzle,
  Radar,
  Radio,
  Receipt,
  Rocket,
  Ruler,
  Satellite,
  Scale,
  Scissors,
  Server,
  Shield,
  Ship,
  ShoppingCart,
  Signal,
  Smartphone,
  Sparkles,
  Sprout,
  Square,
  Star,
  Sun,
  Table,
  Tag,
  Target,
  Telescope,
  Terminal,
  TestTube,
  TreePine,
  Trophy,
  Truck,
  Umbrella,
  Users,
  Wallet,
  Wand,
  Waves,
  Webhook,
  Wifi,
  Wrench,
  Zap,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '../../lib/utils.ts'

/**
 * A project's icon — the render side of protocol's `ProjectIcon`, for a list
 * row or a group header.
 *
 * **The glyph arm is a curated set, and that is the design rather than a
 * shortcut.** The gateway validates a glyph name by *shape* only (lucide's
 * lowercase-kebab convention) and explicitly declines to grow an icon catalog,
 * so the contract already says a client must fall back on a name it does not
 * know.
 *
 * The alternative was measured rather than argued, against the VS Code
 * sidebar's own bundle: `sidebar.js` is **31 KB** with one glyph, **77 KB**
 * with the 110 below (~418 bytes each), and **927 KB** with a
 * `import * as` over lucide's ~1,600 — which is what it costs, because a
 * namespace import defeats tree-shaking by construction. (`DynamicIcon` is the
 * third option and worse in a different currency: ~1,600 chunk files shipped
 * inside the `.vsix`.) Twelve times the bundle to render a name nobody has
 * declared yet is not a trade worth making; 46 KB to cover the names people
 * actually use is.
 *
 * The set is chosen to cover what people call a project; an unlisted-but-valid
 * name draws {@link Folder}, which is what the row drew before this feature
 * existed. **Grow it freely** — each addition is ~400 bytes and the fallback
 * means a missing one is a shrug, not a hole.
 *
 * **The image arm draws nothing until its bytes arrive**, and takes them as a
 * resolved `src` rather than fetching: the wire carries only an address
 * (media type, size, content hash), and *who* fetches it differs per client —
 * a VS Code webview cannot reach a gateway at all and must be handed a data
 * URL by its extension host, while a browser can fetch and `createObjectURL`.
 * A component that fetched would be wrong on one of them. Absent `src` renders
 * nothing rather than a placeholder box: an icon is decoration beside a name
 * that is already there, and a box that becomes a picture a beat later is more
 * movement than the picture is worth.
 *
 * One thing an image icon cannot do, and a glyph can: **take the row's
 * colour.** An `<img>`-embedded SVG is its own document, so `currentColor` does
 * not reach it and its own `prefers-color-scheme` resolves against the *OS*
 * rather than the host's theme (measured: it does resolve, which is the
 * surprise — so a monochrome mark tuned for both schemes is right on a dark OS
 * in a dark editor and wrong on a light OS in a dark one). A repo that wants a
 * mark that always matches its row should declare a glyph; one that wants its
 * brand should declare the image and accept that it is a picture.
 */
const GLYPHS: Record<string, ComponentType<{ className?: string }>> = {
  anchor: Anchor,
  atom: Atom,
  beaker: Beaker,
  bike: Bike,
  binary: Binary,
  blocks: Blocks,
  bot: Bot,
  box: Box,
  brain: Brain,
  briefcase: Briefcase,
  brush: Brush,
  bug: Bug,
  'building-2': Building2,
  cable: Cable,
  camera: Camera,
  car: Car,
  cat: Cat,
  'circuit-board': CircuitBoard,
  cloud: Cloud,
  code: Code,
  coffee: Coffee,
  cog: Cog,
  compass: Compass,
  container: Container,
  cpu: Cpu,
  'credit-card': CreditCard,
  database: Database,
  diamond: Diamond,
  dog: Dog,
  feather: Feather,
  film: Film,
  flame: Flame,
  'flask-conical': FlaskConical,
  folder: Folder,
  'gamepad-2': Gamepad2,
  gauge: Gauge,
  gem: Gem,
  ghost: Ghost,
  gift: Gift,
  'git-branch': GitBranch,
  globe: Globe,
  'graduation-cap': GraduationCap,
  hammer: Hammer,
  hexagon: Hexagon,
  house: House,
  image: Image,
  key: Key,
  landmark: Landmark,
  laptop: Laptop,
  layers: Layers,
  leaf: Leaf,
  library: Library,
  lightbulb: Lightbulb,
  lock: Lock,
  mail: Mail,
  map: Map,
  'message-circle': MessageCircle,
  mic: Mic,
  monitor: Monitor,
  moon: Moon,
  mountain: Mountain,
  music: Music,
  network: Network,
  newspaper: Newspaper,
  notebook: Notebook,
  orbit: Orbit,
  package: Package,
  palette: Palette,
  'pen-tool': PenTool,
  phone: Phone,
  'piggy-bank': PiggyBank,
  plane: Plane,
  plug: Plug,
  puzzle: Puzzle,
  radar: Radar,
  radio: Radio,
  receipt: Receipt,
  rocket: Rocket,
  ruler: Ruler,
  satellite: Satellite,
  scale: Scale,
  scissors: Scissors,
  server: Server,
  shield: Shield,
  ship: Ship,
  'shopping-cart': ShoppingCart,
  signal: Signal,
  smartphone: Smartphone,
  sparkles: Sparkles,
  sprout: Sprout,
  square: Square,
  star: Star,
  sun: Sun,
  table: Table,
  tag: Tag,
  target: Target,
  telescope: Telescope,
  terminal: Terminal,
  'test-tube': TestTube,
  'tree-pine': TreePine,
  trophy: Trophy,
  truck: Truck,
  umbrella: Umbrella,
  users: Users,
  wallet: Wallet,
  wand: Wand,
  waves: Waves,
  webhook: Webhook,
  wifi: Wifi,
  wrench: Wrench,
  zap: Zap,
}

export function ProjectIcon({
  icon,
  src,
  name,
  className,
}: {
  icon: ProjectIconSpec | undefined
  /** Resolved bytes for the `image` arm — an object URL or a data URL. The
   * caller fetches (see the note above); absent draws nothing. */
  src?: string
  /** The project's name, for the alt text. */
  name?: string
  className?: string
}) {
  if (!icon) {
    return null
  }
  if (icon.type === 'image') {
    if (!src) {
      return null
    }
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        title={name}
        // `object-contain` because a declared icon is whatever aspect the repo
        // checked in, and a squashed logo reads worse than a letterboxed one.
        className={cn('inline-block size-3 shrink-0 object-contain', className)}
      />
    )
  }
  const Glyph = GLYPHS[icon.name] ?? Folder
  return <Glyph className={cn('inline-block size-3 shrink-0', className)} />
}
