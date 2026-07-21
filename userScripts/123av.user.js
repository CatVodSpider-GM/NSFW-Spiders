// ==UserScript==
// @name         123av
// @namespace    gmspider
// @version      2024.12.03
// @description  123av GMSpider
// @author       Luomo
// @match        https://123av.com/*
// @match        https://javplayer.cc/*
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.slim.min.js
// @grant        unsafeWindow
// ==/UserScript==
console.log(JSON.stringify(GM_info));
(function () {
    const GMSpiderArgs = {};
    if (typeof GmSpiderInject !== 'undefined') {
        let args = JSON.parse(GmSpiderInject.GetSpiderArgs());
        GMSpiderArgs.fName = args.shift();
        GMSpiderArgs.fArgs = args;
    } else {
        GMSpiderArgs.fName = "detailContent";
        GMSpiderArgs.fArgs = ["tags"];
    }
    Object.freeze(GMSpiderArgs);
    const GmSpider = (function () {
        const typeFilter = {
            key: "type",
            name: "类型",
            value: [
                {
                    n: "所有",
                    v: ""
                },
                {
                    n: "有码",
                    v: "censored"
                },
                {
                    n: "无码",
                    v: "uncensored"
                },
                {
                    n: "有码",
                    v: "uncensored-leaked"
                }
            ]
        };
        const defaultFilter = [
            {
                key: "actress",
                name: "女演员",
                value: [
                    {
                        n: "全部",
                        v: ""
                    },
                    {
                        n: "单人",
                        v: "censored"
                    },
                    {
                        n: "多人",
                        v: "multi"
                    }
                ]
            },
            {
                key: "sort",
                name: "排序",
                value: [
                    {
                        n: "发布日期",
                        v: "release_date"
                    },
                    {
                        n: "最近添加",
                        v: "recent"
                    },
                    {
                        n: "热门",
                        v: "hot"
                    },
                    {
                        n: "今日观看",
                        v: "today"
                    },
                    {
                        n: "本周观看",
                        v: "week"
                    },
                    {
                        n: "本月观看",
                        v: "month"
                    },
                    {
                        n: "最受欢迎",
                        v: "views"
                    },
                    {
                        n: "最多关注",
                        v: "follows"
                    },
                    {
                        n: "最长",
                        v: "longest"
                    }
                ]
            }];

        function listVideos(select) {
            let itemList = [];
            jQuery(select).each(function (i) {
                itemList.push({
                    vod_id: jQuery(this).find(".card__link").attr("href").split("/").pop(),
                    vod_name: jQuery(this).find(".card__link").text().trim(),
                    vod_pic: jQuery(this).find(".card__img").attr("src"),
                    vod_year: jQuery(this).find(".card__meta span:first").text().trim(),
                    vod_remarks: jQuery(this).find('.card__dur').text().trim(),
                })
            });
            return itemList;
        }

        function formatDetail(detail, ...keys) {
            let format = "";
            for (let key of keys) {
                format += key in detail ? (Array.isArray(detail[key]) ? detail[key].join(" ") : detail[key]) : "";
            }
            return format;
        }


        return {
            homeContent: function () {
                return {
                    class: [
                        {type_id: "all", type_name: "所有影片"},
                        {type_id: "censored", type_name: "有码"},
                        {type_id: "uncensored", type_name: "无码"},
                        {type_id: "uncensored-leaked", type_name: "无码泄露"}
                    ],
                    filters: {
                        "all": [typeFilter, ...defaultFilter],
                        "censored": defaultFilter,
                        "uncensored": defaultFilter,
                        "uncensored-leaked": defaultFilter,
                    },
                    list: listVideos(".grid .card")
                };
            },
            categoryContent: function (tid) {
                return {
                    list: listVideos(".grid .card"),
                    pagecount: 1000
                };
            },
            detailContent: function (ids) {
                let detail = {};
                jQuery(".watch__info .watch__info-row").each(function (item) {
                    const key = jQuery(this).find("dt").text().trim();
                    if (jQuery(this).find("dd a").length === 0) {
                        detail[key] = jQuery(this).find("dd").text().trim();
                    } else {
                        detail[key] = [];
                        jQuery(this).find("dd a").each(function () {
                            const id = jQuery(this).attr("href");
                            const name = jQuery(this).text();
                            detail[key].push(`[a=cr:{"id":"${id}","name":"${name}"}/]${name}[/a]`);
                        })
                    }
                });
                const vod = {
                    vod_id: ids[0],
                    vod_name: formatDetail(detail, "代码"),
                    vod_year: formatDetail(detail, "发布日期"),
                    vod_remarks: formatDetail(detail, "类型"),
                    vod_director: formatDetail(detail, "制作商", "标签"),
                    vod_actor: formatDetail(detail, "演员"),
                    vod_content: jQuery(".watch__title").text().trim(),
                    vod_play_data: [{
                        from: "123AV",
                        media: [{
                            name: "正片",
                            type: "webview",
                            ext: {
                                url: jQuery(".player__frame").attr("src")
                            }
                        }]
                    }]
                };
                return {list: [vod]};
            },
            playerContent: function () {
                return {
                    type: "match"
                };
            },
            searchContent: function (key, quick, pg) {
                const result = {
                    list: [],
                    page: pg,
                    pagecount: 0
                };
                result.list = pageList("#page-list .box-item-list .box-item");
                result.pagecount = Math.ceil(parseInt(jQuery("#page-list .section-title .text-muted").text().replace(",", "")) / 12);
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