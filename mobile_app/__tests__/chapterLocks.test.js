// M2c: services/chapterLocks.ts + chapterCache.ts helpers + syntax of the
// generated injected scripts. Fixtures are asurascans.com pages saved
// 2026-10-23, trimmed (scripts/styles/svg/classes and chapter-less island
// props removed) without changing anything these tests read.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../services/chapterLocks');
const C = require('../services/chapterCache');
const M = require('../services/chapterListManager');

const read = f => fs.readFileSync(path.join(__dirname, 'fixtures', 'asura', f), 'utf8');

describe('isAsuraUrl', () => {
    test('asurascans.com', () => assert.ok(L.isAsuraUrl('https://asurascans.com/comics/x')));
    test('www + asuracomic.net', () => assert.ok(L.isAsuraUrl('https://www.asuracomic.net/series/x')));
    test('lookalike host rejected', () => assert.ok(!L.isAsuraUrl('https://notasurascans.com.evil.io/x')));
    test('mangaread rejected', () => assert.ok(!L.isAsuraUrl('https://www.mangaread.org/manga/x/')));
    test('garbage', () => assert.ok(!L.isAsuraUrl('not a url') && !L.isAsuraUrl(null)));
});

describe('getLockedRowMarkers', () => {
    test('asura default', () => assert.deepEqual(L.getLockedRowMarkers(null, 'https://asurascans.com/comics/x'), ['Early Access', 'Unlocks in']));
    test('other site default empty', () => assert.equal(L.getLockedRowMarkers({}, 'https://toonily.com/serie/x/').length, 0));
    test('config override wins', () => assert.deepEqual(L.getLockedRowMarkers({ selectors: { chapters: { locked_text: ['Coin', '', 5, 'x'.repeat(65)] } } }, 'https://asurascans.com/c'), ['Coin']));
    test('empty override disables', () => assert.equal(L.getLockedRowMarkers({ selectors: { chapters: { locked_text: [] } } }, 'https://asurascans.com/c').length, 0));
    test('override capped at 10', () => assert.equal(L.getLockedRowMarkers({ selectors: { chapters: { locked_text: Array(20).fill('a') } } }, 'https://x.com').length, 10));
});

describe('isLockedRowText', () => {
    test('badge text locks', () => assert.ok(L.isLockedRowText('Chapter 174 EARLY ACCESS Early Access Unlocks in 5h 19m', ['Early Access', 'Unlocks in'])));
    test('free row not locked', () => assert.ok(!L.isLockedRowText('Chapter 173 6 days ago', ['Early Access', 'Unlocks in'])));
    test('no markers never locks', () => assert.ok(!L.isLockedRowText('Early Access', [])));
});

