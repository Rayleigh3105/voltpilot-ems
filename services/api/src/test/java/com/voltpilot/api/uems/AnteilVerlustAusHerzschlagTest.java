package com.voltpilot.api.uems;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Der Empfang des Anteils-Verlusts aus dem Herzschlag-Block (UEMS AP-15 IP-22), ohne Datenbank. */
class AnteilVerlustAusHerzschlagTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID T = UUID.randomUUID();
    private static final UUID S = UUID.randomUUID();
    private static final UUID D = UUID.randomUUID();

    private AnteilVerlustRepository repo;
    private AnteilVerlustAusHerzschlag empfang;

    @BeforeEach
    void setUp() {
        repo = mock(AnteilVerlustRepository.class);
        empfang = new AnteilVerlustAusHerzschlag(repo);
        // 17.06.2026, 14:00 in Berlin
        empfang.uhrStellen(Clock.fixed(Instant.parse("2026-06-17T12:00:00Z"), ZoneOffset.UTC));
    }

    private static JsonNode block(String json) throws Exception {
        return MAPPER.readTree(json);
    }

    @Test
    void heuteUndVortagWerdenGemeldet() throws Exception {
        empfang.merke(T, S, D, block("{\"anteile_revision\":8,\"anteil_verlust\":{\"tag\":\"2026-06-17\","
                + "\"kwh\":160.2,\"gebunden_s\":32810,\"vortag\":{\"tag\":\"2026-06-16\",\"kwh\":0,\"gebunden_s\":0}}}"));
        verify(repo).melde(T, S, D, LocalDate.parse("2026-06-17"), new BigDecimal("160.2"), 32810);
        verify(repo).melde(T, S, D, LocalDate.parse("2026-06-16"), new BigDecimal("0"), 0);
    }

    @Test
    void ohneFeldOhneBlockKeineZeile() throws Exception {
        empfang.merke(T, S, D, block("{\"plan_id\":\"p-1\",\"anteile_revision\":8}"));
        empfang.merke(T, S, D, null);
        verifyNoInteractions(repo);
    }

    @Test
    void unlesbaresWirdUeberlesenUnbekanntIstKeineNull() throws Exception {
        for (String v : new String[] {
                "{\"tag\":\"2026-06-17\",\"kwh\":-1,\"gebunden_s\":10}",
                "{\"tag\":\"2026-06-17\",\"kwh\":\"1.0\",\"gebunden_s\":10}",
                "{\"tag\":\"2026-06-17\",\"kwh\":1.0,\"gebunden_s\":10.5}",
                "{\"tag\":\"2026-06-17\",\"kwh\":1.0,\"gebunden_s\":90001}",
                "{\"tag\":\"2026-06-17\",\"kwh\":1.0}",
                "{\"tag\":\"17.06.2026\",\"kwh\":1.0,\"gebunden_s\":10}",
                // Uhr der Box falsch: vorgestern und übermorgen
                "{\"tag\":\"2026-06-15\",\"kwh\":1.0,\"gebunden_s\":10}",
                "{\"tag\":\"2026-06-19\",\"kwh\":1.0,\"gebunden_s\":10}"}) {
            empfang.merke(T, S, D, block("{\"anteil_verlust\":" + v + "}"));
        }
        verify(repo, never()).melde(any(), any(), any(), any(), any(), org.mockito.ArgumentMatchers.anyInt());
    }
}
