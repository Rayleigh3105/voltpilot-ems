import { useMemo, useState, type KeyboardEvent } from 'react';
import { monatKurz, monatLang, prozent, type MonatsPunkt } from '../energiezielBild';
import './MonatsGrafik.css';

const W = 290;
const H = 142;
const NULL_Y = H / 2;

/** Die Achse: Striche bei ± 4 %, solange alle Werte hineinpassen (wie a1), sonst bei einem runden größeren Schritt. */
export function achse(punkte: MonatsPunkt[], zielwert: number, band: number | null) {
  const groesster = Math.max(Math.abs(zielwert), band ?? 0, ...punkte.map((p) => Math.abs(p.delta ?? 0)));
  const strich = groesster <= 6 ? 4 : ([5, 10, 15, 20, 25, 50, 100].find((s) => s >= groesster * 0.65) ?? 100);
  const halb = Math.max(strich * 1.5875, groesster * 1.08);
  return { strich, halb, y: (p: number) => NULL_Y - (p * NULL_Y) / halb };
}

/** Eine Säule von der Nulllinie bis `y`, die freie Kante gerundet (wie a1). */
function saeule(x: number, b: number, y: number): string {
  const r = Math.min(3, Math.abs(NULL_Y - y));
  if (y < NULL_Y) {
    return `M${x},${NULL_Y}V${y + r}Q${x},${y} ${x + r},${y}H${x + b - r}Q${x + b},${y} ${x + b},${y + r}V${NULL_Y}Z`;
  }
  return `M${x},${NULL_Y}V${y - r}Q${x},${y} ${x + r},${y}H${x + b - r}Q${x + b},${y} ${x + b},${y - r}V${NULL_Y}Z`;
}

const vorgabe = (punkte: MonatsPunkt[]) => {
  for (let i = punkte.length - 1; i >= 0; i--) if (punkte[i].art === 'gezaehlt') return i;
  for (let i = punkte.length - 1; i >= 0; i--) if (punkte[i].art !== 'kommt') return i;
  return 0;
};

/**
 * „Je Monat gegen das Energieziel“ (Konzept Verbessern §6.4, §6.11): die Abweichung vom Erwarteten je Monat als Säule
 * um die Nulllinie (Auswerten a1), das Band „im Rahmen“ hell hinterlegt, das Energieziel als gestrichelte Linie in Navy
 * — gestrichelt, damit es nie mit einer Säule verwechselt wird. Laufende und nicht bewertbare Monate stehen gestrichelt
 * ohne Zahl, kommende leer mit hellem Namen. Eine Infozeile über der Grafik sagt den gewählten Monat (kein Tooltip, der
 * etwas verdeckt); dieselben Werte stehen als Liste darunter.
 */
