import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import { api, type EnergiemanagementDokument, type EnergiemanagementPerson, type StandortAmStichtag } from '../../api';
import { WOERTER } from '../../energiemanagement';
import * as E from '../../energiemanagementPortal';
import { useRollen } from '../../rollen';
import { pruefsummeLokal } from '../../uemsMessmittel';
import { GrenzSatz } from '../GrenzSatz';
import { VpDatePicker } from '../VpDatePicker';
import { VpPicker } from '../VpPicker';
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
 * nicht zu“), 2 wo das Original liegt bzw. der Text, 3 prüfen und gleich freigeben oder als Entwurf speichern. Es legt
 * das Dokument an, entwirft Fassung 1 und gibt sie frei (bei Vier-Augen: beantragt) - drei Routen, eine Führung.
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
  const [heute, setHeute] = useState<string | null>(null);
  const [vierAugen, setVierAugen] = useState<boolean | null>(null);
  const [personen, setPersonen] = useState<{ id: string; label: string; konto: string | null }[] | null>(null);
  const [standorte, setStandorte] = useState<StandortAmStichtag[]>([]);
  const [angelegt, setAngelegt] = useState<EnergiemanagementDokument | null>(null);
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rechnet, setRechnet] = useState(false);
  const leitung = !!art && E.leitungsPflicht(art);
  const darfFreigeben = rollen.darf(E.RECHT_FREIGEBEN, null);

  // „Heute“ ist der Tag der Route (die Überprüfung beim Abruf trägt ihn), dazu Vier-Augen und die Standorte.
  useEffect(() => {
    let aktiv = true;
    api.energiemanagementDokumente().then(
      (r) => aktiv && setHeute(r.dokumente.find((d) => d.ueberpruefung)?.ueberpruefung?.abruf ?? null),
      () => undefined,
    );
    api.unternehmenVierAugen().then(
      (v) => aktiv && setVierAugen(v.vieraugen),
      () => aktiv && setVierAugen(false),
    );
    api.standorte().then((s) => aktiv && setStandorte(s.standorte.filter((x) => x.zustand !== 'archiviert')), () => undefined);
    return () => {
      aktiv = false;
    };
  }, []);

  // Wer entscheidet: die Leitung am Tag (PA3) oder jede aktive Person; vorbelegt die Leitung bzw. die eigene Person.
  useEffect(() => {
    if (!art) return;
    let aktiv = true;
    const laden = leitung
      ? api.energiemanagementAufgaben(tag || heute || undefined).then((a) => a.leitung.map((p) => ({ id: p.id, label: `${p.name}, ${p.funktion}`, konto: null })))
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
  }, [art, leitung, tag, heute, rollen.selbst?.kennung]);

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

  async function festhalten() {
    const freigeben = weiter === 'freigeben' && darfFreigeben;
    const f: E.Feldfehler = {};
    if (freigeben && !von) f.entschiedenVon = 'Bitte wählen Sie, wer entschieden hat.';
    const b = freigeben ? E.begruendungFehler(begruendung) : null;
    if (b) f.begruendung = b;
    setFehler(f);
    if (Object.keys(f).length) {
      setAendern(true);
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
        d = await api.energiemanagementFassungEntwerfen(
          d.id,
          wo === 'verweis' ? { form: 'verweis', verweis: v && !('fehler' in v) ? v : null } : { form: 'wortlaut', wortlaut },
        );
        setAngelegt(d);
      }
      if (freigeben) {
        const koerper = { entschieden_von: von, entschieden_am: tag || null, begruendung: begruendung.trim() };
        d = vierAugen ? await api.energiemanagementFassungBeantragen(d.id, 1, koerper) : await api.energiemanagementFassungFreigeben(d.id, 1, koerper);
      }
      onFertig(d);
    } catch (err) {
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  async function datei(liste: FileList | null) {
    const datei = liste?.[0];
    if (!datei) return;
    setRechnet(true);
    try {
      const sha256 = await pruefsummeLokal(datei);
      setVerweis((v) => ({ ...v, sha256, bezeichnung: v.bezeichnung || datei.name }));
    } finally {
      setRechnet(false);
    }
  }

  const titelSchritt = schritt === 1 ? kopf : schritt === 2 ? (wo === 'verweis' ? 'Wo liegt das Original?' : 'Ihr Text') : 'Prüfen';
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
          <Button type="submit" form={`${basis}-form`} disabled={busy} aria-busy={busy || undefined} data-testid="festhalten-weiter">
            {schritt < 3 ? 'Weiter' : 'Festhalten'}
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
          e.preventDefault();
          if (schritt === 1 && schritt1()) setSchritt(2);
          else if (schritt === 2 && schritt2()) setSchritt(3);
          else if (schritt === 3) void festhalten();
        }}
      >
        <SchrittAnzeige nr={schritt} von={3} />
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
            </>
          ) : (
            <NwTextfeld label="Text" wert={wortlaut} onWert={setWortlaut} mehrzeilig fehler={fehler.wortlaut} hoechstens={20000} testid="festhalten-text" />
          ))}
        {schritt === 3 && (
          <>
            <PruefZeilen
              zeilen={[
                { etikett: 'Teil', wert: titel || artWort },
                wo === 'verweis'
                  ? { etikett: 'Original', wert: [verweis.ablage, verweis.kennung].filter(Boolean).join(' · '), onAendern: () => setSchritt(2) }
                  : { etikett: 'Text', wert: wortlaut.length > 60 ? `${wortlaut.slice(0, 57)} …` : wortlaut, onAendern: () => setSchritt(2) },
                ...(weiter === 'freigeben' && darfFreigeben && !aendern ? [{ etikett: 'Entschieden', wert: `${personWort} · ${tagWort}`, onAendern: () => setAendern(true) }] : []),
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
            {weiter === 'freigeben' && darfFreigeben && aendern && (
              <>
                <VpPicker
                  id={`${basis}-person`}
                  label="Wer hat entschieden?"
                  options={(personen ?? []).map((p) => ({ value: p.id, label: p.label }))}
                  value={von || null}
                  onChange={setVon}
                  placeholder="Person wählen"
                  loading={personen === null}
                  error={fehler.entschiedenVon ?? null}
                />
                <VpDatePicker label="Wann?" value={tag || heute || null} onChange={setTag} max={heute ?? undefined} />
                <NwTextfeld label="Warum?" wert={begruendung} onWert={setBegruendung} fehler={fehler.begruendung} hoechstens={500} testid="festhalten-begruendung" />
              </>
            )}
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
