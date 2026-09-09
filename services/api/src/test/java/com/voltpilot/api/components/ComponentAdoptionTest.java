package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.entities.EntityObservedRepository.EdgeLink;
import com.voltpilot.api.entities.EntityObservedRepository.ObservedRow;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die REGELN der Bestands-Übernahme, ohne Datenbank und ohne Container
 * ({@code ComponentAdoption} ist rein - das
 * {@code Tagesprotokoll}/{@code FleetPflege}-Muster).
 *
 * <p>Jeder Fall hier ist eine Regel, deren Fehlen eine belegte Fehlerklasse
 * wäre - nicht eine Zeile Abdeckung.
 */
class ComponentAdoptionTest {

    private static final UUID DEVICE = UUID.randomUUID();

    /** Der Deye der Pilsting-artigen Anlage. */
    private static ObservedRow inverter() {
        return local("inverter", "inverter", null, "Deye SUN-30K", "deye", "sun-30k-sg01hp3",
                new EdgeLink("solarman_v5", "hybrid_3p",
                        "{\"ip\":\"192.168.0.28\",\"port\":8899,\"serial\":\"2985159064\"}",
                        null, null, null));
    }

    /** Einer der beiden Fronius-Erzeuger. */
    private static ObservedRow producer(String id, int unit) {
        return local(id, "source", "pv-generation", "Fronius " + unit, "fronius_sunspec",
                "fronius-eco-27-3-s",
                new EdgeLink("fronius_sunspec", "sunspec_live",
                        "{\"ip\":\"192.168.210.40\",\"port\":502,\"unit_id\":" + unit + "}",
                        30, new BigDecimal("27"), "SEE9668316694" + unit));
    }

    private static ObservedRow local(String id, String kind, String role, String label,
            String brand, String model, EdgeLink link) {
        return new ObservedRow(DEVICE, "local:" + id, "local", kind, null, label, null, "rev-1",
                null, Instant.EPOCH, role, brand, model, link);
    }

    /** Eine Vorlagen-Auflösung, die jede Marke kennt. */
    private static ComponentAdoption.TemplateLookup knowsEverything() {
        return (brand, model) -> Optional.of(template(brand, model));
    }

    private static ComponentTemplateDto template(String brand, String model) {
        return new ComponentTemplateDto("builtin:" + brand + ":" + model, "builtin", 1, brand,
                brand, model, model, null, "inverter", null, "fam", "fam", "comm", "comm", "{}",
                null,
                null, null, 0, "builtin", null, null, null, Instant.EPOCH);
    }

    @Test
    @DisplayName("eine vollständig gemeldete Bestandsanlage ist übernehmbar")
    void aCompleteReportIsAdoptable() {
        ComponentAdoption.Plan plan = ComponentAdoption.decide(ComponentAuthority.BOX,
                List.of(inverter(), producer("src-a", 1), producer("src-b", 2)),
                knowsEverything());

        assertThat(plan.adoptable()).isTrue();
        assertThat(plan.items()).hasSize(3);
        // Der Wechselrichter ist KEINE Quelle - er hat keine Quellen-Kennung.
        assertThat(plan.items().get(0).edgeSourceId()).isNull();
        assertThat(plan.items().get(0).role()).isEqualTo(ComponentService.ROLE_INVERTER);
        assertThat(plan.items().get(0).entityType()).isEqualTo("battery-hybrid");
        // Die Quellen behalten ihre Kennung UND ihre Stammdaten.
        assertThat(plan.items().get(1).edgeSourceId()).isEqualTo("src-a");
        assertThat(plan.items().get(1).intervalS()).isEqualTo(30);
        assertThat(plan.items().get(1).capacityKwp()).isEqualByComparingTo("27");
        assertThat(plan.items().get(1).registryUnitId()).isEqualTo("SEE96683166941");
    }

    @Test
    @DisplayName("ein Bericht OHNE Verbindungsfelder ist ein älterer Box-Stand, kein Fehler")
    void aReportWithoutConnectionsIsNotAdoptable() {
        ObservedRow old = local("inverter", "inverter", null, "Deye", "deye", "sun-30k-sg01hp3",
                null);

        ComponentAdoption.Plan plan =
                ComponentAdoption.decide(ComponentAuthority.BOX, List.of(old), knowsEverything());

        assertThat(plan.verdict()).isEqualTo(ComponentAdoption.Verdict.INCOMPLETE_REPORT);
        assertThat(plan.items()).isEmpty();
        // Der Satz nennt den Weg, nicht nur die Ablehnung.
        assertThat(plan.reason()).contains("aktualisiert");
    }

