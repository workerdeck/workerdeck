import { RouterProvider } from '@tanstack/react-router'
import { Toaster } from '@workerdeck/ui'
import { router } from '@/router.tsx'

export function App() {
  return (
    <>
      <RouterProvider router={router} />
      {/* Outside the router so toasts survive navigation. */}
      <Toaster />
    </>
  )
}
