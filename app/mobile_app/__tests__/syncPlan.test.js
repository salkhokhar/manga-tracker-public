// services/syncPlan.ts: two-way title sync rules (same as desktop library_merge.plan_sync).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { planSync, deletionLimit, parseSnapshot } = require('../services/syncPlan');

const S = (...a) => new Set(a);
const LIB = new Set(Array.from({ length: 50 }, (_, i) => `C${i}`));
const without = (set, ...t) => new Set([...set].filter(x => !t.includes(x)));
const sorted = s => [...s].sort();

describe('planSync', () => {
    test('first sync: no deletions, local-only uploaded', () => {
        const p = planSync(S('A', 'B'), S('B', 'C'), null);
        assert.deepEqual([sorted(p.deleteCloud), sorted(p.deleteLocal), sorted(p.pushNew)], [[], [], ['A']]);
        assert.ok(p.blocked.length);
    });
    test('deleted on the desktop → removed from this phone', () => {
        const p = planSync(LIB, without(LIB, 'C2'), LIB);
        assert.deepEqual(sorted(p.deleteLocal), ['C2']);
        assert.equal(p.deleteCloud.size, 0);
    });
    test('deleted on this phone while offline → removed from the cloud', () => {
        assert.deepEqual(sorted(planSync(without(LIB, 'C1'), LIB, LIB).deleteCloud), ['C1']);
    });
    test('added on the desktop → nothing to delete (restored by the pull)', () => {
        const p = planSync(LIB, new Set([...LIB, 'Desk']), LIB);
        assert.equal(p.deleteCloud.size + p.deleteLocal.size + p.pushNew.size, 0);
    });
    test('added on this phone offline → uploaded, not deleted', () => {
        const p = planSync(new Set([...LIB, 'Mine']), LIB, LIB);
        assert.deepEqual(sorted(p.pushNew), ['Mine']);
        assert.equal(p.deleteLocal.size, 0);
    });
    test('empty cloud with a snapshot: nothing deleted', () => {
        const p = planSync(LIB, S(), LIB);
        assert.equal(p.deleteLocal.size + p.deleteCloud.size, 0);
        assert.ok(p.blocked.length);
    });
    test('empty local library (after sign-out): restore, never delete from cloud', () => {
        const small = S('A', 'B', 'C');
        const p = planSync(S(), small, small);
        assert.equal(p.deleteCloud.size, 0);
        assert.ok(p.blocked.length);
    });
    test('mass deletion blocked', () => {
        const p = planSync(LIB, new Set([...LIB].slice(0, 30)), LIB);
        assert.equal(p.deleteLocal.size, 0);
        assert.ok(p.blocked.length);
    });
    test('deletions within the limit go ahead', () => {
        assert.equal(planSync(LIB, new Set([...LIB].slice(0, 42)), LIB).deleteLocal.size, 8);
    });
    test('deletionLimit matches the desktop', () => {
        assert.equal(deletionLimit(7), 5);
        assert.equal(deletionLimit(280), 56);
    });
});

describe('parseSnapshot', () => {
    test('JSON list', () => assert.deepEqual(sorted(parseSnapshot('["b","a"]')), ['a', 'b']));
    test('missing or broken → null (first sync)', () => {
        for (const v of ['', null, undefined, '{', '{"a":1}']) assert.equal(parseSnapshot(v), null);
    });
});
