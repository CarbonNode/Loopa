import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import type { ClipActivity as Activity, PersonEvent, PersonRef, ShareLink } from '../api/types.ts';
import { useApp } from '../state/store.tsx';
import { formatAbsoluteTime, formatCount, formatRelativeTime } from '../utils/format.ts';
import './ClipActivity.css';

/** Two initials, the same rule the members list in Settings uses. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function Avatar({ person, at, verb }: { person: PersonRef; at?: number; verb: string }) {
  const when = at ? formatRelativeTime(at) : null;
  return (
    <span
      className="activity__avatar"
      style={{ background: person.avatarColor }}
      title={at ? `${person.displayName} ${verb} ${when} · ${formatAbsoluteTime(at)}` : `${person.displayName} ${verb}`}
      aria-label={`${person.displayName}${when ? `, ${verb} ${when}` : ''}`}
    >
      {initialsOf(person.displayName)}
    </span>
  );
}

/**
 * A row of avatars that stays a row.
 *
 * Everyone in the group eventually watches everything, so this list only grows
 * — past a handful it collapses to "+N" rather than wrapping into a wall of
 * circles that pushes the rest of the panel off screen.
 */
function People({ people, verb, max = 8 }: { people: PersonEvent[]; verb: string; max?: number }) {
  const shown = people.slice(0, max);
  const rest = people.slice(max);

  return (
    <div className="activity__people">
      {shown.map((person) => (
        <Avatar key={person.id} person={person} at={person.at} verb={verb} />
      ))}
      {rest.length > 0 && (
        <span
          className="activity__avatar activity__avatar--more"
          title={rest.map((person) => person.displayName).join(', ')}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}

export function ClipActivity({ clipId }: { clipId: string }) {
  const { notify, reportError } = useApp();

  const [activity, setActivity] = useState<Activity | null>(null);
  const [share, setShare] = useState<ShareLink | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { activity: result } = await api.clipActivity(clipId);
      setActivity(result);
    } catch {
      // Attribution is decoration on top of the clip — failing to load it
      // should not put an error banner over a video that plays fine.
      setActivity(null);
    }
  }, [clipId]);

  useEffect(() => {
    setActivity(null);
    setShare(null);
    void load();
  }, [load]);

  // An existing link is already in the activity payload, so showing it costs
  // no extra request — only creating one does.
  const existing = share ?? (activity?.shares[0] ? { ...activity.shares[0], url: '', directUrl: '' } : null);
  const hasLink = Boolean(share) || (activity?.shares.length ?? 0) > 0;

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify({ kind: 'success', message: `${label} copied.` });
    } catch {
      // Clipboard access is denied on insecure origins — surfacing the URL
      // still lets someone copy it by hand.
      notify({ kind: 'info', message: value });
    }
  };

  const createOrCopy = async () => {
    setBusy(true);
    try {
      const { share: link } = await api.shareClip(clipId);
      setShare(link);
      await copy(link.url, 'Share link');
      void load();
    } catch (error) {
      reportError(error, 'Could not create a share link.');
    } finally {
      setBusy(false);
    }
  };

  const stopSharing = async () => {
    setBusy(true);
    try {
      await api.unshareClip(clipId);
      setShare(null);
      await load();
      notify({ kind: 'info', message: 'Sharing turned off. Existing links no longer work.' });
    } catch (error) {
      reportError(error, 'Could not revoke that link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lightbox__block activity">
      <h3 className="lightbox__block-title">Share</h3>

      <div className="activity__share">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void createOrCopy()} disabled={busy}>
          {busy ? 'Working…' : hasLink ? 'Copy link' : 'Create link'}
        </button>

        {share && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copy(share.directUrl, 'Direct .mp4 link')}>
            Copy .mp4
          </button>
        )}

        {hasLink && (
          <button type="button" className="btn btn--ghost btn--sm activity__stop" onClick={() => void stopSharing()} disabled={busy}>
            Stop sharing
          </button>
        )}
      </div>

      {share ? (
        <p className="activity__url" title={share.url}>
          {share.url}
        </p>
      ) : (
        <p className="lightbox__muted activity__hint">
          {hasLink
            ? 'A public link exists for this clip. Copy it to send again.'
            : 'Anyone with the link can watch — no account needed. It plays inline in Discord.'}
        </p>
      )}

      {existing && existing.viewCount > 0 && (
        <p className="lightbox__muted activity__hint">
          Opened {formatCount(existing.viewCount)} {existing.viewCount === 1 ? 'time' : 'times'} through the link
          {existing.lastViewedAt ? `, last ${formatRelativeTime(existing.lastViewedAt)}` : ''}.
        </p>
      )}

      {activity && (
        <>
          <h3 className="lightbox__block-title activity__heading">Activity</h3>

          <dl className="activity__rows">
            <div className="activity__row">
              <dt>Added by</dt>
              <dd>
                {activity.addedBy ? (
                  <span className="activity__named">
                    <Avatar person={activity.addedBy} at={activity.addedAt} verb="added this" />
                    <span>{activity.addedBy.displayName}</span>
                    <span className="lightbox__muted" title={formatAbsoluteTime(activity.addedAt)}>
                      {formatRelativeTime(activity.addedAt)}
                    </span>
                  </span>
                ) : (
                  <span className="lightbox__muted">Unknown</span>
                )}
              </dd>
            </div>

            <div className="activity__row">
              <dt>Watched by</dt>
              <dd>
                {activity.viewers.length > 0 ? (
                  <span className="activity__named">
                    <People people={activity.viewers} verb="watched it" />
                    <span className="lightbox__muted">
                      {activity.viewers.length} {activity.viewers.length === 1 ? 'member' : 'members'}
                      {activity.playCount > activity.viewers.length ? ` · ${formatCount(activity.playCount)} plays` : ''}
                    </span>
                  </span>
                ) : (
                  <span className="lightbox__muted">Nobody yet</span>
                )}
              </dd>
            </div>

            {activity.favoritedBy.length > 0 && (
              <div className="activity__row">
                <dt>Favourited by</dt>
                <dd>
                  <People people={activity.favoritedBy} verb="favourited it" />
                </dd>
              </div>
            )}

            {activity.shares.length > 0 && (
              <div className="activity__row">
                <dt>Shared by</dt>
                <dd>
                  <span className="activity__named">
                    {activity.shares[0]?.createdBy ? (
                      <>
                        <Avatar
                          person={activity.shares[0].createdBy}
                          at={activity.shares[0].createdAt}
                          verb="shared it"
                        />
                        <span>{activity.shares[0].createdBy.displayName}</span>
                      </>
                    ) : (
                      <span className="lightbox__muted">Someone since removed</span>
                    )}
                    <span className="lightbox__muted" title={formatAbsoluteTime(activity.shares[0]!.createdAt)}>
                      {formatRelativeTime(activity.shares[0]!.createdAt)}
                    </span>
                  </span>
                </dd>
              </div>
            )}
          </dl>
        </>
      )}
    </section>
  );
}
