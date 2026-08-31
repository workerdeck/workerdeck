import { Empty, EmptyKey } from '@workerdeck/ui'
import { Plug } from 'lucide-react'

export function GatewaysView() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Empty
        icon={<Plug />}
        title="No gateway selected"
        description={
          <>
            Pick one on the left, or add one with <EmptyKey>+</EmptyKey> above.
          </>
        }
      />
    </div>
  )
}
