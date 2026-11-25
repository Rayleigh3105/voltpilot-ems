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
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { VpDatePicker } from '../components/VpDatePicker';
import { ApiError, type Site } from '../api';
import { ablehnungGrund } from '../api';
import { api } from '../apiVoll';
import {
  anzeige,
  fortschrittIndex,
  FORTSCHRITT_STATIONEN,
  verbindungsbild,
  wohinDerStromGeht,
  ZUSTIMMUNG_TEXTFASSUNG_1,
  ZUSTIMMUNG_ZEILEN,
  type DirektvermarktungPartner,
  type DirektvermarktungStatus,
  type VerbindungsLinie,
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

/** Das Verbindungsbild (§7.2 Regel 1, §7.5): Ihre Anlage · VoltPilot-Box · Partner, mit einer Strecke je Paar. */
function Verbindungsbild({ partnerKuerzel, anlageBox, boxPartner, partnerWarnung }: {
  partnerKuerzel: string;
  anlageBox: VerbindungsLinie;
  boxPartner: VerbindungsLinie;
  partnerWarnung: boolean;
}) {
  return (
    <div className="vp-dv-bild" role="img"
      aria-label={`Ihre Anlage, verbunden mit der VoltPilot-Box, ${partnerWarnung ? 'getrennt von' : 'verbunden mit'} ${partnerKuerzel}`}>
      <div className="vp-dv-knoten">
        <span className={`vp-dv-kreis${anlageBox !== 'offen' ? ' is-ok' : ''}`}><Icon name="sun" size={18} /></span>
        <small>Ihre Anlage</small>
      </div>
      <span className={`vp-dv-strecke is-${anlageBox}`} aria-hidden="true" />
      <div className="vp-dv-knoten">
        <span className={`vp-dv-kreis${anlageBox === 'fest' ? ' is-ok' : ''}`}><Icon name="cpu" size={18} /></span>
        <small>VoltPilot-Box</small>
      </div>
      <span className={`vp-dv-strecke is-${boxPartner}`} aria-hidden="true" />
      <div className="vp-dv-knoten">
        <span className={`vp-dv-kreis vp-dv-partner${partnerWarnung ? ' is-warnung' : ''}${boxPartner === 'fest' ? ' is-verbunden' : ''}`}>
          {partnerWarnung ? <Icon name="alert-triangle" size={16} /> : partnerKuerzel.slice(0, 2).toUpperCase()}
        </span>
        <small>{partnerKuerzel}</small>
      </div>
    </div>
  );
}

type Schritt = 'waehlen' | 'vertrag';

/** Der Einrichtungs-Assistent (Blätter/Modal, §7.3 "Aufgaben"): wählen, dann Zustimmen. */
function EinrichtenModal({ site, status, onClose, onFertig }: {
  site: Site;
  status: DirektvermarktungStatus;
  onClose: () => void;
  onFertig: (status: DirektvermarktungStatus) => void;
}) {
  const [schritt, setSchritt] = useState<Schritt>('waehlen');
  const [partner, setPartner] = useState<string>(status.katalog[0]?.partner ?? '');
  const [einVerstanden, setEinVerstanden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const gewaehlt = status.katalog.find((p) => p.partner === partner) ?? null;
  const schrittNr = schritt === 'waehlen' ? 1 : 3;

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
    <Modal open onClose={onClose} blatt
      icon={schritt === 'vertrag' ? (
        <button type="button" className="vp-dv-zurueck" aria-label="Zurück" onClick={() => setSchritt('waehlen')}>
          <Icon name="chevron-left" size={18} />
        </button>
      ) : undefined}
      title={<span className="vp-dv-blatttitel">Direktvermarkter<small>{schrittNr} von 4</small></span>}>
      {schritt === 'waehlen' && (
        <div className="vp-dv-schritt">
          <h3>Wer vermarktet Ihren Strom?</h3>
          <ul className="vp-dv-partnerliste">
            {status.katalog.map((p) => (
              <li key={p.partner}>
                <label className={`vp-dv-partnerzeile${partner === p.partner ? ' is-gewaehlt' : ''}`}>
                  <input type="radio" name="partner" checked={partner === p.partner}
                    onChange={() => setPartner(p.partner)} />
                  <span className="vp-dv-partnerkuerzel" aria-hidden="true">{p.partner.slice(0, 2).toUpperCase()}</span>
                  <span className="vp-dv-partnertext">
                    <b>{p.name}</b>
                    <small>Einrichten hier im Portal</small>
                  </span>
                </label>
              </li>
            ))}
            <li>
              <label className="vp-dv-partnerzeile is-weiterer">
                <input type="radio" name="partner" checked={false} readOnly
                  onClick={() => setFehler('Diesen Direktvermarkter richten wir noch nicht automatisch ein. '
                      + 'Wir merken uns Ihren Wunsch.')} />
                <span className="vp-dv-partnerkuerzel is-weiterer" aria-hidden="true">+</span>
                <span className="vp-dv-partnertext">
                  <b>Ein anderer</b>
                  <small>Sagen Sie uns, welcher.</small>
                </span>
              </label>
            </li>
            {status.katalog.length === 0 && <li className="vp-dv-hinweis">Noch kein Direktvermarkter hinterlegt.</li>}
          </ul>
          {gewaehlt?.vertragLink && (
            <a href={gewaehlt.vertragLink} target="_blank" rel="noopener noreferrer">
              Noch kein Vertrag? Erlös bei {gewaehlt.name} berechnen
            </a>
          )}
          {fehler && <p className="vp-alert vp-alert-info">{fehler}</p>}
          <Button onClick={weiterZuVertrag} fullWidth>Weiter mit {gewaehlt?.partner ?? 'Direktvermarkter'}</Button>
        </div>
      )}
      {schritt === 'vertrag' && (
        <div className="vp-dv-schritt">
          <h3>Das darf {gewaehlt?.name} an Ihrer Anlage</h3>
          <ul className="vp-dv-zustimmliste">
            {ZUSTIMMUNG_ZEILEN.map((z) => (
              <li key={z.text}>
                <span className="vp-dv-zustimmicon"><Icon name={z.icon as IconName} size={18} /></span>
                <span>{z.text}</span>
              </li>
            ))}
          </ul>
          <div className="vp-alert vp-alert-ok vp-dv-bleibt">
            <b>BLEIBT IMMER SO</b>
            <p>Netzbetreiber und Schutz gehen vor.</p>
          </div>
          <label className="vp-dv-zustimmzeile">
            <input type="checkbox" checked={einVerstanden} onChange={(e) => setEinVerstanden(e.target.checked)} />
            <span>Ich stimme dem Datenaustausch mit {gewaehlt?.name} zu.</span>
          </label>
          {fehler && <p className="vp-alert vp-alert-err">{fehler}</p>}
          <Button onClick={() => void waehlenUndZustimmen()} disabled={busy || !einVerstanden} fullWidth>
            {busy ? 'Einen Moment …' : 'Zustimmen'}
          </Button>
          <p className="vp-dv-fussnotiz">Jederzeit beendbar</p>
        </div>
      )}
    </Modal>
  );
}

/** Das Blatt "Beenden" (§7.6, Bildschirm 27): Monatsende vorgewählt, zwei Folgen, oder stattdessen wechseln. */
function BeendenModal({ site, status, onClose, onFertig }: {
  site: Site;
  status: DirektvermarktungStatus;
  onClose: () => void;
  onFertig: (status: DirektvermarktungStatus) => void;
}) {
  const monatsende = new Date(new Date().setMonth(new Date().getMonth() + 1, 0)).toISOString().slice(0, 10);
  const heuteIso = new Date().toISOString().slice(0, 10);
  const [eigenesDatum, setEigenesDatum] = useState(false);
  const [datum, setDatum] = useState(monatsende);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const name = status.partner?.name ?? status.aktuell?.partner ?? 'Ihrem Direktvermarkter';
  const anzeigeDatum = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
      .format(new Date(datum));

  const beenden = async () => {
    setBusy(true);
    setFehler(null);
    try {
      onFertig(await api.direktvermarktungBeenden(site.id, datum));
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Das hat leider nicht geklappt. Bitte erneut versuchen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} blatt title="Beenden">
      <div className="vp-dv-schritt">
        <h3>Direktvermarktung mit {name} beenden</h3>
        <p className="vp-dv-fussnotiz">ZUM</p>
        <div className="vp-dv-datumwahl">
          <button type="button" className={`vp-dv-datumknopf${!eigenesDatum ? ' is-gewaehlt' : ''}`}
            onClick={() => { setEigenesDatum(false); setDatum(monatsende); }}>
            {new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
                .format(new Date(monatsende))} · Monatsende
          </button>
          <button type="button" className={`vp-dv-datumknopf${eigenesDatum ? ' is-gewaehlt' : ''}`}
            onClick={() => setEigenesDatum(true)}>
            Anderes Datum
          </button>
        </div>
        {eigenesDatum && (
          <VpDatePicker ariaLabel="Enddatum" value={datum} onChange={setDatum} min={heuteIso} />
        )}
        <ul className="vp-dv-zustimmliste">
          <li><span className="vp-dv-zustimmicon"><Icon name="link" size={18} /></span>
            <span>Danach erreicht {name} Ihre Anlage nicht mehr.</span></li>
          <li><span className="vp-dv-zustimmicon"><Icon name="file-text" size={18} /></span>
            <span>Den Vertrag kündigen Sie bei {name}.</span></li>
        </ul>
        {fehler && <p className="vp-alert vp-alert-err">{fehler}</p>}
        <Button onClick={() => void beenden()} disabled={busy} fullWidth>
          Beenden zum {anzeigeDatum}
        </Button>
      </div>
    </Modal>
  );
}

export function DirektvermarktungSection({ site }: { site: Site }) {
  const [status, setStatus] = useState<DirektvermarktungStatus | null>(null);
  const [fehler, setFehler] = useState(false);
  const [assistentOffen, setAssistentOffen] = useState(false);
  const [beendenOffen, setBeendenOffen] = useState(false);
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
  const partnerKuerzel = status.partner?.partner ?? status.aktuell?.partner ?? 'Partner';
  const a = anzeige(status.aktuell, partnerName, status.stand, jetzt);
  const zustand = status.aktuell?.zustand ?? null;
  const bild = verbindungsbild(status.aktuell, status.stand, jetzt);
  const fluss = wohinDerStromGeht(status.stand);
  const vorgabePct = status.stand?.vorgabePct;
  const ruhigerAlltag = (zustand === 'verbunden' || zustand === 'wartet_auf_partner') && !bild.zeigen;

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
          <Verbindungsbild partnerKuerzel={status.katalog[0]?.partner ?? 'Partner'} {...bild} />
          <h2>Strom direkt an der Börse verkaufen</h2>
          <p>Ein Direktvermarkter liest Ihre Erzeugung und darf sie begrenzen; dafür bekommen Sie den Börsenpreis
            und eine Marktprämie statt der festen Einspeisevergütung.</p>
          <Button onClick={() => setAssistentOffen(true)}>Direktvermarkter wählen</Button>
        </Card>
      )}

      {/* Im Einrichten (Bildschirme 7-10): der Zugang fehlt noch - ein eigener, sicherheitskritischer Auftrag. */}
      {(zustand === 'entwurf' || zustand === 'wartet_auf_zugang') && (
        <Card className="vp-dv-karte">
          <Verbindungsbild partnerKuerzel={partnerKuerzel} {...bild} />
          <p className={`vp-status-line${a.farbe === 'grau' ? ' stale' : ''}`} data-farbe={a.farbe}>
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
              <p>Nächster Schritt · Sie</p>
              <h3>Zugangsdatei hochladen</h3>
              <p>{partnerName ?? partnerKuerzel} hat sie per E-Mail geschickt.</p>
              <Button disabled title="Kommt mit der nächsten Veröffentlichung">
                <Icon name="upload" size={16} /> Datei hochladen
              </Button>
              <p className="vp-dv-fussnotiz">Diese Datei prüft das Portal in Kürze an dieser Stelle.</p>
            </>
          )}
        </Card>
      )}

      {/* Endet oder Wechsel (§7.6). */}
      {zustand === 'endet' && status.aktuell?.ende && (
        <Card className="vp-dv-karte">
          <p className={`vp-status-line${a.farbe === 'grau' ? ' stale' : ''}`} data-farbe={a.farbe}>
            <span className="vp-status-dot" aria-hidden="true" />
            {a.statuszeile}
          </p>
          {status.geplant && status.geplanterPartner && (
            <p>Ab dann: {status.geplanterPartner.name}.</p>
          )}
        </Card>
      )}

      {/* Verbunden/begrenzt/gestört (§5.4/§7.6). */}
      {(zustand === 'verbindet' || zustand === 'wartet_auf_partner' || zustand === 'verbunden'
        || zustand === 'gestoert') && (
        <Card className="vp-dv-karte">
          <p className={`vp-status-line${a.farbe === 'grau' ? ' stale' : ''}`} data-farbe={a.farbe}>
            <span className="vp-status-dot" aria-hidden="true" />
            {a.statuszeile}
          </p>
          {bild.zeigen && <Verbindungsbild partnerKuerzel={partnerKuerzel} {...bild} />}
          {ruhigerAlltag && vorgabePct != null && (
            <>
              <p className="vp-dv-kennzeichnung">EINSPEISUNG ERLAUBT</p>
              <div className="vp-dv-freigabe">
                <span className="vp-dv-freigabe-zahl">{vorgabePct}<small>%</small></span>
              </div>
              <div className="vp-dv-balken" role="img" aria-label={`${vorgabePct} von 100 Prozent erlaubt`}>
                <div className="vp-dv-balken-fuellung" style={{ width: `${vorgabePct}%` }} />
              </div>
              <p>{vorgabePct === 100
                ? `${partnerName ?? partnerKuerzel} lässt Ihre Anlage frei einspeisen.`
                : 'Der Speicher lädt zuerst. Abgeregelt wird nur der Rest.'}</p>
              {fluss && (
                <>
                  <p className="vp-dv-kennzeichnung">WOHIN DER STROM GEHT</p>
                  <div className="vp-dv-flussbalken" role="img"
                    aria-label={`Haus ${Math.round(fluss.hausW)} Watt, Netz ${Math.round(fluss.netzW)} Watt`}>
                    <div className="vp-dv-fluss-haus" style={{ flexGrow: Math.max(fluss.hausW, 1) }} />
                    <div className="vp-dv-fluss-netz" style={{ flexGrow: Math.max(fluss.netzW, 1) }} />
                  </div>
                  <div className="vp-dv-flusslegende">
                    <span><i className="vp-dv-punkt-haus" /> Haus {(fluss.hausW / 1000).toFixed(1)} kW</span>
                    <span><i className="vp-dv-punkt-netz" /> Netz {(fluss.netzW / 1000).toFixed(1)} kW</span>
                  </div>
                </>
              )}
            </>
          )}
          {/* Nur bei einem echten Bruch der Partner-Strecke (getrennt) - luox begrenzt ist Vertrag, kein Fehler,
              und bekommt darum keinen "neu verbinden"-Knopf (§7.2 Regel 5). */}
          {bild.boxPartner === 'bruch' && (
            <Button onClick={() => void neuVerbinden()}><Icon name="refresh-cw" size={16} /> Jetzt neu verbinden</Button>
          )}
          <details className="vp-dv-beenden">
            <summary>Beenden oder wechseln</summary>
            <Button variant="outline" onClick={() => setBeendenOffen(true)}>Beenden</Button>
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
      {beendenOffen && (
        <BeendenModal
          site={site}
          status={status}
          onClose={() => setBeendenOffen(false)}
          onFertig={(neu) => {
            setStatus(neu);
            setBeendenOffen(false);
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
