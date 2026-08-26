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
                null, false, Set.of(), Map.of(), Set.of(), Map.of(), 0, 20);

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
                false, Set.of(), Map.of(key, 30), Set.of(key), Map.of(), 0, 10);
        assertThat(bySelector.points()).extracting(MeasurementCatalog.Point::pointKey)
                .contains(key);

        var recorded = catalog.search("", Set.of(), null, null, true,
                false, Set.of(), Map.of(key, 30), Set.of(key), Map.of(), 0, 10);
        assertThat(recorded.total()).isEqualTo(1);
        assertThat(recorded.points().get(0).selected()).isTrue();
        assertThat(recorded.points().get(0).selectedCadenceS()).isEqualTo(30);
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
}
