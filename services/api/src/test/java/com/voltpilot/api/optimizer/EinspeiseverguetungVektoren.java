package com.voltpilot.api.optimizer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * Liest die GETEILTEN Vektoren {@code docs/contracts/einspeiseverguetung-vectors.json}
 * per Pfad - dieselbe Datei, gegen die {@code services/optimization}
 * {@code tests/test_pricing.py} den Optimierer prüft. Ein Fall je Viertelstunde
 * {@link #slot()}; {@code null} heißt in jedem Feld: unbekannt bzw. nicht gepflegt.
 */
public final class EinspeiseverguetungVektoren {

    public static final Path DATEI =
            Path.of("..", "..", "docs", "contracts", "einspeiseverguetung-vectors.json");

    /** Ein Fall der Datei, Felder wie dort. */
    public record Fall(
            String fall,
            String veraeusserungsform,
            boolean netzladen,
            Double angegebenCtKwh,
            Boolean inbetriebnahmeAbSolarspitzengesetz,
            LocalDate inbetriebnahme,
            Double leistungKwp,
            Double anzulegenderWertCtKwh,
            Double monatsmarktwertCtKwh,
            Double spotEurMwh,
            Double einspeisewertCtKwh,
            String quelle,
            String zustand) {
    }

    private static JsonNode wurzel;

    private EinspeiseverguetungVektoren() {
    }

    /** Die Viertelstunde aller Fälle. */
    public static Instant slot() {
        return Instant.parse(datei().path("slot").asText());
    }

    /** Das geschlossene Vokabular der Karte ({@code zustaende}). */
    public static List<String> zustaende() {
        List<String> aus = new ArrayList<>();
        datei().path("zustaende").forEach(z -> aus.add(z.asText()));
        return aus;
    }

    public static List<Fall> faelle() {
        List<Fall> aus = new ArrayList<>();
        for (JsonNode f : datei().path("faelle")) {
            aus.add(new Fall(
                    f.path("fall").asText(),
                    f.path("veraeusserungsform").asText(),
                    f.path("netzladen").asBoolean(),
                    zahl(f, "angegebenCtKwh"),
                    antwort(f),
                    f.path("inbetriebnahme").isNull() ? null
                            : LocalDate.parse(f.path("inbetriebnahme").asText()),
                    zahl(f, "leistungKwp"),
                    zahl(f, "anzulegenderWertCtKwh"),
                    zahl(f, "monatsmarktwertCtKwh"),
                    zahl(f, "spotEurMwh"),
                    zahl(f, "einspeisewertCtKwh"),
                    f.path("quelle").isNull() ? null : f.path("quelle").asText(),
                    f.path("zustand").asText()));
        }
        return aus;
    }

    private static Boolean antwort(JsonNode f) {
        JsonNode v = f.get("inbetriebnahmeAbSolarspitzengesetz");
        if (v == null) {
            throw new IllegalStateException("Fall '" + f.path("fall").asText()
                    + "' ohne Feld inbetriebnahmeAbSolarspitzengesetz");
        }
        return v.isNull() ? null : v.asBoolean();
    }

    private static Double zahl(JsonNode f, String feld) {
        JsonNode v = f.get(feld);
        if (v == null) {
            throw new IllegalStateException("Fall '" + f.path("fall").asText() + "' ohne Feld " + feld);
        }
        return v.isNull() ? null : v.asDouble();
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
