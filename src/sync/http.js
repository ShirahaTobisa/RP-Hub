    function buildSyncHeaders(options = {}) {
        const password = typeof options.password === 'string' ? options.password : getStoredSyncPassword();
        return { 'content-type': 'application/json', ...(password ? { 'x-rp-sync-password': password } : {}) };
    }

    function buildPartHeaders(chunk, options = {}) {
        return { ...buildSyncHeaders(options), 'content-type': 'application/octet-stream',
            'x-rp-part-checksum': chunk.checksum, 'x-rp-part-length': String(chunk.length) };
    }

    function shouldRetrySyncError(error) {
        const status = Number(error?.status || 0);
        return !status || status === 408 || status === 429 || status >= 500;
    }

    const transferTimeout = bytes => CONFIG.transferTimeoutMs + Math.ceil(bytes / 50);

    async function requestSync(url, init, options = {}) {
        const retries = Number.isInteger(options.retryCount) ? options.retryCount : CONFIG.retryCount;
        const timeout = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : CONFIG.requestTimeoutMs;
        for (let attempt = 0; ; attempt += 1) {
            if (options.shouldStop?.()) throw new Error('其他下载任务已失败，停止重试。');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            try {
                const response = await fetch(url, { ...init, method: 'POST', credentials: 'same-origin', signal: controller.signal });
                if (response.ok && options.binary) {
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    return { ok: true, bytes,
                        byteLength: Number(response.headers.get('x-rp-sync-byte-length') || bytes.byteLength),
                        partLengths: response.headers.get('x-rp-sync-part-lengths') || '' };
                }
                const data = await response.json().catch(() => ({}));
                if (response.ok && data.ok) return data;
                if (response.status === 401 && !options.keepPasswordOnAuthError) clearStoredSyncPassword();
                throw Object.assign(new Error(data.error || 'HTTP ' + response.status), { response: data, status: response.status });
            } catch (cause) {
                const error = cause?.name === 'AbortError'
                    ? Object.assign(new Error((options.upload ? '上传' : '同步请求') + '超时，请检查网络后重试。'), { status: 0 })
                    : cause instanceof Error ? cause : new Error(String(cause));
                if (attempt >= retries || !shouldRetrySyncError(error)) throw error;
            } finally { clearTimeout(timer); }
            await wait(CONFIG.retryDelayMs * (attempt + 1));
        }
    }

    function postSync(payload, options = {}) {
        return requestSync(CONFIG.apiEndpoint, { headers: buildSyncHeaders(options), body: JSON.stringify(payload) }, options);
    }

    function postSyncBinary(payload, options = {}) {
        return postSync(payload, { ...options, binary: true });
    }

    // 版本 6 分片先压缩，再按压缩后的长度和校验码上传。
    async function preparePart(chunk, gzip = false) {
        const body = gzip ? await gzipBytes(chunk.bytes) : chunk.bytes;
        return { index: chunk.index, checksum: chunk.checksum, length: chunk.length, body,
            ...(gzip ? { encoding: 'gzip', storedLength: body.byteLength, storedChecksum: await sha256Bytes(body) } : {}) };
    }

    async function postUploadPart(chunk) {
        const headers = { ...buildPartHeaders(chunk), ...(chunk.encoding === 'gzip' ? {
            'x-rp-part-encoding': 'gzip', 'x-rp-part-stored-length': String(chunk.storedLength),
            'x-rp-part-stored-checksum': chunk.storedChecksum } : {}) };
        const params = new URLSearchParams({ action: 'upload-part', index: String(chunk.index), partNumber: String(chunk.index + 1) });
        const data = await requestSync(CONFIG.apiEndpoint + '?' + params, { headers, body: chunk.body }, {
            timeoutMs: transferTimeout(chunk.body.byteLength), upload: true });
        return { partNumber: Number(data.partNumber), index: chunk.index, byteLength: chunk.length, checksum: chunk.checksum, key: data.key };
    }

