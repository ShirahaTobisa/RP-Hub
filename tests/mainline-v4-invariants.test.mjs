import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function sha256Bytes(bytes) {
    return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function fileSha256(relativePath) {
    return sha256Bytes(fs.readFileSync(path.join(root, relativePath)));
}

function normalizedWorkerSegment(source, startMarker, endMarker) {
    const normalized = source.replaceAll('\r\n', '\n');
    const start = normalized.indexOf(startMarker);
    const end = normalized.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0, `worker marker missing: ${startMarker}`);
    assert.ok(end > start, `worker marker missing or reordered: ${endMarker}`);
    return normalized.slice(start, end);
}

const protectedFiles = new Map([
    ['DB/image-module.js', 'EEC947FA77F4D50A28F1F6E23D15A1ECB0995C4F67D2D3C1659A2254C001AA47'],
    ['_worker.js', '351A50453018389B27477291C71FC0942F8E745AF93DFA2983A33C90E8B53445'],
    ['DB/char-store.js', 'A02451B65EA470AAA936A772EA75900C323618CFA579953350996771D744D7FE'],
    ['DB/bootstrap.js', '2BEA8C374E3B56F1CD3F883B23C0E03991C983F0353F404CC7192403515AE602'],
    ['DB/styles.css', 'BB608C2DB52681DC8279139A0DBCFAD30DED5E5B15214A58363E6F26FF540A15'],
    ['DB/app-patches.mjs', '55629DF1E0888F027863F2A618A72300BB03DDBF938F2119EAF520421C57AC53'],
    ['assets/js/app.js', '1531FD9E563517F642B57AB5CC9C821796753F813EF244370402CE772AA47B0C'],
    ['scripts/rebuild.mjs', 'BFD59ECA2596E37C55583146FFB8CFE48656B9C4AF81E9ACA606B833C02302DC']
]);

for (const [relativePath, expectedHash] of protectedFiles) {
    assert.equal(fileSha256(relativePath), expectedHash, `${relativePath} changed from the mainline baseline`);
}

const workerSource = fs.readFileSync(path.join(root, '_worker.js'), 'utf8');
const workshopInjection = '<script src="/DB/module-loader.js?v=r2-workshop-1"></script>';
assert.equal(workerSource.split(workshopInjection).length - 1, 1, 'workshop loader injection must occur exactly once');
const workerWithoutWorkshopInjection = workerSource.replace(/<script src="\/DB\/nav-adapter\.js\?v=sync-195"><\/script>\r?\n/, '').replace(`${workshopInjection}${workerSource.includes(`${workshopInjection}\r\n`) ? '\r\n' : '\n'}`, '');
assert.equal(
    sha256Bytes(Buffer.from(workerWithoutWorkshopInjection, 'utf8')),
    'A2303B5074F99D962289650D564E3B3A927EFD4DF7D09B48BE6B8379EF452E61',
    '_worker.js differs from the current img baseline by more than the workshop injection line'
);
const stableWorkerSegments = [
    ['sync CAS/history/GC core', 'function getChunkLength', 'function buildRemoteInfo', '7FC81FBA8BF5C43271648B55BD6D255615FFE8227EB61CA1004A74286C7C5EAC'],
    ['pull-json-part handler', 'async function handlePullJsonPart', 'async function handleUploadCreate', 'D366983D77B5FDB07BE327B5B0BC386FA1E887C77B2786B5D0174D2ADE919093'],
    ['upload-part handler', 'async function handleUploadPart', 'async function handleUploadComplete', '43D9C71D4E55870986A03F4998DD1F3FC6B0E4A1FF8EA6E46C7D21489B9E7C8F'],
    ['app-update implementation', 'function buildGitHubHeaders', 'async function handleJsonApi', 'B1ECB6B5F65809EA6113B1014FE5FB72B2625F09C74184E664F9CE2D2C7E1BBB']
];

for (const [label, startMarker, endMarker, expectedHash] of stableWorkerSegments) {
    const segment = normalizedWorkerSegment(workerSource, startMarker, endMarker);
    assert.equal(sha256Bytes(Buffer.from(segment, 'utf8')), expectedHash, `${label} changed outside the permitted v4 manifest surface`);
}

const bootstrapSource = fs.readFileSync(path.join(root, 'DB', 'bootstrap.js'), 'utf8');
const stableBootstrapUpdateSegments = [
    ['version rendering', 'function renderAppUpdateVersions', 'async function checkAppUpdate', 'FF7BB233B607324F6A6D1925AF8A763D1D1814F6ACD4CAF0CA5AEEAAD46ED01F'],
    ['update check', 'async function checkAppUpdate', 'async function applyAppUpdate', '58E94BE2974D6302160424B9608D936064EBFDA8863F0E62E22A34D3BFE5842F'],
    ['update apply', 'async function applyAppUpdate', 'async function rollbackAppUpdate', '8998E34D9287D239E5DE0EB22CE454CAC4D85F2EAE07BC4B330754E662AAD3C2'],
    ['update rollback', 'async function rollbackAppUpdate', 'async function submitSyncPassword', 'E7BEA7374036044587C6490A312D8AECFB2ED61F50633D699C96CEA302AEEBCD'],
    ['update modal wiring', 'function ensureModal', 'function rememberSyncFocus', '0AAF4EB51B85EAF3F07F3B431C1FA16FA46AFB3BE33D3421731E791F8349978B']
];

for (const [label, startMarker, endMarker, expectedHash] of stableBootstrapUpdateSegments) {
    let segment = normalizedWorkerSegment(bootstrapSource, startMarker, endMarker);
    // Only the close-button lookup/binding changed for navigation focus handling.
    if (label === 'update modal wiring') segment = segment
        .replace("closeButton = modalRoot.querySelector('.rp-sync-modal__close');", "closeButton = modalRoot.querySelector('[data-action=\"close\"]');")
        .replace("        modalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener", "        modalRoot.querySelector('.rp-sync-modal__close').addEventListener('click', closeModal);\n        modalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener");
    assert.equal(sha256Bytes(Buffer.from(segment, 'utf8')), expectedHash, `client app-update ${label} changed from mainline`);
}

assert.doesNotMatch(workerSource, /body\.action === ['"]pull-part['"]/);
assert.doesNotMatch(workerSource, /\bbaseVersion\b/);
assert.match(workerSource, /const IMAGE_API_PATH = ['"]\/api\/rp-image['"]/);
assert.match(workerSource, /const IMAGE_THUMB_API_PATH = ['"]\/api\/rp-image-thumb['"]/);
assert.match(workerSource, /const IMAGE_ADMIN_PATH = ['"]\/image['"]/);
assert.match(workerSource, /function parseImageObjectKey\(key\)/);
assert.match(workerSource, /function createImageKey\(characterName, checksum\)/);
for (const action of ['app-update-versions', 'app-update-check', 'app-update-apply', 'app-update-rollback']) {
    assert.match(workerSource, new RegExp(`body\\.action === ['"]${action}['"]`), `${action} route is missing`);
}

console.log('mainline v4 protected-file and stable-worker invariants passed');
