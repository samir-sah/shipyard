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

test('separate-origin versions use the pinned host route', () => {
  const html = render('deployed', { project: { ...project, siteUrl: 'http://test-site.sites.localhost:3000/' } });
  assert.ok(html.includes(`href="http://test-site.sites.localhost:3000/_shipyard/v/${id}/"`));
  assert.ok(!html.includes('/versions/'));
});

test('expired and deleting versions keep history without actionable artifact links', () => {
  for (const artifactState of ['deleting', 'deleted'] as const) {
    const html = render('deployed', { deployment: { id, status: 'deployed', artifactState }, onRetain: () => {} });
    assert.ok(!html.includes('<a') && !html.includes('<button'));
    assert.ok(html.includes(artifactState === 'deleting' ? 'Expiring…' : 'Artifacts expired'));
  }
});

test('manual keep is explicit, reflects retained state and can protect an active version after a later deployment', () => {
  let html = render('deployed', { deployment: { id, status: 'deployed', retained: true, artifactState: 'available' }, onRetain: () => {} });
  assert.ok(html.includes('aria-pressed="true"'));
  assert.ok(html.includes('>Kept</button>'));
  html = render('deployed', { project: { ...project, activeDeploymentId: id }, onRetain: () => {} });
  assert.ok(html.includes('Keep deployment 11111111'));
  assert.ok(!html.includes('Restore deployment'));
});
