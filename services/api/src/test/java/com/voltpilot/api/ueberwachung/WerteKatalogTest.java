package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Der Werte-Katalog (Alerting Scheibe 1, §6.3): "ONE truth" wie {@code ConsumerSignalCatalog} - rein,
 * ohne Datenbank.
 */
class WerteKatalogTest {

    private final WerteKatalog katalog = new WerteKatalog();

    @Test
    void kenntDieBeidenWertartenDieserScheibe() {
        assertThat(katalog.eintrag("box.erreichbar")).isNotNull();
        assertThat(katalog.eintrag("box.erreichbar").leser().art()).isEqualTo("zustand");
        assertThat(katalog.eintrag("datenquelle.liefert_daten")).isNotNull();
        assertThat(katalog.eintrag("datenquelle.liefert_daten").leser().art()).isEqualTo("zustand");
    }

    @Test
    void kenntDenEreignisLeser() {
        WerteKatalog.Eintrag luecke = katalog.eintrag("box.luecke");
        assertThat(luecke.leser().art()).isEqualTo("ereignis");
        assertThat(luecke.leser().arten()).containsExactly("data_gap");
    }

    @Test
    void einUnbekannterWertartSchluesselLiefertNull() {
        assertThat(katalog.eintrag("nicht_vorhanden")).isNull();
    }

    @Test
    void nurDieBeidenAbWerkEintraegeHabenEinenVorschlag() {
        assertThat(katalog.mitVorschlagAbWerk())
                .extracting(WerteKatalog.Eintrag::wertart)
                .containsExactlyInAnyOrder("box.erreichbar", "datenquelle.liefert_daten");
    }

    @Test
    void dieVorgabenAusEntscheid2AStehenImKatalog() {
        WerteKatalog.Eintrag box = katalog.eintrag("box.erreichbar");
        assertThat(box.vorschlag().dauerS()).isEqualTo(900);
        assertThat(box.vorschlag().schwere()).isEqualTo("warnung");
        assertThat(box.vorschlag().ziel()).containsExactly("nicht_erreichbar");

        WerteKatalog.Eintrag quelle = katalog.eintrag("datenquelle.liefert_daten");
        assertThat(quelle.vorschlag().dauerS()).isEqualTo(3600);
        assertThat(quelle.vorschlag().schwere()).isEqualTo("warnung");
    }
}
