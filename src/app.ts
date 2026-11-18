// HTTP entry point: routes requests to the git smart-HTTP surface, the REST
// v3 surface, GraphQL and MCP. Every reply carries a non-empty
// X-GitHub-Request-Id; every REST/GraphQL/MCP reply is application/json.

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit, readBody } from './protocol.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function decodeSegments(pathname: string): string[] | null {
  const parts = pathname.split('/').filter((p) => p !== '');
  try {
    return parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
}

export function createApp(store: Store): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const authorized = (req: IncomingMessage): boolean => {
    if (token === '') return true;
    return (req.headers.authorization ?? '') === `Bearer ${token}`;
  };

  return createServer((req, res) => {
    void (async () => {
      res.setHeader('x-github-request-id', randomBytes(8).toString('hex'));
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 400, { message: 'Bad request URL' });
        return;
      }
      const segments = decodeSegments(url.pathname);
      if (segments === null) {
        sendJson(res, 400, { message: 'Bad request path' });
        return;
      }

      // Health check: boot probes this twice and only wants HTTP 200.
      if (segments.length === 1 && segments[0] === 'healthz') {
        if (method !== 'GET') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
        const owner = segments[0] as string;
        const repoName = (segments[1] as string).slice(0, -4);
        const rest = segments.slice(2);
        try {
          const handled = await handleGit(store, req, res, owner, repoName, rest);
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
        } catch (err) {
          if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        }
        return;
      }

      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      const rawBody = needsBody ? await readBody(req) : null;

      // REST v3: /api/v3/...
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        if (!authorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        try {
          const handled = handleRest(store, req, res, segments.slice(2), url.searchParams, rawBody);
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
        } catch (err) {
          if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        }
        return;
      }

      // GraphQL: POST /api/graphql
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
        if (!authorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        let body: unknown;
        try {
          body = rawBody === null || rawBody.length === 0 ? {} : JSON.parse(rawBody.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        try {
          sendJson(res, 200, handleGraphQL(store, body));
        } catch (err) {
          if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        }
        return;
      }

      // MCP: POST /mcp
      if (segments.length === 1 && segments[0] === 'mcp') {
        if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
        if (!authorized(req)) {
          // JSON-RPC-shaped 401, as the MCP client expects a JSON body.
          const text = rawBody === null ? '' : rawBody.toString('utf8');
          let id: unknown = null;
          const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text);
          if (m !== null) {
            const raw = m[1] as string;
            id = raw.startsWith('"') ? JSON.parse(raw) : parseInt(raw, 10);
          }
          sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
          return;
        }
        try {
          const outcome = handleMcp(store, rawBody);
          if (outcome.body === '') {
            res.writeHead(outcome.status);
            res.end();
          } else {
            sendJson(res, outcome.status, outcome.body);
          }
        } catch (err) {
          if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        }
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
      }
    });
  });
}
