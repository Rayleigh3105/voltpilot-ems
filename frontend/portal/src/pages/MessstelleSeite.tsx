import { clearWerteCache } from '../uemsWerteCache';
import { Ablesungen } from '../components/Ablesungen';
import { RechteStandort } from '../rollen';
import { Recht } from '../components/Recht';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  ApiError,
  type Kostenstelle,
  type Messstelle,
  type MessstelleProzessZuordnung,
  type MessstellenRegister,
  type MessstelleQuellenListe,
  type MessstelleVerteilungAnteil,
  type OrtsbaumAmStichtag,
  type Prozess,
  type StandorteAmStichtag,
} from '../api';
import { MessstelleDialog } from '../components/MessstelleDialog';
import { QuelleBindenDialog, type QuelleBindenZiel } from '../components/QuelleBindenDialog';
import { ZaehlerwechselVerlauf } from '../components/ZaehlerwechselVerlauf';
import { ZaehlerwechselDialog } from '../components/ZaehlerwechselDialog';
import type { WechselZiel } from '../zaehlerwechsel';
import { QuelleKarte } from '../components/QuelleKarte';
import type { Schritt } from '../messstelleDialog';
import { PROTOKOLL_LABEL } from '../components/ProtokollDialog';
import { ProtokollListe, useProtokoll } from '../components/ProtokollListe';
import { ErrorState, Skeleton } from '../components/States';
import { WagoKarte } from '../components/WagoKarte';
import { kannKartenangabenHaben } from '../wagoKarte';
import { WerteSektion } from '../components/WerteSektion';
import { wahlHash } from '../uemsVergleich';
import { ZuordnungAendernDialog } from '../components/ZuordnungAendernDialog';
import { UEMS_WERTE } from '../glossar';
import { lebenszyklusWort, zeileWoerter, type Lebenszyklus } from '../messstellen';
import {
  AENDERN_AB,
  AENDERN_TITEL,
  aenderbar,
  BEARBEITEN,
  bestandAus,
  elektrischKarte,
  gespeichertSatz,
  HISTORIE,
  kopf,
  LADEFEHLER,
  MESSSTELLE_PROTOKOLL_ACHSE,
  namenAus,
  NICHT_GEFUNDEN,
  organisationKarte,
  ortKarte,
  ZUR_LISTE,
  type AendernArt,
  type Kataloge,
  type KartenZeile,
  type ZuordnungsKarte,
} from '../messstelleZuordnung';
import { quelleKarte, type BindungsRolle, type QuelleGroesseKarte } from '../quelleBinden';
import { lokalerTag, VORGABE_ZEITZONE, type Tag } from '../uemsOrtsbaum';
import { boxAmGeraet, boxWechselAmGeraet } from '../boxAnQuelle';
import { useBoxenAnQuellen } from '../useBoxenAnQuellen';
import { nebengroessen, periodeAus } from '../uemsWerteKarte';
import './MessstelleSeite.css';

interface Stamm {
  messstelle: Messstelle;
  /** `null` = nicht abrufbar (die Karte sagt es, statt eine leere Zuordnung zu zeigen). */
  prozesse: MessstelleProzessZuordnung[] | null;
  anteile: MessstelleVerteilungAnteil[] | null;
}

