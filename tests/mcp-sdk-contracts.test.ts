import { expect, test } from 'bun:test';
import { getModuleActionParams } from 'zentao-api';
import { getAction, getModule } from '../src/modules/helper.js';
import { normalizeToolParams } from '../src/mcp/params.js';
import { createMcpTestClient } from './mcp-helpers.js';

test('MCP scope shortcuts never replace array fields', async () => {
    let requests = 0;
    const mcp = await createMcpTestClient(() => { requests++; return Response.json({}); });
    try {
        const { tools } = await mcp.client.listTools();
        expect(tools.find(tool => tool.name === 'zentao_repo')!.inputSchema.properties).not.toHaveProperty('product');
        expect(tools.find(tool => tool.name === 'zentao_task')!.inputSchema.properties).toHaveProperty('execution');
        for (const [name, actionName, alias, params] of [
            ['repo', 'create', { product: 12 }, { space: 10, name: 'demo' }],
            ['auditplan', 'batchCreate', { execution: 3 }, { projectID: 1, process: ['117'], objectID: ['475'], checkDate: ['2026-10-16'] }],
            ['opportunity', 'batchCreate', { execution: 3 }, { projectID: 1, name: ['Opportunity'] }],
        ] as const) {
            const mod = getModule(name)!;
            expect(() => normalizeToolParams(mod, getAction(mod, actionName)!, { ...alias, params })).toThrow();
            expect((await mcp.client.callTool({ name: `zentao_${name}`, arguments: { action: actionName, ...alias, params } })).isError).toBe(true);
        }
        expect(requests).toBe(0);
    } finally {
        await mcp.close();
    }
});

test('MCP validates SDK body constraints before authentication, including JSON data and array elements', async () => {
    let requests = 0;
    const mcp = await createMcpTestClient(() => { requests++; return Response.json({ version: '22.7', id: 1 }); });
    try {
        for (const patch of [
            { space: 0.5 }, { space: 0 }, { space: Number.MAX_SAFE_INTEGER + 1 },
            { product: [] }, { product: ['12'] }, { product: [0] }, { product: [1.5] },
            { name: '' }, { name: 'bad name' }, { members: [''] }, { members: [1] },
        ]) {
            const body = { space: 10, product: [12], name: 'demo', ...patch };
            for (const params of [body, { data: body }]) {
                const result = await mcp.client.callTool({ name: 'zentao_repo', arguments: { action: 'create', params } });
                expect(result, JSON.stringify(params)).toMatchObject({ isError: true, structuredContent: { error: { code: 'E2009' } } });
            }
        }
        for (const params of [{ name: 'bad name', publicKey: 'ssh-ed25519 mock' }, { name: 'coder', publicKey: '' }]) {
            const result = await mcp.client.callTool({ name: 'zentao_my', arguments: { action: 'createSSH', params } });
            expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'E2009' } } });
        }
        expect(requests).toBe(0);
    } finally {
        await mcp.close();
    }
});

test('new SDK requests preserve numeric arrays, public keys, multiple IDs, autofill and false', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const mcp = await createMcpTestClient(async req => {
        const url = new URL(req.url);
        if (url.searchParams.get('mode') === 'getconfig') return Response.json({ version: '22.7' });
        const path = url.pathname.replace('/api.php/v2', '');
        requests.push({ method: req.method, path, ...(req.method === 'POST' || req.method === 'PUT' ? { body: await req.json() } : {}) });
        return Response.json({ status: 'success', id: 7, rows: [{ id: 7 }], flow: { id: 5, name: 'Original', navigator: 'primary', position: 'after', positionModule: 'main', readOnlyField: 'excluded' } });
    });
    try {
        const publicKey = 'ssh-ed25519 <mock-public-key> developer@example.com';
        for (const [name, args] of [
            ['repo', { action: 'create', params: { data: { space: 10, product: [12, 13], name: 'demo_repo', acl: 'private', members: ['developer'] } } }],
            ['my', { action: 'createSSH', params: { name: 'coder', publicKey } }],
            ['relation', { action: 'unlink', id: 42, params: { objectType: 'story', relatedObjectType: 'bug', relatedObjectID: 43, relationName: 'related' } }],
            ['workflow', { action: 'updateFlow', id: 5, params: { name: 'Renamed' } }],
            ['db', { action: 'query', params: { sql: 'SELECT id FROM zt_user', count: false } }],
        ] as const) {
            const result = await mcp.client.callTool({ name: `zentao_${name}`, arguments: args });
            expect(result.isError, `${name}/${args.action}: ${JSON.stringify(result)}`).not.toBe(true);
        }
        expect(requests).toEqual([
            { method: 'POST', path: '/repos', body: { space: 10, product: [12, 13], name: 'demo_repo', acl: 'private', members: ['developer'], desc: '' } },
            { method: 'POST', path: '/my/sshkeys', body: { name: 'coder', publicKey } },
            { method: 'DELETE', path: '/relations/story/42/bug/43/related' },
            { method: 'GET', path: '/workflows/5' },
            { method: 'PUT', path: '/workflows/5', body: { name: 'Renamed', navigator: 'primary', position: 'after', positionModule: 'main' } },
            { method: 'POST', path: '/db/query', body: { sql: 'SELECT id FROM zt_user', count: false } },
        ]);
    } finally {
        await mcp.close();
    }
});

test('audit plan defaults match their enum without weakening case-sensitive task filters', () => {
    const mod = getModule('my')!;
    const auditPlans = getAction(mod, 'auditPlans')!;
    const browseType = getModuleActionParams('my', 'auditPlans').find(param => param.name === 'browseType')!;
    expect(browseType.defaultValue).toBe('mychecking');
    expect(() => normalizeToolParams(mod, auditPlans, { params: { browseType: browseType.defaultValue } })).not.toThrow();
    expect(() => normalizeToolParams(mod, getAction(mod, 'tasks')!, { params: { browseType: 'assignedto' } })).toThrow();
});
