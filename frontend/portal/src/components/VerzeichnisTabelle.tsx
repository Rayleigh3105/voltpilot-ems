import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import {
  api,
  type EnergiemanagementDokumentKurz,
  type EnergiemanagementPerson,
  type EnergiemanagementVerzeichnis,
  type EnergiemanagementVerzeichnisFilter,
} from '../api';
import { SAETZE, VOKABULARE, WOERTER } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_ENTSCHIEDEN_VON, UEMS_EINGETRAGEN_VON, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG, UEMS_VERZEICHNIS } from '../glossar';
import { useRollen } from '../rollen';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

const ALLE = '';

/**
 * Reiter „Verzeichnis“ (UEMS AP-19 IP-9, VZ1–VZ4, R3): der Leser `GET /api/v1/energiemanagement/verzeichnis` in elf
 * Gruppen, je Zeile Kennzeichen, Fassung oder Nr., „entschieden von“, „eingetragen von“, Tag, Prüfsumme und Ort — und
 * je leerer Gruppe „Hier ist noch nichts festgehalten.“ mit ihren Zeilen des Zuschnitts. Keine Zahl über das Ganze,
 * kein „fehlt“ (G4). Filter nach Gruppe, Tag und Person; „Als CSV abrufen“ holt dieselben Zeilen als Datei (KS2).
 * Eine Dokument-Zeile öffnet ihr Dokument. `saetze` zeigt Grenz- und Verantwortungs-Satz, wo die Tabelle allein steht.
 */
