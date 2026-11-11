import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type EdgeVersion, type SiteComponentRow } from '../api';
import { consumersApi } from '../consumers/consumersApi';
import type { ManualOverride } from '../consumers/fulfillment';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import type { Consumer } from '../consumers/types';
import {
  abweichungHinweis,
  ANSCHLUSS_OFFEN_SATZ,
  ANSCHLUSS_WAHL,
  anschlussOffen,
  HAND_MINUTEN,
  handEingriff,
  handWunsch,
  heizstabVerbindung,
  kwText,
  leistungJePhase,
  nurZusammen,
  phaseTippen,
  phasenAnsicht,
  phasenFaehig,
  phasenZeilen,
  reglerSatz,
  smartWiederAb,
  smartZustand,
  stufeText,
  zustandsSatz,
  type Anschluss,
} from '../heizstab';
import { testErgebnis } from '../komponentenAssistent';
import { anlageRoute, geraetSeiteHash, hashForRoute, komponenteHash } from '../nav';
import { LIVE_POLL_MS } from '../pollCadence';
import { quelleChip, type SiteVerbraucher } from '../verbraucherZone';
import { Recht } from './Recht';
import './Heizstab.css';

/** Die Stufen eines Heizstabs aus seinem Profil: kW je Stufe und daraus die Zahl der Phasen. */
export function heizStufen(consumer: Consumer, kanaele: number): { stufe: number; ausgaenge: number; kw: number }[] {
  const levels = (consumer.levelsKw ?? []).filter((k) => k > 0).sort((a, b) => a - b);
  const jeElement = consumer.ratedPowerKw > 0 && kanaele > 0 ? consumer.ratedPowerKw / kanaele : null;
  return levels.map((kw, i) => ({
    stufe: i + 1,
    ausgaenge: jeElement ? Math.max(1, Math.round(kw / jeElement)) : i + 1,
    kw,
  }));
}

/** Der Link in die Steuerung: dort öffnet das Blatt des Geräts mit offenen Einstellungen. */
export function einstellungenHash(siteId: string, entityId: string): string {
  return `${hashForRoute(anlageRoute(siteId, 'steuerung'))}?einstellungen=${encodeURIComponent(entityId)}`;
}

