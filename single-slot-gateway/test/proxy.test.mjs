import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createSingleSlotGateway } from '../src/server.mjs'

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

function config(baseUrl, overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    baseUrl: new URL(baseUrl),
    inboundApiKey: 'inbound-secret',
    upstreamApiKey: 'sk-vm-upstream',
    slotId: 'vm-01',
    maxConcurrency: 2,
    maxWaiters: 4,
    queueTimeoutMs: 1000,
    upstreamIdleTimeoutMs: 5000,
    projectRoot: null,
    preflightRequired: false,
    requireProxy: false,
    trustInboundSession: true,
    ...overrides,
  }
}

async function requestJson({
  port,
  path = '/v1/messages',
  key = 'inbound-secret',
  headers = {},
  body = '{}',
} = {}) {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        )
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

test('authenticates inbound key, rewrites upstream auth, preserves session, and strips diagnostic headers', async () => {
  let observed = null
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      observed = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'ok' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  const upstreamPort = await listen(upstream)
  const app = createSingleSlotGateway({
    config: config(`http://127.0.0.1:${upstreamPort}`),
    logger: { error() {} },
  })
  const address = await app.listen()
  try {
    const result = await requestJson({
      port: address.port,
      path: '/v1/messages?trace=1',
      headers: {
        'x-session-id': 'conversation-a',
        'x-kin-vm': 'vm-evil',
        'x-forwarded-for': '203.0.113.7',
      },
      body: '{"model":"test"}',
    })
    assert.equal(result.status, 200)
    assert.equal(result.headers['x-upstream'], 'ok')
    assert.equal(observed.method, 'POST')
    assert.equal(observed.url, '/v1/messages?trace=1')
    assert.equal(observed.headers.authorization, 'Bearer sk-vm-upstream')
    assert.equal(observed.headers['x-session-id'], 'conversation-a')
    assert.equal(observed.headers['x-kin-vm'], undefined)
    assert.equal(observed.headers['x-forwarded-for'], undefined)
  } finally {
    await app.close()
    await close(upstream)
  }
})

test('rejects invalid credentials and admin routes', async () => {
  const upstream = http.createServer((_req, res) => res.end('{}'))
  const upstreamPort = await listen(upstream)
  const app = createSingleSlotGateway({
    config: config(`http://127.0.0.1:${upstreamPort}`),
    logger: { error() {} },
  })
  const address = await app.listen()
  try {
    const denied = await requestJson({ port: address.port, key: 'wrong' })
    assert.equal(denied.status, 401)
    const admin = await requestJson({ port: address.port, path: '/api/panel/vms' })
    assert.equal(admin.status, 404)
  } finally {
    await app.close()
    await close(upstream)
  }
})

test('enforces max concurrency while streaming responses', async () => {
  let active = 0
  let maxObserved = 0
  const releases = []
  const upstream = http.createServer((req, res) => {
    req.resume()
    active += 1
    maxObserved = Math.max(maxObserved, active)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: started\n\n')
    releases.push(() => {
      res.end('data: done\n\n')
      active -= 1
    })
  })
  const upstreamPort = await listen(upstream)
  const app = createSingleSlotGateway({
    config: config(`http://127.0.0.1:${upstreamPort}`, { maxConcurrency: 1, maxWaiters: 2 }),
    logger: { error() {} },
  })
  const address = await app.listen()
  try {
    const first = requestJson({ port: address.port })
    while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 5))
    const second = requestJson({ port: address.port })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(releases.length, 1)
    releases.shift()()
    await first
    while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 5))
    releases.shift()()
    await second
    assert.equal(maxObserved, 1)
  } finally {
    await app.close()
    await close(upstream)
  }
})

test('synthesizes an opaque session id when none is supplied', async () => {
  let session = null
  const upstream = http.createServer((req, res) => {
    session = req.headers['x-session-id']
    req.resume()
    res.end('{}')
  })
  const upstreamPort = await listen(upstream)
  const app = createSingleSlotGateway({
    config: config(`http://127.0.0.1:${upstreamPort}`),
    logger: { error() {} },
  })
  const address = await app.listen()
  try {
    const result = await requestJson({ port: address.port })
    assert.equal(result.status, 200)
    assert.match(session, /^ssg-[0-9a-f-]+$/)
  } finally {
    await app.close()
    await close(upstream)
  }
})
