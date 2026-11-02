import type { Deps, RpcAs } from '../_shared/env.ts'

/** Ψεύτικο fetch: καταγράφει τις κλήσεις, απαντά από κανόνες (με τη σειρά) */
export interface Call { url: string; method: string; headers: Record<string, string>; body: string }

export function fakeFetch(routes: [RegExp | string, (c: Call) => Response | Promise<Response>][]) {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers ?? {}).forEach((v, k) => { headers[k] = v })
    const body = init?.body == null ? '' : init.body instanceof URLSearchParams ? init.body.toString() : String(init.body)
    const c = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body }
    calls.push(c)
    for (const [m, h] of routes) {
      if (typeof m === 'string' ? url.startsWith(m) : m.test(`${c.method} ${url}`)) return h(c)
    }
    return new Response(`no route for ${c.method} ${url}`, { status: 599 })
  }) as typeof fetch
  return { fetch: f, calls }
}

export const jsonRes = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })

/** Ψεύτικη βάση: κάθε RPC απαντά από χάρτη (τιμή ή συνάρτηση) */
export function fakeRpc(map: Record<string, unknown | ((args: Record<string, unknown>, as: RpcAs) => unknown)>) {
  const calls: { name: string; args: Record<string, unknown>; as: RpcAs }[] = []
  const rpc = (async (name: string, args: Record<string, unknown>, as: RpcAs) => {
    calls.push({ name, args, as })
    if (!(name in map)) throw new Error(`unexpected rpc ${name}`)
    const v = map[name]
    return typeof v === 'function' ? await (v as (a: Record<string, unknown>, as: RpcAs) => unknown)(args, as) : v
  }) as Deps['rpc']
  return { rpc, calls }
}

export function deps(rpc: Deps['rpc'], f: typeof fetch, now = 1_800_000_000_000): Deps {
  return { rpc, fetch: f, site: () => 'https://pizza.example', now: () => now }
}

export const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://fn.example/x', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } })
