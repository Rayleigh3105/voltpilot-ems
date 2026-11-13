import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Switch } from '../../designsystem/components/forms/Switch';
import { api, ladeMeldungenVerlaufCsv, type Anlagensteuerung } from '../api';
import { currentUser } from '../auth';
import { benachrichtigungenApi, type WegAusfall, type Zustellstand } from '../benachrichtigungenApi';
import { boxRefOf } from '../geraetAdresse';
import { useBoxen } from '../useBoxRef';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErsteEinrichtung, einrichtungOffen, useEinrichtungsStand } from '../components/ErsteEinrichtung';
import { EmptyState, ErrorState } from '../components/States';
import { NeueUeberwachung } from '../components/NeueUeberwachung';
import { UeberwachenBlatt } from '../components/UeberwachenBlatt';
import { VpPicker } from '../components/VpPicker';
import {
  anlageAusHash,
  dauerText,
  einheitAusBezug,
  empfaengerText,
  istEigeneUeberwachung,
  istGemeinteMeldung,
  istLeise,
  meldungAusHash,
  meldungEinheitLink,
  meldungenApi,
  meldungQuelleLink,
  regelAnlage,
  regelName,
  reiterAusHash,
  type Meldung,
  type UeberwachungsRegel,
  SCHWERE_WORT,
  sortiereJetzt,
  sortiereRegeln,
  sortiereVerlauf,
  wartezeitText,
  wertartSatzname,
  WORT_EIGENE_UEBERWACHUNG,
} from '../meldungen';
import { ausgeloest, entwarnung } from '../meldungsText';
import { datumZeit } from '../rechteTexte';
import { useRollen } from '../rollen';
import { ueberwachungApi } from '../ueberwachungApi';
import type { WertWahl } from '../ueberwachungAuswahl';
import { useIsPhone } from '../useIsPhone';
import { ausfallText, entwarnungSatz, zustellSatz, type ZustellSatz } from '../zustellstand';
import { EinstellungenPage } from './EinstellungenPage';
import '../components/BereichTabs.css';
import './MeldungenPage.css';

type Reiter = 'jetzt' | 'verlauf' | 'einstellen';

/** Löschbar ist nur eine selbst angelegte Regel - dieselbe Einschränkung wie serverseitig
 * (`UeberwachungAnlegenService.loeschen`, `CLIENT_HERKUNFT`): eine Regel ab Werk lässt sich ausschalten, nicht löschen
 * (ihre Aussaat sät jede Wertart und Anlage nur einmal). */
function loeschbar(regel: UeberwachungsRegel): boolean {
  return regel.herkunft === 'eigen' || regel.herkunft === 'steuerung';
}

/** Die vier Zeiträume des CSV-Exports (Entscheid 14A) - eine Export-Bequemlichkeit, keine
 * abrechnungsgenaue Angabe, darum feste UTC-Fenster statt der Standort-Zeitzone. */
const CSV_PERIODEN = [
  { value: 'monat', label: 'Dieser Monat' },
  { value: 'letzter_monat', label: 'Letzter Monat' },
  { value: 'jahr', label: 'Dieses Jahr' },
  { value: 'letztes_jahr', label: 'Letztes Jahr' },
];

function csvZeitraum(periode: string, jetzt: Date): { von: string; bis: string } {
  const jahr = jetzt.getUTCFullYear();
  const monat = jetzt.getUTCMonth();
  switch (periode) {
    case 'letzter_monat':
      return { von: new Date(Date.UTC(jahr, monat - 1, 1)).toISOString(), bis: new Date(Date.UTC(jahr, monat, 1)).toISOString() };
    case 'jahr':
      return { von: new Date(Date.UTC(jahr, 0, 1)).toISOString(), bis: new Date(Date.UTC(jahr + 1, 0, 1)).toISOString() };
    case 'letztes_jahr':
      return { von: new Date(Date.UTC(jahr - 1, 0, 1)).toISOString(), bis: new Date(Date.UTC(jahr, 0, 1)).toISOString() };
    default:
      return { von: new Date(Date.UTC(jahr, monat, 1)).toISOString(), bis: new Date(Date.UTC(jahr, monat + 1, 1)).toISOString() };
  }
}

/** „12:18 Uhr“ für heute, sonst Datum und Uhrzeit. */
function zeitKurz(iso: string, jetzt: Date): string {
  const voll = datumZeit(iso);
  return voll.slice(0, 10) === datumZeit(jetzt.toISOString()).slice(0, 10) ? `${voll.slice(11)} Uhr` : voll;
}

/** „Stumm“ an der Karte: drei Fristen statt eines Formulars (Stummschalten verlangt ein Ende). */
const STUMM_FRISTEN: { key: string; label: string; bis: (jetzt: Date) => Date }[] = [
  { key: 'stunde', label: '1 Stunde', bis: (j) => new Date(j.getTime() + 3600_000) },
  {
    key: 'morgen',
    label: 'Bis morgen früh',
    bis: (j) => {
      const d = new Date(j);
      d.setDate(d.getDate() + 1);
      d.setHours(7, 0, 0, 0);
      return d;
    },
  },
  { key: 'woche', label: '7 Tage', bis: (j) => new Date(j.getTime() + 7 * 86400_000) },
];

