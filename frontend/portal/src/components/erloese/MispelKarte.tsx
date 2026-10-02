import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { VrKarte } from '../VerlaufRahmen';
import { BottomSheet } from '../BottomSheet';
import { VpPicker } from '../VpPicker';
import {
  EMPFAENGER,
  FARBE,
  balken,
  betragText,
  euroText,
  grundText,
  kwhText,
  monatName,
  offenText,
  standText,
  standZeit,
  tagText,
  type MispelBetrag,
  type MispelEmpfaenger,
  type MispelJahr,
  type MispelMonat,
  type MispelTeil,
  type MispelWert,
} from '../../mispelMengen';
import './MispelKarte.css';

/**
 * **MiSpeL · Mengen nach Anlage 1** — die Karte in Verlauf › Erlöse (MP-18, Bedienkonzept BK-18 Variante A, abgestimmt
 * 02.10.2026). Monat: Farbbalken der Einspeisung (4) mit Grün (26), Gelb (31), Rot (16) und Grau, jede Zahl mit Begriff
 * und Formelnummer; Netzbezug (3) mit umlagereduziert (20) und umlagebelastet (21); „Was das wert ist“; Stand;
 * Nachweis über die Routen von MP-16. Jahr: eine Zeile je Monat.
 *
 * ⚠ Keine eigene Rechnung — alle Zahlen kommen fertig aus der Route (`mispelMengen.ts`).
 * ⚠ `ampel` ist der Platz der Abweichungsampel Gerät ↔ Messstellenbetreiber (MP-15, BK-15); heute leer.
 */
export function MispelMonatKarte({
  siteId,
  daten,
  ampel,
}: {
  siteId: string;
  daten: MispelMonat;
  ampel?: ReactNode;
}) {
  const name = monatName(daten.monat);
  const stand = standText(daten.stand, daten.teile);
  const vorlaeufig = daten.stand === 'vorlaeufig';
  return (
    <VrKarte titel={`MiSpeL · Mengen nach Anlage 1 · ${name}`} label="MiSpeL · Mengen nach Anlage 1" className="vp-mi">
      <div className="vp-mi-kopf">
        <span className={`vp-mi-stand is-${stand.ton}`}>{stand.text}</span>
        {ampel}
      </div>
      <p className="vp-mi-satz">{satz(daten, name)}</p>
      {daten.teile.length > 0 && daten.wert && (
        <div className="vp-mi-grid">
          <div>
            {daten.teile.map((t) => (
              <TeilMengen key={t.schluessel} teil={t} monat={daten.monat} mehrere={daten.teile.length > 1} />
            ))}
          </div>
          <div>
            <h3 className="vp-mi-label">Was das wert ist</h3>
            <WertLedger wert={daten.wert} vorschau={vorlaeufig} />
            <Nachweis siteId={siteId} zeitraum={daten.monat} titel={`Nachweis ${name}`} endgueltig={daten.giltAlsNachweis}>
              {daten.giltAlsNachweis
                ? `Monatliche Mengenbestimmung nach Anlage 1 · ${formelsaetze(daten.teile)} · mit Prüfsumme`
                : 'Wasserzeichen „vorläufig – keine Mengenbestimmung“; als Nachweis zählen nur endgültige Monate.'}
            </Nachweis>
          </div>
        </div>
      )}
    </VrKarte>
  );
}

