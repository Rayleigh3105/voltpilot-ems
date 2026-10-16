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
    void eineFehlendeWertartLiefertNullStattEinerAusnahme() {
        // Ein unvollständiger Anfragekörper (z. B. "{}") liefert hier null statt
        // NullPointerException - UeberwachungAnlegenService.anlegen macht daraus den sauberen
        // 400 "unbekannte Wertart" wie für jeden anderen unbekannten Schlüssel.
        assertThat(katalog.eintrag(null)).isNull();
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

    // ----------------------------------------------------------- Scheibe 2 (§6.3, §7 Scheibe 2)

    @Test
    void kenntDieAnlagenflussWertartenMitIhrenLesefeldern() {
        record Erwartet(String wertart, String feld) {}
        for (Erwartet e : java.util.List.of(
                new Erwartet("anlage.netz.leistung", "netz"),
                new Erwartet("anlage.pv.leistung", "pv"),
                new Erwartet("anlage.speicher.leistung", "speicher_leistung"),
                new Erwartet("anlage.speicher.ladestand", "speicher_ladestand"),
                new Erwartet("anlage.verbrauch.leistung", "verbrauch"),
                new Erwartet("anlage.ladepunkte.leistung", "ladepunkte"),
                new Erwartet("anlage.preis.jetzt", "preis"))) {
            WerteKatalog.Eintrag eintrag = katalog.eintrag(e.wertart());
            assertThat(eintrag).as(e.wertart()).isNotNull();
            assertThat(eintrag.leser().art()).as(e.wertart()).isEqualTo("anlagenfluss");
            assertThat(eintrag.leser().feld()).as(e.wertart()).isEqualTo(e.feld());
            assertThat(eintrag.bezug()).as(e.wertart()).isEqualTo("anlage");
            assertThat(eintrag.form()).as(e.wertart()).isEqualTo("zahl");
            assertThat(eintrag.bedingungen()).as(e.wertart()).contains("ueber", "unter");
        }
    }

    @Test
    void dieMessreiheFamilieDecktJedenGemessenenKanalOhneSondercodeAb() {
        WerteKatalog.Eintrag eintrag = katalog.eintrag("geraet.messwert");
        assertThat(eintrag.leser().art()).isEqualTo("messreihe");
        assertThat(eintrag.bezug()).isEqualTo("komponente");
        assertThat(eintrag.bedingungen()).contains("ueber", "unter", "ausserhalb", "keine_daten");
        // Kein Vorschlag ab Werk für die Familie - der Preis-Hinweis sät sich separat (15C).
        assertThat(eintrag.vorschlag()).isNull();
    }

    @Test
    void derPreisEintragHatKeinenGenerischenVorschlagDieAussaatLaeuftSeparat() {
        // 15C: der Preis-Hinweis wird ab Werk gesät, aber NICHT über WerteKatalog.mitVorschlagAbWerk()
        // (dessen Vorgaben-Modell kennt nur Ziel-Zustände, keine Zahl) - siehe UeberwachungsService.
        assertThat(katalog.eintrag("anlage.preis.jetzt").vorschlag()).isNull();
        assertThat(katalog.mitVorschlagAbWerk()).extracting(WerteKatalog.Eintrag::wertart)
                .doesNotContain("anlage.preis.jetzt");
    }
}
