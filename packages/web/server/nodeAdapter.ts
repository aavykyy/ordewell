import type { IncomingMessage, ServerResponse } from 'http';
import type { Hono } from 'hono';
import { decideAdmission, type AdmissionContext } from './security/admission';

/**
 * How much of a request body the daemon will hold in memory. Plans, task edits
 * and conversation messages are small; a body past this is not one of ours.
 * Without a cap, the admission check below could never run before a browser's
 * multi-gigabyte `text/plain` POST was already buffered.
 */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

class BodyTooLargeError extends Error {}

/** A body over the cap, or a request the admission check refused, answered and closed. */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, message: string): void {
  const payload = JSON.stringify({ error: message });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // Nothing more is read from this request, so its connection cannot be reused.
    Connection: 'close',
  });
  res.end(payload, () => req.destroy());
}

/**
 * Read at most `max` bytes, leaving the stream paused once it is over. The
 * caller answers 413 and destroys the request; draining it instead would let a
 * browser keep the daemon busy for as long as it liked.
 */
function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        cleanup();
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(chunks.length > 0 ? Buffer.concat(chunks).toString() : undefined);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Bridges node's http server onto the Hono app. Kept out of `main.ts` so the
 * real request path — including the Host header the admission check reads — is
 * testable against a listening server.
 *
 * Admission runs here as well as in the Hono middleware, and first: the
 * middleware only sees the request after the body has been read, which is too
 * late to keep a browser from making the daemon buffer it.
 */
export function createRequestListener(app: Hono, admission: AdmissionContext, maxBodyBytes = MAX_BODY_BYTES) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const decision = decideAdmission({
      origin: req.headers.origin ?? null,
      host: req.headers.host ?? null,
      authorization: req.headers.authorization ?? null,
    }, admission);
    if (!decision.admit) {
      refuse(req, res, decision.status, decision.reason);
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      refuse(req, res, 413, `Request body must be at most ${maxBodyBytes} bytes.`);
      return;
    }

    let body: string | undefined;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        refuse(req, res, 413, `Request body must be at most ${maxBodyBytes} bytes.`);
        return;
      }
      throw err;
    }

    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) {
        if (Array.isArray(v)) v.forEach(vv => headers.append(k, vv));
        else headers.set(k, v as string);
      }
    }
    if (body && !headers.has('content-type')) headers.set('content-type', 'application/json');

    const webReq = new Request(url, {
      method: req.method || 'GET',
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    });

    try {
      const webRes = await app.fetch(webReq);
      res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
      if (webRes.body) {
        const reader = webRes.body.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? (err as Error).message : 'Internal server error' }));
      }
    }
  };
}
