package com.voltpilot.api.preis;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.tenant.TenantContext;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

/**
 * Der 15-Minuten-Takt: cross-tenant Enumeration, Bewertung je Anlage unter
 * gebundenem {@link TenantContext}, ein Slot-Lookup je Zone, und eine Anlage
 * ohne Preis für „jetzt" bekommt NICHTS (die Frische auf der Box macht daraus
 * ehrlich unbekannt, nie eine erfundene Zahl).
 */
class PreisZuleitungTaktTest {

    private static final Instant NOW = Instant.parse("2026-11-14T11:00:10Z");
    private static final UUID TENANT = UUID.randomUUID();
    private static final UUID SITE_DYN = UUID.randomUUID();
    private static final UUID SITE_FEST = UUID.randomUUID();
    private static final UUID BOX = UUID.randomUUID();

    private JdbcTemplate adminJdbc;
    private PreisZuleitung dienst;
    private PreisZuleitungPublisher publisher;
    private PreisZuleitungTakt takt;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        adminJdbc = mock(JdbcTemplate.class);
        dienst = mock(PreisZuleitung.class);
        publisher = mock(PreisZuleitungPublisher.class);
        ObjectProvider<PreisZuleitungPublisher> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(publisher);
        takt = new PreisZuleitungTakt(adminJdbc, dienst, provider);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    void speistBerechtigteAnlagenBindetDenMandantenUndLaesstFestAus() {
        // Zwei Anlagen eines Mandanten: dynamisch (gespeist) und fest (gesperrt).
        stubZeilen(
                zeile(SITE_DYN, TENANT, "DE-LU", "dynamisch"),
                zeile(SITE_FEST, TENANT, "DE-LU", "fest"));
        AtomicReference<UUID> tenantBeimStand = new AtomicReference<>();
        when(dienst.stand(eq(SITE_DYN), eq("DE-LU"), eq("dynamisch"))).thenAnswer(inv -> {
            tenantBeimStand.set(TenantContext.get());
            return new PreisZuleitung.Stand(true, null, BOX);
        });
        when(dienst.stand(eq(SITE_FEST), eq("DE-LU"), eq("fest")))
                .thenReturn(new PreisZuleitung.Stand(false,
                        PreisZuleitung.GRUND_KEIN_DYNAMISCHER_TARIF, null));
        PreisZuleitung.PricePoint slot = new PreisZuleitung.PricePoint(
                Instant.parse("2026-11-14T11:00:00Z"), Instant.parse("2026-11-14T11:15:00Z"), 8.4);
        when(dienst.aktuellerSlot("DE-LU", NOW)).thenReturn(slot);
        when(publisher.publish(TENANT, SITE_DYN, BOX, slot, "DE-LU", NOW)).thenReturn(true);

        PreisZuleitungTakt.TaktErgebnis e = takt.run(NOW);

        assertThat(e.gespeist()).isEqualTo(1);
        assertThat(e.fehlgeschlagen()).isZero();
        assertThat(tenantBeimStand.get()).isEqualTo(TENANT);
        assertThat(TenantContext.get()).as("Kontext nach dem Takt geräumt").isNull();
        verify(publisher, never()).publish(eq(TENANT), eq(SITE_FEST), any(), any(), any(), any());
    }

    @Test
    void ohnePreisFuerJetztWirdNichtsGesendet() {
        stubZeilen(zeile(SITE_DYN, TENANT, "DE-LU", "dynamisch"));
        when(dienst.stand(eq(SITE_DYN), eq("DE-LU"), eq("dynamisch")))
                .thenReturn(new PreisZuleitung.Stand(true, null, BOX));
        when(dienst.aktuellerSlot("DE-LU", NOW)).thenReturn(null);

        PreisZuleitungTakt.TaktErgebnis e = takt.run(NOW);

        assertThat(e.ohnePreis()).isEqualTo(1);
        verify(publisher, never()).publish(any(), any(), any(), any(), any(), any());
    }

    @Test
    void einFehlerJeAnlageBrichtDenTaktNie() {
        UUID site2 = UUID.randomUUID();
        stubZeilen(
                zeile(SITE_DYN, TENANT, "DE-LU", "dynamisch"),
                zeile(site2, TENANT, "DE-LU", "dynamisch"));
        when(dienst.stand(eq(SITE_DYN), any(), any())).thenThrow(new IllegalStateException("kaputt"));
        when(dienst.stand(eq(site2), any(), any()))
                .thenReturn(new PreisZuleitung.Stand(true, null, BOX));
        PreisZuleitung.PricePoint slot = new PreisZuleitung.PricePoint(
                Instant.parse("2026-11-14T11:00:00Z"), Instant.parse("2026-11-14T11:15:00Z"), 8.4);
        when(dienst.aktuellerSlot("DE-LU", NOW)).thenReturn(slot);
        when(publisher.publish(TENANT, site2, BOX, slot, "DE-LU", NOW)).thenReturn(true);

        PreisZuleitungTakt.TaktErgebnis e = takt.run(NOW);

        assertThat(e.fehlgeschlagen()).isEqualTo(1);
        assertThat(e.gespeist()).isEqualTo(1);
        assertThat(TenantContext.get()).isNull();
    }

    // -- Zeilen-Stub: der Takt mappt (id, tenant_id, bidding_zone, tarif_art) --

    private record Row(UUID id, UUID tenant, String zone, String tarifArt) {}

    private static Row zeile(UUID id, UUID tenant, String zone, String tarifArt) {
        return new Row(id, tenant, zone, tarifArt);
    }

    @SuppressWarnings("unchecked")
    private void stubZeilen(Row... rows) {
        when(adminJdbc.query(anyString(), any(RowMapper.class))).thenAnswer(inv -> {
            RowMapper<Object> mapper = inv.getArgument(1);
            java.sql.ResultSet rs = mock(java.sql.ResultSet.class);
            java.util.ArrayList<Object> out = new java.util.ArrayList<>();
            for (int i = 0; i < rows.length; i++) {
                Row r = rows[i];
                when(rs.getObject("id", UUID.class)).thenReturn(r.id());
                when(rs.getObject("tenant_id", UUID.class)).thenReturn(r.tenant());
                when(rs.getString("bidding_zone")).thenReturn(r.zone());
                when(rs.getString("tarif_art")).thenReturn(r.tarifArt());
                out.add(mapper.mapRow(rs, i));
            }
            return List.copyOf(out);
        });
    }
}
