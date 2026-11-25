/**
 * Die Seite „Direktvermarktung" einer Anlage (Konzept vp-direktvermarktung-konzept d2 §7.3): eine eigene Seite
 * `#/anlage/{id}/direktvermarktung`, eine Ebene unter „Anlage" wie die Box-Seite (OHNE_BEREICHS_REITER), eigener
 * Rückweg „‹ Einstellungen". Eine Seite für alles (Regel 1, §7.2): Einrichten, Alltag, Störung und Ende wohnen
 * hier, mit demselben Verbindungsbild.
 *
 * Stufe 3 ohne Zustellung: die Zugangsdatei (ZIP+Passwort) ist ein eigener, sicherheitskritischer Auftrag - diese
 * Seite zeigt den Schritt „Zugangsdatei hochladen" darum als den nächsten, noch nicht freigeschalteten Schritt.
 * Ohne Box-Herzschlag bleiben die operativen Lagen (verbunden/begrenzt/gestört) im echten Betrieb unerreichbar;
 * die Bühne (E2E, gemockte Antworten) beweist trotzdem jeden Bildschirm.
 */
import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { ApiError, type Site } from '../api';
import { ablehnungGrund } from '../api';
import { api } from '../apiVoll';
import {
  anzeige,
  fortschrittIndex,
  FORTSCHRITT_STATIONEN,
  ZUSTIMMUNG_TEXTFASSUNG_1,
  type DirektvermarktungPartner,
  type DirektvermarktungStatus,
} from '../direktvermarktung';
import { anlageRoute, hashForRoute } from '../nav';
import { LIVE_POLL_MS } from '../pollCadence';
import { einstellungenHash } from '../settingsNav';
import '../components/GeraetBrotkrume.css';
import '../boxweg/BoxWeg.css';
import './DirektvermarktungSection.css';

function Brotkrume({ site }: { site: Site }) {
  return (
    <nav className="vp-geraet-brotkrume" aria-label="Pfad zur Direktvermarktung">
      <a href={hashForRoute(anlageRoute(site.id))}>Anlage</a>
      <Icon name="chevron-right" size={13} />
      <a href={einstellungenHash(site.id, 'geld')}>Einstellungen</a>
      <Icon name="chevron-right" size={13} />
      <span aria-current="page">Direktvermarktung</span>
    </nav>
  );
}

type Schritt = 'waehlen' | 'vertrag' | 'zustimmen';

