package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

/**
 * Der Berichts-CSV eines Berichtsstands (UEMS AP-12 IP-10, E11 DA3) — rein, ohne Spring und ohne Datenbank. Er liest NUR
 * den Abzug und die Freigabe des Stands (A1): nichts wird nachgeschlagen, darum ist die Datei in zehn Jahren dieselbe wie
 * heute, auch wenn Rohdaten, Tageszeilen oder Stammdaten längst anders sind.
 *
 * <p><b>Die Form</b> (bericht.md §10 DA3): UTF-8 mit BOM, Zeilenende CRLF, die 16 Kopfzeilen aus
 * {@link BerichtRegeln#csvKopf}, bei einem ersetzten Stand direkt dahinter {@code # wasserzeichen=ersetzt durch Nr. n (Datum)},
 * dann die 13 Spalten ({@link BerichtRegeln#CSV_SPALTEN}) und je Abschnitt {@code # abschnitt=<Schlüssel der Vorlage>} mit
 * einer Zeile je Wert ({@link BerichtRegeln#csvZeile}). Zwei Abrufe desselben Stands unterscheiden sich nur in
 * {@code erzeugt_am}, {@code erzeugt_von} und {@code teilansicht}.
 *
 * <p><b>Welche Abschnitte Zeilen tragen</b> — die mit Werten in der Trägerform des Abzugs, in der Folge aller vier Vorlagen
 * der Fassung 1: am Standort {@code verbrauch_je_messstelle} ({@code werte}), am Unternehmen {@code standorte}
 * ({@code werte}) und {@code kostenstellen} (je Kostenstelle ihr Block {@code summe}), an beiden {@code kennzahlen}. Kopf,
 * Zusammenfassung, Qualität und Quellenverzeichnis sind keine Werte; Monatswerte trägt der Abzug noch nicht.
 *
 * <p><b>Kennzahlen</b> (firstmate 001 = A): ihre Richtung (Untergrenze, Obergrenze, unbestimmt) steht als Kennzeichen in der
 * Zelle {@code kennzeichen} — keine 14. Spalte. Seit Vertrag 1.2 trägt eine Kennzahl {@code ort_zum_datenstand} und
 * {@code endgueltig_ab} wie ein Wert; das Mapping las beide schon immer aus demselben Knoten, darum füllen sich die zwei
 * Zellen von selbst, sobald der Abzug sie trägt (B14/KZ-0001: {@code G-2}, {@code 2026-11-08}). Ein Abzug nach 1.0/1.1
 * trägt sie nicht — dort bleiben die Zellen leer, und das ist die Lücke, nicht die Null. Der Tagesverlauf ist KEIN Wert
 * und erscheint nicht in der CSV; sein Nachweis steht an der Monatszeile. Die Periode einer Kennzahl ist der Zeitraum
 * des Berichts (Q4).
 */
public final class BerichtCsv {

    public static final String BOM = "﻿";
    public static final String ZEILENENDE = "\r\n";
    public static final String WASSERZEICHEN = "wasserzeichen";
    public static final String ABSCHNITT = "abschnitt";
    public static final String MESSSTELLEN = "verbrauch_je_messstelle";
    public static final String STANDORTE = "standorte";
    public static final String KOSTENSTELLEN = "kostenstellen";
    public static final String KENNZAHLEN = "kennzahlen";
    /** Die Abschnitte mit Zeilen je Geltung, in der Folge der Vorlagen (Fassung 1). */
    public static final List<String> ABSCHNITTE_STANDORT = List.of(MESSSTELLEN, KENNZAHLEN);
    public static final List<String> ABSCHNITTE_UNTERNEHMEN = List.of(STANDORTE, KOSTENSTELLEN, KENNZAHLEN);

    /** Was der Stand über den Abzug hinaus trägt: Nr., Freigabe, Prüfsumme und — wenn ersetzt — durch welche Nr., wann. */
    public record Stand(int nr, Instant freigegebenAm, String freigegebenVon, String pruefsumme, Integer ersetztDurchNr,
            Instant ersetztAm) {}

    private BerichtCsv() {
    }

