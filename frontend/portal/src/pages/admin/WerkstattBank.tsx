/**
 * Die Werkstatt-Bildschirme an der Werkbank (WI-8 A, M1–M6) mit der Lauf-Seite
 * (Konzept vp-werkstatt-lauf-seite, entschieden 05.11.2026, E1–E4 je A): ein
 * geführter Ablauf, den auch Fremde schaffen. Während des Laufs steht links,
 * was der Dienst jetzt tut und alle Schritte mit Beleg und Dauer, rechts die
 * Software, die auf die Box kommt, und die Box selbst; auf dem Telefon eine
 * Spalte. Hält der Lauf an, zeigt die Seite den Fall: was los ist, was du tun
 * kannst, ob der Dienst danach von selbst weitermacht. Kein Knopf hier löscht
 * etwas an einer Box; „Nochmal versuchen“ tut, was das Abziehen des Kabels
 * täte. Welcher Bildschirm gilt, entscheidet `werkstattBank.ts`, die Seite
 * eines Falls `werkstattLauf.ts`.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { beschriftung, VERSAND_SATZ } from '../../werkstatt';
import {
  bildschirm,
  fortschritt,
  geraetVon,
  geraetWort,
  heute,
  phasen,
  uhrzeit,
  type Geraet,
  type LaufStand,
  type Phase,
  type WerkstattAnsicht,
  type WerkstattDienst,
  type WerkstattFreigabe,
  type WerkstattFreigabePfc200,
  type WerkstattStand,
} from '../../werkstattBank';
import {
  dauerText,
  jetzt as jetztKarte,
  liveSeitSek,
  meistDauer,
  PRUEFUNGEN_WORT,
  schrittListe,
  seitText,
  softwareKarte,
  type Bild,
  type FallSeite,
  type Knopf,
  type PhasenZeile,
  type SoftwareKarte as Software,
} from '../../werkstattLauf';
import {
  ADMIN_PASSWORT_SATZ,
  ANSCHLIESSEN_PFC200,
  CODESYS_SATZ,
  EDGE_INDUSTRIE,
  FESTE_ADRESSE_FOLGE,
  PFC200_ANGESCHLOSSEN,
  PFC_BILD,
  PRUEFUNGEN_PFC200_WORT,
  SPS_SATZ,
  ZUGAENGE_SATZ,
  type PfcAnsicht,
  type PfcBild,
} from '../../werkstattPfc200';
import { DirektlinkQr } from './WerkstattTeile';

const ORANGE = '#E65100';

function MangoBild({ reset = false, lanOrange = true, titel }: { reset?: boolean; lanOrange?: boolean; titel: string }) {
  return (
    <svg className="vp-wsb-bild" viewBox="0 0 240 160" role="img" aria-label={titel}>
      <title>{titel}</title>
      <rect x="30" y="22" width="180" height="70" rx="14" fill="#FFFFFF" stroke="#CED4DA" strokeWidth="2" />
      {reset ? (
        <>
          <circle cx="196" cy="34" r="7" fill="#C62828" />
          <text x="196" y="16" fontSize="10" fontWeight="700" textAnchor="middle" fill="#C62828">Reset 10 s</text>
        </>
      ) : (
        <circle cx="196" cy="34" r="4" fill="#CED4DA" />
      )}
      <text x="120" y="44" fontSize="13" fontWeight="700" textAnchor="middle" fill="#1A1A1A">Mango</text>
      <text x="120" y="58" fontSize="10" textAnchor="middle" fill="#66717C">GL-MT300N-V2</text>
      <rect x="56" y="84" width="28" height="18" rx="3" fill="#ADB5BD" opacity="0.9" />
      <rect x="136" y="84" width="28" height="18" rx="3" fill={lanOrange ? ORANGE : '#ADB5BD'} opacity="0.9" />
      <text x="70" y="78" fontSize="10" fontWeight="700" textAnchor="middle" fill="#1A1A1A">WAN</text>
      <text x="150" y="78" fontSize="10" fontWeight="700" textAnchor="middle" fill="#1A1A1A">LAN</text>
      <rect x="206" y="48" width="10" height="16" rx="2" fill="#ADB5BD" />
      <path d="M216 56 L232 56" stroke="#ADB5BD" strokeWidth="4" strokeLinecap="round" />
      <text x="224" y="44" fontSize="9" textAnchor="middle" fill="#66717C">Strom</text>
      {lanOrange && (
        <>
          <path d="M150 100 L150 140" stroke={ORANGE} strokeWidth="7" strokeLinecap="round" />
          <text x="160" y="134" fontSize="11" fontWeight="700" fill={ORANGE}>{reset ? 'bleibt stecken' : 'WERKSTATT'}</text>
          {!reset && <text x="70" y="122" fontSize="10" textAnchor="middle" fill="#66717C">bleibt frei</text>}
        </>
      )}
    </svg>
  );
}

function PiBild() {
  return (
    <svg className="vp-wsb-bild vp-wsb-bild-klein" viewBox="0 0 240 160" role="img" aria-label="Brücke (Raspberry Pi)">
      <rect x="40" y="30" width="160" height="100" rx="10" fill="#E8F5E9" stroke="#2E7D4F" strokeWidth="2" />
      <rect x="60" y="52" width="40" height="30" rx="3" fill="#ADB5BD" />
      <rect x="150" y="96" width="34" height="22" rx="3" fill="#ADB5BD" />
      <circle cx="176" cy="48" r="6" fill="#2E7D4F" />
      <text x="120" y="122" fontSize="12" fontWeight="700" textAnchor="middle" fill="#2E7D4F">Pi</text>
    </svg>
  );
}

function StartladerBild() {
  return (
    <svg className="vp-wsb-bild" viewBox="0 0 240 160" role="img" aria-label="Rechner in der LAN-Buchse der Mango statt des orangen Kabels, Reset halten und Strom stecken">
      <rect x="8" y="40" width="120" height="50" rx="12" fill="#FFFFFF" stroke="#CED4DA" strokeWidth="2" />
      <text x="68" y="62" fontSize="12" fontWeight="700" textAnchor="middle" fill="#1A1A1A">Mango</text>
      <circle cx="114" cy="50" r="6" fill="#C62828" />
      <text x="114" y="32" fontSize="9" fontWeight="700" textAnchor="middle" fill="#C62828">Reset halten</text>
      <path d="M68 90 L68 120 L170 120" stroke="#2C5282" strokeWidth="5" fill="none" strokeLinecap="round" />
      <rect x="160" y="70" width="70" height="44" rx="4" fill="#E9ECEF" stroke="#ADB5BD" />
      <rect x="150" y="114" width="90" height="8" rx="3" fill="#ADB5BD" />
      <text x="195" y="96" fontSize="10" textAnchor="middle" fill="#2C5282">192.168.1.1</text>
      <text x="61" y="106" fontSize="9" fontWeight="700" textAnchor="end" fill="#2C5282">LAN</text>
      <text x="120" y="146" fontSize="10" textAnchor="middle" fill="#66717C">Rechner in LAN statt orangem Kabel</text>
    </svg>
  );
}

const SCHALTER_Y: Record<PfcAnsicht['schalter'], number> = { run: 70, stop: 88, reset: 106 };

/**
 * Die Front eines PFC200 als Schema: Leuchte SYS, Betriebsartenschalter (RUN, STOP, RESET), Reset-Taster (RST) und
 * die zwei Netzbuchsen X1 und X2. Kein Foto und nicht maßstäblich: Es zeigt, was der Handgriff stellt.
 */
