import { useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError } from '../api';
import { entitiesApi } from '../entitiesApi';
import { ADOPT_FORBIDDEN_MSG } from '../setupPath';
import { useIsPhone } from '../useIsPhone';
import { BottomSheet } from './BottomSheet';
import {
  berichtsBelegAus,
  type BerichtsBeleg,
  type EntfernenFolge,
  type GefahrenzoneZustand,
} from '../geraetLoeschen';
import { hashForRoute, messstelleRoute } from '../nav';
import './GeraetGefahrenzone.css';

/**
 * Die GEFAHRENZONE der Geräteseite (Konzept `vp-loeschen-konzept-l3`, E4):
 * genau EIN Ort für das Entfernen, am Seitenende, parallel zu „Anlage löschen"
 * ({@code AnlageTechnik} DangerZone) - nie im eingeklappten „Details"-Block.
 *
 * <p>Drei Formen, nie ein toter Knopf:
 * <ul>
 *   <li>eine löschbare Kunden-Komponente → „Komponente entfernen" mit ehrlicher
 *       Folgenliste (was bleibt / was geht) und Namen-Bestätigung;</li>
 *   <li>der geschützte {@code battery-hybrid} → Grund UND Weg: „Batterie am
 *       Standort abmelden" (E1), das Nennwerte, Entität und Live-Sicht zusammen
 *       entfernt und den Optimierer aufhören lässt, einen Phantom-Speicher zu
 *       planen;</li>
 *   <li>eine plattform-eigene Grundausstattung ohne neuen Weg → nur der Grund.</li>
 * </ul>
 *
 * <p>Lehnt der Server das Entfernen ab, weil freigegebene Berichtsstände die
 * Komponente zitieren (UEMS AP-12 IP-12, 409 {@code berichts_belege}), schließt
 * die Rückfrage und die Gefahrenzone nennt Grund UND Weg: den Satz mit der
 * Liste der Stände und je zitierter Messstelle den Sprung dorthin, wo die
 * Bindung endet. Geschrieben ist in dem Fall nichts.
 *
 * <p>Die Rückfrage ist am Rechner das zentrierte {@code Modal}, am Telefon ein
 * {@code BottomSheet} (E4-Mobil) - dieselbe Folgenliste, derselbe Zwei-Stufen-
 * Schutz (Namen tippen). Die Folgen und der Zustand kommen als reine Ableitung
 * aus {@code geraetLoeschen.ts}; diese Fläche rendert nur.
 */
