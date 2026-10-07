import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type EnergiemanagementMappe } from '../api';
import { GrenzHinweis, GrenzSatz, GrenzSatzBereich } from '../components/GrenzSatz';
import { EinsichtBlatt } from '../components/nachweisen/EinsichtBlatt';
import { NwKopf } from '../components/nachweisen/NwKopf';
import { StatusZeile } from '../components/nachweisen/NwStatus';
import { NwSymbol } from '../components/nachweisen/NwSymbol';
import { NwZeichen } from '../components/nachweisen/NwZeichen';
import { Fakt, NwZeile, NwZeilen } from '../components/nachweisen/NwZeilen';
import { seitenLink } from '../components/nachweisen/teilen';
import { Weitergeben, type WeitergebenKnopf } from '../components/nachweisen/Weitergeben';
import * as E from '../energiemanagementPortal';
import * as P from '../mappeBild';
import { hashForRoute, mappeRoute } from '../nav';
import { useRollen } from '../rollen';
import { merkeAbruf, routenHeute } from '../routenUhr';
import '../components/nachweisen/NwZeilen.css';
import './Energiemanagement.css';

/** Speichert eine Datei im Browser (wie die Stände der Berichte). */
function speichern(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

/**
 * Die Seite einer Mappe (Konzept Nachweisen n1, Runde 2, Entscheid 7, Mock MP3) - Schritt 3 von „Unterlagen
 * zusammenstellen“: „Die Mappe ist fertig · PDF mit Inhaltsverzeichnis“, die Datei mit „Öffnen“, darunter Teilen,
 * Speichern (PDF), CSV und - für Kundenadministratoren - „Einsicht geben“; dazu die Teile, die als offen darin stehen.
 * Jeder Abruf wird protokolliert; nach 30 Tagen ist die Mappe nicht mehr abrufbar (410), ihre Angaben bleiben.
 */
export function MappeSeite({ id, onZurueck }: { id: string; onZurueck: () => void }) {
  const rollen = useRollen();
  const darfEinsicht = rollen.darf('benutzer.verwalten', null);
  // Review P6-6: „Neu zusammenstellen“ nur, wer zusammenstellen darf - „Einsicht“ liest nur.
  const darfNeu = rollen.darf(E.RECHT_VERWALTEN, null);
  const [m, setM] = useState<EnergiemanagementMappe | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState<'pdf' | 'csv' | null>(null);
  const [satz, setSatz] = useState<{ text: string; fehler: boolean } | null>(null);
  const [einsicht, setEinsicht] = useState(false);
  const [versuch, setVersuch] = useState(0);

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api.energiemanagementMappe(id).then(
      (r) => {
        // Befund 3: „heute“ ist der Tag der Route - die Frist von „Einsicht geben“ zählt ab ihm. `abruf` ist ein
        // Augenblick mit dem Versatz des Unternehmens; seine ersten zehn Zeichen sind der Tag in dessen Zone.
        merkeAbruf(r.abruf.slice(0, 10));
        if (aktiv) setM(r);
      },
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  // Review P6-4: „Öffnen“ lädt das PDF wie „Speichern“. Ein Blob-Dokument in einem neuen Fenster erbte die CSP des
  // Portals (`object-src 'none'`), der PDF-Betrachter wäre dort nicht sicher erlaubt; ein geladenes PDF zeigt das
  // Telefon direkt an, der Rechner in seiner Download-Leiste.
  async function abrufen(format: 'pdf' | 'csv') {
    if (!m) return;
    setLaeuft(format);
    setSatz(null);
    try {
      speichern(await api.energiemanagementMappeDatei(m.id, format), `${m.datei_name}.${format}`);
      setSatz({ text: 'Abgerufen, der Abruf ist protokolliert.', fehler: false });
      setVersuch((v) => v + 1);
    } catch (e) {
      setSatz({ text: E.ablehnungSatz(e), fehler: true });
      setVersuch((v) => v + 1);
    } finally {
      setLaeuft(null);
    }
  }

  // Erst ohne geladene Mappe ist der Fehler die Seite; scheitert nur das Neuladen nach einem Abruf, bleibt die Mappe
  // stehen und der Satz steht darunter (Review P6-8).
  if (!m) {
    return (
      <GrenzSatzBereich>
        <div className="vp-nw-seite vp-nw-mappe-seite" data-testid="mappe-seite">
          <NwKopf titel={P.UNTERLAGEN_ZUSAMMENSTELLEN} zurueck={{ label: E.UEBERBLICK, onClick: onZurueck }} testId="mappe-kopf" />
          {fehler ? (
            <p className="vp-ez-fehler" role="alert">
              {fehler}
            </p>
          ) : (
            <p className="vp-ez-leise">Wird geladen …</p>
          )}
        </div>
      </GrenzSatzBereich>
    );
  }

  const knoepfe: WeitergebenKnopf[] = m.abrufbar
    ? [
        { symbol: 'speichern', text: 'Speichern', onClick: () => void abrufen('pdf'), laeuft: laeuft !== null, testId: 'mappe-speichern' },
        { symbol: 'file-text', text: 'CSV', onClick: () => void abrufen('csv'), laeuft: laeuft !== null, testId: 'mappe-csv' },
        ...(darfEinsicht ? [{ symbol: 'eye' as const, text: P.EINSICHT_GEBEN, onClick: () => setEinsicht(true), testId: 'mappe-einsicht' }] : []),
      ]
    : [];
  const offen = P.offenZeile(m);

  return (
    <GrenzSatzBereich>
      <div className="vp-nw-seite vp-nw-mappe-seite" data-testid="mappe-seite">
        <NwKopf
          titel={m.titel}
          zurueck={{ label: E.UEBERBLICK, onClick: onZurueck }}
          kurzzeile={P.zeitText(m.stichtag)}
          testId="mappe-kopf"
        />
        {m.abrufbar ? (
          <div className="vp-nw-fertig" data-testid="mappe-fertig">
            <NwSymbol name="check" size={20} />
            <span>
              <b>{P.MAPPE_FERTIG}</b>
              {P.PDF_MIT_INHALT}
            </span>
          </div>
        ) : (
          <StatusZeile zeichen={<NwZeichen art="offen" />} text={P.MAPPE_ABGELAUFEN} sub={`· ${m.aufbewahrung_tage} Tage sind um`} testId="mappe-abgelaufen" />
        )}
        <NwZeilen testId="mappe-datei">
          <NwZeile
            vorn={
              <span className="vp-nw-ordner" aria-hidden="true">
                <NwSymbol name="ordner" size={18} />
              </span>
            }
            titel={m.datei_titel}
            unter={P.dateiZeile(m)}
            verb={m.abrufbar ? 'Öffnen' : undefined}
            {...(m.abrufbar ? { onClick: () => void abrufen('pdf') } : {})}
            testId="mappe-oeffnen"
          />
          <NwZeile titel="Zeitraum" rechts={<Fakt>{P.zeitraumText(m)}</Fakt>} testId="mappe-zeitraum-zeile" />
        </NwZeilen>
        {m.abrufbar ? (
          <Weitergeben knoepfe={knoepfe} teilenLink={{ titel: m.titel, url: seitenLink(hashForRoute(mappeRoute(m.id))) }} testId="mappe-weitergeben" />
        ) : darfNeu ? (
          <div className="vp-nw-vb-knoepfe">
            <Button variant="outline" onClick={onZurueck} data-testid="mappe-neu">
              Neu zusammenstellen
            </Button>
          </div>
        ) : null}
        {satz && (
          <p className={satz.fehler ? 'vp-nw-feld-fehler' : 'vp-nw-leise'} role={satz.fehler ? 'alert' : 'status'} data-testid="mappe-abruf">
            {satz.text}
          </p>
        )}
        {fehler && (
          <p className="vp-nw-feld-fehler" role="alert" data-testid="mappe-neu-laden">
            {fehler}
          </p>
        )}
        {offen && <StatusZeile zeichen={<NwZeichen art="offen" />} text={offen} testId="mappe-offen" />}
        <GrenzSatz verantwortung />
        <GrenzHinweis />
        {einsicht && <EinsichtBlatt heute={routenHeute()} onClose={() => setEinsicht(false)} />}
      </div>
    </GrenzSatzBereich>
  );
}
