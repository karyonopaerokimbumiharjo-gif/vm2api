import { timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'

function readInt(name, fallback, { min, max }) {
  const raw = process.env[name]
  const value = raw == null || raw === '' ? fallback : Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  }
  return Math.trunc(value)
}

function readBool(name, fallback = false) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  if (/^(1|true|yes|on)$/i.test(raw)) return true
  if (/^(0|false|no|off)$/i.test(raw)) return false
  throw new Error(`${name} must be a boolean`)
}

function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requiredSecret(name) {
  const file = String(process.env[`${name}_FILE`] || '').trim()
  if (file) {
    const value = fs.readFileSync(file, 'utf8').trim()
    if (!value) throw new Error(`${name}_FILE is empty`)
    return value
  }
  return required(name)
}

export function loadGatewayConfig() {
  const base = new URL(required('VM2API_BASE_URL'))
  if (!/^https?:$/.test(base.protocol)) throw new Error('VM2API_BASE_URL must use http or https')
  if (base.username || base.password) throw new Error('VM2API_BASE_URL must not embed credentials')

  const slotId = required('SINGLE_SLOT_VM_ID')
  if (!/^[a-zA-Z0-9_-]+$/.test(slotId)) throw new Error('SINGLE_SLOT_VM_ID contains invalid characters')

  return {
    host: process.env.HOST || '0.0.0.0',
    port: readInt('PORT', 8790, { min: 1, max: 65535 }),
    baseUrl: base,
    inboundApiKey: requiredSecret('INBOUND_API_KEY'),
    upstreamApiKey: requiredSecret('VM2API_UPSTREAM_KEY'),
    slotId,
    maxConcurrency: readInt('MAX_CONCURRENCY', 2, { min: 1, max: 64 }),
    maxWaiters: readInt('MAX_WAITERS', 32, { min: 0, max: 10_000 }),
    queueTimeoutMs: readInt('QUEUE_TIMEOUT_MS', 120_000, { min: 1_000, max: 3_600_000 }),
    upstreamIdleTimeoutMs: readInt('UPSTREAM_IDLE_TIMEOUT_MS', 180_000, { min: 1_000, max: 3_600_000 }),
    projectRoot: String(process.env.VM2API_PROJECT_ROOT || '').trim() || null,
    preflightRequired: readBool('PREFLIGHT_REQUIRED', true),
    requireProxy: !readBool('ALLOW_LOCAL_EGRESS', false),
    trustInboundSession: readBool('TRUST_INBOUND_SESSION', true),
  }
}

export function keyMatches(presented, expected) {
  const left = Buffer.from(String(presented || ''))
  const right = Buffer.from(String(expected || ''))
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}
