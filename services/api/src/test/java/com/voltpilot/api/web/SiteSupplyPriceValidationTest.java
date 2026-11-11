package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.LocalDate;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Feldregeln von {@code PUT …/supply-price}: Komponenten sind ct/kWh
 * zwischen 0 und 999,999 (NUMERIC(6,3)), der USt-Satz zwischen 0 und 100, der
 * Preisblatt-Stand ein Datum - sonst 400 mit deutschem Grund statt eines 500
 * aus der Datenbank (Konzept vp-nacht-bezug-e7 §3.1, analog
 * {@code SiteEinspeiseverguetungSatzTest}). PATCH-Semantik, Gatter und
 * Mandantentrennung prüft {@code PortalApiTest#supplyPriceSheetCrudHonoursPatchSemanticsAndTenantScoping}
 * über die echte Route; dort laufen nur ein negativer Betrag und ein falsches Datum.
 */
class SiteSupplyPriceValidationTest {

    @Test
    void nullLoeschtEineKomponenteUndKommaUndPunktSindErlaubt() {
        assertThat(SiteSupplyPriceController.componentValue("netzentgeltArbeitspreisCt", null)).isNull();
        assertThat(SiteSupplyPriceController.componentValue("netzentgeltArbeitspreisCt", 8.2))
                .isEqualByComparingTo("8.2");
        assertThat(SiteSupplyPriceController.componentValue("stromsteuerCt", "1,558"))
                .isEqualByComparingTo("1.558");
        assertThat(SiteSupplyPriceController.componentValue("umlagenCt", " 2.946 "))
                .isEqualByComparingTo("2.946");
        // 0 ist eine Angabe ("keine Komponente"), keine fehlende.
        assertThat(SiteSupplyPriceController.componentValue("vertriebsaufschlagCt", 0))
                .isEqualByComparingTo("0");
    }

    @Test
    void komponenteAusserhalbVonNullBis999Komma999IstEinDeutscher400er() {
        for (Object ausserhalb : new Object[] {-0.001, 1000}) {
            assertThatThrownBy(() -> SiteSupplyPriceController.componentValue("netzentgeltArbeitspreisCt", ausserhalb))
                    .as(String.valueOf(ausserhalb))
                    .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                        assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                        assertThat(e.getReason())
                                .contains("netzentgeltArbeitspreisCt")
                                .contains("zwischen 0 und 999,999");
                    });
        }
        // Keine Zahl ist ein eigener Grund, nicht die Bereichsmeldung.
        for (Object keineZahl : new Object[] {"abc", "", "1.2.3", true}) {
            assertThatThrownBy(() -> SiteSupplyPriceController.componentValue("netzentgeltArbeitspreisCt", keineZahl))
                    .as(String.valueOf(keineZahl))
                    .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                        assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                        assertThat(e.getReason())
                                .contains("netzentgeltArbeitspreisCt")
                                .contains("als Zahl an");
                    });
        }
        // Randwerte sind erlaubt.
        assertThat(SiteSupplyPriceController.componentValue("netzentgeltArbeitspreisCt", "999.999"))
                .isEqualByComparingTo("999.999");
        assertThat(SiteSupplyPriceController.componentValue("netzentgeltArbeitspreisCt", 0))
                .isEqualByComparingTo("0");
    }

    @Test
    void ustSatzAusserhalbVonNullBisHundertIstEinDeutscher400er() {
        assertThat(SiteSupplyPriceController.ustValue(19)).isEqualByComparingTo("19");
        assertThat(SiteSupplyPriceController.ustValue(0)).isEqualByComparingTo("0");
        assertThat(SiteSupplyPriceController.ustValue(100)).isEqualByComparingTo("100");
        for (Object ausserhalb : new Object[] {-0.01, 100.01}) {
            assertThatThrownBy(() -> SiteSupplyPriceController.ustValue(ausserhalb))
                    .as(String.valueOf(ausserhalb))
                    .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                        assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                        assertThat(e.getReason()).contains("zwischen 0 und 100");
                    });
        }
        for (Object keineZahl : new Object[] {"abc", true}) {
            assertThatThrownBy(() -> SiteSupplyPriceController.ustValue(keineZahl))
                    .as(String.valueOf(keineZahl))
                    .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                        assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                        assertThat(e.getReason()).contains("als Zahl an");
                    });
        }
    }

    @Test
    void nullLoeschtDenPreisblattStandUndEinBefremdetesDatumIstEinDeutscher400er() {
        assertThat(SiteSupplyPriceController.dateValue(null)).isNull();
        assertThat(SiteSupplyPriceController.dateValue("2026-07-29")).isEqualTo(LocalDate.of(2026, 7, 29));
        for (Object falsch : new Object[] {"29.07.2026", "2026/07/29", "nicht-datum", ""}) {
            assertThatThrownBy(() -> SiteSupplyPriceController.dateValue(falsch))
                    .as(String.valueOf(falsch))
                    .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                        assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                        assertThat(e.getReason()).contains("JJJJ-MM-TT");
                    });
        }
    }
}
