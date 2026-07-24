// ==UserScript==
// @name         AV01
// @namespace    gmspider
// @version      2026.07.24
// @description  AV01 GMSpider
// @author       Luomo
// @match        https://www.av01.media/*
// @require      ../Spiders-Lib/utils.js
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    const GMSpiderArgs = {};
    if (typeof GmSpiderInject !== 'undefined') {
        let args = JSON.parse(GmSpiderInject.GetSpiderArgs());
        GMSpiderArgs.fName = args.shift();
        GMSpiderArgs.fArgs = args;
    } else {
        GMSpiderArgs.fName = "homeContent";
        GMSpiderArgs.fArgs = [""];
    }
    Object.freeze(GMSpiderArgs);

    var cdnToken = '';
    var name = GMSpiderArgs.fName;
    var urls = {geo: '/edge/geo.js'};
    var handler = null;

    switch (name) {
        case 'homeContent':
            urls.combined = function (u) {
                return u.includes('/types/combined');
            };
            urls.tags = function (u) {
                return u.includes('/tags/by-score');
            };
            urls.makers = function (u) {
                return u.includes('/makers/by-score');
            };
            handler = function (h) {
                var videos = (h.combined && h.combined.hottest_videos && h.combined.hottest_videos.videos) || [];
                var tagOptions = [{n: '全部', v: ''}];
                (h.tags && h.tags.tags || []).forEach(function (t) {
                    tagOptions.push({n: (t.name_translations && t.name_translations.cn) || t.name, v: String(t.id)});
                });
                var makerOptions = [{n: '全部', v: ''}];
                (h.makers && h.makers.makers || []).forEach(function (m) {
                    makerOptions.push({n: (m.name_translations && m.name_translations.cn) || m.name, v: String(m.id)});
                });
                return {
                    class: [{type_id: 'videos/latest', type_name: '最新'}, {
                        type_id: 'videos/hottest',
                        type_name: '热门'
                    }],
                    list: videos.map(function (v) {
                        return {
                            vod_id: v.id + '/' + v.dvd_id,
                            vod_name: (v.title_translations && v.title_translations.cn) || v.title,
                            vod_pic: 'https://files.iw01.xyz/covers/' + v.id + '/800.webp' + (cdnToken ? '?' + cdnToken : ''),
                            vod_remarks: Math.floor(v.duration / 60) + 'm'
                        };
                    }),
                    filters: {
                        "videos/latest": [{
                            key: 'tag', name: '标签', value: tagOptions
                        }, {
                            key: 'maker',
                            name: '制作商',
                            value: makerOptions
                        }],
                        'videos/hottest': [{
                            key: 'tag', name: '标签', value: tagOptions
                        }, {
                            key: 'maker',
                            name: '制作商',
                            value: makerOptions
                        }]
                    }
                };
            };
            break;
        case 'categoryContent':
            urls.data = function (u) {
                return u.includes('/types/' + GMSpiderArgs.fArgs[0].split('/').pop()) || u.includes('/complex_search') || u.includes('/videos/tag/') || u.includes('/videos/maker/') || u.includes('/videos/actress/');
            };
            handler = function (h) {
                var videos = h.data.videos || [];
                return {
                    list: videos.map(function (v) {
                        return {
                            vod_id: v.id + '/' + v.dvd_id,
                            vod_name: (v.title_translations && v.title_translations.cn) || v.title,
                            vod_pic: 'https://files.iw01.xyz/covers/' + v.id + '/800.webp' + (cdnToken ? '?' + cdnToken : ''),
                            vod_remarks: Math.floor(v.duration / 60) + 'm'
                        };
                    }), pagecount: 1000
                };
            };
            break;
        case 'detailContent':
            urls.cdn = function (u) {
                return u.includes('/cdn-access');
            };
            urls.data = function (u) {
                var id = u.split('/api/v1/videos/')[1];
                return id && /^\d+$/.test(id);
            };
            handler = function (results) {
                const video = results.data;
                if (!video) return {list: []};
                const title = (video.title_translations && video.title_translations.cn) || video.title;
                const actress = (video.actresses || []).map(actor => {
                    const name = (actor.name_translations && actor.name_translations.cn) || actor.name;
                    return `[a=cr:{"id":"actress/${actor.id}/${encodeURIComponent(name)}","name":"${name}"}/]${name}[/a]`;
                }).join(' ');
                const tags = (video.tags || []).map(tag => {
                    const name = (tag.name_translations && tag.name_translations.cn) || tag.name;
                    return `[a=cr:{"id":"tag/${tag.id}/${encodeURIComponent(name)}","name":"#${name}"}/]#${name}[/a]`;
                }).join(' ');
                const makerName = (video.maker_translations && video.maker_translations.cn) || video.maker;
                const makerLink = makerName ? ` [a=cr:{"id":"maker/${video.maker_id}/${encodeURIComponent(makerName)}","name":"${makerName}"}/]${makerName}[/a]` : '';
                const token = results.cdn && results.cdn.access_token;
                return {
                    list: [{
                        vod_id: video.id + '/' + video.dvd_id,
                        vod_name: GMSpiderUtils.extractCode(video.dvd_id + ' ' + title),
                        vod_pic: `https://files.iw01.xyz/covers/${video.id}/800.webp${cdnToken ? '?' + cdnToken : ''}`,
                        vod_remarks: tags,
                        vod_actor: actress + makerLink,
                        vod_content: title,
                        vod_year: (video.published_time || video.uploaded_time || '').substring(0, 10),
                        vod_play_data: [{
                            from: 'AV01',
                            media: [{
                                name: '正片',
                                type: 'direct',
                                ext: {url: `https://www.av01.media/api/v1/videos/${video.id}/manifest/index90-v3-a1.m3u8?access_token=${token}`}
                            }]
                        }]
                    }]
                };
            };
            break;
        case 'searchContent':
            urls.data = function (u) {
                return u.includes('/api/v1/videos/search');
            };
            handler = function (h) {
                return {
                    list: (h.data.videos || []).map(function (v) {
                        return {
                            vod_id: v.id + '/' + v.dvd_id,
                            vod_name: (v.title_translations && v.title_translations.cn) || v.title,
                            vod_pic: 'https://files.iw01.xyz/covers/' + v.id + '/800.webp' + (cdnToken ? '?' + cdnToken : ''),
                            vod_remarks: Math.floor((v.duration || 0) / 60) + 'm'
                        };
                    }), pagecount: 1000, page: 1
                };
            };
            break;
    }

    if (handler) {
        GMSpiderUtils.hookFetch(unsafeWindow, urls, function (results) {
            if (results.geo) cdnToken = 'token_v2=' + results.geo.token_v2 + '&expires=' + results.geo.expires + '&ip=' + results.geo.ip;
            var result = handler(results);
            console.log(JSON.stringify(result));
            if (typeof GmSpiderInject !== 'undefined') GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        });
    }
})();
