package com.voltpilot.api.cockpit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.profile.AnwendungKatalog;
import com.voltpilot.api.profile.AnwendungKatalog.LayoutDoc;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die FORM-Prüfung eines Layout-Dokuments — rein, ohne Docker und ohne Spring
 * (das {@code Tagesprotokoll}/{@code FleetPflege}-Muster). Die Reise über die
 * echten Routen steht in {@code CockpitLayoutApiTest}.
 *
 * <p>Der wichtigste Fall ist eine NICHT-Ablehnung: ein Baustein, den die Anlage
 * gerade nicht hat, darf nicht abgelehnt werden — sonst überlebte die Präferenz
 * kein Ab- und Wiedereinschalten einer Anwendung, und genau das ist die
 * tragende Regel der Stufe.
 */
class CockpitLayoutServiceTest {

    private final AnwendungKatalog katalog = new AnwendungKatalog(new ObjectMapper());
    private final CockpitLayoutService service = new CockpitLayoutService(null, null, katalog, null, new ObjectMapper(), null);

    private static LayoutDoc doc(List<String> order, List<String> hidden, List<String> shown,
            String lead) {
        return new LayoutDoc(order, hidden, shown, lead);
    }

    @Test
    void einVollstaendigesDokumentGehtDurch() {
        assertThatCode(() -> service.validate(doc(
                List.of("status", "energiefluss", "geld", "kacheln", "komponenten", "zustand"),
                List.of("strompreis"), List.of("fahrplan"), "energiefluss"), "cockpit", null))
                .doesNotThrowAnyException();
    }

    @Test
    void dasLeereDokumentSagtNichtsUndIstDamitGueltig() {
        assertThatCode(() -> service.validate(LayoutDoc.leer(), "cockpit", null)).doesNotThrowAnyException();
    }

