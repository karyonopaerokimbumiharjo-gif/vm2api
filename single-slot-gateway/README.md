# vm2api Single-Slot Gateway

A fail-closed sidecar for the following deployment:

```text
many Sub2API users
        │
        ▼
     Sub2API
        │ one internal upstream account
        ▼
Single-Slot Gateway ── bounded concurrency / FIFO queue
        │ one managed sk-vm-* key
        ▼
     vm2api
        │ exactly one schedulable VM slot
        ▼
one upstream account + one persistent HOME + one fixed egress
```

The sidecar exists because vm2api's `x-kin-vm` header is a master-key diagnostic facility. This gateway **does not** use that header and strips it from inbound requests. The target vm2api instance must expose exactly one schedulable slot. A read-only preflight check enforces that invariant before start and again before every inference request.

## What it guarantees

- One configured vm2api slot is active and schedulable.
- `policy.maxConcurrency` matches the sidecar's `MAX_CONCURRENCY`.
- Excess calls wait in a bounded FIFO queue.
- Client cancellation removes queued work and aborts the upstream request.
- The Sub2API-facing key is replaced with a managed `sk-vm-*` key.
- Admin, panel, diagnostic pin, and backend-selection headers are never forwarded.
- Existing opaque session headers are preserved; an opaque request session is generated when none is supplied.
- Streaming responses are passed through without buffering.
- Configuration drift fails closed when `PREFLIGHT_REQUIRED=1`.

## What it does not do

It does not emulate a human, forge hardware identity, randomize timing, hide actual concurrency, or guarantee how an upstream provider classifies the traffic. It only creates a stable single execution boundary.

## Required configuration

| Variable | Meaning | Default |
|---|---|---:|
| `VM2API_BASE_URL` | Internal vm2api root URL | required |
| `SINGLE_SLOT_VM_ID` | Expected vm2api slot ID | required |
| `VM2API_PROJECT_ROOT` | Read-only vm2api project mount used for preflight | required when preflight is enabled |
| `INBOUND_API_KEY` / `_FILE` | Secret used by Sub2API to call this sidecar | required |
| `VM2API_UPSTREAM_KEY` / `_FILE` | Managed `sk-vm-*` key used to call vm2api | required |
| `MAX_CONCURRENCY` | Simultaneous requests admitted to the slot | `2` |
| `MAX_WAITERS` | Maximum queued requests | `32` |
| `QUEUE_TIMEOUT_MS` | Maximum queue wait | `120000` |
| `UPSTREAM_IDLE_TIMEOUT_MS` | Idle timeout while talking to vm2api | `180000` |
| `PREFLIGHT_REQUIRED` | Refuse to start/serve if invariant cannot be verified | `true` |
| `ALLOW_LOCAL_EGRESS` | Permit a slot without a bound proxy | `false` |
| `TRUST_INBOUND_SESSION` | Preserve opaque inbound session IDs | `true` |

Use `*_FILE` with Docker secrets in production. Do not give the sidecar vm2api's master admin key.

## Exposed routes

Only these API routes are proxied:

- `GET /v1/models`
- `GET /v1/usage`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- compatible aliases without `/v1`

Local endpoints:

- `GET /health`: queue and preflight snapshot
- `GET /ready`: preflight plus vm2api health probe

Panel and admin routes are deliberately unavailable.

## Run

```bash
cp .env.example .env
set -a; . ./.env; set +a
npm test
npm start
```

For deployment, use `deploy/docker-compose.single-slot.yml` from the repository root.
