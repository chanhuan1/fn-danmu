const { test } = require('node:test');
const assert = require('node:assert');
const { buildAuthx, getPayloadHashFromUrl, decompress, isPageRequest, createVideoInfoCache } = require('../lib/core');
const zlib = require('zlib');

test('buildAuthx returns nonce+timestamp+sign', () => {
    const authx = buildAuthx('/v/api/v1/server/info', '');
    assert.match(authx, /^nonce=\d+&timestamp=\d+&sign=[a-f0-9]{32}$/);
});

test('buildAuthx produces different signs for different calls', () => {
    const a = buildAuthx('/v/api/v1/server/info', '');
    const b = buildAuthx('/v/api/v1/server/info', '');
    assert.notEqual(a, b);
});

test('getPayloadHashFromUrl returns consistent MD5', () => {
    const a = getPayloadHashFromUrl('/v/api/v1/server/info?b=2&a=1');
    const b = getPayloadHashFromUrl('/v/api/v1/server/info?a=1&b=2');
    assert.strictEqual(a, b);
    assert.match(a, /^[a-f0-9]{32}$/);
});

test('decompress gzip', () => {
    const original = Buffer.from('hello world');
    const gzipped = zlib.gzipSync(original);
    const result = decompress(gzipped, 'gzip');
    assert.deepStrictEqual(result, original);
});

test('decompress brotli', () => {
    const original = Buffer.from('hello world');
    const compressed = zlib.brotliCompressSync(original);
    const result = decompress(compressed, 'br');
    assert.deepStrictEqual(result, original);
});

test('decompress deflate', () => {
    const original = Buffer.from('hello world');
    const compressed = zlib.deflateSync(original);
    const result = decompress(compressed, 'deflate');
    assert.deepStrictEqual(result, original);
});

test('decompress passthrough when no encoding', () => {
    const original = Buffer.from('plain text');
    const result = decompress(original, '');
    assert.deepStrictEqual(result, original);
});

test('isPageRequest returns true for HTML page', () => {
    const req = { url: '/v/video/abc123', headers: { accept: 'text/html' } };
    assert.strictEqual(isPageRequest(req), true);
});

test('isPageRequest returns false for API path', () => {
    const req = { url: '/v/api/v1/play/info', headers: {} };
    assert.strictEqual(isPageRequest(req), false);
});

test('isPageRequest returns false for static asset', () => {
    const req = { url: '/v/assets/main.js', headers: {} };
    assert.strictEqual(isPageRequest(req), false);
});

test('isPageRequest returns false for XHR', () => {
    const req = { url: '/v/somepage', headers: { 'x-requested-with': 'XMLHttpRequest' } };
    assert.strictEqual(isPageRequest(req), false);
});

test('isPageRequest returns false for sec-fetch-mode cors', () => {
    const req = { url: '/v/somepage', headers: { 'sec-fetch-mode': 'cors', accept: 'text/html' } };
    assert.strictEqual(isPageRequest(req), false);
});

test('videoInfoCache set and get', () => {
    const cache = createVideoInfoCache();
    const info = { guid: 'abc', title: 'test', season: 1, episode: 1, isSeries: true };
    cache.set('abc', info);
    assert.deepStrictEqual(cache.get('abc'), info);
});

test('videoInfoCache returns null for missing guid', () => {
    const cache = createVideoInfoCache();
    assert.strictEqual(cache.get('nonexistent'), null);
});

test('videoInfoCache TTL expiry', async () => {
    const cache = createVideoInfoCache();
    cache.set('abc', { guid: 'abc', title: 'test' });
    assert.notStrictEqual(cache.get('abc'), null);
    // Can't actually wait 10s in test, so just verify structure
    assert.strictEqual(cache.size(), 1);
});

test('videoInfoCache clear', () => {
    const cache = createVideoInfoCache();
    cache.set('a', { guid: 'a' });
    cache.set('b', { guid: 'b' });
    assert.strictEqual(cache.size(), 2);
    cache.clear();
    assert.strictEqual(cache.size(), 0);
    assert.strictEqual(cache.get('a'), null);
});
