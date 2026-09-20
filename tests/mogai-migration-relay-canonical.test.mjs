import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');

// Snapshot taken immediately before the v2 relay work.  These are canonical
// site files; scripts/tests/evidence are intentionally outside this guard.
const EXPECTED = {
    'DB/nav-adapter.js': '4088685A265688A6FE87EFAC4517A83262DA2781B270BC2A4D7F1EE1AFEBA205',
    '_worker.js': '351A50453018389B27477291C71FC0942F8E745AF93DFA2983A33C90E8B53445',
    'assets/css/styles.css': 'CB4E276D0E6C6F66C311F501E7C3D8B391DEF05FEE7CB86DECE0F64E13B27713',
    'assets/js/app.js': '1531FD9E563517F642B57AB5CC9C821796753F813EF244370402CE772AA47B0C',
    'assets/js/card-utils.js': '401730146A43EEF77B24BBF2A3DAA43403DDB4FC817329253801C2E14F8C9062',
    'assets/js/ui-select.js': '7EF8EF39F4526BC8FB3AF9951BBB3E56C815D5A3A01418488F80591F009C7615',
    'assets/js/utils.js': 'D1DC4DCEBAEDC78FBD239856C5586DDC584B3DEE82D581D05BBB960963E4DD88',
    'character/index.html': '577942BF1474299D44992B77AAEEE42C7DF13CF1DE7B71A4443591549E99D708',
    'DB/README.md': 'F5D54F8C6FF5C520373671335F29D381C31CC078352EA3763CD09149890A96B5',
    'DB/app-patches.mjs': '55629DF1E0888F027863F2A618A72300BB03DDBF938F2119EAF520421C57AC53',
    'DB/bootstrap.js': '2BE2F8C3328D63BBE6C3962DA69E4CC9ED5236E6BB62E353385C3C123692ABE4',
    'DB/char-store.js': 'A02451B65EA470AAA936A772EA75900C323618CFA579953350996771D744D7FE',
    'DB/image-module.js': '249632CA94EB6034A1A0A665DC1F21BFA0A4D798A29EE4217440627DB3804085',
    'DB/module-loader.js': '313A1A0D7BCC9DBE074CD6ED576ABD2A3FAB176D0C1E0E354985F787C4C25021',
    'DB/styles.css': 'BB608C2DB52681DC8279139A0DBCFAD30DED5E5B15214A58363E6F26FF540A15',
    'index.html': 'C9BF4FBE157A6808FFBE9BFCDD9F60BDD499881AE638CC369A2F5F99053AD770',
    'LICENSE': '978A8C832BB0DC3AEF756768089A11B41CCAA7472D80491D74BBFFB23AAE94B1',
    'work.js': 'DAFEC08B9A370461E68A3412D9FD1D883113DA89CBD02B43052C99C67A207451',
    'wrangler.toml': 'C2FFFD4267C5234E72FF05B3388312F7230D525335E6AFB51F8065259805FCE0'
};

const actual = {};
for (const [relativePath, expected] of Object.entries(EXPECTED)) {
    const file = path.join(ROOT_DIR, ...relativePath.split('/'));
    assert.ok(fs.existsSync(file), `canonical file missing: ${relativePath}`);
    actual[relativePath] = createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
    assert.equal(actual[relativePath], expected, `canonical file changed: ${relativePath}`);
}

const imageModule = fs.readFileSync(path.join(ROOT_DIR, 'DB', 'image-module.js'), 'utf8');
assert.match(imageModule, /const MODULE_VERSION = 'r2-img-1';/, 'REVISION/module version was bumped');
assert.doesNotMatch(imageModule, /IMAGE_AUTO_ENTRY_MIGRATION_KEY|migrateNativeAutoImageEntry|buildNativeAutoImagePrompt/,
    'canonical tree contains retired world-info seeding code');

console.log(JSON.stringify({ ok: true, canonicalFileCount: Object.keys(actual).length, hashes: actual }, null, 2));
console.log('mogai-migration-relay-canonical.test.mjs: canonical site snapshot is byte-identical');
