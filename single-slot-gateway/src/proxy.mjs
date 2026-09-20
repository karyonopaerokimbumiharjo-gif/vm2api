import http from 'node:http'
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import { GateError } from './gate.mjs'
import { keyMatches } from './config.mjs'

const API_ROUTES = new Map([
  ['GET /v1/models', true],
  ['GET /v1/usage', true],
  ['POST /v1/messages', true],
  ['POST /messages', true],
  ['POST /v1/messages/count_tokens', true],
  ['POST /messages/count_tokens', true],
  ['POST /v1/chat/completions', true],
  ['POST /chat/completions', true],
  ['POST /v1/completions', true],
  ['POST /completions', true],
  ['POST /v1/responses', true],
  ['POST /responses', true],
])

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const UNTRUSTED_FORWARDING = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'x-panel-token',
  'x-kin-vm',
  'x-kin-backend',
  'cookie',
  'origin',
  'referer',
])

function extractKey(req) {
  const auth = String(req.headers.authorization || '')
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
  return String(req.headers['x-api-key'] || '').trim()
}

function json(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    ...headers,
  })
  res.end(payload)
}

function safeRequestHeaders(req, config) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers || {})) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || UNTRUSTED_FORWARDING.has(lower)) continue
    if (lower === 'host' || lower === 'authorization' || lower === 'x-api-key') continue
    if (value !== undefined) headers[lower] = value
  }
  headers.authorization = `Bearer ${config.upstreamApiKey}`
  headers['x-request-id'] = String(headers['x-request-id'] || `ssg-${randomUUID()}`)
  const hasSession =
    headers['x-session-id'] || headers['x-conversation-id'] || headers['x-claude-code-session-id']
  if (!hasSession || !config.trustInboundSession) {
    headers['x-session-id'] = `ssg-${randomUUID()}`
    delete headers['x-conversation-id']
    delete headers['x-claude-code-session-id']
  }
  return headers
}

function safeResponseHeaders(upstreamHeaders) {
  const headers = {}
  for (const [name, value] of Object.entries(upstreamHeaders || {})) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || lower === 'set-cookie') continue
    if (value !== undefined) headers[lower] = value
  }
  return headers
}

function routeAllowed(req, url) {
  return API_ROUTES.has(`${String(req.method || 'GET').toUpperCase()} ${url.pathname}`)
}

function errorResponse(res, error) {
  if (error instanceof GateError) {
    if (error.status === 499) return
    return json(
      res,
      error.status,
      { error: { type: 'rate_limit_error', code: error.code, message: error.message } },
      error.retryAfter > 0 ? { 'retry-after': String(error.retryAfter) } : {},
    )
  }
  return json(res, 500, {
    error: { type: 'server_error', code: 'single_slot_gateway_error', message: error?.message || String(error) },
  })
}

async function probeUpstream(config) {
  const target = new URL('/health', config.baseUrl)
  const transport = target.protocol === 'https:' ? https : http
  return await new Promise((resolve) => {
    const request = transport.request(
      target,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        timeout: Math.min(config.upstreamIdleTimeoutMs, 10_000),
      },
      (response) => {
        response.resume()
        response.on('end', () =>
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode }),
        )
      },
    )
    request.on('timeout', () => request.destroy(new Error('upstream health timeout')))
    request.on('error', (error) => resolve({ ok: false, status: 0, error: error.message }))
    request.end()
  })
}

