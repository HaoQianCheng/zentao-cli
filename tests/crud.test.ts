import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CLI command entry points', () => {
    let directory: string;
    let configFile: string;
    let server: ReturnType<typeof Bun.serve>;
    let requests: Array<{ method: string; path: string; query: Record<string, string>; body?: unknown }>;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'zentao-cli-crud-'));
        configFile = join(directory, 'config.json');
        requests = [];
        server = Bun.serve({
            hostname: '127.0.0.1', port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                if (url.searchParams.get('mode') === 'getconfig') {
                    return Response.json({ version: '22.7' });
                }
                const path = url.pathname.replace('/api.php/v2', '');
                requests.push({ method: request.method, path, query: Object.fromEntries(url.searchParams),
                    ...(request.method === 'POST' ? { body: await request.json() } : {}) });
                if (path.endsWith('/deliverable-options')) return Response.json({ deliverables: { 3: '开发说明', 8: '验收报告' } });
                if (path.endsWith('/deliverables')) return Response.json({ deliverables: [{ id: 7, name: '开发说明' }], pager: { pageID: 2, recPerPage: 10, recTotal: 21 } });
                return Response.json({
                    status: 'success',
                    product: { id: Number(path.split('/').at(-1)), name: 'Product' },
                    products: [{ id: 1, name: 'First' }, { id: 2, name: 'Second' }],
                    bugs: [],
                    rows: [],
                    id: 7,
                    resourceCalendars: { developer: { tasks: [] } },
                });
            },
        });
        const address = `http://127.0.0.1:${server.port}`;
        writeFileSync(configFile, JSON.stringify({
            currentProfile: `test@${address}`,
            profiles: [{ server: address, account: 'test', token: 'test-token' }],
        }));
    });

    afterEach(() => {
        server.stop(true);
        rmSync(directory, { recursive: true, force: true });
    });

    async function run(args: string[]) {
        const child = Bun.spawn({
            cmd: [process.execPath, '--no-env-file', 'src/index.ts', '--config', configFile, '--format=json', ...args],
            env: { ...process.env, ZENTAO_URL: '', ZENTAO_ACCOUNT: '', ZENTAO_PASSWORD: '', ZENTAO_TOKEN: '' },
            stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        return { stdout, stderr, exitCode };
    }

    test.each([
        ['product', 'delete', '1,2'],
        ['delete', 'product', '1,2'],
        ['do', 'product', 'delete', '1,2'],
    ].map(args => ({ args })))('preserves positional batch targets through %j', async ({ args }) => {
        const result = await run([...args, '--id=4,5', '--params={"id":3}', '--yes']);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
            { method: 'DELETE', path: '/products/1' },
            { method: 'DELETE', path: '/products/2' },
        ]);
        expect(JSON.parse(result.stdout).result.success).toEqual([1, 2]);
    });

    test.each([
        ['product', 'delete', '1'], ['delete', 'product', '1'],
        ['product', 'get', '1'], ['get', 'product', '1'], ['product', '1'],
    ].map(args => ({ args })))('preserves a positional target through %j', async ({ args }) => {
        const result = await run([...args, '--params={"id":3}', '--yes']);
        expect(result.exitCode).toBe(0);
        expect(requests.map(({ path }) => path)).toEqual(['/products/1']);
    });

    test('selects the batch from the final merged parameters', async () => {
        const result = await run(['product', 'delete', '--id=4,5', '--params={"id":"1,2"}', '--yes']);
        expect(result.exitCode).toBe(0);
        expect(requests.map(({ path }) => path)).toEqual(['/products/1', '/products/2']);
        expect(JSON.parse(result.stdout).result.success).toEqual([1, 2]);
    });

    test.each(['ls', 'list'])('%s preserves pagination, processing and dynamic options', async (command) => {
        const options = ['--page=2', '--recPerPage=10', '--pick=id', '--limit=1', '--orderBy=id_desc'];
        const direct = await run(['product', ...options]);
        const directRequests = [...requests];
        requests.length = 0;
        const shortcut = await run([command, 'product', ...options]);

        expect(shortcut).toEqual(direct);
        expect(shortcut.exitCode).toBe(0);
        expect(JSON.parse(shortcut.stdout).data).toEqual([{ id: 1 }]);
        expect(requests).toEqual(directRequests);
        expect(requests[0].query).toMatchObject({ pageID: '2', recPerPage: '10', orderBy: 'id_desc' });
    });

    test('ls passes scope options to scoped list actions', async () => {
        const result = await run(['ls', 'bug', '--product=1']);
        expect(result.exitCode).toBe(0);
        expect(requests.map(({ path }) => path)).toEqual(['/products/1/bugs']);
    });

    test('generic get supports queries without a path ID and preserves dynamic options', async () => {
        const options = ['--type=person', '--projectID=1', '--accounts=developer'];
        const direct = await run(['resourcecalendar', 'get', ...options]);
        const shortcut = await run(['get', 'resourcecalendar', ...options]);
        expect(shortcut).toEqual(direct);
        expect(shortcut.exitCode).toBe(0);
        expect(JSON.parse(shortcut.stdout)).toEqual({ developer: { tasks: [] } });
        expect(requests).toHaveLength(2);
        expect(requests[0]).toEqual(requests[1]);
        expect(requests[0]).toEqual({ method: 'GET', path: '/resourcecalendars', query: { type: 'person', mode: 'wait', projectID: '1', accounts: 'developer' } });
    });

    test('generic get still requires the ID declared by the selected action', async () => {
        const result = await run(['get', 'product']);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stderr).error.code).toBe('2003');
        expect(requests).toEqual([]);
    });

    test('JSON examples preserve repository ID arrays and an explicit false SQL count', async () => {
        const repo = { space: 10, product: [12, 13], name: 'demo_repo' };
        expect((await run(['repo', 'create', '--data', JSON.stringify(repo)])).exitCode).toBe(0);
        expect(requests[0]).toMatchObject({ method: 'POST', path: '/repos', body: repo });
        const query = { sql: 'SELECT id, account FROM zt_user', page: 1, limit: 20, count: false };
        expect((await run(['db', 'query', '--params', JSON.stringify(query)])).exitCode).toBe(0);
        expect(requests[1]).toMatchObject({ method: 'POST', path: '/db/query', body: query });
    });

    test('deliverable options remain an object and submitted deliverables retain their pager', async () => {
        const options = await run(['deliverable', 'options', '--projectID=2']);
        expect(options.exitCode).toBe(0);
        expect(JSON.parse(options.stdout)).toEqual({ 3: '开发说明', 8: '验收报告' });
        expect(requests[0]).toEqual({ method: 'GET', path: '/projects/2/deliverable-options', query: {} });
        const list = await run(['deliverable', 'list', '--projectID=2', '--browseType=reviewing', '--page=2', '--recPerPage=10']);
        expect(list.exitCode).toBe(0);
        expect(JSON.parse(list.stdout)).toMatchObject({ data: [{ id: 7, name: '开发说明' }], pager: { page: 2, recPerPage: 10, total: 21 } });
        expect(requests[1]).toMatchObject({ path: '/projects/2/deliverables', query: { browseType: 'reviewing', pageID: '2', recPerPage: '10' } });
    });

    test('relation unlink uses a relation record ID through each CLI entry point', async () => {
        for (const args of [
            ['relation', 'unlink', '--relationID=8'],
            ['relation', 'unlink', '8'],
            ['do', 'relation', 'unlink', '--id=8'],
        ]) {
            const result = await run([...args, '--yes']);
            expect(result.exitCode, result.stderr).toBe(0);
            expect(requests.at(-1)).toEqual({ method: 'DELETE', path: '/relations/8', query: {} });
        }
        expect(requests).toHaveLength(3);
    });

    test('relation unlink rejects legacy object selectors even when an ID could be resolved', async () => {
        const legacy = { objectType: 'story', objectID: 42, relatedObjectType: 'bug', relatedObjectID: 43, relationName: 'related' };
        for (const args of [
            ['42', ...Object.entries(legacy).map(([key, value]) => `--${key}=${value}`)],
            ['--id=42', '--params', JSON.stringify(legacy)],
            ['--relationID=8', '--objectID=42'],
            Object.entries(legacy).map(([key, value]) => `--${key}=${value}`),
        ]) {
            const result = await run(['relation', 'unlink', ...args, '--yes']);
            expect(result.exitCode, args.join(' ')).toBe(1);
            expect(JSON.parse(result.stderr).error).toMatchObject({ code: '2009', message: expect.stringContaining('relationID') });
        }
        expect(requests).toEqual([]);
    });

    test('relation unlink still requires a relation ID and explicit deletion confirmation', async () => {
        const missingID = await run(['relation', 'unlink', '--yes']);
        expect(missingID.exitCode).toBe(1);
        expect(JSON.parse(missingID.stderr).error.code).toBe('2003');
        const unconfirmed = await run(['relation', 'unlink', '--relationID=8']);
        expect(unconfirmed.exitCode).toBe(1);
        expect(JSON.parse(unconfirmed.stderr).error.message).toContain('--yes');
        expect(requests).toEqual([]);
    });

    test('ls refuses unsupported automatic pagination before requesting a page', async () => {
        const result = await run(['ls', 'product', '--all']);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stderr).error.code).toBe('2009');
        expect(requests).toEqual([]);
    });
});
