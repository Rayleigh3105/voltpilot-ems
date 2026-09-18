/**
 * Simulator-Vorstufe zum Vertrag „VoltPilot-Registerbild WAGO v1" (UEMS AP-05 IP-12).
 *
 * Diese Datei ist die BÜHNE, auf der IP-6 (Treiberfamilie `wago.registerbild`), IP-7
 * (Kopf-Prüfung) und IP-8 (Ereignisse) ihre Tests fahren: ein Register-Store mit Kopf und
 * Karten-Blöcken nach `docs/contracts/v2/wago-registerbild.md` und ein In-Process-Modbus-TCP-
 * Server davor, der ihn über FC3 bzw. FC4 ausliefert - wie `modbus_spec.js` es für den
 * generischen Lese-Knoten tut.
 *
 * ⚠ **KEIN BELEG.** Der Satz des Konzepts gilt wörtlich: *„der Simulator dient dem Bauen, nie
 * dem Beleg"*. Jeder Fall in `docs/contracts/v2/wago-simulator-vectors.json` trägt
 * `herkunft: "simulator"` und `belegt: false`; kein Fall darf je einen `nachweis` tragen
 * (Gegenprobe im Spec). Was hier steht, ist AUSGEDACHT - es gibt keine Hardware. Insbesondere:
 * der Skalierungsfaktor der 750-494 ist nicht belegt (Befund 1 und 4 aus dem Bau von AP-05), und
 * die Messwert-Tabelle der 750-494 ist insgesamt nicht belegt. Darum liefert der Store **nur
 * Rohwörter**: aus einem Rohwert wird hier nie eine kWh-Zahl.
 *
 * Der AUFBAU wird nicht abgeschrieben, sondern aus der Vertrags-Vektor-Datei von IP-2 gelesen
 * (`wago-registerbild-vectors.json`: Kopflänge, Kartenblocklänge, Offsets, Datentypen, die
 * Festlegungswerte für Signatur, Versionen und Prüfwert). Ändert IP-2 den Vertrag, wandert der
 * Store mit - er kann nicht davon abdriften.
 *
 * Basisadresse, Funktionscode und Wortfolge sind **Parameter je Anlage** (Vertrag §2, Befund 9),
 * nicht Konstanten: jeder Fall setzt sie selbst.
 *
 * Export für IP-6 (ohne Umbau importierbar):
 *   `vertragVorhanden()`      - ob die Vertragsdateien neben der Palette liegen (sonst `this.skip()`)
 *   `ladeAufbau()`            - Offsets/Längen/Datentypen aus dem Vertrag
 *   `erstelleRegisterbild()`  - der Register-Store (Kopf + n Karten)
 *   `ladeFaelle()` / `ladeFall(name)` - die Fälle der Vektor-Datei, je mit fertigem Store
 *   `starteRegisterbildServer(store)` - der Modbus-TCP-Server vor dem Store
 *   `UNGUELTIG`               - „kein Messwert" je Datentyp (Vertrag §4.3)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const V2 = path.join(__dirname, '..', '..', '..', '..', '..', 'docs', 'contracts', 'v2');
const VERTRAG_VEKTOREN = path.join(V2, 'wago-registerbild-vectors.json');
const SIMULATOR_VEKTOREN = path.join(V2, 'wago-simulator-vectors.json');

/** „Ungültig" ist nicht 0: der größte Wert des Datentyps heißt kein Messwert (Vertrag §4.3). */
const UNGUELTIG = { UInt32: 4294967295, Int32: 2147483647 };

/** Die Palette wird auch ohne das Repo ausgeliefert - dann gibt es keine Verträge. */
function vertragVorhanden() {
  return fs.existsSync(VERTRAG_VEKTOREN) && fs.existsSync(SIMULATOR_VEKTOREN);
}

function liesJson(datei) {
  return JSON.parse(fs.readFileSync(datei, 'utf8'));
}

