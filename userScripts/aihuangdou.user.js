// ==UserScript==
// @name         黄豆短剧
// @namespace    gmspider
// @version      2026.10.13
// @description  aihuangdou.com 分类（AI短剧/漫剧/美女/魔改 + 更新 + 榜单 + 标签 + 搜索）+ 详情选集 + MATCH 嗅探播放
// @author       Luomo
// @match        https://aihuangdou.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==
(function () {
    'use strict';

    const GMSpiderArgs = { fName: 'homeContent', fArgs: [true] };
    if (typeof GmSpiderInject !== 'undefined') {
        try {
            // GetSpiderArgs() 是 JSON 数组：[方法名, ...参数]
            const args = JSON.parse(GmSpiderInject.GetSpiderArgs());
            GMSpiderArgs.fName = args.shift();
            GMSpiderArgs.fArgs = args;
        } catch (e) {
            // 参数未就绪/已被取空：退回首页调用，不静默死亡
        }
    }

    const SITE = location.origin;

    // 站点自己的封面解密 worker（lazyload.js 用的就是它）：native 优先，失败降级 CryptoJS 版
    const WORKER_NATIVE = SITE + '/static/web/js/plugins/crypto-worker-native.js';
    const WORKER_CJS = SITE + '/static/web/js/plugins/crypto-worker.js';
    const CFG_URL = SITE + '/cdn-config.js';   // define({"imgEncKey":..,"imgEncIV":..})

    const COVER_TIMEOUT = 8000;
    const COVERS_DEADLINE = 12000;
    const LIST_MAX_W = 240;      // 列表封面缩到 240px 宽再转 dataURI，省 TVBox 落盘
    const LIST_QUALITY = 0.65;
    const POOL_SIZE = 3;
    const MAX_CACHE = 300;
    const CACHE_PFX = 'ahd:img:';
    const CACHE_META = 'ahd:meta';

    // ------------------------------------------------------------------ 缓存
    function lsGet(key) {
        try {
            return localStorage.getItem(key) || '';
        } catch (e) {
            return '';
        }
    }

    function lsSet(key, val) {
        try {
            localStorage.setItem(key, val);
        } catch (e) {
            lsTrim();
        }
    }

    function lsTrim() {
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf(CACHE_PFX) === 0) keys.push(k);
            }
            keys.slice(0, Math.max(0, keys.length - MAX_CACHE + 20)).forEach(k => localStorage.removeItem(k));
        } catch (e) {
        }
    }

    // ------------------------------------------------------------------ cdn-config
    let cdnCfg = null;

    function loadCfg() {
        if (cdnCfg) return Promise.resolve(cdnCfg);
        return fetch(CFG_URL, { cache: 'force-cache' }).then(r => r.text()).then(txt => {
            const m = txt.match(/\{[\s\S]*\}/);
            cdnCfg = m ? JSON.parse(m[0]) : {};
            return cdnCfg;
        }).catch(() => (cdnCfg = {}));
    }

    // 与站点 lazyload.js 的 image_cdn_headers 一致：未启用/缺配置时返回 null（避免多余预检）
    function imgHeaders() {
        const c = cdnCfg || {};
        if (!c.imgEnabled || !c.imgAuthKey || !c.imgAuthValue || !c.app) return null;
        const h = {};
        h[c.imgAuthKey] = c.imgAuthValue;
        h['x-cdn-app'] = c.app;
        return h;
    }

    // ------------------------------------------------------------------ 解密 worker 池
    // worker 回包会把请求里的 key 原样带回来，所以 N 个 worker 共用一个 key->promise 表即可
    let workers = [];
    let workerUrl = WORKER_NATIVE;
    let rr = 0;
    const pending = new Map();

    function onWorkerMessage(e) {
        const d = e.data || {};
        const key = d.key;
        const p = key && pending.get(key);
        if (!p) return;
        if (d.error) {
            // native（crypto.subtle）在非安全上下文会 degrade，换 CryptoJS 版重投
            if (d.degrade && workerUrl === WORKER_NATIVE) {
                workerUrl = WORKER_CJS;
                workers.forEach(w => { try { w.terminate(); } catch (err) { } });
                workers = [];
                ensureWorkers();
                pending.forEach((v, k) => post(k));
                return;
            }
            pending.delete(key);
            clearTimeout(p.timer);
            p.reject(new Error(String(d.error)));
            return;
        }
        const url = d.result && d.result.url;
        if (!url) {
            pending.delete(key);
            clearTimeout(p.timer);
            p.reject(new Error('no url'));
            return;
        }
        pending.delete(key);
        clearTimeout(p.timer);
        p.resolve(url);
    }

    function ensureWorkers() {
        while (workers.length < POOL_SIZE) {
            const w = new Worker(workerUrl, { type: 'module' });
            w.addEventListener('message', onWorkerMessage);
            workers.push(w);
        }
    }

    function post(url) {
        if (!workers.length) ensureWorkers();
        const cfg = cdnCfg || {};
        workers[rr++ % workers.length].postMessage({
            data: url,
            key: url,
            type: 'image',
            responseType: 'url',
            headers: imgHeaders(),
            encKey: cfg.imgEncKey || '',
            encIV: cfg.imgEncIV || ''
        });
    }

    // 拿到密文封面地址 -> 站点 worker 解出的 blob:/data: 地址
    function decryptCover(src) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(src);
                reject(new Error('timeout'));
            }, COVER_TIMEOUT);
            pending.set(src, { resolve, reject, timer });
            post(src);
        });
    }

    // ------------------------------------------------------------------ dataURI
    function downscaleToDataUri(blobUrl, maxWidth, quality) {
        return fetch(blobUrl)
            .then(r => r.blob())
            .then(blob => {
                if (typeof createImageBitmap !== 'function') return blobToDataUri(blob);
                return createImageBitmap(blob, {
                    resizeWidth: maxWidth,
                    resizeQuality: 'low'
                }).then(bmp => {
                    const w = bmp.width, h = bmp.height;
                    if (!w || !h) {
                        bmp.close && bmp.close();
                        return blobToDataUri(blob);
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
                    bmp.close && bmp.close();
                    return canvas.toDataURL('image/jpeg', quality);
                }).catch(() => blobToDataUri(blob));
            });
    }

    function blobToDataUri(blob) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || ''));
            fr.onerror = () => reject(new Error('read'));
            fr.readAsDataURL(blob);
        });
    }

    function getPicDataUri(url, maxWidth, quality) {
        if (!url) return Promise.resolve('');
        // 站点自己已经把封面解成 blob:/data: 了就直接用，省一次解密（blob 归站点所有，不能 revoke）
        if (/^(blob:|data:)/.test(url)) {
            return downscaleToDataUri(url, maxWidth, quality).catch(() => '');
        }
        // 密文地址：交给 worker 解密，我们拿到的 blob 用完自己回收
        return decryptCover(url).then(blobUrl => {
            return downscaleToDataUri(blobUrl, maxWidth, quality).catch(() => '').then(uri => {
                try { URL.revokeObjectURL(blobUrl); } catch (e) { }
                return uri;
            });
        }).catch(() => '');
    }

    function batchGetPics(items, maxWidth, quality) {
        if (!items.length) return Promise.resolve(items);
        return Promise.all(items.map(it => new Promise(resolve => {
            const timer = setTimeout(() => resolve(''), COVERS_DEADLINE);
            getPicDataUri(it._imgUrl, maxWidth, quality).then(uri => {
                clearTimeout(timer);
                if (uri) it.vod_pic = uri;
                resolve(uri);
            });
        }))).then(() => items);
    }

    // ------------------------------------------------------------------ 列表解析
    // 卡片（轴页/更新页/搜索页/标签页）与榜单（rank-*）共用同一批 data-track 属性
    const CARD_A = 'a[data-track-item-type="video"][data-track-item-id]';
    const LIST_SKELETON = '.drama-grid, .result-list, .rank-podium, .rank-list, .update-card';

    function scopeOf(a) {
        return a.closest('article.drama-card, article.rank-lead, article.rank-runner, li.rank-row, .update-card, article, li') ||
            a.parentElement ||
            a;
    }

    function remarksOf(scope) {
        const rank = scope.querySelector('.rank-lead-watermark, .rank-runner-watermark, .rank-no');
        if (rank) {
            const n = (rank.textContent || '').replace(/[^\d]/g, '');
            if (n) return 'TOP ' + parseInt(n, 10);
        }
        const eps = scope.querySelector('.eps-flag');
        if (eps && (eps.textContent || '').trim()) return eps.textContent.trim();
        const score = scope.querySelector('.card-score');
        if (score && (score.textContent || '').trim()) return score.textContent.trim();
        return '';
    }

    function collectItems() {
        const out = [];
        const seen = {};
        const nodes = document.querySelectorAll(CARD_A);
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            const id = a.getAttribute('data-track-item-id');
            if (!id || seen[id]) continue;
            const scope = scopeOf(a);
            const h3 = scope.querySelector('h3');
            const name = (a.getAttribute('data-track-item-name') ||
                (h3 && h3.textContent) ||
                a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
            if (!name) continue;
            seen[id] = 1;
            const img = scope.querySelector('img.poster-img, img[data-src], img[data-preview-src]');
            let imgUrl = '';
            if (img) {
                const live = img.getAttribute('src') || '';
                imgUrl = /^(blob:|data:)/.test(live) ? live : (img.getAttribute('data-src') || '');
            }
            out.push({
                vod_id: id,
                vod_name: name,
                vod_pic: '',
                vod_remarks: remarksOf(scope),
                _imgUrl: imgUrl
            });
        }
        return out;
    }

    function pageCountOf() {
        const el = document.querySelector('[data-pager-status]');
        const txt = el ? (el.textContent || '') : '';
        const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) return parseInt(m[2], 10) || 1;
        if (el && el.getAttribute('data-pager-status')) {
            const n = parseInt(el.getAttribute('data-pager-status'), 10);
            if (n > 0) return n;
        }
        return 1;   // 榜单/首页没有分页器
    }

    function looksLikeList() {
        return !!document.querySelector(LIST_SKELETON);
    }

    function buildList() {
        const items = collectItems();
        if (!items.length) return Promise.resolve({ list: [], pagecount: pageCountOf() });
        const pagecount = pageCountOf();
        return loadCfg().then(() => {
            // 命中缓存的先填上，剩下的再批量解
            const todo = [];
            items.forEach(it => {
                const hit = lsGet(CACHE_PFX + it.vod_id);
                if (hit) {
                    it.vod_pic = hit;
                } else if (it._imgUrl) {
                    todo.push(it);
                }
            });
            return batchGetPics(todo, LIST_MAX_W, LIST_QUALITY).then(() => {
                items.forEach(it => {
                    if (it.vod_pic) lsSet(CACHE_PFX + it.vod_id, it.vod_pic);
                    delete it._imgUrl;
                });
                lsSet(CACHE_META, String(Date.now()));
                return { list: items, pagecount: pagecount };
            });
        });
    }

    // ------------------------------------------------------------------ 分类表
    // 主轴 / 更新 / 榜单三档：# 号让服务端只看到合法的无分页路径（/rankings/1/ 是 404）
    const CLASSES = [
        { type_id: 'ai-duanju', type_name: 'AI短剧' },
        { type_id: 'ai-manju', type_name: 'AI漫剧' },
        { type_id: 'ai-meinv', type_name: 'AI美女' },
        { type_id: 'ai-mogai', type_name: 'AI魔改' },
        { type_id: 'updates', type_name: '最新更新' },
        { type_id: 'rankings/#', type_name: '热播榜' },
        { type_id: 'rankings/week/#', type_name: '精选榜' },
        { type_id: 'rankings/rising/#', type_name: '潜力榜' }
    ];

    // 标签只上 /tags/ 里最热的 10 个（全站 73 个，遥控器翻不动；要加回来就往这里补 ['slug','中文名']）
    const TAGS = [
        ['mingxing', '明星'], ['dushi', '都市'], ['juqing', '剧情'], ['chengzhang', '成长'], ['qingchun', '青春'],
        ['richang', '日常'], ['xiaoyuan', '校园'], ['fancha', '反差'], ['guzhuang', '古装'], ['nixi', '逆袭']
    ];

    function classes() {
        const list = CLASSES.slice();
        TAGS.forEach(t => list.push({ type_id: 'tag/' + t[0], type_name: t[1] }));
        return list;
    }

    // ------------------------------------------------------------------ 详情 / 播放
    // 详情页 /drama/<id>/：标题 .detail-main h1、简介 .detail-intro、海报 .detail-cover img.poster-img（密文，走 worker）、
    // 剧集表 #nineEpisodeGrid 的 <a href="/video/<剧id>/[集号]/">；单集作品没有剧集表，退「立即播放」按钮。
    //
    // 播放页 /video/<id>/[N/] 的地址**不在脚本里解析**：站点自己的 nine-play.js + hls.js 会预载 m3u8
    // （宿主 WebView 已 setMediaPlaybackRequiresUserGesture(false)，无人点击也会发请求），
    // 交给 index.json 的 playUrlMatch 让宿主在 MATCH 拦截层嗅探首条命中（含其请求头）。
    const DETAIL_MAX_W = 360;
    const DETAIL_QUALITY = 0.7;

    function absUrl(u) {
        if (!u) return '';
        return /^https?:/i.test(u) ? u : SITE + (u.charAt(0) === '/' ? u : '/' + u);
    }

    function textOf(sel) {
        const el = document.querySelector(sel);
        return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }

    function metaDesc() {
        const og = document.querySelector('meta[property="og:description"], meta[name="description"]');
        return og ? (og.getAttribute('content') || '').replace(/\s+/g, ' ').trim() : '';
    }

    function detailRemarks(epCount) {
        const m = textOf('.detail-cover-status, .detail-stats').match(/(已完结|更新至\s*\d+\s*集|全\s*\d+\s*集)/);
        if (m) return m[1].replace(/\s+/g, '');
        return epCount > 1 ? '共 ' + epCount + ' 集' : '';
    }

    // 剧集表：#nineEpisodeGrid 里每集都是 /video/<剧id>/[集号]/；没有剧集表（单集作品）就退「立即播放」
    function detailEps(id) {
        const out = [];
        document.querySelectorAll('#nineEpisodeGrid a[href*="/video/"]').forEach((a, i) => {
            const href = a.getAttribute('href') || '';
            const m = href.match(/\/video\/\d+(?:\/(\d+))?\/?$/);
            const n = m && m[1] ? parseInt(m[1], 10) : i + 1;
            const title = (a.getAttribute('title') || '').trim();
            out.push({ name: title || ('第 ' + n + ' 集'), url: absUrl(href) });
        });
        if (!out.length) {
            const play = document.querySelector('.detail-play[href*="/video/"]');
            out.push({ name: '正片', url: play ? absUrl(play.getAttribute('href')) : SITE + '/video/' + id + '/' });
        }
        return out;
    }

    // 封面：站点自己解好的 blob/data 直接用，否则拿 data-src 密文交 worker（与列表同一套解密）
    function detailPoster() {
        const img = document.querySelector('.detail-cover img.poster-img, .detail-cover img[data-src]');
        if (!img) return '';
        const live = img.getAttribute('src') || '';
        return /^(blob:|data:)/.test(live) ? live : (img.getAttribute('data-src') || '');
    }

    // 详情页标签 → CatVod 可点标签（点开就是对应标签分类；分类模板自己补 /${pg:-1}/，这里只给 tag/<slug>）
    function detailTags() {
        const out = [];
        document.querySelectorAll('.detail-tags a[href*="/tag/"]').forEach(a => {
            const name = (a.textContent || '').trim();
            const slug = (a.getAttribute('href') || '').match(/\/tag\/([^/]+)\//);
            if (name && slug) out.push('[a=cr:{"id":"tag/' + slug[1] + '","name":"' + name + '"}]#' + name + '[/a]');
        });
        return out.join(' ');
    }

    function buildDetail(id, eps) {
        const vod = {
            vod_id: String(id),
            vod_name: textOf('.detail-main h1') || textOf('h1'),
            vod_pic: '',
            vod_remarks: detailRemarks(eps.length),
            type_name: detailTags(),
            vod_content: textOf('.detail-intro') || metaDesc(),
            vod_play_data: [{
                from: '黄豆',
                media: eps.map(e => ({ name: e.name, type: 'webview', ext: { url: e.url } }))
            }]
        };
        // 海报解密失败不能拖垮详情返回（getPicDataUri 内部已兜底成空串）
        return loadCfg()
            .then(() => detailPoster())
            .then(poster => poster ? getPicDataUri(poster, DETAIL_MAX_W, DETAIL_QUALITY) : '')
            .then(uri => { if (uri) vod.vod_pic = uri; return vod; })
            .catch(() => vod);
    }

    // ------------------------------------------------------------------ GmSpider
    const GmSpider = {
        homeContent() {
            return buildList().then(res => ({ class: classes(), list: res.list }));
        },
        categoryContent() {
            return buildList();
        },
        searchContent() {
            return buildList();
        },
        detailContent(ids) {
            // fArgs[0] 就是 List<String> ids（invoke 把整个 list 当一个参数传），兜底再从 /drama/<id>/ 路径取
            const id = String(((ids || [])[0] || '')).trim() ||
                ((location.pathname.match(/\/drama\/(\d+)/) || [])[1] || '');
            if (!id) return { list: [] };
            return buildDetail(id, detailEps(id)).then(vod => ({ list: [vod] }));
        },
        playerContent() {
            // 播放页自己会预载 m3u8，这里只声明「等宿主嗅探」，不解析地址（见 index.json 的 playUrlMatch）
            return { name: '黄豆', type: 'match' };
        }
    };

    // ------------------------------------------------------------------ 结果回填
    const LIST_METHODS = { homeContent: 1, categoryContent: 1, searchContent: 1 };

    function setResult(result) {
        if (typeof GmSpiderInject === 'undefined' || !GmSpiderInject.SetSpiderResult) return false;
        GmSpiderInject.SetSpiderResult(typeof result === 'string' ? result : JSON.stringify(result));
        return true;
    }

    // 列表类：页面还没有列表骨架就别答 —— 分类第 1 页会 301 到无页码地址，
    // 中途那份空白文档若抢答了空列表，会把真正目标页的结果顶掉（SetSpiderResult 是后写覆盖）。
    function shouldAnswer() {
        return !LIST_METHODS[GMSpiderArgs.fName] || looksLikeList();
    }

    function run() {
        const fn = GmSpider[GMSpiderArgs.fName];
        if (typeof fn !== 'function') {
            setResult({ list: [] });
            return;
        }
        Promise.resolve(fn.apply(null, GMSpiderArgs.fArgs || []))
            .then(result => {
                if (shouldAnswer()) setResult(result || { list: [] });
            })
            .catch(() => {
                if (shouldAnswer()) setResult({ list: [] });
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(run, 0));
    } else {
        setTimeout(run, 0);
    }
})();
