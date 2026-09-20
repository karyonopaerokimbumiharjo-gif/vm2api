import { loadGatewayConfig } from './config.mjs'
import { auditSingleSlotProject } from './preflight.mjs'

try {
  const config = loadGatewayConfig()
  if (!config.projectRoot) throw new Error('VM2API_PROJECT_ROOT is required for preflight')
  const result = auditSingleSlotProject({
    projectRoot: config.projectRoot,
    vmId: config.slotId,
    maxConcurrency: config.maxConcurrency,
    requireProxy: config.requireProxy,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.ok ? 0 : 1
} catch (error) {
  process.stderr.write(`${error.message || error}\n`)
  process.exitCode = 1
}
