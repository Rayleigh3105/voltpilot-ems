package com.voltpilot.api;

import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Eine Edge-Light-Fassung im Register, wie der Release-Lauf sie hinterlässt:
 * signiertes Manifest (Programm für die Mango, auf Wunsch der Skriptstand),
 * Signatur, und die gepackten Programme geprüft im Portal - für die Tests der
 * Werkstatt, die immer die neueste Fassung nimmt. Alle Prüfsummen sind erfunden.
 */
public final class WerkstattTestFassung {

    /** Das rohe Programm der Mango (linux/mipsle), wie es im Manifest steht. */
    public static final String PROGRAMM_SHA = "1a2b3c4d".repeat(8);
    /** Der Skriptstand edge-light-openwrt.tar.gz, wie er im Manifest steht. */
    public static final String SKRIPTE_SHA = "5e6f7a8b".repeat(8);
    private static final String GZ_SHA = "9c0d1e2f".repeat(8);

    private WerkstattTestFassung() {
    }

    /** Die Fassung mit Skriptstand im Manifest und fertigen Programmen: die Werkstatt nimmt sie. */
    public static void anlegen(JdbcTemplate admin, String fassung, long seq) {
        anlegen(admin, fassung, seq, true, true);
    }

    public static void anlegen(JdbcTemplate admin, String fassung, long seq, boolean mitSkripte, boolean programmeFertig) {
        admin.update("INSERT INTO edge_release (release_seq, version, target_commit, created_by, manifest, signature, "
                + "signing_key_id) VALUES (?, ?, '5b28311b4c0d', 'test', ?, 'test-signatur', 'rel-2026-a')",
                seq, fassung, manifest(fassung, seq, mitSkripte));
        admin.update("INSERT INTO edge_light_programm (release_seq, arch, gz_sha256, gz_size, daten, fertig_am, "
                + "created_by) VALUES (?, 'linux/mipsle', ?, 4, ?, " + (programmeFertig ? "now()" : "NULL")
                + ", 'test')", seq, GZ_SHA, programmeFertig ? new byte[] {1, 2, 3, 4} : new byte[0]);
    }

    /** Das Programm des PFC200 (linux/arm), sein Skriptstand und das Tunnel-Programm, wie sie im Manifest stehen. */
    public static final String INDUSTRIE_PROGRAMM_SHA = "a1b2c3d4".repeat(8);
    public static final String INDUSTRIE_SKRIPTE_SHA = "e5f6a7b8".repeat(8);
    public static final String INDUSTRIE_WARTUNG_SHA = "c9d0e1f2".repeat(8);
    private static final String INDUSTRIE_GZ_SHA = "0a1b2c3d".repeat(8);

    /**
     * Eine Edge-Industrie-Fassung im Register, wie der Lauf
     * edge-industrie-release.yaml sie hinterlässt: Programm für linux/arm,
     * und (mit {@code mitWerkstattDateien}) Skriptstand und Tunnel-Programm
     * im Manifest. Die Werkstatt nimmt sie für den PFC200 nur mit beidem.
     */
    public static void anlegenIndustrie(JdbcTemplate admin, String fassung, long seq, boolean mitWerkstattDateien) {
        admin.update("INSERT INTO edge_release (release_seq, version, target_commit, created_by, manifest, signature, "
                + "signing_key_id) VALUES (?, ?, '5b28311b4c0d', 'test', ?, 'test-signatur', 'rel-2026-a')",
                seq, fassung, manifestIndustrie(fassung, seq, mitWerkstattDateien));
        admin.update("INSERT INTO edge_light_programm (release_seq, arch, gz_sha256, gz_size, daten, fertig_am, "
                + "created_by) VALUES (?, 'linux/arm', ?, 4, ?, now(), 'test')", seq, INDUSTRIE_GZ_SHA,
                new byte[] {1, 2, 3, 4});
    }

    public static String manifestIndustrie(String fassung, long seq, boolean mitWerkstattDateien) {
        return "{\"schema_version\":\"1.0\",\"release\":\"" + fassung + "\",\"release_seq\":" + seq
                + ",\"target_commit\":\"5b28311b4c0d\",\"artifacts\":[{\"type\":\"binary\","
                + "\"name\":\"vp-edge-industrie\",\"arch\":\"linux/arm\",\"sha256\":\"" + INDUSTRIE_PROGRAMM_SHA
                + "\",\"size\":100,\"gz_sha256\":\"" + INDUSTRIE_GZ_SHA + "\",\"gz_size\":4}],\"min_from_seq\":0,"
                + "\"allow_downgrade\":false,\"state_schema\":1,\"compat\":{\"backends\":[\"industrie\"]},"
                + "\"signing_key_id\":\"rel-2026-a\""
                + (mitWerkstattDateien ? ",\"skripte\":{\"name\":\"edge-industrie-skripte.tar.gz\",\"sha256\":\""
                        + INDUSTRIE_SKRIPTE_SHA + "\",\"size\":22547},\"wartung\":{\"name\":\"vp-wartung-linux-arm\","
                        + "\"sha256\":\"" + INDUSTRIE_WARTUNG_SHA + "\",\"size\":9961634}" : "")
                + "}";
    }

    public static String manifest(String fassung, long seq, boolean mitSkripte) {
        return "{\"schema_version\":\"1.0\",\"release\":\"" + fassung + "\",\"release_seq\":" + seq
                + ",\"target_commit\":\"5b28311b4c0d\",\"artifacts\":[{\"type\":\"binary\",\"name\":\"vp-edge-light\","
                + "\"arch\":\"linux/mipsle\",\"sha256\":\"" + PROGRAMM_SHA + "\",\"size\":100,\"gz_sha256\":\""
                + GZ_SHA + "\",\"gz_size\":4}],\"min_from_seq\":0,\"allow_downgrade\":false,\"state_schema\":1,"
                + "\"compat\":{\"backends\":[\"light\"]},\"signing_key_id\":\"rel-2026-a\""
                + (mitSkripte ? ",\"skripte\":{\"name\":\"edge-light-openwrt.tar.gz\",\"sha256\":\"" + SKRIPTE_SHA
                        + "\",\"size\":31744}" : "")
                + "}";
    }
}
