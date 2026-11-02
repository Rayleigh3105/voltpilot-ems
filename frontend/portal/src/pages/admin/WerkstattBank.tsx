/**
 * Die Werkstatt-Bildschirme an der Werkbank (WI-8 A, Konzept Abschnitt 4,
 * M1–M6): ein geführter Ablauf, den auch Fremde schaffen. Eine Aufgabe je
 * Bildschirm, Bild statt Wort, das orange Kabel WERKSTATT wie an der Werkbank.
 * Der Dienst merkt Handgriffe selbst: Es gibt keinen „Weiter“-Knopf, und kein
 * Knopf hier kann an einer Box etwas kaputt machen. Welcher Bildschirm gilt,
 * entscheidet `werkstattBank.ts`.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { beschriftung, VERSAND_SATZ } from '../../werkstatt';
import {
  aktuellePhase,
  bildschirm,
  fortschritt,
  freigabeZeile,
  heute,
  phasen,
  type LaufStand,
  type Phase,
  type WerkstattDienst,
  type WerkstattFreigabe,
} from '../../werkstattBank';
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
          <text x="196" y="16" fontSize="10" fontWeight="700" textAnchor="middle" fill="#C62828">Reset</text>
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
          <text x="160" y="134" fontSize="11" fontWeight="700" fill={ORANGE}>WERKSTATT</text>
          <text x="70" y="122" fontSize="10" textAnchor="middle" fill="#66717C">bleibt frei</text>
        </>
      )}
    </svg>
  );
}

function PiBild() {
  return (
    <svg className="vp-wsb-bild vp-wsb-bild-klein" viewBox="0 0 240 160" role="img" aria-label="Raspberry Pi">
      <rect x="40" y="30" width="160" height="100" rx="10" fill="#E8F5E9" stroke="#2E7D4F" strokeWidth="2" />
      <rect x="60" y="52" width="40" height="30" rx="3" fill="#ADB5BD" />
      <rect x="150" y="96" width="34" height="22" rx="3" fill="#ADB5BD" />
      <text x="120" y="122" fontSize="12" fontWeight="700" textAnchor="middle" fill="#2E7D4F">Pi</text>
    </svg>
  );
}

type Punkt = 'ok' | 'lauf' | 'offen' | 'warn';

function Punktliste({ zeilen, testId }: { zeilen: { zustand: Punkt; text: string; klein?: string }[]; testId: string }) {
  return (
    <ul className="vp-wsb-liste" data-testid={testId}>
      {zeilen.map((z) => (
        <li key={z.text} className={`vp-wsb-zeile vp-wsb-${z.zustand}`} data-zustand={z.zustand}>
          <span className="vp-wsb-punkt" aria-hidden>
            {z.zustand === 'ok' ? '✓' : z.zustand === 'warn' ? '!' : ''}
          </span>
          <span>
            {z.text}
            {z.klein && <small>{z.klein}</small>}
          </span>
        </li>
      ))}
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

function TechnikDetails({ lauf }: { lauf: LaufStand }) {
  return (
    <Details titel="Details für Technik">
      <dl className="vp-wsb-technik">
        <dt>Lauf</dt>
        <dd>{lauf.kennung}</dd>
        {lauf.box && (
          <>
            <dt>Box</dt>
            <dd>{lauf.box}</dd>
          </>
        )}
        <dt>Schritt</dt>
        <dd>{lauf.titel ? `${lauf.titel} (${lauf.schritt})` : lauf.schritt ?? '–'}</dd>
        <dt>Erledigt</dt>
        <dd>{lauf.erledigt.join(', ') || '–'}</dd>
        {lauf.grund && (
          <>
            <dt>Grund</dt>
            <dd>{lauf.grund}</dd>
          </>
        )}
        {lauf.handgriff && (
          <>
            <dt>Handgriff</dt>
            <dd>{lauf.handgriff}</dd>
          </>
        )}
      </dl>
    </Details>
  );
}

export function WerkstattBank({
  dienst,
  freigabe,
  onUebersicht,
}: {
  dienst: WerkstattDienst | null;
  freigabe: WerkstattFreigabe | null;
  onUebersicht: () => void;
}) {
  const [gewaehlt, setGewaehlt] = useState(false);
  const [erledigt, setErledigt] = useState<Set<string>>(() => new Set());
  const s = useMemo(() => bildschirm({ dienst, gewaehlt, erledigt }), [dienst, gewaehlt, erledigt]);
  const weg = (kennung: string) => setErledigt((alt) => new Set([...alt, kennung]));
  const krumen = s.art === 'fertig' && s.lauf.box ? `Werkstatt › ${s.lauf.box}` : gewaehlt ? 'Werkstatt › Mango' : 'Werkstatt';

  return (
    <section className="vp-wsb" data-testid="wsb" data-bildschirm={s.art} aria-live="polite">
      <div className="vp-wsb-kopf">
        <span className="vp-wsb-krumen">{krumen}</span>
        {gewaehlt && s.art !== 'kein-dienst' && (
          <button type="button" className="vp-wsb-leise" onClick={() => setGewaehlt(false)}>
            Zum Start
          </button>
        )}
      </div>

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
          <div className="vp-wsb-karte" data-testid="wsb-freigabe">
            <h5>{freigabe ? 'Werkstatt freigegeben' : 'Werkstatt nicht freigegeben'}</h5>
            {freigabe ? (
              <>
                <div className="vp-wsb-reihe">
                  <strong>Mango</strong>
                  <Badge variant="ok">{dienst?.ansicht?.freigabe.boxen ?? 0} eingerichtet</Badge>
                </div>
                <p className="vp-wsb-sub">{freigabeZeile(freigabe)}</p>
              </>
            ) : (
              <p className="vp-wsb-sub">Ohne Freigabe richtet der Dienst keine Box ein. Ein Admin gibt sie in der Übersicht frei.</p>
            )}
          </div>
          <h4 className="vp-wsb-h">Was willst du einrichten?</h4>
          <div className="vp-wsb-kacheln">
            <button type="button" className="vp-wsb-kachel" data-testid="wsb-mango" onClick={() => setGewaehlt(true)}>
              <MangoBild lanOrange={false} titel="Mango" />
              <strong>Mango</strong>
              <small>kleiner weißer Router</small>
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
                    <span>{h.box ?? 'Mango an der Werkbank'}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="vp-wsb-sub">Heute lief noch keine Box.</p>
            )}
          </div>
        </>
      )}

      {s.art === 'anschliessen' && (
        <>
          <h4 className="vp-wsb-h">Mango anschließen</h4>
          <p className="vp-wsb-sub">Ein Kabel und Strom, dann macht der Dienst den Rest.</p>
          {!s.freigegeben && (
            <p className="vp-wsb-hinweis vp-wsb-warn" data-testid="wsb-nicht-freigegeben">
              <strong>Noch nicht freigegeben.</strong> {s.grund} Ein Admin gibt die Werkstatt in der Übersicht frei; bis dahin
              richtet der Dienst keine Box ein.
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

      {s.art === 'laeuft' && <Laeuft lauf={s.lauf} />}

      {s.art === 'du' && (
        <>
          <p className="vp-wsb-hinweis vp-wsb-warn">
            <strong>Einmal kurz du</strong>
          </p>
          <h4 className="vp-wsb-h">{s.lauf.titel ?? 'Der Dienst wartet auf dich'}</h4>
          <p className="vp-wsb-sub" data-testid="wsb-du-hinweis">{s.lauf.hinweis ?? 'Der Dienst wartet auf eine Eingabe.'}</p>
          <PhasenListe lauf={s.lauf} />
          <TechnikDetails lauf={s.lauf} />
        </>
      )}

      {s.art === 'startlader' && (
        <>
          <p className="vp-wsb-hinweis vp-wsb-warn">
            <strong>Einmal kurz du</strong>
          </p>
          <h4 className="vp-wsb-h">Reset-Knopf drücken</h4>
          <p className="vp-wsb-sub">Die Werksfirmware dieser Mango nimmt das neue System nicht an. Dann hilft ihr Startlader.</p>
          <div className="vp-wsb-karte vp-wsb-bildkarte">
            <MangoBild reset titel="Reset-Knopf der Mango, oranges Kabel bleibt in LAN" />
          </div>
          <Schritte
            eintraege={[
              'Strom abziehen.',
              <>
                Den <strong>Reset-Knopf</strong> gedrückt halten und Strom wieder anstecken.
              </>,
              'Nach etwa fünf Sekunden loslassen, wenn die Leuchte blinkt.',
            ]}
          />
          <p className="vp-wsb-hinweis">Danach das neue System hochladen, wie unter „Details für Technik“ beschrieben.</p>
          <p className="vp-wsb-hinweis vp-wsb-ok">Das orange Kabel bleibt stecken. Den Rest macht der Dienst.</p>
          <TechnikDetails lauf={s.lauf} />
          <div className="vp-wsb-fuss">
            <button type="button" className="vp-wsb-leise" onClick={() => weg(s.lauf.kennung)}>
              Box zur Seite legen
            </button>
          </div>
        </>
      )}

      {s.art === 'fertig' && <Fertig lauf={s.lauf} onNaechste={() => weg(s.lauf.kennung)} />}

      {s.art === 'problem' && (
        <>
          <p className="vp-wsb-hinweis vp-wsb-fehl" data-testid="wsb-problem">
            <strong>Hier hat etwas nicht geklappt.</strong>
          </p>
          <h4 className="vp-wsb-h">{aktuellePhase(s.lauf)?.titel ?? 'Angehalten'}</h4>
          <p className="vp-wsb-sub">Die Box ist nicht fertig und geht nicht ins Lager.</p>
          <div className="vp-wsb-karte">
            <h5>Was du tun kannst</h5>
            <Schritte
              eintraege={[
                <>
                  Das orange Kabel kurz abziehen und wieder einstecken: der Dienst <strong>versucht es noch einmal</strong>.
                </>,
                'Klappt es wieder nicht: zur Seite legen, Zettel „Problem“ drauf. Der Grund bleibt hier für die Technik stehen.',
              ]}
            />
          </div>
          <div className="vp-wsb-fuss">
            <Button variant="outline" onClick={() => weg(s.lauf.kennung)} data-testid="wsb-zur-seite">
              Box zur Seite legen
            </Button>
          </div>
          <TechnikDetails lauf={s.lauf} />
        </>
      )}

      <div className="vp-wsb-unten">
        <button type="button" className="vp-wsb-leise" onClick={onUebersicht} data-testid="wsb-uebersicht">
          Zur Übersicht
        </button>
      </div>
    </section>
  );
}

function Laeuft({ lauf }: { lauf: LaufStand }) {
  const f = fortschritt(lauf);
  return (
    <>
      <h4 className="vp-wsb-h">Mango wird eingerichtet</h4>
      <p className="vp-wsb-sub" data-testid="wsb-restzeit">
        Noch ca. {f.restMinuten} {f.restMinuten === 1 ? 'Minute' : 'Minuten'} · du kannst weggehen
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
      <PhasenListe lauf={lauf} />
      <p className="vp-wsb-hinweis">
        <strong>Nicht abziehen.</strong> Wenn der Dienst etwas von dir braucht, steht es hier.
      </p>
      <TechnikDetails lauf={lauf} />
    </>
  );
}

function Fertig({ lauf, onNaechste }: { lauf: LaufStand; onNaechste: () => void }) {
  const ref = lauf.box ?? null;
  return (
    <>
      <p className="vp-wsb-hinweis vp-wsb-ok" data-testid="wsb-fertig">
        <strong>Fertig.</strong> Alle acht Prüfungen bestanden.
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
