package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der von der Edge gemeldete Software-Stand und Update-Zustand je Gerät
 * (Tabelle {@code device_update_status}, Migration V20260803010000; OTA
 * Stufe 0).
 *
 * <p>Genau EINE Zeile je Gerät, bei jedem Herzschlag ERSETZT - der Block trägt
 * den vollständigen Ist, ein Upsert ist deshalb richtig (keine Historie:
 * „welche Version läuft JETZT" ist die einzige Frage dieser Stufe).
 *
 * <p>Geschrieben wird über die RLS-gefencte App-Rolle unter dem Mandanten des
 * Topics; {@code tenant_id} kommt aus der RLS-Sitzung, nie aus dem Aufruf -
 * eine fremde Mandanten-Id wäre schon vom {@code WITH CHECK} der Policy
 * abgewiesen. Das ist dieselbe Haltung wie bei {@link EdgeVersionRepository}
 * und {@link CurtailmentStatusRepository}.
 */
@Repository
public class UpdateStatusRepository {

    private final JdbcTemplate jdbc;

    public UpdateStatusRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Den gemeldeten Stand eines Geräts festhalten (Upsert je Gerät).
     *
     * <p>Jedes Feld außer {@code reportedAt} darf {@code null} sein: in Stufe 0
     * kennt das Gerät weder Register noch Ziel, und was es nicht weiß, meldet es
     * GAR NICHT - hier bleibt es dann leer, nie eine geratene Version oder eine
     * erfundene Sequenznummer.
     */
    public void upsert(UUID deviceId, UUID siteId, String version, String backend,
            String currentVersion, Long currentSeq, String targetVersion, Long targetSeq,
            String channel, String state, String reason, String lastKnownGood,
            String targetVerdict, Instant reportedAt) {
        jdbc.update(
                "INSERT INTO device_update_status (device_id, tenant_id, site_id, version, "
                        + "backend, current_version, current_seq, target_version, target_seq, "
                        + "channel, state, reason, last_known_good, target_verdict, "
                        + "reported_at, updated_at) "
                        + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, "
                        + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now()) "
                        + "ON CONFLICT (device_id) DO UPDATE SET site_id = EXCLUDED.site_id, "
                        + "version = EXCLUDED.version, backend = EXCLUDED.backend, "
                        + "current_version = EXCLUDED.current_version, "
                        + "current_seq = EXCLUDED.current_seq, "
                        + "target_version = EXCLUDED.target_version, "
                        + "target_seq = EXCLUDED.target_seq, channel = EXCLUDED.channel, "
                        + "state = EXCLUDED.state, reason = EXCLUDED.reason, "
                        + "last_known_good = EXCLUDED.last_known_good, "
                        + "target_verdict = EXCLUDED.target_verdict, "
                        + "reported_at = EXCLUDED.reported_at, updated_at = now()",
                deviceId, siteId, version, backend, currentVersion, currentSeq, targetVersion,
                targetSeq, channel, state, reason, lastKnownGood, targetVerdict,
                Timestamp.from(reportedAt));
    }

    // Bewusst NUR ein Schreibpfad: gelesen wird der Stand cross-tenant im
    // Flotten-Aggregat (AdminFleetRepository.updateStatusPerSite) - eine zweite
    // Lese-Methode ohne Aufrufer wäre toter Code, der aussieht wie ein Vertrag.
}
