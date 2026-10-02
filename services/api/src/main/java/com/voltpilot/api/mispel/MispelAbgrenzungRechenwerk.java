package com.voltpilot.api.mispel;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * MiSpeL MP-8: Rechenwerk der Abgrenzungsoption — reine Rechnung, ohne Uhr, Datenbank oder Schreibweg.
 *
 * <p>Die Formeln (1)–(33) der Formelsätze A1, A5, A5-Variante, A10 und A11 aus Anlage 1 der Festlegung zur
 * Marktintegration von Speichern und Ladepunkten (BNetzA, Az. 618-25-02, Beschluss vom 01.10.2026). Nummern,
 * Begriffe und Rechenwege wörtlich wie im Vertrag {@code docs/contracts/v2/mispel-abgrenzung.md}; Zitierweise
 * „A1 S. 35“ = Anlage 1, Seite 35. Zwilling des Python-Rechenwerks
 * {@code services/optimization/voltpilot_optimization/mispel_abgrenzung.py} (MP-9): beide rechnen
 * {@code mispel-abgrenzung-vectors.json} exakt nach, Stufe für Stufe gleich (Viertelstunde → ∑M → Monat → ∑J).
 *
 * <p>Regeln des Vertrags, die Anlage 1 offenlässt: <b>vergleich</b> — ungerundet, mit exakten {@link Bruch}en;
 * <b>nenner_null</b> — ein Quotient mit Nenner 0 ist nicht bestimmbar ({@code null}), ein Produkt mit ihm 0;
 * <b>zeit</b> — eine Viertelstunde gehört zum Kalendermonat und -jahr, in dem sie nach gesetzlicher Zeit
 * (Europe/Berlin) beginnt.
 *
 * <p>Einziger Unterschied der Schnittstelle zum Zwilling: AW¼ kommt als Wahrheitswert „AW¼ &gt; 0“ an, denn mehr
 * wertet (24)¼ = WENN [ AW¼ &gt; 0 ; 1 ; 0 ] nicht aus (A1 S. 38) und mehr liefert die Liste der ÜNB nicht
 * ({@code MispelMarktdatenRepository.awZeiten}). Die Rechnung summiert genau die übergebenen Viertelstunden: ob ein
 * Monat vollständig ist, entscheidet der Aufrufer ({@link MispelAbgrenzungService}).
 */
public final class MispelAbgrenzungRechenwerk {

    public static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final Duration VIERTELSTUNDE = Duration.ofMinutes(15);
    private static final DateTimeFormatter MONAT = DateTimeFormatter.ofPattern("yyyy-MM");

    public static final String A1 = "A1";
    public static final String A5 = "A5";
    public static final String A5_VARIANTE = "A5-Variante";
    public static final String A10 = "A10";
    public static final String A11 = "A11";
    public static final List<String> FORMELSAETZE = List.of(A1, A5, A5_VARIANTE, A10, A11);

    private static final List<String> Z1 = List.of("Z1NB¼", "Z1NE¼");
    private static final List<String> Z1_Z2 = List.of("Z1NB¼", "Z1NE¼", "Z2V¼", "Z2E¼");

    /** Zählerwerte je Viertelstunde und Formelsatz (Vertrag, Tabelle „Umfang“). */
    public static List<String> zaehlerEingaenge(String formelsatz) {
        pruefeFormelsatz(formelsatz);
        return A10.equals(formelsatz) || A11.equals(formelsatz) ? Z1 : Z1_Z2;
    }

    /** Die AW-Eingänge je Viertelstunde: {@code AW¼} in A1, {@code AWa¼}/{@code AWb¼} in A5, keine in A10/A11. */
    public static List<String> awEingaenge(String formelsatz) {
        pruefeFormelsatz(formelsatz);
        return switch (formelsatz) {
            case A1 -> List.of("AW¼");
            case A5, A5_VARIANTE -> List.of("AWa¼", "AWb¼");
            default -> List.of();
        };
    }

    public static boolean brauchtStammdaten(String formelsatz) {
        return A5.equals(formelsatz) || A5_VARIANTE.equals(formelsatz);
    }

