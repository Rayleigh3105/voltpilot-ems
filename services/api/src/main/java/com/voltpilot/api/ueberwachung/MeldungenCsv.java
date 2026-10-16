package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.ueberwachung.UeberwachungRepository.VerlaufZeile;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Der Verlauf des Meldungs-Centers als CSV (Entscheid 14A, §6.4 Nr. 8): rein, ohne Spring und ohne
 * Datenbank - liest nur die Zeilen, die {@link UeberwachungRepository#verlaufJePeriode} schon
 * gelesen hat. Dieselbe Form wie {@code BerichtCsv}: UTF-8 mit BOM, Zeilenende CRLF, eine
 * Kopfzeile; anders als die UEMS-Berichte (DA3, Dezimalkomma) ungerundete Zahlen mit Dezimalpunkt
 * und ISO-Zeit (Hausregel "UEMS-Zahlenformat") - der Verlauf trägt hier aber keine Menge, nur
 * Zeitpunkte und Wörter.
 *
 * <p><b>Entscheid 14A/MX4:</b> dieser Export ist ein Nachweis für die eigene Dokumentation - er
 * behauptet nirgends, damit eine Norm (ISO 50001 o.ä.) zu erfüllen.
 */
public final class MeldungenCsv {

    public static final String BOM = "﻿";
    public static final String ZEILENENDE = "\r\n";
    private static final String TRENNER = ";";
    private static final List<String> SPALTEN = List.of("kennzeichen", "wertart", "name", "herkunft", "bezug",
            "standort_id", "schwere", "zustand", "ausgeloest_am", "wieder_normal_am", "gesehen_von", "gesehen_am",
            "erledigt_am");

    private MeldungenCsv() {
    }

    /** Die Datei: BOM, jede Zeile mit CRLF. */
    public static byte[] datei(List<VerlaufZeile> zeilen) {
        StringBuilder s = new StringBuilder(BOM);
        zeilen(zeilen).forEach(z -> s.append(z).append(ZEILENENDE));
        return s.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** Die Zeilen der Datei, ohne BOM und Zeilenende - für den Test ohne Byte-Kodierung. */
    static List<String> zeilen(List<VerlaufZeile> zeilen) {
        List<String> raus = new ArrayList<>();
        raus.add(String.join(TRENNER, SPALTEN));
        for (VerlaufZeile z : zeilen) {
            raus.add(zeile(z));
        }
        return raus;
    }

    private static String zeile(VerlaufZeile z) {
        return String.join(TRENNER, zelle(z.kennzeichen()), zelle(z.wertart()), zelle(z.regelName()),
                zelle(herkunftWort(z.herkunft())), zelle(z.bezugKennung()),
                zelle(z.standortId() == null ? null : z.standortId().toString()), zelle(z.schwere()),
                zelle(z.zustand()), zelle(iso(z.ausgeloestAm())), zelle(iso(z.wiederNormalAm())),
                zelle(z.gesehenVon()), zelle(iso(z.gesehenAm())), zelle(iso(z.erledigtAm())));
    }

    /** Die Marke "eigene Überwachung" (§6.4 Nr. 7) auch in der CSV - sonst zwei Wörter für dieselbe Sache. */
    private static String herkunftWort(String herkunft) {
        return "eigen".equals(herkunft) ? "eigene Überwachung" : "ab Werk";
    }

    private static String iso(Instant i) {
        return i == null ? null : i.toString();
    }

    private static String zelle(String s) {
        if (s == null) {
            return "";
        }
        if (s.contains(";") || s.contains("\"") || s.contains("\n") || s.contains("\r")) {
            return "\"" + s.replace("\"", "\"\"") + "\"";
        }
        return s;
    }
}
