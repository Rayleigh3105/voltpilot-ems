package com.voltpilot.api.direktvermarktung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.tenant.TenantContext;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Der Nachtlauf über alle Mandanten (Muster {@link com.voltpilot.api.unterstuetzung.AblaufLaeufer}): ein
 * gescheiterter Mandant darf den nächsten nicht verhindern, und {@link TenantContext} steht während des
 * Dienst-Aufrufs auf genau diesem Mandanten.
 */
class DirektvermarktungNachtlaufTest {

    @Test
    void jederMandantBekommtSeinenEigenenTenantContextUndEinGescheiterterStopptDieAnderenNicht() {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        UUID c = UUID.randomUUID();
        JdbcTemplate adminJdbc = mock(JdbcTemplate.class);
        when(adminJdbc.queryForList(org.mockito.ArgumentMatchers.anyString(), eq(UUID.class)))
                .thenReturn(List.of(a, b, c));
        DirektvermarktungService dienst = mock(DirektvermarktungService.class);
        List<UUID> gesehen = new java.util.ArrayList<>();
        org.mockito.Mockito.doAnswer(inv -> {
            UUID aktuell = TenantContext.get();
            gesehen.add(aktuell);
            if (aktuell.equals(b)) throw new RuntimeException("Mandant b ist kaputt");
            return null;
        }).when(dienst).naechtlicheUebergaenge(any());

        DirektvermarktungNachtlauf laeufer = new DirektvermarktungNachtlauf(adminJdbc, dienst,
                java.time.Clock.systemUTC());
        laeufer.lauf(LocalDate.of(2026, 11, 30));

        assertThat(gesehen).containsExactly(a, b, c);
        assertThat(TenantContext.get()).isNull();
        verify(dienst, org.mockito.Mockito.times(3)).naechtlicheUebergaenge(LocalDate.of(2026, 11, 30));
    }

    @Test
    void laesstBeendeteKundenbereicheAus() {
        UUID aktiv = UUID.randomUUID();
        UUID beendetTenant = UUID.randomUUID();
        JdbcTemplate adminJdbc = mock(JdbcTemplate.class);
        when(adminJdbc.queryForList(org.mockito.ArgumentMatchers.anyString(), eq(UUID.class)))
                .thenReturn(List.of(aktiv, beendetTenant));
        DirektvermarktungService dienst = mock(DirektvermarktungService.class);

        DirektvermarktungNachtlauf laeufer = new DirektvermarktungNachtlauf(adminJdbc, dienst,
                java.time.Clock.systemUTC());
        laeufer.setBeendeteKundenbereiche(new BeendeteKundenbereiche(() -> Set.of(beendetTenant),
                java.time.Clock.systemUTC(), null));

        laeufer.lauf(LocalDate.of(2026, 11, 30));

        verify(dienst).naechtlicheUebergaenge(LocalDate.of(2026, 11, 30));
        assertThat(TenantContext.get()).isNull();
    }
}
