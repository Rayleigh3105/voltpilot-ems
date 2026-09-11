package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
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
        assertThat(catalog.inhaltsstand()).isEqualTo("2026.09.11.1");

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
}
