// ==UserScript==
// @name         Javtiful
// @namespace    gmspider
// @version      2026.07.09
// @description  Javtiful GMSpider
// @author       Luomo
// @match        https://javtiful.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js
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

    function listVideos($cards, titleSelector) {
        var items = [];
        $cards.each(function () {
            var a = this.querySelector('a[href*="/video/"]');
            if (!a) return;
            items.push({
                vod_id: a.href.split('/video/')[1],
                vod_name: jQuery(this).find(".front-video-title").text().trim(),
                vod_pic: window.location.origin + jQuery(this).find('img').attr('data-front-lazy-src'),
                vod_remarks: jQuery(this).find('.front-duration-tag').text().trim(),
            });
        });
        return items;
    }

    function listFolders(select, rect = 1.78) {
        let items = [];
        jQuery(select).each(function () {
            items.push({
                vod_id: jQuery(this).find(".front-collection-card-link").attr('href').replace(/^\/zh\//, ''),
                vod_name: jQuery(this).find(".front-collection-title").text().trim(),
                vod_tag: 'folder',
                vod_pic: window.location.origin + jQuery(this).find('img').attr('data-front-lazy-original-src'),
                vod_remarks: jQuery(this).find('.front-collection-meta').text().trim(),
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
            const id = jQuery(this).attr('href').replace(/^\/zh\//, '');
            const name = jQuery(this).text().trim();
            tags.push(`[a=cr:{"id":"${id}","name":"${name}"}/]${name}[/a]`);
        });
        return tags;
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
                    {type_id: 'categories', type_name: '分类'},
                    {type_id: 'actresses', type_name: '女优'},
                    {type_id: 'channels', type_name: '频道'},
                ],
                list: listVideos(jQuery('.front-video-grid-foryou .front-video-card'), '.front-video-title'),
                filters: {
                    'videos': SORT_FILTER,
                    'censored': SORT_FILTER,
                    'uncensored': SORT_FILTER,
                    'reducing-mosaic': SORT_FILTER,
                }
            };
        },

        categoryContent: function () {
            switch (arguments[0]) {
                case 'categories':
                    return {
                        list: listFolders(".front-collection-grid-category .front-collection-card-category"),
                        pagecount: 1
                    };
                case 'actresses':
                    return {
                        list: listFolders(".front-collection-grid-actress .front-collection-card-actress", 1),
                        pagecount: 1000
                    };
                case 'channels':
                    return {
                        list: listFolders(".front-collection-grid-channel .front-collection-card-channel"),
                        pagecount: 1000
                    };
                default:
                    return {
                        list: listVideos(jQuery('article.front-video-card'), '.front-video-title'),
                        pagecount: 1000
                    };
            }
        },

        detailContent: function (ids) {
            var vid = Array.isArray(ids) ? ids[0] : ids;
            return {
                list: [{
                    vod_id: vid,
                    vod_name: jQuery('meta[property="og:image:alt"]').attr('content'),
                    vod_pic: jQuery('meta[property="og:image"]').attr('content'),
                    vod_remarks: getTags(".front-watch-detail:eq(1) .front-watch-link-chip").join(' '),
                    vod_actor: getTags(".front-watch-actor-list .front-watch-actor-card").join(' '),
                    vod_director: getTags(".front-watch-detail:gt(1) .front-watch-link-chip,.front-watch-inline-link").join(' '),
                    vod_content: jQuery('meta[property="og:image:alt"]').attr('content'),
                    vod_year: jQuery('meta[property="article:published_time"]').attr('content').substring(0, 10),
                    vod_play_from: "Javtiful",
                    vod_play_url: '正片$' + jQuery('#front-player').attr('src'),
                }]
            };
        },

        searchContent: function () {
            return {
                list: listVideos(jQuery('article.front-video-card'), '.front-video-title'),
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
