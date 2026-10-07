import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import {
  api,
  type BerichtDetail,
  type BerichtEntwurf,
  type Managementbewertung,
  type ManagementbewertungBeschluss,
  type ManagementbewertungBeschlussArt,
} from '../api';
import { freigabeAntrag, freigabeFehler, freigabeVorschau } from '../berichtDialoge';
import { abzugAus, gueltigerStand } from '../berichtSeite';
import { VOKABULARE } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import * as M from '../managementbewertung';
import * as B from '../managementbewertungBild';
import { EinsichtRecht } from './EinsichtRecht';
import { GrenzSatz } from './GrenzSatz';
import { usePersonen } from './InternesAuditDialoge';
import { NwBlatt } from './nachweisen/NwBlatt';
import { HinweisZeile, PruefZeilen, SchrittAnzeige, WahlChips } from './nachweisen/NwSchritte';
import { NwTextfeld } from './nachweisen/NwTextfeld';
import { Fakt, NwZeile, NwZeilen } from './nachweisen/NwZeilen';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

const TITEL: Record<B.VorbereitenSchritt, string> = {
  eingaben: 'Was die Leitung sieht',
  sitzung: 'Sitzung',
  beschluss: 'Beschluss',
  pruefen: 'Prüfen',
  freigeben: 'Freigeben',
};

/**
 * Das Blatt „Vorbereiten“ einer Managementbewertung (Konzept Nachweisen n1, Runde 1 §6.7 und Runde 2, Mock MBV): fünf
 * Schritte - Eingaben ansehen, Sitzung, Beschlüsse (Art wählen statt tippen, Wortlaut, wer, bis wann), prüfen,
 * freigeben. Jeder Schritt hält über die Route fest, was er fragt (MG4, MG5; Freigabe = Freigabe der Berichte, F2); die
 * Route entscheidet und lehnt mit ihrem Satz ab. Höchstens 35 Wörter des Systems je Schritt, der Beschluss 30.
 *
 * `heute` ist der Tag der Route (Befund 3) - Tag der Sitzung und Termin nie aus dem Browser.
 */
export function ManagementbewertungVorbereiten({
  kennung,
  mb,
  detail,
  entwurf,
  start,
  heute,
  titel,
  onMb,
  onEntwurf,
  onFreigegeben,
  onClose,
}: {
  kennung: string;
  mb: Managementbewertung;
  detail: BerichtDetail;
  entwurf: BerichtEntwurf | null;
  start: B.VorbereitenSchritt;
  heute: string;
  /** Titel je Kennzeichen für die Kurztitel der Beschlüsse im Schritt „Prüfen“. */
  titel: { dokumente: Record<string, string>; massnahmen: Record<string, string> };
  onMb: (mb: Managementbewertung) => void;
  onEntwurf: (e: BerichtEntwurf) => void;
  onFreigegeben: () => void;
  onClose: () => void;
}) {
  const [schritt, setSchritt] = useState<B.VorbereitenSchritt>(start);
  const [beschluss, setBeschluss] = useState<ManagementbewertungBeschluss | null>(null);
  const nr = B.VORBEREITEN_SCHRITTE.indexOf(schritt) + 1;
  const geh = (s: B.VorbereitenSchritt, b: ManagementbewertungBeschluss | null = null) => {
    setBeschluss(b);
    setSchritt(s);
  };
  const blattTitel = schritt === 'beschluss' ? `Beschluss ${beschluss?.nr ?? mb.beschluesse.length + 1}` : TITEL[schritt];

  return (
    <NwBlatt open titel={blattTitel} onClose={onClose} testId="mb-vorbereiten">
      <div className="vp-nw-schritt-inhalt" data-schritt={schritt}>
        <SchrittAnzeige nr={nr} von={B.VORBEREITEN_SCHRITTE.length} />
        {schritt === 'eingaben' && <Eingaben entwurf={entwurf} onWeiter={() => geh('sitzung')} onClose={onClose} />}
        {schritt === 'sitzung' && (
          <Sitzung kennung={kennung} mb={mb} heute={heute} onZurueck={() => geh('eingaben')} onFertig={(m) => (onMb(m), geh(m.beschluesse.length ? 'pruefen' : 'beschluss'))} />
        )}
        {schritt === 'beschluss' && (
          <Beschluss key={beschluss?.nr ?? 'neu'} kennung={kennung} mb={mb} beschluss={beschluss} onZurueck={() => geh(mb.beschluesse.length ? 'pruefen' : 'sitzung')} onFertig={(m) => (onMb(m), geh('pruefen'))} />
        )}
        {schritt === 'pruefen' && (
          <Pruefen mb={mb} titel={titel} onSitzung={() => geh('sitzung')} onBeschluss={(b) => geh('beschluss', b)} onWeiter={() => geh('freigeben')} />
        )}
        {schritt === 'freigeben' && entwurf && (
          <Freigeben detail={detail} entwurf={entwurf} mb={mb} onEntwurf={onEntwurf} onZurueck={() => geh('pruefen')} onFreigegeben={onFreigegeben} />
        )}
        {schritt === 'freigeben' && !entwurf && <p className="vp-nw-leise">Wird geladen …</p>}
        {/* Grenz- und Verantwortungs-Satz: einmal am Fuß der Seite, unter der das Blatt liegt (K7/D5). */}
        <GrenzSatz verantwortung />
      </div>
    </NwBlatt>
  );
}

