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
    var latestGeo = null;      // 最近一次 geo 响应，用于自取分片鉴权 token
    var name = GMSpiderArgs.fName;
    var urls = {geo: '/edge/geo.js'};
    var handler = null;

    /**
     * 取站点权威播放地址：优先读 SSR 输出的 <video><source src>（master.m3u8），
     * 退回非 blob 的 video[src]。video.src 在 MSE 下是 blob:，宿主无法使用。
     */
    function getSourceUrl() {
        var el = document.querySelector('video source[src]');
        if (el) {
            try {
                return new URL(el.getAttribute('src'), location.origin).href;
            } catch (e) {}
        }
        var v = document.querySelector('video[src]');
        var raw = v && v.getAttribute('src');
        if (raw && raw.indexOf('blob:') !== 0) {
            try {
                return new URL(raw, location.origin).href;
            } catch (e) {}
        }
        return '';
    }

    /** 等 <source> 渲染出来再取地址（SSR 通常首屏即有，此处仅兜底） */
    function waitSourceUrl(timeout) {
        timeout = timeout || 8000;
        return new Promise(function (resolve) {
            var now = getSourceUrl();
            if (now) return resolve(now);
            var done = false, timer = null;
            var obs = new MutationObserver(function () {
                if (done) return;
                var u = getSourceUrl();
                if (u) { done = true; obs.disconnect(); clearTimeout(timer); resolve(u); }
            });
            obs.observe(document.documentElement, {childList: true, subtree: true});
            timer = setTimeout(function () {
                if (done) return;
                done = true; obs.disconnect(); resolve(getSourceUrl());
            }, timeout);
        });
    }

    /**
     * 取 CDN 分片鉴权 token（access_token JWT）。
     * 分片（customers.iw01.xyz/.../*.m4s）必须在 URL 上带 ?access_token=，manifest 的 hb 对其无效。
     * token 自行向 cdn-access 换取，不依赖页面是否发起该请求。
     */
    function resolveCdnToken(videoId) {
        if (!latestGeo || !latestGeo.token_v2) return Promise.resolve('');
        var u = 'https://customers.iw01.xyz/api/v1/videos/' + videoId + '/cdn-access'
            + '?token_v2=' + encodeURIComponent(latestGeo.token_v2)
            + '&expires=' + encodeURIComponent(latestGeo.expires)
            + '&ip=' + encodeURIComponent(latestGeo.ip);
        return fetch(u)
            .then(function (r) { return r.json(); })
            .then(function (j) { return (j && j.access_token) || ''; })
            .catch(function () { return ''; });
    }

    /** 给子资源地址追加 access_token */
    function withToken(u, token) {
        if (!token) return u;
        return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'access_token=' + token;
    }

    /** 把 playlist 中所有子资源（#EXT-X-MAP 与分片行）转成绝对地址并带上 token */
    function tokenizePlaylist(text, baseUrl, token) {
        return text.split('\n').map(function (line) {
            var l = line.trim();
            if (!l) return line;
            if (l.charAt(0) === '#') {
                return line.replace(/URI="([^"]+)"/g, function (m, uri) {
                    return 'URI="' + withToken(new URL(uri, baseUrl).href, token) + '"';
                });
            }
            return withToken(new URL(l, baseUrl).href, token);
        }).join('\n');
    }

    /** 从 master 播放列表中挑码率最高的一档，返回绝对地址 */
    function pickHighestVariant(text, baseUrl) {
        var lines = text.split('\n'), best = '', bestBw = -1;
        for (var i = 0; i < lines.length; i++) {
            if (!/^#EXT-X-STREAM-INF/.test(lines[i].trim())) continue;
            var m = lines[i].match(/BANDWIDTH=(\d+)/);
            var bw = m ? parseInt(m[1], 10) : 0;
            var j = i + 1;
            while (j < lines.length && (!lines[j].trim() || lines[j].trim().charAt(0) === '#')) j++;
            if (j < lines.length && bw > bestBw) { bestBw = bw; best = lines[j].trim(); }
        }
        return best ? new URL(best, baseUrl).href : '';
    }

    /**
     * 构建可直接播放的 media：master → 最高码率单档 → 分片地址补 access_token。
     * 任一步失败则退回 master 地址（不阻断详情返回）。
     */
    function buildDirectMedia(video, masterUrl) {
        var fallback = 'https://www.av01.media/api/v1/videos/' + video.id + '/manifest/master.m3u8';
        if (!masterUrl) return Promise.resolve({name: '正片', type: 'direct', ext: {url: fallback}});
        return resolveCdnToken(video.id).then(function (token) {
            return fetch(masterUrl).then(function (r) { return r.text(); }).then(function (master) {
                var variantUrl = pickHighestVariant(master, masterUrl);
                if (!variantUrl) return {name: '正片', type: 'direct', ext: {url: masterUrl}};
                if (!token) return {name: '正片', type: 'direct', ext: {url: variantUrl}};
                return fetch(variantUrl).then(function (r) { return r.text(); }).then(function (variant) {
                    return {
                        name: '正片',
                        type: 'direct',
                        ext: {url: masterUrl, file: tokenizePlaylist(variant, variantUrl, token)}
                    };
                });
            });
        }).catch(function () {
            return {name: '正片', type: 'direct', ext: {url: fallback}};
        });
    }

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
                            vod_name:GMSpiderUtils.extractCode(v.dvd_id ) + ((v.title_translations && v.title_translations.cn) || v.title),
                            vod_pic: 'https://files.iw01.xyz/covers/' + v.id + '/800.webp' + (cdnToken ? '?' + cdnToken : ''),
                            vod_remarks: Math.floor(v.duration / 60) + 'm'
                        };
                    }), pagecount: 1000
                };
            };
            break;
        case 'detailContent':
            // 分片 token 由 resolveCdnToken 自取，不把 cdn-access 作为 batch 键，避免阻塞返回
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
                const vodItem = {
                    vod_id: video.id + '/' + video.dvd_id,
                    vod_name: GMSpiderUtils.extractCode(video.dvd_id + ' ' + title),
                    vod_pic: `https://files.iw01.xyz/covers/${video.id}/800.webp${cdnToken ? '?' + cdnToken : ''}`,
                    vod_remarks: tags,
                    vod_actor: actress + makerLink,
                    vod_content: title,
                    vod_year: (video.published_time || video.uploaded_time || '').substring(0, 10)
                };
                return waitSourceUrl(8000).then(function (masterUrl) {
                    return buildDirectMedia(video, masterUrl);
                }).then(function (media) {
                    vodItem.vod_play_data = [{from: 'AV01', media: [media]}];
                    return {list: [vodItem]};
                });
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
            if (results.geo) {
                latestGeo = results.geo;
                cdnToken = 'token_v2=' + results.geo.token_v2 + '&expires=' + results.geo.expires + '&ip=' + results.geo.ip;
            }
            Promise.resolve().then(function () {
                return handler(results);
            }).then(function (result) {
                console.log(JSON.stringify(result));
                if (typeof GmSpiderInject !== 'undefined') GmSpiderInject.SetSpiderResult(JSON.stringify(result));
            }).catch(function (e) {
                console.log('handler error: ' + (e && e.message ? e.message : e));
            });
        });
    }
})();
