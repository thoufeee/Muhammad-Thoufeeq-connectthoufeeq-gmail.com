// The six sections. Each view fetches its own data when it mounts, so switching sections
// (or orgs) always shows what the server says now.

import React, { useCallback, useEffect, useState } from 'react';

const allowed = (perms, key) => perms?.[key]?.effect === 'allow';

// How a refusal explains itself. An absent button can't say anything, so rows carry a short
// note when something was taken away on purpose (explicit_deny) — "nobody granted it"
// (implicit) is the normal state and gets no note.
//
// Control and Terminal are present exactly when the row holds that permission (the console
// contract). Watch additionally needs session:start on the row: device:view is true on every
// row you can see at all, so a Watch keyed on it alone would appear everywhere and fail when
// clicked. The seed fixture says the viewer gets "a working View button on lab-mac-01 and
// nowhere else", which is only true with the extra check.
const ACTIONS = [
  { permission: 'device:view', mode: 'view', label: 'Watch', alsoNeeds: 'session:start' },
  { permission: 'device:control', mode: 'control', label: 'Control' },
  { permission: 'device:terminal', mode: 'terminal', label: 'Terminal' },
];
const shows = (perms, a) => allowed(perms, a.permission) && (!a.alsoNeeds || allowed(perms, a.alsoNeeds));

