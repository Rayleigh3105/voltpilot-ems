package com.voltpilot.api.mispel;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.Year;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * MiSpeL MP-25: Rechenwerk der Pauschaloption — reine Rechnung, ohne Uhr, Datenbank oder Schreibweg.
 *
 * <p>Die Formeln (P1)–(P22)R der Formelsätze P1, P2, P3, P4, P4-Variante und P5 aus Anlage 2 der Festlegung zur
 * Marktintegration von Speichern und Ladepunkten (BNetzA, Az. 618-25-02, Beschluss vom 01.10.2026). Nummern, Begriffe
 * und Rechenwege wörtlich wie im Vertrag {@code docs/contracts/v2/mispel-pauschal.md}; Zitierweise „A2 S. 30“ =
 * Anlage 2, Seite 30. Zwilling des Python-Rechenwerks {@code services/optimization/voltpilot_optimization/
 * mispel_pauschal.py}: beide rechnen {@code mispel-pauschal-vectors.json} exakt nach, Stufe für Stufe gleich
 * (Viertelstunde → ∑J → (Rumpf-)Jahr). Erst ab der EU-Genehmigung anwendbar (T S. 3, Tenorziffer 9 b; A2 S. 20) —
 * bis dahin Vorbau (E7 = B).
 *
 * <p>Regeln des Vertrags, die Anlage 2 offenlässt: <b>vergleich</b> — ungerundet, mit exakten {@link Bruch}en;
 * <b>zeit</b> — eine Viertelstunde gehört zu dem Kalendertag und -jahr, an dem sie nach gesetzlicher Zeit
 * (Europe/Berlin) beginnt; <b>kalenderjahr</b> — kein Monatsbezug, kein Übertrag (A2 S. 9–10; T S. 63);
 * <b>rumpfjahre</b> — ganze Kalendertage, {@code von} und {@code bis} einschließlich, der Änderungstag zählt zum
 * Rumpfjahr davor (A2 S. 53, TR); (P1)R ersetzt (P1) in (P15)/(P15a)/(P15b), (P4)R ersetzt (P4) in (P8);
 * <b>ungefoerdert</b> — für eine ungeförderte Solaranlage entfällt ihr AW-Eingang, ihre (P12…)¼ ist 1 (A2 S. 40, S. 50);
 * <b>abwandlungen</b> — P4, P4-Variante und P5 stellt Anlage 2 in Abwandlung zum Basisfall P1 dar, mit Ladepunkt gelten
 * sie in Abwandlung zu P2 oder P3 mit deren Rechengröße (A2 S. 34, S. 43, S. 49); der {@code basisfall} wählt sie
 * (Vorgabe P1), in Abwandlung zu P2 entfällt SKinst (A2 S. 27).
 *
 * <p>Einziger Unterschied der Schnittstelle zum Zwilling: AW¼ kommt als Wahrheitswert „AW¼ &gt; 0“ an, denn mehr
 * wertet (P12)¼ = WENN [ AW¼ &gt; 0 ; 1 ; 0 ] nicht aus (A2 S. 31) und mehr liefert die Liste der ÜNB nicht
 * ({@code MispelMarktdatenRepository.awZeiten}); SP¼ kommt als Preis in ct/kWh (darf negativ sein). Die Rechnung
 * summiert genau die übergebenen Viertelstunden: ob ein Jahr vollständig ist, entscheidet der Aufrufer
 * ({@link MispelPauschalService}).
 */
public final class MispelPauschalRechenwerk {

    private static final Duration VIERTELSTUNDE = Duration.ofMinutes(15);

    public static final String P1 = "P1";
    public static final String P2 = "P2";
    public static final String P3 = "P3";
    public static final String P4 = "P4";
    public static final String P4_VARIANTE = "P4-Variante";
    public static final String P5 = "P5";
    public static final List<String> FORMELSAETZE = List.of(P1, P2, P3, P4, P4_VARIANTE, P5);
    /** Die Sonderfälle, die Anlage 2 in Abwandlung zu einem Basisfall darstellt (Regel {@code abwandlungen}). */
    public static final List<String> ABWANDLUNGEN = List.of(P4, P4_VARIANTE, P5);
    public static final List<String> BASISFAELLE = List.of(P1, P2, P3);

