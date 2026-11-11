'use strict';
/**
 * Testhilfe: baut Erzeuger-Registerbilder als Woerter - UNABHAENGIG vom Leser. Adressen, Breiten
 * und Datentypen kommen aus der Vorlage `erzeuger-register-vorlage-schlank.json` (Kopie der
 * Konzept-Datei `register-vorlage-schlank.json`, Fassung 12), nie aus `erzeuger-registerbild.js`.
 * Laege der Bauer dort, pruefte der Leser sich selbst.
 *
 * Werte stehen ROH, wie die Steuerung sie schreibt (0,1 % als 600, 0,1 kWh als Ganzzahl);
 * negative Zahlen im Zweierkomplement des Felds.
 *
 * ⚠ Simulator, kein Beleg: Gore und Buettner sind hier plausible Bilder nach dem Konzept
 * (§3.7, §3.9, §3.10, EW-16 C), keine Lesung an einer echten Steuerung.
 */

const fs = require('node:fs');
const path = require('node:path');

const VORLAGE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'erzeuger-register-vorlage-schlank.json'), 'utf8'));
const EINHEIT_AB = VORLAGE.abschnitte.find((a) => a.kurz === 'T').start;
const EINHEIT_WOERTER = VORLAGE.abschnitte.find((a) => a.kurz === 'T').woerter;
const NAMEN_AB = VORLAGE.namen.ab;
const NAME_WOERTER = VORLAGE.namen.woerter_je_text;
const UNGUELTIG = Object.fromEntries(Object.entries(VORLAGE.regeln.ungueltig)
  .map(([typ, hex]) => [typ, Number(hex)]));

const feldVon = (name) => {
  const f = VORLAGE.felder_einheit_1.find((x) => x.feld === name);
  if (!f) throw new Error(`Feld ${name} steht nicht in der Vorlage`);
  return f;
};

/** Ein Wert als Woerter des Feldtyps, Wortfolge `big` (hoeherwertiges Wort zuerst) oder `little`. */
function woerterVon(typ, wert, wortfolge) {
  if (typ === 'U16' || typ === 'S16') return [wert < 0 ? wert + 0x10000 : wert & 0xffff];
  const u = wert < 0 ? wert + 0x100000000 : wert;
  const hoch = Math.floor(u / 0x10000) & 0xffff;
  const nieder = u & 0xffff;
  return wortfolge === 'little' ? [nieder, hoch] : [hoch, nieder];
}

/** Ein Name als 16 Woerter, ISO 8859-1, hoeherwertiges Byte zuerst, mit 0 aufgefuellt. */
function nameWoerter(text) {
  const bytes = Buffer.from(text || '', 'latin1');
  if (bytes.length > NAME_WOERTER * 2) throw new Error(`Name zu lang: ${text}`);
  const voll = Buffer.alloc(NAME_WOERTER * 2);
  bytes.copy(voll);
  return Array.from({ length: NAME_WOERTER }, (_, i) => voll.readUInt16BE(i * 2));
}

/**
 * Ein Bild bauen. `kopf`, `anlage` (alle Felder ausser Einheit) und `einheiten[]` sind Objekte
 * Feld → Rohwert; ein fehlendes Feld ist der Ungueltig-Wert seines Typs. `namen`:
 * `{ netzbetreiber, direktvermarkter, typen: [] }` oder `null` (dann `beschreibung_ab` 0).
 * `ende`: letzte Adresse, die die Steuerung beantwortet (Vorgabe: letzter Name bzw. letzte Einheit).
 */
function baueBild({ kopf = {}, anlage = {}, einheiten = [], namen = null, wortfolge = 'big',
  beschreibungAb = NAMEN_AB, ende = null } = {}) {
  const woerter = [];
  const setze = (adresse, ws) => ws.forEach((w, i) => { woerter[adresse + i] = w; });
  const fest = Object.assign({
    signatur: null, wortfolge: 0x01020304, version: 0x0100, te_anzahl: einheiten.length,
    herzschlag: 1, programmstand: 2610, steuerung_id: 1, anlagenart: 1,
    beschreibung_ab: namen ? beschreibungAb : 0,
  }, kopf);
  for (const f of VORLAGE.felder_einheit_1.filter((x) => x.abschnitt === 'K')) {
    if (f.feld === 'signatur') {
      // Zwei einzelne Woerter „VP" „EZ" - von der Wortfolge unberuehrt.
      setze(f.adresse, Array.isArray(fest.signatur) ? fest.signatur
        : f.einheit.split(' ').map((h) => Number(h)));
      continue;
    }
    setze(f.adresse, woerterVon(f.typ, fest[f.feld], wortfolge));
  }
  for (const f of VORLAGE.felder_einheit_1.filter((x) => !['K', 'T1'].includes(x.abschnitt))) {
    const wert = Object.hasOwn(anlage, f.feld) ? anlage[f.feld] : UNGUELTIG[f.typ];
    setze(f.adresse, woerterVon(f.typ, wert, wortfolge));
  }
  einheiten.forEach((e, i) => {
    for (const f of VORLAGE.felder_einheit_1.filter((x) => x.abschnitt === 'T1')) {
      const wert = Object.hasOwn(e, f.feld) ? e[f.feld] : UNGUELTIG[f.typ];
      setze(f.adresse + i * EINHEIT_WOERTER, woerterVon(f.typ, wert, wortfolge));
    }
  });
  if (namen) {
    setze(beschreibungAb, nameWoerter(namen.netzbetreiber));
    setze(beschreibungAb + NAME_WOERTER, nameWoerter(namen.direktvermarkter));
    (namen.typen || []).forEach((t, i) => setze(beschreibungAb + 2 * NAME_WOERTER + i * NAME_WOERTER,
      nameWoerter(t)));
  }
  const letzte = ende === null ? woerter.length - 1 : ende;
  return Array.from({ length: letzte + 1 }, (_, i) => (woerter[i] === undefined ? 0 : woerter[i]));
}

