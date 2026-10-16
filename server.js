const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { buildAuthx, getPayloadHashFromUrl, decompress, isPageRequest, createVideoInfoCache } = require('./lib/core');

const FN_URL = process.env.FN_URL || 'http://192.168.10.252:5666';
const DM_URL = process.env.DM_URL || 'http://192.168.10.252:9321';
const PORT   = process.env.PORT   || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const LOG_PRIORITIES = { debug: 10, info: 20, warn: 30, error: 40 };

function log(level, ...args) {
    if ((LOG_PRIORITIES[level] || 20) >= (LOG_PRIORITIES[LOG_LEVEL] || 20)) {
        console[level === 'debug' ? 'log' : level](...args);
    }
}

const isFniuHttps = FN_URL.startsWith('https');
const isDmHttps   = DM_URL.startsWith('https');

console.log(`[启动] 飞牛: ${FN_URL} (HTTPS: ${isFniuHttps})`);
console.log(`[启动] 弹幕: ${DM_URL} (HTTPS: ${isDmHttps})`);
console.log(`[启动] HTTP端口: ${PORT}  HTTPS端口: ${HTTPS_PORT}`);

// ═══ 弹幕脚本（惰性读取，支持热更新） ═══
let danmakuMtime = 0;
let danmakuScriptCache = '';

function getDanmakuScript() {
    const scriptPath = path.join(__dirname, 'danmaku.js');
    const mtime = fs.statSync(scriptPath).mtimeMs;
    if (mtime !== danmakuMtime) {
        danmakuScriptCache = fs.readFileSync(scriptPath, 'utf8');
        danmakuMtime = mtime;
        log('debug', '[脚本] 重新读取:', danmakuScriptCache.length, '字符');
    }
    return danmakuScriptCache;
}

function buildInjectTag() {
    const script = getDanmakuScript();
    return `<script>window.__DMAPI__='/dm-api';</script><script>${script}</script>`;
}

// ═══ 自签证书 ═══
function ensureCerts() {
    const certDir = path.join(__dirname, 'certs');
    const keyPath  = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        console.log('[证书] 使用已有证书');
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }

    console.log('[证书] 自动生成自签证书...');
    fs.mkdirSync(certDir, { recursive: true });
    try {
        execSync(
            `openssl req -x509 -newkey rsa:2048 -nodes ` +
            `-keyout "${keyPath}" -out "${certPath}" ` +
            `-days 3650 -subj "/CN=fn-danmaku-proxy" ` +
            `-addext "subjectAltName=IP:127.0.0.1,IP:0.0.0.0,DNS:localhost"`,
            { stdio: 'pipe' }
        );
        console.log('[证书] 生成完成');
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    } catch (e) {
        console.error('[证书] 生成失败:', e.message);
        return null;
    }
}

// ═══ 代理实例 ═══
// secure: false → 跳过后端证书验证（内网自签证书场景）
// 只有后端是 HTTPS 时才需要
const baseOpts = { changeOrigin: true, secure: false };

const fnPassthrough = httpProxy.createProxyServer({ ...baseOpts, target: FN_URL, ws: true });
// 只拦截 play/info：其他透传响应直接 pipe，避免大文件被缓冲进内存
const fnIntercept   = httpProxy.createProxyServer({ ...baseOpts, target: FN_URL });
const dmProxy       = httpProxy.createProxyServer({ ...baseOpts, target: DM_URL });

// 安全的错误处理（区分 HTTP response 和 WebSocket socket）
function safeError(err, req, res, tag) {
    log('error', `[${tag}]`, req.url, err.message);
    if (!res) return;
    // HTTP 响应对象有 writeHead，WebSocket 升级的 socket 没有
    if (typeof res.writeHead === 'function') {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: true, tag, message: err.message, url: req.url }));
        }
    } else if (typeof res.end === 'function') {
        // 是 socket，直接关闭
        try { res.end(); } catch {}
    }
}

fnPassthrough.on('error', (err, req, res) => safeError(err, req, res, '透传'));
fnIntercept.on('error', (err, req, res)   => safeError(err, req, res, '拦截'));
dmProxy.on('error', (err, req, res)       => safeError(err, req, res, '弹幕'));

let injectCount = 0;
const videoInfoCache = createVideoInfoCache();

function cacheVideoInfo(item) {
    const guid = item.guid || '';
    if (!guid) return;
    videoInfoCache.set(guid, {
        guid,
        title: item.tv_title || item.title || '',
        season: item.season_number || 1,
        episode: item.episode_number || 1,
        isSeries: !!item.tv_title
    });
    log('debug', '[视频信息] 已缓存 guid:', guid, JSON.stringify(videoInfoCache.get(guid)));
}

