export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 3 20.5 7.75 12 12.5 3.5 7.75Z" />
      <path d="M3.5 12.25 12 17l8.5-4.75" />
      <path d="M3.5 16.5 12 21.25l8.5-4.75" />
      <path d="M12 6.15 14.85 7.75 12 9.35 9.15 7.75Z" fill="#2fbf71" stroke="none" />
    </svg>
  )
}
