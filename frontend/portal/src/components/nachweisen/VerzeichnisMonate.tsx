import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import {
  api,
  type EnergiemanagementDokumentKurz,
  type EnergiemanagementPerson,
  type EnergiemanagementVerzeichnis,
  type EnergiemanagementVerzeichnisFilter,
  type EnergiemanagementVerzeichnisZeile,
} from '../../api';
import { VOKABULARE, WOERTER } from '../../energiemanagement';
import * as E from '../../energiemanagementPortal';
import { UEMS_ENTSCHIEDEN_VON, UEMS_EINGETRAGEN_VON, UEMS_VERZEICHNIS } from '../../glossar';
import { useRollen } from '../../rollen';
import {
  eintraegeZahl,
  eintragTitel,
  tagBlock,
  tagVoll,
  verzeichnisMonate,
  type VerzeichnisEintrag,
} from '../../verzeichnisMonate';
import { GrenzSatz } from '../GrenzSatz';
import { RowMenu } from '../RowMenu';
import { VpDatePicker } from '../VpDatePicker';
import { VERZEICHNIS, verzeichnisBeiIhnen } from './nachweisBegriffe';
import { NwBlatt } from './NwBlatt';
import { NwKopf } from './NwKopf';
import { AntwortKarten, PruefZeilen } from './NwSchritte';
import { CSV_FEHLER, ERNEUT_VERSUCHEN, kuerzel } from './Ueberblick';
import './Nachweisen.css';

export const SUCHEN = 'Suchen';
export const ALLE = 'Alle';
export const MEINE = 'Meine';
export const THEMA = 'Thema';
export const ZEITRAUM = 'Zeitraum';
export const NICHTS_GEFUNDEN = 'Kein Eintrag passt dazu.';
export const NOCH_KEIN_EINTRAG = 'Noch ist nichts festgehalten.';
export const VERZEICHNIS_LADEFEHLER = 'Das Verzeichnis ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
export const ZURUECK_UEBERBLICK = 'Überblick';
export const DOKUMENT_OEFFNEN = 'Dokument öffnen';
export const FERTIG = 'Fertig';

type Filter = Required<EnergiemanagementVerzeichnisFilter>;
const LEER: Filter = { gruppe: null, von: null, bis: null, person: null };

/**
 * Das Verzeichnis eine Ebene unter dem Überblick (Konzept Nachweisen n1, Runde 2, §6.9; `#/portfolio/energiemanagement/
 * verzeichnis`): eine Zeitleiste nach Monaten, je Zeile Datumsblock, Titel und das Kürzel der Person, die entschieden
 * hat; Gleichartiges vom selben Tag ist eine Zeile. Suche, „Meine“, Thema (die Gruppe des Vertrags) und Zeitraum filtern
 * - Thema ist ein Filter statt der Gliederung. Ein Antippen öffnet den Eintrag mit Prüfsumme, wer eingetragen hat und dem
 * Ort des Originals. Am Rechner steht das Kennzeichen als leise Spalte (Entscheid 25), die CSV im Menü.
 */
