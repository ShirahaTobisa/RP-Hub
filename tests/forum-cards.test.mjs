import assert from 'node:assert/strict';
import worker from '../_worker.js';

// 万相广场代查（action forum-cards）：按卡名搜广场两个分区的公开卡，只回名字完全一样的卡；
// 广场的两种时间写法都认；同名卡靠简介和作者备注认；某张卡查失败只影响它自己；要同步密码。
const forum = {
    reviewed: [
        { id: 'a1', name: '夕', description: '画家', creator_notes: '#R18', created_at: '2026-10-01 08:00:00', updated_at: '2026-11-20T10:00:00.000Z' },
        { id: 'a2', name: '夕的日常', description: '', creator_notes: '', created_at: '2026-10-02 08:00:00', updated_at: '2026-10-02 08:00:00' }
    ],
    unreviewed: [
        { id: 'b1', name: '夕', description: '别人的夕', creator_notes: '', created_at: '2026-10-05T00:00:00.000Z', updated_at: '2026-10-05T00:00:00.000Z' }
    ]
};
const requests = [];
globalThis.fetch = async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.searchParams.get('q') === '坏') return new Response('busy', { status: 502 });
    return Response.json(forum[url.searchParams.get('zone')].filter((card) => card.name.includes(url.searchParams.get('q'))));
};
const bucket = { get: async () => null, put: async () => null, delete: async () => {}, list: async () => ({ objects: [] }), head: async () => null };
const call = (body, env = { RP_SYNC_R2: bucket }, headers = {}) => worker.fetch(new Request('https://rph.example/api/rp-sync', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
}), env, { waitUntil() {} });

const response = await call({ action: 'forum-cards', cards: [
    { name: ' 夕 ', description: '画家', creatorNotes: '#R18' }, { name: '坏' }, { name: '' },
    { name: '一' }, { name: '二' }, { name: '三' }
] });
assert.equal(response.status, 200);
const { ok, results } = await response.json();
assert.equal(ok, true);
assert.equal(results.length, 5, 'one request handles at most five cards');
assert.deepEqual(results[0], [
    { id: 'a1', createdAt: Date.UTC(2026, 9, 1, 8), updatedAt: Date.UTC(2026, 10, 20, 10), same: true },
    { id: 'b1', createdAt: Date.UTC(2026, 9, 5), updatedAt: Date.UTC(2026, 9, 5), same: false }
]);
assert.equal(results[1], null, 'a card whose search failed comes back as null');
assert.deepEqual(results[2], [], 'an empty name is not searched');
const searched = requests.filter((url) => url.searchParams.get('q') === '夕');
assert.deepEqual(searched.map((url) => url.origin + url.pathname), ['https://rphforum.zeabur.app/api/cards', 'https://rphforum.zeabur.app/api/cards']);
assert.deepEqual(searched.map((url) => url.searchParams.get('zone')).sort(), ['reviewed', 'unreviewed']);
assert.ok(searched.every((url) => url.searchParams.get('limit') === '10'));
assert.ok(!requests.some((url) => url.searchParams.get('q') === '三'), 'cards past the first five are not searched');
console.log('PASS forum-cards searches both zones by exact name, parses both time formats and isolates failures');

const before = requests.length;
const denied = await call({ action: 'forum-cards', cards: [{ name: '夕' }] }, { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: 'secret' });
assert.equal(denied.status, 401);
assert.equal(requests.length, before, 'without the sync password the plaza is not queried');
const allowed = await call({ action: 'forum-cards', cards: [{ name: '夕' }] }, { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: 'secret' }, { 'x-rp-sync-password': 'secret' });
assert.equal(allowed.status, 200);
console.log('PASS forum-cards needs the sync password like the other actions');
