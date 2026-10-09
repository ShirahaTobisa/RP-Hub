import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 浏览器测试用的上游页面，放在 evidence/sync-195/upstream/：
// - latest/：分发端已收录（补丁预检通过）的最新正式版本，自动跟随，不用手工更新；按清单逐个核对 SHA-256。
// - 1.9.5/：固定的旧版对照，从上游下载 ZIP 核对 SHA-256。
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'evidence/sync-195/upstream');
const mirror = (process.env.RPH_MIRROR_BASE || 'https://update.rph.mornye.uk').replace(/\/+$/, '');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";

async function download(url, timeout = 90000) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${url}`);
    return Buffer.from(await response.arrayBuffer());
}

async function prepareLatest() {
    const target = path.join(directory, 'latest');
    const markerPath = path.join(target, '.fixture.json');
    const cached = await fs.readFile(markerPath, 'utf8').then(JSON.parse, () => null);
    let version;
    try {
        const manifest = JSON.parse(await download(`${mirror}/manifest.json`, 30000));
        version = manifest.versions.find((item) => /^\d+(?:\.\d+)+$/.test(item.tag));
        if (!version) throw new Error('分发端清单里没有正式版本');
    } catch (error) {
        if (!cached) throw error;
        console.warn(`分发端暂时不可用，沿用上次的上游 ${cached.tag}：${error.message}`);
        return cached;
    }
    if (cached?.commit === version.commit) return cached;
    const staging = `${target}.staging`;
    await fs.rm(staging, { recursive: true, force: true });
    for (const file of version.files) {
        const bytes = await download(`${mirror}/snapshots/${encodeURIComponent(version.tag)}/${version.commit}/${file.path.split('/').map(encodeURIComponent).join('/')}`);
        assert.equal(sha256(bytes), file.sha256, `上游 ${version.tag} 文件校验失败：${file.path}`);
        await fs.mkdir(path.dirname(path.join(staging, file.path)), { recursive: true });
        await fs.writeFile(path.join(staging, file.path), bytes);
    }
    const marker = { tag: version.tag, commit: version.commit };
    await fs.writeFile(path.join(staging, '.fixture.json'), JSON.stringify(marker));
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
    return marker;
}

async function preparePinned(version, commit, expected) {
    const archive = path.join(directory, version + '.zip');
    const bytes = await fs.readFile(archive).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return download('https://codeload.github.com/STA1N156/RP-Hub/zip/' + commit);
    });
    assert.equal(sha256(bytes), expected, `Upstream ${version} fixture checksum mismatch`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(archive, bytes);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath " + quote(archive)
        + ' -DestinationPath ' + quote(path.join(directory, version)) + ' -Force'
    ], { stdio: 'inherit', windowsHide: true });
}

await fs.mkdir(directory, { recursive: true });
const latest = await prepareLatest();
console.log(`Upstream latest test fixture ready: ${latest.tag} ${latest.commit}`);
await preparePinned('1.9.5', 'cd7fb2b946f5985991b60597960852671013f36f', 'f27ee8a1b2806af97b53ea89f7ba4fc2b5e83047eb53110bb9c0f6a459113e80');
console.log('Upstream 1.9.5 test fixture ready: cd7fb2b946f5985991b60597960852671013f36f');
