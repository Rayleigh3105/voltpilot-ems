package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BerichtsBelege;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.repo.FlowClaimRepository;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.*;
import com.voltpilot.api.uems.ZustaendigkeitRepository.Zeitraum;
import java.time.*;
import java.util.*;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** A3 mit zwei Boxen in EINER Anlage; der unveränderte anlagenfremde Fall bleibt am Gate. */
@Testcontainers(disabledWithoutDocker = true)
class UemsQuellenUebergabeTest {
    static final ObjectMapper JSON = new ObjectMapper();
    static final Instant HIN = Instant.parse("2027-04-10T05:30:00Z"); // 07:30 Europe/Berlin
    static final Instant ZURUECK = Instant.parse("2027-04-12T14:00:00Z"); // 16:00
    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("test");
    static JdbcTemplate root, app;
    static DataSource ds;
    static UebergabeRepository repo;
    static DataSourceTransactionManager manager;
    UUID tenant, site, a, b, quelle, entity;
    EntityRegistryService registry;
    EntityRegistryRepository registryRepo;
    Map<UUID,Set<String>> liest = new LinkedHashMap<>();
    Map<UUID,String> revisionen = new HashMap<>();
    Set<UUID> fehlgeschlagen = new HashSet<>();
    Set<UUID> verzoegert = new HashSet<>();
    List<UUID> versand = new ArrayList<>();
    Uhr uhr = new Uhr();

