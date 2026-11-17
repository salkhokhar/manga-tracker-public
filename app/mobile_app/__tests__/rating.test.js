// services/rating.ts: the reader's rating vs the site's rating, per-site scales,
// and the one-time migration of the old shared column.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
    ratingScaleFor, parseRatingNumber, normalizeSiteRating, formatUserRating,
    isUserRating, migrateLegacyRating, splitCloudRating,
} = require('../services/rating');

describe('ratingScaleFor', () => {
    test('10 only when the config says so', () => {
        assert.equal(ratingScaleFor({ rating_scale: 10 }), 10);
        assert.equal(ratingScaleFor({ rating_scale: '10' }), 10);
        assert.equal(ratingScaleFor({ rating_scale: 5 }), 5);
        assert.equal(ratingScaleFor({}), 5);
        assert.equal(ratingScaleFor(null), 5);
        assert.equal(ratingScaleFor({ rating_scale: 100 }), 5);
    });
});

describe('parseRatingNumber', () => {
    test('first number in the text', () => {
        assert.equal(parseRatingNumber('4.5 out of 5 from 75 votes'), 4.5);
        assert.equal(parseRatingNumber(' 9.7 '), 9.7);
        assert.equal(parseRatingNumber('Rating 8'), 8);
        assert.equal(parseRatingNumber('N/A'), null);
        assert.equal(parseRatingNumber(''), null);
        assert.equal(parseRatingNumber(undefined), null);
    });
});

describe('normalizeSiteRating', () => {
    test('10-scale sites are halved, 5-scale kept, one decimal', () => {
        assert.equal(normalizeSiteRating('9.7', 10), '4.9');     // Asura
        assert.equal(normalizeSiteRating('8.9', 10), '4.5');     // KingOfShojo
        assert.equal(normalizeSiteRating('9.86', 10), '4.9');    // Webtoons
        assert.equal(normalizeSiteRating('4.5 out of 5 from 75 votes', 5), '4.5'); // ManhuaTop title attr
        assert.equal(normalizeSiteRating('4.00', 5), '4');
        assert.equal(normalizeSiteRating('3', 10), '1.5');
    });
    test('no number, zero, or above the scale', () => {
        assert.equal(normalizeSiteRating('', 5), '');
        assert.equal(normalizeSiteRating('N/A', 5), '');
        assert.equal(normalizeSiteRating('0', 5), '');
        assert.equal(normalizeSiteRating('7', 5), '5');
        assert.equal(normalizeSiteRating(null, 5), '');
    });
});

describe('formatUserRating / isUserRating', () => {
    test('any value in (0, 5] with one decimal', () => {
        assert.equal(formatUserRating('4.8'), '4.8');
        assert.equal(formatUserRating(' 1.1 '), '1.1');
        assert.equal(formatUserRating('3'), '3');
        assert.equal(formatUserRating('5'), '5');
        assert.equal(formatUserRating('4,75'), '4.8');
        assert.equal(formatUserRating('0.5'), '0.5');
    });
    test('rejects empty, zero, text, above 5', () => {
        assert.equal(formatUserRating(''), null);
        assert.equal(formatUserRating('0'), null);
        assert.equal(formatUserRating('5.1'), null);
        assert.equal(formatUserRating('8'), null);
        assert.equal(formatUserRating('abc'), null);
        assert.equal(formatUserRating('4 stars'), null);
        assert.equal(formatUserRating(undefined), null);
    });
    test('isUserRating mirrors it on stored values', () => {
        assert.equal(isUserRating('4.5'), true);
        assert.equal(isUserRating('5'), true);
        assert.equal(isUserRating('8.9'), false);
        assert.equal(isUserRating(''), false);
        assert.equal(isUserRating('N/A'), false);
    });
});

describe('migrateLegacyRating', () => {
    test('a value the site could show is its average: moved to site_rating', () => {
        assert.deepEqual(migrateLegacyRating('8.9', 10), { rating: '', siteRating: '4.5' });
        assert.deepEqual(migrateLegacyRating('4.5', 5), { rating: '', siteRating: '4.5' });
        assert.deepEqual(migrateLegacyRating('4', 5), { rating: '', siteRating: '4' });      // exact MangaRead average
        assert.deepEqual(migrateLegacyRating('4.00', 5), { rating: '', siteRating: '4' });
        assert.deepEqual(migrateLegacyRating(' 9.7 ', 10), { rating: '', siteRating: '4.9' });
        assert.deepEqual(migrateLegacyRating('7', 10), { rating: '', siteRating: '3.5' });
    });
    test('above the site scale it can only be an old 10-scale pick: halved', () => {
        assert.deepEqual(migrateLegacyRating('8', 5), { rating: '4', siteRating: null });
        assert.deepEqual(migrateLegacyRating('7', 5), { rating: '3.5', siteRating: null });
        assert.deepEqual(migrateLegacyRating('10', 5), { rating: '5', siteRating: null });
        assert.deepEqual(migrateLegacyRating('11', 10), { rating: '', siteRating: null });
    });
    test('empty and text leave both alone / clear', () => {
        assert.deepEqual(migrateLegacyRating('', 5), { rating: '', siteRating: null });
        assert.deepEqual(migrateLegacyRating(null, 5), { rating: '', siteRating: null });
        assert.deepEqual(migrateLegacyRating('N/A', 5), { rating: '', siteRating: null });
        assert.deepEqual(migrateLegacyRating('0', 5), { rating: '', siteRating: '' });
    });
});

describe('splitCloudRating', () => {
    test('a possible reader rating is kept as it is', () => {
        assert.deepEqual(splitCloudRating('4.8', 10), { rating: '4.8', siteRating: null });
        assert.deepEqual(splitCloudRating('3', 10), { rating: '3', siteRating: null });
        assert.deepEqual(splitCloudRating('4.5', 5), { rating: '4.5', siteRating: null });
    });
    test('a value the rating box cannot produce is a desktop site average', () => {
        assert.deepEqual(splitCloudRating('8.9', 10), { rating: '', siteRating: '4.5' });
        assert.deepEqual(splitCloudRating('9.7', 10), { rating: '', siteRating: '4.9' });
        assert.deepEqual(splitCloudRating('7', 5), { rating: '', siteRating: '5' });
        assert.deepEqual(splitCloudRating('N/A', 5), { rating: '', siteRating: null });
        assert.deepEqual(splitCloudRating('', 5), { rating: '', siteRating: null });
    });
});
