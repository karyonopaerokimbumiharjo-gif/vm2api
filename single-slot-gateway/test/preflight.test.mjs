import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { auditSingleSlotProject } from '../src/preflight.mjs'

function fixture({ active = 'vm-01', otherSchedulable = false, concurrency = 2, proxy = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'single-slot-preflight-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(path.join(vms, 'vm-01', 'cli-home'), { recursive: true })
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: active }))
  fs.writeFileSync(
    path.join(vms, 'vm-01.json'),
    JSON.stringify({
      id: 'vm-01',
      schedulable: true,
      status: 'ready',
      proxy: proxy ? { id: 'proxy-01', url: 'socks5://proxy.invalid:1080' } : null,
      policy: { maxConcurrency: concurrency },
    }),
  )
  fs.writeFileSync(
    path.join(vms, 'vm-02.json'),
    JSON.stringify({ id: 'vm-02', schedulable: otherSchedulable, status: 'ready', policy: { maxConcurrency: 2 } }),
  )
  return root
}

test('accepts one active schedulable target with matching concurrency and proxy', () => {
  const root = fixture()
  const result = auditSingleSlotProject({
    projectRoot: root,
    vmId: 'vm-01',
    maxConcurrency: 2,
    requireProxy: true,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.schedulable_vms, ['vm-01'])
})

test('rejects multiple schedulable slots', () => {
  const root = fixture({ otherSchedulable: true })
  const result = auditSingleSlotProject({
    projectRoot: root,
    vmId: 'vm-01',
    maxConcurrency: 2,
    requireProxy: true,
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /exactly one schedulable VM/)
})

test('rejects concurrency mismatch and missing proxy', () => {
  const root = fixture({ concurrency: 4, proxy: false })
  const result = auditSingleSlotProject({
    projectRoot: root,
    vmId: 'vm-01',
    maxConcurrency: 2,
    requireProxy: true,
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /maxConcurrency/)
  assert.match(result.errors.join(' '), /no bound remote proxy/)
})

test('allows fixed local egress when proxy requirement is disabled', () => {
  const root = fixture({ proxy: false })
  const result = auditSingleSlotProject({
    projectRoot: root,
    vmId: 'vm-01',
    maxConcurrency: 2,
    requireProxy: false,
  })
  assert.equal(result.ok, true)
})

test('rejects px-local when a remote proxy is required', () => {
  const root = fixture()
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.proxy = { id: 'px-local', scheme: 'local' }
  fs.writeFileSync(file, JSON.stringify(vm))
  const result = auditSingleSlotProject({
    projectRoot: root,
    vmId: 'vm-01',
    maxConcurrency: 2,
    requireProxy: true,
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /no bound remote proxy/)
})

test('accepts top-level proxy_id as a bound remote proxy', () => {
  const root = fixture()
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete vm.proxy
  vm.proxy_id = 'px-remote-01'
  fs.writeFileSync(file, JSON.stringify(vm))
  const result = auditSingleSlotProject({
    projectRoot: root,
    vmId: 'vm-01',
    maxConcurrency: 2,
    requireProxy: true,
  })
  assert.equal(result.ok, true)
})
