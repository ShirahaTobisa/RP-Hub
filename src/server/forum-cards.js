// ---- 万相广场（官方卡片站）没开跨域，页面查不到它的卡片，由本站代查：按卡名搜公开的卡，只回同名卡的编号和时间 ----
const FORUM_BASE = 'https://rphforum.zeabur.app';
const FORUM_ZONES = ['reviewed', 'unreviewed'];
const FORUM_MAX_CARDS = 5;

// 广场的时间有两种写法：ISO（带 Z）和 SQLite 默认的「2026-11-20 08:00:00」（UTC，不带时区）。
function parseForumTime(value) {
    const text = String(value || '');
    return Date.parse(/z$|[+-]\d\d:?\d\d$/i.test(text) ? text : text.replace(' ', 'T') + 'Z') || 0;
}

async function searchForumCards(name, zone) {
    const params = new URLSearchParams({ q: name, zone, limit: '10' });
    const response = await fetch(`${FORUM_BASE}/api/cards?${params}`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) throw new Error('万相广场暂时不可用');
    const cards = await response.json();
    return Array.isArray(cards) ? cards.filter((card) => String(card?.name || '').trim() === name) : [];
}

// same：广场上这张卡的简介和作者备注和本机的一样，同名卡不止一张时靠它认出是哪张。
async function handleForumCards(body) {
    const cards = Array.isArray(body.cards) ? body.cards.slice(0, FORUM_MAX_CARDS) : [];
    const results = await Promise.all(cards.map(async (card) => {
        const name = String(card?.name || '').trim();
        if (!name) return [];
        try {
            const found = (await Promise.all(FORUM_ZONES.map((zone) => searchForumCards(name, zone)))).flat();
            return found.map((item) => ({
                id: String(item.id), createdAt: parseForumTime(item.created_at), updatedAt: parseForumTime(item.updated_at),
                same: item.description === card.description && item.creator_notes === card.creatorNotes
            }));
        } catch (_) {
            return null;
        }
    }));
    return json({ ok: true, results });
}
