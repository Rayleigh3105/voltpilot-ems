/* Beispieldaten für den Prototyp. Alles erfunden, aber in der Form der echten Antworten:
   Börsenpreis je Viertelstunde (ct/kWh, heute und ab 13 Uhr morgen), PV-Prognose und
   Grundlast je Viertelstunde (kW), Außentemperatur (°C). Beispieltag ist Dienstag,
   29.09.2026; die Anlage „Sonnenhof“ stammt aus den fiktiven Test-Fixtures. */
const DATEN = (() => {
  function zufall(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const glocke = (h, mitte, breite) => Math.exp(-((h - mitte) ** 2) / (2 * breite * breite));
  const r2 = (v) => Math.round(v * 100) / 100;

  /* Herbsttag: Morgen- und Abendspitze, Mittagssenke durch Sonnenstrom. */
  function preisTag(p, seed) {
    const r = zufall(seed);
    const rampe = [0.28, 0.06, -0.12, -0.22];
    const out = [];
    for (let i = 0; i < 96; i++) {
      const h = (i + 0.5) / 4;
      const v = p.basis
        + p.morgen * glocke(h, 8, 1.1)
        + p.abend * glocke(h, 19.3, 1.5)
        - p.senke * glocke(h, 13.2, p.senkeBreite)
        - 1.4 * glocke(h, 3.4, 1.7)
        + rampe[i % 4] * 1.3
        + (r() - 0.5) * 0.7;
      out.push(r2(v));
    }
    return out;
  }

  /* PV 11,4 kWp: heute klar, morgen wechselnd bewölkt. */
  function pvTag(spitze, wolken, seed) {
    const r = zufall(seed);
    const out = [];
    for (let i = 0; i < 96; i++) {
      const h = (i + 0.5) / 4;
      if (h < 7.1 || h > 19.05) { out.push(0); continue; }
      const x = Math.sin(Math.PI * (h - 7.1) / 11.95);
      let v = spitze * Math.pow(Math.max(x, 0), 1.35);
      if (wolken) v *= 1 - wolken * (0.5 + 0.5 * Math.sin(i * 0.9 + r() * 2)) * (0.6 + r() * 0.4);
      else v *= 0.97 + r() * 0.05;
      out.push(r2(Math.max(0, v)));
    }
    return out;
  }

  /* Grundlast des Hauses ohne die gesteuerten Geräte (Kühlschrank, Licht, Kochen ...). */
  function lastTag(seed) {
    const r = zufall(seed);
    const out = [];
    for (let i = 0; i < 96; i++) {
      const h = (i + 0.5) / 4;
      const v = 0.32 + 0.9 * glocke(h, 7.2, 0.8) + 0.45 * glocke(h, 12.4, 0.9)
        + 1.35 * glocke(h, 19, 1.4) + 0.25 * glocke(h, 21.8, 0.8) + (r() - 0.5) * 0.16;
      out.push(r2(Math.max(0.25, v)));
    }
    return out;
  }

  function tempTag(min, max, seed) {
    const r = zufall(seed);
    const out = [];
    for (let i = 0; i < 96; i++) {
      const h = (i + 0.5) / 4;
      const w = 0.5 - 0.5 * Math.cos(Math.PI * 2 * (h - 4.5) / 24);
      out.push(Math.round((min + (max - min) * Math.pow(w, 1.4) + (r() - 0.5) * 0.4) * 10) / 10);
    }
    return out;
  }

  const heute = {
    datum: 'Di. 29.09.', wort: 'Heute',
    preis: preisTag({ basis: 9.4, morgen: 5.4, abend: 12.5, senke: 10.4, senkeBreite: 1.8 }, 7),
    pv: pvTag(7.9, 0, 3),
    last: lastTag(21),
    temp: tempTag(9, 25.6, 5),
  };
  const morgen = {
    datum: 'Mi. 30.09.', wort: 'Morgen',
    preis: preisTag({ basis: 10.6, morgen: 5.0, abend: 11.2, senke: 5.2, senkeBreite: 1.7 }, 11),
    pv: pvTag(6.4, 0.55, 9),
    last: lastTag(23),
    temp: tempTag(10, 17, 13),
  };
  /* Negativpreise am Mittag heute: vier Viertelstunden knapp unter null. */
  [52, 53, 54, 55].forEach((i, k) => { heute.preis[i] = [-0.4, -1.1, -0.8, -0.2][k]; });

  return { tage: [heute, morgen], anlage: 'Sonnenhof', netzanschlussKw: 22, pvKwp: 11.4 };
})();
