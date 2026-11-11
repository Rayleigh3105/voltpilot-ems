package com.voltpilot.api.geraete;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BerichtsBelege;
import com.voltpilot.api.uems.MessreihenBelege;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * „Endgültig löschen" einer AUSGEBAUTEN Box, die nie Daten geliefert hat (vp-box-endgueltig-loeschen;
 * Captain 11.11.2026). Der vierte Löschweg neben Abmelden, Purge und Anlage entfernen
 * ({@code docs/agents/root/uems-loeschwege.md}): anders als Abmelden verschwindet die ZEILE - erlaubt
 * nur, wenn {@link BoxDatenBestand} in keiner Aufzeichnung etwas findet und keine Beleg-Regel
 * ({@link MessreihenBelege}, {@link BerichtsBelege}) die Box schützt. Im Zweifel „hat Daten".
 *
 * <p><b>Mandantentrennung</b> wie {@link BoxLoesenService}: der Befund kommt aus
 * {@link AdminBoxEndgueltigRepository} (BYPASSRLS, read-only, über jeden Mandanten); die Löschung und
 * das Protokoll laufen mit GESETZTEM {@link TenantContext} über die RLS-gezäunte App-Rolle. Die
 * DB-Rückversicherung bleibt: jede RESTRICT-Tabelle lehnt das DELETE selbst ab (23503), fände die
 * Anwendung doch nichts - der Dienst übersetzt das in denselben 409.
 *
 * <p>Werkstatt-, Fernwartungs- und Einrichtungs-Protokolle tragen keine {@code device_id} bzw. keinen
 * Fremdschlüssel (sie adressieren die Kennung) und bleiben dadurch von selbst; die Kennung bleibt
 * wieder anmeldbar wie heute nach dem Ausbau (der eindeutige Index gilt nur für nicht ausgebaute).
 */
@Service
public class BoxEndgueltigLoeschenService {

    private static final Logger log = LoggerFactory.getLogger(BoxEndgueltigLoeschenService.class);

    private final AdminBoxEndgueltigRepository admin;
    private final BoxEndgueltigRepository repo;
    private final DeviceRepository devices;
    private final MessreihenBelege messreihenBelege;
    private final BerichtsBelege berichtsBelege;
    private final TransactionTemplate tx;

    public BoxEndgueltigLoeschenService(AdminBoxEndgueltigRepository admin, BoxEndgueltigRepository repo,
            DeviceRepository devices, MessreihenBelege messreihenBelege, BerichtsBelege berichtsBelege,
            PlatformTransactionManager transactions) {
        this.admin = admin;
        this.repo = repo;
        this.devices = devices;
        this.messreihenBelege = messreihenBelege;
        this.berichtsBelege = berichtsBelege;
        this.tx = new TransactionTemplate(transactions);
    }

    /** Der Befund für die Akte: die Box aus dem Kopf (jüngste ausgebaute dieser Referenz) samt Datenarten. */
    public record Befund(BoxDatenBestand.Zeile zeile, List<String> daten) {
        public boolean loeschbar() {
            return daten.isEmpty();
        }
    }

    /** Für das GET - informativ, vor jedem Sperren; 404, wenn keine ausgebaute Box diese Referenz trägt. */
    public Befund befund(String externalRef) {
        BoxDatenBestand.Zeile zeile = admin.ausgebauteBox(externalRef)
                .orElseThrow(() -> unbekannt(externalRef));
        return imMandanten(zeile.tenantId(), () -> new Befund(zeile, mitBelegen(zeile)));
    }

    public record Ergebnis(String externalRef, UUID deviceId, Instant geloeschtAm, boolean bereitsGeloescht) {
    }

