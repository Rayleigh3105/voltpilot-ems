package com.voltpilot.api.erzeuger;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;

/**
 * UEMS EZ-7 „Vorgaben-Läufer“ (Konzept vp-erzeuger-wago-konzept §4.2, §4.6; EW-8 A, EW-12 A): aus den Rohwerten des
 * Erzeuger-Registerbilds die <b>Vorgaben</b> — wer wann wie lange die Anlage begrenzt oder gesteuert hat. Rein, ohne
 * Spring und ohne Datenbank: der Läufer füttert {@link Lesung}en in Zeitfolge, die Ableitung führt die offenen
 * Vorgaben im {@link Zustand} und nennt nach jeder Runde, was sich geändert hat.
 *
 * <p><b>Die Regeln (§4.6, übersetzt auf die schlanke Fassung §3.7, Vertrag EZ-1 §4/§5).</b>
 * <ul>
 *   <li>Netzbetreiber, {@code p_begrenzung}: {@code n_bits} Bit 2 (Wirkleistung begrenzt) oder — bei gültiger
 *       Vorgabe, Bit 0 — {@code n_p_prozent} &lt; 100 %; Beginn genau auf Lesezeit − {@code n_seit_s}.</li>
 *   <li>Netzbetreiber, {@code abschaltung}: {@code n_bits} Bit 3; {@code quelle_p} = 5 (Not-Aus) ohne dieses Bit ist
 *       eine Abschaltung des Urhebers {@code schutz} (Not-Aus vor Ort, NA-Schutz).</li>
 *   <li>Netzbetreiber, {@code q_vorgabe}: {@code n_bits} Bit 4 (cos φ) — nur Zählung, keine Energie.</li>
 *   <li>Direktvermarkter, {@code dv_aktivierung} / {@code dv_stopp}: {@code d_bits} Bit 1 / Bit 2 (gedeckt von
 *       Bit 0) für die ganze Anlage, {@code t_bits} Bit 3 je Einheit; Beginn auf Lesezeit − {@code d_seit_s}.</li>
 *   <li>{@code nicht_bereit} je Einheit: {@code t_bits} Bit 2 aus, solange {@code d_kanal} ≠ 0; Gründe Bit 4–9.</li>
 *   <li>Wirkung ({@code quelle_p}, gedeckt von {@code s_bits} Bit 0): 3 → {@code automatik} der Anlage,
 *       4 → Hand ({@code p_begrenzung}), 6 → {@code ersatzwert}.</li>
 * </ul>
 * Wer wirklich bindet, sagt {@code quelle_p} je Lesung; eine Vorgabe, deren Urheber nie band, heißt
 * „nicht bindend“. Unbekannt ist keine Null: ein ungültiges Bitfeld öffnet nichts und schließt nichts, es macht
 * eine laufende Vorgabe „unvollständig“.
 *
 * <p><b>Geschätzt nicht erzeugte Energie</b> = ∫ max(0, verfügbar − Ist) über die Zeit, in der der Urheber bindet.
 * „Verfügbar“: PV aus der Prognose der Anlage, BHKW aus der Nennleistung der bereiten Motoren bzw. dem Sollwert des
 * Direktvermarkters davor. Die Methode steht an der Vorgabe; ohne Grundlage bleibt die Zahl leer, nie 0.
 *
 * <p><b>Lücken und Zähler (Vertrag EZ-1 §8).</b> Fehlen Lesungen länger als {@value #LUECKE_AB_S} s, ist das eine
 * Lücke: was über sie läuft, ist „unvollständig“, ein Beginn oder Ende in ihr wird nie erfunden (ohne „seit“ gilt
 * die Beobachtung). Springt {@code n_zaehler} oder {@code d_zaehler} (mod 65536) über eine Lücke weiter, als die
 * gesehenen Wechsel erklären, entsteht eine {@link Luecke} „n weitere Wechsel während einer Datenlücke“. Nach einem
 * Neustart der Steuerung ist die Zahl unbekannt, nicht 0.
 */
public final class VorgabenAbleitung {

    /** Jeder Punkt kommt spätestens alle 60 s (EZ-5 {@code erzeuger-meldung.js}); länger ohne Lesung ist eine Lücke. */
    public static final long LUECKE_AB_S = 90;
    /** So lange gilt ein Wert nach seiner Lesung; danach ist er unbekannt (ein ungültiger Wert kommt nie wieder). */
    public static final long GILT_S = LUECKE_AB_S;
    /** Wie weit „seit“ und Zähler nach einem Wechsel gesucht werden (sie kommen im 60-s-Takt). */
    public static final long NACHSCHAU_S = 70;
    /** Kleiner, aber höchstens so viele Schritte weiter, ist ein Zähler übergelaufen statt neu gestartet (EZ-1 §8). */
    static final long UEBERLAUF_HOECHSTENS = 120;
    static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    public static final List<String> ARTEN = List.of("p_begrenzung", "abschaltung", "q_vorgabe", "dv_aktivierung",
            "dv_stopp", "nicht_bereit", "automatik", "ersatzwert");
    public static final List<String> URHEBER = List.of("netzbetreiber", "direktvermarkter", "anlage", "hand",
            "ersatzwert", "schutz");
    public static final List<String> METHODEN = List.of("pv_prognose", "nennleistung_bereite_motoren",
            "dv_sollwert_davor");

