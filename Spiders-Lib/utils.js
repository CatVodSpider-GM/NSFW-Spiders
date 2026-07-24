// GMSpider 共用工具方法
// @require 注入后全局可用

const GMSpiderUtils = {
    /**
     * 从文本中提取第一个匹配正则的子串。
     * @param {string} text  原始文本（如 "上市於 2026-07-16"）
     * @param {RegExp} regex 提取正则（如 /\d{4}-\d{2}-\d{2}/）
     * @returns {string} 匹配结果，未匹配返回空字符串
     */
    extract(text, regex) {
        const m = String(text || "").match(regex);
        return m ? m[0] : "";
    },

    extractDate(text) {
        return this.extract(text, /\d{4}[-/]\d{2}[-/]\d{2}/);
    },

    extractCode(text) {
        text = String(text || "").trim();
        // 优先: 标准番号 MIDA-706 / FC2PPV-4940812
        const code = this.extract(text, /\[?([a-z0-9]{2,10}-[a-z0-9]{2,10})\]?/i);
        if (code) {
            const cleaned = code.replace(/[\[\]]/g, "");
            // 排除纯数字日期组合 (如 2026-06、2024-12-25)，标准番号至少一侧含字母
            if (!/^\d{2,4}-\d{2,4}$/.test(cleaned)) {
                return cleaned.toUpperCase();
            }
        }
        // 次选: 带数字的独立字符串 (如 28122458, hookup123)
        const alt = text.match(/\b[a-z0-9]*\d[a-z0-9]*\b/gi);
        return alt ? alt[0].toUpperCase() : text;
    },

    /**
     * 拦截 fetch。
     *
     * hookFetch(root, callback, debug?)
     *   callback(response, url)         — 每次 fetch 都调用
     *
     * hookFetch(root, urls, callback, debug?)
     *   urls: {key: string|function}    — URL 匹配规则
     *   callback(results)               — 全部匹配后调用，results: {key: data}
     *
     * @param {object}          root    window 对象（GM 脚本传 unsafeWindow）
     * @param {object|function} urls    URL 匹配规则（对象为 batch，函数为简单模式）
     * @param {function}        callback 回调
     * @param {boolean}         [debug] 是否打印拦截的请求信息
     */
    hookFetch(root, urls, callback, debug) {
        const origFetch = root.fetch.bind(root);
        const isBatch = typeof urls === 'object';
        if (!isBatch) { debug = callback; callback = urls; urls = null; }

        const result = {};
        let pending = 0;
        if (isBatch) for (var k in urls) pending++;

        root.fetch = function (input, init) {
            return origFetch(input, init).then(function (response) {
                var url = response.url || '';
                if (debug) {
                    response.clone().text().then(function (t) {
                        console.log('[hookFetch]', response.status, url, t);
                    }).catch(function () {});
                }
                if (isBatch && response.ok) {
                    for (var key in urls) {
                        if (!(key in result)) {
                            var match = urls[key];
                            var matched = typeof match === 'function' ? match(url) : url.includes(match);
                            if (matched) {
                                response.clone().json().then(function (data) {
                                    result[key] = data;
                                    pending--;
                                    if (pending <= 0) callback(result);
                                }).catch(function () {});
                                break;
                            }
                        }
                    }
                } else if (!isBatch) {
                    callback(response, url);
                }
                return response;
            });
        };
    },

    /**
     * 等待页面 JS 动态渲染出目标元素后执行回调。
     * 先立即检查一次，若已有元素则直接回调；否则用 MutationObserver 监听，
     * 并设超时兜底，避免页面异常时永久阻塞。
     *
     * @param {string}   selector CSS 选择器，多个用逗号分隔
     * @param {function} callback 元素就绪后的回调
     * @param {number}   timeout  超时时间（毫秒），默认 10000
     */
    waitForElements(selector, callback, timeout) {
        timeout = timeout || 10000;
        if (document.querySelectorAll(selector).length > 0) {
            callback();
            return;
        }
        let called = false;
        console.log('GMSpiderUtils: 等待 "' + selector + '" 出现...');
        const obs = new MutationObserver(function () {
            if (!called && document.querySelectorAll(selector).length > 0) {
                called = true;
                obs.disconnect();
                console.log('GMSpiderUtils: "' + selector + '" 就绪');
                callback();
            }
        });
        obs.observe(document.body, {childList: true, subtree: true});
        setTimeout(function () {
            if (!called) {
                called = true;
                obs.disconnect();
                callback();
            }
        }, timeout);
    },

};
