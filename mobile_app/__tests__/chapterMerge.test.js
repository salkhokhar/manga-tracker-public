// services/chapterMerge.ts (M2b merge rule) + services/chapterNumber.ts parsing.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeChapterLists, isDescending } = require('../services/chapterMerge');

const ch = (title, link, date) => ({ title, link, date });
const numbers = m => m.map(r => r.number).join(',');
const links = m => m.map(r => r.link).join(',');

describe('isDescending', () => {
    test('empty → descending by default', () => assert.equal(isDescending([]), true));
    test('single → descending', () => assert.equal(isDescending([5]), true));
    test('desc list', () => assert.equal(isDescending([3, 2, null, 1]), true));
    test('asc list', () => assert.equal(isDescending([1, 2, 3]), false));
});

describe('mergeChapterLists — primary only', () => {
    const p = [ch('Chapter 3', 'https://a/3'), ch('Chapter 2', 'https://a/2'), ch('Chapter 1', 'https://a/1')];
    const m = mergeChapterLists(p, 'A', []);
    test('same length', () => assert.equal(m.length, 3));
    test('order preserved', () => assert.equal(links(m), 'https://a/3,https://a/2,https://a/1'));
    test('website_name = primary', () => assert.ok(m.every(r => r.website_name === 'A')));
    test('numbers parsed', () => assert.equal(numbers(m), '3,2,1'));
    test('no alternates', () => assert.ok(m.every(r => r.alternates === undefined)));
});

describe('mergeChapterLists — overlap: primary wins, alternates attached', () => {
    const p = [ch('Chapter 3', 'https://a/3'), ch('Chapter 2', 'https://a/2'), ch('Chapter 1', 'https://a/1')];
    const b = [ch('Ch. 3', 'https://b/3'), ch('Ch. 2', 'https://b/2'), ch('Ch. 1', 'https://b/1')];
    const m = mergeChapterLists(p, 'A', [{ website_name: 'B', chapters: b }]);
    test('no extra rows', () => assert.equal(m.length, 3));
    test('primary links kept', () => assert.ok(m.every(r => r.link.startsWith('https://a/'))));
    test('alternates per row', () => assert.ok(m.every(r => r.alternates && r.alternates.length === 1 && r.alternates[0].website_name === 'B')));
    test('alternate link is B\'s', () => assert.equal(m[0].alternates[0].link, 'https://b/3'));
});

describe('mergeChapterLists — linked source ahead of primary (newest-first)', () => {
    const p = [ch('Chapter 3', 'https://a/3'), ch('Chapter 2', 'https://a/2'), ch('Chapter 1', 'https://a/1')];
    const b = [ch('Chapter 5', 'https://b/5'), ch('Chapter 4', 'https://b/4'), ch('Chapter 3', 'https://b/3')];
    const m = mergeChapterLists(p, 'A', [{ website_name: 'B', chapters: b }]);
    test('5 rows', () => assert.equal(m.length, 5, JSON.stringify(m.map(r => r.title))));
    test('order 5,4,3,2,1', () => assert.equal(numbers(m), '5,4,3,2,1'));
    test('new rows carry B link + badge name', () => assert.ok(m[0].link === 'https://b/5' && m[0].website_name === 'B' && m[1].website_name === 'B'));
    test('row 3 is primary with alternate', () => assert.ok(m[2].link === 'https://a/3' && m[2].alternates[0].link === 'https://b/3'));
});

describe('mergeChapterLists — gap fill in the middle + decimals', () => {
    const p = [ch('Chapter 4', 'https://a/4'), ch('Chapter 2', 'https://a/2'), ch('Chapter 1', 'https://a/1')];
    const b = [ch('Chapter 3.5', 'https://b/3.5'), ch('Chapter 3', 'https://b/3'), ch('Chapter 0', 'https://b/0')];
    const m = mergeChapterLists(p, 'A', [{ website_name: 'B', chapters: b }]);
    test('order 4,3.5,3,2,1,0', () => assert.equal(numbers(m), '4,3.5,3,2,1,0'));
    test('trailing extra appended at end', () => assert.equal(m[5].link, 'https://b/0'));
});

describe('mergeChapterLists — ascending primary order', () => {
    const p = [ch('Chapter 1', 'https://a/1'), ch('Chapter 2', 'https://a/2'), ch('Chapter 3', 'https://a/3')];
    const b = [ch('Chapter 4', 'https://b/4'), ch('Chapter 0', 'https://b/0')];
    const m = mergeChapterLists(p, 'A', [{ website_name: 'B', chapters: b }]);
    test('order 0,1,2,3,4', () => assert.equal(numbers(m), '0,1,2,3,4'));
});