    /** (P17) = ANZAHL [ TS ] = 183: die Tage April bis September (A2 S. 54). */
    public static final int TAGE_SOMMERPERIODE = 183;
    private static final Bruch KWH_JE_KW = Bruch.von(500);
    private static final Bruch NULL_KOMMA_EINS = Bruch.von(new BigDecimal("0.1"));
    private static final Bruch NULL_KOMMA_ZWEI = Bruch.von(new BigDecimal("0.2"));

    private static final List<String> QH = List.of("(P5)¼", "(P6)¼", "(P12)¼", "(P13)¼");
    private static final List<String> SALDIERUNG = List.of("(P3)", "(P4)", "(P7)", "(P8)", "(P9)", "(P10)", "(P11)");
    private static final List<String> FOERDERUNG = List.of("(P14)", "(P15)");
    public static final List<String> RUMPFJAHR = List.of("(P17)", "(P18)", "(P19)R", "(P1)R", "(P20)", "(P21)",
            "(P22)R", "(P3)R", "(P4)R");

    /** Zähler- und Marktwerte je Viertelstunde und Formelsatz (Vertrag, Tabelle „Umfang“). */
    public static List<String> eingaenge(String formelsatz) {
        pruefeFormelsatz(formelsatz);
        return switch (formelsatz) {
            case P4, P4_VARIANTE -> List.of("Z1NB¼", "Z1NE¼", "AWa¼", "AWb¼", "SP¼");
            case P5 -> List.of("Z1NB¼", "ZWNE¼", "AW¼", "SP¼");
            default -> List.of("Z1NB¼", "Z1NE¼", "AW¼", "SP¼");
        };
    }

    /** Die Zählerwerte (kWh) unter den Eingängen. */
    public static List<String> zaehlerEingaenge(String formelsatz) {
        return eingaenge(formelsatz).stream().filter(e -> e.startsWith("Z")).toList();
    }

    /** Die AW-Eingänge (AW¼ bzw. AWa¼/AWb¼). */
    public static List<String> awEingaenge(String formelsatz) {
        return eingaenge(formelsatz).stream().filter(e -> e.startsWith("AW")).toList();
    }

    public static List<String> stammdaten(String formelsatz) {
        return stammdaten(formelsatz, null);
    }

    /** Die Stammdaten des Formelsatzes; in Abwandlung zu P2 (Ladepunkt) ohne SKinst (A2 S. 27). */
    public static List<String> stammdaten(String formelsatz, String basisfall) {
        List<String> namen = switch (formelsatz) {
            case P2 -> List.of("Pinst");
            case P4, P4_VARIANTE -> List.of("Pinst", "SKinst", "Painst", "Pbinst");
            default -> List.of("Pinst", "SKinst");
        };
        return P2.equals(basisfallVon(formelsatz, basisfall))
                ? namen.stream().filter(n -> !n.equals("SKinst")).toList() : namen;
    }

    /** Der Basisfall, dessen Rechengröße gilt: P1–P3 sind es selbst, P4/P4-Variante/P5 nach Vorgabe, sonst P1. */
    public static String basisfallVon(String formelsatz, String basisfall) {
        pruefeFormelsatz(formelsatz);
        if (basisfall == null) {
            return BASISFAELLE.contains(formelsatz) ? formelsatz : P1;
        }
        if (!BASISFAELLE.contains(basisfall) || !ABWANDLUNGEN.contains(formelsatz) && !basisfall.equals(formelsatz)) {
            throw new IllegalArgumentException("Basisfall „" + basisfall + "“: P4, P4-Variante und P5 gelten in "
                    + "Abwandlung zu P1, P2 oder P3 (A2 S. 34, S. 43, S. 49), " + formelsatz + " ist selbst ein Basisfall");
        }
        return basisfall;
    }

