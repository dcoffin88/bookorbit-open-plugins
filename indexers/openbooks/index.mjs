/**
 * OpenBooks as a BookOrbit indexer plugin.
 *
 * OpenBooks searches IRC over the same websocket flow as its UI. This plugin opens `/ws`, asks
 * OpenBooks to join IRC, sends a search, and resolves the selected result by asking OpenBooks to
 * download it. Run OpenBooks with `--persist` so `/library/<file>` can serve the resolved file.
 *
 * OpenBooks can download files from IRC users and can expose copyrighted works. Install only where
 * your use of the configured source and resolved files is lawful for you.
 */

const WS_PATH = '/ws';
const SERVERS_PATH = '/servers';
const MESSAGE_STATUS = 0;
const MESSAGE_CONNECT = 1;
const MESSAGE_SEARCH = 2;
const MESSAGE_DOWNLOAD = 3;
const MESSAGE_RATELIMIT = 4;
const MAX_RESULTS = 50;
const USER_AGENT = 'BookOrbit';
const DEFAULT_SEARCH_TIMEOUT_SECONDS = 90;
const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 180;

const DEFAULT_EXTENSIONS = ['epub', 'pdf', 'mobi', 'azw3'];
const FORMAT_OPTIONS = ['epub', 'pdf', 'mobi', 'azw3', 'txt', 'rtf', 'html', 'htm', 'zip', 'rar'];

