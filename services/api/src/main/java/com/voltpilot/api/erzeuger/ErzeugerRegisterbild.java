package com.voltpilot.api.erzeuger;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * UEMS EZ-6: das VoltPilot-Registerbild Erzeuger v1 (schlanke Fassung, Konzept vp-erzeuger-wago-konzept §3.7,
 * EW-17 A) aus Sicht der Cloud — die Punktschlüssel der Katalogfamilie {@value #FAMILIE} und das Vokabular der
 * Zustände und Bitfelder.
 *
 * <p>Zwilling der Katalogquelle {@code catalog/measurement-points/sources/voltpilot/erzeuger-registerbild-v1.json};
 * {@code ErzeugerRegisterbildTest} hält Abschnitte, Felder, Arten, Einheiten, Vokabular und Bits Zeichen für
 * Zeichen gegen sie. Das Vokabular ist Cloud-Wissen für die Anzeige: die Box reicht Rohwerte, und ein Wert
 * außerhalb des Vokabulars bleibt ein Rohwert ohne Wort (EZ-1 Lesart 6) — nie ein geratenes.
 *
 * <p>Schlüssel: feste Abschnitte {@code erzeuger.<abschnitt>.<feld>}, je Einheit {@code erzeuger.te[n].<feld>}
 * mit n = TE-Nr. 1 … {@value #MAX_EINHEITEN} (Katalogvorlage {@code erzeuger.te[*].<feld>}). Die Feldnamen sind
 * die der Vorlage, unverändert.
 */
public final class ErzeugerRegisterbild {

    /** Die Katalogfamilie (noch an keiner Box, bis EZ-5 den Leser ausliefert). */
    public static final String FAMILIE = "voltpilot.erzeuger_registerbild_v1";
    /** Das Fähigkeitswort der Box ({@code docs/contracts/v2/edge-supports-vectors.json}). */
    public static final String FAEHIGKEIT = "erzeuger_registerbild";
    /** Die Bildart der Registerbild-Fassung. */
    public static final String BILDART = "erzeuger";
    /** Höchstens zehn Einheiten je Bild (EZ-1 A1). */
    public static final int MAX_EINHEITEN = 10;
    /** Der Abschnitt der Einheiten-Vorlage in der Quelle. */
    public static final String EINHEIT = "te[*]";

    private static final Pattern SCHLUESSEL =
            Pattern.compile("^erzeuger\\.(kopf|a|nb|dv|wirkung|te\\[([1-9]|10)])\\.([a-z_]+)$");

    /** Ein Wort eines Zustands: der Rohwert, das Maschinenwort und der Text der Anzeige. */
    public record Wort(int wert, String wort, String text) {}

    /** Ein Bit eines Bitfelds. */
    public record Bit(int bit, String wort, String text) {}

    /**
     * Ein Feld des Bilds. {@code art} ist die Katalog-Aggregation (gauge · counter · state · bitfield),
     * {@code einheit} die Einheit des dekodierten Werts (null = ohne Einheit).
     */
    public record Feld(String abschnitt, String feld, String art, String einheit, List<Wort> vokabular,
            List<Bit> bits) {}

    private static final List<Wort> ZUSTAND = List.of(
            new Wort(0, "aus", "aus"), new Wort(1, "bereit", "bereit"), new Wort(2, "laeuft", "läuft"),
            new Wort(3, "laeuft_begrenzt", "läuft begrenzt"), new Wort(4, "stoerung", "Störung"),
            new Wort(5, "hand_wartung", "Hand/Wartung"), new Wort(6, "not_aus", "Not-Aus"));

    static final List<Feld> FELDER = List.of(
            zahl("kopf", "te_anzahl", "state", null),
            zahl("kopf", "programmstand", "state", null),
            zahl("kopf", "steuerung_id", "state", null),
            zustand("kopf", "anlagenart", List.of(new Wort(1, "pv", "PV"), new Wort(2, "bhkw", "BHKW"),
                    new Wort(3, "gemischt", "gemischt"))),
            bits("a", "a_gueltig", List.of(new Bit(0, "netzpunkt_gueltig", "Netzpunkt gültig"),
                    new Bit(1, "netzpunkt_berechnet", "Netzpunkt berechnet"),
                    new Bit(2, "netzpunkt_messung_tot", "Netzpunkt-Messung tot"),
                    new Bit(3, "erzeugung_gueltig", "Erzeugung gültig"),
                    new Bit(4, "gasspeicher_gueltig", "Gasspeicher gültig"))),
            zahl("a", "a_alter_s", "gauge", "s"),
            zahl("a", "p_nvp_w", "gauge", "W"),
            zahl("a", "p_erzeugung_w", "gauge", "W"),
            zustand("a", "anlage_zustand", ZUSTAND),
            bits("a", "a_bits", List.of(new Bit(0, "not_aus_vor_ort", "Not-Aus vor Ort"),
                    new Bit(1, "na_schutz", "NA-Schutz"), new Bit(2, "sammelstoerung", "Sammelstörung"),
                    new Bit(3, "hand_ort", "Hand/Ort"), new Bit(4, "wartung", "Wartung"))),
            zahl("a", "speicher_fuellstand", "gauge", "%"),
            zahl("a", "p_installiert_kw", "state", "kW"),
            zustand("nb", "n_kanal", List.of(new Wort(0, "keiner", "keiner"),
                    new Wort(1, "feste_grenze", "feste Grenze"), new Wort(2, "stufen", "Stufen"),
                    new Wort(3, "fernwirktechnik", "Fernwirktechnik"))),
            bits("nb", "n_bits", List.of(new Bit(0, "vorgabe_gueltig", "Vorgabe gültig"),
                    new Bit(1, "verbindung_steht", "Verbindung steht"),
                    new Bit(2, "wirkleistung_begrenzt", "Wirkleistung begrenzt"), new Bit(3, "not_aus", "Not-Aus"),
                    new Bit(4, "cosphi_vorgabe", "cos-φ-Vorgabe"), new Bit(5, "kennlinie", "Kennlinie"))),
            zahl("nb", "n_p_prozent", "gauge", "%"),
            zahl("nb", "n_cosphi", "gauge", "PF"),
            zahl("nb", "n_seit_s", "gauge", "s"),
            zahl("nb", "n_zaehler", "counter", null),
            zustand("dv", "d_kanal", List.of(new Wort(0, "keiner", "keiner"),
                    new Wort(1, "relais_ma", "Relais und mA"), new Wort(2, "modbus", "Modbus"))),
            bits("dv", "d_bits", List.of(new Bit(0, "abschnitt_gueltig", "Abschnitt gültig"),
                    new Bit(1, "aktivierung", "Aktivierung"), new Bit(2, "stopp", "Stopp"),
                    new Bit(3, "bereit_gemeldet", "bereit gemeldet"), new Bit(4, "aktiv_gemeldet", "aktiv gemeldet"))),
            zahl("dv", "d_soll_w", "gauge", "W"),
            zahl("dv", "d_seit_s", "gauge", "s"),
            zahl("dv", "d_zaehler", "counter", null),
            zustand("wirkung", "quelle_p", List.of(new Wort(0, "keine_grenze", "keine Grenze"),
                    new Wort(1, "netzbetreiber", "Netzbetreiber"), new Wort(2, "direktvermarkter", "Direktvermarkter"),
                    new Wort(3, "netzpunkt_regelung", "Netzpunkt-Regelung"), new Wort(4, "hand", "Hand"),
                    new Wort(5, "not_aus", "Not-Aus"), new Wort(6, "ersatzwert", "Ersatzwert"))),
            bits("wirkung", "s_bits", List.of(new Bit(0, "gueltig", "gültig"),
                    new Bit(1, "anlage_folgt", "Anlage folgt"))),
            zahl("wirkung", "p_grenze_w", "gauge", "W"),
            zustand(EINHEIT, "t_zustand", ZUSTAND),
            bits(EINHEIT, "t_bits", List.of(new Bit(0, "werte_gueltig", "Werte gültig"),
                    new Bit(1, "sollwert_gueltig", "Sollwert gültig"),
                    new Bit(2, "dv_bereit", "bereit für den Direktvermarkter"),
                    new Bit(3, "dv_aktiv", "vom Direktvermarkter aktiv"), new Bit(4, "stoerung", "Störung"),
                    new Bit(5, "vorgabe_netzbetreiber", "Vorgabe des Netzbetreibers (§ 9 EEG)"),
                    new Bit(6, "hand_ort", "Hand/Ort"), new Bit(7, "wartung", "Wartung"),
                    new Bit(8, "gasspeicher_leer", "Gasspeicher leer"), new Bit(9, "sonstiger", "sonstiger Grund"))),
            zustand(EINHEIT, "t_art", List.of(new Wort(1, "pv_wechselrichter", "PV-Wechselrichter"),
                    new Wort(2, "bhkw_motor", "BHKW-Motor"))),
            zahl(EINHEIT, "t_nenn_kw", "state", "kW"),
            zahl(EINHEIT, "t_p_ist_w", "gauge", "W"),
            zahl(EINHEIT, "t_p_soll_w", "gauge", "W"),
            zahl(EINHEIT, "t_e", "counter", "kWh"));

    private ErzeugerRegisterbild() {}

    /**
     * Die konkreten Punktschlüssel eines Bilds mit {@code teAnzahl} Einheiten, in Bildreihenfolge: erst die
     * festen Abschnitte, dann je Einheit 1 … teAnzahl ihre Felder.
     */
    public static List<String> punkte(int teAnzahl) {
        if (teAnzahl < 1 || teAnzahl > MAX_EINHEITEN) {
            throw new IllegalArgumentException("te_anzahl außerhalb 1 … " + MAX_EINHEITEN + ": " + teAnzahl);
        }
        List<String> out = new ArrayList<>();
        for (Feld f : FELDER) {
            if (!EINHEIT.equals(f.abschnitt())) {
                out.add("erzeuger." + f.abschnitt() + "." + f.feld());
            }
        }
        for (int te = 1; te <= teAnzahl; te++) {
            for (Feld f : FELDER) {
                if (EINHEIT.equals(f.abschnitt())) {
                    out.add("erzeuger.te[" + te + "]." + f.feld());
                }
            }
        }
        return List.copyOf(out);
    }

    /**
     * Die Punkte, die als Kurve taugen (UEMS EZ-10, Verlauf › Messwerte): jeder Momentanwert in W oder % —
     * Netzpunkt, Erzeugung, Gasspeicher, Vorgaben von Netzbetreiber und Direktvermarkter, wirksame Grenze und je
     * Einheit Ist und Soll. Alter, „seit“ und cos φ sind keine Kurve. Dazu je Einheit der Zählerstand Erzeugung
     * {@code t_e} in kWh (GE-3, additiv): aus ihm liest die Seite der Einheit die Energie heute.
     */
    public static List<String> kurven(int teAnzahl) {
        return punkte(teAnzahl).stream().filter(k -> feld(k).filter(ErzeugerRegisterbild::kurve).isPresent())
                .toList();
    }

    private static boolean kurve(Feld f) {
        return "gauge".equals(f.art()) && ("W".equals(f.einheit()) || "%".equals(f.einheit()))
                || "counter".equals(f.art()) && "kWh".equals(f.einheit());
    }

    /** Das Feld eines konkreten Punktschlüssels — leer für jeden fremden Schlüssel. */
    public static Optional<Feld> feld(String pointKey) {
        Matcher m = pointKey == null ? null : SCHLUESSEL.matcher(pointKey);
        if (m == null || !m.matches()) {
            return Optional.empty();
        }
        String abschnitt = m.group(2) != null ? EINHEIT : m.group(1);
        return FELDER.stream().filter(f -> f.abschnitt().equals(abschnitt) && f.feld().equals(m.group(3)))
                .findFirst();
    }

    /** Die TE-Nr. eines Einheiten-Schlüssels ({@code erzeuger.te[2].t_p_ist_w} → 2); leer für feste Abschnitte. */
    public static Optional<Integer> teNr(String pointKey) {
        Matcher m = pointKey == null ? null : SCHLUESSEL.matcher(pointKey);
        return m != null && m.matches() && m.group(2) != null ? Optional.of(Integer.valueOf(m.group(2)))
                : Optional.empty();
    }

    /** Das Wort eines Zustands-Rohwerts — leer außerhalb des Vokabulars (der Wert bleibt roh). */
    public static Optional<Wort> wort(Feld feld, long roh) {
        return feld.vokabular().stream().filter(w -> w.wert() == roh).findFirst();
    }

    /** Die gesetzten Bits eines Bitfeld-Rohwerts, die das Vokabular kennt (unbekannte Bits fehlen, nie geraten). */
    public static List<Bit> gesetzt(Feld feld, long roh) {
        return feld.bits().stream().filter(b -> ((roh >> b.bit()) & 1L) == 1L).toList();
    }

    private static Feld zahl(String abschnitt, String feld, String art, String einheit) {
        return new Feld(abschnitt, feld, art, einheit, List.of(), List.of());
    }

    private static Feld zustand(String abschnitt, String feld, List<Wort> vokabular) {
        return new Feld(abschnitt, feld, "state", null, vokabular, List.of());
    }

    private static Feld bits(String abschnitt, String feld, List<Bit> bits) {
        return new Feld(abschnitt, feld, "bitfield", null, List.of(), bits);
    }
}