    @BeforeAll static void migration() {
        Flyway.configure().dataSource(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword())
                .locations("classpath:db/migration").baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser","voltpilot_app","appDbPassword","app_test",
                        "adminDbUser","voltpilot_admin","adminDbPassword","admin_test")).load().migrate();
        root = new JdbcTemplate(source(DB.getUsername(), DB.getPassword()));
        ds = new TenantAwareDataSource(source("voltpilot_app", "app_test"));
        app = new JdbcTemplate(ds);
        repo = new UebergabeRepository(app);
        manager = new DataSourceTransactionManager(ds);
    }
    @BeforeEach void welt() throws Exception {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('A3 Prüffall') RETURNING id", UUID.class);
        site = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?, 'Halle 1') RETURNING id", UUID.class, tenant);
        a = box("Box Halle 1"); b = box("Box Halle 2 (A3, Heimat für diesen Gate-freien Test Halle 1)");
        quelle = root.queryForObject("INSERT INTO data_source(tenant_id,site_id,kennzeichen,protokoll,adresse,kadenz_s) "
                + "VALUES (?,?,'DQ-3','modbus_tcp','192.168.10.31:502',60) RETURNING id",UUID.class,tenant,site);
        entity = root.queryForObject("INSERT INTO measurement_point(tenant_id,site_id,role,entity_type,data_source_id) "
                + "VALUES (?,?,'modbus-generic','modbus-generic',?) RETURNING id",UUID.class,tenant,site,quelle);
        TenantContext.set(tenant);
        uhr.zeit = HIN.minusSeconds(60);
        registryRepo = mock(EntityRegistryRepository.class);
        when(registryRepo.siteDeviceIds(site)).thenReturn(List.of(a,b));
        when(registryRepo.storedLeadDeviceId(site)).thenReturn(a);
        when(registryRepo.componentAuthority(site)).thenReturn("portal");
        when(registryRepo.datenquelleJeEntitaet(site)).thenReturn(Map.of(entity,quelle));
        when(registryRepo.entitiesForSite(site)).thenReturn(List.of(new EntityRow(entity, "modbus-generic",
                null,null,null,null,"modbus_tcp","{\"ip\":\"192.168.10.31\",\"port\":502,\"unit_id\":1}",
                null,null,false,"Unterzähler", "{\"measure\":[{\"channel\":\"power_kw\"}]}",
                "{\"failsafe\":{\"behavior\":\"measure-only\"}}",null,null,null,null,1,null)));
        List<Zeitraum> zeiten=List.of(z(a,HIN.minusSeconds(86400),HIN),z(b,HIN,ZURUECK),z(a,ZURUECK,null));
        for (Zeitraum z : zeiten) root.update("INSERT INTO data_source_assignment "
                + "(id,tenant_id,data_source_id,device_id,protokoll,adresse,effective_from,effective_to) "
                + "VALUES (?,?,?,?,'modbus_tcp','192.168.10.31:502',?,?)",z.id(),tenant,quelle,z.deviceId(),
                java.sql.Timestamp.from(z.effectiveFrom()),z.effectiveTo()==null?null:java.sql.Timestamp.from(z.effectiveTo()));
        when(registryRepo.zustaendigkeitenDerQuellen(site)).thenReturn(zeiten);
        EntityRegistryPublisher pub = mock(EntityRegistryPublisher.class);
        when(pub.publishRegistry(any(),any(),any(),any())).thenAnswer(call -> {
            UUID box = call.getArgument(2); versand.add(box);
            if (fehlgeschlagen.contains(box)) return false;
            if (verzoegert.contains(box)) return true; // Broker nahm an; die Box hat noch NICHT angewandt.
            var payload = JSON.readTree((byte[]) call.getArgument(3));
            Set<String> ids = new HashSet<>(); payload.get("entities").forEach(e -> ids.add(e.get("entity_id").asText()));
            liest.put(box,ids); revisionen.put(box,payload.get("revision").asText());
            assertThat(liest.values().stream().filter(v -> v.contains(entity.toString())).count())
                    .as("nach JEDEM einzelnen Push niemals zwei Leser").isLessThanOrEqualTo(1);
            return true;
        });
        ObjectProvider<EntityRegistryPublisher> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(pub);
        registry = new EntityRegistryService(registryRepo, provider, JSON, mock(EntityTypeCatalog.class),
                mock(AssetRepository.class),mock(FlowClaimRepository.class),mock(DeviceOverrideRepository.class),
                new LeadDeviceService(registryRepo),uhr,
                mock(BerichtsBelege.class));
        neuStarten();
        push(); // initiale Zuständigkeit
        bestaetigen(a); bestaetigen(b);
        versand.clear();
    }
    @AfterEach void zaunZu() { TenantContext.clear(); }

    @Test void a3HinUndZurueckMitFakeUhrKeineDoppellesungLueckeHoechstensEinQuellentakt() {
        wechsel(HIN,a,b);
        wechsel(ZURUECK,b,a); // führende Box ist nun das ZIEL: falsche Reihenfolge würde doppelt lesen
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE art='handover'",Integer.class))
                .isEqualTo(4); // zwei append-only Öffnungen und zwei Abschlüsse
        assertThat(repo.stand(quelle).phase()).isEqualTo("active");
    }
    private void wechsel(Instant zeit, UUID alt, UUID neu) {
        uhr.zeit=zeit.minusSeconds(1); bestaetigen(alt); bestaetigen(neu); push();
        assertThat(liest.get(alt)).contains(entity.toString());
        uhr.zeit=zeit; push();
        assertThat(liest.values()).allSatisfy(ids -> assertThat(ids).doesNotContain(entity.toString()));
        assertThat(repo.stand(quelle).phase()).isEqualTo("removing");
        uhr.zeit=zeit.plusSeconds(9); bestaetigen(alt); push();
        assertThat(liest.get(neu)).contains(entity.toString());
        assertThat(Duration.between(zeit,uhr.instant()).getSeconds()).isLessThanOrEqualTo(60);
        uhr.zeit=zeit.plusSeconds(15); bestaetigen(neu); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("active");
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE art='handover' "
                + "AND data_source_id=? AND bis IS NULL",Integer.class,quelle)).isGreaterThan(0);
    }
    @Test void offlineZielBleibtAusstehendUndAlteBoxLiestWeiter() {
        uhr.zeit=HIN.plusSeconds(301); bestaetigen(a); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("pending");
        assertThat(liest.get(a)).contains(entity.toString());
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE art='handover'",Integer.class)).isZero();
        bestaetigen(b); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("removing");
    }
    @Test void fehlenderVersandUndVeralteteQuittungGebenNiemalsFrei() {
        uhr.zeit=HIN; fehlgeschlagen.add(a); push();
        assertThat(repo.stand(quelle).revision()).isNull();
        uhr.zeit=HIN.plusSeconds(15); bestaetigen(a); push();
        assertThat(liest.get(a)).contains(entity.toString());
        assertThat(liest.getOrDefault(b,Set.of())).doesNotContain(entity.toString());
        fehlgeschlagen.clear(); push();
        uhr.zeit=HIN.plusSeconds(30); push(); // Zeitablauf allein ist KEINE Quittung
        assertThat(repo.stand(quelle).phase()).isEqualTo("removing");
        bestaetigen(a); push();
        assertThat(liest.get(b)).contains(entity.toString());
    }
    @Test void neustartUndZwischenpushVerlierenDenEntzugNicht() {
        uhr.zeit=HIN; push();
        String erste = revisionen.get(a);
        uhr.zeit=HIN.plusSeconds(1); push(); // anderer Aufrufer im selben Übergabe-Fenster
        neuStarten();
        uhr.zeit=HIN.plusSeconds(15);
        repo.herzschlag(tenant,a,erste,uhr.instant()); push(); // frühere sichere Fassung genügt
        assertThat(liest.get(b)).contains(entity.toString());
    }
    @Test void zielQuittiertNichtMarkerBleibtOffenUndZustandAusstehend() {
        uhr.zeit=HIN; push(); uhr.zeit=HIN.plusSeconds(15); bestaetigen(a); push();
        uhr.zeit=HIN.plusSeconds(30); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("receiving");
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE art='handover'",Integer.class)).isEqualTo(1);
    }
    @Test void fremdeHeimatIstTatsaechlichGesperrtUndEntziehtDerAltenBoxNichts() {
        UUID fremd = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?, 'Halle 2') RETURNING id", UUID.class,tenant);
        root.update("UPDATE device SET site_id=? WHERE id=?",fremd,b);
        uhr.zeit=HIN; bestaetigen(b); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("pending");
        assertThat(liest.get(a)).contains(entity.toString());
    }
    @Disabled("AP-07 IP-7 verwendet im MeasurementWriteRepository INSERT weiterhin event.site_id(), "
            + "HerkunftNachschlag.Reihe enthält keine Anlage aus der Entität. Fremde Heimat erst danach.")
    @Test void a3QuelleAusAnlageHalle1AnBoxMitHeimatHalle2() { wechsel(HIN,a,b); }

    @Test void faelligeArbeitslisteLiestDieGeplantenZeitraeumeUndDenDauerhaftenStand() {
        UebergabeAufgaben aufgaben=new UebergabeAufgaben(new JdbcTemplate(source("voltpilot_admin","admin_test")));
        var diese=new UebergabeAufgaben.Anlage(tenant,site);
        assertThat(aufgaben.faellig(HIN.minusSeconds(1))).doesNotContain(diese);
        assertThat(aufgaben.faellig(HIN)).contains(diese);
        wechsel(HIN,a,b);
        assertThat(aufgaben.faellig(HIN.plusSeconds(60))).doesNotContain(diese);
        assertThat(aufgaben.faellig(ZURUECK)).contains(diese);
    }
    @Test void datenquellenAntwortNenntAusstehendUndBeideBoxenOhneDenPlanUmzuschreiben() {
        uhr.zeit=HIN.plusSeconds(301); bestaetigen(a); push();
        ObjectProvider<Clock> zeit=mock(ObjectProvider.class);
        when(zeit.getIfAvailable(any(java.util.function.Supplier.class))).thenReturn(uhr);
        var service=new DatenquelleService(new DatenquelleRepository(app),new ZustaendigkeitRepository(app),
                new DatenquelleAenderungRepository(app),mock(com.voltpilot.api.zugriff.Geltungsbereich.class),
                mock(com.voltpilot.api.probe.ProbeService.class),manager,JSON,zeit);
        org.springframework.test.util.ReflectionTestUtils.setField(service,"uebergaben",repo);
        var antwort=service.eine(site,quelle);
        assertThat(antwort.uebergabe().zustand()).isEqualTo("Übergabe ausstehend");
        assertThat(antwort.uebergabe().boxAlt().id()).isEqualTo(a);
        assertThat(antwort.uebergabe().boxNeu().id()).isEqualTo(b);
        assertThat(antwort.uebergabe().seit()).isEqualTo(HIN);
        assertThat(antwort.zustaendigeBox().id()).isEqualTo(b); // Plan bleibt separat sichtbar
        assertThat(antwort.zeitraeume()).hasSize(3);
    }
    @Test void einmalAuftragFolgtAusfuehrungStattPlanBisDieUebergabeVersandtIst() {
        var echteEntitaeten = new EntityRegistryRepository(app);
        var ziel = new EinmalAuftragZiel(echteEntitaeten, new LeadDeviceService(echteEntitaeten),
                new com.voltpilot.api.repo.DeviceRepository(app), repo);
        assertThat(ziel.komponente(site, entity, uhr.instant()).id()).isEqualTo(a);
        uhr.zeit = HIN.plusSeconds(301); bestaetigen(a); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("pending");
        assertThat(ziel.komponente(site, entity, uhr.instant()).id()).isEqualTo(a);
        bestaetigen(b); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("removing");
        assertThatThrownBy(() -> ziel.komponente(site, entity, uhr.instant()))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        bestaetigen(a); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("receiving");
        assertThat(ziel.komponente(site, entity, uhr.instant()).id()).isEqualTo(b);
        bestaetigen(b); push();
        assertThat(ziel.komponente(site, entity, uhr.instant()).id()).isEqualTo(b);
    }

    @Test void alterMesspunktOhneV2KonfigurationBleibtAdressierbarUndQuelleGehtVor() {
        UUID alt = root.queryForObject("INSERT INTO measurement_point(tenant_id,site_id,role) "
                + "VALUES (?,?,'pv-inverter') RETURNING id", UUID.class, tenant, site);
        root.update("UPDATE site SET lead_device_id=? WHERE id=?", b, site);
        var echteEntitaeten = new EntityRegistryRepository(app);
        var ziel = new EinmalAuftragZiel(echteEntitaeten, new LeadDeviceService(echteEntitaeten),
                new com.voltpilot.api.repo.DeviceRepository(app), repo);
        assertThat(ziel.komponente(site, alt, uhr.instant()).id()).isEqualTo(b);
        root.update("UPDATE measurement_point SET data_source_id=? WHERE id=?", quelle, alt);
        assertThat(ziel.komponente(site, alt, uhr.instant()).id()).isEqualTo(a);
    }

    @Test void upgradeOhneAusfuehrungsstandSchaltetNichtBlindDenVorherigenLeserEin() {
        // Der alte Cloud-Stand kann bereits an B zugestellt haben; die neue Tabelle ist leer.
        root.update("DELETE FROM data_source_handover WHERE tenant_id=?",tenant);
        liest.put(a,Set.of()); liest.put(b,Set.of(entity.toString()));
        uhr.zeit=HIN.plusSeconds(60); bestaetigen(a); bestaetigen(b); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("reconciling");
        assertThat(liest.values()).allSatisfy(ids -> assertThat(ids).doesNotContain(entity.toString()));
        uhr.zeit=HIN.plusSeconds(75); bestaetigen(a); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("reconciling");
        bestaetigen(b); push();
        assertThat(liest.get(b)).contains(entity.toString());
    }
    @Test void upgradeNachMehrerenZeitraeumenWartetAuchAufDenDrittenMoeglichenLeser() {
        UUID c=box("frühere Box");
        when(registryRepo.siteDeviceIds(site)).thenReturn(List.of(a,b,c));
        when(registryRepo.boxenMitSoll(site)).thenReturn(List.of(c));
        List<Zeitraum> zeiten=new ArrayList<>(registryRepo.zustaendigkeitenDerQuellen(site));
        zeiten.add(0,z(c,HIN.minusSeconds(172800),HIN.minusSeconds(86400)));
        when(registryRepo.zustaendigkeitenDerQuellen(site)).thenReturn(zeiten);
        root.update("DELETE FROM data_source_handover WHERE tenant_id=?",tenant);
        liest.put(a,Set.of()); liest.put(b,Set.of()); liest.put(c,Set.of(entity.toString()));
        fehlgeschlagen.add(c);
        uhr.zeit=ZURUECK.plusSeconds(60); bestaetigen(a); bestaetigen(b); push();
        uhr.zeit=ZURUECK.plusSeconds(75); bestaetigen(a); bestaetigen(b); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("reconciling");
        assertThat(liest.get(c)).contains(entity.toString());
        fehlgeschlagen.remove(c);
        uhr.zeit=ZURUECK.plusSeconds(76); push();
        assertThat(liest.values()).allSatisfy(ids -> assertThat(ids).doesNotContain(entity.toString()));
        uhr.zeit=ZURUECK.plusSeconds(90); bestaetigen(a); bestaetigen(b); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("reconciling"); // C noch unbestätigt
        bestaetigen(c); uhr.zeit=ZURUECK.plusSeconds(91); push();
        assertThat(liest.get(a)).contains(entity.toString());
    }
    @Test void upgradeWartetNichtAufEineNachweislichAusgebauteHistorischeBox() {
        List<Zeitraum> zeiten=new ArrayList<>(registryRepo.zustaendigkeitenDerQuellen(site));
        root.update("DELETE FROM data_source_assignment WHERE id=?",zeiten.remove(2).id());
        Zeitraum heute=zeiten.get(1);
        root.update("UPDATE data_source_assignment SET effective_to=NULL WHERE id=?",heute.id());
        zeiten.set(1,new Zeitraum(heute.id(),quelle,b,heute.effectiveFrom(),null));
        when(registryRepo.zustaendigkeitenDerQuellen(site)).thenReturn(zeiten);
        root.update("UPDATE device SET status='ausgebaut',ausgebaut_am=? WHERE id=?",java.sql.Timestamp.from(HIN),a);
        root.update("DELETE FROM data_source_handover WHERE tenant_id=?",tenant);
        when(registryRepo.siteDeviceIds(site)).thenReturn(List.of(b));
        when(registryRepo.storedLeadDeviceId(site)).thenReturn(b);
        liest.put(a,Set.of()); liest.put(b,Set.of(entity.toString()));
        uhr.zeit=HIN.plusSeconds(60); bestaetigen(b); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("reconciling");
        uhr.zeit=HIN.plusSeconds(75); bestaetigen(b); push();
        assertThat(liest.get(b)).contains(entity.toString());
        uhr.zeit=HIN.plusSeconds(90); bestaetigen(b); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("active");
        assertThat(repo.nachweislichAusgebaut(UUID.randomUUID())).isFalse();
    }
    @Test void spaetereWanduhrEinerAltenFassungIstKeineEntzugsquittung() {
        // Knoten 1 geht 500 ms vor. B schweigt noch, also bestätigt A eine aktive Fassung.
        root.update("DELETE FROM data_source_box_receipt WHERE tenant_id=? AND device_id=?",tenant,b);
        uhr.zeit=HIN.plusMillis(500); push(); bestaetigen(a);
        // Knoten 2 geht nach. B meldet sich, sein Entzug an A bleibt aber beim Broker liegen.
        verzoegert.add(a);
        uhr.zeit=HIN; bestaetigen(b); push();
        uhr.zeit=HIN.plusSeconds(1); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("removing");
        assertThat(liest.get(a)).contains(entity.toString());
        assertThat(liest.getOrDefault(b,Set.of())).doesNotContain(entity.toString());
    }
    @Test void verweigerteFassungIstTrotzRegistryHerzschlagKeineQuittung() {
        String vorher=revisionen.get(a);
        uhr.zeit=HIN; push();
        new com.voltpilot.api.components.ComponentApplyRepository(app).upsert(a,tenant,site,"portal",
                vorher,HIN.minusSeconds(60),revisionen.get(a),"nicht anwendbar",null,null,HIN);
        uhr.zeit=HIN.plusSeconds(15); bestaetigen(a); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("removing");
        assertThat(liest.getOrDefault(b,Set.of())).doesNotContain(entity.toString());
    }
    @Test void zweiPushesInEinerZurueckgerolltenFachtransaktionGebenNichtVorzeitigFrei() {
        new org.springframework.transaction.support.TransactionTemplate(manager).execute(status -> {
            Object savepoint=status.createSavepoint();
            uhr.zeit=HIN; push();
            uhr.zeit=HIN.plusSeconds(15); bestaetigen(a); push();
            assertThat(repo.stand(quelle).phase()).isEqualTo("removing");
            status.releaseSavepoint(savepoint);
            assertThat(liest.getOrDefault(b,Set.of())).doesNotContain(entity.toString());
            status.setRollbackOnly();
            return null;
        });
        assertThat(repo.stand(quelle).phase()).isEqualTo("active");
        String verworfeneRevision=revisionen.get(a);
        push(); // nach Rollback beginnt zuerst wieder der Entzug, kein zweiter Leser
        assertThat(revisionen.get(a)).isNotEqualTo(verworfeneRevision);
        repo.herzschlag(tenant,a,verworfeneRevision,uhr.instant()); push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("removing");
    }
    @Test void zweiteInstanzUeberspringtGesperrteAnlage() throws Exception {
        try (var con=source(DB.getUsername(),DB.getPassword()).getConnection()) {
            con.setAutoCommit(false);
            try (var st=con.prepareStatement("SELECT pg_advisory_xact_lock(hashtextextended(?,0))")) {
                st.setString(1,"quellen-uebergabe:"+tenant+":"+site); st.execute();
            }
            uhr.zeit=HIN; versand.clear();
            assertThat(registry.pushRegistryBestEffort(site).reason()).isEqualTo("uebergabe_belegt");
            assertThat(versand).isEmpty();
            con.rollback();
        }
    }
    @Test void fehlerImMarkerIstDurchSavepointIsoliert() {
        JdbcTemplate kaputterZusatz=new JdbcTemplate(ds) {
            @Override public <T> List<T> queryForList(String sql,Class<T> type,Object... args) {
                if (sql.contains("pg_advisory_xact_lock")) return super.queryForList("SELECT 1/0",type);
                return super.queryForList(sql,type,args);
            }
        };
        registry.uebergabe(new QuellenUebergabe(repo,kaputterZusatz,manager,JSON));
        uhr.zeit=HIN; push();
        assertThat(repo.stand(quelle).phase()).isEqualTo("removing");
        assertThat(liest.get(a)).doesNotContain(entity.toString());
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE art='handover'",Integer.class)).isZero();
    }
    @Test void beideNeuenTabellenSindRlsGeschuetztUndKeineBestandsFkWirdVerschaerft() {
        for (String t : List.of("data_source_handover","data_source_box_receipt")) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=?::regclass",
                    Boolean.class,t)).isTrue();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_constraint WHERE conrelid=?::regclass AND contype='f' "
                    + "AND confrelid<>'tenant'::regclass",Integer.class,t)).isZero();
        }
        TenantContext.set(UUID.randomUUID());
        assertThat(repo.stand(quelle)).isNull(); assertThat(repo.rueckmeldung(a)).isNull();
        TenantContext.clear(); assertThat(repo.stand(quelle)).isNull();
    }
    private void neuStarten() { registry.uebergabe(new QuellenUebergabe(repo,app,manager,JSON)); }
    private void push() { registry.pushRegistryBestEffort(site); }
    private void bestaetigen(UUID box) { repo.herzschlag(tenant,box,revisionen.get(box),uhr.instant()); }
    private Zeitraum z(UUID box,Instant von,Instant bis) { return new Zeitraum(UUID.randomUUID(),quelle,box,von,bis); }
    private UUID box(String name) {
        return root.queryForObject("INSERT INTO device(tenant_id,site_id,external_ref,name) VALUES (?,?,?,?) RETURNING id",
                UUID.class,tenant,site,UUID.randomUUID().toString(),name);
    }
    private static DataSource source(String user,String pw) {
        PGSimpleDataSource s=new PGSimpleDataSource(); s.setUrl(DB.getJdbcUrl()); s.setUser(user); s.setPassword(pw); return s;
    }
    static class Uhr extends Clock {
        Instant zeit;
        public ZoneId getZone(){return ZoneOffset.UTC;}
        public Clock withZone(ZoneId zone){return this;}
        public Instant instant(){return zeit;}
    }
}
