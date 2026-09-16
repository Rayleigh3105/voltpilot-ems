package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.voltpilot.api.chargers.ChargingConfigPublisher;
import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.control.ControlCertificationPublisher;
import com.voltpilot.api.enrollment.EnrollmentService;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.measurement.MeasurementConfigPublisher;
import com.voltpilot.api.measurement.MeasurementSelectionService;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.ota.OtaTargetPublisher;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** A5: echte App-Rolle/RLS/Transaktion, ausschließlich gemockte externe Transporte. */
@Testcontainers(disabledWithoutDocker=true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BoxTauschApiTest {
    @Container static final PostgreSQLContainer<?> DB=new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url",DB::getJdbcUrl);
        r.add("spring.datasource.username",()->"voltpilot_app");
        r.add("spring.datasource.password",()->"voltpilot_app_test_pw");
        r.add("spring.flyway.url",DB::getJdbcUrl);
        r.add("spring.flyway.user",DB::getUsername);
        r.add("spring.flyway.password",DB::getPassword);
        r.add("spring.flyway.placeholders.appDbUser",()->"voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword",()->"voltpilot_app_test_pw");
        r.add("voltpilot.security.oidc.enabled",()->"true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",()->"http://127.0.0.1:9/test");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",()->"http://127.0.0.1:9/test/jwks");
    }
    @Autowired MockMvc mvc;
    @Autowired BoxTauschService service;
    @Autowired BoxTauschZustellung delivery;
    @MockBean EnrollmentService enrollment;
    @MockBean ProvisioningPublisher provisioning;
    @MockBean EntityRegistryPublisher entities;
    @MockBean MeasurementConfigPublisher measurements;
    @MockBean MeasurementSelectionService selections;
    @MockBean ControlCertificationPublisher certification;
    @MockBean OtaTargetPublisher ota;
    @MockBean FlowDeploymentPublisher flows;
    @MockBean ChargingConfigPublisher charging;
    @MockBean FlowActivationService deployments;
    @MockBean ChargingConfigService chargingConfig;
    static JdbcTemplate root;
    @BeforeAll static void connection() {
        root=new JdbcTemplate(new DriverManagerDataSource(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword()));
    }
    @BeforeEach void transports() {
        when(enrollment.blockSucceededDevice(any(),any())).thenAnswer(i -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(root.queryForObject("SELECT status FROM device WHERE id=?",String.class,(UUID)i.getArgument(1))).isEqualTo("retired");
            return true;
        });
        when(provisioning.clearRetained(any(),any(),any(),any(),anyBoolean())).thenReturn(true);
        when(provisioning.publishConfig(any(),any(),any(),any())).thenReturn(true);
        when(entities.clearRegistry(any(),any(),any())).thenReturn(true);
        when(entities.publishRegistry(any(),any(),any(),any())).thenReturn(true);
        when(measurements.clear(any(),any(),any())).thenReturn(true);
        when(measurements.publish(any(),any())).thenReturn(true);
        when(selections.forPublishing(any())).thenReturn(mock(MeasurementSelectionService.State.class));
        when(certification.clear(any(),any(),any())).thenReturn(true);
        when(certification.publish(any(),any(),any(),anyBoolean(),any(),any())).thenReturn(true);
        when(ota.clearTarget(any(),any(),any())).thenReturn(true);
        when(ota.publishTarget(any(),any(),any(),any(),anyLong(),any(),any(),any(),any())).thenReturn(true);
        when(flows.clearDeployment(any(),any(),any())).thenReturn(true);
        when(charging.clear(any(),any(),any())).thenReturn(true);
        when(deployments.republishForSite(any())).thenReturn(true);
        when(chargingConfig.republishForSite(any(),any())).thenReturn(true);
    }
    @AfterEach void context() { TenantContext.clear(); }

    @Test void a5UebernimmtOhneDeleteUndPushAnNeueBox() throws Exception {
        Welt w=welt();
        Map<String,Long> before=counts(w);
        // Jeder DELETE auf einem geschützten Fachobjekt würde die Abnahme abbrechen.
        root.execute("CREATE OR REPLACE FUNCTION test_box_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'DELETE verboten'; END $$");
        for(String table: List.of("device","measurement_point","geraet","messstelle","data_source","device_measurement_selection","device_control_activation","device_update_target"))
            root.execute("CREATE TRIGGER test_box_no_delete BEFORE DELETE ON "+table+" FOR EACH ROW EXECUTE FUNCTION test_box_no_delete()");
        try {
            mvc.perform(request(w)).andExpect(status().isOk());
        } finally {
            for(String table: List.of("device","measurement_point","geraet","messstelle","data_source","device_measurement_selection","device_control_activation","device_update_target"))
                root.execute("DROP TRIGGER test_box_no_delete ON "+table);
        }
        assertThat(counts(w)).isEqualTo(before);
        assertThat(root.queryForObject("SELECT status FROM device WHERE id=?",String.class,w.old())).isEqualTo("retired");
        for(String table: List.of("measurement_point","asset","device_measurement_selection","device_control_activation","device_update_target"))
            assertThat(root.queryForObject("SELECT count(*) FROM "+table+" WHERE device_id=?",Long.class,w.next())).isPositive();
        assertThat(root.queryForObject("SELECT lead_device_id FROM site WHERE id=?",UUID.class,w.site())).isEqualTo(w.next());
        var periods=root.queryForList("SELECT device_id,effective_from,effective_to FROM data_source_assignment WHERE data_source_id=? ORDER BY effective_from",w.source());
        assertThat(periods).hasSize(2);
        assertThat(periods.getFirst().get("effective_to")).isEqualTo(periods.getLast().get("effective_from"));
        Timestamp boundary=(Timestamp)periods.getLast().get("effective_from");
        assertThat(root.queryForObject("SELECT device_id FROM data_source_assignment WHERE data_source_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)",UUID.class,w.source(),boundary,boundary)).isEqualTo(w.next());
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_selection_event WHERE device_id=?",Long.class,w.old())).isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_selection_event WHERE device_id=? AND event_kind='selection_requested'",Long.class,w.next())).isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM device_succession WHERE old_device_id=? AND delivered_at IS NOT NULL",Long.class,w.old())).isEqualTo(1);
        verify(entities).publishRegistry(eq(w.tenant()),eq(w.site()),eq(w.next()),any());
        verify(entities,never()).publishRegistry(any(),any(),eq(w.old()),any());
        var order=inOrder(enrollment,entities);
        order.verify(enrollment).blockSucceededDevice(any(),eq(w.old()));
        order.verify(entities).clearRegistry(w.tenant(),w.site(),w.old());
        order.verify(entities).publishRegistry(eq(w.tenant()),eq(w.site()),eq(w.next()),any());
        verify(certification).publish(eq(w.tenant()),eq(w.site()),eq(w.next()),eq(true),any(),any());
        verify(ota).publishTarget(eq(w.tenant()),eq(w.site()),eq(w.next()),any(),anyLong(),any(),any(),any(),any());
    }

    @Test void letzterSchrittFehlschlaegtAllesBleibtUndKeinTransport() {
        Welt w=welt();
        var before=snapshot(w);
        root.execute("CREATE OR REPLACE FUNCTION test_box_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'erzwungener Fehler'; END $$");
        root.execute("CREATE TRIGGER test_box_abort BEFORE INSERT ON device_succession FOR EACH ROW EXECUTE FUNCTION test_box_abort()");
        try {
            TenantContext.set(w.tenant());
            assertThatThrownBy(() -> service.tauschen(w.next(),w.old(),new ProtokollAkteur("test","Test","kundenadministrator","kunde")))
                    .hasMessageContaining("erzwungener Fehler");
        } finally { root.execute("DROP TRIGGER test_box_abort ON device_succession"); }
        assertThat(snapshot(w)).isEqualTo(before);
        verifyNoInteractions(enrollment);
    }

    @Test void aclFehlerBleibtAusstehendUndWirdWiederholt() throws Exception {
        Welt w=welt();
        doReturn(false).when(enrollment).blockSucceededDevice(any(),eq(w.old()));
        mvc.perform(request(w)).andExpect(status().isAccepted());
        verify(entities,never()).publishRegistry(any(),any(),any(),any());
        assertThat(root.queryForObject("SELECT phase FROM data_source_handover WHERE data_source_id=?",String.class,w.source())).isEqualTo("pending");
        doReturn(true).when(enrollment).blockSucceededDevice(any(),eq(w.old()));
        TenantContext.set(w.tenant());
        assertThat(delivery.zustellen(w.old())).isTrue();
        verify(entities).publishRegistry(eq(w.tenant()),eq(w.site()),eq(w.next()),any());
    }

    @Test void fremdeBoxenSind404UndAndereHeimat409() throws Exception {
        Welt w=welt(),fremd=welt();
        mvc.perform(auth(post(path(w.next(),fremd.old())),w.tenant())).andExpect(status().isNotFound());
        mvc.perform(auth(post(path(fremd.next(),w.old())),w.tenant())).andExpect(status().isNotFound());
        UUID other=root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?,'Andere Anlage') RETURNING id",UUID.class,w.tenant());
        root.update("UPDATE device SET site_id=? WHERE id=?",other,w.next());
        var r=mvc.perform(request(w)).andExpect(status().isConflict())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.grund").value("nachfolger_andere_heimat")).andReturn();
        assertThat(r.getResolvedException()).hasMessageContaining("nachfolger_andere_heimat");
        verifyNoInteractions(enrollment);
    }

    @Test void entfernenMitZustaendigkeitIst409() throws Exception {
        Welt w=welt();
        var r=mvc.perform(auth(delete("/api/v1/devices/"+w.old()),w.tenant())).andExpect(status().isConflict())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.grund").value("box_hat_zustaendigkeiten")).andReturn();
        assertThat(r.getResolvedException()).hasMessageContaining("box_hat_zustaendigkeiten");
        assertThat(root.queryForObject("SELECT status FROM device WHERE id=?",String.class,w.old())).isEqualTo("claimed");
    }

    @Test void spaetereBereinigungLoeschtKeinNeuVergebenesProvisioning() throws Exception {
        Welt w=welt();
        doReturn(false).when(enrollment).blockSucceededDevice(any(),eq(w.old()));
        mvc.perform(request(w)).andExpect(status().isAccepted());
        String ref=root.queryForObject("SELECT external_ref FROM device WHERE id=?",String.class,w.old());
        root.update("INSERT INTO device(tenant_id,site_id,external_ref,status) VALUES (?,?,?,'claimed')",w.tenant(),w.site(),ref);
        doReturn(true).when(enrollment).blockSucceededDevice(any(),eq(w.old()));
        TenantContext.set(w.tenant());
        assertThat(delivery.zustellen(w.old())).isTrue();
        verify(provisioning).clearRetained(ref,w.tenant(),w.site(),w.old(),false);
    }

    @Test void geplanterZeitraumSperrtTauschUndEntfernen() throws Exception {
        Welt w=welt();
        root.update("UPDATE data_source_assignment SET effective_from=date_trunc('minute',now())+interval '1 day' WHERE data_source_id=?",w.source());
        mvc.perform(request(w)).andExpect(status().isConflict());
        mvc.perform(auth(delete("/api/v1/devices/"+w.old()),w.tenant())).andExpect(status().isConflict());
    }

    @Test void fehlendesRechtUndUnsichtbareAnlageBleibenGeschuetzt() throws Exception {
        Welt w=welt();
        String sub="eingeschraenkt-"+w.tenant();
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer','Test','aktiv')",w.tenant(),sub);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,gueltig_ab,zeitzone) VALUES (?,?,'energiemanager','2024-01-01','Europe/Berlin')",w.tenant(),sub);
        mvc.perform(auth(post(path(w.next(),w.old())),w.tenant(),sub))
                .andExpect(status().isForbidden());
        // Bearbeiter eines anderen Standorts sieht auch innerhalb desselben Kundenbereichs
        // keine der beiden Boxen: Sichtbarkeit wird vor der Heimat-Konfliktauskunft geprüft.
        UUID company=root.queryForObject("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,'Ahrenberg','Europe/Berlin') RETURNING id",UUID.class,w.tenant());
        UUID place=root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) VALUES (?,?,'Werk Lindach','ST-2','Europe/Berlin','aktiv') RETURNING id",UUID.class,w.tenant(),company);
        String eingeschraenkt="bearbeiter-"+w.tenant();
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer','Test','aktiv')",w.tenant(),eingeschraenkt);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) VALUES (?,?,'bearbeiter',?,'2024-01-01','Europe/Berlin')",w.tenant(),eingeschraenkt,place);
        mvc.perform(auth(post(path(w.next(),w.old())),w.tenant(),eingeschraenkt))
                .andExpect(status().isNotFound());
        verifyNoInteractions(enrollment);
    }

    @Test void belegterNachfolgerWirdNichtUeberschrieben() throws Exception {
        Welt w=welt();
        root.update("INSERT INTO device_control_activation(device_id,activated_by) VALUES (?,'test')",w.next());
        mvc.perform(request(w)).andExpect(status().isConflict());
        assertThat(root.queryForObject("SELECT count(*) FROM device_control_activation WHERE device_id IN (?,?)",Long.class,w.old(),w.next())).isEqualTo(2);
    }

    private MockHttpServletRequestBuilder request(Welt w) { return auth(post(path(w.next(),w.old())),w.tenant()); }
    private static String path(UUID next,UUID old) { return "/api/v1/devices/"+next+"/succeed/"+old; }
    private static MockHttpServletRequestBuilder auth(MockHttpServletRequestBuilder r,UUID tenant) {
        return auth(r,tenant,"test-"+tenant);
    }
    private static MockHttpServletRequestBuilder auth(MockHttpServletRequestBuilder r,UUID tenant,String sub) {
        var token=new org.springframework.security.oauth2.jwt.Jwt("test",Instant.now(),Instant.now().plusSeconds(3600),
                Map.of("alg","none"),Map.of("sub",sub,"tenant_id",tenant.toString(),"name","Test",
                        "realm_access",Map.of("roles",List.of())));
        return r.with(authentication(new com.voltpilot.api.config.KeycloakRealmRoleConverter().convert(token)));
    }
    record Welt(UUID tenant,UUID site,UUID old,UUID next,UUID source,UUID entity) {}
    private Welt welt() {
        UUID t=root.queryForObject("INSERT INTO tenant(name) VALUES ('Kunststoffwerk Ahrenberg · Box-Tausch') RETURNING id",UUID.class);
        UUID s=root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?,'Halle 2') RETURNING id",UUID.class,t);
        UUID old=box(t,s,"Box Halle 2"),next=box(t,s,"Box Halle 2 Nachfolger");
        root.update("UPDATE site SET lead_device_id=? WHERE id=?",old,s);
        UUID q=root.queryForObject("INSERT INTO data_source(tenant_id,site_id,kennzeichen,protokoll,adresse,kadenz_s) VALUES (?,?,'DQ-4','modbus_tcp','10.2.0.4:502',60) RETURNING id",UUID.class,t,s);
        root.update("INSERT INTO data_source_assignment(tenant_id,data_source_id,device_id,protokoll,adresse,effective_from) VALUES (?,?,?,'modbus_tcp','10.2.0.4:502',date_trunc('minute',now())-interval '1 day')",t,q,old);
        UUID entity=root.queryForObject("INSERT INTO measurement_point(tenant_id,site_id,device_id,role,entity_type,control,communication,connection_json,data_source_id) VALUES (?,?,?,'grid-meter','grid-meter',false,'modbus_tcp','{\"ip\":\"10.2.0.4\",\"port\":502,\"unit_id\":1}'::jsonb,?) RETURNING id",UUID.class,t,s,old,q);
        root.update("INSERT INTO asset(tenant_id,site_id,type,device_id,capacity_kwh,max_charge_kw,max_discharge_kw) VALUES (?,?,'battery',?,200,100,100)",t,s,old);
        root.update("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,wertart) VALUES (?,'MS-10','EK-1','gemessen','Strom','Wirkenergie','Bezug','kWh','Zählerstand')",t);
        root.update("INSERT INTO device_measurement_selection(tenant_id,site_id,device_id,entity_id,point_key,enabled,cadence_s,desired_revision,enabled_at,catalog_version,changed_by,apply_status,retention_class,long_term_strategy) VALUES (?,?,?,?,'sunspec.model_203.totwhimp',true,60,1,now(),'2026.09.11.1','test','pending_edge','energy_counter','fifteen_minute')",t,s,old,entity);
        root.update("INSERT INTO device_measurement_selection_event(tenant_id,site_id,device_id,point_key,desired_revision,requested_enabled,requested_cadence_s,enabled_at,catalog_version,actor,apply_status,retention_class,long_term_strategy,idempotency_key) VALUES (?,?,?,'sunspec.model_203.totwhimp',1,true,60,now(),'2026.09.11.1','test','pending_edge','energy_counter','fifteen_minute',gen_random_uuid())",t,s,old);
        root.update("INSERT INTO device_control_activation(device_id,activated_by) VALUES (?,'test')",old);
        long release=root.queryForObject("INSERT INTO edge_release(release_seq,version,target_commit,created_by,manifest,signature,signing_key_id) SELECT coalesce(max(release_seq),0)+1,?,'test','test','{}','test-signature','test-key' FROM edge_release RETURNING release_seq",Long.class,"test-"+UUID.randomUUID());
        root.update("INSERT INTO device_update_target(device_id,release_seq,release_version) VALUES (?,?,?)",old,release,"test-release");
        root.update("INSERT INTO telemetry(time,tenant_id,site_id,device_id,power_kw) VALUES (now(),?,?,?,42)",t,s,old);
        when(selections.requireDevice(next)).thenReturn(new DeviceScope(t,s,next));
        return new Welt(t,s,old,next,q,entity);
    }
    private UUID box(UUID t,UUID s,String name) {
        return root.queryForObject("INSERT INTO device(tenant_id,site_id,external_ref,name,status) VALUES (?,?,?,?,'claimed') RETURNING id",UUID.class,t,s,"VP-TEST-"+UUID.randomUUID(),name);
    }
    private Map<String,Long> counts(Welt w) {
        Map<String,Long> result=new TreeMap<>();
        for(String table:List.of("device","measurement_point","geraet","messstelle","data_source","asset","device_measurement_selection","telemetry"))
            result.put(table,root.queryForObject("SELECT count(*) FROM "+table+" WHERE tenant_id=?",Long.class,w.tenant()));
        return result;
    }
    private Map<String,Object> snapshot(Welt w) {
        Map<String,Object> result=new TreeMap<>();
        for(String table:List.of("device","site","measurement_point","asset","data_source_assignment","device_measurement_selection","device_measurement_selection_event","device_succession","data_source_aenderung","data_source_handover"))
            result.put(table,root.queryForList("SELECT * FROM "+table+" WHERE tenant_id=? ORDER BY 1",w.tenant()));
        for(String table:List.of("device_control_activation","device_update_target"))
            result.put(table,root.queryForList("SELECT * FROM "+table+" WHERE device_id IN (?,?) ORDER BY device_id",w.old(),w.next()));
        return result;
    }
}
