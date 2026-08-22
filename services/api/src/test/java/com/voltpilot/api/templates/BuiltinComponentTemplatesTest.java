package com.voltpilot.api.templates;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.templates.BuiltinComponentTemplates.BuiltinTemplate;
import java.io.InputStream;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

/**
 * Die eingecheckte Vorlagen-Ressource, rein und ohne Docker geprüft - das
 * java-seitige Glied der Drift-Kette (Einheitsmodell Stufe 0a).
 *
 * <p>Die Kette hat ZWEI Glieder, und beide brauchen einen eigenen Wächter, weil
 * sie in verschiedenen Sprachen leben:
 * <ol>
 *   <li><b>Go-Katalog ⟷ Ressource:</b> {@code TestBuiltinTemplateExportMatchesTheCommittedFile}
 *       in {@code edge-app/core/internal/inverter} vergleicht die BYTES.</li>
 *   <li><b>Ressource ⟷ Tabelle:</b> hier + {@code ComponentTemplateApiTest}.</li>
 * </ol>
 * Zusammen ergibt das die vom Auftrag verlangte Gleichheit „Go-Katalog ⟷
 * Tabelle" - ein Java-Test kann den Go-Katalog nicht selbst ausführen, deshalb
 * ist die eingecheckte Datei das gemeinsame Zwischenstück.
 */
class BuiltinComponentTemplatesTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final BuiltinComponentTemplates builtin = new BuiltinComponentTemplates(mapper);

    @Test
    void theResourceCarriesEveryBrandOfTheEdgeCatalog() {
        List<BuiltinTemplate> all = builtin.all();
        assertThat(all).as("die Ressource ist nicht leer").isNotEmpty();

        // Die sieben Marken des Geräte-Katalogs (inverter.go DefaultCatalog).
        // Fällt eine weg, hat jemand den Katalog beschnitten, ohne es zu merken -
        // der Kunde bekäme im Assistenten weniger Geräte, als seine Box lesen kann.
        Set<String> brands = all.stream().map(BuiltinTemplate::brand).collect(Collectors.toSet());
        assertThat(brands).containsExactlyInAnyOrder("deye", "generic_modbus", "fronius",
                "fronius_sunspec", "kostal", "go-e", "shelly");

        // Die Deye-Modellreihe ist die grösste und der Grund, warum die Vorlage
        // je MODELL geschlüsselt ist (ein Registerprofil deckt mehrere Baureihen ab).
        assertThat(all.stream().filter(t -> "deye".equals(t.brand())).count())
                .as("Deye-Modelle").isGreaterThanOrEqualTo(30);
    }

    @Test
    void everyTemplateIsBuiltinSlugSafeAndUnique() {
        Set<String> refs = builtin.all().stream()
                .map(BuiltinTemplate::templateRef).collect(Collectors.toSet());
        assertThat(refs).hasSameSizeAs(builtin.all());
        for (BuiltinTemplate t : builtin.all()) {
            assertThat(BuiltinComponentTemplates.REF_PATTERN.matcher(t.templateRef()).matches())
                    .as("Schlüssel %s ist slug-sicher", t.templateRef()).isTrue();
            assertThat(t.templateRef()).startsWith("builtin:");
            assertThat(t.version()).isEqualTo(1);
            assertThat(t.certificationStatus()).isEqualTo("builtin");
            assertThat(t.brand()).isNotBlank();
            assertThat(t.model()).isNotBlank();
            assertThat(t.communication()).isNotBlank();
            assertThat(t.transportSchemaJson()).as("Transport-Schema ist echte Daten")
                    .isNotBlank().startsWith("[");
        }
    }

    /**
     * DIE Ehrlichkeitsregel dieser Stufe: {@code null} heisst „hier nicht
     * erklärt", nicht „gibt es nicht". Eine eingebaute Vorlage erklärt ihre
     * Kanäle im Decode-Profil auf der Box und ihren Schreibweg im Steuer-Adapter
     * - eine leere Liste wäre die Behauptung „liefert keine Messwerte" bzw.
     * „kann nichts schreiben", und beides ist für einen Deye-Hybriden falsch.
     */
    @Test
    void builtinTemplatesDeclareChannelsAndWritesAsNullNotAsEmpty() {
        for (BuiltinTemplate t : builtin.all()) {
            assertThat(t.channelsJson()).as("%s: Kanäle", t.templateRef()).isNull();
            assertThat(t.writesJson()).as("%s: Schreibwege", t.templateRef()).isNull();
        }
    }

    /** {@code rated_kw} = 0 wäre eine Aussage über ein Gerät, die niemand belegt hat. */
    @Test
    void ratedKwIsNullWhenUnknownAndNeverZero() {
        BuiltinTemplate generic = find("builtin:generic_modbus:sunspec");
        assertThat(generic.ratedKw()).as("generischer SunSpec-Eintrag hat keine Nennleistung")
                .isNull();

        BuiltinTemplate deye = find("builtin:deye:sun-30k-sg01hp3");
        assertThat(deye.ratedKw()).isNotNull();
        assertThat(deye.ratedKw().doubleValue()).isEqualTo(30.0);

        for (BuiltinTemplate t : builtin.all()) {
            if (t.ratedKw() != null) {
                assertThat(t.ratedKw().signum()).as("%s trägt 0 kW", t.templateRef()).isPositive();
            }
        }
    }

    /**
     * Die Katalog-Neustruktur (Konzept data/vp-anlegen-rework/konzept.md):
     * jede Vorlage nennt ihren GERÄTETYP, und der frühere zweite Fronius-Eintrag
     * ist eine ABGELÖSTE Vorlage - auflösbar, aber nicht mehr angeboten.
     */
    @Test
    void everyTemplateDeclaresItsDeviceTypeAndTheLegacyFroniusIsSuperseded() {
        Set<String> known = Set.of("inverter", "wallbox", "switch", "meter",
                "charge_point", "custom");
        for (BuiltinTemplate t : builtin.all()) {
            assertThat(t.deviceType()).as("%s: Gerätetyp", t.templateRef()).isIn(known);
        }
        assertThat(find("builtin:go-e:goe_http_api").deviceType()).isEqualTo("wallbox");
        assertThat(find("builtin:shelly:shelly_http").deviceType()).isEqualTo("switch");
        assertThat(find("builtin:deye:sun-30k-sg01hp3").deviceType()).isEqualTo("inverter");

        // Die aktive Fronius-Zeile gilt; die abgelöste nennt ihre Nachfolgerin -
        // und die muss es wirklich geben, sonst wäre sie eine Sackgasse.
        assertThat(find("builtin:fronius:fronius-eco-27-3-s").supersededBy()).isNull();
        BuiltinTemplate alt = find("builtin:fronius_sunspec:fronius-eco-27-3-s");
        assertThat(alt.supersededBy()).isEqualTo("builtin:fronius:fronius-eco-27-3-s");
        assertThat(builtin.all().stream().map(BuiltinTemplate::templateRef))
                .contains(alt.supersededBy());
        for (BuiltinTemplate t : builtin.all()) {
            if (t.supersededBy() != null) {
                assertThat(t.brand()).as("nur die Alias-Marke ist abgelöst")
                        .isEqualTo("fronius_sunspec");
            }
        }
    }

    /**
     * Captain-Entscheid 4: die Marke heisst, wie sie auf dem Typenschild steht -
     * ALLE Technik-Zusätze sind aus den MARKENNAMEN heraus (sie stehen in der
     * Beschreibungszeile). Ein Klammer-Zusatz im Markennamen war zugleich das
     * Symptom, an dem der doppelte Fronius hing.
     */
    @Test
    void noBrandLabelCarriesATechnicalParenthesis() {
        for (BuiltinTemplate t : builtin.all()) {
            assertThat(t.brandLabel()).as("Markenname %s", t.brandLabel())
                    .doesNotContain("(").doesNotContain(")").doesNotContain("/");
        }
        assertThat(find("builtin:go-e:goe_http_api").brandLabel()).isEqualTo("go-e");
        assertThat(find("builtin:shelly:shelly_http").brandLabel()).isEqualTo("Shelly");
        assertThat(find("builtin:fronius_sunspec:fronius-eco-27-3-s").brandLabel())
                .isEqualTo("Fronius");
    }

    /**
     * Der Duplikat-Befund des Konzepts: Modell und Familie des generischen
     * Eintrags hiessen beide „SunSpec (Standard)" und standen damit zweimal
     * gleich im Baum.
     */
    @Test
    void theGenericEntryNoLongerNamesItsModelLikeItsFamily() {
        BuiltinTemplate generic = find("builtin:generic_modbus:sunspec");
        assertThat(generic.modelLabel()).isNotEqualTo(generic.familyLabel());
    }

    /** Die Decode-Profil-Referenz ist die Brücke zum Code, der die Vorlage ausführt. */
    @Test
    void theDecodeProfileAndTransportFieldsComeFromTheCatalogVerbatim() {
        BuiltinTemplate deye = find("builtin:deye:sun-30k-sg01hp3");
        assertThat(deye.family()).isEqualTo("hybrid_3p");
        assertThat(deye.communication()).isEqualTo("solarman_v5");
        assertThat(deye.controlTier()).as("Deye deklariert das ToU-Primitiv").isEqualTo(3);
        assertThat(deye.transportSchemaJson())
                .contains("\"key\":\"ip\"")
                .contains("\"key\":\"serial\"")
                .as("das Feld-Vokabular reist mit Hilfetexten").contains("\"help\"");

        // go-e ist ein VERBRAUCHER - Tier 0, weil der Steuerweg der Go-Executor
        // ist, nicht der Batterie-Adapter. Ein von hier abgeleiteter Anspruch
        // wäre falsch.
        assertThat(find("builtin:go-e:goe_http_api").controlTier()).isZero();
    }

    /** Die öffentliche Menge der Lese-Route schliesst private Vorlagen aus. */
    @Test
    void publicKindsDeliberatelyExcludeCustom() {
        assertThat(BuiltinComponentTemplates.PUBLIC_KINDS)
                .containsExactlyInAnyOrder("builtin", "certified")
                .doesNotContain("custom");
    }

    /**
     * Was NICHT im Export steht, ist so wichtig wie was drinsteht: das Dokument
     * darf keine Zeitstempel tragen, sonst wäre es bei gleichem Katalog nicht
     * byte-gleich und der Go-Drift-Wächter könnte nicht auf Bytes vergleichen.
     */
    @Test
    void theExportDocumentIsStableAcrossRuns() throws Exception {
        try (InputStream in = getClass().getResourceAsStream("/componenttemplates/builtin.json")) {
            JsonNode raw = mapper.readTree(in);
            assertThat(raw.path("schema_version").asText()).isEqualTo("1.0");
            assertThat(raw.path("generated_from").asText())
                    .contains("DefaultCatalog").contains("vp-template-export");
            assertThat(raw.has("generated_at")).as("kein Zeitstempel im Dokument").isFalse();
        }
        assertThat(builtin.schemaVersion()).isEqualTo("1.0");
    }

    private BuiltinTemplate find(String ref) {
        return builtin.all().stream().filter(t -> ref.equals(t.templateRef())).findFirst()
                .orElseThrow(() -> new AssertionError("Vorlage " + ref + " fehlt"));
    }
}
