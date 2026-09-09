package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Der Katalog der KURVEN-VORLAGEN der SoC-Ableitung (P5b Ebene 2, Konzept
 * {@code vp-deye-diybms-luecke-l5} §3.2b) - geladen aus
 * {@code soccurves/catalog.json}, dem {@code entitytypes/catalog.json}-Muster
 * folgend.
 *
 * <p><b>Eine Vorlage ist ein DATENSATZ, kein Code.</b> Sie füllt nur die beiden
 * Kennlinien einer {@code soc_derivation} vor; die Methode selbst bleibt
 * generisch und vollständig konfigurierbar. Wer eigene Stützpunkte hat, trägt
 * sie ein und braucht keine Vorlage - deshalb ist die Auswahl einer Vorlage
 * NIE Pflicht.
 *
 * <p><b>⚠ Warum es (heute) genau EINE gibt:</b> eine Kennlinie ist eine MESSUNG
 * an einer bestimmten Zellchemie. Die ausgelieferte Tabelle ist byte-verbatim
 * der Kundenflow vom 09.09.2026; sie steht zusätzlich in
 * {@code docs/contracts/v2/soc-derivation-vectors.json}, und
 * {@code SocCurveTemplateTest} beweist die Gleichheit beider Dateien. Eine
 * „LiFePO4 generisch"-Vorlage hätte VoltPilot erfinden müssen - und eine
 * erfundene Kennlinie ist kein Angebot, sondern ein falscher Ladestand mit
 * Nachkommastellen.
 *
 * <p>Der Katalog wird beim Start VOLLSTÄNDIG gegen dieselben Regeln geprüft,
 * die auch eine selbst eingetragene Kurve bestehen muss
 * ({@link UserDefinedBatteryDefinition#checkCurve}) - eine Vorlage, die die
 * eigene Prüfung nicht besteht, wäre eine Falle mit Gütesiegel.
 */
@Component
public class SocCurveTemplateCatalog {

    /** Die Kennung einer Vorlage - dieselbe kebab-case-Form wie ein Typ. */
    public static final Pattern ID_PATTERN = Pattern.compile("^[a-z][a-z0-9-]{0,62}$");

    /** Eine Vorlage, so wie das Portal (P5d) sie anbietet. */
    public record Template(String id, String label, String description, String chemistry,
            Integer cellsInSeries, Double refTempC, Double cellMinV, Double cellMaxV,
            String source, List<double[]> curveCharge, List<double[]> curveDischarge) {}

    private final Map<String, Template> templates = new LinkedHashMap<>();

    public SocCurveTemplateCatalog(ObjectMapper mapper) {
        JsonNode raw;
        try (InputStream in = getClass().getResourceAsStream("/soccurves/catalog.json")) {
            if (in == null) {
                throw new IllegalStateException("soccurves/catalog.json missing from classpath");
            }
            raw = mapper.readTree(in);
        } catch (IOException e) {
            throw new IllegalStateException("soccurves/catalog.json unreadable", e);
        }
        for (JsonNode t : raw.path("templates")) {
            String id = t.path("id").asText();
            if (!ID_PATTERN.matcher(id).matches()) {
                throw new IllegalStateException("curve template id not kebab-case: " + id);
            }
            List<double[]> charge = points(t.path("curve_charge"), id, "curve_charge");
            List<double[]> discharge = t.hasNonNull("curve_discharge")
                    ? points(t.path("curve_discharge"), id, "curve_discharge") : null;
            templates.put(id, new Template(id,
                    t.path("label").asText(id),
                    t.path("description").asText(""),
                    t.path("chemistry").asText(""),
                    t.hasNonNull("cells_in_series") ? t.get("cells_in_series").asInt() : null,
                    t.hasNonNull("ref_temp_c") ? t.get("ref_temp_c").asDouble() : null,
                    t.hasNonNull("cell_min_v") ? t.get("cell_min_v").asDouble() : null,
                    t.hasNonNull("cell_max_v") ? t.get("cell_max_v").asDouble() : null,
                    t.path("source").asText(""),
                    charge, discharge));
        }
        if (templates.isEmpty()) {
            throw new IllegalStateException("soccurves/catalog.json declares no templates");
        }
    }

    /**
     * Eine Kennlinie aus dem Katalog - geprüft wie eine eingetippte.
     *
     * <p>Die Prüfung ist ABSICHTLICH dieselbe: eine Vorlage, die die Regel
     * ihrer eigenen Fläche nicht besteht, wäre eine Falle mit Gütesiegel.
     */
    private static List<double[]> points(JsonNode node, String id, String field) {
        List<double[]> out = new ArrayList<>();
        for (JsonNode p : node) {
            if (!p.isArray() || p.size() < 2) {
                throw new IllegalStateException(id + "." + field + ": Stützpunkt ist kein Paar");
            }
            out.add(new double[] {p.get(0).asDouble(), p.get(1).asDouble()});
        }
        List<String> errors = new ArrayList<>();
        List<double[]> checked = UserDefinedBatteryDefinition.checkCurve(out, field, errors);
        if (!errors.isEmpty() || checked == null) {
            throw new IllegalStateException(id + ": " + String.join(" ", errors));
        }
        return checked;
    }

    /** Alle Vorlagen in Katalog-Reihenfolge. */
    public List<Template> all() {
        return List.copyOf(templates.values());
    }

    /** Eine Vorlage, oder {@code null} - ein unbekannter Name wird nie geraten. */
    public Template find(String id) {
        return id == null ? null : templates.get(id);
    }
}
