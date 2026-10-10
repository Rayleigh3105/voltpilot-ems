package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Bestandsschutz des Punktzustands (AP-07 IP-18b): ein Wert ohne Komponente schreibt den
 * Punktzustand mit derselben Anweisung wie vorher, Zeichen für Zeichen - sie nennt die neue Spalte
 * {@code component_read_at} nicht und läuft deshalb auch gegen ein Schema ohne sie. Die Kopie
 * unten ist wörtlich aus {@code MeasurementWriteRepository#updatePointState} vor diesem Paket
 * ({@code origin/uems} 486b073b).
 */
class PunktzustandBestandTest {

    private static final String VORHER = "INSERT INTO device_measurement_point_state (tenant_id,site_id,device_id,"
            + "point_key,first_read_at,last_read_at,edge_sequence,raw_numeric,raw_text,"
            + "decoded_numeric,decoded_text,quality,gap,dropped_samples,catalog_version) "
            + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT "
            + "(tenant_id,site_id,device_id,point_key) DO UPDATE SET "
            + "first_read_at=LEAST(device_measurement_point_state.first_read_at,"
            + "EXCLUDED.first_read_at),last_read_at=EXCLUDED.last_read_at,"
            + "edge_sequence=EXCLUDED.edge_sequence,raw_numeric=EXCLUDED.raw_numeric,"
            + "raw_text=EXCLUDED.raw_text,decoded_numeric=EXCLUDED.decoded_numeric,"
            + "decoded_text=EXCLUDED.decoded_text,quality=EXCLUDED.quality,gap=EXCLUDED.gap,"
            + "dropped_samples=EXCLUDED.dropped_samples,catalog_version=EXCLUDED.catalog_version "
            + "WHERE (EXCLUDED.last_read_at,EXCLUDED.edge_sequence) > "
            + "(device_measurement_point_state.last_read_at,"
            + "device_measurement_point_state.edge_sequence)";

    @Test
    void ohneKomponenteIstDieAnweisungDieBisherige() {
        assertThat(MeasurementWriteRepository.punktzustandSql(false)).isEqualTo(VORHER);
    }

    @Test
    void mitKomponenteSetztSieNurDasKennzeichenDazu() {
        String je = MeasurementWriteRepository.punktzustandSql(true);
        assertThat(je.replace(",component_read_at=EXCLUDED.component_read_at", "")
                .replace(",component_read_at)", ")").replace(",?) ON CONFLICT", ") ON CONFLICT"))
                .as("dieselbe Anweisung plus die eine Spalte, dieselbe Bedingung „jüngste gewinnt“")
                .isEqualTo(VORHER);
        assertThat(je.chars().filter(c -> c == '?').count()).isEqualTo(16);
    }
}