export function createGatewayHandler({
  config,
  gate,
  getPreflight = () => ({ ok: true, skipped: true }),
  logger = console,
} = {}) {
  if (!config || !gate) throw new Error('config and gate are required')

  return async function gatewayHandler(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      const preflight = getPreflight()
      const healthy = preflight?.ok !== false
      return json(res, healthy ? 200 : 503, {
        status: healthy ? 'ok' : 'not_ready',
        service: 'vm2api-single-slot-gateway',
        slot_id: config.slotId,
        gate: gate.snapshot(),
        preflight,
      })
    }

    if (req.method === 'GET' && url.pathname === '/ready') {
      const preflight = getPreflight()
      const upstream = await probeUpstream(config)
      const ready = Boolean(preflight?.ok !== false && upstream.ok)
      return json(res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        slot_id: config.slotId,
        preflight_ok: preflight?.ok !== false,
        upstream,
        gate: gate.snapshot(),
      })
    }

    if (!routeAllowed(req, url)) {
      return json(res, 404, {
        error: {
          type: 'invalid_request_error',
          code: 'route_not_allowed',
          message: 'route is not exposed by the single-slot gateway',
        },
      })
    }

    if (!keyMatches(extractKey(req), config.inboundApiKey)) {
      return json(res, 401, {
        error: { type: 'authentication_error', code: 'invalid_api_key', message: 'invalid gateway credentials' },
      })
    }

    const livePreflight = getPreflight()
    if (livePreflight?.ok === false) {
      return json(res, 503, {
        error: {
          type: 'api_error',
          code: 'single_slot_preflight_failed',
          message: 'single-slot invariant is not satisfied; inference is fail-closed',
          details: livePreflight.errors || [],
        },
      })
    }

    const abortController = new AbortController()
    const abort = () => abortController.abort()
    req.once('aborted', abort)
    res.once('close', () => {
      if (!res.writableEnded) abort()
    })

    let release = null
    try {
      release = await gate.acquire({ signal: abortController.signal, timeoutMs: config.queueTimeoutMs })
      if (abortController.signal.aborted) {
        throw new GateError('client_aborted', 'client disconnected before execution', { status: 499 })
      }

      const target = new URL(`${url.pathname}${url.search}`, config.baseUrl)
      const transport = target.protocol === 'https:' ? https : http
      const headers = safeRequestHeaders(req, config)

      await new Promise((resolve) => {
        let settled = false
        let upstreamReq = null
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }

        upstreamReq = transport.request(
          target,
          {
            method: req.method,
            headers,
          },
          (upstreamRes) => {
            if (!res.headersSent) {
              res.writeHead(upstreamRes.statusCode || 502, safeResponseHeaders(upstreamRes.headers))
            }
            upstreamRes.setTimeout(config.upstreamIdleTimeoutMs, () => {
              upstreamRes.destroy(new Error('upstream response idle timeout'))
            })
            upstreamRes.on('error', (error) => {
              logger.error?.('[single-slot-gateway] upstream response error', error.message)
              if (!res.headersSent) {
                json(res, 502, {
                  error: {
                    type: 'api_error',
                    code: 'upstream_transport_error',
                    message: 'vm2api upstream response failed',
                  },
                })
              } else {
                res.destroy(error)
              }
              finish()
            })
            upstreamRes.on('end', finish)
            upstreamRes.on('close', finish)
            upstreamRes.pipe(res)
          },
        )

        upstreamReq.setTimeout(config.upstreamIdleTimeoutMs, () => {
          upstreamReq.destroy(new Error('upstream request idle timeout'))
        })
        upstreamReq.on('error', (error) => {
          logger.error?.('[single-slot-gateway] upstream request error', error.message)
          if (!res.headersSent && !res.writableEnded) {
            json(res, 502, {
              error: {
                type: 'api_error',
                code: 'upstream_transport_error',
                message: 'vm2api upstream is unavailable',
              },
            })
          } else if (!res.writableEnded) {
            res.destroy(error)
          }
          finish()
        })
        abortController.signal.addEventListener(
          'abort',
          () => {
            upstreamReq.destroy(new Error('client aborted'))
            finish()
          },
          { once: true },
        )
        req.pipe(upstreamReq)
      })
    } catch (error) {
      errorResponse(res, error)
    } finally {
      req.removeListener('aborted', abort)
      if (release) release()
    }
  }
}
