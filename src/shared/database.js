    // operation 只负责排入请求；事务真正提交后才返回，任何同步错误都回滚本次事务。
    function withStore(db, name, mode, operation) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(name, mode);
            let result, failure;
            const abort = error => {
                if (failure) return;
                failure = error;
                tx.abort();
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = event => { failure ||= event.target.error; };
            tx.onabort = () => {
                const error = failure || tx.error || new Error('数据库事务已中止。');
                globalThis.RPHubDiagnostics?.failure('database-error', error);
                reject(error);
            };
            try { result = operation(tx.objectStore(name), abort); }
            catch (error) { abort(error); }
        });
    }
