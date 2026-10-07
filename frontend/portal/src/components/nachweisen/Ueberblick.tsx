import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../designsystem/components/core/Icon';
import {
  api,
  type EnergiemanagementDokumentKurz,
  type EnergiemanagementTeilVermerk,
  type EnergiemanagementVerzeichnis,
} from '../../api';
import { sprungKlick, springeUeberHash, seitenSprung, type Sprung } from '../../entscheid';
import * as E from '../../energiemanagementPortal';
import { UEMS_KEINE_FRIST_UEBERFAELLIG, UEMS_WIEDERVORLAGE } from '../../glossar';
import { energiemanagementRoute, type Route } from '../../nav';
import { useRollen } from '../../rollen';
import { routenHeute } from '../../routenUhr';
import {
  DEMNAECHST,
  nachweisStand,
  offenWort,
  TEILE,
  TRIFFT_NICHT_ZU_KURZ,
  ueberfaelligWort,
  WIEDERVORLAGE_LINK,
  type NachweisStand,
  type TeilGruppe,
  type TeilStand,
  type TeilZustand,
} from '../../nachweisStand';
import type { Wiedervorlage } from '../../wiedervorlage';
import { FristDatum, Kennzeichentext } from '../FristDatum';
import { RowMenu } from '../RowMenu';
import { AlsNaechstes } from './AlsNaechstes';
import { ErklaerKnopf } from './ErklaerKnopf';
import { NACHWEIS, TEIL, nachweisBeiIhnen, teilBeiIhnen } from './nachweisBegriffe';
import { NwKopf } from './NwKopf';
import { NwZeichen, NwZeichenLegende, ZaehlerChip, type ZeichenArt } from './NwZeichen';
import { PruefungVonAussen } from './PruefungVonAussen';
import { FristenBlatt, GruppenBlatt, TeilBlatt } from './UeberblickBlaetter';
import './Nachweisen.css';

export const UEBERBLICK_LADEFEHLER = 'Der Überblick ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
export const ERNEUT_VERSUCHEN = 'Erneut versuchen';
export const MENUE_VERZEICHNIS = 'Verzeichnis';
export const MENUE_CSV = 'Verzeichnis als CSV';
export const MENUE_ZUSCHNITT = 'Was VoltPilot führt';

const ZEICHEN: Record<TeilZustand, ZeichenArt> = { festgehalten: 'festgehalten', offen: 'offen', entwurf: 'entwurf', ueber: 'ueber' };

type Daten = {
  verzeichnis: EnergiemanagementVerzeichnis;
  dokumente: EnergiemanagementDokumentKurz[];
  wiedervorlage: Wiedervorlage | null;
  vermerke: EnergiemanagementTeilVermerk[];
};

/**
 * Der Überblick von Nachweisen (Konzept Nachweisen n1, Runde 2, §6.3, Entscheide 2 bis 5): der erste Reiter der Gruppe.
 * Die Antwort steht als Zahl und Zeichen da - zwei Zähler-Chips („4 Teile offen“, „6 Fristen überfällig“), genau ein
 * nächster Schritt, die 18 Teile als Zeichen-Reihe je Gruppe mit den Teilen, die etwas brauchen, als Chips; die Fakten
 * je Teil stehen im Blatt der Gruppe. „Demnächst“ zeigt die nächsten Fristen aus Nachweisen. Kein Urteil über das Ganze
 * (G4); gezählt wird nur Offenes und Überfälliges (Entscheid 3). Am Rechner dieselbe Antwort in zwei Spalten, alle
 * Teile als Chips (§6.11).
 *
 * Gelesen wird aus vier Routen (Entscheid 4), abgeleitet in `nachweisStand.ts`. Ohne Wiedervorlage (Ladefehler) gibt es
 * keine Fristen - nichts wird geraten.
 */