export function PfcZeichnung({ ansicht, titel, klein = false }: { ansicht: PfcAnsicht; titel: string; klein?: boolean }) {
  const { schalter, rst, sys, kabel } = ansicht;
  const marke = (pos: PfcAnsicht['schalter'], text: string) => (
    <text x="56" y={SCHALTER_Y[pos] + 3.5} fontSize="10" fontWeight={schalter === pos ? 700 : 400} fill={schalter === pos ? (pos === 'run' ? '#2E7D4F' : '#C62828') : '#66717C'}>
      {text}
    </text>
  );
  const buchse = (name: 'x1' | 'x2', y: number) => (
    <>
      <rect x="34" y={y} width="22" height="16" rx="2" fill={kabel === name ? ORANGE : '#ADB5BD'} opacity="0.9" />
      <text x="62" y={y + 12} fontSize="10" fontWeight="700" fill="#1A1A1A">{name.toUpperCase()}</text>
      {kabel === name && <path d={`M34 ${y + 8} L6 ${y + 8}`} stroke={ORANGE} strokeWidth="6" strokeLinecap="round" />}
    </>
  );
  return (
    <svg className={`vp-wsb-bild vp-wsb-pfc${klein ? ' vp-wsb-bild-klein' : ''}`} viewBox="0 0 136 190" role="img" aria-label={titel} data-schalter={schalter} data-rst={rst ? 'ja' : 'nein'} data-sys={sys} data-kabel={kabel ?? 'keins'}>
      <title>{titel}</title>
      <rect x="24" y="6" width="106" height="178" rx="6" fill="#FFFFFF" stroke="#CED4DA" strokeWidth="2" />
      <text x="77" y="22" fontSize="11" fontWeight="700" textAnchor="middle" fill="#1A1A1A">PFC200</text>
      <text x="77" y="33" fontSize="8" textAnchor="middle" fill="#66717C">750-8212</text>
      {sys === 'rotgruen' ? (
        <>
          <path d="M41 40 A6 6 0 0 0 41 52 Z" fill="#C62828" />
          <path d="M41 40 A6 6 0 0 1 41 52 Z" fill="#2E7D4F" />
        </>
      ) : (
        <circle cx="41" cy="46" r="6" fill={sys === 'orange' ? '#F59F00' : '#CED4DA'} />
      )}
      {sys !== 'aus' && <circle cx="41" cy="46" r="9" fill="none" stroke={sys === 'orange' ? '#F59F00' : '#C62828'} strokeWidth="1.5" strokeDasharray="3 3" />}
      <text x="56" y="49.5" fontSize="10" fontWeight={sys === 'aus' ? 400 : 700} fill={sys === 'aus' ? '#66717C' : '#1A1A1A'}>
        SYS{sys === 'orange' ? ' orange' : sys === 'rotgruen' ? ' rot/grün' : ''}
      </text>
      <rect x="34" y="62" width="14" height="52" rx="5" fill="#E9ECEF" stroke="#ADB5BD" />
      <circle cx="41" cy={SCHALTER_Y[schalter]} r="6" fill={schalter === 'run' ? '#2E7D4F' : '#C62828'} />
      {marke('run', 'RUN')}
      {marke('stop', 'STOP')}
      {marke('reset', 'RESET')}
      <circle cx="41" cy="126" r="4" fill={rst ? '#C62828' : '#CED4DA'} stroke={rst ? '#C62828' : '#ADB5BD'} />
      {rst && <path d="M4 126 L34 126" stroke="#1A1A1A" strokeWidth="3" strokeLinecap="round" />}
      <text x="56" y="129.5" fontSize="10" fontWeight={rst ? 700 : 400} fill={rst ? '#C62828' : '#66717C'}>
        RST{rst ? ' halten' : ''}
      </text>
      {buchse('x1', 140)}
      {buchse('x2', 162)}
    </svg>
  );
}

/**
 * Ein Handgriff am PFC200 in Bildern: je Teilschritt das Gerät, darunter in einem Satz, was zu tun ist.
 * `inKarte`: Das Bild steht schon in einer Karte mit eigener Überschrift; dann ohne Rahmen und ohne Titel.
 */
function HandgriffBild({ bild, inKarte = false }: { bild: PfcBild; inKarte?: boolean }) {
  const b = PFC_BILD[bild];
  return (
    <figure className={`vp-wsb-handgriff${inKarte ? '' : ' vp-wsb-karte'}`} data-testid="wsb-bild" data-bild={bild} aria-label={b.titel}>
      {!inKarte && <figcaption>{b.titel}</figcaption>}
      <ol>
        {b.schritte.map((s, i) => (
          <li key={s.kurz}>
            <PfcZeichnung ansicht={s.bild} titel={s.text} />
            <span>
              {b.schritte.length > 1 && <b>{i + 1}. </b>}
              {s.kurz}
            </span>
          </li>
        ))}
      </ol>
      <small>Schema der Front, nicht maßstäblich.</small>
    </figure>
  );
}

function istPfcBild(bild: Bild): bild is PfcBild {
  return bild.startsWith('pfc-');
}

function FallBild({ bild }: { bild: Bild }) {
  if (istPfcBild(bild)) return <HandgriffBild bild={bild} />;
  return (
    <div className="vp-wsb-karte vp-wsb-bildkarte" data-testid="wsb-bild" data-bild={bild}>
      {bild === 'reset' ? (
        <MangoBild reset titel="Reset-Knopf der Mango 10 Sekunden halten, oranges Kabel bleibt in LAN" />
      ) : bild === 'startlader' ? (
        <StartladerBild />
      ) : bild === 'pi' ? (
        <PiBild />
      ) : (
        <MangoBild titel="Oranges Kabel WERKSTATT in LAN, WAN bleibt frei, Strom an der Seite" />
      )}
    </div>
  );
}

