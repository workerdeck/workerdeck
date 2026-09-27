import { useState } from 'react'
import { DEFAULT_VIEW_CONFIG, type ViewConfig } from '@workerdeck/protocol'
import { SessionBrowser } from '@workerdeck/ui'

import { useController, useGateway, useRows, useView } from '../tour/react.tsx'

export function SessionsView() {
  const controller = useController()
  const gateway = useGateway()
  const rows = useRows(gateway)
  const view = useView()
  const [config, setConfig] = useState<ViewConfig>({ ...DEFAULT_VIEW_CONFIG, groupBy: 'none', subagents: 'all', tasks: 'all' })
  return (
    <div className="py-1 text-body-sm">
      <SessionBrowser
        rows={rows}
        config={config}
        onConfigChange={setConfig}
        showControls={false}
        showSearch={false}
        showSubset={false}
        gatewayCount={1}
        isActive={(row) => row.info.id === view.selected}
        onSelect={(row) => controller.select(row.info.id)}
        rowActions={(row) => <span hidden data-demo-card={row.info.id} />}
      />
    </div>
  )
}
