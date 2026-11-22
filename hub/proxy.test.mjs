import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { honorsEnvProxy, noProxyWithLocal, proxyEnv, proxyFrom } from './proxy.mjs'

test('a proxy set in any case is found, HTTPS first', () => {
  assert.equal(proxyFrom({}), '')
  assert.equal(proxyFrom({ http_proxy: 'http://p:3128' }), 'http://p:3128')
  assert.equal(proxyFrom({ HTTP_PROXY: 'http://a:1', https_proxy: 'http://b:2' }), 'http://b:2')
  assert.equal(proxyFrom({ HTTPS_PROXY: '  ' }), '')
})

test('Node reads the proxy from the environment from 22.21 and 24 on', () => {
  assert.equal(honorsEnvProxy({ node: '22.20.0' }), false)
  assert.equal(honorsEnvProxy({ node: '22.21.0' }), true)
  assert.equal(honorsEnvProxy({ node: '23.11.0' }), false)
  assert.equal(honorsEnvProxy({ node: '24.22.3' }), true)
  assert.equal(honorsEnvProxy({ node: '20.19.0' }), false)
})

test('with a proxy, a child Node is told to use it, and the hub on 127.0.0.1 stays off it', () => {
  const node24 = { node: '24.22.3' }
  assert.deepEqual(proxyEnv({}, node24), {})
  const env = proxyEnv({ HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'intranet.local' }, node24)
  assert.equal(env.NODE_USE_ENV_PROXY, '1')
  assert.deepEqual(env.NO_PROXY.split(','), ['intranet.local', '127.0.0.1', 'localhost', '::1'])
  assert.equal(env.no_proxy, env.NO_PROXY)
  // Already on (someone set NODE_USE_ENV_PROXY): the hub's own address is still kept off it.
  const already = { HTTPS_PROXY: 'http://proxy:8080', NODE_USE_ENV_PROXY: '1' }
  assert.equal(proxyEnv(already, node24).NO_PROXY, '127.0.0.1,localhost,::1')
  // setup.mjs starts itself again only while something is missing, so never twice.
  const child = { ...already, ...proxyEnv(already, node24) }
  assert.equal(Object.entries(proxyEnv(child, node24)).some(([name, value]) => child[name] !== value), false)
  // A Node that cannot: nothing to add (the installers bring one that can).
  assert.deepEqual(proxyEnv({ HTTPS_PROXY: 'http://proxy:8080' }, { node: '20.19.0' }), {})
  assert.equal(noProxyWithLocal({ no_proxy: 'localhost' }), 'localhost,127.0.0.1,::1')
})

test('a Node started with proxyEnv downloads through the proxy and reaches 127.0.0.1 directly', { skip: !honorsEnvProxy() }, async () => {
  const seen = []
  const proxy = createServer((req, res) => (seen.push(req.url), res.end()))
  proxy.on('connect', (req, socket) => (seen.push(`CONNECT ${req.url}`), socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')))
  const local = createServer((req, res) => res.end('direct'))
  await Promise.all([proxy, local].map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))))
  try {
    const at = `http://127.0.0.1:${proxy.address().port}`
    const code = `const far = await fetch('https://huggingface.co/x').then(() => 'ok', () => 'failed'); const near = await fetch('http://127.0.0.1:${local.address().port}/').then(r => r.text()); console.log(far, near)`
    const env = { ...process.env, HTTPS_PROXY: at, HTTP_PROXY: at, NO_PROXY: '' }
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', code], { env: { ...env, ...proxyEnv(env) }, timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())))
    })
    assert.equal(out, 'failed direct')
    assert.deepEqual(seen, ['CONNECT huggingface.co:443'])
  } finally {
    proxy.close()
    local.close()
  }
})
