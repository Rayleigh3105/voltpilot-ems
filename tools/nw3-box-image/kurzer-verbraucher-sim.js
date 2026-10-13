/**
 * Szenario-Simulator fuer den Zusatzlauf „Lade-Viertelstunde mit kurzem
 * Verbraucher" (kurzer-verbraucher.sh).
 *
 * Laeuft IM Simulator-Bild des Tags (`FROM nw3-edge-sim:<ref>`): das Modell ist
 * `sim-model.js` DES TAGS, unveraendert - Register, Vorzeichen, Totzeit des
 * Sollwerts und Messtakt stammen von dort. Ersetzt wird nur der Server
 * `sunspec-sim.js`, und nur aus einem Grund: er verdrahtet PV und Hauslast fest
 * als Zwei-Minuten-Sinus, und das Modell nimmt eine eigene Kurve nur ueber den
 * Konstruktor an (`pvKw`, `loadKw`), nicht ueber SIM_*-Variablen.
 *
 * Der Fall ist der des Prueflaufs im Tag
 * (edge-app/core/internal/agent/surplus_short_consumer_scenario_test.go,
 * herzogauBenchScenario, Herzogau 10.10.2026): gleichmaessige PV, ein kleiner
 * Ueberschuss, und ein Verbraucher, der groesser ist als der Ueberschuss und nur
 * 10-15 s laeuft. Der Ueberschuss kommt in ABSCHNITTEN (SZ_ABSCHNITTE,
 * "kW:bis_sekunde,..."): erst einer, den die Box sichtbar laedt, dann einer in
 * Hoehe der Reserve des Folgers - dort steht der Sollwert schon vor dem
 * Verbraucher auf 0, obwohl die Viertelstunde ein Laden plant.
 *
 * Jede Sekunde schreibt der Simulator die PHYSIKALISCHE Wahrheit des Modells
 * (`truth()`, nicht die verzoegerten Register) als eine Zeile `[szenario] ...`;
 * jeder Sollwert, den die Box schreibt, steht als `[szenario] schreiben ...`
 * daneben. Aus genau diesen Zeilen urteilt kurzer_verbraucher_pruefen.py.
 */

'use strict';

const ModbusRTU = require('modbus-serial');
const { R, NUM_REGS, s16ToKw, createSimModel, optionsFromEnv } = require('./sim-model');

const zahl = (v, vorgabe) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : vorgabe;
};
const liste = (v, vorgabe) => {
  const l = String(v || '').split(',').map((x) => parseFloat(x)).filter((x) => Number.isFinite(x) && x > 0);
  return l.length ? l : vorgabe;
};

const PV_KW = zahl(process.env.SZ_PV_KW, 5.0);
// "0.76:420,0.5" = 0,76 kW Ueberschuss bis Sekunde 420, danach 0,5 kW.
const ABSCHNITTE = String(process.env.SZ_ABSCHNITTE || '0.76').split(',').map((a) => {
  const [kw, bis] = a.split(':');
  return { kw: zahl(kw, 0.76), bisS: zahl(bis, Infinity) };
});
const ueberschussKw = (seitStartS) => (ABSCHNITTE.find((a) => seitStartS < a.bisS)
  || ABSCHNITTE[ABSCHNITTE.length - 1]).kw;
const VERBRAUCHER_KW = zahl(process.env.SZ_VERBRAUCHER_KW, 2.62);
const DAUERN_S = liste(process.env.SZ_DAUERN_S, [15, 10, 12]);
const ABSTAENDE_S = liste(process.env.SZ_ABSTAENDE_S, [60, 90, 120, 75, 105]);
// Der erste Verbraucher startet 43 s nach dem Start - wie im Prueflauf des Tags
// nicht auf einer Takt- oder Abfragegrenze -, und der Zyklus verschiebt die Phase.
const ERSTER_S = zahl(process.env.SZ_ERSTER_S, 43);

const nowS = () => Date.now() / 1000;
const START = nowS();

function verbraucherLaeuft(seitStartS) {
  let ab = ERSTER_S;
  for (let i = 0; ab <= seitStartS; i += 1) {
    if (seitStartS < ab + DAUERN_S[i % DAUERN_S.length]) return true;
    ab += ABSTAENDE_S[i % ABSTAENDE_S.length];
  }
  return false;
}

const OPTS = optionsFromEnv();
const model = createSimModel({
  ...OPTS,
  startS: START - 1,
  pvKw: () => PV_KW,
  loadKw: (t) => PV_KW - ueberschussKw(t - START) + (verbraucherLaeuft(t - START) ? VERBRAUCHER_KW : 0),
});

const f = (x) => x.toFixed(3);
function schritt() {
  const t = nowS();
  const w = model.step(1, t);
  console.log(
    `[szenario] t=${(t - START).toFixed(1)} pv=${f(w.pv)} last=${f(w.load)} batt=${f(w.batt)} ` +
    `netz=${f(w.grid)} soc=${w.soc.toFixed(2)} ueberschuss=${ueberschussKw(t - START)} ` +
    `verbraucher=${verbraucherLaeuft(t - START) ? 1 : 0}`
  );
}
setInterval(schritt, 1000);
schritt();

const vector = {
  getHoldingRegister: (addr) => model.getRegister(addr),
  getInputRegister: (addr) => model.getRegister(addr),
  setRegister: (addr, value) => {
    if (addr < 0 || addr >= NUM_REGS) return;
    const zeile = model.setRegister(addr, value);
    if (addr === R.SETPOINT) {
      console.log(`[szenario] schreiben t=${(nowS() - START).toFixed(1)} sollwert=${f(s16ToKw(model.getRegister(addr)))}`);
    } else if (addr === R.ENABLE) {
      console.log(`[szenario] freigabe t=${(nowS() - START).toFixed(1)} ems=${model.getRegister(addr) ? 1 : 0}`);
    }
    if (zeile) console.log(zeile);
  },
};

const server = new ModbusRTU.ServerTCP(vector, {
  host: process.env.SIM_HOST || '0.0.0.0',
  port: parseInt(process.env.SIM_PORT || '502', 10),
  unitID: parseInt(process.env.SIM_UNIT_ID || '1', 10),
  debug: false,
});
server.on('socketError', (err) => console.error('[sim] socket error:', err && err.message));
server.on('serverError', (err) => console.error('[sim] server error:', err && err.message));

console.log(
  `[szenario] start pv=${PV_KW} abschnitte=${ABSCHNITTE.map((a) => `${a.kw}:${a.bisS}`).join(',')} ` +
  `verbraucher=${VERBRAUCHER_KW} ` +
  `dauern=${DAUERN_S.join('/')} abstaende=${ABSTAENDE_S.join('/')} ` +
  `folgt_nach=${OPTS.followDelayS} messtakt=${OPTS.measureIntervalS} soc=${OPTS.socStartPct}`
);
