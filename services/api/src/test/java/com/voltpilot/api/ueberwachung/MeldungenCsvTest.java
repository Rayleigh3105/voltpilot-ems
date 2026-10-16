package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.ueberwachung.UeberwachungRepository.VerlaufZeile;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der Verlauf-CSV rein (Entscheid 14A, §6.4 Nr. 8) - keine Datenbank.
 */
class MeldungenCsvTest {

    private static final UUID STANDORT = UUID.randomUUID();

    @Test
    void dieKopfzeileNenntAlleSpalten() {
        List<String> zeilen = MeldungenCsv.zeilen(List.of());
        assertThat(zeilen).hasSize(1);
        assertThat(zeilen.get(0)).isEqualTo("kennzeichen;wertart;name;herkunft;bezug;standort_id;schwere;zustand;"
                + "ausgeloest_am;wieder_normal_am;gesehen_von;gesehen_am;erledigt_am");
    }

    @Test
    void eineEigeneUeberwachungTraegtDieMarke() {
        VerlaufZeile z = new VerlaufZeile("AL-2026-000001", "messstelle.menge", "Meine Menge", "eigen",
                "messstelle:" + UUID.randomUUID(), STANDORT, "warnung", "aktiv",
                Instant.parse("2026-10-16T08:00:00Z"), null, null, null, null);

        List<String> zeilen = MeldungenCsv.zeilen(List.of(z));

        assertThat(zeilen.get(1)).contains("eigene Überwachung");
        assertThat(zeilen.get(1)).doesNotContain("ab Werk");
    }

    @Test
    void abWerkTraegtDasAndereWort() {
        VerlaufZeile z = new VerlaufZeile("AL-2026-000002", "box.erreichbar", "Box", "ab_werk", "anlage:"
                + UUID.randomUUID(), STANDORT, "warnung", "erledigt", Instant.parse("2026-10-16T08:00:00Z"),
                Instant.parse("2026-10-16T09:00:00Z"), null, null, Instant.parse("2026-10-16T09:05:00Z"));

        List<String> zeilen = MeldungenCsv.zeilen(List.of(z));

        assertThat(zeilen.get(1)).contains("ab Werk");
    }

    @Test
    void zeitpunkteSindIsoUndUngerundet() {
        VerlaufZeile z = new VerlaufZeile("AL-2026-000003", "kennzahl.bezugsbasis", null, "eigen", "kennzahl:"
                + UUID.randomUUID(), null, "hinweis", "aktiv", Instant.parse("2026-10-16T08:00:00Z"), null, null,
                null, null);

        List<String> zeilen = MeldungenCsv.zeilen(List.of(z));

        assertThat(zeilen.get(1)).contains("2026-10-16T08:00:00Z");
    }

    @Test
    void dieDateiTraegtDieBomUndCrlf() {
        VerlaufZeile z = new VerlaufZeile("AL-2026-000004", "box.erreichbar", "Box", "ab_werk", "anlage:"
                + UUID.randomUUID(), STANDORT, "warnung", "aktiv", Instant.parse("2026-10-16T08:00:00Z"), null, null,
                null, null);

        byte[] datei = MeldungenCsv.datei(List.of(z));
        String text = new String(datei, StandardCharsets.UTF_8);

        assertThat(text).startsWith(MeldungenCsv.BOM);
        assertThat(text).contains("\r\n");
    }

    @Test
    void einSemikolonInEinemFreitextfeldWirdGeschuetzt() {
        VerlaufZeile z = new VerlaufZeile("AL-2026-000005", "box.erreichbar", "Name; mit Semikolon", "ab_werk",
                "anlage:" + UUID.randomUUID(), STANDORT, "warnung", "aktiv", Instant.parse("2026-10-16T08:00:00Z"),
                null, null, null, null);

        List<String> zeilen = MeldungenCsv.zeilen(List.of(z));

        assertThat(zeilen.get(1)).contains("\"Name; mit Semikolon\"");
    }
}
