package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.measurement.MeasurementConfigPublisher;
import com.voltpilot.api.measurement.MeasurementSelectionService;
import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.Eintrag;
import com.voltpilot.api.repo.DirektvermarktungRepository.Zustellung;
import com.voltpilot.api.repo.DirektvermarktungRepository.ZugangZeile;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * Der Zustell-Abgleich der Direktvermarktung (Vertrag
 * {@code docs/contracts/v2/direktvermarktung-zustellung.md} §2 und §4, Konzept §5.7 "Zustellung"): rechnet
 * je Anlage den SOLL (welche Box soll das retained Partnerprofil halten) und führt den IST nach.
 *
 * <p><b>Soll:</b> die führende Box der Anlage, wenn der Anschluss über den Entwurf hinaus ist, ein aktueller
 * (nicht zurückgezogener) Zugang vorliegt und die Box das Fähigkeitswort {@code direktvermarktung} meldet.
 * Sonst: keine.
 *
 * <p><b>Nachführen in genau dieser Reihenfolge (PS-D22, "ein Zertifikat, eine Anlage"):</b> hält eine
 * falsche Box das Profil (Box-Tausch, Wechsel der führenden Box, Anschluss beendet, Box gelöst), geht ZUERST
 * der Rückzug (leeres retained Payload) an sie - und erst wenn ihre {@code geloescht}-Quittung die
 * Buchführung geräumt hat ({@link DirektvermarktungQuittungListener}), stellt der nächste Abgleich an die
 * neue Box zu. luox sieht so nie zwei Tunnel mit demselben Zertifikat. Eine endgültig verlorene Box kann
 * diese Quittung nie schicken; dieses Loch löst bewusst kein Timer, sondern der Admin (Konzept §7.7 "Zugang
 * neu senden" - noch nicht gebaut, bis dahin die Protokoll-Spur plus Handgriff an der Datenbank).
 *
 * <p>Eine geänderte Fassung (neuer Zugangs-Fingerabdruck nach einem Ersatz-Upload) geht als NEUE Revision an
 * DIESELBE Box - die löscht ihren alten Zugang selbst, quittiert {@code geloescht} für den alten und fragt
 * nach dem neuen; kein Rückzug nötig. Idempotent: ist der zugestellte Fingerabdruck der gewünschte, sendet
 * der Abgleich nichts.
 */
@Service
public class DirektvermarktungZustellung {

    private static final Logger log = LoggerFactory.getLogger(DirektvermarktungZustellung.class);

    /** Das Fähigkeitswort der Zustellung (edge-supports; die Box-Seite ist {@code direktvermarkter.Capability}). */
    public static final String FAEHIGKEIT = "direktvermarktung";

    /** Schema-Fassung des retained Profil-Dokuments. */
    public static final String SCHEMA_VERSION = "1.0";

    /** Die Rolle in Protokollzeilen dieses Abgleichs. */
    static final String ROLLE = "zustellung";

    private final DirektvermarktungRepository repo;
    private final VermarkterLaufzeitKatalog laufzeit;
    private final LeadDeviceService leadDevices;
    private final BoxFaehigkeiten faehigkeiten;
    private final ObjectProvider<DirektvermarktungPublisher> publisher;
    private final ObjectProvider<MeasurementSelectionService> messplan;
    private final ObjectProvider<MeasurementConfigPublisher> messplanPublisher;
    private final ObjectMapper json;
    private final Clock clock;

    public DirektvermarktungZustellung(DirektvermarktungRepository repo, VermarkterLaufzeitKatalog laufzeit,
            LeadDeviceService leadDevices, BoxFaehigkeiten faehigkeiten,
            ObjectProvider<DirektvermarktungPublisher> publisher,
            ObjectProvider<MeasurementSelectionService> messplan,
            ObjectProvider<MeasurementConfigPublisher> messplanPublisher, ObjectMapper json) {
        this(repo, laufzeit, leadDevices, faehigkeiten, publisher, messplan, messplanPublisher, json,
                Clock.systemUTC());
    }

    DirektvermarktungZustellung(DirektvermarktungRepository repo, VermarkterLaufzeitKatalog laufzeit,
            LeadDeviceService leadDevices, BoxFaehigkeiten faehigkeiten,
            ObjectProvider<DirektvermarktungPublisher> publisher,
            ObjectProvider<MeasurementSelectionService> messplan,
            ObjectProvider<MeasurementConfigPublisher> messplanPublisher, ObjectMapper json, Clock clock) {
        this.repo = repo;
        this.laufzeit = laufzeit;
        this.leadDevices = leadDevices;
        this.faehigkeiten = faehigkeiten;
        this.publisher = publisher;
        this.messplan = messplan;
        this.messplanPublisher = messplanPublisher;
        this.json = json;
        this.clock = clock;
    }

    /** Was ein Abgleich einer Anlage getan hat (für Logs und Tests). */
    public enum Ergebnis { NICHTS, ZURUECKGEZOGEN, ZUGESTELLT, WARTET_AUF_QUITTUNG, KEIN_ZIEL }

    /**
     * Gleicht EINE Anlage ab - unter dem {@link TenantContext} des Aufrufers (Takt oder Listener nach einer
     * Quittung). Wirft für keinen erwarteten Zustand.
     */
    public Ergebnis abgleichen(UUID siteId) {
        DirektvermarktungPublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            return Ergebnis.NICHTS;
        }
        UUID tenantId = TenantContext.get();
        Instant jetzt = clock.instant();

        Eintrag aktiv = repo.aktiverOhneEnde(siteId);
        ZugangZeile zugang = null;
        UUID zielBox = null;
        if (aktiv != null && !DirektvermarktungRepository.ENTWURF.equals(aktiv.zustand())) {
            zugang = repo.aktuellerZugang(aktiv.id());
            if (zugang != null) {
                LeadDeviceService.FuehrendeBox lead = leadDevices.fuehrendeBox(siteId);
                if (lead.box() != null && faehigkeiten.kann(lead.box(), FAEHIGKEIT)) {
                    zielBox = lead.box();
                }
            }
        }

        // 1. Rückzug bei jeder Box, die das Profil hält, aber nicht (mehr) halten soll. Das leere retained
        //    Payload ist idempotent; die Buchführung räumt erst die geloescht-Quittung der Box.
        boolean rueckzugOffen = false;
        for (Zustellung z : repo.zustellungenMitBox(siteId)) {
            boolean soll = aktiv != null && z.eintragId().equals(aktiv.id()) && z.boxId().equals(zielBox);
            if (!soll) {
                pub.clearProfil(tenantId, siteId, z.boxId());
                rueckzugOffen = true;
            }
        }
        if (rueckzugOffen) {
            return Ergebnis.WARTET_AUF_QUITTUNG;
        }
        if (zielBox == null || aktiv == null || zugang == null) {
            return Ergebnis.KEIN_ZIEL;
        }

        // 2. Zustellen bzw. neue Fassung: nur, wenn der gewünschte Fingerabdruck noch nicht zugestellt ist.
        Zustellung stand = repo.zustellung(aktiv.id());
        if (stand != null && zielBox.equals(stand.boxId())
                && zugang.fingerabdruck().equals(stand.zugestellterFingerabdruck())) {
            return Ergebnis.NICHTS;
        }
        JsonNode profil = laufzeit.profil(aktiv.partner());
        if (profil == null) {
            log.warn("direktvermarktung: kein Laufzeit-Profil fuer Partner {} - Anlage {} bleibt ohne Zustellung",
                    aktiv.partner(), siteId);
            return Ergebnis.KEIN_ZIEL;
        }
        int revision = (stand == null ? 0 : stand.profilRevision()) + 1;
        byte[] dokument = dokument(tenantId, siteId, zielBox, aktiv.partner(), revision,
                zugang.fingerabdruck(), profil, jetzt);
        if (!pub.publishProfil(tenantId, siteId, zielBox, dokument)) {
            return Ergebnis.NICHTS; // best-effort; der nächste Takt holt nach
        }
        repo.profilZugestellt(aktiv.id(), zielBox, revision, zugang.fingerabdruck(), jetzt);
        repo.protokolliere(tenantId, siteId, aktiv.id(), "profil_zugestellt", null, ROLLE,
                daten("box", zielBox.toString(), "revision", String.valueOf(revision),
                        "fingerabdruck", zugang.fingerabdruck()),
                jetzt);
        // §5.4 "Nachweis": die vier dv.*-Punkte wandern in den Messplan der Zustell-Box.
        messpunkteSetzen(zielBox, true);
        return Ergebnis.ZUGESTELLT;
    }

    /**
     * Nimmt die dv.*-Punkte wieder aus dem Messplan einer Box - gerufen von der geloescht-Quittung
     * ({@code DirektvermarktungQuittungListener}), wenn die Box ihr Profil losgeworden ist.
     */
    public void messpunkteAbwaehlen(UUID boxId) {
        messpunkteSetzen(boxId, false);
    }

    /** Best-effort wie {@code AnlagensteuerungMessplan.zustellen}: der Mess-Abgleich holt sonst nach. */
    private void messpunkteSetzen(UUID boxId, boolean an) {
        MeasurementSelectionService selections = messplan.getIfAvailable();
        if (selections == null) {
            return;
        }
        try {
            selections.direktvermarktungsPunkte(boxId, an);
            MeasurementConfigPublisher p = messplanPublisher.getIfAvailable();
            if (p != null) {
                p.publish(selections.requireDevice(boxId), selections.forPublishing(boxId));
            }
        } catch (RuntimeException e) {
            log.warn("direktvermarktung: Messplan der Box {} nicht sofort nachgefuehrt (der Mess-Abgleich "
                    + "holt nach): {}", boxId, e.getMessage());
        }
    }

    /**
     * Beantwortet die Zugangs-Anfrage einer Box: NUR an die Box, der das Profil zugestellt ist, NUR für den
     * Fingerabdruck des aktuellen Zugangs, einmal je Anfrage, nie retained - und kein Byte des Materials in
     * Log oder Protokoll ({@code DirektvermarktungAnfrageListener} ruft das unter dem Mandanten des Topics).
     */
    public boolean zugangSenden(UUID siteId, UUID deviceId, String fingerabdruck, PartnerzugangSpeicher speicher) {
        DirektvermarktungPublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            return false;
        }
        UUID tenantId = TenantContext.get();
        Instant jetzt = clock.instant();
        Eintrag aktiv = repo.aktiverOhneEnde(siteId);
        if (aktiv == null) {
            return false;
        }
        Zustellung stand = repo.zustellung(aktiv.id());
        if (stand == null || !deviceId.equals(stand.boxId())) {
            log.warn("direktvermarktung: Zugangs-Anfrage von Box {} ohne zugestelltes Profil - verworfen", deviceId);
            return false;
        }
        ZugangZeile zugang = repo.aktuellerZugang(aktiv.id());
        if (zugang == null || !zugang.fingerabdruck().equals(fingerabdruck)) {
            log.warn("direktvermarktung: Zugangs-Anfrage der Anlage {} mit fremdem Fingerabdruck - verworfen",
                    siteId);
            return false;
        }
        JsonNode klartext = speicher.lade(zugang.id()).orElse(null);
        if (klartext == null) {
            return false; // der Speicher hat den Grund (ohne Material) schon geloggt
        }
        ObjectNode antwort = json.createObjectNode();
        antwort.put("schema_version", SCHEMA_VERSION);
        antwort.put("tenant_id", tenantId.toString());
        antwort.put("site_id", siteId.toString());
        antwort.put("device_id", deviceId.toString());
        antwort.put("partner", aktiv.partner());
        antwort.put("zugang_fingerabdruck", zugang.fingerabdruck());
        if (zugang.gueltigBis() != null) {
            antwort.put("gueltig_bis", zugang.gueltigBis().toString());
        }
        antwort.set("gegenstelle", klartext.get("gegenstelle"));
        antwort.set("dateien", klartext.get("dateien"));
        boolean gesendet = pub.publishZugang(tenantId, siteId, deviceId, antwort.toString().getBytes(
                java.nio.charset.StandardCharsets.UTF_8));
        if (gesendet) {
            repo.protokolliere(tenantId, siteId, aktiv.id(), "zugang_angefragt", null, ROLLE,
                    daten("box", deviceId.toString(), "fingerabdruck", fingerabdruck), jetzt);
        }
        return gesendet;
    }

    private byte[] dokument(UUID tenantId, UUID siteId, UUID deviceId, String partner, int revision,
            String fingerabdruck, JsonNode profil, Instant jetzt) {
        ObjectNode doc = json.createObjectNode();
        doc.put("schema_version", SCHEMA_VERSION);
        doc.put("tenant_id", tenantId.toString());
        doc.put("site_id", siteId.toString());
        doc.put("device_id", deviceId.toString());
        doc.put("generated_at", jetzt.toString());
        doc.put("partner", partner);
        doc.put("revision", revision);
        doc.put("zugang_fingerabdruck", fingerabdruck);
        doc.set("profil", profil);
        return doc.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    private String daten(String... kv) {
        ObjectNode n = json.createObjectNode();
        for (int i = 0; i + 1 < kv.length; i += 2) n.put(kv[i], kv[i + 1]);
        return n.toString();
    }

    /** Für Tests: baut das Dokument ohne zu senden. */
    byte[] dokumentFuerTest(UUID tenantId, UUID siteId, UUID deviceId, String partner, int revision,
            String fingerabdruck, JsonNode profil, Instant jetzt) {
        return dokument(tenantId, siteId, deviceId, partner, revision, fingerabdruck, profil, jetzt);
    }
}