/** Ein Schalter wie in Home Assistant: die Stellung ist, was bestätigt ist. */
function Schalter({ an, warte = false, unbekannt = false, label, disabled, onClick }: {
  an: boolean;
  warte?: boolean;
  unbekannt?: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={unbekannt ? 'mixed' : an}
      aria-label={label}
      className={`vp-hz-sw${an ? ' is-an' : ''}${warte ? ' is-warte' : ''}${unbekannt ? ' is-unbekannt' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="vp-hz-sw-knopf" aria-hidden="true">{unbekannt ? '?' : ''}</span>
    </button>
  );
}

/**
 * Die Steuerung eines Heizstabs (Konzept „Phasen schalten“, entschieden 05.11.2026: D1-A, D2-A, D3-A) - auf
 * seiner Geräteseite und im Steuer-Dialog gleich:
 *
 * - oben **Smart** mit eigenem Schalter: aus = Smart ruht (das Pausieren des Geräts), der Stab bleibt aus;
 * - darunter **ein Schalter je Phase**. Seine Stellung ist, was der Shelly BESTÄTIGT hat; ein angefragter Wechsel
 *   wartet sichtbar, ohne Rückmeldung steht „?“. Ein Tipp schaltet von Hand: Smart ruht, und zwei Stunden nach
 *   dem letzten Tipp übernimmt Smart wieder (oder sofort mit „Zurück zu Smart“);
 * - eine Box ohne `heizstab_phasen` schaltet nur Stufen, dann stehen Stufen da; ein Stab „nur alle zusammen“
 *   hat einen Schalter;
 * - Seltenes liegt unter **Einstellungen** (eine Zeile zum Aufklappen).
 *
 * Schutzgrenzen, Thermostat und Totmann der Box gelten immer; ein offener Anschluss sperrt jedes Schalten.
 */
export function HeizstabKarte({
  siteId,
  consumer,
  status,
  override,
  kanaele,
  jetzt,
  komponente = null,
  onGeaendert,
  einstellungen = true,
  zurGeraeteseite = null,
  gesperrt = null,
}: {
  siteId: string;
  consumer: Consumer;
  status: ConsumerRuntimeStatus | null;
  override: ManualOverride | null;
  kanaele: number;
  jetzt: Date;
  /** Die Komponente des Heizstabs: ihre Verbindung trägt Ausgänge, Stufen, Anschluss und Phasenwahl. */
  komponente?: SiteComponentRow | null;
  onGeaendert: () => void;
  /** false im Steuer-Dialog: dort stehen die Einstellungen des Dialogs selbst. */
  einstellungen?: boolean;
  /** Im Steuer-Dialog: der Weg zur Geräteseite. */
  zurGeraeteseite?: string | null;
  /**
   * Der Satz, warum gerade kein Eingriff geht (Ruhe der Anlage, UEMS R0); der Dialog zeigt ihn. Gesperrt sind
   * Phasen, Stufen und der Smart-Schalter - nur „Zurück zu Smart“ beendet einen laufenden Eingriff.
   */
  gesperrt?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [hinweisNachTipp, setHinweisNachTipp] = useState<string | null>(null);
  const [versionen, setVersionen] = useState<EdgeVersion[] | null>(null);
  const [zone, setZone] = useState<SiteVerbraucher | null>(null);
  const [zoneKey, setZoneKey] = useState(0);

  useEffect(() => {
    let aktiv = true;
    api.edgeVersions()
      .then((antwort) => { if (aktiv) setVersionen(antwort.eintraege); })
      .catch(() => { if (aktiv) setVersionen(null); });
    return () => { aktiv = false; };
  }, [siteId]);
  useEffect(() => {
    let aktiv = true;
    api.siteVerbraucher(siteId)
      .then((z) => { if (aktiv) setZone(z); })
      .catch(() => { if (aktiv) setZone(null); });
    return () => { aktiv = false; };
  }, [siteId, zoneKey]);

  const conn = komponente?.connection ?? null;
  const stufe = status?.stufe ?? null;
  const offen = anschlussOffen(conn);
  const hand = handEingriff(override, jetzt);
  const wunsch = handWunsch(override, jetzt);
  const zeilen = phasenZeilen(conn, stufe, wunsch);
  const faehig = phasenFaehig(versionen, siteId);
  const zusammen = nurZusammen(conn);
  const smart = smartZustand(consumer.controlActivation, hand);
  const abweichung = abweichungHinweis(stufe, jetzt);
  const regler = reglerSatz(status?.heizstab ?? null);
  const eintrag = zone?.verbraucher.find((v) => v.entityId === consumer.id) ?? null;
  const smartArt = eintrag ? quelleChip(eintrag.steuerart) : null;

  const lauf = async (fn: () => Promise<string | null | void>, fehlerSatz: string) => {
    setBusy(true);
    setFehler(null);
    setHinweisNachTipp(null);
    try {
      const satz = await fn();
      if (satz) setHinweisNachTipp(satz);
      onGeaendert();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : fehlerSatz);
    } finally {
      setBusy(false);
    }
  };

  // Ein Tipp schaltet von Hand: zwei Stunden ab jetzt, danach Smart (D1-A).
  const handStart = (body: { ausgaenge?: number[]; stufe?: number }) => lauf(async () => {
    const out = await consumersApi.startOverride(siteId, consumer.id, { action: 'start', durationMinutes: HAND_MINUTEN, ...body });
    return out && out.phasenGenau === false && out.pushed ? out.message : null;
  }, 'Der Heizstab ließ sich nicht schalten.');
  const handAus = () => lauf(async () => {
    await consumersApi.startOverride(siteId, consumer.id, { action: 'stop', durationMinutes: HAND_MINUTEN });
  }, 'Der Heizstab ließ sich nicht ausschalten.');
  const zurueckZuSmart = () => lauf(async () => {
    await consumersApi.clearOverride(siteId, consumer.id);
    if (consumer.controlActivation === 'paused') {
      const r = await consumersApi.resume(siteId, consumer.id);
      if (r && r.activated === false) return r.message;
    }
    return null;
  }, 'Smart ließ sich nicht fortsetzen.');
  const smartRuhen = () => lauf(async () => {
    await consumersApi.pause(siteId, consumer.id);
  }, 'Smart ließ sich nicht anhalten.');

  const phaseTipp = (kanal: number) => {
    const t = phaseTippen(conn, zeilen, kanal);
    if (t.art === 'fehler') {
      setFehler(t.satz);
      return;
    }
    if (t.art === 'stop') void handAus();
    else void handStart({ ausgaenge: t.ausgaenge });
  };

  // Was die Stufe bestätigt (für die Stufenwahl einer älteren Box und den Stab „nur alle zusammen“).
  const bestaetigt = stufe?.confirmed ?? null;
  const gewuenschteStufe = wunsch !== null ? wunsch.length
    : hand?.kind === 'start' && hand.targetValue != null
      ? heizStufen(consumer, kanaele).find((s) => Math.abs(s.kw - (hand.targetValue ?? 0)) < 1e-6)?.ausgaenge ?? null
      : null;
  const stufenWahl = heizStufen(consumer, kanaele);
  const n = zeilen.length || kanaele;
  const jePhase = leistungJePhase(zeilen);

  let steuerung: ReactNode;
  if (zusammen) {
    const an = gewuenschteStufe !== null ? gewuenschteStufe > 0 : bestaetigt === null ? null : bestaetigt > 0;
    const warte = gewuenschteStufe !== null && bestaetigt !== null && (gewuenschteStufe > 0) !== (bestaetigt > 0);
    const gesamt = zeilen.reduce((a, z) => a + (z.kw ?? 0), 0);
    steuerung = (
      <>
        <div className="vp-hz-titel"><span>Heizstab</span>{gesamt > 0 && <em>{kwText(gesamt)}</em>}</div>
        <ul className="vp-hz-phasen-liste">
          <li>
            <span className="vp-hz-ph">{n > 1 ? `L1–${n}` : 'L1'}</span>
            <span className="vp-hz-wert">
              <b>{an === null ? '?' : warte ? (an ? 'schaltet ein …' : 'schaltet aus …') : an ? 'an' : 'aus'}</b>
              {n > 1 && jePhase && <small>{n} × {jePhase.replace(' je Phase', '')} zusammen</small>}
            </span>
            <Recht aktion="handeingriff.setzen">
              <Schalter
                an={an === true}
                warte={warte}
                unbekannt={an === null}
                label={`Heizstab ${an ? 'ausschalten' : 'einschalten'}`}
                disabled={busy || offen || gesperrt != null}
                onClick={() => (an ? void handAus() : void handStart({ stufe: stufenWahl.length || undefined }))}
              />
            </Recht>
          </li>
        </ul>
      </>
    );
  } else if (faehig === true) {
    steuerung = (
      <>
        <div className="vp-hz-titel"><span>Phasen</span>{jePhase && <em>{jePhase}</em>}</div>
        <ul className="vp-hz-phasen-liste" aria-label="Phasen">
          {zeilen.map((z) => {
            const v = phasenAnsicht(z, stufe);
            const an = v.stellung === 'an' || v.stellung === 'warte-an';
            return (
              <li key={z.kanal} data-testid={`heizstab-phase-${z.label}`}>
                <span className="vp-hz-ph">{z.label}</span>
                <span className="vp-hz-wert">
                  <b>
                    <span className={`vp-hz-punkt is-${v.stellung}`} aria-hidden="true" />
                    {v.wort}
                  </b>
                  {v.unter && <small>{v.unter}</small>}
                </span>
                <Recht aktion="handeingriff.setzen">
                  <Schalter
                    an={an}
                    warte={v.stellung.startsWith('warte')}
                    unbekannt={v.stellung === 'unbekannt'}
                    label={`${z.label} ${an ? 'ausschalten' : 'einschalten'}`}
                    disabled={busy || offen || gesperrt != null}
                    onClick={() => phaseTipp(z.kanal)}
                  />
                </Recht>
              </li>
            );
          })}
        </ul>
      </>
    );
  } else {
    // Eine Box ohne heizstab_phasen (oder ein noch unbekannter Stand): sie schaltet Stufen, keine Phasen.
    const gedrueckt = gewuenschteStufe ?? bestaetigt;
    steuerung = (
      <>
        <div className="vp-hz-titel">
          <span>Stufe</span>
          {faehig === false && <em>Einzelne Phasen nach dem nächsten Update der Box</em>}
        </div>
        <Recht aktion="handeingriff.setzen">
          <ul className="vp-hz-tasten" aria-label="Stufe">
            <li>
              <button type="button" aria-pressed={gedrueckt === 0} disabled={busy || offen || gesperrt != null} onClick={() => void handAus()}>Aus</button>
            </li>
            {stufenWahl.map((s) => (
              <li key={s.stufe}>
                <button
                  type="button"
                  aria-pressed={gedrueckt === s.ausgaenge}
                  disabled={busy || offen || gesperrt != null}
                  onClick={() => void handStart({ stufe: s.stufe })}
                >
                  {stufeText(s.ausgaenge)}
                </button>
              </li>
            ))}
          </ul>
        </Recht>
        <p className="vp-hz-unter">{zustandsSatz(stufe)}</p>
      </>
    );
  }

  return (
    <div className="vp-hz" data-testid="heizstab-karte">
      {(offen || abweichung) && (
        <div className="vp-hz-abschnitt">
          {offen && (
            <p className="vp-hz-hinweis" role="status" data-testid="heizstab-anschluss-offen">
              <Icon name="alert-triangle" size={15} />
              <span>{ANSCHLUSS_OFFEN_SATZ}</span>
            </p>
          )}
          {abweichung && (
            <p className="vp-hz-hinweis" role="status">
              <Icon name="alert-triangle" size={15} />
              <span>{abweichung}</span>
            </p>
          )}
        </div>
      )}

      <div className={`vp-hz-smart${smart.an ? '' : ' is-ruht'}`} data-testid="heizstab-smart">
        <span className="vp-hz-smart-ic" aria-hidden="true"><Icon name={smart.an ? 'sun' : hand ? 'hand' : 'info'} size={18} /></span>
        <span className="vp-hz-smart-txt">
          <b>{smart.titel}{smart.an && smartArt ? <> · <span className="vp-hz-art">{smartArt}</span></> : null}</b>
          <small>{smart.ruht ?? regler ?? zustandsSatz(stufe)}</small>
        </span>
        {smart.schalter && (
          <Recht aktion={hand ? 'handeingriff.setzen' : 'betriebsweise.aendern'}>
            <Schalter
              an={smart.an}
              label={smart.an ? 'Smart ruhen lassen' : 'Smart einschalten'}
              disabled={busy || (gesperrt != null && !hand)}
              onClick={() => (smart.an ? void smartRuhen() : void zurueckZuSmart())}
            />
          </Recht>
        )}
      </div>

      <div className="vp-hz-abschnitt">{steuerung}</div>

      {hand && (
        <div className="vp-hz-hand" data-testid="heizstab-hand">
          <span><Icon name="hand" size={15} /> <b>Von Hand</b> · {smartWiederAb(hand.endsAt)}</span>
          <Recht aktion="handeingriff.setzen">
            <Button variant="outline" size="sm" onClick={() => void zurueckZuSmart()} disabled={busy}>Zurück zu Smart</Button>
          </Recht>
        </div>
      )}
      {hinweisNachTipp && <p className="vp-hz-unter" role="status">{hinweisNachTipp}</p>}
      {fehler && <p className="vp-hz-fehler" role="alert">{fehler}</p>}

      {einstellungen && (
        <HeizstabEinstellungen
          siteId={siteId}
          consumer={consumer}
          komponente={komponente}
          smartArt={smartArt}
          platz={eintrag ? platzText(zone, consumer.id) : null}
          regeln={eintrag?.regeln ?? null}
          onGeaendert={() => { setZoneKey((k) => k + 1); onGeaendert(); }}
        />
      )}
      {zurGeraeteseite && (
        <a className="vp-hz-link" href={zurGeraeteseite}>Zur Geräteseite <Icon name="chevron-right" size={15} /></a>
      )}
    </div>
  );
}

/** „Platz 1 von 3“ in der Reihenfolge für Sonnenstrom, null ohne Platz. */
function platzText(zone: SiteVerbraucher | null, id: string): string | null {
  const liste = zone?.rangliste ?? [];
  const i = liste.findIndex((e) => (e as { entityId?: string | null }).entityId === id);
  return i >= 0 ? `Platz ${i + 1} von ${liste.length}` : null;
}

const ANSCHLUSS_KURZ: Record<Anschluss, string> = {
  stern_mit_n: 'Stern mit N',
  ohne_n: 'ohne N',
  dreieck: 'Dreieck',
  unbekannt: 'Anschluss offen',
};

/**
 * Die eine Zeile „Einstellungen“ (D2-A): zugeklappt die Werte als kurze Zeile, aufgeklappt Smart-Art, Speicher,
 * Reihenfolge, Bedingungen und Technik. Die Ausgänge und die Phase für Stufe 1 lassen sich hier ändern - so
 * lässt sich ein Stab reparieren, der mit zu wenigen Ausgängen angelegt wurde (Fall GATE, 05.11.2026).
 */
function HeizstabEinstellungen({ siteId, consumer, komponente, smartArt, platz, regeln, onGeaendert }: {
  siteId: string;
  consumer: Consumer;
  komponente: SiteComponentRow | null;
  smartArt: string | null;
  platz: string | null;
  regeln: number | null;
  onGeaendert: () => void;
}) {
  const conn = komponente?.connection ?? null;
  const chs = Array.isArray(conn?.channels) ? (conn!.channels as number[]) : [];
  const kw = Array.isArray(conn?.output_kw) ? (conn!.output_kw as number[]) : [];
  const anschluss = (typeof conn?.anschluss === 'string' ? conn.anschluss : 'unbekannt') as Anschluss;
  const rotation: 'daily' | 'fixed' = conn?.rotation === 'fixed' ? 'fixed' : 'daily';
  const hilft = consumer.allowStorageDischarge;
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neueZahl, setNeueZahl] = useState<number | null>(null);

  const kurz = [
    smartArt,
    hilft ? 'Speicher hilft' : 'Speicher hilft nicht',
    platz,
    'Technik',
  ].filter(Boolean).join(' · ');

  /** Prüft die neue Verbindung an der Box und speichert sie erst danach (wie beim Anlegen). */
  const verbindungSpeichern = async (connection: Record<string, unknown>) => {
    if (!komponente?.templateRef) return;
    setBusy(true);
    setFehler(null);
    try {
      const test = testErgebnis(
        await api.testComponentConnection(siteId, {
          templateRef: komponente.templateRef,
          templateVersion: komponente.templateVersion ?? undefined,
          role: komponente.role ?? 'consumer',
          connection,
          entityId: komponente.id,
        }),
      );
      if (test.zustand !== 'bestanden') {
        setFehler(`Nicht geändert: ${test.text}`);
        return;
      }
      await api.updateComponent(siteId, komponente.id, {
        templateRef: komponente.templateRef,
        templateVersion: komponente.templateVersion ?? undefined,
        label: komponente.label ?? undefined,
        role: komponente.role ?? 'consumer',
        connection,
        expectedRevision: komponente.definitionVersion,
        effectiveAt: new Date().toISOString(),
      });
      setNeueZahl(null);
      onGeaendert();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Die Einstellung ließ sich nicht ändern.');
    } finally {
      setBusy(false);
    }
  };
  const ausgaengeSpeichern = (zahl: number) => {
    const jeElement = kw[0] ?? (consumer.ratedPowerKw > 0 && chs.length > 0 ? consumer.ratedPowerKw / chs.length : 0);
    // Teilstufen nur bei Stern mit N und Elementen bis 4,6 kW (dieselbe Regel wie Box und API).
    const teil = anschluss === 'stern_mit_n' && jeElement <= 4.6;
    void verbindungSpeichern(heizstabVerbindung(conn ?? {}, {
      kanaele: zahl,
      kwJeElement: jeElement,
      stufen: teil ? Array.from({ length: zahl }, (_, k) => k + 1) : [zahl],
      rotation,
      anschluss,
    }));
  };
  const speicher = async () => {
    setBusy(true);
    setFehler(null);
    try {
      await consumersApi.patch(siteId, consumer.id, { allowStorageDischarge: !hilft, expectedVersion: consumer.version });
      onGeaendert();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Die Einstellung ließ sich nicht ändern.');
    } finally {
      setBusy(false);
    }
  };
  const zeigtPhasenwahl = chs.length > 1 && Array.isArray(conn?.stages) && (conn!.stages as number[]).includes(1);
  const zahlWahl = neueZahl ?? chs.length;

  return (
    <details className="vp-hz-mehr" data-testid="heizstab-einstellungen">
      <summary>
        <span>Einstellungen</span>
        <small>{kurz}</small>
      </summary>
      <div className="vp-hz-mehr-inhalt">
        <div className="vp-hz-zeile">
          <b>Smart-Art</b>
          <span>{smartArt ?? '–'}</span>
          <a href={einstellungenHash(siteId, consumer.id)}>Ändern</a>
        </div>
        <div className="vp-hz-zeile">
          <b>Speicher darf aushelfen</b>
          <span />
          <Recht aktion="betriebsweise.aendern">
            <Schalter an={hilft} label="Speicher darf aushelfen" disabled={busy} onClick={() => void speicher()} />
          </Recht>
        </div>
        <div className="vp-hz-zeile">
          <b>Reihenfolge</b>
          <span>{platz ?? 'nach Zeit, Frist oder Preis'}</span>
          <a href={einstellungenHash(siteId, consumer.id)}>Ändern</a>
        </div>
        <div className="vp-hz-zeile">
          <b>Bedingungen</b>
          <span>{regeln == null ? '–' : regeln === 0 ? 'keine' : regeln === 1 ? '1 Regel' : `${regeln} Regeln`}</span>
          <a href={einstellungenHash(siteId, consumer.id)}>Ändern</a>
        </div>
        <section className="vp-hz-technik" aria-labelledby={`hz-technik-${consumer.id}`}>
          <h4 id={`hz-technik-${consumer.id}`}>Technik</h4>
          <p className="vp-hz-unter">
            {chs.length === 1 ? '1 Ausgang' : `${chs.length} Ausgänge`}
            {kw[0] != null ? ` · ${kwText(kw[0])} je Element` : ''} · {ANSCHLUSS_KURZ[anschluss] ?? ANSCHLUSS_WAHL[3].titel}
          </p>
          <Recht aktion="geraet.einrichten">
            <div className="vp-hz-gruppe" role="group" aria-labelledby={`hz-ausgaenge-${consumer.id}`}>
              <span className="vp-hz-gruppe-wort" id={`hz-ausgaenge-${consumer.id}`}>Ausgänge am Shelly</span>
              <ul className="vp-hz-tasten">
                {[1, 2, 3, 4].map((z) => (
                  <li key={z}>
                    <button type="button" aria-pressed={zahlWahl === z} disabled={busy} onClick={() => setNeueZahl(z)}>{z}</button>
                  </li>
                ))}
              </ul>
              {neueZahl !== null && neueZahl !== chs.length && (
                <div className="vp-hz-knoepfe">
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => ausgaengeSpeichern(neueZahl)}>
                    {neueZahl === 1 ? '1 Ausgang' : `${neueZahl} Ausgänge`} prüfen und speichern
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setNeueZahl(null)}>Abbrechen</Button>
                </div>
              )}
            </div>
            {zeigtPhasenwahl && (
              <div className="vp-hz-gruppe" role="group" aria-labelledby={`hz-phase-${consumer.id}`}>
                <span className="vp-hz-gruppe-wort" id={`hz-phase-${consumer.id}`}>Smart mit einer Phase</span>
                <ul className="vp-hz-tasten">
                  <li>
                    <button
                      type="button"
                      aria-pressed={rotation === 'daily'}
                      disabled={busy}
                      onClick={() => rotation !== 'daily' && void verbindungSpeichern({ ...conn, rotation: 'daily' })}
                    >
                      Täglich wechselnd
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      aria-pressed={rotation === 'fixed'}
                      disabled={busy}
                      onClick={() => rotation !== 'fixed' && void verbindungSpeichern({ ...conn, rotation: 'fixed' })}
                    >
                      Immer L1
                    </button>
                  </li>
                </ul>
              </div>
            )}
          </Recht>
          {fehler && <p className="vp-hz-fehler" role="alert">{fehler}</p>}
        </section>
      </div>
    </details>
  );
}

/**
 * Die Heizstab-Steuerung im Steuer-Dialog (D2-A: dieselbe Karte wie auf der Geräteseite, ohne Verlauf). Der
 * Dialog kennt Stufe, Handeingriff und Verbindung nicht; diese Hülle lädt sie und fragt im Takt der Live-Werte nach.
 */
export function HeizstabKarteGeladen({ siteId, entityId, gesperrt = null, sonst = null, danach = null }: {
  siteId: string;
  entityId: string;
  gesperrt?: string | null;
  /** Ein Heizstab OHNE Ausgangsmenge (z. B. an einem Ausgang eines I/O-Moduls): der bisherige Dialog. */
  sonst?: ReactNode;
  /** Unter der Karte (der Dialog: seine Einstellungen). */
  danach?: ReactNode;
}) {
  const [daten, setDaten] = useState<{
    consumer: Consumer | null;
    status: ConsumerRuntimeStatus | null;
    override: ManualOverride | null;
    komponente: SiteComponentRow | null;
    seite: string | null;
  } | null>(null);
  const [key, setKey] = useState(0);
  const [jetzt, setJetzt] = useState(() => new Date());

  useEffect(() => {
    let aktiv = true;
    void Promise.all([
      consumersApi.list(siteId).catch(() => null),
      consumersApi.status(siteId).catch(() => null),
      consumersApi.overrides(siteId).catch(() => null),
      api.siteComponents(siteId).catch(() => null),
      api.listDevices().then((d) => d.eintraege).catch(() => null),
    ]).then(([liste, status, overrides, komponenten, boxen]) => {
      if (!aktiv) return;
      const komponente = komponenten?.components.find((r) => r.id === entityId) ?? null;
      const eigene = (boxen ?? []).filter((b) => b.siteId === siteId);
      const quelle = komponente?.edgeSourceId ?? null;
      setDaten({
        consumer: liste?.find((c) => c.id === entityId) ?? null,
        status: status?.find((s) => s.entityId === entityId) ?? null,
        override: overrides?.find((o) => o.entityId === entityId) ?? null,
        komponente,
        seite: eigene.length === 1 && quelle ? geraetSeiteHash(siteId, eigene[0].externalRef, quelle) : komponenteHash(siteId, entityId),
      });
      setJetzt(new Date());
    });
    return () => { aktiv = false; };
  }, [siteId, entityId, key]);
  useEffect(() => {
    const t = window.setInterval(() => setKey((k) => k + 1), LIVE_POLL_MS);
    return () => window.clearInterval(t);
  }, []);

  if (!daten) return <p className="vp-hz-unter" role="status">Lade die Steuerung des Heizstabs …</p>;
  const kanaele = Array.isArray(daten.komponente?.connection?.channels)
    ? (daten.komponente!.connection!.channels as unknown[]).length
    : 0;
  if (!daten.consumer || kanaele === 0) return <>{sonst}</>;
  return (
    <>
    <HeizstabKarte
      siteId={siteId}
      consumer={daten.consumer}
      status={daten.status}
      override={daten.override}
      kanaele={kanaele}
      jetzt={jetzt}
      komponente={daten.komponente}
      onGeaendert={() => setKey((k) => k + 1)}
      einstellungen={false}
      zurGeraeteseite={daten.seite}
      gesperrt={gesperrt}
    />
    {danach}
    </>
  );
}
