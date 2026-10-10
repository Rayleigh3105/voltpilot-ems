package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

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
 *
 * <p><b>Energetische Bewertung und Leistungsvergleich</b> (AP-16/AP-17 IP-22): statt des 13-Spalten-Trägers je Abschnitt eine
 * eigene Spaltenzeile ({@link #ABSCHNITTE_BEWERTUNG}, {@link #ABSCHNITTE_LEISTUNGSVERGLEICH}); beide tragen den Grenz-Satz
 * im Kopf, der Leistungsvergleich dazu Referenzperiode und Bezugsbasis mit Fassung (bericht.md §10 DA3).
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
    public static final String UMFANG = "umfang";
    public static final String RANGLISTE = "rangliste";
    public static final String EINSTUFUNGEN = "einstufungen";
    public static final String MESSABDECKUNG = "messabdeckung";
    public static final String MESSPLANUNG = "messplanung";
    public static final String MESSMITTEL = "messmittel";
    public static final String QUALITAET = "qualitaet";
    public static final String QUELLENVERZEICHNIS = "quellenverzeichnis";
    public static final String KENNZAHL = "kennzahl";
    public static final String BEZUGSBASIS = "bezugsbasis";
    public static final String VERGLEICH_JE_PERIODE = "vergleich_je_periode";
    public static final String URTEIL = "urteil";
    public static final String GRENZEN = "grenzen_und_vorbehalte";
    public static final String STATISCHE_FAKTOREN = "statische_faktoren";
    public static final String REFERENZPERIODE = "referenzperiode";
    /** Die Abschnitte mit Zeilen je Geltung, in der Folge der Vorlagen (Fassung 1). */
    public static final List<String> ABSCHNITTE_STANDORT = List.of(MESSSTELLEN, KENNZAHLEN);
    public static final List<String> ABSCHNITTE_UNTERNEHMEN = List.of(STANDORTE, KOSTENSTELLEN, KENNZAHLEN);
    /** Die acht Abschnitte der energetischen Bewertung, je mit eigener Kopfzeile. */
    public static final List<String> ABSCHNITTE_BEWERTUNG = List.of(UMFANG, RANGLISTE, EINSTUFUNGEN,
            MESSABDECKUNG, MESSPLANUNG, MESSMITTEL, QUALITAET, QUELLENVERZEICHNIS);
    /** AP-17 IP-22: die sieben Abschnitte des Leistungsvergleichs nach dem Kopf, je mit eigener Kopfzeile. */
    public static final List<String> ABSCHNITTE_LEISTUNGSVERGLEICH = List.of(KENNZAHL, BEZUGSBASIS, VERGLEICH_JE_PERIODE,
            URTEIL, GRENZEN, STATISCHE_FAKTOREN, QUELLENVERZEICHNIS);

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
        boolean bewertung = BerichtRegeln.ENERGETISCHE_BEWERTUNG.equals(kopf.path("vorlage").asText());
        boolean leistungsvergleich = BerichtRegeln.LEISTUNGSVERGLEICH.equals(kopf.path("vorlage").asText());
        if (bewertung || leistungsvergleich) {
            raus.add("# grenz_satz=" + BerichtRegeln.BEWERTUNG_GRENZ_SATZ);
        }
        if (leistungsvergleich) {
            raus.add("# " + REFERENZPERIODE + "=" + kopf.path(REFERENZPERIODE).path("schluessel").asText());
            raus.add("# " + BEZUGSBASIS + "=" + kopf.path(BEZUGSBASIS).path("kennzeichen").asText() + ", Fassung "
                    + kopf.path(BEZUGSBASIS).path("fassung").asText());
        }
        if (stand.ersetztDurchNr() != null) {
            raus.add("# " + WASSERZEICHEN + "="
                    + BerichtRegeln.ersetztDurch(stand.ersetztDurchNr(), stand.ersetztAm(), zone));
        }
        if (bewertung) {
            bewertung(raus, abzug);
            return raus;
        }
        if (leistungsvergleich) {
            leistungsvergleich(raus, abzug);
            return raus;
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

    /** AP-16 IP-22: Tabellen statt des Messwert-Trägers — jeder Abschnitt benennt seine eigenen Zellen. */
    private static void bewertung(List<String> raus, JsonNode abzug) {
        abschnitt(raus, UMFANG, List.of("id", "fassung", "von", "bis", "teilansicht"));
        JsonNode u = abzug.path(UMFANG);
        raus.add(csvZeile(text(u.path("id")), text(u.path("fassung")), text(u.path("von")), text(u.path("bis")),
                text(u.path("teilansicht"))));

        abschnitt(raus, RANGLISTE, List.of("energieeinsatz", "name", "traeger", "menge", "einheit", "zustand",
                "anteil_prozent", "rang", "vorschlag", "kriterien_fassung"));
        JsonNode rangliste = abzug.path(RANGLISTE);
        for (String gruppe : List.of("einsaetze", "weitere_traeger")) {
            rangliste.path(gruppe).forEach(e -> raus.add(csvZeile(text(e.path("kennzeichen")),
                    text(e.path("name")), text(e.path("traeger")), text(e.path("menge")), text(e.path("einheit")),
                    text(e.path("zustand")), text(e.path("anteil_prozent")), text(e.path("rang")),
                    text(e.path("vorschlag")), text(rangliste.path("kriterien").path("fassung")))));
        }

        abschnitt(raus, EINSTUFUNGEN, List.of("energieeinsatz", "name", "einstufung", "fassung", "gueltig_ab",
                "person", "begruendung"));
        abzug.path(EINSTUFUNGEN).forEach(e -> raus.add(csvZeile(text(e.path("einsatz")),
                text(e.path("name_zum_datenstand")), text(e.path("einstufung")), text(e.path("fassung")),
                text(e.path("gueltig_ab")), text(e.path("person")), text(e.path("begruendung")))));

        abschnitt(raus, MESSABDECKUNG, List.of("energieeinsatz", "name", "traeger", "menge", "einheit", "gemessen",
                "geplant", "ersatz", "ungemessen"));
        abzug.path(MESSABDECKUNG).path("je_einsatz").forEach(e -> raus.add(csvZeile(text(e.path("kennzeichen")),
                text(e.path("name")), text(e.path("traeger")), text(e.path("menge")), text(e.path("einheit")),
                liste(e.path("gemessen"), "kennzeichen"), liste(e.path("geplant"), "kennzeichen"),
                liste(e.path("ersatz"), "kennzeichen"), liste(e.path("ungemessen"), "anlage"))));

        Map<String, String> einsaetze = einsaetze(rangliste);
        abschnitt(raus, MESSPLANUNG, List.of("messbedarf", "energieeinsatz", "wortlaut", "ort", "groesse", "frist",
                "zustand", "messstelle", "begruendung", "datenstand"));
        abzug.path(MESSPLANUNG).forEach(m -> raus.add(csvZeile(text(m.path("kennzeichen")),
                einsaetze.get(text(m.path("einsatz_id"))), text(m.path("wortlaut")), text(m.path("ort")),
                text(m.path("groesse")), text(m.path("frist")), text(m.path("zustand")),
                text(m.path("messstelle")), text(m.path("begruendung")), text(m.path("datenstand")))));

        abschnitt(raus, MESSMITTEL, List.of("geraet", "einbau", "genauigkeitsklasse", "pruefungsart", "pruefung_am",
                "pruefung_gueltig_bis", "beleg", "ablage", "beleg_sha256"));
        abzug.path(MESSMITTEL).forEach(m -> raus.add(csvZeile(text(m.path("geraet")), text(m.path("einbau")),
                text(m.path("genauigkeitsklasse")), text(m.path("pruefungsart")), text(m.path("pruefung_am")),
                text(m.path("pruefung_gueltig_bis")), text(m.path("beleg").path("bezeichnung")),
                text(m.path("beleg").path("ablage")), text(m.path("beleg").path("sha256")))));

        abschnitt(raus, QUALITAET, List.of("merkmal", "wert"));
        abzug.path(QUALITAET).fields().forEachRemaining(e -> raus.add(csvZeile(e.getKey(), text(e.getValue()))));

        abschnitt(raus, QUELLENVERZEICHNIS, List.of("kennzeichen"));
        abzug.path("kopf").path(QUELLENVERZEICHNIS).forEach(q -> raus.add(csvZeile(text(q))));
    }

    /**
     * AP-17 IP-22: der Leistungsvergleich — eine Zeile je Periode mit Urteil, Band, Kennzeichen und Fassung als Zellen, die
     * rohe Veränderung daneben ohne Urteil (U1); dazu die Zeile des Zeitraums. Zahlen ungerundet mit Dezimalkomma.
     */
    private static void leistungsvergleich(List<String> raus, JsonNode abzug) {
        abschnitt(raus, KENNZAHL, List.of("kennzahl", "name", "rechenform", "einheit"));
        JsonNode k = abzug.path(KENNZAHL);
        raus.add(csvZeile(text(k.path("kennzeichen")), text(k.path("name_zum_datenstand")), text(k.path("rechenform")),
                text(k.path("einheit"))));

        abschnitt(raus, BEZUGSBASIS, List.of("bezugsbasis", "fassung", "methode", "referenzperiode", "datenlage",
                "gilt_ab", "gilt_bis", "basiswert", "koeffizienten", "r2", "streuung_prozent", "toleranz_prozent",
                "pruefsumme", "freigegeben_von", "freigegeben_am", "beendet_zum", "beendet_grund"));
        JsonNode b = abzug.path(BEZUGSBASIS);
        List<String> koeffizienten = new ArrayList<>();
        b.path("koeffizienten").fields().forEachRemaining(e -> koeffizienten.add(e.getKey() + "=" + dezimal(e.getValue())));
        raus.add(csvZeile(text(b.path("kennzeichen")), text(b.path("fassung")), text(b.path("methode")),
                text(b.path("referenzperiode")), text(b.path("datenlage")), text(b.path("gilt_ab")),
                text(b.path("gilt_bis")), dezimal(b.path("basiswert")), String.join(", ", koeffizienten),
                dezimal(b.path("r2")), dezimal(b.path("streuung_prozent")), dezimal(b.path("toleranz_prozent")),
                text(b.path("pruefsumme")), text(b.path("freigegeben_von")), text(b.path("freigegeben_am")),
                text(b.path("beendet_zum")), text(b.path("beendet_grund"))));

        abschnitt(raus, VERGLEICH_JE_PERIODE, List.of("periode", "gemessen", "einheit", "version", "zustand",
                "bedingung", "erwartet", "delta_prozent", "band_prozent", "urteil", "grund", "kennzeichen",
                "bezugsbasis", "fassung", "roh_gemessen", "roh_vormonat", "roh_delta_prozent",
                "roh_einflussgroesse_delta_prozent"));
        String basis = text(b.path("kennzeichen"));
        abzug.path(VERGLEICH_JE_PERIODE).forEach(m -> {
            JsonNode r = m.path("bereinigt");
            JsonNode g = r.path("gemessen");
            JsonNode roh = m.path("roh");
            List<String> bedingung = new ArrayList<>();
            r.path("bedingung").forEach(v -> bedingung.add(v.path("kennzeichen").asText(v.path("name").asText()) + "="
                    + Objects.requireNonNullElse(dezimal(v.path("wert")), "") + (v.hasNonNull("einheit")
                            ? " " + v.path("einheit").asText() : "")
                    + (v.path("fassung").isIntegralNumber() ? " (Fassung " + v.path("fassung").asInt() + ")"
                            : v.path("version").isIntegralNumber() ? " (Version " + v.path("version").asInt() + ")" : "")));
            raus.add(csvZeile(text(m.path("periode")),
                    dezimal(g.path("wert")), text(g.path("einheit")),
                    text(g.path("version")), text(g.path("zustand")), String.join(", ", bedingung),
                    dezimal(r.path("erwartet")), dezimal(r.path("delta_prozent")), dezimal(r.path("band_prozent")),
                    urteil(r.path("urteil")), text(r.path("grund")), String.join(" · ", texte(r.path("kennzeichen"))),
                    r.path("fassung").isObject() ? basis : null, text(r.path("fassung").path("fassung")),
                    dezimal(roh.path("gemessen")), dezimal(roh.path("vorher")), dezimal(roh.path("delta_prozent")),
                    dezimal(roh.path("variable_delta_prozent"))));
        });

        abschnitt(raus, URTEIL, List.of("zeitraum", "monate", "gemessen", "erwartet", "delta_prozent", "band_prozent",
                "urteil", "grund", "kennzeichen", "bezugsbasis", "fassung"));
        JsonNode u = abzug.path(URTEIL);
        raus.add(csvZeile(abzug.path("kopf").path("zeitraum").path("schluessel").asText(), text(u.path("monate")),
                dezimal(u.path("gemessen")), dezimal(u.path("erwartet")), dezimal(u.path("delta_prozent")),
                dezimal(u.path("band_prozent")), urteil(u.path("urteil")), text(u.path("grund")),
                String.join(" · ", texte(u.path("kennzeichen"))), basis, text(u.path("fassung"))));

        abschnitt(raus, GRENZEN, List.of("merkmal", "periode", "wert"));
        JsonNode gr = abzug.path(GRENZEN);
        raus.add(csvZeile("datenlage", null, text(gr.path("datenlage"))));
        raus.add(csvZeile("toleranz_prozent", null, dezimal(gr.path("toleranz_prozent"))));
        raus.add(csvZeile("streuung_prozent", null, dezimal(gr.path("streuung_prozent"))));
        gr.path("kennzeichen").forEach(z -> raus.add(csvZeile("kennzeichen", null, z.asText())));
        gr.path("nicht_anwendbar").forEach(n -> raus.add(csvZeile("nicht_anwendbar", text(n.path("periode")),
                text(n.path("grund")))));

        abschnitt(raus, STATISCHE_FAKTOREN, List.of("position", "art", "kennzeichen", "wortlaut", "wert", "einheit",
                "wert_gueltig_ab", "kopie_am"));
        abzug.path(STATISCHE_FAKTOREN).forEach(f -> raus.add(csvZeile(text(f.path("position")), text(f.path("art")),
                text(f.path("kennzeichen")), text(f.path("wortlaut")), dezimal(f.path("wert")), text(f.path("einheit")),
                text(f.path("wert_gueltig_ab")), text(f.path("kopie_am")))));

        abschnitt(raus, QUELLENVERZEICHNIS, List.of("kennzeichen", "name", "art", "bezug", "version", "fassung",
                "erster_tag", "letzter_tag"));
        abzug.path(QUELLENVERZEICHNIS).forEach(q -> raus.add(csvZeile(text(q.path("kennzeichen")),
                text(q.path("name_zum_datenstand")), text(q.path("art")), text(q.path("bezug")), text(q.path("version")),
                text(q.path("fassung")), text(q.path("erster_tag")), text(q.path("letzter_tag")))));
    }

    /** Das Urteil als Kundenwort (SP1): besser · schlechter · im Rahmen · nicht bewertbar; leer ohne Urteil. */
    private static String urteil(JsonNode n) {
        String u = text(n);
        return u == null ? null : BezugsbasisVergleichSatz.URTEIL_WORT.getOrDefault(u, u);
    }

    /** Eine Zahl des Abzugs (Text oder Zahl) ungerundet mit Dezimalkomma (DA3); leer, wenn keine. */
    private static String dezimal(JsonNode n) {
        String t = text(n);
        if (t == null || t.isBlank()) {
            return null;
        }
        try {
            return new BigDecimal(t).toPlainString().replace(".", BerichtRegeln.CSV_DEZIMAL);
        } catch (NumberFormatException e) {
            return t;
        }
    }

    private static List<String> texte(JsonNode n) {
        List<String> raus = new ArrayList<>();
        n.forEach(t -> raus.add(t.asText()));
        return raus;
    }

    private static void abschnitt(List<String> raus, String schluessel, List<String> spalten) {
        raus.add("# " + ABSCHNITT + "=" + schluessel);
        raus.add(String.join(BerichtRegeln.CSV_TRENNER, spalten));
    }

    private static Map<String, String> einsaetze(JsonNode rangliste) {
        Map<String, String> raus = new LinkedHashMap<>();
        for (String gruppe : List.of("einsaetze", "weitere_traeger")) {
            rangliste.path(gruppe).forEach(e -> raus.put(text(e.path("id")), text(e.path("kennzeichen"))));
        }
        return raus;
    }

    private static String liste(JsonNode liste, String feld) {
        List<String> raus = new ArrayList<>();
        liste.forEach(e -> raus.add(Objects.requireNonNullElse(text(e.path(feld)), "")));
        return String.join(", ", raus);
    }

    private static String csvZeile(String... zellen) {
        return Arrays.stream(zellen).map(BerichtCsv::csvZelle)
                .collect(java.util.stream.Collectors.joining(BerichtRegeln.CSV_TRENNER));
    }

    private static String csvZelle(String s) {
        if (s == null) return "";
        if (s.contains(";") || s.contains("\"") || s.contains("\n") || s.contains("\r")) {
            return "\"" + s.replace("\"", "\"\"") + "\"";
        }
        return s;
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