/**
 * Aufbau aus dem Vertrag: Kopflänge, Kartenblocklänge, Offsets je Feld, die Festlegungswerte
 * (Signatur, Hauptversion, Nebenversion, Längen, Prüfwert) und die zwölf Messwerte mit ihrem
 * Datentyp - `null` heißt „zu erheben", und ohne belegten Datentyp gibt es keinen Wert.
 */
function ladeAufbau() {
  const v = liesJson(VERTRAG_VEKTOREN);
  const festlegung = (feld) => (feld.wert && feld.wert.art === 'festlegung' ? feld.wert.wert : null);
  const kopf = {};
  v.kopf.felder.forEach((f) => {
    kopf[f.schluessel] = { offset: f.offset, woerter: f.woerter, festlegung: festlegung(f) };
  });
  const karte = {};
  v.karte.felder.forEach((f) => {
    karte[f.schluessel] = { offset: f.offset, woerter: f.woerter };
  });
  const gueltigkeitBits = {};
  v.gueltigkeit.bits.forEach((b) => { gueltigkeitBits[b.schluessel] = b.bit; });
  return {
    kopflaenge: v.kopf.laenge,
    kartenblocklaenge: v.karte.laenge,
    kopf,
    karte,
    gueltigkeitBits,
    statuswoerterJeGruppe: v.statuswoerter.woerter_je_gruppe,
    messwerte: v.messwerte.map((m) => ({
      nr: m.nr,
      offset: m.offset,
      schluessel: m.schluessel,
      datentyp: m.datentyp && m.datentyp.art === 'handbuch' ? m.datentyp.wert : null,
    })),
  };
}

/** Ein 32-bit-Wert als zwei Wörter, in der Wortfolge des Parameters (Vertrag §2). */
function woerterAus32(wert, wortfolge) {
  const roh = wert < 0 ? wert + 0x100000000 : wert;
  if (!Number.isInteger(roh) || roh < 0 || roh > 0xffffffff) {
    throw new Error(`32-bit-Wert ausserhalb des Bereichs: ${wert}`);
  }
  const hi = Math.floor(roh / 0x10000) & 0xffff;
  const lo = roh & 0xffff;
  return wortfolge === 'little' ? [lo, hi] : [hi, lo];
}

/**
 * Ein Messwert-Eintrag eines Falls als 32-bit-Rohmuster.
 *  - Zahl            → logischer Wert, nach dem Datentyp des Felds kodiert
 *  - `"ungueltig"`   → der größte Wert des Datentyps (= kein Messwert)
 *  - `{ roh: N }`    → rohes Muster; die EINZIGE zulässige Form, wo der Datentyp „zu erheben" ist
 */
function messwertRoh(eintrag, messwert) {
  if (eintrag === null || eintrag === undefined) return 0;
  if (typeof eintrag === 'object' && eintrag.roh !== undefined) {
    return eintrag.roh < 0 ? eintrag.roh + 0x100000000 : eintrag.roh;
  }
  if (eintrag === 'ungueltig') {
    if (!messwert.datentyp) {
      throw new Error(`Messwert ${messwert.nr} (${messwert.schluessel}): „ungueltig" braucht einen `
        + 'belegten Datentyp - fuer diesen ist er zu erheben');
    }
    return UNGUELTIG[messwert.datentyp];
  }
  if (typeof eintrag !== 'number') {
    throw new Error(`Messwert ${messwert.nr}: unbekannte Angabe ${JSON.stringify(eintrag)}`);
  }
  if (!messwert.datentyp) {
    throw new Error(`Messwert ${messwert.nr} (${messwert.schluessel}) hat keinen belegten Datentyp `
      + '(zu erheben) - nur { "roh": N } ist hier zulaessig, nie eine gedeutete Zahl');
  }
  if (messwert.datentyp === 'UInt32' && eintrag < 0) {
    throw new Error(`Messwert ${messwert.nr} ist UInt32, ${eintrag} ist negativ`);
  }
  return eintrag;
}

/**
 * Der Register-Store: ein zusammenhängender Wortbereich ab der Basisadresse, Kopf + je ein
 * gleich gebauter Block pro Karte. Alle Zugriffe gehen über die Bank - es gibt keinen zweiten
 * Zustand daneben, den man vergessen könnte mitzuziehen.
 */