/** Der Einrichtungs-Assistent (Blätter/Modal, §7.3 "Aufgaben"): wählen, Vertragsfrage, Zustimmen. */
function EinrichtenModal({ site, status, onClose, onFertig }: {
  site: Site;
  status: DirektvermarktungStatus;
  onClose: () => void;
  onFertig: (status: DirektvermarktungStatus) => void;
}) {
  const [schritt, setSchritt] = useState<Schritt>('waehlen');
  const [partner, setPartner] = useState<string>(status.katalog[0]?.partner ?? '');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const gewaehlt = status.katalog.find((p) => p.partner === partner) ?? null;

  const weiterZuVertrag = () => {
    if (!partner) {
      setFehler('Bitte einen Direktvermarkter wählen.');
      return;
    }
    setFehler(null);
    setSchritt('vertrag');
  };

  const waehlenUndZustimmen = async () => {
    setBusy(true);
    setFehler(null);
    try {
      await api.direktvermarktungWaehlen(site.id, partner);
      const neu = await api.direktvermarktungZustimmen(site.id, ZUSTIMMUNG_TEXTFASSUNG_1);
      onFertig(neu);
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Das hat leider nicht geklappt. Bitte erneut versuchen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} blatt title="Direktvermarktung">
      {schritt === 'waehlen' && (
        <div className="vp-dv-schritt">
          <p>Wer vermarktet Ihren Strom?</p>
          <ul className="vp-dv-partnerliste">
            {status.katalog.map((p) => (
              <li key={p.partner}>
                <label className="vp-dv-partnerzeile">
                  <input type="radio" name="partner" checked={partner === p.partner}
                    onChange={() => setPartner(p.partner)} />
                  <span className="vp-dv-partnerkuerzel" aria-hidden="true">{p.name.slice(0, 2).toUpperCase()}</span>
                  <span>{p.name}</span>
                </label>
              </li>
            ))}
            {status.katalog.length === 0 && <li className="vp-dv-hinweis">Noch kein Direktvermarkter hinterlegt.</li>}
          </ul>
          {gewaehlt?.vertragLink && (
            <a href={gewaehlt.vertragLink} target="_blank" rel="noopener noreferrer">
              Noch kein Vertrag? Erlös bei {gewaehlt.name} berechnen
            </a>
          )}
          {fehler && <p className="vp-alert vp-alert-err">{fehler}</p>}
          <Button onClick={weiterZuVertrag} fullWidth>Weiter mit {gewaehlt?.name ?? 'Direktvermarkter'}</Button>
        </div>
      )}
      {schritt === 'vertrag' && (
        <div className="vp-dv-schritt">
          <h3>Das darf {gewaehlt?.name} an Ihrer Anlage</h3>
          <p>{ZUSTIMMUNG_TEXTFASSUNG_1}</p>
          <div className="vp-dv-chipreihe">
            <span className="vp-dv-chip">Wirkt auf: Erzeugung</span>
            <span className="vp-dv-chip">Wirkt auf: Erlöse</span>
          </div>
          <label className="vp-dv-zustimmzeile">
            <input type="checkbox" required />
            <span>Ich stimme zu. Zeit und Name werden festgehalten.</span>
          </label>
          {fehler && <p className="vp-alert vp-alert-err">{fehler}</p>}
          <div className="vp-dv-fussreihe">
            <Button variant="outline" onClick={() => setSchritt('waehlen')}>Zurück</Button>
            <Button onClick={() => void waehlenUndZustimmen()} disabled={busy}>
              {busy ? 'Einen Moment …' : 'Zustimmen'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function DirektvermarktungSection({ site }: { site: Site }) {
  const [status, setStatus] = useState<DirektvermarktungStatus | null>(null);
  const [fehler, setFehler] = useState(false);
  const [assistentOffen, setAssistentOffen] = useState(false);
  const [jetzt, setJetzt] = useState(() => new Date());

  const lade = () => {
    api.direktvermarktung(site.id).then(setStatus).catch(() => setFehler(true));
  };
  useEffect(() => {
    setStatus(null);
    setFehler(false);
    lade();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);
  // Die Statuszeile „vor 12 s" lebt von einer laufenden Uhr - sonst stünde beim Öffnen „vor 0 s" fest, bis neu
  // geladen wird (§7.6 "Verbunden · vor 12 s").
  useEffect(() => {
    const id = window.setInterval(() => setJetzt(new Date()), LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  if (fehler) {
    return (
      <div className="vp-dv-seite">
        <Brotkrume site={site} />
        <p className="vp-alert vp-alert-err">Die Direktvermarktung konnte nicht geladen werden.</p>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="vp-dv-seite">
        <Brotkrume site={site} />
        <div className="vp-skeleton" aria-hidden="true" />
      </div>
    );
  }

  const partnerName: string | null = status.partner?.name ?? null;
  const a = anzeige(status.aktuell, partnerName, status.stand, jetzt);
  const zustand = status.aktuell?.zustand ?? null;

  const beenden = async (ende: string) => {
    const neu = await api.direktvermarktungBeenden(site.id, ende);
    setStatus(neu);
  };
  const neuVerbinden = async () => {
    const neu = await api.direktvermarktungNeuVerbinden(site.id);
    setStatus(neu);
  };

  return (
    <div className="vp-dv-seite">
      <Brotkrume site={site} />
      <h1>Direktvermarktung</h1>

      {/* Nicht verbunden (Bildschirm 2): Startseite mit dem einen Einstiegsknopf. */}
      {zustand == null && (
        <Card className="vp-dv-karte">
          <h2>Strom direkt an der Börse verkaufen</h2>
          <p>Ein Direktvermarkter liest Ihre Erzeugung und darf sie begrenzen; dafür bekommen Sie den Börsenpreis
            und eine Marktprämie statt der festen Einspeisevergütung.</p>
          <Button onClick={() => setAssistentOffen(true)}>Direktvermarkter wählen</Button>
        </Card>
      )}

      {/* Im Einrichten (Bildschirme 7-10): der Zugang fehlt noch - ein eigener, sicherheitskritischer Auftrag. */}
      {(zustand === 'entwurf' || zustand === 'wartet_auf_zugang') && (
        <Card className="vp-dv-karte">
          <p className="vp-status-line">
            <span className="vp-status-dot" aria-hidden="true" />
            {a.statuszeile}
          </p>
          <ol className="vp-weg-liste" aria-label="Fortschritt des Einrichtens">
            {FORTSCHRITT_STATIONEN.map((station, i) => {
              const idx = fortschrittIndex(status.aktuell);
              const art = i < idx ? 'is-done' : i === idx ? 'is-active' : '';
              return (
                <li key={station} className={`vp-weg-station ${art}`}>
                  <span className="vp-weg-marke" aria-hidden="true">
                    {i < idx ? <Icon name="check" size={14} /> : i + 1}
                  </span>
                  <span className="vp-weg-label">{station}</span>
                </li>
              );
            })}
          </ol>
          {zustand === 'entwurf' && (
            <>
              <p>Nächster Schritt · Sie</p>
              <Button onClick={() => setAssistentOffen(true)}>Zustimmen</Button>
            </>
          )}
          {zustand === 'wartet_auf_zugang' && (
            <>
              <p>{status.partner?.name ?? status.aktuell?.partner} schickt die Zugangsdatei per E-Mail, dazu das
                Passwort getrennt. Das Hochladen folgt in Kürze an dieser Stelle.</p>
              <p className="vp-dv-hinweis">Nächster Schritt · {status.partner?.name ?? 'Ihr Direktvermarkter'}</p>
            </>
          )}
        </Card>
      )}

      {/* Endet oder Wechsel (§7.6). */}
      {zustand === 'endet' && status.aktuell?.ende && (
        <Card className="vp-dv-karte">
          <p className="vp-status-line">
            <span className="vp-status-dot" aria-hidden="true" />
            {a.statuszeile}
          </p>
          {status.geplant && status.geplanterPartner && (
            <p>Ab dann: {status.geplanterPartner.name}.</p>
          )}
        </Card>
      )}

      {/* Verbunden/begrenzt/gestört (§5.4/§7.6) - operative Lagen, heute nur über die Bühne erreichbar. */}
      {(zustand === 'verbindet' || zustand === 'wartet_auf_partner' || zustand === 'verbunden'
        || zustand === 'gestoert') && (
        <Card className="vp-dv-karte">
          <p className={`vp-status-line${a.farbe === 'grau' ? ' stale' : ''}`} data-farbe={a.farbe}>
            <span className="vp-status-dot" aria-hidden="true" />
            {a.statuszeile}
          </p>
          {status.stand?.vorgabePct != null && (
            <div className="vp-dv-freigabe">
              <span className="vp-dv-freigabe-zahl">{status.stand.vorgabePct} %</span>
              <span>Einspeisung erlaubt</span>
            </div>
          )}
          {(a.farbe === 'bernstein' || a.farbe === 'rot') && (
            <Button onClick={() => void neuVerbinden()}>Jetzt neu verbinden</Button>
          )}
          <details className="vp-dv-beenden">
            <summary>Beenden oder wechseln</summary>
            <Button variant="outline"
              onClick={() => void beenden(new Date(new Date().setMonth(new Date().getMonth() + 1, 0))
                .toISOString().slice(0, 10))}
            >
              Beenden zum Monatsende
            </Button>
          </details>
        </Card>
      )}

      {assistentOffen && (
        <EinrichtenModal
          site={site}
          status={status}
          onClose={() => setAssistentOffen(false)}
          onFertig={(neu) => {
            setStatus(neu);
            setAssistentOffen(false);
          }}
        />
      )}
    </div>
  );
}

/** Für Tests/Wiederverwendung: liest, ob eine Ablehnung „schon_eingerichtet" war. */
export function istSchonEingerichtet(e: unknown): boolean {
  return ablehnungGrund(e) === 'schon_eingerichtet';
}

export type { DirektvermarktungPartner };
