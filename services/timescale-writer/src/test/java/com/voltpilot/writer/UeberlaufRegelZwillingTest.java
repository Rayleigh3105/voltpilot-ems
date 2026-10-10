package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Der Writer-Zwilling der Überlauf-Entscheidung (UEMS AP-08 IP-4, Z6/E4) gegen DIESELBE Datei wie
 * {@code VerbrauchRegeln.ueberlauf} (api) und {@code verbrauch.ueberlauf} (Python): an jedem
 * fallenden Nachbarn guter Werte jeder Zählerstand-Reihe steht genau dort ein Überlauf, wo eine
 * Erwartung des Falls „Überlauf HH:MM" nennt — F7 10:03 ja (767 ≤ 1 667), F7 10:20 nein
 * (53 179 &gt; 1 667), F6/F12 nie (keine Deklaration). Eine Gerätegrenze dazwischen ist Z4, nie Z6.
 *
 * <p>Rein; die Datei wird PER PFAD gelesen (Arbeitsverzeichnis services/timescale-writer).
 */
class UeberlaufRegelZwillingTest {

    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2", "verbrauch-vectors.json");
    private static final ZoneId ANZEIGE = ZoneId.of("Europe/Berlin");

    private record Wert(Instant zeit, BigDecimal stand) {}

    @Test
    void dieUeberlaufEntscheidungStehtGenauDortWoDieErwartungEinenUeberlaufNennt() throws Exception {
        JsonNode datei = new ObjectMapper().readTree(Files.readString(VECTORS));
        int ueberlaeufe = 0;
        int ruecksetzungen = 0;
        for (JsonNode fall : datei.path("cases")) {
            JsonNode reihe = fall.path("input").path("reihe");
            if (!"zaehlerstand".equals(fall.path("familie").asText()) || reihe.isMissingNode()) {
                continue;
            }
            List<Wert> gute = gute(reihe);
            List<Instant> grenzen = new ArrayList<>();
            reihe.path("ereignisse").forEach(e -> {
                if ("device_boundary".equals(e.path("art").asText())) {
                    grenzen.add(OffsetDateTime.parse(e.path("t").asText()).toInstant());
                }
            });
            List<String> genannt = new ArrayList<>();
            fall.path("expected").forEach(e -> e.path("kennzeichen").forEach(k -> {
                if (k.asText().startsWith("Überlauf ")) {
                    genannt.add(k.asText().split(" ")[1]);
                }
            }));
            Duration kadenz = Duration.ofSeconds(reihe.path("kadenz_s").asLong());
            BigDecimal modul = zahl(reihe.path("wertebereich_modul"));
            BigDecimal hoechst = zahl(reihe.path("hoechstzuwachs_je_kadenz"));
            for (int i = 0; i + 1 < gute.size(); i++) {
                Wert vorher = gute.get(i);
                Wert nachher = gute.get(i + 1);
                if (nachher.stand().compareTo(vorher.stand()) >= 0 || grenzen.stream()
                        .anyMatch(g -> g.isAfter(vorher.zeit()) && !g.isAfter(nachher.zeit()))) {
                    continue;
                }
                String uhr = DateTimeFormatter.ofPattern("HH:mm").format(nachher.zeit().atZone(ANZEIGE));
                BigDecimal ueber = UeberlaufRegel.ueberlauf(vorher.stand(), vorher.zeit(), nachher.stand(),
                        nachher.zeit(), kadenz, modul, hoechst);
                assertThat(ueber != null).as(fall.path("name").asText() + " " + uhr)
                        .isEqualTo(genannt.contains(uhr));
                if (ueber != null) {
                    assertThat(ueber).isEqualByComparingTo(modul.subtract(vorher.stand()).add(nachher.stand()));
                    ueberlaeufe++;
                } else {
                    ruecksetzungen++;
                }
                // Ohne Wertebereich oder ohne Höchstzuwachs wird nie ein Überlauf geraten (E4).
                assertThat(UeberlaufRegel.ueberlauf(vorher.stand(), vorher.zeit(), nachher.stand(),
                        nachher.zeit(), kadenz, null, hoechst)).isNull();
                assertThat(UeberlaufRegel.ueberlauf(vorher.stand(), vorher.zeit(), nachher.stand(),
                        nachher.zeit(), kadenz, modul, null)).isNull();
            }
        }
        assertThat(ueberlaeufe).as("F7 10:03").isPositive();
        assertThat(ruecksetzungen).as("F6, F7 10:20, F12").isPositive();
    }

    @Test
    void einSteigenderStandIstNieEinUeberlauf() {
        Instant t = Instant.parse("2026-10-20T08:00:00Z");
        assertThat(UeberlaufRegel.ueberlauf(new BigDecimal("100"), t, new BigDecimal("101"), t.plusSeconds(60),
                Duration.ofSeconds(60), new BigDecimal("65536"), new BigDecimal("1667"))).isNull();
    }

    /** Die guten Werte einer Reihe — Abschnitte wie in {@code docs/contracts/v2/verbrauch.md} §1. */
    private static List<Wert> gute(JsonNode reihe) {
        List<Wert> out = new ArrayList<>();
        for (JsonNode a : reihe.path("rohwerte")) {
            if ("bad".equals(a.path("q").asText("good"))) {
                continue;
            }
            if (a.has("t")) {
                out.add(new Wert(OffsetDateTime.parse(a.path("t").asText()).toInstant(), a.path("v").decimalValue()));
                continue;
            }
            Instant von = OffsetDateTime.parse(a.path("von").asText()).toInstant();
            Instant bis = OffsetDateTime.parse(a.path("bis").asText()).toInstant();
            Duration schritt = Duration.ofSeconds(a.path("kadenz_s").asLong());
            BigDecimal stand = a.path("stand_von").decimalValue();
            BigDecimal zuwachs = a.path("zuwachs_je_kadenz").decimalValue();
            long i = 0;
            for (Instant t = von; !t.isAfter(bis); t = t.plus(schritt), i++) {
                out.add(new Wert(t, stand.add(zuwachs.multiply(BigDecimal.valueOf(i)))));
            }
        }
        for (JsonNode l : reihe.path("luecken")) {
            Instant von = OffsetDateTime.parse(l.path("von").asText()).toInstant();
            Instant bis = OffsetDateTime.parse(l.path("bis").asText()).toInstant();
            out.removeIf(w -> !w.zeit().isBefore(von) && w.zeit().isBefore(bis));
        }
        out.sort(Comparator.comparing(Wert::zeit));
        return out;
    }

    private static BigDecimal zahl(JsonNode n) {
        return n.isMissingNode() || n.isNull() ? null : n.decimalValue();
    }
}
