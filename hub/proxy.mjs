// Behind a company proxy, curl and Invoke-WebRequest go through it, but Node's fetch does not by
// itself: the voice download would fail with a bare "fetch failed". When HTTPS_PROXY or HTTP_PROXY
// (any case) is set, Node is told to use it: NODE_USE_ENV_PROXY=1 on a Node that honors it (22.21+
// and 24+), with the hub's own address kept off the proxy. An older Node has no built-in way: the
// installers then bring their own Node.js (24), which the mod runs first.

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
// The hub and the voice engine listen here: never through a proxy.
const LOCAL = ['127.0.0.1', 'localhost', '::1']

export function proxyFrom(env = process.env) {
  for (const name of PROXY_VARS) if (env[name]?.trim()) return env[name].trim()
  return ''
}

// Whether this Node reads the proxy from the environment when NODE_USE_ENV_PROXY=1.
export function honorsEnvProxy(versions = process.versions) {
  const [major, minor] = String(versions.node ?? '').split('.').map(Number)
  return major >= 24 || (major === 22 && minor >= 21)
}

// NO_PROXY with the local addresses added, keeping what the user set.
export function noProxyWithLocal(env = process.env) {
  const given = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return [...new Set([...given, ...LOCAL])].join(',')
}

// What a child Node's environment needs so its fetch uses the proxy and never sends the hub's own
// address through it. Empty when no proxy is set, or when this Node cannot use one.
export function proxyEnv(env = process.env, versions = process.versions) {
  if (!proxyFrom(env) || !honorsEnvProxy(versions)) return {}
  const noProxy = noProxyWithLocal(env)
  return { NODE_USE_ENV_PROXY: '1', NO_PROXY: noProxy, no_proxy: noProxy }
}