export function GeraetGefahrenzone({
  siteId,
  zustand,
  name,
  onDone,
}: {
  siteId: string;
  zustand: GefahrenzoneZustand;
  /** Der Anzeigename des Geräts - Titel der Rückfrage und das Wort zum Tippen. */
  name: string;
  /** Neu laden, nachdem etwas entfernt wurde. */
  onDone: () => void;
}) {
  const [offen, setOffen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [beleg, setBeleg] = useState<BerichtsBeleg | null>(null);

  if (zustand == null) return null;

  async function entfernen() {
    if (zustand == null) return;
    setBusy(true);
    setFehler(null);
    try {
      if (zustand.kind === 'batterie') {
        await api.unregisterBattery(siteId);
      } else if (zustand.kind === 'entfernen') {
        await entitiesApi.removeComponent(siteId, zustand.entity.id);
      }
      onDone();
    } catch (e) {
      const b = e instanceof ApiError ? berichtsBelegAus(e.status, e.body) : null;
      if (b) {
        // Ein Beleg: nichts ist geschrieben - die Rückfrage hat ihre Frage verloren.
        setBeleg(b);
        setOffen(false);
        setBusy(false);
        return;
      }
      setFehler(fehlerText(e));
      setBusy(false);
    }
  }

  const schliessen = () => {
    if (busy) return;
    setOffen(false);
    setFehler(null);
  };

  // Beleg freigegebener Berichtsstände: Grund UND Weg, kein Knopf mehr.
  if (beleg) {
    return (
      <section className="vp-gz" aria-label="Gefahrenzone">
        <GzKopf />
        <div className="vp-gz-blocked" data-testid="gz-berichts-belege">
          <Icon name="lock" size={16} aria-hidden />
          <div>
            <p>{beleg.satz}</p>
            {beleg.messstellen.length > 0 && (
              <ul className="vp-gz-belege">
                {beleg.messstellen.map((m) => (
                  <li key={m.id}>
                    <a href={hashForRoute(messstelleRoute(m.id))}>
                      Zur Messstelle {m.kennzeichen} {m.name}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    );
  }

  // A platform base row with no new way: only the reason, never a button.
  if (zustand.kind === 'geschuetzt') {
    return (
      <section className="vp-gz" aria-label="Gefahrenzone">
        <GzKopf />
        <div className="vp-gz-blocked">
          <Icon name="lock" size={16} aria-hidden />
          <p>{zustand.grund}</p>
        </div>
      </section>
    );
  }

  const istBatterie = zustand.kind === 'batterie';
  const aktionLabel = istBatterie ? 'Batterie am Standort abmelden' : 'Komponente entfernen';
  const titel = istBatterie ? 'Batterie am Standort abmelden?' : `„${name}“ entfernen?`;
  const intro = istBatterie
    ? 'VoltPilot hört auf, diesen Speicher zu lesen und zu steuern. Das lässt sich nicht '
      + 'rückgängig machen.'
    : 'VoltPilot hört auf, dieses Gerät zu lesen und zu steuern. Das lässt sich nicht '
      + 'rückgängig machen.';
  const bestaetigen = istBatterie ? 'Batterie endgültig abmelden' : 'Endgültig entfernen';

  return (
    <section className="vp-gz" aria-label="Gefahrenzone">
      <GzKopf />
      {istBatterie ? (
        // Der geschützte Speicher: kein toter Knopf, sondern Grund UND Weg.
        <div className="vp-gz-blocked">
          <Icon name="lock" size={16} aria-hidden />
          <div>
            <p>
              Dieser Speicher gehört zur Grundausstattung Ihrer Anlage - die Optimierung braucht
              ihn. Deshalb lässt er sich nicht einzeln entfernen. Um ihn wirklich loszuwerden,
              melden Sie die Batterie am Standort ab.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="vp-btn-danger"
              iconLeft={<Icon name="trash" size={16} />}
              onClick={() => setOffen(true)}
            >
              {aktionLabel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="vp-gz-row">
          <p>
            Diese Komponente aus Ihrer Anlage entfernen. Ihre aufgezeichneten Messwerte und Erlöse
            bleiben in der Historie erhalten.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="vp-btn-danger"
            iconLeft={<Icon name="trash" size={16} />}
            onClick={() => setOffen(true)}
          >
            {aktionLabel}
          </Button>
        </div>
      )}

      <GefahrBestaetigung
        open={offen}
        title={titel}
        intro={intro}
        folgen={zustand.folgen}
        confirmName={name}
        confirmLabel={bestaetigen}
        busy={busy}
        error={fehler}
        onConfirm={() => void entfernen()}
        onCancel={schliessen}
      />
    </section>
  );
}

function GzKopf() {
  return (
    <div className="vp-gz-head">
      <Icon name="alert-triangle" size={18} aria-hidden />
      Gefahrenzone
    </div>
  );
}

/** 401/403/404 = die Kundenroute fehlt (älteres Backend) → ehrlicher Hinweis. */
function fehlerText(e: unknown): string {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 401 || status === 403) return ADOPT_FORBIDDEN_MSG;
  return e instanceof ApiError && e.message
    ? e.message
    : 'Das ließ sich gerade nicht entfernen. Bitte versuchen Sie es erneut.';
}

/**
 * Die Rückfrage: am Rechner das zentrierte {@code Modal}, am Telefon ein
 * {@code BottomSheet} (E4-Mobil) - beide tragen dieselbe Folgenliste und die
 * Namen-Bestätigung. Der Bestätigungsknopf bleibt gesperrt, bis der Name exakt
 * getippt ist (Zwei-Stufen-Schutz für die destruktive Aktion).
 */
function GefahrBestaetigung({
  open,
  title,
  intro,
  folgen,
  confirmName,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  intro: string;
  folgen: EntfernenFolge[];
  confirmName: string;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isPhone = useIsPhone();
  const [getippt, setGetippt] = useState('');
  const gesperrt = getippt.trim() !== confirmName.trim();

  const body = (
    <div className="vp-gz-confirm">
      <p className="vp-gz-intro">{intro}</p>
      <div className="vp-gz-folgen">
        <div className="vp-gz-folgen-h">Was passiert</div>
        <ul data-testid="gz-folgen">
          {folgen.map((f) => (
            <li key={f.text} className={`vp-gz-folge vp-gz-folge--${f.art}`}>
              <span className="vp-gz-marker" aria-hidden>
                {f.art === 'keep' ? '✓' : f.art === 'gone' ? '✕' : 'i'}
              </span>
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="vp-gz-field">
        <Input
          label={`Zum Bestätigen den Namen tippen: „${confirmName}“`}
          placeholder={confirmName}
          value={getippt}
          autoComplete="off"
          spellCheck={false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGetippt(e.target.value)}
        />
      </div>
      {error && (
        <div className="vp-alert vp-alert-err" role="alert" style={{ marginTop: 'var(--vp-space-3)' }}>
          {error}
        </div>
      )}
    </div>
  );

  const footer = (
    <>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        Abbrechen
      </Button>
      <Button
        variant="primary"
        className="vp-gz-danger-fill"
        onClick={onConfirm}
        disabled={busy || gesperrt}
      >
        {busy ? 'Wird entfernt…' : confirmLabel}
      </Button>
    </>
  );

  const kopfIcon: ReactNode = <Icon name="trash" size={20} />;

  // Beim Schließen den getippten Namen vergessen, damit die nächste Rückfrage
  // wieder sicher gesperrt startet.
  const abbrechen = () => {
    setGetippt('');
    onCancel();
  };

  if (isPhone) {
    return (
      <BottomSheet open={open} title={title} onClose={abbrechen} footer={footer} className="vp-gz-sheet">
        {body}
      </BottomSheet>
    );
  }
  return (
    <Modal open={open} onClose={abbrechen} title={title} icon={kopfIcon} footer={footer}>
      {body}
    </Modal>
  );
}
