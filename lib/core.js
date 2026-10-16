const zlib = require('zlib');
const crypto = require('crypto');

const CACHE_TTL_MS = 10000;

const FN_API_KEY = '16CCEB3D-AB42-077D-36A1-F355324E4237';
const FN_SIGN_SECRET = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';

function buildAuthx(pathname, payloadHash) {
    const nonce = String(Math.floor(Math.random() * 900000) + 100000);
    const ts = String(Date.now());
    const raw = [FN_SIGN_SECRET, pathname, nonce, ts, payloadHash, FN_API_KEY].join('_');
    const sign = crypto.createHash('md5').update(raw).digest('hex');
    return `nonce=${nonce}&timestamp=${ts}&sign=${sign}`;
}

// 复刻飞牛前端 GET 请求的 payload 哈希：排序后的查询参数经 URL 解码后取 MD5
function getPayloadHashFromUrl(url) {
    const u = new URL(url, 'http://localhost');
    const params = {};
    u.searchParams.forEach((v, k) => {
        if (v !== 'undefined' && v !== 'null') params[k] = v;
    });
    const sp = new URLSearchParams();
    for (const k of Object.keys(params).sort()) sp.append(k, params[k]);
    const encoded = sp.toString().replace(/\+/g, '%2B');
    try {
        return crypto.createHash('md5').update(decodeURIComponent(encoded.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'))).digest('hex');
    } catch {
        return crypto.createHash('md5').update(encoded).digest('hex');
    }
}

function decompress(buf, encoding) {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
    return buf;
}

function isPageRequest(req) {
    const url = req.url.split('?')[0];
    if (url.startsWith('/v/api/'))    return false;
    if (url.startsWith('/api/'))      return false;
    if (url.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|mp4|m3u8|ts|map)$/)) return false;
    const xReq = req.headers['x-requested-with'] || '';
    if (xReq === 'XMLHttpRequest') return false;
    const secFetch = req.headers['sec-fetch-mode'] || '';
    if (secFetch === 'cors' || secFetch === 'no-cors' || secFetch === 'same-origin') return false;
    const accept = req.headers['accept'] || '';
    return accept.includes('text/html');
}

function createVideoInfoCache() {
    const cache = new Map();

    function set(guid, info) {
        if (!guid) return;
        cache.set(guid, { info, ts: Date.now() });
    }

    function get(guid) {
        const entry = cache.get(guid);
        if (!entry) return null;
        if (Date.now() - entry.ts > CACHE_TTL_MS) {
            cache.delete(guid);
            return null;
        }
        return entry.info;
    }

    function clear() { cache.clear(); }
    return { set, get, clear, size: () => cache.size };
}

module.exports = {
    buildAuthx,
    getPayloadHashFromUrl,
    decompress,
    isPageRequest,
    createVideoInfoCache,
    CACHE_TTL_MS,
    FN_API_KEY,
    FN_SIGN_SECRET
};
