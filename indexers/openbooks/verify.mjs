/**
 * Exercises the OpenBooks plugin against a mocked websocket flow patterned after OpenBooks server
 * mode: CONNECT, SEARCH, DOWNLOAD, and RATELIMIT messages.
 *
 * Run with: node verify.mjs
 */
import plugin from './index.mjs';

let pass = 0;
let fail = 0;
const ok = (name, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
};

function makeHost(responder = () => new Response('')) {
  const reqs = [];
  return {
    reqs,
    get calls() {
      return reqs.map((entry) => entry.url);
    },
    fetch: async (url, init) => {
      reqs.push({ url, init });
      return responder(url, init);
    },
    logger: { log: () => {}, warn: () => {} },
    buildSearchText: (q) => [q.title, q.author].filter(Boolean).join(' '),
    saveCredential: async () => {},
    fail: (code, message) => Object.assign(new Error(message), { code }),
  };
}

const cfg = (over = {}) => ({
  id: 7,
  name: 'OpenBooks',
  priority: 1,
  baseUrl: 'http://openbooks.example',
  credential: null,
  allowPrivateAddress: true,
  categories: { ebook: [], audiobook: [], comic: [] },
  settings: null,
  ...over,
});
const query = (over = {}) => ({ title: 'Sometimes I Lie', author: 'Alice Feeney', isbn13: null, isbn13s: [], mediaKind: 'ebook', language: null, limit: 30, ...over });
const search = (host, over = {}, config = cfg()) => plugin.search(query(over), config, host, AbortSignal.timeout(5000));

const BOOKS = [
  {
    server: 'Ook',
    author: 'Alice Feeney',
    title: 'Sometimes I Lie',
    format: 'epub',
    size: '1.7MB',
    full: '!Ook Alice Feeney - Sometimes I Lie.epub',
  },
  {
    server: 'Oatmeal',
    author: 'Alice Feeney',
    title: 'Sometimes I Lie',
    format: 'pdf',
    size: '2.5MB',
    full: '!Oatmeal Alice Feeney - Sometimes I Lie.pdf',
  },
  {
    server: 'Images',
    author: 'Alice Feeney',
    title: 'Sometimes I Lie Cover',
    format: 'jpg',
    size: '90KB',
    full: '!Images Alice Feeney - Sometimes I Lie Cover.jpg',
  },
];

