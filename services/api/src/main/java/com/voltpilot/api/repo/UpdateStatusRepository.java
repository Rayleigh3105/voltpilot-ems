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
     * <p><b>Zwei Zeitpunkte entstehen hier</b> (Geräte &amp; Updates G2):
     * {@code target_verdict_at} (seit wann das gemeldete Prüfurteil zum gemeldeten
     * Ziel gilt - „angenommen") und {@code current_since} (seit wann der laufende
     * Stempel gilt - „bestätigt"). Beide setzt nur ein beobachteter WECHSEL, mit
     * der Serveruhr; die erste Meldung einer Box lässt sie leer, denn sie sagt
     * nicht, seit wann.
     *
     * <p>Jedes Feld außer {@code reportedAt} darf {@code null} sein: in Stufe 0
     * kennt das Gerät weder Register noch Ziel, und was es nicht weiß, meldet es
     * GAR NICHT - hier bleibt es dann leer, nie eine geratene Version oder eine
     * erfundene Sequenznummer.
     */
    public void upsert(UUID deviceId, UUID siteId, String version, String backend,
            String currentVersion, Long currentSeq, String targetVersion, Long targetSeq,
            String state, String reason, String lastKnownGood,
            String targetVerdict, String blocker, String rootKeyIds, String trustSetKeyIds,
            String trustSetGeneratedAt, String trustSetSignedBy, String trustSetError,
            Instant reportedAt) {
        jdbc.update(
                "INSERT INTO device_update_status (device_id, tenant_id, site_id, version, "
                        + "backend, current_version, current_seq, target_version, target_seq, "
                        + "state, reason, last_known_good, target_verdict, blocker, "
                        + "root_key_ids, trust_set_key_ids, trust_set_generated_at, "
                        + "trust_set_signed_by, trust_set_error, reported_at, "
                        + "updated_at) "
                        + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, "
                        + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now()) "
                        + "ON CONFLICT (device_id) DO UPDATE SET site_id = EXCLUDED.site_id, "
                        + "version = EXCLUDED.version, backend = EXCLUDED.backend, "
                        + "current_version = EXCLUDED.current_version, "
                        + "current_seq = EXCLUDED.current_seq, "
                        + "target_version = EXCLUDED.target_version, "
                        + "target_seq = EXCLUDED.target_seq, "
                        + "state = EXCLUDED.state, reason = EXCLUDED.reason, "
                        + "last_known_good = EXCLUDED.last_known_good, "
                        + "target_verdict = EXCLUDED.target_verdict, "
                        + "blocker = EXCLUDED.blocker, "
                        + "root_key_ids = EXCLUDED.root_key_ids, "
                        + "trust_set_key_ids = EXCLUDED.trust_set_key_ids, "
                        + "trust_set_generated_at = EXCLUDED.trust_set_generated_at, "
                        + "trust_set_signed_by = EXCLUDED.trust_set_signed_by, "
                        + "trust_set_error = EXCLUDED.trust_set_error, "
                        // Geräte & Updates G2 (V20261105210000): die Zeitpunkte
                        // „angenommen" und „läuft seit" entstehen beim WECHSEL,
                        // mit der Serveruhr (eine Uhr für die ganze Seite). Bleibt
                        // der Wert gleich, bleibt der Zeitpunkt; ohne beobachteten
                        // Wechsel bleibt er unbekannt (NULL) statt erfunden.
                        + "target_verdict_at = CASE WHEN EXCLUDED.target_verdict IS NULL THEN NULL "
                        + "WHEN device_update_status.target_verdict IS DISTINCT FROM EXCLUDED.target_verdict "
                        + "OR device_update_status.target_version IS DISTINCT FROM EXCLUDED.target_version "
                        + "THEN now() ELSE device_update_status.target_verdict_at END, "
                        + "current_since = CASE WHEN COALESCE(EXCLUDED.current_version, EXCLUDED.version) "
                        + "IS NOT NULL AND COALESCE(EXCLUDED.current_version, EXCLUDED.version) "
                        + "IS DISTINCT FROM COALESCE(device_update_status.current_version, "
                        + "device_update_status.version) THEN now() "
                        + "ELSE device_update_status.current_since END, "
                        + "reported_at = EXCLUDED.reported_at, updated_at = now()",
                deviceId, siteId, version, backend, currentVersion, currentSeq, targetVersion,
                targetSeq, state, reason, lastKnownGood, targetVerdict, blocker,
                rootKeyIds, trustSetKeyIds, trustSetGeneratedAt, trustSetSignedBy, trustSetError,
                Timestamp.from(reportedAt));
    }

    /**
     * Die Geräte-Angabe einer Box festhalten ({@code update.geraet}, Geräte &amp;
     * Updates G8) - nur gerufen, wenn der Herzschlag den Block trägt; sonst
     * bleibt die zuletzt gemeldete Angabe stehen. Nach {@link #upsert} im selben
     * Mandanten (RLS), die Zeile besteht also.
     */
    public void geraet(UUID deviceId, String modell, String arch, String loader, Integer loaderStand) {
        jdbc.update("UPDATE device_update_status SET geraet_modell = ?, geraet_arch = ?, loader = ?, "
                + "loader_stand = ? WHERE device_id = ?", modell, arch, loader, loaderStand, deviceId);
    }

    // Bewusst NUR ein Schreibpfad: gelesen wird der Stand cross-tenant im
    // Flotten-Aggregat (AdminFleetRepository.updateStatusPerSite) - eine zweite
    // Lese-Methode ohne Aufrufer wäre toter Code, der aussieht wie ein Vertrag.

    /**
     * Die Box-Art aus der letzten Meldung dieses Geraets ({@link com.voltpilot.api.ota.BoxArt}):
     * {@code light}, {@code docker} oder {@code null} = unbekannt (nie gemeldet). Liest unter RLS.
     */
    public String boxArt(UUID deviceId) {
        if (deviceId == null) return null;
        return jdbc.query("SELECT backend, version, current_version FROM device_update_status WHERE device_id = ?",
                rs -> rs.next()
                        ? com.voltpilot.api.ota.BoxArt.ofDevice(rs.getString("backend"), rs.getString("version"),
                                rs.getString("current_version"))
                        : null,
                deviceId);
    }
}