function erstelleRegisterbild(cfg = {}, aufbau = ladeAufbau()) {
  const basisadresse = cfg.basisadresse === undefined ? 0 : cfg.basisadresse;
  const funktionscode = cfg.funktionscode === undefined ? 3 : cfg.funktionscode;
  const wortfolge = cfg.wortfolge === undefined ? 'big' : cfg.wortfolge;
  if (wortfolge !== 'big' && wortfolge !== 'little') throw new Error(`Wortfolge ${wortfolge}?`);
  if (funktionscode !== 3 && funktionscode !== 4) throw new Error(`Funktionscode ${funktionscode}?`);
  const kartenCfg = cfg.karten || [];
  const kopflaenge = aufbau.kopflaenge;
  const blocklaenge = aufbau.kartenblocklaenge;
  const bank = new Array(kopflaenge + kartenCfg.length * blocklaenge).fill(0);

  const setzeWort = (i, w) => { bank[i] = w & 0xffff; };
  const setze32 = (i, wert) => { woerterAus32(wert, wortfolge).forEach((w, k) => setzeWort(i + k, w)); };
  const kopfOffset = (schluessel) => aufbau.kopf[schluessel].offset;
  const blockStart = (n) => kopflaenge + n * blocklaenge;
  const karteOffset = (n, schluessel) => blockStart(n) + aufbau.karte[schluessel].offset;

  // Kopf: die Festlegungen kommen aus dem Vertrag, die erhebbaren Werte aus dem Fall.
  setzeWort(kopfOffset('signatur_1'), aufbau.kopf.signatur_1.festlegung);
  setzeWort(kopfOffset('signatur_2'), aufbau.kopf.signatur_2.festlegung);
  setzeWort(kopfOffset('hauptversion'),
    cfg.hauptversion === undefined ? aufbau.kopf.hauptversion.festlegung : cfg.hauptversion);
  setzeWort(kopfOffset('nebenversion'),
    cfg.nebenversion === undefined ? aufbau.kopf.nebenversion.festlegung : cfg.nebenversion);
  setzeWort(kopfOffset('kopflaenge'), kopflaenge);
  setzeWort(kopfOffset('kartenblocklaenge'), blocklaenge);
  setzeWort(kopfOffset('kartenzahl'),
    cfg.kartenzahl === undefined ? kartenCfg.length : cfg.kartenzahl);
  setzeWort(kopfOffset('herzschlag'), cfg.herzschlag === undefined ? 0 : cfg.herzschlag);
  setze32(kopfOffset('wortfolge_pruefwert'), aufbau.kopf.wortfolge_pruefwert.festlegung);
  setze32(kopfOffset('controller_kennung'),
    cfg.controller_kennung === undefined ? 0 : cfg.controller_kennung);

  kartenCfg.forEach((k, n) => {
    setzeWort(karteOffset(n, 'steckplatz'), k.steckplatz);
    setzeWort(karteOffset(n, 'kartentyp'), k.kartentyp);
    setzeWort(karteOffset(n, 'variante'), k.variante === undefined ? 0 : k.variante);
    setzeWort(karteOffset(n, 'gueltigkeit'), k.gueltigkeit === undefined ? 0b1111 : k.gueltigkeit);
    setzeWort(karteOffset(n, 'kartenregister_32'), k.kartenregister_32 || 0);
    setzeWort(karteOffset(n, 'kartenregister_35'), k.kartenregister_35 || 0);
    const status = k.statuswoerter || [];
    for (let i = 0; i < aufbau.karte.statuswoerter.woerter; i++) {
      setzeWort(karteOffset(n, 'statuswoerter') + i, status[i] || 0);
    }
    const werte = k.messwerte || [];
    aufbau.messwerte.forEach((m, i) => {
      setze32(blockStart(n) + m.offset, messwertRoh(werte[i], m));
    });
  });

  const store = {
    basisadresse,
    funktionscode,
    wortfolge,
    kopflaenge,
    kartenblocklaenge: blocklaenge,
    kartenzahl: kartenCfg.length,
    aufbau,

    /** Die ganze Bank als Wörter (Index 0 = Basisadresse). */
    woerter: () => bank.slice(),
    laenge: () => bank.length,

    /**
     * Lesen wie über Modbus: `adresse` ist die Protokolladresse, nicht der Bank-Index.
     * Außerhalb des Registerbilds gibt es nichts - das meldet der Server als Ausnahme 0x02.
     */
    lies(adresse, anzahl) {
      const von = adresse - basisadresse;
      if (von < 0 || anzahl < 1 || von + anzahl > bank.length) return null;
      return bank.slice(von, von + anzahl);
    },

    herzschlag: () => bank[kopfOffset('herzschlag')],
    /** Je Sekunde + 1, von 65 535 auf 0 (Vertrag §3). */
    herzschlagTick(schritte = 1) {
      setzeWort(kopfOffset('herzschlag'), (store.herzschlag() + schritte) % 0x10000);
      return store;
    },
    herzschlagSetzen(wert) { setzeWort(kopfOffset('herzschlag'), wert); return store; },
    /** Programmstart: der Herzschlag beginnt wieder bei 0 (Vertrag §3). */
    programmNeustart() { return store.herzschlagSetzen(0); },

    hauptversionSetzen(wert) { setzeWort(kopfOffset('hauptversion'), wert); return store; },
    nebenversionSetzen(wert) { setzeWort(kopfOffset('nebenversion'), wert); return store; },
    signaturSetzen(w1, w2) {
      setzeWort(kopfOffset('signatur_1'), w1);
      setzeWort(kopfOffset('signatur_2'), w2);
      return store;
    },
    kartenzahlSetzen(wert) { setzeWort(kopfOffset('kartenzahl'), wert); return store; },
    controllerKennungSetzen(wert) { setze32(kopfOffset('controller_kennung'), wert); return store; },

    /** Ein Griff auf Karte `n` (ab 0 gezählt). */
    karte(n) {
      if (n < 0 || n >= kartenCfg.length) throw new Error(`Karte ${n} gibt es nicht`);
      const griff = {
        start: () => blockStart(n),
        woerter: () => bank.slice(blockStart(n), blockStart(n) + blocklaenge),
        gueltigkeit: () => bank[karteOffset(n, 'gueltigkeit')],
        gueltigkeitSetzen(bits) { setzeWort(karteOffset(n, 'gueltigkeit'), bits); return griff; },
        /**
         * Karte gezogen oder Klemmenbusfehler: Bit 0 fällt, die ALTEN Wörter bleiben im Block
         * stehen (Vertrag §4.1 - „unbekannt", nicht 0). Genau das ist die Falle, die ein Leser
         * bestehen muss.
         */
        nichtGelesen() {
          const bit = aufbau.gueltigkeitBits.karte_gelesen;
          return griff.gueltigkeitSetzen(griff.gueltigkeit() & ~(1 << bit) & 0xffff);
        },
        steckplatzSetzen(wert) { setzeWort(karteOffset(n, 'steckplatz'), wert); return griff; },
        kartentypSetzen(wert) { setzeWort(karteOffset(n, 'kartentyp'), wert); return griff; },
        varianteSetzen(wert) { setzeWort(karteOffset(n, 'variante'), wert); return griff; },
        messwertSetzen(nr, eintrag) {
          const m = aufbau.messwerte.find((x) => x.nr === nr);
          if (!m) throw new Error(`Messwert ${nr} gibt es nicht`);
          setze32(blockStart(n) + m.offset, messwertRoh(eintrag, m));
          return griff;
        },
      };
      return griff;
    },

    /** Einen Schritt aus der Vektor-Datei anwenden (`lesungen[].schritte`). */
    schritt(s) {
      switch (s.art) {
        case 'herzschlag_tick': return store.herzschlagTick(s.wert === undefined ? 1 : s.wert);
        case 'herzschlag_steht': return store;
        case 'herzschlag_setzen': return store.herzschlagSetzen(s.wert);
        case 'programm_neustart': return store.programmNeustart();
        case 'hauptversion_setzen': return store.hauptversionSetzen(s.wert);
        case 'nebenversion_setzen': return store.nebenversionSetzen(s.wert);
        case 'signatur_setzen': return store.signaturSetzen(s.woerter[0], s.woerter[1]);
        case 'kartenzahl_setzen': return store.kartenzahlSetzen(s.wert);
        case 'karte_nicht_gelesen': store.karte(s.karte).nichtGelesen(); return store;
        case 'karte_gueltigkeit_setzen': store.karte(s.karte).gueltigkeitSetzen(s.wert); return store;
        case 'karte_messwert_setzen': store.karte(s.karte).messwertSetzen(s.nr, s.eintrag); return store;
        default: throw new Error(`unbekannter Schritt ${s.art}`);
      }
    },
  };
  return store;
}

