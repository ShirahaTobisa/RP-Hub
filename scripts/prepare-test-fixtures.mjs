import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const commit = 'cd7fb2b946f5985991b60597960852671013f36f';
const expected = 'f27ee8a1b2806af97b53ea89f7ba4fc2b5e83047eb53110bb9c0f6a459113e80';
const directory = path.join(root, 'evidence/sync-195/upstream');
const archive = path.join(directory, '1.9.5.zip');
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
assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'Upstream fixture checksum mismatch');
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(archive, bytes);
const quote = value => "'" + value.replaceAll("'", "''") + "'";
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath " + quote(archive)
    + ' -DestinationPath ' + quote(path.join(directory, '1.9.5')) + ' -Force'
], { stdio: 'inherit', windowsHide: true });
console.log('Upstream 1.9.5 test fixture ready: ' + commit);