    /**
     * Löschen (POST), adressiert über Referenz UND Geräte-ID aus dem Befund - idempotent: ist GENAU
     * diese Box schon gelöscht (Protokoll-Eintrag), antwortet der Weg mit demselben Ergebnis statt
     * 404; ein Doppelklick oder eine Wiederholung nach Netzfehler löscht nie eine zweite Box.
     */
    public Ergebnis loeschen(String externalRef, UUID deviceId, ProtokollAkteur akteur) {
        if (deviceId == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Die Geräte-ID fehlt.");
        }
        var vorab = admin.ausgebauteBox(externalRef, deviceId);
        if (vorab.isEmpty()) {
            var geloescht = admin.protokoll(deviceId)
                    .filter(g -> g.externalRef().equals(externalRef));
            if (geloescht.isPresent()) {
                return new Ergebnis(externalRef, deviceId, geloescht.get().geloeschtAm(), true);
            }
            if (admin.nichtAusgebauteBox(externalRef, deviceId)) {
                throw BoxEndgueltigAbgelehnt.nichtAusgebaut();
            }
            throw unbekannt(externalRef);
        }
        BoxDatenBestand.Zeile zeile = vorab.get();
        return imMandanten(zeile.tenantId(),
                () -> tx.execute(status -> loeschenGesperrt(zeile, akteur)));
    }

    private Ergebnis loeschenGesperrt(BoxDatenBestand.Zeile vorab, ProtokollAkteur akteur) {
        devices.lockReference(vorab.externalRef());
        BoxDatenBestand.Zeile zeile = admin.ausgebauteBox(vorab.externalRef(), vorab.deviceId())
                .orElseThrow(() -> unbekannt(vorab.externalRef()));
        List<String> daten = mitBelegen(zeile);
        if (!daten.isEmpty()) {
            throw BoxEndgueltigAbgelehnt.hatDaten(daten);
        }
        Instant geloeschtAm;
        try {
            if (!devices.endgueltigLoeschen(zeile.deviceId())) {
                // RLS verbirgt die Box oder sie ist zwischen Befund und Sperre verschwunden.
                throw unbekannt(zeile.externalRef());
            }
            List<String> geprueft = new ArrayList<>();
            geprueft.add(BoxDatenBestand.HERZSCHLAG);
            geprueft.addAll(BoxDatenBestand.AUFZEICHNUNGEN.keySet());
            geprueft.add("messstellen_belege");
            geprueft.add("berichtsstaende");
            geloeschtAm = repo.protokollieren(new BoxEndgueltigRepository.Eintrag(
                    zeile.tenantId(), zeile.tenantName(), zeile.siteId(), zeile.siteName(),
                    zeile.deviceId(), zeile.externalRef(), zeile.verbundenAm(), zeile.ausgebautAm(),
                    akteur == null ? null : akteur.sub(), akteur == null ? "VoltPilot" : akteur.name(),
                    geprueft));
        } catch (DataIntegrityViolationException ex) {
            // Die DB-Rückversicherung (ON DELETE RESTRICT, V20260913150000): eine Tabelle, die die
            // Anwendungs-Regel nicht kennt, trägt doch eine Zeile. Nichts geändert.
            throw BoxEndgueltigAbgelehnt.hatDaten(List.of("weitere_aufzeichnungen"));
        }
        log.info("Ausgebaute Box {} ({}) endgültig gelöscht - nie Daten geliefert; Werkstatt- und "
                + "Fernwartungs-Protokolle bleiben", zeile.externalRef(), zeile.deviceId());
        return new Ergebnis(zeile.externalRef(), zeile.deviceId(), geloeschtAm, false);
    }

    /**
     * Die beiden Beleg-Regeln zu den Datenarten dazu - unter RLS im Mandanten der Box, dieselben
     * Kundensätze wie Purge und Anlage entfernen ({@code messstellen_belege}, {@code berichtsstaende}).
     */
    private List<String> mitBelegen(BoxDatenBestand.Zeile zeile) {
        List<String> daten = new ArrayList<>(zeile.datenarten());
        List<MessreihenBelege.Beleg> belege = messreihenBelege.derBox(zeile.deviceId());
        if (!belege.isEmpty()) {
            daten.add("messstellen_belege");
        }
        if (!berichtsBelege.derMessstellen(belege).isEmpty()) {
            daten.add("berichtsstaende");
        }
        return List.copyOf(daten);
    }

    private <T> T imMandanten(UUID tenantId, java.util.function.Supplier<T> arbeit) {
        UUID vorher = TenantContext.get();
        try {
            TenantContext.set(tenantId);
            return arbeit.get();
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    private static ResponseStatusException unbekannt(String externalRef) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND,
                "Keine ausgebaute Box mit der Kennung " + externalRef + ".");
    }
}
