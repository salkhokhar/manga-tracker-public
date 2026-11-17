// services/sourceDiscovery.ts, altNames.ts, titleMatch.ts, probeManager.ts (pure
// parts): search-based source discovery and alternate-name matching.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { isSearchable, buildSearchUrls, getSearchRules, DEFAULT_SEARCH_RULES } = require('../services/sourceDiscovery');
const { parseAltNames, isUsableAltName, mergeAltNames, namesForMatching } = require('../services/altNames');
const { nameSimilarity, bestNameSimilarity, isMostlyNonLatin, SUGGESTION_THRESHOLD } = require('../services/titleMatch');
const { pickSearchMatch } = require('../services/probeManager');

const madara = {
    website_name: 'MangaRead',
    json_rules: {
        search_url: 'https://www.mangaread.org/?s={query}&post_type=wp-manga',
        selectors: {
            search: { item: '.c-tabs-item__content', title: '.post-title h3 a', link: '.post-title h3 a' },
            explore: { item: '.page-item-detail', title: 'h3 a', link: 'h3 a' },
        },
    },
};
const exploreOnly = {
    website_name: 'Toonily',
    json_rules: {
        search_url: 'https://toonily.com/?s={query}&post_type=wp-manga',
        selectors: { explore: { item: '.page-item-detail', title: '.post-title h3 a', link: '.post-title h3 a' } },
    },
};
const noSearch = { website_name: 'Gourmet', json_rules: { explore_categories: [{ urls: { all: 'https://gourmetsupremacy.com/project/' } }] } };

describe('isSearchable / buildSearchUrls', () => {
    test('needs a search_url with {query}', () => {
        assert.equal(isSearchable(madara), true);
        assert.equal(isSearchable(noSearch), false);
        assert.equal(isSearchable({ json_rules: { search_url: 'https://x.com/search' } }), false);
    });
    test('title first, then alternates, capped at three, URL-encoded', () => {
        const urls = buildSearchUrls(madara, ["Omniscient Reader's Viewpoint", '전지적 독자 시점', 'ORV', 'Fourth name']);
        assert.deepEqual(urls, [
            "https://www.mangaread.org/?s=Omniscient%20Reader's%20Viewpoint&post_type=wp-manga",
            'https://www.mangaread.org/?s=%EC%A0%84%EC%A7%80%EC%A0%81%20%EB%8F%85%EC%9E%90%20%EC%8B%9C%EC%A0%90&post_type=wp-manga',
            'https://www.mangaread.org/?s=ORV&post_type=wp-manga',
        ]);
    });
    test('skips blank names and repeats', () => {
        assert.deepEqual(buildSearchUrls(madara, ['', '  ', 'Solo Leveling', 'Solo Leveling']),
            ['https://www.mangaread.org/?s=Solo%20Leveling&post_type=wp-manga']);
    });
    test('not searchable → no URLs', () => assert.deepEqual(buildSearchUrls(noSearch, ['Anything']), []));
});

describe('getSearchRules', () => {
    test('prefers selectors.search', () => assert.deepEqual(getSearchRules(madara), madara.json_rules.selectors.search));
    test('falls back to selectors.explore', () => assert.deepEqual(getSearchRules(exploreOnly), exploreOnly.json_rules.selectors.explore));
    test('then to the defaults', () => assert.deepEqual(getSearchRules(noSearch), DEFAULT_SEARCH_RULES));
    test('fills missing title/link from the defaults', () => {
        assert.deepEqual(getSearchRules({ json_rules: { selectors: { search: { item: '.card' } } } }),
            { item: '.card', title: DEFAULT_SEARCH_RULES.title, link: DEFAULT_SEARCH_RULES.link });
    });
});

describe('parseAltNames', () => {
    test('splits on ; | / , and newlines, trims, de-dupes', () => {
        assert.deepEqual(parseAltNames('진화하는 우주 괴물이 되었다 ; I Became an Evolving Space Monster / Space Monster, space monster\nEvolving Monster'),
            ['진화하는 우주 괴물이 되었다', 'I Became an Evolving Space Monster', 'Space Monster', 'Evolving Monster']);
    });
    test('empty / non-string → []', () => {
        assert.deepEqual(parseAltNames(''), []);
        assert.deepEqual(parseAltNames(null), []);
        assert.deepEqual(parseAltNames(['a']), []);
    });
});

