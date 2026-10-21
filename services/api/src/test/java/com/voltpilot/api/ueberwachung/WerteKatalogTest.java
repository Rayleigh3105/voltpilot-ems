package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
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

    // ----------------------------------------------------------- Scheibe 5 (§6.3, §7 Scheibe 5)

    @Test
    void kenntDenKennzahlLeser() {
        WerteKatalog.Eintrag bezugsbasis = katalog.eintrag("kennzahl.bezugsbasis");
        assertThat(bezugsbasis.leser().art()).isEqualTo("kennzahl");
        assertThat(bezugsbasis.bezug()).isEqualTo("kennzahl");
        assertThat(bezugsbasis.form()).isEqualTo("zahl");
        assertThat(bezugsbasis.bedingungen()).contains("ueber", "unter", "ausserhalb", "keine_daten");

        WerteKatalog.Eintrag kurs = katalog.eintrag("energieziel.kurs");
        assertThat(kurs.leser().art()).isEqualTo("kennzahl");
        assertThat(kurs.bezug()).isEqualTo("energieziel");
        assertThat(kurs.form()).isEqualTo("zustand");
        assertThat(kurs.zustaende()).containsExactly("noch_keine_aussage", "auf_kurs", "knapp_dahinter",
                "nicht_auf_kurs");
        assertThat(kurs.bedingungen()).containsExactly("zustand");
    }

    @Test
    void kenntDenZaehlungLeser() {
        WerteKatalog.Eintrag menge = katalog.eintrag("messstelle.menge");
        assertThat(menge.leser().art()).isEqualTo("zaehlung");
        assertThat(menge.bezug()).isEqualTo("messstelle");
        assertThat(menge.bedingungen()).contains("periode", "aenderung");

        WerteKatalog.Eintrag beobachtung = katalog.eintrag("messstelle.beobachtung");
        assertThat(beobachtung.leser().art()).isEqualTo("zaehlung");
        assertThat(beobachtung.zustaende()).containsExactly("liefert", "liefert_nicht_seit",
                "wartet_auf_erste_daten", "keine_datenquelle");

        WerteKatalog.Eintrag monat = katalog.eintrag("messstelle.monat_unvollstaendig");
        assertThat(monat.leser().art()).isEqualTo("zaehlung");
        assertThat(monat.zustaende()).containsExactly("vollstaendig", "unvollstaendig");
    }

    @Test
    void entscheid9aKeinScheibe5EintragHatEinenVorschlagAbWerk() {
        // 9A: kein Läufer legt ab Werk eine Überwachung auf Energiemanagement-Zahlen an - nur
        // eine selbst angelegte. mitVorschlagAbWerk() bleibt darum unverändert bei den zwei
        // Scheibe-1-Einträgen (siehe nurDieBeidenAbWerkEintraegeHabenEinenVorschlag oben).
        for (String wertart : List.of("kennzahl.bezugsbasis", "energieziel.kurs", "messstelle.menge",
                "messstelle.beobachtung", "messstelle.monat_unvollstaendig")) {
            assertThat(katalog.eintrag(wertart).vorschlag()).as(wertart).isNull();
        }
        assertThat(katalog.mitVorschlagAbWerk()).extracting(WerteKatalog.Eintrag::wertart)
                .containsExactlyInAnyOrder("box.erreichbar", "datenquelle.liefert_daten");
    }

    @Test
    void dieErzeugerVorlagenHabenStabileKennungenUndWerdenNieGesaet() {
        // EZ-11: die Wertart IST die Kennung, unter der EZ-15 (Anlege-Schritt) die Vorlagen anbietet - umbenennen
        // bricht gespeicherte Regeln und den Anlege-Schritt.
        assertThat(katalog.vorlagen()).extracting(WerteKatalog.Eintrag::wertart).containsExactly(
                "erzeuger.fernsteuerung_nicht_bereit", "erzeuger.daten_veraltet", "erzeuger.anlage_folgt_nicht",
                "erzeuger.netzbetreiber_abgeschaltet", "erzeuger.fernwirk_verbindung_weg",
                "erzeuger.programmstand_veraltet");
        for (WerteKatalog.Eintrag e : katalog.vorlagen()) {
            assertThat(e.leser().art()).as(e.wertart()).isEqualTo("erzeuger");
            assertThat(e.vorschlag()).as(e.wertart() + ": nie ab Werk gesät").isNull();
            assertThat(e.vorlage().nurMitAnlagensteuerung()).as(e.wertart()).isTrue();
            assertThat(e.zustaende()).as(e.wertart()).containsAll(e.vorlage().ziel());
            assertThat(e.bedingungen()).as(e.wertart()).containsExactly("zustand");
        }
        WerteKatalog.Vorlage folgt = katalog.eintrag("erzeuger.anlage_folgt_nicht").vorlage();
        assertThat(folgt.schwellen()).containsEntry("toleranz_prozent", 5.0).containsEntry("toleranz_kw", 5.0);
        assertThat(folgt.dauerS()).isEqualTo(300);
        assertThat(katalog.eintrag("erzeuger.fernwirk_verbindung_weg").vorlage().dauerS()).isEqualTo(600);
        assertThat(katalog.eintrag("erzeuger.netzbetreiber_abgeschaltet").vorlage().dauerS()).isZero();
        assertThat(katalog.eintrag("erzeuger.programmstand_veraltet").vorlage().dauerS()).isEqualTo(86_400); // EZ-11b: 24 h
    }
}
