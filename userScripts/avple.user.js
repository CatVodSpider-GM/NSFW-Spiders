// ==UserScript==
// @name         Avple
// @namespace    gmspider
// @version      2026.10.12.4
// @description  avple.tv GMSpider
// @author       Luomo
// @match        https://avple.tv/*
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

    // 站点在 Cloudflare 后面：无 cf_clearance 时先返回 "Just a moment..." 挑战页（没有 __NEXT_DATA__），
    // 由宿主自己识别挑战、弹 WebView 给用户过验证，过了以后 reload 让脚本重跑。
    // 所以这里不能一上来就判定失败，要轮询等真正的页面数据出现；超时（宿主 webViewTimeout 60s 以内）再兜空。
    const DATA_WAIT = 20000;

    // 分类只有热门榜三条（站点父级分类没有自己的页面，标签轴只走搜索）
    const TREND_CATS = [
        {type_id: 'trend/daily', type_name: '今日熱門'},
        {type_id: 'trend/weekly', type_name: '本週熱門'},
        {type_id: 'trend/monthly', type_name: '本月熱門'}
    ];

    // ==================== 播放地址 ====================
    // 页面只给相对地址 play（如 hls/<hash>/playlist.m3u8），真正的 CDN 域名是站点前端里写死的一批镜像，
    // 按 play_source_type 选路径、从镜像表里随机挑一台（站点自己的拼法见下面 refreshCdn 的注释，一模一样）：
    //   12/13/14/17/18 → <前缀>1.cdnedge.live/file/avple-asserts/<play>
    //   2/3/4/7/8      → <前缀>.cdnedge.live/file/avple-images/<play>
    //   1/1001         → hqua8q61at.cdnedge.live/file/avple-images/<play>
    //   5 或空         → play 原样（往往已经是绝对地址）
    // 这 42 个前缀是 42 台**各自独立的机器**（IP 互不相同、没有泛解析、两棵路径树也不通用），
    // 一台不通就换一台：随机挑 = 天然自愈。CDN_PREFIX 是**内置种子**，详情页会尝试从站点 chunk 抓到最新表覆盖它。
    const CDN_PREFIX = [
        'd862cp', 'q2cyl7', 'u89ey', 'zo392', 'wo880', '6m7d', '8bb88', 'fa678',
        'pg2z7', '1xp60', '47b61', 'i3qss', '10j99', 'je40u', 's2jfy', 'l87ul',
        's6s6u', 'rup0u', 'ja34l', 'rr0s1', 'c4m6s', '60frt', 'rd192', '2nm9j',
        'l8uao', 'ie2ow', 'fhq06', 'b3h6s', 'sms9q', 'xre5q', 'tn5un', '8fld9',
        's3fl8', '3krlq', '5sggi', 'xeba3', 'h8ze9', 'ta6us', '2dvqt', '99fnq',
        'x8x5b', 'isg2c'
    ];
    const IMG_HOST = 'hqua8q61at.cdnedge.live';

    function pick(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    // ==================== 镜像表（动态刷新） ====================
    // 镜像表在站点前端里就是一句写死的字面量，实测只出现在**详情页**加载的播放器 chunk 里：
    //     let u=["d862cp.cdnedge.live", …42 个…],
    //         f=u.map(e=>e.split(".")[0]+"1.cdnedge.live"),
    //         m=["hqua8q61at.cdnedge.live"];
    // 列表/首页/搜索页的 chunk 里都没有，__NEXT_DATA__ 和 _buildManifest.js 里也没有（后者只给页面级 chunk），
    // 而 chunk 名又是内容哈希（如 chunks/18qj62fw9zpjn.js）⇒ 只能从详情页已加载的 <script src> 里现读。
    // 读它也只能走镜像：页面里 fetch('https://asserts.avple.tv/…chunk') 是 TypeError: Failed to fetch（CF 域跨域读不了），
    // 镜像才回 Access-Control-Allow-Origin: https://avple.tv。而要用镜像就得先有一个已知可用的前缀
    // ⇒ 内置那 42 个必须留作种子。抓到的表写 localStorage（7 天），列表页直接用缓存，抓不到就静默继续用内置表。
    const CDN_KEY = 'avple_cdn_v1';
    const CDN_TTL = 7 * 86400000;

    function cdnCache() {
        try {
            const c = JSON.parse(localStorage.getItem(CDN_KEY) || 'null');
            if (c && c.list && c.list.length >= 8) return c;
        } catch (e) {
        }
        return null;
    }

    /** 当前该用的镜像表：缓存没过期就用缓存，否则用内置种子 */
    function prefixes() {
        const c = cdnCache();
        return c && Date.now() - (c.at || 0) < CDN_TTL ? c.list : CDN_PREFIX;
    }

    function pickPrefix() {
        return pick(prefixes());
    }

    /** 把站点资源挂到某台镜像上：/file/avple-asserts/ → <前缀>1.cdnedge.live，/file/avple-images/ → <前缀>.cdnedge.live（注意没有那个 1） */
    function mirrorOf(src, prefix) {
        const m = String(src || '').match(/^https?:\/\/[^/]+(\/file\/(avple-asserts|avple-images)\/.+)$/i);
        if (!m || !prefix) return '';
        const suffix = m[2].toLowerCase() === 'avple-asserts' ? '1.cdnedge.live' : '.cdnedge.live';
        return 'https://' + prefix + suffix + m[1];
    }

    /** 从任意 JS 文本里抠镜像前缀：取最长的一串**连续** "xxx.cdnedge.live"。连续这个条件正好把落单的 hqua8q61at（m 数组）排除掉。 */
    function extractPrefixes(text) {
        const re = /([a-z0-9]{3,12})\.cdnedge\.live/gi;
        const runs = [];
        let m, run = null, last = -1;
        while ((m = re.exec(text)) !== null) {
            if (!run || m.index - last > 24) runs.push(run = []);
            run.push(m[1]);
            last = m.index + m[0].length;
        }
        runs.sort(function (a, b) {
            return b.length - a.length;
        });
        const seen = {}, out = [];
        [].forEach.call(runs[0] || [], function (p) {
            if (!seen[p]) {
                seen[p] = 1;
                out.push(p);
            }
        });
        return out;
    }

    let cdnTried = false;

    function saveCdn(list, chunk) {
        try {
            localStorage.setItem(CDN_KEY, JSON.stringify({at: Date.now(), list: list, chunk: chunk}));
        } catch (e) {
        }
    }

    // 首选抓法：钩 Array.prototype.map。站点那句 `f=u.map(e=>e.split(".")[0]+"1.cdnedge.live")`
    // 一执行，map 的 this 就是镜像表本体 ⇒ 拿的是活数组，不用抠文本、0 请求 0 等待。
    // 时机极紧：实测站点那句在 **t+227ms** 执行，DOMContentLoaded 才 t+229ms（播放器 chunk 在 HTML 里预载，下载完就执行）。
    // 能赢是因为宿主在 onPageStarted 就注入：WebViewClientGmHook.onPageStarted → super → pardus RUNATSTART → evaluateJavascript，
    // 实测脚本 t+31ms 就跑到、钩子 t+39ms 装上（站点那句 t+266ms 命中并当场还原）。
    // 反例：测试台用 `<script src>` 注入要 342ms 才下载完（t+613ms），必然输给 227ms —— 那样就只能靠下面的 fetch。
    // 装晚了/站点哪天不用 map 了都抓不到 ⇒ 回落到下面的 fetch 路子（所以这个钩子只是加速，不是唯一活路）。
    // 只在详情页会命中（播放器 chunk 只在那儿 import），列表页钩子白挂 ⇒ 给个 15s 上限自己摘掉。
    const HOOK_WAIT = 5000;
    let hooked = null, hookWait = [];

    function installMapHook() {
        const om = Array.prototype.map;
        if (om.avple) return;
        const wrapped = function (cb, ta) {
            const r = om.call(this, cb, ta);
            try {
                if (!hooked && r && r.length >= 8 && r.length <= 80 && r.length === this.length
                    && typeof r[0] === 'string' && /^[a-z0-9]{3,12}1\.cdnedge\.live$/.test(r[0])) {
                    const list = [];
                    for (let i = 0; i < this.length; i++) {
                        const m = /^([a-z0-9]{3,12})\.cdnedge\.live$/.exec(String(this[i]));
                        if (!m) {
                            list.length = 0;   // 整条数组都得是镜像表，有一条不是就判为误伤
                            break;
                        }
                        list.push(m[1]);
                    }
                    if (list.length >= 8) {
                        hooked = list;
                        Array.prototype.map = om;   // 立刻还原，别带着站点跑完这一页
                        const prev = cdnCache();    // 钩子不知道表在哪个 chunk 里，别把上次记下的名字冲掉
                        saveCdn(list, prev ? prev.chunk : '');
                        [].forEach.call(hookWait, function (f) {
                            f();
                        });
                        hookWait = [];
                    }
                }
            } catch (e) {
            }
            return r;
        };
        wrapped.avple = 1;
        Array.prototype.map = wrapped;
        setTimeout(function () {
            if (Array.prototype.map === wrapped) Array.prototype.map = om;
        }, 15000);
    }

    installMapHook();

    /**
     * 并行探这批 chunk：谁先抠出表算谁的，其余立刻 abort。
     * 串行实测冷启动 9.7s（表在第 5 块里，前 4 块白等，其中两块 300KB+），并行实测 2.3s。
     * 想"小的先试"是不行的：chunk 来自 asserts.avple.tv（跨域），资源计时拿不到 encodedBodySize，全是 0。
     */
    function probe(cands, onFail) {
        const ctls = [];
        let done = false, left = 0;
        [].forEach.call(cands, function (x) {
            const via = mirrorOf(x.url, pick(CDN_PREFIX));
            if (!via) return;
            left++;
            let ac = null;
            try {
                ac = new AbortController();
                ctls.push(ac);
            } catch (e) {
            }
            fetch(via, {credentials: 'omit', signal: ac ? ac.signal : undefined}).then(function (r) {
                return r.text();
            }).then(function (t) {
                if (done) return;
                const list = extractPrefixes(t);
                if (list.length >= 8) {
                    done = true;
                    saveCdn(list, x.name);
                    [].forEach.call(ctls, function (a) {
                        try {
                            a.abort();
                        } catch (e) {
                        }
                    });
                }
            }).catch(function () {
            }).then(function () {
                if (!done && --left === 0 && onFail) onFail();
            });
        });
    }

    /** 详情页才有播放器 chunk，所以只在那儿刷新；抓到就落盘，抓不到就静默保持内置表（不阻塞详情结果）。 */
    function refreshCdn() {
        if (cdnTried) return;
        cdnTried = true;
        const c = cdnCache();
        if (c && Date.now() - (c.at || 0) < CDN_TTL) return;
        const cands = [];
        [].forEach.call(document.querySelectorAll('script[src]'), function (s) {
            const u = s.getAttribute('src') || '';
            if (/\/_next\/static\/chunks\/[^/]+\.js/.test(u)) cands.push({url: u, name: u.split('/').pop()});
        });
        if (!cands.length) return;
        const scan = function () {
            if (hooked) return;
            if (c && c.chunk) {
                // 上次命中的那个先单独试（站点改版才会换 chunk 名，平时一次请求就够）
                const hit = cands.filter(function (x) {
                    return x.name === c.chunk;
                });
                if (hit.length) {
                    // 单独试不中就回落全扫（chunk 名变了 / 那次挑中的镜像正好不通）
                    probe(hit.slice(0, 1), function () {
                        probe(cands.slice(0, 8));
                    });
                    return;
                }
            }
            probe(cands.slice(0, 8));
        };
        // 钩子常比 DOMContentLoaded 晚（播放器模块是 hydration 时才 import 的），
        // 而这里是 fire-and-forget、没人等结果 ⇒ 先白等几秒，等不到再发请求。
        const timer = setTimeout(scan, HOOK_WAIT);
        hookWait.push(function () {
            clearTimeout(timer);
        });
    }

    function buildPlayUrl(type, play) {
        const p = String(play || '');
        if (!p) return '';
        if (/^https?:\/\//i.test(p)) return p;
        const t = Number(type);
        const host = pickPrefix();
        if (t === 12 || t === 13 || t === 14 || t === 17 || t === 18) {
            return 'https://' + host + '1.cdnedge.live/file/avple-asserts/' + p;
        }
        if (t === 2 || t === 3 || t === 4 || t === 7 || t === 8) {
            return 'https://' + host + '.cdnedge.live/file/avple-images/' + p;
        }
        if (t === 1 || t === 1001) {
            return 'https://' + IMG_HOST + '/file/avple-images/' + p;
        }
        return p;
    }

    // ==================== 封面地址 ====================
    // 站点前端用的图床是 CF 后面的 asserts.avple.tv（老数据 assert.avple.tv）。服务端这批图没问题，
    // 但经 CF 在设备上取图很不稳（CF 对本站会按请求特征概率性 403，且这条链路慢），实测列表里只有零星几张出得来。
    // 同一批图在放播放流的 cdnedge.live 镜像上原样可读，而且镜像不是 CF、不回跳转，字节与 CF 站完全一致：
    //   实测 42 台 × {列表 preview/1.webp、详情海报 0/1.webp、avple-images} 全部 200、md5 相同。
    // 封面改走镜像——就是播放地址那批机器（设备本来就得连它们才能播），随机挑一台 = 天然自愈。
    // 只改站点自己的两个图床域名，第三方域名的图原样不动，免得把本来能显示的图改坏。
    function buildPicUrl(src) {
        const u = String(src || '');
        if (!/^https?:\/\/asserts?\.avple\.tv\//i.test(u)) return u;
        return mirrorOf(u, pickPrefix()) || u;
    }

    // ==================== 页面数据 ====================
    // 站点是 Next.js Pages Router：列表页/详情页的全部数据都在 __NEXT_DATA__ 里（SSR 直出，不用等脚本），
    // 比解析 DOM 稳得多——列表页 props.pageProps.data 是当页条目数组，详情页 props.pageProps.instance 是本片。
    // 挑战页/加载中都没有这个节点，所以按节点出现来轮询。
    function waitForData(ms) {
        return new Promise(function (resolve) {
            const t0 = Date.now();
            (function poll() {
                const el = document.getElementById('__NEXT_DATA__');
                if (el) {
                    let j = null;
                    try {
                        j = JSON.parse(el.textContent || '');
                    } catch (e) {
                    }
                    if (j && j.props && j.props.pageProps) {
                        resolve({pp: j.props.pageProps, route: j.page || ''});
                        return;
                    }
                }
                if (Date.now() - t0 >= ms) {
                    resolve(null);
                    return;
                }
                setTimeout(poll, 200);
            })();
        });
    }

    /** 列表数据 → CatVod 列表项。封面是明文 webp 直链（图床无防盗链、不需要解密），原样交给宿主图片加载器。 */
    function itemsFromProps(pp) {
        const data = (pp && pp.data) || [];
        const out = [];
        [].forEach.call(data, function (v) {
            const id = v && v._id != null ? String(v._id) : '';
            if (!id) return;
            out.push({
                vod_id: id,
                vod_name: v.title || '',
                vod_pic: buildPicUrl(v.img_preview),
                vod_remarks: v.timeLengh || ''
            });
        });
        return out;
    }

    /** DOM 兜底：万一某页 props 里没有 data（路由改版等），退回卡片解析。标题取 img 的 alt（站点就用它存标题）。 */
    function itemsFromDom() {
        const out = [], seen = {};
        [].forEach.call(document.querySelectorAll('a[href^="/video/"] img'), function (img) {
            const a = img.closest('a[href]');
            const href = a ? (a.getAttribute('href') || '') : '';
            const m = href.match(/^\/video\/([A-Za-z0-9]+)/);
            if (!m || seen[m[1]]) return;
            seen[m[1]] = 1;
            out.push({
                vod_id: m[1],
                vod_name: (img.getAttribute('alt') || img.getAttribute('title') || '').trim(),
                vod_pic: buildPicUrl(img.getAttribute('src') || ''),
                vod_remarks: ''
            });
        });
        return out;
    }

    /** 列表页取条目：优先 __NEXT_DATA__，取不到再退回 DOM。 */
    async function buildList() {
        const d = await waitForData(DATA_WAIT);
        let list = d ? itemsFromProps(d.pp) : [];
        if (!list.length) list = itemsFromDom();
        return {list: list, pp: d ? d.pp : null, found: !!d};
    }

    /** 页数：站点直接给了 totalPage；拿不到就按当页是否满页粗略兜底。 */
    function pageCount(pp, list) {
        const n = Number(pp && pp.totalPage);
        if (n > 0) return n;
        return list && list.length >= 20 ? 1000 : 1;
    }

    // ==================== 站点标签清洗 ====================
    // 老数据的 tags 里会塞 "91視頻,開心鬼傳媒" 这种逗号串，拆开更可读
    function flatTags(tags) {
        const out = [];
        [].forEach.call(tags || [], function (t) {
            String(t).split(/[,，]/).forEach(function (s) {
                s = s.trim();
                if (s && out.indexOf(s) < 0) out.push(s);
            });
        });
        return out;
    }

    const GmSpider = (function () {
        return {
            homeContent: async function () {
                // homeContent 的 loadUrl 落在 /trend/daily/1，首页列表就是今日榜
                const r = await buildList();
                return {
                    class: TREND_CATS,
                    list: r.list
                };
            },

            categoryContent: async function (tid, pg, filter, extend) {
                // tid 形如 trend/daily（自带斜杠），交给 index.json 的
                // categoryContent.loadUrl = https://avple.tv/${tid}/${pg}，
                // 宿主的 StringSubstitutor 是纯字符串替换、不做 URL 编码，斜杠能原样进路径
                const r = await buildList();
                return {
                    list: r.list,
                    pagecount: pageCount(r.pp, r.list)
                };
            },

            searchContent: async function (key, quick, pg) {
                const r = await buildList();
                return {
                    list: r.list,
                    pagecount: pageCount(r.pp, r.list)
                };
            },

            detailContent: async function (ids) {
                const reqId = String((ids && ids[0]) || '');
                refreshCdn();   // 详情页带着播放器 chunk，顺手把镜像表刷新一次（不阻塞下面的结果）
                const d = await waitForData(DATA_WAIT);
                const v = (d && d.pp && d.pp.instance) || null;
                if (!v) {
                    // 挑战页/异常页：宿主过验证后会 reload 重跑，这里先返回空
                    return {list: []};
                }
                const meta = (d.pp && d.pp.metaInfo) || {};

                // 播放地址在详情页的 instance 里就能拼完（m3u8 是明文 VOD、无 token、CDN 不校验 Referer），
                // 所以直接给 direct 源，播放阶段不用再开 WebView。
                const playUrl = buildPlayUrl(v.play_source_type, v.play);

                const tags = flatTags(v.tags);
                const acters = (v.acters || []).map(function (a) {
                    return String(a).trim();
                }).filter(function (a) {
                    return a;
                });

                const content = String(meta.description || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 1000);

                const vod = {
                    vod_id: String(v._id != null ? v._id : reqId),
                    vod_name: v.title || '',
                    vod_pic: buildPicUrl(v.img_normal || v.img_preview || ''),
                    vod_remarks: v.timeLengh || '',
                    vod_year: String(v.release || '').slice(0, 4),
                    vod_actor: acters.join(' '),
                    type_name: tags.join(' '),
                    vod_content: content,
                    vod_play_data: [{
                        from: 'Avple',
                        media: [{
                            name: '正片',
                            type: 'direct',
                            ext: {
                                url: playUrl,
                                header: {Referer: SITE + '/', 'User-Agent': navigator.userAgent}
                            }
                        }]
                    }]
                };
                return {list: [vod]};
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
