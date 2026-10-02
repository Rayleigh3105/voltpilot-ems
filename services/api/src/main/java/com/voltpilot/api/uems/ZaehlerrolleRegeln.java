package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Die Zählerrollen der MiSpeL-Festlegung (BNetzA, Beschluss 01.10.2026) am Messstellen-Register —
 * MiSpeL MP-6, Vertrag {@code docs/contracts/v2/mispel-zaehlerrolle.md}. Rein: ohne Spring, ohne
 * Datenbank, ohne Uhr.
 *
 * <p>Begriffe wörtlich nach Anlage 1: Z1 = Zweirichtungszähler am Netzanschluss, Z2 = Zähler der
 * Stromspeicher und/oder Ladepunkte, Z3 = Zähler des separat gemessenen Stromspeichers (Basisfall
 * A4). Die Formelsätze lesen je Viertelstunde {@code Z1NB}/{@code Z1NE}, {@code Z2V}/{@code Z2E},
 * {@code Z3V}/{@code Z3E} (Anlage 1 S. 32–33); eine Messstelle trägt genau eine Richtung, darum
 * liefert sie genau EINE dieser Größen ({@link #festlegungsgroesse}).
 *
 * <p>Die Plausibilitätsregel ist Anlage 1 S. 25, Abschn. 3.2.4: „Hinter dem Zähler Z2 für die
 * Stromspeicher und/oder Ladepunkte (und hinter Zähler Z3 für den separat gemessenen Stromspeicher
 * im Basisfall A4) darf kein sonstiger Verbrauch stattfinden und dürfen keine sonstigen
 * Erzeugungsanlagen eingebunden sein.“ Was hinter einem Zähler liegt, ist die Komponente seiner
 * führenden Quelle und jede Messstelle, die (auch mittelbar) „Unterzähler von“ ihm ist.
 */
public final class ZaehlerrolleRegeln {

    public static final String Z1 = "Z1";
    public static final String Z2 = "Z2";
    public static final String Z3 = "Z3";
    public static final List<String> ROLLEN = List.of(Z1, Z2, Z3);
    public static final List<String> EICHSTATUS = List.of("eichrechtskonform", "nicht_eichrechtskonform");
    public static final List<String> WERTEQUELLEN = List.of("messstellenbetreiber", "geraet");

    /** Die Zählpunktbezeichnung (Messlokations-ID): „DE“ und 31 Ziffern oder Großbuchstaben. */
    public static final Pattern ZAEHLPUNKT = Pattern.compile("^DE[0-9A-Z]{31}$");

    public static final String FEHLER = "fehler";
    public static final String HINWEIS = "hinweis";

    /** Die Fundstellen der Befunde, wörtlich zitierbar. */
    public static final String A1_S23 = "Anlage 1 S. 23, Abschn. 3.2.1/3.2.2";
    public static final String A1_S25 = "Anlage 1 S. 25, Abschn. 3.2.4";
    public static final String A1_S32 = "Anlage 1 S. 32–33, Formelsatz-Eingänge";
    public static final String T_S28 = "Tenor mit Begründung S. 28, Abschn. 3.2.3.2.1";
    public static final String T_S32 = "Tenor mit Begründung S. 31–32, Abschn. 3.2.3.2.2";

    /** Die Codes der Trennungs-Regel (A1 S. 25): sie lehnen das Setzen einer Rolle ab. */
    public static final Set<String> TRENNUNG = Set.of("sonstiger_verbrauch_hinter_zaehler",
            "sonstige_erzeugung_hinter_zaehler", "ladepunkt_hinter_z3");

    // Die Rollen der Topologie (TopologyDeriver), aus denen das Messobjekt einer Komponente folgt.
    static final String PV = "pv";
    static final String STORAGE = "storage";
    static final String CONSUMER = "consumer";
    static final String GRID = "grid";
    static final String CHARGING = "charging";
    static final String CHARGING_OWN = "charging-own";

    private static final String WIRKENERGIE = "Wirkenergie";
    private static final String STROM = "Strom";
    private static final String GEMESSEN = "gemessen";

    private ZaehlerrolleRegeln() {}

    /** Die Angaben einer Fassung; {@code rolle} {@code null} = keine Rolle. */
    public record Angaben(String rolle, String zaehlpunkt, String messstellenbetreiber, String eichstatus,
            LocalDate eichfristBis, String wertequelle) {}

    /** Eine Ablehnung mit Code, Status, Grund und Satz. */
    public record Ablehnung(String code, int status, String grund, String satz) {}

    /** Ein Befund der Plausibilität. {@code messstelle} trägt die Rolle, {@code betroffen} liegt hinter ihr. */
    public record Befund(String code, String schwere, String messstelle, String betroffen, String fundstelle,
            String satz) {}

    /**
     * Eine Messstelle der Anlage am Tag: ihre Richtung, ihre Stellung, ihre Rolle (oder {@code null}) und die
     * Topologie-Rollen der Komponenten ihrer führenden Quelle — leer = unbekannt, nie „nichts dahinter“.
     */
    public record Knoten(UUID id, String kennzeichen, String richtung, String stellung, UUID unterzaehlerVon,
            Angaben angaben, Set<String> messobjekt) {
        String rolle() {
            return angaben == null ? null : angaben.rolle();
        }
    }

    // ------------------------------------------------------------------ Form und Passung

    /** Formfehler der Angaben: 400 {@code zaehlerrolle_ungueltig} mit Grund, sonst {@code null}. */
    public static Ablehnung formPruefen(Angaben a) {
        if (a.rolle() != null && !ROLLEN.contains(a.rolle())) {
            return ungueltig("rolle", "„" + a.rolle() + "“ ist keine Zählerrolle. Erlaubt sind: Z1, Z2, Z3.");
        }
        if (a.rolle() == null) {
            boolean angaben = a.zaehlpunkt() != null || a.messstellenbetreiber() != null || a.eichstatus() != null
                    || a.eichfristBis() != null || a.wertequelle() != null;
            return angaben ? ungueltig("angaben_ohne_rolle",
                    "Ohne Zählerrolle gibt es keine Zähler-Angaben — die Fassung beendet die Rolle.") : null;
        }
        if (a.zaehlpunkt() != null && !ZAEHLPUNKT.matcher(a.zaehlpunkt()).matches()) {
            return ungueltig("zaehlpunkt", "Eine Zählpunktbezeichnung hat 33 Zeichen: „DE“ und 31 Ziffern oder "
                    + "Großbuchstaben.");
        }
        if (a.messstellenbetreiber() != null
                && (a.messstellenbetreiber().isBlank() || a.messstellenbetreiber().length() > 200)) {
            return ungueltig("messstellenbetreiber", "Der Messstellenbetreiber hat 1 bis 200 Zeichen.");
        }
        if (a.eichstatus() != null && !EICHSTATUS.contains(a.eichstatus())) {
            return ungueltig("eichstatus", "„" + a.eichstatus() + "“ ist kein Eichstatus. Erlaubt sind: "
                    + String.join(", ", EICHSTATUS) + " (leer = nicht erhoben).");
        }
        if (a.wertequelle() == null) {
            return ungueltig("wertequelle", "Die Wertequelle fehlt: messstellenbetreiber oder geraet.");
        }
        if (!WERTEQUELLEN.contains(a.wertequelle())) {
            return ungueltig("wertequelle", "„" + a.wertequelle() + "“ ist keine Wertequelle. Erlaubt sind: "
                    + String.join(", ", WERTEQUELLEN) + ".");
        }
        return null;
    }

    /**
     * Passt die Messstelle zur Rolle? Ein Zähler der Festlegung misst Strom als Energiemenge in einer Richtung
     * je Viertelstunde (A1 S. 23); eine berechnete Messstelle ist kein Zählpunkt. 422
     * {@code zaehlerrolle_passt_nicht} mit Grund, sonst {@code null}.
     */
    public static Ablehnung passtPruefen(String art, String medium, String groesse, String richtung, String rolle) {
        if (rolle == null) {
            return null;
        }
        if (!GEMESSEN.equals(art)) {
            return passtNicht("nicht_gemessen", "Eine berechnete Messstelle ist kein Zählpunkt — die Zähler der "
                    + "Festlegung sind Zählpunkte mit Messeinrichtung (" + A1_S23 + ").");
        }
        if (!STROM.equals(medium)) {
            return passtNicht("nicht_strom", "Zählerrollen gibt es nur für Strom.");
        }
        if (!WIRKENERGIE.equals(groesse)) {
            return passtNicht("keine_wirkenergie", "Die Formelsätze rechnen mit Strommengen je Viertelstunde — die "
                    + "Hauptgröße muss Wirkenergie sein (" + A1_S32 + ").");
        }
        if (festlegungsgroesse(rolle, richtung) == null) {
            return passtNicht("richtung", "Die Richtung „" + richtung + "“ liefert keine Größe der Festlegung — "
                    + "ein Zähler liefert Netzbezug/Verbrauch oder Netzeinspeisung/Erzeugung getrennt ("
                    + A1_S32 + ").");
        }
        return null;
    }

    /**
     * Die Größe der Formelsätze, die eine Messstelle mit dieser Rolle und Richtung liefert: Z1 · Bezug =
     * {@code Z1NB}, Z1 · Abgabe = {@code Z1NE}; Z2/Z3 · Bezug oder Laden = {@code Z2V}/{@code Z3V}, Abgabe, Entladen
     * oder Erzeugung = {@code Z2E}/{@code Z3E}; „Laden / Entladen“ in einer Messstelle trennt nichts. Sonst {@code null}.
     */
    public static String festlegungsgroesse(String rolle, String richtung) {
        if (rolle == null || richtung == null) {
            return null;
        }
        if (Z1.equals(rolle)) {
            return switch (richtung) {
                case "Bezug" -> "Z1NB";
                case "Abgabe" -> "Z1NE";
                default -> null;
            };
        }
        if (Z2.equals(rolle) || Z3.equals(rolle)) {
            return switch (richtung) {
                case "Bezug", "Laden" -> rolle + "V";
                case "Abgabe", "Entladen", "Erzeugung" -> rolle + "E";
                default -> null;
            };
        }
        return null;
    }

    /** Die andere Messstelle der Anlage, die dieselbe Größe der Festlegung liefert — oder {@code null}. */
    public static Knoten vergeben(UUID messstelle, String groesse, List<Knoten> anlage) {
        if (groesse == null) {
            return null;
        }
        for (Knoten k : anlage) {
            if (!k.id().equals(messstelle) && groesse.equals(festlegungsgroesse(k.rolle(), k.richtung()))) {
                return k;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ Plausibilität

    /** Alle Befunde der Anlage am Tag, in der Reihenfolge der Messstellen. */
    public static List<Befund> befunde(List<Knoten> anlage, LocalDate tag) {
        Map<UUID, List<Knoten>> kinder = new HashMap<>();
        for (Knoten k : anlage) {
            if (k.unterzaehlerVon() != null) {
                kinder.computeIfAbsent(k.unterzaehlerVon(), x -> new ArrayList<>()).add(k);
            }
        }
        List<Befund> out = new ArrayList<>();
        for (Knoten k : anlage) {
            String rolle = k.rolle();
            if (rolle == null) {
                continue;
            }
            angabenBefunde(k, tag, out);
            if (Z1.equals(rolle) && !"Hauptzähler".equals(k.stellung())) {
                out.add(new Befund("z1_nicht_hauptzaehler", HINWEIS, k.kennzeichen(), null, A1_S23,
                        k.kennzeichen() + " ist Z1, steht aber nicht als Hauptzähler im elektrischen Baum. Z1 ist "
                                + "der Zweirichtungszähler am Netzanschluss."));
            }
            if (Z2.equals(rolle) || Z3.equals(rolle)) {
                messobjekt(k, k, rolle, true, out);
                for (Knoten d : nachfahren(k, kinder)) {
                    if (Z2.equals(rolle) && Z3.equals(d.rolle())) {
                        continue; // A4: der separat gemessene Speicher hängt hinter Z2.
                    }
                    messobjekt(k, d, rolle, false, out);
                }
            }
        }
        paarBefunde(anlage, out);
        return out;
    }

    /** Die Befunde, die eine Messstelle betreffen: als Träger der Rolle oder als das, was hinter einer liegt. */
    public static List<Befund> befundeZu(String kennzeichen, List<Befund> alle) {
        return alle.stream().filter(b -> kennzeichen.equals(b.messstelle()) || kennzeichen.equals(b.betroffen()))
                .toList();
    }

    /**
     * Das Urteil über die Befunde einer Messstelle mit Rolle: {@code nicht_tauglich} bei einem Fehler,
     * {@code nicht_pruefbar} bei einem Unbekannten (Messobjekt, Eichstatus), sonst {@code tauglich}.
     */
    public static String urteil(String rolle, List<Befund> befunde) {
        if (rolle == null) {
            return "keine_rolle";
        }
        if (befunde.stream().anyMatch(b -> FEHLER.equals(b.schwere()))) {
            return "nicht_tauglich";
        }
        if (befunde.stream().anyMatch(b -> b.code().equals("messobjekt_unbekannt")
                || b.code().equals("eichstatus_unbekannt"))) {
            return "nicht_pruefbar";
        }
        return "tauglich";
    }

    private static void angabenBefunde(Knoten k, LocalDate tag, List<Befund> out) {
        Angaben a = k.angaben();
        String ms = k.kennzeichen();
        if (a.zaehlpunkt() == null) {
            out.add(new Befund("zaehlpunkt_fehlt", HINWEIS, ms, null, A1_S23,
                    "Für " + ms + " fehlt die Zählpunktbezeichnung. Die Zähler der Festlegung sind Zählpunkte."));
        }
        if (a.messstellenbetreiber() == null) {
            out.add(new Befund("messstellenbetreiber_fehlt", HINWEIS, ms, null, A1_S23,
                    "Für " + ms + " fehlt der Messstellenbetreiber."));
        }
        if (a.eichstatus() == null) {
            out.add(new Befund("eichstatus_unbekannt", HINWEIS, ms, null, A1_S23,
                    "Der Eichstatus von " + ms + " ist nicht erhoben. Alle Messeinrichtungen müssen mess- und "
                            + "eichrechtskonform sein."));
        } else if ("nicht_eichrechtskonform".equals(a.eichstatus())) {
            out.add(new Befund("nicht_eichrechtskonform", FEHLER, ms, null, A1_S23,
                    ms + " ist nicht mess- und eichrechtskonform. Die Festlegung verlangt mess- und eichrechtskonforme "
                            + "Messeinrichtungen."));
        } else if (a.eichfristBis() != null && a.eichfristBis().isBefore(tag)) {
            out.add(new Befund("eichfrist_abgelaufen", FEHLER, ms, null, A1_S23,
                    "Die Eichfrist von " + ms + " ist am " + a.eichfristBis() + " abgelaufen."));
        }
        if ("geraet".equals(a.wertequelle())) {
            out.add(new Befund("wertequelle_geraet", HINWEIS, ms, null, T_S28,
                    ms + " liefert Gerätewerte. Für Nachweis und Abrechnung zählen nur mess- und eichrechtskonform "
                            + "erfasste Werte."));
        }
    }

    /**
     * Was {@code d} misst, hinter (oder als) dem Zähler {@code z} mit Rolle {@code rolle}: erlaubt sind hinter Z2
     * Speicher und Ladepunkte, hinter Z3 nur Speicher (A1 S. 25). Eine Komponente mit Speicher UND Solar ist
     * gleichstromseitig gekoppelt — dann braucht es eine geeichte DC-Messung (T S. 31–32), die das Register
     * nicht kennt: ein Hinweis, kein Fehler.
     */
    private static void messobjekt(Knoten z, Knoten d, String rolle, boolean selbst, List<Befund> out) {
        String betroffen = selbst ? null : d.kennzeichen();
        String wo = selbst ? z.kennzeichen() + " (" + rolle + ") misst" : "Hinter " + z.kennzeichen() + " (" + rolle
                + ") hängt " + d.kennzeichen() + " und misst";
        Set<String> m = d.messobjekt();
        if (m == null || m.isEmpty()) {
            out.add(new Befund("messobjekt_unbekannt", HINWEIS, z.kennzeichen(), betroffen, A1_S25,
                    wo + " eine Komponente ohne bekannte Rolle — ob die Trennung hält, ist nicht prüfbar."));
            return;
        }
        boolean speicher = m.contains(STORAGE);
        boolean ladepunkt = m.contains(CHARGING) || m.contains(CHARGING_OWN);
        if (m.contains(PV)) {
            if (speicher || ladepunkt) {
                out.add(new Befund("dc_kopplung_erzeugung", HINWEIS, z.kennzeichen(), betroffen, T_S32,
                        wo + " Speicher und Solarerzeugung derselben Komponente. Bei gleichstromseitiger Kopplung ist "
                                + "eine geeichte DC-Messung erforderlich."));
            } else {
                out.add(new Befund("sonstige_erzeugung_hinter_zaehler", FEHLER, z.kennzeichen(), betroffen, A1_S25,
                        wo + " eine sonstige Erzeugungsanlage. Hinter " + rolle + " dürfen keine sonstigen "
                                + "Erzeugungsanlagen eingebunden sein."));
            }
        }
        if (m.contains(CONSUMER) || m.contains(GRID)) {
            out.add(new Befund("sonstiger_verbrauch_hinter_zaehler", FEHLER, z.kennzeichen(), betroffen, A1_S25,
                    wo + " sonstigen Verbrauch. Hinter " + rolle + " darf kein sonstiger Verbrauch stattfinden."));
        }
        if (Z3.equals(rolle) && ladepunkt) {
            out.add(new Befund("ladepunkt_hinter_z3", FEHLER, z.kennzeichen(), betroffen, A1_S25,
                    wo + " einen Ladepunkt. Z3 misst den Stromspeicher allein (Basisfall A4)."));
        }
    }

    /** Z1NB und Z1NE (bzw. V und E) sind EIN Zweirichtungszähler: ein Zählpunkt, beide Richtungen vorhanden. */
    private static void paarBefunde(List<Knoten> anlage, List<Befund> out) {
        Map<String, List<Knoten>> jeRolle = new HashMap<>();
        for (Knoten k : anlage) {
            if (k.rolle() != null) {
                jeRolle.computeIfAbsent(k.rolle(), x -> new ArrayList<>()).add(k);
            }
        }
        for (String rolle : ROLLEN) {
            List<Knoten> ks = jeRolle.getOrDefault(rolle, List.of());
            if (ks.isEmpty()) {
                continue;
            }
            Set<String> punkte = new LinkedHashSet<>();
            Set<String> groessen = new HashSet<>();
            for (Knoten k : ks) {
                if (k.angaben().zaehlpunkt() != null) {
                    punkte.add(k.angaben().zaehlpunkt());
                }
                groessen.add(festlegungsgroesse(rolle, k.richtung()));
            }
            if (punkte.size() > 1) {
                for (Knoten k : ks) {
                    out.add(new Befund("zaehlpunkt_abweichend", FEHLER, k.kennzeichen(), null, A1_S23,
                            "Die Messstellen mit Rolle " + rolle + " nennen verschiedene Zählpunkte (" + String.join(
                                    ", ", punkte) + "). " + rolle + " ist EIN Zweirichtungszähler."));
                }
            }
            String v = Z1.equals(rolle) ? "Z1NB" : rolle + "V";
            String e = Z1.equals(rolle) ? "Z1NE" : rolle + "E";
            String fehlt = !groessen.contains(v) ? v : !groessen.contains(e) ? e : null;
            if (fehlt != null) {
                for (Knoten k : ks) {
                    out.add(new Befund("gegenrichtung_fehlt", HINWEIS, k.kennzeichen(), null, A1_S32,
                            "Für " + rolle + " fehlt die Messstelle der Größe " + fehlt + " — die Formelsätze lesen "
                                    + "beide Richtungen je Viertelstunde."));
                }
            }
        }
    }

    /** Alle Messstellen, die (auch mittelbar) Unterzähler von {@code k} sind — ohne Kreis. */
    private static List<Knoten> nachfahren(Knoten k, Map<UUID, List<Knoten>> kinder) {
        List<Knoten> out = new ArrayList<>();
        Set<UUID> gesehen = new HashSet<>();
        gesehen.add(k.id());
        List<Knoten> offen = new ArrayList<>(kinder.getOrDefault(k.id(), List.of()));
        while (!offen.isEmpty()) {
            Knoten d = offen.remove(0);
            if (!gesehen.add(d.id())) {
                continue;
            }
            out.add(d);
            offen.addAll(kinder.getOrDefault(d.id(), List.of()));
        }
        return out;
    }

    private static Ablehnung ungueltig(String grund, String satz) {
        return new Ablehnung("zaehlerrolle_ungueltig", 400, grund, satz);
    }

    private static Ablehnung passtNicht(String grund, String satz) {
        return new Ablehnung("zaehlerrolle_passt_nicht", 422, grund, satz);
    }

    /** Gleich bis auf die Schreibweise? (für {@code zaehlerrolle_unveraendert}) */
    public static boolean gleich(Angaben a, Angaben b) {
        return Objects.equals(a, b);
    }
}
