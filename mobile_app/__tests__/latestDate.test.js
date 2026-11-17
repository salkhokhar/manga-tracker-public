// services/latestDate.ts: Library date sorting ("Latest update", "Recently read").
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLatestDate, formatLatestDate, sortByDateField, extractMadaraChapterDates, hasTime, isoMinute } = require('../services/latestDate');

const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime(); // 24 Oct 2026, 12:00 local
// Dates without a time are local midnight, so they format back to the same day.
const day = (y, m, d) => new Date(y, m - 1, d).getTime();

describe('parseLatestDate — absolute formats', () => {
    test('desktop "16 Apr 2026"', () => assert.equal(parseLatestDate('16 Apr 2026', NOW), day(2026, 4, 16)));
    test('single-digit day "8 Sep 2021"', () => assert.equal(parseLatestDate('8 Sep 2021', NOW), day(2021, 9, 8)));
    test('full month "16 April 2026"', () => assert.equal(parseLatestDate('16 April 2026', NOW), day(2026, 4, 16)));
    test('US "April 16, 2026"', () => assert.equal(parseLatestDate('April 16, 2026', NOW), day(2026, 4, 16)));
    test('US short "Apr 16th 2026"', () => assert.equal(parseLatestDate('Apr 16th 2026', NOW), day(2026, 4, 16)));
    test('Madara "16.04.2026" is day-first', () => assert.equal(parseLatestDate('16.04.2026', NOW), day(2026, 4, 16)));
    test('ISO "2026-04-16"', () => assert.equal(parseLatestDate('2026-04-16', NOW), day(2026, 4, 16)));
    test('desktop last_read "2023-03-02 00:00:00"', () => assert.equal(parseLatestDate('2023-03-02 00:00:00', NOW), day(2023, 3, 2)));
    test('extra spaces tolerated', () => assert.equal(parseLatestDate('  16  Apr 2026 ', NOW), day(2026, 4, 16)));
});

describe('parseLatestDate — relative formats', () => {
    test('"11 hours ago"', () => assert.equal(parseLatestDate('11 hours ago', NOW), NOW - 11 * 3600e3));
    test('"1 day ago"', () => assert.equal(parseLatestDate('1 day ago', NOW), NOW - 86400e3));
    test('"2 days ago"', () => assert.equal(parseLatestDate('2 days ago', NOW), NOW - 2 * 86400e3));
    test('"a week ago"', () => assert.equal(parseLatestDate('a week ago', NOW), NOW - 7 * 86400e3));
    test('"3 mins ago"', () => assert.equal(parseLatestDate('3 mins ago', NOW), NOW - 3 * 60e3));
    test('"yesterday"', () => assert.equal(parseLatestDate('Yesterday', NOW), NOW - 86400e3));
    test('"just now"', () => assert.equal(parseLatestDate('just now', NOW), NOW));
});

describe('parseLatestDate — unreadable', () => {
    for (const v of ['', '   ', null, undefined, 42, 'Unknown', 'NEW', '31 Foo 2026', '45.13.2026', '1 decade ago']) {
        test(JSON.stringify(v ?? null), () => assert.equal(parseLatestDate(v, NOW), null));
    }
});

describe('formatLatestDate', () => {
    test('desktop format, zero-padded day', () => assert.equal(formatLatestDate(new Date(2026, 3, 6)), '06 Apr 2026'));
    test('round-trips through the parser', () => {
        const s = formatLatestDate(new Date(2026, 9, 24));
        assert.equal(parseLatestDate(s, NOW), day(2026, 10, 24));
    });
});

