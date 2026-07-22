/**
 * Portal v3 · M3 — das Modus-Profile-Regal (`#/anlage/{id}/profile`).
 *
 * Der Funktionsumfang der Anlage als Regal mit Schaltern: eine Karte je Profil,
 * ein Satz was es tut, „Schaltet frei"-Chips, Voraussetzungs-Chips und — wenn
 * ein eingeschaltetes Profil noch nicht voll laufen kann — der ehrliche Grund.
 *
 * **Jedes Profil ist ein direkter Kundenschalter** (Owner-Entscheidung): keine
 * „Angefragt"-Stufe, keine Anfragewand. Der Schalter schreibt den Willen; der
 * SERVER schaltet daraufhin genau die Bausteine dieses Profils frei und sät
 * seinen Start-Flow (bzw. legt die Flows beim Ausschalten still). Das Gate wird
 * nie in der Oberfläche vorgetäuscht.
 *
 * Reiner Renderer: jede Ableitung/Formulierung kommt aus `src/profiles.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Site } from '../api';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { CoOptimizationStrip } from '../components/SteuerungParts';
import { optimizerApi } from '../optimizerApi';
import {
  profileShelf,
  type ProfileState,
  type ShelfCard,
  type SiteProfiles,
} from '../profiles';
import {
  coOptimization,
  socReservationStack,
  type ReservationInput,
} from '../steuerungArea';
import { useAnlageSurface } from '../useAnlageSurface';
import '../components/Profile.css';

const INTRO =
  'Was Ihre Anlage kann, entscheiden Sie hier. Sie können mehrere Profile gleichzeitig ' +
  'nutzen — VoltPilot bringt sie auf einem Speicher zusammen.';

export function ProfileSection({ site }: { site: Site }) {
  const [profiles, setProfiles] = useState<SiteProfiles | null>(null);
  const [state, setState] = useState<'loading' | 'idle' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reservation, setReservation] = useState<ReservationInput | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { surface } = useAnlageSurface(site);

  useEffect(() => {
    let active = true;
    setState('loading');
    Promise.all([
      api.siteProfiles(site.id),
      optimizerApi.configViaSwitcher(site.id).catch(() => null),
    ])
      .then(([shelf, config]) => {
        if (!active) return;
        setProfiles(shelf);
        setReservation({
          socMinPct: config?.effective.socMinPct ?? null,
          socMaxPct: config?.effective.socMaxPct ?? null,
          backupReserveSocPct: config?.effective.backupReserveSocPct ?? null,
          peakReserveSocPct: site.peakReserveSocPct ?? null,
        });
        setState('idle');
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, [site.id, site.peakReserveSocPct, reloadKey]);

  const toggle = useCallback(
    async (id: string, next: ProfileState) => {
      setBusy(id);
      setError('');
      try {
        setProfiles(await api.setSiteProfile(site.id, id, next));
      } catch (e) {
        setError(
          e instanceof ApiError && e.message
            ? e.message
            : 'Das Profil konnte nicht umgeschaltet werden. Bitte später erneut versuchen.',
        );
      } finally {
        setBusy(null);
      }
    },
    [site.id],
  );

  const shelf = useMemo(() => profileShelf(profiles), [profiles]);
  const co = useMemo(() => coOptimization(surface?.modes ?? []), [surface]);
  const layers = useMemo(() => socReservationStack(reservation), [reservation]);

  if (state === 'loading') {
    return (
      <Card padding="lg" radius="lg">
        <TextSkeleton lines={4} />
      </Card>
    );
  }
  if (state === 'error') {
    return (
      <ErrorState
        message="Die Profile konnten nicht geladen werden."
        onRetry={() => setReloadKey((k) => k + 1)}
      />
    );
  }
  if (shelf.cards.length === 0 && shelf.weitere.length === 0) {
    return <EmptyState title="Noch keine Profile" description={INTRO} />;
  }

  return (
    <div className="vp-profile-area">
      <p className="vp-profile-intro">{INTRO}</p>
      {error ? (
        <p className="vp-profile-error" role="alert">
          {error}
        </p>
      ) : null}
      {co ? <CoOptimizationStrip co={co} layers={layers} /> : null}
      <div className="vp-profile-grid">
        {shelf.cards.map((card) => (
          <ProfileCard
            key={card.profile.id}
            card={card}
            busy={busy === card.profile.id}
            onToggle={toggle}
          />
        ))}
      </div>
      {shelf.weitere.length > 0 ? (
        <details className="vp-profile-weitere">
          <summary>Weitere Profile ({shelf.weitere.length})</summary>
          <div className="vp-profile-grid">
            {shelf.weitere.map((card) => (
              <ProfileCard
                key={card.profile.id}
                card={card}
                busy={busy === card.profile.id}
                onToggle={toggle}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ProfileCard({
  card,
  busy,
  onToggle,
}: {
  card: ShelfCard;
  busy: boolean;
  onToggle: (id: string, next: ProfileState) => void;
}) {
  const on = card.profile.active;
  return (
    <Card className={`vp-profile-card${on ? ' on' : ''}`} padding="lg" radius="lg">
      <div className="vp-profile-head">
        <h3>{card.profile.label}</h3>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${card.profile.label} ${on ? 'ausschalten' : 'einschalten'}`}
          className={`vp-switch${on ? ' on' : ''}`}
          disabled={busy}
          onClick={() => onToggle(card.profile.id, on ? 'aus' : 'an')}
        >
          <span className="vp-switch-knob" aria-hidden="true" />
        </button>
      </div>
      <p className="vp-profile-benefit">{card.benefit}</p>
      {card.unlocks.length > 0 ? (
        <div className="vp-profile-block">
          <span className="vp-profile-blocklabel">Schaltet frei</span>
          <ul className="vp-profile-chips">
            {card.unlocks.map((u) => (
              <li key={u} className="vp-profile-chip">
                {u}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {card.requirements.length > 0 ? (
        <div className="vp-profile-block">
          <span className="vp-profile-blocklabel">Voraussetzungen</span>
          <ul className="vp-profile-chips">
            {card.requirements.map((r) => (
              <li key={r.label} className={`vp-profile-chip req${r.met ? ' met' : ' missing'}`}>
                <Icon name={r.met ? 'check' : 'alert-triangle'} size={14} />
                {r.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {card.blockedReason ? (
        <p className="vp-profile-blocked">
          <Icon name="info" size={16} />
          {card.blockedReason}
        </p>
      ) : null}
      {card.originLine ? <p className="vp-profile-origin">{card.originLine}</p> : null}
    </Card>
  );
}
