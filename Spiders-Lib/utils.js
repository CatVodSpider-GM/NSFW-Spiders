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
        if (code) return code.replace(/[\[\]]/g, "").toUpperCase();
        // 次选: 带数字的独立字符串 (如 28122458, hookup123)
        const alt = text.match(/\b[a-z0-9]*\d[a-z0-9]*\b/gi);
        return alt ? alt[0].toUpperCase() : text;
    },

};
