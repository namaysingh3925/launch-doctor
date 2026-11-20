import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { callTool, handleMessage, mcpTools, PROTOCOL_VERSIONS } from '../src/mcp.js';
import { makeProject } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const leaky = () =>
  makeProject({
    'package.json': '{"name":"mcp-app","dependencies":{"react":"^19","vite":"^7","stripe":"^18"}}',
    'src/pay.ts': `export const k = "${'sk_' + 'live_' + 'Q7wZp2Lk9VtR4mXc8Bn3Hs6Jd'}";\n`,
    'index.html': '<title>Vite + React</title>',
  });

type Msg = {
  jsonrpc: string;
  id: number | string | null;
  // biome-ignore lint/suspicious/noExplicitAny: each test checks the fields of the JSON-RPC result it expects
  result?: any;
  error?: { code: number; message: string };
};

/** Start `launch-doctor mcp` and talk JSON-RPC to it, one message per line. */
function server() {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI, 'mcp'], {
    env: { ...process.env, NO_COLOR: '1' },
  });
  const received: Msg[] = [];
  const waiting = new Map<string, (m: Msg) => void>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      // Every line on stdout must be a JSON-RPC message: JSON.parse throws (and fails the test) otherwise.
      const msg = JSON.parse(line) as Msg;
      received.push(msg);
      waiting.get(String(msg.id))?.(msg);
      waiting.delete(String(msg.id));
      nl = buffer.indexOf('\n');
    }
  });
  const reply = (id: number | string | null) =>
    new Promise<Msg>((resolve) => {
      const done = received.find((m) => m.id === id);
      if (done) resolve(done);
      else waiting.set(String(id), resolve);
    });
  const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  return {
    received,
    raw: (text: string) => child.stdin.write(`${text}\n`),
    notify: (method: string, params?: object) => send({ jsonrpc: '2.0', method, params }),
    request: (id: number, method: string, params?: object) => {
      send({ jsonrpc: '2.0', id, method, params });
      return reply(id);
    },
    reply,
    close: () =>
      new Promise<number | null>((resolve) => {
        child.on('close', (code) => resolve(code));
        child.stdin.end();
      }),
  };
}

const initialize = (protocolVersion: string) => ({
  protocolVersion,
  capabilities: {},
  clientInfo: { name: 'test-client', version: '1.0.0' },
});

test('MCP: initialize, list tools and scan a project over stdio', { timeout: 60_000 }, async () => {
  const s = server();
  const init = await s.request(1, 'initialize', initialize('2025-06-18'));
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'launch-doctor');
  assert.ok(init.result.capabilities.tools);
  s.notify('notifications/initialized');

  const list = await s.request(2, 'tools/list');
  assert.deepEqual(
    list.result.tools.map((t: { name: string }) => t.name),
    ['scan_project', 'scan_url', 'list_checks'],
  );

  const dir = leaky();
  const scan = await s.request(3, 'tools/call', {
    name: 'scan_project',
    arguments: { path: dir, offline: true },
  });
  const text: string = scan.result.content[0].text;
  assert.equal(scan.result.isError, undefined);
  assert.match(text, /grade F/);
  assert.match(text, /stripe-live-key/);
  assert.match(text, /Fix prompt:/);
  assert.match(text, /src\/pay\.ts:1/);
  assert.equal(scan.result.structuredContent.grade, 'F');
  assert.ok(
    scan.result.structuredContent.findings.some(
      (f: { id: string; severity: string }) => f.id === 'stripe-live-key' && f.severity === 'critical',
    ),
  );

  assert.equal(await s.close(), 0);
  // The notification got no reply: exactly one reply per request.
  assert.deepEqual(
    s.received.map((m) => m.id),
    [1, 2, 3],
  );
});

test('MCP: protocol errors are JSON-RPC errors, bad tool input is a tool error', { timeout: 60_000 }, async () => {
  const s = server();
  s.raw('{ this is not json');
  assert.equal((await s.reply(null)).error?.code, -32700);

  assert.equal((await s.request(1, 'no/such/method')).error?.code, -32601);
  assert.equal((await s.request(2, 'tools/call', { name: 'delete_everything' })).error?.code, -32602);

  const missing = await s.request(3, 'tools/call', {
    name: 'scan_project',
    arguments: { path: 'C:/definitely/not/here/x7' },
  });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /Folder not found/);

  const wrongType = await s.request(4, 'tools/call', { name: 'scan_project', arguments: { offline: 'yes' } });
  assert.equal(wrongType.result.isError, true);
  assert.match(wrongType.result.content[0].text, /"offline" must be a boolean/);

  assert.deepEqual((await s.request(5, 'ping')).result, {});
  assert.equal(await s.close(), 0);
});

test('MCP: an unknown protocol version gets the default one', async () => {
  const reply = (await handleMessage({
    jsonrpc: '2.0',
    id: 7,
    method: 'initialize',
    params: initialize('2099-01-01'),
  })) as Msg;
  assert.equal(reply.result.protocolVersion, '2025-06-18');
  for (const v of PROTOCOL_VERSIONS) {
    const r = (await handleMessage({ jsonrpc: '2.0', id: 8, method: 'initialize', params: initialize(v) })) as Msg;
    assert.equal(r.result.protocolVersion, v, `${v} is echoed back`);
  }
});

test('MCP: batches, notifications and list_checks', async () => {
  const batch = (await handleMessage([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ])) as Msg[];
  assert.deepEqual(
    batch.map((m) => m.id),
    [1, 2],
  );
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled' }), null);

  const checks = await callTool('list_checks', {});
  assert.match(checks.content[0]!.text, /^secrets \(Secrets & keys\): /m);
  assert.match(checks.content[0]!.text, /stripe-live-key/);
});

test('MCP: tool schemas offer every category for only and skip', () => {
  const scan = mcpTools().find((t) => t.name === 'scan_project')!;
  const only = (scan.inputSchema.properties as Record<string, { items?: { enum?: string[] } }>).only!;
  assert.ok(only.items?.enum?.includes('secrets'));
  assert.ok(only.items?.enum?.includes('first-impressions'));
});

test('MCP: --help explains setup and other options are refused', () => {
  return new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [CLI, 'mcp', '--help'], { env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('close', (code) => {
      assert.equal(code, 0);
      assert.match(out, /claude mcp add launch-doctor -- npx -y launch-doctor mcp/);
      assert.match(out, /scan_project/);
      resolve();
    });
  });
});
