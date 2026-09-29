/* Beispieldaten für den Prototyp. Alles erfunden, aber in der Form der echten Antworten:
   Börsenpreise je Viertelstunde (96 Werte je Tag, ct/kWh), Wetter je Stunde (3 Tage),
   PV je Viertelstunde (gemessen bis jetzt, danach Prognose), Speicher laut Plan.
   Beispieltag ist Dienstag, 29.09.2026; die Anlage „Sonnenhof“ stammt aus den Test-Fixtures. */
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

  /* Ein typischer Herbsttag: Morgen- und Abendspitze, Mittagssenke durch Sonnenstrom. */
  function preisTag(p, seed) {
    const r = zufall(seed);
    const rampe = [0.28, 0.06, -0.12, -0.22];
    const out = [];
    for (let i = 0; i < 96; i++) {
      const h = (i + 0.5) / 4;
      let v = p.basis
        + p.morgen * glocke(h, 8, 1.1)
        + p.abend * glocke(h, 19.3, 1.5)
        - p.senke * glocke(h, 13.2, p.senkeBreite)
        - 1.2 * glocke(h, 3.5, 1.8)
        + rampe[i % 4] * 1.3
        + (r() - 0.5) * 0.7;
      out.push(Math.round(v * 100) / 100);
    }
    return out;
  }

  const TAGE = [
    { datum: new Date(2026, 8, 29), wort: 'Heute', name: 'Dienstag', kurz: 'Di. 29.09.' },
    { datum: new Date(2026, 8, 30), wort: 'Morgen', name: 'Mittwoch', kurz: 'Mi. 30.09.' },
    { datum: new Date(2026, 9, 1), wort: 'Donnerstag', name: 'Donnerstag', kurz: 'Do. 01.10.' },
  ];

  const PREIS = {
    sonnig: preisTag({ basis: 9.6, morgen: 5, abend: 10.5, senke: 8.2, senkeBreite: 2.0 }, 7),
    morgen: preisTag({ basis: 10.2, morgen: 4.2, abend: 8.4, senke: 5.6, senkeBreite: 1.9 }, 11),
    negativ: preisTag({ basis: 8.6, morgen: 3.8, abend: 8.2, senke: 12.4, senkeBreite: 2.3 }, 5),
  };

  /* Szenarien der Preisseite: Uhrzeit (Minute des Tages) und ob der Folgetag schon feststeht. */
  const PREIS_FAELLE = {
    vormittag: { label: '10:40 Uhr', minute: 10 * 60 + 40, heute: PREIS.sonnig, morgen: null },
    nachmittag: { label: '16:20 Uhr', minute: 16 * 60 + 20, heute: PREIS.sonnig, morgen: PREIS.morgen },
    negativ: { label: 'Negativpreise', minute: 12 * 60 + 50, heute: PREIS.negativ, morgen: null },
  };

  /* Ihr Preis: im Portal aus dem Fahrplan GELESEN (importPriceCtKwh). Hier nur fürs Beispiel
     aus den fiktiven Tariffeldern der Test-Fixtures gebildet (Aufschlag 4,5 ct, Netz 8 ct,
     Abgaben 2 ct, 19 % MwSt.). */
  const ihrPreis = (ct) => Math.round((ct + 4.5 + 8 + 2) * 1.19 * 10) / 10;

  /* Speicher laut Plan (nur kommende Viertelstunden): laden im günstigen Drittel bei Tag,
     abgeben im teuren Drittel. +1 lädt, −1 gibt ab, 0 ruht. */
  function plan(cts, abIndex) {
    const s = [...cts].sort((a, b) => a - b);
    const tief = s[Math.floor(s.length * 0.3)];
    const hoch = s[Math.floor(s.length * 0.72)];
    return cts.map((v, i) => {
      if (i < abIndex) return null;
      const h = i / 4;
      if (v <= tief && h >= 9.5 && h < 16) return 1;
      if (v >= hoch && (h >= 17 || (h >= 6.5 && h < 9))) return -1;
      return 0;
    });
  }

  /* Rückblick: Tagesmittel der letzten 7 und 30 Tage, Monatsmittel eines Jahres (ct/kWh). */
  function rueckblick() {
    const r = zufall(19);
    const tage = [];
    for (let d = 29; d >= 0; d--) {
      const dt = new Date(2026, 8, 29 - d);
      const we = dt.getDay() === 0 || dt.getDay() === 6;
      tage.push({ datum: dt, ct: Math.round((9.2 + (r() - 0.5) * 4.4 - (we ? 2.1 : 0)) * 100) / 100 });
    }
    const monate = ['Okt.', 'Nov.', 'Dez.', 'Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.']
      .map((m, i) => ({ label: m, jahr: i < 3 ? 2025 : 2026, ct: Math.round((9.4 + 2.3 * Math.cos((i - 2.4) / 12 * 2 * Math.PI) + (r() - 0.5) * 1.2) * 100) / 100 }));
    return { tage, monate };
  }

  /* ---------- Wetter ---------- */
  const AUF = 7.15, UNTER = 19.05; // Sonnenauf- und -untergang am Beispielort (Stunden)
  const klarHimmel = (h) => (h <= AUF || h >= UNTER ? 0 : 725 * Math.sin(Math.PI * (h - AUF) / (UNTER - AUF)) ** 1.25);

  /* Bewölkung je Stunde (0–23) für drei Tagesarten. */
  function wolken(art, seed) {
    const r = zufall(seed);
    return Array.from({ length: 24 }, (_, h) => {
      let c;
      if (art === 'sonnig') c = 8 + 10 * glocke(h, 17, 2.5) + r() * 8;
      else if (art === 'wechselnd') c = 38 + 30 * Math.sin(h / 2.2) ** 2 + r() * 14;
      else if (art === 'launisch') c = h < 11 ? 18 + r() * 10 : h < 15 ? 72 + r() * 16 : 24 + r() * 10;
      else c = 78 + r() * 17;
      return Math.max(0, Math.min(100, Math.round(c)));
    });
  }
  function temperaturen(tief, hoch, seed) {
    const r = zufall(seed);
    return Array.from({ length: 24 }, (_, h) => {
      const t = tief + (hoch - tief) * (0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, (h - 6) / 9))));
      const abend = h > 15 ? (hoch - tief) * 0.55 * ((h - 15) / 9) : 0;
      return Math.round((t - abend + (r() - 0.5) * 0.6) * 10) / 10;
    });
  }
  const ghi = (h, c) => Math.round(klarHimmel(h) * (1 - 0.75 * (c / 100) ** 3.4));

  function wetterTag(art, tief, hoch, seed) {
    const cloud = wolken(art, seed);
    const temp = temperaturen(tief, hoch, seed + 1);
    const stunden = cloud.map((c, h) => ({ h, cloud: c, temp: temp[h], ghi: ghi(h + 0.5, c) }));
    return { art, stunden };
  }

  /* PV je Viertelstunde aus der Sonneneinstrahlung der Beispieldaten (10,4 kWp, 86 %).
     Das Portal rechnet so NIE; es liest die gespeicherte PV-Prognose. */
  function pvTag(tag, seed, messRauschen) {
    const r = zufall(seed);
    return Array.from({ length: 96 }, (_, i) => {
      const h = (i + 0.5) / 4;
      const st = tag.stunden[Math.min(23, Math.floor(h))];
      const nb = tag.stunden[Math.min(23, Math.floor(h) + 1)];
      const f = h - Math.floor(h);
      const c = st.cloud * (1 - f) + nb.cloud * f;
      let kw = 10.4 * 0.86 * (klarHimmel(h) * (1 - 0.75 * (c / 100) ** 3.4)) / 1000;
      if (messRauschen) kw *= 1 + (r() - 0.5) * messRauschen;
      return kw < 0.03 ? 0 : Math.round(kw * 100) / 100;
    });
  }

  function wetterFall(artHeute, seed) {
    const tage = [
      wetterTag(artHeute, 12, artHeute === 'sonnig' ? 24 : 21, seed),
      wetterTag('wechselnd', 11, 20, seed + 10),
      wetterTag('bewoelkt', 10, 16, seed + 20),
    ];
    const minute = 10 * 60 + 40;
    const jetzt = Math.floor(minute / 15);
    const pvHeuteMess = pvTag(tage[0], seed + 3, 0.12);
    const pvHeuteProg = pvTag(tage[0], seed + 4, 0);
    const pvMorgen = pvTag(tage[1], seed + 5, 0);
    // Die PV-Prognose reicht 48 h ab jetzt: heute ab jetzt, morgen ganz, übermorgen bis 10:40.
    return {
      minute,
      tage,
      pv: [
        { gemessen: pvHeuteMess.map((v, i) => (i < jetzt ? v : null)), erwartet: pvHeuteProg.map((v, i) => (i >= jetzt ? v : null)) },
        { gemessen: null, erwartet: pvMorgen },
        null,
      ],
    };
  }

  const WETTER_FAELLE = {
    sonnig: { label: 'Sonnig', ...wetterFall('sonnig', 31) },
    launisch: { label: 'Wechselhaft', ...wetterFall('launisch', 41) },
    ohne: { label: 'Ohne Prognose', ...wetterFall('sonnig', 31), ohnePrognose: true },
  };

  return { TAGE, PREIS_FAELLE, WETTER_FAELLE, ihrPreis, plan, rueckblick: rueckblick() };
})();
