// ==UserScript==
// @name         AVPorner
// @namespace    gmspider
// @version      2026.07.09
// @description  AVPorner GMSpider
// @author       Luomo
// @match        https://avporner.com/*
// @match        https://hornyhill.st/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.2.1/dist/jquery.slim.min.js
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
        GMSpiderArgs.fName = "searchContent";
        GMSpiderArgs.fArgs = ["starts"];
    }
    Object.freeze(GMSpiderArgs);

    function listVideos(cards, titleSelector) {
        let items = [];
        cards.each(function () {
            const id = new URL(jQuery(this).find(titleSelector + ' a').attr('href')).pathname.split('/').pop().replace('.html', '')
            items.push({
                vod_id: id,
                vod_name: jQuery(this).find(titleSelector).text().trim(),
                vod_pic: jQuery(this).find('img').attr('src'),
                vod_remarks: jQuery(this).find('.duration').text().trim(),
            });
        });
        return items;
    }

    function listFolders(select) {
        let items = [];
        jQuery(select).each(function () {
            items.push({
                vod_id: new URL(jQuery(this).attr('href')).pathname.replace(/^\//, ''),
                vod_name: jQuery(this).text().trim(),
                vod_tag: 'folder',
                style: {
                    "type": "rect",
                    "ratio": 3
                }
            });
        });
        return items;
    }

    function getTags(type) {
        let tags = [];
        jQuery(`[itemtype="https://schema.org/${type}"] a`).each(function () {
            const id = new URL(this.href).pathname.replace(/^\//, '');
            const name = $(this).text().trim();
            tags.push(`[a=cr:{"id":"${id}","name":"${name}"}/]${name}[/a]`);
        });
        return tags;
    }

    const GmSpider = {
        homeContent: function () {
            return {
                class: [
                    {type_id: 'videos/latest', type_name: '最新'},
                    {type_id: 'videos/trending', type_name: '趋势'},
                    {type_id: 'videos/top', type_name: '热门'},
                    {type_id: 'videos/category/Uncensored', type_name: '无码'},
                    {type_id: 'videos/category/Chinese', type_name: '中国'},
                    {type_id: 'videos/category/Korean', type_name: '韩国'},
                    {type_id: 'videos/category/Cam', type_name: '直播录像'},
                    {type_id: 'studios', type_name: '厂牌'},
                    {type_id: 'categories', type_name: '分类'}
                ],
                list: listVideos(jQuery('.container-home .home-page-categories').slice(0, 3).find('.video-list'), '.video-list-title'),
                filters: {
                    'videos/top': [
                        {
                            key: 'time', name: '时间', value: [
                                {n: '不限', v: ''},
                                {n: '今天', v: '&type=today'},
                                {n: '本周', v: '&type=this_week'},
                                {n: '本月', v: '&type=this_month'},
                                {n: '今年', v: '&type=this_year'},
                            ]
                        }
                    ]
                }
            };
        },

        categoryContent: function () {
            switch (arguments[0]) {
                case 'studios':
                    return {list: listFolders(".channel-list .pill"), pagecount: 1};
                case 'categories':
                    return {list: listFolders(".categories-list .pill"), pagecount: 1};
                default:
                    return {
                        list: listVideos(jQuery('.container-home .video-wrapper'), '.video-title'),
                        pagecount: 1000
                    };
            }
        },

        detailContent: function (ids) {
            let vid = Array.isArray(ids) ? ids[0] : ids;
            let jsonld = JSON.parse(jQuery('script[type="application/ld+json"]').html());
            return {
                list: [{
                    vod_id: vid,
                    vod_name: GMSpiderUtils.extractCode(jsonld.name),
                    vod_pic: jsonld.thumbnailUrl,
                    vod_remarks: getTags("CollectionPage").join(' '),
                    vod_actor: getTags("Person").join(' '),
                    type_name: getTags("Organization").join(' '),
                    vod_content: jsonld.name,
                    vod_year: (jsonld.uploadDate || '').substring(0, 10),
                    vod_play_data: [{
                        from: "AVPorner",
                        media: [{
                            name: "正片",
                            type: "webview",
                            ext: {url: (jQuery('script').text().match(/var embedUrl\s*=\s*'([^']+)'/) || [])[1]}
                        }]
                    }],
                }]
            };
        },

        playerContent: function () {
            return {
                type: "direct",
                ext: {url: jwplayer().getPlaylist()[0].file}
            };
        },

        searchContent: function () {
            return {
                list: listVideos(jQuery('.container-home .video-wrapper'), '.video-title'),
                pagecount: 1000,
                page: 1
            };
        },
    };

    $(function () {
        var fn = GmSpider[GMSpiderArgs.fName];
        var result = fn ? fn(...GMSpiderArgs.fArgs) : {};
        console.log(JSON.stringify(result));
        if (typeof GmSpiderInject !== 'undefined') {
            GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        }
    });
})();