/** Die Knöpfe eines Schritts: vorn der eine Schritt nach vorn, dahinter „Zurück“ oder „Abbrechen“. */
function Knoepfe({ children }: { children: ReactNode }) {
  return <div className="vp-nw-vb-knoepfe">{children}</div>;
}

function Ablehnung({ satz }: { satz: string | null }) {
  if (!satz) return null;
  return (
    <p className="vp-nw-feld-fehler" role="alert" data-testid="energiemanagement-ablehnung">
      {satz}
    </p>
  );
}

// ------------------------------------------------------------------ 1 · Eingaben

function Eingaben({ entwurf, onWeiter, onClose }: { entwurf: BerichtEntwurf | null; onWeiter: () => void; onClose: () => void }) {
  const zeilen = entwurf ? B.eingabenZeilen(M.abzug(entwurf.abzug)) : null;
  return (
    <>
      {zeilen === null ? (
        <p className="vp-nw-leise">Wird geladen …</p>
      ) : (
        <NwZeilen testId="mb-vb-eingaben">
          {zeilen.map((z) => (
            <NwZeile key={z.key} titel={z.titel} rechts={z.zahl !== null ? <Fakt>{z.zahl}</Fakt> : undefined} />
          ))}
        </NwZeilen>
      )}
      <Knoepfe>
        <Button onClick={onWeiter} data-testid="mb-vb-weiter">
          Weiter
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Abbrechen
        </Button>
      </Knoepfe>
    </>
  );
}

// ------------------------------------------------------------------ 2 · Sitzung (MG4)