    // Die Punktschlüssel des Bilds (ErzeugerRegisterbild), die die Ableitung liest.
    public static final String N_BITS = "erzeuger.nb.n_bits";
    public static final String N_PROZENT = "erzeuger.nb.n_p_prozent";
    public static final String N_COSPHI = "erzeuger.nb.n_cosphi";
    public static final String N_SEIT = "erzeuger.nb.n_seit_s";
    public static final String N_ZAEHLER = "erzeuger.nb.n_zaehler";
    public static final String N_KANAL = "erzeuger.nb.n_kanal";
    public static final String D_KANAL = "erzeuger.dv.d_kanal";
    public static final String D_BITS = "erzeuger.dv.d_bits";
    public static final String D_SOLL = "erzeuger.dv.d_soll_w";
    public static final String D_SEIT = "erzeuger.dv.d_seit_s";
    public static final String D_ZAEHLER = "erzeuger.dv.d_zaehler";
    public static final String QUELLE = "erzeuger.wirkung.quelle_p";
    public static final String S_BITS = "erzeuger.wirkung.s_bits";
    public static final String GRENZE = "erzeuger.wirkung.p_grenze_w";
    public static final String A_GUELTIG = "erzeuger.a.a_gueltig";
    public static final String ERZEUGUNG = "erzeuger.a.p_erzeugung_w";
    public static final String INSTALLIERT = "erzeuger.a.p_installiert_kw";
    static final List<String> FEST = List.of(N_BITS, N_PROZENT, N_COSPHI, N_SEIT, N_ZAEHLER, N_KANAL, D_KANAL, D_BITS,
            D_SOLL, D_SEIT, D_ZAEHLER, QUELLE, S_BITS, GRENZE, A_GUELTIG, ERZEUGUNG, INSTALLIERT);
    static final List<String> JE_EINHEIT = List.of("t_zustand", "t_bits", "t_nenn_kw", "t_p_ist_w", "t_p_soll_w");
    /** Die Werte, deren nächste Lesung nach einem Wechsel zählt: „seit“ datiert ihn, der Zähler steht am Anfang/Ende. */
    public static final List<String> NACHSCHAU = List.of(N_SEIT, D_SEIT, N_ZAEHLER, D_ZAEHLER);

    /** Die Punkte, die die Ableitung liest, für ein Bild mit {@code teAnzahl} Einheiten. */
    public static List<String> punkte(int teAnzahl) {
        List<String> out = new ArrayList<>(FEST);
        for (int te = 1; te <= teAnzahl; te++) {
            for (String feld : JE_EINHEIT) {
                out.add(einheit(te, feld));
            }
        }
        return List.copyOf(out);
    }

    public static String einheit(int teNr, String feld) {
        return "erzeuger.te[" + teNr + "]." + feld;
    }

    /**
     * Was die Ableitung über die Anlage wissen muss — aus Fassung, Stammdaten, Prognose und Preisen. {@code preis}
     * null = keine Preisgrundlage (die Euro-Schätzung bleibt leer).
     */
    public record Kontext(String anlagenart, int teAnzahl, Map<Integer, BigDecimal> nennKwStamm, Prognose prognose,
            Preis preis) {}

    /** Die PV-Prognose der Anlage: Leistung in W zu einem Zeitpunkt, null = keine. */
    @FunctionalInterface
    public interface Prognose {
        BigDecimal leistungW(Instant t);
    }

    /** Was eine eingespeiste kWh zu einem Zeitpunkt wert ist (ct/kWh, die Grundlage der Erlösanzeige); null = unbekannt. */
    @FunctionalInterface
    public interface Preis {
        Double ctKwh(Instant t);
    }

    /** Die erste Lesung eines Werts nach einem Zeitpunkt (innerhalb {@value #NACHSCHAU_S} s). */
    public record Nachschau(Instant zeit, BigDecimal wert) {}

    /**
     * Eine Lesung der Steuerung: alle zu {@code zeit} bekannten Werte (getragen, höchstens {@value #GILT_S} s alt),
     * {@code frisch} die Punkte, die genau jetzt gelesen wurden, ob davor eine Lücke oder ein Neustart lag, und je
     * {@link #NACHSCHAU}-Punkt seine erste Lesung ab {@code zeit}.
     */
    public record Lesung(Instant zeit, Map<String, BigDecimal> werte, Set<String> frisch, boolean lueckeDavor,
            boolean neustartDavor, Map<String, Nachschau> nachschau) {

        BigDecimal zahl(String key) {
            return werte.get(key);
        }
    }

    /**
     * Eine Vorgabe mit ihren Summen; offen, solange {@code ende} null ist. Öffentliche Felder, weil sie als Teil des
     * {@link Zustand} zwischen zwei Läufen als JSON liegt.
     */
    public static final class Vorgabe {
        public UUID id;
        public String art;
        public String urheber;
        public Integer teNr;
        public Instant beginn;
        /** Beginn aus „seit“ datiert (genau) oder die Beobachtung (spätestens). */
        public boolean beginnGenau;
        public Instant ende;
        public boolean endeGenau;
        /** Die letzte Lesung, in der sie galt. */
        public Instant gesehenBis;
        public BigDecimal kleinsteProzent;
        public BigDecimal kleinsteW;
        public double istWs;
        public double istS;
        public double verfuegbarWs;
        public double verfuegbarS;
        public double bindendS;
        public double nichtBindendS;
        public double energieWh;
        public double grundlageS;
        /** Bindende Zeit mit Ist, aber ohne verfügbare Leistung: dann gibt es keine Schätzung, nie eine halbe. */
        public double ohneGrundlageS;
        /** Euro-Schätzung in ct; {@code wertFehlt}, sobald ein Stück Energie ohne Preis blieb. */
        public double wertCt;
        public boolean wertFehlt;
        public boolean preisBekannt;
        public String methode;
        public BigDecimal verfuegbarDavorW;
        public String kanal;
        public boolean unvollstaendig;
        public boolean neustart;
        public Long zaehlerBeginn;
        public Long zaehlerEnde;
        public Map<String, BigDecimal> rohBeginn;
        public Map<String, BigDecimal> rohEnde;
        public TreeSet<String> gruende = new TreeSet<>();
        /** Geschätzt nicht erzeugte Energie je Tag (Europe/Berlin), Wh. */
        public TreeMap<String, Double> energieJeTagWh = new TreeMap<>();

