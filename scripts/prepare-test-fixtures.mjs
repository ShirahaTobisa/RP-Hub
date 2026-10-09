import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 浏览器测试用的上游页面：2.0.0 是默认锚点，1.9.5 保留作旧版对照。下载后核对 SHA-256 再解压。
const fixtures = [
    { version: '1.9.5', commit: 'cd7fb2b946f5985991b60597960852671013f36f', sha256: 'f27ee8a1b2806af97b53ea89f7ba4fc2b5e83047eb53110bb9c0f6a459113e80' },
    { version: '2.0.0', commit: 'ed372012fde428499d024ac3623902b754af7721', sha256: 'f0cdd8c459936b863ba063eae7f107c7822fa18c70918fa6c150043fd7e5dc6a' }
];
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'evidence/sync-195/upstream');
const quote = value => "'" + value.replaceAll("'", "''") + "'";

for (const { version, commit, sha256 } of fixtures) {
    const archive = path.join(directory, version + '.zip');
    let bytes;
    try {
        bytes = await fs.readFile(archive);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const response = await fetch('https://codeload.github.com/STA1N156/RP-Hub/zip/' + commit, {
            signal: AbortSignal.timeout(90000)
        });
        if (!response.ok) throw new Error('Upstream fixture download failed: HTTP ' + response.status);
        bytes = Buffer.from(await response.arrayBuffer());
    }
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, `Upstream ${version} fixture checksum mismatch`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(archive, bytes);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath " + quote(archive)
        + ' -DestinationPath ' + quote(path.join(directory, version)) + ' -Force'
    ], { stdio: 'inherit', windowsHide: true });
    console.log(`Upstream ${version} test fixture ready: ${commit}`);
}
