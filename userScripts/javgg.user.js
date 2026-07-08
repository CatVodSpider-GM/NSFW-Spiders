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
        GMSpiderArgs.fName = "homeContent";
        GMSpiderArgs.fArgs = [true];
    }
    Object.freeze(GMSpiderArgs);

    function listVideos() {
        const seen = new Set();
        const items = [];
        jQuery('.poster').each(function () {
            const a = this.querySelector('a[href*="/jav/"]');
            if (!a) return;
            const m = a.href.match(/\/jav\/([^/]+)\//);
            const id = m ? m[1] : '';
            if (!id || seen.has(id)) return;
            seen.add(id);
            const img = this.querySelector('img');
            const title = jQuery(this).find('.titlecontent').text().trim();
            items.push({
                vod_id: id,
                vod_name: title || (img ? img.alt : '') || id,
                vod_pic: img ? (img.src || img.getAttribute('data-src') || '') : '',
                vod_remarks: '',
            });
        });
        return items;
    }

    function getPageCount() {
        const text = jQuery('.pagination span').first().text();
        const m = text.match(/of\s+(\d+)/);
        return m ? parseInt(m[1]) : 1;
    }

    const GmSpider = {
        homeContent: function () {
            return {
                class: [
                    {type_id: 'new-post', type_name: '最新'},
                    {type_id: 'trending', type_name: '热门'},
                    {type_id: 'top-actress', type_name: '热门女优'},
                    {type_id: 'featured', type_name: '精选'},
                ],
                list: listVideos(),
                filters: {},
            };
        },

        categoryContent: function () {
            return {
                list: listVideos(),
                pagecount: getPageCount(),
                page: parseInt(arguments[1]) || 1,
            };
        },

        detailContent: function (ids) {
            const code = Array.isArray(ids) ? ids[0] : ids;
            const h1 = document.querySelector('h1');
            const name = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : code;
            const cover = jQuery('meta[property="og:image"]').attr('content') || '';
            const playUrl = jQuery('video[src]').first().attr('src') || '';

            const actors = [], tagSet = new Set(), tags = [];
            jQuery('a[href*="/star/"]').each(function () {
                const t = jQuery(this).text().trim();
                if (t && t !== 'JAV Actress List' && t !== 'All Actress' && t.length < 30 && !t.includes('(')) {
                    actors.push(t);
                }
            });
            jQuery('.entry-tags a, a[href*="/tag/"]').each(function () {
                const t = jQuery(this).text().trim();
                if (t && t !== 'Genre' && t !== 'Category' && !tagSet.has(t)) {
                    tagSet.add(t); tags.push(t);
                }
            });
            const typeName = jQuery('a[href*="/tag/censored/"],a[href*="/tag/uncensored/"]').first().text().trim()
                || jQuery('.cat-links a').first().text().trim();

            return {
                list: [{
                    vod_id: code,
                    vod_name: name,
                    vod_pic: cover,
                    vod_actor: [...new Set(actors)].join(' '),
                    vod_remarks: tags.join(','),
                    type_name: typeName,
                    vod_play_from: playUrl ? 'JAVGG' : '',
                    vod_play_url: playUrl ? '直接播放$' + playUrl : '',
                }]
            };
        },

        searchContent: function () {
            return {
                list: listVideos(),
                pagecount: getPageCount(),
                page: parseInt(arguments[2]) || 1,
            };
        },
    };

    $(function () {
        const fn = GmSpider[GMSpiderArgs.fName];
        const result = fn ? fn(...GMSpiderArgs.fArgs) : {};
        if (typeof GmSpiderInject !== 'undefined') {
            GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        }
    });
})();