        public String schluessel() {
            return schluessel(art, urheber, teNr);
        }

        static String schluessel(String art, String urheber, Integer teNr) {
            return art + "|" + urheber + "|" + (teNr == null ? "" : teNr);
        }

        /** „bindend“, „nicht_bindend“ oder null (kein gültiges {@code quelle_p}, oder die Art bindet nicht). */
        public String bindung() {
            if (!bindetUeberhaupt(art)) {
                return null;
            }
            return bindendS > 0 ? "bindend" : nichtBindendS > 0 ? "nicht_bindend" : null;
        }

        /**
         * Geschätzt nicht erzeugte Energie in kWh; null ohne Grundlage (auch wenn sie nur für einen Teil der bindenden
         * Zeit fehlte), 0 nur, wenn der Urheber nie band.
         */
        public BigDecimal energieKwh() {
            if (methode == null) {
                return null;
            }
            if (bindendS == 0) {
                return nichtBindendS > 0 ? BigDecimal.ZERO : null;
            }
            return grundlageS > 0 && ohneGrundlageS == 0 ? kwh(energieWh) : null;
        }

        /** Die Euro-Schätzung (EW-8 A): nur mit Energie und Preis für jedes Stück davon, sonst leer. */
        public BigDecimal wertEur() {
            BigDecimal kwh = energieKwh();
            if (kwh == null || !preisBekannt || wertFehlt) {
                return null;
            }
            return BigDecimal.valueOf(wertCt / 100.0).setScale(2, RoundingMode.HALF_UP);
        }

        public BigDecimal istMittelW() {
            return istS > 0 ? watt(istWs / istS) : null;
        }

        public BigDecimal verfuegbarMittelW() {
            return verfuegbarS > 0 ? watt(verfuegbarWs / verfuegbarS) : null;
        }

        /** Je Tag die geschätzte Energie in kWh — nur mit Grundlage (sonst leer). */
        public Map<String, BigDecimal> energieJeTagKwh() {
            Map<String, BigDecimal> out = new TreeMap<>();
            if (energieKwh() != null) {
                energieJeTagWh.forEach((tag, wh) -> out.put(tag, kwh(wh)));
            }
            return out;
        }
    }

    /** Eine Datenlücke, über die ein Zähler mehr Vorgaben zählt, als gesehen wurden. */
    public record Luecke(UUID id, String urheber, Instant beginn, Instant ende, Integer weitereWechsel,
            boolean neustart, Long zaehlerVorher, Long zaehlerNachher) {}

    /** Der Stand eines Zählers zwischen zwei seiner Lesungen. */
    public static final class Zaehler {
        public Long wert;
        public Instant zeit;
        /** Wechsel, die seit der letzten Lesung des Zählers gesehen wurden. */
        public int gesehen;
        public Instant lueckeVon;
        public Instant lueckeBis;
        public boolean neustart;
    }

    /** Ein getragener Wert: was zuletzt gelesen wurde und wann. */
    public static final class Getragen {
        public BigDecimal wert;
        public Instant zeit;

        public Getragen() {}

        public Getragen(BigDecimal wert, Instant zeit) {
            this.wert = wert;
            this.zeit = zeit;
        }
    }

    /** Was zwischen zwei Läufen bleibt: die getragenen Werte, die letzte Lesung, die offenen Vorgaben und die Zähler. */
    public static final class Zustand {
        public Map<String, Getragen> getragen = new LinkedHashMap<>();
        public Instant letzteLesung;
        public Map<String, BigDecimal> letzteWerte = new LinkedHashMap<>();
        public Map<String, Vorgabe> offen = new LinkedHashMap<>();
        public Zaehler nb = new Zaehler();
        public Zaehler dv = new Zaehler();
    }

    private final Kontext kontext;
    private final Zustand z;
    private final Map<UUID, Vorgabe> geaendert = new LinkedHashMap<>();
    private final List<Luecke> luecken = new ArrayList<>();

    public VorgabenAbleitung(Kontext kontext, Zustand zustand) {
        this.kontext = kontext;
        this.z = zustand == null ? new Zustand() : zustand;
    }

    public Zustand zustand() {
        return z;
    }

    /** Die Vorgaben, die seit dem Anlegen der Ableitung entstanden, sich änderten oder endeten. */
    public List<Vorgabe> geaendert() {
        return List.copyOf(geaendert.values());
    }

    /** Die Lücken mit weiteren Wechseln, die seit dem Anlegen erkannt wurden. */
    public List<Luecke> luecken() {
        return List.copyOf(luecken);
    }