/**
 * Die Messstellen-Seite (UEMS AP-04 IP-8, Mockups R2 · Z4): Kopf mit Zustand und Quelle, drei
 * Zuordnungs-Karten Ort · Elektrisch · Organisation mit „Ändern ab …“ und der Historie je Karte,
 * darunter das Änderungsprotokoll nach dem Muster des Befehls-Verlaufs.
 *
 * Sie liest `GET /api/v1/messstellen/{id}` (Orte, Stellungen), `…/prozesse`, `…/verteilung`, das
 * Register von heute (Zustand, Quelle, „Unterzähler von …“), Standorte und Ortsbäume (Namen) und
 * die Kataloge Prozesse/Kostenstellen; das Protokoll `…/aenderungen?achse=eintrag`. Jede Ableitung
 * steht in `messstelleZuordnung.ts`; hier wird nur geladen und gerendert. Nach jedem Eintrag liest
 * die Seite neu — Karten, Historie und Protokoll zeigen dann den Stand des Servers.
 *
 * Das Ziel des Registers (`#/portfolio/messstellen/{id}`, `#/standort/{sid}/messstellen/{id}`).
 *
 * Über den Zuordnungs-Karten steht seit AP-04 IP-14 die QUELLE-KARTE (`components/QuelleKarte.tsx`,
 * abgeleitet in `quelleBinden.ts` aus `GET …/quellen`): je Messgröße die führende Quelle und jede
 * Vergleichsquelle mit ihren Werten NEBENEINANDER (E3), die Historie der führenden Quellen mit jeder
 * Lücke, und die Einstiege „Quelle binden“ · „Vergleichsquelle hinzufügen“ (`QuelleBindenDialog`).
 *
 * Direkt unter dem Kopf steht der Abschnitt „Werte“ (UEMS AP-13 IP-3, E9 = A): die `WerteSektion`, die
 * auch der Dialog an den Gesamtwert-Karten öffnet — hier wohnt die Zahl einer Messstelle. Periode und
 * Version kommen aus der Adresse (`?periode=2026-10-25&version=2`); mit einer Periode holt die Seite den
 * Abschnitt in den Blick, und jede neue Wahl meldet sie dem Wirt, der die Adresse nachschreibt.
 *
 * Eine Adresse darf seit AP-13 IP-11 auch das KENNZEICHEN nennen — siehe {@link KENNZEICHEN_ADRESSE}.
 */

/**
 * Eine Adresse, die ein KENNZEICHEN nennt statt der ID (`#/portfolio/messstellen/MS-12`). Die Sprünge der
 * Kette (AP-13 IP-11, D1) kennen nur das Kennzeichen — es steht in jeder Herkunfts-Zeile, nie eine UUID —,
 * die Routen der Seite brauchen aber die ID. Genau hier, an EINER Stelle, wird es aufgelöst.
 */
const KENNZEICHEN_ADRESSE = /^MS-[0-9A-Za-z]+$/;

export function MessstelleSeite(props: MessstelleSeiteProps) {
  const alsKennzeichen = KENNZEICHEN_ADRESSE.test(props.id);
  const [id, setId] = useState<string | 'fehlt' | null>(alsKennzeichen ? null : props.id);

  useEffect(() => {
    if (!alsKennzeichen) {
      setId(props.id);
      return;
    }
    let aktiv = true;
    setId(null);
    api.messstellenRegister().then(
      (r) => aktiv && setId(r.register.find((z) => z.kennzeichen === props.id)?.id ?? 'fehlt'),
      // Ohne Register ist das Kennzeichen nicht aufzulösen — dann sagt die Seite das, statt leer zu bleiben.
      () => aktiv && setId('fehlt'),
    );
    return () => {
      aktiv = false;
    };
  }, [props.id, alsKennzeichen]);

  if (id === null) {
    return (
      <div className="vp-mss" data-testid="messstelle-seite" aria-busy="true">
        <Skeleton height={220} />
      </div>
    );
  }
  if (id === 'fehlt') {
    return (
      <div className="vp-mss" data-testid="messstelle-seite">
        <button type="button" className="vp-mss-zurueck" onClick={props.onListe}>
          <Icon name="chevron-left" size={18} />
          {ZUR_LISTE}
        </button>
        <p className="vp-mss-leer">{NICHT_GEFUNDEN}</p>
      </div>
    );
  }
  return <MessstelleSeiteMitId {...props} key={id} id={id} />;
}

interface MessstelleSeiteProps {
  id: string;
  zone?: string;
  /** Periode und Version der Adresse für den Abschnitt „Werte“. */
  werte?: { periode: string | null; version: number | null; vergleich: string | null } | null;
  /** Die neu gewählte Periode der Werte (`JJJJ-MM-TT` bzw. `JJJJ-MM`). */
  onWerteZeitraum?: (periode: string) => void;
  /** AP-13 IP-5: eine neue Wahl des Vergleichs-Umschalters — der Wirt schreibt sie als `v=` in die Adresse. */
  onWerteVergleich?: (v: string | null) => void;
  onListe: () => void;
}