type Punkt = 'ok' | 'lauf' | 'offen' | 'warn';

function Punktliste({
  zeilen,
  testId,
  uhr,
}: {
  zeilen: { zustand: Punkt; text: string; klein?: string; tut?: string; seit?: string | null }[];
  testId: string;
  /** Jetzt-Zeitstempel (ms), damit ein wiederholter Check sein Lebenszeichen mitzählt (E1). */
  uhr?: number;
}) {
  return (
    <ul className="vp-wsb-liste" data-testid={testId}>
      {zeilen.map((z) => {
        const seitSek = uhr != null ? liveSeitSek(z.seit, uhr) : null;
        return (
          <li key={z.text} className={`vp-wsb-zeile vp-wsb-${z.zustand}`} data-zustand={z.zustand}>
            <span className="vp-wsb-punkt" aria-hidden>
              {z.zustand === 'ok' ? '✓' : z.zustand === 'warn' ? '!' : ''}
            </span>
            <span>
              {z.text}
              {z.klein && <small>{z.klein}</small>}
              {z.tut && <small data-testid="wsb-live-tut">{z.tut}</small>}
              {seitSek != null && (
                <small data-testid="wsb-live-seit">zuletzt geprüft {seitText(seitSek)}</small>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Schritte({ eintraege }: { eintraege: ReactNode[] }) {
  return (
    <ol className="vp-wsb-schritte">
      {eintraege.map((e, i) => (
        <li key={i}>
          <span>{e}</span>
        </li>
      ))}
    </ol>
  );
}

function Details({ titel, children }: { titel: string; children: ReactNode }) {
  return (
    <details className="vp-wsb-details" data-testid="wsb-details">
      <summary>{titel}</summary>
      <div>{children}</div>
    </details>
  );
}

export function PhasenListe({ lauf }: { lauf: LaufStand }) {
  return (
    <Punktliste
      testId="wsb-phasen"
      zeilen={phasen(lauf).map((p: Phase) => ({ zustand: p.zustand, text: p.titel, klein: p.zustand === 'offen' ? undefined : p.klein }))}
    />
  );
}

function Zeile({ dt, dd }: { dt: string; dd: ReactNode }) {
  return (
    <>
      <dt>{dt}</dt>
      <dd>{dd}</dd>
    </>
  );
}

function TechnikDetails({ lauf, fall, anschluss }: { lauf: LaufStand | null; fall?: string; anschluss?: string }) {
  return (
    <Details titel="Details für Technik">
      <dl className="vp-wsb-technik">
        {fall && <Zeile dt="Fall" dd={<code data-testid="wsb-fall-code">{fall}</code>} />}
        {!lauf && <Zeile dt="Anschluss" dd={anschluss ?? 'kein Lauf'} />}
        {lauf && (
          <>
            <Zeile dt="Lauf" dd={lauf.kennung} />
            {lauf.box && <Zeile dt="Box" dd={lauf.box} />}
            <Zeile dt="Schritt" dd={lauf.titel ? `${lauf.titel} (${lauf.schritt})` : lauf.schritt ?? '–'} />
            <Zeile dt="Erledigt" dd={lauf.erledigt.join(', ') || '–'} />
            {lauf.grund && <Zeile dt="Grund" dd={lauf.grund} />}
            {lauf.handgriff && <Zeile dt="Handgriff" dd={lauf.handgriff} />}
          </>
        )}
      </dl>
    </Details>
  );
}

// ── Lauf-Seite: Bausteine ──────────────────────────────────────────────────

function SoftwareKarte({ sw, titel, neuer, testId = 'wsb-software' }: { sw: Software; titel: string; neuer: string | null; testId?: string }) {
  const paket = (p: Software['pakete'][number]) => (
    <div className="vp-wsl-paket" key={p.id} data-testid={`wsb-soft-${p.id}`}>
      <strong>
        {p.name} {p.fassung}
      </strong>
      <span className={`vp-wsl-pruef${p.ok ? '' : ' offen'}`}>{p.pruef}</span>
      <span className="vorher">
        vorher: {p.vorher == null ? 'noch nicht gelesen' : p.ersetzt ? <s>{p.vorher}</s> : p.vorher}
        {p.sha && <> · sha256 {p.sha}</>}
      </span>
    </div>
  );
  return (
    <div className="vp-wsl-soft" data-testid={testId}>
      <h5>{titel}</h5>
      <p className="frg">
        Freigabe <b>{sw.freigabe}</b>
      </p>
      {sw.pakete.map(paket)}
      {sw.geraet === 'pfc200' && (
        <div className="vp-wsl-paket" data-testid="wsb-soft-firmware">
          <strong>Firmware des PFC200</strong>
          <span className="vp-wsl-pruef offen">bleibt, wie sie ist</span>
          <span className="vorher">
            {sw.firmware ?? 'noch nicht gelesen'} · Die Werkstatt liest sie nur und prüft sie nicht.
          </span>
        </div>
      )}
      {neuer && sw.geraet === 'mango' && (
        <p className="neuer" data-testid="wsb-soft-neuer">
          Neuer erschienen: Edge Light {neuer}. Diese Box bleibt bei ihrer Fassung und holt sie beim ersten Verbinden
          selbst; die nächste bekommt die neueste.
        </p>
      )}
    </div>
  );
}

/** Auf dem Telefon: die Software als eine Zeile, aufklappbar. */
function SoftwareZeile({ sw, titel, neuer }: { sw: Software; titel: string; neuer: string | null }) {
  return (
    <details className="vp-wsl-soft-zeile" data-testid="wsb-software-zeile">
      <summary>
        <span>{titel === 'Auf dieser Box' ? 'Drauf:' : 'Kommt drauf:'}</span>
        {sw.kurz.map((k) => (
          <b key={k}>{k}</b>
        ))}
      </summary>
      <SoftwareKarte sw={sw} titel={titel} neuer={neuer} testId="wsb-software-telefon" />
    </details>
  );
}

function SchrittListe({ phasen: ph, testId = 'wsb-schritte' }: { phasen: PhasenZeile[]; testId?: string }) {
  return (
    <div data-testid={testId}>
      {ph.map((p) => (
        <div key={p.id} className={`vp-wsl-phase ${p.zustand}`} data-phase={p.id} data-zustand={p.zustand}>
          <div className="ph">
            <span className={`vp-wsb-zeile vp-wsb-${p.zustand} vp-wsl-phasenpunkt`}>
              <span className="vp-wsb-punkt" aria-hidden>{p.zustand === 'ok' ? '✓' : p.zustand === 'warn' ? '!' : ''}</span>
            </span>
            <span>
              {p.titel}
              {p.zustand === 'offen' && <small> · {p.schritte.length === 1 ? '1 Schritt' : `${p.schritte.length} Schritte`}</small>}
            </span>
            <small>{p.rechts}</small>
          </div>
          {p.zustand !== 'offen' && (
            <ul className="vp-wsl-schritte">
              {p.schritte.map((s) => (
                <li key={s.schritt} className={`vp-wsl-s ${s.zustand}`} data-schritt={s.schritt} data-zustand={s.zustand}>
                  <span className="m" aria-hidden>{s.zustand === 'ok' ? '✓' : s.zustand === 'warn' ? '!' : ''}</span>
                  <span>
                    {s.titel}
                    {s.beleg && <small data-testid="wsb-beleg">{s.beleg}</small>}
                    {s.zustand === 'lauf' && <small>läuft gerade</small>}
                    {s.zustand === 'warn' && <small>hier angehalten</small>}
                  </span>
                  <span className="d">{s.dauer ?? ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function minuten(sek: number): string {
  const m = Math.round(sek / 60);
  return m < 1 ? 'unter 1 Min' : `${m} Min`;
}

function JetztKarte({ lauf, meist, uhr }: { lauf: LaufStand; meist: Record<string, number>; uhr: number }) {
  const j = jetztKarte(lauf, meist, uhr);
  if (!j) return null;
  return (
    <div className="vp-wsl-jetzt" data-testid="wsb-jetzt" data-schritt={j.schritt}>
      <span className="ueber">
        Jetzt · Schritt {j.nummer} von {j.von}
      </span>
      <h4>{j.titel}</h4>
      <p>{j.tut}</p>
      <p className="vp-wsl-zeiten">
        {j.seitSek != null && (
          <span>
            läuft seit <b>{dauerText(j.seitSek)}</b>
          </span>
        )}
        {j.meistSek != null && <span>meist {minuten(j.meistSek)}</span>}
        {j.fristSek != null && <span>Frist {minuten(j.fristSek)}</span>}
      </p>
      {j.danach && (
        <p className="vp-wsl-danach">
          Danach: <b>{j.danach}</b>
          {j.dann.length > 0 && <>, dann {j.dann.join(', ')}</>}.
        </p>
      )}
    </div>
  );
}

function BoxKarte({ lauf, ansicht }: { lauf: LaufStand; ansicht: WerkstattAnsicht }) {
  const antwort = (ansicht.werkbank.status?.antworten ?? []).find((a) => (a.macs ?? []).length > 0) ?? null;
  return (
    <div className="vp-wsb-karte vp-wsl-boxkarte" data-testid="wsb-box">
      <h5>Diese Box</h5>
      <dl className="vp-wsl-box">
        <Zeile dt="MAC" dd={antwort?.macs?.[0] ?? '–'} />
        <Zeile dt="Adresse" dd={antwort?.adresse ?? '–'} />
        <Zeile dt="Referenz" dd={lauf.box ?? `erscheint mit ${geraetVon(lauf.box_art) === 'pfc200' ? EDGE_INDUSTRIE : 'Edge Light'}`} />
        <Zeile dt="Lauf" dd={`seit ${uhrzeit(lauf.beginn)} · ${lauf.kennung}`} />
      </dl>
    </div>
  );
}

const BANNER: Record<FallSeite['art'], { klasse: string; text: string; satz: string }> = {
  warten: { klasse: '', text: 'Der Dienst wartet.', satz: 'Du musst nichts tun.' },
  hand: { klasse: ' vp-wsb-warn', text: 'Einmal kurz du.', satz: 'Danach macht der Dienst weiter.' },
  seite: { klasse: ' vp-wsb-fehl', text: 'Zur Seite legen.', satz: 'Diese Box geht nicht ins Lager.' },
};

interface Aktionen {
  onUebersicht: () => void;
  onBox: (ref: string) => void;
  onNochmal: (lauf: string) => Promise<void>;
  onZurSeite: (lauf: string) => Promise<void>;
}

function KnopfLeiste({
  knoepfe,
  lauf,
  ansicht,
  aktionen,
}: {
  knoepfe: Knopf[];
  lauf: LaufStand | null;
  ansicht: WerkstattAnsicht;
  aktionen: Aktionen;
}) {
  const [laeuft, setLaeuft] = useState<string | null>(null);
  const [gesendet, setGesendet] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  if (knoepfe.length === 0) return null;
  const tue = async (art: string, f: () => Promise<void>) => {
    setLaeuft(art);
    setFehler(null);
    try {
      await f();
      if (art === 'nochmal') setGesendet(true);
    } catch (e) {
      setFehler(e instanceof Error && e.message ? e.message : 'Das hat nicht geklappt. Bitte noch einmal.');
    } finally {
      setLaeuft(null);
    }
  };
  const f = ansicht.freigabe.freigabe;
  const abbild = f?.openwrt.quelle && f.openwrt.datei ? `${f.openwrt.quelle.replace(/\/?$/, '/')}${f.openwrt.datei}` : null;
  return (
    <div className="vp-wsl-knoepfe" data-testid="wsb-knoepfe">
      {knoepfe.map((k) => {
        const testId = `wsb-knopf-${k.art}`;
        const klick = (): void => {
          switch (k.art) {
            case 'nochmal':
              if (lauf) void tue('nochmal', () => aktionen.onNochmal(lauf.kennung));
              break;
            case 'zur-seite':
              if (lauf) void tue('zur-seite', () => aktionen.onZurSeite(lauf.kennung));
              break;
            case 'box-oeffnen':
              if (lauf?.box) aktionen.onBox(lauf.box);
              break;
            default:
              aktionen.onUebersicht();
          }
        };
        if (k.art === 'abbild') {
          return abbild ? (
            <a key={k.art} className="vp-btn vp-btn--md vp-btn--outline" href={abbild} target="_blank" rel="noreferrer" data-testid={testId}>
              {k.text}
            </a>
          ) : null;
        }
        if (k.art === 'nochmal' && gesendet) {
          return (
            <p key={k.art} className="vp-wsb-hinweis" data-testid="wsb-nochmal-gesendet">
              <strong>Gesendet.</strong> Der Dienst holt den Auftrag mit seiner nächsten Meldung ab (etwa alle 10 Sekunden) und
              beginnt neu.
            </p>
          );
        }
        return k.stil === 'leise' ? (
          <button key={k.art} type="button" className="vp-wsb-leise" onClick={klick} disabled={laeuft != null} data-testid={testId}>
            {k.text}
          </button>
        ) : (
          <Button key={k.art} variant={k.stil} onClick={klick} disabled={laeuft != null} data-testid={testId}>
            {laeuft === k.art ? 'Wird gesendet …' : k.text}
          </Button>
        );
      })}
      {fehler && (
        <p className="vp-wsb-hinweis vp-wsb-fehl" role="alert" data-testid="wsb-knopf-fehler">
          {fehler}
        </p>
      )}
    </div>
  );
}

/** Die Seite eines Falls (angehaltener Lauf oder Fall am Anschluss). */
function FallHaupt({
  seite,
  lauf,
  ansicht,
  aktionen,
  uhr,
}: {
  seite: FallSeite;
  lauf: LaufStand | null;
  ansicht: WerkstattAnsicht;
  aktionen: Aktionen;
  uhr: number;
}) {
  const b = BANNER[seite.art];
  return (
    <>
      <p className={`vp-wsb-hinweis${b.klasse}`} data-testid="wsb-fall-banner" data-art={seite.art}>
        <strong>{b.text}</strong> {b.satz}
      </p>
      <h4 className="vp-wsb-h" data-testid="wsb-fall-titel">{seite.titel}</h4>
      <p className="vp-wsb-sub" data-testid="wsb-fall-was">{seite.was}</p>
      {seite.bilder.map((b) => (
        <FallBild key={b} bild={b} />
      ))}
      <div className="vp-wsb-karte" data-testid="wsb-loesung" data-fall={seite.code}>
        <h5>Was du tun kannst</h5>
        <Schritte eintraege={seite.schritte} />
      </div>
      {lauf?.nochmal_seit ? (
        <p className="vp-wsb-hinweis vp-wsb-ok" data-testid="wsb-nochmal-laeuft">
          <strong>Der Dienst versucht es noch einmal.</strong> Gleich beginnt ein neuer Lauf.
        </p>
      ) : seite.selbst ? (
        <>
          <div className="vp-wsl-selbst ja" data-testid="wsb-selbst" data-selbst="ja">
            <span aria-hidden>↻</span>
            <span>
              <b>Der Dienst macht von selbst weiter.</b>
              {seite.live.length > 0 && ' Hier siehst du es:'}
            </span>
          </div>
          {seite.live.length > 0 && (
            <div className="vp-wsb-karte">
              <Punktliste testId="wsb-live" zeilen={seite.live} uhr={uhr} />
            </div>
          )}
        </>
      ) : (
        <div className="vp-wsl-selbst nein" data-testid="wsb-selbst" data-selbst="nein">
          <span aria-hidden>■</span>
          <span>
            <b>Hier geht es nicht von selbst weiter.</b> Der Dienst fasst diese Box nicht an.
          </span>
        </div>
      )}
      {seite.nach && <p className="vp-wsb-sub vp-wsl-nach">{seite.nach}</p>}
      <KnopfLeiste knoepfe={seite.knoepfe} lauf={lauf} ansicht={ansicht} aktionen={aktionen} />
    </>
  );
}

// ── Die Werkbank ───────────────────────────────────────────────────────────

export function WerkstattBank({
  dienst,
  stand,
  freigaben = [],
  freigabenPfc200 = [],
  neuerEdgeLight = null,
  onUebersicht,
  onBox = () => {},
  onNochmal = async () => {},
  onZurSeite = async () => {},
}: {
  dienst: WerkstattDienst | null;
  /** Läuft die Werkstatt, und was spielt sie auf? `null`, solange der Stand nicht geladen ist. */
  stand: WerkstattStand | null;
  /** Die Freigaben als Beleg: ein Lauf zeigt die Fassungen seiner eigenen. */
  freigaben?: readonly WerkstattFreigabe[];
  /** Dasselbe für den PFC200 (eigene Zeilen der Regel). */
  freigabenPfc200?: readonly WerkstattFreigabePfc200[];
  /** Ein neueres signiertes Edge-Light-Release als die Freigabe des Laufs (nur Hinweis). */
  neuerEdgeLight?: string | null;
  onUebersicht: () => void;
  onBox?: (ref: string) => void;
  /** E1 A: „Nochmal versuchen“ als Auftrag an den Dienst. */
  onNochmal?: (lauf: string) => Promise<void>;
  /** E2 A: „Box zur Seite legen“ festhalten. Scheitert es, liegt sie hier trotzdem weg. */
  onZurSeite?: (lauf: string) => Promise<void>;
}) {
  /** Das Gerät, das an der Werkbank gewählt ist (M1 → M2); null: noch keines. */
  const [gewaehlt, setGewaehlt] = useState<Geraet | null>(null);
  const [erledigt, setErledigt] = useState<Set<string>>(() => new Set());
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [uhr, setUhr] = useState(() => Date.now());
  const s = useMemo(
    () => bildschirm({ dienst, gewaehlt: gewaehlt != null, geraet: gewaehlt ?? undefined, erledigt }),
    [dienst, gewaehlt, erledigt],
  );
  // Gemessene Dauern nur aus Läufen desselben Geräts: Ein Neustart der Mango sagt nichts über den des PFC200.
  const laufGeraet = s.art === 'laeuft' || s.art === 'du' || s.art === 'fertig' || s.art === 'fall' ? s.lauf?.box_art ?? null : null;
  const meist = useMemo(() => meistDauer(dienst?.laeufe ?? [], laufGeraet), [dienst, laufGeraet]);
  const weg = (kennung: string) => setErledigt((alt) => new Set([...alt, kennung]));
  const zweiSpalten = s.art === 'laeuft' || s.art === 'du' || s.art === 'fall' || s.art === 'fertig';

  // „läuft seit“ und das Lebenszeichen eines wiederholten Checks zählen zwischen den Meldungen weiter.
  useEffect(() => {
    if (s.art !== 'laeuft' && s.art !== 'du' && s.art !== 'fall') return undefined;
    const t = window.setInterval(() => setUhr(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [s.art]);
  useEffect(() => setUhr(Date.now()), [dienst]);

  const aktionen: Aktionen = {
    onUebersicht,
    onBox,
    onNochmal,
    onZurSeite: async (lauf) => {
      try {
        await onZurSeite(lauf);
        setHinweis(null);
      } catch (e) {
        setHinweis(`Zur Seite gelegt, aber nicht gespeichert: ${e instanceof Error ? e.message : 'unbekannter Fehler'}. Bitte Zettel „Problem“ nicht vergessen.`);
      }
      weg(lauf);
    },
  };

  const lauf = s.art === 'laeuft' || s.art === 'du' || s.art === 'fertig' ? s.lauf : s.art === 'fall' ? s.lauf : null;
  const ansicht = dienst?.ansicht ?? null;
  const sw = ansicht && zweiSpalten ? softwareKarte(ansicht, lauf, freigaben, freigabenPfc200, gewaehlt) : null;
  const swTitel = s.art === 'fertig' ? 'Auf dieser Box' : 'Kommt auf diese Box';
  // Das Gerät der Seite: das des Laufs, sonst das eines Falls am Anschluss, sonst das gewählte.
  const geraet: Geraet | null = lauf ? geraetVon(lauf.box_art) : s.art === 'fall' ? s.seite.geraet : gewaehlt;
  const krumen = s.art === 'fertig' && s.lauf.box ? `Werkstatt › ${s.lauf.box}` : geraet ? `Werkstatt › ${geraetWort(geraet)}` : 'Werkstatt';
  const pfcBereit = ansicht?.freigabe_pfc200 != null;

  const kopf = (
    <div className="vp-wsb-kopf">
      <span className="vp-wsb-krumen">
        {krumen}
        {lauf && s.art !== 'fertig' && s.art !== 'fall' && <> · Lauf seit {uhrzeit(lauf.beginn)}</>}
      </span>
      {gewaehlt && s.art !== 'kein-dienst' && (
        <button type="button" className="vp-wsb-leise" onClick={() => setGewaehlt(null)}>
          Zum Start
        </button>
      )}
    </div>
  );
  const unten = (
    <div className="vp-wsb-unten">
      <button type="button" className="vp-wsb-leise" onClick={onUebersicht} data-testid="wsb-uebersicht">
        Zur Übersicht
      </button>
    </div>
  );
  const hinweisZeile = hinweis && (
    <p className="vp-wsb-hinweis vp-wsb-warn" role="status" data-testid="wsb-hinweis">
      {hinweis}
    </p>
  );

  if (zweiSpalten && ansicht) {
    const phasenZeilen = lauf ? schrittListe(lauf, meist, uhr) : null;
    return (
      <div className="vp-wsl" data-testid="wsb" data-bildschirm={s.art} data-fall={s.art === 'fall' ? s.seite.code : undefined}>
        <div className="vp-wsl-kopf">{kopf}</div>
        <section className="vp-wsb vp-wsl-haupt" aria-live="polite">
          {hinweisZeile}
          {sw && <SoftwareZeile sw={sw} titel={swTitel} neuer={neuerEdgeLight} />}
          {(s.art === 'laeuft' || s.art === 'du') && <Laeuft lauf={s.lauf} meist={meist} uhr={uhr} phasen={phasenZeilen!} />}
          {s.art === 'fall' && <FallHaupt seite={s.seite} lauf={s.lauf} ansicht={ansicht} aktionen={aktionen} uhr={uhr} />}
          {s.art === 'fertig' && <Fertig lauf={s.lauf} onNaechste={() => weg(s.lauf.kennung)} onBox={onBox} />}
        </section>
        <aside className="vp-wsl-seite" aria-label="Software und Box">
          {sw && (
            <div className="vp-wsl-nur-breit">
              <SoftwareKarte sw={sw} titel={swTitel} neuer={neuerEdgeLight} />
            </div>
          )}
          {lauf && s.art !== 'fertig' && <BoxKarte lauf={lauf} ansicht={ansicht} />}
          {(s.art === 'laeuft' || s.art === 'du') && (
            <p className="vp-wsb-hinweis">
              <strong>Nicht abziehen.</strong> Braucht der Dienst dich, steht es hier.
            </p>
          )}
          {phasenZeilen && (s.art === 'fall' || s.art === 'fertig') && (
            <div className="vp-wsb-karte">
              <h5>{s.art === 'fertig' ? 'Alle Schritte' : 'Wo der Lauf steht'}</h5>
              <SchrittListe phasen={phasenZeilen} />
            </div>
          )}
          {s.art === 'fall' ? (
            <TechnikDetails lauf={s.lauf} fall={s.seite.code} anschluss={ansicht.anschluss} />
          ) : s.art !== 'fertig' && lauf ? (
            <TechnikDetails lauf={lauf} />
          ) : null}
        </aside>
        <div className="vp-wsl-fuss">{unten}</div>
      </div>
    );
  }

  return (
    <section className="vp-wsb" data-testid="wsb" data-bildschirm={s.art} aria-live="polite">
      {kopf}
      {hinweisZeile}

      {s.art === 'kein-dienst' && (
        <>
          <p className="vp-wsb-hinweis vp-wsb-fehl" data-testid="wsb-kein-dienst">
            <strong>Der Werkstatt-Dienst meldet sich nicht.</strong>
          </p>
          <p className="vp-wsb-sub">
            {s.alterSekunden == null
              ? 'Von ihm kam noch keine Meldung.'
              : `Seine letzte Meldung ist ${Math.round(s.alterSekunden / 60)} Minuten alt.`}{' '}
            Was hier stünde, wäre veraltet; darum steht hier nichts davon.
          </p>
          <div className="vp-wsb-karte">
            <h5>Was du tun kannst</h5>
            <Schritte
              eintraege={[
                'Keine Box anschließen und nichts abziehen, was gerade läuft.',
                'Ein paar Minuten warten; die Seite fragt von selbst wieder.',
                'Meldet er sich dann nicht: in der Technik Bescheid sagen.',
              ]}
            />
          </div>
        </>
      )}

      {s.art === 'start' && (
        <>
          <div className="vp-wsb-karte vp-wsb-stand" data-testid="wsb-stand" data-zustand={stand?.zustand ?? 'unbekannt'}>
            <div className="vp-wsb-reihe">
              <h5>{stand?.titel ?? 'Werkstatt'}</h5>
              {stand && <Badge variant={stand.badge.variant}>{stand.badge.text}</Badge>}
            </div>
            <p className="vp-wsb-sub">{stand?.zeile ?? 'Der Stand der Werkstatt ließ sich nicht laden.'}</p>
          </div>
          <h4 className="vp-wsb-h">Was willst du einrichten?</h4>
          <div className="vp-wsb-kacheln">
            <button type="button" className="vp-wsb-kachel" data-testid="wsb-mango" onClick={() => setGewaehlt('mango')}>
              <MangoBild lanOrange={false} titel="Mango" />
              <strong>Mango</strong>
              <small>kleiner weißer Router</small>
            </button>
            {/* Ohne Freigabe für den PFC200 in der Ansicht richtet dieser Dienst keine ein: Die Kachel sagt es, statt ins Leere zu führen. */}
            <button
              type="button"
              className="vp-wsb-kachel"
              data-testid="wsb-pfc200"
              disabled={!pfcBereit}
              aria-disabled={!pfcBereit}
              onClick={() => setGewaehlt('pfc200')}
            >
              <PfcZeichnung ansicht={{ ...PFC200_ANGESCHLOSSEN, kabel: null }} titel="WAGO PFC200" klein />
              <strong>PFC200</strong>
              <small>{pfcBereit ? `Steuerung von WAGO, wird ${EDGE_INDUSTRIE}` : 'der Dienst richtet hier keine PFC200 ein'}</small>
            </button>
            <button type="button" className="vp-wsb-kachel" disabled aria-disabled="true" data-testid="wsb-pi">
              <PiBild />
              <strong>Raspberry Pi</strong>
              <small>kommt mit der nächsten Stufe</small>
            </button>
          </div>
          <div className="vp-wsb-karte" data-testid="wsb-heute">
            <h5>Heute</h5>
            {dienst && heute(dienst.laeufe, new Date()).length > 0 ? (
              <ul className="vp-wsb-heute">
                {heute(dienst.laeufe, new Date()).map((h) => (
                  <li key={h.kennung}>
                    {h.zustand === 'fertig' ? (
                      <Badge variant="ok">fertig</Badge>
                    ) : h.zustand === 'angehalten' ? (
                      <Badge variant="warn">Problem</Badge>
                    ) : (
                      <Badge variant="tint">läuft {h.prozent} %</Badge>
                    )}
                    <span>{h.box ?? `${h.geraet} an der Werkbank`}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="vp-wsb-sub">Heute lief noch keine Box.</p>
            )}
          </div>
        </>
      )}

      {s.art === 'anschliessen' && s.geraet === 'pfc200' && (
        <>
          <h4 className="vp-wsb-h">PFC200 anschließen</h4>
          <p className="vp-wsb-sub">Kabel und Strom, dann einmal die feste Adresse geben. Den Rest macht der Dienst.</p>
          {!s.freigegeben && (
            <p className="vp-wsb-hinweis vp-wsb-warn" data-testid="wsb-nicht-freigegeben">
              <strong>Die Werkstatt richtet gerade keinen PFC200 ein.</strong> {s.grund} In der Übersicht siehst du, worauf sie
              wartet.
            </p>
          )}
          <FallBild bild="pfc-anschluss" />
          <Schritte eintraege={[...ANSCHLIESSEN_PFC200]} />
          {/* Ein PFC200 ab Werk hat an der Werkbank keine Adresse: Der Handgriff steht immer da, solange er nicht antwortet. */}
          <div className="vp-wsb-karte vp-wsb-stapel" data-testid="wsb-feste-adresse">
            <h5>Antwortet er nicht: feste Adresse geben</h5>
            <HandgriffBild bild="pfc-adresse" inKarte />
            <Schritte eintraege={PFC_BILD['pfc-adresse'].schritte.map((x) => x.text)} />
            <p className="vp-wsb-karte-fuss">{FESTE_ADRESSE_FOLGE}</p>
          </div>
          <div className="vp-wsb-karte">
            <h5>Wir warten auf den PFC200 …</h5>
            <Punktliste
              testId="wsb-warten"
              zeilen={[
                { zustand: s.kabel ? 'ok' : 'lauf', text: 'Kabel steckt' },
                { zustand: s.meldetSich ? 'ok' : s.kabel ? 'lauf' : 'offen', text: 'PFC200 meldet sich unter seiner festen Adresse' },
                { zustand: s.meldetSich ? 'lauf' : 'offen', text: 'PFC200 erkannt' },
              ]}
            />
          </div>
          <p className="vp-wsb-sub">Der Dienst sieht alle paar Sekunden nach. Einen Knopf brauchst du nicht.</p>
        </>
      )}

      {s.art === 'anschliessen' && s.geraet !== 'pfc200' && (
        <>
          <h4 className="vp-wsb-h">Mango anschließen</h4>
          <p className="vp-wsb-sub">Ein Kabel und Strom, dann macht der Dienst den Rest.</p>
          {!s.freigegeben && (
            <p className="vp-wsb-hinweis vp-wsb-warn" data-testid="wsb-nicht-freigegeben">
              <strong>Die Werkstatt richtet gerade keine Box ein.</strong>{' '}
              {stand && stand.zustand !== 'laeuft' ? stand.zeile : s.grund} In der Übersicht siehst du, warum, und kannst sie
              fortsetzen, wenn sie angehalten ist.
            </p>
          )}
          <div className="vp-wsb-karte vp-wsb-bildkarte">
            <MangoBild titel="Oranges Kabel WERKSTATT in LAN, WAN bleibt frei, Strom an der Seite" />
          </div>
          <Schritte
            eintraege={[
              <>
                Das <strong>orange Kabel WERKSTATT</strong> in die Buchse <strong>LAN</strong>.
              </>,
              'Strom anstecken.',
              'Warten. Hier siehst du, was passiert.',
            ]}
          />
          <p className="vp-wsb-hinweis">
            Die Buchse <strong>WAN</strong> bleibt frei.
          </p>
          <div className="vp-wsb-karte">
            <h5>Wir warten auf die Mango …</h5>
            <Punktliste
              testId="wsb-warten"
              zeilen={[
                { zustand: s.kabel ? 'ok' : 'lauf', text: 'Kabel steckt' },
                { zustand: s.meldetSich ? 'ok' : s.kabel ? 'lauf' : 'offen', text: 'Mango meldet sich' },
                { zustand: s.meldetSich ? 'lauf' : 'offen', text: 'Mango erkannt' },
              ]}
            />
          </div>
          <p className="vp-wsb-sub">Bis zu einer Minute nach dem Einstecken.</p>
        </>
      )}

      {unten}
    </section>
  );
}

function Laeuft({ lauf, meist, uhr, phasen: ph }: { lauf: LaufStand; meist: Record<string, number>; uhr: number; phasen: PhasenZeile[] }) {
  const f = fortschritt(lauf, meist);
  const name = geraetWort(geraetVon(lauf.box_art));
  return (
    <>
      {lauf.zustand === 'wartet' && (
        <p className="vp-wsb-hinweis vp-wsb-warn" data-testid="wsb-du">
          <strong>Einmal kurz du.</strong> <span data-testid="wsb-du-hinweis">{lauf.hinweis ?? 'Der Dienst wartet auf eine Eingabe.'}</span>
        </p>
      )}
      <h4 className="vp-wsb-h">{lauf.zustand === 'wartet' ? lauf.titel ?? 'Der Dienst wartet auf dich' : `${name} wird eingerichtet`}</h4>
      <p className="vp-wsb-sub" data-testid="wsb-restzeit">
        {f.restMinuten == null ? (
          // Ohne gemessene Dauern aus früheren Läufen nennt die Seite keine Minutenzahl.
          <>Wie lange es dauert, ist noch nicht gemessen · du kannst weggehen</>
        ) : (
          <>
            Noch ca. {f.restMinuten} {f.restMinuten === 1 ? 'Minute' : 'Minuten'} · fertig gegen{' '}
            {uhrzeit(new Date(uhr + f.restMinuten * 60_000).toISOString())} · du kannst weggehen
          </>
        )}
      </p>
      <div
        className="vp-wsb-balken"
        role="progressbar"
        aria-label="Fortschritt"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(f.anteil * 100)}
      >
        <span style={{ width: `${Math.round(f.anteil * 100)}%` }} />
      </div>
      <JetztKarte lauf={lauf} meist={meist} uhr={uhr} />
      <div className="vp-wsb-karte">
        <h5>Alle Schritte</h5>
        <SchrittListe phasen={ph} />
      </div>
    </>
  );
}

function Fertig({ lauf, onNaechste, onBox }: { lauf: LaufStand; onNaechste: () => void; onBox: (ref: string) => void }) {
  const ref = lauf.box ?? null;
  const dauer = lauf.ende ? Math.round((Date.parse(lauf.ende) - Date.parse(lauf.beginn)) / 60_000) : null;
  if (geraetVon(lauf.box_art) === 'pfc200') return <FertigPfc200 lauf={lauf} dauer={dauer} onNaechste={onNaechste} onBox={onBox} />;
  return (
    <>
      <p className="vp-wsb-hinweis vp-wsb-ok" data-testid="wsb-fertig">
        <strong>Fertig.</strong> Alle {PRUEFUNGEN_WORT} Prüfungen bestanden{dauer != null && dauer > 0 ? ` · ${dauer} Min` : ''}.
      </p>
      {ref && (
        <>
          <div className="vp-wsb-ref" data-testid="wsb-ref">{beschriftung(ref).klartext}</div>
          <div className="vp-wsb-qr">
            <DirektlinkQr edgeRef={ref} testId="wsb-qr" />
          </div>
        </>
      )}
      <div className="vp-wsb-karte">
        <h5>Jetzt du</h5>
        <Schritte
          eintraege={[
            'Gehäuse drucken (Druckdatei mit dieser Referenz, siehe Übersicht).',
            'Mango ins Gehäuse legen, Deckel drauf.',
            <>
              QR-Code mit dem Handy prüfen: es öffnet sich <strong>{ref ? beschriftung(ref).link.replace(/^https?:\/\//, '') : 'der Direktlink'}</strong>.
            </>,
            <>
              Ins Lager, Fach <strong>„Nicht versenden“</strong> (Stufe 1).
            </>,
          ]}
        />
      </div>
      <p className="vp-wsb-sub vp-wsb-versand">{VERSAND_SATZ}</p>
      <div className="vp-wsb-fuss">
        <Button onClick={onNaechste} data-testid="wsb-naechste">
          Nächste Box
        </Button>
        <span className="vp-wsb-sub">Kabel abziehen geht jetzt</span>
      </div>
    </>
  );
}

/**
 * Die Abschlussseite für einen PFC200: Referenz und QR-Code für das Schild (ein gedrucktes Gehäuse hat er nicht), und
 * was der Betreiber für CODESYS wissen muss: wo die drei Zugänge stehen und an welcher Buchse die Entwicklungsumgebung
 * das Gerät erreicht. Das Portal zeigt kein Passwort; es kann sie nicht lesen.
 */
function FertigPfc200({ lauf, dauer, onNaechste, onBox }: { lauf: LaufStand; dauer: number | null; onNaechste: () => void; onBox: (ref: string) => void }) {
  const ref = lauf.box ?? null;
  return (
    <>
      <p className="vp-wsb-hinweis vp-wsb-ok" data-testid="wsb-fertig">
        <strong>Fertig.</strong> Alle {PRUEFUNGEN_PFC200_WORT} Prüfungen bestanden{dauer != null && dauer > 0 ? ` · ${dauer} Min` : ''}.
      </p>
      {ref && (
        <>
          <div className="vp-wsb-ref" data-testid="wsb-ref">{beschriftung(ref).klartext}</div>
          <div className="vp-wsb-qr">
            <DirektlinkQr edgeRef={ref} testId="wsb-qr" />
          </div>
        </>
      )}
      <div className="vp-wsb-karte">
        <h5>Jetzt du</h5>
        <Schritte
          eintraege={[
            'Schild mit Referenz und QR-Code drucken (Vorlage auf der Seite der Box) und auf den PFC200 kleben.',
            <>
              QR-Code mit dem Handy prüfen: es öffnet sich <strong>{ref ? beschriftung(ref).link.replace(/^https?:\/\//, '') : 'der Direktlink'}</strong>.
            </>,
            <>
              Ins Lager, Fach <strong>„Nicht versenden“</strong> (Stufe 1).
            </>,
          ]}
        />
      </div>
      <div className="vp-wsb-karte" data-testid="wsb-codesys">
        <h5>CODESYS und Zugänge</h5>
        <ul className="vp-wsb-saetze">
          <li data-testid="wsb-codesys-zugaenge">{ZUGAENGE_SATZ}</li>
          <li data-testid="wsb-codesys-admin">{ADMIN_PASSWORT_SATZ}</li>
          <li>{CODESYS_SATZ}</li>
          <li>{SPS_SATZ}</li>
        </ul>
        {ref && (
          <Button variant="outline" size="sm" onClick={() => onBox(ref)} data-testid="wsb-zur-box">
            Seite der Box öffnen
          </Button>
        )}
      </div>
      <p className="vp-wsb-sub vp-wsb-versand">{VERSAND_SATZ}</p>
      <div className="vp-wsb-fuss">
        <Button onClick={onNaechste} data-testid="wsb-naechste">
          Nächste Box
        </Button>
        <span className="vp-wsb-sub">Kabel abziehen geht jetzt</span>
      </div>
    </>
  );
}
