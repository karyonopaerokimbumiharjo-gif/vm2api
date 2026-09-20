import test from 'node:test'
import assert from 'node:assert/strict'
import { ConcurrencyGate, GateError } from '../src/gate.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('admits up to max concurrency and wakes queued requests FIFO', async () => {
  const gate = new ConcurrencyGate({ maxConcurrency: 2, maxWaiters: 4, waitTimeoutMs: 1000 })
  const release1 = await gate.acquire()
  const release2 = await gate.acquire()
  let thirdReady = false
  const third = gate.acquire().then((release) => {
    thirdReady = true
    return release
  })
  await tick()
  assert.equal(thirdReady, false)
  assert.deepEqual(gate.snapshot(), {
    active: 2,
    waiting: 1,
    max_concurrency: 2,
    max_waiters: 4,
    wait_timeout_ms: 1000,
    closed: false,
  })
  release1()
  const release3 = await third
  assert.equal(thirdReady, true)
  assert.equal(gate.snapshot().active, 2)
  release2()
  release3()
  assert.equal(gate.snapshot().active, 0)
})

test('rejects when queue is full', async () => {
  const gate = new ConcurrencyGate({ maxConcurrency: 1, maxWaiters: 1, waitTimeoutMs: 1000 })
  const release = await gate.acquire()
  const waiting = gate.acquire()
  await assert.rejects(() => gate.acquire(), (error) => error instanceof GateError && error.code === 'queue_full')
  release()
  const releaseWaiting = await waiting
  releaseWaiting()
})

test('times out queued requests without leaking capacity', async () => {
  const gate = new ConcurrencyGate({ maxConcurrency: 1, maxWaiters: 2, waitTimeoutMs: 20 })
  const release = await gate.acquire()
  await assert.rejects(
    () => gate.acquire(),
    (error) => error instanceof GateError && error.code === 'queue_timeout',
  )
  assert.equal(gate.snapshot().active, 1)
  assert.equal(gate.snapshot().waiting, 0)
  release()
  assert.equal(gate.snapshot().active, 0)
})

test('removes aborted waiters', async () => {
  const gate = new ConcurrencyGate({ maxConcurrency: 1, maxWaiters: 2, waitTimeoutMs: 1000 })
  const release = await gate.acquire()
  const controller = new AbortController()
  const waiting = gate.acquire({ signal: controller.signal })
  controller.abort()
  await assert.rejects(
    () => waiting,
    (error) => error instanceof GateError && error.code === 'client_aborted',
  )
  assert.equal(gate.snapshot().waiting, 0)
  release()
})
