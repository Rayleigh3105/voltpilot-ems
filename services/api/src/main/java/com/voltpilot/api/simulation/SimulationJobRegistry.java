package com.voltpilot.api.simulation;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * Remembers which caller scope a running simulation job belongs to, so the
 * poll endpoints can never leak a foreign job: a site job is only readable
 * through ITS site route (which is itself RLS-scoped), an admin job only
 * through the platform-admin route. The Python service knows no tenants.
 *
 * <p>In-memory on purpose (V1 is stateless; jobs live 1 h in the service): an
 * api restart forgets the mapping, the poll turns 404 and the portal simply
 * starts a fresh simulation - the input cache makes that cheap.
 */
@Component
public class SimulationJobRegistry {

    private static final Duration TTL = Duration.ofHours(2);

    private record Scope(UUID siteId, boolean admin, Instant created) {
    }

    private final ConcurrentHashMap<String, Scope> scopes = new ConcurrentHashMap<>();

    public void registerSiteJob(String simulationId, UUID siteId) {
        purge();
        scopes.put(simulationId, new Scope(siteId, false, Instant.now()));
    }

    public void registerAdminJob(String simulationId) {
        purge();
        scopes.put(simulationId, new Scope(null, true, Instant.now()));
    }

    public boolean isSiteJob(String simulationId, UUID siteId) {
        Scope scope = scopes.get(simulationId);
        return scope != null && !scope.admin() && siteId.equals(scope.siteId());
    }

    public boolean isAdminJob(String simulationId) {
        Scope scope = scopes.get(simulationId);
        return scope != null && scope.admin();
    }

    private void purge() {
        Instant cutoff = Instant.now().minus(TTL);
        scopes.entrySet().removeIf(e -> e.getValue().created().isBefore(cutoff));
    }
}