    // Formeln je Formelsatz und Ebene, in der Reihenfolge des Formelkatalogs der Vektor-Datei.
    private static final List<String> A1_VIERTELSTUNDE = List.of("(1)¼", "(2)¼", "(23)¼", "(24)¼", "(25)¼", "(27)¼");
    private static final List<String> A1_SALDIERUNG = List.of("(3)", "(4)", "(5)", "(6)", "(9)", "(10)", "(11)",
            "(12)", "(13)", "(14)A1", "(15)", "(16)", "(17)A1", "(18)", "(19)A1,A4", "(20)", "(21)");
    private static final List<String> A1_FOERDERUNG = List.of("(26)", "(28)", "(29)", "(30)", "(31)", "(32)");

    private static List<String> a5JeAnlage(String x) {
        return List.of("(23" + x + ")¼ A5", "(24" + x + ")¼", "(25" + x + ")¼", "(27" + x + ")¼");
    }

    private static List<String> a5MonatJeAnlage(String x) {
        return List.of("(26" + x + ")", "(28" + x + ")A5", "(29" + x + ")", "(30" + x + ")", "(31" + x + ")",
                "(32" + x + ")");
    }

    @SafeVarargs
    private static List<String> folge(List<String>... teile) {
        List<String> out = new ArrayList<>();
        for (List<String> t : teile) {
            out.addAll(t);
        }
        return List.copyOf(out);
    }

    /** Die Formeln eines Formelsatzes auf einer Ebene ({@code viertelstunde}, {@code monat}, {@code jahr}). */
    public static List<String> formeln(String formelsatz, String ebene) {
        pruefeFormelsatz(formelsatz);
        return switch (formelsatz) {
            case A1 -> switch (ebene) {
                case "viertelstunde" -> A1_VIERTELSTUNDE;
                case "monat" -> folge(A1_SALDIERUNG, A1_FOERDERUNG);
                default -> List.of("(22)", "(33)");
            };
            case A5 -> switch (ebene) {
                case "viertelstunde" -> folge(List.of("(1)¼", "(2)¼", "(23)¼"), a5JeAnlage("a"), a5JeAnlage("b"));
                case "monat" -> folge(A1_SALDIERUNG, List.of("(28)", "(ZFa)", "(ZFb)"), a5MonatJeAnlage("a"),
                        a5MonatJeAnlage("b"));
                default -> List.of("(22)", "(33a)", "(33b)");
            };
            case A5_VARIANTE -> switch (ebene) {
                case "viertelstunde" -> A1_VIERTELSTUNDE;
                case "monat" -> folge(A1_SALDIERUNG, A1_FOERDERUNG,
                        List.of("(ZFa)", "(ZFb)", "(32a)A5-Variante", "(32b)A5-Variante"));
                default -> List.of("(22)", "(33)", "(33a)A5-Variante", "(33b)A5-Variante");
            };
            case A10 -> switch (ebene) {
                case "viertelstunde" -> List.of();
                case "monat" -> List.of("(3)", "(20)A10", "(21)A10");
                default -> List.of("(22)A10");
            };
            default -> switch (ebene) {
                case "viertelstunde" -> List.of();
                case "monat" -> List.of("(3)", "(4)", "(16)A11", "(20)A11", "(21)A11");
                default -> List.of("(22)A11");
            };
        };
    }

    /** ∑M: Monatsformel → summierter Eingang bzw. Viertelstundenwert (A1 S. 34–39, S. 47–48). */
    private static final Map<String, String> SUMME_M = Map.ofEntries(
            Map.entry("(3)", "Z1NB¼"), Map.entry("(4)", "Z1NE¼"), Map.entry("(5)", "Z2V¼"), Map.entry("(6)", "Z2E¼"),
            Map.entry("(9)", "(1)¼"), Map.entry("(11)", "(2)¼"), Map.entry("(26)", "(25)¼"), Map.entry("(29)", "(27)¼"),
            Map.entry("(26a)", "(25a)¼"), Map.entry("(29a)", "(27a)¼"), Map.entry("(26b)", "(25b)¼"),
            Map.entry("(29b)", "(27b)¼"));

