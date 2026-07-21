// ==UserScript==
// @name         Supjav
// @namespace    gmspider
// @version      2025.11.12
// @description  Supjav GMSpider
// @author       Luomo
// @match        https://supjav.com/*
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
        GMSpiderArgs.fArgs = ["tag"];
    }
    Object.freeze(GMSpiderArgs);
    const GmSpider = (function () {
        function listVideos() {
            let itemList = [];
            jQuery(".post").each(function () {
                const url = new URL(jQuery(this).find(".img").attr("href"));
                itemList.push({
                    vod_id: url.pathname.split('/').at(2),
                    vod_name: jQuery(this).find(".img").attr("title"),
                    vod_pic: formatImgUrl(jQuery(this).find("img").data("original")),
                    vod_remarks: jQuery(this).find(".date").text(),
                    vod_year: jQuery(this).find(".meta").children().remove().end().text()
                })
            });
            return itemList;
        }

        function formatImgUrl(url) {
            return url;
        }

        return {
            homeContent: function (filter) {
                const defaultFilter = [{
                    key: "sort",
                    name: "排序",
                    value: [
                        {
                            n: "观看数",
                            v: "views"
                        },
                        {
                            n: "更新时间",
                            v: ""
                        }
                    ]
                }];
                let result = {
                    class: [
                        {type_id: "popular", type_name: "热门"},
                        {type_id: "category/censored-jav", type_name: "有码"},
                        {type_id: "category/uncensored-jav", type_name: "无码"},
                        {type_id: "category/amateur", type_name: "素人"},
                        {type_id: "category/chinese-subtitles", type_name: "中文字幕"},
                        {type_id: "category/reducing-mosaic", type_name: "无码破解"},
                        {type_id: "category/english-subtitles", type_name: "英文字幕"},
                        {type_id: "tag", type_name: "类别"},
                    ],
                    filters: {
                        popular: [{
                            key: "sort",
                            name: "时间",
                            value: [
                                {
                                    n: "本月热门",
                                    v: "month"
                                },
                                {
                                    n: "本周热门",
                                    v: "week"
                                },
                                {
                                    n: "今日热门",
                                    v: ""
                                }
                            ]
                        }]
                    },
                    list: []
                };
                result.class.forEach((item) => {
                    if (typeof result.filters[item.type_id] === "undefined") {
                        result.filters[item.type_id] = defaultFilter;
                    }
                })
                result.list = listVideos()
                return result;
            },
            categoryContent: function (tid, pg, filter, extend) {
                let result = {
                    list: [],
                    pagecount: 1
                };
                if (tid === "tag") {
                    jQuery(".categorys .child").each(function () {
                        const url = new URL(jQuery(this).find("a").attr("href")).pathname.split('/');
                        const text = jQuery(this).text().trim().split("(")
                        result.list.push({
                            vod_id: url[2] + "/" + url[3],
                            vod_name: text[0],
                            vod_remarks: parseInt(text[1]) + " 部影片",
                            vod_tag: "folder",
                            style: {
                                "type": "rect",
                                "ratio": 1
                            }
                        })
                    });
                    result.pagecount = jQuery(".pagination li").not(".next-page").last().text().trim();
                } else {
                    if (jQuery(".pagination li").length > 0) {
                        result.pagecount = jQuery(".pagination li").not(".next-page").last().text().trim();
                    }
                    result.list = listVideos();
                }
                return result;
            },
            detailContent: function (ids) {
                jQuery("#vserver").click();
                let vodActor = [], tags = [];
                jQuery(".post-meta .cats a").each(function () {
                    const id = new URL(jQuery(this).attr("href")).pathname.replace("/zh/", "");
                    const name = jQuery(this).text().trim();
                    vodActor.unshift(`[a=cr:{"id":"${id}","name":"${name}"}/]${name}[/a]`);
                });
                jQuery(".post-meta .tags a").each(function () {
                    const id = new URL(jQuery(this).attr("href")).pathname.replace("/zh/", "");
                    const name = jQuery(this).text().trim();
                    tags.push(`[a=cr:{"id":"${id}","name":"${name}"}/]#${name}[/a]`);
                });
                let vodContent = jQuery(".post-meta .img").attr("alt").trim();
                let vodName = vodContent.replace("[无码破解]", '');
                let match = vodName.match(/^[\w|-]+/g);
                if (match) {
                    if (match[0].includes("-")) {
                        vodName = match[0];
                    } else {
                        match = vodContent.match(/^[\w]+\s[\w]+/g);
                        if (match) {
                            vodName = match[0].replace(" ", "-");
                        }
                    }
                }
                let vodPlayData = [];
                let btnServers;
                if (jQuery(".video-wrap .cd-server").length > 0) {
                    btnServers = jQuery(".video-wrap .cd-server:first .btn-server");
                } else {
                    btnServers = jQuery(".video-wrap .btn-server");

                }
                btnServers.each(function (i) {
                    vodPlayData.push({
                        from: jQuery(this).text().trim(),
                        media: [{
                            name: vodName,
                            type: "webview",
                            ext: {
                                url: "https://supjav.com/zh/" + ids[0] + "#" + i
                            }
                        }]
                    });
                })
                const result = {
                    list: [{
                        vod_id: ids[0],
                        vod_name: vodName,
                        vod_pic: formatImgUrl(jQuery(".post-meta .img").attr("src")),
                        vod_actor: vodActor.join(" "),
                        vod_remarks: tags.join(" "),
                        vod_content: vodContent,
                        vod_play_data: vodPlayData
                    }]
                };
                return result
            },
            playerContent: function (flag, id, vipFlags) {
                const link = window.location.hash.split("#").at(1);
                document.querySelectorAll(`.video-wrap .btn-server`)[link].dispatchEvent(new Event("click"));
                return {
                    type: "match"
                };
            },
            searchContent: function (key, quick, pg) {
                const result = {
                    list: [],
                    pagecount: 1
                };
                result.list = listVideos();
                if (jQuery(".pagination li").length > 0) {
                    result.pagecount = jQuery(".pagination li").not(".next-page").last().text().trim();
                }
                return result;
            }
        };
    })();
    jQuery(function () {
        const result = GmSpider[GMSpiderArgs.fName](...GMSpiderArgs.fArgs);
        console.log(result);
        if (typeof GmSpiderInject !== 'undefined') {
            GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        }
    });
})();

