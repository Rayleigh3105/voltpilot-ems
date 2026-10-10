import type { ReactNode } from 'react';
import { GrenzSatz } from './GrenzSatz';
import * as M from '../managementbewertung';
import { beschlussZustand, jahre } from '../managementbewertungBild';
import { Fakt, NwZeile, NwZeilen, Unterkopf } from './nachweisen/NwZeilen';

/**
 * Die Eingaben einer Managementbewertung (UEMS AP-19 IP-24, MG2): die Abschnitte der Vorlage in ihrer Reihenfolge, genau
 * so, wie der Abzug sie festhält - das Ergebnis wie festgehalten, Kennzeichen und Prüfsumme im Tooltip; nichts wird neu
 * gerechnet oder beurteilt. Seit Konzept Nachweisen n1 (Runde 2, PR 5) ein Abschnitt je Blatt („Was die Leitung sah“),
 * je Gegenstand eine Zeile. Derselbe Baustein zeigt den Entwurf (die Eingaben von heute) und einen Stand (die Eingaben
 * seines Tages). Sitzung und Beschlüsse füllt, wer das Energiemanagement bearbeitet (`beschluesse`, `sitzung` als Kinder).
 * `saetze` zeigt Grenz- und Verantwortungs-Satz, wo der Baustein allein steht (auf der Seite stehen sie am Fuß).
 */