function satz(d: MispelMonat, name: string): string {
  if (d.teile.length === 0) {
    return `Für ${name} ist noch kein Monatslauf gerechnet. Die Mengen stehen hier, sobald VoltPilot den Monat nach Anlage 1 bestimmt hat.`;
  }
  if (d.stand === 'endgueltig') return 'Abgerechnet wird mit den Werten Ihres Messstellenbetreibers.';
  const zeit = standZeit(d.teile);
  const geraet = d.teile.some((t) => t.wertequelle === 'geraet');
  const letzter = d.teile[d.teile.length - 1].letzterTag;
  const gruende = [...new Set(d.teile.flatMap((t) => t.standGruende).map(grundText))].join(', ');
  return geraet
    ? `Vorschau aus den Werten Ihrer Geräte${zeit ? `, ${zeit}` : ''}. Endgültig wird der Monat mit den Werten Ihres Messstellenbetreibers — frühestens nach dem ${tagText(letzter)}.`
    : `Vorläufig${zeit ? `, ${zeit}` : ''}: ${gruende}.`;
}

function formelsaetze(teile: MispelTeil[]): string {
  return [...new Set(teile.map((t) => `Formelsatz ${t.formelsatz}`))].join(', ');
}

function TeilMengen({ teil, monat, mehrere }: { teil: MispelTeil; monat: string; mehrere: boolean }) {
  const rumpf = mehrere || !teil.ersterTag.endsWith('-01') || teil.schluessel !== monat;
  const stuecke = balken(teil);
  return (
    <div className="vp-mi-teil" data-teil={teil.schluessel}>
      {rumpf && (
        <p className="vp-mi-rumpf">
          Rumpfmonat {tagText(teil.ersterTag)}–{tagText(teil.letzterTag)} · Formelsatz {teil.formelsatz}
        </p>
      )}
      <div className="vp-mi-summe">
        <span>
          <b>Eingespeist</b> <span className="vp-mi-nr">{teil.einspeisung.nr}</span>
        </span>
        <b className="vp-mi-zahl-gross">{kwhText(teil.einspeisung.kwh)}</b>
      </div>
      <div
        className="vp-mi-bar"
        role="img"
        aria-label={`Einspeisung nach Anlage 1: ${teil.farben.map((f) => `${FARBE[f.farbe].kurz} ${kwhText(f.kwh)}`).join(', ')}`}
      >
        {stuecke.map((s) => (
          <i key={s.farbe} className={`is-${s.farbe}`} style={{ width: `${s.pct}%` }} />
        ))}
      </div>
      <ul className="vp-mi-leg" aria-label="Mengen nach Anlage 1">
        {teil.farben.map((f) => (
          <li key={f.farbe} data-farbe={f.farbe}>
            <span className={`vp-mi-q is-${f.farbe}`} aria-hidden="true" />
            <span>
              {FARBE[f.farbe].wort}
              <span className="vp-mi-f">
                {f.formel} {f.begriff}
              </span>
            </span>
            <span className="vp-mi-z">{kwhText(f.kwh)}</span>
          </li>
        ))}
      </ul>
      <dl className="vp-mi-kv">
        <dt>
          <b>Netzbezug</b> <span className="vp-mi-nr">{teil.netzbezug.nr}</span>
        </dt>
        <dd>{kwhText(teil.netzbezug.kwh)}</dd>
        <dt title={teil.umlagereduziert.begriff}>
          davon umlagereduziert <span className="vp-mi-nr">{teil.umlagereduziert.nr}</span>
        </dt>
        <dd>{kwhText(teil.umlagereduziert.kwh)}</dd>
        <dt title={teil.umlagebelastet.begriff}>
          davon umlagebelastet <span className="vp-mi-nr">{teil.umlagebelastet.nr}</span>
        </dt>
        <dd>{kwhText(teil.umlagebelastet.kwh)}</dd>
      </dl>
    </div>
  );
}

function satzZeile(b: MispelBetrag, was: string, ust: number | null): string {
  const menge = kwhText(b.mengeKwh);
  if (b.satzCt == null) return `${menge} ${b.formel} · ${offenText(b.grund)}`;
  const ct = b.satzCt.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const steuer = ust ? ` · inkl. ${ust.toLocaleString('de-DE')} % USt` : '';
  return `${menge} × ${ct} ct ${was}${steuer}`;
}