    private static List<String> rechengroessen(String basisfall) {
        return switch (basisfall) {
            case P2 -> List.of("(P2)P2");
            case P3 -> List.of("(P2)P1", "(P2)P2", "(P2)P3");
            default -> List.of("(P2)P1");
        };
    }

    @SafeVarargs
    private static List<String> folge(List<String>... teile) {
        List<String> out = new ArrayList<>();
        for (List<String> t : teile) {
            out.addAll(t);
        }
        return List.copyOf(out);
    }

    /** Die Formeln eines Formelsatzes je Ebene ({@code viertelstunde}, {@code jahr}, {@code rumpfjahr}), in Katalog-Folge. */
    public static List<String> formeln(String formelsatz, String ebene) {
        return formeln(formelsatz, ebene, null);
    }

    /** Wie {@link #formeln(String, String)}; in Abwandlung zu P2/P3 mit deren Rechengröße statt (P2)P1. */
    public static List<String> formeln(String formelsatz, String ebene, String basisfall) {
        String b = basisfallVon(formelsatz, basisfall);
        if ("jahr".equals(ebene) && ABWANDLUNGEN.contains(formelsatz) && !P1.equals(b)) {
            List<String> out = new ArrayList<>();
            formeln(formelsatz, ebene, null).forEach(nr -> {
                if (nr.equals("(P2)P1")) {
                    out.addAll(rechengroessen(b));
                } else {
                    out.add(nr);
                }
            });
            return List.copyOf(out);
        }
        return switch (ebene) {
            case "viertelstunde" -> switch (formelsatz) {
                case P4 -> List.of("(P5)¼", "(P6)¼", "(P12a)¼", "(P12b)¼", "(P13a)¼", "(P13b)¼");
                case P5 -> List.of("(P5)¼", "(P6)¼ P5", "(P12)¼", "(P13)¼ P5");
                default -> QH;
            };
            case "jahr" -> switch (formelsatz) {
                case P2 -> folge(List.of("(P1)", "(P2)P2"), SALDIERUNG, FOERDERUNG);
                case P3 -> folge(List.of("(P1)", "(P2)P1", "(P2)P2", "(P2)P3"), SALDIERUNG, FOERDERUNG);
                case P4 -> folge(List.of("(P1)", "(P2)P1"), SALDIERUNG, List.of("(ZFa)", "(ZFb)", "(P14a)", "(P14b)",
                        "(P15a)", "(P15b)", "(P16a)", "(P16b)"));
                case P4_VARIANTE -> folge(List.of("(P1)", "(P2)P1"), SALDIERUNG, FOERDERUNG, List.of("(ZFa)", "(ZFb)",
                        "(P16a)P4-Variante", "(P16b)P4-Variante"));
                default -> folge(List.of("(P1)", "(P2)P1"), SALDIERUNG, FOERDERUNG);
            };
            case "rumpfjahr" -> RUMPFJAHR;
            default -> throw new IllegalArgumentException("Ebene „" + ebene + "“ unbekannt");
        };
    }

    /** ∑J: Jahresformel → die Viertelstundengröße, über die sie summiert (Katalog {@code summe.von}). */
    public static Map<String, String> summen(String formelsatz) {
        pruefeFormelsatz(formelsatz);
        Map<String, String> m = new LinkedHashMap<>();
        m.put("(P7)", P5.equals(formelsatz) ? "(P6)¼ P5" : "(P6)¼");
        m.put("(P9)", "Z1NB¼");
        if (P4.equals(formelsatz)) {
            m.put("(P14a)", "(P13a)¼");
            m.put("(P14b)", "(P13b)¼");
        } else {
            m.put("(P14)", P5.equals(formelsatz) ? "(P13)¼ P5" : "(P13)¼");
        }
        return m;
    }

    /**
     * Eine Viertelstunde: {@code beginn} mit Versatz zur UTC, die Zählerwerte in kWh je {@link #zaehlerEingaenge},
     * „AW &gt; 0“ je geförderter {@link #awEingaenge} und SP¼ in ct/kWh.
     */
    public record Viertelstunde(OffsetDateTime beginn, Map<String, BigDecimal> zaehler, Map<String, Boolean> awGroesserNull,
            BigDecimal sp) {}

