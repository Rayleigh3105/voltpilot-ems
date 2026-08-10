package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.entities.EntityRegistryService.BackfillOutcome;
import com.voltpilot.api.tenant.TenantContext;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Die AUSLÖSE-Politik der automatischen Komposition: sie darf ihrem Aufrufer
 * niemals schaden - weder durch eine geworfene Ausnahme (ein Claim ist ein
 * Betriebsvorgang, ein fehlendes Anlagen-Modell nur ein Anzeige-Mangel) noch
 * durch einen Rollback der laufenden Kundentransaktion.
 */
class EntityAutoComposerTest {

    private final EntityRegistryService entities = mock(EntityRegistryService.class);
    private final EntityAutoComposer composer = new EntityAutoComposer(entities);
    private final UUID site = UUID.randomUUID();

    @AfterEach
    void tearDown() {
        TenantContext.clear();
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    @Test
    void composesImmediatelyWhenNoTransactionIsRunning() {
        when(entities.bootstrapIfEligible(site)).thenReturn(BackfillOutcome.MIGRATED);

        composer.ensureComposed(site);

        verify(entities).bootstrapIfEligible(site);
    }

    /**
     * Der Claim-Pfad: die Komposition passiert VOR der Antwort, damit die
     * Oberfläche direkt danach ein gefülltes Modell liest - nicht erst nach dem
     * nächsten Takt.
     */
    @Test
    void runsUnderTheCallersTenantSoRlsIsTheFence() {
        UUID tenant = UUID.randomUUID();
        TenantContext.set(tenant);
        List<UUID> seenInside = new ArrayList<>();
        when(entities.bootstrapIfEligible(site)).thenAnswer(i -> {
            seenInside.add(TenantContext.get());
            return BackfillOutcome.MIGRATED;
        });

        composer.ensureComposed(site);

        assertThat(seenInside).containsExactly(tenant);
        assertThat(TenantContext.get()).as("der Aufrufer-Kontext bleibt unangetastet")
                .isEqualTo(tenant);
    }

    /**
     * DIE tragende Zusage für den Speicher-Schreibpfad: läuft eine Transaktion,
     * wird erst NACH dem Commit komponiert. Sonst würde eine Ausnahme im
     * Modell-Aufbau die Transaktion als rollback-only markieren und die
     * eigentliche Kundenaktion mitreißen.
     */
    @Test
    void defersToAfterCommitWhileATransactionIsRunning() {
        TransactionSynchronizationManager.initSynchronization();
        try {
            composer.ensureComposed(site);
            verify(entities, never()).bootstrapIfEligible(any());

            TransactionSynchronizationManager.getSynchronizations()
                    .forEach(s -> s.afterCommit());
            verify(entities).bootstrapIfEligible(site);
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    /**
     * Der Mandant wird in die Nach-Commit-Ausführung MITGENOMMEN: sie läuft zwar
     * auf demselben Thread, aber möglicherweise nachdem der Anfrage-Kontext
     * schon aufgeräumt wurde - ohne ihn wäre die Sitzung mandantenlos und RLS
     * würde per Vorgabe ALLES verweigern.
     */
    @Test
    void carriesTheTenantIntoTheAfterCommitCallback() {
        UUID tenant = UUID.randomUUID();
        TenantContext.set(tenant);
        List<UUID> seenInside = new ArrayList<>();
        when(entities.bootstrapIfEligible(site)).thenAnswer(i -> {
            seenInside.add(TenantContext.get());
            return BackfillOutcome.MIGRATED;
        });
        TransactionSynchronizationManager.initSynchronization();
        try {
            composer.ensureComposed(site);
            TenantContext.clear(); // wie nach dem Aufräumen des TenantFilters
            TransactionSynchronizationManager.getSynchronizations()
                    .forEach(s -> s.afterCommit());
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }

        assertThat(seenInside).containsExactly(tenant);
        assertThat(TenantContext.get()).as("danach wieder leer, kein Leck").isNull();
    }

    @Test
    void neverThrowsAtTheCallerWhenTheCompositionFails() {
        when(entities.bootstrapIfEligible(site)).thenThrow(new IllegalStateException("boom"));

        composer.ensureComposed(site); // darf einen Claim nie scheitern lassen

        verify(entities).bootstrapIfEligible(site);
        assertThat(TenantContext.get()).as("Kontext auch nach einem Fehler aufgeräumt").isNull();
    }

    @Test
    void doesNothingWithoutASite() {
        composer.ensureComposed(null);
        verify(entities, never()).bootstrapIfEligible(any());
    }
}
