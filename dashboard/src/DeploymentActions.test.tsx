import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeploymentActions } from './App';

const id = '11111111-1111-4111-8111-111111111111';
const project = { slug: 'test-site', activeDeploymentId: 'another-deployment' };

function render(status: 'queued' | 'building' | 'failed' | 'deployed', options = {}) {
  return renderToStaticMarkup(<DeploymentActions deployment={{ id, status }} project={project} pending={false} restoring={false} onRestore={() => {}} {...options}/>);
}

test('only completed successful deployments expose retained versions and restore controls', () => {
  for (const status of ['queued', 'building', 'failed'] as const) assert.equal(render(status), '');
  const html = render('deployed');
  assert.ok(html.includes(`href="/versions/test-site/${id}/"`));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('Restore deployment 11111111'));
});

test('the active deployment links to its immutable version without a restore button', () => {
  const html = render('deployed', { project: { ...project, activeDeploymentId: id } });
  assert.ok(html.includes(`href="/versions/test-site/${id}/"`));
  assert.ok(!html.includes('<button'));
});

test('restore controls stay disabled during a pending action and identify the restoring version', () => {
  const html = render('deployed', { pending: true, restoring: true });
  assert.ok(html.includes('disabled=""'));
  assert.ok(html.includes('Restoring…'));
});
