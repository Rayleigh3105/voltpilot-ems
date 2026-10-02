package com.voltpilot.api.mispel;

import com.voltpilot.api.uems.ZaehlerrolleRegeln;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Liest die einfache CSV mit Viertelstundenwerten des Messstellenbetreibers (MiSpeL MP-15, Vertrag
 * {@code mispel-abgrenzung.md}, Abschnitt „Werte des Messstellenbetreibers“). Rein: ohne Spring, Datenbank, Uhr.
 *
 * <pre>
 * zeitstempel;zaehlpunkt;richtung;kwh
 * 2026-12-01T00:00+01:00;DE0003374000000000000000001234567;bezug;1,250
 * </pre>
 *
 * Eine Kopfzeile mit genau diesen vier Spalten (Reihenfolge frei), Trennzeichen {@code ;} oder {@code ,}, Zeilen mit
 * {@code #} am Anfang und leere Zeilen werden übersprungen. {@code zeitstempel} ist der Beginn der Viertelstunde mit
 * Versatz (ISO 8601), {@code richtung} {@code bezug}/{@code abgabe} oder die OBIS-Kennzahl des Lastgangs
 * ({@code 1-1:1.29.0} Bezug, {@code 1-1:2.29.0} Abgabe), {@code kwh} die Menge der Viertelstunde ≥ 0 (Dezimalkomma
 * nur beim Trennzeichen {@code ;}). Nichts wird ergänzt oder umgerechnet: eine fehlende Viertelstunde bleibt fehlend.
 */
public final class MsbWerteCsv {

    public static final String BEZUG = "bezug";
    public static final String ABGABE = "abgabe";
    public static final List<String> SPALTEN = List.of("zeitstempel", "zaehlpunkt", "richtung", "kwh");
    /** Höchstens ein Jahr mit vier Richtungen. */
    public static final int HOECHSTENS_ZEILEN = 4 * 35_136;

    private MsbWerteCsv() {}

    /** Ein Viertelstundenwert des Messstellenbetreibers. */
    public record Wert(String zaehlpunkt, String richtung, Instant beginn, BigDecimal kwh) {}

    /** Eine abgelehnte Datei: {@code grund} und die Zeile (1-basiert, 0 = die ganze Datei). */
    public static final class Ungueltig extends RuntimeException {
        private final String grund;
        private final int zeile;

        Ungueltig(String grund, int zeile, String satz) {
            super(satz);
            this.grund = grund;
            this.zeile = zeile;
        }

        public String grund() {
            return grund;
        }

        public int zeile() {
            return zeile;
        }
    }

    public static List<Wert> lesen(String text) {
        if (text == null || text.isBlank()) {
            throw new Ungueltig("leer", 0, "Die Datei ist leer.");
        }
        String[] zeilen = text.replace("﻿", "").split("\r?\n", -1);
        int[] idx = null;
        char trenner = ';';
        List<Wert> out = new ArrayList<>();
        Set<String> gesehen = new HashSet<>();
        for (int i = 0; i < zeilen.length; i++) {
            String z = zeilen[i].strip();
            int nr = i + 1;
            if (z.isEmpty() || z.startsWith("#")) {
                continue;
            }
            if (idx == null) {
                trenner = z.indexOf(';') >= 0 ? ';' : ',';
                idx = kopf(z, trenner, nr);
                continue;
            }
            String[] f = z.split(String.valueOf(trenner), -1);
            if (f.length != SPALTEN.size()) {
                throw new Ungueltig("spalten", nr, "Zeile " + nr + " hat " + f.length + " statt " + SPALTEN.size()
                        + " Spalten.");
            }
            Instant beginn = zeitstempel(f[idx[0]].strip(), nr);
            String zp = f[idx[1]].strip();
            if (!ZaehlerrolleRegeln.ZAEHLPUNKT.matcher(zp).matches()) {
                throw new Ungueltig("zaehlpunkt", nr, "Zeile " + nr + ": „" + zp + "“ ist keine Zählpunktbezeichnung "
                        + "(33 Zeichen, „DE“ und 31 Ziffern oder Großbuchstaben).");
            }
            String richtung = richtung(f[idx[2]].strip(), nr);
            BigDecimal kwh = kwh(f[idx[3]].strip(), trenner, nr);
            if (!gesehen.add(zp + "|" + richtung + "|" + beginn)) {
                throw new Ungueltig("doppelt", nr, "Zeile " + nr + ": die Viertelstunde " + f[idx[0]].strip()
                        + " steht für diesen Zählpunkt und diese Richtung zweimal in der Datei.");
            }
            out.add(new Wert(zp, richtung, beginn, kwh));
            if (out.size() > HOECHSTENS_ZEILEN) {
                throw new Ungueltig("zu_gross", nr, "Die Datei hat mehr als " + HOECHSTENS_ZEILEN
                        + " Viertelstunden — bitte je Jahr einlesen.");
            }
        }
        if (idx == null) {
            throw new Ungueltig("kopf", 0, "Die Kopfzeile fehlt: " + String.join(";", SPALTEN) + ".");
        }
        if (out.isEmpty()) {
            throw new Ungueltig("leer", 0, "Die Datei enthält keine Viertelstunde.");
        }
        return List.copyOf(out);
    }

    private static int[] kopf(String z, char trenner, int nr) {
        String[] f = z.split(String.valueOf(trenner), -1);
        int[] idx = {-1, -1, -1, -1};
        for (int i = 0; i < f.length; i++) {
            int s = SPALTEN.indexOf(f[i].strip().toLowerCase(Locale.ROOT));
            if (s >= 0 && idx[s] < 0) {
                idx[s] = i;
            }
        }
        for (int i : idx) {
            if (i < 0 || f.length != SPALTEN.size()) {
                throw new Ungueltig("kopf", nr, "Die Kopfzeile braucht genau die Spalten " + String.join(";", SPALTEN)
                        + ".");
            }
        }
        return idx;
    }

    private static Instant zeitstempel(String s, int nr) {
        Instant t;
        try {
            t = OffsetDateTime.parse(s).toInstant();
        } catch (DateTimeParseException e) {
            throw new Ungueltig("zeitstempel", nr, "Zeile " + nr + ": „" + s + "“ ist kein Zeitpunkt mit Versatz "
                    + "(z. B. 2026-12-01T00:00+01:00).");
        }
        if (t.getEpochSecond() % 900 != 0 || t.getNano() != 0) {
            throw new Ungueltig("zeitstempel", nr, "Zeile " + nr + ": „" + s + "“ ist kein Beginn einer Viertelstunde.");
        }
        return t;
    }

    static String richtung(String s, int nr) {
        String r = s.toLowerCase(Locale.ROOT);
        if (r.equals(BEZUG) || r.startsWith("1-1:1.29.0")) {
            return BEZUG;
        }
        if (r.equals(ABGABE) || r.startsWith("1-1:2.29.0")) {
            return ABGABE;
        }
        throw new Ungueltig("richtung", nr, "Zeile " + nr + ": „" + s + "“ ist keine Richtung (bezug, abgabe, "
                + "1-1:1.29.0 oder 1-1:2.29.0).");
    }

    private static BigDecimal kwh(String s, char trenner, int nr) {
        String t = trenner == ';' ? s.replace(',', '.') : s;
        BigDecimal v;
        try {
            v = new BigDecimal(t);
        } catch (NumberFormatException e) {
            throw new Ungueltig("kwh", nr, "Zeile " + nr + ": „" + s + "“ ist keine Menge in kWh.");
        }
        if (v.signum() < 0) {
            throw new Ungueltig("kwh", nr, "Zeile " + nr + ": eine Menge je Richtung ist nie negativ.");
        }
        return v;
    }

    /** Bezug/Abgabe der Datei aus der Richtung einer Messstelle (Laden ist Bezug, Entladen und Erzeugung Abgabe). */
    public static String richtungDerMessstelle(String richtung) {
        if (richtung == null) {
            return null;
        }
        return switch (richtung) {
            case "Bezug", "Laden" -> BEZUG;
            case "Abgabe", "Entladen", "Erzeugung" -> ABGABE;
            default -> null;
        };
    }
}
