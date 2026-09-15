package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Component;

/**
 * Der Vorlagen-Katalog der Kennzahlen (UEMS AP-11 IP-10, §4.12, E9 = A): {@code kennzahlen/kennzahl-vorlagen.json},
 * einmal beim Start gelesen. Eine Vorlage ist eine VoltPilot-Vorgabe, nie eine Kennzahl und nie ein Kundenobjekt —
 * keine Fassung, kein Mandant, kein Recht. Sie belegt den Assistenten „Kennzahl anlegen“ vor und sagt, was sie an Menge
 * und Bezugsgröße erwartet; die Eingänge bindet der Kunde ausdrücklich (Invariante 5).
 *
 * <p>Die Datei ist kanonisch; {@code frontend/portal/src/kennzahlen/kennzahl-vorlagen.json} ist ihre byte-gleiche
 * Kopie. Die Form hält {@code docs/contracts/v2/kennzahl-vorlagen.schema.json} fest ({@code KennzahlVorlagenTest}).
 * Die Vorbelegung ruft {@link KennzahlRegeln#vorlage} — derselbe Platzhalter, dieselbe Regel wie der TS-Zwilling.
 */
@Component
public class KennzahlVorlagen {

    static final String RESSOURCE = "/kennzahlen/kennzahl-vorlagen.json";

    /** Der Platzhalter am Ende jedes Name-Vorschlags; er wird der Name des Geltungsobjekts. */
    public static final String PLATZHALTER = "{Geltungsbereich}";

    /**
     * Was eine Vorlage an einer Seite erwartet. {@code art} messstelle: Messstellen-Arten (berechnet = Gesamtwert),
     * Größe, Richtungen ({@code null} = keine Vorgabe) und Wertarten; {@code art} bezugsgroesse: Arten, Einheiten
     * und Wertarten der Bezugsgröße. Die Felder der anderen Art sind {@code null}.
     */
    public record Erwartung(String art, List<String> messstelleArten, String groesse, List<String> richtungen,
            List<String> wertarten, List<String> bezugsgroesseArten, List<String> einheiten, String satz) {}

    /** Eine Vorlage (§4.12); {@code zaehler} ist Menge bzw. Teil, {@code nenner} Bezugsgröße bzw. Ganzes. */
    public record Vorlage(String kennung, String nameVorschlag, String zweckVorschlag, String hilfesatz,
            String rechenform, boolean komplement, Erwartung zaehler, Erwartung nenner) {}

    private final JsonNode raw;
    private final Map<String, Vorlage> nachKennung = new LinkedHashMap<>();

    public KennzahlVorlagen(ObjectMapper mapper) {
        try (InputStream in = getClass().getResourceAsStream(RESSOURCE)) {
            if (in == null) {
                throw new IllegalStateException("kennzahlen/kennzahl-vorlagen.json fehlt im Klassenpfad");
            }
            this.raw = mapper.readTree(in);
        } catch (IOException e) {
            throw new IllegalStateException("kennzahlen/kennzahl-vorlagen.json ist nicht lesbar", e);
        }
        for (JsonNode v : raw.path("vorlagen")) {
            Vorlage vorlage = new Vorlage(text(v, "kennung"), text(v, "name_vorschlag"), text(v, "zweck_vorschlag"),
                    text(v, "hilfesatz"), text(v, "rechenform"), v.path("komplement").asBoolean(),
                    erwartung(v.path("zaehler_erwartung")), erwartung(v.path("nenner_erwartung")));
            if (!vorlage.nameVorschlag().endsWith(" — " + PLATZHALTER)) {
                throw new IllegalStateException("Vorlage " + vorlage.kennung() + ": der Name endet nicht auf den Platzhalter");
            }
            if (nachKennung.put(vorlage.kennung(), vorlage) != null) {
                throw new IllegalStateException("Vorlage doppelt: " + vorlage.kennung());
            }
        }
        if (nachKennung.isEmpty()) {
            throw new IllegalStateException("kennzahlen/kennzahl-vorlagen.json trägt keine Vorlage");
        }
    }

    /** Alle Vorlagen in Katalog-Reihenfolge. */
    public List<Vorlage> alle() {
        return List.copyOf(nachKennung.values());
    }

    public Optional<Vorlage> vorlage(String kennung) {
        return Optional.ofNullable(nachKennung.get(kennung));
    }

    /** Die Antwort von {@code GET /api/v1/kennzahl-vorlagen}: Fassung und Vorlagen, Knoten für Knoten die der Datei. */
    public ObjectNode katalog() {
        ObjectNode aus = raw.deepCopy();
        aus.retain("schema_version", "vorlagen");
        return aus;
    }

    /**
     * Die Vorbelegung einer Anfrage an {@code POST /api/v1/kennzahlen} und {@code …/vorschau} aus einer Vorlage (K20):
     * Rechenform, Name mit dem Geltungsobjekt, Zweck, beim Anteil das Komplement — und sonst nichts. Kennzeichen,
     * Verantwortlich und Periode bleiben leer (der Server vergibt bzw. nimmt den Aufrufer), die Eingänge bindet der Kunde.
     */
    public static KennzahlDto.Anfrage vorbelegung(Vorlage v, String geltungArt, String geltungId, String geltungName) {
        KennzahlRegeln.Belegung b = KennzahlRegeln.vorlage(v.rechenform(), v.nameVorschlag(), v.zweckVorschlag(), geltungName);
        Boolean komplement = KennzahlRegeln.ANTEIL.equals(b.rechenform()) ? v.komplement() : null;
        return new KennzahlDto.Anfrage(null, b.name(), b.rechenform(), geltungArt, geltungId, null, b.zweck(), null,
                komplement, List.of());
    }

    private static Erwartung erwartung(JsonNode e) {
        return new Erwartung(text(e, "art"), texte(e.get("messstelle_arten")), e.path("groesse").textValue(),
                texte(e.get("richtungen")), texte(e.get("wertarten")), texte(e.get("bezugsgroesse_arten")),
                texte(e.get("einheiten")), text(e, "satz"));
    }

    private static String text(JsonNode n, String feld) {
        JsonNode w = n.get(feld);
        if (w == null || !w.isTextual() || w.asText().isBlank()) {
            throw new IllegalStateException("kennzahl-vorlagen.json: Feld " + feld + " fehlt");
        }
        return w.asText();
    }

    private static List<String> texte(JsonNode liste) {
        if (liste == null || liste.isNull()) {
            return null;
        }
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
        return List.copyOf(aus);
    }
}