    /** ∑J: Jahresformel → summierter Monatswert (A1 S. 37, S. 39, S. 49, S. 53, S. 96–97, S. 101). */
    private static final Map<String, String> SUMME_J = Map.of(
            "(22)", "(21)", "(33)", "(32)", "(33a)", "(32a)", "(33b)", "(32b)",
            "(33a)A5-Variante", "(32a)A5-Variante", "(33b)A5-Variante", "(32b)A5-Variante",
            "(22)A10", "(21)A10", "(22)A11", "(21)A11");

    /** Die ∑M-Formeln eines Formelsatzes in Katalog-Reihenfolge. */
    public static List<String> summen(String formelsatz) {
        return formeln(formelsatz, "monat").stream().filter(SUMME_M::containsKey).toList();
    }

    // ------------------------------------------------------------------ Eingang und Ergebnis

    /**
     * Eine Viertelstunde: Beginn (mit Versatz zur UTC), die Zählerwerte in kWh ({@link #zaehlerEingaenge}) und
     * „AW &gt; 0“ je AW-Eingang ({@link #awEingaenge}).
     */
    public record Viertelstunde(OffsetDateTime beginn, Map<String, BigDecimal> zaehler, Map<String, Boolean> awGroesserNull) {}

    /**
     * Ein Rumpfmonat (A1 S. 102, Abschn. 11): {@code [von, bis)} innerhalb eines Kalendermonats mit eigenen
     * Stammdaten; {@code schluessel} benennt ihn im Ergebnis (z. B. {@code 2027-05/1}).
     */
    public record Zeitraum(String schluessel, OffsetDateTime von, OffsetDateTime bis, Map<String, BigDecimal> stammdaten) {}

    /** Werte einer Viertelstunde mit ihrem Beginn. */
    public record ViertelstundeWerte(OffsetDateTime beginn, Map<String, Bruch> werte) {}

    /**
     * Viertelstundenwerte, Monatswerte je (Rumpf-)Monat und Jahreswerte je Kalenderjahr. Ein Wert {@code null} ist
     * nicht bestimmbar (Regel {@code nenner_null}).
     */
    public record Ergebnis(String formelsatz, List<ViertelstundeWerte> viertelstunden,
            Map<String, Map<String, Bruch>> monate, Map<String, Map<String, Bruch>> jahre) {}

    private MispelAbgrenzungRechenwerk() {}

    // ------------------------------------------------------------------ Hilfen

    /** Regel nenner_null: ohne Regel in Anlage 1 für den Nenner 0 ist der Quotient nicht bestimmbar. */
    private static Bruch quotient(Bruch zaehler, Bruch nenner) {
        return nenner.signum() == 0 ? null : zaehler.durch(nenner);
    }

    /** Regel nenner_null: ein Produkt mit einem nicht bestimmbaren Faktor ist 0. */
    private static Bruch produkt(Bruch faktor, Bruch wert) {
        return faktor == null ? Bruch.NULL : faktor.mal(wert);
    }

    /** (24)¼ = WENN [ AW¼ &gt; 0 ; 1 ; 0 ] (A1 S. 38). */
    private static Bruch awGroesserNull(boolean aw) {
        return aw ? Bruch.EINS : Bruch.NULL;
    }

    private static Bruch zahl(String name, BigDecimal wert) {
        if (wert == null) {
            throw new IllegalArgumentException(name + ": kein Wert — unbekannt ist keine Null");
        }
        if (wert.signum() < 0) {
            throw new IllegalArgumentException(name + " = " + wert.toPlainString()
                    + ": Zählerwerte und Leistungen sind nie negativ (A1 S. 32)");
        }
        return Bruch.von(wert);
    }

    private static void pruefeFormelsatz(String formelsatz) {
        if (!FORMELSAETZE.contains(formelsatz)) {
            throw new IllegalArgumentException("Formelsatz „" + formelsatz + "“ nicht im Umfang: "
                    + String.join(", ", FORMELSAETZE));
        }
    }

    private static void pruefeUngefoerdert(String formelsatz, Set<String> ungefoerdert) {
        if (!ungefoerdert.isEmpty() && (!A5.equals(formelsatz) || !Set.of("a", "b").containsAll(ungefoerdert))) {
            throw new IllegalArgumentException("ungefördert gibt es nur für die Anlagen a und b in A5 (A1 S. 52), nicht "
                    + formelsatz);
        }
        if (ungefoerdert.containsAll(Set.of("a", "b"))) {
            throw new IllegalArgumentException("A5 braucht mindestens eine marktprämien-geförderte Anlage; ohne sie "
                    + "gilt Abschn. 10 (A1 S. 52)");
        }
    }

