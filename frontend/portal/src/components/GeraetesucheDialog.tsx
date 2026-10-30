import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, neueAnfrageKennung, type SiteComponentRow, type SiteComponents } from '../api';
import type { AufbauKategorie } from '../aufbauBaum';
import type {
  Geraetesuche,
  GeraetesucheArt,
  GeraetesucheFehler,
  GeraetesucheFund,
  GeraetesucheGruppeWort,
  GeraetesucheVerlaufEintrag,
} from '../geraetesuche';
import {
  ART_WORT,
  GRUPPEN_TITEL,
  ausDerSuche,
  artText,
  bauart,
  endHinweis,
  erkennungWort,
  ergebnisTitel,
  fortschritt,
  fundAdresse,
  fundAktion,
  fundHinweis,
  fundTitel,
  fundZeile,
  GERAETESUCHE_POLL_MS,
  istUebernommen,
  klopftAnZeile,
  laeuftNoch,
  merkmalText,
  nichtsGefunden,
  nichtsGefundenFragen,
  offeneAusgaenge,
  startFehlerSatz,
  uebernahmeSchluessel,
  uebernahmeWeg,
  uhrzeit,
  verlaufZeile,
  vorbelegung,
  wann,
  weitere,
  weitereTitel,
  wer,
} from '../geraetesucheAnsicht';
import { UEMS_GERAETE_SUCHEN } from '../glossar';
import { testErgebnis, type ComponentTemplate } from '../komponentenAssistent';
import { hashForRoute, pageRoute } from '../nav';
import { useRollen } from '../rollen';
import { useIsPhone } from '../useIsPhone';
import { AufbauSymbol } from './AufbauSymbol';
import { Recht } from './Recht';
import './GeraetesucheDialog.css';

/**
 * „Geräte suchen" (Konzept vp-portal-geraetesuche-konzept, Board-Runde 1: die ruhige Handy-Fassung; Bericht §2–§4):
 * das zentrierte Modal über dem Aufbau. Es startet die Suche auf der Box (oder sieht einer laufenden zu), fragt alle
 * 2 s ab, solange sie läuft, und zeigt danach die Funde in den sechs Gruppen der Antwort. „Übernehmen" gibt den Fund
 * an den Wirt, der den bestehenden Anlege-Fluss öffnet - dieses Modal bleibt dabei im Baum (`open` false), damit der
 * Weg danach zur Liste zurückführt (m5c). Eine neue Adresse übernimmt ein Tipp über den Bearbeiten-Weg (DP-7 A).
 *
 * Regeln und Sätze kommen aus `geraetesucheAnsicht.ts`; diese Datei rendert und ruft nur ab. Am Telefon eine ruhige
 * Liste (Name, eine graue Zeile, eine Handlung), am Rechner dieselbe Liste mit Spalten für Seriennummer und Adresse.
 */

const SYMBOL: Record<GeraetesucheArt, { kategorie: AufbauKategorie; icon: IconName }> = {
  wechselrichter: { kategorie: 'solar', icon: 'sun' },
  wallbox: { kategorie: 'ev', icon: 'battery-charging' },
  schaltaktor: { kategorie: 'home', icon: 'sliders' },
  zaehler: { kategorie: 'grid', icon: 'activity' },
  io_modul: { kategorie: 'grid', icon: 'cpu' },
  sps: { kategorie: 'grid', icon: 'cpu' },
  dtu: { kategorie: 'solar', icon: 'sun' },
  modbus_geraet: { kategorie: 'grid', icon: 'cpu' },
  router: { kategorie: 'navy', icon: 'wifi' },
  zugangspunkt: { kategorie: 'navy', icon: 'wifi' },
};

/** Was der Wirt mit einem übernommenen Fund tut: den Anlege-Fluss mit dieser Vorlage und Vorbelegung öffnen. */
export interface GeraetesucheUebernahme {
  fund: GeraetesucheFund;
  template: ComponentTemplate;
  verbindung: Record<string, unknown>;
  kanal: number | null;
  /** Der Schlüssel in `uebernommen`, sobald gespeichert ist. */
  schluessel: string;
}

type Ansicht =
  | { art: 'suche' }
  | { art: 'verlauf'; zurueck: boolean }
  | { art: 'modell'; fund: GeraetesucheFund; templates: ComponentTemplate[] }
  | { art: 'ausgang'; fund: GeraetesucheFund; template: ComponentTemplate };

type AdressLauf = { zustand: 'laeuft' } | { zustand: 'ok'; satz: string } | { zustand: 'fehler'; satz: string };

