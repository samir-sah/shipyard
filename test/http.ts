import { request } from 'node:http';

// Node fetch may replace Host; virtual-host tests need the HTTP client's explicit header support.
export function httpFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers).entries()) }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('error', reject);
      incoming.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const status = incoming.statusCode ?? 500;
        resolve(new Response([204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks)), { status, headers }));
      });
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(15_000, () => outgoing.destroy(new Error('Test HTTP request timed out')));
    if (options.body !== undefined && options.body !== null) {
      if (typeof options.body !== 'string') { outgoing.destroy(new Error('Test HTTP helper expects a text body')); return; }
      outgoing.write(options.body);
    }
    outgoing.end();
  });
}