function MessstelleSeiteMitId({
  id,
  zone = VORGABE_ZEITZONE,
  werte = null,
  onWerteZeitraum,
  onWerteVergleich,
  onListe,
}: MessstelleSeiteProps) {
  const [stamm, setStamm] = useState<Stamm | null>(null);
  const [stammFehler, setStammFehler] = useState<'fehlt' | 'fehler' | null>(null);
  const [register, setRegister] = useState<MessstellenRegister | null>(null);
  const [registerGelesen, setRegisterGelesen] = useState(false);
  const [standorte, setStandorte] = useState<StandorteAmStichtag | null>(null);
  const [baeume, setBaeume] = useState<Record<string, OrtsbaumAmStichtag | undefined>>({});
  const [prozessKatalog, setProzessKatalog] = useState<Prozess[]>([]);
  const [kostenstellen, setKostenstellen] = useState<Kostenstelle[]>([]);
  const [versuch, setVersuch] = useState(0);
  const [aendern, setAendern] = useState<AendernArt | null>(null);
  const [gespeichert, setGespeichert] = useState<{ art: AendernArt; satz: string } | null>(null);
  const [bearbeiten, setBearbeiten] = useState(false);
  // „Bearbeiten“ öffnet Schritt 1, „Quelle zuordnen“ aus den Werten Schritt 3 (AP-13 IP-6).
  const [bearbeitenAb, setBearbeitenAb] = useState<Schritt>(1);
  const [bearbeitet, setBearbeitet] = useState(false);
  // UEMS AP-04 IP-14: die Quelle-Karte liest ihre eigene Route; `binden` ist der offene Dialog.
  const [wechsel, setWechsel] = useState<WechselZiel | null>(null);
  const [wechselStand, setWechselStand] = useState(0);
  const [quellen, setQuellen] = useState<MessstelleQuellenListe | null>(null);
  const [binden, setBinden] = useState<{ rolle: BindungsRolle; ziel: QuelleBindenZiel } | null>(null);
  const protokoll = useProtokoll({ art: 'messstelle', id }, { achse: MESSSTELLE_PROTOKOLL_ACHSE, anlegeSatz: true });

  useEffect(() => {
    let aktiv = true;
    setStammFehler(null);
    Promise.all([
      api.messstelle(id),
      api.messstelleProzesse(id).then(
        (p) => p.prozesse,
        () => null,
      ),
      api.messstelleVerteilung(id).then(
        (v) => v.anteile,
        () => null,
      ),
    ]).then(
      ([messstelle, prozesse, anteile]) => aktiv && setStamm({ messstelle, prozesse, anteile }),
      (e) => aktiv && setStammFehler(e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler'),
    );
    api.messstellenRegister().then(
      (r) => {
        if (!aktiv) return;
        setRegister(r);
        setRegisterGelesen(true);
      },
      // Ohne Register fehlen Zustand und Quelle im Kopf — die Karten stehen trotzdem.
      () => aktiv && setRegisterGelesen(true),
    );
    // Die Quellen je Größe (AP-04 IP-14): ohne sie steht die Quelle-Karte nicht — der Rest schon.
    api.messstelleQuellen(id).then(
      (q) => aktiv && setQuellen(q),
      () => aktiv && setQuellen(null),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  // Die Namen und Kataloge ändern sich durch einen Eintrag nicht — sie werden einmal gelesen.
  useEffect(() => {
    let aktiv = true;
    api.standorte().then(
      (s) => {
        if (!aktiv) return;
        setStandorte(s);
        for (const st of s.standorte) {
          api.standortOrte(st.id).then(
            (baum) => aktiv && setBaeume((alt) => ({ ...alt, [st.id]: baum })),
            () => undefined,
          );
        }
      },
      () => undefined,
    );
    api.prozesse().then(
      (p) => aktiv && setProzessKatalog(p.prozesse),
      () => undefined,
    );
    api.kostenstellen().then(
      (k) => aktiv && setKostenstellen(k.kostenstellen),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, []);

  const zeilen = register?.register ?? [];
  const namen = useMemo(() => namenAus(standorte, baeume, zeilen), [standorte, baeume, zeilen]);
  const kataloge: Kataloge = useMemo(
    () => ({ namen, prozesse: prozessKatalog, kostenstellen }),
    [namen, prozessKatalog, kostenstellen],
  );

  // Ein Sprung mit Periode (Register, Herkunfts-Zeile) holt den Abschnitt „Werte“ in den Blick — einmal, und
  // nur so weit wie nötig: steht er schon im Bild, bleibt die Seite, wo sie ist.
  const werteRef = useRef<HTMLElement>(null);
  const gesprungen = useRef(false);
  const geladen = stamm !== null && registerGelesen;
  useEffect(() => {
    if (!werte?.periode || !geladen || gesprungen.current) return;
    gesprungen.current = true;
    werteRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [werte, geladen]);

  // AP-13 IP-12 (L6): die Zuständigkeiten der Anlage dieser Messstelle — VOR den Leerbildern
  // gelesen, damit der Hook-Aufruf unbedingt bleibt. Ohne Anlage wird nichts gefragt.
  const boxen = useBoxenAnQuellen([zeilen.find((r) => r.id === id)?.elektrische_stellung?.anlage]);

  const zurueck = (
    <button type="button" className="vp-mss-zurueck" onClick={onListe}>
      <Icon name="chevron-left" size={18} />
      {ZUR_LISTE}
    </button>
  );

  if (stammFehler === 'fehlt') {
    return (
      <div className="vp-mss" data-testid="messstelle-seite">
        {zurueck}
        <p className="vp-mss-leer">{NICHT_GEFUNDEN}</p>
      </div>
    );
  }
  if (stammFehler) {
    return (
      <div className="vp-mss" data-testid="messstelle-seite">
        {zurueck}
        <ErrorState message={LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />
      </div>
    );
  }
  // „heute“ ist der Stichtag des Servers (das Register von heute) — erst mit ihm stehen die Karten.
  if (!stamm || !registerGelesen) {
    return (
      <div className="vp-mss" data-testid="messstelle-seite" aria-busy="true">
        {zurueck}
        <Skeleton height={220} />
      </div>
    );
  }

  const m = stamm.messstelle;
  const heute: Tag = register?.stichtag ?? lokalerTag(new Date().toISOString(), zone);
  const k = kopf(m);
  const zeile = zeilen.find((r) => r.id === m.id) ?? null;
  const w =
    zeile && register
      ? zeileWoerter(zeile, { ebene: { art: 'unternehmen', name: '' }, zone, zeitpunkt: register.zeitpunkt })
      : null;
  const bestand = bestandAus(m, stamm.prozesse, stamm.anteile);
  const karten: ZuordnungsKarte[] = [
    ortKarte(m, heute, namen),
    elektrischKarte(m, heute, namen),
    organisationKarte(stamm.prozesse, stamm.anteile, heute),
  ];
  const darfAendern = aenderbar(m);
  const werteAnfang = periodeAus(werte?.periode);
  const haupt = zeile?.hauptgroesse ?? m.hauptgroesse ?? null;
  const neben = haupt ? nebengroessen(w, haupt) : null;
  const oeffneBearbeiten = (ab: Schritt) => {
    setBearbeitenAb(ab);
    setBearbeiten(true);
  };
  // UEMS AP-04 IP-14: die Karten der Quelle-Karte; die Uhr ist der Zeitpunkt des Registers.
  const jetzt = register?.zeitpunkt ?? new Date().toISOString();
  // AP-13 IP-12 (L6): die Zuständigkeiten der Anlage dieser Messstelle — daraus nennt die Karte die Box.
  const quelleKarten: QuelleGroesseKarte[] = quellen ? quelleKarte(quellen, jetzt, boxen.karte) : [];
  const oeffneBinden = (rolle: BindungsRolle) => (karte: QuelleGroesseKarte) =>
    setBinden({
      rolle,
      ziel: {
        art: 'messstelle',
        messstelleId: m.id,
        kennzeichen: m.kennzeichen,
        groesse: karte.groesse,
        hauptgroesse: karte.hauptgroesse,
        // Die Anlage ihrer elektrischen Stellung am Stichtag — ohne sie stehen alle offen.
        anlageId: zeile?.elektrische_stellung?.anlage ?? null,
      },
    });

  return (
    <RechteStandort.Provider value={zeile?.ort.standort_id ?? null}>
    <div className="vp-mss" data-testid="messstelle-seite">
      {zurueck}
      <header className="vp-mss-kopf">
        <div className="vp-mss-kopf-text">
          <span className="vp-mss-kz">{k.kennzeichen}</span>
          <h1>{k.titel}</h1>
          <p>
            {[k.unter, lebenszyklusWort(m.lebenszyklus as Lebenszyklus)].filter(Boolean).join(' · ')}
          </p>
          {w?.beobachtung && <p className={`vp-mss-beob is-${w.beobachtung.ton}`}>{w.beobachtung.text}</p>}
          {w?.quelle.art === 'gebunden' && (
            <p className="vp-mss-quelle">
              Quelle: {[w.quelle.geraet, w.quelle.messwert, w.quelle.seit].join(' · ')}
            </p>
          )}
        </div>
        {darfAendern && (
          <Recht aktion="messstelle.bearbeiten"><Button variant="outline" onClick={() => oeffneBearbeiten(1)}>
            {BEARBEITEN}
          </Button></Recht>
        )}
      </header>

      <section className="vp-mss-werte" aria-labelledby="vp-mss-werte-titel" data-testid="werte" ref={werteRef}>
        <WerteSektion
          key={wechselStand}
          kennzeichen={m.kennzeichen}
          messstelle={`${k.kennzeichen} · ${k.titel}`}
          kopf={<h2 id="vp-mss-werte-titel">{UEMS_WERTE}</h2>}
          anfang={werteAnfang}
          // Die Version gehört zu GENAU der Periode der Adresse — ohne sie gibt es nichts zu wählen.
          version={werteAnfang ? (werte?.version ?? null) : null}
          heute={heute}
          standortName={zeile?.ort.standort_name ?? null}
          quelle={zeile?.quelle ?? null}
          korrekturKontext={quellen && zeile?.ort.standort_id && haupt?.einheit && m.art === 'gemessen' && m.lebenszyklus !== 'archiviert'
            ? { quellen, standort: zeile.ort.standort_id, einheit: haupt.einheit } : undefined}
          herkunftKontext={zeile?.quelle.fuehrend && zeile.ort.standort_id ? {
            deviceId: (zeitpunkt) => boxAmGeraet(boxen.karte, zeile.quelle.fuehrend?.geraet.id, zeitpunkt)?.boxId ?? null,
            siteId: zeile.ort.standort_id,
            entityId: zeile.quelle.fuehrend.komponente,
            pointKey: zeile.quelle.fuehrend.kanal,
            geraete: {
              [zeile.quelle.fuehrend.geraet.id]: [
                zeile.quelle.fuehrend.geraet.geraet,
                zeile.quelle.fuehrend.geraet.einbau,
                zeile.quelle.fuehrend.geraet.bezeichnung,
              ].filter(Boolean).join(' · '),
            },
            boxen: Object.fromEntries(boxen.quellen.flatMap(q => (q.zeitraeume ?? [])
              .filter(z => z.box.name)
              .map(z => [z.box.id, z.box.name!] as const))),
          } : undefined}
          // AP-13 IP-12 (L6): Übergabe und Box-Tausch im Verlauf sprechen aus der Zeitachse der Zuständigkeiten.
          boxWechsel={boxWechselAmGeraet(boxen.karte, zeile?.quelle.fuehrend?.geraet.id, boxen.quellen)}
          // AP-13 IP-5: der Vergleich braucht die Hauptgrößen der anderen Messstellen („passend“, O12).
          register={zeilen}
          medium={zeile?.medium}
          vergleich={werte?.vergleich ?? null}
          onVergleich={(w) => onWerteVergleich?.(wahlHash(w))}
          onQuelleZuordnen={darfAendern ? () => oeffneBearbeiten(3) : undefined}
          onZeitraum={onWerteZeitraum}
        />
        {/* V8: Nebengrößen haben keine Werte-Route — ihr letzter Wert aus dem Register, und wofür es Werte gibt. */}
        {neben && (
          <div className="vp-mss-neben" data-testid="werte-nebengroessen">
            <h3>{neben.titel}</h3>
            <ul>
              {neben.zeilen.map((z) => (
                <li key={z}>{z}</li>
              ))}
            </ul>
            <p>{neben.satz}</p>
          </div>
        )}
      </section>

      {quellen && m.art === 'gemessen' && haupt?.wertart === 'Zählerstand' && !quellen.quellen.some(q => q.rolle === 'fuehrend') && <Ablesungen onWirksam={() => { clearWerteCache(); setVersuch(v => v + 1); setWechselStand(v => v + 1); protokoll.reload(); }} kennzeichen={m.kennzeichen} einheit={haupt.einheit} zone={standorte?.standorte.find(s => s.id === zeile?.ort.standort_id)?.zeitzone ?? zone} archiviert={m.lebenszyklus === 'archiviert'} />}
      {quelleKarten.length > 0 && (
        <QuelleKarte
          karten={quelleKarten}
          darfBinden={darfAendern}
          onBinden={oeffneBinden('fuehrend')}
          onVergleich={oeffneBinden('vergleich')}
          onWechsel={(karte) => {
            const q = quellen?.groessen.find(g => g.groesse === karte.groesse.groesse && g.richtung === karte.groesse.richtung)?.fuehrend;
            if (q?.geraet.id) setWechsel({ art: 'messstelle', id: m.id, kennzeichen: m.kennzeichen, geraetId: q.geraet.id, anlageId: q.anlage });
          }}
        />
      )}

      {/* AP-05 IP-11: die Energiekarte — nur wo es eine WAGO-Komponente GIBT (sonst 404, nichts
          gezeichnet). Die Verlauf-Marker der Box-Ereignisse hängen NICHT hieran; sie stehen oben
          in der WerteSektion und erscheinen bei jeder Box, die sie meldet. */}
      {quellen?.groessen[0]?.fuehrend
        && kannKartenangabenHaben(quellen.groessen[0].fuehrend.geraet.hersteller) && (
        <WagoKarte
          anlageId={quellen.groessen[0].fuehrend.anlage}
          standortId={zeile?.ort.standort_id ?? null}
          entityId={quellen.groessen[0].fuehrend.komponente}
          zone={standorte?.standorte.find(s => s.id === zeile?.ort.standort_id)?.zeitzone ?? zone}
          einheit={haupt?.wertart === 'Zählerstand' ? haupt.einheit : null}
          onGetauscht={() => { setVersuch(v => v + 1); setWechselStand(v => v + 1); protokoll.reload(); }}
        />
      )}

      {quellen?.groessen[0]?.fuehrend && <ZaehlerwechselVerlauf
        anlageId={quellen.groessen[0].fuehrend.anlage}
        komponenten={[...new Set(quellen.quellen.map(q => q.komponente))]} stand={wechselStand} />}

      <div className="vp-mss-karten">
        {karten.map((karte) => (
          <Karte
            key={karte.art}
            karte={karte}
            darfAendern={darfAendern}
            gespeichert={gespeichert}
            onAendern={(art) => {
              setGespeichert(null);
              setAendern(art);
            }}
          />
        ))}
      </div>

      <section className="vp-mss-protokoll" aria-labelledby="vp-mss-protokoll-titel">
        <h2 id="vp-mss-protokoll-titel">{PROTOKOLL_LABEL}</h2>
        <ProtokollListe state={protokoll} />
      </section>

      {aendern && (
        <ZuordnungAendernDialog
          art={aendern}
          messstelle={m}
          bestand={bestand}
          kataloge={kataloge}
          standorte={standorte}
          baeume={baeume}
          register={zeilen}
          heute={heute}
          zone={zone}
          onClose={() => setAendern(null)}
          onGespeichert={(art, tag) => {
            setAendern(null);
            setGespeichert({ art, satz: gespeichertSatz(art, tag, heute, zone) });
            setVersuch((v) => v + 1);
            protokoll.reload();
          }}
        />
      )}
      {wechsel && <ZaehlerwechselDialog ziel={wechsel} onClose={() => setWechsel(null)}
        onBerichtigt={() => { setVersuch(v => v + 1); setWechselStand(v => v + 1); protokoll.reload(); }}
        onGewechselt={() => { setVersuch(v => v + 1); setWechselStand(v => v + 1); protokoll.reload(); }} />}
      {binden && (
        <QuelleBindenDialog
          open
          rolle={binden.rolle}
          ziel={binden.ziel}
          jetzt={jetzt}
          onClose={() => setBinden(null)}
          onGebunden={() => {
            setVersuch((v) => v + 1);
            protokoll.reload();
          }}
        />
      )}
      <MessstelleDialog
        open={bearbeiten}
        messstelleId={m.id}
        schritt={bearbeitenAb}
        heute={heute}
        onClose={() => {
          setBearbeiten(false);
          if (!bearbeitet) return;
          setBearbeitet(false);
          setVersuch((v) => v + 1);
          protokoll.reload();
        }}
        onGespeichert={() => setBearbeitet(true)}
      />
    </div>
    </RechteStandort.Provider>
  );
}

function Karte({
  karte,
  darfAendern,
  gespeichert,
  onAendern,
}: {
  karte: ZuordnungsKarte;
  darfAendern: boolean;
  gespeichert: { art: AendernArt; satz: string } | null;
  onAendern: (art: AendernArt) => void;
}) {
  const titelId = `vp-mss-karte-${karte.art}`;
  return (
    <section className="vp-mss-karte" aria-labelledby={titelId} data-testid={`karte-${karte.art}`}>
      <h2 id={titelId}>{karte.titel}</h2>
      {karte.zeilen.map((z) => (
        <Zeile
          key={z.art}
          zeile={z}
          darfAendern={darfAendern}
          gespeichert={gespeichert?.art === z.art ? gespeichert.satz : null}
          onAendern={() => onAendern(z.art)}
        />
      ))}
    </section>
  );
}

function Zeile({
  zeile: z,
  darfAendern,
  gespeichert,
  onAendern,
}: {
  zeile: KartenZeile;
  darfAendern: boolean;
  gespeichert: string | null;
  onAendern: () => void;
}) {
  return (
    <div className="vp-mss-zeile">
      {z.titel && <h3>{z.titel}</h3>}
      {z.heute ? (
        <>
          <p className="vp-mss-wert">{z.heute.wert}</p>
          <p className="vp-mss-neben">{[z.heute.neben, z.heute.zeitraum].filter(Boolean).join(' · ')}</p>
        </>
      ) : (
        <p className="vp-mss-leer">{z.leer}</p>
      )}
      {z.danach && (
        <p className="vp-mss-danach">
          <span>{z.danach.text}</span>
          <Badge variant="tint">{z.danach.marke}</Badge>
        </p>
      )}
      {gespeichert && (
        <p className="vp-mss-gespeichert" role="status">
          {gespeichert}
        </p>
      )}
      {z.geladen && darfAendern && (
        <Recht aktion={z.art === 'verteilung' ? 'messstelle.verteilung' : 'messstelle.bearbeiten'}><button type="button" className="vp-mss-aendern" aria-label={`${AENDERN_TITEL[z.art]} ab …`} onClick={onAendern}>
          {AENDERN_AB}
        </button></Recht>
      )}
      {z.historie.length > 1 && (
        <details className="vp-mss-historie">
          <summary>
            {z.art === 'verteilung' ? 'Fassungen' : HISTORIE} ({z.historie.length})
          </summary>
          <ol>
            {z.historie.map((h, i) => (
              <li key={h.schluessel} className={`vp-mss-h is-${h.zustand}`}>
                <span className="vp-mss-punkt" aria-hidden="true" />
                <span className="vp-mss-h-text">
                  {z.art === 'verteilung' && <span className="vp-mss-h-neben">Fassung {z.historie.length - i}</span>}
                  <span className="vp-mss-h-wert">{h.wert}</span>
                  {h.neben && <span className="vp-mss-h-neben">{h.neben}</span>}
                  <span className="vp-mss-h-zeit">{h.zeitraum}</span>
                </span>
                {h.marke && <Badge variant={h.zustand === 'geplant' ? 'tint' : 'ok'}>{h.marke}</Badge>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
