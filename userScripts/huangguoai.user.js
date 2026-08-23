// ==UserScript==
// @name         黄果短剧
// @namespace    gmspider
// @version      2026.08.24
// @description  黄果短剧 GMSpider
// @author       Luomo
// @match        https://huangguoai.com/*
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
    const WORKER_URL = SITE + '/static/web/js/plugins/crypto-worker.js';
    const LIST_MAX_W = 240;      // 列表封面降采样宽度（盒子性能弱，取小一些）
    const LIST_QUALITY = 0.65;
    const DECRYPT_TIMEOUT = 15000; // 单图看门狗：worker 有响应即重新计时（只防真卡死，不杀慢任务）
    const COVERS_TIMEOUT = 8000;   // covers 接口兜底超时：卡住直接返回空，不让整页等死
    const MAX_CACHE = 300;         // 封面缓存条数上限（盒子 localStorage 配额有限）

    // ==================== 图片解密管线 ====================
    // 解密逻辑完全复用站点自己的 crypto-worker.js：站点换密钥/算法自动跟随，无需自研。
    // 封面 URL 统一来自 /api/media/covers（type+id → 签名 URL），解密后降采样为 data URI，
    // 由 GM 侧落盘缓存；脚本内 localStorage 二级缓存。

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
        淘汰顺序按写入先后，非严格 LRU——热图长期不重写也可能被挤出，最坏重新解密一次。 */
    function cachePut(key, uri) {
        lsSet(key, uri);
        try {
            const meta = JSON.parse(lsGet('hgg:meta') || '[]');
            const i = meta.indexOf(key);
            if (i >= 0) meta.splice(i, 1);
            meta.push(key);
            while (meta.length > MAX_CACHE) {
                localStorage.removeItem(meta.shift());
            }
            lsSet('hgg:meta', JSON.stringify(meta));
        } catch (e) {
        }
    }

    // ==================== 解密 Worker 池（并发队列） ====================
    // 站点自己的 crypto-worker.js 响应里不带请求 id，单个 worker 无法区分并发响应归属，
    // 因此用 POOL_SIZE 个 worker 组成池：每个 worker 同时只处理一张，空闲即派发，
    // pendingQueue 保证并发上限（POOL_SIZE=4）。worker 超时/崩溃时终止重建。

    const POOL_SIZE = 4;
    let pool = [];
    let pendingQueue = [];

    function createWorker(slot) {
        slot.worker = new Worker(WORKER_URL, {type: 'module'});
        slot.worker.onmessage = function (e) {
            const result = e.data.result;
            if (e.data.error || !result || !result.url) {
                failSlotTask(slot, e.data.error || 'no blob url');
                return;
            }
            const blobUrl = result.url;
            const t = slot.task;
            // 心跳：worker 有响应说明在推进，重新计时
            resetSlotTimer(slot);
            downscaleToDataUri(blobUrl, t.maxWidth, t.quality).then(function (uri) {
                // 竞态守卫：解码期间槽位可能已被看门狗回收并派发新任务，
                // 迟到的结果只对"仍是本任务"的槽位生效，否则丢弃（本任务已按超时失败）。
                if (slot.task !== t) return;
                const r = slot.resolveTask;
                slot.busy = false;
                slot.task = null;
                slot.resolveTask = null;
                slot.rejectTask = null;
                clearTimeout(slot.taskTimer);
                slot.taskTimer = null;
                r && r(uri);
                dispatchNext();
            }).catch(function (err) {
                if (slot.task !== t) return;
                failSlotTask(slot, err || 'decode fail');
            });
        };
        slot.worker.onerror = function () {
            // worker 崩溃：终止重建，当前任务判失败
            failSlotTask(slot, 'worker error', true);
        };
    }

    /** 看门狗：worker 每有响应即重新计时。只防真卡死（迟迟无响应的 worker），不杀推进中的慢任务。 */
    function resetSlotTimer(slot) {
        clearTimeout(slot.taskTimer);
        slot.taskTimer = setTimeout(function () {
            failSlotTask(slot, 'decrypt timeout', true);
        }, DECRYPT_TIMEOUT);
    }

    /** 让一个空闲槽位开始处理队列头任务；无任务或忙碌则跳过。 */
    function dispatchToSlot(slot) {
        if (slot.busy || !pendingQueue.length) return;
        if (!slot.worker) createWorker(slot);
        const task = pendingQueue.shift();
        slot.busy = true;
        slot.task = task;
        slot.resolveTask = task.resolve;
        slot.rejectTask = task.reject;
        resetSlotTimer(slot);
        slot.worker.postMessage({data: task.url, key: task.url, type: 'image', responseType: 'url'});
    }

    /** 填满空闲槽位；池未满且有积压时惰性扩容到 POOL_SIZE。 */
    function dispatchNext() {
        for (let i = 0; i < pool.length; i++) {
            dispatchToSlot(pool[i]);
        }
        while (pool.length < POOL_SIZE && pendingQueue.length) {
            const slot = {worker: null, busy: false, task: null, resolveTask: null, rejectTask: null, taskTimer: null};
            pool.push(slot);
            dispatchToSlot(slot);
        }
    }

    /** 槽位任务失败/结束：清状态、按需终止重建 worker、派发下一个。 */
    function failSlotTask(slot, err, recycle) {
        if (recycle && slot.worker) {
            slot.worker.terminate();
            slot.worker = null;
        }
        const r = slot.rejectTask;
        slot.busy = false;
        slot.task = null;
        slot.resolveTask = null;
        slot.rejectTask = null;
        clearTimeout(slot.taskTimer);
        slot.taskTimer = null;
        r && r(err instanceof Error ? err : new Error(String(err)));
        dispatchNext();
    }

    /**
     * blob URL → data URI：createImageBitmap 解码期直接降采样（只出目标宽度，
     * 无全尺寸中间位图，省内存、不进合成器）。
     */
    function downscaleToDataUri(blobUrl, maxWidth, quality) {
        return fetch(blobUrl).then(function (r) {
            if (!r.ok) throw new Error('blob fetch ' + r.status);
            return r.blob();
        }).then(function (blob) {
            try {
                URL.revokeObjectURL(blobUrl);
            } catch (x) {
            }
            // 只传 resizeWidth：浏览器按源宽高比自动算出目标高度
            return createImageBitmap(blob, {resizeWidth: maxWidth, resizeQuality: 'low'}).then(function (bmp) {
                const canvas = document.createElement('canvas');
                canvas.width = bmp.width;
                canvas.height = bmp.height;
                canvas.getContext('2d').drawImage(bmp, 0, 0);
                bmp.close();
                return canvas.toDataURL('image/jpeg', quality);
            });
        });
    }

    /** 单张图片：worker 解密 → blob → 降采样 → data URI。入队由池调度。 */
    function decryptToDataUri(id, url, maxWidth, quality) {
        return new Promise(function (resolve, reject) {
            pendingQueue.push({id: id, url: url, maxWidth: maxWidth, quality: quality, resolve: resolve, reject: reject});
            dispatchNext();
        });
    }

    /** 按 id 取封面 data URI：localStorage 缓存 → 解密生成。失败返回空串。 */
    async function getPicDataUri(id, rawUrl, maxWidth, quality) {
        if (!id || !rawUrl) return '';
        const key = 'hgg:img:' + id;
        const cached = lsGet(key);
        if (cached) return cached;
        try {
            const uri = await decryptToDataUri(id, rawUrl, maxWidth, quality);
            cachePut(key, uri);
            return uri;
        } catch (e) {
            return '';
        }
    }

    /** 批量按 id 取封面：全部入队，池内并发解密（上限 POOL_SIZE=4）。 */
    async function batchGetPics(idUrls, maxWidth, quality) {
        return Promise.all(idUrls.map(function (iu) {
            return getPicDataUri(iu.id, iu.url, maxWidth, quality);
        }));
    }

    /** 批量解析签名封面 URL：POST /api/media/covers（type+id → 签名 URL）。
        带 COVERS_TIMEOUT 兜底：接口卡住也返回空，不让整页等死。 */
    function fetchCovers(idList) {
        return new Promise(function (resolve) {
            const out = {};
            if (!idList || !idList.length) return resolve(out);
            const ctl = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = setTimeout(function () {
                if (ctl) ctl.abort();
                resolve(out);
            }, COVERS_TIMEOUT);
            fetch(SITE + '/api/media/covers', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    items: idList.map(function (id) {
                        return {type: 'video', id: parseInt(id, 10)};
                    })
                }),
                signal: ctl ? ctl.signal : undefined
            }).then(function (r) {
                return r.json();
            }).then(function (j) {
                const covers = (j && j.data && j.data.covers) || {};
                Object.keys(covers).forEach(function (k) {
                    const m = k.match(/^video:(\d+)$/);
                    if (m) out[m[1]] = covers[k];
                });
                clearTimeout(timer);
                resolve(out);
            }).catch(function () {
                clearTimeout(timer);
                resolve(out);
            });
        });
    }

    // ==================== 页面工具 ====================

    /** 从页面 JSON-LD 中提取 ItemList 条目（首页 #home-itemlist、分类页 #itemlist）。 */
    function getLdItemList() {
        // 站点可能输出多个 JSON-LD 块，扫描全部，命中 ItemList 即返回
        const els = document.querySelectorAll('script[type="application/ld+json"]');
        for (let i = 0; i < els.length; i++) {
            let data = null;
            try {
                data = JSON.parse(els[i].textContent);
            } catch (e) {
                continue;
            }
            const graph = (data && data['@graph']) || [];
            for (let j = 0; j < graph.length; j++) {
                const node = graph[j];
                const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
                if (types.indexOf('ItemList') >= 0 && Array.isArray(node.itemListElement)) {
                    return node.itemListElement;
                }
            }
        }
        return null;
    }

    /**
     * 视频列表（首页/分类共用）：纯 JSON-LD 数据源，零 DOM 元素依赖。
     * 基础数据来自页面 <script type="application/ld+json"> 的 ItemList；
     * 封面：/api/media/covers 换签名 URL → 站点 worker 解密 → 降采样 data URI。
     */
    async function buildLdList() {
        const ldItems = getLdItemList();
        if (!ldItems || !ldItems.length) return [];
        const items = [];
        const seen = {};
        ldItems.forEach(function (it) {
            const m = (it.url || '').match(/\/detail\/(\d+)\//);
            if (!m || seen[m[1]]) return;
            seen[m[1]] = 1;
            items.push({id: m[1], name: (it.name || '').trim()});
        });
        if (!items.length) return [];
        const covers = await fetchCovers(items.map(function (it) {
            return it.id;
        }));
        const idUrls = items.map(function (it) {
            return {id: it.id, url: covers[it.id] || ''};
        });
        const pics = await batchGetPics(idUrls, LIST_MAX_W, LIST_QUALITY);
        return items.map(function (it, i) {
            return {vod_id: it.id, vod_name: it.name, vod_pic: pics[i] || ''};
        });
    }

    const GmSpider = (function () {
        return {
            homeContent: async function () {
                const categories = [
                    {type_id: 'recommend', type_name: '热门推荐'},
                    {type_id: 'newest', type_name: '最近上新'},
                    {type_id: 'ai-duanju', type_name: 'AI成人短剧'},
                    {type_id: 'ai-manju', type_name: 'AI成人漫剧'},
                    {type_id: 'ai-huanlian', type_name: 'AI换脸'},
                    {type_id: 'ai-mogai', type_name: 'AI魔改'}
                ];
                return {
                    class: categories,
                    list: await buildLdList()
                };
            },

            categoryContent: async function (tid, pg, filter, extend) {
                // 分类页同首页：默认 application/ld+json 的 ItemList 为唯一数据源，
                // 封面走 covers 接口；不解析分页导航（pagecount 固定 1）。
                return {
                    list: await buildLdList(),
                    pagecount: 1000
                };
            },

            detailContent: async function (ids) {
                const id = ids[0];
                const titleEl = document.querySelector('h1');
                const metaEl = document.querySelector('.hg-web-detail__meta');
                const descEl = document.querySelector('.hg-web-detail__desc');
                const metaText = (metaEl && metaEl.textContent) || '';

                // 选集：多集剧从选集网格取，单集视频回退到"立即播放"按钮
                const eps = [];
                [].forEach.call(document.querySelectorAll('.hg-web-detail__ep-grid a[data-ep-id]'), function (el) {
                    const ep = parseInt(el.getAttribute('data-ep-id'), 10) || 0;
                    const href = el.getAttribute('href');
                    if (href) eps.push({ep: ep, href: href});
                });
                if (eps.length === 0) {
                    const play = document.querySelector('.hg-web-detail__play');
                    const href = play && play.getAttribute('href');
                    if (href) eps.push({ep: 1, href: href});
                }
                eps.sort(function (a, b) {
                    return a.ep - b.ep;
                });

                const media = eps.map(function (e) {
                    return {
                        name: '第' + (e.ep < 10 ? '0' + e.ep : e.ep) + '集',
                        type: 'webview',
                        ext: {url: SITE + '/api/videos/' + id + '/play?ep=' + e.ep}
                    };
                });

                // 备注：优先海报上的集数角标（全21集/更新至4集），回退到 meta 中的状态
                const episodeBadge = document.querySelector('.hg-web-detail__episode');
                let remarks = (episodeBadge && episodeBadge.textContent.trim()) || '';
                if (!remarks) {
                    const statusM = metaText.match(/(已完结|更新至\s*\d+\s*集|全\s*\d+\s*集)/);
                    remarks = statusM ? statusM[1].replace(/\s+/g, '') : '';
                }

                const yearM = metaText.match(/(20\d{2})-\d{2}-\d{2}/);
                const tags = [];
                [].forEach.call(document.querySelectorAll('.hg-web-detail__tags .hg-tag'), function (el) {
                    const name = el.textContent.trim();
                    if (!name) return;
                    // [a=cr] 可点击标签：id 取 /tag/{slug}/ 的路径（如 tag/tianchong），点击触发 categoryContent
                    const id = (el.getAttribute('href') || '').split('/').filter(Boolean).join('/');
                    tags.push(`[a=cr:{"id":"${id}/page","name":"${name}"}/]#${name}[/a]`);
                });
                // 简介中移除"展开"按钮的文本
                let content = (descEl && descEl.textContent) || '';
                content = content.replace(/\s*展开\s*$/, '').trim();

                const vod = {
                    vod_id: id,
                    vod_name: (titleEl && titleEl.textContent.trim()) || '',
                    vod_remarks: remarks,
                    vod_year: yearM ? yearM[1] : '',
                    type_name: tags.join(' '),
                    vod_content: content,
                    vod_play_data: media.length ? [{from: '黄果', media: media}] : []
                };
                return {list: [vod]};
            },

            playerContent: async function (flag, id, vipFlags) {
                // 接口 JSON 响应（GET /api/videos/{id}/play?ep=N → data.video_url）
                let url = '';
                try {
                    const text = document.body ? document.body.textContent : '';
                    if (text && text.trim().charAt(0) === '{') {
                        const j = JSON.parse(text);
                        url = (j.data && j.data.video_url) || '';
                    }
                } catch (e) {
                }
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

    // 站点自身的 jQuery 是 require.js AMD 模块，全局可用时机不可控；
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