export function Ueberblick({
  onNavigate,
  springe = springeUeberHash,
}: {
  onNavigate: (r: Route) => void;
  springe?: (s: Sprung) => void;
}) {
  const rollen = useRollen();
  // Festhalten verspricht nur, wer das Energiemanagement bearbeitet; „Einsicht“ und Leser sehen den Stand ohne Knopf.
  const darfFesthalten = rollen.darf(E.RECHT_VERWALTEN, null);
  const [daten, setDaten] = useState<Daten | null>(null);
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  // Ein Blatt behält seinen Inhalt, solange es ausblendet: offen/zu und welches getrennt.
  const [gruppeKey, setGruppeKey] = useState<TeilGruppe['key'] | null>(null);
  const [gruppeOffen, setGruppeOffen] = useState(false);
  const [fristen, setFristen] = useState(false);
  const [teilKey, setTeilKey] = useState<string | null>(null);
  const [teilOffen, setTeilOffen] = useState(false);
  const teileRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let aktiv = true;
    setFehler(false);
    Promise.all([
      api.energiemanagementVerzeichnis(),
      api.energiemanagementDokumente(),
      api.energiemanagementWiedervorlage().catch(() => null),
      api.energiemanagementTeilVermerke().catch(() => ({ stichtag: '', vermerke: [] })),
    ]).then(
      ([verzeichnis, dokumente, wiedervorlage, vermerke]) =>
        aktiv && setDaten({ verzeichnis, dokumente: dokumente.dokumente, wiedervorlage, vermerke: vermerke.vermerke }),
      () => aktiv && setFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  const stand: NachweisStand | null = useMemo(() => (daten ? nachweisStand(daten) : null), [daten]);
  const neu = () => setVersuch((v) => v + 1);

  // Ein Blatt zeigt den Teil mit dem Stand von jetzt (nach einem Vermerk neu geladen).
  const teilJetzt = teilKey && stand ? (stand.teile.find((t) => t.teil === teilKey) ?? null) : null;
  const gruppeJetzt = gruppeKey && stand ? (stand.gruppen.find((g) => g.key === gruppeKey) ?? null) : null;
  const zeigeTeil = (t: TeilStand) => {
    setTeilKey(t.teil);
    setTeilOffen(true);
  };

  const menue = (
    <RowMenu
      label="Weitere Aktionen"
      buttonClassName="vp-wv-menue-knopf"
      items={[
        { label: MENUE_VERZEICHNIS, icon: 'list', onClick: () => onNavigate(energiemanagementRoute('verzeichnis')) },
        { label: MENUE_CSV, icon: 'file-text', onClick: () => void verzeichnisCsv() },
        { label: MENUE_ZUSCHNITT, icon: 'info', onClick: () => onNavigate(energiemanagementRoute('zuschnitt')) },
      ]}
    />
  );

  const oeffneTeil = (t: TeilStand) => {
    if (t.zustand === 'ueber' && t.fristSprung) return springe(t.fristSprung);
    if (t.zustand === 'offen' || (t.vermerk && t.zustand === 'festgehalten' && t.fakt === TRIFFT_NICHT_ZU_KURZ)) return zeigeTeil(t);
    onNavigate(t.ort);
  };

  return (
    <div className="vp-nw-ueberblick" data-testid="nachweisen-ueberblick">
      <NwKopf
        titel={E.UEBERBLICK}
        erklaerung={{ ...NACHWEIS, beiIhnen: daten ? nachweisBeiIhnen(daten.verzeichnis) : null }}
        kurzzeile={stand ? `Stand ${stand.stand}` : undefined}
        menue={menue}
        testId="ueberblick-kopf"
      />
      {fehler ? (
        <section className="vp-wv-karte is-fehler" role="alert" data-testid="ueberblick-fehler">
          <p className="vp-wv-leise">{UEBERBLICK_LADEFEHLER}</p>
          <button type="button" className="vp-wv-link" onClick={neu}>
            {ERNEUT_VERSUCHEN}
          </button>
        </section>
      ) : !stand ? (
        <div className="vp-nw-skelett" aria-busy="true" aria-label="Wird geladen" data-testid="ueberblick-laedt">
          <span className="vp-skeleton is-zeile" />
          <span className="vp-skeleton is-karte" />
          <span className="vp-skeleton is-karte" />
        </div>
      ) : (
        <div className="vp-nw-ub-raster">
          <div className="vp-nw-ub-links">
            <div className="vp-nw-zchips" data-testid="ueberblick-zaehler">
              {stand.offen > 0 && (
                <ZaehlerChip
                  anzahl={stand.offen}
                  wort={offenWort(stand.offen)}
                  zeichen="offen"
                  onClick={() => teileRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  testId="zaehler-offen"
                />
              )}
              {stand.ueberfaellig.length > 0 ? (
                <ZaehlerChip
                  anzahl={stand.ueberfaellig.length}
                  wort={ueberfaelligWort(stand.ueberfaellig.length)}
                  zeichen="ueber"
                  ton="warn"
                  onClick={() => setFristen(true)}
                  blatt
                  testId="zaehler-ueberfaellig"
                />
              ) : (
                daten?.wiedervorlage && (
                  <span className="vp-nw-zchip is-still" data-testid="zaehler-ruhig">
                    <Icon name="check" size={15} />
                    {UEMS_KEINE_FRIST_UEBERFAELLIG}
                  </span>
                )
              )}
            </div>
            {stand.naechstes && (
              <AlsNaechstes
                testId="ueberblick-naechstes"
                frist={stand.naechstes.art === 'frist' ? { ...stand.naechstes.eintrag.frist, ton: 'ueber' } : null}
                titel={<Kennzeichentext text={stand.naechstes.titel} />}
                knopf={
                  stand.naechstes.art === 'festhalten' && !darfFesthalten
                    ? null
                    : {
                        label: stand.naechstes.knopf,
                        onClick: () => {
                          const n = stand.naechstes!;
                          if (n.art === 'festhalten') zeigeTeil(n.teil);
                          else if (n.sprung) springe(n.sprung);
                        },
                      }
                }
              />
            )}
          </div>
          <section className="vp-nw-karte vp-nw-ub-demnaechst" aria-labelledby="vp-nw-demnaechst" data-testid="ueberblick-demnaechst">
            <div className="vp-nw-blockkopf">
              <h2 id="vp-nw-demnaechst">{DEMNAECHST}</h2>
              <a
                className="vp-nw-link"
                href={seitenSprung(energiemanagementRoute('wiedervorlage')).hash}
                onClick={sprungKlick(seitenSprung(energiemanagementRoute('wiedervorlage')), springe)}
              >
                <span className="vp-nw-nur-telefon">{WIEDERVORLAGE_LINK}</span>
                <span className="vp-nw-nur-rechner">{UEMS_WIEDERVORLAGE}</span>
              </a>
            </div>
            {stand.demnaechst.length === 0 ? (
              <p className="vp-nw-leise" data-testid="demnaechst-leer">
                {daten?.wiedervorlage ? 'Keine Frist in Sicht.' : 'Die Fristen ließen sich gerade nicht laden.'}
              </p>
            ) : (
              <ul className="vp-fzl vp-nw-demnaechst">
                {stand.demnaechst.slice(0, 4).map((x) => {
                  const inhalt = (
                    <>
                      <FristDatum {...x.frist} ton="bald" />
                      <span className="vp-fz-text">
                        <span className="vp-fz-titel">
                          <Kennzeichentext text={x.aufgabe} />
                        </span>
                      </span>
                      {x.zustaendig && (
                        <span className="vp-nw-kuerzel" title={x.zustaendig.name} aria-label={x.zustaendig.name}>
                          {kuerzel(x.zustaendig.name)}
                        </span>
                      )}
                      <span className="vp-fz-chev" aria-hidden="true">
                        <Icon name="chevron-right" size={18} />
                      </span>
                    </>
                  );
                  return (
                    <li key={x.key}>
                      {x.sprung ? (
                        <a className="vp-fz" href={x.sprung.hash} onClick={sprungKlick(x.sprung, springe)} data-testid={`demnaechst-${x.key}`}>
                          {inhalt}
                        </a>
                      ) : (
                        <div className="vp-fz">{inhalt}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {/* PR 6 (Entscheide 7 und 8): Unterlagen zusammenstellen und Einsicht geben, nach „Demnächst“. */}
          <PruefungVonAussen
            heute={daten?.verzeichnis.stichtag.slice(0, 10) ?? routenHeute()}
            verzeichnis={daten?.verzeichnis ?? null}
            offen={stand.teile.filter((t) => t.zustand === 'offen').map((t) => t.teil)}
            onNavigate={onNavigate}
          />
          <section ref={teileRef} className="vp-nw-karte vp-nw-ub-teile" aria-labelledby="vp-nw-teile" data-testid="ueberblick-teile">
            <div className="vp-nw-blockkopf">
              <h2 id="vp-nw-teile">
                {TEILE}
                <ErklaerKnopf erklaerung={{ ...TEIL, beiIhnen: teilBeiIhnen(stand) }} klein testId="teile-erklaeren" />
              </h2>
            </div>
            <div className="vp-nw-tgl">
              {stand.gruppen.map((g) => (
                <div key={g.key} className="vp-nw-tg" data-testid={`teile-gruppe-${g.key}`}>
                  <button
                    type="button"
                    className="vp-nw-tg-kopf"
                    aria-haspopup="dialog"
                    aria-label={`${g.wort}: ${gruppenSatz(g)}`}
                    onClick={() => {
                      setGruppeKey(g.key);
                      setGruppeOffen(true);
                    }}
                  >
                    <span className="vp-nw-tg-name">{g.wort}</span>
                    <span className="vp-nw-tg-reihe" aria-hidden="true">
                      {g.teile.map((t) => (
                        <NwZeichen key={t.teil} art={ZEICHEN[t.zustand]} stumm />
                      ))}
                    </span>
                    <span className="vp-nw-tg-chev" aria-hidden="true">
                      <Icon name="chevron-right" size={16} />
                    </span>
                  </button>
                  <TeilChips gruppe={g} onTeil={oeffneTeil} />
                </div>
              ))}
            </div>
            <NwZeichenLegende arten={legende(stand)} />
          </section>
        </div>
      )}
      {gruppeJetzt && (
        <GruppenBlatt
          gruppe={gruppeJetzt}
          offen={gruppeOffen}
          darfFesthalten={darfFesthalten}
          onClose={() => setGruppeOffen(false)}
          onTeil={(t) => {
            setGruppeOffen(false);
            oeffneTeil(t);
          }}
        />
      )}
      {stand && (
        <FristenBlatt
          offen={fristen}
          eintraege={stand.ueberfaellig}
          onClose={() => setFristen(false)}
          springe={(s) => {
            setFristen(false);
            springe(s);
          }}
        />
      )}
      {teilJetzt && stand && (
        <TeilBlatt
          teil={teilJetzt}
          offen={teilOffen}
          heute={stand.stand}
          onClose={() => setTeilOffen(false)}
          onNavigate={(r) => {
            setTeilOffen(false);
            onNavigate(r);
          }}
          onGeaendert={neu}
        />
      )}
    </div>
  );

  async function verzeichnisCsv() {
    try {
      const datei = await api.energiemanagementVerzeichnisCsv({});
      const url = URL.createObjectURL(datei);
      const a = document.createElement('a');
      a.href = url;
      a.download = `verzeichnis-energiemanagement-${(daten?.verzeichnis.stichtag ?? '').slice(0, 10) || 'abruf'}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setFehler(true);
    }
  }
}

/** Die Chips einer Gruppe: am Telefon nur Teile, die etwas brauchen; am Rechner alle (die festgehaltenen still, §6.11). */
function TeilChips({ gruppe, onTeil }: { gruppe: TeilGruppe; onTeil: (t: TeilStand) => void }) {
  return (
    <span className="vp-nw-tg-chips">
      {gruppe.teile.map((t) => (
        <button
          key={t.teil}
          type="button"
          className={`vp-nw-lchip is-${t.zustand}`}
          onClick={() => onTeil(t)}
          data-testid={`teil-chip-${t.teil}`}
        >
          <NwZeichen art={ZEICHEN[t.zustand]} />
          {t.kurz}
          {t.ueberfaellig.length > 1 && <span className="vp-nw-lchip-n">{t.ueberfaellig.length}</span>}
        </button>
      ))}
    </span>
  );
}

/** Für Vorleser: was die Zeichen-Reihe einer Gruppe zeigt, ohne Zahl über das Ganze. */
function gruppenSatz(g: TeilGruppe): string {
  const offen = g.teile.filter((t) => t.zustand !== 'festgehalten').map((t) => `${t.kurz} ${t.zustand === 'offen' ? 'offen' : t.zustand === 'ueber' ? 'überfällig' : 'Entwurf wartet'}`);
  return offen.length === 0 ? 'nichts offen' : offen.join(', ');
}

function legende(s: NachweisStand): ZeichenArt[] {
  const da = new Set(s.teile.map((t) => ZEICHEN[t.zustand]));
  return (['festgehalten', 'offen', 'entwurf', 'ueber'] as const).filter((a) => da.has(a));
}

/** Das Kürzel einer Person: „Ines Kaltenbach“ → „IK“, ein Name aus einem Wort → seine ersten zwei Buchstaben. */
export function kuerzel(name: string): string {
  const w = name.trim().split(/\s+/u).filter(Boolean);
  if (w.length === 0) return '';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return `${w[0][0]}${w[w.length - 1][0]}`.toUpperCase();
}