// 专用代理：只拦截 play/info 响应，缓冲后解析并转发
const fnPlayInfo = httpProxy.createProxyServer({ ...baseOpts, target: FN_URL });
fnPlayInfo.on('error', (err, req, res) => safeError(err, req, res, '播放信息'));
fnPlayInfo.on('proxyRes', (proxyRes, req, res) => {
    const ce = proxyRes.headers['content-encoding'] || '';
    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', () => {
        try {
            const raw = Buffer.concat(chunks);
            const body = ce ? decompress(raw, ce) : raw;
            const data = JSON.parse(body.toString('utf8'));
            if (data.code === 0 && data.data?.item) {
                cacheVideoInfo(data.data.item);
            }
        } catch(e) { log('warn', '[视频信息] 解析失败:', e.message); }
        try {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.end(raw);
        } catch {}
    });
});

// ═══ 请求判断 ═══

// ═══ 请求处理器（HTTP/HTTPS 共用） ═══
function handleRequest(req, res) {
    if (req.url.startsWith('/dm-api/video-info')) {
        const guid = new URL(req.url, 'http://localhost').searchParams.get('guid') || '';
        let info = guid ? videoInfoCache.get(guid) : null;
        if (!info && videoInfoCache.size() > 0) {
            // 兼容旧脚本未带 guid 的请求：返回最近缓存的一条
            const entries = [...videoInfoCache.entries()].sort((a, b) => b[1].ts - a[1].ts);
            info = entries[0][1].info;
        }
        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        res.end(JSON.stringify(info || {}));
        return;
    }
    if (req.url.startsWith('/dm-api/')) {
        req.url = req.url.replace('/dm-api', '');
        dmProxy.web(req, res);
        return;
    }

    // 签名预计算：为缺少 authx 的飞牛 API 请求补签名
    if (req.url.startsWith('/v/api/') && !req.headers['authx']) {
        const pathname = req.url.split('?')[0];
        const payloadHash = req.method === 'GET'
            ? getPayloadHashFromUrl(req.url)
            : crypto.createHash('md5').update('').digest('hex');
        req.headers['authx'] = buildAuthx(pathname, payloadHash);
    }

    if (isPageRequest(req)) {
        delete req.headers['if-modified-since'];
        delete req.headers['if-none-match'];
        delete req.headers['accept-encoding'];
        fnIntercept.web(req, res, { selfHandleResponse: true });
        return;
    }

    if (req.url.includes('/play/info')) {
        fnPlayInfo.web(req, res);
    } else {
        fnPassthrough.web(req, res);
    }
}

function handleUpgrade(req, socket, head) {
    fnPassthrough.ws(req, socket, head);
}

// ═══ HTML 注入 ═══
fnIntercept.on('proxyRes', (proxyRes, req, res) => {
    const ct = proxyRes.headers['content-type'] || '';
    const status = proxyRes.statusCode;

    if (status === 200 && ct.includes('text/html')) {
        const ce = proxyRes.headers['content-encoding'] || '';
        const chunks = [];
        let raw = Buffer.alloc(0);
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
            try {
                raw = Buffer.concat(chunks);
                let body = decompress(raw, ce).toString('utf8');

                const injectTag = buildInjectTag();
                if (body.includes('</head>')) {
                    body = body.replace('</head>', `${injectTag}</head>`);
                } else if (body.includes('</body>')) {
                    body = body.replace('</body>', `${injectTag}</body>`);
                } else {
                    body += injectTag;
                }

                injectCount++;
                log('debug', `[注入 #${injectCount}] ${req.url.substring(0, 80)}`);

                const buf = Buffer.from(body, 'utf8');
                const headers = { ...proxyRes.headers };
                delete headers['content-encoding'];
                delete headers['transfer-encoding'];
                delete headers['x-frame-options'];
                headers['content-length'] = buf.length;

                res.writeHead(status, headers);
                res.end(buf);
            } catch (e) {
                log('error', '[注入失败]', e.message);
                try {
                    const headers = { ...proxyRes.headers };
                    delete headers['content-encoding'];
                    res.writeHead(status, headers);
                    res.end(raw);
                } catch {
                    if (!res.headersSent) { res.writeHead(500); res.end('处理错误'); }
                }
            }
        });
    } else {
        res.writeHead(status, proxyRes.headers);
        proxyRes.pipe(res);
    }
});

// ═══ 启动 HTTP ═══
const httpServer = http.createServer(handleRequest);
httpServer.on('upgrade', handleUpgrade);
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[就绪] HTTP:  http://<NAS-IP>:${PORT}`);
});

// ═══ 启动 HTTPS ═══
const certs = ensureCerts();
if (certs && certs.cert.length > 0) {
    const httpsServer = https.createServer(certs, handleRequest);
    httpsServer.on('upgrade', handleUpgrade);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log(`[就绪] HTTPS: https://<NAS-IP>:${HTTPS_PORT}`);
        console.log('[提示] 自签证书，浏览器会提示不安全，点"继续访问"即可');
    });
} else {
    console.warn('[跳过] 无有效证书，HTTPS 未启动');
}

process.on('uncaughtException', err => console.error('[异常]', err.message));
process.on('unhandledRejection', err => console.error('[拒绝]', String(err)));
