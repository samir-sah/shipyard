export class InputError extends Error {}

export function parseProject(input: unknown): { name: string; repoUrl: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Expected a JSON object');
  const { name, repoUrl } = input as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new InputError('Name must contain 1–80 characters');
  }
  if (typeof repoUrl !== 'string' || repoUrl.length > 300) throw new InputError('Enter a public GitHub HTTPS repository URL');
  let url: URL;
  try { url = new URL(repoUrl); } catch { throw new InputError('Enter a public GitHub HTTPS repository URL'); }
  const match = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !match || ['.', '..'].includes(match[2])) {
    throw new InputError('Only public https://github.com/owner/repository URLs are supported');
  }
  return { name: name.trim(), repoUrl: `https://github.com/${match[1]}/${match[2]}.git` };
}

export function requireUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new InputError('Invalid ID');
  return value;
}

export function artifactKey(value: string): string {
  if (!value || Buffer.byteLength(value) > 1024 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.split('/').some(part => part === '.' || part === '..' || !part)) {
    throw new InputError('Invalid artifact path');
  }
  return value;
}

export function logCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InputError('Invalid log cursor');
  return Number(value);
}
