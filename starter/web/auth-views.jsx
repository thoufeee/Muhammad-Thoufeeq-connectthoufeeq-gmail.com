// Sign-in and invite redemption. Failures say what went wrong, in words, without ever
// revealing whether an account exists.

import React, { useEffect, useState } from 'react';
import { http, ApiError } from './api.js';

export function LoginForm({ onLogin, notice }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const missing = [!email.trim() && 'email', !password && 'password'].filter(Boolean);
    if (missing.length) {
      setError(`Enter your ${missing.join(' and ')} to sign in.`);
      return;
    }
    setBusy(true);
    try {
      onLogin(await http('POST', '/auth/login', { body: { email: email.trim(), password } }));
    } catch (err) {
      // The server answers "invalid email or password" for both a wrong password and an
      // unknown account. The screen must not be more specific than that.
      setError(err instanceof ApiError && err.status === 401
        ? 'Invalid email or password. Check both and try again.'
        : err.status === 403 ? 'This account is not an active member of any organization.'
        : 'Sign-in failed. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gatecard" data-testid="login-form" onSubmit={submit} noValidate>
        <h1 className="brand">RemoteOps</h1>
        <p className="muted">Sign in to reach the devices your organizations share with you.</p>
        {notice && <p className="notice" role="status">{notice}</p>}
        <label>
          Email
          <input data-testid="login-email" type="email" autoComplete="username"
                 value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input data-testid="login-password" type="password" autoComplete="current-password"
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="formerror" data-testid="login-error" role="alert">{error}</p>}
        <button className="primary" data-testid="login-submit" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export function InvitePage({ token, onDone }) {
  const [invite, setInvite] = useState(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    http('GET', `/invites/${encodeURIComponent(token)}`).then(setInvite).catch(() => setFailed(true));
  }, [token]);

  const accept = async (e) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Enter your name.');
    if (password.length < 8) return setError('Choose a password of at least 8 characters.');
    try {
      await http('POST', `/invites/${encodeURIComponent(token)}/accept`, { body: { name: name.trim(), password } });
      onDone('Your account is ready. Sign in with the email and password you just chose.');
    } catch (err) {
      setError(err.status === 409 ? 'This invite has already been used.' : err.message);
    }
  };

  if (failed) {
    // Deliberately generic: an unknown, expired and revoked link all read the same here.
    return (
      <div className="gate">
        <div className="gatecard" data-testid="invite-error" role="alert">
          <h1 className="brand">RemoteOps</h1>
          <p>This invite link can’t be used. It may have expired, been cancelled or already been accepted.</p>
          <p className="muted">Ask the person who invited you to send a new one.</p>
          <a href="/">Go to sign in</a>
        </div>
      </div>
    );
  }
  if (!invite) return <div className="boot" aria-busy="true">Checking your invite…</div>;

  return (
    <div className="gate">
      <form className="gatecard" onSubmit={accept} noValidate>
        <h1 className="brand">RemoteOps</h1>
        <p>You’ve been invited to <strong>{invite.orgName}</strong> as{' '}
          <span className="rolepill" data-testid="invite-role">{invite.role}</span>
        </p>
        <label>
          Email
          <input data-testid="invite-email" value={invite.email} readOnly />
        </label>
        <label>
          Your name
          <input data-testid="invite-name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Choose a password
          <input data-testid="invite-password" type="password" autoComplete="new-password"
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="formerror" role="alert">{error}</p>}
        <button className="primary" data-testid="invite-submit" type="submit">Accept invite</button>
      </form>
    </div>
  );
}