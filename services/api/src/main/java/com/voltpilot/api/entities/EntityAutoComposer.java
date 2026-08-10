package com.voltpilot.api.entities;

import com.voltpilot.api.entities.EntityRegistryService.BackfillOutcome;
import com.voltpilot.api.tenant.TenantContext;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * <b>Das Anlagen-Modell füllt sich von selbst.</b> Die Komposition der
 * v2-Entitäten war bis hierher an EINEN Admin-Handgriff gebunden (der
 * platform-admin-gated {@code POST /admin/sites/{id}/v2-entities/bootstrap})
 * plus den einmaligen {@link V2SiteBackfillRunner}-Lauf beim api-Start. Eine
 * Anlage, die NACH dem letzten Start entstand oder ihr Gerät erst danach
 * beanspruchte, bekam damit nie eine Komposition: das Portal versprach
 * „Sobald Ihr Gerät sich meldet, erscheint hier, wie Ihre Anlage verschaltet
 * ist" und hielt es nicht (Live-Befund „Mienbach", 10.08.2026).
 *
 * <p>Diese Klasse ist die AUSLÖSE-Politik dazu - sie entscheidet WANN
 * automatisch komponiert wird und sorgt dafür, dass das nie einem
 * Aufrufer schaden kann. WAS komponiert wird, bleibt allein
 * {@link EntityRegistryService#bootstrapIfEligible} (eine Wahrheit, kein
 * SQL-Zwilling, dieselben Wächter wie der Admin-Bootstrap).
 *
 * <p><b>Drei Auslöser, jeder an dem Moment, in dem die Stammdaten
 * komponierbar WERDEN</b> - der Kunde tut dafür nichts:
 * <ul>
 *   <li><b>Geräte-Claim</b> - erst mit dem Gerät↔Anlage-Link gibt es ein
 *       eindeutiges Gateway; die Komposition passiert im selben Atemzug, also
 *       ohne jede Wartezeit für eine neu eingerichtete Anlage.</li>
 *   <li><b>Speicher-Speichern</b> - eine Anlage, die ihr Gerät VOR dem
 *       Speicher bekam, ist bis dahin ohne battery-hybrid komponiert; der
 *       Batterie-Schreibpfad schließt sie ab.</li>
 *   <li><b>Der getaktete Abgleich</b> ({@link V2SiteBackfillRunner}) - er
 *       heilt Bestandsanlagen wie Mienbach OHNE Deploy, ohne Re-Claim und
 *       ohne Klick.</li>
 * </ul>
 *
 * <p><b>Warum kein MQTT-Herzschlag-Zuhörer:</b> ein eigener Zuhörer bräuchte
 * ein NEUES {@code @ConditionalOnProperty}-Flag (wie alle seine Geschwister
 * per Vorgabe aus), das im gitops-Repo nachgezogen werden muss - sonst läuft
 * er in prod nachweislich nie (die dokumentierte OTA-Listener-Falle), also
 * genau die Fehlerklasse, die dieser Umbau beendet. Sich an einen BESTEHENDEN
 * Zuhörer zu hängen koppelte die Komposition an das Flag eines fremden
 * Features. Der getaktete Abgleich braucht weder Broker noch neues Flag; sein
 * Not-Aus ist der schon vorhandene {@code voltpilot.entities.backfill.enabled}.
 *
 * <p><b>Nie schädlich, in beide Richtungen:</b> die Komposition ist
 * idempotent + fail-soft, und eine Ausnahme wird hier verschluckt (ein Claim
 * darf nie an der Modell-Buchhaltung scheitern). Läuft der Aufrufer in einer
 * Transaktion, wird bewusst NACH dem Commit komponiert - ein Fehler in einer
 * mitlaufenden Transaktion würde sie sonst als rollback-only markieren und die
 * eigentliche Kundenaktion (den Speicher-Schreibvorgang) mitreißen.
 */
@Component
public class EntityAutoComposer {

    private static final Logger log = LoggerFactory.getLogger(EntityAutoComposer.class);

    private final EntityRegistryService entities;

    public EntityAutoComposer(EntityRegistryService entities) {
        this.entities = entities;
    }

    /**
     * Komponiere die Anlage, sobald ihre Stammdaten es hergeben - sofort, wenn
     * keine Transaktion läuft, sonst nach deren Commit. Wirft NIE.
     *
     * <p>Der {@link com.voltpilot.api.tenant.TenantContext} des Aufrufers ist
     * der Mandant, unter dem geschrieben wird (RLS ist der Zaun) - beim
     * Nach-Commit-Weg wird er ausdrücklich mitgenommen, weil die Synchronisation
     * zwar auf demselben Thread, aber möglicherweise nach dem Aufräumen des
     * Anfrage-Kontexts läuft.
     */
    public void ensureComposed(UUID siteId) {
        if (siteId == null) {
            return;
        }
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            composeQuietly(siteId, TenantContext.get());
            return;
        }
        UUID tenantId = TenantContext.get();
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                composeQuietly(siteId, tenantId);
            }
        });
    }

    private void composeQuietly(UUID siteId, UUID tenantId) {
        UUID previous = TenantContext.get();
        try {
            if (tenantId != null) {
                TenantContext.set(tenantId);
            }
            BackfillOutcome outcome = entities.bootstrapIfEligible(siteId);
            if (outcome == BackfillOutcome.MIGRATED) {
                log.info("Anlagen-Modell für Anlage {} automatisch komponiert", siteId);
            }
        } catch (RuntimeException e) {
            // Eine Anlage ohne Modell ist ein Anzeige-Mangel, ein gescheiterter
            // Claim ein Betriebsausfall - also nie den Aufrufer mitreißen.
            log.warn("Automatische Komposition für Anlage {} fehlgeschlagen, die Anlage bleibt "
                    + "vorerst ohne Modell: {}", siteId, e.toString());
        } finally {
            if (previous == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(previous);
            }
        }
    }
}