describe('mergeChapterLists — two linked sources: first linked wins, second becomes alternate', () => {
    const p = [ch('Chapter 1', 'https://a/1')];
    const b = [ch('Chapter 2', 'https://b/2')];
    const c = [ch('Chapter 2', 'https://c/2'), ch('Chapter 3', 'https://c/3')];
    const m = mergeChapterLists(p, 'A', [{ website_name: 'B', chapters: b }, { website_name: 'C', chapters: c }]);
    test('order 3,2,1 (default desc, primary has one number)', () => assert.equal(numbers(m), '3,2,1'));
    test('ch2 from B with C alternate', () => assert.ok(m[1].link === 'https://b/2' && m[1].website_name === 'B' && m[1].alternates[0].website_name === 'C'));
    test('ch3 from C', () => assert.ok(m[0].link === 'https://c/3' && m[0].website_name === 'C'));
});

describe('mergeChapterLists — unparseable rows', () => {
    const p = [ch('Chapter 2', 'https://a/2'), ch('Extra: Afterword', 'https://a/after'), ch('Chapter 1', 'https://a/1')];
    const b = [ch('Latest news', 'https://b/news'), ch('Chapter 3', 'https://b/3'), ch('Bonus', 'https://b/bonus')];
    const m = mergeChapterLists(p, 'A', [{ website_name: 'B', chapters: b }]);
    test('primary unnumbered row kept in place', () => assert.ok(m[2].link === 'https://a/after' && m[2].number === null, links(m)));
    test('linked unnumbered rows dropped', () => assert.ok(!m.some(r => r.link === 'https://b/news' || r.link === 'https://b/bonus')));
    test('ch3 inserted at top', () => assert.equal(m[0].link, 'https://b/3'));
    test('4 rows total', () => assert.equal(m.length, 4));
});

describe('mergeChapterLists — duplicates and junk', () => {
    const p = [ch('Chapter 2', 'https://a/2'), ch('Chapter 2', 'https://a/2'), ch('Chapter 2 (fixed)', 'https://a/2-fixed'), null, { title: 'no link' }, ch('Chapter 1', 'https://a/1')];
    const b = [ch('Chapter 2', 'https://a/2'), ch('Chapter 1', 'https://b/1'), 'junk', { link: '' }];
    const m = mergeChapterLists(p, 'A', [{ website_name: 'B', chapters: b }]);
    test('primary dup link collapsed, junk dropped', () => assert.equal(links(m), 'https://a/2,https://a/2-fixed,https://a/1'));
    test('same-link from linked source ignored', () => assert.ok(!(m[0].alternates && m[0].alternates.length)));
    test('B ch1 alternate on primary ch1', () => assert.equal(m[2].alternates[0].link, 'https://b/1'));
    test('second same-number primary row did not take the number', () => assert.equal(m[1].alternates, undefined));
});

describe('mergeChapterLists — cross-site title formats', () => {
    const p = [ch('Chapter 120', 'https://a/120'), ch('Chapter 119', 'https://a/119')];
    const b = [ch('Ch.121 - The End', 'https://b/121'), ch('Episode 120', 'https://b/120'), ch('Vol.3 Chapter 119', 'https://b/119')];
    const m = mergeChapterLists(p, 'A', [{ website_name: 'B', chapters: b }]);
    test('121 inserted, 120/119 merged', () => assert.equal(numbers(m), '121,120,119'));
    test('every merged primary row has a B alternate', () => assert.ok(m[1].alternates.length === 1 && m[2].alternates.length === 1));
});

describe('mergeChapterLists — empty primary', () => {
    const b = [ch('Chapter 2', 'https://b/2'), ch('Chapter 1', 'https://b/1')];
    const m = mergeChapterLists([], 'A', [{ website_name: 'B', chapters: b }]);
    test('linked rows alone, desc', () => assert.equal(links(m), 'https://b/2,https://b/1'));
});

describe('mergeChapterLists — inputs not mutated', () => {
    test('primary + linked untouched', () => {
        const p = [ch('Chapter 1', 'https://a/1')];
        const b = [ch('Chapter 1', 'https://b/1')];
        const snapshot = JSON.stringify([p, b]);
        mergeChapterLists(p, 'A', [{ website_name: 'B', chapters: b }]);
        assert.equal(JSON.stringify([p, b]), snapshot);
    });
});