export default {
  apiVersion: 1,
  version: '1.0.0',
  type: 'openbooks',
  label: 'OpenBooks',
  requiresCredential: false,
  credentialKind: null,
  mediaKinds: ['ebook'],
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: 'http://localhost:8080',
  baseUrlHint: 'Your OpenBooks server URL, for example http://192.168.86.150:6081. Run OpenBooks with --persist.',
  settingsFields: [
    {
      key: 'extensions',
      type: 'string',
      label: 'Extensions',
      hint: 'Only live OpenBooks search results with these extensions are listed.',
      format: 'list',
      options: FORMAT_OPTIONS,
      minItems: 1,
      default: DEFAULT_EXTENSIONS.join(', '),
    },
    {
      key: 'searchTimeoutSeconds',
      type: 'number',
      label: 'Search timeout',
      hint: 'How long to wait for OpenBooks IRC search results.',
      default: DEFAULT_SEARCH_TIMEOUT_SECONDS,
    },
    {
      key: 'downloadTimeoutSeconds',
      type: 'number',
      label: 'Download timeout',
      hint: 'How long to wait for OpenBooks to fetch the selected file before BookOrbit downloads it from /library.',
      default: DEFAULT_DOWNLOAD_TIMEOUT_SECONDS,
    },
    {
      key: 'libraryToken',
      type: 'string',
      label: 'Library token',
      hint: 'Optional token for OpenBooks /library URLs when the server is started with --library-token.',
      default: '',
    },
  ],

  async search(query, config, host, signal) {
    if (query.mediaKind !== 'ebook') return [];

    const extensions = listSetting(config, 'extensions', DEFAULT_EXTENSIONS, FORMAT_OPTIONS);
    if (extensions.length === 0) return [];

    const books = await websocketSearch(config, host, signal, query.isbn13 || host.buildSearchText(query));
    if (signal.aborted) return [];

    const releases = [];
    const seen = new Set();
    for (const book of books) {
      if (releases.length >= Math.min(query.limit, MAX_RESULTS)) break;
      const release = toRelease(book, config, extensions);
      if (!release || seen.has(release.guid)) continue;
      seen.add(release.guid);
      releases.push(release);
    }
    return releases;
  },

  async test(config, host) {
    try {
      await websocketConnect(config, host, AbortSignal.timeout(5000));
      return { success: true, indexerName: 'OpenBooks' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async resolveFile(release, config, host) {
    const downloadPath = await websocketDownload(config, host, AbortSignal.timeout(integerSetting(config, 'downloadTimeoutSeconds', DEFAULT_DOWNLOAD_TIMEOUT_SECONDS) * 1000), release.guid);
    const url = addLibraryToken(safeUrl(downloadPath, config.baseUrl), config);
    if (!url) throw host.fail('error', `lists "${release.title}" with no downloadable OpenBooks library link`);
    return {
      url,
      fileName: fileNameFromUrl(url) || `${sanitizeName(release.bookTitle ?? release.title)}.${release.format || 'bin'}`,
      sizeBytes: release.sizeBytes,
      format: release.format || extensionFromName(url) || 'bin',
    };
  },
};

async function websocketConnect(config, host, signal) {
  await checkReachable(config, host);
  const socket = openSocket(config, host);
  try {
    await waitForOpen(socket, host, signal, 5000);
    socket.send(JSON.stringify({ type: MESSAGE_CONNECT, payload: {} }));
    await waitForMessage(
      socket,
      host,
      signal,
      15000,
      (message) => {
        if (message.type === MESSAGE_CONNECT) return true;
        if (message.type === MESSAGE_STATUS && message.appearance === 3) throw host.fail('unreachable', message.title || 'Unable to connect to IRC server');
        return false;
      },
      'did not confirm the IRC connection in time',
    );
  } finally {
    closeSocket(socket);
  }
}

async function websocketSearch(config, host, signal, queryText) {
  await checkReachable(config, host);
  const socket = openSocket(config, host);
  try {
    await waitForOpen(socket, host, signal, 5000);
    socket.send(JSON.stringify({ type: MESSAGE_CONNECT, payload: {} }));
    await waitForMessage(socket, host, signal, 15000, (message) => message.type === MESSAGE_CONNECT, 'did not confirm the IRC connection in time');
    socket.send(JSON.stringify({ type: MESSAGE_SEARCH, payload: { query: queryText } }));

    const response = await waitForMessage(
      socket,
      host,
      signal,
      integerSetting(config, 'searchTimeoutSeconds', DEFAULT_SEARCH_TIMEOUT_SECONDS) * 1000,
      (message) => {
        if (message.type === MESSAGE_SEARCH) return message;
        if (message.type === MESSAGE_RATELIMIT) throw host.fail('throttled', message.detail || message.title || 'is rate limiting us');
        if (message.type === MESSAGE_STATUS && message.appearance === 3) throw host.fail('error', message.title || 'OpenBooks search failed');
        return false;
      },
      'did not return search results in time',
    );
    return Array.isArray(response.books) ? response.books : [];
  } finally {
    closeSocket(socket);
  }
}

async function websocketDownload(config, host, signal, book) {
  await checkReachable(config, host);
  const socket = openSocket(config, host);
  try {
    await waitForOpen(socket, host, signal, 5000);
    socket.send(JSON.stringify({ type: MESSAGE_CONNECT, payload: {} }));
    await waitForMessage(socket, host, signal, 15000, (message) => message.type === MESSAGE_CONNECT, 'did not confirm the IRC connection in time');
    socket.send(JSON.stringify({ type: MESSAGE_DOWNLOAD, payload: { book } }));

    const response = await waitForMessage(
      socket,
      host,
      signal,
      integerSetting(config, 'downloadTimeoutSeconds', DEFAULT_DOWNLOAD_TIMEOUT_SECONDS) * 1000,
      (message) => {
        if (message.type === MESSAGE_DOWNLOAD) return message;
        if (message.type === MESSAGE_STATUS && message.appearance === 3) throw host.fail('error', message.title || 'OpenBooks download failed');
        return false;
      },
      'did not finish downloading the selected file in time',
    );

    const downloadPath = typeof response.downloadPath === 'string' ? response.downloadPath.trim() : '';
    if (!downloadPath) throw host.fail('error', 'downloaded the file but did not publish a /library path; run OpenBooks without --no-browser-downloads');
    return downloadPath;
  } finally {
    closeSocket(socket);
  }
}

async function checkReachable(config, host) {
  const url = httpUrl(config, SERVERS_PATH);
  let response;
  try {
    response = await host.fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') throw host.fail('timeout', 'did not answer in time');
    throw host.fail('unreachable', `could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status === 404) throw host.fail('error', 'does not look like an OpenBooks server');
  if (response.status === 429) throw host.fail('throttled', 'is rate limiting us');
  if (!response.ok) throw host.fail('error', `answered ${response.status}`);
}

function openSocket(config, host) {
  const Socket = globalThis.WebSocket;
  if (typeof Socket !== 'function') {
    throw host.fail('error', 'needs a plugin runtime with WebSocket support for OpenBooks live search');
  }

  try {
    return new Socket(websocketUrl(config));
  } catch (error) {
    throw host.fail('unreachable', `could not open the OpenBooks websocket: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function addLibraryToken(rawUrl, config) {
  const token = stringSetting(config, 'libraryToken');
  if (!rawUrl || !token) return rawUrl;

  const url = new URL(rawUrl);
  url.searchParams.set('libraryToken', token);
  return url.href;
}

function httpUrl(config, path) {
  const base = new URL(config.baseUrl);
  return new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base).href;
}

function websocketUrl(config) {
  const base = new URL(config.baseUrl);
  const url = new URL(`${base.pathname.replace(/\/+$/, '')}${WS_PATH}`, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function waitForOpen(socket, host, signal, timeoutMs) {
  if (socket.readyState === 1) return Promise.resolve();
  return withSocketWait(
    socket,
    signal,
    timeoutMs,
    (resolve, reject, cleanup) => {
      cleanup.on('open', () => {
        cleanup();
        resolve();
      });
      cleanup.on('error', () => {
        cleanup();
        reject(host.fail('unreachable', 'could not connect to the OpenBooks websocket'));
      });
    },
    () => host.fail('timeout', 'did not open the OpenBooks websocket in time'),
  );
}

function waitForMessage(socket, host, signal, timeoutMs, accept, timeoutMessage) {
  return withSocketWait(
    socket,
    signal,
    timeoutMs,
    (resolve, reject, cleanup) => {
      cleanup.on('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          cleanup();
          reject(host.fail('error', 'sent a websocket message that was not JSON'));
          return;
        }

        try {
          const accepted = accept(message);
          if (accepted) {
            cleanup();
            resolve(accepted === true ? message : accepted);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      cleanup.on('error', () => {
        cleanup();
        reject(host.fail('unreachable', 'lost the OpenBooks websocket'));
      });
      cleanup.on('close', () => {
        cleanup();
        reject(host.fail('unreachable', 'closed the OpenBooks websocket before answering'));
      });
    },
    () => host.fail('timeout', timeoutMessage),
  );
}

function withSocketWait(socket, signal, timeoutMs, attach, timeoutError) {
  return new Promise((resolve, reject) => {
    const cleanupFns = [];
    const cleanup = () => {
      clearTimeout(timer);
      for (const fn of cleanupFns.splice(0)) fn();
    };
    cleanup.on = (type, listener) => {
      socket.addEventListener(type, listener);
      cleanupFns.push(() => socket.removeEventListener?.(type, listener));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(timeoutError());
    }, timeoutMs);

    const abort = () => {
      cleanup();
      reject(Object.assign(new Error('aborted'), { code: 'timeout' }));
    };
    signal.addEventListener('abort', abort, { once: true });
    cleanupFns.push(() => signal.removeEventListener('abort', abort));

    attach(resolve, reject, cleanup);
  });
}

function closeSocket(socket) {
  try {
    socket.close?.();
  } catch {
    // Nothing useful to do after the work is already done.
  }
}

function toRelease(book, config, extensions) {
  if (!book || typeof book !== 'object') return null;
  const guid = typeof book.full === 'string' ? book.full.trim() : '';
  const title = typeof book.title === 'string' ? book.title.trim() : '';
  const author = typeof book.author === 'string' && book.author.trim() ? book.author.trim() : undefined;
  const server = typeof book.server === 'string' && book.server.trim() ? book.server.trim() : undefined;
  const format = typeof book.format === 'string' ? book.format.trim().toLowerCase() : '';
  if (!guid || !title || !format || !extensions.includes(format)) return null;

  return {
    guid,
    title,
    bookTitle: title,
    downloadUrl: null,
    sizeBytes: parseSize(book.size),
    seeders: null,
    leechers: null,
    format,
    ...(author ? { author } : {}),
    ...(server ? { indexerFlags: { server } } : {}),
    freeleech: true,
    primaryFileCount: 1,
  };
}

function integerSetting(config, key, fallback) {
  const value = Number(config.settings?.[key] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringSetting(config, key) {
  const value = config.settings?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function parseSize(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  return Math.round(Number(match[1]) * multipliers[unit]);
}

function listSetting(config, key, fallback, allowed) {
  const raw = typeof config.settings?.[key] === 'string' ? config.settings[key] : fallback.join(',');
  const out = [];
  for (const item of raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)) {
    if (allowed.includes(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

function safeUrl(raw, baseUrl) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function extensionFromName(name) {
  return /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(String(name).trim())?.[1].toLowerCase();
}

function fileNameFromUrl(raw) {
  try {
    const name = decodeURIComponent(new URL(raw).pathname.split('/').filter(Boolean).at(-1) ?? '');
    return name || undefined;
  } catch {
    return undefined;
  }
}

function sanitizeName(title) {
  return (
    title
      .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'book'
  );
}
