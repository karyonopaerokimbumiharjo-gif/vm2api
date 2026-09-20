import fs from 'node:fs'
import path from 'node:path'

const HARD_UNAVAILABLE = new Set(['dead', 'error', 'disabled'])

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function proxyDescriptor(vm) {
  if (vm?.proxy) return vm.proxy
  if (vm?.proxy_id) return { id: vm.proxy_id }
  return null
}

function isLocalEgress(proxy) {
  if (!proxy || typeof proxy !== 'object') return false
  const id = String(proxy.id || '').trim().toLowerCase()
  const scheme = String(proxy.scheme || proxy.kind || '').trim().toLowerCase()
  const host = String(proxy.host || '').trim().toLowerCase()
  return id === 'px-local' || scheme === 'local' || host === 'local'
}

function hasBoundRemoteProxy(vm) {
  const proxy = proxyDescriptor(vm)
  if (!proxy) return false
  if (typeof proxy === 'string') return proxy.trim().length > 0
  if (typeof proxy !== 'object' || isLocalEgress(proxy)) return false
  return Boolean(proxy.url || proxy.endpoint || proxy.socks5 || proxy.host || proxy.id)
}

function isSchedulable(vm) {
  if (!vm || vm.schedulable === false) return false
  return !HARD_UNAVAILABLE.has(String(vm.status || '').toLowerCase())
}

export function auditSingleSlotProject({ projectRoot, vmId, maxConcurrency, requireProxy = true } = {}) {
  const root = path.resolve(String(projectRoot || ''))
  const vmsDir = path.join(root, 'vms')
  const errors = []
  const warnings = []

  if (!projectRoot || !fs.existsSync(vmsDir)) {
    return { ok: false, vm_id: vmId || null, errors: ['VM project vms directory is not readable'], warnings }
  }

  let activeId = null
  try {
    activeId = readJson(path.join(vmsDir, 'active.json')).active_vm || null
  } catch (error) {
    errors.push(`active.json is invalid: ${error.message}`)
  }

  const vms = []
  for (const name of fs.readdirSync(vmsDir)) {
    if (!name.endsWith('.json') || name === 'active.json') continue
    try {
      const vm = readJson(path.join(vmsDir, name))
      if (vm?.id) vms.push(vm)
    } catch (error) {
      errors.push(`${name} is invalid: ${error.message}`)
    }
  }

  const target = vms.find((vm) => vm.id === vmId) || null
  const schedulable = vms.filter(isSchedulable)
  if (!target) errors.push(`configured slot '${vmId}' does not exist`)
  if (activeId !== vmId) errors.push(`active VM is '${activeId || 'unset'}', expected '${vmId}'`)
  if (schedulable.length !== 1 || schedulable[0]?.id !== vmId) {
    errors.push(`exactly one schedulable VM is required; found: ${schedulable.map((vm) => vm.id).join(', ') || 'none'}`)
  }

  if (target) {
    const actualConcurrency = Number(target.policy?.maxConcurrency)
    if (actualConcurrency !== Number(maxConcurrency)) {
      errors.push(
        `slot policy.maxConcurrency is ${Number.isFinite(actualConcurrency) ? actualConcurrency : 'unset'}, expected ${maxConcurrency}`,
      )
    }
    if (requireProxy && !hasBoundRemoteProxy(target)) {
      errors.push('target slot has no bound remote proxy while proxy mode is required')
    }
    const cliHome = path.join(vmsDir, vmId, 'cli-home')
    if (!fs.existsSync(cliHome)) warnings.push(`slot cli-home is not present at ${cliHome}`)
  }

  return {
    ok: errors.length === 0,
    vm_id: vmId,
    active_vm: activeId,
    schedulable_vms: schedulable.map((vm) => vm.id),
    require_proxy: requireProxy,
    expected_max_concurrency: Number(maxConcurrency),
    errors,
    warnings,
  }
}