export function VerzeichnisTabelle({ onDokument, saetze = false }: { onDokument?: (id: string) => void; saetze?: boolean }) {
  const { selbst } = useRollen();
  const [filter, setFilter] = useState<Required<EnergiemanagementVerzeichnisFilter>>({ gruppe: ALLE, von: ALLE, bis: ALLE, person: ALLE });
  const [daten, setDaten] = useState<EnergiemanagementVerzeichnis | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [personen, setPersonen] = useState<EnergiemanagementPerson[]>([]);
  const [dokumente, setDokumente] = useState<EnergiemanagementDokumentKurz[]>([]);
  const [csvLaeuft, setCsvLaeuft] = useState(false);

  useEffect(() => {
    let aktiv = true;
    api.energiemanagementPersonen().then((r) => aktiv && setPersonen(r.personen), () => undefined);
    api.energiemanagementDokumente().then((r) => aktiv && setDokumente(r.dokumente), () => undefined);
    return () => {
      aktiv = false;
    };
  }, []);

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api.energiemanagementVerzeichnis(filter).then(
      (v) => aktiv && setDaten(v),
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [filter]);

  const ich = personen.find((p) => p.konto?.sub && p.konto.sub === selbst?.kennung) ?? null;
  const dokumentId = useMemo(() => new Map(dokumente.map((d) => [d.kennzeichen, d.id])), [dokumente]);
  const gruppenOptionen = [{ value: ALLE, label: 'alle Gruppen' }, ...VOKABULARE.verzeichnis_gruppe.map((g) => ({ value: g, label: WOERTER.verzeichnis_gruppe[g] }))];
  const personOptionen = [
    { value: ALLE, label: 'alle Personen' },
    ...personen.map((p) => ({ value: p.id, label: p.id === ich?.id ? `${p.name} — in meinem Namen` : p.name, sub: p.funktion })),
  ];
  const setze = (teil: Partial<EnergiemanagementVerzeichnisFilter>) => setFilter((alt) => ({ ...alt, ...teil }) as typeof alt);
  const zeilenZahl = daten ? daten.gruppen.reduce((n, g) => n + g.zeilen.length, 0) : 0;

  async function csv() {
    setCsvLaeuft(true);
    try {
      const datei = await api.energiemanagementVerzeichnisCsv(filter);
      const url = URL.createObjectURL(datei);
      const a = document.createElement('a');
      a.href = url;
      a.download = `verzeichnis-energiemanagement-${(daten?.stichtag ?? '').slice(0, 10) || 'abruf'}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      setFehler(E.ablehnungSatz(e));
    } finally {
      setCsvLaeuft(false);
    }
  }

  return (
    <section className="vp-ez-kopf" aria-label={UEMS_VERZEICHNIS} data-testid="verzeichnis">
      <div className="vp-em-filter">
        <VpPicker id="vz-gruppe" label="Gruppe" options={gruppenOptionen} value={filter.gruppe} onChange={(v) => setze({ gruppe: v })} />
        <VpDatePicker label="Tag von" value={filter.von || null} onChange={(v) => setze({ von: v })} max={filter.bis || undefined} />
        <VpDatePicker label="Tag bis" value={filter.bis || null} onChange={(v) => setze({ bis: v })} min={filter.von || undefined} />
        <VpPicker id="vz-person" label="Festgehalten im Namen von" options={personOptionen} value={filter.person} onChange={(v) => setze({ person: v })} />
        <Button variant="ghost" onClick={() => void csv()} disabled={csvLaeuft || !daten} data-testid="verzeichnis-csv">
          {E.KNOPF_CSV}
        </Button>
      </div>
      {daten && (
        <p className="vp-ez-leise" data-testid="verzeichnis-stichtag">
          Stand vom {E.tagText(daten.stichtag)}, {daten.stichtag.slice(11, 16)} Uhr
          {filter.person && filter.person === ich?.id ? ` · ${E.satzText('verzeichnis_filter', { anzahl: String(zeilenZahl) })}` : ''}
        </p>
      )}
      {fehler && (
        <p className="vp-ez-fehler" role="alert">
          {fehler}
        </p>
      )}
      {!daten && !fehler && <p className="vp-ez-leise">Wird geladen …</p>}
      {daten?.gruppen.map((g) => (
        <section key={g.gruppe} className="vp-ez-karte vp-em-gruppe" data-testid={`verzeichnis-gruppe-${g.gruppe}`}>
          <h2>{g.gruppe_wort}</h2>
          {g.zeilen.length === 0 ? (
            <>
              <p className="vp-ez-satz">{g.satz ?? SAETZE.verzeichnis_leer}</p>
              <ul className="vp-em-zuschnitt">
                {g.zuschnitt.map((z) => (
                  <li key={z.teil}>
                    {z.teil} — {z.stufe}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <table className="vp-ez-tafel">
              <thead>
                <tr>
                  <th scope="col" className="vp-em-eintrag">Eintrag</th>
                  <th scope="col">Fassung oder Nr.</th>
                  <th scope="col">{UEMS_ENTSCHIEDEN_VON}</th>
                  <th scope="col">{UEMS_EINGETRAGEN_VON}</th>
                  <th scope="col">Tag</th>
                  <th scope="col">Prüfsumme</th>
                  <th scope="col">Ort</th>
                </tr>
              </thead>
              <tbody>
                {g.zeilen.map((z, i) => {
                  const id = z.kennzeichen.startsWith('D-') ? dokumentId.get(z.kennzeichen) : undefined;
                  // Eine Aufgaben-Zeile trägt ihr Wort als Kennzeichen und im Titel („Leitung des Unternehmens: …“) — einmal genügt.
                  const text = z.titel.startsWith(z.kennzeichen) ? z.titel : `${z.kennzeichen} · ${z.titel}`;
                  return (
                    <tr key={`${z.kennzeichen}-${z.nr ?? ''}-${i}`} data-testid={`verzeichnis-zeile-${z.kennzeichen}`}>
                      <td className="vp-em-eintrag">
                        {id && onDokument ? (
                          <button type="button" className="vp-ez-zeile-knopf" onClick={() => onDokument(id)}>
                            {text}
                          </button>
                        ) : (
                          text
                        )}
                      </td>
                      <td data-label="Fassung oder Nr.">{z.nr ?? '—'}</td>
                      <td data-label={UEMS_ENTSCHIEDEN_VON}>{z.entschieden_von ?? '—'}</td>
                      <td data-label={UEMS_EINGETRAGEN_VON}>{z.eingetragen_von ?? '—'}</td>
                      <td data-label="Tag" className="vp-em-tag">{z.tag ? E.tagText(z.tag) : '—'}</td>
                      <td data-label="Prüfsumme" className="vp-ez-pruefsumme" title={z.pruefsumme ?? undefined}>
                        {z.pruefsumme ? E.kurz(z.pruefsumme) : '—'}
                      </td>
                      <td data-label="Ort">{z.ort_satz}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      ))}
      {saetze && (
        <div className="vp-em-saetze">
          <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
          <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
        </div>
      )}
    </section>
  );
}
