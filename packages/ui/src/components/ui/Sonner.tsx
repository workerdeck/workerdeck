import { Toaster as SonnerToaster, toast } from 'sonner'

export { toast }

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        style: {
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-md)',
          fontFamily: 'var(--cw-font-sans)',
          fontSize: 'var(--text-body-sm)',
        },
      }}
    />
  )
}
