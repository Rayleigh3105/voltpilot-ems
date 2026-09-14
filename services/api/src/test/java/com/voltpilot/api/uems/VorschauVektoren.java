package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Macht aus einer Prüfung der Regel {@code vorschau} (Fälle B1, B2, B9–B13 der Vektor-Datei) eine
 * Vorschau: Bytes wie {@link CsvVektoren}, die Zuordnung, die Bezugsgrößen, der Bestand und die
 * Importe derselben Datei als Antworten — und vergleicht jedes Feld des Ergebnisses. Gemeinsam für
 * {@code BezugsdatenVectorsTest}, {@code ImportVorschauTest} und den API-Test, der dieselben Fälle
 * über die Route schickt — EINE Lesart der Vektoren, nicht drei.
 */
final class VorschauVektoren {

    private VorschauVektoren() {}

    static ImportVorschau.Ergebnis rechne(JsonNode wurzel, JsonNode ein) {
        Map<String, ImportVorschau.Ziel> ziele = ziele(ein.path("bezugsgroessen"));
        Map<String, BezugsdatenRegeln.Bestand> bestand = new LinkedHashMap<>();
        ein.path("bestand").forEach(b -> bestand.put(b.path("bezugsgroesse").asText() + "|" + b.path("schluessel").asText(),
                new BezugsdatenRegeln.Bestand(new BigDecimal(b.path("betrag").asText()), b.path("fassung").asInt(),
                        b.path("import_kennung").asText(null))));
        List<ImportVorschau.FruehererImport> importe = new ArrayList<>();
        ein.path("importe_dieser_datei").forEach(i -> importe.add(new ImportVorschau.FruehererImport(
                i.path("kennung").asText(), i.path("status").asText(), OffsetDateTime.parse(i.path("am").asText()).toInstant())));
        byte[] datei = CsvVektoren.datei(ein.path("datei"));
        String sha = ImportVorschau.sha256(datei);
        return ImportVorschau.vorschau(
                datei,
                zuordnung(ein.path("zuordnung")),
                ziele,
                (ziel, schluessel) -> bestand.get(ziel.kennzeichen() + "|" + schluessel),
                s -> s.equals(sha) ? importe : List.of(),
                grundlagen(wurzel),
                OffsetDateTime.parse(ein.path("jetzt").asText()).toInstant());
    }

    static void pruefe(String why, JsonNode wurzel, JsonNode ein, JsonNode soll) {
        vergleiche(why, rechne(wurzel, ein), soll);
    }

    static void vergleiche(String why, ImportVorschau.Ergebnis ist, JsonNode soll) {
        JsonNode d = soll.path("datei");
        assertThat(ist.datei().sha256()).as(why + " · datei.sha256").isEqualTo(d.path("sha256").asText());
        assertThat(ist.datei().bytes()).as(why + " · datei.bytes").isEqualTo(d.path("bytes").asInt());
        assertThat(ist.datei().befund()).as(why + " · datei.befund").isEqualTo(d.path("befund").asText(null));
        assertThat(ist.datei().zusatz()).as(why + " · datei.zusatz").isEqualTo(d.path("zusatz").asText(null));
        assertThat(ist.datei().kodierung()).as(why + " · datei.kodierung").isEqualTo(d.path("kodierung").asText(null));
        assertThat(ist.datei().trennzeichen()).as(why + " · datei.trennzeichen").isEqualTo(d.path("trennzeichen").asText(null));
        assertThat(ist.datei().kopfzeile()).as(why + " · datei.kopfzeile")
                .isEqualTo(d.path("kopfzeile").isNull() ? null : d.path("kopfzeile").asBoolean());
        assertThat(ist.datei().datenzeilen()).as(why + " · datei.datenzeilen")
                .isEqualTo(d.path("datenzeilen").isNull() ? null : d.path("datenzeilen").asInt());

        JsonNode f = soll.path("frueherer_import");
        assertThat(ist.fruehererImport() == null ? null : ist.fruehererImport().kennung() + " " + ist.fruehererImport().status())
                .as(why + " · frueherer_import")
                .isEqualTo(f.isNull() ? null : f.path("kennung").asText() + " " + f.path("status").asText());

        List<String> sollZeilen = new ArrayList<>();
        soll.path("zeilen").forEach(z -> sollZeilen.add(zeile(z.path("nr").asInt(), z.path("bezugsgroesse").asText(null),
                z.path("schluessel").asText(null), z.path("betrag").isNull() ? null : new BigDecimal(z.path("betrag").asText()),
                z.path("einheit").asText(null), z.path("urteil").asText(), CsvVektoren.texte(z.path("befunde")),
                z.path("fingerabdruck").asText(null))));
        assertThat(ist.zeilen().stream().map(z -> zeile(z.nr(), z.bezugsgroesse(), z.schluessel(), z.betrag(), z.einheit(),
                z.urteil(), z.befunde(), z.fingerabdruck())).toList())
                .as(why + " · zeilen")
                .isEqualTo(sollZeilen);

        JsonNode i = soll.path("import");
        BezugsdatenRegeln.Importergebnis e = ist.importergebnis();
        assertThat(e.status()).as(why + " · import.status").isEqualTo(i.path("status").asText(null));
        JsonNode z = i.path("zaehler");
        assertThat(e.zaehler()).as(why + " · import.zaehler").isEqualTo(new BezugsdatenRegeln.Zaehler(
                z.path("zeilen").asInt(), z.path("neu").asInt(), z.path("wiederholung").asInt(), z.path("konflikt").asInt(),
                z.path("berichtigung").asInt(), z.path("uebersprungen").asInt(), z.path("abgelehnt").asInt(),
                z.path("mit_hinweis").asInt()));
        assertThat(e.uebernahmeMoeglich()).as(why + " · import.uebernahme_moeglich").isEqualTo(i.path("uebernahme_moeglich").asBoolean());
        assertThat(e.importDatensatz()).as(why + " · import.import_datensatz").isEqualTo(i.path("import_datensatz").asBoolean());
        assertThat(e.bestaetigung()).as(why + " · import.bestaetigung").isEqualTo(i.path("bestaetigung").asText(null));
        assertThat(e.aenderungen()).as(why + " · import.aenderungen").isEqualTo(i.path("aenderungen").asInt());
        assertThat(e.befunde()).as(why + " · import.befunde").isEqualTo(CsvVektoren.texte(i.path("befunde")));
    }