describe('parseAsuraLockedNumbers (synthetic)', () => {
    const obj = (sid, n, prem) => `{"id":[0,1],"series_id":[0,${sid}],"number":[0,${n}],"slug":[0,"chapter-${n}"],"page_count":[0,9],"is_premium":[0,${prem}],"early_access_until":[0,null]}`;
    const txt = [obj(7, 12, true), obj(7, 11, false), obj(7, 10.5, true), obj(9, 3, true), obj(0, 99, true)].join(',');
    test('own-series premium only', () => assert.deepEqual(L.parseAsuraLockedNumbers(txt), [12, 10.5]));
    test('entity-encoded input', () => assert.deepEqual(L.parseAsuraLockedNumbers(txt.replace(/"/g, '&quot;')), [12, 10.5]));
    test('only series_id 0 → all premium', () => assert.deepEqual(L.parseAsuraLockedNumbers(obj(0, 5, true) + obj(0, 4, false)), [5]));
    test('empty / junk', () => assert.ok(L.parseAsuraLockedNumbers('').length === 0 && L.parseAsuraLockedNumbers(null).length === 0));
});

describe('live fixtures (asurascans.com, saved 2026-10-23)', () => {
    {
        const url = 'https://asurascans.com/comics/dungeon-odyssey-11fe7da3';
        const html = read('dungeon-odyssey-11fe7da3.html');
        const locked = L.parseAsuraLockedNumbers(html);
        const got = L.extractLatestUnlockedFromAsuraHtml(html, url);
        // Chapter 174 was Early Access when the page was saved.
        test('extractor returns Chapter 173', () => assert.equal(got, 'Chapter 173'));
        test('extractor never returns a locked number', () => assert.ok(locked.every(n => got !== `Chapter ${n}`), JSON.stringify(locked)));
    }
    {
        const url = 'https://asurascans.com/comics/star-embracing-swordmaster-11fe7da3/';
        const html = read('star-embracing-swordmaster-11fe7da3.html');
        test('free series: no locked numbers', () => assert.deepEqual(L.parseAsuraLockedNumbers(html), []));
        test('free series: newest chapter (143) returned, trailing slash ok', () => assert.equal(L.extractLatestUnlockedFromAsuraHtml(html, url), 'Chapter 143'));
    }
    {
        const html = read('dungeon-odyssey-11fe7da3.html');
        test('wrong series URL → null (caller falls back)', () => assert.equal(L.extractLatestUnlockedFromAsuraHtml(html, 'https://asurascans.com/comics/some-other-series'), null));
        test('bad inputs → null', () => assert.ok(L.extractLatestUnlockedFromAsuraHtml('', 'x') === null && L.extractLatestUnlockedFromAsuraHtml(html, null) === null));
    }
});

describe('Explore astro map logic on live browse page', () => {
    // Same regexes as the injected Explore script (single-backslash form = what runs in the page).
    const raw = read('browse.html').replace(/&quot;/g, '"');
    const re = /"id":\[0,(\d+)\],"slug":[\s\S]*?"latest_chapters":\[1,\[/g;
    const chRe = /"number":\[0,([\d.]+)\][^{}]*?"is_premium":\[0,(true|false)\]/g;
    const oldRe = /"id":\[0,(\d+)\],"slug":[\s\S]*?"latest_chapters":\[1,\[\[0,[\s\S]*?"number":\[0,([\d.]+)\]/g;
    const oldMap = {}, newMap = {}, lockedFirst = {};
    let m;
    while ((m = oldRe.exec(raw)) !== null) oldMap[m[1]] = m[2];
    while ((m = re.exec(raw)) !== null) {
        const segStart = re.lastIndex;
        const segEnd = raw.indexOf('"latest_chapters"', segStart);
        const seg = raw.substring(segStart, segEnd === -1 ? raw.length : segEnd);
        let pick = null, c, first = true;
        chRe.lastIndex = 0;
        while ((c = chRe.exec(seg)) !== null) {
            if (first && c[2] === 'true') lockedFirst[m[1]] = c[1];
            first = false;
            if (c[2] === 'false') { pick = c[1]; break; }
        }
        if (pick) newMap[m[1]] = pick;
    }
    const ids = Object.keys(newMap);
    test('map built for most cards', () => assert.ok(ids.length >= 10, String(ids.length)));
    test('every locked-first card now shows a lower, unlocked number', () => assert.ok(Object.keys(lockedFirst).every(k => newMap[k] && parseFloat(newMap[k]) < parseFloat(lockedFirst[k])), JSON.stringify({ lockedFirst, newMap })));
    test('cards without a locked first entry unchanged', () => assert.ok(ids.filter(k => !lockedFirst[k]).every(k => oldMap[k] === newMap[k])));
});

describe('chapterCache helpers', () => {
    const list = [
        { title: 'Ch 3', link: 'https://a/3', website_name: 'A', alternates: [{ link: 'https://b/3', website_name: 'B', title: '3' }, { link: 'https://c/3', website_name: 'C', title: '3' }] },
        { title: 'Ch 2', link: 'https://a/2', website_name: 'A' },
    ];
    test('findChapterIndex own link', () => assert.equal(C.findChapterIndex(list, 'https://a/2'), 1));
    test('findChapterIndex alternate link', () => assert.equal(C.findChapterIndex(list, 'https://c/3'), 0));
    test('findChapterIndex unknown/bad', () => assert.ok(C.findChapterIndex(list, 'https://z') === -1 && C.findChapterIndex(list, null) === -1));
    test('sourceNameForUrl own/alt/none', () => assert.ok(C.sourceNameForUrl(list[0], 'https://a/3') === 'A' && C.sourceNameForUrl(list[0], 'https://b/3') === 'B' && C.sourceNameForUrl(list[0], 'https://z') === ''));
    test('fallback after primary → B', () => assert.equal(C.nextFallbackSource(list[0], ['https://a/3']).link, 'https://b/3'));
    test('fallback after A,B → C', () => assert.equal(C.nextFallbackSource(list[0], ['https://a/3', 'https://b/3']).website_name, 'C'));
    test('all tried → null', () => assert.equal(C.nextFallbackSource(list[0], ['https://a/3', 'https://b/3', 'https://c/3']), null));
    test('no alternates → null', () => assert.equal(C.nextFallbackSource(list[1], ['https://a/2']), null));
    test('null row → null', () => assert.equal(C.nextFallbackSource(null, []), null));
});

describe('generated injected scripts parse', () => {
    const lockJs = L.buildLockFilterJs(['Early Access', "it's \"quoted\""]);
    const listJs = M.buildChapterListJs({ selectors: { chapters: { item: 'a.group', title: 'span', link: 'self' } } }, ['Early Access']);
    test('buildLockFilterJs is valid JS', () => assert.doesNotThrow(() => new Function(lockJs)));
    test('regex escapes survived (single backslash in page)', () => assert.ok(lockJs.indexOf('/"series_id":\\[0,(\\d+)\\]') !== -1, lockJs.slice(lockJs.indexOf('var re ='), lockJs.indexOf('var re =') + 60)));
    test('buildChapterListJs (with lock filter) is valid JS', () => assert.doesNotThrow(() => new Function(listJs)));
    test('lock filter is wired into the list scraper', () => assert.ok(listJs.indexOf('__isLockedRow(el, rowTitle)') !== -1));
});
