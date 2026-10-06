import { geplantFuerText } from '../uemsMessplanung';
import { clearWerteCache } from '../uemsWerteCache';
import { Ablesungen } from '../components/Ablesungen';
import { AblesungDialog } from '../components/AblesungDialog';
import { RechteStandort, useRollen } from '../rollen';
import { Recht } from '../components/Recht';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  ApiError,
  type Ablesung,
  type AblesungAntwort,
  type Kostenstelle,
  type Messstelle,
  type MessstelleFormel,
  type MessstelleProzessZuordnung,
  type MessstellenRegister,
  type MessstelleQuellenListe,
  type MessstelleVerteilungAnteil,
  type MessstelleWerte,
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
import { VergleichBefund } from '../components/VergleichBefund';
import type { Schritt } from '../messstelleDialog';
import { PROTOKOLL_LABEL, ProtokollDialog } from '../components/ProtokollDialog';
import { useProtokoll } from '../components/ProtokollListe';
import { ErrorState, Skeleton } from '../components/States';
import { WagoKarte } from '../components/WagoKarte';
import { kannKartenangabenHaben } from '../wagoKarte';
import { WerteSektion, type WerteSeite } from '../components/WerteSektion';
import { wahlHash } from '../uemsVergleich';
import { ZuordnungAendernDialog } from '../components/ZuordnungAendernDialog';
import { KorrekturenDialog } from '../components/KorrekturenDialog';
import { MessstelleKacheln } from '../components/MessstelleKacheln';
import { BegriffAufklapper } from '../components/BegriffAufklapper';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { UEMS_WERTE, UEMS_WOHER_DIE_WERTE } from '../glossar';
import { zeileWoerter } from '../messstellen';
import {
  AENDERN_TITEL,
  aenderbar,
  BEARBEITEN,
  bestandAus,
  gespeichertSatz,
  HISTORIE,
  LADEFEHLER,
  MESSSTELLE_PROTOKOLL_ACHSE,
  namenAus,
  NICHT_GEFUNDEN,
  ZUR_LISTE,
  zuordnungZeilen,
  type AendernArt,
  type Kataloge,
  type KartenZeile,
} from '../messstelleZuordnung';
import {
  ABLESUNG_EINTRAGEN,
  AENDERN,
  ablesungKachel,
  ablesungZeilen,
  FORMEL_AENDERN,
  fussSatz,
  hatMenge,
  herkunftAus,
  herkunftKarte,
  KORREKTUREN_UND_ERSATZWERTE,
  leitKachel,
  monatPlus,
  monatsTage,
  protokollSatz,
  rolle,
  seitenKopf,
  standKachel,
  statusZeile,
  werteStart,
  ZAEHLER_VERBINDEN,
  ZUORDNUNG,
  ZUSAMMENGESETZT_AUS,
  type Herkunft,
} from '../messstelleSeite';
import { quelleKarte, type BindungsRolle, type QuelleGroesseKarte } from '../quelleBinden';
import { lokalerTag, VORGABE_ZEITZONE, type Tag } from '../uemsOrtsbaum';
import { boxAmGeraet, boxWechselAmGeraet } from '../boxAnQuelle';
import { useBoxenAnQuellen } from '../useBoxenAnQuellen';
import { nebengroessen, periodeAus, quellenNamen } from '../uemsWerteKarte';
import { useMessenEinstieg } from '../messenEinstieg';
import { sprungziel, zoneSatz, type Zeitraum, ZEITRAEUME } from '../uemsOberflaechen';
import { wirksameAblesungen } from '../werteEingabe';
import './MessstelleSeite.css';

interface Stamm {
  messstelle: Messstelle;
  /** `null` = nicht abrufbar (die Karte sagt es, statt eine leere Zuordnung zu zeigen). */
  prozesse: MessstelleProzessZuordnung[] | null;
  anteile: MessstelleVerteilungAnteil[] | null;
}

