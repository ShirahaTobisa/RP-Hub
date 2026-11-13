    function canonicalImageRenderUrl(source) {
        const url = new URL(source, window.location.origin);
        url.searchParams.delete('_rph_retry');
        return url;
    }

    function requestImageGeneration(source) {
        const url = canonicalImageRenderUrl(source);
        const requestKey = url.toString();
        if (state.pendingRequests.has(requestKey)) return state.pendingRequests.get(requestKey);
        const request = (async () => {
            const headers = {};
            const token = getImageToken();
            const provider = String(url.searchParams.get('provider') || '').toLowerCase();
            const tokenProvider = getTokenProviderName(token);
            if (token && (!provider || !tokenProvider || provider === tokenProvider)) headers[IMAGE_TOKEN_HEADER] = token;
            const syncPassword = safeLocalGet('rp_hub_sync_password_v1');
            if (syncPassword) headers['x-rp-sync-password'] = syncPassword;
            const generator = String(generation.settings.generator || 'direct');
            let response;
            if (generator === 'direct') {
                response = await fetch(url, { method: 'POST', headers });
            } else {
                // 选了插件提供的生图接口：插件在浏览器里生成，外壳把图片上传存进 R2（存放位置和直链生图相同）。
                const provider = generation.providers.get(generator);
                if (!provider) throw new Error(`生图接口「${generator}」的插件没有加载，请在模块管理里启用它，或在设置里改回直链`);
                const blob = await provider.generate({ params: Object.fromEntries(url.searchParams), token });
                if (!(blob instanceof Blob) || !blob.type.startsWith('image/')) throw new Error(`生图接口「${provider.label}」没有返回图片`);
                response = await fetch(url, { method: 'PUT', headers: { ...headers, 'content-type': blob.type }, body: blob });
            }
            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                throw new Error(payload?.error || `图片生成失败：HTTP ${response.status}`);
            }
            if (response.body) await response.body.cancel().catch(() => { });
            return true;
        })();
        state.pendingRequests.set(requestKey, request);
        request.then(() => state.pendingRequests.delete(requestKey), () => state.pendingRequests.delete(requestKey));
        return request;
    }

    function handleImageError(event) {
        const image = event.target;
        if (!(image instanceof HTMLImageElement)) return;
        const frame = image.closest('.rp-generated-image-frame');
        if (!frame) return;
        let url;
        try { url = canonicalImageRenderUrl(image.currentSrc || image.src || ''); } catch (_) { return; }
        if (url.origin !== window.location.origin || url.pathname !== IMAGE_RENDER_ENDPOINT) return;
        const currentState = image.dataset.rphImageGenerationState || '';
        if (image.dataset.rphImageReadOnly === '1') {
            image.dataset.rphImageGenerationState = 'missing';
            image.alt = '原图读取失败，可点击重新生成';
            frame.style.minHeight = '96px';
            return;
        }
        if (currentState === 'pending' || currentState === 'retrying') return;
        if (isFrozenForBusy()) {
            image.dataset.rphImageGenerationState = 'deferred';
            return;
        }
        image.dataset.rphImageGenerationState = 'pending';
        requestImageGeneration(url).then(() => {
            const retryUrl = canonicalImageRenderUrl(url);
            retryUrl.searchParams.set('_rph_retry', String(Date.now()));
            image.dataset.rphImageGenerationState = 'retrying';
            image.src = retryUrl.toString();
        }).catch((error) => {
            image.dataset.rphImageGenerationState = 'failed';
            image.alt = `生图失败：${describeGenerationError(error) || '请检查密钥或服务状态'}`;
            reportImageGenerationFailure(error);
        });
    }

    function buildImageThumbnailBlob(image) {
        return new Promise((resolve, reject) => {
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            if (!width || !height) return reject(new Error('Image is not ready'));
            const ratio = Math.min(1, 360 / Math.max(width, height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(width * ratio));
            canvas.height = Math.max(1, Math.round(height * ratio));
            const context = canvas.getContext('2d');
            if (!context) return reject(new Error('Canvas unavailable'));
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Failed to build thumbnail')), 'image/webp', 0.8);
        });
    }

    async function uploadImageThumbnail(image) {
        let signature = '';
        try {
            const source = image?.currentSrc || image?.src || '';
            const url = new URL(source, window.location.origin);
            if (url.origin !== window.location.origin || url.pathname !== IMAGE_RENDER_ENDPOINT) return;
            url.searchParams.delete('_rph_retry');
            signature = url.search;
            if (!signature || state.uploadedThumbs.has(signature)) return;
            state.uploadedThumbs.add(signature);
            const blob = await buildImageThumbnailBlob(image);
            const response = await fetch(IMAGE_THUMB_ENDPOINT + signature, {
                method: 'PUT',
                headers: {
                    'Content-Type': blob.type || 'image/webp',
                    'x-rp-sync-password': safeLocalGet('rp_hub_sync_password_v1')
                },
                body: blob
            });
            if (!response.ok) throw new Error(`Thumbnail upload failed: ${response.status}`);
        } catch (error) {
            if (signature) state.uploadedThumbs.delete(signature);
            log('thumbnail upload failed', error);
        }
    }

    function handleImageLoad(event) {
        const image = event.target;
        if (!(image instanceof HTMLImageElement)) return;
        const frame = image.closest('.rp-generated-image-frame');
        if (!frame) return;
        // 只有这个页面刚生成出来的图（重试加载）才顺手传缩略图；已存好的图每次加载不再重做，缺的由图片管理页补。
        const justGenerated = image.dataset.rphImageGenerationState === 'retrying';
        delete image.dataset.rphImageGenerationState;
        if (frame.getAttribute('data-image-render-key')) {
            scheduleSave({ uuid: frame.getAttribute('data-character-uuid') || '' });
        }
        if (justGenerated) uploadImageThumbnail(image).catch((error) => log('thumbnail task failed', error));
    }