    /** Eine Lesung verarbeiten; Lesungen kommen in Zeitfolge, eine ältere als die letzte wird übergangen. */
    public void lesung(Lesung l) {
        Instant t = l.zeit();
        if (z.letzteLesung != null && !t.isAfter(z.letzteLesung)) {
            return;
        }
        Instant vorher = z.letzteLesung;
        boolean luecke = vorher != null
                && (l.lueckeDavor() || Duration.between(vorher, t).getSeconds() > LUECKE_AB_S);
        boolean neustart = l.neustartDavor();
        // 1. Die Zeit seit der letzten Lesung gehört den offenen Vorgaben — mit den Werten von damals.
        if (vorher != null && !luecke) {
            for (Vorgabe v : z.offen.values()) {
                sammle(v, z.letzteWerte, vorher, t);
            }
        }
        if (luecke) {
            z.offen.values().forEach(v -> {
                v.unvollstaendig = true;
                geaendert.put(v.id, v);
            });
        }
        // 2. Zähler: Neustart erkennen, Wechsel zählen, Lücken mit weiteren Wechseln melden.
        neustart |= zaehle(z.nb, "netzbetreiber", N_ZAEHLER, l, vorher, luecke, nbGesehen(z.letzteWerte, l.werte()));
        neustart |= zaehle(z.dv, "direktvermarkter", D_ZAEHLER, l, vorher, luecke, dvGesehen(z.letzteWerte, l.werte()));
        if (neustart) {
            z.offen.values().forEach(v -> {
                v.neustart = true;
                geaendert.put(v.id, v);
            });
        }
        // 3. Was gilt jetzt? Schließen, was nicht mehr gilt, öffnen, was neu gilt.
        Map<String, Gilt> jetzt = gilt(l.werte());
        for (Vorgabe v : new ArrayList<>(z.offen.values())) {
            Gilt g = jetzt.get(v.schluessel());
            if (g == null || g.an() == null) {
                v.unvollstaendig = true;
                geaendert.put(v.id, v);
            } else if (!g.an()) {
                schliesse(v, l, vorher, luecke, neustart);
            }
        }
        for (Map.Entry<String, Gilt> e : jetzt.entrySet()) {
            Gilt g = e.getValue();
            if (Boolean.TRUE.equals(g.an()) && !z.offen.containsKey(e.getKey())) {
                oeffne(g, l, vorher, luecke, neustart);
            }
        }
        // 4. Was offen ist, nimmt die Lesung auf.
        for (Vorgabe v : z.offen.values()) {
            Gilt g = jetzt.get(v.schluessel());
            v.gesehenBis = t;
            if (g != null) {
                v.kleinsteProzent = kleiner(v.kleinsteProzent, g.prozent());
                v.kleinsteW = kleiner(v.kleinsteW, g.watt());
                v.gruende.addAll(g.gruende());
            }
            Long zaehler = zaehlerWert(v, l.werte());
            if (zaehler != null) {
                v.zaehlerEnde = zaehler;
            }
            v.rohEnde = roh(v, l.werte());
            geaendert.put(v.id, v);
        }
        z.letzteLesung = t;
        z.letzteWerte = new LinkedHashMap<>(l.werte());
    }

    // ------------------------------------------------------------------ Regeln

    /** Gilt eine Vorgabe in einer Lesung? {@code an} null = unbekannt; dazu Wert, Gründe und Kanal. */
    record Gilt(String art, String urheber, Integer teNr, Boolean an, BigDecimal prozent, BigDecimal watt,
            Set<String> gruende, String kanal) {}

