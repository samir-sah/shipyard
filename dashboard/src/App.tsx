import { useEffect, useRef, useState, type FormEvent } from 'react';

type Project = {
  id: string; name: string; slug: string; repoUrl: string; branch: string;
  activeDeploymentId: string | null; createdAt: string;
};
type Deployment = {
  id: string; projectId: string; status: 'queued' | 'building' | 'failed' | 'deployed';
  commitSha: string | null; createdAt: string; startedAt: string | null;
  finishedAt: string | null; error: string | null; queueWaitMs: number | null;
  buildDurationMs: number | null; logTruncated: boolean;
};
type Log = { id: number; stream: string; message: string; createdAt: string };

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body?.error === 'string' ? body.error : body?.error?.message;
    throw new Error(detail || `Request failed (${response.status}).`);
  }
  return body as T;
}

function savedProject() {
  try { return localStorage.getItem('shipyard.project') || ''; } catch { return ''; }
}

function duration(value: number | null) {
  if (value === null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function timestamp(value: string) {
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Status({ value }: { value: Deployment['status'] }) {
  return <span className={`status ${value}`}><span aria-hidden="true" />{value}</span>;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(savedProject);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deploymentId, setDeploymentId] = useState('');
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [health, setHealth] = useState<'checking' | 'online' | 'unavailable'>('checking');
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [logError, setLogError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [follow, setFollow] = useState(true);
  const logBox = useRef<HTMLDivElement>(null);
  const project = projects.find(item => item.id === projectId);
  const deployment = deployments.find(item => item.id === deploymentId);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const [projectResult, healthResult] = await Promise.allSettled([
        request<{ projects: Project[] }>('/api/projects', { signal: controller.signal }),
        request('/health', { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      setHealth(healthResult.status === 'fulfilled' ? 'online' : 'unavailable');
      if (projectResult.status === 'fulfilled') {
        const next = projectResult.value.projects;
        setProjects(next);
        setProjectId(current => next.some(item => item.id === current) ? current : next[0]?.id || '');
        setError(current => current.startsWith('Could not load projects:') ? '' : current);
      } else {
        setError(`Could not load projects: ${projectResult.reason.message}`);
      }
      setLoading(false);
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    try { localStorage.setItem('shipyard.project', projectId); } catch { /* Storage can be disabled. */ }
    setDeployments([]);
    setDeploymentId('');
    setHistoryError('');
    if (!projectId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setHistoryLoading(true);
    async function poll() {
      try {
        const body = await request<{ deployments: Deployment[] }>(`/api/projects/${projectId}/deployments`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setDeployments(body.deployments);
        setDeploymentId(current => body.deployments.some(item => item.id === current) ? current : body.deployments[0]?.id || '');
        setHistoryError('');
      } catch (cause) {
        if (controller.signal.aborted) return;
        setHistoryError((cause as Error).message);
      }
      setHistoryLoading(false);
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, refresh]);

  useEffect(() => {
    setLogs([]);
    setLogError('');
    if (!deploymentId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    setLogsLoading(true);
    async function poll() {
      try {
        const body = await request<{ logs: Log[]; nextCursor: number }>(`/api/deployments/${deploymentId}/logs?after=${cursor}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        cursor = body.nextCursor;
        if (body.logs.length) setLogs(current => [...current, ...body.logs].slice(-1000));
        setLogError('');
      } catch (cause) {
        if (controller.signal.aborted) return;
        setLogError((cause as Error).message);
      }
      setLogsLoading(false);
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [deploymentId]);

  useEffect(() => {
    if (follow && logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [logs, follow]);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = await request<{ project: Project; deployment: Deployment }>('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, repoUrl }),
      });
      setProjects(current => [body.project, ...current]);
      setProjectId(body.project.id);
      setShowCreate(false);
      setName('');
      setRepoUrl('');
      setRefresh(current => current + 1);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  async function deploy() {
    if (!project) return;
    setDeploying(true);
    setError('');
    try {
      const body = await request<{ deployment: Deployment }>(`/api/projects/${project.id}/deployments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setDeployments(current => [body.deployment, ...current]);
      setDeploymentId(body.deployment.id);
      setRefresh(current => current + 1);
    } catch (cause) { setError((cause as Error).message); }
    finally { setDeploying(false); }
  }

  return <div className="app">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Shipyard home"><svg width="29" height="30" viewBox="0 0 29 30" fill="none" aria-hidden="true"><path d="M14.5 2 27 9v12l-12.5 7L2 21V9L14.5 2Z" stroke="currentColor" strokeWidth="2"/><path d="m2 9 12.5 7L27 9M14.5 16v12M8 5.5l13 7" stroke="currentColor" strokeWidth="2"/></svg><span>shipyard<span className="brand-dot">.</span></span></a>
      <span className="topbar-label">LOCAL DEPLOYMENT PLATFORM</span>
      <span className={`health ${health}`}><span aria-hidden="true" />{health === 'online' ? 'Services ready' : health === 'checking' ? 'Checking services' : 'Services unavailable'}</span>
    </header>

    <div className="workspace">
      <aside className="sidebar">
        <div className="section-label"><span>WORKSPACE</span><span className="count">{projects.length}</span></div>
        <div className="project-list" aria-label="Projects">
          {projects.map(item => <button key={item.id} className={`project-button ${item.id === projectId ? 'selected' : ''}`} onClick={() => setProjectId(item.id)} aria-pressed={item.id === projectId}>
            <span className="project-icon" aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span><span className="project-text"><strong>{item.name}</strong><small>{item.branch}</small></span><span className="project-arrow" aria-hidden="true">›</span>
          </button>)}
          {loading && <p className="muted sidebar-message">Loading projects…</p>}
          {!loading && !projects.length && <p className="muted sidebar-message">Your first launch starts here.</p>}
        </div>
        <button className="button new-project" onClick={() => setShowCreate(current => !current)} aria-expanded={showCreate || projects.length === 0}><span aria-hidden="true">+</span> New project</button>
        {(showCreate || (!loading && projects.length === 0)) && <form className="create-form" onSubmit={createProject}>
          <label htmlFor="project-name">Project name</label><input id="project-name" value={name} onChange={event => setName(event.target.value)} placeholder="My static site" required maxLength={80} autoComplete="off" />
          <label htmlFor="repo-url">Public GitHub repository</label><input id="repo-url" type="url" value={repoUrl} onChange={event => setRepoUrl(event.target.value)} placeholder="https://github.com/owner/repo" required autoComplete="url" />
          <p className="form-hint">Vite · <code>main</code> branch · npm lockfile</p>
          <button className="button primary" disabled={saving}>{saving ? 'Creating…' : 'Create & deploy'}</button>
        </form>}
        <div className="sidebar-footer"><span className="small-square" aria-hidden="true"/><span>SELF-HOSTED<br/><strong>Your code. Your infrastructure.</strong></span></div>
      </aside>

      <main>
        <div className="breadcrumb">Workspace <span aria-hidden="true">/</span> <span>{project?.name || 'Overview'}</span></div>
        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setRefresh(current => current + 1)}>Retry</button></div>}
        {project ? <>
          <div className="page-heading"><div><div className="eyebrow">PROJECT CONTROL ROOM</div><h1>{project.name}</h1><a className="repo-link" href={project.repoUrl.replace(/\.git$/, '')} target="_blank" rel="noopener noreferrer">{project.repoUrl.replace('https://github.com/', '').replace(/\.git$/, '')}<span aria-hidden="true">↗</span></a></div><button className="button primary deploy-button" onClick={deploy} disabled={deploying}><span aria-hidden="true">↑</span>{deploying ? 'Queueing…' : 'Deploy latest'}</button></div>

          <section className="project-summary" aria-label="Project details">
            <div className="summary-block"><span className="section-label">LIVE SITE</span>{project.activeDeploymentId ? <a className="site-link" href={`/sites/${project.slug}/`} target="_blank" rel="noopener noreferrer">Open deployment <span aria-hidden="true">↗</span></a> : <strong className="muted">Awaiting first deployment</strong>}<small className="route">/sites/{project.slug}/</small></div>
            <div className="summary-block"><span className="section-label">PRODUCTION BRANCH</span><strong><span className="branch-mark" aria-hidden="true">⑂</span>{project.branch}</strong><small>Public GitHub repository</small></div>
            <div className="summary-block recipe"><span className="section-label">BUILD RECIPE</span><strong>Vite / npm</strong><small><code>npm ci</code> · output <code>dist/</code></small></div>
          </section>

          <section className="history-section" aria-labelledby="history-title">
            <div className="section-heading"><h2 id="history-title">Deployments <span className="count">{deployments.length}</span></h2><span className="refresh-label"><span aria-hidden="true"/>Updates every 2 seconds</span></div>
            {historyError && <p className="inline-error" role="alert">Could not load deployment history: {historyError}</p>}
            <div className="table-wrap"><table><thead><tr><th>Deployment</th><th>Status</th><th>Queued at</th><th>Queue wait</th><th>Build time</th></tr></thead><tbody>
              {deployments.map(item => <tr key={item.id} className={item.id === deploymentId ? 'selected-row' : ''}><td><button className="deployment-select" onClick={() => setDeploymentId(item.id)} aria-pressed={item.id === deploymentId}><span className="deployment-hash">{item.id.slice(0, 8)}</span>{item.id === project.activeDeploymentId && <span className="active-tag">LIVE</span>}<small>{item.commitSha ? item.commitSha.slice(0, 7) : 'Awaiting checkout'}</small></button></td><td><Status value={item.status}/></td><td className="date-cell">{timestamp(item.createdAt)}</td><td className="mono">{duration(item.queueWaitMs)}</td><td className="mono">{duration(item.buildDurationMs)}</td></tr>)}
              {!deployments.length && <tr><td colSpan={5} className="table-empty">{historyLoading ? 'Loading deployments…' : 'No deployments yet. Deploy the latest commit to get started.'}</td></tr>}
            </tbody></table></div>
          </section>

          <section className="logs-section" aria-labelledby="logs-title"><div className="terminal-header"><div><span className="terminal-symbol" aria-hidden="true">&gt;_</span><h2 id="logs-title">Build logs</h2>{deployment && <code>{deployment.id.slice(0, 8)}</code>}</div><label className="follow-toggle"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)}/>Follow output</label></div>
            {deployment?.error && <div className="build-error" role="alert">{deployment.error}</div>}
            {logError && <p className="inline-error" role="alert">Could not load logs: {logError}</p>}
            <div className="terminal-body" ref={logBox} tabIndex={0} role="log" aria-label="Build output" aria-live="off">
              {logs.map(line => <div key={line.id} className={`log-line ${line.stream}`}><time dateTime={line.createdAt}>{new Date(line.createdAt).toLocaleTimeString(undefined, { hour12: false })}</time><pre>{line.message}</pre></div>)}
              {!logs.length && <p className="terminal-empty">{logsLoading ? 'Loading output…' : !deployment ? 'Select a deployment to inspect its build output.' : deployment.status === 'queued' ? 'Waiting for an available build worker…' : 'No build output recorded.'}</p>}
            </div><div className="terminal-footer"><span>{deployment ? `${deployment.status} · ${logs.length} log entries shown` : 'No deployment selected'}</span><span>{deployment?.logTruncated ? 'Log storage limit reached' : logs.length === 1000 ? 'Showing the latest 1,000 entries' : 'Incremental log polling'}</span></div>
          </section>
        </> : <section className="welcome"><span className="eyebrow">FROM REPOSITORY TO RELEASE</span><h1>Your next site,<br/><span>ready to launch.</span></h1><p>Connect a public Vite repository. Shipyard builds your code and serves a new deployment on your own infrastructure.</p><button className="button primary" onClick={() => { setShowCreate(true); document.getElementById('project-name')?.focus(); }}>Create your first project <span aria-hidden="true">↗</span></button><div className="welcome-flow"><span>01 <strong>Connect Git</strong></span><span>02 <strong>Build in Docker</strong></span><span>03 <strong>Go live</strong></span></div></section>}
        <footer className="main-footer"><span>SHIPYARD <span className="footer-slash">/</span> MILESTONE 01</span><span>Trusted repositories · Local workspace</span></footer>
      </main>
    </div>
  </div>;
}