/** Gore: PV, drei Wechselrichter, N-ERGIE per Fernwirktechnik, kein Direktvermarkter. */
function gore(ueberschreiben = {}) {
  const einheit = (n) => ({ t_zustand: 3, t_bits: 0b11, t_art: 1, t_nenn_kw: 125,
    t_p_ist_w: 60800 + n * 100, t_p_soll_w: 53000, t_e: 12345678 + n });
  return baueBild(Object.assign({
    kopf: { herzschlag: 1000, programmstand: 2610, steuerung_id: 4711, anlagenart: 1 },
    anlage: { a_gueltig: 0b1001, a_alter_s: 2, p_nvp_w: -1200, p_erzeugung_w: 182400,
      anlage_zustand: 3, a_bits: 0, p_installiert_kw: 265,
      n_kanal: 3, n_bits: 0b111, n_p_prozent: 600, n_cosphi: 950, n_seit_s: 1234, n_zaehler: 17,
      d_kanal: 0, d_bits: 0, d_zaehler: 0,
      quelle_p: 1, s_bits: 0b11, p_grenze_w: 159000 },
    einheiten: [einheit(1), einheit(2), einheit(3)],
    namen: { netzbetreiber: 'N-ERGIE Netz GmbH', direktvermarkter: '',
      typen: ['Growatt MAX 125KTL3-X LV', 'Growatt MAX 125KTL3-X LV', 'Growatt MAX 125KTL3-X LV'] },
  }, ueberschreiben));
}

/**
 * Buettner: Biogas-BHKW, zwei Motoren, Netzbetreiber mit Stufen, WVV-Poolbox ueber Relais und
 * 4-20 mA (EW-10 A), OHNE Messung am Netzpunkt (EW-16 C: a_gueltig Bit 0/1/2 = 0,
 * p_nvp_w ungueltig - EZ-1 Lesart 10). `n_zaehler` steht auf 65 535 (EZ-1 A2: ein Wert).
 */
function buettner(ueberschreiben = {}) {
  return baueBild(Object.assign({
    kopf: { herzschlag: 500, programmstand: 2611, steuerung_id: 4712, anlagenart: 2 },
    anlage: { a_gueltig: 0b11000, p_erzeugung_w: 58900, anlage_zustand: 2, a_bits: 0,
      speicher_fuellstand: 734, p_installiert_kw: 99,
      n_kanal: 2, n_bits: 0b111, n_p_prozent: 600, n_seit_s: 300, n_zaehler: 65535,
      d_kanal: 1, d_bits: 0b11011, d_soll_w: 60000, d_seit_s: 120, d_zaehler: 4,
      quelle_p: 2, s_bits: 0b11, p_grenze_w: 60000 },
    einheiten: [
      { t_zustand: 2, t_bits: 0b1111, t_art: 2, t_nenn_kw: 66, t_p_ist_w: 39600, t_p_soll_w: 40000 },
      { t_zustand: 2, t_bits: 0b1111, t_art: 2, t_nenn_kw: 33, t_p_ist_w: 19300, t_p_soll_w: 20000,
        t_e: 987654 },
    ],
    namen: { netzbetreiber: 'N-ERGIE Netz GmbH', direktvermarkter: 'WVV (Stadtwerke Würzburg)',
      typen: ['MAN E0836LE', 'KW Energie Smartblock 33'] },
  }, ueberschreiben));
}

/**
 * Ein Register-Store fuer den In-Process-Modbus-Server der WAGO-Buehne
 * (`vp-palette/test/fixtures/wago-registerbild-store.js` `starteRegisterbildServer`): er braucht
 * nur `funktionscode` und `lies(adresse, anzahl)` (null = ausserhalb → Ausnahme 0x02).
 */
function store(woerter, { funktionscode = 4, basis = 0 } = {}) {
  const s = {
    funktionscode,
    woerter: woerter.slice(),
    lies(adresse, anzahl) {
      const von = adresse - basis;
      if (von < 0 || von + anzahl > s.woerter.length) return null;
      return s.woerter.slice(von, von + anzahl);
    },
    setze(adresse, wert) { s.woerter[adresse] = wert & 0xffff; },
  };
  return s;
}

module.exports = { VORLAGE, EINHEIT_AB, EINHEIT_WOERTER, NAMEN_AB, NAME_WOERTER, UNGUELTIG,
  feldVon, woerterVon, nameWoerter, baueBild, gore, buettner, store };
