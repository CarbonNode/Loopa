import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client.ts';
import { useApp } from '../state/store.tsx';
import './AuthScreen.css';

type Mode = 'login' | 'join' | 'setup';

/** Read a query param without pulling in a router for two screens. */
function readParam(name: string): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(name) ?? '';
}

export function AuthScreen() {
  const { setupPending, signIn } = useApp();

  // The mode is dictated by state and URL, not by the user: an unclaimed
  // instance can only be set up, and an invite link should land on Join.
  const [mode, setMode] = useState<Mode>(() => {
    if (setupPending) return 'setup';
    return readParam('code') ? 'join' : 'login';
  });

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState(() => readParam('code'));
  const [token, setToken] = useState(() => readParam('token'));

  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (setupPending) setMode('setup');
  }, [setupPending]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);

      try {
        const result =
          mode === 'setup'
            ? await api.setup({ token: token.trim(), username, password, displayName })
            : mode === 'join'
              ? await api.join({ code: code.trim(), username, password, displayName })
              : await api.login({ username, password });

        // Clear the invite/setup token from the address bar so it is not left
        // in history or copied out of the URL later.
        if (window.location.search) {
          window.history.replaceState({}, '', window.location.pathname);
        }

        signIn(result.user);
      } catch (caught) {
        if (caught instanceof ApiError) setError({ message: caught.message, hint: caught.hint });
        else setError({ message: 'Something went wrong. Try again.', hint: null });
      } finally {
        setBusy(false);
      }
    },
    [mode, token, code, username, password, displayName, signIn],
  );

  const copy = {
    setup: {
      title: 'Set up Loopa',
      body: 'Create the first account. This one gets admin rights, so it can invite everyone else.',
      submit: 'Create admin account',
    },
    join: {
      title: 'Join this Loopa',
      body: "You've been invited. Pick a username and a password you'll remember.",
      submit: 'Create account',
    },
    login: {
      title: 'Welcome back',
      body: 'Sign in to get to the clips.',
      submit: 'Sign in',
    },
  }[mode];

  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="auth__brand">
          <span className="auth__logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="26" height="26">
              <path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              <path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" />
            </svg>
          </span>
          <span className="auth__wordmark">Loopa</span>
        </div>

        <header className="auth__header">
          <h1 className="auth__title">{copy.title}</h1>
          <p className="auth__body">{copy.body}</p>
        </header>

        <form className="auth__form" onSubmit={submit}>
          {mode === 'setup' && (
            <div className="field">
              <label className="field__label" htmlFor="auth-token">
                Setup token
              </label>
              <input
                id="auth-token"
                className="input"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="From the server log"
                autoComplete="off"
                spellCheck={false}
                required
              />
              <p className="auth__hint">
                Printed to the server log on startup. Run <code>docker logs loopa</code> if you need it again.
              </p>
            </div>
          )}

          {mode === 'join' && (
            <div className="field">
              <label className="field__label" htmlFor="auth-code">
                Invite code
              </label>
              <input
                id="auth-code"
                className="input auth__code"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="XXXX-XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
          )}

          <div className="field">
            <label className="field__label" htmlFor="auth-username">
              Username
            </label>
            <input
              id="auth-username"
              className="input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete={mode === 'login' ? 'username' : 'off'}
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus={mode === 'login'}
            />
          </div>

          {mode !== 'login' && (
            <div className="field">
              <label className="field__label" htmlFor="auth-display">
                Display name <span className="auth__optional">optional</span>
              </label>
              <input
                id="auth-display"
                className="input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={username || 'How your name appears'}
                autoComplete="name"
              />
            </div>
          )}

          <div className="field">
            <label className="field__label" htmlFor="auth-password">
              Password
            </label>
            <input
              id="auth-password"
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'login' ? undefined : 10}
            />
            {mode !== 'login' && <p className="auth__hint">At least 10 characters. Length beats symbols.</p>}
          </div>

          {error && (
            <div className="form-error" role="alert">
              <span aria-hidden="true">⚠</span>
              <span>
                {error.message}
                {error.hint && <span className="auth__error-hint"> {error.hint}</span>}
              </span>
            </div>
          )}

          <button type="submit" className="btn btn--primary auth__submit" disabled={busy}>
            {busy ? 'Just a moment…' : copy.submit}
          </button>
        </form>

        {/* Only offer the switch when it is actually reachable — an unclaimed
            instance has no accounts to sign in to. */}
        {!setupPending && (
          <p className="auth__switch">
            {mode === 'login' ? (
              <>
                Got an invite code?{' '}
                <button type="button" className="auth__link" onClick={() => setMode('join')}>
                  Join instead
                </button>
              </>
            ) : mode === 'join' ? (
              <>
                Already have an account?{' '}
                <button type="button" className="auth__link" onClick={() => setMode('login')}>
                  Sign in
                </button>
              </>
            ) : null}
          </p>
        )}
      </div>
    </div>
  );
}
