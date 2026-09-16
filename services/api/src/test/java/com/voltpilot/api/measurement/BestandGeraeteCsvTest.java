package com.voltpilot.api.measurement;

import static com.voltpilot.api.measurement.BestandGeraeteCsvVergleich.erzeugung;
import static com.voltpilot.api.measurement.BestandGeraeteCsvVergleich.ohneNeueKopfzeilen;
import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.measurement.MeasurementHistoryService.Datum;
import com.voltpilot.api.measurement.MeasurementHistoryService.Erzeugung;
import com.voltpilot.api.measurement.MeasurementHistoryService.Herkunft;
import com.voltpilot.api.measurement.MeasurementHistoryService.History;
import com.voltpilot.api.measurement.MeasurementHistoryService.Marker;
import com.voltpilot.api.measurement.MeasurementHistoryService.Meta;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der Bestandsnachweis des Bestand-Geräte-CSV (UEMS AP-12 IP-10, E11 DA4) — rein, ohne Datenbank: wer den Export heute
 * nutzt und das Recht hat, bekommt dieselben Spalten und dieselben Zeilen wie vorher, nur neun Kopfzeilen mehr.
 *
 * <p>{@code bestand-geraete-csv-vorher.csv} hat der UNVERÄNDERTE Export (Stand {@code uems} 84f8307f) aus
 * {@link #beispiel()} geschrieben, bevor dieses Paket eine Zeile Produktivcode anfasste. Den Vergleich mit der Datenbank
 * führt die md5-Karte in {@code UemsLesepfadMengenTest} (aufgenommen mit AP-07 IP-14).
 */
class BestandGeraeteCsvTest {

    static final Path VORHER = Path.of("src", "test", "resources", "measurement", "bestand-geraete-csv-vorher.csv");

    private final MeasurementHistoryService dienst = new MeasurementHistoryService(null, null, null);

    /** Auf origin/uems 01c6d166 mit clean test aufgenommen, einschließlich aller AP-12-Kopfzeilen. */
    @Test
    void ip11VolleSichtIstZeichengleichZuOriginUems() throws Exception {
        assertThat(dienst.csv(beispiel(), erzeugung())).isEqualTo(Files.readAllBytes(
                Path.of("src/test/resources/measurement/geraete-csv-origin-uems-ip11.csv")));
    }

    @Test
    void ip11TeilansichtErgaenztNurIhreKopfzeile() {
        Erzeugung e = erzeugung();
        byte[] teil = dienst.csv(beispiel(), new Erzeugung(e.erzeugtAm(), e.erzeugtVon(), e.standort(), e.unternehmen(),
                "Teilansicht: Werk Lindach (1 von 3 Standorten)"));
        String csv = new String(teil, StandardCharsets.UTF_8);
        assertThat(csv).startsWith("# Teilansicht: Werk Lindach (1 von 3 Standorten)\n");
        assertThat(csv.substring(csv.indexOf('\n') + 1).getBytes(StandardCharsets.UTF_8))
                .isEqualTo(dienst.csv(beispiel(), e));
    }

    @Test
    void ohneDieNeunKopfzeilenIstDerExportByteGleichZuVorher() throws Exception {
        byte[] heute = dienst.csv(beispiel(), erzeugung());
        assertThat(heute.length).isGreaterThan(Files.readAllBytes(VORHER).length);
        assertThat(ohneNeueKopfzeilen(heute)).isEqualTo(Files.readAllBytes(VORHER));
    }

    @Test
    void dieNeunKopfzeilenStehenDirektHinterDenBisherigenUndSprechenMaschinenform() {
        List<String> zeilen = List.of(new String(dienst.csv(beispiel(), erzeugung()), StandardCharsets.UTF_8).split("\n"));
        assertThat(zeilen.get(14)).startsWith("# catalog_version_gespeichert=");
        assertThat(zeilen.subList(15, 24)).containsExactly(
                "# zeitraum_von=\"2026-10-19T22:00:00Z\"",
                "# zeitraum_bis=\"2026-10-20T22:00:00Z\"",
                "# erzeugt_am=\"2027-01-19T10:00:00Z\"",
                "# erzeugt_von=\"Jonas Wendlinger\"",
                "# zeitzone=\"UTC\"",
                "# dezimal=\".\"",
                "# trenner=\",\"",
                "# standort=\"ST-1 Werk Ahrenberg\"",
                "# unternehmen=\"Kunststoffwerk Ahrenberg GmbH\"");
        assertThat(zeilen.get(24)).as("die Spalten von vorher, unverändert")
                .startsWith("time,value,min,max,text,sample_count,gap,quelle,").endsWith(",stand_anfang,stand_ende");
        assertThat(zeilen.get(25)).as("UTC mit Z, Punkt, Komma").startsWith("2026-10-19T22:00:00Z,3.75,0.1,0.4,");
    }

    /** Ohne Standort-Objekt bleibt die Zeile leer — und ein Name aus dem Token wird wie jede Zelle entschärft. */
    @Test
    void ohneStandortUndUnternehmenBleibenDieZeilenLeer_einFormelPraefixImNamenWirdEntschaerft() {
        String csv = new String(dienst.csv(beispiel(), new Erzeugung(Instant.parse("2027-01-19T10:00:00Z"),
                "=HYPERLINK(\"x\")", null, null)), StandardCharsets.UTF_8);
        assertThat(csv).contains("\n# erzeugt_von=\"'=HYPERLINK(\"\"x\"\")\"\n")
                .contains("\n# standort=\n# unternehmen=\ntime,");
    }

    /** Ein Verlauf, der jede Stelle des Exports berührt: Kopf mit Formel-Präfix, Herkunft, Lücke, leere Zahl, Text. */
    static History beispiel() {
        UUID site = UUID.fromString("0a120000-0000-0000-0000-0000000000a2");
        UUID einbau = UUID.fromString("0a120000-0000-0000-0000-0000000000e1");
        UUID box = UUID.fromString("0a120000-0000-0000-0000-0000000000b0");
        Meta meta = new Meta("deye.hybrid_1p.meter.today-energy", "=Zähler \"Halle 2\"", "WAGO, Halle 2", "kWh",
                "counter", "known", "2026.08.26.3", "decoded", false, Instant.parse("2026-10-19T22:00:00Z"),
                Instant.parse("2026-10-20T22:00:00Z"), 900, "Differenz je Viertelstunde.", site, null, "viertelstunde",
                "Aus den gespeicherten Viertelstunden.", Instant.parse("2026-10-21T10:00:00Z"),
                List.of("2026.06.02.1", "2026.08.26.3"));
        Herkunft voll = new Herkunft("viertelstunde", "counter", 100, 15, 15, 15, 0, 0, 0, 0, "endgueltig",
                Instant.parse("2026-10-28T00:00:00Z"), 1, 0, "live", Instant.parse("2026-10-19T22:14:30Z"), einbau,
                null, box, null, 3L, "2026.06.02.1", "fuehrend", new BigDecimal("1200.5"), new BigDecimal("1204.25"));
        Herkunft luecke = new Herkunft("viertelstunde", "counter", 40, 6, 15, 6, 0, 0, 0, 0, "unvollstaendig", null,
                1, 2, "nachgeliefert", Instant.parse("2026-10-20T08:29:00Z"), einbau, einbau, box, box, 3L,
                "2026.06.02.1", "fuehrend", null, null);
        List<Datum> daten = List.of(
                new Datum(Instant.parse("2026-10-19T22:00:00Z"), new BigDecimal("3.75"), new BigDecimal("0.1"),
                        new BigDecimal("0.4"), null, 15, false, voll),
                new Datum(Instant.parse("2026-10-20T08:15:00Z"), null, null, null, "-Störung, \"kurz\"", 6, true, luecke),
                new Datum(Instant.parse("2026-10-20T08:30:00Z"), new BigDecimal("9007199254740993"), null, null, null, 1,
                        false));
        return new History(meta, daten, List.of(new Marker(Instant.parse("2026-10-20T08:15:00Z"), "gap", "Lücke")));
    }
}