    /**
     * Ein Rumpfjahr (A2 S. 51–53, Abschn. 9): ganze Kalendertage {@code von} bis {@code bis} einschließlich in einem
     * Kalenderjahr mit seinen Stammdaten; der Schlüssel im Ergebnis ist {@code von/bis}.
     */
    public record Rumpfjahr(LocalDate von, LocalDate bis, Map<String, BigDecimal> stammdaten) {
        public String schluessel() {
            return von + "/" + bis;
        }
    }

    /** Werte einer Viertelstunde mit ihrem Beginn. */
    public record ViertelstundeWerte(OffsetDateTime beginn, Map<String, Bruch> werte) {}

    /** Viertelstundenwerte und Jahreswerte je Kalenderjahr (Schlüssel {@code 2027}) bzw. Rumpfjahr ({@code von/bis}). */
    public record Ergebnis(String formelsatz, List<ViertelstundeWerte> viertelstunden,
            Map<String, Map<String, Bruch>> jahre) {}

    private MispelPauschalRechenwerk() {}

    // ------------------------------------------------------------------ Hilfen

    private static Bruch wenn(boolean bedingung) {
        return bedingung ? Bruch.EINS : Bruch.NULL;
    }

    private static Bruch zahl(String name, BigDecimal wert) {
        if (wert == null) {
            throw new IllegalArgumentException(name + ": kein Wert — unbekannt ist keine Null");
        }
        if (wert.signum() < 0) {
            throw new IllegalArgumentException(name + " = " + wert.toPlainString()
                    + ": Strommengen und Leistungen sind nie negativ (A2 S. 27)");
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
        Set<String> fremd = new TreeSet<>(ungefoerdert);
        awEingaenge(formelsatz).forEach(fremd::remove);
        if (!fremd.isEmpty()) {
            throw new IllegalArgumentException("ungefördert sind AW-Eingänge des Formelsatzes " + formelsatz + " ("
                    + String.join(", ", awEingaenge(formelsatz)) + "), nicht " + fremd + " (A2 S. 40, S. 50)");
        }
    }

    /**
     * Die Stammdaten des Formelsatzes als Brüche: genau die des Vertrags, SKinst &gt; 0, in P4 und P4-Variante
     * Pinst = Painst + Pbinst (A2 S. 36).
     */
    public static Map<String, Bruch> stammdatenPruefen(String formelsatz, Map<String, BigDecimal> stammdaten) {
        return stammdatenPruefen(formelsatz, stammdaten, null);
    }

    public static Map<String, Bruch> stammdatenPruefen(String formelsatz, Map<String, BigDecimal> stammdaten,
            String basisfall) {
        List<String> namen = stammdaten(formelsatz, basisfall);
        Map<String, BigDecimal> s = stammdaten == null ? Map.of() : stammdaten;
        Set<String> fremd = new TreeSet<>(s.keySet());
        namen.forEach(fremd::remove);
        if (!fremd.isEmpty()) {
            throw new IllegalArgumentException(formelsatz + " kennt die Stammdaten " + fremd + " nicht (erwartet "
                    + namen + ")");
        }
        Map<String, Bruch> out = new LinkedHashMap<>();
        for (String n : namen) {
            out.put(n, zahl(n, s.get(n)));
        }
        if (out.containsKey("SKinst") && out.get("SKinst").signum() == 0) {
            throw new IllegalArgumentException("SKinst = 0: ohne Stromspeicher ist es nicht die Fallkonstellation P1 "
                    + "(A2 S. 27–28)");
        }
        if (out.containsKey("Painst")) {
            Bruch summe = out.get("Painst").plus(out.get("Pbinst"));
            if (summe.signum() == 0) {
                throw new IllegalArgumentException("Painst + Pbinst = 0: ohne installierte Leistung kein "
                        + "Zuordnungs-Faktor (A2 S. 36)");
            }
            if (out.get("Pinst").compareTo(summe) != 0) {
                throw new IllegalArgumentException("Pinst = " + out.get("Pinst").text() + " ist nicht Painst + Pbinst = "
                        + summe.text() + " (A2 S. 36)");
            }
        }
        return out;
    }

    private static Map<String, Bruch> zaehler(String formelsatz, Viertelstunde q) {
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

    /** (P12)¼ = WENN [ AW¼ &gt; 0 ; 1 ; 0 ] (A2 S. 31); ungefördert: 1 (A2 S. 40, S. 50). */
    private static Bruch aw(String name, Viertelstunde q, Set<String> ungefoerdert) {
        if (ungefoerdert.contains(name)) {
            if (q.awGroesserNull() != null && q.awGroesserNull().containsKey(name)) {
                throw new IllegalArgumentException(name + " ist ungefördert: ohne anzulegenden Wert kein AW-Eingang "
                        + "(A2 S. 40)");
            }
            return Bruch.EINS;
        }
        Boolean b = q.awGroesserNull() == null ? null : q.awGroesserNull().get(name);
        if (b == null) {
            throw new IllegalArgumentException(name + ": kein Wert — unbekannt ist keine Null");
        }
        return wenn(b);
    }

    // ------------------------------------------------------------------ die Stufen

    /** Viertelstundenwerte eines Formelsatzes aus Zählerwerten (kWh), „AW¼ &gt; 0“ und SP¼ (ct/kWh). */
    public static Map<String, Bruch> viertelstunde(String formelsatz, Viertelstunde q, Set<String> ungefoerdert) {
        pruefeFormelsatz(formelsatz);
        Set<String> ohne = ungefoerdert == null ? Set.of() : ungefoerdert;
        pruefeUngefoerdert(formelsatz, ohne);
        Map<String, Bruch> z = zaehler(formelsatz, q);
        if (q.awGroesserNull() != null) {
            Set<String> fremd = new TreeSet<>(q.awGroesserNull().keySet());
            awEingaenge(formelsatz).forEach(fremd::remove);
            if (!fremd.isEmpty()) {
                throw new IllegalArgumentException(formelsatz + " kennt die Eingänge " + fremd + " nicht");
            }
        }
        if (q.sp() == null) {
            throw new IllegalArgumentException("SP¼: kein Wert — unbekannt ist keine Null");
        }
        Bruch ne = z.get(P5.equals(formelsatz) ? "ZWNE¼" : "Z1NE¼");
        Bruch p5 = wenn(q.sp().signum() >= 0); // (P5)¼ = WENN [ SP¼ ≥ 0 ; 1 ; 0 ] (A2 S. 30)
        Map<String, Bruch> w = new LinkedHashMap<>();
        w.put("(P5)¼", p5);
        if (P4.equals(formelsatz)) {
            Bruch p12a = aw("AWa¼", q, ohne);
            Bruch p12b = aw("AWb¼", q, ohne);
            w.put("(P6)¼", p5.mal(ne));
            w.put("(P12a)¼", p12a);
            w.put("(P12b)¼", p12b);
            w.put("(P13a)¼", p12a.mal(ne));
            w.put("(P13b)¼", p12b.mal(ne));
            return w;
        }
        Bruch p12;
        if (P4_VARIANTE.equals(formelsatz)) {
            Bruch p12a = aw("AWa¼", q, ohne);
            if (p12a.compareTo(aw("AWb¼", q, ohne)) != 0) {
                throw new IllegalArgumentException("beginn = " + q.beginn() + ": die P4-Variante verlangt jederzeit "
                        + "übereinstimmende AW>0-Zeiten der Solaranlagen a und b (A2 S. 41)");
            }
            p12 = p12a;
        } else {
            p12 = aw("AW¼", q, ohne);
        }
        String sechs = P5.equals(formelsatz) ? "(P6)¼ P5" : "(P6)¼";
        String dreizehn = P5.equals(formelsatz) ? "(P13)¼ P5" : "(P13)¼";
        w.put(sechs, p5.mal(ne));
        w.put("(P12)¼", p12);
        w.put(dreizehn, p12.mal(ne));
        return w;
    }

    /** ANZAHL [ TRS ]: die Tage von {@code von} bis {@code bis} (einschließlich) in April bis September (A2 S. 53–54). */
    public static int sommertage(LocalDate von, LocalDate bis) {
        LocalDate anfang = von.isAfter(LocalDate.of(von.getYear(), 4, 1)) ? von : LocalDate.of(von.getYear(), 4, 1);
        LocalDate ende = bis.isBefore(LocalDate.of(von.getYear(), 9, 30)) ? bis : LocalDate.of(von.getYear(), 9, 30);
        return ende.isBefore(anfang) ? 0 : (int) ChronoUnit.DAYS.between(anfang, ende) + 1;
    }

    /** Die Jahreswerte aus den ∑J-Summen und den Stammdaten; im Rumpfjahr dazu (P17)–(P4)R (A2 S. 54–55). */
    public static Map<String, Bruch> jahr(String formelsatz, Map<String, Bruch> summen, Map<String, BigDecimal> stammdaten,
            Rumpfjahr rumpfjahr) {
        return jahr(formelsatz, summen, stammdaten, rumpfjahr, null);
    }

    /** Wie {@link #jahr(String, Map, Map, Rumpfjahr)}, für P4/P4-Variante/P5 in Abwandlung zu {@code basisfall}. */
    public static Map<String, Bruch> jahr(String formelsatz, Map<String, Bruch> summen, Map<String, BigDecimal> stammdaten,
            Rumpfjahr rumpfjahr, String basisfall) {
        Map<String, Bruch> s = stammdatenPruefen(formelsatz, stammdaten, basisfall);
        String basis = basisfallVon(formelsatz, basisfall);
        Map<String, Bruch> w = new LinkedHashMap<>();
        w.put("(P1)", s.get("Pinst").mal(KWH_JE_KW)); // (P1) = Pinst • 500 kWh/kW (A2 S. 28)
        Bruch p2;
        if (P2.equals(basis)) {
            p2 = NULL_KOMMA_ZWEI; // (P2)P2 = 0,2 (A2 S. 29)
            w.put("(P2)P2", p2);
        } else {
            Bruch p2p1 = NULL_KOMMA_EINS.mal(s.get("Pinst")).durch(s.get("SKinst")); // (P2)P1 (A2 S. 28–29)
            w.put("(P2)P1", p2p1);
            p2 = p2p1;
            if (P3.equals(basis)) {
                w.put("(P2)P2", NULL_KOMMA_ZWEI);
                p2 = Bruch.min(p2p1, NULL_KOMMA_ZWEI); // (P2)P3 = MIN [ (P2)P1 ; (P2)P2 ] (A2 S. 29)
                w.put("(P2)P3", p2);
            }
        }
        w.put("(P3)", p2.mal(w.get("(P1)"))); // (P3) = (P2) • (P1) (A2 S. 30)
        w.put("(P4)", w.get("(P1)").plus(w.get("(P3)"))); // (P4) = (P1) + (P3)
        Bruch foerdergrenze = w.get("(P1)");
        Bruch saldogrenze = w.get("(P4)");
        Map<String, Bruch> r = new LinkedHashMap<>();
        if (rumpfjahr != null) {
            r.put("(P17)", Bruch.von(TAGE_SOMMERPERIODE));
            r.put("(P18)", w.get("(P1)").durch(r.get("(P17)")));
            r.put("(P19)R", Bruch.von(sommertage(rumpfjahr.von(), rumpfjahr.bis())));
            r.put("(P1)R", r.get("(P19)R").mal(r.get("(P18)")));
            r.put("(P20)", Bruch.von(Year.of(rumpfjahr.von().getYear()).length()));
            r.put("(P21)", w.get("(P3)").durch(r.get("(P20)")));
            r.put("(P22)R", Bruch.von(ChronoUnit.DAYS.between(rumpfjahr.von(), rumpfjahr.bis()) + 1));
            r.put("(P3)R", r.get("(P22)R").mal(r.get("(P21)")));
            r.put("(P4)R", r.get("(P1)R").plus(r.get("(P3)R")));
            foerdergrenze = r.get("(P1)R");
            saldogrenze = r.get("(P4)R");
        }
        w.put("(P7)", summe(summen, "(P7)"));
        w.put("(P9)", summe(summen, "(P9)"));
        w.put("(P8)", Bruch.max(w.get("(P7)").minus(saldogrenze), Bruch.NULL)); // (P8) = MAX [ (P7) – (P4) ; 0 ]
        w.put("(P10)", Bruch.min(w.get("(P8)"), w.get("(P9)"))); // (P10) = MIN [ (P8) ; (P9) ] (A2 S. 31)
        w.put("(P11)", w.get("(P9)").minus(w.get("(P10)"))); // (P11) = (P9) – (P10)
        if (P4.equals(formelsatz)) {
            putZuordnungsfaktoren(w, s);
            for (String x : List.of("a", "b")) {
                w.put("(P14" + x + ")", summe(summen, "(P14" + x + ")"));
                w.put("(P15" + x + ")", Bruch.min(w.get("(P14" + x + ")"), foerdergrenze)); // A2 S. 37–38
                w.put("(P16" + x + ")", w.get("(ZF" + x + ")").mal(w.get("(P15" + x + ")")));
            }
        } else {
            w.put("(P14)", summe(summen, "(P14)"));
            w.put("(P15)", Bruch.min(w.get("(P14)"), foerdergrenze)); // (P15) = MIN [ (P14) ; (P1) ] (A2 S. 32)
            if (P4_VARIANTE.equals(formelsatz)) {
                putZuordnungsfaktoren(w, s);
                w.put("(P16a)P4-Variante", w.get("(ZFa)").mal(w.get("(P15)"))); // A2 S. 41
                w.put("(P16b)P4-Variante", w.get("(ZFb)").mal(w.get("(P15)")));
            }
        }
        Map<String, Bruch> out = new LinkedHashMap<>();
        formeln(formelsatz, "jahr", basisfall).forEach(nr -> out.put(nr, w.get(nr)));
        if (rumpfjahr != null) {
            RUMPFJAHR.forEach(nr -> out.put(nr, r.get(nr)));
        }
        return out;
    }

    /** (ZFa) = Painst / (Painst + Pbinst), (ZFb) = Pbinst / (Painst + Pbinst) (A2 S. 36). */
    private static void putZuordnungsfaktoren(Map<String, Bruch> w, Map<String, Bruch> s) {
        Bruch summe = s.get("Painst").plus(s.get("Pbinst"));
        w.put("(ZFa)", s.get("Painst").durch(summe));
        w.put("(ZFb)", s.get("Pbinst").durch(summe));
    }

    private static Bruch summe(Map<String, Bruch> summen, String nr) {
        Bruch b = summen == null ? null : summen.get(nr);
        if (b == null) {
            throw new IllegalArgumentException(nr + ": keine Summe — unbekannt ist keine Null");
        }
        return b;
    }

    // ------------------------------------------------------------------ der Lauf

    /** Rumpfjahre geordnet; jedes in einem Kalenderjahr, {@code von} ≤ {@code bis}, keine Überlappung. */
    public static List<Rumpfjahr> rumpfjahrePruefen(List<Rumpfjahr> roh) {
        List<Rumpfjahr> liste = new ArrayList<>(roh);
        for (Rumpfjahr r : liste) {
            if (r.von() == null || r.bis() == null || r.bis().isBefore(r.von()) || r.von().getYear() != r.bis().getYear()) {
                throw new IllegalArgumentException("Rumpfjahr " + r.von() + "/" + r.bis() + ": ganze Tage von ≤ bis in "
                        + "einem Kalenderjahr (A2 S. 53)");
            }
        }
        liste.sort(Comparator.comparing(Rumpfjahr::von));
        for (int i = 1; i < liste.size(); i++) {
            if (!liste.get(i).von().isAfter(liste.get(i - 1).bis())) {
                throw new IllegalArgumentException("Rumpfjahre " + liste.get(i - 1).schluessel() + " und "
                        + liste.get(i).schluessel() + " überlappen");
            }
        }
        return liste;
    }

    /**
     * Rechnet einen Formelsatz über Viertelstunden. Ohne {@code rumpfjahre} gilt das Kalenderjahr nach gesetzlicher
     * Zeit mit {@code stammdaten} für alle Jahre; mit {@code rumpfjahre} muss jede Viertelstunde an einem Tag genau
     * eines Rumpfjahres beginnen, und jedes bringt seine Stammdaten mit. Jahre sind genau die (Rumpf-)Jahre mit
     * mindestens einer Viertelstunde.
     */
    public static Ergebnis rechne(String formelsatz, List<Viertelstunde> viertelstunden, Map<String, BigDecimal> stammdaten,
            List<Rumpfjahr> rumpfjahre, Set<String> ungefoerdert) {
        return rechne(formelsatz, viertelstunden, stammdaten, rumpfjahre, ungefoerdert, null);
    }

    /** Wie oben; {@code basisfall} wählt für P4, P4-Variante und P5 die Rechengröße (Regel abwandlungen, Vorgabe P1). */
    public static Ergebnis rechne(String formelsatz, List<Viertelstunde> viertelstunden, Map<String, BigDecimal> stammdaten,
            List<Rumpfjahr> rumpfjahre, Set<String> ungefoerdert, String basisfall) {
        basisfallVon(formelsatz, basisfall);
        Set<String> ohne = ungefoerdert == null ? Set.of() : ungefoerdert;
        pruefeUngefoerdert(formelsatz, ohne);
        List<Rumpfjahr> raeume = rumpfjahre == null ? null : rumpfjahrePruefen(rumpfjahre);
        if (raeume != null && stammdaten != null) {
            throw new IllegalArgumentException("Stammdaten entweder je Rumpfjahr oder für alle Jahre, nicht beides");
        }
        if (raeume == null) {
            stammdatenPruefen(formelsatz, stammdaten, basisfall);
        }
        Map<String, Map<String, Bruch>> summen = new LinkedHashMap<>();
        Map<String, Rumpfjahr> rumpfVon = new LinkedHashMap<>();
        List<ViertelstundeWerte> ergebnisQh = new ArrayList<>();
        Instant vorher = null;
        for (Viertelstunde q : viertelstunden) {
            if (q.beginn() == null) {
                throw new IllegalArgumentException("beginn fehlt: ohne Versatz zur UTC ist der Kalendertag nicht bestimmbar");
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
            LocalDate tag = beginn.atZone(MispelAbgrenzungRechenwerk.BERLIN).toLocalDate();
            String schluessel;
            Rumpfjahr rumpf = null;
            if (raeume == null) {
                schluessel = String.valueOf(tag.getYear());
            } else {
                rumpf = raeume.stream().filter(r -> !tag.isBefore(r.von()) && !tag.isAfter(r.bis())).findFirst()
                        .orElseThrow(() -> new IllegalArgumentException("beginn = " + q.beginn()
                                + ": liegt in keinem Rumpfjahr"));
                schluessel = rumpf.schluessel();
            }
            Map<String, Bruch> qh = viertelstunde(formelsatz, q, ohne);
            Map<String, Bruch> alles = new LinkedHashMap<>(zaehler(formelsatz, q));
            alles.putAll(qh);
            Map<String, Bruch> s = summen.computeIfAbsent(schluessel, k -> {
                Map<String, Bruch> neu = new LinkedHashMap<>();
                summen(formelsatz).keySet().forEach(nr -> neu.put(nr, Bruch.NULL));
                return neu;
            });
            summen(formelsatz).forEach((nr, von) -> s.put(nr, s.get(nr).plus(alles.get(von))));
            rumpfVon.put(schluessel, rumpf);
            ergebnisQh.add(new ViertelstundeWerte(q.beginn(), qh));
        }
        Map<String, Map<String, Bruch>> jahre = new LinkedHashMap<>();
        summen.forEach((k, s) -> {
            Rumpfjahr r = rumpfVon.get(k);
            jahre.put(k, jahr(formelsatz, s, r == null ? stammdaten : r.stammdaten(), r, basisfall));
        });
        return new Ergebnis(formelsatz, List.copyOf(ergebnisQh), jahre);
    }
}