/**
 * Der In-Process-Modbus-TCP-Server vor dem Store - nach dem Muster von `modbus_spec.js`, aber
 * mit den Ausnahmen, die ein Leser treffen kann: fremder Funktionscode → 0x01, Adresse
 * außerhalb des Registerbilds oder mehr als 125 Register → 0x02 bzw. 0x03.
 */
function starteRegisterbildServer(store, { delayMs = 0 } = {}) {
  const state = { anfragen: 0, ausnahmen: 0, letzte: null };
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', (buf) => {
      const txid = buf.readUInt16BE(0);
      const unit = buf[6];
      const fn = buf[7];
      const addr = buf.readUInt16BE(8);
      const count = buf.readUInt16BE(10);
      state.anfragen += 1;
      state.letzte = { fn, addr, count };
      const ausnahme = (code) => {
        state.ausnahmen += 1;
        const res = Buffer.alloc(9);
        res.writeUInt16BE(txid, 0);
        res.writeUInt16BE(0, 2);
        res.writeUInt16BE(3, 4);
        res[6] = unit;
        res[7] = fn | 0x80;
        res[8] = code;
        return res;
      };
      let res;
      if (fn !== store.funktionscode) {
        res = ausnahme(0x01); // fremder Funktionscode
      } else if (count < 1 || count > 125) {
        res = ausnahme(0x03); // unzulaessige Anzahl
      } else {
        const woerter = store.lies(addr, count);
        if (woerter === null) {
          res = ausnahme(0x02); // ausserhalb des Registerbilds
        } else {
          res = Buffer.alloc(9 + woerter.length * 2);
          res.writeUInt16BE(txid, 0);
          res.writeUInt16BE(0, 2);
          res.writeUInt16BE(3 + woerter.length * 2, 4);
          res[6] = unit;
          res[7] = fn;
          res[8] = woerter.length * 2;
          woerter.forEach((w, i) => res.writeUInt16BE(w, 9 + i * 2));
        }
      }
      setTimeout(() => { if (!sock.destroyed) sock.write(res); }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Alle Fälle der Vektor-Datei, je mit einem frisch gebauten Store. */
function ladeFaelle() {
  const datei = liesJson(SIMULATOR_VEKTOREN);
  const aufbau = ladeAufbau();
  return {
    datei,
    faelle: datei.faelle.map((fall) => ({
      ...fall,
      store: () => erstelleRegisterbild(fall.aufbau, aufbau),
    })),
  };
}

/** Ein Fall über den Anfang seines Namens („S1", „S1 normallast", „normallast"). */
function ladeFall(name) {
  const { faelle } = ladeFaelle();
  const treffer = faelle.filter((f) => f.name === name || f.name.split(' ').includes(name));
  if (treffer.length !== 1) throw new Error(`Fall „${name}": ${treffer.length} Treffer`);
  return treffer[0];
}

module.exports = {
  VERTRAG_VEKTOREN,
  SIMULATOR_VEKTOREN,
  UNGUELTIG,
  vertragVorhanden,
  ladeAufbau,
  woerterAus32,
  erstelleRegisterbild,
  starteRegisterbildServer,
  ladeFaelle,
  ladeFall,
};