export function WertLedger({ wert, vorschau }: { wert: MispelWert; vorschau: boolean }) {
  const v = vorschau ? ' (Vorschau)' : '';
  const p = wert.marktpraemie;
  return (
    <dl className="vp-mi-ledger">
      <dt>
        Vermiedene Umlagen{v}
        <span className="vp-mi-f">
          {satzZeile(wert.vermiedeneUmlagen, '· umlagereduzierende Menge (20), § 21 EnFG', wert.ustPct)}
        </span>
      </dt>
      <dd data-betrag="umlagen">{betragText(wert.vermiedeneUmlagen)}</dd>
      <dt>
        Vermiedenes Netzentgelt{v}
        <span className="vp-mi-f">
          {satzZeile(wert.vermiedenesNetzentgelt, 'Arbeitspreis · § 118 Abs. 6 EnWG', wert.ustPct)}
        </span>
      </dt>
      <dd data-betrag="netzentgelt">{betragText(wert.vermiedenesNetzentgelt)}</dd>
      {p && (
        <>
          <dt>
            Marktprämie
            <span className="vp-mi-f">
              auf {kwhText(p.mengeKwh)} förderfähig {p.formel}
              {p.stand === 'offen' ? ` · ${offenText(p.grund)}` : ` × ${p.satzCt?.toLocaleString('de-DE')} ct (AW − Jahresmarktwert)`}
            </span>
          </dt>
          <dd data-betrag="marktpraemie" className={p.stand === 'offen' ? 'is-offen' : undefined}>
            {betragText(p)}
          </dd>
        </>
      )}
      <dt className="vp-mi-sum">Summe ohne Marktprämie</dt>
      <dd className="vp-mi-sum" data-betrag="summe">
        {euroText(wert.summeOhneMarktpraemieEur)}
      </dd>
    </dl>
  );
}

/** Schmal = Telefon: der Nachweis kommt als Blatt (BK-18 „Telefon · Nachweis holen“). */
function useSchmal(): boolean {
  const abfrage = '(max-width: 640px)';
  const [schmal, setSchmal] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(abfrage).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(abfrage);
    if (!mq) return;
    const auf = () => setSchmal(mq.matches);
    mq.addEventListener?.('change', auf);
    return () => mq.removeEventListener?.('change', auf);
  }, []);
  return schmal;
}

