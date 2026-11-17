// services/libraryMatch.ts: finding the library entry a new add duplicates.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { findSameSeries, planDuplicateMerges } = require('../services/libraryMatch');

describe('planDuplicateMerges', () => {
    const nameFor = url => (url.includes('asura') ? 'Asura Scans' : url.includes('mangaread') ? 'MangaRead' : 'Other');
    const NOW = '2026-11-13T00:00:00.000Z';
    test('same title from two sites folds into the oldest row', () => {
        const plans = planDuplicateMerges([
            { id: 4, title: 'Return of the Mount Hua Sect', manga_url: 'https://www.mangaread.org/manga/return-of-the-mount-hua-sect/', chapter: 'Chapter 180', last_read_date: '2026-11-01', linked_sources: '[]' },
            { id: 9, title: 'Nano Machine', manga_url: 'https://www.mangaread.org/manga/nano-machine/', chapter: 'Chapter 3', linked_sources: '[]' },
            { id: 31, title: 'Return of the Mount Hua Sect', manga_url: 'https://asurascans.com/comics/return-of-the-mount-hua-sect-f212c582', chapter: 'Chapter 187', last_read_date: '2026-11-11', linked_sources: '[]' },
        ], nameFor, NOW);
        assert.equal(plans.length, 1);
        const p = plans[0];
        assert.equal(p.keepId, 4);
        assert.deepEqual(p.removeIds, [31]);
        assert.deepEqual(p.linkedSources, [{ website_name: 'Asura Scans', manga_url: 'https://asurascans.com/comics/return-of-the-mount-hua-sect-f212c582', added_at: NOW }]);
        assert.equal(p.chapter, 'Chapter 187');
        assert.equal(p.lastReadDate, '2026-11-11');
    });
    test('keeps existing links, carries the links of the duplicate, no repeats', () => {
        const kos = { website_name: 'KingOfShojo', manga_url: 'https://kingofshojo.com/manga/x/', added_at: '2026-01-01T00:00:00Z', updates: 'muted' };
        const plans = planDuplicateMerges([
            { id: 1, title: 'X', manga_url: 'https://www.mangaread.org/manga/x/', chapter: 'Chapter 9', linked_sources: JSON.stringify([kos]) },
            { id: 2, title: 'x', manga_url: 'https://asurascans.com/comics/x-1', chapter: 'Chapter 2', linked_sources: JSON.stringify([kos]) },
        ], nameFor, NOW);
        assert.equal(plans[0].linkedSources.length, 2);
        assert.equal(plans[0].linkedSources[0].updates, 'muted');
        assert.equal(plans[0].chapter, 'Chapter 9');
    });
    test('no duplicates: nothing to do', () => {
        assert.deepEqual(planDuplicateMerges([
            { id: 1, title: 'A', manga_url: 'https://www.mangaread.org/manga/a/' },
            { id: 2, title: 'B', manga_url: 'https://www.mangaread.org/manga/b/' },
        ], nameFor, NOW), []);
    });
});

const library = [
    { title: 'Return of the Flowery Mountain Sect', manga_url: 'https://www.mangaread.org/manga/return-of-the-flowery-mountain-sect/', alternative_names: '', linked_sources: '[]' },
    { title: 'Solo Leveling', manga_url: 'https://www.mangaread.org/manga/solo-leveling/', alternative_names: 'Na Honjaman Level Up', linked_sources: '[{"website_name":"Asura","manga_url":"https://asurascans.com/series/solo-leveling-abc123","added_at":"2026-01-01T00:00:00Z"}]' },
    { title: 'Nano Machine', manga_url: 'https://www.mangaread.org/manga/nano-machine/', alternative_names: null, linked_sources: null },
];

describe('findSameSeries', () => {
    test('same title on another site is the same series', () => {
        const hit = findSameSeries(library, 'Return of the Flowery Mountain Sect', 'https://asurascans.com/series/return-of-the-flowery-mountain-sect-9f1c');
        assert.equal(hit && hit.title, 'Return of the Flowery Mountain Sect');
    });
    test('matches through alternative names and ignores case / punctuation', () => {
        const hit = findSameSeries(library, 'NA HONJAMAN LEVEL-UP', 'https://kingofshojo.com/manga/na-honjaman-level-up/');
        assert.equal(hit && hit.title, 'Solo Leveling');
    });
    test('the entry itself (primary or linked URL) is not a duplicate', () => {
        assert.equal(findSameSeries(library, 'Solo Leveling', 'https://www.mangaread.org/manga/solo-leveling/'), null);
        assert.equal(findSameSeries(library, 'Solo Leveling', 'https://asurascans.com/series/solo-leveling-abc123'), null);
    });
    test('a different series with shared words is not a match', () => {
        assert.equal(findSameSeries(library, 'Solo Leveling Ragnarok', 'https://asurascans.com/series/solo-leveling-ragnarok-77'), null);
        assert.equal(findSameSeries(library, 'Nano Machine Side Story Collection', 'https://x.com/a'), null);
    });
    test('empty inputs', () => {
        assert.equal(findSameSeries([], 'Nano Machine', 'https://x.com/a'), null);
        assert.equal(findSameSeries(library, '', 'https://x.com/a'), null);
    });
});
