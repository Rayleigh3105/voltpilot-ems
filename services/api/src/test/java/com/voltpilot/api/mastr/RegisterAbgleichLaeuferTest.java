package com.voltpilot.api.mastr;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.RegisterEinheitRepository;
import com.voltpilot.api.repo.RegisterEinheitRepository.FaelligeEinheit;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The Hintergrund-Abgleich's per-unit logic (S2, Abschnitt 5.4): a fresh
 * register read never touches the confirmed layer, and a sibling is
 * suggested ONLY when it is not already known at the site - "einmal
 * vorschlagen" (E5) means the repository's {@code ON CONFLICT DO NOTHING}
 * does the real de-dup; this test pins the service-side half (never even
 * trying to suggest an already-known number).
 */
class RegisterAbgleichLaeuferTest {

    private static final UUID TENANT = UUID.randomUUID();
    private static final UUID SITE = UUID.randomUUID();
    private static final String ANCHOR = "SEE966831669444";
    private static final String SIBLING = "SEE912345678901";
    private static final String LOCATION = "SEL926735321862";

    private final RegisterEinheitRepository repo = Mockito.mock(RegisterEinheitRepository.class);
    private final JdbcTemplate adminJdbc = Mockito.mock(JdbcTemplate.class);

    @Test
    void rereadsTheRegisterLayerAndSuggestsAnUnknownSibling() throws Exception {
        MastrUnit anchor = solar(ANCHOR, LOCATION);
        MastrUnit sibling = solar(SIBLING, LOCATION);
        PlantRegistryClient registry = fakeRegistry(anchor, List.of(anchor, sibling));
        when(repo.knownUnitNumbers(SITE)).thenReturn(List.of(ANCHOR));
        when(repo.suggestUnit(any(), any(), any(), any(), any(), any(), any(), any())).thenReturn(true);
        RegisterAbgleichLaeufer laeufer = new RegisterAbgleichLaeufer(adminJdbc, repo, registry);

        int vorgeschlagen = laeufer.einheit(TENANT, new FaelligeEinheit(SITE, ANCHOR, "pv"), Instant.now());

        assertThat(vorgeschlagen).isEqualTo(1);
        verify(repo).updateRegisterLayer(eq(SITE), eq(ANCHOR), eq(anchor.grossPowerKw()),
                eq(anchor.commissionedOn()), eq(anchor.moduleCount()), any());
        verify(repo).suggestUnit(eq(TENANT), eq(SITE), eq("pv"), eq("mastr"), eq(SIBLING),
                eq(sibling.grossPowerKw()), eq(sibling.commissionedOn()), any());
    }

    @Test
    void neverSuggestsAnAlreadyKnownSibling() throws Exception {
        MastrUnit anchor = solar(ANCHOR, LOCATION);
        MastrUnit sibling = solar(SIBLING, LOCATION);
        PlantRegistryClient registry = fakeRegistry(anchor, List.of(anchor, sibling));
        // The sibling is ALREADY known at this site (confirmed or previously suggested).
        when(repo.knownUnitNumbers(SITE)).thenReturn(List.of(ANCHOR, SIBLING));
        RegisterAbgleichLaeufer laeufer = new RegisterAbgleichLaeufer(adminJdbc, repo, registry);

        int vorgeschlagen = laeufer.einheit(TENANT, new FaelligeEinheit(SITE, ANCHOR, "pv"), Instant.now());

        assertThat(vorgeschlagen).isEqualTo(0);
        verify(repo, never()).suggestUnit(any(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void aUnitWithoutAKnownLokationIsReReadButNeverSearchedForSiblings() throws Exception {
        MastrUnit anchor = solar(ANCHOR, null);
        PlantRegistryClient registry = unitNumber -> anchor;
        RegisterAbgleichLaeufer laeufer = new RegisterAbgleichLaeufer(adminJdbc, repo, registry);

        int vorgeschlagen = laeufer.einheit(TENANT, new FaelligeEinheit(SITE, ANCHOR, "pv"), Instant.now());

        assertThat(vorgeschlagen).isEqualTo(0);
        verify(repo).updateRegisterLayer(eq(SITE), eq(ANCHOR), eq(anchor.grossPowerKw()),
                eq(anchor.commissionedOn()), eq(anchor.moduleCount()), any());
        verify(repo, never()).suggestUnit(any(), any(), any(), any(), any(), any(), any(), any());
    }

    private static PlantRegistryClient fakeRegistry(MastrUnit anchor, List<MastrUnit> atLocation) {
        return new PlantRegistryClient() {
            @Override
            public MastrUnit fetchUnit(String unitNumber) {
                return anchor;
            }

            @Override
            public List<MastrUnit> fetchUnitsAtLocation(String locationNumber) {
                return atLocation;
            }
        };
    }

    private static MastrUnit solar(String unitNumber, String locationNumber) {
        return new MastrUnit(unitNumber, MastrUnit.Kind.SOLAR, "PV", "In Betrieb", "Gebäudesolaranlage",
                new BigDecimal("6.05"), new BigDecimal("6.0"), 13, 699, 809,
                LocalDate.of(2026, 7, 1), null, null, null, "89150", "Laichingen", null,
                locationNumber, "ABR917552830729");
    }
}