function Sitzung({
  kennung,
  mb,
  heute,
  onZurueck,
  onFertig,
}: {
  kennung: string;
  mb: Managementbewertung;
  heute: string;
  onZurueck: () => void;
  onFertig: (mb: Managementbewertung) => void;
}) {
  const vorher = mb.sitzung ?? null;
  const { personen, optionen } = usePersonen();
  const [tag, setTag] = useState(vorher?.tag ?? heute);
  const [leitung, setLeitung] = useState<string | null>(vorher?.leitung.id ?? null);
  const [leitungWaehlen, setLeitungWaehlen] = useState(false);
  const [teilnehmende, setTeilnehmende] = useState<string[]>(vorher?.teilnehmende.map((p) => p.id) ?? []);
  const [ort, setOrt] = useState(vorher?.ort ?? '');
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (vorher || !tag) return;
    let aktiv = true;
    // PA3: wer am Tag der Sitzung die Aufgabe „Leitung des Unternehmens“ hat - nur ein Vorschlag, die Route prüft.
    api.energiemanagementAufgaben(tag).then(
      (a) => {
        if (!aktiv) return;
        if (a.leitung.length) setLeitung((l) => l ?? a.leitung[0].id);
        else setLeitungWaehlen(true);
      },
      () => aktiv && setLeitungWaehlen(true),
    );
    return () => {
      aktiv = false;
    };
  }, [tag, vorher]);
  const leitungName = personen?.find((p) => p.id === leitung)?.name ?? vorher?.leitung.name ?? '';

  async function festhalten() {
    if (!tag || !leitung) {
      setLeitungWaehlen(true);
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onFertig(
        await api.managementbewertungSitzung(kennung, {
          tag,
          leitung,
          teilnehmende: teilnehmende.filter((p) => p !== leitung),
          ...(ort.trim() ? { ort: ort.trim() } : {}),
        }),
      );
    } catch (err) {
      setSatz(M.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <VpDatePicker label="Wann?" value={tag || null} onChange={setTag} max={heute} />
      {leitungWaehlen || !leitung ? (
        <VpPicker label={M.LEITUNG} options={optionen} value={leitung} onChange={setLeitung} placeholder="Person wählen" loading={personen === null} />
      ) : (
        <PruefZeilen zeilen={[{ etikett: M.LEITUNG, wert: leitungName, onAendern: () => setLeitungWaehlen(true) }]} testid="mb-vb-leitung" />
      )}
      <VpPicker
        label="Wer war dabei?"
        options={optionen.filter((o) => o.value !== leitung)}
        values={teilnehmende}
        onChangeMany={setTeilnehmende}
        placeholder="Personen wählen"
        loading={personen === null}
      />
      <NwTextfeld label="Wo? (wahlfrei)" wert={ort} onWert={setOrt} hoechstens={200} testid="mb-vb-ort" />
      <Ablehnung satz={satz} />
      <Knoepfe>
        <Button onClick={() => void festhalten()} disabled={busy} data-testid="mb-vb-sitzung-festhalten">
          Festhalten
        </Button>
        <Button variant="ghost" onClick={onZurueck}>
          Zurück
        </Button>
      </Knoepfe>
    </>
  );
}

// ------------------------------------------------------------------ 3 · Beschluss (MG5)

function Beschluss({
  kennung,
  mb,
  beschluss,
  onZurueck,
  onFertig,
}: {
  kennung: string;
  mb: Managementbewertung;
  beschluss: ManagementbewertungBeschluss | null;
  onZurueck: () => void;
  onFertig: (mb: Managementbewertung) => void;
}) {
  const { personen, optionen } = usePersonen();
  const [art, setArt] = useState<ManagementbewertungBeschlussArt | null>(beschluss?.art ?? null);
  const [wortlaut, setWortlaut] = useState(beschluss?.wortlaut ?? '');
  const [zustaendig, setZustaendig] = useState<string | null>(beschluss?.zustaendig?.id ?? null);
  const [termin, setTermin] = useState(beschluss?.termin ?? '');
  const [fehler, setFehler] = useState<{ art?: string; wortlaut?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Entschieden hat die Leitung der Sitzung (MG5); wer festhält, steht als „eingetragen von“ daneben.
  const entschieden = beschluss?.entschieden_von.id ?? mb.sitzung?.leitung.id ?? null;

  async function festhalten() {
    const w = wortlaut.trim();
    const f = {
      art: art ? undefined : 'Bitte wählen.',
      wortlaut: !w ? 'Bitte einen Satz.' : w.length > M.WORTLAUT_HOECHSTENS ? `Höchstens ${M.WORTLAUT_HOECHSTENS} Zeichen.` : undefined,
    };
    setFehler(f);
    if (f.art || f.wortlaut || !art) return;
    setBusy(true);
    setSatz(null);
    const body = {
      art,
      wortlaut: w,
      ...(entschieden ? { entschieden_von: entschieden } : {}),
      ...(zustaendig ? { zustaendig } : {}),
      ...(termin ? { termin } : {}),
    };
    try {
      onFertig(beschluss ? await api.managementbewertungBeschlussAendern(kennung, beschluss.nr, body) : await api.managementbewertungBeschluss(kennung, body));
    } catch (err) {
      setSatz(M.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <WahlChips
        frage="Worum geht es?"
        optionen={VOKABULARE.beschluss_art.map((a) => ({ wert: a as ManagementbewertungBeschlussArt, label: B.BESCHLUSS_CHIP[a] ?? a }))}
        wert={art}
        onWahl={setArt}
        fehler={fehler.art}
        testid="mb-vb-art"
      />
      <NwTextfeld label="Beschluss" wert={wortlaut} onWert={setWortlaut} mehrzeilig hoechstens={M.WORTLAUT_HOECHSTENS} fehler={fehler.wortlaut} testid="mb-vb-wortlaut" />
      <div className="vp-nw-vb-zwei">
        <VpPicker label="Wer?" options={optionen} value={zustaendig} onChange={setZustaendig} placeholder="Person" loading={personen === null} />
        <VpDatePicker label="Bis?" value={termin || null} onChange={setTermin} placeholder="Tag" />
      </div>
      <Ablehnung satz={satz} />
      <Knoepfe>
        <Button onClick={() => void festhalten()} disabled={busy} data-testid="mb-vb-beschluss-festhalten">
          Festhalten
        </Button>
        <Button variant="ghost" onClick={onZurueck}>
          Zurück
        </Button>
      </Knoepfe>
    </>
  );
}

// ------------------------------------------------------------------ 4 · Prüfen

function Pruefen({
  mb,
  titel,
  onSitzung,
  onBeschluss,
  onWeiter,
}: {
  mb: Managementbewertung;
  titel: { dokumente: Record<string, string>; massnahmen: Record<string, string> };
  onSitzung: () => void;
  onBeschluss: (b: ManagementbewertungBeschluss | null) => void;
  onWeiter: () => void;
}) {
  const s = mb.sitzung;
  const bereit = M.freigabeBereit(mb);
  return (
    <>
      <PruefZeilen
        testid="mb-vb-pruefen"
        zeilen={[
          { etikett: 'Sitzung', wert: s ? [E.tagText(s.tag), s.leitung.name].filter(Boolean).join(' · ') : 'fehlt', onAendern: onSitzung },
          ...[...mb.beschluesse]
            .sort((a, b) => a.nr - b.nr)
            .map((b) => ({ etikett: `Beschluss ${b.nr}`, wert: B.beschlussKurz(b, titel), onAendern: () => onBeschluss(b) })),
        ]}
      />
      {s && !s.leitung_gilt && <p className="vp-nw-feld-fehler" data-testid="mb-leitung-gilt-nicht">{M.LEITUNG_GILT_NICHT}</p>}
      <Knoepfe>
        <Button onClick={onWeiter} disabled={!bereit} data-testid="mb-vb-weiter">
          Weiter
        </Button>
        <Button variant="outline" onClick={() => onBeschluss(null)} disabled={!s} data-testid="mb-vb-weiterer">
          Weiterer Beschluss
        </Button>
      </Knoepfe>
    </>
  );
}

// ------------------------------------------------------------------ 5 · Freigeben (= Freigabe der Berichte, F2)

function Freigeben({
  detail,
  entwurf: gesehen,
  mb,
  onEntwurf,
  onZurueck,
  onFreigegeben,
}: {
  detail: BerichtDetail;
  entwurf: BerichtEntwurf;
  mb: Managementbewertung;
  onEntwurf: (e: BerichtEntwurf) => void;
  onZurueck: () => void;
  onFreigegeben: () => void;
}) {
  const [entwurf, setEntwurf] = useState(gesehen);
  const [fehler, setFehler] = useState<{ satz: string; neuLaden: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setEntwurf(gesehen), [gesehen]);
  const b = detail.bericht;
  // Befund 3: der Augenblick der Route, mit dem die Seite gelesen wurde.
  const jetzt = Number.isNaN(Date.parse(detail.abruf)) ? Date.now() : Date.parse(detail.abruf);
  const v = freigabeVorschau(freigabeAntrag(b, entwurf, detail.staende, jetzt), gueltigerStand(detail.staende)?.nr ?? null, abzugAus(entwurf.abzug).kopf.darstellung.zahlenformat);
  const offen = v.punkte.filter((p) => !p.erfuellt);

  async function freigeben() {
    setBusy(true);
    setFehler(null);
    try {
      await api.berichtFreigeben(b.kennung, entwurf.datenstand);
      onFreigegeben();
    } catch (e) {
      setFehler(freigabeFehler(e));
    } finally {
      setBusy(false);
    }
  }
  async function neuLaden() {
    setBusy(true);
    try {
      const neu = await api.berichtEntwurf(b.kennung);
      setEntwurf(neu);
      setFehler(null);
      onEntwurf(neu);
    } catch {
      setFehler({ satz: M.LADEFEHLER, neuLaden: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PruefZeilen
        testid="mb-vb-freigeben-zeilen"
        zeilen={[
          { etikett: 'Eingaben vom', wert: M.zeitpunkt(entwurf.datenstand, b.zeitzone) },
          { etikett: 'Beschlüsse', wert: String(mb.beschluesse.length) },
        ]}
      />
      <HinweisZeile icon="lock" titel="Danach bleibt es so" zusatz="Folgen kommen dazu" />
      {offen.length > 0 && (
        <ul className="vp-nw-vb-offen" data-testid="mb-vb-offen">
          {offen.map((p) => (
            <li key={p.schluessel}>{p.text}</li>
          ))}
        </ul>
      )}
      {fehler && (
        <div className="vp-nw-feld-fehler" role="alert" data-testid="energiemanagement-ablehnung">
          <span>{fehler.satz}</span>
          {fehler.neuLaden && (
            <Button variant="outline" size="sm" onClick={() => void neuLaden()} disabled={busy}>
              Entwurf neu laden
            </Button>
          )}
        </div>
      )}
      <Knoepfe>
        <EinsichtRecht aktion={E.RECHT_FREIGEBEN} standort={null}>
          <Button onClick={() => void freigeben()} disabled={busy || !v.erlaubt} data-testid="mb-vb-freigeben">
            {B.KNOPF_MB_FREIGEBEN}
          </Button>
        </EinsichtRecht>
        <Button variant="ghost" onClick={onZurueck}>
          Zurück
        </Button>
      </Knoepfe>
    </>
  );
}