/**
 * Die Seite einer Messstelle (Konzept Messen m1, §6.4/§6.5, Captain-Freigabe 05.10.2026; Messen-Bau m2 PR2): oben
 * steht, ob die Messstelle aktuell ist und der eine nächste Schritt („Ablesung eintragen“ bei einem Ablesezähler);
 * darunter der Verbrauch als Kachel, die Monate als Balken, die Ablesungen (neueste zuerst), EINE Karte „Zuordnung“,
 * woher die Werte kommen und der Verweis auf das Änderungsprotokoll. Am Rechner Kacheln über die volle Breite, darunter
 * zwei Spalten: links Werte und Ablesungen, rechts Zuordnung, Herkunft und Protokoll. Die Zone steht einmal am Fuß
 * (Entscheid 6).
 *
 * Sie liest `GET /api/v1/messstellen/{id}` (Orte, Stellungen), `…/prozesse`, `…/verteilung`, `…/quellen`, das Register
 * von heute (Zustand, Quelle, letzter Wert, nächste Ablesung), die Monatsreihe der Werte (Leitkachel, Ablesungen),
 * die Ablesungen eines Ablesezählers, die Formel einer berechneten Messstelle, Standorte und Ortsbäume (Namen) und die
 * Kataloge Prozesse/Kostenstellen. Jede Ableitung steht in `messstelleSeite.ts` und `messstelleZuordnung.ts`; hier
 * wird nur geladen und gerendert. Nach jedem Eintrag liest die Seite neu.
 *
 * Das Ziel des Registers (`#/portfolio/messstellen/{id}`, `#/standort/{sid}/messstellen/{id}`); eine Adresse darf auch
 * das KENNZEICHEN nennen ({@link KENNZEICHEN_ADRESSE}). Periode und Version der Werte kommen aus der Adresse
 * (`?periode=2026-10-25&version=2`); mit einer Periode holt die Seite die Werte in den Blick.
 */

/**
 * Eine Adresse, die ein KENNZEICHEN nennt statt der ID (`#/portfolio/messstellen/MS-12`). Die Sprünge der
 * Kette (AP-13 IP-11, D1) kennen nur das Kennzeichen — es steht in jeder Herkunfts-Zeile, nie eine UUID —,
 * die Routen der Seite brauchen aber die ID. Genau hier, an EINER Stelle, wird es aufgelöst.
 */
const KENNZEICHEN_ADRESSE = /^MS-[0-9A-Za-z]+$/;

