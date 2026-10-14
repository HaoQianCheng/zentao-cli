import { extendModuleAction } from 'zentao-api';

// zentao-api 0.8.0 declares a mixed-case default outside this action's enum.
extendModuleAction('my', 'auditPlans', (action) => {
    action.params = action.params?.map(param => param.name === 'browseType' && param.defaultValue === 'myChecking'
        ? { ...param, defaultValue: 'mychecking', description: param.description?.replace('默认 myChecking', '默认 mychecking') }
        : param);
    return action;
});

// Some servers read the product ID for bug creation from the query string.
// Copy the resolved body value so JSON/stdin precedence and SDK coercion agree.
extendModuleAction('bug', 'create', (action) => {
    const beforeRequest = action.beforeRequest;
    action.beforeRequest = async (request) => {
        const patch = await beforeRequest?.(request);
        const resolved = { ...request, ...patch };
        if (resolved.data?.productID === undefined) return patch ?? {};
        return {
            ...patch,
            query: { ...resolved.query, productID: resolved.data.productID },
        };
    };
    return action;
});
