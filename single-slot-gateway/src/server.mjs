import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGatewayConfig } from './config.mjs'
import { ConcurrencyGate } from './gate.mjs'
import { auditSingleSlotProject } from './preflight.mjs'
import { createGatewayHandler } from './proxy.mjs'

export function createSingleSlotGateway({ config = loadGatewayConfig(), logger = console } = {}) {
  const runPreflight = () => {
    if (!config.projectRoot) return { ok: true, skipped: true, warnings: ['preflight was not run'] }
    return auditSingleSlotProject({
      projectRoot: config.projectRoot,
      vmId: config.slotId,
      maxConcurrency: config.maxConcurrency,
      requireProxy: config.requireProxy,
    })
  }
  if (!config.projectRoot && config.preflightRequired) {
    throw new Error('VM2API_PROJECT_ROOT is required because PREFLIGHT_REQUIRED is enabled')
  }
  const preflight = runPreflight()
  if (config.preflightRequired && !preflight.ok) {
    throw new Error(`single-slot preflight failed: ${preflight.errors.join('; ')}`)
  }

  const gate = new ConcurrencyGate({
    maxConcurrency: config.maxConcurrency,
    maxWaiters: config.maxWaiters,
    waitTimeoutMs: config.queueTimeoutMs,
  })
  const handler = createGatewayHandler({ config, gate, getPreflight: runPreflight, logger })
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      logger.error?.('[single-slot-gateway] unhandled request error', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'single_slot_gateway_error', message: 'internal gateway error' } }))
      } else {
        res.destroy(error)
      }
    })
  })

  return {
    server,
    gate,
    preflight,
    config,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.host, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      return server.address()
    },
    async close() {
      gate.close()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (entry && entry === fileURLToPath(import.meta.url)) {
  const app = createSingleSlotGateway()
  const address = await app.listen()
  console.log(
    JSON.stringify({
      event: 'single_slot_gateway_listening',
      address,
      slot_id: app.config.slotId,
      max_concurrency: app.config.maxConcurrency,
      preflight: app.preflight,
    }),
  )
  const shutdown = async (signal) => {
    console.log(JSON.stringify({ event: 'single_slot_gateway_shutdown', signal }))
    await app.close()
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}