describe('extractMadaraChapterDates (rows as served by mangaread.org, 2026-10-24)', () => {
    const S = 'https://www.mangaread.org/manga/becoming-the-swordmaster-rank-young-lord-of-the-sichuan-tang-family/';
    const row = (n, date) => `<li class="wp-manga-chapter    ">
        <a href="${S}chapter-${n}/"> Chapter ${n} </a>
        <span class="chapter-release-date"> <i>${date}</i> </span> </li>`;
    const newRow = (n, rel) => `<li class="wp-manga-chapter  new-chap  ">
        <a href="${S}chapter-${n}/"> Chapter ${n} </a>
        <span class="chapter-release-date"> <a href="${S}chapter-${n}/" title="${rel}" class="c-new-tag"><img src="x.png"></a> </span> </li>`;

    test('dated rows stored as the day: Swordmaster ch.121 → "31 Jul 2026"', () => {
        const d = extractMadaraChapterDates(row(121, '31.07.2026') + row(120, '24.05.2026'), NOW);
        assert.equal(d.get(121), '31 Jul 2026');
        assert.equal(d.get(120), '24 May 2026');
    });
    test('relative "2 days ago" stored as a timestamp from fetch time', () => {
        assert.equal(extractMadaraChapterDates(row(279, '2 days ago'), NOW).get(279), isoMinute(NOW - 2 * 86400e3));
    });
    test('new-chapter tag with the date in a title attribute', () => {
        assert.equal(extractMadaraChapterDates(newRow(40, '5 hours ago'), NOW).get(40), isoMinute(NOW - 5 * 3600e3));
    });
    test('no date span → no entry', () => {
        assert.equal(extractMadaraChapterDates(`<li class="wp-manga-chapter"><a href="${S}chapter-5/">Chapter 5</a></li> chapter-release-date`, NOW).size, 0);
    });
    test('non-Madara page → empty', () => assert.equal(extractMadaraChapterDates('<html><a>Chapter 3</a></html>', NOW).size, 0));
});

describe('timestamps (same-day releases keep their order)', () => {
    test('isoMinute is UTC to the minute', () => assert.equal(isoMinute(Date.UTC(2026, 9, 26, 13, 5, 42)), '2026-10-26T13:05Z'));
    test('parsed back exactly', () => assert.equal(parseLatestDate('2026-10-26T13:05Z', NOW), Date.UTC(2026, 9, 26, 13, 5)));
    test('hasTime', () => {
        assert.equal(hasTime('2026-10-26T13:05Z'), true);
        assert.equal(hasTime('26 Oct 2026'), false);
        assert.equal(hasTime(null), false);
    });
    test('the reported case: 10 mins ago above 6 hours ago, same day', () => {
        const now = Date.UTC(2026, 9, 26, 20, 0);
        const order = sortByDateField([
            { title: 'A six hours', latest_date: isoMinute(now - 6 * 3600e3) },
            { title: 'B older day', latest_date: '25 Oct 2026' },
            { title: 'Z ten minutes', latest_date: isoMinute(now - 10 * 60e3) },
        ], 'latest_date', now).map(r => r.title);
        assert.deepEqual(order, ['Z ten minutes', 'A six hours', 'B older day']);
    });
});

describe('sortByDateField', () => {
    const rows = [
        { title: 'Old 2021', latest_date: '18 Sep 2021' },
        { title: 'Apr 2026', latest_date: '16 Apr 2026' },
        { title: 'No date', latest_date: '' },
        { title: 'Madara Mar 2026', latest_date: '26.03.2026' },
        { title: 'Hours ago', latest_date: '11 hours ago' },
        { title: 'Dec 2024', latest_date: '31 Dec 2024' },
        { title: 'B same day', latest_date: '16 Apr 2026' },
    ];
    const order = sortByDateField(rows, 'latest_date', NOW).map(r => r.title);
    test('newest first, the text-sort bug cases in the right order', () => assert.deepEqual(order, [
        'Hours ago', 'Apr 2026', 'B same day', 'Madara Mar 2026', 'Dec 2024', 'Old 2021', 'No date',
    ]));
    test('does not mutate the input', () => assert.equal(rows[0].title, 'Old 2021'));
    test('last_read_date: "18.04.2026" above "2023-03-02 00:00:00"', () => {
        const r = sortByDateField([
            { title: 'iso 2023', last_read_date: '2023-03-02 00:00:00' },
            { title: 'dotted 2026', last_read_date: '18.04.2026' },
            { title: 'app 2026-10-20', last_read_date: '2026-10-20' },
        ], 'last_read_date', NOW).map(x => x.title);
        assert.deepEqual(r, ['app 2026-10-20', 'dotted 2026', 'iso 2023']);
    });
});
