import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { IngestStatus, Invite, ProbeResult, SystemStatus, User } from '../api/types.ts';
import { useDismissable, useFocusTrap, useScrollLock } from '../hooks/index.ts';
import { useApp } from '../state/store.tsx';
import { formatBytes, formatRelativeTime, formatUsd, initialsOf } from '../utils/format.ts';
import './SettingsDialog.css';

type Tab = 'account' | 'people' | 'ingest' | 'library';

/**
 * Per-site auth setup.
 *
 * `cookie` is the single cookie that actually carries the session — copying
 * one value out of DevTools is far less friction than installing a cookies.txt
 * extension, and it is all yt-dlp needs.
 */
const COOKIE_SITES = [
  {
    id: 'instagram',
    label: 'Instagram',
    cookie: 'sessionid',
    domain: 'instagram.com',
    required: true,
    note: 'Required. Instagram refuses almost all Reels without a signed-in session.',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    cookie: 'sessionid',
    domain: 'tiktok.com',
    required: false,
    note: 'Usually optional — helps with rate limits and private posts.',
  },
  {
    id: 'twitter',
    label: 'X / Twitter',
    cookie: 'auth_token',
    domain: 'x.com',
    required: true,
    note: 'Required for most video posts.',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    cookie: 'SID',
    domain: 'youtube.com',
    required: false,
    note: 'Only for age-restricted or members-only videos.',
  },
] as const;

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, notify, reportError, status, refreshStatus, invalidateLibrary } = useApp();

  const [tab, setTab] = useState<Tab>('account');
  const dialogRef = useFocusTrap(open);
  const dismissRef = useDismissable(open, onClose);
  useScrollLock(open);

  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    if (open) void refreshStatus();
  }, [open, refreshStatus]);

  // A member landing on an admin-only tab (e.g. after a role change) must not
  // be stranded on a blank panel.
  useEffect(() => {
    if (!isAdmin && (tab === 'people' || tab === 'library')) setTab('account');
  }, [isAdmin, tab]);

  if (!open) return null;

  const tabs: Array<{ id: Tab; label: string; adminOnly: boolean }> = [
    { id: 'account', label: 'Account', adminOnly: false },
    { id: 'ingest', label: 'Ingest', adminOnly: false },
    { id: 'people', label: 'People', adminOnly: true },
    { id: 'library', label: 'Library', adminOnly: true },
  ];

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="modal__backdrop" aria-hidden="true" />

      <div className="modal__panel settings" ref={dismissRef}>
        <div ref={dialogRef}>
          <header className="modal__header">
            <h2 className="modal__title" id="settings-title">
              Settings
            </h2>
            <button type="button" className="modal__close" onClick={onClose} aria-label="Close" data-autofocus>
              ×
            </button>
          </header>

          <nav className="settings__tabs" role="tablist" aria-label="Settings sections">
            {tabs
              .filter((entry) => !entry.adminOnly || isAdmin)
              .map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  className={`settings__tab${tab === entry.id ? ' is-active' : ''}`}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
          </nav>

          <div className="modal__body settings__body" role="tabpanel">
            {tab === 'account' && <AccountTab />}
            {tab === 'ingest' && <IngestTab isAdmin={isAdmin} notify={notify} reportError={reportError} />}
            {tab === 'people' && isAdmin && <PeopleTab notify={notify} reportError={reportError} />}
            {tab === 'library' && isAdmin && (
              <LibraryTab
                status={status}
                notify={notify}
                reportError={reportError}
                refreshStatus={refreshStatus}
                invalidateLibrary={invalidateLibrary}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Account ──────────────────────────────────────────────────────────────────

function AccountTab() {
  const { user, notify, reportError } = useApp();

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.updateProfile({ displayName });
      notify({ kind: 'success', message: 'Profile updated.' });
    } catch (error) {
      reportError(error, 'Could not update your profile.');
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      notify({
        kind: 'success',
        message: 'Password changed.',
        hint: 'Your other devices have been signed out.',
      });
    } catch (error) {
      reportError(error, 'Could not change your password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings__section">
      <form className="settings__group" onSubmit={saveProfile}>
        <h3 className="settings__group-title">Profile</h3>
        <div className="field">
          <label className="field__label" htmlFor="settings-display">
            Display name
          </label>
          <input
            id="settings-display"
            className="input"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={64}
          />
        </div>
        <button type="submit" className="btn btn--secondary" disabled={busy || !displayName.trim()}>
          Save
        </button>
      </form>

      <form className="settings__group" onSubmit={savePassword}>
        <h3 className="settings__group-title">Password</h3>
        <div className="field">
          <label className="field__label" htmlFor="settings-current">
            Current password
          </label>
          <input
            id="settings-current"
            className="input"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="settings-new">
            New password
          </label>
          <input
            id="settings-new"
            className="input"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={10}
          />
        </div>
        <button
          type="submit"
          className="btn btn--secondary"
          disabled={busy || !currentPassword || newPassword.length < 10}
        >
          Change password
        </button>
      </form>
    </div>
  );
}

// ── Ingest ───────────────────────────────────────────────────────────────────

type Notifier = ReturnType<typeof useApp>['notify'];
type ErrorReporter = ReturnType<typeof useApp>['reportError'];

function IngestTab({
  isAdmin,
  notify,
  reportError,
}: {
  isAdmin: boolean;
  notify: Notifier;
  reportError: ErrorReporter;
}) {
  const [ingest, setIngest] = useState<IngestStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const fileInputs = useRef(new Map<string, HTMLInputElement | null>());

  const refresh = useCallback(async () => {
    try {
      setIngest(await api.ingestStatus());
    } catch (error) {
      reportError(error, 'Could not read the ingest status.');
    }
  }, [reportError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateYtDlp = async () => {
    setUpdating(true);
    try {
      const result = await api.updateYtDlp();
      notify({
        kind: result.ok ? 'success' : 'error',
        message: result.ok ? `yt-dlp updated to ${result.version ?? 'the latest version'}.` : 'The update failed.',
        hint: result.ok ? null : result.output.split('\n').slice(-2).join(' ').slice(0, 200),
      });
      await refresh();
    } catch (error) {
      reportError(error, 'Could not update yt-dlp.');
    } finally {
      setUpdating(false);
    }
  };

  const uploadCookies = async (site: string, file: File) => {
    try {
      const result = await api.uploadCookies(site, file);
      setIngest((current) => (current ? { ...current, cookies: result.cookies } : current));
      notify({ kind: 'success', message: `${site} cookies saved.` });
    } catch (error) {
      reportError(error, 'Could not save that cookies file.');
    }
  };

  return (
    <div className="settings__section">
      <div className="settings__group">
        <h3 className="settings__group-title">Downloader</h3>
        <div className="settings__row">
          <div className="settings__row-text">
            <strong>yt-dlp</strong>
            <span className="settings__muted">
              {ingest?.ytDlpVersion ? `Version ${ingest.ytDlpVersion}` : 'Not detected'}
            </span>
          </div>
          {isAdmin && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void updateYtDlp()} disabled={updating}>
              {updating ? 'Updating…' : 'Update'}
            </button>
          )}
        </div>
        <p className="settings__note">
          Instagram and TikTok change how their pages work often enough to break downloads. When a Reel
          suddenly stops importing, updating yt-dlp is almost always the fix — no rebuild needed.
        </p>
      </div>

      <div className="settings__group">
        <h3 className="settings__group-title">Site sign-in</h3>
        <p className="settings__note">
          Some sites only serve videos to a signed-in session. Hit <em>Sign in</em> below and paste whatever is
          easiest to copy out of your browser — a <code>Copy as cURL</code>, a cookie header, a cookies.txt, or
          just the raw value. Loopa works out which it is and keeps only the cookies that site needs.
        </p>

        <ul className="settings__cookies">
          {COOKIE_SITES.map((site) => (
            <SiteAuthRow
              key={site.id}
              site={site}
              present={ingest?.cookies[site.id] ?? false}
              isAdmin={isAdmin}
              onChanged={(cookies) => setIngest((current) => (current ? { ...current, cookies } : current))}
              onPickFile={() => fileInputs.current.get(site.id)?.click()}
              registerFileInput={(element) => fileInputs.current.set(site.id, element)}
              onUploadFile={(file) => void uploadCookies(site.id, file)}
              notify={notify}
              reportError={reportError}
            />
          ))}
        </ul>
      </div>

      <LinkTester reportError={reportError} />

      {ingest && (
        <div className="settings__group">
          <h3 className="settings__group-title">Limits</h3>
          <div className="settings__row">
            <span className="settings__muted">Maximum upload</span>
            <strong>{formatBytes(ingest.maxUploadBytes)}</strong>
          </div>
          <div className="settings__row">
            <span className="settings__muted">Maximum download from a link</span>
            <strong>{formatBytes(ingest.maxUrlBytes)}</strong>
          </div>
        </div>
      )}
    </div>
  );
}

/** One site's auth state: paste a session token, or fall back to a cookie file. */
function SiteAuthRow({
  site,
  present,
  isAdmin,
  onChanged,
  onPickFile,
  registerFileInput,
  onUploadFile,
  notify,
  reportError,
}: {
  site: (typeof COOKIE_SITES)[number];
  present: boolean;
  isAdmin: boolean;
  onChanged: (cookies: Record<string, boolean>) => void;
  onPickFile: () => void;
  registerFileInput: (element: HTMLInputElement | null) => void;
  onUploadFile: (file: File) => void;
  notify: Notifier;
  reportError: ErrorReporter;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;

    setSaving(true);
    try {
      const result = await api.saveSession(site.id, value);
      onChanged(result.cookies);
      // Never keep a bearer credential in component state longer than needed.
      setValue('');
      setOpen(false);

      const described = {
        curl: 'from the cURL command',
        json: 'from the JSON export',
        netscape: 'from the cookies.txt',
        header: 'from the cookie header',
        pair: '',
        value: '',
      }[result.format] ?? '';

      notify({
        kind: 'success',
        message: `${site.label} signed in — picked up ${result.written.join(', ')} ${described}`.trim(),
        hint: 'Confirm it works: paste a link into "Test a link" below.',
      });
    } catch (error) {
      reportError(error, `Could not save the ${site.label} session.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="settings__cookie settings__cookie--stack">
      <div className="settings__cookie-head">
        <div className="settings__row-text">
          <strong>
            {site.label}
            <span className={`settings__pill${present ? ' is-good' : site.required ? ' is-warn' : ''}`}>
              {present ? 'signed in' : site.required ? 'needed' : 'not set'}
            </span>
          </strong>
          <span className="settings__muted">{site.note}</span>
        </div>

        {isAdmin && (
          <div className="settings__cookie-actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setOpen((v) => !v)}>
              {present ? 'Replace' : 'Sign in'}
            </button>
            {present && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  void api
                    .deleteCookies(site.id)
                    .then((result) => onChanged(result.cookies))
                    .catch((error: unknown) => reportError(error, 'Could not remove that session.'));
                }}
              >
                Remove
              </button>
            )}
          </div>
        )}
      </div>

      {isAdmin && open && (
        <form className="settings__session" onSubmit={save}>
          {/*
            Instagram's sessionid is HttpOnly, so no bookmarklet can read it —
            it has to be copied out of the browser by hand. Rather than demand
            one exact format, take anything a copy plausibly produces and work
            it out server-side.
          */}
          <ol className="settings__steps">
            <li>
              Open <strong>{site.label}</strong> in a browser where you are signed in.
            </li>
            <li>
              Press <kbd>F12</kbd> (or <kbd>⌥</kbd><kbd>⌘</kbd><kbd>I</kbd>) to open DevTools.
            </li>
            <li>
              <strong>Easiest:</strong> the <em>Network</em> tab → reload the page → right-click any request →{' '}
              <em>Copy</em> → <em>Copy as cURL</em>. Paste the whole thing below.
            </li>
            <li>
              Or: <em>Application</em> → <em>Cookies</em> → <code>{site.domain}</code> → copy the value of{' '}
              <code>{site.cookie}</code>.
            </li>
          </ol>

          <label className="settings__session-label" htmlFor={`session-${site.id}`}>
            Paste it here — a cURL command, a cookie header, a cookies.txt, or just the value
          </label>

          <textarea
            id={`session-${site.id}`}
            className="input settings__session-input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={`curl 'https://www.${site.id}.com/…' -H 'cookie: ${site.cookie}=…'\n\n…or just the ${site.cookie} value on its own`}
            rows={4}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />

          <div className="settings__session-actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={!value.trim() || saving}>
              {saving ? 'Saving…' : 'Save session'}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onPickFile}>
              Upload a cookies.txt instead
            </button>
          </div>

          <p className="settings__note settings__session-privacy">
            Stored on the server only, readable by nobody but the server process, and never sent back to a
            browser. A cURL paste can contain other cookies — only the ones {site.label} needs are kept.
          </p>

          <input
            ref={registerFileInput}
            type="file"
            accept=".txt,text/plain"
            className="visually-hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUploadFile(file);
              event.target.value = '';
            }}
          />
        </form>
      )}
    </li>
  );
}

/**
 * Dry-run a real link through the downloader.
 *
 * Configuring cookies and then finding out hours later that they were wrong is
 * the worst version of this. Testing runs the actual extractor, so the answer
 * is the one that matters.
 */
function LinkTester({ reportError }: { reportError: ErrorReporter }) {
  const [url, setUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  const test = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;

    setTesting(true);
    setResult(null);
    try {
      setResult(await api.probe(url));
    } catch (error) {
      reportError(error, 'The test could not run.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings__group">
      <h3 className="settings__group-title">Test a link</h3>
      <p className="settings__note">
        Runs the real downloader without saving anything, so you can confirm a site works before importing a
        batch.
      </p>

      <form className="settings__session-row" onSubmit={test}>
        <input
          className="input"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://www.instagram.com/reel/…"
          autoComplete="off"
          spellCheck={false}
          aria-label="Link to test"
        />
        <button type="submit" className="btn btn--secondary btn--sm" disabled={!url.trim() || testing}>
          {testing ? 'Testing…' : 'Test'}
        </button>
      </form>

      {testing && (
        <div className="settings__row">
          <span className="spinner" />
          <span className="settings__muted">Asking {new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '')}…</span>
        </div>
      )}

      {result && !testing && (
        <div className={`settings__probe${result.ok ? ' is-ok' : ' is-bad'}`}>
          <strong>
            {result.ok ? '✓ ' : '✕ '}
            {result.ok ? `${result.site} works` : `${result.site} failed`}
            <span className="settings__pill">{result.usedCookies ? 'using your session' : 'anonymous'}</span>
          </strong>
          {result.ok ? (
            <span className="settings__muted">
              {result.title ?? 'Untitled'}
              {result.uploader ? ` · ${result.uploader}` : ''}
            </span>
          ) : (
            <>
              <span className="settings__muted">{result.error}</span>
              {result.hint && <span className="settings__muted settings__probe-hint">{result.hint}</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── People ───────────────────────────────────────────────────────────────────

function PeopleTab({ notify, reportError }: { notify: Notifier; reportError: ErrorReporter }) {
  const { user } = useApp();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [creating, setCreating] = useState(false);
  // 0 = unlimited, matching the server's sentinel.
  const [maxUses, setMaxUses] = useState(1);

  const refresh = useCallback(async () => {
    try {
      const [inviteResult, userResult] = await Promise.all([api.invites(), api.users()]);
      setInvites(inviteResult.invites.filter((invite) => !invite.revoked_at));
      setUsers(userResult.users);
    } catch (error) {
      reportError(error, 'Could not load members.');
    }
  }, [reportError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createInvite = async () => {
    setCreating(true);
    try {
      const { invite } = await api.createInvite({ maxUses, expiresInDays: 14 });
      await refresh();

      // Clipboard access can be denied (insecure origin, permissions); the
      // code is on screen either way, so a failure is not worth an error.
      try {
        await navigator.clipboard.writeText(invite.url);
        notify({ kind: 'success', message: 'Invite link copied to your clipboard.' });
      } catch {
        notify({ kind: 'success', message: `Invite created: ${invite.code}` });
      }
    } catch (error) {
      reportError(error, 'Could not create an invite.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="settings__section">
      <div className="settings__group">
        <div className="settings__group-head">
          <h3 className="settings__group-title">Invites</h3>
          <div className="settings__invite-new">
            <label className="visually-hidden" htmlFor="invite-uses">
              How many people can use this invite
            </label>
            <select
              id="invite-uses"
              className="input settings__invite-uses"
              value={maxUses}
              onChange={(event) => setMaxUses(Number(event.target.value))}
            >
              <option value={1}>1 person</option>
              <option value={5}>5 people</option>
              <option value={25}>25 people</option>
              {/* 0 is the server's sentinel for "no limit". */}
              <option value={0}>Unlimited</option>
            </select>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void createInvite()} disabled={creating}>
              {creating ? 'Creating…' : 'New invite'}
            </button>
          </div>
        </div>

        {invites.length === 0 ? (
          <p className="settings__note">
            No open invites. Pick how many people it should let in, create it, and send the link — invites expire in two weeks.
          </p>
        ) : (
          <ul className="settings__list">
            {invites.map((invite) => (
              <li key={invite.code} className="settings__row">
                <div className="settings__row-text">
                  <strong className="settings__code">{invite.code}</strong>
                  <span className="settings__muted">
                    {invite.max_uses === 0
                      ? `${invite.uses} used · unlimited`
                      : `${invite.uses}/${invite.max_uses} used`}
                    {invite.expires_at ? ` · expires ${formatRelativeTime(invite.expires_at)}` : ''}
                  </span>
                </div>
                <div className="settings__cookie-actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(invite.url)
                        .then(() => notify({ kind: 'success', message: 'Link copied.' }))
                        .catch(() => notify({ kind: 'info', message: invite.url }));
                    }}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      void api
                        .revokeInvite(invite.code)
                        .then(refresh)
                        .catch((error: unknown) => reportError(error, 'Could not revoke that invite.'));
                    }}
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="settings__group">
        <h3 className="settings__group-title">Members</h3>
        <ul className="settings__list">
          {users.map((member) => (
            <li key={member.id} className="settings__row">
              <div className="settings__member">
                <span className="settings__avatar" style={{ background: member.avatarColor }}>
                  {initialsOf(member.displayName)}
                </span>
                <div className="settings__row-text">
                  <strong>
                    {member.displayName}
                    {member.role === 'admin' && <span className="settings__pill is-good">admin</span>}
                  </strong>
                  <span className="settings__muted">@{member.username}</span>
                </div>
              </div>

              {member.id !== user?.id && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    void api
                      .deleteUser(member.id)
                      .then(refresh)
                      .catch((error: unknown) => reportError(error, 'Could not remove that member.'));
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── Library ──────────────────────────────────────────────────────────────────

function LibraryTab({
  status,
  notify,
  reportError,
  refreshStatus,
  invalidateLibrary,
}: {
  status: SystemStatus | null;
  notify: Notifier;
  reportError: ErrorReporter;
  refreshStatus: () => Promise<void>;
  invalidateLibrary: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const runAction = async (label: string, action: () => Promise<string>) => {
    setBusy(label);
    try {
      notify({ kind: 'success', message: await action() });
      await refreshStatus();
      invalidateLibrary();
    } catch (error) {
      reportError(error, `Could not ${label.toLowerCase()}.`);
    } finally {
      setBusy(null);
    }
  };

  const stats = status?.stats;

  return (
    <div className="settings__section">
      {stats && (
        <div className="settings__stats">
          <Stat label="Clips" value={stats.clips.toLocaleString()} />
          <Stat label="On disk" value={formatBytes(stats.bytes)} />
          <Stat label="Categories" value={String(stats.categories)} />
          <Stat label="Tags" value={String(stats.tags)} />
          <Stat label="Untagged" value={String(stats.untagged)} tone={stats.untagged > 0 ? 'warn' : undefined} />
          <Stat label="AI spend" value={formatUsd(stats.aiSpendUsd)} />
        </div>
      )}

      {status?.tagger && (
        <div className="settings__group">
          <h3 className="settings__group-title">AI tagging</h3>
          <div className="settings__row">
            <div className="settings__row-text">
              <strong>
                {status.tagger.enabled ? status.tagger.model : 'Disabled'}
                <span className={`settings__pill${status.tagger.enabled ? ' is-good' : ''}`}>
                  {status.tagger.provider}
                </span>
              </strong>
              <span className="settings__muted">
                {status.tagger.enabled
                  ? 'New clips are tagged automatically as they finish processing.'
                  : 'Set ANTHROPIC_API_KEY and restart to enable automatic tagging.'}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="settings__group">
        <h3 className="settings__group-title">Maintenance</h3>

        <div className="settings__row">
          <div className="settings__row-text">
            <strong>Tag anything missed</strong>
            <span className="settings__muted">Queues every clip that has no AI tags yet.</span>
          </div>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={busy !== null}
            onClick={() =>
              void runAction('Queue tagging', async () => {
                const result = await api.retagMissing();
                return `Queued ${result.queued} clip${result.queued === 1 ? '' : 's'} for tagging.`;
              })
            }
          >
            {busy === 'Queue tagging' ? 'Queueing…' : 'Run'}
          </button>
        </div>

        <div className="settings__row">
          <div className="settings__row-text">
            <strong>Rebuild the search index</strong>
            <span className="settings__muted">Use if search results look stale or incomplete.</span>
          </div>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={busy !== null}
            onClick={() =>
              void runAction('Rebuild index', async () => {
                const result = await api.reindex();
                return `Reindexed ${result.indexed} clips.`;
              })
            }
          >
            {busy === 'Rebuild index' ? 'Rebuilding…' : 'Run'}
          </button>
        </div>

        <div className="settings__row settings__row--danger">
          <div className="settings__row-text">
            <strong>Permanently delete removed clips</strong>
            <span className="settings__muted">
              Removed clips keep their files so a mistake can be undone. This frees that space for good.
            </span>
          </div>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            disabled={busy !== null}
            onClick={() => {
              if (!window.confirm('Permanently delete every removed clip and its files? This cannot be undone.')) return;
              void runAction('Purge', async () => {
                const result = await api.purge(0);
                return `Purged ${result.purged} clip${result.purged === 1 ? '' : 's'}.`;
              });
            }}
          >
            {busy === 'Purge' ? 'Purging…' : 'Purge'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className={`settings__stat${tone === 'warn' ? ' is-warn' : ''}`}>
      <span className="settings__stat-value">{value}</span>
      <span className="settings__stat-label">{label}</span>
    </div>
  );
}
