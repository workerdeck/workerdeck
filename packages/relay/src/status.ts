import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { RelayStatus } from './relay.ts'

export function statusSocketPath(stateDir: string): string {
  return join(stateDir, 'relay.sock')
}

function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path)
    probe.once('connect', () => {
      probe.end()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

export async function serveStatusSocket(stateDir: string, status: () => RelayStatus): Promise<Server> {
  const path = statusSocketPath(stateDir)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  if (await socketAnswers(path)) {
    throw new Error(`another relay is already serving ${stateDir} (${path} answers)`)
  }
  await rm(path, { force: true })
  const server = createServer((req, res) => {
    if (req.url !== '/status' || req.method !== 'GET') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(status()))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(path, 0o600)
  return server
}

export function fetchRelayStatus(stateDir: string, timeoutMs = 5_000): Promise<RelayStatus> {
  const socketPath = statusSocketPath(stateDir)
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/status', method: 'GET', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as RelayStatus)
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}
