import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createSingleSlotGateway } from '../src/server.mjs'

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

async function post(port) {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          authorization: 'Bearer inbound-secret',
          'content-type': 'application/json',
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    request.on('error', reject)
    request.end('{}')
  })
}

test('fails closed when a second slot becomes schedulable after startup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'single-slot-live-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(path.join(vms, 'vm-01', 'cli-home'), { recursive: true })
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: 'vm-01' }))
  fs.writeFileSync(
    path.join(vms, 'vm-01.json'),
    JSON.stringify({
      id: 'vm-01',
      schedulable: true,
      status: 'ready',
      proxy: { id: 'px-01' },
      policy: { maxConcurrency: 1 },
    }),
  )
  const secondPath = path.join(vms, 'vm-02.json')
  fs.writeFileSync(
    secondPath,
    JSON.stringify({ id: 'vm-02', schedulable: false, status: 'ready', policy: { maxConcurrency: 1 } }),
  )

  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1
    request.resume()
    response.end('{}')
  })
  const upstreamPort = await listen(upstream)
  const app = createSingleSlotGateway({
    config: {
      host: '127.0.0.1',
      port: 0,
      baseUrl: new URL(`http://127.0.0.1:${upstreamPort}`),
      inboundApiKey: 'inbound-secret',
      upstreamApiKey: 'sk-vm-upstream',
      slotId: 'vm-01',
      maxConcurrency: 1,
      maxWaiters: 2,
      queueTimeoutMs: 1000,
      upstreamIdleTimeoutMs: 5000,
      projectRoot: root,
      preflightRequired: true,
      requireProxy: true,
      trustInboundSession: true,
    },
    logger: { error() {} },
  })
  const address = await app.listen()
  try {
    const first = await post(address.port)
    assert.equal(first.status, 200)
    assert.equal(upstreamCalls, 1)

    fs.writeFileSync(
      secondPath,
      JSON.stringify({ id: 'vm-02', schedulable: true, status: 'ready', policy: { maxConcurrency: 1 } }),
    )
    const blocked = await post(address.port)
    assert.equal(blocked.status, 503)
    assert.match(blocked.body, /single_slot_preflight_failed/)
    assert.equal(upstreamCalls, 1)
  } finally {
    await app.close()
    await close(upstream)
  }
})
