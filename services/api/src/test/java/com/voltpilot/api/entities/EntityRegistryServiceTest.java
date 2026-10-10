package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BerichtsBelege;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.repo.FlowClaimRepository;
import java.util.UUID;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.ObjectProvider;

class EntityRegistryServiceTest {
    @ParameterizedTest
    @ValueSource(strings = {"pv-generation", "grid-meter", "generic-load"})
    @SuppressWarnings("unchecked")
    void loeschenEntferntZuordnungenAuchWennDerMesspunktBleibt(String role) {
        var repo = mock(EntityRegistryRepository.class);
        var site = UUID.randomUUID();
        var entity = UUID.randomUUID();
        var row = mock(EntityRow.class);
        when(row.role()).thenReturn(role);
        when(repo.entityForSite(site, entity)).thenReturn(row);
        var service = spy(new EntityRegistryService(repo, mock(ObjectProvider.class), new ObjectMapper(),
                mock(EntityTypeCatalog.class), mock(AssetRepository.class), mock(FlowClaimRepository.class),
                mock(DeviceOverrideRepository.class), new LeadDeviceService(repo),
                mock(BerichtsBelege.class)));
        doReturn(new EntityRegistryService.PushOutcome(false, false, "test", null)).when(service).pushRegistryBestEffort(site);
        assertThat(service.deleteEntity(site, entity)).isTrue();
        var reihenfolge = inOrder(repo);
        reihenfolge.verify(repo).entityForSite(site, entity);
        reihenfolge.verify(repo).deleteRoleAssignments(entity);
        if (role.equals("generic-load")) reihenfolge.verify(repo).deletePoint(entity);
        else reihenfolge.verify(repo).clearEntityConfig(entity);
    }
}
