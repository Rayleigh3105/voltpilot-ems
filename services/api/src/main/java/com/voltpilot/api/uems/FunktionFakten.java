package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.chargers.ChargingConfigRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.profile.AnwendungKatalog;
import com.voltpilot.api.profile.SiteProfileService;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.uems.FunktionZustandAbleitung.Hauptzaehler;
import com.voltpilot.api.uems.FunktionZustandAbleitung.Komponente;
import com.voltpilot.api.uems.FunktionZustandAbleitung.KomponentenArt;
import com.voltpilot.api.uems.ZustandAbleitung.BoxZustand;
import com.voltpilot.api.verbraucher.SteuerartProjektion;
import com.voltpilot.api.verbraucher.VerbraucherService;
import com.voltpilot.api.web.dto.DeviceDto;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.SiteProfilesDto;
import com.voltpilot.api.web.dto.VerbraucherDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Liest die FAKTEN der Prüfliste „Steuern &amp; Optimieren“ je Anlage und die Eingänge von „Messen &amp;
 * Auswerten“ je Standort (UEMS AP-01 IP-3, §4.7, R2 „Prüfungen sind Fakten, nie Selbstauskunft“) — die
 * Eingänge der Vertragsregel {@link FunktionZustandAbleitung}, nie die Regel selbst. Rein lesend, unter RLS;
 * nur die mandantenfreie Scharfschaltung geht eng auf Mandant UND Anlage über die BYPASSRLS-Verbindung.
 *
 * <p><b>Die Abbildung</b> (Entscheid firstmate 14.09.2026 zu Verbindungstest und Grenze):
 * <ul>
 *   <li><b>Box</b> — jede nicht ausgebaute Box der Anlage; „verbunden“ = ihr letzter EINGANG liegt höchstens
 *       {@link #ONLINE_FENSTER} zurück (dasselbe Fenster wie {@code OverviewRepository}/{@code api.ts}
 *       {@code ONLINE_WINDOW_MS}; eine Box-eigene Kadenz gibt es noch nicht).</li>
 *   <li><b>Hauptzähler</b> — die gemessene, nicht archivierte Messstelle mit Stellung „Hauptzähler“ und
 *       Richtung „Bezug“ an der Anlage HEUTE, mit ihrer Beobachtung aus dem Messstellen-Register (dieselbe
 *       Rechnung wie die Fläche, nie eine zweite).</li>
 *   <li><b>Freigabe</b> — der Speicher über die Steuer-Scharfschaltung (VoltPilot), jeder steuerbare
 *       Verbraucher über seine gespeicherte Freigabe: er steht in der Liste der steuerbaren Komponenten
 *       ({@link VerbraucherService#forSite}) — Katalog mit Schreib-Fähigkeit oder freigegebener
 *       Selbstbau-Schalter.</li>
 *   <li><b>Verbindungstest</b> (AP-01 §4.4) — beim Speicher und beim Katalog-Verbraucher in der Freigabe
 *       enthalten; beim Selbstbau-Schalter ein bestandener Schalt-Test ({@code consumer_audit_event}
 *       {@code switch_tested} „bestanden“) oder die Freigabe selbst (sie setzt einen bestandenen Test
 *       voraus), höchstens {@link #SCHALTTEST_GUELTIG} alt.</li>
 *   <li><b>Grenze</b> — die Anlage hängt heute an einem Netzanschluss mit vereinbarter Leistung, und eine
 *       gesetzte Netzgrenze des Ladeparks liegt nicht darüber. Keine gesetzte Grenze ist der Fakt „keine
 *       Begrenzung, die der vereinbarten Leistung widerspricht“; ein fehlender Netzanschluss ist ein
 *       fehlender Fakt. Die Budget-Rechnung (Grundlast + Hausreserve) kommt mit IP-13.</li>
 *   <li><b>Betriebsweise</b> — die Steuerart je Verbraucher, wenn sie eine Herkunft hat (eigene Policy,
 *       Säule, Anlagen-Standard — nicht „ohne“); das Betriebsmodell = die aktive Karte der Exklusiv-Gruppe
 *       {@code speicher}, sonst der aktive Grundmodus {@code speicher-fahrplan}.</li>
 * </ul>
 */
@Component
public class FunktionFakten {

    /** Das Online-Fenster der Box — wie {@code OverviewRepository.ONLINE_WINDOW}. */
    static final Duration ONLINE_FENSTER = Duration.ofMinutes(5);
    /** Ein Schalt-Test eines Selbstbau-Schalters gilt 90 Tage (AP-01 §4.4). */
    static final Duration SCHALTTEST_GUELTIG = Duration.ofDays(90);

    static final String HAUPTZAEHLER = "Hauptzähler";
    static final String BEZUG = "Bezug";
    private static final String GEMESSEN = "gemessen";
    private static final String ARCHIVIERT = "archiviert";
    private static final String SPEICHER_TYP = "battery-hybrid";
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Wie die Grenze der Anlage heute steht — {@link #PLAUSIBEL} oder der fehlende bzw. widersprechende Fakt. */
    public enum GrenzeBefund {
        PLAUSIBEL,
        KEIN_NETZANSCHLUSS,
        OHNE_VEREINBARTE_LEISTUNG,
        UEBER_VEREINBARTER_LEISTUNG
    }

    /**
     * Die Grenze mit ihren Zahlen, damit die Ablehnung den WEG nennen kann.
     *
     * @param netzanschluss das Kennzeichen des heute gebundenen Netzanschlusses; {@code null} = keiner
     * @param netzgrenzeKw die gesetzte Netzgrenze des Ladeparks; {@code null} = keine gesetzt
     */
    public record Grenze(GrenzeBefund befund, String netzanschluss, BigDecimal vereinbartKw, BigDecimal netzgrenzeKw) {

        public boolean plausibel() {
            return befund == GrenzeBefund.PLAUSIBEL;
        }
    }

    /** Was die Prüfliste über EINE Anlage weiß. */
    public record Anlage(List<BoxZustand> boxen, Hauptzaehler hauptzaehler, List<Komponente> komponenten,
            String betriebsmodell, Grenze grenze) {}

    private final JdbcTemplate jdbc;
    private final JdbcTemplate adminJdbc;
    private final DeviceRepository devices;
    private final MessstelleRegisterService register;
    private final VerbraucherService verbraucher;
    private final EntityRegistryRepository entities;
    private final SiteProfileService profile;
    private final NetzanschlussRepository netzanschluesse;
    private final ChargingConfigRepository ladepark;

    public FunktionFakten(JdbcTemplate jdbc, @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            DeviceRepository devices, MessstelleRegisterService register, VerbraucherService verbraucher,
            EntityRegistryRepository entities, SiteProfileService profile, NetzanschlussRepository netzanschluesse,
            ChargingConfigRepository ladepark) {
        this.jdbc = jdbc;
        this.adminJdbc = adminJdbc;
        this.devices = devices;
        this.register = register;
        this.verbraucher = verbraucher;
        this.entities = entities;
        this.profile = profile;
        this.netzanschluesse = netzanschluesse;
        this.ladepark = ladepark;
    }

    /**
     * Die Fakten der Anlage des Mandanten {@code tenantId} (im {@code TenantContext}) zum Zeitpunkt {@code jetzt}.
     *
     * @param register die Zeilen des Messstellen-Registers, wenn der Aufrufer sie schon hat; {@code null} = hier lesen
     */
    public Anlage anlage(UUID tenantId, UUID siteId, Instant jetzt, ZoneId zone, List<MessstelleDto.RegisterZeile> register) {
        return new Anlage(boxen(siteId, jetzt), hauptzaehler(siteId, register), komponenten(tenantId, siteId, jetzt),
                betriebsmodell(siteId), grenze(siteId, LocalDate.ofInstant(jetzt, zone)));
    }

    /** Die Boxen der Anlage — ohne Box eine leere Liste (der Vertrag sagt dann „es fehlt: Box …“). */
    public List<BoxZustand> boxen(UUID siteId, Instant jetzt) {
        List<BoxZustand> out = new ArrayList<>();
        for (DeviceDto d : devices.findAll()) {
            if (siteId.equals(d.siteId())) {
                boolean verbunden = d.lastSeenAt() != null && !d.lastSeenAt().isBefore(jetzt.minus(ONLINE_FENSTER));
                out.add(new BoxZustand(boxName(d), verbunden));
            }
        }
        return out;
    }

    /** Die Zeilen des Messstellen-Registers heute — EIN Zug für alle Standorte. */
    public List<MessstelleDto.RegisterZeile> register() {
        return register.liste(null, MessstelleRegisterService.Filter.KEINER).register();
    }

    /** Ist die Zeile ein gemessener, nicht archivierter Hauptzähler Bezug der Anlage? */
    static boolean hauptzaehlerDer(MessstelleDto.RegisterZeile z, UUID siteId) {
        return GEMESSEN.equals(z.art()) && !ARCHIVIERT.equals(z.lebenszyklus())
                && z.elektrischeStellung() != null && siteId.equals(z.elektrischeStellung().anlage())
                && HAUPTZAEHLER.equals(z.elektrischeStellung().stellung())
                && z.hauptgroesse() != null && BEZUG.equals(z.hauptgroesse().richtung());
    }

    private Hauptzaehler hauptzaehler(UUID siteId, List<MessstelleDto.RegisterZeile> vorhanden) {
        List<MessstelleDto.RegisterZeile> zeilen = new ArrayList<>(vorhanden != null ? vorhanden : register.liste(null,
                new MessstelleRegisterService.Filter(null, null, siteId, null, false)).register());
        zeilen.sort(Comparator.comparing(MessstelleDto.RegisterZeile::kennzeichen));
        for (MessstelleDto.RegisterZeile z : zeilen) {
            if (hauptzaehlerDer(z, siteId) && z.beobachtung() != null) {
                return new Hauptzaehler(z.kennzeichen(), ZustandAbleitung.LiefertDaten.vonCode(z.beobachtung().zustand()),
                        z.beobachtung().seit() == null ? null : z.beobachtung().seit().toInstant());
            }
        }
        return null;
    }

    private List<Komponente> komponenten(UUID tenantId, UUID siteId, Instant jetzt) {
        List<Komponente> out = new ArrayList<>();
        List<EntityRegistryRepository.EntityRow> zeilen = entities.entitiesForSite(siteId);
        Map<UUID, EntityRegistryRepository.EntityRow> jeId = new HashMap<>();
        boolean scharf = false;
        boolean scharfGelesen = false;
        for (EntityRegistryRepository.EntityRow r : zeilen) {
            jeId.put(r.id(), r);
            if (SPEICHER_TYP.equals(r.entityType())) {
                if (!scharfGelesen) {
                    scharf = scharfgeschaltet(tenantId, siteId);
                    scharfGelesen = true;
                }
                out.add(new Komponente(name(r.label(), "Speicher"), KomponentenArt.SPEICHER, scharf, scharf, null));
            }
        }
        VerbraucherDto liste = verbraucher.forSite(siteId);
        for (VerbraucherDto.Eintrag e : liste.verbraucher()) {
            EntityRegistryRepository.EntityRow r = jeId.get(e.entityId());
            Instant freigabe = r == null ? null : selbstbauFreigabe(r.connectionJson());
            boolean test = r == null || freigabe == null
                    || schalttestGueltig(siteId, e.entityId(), freigabe, jetzt);
            String steuerart = e.steuerart() == null || SteuerartProjektion.HERKUNFT_OHNE.equals(e.steuerart().herkunft())
                    ? null : e.steuerart().quelle();
            out.add(new Komponente(name(e.name(), e.typLabel()), KomponentenArt.VERBRAUCHER, true, test, steuerart));
        }
        return out;
    }

    /** Die Steuer-Scharfschaltung an einem nicht ausgebauten Gerät der Anlage — wie {@link FunktionBestandFakten}. */
    private boolean scharfgeschaltet(UUID tenantId, UUID siteId) {
        Long n = adminJdbc.queryForObject("SELECT count(*) FROM device_control_activation a "
                + "JOIN device d ON d.id = a.device_id AND d.ausgebaut_am IS NULL "
                + "WHERE d.tenant_id = ? AND d.site_id = ?", Long.class, tenantId, siteId);
        return n != null && n > 0;
    }

    /** {@code switch.freigabe.released_at} eines Selbstbau-Schalters; {@code null} = keiner. */
    static Instant selbstbauFreigabe(String connectionJson) {
        if (connectionJson == null || connectionJson.isBlank()) {
            return null;
        }
        try {
            JsonNode at = JSON.readTree(connectionJson).path("switch").path("freigabe").path("released_at");
            return at.isTextual() ? Instant.parse(at.asText()) : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Der jüngste Beleg eines bestandenen Schalt-Tests (Freigabe oder {@code switch_tested}) ist höchstens 90 Tage alt. */
    private boolean schalttestGueltig(UUID siteId, UUID entityId, Instant freigabe, Instant jetzt) {
        Timestamp test = jdbc.queryForObject("SELECT max(occurred_at) FROM consumer_audit_event WHERE site_id = ? "
                + "AND entity_id = ? AND event_type = 'switch_tested' AND detail LIKE 'bestanden%'",
                Timestamp.class, siteId, entityId);
        Instant juengster = test == null || test.toInstant().isBefore(freigabe) ? freigabe : test.toInstant();
        return !juengster.isBefore(jetzt.minus(SCHALTTEST_GUELTIG));
    }

    private String betriebsmodell(UUID siteId) {
        SiteProfilesDto regal = profile.profiles(siteId);
        if (regal == null) {
            return null;
        }
        List<SiteProfilesDto.Profile> karten = new ArrayList<>(regal.profiles());
        karten.addAll(regal.weitere());
        String grundmodus = null;
        for (SiteProfilesDto.Profile k : karten) {
            if (!k.active()) {
                continue;
            }
            if (FunktionBestandFakten.BETRIEBSMODELLE.equals(k.exklusivGruppe())) {
                return k.id();
            }
            if (AnwendungKatalog.SPEICHER_FAHRPLAN.equals(k.id())) {
                grundmodus = k.id();
            }
        }
        return grundmodus;
    }

    /** Die Grenze der Anlage am Tag {@code heute} (Zeitzone des Standorts). */
    public Grenze grenze(UUID siteId, LocalDate heute) {
        NetzanschlussRepository.Bindung bindung = netzanschluesse.bindungenDerAnlage(siteId).stream()
                .filter(b -> b.laeuftAm(heute)).findFirst().orElse(null);
        if (bindung == null) {
            return new Grenze(GrenzeBefund.KEIN_NETZANSCHLUSS, null, null, null);
        }
        BigDecimal vereinbart = netzanschluesse.finde(bindung.netzanschlussId())
                .map(NetzanschlussRepository.Anschluss::vereinbartKw).orElse(null);
        Double gesetzt = ladepark.forSite(siteId).gridLimitKw();
        BigDecimal netzgrenze = gesetzt == null ? null : BigDecimal.valueOf(gesetzt);
        if (vereinbart == null) {
            return new Grenze(GrenzeBefund.OHNE_VEREINBARTE_LEISTUNG, bindung.netzanschlussKennzeichen(), null,
                    netzgrenze);
        }
        if (netzgrenze != null && netzgrenze.compareTo(vereinbart) > 0) {
            return new Grenze(GrenzeBefund.UEBER_VEREINBARTER_LEISTUNG, bindung.netzanschlussKennzeichen(),
                    vereinbart, netzgrenze);
        }
        return new Grenze(GrenzeBefund.PLAUSIBEL, bindung.netzanschlussKennzeichen(), vereinbart, netzgrenze);
    }

    static String boxName(DeviceDto d) {
        return name(d.name(), d.externalRef() == null ? "Box" : "Box " + d.externalRef());
    }

    private static String name(String name, String sonst) {
        return name == null || name.isBlank() ? sonst : name.strip();
    }
}
