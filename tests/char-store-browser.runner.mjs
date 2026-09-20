import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(testDirectory, '..');
const charStorePath = resolve(siteRoot, 'DB', 'char-store.js');
const chrome = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

function replaceExactlyOnce(source, pattern, replacement, label) {
    const matches = source.match(pattern);
    if (!matches || matches.length !== 1) {
        throw new Error(`Expected exactly one ${label} match, found ${matches?.length || 0}.`);
    }
    return source.replace(pattern, replacement);
}

const largeRecordFixtureSource = replaceExactlyOnce(
    await readFile(charStorePath, 'utf8'),
    /const LARGE_RECORD_LENGTH = 100 \* 1024 \* 1024;/g,
    'const LARGE_RECORD_LENGTH = 1 * 1024 * 1024;',
    'production 100MiB large-record threshold'
);

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8'
};

const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname === '/tests/char-store-browser.wait') {
            setTimeout(() => response.writeHead(204).end(), 3000);
            return;
        }
        if (pathname === '/tests/char-store-browser.large-record.js') {
            response.writeHead(200, {
                'content-type': contentTypes['.js'],
                'cache-control': 'no-store'
            });
            response.end(largeRecordFixtureSource);
            return;
        }
        const relativePath = pathname === '/' ? 'tests/char-store-browser.html' : pathname.replace(/^\/+/, '');
        const filePath = resolve(siteRoot, relativePath);
        if (filePath !== siteRoot && !filePath.startsWith(`${siteRoot}${sep}`)) {
            response.writeHead(403).end('Forbidden');
            return;
        }
        const body = await readFile(filePath);
        response.writeHead(200, {
            'content-type': contentTypes[extname(filePath)] || 'application/octet-stream',
            'cache-control': 'no-store'
        });
        response.end(body);
    } catch (_) {
        response.writeHead(404).end('Not found');
    }
});

function runChrome(url, profileDirectory) {
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(chrome, [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-default-apps',
            '--no-first-run',
            `--user-data-dir=${profileDirectory}`,
            '--virtual-time-budget=15000',
            '--dump-dom',
            url
        ], { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', rejectRun);
        child.on('close', (code) => {
            if (code !== 0) {
                rejectRun(new Error(`Chrome exited ${code}: ${stderr}`));
                return;
            }
            resolveRun(stdout);
        });
    });
}

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}/tests/char-store-browser.html`;

try {
    for (const mode of ['main', 'unpatched', 'fetch-failure', 'large-record']) {
        const profileDirectory = await mkdtemp(resolve(tmpdir(), `rph-char-store-${mode}-`));
        try {
            const html = await runChrome(`${baseUrl}?mode=${mode}`, profileDirectory);
            if (!/<pre id="result" data-status="pass">PASS:/.test(html)) {
                throw new Error(`Browser test ${mode} failed:\n${html}`);
            }
            console.log(`PASS char-store browser ${mode}`);
        } finally {
            await rm(profileDirectory, { recursive: true, force: true });
        }
    }
} finally {
    await new Promise((resolveClose) => server.close(resolveClose));
}
