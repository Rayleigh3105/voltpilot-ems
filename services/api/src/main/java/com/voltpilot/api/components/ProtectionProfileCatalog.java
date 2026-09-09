package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Hysteresis;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.ProtectionDirection;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Der Katalog der SCHUTZ-VORLAGEN des Grenzbausteins (P5c, Konzept
 * {@code vp-deye-diybms-luecke-l5} §3.2b „OPTIONAL - Schutz-/Grenzbaustein") -
 * geladen aus {@code protectionprofiles/catalog.json}, dem
 * {@link SocCurveTemplateCatalog}-Muster folgend.
 *
 * <p><b>Eine Vorlage ist ein DATENSATZ, kein Code.</b> Sie füllt die
 * Strom-Treppen und die vier Zellspannungs-Schwellen einer {@code protection}
 * vor; der Baustein selbst bleibt generisch und vollständig konfigurierbar. Wer
 * eigene Werte hat, trägt sie ein und braucht keine Vorlage - die Auswahl einer
 * Vorlage ist deshalb NIE Pflicht.
 *
 * <p><b>⚠ Warum es (heute) genau EINE gibt:</b> eine Schutzgrenze ist eine
 * Aussage über EINE Zelle an EINEM Gerät. Die ausgelieferte Tabelle ist
 * byte-verbatim der Kundenflow vom 09.09.2026; sie steht zusätzlich in
 * {@code docs/contracts/v2/limit-protection-vectors.json}, und
 * {@code ProtectionProfileTest} beweist die Gleichheit beider Dateien. Ein
 * erfundener Hartstopp wäre keine Vorlage, sondern eine Abschaltung an der
 * falschen Spannung.
 *
 * <p>Der Katalog wird beim Start VOLLSTÄNDIG gegen dieselben Regeln geprüft,
 * die auch eine selbst eingetragene Treppe bestehen muss
 * ({@link UserDefinedBatteryDefinition#checkDirection} /
 * {@link UserDefinedBatteryDefinition#checkHysteresis}) - eine Vorlage, die die
 * eigene Prüfung nicht besteht, wäre eine Falle mit Gütesiegel.
 */
@Component
public class ProtectionProfileCatalog {

    /** Eine Vorlage, so wie das Portal sie anbietet. */
    public record Profile(String id, String label, String description, String chemistry,
            Integer cellsInSeries, String source, double roundA, ProtectionDirection charge,
            ProtectionDirection discharge, Hysteresis hysteresis) {}

    private final Map<String, Profile> profiles = new LinkedHashMap<>();

    public ProtectionProfileCatalog(ObjectMapper mapper) {
        JsonNode raw;
        try (InputStream in = getClass().getResourceAsStream("/protectionprofiles/catalog.json")) {
            if (in == null) {
                throw new IllegalStateException(
                        "protectionprofiles/catalog.json missing from classpath");
            }
            raw = mapper.readTree(in);
        } catch (IOException e) {
            throw new IllegalStateException("protectionprofiles/catalog.json unreadable", e);
        }
        for (JsonNode p : raw.path("profiles")) {
            String id = p.path("id").asText();
            if (!SocCurveTemplateCatalog.ID_PATTERN.matcher(id).matches()) {
                throw new IllegalStateException("protection profile id not kebab-case: " + id);
            }
            List<String> errors = new ArrayList<>();
            ProtectionDirection charge = UserDefinedBatteryDefinition.checkDirection(
                    direction(p.path("charge")), id + ".charge", errors);
            ProtectionDirection discharge = UserDefinedBatteryDefinition.checkDirection(
                    direction(p.path("discharge")), id + ".discharge", errors);
            Hysteresis hysteresis = UserDefinedBatteryDefinition.checkHysteresis(
                    hysteresis(p.path("hysteresis")), errors);
            if (!errors.isEmpty()) {
                throw new IllegalStateException(id + ": " + String.join(" ", errors));
            }
            profiles.put(id, new Profile(id,
                    p.path("label").asText(id),
                    p.path("description").asText(""),
                    p.path("chemistry").asText(""),
                    p.hasNonNull("cells_in_series") ? p.get("cells_in_series").asInt() : null,
                    p.path("source").asText(""),
                    p.hasNonNull("round_a") ? p.get("round_a").asDouble()
                            : UserDefinedBatteryDefinition.DEFAULT_ROUND_A,
                    charge, discharge, hysteresis));
        }
        if (profiles.isEmpty()) {
            throw new IllegalStateException("protectionprofiles/catalog.json declares no profiles");
        }
    }

    private static ProtectionDirection direction(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        List<double[]> steps = new ArrayList<>();
        for (JsonNode s : node.path("steps")) {
            if (!s.isArray() || s.size() < 2) {
                // Eine kaputte Stufe wird NICHT stillschweigend ausgelassen -
                // sie reist als unbrauchbarer Punkt in die Prüfung und lässt
                // den Start ehrlich scheitern.
                steps.add(new double[] {Double.NaN, Double.NaN});
                continue;
            }
            steps.add(new double[] {s.get(0).asDouble(), s.get(1).asDouble()});
        }
        return new ProtectionDirection(steps,
                node.hasNonNull("max_a") ? node.get("max_a").asDouble() : Double.NaN);
    }

    private static Hysteresis hysteresis(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        return new Hysteresis(
                node.hasNonNull("charge_stop_v") ? node.get("charge_stop_v").asDouble() : null,
                node.hasNonNull("charge_resume_v") ? node.get("charge_resume_v").asDouble() : null,
                node.hasNonNull("discharge_stop_v")
                        ? node.get("discharge_stop_v").asDouble() : null,
                node.hasNonNull("discharge_resume_v")
                        ? node.get("discharge_resume_v").asDouble() : null);
    }

    /** Alle Vorlagen in Katalog-Reihenfolge. */
    public List<Profile> all() {
        return List.copyOf(profiles.values());
    }

    /** Eine Vorlage, oder {@code null} - ein unbekannter Name wird nie geraten. */
    public Profile find(String id) {
        return id == null ? null : profiles.get(id);
    }
}
