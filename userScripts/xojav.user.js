// ==UserScript==
// @name         XOJAV
// @namespace    gmspider
// @version      2024.12.02
// @description  XOJAV GMSpider
// @author       Luomo
// @match        https://xojav.tv/*
// @require      https://cdn.jsdelivr.net/npm/jquery@1.12.4/dist/jquery.min.js
// @grant        unsafeWindow
// ==/UserScript==
(function () {
    const GMSpiderArgs = {};
    if (typeof GmSpiderInject !== 'undefined') {
        let args = JSON.parse(GmSpiderInject.GetSpiderArgs());
        GMSpiderArgs.fName = args.shift();
        GMSpiderArgs.fArgs = args;
    } else {
        GMSpiderArgs.fName = "homeContent";
        GMSpiderArgs.fArgs = [];
    }
    Object.freeze(GMSpiderArgs);
    const GmSpider = (function () {
        function listVideos(select) {
            let vods = [];
            jQuery(select).each(function () {
                const remarks = [
                    "👁️" + jQuery(this).find(".card-video__stats .num:first").text().trim(),
                    "❤️" + jQuery(this).find(".card-video__fav-button .num").text().trim()
                ];
                const url = new URL(jQuery(this).find(".card-video__title a").attr("href"));
                vods.push({
                    vod_id: url.pathname.split('/').at(2).toUpperCase(),
                    vod_name: jQuery(this).find(".card-video__img img").attr("alt"),
                    vod_pic: jQuery(this).find(".card-video__img img").data("src"),
                    vod_remarks: remarks.join(" "),
                    vod_year: jQuery(this).find(".card-video__duration").text().trim()
                })
            })
            return vods;
        }

        return {
            homeContent: function (filter) {
                let result = {
                    class: [
                        {type_id: "latest-updates?sort_by=release_at", type_name: "最近更新"},
                        {type_id: "categories/taiwan-av?sort_by=release_at", type_name: "台湾AV"},
                        {type_id: "stars?sort_by=stars", type_name: "近期最佳"},
                        {type_id: "hot?sort_by=views", type_name: "热门"},
                        {type_id: "categories?", type_name: "所有分类"},
                    ],
                    filters: {
                        "categories/taiwan-av?sort_by=release_at": [{
                            key: "sort_by",
                            name: "排序",
                            value: [
                                {n: "近期最佳", v: "&sort_by=stars"},
                                {n: "观看数", v: "&sort_by=views"},
                                {n: "最近更新", v: "&sort_by=release_at"}
                            ]
                        }],
                        "categories?": [{
                            key: "sort_by",
                            name: "排序",
                            value: [
                                {n: "近期最佳", v: "&sort_by=stars"},
                                {n: "观看数", v: "&sort_by=views"},
                                {n: "最近更新", v: "&sort_by=release_at"},
                            ]
                        }]
                    },
                    list: []
                };
                let itemList = listVideos(".card-video");
                result.list = itemList.filter((item, index) => {
                    return itemList.findIndex(i => i.vod_id === item.vod_id) === index
                });
                return result;
            },
            categoryContent: function (tid, pg, filter, extend) {
                let result = {
                    list: [],
                    pagecount: 1000
                };
                if (tid === "categories?") {
                    jQuery(".padding-bottom-xl").each(function () {
                        let remarks = jQuery(this).find(".title--listing").text().trim();
                        jQuery(this).find(".card-cat-v2").each(function () {
                            const url = new URL(jQuery(this).find(".card-cat-v2__link").attr("href")).pathname.split('/');
                            result.list.push({
                                vod_id: url[1] + "/" + url[2] + "?sort_by=release_at",
                                vod_name: jQuery(this).find(".card-cat-v2__title h4").text(),
                                vod_pic: jQuery(this).find("img").attr("src"),
                                vod_remarks: remarks,
                                vod_tag: "folder",
                                style: {
                                    "type": "rect",
                                    "ratio": 0.7
                                }
                            })
                        });
                    })
                    result.pagecount = 1;
                } else {
                    result.list = listVideos(".card-video");
                }
                return result;
            },
            detailContent: function (ids) {
                let categories = [], tags = [];
                jQuery(".content-details__meta a").each(function () {
                    const url = new URL(jQuery(this).attr("href")).pathname.split('/');
                    const id = url[1] + "/" + url[2] + "?sort_by=release_at";
                    const name = jQuery(this).text().trim();
                    if (name.length > 0) {
                        if (url[1] === "categories") {
                            categories.push(`[a=cr:{"id":"${id}","name":"${name}"}/]${name}[/a]`);
                        } else {
                            tags.push(`[a=cr:{"id":"${id}","name":"${name}"}/]${name}[/a]`);
                        }
                    }
                })
                const vod = {
                    vod_id: ids[0],
                    vod_name: ids[0].toUpperCase(),
                    vod_year: jQuery(".content-details__meta time").text(),
                    vod_remarks: categories.join(" "),
                    vod_actor: tags.join(" "),
                    vod_content: jQuery(".content-details__title").text(),
                    vod_play_data: [{
                        from: "XOJAV",
                        media: [{
                            name: "正片",
                            type: "direct",
                            ext: { url: unsafeWindow.stream }
                        }]
                    }],
                };
                return {list: [vod]};
            },
            searchContent: function (key, quick, pg) {
                const result = {
                    list: [],
                    pagecount: 1000
                };
                result.list = listVideos(".card-video");
                return result;
            }
        };
    })();
    jQuery(document).ready(function () {
        let result = GmSpider[GMSpiderArgs.fName](...GMSpiderArgs.fArgs);
        if (typeof GmSpiderInject !== 'undefined') {
            GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        }
    });
})();