    /** Beträge numerisch: „312400“ und „312400.0“ sind derselbe Betrag. */
    private static String zeile(int nr, String bz, String schluessel, BigDecimal betrag, String einheit, String urteil,
            List<String> befunde, String fingerabdruck) {
        String b = betrag == null ? null : betrag.signum() == 0 ? "0" : betrag.stripTrailingZeros().toPlainString();
        return nr + " | " + bz + " | " + schluessel + " | " + b + " " + einheit + " | " + urteil + " " + befunde + " | "
                + fingerabdruck;
    }

    static Map<String, ImportVorschau.Ziel> ziele(JsonNode liste) {
        Map<String, ImportVorschau.Ziel> aus = new LinkedHashMap<>();
        liste.forEach(b -> aus.put(b.path("kennzeichen").asText(), new ImportVorschau.Ziel(
                UUID.fromString(b.path("id").asText()), b.path("kennzeichen").asText(), b.path("wertart").asText(),
                b.path("einheit").asText(), b.path("periode_art").asText(null), ZoneId.of(b.path("zeitzone").asText()),
                b.path("einheiten_gebunden").asInt())));
        return aus;
    }

    static ImportVorschau.Zuordnung zuordnung(JsonNode z) {
        JsonNode s = z.path("spalten");
        return new ImportVorschau.Zuordnung(
                CsvVektoren.vorgabe(z.path("csv")),
                new ImportVorschau.Spalten(zahl(s.path("periode")), zahl(s.path("bis")), zahl(s.path("wert")),
                        zahl(s.path("einheit")), zahl(s.path("bezug")), zahl(s.path("bemerkung"))),
                z.path("deutung").asText(),
                z.path("zahlformat").asText(),
                z.path("einheit").asText(null),
                z.path("bezugsgroesse").asText(null),
                texte(z.path("bezug_tabelle")),
                texte(z.path("synonyme")));
    }

    static ImportVorschau.Grundlagen grundlagen(JsonNode wurzel) {
        Map<String, List<String>> einheiten = new LinkedHashMap<>();
        wurzel.path("einheiten").properties().forEach(e -> einheiten.put(e.getKey(), CsvVektoren.texte(e.getValue())));
        List<BezugsEinheit.Umrechnung> umrechnungen = new ArrayList<>();
        wurzel.path("umrechnung").forEach(u -> umrechnungen.add(new BezugsEinheit.Umrechnung(u.path("von").asText(),
                u.path("nach").asText(), zahl(u.path("zehnerpotenz")), zahl(u.path("teiler")), zahl(u.path("nachkommastellen")))));
        return new ImportVorschau.Grundlagen(einheiten, umrechnungen);
    }

    private static Map<String, String> texte(JsonNode objekt) {
        Map<String, String> aus = new LinkedHashMap<>();
        objekt.properties().forEach(e -> aus.put(e.getKey(), e.getValue().asText()));
        return aus;
    }

    private static Integer zahl(JsonNode n) {
        return n.isNull() || n.isMissingNode() ? null : n.asInt();
    }
}
