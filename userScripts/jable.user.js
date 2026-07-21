// ==UserScript==
// @name         Jable
// @namespace    gmspider
// @version      2026.07.21
// @description  Jable GMSpider
// @author       Luomo
// @match        https://jable.tv/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.2.1/dist/jquery.slim.min.js
// @require      ../Spiders-Lib/utils.js
// @grant        unsafeWindow
// ==/UserScript==
(function () {
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
    const GmSpider = (function () {

        function listVideos() {
            const list = [];
            jQuery("[id^='list_videos_'] .row:first .video-img-box").each(function (i) {
                const subTitle = jQuery(this).find(".sub-title").text().split('\n');
                const remarks = [
                    "👁️" + subTitle[1].trim(),
                    "❤️" + subTitle[2].trim()
                ];
                const url = new URL(jQuery(this).find(".img-box a").attr("href"));
                list.push({
                    vod_id: url.pathname.split('/').at(2).toUpperCase(),
                    vod_name: jQuery(this).find(".title").text(),
                    vod_pic: jQuery(this).find(".img-box img").data("src"),
                    vod_remarks: remarks.join(" "),
                    vod_year: jQuery(this).find(".absolute-bottom-right").text().trim()
                })
            });
            return list;
        }

        return {
            homeContent: function (filter) {
                let result = {
                    class: [
                        {type_id: "latest-updates", type_name: "最近更新"},
                        {type_id: "hot", type_name: "热门影片"},
                        {type_id: "categories/chinese-subtitle", type_name: "中文字幕"},
                        {type_id: "new-release", type_name: "全新上市"},
                        {type_id: "categories", type_name: "主题&标签"},
                    ],
                    filters: {
                        hot: [{
                            key: "sort_by",
                            name: "时间",
                            value: [
                                {
                                    n: "所有时间",
                                    v: "&sort_by=video_viewed"
                                },
                                {
                                    n: "本月热门",
                                    v: "&sort_by=video_viewed_month"
                                },
                                {
                                    n: "本周热门",
                                    v: "&sort_by=video_viewed_week"
                                },
                                {
                                    n: "今日热门",
                                    v: "&sort_by=video_viewed_today"
                                }
                            ]
                        }],
                        "categories/chinese-subtitle": [{
                            key: "sort_by",
                            name: "时间",
                            value: [
                                {
                                    n: "近期最佳",
                                    v: "&sort_by=post_date_and_popularity"
                                },
                                {
                                    n: "最近更新",
                                    v: "&sort_by=post_date"
                                },
                                {
                                    n: "最多观看",
                                    v: "&sort_by=video_viewed"
                                },
                                {
                                    n: "最高收藏",
                                    v: "&sort_by=most_favourited"
                                }
                            ]
                        }],
                        categories: [{
                            key: "sort_by",
                            name: "时间",
                            value: [
                                {
                                    n: "近期最佳",
                                    v: "&sort_by=post_date_and_popularity"
                                },
                                {
                                    n: "最近更新",
                                    v: "&sort_by=post_date"
                                },
                                {
                                    n: "最多观看",
                                    v: "&sort_by=video_viewed"
                                },
                                {
                                    n: "最高收藏",
                                    v: "&sort_by=most_favourited"
                                }
                            ]
                        }]
                    },
                    list: []
                };
                let itemList = [];
                jQuery(".video-img-box").has(".detail").has("img").each(function () {
                    const url = new URL(jQuery(this).find(".img-box a").attr("href"));
                    if (url.hostname === "jable.tv") {
                        itemList.push({
                            vod_id: url.pathname.split('/').at(2).toUpperCase(),
                            vod_name: jQuery(this).find(".title").text(),
                            vod_pic: jQuery(this).find("img").data("src"),
                            vod_year: jQuery(this).find(".absolute-bottom-right").text().trim()
                        })
                    }
                });
                result.list = itemList.filter((item, index) => {
                    return itemList.findIndex(i => i.vod_id === item.vod_id) === index
                });
                return result;
            },
            categoryContent: function (tid, pg, filter, extend) {
                let result = {
                    list: [],
                    pagecount: 1
                };
                if (tid === "categories") {
                    jQuery("#list_categories_video_categories_list .video-img-box").each(function () {
                        const url = new URL(jQuery(this).find("a").attr("href")).pathname.split('/');
                        result.list.push({
                            vod_id: url[1] + "/" + url[2],
                            vod_name: jQuery(this).find("h4").text(),
                            vod_pic: jQuery(this).find("img").attr("src"),
                            vod_remarks: jQuery(this).find(".absolute-center span").text(),
                            vod_tag: "folder",
                            style: {
                                "type": "rect",
                                "ratio": 1
                            }
                        })
                    });
                    const tags = [];
                    jQuery(".app-nav .title-box:gt(0)").each(function () {
                        const remark = jQuery(this).text();
                        jQuery(this).next(".row").find(".tag").each(function () {
                            const url = new URL(jQuery(this).attr("href")).pathname.split('/');
                            result.list.push({
                                vod_id: url[1] + "/" + url[2],
                                vod_name: jQuery(this).text(),
                                vod_remarks: remark,
                                vod_tag: "folder",
                            })
                        });
                    });
                    result.pagecount = 1;
                } else {
                    result.list = listVideos();
                    result.pagecount = 1000;
                }
                return result;
            },
            detailContent: function (ids) {
                let vodActor = [], categories = [], tags = [];
                jQuery(".video-info .info-header .models .model").each(function () {
                    const url = new URL(jQuery(this).attr("href")).pathname.split('/');
                    const id = url[1] + "/" + url[2];
                    const name = jQuery(this).find(".rounded-circle").data("original-title");
                    vodActor.push(`[a=cr:{"id":"${id}","name":"${name}"}/]${name}[/a]`);
                });
                jQuery(".video-info .tags .cat").each(function () {
                    const url = new URL(jQuery(this).attr("href")).pathname.split('/');
                    const id = url[1] + "/" + url[2];
                    const name = jQuery(this).text();
                    categories.push(`[a=cr:{"id":"${id}","name":"${name}"}/]#${name}[/a]`);
                });
                jQuery(".video-info .tags a:not(.cat)").each(function () {
                    const url = new URL(jQuery(this).attr("href")).pathname.split('/');
                    const id = url[1] + "/" + url[2];
                    const name = jQuery(this).text();
                    tags.push(`[a=cr:{"id":"${id}","name":"${name}"}/]#${name}[/a]`);
                });
                return {
                    list: [{
                        vod_id: ids[0],
                        vod_name: GMSpiderUtils.extractCode(jQuery('meta[property="og:title"]').attr('content')),
                        vod_year: GMSpiderUtils.extractDate(jQuery(".video-info .info-header .inactive-color").text().trim()),
                        vod_remarks: tags.join(" "),
                        vod_actor: vodActor.join(" ") + " " + categories.join(" "),
                        vod_content: jQuery('meta[property="og:title"]').attr('content'),
                        vod_play_data: [{
                            from: "Jable",
                            media: [{
                                name: "正片",
                                type: "direct",
                                ext: {url: unsafeWindow.hlsUrl}
                            }]
                        }],
                    }]
                };
            },
            searchContent: function (key, quick, pg) {
                const result = {
                    list: listVideos(),
                    pagecount: 1000
                };
                return result;
            }
        };
    })();
    jQuery(document).ready(function () {
        let result = GmSpider[GMSpiderArgs.fName](...GMSpiderArgs.fArgs);
        console.log(JSON.stringify(result));
        if (typeof GmSpiderInject !== 'undefined') {
            GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        }
    });
})();