    Map<String, Gilt> gilt(Map<String, BigDecimal> w) {
        Map<String, Gilt> out = new LinkedHashMap<>();
        Long nBits = bitfeld(w.get(N_BITS));
        Long quelle = gedeckt(w.get(QUELLE), bitfeld(w.get(S_BITS)), 0);
        BigDecimal installiertW = mal(w.get(INSTALLIERT), 1000);
        String nKanal = wort(ErzeugerRegisterbild.feld(N_KANAL).orElseThrow(), w.get(N_KANAL));
        // Netzbetreiber
        BigDecimal prozent = nBits != null && bit(nBits, 0) ? w.get(N_PROZENT) : null;
        Boolean nbAn = nBits == null ? null
                : bit(nBits, 2) || (prozent != null && prozent.compareTo(BigDecimal.valueOf(100)) < 0) ? Boolean.TRUE
                : bit(nBits, 0) && prozent == null ? null : Boolean.FALSE;
        put(out, new Gilt("p_begrenzung", "netzbetreiber", null, nbAn, prozent, anteil(prozent, installiertW),
                Set.of(), nKanal));
        Boolean nbAus = nBits == null ? null : bit(nBits, 3);
        put(out, new Gilt("abschaltung", "netzbetreiber", null, nbAus, BigDecimal.ZERO, BigDecimal.ZERO, Set.of(),
                nKanal));
        put(out, new Gilt("q_vorgabe", "netzbetreiber", null, nBits == null ? null : bit(nBits, 4), null, null,
                Set.of(), nKanal));
        Boolean schutz = quelle == null ? null : quelle != 5 ? Boolean.FALSE
                : nBits == null ? null : !bit(nBits, 3);
        put(out, new Gilt("abschaltung", "schutz", null, schutz, BigDecimal.ZERO, BigDecimal.ZERO, Set.of(), null));
        // Wirkung: die Anlage selbst, Hand, Ersatzwert
        BigDecimal grenze = quelle == null ? null : w.get(GRENZE);
        put(out, wirkung("automatik", "anlage", quelle, 3, grenze, installiertW));
        put(out, wirkung("p_begrenzung", "hand", quelle, 4, grenze, installiertW));
        put(out, wirkung("ersatzwert", "ersatzwert", quelle, 6, grenze, installiertW));
        // Direktvermarkter
        BigDecimal dKanalRoh = w.get(D_KANAL);
        String dKanal = wort(ErzeugerRegisterbild.feld(D_KANAL).orElseThrow(), dKanalRoh);
        boolean ohneDv = dKanalRoh != null && dKanalRoh.signum() == 0;
        Long dBits = bitfeld(w.get(D_BITS));
        boolean dGueltig = dBits != null && bit(dBits, 0);
        BigDecimal dSoll = dGueltig ? w.get(D_SOLL) : null;
        put(out, new Gilt("dv_aktivierung", "direktvermarkter", null,
                ohneDv ? Boolean.FALSE : dGueltig ? bit(dBits, 1) : null, prozent(dSoll, installiertW), dSoll,
                Set.of(), dKanal));
        put(out, new Gilt("dv_stopp", "direktvermarkter", null, ohneDv ? Boolean.FALSE : dGueltig ? bit(dBits, 2) : null,
                BigDecimal.ZERO, BigDecimal.ZERO, Set.of(), dKanal));
        ErzeugerRegisterbild.Feld tBitsFeld = ErzeugerRegisterbild.feld(einheit(1, "t_bits")).orElseThrow();
        for (int te = 1; te <= kontext.teAnzahl(); te++) {
            Long tBits = bitfeld(w.get(einheit(te, "t_bits")));
            BigDecimal soll = tBits != null && bit(tBits, 1) ? w.get(einheit(te, "t_p_soll_w")) : null;
            BigDecimal nennW = mal(nennKw(w, te), 1000);
            put(out, new Gilt("dv_aktivierung", "direktvermarkter", te,
                    ohneDv ? Boolean.FALSE : tBits == null ? null : bit(tBits, 3), prozent(soll, nennW), soll,
                    Set.of(), dKanal));
            Boolean nichtBereit = dKanalRoh == null ? null : ohneDv ? Boolean.FALSE
                    : tBits == null ? null : !bit(tBits, 2);
            Set<String> gruende = new TreeSet<>();
            if (tBits != null) {
                ErzeugerRegisterbild.gesetzt(tBitsFeld, tBits).stream().filter(b -> b.bit() >= 4)
                        .forEach(b -> gruende.add(b.wort()));
            }
            put(out, new Gilt("nicht_bereit", "anlage", te, nichtBereit, null, null, gruende, dKanal));
        }
        return out;
    }

    private static Gilt wirkung(String art, String urheber, Long quelle, int code, BigDecimal grenze,
            BigDecimal installiertW) {
        Boolean an = quelle == null ? null : quelle == code;
        return new Gilt(art, urheber, null, an, prozent(grenze, installiertW), grenze, Set.of(), null);
    }

    private static void put(Map<String, Gilt> out, Gilt g) {
        out.put(Vorgabe.schluessel(g.art(), g.urheber(), g.teNr()), g);
    }

    /** Bindet der Urheber dieser Vorgabe laut {@code quelle_p}? null = unbekannt. */
    static Boolean bindet(Vorgabe v, Map<String, BigDecimal> w) {
        if (!bindetUeberhaupt(v.art)) {
            return null;
        }
        Long quelle = gedeckt(w.get(QUELLE), bitfeld(w.get(S_BITS)), 0);
        if (quelle == null) {
            return null;
        }
        return switch (v.urheber) {
            case "netzbetreiber" -> "abschaltung".equals(v.art) ? quelle == 5 || quelle == 1 : quelle == 1;
            case "direktvermarkter" -> quelle == 2;
            case "anlage" -> quelle == 3;
            case "hand" -> quelle == 4;
            case "schutz" -> quelle == 5;
            case "ersatzwert" -> quelle == 6;
            default -> null;
        };
    }

    static boolean bindetUeberhaupt(String art) {
        return !"q_vorgabe".equals(art) && !"nicht_bereit".equals(art);
    }

    // ------------------------------------------------------------------ öffnen, sammeln, schließen

    private void oeffne(Gilt g, Lesung l, Instant vorher, boolean luecke, boolean neustart) {
        Vorgabe v = new Vorgabe();
        v.id = UUID.randomUUID();
        v.art = g.art();
        v.urheber = g.urheber();
        v.teNr = g.teNr();
        v.kanal = g.kanal();
        Instant datiert = neustart ? null : datiert(seitPunkt(v), l, vorher);
        v.beginn = datiert != null ? datiert : l.zeit();
        v.beginnGenau = datiert != null;
        // Vor der ersten Lesung und über eine Lücke fehlt, was in der Zeit davor geschah.
        v.unvollstaendig = vorher == null || luecke;
        v.neustart = false;
        v.zaehlerBeginn = nachZaehler(v, l);
        v.rohBeginn = roh(v, l.werte());
        v.methode = methode(v, z.letzteWerte);
        v.preisBekannt = v.methode != null && kontext.preis() != null;
        if ("dv_sollwert_davor".equals(v.methode)) {
            v.verfuegbarDavorW = z.letzteWerte.get(D_SOLL);
        }
        z.offen.put(v.schluessel(), v);
        geaendert.put(v.id, v);
    }

