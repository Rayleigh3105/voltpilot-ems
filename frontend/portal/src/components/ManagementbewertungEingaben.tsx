import type { ReactNode } from 'react';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import * as M from '../managementbewertung';

/**
 * Die Eingaben einer Managementbewertung (UEMS AP-19 IP-24, MG2): die Abschnitte der Vorlage in ihrer Reihenfolge, genau
 * so, wie der Abzug sie festhält — Kennzeichen, Nr., Prüfsumme und das Ergebnis wie festgehalten; nichts wird neu
 * gerechnet oder beurteilt. Derselbe Baustein zeigt den Entwurf (die Eingaben von heute) und einen Stand (die Eingaben
 * seines Tages). Sitzung und Beschlüsse füllt, wer das Energiemanagement bearbeitet (`beschluesse`, `sitzung` als Kinder).
 * `saetze` zeigt Grenz- und Verantwortungs-Satz, wo der Baustein allein steht (auf der Seite stehen sie am Fuß).
 */
export function ManagementbewertungEingaben({
  abzug,
  beschluesse,
  sitzung,
  ohne = [],
  saetze = false,
}: {
  abzug: M.MbAbzug;
  beschluesse?: ReactNode;
  sitzung?: ReactNode;
  /** Abschnitte, die die Seite an anderer Stelle zeigt (Sitzung und Beschlüsse über den Eingaben). */
  ohne?: readonly string[];
  saetze?: boolean;
}) {
  const a = abzug;
  return (
    <div className="vp-mb-eingaben" data-testid="mb-eingaben">
      {M.ABSCHNITTE.filter(({ key }) => !ohne.includes(key)).map(({ key, titel }) => (
        <section key={key} className="vp-mb-abschnitt" aria-label={titel} data-testid={`mb-abschnitt-${key}`}>
          <h3>{titel}</h3>
          {key === 'vorige_beschluesse' ? (
            <Vorige a={a} />
          ) : key === 'grundlagen' ? (
            <Grundlagen a={a} />
          ) : key === 'energieziele' ? (
            <Liste leer={M.LEER.energieziele} zeilen={(a.energieziele ?? []).map((e) => ({
              key: e.kennzeichen,
              titel: `${e.kennzeichen} · Ziel ${M.prozent(e.zielwert_prozent)} (${e.zielperiode})`,
              zustand: M.zustandWort(e.zustand),
              text: M.energiezielErgebnis(e),
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
              text: `${M.herkunftWort(m.herkunft_art, m.herkunft_kennung)} · ${M.massnahmeStand(m)}`,
              pruefsumme: m.bewertung?.pruefsumme ?? null,
            }))} />
          ) : key === 'abweichungen' ? (
            <>
              <p className="vp-ez-leise">{M.offenSatz(a.abweichungen?.offen ?? 0, 'Abweichung', 'Abweichungen')}</p>
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
              <p className="vp-ez-leise">{M.offenSatz(a.audits_feststellungen?.offen ?? 0, 'Feststellung', 'Feststellungen')}</p>
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
              <p className="vp-ez-leise">
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
            beschluesse ?? <p className="vp-ez-leise">{M.LEER.beschluesse}</p>
          ) : key === 'sitzung' ? (
            sitzung ?? <p className="vp-ez-leise">{M.LEER.sitzung}</p>
          ) : (
            <Quellen a={a} />
          )}
        </section>
      ))}
      {saetze && (
        <div className="vp-em-saetze">
          <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
          <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
        </div>
      )}
    </div>
  );
}

type Zeile = { key: string; titel: string; zustand?: string; text: string; pruefsumme?: string | null };

/** Eine Zeile je Gegenstand — Titel, Zustand, was festgehalten ist, Prüfsumme gekürzt (die ganze im `title`). */
function Liste({ zeilen, leer }: { zeilen: Zeile[]; leer: string }) {
  if (zeilen.length === 0) return <p className="vp-ez-leise">{leer}</p>;
  return (
    <ul className="vp-mb-zeilen">
      {zeilen.map((z) => (
        <li key={z.key} data-testid={`mb-eingabe-${z.key}`}>
          <span className="vp-mb-gegenstand">{z.titel}</span>
          {z.zustand && <span className="vp-mb-zustand">{z.zustand}</span>}
          <span className="vp-mb-text">{z.text}</span>
          {z.pruefsumme && (
            <span className="vp-mb-pruef" title={z.pruefsumme}>
              Prüfsumme {M.pruefsummeKurz(z.pruefsumme)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Vorige({ a }: { a: M.MbAbzug }) {
  const v = a.vorige_beschluesse;
  if (!v || !v.managementbewertung) return <p className="vp-ez-satz" data-testid="mb-vorige-keine">{v?.satz ?? M.KEINE_VORIGE}</p>;
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
      {/* MG6 (R14): jeder Beschluss der vorigen mit seinen Folgen und deren Zustand von heute — oder dem Satz ohne Folge. */}
      <ul className="vp-mb-zeilen vp-mb-vorige" data-testid="mb-vorige-beschluesse">
        {v.beschluesse.map((b) => (
          <li key={b.kennung} data-testid={`mb-vorig-${b.kennung}`}>
            <span className="vp-mb-gegenstand">{`${b.kennung} · ${M.BESCHLUSS_ART_WORT[b.art] ?? b.art}${b.entschieden_von ? ` · entschieden von ${b.entschieden_von}` : ''}`}</span>
            <span className="vp-mb-text">{b.wortlaut}</span>
            {b.folgen.length > 0 ? (
              <ul className="vp-em-kurzliste">
                {b.folgen.map((f) => (
                  <li key={`${f.art}/${f.objekt}/${f.wie}`}>{M.folgeZeile(f)}</li>
                ))}
              </ul>
            ) : (
              <span className="vp-ez-leise">{b.satz ?? '—'}</span>
            )}
          </li>
        ))}
      </ul>
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
            <h4>{WORT[art]}</h4>
            {g.satz ? (
              <p className="vp-ez-leise">{g.satz}</p>
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
      {aufgaben && <p className="vp-ez-satz" data-testid="mb-aufgaben">{aufgaben}</p>}
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
  if (q.length === 0) return <p className="vp-ez-leise">—</p>;
  return (
    <details className="vp-mb-quellen">
      <summary>{q.length === 1 ? '1 Quelle' : `${q.length} Quellen`}</summary>
      <ul className="vp-mb-zeilen">
        {q.map((x) => (
          <li key={`${x.art}/${x.kennzeichen}/${x.version ?? ''}/${x.fassung ?? ''}`}>
            <span className="vp-mb-gegenstand">{`${x.kennzeichen}${x.name_zum_datenstand ? ` · ${x.name_zum_datenstand}` : ''}`}</span>
            <span className="vp-mb-text">
              {[x.version !== null ? `Nr. ${x.version}` : null, x.fassung !== null ? `Fassung ${x.fassung}` : null].filter(Boolean).join(' · ') || '—'}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