    @Test
    void einUnbekannterBausteinIstEineBenannteAblehnung() {
        assertThatThrownBy(() -> service.validate(doc(List.of("gibtsnicht"), List.of(), List.of(),
                null), "cockpit", null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("kein Baustein");
    }

    @Test
    void einPflichtBausteinLaesstSichNichtAusblenden() {
        for (String pflicht : List.of("status", "zustand")) {
            assertThatThrownBy(() -> service.validate(doc(List.of(), List.of(pflicht), List.of(),
                    null), "cockpit", null))
                    .as(pflicht)
                    .isInstanceOf(ResponseStatusException.class)
                    .hasMessageContaining("Grundausstattung");
        }
    }

    @Test
    void einErfundenerLeadWirdNieUebernommen() {
        assertThatThrownBy(() -> service.validate(doc(List.of(), List.of(), List.of(),
                "geraete-automatik"), "cockpit", null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("hervorheben");
    }

    @Test
    void eineDoppelteNennungInDerReihenfolgeIstEinWiderspruch() {
        assertThatThrownBy(() -> service.validate(doc(List.of("kacheln", "kacheln"), List.of(),
                List.of(), null), "cockpit", null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("mehrfach");
    }

    @Test
    void einBausteinDenDieseAnlageGeradeNichtHatWirdAUSDRUECKLICHnichtAbgelehnt() {
        // Der Server weiß nicht (und darf nicht wissen), was die Fläche gerade
        // rendert. Würde er auf momentane Verfügbarkeit prüfen, verlöre der
        // Kunde sein Bild, sobald er eine Anwendung kurz abschaltet.
        assertThatCode(() -> service.validate(doc(List.of("kacheln", "geld"),
                List.of("kacheln", "geld"), List.of(), "erloes-komposition"), "cockpit", null))
                .doesNotThrowAnyException();
    }

    @Test
    void derBausteinKatalogTraegtGenauDieDreiEhrlichkeitsRegeln() {
        var bausteine = katalog.bausteine("cockpit");
        assertThat(bausteine.stream().filter(b -> b.pflicht()).map(b -> b.id()))
                .containsExactly("status", "zustand");
        assertThat(bausteine.stream().filter(b -> !b.beweglich()).map(b -> b.id()))
                .containsExactly("status", "energiefluss", "geld", "steuerung");
        // „Beigesteuert von" ist ABGELEITET aus den Anwendungen, nie eine Liste.
        assertThat(katalog.beigesteuertVon("kacheln"))
                .contains("marktvermarktung", "lastspitzenkappung");
        // ⚠ EIN Block hat EINEN Wohnort: `lade-budget` ist mit der Kachel
        // „Laden" aus den Kennzahlen dorthin gezogen (Konzept
        // `vp-verbraucher-cockpit-k1` §5.1). Stünde er in beiden `bloecke`,
        // renderte er zweimal - und `lastmanagement" erschiene unter zwei
        // Bausteinen.
        assertThat(katalog.beigesteuertVon("laden")).containsExactly("lastmanagement");
        assertThat(katalog.beigesteuertVon("kacheln")).doesNotContain("lastmanagement");
        assertThat(katalog.beigesteuertVon("komponenten")).isEmpty();
        // Das Preset „privat" hebt den Fluss hervor, „gewerbe" sagt nichts.
        assertThat(katalog.presetLayout("privat", "cockpit").lead()).isEqualTo("energiefluss");
        assertThat(katalog.presetLayout("gewerbe", "cockpit").istLeer()).isTrue();
        assertThat(katalog.presetLayout(null, "cockpit").istLeer()).isTrue();
        assertThat(katalog.presetLayout("gibtsnicht", "cockpit").istLeer()).isTrue();
    }

    // -- Stufe 4: die Fläche „portfolio" ------------------------------------

    @Test
    void derPortfolioKatalogTraegtSeineEigenenBausteine() {
        var portfolio = katalog.bausteine("portfolio");
        assertThat(portfolio.stream().map(b -> b.id())).containsExactly("flotten-status",
                "datenlage", "netzbezug-gesamt", "erloese", "speicher", "lastspitzen", "ladepunkte", "pv-jetzt", "erzeugung-heute",
                "verbrauch-heute", "netz-heute", "anlagen");
        // Pflicht sind der Kopf und die Anlagen-Liste: eine Flotten-Fläche ohne
        // ihre Anlagen wäre keine.
        assertThat(portfolio.stream().filter(b -> b.pflicht()).map(b -> b.id()))
                .containsExactly("flotten-status", "anlagen");
        // KEIN Portfolio-Baustein ist lead-fähig - es gibt dort keine Bühne.
        assertThat(portfolio.stream().map(b -> b.leadBlock())).containsOnlyNulls();
    }

    @Test
    void beigesteuertVonKommtImPortfolioDIREKTausDenAnwendungen() {
        // Ein Portfolio-Baustein hat keine Blockschicht unter sich - er IST die
        // Einheit. Deshalb steht sein Schlüssel direkt in bausteine.portfolio.
        assertThat(katalog.beigesteuertVon("speicher")).containsExactly("speicher-fahrplan");
        assertThat(katalog.beigesteuertVon("lastspitzen"))
                .containsExactly("lastspitzenkappung");
        assertThat(katalog.beigesteuertVon("ladepunkte")).containsExactly("lastmanagement");
        // Geld kommt aus ZWEI Anwendungen (Fahrplan-Ersparnis und Markt).
        assertThat(katalog.beigesteuertVon("erloese"))
                .containsExactlyInAnyOrder("speicher-fahrplan", "marktvermarktung");
        assertThat(katalog.beigesteuertVon("flotten-status")).containsExactly("monitoring");
    }

    @Test
    void dasPresetLayoutHaengtAnDerFLAECHE() {
        // Der Cockpit-Lead „energiefluss" ist eine CockpitBlockId, die es im
        // Portfolio gar nicht gibt - ihn dorthin durchzureichen wäre ein
        // Dokument, das die Form-Prüfung zu Recht ablehnt.
        assertThat(katalog.presetLayout("privat", "portfolio").lead()).isNull();
        assertThat(katalog.presetLayout("privat", "portfolio").order())
                .startsWith("flotten-status", "pv-jetzt");
        assertThat(katalog.presetLayout("gewerbe", "portfolio").istLeer()).isTrue();
        assertThat(katalog.presetLayout(null, "portfolio").istLeer()).isTrue();
    }

    @Test
    void einCockpitBausteinGehoertNichtAufDasPortfolioUndUmgekehrt() {
        assertThatThrownBy(() -> service.validate(doc(List.of("kacheln"), List.of(), List.of(),
                null), "portfolio", null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("gehört nicht auf diese Fläche");
        assertThatThrownBy(() -> service.validate(doc(List.of("speicher"), List.of(), List.of(),
                null), "cockpit", null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("gehört nicht auf diese Fläche");
    }

    @Test
    void aufDemPortfolioIstJEDERLeadEineAblehnung() {
        // Es gibt dort keine Bühne, die ein Baustein an sich ziehen könnte -
        // ein gesetzter Lead wäre still wirkungslos statt benannt.
        assertThatThrownBy(() -> service.validate(doc(List.of(), List.of(), List.of(),
                "energiefluss"), "portfolio", null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("hervorheben");
    }

    @Test
    void diePflichtBausteineDesPortfoliosLassenSichNichtAusblenden() {
        for (String pflicht : List.of("flotten-status", "anlagen")) {
            assertThatThrownBy(() -> service.validate(doc(List.of(), List.of(pflicht), List.of(),
                    null), "portfolio", null))
                    .as(pflicht)
                    .isInstanceOf(ResponseStatusException.class)
                    .hasMessageContaining("Grundausstattung");
        }
        assertThatCode(() -> service.validate(doc(List.of("erloese", "speicher"),
                List.of("lastspitzen"), List.of(), null), "portfolio", null))
                .doesNotThrowAnyException();
    }

    // --- Anwendungs-Programm Stufe 5 ---------------------------------------

    private static LayoutDoc mitEigener(List<String> order, EigeneAuswertung.CustomBaustein b) {
        return new LayoutDoc(order, List.of(), List.of(), null,
                b == null ? List.of() : List.of(b));
    }

    private static EigeneAuswertung.CustomBaustein kachel() {
        return new EigeneAuswertung.CustomBaustein("eigen:k1", "Wärmepumpe", "kachel",
                "11111111-1111-1111-1111-111111111111", "power_kw", "jetzt");
    }

    @Test
    void eineEigeneAuswertungGibtEsNurAufDemCockpitEinerAnlage() {
        // Das Portfolio hängt am KUNDEN und hat keine einzelne Komponente,
        // gegen die ein Kanal zu prüfen wäre.
        assertThatThrownBy(() -> service.validate(mitEigener(List.of(), kachel()), "portfolio",
                java.util.UUID.randomUUID()))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("nur auf dem Cockpit");
        // Und ohne Anlage (die kunden-weite Route) ebenso.
        assertThatThrownBy(() -> service.validate(mitEigener(List.of(), kachel()), "cockpit", null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("nur auf dem Cockpit");
    }

    @Test
    void einEigenSchluesselOhneDefinitionIstEineBenannteAblehnung() {
        // Eine Reihenfolge, die eine Kachel nennt, die es nicht gibt, wäre ein
        // Schlüssel, den niemand rendern kann.
        assertThatThrownBy(() -> service.validate(
                mitEigener(List.of("eigen:geist"), null), "cockpit", java.util.UUID.randomUUID()))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("keine eigene Auswertung");
    }

    @Test
    void einDokumentOhneEigeneAuswertungenIstUnveraendert() {
        // Der Bestands-Beweis: kein `custom`, keine neue Ablehnung, und die
        // Prüfung fasst die Entitäts-Repository gar nicht erst an (sie ist hier
        // null - ein Zugriff wäre eine NPE).
        assertThatCode(() -> service.validate(
                doc(List.of("status", "kacheln"), List.of(), List.of(), null), "cockpit",
                java.util.UUID.randomUUID())).doesNotThrowAnyException();
    }
}
