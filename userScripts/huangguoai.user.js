// ==UserScript==
// @name         黄果短剧
// @namespace    gmspider
// @version      2026.10.12
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
    // 2026-10-11 站点改版后，封面 URL 变成明文签名直链（pic.wirqed.cn/...?auth_key=...），
    // 但**字节仍然是加密的**：直接 fetch 回来的是不可解码的密文（首字节不是图片魔数），
    // 站点前端也是靠 crypto-worker.js 解出 JPEG 再换 img.src。所以解密这一步不能省，
    // 继续复用站点自己的 crypto-worker.js：站点换密钥/算法自动跟随，无需自研。
    // 封面 URL 有两处来源：列表 JSON-LD 条目不带图 → /api/media/covers（type+id → 签名 URL）；
    // 搜索页的 DOM 卡片自带 img[data-src]。解密后降采样为 data URI——签名 URL 会过期（几小时），
    // data URI 不会，所以缓存下来的是 data URI（GM 侧落盘 + 脚本内 localStorage 二级缓存）。

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

    /** 页面可能输出多个 JSON-LD 块；拍平成 @graph 节点数组。 */
    function getLdNodes() {
        const nodes = [];
        [].forEach.call(document.querySelectorAll('script[type="application/ld+json"]'), function (s) {
            let data = null;
            try {
                data = JSON.parse(s.textContent);
            } catch (e) {
                return;
            }
            [].forEach.call((data && data['@graph']) || [], function (n) {
                nodes.push(n);
            });
        });
        return nodes;
    }

    /** 按 @type 取第一个 JSON-LD 节点（ItemList 列表条目、VideoObject 详情）。 */
    function getLdNode(type) {
        const nodes = getLdNodes();
        for (let i = 0; i < nodes.length; i++) {
            const types = Array.isArray(nodes[i]['@type']) ? nodes[i]['@type'] : [nodes[i]['@type']];
            if (types.indexOf(type) >= 0) return nodes[i];
        }
        return null;
    }

    /** 从页面 JSON-LD 中提取 ItemList 条目（首页 #home-itemlist、分类页等）。 */
    function getLdItemList() {
        const node = getLdNode('ItemList');
        return (node && Array.isArray(node.itemListElement)) ? node.itemListElement : null;
    }

    /** 视频链接取 id：2026-10-11 改版前列表是 /detail/<id>/，现在是 /video/<id>/。 */
    function videoIdFromUrl(url) {
        const m = (url || '').match(/\/video\/(\d+)\//);
        return m ? m[1] : '';
    }

    /** 卡片标题：去掉 "全集在线观看" 这类只给读屏用的补全文案（.sr-only）。 */
    function cardTitle(card) {
        const a = card.querySelector('.hg-drama-card__title a');
        if (!a) return '';
        const clone = a.cloneNode(true);
        const sr = clone.querySelector('.sr-only');
        if (sr) sr.parentNode.removeChild(sr);
        return clone.textContent.trim();
    }

    /**
     * DOM 卡片数据源：搜索页没有 JSON-LD，只有卡片。
     * 只取 .hg-card-grid 内的卡片（搜索结果），跳过 .hg-search-suggest__guess（"猜你想搜"，不是命中）。
     * 卡片自带明文封面 img[data-src] 和集数角标 data-ep-base，不用再问 covers 接口。
     */
    function getDomItems() {
        const items = [];
        [].forEach.call(document.querySelectorAll('.hg-card-grid .hg-drama-card'), function (card) {
            if (card.closest('.hg-search-suggest__guess')) return;
            const link = card.querySelector('.hg-drama-card__cover-link') || card.querySelector('.hg-drama-card__title a');
            const id = videoIdFromUrl(link && link.getAttribute('href'));
            if (!id) return;
            const img = card.querySelector('img[data-src]');
            const badge = card.querySelector('.hg-drama-card__episode');
            items.push({
                id: id,
                name: cardTitle(card),
                pic: (img && img.getAttribute('data-src')) || '',
                remarks: (badge && badge.getAttribute('data-ep-base')) || ''
            });
        });
        return items;
    }

    /** JSON-LD ItemList → 去重条目（LD 条目只有 name/url，封面留空，回头用 covers 接口补）。 */
    function ldItems(list) {
        const items = [];
        const seen = {};
        [].forEach.call(list || [], function (it) {
            const id = videoIdFromUrl(it.url);
            if (!id || seen[id]) return;
            seen[id] = 1;
            items.push({id: id, name: (it.name || '').trim(), pic: '', remarks: ''});
        });
        return items;
    }

    /**
     * 视频列表（首页/分类/搜索共用）：JSON-LD ItemList 优先——名称干净（DOM 标题带"全集在线观看"
     * 之类的后缀）、条目比渲染出的卡片全；无 LD（搜索页）或 LD 里没有 /video/ 条目时退回 DOM 卡片。
     * 封面：签名 URL（covers 接口或 data-src）→ 站点 worker 解密 → 降采样 data URI。
     */
    async function buildList() {
        let items = ldItems(getLdItemList());
        if (!items.length) items = getDomItems();
        if (!items.length) return [];
        const needCover = items.filter(function (it) {
            return !it.pic;
        });
        if (needCover.length) {
            const covers = await fetchCovers(needCover.map(function (it) {
                return it.id;
            }));
            needCover.forEach(function (it) {
                it.pic = covers[it.id] || '';
            });
        }
        const pics = await batchGetPics(items.map(function (it) {
            return {id: it.id, url: it.pic};
        }), LIST_MAX_W, LIST_QUALITY);
        return items.map(function (it, i) {
            return {vod_id: it.id, vod_name: it.name, vod_pic: pics[i] || '', vod_remarks: it.remarks || ''};
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
                    list: await buildList()
                };
            },

            categoryContent: async function (tid, pg, filter, extend) {
                // 分类页同首页：默认 application/ld+json 的 ItemList 为数据源；
                // 不解析分页导航（pagecount 固定 1），翻页靠 loadUrl 模板里的 ${pg}。
                return {
                    list: await buildList(),
                    pagecount: 1000
                };
            },

            searchContent: async function (key, pg, quick) {
                // 搜索页没有 JSON-LD，buildList 会退回 DOM 卡片（只取结果网格，不含"猜你想搜"）
                return {list: await buildList()};
            },

            detailContent: async function (ids) {
                const id = ids[0];
                // 2026-10-11 改版：详情页 /detail/<id>/ → /video/<id>/，页面本身即播放页
                // （hg-web-detail__* 全族换成 hg-web-play__*），简介/日期改从 JSON-LD 取。
                const titleEl = document.querySelector('.hg-web-play__title') || document.querySelector('h1');
                const vo = getLdNode('VideoObject') || {};
                const wp = getLdNode('WebPage') || {};

                // 选集：a[data-ep-id]（第 1 集 href 就是 /video/<id>/，之后是 /video/<id>/ep-N/）。
                // 播放地址仍走接口 GET /api/videos/<id>/play?ep=N，与选集 href 无关。
                const eps = [];
                [].forEach.call(document.querySelectorAll('a[data-ep-id]'), function (el) {
                    const ep = parseInt(el.getAttribute('data-ep-id'), 10);
                    if (ep > 0) eps.push(ep);
                });
                if (!eps.length) eps.push(1);   // 没有选集网格时按单集处理
                eps.sort(function (a, b) {
                    return a - b;
                });

                const media = eps.map(function (ep) {
                    return {
                        name: '第' + (ep < 10 ? '0' + ep : ep) + '集',
                        type: 'webview',
                        ext: {url: SITE + '/api/videos/' + id + '/play?ep=' + ep}
                    };
                });

                // 备注：侧栏标题下的 "更新至 N 集"（已完结/全集同理），回退到选集数量
                const sideHead = document.querySelector('.hg-web-play__side-head');
                const rm = ((sideHead && sideHead.textContent) || '').match(/(已完结|更新至\s*\d+\s*集|全\s*\d+\s*集)/);
                const remarks = rm ? rm[1].replace(/\s+/g, '') : '更新至' + eps.length + '集';

                // 年份：JSON-LD 的发布日期
                const dm = ((vo.uploadDate || wp.datePublished) || '').match(/(20\d{2})-/);

                // 类型标签：页面 .hg-web-play__tags 里的可点击标签（LD 的 genre 只有中文名、没有 slug，
                // 生成不了跳转，所以只用来核对）
                const tags = [];
                [].forEach.call(document.querySelectorAll('.hg-web-play__tags .hg-tag'), function (el) {
                    const name = el.textContent.trim();
                    if (!name) return;
                    // [a=cr] 可点击标签：id 取 /tag/{slug}/ 的路径（如 tag/chaonengli），点击触发 categoryContent
                    const tagId = (el.getAttribute('href') || '').split('/').filter(Boolean).join('/');
                    tags.push(`[a=cr:{"id":"${tagId}/page","name":"${name}"}/]#${name}[/a]`);
                });

                // 简介：改版后详情页 DOM 里已没有简介容器，取 JSON-LD VideoObject.description
                // （WebPage.description 是截断版，只作兜底）
                const content = (vo.description || wp.description || '').trim();

                const name = (titleEl && titleEl.textContent.trim())
                    || ((vo.isPartOf && vo.isPartOf.name) || '');   // LD 的 name 带"第N集"，只用系列名兜底

                const vod = {
                    vod_id: id,
                    vod_name: name,
                    vod_remarks: remarks,
                    vod_year: dm ? dm[1] : '',
                    type_name: tags.join(' '),
                    vod_content: content,
                    vod_play_data: [{from: '黄果', media: media}]
                };
                return {list: [vod]};
            },

            playerContent: async function (flag, id, vipFlags) {
                // 接口 JSON 响应（GET /api/videos/{id}/play?ep=N → data.video_url，现为 m3u8 直链）
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
