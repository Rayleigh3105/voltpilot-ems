package com.voltpilot.api.mispel;

import com.voltpilot.api.uems.ZaehlerrolleRegeln;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Liest Lastgänge des Messstellenbetreibers im EDIFACT-Format MSCONS (MiSpeL MP-15b, Vertrag
 * {@code mispel-abgrenzung.md}, Abschnitt „Werte des Messstellenbetreibers“) in dieselben Werte wie
 * {@link MsbWerteCsv}. Rein: ohne Spring, Datenbank, Uhr.
 *
 * <p>Formatversion EDI@Energy MSCONS MIG 2.5 / AHB 3.2 (verbindlich ab 01.10.2026, BNetzA BK6 Mitteilung Nr. 56) und
 * die Vorfassung 2.4c. Gelesen wird nur, was der Abgleich braucht:
 *
 * <pre>
 * UNA:+.? '                            Trennzeichen (wahlfrei, sonst die Vorgabe)
 * UNH+1+MSCONS:D:04B:UN:2.5'           Nachricht und Version
 * LOC+172+DE0001234567890000000000000000001'   Zählpunkt (Messlokation, 33 Zeichen)
 * LIN+1'  PIA+5+1-1?:1.29.0:SRW'       Lastgang Bezug (1-1:2.29.0 Abgabe)
 * QTY+220:1.250'                       wahrer Wert in kWh (Einheit KWH oder keine)
 * DTM+163:202611302300?+00:303'        Beginn der Viertelstunde (Format 303 mit Versatz)
 * DTM+164:202611302315?+00:303'        Ende der Viertelstunde
 * UNT+…'  UNZ+…'                       Segmentzahl und Abschluss werden geprüft (abgeschnittene Datei)
 * </pre>
 *
 * Übernommen wird nur der wahre Wert ({@code QTY+220}); Ersatz-, Vorschlags-, Prognose- und nicht verwendbare Werte
 * bleiben eine Lücke und werden gezählt ({@link Gelesen#uebergangen}) — erfasst „mit mess- und eichrechtskonformen
 * Messeinrichtungen“ (Tenor S. 28) ist nur der gemessene Wert; ein späterer Import mit wahren Werten ersetzt die Lücke.
 * Lastgänge anderer OBIS-Kennzahlen (etwa Blindarbeit) werden übergangen. Nichts wird umgerechnet: eine andere Einheit
 * als kWh ist ein Fehler.
 */
public final class MsbWerteMscons {

    /** Die gelesenen Versionen (Zuordnungscode im UNH). */
    public static final Set<String> VERSIONEN = Set.of("2.4c", "2.5");
    /** Wahrer Wert (QTY 6063 = 220). */
    static final String WAHRER_WERT = "220";

    private static final Pattern FORMAT_303 = Pattern.compile("(\\d{12})([+-])(\\d{2})(\\d{2})?");
    private static final DateTimeFormatter JJJJMMTTHHMM = DateTimeFormatter.ofPattern("uuuuMMddHHmm");
    private static final Pattern MARKTLOKATION = Pattern.compile("\\d{11}");

    private MsbWerteMscons() {}

    /** Die gelesenen Werte, die Version der ersten Nachricht und wie viele Mengen ohne wahren Wert übergangen wurden. */
    public record Gelesen(String version, List<MsbWerteCsv.Wert> werte, int uebergangen) {}

    /** EDIFACT erkennt der Import am Anfang der Datei: {@code UNA} oder {@code UNB} (nach BOM und Leerraum). */
    public static boolean istEdifact(byte[] datei) {
        int i = 0;
        if (datei.length >= 3 && (datei[0] & 0xff) == 0xef && (datei[1] & 0xff) == 0xbb && (datei[2] & 0xff) == 0xbf) {
            i = 3;
        }
        while (i < datei.length && Character.isWhitespace(datei[i])) {
            i++;
        }
        if (datei.length - i < 3) {
            return false;
        }
        String anfang = new String(datei, i, 3, java.nio.charset.StandardCharsets.ISO_8859_1);
        return anfang.equals("UNA") || anfang.equals("UNB");
    }

    // ---------------------------------------------------------------- Segmente

    /** Ein Segment: Kennung, Datenelemente mit ihren Gruppendatenelementen (Freigabezeichen schon aufgelöst). */
    record Segment(int nr, List<List<String>> elemente) {
        String tag() {
            return el(0, 0);
        }

        String el(int e, int k) {
            if (e >= elemente.size() || k >= elemente.get(e).size()) {
                return "";
            }
            return elemente.get(e).get(k);
        }
    }

    /** Die Segmente der Datei und das Dezimalzeichen aus UNA. */
    record Zerlegt(List<Segment> segmente, char dezimal) {}

    static Zerlegt segmente(String text) {
        String t = text.replace("\uFEFF", "").stripLeading();
        char komp = ':';
        char daten = '+';
        char dezimal = '.';
        char frei = '?';
        char ende = '\'';
        int i = 0;
        if (t.startsWith("UNA")) {
            if (t.length() < 9) {
                throw new MsbWerteCsv.Ungueltig("unvollstaendig", 1, "Segment 1: UNA braucht sechs Zeichen.");
            }
            komp = t.charAt(3);
            daten = t.charAt(4);
            dezimal = t.charAt(5);
            frei = t.charAt(6);
            ende = t.charAt(8);
            i = 9;
        }
        List<Segment> out = new ArrayList<>();
        List<List<String>> elemente = new ArrayList<>();
        List<String> element = new ArrayList<>();
        StringBuilder teil = new StringBuilder();
        boolean begonnen = false;
        for (; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c == frei && frei != ' ') {
                if (i + 1 >= t.length()) {
                    break;
                }
                teil.append(t.charAt(++i));
                begonnen = true;
            } else if (c == '\r' || c == '\n' || !begonnen && elemente.isEmpty() && Character.isWhitespace(c)) {
                continue;
            } else if (c == ende) {
                element.add(teil.toString());
                elemente.add(element);
                out.add(new Segment(out.size() + 1, elemente));
                elemente = new ArrayList<>();
                element = new ArrayList<>();
                teil.setLength(0);
                begonnen = false;
            } else if (c == daten) {
                element.add(teil.toString());
                elemente.add(element);
                element = new ArrayList<>();
                teil.setLength(0);
                begonnen = true;
            } else if (c == komp) {
                element.add(teil.toString());
                teil.setLength(0);
                begonnen = true;
            } else {
                teil.append(c);
                begonnen |= !Character.isWhitespace(c);
            }
        }
        if (begonnen) {
            throw new MsbWerteCsv.Ungueltig("unvollstaendig", out.size() + 1, "Segment " + (out.size() + 1)
                    + " endet nicht mit dem Segment-Endezeichen " + ende + " — die Datei ist abgeschnitten.");
        }
        return new Zerlegt(out, dezimal);
    }

    // ---------------------------------------------------------------- lesen

    /** Liest eine MSCONS-Datei (Text in ISO 8859-1, Zeichensatz UNOC); wirft {@link MsbWerteCsv.Ungueltig}. */
    public static Gelesen lesen(String text) {
        if (text == null || text.isBlank()) {
            throw new MsbWerteCsv.Ungueltig("leer", 0, "Die Datei ist leer.");
        }
        Zerlegt z = segmente(text);
        return new Leser(z.dezimal()).lesen(z.segmente());
    }

    /** Der Zustand beim Durchgehen der Segmente. */
    private static final class Leser {
        private final List<MsbWerteCsv.Wert> out = new ArrayList<>();
        private final Set<String> gesehen = new HashSet<>();
        private final Set<String> fremdeObis = new LinkedHashSet<>();
        private String version;
        private String unb;
        private String unh;
        private int inNachricht;
        private int nachrichten;
        private boolean unz;
        private String zaehlpunkt;
        private boolean lin;
        private String obis;
        private String richtung;
        private Menge menge;
        private int uebergangen;
        private final char dezimal;

        Leser(char dezimal) {
            this.dezimal = dezimal;
        }

        Gelesen lesen(List<Segment> segmente) {
            for (Segment s : segmente) {
                segment(s);
            }
            if (!unz) {
                throw new MsbWerteCsv.Ungueltig("unvollstaendig", 0, "Die Datei endet ohne UNZ — sie ist "
                        + "unvollständig.");
            }
            if (out.isEmpty()) {
                if (uebergangen > 0) {
                    throw new MsbWerteCsv.Ungueltig("kein_wahrer_wert", 0, "Die Datei enthält keinen wahren Wert "
                            + "(QTY+220), nur " + uebergangen + " Ersatz- oder andere Werte.");
                }
                if (!fremdeObis.isEmpty()) {
                    throw new MsbWerteCsv.Ungueltig("obis", 0, "Die Datei enthält keinen Lastgang Bezug (1-1:1.29.0) "
                            + "oder Abgabe (1-1:2.29.0), nur " + String.join(", ", fremdeObis) + ".");
                }
                throw new MsbWerteCsv.Ungueltig("leer", 0, "Die Datei enthält keine Viertelstunde.");
            }
            return new Gelesen(version, List.copyOf(out), uebergangen);
        }

        private void segment(Segment s) {
            String tag = s.tag();
            int nr = s.nr();
            if (unz) {
                throw new MsbWerteCsv.Ungueltig("aufbau", nr, "Segment " + nr + " (" + tag + ") steht nach UNZ.");
            }
            switch (tag) {
                case "UNB" -> unb = s.el(5, 0);
                case "UNH" -> unh(s);
                case "UNZ" -> unz(s);
                default -> {
                    if (unh == null) {
                        if (!tag.equals("UNG") && !tag.equals("UNE")) {
                            throw new MsbWerteCsv.Ungueltig("aufbau", nr, "Segment " + nr + " (" + tag + ") steht "
                                    + "außerhalb einer Nachricht (UNH … UNT).");
                        }
                        return;
                    }
                    inNachricht++;
                    imInhalt(s);
                }
            }
        }

        private void unh(Segment s) {
            int nr = s.nr();
            if (unh != null) {
                throw new MsbWerteCsv.Ungueltig("unvollstaendig", nr, "Segment " + nr + ": eine neue Nachricht (UNH) "
                        + "beginnt, bevor die vorige mit UNT endet.");
            }
            String typ = s.el(2, 0);
            if (!typ.equals("MSCONS")) {
                throw new MsbWerteCsv.Ungueltig("nachrichtentyp", nr, "Segment " + nr + ": die EDIFACT-Datei enthält "
                        + "eine " + (typ.isEmpty() ? "unbenannte" : typ) + "-Nachricht — gelesen werden nur "
                        + "MSCONS-Lastgänge.");
            }
            String v = s.el(2, 4);
            if (!VERSIONEN.contains(v)) {
                throw new MsbWerteCsv.Ungueltig("version", nr, "Segment " + nr + ": MSCONS-Version „" + v + "“ wird "
                        + "nicht gelesen (gelesen werden " + String.join(", ", VERSIONEN.stream().sorted().toList())
                        + ").");
            }
            if (version == null) {
                version = v;
            }
            unh = s.el(1, 0);
            inNachricht = 1;
            zaehlpunkt = null;
            lin = false;
            richtung = null;
            obis = null;
            menge = null;
        }

        private void unz(Segment s) {
            int nr = s.nr();
            if (unh != null) {
                throw new MsbWerteCsv.Ungueltig("unvollstaendig", nr, "Segment " + nr + ": UNZ, aber die Nachricht "
                        + unh + " endet nicht mit UNT — die Datei ist unvollständig.");
            }
            if (!String.valueOf(nachrichten).equals(s.el(1, 0))) {
                throw new MsbWerteCsv.Ungueltig("unvollstaendig", nr, "Segment " + nr + ": UNZ nennt " + s.el(1, 0)
                        + " Nachrichten, die Datei enthält " + nachrichten + ".");
            }
            if (unb != null && !unb.equals(s.el(2, 0))) {
                throw new MsbWerteCsv.Ungueltig("aufbau", nr, "Segment " + nr + ": UNZ nennt die Datenaustauschreferenz "
                        + s.el(2, 0) + ", UNB " + unb + ".");
            }
            if (nachrichten == 0) {
                throw new MsbWerteCsv.Ungueltig("leer", 0, "Die Datei enthält keine MSCONS-Nachricht.");
            }
            unz = true;
        }

        private void imInhalt(Segment s) {
            int nr = s.nr();
            switch (s.tag()) {
                case "LOC" -> {
                    abschliessen();
                    if (s.el(1, 0).equals("172")) {
                        String id = s.el(2, 0);
                        if (MARKTLOKATION.matcher(id).matches()) {
                            throw new MsbWerteCsv.Ungueltig("zaehlpunkt", nr, "Segment " + nr + ": „" + id + "“ ist "
                                    + "eine Marktlokation — der Abgleich braucht den Lastgang der Messlokation "
                                    + "(Zählpunktbezeichnung, 33 Zeichen).");
                        }
                        if (!ZaehlerrolleRegeln.ZAEHLPUNKT.matcher(id).matches()) {
                            throw new MsbWerteCsv.Ungueltig("zaehlpunkt", nr, "Segment " + nr + ": „" + id + "“ ist "
                                    + "keine Zählpunktbezeichnung (33 Zeichen, „DE“ und 31 Ziffern oder "
                                    + "Großbuchstaben).");
                        }
                        zaehlpunkt = id;
                        lin = false;
                        richtung = null;
                        obis = null;
                    }
                }
                case "LIN" -> {
                    abschliessen();
                    lin = true;
                    richtung = null;
                    obis = null;
                }
                case "PIA" -> {
                    if (lin && s.el(1, 0).equals("5")) {
                        obis = s.el(2, 0);
                        richtung = richtung(obis);
                    }
                }
                case "QTY" -> {
                    abschliessen();
                    if (zaehlpunkt == null || !lin || obis == null) {
                        throw new MsbWerteCsv.Ungueltig("aufbau", nr, "Segment " + nr + ": eine Menge (QTY) ohne "
                                + "Zählpunkt (LOC+172) und OBIS-Kennzahl (LIN, PIA+5).");
                    }
                    menge = new Menge(nr, s.el(1, 0), s.el(1, 1), s.el(1, 2));
                }
                case "DTM" -> {
                    if (menge != null) {
                        String q = s.el(1, 0);
                        if (q.equals("163") || q.equals("164")) {
                            Instant t = zeitpunkt(s.el(1, 1), s.el(1, 2), nr);
                            if (q.equals("163")) {
                                menge.beginn = t;
                            } else {
                                menge.ende = t;
                            }
                        }
                    }
                }
                case "UNT" -> {
                    abschliessen();
                    if (!String.valueOf(inNachricht).equals(s.el(1, 0))) {
                        throw new MsbWerteCsv.Ungueltig("unvollstaendig", nr, "Segment " + nr + ": UNT nennt "
                                + s.el(1, 0) + " Segmente, die Nachricht " + unh + " hat " + inNachricht
                                + " — sie ist unvollständig.");
                    }
                    if (!unh.equals(s.el(2, 0))) {
                        throw new MsbWerteCsv.Ungueltig("aufbau", nr, "Segment " + nr + ": UNT nennt die Nachricht "
                                + s.el(2, 0) + ", UNH " + unh + ".");
                    }
                    unh = null;
                    nachrichten++;
                }
                default -> {
                    // BGM, DTM+137, RFF, NAD, CTA, COM, UNS, CCI, STS …: für den Abgleich ohne Belang.
                }
            }
        }

        /** Schließt die offene Menge ab: prüfen, einordnen, übernehmen oder als Lücke zählen. */
        private void abschliessen() {
            Menge m = menge;
            menge = null;
            if (m == null) {
                return;
            }
            int nr = m.nr;
            if (richtung == null) {
                fremdeObis.add(obis);
                return;
            }
            if (!m.qualifier.equals(WAHRER_WERT)) {
                uebergangen++;
                return;
            }
            if (m.beginn == null) {
                throw new MsbWerteCsv.Ungueltig("zeitstempel", nr, "Segment " + nr + ": zur Menge fehlt der Beginn "
                        + "der Viertelstunde (DTM+163).");
            }
            if (m.beginn.getEpochSecond() % 900 != 0) {
                throw new MsbWerteCsv.Ungueltig("zeitstempel", nr, "Segment " + nr + ": " + m.beginn + " ist kein "
                        + "Beginn einer Viertelstunde.");
            }
            if (m.ende != null && !m.ende.equals(m.beginn.plusSeconds(900))) {
                throw new MsbWerteCsv.Ungueltig("intervall", nr, "Segment " + nr + ": " + m.beginn + " bis " + m.ende
                        + " ist keine Viertelstunde — gelesen werden nur Viertelstundenwerte.");
            }
            if (!m.einheit.isEmpty() && !m.einheit.equals("KWH")) {
                throw new MsbWerteCsv.Ungueltig("einheit", nr, "Segment " + nr + ": die Einheit " + m.einheit
                        + " ist keine Energiemenge in kWh (KWH).");
            }
            BigDecimal kwh;
            try {
                kwh = new BigDecimal(dezimal == '.' ? m.wert : m.wert.replace(dezimal, '.'));
            } catch (NumberFormatException e) {
                throw new MsbWerteCsv.Ungueltig("kwh", nr, "Segment " + nr + ": „" + m.wert + "“ ist keine Menge in "
                        + "kWh.");
            }
            if (kwh.signum() < 0) {
                throw new MsbWerteCsv.Ungueltig("kwh", nr, "Segment " + nr + ": eine Menge je Richtung ist nie "
                        + "negativ.");
            }
            if (!gesehen.add(zaehlpunkt + "|" + richtung + "|" + m.beginn)) {
                throw new MsbWerteCsv.Ungueltig("doppelt", nr, "Segment " + nr + ": die Viertelstunde ab " + m.beginn
                        + " steht für " + zaehlpunkt + " und " + obis + " zweimal in der Datei.");
            }
            out.add(new MsbWerteCsv.Wert(zaehlpunkt, richtung, m.beginn, kwh));
            if (out.size() > MsbWerteCsv.HOECHSTENS_ZEILEN) {
                throw new MsbWerteCsv.Ungueltig("zu_gross", nr, "Die Datei hat mehr als "
                        + MsbWerteCsv.HOECHSTENS_ZEILEN + " Viertelstunden — bitte je Jahr einlesen.");
            }
        }
    }

    /** Eine Menge (QTY) mit ihrem Zeitraum aus den folgenden DTM-Segmenten. */
    private static final class Menge {
        final int nr;
        final String qualifier;
        final String wert;
        final String einheit;
        Instant beginn;
        Instant ende;

        Menge(int nr, String qualifier, String wert, String einheit) {
            this.nr = nr;
            this.qualifier = qualifier;
            this.wert = wert;
            this.einheit = einheit;
        }
    }

    /** {@code 1-1:1.29.0} Bezug, {@code 1-1:2.29.0} Abgabe; sonst {@code null} (übergangen). */
    static String richtung(String obis) {
        if (obis.startsWith("1-1:1.29.0")) {
            return MsbWerteCsv.BEZUG;
        }
        if (obis.startsWith("1-1:2.29.0")) {
            return MsbWerteCsv.ABGABE;
        }
        return null;
    }

    /** Format 303 {@code JJJJMMTTHHMM±ZZ}: Zeitpunkt mit Versatz (BDEW: UTC, {@code ?+00}). */
    static Instant zeitpunkt(String wert, String format, int nr) {
        if (!format.equals("303")) {
            throw new MsbWerteCsv.Ungueltig("zeitstempel", nr, "Segment " + nr + ": Datumsformat „" + format + "“ — "
                    + "gefordert ist 303 (Zeitpunkt mit Versatz, z. B. 202612010000?+00).");
        }
        Matcher m = FORMAT_303.matcher(wert);
        if (!m.matches()) {
            throw new MsbWerteCsv.Ungueltig("zeitstempel", nr, "Segment " + nr + ": „" + wert + "“ ist kein Zeitpunkt "
                    + "im Format 303 (JJJJMMTTHHMM mit Versatz).");
        }
        try {
            int stunden = Integer.parseInt(m.group(3));
            int minuten = m.group(4) == null ? 0 : Integer.parseInt(m.group(4));
            int vz = m.group(2).equals("-") ? -1 : 1;
            ZoneOffset versatz = ZoneOffset.ofHoursMinutes(vz * stunden, vz * minuten);
            return LocalDateTime.parse(m.group(1), JJJJMMTTHHMM).toInstant(versatz);
        } catch (java.time.DateTimeException e) {
            throw new MsbWerteCsv.Ungueltig("zeitstempel", nr, "Segment " + nr + ": „" + wert + "“ ist kein gültiger "
                    + "Zeitpunkt.");
        }
    }
}
