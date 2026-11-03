import { createHash } from 'node:crypto';
import { config } from '../src/config.js';

export const operatorId = '00000000-0000-4000-8000-000000000001';
export const otherUserId = '00000000-0000-4000-8000-000000000002';
export const operatorToken = 'test-only-operator-token-with-entropy-0001';
export const otherToken = 'test-only-other-user-token-with-entropy-0002';

export function configureTestAuth(): () => void {
  const users = config.authUsers;
  const secret = config.sessionSecret;
  config.authUsers = [{ id: operatorId, name: 'Operator fixture', tokenHash: createHash('sha256').update(operatorToken).digest() }, { id: otherUserId, name: 'Other fixture', tokenHash: createHash('sha256').update(otherToken).digest() }];
  config.sessionSecret = 'test-only-session-secret-not-a-deployment-credential';
  return () => { config.authUsers = users; config.sessionSecret = secret; };
}
