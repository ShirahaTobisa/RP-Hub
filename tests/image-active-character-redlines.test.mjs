import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');

function fileSha256(relativePath) {
    return createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT_DIR, relativePath)))
        .digest('hex')
        .toUpperCase();
}

const expectedSourceHashes = new Map([
    ['DB/image-module.js', 'EEC947FA77F4D50A28F1F6E23D15A1ECB0995C4F67D2D3C1659A2254C001AA47'],
    ['DB/bootstrap.js', '2BEA8C374E3B56F1CD3F883B23C0E03991C983F0353F404CC7192403515AE602'],
    ['DB/char-store.js', 'A02451B65EA470AAA936A772EA75900C323618CFA579953350996771D744D7FE'],
    ['DB/styles.css', 'BB608C2DB52681DC8279139A0DBCFAD30DED5E5B15214A58363E6F26FF540A15'],
    ['DB/app-patches.mjs', '55629DF1E0888F027863F2A618A72300BB03DDBF938F2119EAF520421C57AC53'],
    ['_worker.js', '351A50453018389B27477291C71FC0942F8E745AF93DFA2983A33C90E8B53445'],
    ['index.html', 'C9BF4FBE157A6808FFBE9BFCDD9F60BDD499881AE638CC369A2F5F99053AD770'],
    ['work.js', 'DAFEC08B9A370461E68A3412D9FD1D883113DA89CBD02B43052C99C67A207451'],
    ['wrangler.toml', 'C2FFFD4267C5234E72FF05B3388312F7230D525335E6AFB51F8065259805FCE0'],
    ['LICENSE', '978A8C832BB0DC3AEF756768089A11B41CCAA7472D80491D74BBFFB23AAE94B1']
]);

const expectedUpstreamHashes = new Map([
    ['assets/css/styles.css', 'CB4E276D0E6C6F66C311F501E7C3D8B391DEF05FEE7CB86DECE0F64E13B27713'],
    ['assets/js/app.js', '1531FD9E563517F642B57AB5CC9C821796753F813EF244370402CE772AA47B0C'],
    ['assets/js/card-utils.js', '401730146A43EEF77B24BBF2A3DAA43403DDB4FC817329253801C2E14F8C9062'],
    ['assets/js/ui-select.js', '7EF8EF39F4526BC8FB3AF9951BBB3E56C815D5A3A01418488F80591F009C7615'],
    ['assets/js/utils.js', 'D1DC4DCEBAEDC78FBD239856C5586DDC584B3DEE82D581D05BBB960963E4DD88'],
    ['character/index.html', '577942BF1474299D44992B77AAEEE42C7DF13CF1DE7B71A4443591549E99D708']
]);

for (const [relativePath, expectedHash] of expectedSourceHashes) {
    assert.equal(fileSha256(relativePath), expectedHash, `${relativePath} changed from the active-character delivery tree`);
}

for (const [relativePath, expectedHash] of expectedUpstreamHashes) {
    assert.equal(fileSha256(relativePath), expectedHash, `${relativePath} changed from the 181 upstream baseline`);
}

const workerSource = fs.readFileSync(path.join(ROOT_DIR, '_worker.js'), 'utf8');
const workshopInjection = '<script src="/DB/module-loader.js?v=r2-workshop-1"></script>';
assert.equal(workerSource.split(workshopInjection).length - 1, 1, 'workshop loader injection must occur exactly once');
const workerWithoutWorkshopInjection = workerSource.replace(/<script src="\/DB\/nav-adapter\.js\?v=sync-195"><\/script>\r?\n/, '').replace(`${workshopInjection}${workerSource.includes(`${workshopInjection}\r\n`) ? '\r\n' : '\n'}`, '');
assert.equal(
    createHash('sha256').update(Buffer.from(workerWithoutWorkshopInjection, 'utf8')).digest('hex').toUpperCase(),
    'A2303B5074F99D962289650D564E3B3A927EFD4DF7D09B48BE6B8379EF452E61',
    '_worker.js differs from the active-character delivery tree by more than the workshop injection line'
);

assert.notEqual(
    fileSha256('DB/image-module.js'),
    '6493745BDBFA2F414960E6F8A3A3AB67D39CF9F9D64D97B9281A97183D1A983D',
    'image-module.js still matches the pre-change 181 baseline'
);

console.log('image-active-character-redlines.test.mjs: source and upstream SHA-256 locks passed');
