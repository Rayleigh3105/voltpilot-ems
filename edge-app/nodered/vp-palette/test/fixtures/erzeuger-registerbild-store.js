/**
 * Simulator-Fälle zum „VoltPilot-Registerbild Erzeuger", schlanke Fassung 1.0 (EZ-2).
 *
 * Diese Datei ist die BÜHNE, auf der der Box-Leser (EZ-5) und das Protokoll (EZ-7) ihre Tests
 * fahren: ein Register-Store mit Kopf, Anlage, Netzbetreiber, Direktvermarkter, Wirkung, einem
 * Block je Einheit und den Namen ab Register 140 - und vor ihm derselbe In-Process-Modbus-TCP-
 * Server wie beim WAGO-Energiekarten-Bild (`wago-registerbild-store.js`), hier über FC4.
 *
 * ⚠ **KEIN BELEG.** Der Simulator dient dem Bauen, nie dem Beleg. Jeder Fall in
 * `docs/contracts/v2/erzeuger-simulator-vectors.json` trägt `herkunft: "simulator"` und
 * `belegt: false`. Die Büttner-Hardware gibt es noch nicht; Gore ist aus dem nicht übersetzten
 * Entwurf `PRG_VP_Bild.st` nachgestellt.
 *
 * Der AUFBAU wird nicht abgeschrieben, sondern aus dem Abschnitt `registerbild` der Vektor-Datei
 * gelesen (Adressen, Wörter, Typen, Ungültig-Werte; mechanisch aus `register-vorlage-schlank.json`
 * gezogen). Liefert EZ-1 den Vertrag mit eigenen Vektoren, zieht der Abschnitt dorthin um.
 *
 * Der Store setzt nur Wörter, so wie die Steuerung sie ablegt. Was daraus folgt - veraltet,
 * Gültigkeitsbits, Ereignisse -, entscheidet der Leser. Die Zeit läuft über Schritte
 * (`sekunden`), damit Herzschlag, `n_seit_s`/`d_seit_s` und die Zähler zueinander passen und das
 * Protokoll später aus ihnen entstehen kann.
 *
 * Export (ohne Umbau importierbar, z. B. aus `edge-app/nodered/measurements/*.test.js`):
 *   `vektorenVorhanden()`     - ob die Vektor-Datei neben der Palette liegt (sonst `this.skip()`)
 *   `ladeAufbau()`            - Adressen/Typen aus `registerbild`
 *   `erstelleErzeugerbild()`  - der Register-Store
 *   `ladeFaelle()` / `ladeFall(name)` - die Fälle der Vektor-Datei, je mit fertigem Store
 *   `starteServer(store)`     - der Modbus-TCP-Server vor dem Store
 *
 * Kommandozeile (ein Fall in Echtzeit, Herzschlag +1 je s, danach läuft er weiter):
 *   node test/fixtures/erzeuger-registerbild-store.js "E1 gore" --port 5020
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const wago = require('./wago-registerbild-store.js');

const V2 = path.join(__dirname, '..', '..', '..', '..', '..', 'docs', 'contracts', 'v2');
const VEKTOREN = path.join(V2, 'erzeuger-simulator-vectors.json');

const BEREICH = {
  U16: [0, 0xffff],
  S16: [-0x8000, 0x7fff],
  U32: [0, 0xffffffff],
  S32: [-0x80000000, 0x7fffffff],
};
/** „höchstens 65534" (Vorlage): 0xFFFF bleibt bei den „seit"-Feldern der Ungültig-Wert. */
const SEIT_MAX = 65534;

/** Die Palette wird auch ohne das Repo ausgeliefert - dann gibt es keine Vektoren. */
function vektorenVorhanden() {
  return fs.existsSync(VEKTOREN);
}

function liesVektoren() {
  return JSON.parse(fs.readFileSync(VEKTOREN, 'utf8'));
}

/** Adressen und Typen aus `registerbild`: Felder der Abschnitte K-S und der Block je Einheit. */
function ladeAufbau() {
  const rb = liesVektoren().registerbild;
  const feld = {};
  rb.felder.forEach((f) => { feld[f.feld] = f; });
  const einheit = {};
  rb.einheit.felder.forEach((f) => { einheit[f.feld] = f; });
  return { rb, feld, einheit };
}

/**
 * Ein Eintrag eines Falls als Rohmuster des Typs.
 *  - Zahl          → nach Typ kodiert, außerhalb des Bereichs ein Fehler
 *  - `"ungueltig"` → das Typ-Maximum (Vorlage `regeln.ungueltig`)
 *  - `{ roh: N }`  → rohes Muster, ohne Deutung
 */
