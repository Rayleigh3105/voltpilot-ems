package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BezugsPeriode.Periodendeutung;
import com.voltpilot.api.uems.BezugsPeriode.Zeitdeutung;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Das PERIODEN-Modul (UEMS AP-09 IP-3) gegen die geteilte Vektor-Datei
 * {@code docs/contracts/v2/bezugsdaten-vectors.json} — Familien {@code periode}, {@code zeit},
 * {@code stunden} — und gegen die drei Fallen, an denen es richtig oder falsch wird: der Tag mit
 * 23 oder 25 Stunden, der mehrdeutige bzw. nicht existierende Zeitpunkt und der Unterschied
 * zwischen „passt nicht“ und „noch nicht zu Ende“.
 *
 * <p>Der Aufruf geht hier DIREKT an {@link BezugsPeriode}; {@code BezugsdatenVectorsTest} fährt
 * dieselben Fälle über den Anruf in {@link BezugsdatenRegeln}.
 */
class BezugsPeriodeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "bezugsdaten-vectors.json");

    private static final Path REGELN =
            Path.of("src", "main", "java", "com", "voltpilot", "api", "uems", "BezugsdatenRegeln.java");

    /** Die Zeitzone des Standorts der Referenzfälle (Ahrenberg). */
    private static final ZoneId AHRENBERG = ZoneId.of("Europe/Berlin");

    private static JsonNode vektoren() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    private static String text(JsonNode n) {
        return n.isMissingNode() || n.isNull() ? null : n.asText();
    }

    /** Jede Prüfung der Familien {@code periode}, {@code zeit} und {@code stunden} — am Modul. */
    @TestFactory
    List<DynamicTest> dieFamilienPeriodeZeitUndStunden() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : vektoren().path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                String regel = p.path("regel").asText();
                if (!List.of("periode", "zeit", "stunden").contains(regel)) {
                    continue;
                }
                String name = fall.path("id").asText() + " · " + regel + " :: " + p.path("name").asText();
                tests.add(DynamicTest.dynamicTest(name, () -> pruefe(regel, name, p)));
            }
        }
        assertThat(tests).as("Prüfungen der drei Familien").hasSizeGreaterThanOrEqualTo(15);
        return tests;
    }

    private void pruefe(String regel, String name, JsonNode p) {
        JsonNode ein = p.path("eingang");
        JsonNode soll = p.path("ergebnis");
        switch (regel) {
            case "periode" -> {
                Periodendeutung ist = BezugsPeriode.periode(
                        text(ein.path("text")),
                        text(ein.path("von_text")),
                        text(ein.path("bis_text")),
                        ein.path("deutung").asText(),
                        ein.path("periode_art").asText(),
                        AHRENBERG,
                        ein.has("jetzt") ? BezugsPeriode.zeit(ein.path("jetzt").asText()) : null);
                assertThat(ist.schluessel()).as(name + " · schluessel").isEqualTo(text(soll.path("schluessel")));
                assertThat(ist.von() == null ? null : BezugsPeriode.iso(ist.von(), AHRENBERG))
                        .as(name + " · von")
                        .isEqualTo(text(soll.path("von")));
                assertThat(ist.bis() == null ? null : BezugsPeriode.iso(ist.bis(), AHRENBERG))
                        .as(name + " · bis")
                        .isEqualTo(text(soll.path("bis")));
                assertThat(ist.stunden())
                        .as(name + " · stunden")
                        .isEqualTo(soll.path("stunden").isNull() ? null : soll.path("stunden").asLong());
                assertThat(ist.befund()).as(name + " · befund").isEqualTo(text(soll.path("befund")));
            }
            case "zeit" -> {
                Zeitdeutung ist = BezugsPeriode.zeitpunkt(
                        ein.path("text").asText(),
                        ZoneId.of(ein.path("zeitzone").asText()),
                        text(ein.path("offset_in_datei")));
                assertThat(ist.zeitpunkt() == null ? null : BezugsPeriode.iso(ist.zeitpunkt(), AHRENBERG))
                        .as(name + " · zeitpunkt")
                        .isEqualTo(text(soll.path("zeitpunkt")));
                assertThat(ist.befund()).as(name + " · befund").isEqualTo(text(soll.path("befund")));
                List<String> varianten = new ArrayList<>();
                soll.path("varianten").forEach(x -> varianten.add(x.asText()));
                assertThat(ist.varianten()).as(name + " · varianten").isEqualTo(varianten);
            }
            default -> assertThat(BezugsPeriode.stundenDesTages(
                            LocalDate.parse(ein.path("tag").asText()), AHRENBERG))
                    .as(name)
                    .isEqualTo(soll.path("stunden").asLong());
        }
    }

    /** Die Kundensätze wohnen im Modul — und sind Wort für Wort die des Vertrags. */
    @Test
    void dieKundensaetzeSindDieDesVertrags() throws Exception {
        JsonNode saetze = vektoren().path("befund_saetze");
        BezugsPeriode.SAETZE.forEach((befund, satz) -> assertThat(satz)
                .as("Kundensatz " + befund)
                .isEqualTo(saetze.path(befund).asText()));
        assertThat(BezugsPeriode.SAETZE.keySet())
                .containsExactlyInAnyOrder(
                        BezugsPeriode.PERIODE_PASST_NICHT,
                        BezugsPeriode.PERIODE_NICHT_ZU_ENDE,
                        BezugsPeriode.ZEIT_MEHRDEUTIG,
                        BezugsPeriode.ZEIT_NICHT_VORHANDEN,
                        BezugsPeriode.DATUM_UNLESBAR);
    }

    /**
     * FALLE 1 — ein Tag hat nicht 24 Stunden, und die Stundenzahl wird bei der Verbrauchsregel
     * AP-08 BESTELLT statt hier ein zweites Mal gezählt.
     */
    @Test
    void derUmstellungstagHat25BeziehungsweiseTagHat23Stunden() {
        assertThat(BezugsPeriode.stundenDesTages(LocalDate.parse("2026-10-25"), AHRENBERG))
                .as("Rückstellung: der Tag ist eine Stunde LÄNGER")
                .isEqualTo(25);
        assertThat(BezugsPeriode.stundenDesTages(LocalDate.parse("2027-03-28"), AHRENBERG))
                .as("Vorstellung: der Tag ist eine Stunde KÜRZER")
                .isEqualTo(23);
        assertThat(BezugsPeriode.stundenDesTages(LocalDate.parse("2026-12-02"), AHRENBERG))
                .isEqualTo(24);

        // Nachgerechnet, nicht geglaubt: es ist dieselbe Zahl, die AP-08 nennt.
        for (String tag : List.of("2026-10-25", "2027-03-28", "2026-12-02")) {
            LocalDate d = LocalDate.parse(tag);
            assertThat(BezugsPeriode.stundenDesTages(d, AHRENBERG))
                    .as("dieselbe Zählung wie VerbrauchRegeln.stunden am " + tag)
                    .isEqualTo(VerbrauchRegeln.stunden(
                            d.atStartOfDay(AHRENBERG).toInstant(),
                            d.plusDays(1).atStartOfDay(AHRENBERG).toInstant()));
        }

        // Und die Periode erbt das: der Oktober 2026 hat 745 Stunden, nicht 744.
        Periodendeutung oktober = BezugsPeriode.periode(
                "2026-10", null, null, "periode", "monat", AHRENBERG, BezugsPeriode.zeit("2026-11-03T09:12:00+01:00"));
        assertThat(oktober.stunden()).isEqualTo(745);
        Periodendeutung maerz = BezugsPeriode.periode(
                "2027-03", null, null, "periode", "monat", AHRENBERG, BezugsPeriode.zeit("2027-04-02T09:00:00+02:00"));
        assertThat(maerz.stunden()).as("der März 2027 hat 743 Stunden").isEqualTo(743);
    }

    /**
     * FALLE 2 — der mehrdeutige und der nicht existierende Zeitpunkt sind BEFUNDE mit Kundensatz,
     * nie eine stille Wahl.
     */
    @Test
    void mehrdeutigUndNichtVorhandenSindBefundeMitKundensatz() {
        Zeitdeutung doppelt = BezugsPeriode.zeitpunkt("25.10.2026 02:30", AHRENBERG, null);
        assertThat(doppelt.zeitpunkt()).as("keine der beiden Möglichkeiten wird gewählt").isNull();
        assertThat(doppelt.befund()).isEqualTo(BezugsPeriode.ZEIT_MEHRDEUTIG);
        assertThat(doppelt.varianten())
                .as("BEIDE Möglichkeiten reisen mit, damit der Kunde wählen kann")
                .containsExactly("2026-10-25T02:30:00+02:00", "2026-10-25T02:30:00+01:00");
        assertThat(BezugsPeriode.satz(doppelt.befund()))
                .isEqualTo("Diesen Zeitpunkt gibt es an diesem Tag zweimal (Zeitumstellung). Geben Sie die Zone an.");

        Zeitdeutung fehlt = BezugsPeriode.zeitpunkt("28.03.2027 02:30", AHRENBERG, null);
        assertThat(fehlt.zeitpunkt()).as("nie auf 03:30 verschoben").isNull();
        assertThat(fehlt.befund()).isEqualTo(BezugsPeriode.ZEIT_NICHT_VORHANDEN);
        assertThat(fehlt.varianten()).isEmpty();
        assertThat(BezugsPeriode.satz(fehlt.befund()))
                .isEqualTo("Diesen Zeitpunkt gibt es an diesem Tag nicht (Zeitumstellung).");

        // Ein Offset in der Datei gewinnt immer und macht dieselbe Zeile eindeutig (Z5).
        Zeitdeutung mitOffset = BezugsPeriode.zeitpunkt("25.10.2026 02:30", AHRENBERG, "+02:00");
        assertThat(mitOffset.befund()).isNull();
        assertThat(BezugsPeriode.iso(mitOffset.zeitpunkt(), AHRENBERG)).isEqualTo("2026-10-25T02:30:00+02:00");
    }

    /**
     * FALLE 3 — „passt nicht“ (wird NIE geteilt) und „noch nicht zu Ende“ (kommt später wieder)
     * sind zwei Befunde mit zwei Sätzen, nicht einer.
     */
    @Test
    void passtNichtIstNichtDasselbeWieNochNichtZuEnde() {
        Instant jetzt = BezugsPeriode.zeit("2026-11-03T09:12:00+01:00");

        Periodendeutung woche =
                BezugsPeriode.periode(null, "28.09.2026", "04.10.2026", "von_bis", "monat", AHRENBERG, jetzt);
        assertThat(woche.befund()).isEqualTo(BezugsPeriode.PERIODE_PASST_NICHT);
        assertThat(woche.schluessel()).as("nichts wird geteilt, nichts nach Mehrheit zugeordnet").isNull();
        assertThat(woche.von()).isNull();
        assertThat(woche.bis()).isNull();
        assertThat(BezugsPeriode.satz(woche.befund()))
                .isEqualTo("Der gelieferte Zeitraum ist keine Periode dieser Bezugsgröße.");

        // Dieselbe Woche in einer WOCHEN-Bezugsgröße passt — die Reihe entscheidet, nicht der Text.
        Periodendeutung inWochenreihe =
                BezugsPeriode.periode(null, "28.09.2026", "04.10.2026", "von_bis", "woche", AHRENBERG, jetzt);
        assertThat(inWochenreihe.schluessel()).isEqualTo("2026-W40");
        assertThat(inWochenreihe.befund()).isNull();

        Periodendeutung laufend =
                BezugsPeriode.periode("2026-11", null, null, "periode", "monat", AHRENBERG, jetzt);
        assertThat(laufend.befund()).isEqualTo(BezugsPeriode.PERIODE_NICHT_ZU_ENDE);
        assertThat(BezugsPeriode.satz(laufend.befund())).isEqualTo("Diese Periode ist noch nicht zu Ende.");

        assertThat(BezugsPeriode.satz(BezugsPeriode.PERIODE_PASST_NICHT))
                .as("zwei Befunde, zwei Sätze — der Kunde tut zwei verschiedene Dinge")
                .isNotEqualTo(BezugsPeriode.satz(BezugsPeriode.PERIODE_NICHT_ZU_ENDE));

        // Und der laufende Monat wird nicht abgelehnt, weil er falsch wäre: einen Tag nach seinem
        // Ende nimmt dieselbe Reihe denselben Text an.
        Periodendeutung spaeter = BezugsPeriode.periode(
                "2026-11", null, null, "periode", "monat", AHRENBERG, BezugsPeriode.zeit("2026-12-01T00:00:00+01:00"));
        assertThat(spaeter.befund()).isNull();
        assertThat(spaeter.schluessel()).isEqualTo("2026-11");
    }

    /** E7/Z5 — die Zone kommt vom STANDORT; eine Vorlage darf davon abweichen. */
    @Test
    void dieZonenloseOrtszeitLiestDieZonedesStandorts() {
        Zeitdeutung amStandort = BezugsPeriode.zeitpunkt("02.11.2026 07:40", AHRENBERG, null);
        Zeitdeutung nachVorlage = BezugsPeriode.zeitpunkt("02.11.2026 07:40", ZoneId.of("UTC"), null);
        assertThat(amStandort.befund()).isNull();
        assertThat(nachVorlage.befund()).isNull();
        assertThat(BezugsPeriode.iso(amStandort.zeitpunkt(), AHRENBERG)).isEqualTo("2026-11-02T07:40:00+01:00");
        assertThat(amStandort.zeitpunkt())
                .as("dieselbe Wanduhrzeit, eine andere Zone: ein anderer Zeitpunkt")
                .isNotEqualTo(nachVorlage.zeitpunkt());

        // Auch die Periodengrenzen sind Ortszeit: der Oktober beginnt am Standort um 00:00.
        Periodendeutung oktober = BezugsPeriode.periode(
                "31.10.2026",
                null,
                null,
                "periodenende",
                "monat",
                AHRENBERG,
                BezugsPeriode.zeit("2026-11-03T09:12:00+01:00"));
        assertThat(BezugsPeriode.iso(oktober.von(), AHRENBERG)).isEqualTo("2026-10-01T00:00:00+02:00");
        assertThat(BezugsPeriode.iso(oktober.bis(), AHRENBERG)).isEqualTo("2026-11-01T00:00:00+01:00");
    }

    /**
     * IP-3 — es bleibt KEINE zweite Fassung: die Periodendeutung wohnt nur noch hier, und
     * {@link BezugsdatenRegeln} ruft sie an (auch der Stichtag eines Stammdatums).
     */
    @Test
    void diePeriodenlogikStehtNurNochInDiesemModul() throws Exception {
        String regeln = Files.readString(REGELN);
        assertThat(regeln)
                .as("keine zweite Zonen-/Kalenderrechnung in BezugsdatenRegeln")
                .doesNotContain("getValidOffsets")
                .doesNotContain("IsoFields")
                .doesNotContain("MONATSNAMEN");
        assertThat(regeln)
                .as("BezugsdatenRegeln ruft das Modul an")
                .contains("BezugsPeriode.periode(")
                .contains("BezugsPeriode.zeitpunkt(")
                .contains("BezugsPeriode.stundenDesTages(")
                .contains("BezugsPeriode.spanneVon(");

        Instant jetzt = BezugsPeriode.zeit("2026-11-03T09:12:00+01:00");
        assertThat(BezugsdatenRegeln.periode("2026-10", null, null, "periode", "monat", AHRENBERG, jetzt))
                .isEqualTo(BezugsPeriode.periode("2026-10", null, null, "periode", "monat", AHRENBERG, jetzt));
    }
}