/**
 * Meldungen (Alerting Scheibe 1, Konzept §6.8, Entscheid 4A; Kunden-Alarmierung P3, KA-6 A): `#/meldungen` hinter der
 * Glocke, ohne Eintrag in der Leiste - EIN Ort mit den Reitern Jetzt · Verlauf · Einstellen.
 *
 * - **Jetzt:** eine Karte je Meldung - Stufe, „seit“, der Titel als Aussage, die Anlage, ein Satz Ursache, „Zur Anlage“
 *   und „Stumm“. Öffnen gilt als gesehen (der Knopf „Gesehen“ entfällt). Hinweise stehen unter „Leise“ und zählen
 *   nicht in der Glocke (KA-4 B). Solange kein Push-Gerät da ist, steht die erste Einrichtung darunter.
 * - **Verlauf:** wie bisher, mit Ende und Dauer statt „seit“; CSV je Zeitraum.
 * - **Einstellen:** oben „So erreichen wir Sie“ (die Bausteine der Einstellungsseite), darunter „Das melden wir“ als
 *   Schalterliste; ein Tipp auf eine Zeile zeigt Wartezeit und Empfänger; ganz unten „Eigene Überwachung“.
 */
export function MeldungenPage() {
  const [reiter, setReiter] = useState<Reiter>(() => reiterAusHash(window.location.hash) ?? 'jetzt');
  const [meldungen, setMeldungen] = useState<Meldung[] | null>(null);
  const [regeln, setRegeln] = useState<UeberwachungsRegel[] | null>(null);
  const [anlagenNamen, setAnlagenNamen] = useState<Record<string, string>>({});
  const [fehler, setFehler] = useState('');
  const [aktionsFehler, setAktionsFehler] = useState('');
  const [neuLaden, setNeuLaden] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [csvPeriode, setCsvPeriode] = useState('monat');
  const [csvLaedt, setCsvLaedt] = useState(false);
  const [csvFehler, setCsvFehler] = useState('');
  const [loeschenZiel, setLoeschenZiel] = useState<UeberwachungsRegel | null>(null);
  const [neuOffen, setNeuOffen] = useState(false);
  const [neuWert, setNeuWert] = useState<WertWahl | null>(null);
  const [bearbeiten, setBearbeiten] = useState<UeberwachungsRegel | null>(null);
  const [stummFuer, setStummFuer] = useState<string | null>(null);
  const [stummGesetzt, setStummGesetzt] = useState<Record<string, string>>({});
  const [einrichtung, setEinrichtung] = useEinrichtungsStand();
  // Kunden-Alarmierung P4: wie jede Meldung die Person erreichte (Versand-Protokoll) und welche Wege gerade ausfallen.
  // Beides nachrangig: ohne Antwort steht die Karte ohne Zustellstand da, nie mit einem Fehler.
  const [zustellung, setZustellung] = useState<Record<string, Zustellstand>>({});
  const [ausfaelle, setAusfaelle] = useState<WegAusfall[]>([]);
  const anlageFilter = anlageAusHash(window.location.hash);
  // Kunden-Alarmierung P1: „Ansehen“ in der Mail und der Tipp auf den Push zeigen auf EINE Meldung. Ist sie nicht
  // mehr offen, steht sie im Verlauf - einmal dorthin wechseln.
  const gemeint = meldungAusHash(window.location.hash);
  const verlaufGesucht = useRef(false);
  const isPhone = useIsPhone();
  const { selbst } = useRollen();
  // Wer sich an irgendeinem Standort (oder am Unternehmen) selbst benachrichtigen lassen darf, sieht „Eigene
  // Überwachung“; ob es am gewählten Ort erlaubt ist, entscheidet der Server beim Anlegen.
  const hatRecht = (recht: string) =>
    !!selbst && selbst.zustand === 'aktiv'
    && (selbst.unternehmen_rechte.includes(recht) || selbst.standorte.some((st) => st.rechte.includes(recht)));
  const darfAnlegen = hatRecht(RECHT_EIGENE);
  // „Stumm“ trifft alle Empfänger der Regel und braucht darum ueberwachung.verwalten (der Server prüft am Standort).
  const darfStumm = hatRecht(RECHT_VERWALTEN);

  useEffect(() => {
    let aktiv = true;
    setFehler('');
    const laden =
      reiter === 'einstellen'
        ? Promise.all([
            meldungenApi.regeln(),
            api.listSites().then(
              (l) => l.eintraege,
              () => [],
            ),
          ]).then(([r, sites]) => {
            if (!aktiv) return;
            setRegeln(r);
            setAnlagenNamen(Object.fromEntries(sites.map((s) => [s.id, s.name])));
          })
        : (reiter === 'jetzt' ? meldungenApi.jetzt() : meldungenApi.verlauf()).then((m) => {
            if (!aktiv) return;
            setMeldungen(m);
            if (reiter === 'jetzt' && gemeint && !verlaufGesucht.current && !m.some((x) => istGemeinteMeldung(x, gemeint))) {
              verlaufGesucht.current = true;
              setReiter('verlauf');
              return;
            }
            if (reiter === 'jetzt') alsGesehenMarkieren(m);
            benachrichtigungenApi.zustellung(m.map((x) => x.id)).then(
              (liste) => aktiv && setZustellung(Object.fromEntries(liste.map((z) => [z.meldungId, z]))),
              () => undefined,
            );
          });
    if (reiter !== 'verlauf') {
      benachrichtigungenApi.ausfaelle().then(
        (a) => aktiv && setAusfaelle(a),
        () => undefined,
      );
    }
    laden.catch(() => {
      if (aktiv) setFehler('Die Meldungen konnten nicht geladen werden. Bitte versuchen Sie es erneut.');
    });
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reiter, neuLaden, gemeint]);

  /**
   * Öffnen gilt als gesehen (Kunden-Alarmierung P3, §6.2): was „Jetzt“ zeigt, ist gesehen - das beendet auch die
   * Erinnerung bei Dringend. Still und nachrangig: scheitert es, bleibt die Meldung ungesehen und die Glocke zählt sie.
   */
  function alsGesehenMarkieren(liste: Meldung[]) {
    const ungesehen = liste.filter((m) => !m.gesehenVon && (!anlageFilter || m.anlageId === anlageFilter));
    for (const m of ungesehen) {
      meldungenApi.gesehen(m.id).then(
        (neu) => setMeldungen((alt) => alt?.map((x) => (x.id === neu.id ? neu : x)) ?? alt),
        () => undefined,
      );
    }
  }

  const gefiltert = (meldungen ?? []).filter((m) => !anlageFilter || m.anlageId === anlageFilter);
  const sortiert = reiter === 'verlauf' ? sortiereVerlauf(gefiltert) : sortiereJetzt(gefiltert);
  const liste = gemeint
    ? [...sortiert.filter((m) => istGemeinteMeldung(m, gemeint)), ...sortiert.filter((m) => !istGemeinteMeldung(m, gemeint))]
    : sortiert;

  // GE-3: ein Alarm je Einheit führt auf die Seite der Einheit — dafür die Steuerungen ihrer Anlage und die Boxen,
  // nur wenn es solche Meldungen gibt. Fail-soft: ohne Antwort steht die Meldung ohne Weg da.
  const einheitAnlagen = useMemo(
    () => [...new Set((meldungen ?? []).filter((m) => einheitAusBezug(m.bezugKennung) && m.anlageId).map((m) => m.anlageId as string))].sort().join(','),
    [meldungen],
  );
  const [steuerungenJe, setSteuerungenJe] = useState<Record<string, Anlagensteuerung[]>>({});
  useEffect(() => {
    let aktiv = true;
    for (const id of einheitAnlagen.split(',').filter(Boolean)) {
      api.anlagensteuerungen(id).then(
        (l) => aktiv && setSteuerungenJe((alt) => ({ ...alt, [id]: l?.steuerungen ?? [] })),
        () => undefined,
      );
    }
    return () => {
      aktiv = false;
    };
  }, [einheitAnlagen]);
  const boxen = useBoxen(einheitAnlagen !== '');
  const einheitLink = (m: Meldung) =>
    m.anlageId ? meldungEinheitLink(m, steuerungenJe[m.anlageId], boxRefOf(boxen, m.anlageId)) : null;

  async function stummSchalten(m: Meldung, bis: Date, label: string) {
    if (busy || !m.ueberwachungId) return;
    setBusy(m.id);
    setAktionsFehler('');
    try {
      await benachrichtigungenApi.stummschalten('regel', m.ueberwachungId, bis.toISOString(), null);
      setStummGesetzt((alt) => ({ ...alt, [m.id]: label }));
      setStummFuer(null);
    } catch {
      setAktionsFehler('Stummschalten hat nicht geklappt. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(null);
    }
  }

  /** Entscheid 14A: der Verlauf je Periode als CSV - ein Nachweis für die eigene Dokumentation,
   * kein Anspruch auf Normerfüllung (MX4). */
  async function verlaufCsv() {
    if (csvLaedt) return;
    setCsvLaedt(true);
    setCsvFehler('');
    try {
      const { von, bis } = csvZeitraum(csvPeriode, new Date());
      await ladeMeldungenVerlaufCsv(von, bis);
    } catch {
      setCsvFehler('Die Datei konnte nicht geladen werden. Bitte versuchen Sie es erneut.');
    } finally {
      setCsvLaedt(false);
    }
  }

  function regelErsetzen(neu: UeberwachungsRegel) {
    setRegeln((alt) => {
      if (!alt) return alt;
      const da = alt.some((r) => r.id === neu.id);
      // Die Antwort von Anlegen trägt keine Empfänger - beim Ändern kommen sie mit, sonst bleiben die alten.
      return da ? alt.map((r) => (r.id === neu.id ? { ...r, ...neu } : r)) : [neu, ...alt];
    });
  }

  /** „Das melden wir“: eine Regel an- oder ausschalten (`PUT /regeln/{id}/aktiv`). */
  async function schalten(r: UeberwachungsRegel, aktiv: boolean) {
    if (busy) return;
    setBusy(r.id);
    setAktionsFehler('');
    regelErsetzen({ ...r, aktiv });
    try {
      regelErsetzen(await ueberwachungApi.schalten(r.id, aktiv));
    } catch {
      regelErsetzen(r);
      setAktionsFehler('Das Umschalten hat nicht geklappt. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(null);
    }
  }

  /** „Jetzt melden“ (KA-3 A): beendet einen laufenden Probelauf. */
  async function scharfSchalten(id: string) {
    if (busy) return;
    setBusy(id);
    setAktionsFehler('');
    try {
      const neu = await ueberwachungApi.scharfSchalten(id);
      setRegeln((alt) => alt?.map((r) => (r.id === id ? { ...r, probelaufBis: neu.probelaufBis } : r)) ?? alt);
    } catch {
      setAktionsFehler('Das hat nicht geklappt. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(null);
    }
  }

  /** Löschen - eine eigene Regel verschwindet, der Verlauf bleibt (Entscheid 3B). */
  async function loeschen(id: string) {
    if (busy) return;
    setBusy(id);
    try {
      await ueberwachungApi.loeschen(id);
      setRegeln((alt) => alt?.filter((r) => r.id !== id) ?? alt);
      setLoeschenZiel(null);
    } catch {
      setAktionsFehler('Das Löschen ist fehlgeschlagen. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(null);
    }
  }

  const jetzt = new Date();
  const karten = reiter === 'jetzt' ? liste.filter((m) => !istLeise(m)) : liste;
  const leise = reiter === 'jetzt' ? liste.filter(istLeise) : [];
  const zeigeEinrichtung = reiter === 'jetzt' && einrichtung != null && einrichtungOffen(einrichtung) && meldungen !== null;

  return (
    <div className="vp-meldungen" data-testid="meldungen-seite">
      <h1>Meldungen</h1>
      <div className="vp-bereich-tabs" role="tablist" aria-label="Meldungen">
        {(
          [
            ['jetzt', 'Jetzt'],
            ['verlauf', 'Verlauf'],
            ['einstellen', 'Einstellen'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={reiter === key}
            className={`vp-bereich-tab${reiter === key ? ' active' : ''}`}
            data-testid={`meldungen-reiter-${key}`}
            onClick={() => setReiter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {fehler && <ErrorState message={fehler} onRetry={() => setNeuLaden((n) => n + 1)} />}
      {aktionsFehler && (
        <p className="vp-meldungen-aktionsfehler" role="alert">
          {aktionsFehler}
        </p>
      )}

      {reiter === 'verlauf' && (
        <div className="vp-meldungen-csv" data-testid="verlauf-csv">
          <VpPicker ariaLabel="Zeitraum des Exports" options={CSV_PERIODEN} value={csvPeriode} onChange={setCsvPeriode} />
          <Button variant="outline" size="sm" disabled={csvLaedt} onClick={() => void verlaufCsv()}>
            Verlauf als CSV
          </Button>
          {csvFehler && <p role="alert">{csvFehler}</p>}
        </div>
      )}

      {reiter === 'einstellen' ? (
        <div className="vp-meldungen-einstellen" data-testid="meldungen-einstellen">
          <WegAusfaelle ausfaelle={ausfaelle} jetzt={jetzt} />
          <EinstellungenPage ansicht="meldungen" />
          {fehler && regeln === null ? null : (
            <DasMeldenWir
              regeln={regeln}
              anlagenNamen={anlagenNamen}
              busy={busy}
              darfAnlegen={darfAnlegen}
              onSchalten={(r, a) => void schalten(r, a)}
              onScharf={(id) => void scharfSchalten(id)}
              onAendern={setBearbeiten}
              onLoeschen={setLoeschenZiel}
              onNeu={() => setNeuOffen(true)}
            />
          )}
        </div>
      ) : fehler && meldungen === null ? null : meldungen === null ? (
        <p>Wird geladen …</p>
      ) : (
        <>
          {reiter === 'jetzt' && (
            <WegAusfaelle ausfaelle={ausfaelle} jetzt={jetzt} onEinstellen={() => setReiter('einstellen')} />
          )}
          {karten.length === 0 ? (
            <div className="vp-meldungen-leer">
              <EmptyState
                icon={reiter === 'jetzt' ? 'check' : 'bell'}
                category={reiter === 'jetzt' ? 'ev' : 'primary'}
                title={reiter === 'jetzt' ? 'Alles ruhig' : 'Noch nichts erledigt'}
                description={
                  reiter === 'jetzt'
                    ? 'Wenn etwas ist, melden wir uns.'
                    : 'Erledigte Meldungen erscheinen hier, sobald eine vorbei ist.'
                }
              />
            </div>
          ) : (
            <ul className="vp-meldungen-liste">
              {karten.map((m) => (
                <MeldungKarte
                  key={m.id}
                  m={m}
                  reiter={reiter}
                  jetzt={jetzt}
                  hervor={istGemeinteMeldung(m, gemeint)}
                  quelle={meldungQuelleLink(m) ?? einheitLink(m)}
                  darfStumm={darfStumm && !!m.ueberwachungId}
                  stummOffen={stummFuer === m.id}
                  stummGesetzt={stummGesetzt[m.id] ?? null}
                  busy={busy === m.id}
                  zustell={zustellSatz(zustellung[m.id], jetzt, m.zustand === 'erledigt')}
                  entwarnungZustell={reiter === 'verlauf' ? entwarnungSatz(zustellung[m.id], jetzt) : null}
                  onStummOeffnen={() => setStummFuer((alt) => (alt === m.id ? null : m.id))}
                  onStumm={(bis, label) => void stummSchalten(m, bis, label)}
                />
              ))}
            </ul>
          )}

          {leise.length > 0 && (
            <section className="vp-meldungen-leise" aria-labelledby="meldungen-leise-h" data-testid="meldungen-leise">
              <h2 id="meldungen-leise-h">Leise</h2>
              <ul>
                {leise.map((m) => {
                  const text = m.text ? ausgeloest(m.text, jetzt) : null;
                  const zustell = zustellSatz(zustellung[m.id], jetzt, m.zustand === 'erledigt');
                  return (
                    <li key={m.id}>
                      <span>{text ? titelOhneOrt(text.titel, m) : wertartSatzname(m.wertart)}</span>
                      <span className="vp-meldungen-leise-sub">
                        {m.anlageName ?? ''}
                        {m.anlageName ? ' · ' : ''}
                        {zeitKurz(m.ausgeloestAm, jetzt)}
                      </span>
                      {zustell && (
                        <span className={`vp-meldung-zustellung ton-${zustell.ton}`} data-testid="leise-zustellung">
                          {zustell.text}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {zeigeEinrichtung && einrichtung && (
            <section className="vp-meldungen-einrichtung" aria-label="So erreichen Sie Meldungen">
              {karten.length > 0 && <h2>So erreichen Sie Meldungen</h2>}
              <ErsteEinrichtung stand={einrichtung} onStand={setEinrichtung} />
            </section>
          )}
        </>
      )}

      <ConfirmDialog
        open={loeschenZiel != null}
        title="Überwachung löschen?"
        intro={`„${loeschenZiel ? regelName(loeschenZiel) : ''}" meldet sich danach nicht mehr.`}
        consequences={['Der bisherige Verlauf dieser Überwachung bleibt erhalten.', 'Noch offene Meldungen dieser Regel werden geschlossen.']}
        confirmLabel="Löschen"
        tone="danger"
        busy={loeschenZiel != null && busy === loeschenZiel.id}
        onCancel={() => setLoeschenZiel(null)}
        onConfirm={() => {
          if (loeschenZiel) void loeschen(loeschenZiel.id);
        }}
      />

      <NeueUeberwachung
        offen={neuOffen}
        isPhone={isPhone}
        onClose={() => setNeuOffen(false)}
        onWahl={(w) => {
          setNeuOffen(false);
          setNeuWert(w);
        }}
      />
      {neuWert && (
        <UeberwachenBlatt
          key={neuWert.schluessel}
          offen
          isPhone={isPhone}
          onClose={() => setNeuWert(null)}
          wertart={neuWert.wertart}
          bezug={neuWert.bezug}
          aktuellerWert={neuWert.aktuellerWert}
          einheit={neuWert.einheit}
          titelZusatz={neuWert.titelZusatz}
          onUeberwacht={() => setNeuLaden((n) => n + 1)}
        />
      )}
      {bearbeiten && (
        <UeberwachenBlatt
          key={`aendern-${bearbeiten.id}`}
          offen
          isPhone={isPhone}
          onClose={() => setBearbeiten(null)}
          wertart={bearbeiten.wertart}
          bezug={bezugAusRegel(bearbeiten)}
          aktuellerWert={null}
          einheit={einheitDerRegel(bearbeiten)}
          titelZusatz={regelName(bearbeiten)}
          regel={bearbeiten}
          onUeberwacht={regelErsetzen}
        />
      )}
    </div>
  );
}

/** Das Recht, sich selbst zu einem Wert benachrichtigen zu lassen (Alerting §6.6, Entscheid 5A). */
const RECHT_EIGENE = 'ueberwachung.eigene';
/** Überwachungen für andere und Stummschalten für alle (Alerting §6.6). */
const RECHT_VERWALTEN = 'ueberwachung.verwalten';

/** Der Titel ohne vorangestellten Ort („Hof Lindenberg: Box meldet sich nicht“ → „Box meldet sich nicht“) - die
 * Karte nennt die Anlage in einer eigenen Zeile. */
function titelOhneOrt(titel: string, m: Meldung): string {
  const ort = m.text?.ort ?? m.anlageName;
  return ort && titel.startsWith(`${ort}: `) ? titel.slice(ort.length + 2) : titel;
}

/** Der Bezug einer Regel für das Blatt „Ändern“ (Wertart und Bezug bleiben, nur gelesen). */
function bezugAusRegel(r: UeberwachungsRegel): Parameters<typeof UeberwachenBlatt>[0]['bezug'] {
  try {
    const b = JSON.parse(r.bezugJson ?? '{}') as Record<string, string>;
    if (b.komponente) return { komponente: b.komponente, kanal: b.kanal ?? '' };
    if (b.messstelle) return { messstelle: b.messstelle };
    if (b.kennzahl) return { kennzahl: b.kennzahl };
    if (b.energieziel) return { energieziel: b.energieziel };
    return { anlage: b.anlage ?? '' };
  } catch {
    return { anlage: '' };
  }
}

function einheitDerRegel(r: UeberwachungsRegel): string {
  return r.wertart === 'anlage.preis.jetzt' ? 'ct/kWh' : r.wertart.endsWith('ladestand') ? '%' : 'kW';
}

function MeldungKarte({
  m,
  reiter,
  jetzt,
  hervor,
  quelle,
  darfStumm,
  stummOffen,
  stummGesetzt,
  busy,
  zustell,
  entwarnungZustell,
  onStummOeffnen,
  onStumm,
}: {
  m: Meldung;
  reiter: Reiter;
  jetzt: Date;
  hervor: boolean;
  quelle: { label: string; hash: string } | null;
  darfStumm: boolean;
  stummOffen: boolean;
  stummGesetzt: string | null;
  busy: boolean;
  /** Kunden-Alarmierung P4: wie diese Meldung die Person erreichte - `null`, solange der Stand fehlt. */
  zustell: ZustellSatz | null;
  /** Im Verlauf: die Entwarnung, wenn sie hinausging. */
  entwarnungZustell: string | null;
  onStummOeffnen: () => void;
  onStumm: (bis: Date, label: string) => void;
}) {
  // Kunden-Alarmierung P1: derselbe Text wie in Mail und Push (meldungsText.ts ↔ MeldungsText.java).
  const text = m.text ? ausgeloest(m.text, jetzt) : null;
  const ende = m.text && reiter === 'verlauf' ? entwarnung(m.text, jetzt) : null;
  const titel = text ? titelOhneOrt(text.titel, m) : wertartSatzname(m.wertart);
  // Ein Satz Ursache: nach der Lage (die „seit“ schon sagt) steht die Ursache; ohne sie die Lage.
  const satz = text ? (text.saetze[1] ?? text.saetze[0] ?? null) : null;
  const endeAm = m.erledigtAm ?? m.wiederNormalAm;
  const anlageHash = m.anlageId ? `#/anlage/${m.anlageId}` : null;
  const ziel = quelle ?? (anlageHash ? { label: 'Zur Anlage', hash: anlageHash } : null);
  return (
    <li
      className={`vp-meldung vp-meldung-karte schwere-${m.schwere}${hervor ? ' gemeint' : ''}`}
      aria-current={hervor ? 'true' : undefined}
      data-testid={hervor ? 'meldung-gemeint' : 'meldung-karte'}
    >
      <span className="vp-meldung-dot" aria-hidden="true" />
      <div className="vp-meldung-inhalt">
        <div className="vp-meldung-kopf">
          <span className="vp-meldung-schwere">{SCHWERE_WORT[m.schwere]}</span>
          {reiter === 'verlauf' && endeAm ? (
            <span className="vp-meldung-seit" data-testid="meldung-dauer">
              {zeitKurz(m.ausgeloestAm, jetzt)} bis {zeitKurz(endeAm, jetzt)} · {dauerText(m.ausgeloestAm, endeAm)}
            </span>
          ) : (
            <span className="vp-meldung-seit">seit {zeitKurz(m.ausgeloestAm, jetzt)}</span>
          )}
        </div>
        <h3 className="vp-meldung-titel" data-testid="meldung-titel">
          {titel}
        </h3>
        {m.anlageName && <p className="vp-meldung-ort">{m.anlageName}</p>}
        {satz && (
          <p className="vp-meldung-satz" data-testid="meldung-text">
            {satz}
          </p>
        )}
        {ende && (
          <p className="vp-meldung-satz vp-meldung-entwarnung" data-testid="meldung-entwarnung">
            {ende.saetze.join(' ')}
          </p>
        )}
        {reiter === 'jetzt' && (ziel || darfStumm) && (
          <div className="vp-meldung-knoepfe">
            {ziel && (
              <a className="vp-btn vp-btn--primary vp-btn--sm" href={ziel.hash} data-testid="meldung-quelle-link">
                {ziel.label}
              </a>
            )}
            {darfStumm && !stummGesetzt && (
              <Button variant="outline" size="sm" aria-expanded={stummOffen} disabled={busy} onClick={onStummOeffnen}>
                Stumm
              </Button>
            )}
          </div>
        )}
        {stummOffen && !stummGesetzt && (
          <div className="vp-meldung-stumm" role="group" aria-label="Wie lange stumm?" data-testid="meldung-stumm">
            <span>Diese Überwachung stumm für:</span>
            {STUMM_FRISTEN.map((f) => (
              <Button key={f.key} variant="ghost" size="sm" disabled={busy} onClick={() => onStumm(f.bis(new Date()), f.label)}>
                {f.label}
              </Button>
            ))}
          </div>
        )}
        {stummGesetzt && (
          <p className="vp-meldung-gesehen" role="status">
            Stumm für {stummGesetzt}. Meldungen dieser Überwachung gehen bis dahin nicht hinaus.
          </p>
        )}
        {zustell && (
          <p className={`vp-meldung-zustellung ton-${zustell.ton}`} data-testid="meldung-zustellung">
            <Icon name={zustell.ton === 'gemeldet' ? 'check' : zustell.ton === 'fehler' ? 'alert-triangle' : 'bell'} size={14} />
            <span>
              {zustell.text}
              {entwarnungZustell ? ` · ${entwarnungZustell}` : ''}
            </span>
          </p>
        )}
        <p className="vp-meldung-kennzeichen">
          {m.kennzeichen}
          {istEigeneUeberwachung(m.wertart) && (
            <span className="vp-meldung-eigene" data-testid="meldung-eigene-ueberwachung">
              {' '}· {WORT_EIGENE_UEBERWACHUNG}
            </span>
          )}
          {m.gesehenVon && (
            <>
              {' '}· Gesehen von {m.gesehenVon}
              {m.gesehenAm ? `, ${zeitKurz(m.gesehenAm, jetzt)}` : ''}
            </>
          )}
        </p>
      </div>
    </li>
  );
}

/**
 * „Das melden wir“ (Kunden-Alarmierung P3, §6.2/§6.3): jede Regel als Zeile mit Schalter - ab Werk mit dem Namen der
 * Meldungsart, eigene mit ihrem Namen. Gezeigt wird nur, was es gibt. Ein Tipp auf eine Zeile zeigt Wartezeit und
 * Empfänger; eigene Regeln lassen sich dort ändern und löschen, ein laufender Probelauf „Jetzt melden“. Mit mehreren
 * Anlagen wählt oben eine Auswahl, welche.
 */
function DasMeldenWir({
  regeln,
  anlagenNamen,
  busy,
  darfAnlegen,
  onSchalten,
  onScharf,
  onAendern,
  onLoeschen,
  onNeu,
}: {
  regeln: UeberwachungsRegel[] | null;
  anlagenNamen: Record<string, string>;
  busy: string | null;
  darfAnlegen: boolean;
  onSchalten: (r: UeberwachungsRegel, aktiv: boolean) => void;
  onScharf: (id: string) => void;
  onAendern: (r: UeberwachungsRegel) => void;
  onLoeschen: (r: UeberwachungsRegel) => void;
  onNeu: () => void;
}) {
  const [offen, setOffen] = useState<string | null>(null);
  const [anlage, setAnlage] = useState('alle');
  const ichName = currentUser().name;
  if (regeln === null) return <p>Wird geladen …</p>;

  const anlagen = [...new Set(regeln.map(regelAnlage).filter((a): a is string => a != null))];
  const auswahl = anlagen.length > 1
    ? [{ value: 'alle', label: 'Alle Anlagen' }, ...anlagen.map((a) => ({ value: a, label: anlagenNamen[a] ?? 'Anlage' }))]
    : null;
  const sichtbar = sortiereRegeln(regeln.filter((r) => anlage === 'alle' || regelAnlage(r) === anlage || regelAnlage(r) == null));
  const mehrereAnlagen = anlagen.length > 1 && anlage === 'alle';

  return (
    <section className="vp-melden-wir" aria-labelledby="melden-wir-h" data-testid="das-melden-wir">
      <div className="vp-melden-wir-kopf">
        <h3 id="melden-wir-h">Das melden wir</h3>
        {auswahl && <VpPicker ariaLabel="Für welche Anlage" options={auswahl} value={anlage} onChange={setAnlage} />}
      </div>
      {sichtbar.length === 0 ? (
        <p className="vp-note">Noch nichts eingerichtet. Sobald Ihre Box verbunden ist, meldet VoltPilot, wenn sie sich nicht meldet.</p>
      ) : (
        <ul className="vp-melden-wir-liste">
          {sichtbar.map((r) => {
            const istOffen = offen === r.id;
            const wartezeit = wartezeitText(r);
            const an = empfaengerText(r, ichName);
            const anlageName = regelAnlage(r) ? anlagenNamen[regelAnlage(r) as string] : null;
            const unter = [
              r.wertart === 'anlage.preis.jetzt' && r.herkunft === 'ab_werk' ? 'leise, höchstens einmal am Tag' : null,
              r.herkunft !== 'ab_werk' ? WORT_EIGENE_UEBERWACHUNG : null,
              wartezeit,
              mehrereAnlagen && anlageName ? anlageName : null,
              r.probelaufBis ? `zählt nur mit bis ${datumZeit(r.probelaufBis).slice(0, 10)}` : null,
            ].filter(Boolean);
            const name = regelName(r);
            return (
              <li key={r.id} className={`vp-melden-wir-zeile${r.aktiv ? '' : ' is-aus'}`} data-testid="melden-wir-zeile">
                <div className="vp-melden-wir-haupt">
                  <button
                    type="button"
                    className="vp-melden-wir-text"
                    aria-expanded={istOffen}
                    onClick={() => setOffen(istOffen ? null : r.id)}
                  >
                    <b>{name}</b>
                    {unter.length > 0 && <span>{unter.join(' · ')}</span>}
                  </button>
                  <Switch
                    id={`melden-wir-${r.id}`}
                    checked={r.aktiv}
                    disabled={busy === r.id}
                    onChange={(e) => onSchalten(r, e.target.checked)}
                    label={<span className="vp-sr-only">{name}</span>}
                  />
                </div>
                {istOffen && (
                  <div className="vp-melden-wir-details" data-testid="melden-wir-details">
                    <dl>
                      <div>
                        <dt>Meldet</dt>
                        <dd>{wartezeit ?? 'sobald es eintritt'}</dd>
                      </div>
                      <div>
                        <dt>Wie wichtig</dt>
                        <dd>{SCHWERE_WORT[r.schwere]}</dd>
                      </div>
                      <div>
                        <dt>Empfänger</dt>
                        <dd>{an ?? 'niemand'}</dd>
                      </div>
                      {anlageName && (
                        <div>
                          <dt>Anlage</dt>
                          <dd>{anlageName}</dd>
                        </div>
                      )}
                    </dl>
                    <div className="vp-melden-wir-aktionen">
                      {r.probelaufBis && (
                        <Button variant="outline" size="sm" disabled={busy === r.id} onClick={() => onScharf(r.id)}>
                          Jetzt melden
                        </Button>
                      )}
                      {loeschbar(r) && (
                        <Button variant="outline" size="sm" disabled={busy === r.id} onClick={() => onAendern(r)}>
                          Ändern
                        </Button>
                      )}
                      {loeschbar(r) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="vp-btn-danger"
                          disabled={busy === r.id}
                          aria-label={`${name} löschen`}
                          onClick={() => onLoeschen(r)}
                        >
                          <Icon name="trash" size={14} /> Löschen
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {darfAnlegen && (
        <button type="button" className="vp-melden-wir-neu" onClick={onNeu} data-testid="eigene-ueberwachung-neu">
          <span>
            <b>Eigene Überwachung</b>
            <span>Ein Wert, eine Schwelle - zum Beispiel Netzbezug über 10 kW.</span>
          </span>
          <Icon name="plus" size={18} />
        </button>
      )}
    </section>
  );
}

/**
 * „Ein Weg fällt aus“ (Kunden-Alarmierung P4): eine Karte je ausgefallenem Weg - in „Jetzt“ mit dem Weg zu „Einstellen“,
 * dort ohne. Bisher stand ein Fehlschlag nur im Protokoll, ein abgemeldetes Push-Gerät war still aus.
 */
function WegAusfaelle({
  ausfaelle,
  jetzt,
  onEinstellen,
}: {
  ausfaelle: readonly WegAusfall[];
  jetzt: Date;
  onEinstellen?: () => void;
}) {
  if (ausfaelle.length === 0) return null;
  return (
    <section className="vp-meldungen-ausfall" aria-label="Wege, über die gerade nichts ankommt" data-testid="weg-ausfall">
      {ausfaelle.map((a) => {
        const t = ausfallText(a, jetzt);
        return (
          <div key={`${a.weg}:${a.id ?? ''}`} className="vp-meldungen-ausfall-karte" role="status">
            <Icon name="alert-triangle" size={18} />
            <div>
              <h2>{t.titel}</h2>
              <p>{t.satz}</p>
              {onEinstellen && (
                <Button variant="outline" size="sm" onClick={onEinstellen}>
                  Wege einstellen
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
