package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundRepository.MitgliedZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.VerbundZeile;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Die Sprungprobe der Gemeinsamen Steuerung, Cloud-Seite (UEMS AP-15 IP-21, Kasten E3 = A, T5, I3, I4; Fälle R1/R19;
 * Vertrag {@code docs/contracts/v2/mqtt-sprungprobe.md}): Auslösen NUR durch die Plattform-Rolle, Auswertung am Netzpunkt
 * der führenden Box ({@code telemetry.power_kw}, Sekundenwerte — nicht die Viertelstunden der Verbund-Bilanz), das
 * Protokoll, die Naht {@link SteuerungsverbundNachweise#sprungprobe}, S1 → S2 nach der letzten bestandenen Probe und
 * die Entwertung bei jeder Strukturänderung (I3, S2 → S1).
 *
 * <p>Die Probe verstellt an einer Live-Anlage etwas — ausgelöst wird sie nur als Handgriff des Betreibers; kein Läufer
 * und kein Test spricht je eine echte Anlage an. Ohne Gemeinsame Steuerung läuft hier nichts (I6).
 */
@Service
public class SprungprobeDienst {

    private final SprungprobeRepository proben;
    private final SteuerungsverbundRepository verbuende;
    private final BoxFaehigkeiten faehigkeiten;
    private final ObjectProvider<SprungprobeVersand> versand;
    private final ObjectMapper mapper;
    private Clock uhr = Clock.systemUTC();

    public SprungprobeDienst(SprungprobeRepository proben, SteuerungsverbundRepository verbuende,
            BoxFaehigkeiten faehigkeiten, ObjectProvider<SprungprobeVersand> versand, ObjectMapper mapper) {
        this.proben = proben;
        this.verbuende = verbuende;
        this.faehigkeiten = faehigkeiten;
        this.versand = versand;
        this.mapper = mapper;
    }

    void uhrStellen(Clock clock) {
        uhr = clock;
    }

    // ------------------------------------------------------------------ Auslösen (I4)

    /**
     * Löst die Probe an der Box aus: Stufe S1, die Box ist Mitglied und meldet {@code sprungprobe}, keine andere Probe
     * läuft in der Anlage, der Netzpunkt der führenden Box ist frisch. Erst wenn der Auftrag zugestellt ist, steht das
     * Protokoll (sonst 409 {@code nicht_zugestellt}, nichts geschrieben).
     */
    @Transactional
    public GemeinsameSteuerungDto.Sprungprobe ausloesen(UUID siteId, UUID box, SprungprobeRegel.Art art,
            BigDecimal sprungKw, ProtokollAkteur wer) {
        if (!verbuende.anlageSichtbar(siteId)) {
            throw GemeinsameSteuerungAbgelehnt.nichtGefunden();
        }
        VerbundZeile v = verbuende.derAnlage(siteId).orElseThrow(() -> GemeinsameSteuerungAbgelehnt.uebergang(
                GemeinsameSteuerungAbgelehnt.NICHT_EINGERICHTET, "Die Anlage hat keine Gemeinsame Steuerung."));
        verbuende.sperren(v.id());
        v = verbuende.finden(v.id()).orElseThrow();
        if (v.stufe() != Stufe.BEOBACHTET) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.NICHT_BEOBACHTET,
                    "Die Sprungprobe läuft in der Stufe „beobachtet“, vor dem Scharfschalten.");
        }
        Instant jetzt = uhr.instant();
        List<MitgliedZeile> mitglieder = verbuende.mitglieder(v.id(), jetzt);
        if (mitglieder.stream().noneMatch(m -> m.deviceId().equals(box))) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.KEIN_MITGLIED,
                    "Diese Box ist kein Mitglied der Gemeinsamen Steuerung.");
        }
        UUID fuehrende = fuehrende(mitglieder).orElseThrow(() -> GemeinsameSteuerungAbgelehnt.uebergang(
                GemeinsameSteuerungAbgelehnt.NICHT_BEOBACHTET, "Die Gemeinsame Steuerung hat keine führende Box."));
        if (!faehigkeiten.kann(box, SprungprobeRegel.FAEHIGKEIT)) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.SPRUNGPROBE_NICHT_GEMELDET,
                    "Die Box meldet die Fähigkeit „sprungprobe“ nicht.");
        }
        if (proben.laeuft(v.id(), jetzt.minusSeconds(SprungprobeRegel.LAUFZEIT_S))) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.SPRUNGPROBE_LAEUFT,
                    "In dieser Anlage läuft schon eine Sprungprobe.");
        }
        if (!proben.netzpunktFrisch(siteId, fuehrende, jetzt.minusSeconds(SprungprobeRegel.FRISCH_S), jetzt)) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.NETZPUNKT_NICHT_FRISCH,
                    "Der Netzzähler der führenden Box hat keinen frischen Wert.");
        }
        UUID tenant = TenantContext.get();
        Instant gueltigBis = jetzt.plusSeconds(SprungprobeRegel.ANNAHME_S);
        UUID id = proben.anlegen(tenant, v.id(), siteId, box, fuehrende, art, sprungKw, jetzt, gueltigBis, wer);
        SprungprobeVersand weg = versand.getIfAvailable();
        String topic = "ems/" + tenant + "/" + siteId + "/" + box + "/v2/" + SprungprobeBericht.AUFTRAG;
        if (weg == null || !weg.senden(topic, auftrag(tenant, siteId, box, id, art, sprungKw, jetzt, gueltigBis))) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.NICHT_ZUGESTELLT,
                    "Der Auftrag hat die Box nicht erreicht.");
        }
        return auskunft(proben.finden(id).orElseThrow(), fuehrende);
    }

    /** Der Auftrag, wie er auf {@code …/v2/sprungprobe} steht (Vertrag §2). */
    byte[] auftrag(UUID tenant, UUID siteId, UUID box, UUID probe, SprungprobeRegel.Art art, BigDecimal sprungKw,
            Instant am, Instant gueltigBis) {
        ObjectNode n = mapper.createObjectNode();
        n.put("schema_version", SprungprobeBericht.SCHEMA_VERSION);
        n.put("tenant_id", tenant.toString());
        n.put("site_id", siteId.toString());
        n.put("device_id", box.toString());
        n.put("probe_id", probe.toString());
        n.put("art", art.code());
        n.put("sprung_kw", sprungKw);
        n.put("dauer_s", SprungprobeRegel.DAUER_S);
        n.put("wiederholungen", SprungprobeRegel.WIEDERHOLUNGEN);
        n.put("pause_s", SprungprobeRegel.PAUSE_S);
        n.put("gueltig_bis", gueltigBis.toString());
        n.put("ts", am.toString());
        return n.toString().getBytes(StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------------ Bericht und Auswertung

    /**
     * Der Bericht der Box: gehört er zu einer laufenden Probe DIESER Box (Topic, Anlage, Art), wird er gegen den
     * Netzpunkt der führenden Box ausgewertet und das Urteil geschrieben; die letzte bestandene Probe hebt S1 auf S2.
     * false = verworfen (unbekannt, fremd, schon ausgewertet, zu spät).
     */
    @Transactional
    public boolean berichtEmpfangen(SprungprobeBericht b, Instant empfangenUm) {
        Optional<SprungprobeRepository.Probe> gefunden = proben.finden(b.probeId());
        if (gefunden.isEmpty()) {
            return false;
        }
        SprungprobeRepository.Probe p = gefunden.get();
        if (!p.tenantId().equals(b.tenantId()) || !p.siteId().equals(b.siteId()) || !p.box().equals(b.box())
                || !p.art().equals(b.art().code()) || !SprungprobeRegel.AUSGELOEST.equals(p.urteil())
                || empfangenUm.isAfter(p.ausgeloestAm().plusSeconds(SprungprobeRegel.LAUFZEIT_S))) {
            return false;
        }
        List<SprungprobeRegel.Sprung> spruenge = new ArrayList<>();
        ArrayNode messwerte = mapper.createArrayNode();
        for (SprungprobeBericht.Sprung s : b.spruenge()) {
            SprungprobeRepository.Mittel vorher = proben.netzpunkt(p.siteId(), p.fuehrendeBox(),
                    s.von().minusSeconds(SprungprobeRegel.VORHER_S), s.von());
            SprungprobeRepository.Mittel waehrend = proben.netzpunkt(p.siteId(), p.fuehrendeBox(),
                    s.von().plusSeconds(SprungprobeRegel.EINSCHWINGEN_S), s.bis());
            spruenge.add(new SprungprobeRegel.Sprung(SprungprobeBericht.eigene(s), wert(vorher), wert(waehrend)));
        }
        SprungprobeRegel.Ergebnis e = SprungprobeRegel.auswerten(b.art(), b.abgebrochen(), b.grund(), spruenge);
        for (int i = 0; i < b.spruenge().size(); i++) {
            SprungprobeBericht.Sprung s = b.spruenge().get(i);
            SprungprobeRegel.Sprung r = spruenge.get(i);
            SprungprobeRegel.Messung m = e.messungen().get(i);
            ObjectNode n = messwerte.addObject();
            n.put("von", s.von().toString());
            n.put("bis", s.bis().toString());
            n.put("eigene_kw", r.eigeneKw());
            n.put("netz_vorher_kw", r.netzVorherKw());
            n.put("netz_waehrend_kw", r.netzWaehrendKw());
            n.put("erwartet_kw", m.erwartetKw());
            n.put("gesehen_kw", m.gesehenKw());
            n.put("toleranz_kw", m.toleranzKw());
            n.put("urteil", m.urteil());
            n.put("grund", m.grund());
        }
        Instant jetzt = uhr.instant();
        if (!proben.auswerten(p.id(), e.urteil(), e.grund(), b.roh(), messwerte.toString(), jetzt)) {
            return false;
        }
        if (SprungprobeRegel.BESTANDEN.equals(e.urteil())) {
            geprueftWennAlleBestanden(p.verbundId(), p.siteId(), jetzt);
        }
        return true;
    }

    /** S1 → S2, wenn jetzt JEDES Mitglied eine geltende bestandene Probe hat (I1 „Sprungprobe je steuernder Box“). */
    private void geprueftWennAlleBestanden(UUID verbundId, UUID siteId, Instant jetzt) {
        verbuende.sperren(verbundId);
        VerbundZeile v = verbuende.finden(verbundId).orElseThrow();
        if (v.stufe() != Stufe.BEOBACHTET) {
            return;
        }
        List<MitgliedZeile> mitglieder = verbuende.mitglieder(verbundId, jetzt);
        if (mitglieder.isEmpty() || !mitglieder.stream().allMatch(m -> gilt(verbundId, m.deviceId(), mitglieder))) {
            return;
        }
        verbuende.stufeSetzen(verbundId, Stufe.GEPRUEFT);
        verbuende.protokoll(TenantContext.get(), verbundId, siteId, "stufe", quote(Stufe.BEOBACHTET.code()),
                quote(Stufe.GEPRUEFT.code()), jetzt, false, GRUND_BESTANDEN, ProtokollAkteur.sprungprobe());
    }

    public static final String GRUND_BESTANDEN = "sprungprobe_bestanden";
    public static final String GRUND_ENTWERTET = "sprungprobe_entwertet";

    // ------------------------------------------------------------------ Naht (T5)

    /** Die Box hat für die heutige Struktur eine bestandene Probe (Naht {@link SteuerungsverbundNachweise}). */
    public boolean gilt(UUID verbundId, UUID box) {
        return gilt(verbundId, box, verbuende.mitglieder(verbundId, uhr.instant()));
    }

    private boolean gilt(UUID verbundId, UUID box, List<MitgliedZeile> mitglieder) {
        Optional<UUID> fuehrende = fuehrende(mitglieder);
        return fuehrende.isPresent() && proben.geltende(verbundId, box)
                .filter(p -> SprungprobeRegel.BESTANDEN.equals(p.urteil()))
                .filter(p -> p.fuehrendeBox().equals(fuehrende.get())).isPresent();
    }

    /** Die jüngste Probe der Box für die Auskunft im GET (IP-24), oder null. */
    public GemeinsameSteuerungDto.Sprungprobe auskunft(UUID verbundId, UUID box, List<MitgliedZeile> mitglieder) {
        return proben.letzte(verbundId, box).map(p -> auskunft(p, fuehrende(mitglieder).orElse(null))).orElse(null);
    }

    private GemeinsameSteuerungDto.Sprungprobe auskunft(SprungprobeRepository.Probe p, UUID fuehrende) {
        boolean gilt = SprungprobeRegel.BESTANDEN.equals(p.urteil()) && p.entwertetAm() == null
                && p.fuehrendeBox().equals(fuehrende)
                && proben.geltende(p.verbundId(), p.box()).map(g -> g.id().equals(p.id())).orElse(false);
        return new GemeinsameSteuerungDto.Sprungprobe(p.id(), p.box(), p.art(), p.sprungKw(), p.dauerS(),
                p.wiederholungen(), utc(p.ausgeloestAm()), p.urteil(), p.grund(), utc(p.ausgewertetAm()),
                utc(p.entwertetAm()), gilt);
    }

    // ------------------------------------------------------------------ Entwerten (I3)

    /**
     * Entwertet die Proben der Boxen — die Stufe stellt der Aufrufer (Einrichten/Ändern setzt ohnehin S0/S1). Die Zahl
     * der entwerteten Proben.
     */
    public int entwerten(UUID verbundId, Collection<UUID> boxen, String grund) {
        return boxen.isEmpty() ? 0 : proben.entwerten(verbundId, boxen, uhr.instant(), GRUND_ENTWERTET + " " + grund);
    }

    /**
     * Ein Zuständigkeitswechsel der Datenquelle {@code quelle} ist geschrieben (T6 vor dem Scharfschalten, Befund aus
     * IP-26): die Proben der betroffenen Boxen ({@link SprungprobeRegel#betroffenBeimWechsel}) sind entwertet, und eine
     * Anlage in S2 geht auf S1 zurück — mit Protokoll und Akteur. Ohne Gemeinsame Steuerung ruft niemand hierher.
     */
    @Transactional
    public void zustaendigkeitGewechselt(VerbundZeile verbund, UUID quelle, boolean steuerquelle, UUID bisher,
            UUID kuenftig, ProtokollAkteur wer) {
        Instant jetzt = uhr.instant();
        List<MitgliedZeile> mitglieder = verbuende.mitglieder(verbund.id(), jetzt);
        Set<String> betroffen = SprungprobeRegel.betroffenBeimWechsel(eintraege(mitglieder), quelle.toString(),
                steuerquelle, bisher == null ? null : bisher.toString(), kuenftig == null ? null : kuenftig.toString());
        if (betroffen.isEmpty()) {
            return;
        }
        entwerten(verbund.id(), betroffen.stream().map(UUID::fromString).toList(), "zustaendigkeit " + quelle);
        verbuende.sperren(verbund.id());
        VerbundZeile v = verbuende.finden(verbund.id()).orElseThrow();
        if (v.stufe() == Stufe.GEPRUEFT) {
            verbuende.stufeSetzen(v.id(), Stufe.BEOBACHTET);
            verbuende.protokoll(TenantContext.get(), v.id(), v.siteId(), "stufe", quote(Stufe.GEPRUEFT.code()),
                    quote(Stufe.BEOBACHTET.code()), jetzt, false, GRUND_ENTWERTET + " zustaendigkeit " + quelle, wer);
        }
    }

    /** Die Einträge der Mitglieder für die reine Regel. */
    public static List<SprungprobeRegel.Eintrag> eintraege(List<MitgliedZeile> mitglieder) {
        return mitglieder.stream().map(m -> new SprungprobeRegel.Eintrag(m.deviceId().toString(), m.rolle().code(),
                m.dataSourceId() == null ? null : m.dataSourceId().toString())).toList();
    }

    private static Optional<UUID> fuehrende(List<MitgliedZeile> mitglieder) {
        return mitglieder.stream().filter(m -> m.rolle() == Rolle.FUEHRT).map(MitgliedZeile::deviceId).findFirst();
    }

    private static BigDecimal wert(SprungprobeRepository.Mittel m) {
        return m.werte() == 0 ? null : m.kw();
    }

    private static java.time.OffsetDateTime utc(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }

    private static String quote(String s) {
        return "\"" + s + "\"";
    }
}
