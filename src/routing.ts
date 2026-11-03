import type { RequestHandler } from 'express';
import { config } from './config.js';

export function siteUrl(slug: string): string {
  const url = new URL(config.siteBaseUrl);
  url.hostname = `${slug}.${url.hostname}`;
  return url.href;
}

export const routeHost: RequestHandler = (req, res, next) => {
  const header = req.headers.host ?? '';
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(header)) { res.status(400).send('Invalid host'); return; }
  const host = header.split(':')[0].toLowerCase().replace(/\.$/, '');
  const base = new URL(config.siteBaseUrl).hostname;
  if (host.endsWith(`.${base}`)) {
    const slug = host.slice(0, -(base.length + 1));
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) { res.status(404).send('Site not found'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.status(405).send('Sites are read only'); return; }
    if (!req.url.startsWith('/')) { res.status(400).send('Invalid request path'); return; }
    const [path] = req.url.split('?');
    const search = req.url.slice(path.length);
    if (path === '/api' || path.startsWith('/api/') || path === '/health') { res.status(404).send('Not found'); return; }
    res.locals.siteSlug = slug;
    if (path.startsWith('/_shipyard/')) {
      const version = /^\/_shipyard\/v\/([a-f0-9-]{36})(\/.*)?$/i.exec(path);
      if (!version) { res.status(404).send('Version not found'); return; }
      req.url = `/versions/${slug}/${version[1]}${version[2] ?? ''}${search}`;
    } else req.url = `/sites/${slug}${path}${search}`;
    next();
    return;
  }
  if (![new URL(config.dashboardOrigin).hostname, 'localhost', '127.0.0.1'].includes(host)) { res.status(404).send('Unknown host'); return; }
  next();
};
