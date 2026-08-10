package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.entities.EntityRegistryService.BackfillOutcome;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

/**
 * The four guards of the automatic v1 -> v2 migration (MIG §6), unit-tested
 * against a stubbed registry service - the composition itself is proven against
 * a real database in {@code AdminApiTest}.
 */
class V2SiteBackfillRunnerTest {

    private static final Instant NOW = Instant.parse("2026-07-22T09:00:00Z");

    private final JdbcTemplate adminJdbc = mock(JdbcTemplate.class);
    private final EntityRegistryService entities = mock(EntityRegistryService.class);
    private final EntityRegistryRepository repo = mock(EntityRegistryRepository.class);

    private V2SiteBackfillRunner runner(boolean enabled) {
        return runner(enabled, true);
    }

    private V2SiteBackfillRunner runner(boolean enabled, boolean reconcileEnabled) {
        return new V2SiteBackfillRunner(adminJdbc, entities, repo, enabled, reconcileEnabled,
                Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @SuppressWarnings("unchecked")
    private void pending(V2SiteBackfillRunner.Candidate... candidates) {
        when(adminJdbc.query(any(String.class), any(RowMapper.class)))
                .thenReturn(new ArrayList<>(List.of(candidates)));
    }

    private static V2SiteBackfillRunner.Candidate site(String name) {
        return new V2SiteBackfillRunner.Candidate(UUID.randomUUID(), UUID.randomUUID(), name);
    }

    @Test
    void migratesAnEligibleSiteUnderItsOwnTenantAndStampsTheMarker() {
        V2SiteBackfillRunner.Candidate auernheim = site("Auernheim");
        pending(auernheim);
        List<UUID> tenantSeenInside = new ArrayList<>();
        when(entities.bootstrapIfEligible(auernheim.siteId())).thenAnswer(i -> {
            // The write must run under the site's tenant: RLS is the fence,
            // exactly like an admin using the X-Tenant-Id switcher.
            tenantSeenInside.add(TenantContext.get());
            return BackfillOutcome.MIGRATED;
        });

        V2SiteBackfillRunner.RunSummary summary = runner(true).run();

        assertThat(summary.migrated()).isEqualTo(1);
        assertThat(tenantSeenInside).containsExactly(auernheim.tenantId());
        verify(repo).markV2Backfilled(auernheim.siteId(), NOW);
        assertThat(TenantContext.get()).as("context cleared after the run").isNull();
    }

    @Test
    void skipsADeviceLessSiteWITHOUTMarkingIt_soItIsRetriedAfterAClaim() {
        // MIG §7 (Mienbach): composing entities for a site with no gateway would
        // replace its honest onboarding guide with an empty Energiefluss - and
        // marking it would freeze that decision forever.
        V2SiteBackfillRunner.Candidate mienbach = site("Mienbach");
        pending(mienbach);
        when(entities.bootstrapIfEligible(mienbach.siteId()))
                .thenReturn(BackfillOutcome.SKIPPED_NO_GATEWAY);

        V2SiteBackfillRunner.RunSummary summary = runner(true).run();

        assertThat(summary.skippedNoGateway()).isEqualTo(1);
        assertThat(summary.migrated()).isZero();
        verify(repo, never()).markV2Backfilled(eq(mienbach.siteId()), any());
    }

    @Test
    void marksAnAlreadyV2SiteWithoutComposingAnything() {
        V2SiteBackfillRunner.Candidate site = site("Bereits migriert");
        pending(site);
        when(entities.bootstrapIfEligible(site.siteId())).thenReturn(BackfillOutcome.ALREADY_V2);

        V2SiteBackfillRunner.RunSummary summary = runner(true).run();

        assertThat(summary.alreadyV2()).isEqualTo(1);
        assertThat(summary.migrated()).isZero();
        verify(repo).markV2Backfilled(site.siteId(), NOW);
    }

    @Test
    void aMarkedSiteIsNeverConsideredAgain_soTheRollbackSticks() {
        // The stickiness lives in the query: only NULL markers are candidates.
        // Deleting a migrated site's entities must NOT be undone on the next boot.
        pending();
        runner(true).run();

        ArgumentCaptor<String> sql = ArgumentCaptor.forClass(String.class);
        verify(adminJdbc).query(sql.capture(), any(RowMapper.class));
        assertThat(sql.getValue()).contains("v2_backfilled_at IS NULL");
        verify(entities, never()).bootstrapIfEligible(any());
    }

    @Test
    void oneFailingSiteNeverStopsTheRunAndIsNotMarked() {
        V2SiteBackfillRunner.Candidate broken = site("Kaputt");
        V2SiteBackfillRunner.Candidate healthy = site("Heil");
        pending(broken, healthy);
        when(entities.bootstrapIfEligible(broken.siteId()))
                .thenThrow(new IllegalStateException("boom"));
        when(entities.bootstrapIfEligible(healthy.siteId())).thenReturn(BackfillOutcome.MIGRATED);

        V2SiteBackfillRunner.RunSummary summary = runner(true).run();

        assertThat(summary.failed()).isEqualTo(1);
        assertThat(summary.migrated()).isEqualTo(1);
        verify(repo, never()).markV2Backfilled(eq(broken.siteId()), any());
        verify(repo).markV2Backfilled(healthy.siteId(), NOW);
        assertThat(TenantContext.get()).as("context cleared even after a failure").isNull();
    }

    @Test
    void theOpsKillSwitchDoesNothingAtAll() {
        V2SiteBackfillRunner runner = runner(false);
        runner.onApplicationReady();
        verify(adminJdbc, never()).query(any(String.class), any(RowMapper.class));
        verify(entities, never()).bootstrapIfEligible(any());
    }

    @Test
    void aFailingRunNeverKeepsTheApiFromStarting() {
        when(adminJdbc.query(any(String.class), any(RowMapper.class)))
                .thenThrow(new IllegalStateException("db down at boot"));
        runner(true).onApplicationReady(); // must not throw
    }

    // ---- Der getaktete Abgleich (Selbstheilung ohne Deploy/Klick) -----------

    /**
     * Der Kern des Umbaus: eine Anlage, die NACH dem letzten api-Start ihr
     * Gerät bekam, wartete bis hierher auf den nächsten Deploy. Der Takt fährt
     * denselben Lauf mit denselben Wächtern - also wird sie komponiert und
     * gestempelt, ohne dass jemand etwas tut.
     */
    @Test
    void theTickHealsASiteThatBecameEligibleAfterBootWithoutAnyHumanStep() {
        V2SiteBackfillRunner.Candidate mienbach = site("Mienbach");
        pending(mienbach);
        when(entities.bootstrapIfEligible(mienbach.siteId()))
                .thenReturn(BackfillOutcome.MIGRATED);

        runner(true).reconcile();

        verify(entities).bootstrapIfEligible(mienbach.siteId());
        verify(repo).markV2Backfilled(mienbach.siteId(), NOW);
    }

    /**
     * Der Takt hat einen EIGENEN Schalter, weil {@code @EnableScheduling}
     * global ist: sobald eine fremde Konfiguration (OTA, Metriken) Scheduling
     * einschaltet, liefe diese Methode sonst auch im Testlauf gegen gestoppte
     * Testcontainer.
     */
    @Test
    void theTickRespectsItsOwnSwitchEvenWhileTheFeatureItselfIsOn() {
        pending(site("Egal"));
        runner(true, false).reconcile();
        verify(adminJdbc, never()).query(any(String.class), any(RowMapper.class));
        verify(entities, never()).bootstrapIfEligible(any());
    }

    @Test
    void theOpsKillSwitchAlsoStopsTheTick() {
        pending(site("Egal"));
        runner(false, true).reconcile();
        verify(adminJdbc, never()).query(any(String.class), any(RowMapper.class));
        verify(entities, never()).bootstrapIfEligible(any());
    }

    /**
     * Eine geworfene Ausnahme im Takt würde den Scheduler-Thread beenden - und
     * damit die Selbstheilung LAUTLOS für immer abschalten.
     */
    @Test
    void aFailingTickNeverKillsTheSchedulerThread() {
        when(adminJdbc.query(any(String.class), any(RowMapper.class)))
                .thenThrow(new IllegalStateException("db blip"));
        runner(true).reconcile(); // must not throw
    }
}