    private void schliesse(Vorgabe v, Lesung l, Instant vorher, boolean luecke, boolean neustart) {
        Instant datiert = neustart ? null : datiert(seitPunkt(v), l, vorher);
        if (datiert != null) {
            v.ende = datiert.isBefore(v.beginn) ? v.beginn : datiert;
            v.endeGenau = true;
        } else if (luecke) {
            // Ohne „seit“ endete sie irgendwo in der Lücke: belegt ist nur, dass sie bis zur letzten Lesung galt.
            v.ende = v.gesehenBis != null ? v.gesehenBis : v.beginn;
            v.endeGenau = false;
        } else {
            v.ende = l.zeit();
            v.endeGenau = false;
        }
        Long zaehler = nachZaehler(v, l);
        if (zaehler != null) {
            v.zaehlerEnde = zaehler;
        }
        v.rohEnde = roh(v, l.werte());
        z.offen.remove(v.schluessel());
        geaendert.put(v.id, v);
    }

    /** Die Zeit [a, b) mit den Werten {@code w} (gelesen bei a) in die Summen der Vorgabe. */
    private void sammle(Vorgabe v, Map<String, BigDecimal> w, Instant a, Instant b) {
        double s = Duration.between(a, b).toMillis() / 1000.0;
        if (s <= 0) {
            return;
        }
        BigDecimal ist = ist(v, w);
        if (ist != null) {
            v.istWs += ist.doubleValue() * s;
            v.istS += s;
        }
        BigDecimal verfuegbar = verfuegbar(v, w, a);
        if (verfuegbar != null) {
            v.verfuegbarWs += verfuegbar.doubleValue() * s;
            v.verfuegbarS += s;
        }
        Boolean bindet = bindet(v, w);
        if (Boolean.TRUE.equals(bindet)) {
            v.bindendS += s;
            if (v.methode != null) {
                if (ist == null) {
                    // Ohne Ist fehlt eine Messung: die Vorgabe ist lückenhaft belegt.
                    v.unvollstaendig = true;
                } else if (verfuegbar == null) {
                    v.ohneGrundlageS += s;
                } else {
                    v.grundlageS += s;
                    double watt = Math.max(0, verfuegbar.doubleValue() - ist.doubleValue());
                    verteile(v, watt, a, b, kontext.preis());
                }
            }
        } else if (Boolean.FALSE.equals(bindet)) {
            v.nichtBindendS += s;
        }
    }

    /** Energie einer konstanten Leistung über [a, b) auf die Tage (Europe/Berlin) verteilen und bewerten. */
    private static void verteile(Vorgabe v, double watt, Instant a, Instant b, Preis preis) {
        Instant von = a;
        while (von.isBefore(b)) {
            LocalDate tag = von.atZone(ZONE).toLocalDate();
            Instant mitternacht = tag.plusDays(1).atStartOfDay(ZONE).toInstant();
            Instant bis = mitternacht.isBefore(b) ? mitternacht : b;
            double wh = watt * Duration.between(von, bis).toMillis() / 3_600_000.0;
            v.energieWh += wh;
            v.energieJeTagWh.merge(tag.toString(), wh, Double::sum);
            if (wh > 0 && preis != null) {
                Double ct = preis.ctKwh(von);
                if (ct == null) {
                    v.wertFehlt = true;
                } else {
                    v.wertCt += wh / 1000.0 * ct;
                }
            }
            von = bis;
        }
    }

    /** Ist: die ganze Anlage aus {@code p_erzeugung_w} (gedeckt von {@code a_gueltig} Bit 3), eine Einheit aus ihrem Block. */
    static BigDecimal ist(Vorgabe v, Map<String, BigDecimal> w) {
        if (v.teNr == null) {
            Long a = bitfeld(w.get(A_GUELTIG));
            return a != null && bit(a, 3) ? w.get(ERZEUGUNG) : null;
        }
        Long tBits = bitfeld(w.get(einheit(v.teNr, "t_bits")));
        return tBits != null && bit(tBits, 0) ? w.get(einheit(v.teNr, "t_p_ist_w")) : null;
    }

    /** Verfügbar nach der Methode der Vorgabe; null = unbekannt. */
    BigDecimal verfuegbar(Vorgabe v, Map<String, BigDecimal> w, Instant t) {
        if (v.methode == null) {
            return null;
        }
        return switch (v.methode) {
            case "pv_prognose" -> kontext.prognose() == null ? null : kontext.prognose().leistungW(t);
            case "dv_sollwert_davor" -> v.verfuegbarDavorW;
            case "nennleistung_bereite_motoren" -> bereiteNennleistungW(w, v.teNr);
            default -> null;
        };
    }

    /**
     * Σ Nennleistung der Motoren, die bereit sind oder laufen ({@code t_zustand} 1 … 3). Ein Motor mit unbekanntem
     * Zustand oder ohne Nennleistung zählt nicht als verfügbar (die Schätzung bleibt eine Untergrenze); ist keiner
     * bekannt, ist auch die Summe unbekannt.
     */
    private BigDecimal bereiteNennleistungW(Map<String, BigDecimal> w, Integer nurTe) {
        BigDecimal summe = BigDecimal.ZERO;
        boolean bekannt = false;
        for (int te = 1; te <= kontext.teAnzahl(); te++) {
            if (nurTe != null && nurTe != te) {
                continue;
            }
            Long tBits = bitfeld(w.get(einheit(te, "t_bits")));
            BigDecimal zustand = tBits != null && bit(tBits, 0) ? w.get(einheit(te, "t_zustand")) : null;
            BigDecimal nenn = nennKw(w, te);
            if (zustand == null || nenn == null) {
                continue;
            }
            bekannt = true;
            int code = zustand.intValue();
            if (code >= 1 && code <= 3) {
                summe = summe.add(nenn.multiply(BigDecimal.valueOf(1000)));
            }
        }
        return bekannt ? summe : null;
    }