function rohmuster(eintrag, typ, ungueltig, wo) {
  if (eintrag === 'ungueltig') return ungueltig[typ];
  if (eintrag && typeof eintrag === 'object' && eintrag.roh !== undefined) return eintrag.roh;
  if (!Number.isInteger(eintrag)) throw new Error(`${wo}: unbekannte Angabe ${JSON.stringify(eintrag)}`);
  const [min, max] = BEREICH[typ];
  if (eintrag < min || eintrag > max) throw new Error(`${wo}: ${eintrag} liegt außerhalb von ${typ}`);
  return eintrag;
}

/** Ein Name als 16 Wörter: ISO 8859-1, erstes Zeichen im höherwertigen Byte, mit 0 aufgefüllt. */
function textWoerter(text, woerter, wo) {
  const bytes = [];
  for (const z of text) {
    const c = z.codePointAt(0);
    if (c > 0xff) throw new Error(`${wo}: „${z}" gibt es in ISO 8859-1 nicht`);
    bytes.push(c);
  }
  if (bytes.length > woerter * 2) throw new Error(`${wo}: mehr als ${woerter * 2} Zeichen`);
  const aus = [];
  for (let i = 0; i < woerter; i++) aus.push(((bytes[2 * i] || 0) << 8) | (bytes[2 * i + 1] || 0));
  return aus;
}

/**
 * Der Register-Store: eine Bank ab Adresse 0 (`basis` der Vorlage), so lang wie das Abbild der
 * Steuerung (Gore 220 Wörter: laufend 0-67, dazwischen 0, Namen 140-219). Jedes Feld außerhalb
 * des Kopfs muss der Fall nennen - ein vergessenes Feld wäre still 0, und Unbekannt ist keine Null.
 */