    /**
     * (ZFa) = Painst / (Painst + Pbinst), (ZFb) = Pbinst / (Painst + Pbinst) (A1 S. 46). Painst und Pbinst sind die
     * installierten Leistungen in kW nach § 24 Abs. 3 S. 2 Halbsatz 2 EEG (A1 S. 45).
     */
    public static Map<String, Bruch> zuordnungsfaktoren(Map<String, BigDecimal> stammdaten) {
        Map<String, BigDecimal> s = stammdaten == null ? Map.of() : stammdaten;
        Bruch pa = zahl("Painst", s.get("Painst"));
        Bruch pb = zahl("Pbinst", s.get("Pbinst"));
        if (pa.plus(pb).signum() == 0) {
            throw new IllegalArgumentException("Painst + Pbinst = 0: ohne installierte Leistung kein Zuordnungs-Faktor");
        }
        Map<String, Bruch> zf = new LinkedHashMap<>();
        zf.put("(ZFa)", pa.durch(pa.plus(pb)));
        zf.put("(ZFb)", pb.durch(pa.plus(pb)));
        return zf;
    }

    private static Map<String, Bruch> eingaenge(String formelsatz, Viertelstunde q) {
        List<String> erwartet = zaehlerEingaenge(formelsatz);
        Map<String, BigDecimal> z = q.zaehler() == null ? Map.of() : q.zaehler();
        Set<String> fremd = new TreeSet<>(z.keySet());
        erwartet.forEach(fremd::remove);
        if (!fremd.isEmpty()) {
            throw new IllegalArgumentException(formelsatz + " kennt die Eingänge " + fremd + " nicht (erwartet "
                    + erwartet + ")");
        }
        Map<String, Bruch> e = new LinkedHashMap<>();
        for (String name : erwartet) {
            e.put(name, zahl(name, z.get(name)));
        }
        return e;
    }

    private static boolean aw(String name, Viertelstunde q) {
        Boolean b = q.awGroesserNull() == null ? null : q.awGroesserNull().get(name);
        if (b == null) {
            throw new IllegalArgumentException(name + ": kein Wert — unbekannt ist keine Null");
        }
        return b;
    }

    // ------------------------------------------------------------------ die Stufen

    /** Viertelstundenwerte eines Formelsatzes aus den Zählerwerten (kWh) und „AW¼ &gt; 0“ der Viertelstunde. */
    public static Map<String, Bruch> viertelstunde(String formelsatz, Viertelstunde q, Map<String, BigDecimal> stammdaten,
            Set<String> ungefoerdert) {
        pruefeFormelsatz(formelsatz);
        pruefeUngefoerdert(formelsatz, ungefoerdert);
        Map<String, Bruch> e = eingaenge(formelsatz, q);
        Map<String, Bruch> w = new LinkedHashMap<>();
        if (formeln(formelsatz, "viertelstunde").isEmpty()) {
            return w;
        }
        w.put("(1)¼", Bruch.min(e.get("Z1NB¼"), e.get("Z2V¼"))); // A1 S. 33
        w.put("(2)¼", Bruch.min(e.get("Z1NE¼"), e.get("Z2E¼"))); // A1 S. 34
        w.put("(23)¼", e.get("Z1NE¼").minus(w.get("(2)¼"))); // A1 S. 38
        if (A5.equals(formelsatz)) {
            Map<String, Bruch> zf = zuordnungsfaktoren(stammdaten);
            for (String x : List.of("a", "b")) {
                w.put("(23" + x + ")¼ A5", zf.get("(ZF" + x + ")").mal(w.get("(23)¼"))); // A1 S. 46
                w.put("(24" + x + ")¼", ungefoerdert.contains(x) ? Bruch.EINS : awGroesserNull(aw("AW" + x + "¼", q)));
                w.put("(25" + x + ")¼", w.get("(24" + x + ")¼").mal(w.get("(23" + x + ")¼ A5")));
                w.put("(27" + x + ")¼", w.get("(24" + x + ")¼").mal(w.get("(2)¼"))); // A1 S. 47
            }
            return w;
        }
        boolean aw;
        if (A5_VARIANTE.equals(formelsatz)) {
            // A1 S. 52: nur anwendbar bei jederzeit übereinstimmenden AW>0-Zeiten; dann ist (24)¼ für a und b gleich.
            if (aw("AWa¼", q) != aw("AWb¼", q)) {
                throw new IllegalArgumentException("A5-Variante nicht anwendbar: AW>0-Zeiten von a und b stimmen nicht "
                        + "überein (A1 S. 52)");
            }
            aw = aw("AWa¼", q);
        } else {
            aw = aw("AW¼", q);
        }
        w.put("(24)¼", awGroesserNull(aw)); // A1 S. 38
        w.put("(25)¼", w.get("(24)¼").mal(w.get("(23)¼")));
        w.put("(27)¼", w.get("(24)¼").mal(w.get("(2)¼")));
        return w;
    }

