package com.voltpilot.api.repo;

import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Steuerstand des Speichers je Box ({@code device_battery_control},
 * Migration V20261007120000, Vertrag {@code docs/contracts/speicher-steuerstand.md}):
 * steuert VoltPilot den Speicher oder beobachtet die Box ihn nur?
 *
 * <p>RLS-gebunden an den aktuellen Mandanten wie jede geräteeigene Tabelle. Der
 * Status-Listener schreibt eine Zeile je Box aus dem {@code battery_control}-Block
 * des Herzschlags; gelesen wird sie vom Optimierer (Backend-Rolle) über
 * {@code asset.device_id}.
 */
@Repository
public class BatteryControlRepository {

    /**
     * Ein geprüfter Block. Nur {@link #of} baut ihn - ein Widerspruch zwischen
     * Wort und Flags ergibt keinen Block, denn der Optimierer plant aus dem Wort.
     *
     * @param state          {@code gesteuert | beobachtet | not_aus}
     * @param controlEnabled Steuerschalter UND Freigabe (wie in
     *                       {@code device_control_status})
     * @param certified      Modell-/Gerätefreigabe
     */
    public record State(String state, boolean controlEnabled, boolean certified) {

        public static final String GESTEUERT = "gesteuert";
        public static final String BEOBACHTET = "beobachtet";
        public static final String NOT_AUS = "not_aus";

        /**
         * Der Block nur, wenn Wort und Flags zusammenpassen
         * ({@code speicher-steuerstand-vectors.json}, Abschnitt {@code api}):
         * gesteuert heißt Schalter und Freigabe, beobachtet heißt Schalter ohne
         * Freigabe, Not-Aus heißt kein Schreiben. Sonst leer.
         */
        public static Optional<State> of(String state, boolean controlEnabled, boolean certified) {
            if (state == null) {
                return Optional.empty();
            }
            boolean consistent = switch (state) {
                case GESTEUERT -> controlEnabled && certified;
                case BEOBACHTET -> !controlEnabled && !certified;
                case NOT_AUS -> !controlEnabled;
                default -> false;
            };
            return consistent
                    ? Optional.of(new State(state, controlEnabled, certified))
                    : Optional.empty();
        }
    }

    private final JdbcTemplate jdbc;

    public BatteryControlRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Den Steuerstand einer Box fortschreiben. {@code reported_at} ist die Uhr
     * der Datenbank beim Empfang, nicht die der Box; {@code state_since} bleibt
     * stehen, solange das Wort gleich bleibt. RLS' WITH CHECK legt die Zeile in
     * den Mandanten der Sitzung (der Listener setzt ihn aus dem Topic).
     */
    public void upsert(UUID deviceId, UUID siteId, State state) {
        jdbc.update(
                "INSERT INTO device_battery_control (device_id, tenant_id, site_id, state, "
                        + "control_enabled, certified, state_since, reported_at, updated_at) "
                        + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?, "
                        + "now(), now(), now()) "
                        + "ON CONFLICT (device_id) DO UPDATE SET "
                        + "site_id = EXCLUDED.site_id, "
                        + "state_since = CASE WHEN device_battery_control.state = EXCLUDED.state "
                        + "THEN device_battery_control.state_since ELSE EXCLUDED.state_since END, "
                        + "state = EXCLUDED.state, control_enabled = EXCLUDED.control_enabled, "
                        + "certified = EXCLUDED.certified, reported_at = EXCLUDED.reported_at, "
                        + "updated_at = now()",
                deviceId, siteId, state.state(), state.controlEnabled(), state.certified());
    }
}
