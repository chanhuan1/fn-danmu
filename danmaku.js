(function () {
    'use strict';

    /* ══════════════════════════════════════════════════════════════════
     *  FniuDM - 飞牛影视弹幕增强脚本 (Docker 注入版 v3.0)
     *  运行环境：通过反向代理注入到飞牛影视 HTML 页面中
     *  依赖：danmu-api (DM API) 提供弹幕数据
     *  视频信息：由 server.js 代理层拦截 play/info 响应并缓存
     * ══════════════════════════════════════════════════════════════════ */

    // ─── 服务端地址 ───
    const DMAPI = window.__DMAPI__ || '/dm-api';

    // ─── 常量配置 ───
    const PSEL  = 'div.xgplayer';
    const STORE = 'fn_dm_cfg_v72';
    const FONT  = '"PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

    // ─── 设计令牌：背景层级 / 文本层级 / 主色 / 圆角 / 过渡 ───
    const BG0 = 'rgba(22,22,24,.97)';        // 面板底
    const BG1 = '#232326';                   // 卡片
    const BG2 = '#2b2b2f';                   // hover
    const BD = 'rgba(255,255,255,.07)';      // 弱边框
    const T0 = '#f2f2f4';                    // 主文本
    const T1 = '#9a9aa2';                    // 次文本
    const T2 = '#5c5c64';                    // 辅助文本
    const AC = '#5a8dff';                    // 主色（仅激活态）
    const R  = '10px';                       // 统一圆角
    const TR = '.18s cubic-bezier(.4,0,.2,1)'; // 统一过渡

    // ─── 默认配置 ───
    const DEF = {
        on: true, opacity: 0.85, area: 35, fontSize: 22,
        lineHeight: 1.8, speed: 1, outline: true, density: 100,
        maxActive: 40, offset: 0, heatmap: true
    };

    let cfg = { ...DEF };
    try { Object.assign(cfg, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch {}
    const save = () => localStorage.setItem(STORE, JSON.stringify(cfg));

    // ─── 画布 & 渲染状态 ───
    let cvs, ctx, lW, lH;
    let allDm = [], active = [];
    let eIdx = 0, rowData = [];
    let vid, raf = null;
    let injected = false;
    let showGuide = false;
    let playTime = 0, lastFrame = 0, lastDpr = 0;
    const texCache = new Map();

    // ─── UI 元素引用 ───
    let sBar, sTxt, sSub;
    let cntEl;
    let uiEls = [];
    let tooltipEl = null;
    let tipEl = null;
    let searchInp = null;

    // ─── 弹幕数据缓冲 ───
    let lastEpGuid = '';
    let rawDmBuf = null;
    let dmDurBuf = 0;
    let fixedTopRow = [];
    let fixedBotRow = [];
    let _pendingInfo = null;
    let heatBars = [];  // [{x, w, h, count}] 预计算弹幕密度桶


    /* ══════════════════════════════════════════════════════════════════
     *  工具函数
     * ══════════════════════════════════════════════════════════════════ */

    function $(tag, html, css) {
        const e = document.createElement(tag);
        if (html != null) e.innerHTML = html;
        if (css) e.style.cssText = css;
        return e;
    }

    async function gmFetch(url, o = {}) {
        const opts = { method: o.method || 'GET', headers: o.headers || {} };
        if (o.data) opts.body = o.data;
        console.log('[请求]', opts.method, url);
        try {
            const r = await fetch(url, opts);
            console.log('[响应]', url, r.status, r.statusText);
            if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
            return r.json();
        } catch (e) {
            console.error('[请求失败]', url, e.message);
            throw e;
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕 API 封装
     * ══════════════════════════════════════════════════════════════════ */

    const api = {
        search: kw => gmFetch(`${DMAPI}/api/v2/search/anime?keyword=${encodeURIComponent(kw)}`),
        match: fn => gmFetch(`${DMAPI}/api/v2/match`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ fileName: fn })
        }),
        bangumi: id => gmFetch(`${DMAPI}/api/v2/bangumi/${id}`),
        async comment(cid) {
            const r = await gmFetch(`${DMAPI}/api/v2/comment/${cid}?format=json&duration=true`);
            return { comments: r.comments || (Array.isArray(r) ? r : []), videoDuration: r.videoDuration || 0 };
        }
    };


    /* ══════════════════════════════════════════════════════════════════
     *  视频信息获取（从代理层缓存读取）
     *  server.js 会拦截 play/info API 响应，缓存视频信息
     * ══════════════════════════════════════════════════════════════════ */

    function getGuid() {
        const m = location.pathname.match(/\/v\/video\/([a-f0-9]+)/i);
        return m ? m[1] : null;
    }

    /** 从代理层获取视频信息并处理自动匹配 */
    function onVideoInfo(info) {
        if (!info || !info.title) return;
        const guid = info.guid || '';
        if (guid && guid === lastEpGuid) return;
        lastEpGuid = guid;

        console.log('[视频信息]', JSON.stringify(info));

        if (tipEl) {
            tipEl.innerHTML = info.isSeries
                ? `当前：${info.title} S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`
                : `当前：${info.title}`;
        }
        if (searchInp) searchInp.value = info.title;

        if (!cvs || !ctx) {
            _pendingInfo = info;
            return;
        }

        clearDm();
        if (vid) { playTime = vid.currentTime; lastFrame = 0; }
        autoMatch(info);
    }

    /** 轮询代理层 /dm-api/video-info 直到获取到视频信息 */
    function fetchVideoInfo(retry) {
        retry = retry || 0;
        const curGuid = getGuid();
        const qs = curGuid ? `?guid=${encodeURIComponent(curGuid)}` : '';
        fetch(`${DMAPI}/video-info${qs}`)
            .then(r => r.json())
            .then(data => {
                if (data && data.title) {
                    const curGuid = getGuid();
                    if (!curGuid || !data.guid || data.guid === curGuid) {
                        onVideoInfo(data);
                        return;
                    }
                }
                if (retry < 15) setTimeout(() => fetchVideoInfo(retry + 1), 800);
            })
            .catch(() => {
                if (retry < 15) setTimeout(() => fetchVideoInfo(retry + 1), 800);
            });
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕解析 & 管理
     * ══════════════════════════════════════════════════════════════════ */

    function parse(raw) {
        if (!Array.isArray(raw)) return [];
        return raw.map(it => {
            try {
                if (!it) return null;
                const p = String(it.p || '').split(',');
                const time = parseFloat(p[0]);
                if (isNaN(time)) return null;
                const mode = parseInt(p[1] || '1');
                const ci = parseInt(p[2] || '16777215');
                const text = String(it.m || '').trim();
                if (!text) return null;
                return {
                    text,
                    color: '#' + ci.toString(16).padStart(6, '0'),
                    type: mode === 4 ? 1 : mode === 5 ? 2 : 0,
                    time,
                    src: it._sourceLabel || '',
                    w: 0
                };
            } catch { return null; }
        }).filter(Boolean).sort((a, b) => a.time - b.time);
    }

    function measureAll() {
        ctx.save();
        ctx.font = `bold ${cfg.fontSize}px ${FONT}`;
        allDm.forEach(d => d.w = ctx.measureText(d.text).width);
        active.forEach(d => d.w = ctx.measureText(d.text).width);
        ctx.restore();
    }

    function applyLoad() {
        if (!rawDmBuf) return;
        allDm = parse(rawDmBuf);
        console.log('[弹幕] 解析完成', allDm.length, '条');
        if (dmDurBuf > 0 && vid && vid.duration > 0 && Math.abs(vid.duration - dmDurBuf) > 5) {
            const ratio = vid.duration / dmDurBuf;
            if (ratio > 0.5 && ratio < 2.0) {
                console.log('[弹幕] 时长校准', dmDurBuf.toFixed(1), '→', vid.duration.toFixed(1), 'ratio:', ratio.toFixed(3));
                allDm.forEach(d => d.time *= ratio);
                allDm.sort((a, b) => a.time - b.time);
            }
        }
        active = []; eIdx = 0; rowData = [];
        fixedTopRow = []; fixedBotRow = [];
        texCache.clear();
        measureAll(); refreshCnt();
        buildHeatmap();
        if (vid) onSeek();
        ensureLoop();
    }

    function loadDm(raw, danmakuDuration) {
        console.log('[弹幕] loadDm 收到', raw ? raw.length : 0, '条, 时长:', danmakuDuration);
        rawDmBuf = raw;
        dmDurBuf = danmakuDuration || 0;
        applyLoad();
    }

    function clearDm() {
        console.log('[弹幕] 清除');
        allDm = []; active = []; eIdx = 0; rowData = [];
        fixedTopRow = []; fixedBotRow = [];
        texCache.clear(); rawDmBuf = null; dmDurBuf = 0; heatBars = [];
        refreshCnt();
    }

    function buildHeatmap() {
        heatBars = [];
        if (!vid || !vid.duration || !allDm.length || !lW) return;
        const buckets = 80;
        const counts = new Array(buckets).fill(0);
        const dur = vid.duration;
        for (const d of allDm) {
            const idx = Math.min(buckets - 1, Math.floor(d.time / dur * buckets));
            if (idx >= 0) counts[idx]++;
        }
        const max = Math.max(...counts, 1);
        const bw = lW / buckets;
        for (let i = 0; i < buckets; i++) {
            if (counts[i] === 0) continue;
            heatBars.push({
                x: (i * bw) / lW, w: (bw - 1) / lW,
                h: Math.max(1.5, (counts[i] / max) * 10),
                count: counts[i]
            });
        }
    }

    function refreshCnt() {
        if (cntEl) cntEl.textContent = allDm.length ? ` (${allDm.length})` : '';
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕纹理（离屏 Canvas 缓存）
     * ══════════════════════════════════════════════════════════════════ */

    function getTex(text, color) {
        const dpr = window.devicePixelRatio || 1;
        if (dpr !== lastDpr) { texCache.clear(); lastDpr = dpr; }
        const key = `${text}\x00${color}\x00${cfg.fontSize}\x00${cfg.outline}`;
        let e = texCache.get(key);
        if (e) {
            texCache.delete(key);
            texCache.set(key, e);
            return e;
        }

        const fs = cfg.fontSize;
        const sw = cfg.outline ? Math.max(2, fs / 10) : 0;
        const pad = Math.ceil(sw / 2) + 1;

        const tc = document.createElement('canvas');
        const t = tc.getContext('2d');
        t.font = `bold ${fs}px ${FONT}`;
        const tw = t.measureText(text).width;
        const cW = Math.ceil(tw) + pad * 2;
        const cH = Math.ceil(fs * 1.35) + pad * 2;

        tc.width = cW * dpr;
        tc.height = cH * dpr;
        t.scale(dpr, dpr);
        t.font = `bold ${fs}px ${FONT}`;
        t.textBaseline = 'top';

        if (cfg.outline) {
            t.strokeStyle = 'rgba(0,0,0,0.7)';
            t.lineWidth = sw;
            t.lineJoin = 'round';
            t.strokeText(text, pad, pad);
        }

        t.fillStyle = color;
        t.fillText(text, pad, pad);

        e = { c: tc, w: cW, h: cH, pad };
        texCache.set(key, e);
        if (texCache.size > 600) texCache.delete(texCache.keys().next().value);
        return e;
    }


    /* ══════════════════════════════════════════════════════════════════
     *  Canvas 初始化 & 播放器事件绑定
     * ══════════════════════════════════════════════════════════════════ */

    function initCvs(container, video) {
        const c = $('canvas', null,
            'position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;');
        container.style.position = container.style.position || 'relative';
        container.appendChild(c);

        cvs = c;
        ctx = c.getContext('2d', { willReadFrequently: false, alpha: true });
        vid = video;

        function fit() {
            const r = container.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            lW = r.width;
            lH = r.height;
            c.width = lW * dpr;
            c.height = lH * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            if (rawDmBuf) buildHeatmap();
            ensureLoop();
        }

        fit();
        new ResizeObserver(fit).observe(container);
        window.addEventListener('resize', fit);

        video.addEventListener('play',           () => { lastFrame = 0; ensureLoop(); });
        video.addEventListener('pause',          () => { ensureLoop(); });
        video.addEventListener('ended',          () => {});
        video.addEventListener('seeked',         () => onSeek());
        video.addEventListener('loadedmetadata', () => {
            playTime = video.currentTime;
            if (rawDmBuf && dmDurBuf > 0) applyLoad();
        });
        video.addEventListener('ratechange',     () => { lastFrame = 0; });

        ensureLoop();
    }

    function onSeek() {
        if (!vid) return;
        active = []; rowData = [];
        fixedTopRow = []; fixedBotRow = [];
        lastFrame = 0;
        playTime = vid.currentTime;

        const t = vid.currentTime - cfg.offset;
        let lo = 0, hi = allDm.length;
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            allDm[m].time <= t ? lo = m + 1 : hi = m;
        }
        eIdx = lo;
        ensureLoop();
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕渲染主循环
     * ══════════════════════════════════════════════════════════════════ */

    function ensureLoop() {
        if (!raf) { lastFrame = 0; raf = requestAnimationFrame(tick); }
    }

    function tick(ts) {
        const dt = lastFrame ? Math.min((ts - lastFrame) / 1000, 0.05) : 0;
        lastFrame = ts;
        const playing = vid && !vid.paused && !vid.ended;

        if (playing) {
            playTime += dt * (vid.playbackRate || 1);

            const drift = vid.currentTime - playTime;
            if (Math.abs(drift) > 0.5) {
                const delta = vid.currentTime - playTime;
                playTime = vid.currentTime;
                active.forEach(d => { d.born += delta; });
                rowData.forEach(r => { if (r) r.born += delta; });
                fixedTopRow.forEach(r => { if (r) r.born += delta; });
                fixedBotRow.forEach(r => { if (r) r.born += delta; });
            } else if (Math.abs(drift) > 0.02) {
                playTime += drift * 0.05;
            }

            if (cfg.on && allDm.length && vid.currentTime > 0) emitNew();
        }

        pruneActive();
        draw();

        if (playing || showGuide || (cfg.heatmap && heatBars.length)) { raf = requestAnimationFrame(tick); }
        else { raf = null; }
    }

    function countVisible() {
        let n = 0;
        for (const d of active) {
            if (d.fixed) {
                if ((playTime - d.born) < d.life) n++;
            } else {
                const x = d.startX - (playTime - d.born) * d.spd;
                if (x + d.w > 0) n++;
            }
        }
        return n;
    }

    function emitNew() {
        const ct = vid.currentTime - cfg.offset;
        while (eIdx < allDm.length && allDm[eIdx].time <= ct + 0.2) {
            const dm = allDm[eIdx++];
            if (Math.random() * 100 >= cfg.density) continue;
            if (countVisible() >= cfg.maxActive) continue;
            fire(dm);
        }
    }

    function fire(dm) {
        const fs = cfg.fontSize;
        const lh = fs * cfg.lineHeight;
        const maxR = Math.floor(lH * cfg.area / 100 / lh);
        if (maxR <= 0) return;

        if (dm.type === 0) {
            const r = findRow(dm.w, maxR);
            if (r < 0) return;
            const spd = (120 + Math.random() * 50) * cfg.speed;
            rowData[r] = { born: playTime, spd, w: dm.w };
            active.push({
                text: dm.text, color: dm.color, w: dm.w,
                startX: lW + 5, y: r * lh + fs,
                spd, fixed: false, born: playTime,
                time: dm.time, src: dm.src || '', highlight: false
            });
        } else {
            const bound = lH * cfg.area / 100;
            const life = 4;
            const mfr = 4;

            if (dm.type === 2) {
                let r = -1;
                for (let i = 0; i < mfr; i++) {
                    if (!fixedTopRow[i] || (playTime - fixedTopRow[i].born >= fixedTopRow[i].life)) {
                        r = i; break;
                    }
                }
                if (r < 0) return;
                fixedTopRow[r] = { born: playTime, life };
                active.push({
                    text: dm.text, color: dm.color, w: dm.w,
                    x: (lW - dm.w) / 2, y: fs * 1.5 + r * lh,
                    fixed: true, born: playTime, life,
                    time: dm.time, src: dm.src || '', highlight: false
                });
            } else {
                let r = -1;
                for (let i = 0; i < mfr; i++) {
                    if (!fixedBotRow[i] || (playTime - fixedBotRow[i].born >= fixedBotRow[i].life)) {
                        r = i; break;
                    }
                }
                if (r < 0) return;
                fixedBotRow[r] = { born: playTime, life };
                active.push({
                    text: dm.text, color: dm.color, w: dm.w,
                    x: (lW - dm.w) / 2,
                    y: Math.max(fs * 2, bound - fs * 2 - r * lh),
                    fixed: true, born: playTime, life,
                    time: dm.time, src: dm.src || '', highlight: false
                });
            }
        }
    }

    function findRow(nw, maxR) {
        let best = -1, bestClr = -1;
        for (let r = 0; r < maxR; r++) {
            const rd = rowData[r];
            if (!rd) return r;
            const elapsed = playTime - rd.born;
            if (elapsed < 0) continue;
            const rightEdge = (lW + 5) - elapsed * rd.spd + rd.w;
            if (rightEdge < 0) { rowData[r] = null; return r; }
            const clr = lW - rightEdge;
            if (clr > nw + 40 && clr > bestClr) { bestClr = clr; best = r; }
        }
        return best;
    }

    function pruneActive() {
        active = active.filter(d => {
            if (d.fixed) return (playTime - d.born) < d.life;
            const x = d.startX - (playTime - d.born) * d.spd;
            return x > -(lW * 2);
        });
    }


    /* ══════════════════════════════════════════════════════════════════
     *  绘制
     * ══════════════════════════════════════════════════════════════════ */

    function draw() {
        ctx.clearRect(0, 0, lW, lH);

        if (cfg.on && active.length) {
            ctx.save();
            ctx.globalAlpha = cfg.opacity;
            for (const d of active) {
                let x;
                if (d.fixed) {
                    if ((playTime - d.born) > d.life) continue;
                    x = d.x;
                } else {
                    x = d.startX - (playTime - d.born) * d.spd;
                    if (x > lW + 10) continue;
                }
                const tex = getTex(d.text, d.color);
                const dx = x - tex.pad;
                const dy = d.y - tex.pad;

                if (d.highlight) {
                    const p = 4;
                    ctx.fillStyle = 'rgba(79,140,255,0.25)';
                    ctx.beginPath();
                    if (ctx.roundRect) {
                        ctx.roundRect(dx - p, dy - p, tex.w + p * 2, tex.h + p * 2, 6);
                    } else {
                        ctx.rect(dx - p, dy - p, tex.w + p * 2, tex.h + p * 2);
                    }
                    ctx.fill();
                }
                ctx.drawImage(tex.c, dx, dy);
                if (d.src) {
                    ctx.globalAlpha = cfg.opacity * 0.6;
                    ctx.fillStyle = '#888';
                    ctx.font = `10px ${FONT}`;
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(d.src, dx + tex.w - tex.pad + 4, dy + tex.h);
                    ctx.globalAlpha = cfg.opacity;
                }
            }
            ctx.restore();
        }

        if (showGuide) {
            const gy = lH * cfg.area / 100;
            ctx.save();
            ctx.fillStyle = 'rgba(79,140,255,0.06)';
            ctx.fillRect(0, 0, lW, gy);
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = '#4f8cff';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([8, 5]);
            ctx.beginPath();
            ctx.moveTo(0, gy);
            ctx.lineTo(lW, gy);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#4f8cff';
            ctx.globalAlpha = 0.8;
            ctx.font = `12px ${FONT}`;
            ctx.textBaseline = 'top';
            ctx.fillText(`弹幕区域 ${cfg.area}%`, 10, gy + 6);
            ctx.restore();
        }

        if (cfg.heatmap && heatBars.length && vid) {
            ctx.save();
            ctx.globalAlpha = 0.18;
            ctx.fillStyle = '#4f8cff';
            const baseY = lH - 4;
            for (const bar of heatBars) {
                ctx.fillRect(bar.x * lW, baseY - bar.h, bar.w * lW, bar.h);
            }
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
            ctx.lineWidth = 1;
            const dur = vid.duration > 0 ? vid.duration : 1;
            const px = (vid.currentTime / dur) * lW;
            ctx.beginPath();
            ctx.moveTo(px, baseY - 12);
            ctx.lineTo(px, baseY);
            ctx.stroke();
            ctx.restore();
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  UI 自动隐藏
     * ══════════════════════════════════════════════════════════════════ */

    function setUIVis(vis) {
        uiEls.forEach(el => {
            el.style.opacity = vis ? '1' : '0';
            el.style.pointerEvents = vis ? (el._dmPE || 'none') : 'none';
        });
    }

    function setupAutoHide(container) {
        let timer, onUI = false;
        function show() {
            if (onUI) return;
            setUIVis(true);
            clearTimeout(timer);
            timer = setTimeout(() => setUIVis(false), 3000);
        }
        function hide() {
            if (onUI) return;
            clearTimeout(timer);
            setUIVis(false);
        }

        container.addEventListener('mousemove', show);
        container.addEventListener('mouseleave', hide);

        let ctrlObs = false;
        function tryObs() {
            if (ctrlObs) return;
            const ctrl = container.querySelector('.xgplayer-controls');
            if (!ctrl) return;
            ctrlObs = true;
            const chk = () => {
                if (!onUI) {
                    parseFloat(getComputedStyle(ctrl).opacity) > 0.1 ? show() : hide();
                }
            };
            ctrl.addEventListener('transitionend', chk);
            new MutationObserver(chk).observe(ctrl, { attributes: true, attributeFilter: ['class', 'style'] });
        }
        new MutationObserver(tryObs).observe(container, { childList: true });
        tryObs();

        uiEls.forEach(el => {
            el.addEventListener('mouseenter', () => { onUI = true; clearTimeout(timer); });
            el.addEventListener('mouseleave', () => {
                onUI = false;
                timer = setTimeout(() => setUIVis(false), 3000);
            });
        });

        show();
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕点击交互
     * ══════════════════════════════════════════════════════════════════ */

    function setupDanmakuTouch(container) {
        tooltipEl = $('div', null,
            'position:absolute;z-index:999998;background:rgba(24,24,26,.92);color:#f2f2f4;' +
            'padding:5px 12px;border-radius:8px;font-size:13px;font-weight:500;' +
            'pointer-events:none;opacity:0;transition:opacity .3s;white-space:nowrap;backdrop-filter:blur(8px);');
        container.appendChild(tooltipEl);

        container.addEventListener('click', (e) => {
            for (const el of uiEls) { if (el.contains(e.target)) return; }
            if (!cfg.on || !active.length || !vid) return;

            const rect = container.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const fs = cfg.fontSize;

            for (let i = active.length - 1; i >= 0; i--) {
                const d = active[i];
                let x;
                if (d.fixed) {
                    if ((playTime - d.born) > d.life) continue;
                    x = d.x;
                } else {
                    x = d.startX - (playTime - d.born) * d.spd;
                }
                if (cx >= x - 4 && cx <= x + d.w + 4 && cy >= d.y - 4 && cy <= d.y + fs * 1.35 + 4) {
                    d.highlight = true;

                    const t = d.time;
                    tooltipEl.textContent =
                        `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
                    tooltipEl.style.left = Math.min(Math.max(x, 0), lW - 80) + 'px';
                    tooltipEl.style.top = Math.max(d.y - 30, 0) + 'px';
                    tooltipEl.style.opacity = '1';

                    setTimeout(() => {
                        d.highlight = false;
                        tooltipEl.style.opacity = '0';
                    }, 3000);

                    e.stopPropagation();
                    return;
                }
            }
        });
    }


    /* ══════════════════════════════════════════════════════════════════
     *  状态提示条
     * ══════════════════════════════════════════════════════════════════ */

    function flash(msg, err, sub) {
        if (!sBar) return;
        sTxt.textContent = msg;
        sTxt.style.color = err ? '#ff6666' : '#fff';
        sSub.textContent = sub || '';
        clearTimeout(sBar._t);
        sBar.style.opacity = '1';
        sBar._t = setTimeout(() => sBar.style.opacity = '0', 8000);
    }

    // 加载阶段提示：steps = ['搜索', '匹配', '加载']，activeIdx 从 0 开始
    function flashSteps(steps, activeIdx, sub, opts = {}) {
        if (!sBar) return;
        const done = steps.slice(0, activeIdx).map(s => `✓ ${s}`);
        const cur = activeIdx < steps.length ? `● ${steps[activeIdx]}` : '';
        const pend = steps.slice(activeIdx + 1).map(s => s);
        sTxt.innerHTML = [cur, ...pend]
            .map((s, i) => {
                const isCur = i === 0 && cur;
                return `<span style="color:${isCur ? '#4f8cff' : '#555'};margin-right:14px;">${s}</span>`;
            }).join('');
        for (let i = done.length - 1; i >= 0; i--) {
            sTxt.insertAdjacentHTML('afterbegin', `<span style="color:#4caf50;margin-right:14px;">${done[i]}</span>`);
        }
        sSub.textContent = sub || '';
        sSub.style.color = opts.err ? '#ff8888' : '#aaa';
        clearTimeout(sBar._t);
        sBar.style.opacity = '1';
        if (!opts.sticky) sBar._t = setTimeout(() => sBar.style.opacity = '0', opts.duration || 8000);
    }

    function flashDone(msg, err, sub) {
        if (!sBar) return;
        sTxt.textContent = msg;
        sTxt.style.color = err ? '#ff6666' : '#fff';
        sSub.textContent = sub || '';
        sSub.style.color = '#aaa';
        if (sBar._retry) sBar._retry.style.display = err ? 'block' : 'none';
        clearTimeout(sBar._t);
        sBar.style.opacity = '1';
        sBar._t = setTimeout(() => sBar.style.opacity = '0', 8000);
    }

    function mkStatus(c) {
        sBar = $('div', null,
            'position:absolute;left:20px;bottom:60px;z-index:99999;background:rgba(24,24,26,.88);' +
            'padding:10px 16px;border-radius:10px;font-size:13px;pointer-events:none;' +
            'transition:opacity .3s;opacity:0;backdrop-filter:blur(12px);display:flex;flex-direction:column;gap:3px;' +
            'border:1px solid rgba(255,255,255,.06);');
        sTxt = $('div', null, 'font-weight:500;color:#f2f2f4;');
        sSub = $('div', null, 'font-size:12px;color:#9a9aa2;');
        const retryLink = $('span', '刷新网页重试',
            'display:none;margin-top:2px;font-size:12px;color:#5a8dff;cursor:pointer;' +
            'text-decoration:underline;pointer-events:auto;width:fit-content;');
        retryLink.onclick = () => location.reload();
        sBar._retry = retryLink;
        sBar.append(sTxt, sSub, retryLink);
        c.appendChild(sBar);
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕控制面板
     * ══════════════════════════════════════════════════════════════════ */

    function mkPanel(c, info) {
        const btn = $('div', '弹幕',
            'position:absolute;top:14px;right:70px;z-index:999999;background:rgba(24,24,26,.82);' +
            'backdrop-filter:blur(16px);color:#f2f2f4;border-radius:8px;padding:7px 16px;cursor:pointer;' +
            'font-size:13px;font-weight:500;transition:opacity .3s,background .18s,border-color .18s;border:1px solid rgba(255,255,255,.08);' +
            'box-shadow:0 1px 6px rgba(0,0,0,.35);pointer-events:auto;letter-spacing:.5px;');
        btn._dmPE = 'auto';

        cntEl = $('span', '', 'font-size:11px;color:#8a8a92;margin-left:5px;font-weight:400;');
        btn.appendChild(cntEl);
        btn.onmouseenter = () => { btn.style.background = 'rgba(36,36,40,.92)'; btn.style.borderColor = 'rgba(255,255,255,.16)'; };
        btn.onmouseleave = () => { btn.style.background = 'rgba(24,24,26,.82)'; btn.style.borderColor = 'rgba(255,255,255,.08)'; };

        const pn = $('div', null,
            'position:absolute;top:58px;right:70px;width:400px;max-width:calc(100% - 20px);' +
            'height:560px;max-height:calc(100% - 70px);z-index:999999;background:' + BG0 + ';' +
            'backdrop-filter:blur(28px);border-radius:12px;overflow:hidden;' +
            'border:1px solid rgba(255,255,255,.09);box-shadow:0 24px 64px rgba(0,0,0,.6),0 2px 8px rgba(0,0,0,.4);' +
            'pointer-events:none;display:none;flex-direction:column;' +
            'transform-origin:top right;transition:opacity .2s cubic-bezier(.4,0,.2,1),transform .2s cubic-bezier(.4,0,.2,1);');
        pn._dmPE = 'auto';

        // 点击面板外部关闭（透明遮罩）
        const overlay = $('div', null,
            'position:absolute;inset:0;z-index:999998;display:none;');
        overlay._dmPE = 'auto';

        function closePanel() {
            pn.style.display = 'none';
            overlay.style.display = 'none';
            btn.style.borderColor = 'rgba(255,255,255,.08)';
            btn.style.background = 'rgba(24,24,26,.82)';
            showGuide = false;
            ensureLoop();
        }

        const tabBar = $('div', null,
            'display:flex;border-bottom:1px solid ' + BD + ';flex-shrink:0;position:relative;');
        const tabS = $('div', '弹幕搜索',
            'flex:1;text-align:center;padding:13px;cursor:pointer;font-size:13px;font-weight:500;' +
            'color:#f2f2f4;transition:color .18s;letter-spacing:.5px;');
        const tabG = $('div', '设置',
            'flex:1;text-align:center;padding:13px;cursor:pointer;font-size:13px;font-weight:500;color:#8a8a92;transition:color .18s;letter-spacing:.5px;');
        const tabInd = $('div', null,
            'position:absolute;bottom:0;left:0;width:50%;height:2px;background:' + AC + ';' +
            'transition:transform .25s cubic-bezier(.4,0,.2,1);');
        tabBar.append(tabS, tabG, tabInd);

        const vS = $('div', null, 'flex:1;overflow:hidden;display:flex;flex-direction:column;');
        const vG = $('div', null, 'flex:1;overflow-y:auto;display:none;padding:20px;box-sizing:border-box;');

        buildSearch(vS, info);
        buildSettings(vG);

        function sw(t) {
            const isS = t === 's';
            tabS.style.color = isS ? '#fff' : '#888';
            tabG.style.color = isS ? '#888' : '#fff';
            tabInd.style.transform = isS ? 'translateX(0)' : 'translateX(100%)';
            vS.style.display = isS ? 'flex' : 'none';
            vG.style.display = isS ? 'none' : 'block';
            showGuide = !isS;
            ensureLoop();
        }
        tabS.onclick = () => sw('s');
        tabG.onclick = () => sw('g');

        pn.append(tabBar, vS, vG);

        btn.onclick = () => {
            const vis = pn.style.display === 'none';
            pn.style.display = vis ? 'flex' : 'none';
            overlay.style.display = vis ? 'block' : 'none';
            btn.style.borderColor = vis ? 'rgba(90,141,255,.45)' : 'rgba(255,255,255,.08)';
            btn.style.background = vis ? 'rgba(32,32,38,.95)' : 'rgba(24,24,26,.82)';
            if (vis) {
                pn.style.opacity = '0';
                pn.style.transform = 'scale(.95) translateY(-4px)';
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    pn.style.opacity = '1';
                    pn.style.transform = 'scale(1) translateY(0)';
                }));
            }
            showGuide = vis && tabG.style.color === 'rgb(255, 255, 255)';
            ensureLoop();
        };

        overlay.onclick = closePanel;
        pn._close = closePanel;

        c.append(btn, overlay, pn);
        uiEls.push(btn, overlay, pn);
    }


    /* ══════════════════════════════════════════════════════════════════
     *  搜索面板
     * ══════════════════════════════════════════════════════════════════ */

    function buildSearch(root, info) {
        const wrap = $('div', null, 'padding:14px;display:flex;gap:10px;flex-shrink:0;');

        const inp = document.createElement('input');
        inp.placeholder = '输入动漫名称';
        inp.style.cssText =
            'flex:1;background:#1e1e21;border:1px solid rgba(255,255,255,.06);outline:none;color:#f2f2f4;border-radius:8px;' +
            'padding:10px 14px;font-size:13px;transition:border-color .18s,box-shadow .18s;box-sizing:border-box;';
        inp.onfocus = () => { inp.style.borderColor = 'rgba(90,141,255,.55)'; inp.style.boxShadow = '0 0 0 3px rgba(90,141,255,.1)'; };
        inp.onblur = () => { inp.style.borderColor = 'rgba(255,255,255,.06)'; inp.style.boxShadow = 'none'; };
        inp.style.setProperty('font-family', FONT);

        const go = $('button', '搜索',
            'background:#2e2e33;border:none;color:#f2f2f4;border-radius:8px;padding:0 18px;cursor:pointer;font-size:13px;font-weight:500;transition:background .18s;letter-spacing:.5px;');
        go.onmouseenter = () => go.style.background = '#38383e';
        go.onmouseleave = () => go.style.background = '#2e2e33';
        wrap.append(inp, go);

        const tip = $('div', null, 'padding:0 14px 8px;color:#8a8a92;font-size:12px;flex-shrink:0;');
        const list = $('div', null, 'flex:1;overflow-y:auto;padding:0 10px 10px;');

        root.append(wrap, tip, list);

        tipEl = tip;
        searchInp = inp;

        async function doSearch(kw) {
            if (!kw) return;
            if (go._busy) return;
            go._busy = true;
            go.textContent = '搜索中';
            go.style.opacity = '.6';
            go.style.pointerEvents = 'none';
            list.innerHTML = '<div style="color:#999;padding:20px;text-align:center;">搜索中...</div>';
            try {
                const r = await api.search(kw);
                const animes = r.animes || [];
                list.innerHTML = '';
                if (!animes.length) {
                    const empty = $('div', null, 'color:#999;padding:20px;text-align:center;');
                    empty.innerHTML = '无结果 ';
                    const retry = $('span', '重新搜索',
                        'color:#5a8dff;cursor:pointer;text-decoration:underline;');
                    retry.onclick = () => doSearch(kw);
                    empty.appendChild(retry);
                    list.appendChild(empty);
                    return;
                }
                for (const a of animes) {
                    const it = $('div', null,
                        'background:#232326;border-radius:10px;margin-bottom:6px;padding:12px 14px;cursor:pointer;transition:background .18s;');
                    it.onmouseenter = () => { it.style.background = '#2b2b2f'; };
                    it.onmouseleave = () => { it.style.background = '#232326'; };
                    it.innerHTML = `<div style="color:#f2f2f4;font-size:13px;font-weight:500;">${a.animeTitle || a.title || a.name}</div>`;

                    it.onclick = async () => {
                        // 返回按钮
                        const backRow = $('div', '← 返回搜索结果',
                            'color:#5a8dff;font-size:12px;cursor:pointer;padding:4px 2px 10px;width:fit-content;');
                        backRow.onclick = () => doSearch(kw);
                        backRow.onmouseenter = () => backRow.style.textDecoration = 'underline';
                        backRow.onmouseleave = () => backRow.style.textDecoration = 'none';
                        list.innerHTML = '<div style="color:#999;padding:20px;text-align:center;">加载剧集...</div>';
                        const bg = await api.bangumi(a.animeId || a.id);
                        const eps = (bg.bangumi?.episodes || bg.episodes || bg.data?.episodes || [])
                            .sort((x, y) => (parseInt(x.episodeNumber) || 0) - (parseInt(y.episodeNumber) || 0));
                        list.innerHTML = '';
                        list.appendChild(backRow);
                        if (!eps.length) {
                            list.innerHTML = '<div style="color:#999;padding:20px;text-align:center;">暂无剧集</div>';
                            return;
                        }
                        for (const ep of eps) {
                            const lb = `S${ep.seasonId?.split('-').pop() || '?'} E${ep.episodeNumber || '?'}`;
                            const ed = $('div', `<div style="color:#fff;font-size:14px;">${lb}</div>`,
                                'background:#232326;border-radius:8px;margin-bottom:4px;padding:10px 14px;cursor:pointer;transition:background .18s;');
                            ed.onmouseenter = () => { ed.style.background = '#2b2b2f'; };
                            ed.onmouseleave = () => { ed.style.background = '#232326'; };
                            ed.firstChild.style.cssText = 'color:#f2f2f4;font-size:13px;font-weight:400;';

                            ed.onclick = async () => {
                                ed.innerHTML = '<div style="color:#4f8cff">加载中...</div>';
                                const desc = `${a.animeTitle || a.title} ${lb}`;
                                flashSteps(['加载弹幕'], 0, desc, { sticky: true });
                                try {
                                    const result = await api.comment(ep.episodeId);
                                    if (result.comments.length) {
                                        clearDm();
                                        loadDm(result.comments, result.videoDuration);
                                        flashDone(`加载成功，${result.comments.length} 条弹幕`, false, desc);
                                    } else {
                                        flashDone('该集暂无弹幕', true, desc);
                                    }
                                } catch (e) {
                                    console.error('[手动加载弹幕失败]', e.message);
                                    flashDone('加载失败：' + e.message, true, desc);
                                } finally {
                                    ed.innerHTML = `<div style="color:#fff;font-size:14px;">${lb}</div>`;
                                }
                            };
                            list.appendChild(ed);
                        }
                    };
                    list.appendChild(it);
                }
            } catch (e) {
                console.error('[搜索失败]', e.message);
                const fail = $('div', null, 'color:#ff6666;padding:20px;text-align:center;');
                fail.innerHTML = '搜索失败 ';
                const retry = $('span', '重试',
                    'color:#4f8cff;cursor:pointer;text-decoration:underline;');
                retry.onclick = () => doSearch(kw);
                fail.appendChild(retry);
                list.appendChild(fail);
            } finally {
                go._busy = false;
                go.textContent = '搜索';
                go.style.opacity = '1';
                go.style.pointerEvents = 'auto';
            }
        }

        go.onclick = () => doSearch(inp.value.trim());
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(inp.value.trim()); });

        if (info) {
            inp.value = info.title;
            tip.innerHTML = info.isSeries
                ? `当前：${info.title} S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`
                : `当前：${info.title}`;
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  设置面板
     * ══════════════════════════════════════════════════════════════════ */

    function buildSettings(root) {
        function row(l, el) {
            const r = $('div', null,
                'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;');
            r.append($('span', l, 'color:#9a9aa2;font-size:12px;min-width:70px;'), el);
            return r;
        }

        function sld(min, max, step, val, fmt, cb) {
            const s = document.createElement('input');
            s.type = 'range'; s.min = min; s.max = max; s.step = step; s.value = val;
            s.style.cssText = 'flex:1;margin:0 10px;accent-color:#4f8cff;height:6px;';
            s.onfocus = () => { s.style.filter = 'drop-shadow(0 0 3px rgba(79,140,255,.7))'; };
            s.onblur = () => { s.style.filter = ''; };
            const v = $('span', fmt(val), 'color:#f2f2f4;font-size:12px;min-width:52px;text-align:right;font-variant-numeric:tabular-nums;');
            s.oninput = () => { v.textContent = fmt(+s.value); cb(+s.value); };
            const w = $('div', null, 'display:flex;align-items:center;flex:1;');
            w.append(s, v);
            return w;
        }

        function tgl(get, flip) {
            const t = $('div', null,
                'width:38px;height:22px;border-radius:11px;cursor:pointer;transition:background .18s;position:relative;flex-shrink:0;');
            const d = $('div', null,
                'width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:3px;transition:left .18s cubic-bezier(.4,0,.2,1);box-shadow:0 1px 3px rgba(0,0,0,.3);');
            t.appendChild(d);
            const u = () => {
                t.style.background = get() ? '#5a8dff' : '#3a3a3f';
                d.style.left = get() ? '19px' : '3px';
            };
            t.onclick = () => { flip(); u(); };
            u();
            return t;
        }

        const clr = $('button', '清除当前弹幕',
            'width:100%;background:#2b2b2f;border:none;color:#9a9aa2;border-radius:8px;padding:10px;cursor:pointer;font-size:12px;margin-top:12px;transition:background .18s,color .18s;');
        clr.onmouseenter = () => { clr.style.background = '#333338'; clr.style.color = '#f2f2f4'; };
        clr.onmouseleave = () => { clr.style.background = '#2b2b2f'; clr.style.color = '#9a9aa2'; };
        clr.onclick = () => { clearDm(); flash('弹幕已清除'); };

        // 可折叠分组
        function group(title, open, ...children) {
            const head = $('div', null,
                'display:flex;align-items:center;justify-content:space-between;cursor:pointer;' +
                'color:#5c5c64;font-size:11px;letter-spacing:1px;' +
                'margin:2px 0 12px;user-select:none;');
            const label = $('span', title);
            const arrow = $('span', open ? '−' : '+', 'font-size:14px;line-height:1;');
            head.append(label, arrow);
            const body = $('div', null, open ? '' : 'display:none;');
            children.forEach(c => body.appendChild(c));
            head.onclick = () => {
                const isOpen = body.style.display !== 'none';
                body.style.display = isOpen ? 'none' : '';
                arrow.textContent = isOpen ? '+' : '−';
            };
            head.onmouseenter = () => head.style.color = '#999';
            head.onmouseleave = () => head.style.color = '#666';
            const wrap = $('div', null, 'margin-top:4px;');
            wrap.append(head, body);
            return wrap;
        }

        root.append(
            group('显示', true,
            row('弹幕开关', tgl(() => cfg.on, () => { cfg.on = !cfg.on; save(); ensureLoop(); })),
            row('热力图', tgl(() => cfg.heatmap, () => { cfg.heatmap = !cfg.heatmap; save(); ensureLoop(); })),
            row('透明度',   sld(0, 1, 0.05, cfg.opacity, v => v.toFixed(2), v => { cfg.opacity = v; save(); ensureLoop(); })),
            row('显示区域', sld(10, 80, 5, cfg.area, v => v + '%', v => { cfg.area = v; save(); ensureLoop(); })),
            row('文字描边', tgl(() => cfg.outline, () => { cfg.outline = !cfg.outline; save(); texCache.clear(); ensureLoop(); })),
            ),
            group('密度', false,
            row('字号',     sld(14, 40, 1, cfg.fontSize, v => v + 'px', v => { cfg.fontSize = v; save(); texCache.clear(); measureAll(); ensureLoop(); })),
            row('行间距',   sld(1.2, 3.0, 0.1, cfg.lineHeight, v => v.toFixed(1) + 'x', v => { cfg.lineHeight = v; save(); })),
            row('滚动速度', sld(0.5, 2.5, 0.1, cfg.speed, v => v.toFixed(1) + 'x', v => { cfg.speed = v; save(); })),
            row('弹幕密度', sld(10, 100, 5, cfg.density, v => v + '%', v => { cfg.density = v; save(); })),
            row('同屏上限', sld(10, 80, 5, cfg.maxActive, v => v + '条', v => { cfg.maxActive = v; save(); })),
            ),
            group('时间', false,
            row('偏移量', sld(-30, 30, 0.5, cfg.offset,
                v => (v > 0 ? '+' : '') + v.toFixed(1) + 's', v => { cfg.offset = v; save(); })),
            $('div', '正数=延后  负数=提前', 'color:#555;font-size:11px;margin:-8px 0 14px;padding-left:70px;'),
            ),
            clr
        );
    }


    /* ══════════════════════════════════════════════════════════════════
     *  自动匹配弹幕
     * ══════════════════════════════════════════════════════════════════ */

    async function autoMatch(info) {
        if (!info) return;
        const STEPS = ['获取信息', '匹配剧集', '加载弹幕'];
        const fn = info.isSeries
            ? `${info.title} S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`
            : info.title;
        console.log('[自动匹配] 开始', fn);
        flashSteps(STEPS, 0, fn, { sticky: true });
        try {
            const m = await api.match(fn);
            console.log('[自动匹配] API返回', JSON.stringify(m).substring(0, 500));
            if (!m.success || !m.isMatched) {
                console.warn('[自动匹配] 未匹配', 'success:', m.success, 'isMatched:', m.isMatched);
                flashDone('未找到匹配的剧集', true, fn);
                return;
            }
            const f = m.matches?.[0];
            if (!f) { flashDone('未找到匹配的剧集', true, fn); return; }
            const desc = `${f.animeTitle || '?'} ${f.episodeTitle || '?'}`;
            console.log('[自动匹配] 匹配到', desc, 'episodeId:', f.episodeId);
            flashSteps(STEPS, 2, desc, { sticky: true });
            const result = await api.comment(f.episodeId);
            console.log('[自动匹配] 弹幕数', result.comments.length);
            if (result.comments.length) {
                clearDm();
                loadDm(result.comments, result.videoDuration);
                flashDone(`加载成功，${result.comments.length} 条弹幕`, false, desc);
            } else {
                flashDone('该集暂无弹幕', true, desc);
            }
        } catch (e) {
            console.error('[自动匹配] 异常', e.message, e.stack);
            flashDone('匹配失败：' + e.message, true);
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  注入主逻辑
     * ══════════════════════════════════════════════════════════════════ */

    async function inject() {
        if (injected) return;
        const container = document.querySelector(PSEL);
        if (!container) return;
        const video = container.querySelector('video');
        if (!video) { setTimeout(inject, 500); return; }

        injected = true;
        console.log('[注入] 开始注入弹幕系统');
        initCvs(container, video);
        mkStatus(container);
        mkPanel(container, null);
        setupAutoHide(container);
        setupDanmakuTouch(container);

        // 处理在 canvas 就绪前缓冲到的视频信息
        if (_pendingInfo) {
            const info = _pendingInfo;
            _pendingInfo = null;
            onVideoInfo(info);
        }

        // 从代理层获取视频信息并自动匹配
        fetchVideoInfo(0);

        console.log('[注入] 完成');
    }


    /* ══════════════════════════════════════════════════════════════════
     *  SPA 导航监听 & 启动
     * ══════════════════════════════════════════════════════════════════ */

    let lastPath = location.pathname;

    function checkUrlChange() {
        if (location.pathname !== lastPath) {
            const oldPath = lastPath;
            lastPath = location.pathname;
            console.log('[URL变化]', oldPath, '→', lastPath);

            injected = false;
            uiEls.forEach(el => el.remove());
            uiEls = [];
            if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
            if (sBar) { sBar.remove(); sBar = null; sTxt = null; sSub = null; }
            if (cvs) { cvs.remove(); cvs = null; }
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            clearDm();
            playTime = 0;
            lastFrame = 0;
            tipEl = null;
            searchInp = null;
            lastEpGuid = '';
            _pendingInfo = null;

            setTimeout(inject, 100);
        }
    }

    function startWatch() {
        const target = document.body || document.documentElement;

        new MutationObserver(() => {
            if (document.querySelector(PSEL) && !injected) inject();
        }).observe(target, { childList: true, subtree: true });

        const origPush = history.pushState;
        const origReplace = history.replaceState;

        history.pushState = function () {
            origPush.apply(this, arguments);
            setTimeout(checkUrlChange, 100);
        };
        history.replaceState = function () {
            origReplace.apply(this, arguments);
            setTimeout(checkUrlChange, 100);
        };
        window.addEventListener('popstate', () => setTimeout(checkUrlChange, 100));

        setInterval(checkUrlChange, 2000);

        inject();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startWatch);
    } else {
        startWatch();
    }
})();
