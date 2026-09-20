export class GateError extends Error {
  constructor(code, message, { status = 429, retryAfter = 1 } = {}) {
    super(message)
    this.name = 'GateError'
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

function positiveInt(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

export class ConcurrencyGate {
  constructor({ maxConcurrency = 2, maxWaiters = 32, waitTimeoutMs = 120_000 } = {}) {
    this.maxConcurrency = positiveInt(maxConcurrency, 2, { min: 1, max: 64 })
    this.maxWaiters = positiveInt(maxWaiters, 32, { min: 0, max: 10_000 })
    this.waitTimeoutMs = positiveInt(waitTimeoutMs, 120_000, { min: 1, max: 3_600_000 })
    this.active = 0
    this.queue = []
    this.closed = false
    this.sequence = 0
  }

  snapshot() {
    return {
      active: this.active,
      waiting: this.queue.filter((item) => !item.done).length,
      max_concurrency: this.maxConcurrency,
      max_waiters: this.maxWaiters,
      wait_timeout_ms: this.waitTimeoutMs,
      closed: this.closed,
    }
  }

  async acquire({ signal = null, timeoutMs = this.waitTimeoutMs } = {}) {
    if (this.closed) {
      throw new GateError('gateway_draining', 'single-slot gateway is draining', { status: 503 })
    }
    if (signal?.aborted) {
      throw new GateError('client_aborted', 'client disconnected before execution', { status: 499, retryAfter: 0 })
    }
    if (this.active < this.maxConcurrency) {
      this.active += 1
      return this.#releaseHandle()
    }
    const waiting = this.queue.filter((item) => !item.done).length
    if (waiting >= this.maxWaiters) {
      throw new GateError('queue_full', 'single-slot execution queue is full', { status: 429 })
    }

    const waitMs = positiveInt(timeoutMs, this.waitTimeoutMs, { min: 1, max: 3_600_000 })
    return await new Promise((resolve, reject) => {
      const waiter = {
        id: ++this.sequence,
        done: false,
        timer: null,
        signal,
        abort: null,
        resolve,
        reject,
      }
      const fail = (error) => {
        if (waiter.done) return
        waiter.done = true
        this.#cleanupWaiter(waiter)
        reject(error)
        this.#drain()
      }
      waiter.timer = setTimeout(
        () => fail(new GateError('queue_timeout', 'timed out waiting for the single upstream slot', { status: 429 })),
        waitMs,
      )
      if (signal) {
        waiter.abort = () =>
          fail(new GateError('client_aborted', 'client disconnected while queued', { status: 499, retryAfter: 0 }))
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.queue.push(waiter)
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    const pending = this.queue.splice(0)
    for (const waiter of pending) {
      if (waiter.done) continue
      waiter.done = true
      this.#cleanupWaiter(waiter)
      waiter.reject(new GateError('gateway_draining', 'single-slot gateway is draining', { status: 503 }))
    }
  }

  #releaseHandle() {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      this.#drain()
    }
  }

  #cleanupWaiter(waiter) {
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
  }

  #drain() {
    if (this.closed) return
    while (this.active < this.maxConcurrency && this.queue.length) {
      const waiter = this.queue.shift()
      if (!waiter || waiter.done) continue
      if (waiter.signal?.aborted) {
        waiter.done = true
        this.#cleanupWaiter(waiter)
        waiter.reject(
          new GateError('client_aborted', 'client disconnected while queued', { status: 499, retryAfter: 0 }),
        )
        continue
      }
      waiter.done = true
      this.#cleanupWaiter(waiter)
      this.active += 1
      waiter.resolve(this.#releaseHandle())
    }
  }
}