    /** Monatswerte aus den ∑M-Werten des (Rumpf-)Monats. Ein Rumpfmonat tritt an die Stelle des Kalendermonats (A1 S. 102). */
    public static Map<String, Bruch> monat(String formelsatz, Map<String, Bruch> monatssummen,
            Map<String, BigDecimal> stammdaten) {
        pruefeFormelsatz(formelsatz);
        Map<String, Bruch> m = new LinkedHashMap<>();
        for (String nr : summen(formelsatz)) {
            Bruch s = monatssummen.get(nr);
            if (s == null) {
                throw new IllegalArgumentException(formelsatz + ": Monatssumme " + nr + " fehlt");
            }
            m.put(nr, s);
        }
        if (A10.equals(formelsatz)) { // A1 S. 96
            m.put("(20)A10", m.get("(3)"));
            m.put("(21)A10", m.get("(3)").minus(m.get("(20)A10")));
            return geordnet(formelsatz, "monat", m);
        }
        if (A11.equals(formelsatz)) { // A1 S. 100–101
            m.put("(16)A11", m.get("(4)"));
            m.put("(20)A11", Bruch.min(m.get("(16)A11"), m.get("(3)")));
            m.put("(21)A11", m.get("(3)").minus(m.get("(20)A11")));
            return geordnet(formelsatz, "monat", m);
        }
        // A1 S. 34–37: Saldierung; in A5 und A5-Variante unverändert (A1 S. 45, S. 52).
        m.put("(10)", m.get("(5)").minus(m.get("(9)")));
        m.put("(12)", Bruch.max(m.get("(6)").minus(m.get("(5)")), Bruch.NULL));
        m.put("(13)", Bruch.max(m.get("(11)").minus(m.get("(12)")), Bruch.NULL));
        m.put("(14)A1", quotient(m.get("(6)"), m.get("(5)")));
        m.put("(15)", produkt(m.get("(14)A1"), m.get("(10)")));
        m.put("(16)", Bruch.max(m.get("(13)").minus(m.get("(15)")), Bruch.NULL));
        m.put("(17)A1", Bruch.max(m.get("(5)").minus(m.get("(6)")), Bruch.NULL));
        m.put("(18)", quotient(m.get("(16)"), m.get("(6)")));
        m.put("(19)A1,A4", produkt(m.get("(18)"), m.get("(17)A1")));
        m.put("(20)", Bruch.min(m.get("(16)").plus(m.get("(19)A1,A4")), m.get("(3)")));
        m.put("(21)", m.get("(3)").minus(m.get("(20)")));
        m.put("(28)", Bruch.min(m.get("(13)"), m.get("(15)"))); // A1 S. 38–39; in A5 für die Summe (S. 45)
        if (A5.equals(formelsatz)) { // A1 S. 46–49
            m.putAll(zuordnungsfaktoren(stammdaten));
            for (String x : List.of("a", "b")) {
                m.put("(28" + x + ")A5", m.get("(ZF" + x + ")").mal(m.get("(28)")));
                m.put("(30" + x + ")", quotient(m.get("(29" + x + ")"), m.get("(11)")));
                m.put("(31" + x + ")", produkt(m.get("(30" + x + ")"), m.get("(28" + x + ")A5")));
                m.put("(32" + x + ")", m.get("(26" + x + ")").plus(m.get("(31" + x + ")")));
            }
            return geordnet(formelsatz, "monat", m);
        }
        m.put("(30)", quotient(m.get("(29)"), m.get("(11)"))); // A1 S. 39
        m.put("(31)", produkt(m.get("(30)"), m.get("(28)")));
        m.put("(32)", m.get("(26)").plus(m.get("(31)")));
        if (A5_VARIANTE.equals(formelsatz)) { // A1 S. 53
            m.putAll(zuordnungsfaktoren(stammdaten));
            for (String x : List.of("a", "b")) {
                m.put("(32" + x + ")A5-Variante", m.get("(ZF" + x + ")").mal(m.get("(32)")));
            }
        }
        return geordnet(formelsatz, "monat", m);
    }

