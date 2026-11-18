    // 把原生下拉框换成 RPH 自己的下拉框（展开的列表、深色模式都和原生设置页一样）。值还在隐藏的 <select> 里，
    // 别的代码照旧读写 .value、监听 change；选项或选中项变了会自己跟上。页面没有这个组件（旧版 RPH）时保持原生下拉框。
    function styledSelect(select) {
        const Component = window.RPHubCustomSelect;
        const Vue = globalThis.Vue;
        if (!select || !Component || !Vue?.createApp) return { unmount() {} };
        const view = Vue.reactive({ value: '', options: [] });
        const sync = () => Object.assign(view, {
            value: select.value,
            options: [...select.options].map((option) => ({ value: option.value, label: option.textContent, disabled: option.disabled }))
        });
        const host = document.createElement('div');
        const app = Vue.createApp({
            render: () => Vue.h(Component, {
                modelValue: view.value, options: view.options, buttonClass: 'rph-ui-input', menuClass: 'text-sm',
                'onUpdate:modelValue': (value) => {
                    select.value = value;
                    sync();
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
            })
        });
        app.mount(host);
        select.hidden = true;
        select.after(host);
        const observer = new MutationObserver(sync);
        observer.observe(select, { childList: true, subtree: true, attributes: true });
        sync();
        return {
            unmount() {
                observer.disconnect();
                app.unmount();
            }
        };
    }