function erstelleErzeugerbild(cfg, aufbau = ladeAufbau()) {
  const { rb, feld, einheit } = aufbau;
  const wortfolge = cfg.wortfolge === undefined ? rb.wortfolge : cfg.wortfolge;
  if (wortfolge !== 'big' && wortfolge !== 'little') throw new Error(`Wortfolge ${wortfolge}?`);
  const einheiten = cfg.einheiten || [];
  if (einheiten.length > rb.max_einheiten) throw new Error(`mehr als ${rb.max_einheiten} Einheiten`);
  const kopf = cfg.kopf || {};
  const namen = cfg.namen || null;
  const laufend = rb.einheit.start + einheiten.length * rb.einheit.woerter;
  const ab = kopf.beschreibung_ab;
  const mitNamen = namen && ab !== 0 && ab !== rb.ungueltig.U16;
  const namenEnde = mitNamen ? ab + (2 + einheiten.length) * rb.namen.woerter_je_text : 0;
  const laenge = cfg.laenge === undefined ? Math.max(laufend, namenEnde) : cfg.laenge;
  if (laenge < laufend || laenge < namenEnde) throw new Error(`laenge ${laenge} ist zu kurz`);
  const bank = new Array(laenge).fill(0);
  const zustand = { zeit: 0, steht: false, alterLaeuft: false };

  const setzeWort = (i, w) => { bank[i] = w & 0xffff; };
  const setze32 = (i, roh) => {
    const u = roh < 0 ? roh + 0x100000000 : roh;
    const hi = Math.floor(u / 0x10000) & 0xffff;
    const lo = u & 0xffff;
    if (wortfolge === 'little') { setzeWort(i, lo); setzeWort(i + 1, hi); } else { setzeWort(i, hi); setzeWort(i + 1, lo); }
  };
  const schreibe = (adresse, f, eintrag, wo) => {
    const roh = rohmuster(eintrag, f.typ, rb.ungueltig, wo);
    if (f.woerter === 2) setze32(adresse, roh); else setzeWort(adresse, roh);
  };
  const adresseEinheit = (nr, name) => {
    if (!Number.isInteger(nr) || nr < 1 || nr > einheiten.length) throw new Error(`Einheit ${nr} gibt es nicht`);
    if (!einheit[name]) throw new Error(`Feld ${name} gibt es im Einheiten-Block nicht`);
    return rb.einheit.start + (nr - 1) * rb.einheit.woerter + einheit[name].offset;
  };
  const setzeFeld = (name, eintrag) => {
    const f = feld[name];
    if (!f) throw new Error(`Feld ${name} gibt es nicht`);
    if (name === 'signatur' || name === 'wortfolge' || name === 'version') {
      throw new Error(`${name} ist fest - dafür gibt es signatur_setzen bzw. die Wortfolge des Falls`);
    }
    schreibe(f.adresse, f, eintrag, name);
  };
  const setzeEinheit = (nr, name, eintrag) => {
    schreibe(adresseEinheit(nr, name), einheit[name], eintrag, `Einheit ${nr} ${name}`);
  };
  const wort = (name) => bank[feld[name].adresse];
  const setzeEinheiten = (liste = []) => liste.forEach((e) => {
    Object.entries(e).forEach(([k, w]) => { if (k !== 'nr') setzeEinheit(e.nr, k, w); });
  });
  const lebt = (art) => { if (zustand.steht) throw new Error(`${art}: die Steuerung steht`); };

  // Kopf: Signatur als zwei feste Wörter (Befund B2), Prüfwert über dieselbe Routine wie jeder
  // 32-Bit-Wert (EZ-1 Lesart 9) - bei falscher Wortfolge steht er darum verdreht.
  setzeWort(feld.signatur.adresse, rb.signatur[0]);
  setzeWort(feld.signatur.adresse + 1, rb.signatur[1]);
  setze32(feld.wortfolge.adresse, rb.pruefwert);
  setzeWort(feld.version.adresse, rb.version);
  setzeFeld('te_anzahl', kopf.te_anzahl === undefined ? einheiten.length : kopf.te_anzahl);
  ['herzschlag', 'programmstand', 'steuerung_id', 'anlagenart', 'beschreibung_ab'].forEach((k) => {
    if (kopf[k] === undefined) throw new Error(`Kopf: ${k} fehlt`);
    setzeFeld(k, kopf[k]);
  });

  const felder = cfg.felder || {};
  rb.felder.filter((f) => f.abschnitt !== 'K').forEach((f) => {
    if (felder[f.feld] === undefined) throw new Error(`Feld ${f.feld} fehlt im Fall`);
  });
  Object.entries(felder).forEach(([k, w]) => setzeFeld(k, w));
  einheiten.forEach((e, i) => {
    rb.einheit.felder.forEach((f) => {
      if (e[f.feld] === undefined) throw new Error(`Einheit ${i + 1}: ${f.feld} fehlt im Fall`);
      setzeEinheit(i + 1, f.feld, e[f.feld]);
    });
  });

  if (mitNamen) {
    const n = rb.namen.woerter_je_text;
    const typen = namen.t_typ_name || [];
    if (typen.length !== einheiten.length) throw new Error('je Einheit ein t_typ_name');
    [namen.netzbetreiber_name, namen.direktvermarkter_name, ...typen].forEach((text, i) => {
      textWoerter(text || '', n, `Name ${i + 1}`).forEach((w, k) => setzeWort(ab + i * n + k, w));
    });
  }

  /** „seit"/Alter: +n, höchstens 65534; ungültig bleibt ungültig. */
  const weiter = (name, n) => {
    const w = wort(name);
    if (w !== rb.ungueltig.U16) setzeWort(feld[name].adresse, Math.min(w + n, SEIT_MAX));
  };
  const aufNull = (name) => {
    if (wort(name) !== rb.ungueltig.U16) setzeWort(feld[name].adresse, 0);
  };

  const store = {
    basisadresse: rb.basis,
    funktionscode: rb.funktionscode,
    wortfolge,
    te_anzahl: einheiten.length,
    aufbau,

    woerter: () => bank.slice(),
    laenge: () => bank.length,
    zeit: () => zustand.zeit,
    steht: () => zustand.steht,

    /** Lesen wie über Modbus; außerhalb der Bank meldet der Server Ausnahme 0x02. */
    lies(adresse, anzahl) {
      const von = adresse - rb.basis;
      if (von < 0 || anzahl < 1 || von + anzahl > bank.length) return null;
      return bank.slice(von, von + anzahl);
    },

    /** Einen Schritt aus der Vektor-Datei anwenden (`lesungen[].schritte`). */
    schritt(s) {
      switch (s.art) {
        case 'sekunden': {
          const n = s.wert;
          if (!Number.isInteger(n) || n < 0) throw new Error(`sekunden ${n}?`);
          zustand.zeit += n;
          if (zustand.steht) return store;
          // Wie WORD + 1 im Entwurf: über 65 535 auf 0 (EZ-1 A2, 0xFFFF ist hier ein Wert).
          setzeWort(feld.herzschlag.adresse, wort('herzschlag') + n);
          weiter('n_seit_s', n);
          weiter('d_seit_s', n);
          if (zustand.alterLaeuft) weiter('a_alter_s', n);
          return store;
        }
        case 'steuerung_steht': zustand.steht = true; return store;
        case 'neustart':
          // Nicht remanent im Entwurf: uHerzschlag, setpointTelegramCounter, die „seit"-Uhren.
          zustand.steht = false;
          setzeWort(feld.herzschlag.adresse, 0);
          ['n_zaehler', 'd_zaehler', 'n_seit_s', 'd_seit_s'].forEach(aufNull);
          return store;
        case 'nb_vorgabe':
          lebt(s.art);
          setzeWort(feld.n_zaehler.adresse, wort('n_zaehler') + 1);
          setzeWort(feld.n_seit_s.adresse, 0);
          Object.entries(s.felder || {}).forEach(([k, w]) => setzeFeld(k, w));
          setzeEinheiten(s.einheiten);
          return store;
        case 'dv_wechsel':
          lebt(s.art);
          setzeWort(feld.d_zaehler.adresse, wort('d_zaehler') + 1);
          setzeWort(feld.d_seit_s.adresse, 0);
          Object.entries(s.felder || {}).forEach(([k, w]) => setzeFeld(k, w));
          setzeEinheiten(s.einheiten);
          return store;
        case 'felder_setzen':
          lebt(s.art);
          Object.entries(s.felder || {}).forEach(([k, w]) => setzeFeld(k, w));
          setzeEinheiten(s.einheiten);
          return store;
        case 'alter_laeuft': zustand.alterLaeuft = true; return store;
        case 'signatur_setzen':
          setzeWort(feld.signatur.adresse, s.woerter[0]);
          setzeWort(feld.signatur.adresse + 1, s.woerter[1]);
          return store;
        default: throw new Error(`unbekannter Schritt ${s.art}`);
      }
    },
  };
  return store;
}