    /** ∑J über die Monatswerte der (Rumpf-)Monate eines Kalenderjahres. */
    public static Map<String, Bruch> jahr(String formelsatz, List<Map<String, Bruch>> monate) {
        Map<String, Bruch> j = new LinkedHashMap<>();
        for (String nr : formeln(formelsatz, "jahr")) {
            Bruch s = Bruch.NULL;
            for (Map<String, Bruch> mw : monate) {
                s = s.plus(mw.get(SUMME_J.get(nr)));
            }
            j.put(nr, s);
        }
        return j;
    }

    private static Map<String, Bruch> geordnet(String formelsatz, String ebene, Map<String, Bruch> werte) {
        Map<String, Bruch> out = new LinkedHashMap<>();
        for (String nr : formeln(formelsatz, ebene)) {
            out.put(nr, werte.get(nr));
        }
        return out;
    }

    // ------------------------------------------------------------------ der Lauf

    private static ZonedDateTime monatsbeginnDanach(OffsetDateTime t) {
        ZonedDateTime lokal = t.atZoneSameInstant(BERLIN);
        return lokal.withDayOfMonth(1).toLocalDate().plusMonths(1).atStartOfDay(BERLIN);
    }

    private static List<Zeitraum> zeitraeume(List<Zeitraum> roh) {
        List<Zeitraum> liste = new ArrayList<>(roh);
        for (Zeitraum z : liste) {
            if (!(z.von().isBefore(z.bis()) && !z.bis().toInstant().isAfter(monatsbeginnDanach(z.von()).toInstant()))) {
                throw new IllegalArgumentException("Rumpfmonat " + z.schluessel()
                        + ": [von, bis) muss in einem Kalendermonat liegen (A1 S. 102)");
            }
        }
        liste.sort(Comparator.comparing(z -> z.von().toInstant()));
        Set<String> schluessel = new HashSet<>();
        for (Zeitraum z : liste) {
            if (!schluessel.add(z.schluessel())) {
                throw new IllegalArgumentException("Rumpfmonate mit gleichem Schlüssel");
            }
        }
        for (int i = 1; i < liste.size(); i++) {
            if (liste.get(i).von().isBefore(liste.get(i - 1).bis())) {
                throw new IllegalArgumentException("Rumpfmonate " + liste.get(i - 1).schluessel() + " und "
                        + liste.get(i).schluessel() + " überlappen");
            }
        }
        return liste;
    }