    @Test
    @DisplayName("EIN unvollständiger Eintrag verhindert die GANZE Übernahme")
    void oneIncompleteEntryRefusesEverything() {
        ObservedRow halfway = local("src-b", "source", "pv-generation", "Fronius 2",
                "fronius_sunspec", "fronius-eco-27-3-s",
                new EdgeLink("fronius_sunspec", "sunspec_live", null, null, null, null));

        ComponentAdoption.Plan plan = ComponentAdoption.decide(ComponentAuthority.BOX,
                List.of(inverter(), producer("src-a", 1), halfway), knowsEverything());

        // Alles oder nichts: der Applier leitet die Quellenliste VOLLSTÄNDIG aus
        // dem Push ab, ein fehlender Eintrag würde ein laufendes Messgerät nicht
        // auslassen, sondern ENTFERNEN.
        assertThat(plan.adoptable()).isFalse();
        assertThat(plan.items()).isEmpty();
    }

    @Test
    @DisplayName("ein unbekanntes Gerät wird nicht übernommen, sondern beim Namen genannt")
    void anUnknownDeviceIsRefusedByName() {
        ComponentAdoption.Plan plan = ComponentAdoption.decide(ComponentAuthority.BOX,
                List.of(inverter()), (brand, model) -> Optional.empty());

        assertThat(plan.verdict()).isEqualTo(ComponentAdoption.Verdict.UNKNOWN_DEVICE);
        assertThat(plan.reason()).contains("Deye SUN-30K");
    }

    @Test
    @DisplayName("eine Rolle ohne eindeutige Geräteart wird nie geraten")
    void anAmbiguousRoleIsNeverGuessed() {
        ObservedRow consumer = local("src-c", "source", "consumer", "Wallbox", "go-e", "goe",
                new EdgeLink("goe_http_api", "goe", "{\"ip\":\"192.168.0.55\"}", null, null,
                        null));

        ComponentAdoption.Plan plan = ComponentAdoption.decide(ComponentAuthority.BOX,
                List.of(inverter(), consumer), knowsEverything());

        // Ein Verbraucher kann Wallbox, Heizstab oder allgemeine Last sein - das
        // ist eine Mensch-Entscheidung (so fragt es der Übernahme-Dialog auch).
        assertThat(plan.verdict()).isEqualTo(ComponentAdoption.Verdict.UNMAPPABLE_ROLE);
        assertThat(plan.reason()).contains("Wallbox");
    }

    @Test
    @DisplayName("zwei gemeldete Wechselrichter sind kein entscheidbares Soll")
    void twoInvertersAreRefused() {
        ComponentAdoption.Plan plan = ComponentAdoption.decide(ComponentAuthority.BOX,
                List.of(inverter(), inverter()), knowsEverything());

        assertThat(plan.verdict()).isEqualTo(ComponentAdoption.Verdict.AMBIGUOUS_INVERTER);
    }

    @Test
    @DisplayName("eine schon portal-verwaltete Anlage wird nicht noch einmal übernommen")
    void anAlreadyPortalManagedPlantIsLeftAlone() {
        ComponentAdoption.Plan plan = ComponentAdoption.decide(ComponentAuthority.PORTAL,
                List.of(inverter()), knowsEverything());

        assertThat(plan.verdict()).isEqualTo(ComponentAdoption.Verdict.ALREADY_PORTAL);
    }

    @Test
    @DisplayName("ohne jeden Bericht wird nichts behauptet")
    void aSilentPlantIsNotAdopted() {
        // Nur Registry-Zeilen, keine local:-Zeile - die Box hat sich zu ihrer
        // Geräte-Einrichtung nie geäußert.
        ObservedRow registryOnly = new ObservedRow(DEVICE, UUID.randomUUID().toString(),
                "registry", "producer", "ok", null, null, "rev-1", null, Instant.EPOCH, null, null,
                null, null);

        ComponentAdoption.Plan plan = ComponentAdoption.decide(ComponentAuthority.BOX,
                List.of(registryOnly), knowsEverything());

        assertThat(plan.verdict()).isEqualTo(ComponentAdoption.Verdict.NO_REPORT);
    }

    @Test
    @DisplayName("eine doppelt gemeldete Quelle wird nicht auf zwei Komponenten gepinnt")
    void aDuplicateSourceIsRefused() {
        ComponentAdoption.Plan plan = ComponentAdoption.decide(ComponentAuthority.BOX,
                List.of(inverter(), producer("src-a", 1), producer("src-a", 1)),
                knowsEverything());

        assertThat(plan.adoptable()).isFalse();
    }

    @Test
    @DisplayName("ein Eintrag mit Transport ABER ohne Verbindung gilt als unvollständig")
    void halfALinkIsNotALink() {
        assertThat(new EdgeLink("solarman_v5", "hybrid_3p", null, null, null, null).complete())
                .isFalse();
        assertThat(new EdgeLink(null, null, "{\"ip\":\"1.2.3.4\"}", null, null, null).complete())
                .isFalse();
        assertThat(new EdgeLink("solarman_v5", "hybrid_3p", "{\"ip\":\"1.2.3.4\"}", null, null,
                null).complete()).isTrue();
    }
}
