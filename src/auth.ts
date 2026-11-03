import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import { config } from './config.js';

export interface AuthIdentity { id: string; name: string }
const sessionDurationMs = 8 * 60 * 60 * 1000;

function tokenIdentity(token: unknown): AuthIdentity | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const digest = createHash('sha256').update(token).digest();
  let identity: AuthIdentity | null = null;
  for (const user of config.authUsers) {
    if (user.tokenHash.length === digest.length && timingSafeEqual(user.tokenHash, digest)) identity = { id: user.id, name: user.name };
  }
  return identity;
}

export function signSession(userId: string, now = Date.now()): string {
  if (Buffer.byteLength(config.sessionSecret) < 32) throw new Error('Session authentication is not configured');
  const user = config.authUsers.find(item => item.id === userId);
  if (!user) throw new Error('Session user is not configured');
  const keyId = createHash('sha256').update(user.tokenHash).digest('base64url');
  const payload = Buffer.from(JSON.stringify({ userId, keyId, expiresAt: now + sessionDurationMs })).toString('base64url');
  const signature = createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySession(value: string, now = Date.now()): AuthIdentity | null {
  if (Buffer.byteLength(config.sessionSecret) < 32 || value.length > 2048) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const signature = Buffer.from(parts[1], 'base64url');
  if (signature.toString('base64url') !== parts[1]) return null;
  const expected = createHmac('sha256', config.sessionSecret).update(parts[0]).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload || typeof payload.userId !== 'string' || typeof payload.keyId !== 'string' || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now || payload.expiresAt > now + sessionDurationMs) return null;
    const user = config.authUsers.find(item => item.id === payload.userId);
    return user && createHash('sha256').update(user.tokenHash).digest('base64url') === payload.keyId ? { id: user.id, name: user.name } : null;
  } catch { return null; }
}

function cookieSettings() {
  const secure = new URL(config.dashboardOrigin).protocol === 'https:';
  return { name: secure ? '__Host-shipyard_session' : 'shipyard_session', options: { httpOnly: true, sameSite: 'strict' as const, secure, path: '/' } };
}

function requestIdentity(req: Request): AuthIdentity | null {
  if (req.headers.authorization !== undefined) {
    const bearer = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(req.headers.authorization);
    return bearer ? tokenIdentity(bearer[1]) : null;
  }
  const { name } = cookieSettings();
  const matches = (req.headers.cookie ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  try { return verifySession(decodeURIComponent(matches[0].slice(name.length + 1))); }
  catch { return null; }
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const identity = requestIdentity(req);
  res.setHeader('Cache-Control', 'no-store');
  if (!identity) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  res.locals.user = identity;
  next();
};

export const sessionRouter = Router();
sessionRouter.get('/api/session', requireAuth, (_req, res) => { res.json({ user: res.locals.user }); });
sessionRouter.post('/api/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const identity = tokenIdentity(req.body && !Array.isArray(req.body) ? req.body.token : undefined);
  if (!identity) { res.status(401).json({ error: 'Invalid operator key' }); return; }
  if (Buffer.byteLength(config.sessionSecret) < 32) { res.status(503).json({ error: 'Session authentication is not configured' }); return; }
  const { name, options } = cookieSettings();
  res.cookie(name, signSession(identity.id), { ...options, maxAge: sessionDurationMs });
  res.json({ user: identity });
});
sessionRouter.delete('/api/session', (_req, res) => {
  const { name, options } = cookieSettings();
  res.setHeader('Cache-Control', 'no-store');
  res.clearCookie(name, options);
  res.status(204).end();
});
