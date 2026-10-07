import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import { api, type EnergiemanagementAusschluss, type EnergiemanagementDokument, type EnergiemanagementPerson, type StandortAmStichtag } from '../../api';
import { WOERTER } from '../../energiemanagement';
import * as E from '../../energiemanagementPortal';
import * as N from '../../nachweisDokumente';
import { useRollen } from '../../rollen';
import { pruefsummeLokal } from '../../uemsMessmittel';
import { GrenzSatz } from '../GrenzSatz';
import { VpDatePicker } from '../VpDatePicker';
import { VpPicker } from '../VpPicker';
import { AusschlussFelder, belegAus, EntscheiderWahl, OrtFelder, VierAugenUnbekannt } from './DokumentBlaetter';
import { NwBlatt } from './NwBlatt';
import { AntwortKarten, PruefZeilen, SchrittAnzeige, WahlChips } from './NwSchritte';
import { NwTextfeld } from './NwTextfeld';
import './NwSchritte.css';
import './NwZeilen.css';
import './NwDokumente.css';

type Wo = 'verweis' | 'wortlaut' | 'trifft_nicht_zu';

/** Wo ein Teil gewöhnlich geführt wird: Energiepolitik und Anwendungsbereich als Text hier, alles andere im eigenen System. */
const vorschlagWo = (art: string): Wo => (art === 'energiepolitik' || art === 'anwendungsbereich' ? 'wortlaut' : 'verweis');

/** Für wo? - nur, wo eine Vorgabe auch an einem Standort hängen kann (nicht die Arten der Leitung) und es mehrere gibt. */
const mitOrtWahl = (art: string, standorte: StandortAmStichtag[]) => !!art && !E.leitungsPflicht(art) && standorte.length > 1;

const ERSTE_BEGRUENDUNG = 'Erste Fassung festgehalten.';

/**
 * „Festhalten“ (Konzept Nachweisen n1, Runde 2, §6.10 „Einen offenen Teil festhalten“): ein Dokument in drei Schritten -
 * 1 was und wo es geführt wird (eigenes System, kurzer Text hier, oder - nur mit `onTrifftNichtZu` - „trifft zurzeit
 * nicht zu“), 2 wo das Original liegt bzw. der Text, 3 prüfen und gleich freigeben oder als Entwurf speichern. Der
 * Anwendungsbereich fragt davor „Wofür gilt es?“ (Standorte, Energieträger, Ausschlüsse - die Route verlangt sie schon
 * für den Entwurf, Review r1 P2-2). Es legt das Dokument an, entwirft Fassung 1 und gibt sie frei (bei Vier-Augen:
 * beantragt) - drei Routen, eine Führung.
 *
 * Mit `art` steht die Art fest (Überblick: der offene Teil), sonst fragt Schritt 1 nach ihr. „Entschieden“ ist
 * vorbelegt (die Leitung bei Energiepolitik und Anwendungsbereich, sonst die eigene Person) und mit „Ändern“ wählbar.
 */