export function ManagementbewertungEingaben({
  abzug,
  beschluesse,
  sitzung,
  ohne = [],
  nur,
  saetze = false,
}: {
  abzug: M.MbAbzug;
  beschluesse?: ReactNode;
  sitzung?: ReactNode;
  /** Abschnitte, die die Seite an anderer Stelle zeigt (Sitzung und Beschlüsse über den Eingaben). */
  ohne?: readonly string[];
  /** Nur dieser Abschnitt, ohne eigene Überschrift (Konzept Nachweisen n1: im Blatt „Was die Leitung sah“ trägt das Blatt sie). */
  nur?: string;
  saetze?: boolean;
}) {
  const a = abzug;
  return (
    <div className="vp-mb-eingaben" data-testid="mb-eingaben">
      {M.ABSCHNITTE.filter(({ key }) => (nur ? key === nur : !ohne.includes(key))).map(({ key, titel }) => (
        <section key={key} className="vp-mb-abschnitt" aria-label={titel} data-testid={`mb-abschnitt-${key}`}>
          {!nur && <h3>{titel}</h3>}
          {key === 'vorige_beschluesse' ? (
            <Vorige a={a} />
          ) : key === 'grundlagen' ? (
            <Grundlagen a={a} />
          ) : key === 'energieziele' ? (
            <Liste leer={M.LEER.energieziele} zeilen={(a.energieziele ?? []).map((e) => ({
              key: e.kennzeichen,
              titel: `${e.kennzeichen} · Energieziel ${jahre(e.zielperiode)}: ${M.prozent(e.zielwert_prozent)}`,
              zustand: M.zustandWort(e.zustand),
              // Ein Fakt: das Ergebnis wie festgehalten; wer und wann steht im PDF.
              text: [e.ergebnis ? M.ergebnisWort(e.ergebnis) : null, e.stand ? `${M.prozent(e.stand.delta_prozent)} in ${e.stand.monate} Monaten` : null].filter(Boolean).join(' · ') || 'noch ohne Ergebnis',
              pruefsumme: e.pruefsumme,
            }))} />
          ) : key === 'energieleistung' ? (
            <>
              <Liste leer={M.LEER.leistungsvergleiche} zeilen={(a.energieleistung?.leistungsvergleiche ?? []).map((v) => ({
                key: v.kennung,
                titel: `${v.kennung} · Leistungsvergleich ${v.zeitraum}`,
                zustand: `Stand Nr. ${v.stand}${v.freigegeben_am ? ` vom ${M.tag(v.freigegeben_am)}` : ''}`,
                text: [M.leistungsvergleichZeile(v), ...v.anstoesse_offen.map((x) => `Revision angestoßen: ${x.anlass}`)].join(' · '),
                pruefsumme: v.pruefsumme,
              }))} />
              <Liste leer={M.LEER.bezugsbasen} zeilen={(a.energieleistung?.bezugsbasen ?? []).map((b) => ({
                key: b.kennzeichen,
                titel: `${b.kennzeichen} · ${b.titel}`,
                text: M.fristZeile(b.ueberpruefung) ?? '—',
              }))} />
            </>
          ) : key === 'massnahmen' ? (
            <Liste leer={M.LEER.massnahmen} zeilen={(a.massnahmen ?? []).map((m) => ({
              key: m.kennzeichen,
              titel: `${m.kennzeichen} · ${m.titel}`,
              zustand: M.zustandWort(m.zustand),
              // Ein Fakt: das Ergebnis der Bewertung („belegt · 2,4 % weniger“); Stand Nr. und Tag stehen im PDF.
              text: m.bewertung
                ? [M.ergebnisWort(m.bewertung.ergebnis), m.bewertung.wirkung_prozent !== null ? M.prozent(m.bewertung.wirkung_prozent) : null].filter(Boolean).join(' · ')
                : M.massnahmeStand(m),
              pruefsumme: m.bewertung?.pruefsumme ?? null,
            }))} />
          ) : key === 'abweichungen' ? (
            <>
              <p className="vp-nw-leise">{M.offenSatz(a.abweichungen?.offen ?? 0, 'Abweichung', 'Abweichungen')}</p>
              <Liste leer={M.LEER.abweichungen} zeilen={(a.abweichungen?.im_jahr ?? []).map((x) => ({
                key: x.kennzeichen,
                titel: `${x.kennzeichen} · ${x.monate.join(', ')}`,
                zustand: M.zustandWort(x.zustand),
                text: [x.ergebnis ? M.ergebnisWort(x.ergebnis) : null, x.massnahme, x.abgeschlossen_am ? `abgeschlossen am ${M.tag(x.abgeschlossen_am)}` : null].filter(Boolean).join(' · ') || '—',
              }))} />
              <Liste leer={M.LEER.auffaelligkeiten} zeilen={(a.abweichungen?.auffaelligkeiten ?? []).map((x) => ({
                key: `${x.kennzahl}/${x.monat}`,
                titel: `Auffälligkeit ${x.kennzahl} · ${x.monat}`,
                zustand: M.zustandWort(x.zustand),
                text: x.antwort ? `${M.ergebnisWort(x.antwort)}${x.am ? ` am ${M.tag(x.am)}` : ''}` : '—',
              }))} />
            </>
          ) : key === 'audits_feststellungen' ? (
            <>
              <p className="vp-nw-leise">{M.offenSatz(a.audits_feststellungen?.offen ?? 0, 'Feststellung', 'Feststellungen')}</p>
              <Liste leer={M.LEER.audits} zeilen={(a.audits_feststellungen?.audits ?? []).map((x) => ({
                key: x.kennzeichen,
                titel: `${x.kennzeichen} · ${x.titel}`,
                zustand: M.zustandWort(x.zustand),
                text: x.durchgefuehrt_am ? `durchgeführt am ${M.tag(x.durchgefuehrt_am)}${x.abgeschlossen_am ? ` · abgeschlossen am ${M.tag(x.abgeschlossen_am)}` : ''}` : `Termin ${M.tag(x.termin)}`,
                pruefsumme: x.pruefsumme,
              }))} />
              <Liste leer={M.LEER.feststellungen} zeilen={(a.audits_feststellungen?.feststellungen ?? []).map((x) => ({
                key: x.kennzeichen,
                titel: `${x.kennzeichen} · ${M.quelleWort(x.quelle)}`,
                zustand: M.zustandWort(x.zustand),
                text: [`festgestellt am ${M.tag(x.festgestellt_am)}`, `Frist ${M.tag(x.frist)}`, x.wirksamkeit ? `Wirksamkeit Stand Nr. ${x.wirksamkeit.stand}: ${M.ergebnisWort(x.wirksamkeit.ergebnis)}` : null].filter(Boolean).join(' · '),
                pruefsumme: x.wirksamkeit?.pruefsumme ?? null,
              }))} />
            </>
          ) : key === 'bewertung_messplanung' ? (
            <>
              <Liste leer={M.LEER.bewertungen} zeilen={(a.bewertung_messplanung?.bewertungen ?? []).map((x) => ({
                key: x.kennung,
                titel: `${x.kennung} · Energetische Bewertung ${x.zeitraum}`,
                zustand: `Stand Nr. ${x.stand}${x.freigegeben_am ? ` vom ${M.tag(x.freigegeben_am)}` : ''}`,
                text: M.fristZeile(x.ueberpruefung) ?? '—',
                pruefsumme: x.pruefsumme,
              }))} />
              <Liste leer={M.LEER.messbedarfe} zeilen={(a.bewertung_messplanung?.messbedarfe ?? []).map((x) => ({
                key: x.kennzeichen,
                titel: `Messbedarf ${x.kennzeichen}`,
                zustand: M.zustandWort(x.zustand),
                text: x.frist ? `Frist ${M.tag(x.frist)}` : '—',
              }))} />
            </>
          ) : key === 'wiedervorlage' ? (
            <>
              <p className="vp-nw-leise">
                {a.wiedervorlage
                  ? `Stichtag ${M.tag(a.wiedervorlage.stichtag)}: ${a.wiedervorlage.anzahl_faellig} fällig · ${a.wiedervorlage.anzahl_vorschau} in den nächsten ${a.wiedervorlage.vorschau_tage} Tagen`
                  : '—'}
              </p>
              <Liste leer="—" zeilen={[...(a.wiedervorlage?.faellig ?? []), ...(a.wiedervorlage?.vorschau ?? [])].map((z) => ({
                key: `${z.art}/${z.kennzeichen}`,
                titel: `${z.kennzeichen} · ${z.titel}`,
                text: `${z.satz} (${M.tag(z.faellig_am)})`,
              }))} />
            </>
          ) : key === 'beschluesse' ? (
            beschluesse ?? <p className="vp-nw-leise">{M.LEER.beschluesse}</p>
          ) : key === 'sitzung' ? (
            sitzung ?? <p className="vp-nw-leise">{M.LEER.sitzung}</p>
          ) : (
            <Quellen a={a} />
          )}
        </section>
      ))}
      {saetze && (
        <div className="vp-em-saetze">
          <GrenzSatz className="vp-ez-grenze" verantwortung />
        </div>
      )}
    </div>
  );
}

