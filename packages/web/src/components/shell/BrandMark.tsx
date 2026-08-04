/** The workerdeck "Session Stack" mark — see docs/assets/BRAND.md. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className={className}>
      <path d='M8 3.5h9A3.5 3.5 0 0 1 20.5 7v9' />
      <rect width='13.5' height='13.5' x='3.5' y='7' rx='3.5' />
      <path d='m7 16.5 2.5-2.5L7 11.5' />
      <circle cx='13.2' cy='14' r='1.7' fill='#2fbf71' stroke='none' />
    </svg>
  )
}