export function DokumentFesthaltenBlatt({
  art: festeArt = null,
  titel: festerTitel = null,
  onFertig,
  onClose,
  onTrifftNichtZu,
}: {
  art?: string | null;
  titel?: string | null;
  onFertig: (d: EnergiemanagementDokument) => void;
  onClose: () => void;
  /** Die dritte Antwort „Trifft zurzeit nicht zu · mit Grund“ - sie öffnet das Blatt des Überblicks (PR 1). */
  onTrifftNichtZu?: () => void;
}) {
  const basis = `fh-${useId().replace(/:/g, '')}`;
  const rollen = useRollen();
  const [schritt, setSchritt] = useState(1);
  const [art, setArt] = useState(festeArt ?? '');
  const [titel, setTitel] = useState(festerTitel ?? (festeArt ? WOERTER.dokument_art[festeArt] : ''));
  const [wo, setWo] = useState<Wo>(festeArt ? vorschlagWo(festeArt) : 'verweis');
  const [ort, setOrt] = useState<string>('unternehmen');
  const [verweis, setVerweis] = useState<E.VerweisEntwurf>(E.LEERER_VERWEIS);
  const [wortlaut, setWortlaut] = useState('');
  const [weiter, setWeiter] = useState<'freigeben' | 'entwurf'>('freigeben');
  const [aendern, setAendern] = useState(false);
  const [von, setVon] = useState('');
  const [tag, setTag] = useState('');
  const [begruendung, setBegruendung] = useState(ERSTE_BEGRUENDUNG);
  const [mitOriginal, setMitOriginal] = useState(false);
  const [original, setOriginal] = useState<E.VerweisEntwurf>(E.LEERER_VERWEIS);
  const [heute, setHeute] = useState<string | null>(null);
  const [vierAugen, setVierAugen] = useState<boolean | null>(null);
  const [vierAugenFehler, setVierAugenFehler] = useState(false);
  const [vierAugenVersuch, setVierAugenVersuch] = useState(0);
  const [personen, setPersonen] = useState<{ id: string; label: string; konto: string | null }[] | null>(null);
  // Neu angelegte Person („Person anlegen“ ohne Leitung): die Liste kennt sie erst nach einem neuen Abruf.
  const [personenNeu, setPersonenNeu] = useState(0);
  const [standorte, setStandorte] = useState<StandortAmStichtag[]>([]);
  // Anwendungsbereich (Review r1, P2-2): ohne Wahl gelten alle Standorte; Energieträger wählt man selbst.
  const [standortIds, setStandortIds] = useState<string[] | null>(null);
  const [traeger, setTraeger] = useState<string[]>([]);
  const [ausschluesse, setAusschluesse] = useState<EnergiemanagementAusschluss[]>([]);
  const [angelegt, setAngelegt] = useState<EnergiemanagementDokument | null>(null);
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rechnet, setRechnet] = useState(false);
  const [dateiFehler, setDateiFehler] = useState<string | null>(null);
  const leitung = !!art && E.leitungsPflicht(art);
  const darfFreigeben = rollen.darf(E.RECHT_FREIGEBEN, null);
  const mitGeltung = art === 'anwendungsbereich';
  const letzter = mitGeltung ? 4 : 3;
  const orte = standortIds ?? standorte.map((s) => s.id);

  // „Heute“ ist der Tag der Route (die Aufgaben antworten mit ihm, auch ohne ein einziges Dokument) und die Standorte.
  useEffect(() => {
    let aktiv = true;
    api.energiemanagementAufgaben().then(
      (r) => aktiv && setHeute(r.tag),
      () => undefined,
    );
    api.standorte().then((s) => aktiv && setStandorte(s.standorte.filter((x) => x.zustand !== 'archiviert')), () => undefined);
    return () => {
      aktiv = false;
    };
  }, []);

  // Vier-Augen: unbekannt ist nicht „aus“ (Review r1, P2-4) - bis die Einstellung da ist, gibt das Blatt nicht frei.
  useEffect(() => {
    let aktiv = true;
    setVierAugenFehler(false);
    api.unternehmenVierAugen().then(
      (v) => aktiv && setVierAugen(v.vieraugen),
      () => aktiv && setVierAugenFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [vierAugenVersuch]);

  // Wer entscheidet: die Leitung am Tag (PA3, aus `…/leitung` im Zaun des Freigaberechts - Befund A4) oder jede aktive
  // Person; vorbelegt die Leitung bzw. die eigene Person.
  useEffect(() => {
    if (!art) return;
    let aktiv = true;
    setPersonen(null);
    const laden = leitung
      ? api.energiemanagementLeitung(tag || heute, ort === 'unternehmen' ? null : ort).then((a) => a.leitung.map((p) => ({ id: p.id, label: `${p.name}, ${p.funktion}`, konto: null })))
      : api.energiemanagementPersonen().then((p) =>
          p.personen.filter((x: EnergiemanagementPerson) => x.zustand === 'aktiv').map((x) => ({ id: x.id, label: `${x.name}, ${x.funktion}`, konto: x.konto?.sub ?? null })),
        );
    laden.then(
      (liste) => {
        if (!aktiv) return;
        setPersonen(liste);
        setVon((alt) => (liste.some((p) => p.id === alt) ? alt : (liste.find((p) => p.konto && p.konto === rollen.selbst?.kennung)?.id ?? (liste.length === 1 ? liste[0].id : ''))));
      },
      () => aktiv && setPersonen([]),
    );
    return () => {
      aktiv = false;
    };
  }, [art, leitung, tag, heute, ort, rollen.selbst?.kennung, personenNeu]);

  const artWort = art ? WOERTER.dokument_art[art] : '';
  const kopf = festeArt ? `${artWort} festhalten` : 'Dokument festhalten';

  function schritt1(): boolean {
    const f: E.Feldfehler = {};
    if (!art) f.art = 'Bitte wählen Sie, was Sie festhalten.';
    if (!titel.trim()) f.titel = 'Bitte geben Sie einen Titel an.';
    setFehler(f);
    if (Object.keys(f).length) return false;
    if (wo === 'trifft_nicht_zu') {
      onTrifftNichtZu?.();
      return false;
    }
    return true;
  }

  function schritt2(): boolean {
    const f: E.Feldfehler = {};
    if (wo === 'verweis' && !verweis.ablage.trim()) f.verweis = 'Bitte nennen Sie, wo das Original liegt.';
    if (wo === 'wortlaut' && !wortlaut.trim()) f.wortlaut = 'Bitte schreiben Sie den Text.';
    setFehler(f);
    return !Object.keys(f).length;
  }

  /** Wofür der Anwendungsbereich gilt - dieselben Regeln wie „Neu fassen“ und die Route (`anwendungsbereich_fehlt`). */
  function geltungPruefen(): boolean {
    const f: E.Feldfehler = {};
    if (!orte.length) f.standorte = 'Bitte wählen Sie mindestens einen Standort.';
    if (!traeger.length) f.traeger = 'Bitte wählen Sie mindestens einen Energieträger.';
    const aus = ausschluesse.filter((a) => a.verweis || a.begruendung.trim());
    if (aus.some((a) => !a.verweis || E.begruendungFehler(a.begruendung))) f.ausschluesse = 'Bitte nennen Sie je Ausschluss den Standort und begründen Sie mit 10 bis 500 Zeichen.';
    setFehler(f);
    return !Object.keys(f).length;
  }

  async function festhalten() {
    const freigeben = weiter === 'freigeben' && darfFreigeben;
    // Die Wahl der Person oder die Vier-Augen-Einstellung lädt noch - der Knopf wartet sichtbar (aria-busy).
    if (freigeben && (personen === null || vierAugen === null)) return;
    const f: E.Feldfehler = {};
    if (freigeben && !von) f.entschiedenVon = 'Bitte wählen Sie, wer entschieden hat.';
    const b = freigeben ? E.begruendungFehler(begruendung) : null;
    if (b) f.begruendung = b;
    // Entscheid 10: das Original braucht einen Ort - Kennung oder Prüfsumme allein gehen sonst still verloren (P2-8).
    const orig = freigeben && wo === 'wortlaut' && mitOriginal ? belegAus(original) : null;
    if (freigeben && wo === 'wortlaut' && mitOriginal && !orig && (original.kennung.trim() || original.sha256)) f.original = 'Bitte nennen Sie, wo das Original liegt.';
    setFehler(f);
    if (Object.keys(f).length) {
      if (!f.original) setAendern(true);
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      let d = angelegt;
      if (!d) {
        d = await api.energiemanagementDokumentAnlegen({
          art,
          titel: titel.trim(),
          bezug: ort === 'unternehmen' ? { art: 'unternehmen' } : { art: 'standort', standort_id: ort },
        });
        setAngelegt(d);
      }
      if (!d.fassungen.length) {
        const v = E.verweisKoerper(verweis, true);
        const geltung = mitGeltung
          ? {
              anwendungsbereich: {
                standort_ids: orte,
                traeger,
                ausschluesse: ausschluesse.filter((a) => a.verweis || a.begruendung.trim()).map((a) => ({ ...a, begruendung: a.begruendung.trim() })),
              },
            }
          : {};
        d = await api.energiemanagementFassungEntwerfen(
          d.id,
          wo === 'verweis' ? { form: 'verweis', verweis: v && !('fehler' in v) ? v : null, ...geltung } : { form: 'wortlaut', wortlaut, ...geltung },
        );
        setAngelegt(d);
      }
      if (freigeben) {
        // Entscheid 10: das unterschriebene Original gehört zur Fassung - festgehalten mit ihrer Freigabe.
        const koerper = { entschieden_von: von, entschieden_am: tag || null, begruendung: begruendung.trim(), ...(orig ? { original: orig } : {}) };
        d = vierAugen ? await api.energiemanagementFassungBeantragen(d.id, 1, koerper) : await api.energiemanagementFassungFreigeben(d.id, 1, koerper);
      }
      onFertig(d);
    } catch (err) {
      // Hat sich die Vier-Augen-Einstellung geändert, sagt es die Route: das Blatt stellt um, der nächste Klick passt.
      if (E.ablehnungCode(err) === 'vieraugen_beantragen') setVierAugen(true);
      else if (E.ablehnungCode(err) === 'vieraugen_aus') setVierAugen(false);
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  async function datei(liste: FileList | null) {
    const datei = liste?.[0];
    if (!datei) return;
    setRechnet(true);
    setDateiFehler(null);
    try {
      const sha256 = await pruefsummeLokal(datei);
      setVerweis((v) => ({ ...v, sha256, bezeichnung: v.bezeichnung || datei.name }));
    } catch {
      // Ohne sicheren Kontext (kein `crypto.subtle`) oder bei einer zu großen Datei sagt es das Blatt (Review r1, P2-8).
      setDateiFehler(E.PRUEFSUMME_FEHLT);
    } finally {
      setRechnet(false);
    }
  }

  // Bis die Personen zur Wahl und die Vier-Augen-Einstellung da sind, wartet „Festhalten“ - sonst stünde ein Fehler,
  // bevor die Vorbelegung kommt, oder es würde ohne Vier-Augen freigegeben.
  const freigebenGewaehlt = schritt === letzter && weiter === 'freigeben' && darfFreigeben;
  const laedt = freigebenGewaehlt && (personen === null || (vierAugen === null && !vierAugenFehler));
  const gesperrt = freigebenGewaehlt && vierAugenFehler && vierAugen === null;
  const titelSchritt =
    schritt === 1 ? kopf : schritt === 2 ? (wo === 'verweis' ? 'Wo liegt das Original?' : 'Ihr Text') : schritt < letzter ? 'Wofür gilt es?' : 'Prüfen';
  const personWort = personen?.find((p) => p.id === von)?.label.split(',')[0] ?? '-';
  const tagWort = E.tagText(tag || heute || '') || 'heute';

  return (
    <NwBlatt
      open
      titel={titelSchritt}
      onClose={onClose}
      breit
      testId="festhalten-blatt"
      fuss={
        <div className="vp-nw-blatt-fuss">
          <Button type="submit" form={`${basis}-form`} disabled={busy || laedt || gesperrt} aria-busy={busy || laedt || undefined} data-testid="festhalten-weiter">
            {schritt < letzter ? 'Weiter' : 'Festhalten'}
          </Button>
          <Button variant="ghost" onClick={schritt === 1 ? onClose : () => setSchritt(schritt - 1)}>
            {schritt === 1 ? 'Abbrechen' : 'Zurück'}
          </Button>
        </div>
      }
    >
      <form
        id={`${basis}-form`}
        className="vp-nw-schritt-inhalt"
        noValidate
        data-testid="festhalten-form"
        onSubmit={(e: FormEvent) => {
          // Wie `BlattFormular`: das Absenden bleibt in diesem Blatt (Review r1, P2-1).
          e.preventDefault();
          e.stopPropagation();
          if (schritt === 1) {
            if (schritt1()) setSchritt(2);
          } else if (schritt === 2) {
            if (schritt2()) setSchritt(3);
          } else if (schritt < letzter) {
            if (geltungPruefen()) setSchritt(letzter);
          } else void festhalten();
        }}
      >
        <SchrittAnzeige nr={schritt} von={letzter} />
        {schritt === 1 && (
          <>
            {!festeArt && (
              <>
                <VpPicker
                  id={`${basis}-art`}
                  label="Was?"
                  options={E.artOptionen().map((o) => ({ value: o.value, label: o.label }))}
                  value={art || null}
                  onChange={(a) => {
                    setArt(a);
                    setWo(vorschlagWo(a));
                    if (!titel.trim() || titel === artWort) setTitel(WOERTER.dokument_art[a]);
                  }}
                  placeholder="Art wählen"
                  error={fehler.art ?? null}
                />
                <NwTextfeld label="Titel" wert={titel} onWert={setTitel} fehler={fehler.titel} hoechstens={200} testid="festhalten-titel" />
              </>
            )}
            <AntwortKarten
              frage="Wo führen Sie das?"
              optionen={[
                { wert: 'verweis', titel: 'In einem eigenen System', zusatz: 'zum Beispiel ein Register' },
                { wert: 'wortlaut', titel: 'Als kurzer Text hier' },
                ...(onTrifftNichtZu ? [{ wert: 'trifft_nicht_zu' as const, titel: 'Trifft zurzeit nicht zu', zusatz: 'mit Grund' }] : []),
              ]}
              wert={wo}
              onWahl={setWo}
              testid="festhalten-wo"
            />
            {mitOrtWahl(art, standorte) && (
              <WahlChips
                frage="Für wo?"
                optionen={[{ wert: 'unternehmen', label: 'Unternehmen' }, ...standorte.map((s) => ({ wert: s.id, label: s.name }))]}
                wert={ort}
                onWahl={setOrt}
                testid="festhalten-ort"
              />
            )}
          </>
        )}
        {schritt === 2 &&
          (wo === 'verweis' ? (
            <>
              <NwTextfeld label="Wo liegt es?" wert={verweis.ablage} onWert={(ablage) => setVerweis({ ...verweis, ablage })} platzhalter="zum Beispiel Risiko-Register der Geschäftsführung" fehler={fehler.verweis} hoechstens={200} testid="festhalten-ablage" />
              <div className="vp-nw-paar">
                <NwTextfeld label="Kennung" wert={verweis.kennung} onWert={(kennung) => setVerweis({ ...verweis, kennung })} hoechstens={200} testid="festhalten-kennung" />
                <VpDatePicker label="Stand vom" value={verweis.datum || null} onChange={(datum) => setVerweis({ ...verweis, datum })} max={heute ?? undefined} />
              </div>
              <label className="vp-nw-hz vp-nw-datei" htmlFor={`${basis}-datei`} data-testid="datei-pruefen">
                <span className="vp-nw-hz-i" aria-hidden="true">
                  <Icon name="lock" size={14} />
                </span>
                <span className="vp-nw-hz-t">
                  <b>{rechnet ? 'Prüfsumme wird gebildet …' : verweis.sha256 ? 'Prüfsumme festgehalten' : 'Datei prüfen'}</b>
                  {!verweis.sha256 && !rechnet && <span> · wahlfrei</span>}
                </span>
                <input id={`${basis}-datei`} type="file" className="vp-nw-unsichtbar" onChange={(e) => void datei(e.target.files)} />
              </label>
              {dateiFehler && (
                <p className="vp-nw-fehler" role="alert" data-testid="datei-fehler">
                  {dateiFehler}
                </p>
              )}
            </>
          ) : (
            <NwTextfeld label="Text" wert={wortlaut} onWert={setWortlaut} mehrzeilig fehler={fehler.wortlaut} hoechstens={20000} testid="festhalten-text" />
          ))}
        {schritt === 3 && mitGeltung && (
          <>
            <VpPicker
              id={`${basis}-standorte`}
              label="Standorte"
              options={standorte.map((x) => ({ value: x.id, label: x.name, sub: x.kurzzeichen }))}
              values={orte}
              onChangeMany={setStandortIds}
              error={fehler.standorte ?? null}
            />
            <VpPicker
              id={`${basis}-traeger`}
              label="Energieträger"
              options={E.TRAEGER.map((t) => ({ value: t, label: t }))}
              values={traeger}
              onChangeMany={setTraeger}
              error={fehler.traeger ?? null}
            />
            <AusschlussFelder basis={basis} standorte={standorte} wert={ausschluesse} setze={setAusschluesse} />
            {fehler.ausschluesse && (
              <p className="vp-nw-fehler" role="alert">
                {fehler.ausschluesse}
              </p>
            )}
          </>
        )}
        {schritt === letzter && (
          <>
            <PruefZeilen
              zeilen={[
                { etikett: 'Teil', wert: titel || artWort },
                wo === 'verweis'
                  ? { etikett: 'Original', wert: [verweis.ablage, verweis.kennung].filter(Boolean).join(' · '), onAendern: () => setSchritt(2) }
                  : { etikett: 'Text', wert: wortlaut.length > 60 ? `${wortlaut.slice(0, 57)} …` : wortlaut, onAendern: () => setSchritt(2) },
                ...(mitGeltung
                  ? [{ etikett: 'Geltung', wert: N.geltungText(orte.length, traeger), onAendern: () => setSchritt(3) }]
                  : []),
                ...(weiter === 'freigeben' && darfFreigeben && !aendern && von ? [{ etikett: 'Entschieden', wert: `${personWort} · ${tagWort}`, onAendern: () => setAendern(true) }] : []),
              ]}
              testid="festhalten-pruefen"
            />
            {darfFreigeben && (
              <AntwortKarten
                label="Wie weiter?"
                optionen={[
                  { wert: 'freigeben', titel: vierAugen ? 'Gleich beantragen' : 'Gleich freigeben' },
                  { wert: 'entwurf', titel: 'Als Entwurf speichern' },
                ]}
                wert={weiter}
                onWahl={setWeiter}
                testid="festhalten-weiter-wahl"
              />
            )}
            {gesperrt && <VierAugenUnbekannt onErneut={() => setVierAugenVersuch((v) => v + 1)} />}
            {weiter === 'freigeben' && darfFreigeben && (aendern || (personen !== null && !von)) && (
              <>
                <EntscheiderWahl
                  id={`${basis}-person`}
                  leitung={leitung}
                  standort={ort === 'unternehmen' ? null : ort}
                  tag={tag || heute || ''}
                  wert={von}
                  setze={setVon}
                  fehler={fehler.entschiedenVon}
                  onAngelegt={() => setPersonenNeu((n) => n + 1)}
                />
                <VpDatePicker label="Wann?" value={tag || heute || null} onChange={setTag} max={heute ?? undefined} />
                <NwTextfeld label="Warum?" wert={begruendung} onWert={setBegruendung} fehler={fehler.begruendung} hoechstens={500} testid="festhalten-begruendung" />
              </>
            )}
            {weiter === 'freigeben' && darfFreigeben && wo === 'wortlaut' &&
              (mitOriginal ? (
                <OrtFelder basis={`${basis}-original`} wert={original} setze={setOriginal} mitStand={false} fehler={fehler.original} />
              ) : (
                <button type="button" className="vp-nw-aendern vp-nw-links" onClick={() => setMitOriginal(true)} data-testid="festhalten-original">
                  Original festhalten
                </button>
              ))}
          </>
        )}
        {satz && (
          <p className="vp-nw-fehler" role="alert" data-testid="blatt-ablehnung">
            {satz}
          </p>
        )}
        <GrenzSatz className="vp-nw-leise" verantwortung />
      </form>
    </NwBlatt>
  );
}
