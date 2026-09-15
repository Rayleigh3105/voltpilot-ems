package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.consumers.ConsumerAuditRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowCompiler;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.topology.TopologyRepository;
import com.voltpilot.api.uems.BelegeImWeg;
import com.voltpilot.api.uems.BerichtRegeln;
import com.voltpilot.api.uems.BerichtsBelege;
import com.voltpilot.api.uems.MessreihenBelege;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Der Belegschutz an den zwei Löschtüren des Komponenten-Controllers (UEMS AP-12 IP-12, E13 S2): ein selbst definiertes
 * Gerät und eine eigene Batterie werden erst nach ihren eigenen Prüfungen (404, 409 „am Gerät verwaltet“, 422 falsche
 * Tür) und VOR dem ersten Schreiben gegen die Berichts-Belege geprüft — eine Ablehnung zieht keinen Leseplan zurück,
 * löscht keine Komponente und veröffentlicht nichts. Ohne Beleg läuft derselbe Weg wie heute, in derselben Reihenfolge.
 *
 * <p>Der Beleg selbst (welche Stände welche Messstelle zitieren) ist Gegenstand von {@code UemsBelegschutzApiTest}.
 */
class KomponenteLoeschenBelegschutzTest {

    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-00000000a002");
    private static final UUID KOMPONENTE = UUID.fromString("00000000-0000-0000-0000-0000000008c3");
    private static final BelegeImWeg IM_WEG = new BelegeImWeg(BelegeImWeg.Gegenstand.KOMPONENTE,
            List.of(new MessreihenBelege.Beleg(UUID.randomUUID(), "MS-12", "Montage Linie M1")),
            List.of(new BerichtRegeln.StandBezeichnung("BR-2026-0001", 1)));

    private final ObjectMapper mapper = new ObjectMapper();
    private final SiteRepository sites = mock(SiteRepository.class);
    private final EntityRegistryRepository entityRepo = mock(EntityRegistryRepository.class);
    private final EntityRegistryService entityRegistry = mock(EntityRegistryService.class);
    private final ComponentDefinitionRepository definitions = mock(ComponentDefinitionRepository.class);
    private final FlowRepository flows = mock(FlowRepository.class);
    private final FlowActivationService deployments = mock(FlowActivationService.class);
    private final BerichtsBelege belege = mock(BerichtsBelege.class);
    @SuppressWarnings("unchecked")
    private final ObjectProvider<FlowCompiler> flowc = mock(ObjectProvider.class);

    @BeforeEach
    void setUp() {
        when(sites.existsForCurrentTenant(SITE)).thenReturn(true);
        when(definitions.componentAuthority(SITE)).thenReturn("portal");
    }

    @Test
    void einSelbstDefiniertesGeraetMitBelegZiehtKeinenLeseplanZurueckUndLoeschtNichts() {
        when(entityRepo.entityForSite(SITE, KOMPONENTE)).thenReturn(row(SelfBuildDefinition.COMMUNICATION));
        doThrow(IM_WEG).when(belege).pruefeKomponente(SITE, KOMPONENTE);

        assertThatThrownBy(() -> selbstbau().delete(SITE, KOMPONENTE, "kc-jw")).isSameAs(IM_WEG);

        verify(flows, never()).retireActive(any());
        verify(entityRegistry, never()).deleteEntity(any(), any(), anyBoolean());
        verify(deployments, never()).republishForSite(any());
    }

    @Test
    void einSelbstDefiniertesGeraetOhneBelegGehtWieHeute() {
        when(entityRepo.entityForSite(SITE, KOMPONENTE)).thenReturn(row(SelfBuildDefinition.COMMUNICATION));

        selbstbau().delete(SITE, KOMPONENTE, "kc-jw");

        InOrder reihenfolge = inOrder(belege, flows, entityRegistry, deployments);
        reihenfolge.verify(belege).pruefeKomponente(SITE, KOMPONENTE);
        reihenfolge.verify(flows).retireActive(SelfBuildFlowCompiler.generatedFlowId(KOMPONENTE));
        reihenfolge.verify(entityRegistry).deleteEntity(SITE, KOMPONENTE, true);
        reihenfolge.verify(deployments).republishForSite(SITE);
    }

    @Test
    void dieFalscheTuerAntwortetVorDerBelegpruefung() {
        when(entityRepo.entityForSite(SITE, KOMPONENTE)).thenReturn(row("modbus_tcp"));

        assertThatThrownBy(() -> selbstbau().delete(SITE, KOMPONENTE, "kc-jw"))
                .hasMessageContaining("nicht selbst angelegt");
        verify(belege, never()).pruefeKomponente(any(), any());
    }

    @Test
    void eineEigeneBatterieMitBelegZiehtKeinenLeseplanZurueckUndLoeschtNichts() {
        when(entityRepo.entityForSite(SITE, KOMPONENTE)).thenReturn(row(UserDefinedBatteryDefinition.COMMUNICATION));
        doThrow(IM_WEG).when(belege).pruefeKomponente(SITE, KOMPONENTE);

        assertThatThrownBy(() -> batterie().delete(SITE, KOMPONENTE, "kc-jw")).isSameAs(IM_WEG);

        verify(flows, never()).retireActive(any());
        verify(entityRegistry, never()).deleteEntity(any(), any(), anyBoolean());
        verify(deployments, never()).republishForSite(any());
    }

    @Test
    void eineEigeneBatterieOhneBelegGehtWieHeute() {
        when(entityRepo.entityForSite(SITE, KOMPONENTE)).thenReturn(row(UserDefinedBatteryDefinition.COMMUNICATION));

        batterie().delete(SITE, KOMPONENTE, "kc-jw");

        InOrder reihenfolge = inOrder(belege, flows, entityRegistry, deployments);
        reihenfolge.verify(belege).pruefeKomponente(SITE, KOMPONENTE);
        reihenfolge.verify(flows).retireActive(UserDefinedBatteryFlowCompiler.generatedFlowId(KOMPONENTE));
        reihenfolge.verify(entityRegistry).deleteEntity(SITE, KOMPONENTE, true);
        reihenfolge.verify(deployments).republishForSite(SITE);
    }

    private SelfBuildComponentService selbstbau() {
        return new SelfBuildComponentService(sites, entityRepo, entityRegistry, definitions, mock(ComponentService.class),
                mock(ComponentConnectionReceipts.class), mock(SiteComponentTemplateRepository.class),
                mock(SelfBuildFlowCompiler.class), flows, deployments, flowc, mock(ProbeService.class),
                mock(ConsumerAuditRepository.class), mapper, belege);
    }

    private UserDefinedBatteryService batterie() {
        return new UserDefinedBatteryService(sites, entityRepo, entityRegistry, new EntityTypeCatalog(mapper), definitions,
                mock(ComponentService.class), new SocCurveTemplateCatalog(mapper), new ProtectionProfileCatalog(mapper),
                new UserDefinedBatteryFlowCompiler(mapper), flows, deployments, flowc, mock(TopologyRepository.class), mapper,
                belege);
    }

    private static EntityRow row(String communication) {
        return new EntityRow(KOMPONENTE, null, "Zähler Energiekarte EK-3 (Montage M1)", null, null, null, communication,
                null, null, null, false, "modbus-generic", "{\"measure\":[]}", "{}", null, null, null, null, 1, null);
    }
}
