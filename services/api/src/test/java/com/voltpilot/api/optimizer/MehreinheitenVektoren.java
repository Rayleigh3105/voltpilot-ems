package com.voltpilot.api.optimizer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.optimizer.SlotEconomics.UnitPv;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * Liest die GETEILTEN S4-Vektoren {@code docs/contracts/
 * einspeiseverguetung-mehreinheiten-vectors.json} per Pfad - dieselbe Datei,
 * gegen die {@code services/optimization} {@code tests/test_pricing.py} den
 * Paragraph 24 Abs. 3 EEG-Anteil ueber mehrere Einheiten prueft. Die einzelne
 * Anlage bleibt in {@link EinspeiseverguetungVektoren} geprueft; diese Datei
 * pinnt nur die BLENDE.
 */
public final class MehreinheitenVektoren {

    public static final Path DATEI = Path.of(
            "..", "..", "docs", "contracts", "einspeiseverguetung-mehreinheiten-vectors.json");

    /** Ein Fall der Datei, Felder wie dort. */
    public record Fall(
            String fall,
            Double angegebenCtKwh,
            Boolean inbetriebnahmeAbSolarspitzengesetz,
            List<UnitPv> einheiten,
            Double spotEurMwh,
            double einspeisewertCtKwh) {
    }

    private static JsonNode wurzel;

    private MehreinheitenVektoren() {
    }

    public static Instant slot() {
        return Instant.parse(datei().path("slot").asText());
    }

    public static List<Fall> faelle() {
        List<Fall> aus = new ArrayList<>();
        for (JsonNode f : datei().path("faelle")) {
            List<UnitPv> einheiten = new ArrayList<>();
            for (JsonNode e : f.path("einheiten")) {
                JsonNode inbetriebnahme = e.path("inbetriebnahme");
                einheiten.add(new UnitPv(
                        e.path("leistungKwp").asDouble(),
                        inbetriebnahme.isNull() ? null : LocalDate.parse(inbetriebnahme.asText())));
            }
            JsonNode angegeben = f.path("angegebenCtKwh");
            JsonNode antwort = f.path("inbetriebnahmeAbSolarspitzengesetz");
            aus.add(new Fall(
                    f.path("fall").asText(),
                    angegeben.isNull() ? null : angegeben.asDouble(),
                    antwort.isNull() ? null : antwort.asBoolean(),
                    einheiten,
                    f.path("spotEurMwh").isNull() ? null : f.path("spotEurMwh").asDouble(),
                    f.path("einspeisewertCtKwh").asDouble()));
        }
        return aus;
    }

    private static synchronized JsonNode datei() {
        if (wurzel == null) {
            try {
                wurzel = new ObjectMapper().readTree(DATEI.toFile());
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
        return wurzel;
    }
}