function Nachweis({
  siteId,
  zeitraum,
  titel,
  endgueltig,
  children,
}: {
  siteId: string;
  zeitraum: string;
  titel: string;
  endgueltig: boolean;
  children: ReactNode;
}) {
  const schmal = useSchmal();
  const [empfaenger, setEmpfaenger] = useState<MispelEmpfaenger>('lieferant');
  const [format, setFormat] = useState<'pdf' | 'csv'>('pdf');
  const [blatt, setBlatt] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const laden = async (e: MispelEmpfaenger, f: 'pdf' | 'csv') => {
    setLaeuft(true);
    setFehler(null);
    try {
      await api.mispelNachweis(siteId, zeitraum, e, f);
      setBlatt(false);
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Der Nachweis konnte nicht geladen werden.');
    } finally {
      setLaeuft(false);
    }
  };

  if (!endgueltig) {
    return (
      <div className="vp-mi-nachweis">
        <div className="vp-mi-knoepfe">
          <button type="button" className="vp-btn vp-btn--outline vp-btn--sm" disabled={laeuft} onClick={() => laden('netzbetreiber', 'pdf')}>
            Vorschau (PDF)
          </button>
        </div>
        <p className="vp-mi-klein">{children}</p>
        {fehler && <p className="vp-mi-fehler" role="alert">{fehler}</p>}
      </div>
    );
  }

  return (
    <div className="vp-mi-nachweis">
      {schmal ? (
        <div className="vp-mi-knoepfe">
          <button type="button" className="vp-btn vp-btn--primary vp-btn--sm" onClick={() => setBlatt(true)}>
            Nachweis holen
          </button>
        </div>
      ) : (
        <div className="vp-mi-knoepfe">
          <button type="button" className="vp-btn vp-btn--primary vp-btn--sm" disabled={laeuft} onClick={() => laden(empfaenger, 'pdf')}>
            Nachweis (PDF)
          </button>
          <button type="button" className="vp-btn vp-btn--outline vp-btn--sm" disabled={laeuft} onClick={() => laden(empfaenger, 'csv')}>
            CSV
          </button>
          <span className="vp-mi-fuer">
            für:
            <VpPicker
              ariaLabel="Nachweis für"
              options={EMPFAENGER.map((x) => ({ value: x.id, label: x.label }))}
              value={empfaenger}
              onChange={(v) => setEmpfaenger(v as MispelEmpfaenger)}
            />
          </span>
        </div>
      )}
      <p className="vp-mi-klein">{children}</p>
      {fehler && !blatt && <p className="vp-mi-fehler" role="alert">{fehler}</p>}
      <BottomSheet
        open={blatt}
        title={titel}
        onClose={() => setBlatt(false)}
        footer={
          <div className="vp-mi-knoepfe">
            <button type="button" className="vp-btn vp-btn--ghost vp-btn--sm" onClick={() => setBlatt(false)}>
              Abbrechen
            </button>
            <button type="button" className="vp-btn vp-btn--primary vp-btn--sm" disabled={laeuft} onClick={() => laden(empfaenger, format)}>
              Herunterladen
            </button>
          </div>
        }
      >
        <p className="vp-mi-satz">
          Der Nachweis gilt als monatliche Mengenbestimmung nach Anlage 1. Alle Empfänger bekommen denselben Formelsatz,
          dasselbe Messkonzept und dieselben Zwischenwerte.
        </p>
        <fieldset className="vp-mi-wahl">
          <legend>Für wen?</legend>
          {EMPFAENGER.map((x) => (
            <label key={x.id}>
              <input type="radio" name="mispel-empfaenger" checked={empfaenger === x.id} onChange={() => setEmpfaenger(x.id)} />
              <span>
                <b>{x.label}</b>
                <span className="vp-mi-f">{x.satz}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="vp-mi-wahl is-zeile">
          <legend>Format</legend>
          {(['pdf', 'csv'] as const).map((f) => (
            <label key={f}>
              <input type="radio" name="mispel-format" checked={format === f} onChange={() => setFormat(f)} />
              <b>{f.toUpperCase()}</b>
            </label>
          ))}
        </fieldset>
        {fehler && <p className="vp-mi-fehler" role="alert">{fehler}</p>}
      </BottomSheet>
    </div>
  );
}

/** Zeitraum Jahr: eine Zeile je Monat mit Balken, Betrag und Stand; Summe und Jahresnachweis bis 31.05. */
export function MispelJahrKarte({
  siteId,
  daten,
  onMonat,
}: {
  siteId: string;
  daten: MispelJahr;
  onMonat?: (monat: string) => void;
}) {
  const monate = [...daten.monate].reverse();
  const erster = daten.monate.flatMap((m) => m.teile).map((t) => t.ersterTag).sort()[0];
  const offenePraemie = daten.wert?.marktpraemie?.stand === 'offen';
  const offene = daten.monate.filter((m) => m.abgrenzung && m.stand !== 'endgueltig');
  const letzterOffen = offene.length > 0 ? offene[offene.length - 1] : null;
  return (
    <VrKarte titel={`MiSpeL · Saldierung je Monat · ${daten.jahr}`} label="MiSpeL · Saldierung je Monat" className="vp-mi">
      <ul className="vp-mi-jahr" aria-label="Monate nach Anlage 1">
        {monate.map((m) => (
          <JahrZeile key={m.monat} m={m} onMonat={onMonat} />
        ))}
      </ul>
      <div className="vp-mi-jahr-summe">
        <b>{daten.jahr}</b>
        <span className="vp-mi-klein">
          {erster ? `Bestimmung nach Anlage 1 ab ${tagText(erster)}` : 'noch keine Bestimmung nach Anlage 1'}
          {offenePraemie ? ` · Marktprämie offen bis zum Jahresmarktwert ${daten.jahr}` : ''}
        </span>
        <b className="vp-mi-zahl-gross" data-betrag="jahr">
          {euroText(daten.wert?.summeOhneMarktpraemieEur)}
        </b>
      </div>
      {daten.abgrenzung && (
        <div className="vp-mi-hinweis">
          <p>
            <b>Jahresnachweis {daten.jahr}</b> für die Mitteilung Ihres Lieferanten bis {tagText(daten.mitteilungBis)} (§ 21
            Abs. 7 EnFG)
            {daten.giltAlsNachweis
              ? '.'
              : ` — verfügbar, sobald ${letzterOffen ? monatName(letzterOffen.monat).split(' ')[0] : 'das Jahr'} endgültig ist.`}
          </p>
          {daten.giltAlsNachweis && (
            <Nachweis siteId={siteId} zeitraum={String(daten.jahr)} titel={`Jahresnachweis ${daten.jahr}`} endgueltig>
              Jahresnachweis nach Anlage 1 · ∑J aus den Monatsläufen · mit Prüfsummen
            </Nachweis>
          )}
        </div>
      )}
    </VrKarte>
  );
}

function JahrZeile({ m, onMonat }: { m: MispelMonat; onMonat?: (monat: string) => void }) {
  const name = monatName(m.monat).split(' ')[0];
  const stand = standText(m.stand, m.teile);
  const aenderung = m.teile.map((t) => t.aenderung).find((a) => a != null) ?? null;
  return (
    <li className="vp-mi-monat" data-monat={m.monat}>
      <span className="vp-mi-m">{name}</span>
      {m.teile.length > 0 ? (
        <span className="vp-mi-bar is-schmal" aria-hidden="true">
          {m.teile.flatMap((t) =>
            balken(t).map((s) => (
              <i key={`${t.schluessel}-${s.farbe}`} className={`is-${s.farbe}`} style={{ width: `${s.pct / m.teile.length}%` }} />
            )),
          )}
        </span>
      ) : (
        <span className="vp-mi-klein">
          {m.abgrenzung
            ? 'Abgrenzungsoption — noch kein Monatslauf'
            : `${m.foerderwegBegriff ?? 'ohne Förderweg'} — keine Mengen nach Anlage 1`}
        </span>
      )}
      <span className="vp-mi-e" data-betrag="monat">
        {m.teile.length > 0 ? euroText(m.wert?.summeOhneMarktpraemieEur) : '—'}
      </span>
      {m.teile.length > 0 && (
        <span className="vp-mi-st">
          <span className={`vp-mi-stand is-${stand.ton}`}>
            {m.stand === 'endgueltig' ? 'endgültig' : 'vorläufig'}
          </span>
          {m.stand === 'vorlaeufig' && <span>Vorschau aus {stand.text.includes('Geräte') ? 'Gerätewerten' : 'vorläufigen Werten'}, {standZeit(m.teile)}</span>}
          {aenderung && aenderung.differenzEur != null && (
            <span data-aenderung="">
              {euroText(aenderung.differenzEur)} gegenüber der Vorschau — Grund:{' '}
              {aenderung.vorherGruende.filter((g) => g !== 'zeitraum_offen').map(grundText).join(', ') || 'Monat abgeschlossen'}
            </span>
          )}
          {onMonat && (
            <button type="button" className="vp-mi-link" onClick={() => onMonat(m.monat)}>
              {m.stand === 'endgueltig' ? 'Nachweis ›' : 'Monat ansehen ›'}
            </button>
          )}
        </span>
      )}
    </li>
  );
}
