// ==UserScript==
// @name         JAVGG
// @namespace    gmspider
// @version      2026.07.08
// @description  JAVGG GMSpider
// @author       Luomo
// @match        https://javgg.net/*
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
        GMSpiderArgs.fName = "detailContent";
        GMSpiderArgs.fArgs = [true];
    }
    Object.freeze(GMSpiderArgs);

    function listVideos(cards, titleSelector) {
        let items = [];
        cards.each(function () {
            const id = new URL(jQuery(this).find('.data a').attr('href')).pathname.split('/').at(-2)
            items.push({
                vod_id: id,
                vod_name: jQuery(this).find(".titlecontent").text().trim(),
                vod_pic: jQuery(this).find('img').attr('data-src') || jQuery(this).find('img').attr('src'),
                vod_remarks: jQuery(this).find('.featu').text().trim(),
            });
        });
        return items;
    }

    const GmSpider = {
        homeContent: function () {
            const filter = {
                key: "sort", name: "排序", value: [{
                    n: "全部", v: ""
                }, {
                    n: "本月", v: "monthly"
                }, {
                    n: "本周", v: "weekly"
                }, {
                    n: "今日", v: "today"
                }]
            };
            return {
                class: [{type_id: 'new-post', type_name: '最新'}, {
                    type_id: 'trending', type_name: '热门'
                }, {type_id: 'featured', type_name: '精选'}],
                list: listVideos(jQuery("#featured-titles .owl-item")),
                filters: {
                    "trending": filter, "featured": filter
                },
            };
        },

        categoryContent: function () {
            return {
                list: listVideos(jQuery(".items .movies")), pagecount: 1000, page: parseInt(arguments[1]) || 1,
            };
        },

        detailContent: function (ids) {
            let tags = {};
            jQuery("#cover a[rel='tag']").each(function () {
                let tagInfo = new URL(jQuery(this).attr('href')).pathname.split('/');
                (tags[tagInfo[1]] ??= []).push(`[a=cr:{"id":"${tagInfo[1]}/${tagInfo[2]}","name":"${jQuery(this).text().trim()}"}/]${jQuery(this).text().trim()}[/a]`);
            })
            let vodPlayData = [];
            jQuery("#playeroptions .dooplay_player_option").each(function () {
                vodPlayData.push({
                    from: (t => t === 'Server' ? '' : (t + " "))(jQuery(this).find(".title").text().trim()) + jQuery(this).find(".server").text().trim(),
                    media: [{
                        name: "正片",
                        type: "webview",
                        ext: {
                            replace: {
                                url: jQuery("#source-player-" + jQuery(this).data("nume")).find("#playaa").attr("src"),
                            }
                        }
                    }]
                });
            })
            return {
                list: [{
                    vod_id: ids[0],
                    vod_name: jQuery('meta[property="og:title"]').attr('content'),
                    vod_pic: jQuery('meta[property="og:image"]').attr('content'),
                    vod_year: jQuery('span[itemprop="dateCreated"]').text().trim(),
                    vod_actor: tags?.star?.join(' ') ?? '',
                    vod_remarks: tags?.genre?.join(' ') ?? '',
                    type_name: tags?.tag?.join(' ') ?? '',
                    vod_content: jQuery('meta[property="og:description"]').attr('content'),
                    vod_play_data: vodPlayData
                }]
            };
        },
        playerContent: function (flag, id, vipFlags) {
            return {
                type: "match"
            };
        },
        searchContent: function () {
            return {
                list: listVideos(), pagecount: 1000, page: parseInt(arguments[2]) || 1,
            };
        },
    };

    jQuery(function () {
        const fn = GmSpider[GMSpiderArgs.fName];
        const result = fn ? fn(...GMSpiderArgs.fArgs) : {};
        console.log(result)
        if (typeof GmSpiderInject !== 'undefined') {
            GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        }
    });
})();
