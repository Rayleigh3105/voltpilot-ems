import { useState, type FormEvent } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { benutzerApi, benutzerFehler } from '../../benutzer';
import * as E from '../../energiemanagementPortal';
import * as P from '../../mappeBild';
import { ROLLE_BESCHREIBUNG } from '../BenutzerEinladen';
import { GrenzSatz } from '../GrenzSatz';
import { VpDatePicker } from '../VpDatePicker';
import { NwBlatt } from './NwBlatt';
import { WahlChips } from './NwSchritte';
import { StatusZeile } from './NwStatus';
import { NwSymbol } from './NwSymbol';
import { NwTextfeld } from './NwTextfeld';
import { NwZeichen } from './NwZeichen';

type Frist = 'zwei_wochen' | 'vier_wochen' | 'anderer_tag';
const FRISTEN: readonly { wert: Frist; label: string }[] = [
  { wert: 'zwei_wochen', label: '2 Wochen' },
  { wert: 'vier_wochen', label: '4 Wochen' },
  { wert: 'anderer_tag', label: 'Anderer Tag' },
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Der letzte Tag, einschließlich: heute + n Tage (Kalendertage, Tag der Route). */
export function letzterTag(heute: string, tage: number): string {
  const [j, m, t] = heute.split('-').map(Number);
  const d = new Date(Date.UTC(j, m - 1, t + tage));
  return d.toISOString().slice(0, 10);
}

/** „Vor- und Nachname“ → Vorname(n) und Nachname: das letzte Wort ist der Nachname. */
export function namensTeile(name: string): { vorname: string; nachname: string } {
  const teile = name.trim().split(/\s+/u).filter(Boolean);
  if (teile.length <= 1) return { vorname: '', nachname: teile[0] ?? '' };
  return { vorname: teile.slice(0, -1).join(' '), nachname: teile[teile.length - 1] };
}

/**
 * „Einsicht geben“ (Konzept Nachweisen n1, Runde 2, Entscheid 8, Mock EI): ein Zugang mit der Rolle „Einsicht“ für eine
 * prüfende Person, nur lesen und befristet - Name, E-Mail, „Bis wann?“ und die Vorschau „so sieht es die Person“. Nur
 * für Kundenadministratoren (die Route verlangt `benutzer.verwalten`); die Frist prüft die Route (`gueltig_bis`, nie vor
 * heute). Danach steht das Startpasswort einmal da - persönlich weitergeben; VoltPilot verschickt keine Einladung.
 *
 * `heute` ist der Tag der Route (Befund 3): „2 Wochen“ endet am 14. Tag danach.
 */
export function EinsichtBlatt({ heute, onClose }: { heute: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [frist, setFrist] = useState<Frist>('zwei_wochen');
  const [anderer, setAnderer] = useState<string | null>(null);
  const [vorschau, setVorschau] = useState(false);
  const [fehler, setFehler] = useState<{ name?: string; email?: string; tag?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [angelegt, setAngelegt] = useState<{ passwort: string; bis: string } | null>(null);
  const [kopiert, setKopiert] = useState(false);

  const bis = frist === 'zwei_wochen' ? letzterTag(heute, 14) : frist === 'vier_wochen' ? letzterTag(heute, 28) : anderer;

  async function anlegen() {
    const f = {
      name: name.trim() ? undefined : 'Bitte nennen Sie den Namen.',
      email: EMAIL.test(email.trim()) ? undefined : 'Bitte geben Sie eine E-Mail-Adresse an.',
      tag: bis ? undefined : 'Bitte wählen Sie den letzten Tag.',
    };
    setFehler(f);
    if (f.name || f.email || f.tag || !bis) return;
    setBusy(true);
    setSatz(null);
    try {
      const adresse = email.trim();
      const r = await benutzerApi.anlegen({
        username: adresse,
        email: adresse,
        ...namensTeile(name),
        rolle: 'einsicht',
        standorte: [],
        gueltig_bis: bis,
      });
      setAngelegt({ passwort: r.startpasswort, bis });
    } catch (e) {
      setSatz(benutzerFehler(e, 'Der Zugang ließ sich gerade nicht anlegen. Bitte versuchen Sie es noch einmal.'));
    } finally {
      setBusy(false);
    }
  }

  async function kopieren(passwort: string) {
    try {
      await navigator.clipboard.writeText(passwort);
      setKopiert(true);
    } catch {
      setKopiert(false);
    }
  }

  // Wie die Blätter der Dokumente: ein Formular, die Knöpfe in der festen Fußzeile (`vp-nw-blatt-fuss`).
  const fuss = angelegt ? (
    <div className="vp-nw-blatt-fuss">
      <Button onClick={onClose} data-testid="einsicht-fertig">
        Fertig
      </Button>
    </div>
  ) : (
    <div className="vp-nw-blatt-fuss">
      <Button type="submit" form="einsicht-form" disabled={busy} aria-busy={busy || undefined} data-testid="einsicht-anlegen">
        Zugang anlegen
      </Button>
      <Button variant="ghost" onClick={onClose}>
        Abbrechen
      </Button>
    </div>
  );

  return (
    <NwBlatt open titel={P.EINSICHT_GEBEN} onClose={onClose} fuss={fuss} testId="einsicht-blatt">
      <form
        id="einsicht-form"
        className="vp-nw-schritt-inhalt"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!angelegt) void anlegen();
        }}
      >
        {angelegt ? (
          <>
            <StatusZeile zeichen={<NwZeichen art="festgehalten" />} text="Zugang angelegt" sub={`· bis ${E.tagText(angelegt.bis)}`} testId="einsicht-angelegt" />
            <p className="vp-nw-leise">Startpasswort, nur jetzt sichtbar:</p>
            <div className="vp-nw-passwort-zeile">
              <output aria-label="Startpasswort" className="vp-nw-passwort" data-testid="einsicht-passwort">
                {angelegt.passwort}
              </output>
              <Button variant="outline" iconLeft={<NwSymbol name="kopieren" size={16} />} onClick={() => void kopieren(angelegt.passwort)} data-testid="einsicht-kopieren">
                {kopiert ? 'Kopiert' : 'Kopieren'}
              </Button>
            </div>
            <p className="vp-nw-leise">Persönlich weitergeben; bei der ersten Anmeldung legt die Person ein eigenes fest.</p>
          </>
        ) : (
          <>
            <p className="vp-nw-leise vp-nw-mappe-kurz">nur lesen, befristet</p>
            <NwTextfeld label="Name" wert={name} onWert={setName} platzhalter="Vor- und Nachname" hoechstens={200} fehler={fehler.name} testid="einsicht-name" />
            <NwTextfeld label="E-Mail" art="email" wert={email} onWert={setEmail} platzhalter="E-Mail-Adresse" hoechstens={254} fehler={fehler.email} testid="einsicht-email" />
            <WahlChips frage="Bis wann?" optionen={FRISTEN} wert={frist} onWahl={setFrist} testid="einsicht-frist" />
            {frist === 'anderer_tag' && (
              <VpDatePicker label="Letzter Tag" value={anderer} onChange={setAnderer} min={heute} error={fehler.tag ?? null} />
            )}
            <button type="button" className="vp-nw-link-knopf" aria-expanded={vorschau} onClick={() => setVorschau((v) => !v)} data-testid="einsicht-vorschau">
              <NwSymbol name="eye" size={16} />
              Vorschau
            </button>
            {vorschau && (
              // So sieht es die Person: der Satz der Rolle aus der Benutzerverwaltung, eine Quelle für beide Orte.
              <p className="vp-nw-einsicht-vorschau" data-testid="einsicht-vorschau-inhalt">
                {ROLLE_BESCHREIBUNG.einsicht}
              </p>
            )}
            {satz && (
              <p className="vp-nw-feld-fehler" role="alert" data-testid="energiemanagement-ablehnung">
                {satz}
              </p>
            )}
          </>
        )}
        {/* Grenz- und Verantwortungs-Satz: einmal am Fuß des Bereichs, unter dem das Blatt liegt (K7/D5). */}
        <GrenzSatz verantwortung />
      </form>
    </NwBlatt>
  );
}