describe('isUsableAltName', () => {
    test('two content words or eight characters', () => {
        assert.equal(isUsableAltName('Evolving Space Monster'), true);
        assert.equal(isUsableAltName('Reincarnation'), true); // long enough on its own
        assert.equal(isUsableAltName('The Hero'), false);     // one content word, short
        assert.equal(isUsableAltName('ORV'), false);
    });
    test('non-Latin names need two characters', () => {
        assert.equal(isUsableAltName('전지적 독자 시점'), true);
        assert.equal(isUsableAltName('괴'), false);
    });
});

describe('mergeAltNames', () => {
    test('adds new names, drops repeats and the primary title', () => {
        assert.equal(mergeAltNames('A Name; Second', ['second', 'Primary Title', 'Third'], 'Primary Title'), 'A Name; Second; Third');
    });
    test('caps at ten', () => {
        const many = Array.from({ length: 14 }, (_, i) => `Name ${i}`);
        assert.equal(mergeAltNames('', many, 'X').split('; ').length, 10);
    });
    test('nothing to add returns the existing text unchanged', () => assert.equal(mergeAltNames('One; Two', [], 'X'), 'One; Two'));
});

describe('namesForMatching', () => {
    test('title first, usable alternates after', () => {
        assert.deepEqual(namesForMatching('Solo Leveling', 'Na Honjaman Level Up; SL; 나 혼자만 레벨업'),
            ['Solo Leveling', 'Na Honjaman Level Up', '나 혼자만 레벨업']);
    });
});

describe('nameSimilarity', () => {
    test('Latin titles use the token score', () => {
        assert.equal(nameSimilarity('Regressor of the Fallen Family', 'Regressor of the Fallen Family | Asura Scans'), 1);
        assert.ok(nameSimilarity('Solo Leveling', 'Solo Leveling Ragnarok') < SUGGESTION_THRESHOLD);
    });
    test('non-Latin titles must match exactly after stripping', () => {
        assert.equal(isMostlyNonLatin('나 혼자만 레벨업'), true);
        assert.equal(nameSimilarity('나 혼자만 레벨업', '나혼자만 레벨업!'), 1);
        assert.equal(nameSimilarity('나 혼자만 레벨업', '나 혼자만 레벨업 라그나로크'), 0);
        assert.equal(nameSimilarity('나 혼자만 레벨업', 'Solo Leveling'), 0);
    });
    test('bestNameSimilarity takes the best pair', () => {
        assert.equal(bestNameSimilarity(['Solo Leveling', '나 혼자만 레벨업'], ['Something Else', '나 혼자만 레벨업']), 1);
        assert.equal(bestNameSimilarity([], ['x']), 0);
    });
});

describe('pickSearchMatch', () => {
    const names = ['I Became an Evolving Space Monster', '진화하는 우주 괴물이 되었다'];
    test('best clearing card on the right host wins', () => {
        const pick = pickSearchMatch([
            { title: 'Space Monster Chronicles', link: 'https://kingofshojo.com/manga/space-monster-chronicles/' },
            { title: 'I Became An Evolving Space Monster', link: 'https://kingofshojo.com/manga/i-became-an-evolving-space-monster/' },
        ], names, 'kingofshojo.com');
        assert.equal(pick.link, 'https://kingofshojo.com/manga/i-became-an-evolving-space-monster/');
        assert.equal(pick.score, 1);
    });
    test('matches on an alternate name', () => {
        const pick = pickSearchMatch([{ title: '진화하는 우주 괴물이 되었다', link: 'https://kingofshojo.com/manga/x/' }], names, 'kingofshojo.com');
        assert.equal(pick && pick.title, '진화하는 우주 괴물이 되었다');
    });
    test('ignores other hosts, unsafe links and weak titles', () => {
        assert.equal(pickSearchMatch([{ title: names[0], link: 'https://evil.example/manga/x/' }], names, 'kingofshojo.com'), null);
        assert.equal(pickSearchMatch([{ title: names[0], link: 'javascript:alert(1)' }], names, null), null);
        assert.equal(pickSearchMatch([{ title: 'Space Monster', link: 'https://kingofshojo.com/manga/x/' }], names, 'kingofshojo.com'), null);
    });
    test('no results → null', () => assert.equal(pickSearchMatch([], names, 'kingofshojo.com'), null));
});