function useLoad(loader, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const run = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    return loader()
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => setState({ data: null, error, loading: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return [state, run];
}

function Failure({ error }) {
  return <p className="formerror" role="alert">{error.message}</p>;
}

function Header({ title, children }) {
  return (
    <header className="stagehead">
      <h2>{title}</h2>
      <div className="headactions">{children}</div>
    </header>
  );
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

// ---------------------------------------------------------------------------
export function DevicesView({ api, orgId, say }) {
  const [{ data, error, loading }] = useLoad(() => api('GET', `/orgs/${orgId}/devices`), [orgId]);

  const start = async (device, mode) => {
    try {
      await api('POST', `/orgs/${orgId}/sessions`, { deviceId: device.id, mode });
      say(`Started a ${mode} session on ${device.name}.`);
    } catch (err) {
      const why = {
        missing_permission: 'You can’t open sessions in this organization.',
        missing_device_permission: `You can’t do that on ${device.name}.`,
      }[err.reason];
      say(err.code === 'DEVICE_BUSY' ? `${device.name} is already in an exclusive session.` : (why ?? err.message), 'bad');
    }
  };

  if (error) return <Failure error={error} />;
  if (loading && !data) return <p className="muted">Loading devices…</p>;
  const devices = data.devices;
  const isBlocked = (d, a) => d.permissions[a.permission]?.reason === 'explicit_deny';
  // A rule that blocks an action on every row is an org-wide rule: say it once, not per row.
  const blockedEverywhere = devices.length > 0 ? ACTIONS.filter((a) => devices.every((d) => isBlocked(d, a))) : [];

  return (
    <section>
      <Header title="Devices" />
      {blockedEverywhere.length > 0 && (
        <p className="lockednote banner">
          {blockedEverywhere.map((a) => a.label).join(', ')} is blocked for you on every device in this organization by a rule.
        </p>
      )}
      {devices.length === 0 ? (
        <div className="empty" data-testid="devices-empty">
          <p>No devices you can see in this organization yet.</p>
          <p className="muted">Devices appear here once they are enrolled and you’re allowed to view them.</p>
        </div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th>Device</th><th>Kind</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {devices.map((d) => {
                const blocked = ACTIONS.filter((a) => isBlocked(d, a) && !blockedEverywhere.includes(a));
                return (
                  <tr key={d.id} data-testid="device-row" data-device-id={d.id}>
                    <td className="strong">{d.name}</td>
                    <td>{d.kind}</td>
                    <td><span className={`dot ${d.online ? 'up' : 'down'}`} />{d.online ? 'Online' : 'Offline'}</td>
                    <td>
                      <div className="rowactions">
                        {ACTIONS.filter((a) => shows(d.permissions, a)).map((a) => (
                          <button key={a.permission} type="button" className="act"
                                  data-permission={a.permission} data-state="unlocked"
                                  onClick={() => start(d, a.mode)}>
                            {a.label}
                          </button>
                        ))}
                      </div>
                      {blocked.length > 0 && (
                        <div className="lockednote">
                          {blocked.map((a) => a.label).join(', ')} blocked by a rule for you
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
export function PeopleView({ api, orgId, userId, perms, say }) {
  const [{ data, error, loading }, reload] = useLoad(() => Promise.all([
    api('GET', `/orgs/${orgId}/members`),
    api('GET', `/orgs/${orgId}/roles`),
  ]), [orgId]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [inviteLink, setInviteLink] = useState(null);

  const canRole = allowed(perms, 'user:role:update');
  const canRemove = allowed(perms, 'user:remove');
  const canInvite = allowed(perms, 'user:invite');

  const act = async (fn, okText) => {
    try { await fn(); say(okText); reload(); } catch (err) { say(err.message, 'bad'); }
  };

  const invite = async (e) => {
    e.preventDefault();
    try {
      const inv = await api('POST', `/orgs/${orgId}/invites`, { email: inviteEmail, role: inviteRole });
      setInviteLink(`${window.location.origin}/invite/${inv.inviteToken}`);
      setInviteEmail('');
      say(`Invite created for ${inv.email}.`);
    } catch (err) { say(err.message, 'bad'); }
  };

  if (error) return <Failure error={error} />;
  if (loading && !data) return <p className="muted">Loading people…</p>;
  const [{ members }, { roles }] = data;

  return (
    <section>
      <Header title="People" />
      <div className="tablewrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id} data-testid="user-row" data-user-id={m.user_id}>
                <td className="strong">{m.name}{m.user_id === userId && <span className="muted"> (you)</span>}</td>
                <td>{m.email}</td>
                <td>
                  {canRole && m.user_id !== userId ? (
                    <select aria-label={`Role for ${m.name}`} value={m.role}
                            data-permission="user:role:update" data-state="unlocked"
                            onChange={(e) => act(() => api('PATCH', `/orgs/${orgId}/members/${m.user_id}`, { role: e.target.value }),
                              `${m.name} is now ${e.target.value}.`)}>
                      {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </select>
                  ) : <span className="rolepill">{m.role}</span>}
                </td>
                <td>{m.status}</td>
                <td className="rowactions">
                  {canRemove && m.user_id !== userId && (m.status === 'active' ? (
                    <button type="button" className="act" data-permission="user:remove" data-state="unlocked"
                            onClick={() => act(() => api('POST', `/orgs/${orgId}/members/${m.user_id}/suspend`), `${m.name} is suspended.`)}>
                      Suspend
                    </button>
                  ) : (
                    <button type="button" className="act" data-permission="user:remove" data-state="unlocked"
                            onClick={() => act(() => api('DELETE', `/orgs/${orgId}/members/${m.user_id}/suspend`), `${m.name} is reinstated.`)}>
                      Reinstate
                    </button>
                  ))}
                  {canRemove && m.user_id !== userId && (
                    <button type="button" className="act danger" data-permission="user:remove" data-state="unlocked"
                            onClick={() => window.confirm(`Remove ${m.name} from this organization?`) &&
                              act(() => api('DELETE', `/orgs/${orgId}/members/${m.user_id}`), `${m.name} was removed.`)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canInvite && (
        <form className="panel" onSubmit={invite}>
          <h3>Invite someone</h3>
          <div className="formrow">
            <label>Email<input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} /></label>
            <label>Role
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
            </label>
            <button className="primary" type="submit" data-permission="user:invite" data-state="unlocked">Create invite</button>
          </div>
          {inviteLink && (
            <p className="notice">Send this link to them. It works once and expires in 7 days:<br />
              <code className="copyable">{inviteLink}</code></p>
          )}
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
export function GrantsView({ api, orgId, userId, perms, say }) {
  const [{ data, error, loading }, reload] = useLoad(() => api('GET', `/orgs/${orgId}/grants`), [orgId]);
  const [creating, setCreating] = useState(false);
  const canCreate = allowed(perms, 'grant:create');
  const canRevoke = allowed(perms, 'grant:revoke');

  const revoke = async (g) => {
    try {
      await api('DELETE', `/orgs/${orgId}/grants/${g.id}`);
      say('Grant revoked. Sessions already running keep going; new ones follow the change.');
      reload();
    } catch (err) { say(err.message, 'bad'); }
  };

  if (error) return <Failure error={error} />;
  if (loading && !data) return <p className="muted">Loading grants…</p>;

  return (
    <section>
      <Header title="Grants">
        {canCreate && !creating && (
          <button type="button" className="primary" data-testid="new-grant"
                  data-permission="grant:create" data-state="unlocked" onClick={() => setCreating(true)}>
            New grant
          </button>
        )}
      </Header>

      {creating && (
        <GrantForm api={api} orgId={orgId} userId={userId}
                   onCancel={() => setCreating(false)}
                   onCreated={() => { setCreating(false); say('Grant created.'); reload(); }} />
      )}

      {data.grants.length === 0 ? (
        <div className="empty"><p>No grants in this organization.</p>
          <p className="muted">Everyone has exactly what their role gives them.</p></div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Effect</th><th>Person</th><th>Scope</th><th>Permissions</th><th>Window</th><th /></tr></thead>
            <tbody>
              {data.grants.map((g) => (
                <tr key={g.id} data-testid="grant-row" data-effect={g.effect}>
                  <td><span className={`effect ${g.effect}`}>{g.effect === 'allow' ? 'Allow' : 'Deny'}</span></td>
                  <td className="strong">{g.user_name}</td>
                  <td>{g.device_name ?? 'Whole organization'}</td>
                  <td><div className="permlist">{g.permissions.map((p) => <code key={p}>{p}</code>)}</div></td>
                  <td className="muted">
                    {g.starts_at || g.expires_at ? `${when(g.starts_at)} to ${when(g.expires_at)}` : 'No end date'}
                    {!g.active && <span className="rolepill">not active now</span>}
                  </td>
                  <td>
                    {canRevoke && (
                      <button type="button" className="act danger" data-testid="revoke-grant"
                              data-permission="grant:revoke" data-state="unlocked" onClick={() => revoke(g)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function GrantForm({ api, orgId, userId, onCancel, onCreated }) {
  const [{ data, error }] = useLoad(() => Promise.all([
    api('GET', `/orgs/${orgId}/members`),
    api('GET', `/orgs/${orgId}/devices`),
    api('GET', `/orgs/${orgId}/permissions`),
  ]), [orgId]);
  const [target, setTarget] = useState('');
  const [device, setDevice] = useState('');
  const [effect, setEffect] = useState('allow');
  const [chosen, setChosen] = useState([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [formError, setFormError] = useState(null);

  if (error) return <Failure error={error} />;
  if (!data) return <p className="muted">Loading form…</p>;
  const [{ members }, { devices }, { permissions }] = data;
  const people = members.filter((m) => m.user_id !== userId && m.status === 'active');

  const toggle = (key) => setChosen((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));

  const submit = async (e) => {
    e.preventDefault();
    setFormError(null);
    if (!target) return setFormError('Choose who the grant is for.');
    if (chosen.length === 0) return setFormError('Choose at least one permission.');
    try {
      await api('POST', `/orgs/${orgId}/grants`, {
        userId: target, deviceId: device || null, effect, permissions: chosen,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      onCreated();
    } catch (err) {
      setFormError({
        scope_mismatch: 'You can only grant permissions you hold yourself at that scope.',
        expired_grant: 'That end date is already in the past.',
      }[err.reason] ?? err.message);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h3>New grant</h3>
      <div className="formrow">
        <label>Person
          <select data-testid="grant-user" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {people.map((m) => <option key={m.user_id} value={m.user_id}>{m.name} ({m.role})</option>)}
          </select>
        </label>
        <label>Scope
          <select data-testid="grant-device" value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="">Whole organization</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label>Effect
          <select data-testid="grant-effect" value={effect} onChange={(e) => setEffect(e.target.value)}>
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
        </label>
        <label>Ends (optional)
          <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </label>
      </div>
      <fieldset className="permpick">
        <legend>Permissions</legend>
        {permissions.map((p) => (
          <label key={p.key} className="check" title={p.description}>
            <input type="checkbox" data-permission-key={p.key}
                   checked={chosen.includes(p.key)} onChange={() => toggle(p.key)} />
            <code>{p.key}</code>
          </label>
        ))}
      </fieldset>
      {formError && <p className="formerror" role="alert">{formError}</p>}
      <div className="formrow">
        <button className="primary" type="submit" data-testid="grant-submit">Create grant</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
export function SessionsView({ api, orgId, userId, perms, say }) {
  const [{ data, error, loading }, reload] = useLoad(() => api('GET', `/orgs/${orgId}/sessions`), [orgId]);
  const canTerminate = allowed(perms, 'session:terminate');

  const end = async (s) => {
    try { await api('DELETE', `/sessions/${s.id}`); say('Session ended.'); reload(); }
    catch (err) { say(err.message, 'bad'); }
  };

  if (error) return <Failure error={error} />;
  if (loading && !data) return <p className="muted">Loading sessions…</p>;

  return (
    <section>
      <Header title="Sessions" />
      {data.sessions.length === 0 ? (
        <div className="empty"><p>No sessions yet.</p>
          <p className="muted">Start one from a device row in Devices.</p></div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Device</th><th>Person</th><th>Mode</th><th>State</th><th>Started</th><th>Ends by</th><th /></tr></thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.id}>
                  <td className="strong">{s.device_name}</td>
                  <td>{s.user_name}</td>
                  <td>{s.mode}</td>
                  <td>{s.state}{s.end_reason && <span className="muted"> ({s.end_reason.replace(/_/g, ' ')})</span>}</td>
                  <td className="muted">{when(s.started_at)}</td>
                  <td className="muted">{s.state === 'ended' ? when(s.ended_at) : when(s.expires_at)}</td>
                  <td>
                    {s.state !== 'ended' && (s.user_id === userId || canTerminate) && (
                      <button type="button" className="act danger" onClick={() => end(s)}>
                        {s.user_id === userId ? 'Stop' : 'Terminate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
export function AuditView({ api, orgId }) {
  const [{ data, error, loading }] = useLoad(() => api('GET', `/orgs/${orgId}/audit?limit=200`), [orgId]);
  if (error) return <Failure error={error} />;
  if (loading && !data) return <p className="muted">Loading the audit log…</p>;
  return (
    <section>
      <Header title="Audit log" />
      <div className="tablewrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Result</th><th>Reason</th></tr></thead>
          <tbody>
            {data.events.map((e) => (
              <tr key={e.id} className={e.result === 'deny' ? 'denied' : undefined}>
                <td className="muted">{when(e.at)}</td>
                <td>{e.actor_name ?? e.actor_id ?? 'system'}</td>
                <td><code>{e.action}</code></td>
                <td className="muted">{e.target_id ?? ''}</td>
                <td><span className={`effect ${e.result}`}>{e.result === 'allow' ? 'Allowed' : 'Denied'}</span></td>
                <td className="muted">{e.reason_code ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
export function AdminView({ api, orgId, perms, org, say, onRenamed, onDeleted }) {
  const rename = async () => {
    const name = window.prompt('New name for this organization', org.name);
    if (!name || !name.trim() || name.trim() === org.name) return;
    try { await api('PATCH', `/orgs/${orgId}`, { name: name.trim() }); say('Organization renamed.'); await onRenamed(); }
    catch (err) { say(err.message, 'bad'); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${org.name}? Every live session in it ends, and nobody can use it again.`)) return;
    try { await api('DELETE', `/orgs/${orgId}`); await onDeleted(); }
    catch (err) { say(err.message, 'bad'); }
  };

  return (
    <section>
      <Header title="Organization" />
      <div className="panel">
        <dl className="facts">
          <dt>Name</dt><dd>{org.name}</dd>
          <dt>Theme</dt><dd>{org.theme}</dd>
        </dl>
        <div className="formrow">
          {allowed(perms, 'org:update') && (
            <button type="button" className="primary" data-testid="rename-org"
                    data-permission="org:update" data-state="unlocked" onClick={rename}>
              Rename organization
            </button>
          )}
          {allowed(perms, 'org:delete') && (
            <button type="button" className="act danger" data-testid="delete-org"
                    data-permission="org:delete" data-state="unlocked" onClick={remove}>
              Delete organization
            </button>
          )}
        </div>
      </div>
    </section>
  );
}