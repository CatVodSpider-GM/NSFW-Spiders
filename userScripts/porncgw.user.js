// ==UserScript==
// @name         porn吃瓜网
// @namespace    gmspider
// @version      2026.10.12
// @description  porncgw.com GMSpider
// @author       Luomo
// @match        https://porncgw.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    const GMSpiderArgs = {};
    if (typeof GmSpiderInject !== 'undefined') {
        try {
            const args = JSON.parse(GmSpiderInject.GetSpiderArgs());
            GMSpiderArgs.fName = args.shift();
            GMSpiderArgs.fArgs = args;
        } catch (e) {
            // 参数未就绪/已被取空：退回首页调用，不静默死亡
            GMSpiderArgs.fName = "homeContent";
            GMSpiderArgs.fArgs = [true];
        }
    } else {
        // Chrome 调试时手动指定方法
        GMSpiderArgs.fName = "homeContent";
        GMSpiderArgs.fArgs = [true];
    }
    Object.freeze(GMSpiderArgs);

    const SITE = location.origin;
    const LIST_MAX_W = 240;        // 列表封面降采样宽度（盒子性能弱，取小一些）
    const LIST_QUALITY = 0.65;
    const COVER_CONCURRENCY = 4;   // 封面并发上限：一次并行解密太多会把弱盒子拖死
    const FETCH_TIMEOUT = 12000;   // 单图看门狗：卡住就放弃这一张，不让整页等死
    const MAX_CACHE = 300;         // 封面缓存条数上限（盒子 localStorage 配额有限）

    // ==================== 封面解密 ====================
    // 封面 URL 是明文签名直链（pic.wirqed.cn/...?auth_key=...），但**字节是 AES-CBC 密文**：
    // 站点自己的内联脚本用固定 KEY/IV 在浏览器里解出图片再换 img.src（实测明文是 JPEG/PNG）。
    // KEY/IV 会随站点改版轮换，所以优先从页面的解密脚本里现读，读不到才用当前字面量兜底。
    // 少数图可能直接就是明文直链，因此按魔数判断：是图片就用原字节，否则才解密。
    const KEY_FALLBACK = 'f5d965df75336270';
    const IV_FALLBACK = '97b60394abc2fbe1';

    function readKeyIv() {
        let key = '', iv = '';
        [].forEach.call(document.querySelectorAll('script:not([src])'), function (s) {
            const t = s.textContent || '';
            if (t.indexOf('AES-CBC') < 0) return;   // 只认站点那个解密脚本块
            const km = t.match(/KEY\s*=\s*enc\.encode\(\s*'([^']+)'\s*\)/);
            const im = t.match(/IV\s*=\s*enc\.encode\(\s*'([^']+)'\s*\)/);
            if (km) key = km[1];
            if (im) iv = im[1];
        });
        return {key: key || KEY_FALLBACK, iv: iv || IV_FALLBACK};
    }

    /** 图片魔数判定：JPEG/PNG/GIF/WEBP/BMP。用来区分"密文"与"已明文"。 */
    function isImageBytes(u8) {
        if (u8.length < 4) return false;
        if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return true;
        if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return true;
        if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return true;
        if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[8] === 0x57) return true;
        if (u8[0] === 0x42 && u8[1] === 0x4d) return true;
        return false;
    }

    /** 字节 → 图片 Blob：已是明文就原样返回，否则走 AES-CBC 解密。解密失败抛错，由调用方兜空。 */
    async function decodeCoverBytes(buf) {
        if (isImageBytes(new Uint8Array(buf))) return new Blob([buf]);
        const {key, iv} = readKeyIv();
        const enc = new TextEncoder();
        const k = await crypto.subtle.importKey('raw', enc.encode(key), {name: 'AES-CBC'}, false, ['decrypt']);
        const plain = await crypto.subtle.decrypt({name: 'AES-CBC', iv: enc.encode(iv)}, k, buf);
        return new Blob([plain]);
    }

    /** 站点在 #cdn-config 里声明图片 CDN 是否需要鉴权头（当前 data-img_cdn_enabled=0）。
        值会轮换，所以不写死，按站点同一套规则现读。 */
    function imgFetchOpts() {
        const el = document.getElementById('cdn-config');
        if (!el) return undefined;
        if (el.getAttribute('data-img_cdn_enabled') !== '1') return undefined;
        const k = (el.getAttribute('data-img_cdn_auth_key') || '').trim();
        const v = (el.getAttribute('data-img_cdn_auth_value') || '').trim();
        const app = (el.getAttribute('data-cdn_app') || '').trim();
        if (!k || !v || !app) return undefined;
        const h = {};
        h[k] = v;
        h['x-cdn-app'] = app;
        return {headers: h};
    }

    // ==================== 通用工具 ====================

    function lsGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function lsSet(key, val) {
        try {
            localStorage.setItem(key, val);
        } catch (e) {
        }
    }

    /** 写封面缓存并裁剪：只保留最近写入的 MAX_CACHE 条，避免弱盒子配额被撑满。
        淘汰顺序按写入先后，非严格 LRU——热图长期不重写也可能被挤出，最坏重新解一次。 */
    function cachePut(key, uri) {
        lsSet(key, uri);
        try {
            const meta = JSON.parse(lsGet('pcgw:meta') || '[]');
            const i = meta.indexOf(key);
            if (i >= 0) meta.splice(i, 1);
            meta.push(key);
            while (meta.length > MAX_CACHE) {
                localStorage.removeItem(meta.shift());
            }
            lsSet('pcgw:meta', JSON.stringify(meta));
        } catch (e) {
        }
    }

    /** 给一个 Promise 加超时：超时返回 null，不抛错（封面失败一律降级为空串）。 */
    function withTimeout(p, ms) {
        return new Promise(function (resolve) {
            const t = setTimeout(function () {
                resolve(null);
            }, ms);
            p.then(function (v) {
                clearTimeout(t);
                resolve(v);
            }, function () {
                clearTimeout(t);
                resolve(null);
            });
        });
    }

    /** 有限并发 map：封面解密是 CPU+解码重活，必须限流，失败项兜空串。 */
    function mapLimit(arr, limit, fn) {
        return new Promise(function (resolve) {
            const out = new Array(arr.length);
            let i = 0, active = 0, done = 0;
            if (!arr.length) return resolve(out);
            function next() {
                while (active < limit && i < arr.length) {
                    const idx = i++;
                    active++;
                    Promise.resolve(fn(arr[idx], idx)).then(function (v) {
                        out[idx] = v;
                    }, function () {
                        out[idx] = '';
                    }).then(function () {
                        active--;
                        done++;
                        if (done === arr.length) resolve(out);
                        else next();
                    });
                }
            }
            next();
        });
    }

    /** blob → data URI：解码期直接降采样（只出目标宽度，无全尺寸中间位图，省内存）。 */
    function downscale(blob) {
        return createImageBitmap(blob, {resizeWidth: LIST_MAX_W, resizeQuality: 'low'}).then(function (bmp) {
            const canvas = document.createElement('canvas');
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            canvas.getContext('2d').drawImage(bmp, 0, 0);
            bmp.close();
            return canvas.toDataURL('image/jpeg', LIST_QUALITY);
        });
    }

    /**
     * 取封面 data URI（localStorage 缓存 → 生成）。
     * 两条来源：站点自己解好的 img.src（data: 图，说明站点脚本已跑过 → 直接降采样，省一次网络+解密）；
     * 否则用密文直链（列表卡的 img[data-src]、详情接口的 cover）抓字节解密。
     * 签名 URL 会过期（约 1 小时），data URI 不会，所以缓存的是 data URI。
     */
    async function getCover(vodKey, imgEl, url) {
        const ck = 'pcgw:img:' + vodKey;
        const cached = lsGet(ck);
        if (cached) return cached;
        const src = imgEl ? (imgEl.getAttribute('src') || '') : '';
        let blob = null;
        try {
            if (src.indexOf('data:image/') === 0) {
                blob = await (await fetch(src)).blob();
            } else {
                // data-src 是密文直链；站点解密失败时会把 src 回写成原始地址，也一并兜住
                const u = url || (src && src.indexOf('/static/') !== 0 ? src : '');
                if (u) {
                    const r = await withTimeout(fetch(u, imgFetchOpts()), FETCH_TIMEOUT);
                    if (r && r.ok) blob = await decodeCoverBytes(await r.arrayBuffer());
                }
            }
            if (!blob) return '';
            const uri = await downscale(blob);
            if (uri) cachePut(ck, uri);
            return uri || '';
        } catch (e) {
            return '';
        }
    }

    // ==================== 列表解析 ====================
    // 列表页（首页/分类/搜索/吃瓜社区）全是 SSR，但 ld+json 里只有面包屑（ItemList 不是内容），
    // 所以只能解析 DOM 卡片。三类卡片共用 article.video-card，靠 href 前缀区分类型：
    // /video/<id>/（单视频）、/drama/<id>/（AI 短剧等剧集）、/post/<id>/（吃瓜社区帖子）。
    // 注意：视频 id 与帖子 id 是两套自增序列、数值会撞车（/video/52258/ 是另一个视频），
    // 所以 vod_id 必须带类型前缀，交给 detailContent 的 ${id} 原样拼进路径。
    const VOD_ID_RE = /^\/(video|drama|post)\/(\d+)\//;

    function parseList() {
        const items = [];
        const seen = {};
        [].forEach.call(document.querySelectorAll('article.video-card'), function (card) {
            let href = '';
            const links = card.querySelectorAll('a[href]');
            for (let i = 0; i < links.length; i++) {
                const h = links[i].getAttribute('href') || '';
                if (VOD_ID_RE.test(h)) {
                    href = h;
                    break;
                }
            }
            const m = href.match(VOD_ID_RE);
            if (!m) return;
            const vodKey = m[1] + '/' + m[2];
            if (seen[vodKey]) return;
            seen[vodKey] = 1;
            const img = card.querySelector('img.video-thumb-img');
            const titleEl = card.querySelector('.card-title-desktop') || card.querySelector('.card-title-mobile');
            items.push({
                key: vodKey,
                name: (card.getAttribute('data-title') || (titleEl && titleEl.textContent) || '').trim(),
                // data-time 是时长（如 2:21）；剧集/帖子卡为空
                remarks: (card.getAttribute('data-time') || '').trim(),
                img: img,
                pic: (img && img.getAttribute('data-src')) || ''
            });
        });
        return items;
    }

    /** 列表构建：卡片 → 并发解密封面 → CatVod 列表项。 */
    async function buildList() {
        const items = parseList();
        if (!items.length) return [];
        const pics = await mapLimit(items, COVER_CONCURRENCY, function (it) {
            return getCover(it.key, it.img, it.pic);
        });
        return items.map(function (it, i) {
            return {
                vod_id: it.key,
                vod_name: it.name,
                vod_pic: pics[i] || '',
                vod_remarks: it.remarks || ''
            };
        });
    }

    // ==================== 播放地址 ====================
    // 整条 HLS 链路（m3u8 / crypt.key / .ts）只靠 URL 里的 auth_key 签名，实测不带 x-cdn-auth
    // 也是 200，所以 finalUrl 直出即可，不用 WebView 嗅探。
    // 播放列表是标准 HLS（#EXT-X-KEY:METHOD=AES-128，key 由播放器自己取），无需额外处理。

    /** 还原内联 JSON 里的转义：& → &（否则 URL 的 query 会被吃掉）、\/ → /。 */
    function unescapeJson(s) {
        return s.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    }

    /** 从页面内联 JSON 里取第一个命中的地址字段（分集页没有接口，播放地址就在这里）。 */
    function inlineUrl(keys) {
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        for (let i = 0; i < keys.length; i++) {
            const m = html.match(new RegExp('"' + keys[i] + '"\\s*:\\s*"([^"]+)"'));
            if (m) return unescapeJson(m[1]);
        }
        return '';
    }

    /** 取当前播放页自己的视频地址：接口优先（干净、不会串到相邻条目），页面内联 JSON 兜底。 */
    async function currentVideoUrl() {
        const m = (location.pathname || '').match(/^\/(video|drama|post)\/(\d+)/);
        if (m) {
            if (m[1] === 'drama') {
                // 分集页没有对应接口（/api/videos/<id>/<ep> 是 404），
                // 地址内联在页面里，且实测每集 hash 各不相同 → 只从当前这一集页面取。
                const u = inlineUrl(['videoSrc']);
                if (u) return u;
            } else {
                const api = m[1] === 'post' ? '/api/posts/' : '/api/videos/';
                try {
                    const j = await (await fetch(SITE + api + m[2], {headers: {accept: 'application/json'}})).json();
                    const u = (j.data || j).video_url || '';
                    if (u) return u;
                } catch (e) {
                }
            }
        }
        // 兜底：页面内联 JSON（注意帖子页会预载下一篇的地址，所以只在接口失败时才走这里）
        return inlineUrl(['videoSrc', 'video_url']);
    }

    const GmSpider = (function () {
        return {
            homeContent: async function () {
                const categories = [
                    {type_id: 'recommend', type_name: '推荐吃瓜'},
                    {type_id: 'today', type_name: '今日吃瓜'},
                    {type_id: 'hot', type_name: '热门爆料'},
                    {type_id: 'shrd', type_name: '社会热点'},
                    {type_id: 'entertainment', type_name: '热门短片'},
                    {type_id: 'door', type_name: '门事件'},
                    {type_id: 'ai', type_name: 'AI成人'},
                    {type_id: 'long-video', type_name: '长视频'},
                    {type_id: 'archives', type_name: '吃瓜社区'}
                ];
                return {
                    class: categories,
                    list: await buildList()
                };
            },

            categoryContent: async function (tid, pg, filter, extend) {
                // 分类页同首页，翻页靠 loadUrl 模板里的 ${pg}（/<栏目>/<页码>/，实测 <栏目>/1/ 有效），
                // 不解析分页导航，pagecount 给足让用户翻到没内容为止。
                return {
                    list: await buildList(),
                    pagecount: 1000
                };
            },

            searchContent: async function (key, pg, quick) {
                return {list: await buildList()};
            },

            detailContent: async function (ids) {
                // ids[0] 形如 "video/53375" / "drama/53296" / "post/52258"
                // （driven by index.json 的 detailContent.loadUrl = https://porncgw.com/${id}/，
                //  宿主的 StringSubstitutor 是纯字符串替换、不做 URL 编码，所以前缀里的斜杠能原样进路径）
                const vodKey = String((ids && ids[0]) || '');
                const parts = vodKey.split('/');
                const kind = parts[0];
                const id = parts[1];
                if (!kind || !id) return {list: []};

                // 详情接口：视频/剧集走 /api/videos/<id>，帖子走 /api/posts/<id>
                let d = {};
                try {
                    const api = kind === 'post' ? '/api/posts/' : '/api/videos/';
                    const j = await (await fetch(SITE + api + id, {headers: {accept: 'application/json'}})).json();
                    d = j.data || j;
                } catch (e) {
                }

                const pic = d.cover ? await getCover('detail/' + vodKey, null, d.cover) : '';

                // 选集：只有剧集（/drama/）有，分集走 webview 到 /drama/<id>/<ep>/。
                // 不在详情阶段预先抓每集地址——auth_key 约 1 小时过期，提前抓会白白放旧；
                // 点击时才在那一集的页面上取，playerContent 里处理。
                const eps = [];
                if (kind === 'drama') {
                    const n = parseInt(d.episode_count, 10) || 1;
                    for (let i = 1; i <= n; i++) eps.push(i);
                }
                const media = eps.length
                    ? eps.map(function (ep) {
                        return {
                            name: '第' + (ep < 10 ? '0' + ep : ep) + '集',
                            type: 'webview',
                            ext: {url: SITE + '/drama/' + id + '/' + ep + '/'}
                        };
                    })
                    : [{
                        name: '正片',
                        type: 'webview',
                        ext: {url: SITE + '/' + kind + '/' + id + '/'}
                    }];

                // 时长（秒）→ remarks；剧集换成集数
                const dur = parseInt(d.duration, 10);
                const remarks = kind === 'drama'
                    ? (d.episode_count ? d.episode_count + '集' : '')
                    : (dur > 0 ? Math.floor(dur / 60) + ':' + ('0' + (dur % 60)).slice(-2) : '');

                // 年份：created_at 里就有（LD 的 datePublished 是同一来源）
                const ym = String(d.created_at || '').match(/(20\d{2})-/);

                // 可点击标签：用 breadcrumb 的真实分类路径（如 /ai/、/ai/aidj/），
                // 走 categoryContent 模板正好拼成 /ai/1/、/ai/aidj/1/（实测均 200）；
                // 没有面包屑时退回纯文本关键词。
                const tags = [];
                [].forEach.call(d.breadcrumb || [], function (b) {
                    const tid = String(b.url || '').replace(/^\/+|\/+$/g, '');
                    if (!tid || !b.name || tid.indexOf('/') === 0) return;
                    tags.push('[a=cr:{"id":"' + tid + '","name":"' + b.name + '"}/]#' + b.name + '[/a]');
                });
                if (!tags.length && d.tags && d.tags.length) {
                    tags.push('#' + d.tags.join(' #'));
                }

                // 简介：帖子接口的 description 常为空、正文在 content 里（HTML），去标签兜底
                const content = String(d.description || d.content || '')
                    .replace(/<[^>]*>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 1000);

                const vod = {
                    vod_id: vodKey,
                    vod_name: d.title || '',
                    vod_pic: pic,
                    vod_remarks: remarks,
                    vod_year: ym ? ym[1] : '',
                    type_name: tags.join(' '),
                    vod_content: content,
                    vod_play_data: [{from: '吃瓜', media: media}]
                };
                return {list: [vod]};
            },

            playerContent: async function (flag, id, vipFlags) {
                const url = await currentVideoUrl();
                if (url) {
                    return {
                        type: 'finalUrl',
                        ext: {url: url, header: {Referer: SITE + '/', 'User-Agent': navigator.userAgent}}
                    };
                }
                // 无播放地址（罕见）：直接返回空
                return {type: 'finalUrl', ext: {url: ''}};
            }
        };
    })();

    // 站点自身的脚本是打包产物，全局可用时机不可控；
    // 用原生 DOMContentLoaded 触发，任何失败都回写空结果，避免 app 干等超时。
    function run() {
        GmSpider[GMSpiderArgs.fName](...GMSpiderArgs.fArgs).then(function (result) {
            if (typeof GmSpiderInject !== 'undefined') {
                GmSpiderInject.SetSpiderResult(JSON.stringify(result));
            }
        }).catch(function () {
            if (typeof GmSpiderInject !== 'undefined') {
                GmSpiderInject.SetSpiderResult('{"list":[]}');
            }
        });
    }

    function onReady() {
        try {
            run();
        } catch (e) {
            if (typeof GmSpiderInject !== 'undefined') {
                GmSpiderInject.SetSpiderResult('{"list":[]}');
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
