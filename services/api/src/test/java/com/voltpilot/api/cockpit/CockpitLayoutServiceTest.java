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
    private final CockpitLayoutService service = new CockpitLayoutService(null, null, katalog);

    private static LayoutDoc doc(List<String> order, List<String> hidden, List<String> shown,
            String lead) {
        return new LayoutDoc(order, hidden, shown, lead);
    }

    @Test
    void einVollstaendigesDokumentGehtDurch() {
        assertThatCode(() -> service.validate(doc(
                List.of("status", "energiefluss", "geld", "kacheln", "komponenten", "zustand"),
                List.of("strompreis"), List.of("fahrplan"), "energiefluss")))
                .doesNotThrowAnyException();
    }

    @Test
    void dasLeereDokumentSagtNichtsUndIstDamitGueltig() {
        assertThatCode(() -> service.validate(LayoutDoc.leer())).doesNotThrowAnyException();
    }

    @Test
    void einUnbekannterBausteinIstEineBenannteAblehnung() {
        assertThatThrownBy(() -> service.validate(doc(List.of("gibtsnicht"), List.of(), List.of(),
                null)))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("kein Baustein");
    }

    @Test
    void einPflichtBausteinLaesstSichNichtAusblenden() {
        for (String pflicht : List.of("status", "zustand")) {
            assertThatThrownBy(() -> service.validate(doc(List.of(), List.of(pflicht), List.of(),
                    null)))
                    .as(pflicht)
                    .isInstanceOf(ResponseStatusException.class)
                    .hasMessageContaining("Grundausstattung");
        }
    }

    @Test
    void einErfundenerLeadWirdNieUebernommen() {
        assertThatThrownBy(() -> service.validate(doc(List.of(), List.of(), List.of(),
                "geraete-automatik")))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("hervorheben");
    }

    @Test
    void eineDoppelteNennungInDerReihenfolgeIstEinWiderspruch() {
        assertThatThrownBy(() -> service.validate(doc(List.of("kacheln", "kacheln"), List.of(),
                List.of(), null)))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("mehrfach");
    }

    @Test
    void einBausteinDenDieseAnlageGeradeNichtHatWirdAUSDRUECKLICHnichtAbgelehnt() {
        // Der Server weiß nicht (und darf nicht wissen), was die Fläche gerade
        // rendert. Würde er auf momentane Verfügbarkeit prüfen, verlöre der
        // Kunde sein Bild, sobald er eine Anwendung kurz abschaltet.
        assertThatCode(() -> service.validate(doc(List.of("kacheln", "geld"),
                List.of("kacheln", "geld"), List.of(), "erloes-komposition")))
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
                .contains("marktvermarktung", "lastspitzenkappung", "lastmanagement");
        assertThat(katalog.beigesteuertVon("komponenten")).isEmpty();
        // Das Preset „privat" hebt den Fluss hervor, „gewerbe" sagt nichts.
        assertThat(katalog.presetLayout("privat").lead()).isEqualTo("energiefluss");
        assertThat(katalog.presetLayout("gewerbe").istLeer()).isTrue();
        assertThat(katalog.presetLayout(null).istLeer()).isTrue();
        assertThat(katalog.presetLayout("gibtsnicht").istLeer()).isTrue();
    }
}