type Zeile = { key: string; titel: string; zustand?: string; text: string; pruefsumme?: string | null };

/** Ein Kennzeichen vorn im Titel („M-2028-0001 · …“) - es steht im Tooltip, nicht in der Zeile (Entscheid 25). */
const KENNZEICHEN_VORN = /^[A-Z]{1,4}-\d{4}-\d{4}(?:\/\S+)? · /u;

/**
 * Eine Zeile je Gegenstand (Konzept Nachweisen n1 Runde 2): der Name, rechts der Zustand, darunter höchstens ein Fakt -
 * was festgehalten ist. Kennzeichen und Prüfsumme stehen im Tooltip der Zeile, vollständig im PDF des Stands.
 */
function Liste({ zeilen, leer }: { zeilen: Zeile[]; leer: string }) {
  if (zeilen.length === 0) return <p className="vp-nw-leise">{leer}</p>;
  return (
    <NwZeilen>
      {zeilen.map((z) => {
        const kz = KENNZEICHEN_VORN.exec(z.titel)?.[0].replace(' · ', '') ?? null;
        const hinweis = [kz, z.pruefsumme ? `Prüfsumme ${z.pruefsumme}` : null].filter(Boolean).join(' · ');
        return (
          <div key={z.key} title={hinweis || undefined} data-testid={`mb-eingabe-${z.key}`}>
            <NwZeile
              titel={z.titel.replace(KENNZEICHEN_VORN, '')}
              kurz
              unter={z.text && z.text !== '—' ? z.text : undefined}
              rechts={z.zustand ? <Fakt>{z.zustand}</Fakt> : undefined}
            />
          </div>
        );
      })}
    </NwZeilen>
  );
}

