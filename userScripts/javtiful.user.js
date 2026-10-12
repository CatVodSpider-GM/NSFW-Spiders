// ==UserScript==
// @name         Javtiful
// @namespace    gmspider
// @version      2026.10.12
// @description  Javtiful GMSpider
// @author       Luomo
// @match        https://javtiful.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.slim.min.js
// @require      ../Spiders-Lib/utils.js
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    var GMSpiderArgs = {};
    if (typeof GmSpiderInject !== 'undefined') {
        var args = JSON.parse(GmSpiderInject.GetSpiderArgs());
        GMSpiderArgs.fName = args.shift();
        GMSpiderArgs.fArgs = args;
    } else {
        GMSpiderArgs.fName = "detailContent";
        GMSpiderArgs.fArgs = ["categories"];
    }
    Object.freeze(GMSpiderArgs);

    /**
     * 取封面地址：站点改版后统一为 data-front-lazy-src（旧 data-front-lazy-original-src 已废弃），
     * 目录类卡片则直接是 src。返回绝对地址。
     */
    function imgUrl($card) {
        var $img = $card.find('img').first();
        var src = $img.attr('data-front-lazy-src') || $img.attr('data-front-lazy-original-src') || $img.attr('src') || '';
        if (!src) return '';
        return src.indexOf('http') === 0 ? src : window.location.origin + src;
    }

    /** 时长：.video-card__details 形如 "FHD 02:16:24"，取时间部分 */
    function durationOf($card) {
        var raw = $card.find('.video-card__details').first().text().replace(/\s+/g, ' ').trim();
        var m = raw.match(/\d{1,2}:\d{2}(?::\d{2})?/);
        return m ? m[0] : raw;
    }

    function listVideos($cards) {
        var items = [];
        $cards.each(function () {
            var a = this.querySelector('a[href*="/video/"]');
            if (!a) return;
            items.push({
                vod_id: a.href.split('/video/')[1],
                vod_name: jQuery(this).find('.video-card__title').first().text().trim(),
                vod_pic: imgUrl(jQuery(this)),
                vod_remarks: durationOf(jQuery(this)),
            });
        });
        return items;
    }

    // 目录卡片：女优/频道是 article.directory-card（链接在内部的 a.directory-card__link），
    // 分类是 a.category-card 本身，故两种形态都兼容。
    function listFolders(select, rect = 1.78) {
        let items = [];
        jQuery(select).each(function () {
            var a = this.tagName === 'A' ? this : this.querySelector('a[href]');
            if (!a) return;
            var href = a.getAttribute('href') || '';
            if (!href) return;
            items.push({
                vod_id: href.replace(/^\/zh\//, ''),
                vod_name: jQuery(this).find('.directory-card__name, .category-card__name').first().text().trim(),
                vod_tag: 'folder',
                vod_pic: imgUrl(jQuery(this)),
                vod_remarks: jQuery(this).find('.directory-card__count, .category-card__count').first().text().trim(),
                style: {
                    "type": "rect",
                    "ratio": rect
                }
            });
        });
        return items;
    }

    function getTags(select) {
        let tags = [];
        jQuery(select).each(function () {
            const href = jQuery(this).attr('href') || '';
            const name = jQuery(this).text().trim();
            if (!href) {
                tags.push(name);
                return;
            }
            // 标签的落地页是搜索页（站点已无 tag 页）：/zh/search?q=xxx。
            // 宿主把 tid 拼进 "https://javtiful.com/zh/${tid}?sort=&page="，
            // 故标签的 tid 需自带 "search?q=xxx&"；否则拼出 "?q=xxx?sort="，
            // 搜索词会被污染成 "xxx?sort="（实测只剩模糊匹配的零星结果）。
            let id = href.replace(/^\/zh\//, '');
            if (href.indexOf('/zh/search?q=') === 0) id += '&';
            tags.push(`[a=cr:{"id":"${id}","name":"${name}"}/]${name}[/a]`);
        });
        return tags;
    }

    // 首页是聚合页（.home-section 若干块），首个板块即「为你推荐」，沿用旧行为只取这一块
    function homeVideos() {
        var $sec = jQuery('.home-section').first();
        if (!$sec.length) $sec = jQuery('.video-grid').first();
        return listVideos($sec.find('article.video-card'));
    }

    const GmSpider = {
        homeContent: function () {
            const SORT_FILTER = [{
                key: 'sort', name: '排序', value: [
                    {n: '最新', v: ''},
                    {n: '今日新增', v: 'added_today'},
                    {n: '本周新增', v: 'added_week'},
                    {n: '本月新增', v: 'added_month'},
                    {n: '今日热门', v: 'popular_today'},
                    {n: '本周热门', v: 'popular_week'},
                    {n: '本月热门', v: 'popular_month'},
                    {n: '最多点赞', v: 'most_liked'},
                    {n: '最多观看', v: 'most_viewed'},
                ]
            }];
            return {
                class: [
                    {type_id: 'foryou', type_name: '为你推荐'},
                    {type_id: 'videos', type_name: '最新'},
                    {type_id: 'censored', type_name: '有码'},
                    {type_id: 'uncensored', type_name: '无码'},
                    {type_id: 'reducing-mosaic', type_name: '减码'},
                    {type_id: 'category/chinese-av', type_name: '中国'},
                    {type_id: 'actresses', type_name: '女优'},
                    {type_id: 'channels', type_name: '频道'},
                ],
                list: homeVideos(),
                filters: {
                    'videos': SORT_FILTER,
                    'censored': SORT_FILTER,
                    'uncensored': SORT_FILTER,
                    'reducing-mosaic': SORT_FILTER,
                    'category/chinese-av': SORT_FILTER,
                }
            };
        },

        categoryContent: function (tid) {
            switch (tid) {
                case 'categories':
                    return {
                        list: listFolders(".categories-grid .category-card"),
                        pagecount: 1
                    };
                case 'actresses':
                    return {
                        list: listFolders(".directory-grid .directory-card--actress", 1),
                        pagecount: 1000
                    };
                case 'channels':
                    return {
                        list: listFolders(".directory-grid .directory-card--channel"),
                        pagecount: 1000
                    };
                default:
                    return {
                        list: listVideos(jQuery('article.video-card')),
                        pagecount: 1000
                    };
            }
        },

        detailContent: function (ids) {
            var vid = Array.isArray(ids) ? ids[0] : ids;
            return {
                list: [{
                    vod_id: vid,
                    vod_name: GMSpiderUtils.extractCode(jQuery('meta[property="og:image:alt"]').attr('content')),
                    vod_pic: jQuery('meta[property="og:image"]').attr('content'),
                    vod_remarks: getTags(".watch-detail:eq(1) .watch-link-chip").join(' '),
                    vod_actor: getTags(".watch-actor-list .watch-actor-card").join(' '),
                    vod_director: getTags(".watch-detail:gt(1) .watch-link-chip,.watch-inline-link").join(' '),
                    vod_content: jQuery('meta[property="og:image:alt"]').attr('content'),
                    vod_year: jQuery('meta[property="article:published_time"]').attr('content').substring(0, 10),
                    vod_play_data: [{
                        from: "Javtiful",
                        media: [{
                            name: "正片",
                            type: "direct",
                            ext: { url: jQuery('#front-player source').attr('src') }
                        }]
                    }],
                }]
            };
        },

        searchContent: function () {
            return {
                list: listVideos(jQuery('article.video-card')),
                pagecount: 1000
            };
        },
    };

    $(function () {
        var fn = GmSpider[GMSpiderArgs.fName];
        var result = fn ? fn(...GMSpiderArgs.fArgs) : {};
        console.log(result)
        if (typeof GmSpiderInject !== 'undefined') GmSpiderInject.SetSpiderResult(JSON.stringify(result));
    });
})();