/** Derselbe Modbus-TCP-Server wie beim WAGO-Bild (Ausnahmen 0x01/0x02/0x03), hier vor dem Erzeuger-Store. */
function starteServer(store, opts) {
  return wago.starteRegisterbildServer(store, opts);
}

/** Ein Fehlerfall nennt `basis` (einen Anlagen-Fall) und ändert nur `aufbau_aenderung`. */
function aufbauVon(fall, alle) {
  if (!fall.basis) return fall.aufbau;
  const basis = alle.find((f) => f.name === fall.basis);
  if (!basis || basis.basis) throw new Error(`${fall.name}: basis ${fall.basis}?`);
  const a = JSON.parse(JSON.stringify(basis.aufbau));
  const d = fall.aufbau_aenderung || {};
  if (d.wortfolge !== undefined) a.wortfolge = d.wortfolge;
  Object.assign(a.kopf, d.kopf || {});
  Object.assign(a.felder, d.felder || {});
  return a;
}

/** Alle Fälle der Vektor-Datei, je mit einem frisch gebauten Store. */
function ladeFaelle() {
  const datei = liesVektoren();
  const aufbau = ladeAufbau();
  return {
    datei,
    faelle: datei.faelle.map((fall) => {
      const a = aufbauVon(fall, datei.faelle);
      return { ...fall, aufbau: a, store: () => erstelleErzeugerbild(a, aufbau) };
    }),
  };
}

/** Ein Fall über seinen Namen oder dessen Teil („E1", „gore", „E1 gore"). */
function ladeFall(name) {
  const { faelle } = ladeFaelle();
  const treffer = faelle.filter((f) => f.name === name || f.name.split(' ').includes(name));
  if (treffer.length !== 1) throw new Error(`Fall „${name}": ${treffer.length} Treffer`);
  return treffer[0];
}

module.exports = {
  VEKTOREN,
  vektorenVorhanden,
  ladeAufbau,
  textWoerter,
  erstelleErzeugerbild,
  starteServer,
  ladeFaelle,
  ladeFall,
};

/* Kommandozeile: einen Fall in Echtzeit nachspielen - `sekunden n` dauert n echte Sekunden. */
if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args.splice(i, 2)[1]; };
  const port = Number(opt('--port', 5020));
  const host = opt('--host', '127.0.0.1');
  const fall = ladeFall(args.join(' ') || 'E1 gore');
  const store = fall.store();
  const warte = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const zeige = (was) => process.stdout.write(`t=${store.zeit()}s ${was}\n`);
  (async () => {
    await starteServer(store, { port, host });
    zeige(`${fall.name}: FC${store.funktionscode} auf ${host}:${port}, ${store.laenge()} Wörter`);
    for (const l of fall.lesungen) {
      for (const s of l.schritte) {
        if (s.art === 'sekunden') {
          for (let i = 0; i < s.wert; i++) { await warte(1000); store.schritt({ art: 'sekunden', wert: 1 }); }
        } else {
          store.schritt(s);
          zeige(s.art);
        }
      }
      zeige(`Lesung ${l.nr} fällig`);
    }
    zeige('Fall durchgespielt, die Steuerung läuft weiter');
    for (;;) { await warte(1000); store.schritt({ art: 'sekunden', wert: 1 }); }
  })().catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
