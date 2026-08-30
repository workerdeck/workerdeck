import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Register the custom text-* font-size utilities as a font-size class group, or
// tailwind-merge collapses a size class and a color class (e.g. `text-label
// text-muted-foreground`) into one bucket and silently drops the size.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'display-xl',
            'display-lg',
            'display-md',
            'display-sm',
            'heading-1',
            'heading-2',
            'heading-3',
            'body',
            'body-sm',
            'label',
            'code',
          ],
        },
      ],
    },
  },
})

export const cn = (...inputs: ClassValue[]) => {
  return twMerge(clsx(inputs))
}