export function MonatsGrafik({
  punkte,
  zielwert,
  band,
  linieWort,
  label,
}: {
  punkte: MonatsPunkt[];
  zielwert: string;
  band: string | null;
  /** „Energieziel: 4 % weniger“ — die Legende der Linie. */
  linieWort: string;
  label: string;
}) {
  const [wahl, setWahl] = useState(() => vorgabe(punkte));
  const z = Number(zielwert);
  const b = band === null ? null : Number(band);
  const a = useMemo(() => achse(punkte, z, b), [punkte, z, b]);
  const n = Math.max(1, punkte.length);
  const slot = W / n;
  const breite = Math.min(15, slot * 0.56);
  const p = punkte[Math.min(wahl, punkte.length - 1)];
  const jahre = useMemo(() => {
    const aus: { jahr: string; von: number; bis: number }[] = [];
    punkte.forEach((q, i) => {
      const j = q.periode.slice(0, 4);
      const letzte = aus[aus.length - 1];
      if (letzte && letzte.jahr === j) letzte.bis = i;
      else aus.push({ jahr: j, von: i, bis: i });
    });
    return aus;
  }, [punkte]);
  const beschriften = n <= 12 ? () => true : (i: number) => i % Math.ceil(n / 12) === 0;
  const taste = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setWahl((w) => Math.max(0, w - 1));
    else if (e.key === 'ArrowRight') setWahl((w) => Math.min(punkte.length - 1, w + 1));
    else return;
    e.preventDefault();
  };
  const bandOben = b === null ? null : a.y(b);
  const bandUnten = b === null ? null : a.y(-b);

  return (
    <div className="vp-mgraf-karte">
      <div className="vp-mgraf-info" aria-live="polite" data-testid="monatsgrafik-info">
        {p && (
          <>
            <b>{monatLang(p.periode)}</b>
            {p.art === 'gezaehlt' ? (
              <>
                <span className="w">{p.gemessen}</span>
                <span>statt {p.erwartet?.replace(/ \S+$/, '')} erwartet</span>
                <span className={`u is-${p.ton}`}>
                  {prozent(String(p.delta))} {p.delta !== null && p.delta < 0 ? 'weniger' : 'mehr'} · {p.urteilWort}
                </span>
              </>
            ) : (
              <span>{p.art === 'kommt' ? 'noch nicht begonnen' : p.grund}</span>
            )}
          </>
        )}
      </div>
      <div
        className="vp-mgraf"
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={taste}
        data-testid="monatsgrafik"
      >
        <div className="vp-mgraf-y" aria-hidden="true">
          <span className="sizer w">weniger</span>
          <span className="sizer">{`+${a.strich} %`}</span>
          <span className="oben w">mehr</span>
          <span className="mitte" style={{ top: `${((a.y(a.strich) / H) * 100).toFixed(2)}%` }}>{`+${a.strich} %`}</span>
          <span className="mitte" style={{ top: '50%' }}>0</span>
          <span className="mitte" style={{ top: `${((a.y(-a.strich) / H) * 100).toFixed(2)}%` }}>{`−${a.strich} %`}</span>
          <span className="unten w">weniger</span>
        </div>
        <div className="vp-mgraf-p">
          <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
            {bandOben !== null && bandUnten !== null && (
              <rect className="vp-mgraf-band" x="0" y={bandOben} width={W} height={bandUnten - bandOben} />
            )}
            <line className="vp-mgraf-gitter" x1="0" x2={W} y1={a.y(a.strich)} y2={a.y(a.strich)} />
            <line className="vp-mgraf-null" x1="0" x2={W} y1={NULL_Y} y2={NULL_Y} />
            <line className="vp-mgraf-gitter" x1="0" x2={W} y1={a.y(-a.strich)} y2={a.y(-a.strich)} />
            {punkte.map((q, i) => {
              const x = slot * i + (slot - breite) / 2;
              if (q.art === 'gezaehlt' && q.delta !== null) {
                return <path key={q.periode} className={`vp-mgraf-saeule is-${q.ton}`} d={saeule(x, breite, a.y(q.delta))} />;
              }
              if (q.art === 'kommt') return null;
              return (
                <rect key={q.periode} className="vp-mgraf-offen" x={x} y={NULL_Y - 14.5} width={breite} height="29" rx="3" />
              );
            })}
            <line className="vp-mgraf-linie" x1="0" x2={W} y1={a.y(z)} y2={a.y(z)} />
            {p && (
              <rect
                className="vp-mgraf-wahl"
                x={slot * wahl + (slot - breite) / 2 - 2}
                y="2"
                width={breite + 4}
                height={H - 4}
                rx="5"
              />
            )}
            {punkte.map((q, i) => (
              <rect
                key={`t-${q.periode}`}
                className="vp-mgraf-tippen"
                x={slot * i}
                y="0"
                width={slot}
                height={H}
                onPointerEnter={() => setWahl(i)}
                onPointerDown={() => setWahl(i)}
              />
            ))}
          </svg>
        </div>
        <div className="vp-mgraf-x" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          {punkte.map((q, i) => (
            <span key={q.periode} className={`${i === wahl ? 'sel' : ''} ${q.art === 'kommt' ? 'spaeter' : ''}`}>
              {beschriften(i) && (
                <>
                  <span className="ml">{monatKurz(q.periode)}</span>
                  <span className="mk">{monatKurz(q.periode).charAt(0)}</span>
                </>
              )}
            </span>
          ))}
        </div>
        <div className="vp-mgraf-j" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          {jahre.map((j, i) => (
            <span
              key={j.jahr}
              className={i > 0 && i === jahre.length - 1 && j.bis - j.von < 2 ? 'ende' : ''}
              style={{ gridColumn: `${j.von + 1} / ${j.bis + 2}`, gridRow: 1 }}
            >
              {j.jahr}
            </span>
          ))}
        </div>
      </div>
      <div className="vp-mgraf-legende">
        <span><i className="is-warn" />mehr als erwartet</span>
        <span><i className="is-rahmen" />{b === null ? 'im Rahmen' : `im Rahmen (± ${String(b).replace('.', ',')} %)`}</span>
        <span><i className="is-ok" />weniger als erwartet</span>
        <span><i className="linie" />{linieWort}</span>
      </div>
      <p className="vp-mgraf-tipp">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 11V6a2 2 0 0 0-4 0v1" />
          <path d="M14 10V4a2 2 0 0 0-4 0v2" />
          <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
          <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
        </svg>
        <span className="fein">Monat antippen oder mit dem Finger über die Säulen fahren</span>
        <span className="maus">Mit der Maus über die Säulen fahren oder einen Monat anklicken</span>
      </p>
    </div>
  );
}
