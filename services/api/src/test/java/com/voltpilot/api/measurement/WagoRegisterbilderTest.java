package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.WagoRegisterbilder.Karte;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Die Bildungsregel der {@code registerbilder} (Entscheid firstmate B): nur aus dem Bestand, nie ein
 * erfundener Wert. Die Abfrage selbst prüft {@code WagoRegisterbilderDbTest} gegen die Datenbank.
 */
class WagoRegisterbilderTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final UUID CONTROLLER = UUID.fromString("00000000-0000-0000-0000-00000000c001");
    private static final UUID TEIL_2 = UUID.fromString("00000000-0000-0000-0000-0000000000a2");
    private static final UUID TEIL_3 = UUID.fromString("00000000-0000-0000-0000-0000000000a3");
    private static final UUID KARTE_494 = UUID.fromString("00000000-0000-0000-0000-00000000c494");
    private static final UUID KARTE_495 = UUID.fromString("00000000-0000-0000-0000-00000000c495");
    private static final String VERBINDUNG =
            "{\"ip\":\"10.0.0.5\",\"port\":502,\"base_address\":4096,\"function_code\":\"4\",\"word_order\":\"little\"}";

    private static MeasurementPlan.Entry eintrag(UUID entity, String key) {
        return new MeasurementPlan.Entry(entity, key, 60, null, "x", 90, null, null);
    }

    private static List<Karte> zweiKarten(String verbindung494, String verbindung495) {
        return List.of(new Karte(CONTROLLER, TEIL_2, 2, "750-494/000-001 (5 A)", KARTE_494, verbindung494),
                new Karte(CONTROLLER, TEIL_3, 3, "750-495", KARTE_495, verbindung495));
    }

    @Test
    void einControllerEinRegisterbildAusDemBestandOhneVarianteUndKennung() {
        Map<UUID, Integer> familie = WagoRegisterbilder.familieJeKomponente(
                List.of(eintrag(KARTE_495, "wago.pm495.karte[1].frequency")));
        List<Map<String, Object>> bilder = WagoRegisterbilder.bilde(zweiKarten(VERBINDUNG, VERBINDUNG), familie, JSON);
        assertThat(JSON.valueToTree(bilder).toString()).isEqualTo("[{\"entity_id\":\"" + KARTE_495
                + "\",\"basisadresse\":4096,\"funktionscode\":4,\"wortfolge\":\"little\",\"kartenzahl\":2,"
                + "\"karten\":[{\"steckplatz\":2,\"kartentyp\":494},{\"steckplatz\":3,\"kartentyp\":495}]}]");
    }

    @Test
    void einWiderspruchOderEineLueckeSendetKeinRegisterbild() {
        Map<UUID, Integer> familie = Map.of(KARTE_495, 495);
        // Zwei Karten, zwei Basisadressen: welche gilt, weiß die api nicht.
        assertThat(WagoRegisterbilder.bilde(zweiKarten(VERBINDUNG,
                VERBINDUNG.replace("4096", "0")), familie, JSON)).isEmpty();
        // Ohne Funktionscode keine Lesung (Befund 9: nie ein festes FC 3).
        assertThat(WagoRegisterbilder.bilde(zweiKarten(VERBINDUNG,
                VERBINDUNG.replace(",\"function_code\":\"4\"", "")), familie, JSON)).isEmpty();
        // Kartentyp weder im Plan noch im Freitext: nie raten.
        assertThat(WagoRegisterbilder.bilde(List.of(new Karte(CONTROLLER, TEIL_2, 2, "Energiekarte", null, null),
                new Karte(CONTROLLER, TEIL_3, 3, "750-495", KARTE_495, VERBINDUNG)), familie, JSON)).isEmpty();
        // Plan sagt 494, Freitext 495: Widerspruch.
        assertThat(WagoRegisterbilder.bilde(List.of(new Karte(CONTROLLER, TEIL_3, 3, "750-495", KARTE_495,
                VERBINDUNG)), Map.of(KARTE_495, 494), JSON)).isEmpty();
        // Ohne Steckplatz keine Identität der Karte.
        assertThat(WagoRegisterbilder.bilde(List.of(new Karte(CONTROLLER, TEIL_3, null, "750-495", KARTE_495,
                VERBINDUNG)), familie, JSON)).isEmpty();
    }

    @Test
    void einPlanOhneKartenpunktFragtNichtEinmalDieDatenbank() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        assertThat(new WagoRegisterbilder(jdbc, JSON).fuer(UUID.randomUUID(),
                List.of(eintrag(null, "deye.hybrid_1p.battery.battery"),
                        eintrag(KARTE_494, "deye.hybrid_1p.battery.battery-voltage")))).isEmpty();
        verifyNoInteractions(jdbc);
    }
}