    /** Die Datei: BOM, jede Zeile mit CRLF. */
    public static byte[] datei(JsonNode abzug, Stand stand, Instant erzeugtAm, String erzeugtVon, List<String> teilansicht) {
        StringBuilder s = new StringBuilder(BOM);
        zeilen(abzug, stand, erzeugtAm, erzeugtVon, teilansicht).forEach(z -> s.append(z).append(ZEILENENDE));
        return s.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** Die Zeilen der Datei, ohne BOM und Zeilenende. */
    public static List<String> zeilen(JsonNode abzug, Stand stand, Instant erzeugtAm, String erzeugtVon,
            List<String> teilansicht) {
        JsonNode kopf = abzug.path("kopf");
        JsonNode geltung = kopf.path("geltung");
        JsonNode zeitraum = kopf.path("zeitraum");
        ZoneId zone = ZoneId.of(kopf.path("darstellung").path("zeitzone").asText(zeitraum.path("zone").asText()));
        List<String> raus = new ArrayList<>(BerichtRegeln.csvKopf(new BerichtRegeln.CsvKopf(
                kopf.path("bericht").asText(), kopf.path("vorlage").asText(), kopf.path("vorlage_fassung").asInt(),
                geltung.path("art").asText(), geltung.path("kennzeichen").asText(),
                geltung.path("name_zum_datenstand").asText(), zeitraum.path("art").asText(),
                zeitraum.path("schluessel").asText(), zone, stand.nr(), zeit(kopf.path("datenstand")),
                stand.freigegebenAm(), stand.freigegebenVon(), stand.pruefsumme(), erzeugtAm, erzeugtVon, teilansicht)));
        if (stand.ersetztDurchNr() != null) {
            raus.add("# " + WASSERZEICHEN + "="
                    + BerichtRegeln.ersetztDurch(stand.ersetztDurchNr(), stand.ersetztAm(), zone));
        }
        raus.add(String.join(BerichtRegeln.CSV_TRENNER, BerichtRegeln.CSV_SPALTEN));
        String periode = zeitraum.path("schluessel").asText();
        List<String> abschnitte = BerichtRegeln.UNTERNEHMEN.equals(geltung.path("art").asText())
                ? ABSCHNITTE_UNTERNEHMEN : ABSCHNITTE_STANDORT;
        for (String abschnitt : abschnitte) {
            raus.add("# " + ABSCHNITT + "=" + abschnitt);
            if (KOSTENSTELLEN.equals(abschnitt)) {
                abzug.path(KOSTENSTELLEN).forEach(k -> raus.add(BerichtRegeln.csvZeile(kostenstelle(k), zone)));
            } else {
                abzug.path(KENNZAHLEN.equals(abschnitt) ? KENNZAHLEN : "werte")
                        .forEach(w -> raus.add(BerichtRegeln.csvZeile(wert(w, periode), zone)));
            }
        }
        return raus;
    }

    /**
     * Ein Wert oder eine Kennzahl des Abzugs als Zeile ({@code menge} bzw. {@code wert}). Was der Abzug nicht trägt, bleibt
     * leer — unbekannt ist keine Null; nur die Periode einer Kennzahl ist der Zeitraum des Berichts.
     */
    static BerichtRegeln.CsvZeile wert(JsonNode w, String periodeDesBerichts) {
        return new BerichtRegeln.CsvZeile(text(w.path("quelle")), text(w.path("name_zum_datenstand")),
                text(w.path("ort_zum_datenstand")), w.hasNonNull("periode") ? w.get("periode").asText() : periodeDesBerichts,
                zahl(w.has("menge") ? w.get("menge") : w.path("wert")), text(w.path("einheit")), text(w.path("zustand")),
                zahl(w.path("abdeckung_prozent")), kennzeichen(w.path("kennzeichen")), text(w.path("fassung")),
                zeit(w.path("endgueltig_ab")), w.path("version").isIntegralNumber() ? w.get("version").asInt() : null,
                zeit(w.path("berechnet_am")));
    }

    /** Eine Kostenstelle: ihr Block {@code summe} — eine Menge nur bei genau einer Größe, sonst ihr Grund als Kennzeichen. */
    static BerichtRegeln.CsvZeile kostenstelle(JsonNode k) {
        JsonNode summe = k.path("summe");
        return new BerichtRegeln.CsvZeile(text(k.path("quelle")), text(k.path("name_zum_datenstand")), null,
                text(k.path("periode")), zahl(summe.path("menge")), text(summe.path("einheit")),
                text(summe.path("zustand")), null, summe.hasNonNull("grund") ? List.of(summe.get("grund").asText()) : List.of(),
                null, null, null, zeit(k.path("berechnet_am")));
    }

    private static String text(JsonNode n) {
        return n.isMissingNode() || n.isNull() ? null : n.asText();
    }

    private static BigDecimal zahl(JsonNode n) {
        return n.isNumber() ? n.decimalValue() : null;
    }

    private static Instant zeit(JsonNode n) {
        return n.isTextual() ? OffsetDateTime.parse(n.asText()).toInstant() : null;
    }

    private static List<String> kennzeichen(JsonNode n) {
        List<String> raus = new ArrayList<>();
        n.forEach(k -> raus.add(k.asText()));
        return raus;
    }
}
