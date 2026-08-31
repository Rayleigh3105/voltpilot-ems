package com.voltpilot.api.verbraucher;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.SiteChargingDto.ChargingBudgetDto;
import com.voltpilot.api.web.dto.VerbraucherDto.Rahmen;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** §4.2: der Rahmen ist eine AUSWAHL aus dem Budget-Block, keine neue Zahl. */
class LadeparkRahmenTest {

    private static ChargingBudgetDto budget(Double gridLimitKw, Double allocatedKw,
            Double maxHouseLoadKw) {
        return new ChargingBudgetDto(UUID.randomUUID(), true, true, null, gridLimitKw, 10.0, 4.2,
                27.0, allocatedKw, null, null, 5.0, null, "gemessen", "Ihr Anschluss ist geschützt.",
                false, 30.0, null, null, null, null, maxHouseLoadKw, 4, "sonne_zuerst",
                "speicher_vor_auto", true, null, null, null, false, null, null, null, 8887, "/ocpp",
                Instant.parse("2026-08-31T10:00:00Z"));
    }

    @Test
    void jedeZahlKommtAusDemBudgetBlockDerBox() {
        Rahmen r = LadeparkRahmen.aus(budget(32.0, 22.0, 5.0), 32.0);
        assertThat(r.netzanschlussKw()).isEqualTo(32.0);
        assertThat(r.gepflegteGrenzeKw()).isEqualTo(32.0);
        assertThat(r.effektivGrenzeKw()).isEqualTo(30.0);
        assertThat(r.verteiltKw()).isEqualTo(22.0);
        assertThat(r.hausLastKw()).isEqualTo(5.0);
        assertThat(r.hoechsteHausLastKw()).isEqualTo(5.0);
        assertThat(r.sicherheitsabstandPct()).isEqualTo(10.0);
        assertThat(r.mindestleistungKw()).isEqualTo(4.2);
        assertThat(r.modus()).isEqualTo("gemessen");
        // ⚠ Der Satz der Box, woertlich - nie neu formuliert.
        assertThat(r.hinweis()).isEqualTo("Ihr Anschluss ist geschützt.");
        assertThat(r.steckerAnzahl()).isEqualTo(4);
        assertThat(r.gemeldetAm()).isEqualTo(Instant.parse("2026-08-31T10:00:00Z"));
    }

    @Test
    void eineNichtGemessenesZahlBleibtNull_nieEine0() {
        Rahmen r = LadeparkRahmen.aus(budget(null, null, null), null);
        assertThat(r.netzanschlussKw()).isNull();
        assertThat(r.verteiltKw()).isNull();
        assertThat(r.hoechsteHausLastKw()).isNull();
        assertThat(r.gepflegteGrenzeKw()).isNull();
    }

    @Test
    void ohneJedeMeldungUndOhneGepflegteGrenzeGibtEsKeinenRahmen() {
        assertThat(LadeparkRahmen.aus(null, null)).isNull();
    }

    @Test
    void einePortalGrenzeOhneMeldungTraegtGenauDieseEineZahl() {
        Rahmen r = LadeparkRahmen.aus(null, 32.0);
        assertThat(r).isNotNull();
        assertThat(r.gepflegteGrenzeKw()).isEqualTo(32.0);
        assertThat(r.netzanschlussKw()).isNull();
        assertThat(r.verteiltKw()).isNull();
        assertThat(r.steckerAnzahl()).isZero();
    }
}
