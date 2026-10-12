// ==UserScript==
// @name         7MMTV
// @namespace    gmspider
// @version      2026.10.12
// @description  7MMTV GMSpider
// @author       Luomo
// @match        https://7mmtv.sx/*
// @match        https://*/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.slim.min.js
// @require      ../Spiders-Lib/utils.js
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const GMSpiderArgs = {};
    if (typeof GmSpiderInject !== 'undefined') {
        let args = JSON.parse(GmSpiderInject.GetSpiderArgs());
        GMSpiderArgs.fName = args.shift();
        GMSpiderArgs.fArgs = args;
    } else {
        GMSpiderArgs.fName = "categoryContent";
        GMSpiderArgs.fArgs = ["censored_list", 1, false, {}];
    }
    Object.freeze(GMSpiderArgs);

    const SITE = "https://7mmtv.sx";

    // 首页的 6 个影片轴（按片量排序）；klive_list(韓國直播)/clive_list(中國直播) 结构不同，不做
    const CATEGORIES = [
        { type_id: "censored_list", type_name: "有碼AV" },
        { type_id: "reducing-mosaic_list", type_name: "無碼破解" },
        { type_id: "uncensored_list", type_name: "無碼AV" },
        { type_id: "chinese_list", type_name: "中字AV" },
        { type_id: "amateurjav_list", type_name: "素人AV" },
        { type_id: "amateur_list", type_name: "國產影片" },
    ];

    /** 站内绝对地址 → pathname，作为 vod_id（detailContent 载入时再拼回 SITE） */
    function toId(href) {
        return String(href || "").replace(/^https?:\/\/[^/]+/, "");
    }

    /** 列表卡片解析：首页 / 分类页 / 搜索页共用同一套 .col-item 结构 */
    function listVideos(cards) {
        const items = [];
        cards.each(function () {
            const card = jQuery(this);
            const a = card.find(".video-title a").first();
            const href = a.attr("href");
            if (!href) return;
            const img = card.find("img.lazyload").first();
            items.push({
                vod_id: toId(href),
                vod_name: a.text().trim(),
                vod_pic: img.attr("data-src") || img.attr("src") || "",
                vod_remarks: GMSpiderUtils.extractDate(card.find(".video-info .text-muted").text()),
            });
        });
        return items;
    }

    /** 总页数：分页条末尾带一个「末页」跳转链接（分类页/搜索页都有） */
    function pageCount() {
        let max = 1;
        jQuery(".pagination-row a[href]").each(function () {
            const m = String(jQuery(this).attr("href")).match(/\/(\d+)\.html$/);
            if (m) max = Math.max(max, parseInt(m[1]));
        });
        return max;
    }

    /** 详情页的 JSON-LD（整页只有一个 @type=VideoObject 的块） */
    function readVideoObject() {
        let found = null;
        jQuery("script[type='application/ld+json']").each(function () {
            if (found) return;
            try {
                const data = JSON.parse(jQuery(this).text());
                if (data && data["@type"] === "VideoObject") found = data;
            } catch (e) { /* 非 JSON 块忽略 */ }
        });
        return found;
    }

    /**
     * 第三方嵌页（playmogo/doodstream 这类）的「点一下才开始」门：
     * 页面把播放器包在 splash 层里，没人点就永远不发取流请求（日志里只有 pass_md5 + op=splash_error）。
     * 页面在 WebView 里是隐藏的、没有真手指，所以这里替它点几下。
     * 只在「既没起播也没发过媒体请求」时才动手，避免误点正在正常播放的播放器
     * （mmvh02/mmsi02 的 jw8 大约 1s 内就发 master.m3u8，那时这里直接跳过）。
     */
    function kickEmbedPlayer() {
        const SELECTORS = [
            ".vjs-big-play-button", ".jwplayer", ".play-button", ".play_btn", ".btn-play",
            ".splash", "#splash", "[class*='splash']", "[class*='play']", "video",
        ];
        const tick = function () {
            const v = document.querySelector("video");
            if (v && !v.paused && v.currentTime > 0) return;        // 已在播，别碰
            const busy = (window.performance.getEntriesByType("resource") || []).some(function (e) {
                return /\.m3u8|\.mp4|\.ts(\?|$)|\/stream\//.test(e.name);
            });
            if (busy) return;                                      // 已在取流，别碰
            SELECTORS.forEach(function (sel) {
                const el = jQuery(sel).first()[0];
                if (!el || !el.offsetParent) return;               // 只点可见的
                // 别把外链广告点开（本站详情页/嵌页都挂着 popunder）
                if (el.tagName === "A" && el.href && el.href.indexOf(location.origin) !== 0) return;
                try { el.click(); } catch (e) { /* 忽略 */ }
            });
            if (v) { try { v.muted = true; v.play(); } catch (e) { /* 忽略 */ } }
        };
        let round = 0;
        const timer = setInterval(function () {
            tick();
            if (++round >= 12) clearInterval(timer);
        }, 800);
    }

    const GmSpider = {
        homeContent: function () {
            const list = [];
            jQuery(".block").each(function () {
                const block = jQuery(this);
                const title = block.find(".block-title").first();
                if (!title.length) return;
                // 分块标题带片量：有碼AV (158366) → 剥掉括号取分类名
                const typeName = title.text().replace(/\(\s*[\d,]+\s*\)/, "").trim();
                const typeId = (CATEGORIES.find(c => c.type_name === typeName) || {}).type_id;
                listVideos(block.find(".col-item")).forEach(v => {
                    list.push(typeId ? jQuery.extend(v, { type_id: typeId }) : v);
                });
            });
            return { class: CATEGORIES, list: list };
        },

        categoryContent: function () {
            return {
                list: listVideos(jQuery(".col-item")),
                pagecount: pageCount(),
                page: parseInt(arguments[1]) || 1,
            };
        },

        detailContent: function (ids) {
            const ld = readVideoObject() || {};
            const video = (ld.video && ld.video[0]) || {};
            // 嵌页地址在 JSON-LD 里是明文，直接拿来当播放入口。
            // reducing-mosaic（無碼破解）那轴给的是协议相对地址（//7mmtv.sx/assets/js/play/play.php?id=…），
            // 少了 scheme 直接丢给 WebView.loadUrl 会解析失败，必须补成 https。
            const rawUrl = video.embedUrl || ld.contentUrl || video.contentUrl || "";
            const embedUrl = rawUrl.indexOf("//") === 0 ? "https:" + rawUrl : rawUrl;
            // 片名位放番号（ABC-123），原片名移入 vod_content。
            // identifier 最准但有两个坑：uncensored 那轴写成 "fc2-ppv 4990459"（空格分隔），
            // amateur（國產）那轴整个字段缺失 → 这两种情况退回按片名提番号。
            const code = ld.identifier
                ? ld.identifier.replace(/\s+/g, "-").toUpperCase()
                : GMSpiderUtils.extractCode(ld.name || "");
            // 國產那轴的 JSON-LD 只有 name/description/keywords/thumbnailUrl/uploadDate 五个字段，
            // 没有嵌页地址；但页面本身带播放器（#mvspan_1 里的 CD1 按钮，点了才建 iframe，
            // 地址是页面自己用 AES 解出来的）。所以拿详情页当播放入口，交给 playerContent 去点按钮。
            const playUrl = embedUrl ||
                (jQuery("#mvspan_1 .btn-cd").length ? SITE + ids[0] : "");
            return {
                list: [{
                    vod_id: ids[0],
                    vod_name: code,
                    vod_pic: ld.image || ld.thumbnailUrl || "",
                    vod_year: String(ld.uploadDate || "").slice(0, 4),
                    vod_actor: (ld.actor || []).map(a => a.name).join(','),
                    vod_director: (ld.director || {}).name || "",
                    vod_remarks: String(ld.uploadDate || "").slice(0, 10),
                    type_name: (ld.genre || []).join(','),
                    vod_content: ld.name || "",
                    vod_play_data: playUrl ? [{
                        from: "默认",
                        media: [{
                            name: "正片",
                            type: "webview",
                            ext: { url: playUrl },
                        }],
                    }] : [],
                }],
            };
        },

        playerContent: function (flag, id, vipFlags) {
            // 其它 5 条轴的入口是嵌页，嵌页自己会拉 m3u8，交给宿主的 playUrlMatch 拦下真实地址即可。
            // 國產轴入口是详情页本身：纯净加载时它只建出 CD1 按钮，**不建播放器**
            // （实测 18 个请求无流），必须替它触发一次才把 iframe 插进 #mvspan_2。
            // 优先直呼页面自己的 jfun_show_mvinnerHTML（key 就在按钮 onclick 里），
            // 避开原生点击的默认动作（该页挂着 popunder 广告）；拿不到就退回落点击。
            // 其它轴的嵌页上没有这个按钮，两条路都是空操作。
            const btn = jQuery("#mvspan_1 .btn-cd").first();
            const key = String(btn.attr("onclick") || "").match(/jfun_show_mvinnerHTML\(\s*['"]([^'"]+)['"]/);
            if (key && typeof window.jfun_show_mvinnerHTML === "function") {
                window.jfun_show_mvinnerHTML(key[1]);
            } else if (location.host.indexOf("7mmtv") >= 0) {
                btn.trigger("click");
            } else {
                kickEmbedPlayer();   // 当前就是第三方嵌页（playmogo 这类）
            }
            return { type: "match" };
        },

        searchContent: function () {
            return {
                list: listVideos(jQuery(".col-item")),
                pagecount: pageCount(),
                page: parseInt(arguments[2]) || 1,
            };
        },
    };

    jQuery(function () {
        const fn = GmSpider[GMSpiderArgs.fName];
        const result = fn ? fn(...GMSpiderArgs.fArgs) : {};
        console.log(result);
        if (typeof GmSpiderInject !== 'undefined') {
            GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        }
    });
})();
