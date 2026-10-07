import { useState, type FormEvent } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { ApiError } from '../../api';
import { benutzerApi, benutzerFehler, type BenutzerEintrag } from '../../benutzer';
import * as E from '../../energiemanagementPortal';
import * as P from '../../mappeBild';
import { hashForRoute, pageRoute } from '../../nav';
import { useRollen } from '../../rollen';
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

/** Die laufende „Einsicht“ eines Kontos (die Liste nennt nur wirksame und künftige): die am weitesten reichende. */
function laufendeEinsicht(konto: BenutzerEintrag): { id: string; bis: string | null } | null {
  const einsicht = konto.zuweisungen.filter((z) => z.rolle === 'einsicht');
  if (!einsicht.length) return null;
  const weiteste = einsicht.reduce((a, b) => (a.gueltig_bis === null ? a : b.gueltig_bis === null || b.gueltig_bis > a.gueltig_bis ? b : a));
  return { id: weiteste.id, bis: weiteste.gueltig_bis };
}

/** „Vor- und Nachname“ → Vorname(n) und Nachname: das letzte Wort ist der Nachname. */
export function namensTeile(name: string): { vorname: string; nachname: string } {
  const teile = name.trim().split(/\s+/u).filter(Boolean);
  if (teile.length <= 1) return { vorname: '', nachname: teile[0] ?? '' };
  return { vorname: teile.slice(0, -1).join(' '), nachname: teile[teile.length - 1] };
}

/**
 * „Einsicht geben“ (Konzept Nachweisen n1, Runde 2, Entscheid 8, Mock EI): ein Zugang mit der Rolle „Einsicht“ für eine
 * prüfende Person - Name, E-Mail, „Bis wann?“. Was die Person sieht, steht ohne Aufklappen da (Review P6-3, Captain:
 * die Rolle bleibt, das Blatt sagt ihren Umfang): alle Daten aller Standorte, nur lesend, bis zum letzten Tag - nicht nur
 * diese Mappe. Nur für Kundenadministratoren (die Route verlangt `benutzer.verwalten`); die Frist prüft die Route
 * (`gueltig_bis`, nie vor heute). Danach steht das Startpasswort einmal da - persönlich weitergeben; VoltPilot
 * verschickt keine Einladung. Während des Anlegens schließt das Blatt nicht (sonst entstünde der Zugang, ohne dass
 * jemand das Passwort sieht, Review P6-5).
 *
 * Gibt es für die E-Mail-Adresse schon ein Konto (409, etwa die prüfende Person vom letzten Audit), gibt das Blatt
 * diesem Konto die Einsicht bis zum gewählten Tag - neu zugewiesen oder, wenn sie noch läuft, verlängert - und
 * verweist auf die Benutzerverwaltung (Review P6-7). Der Kasten nennt die laufende Einsicht; eine, die ohne Ende oder
 * länger läuft, kürzt das Blatt nie (Review r2, N-6.1) - das geht ausdrücklich in der Benutzerverwaltung.
 *
 * `heute` ist der Tag der Route (Befund 3): „2 Wochen“ endet am 14. Tag danach.
 */