export function GeraetesucheDialog({
  open,
  siteId,
  boxId,
  boxName,
  zuletztGesehen,
  portalVerwaltet,
  komponenten,
  suchId = null,
  start = 'suche',
  uebernommen,
  zuletzt = null,
  onClose,
  onUebernehmen,
  onSelbst,
  onVonHand,
  onAdresseGespeichert,
}: {
  /** false, solange der Anlege-Fluss darüber liegt - die Suche und ihr Zustand bleiben. */
  open: boolean;
  siteId: string;
  boxId: string;
  /** „Seewiesen" - wie die Box im Aufbau heißt. */
  boxName: string;
  /** Der letzte Herzschlag der Box, für den Satz „zuletzt 08:40". */
  zuletztGesehen: string | null;
  /** false = die Geräte dieser Anlage pflegt die Box (`componentAuthority = box`): suchen ja, übernehmen nein. */
  portalVerwaltet: boolean;
  /** Die Komponenten der Anlage - die Adresse einer abgeglichenen ändert ein Tipp. */
  komponenten: readonly SiteComponentRow[];
  /** „Mitansehen": eine laufende Suche zeigen, statt eine neue zu starten. */
  suchId?: string | null;
  /** „Letzte Suchen" der Box-Karte: erst den Verlauf, gesucht wird nur auf Wunsch. */
  start?: 'suche' | 'verlauf';
  /** Was in dieser Sitzung übernommen wurde: Schlüssel → Name der neuen Komponente. */
  uebernommen: ReadonlyMap<string, string>;
  /** Die zuletzt übernommene Komponente („„Wechselrichter" ist angelegt."); `n` zählt jede neue. */
  zuletzt?: { titel: string; n: number } | null;
  onClose: () => void;
  onUebernehmen: (u: GeraetesucheUebernahme) => void;
  /** „Selbst beschreiben": ein Modbus-Gerät ohne Kennung mit vorbelegter Adresse. */
  onSelbst: (fund: GeraetesucheFund) => void;
  /** „Von Hand hinzufügen": der Katalog. */
  onVonHand: () => void;
  onAdresseGespeichert: (result: SiteComponents, satz: string) => void;
}) {
  const telefon = useIsPhone();
  const ich = useRollen().selbst?.name ?? null;
  const [ansicht, setAnsicht] = useState<Ansicht>(start === 'verlauf' ? { art: 'verlauf', zurueck: false } : { art: 'suche' });
  const [suche, setSuche] = useState<Geraetesuche | null>(null);
  const [startFehler, setStartFehler] = useState<GeraetesucheFehler | null>(null);
  const [lauf, setLauf] = useState(start === 'verlauf' && !suchId ? -1 : 0);
  const kennungen = useRef(new Map<number, string>());
  const [pollFehler, setPollFehler] = useState(false);
  const [abbruch, setAbbruch] = useState<'nein' | 'sendet' | 'gesendet'>('nein');
  const [aktionFehler, setAktionFehler] = useState<string | null>(null);
  const [templates, setTemplates] = useState<ComponentTemplate[] | null>(null);
  const [verlauf, setVerlauf] = useState<GeraetesucheVerlaufEintrag[] | null>(null);
  const [verlaufFehler, setVerlaufFehler] = useState(false);
  const [bestaetigen, setBestaetigen] = useState<string | null>(null);
  const [adressen, setAdressen] = useState<Record<string, AdressLauf>>({});
  const [klopfen, setKlopfen] = useState<Record<string, AdressLauf>>({});
  const titelRef = useRef<HTMLHeadingElement>(null);
  const [jetzt, setJetzt] = useState(() => Date.now());

  // Starten (oder einer laufenden zusehen). Je Anlauf EINE Anfrage-Kennung: ein doppelter Effekt im Entwicklungs-
  // modus schickt dieselbe, der Server antwortet dann dasselbe statt eine zweite Suche zu starten.
  useEffect(() => {
    if (lauf < 0) return;
    let aktiv = true;
    setStartFehler(null);
    setAbbruch('nein');
    setAktionFehler(null);
    const zusehen = async (id: string) => {
      const s = await api.geraetesuche(siteId, id);
      if (aktiv) setSuche(s);
    };
    void (async () => {
      try {
        if (lauf === 0 && suchId) {
          await zusehen(suchId);
          return;
        }
        if (!kennungen.current.has(lauf)) kennungen.current.set(lauf, neueAnfrageKennung());
        const s = await api.geraetesucheStarten(siteId, boxId, kennungen.current.get(lauf) as string);
        if (aktiv) setSuche(s);
      } catch (e) {
        if (!aktiv) return;
        const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as GeraetesucheFehler) : null;
        if (body?.code === 'laeuft_schon' && body.suchId) {
          try {
            await zusehen(body.suchId);
            return;
          } catch {
            /* fällt auf den Satz durch */
          }
        }
        setSuche(null);
        setStartFehler(
          body && typeof body.code === 'string'
            ? body
            : { code: 'anfrage_ungueltig', message: e instanceof ApiError ? e.message : '', suchId: null, zuletztGesehen: null, wiederAb: null },
        );
      }
    })();
    return () => {
      aktiv = false;
    };
  }, [lauf, siteId, boxId, suchId]);

  // Abfragen, solange die Suche läuft - je Runde ein eigener Abbruch (Muster der OCPP-Aktionen); danach nicht mehr.
  const laeuft = suche !== null && laeuftNoch(suche.zustand);
  const aktuelleId = suche?.suchId ?? null;
  useEffect(() => {
    if (!laeuft || !aktuelleId) return;
    let aktiv = true;
    let controller: AbortController | null = null;
    let timer = 0;
    const abfragen = async () => {
      controller = new AbortController();
      try {
        const s = await api.geraetesuche(siteId, aktuelleId, controller.signal);
        if (!aktiv) return;
        setPollFehler(false);
        setSuche(s);
        setJetzt(Date.now());
      } catch (cause) {
        if (aktiv && !(cause instanceof DOMException && cause.name === 'AbortError')) setPollFehler(true);
      } finally {
        if (aktiv) timer = window.setTimeout(() => void abfragen(), GERAETESUCHE_POLL_MS);
      }
    };
    timer = window.setTimeout(() => void abfragen(), GERAETESUCHE_POLL_MS);
    return () => {
      aktiv = false;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [laeuft, aktuelleId, siteId]);

  // Die Vorlagen für „Übernehmen" (fail-soft: ohne sie bleibt nur „von Hand").
  useEffect(() => {
    if (!portalVerwaltet) return;
    let aktiv = true;
    api.componentTemplates().then(
      (liste) => aktiv && setTemplates(liste),
      () => aktiv && setTemplates([]),
    );
    return () => {
      aktiv = false;
    };
  }, [portalVerwaltet]);

  // Der Verlauf der Box, sobald er gezeigt wird.
  const zeigtVerlauf = ansicht.art === 'verlauf';
  useEffect(() => {
    if (!zeigtVerlauf) return;
    const controller = new AbortController();
    setVerlaufFehler(false);
    api.geraetesucheVerlauf(siteId, boxId, controller.signal).then(
      (a) => setVerlauf(a.suchen),
      (cause) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setVerlaufFehler(true);
      },
    );
    return () => controller.abort();
  }, [zeigtVerlauf, siteId, boxId]);

  // Nach dem Speichern im Anlege-Fluss zurück zur Liste (m5c) - beim Schalter mit offenen Ausgängen zu den Ausgängen.
  const zuletztN = zuletzt?.n ?? 0;
  useEffect(() => {
    if (zuletztN === 0) return;
    setAnsicht((a) =>
      a.art === 'ausgang' && offeneAusgaenge(a.fund, new Set(uebernommen.keys())).length > 0 ? a : { art: 'suche' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- genau einmal je neuer Übernahme
  }, [zuletztN]);

  // Der Fokus folgt dem Titel, wenn sich die Ansicht ändert (Suche → Ergebnis, Liste → Modell, Verlauf).
  const ansichtSchluessel = ansicht.art === 'suche' ? (laeuft ? 'laeuft' : suche ? 'ergebnis' : startFehler ? 'fehler' : 'start') : ansicht.art;
  const ersterSchluessel = useRef(true);
  useEffect(() => {
    if (ersterSchluessel.current) {
      ersterSchluessel.current = false;
      return;
    }
    if (open) titelRef.current?.focus();
  }, [ansichtSchluessel, open]);

  const uebernommenSet = useMemo(() => new Set(uebernommen.keys()), [uebernommen]);

  const neuSuchen = () => {
    setSuche(null);
    setAnsicht({ art: 'suche' });
    setAdressen({});
    setBestaetigen(null);
    setLauf((n) => Math.max(1, n + 1));
  };

  const abbrechen = async () => {
    if (!suche) return;
    setAbbruch('sendet');
    try {
      setSuche(await api.geraetesucheAbbrechen(siteId, suche.suchId));
      setAbbruch('gesendet');
    } catch (e) {
      setAbbruch('nein');
      setAktionFehler(e instanceof ApiError ? e.message : 'Abbrechen hat nicht geklappt. Bitte versuchen Sie es erneut.');
    }
  };

  const uebernehmen = (f: GeraetesucheFund) => {
    setAktionFehler(null);
    if (!templates) return;
    const weg = uebernahmeWeg(f, templates);
    if (weg.art === 'direkt') {
      onUebernehmen({ fund: f, template: weg.template, verbindung: vorbelegung(f, weg.template), kanal: null, schluessel: f.schluessel });
    } else if (weg.art === 'modell') {
      setAnsicht({ art: 'modell', fund: f, templates: weg.templates });
    } else if (weg.art === 'ausgang') {
      setAnsicht({ art: 'ausgang', fund: f, template: weg.template });
    } else {
      setAktionFehler('Für dieses Gerät kennt Ihr Portal noch keine Vorlage. Fügen Sie es bitte von Hand hinzu.');
    }
  };

  /** DP-7 A: die neue Adresse an DERSELBEN Komponente - erst der Test (liest nur), dann eine neue Fassung. */
  const adresseUebernehmen = async (f: GeraetesucheFund, komponente: { id: string; name: string }) => {
    const zeile = komponenten.find((c) => c.id === komponente.id);
    const ip = typeof f.verbindung.ip === 'string' ? f.verbindung.ip : null;
    if (!zeile?.templateRef || !zeile.role || !ip) {
      setAdressen((a) => ({ ...a, [f.schluessel]: { zustand: 'fehler', satz: 'Diese Komponente lässt sich hier nicht ändern – öffnen Sie sie auf ihrer Geräteseite.' } }));
      return;
    }
    const connection: Record<string, unknown> = { ...(zeile.connection ?? {}), ip };
    if (typeof f.verbindung.port === 'number') connection.port = f.verbindung.port;
    setAdressen((a) => ({ ...a, [f.schluessel]: { zustand: 'laeuft' } }));
    try {
      const test = testErgebnis(
        await api.testComponentConnection(siteId, {
          deviceId: boxId,
          templateRef: zeile.templateRef,
          templateVersion: zeile.templateVersion ?? undefined,
          role: zeile.role,
          connection,
          entityId: zeile.id,
        }),
      );
      if (test.zustand !== 'bestanden') {
        setAdressen((a) => ({ ...a, [f.schluessel]: { zustand: 'fehler', satz: `Nicht übernommen: ${test.text}` } }));
        return;
      }
      const result = await api.updateComponent(siteId, zeile.id, {
        templateRef: zeile.templateRef,
        templateVersion: zeile.templateVersion ?? undefined,
        label: zeile.label ?? undefined,
        role: zeile.role,
        connection,
        capacityKwp: zeile.capacityKwp ?? undefined,
        expectedRevision: zeile.definitionVersion,
        effectiveAt: new Date().toISOString(),
      });
      const satz = `Neue Adresse für „${komponente.name}“ übernommen – dasselbe Gerät.`;
      setAdressen((a) => ({ ...a, [f.schluessel]: { zustand: 'ok', satz } }));
      onAdresseGespeichert(result, satz);
    } catch (e) {
      setAdressen((a) => ({
        ...a,
        [f.schluessel]: { zustand: 'fehler', satz: e instanceof ApiError ? e.message : 'Speichern hat nicht geklappt. Bitte versuchen Sie es erneut.' },
      }));
    }
  };

  const zulassen = async (chargePointId: string) => {
    setKlopfen((k) => ({ ...k, [chargePointId]: { zustand: 'laeuft' } }));
    try {
      await api.admitChargePoint(siteId, { chargePointId, deviceId: boxId });
      setKlopfen((k) => ({ ...k, [chargePointId]: { zustand: 'ok', satz: 'Zugelassen. Die Ladesäule darf sich beim nächsten Versuch verbinden.' } }));
    } catch (e) {
      setKlopfen((k) => ({
        ...k,
        [chargePointId]: { zustand: 'fehler', satz: e instanceof ApiError ? e.message : 'Zulassen hat nicht geklappt. Bitte versuchen Sie es erneut.' },
      }));
    }
  };

  // ───────────────────────────────────────────────────────────── Kopf, Inhalt, Fuß je Ansicht

  let titel = UEMS_GERAETE_SUCHEN;
  let zurueck: (() => void) | null = null;
  let inhalt: ReactNode;
  let fuss: ReactNode = null;

  if (ansicht.art === 'modell') {
    titel = `${ART_WORT[ansicht.fund.art]} hinzufügen`;
    zurueck = () => setAnsicht({ art: 'suche' });
    inhalt = (
      <ModellWahl
        titelRef={titelRef}
        fund={ansicht.fund}
        templates={ansicht.templates}
        onWahl={(t) => onUebernehmen({ fund: ansicht.fund, template: t, verbindung: vorbelegung(ansicht.fund, t), kanal: null, schluessel: ansicht.fund.schluessel })}
      />
    );
  } else if (ansicht.art === 'ausgang') {
    titel = `${ART_WORT[ansicht.fund.art]} hinzufügen`;
    zurueck = () => setAnsicht({ art: 'suche' });
    inhalt = (
      <AusgangWahl
        titelRef={titelRef}
        fund={ansicht.fund}
        uebernommen={uebernommen}
        onWahl={(kanal) =>
          onUebernehmen({
            fund: ansicht.fund,
            template: ansicht.template,
            verbindung: vorbelegung(ansicht.fund, ansicht.template, kanal),
            kanal,
            schluessel: uebernahmeSchluessel(ansicht.fund, kanal),
          })
        }
      />
    );
  } else if (ansicht.art === 'verlauf') {
    zurueck = ansicht.zurueck ? () => setAnsicht({ art: 'suche' }) : null;
    inhalt = <Verlauf titelRef={titelRef} boxName={boxName} eintraege={verlauf} fehler={verlaufFehler} ich={ich} />;
    fuss = ansicht.zurueck ? (
      <Button variant="outline" onClick={() => setAnsicht({ art: 'suche' })}>Zurück zur Suche</Button>
    ) : (
      <Recht aktion="geraet.einrichten">
        <Button variant="primary" onClick={neuSuchen} data-testid="gs-jetzt-suchen">{UEMS_GERAETE_SUCHEN}</Button>
      </Recht>
    );
  } else if (startFehler) {
    const satz = startFehlerSatz(startFehler, zuletztGesehen);
    inhalt = (
      <div className="vp-gs-leer" data-testid="gs-startfehler">
        <Radar ruhig />
        <h3 ref={titelRef} tabIndex={-1}>Die Suche hat nicht begonnen</h3>
        <p className="vp-gs-hinweis is-warn" role="status">{satz}</p>
        {startFehler.code === 'nicht_unterstuetzt' && (
          <a className="vp-gs-weg" href={hashForRoute(pageRoute('edge-updates'))}>
            Update planen <Icon name="chevron-right" size={14} />
          </a>
        )}
      </div>
    );
    fuss = (
      <Fuss
        telefon={telefon}
        primaer={startFehler.code === 'nicht_unterstuetzt' ? null : { label: 'Erneut suchen', onClick: neuSuchen }}
        zweit={portalVerwaltet ? { label: 'Von Hand hinzufügen', onClick: onVonHand } : null}
      />
    );
  } else if (!suche) {
    inhalt = (
      <div className="vp-gs-leer">
        <Radar />
        <h3 ref={titelRef} tabIndex={-1}>Suche wird gestartet …</h3>
        <p className="vp-gs-unter" role="status" aria-live="polite">Ihre Box bekommt den Auftrag · es wird nur gelesen</p>
      </div>
    );
  } else if (laeuft) {
    inhalt = (
      <Laeuft
        titelRef={titelRef}
        suche={suche}
        boxName={boxName}
        ich={ich}
        telefon={telefon}
        pollFehler={pollFehler}
        abbruch={abbruch !== 'nein'}
      />
    );
    fuss = (
      <div className="vp-gs-fuss is-laeuft">
        <Recht aktion="geraet.einrichten">
          <Button variant="outline" fullWidth={telefon} onClick={() => void abbrechen()} disabled={abbruch !== 'nein'} data-testid="gs-abbrechen">
            {abbruch === 'nein' ? 'Abbrechen' : 'Wird abgebrochen …'}
          </Button>
        </Recht>
        <p className="vp-gs-fussnote">Sie können das Fenster schließen – die Suche läuft weiter.</p>
      </div>
    );
  } else if (nichtsGefunden(suche)) {
    const w = weitere(suche);
    const ende = endHinweis(suche);
    inhalt = (
      <div className="vp-gs-leer" data-testid="gs-nichts">
        <Radar ruhig />
        <h3 ref={titelRef} tabIndex={-1}>Keine Energie-Geräte gefunden</h3>
        <p className="vp-gs-unter">
          {w.anzahl === null ? 'Andere Geräte hat Ihre Box nicht gezählt.' : `${w.anzahl === 1 ? '1 anderes Gerät' : `${w.anzahl} andere Geräte`} im Heimnetz`}
        </p>
        {ende && <p className={`vp-gs-hinweis is-${ende.ton}`} role="status">{ende.satz}</p>}
        <Gruppe titel="Woran es liegen kann" id="gs-gruende">
          <ul className="vp-gs-liste">
            {nichtsGefundenFragen(suche).map((q) => (
              <li key={q.frage} className="vp-gs-frage">
                <span className="vp-gs-frage-symbol" aria-hidden="true"><Icon name={q.icon} size={16} /></span>
                <span className="vp-gs-text"><b>{q.frage}</b><small>{q.antwort}</small></span>
              </li>
            ))}
          </ul>
        </Gruppe>
      </div>
    );
    fuss = (
      <Fuss
        telefon={telefon}
        primaer={{ label: 'Erneut suchen', onClick: neuSuchen }}
        zweit={portalVerwaltet ? { label: 'Von Hand hinzufügen', onClick: onVonHand } : null}
      />
    );
  } else {
    inhalt = (
      <Ergebnis
        titelRef={titelRef}
        suche={suche}
        jetzt={jetzt}
        telefon={telefon}
        portalVerwaltet={portalVerwaltet}
        uebernommen={uebernommen}
        uebernommenSet={uebernommenSet}
        zuletzt={zuletzt}
        vorlagenDa={templates !== null}
        bestaetigen={bestaetigen}
        adressen={adressen}
        klopfen={klopfen}
        aktionFehler={aktionFehler}
        onUebernehmen={(f) => (f.erkennung === 'wahrscheinlich' && bestaetigen !== f.schluessel ? setBestaetigen(f.schluessel) : uebernehmen(f))}
        onBestaetigenAbbrechen={() => setBestaetigen(null)}
        onAdresse={(f, k) => void adresseUebernehmen(f, k)}
        onSelbst={onSelbst}
        onZulassen={(id) => void zulassen(id)}
        onVonHand={onVonHand}
        onVerlauf={() => setAnsicht({ art: 'verlauf', zurueck: true })}
      />
    );
    fuss = <Fuss telefon={telefon} primaer={{ label: 'Fertig', onClick: onClose }} zweit={{ label: 'Erneut suchen', onClick: neuSuchen }} />;
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={titel}
      breit={!telefon && ansicht.art === 'suche' && suche !== null}
      icon={
        zurueck ? (
          <button type="button" className="vp-ein-zurueck" onClick={zurueck} aria-label="Zurück zur Liste">
            <Icon name="chevron-left" size={20} />
          </button>
        ) : undefined
      }
      footer={fuss}
      data-testid="geraetesuche"
      data-ansicht={ansichtSchluessel}
    >
      <div className="vp-gs">{inhalt}</div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────── Bausteine

function Fuss({
  telefon,
  primaer,
  zweit,
}: {
  telefon: boolean;
  primaer: { label: string; onClick: () => void } | null;
  zweit: { label: string; onClick: () => void } | null;
}) {
  // Am Telefon der Hauptknopf zuerst und breit, darunter der zweite Weg als Link (m3, m7); am Rechner rechtsbündig.
  const p = primaer && (
    <Button variant="primary" fullWidth={telefon} onClick={primaer.onClick} data-testid="gs-primaer">
      {primaer.label}
    </Button>
  );
  const z = zweit && (
    <button type="button" className="vp-gs-link" onClick={zweit.onClick} data-testid="gs-zweit">
      {zweit.label}
    </button>
  );
  return <div className={`vp-gs-fuss${telefon ? ' is-telefon' : ''}`}>{telefon ? <>{p}{z}</> : <>{z}{p}</>}</div>;
}

/** Das ruhige Such-Bild: drei Ringe des Laders (stehen unter reduzierter Bewegung), in der Mitte die Box. */
function Radar({ ruhig = false }: { ruhig?: boolean }) {
  return (
    <svg className={`vp-gs-radar${ruhig ? ' is-ruhig' : ''}`} viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="30" className="vp-gs-radar-feld" />
      <circle cx="32" cy="32" r="19" className="vp-gs-radar-kreis" />
      <circle cx="32" cy="32" r="11" className="vp-gs-radar-kreis" />
      {!ruhig && (
        <>
          <circle className="vp-loader-ring r1 vp-gs-radar-puls" cx="32" cy="32" r="19" />
          <circle className="vp-loader-ring r2 vp-gs-radar-puls" cx="32" cy="32" r="19" />
          <circle className="vp-loader-ring r3 vp-gs-radar-puls" cx="32" cy="32" r="19" />
        </>
      )}
      <circle cx="32" cy="32" r="4" className="vp-gs-radar-box" />
    </svg>
  );
}

function Gruppe({ titel, id, rechts, children }: { titel: string; id: string; rechts?: ReactNode; children: ReactNode }) {
  return (
    <section className="vp-gs-gruppe" aria-labelledby={id} data-gruppe={id}>
      <h4 id={id}>
        <span>{titel}</span>
        {rechts ? <small>{rechts}</small> : null}
      </h4>
      {children}
    </section>
  );
}

function Laeuft({
  titelRef,
  suche,
  boxName,
  ich,
  telefon,
  pollFehler,
  abbruch,
}: {
  titelRef: RefObject<HTMLHeadingElement>;
  suche: Geraetesuche;
  boxName: string;
  ich: string | null;
  telefon: boolean;
  pollFehler: boolean;
  abbruch: boolean;
}) {
  const f = fortschritt(suche);
  const funde = suche.gruppen.filter((g) => g.gruppe !== 'weitere').flatMap((g) => g.funde);
  const prozent = f.anteil === null ? null : Math.round(f.anteil * 100);
  return (
    <div className="vp-gs-laeuft" data-testid="gs-laeuft">
      <div className="vp-gs-laeuft-kopf">
        <Radar />
        <div>
          <h3 ref={titelRef} tabIndex={-1}>Suche im Heimnetz …</h3>
          <p className="vp-gs-unter">
            {telefon
              ? `${f.rest} · es wird nur gelesen`
              : `Box ${boxName} · gestartet ${uhrzeit(suche.gestartetAm)} von ${wer(suche.gestartetVon, ich) === 'Sie' ? 'Ihnen' : wer(suche.gestartetVon, ich)} · es wird nur gelesen`}
          </p>
        </div>
      </div>
      {!telefon && (
        <ol className="vp-gs-schritte">
          {f.schritte.map((s) => (
            <li key={s.titel} className={`is-${s.zustand}`}>
              <span className="vp-gs-schritt-marke" aria-hidden="true">
                {s.zustand === 'fertig' ? <Icon name="check" size={14} /> : s.zustand === 'aktiv' ? <span className="vp-spinner" /> : null}
              </span>
              <span className="vp-gs-text">
                <b>{s.titel}</b>
                {s.zeile && <small>{s.zeile}</small>}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div
        className="vp-gs-balken"
        role="progressbar"
        aria-label="Fortschritt der Suche"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={prozent ?? undefined}
        aria-valuetext={prozent === null ? 'Ihre Box beginnt gleich' : `${prozent} Prozent`}
      >
        <span style={{ width: `${prozent ?? 4}%` }} />
      </div>
      <p className="vp-gs-rest" role="status" aria-live="polite">
        {abbruch ? 'Wird abgebrochen …' : telefon ? f.schrittSatz : `${f.rest} · ${f.schrittSatz}`}
      </p>
      {suche.gestartetVon && wer(suche.gestartetVon, ich) !== 'Sie' && telefon && (
        <p className="vp-gs-fussnote">Gestartet {uhrzeit(suche.gestartetAm)} von {wer(suche.gestartetVon, ich)}</p>
      )}
      {pollFehler && (
        <p className="vp-gs-hinweis is-warn">Die Verbindung zum Portal stockt – es wird weiter abgefragt.</p>
      )}
      {funde.length > 0 && (
        <Gruppe titel="Gefunden" id="gs-gefunden">
          <ul className="vp-gs-liste">
            {funde.map((x) => (
              <li key={x.schluessel} className="vp-gs-fund">
                <div className="vp-gs-zeile">
                  <AufbauSymbol {...SYMBOL[x.art]} />
                  <span className="vp-gs-text">
                    <b>{fundTitel(x)}</b>
                    <small>{fundZeile(x, true)}</small>
                  </span>
                  <span className={`vp-gs-wort is-${erkennungWort(x.erkennung).ton}`}>
                    {x.erkennung === 'sicher' ? <Icon name="check" size={16} /> : null}
                    <span className={x.erkennung === 'sicher' ? 'vp-sr-only' : undefined}>{erkennungWort(x.erkennung).wort}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Gruppe>
      )}
    </div>
  );
}

function Ergebnis({
  titelRef,
  suche,
  jetzt,
  telefon,
  portalVerwaltet,
  uebernommen,
  uebernommenSet,
  zuletzt,
  vorlagenDa,
  bestaetigen,
  adressen,
  klopfen,
  aktionFehler,
  onUebernehmen,
  onBestaetigenAbbrechen,
  onAdresse,
  onSelbst,
  onZulassen,
  onVonHand,
  onVerlauf,
}: {
  titelRef: RefObject<HTMLHeadingElement>;
  suche: Geraetesuche;
  jetzt: number;
  telefon: boolean;
  portalVerwaltet: boolean;
  uebernommen: ReadonlyMap<string, string>;
  uebernommenSet: ReadonlySet<string>;
  zuletzt: { titel: string; n: number } | null;
  vorlagenDa: boolean;
  bestaetigen: string | null;
  adressen: Record<string, AdressLauf>;
  klopfen: Record<string, AdressLauf>;
  aktionFehler: string | null;
  onUebernehmen: (f: GeraetesucheFund) => void;
  onBestaetigenAbbrechen: () => void;
  onAdresse: (f: GeraetesucheFund, k: { id: string; name: string }) => void;
  onSelbst: (f: GeraetesucheFund) => void;
  onZulassen: (chargePointId: string) => void;
  onVonHand: () => void;
  onVerlauf: () => void;
}) {
  const ende = endHinweis(suche);
  const w = weitere(suche);
  const jetztDatum = new Date(jetzt);
  const technik = suche.gruppen.find((g) => g.gruppe === 'weitere')?.funde ?? [];
  const sichtbar = (g: GeraetesucheGruppeWort) =>
    (suche.gruppen.find((x) => x.gruppe === g)?.funde ?? []).filter((f) => g === 'schon_eingerichtet' || !istUebernommen(f, uebernommenSet));
  const eingerichtet = new Set((suche.gruppen.find((g) => g.gruppe === 'schon_eingerichtet')?.funde ?? []).map((f) => f.schluessel));
  const uebernommenListe = [...uebernommen.entries()].filter(([k]) => !eingerichtet.has(k.split('#')[0]));
  const klopft = suche.ladesaeulenKlopfenAn ?? [];

  const liste = (g: GeraetesucheGruppeWort) => {
    const funde = sichtbar(g);
    if (funde.length === 0) return null;
    return (
      <Gruppe key={g} titel={GRUPPEN_TITEL[g]} id={`gs-gruppe-${g}`} rechts={funde.length > 1 ? String(funde.length) : null}>
        {!telefon && <Spalten />}
        <ul className="vp-gs-liste">
          {funde.map((f) => (
            <FundZeile
              key={f.schluessel}
              fund={f}
              gruppe={g}
              telefon={telefon}
              portalVerwaltet={portalVerwaltet}
              uebernommen={uebernommenSet}
              vorlagenDa={vorlagenDa}
              bestaetigen={bestaetigen === f.schluessel}
              adresse={adressen[f.schluessel] ?? null}
              onUebernehmen={() => onUebernehmen(f)}
              onBestaetigenAbbrechen={onBestaetigenAbbrechen}
              onAdresse={onAdresse}
              onSelbst={() => onSelbst(f)}
            />
          ))}
        </ul>
      </Gruppe>
    );
  };

  return (
    <div className="vp-gs-ergebnis" data-testid="gs-ergebnis">
      {zuletzt && (
        <p className="vp-gs-erfolg" role="status" key={zuletzt.n}>
          <Icon name="check" size={16} /> „{zuletzt.titel}“ ist angelegt.
        </p>
      )}
      <header className="vp-gs-kopf">
        <h3 ref={titelRef} tabIndex={-1}>{ergebnisTitel(suche, uebernommenSet)}</h3>
        <p className="vp-gs-unter">{wann(suche.gestartetAm, jetztDatum)} · es wurde nur gelesen</p>
      </header>
      {ende && <p className={`vp-gs-hinweis is-${ende.ton}`} role="status">{ende.satz}</p>}
      {!portalVerwaltet && (
        <p className="vp-gs-hinweis is-info">Geräte dieser Anlage verwalten Sie an Ihrer VoltPilot-Box.</p>
      )}
      {aktionFehler && <p className="vp-gs-hinweis is-fehler" role="alert">{aktionFehler}</p>}

      {liste('braucht_hilfe')}

      {klopft.length > 0 && (
        <Gruppe titel="Ladesäule klopft an" id="gs-gruppe-klopft">
          <ul className="vp-gs-liste">
            {klopft.map((l) => {
              const z = klopfen[l.chargePointId] ?? null;
              return (
                <li key={l.chargePointId} className="vp-gs-fund" data-klopft={l.chargePointId}>
                  <div className="vp-gs-zeile">
                    <AufbauSymbol kategorie="ev" icon="battery-charging" />
                    <span className="vp-gs-text">
                      <b>{l.chargePointId}</b>
                      <small>{klopftAnZeile(l, jetztDatum)}</small>
                    </span>
                    <span className="vp-gs-aktion">
                      {z?.zustand === 'ok' ? (
                        <span className="vp-gs-wort is-ok"><Icon name="check" size={16} /> zugelassen</span>
                      ) : (
                        <Recht aktion="ladepunkt.anbinden">
                          <button
                            type="button"
                            className="vp-gs-tun"
                            disabled={z?.zustand === 'laeuft'}
                            onClick={() => onZulassen(l.chargePointId)}
                            aria-label={`Ladesäule ${l.chargePointId} zulassen`}
                          >
                            {z?.zustand === 'laeuft' ? 'Lässt zu …' : 'Zulassen'}
                          </button>
                        </Recht>
                      )}
                    </span>
                  </div>
                  <p className="vp-gs-zeile-satz">
                    {z && z.zustand !== 'laeuft' ? z.satz : 'Ihre Box hat diese Kennung abgewiesen, weil sie noch nicht eingetragen ist.'}
                  </p>
                </li>
              );
            })}
          </ul>
        </Gruppe>
      )}

      {liste('bereit')}

      {uebernommenListe.length > 0 && (
        <Gruppe titel="Übernommen" id="gs-gruppe-uebernommen">
          <ul className="vp-gs-liste">
            {uebernommenListe.map(([k, name]) => (
              <li key={k} className="vp-gs-fund">
                <div className="vp-gs-zeile">
                  <span className="vp-gs-frage-symbol is-ok" aria-hidden="true"><Icon name="check" size={16} /></span>
                  <span className="vp-gs-text">
                    <b>{name}</b>
                    <small>Wird an die Box übertragen …</small>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Gruppe>
      )}

      {liste('nicht_anbindbar')}
      {liste('vielleicht')}
      {liste('schon_eingerichtet')}

      {(technik.length > 0 || w.anzahl) ? (
        <details className="vp-gs-weitere" data-testid="gs-weitere">
          <summary>
            <span className="vp-gs-text">
              <b>{weitereTitel(w.anzahl)}</b>
              {w.zeile && <small>{w.zeile}</small>}
            </span>
            <Icon name="chevron-down" size={16} />
          </summary>
          <ul className="vp-gs-liste">
            {technik.map((f) => (
              <li key={f.schluessel} className="vp-gs-fund">
                <div className="vp-gs-zeile">
                  <AufbauSymbol {...SYMBOL[f.art]} />
                  <span className="vp-gs-text">
                    <b>{fundTitel(f)}</b>
                    <small>{fundZeile(f, true)}</small>
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="vp-gs-fussnote">Telefone und Rechner stehen nur als Anzahl da – ohne Namen und ohne MAC-Adresse.</p>
        </details>
      ) : null}

      <details className="vp-gs-nichtdabei">
        <summary>Gerät nicht dabei? <Icon name="chevron-right" size={14} /></summary>
        <ul className="vp-gs-liste">
          {nichtsGefundenFragen(suche).map((q) => (
            <li key={q.frage} className="vp-gs-frage">
              <span className="vp-gs-frage-symbol" aria-hidden="true"><Icon name={q.icon} size={16} /></span>
              <span className="vp-gs-text"><b>{q.frage}</b><small>{q.antwort}</small></span>
            </li>
          ))}
        </ul>
        {portalVerwaltet && (
          <button type="button" className="vp-gs-link" onClick={onVonHand}>Von Hand hinzufügen</button>
        )}
      </details>

      <button type="button" className="vp-gs-link vp-gs-verlauf-link" onClick={onVerlauf}>
        <Icon name="history" size={15} /> Letzte Suchen
      </button>
    </div>
  );
}

function Spalten() {
  return (
    <div className="vp-gs-spalten" aria-hidden="true">
      <span>Gerät</span>
      <span>Seriennummer</span>
      <span>Adresse</span>
      <span />
    </div>
  );
}

function FundZeile({
  fund: f,
  gruppe,
  telefon,
  portalVerwaltet,
  uebernommen,
  vorlagenDa,
  bestaetigen,
  adresse,
  onUebernehmen,
  onBestaetigenAbbrechen,
  onAdresse,
  onSelbst,
}: {
  fund: GeraetesucheFund;
  gruppe: GeraetesucheGruppeWort;
  telefon: boolean;
  portalVerwaltet: boolean;
  uebernommen: ReadonlySet<string>;
  vorlagenDa: boolean;
  bestaetigen: boolean;
  adresse: AdressLauf | null;
  onUebernehmen: () => void;
  onBestaetigenAbbrechen: () => void;
  onAdresse: (f: GeraetesucheFund, k: { id: string; name: string }) => void;
  onSelbst: () => void;
}) {
  const [offen, setOffen] = useState(false);
  const aktion = fundAktion(f, gruppe, portalVerwaltet);
  const hinweis = fundHinweis(f);
  // Eingerichtet oder mit neuer Adresse ist es DASSELBE Gerät: die Zeile nennt es so, wie der Kunde es benannt hat.
  const titel = (gruppe === 'schon_eingerichtet' || f.abgleich === 'adresse_geaendert') && f.komponente
    ? f.komponente.name
    : fundTitel(f);
  const teilweise =
    f.art === 'schaltaktor' && (f.kanaele ?? 0) > 1 && offeneAusgaenge(f, uebernommen).length < (f.kanaele ?? 0)
      ? `${(f.kanaele ?? 0) - offeneAusgaenge(f, uebernommen).length} von ${f.kanaele} Ausgängen übernommen`
      : null;
  const unter = gruppe === 'schon_eingerichtet'
    ? [fundTitel(f), fundAdresse(f)].filter(Boolean).join(' · ')
    : teilweise ?? fundZeile(f, telefon);
  const detailId = `gs-woran-${f.schluessel.replace(/[^a-z0-9]/gi, '-')}`;
  const ew = erkennungWort(f.erkennung);

  let tun: ReactNode = null;
  if (adresse?.zustand === 'ok') {
    tun = <span className="vp-gs-wort is-ok"><Icon name="check" size={16} /> übernommen</span>;
  } else if (aktion.art === 'uebernehmen' && !bestaetigen) {
    tun = (
      <Recht aktion="geraet.einrichten">
        <button type="button" className="vp-gs-tun" onClick={onUebernehmen} disabled={!vorlagenDa} aria-label={`${titel} übernehmen`}>
          Übernehmen
        </button>
      </Recht>
    );
  } else if (aktion.art === 'adresse') {
    tun = (
      <Recht aktion="geraet.einrichten">
        <button
          type="button"
          className="vp-gs-tun"
          disabled={adresse?.zustand === 'laeuft'}
          onClick={() => onAdresse(f, aktion.komponente)}
          aria-label={`Neue Adresse ${aktion.neu} für ${aktion.komponente.name} übernehmen`}
        >
          {adresse?.zustand === 'laeuft' ? 'Prüft …' : 'Übernehmen'}
        </button>
      </Recht>
    );
  } else if (aktion.art === 'selbst') {
    tun = (
      <Recht aktion="geraet.einrichten">
        <button type="button" className="vp-gs-tun" onClick={onSelbst} aria-label={`${titel} selbst beschreiben`}>
          Beschreiben
        </button>
      </Recht>
    );
  } else if (gruppe === 'schon_eingerichtet') {
    tun = <span className="vp-gs-wort is-ok"><Icon name="check" size={16} /> eingerichtet</span>;
  }

  const woran = (
    <div className="vp-gs-woran" id={detailId} hidden={!offen}>
      <dl>
        {f.seriennummer && telefon && (<div><dt>Seriennummer</dt><dd className="vp-mono">{f.seriennummer}</dd></div>)}
        {fundAdresse(f, true) && telefon && (<div><dt>Adresse</dt><dd className="vp-mono">{fundAdresse(f, true)}</dd></div>)}
        {f.modellName && f.modell && (<div><dt>Modellcode</dt><dd className="vp-mono">{f.modell}</dd></div>)}
        {bauart(f) && (<div><dt>Bauart</dt><dd>{bauart(f)}</dd></div>)}
        {f.firmware && (<div><dt>Firmware</dt><dd className="vp-mono">{f.firmware}</dd></div>)}
        <div><dt>Erkennung</dt><dd><span className={`vp-gs-wort is-${ew.ton}`}>{ew.wort}</span></dd></div>
      </dl>
      <ul className="vp-gs-merkmale">
        {f.merkmale.map((m) => {
          const t = merkmalText(m);
          return <li key={m}>{t.roh ? <code>{t.text}</code> : t.text}</li>;
        })}
      </ul>
    </div>
  );

  return (
    <li className={`vp-gs-fund${gruppe === 'braucht_hilfe' ? ' is-hilfe' : ''}`} data-fund={f.schluessel}>
      <div className={`vp-gs-zeile${telefon ? '' : ' is-spalten'}`}>
        <AufbauSymbol {...SYMBOL[f.art]} />
        <span className="vp-gs-text">
          {telefon ? (
            <button type="button" className="vp-gs-name" aria-expanded={offen} aria-controls={detailId} onClick={() => setOffen((o) => !o)}>
              {titel}
            </button>
          ) : (
            <b>{titel}</b>
          )}
          <small>
            {f.abgleich === 'adresse_geaendert' && <span className="vp-gs-punkt is-warn" aria-hidden="true" />}
            {f.abgleich === 'adresse_geaendert' ? `Neue Adresse ${fundAdresse(f) ?? ''}` : unter}
          </small>
          {!telefon && (
            <button type="button" className="vp-gs-woran-knopf" aria-expanded={offen} aria-controls={detailId} onClick={() => setOffen((o) => !o)}>
              Woran erkannt?
            </button>
          )}
        </span>
        {!telefon && (
          <>
            <span className="vp-gs-zelle vp-mono"><span className="vp-sr-only">Seriennummer </span>{f.seriennummer ?? '–'}</span>
            <span className="vp-gs-zelle vp-mono"><span className="vp-sr-only">Adresse </span>{fundAdresse(f, true) ?? '–'}</span>
          </>
        )}
        <span className="vp-gs-aktion">{tun}</span>
      </div>
      {woran}
      {bestaetigen && aktion.art === 'uebernehmen' && (
        <div className="vp-gs-bestaetigen" role="group" aria-label="Erkennung bestätigen">
          <p>Nur wahrscheinlich erkannt: {f.merkmale.map((m) => merkmalText(m).text).join(' ')} Ist es ein {ART_WORT[f.art]}?</p>
          <div>
            <button type="button" className="vp-gs-link" onClick={onBestaetigenAbbrechen}>Nein</button>
            <Button variant="primary" size="sm" onClick={onUebernehmen}>Ja, übernehmen</Button>
          </div>
        </div>
      )}
      {(hinweis || adresse?.zustand === 'fehler' || adresse?.zustand === 'ok') && (
        <p className={`vp-gs-zeile-satz${adresse?.zustand === 'fehler' ? ' is-fehler' : ''}`} role={adresse && adresse.zustand !== 'laeuft' ? 'status' : undefined}>
          {adresse && adresse.zustand !== 'laeuft' ? adresse.satz : hinweis}
        </p>
      )}
    </li>
  );
}

function ModellWahl({
  titelRef,
  fund,
  templates,
  onWahl,
}: {
  titelRef: RefObject<HTMLHeadingElement>;
  fund: GeraetesucheFund;
  templates: ComponentTemplate[];
  onWahl: (t: ComponentTemplate) => void;
}) {
  const aus = ausDerSuche(fund);
  return (
    <div className="vp-gs-wahl" data-testid="gs-modell">
      <AusDerSuche titel={aus.titel} zeile={aus.zeile} fund={fund} />
      <header className="vp-gs-kopf">
        <h3 ref={titelRef} tabIndex={-1}>Welches Modell steht auf dem Typenschild?</h3>
        <p className="vp-gs-unter">{templates.length} Modelle passen. Die Leistung liest die Suche nicht aus.</p>
      </header>
      <ul className="vp-gs-liste">
        {templates.map((t) => (
          <li key={t.templateRef}>
            <button type="button" className="vp-gs-wahl-zeile" onClick={() => onWahl(t)}>
              <span className="vp-gs-text">
                <b>{t.modelLabel}</b>
                <small>{t.ratedKw != null ? `${String(t.ratedKw).replace('.', ',')} kW` : t.familyLabel ?? ''}</small>
              </span>
              <Icon name="chevron-right" size={16} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AusgangWahl({
  titelRef,
  fund,
  uebernommen,
  onWahl,
}: {
  titelRef: RefObject<HTMLHeadingElement>;
  fund: GeraetesucheFund;
  uebernommen: ReadonlyMap<string, string>;
  onWahl: (kanal: number) => void;
}) {
  const n = fund.kanaele ?? 1;
  return (
    <div className="vp-gs-wahl" data-testid="gs-ausgang">
      <AusDerSuche titel={fundTitel(fund)} zeile={[fundAdresse(fund), artText(fund)].filter(Boolean).join(' · ')} fund={fund} />
      <header className="vp-gs-kopf">
        <h3 ref={titelRef} tabIndex={-1}>Welcher Ausgang steuert ein Gerät?</h3>
        <p className="vp-gs-unter">
          Das lässt sich vom Netz aus nicht erkennen. Je Ausgang entsteht ein eigenes Gerät; was daran hängt, fragt der nächste Schritt.
        </p>
      </header>
      <ul className="vp-gs-liste">
        {Array.from({ length: n }, (_, k) => {
          const name = uebernommen.get(uebernahmeSchluessel(fund, k));
          return (
            <li key={k}>
              {name ? (
                <div className="vp-gs-wahl-zeile is-fertig">
                  <span className="vp-gs-text"><b>Ausgang {k + 1}</b><small>{name}</small></span>
                  <span className="vp-gs-wort is-ok"><Icon name="check" size={16} /> übernommen</span>
                </div>
              ) : (
                <button type="button" className="vp-gs-wahl-zeile" onClick={() => onWahl(k)}>
                  <span className="vp-gs-text"><b>Ausgang {k + 1}</b><small>Noch nicht übernommen</small></span>
                  <Icon name="chevron-right" size={16} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="vp-gs-fussnote">Der Test liest nur den Schaltzustand; geschaltet wird erst, wenn Sie eine Regel einrichten.</p>
    </div>
  );
}

function AusDerSuche({ titel, zeile, fund }: { titel: string; zeile: string; fund: GeraetesucheFund }) {
  return (
    <div className="vp-gs-aus">
      <span className="vp-gs-aus-marke">Aus der Suche</span>
      <b>{titel}</b>
      {zeile && <small>{zeile}</small>}
      <details>
        <summary>Woran erkannt?</summary>
        <ul className="vp-gs-merkmale">
          {fund.merkmale.map((m) => {
            const t = merkmalText(m);
            return <li key={m}>{t.roh ? <code>{t.text}</code> : t.text}</li>;
          })}
        </ul>
      </details>
    </div>
  );
}

function Verlauf({
  titelRef,
  boxName,
  eintraege,
  fehler,
  ich,
}: {
  titelRef: RefObject<HTMLHeadingElement>;
  boxName: string;
  eintraege: GeraetesucheVerlaufEintrag[] | null;
  fehler: boolean;
  ich: string | null;
}) {
  const jetzt = new Date();
  return (
    <div className="vp-gs-verlauf" data-testid="gs-verlauf">
      <header className="vp-gs-kopf">
        <h3 ref={titelRef} tabIndex={-1}>Letzte Suchen</h3>
        <p className="vp-gs-unter">Box {boxName} · 30 Tage</p>
      </header>
      {fehler ? (
        <p className="vp-gs-hinweis is-warn" role="status">Der Verlauf ließ sich gerade nicht laden.</p>
      ) : eintraege === null ? (
        <p className="vp-gs-unter" role="status">Wird geladen …</p>
      ) : eintraege.length === 0 ? (
        <p className="vp-gs-unter">An dieser Box wurde in den letzten 30 Tagen nicht gesucht.</p>
      ) : (
        <ul className="vp-gs-liste">
          {eintraege.map((e) => {
            const z = verlaufZeile(e, ich, jetzt);
            return (
              <li key={e.suchId} className="vp-gs-fund">
                <div className="vp-gs-zeile">
                  <span className="vp-gs-frage-symbol" aria-hidden="true"><Icon name="history" size={16} /></span>
                  <span className="vp-gs-text"><b>{z.titel}</b><small>{z.zeile}</small></span>
                  <span className="vp-gs-dauer">{z.rechts}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="vp-gs-fussnote">
        <Icon name="info" size={14} /> Andere Geräte im Heimnetz stehen nur als Anzahl da, ohne Namen und ohne MAC-Adresse.
        Funde werden nach 30 Tagen gelöscht.
      </p>
    </div>
  );
}
