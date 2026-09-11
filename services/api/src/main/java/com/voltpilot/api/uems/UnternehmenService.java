package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.StandortLesemodell.Adresse;
import com.voltpilot.api.uems.StandortLesemodell.UnternehmenSicht;
import com.voltpilot.api.web.dto.UnternehmenDto;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * {@code PUT /api/v1/unternehmen} (UEMS AP-02 IP-4): das Unternehmen des Kundenbereichs
 * bearbeiten — Name, Kurzname, Zeitzonen-Vorgabe, Sitz, Rechtsform (§4.1). Kein Anlegen,
 * kein Löschen: das Unternehmen entsteht mit dem Kundenbereich ({@code
 * TenantRepository.create}) und endet nur mit seinem Offboarding; die App-Rolle hat kein
 * INSERT und kein DELETE auf {@code unternehmen}.
 *
 * <p>EINE Transaktion und GENAU EIN Protokolleintrag „bearbeitet" mit alt/neu NUR der
 * geänderten Felder ({@link OrtProtokoll}); ändert sich nichts, wird nichts geschrieben. Die
 * Zeitzonen-Vorgabe ist nur die Vorbelegung neuer Standorte — kein bestehender Standort
 * ändert sich mit ihr (Regel 11).
 */
@Service
public class UnternehmenService {

    private static final String OBJEKT = "unternehmen";

    private final UnternehmenRepository unternehmen;
    private final StandortLesemodellService lesemodell;
    private final OrtProtokoll protokoll;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public UnternehmenService(UnternehmenRepository unternehmen, StandortLesemodellService lesemodell,
            OrtProtokoll protokoll, PlatformTransactionManager transactionManager) {
        this.unternehmen = unternehmen;
        this.lesemodell = lesemodell;
        this.protokoll = protokoll;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** Nur für Tests. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    public UnternehmenSicht bearbeiten(UnternehmenDto.Bearbeiten b, ProtokollAkteur wer) {
        UnternehmenRepository.Unternehmen u = unternehmen.desKundenbereichs().orElseThrow(() ->
                OrtAbgelehnt.nichtGefunden(TenantContext.get() == null ? "Kein Kundenbereich gewählt."
                        : "Für diesen Kundenbereich ist noch kein Unternehmen angelegt."));
        if (b == null) {
            throw OrtAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        String name = OrtFelder.name(b.name(), "name");
        String kurzname = OrtFelder.text(b.kurzname(), "kurzname", OrtFelder.KURZNAME_HOECHSTENS, "Der Kurzname");
        String zeitzone = OrtFelder.zeitzone(b.zeitzone(), "zeitzone", null);
        Adresse sitz = OrtFelder.adresse(b.sitz(), "sitz");
        String rechtsform = OrtFelder.text(b.rechtsform(), "rechtsform", OrtFelder.RECHTSFORM_HOECHSTENS,
                "Die Rechtsform");

        UnternehmenRepository.Unternehmen neu = new UnternehmenRepository.Unternehmen(u.id(), name, kurzname,
                zeitzone, sitz.strasse(), sitz.plz(), sitz.ort(), sitz.land(), rechtsform);
        Map<String, Object> vorher = felder(u);
        Map<String, Object> nachher = felder(neu);
        Map<String, Object> alt = new LinkedHashMap<>();
        Map<String, Object> geaendert = new LinkedHashMap<>();
        nachher.forEach((feld, wert) -> {
            if (!Objects.equals(vorher.get(feld), wert)) {
                alt.put(feld, vorher.get(feld));
                geaendert.put(feld, wert);
            }
        });
        if (!geaendert.isEmpty()) {
            Instant jetzt = uhr.instant();
            ZoneId zone = ZoneId.of(zeitzone);
            LocalDate heute = jetzt.atZone(zone).toLocalDate();
            UUID tenant = TenantContext.get();
            transaktion.execute(tx -> {
                if (!unternehmen.bearbeiten(u.id(), neu)) {
                    throw OrtAbgelehnt.nichtGefunden("Für diesen Kundenbereich ist noch kein Unternehmen angelegt.");
                }
                protokoll.eintragen(tenant, OBJEKT, u.id(), "bearbeitet", alt, geaendert, heute, zone, jetzt, wer);
                return u.id();
            });
        }
        return lesemodell.unternehmen().orElseThrow(() -> OrtAbgelehnt.nichtGefunden("Kein Kundenbereich gewählt."));
    }

    /** Die Felder, wie das Protokoll sie nennt (snake_case). */
    private static Map<String, Object> felder(UnternehmenRepository.Unternehmen u) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", u.name());
        m.put("kurzname", u.kurzname());
        m.put("zeitzone", u.zeitzone());
        Map<String, Object> sitz = new LinkedHashMap<>();
        sitz.put("strasse", u.sitzStrasse());
        sitz.put("plz", u.sitzPlz());
        sitz.put("ort", u.sitzOrt());
        sitz.put("land", u.sitzLand());
        m.put("sitz", sitz);
        m.put("rechtsform", u.rechtsform());
        return m;
    }
}