    /**
     * Rechnet einen Formelsatz über Viertelstunden. Ohne {@code zeitraeume} gilt der Kalendermonat nach gesetzlicher
     * Zeit mit {@code stammdaten} für alle Monate; mit {@code zeitraeume} (Rumpfmonate) muss jede Viertelstunde in
     * genau einem liegen, und jeder bringt seine Stammdaten mit. Monate sind genau die (Rumpf-)Monate mit mindestens
     * einer Viertelstunde; das Kalenderjahr eines Rumpfmonats ist das seines Beginns.
     */
    public static Ergebnis rechne(String formelsatz, List<Viertelstunde> viertelstunden, Map<String, BigDecimal> stammdaten,
            List<Zeitraum> zeitraeume, Set<String> ungefoerdert) {
        pruefeFormelsatz(formelsatz);
        Set<String> ohne = ungefoerdert == null ? Set.of() : ungefoerdert;
        pruefeUngefoerdert(formelsatz, ohne);
        List<Zeitraum> raeume = zeitraeume == null ? null : zeitraeume(zeitraeume);
        if (raeume != null && stammdaten != null) {
            throw new IllegalArgumentException("Stammdaten entweder je Rumpfmonat oder für alle Monate, nicht beides");
        }
        if (brauchtStammdaten(formelsatz) && raeume == null) {
            zuordnungsfaktoren(stammdaten);
        }
        Map<String, Map<String, Bruch>> summen = new LinkedHashMap<>();
        Map<String, String> jahrVon = new LinkedHashMap<>();
        Map<String, Map<String, BigDecimal>> stammVon = new LinkedHashMap<>();
        List<ViertelstundeWerte> ergebnisQh = new ArrayList<>();
        Instant vorher = null;
        for (Viertelstunde q : viertelstunden) {
            if (q.beginn() == null) {
                throw new IllegalArgumentException("beginn fehlt: ohne Versatz zur UTC ist der Kalendermonat nicht bestimmbar");
            }
            Instant beginn = q.beginn().toInstant();
            if (beginn.getEpochSecond() % VIERTELSTUNDE.getSeconds() != 0 || beginn.getNano() != 0) {
                throw new IllegalArgumentException("beginn = " + q.beginn() + ": nicht auf dem Viertelstundenraster");
            }
            if (vorher != null && !beginn.isAfter(vorher)) {
                throw new IllegalArgumentException("beginn = " + q.beginn()
                        + ": Viertelstunden streng aufsteigend, ohne Doppel");
            }
            vorher = beginn;
            String schluessel;
            String jahrSchluessel;
            Map<String, BigDecimal> stamm;
            if (raeume == null) {
                ZonedDateTime lokal = beginn.atZone(BERLIN);
                schluessel = MONAT.format(lokal);
                jahrSchluessel = String.valueOf(lokal.getYear());
                stamm = stammdaten;
            } else {
                Zeitraum z = raeume.stream()
                        .filter(r -> !beginn.isBefore(r.von().toInstant()) && beginn.isBefore(r.bis().toInstant()))
                        .findFirst()
                        .orElseThrow(() -> new IllegalArgumentException("beginn = " + q.beginn()
                                + ": liegt in keinem Rumpfmonat"));
                schluessel = z.schluessel();
                jahrSchluessel = String.valueOf(z.von().atZoneSameInstant(BERLIN).getYear());
                stamm = z.stammdaten();
            }
            Map<String, Bruch> qh = viertelstunde(formelsatz, q, stamm, ohne);
            Map<String, Bruch> alles = new LinkedHashMap<>(eingaenge(formelsatz, q));
            alles.putAll(qh);
            Map<String, Bruch> s = summen.computeIfAbsent(schluessel, k -> {
                Map<String, Bruch> neu = new LinkedHashMap<>();
                summen(formelsatz).forEach(nr -> neu.put(nr, Bruch.NULL));
                return neu;
            });
            for (String nr : summen(formelsatz)) {
                s.put(nr, s.get(nr).plus(alles.get(SUMME_M.get(nr))));
            }
            jahrVon.put(schluessel, jahrSchluessel);
            stammVon.put(schluessel, stamm);
            if (!formeln(formelsatz, "viertelstunde").isEmpty()) {
                ergebnisQh.add(new ViertelstundeWerte(q.beginn(), qh));
            }
        }
        Map<String, Map<String, Bruch>> monate = new LinkedHashMap<>();
        summen.forEach((s, werte) -> monate.put(s, monat(formelsatz, werte, stammVon.get(s))));
        Map<String, List<Map<String, Bruch>>> jeJahr = new LinkedHashMap<>();
        jahrVon.forEach((s, j) -> jeJahr.computeIfAbsent(j, k -> new ArrayList<>()).add(monate.get(s)));
        Map<String, Map<String, Bruch>> jahre = new LinkedHashMap<>();
        jeJahr.forEach((j, ms) -> jahre.put(j, jahr(formelsatz, ms)));
        return new Ergebnis(formelsatz, List.copyOf(ergebnisQh), monate, jahre);
    }
}