    /** Welche Schätzung zu dieser Vorgabe passt — festgelegt, wenn sie beginnt. */
    String methode(Vorgabe v, Map<String, BigDecimal> davor) {
        if (!bindetUeberhaupt(v.art)) {
            return null;
        }
        String art = kontext.anlagenart();
        if ("pv".equals(art)) {
            return v.teNr == null && kontext.prognose() != null ? "pv_prognose" : null;
        }
        if ("bhkw".equals(art)) {
            Long dBits = bitfeld(davor.get(D_BITS));
            boolean dvAktivDavor = dBits != null && bit(dBits, 0) && bit(dBits, 1) && davor.get(D_SOLL) != null;
            if (v.teNr == null && !"direktvermarkter".equals(v.urheber) && dvAktivDavor) {
                return "dv_sollwert_davor";
            }
            return "nennleistung_bereite_motoren";
        }
        return null;
    }

    // ------------------------------------------------------------------ „seit“ und Zähler

    private static String seitPunkt(Vorgabe v) {
        return switch (v.urheber) {
            case "netzbetreiber" -> N_SEIT;
            case "direktvermarkter" -> D_SEIT;
            default -> null;
        };
    }

    private static String zaehlerPunkt(Vorgabe v) {
        return switch (v.urheber) {
            case "netzbetreiber" -> N_ZAEHLER;
            case "direktvermarkter" -> D_ZAEHLER;
            default -> null;
        };
    }

    /**
     * Der Wechsel, genau datiert: die nächste Lesung von „seit“ minus ihren Wert — nur, wenn das Ergebnis zwischen
     * der letzten Lesung und dieser liegt (sonst meint „seit“ einen anderen Wechsel). Vor der ersten Lesung gibt es
     * keine untere Grenze.
     */
    static Instant datiert(String seitPunkt, Lesung l, Instant vorher) {
        if (seitPunkt == null) {
            return null;
        }
        Nachschau n = l.nachschau().get(seitPunkt);
        // „seit“ steht höchstens auf 65534 (EZ-1 §3): dort heißt es „mindestens so lange“, keine genaue Zeit.
        if (n == null || n.wert() == null || n.wert().signum() < 0 || n.wert().longValue() >= 65534) {
            return null;
        }
        Instant wechsel = n.zeit().minusSeconds(n.wert().longValue());
        if (wechsel.isAfter(l.zeit()) || (vorher != null && !wechsel.isAfter(vorher))) {
            return null;
        }
        return wechsel;
    }

    private static Long nachZaehler(Vorgabe v, Lesung l) {
        String punkt = zaehlerPunkt(v);
        if (punkt == null) {
            return null;
        }
        Nachschau n = l.nachschau().get(punkt);
        if (n != null && n.wert() != null) {
            return n.wert().longValue();
        }
        return zaehlerWert(v, l.werte());
    }

    private static Long zaehlerWert(Vorgabe v, Map<String, BigDecimal> w) {
        String punkt = zaehlerPunkt(v);
        if (punkt == null || w.get(punkt) == null) {
            return null;
        }
        if ("direktvermarkter".equals(v.urheber)) {
            Long dBits = bitfeld(w.get(D_BITS));
            if (dBits == null || !bit(dBits, 0)) {
                return null;
            }
        }
        return w.get(punkt).longValue();
    }

    /**
     * Ein Zähler über eine Lesung: kommt er frisch, zählt die Differenz (mod 65536) gegen die gesehenen Wechsel.
     * Liegt dazwischen eine Lücke und erklären die gesehenen Wechsel die Differenz nicht, entsteht eine
     * {@link Luecke}; nach einem Neustart ist die Zahl unbekannt. Gibt zurück, ob ein Neustart erkannt wurde.
     */
    private boolean zaehle(Zaehler c, String urheber, String punkt, Lesung l, Instant vorher, boolean luecke,
            int gesehen) {
        if (luecke && c.lueckeVon == null) {
            c.lueckeVon = vorher;
            c.lueckeBis = l.zeit();
        }
        c.neustart |= l.neustartDavor();
        c.gesehen += gesehen;
        BigDecimal neu = l.frisch().contains(punkt) ? l.werte().get(punkt) : null;
        if ("direktvermarkter".equals(urheber)) {
            Long dBits = bitfeld(l.werte().get(D_BITS));
            if (dBits == null || !bit(dBits, 0)) {
                neu = null;
            }
        }
        if (neu == null) {
            return l.neustartDavor();
        }
        long jetzt = neu.longValue();
        boolean neustart = c.neustart;
        Integer differenz = null;
        if (c.wert != null) {
            long d = Math.floorMod(jetzt - c.wert, 65536L);
            long sekunden = Duration.between(c.zeit, l.zeit()).getSeconds();
            // Kleiner geworden und weiter als ein Überlauf (EZ-1 §8): die Steuerung lief neu an.
            if (jetzt < c.wert && d > Math.max(UEBERLAUF_HOECHSTENS, sekunden)) {
                neustart = true;
            }
            differenz = neustart ? null : (int) d;
            if (c.lueckeVon != null && (differenz == null || differenz > c.gesehen)) {
                luecken.add(new Luecke(UUID.randomUUID(), urheber, c.lueckeVon, c.lueckeBis,
                        differenz == null ? null : differenz - c.gesehen, neustart, c.wert, jetzt));
            }
        }
        boolean neustartErkannt = neustart && !c.neustart;
        c.wert = jetzt;
        c.zeit = l.zeit();
        c.gesehen = 0;
        c.lueckeVon = null;
        c.lueckeBis = null;
        c.neustart = false;
        return neustartErkannt || l.neustartDavor();
    }