export function EinsichtBlatt({ heute, onClose }: { heute: string; onClose: () => void }) {
  const rollen = useRollen();
  const darfZuweisen = rollen.darf('zuweisung.verwalten', null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [frist, setFrist] = useState<Frist>('zwei_wochen');
  const [anderer, setAnderer] = useState<string | null>(null);
  const [fehler, setFehler] = useState<{ name?: string; email?: string; tag?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [angelegt, setAngelegt] = useState<{ passwort: string; bis: string } | null>(null);
  const [vorhanden, setVorhanden] = useState<BenutzerEintrag | null>(null);
  const [gegeben, setGegeben] = useState<{ name: string; bis: string } | null>(null);
  const [kopiert, setKopiert] = useState(false);

  const bis = frist === 'zwei_wochen' ? letzterTag(heute, 14) : frist === 'vier_wochen' ? letzterTag(heute, 28) : anderer;
  // Die laufende Einsicht des vorhandenen Kontos: die, die am weitesten reicht (ohne Ende vor jedem Tag).
  const laufend = vorhanden ? laufendeEinsicht(vorhanden) : null;
  const wahl = P.einsichtWahl(laufend, bis);
  const fertig = angelegt !== null || gegeben !== null;
  const schliessen = () => {
    if (!busy) onClose();
  };

  function pruefen(): string | null {
    const f = {
      name: name.trim() ? undefined : 'Bitte nennen Sie den Namen.',
      email: EMAIL.test(email.trim()) ? undefined : 'Bitte geben Sie eine E-Mail-Adresse an.',
      tag: bis ? undefined : 'Bitte wählen Sie den letzten Tag.',
    };
    setFehler(f);
    return f.name || f.email || f.tag || !bis ? null : bis;
  }

  async function anlegen() {
    const tag = pruefen();
    if (!tag) return;
    setBusy(true);
    setSatz(null);
    const adresse = email.trim();
    try {
      const r = await benutzerApi.anlegen({
        username: adresse,
        email: adresse,
        ...namensTeile(name),
        rolle: 'einsicht',
        standorte: [],
        gueltig_bis: tag,
      });
      setAngelegt({ passwort: r.startpasswort, bis: tag });
    } catch (e) {
      // 409: die Adresse hat schon ein Konto - etwa die prüfende Person vom letzten Audit. Dann erneuert das Blatt.
      const konto =
        e instanceof ApiError && e.status === 409
          ? await benutzerApi.liste().then(
              (l) => l.find((b) => b.email.toLowerCase() === adresse.toLowerCase() && b.zustand !== 'entfernt') ?? null,
              () => null,
            )
          : null;
      if (konto) setVorhanden(konto);
      else setSatz(benutzerFehler(e, 'Der Zugang ließ sich gerade nicht anlegen. Bitte versuchen Sie es noch einmal.'));
    } finally {
      setBusy(false);
    }
  }

  async function einsichtGeben(konto: BenutzerEintrag) {
    const tag = pruefen();
    if (!tag) return;
    const lauf = laufendeEinsicht(konto);
    // Nie still kürzen (Review r2, N-6.1): ohne Ende oder länger als gewählt bleibt die laufende Einsicht.
    if (P.einsichtWahl(lauf, tag) === 'bleibt') return;
    setBusy(true);
    setSatz(null);
    try {
      if (lauf) await benutzerApi.wechseln(konto.sub, [lauf.id], 'einsicht', [], tag);
      else await benutzerApi.einsichtZuweisen(konto.sub, tag, null);
      setGegeben({ name: konto.anzeigename, bis: tag });
    } catch (e) {
      setSatz(benutzerFehler(e, 'Die Einsicht ließ sich gerade nicht geben. Bitte versuchen Sie es noch einmal.'));
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
  const fuss = fertig ? (
    <div className="vp-nw-blatt-fuss">
      <Button onClick={onClose} data-testid="einsicht-fertig">
        Fertig
      </Button>
    </div>
  ) : (
    <div className="vp-nw-blatt-fuss">
      {vorhanden && (!darfZuweisen || wahl === 'bleibt') ? null : (
        <Button type="submit" form="einsicht-form" disabled={busy} aria-busy={busy || undefined} data-testid="einsicht-anlegen">
          {vorhanden
            ? wahl === 'verlaengern'
              ? bis
                ? `Einsicht bis ${E.tagText(bis)} verlängern`
                : 'Einsicht verlängern'
              : bis
                ? `Einsicht bis ${E.tagText(bis)} geben`
                : 'Einsicht geben'
            : 'Zugang anlegen'}
        </Button>
      )}
      <Button variant="ghost" onClick={schliessen} disabled={busy}>
        Abbrechen
      </Button>
    </div>
  );

  return (
    <NwBlatt open titel={P.EINSICHT_GEBEN} onClose={schliessen} fuss={fuss} testId="einsicht-blatt">
      <form
        id="einsicht-form"
        className="vp-nw-schritt-inhalt"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (fertig || busy) return;
          void (vorhanden ? einsichtGeben(vorhanden) : anlegen());
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
        ) : gegeben ? (
          <>
            <StatusZeile zeichen={<NwZeichen art="festgehalten" />} text="Einsicht gegeben" sub={`· bis ${E.tagText(gegeben.bis)}`} testId="einsicht-gegeben" />
            <p className="vp-nw-leise">{gegeben.name} meldet sich mit dem bisherigen Passwort an.</p>
          </>
        ) : (
          <>
            {/* Review P6-3: der Umfang ohne Aufklappen - nicht nur diese Mappe, sondern alles, nur lesend, befristet. */}
            <p className="vp-nw-einsicht-umfang" data-testid="einsicht-umfang">
              {/* Bleibt die laufende Einsicht, gilt ihr Ende, nicht der gewählte Tag (Review r2, N-6.1). */}
              {P.einsichtUmfang(wahl === 'bleibt' && laufend ? laufend.bis : bis)}
            </p>
            <NwTextfeld label="Name" wert={name} onWert={setName} platzhalter="Vor- und Nachname" hoechstens={200} fehler={fehler.name} testid="einsicht-name" />
            <NwTextfeld
              label="E-Mail"
              art="email"
              wert={email}
              onWert={(w) => {
                setEmail(w);
                setVorhanden(null);
              }}
              platzhalter="E-Mail-Adresse"
              hoechstens={254}
              fehler={fehler.email}
              testid="einsicht-email"
            />
            <WahlChips frage="Bis wann?" optionen={FRISTEN} wert={frist} onWahl={setFrist} testid="einsicht-frist" />
            {frist === 'anderer_tag' && (
              <VpDatePicker label="Letzter Tag" value={anderer} onChange={setAnderer} min={heute} error={fehler.tag ?? null} />
            )}
            {vorhanden && (
              <div className="vp-nw-einsicht-vorhanden" data-testid="einsicht-vorhanden">
                <p>
                  Schon ein Zugang: <b>{vorhanden.anzeigename}</b>
                </p>
                <p className="vp-nw-leise" data-testid="einsicht-stand">
                  {P.einsichtStand(laufend, wahl)}
                </p>
                <a href={hashForRoute(pageRoute('kunden-benutzer'))} className="vp-nw-link-knopf" data-testid="einsicht-benutzerverwaltung">
                  Benutzerverwaltung
                </a>
              </div>
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
