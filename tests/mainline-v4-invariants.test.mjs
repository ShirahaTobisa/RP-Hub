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
    ['DB/image-module.js', '5ABA6CD6E4491512BF8832778FF3B1A3B258D17FEEEED91D7BC71ECF00708925'],
    ['_worker.js', 'E866A815FB5BB5F4D43E0F6DC6ED6FC27733540919BFBBCC82470AC789BC0BE4'],
    ['DB/char-store.js', '572888C71A656871438D4D7ED61212F46F99DCEAB561A1A07264961CBD66B9E3'],
    ['DB/bootstrap.js', 'D16D3BA8BB2D12BC916014AB42E84BE952339411736A85B4FDF2EABC879AD93A'],
    ['DB/styles.css', '5E283E2CE8A57CEECDAFF6F63CA1820B8AB75B93A7D421005F0E93D9A9643E3E'],
    ['DB/app-patches.mjs', '55629DF1E0888F027863F2A618A72300BB03DDBF938F2119EAF520421C57AC53'],
    ['assets/js/app.js', '2A966442F7E937A5229FE093C97336C152A8153B38E8B335CDC680D06781430C'],
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
    'DBF40D4A4E451EC89432AB85D9390B33300DAB8FA99F9903EDC45D25172DB26B',
    '_worker.js differs from the current img baseline by more than the workshop injection line'
);
const stableWorkerSegments = [
    ['sync CAS/history/GC core', 'function getChunkLength', 'function buildRemoteInfo', '249EB45190B0DB34C3BFB46D3467AE217E1E2F4A60C5CF592FBFAC49DF8DEC53'],
    ['pull-json-part handler', 'async function handlePullJsonPart', 'async function handleUploadCreate', '652B0707538D3C91BD9F1522A055C566086AEDEDEE0DF33B0E33B91E7D6065FB'],
    ['upload-part handler', 'async function handleUploadPart', 'async function handleUploadComplete', '279F7F19B8B0F47180D9D4D65A343A1BC013C52AF7D00AD7F7A035FA79FA296E'],
    ['app-update implementation', 'function buildGitHubHeaders', 'async function handleJsonApi', 'CBB4F0D29DBF2A6647F46B8D2122F866E797ABEA117403E7415697D4C5B43BAA']
];

for (const [label, startMarker, endMarker, expectedHash] of stableWorkerSegments) {
    const segment = normalizedWorkerSegment(workerSource, startMarker, endMarker);
    assert.equal(sha256Bytes(Buffer.from(segment, 'utf8')), expectedHash, `${label} changed outside the permitted v4 manifest surface`);
}

const bootstrapSource = fs.readFileSync(path.join(root, 'DB', 'bootstrap.js'), 'utf8');
const stableBootstrapUpdateSegments = [
    ['version rendering', 'function renderAppUpdateVersions', 'async function checkAppUpdate', 'BA415346FD6C556F436ABF55212AC1C146ED90000B17E572CBA9CE77FD9F505B'],
    ['update check', 'async function checkAppUpdate', 'async function applyAppUpdate', '58E94BE2974D6302160424B9608D936064EBFDA8863F0E62E22A34D3BFE5842F'],
    ['update apply', 'async function applyAppUpdate', 'async function rollbackAppUpdate', '083B17EAD38362F347B07F1CA270FBF77436EF82B7552C99F83858EF2F809D73'],
    ['update rollback', 'async function rollbackAppUpdate', 'async function submitSyncPassword', 'E7BEA7374036044587C6490A312D8AECFB2ED61F50633D699C96CEA302AEEBCD'],
    ['update modal wiring', 'function ensureModal', 'function rememberSyncFocus', '2191940D66C72CA14CAD2AAE6AD350A3CC270CC4BA3A501EAAA33D7CFA7CA3E0']
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
