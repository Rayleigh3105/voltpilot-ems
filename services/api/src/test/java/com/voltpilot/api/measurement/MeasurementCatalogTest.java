package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class MeasurementCatalogTest {

    private final MeasurementCatalog catalog = new MeasurementCatalog(new ObjectMapper());

    @Test
    void canonicalArtifactSupportsSearchFacetsAndSemanticHonesty() {
        var result = catalog.search("Batteriestrom", Set.of("hybrid_1p"), null, null,
                null, false, false, Set.of(), Map.of(), Set.of(), Map.of(), 0, 20);

        assertThat(result.catalogVersion()).isEqualTo("2026.08.26.3");
        assertThat(result.customPointActionLabel()).isEqualTo("Eigenen Messwert hinzufügen");
        assertThat(result.points()).isNotEmpty();
        assertThat(result.points()).allSatisfy(p -> {
            assertThat(p.family()).isEqualTo("hybrid_1p");
            assertThat(p.semanticStatus()).isIn("known", "vendor_label_only", "unknown");
            assertThat(p.retention().rawRetentionDays()).isEqualTo(90);
            assertThat(p.sourceUrl()).startsWith("https://");
            assertThat(p.sourceCommit()).isNotBlank();
        });
        assertThat(result.semanticStatuses()).extracting(MeasurementCatalog.Facet::value)
                .isNotEmpty();
    }

    @Test
    void selectorsAndUnitsAreSearchableAndRecordedFilterUsesCurrentSelection() {
        String key = "deye.hybrid_1p.battery.battery-current";
        var bySelector = catalog.search("holding:0x00bf", Set.of(), null, null, null,
                false, false, Set.of(), Map.of(key, 30), Set.of(key), Map.of(), 0, 10);
        assertThat(bySelector.points()).extracting(MeasurementCatalog.Point::pointKey)
                .contains(key);

        var recorded = catalog.search("", Set.of(), null, null, true,
                false, false, Set.of(), Map.of(key, 30), Set.of(key), Map.of(), 0, 10);
        assertThat(recorded.total()).isEqualTo(1);
        assertThat(recorded.points().get(0).selected()).isTrue();
        assertThat(recorded.points().get(0).selectedCadenceS()).isEqualTo(30);
    }

    @Test
    void selectedOnlyReturnsASelectedPointBeyondTheFirstCatalogPage() {
        String key = "deye.hybrid_3p.pv.pv2-voltage";
        var firstPage = catalog.search("", Set.of("hybrid_3p"), null, null, null,
                false, false, Set.of("hybrid_3p"), Map.of(key, 30), Set.of(key),
                Map.of(), 0, 250);
        assertThat(firstPage.total()).isGreaterThan(250);
        assertThat(firstPage.points()).extracting(MeasurementCatalog.Point::pointKey)
                .doesNotContain(key);

        var selected = catalog.search("", Set.of(), null, null, null,
                false, true, Set.of("hybrid_3p"), Map.of(key, 30), Set.of(key),
                Map.of(), 0, 250);
        assertThat(selected.total()).isEqualTo(1);
        assertThat(selected.points()).extracting(MeasurementCatalog.Point::pointKey)
                .containsExactly(key);
        assertThat(selected.points().get(0).selected()).isTrue();
    }

    /**
     * Der geräteseitige Summenwert-Assistent (Konzept vp-agg-konzept3-r8) braucht die
     * Katalog-Größe/Richtung JE ROHEM Register - nicht nur für die selektierten Messkanäle -,
     * damit sein Guard ehrlich sperren (kW ≠ kWh) und den Gen-Port-Haken (direction == null)
     * nur dort anbieten kann. Darum trägt {@link MeasurementCatalog.Point} quantity/direction
     * additiv, deckungsgleich mit der {@code semantik}-Map; ältere Clients ignorieren die Felder.
     */
    @Test
    void pointsCarryCatalogQuantityAndDirectionForTheSumValueGuard() {
        MeasurementCatalog.Point pv = catalog.resolve("deye.hybrid_3p.pv.pv1-power");
        assertThat(pv).isNotNull();
        assertThat(pv.quantity()).isEqualTo("active_power");
        assertThat(pv.direction()).isEqualTo("generation");

        // Der Gen-Port ist richtungslos (direction == null) - nur hier gilt der AP-08-Haken.
        MeasurementCatalog.Point genPort = catalog.resolve("deye.hybrid_1p.load.generator-power");
        assertThat(genPort).isNotNull();
        assertThat(genPort.quantity()).isEqualTo("active_power");
        assertThat(genPort.direction()).isNull();

        // Ein dynamischer Modul-Punkt trägt die Semantik seiner Vorlage über instantiate().
        MeasurementCatalog.Point modul = catalog.resolve("sunspec.model_160.module[7].dcwh");
        assertThat(modul).isNotNull();
        assertThat(modul.quantity()).isEqualTo("active_energy");
        assertThat(modul.direction()).isEqualTo("generation");

        // Die Point-Felder sind deckungsgleich mit der bestehenden semantik()-Map.
        for (MeasurementCatalog.Point p : List.of(pv, genPort, modul)) {
            assertThat(new MeasurementCatalog.Semantik(p.quantity(), p.direction()))
                    .isEqualTo(catalog.semantik(p.pointKey()));
        }
    }

    @Test
    void sunspecModel160InstancesResolvePerReportedModule() {
        var point = catalog.resolve("sunspec.model_160.module[7].dcw");

        assertThat(point).isNotNull();
        assertThat(point.pointKey()).isEqualTo("sunspec.model_160.module[7].dcw");
        assertThat(point.selector()).contains("module[7]");
        assertThat(point.retention().longTermCadenceS()).isEqualTo(300);
        assertThat(catalog.resolve("sunspec.model_160.module[999].dcw")).isNull();
    }

    /**
     * Zwei Stände: die api veröffentlicht und speichert weiter den LAUFZEITSTAND der Box (die
     * Palette lehnt jede fremde catalog_version ab); Größe und Richtung kommen aus dem
     * paketierten Inhaltsstand.
     */
    @Test
    void theBoxKeepsItsRuntimeVersionWhileTheContentVersionCarriesQuantityAndDirection() {
        assertThat(catalog.version()).isEqualTo("2026.08.26.3");
        assertThat(catalog.inhaltsstand()).isEqualTo("2026.09.17.1");

        assertThat(catalog.semantik("sunspec.model_203.totwhimp"))
                .isEqualTo(new MeasurementCatalog.Semantik("active_energy", "import"));
        assertThat(catalog.semantik("sunspec.model_203.w"))
                .isEqualTo(new MeasurementCatalog.Semantik("active_power", "import_export"));
        assertThat(catalog.semantik("sunspec.model_160.module[7].dcwh"))
                .isEqualTo(new MeasurementCatalog.Semantik("active_energy", "generation"));
        assertThat(catalog.semantik("goe.api_v2.eto"))
                .isEqualTo(new MeasurementCatalog.Semantik(null, null));
        assertThat(catalog.semantik("gibt.es.nicht")).isNull();
    }

    /**
     * Die Einheit eines OCPP-Messwerts steht nicht im Katalog, sondern im konkreten Schlüssel der Reihe —
     * die Station nennt sie je SampledValue. Ohne genannte Einheit ({@code unit[none]}) und an der Vorlage
     * bleibt sie unbekannt; jeder andere Punkt behält die Katalog-Einheit, auch eine ohne.
     */
    @Test
    void einOcppZaehlerNenntDieEinheitSeinesSchluessels() {
        String vorlage = "ocpp.1_6.metervalues.energy.active.import.register.context[*].format[*].phase[*]"
                + ".location[*].unit[*]";
        String reihe = "ocpp.1_6.metervalues.energy.active.import.register.context[sample-periodic].format[raw]"
                + ".phase[none].location[outlet]";
        assertThat(catalog.resolve(vorlage).unit()).as("der Katalog selbst nennt keine").isNull();
        assertThat(catalog.einheit(reihe + ".unit[wh]")).isEqualTo("Wh");
        assertThat(catalog.einheit(reihe + ".unit[kwh]")).isEqualTo("kWh");
        assertThat(catalog.einheit(reihe.replace(".active.", ".reactive.") + ".unit[kvarh]")).isEqualTo("kvarh");
        assertThat(catalog.einheit(reihe + ".unit[none]")).as("nie der OCPP-Vorgabewert Wh geraten").isNull();
        assertThat(catalog.einheit(reihe + ".unit[gibt-es-nicht]")).isNull();
        assertThat(catalog.einheit(vorlage)).isNull();

        assertThat(catalog.einheit("sunspec.model_203.totwhimp")).isEqualTo("Wh");
        assertThat(catalog.einheit("kaco_http.energy-total")).as("benannt, bis der Laufzeitstand steigt")
                .isEqualTo("0,1 kWh");
        assertThat(catalog.einheit("goe.api_v2.eto")).isNull();
        assertThat(catalog.einheit("gibt.es.nicht[wh].unit[wh]")).isNull();
    }

    /**
     * UEMS AP-05 IP-4: die WAGO-Karten stehen im paketierten Inhaltsstand, gehen aber an keine Box, bis der
     * Treiber aus IP-6 ausgeliefert ist — die api bietet sie weder in der Suche noch zur Auswahl an, und
     * sie veröffentlicht weiter den Laufzeitstand, den jede Feld-Box spricht.
     */
    @Test
    void wagoCardsAreContentButNeverOfferedWhileNoBoxReadsThem() throws Exception {
        JsonNode paket;
        try (InputStream in = getClass().getResourceAsStream(
                "/measurementcatalog/measurement-point-catalog-" + catalog.inhaltsstand() + ".json")) {
            paket = new ObjectMapper().readTree(in);
        }
        long wago = 0;
        for (JsonNode p : paket.path("points")) {
            if (p.path("family").asText().startsWith("wago.")) {
                wago++;
            }
        }
        assertThat(wago).as("27 Punkte je Karte im Inhaltsstand").isEqualTo(54);

        assertThat(catalog.familienNochNichtAnDerBox()).containsExactlyInAnyOrder("wago.pm494", "wago.pm495");
        assertThat(catalog.families()).noneMatch(f -> f.startsWith("wago."));
        assertThat(catalog.resolve("wago.pm495.karte[*].energy_import_total")).isNull();
        assertThat(catalog.resolve("wago.pm495.karte[0].energy_import_total")).isNull();
        assertThat(catalog.search("", Set.of("wago.pm494", "wago.pm495"), null, null, null, false, false,
                Set.of("wago.pm494", "wago.pm495"), Map.of(), Set.of(), Map.of(), 0, 250).total()).isZero();
        assertThat(catalog.version()).isEqualTo("2026.08.26.3");
    }

    @Test void missingOrUnknownFamilyIsNamedInsteadOfAnUnexplainedEmptyCatalog() {
        var missing = catalog.search(null, Set.of(), null, null, null, true, false,
                Set.of(), Map.of(), Set.of(), Map.of(), 0, 250);
        assertThat(missing.total()).isZero();
        assertThat(missing.availabilityReason()).isEqualTo("registerfamilie_nicht_zugeordnet");
        var available = catalog.search(null, Set.of(), null, null, null, true, false,
                Set.of("hybrid_3p"), Map.of(), Set.of(), Map.of(), 0, 250);
        assertThat(available.total()).isGreaterThan(250);
        assertThat(available.availabilityReason()).isNull();
    }
}
