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
    ['DB/bootstrap.js', 'FBF0A0C35CBD44BA86F1FB58BCCC6DDA79ED7625976B03F4C37FE385D6918C83'],
    ['DB/char-store.js', 'A02451B65EA470AAA936A772EA75900C323618CFA579953350996771D744D7FE'],
    ['DB/styles.css', 'A8717E07C8DD2FBF0645F12895D80527A8697A2BA53E91E2D8330CF86D745F97'],
    ['DB/app-patches.mjs', '55629DF1E0888F027863F2A618A72300BB03DDBF938F2119EAF520421C57AC53'],
    ['_worker.js', '69E4329DB672905E806FBE84EBCF877E31678AF7A0A266CFB330F55DC375D375'],
    ['index.html', '936A2A66740722BF43B3EAD160FFDCFEE163CC6A2486440C8C0F66B9C24B28A3'],
    ['work.js', 'DAFEC08B9A370461E68A3412D9FD1D883113DA89CBD02B43052C99C67A207451'],
    ['wrangler.toml', 'C2FFFD4267C5234E72FF05B3388312F7230D525335E6AFB51F8065259805FCE0'],
    ['LICENSE', '978A8C832BB0DC3AEF756768089A11B41CCAA7472D80491D74BBFFB23AAE94B1']
]);

const expectedUpstreamHashes = new Map([
    ['index.html', '936A2A66740722BF43B3EAD160FFDCFEE163CC6A2486440C8C0F66B9C24B28A3'],
    ['character/index.html', '8FCACEB80C70C523EF0730A71CC36CDCDDF64391B800F2FC08764277A062EFBD'],
    ['novel/index.html', 'B6425C9E75F7A248A1977FCF2E36BBF183B915AC02285C971E206CF829BC0FAF'],
    ['assets/css/styles.css', '4F163B07CAF86B7EAD4268261DE6C006F95A54174786D5E680AA9820F5E23AC0'],
    ['assets/css/theme.css', '5113B925C13AC6878BF7AFCD3DFB6CE810434B88C80797917CF8FBDF5904D7AF'],
    ['assets/js/api-utils.js', '7110B2A2599B3F45E9B0804F0C58CBFDBC1C405092F67BDF85ECF2C7A4D5294D'],
    ['assets/js/app.js', '2A966442F7E937A5229FE093C97336C152A8153B38E8B335CDC680D06781430C'],
    ['assets/js/built-in-content.js', '37B7DC717D533A32DAB4184C4238623C8CCE894E344B601C86ACF2D55D486005'],
    ['assets/js/core-utils.js', 'E9A425DEAF04732B8780AC5B2593F732D047D64367E64173A5545D3AE3CF1CF2'],
    ['assets/js/data-services.js', '6D4E514F067938246CCD1C9BFDF25BD8B866367B2A4FA66475DCCD585F556559'],
    ['assets/js/presence.js', '1EBE4DD33FE2FE2727CB0D700C29109DF8840ED2613F027664757611E54B074F'],
    ['assets/js/runtime-services.js', 'FA23CB94D09F1D336C4E2A98BE900534B992BAE29D24B916F6266671970DE532'],
    ['assets/js/theme.js', 'E70664A54CB2C1FF02BCD87B2DB0F3AE3FEC3DF2FA3B18862EC01E15A8AB62C8'],
    ['assets/js/ui-components.js', '1FCDD76F632EB885CD29E6102CEBDCFBA749E7A802D8379440DFC5CE354F874D'],
    ['assets/js/update-check.js', '7594E2C46AF88017558E061DDCD87F7CFFA6D804FC637B0061E571119FDE8BA3']
]);

for (const [relativePath, expectedHash] of expectedSourceHashes) {
    assert.equal(fileSha256(relativePath), expectedHash, `${relativePath} changed from the active-character delivery tree`);
}

for (const [relativePath, expectedHash] of expectedUpstreamHashes) {
    assert.equal(fileSha256(relativePath), expectedHash, `${relativePath} changed from the 1.9.8 upstream baseline`);
}

const workerSource = fs.readFileSync(path.join(ROOT_DIR, '_worker.js'), 'utf8');
const workshopInjection = '<script src="/DB/module-loader.js?v=r2-workshop-1"></script>';
assert.equal(workerSource.split(workshopInjection).length - 1, 1, 'workshop loader injection must occur exactly once');
const workerWithoutWorkshopInjection = workerSource.replace(/<script src="\/DB\/nav-adapter\.js\?v=sync-195"><\/script>\r?\n/, '').replace(`${workshopInjection}${workerSource.includes(`${workshopInjection}\r\n`) ? '\r\n' : '\n'}`, '');
assert.equal(
    createHash('sha256').update(Buffer.from(workerWithoutWorkshopInjection, 'utf8')).digest('hex').toUpperCase(),
    'B59E9F8812EA67247DF3135FCE64BDF96DFD88D45B99186435D74BDCD1044D69',
    '_worker.js differs from the active-character delivery tree by more than the workshop injection line'
);

assert.notEqual(
    fileSha256('DB/image-module.js'),
    '6493745BDBFA2F414960E6F8A3A3AB67D39CF9F9D64D97B9281A97183D1A983D',
    'image-module.js still matches the pre-change 181 baseline'
);

console.log('image-active-character-redlines.test.mjs: source and upstream SHA-256 locks passed');
