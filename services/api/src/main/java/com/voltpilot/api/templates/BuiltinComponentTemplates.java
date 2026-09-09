package com.voltpilot.api.templates;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Die EINGEBAUTEN Komponenten-Vorlagen als Daten (Einheitsmodell Stufe 0a,
 * Scout data/vp-komponenten-einheit-h2 Teil 3.1): lädt beim Start die
 * eingecheckte Ressource {@code componenttemplates/builtin.json} - das
 * Muster von {@link com.voltpilot.api.entities.EntityTypeCatalog} und
 * {@code flowcatalog/catalog.json}.
 *
 * <p><b>Woher die Datei kommt und warum sie nicht driften kann.</b> Sie wird
 * NICHT von Hand gepflegt, sondern aus dem Go-Geräte-Katalog erzeugt
 * ({@code edge-app/core/internal/inverter DefaultCatalog()} über
 * {@code cmd/vp-template-export}). Der Go-Katalog bleibt die Wahrheit darüber,
 * was eine Box wirklich lesen kann; diese Datei ist seine cloud-seitige
 * Darstellung. Die Kette hat zwei Glieder, jedes mit eigenem Wächter:
 * <ol>
 *   <li>Go-Katalog ⟷ Datei: {@code TestBuiltinTemplateExportMatchesTheCommittedFile}
 *       vergleicht die BYTES (ein Katalog-Edit ohne Re-Export fällt im
 *       {@code go test ./...}-Lauf durch).</li>
 *   <li>Datei ⟷ Tabelle: {@link ComponentTemplateSeeder} spiegelt sie bei jedem
 *       Start, und {@code ComponentTemplateApiTest} prüft die Menge gegen die
 *       Ressource.</li>
 * </ol>
 *
 * <p><b>Die Ehrlichkeitsregel dieser Stufe:</b> {@code channels} und
 * {@code writes} sind bei einer eingebauten Vorlage {@code null} - „hier nicht
 * erklärt", nicht „gibt es keine". Ihre Kanäle entstehen im Decode-Profil auf
 * der Box, ihr Schreibweg im Steuer-Adapter; eine Liste hier wäre eine
 * unbelegte Behauptung, eine leere Liste eine falsche.
 */
@Component
public class BuiltinComponentTemplates {

    /** Die gepinnte Zeichenmenge des Vorlagen-Schlüssels (Zwilling der Go-Seite + des DB-CHECKs). */
    public static final Pattern REF_PATTERN = Pattern.compile("^[a-z0-9][a-z0-9._:-]{0,127}$");

    /** Herkunft einer Vorlage - das vollständige Vokabular der Spalte {@code kind}. */
    public static final String KIND_BUILTIN = "builtin";
    public static final String KIND_CERTIFIED = "certified";
    public static final String KIND_CUSTOM = "custom";

    /**
     * Die Herkunftsarten, die eine KUNDEN-Route ausliefern darf.
     *
     * <p>{@code custom} fehlt hier mit Absicht und nicht aus Bequemlichkeit:
     * eine private Vorlage gehört EINER Anlage, diese Tabelle hat aber bewusst
     * keine {@code tenant_id} - sie über eine mandantenlose Route auszuliefern
     * wäre ein Leck. Stufe 3 baut den Zaun, dann erst wächst diese Menge.
     */
    public static final Set<String> PUBLIC_KINDS = Set.of(KIND_BUILTIN, KIND_CERTIFIED);

    /**
     * Eine eingebaute Vorlage, so wie sie in die Tabelle wandert. {@code channels}
     * / {@code writes} reisen als roher JSON-Text (oder {@code null}) - sie
     * werden nirgends interpretiert, nur durchgereicht.
     */
    public record BuiltinTemplate(String templateRef, int version, String brand, String brandLabel,
            String model, String modelLabel, String modelAliasesJson, String deviceType,
            String supersededBy,
            String family, String familyLabel,
            String communication, String communicationLabel, String transportSchemaJson,
            String channelsJson, String writesJson, BigDecimal ratedKw, int controlTier,
            String certificationStatus, String note) {}

    private final List<BuiltinTemplate> templates;
    private final String schemaVersion;

    public BuiltinComponentTemplates(ObjectMapper mapper) {
        JsonNode raw;
        try (InputStream in = getClass().getResourceAsStream("/componenttemplates/builtin.json")) {
            if (in == null) {
                throw new IllegalStateException("componenttemplates/builtin.json missing from classpath");
            }
            raw = mapper.readTree(in);
        } catch (IOException e) {
            throw new IllegalStateException("componenttemplates/builtin.json unreadable", e);
        }
        this.schemaVersion = raw.path("schema_version").asText("");
        List<BuiltinTemplate> parsed = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (JsonNode t : raw.path("templates")) {
            String ref = t.path("template_ref").asText();
            if (!REF_PATTERN.matcher(ref).matches()) {
                throw new IllegalStateException("builtin template ref not slug-safe: " + ref);
            }
            if (!seen.add(ref)) {
                throw new IllegalStateException("builtin template ref declared twice: " + ref);
            }
            if (!KIND_BUILTIN.equals(t.path("kind").asText())) {
                throw new IllegalStateException("builtin export carries a non-builtin kind: " + ref);
            }
            parsed.add(new BuiltinTemplate(
                    ref,
                    t.path("version").asInt(1),
                    t.path("brand").asText(),
                    t.path("brand_label").asText(),
                    t.path("model").asText(),
                    t.path("model_label").asText(),
                    // Typenschild-Varianten desselben Modells: absent = „dieses
                    // Modell hat nur seinen einen Namen". Rohes JSON, wie die
                    // Nachbarfelder - hier wird nichts interpretiert.
                    jsonOrNull(t, "model_aliases"),
                    // Beide NULL-freundlich: „die Vorlage sagt dazu nichts" ist eine
                    // eigene Aussage, nie ein leerer Wert (siehe V20260835000000).
                    text(t, "device_type"),
                    text(t, "superseded_by"),
                    text(t, "family"),
                    text(t, "family_label"),
                    t.path("communication").asText(),
                    text(t, "communication_label"),
                    // Das Transport-Schema ist echte Daten und reist als JSON-Text.
                    t.path("transport_schema").toString(),
                    // null bleibt null: absent und "[]" sind verschiedene Aussagen.
                    jsonOrNull(t, "channels"),
                    jsonOrNull(t, "writes"),
                    t.hasNonNull("rated_kw") ? t.get("rated_kw").decimalValue() : null,
                    t.path("control_tier").asInt(0),
                    t.path("certification_status").asText("builtin"),
                    text(t, "note")));
        }
        if (parsed.isEmpty()) {
            throw new IllegalStateException("componenttemplates/builtin.json declares no templates");
        }
        this.templates = List.copyOf(parsed);
    }

    private static String text(JsonNode node, String field) {
        return node.hasNonNull(field) ? node.get(field).asText() : null;
    }

    /** Roher JSON-Text des Feldes, oder {@code null} bei absent/JSON-null. */
    private static String jsonOrNull(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v == null || v.isNull() ? null : v.toString();
    }

    /** Alle eingebauten Vorlagen in Katalog-Reihenfolge. */
    public List<BuiltinTemplate> all() {
        return templates;
    }

    /** Die Formversion des Export-Dokuments (nicht die des Katalog-Inhalts). */
    public String schemaVersion() {
        return schemaVersion;
    }
}