function Vorige({ a }: { a: M.MbAbzug }) {
  const v = a.vorige_beschluesse;
  if (!v || !v.managementbewertung) return <p className="vp-nw-leise" data-testid="mb-vorige-keine">{v?.satz ?? M.KEINE_VORIGE}</p>;
  const mb = v.managementbewertung;
  return (
    <>
      <Liste leer="—" zeilen={[{
        key: mb.kennung,
        titel: `${mb.kennung} · Managementbewertung ${mb.zeitraum}`,
        zustand: `Stand Nr. ${mb.stand_nr}${mb.freigegeben_am ? ` vom ${M.tag(mb.freigegeben_am)}` : ''}`,
        text: v.beschluesse.length === 1 ? '1 Beschluss' : `${v.beschluesse.length} Beschlüsse`,
        pruefsumme: mb.pruefsumme,
      }]} />
      {/* MG6 (R14): jeder Beschluss der vorigen mit dem Zustand seiner Folgen von heute - oder „ohne Folge“. */}
      <NwZeilen testId="mb-vorige-beschluesse">
        {v.beschluesse.map((b) => (
          <div key={b.kennung} title={b.kennung} data-testid={`mb-vorig-${b.kennung}`}>
            <NwZeile titel={b.wortlaut} kurz rechts={<Fakt>{beschlussZustand(b).wort}</Fakt>} />
          </div>
        ))}
      </NwZeilen>
    </>
  );
}

function Grundlagen({ a }: { a: M.MbAbzug }) {
  const aufgaben = M.aufgabenSatz(a);
  return (
    <>
      {M.GRUNDLAGEN.map((art) => {
        const g = M.grundlage(a, art);
        return (
          <div key={art} className="vp-mb-grundlage" data-testid={`mb-grundlage-${art}`}>
            <Unterkopf>{WORT[art]}</Unterkopf>
            {g.satz ? (
              <p className="vp-nw-leise">{g.satz}</p>
            ) : (
              <Liste leer="—" zeilen={g.dokumente.map((d) => ({
                key: d.dokument,
                titel: `${d.titel}`,
                zustand: M.zustandWort(d.zustand),
                text: [M.dokumentZeile(d), M.fristZeile(d.ueberpruefung)].filter(Boolean).join(' · '),
                pruefsumme: d.pruefsumme,
              }))} />
            )}
          </div>
        );
      })}
      {aufgaben && <p className="vp-nw-leise" data-testid="mb-aufgaben">{aufgaben}</p>}
    </>
  );
}

const WORT: Record<string, string> = {
  energiepolitik: 'Energiepolitik',
  anwendungsbereich: 'Anwendungsbereich',
  rechtliche_anforderungen: 'Rechtliche Anforderungen',
  risiken_chancen: 'Risiken und Chancen',
};

function Quellen({ a }: { a: M.MbAbzug }) {
  const q = a.quellenverzeichnis ?? [];
  return (
    <Liste
      leer="—"
      zeilen={q.map((x) => ({
        key: `${x.art}/${x.kennzeichen}/${x.version ?? ''}/${x.fassung ?? ''}`,
        titel: x.name_zum_datenstand ?? x.kennzeichen,
        text: [x.version !== null ? `Nr. ${x.version}` : null, x.fassung !== null ? `Fassung ${x.fassung}` : null].filter(Boolean).join(' · ') || '—',
      }))}
    />
  );
}