export function VerzeichnisMonate({
  onDokument,
  onUeberblick,
}: {
  onDokument: (id: string) => void;
  onUeberblick: () => void;
}) {
  const { selbst } = useRollen();
  const [filter, setFilter] = useState<Filter>(LEER);
  const [suche, setSuche] = useState('');
  const [daten, setDaten] = useState<EnergiemanagementVerzeichnis | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [csvFehler, setCsvFehler] = useState<string | null>(null);
  // Eine Pfeiltaste wählt im Thema-Blatt nur aus; schließen tut erst ein Antippen, Leertaste oder „Fertig“ (P1-7).
  const perPfeil = useRef(false);
  const [personen, setPersonen] = useState<EnergiemanagementPerson[]>([]);
  const [dokumente, setDokumente] = useState<EnergiemanagementDokumentKurz[]>([]);
  const [eintrag, setEintrag] = useState<VerzeichnisEintrag | null>(null);
  const [eintragOffen, setEintragOffen] = useState(false);
  const [zeile, setZeile] = useState<EnergiemanagementVerzeichnisZeile | null>(null);
  const [blatt, setBlatt] = useState<'thema' | 'zeitraum' | null>(null);
  const [versuch, setVersuch] = useState(0);

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
      (e) => aktiv && setFehler(E.ablehnungSatz(e) ?? VERZEICHNIS_LADEFEHLER),
    );
    return () => {
      aktiv = false;
    };
  }, [filter, versuch]);

  const ich = personen.find((p) => p.konto?.sub && p.konto.sub === selbst?.kennung) ?? null;
  const monate = useMemo(() => (daten ? verzeichnisMonate(daten, suche) : []), [daten, suche]);
  const dokumentId = useMemo(() => new Map(dokumente.map((d) => [d.kennzeichen, d.id])), [dokumente]);
  const kuerzelVon = (name: string | null) => (name ? (personen.find((p) => p.name === name)?.kuerzel ?? kuerzel(name)) : null);
  const setze = (t: Partial<Filter>) => setFilter((alt) => ({ ...alt, ...t }));
  const filterAktiv = filter.gruppe !== null || filter.von !== null || filter.bis !== null || filter.person !== null;
  const abrufTag = daten?.stichtag ? daten.stichtag.slice(0, 10) : null;

  // Ein Fehler der CSV steht als eigene Zeile da und versucht die CSV erneut - das Verzeichnis bleibt (P1-6).
  async function csv() {
    setCsvFehler(null);
    try {
      const datei = await api.energiemanagementVerzeichnisCsv(filter);
      const url = URL.createObjectURL(datei);
      const a = document.createElement('a');
      a.href = url;
      a.download = `verzeichnis-energiemanagement-${(daten?.stichtag ?? '').slice(0, 10) || 'abruf'}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      // Eine Ablehnung des Servers nennt ihren Grund; ein Netz- oder Serverfehler ohne Code den Satz der Familie.
      setCsvFehler(E.ablehnungCode(e) ? E.ablehnungSatz(e) : CSV_FEHLER);
    }
  }

  const oeffne = (e: VerzeichnisEintrag) => {
    setEintrag(e);
    setZeile(e.zeilen.length === 1 ? e.zeilen[0] : null);
    setEintragOffen(true);
  };

  return (
    <div className="vp-nw-verzeichnis" data-testid="verzeichnis">
      <NwKopf
        titel={UEMS_VERZEICHNIS}
        erklaerung={{ ...VERZEICHNIS, beiIhnen: daten ? verzeichnisBeiIhnen(daten) : null }}
        kurzzeile={daten ? eintraegeZahl(daten) : undefined}
        zurueck={{ label: ZURUECK_UEBERBLICK, onClick: onUeberblick }}
        menue={
          <RowMenu
            label="Weitere Aktionen"
            buttonClassName="vp-wv-menue-knopf"
            items={[{ label: E.KNOPF_CSV, icon: 'file-text', onClick: () => void csv() }]}
          />
        }
        testId="verzeichnis-kopf"
      />
      <label className="vp-nw-suche">
        <Icon name="search" size={18} />
        <span className="vp-nw-unsichtbar">{SUCHEN}</span>
        <input type="search" placeholder={SUCHEN} value={suche} onChange={(ev) => setSuche(ev.target.value)} data-testid="verzeichnis-suche" />
      </label>
      <div className="vp-nw-filter" role="group" aria-label="Filter" data-testid="verzeichnis-filter">
        <button type="button" className="vp-wv-chip" aria-pressed={!filterAktiv} onClick={() => setFilter(LEER)}>
          {ALLE}
        </button>
        {ich && (
          <button type="button" className="vp-wv-chip" aria-pressed={filter.person === ich.id} onClick={() => setze({ person: filter.person === ich.id ? null : ich.id })}>
            {MEINE}
          </button>
        )}
        <button type="button" className="vp-wv-chip" aria-pressed={filter.gruppe !== null} aria-haspopup="dialog" onClick={() => setBlatt('thema')}>
          {filter.gruppe ? WOERTER.verzeichnis_gruppe[filter.gruppe] : THEMA}
        </button>
        <button type="button" className="vp-wv-chip" aria-pressed={filter.von !== null || filter.bis !== null} aria-haspopup="dialog" onClick={() => setBlatt('zeitraum')}>
          {filter.von || filter.bis ? zeitraumText(filter) : ZEITRAUM}
        </button>
      </div>
      {csvFehler && (
        <section className="vp-wv-karte is-fehler" role="alert" data-testid="verzeichnis-csv-fehler">
          <p className="vp-wv-leise">{csvFehler}</p>
          <button type="button" className="vp-wv-link" onClick={() => void csv()}>
            {ERNEUT_VERSUCHEN}
          </button>
        </section>
      )}
      {fehler ? (
        <section className="vp-wv-karte is-fehler" role="alert">
          <p className="vp-wv-leise">{fehler}</p>
          <button type="button" className="vp-wv-link" onClick={() => setVersuch((v) => v + 1)}>
            {ERNEUT_VERSUCHEN}
          </button>
        </section>
      ) : !daten ? (
        <div className="vp-nw-skelett" aria-busy="true" aria-label="Wird geladen">
          <span className="vp-skeleton is-zeile" />
          <span className="vp-skeleton is-karte" />
        </div>
      ) : monate.length === 0 ? (
        <p className="vp-nw-leise" data-testid="verzeichnis-leer">
          {suche || filterAktiv ? NICHTS_GEFUNDEN : NOCH_KEIN_EINTRAG}
        </p>
      ) : (
        monate.map((m) => (
          <section key={m.key} className="vp-nw-monat" aria-labelledby={`vz-${m.key}`} data-testid={`verzeichnis-monat-${m.key}`}>
            <h2 id={`vz-${m.key}`} className="vp-nw-monat-titel">
              {m.titel}
            </h2>
            <ul className="vp-nw-vzl">
              {m.eintraege.map((e) => {
                const kz = kuerzelVon(e.person);
                return (
                  <li key={e.key}>
                    <button type="button" className="vp-nw-vz" onClick={() => oeffne(e)} aria-haspopup="dialog" data-testid="verzeichnis-eintrag">
                      <span className={`vp-fd vp-nw-tagblock${e.unter ? '' : ' is-erledigt'}`} aria-hidden="true">
                        <b>{e.tag ? tagBlock(e.tag) : '-'}</b>
                      </span>
                      <span className="vp-nw-vz-text">
                        <span className="vp-nw-vz-titel">{e.titel}</span>
                        {e.unter && <span className="vp-nw-vz-unter">{e.unter}</span>}
                      </span>
                      <span className="vp-nw-vz-kz">{kennzeichenSpalte(e)}</span>
                      {kz && (
                        <span className="vp-nw-kuerzel is-immer" title={e.person ?? undefined}>
                          {kz}
                        </span>
                      )}
                      <span className="vp-nw-vz-chev" aria-hidden="true">
                        <Icon name="chevron-right" size={16} />
                      </span>
                      <span className="vp-nw-unsichtbar">{e.tag ? tagVoll(e.tag) : ''}{e.person ? `, ${e.person}` : ''}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
      <GrenzSatz className="vp-ez-grenze" verantwortung />
      {eintrag && (
        <NwBlatt
          open={eintragOffen}
          titel={zeile ? eintragTitel(zeile) : eintrag.titel}
          onClose={() => setEintragOffen(false)}
          testId="eintrag-blatt"
        >
          {zeile ? (
            <EintragDetail
              zeile={zeile}
              dokumentId={dokumentId.get(zeile.kennzeichen) ?? null}
              onDokument={(id) => {
                setEintragOffen(false);
                onDokument(id);
              }}
              onZurueck={eintrag.zeilen.length > 1 ? () => setZeile(null) : null}
            />
          ) : (
            <ul className="vp-nw-tzl">
              {eintrag.zeilen.map((z, i) => (
                <li key={`${z.kennzeichen}-${z.nr ?? ''}-${i}`}>
                  <button type="button" className="vp-nw-tz" onClick={() => setZeile(z)}>
                    <span className="vp-nw-tz-name">{eintragTitel(z)}</span>
                    {z.nr !== null && <span className="vp-nw-tz-fakt">{`Fassung ${z.nr}`}</span>}
                    <span className="vp-nw-tz-chev" aria-hidden="true">
                      <Icon name="chevron-right" size={16} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </NwBlatt>
      )}
      <NwBlatt
        open={blatt === 'thema'}
        titel={THEMA}
        onClose={() => setBlatt(null)}
        testId="thema-blatt"
        fuss={
          <Button fullWidth onClick={() => setBlatt(null)}>
            {FERTIG}
          </Button>
        }
      >
        <div
          onKeyDownCapture={(ev) => {
            perPfeil.current = ev.key.startsWith('Arrow');
          }}
          onPointerDownCapture={() => {
            perPfeil.current = false;
          }}
        >
          <AntwortKarten
            label={THEMA}
            optionen={[{ wert: '', titel: 'Alle Themen' }, ...VOKABULARE.verzeichnis_gruppe.map((g) => ({ wert: g, titel: WOERTER.verzeichnis_gruppe[g] }))]}
            wert={filter.gruppe ?? ''}
            onWahl={(g) => {
              setze({ gruppe: g || null });
              // Die Pfeiltaste wandert durch die Themen (der Filter folgt), das Blatt bleibt offen.
              if (!perPfeil.current) setBlatt(null);
              perPfeil.current = false;
            }}
            testid="thema-wahl"
          />
        </div>
      </NwBlatt>
      <NwBlatt
        open={blatt === 'zeitraum'}
        titel={ZEITRAUM}
        onClose={() => setBlatt(null)}
        testId="zeitraum-blatt"
        fuss={
          <Button fullWidth onClick={() => setBlatt(null)}>
            {FERTIG}
          </Button>
        }
      >
        {/* Der Kalender öffnet am Tag des Abrufs (der Bühne), nicht am Tag des Browsers (P1-8). */}
        <VpDatePicker label="Von" value={filter.von} onChange={(v) => setze({ von: v })} max={filter.bis ?? undefined} heute={abrufTag} />
        <VpDatePicker label="Bis" value={filter.bis} onChange={(v) => setze({ bis: v })} min={filter.von ?? undefined} heute={abrufTag} />
        {(filter.von || filter.bis) && (
          <button type="button" className="vp-nw-link" onClick={() => setze({ von: null, bis: null })}>
            Zeitraum löschen
          </button>
        )}
      </NwBlatt>
    </div>
  );
}

/**
 * Das Kennzeichen als leise Spalte am Rechner (Entscheid 25) - nur, wo es etwas sagt, was der Titel nicht schon trägt
 * (eine Aufgabe nennt ihr Wort als Kennzeichen und im Titel).
 */
function kennzeichenSpalte(e: VerzeichnisEintrag): string {
  if (e.zeilen.length !== 1) return '';
  const z = e.zeilen[0];
  return z.titel.startsWith(z.kennzeichen) || e.titel.startsWith(z.kennzeichen) ? '' : z.kennzeichen;
}

function zeitraumText(f: Filter): string {
  if (f.von && f.bis) return `${tagVoll(f.von)} bis ${tagVoll(f.bis)}`;
  if (f.von) return `ab ${tagVoll(f.von)}`;
  return `bis ${tagVoll(f.bis ?? '')}`;
}

/** Ein Eintrag im Ganzen: Thema, Kennzeichen, Fassung, wer entschieden und wer eingetragen hat, Tag, Ort, Prüfsumme. */
function EintragDetail({
  zeile: z,
  dokumentId,
  onDokument,
  onZurueck,
}: {
  zeile: EnergiemanagementVerzeichnisZeile;
  dokumentId: string | null;
  onDokument: (id: string) => void;
  onZurueck: (() => void) | null;
}) {
  return (
    <>
      {onZurueck && (
        <button type="button" className="vp-nw-zurueck" onClick={onZurueck}>
          <Icon name="chevron-left" size={16} />
          Alle Einträge
        </button>
      )}
      <PruefZeilen
        testid="eintrag-angaben"
        zeilen={[
          { etikett: THEMA, wert: z.gruppe_wort },
          { etikett: 'Kennzeichen', wert: z.kennzeichen },
          ...(z.nr !== null ? [{ etikett: 'Fassung oder Nr.', wert: String(z.nr) }] : []),
          ...(z.entschieden_von ? [{ etikett: UEMS_ENTSCHIEDEN_VON, wert: z.entschieden_von }] : []),
          ...(z.eingetragen_von ? [{ etikett: UEMS_EINGETRAGEN_VON, wert: z.eingetragen_von }] : []),
          ...(z.tag ? [{ etikett: 'Tag', wert: tagVoll(z.tag) }] : []),
          { etikett: 'Ort', wert: z.ort_satz },
          ...(z.pruefsumme ? [{ etikett: 'Prüfsumme', wert: <span className="vp-nw-pruefsumme">{z.pruefsumme}</span> }] : []),
        ]}
      />
      {dokumentId && (
        <Button variant="outline" onClick={() => onDokument(dokumentId)}>
          {DOKUMENT_OEFFNEN}
        </Button>
      )}
    </>
  );
}

