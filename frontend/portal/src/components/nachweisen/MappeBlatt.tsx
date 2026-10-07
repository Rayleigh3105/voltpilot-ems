import { useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { api, type EnergiemanagementMappe, type EnergiemanagementVerzeichnis } from '../../api';
import * as E from '../../energiemanagementPortal';
import * as P from '../../mappeBild';
import { useIsPhone } from '../../useIsPhone';
import { GrenzSatz } from '../GrenzSatz';
import { VpDatePicker } from '../VpDatePicker';
import { NwBlatt } from './NwBlatt';
import { AntwortKarten, SchrittAnzeige, WahlChips } from './NwSchritte';
import { StatusZeile } from './NwStatus';
import { NwZeichen } from './NwZeichen';
import { HakenListe } from './NwZeilen';

/**
 * „Unterlagen zusammenstellen“ (Konzept Nachweisen n1, Runde 2, Entscheid 7, Mocks MP1, MP2, r2d-dlg-mp): wofür
 * (Antwort-Karten), welcher Zeitraum (Chips, „Ab Tag“ mit Datum), was hineingehört (vier Bündel zum Abhaken, je mit der
 * Zahl ihrer Einträge im Zeitraum) und die Teile, die offen sind - sie stehen als offen in der Mappe. Am Telefon zwei
 * Schritte, am Rechner ein Dialog mit dem Kasten „Die Mappe · Grenze“. „Mappe erstellen“ legt sie über die Route an;
 * danach öffnet die Seite der Mappe (Schritt 3).
 *
 * `heute` ist der Tag der Route (Befund 3); `verzeichnis` das Verzeichnis, das der Überblick schon gelesen hat.
 */
export function MappeBlatt({
  heute,
  verzeichnis,
  offen,
  onClose,
  onErstellt,
}: {
  heute: string;
  verzeichnis: Pick<EnergiemanagementVerzeichnis, 'gruppen'> | null;
  /** Die Teile, die der Überblick als offen zeigt (Vokabular `teil`). */
  offen: readonly string[];
  onClose: () => void;
  onErstellt: (m: EnergiemanagementMappe) => void;
}) {
  const isPhone = useIsPhone();
  const [schritt, setSchritt] = useState<1 | 2>(1);
  const [anlass, setAnlass] = useState<string | null>('audit_von_aussen');
  const [zeitraum, setZeitraum] = useState<P.ZeitraumWahl>('zwoelf_monate');
  const [abTag, setAbTag] = useState<string | null>(null);
  const [buendel, setBuendel] = useState<string[]>(P.BUENDEL.map((b) => b.key));
  const [fehler, setFehler] = useState<{ abTag?: string; buendel?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const von = P.vonFuer(zeitraum, heute, abTag);
  const optionen = P.BUENDEL.map((b) => ({
    wert: b.key,
    titel: b.titel,
    // Die Zahl der Einträge im Zeitraum, rechts wie „Personen · 6“ (Blatt ≤ 35 Wörter).
    rechts: verzeichnis ? String(P.eintraegeIm(verzeichnis, b, von, heute)) : null,
  }));

  function pruefeSchritt1(): boolean {
    if (zeitraum === 'ab_tag' && !abTag) {
      setFehler({ abTag: 'Bitte wählen Sie einen Tag.' });
      return false;
    }
    setFehler({});
    return true;
  }

  async function erstellen() {
    if (!pruefeSchritt1() || !anlass) return;
    if (!buendel.length) {
      setFehler({ buendel: 'Bitte wählen Sie mindestens einen Teil.' });
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onErstellt(await api.energiemanagementMappeAnlegen({ anlass, von, gruppen: P.gruppenAus(buendel), offen: [...offen] }));
    } catch (e) {
      setSatz(E.ablehnungSatz(e));
    } finally {
      setBusy(false);
    }
  }

  const wofuer = (
    <AntwortKarten
      {...(isPhone ? { label: P.WOFUER } : { frage: P.WOFUER })}
      // Am Rechner die Karten ohne Zusatz nebeneinander (Mock r2d-dlg-mp; Dialog ≤ 70 Wörter).
      optionen={isPhone ? P.anlassOptionen() : P.anlassOptionen().map((o) => ({ ...o, zusatz: null }))}
      wert={anlass}
      onWahl={setAnlass}
      testid="mappe-anlass"
    />
  );
  const zeitraumWahl = (
    <>
      <WahlChips frage={P.ZEITRAUM} optionen={P.ZEITRAUM_CHIPS} wert={zeitraum} onWahl={setZeitraum} testid="mappe-zeitraum" />
      {zeitraum === 'ab_tag' && <VpDatePicker label="Ab" value={abTag} onChange={setAbTag} max={heute} error={fehler.abTag ?? null} />}
    </>
  );
  const inhalt = (
    <>
      <HakenListe frage={P.WAS_GEHOERT_HINEIN} verborgen={isPhone} optionen={optionen} werte={buendel} onWerte={setBuendel} testId="mappe-inhalt" />
      {fehler.buendel && (
        <p className="vp-nw-feld-fehler" role="alert">
          {fehler.buendel}
        </p>
      )}
      {offen.length > 0 && (
        <StatusZeile zeichen={<NwZeichen art="offen" />} text={P.teileOffenWort(offen.length)} sub="· stehen als offen darin" testId="mappe-offen" />
      )}
    </>
  );
  const ablehnung = satz && (
    <p className="vp-nw-feld-fehler" role="alert" data-testid="energiemanagement-ablehnung">
      {satz}
    </p>
  );
  const erstellenKnopf = (
    <Button onClick={() => void erstellen()} disabled={busy || !anlass} data-testid="mappe-erstellen">
      {P.MAPPE_ERSTELLEN}
    </Button>
  );

  if (isPhone) {
    return (
      <NwBlatt open titel={schritt === 1 ? P.UNTERLAGEN_ZUSAMMENSTELLEN : P.WAS_GEHOERT_HINEIN} onClose={onClose} testId="mappe-blatt">
        <div className="vp-nw-schritt-inhalt">
          <SchrittAnzeige nr={schritt} von={3} />
          {schritt === 1 ? (
            <>
              {wofuer}
              {zeitraumWahl}
              <div className="vp-nw-vb-knoepfe">
                <Button onClick={() => pruefeSchritt1() && setSchritt(2)} data-testid="mappe-weiter">
                  Weiter
                </Button>
                <Button variant="ghost" onClick={onClose}>
                  Abbrechen
                </Button>
              </div>
            </>
          ) : (
            <>
              {inhalt}
              {ablehnung}
              <div className="vp-nw-vb-knoepfe">
                {erstellenKnopf}
                <Button variant="ghost" onClick={() => setSchritt(1)}>
                  Zurück
                </Button>
              </div>
            </>
          )}
          {/* Grenz- und Verantwortungs-Satz: einmal am Fuß des Bereichs, unter dem das Blatt liegt (K7/D5). */}
          <GrenzSatz verantwortung />
        </div>
      </NwBlatt>
    );
  }
  return (
    <NwBlatt
      open
      breit
      titel={P.UNTERLAGEN_ZUSAMMENSTELLEN}
      onClose={onClose}
      testId="mappe-blatt"
      fuss={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          {erstellenKnopf}
        </>
      }
    >
      <p className="vp-nw-leise vp-nw-mappe-kurz">{P.zeitraumKurz(von)}</p>
      <div className="vp-nw-mappe-dialog">
        <div className="vp-nw-schritt-inhalt">
          {wofuer}
          {zeitraumWahl}
          {inhalt}
          {ablehnung}
        </div>
        <aside className="vp-nw-mappe-kasten" aria-label="Die Mappe">
          <p>
            <span>Die Mappe</span>
            ein PDF mit Inhaltsverzeichnis und eine CSV
          </p>
          <p>
            <span>Grenze</span>
            Ob es genügt, beurteilt, wer Sie prüft.
          </p>
        </aside>
      </div>
      <GrenzSatz verantwortung />
    </NwBlatt>
  );
}