export function MessstelleSeite(props: MessstelleSeiteProps) {
  const alsKennzeichen = KENNZEICHEN_ADRESSE.test(props.id);
  // Die Auflösung gehört zu GENAU einer Adresse: beim Wechsel zu einem anderen Kennzeichen steht sonst für einen
  // Augenblick die vorige Messstelle da (Messen-Bau m2, gefunden im Browser).
  const [aufgeloest, setAufgeloest] = useState<{ fuer: string; id: string | 'fehlt' } | null>(null);
  const id: string | 'fehlt' | null = !alsKennzeichen ? props.id : aufgeloest?.fuer === props.id ? aufgeloest.id : null;

  useEffect(() => {
    if (!alsKennzeichen) return;
    let aktiv = true;
    api.messstellenRegister().then(
      (r) => aktiv && setAufgeloest({ fuer: props.id, id: r.register.find((z) => z.kennzeichen === props.id)?.id ?? 'fehlt' }),
      // Ohne Register ist das Kennzeichen nicht aufzulösen — dann sagt die Seite das, statt leer zu bleiben.
      () => aktiv && setAufgeloest({ fuer: props.id, id: 'fehlt' }),
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

/** Die Zeiträume der Werte je Herkunft: ein Ablesezähler hat keine Tages- und Wochenwerte. */
const ZEITRAEUME_ABLESUNG: readonly Zeitraum[] = ['monat', 'jahr'];

function MessstelleSeiteMitId({
  id,
  zone = VORGABE_ZEITZONE,
  werte = null,
  onWerteZeitraum,
  onWerteVergleich,
  onListe,
}: MessstelleSeiteProps) {
  const messenEinstieg = useMessenEinstieg();
  const rollen = useRollen();
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
  // Messen m2: die Monatsreihe der Leitkachel, die Ablesungen, die Formel, das Protokoll im Dialog.
  const [serie, setSerie] = useState<MessstelleWerte | null>(null);
  const [serieGelesen, setSerieGelesen] = useState(false);
  const [ablesungen, setAblesungen] = useState<Ablesung[] | null>(null);
  const [ablesungenFehler, setAblesungenFehler] = useState(false);
  const [ablesungenNeu, setAblesungenNeu] = useState(0);
  const [ablesungDialog, setAblesungDialog] = useState<{ alt: Ablesung | null } | null>(null);
  const [ablesungAntwort, setAblesungAntwort] = useState<AblesungAntwort | null>(null);
  const ablesungAusloeser = useRef<HTMLElement | null>(null);
  const [formel, setFormel] = useState<MessstelleFormel | null>(null);
  const [kanalNamen, setKanalNamen] = useState<Record<string, string>>({});
  const [protokollOffen, setProtokollOffen] = useState(false);
  const [korrekturenOffen, setKorrekturenOffen] = useState(false);
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

  const m = stamm?.messstelle ?? null;
  const zeile = m ? (zeilen.find((r) => r.id === m.id) ?? null) : null;
  const heute: Tag = register?.stichtag ?? lokalerTag(new Date().toISOString(), zone);
  const standortZone = standorte?.standorte.find((s) => s.id === zeile?.ort.standort_id)?.zeitzone ?? zone;
  const herkunft: Herkunft = m ? herkunftAus(zeile, m) : 'keine';
  const haupt = zeile?.hauptgroesse ?? m?.hauptgroesse ?? null;
  // Seit wann die erste führende Quelle gilt - eine eben eingerichtete Messstelle öffnet dort, wo es Werte gibt.
  const quelleSeit: Tag | null = useMemo(() => {
    if (herkunft === 'ablesung') return zeile?.quelle.ablesung ? lokalerTag(zeile.quelle.ablesung.seit, standortZone) : null;
    const ab = (quellen?.quellen ?? []).filter((q) => q.rolle === 'fuehrend').map((q) => q.gueltig_ab).sort()[0];
    return ab ? lokalerTag(ab, standortZone) : null;
  }, [herkunft, zeile, quellen, standortZone]);
  const start = werteStart({ heute, herkunft, quelleSeit });
  const leitMonat = start.art === 'monat' ? start.wert : start.wert.slice(0, 7);
  const mitMenge = hatMenge(haupt);
  const kennzeichen = m?.kennzeichen ?? null;

  // Die Monatsreihe der Leitkachel: dreizehn Monate bis zu ihrem Monat (der Vorjahresmonat gehört dazu).
  useEffect(() => {
    if (!kennzeichen || !registerGelesen || !mitMenge) {
      setSerieGelesen(true);
      return;
    }
    let aktiv = true;
    setSerieGelesen(false);
    const { von, bis } = monatsTage(monatPlus(leitMonat, -12), leitMonat);
    api.messstelleWerte(kennzeichen, 'monat', von, bis).then(
      (s) => {
        if (!aktiv) return;
        setSerie(s ?? null);
        setSerieGelesen(true);
      },
      () => {
        if (!aktiv) return;
        setSerie(null);
        setSerieGelesen(true);
      },
    );
    return () => {
      aktiv = false;
    };
  }, [kennzeichen, registerGelesen, mitMenge, leitMonat, versuch]);

  // Ablesbar ist eine gemessene Messstelle mit Zählerstand ohne führende Gerätequelle (wie bisher die Ablesungen).
  const ablesbar = Boolean(
    m && quellen && m.art === 'gemessen' && haupt?.wertart === 'Zählerstand' && !quellen.quellen.some((q) => q.rolle === 'fuehrend'),
  );
  useEffect(() => {
    if (!kennzeichen || !ablesbar) return;
    let aktiv = true;
    setAblesungenFehler(false);
    api.ablesungen(kennzeichen).then(
      (a) => aktiv && setAblesungen(a),
      () => aktiv && setAblesungenFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [kennzeichen, ablesbar, ablesungenNeu]);

  // Eine berechnete Messstelle: woraus sie zusammengesetzt ist (§6.4 Punkt 10), mit den Namen der Messwerte.
  useEffect(() => {
    if (!m || m.art !== 'berechnet') return;
    let aktiv = true;
    api.messstelleFormel(m.id).then(
      (f) => {
        if (!aktiv) return;
        setFormel(f);
        const anlage = zeile?.elektrische_stellung?.anlage;
        const komponenten = [...new Set(f.terme.map((t) => t.entity_id).filter((e): e is string => Boolean(e)))];
        if (!anlage) return;
        for (const k of komponenten) {
          api.komponenteMesskanaele(anlage, k).then(
            (l) =>
              aktiv &&
              setKanalNamen((alt) => ({
                ...alt,
                ...Object.fromEntries(l.messkanaele.map((c) => [`${k}|${c.kanal}`, `${l.komponente} · ${c.anzeigename ?? c.kanal}`])),
              })),
            () => undefined,
          );
        }
      },
      () => aktiv && setFormel(null),
    );
    return () => {
      aktiv = false;
    };
  }, [m, zeile, versuch]);

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
  const boxen = useBoxenAnQuellen([zeile?.elektrische_stellung?.anlage]);

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
  if (!stamm || !m || !registerGelesen) {
    return (
      <div className="vp-mss" data-testid="messstelle-seite" aria-busy="true">
        {zurueck}
        <Skeleton height={220} />
      </div>
    );
  }

  const k = seitenKopf(m, zeile);
  const w =
    zeile && register
      ? zeileWoerter(zeile, { ebene: { art: 'unternehmen', name: '' }, zone, zeitpunkt: register.zeitpunkt })
      : null;
  const status = statusZeile(zeile, standortZone);
  const bestand = bestandAus(m, stamm.prozesse, stamm.anteile);
  const zuordnung = zuordnungZeilen(m, stamm.prozesse, stamm.anteile, heute, namen);
  const darfAendern = aenderbar(m);
  const archiviert = m.lebenszyklus === 'archiviert';
  const neben = haupt ? nebengroessen(w, haupt) : null;
  const r = rolle(haupt);
  const oeffneBearbeiten = (ab: Schritt) => {
    setBearbeitenAb(ab);
    setBearbeiten(true);
  };
  // UEMS AP-04 IP-14: die Karten der Quelle-Karte; die Uhr ist der Zeitpunkt des Registers.
  const jetzt = register?.zeitpunkt ?? new Date().toISOString();
  // AP-13 IP-12 (L6): die Zuständigkeiten der Anlage dieser Messstelle — daraus nennt die Karte die Box.
  // AP-09 IP-8: kommen die Werte aus Ablesungen, sagt die Karte das wie das Register, nicht „Keine Datenquelle“.
  const quelleKarten: QuelleGroesseKarte[] = quellen
    ? quelleKarte(quellen, jetzt, boxen.karte, w?.quelle.art === 'ablesung' ? w.quelle.text : null)
    : [];
  const oeffneBinden = (rolleWahl: BindungsRolle) => (karte: QuelleGroesseKarte) =>
    setBinden({
      rolle: rolleWahl,
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
  const hauptKarte = quelleKarten.find((q) => q.hauptgroesse) ?? quelleKarten[0] ?? null;

  // Werte: womit sie öffnen (die Adresse zuerst) und was die Seite anbietet.
  const zeitraeume = herkunft === 'ablesung' ? ZEITRAEUME_ABLESUNG : ZEITRAEUME;
  const ausAdresse = periodeAus(werte?.periode);
  const werteAnfang =
    ausAdresse && !zeitraeume.includes(ausAdresse.art)
      ? { art: 'monat' as Zeitraum, wert: ausAdresse.wert.slice(0, 7) }
      : (ausAdresse ?? start);
  const seite: WerteSeite = {
    zeitraeume,
    titelId: 'vp-mss-werte-titel',
    ton: r.ton,
    titel: (art) =>
      !mitMenge ? UEMS_WERTE : art === 'tag' ? `${r.wort} am Tag` : art === 'woche' ? `${r.wort} in der Woche` : `${r.wort} je Monat`,
  };

  // Ablesungen: die Zeilen (neueste zuerst) und der Schritt oben.
  const wirksam = ablesungen ? wirksameAblesungen(ablesungen) : [];
  const ablesungsZeilen = haupt ? ablesungZeilen({ wirksam, einheit: haupt.einheit, zone: standortZone, serie }) : [];
  const darfAblesen = ablesbar && !archiviert && rollen.darf('ablesung.erfassen', zeile?.ort.standort_id ?? null);
  const oeffneAblesung = (alt: Ablesung | null, ausloeser: HTMLElement | null) => {
    ablesungAusloeser.current = ausloeser;
    setAblesungDialog({ alt });
  };
  const schliesseAblesung = () => {
    setAblesungDialog(null);
    requestAnimationFrame(() => ablesungAusloeser.current?.focus());
  };

  const leit =
    mitMenge && serie
      ? leitKachel({ serie, monat: leitMonat, rolle: r, herkunft, ablesenMoeglich: darfAblesen, namen: quellenNamen(zeile?.quelle) })
      : null;
  const stand = standKachel(zeile, standortZone, jetzt);
  const naechste = ablesungKachel(zeile, standortZone, jetzt);
  const herkunftsKarte = herkunftKarte({ herkunft, zeile, zone: standortZone, ablesungen: ablesungen ? wirksam.length : null });
  const korrekturKontext =
    quellen && zeile?.ort.standort_id && haupt?.einheit && m.art === 'gemessen' && !archiviert
      ? { quellen, standort: zeile.ort.standort_id, einheit: haupt.einheit }
      : undefined;

  const menue: RowMenuItem[] = [
    ...(darfAendern ? [{ label: BEARBEITEN, icon: 'pencil' as const, recht: 'messstelle.bearbeiten', onClick: () => oeffneBearbeiten(1) }] : []),
    ...(korrekturKontext ? [{ label: KORREKTUREN_UND_ERSATZWERTE, icon: 'list' as const, onClick: () => setKorrekturenOffen(true) }] : []),
    { label: PROTOKOLL_LABEL, icon: 'history' as const, onClick: () => setProtokollOffen(true) },
  ];
  const nachEintrag = () => {
    setVersuch((v) => v + 1);
    protokoll.reload();
  };
  const ersteZeile = protokoll.seite?.eintraege[0] ?? null;
  // Entscheid 6: die Zone einmal am Fuß - aus der Antwort der Werte, ohne sie die Zone des Standorts.
  const fuss = fussSatz(
    serie ? zoneSatz(serie.zeitzone, serie.zeitzone_herkunft, zeile?.ort.standort_name ?? null) : `Zeiten in ${standortZone}`,
    jetzt,
    standortZone,
  );

  return (
    <RechteStandort.Provider value={zeile?.ort.standort_id ?? null}>
      <div className="vp-mss" data-testid="messstelle-seite">
        {zurueck}
        <header className="vp-mss-oben">
          <div className="vp-mss-titel">
            <h1>
              {k.titel} <span className="vp-mss-kz">{k.kennzeichen}</span>
            </h1>
            <p className="vp-mss-unter">{[k.unter, k.lebenszyklus].filter(Boolean).join(' · ')}</p>
            {/* AP-16 IP-20 (R5): ein eingelöster Messbedarf — „geplant für EE-8 …“; ersetzt weder Quelle noch Wert. */}
            {geplantFuerText(zeile) && <p className="vp-mss-geplant" data-testid="messstelle-geplant-fuer">{geplantFuerText(zeile)}</p>}
          </div>
          <div className="vp-mss-menue">
            <RowMenu label="Weitere Aktionen" items={menue} />
          </div>
          {status && (
            <p className={`vp-mss-status is-${status.ton}`} data-testid="messstelle-status">
              <span className="vp-mss-punkt" aria-hidden="true" />
              <strong>{status.text}</strong>
              {status.neben && <span className="vp-mss-status-neben"> · {status.neben}</span>}
            </p>
          )}
          {/* Konzept §6.4 Punkt 3: bei Ablesezählern der EINE Schritt oben. Ohne Quelle stehen beide Wege gleichwertig in
              „Woher die Werte kommen“ - ein Knopf hier oben bevorzugte das Ablesen. */}
          {darfAblesen && herkunft === 'ablesung' && (
            <div className="vp-mss-schritt">
              <Button
                variant="primary"
                onClick={(e) => oeffneAblesung(null, e.currentTarget)}
                disabled={!ablesungen}
                // Konzept Wiedervorlage w1, Entscheid 7: der Schritt „Ablesung eintragen“ landet auf diesem Knopf -
                // Ziel ist er erst mit den Ablesungen, die der Dialog zum Vergleich braucht.
                data-entscheid={ablesungen ? 'zaehlerablesung' : undefined}
                data-entscheid-schritt
              >
                <Icon name="pencil" size={16} />
                {ABLESUNG_EINTRAGEN}
              </Button>
            </div>
          )}
        </header>

        <MessstelleKacheln
          leit={leit}
          stand={stand}
          ablesung={naechste}
          laedt={mitMenge && !serieGelesen}
          onAblesen={darfAblesen ? () => oeffneAblesung(null, document.activeElement as HTMLElement | null) : undefined}
        />

        <div className="vp-mss-spalten">
          <div className="vp-mss-spalte">
            <section className="vp-mss-karte vp-mss-werte" aria-labelledby="vp-mss-werte-titel" data-testid="werte" ref={werteRef}>
              <WerteSektion
                key={wechselStand}
                kennzeichen={m.kennzeichen}
                seite={seite}
                // AP-01 E5 = A: „Daten kommen an“ → Messen-Assistent, Schritt 2 des Standorts dieser Messstelle.
                onZuordnen={messenEinstieg && zeile?.ort.standort_id
                  ? () => messenEinstieg.oeffnen({ standortId: zeile.ort.standort_id, schritt: 2 })
                  : undefined}
                messstelle={`${k.kennzeichen} · ${k.titel}`}
                anfang={werteAnfang}
                // Die Version gehört zu GENAU der Periode der Adresse — ohne sie gibt es nichts zu wählen.
                version={ausAdresse ? (werte?.version ?? null) : null}
                heute={heute}
                standortName={zeile?.ort.standort_name ?? null}
                quelle={zeile?.quelle ?? null}
                korrekturKontext={korrekturKontext}
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
                onVergleich={(v) => onWerteVergleich?.(wahlHash(v))}
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

            {ablesbar && haupt && (
              <Ablesungen
                kennzeichen={m.kennzeichen}
                einheit={haupt.einheit}
                zone={standortZone}
                archiviert={archiviert}
                alle={ablesungen}
                zeilen={ablesungsZeilen}
                fehler={ablesungenFehler}
                antwort={ablesungAntwort}
                onErneut={() => setAblesungenNeu((n) => n + 1)}
                onBerichtigen={(a, ausloeser) => oeffneAblesung(a, ausloeser)}
              />
            )}
            {/* AP-16 IP-17 (G5): der Monatsvergleich je Vergleichsquelle — nur wo es eine gibt; ohne steht nichts. */}
            {/* AP-16 IP-18: je Zeile „Toleranz ändern“ (messmittel.angaben am Standort der Messstelle). */}
            {quellen?.quellen.some(q => q.rolle === 'vergleich') && <VergleichBefund kennzeichen={m.kennzeichen} messstelleId={m.id} />}
          </div>

          <div className="vp-mss-spalte">
            <section className="vp-mss-karte vp-mss-zuordnung" aria-labelledby="vp-mss-zuordnung-titel" data-testid="karte-zuordnung">
              <div className="vp-mss-karte-kopf">
                <h2 id="vp-mss-zuordnung-titel">{ZUORDNUNG}</h2>
              </div>
              <BegriffAufklapper begriff="zuordnung" />
              {zuordnung.map((z) => (
                <ZuordnungZeile
                  key={z.art}
                  zeile={z}
                  darfAendern={darfAendern}
                  gespeichert={gespeichert?.art === z.art ? gespeichert.satz : null}
                  onAendern={() => {
                    setGespeichert(null);
                    setAendern(z.art);
                  }}
                />
              ))}
            </section>

            <section className="vp-mss-karte vp-mss-herkunft" aria-labelledby="vp-mss-herkunft-titel" data-testid="karte-herkunft">
              <h2 id="vp-mss-herkunft-titel">{UEMS_WOHER_DIE_WERTE}</h2>
              <p className="vp-mss-herkunft-titel">{herkunftsKarte.titel}</p>
              {herkunftsKarte.satz && <p className="vp-mss-leise">{herkunftsKarte.satz}</p>}
              {herkunft === 'geraet' && w?.quelle.art === 'gebunden' && (
                // AP-13 IP-11 (D1): das Gerät der Quelle führt auf seine Komponente im Aufbau der Anlage.
                <p className="vp-mss-quelle">
                  {w.quelle.sprung ? (
                    <a className="vp-mss-quelle-sprung" href={w.quelle.sprung.hash}>
                      {w.quelle.geraet}
                    </a>
                  ) : (
                    w.quelle.geraet
                  )}
                  {w.quelle.messwert ? ` · ${w.quelle.messwert}` : ''}
                </p>
              )}
              {(herkunft === 'ablesung' || herkunft === 'keine') && hauptKarte && darfAendern && (
                <Recht aktion="messstelle.quelle">
                  <button type="button" className="vp-mss-link vp-mss-link-icon" onClick={() => oeffneBinden('fuehrend')(hauptKarte)}>
                    <Icon name="zap" size={15} />
                    {ZAEHLER_VERBINDEN}
                  </button>
                </Recht>
              )}
              {herkunft === 'keine' && darfAblesen && (
                <button type="button" className="vp-mss-link vp-mss-link-icon" onClick={(e) => oeffneAblesung(null, e.currentTarget)} disabled={!ablesungen}>
                  <Icon name="pencil" size={15} />
                  {ABLESUNG_EINTRAGEN}
                </button>
              )}
              {herkunft === 'geraet' && quelleKarten.length > 0 && (
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
              {/* AP-05 IP-11: die Energiekarte — nur wo es eine WAGO-Komponente GIBT (sonst 404, nichts gezeichnet). */}
              {quellen?.groessen[0]?.fuehrend
                && kannKartenangabenHaben(quellen.groessen[0].fuehrend.geraet.hersteller) && (
                <WagoKarte
                  anlageId={quellen.groessen[0].fuehrend.anlage}
                  standortId={zeile?.ort.standort_id ?? null}
                  entityId={quellen.groessen[0].fuehrend.komponente}
                  zone={standortZone}
                  einheit={haupt?.wertart === 'Zählerstand' ? haupt.einheit : null}
                  onGetauscht={() => { setVersuch(v => v + 1); setWechselStand(v => v + 1); protokoll.reload(); }}
                />
              )}
              {quellen?.groessen[0]?.fuehrend && <ZaehlerwechselVerlauf
                anlageId={quellen.groessen[0].fuehrend.anlage}
                komponenten={[...new Set(quellen.quellen.map(q => q.komponente))]} stand={wechselStand} />}
            </section>

            {m.art === 'berechnet' && (
              <ZusammengesetztAus
                formel={formel}
                kanalNamen={kanalNamen}
                register={zeilen}
                standortId={zeile?.ort.standort_id ?? null}
                darfAendern={darfAendern}
                onAendern={() => oeffneBearbeiten(3)}
              />
            )}

            <button type="button" className="vp-mss-karte vp-mss-protokoll" onClick={() => setProtokollOffen(true)} data-testid="protokoll-verweis">
              <span className="vp-mss-protokoll-ico" aria-hidden="true">
                <Icon name="history" size={18} />
              </span>
              <span className="vp-mss-protokoll-text">
                <strong>{PROTOKOLL_LABEL}</strong>
                <span className="vp-mss-leise">
                  {protokoll.seite
                    ? protokollSatz(protokoll.seite.eintraege.length, protokoll.seite.weiter !== null, ersteZeile?.eingetragen_am ?? null, standortZone)
                    : protokoll.error ?? ' '}
                </span>
              </span>
              <Icon name="chevron-right" size={18} />
            </button>
          </div>
        </div>

        <p className="vp-mss-fuss" data-testid="werte-zone">
          {fuss}
        </p>

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
              nachEintrag();
            }}
          />
        )}
        {ablesungDialog && ablesungen && haupt && (
          <AblesungDialog
            key={ablesungDialog.alt?.zeitpunkt ?? 'neu'}
            kennzeichen={m.kennzeichen}
            name={m.name}
            einheit={haupt.einheit}
            zone={standortZone}
            alle={ablesungen}
            alt={ablesungDialog.alt}
            onBerichtigen={(alt) => setAblesungDialog({ alt })}
            onClose={schliesseAblesung}
            onSaved={(a) => {
              if (a.urteil !== 'vorschlag' && a.urteil !== 'wiederholung') {
                clearWerteCache();
                setWechselStand((v) => v + 1);
                nachEintrag();
              }
              setAblesungAntwort(a);
              setAblesungenNeu((n) => n + 1);
              schliesseAblesung();
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
            onGebunden={nachEintrag}
          />
        )}
        {korrekturenOffen && korrekturKontext && (
          <KorrekturenDialog
            standort={korrekturKontext.standort}
            kennzeichen={m.kennzeichen}
            zone={standortZone}
            onClose={() => setKorrekturenOffen(false)}
            onGespeichert={() => {
              clearWerteCache();
              setWechselStand((v) => v + 1);
              nachEintrag();
            }}
          />
        )}
        <ProtokollDialog
          open={protokollOffen}
          titel={`${m.kennzeichen} ${m.name ?? ''}`.trim()}
          ziel={{ art: 'messstelle', id: m.id }}
          optionen={{ achse: MESSSTELLE_PROTOKOLL_ACHSE, anlegeSatz: true }}
          onClose={() => setProtokollOffen(false)}
        />
        <MessstelleDialog
          open={bearbeiten}
          messstelleId={m.id}
          schritt={bearbeitenAb}
          heute={heute}
          onClose={() => {
            setBearbeiten(false);
            if (!bearbeitet) return;
            setBearbeitet(false);
            nachEintrag();
          }}
          onGespeichert={() => setBearbeitet(true)}
        />
      </div>
    </RechteStandort.Provider>
  );
}

/** Eine Zeile der Karte „Zuordnung“: Etikett, was heute gilt, seit wann, „Ändern“ - und die Historie. */
function ZuordnungZeile({
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
    <div className="vp-mss-zeile" data-testid={`zuordnung-${z.art}`}>
      <div className="vp-mss-zeile-text">
        <h3>{z.titel}</h3>
        {z.heute ? (
          <>
            <p className="vp-mss-wert">{z.heute.wert}</p>
            <p className="vp-mss-leise">{[z.heute.neben, z.heute.zeitraum].filter(Boolean).join(' · ')}</p>
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
        {z.historie.length > 1 && (
          <details className="vp-mss-historie">
            <summary>
              {HISTORIE} ({z.historie.length})
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
      {z.geladen && darfAendern && (
        <Recht aktion={z.art === 'verteilung' ? 'messstelle.verteilung' : 'messstelle.bearbeiten'}>
          <button type="button" className="vp-mss-aendern" aria-label={AENDERN_TITEL[z.art]} onClick={onAendern}>
            {AENDERN}
          </button>
        </Recht>
      )}
    </div>
  );
}

/**
 * „Zusammengesetzt aus“ (Konzept Messen m1, §6.4 Punkt 10): die Terme der Formel von heute, je mit ihrem Sprung - eine
 * Messstelle auf ihre Seite; ein Messwert nennt seine Komponente. „Formel ändern“ für Berechtigte.
 */
function ZusammengesetztAus({
  formel,
  kanalNamen,
  register,
  standortId,
  darfAendern,
  onAendern,
}: {
  formel: MessstelleFormel | null;
  kanalNamen: Record<string, string>;
  register: readonly { id: string; kennzeichen: string; name: string | null }[];
  standortId: string | null;
  darfAendern: boolean;
  onAendern: () => void;
}) {
  return (
    <section className="vp-mss-karte vp-mss-formel" aria-labelledby="vp-mss-formel-titel" data-testid="karte-formel">
      <div className="vp-mss-karte-kopf">
        <h2 id="vp-mss-formel-titel">{ZUSAMMENGESETZT_AUS}</h2>
        {darfAendern && (
          <Recht aktion="messstelle.bearbeiten">
            <button type="button" className="vp-mss-link" onClick={onAendern}>
              {FORMEL_AENDERN}
            </button>
          </Recht>
        )}
      </div>
      {!formel ? (
        <p className="vp-mss-leise" role="status">
          Die Formel wird geladen …
        </p>
      ) : formel.terme.length === 0 ? (
        <p className="vp-mss-leise">Noch keine Formel.</p>
      ) : (
        <ul className="vp-mss-terme">
          {formel.terme.map((t) => {
            const quelle = t.quell_messstelle_id ? register.find((r) => r.id === t.quell_messstelle_id) : null;
            const sprung = quelle ? sprungziel({ art: 'messstelle', id: quelle.id, standortId }) : null;
            const name = quelle
              ? `${quelle.name ?? quelle.kennzeichen} ${quelle.kennzeichen}`
              : (t.entity_id && t.point_key ? kanalNamen[`${t.entity_id}|${t.point_key}`] : null) ?? 'Messwert einer Komponente';
            const faktor = t.faktor !== 1 ? ` × ${String(t.faktor).replace('.', ',')}` : '';
            return (
              <li key={t.position}>
                <span className="vp-mss-vorzeichen" aria-label={t.vorzeichen === '-' ? 'minus' : 'plus'}>
                  {t.vorzeichen === '-' ? '−' : '+'}
                </span>
                {sprung ? <a href={sprung.hash}>{name}</a> : <span>{name}</span>}
                {faktor && <span className="vp-mss-leise">{faktor}</span>}
                {formel.ausserhalb_zugriff && <span className="vp-mss-leise"> · {formel.ausserhalb_zugriff}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