    /** Sichtbare Wechsel des Netzbetreibers zwischen zwei Lesungen: Bits 2–4, Prozent, cos φ. */
    static int nbGesehen(Map<String, BigDecimal> alt, Map<String, BigDecimal> neu) {
        if (alt.isEmpty()) {
            return 0;
        }
        Long a = bitfeld(alt.get(N_BITS));
        Long b = bitfeld(neu.get(N_BITS));
        boolean bits = a != null && b != null && ((a ^ b) & 0b11100) != 0;
        return bits || anders(alt.get(N_PROZENT), neu.get(N_PROZENT)) || anders(alt.get(N_COSPHI), neu.get(N_COSPHI))
                ? 1 : 0;
    }

    /** Sichtbare Wechsel des Direktvermarkters: Aktivierung, Stopp, Sollwert. */
    static int dvGesehen(Map<String, BigDecimal> alt, Map<String, BigDecimal> neu) {
        if (alt.isEmpty()) {
            return 0;
        }
        Long a = bitfeld(alt.get(D_BITS));
        Long b = bitfeld(neu.get(D_BITS));
        boolean bits = a != null && b != null && ((a ^ b) & 0b110) != 0;
        return bits || anders(alt.get(D_SOLL), neu.get(D_SOLL)) ? 1 : 0;
    }

    private static boolean anders(BigDecimal a, BigDecimal b) {
        return a != null && b != null && a.compareTo(b) != 0;
    }

    // ------------------------------------------------------------------ Rohsignale

    /** Die Rohsignale, die eine Vorgabe erklären — für das Detail im Protokoll. */
    private static Map<String, BigDecimal> roh(Vorgabe v, Map<String, BigDecimal> w) {
        List<String> punkte = new ArrayList<>(switch (v.urheber) {
            case "netzbetreiber" -> List.of(N_KANAL, N_BITS, N_PROZENT, N_COSPHI, N_SEIT, N_ZAEHLER);
            case "direktvermarkter" -> List.of(D_KANAL, D_BITS, D_SOLL, D_SEIT, D_ZAEHLER);
            default -> List.<String>of();
        });
        punkte.addAll(List.of(QUELLE, S_BITS, GRENZE, ERZEUGUNG));
        if (v.teNr != null) {
            if (!punkte.contains(D_KANAL)) {
                punkte.add(D_KANAL);
            }
            for (String feld : JE_EINHEIT) {
                punkte.add(einheit(v.teNr, feld));
            }
        }
        Map<String, BigDecimal> out = new LinkedHashMap<>();
        for (String p : punkte) {
            if (w.get(p) != null) {
                out.put(p, w.get(p));
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ Zahlen

    private BigDecimal nennKw(Map<String, BigDecimal> w, int te) {
        BigDecimal bild = w.get(einheit(te, "t_nenn_kw"));
        return bild != null ? bild : kontext.nennKwStamm() == null ? null : kontext.nennKwStamm().get(te);
    }

    /** Ein Bitfeld ist 16 Bit; 0xFFFF heißt jedes Bit unbekannt (EZ-1 §4). */
    static Long bitfeld(BigDecimal roh) {
        if (roh == null) {
            return null;
        }
        long v = roh.longValue();
        return v < 0 || v >= 0xFFFF ? null : v;
    }

    static boolean bit(long bits, int nr) {
        return ((bits >> nr) & 1L) == 1L;
    }

    /** Ein Wert, den Bit {@code nr} eines Bitfelds deckt: unbekannt, solange das Bit nicht gesetzt ist. */
    private static Long gedeckt(BigDecimal wert, Long bits, int nr) {
        return wert == null || bits == null || !bit(bits, nr) ? null : wert.longValue();
    }

    private static String wort(ErzeugerRegisterbild.Feld feld, BigDecimal roh) {
        return roh == null ? null : ErzeugerRegisterbild.wort(feld, roh.longValue())
                .map(ErzeugerRegisterbild.Wort::wort).orElse(null);
    }

    private static BigDecimal mal(BigDecimal a, long faktor) {
        return a == null ? null : a.multiply(BigDecimal.valueOf(faktor));
    }

    /** Prozent eines Watt-Werts an einer Bezugsleistung (W); unbekannt ohne beide. */
    private static BigDecimal prozent(BigDecimal watt, BigDecimal bezugW) {
        if (watt == null || bezugW == null || bezugW.signum() <= 0) {
            return null;
        }
        return watt.multiply(BigDecimal.valueOf(100)).divide(bezugW, 2, RoundingMode.HALF_UP);
    }

    /** Watt eines Prozent-Werts an einer Bezugsleistung (W). */
    private static BigDecimal anteil(BigDecimal prozent, BigDecimal bezugW) {
        if (prozent == null || bezugW == null) {
            return null;
        }
        return prozent.multiply(bezugW).divide(BigDecimal.valueOf(100), 0, RoundingMode.HALF_UP);
    }

    private static BigDecimal kleiner(BigDecimal alt, BigDecimal neu) {
        return neu == null ? alt : alt == null || neu.compareTo(alt) < 0 ? neu : alt;
    }

    static BigDecimal kwh(double wh) {
        return BigDecimal.valueOf(wh / 1000.0).setScale(3, RoundingMode.HALF_UP);
    }

    static BigDecimal watt(double w) {
        return BigDecimal.valueOf(w).setScale(0, RoundingMode.HALF_UP);
    }
}
