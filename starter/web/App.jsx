// The console. Every permission-gated element is derived from what the SERVER sends:
// org-level permissions from /auth/me for navigation, and each device row's own resolved
// set for row actions. There is no role-to-permission table anywhere under web/.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { http, refreshSession, ApiError } from './api.js';
import { LoginForm, InvitePage } from './auth-views.jsx';
import { DevicesView, PeopleView, GrantsView, SessionsView, AuditView, AdminView } from './views.jsx';

// Navigation: which card exists is decided by ONE org-level permission each (the union
// across devices, as the server resolves it). Present or absent, never disabled.
const NAV = [
  { key: 'devices', label: 'Devices', permission: 'device:list' },
  { key: 'people', label: 'People', permission: 'user:read' },
  { key: 'grants', label: 'Grants', permission: 'user:read' },
  { key: 'sessions', label: 'Sessions', permission: 'session:view' },
  { key: 'audit', label: 'Audit log', permission: 'audit:read' },
  { key: 'admin', label: 'Organization', permission: 'org:update', alsoIf: 'org:delete' },
];

const allowed = (perms, key) => perms?.[key]?.effect === 'allow';

export function App() {
  const invite = /^\/invite\/([^/]+)\/?$/.exec(window.location.pathname);
  const [session, setSession] = useState(null); // { token, orgId, role, org, orgs, user }
  const [booting, setBooting] = useState(!invite);
  const [notice, setNotice] = useState(null);
  const [inviteToken, setInviteToken] = useState(invite ? decodeURIComponent(invite[1]) : null);

  // A reload restores the session from the refresh cookie; nothing is read from storage.
  useEffect(() => {
    if (invite) return;
    refreshSession().then(setSession).catch(() => {}).finally(() => setBooting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (inviteToken) {
    return (
      <InvitePage
        token={inviteToken}
        onDone={(message) => {
          window.history.replaceState(null, '', '/');
          setInviteToken(null);
          setNotice(message);
        }}
      />
    );
  }
  if (booting) return <div className="boot" aria-busy="true">Loading…</div>;
  if (!session) return <LoginForm notice={notice} onLogin={setSession} />;
  return <Console session={session} setSession={setSession} onLogout={() => { setSession(null); setNotice(null); }} />;
}

function Console({ session, setSession, onLogout }) {
  const [me, setMe] = useState(null);
  const [view, setView] = useState('devices');
  const [toast, setToast] = useState(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Every API call goes through here. A 401 TOKEN_STALE means a role or grant changed:
  // swap the refresh cookie for a new token for the SAME org and retry once.
  const api = useCallback(async (method, path, body) => {
    try {
      return await http(method, path, { token: sessionRef.current.token, body });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOKEN_STALE') {
        const fresh = await refreshSession(sessionRef.current.orgId);
        sessionRef.current = fresh;
        setSession(fresh);
        return http(method, path, { token: fresh.token, body });
      }
      throw err;
    }
  }, [setSession]);

  const loadMe = useCallback(() => api('GET', '/auth/me').then(setMe).catch(() => setMe(null)), [api]);
  useEffect(() => { setMe(null); loadMe(); }, [session.orgId, session.token, loadMe]);

  const say = useCallback((text, tone = 'ok') => {
    setToast({ text, tone, at: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Switching org mints a new token scoped to that org. Views are keyed by org so nothing
  // from the previous org survives in component state.
  const switchOrg = async (orgId) => {
    if (orgId === session.orgId) return;
    try {
      const next = await http('POST', '/auth/token', { token: session.token, body: { orgId } });
      setView('devices');
      setSession(next);
    } catch (err) {
      say(err.message, 'bad');
    }
  };

  const createOrg = async () => {
    const name = window.prompt('Name the new organization');
    if (!name || !name.trim()) return;
    try {
      const org = await api('POST', '/orgs', { name: name.trim() });
      const next = await http('POST', '/auth/token', { token: session.token, body: { orgId: org.id } });
      setView('devices');
      setSession(next);
      say(`Created ${org.name}. You are its owner.`);
    } catch (err) {
      say(err.message, 'bad');
    }
  };

  const logout = async () => {
    try { await http('POST', '/auth/logout', { token: session.token }); } catch { /* ignore */ }
    onLogout();
  };

  const perms = me?.permissions;
  const nav = useMemo(
    () => NAV.filter((n) => allowed(perms, n.permission) || (n.alsoIf && allowed(perms, n.alsoIf))),
    [perms]
  );
  const current = nav.find((n) => n.key === view) ? view : nav[0]?.key;
  const org = session.org;

  const props = { api, orgId: session.orgId, userId: session.user.id, perms, say, refreshMe: loadMe };

  return (
    <div
      className={`shell theme-${org.theme}`}
      data-testid="app-shell"
      data-org-id={session.orgId}
      data-org-theme={org.theme}
    >
      <aside className="rail">
        <div className="orgplate">
          <div className="orgname">{org.name}</div>
          <div className="whoami">
            <span className="username">{session.user.name}</span>
            <span className="rolepill" data-testid="active-role">{session.role}</span>
          </div>
        </div>

        <nav className="orgs" aria-label="Organizations">
          {session.orgs.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`orgchip theme-${o.theme}${o.id === session.orgId ? ' current' : ''}`}
              data-testid="org-option"
              data-org-id={o.id}
              aria-current={o.id === session.orgId ? 'true' : undefined}
              onClick={() => switchOrg(o.id)}
            >
              <span className="swatch" aria-hidden="true" />
              <span className="chipname">{o.name}</span>
              <span className="chiprole">{o.role}</span>
            </button>
          ))}
          <button type="button" className="ghost" data-testid="create-org" onClick={createOrg}>
            New organization
          </button>
        </nav>

        <nav className="cards" aria-label="Sections">
          {perms && nav.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`navcard${current === n.key ? ' on' : ''}`}
              data-testid={`nav-${n.key}`}
              data-permission={n.permission}
              data-state="unlocked"
              onClick={() => setView(n.key)}
            >
              {n.label}
            </button>
          ))}
        </nav>

        <button type="button" className="ghost signout" onClick={logout}>Sign out</button>
      </aside>

      <main className="stage" key={`${session.orgId}:${current}`}>
        {!perms && <p className="muted">Loading your permissions…</p>}
        {perms && current === 'devices' && <DevicesView {...props} />}
        {perms && current === 'people' && <PeopleView {...props} />}
        {perms && current === 'grants' && <GrantsView {...props} />}
        {perms && current === 'sessions' && <SessionsView {...props} />}
        {perms && current === 'audit' && <AuditView {...props} />}
        {perms && current === 'admin' && (
          <AdminView {...props} org={org} onRenamed={async () => {
            const next = await http('POST', '/auth/token', { token: sessionRef.current.token, body: { orgId: session.orgId } });
            setSession(next);
          }} onDeleted={async () => {
            try { setSession(await refreshSession()); } catch { onLogout(); }
          }} />
        )}
        {perms && nav.length === 0 && <p className="muted">You have no access in this organization.</p>}
      </main>

      {toast && <div className={`toast ${toast.tone}`} role="status">{toast.text}</div>}
    </div>
  );
}