class MockWebSocket {
  static instances = [];
  static scenario = {};
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.emit('open', {});
    }, 0);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.type === 1) {
      setTimeout(() => this.emit('message', { data: JSON.stringify({ type: 1, appearance: 1, title: 'Welcome', name: 'BookOrbit' }) }), 0);
    }
    if (message.type === 2) {
      if (MockWebSocket.scenario.rateLimit) {
        setTimeout(() => this.emit('message', { data: JSON.stringify({ type: 4, appearance: 2, title: 'Wait', detail: 'Please wait 10 seconds.' }) }), 0);
      } else {
        setTimeout(() => this.emit('message', { data: JSON.stringify({ type: 2, appearance: 1, title: 'Results', books: BOOKS, errors: [] }) }), 0);
      }
    }
    if (message.type === 3) {
      setTimeout(() => this.emit('message', { data: JSON.stringify({ type: 3, appearance: 1, title: 'Done', downloadPath: 'library/Sometimes%20I%20Lie.epub' }) }), 0);
    }
  }

  close() {
    this.readyState = 3;
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const realWebSocket = globalThis.WebSocket;
globalThis.WebSocket = MockWebSocket;

console.log('declaration');
ok('needs no credential', plugin.requiresCredential === false && plugin.credentialKind === null);
ok('carries ebooks and nothing else', JSON.stringify(plugin.mediaKinds) === '["ebook"]');
ok('joins no swarm and uses no categories', plugin.seedsBack === false && plugin.usesCategories === false);
ok('targets the contract this build speaks', plugin.apiVersion === 1);
ok('plugin version', plugin.version === '1.1.1');
ok('defaults to localhost', plugin.defaultBaseUrl === 'http://localhost:8080');
ok('offers timeout settings', plugin.settingsFields.some((field) => field.key === 'searchTimeoutSeconds') && plugin.settingsFields.some((field) => field.key === 'downloadTimeoutSeconds'));
ok('offers a library token setting', plugin.settingsFields.some((field) => field.key === 'libraryToken'));

console.log('websocket search');
{
  MockWebSocket.instances = [];
  MockWebSocket.scenario = {};
  const host = makeHost();
  const out = await search(host);
  const socket = MockWebSocket.instances[0];
  ok('checks the OpenBooks server through host.fetch first', host.calls[0] === 'http://openbooks.example/servers');
  ok('connects to the OpenBooks websocket', socket.url === 'ws://openbooks.example/ws');
  ok('sends connect then search', JSON.stringify(socket.sent.map((message) => message.type)) === '[1,2]');
  ok('sends title and author as one query', socket.sent[1].payload.query === 'Sometimes I Lie Alice Feeney');
  ok('maps OpenBooks books to releases', out.length === 2 && out[0].title === 'Sometimes I Lie');
  ok('uses the full request line as guid', out[0].guid === '!Ook Alice Feeney - Sometimes I Lie.epub');
  ok('reads author, server and format', out[0].author === 'Alice Feeney' && out[0].indexerFlags.server === 'Ook' && out[0].format === 'epub');
  ok('parses sizes', out[0].sizeBytes === 1_782_579 && out[1].sizeBytes === 2_621_440);
  ok('filters unsupported formats', !out.some((release) => release.format === 'jpg'));
}
{
  const host = makeHost();
  MockWebSocket.instances = [];
  const out = await search(host, {}, cfg({ baseUrl: 'http://openbooks.example/openbooks/' }));
  ok('honors an OpenBooks base path', MockWebSocket.instances[0].url === 'ws://openbooks.example/openbooks/ws' && out.length === 2);
  ok('checks the matching server-list path', host.calls[0] === 'http://openbooks.example/openbooks/servers');
}
{
  MockWebSocket.instances = [];
  const out = await search(makeHost(), { limit: 1 });
  ok('honors the requested limit', out.length === 1);
}
{
  const out = await search(makeHost(), { mediaKind: 'audiobook' });
  ok('ignores non-ebook requests', out.length === 0);
}
{
  const out = await search(makeHost(), {}, cfg({ settings: { extensions: 'pdf' } }));
  ok('honors configured extensions', out.length === 1 && out[0].format === 'pdf');
}

console.log('resolveFile()');
{
  MockWebSocket.instances = [];
  const host = makeHost();
  const [release] = await search(host);
  const file = await plugin.resolveFile(release, cfg(), host);
  const downloadSocket = MockWebSocket.instances.at(-1);
  ok('opens a download websocket', JSON.stringify(downloadSocket.sent.map((message) => message.type)) === '[1,3]');
  ok('sends the OpenBooks full request line', downloadSocket.sent[1].payload.book === release.guid);
  ok('returns the OpenBooks library URL', file.url === 'http://openbooks.example/library/Sometimes%20I%20Lie.epub');
  ok('returns the downloaded file name', file.fileName === 'Sometimes I Lie.epub');
  ok('carries format and size through', file.format === 'epub' && file.sizeBytes === release.sizeBytes);
}
{
  MockWebSocket.instances = [];
  const host = makeHost();
  const [release] = await search(host);
  const file = await plugin.resolveFile(release, cfg({ settings: { libraryToken: 'secret token' } }), host);
  ok('adds the configured library token to resolved file URLs', file.url === 'http://openbooks.example/library/Sometimes%20I%20Lie.epub?libraryToken=secret+token');
}

console.log('failures');
{
  MockWebSocket.scenario = { rateLimit: true };
  const err = await search(makeHost()).catch((e) => e);
  ok('reports OpenBooks rate limits as throttled', err.code === 'throttled', err.message);
  MockWebSocket.scenario = {};
}
{
  const err = await search(makeHost(() => new Response('', { status: 404 }))).catch((e) => e);
  ok('reports a non-OpenBooks base URL', err.code === 'error' && err.message.includes('OpenBooks'), err.message);
}
{
  globalThis.WebSocket = undefined;
  const err = await search(makeHost()).catch((e) => e);
  ok('explains missing websocket support', err.code === 'error' && err.message.includes('WebSocket'), err.message);
  globalThis.WebSocket = MockWebSocket;
}

console.log('test()');
{
  const out = await plugin.test(cfg(), makeHost());
  ok('passes when the websocket connects', out.success === true && out.indexerName === 'OpenBooks');
}
{
  globalThis.WebSocket = undefined;
  const out = await plugin.test(cfg(), makeHost());
  ok('fails rather than throwing without websocket support', out.success === false && out.error.includes('WebSocket'));
  globalThis.WebSocket = MockWebSocket;
}

globalThis.WebSocket = realWebSocket;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
