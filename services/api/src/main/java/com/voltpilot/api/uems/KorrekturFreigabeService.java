package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.KorrekturFreigabeAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.MessreiheFassungen.Fassung;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Korrektur;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Vier Augen bei Korrekturen (UEMS AP-08 IP-15, Entscheid E8 = A): die Einstellung je Unternehmen
 * und die Entscheidung über eine Korrektur — freigeben und zurücknehmen.
 *
 * <h2>Die drei Sätze, die das Paket definieren</h2>
 * <ol>
 *   <li><b>Die Vorgabe ist AUS.</b> {@code unternehmen.vieraugen_freigabe} NULL heißt „nie eingestellt“
 *       und wirkt wie aus; nur der Kundenadministrator schaltet ({@code vieraugen.einstellen}), jede
 *       Änderung steht in {@code ort_aenderung}.</li>
 *   <li><b>Bei AN gibt der Ersteller nicht frei</b> — auch mit Recht (403 {@code zweite_person_noetig}).</li>
 *   <li><b>Ein Unterstützer gibt NIE frei</b> — unabhängig von der Einstellung (403 {@code recht_fehlt}).</li>
 * </ol>
 * Das Urteil fällt {@link KorrekturRechte} über {@link RechteAbleitung}; hier steht die Reihenfolge und
 * der Zeitpunkt.
 *
 * <h2>⚠ Die Einstellung wirkt zum Zeitpunkt der Freigabe</h2>
 *
 * Nicht zum Zeitpunkt des Vorschlags: wer heute vorschlägt und morgen freigibt, unterliegt der Einstellung
 * von morgen. Die Entscheidung liest die Einstellung als ERSTES in ihrer Transaktion mit {@code FOR SHARE}
 * auf der Zeile des Unternehmens; das Umschalten nimmt dieselbe Zeile {@code FOR UPDATE}. Damit gibt es
 * keinen Augenblick, in dem eine Freigabe unter „aus“ geprüft und nach einem „an“ geschrieben wird — die
 * eine wartet auf die andere. Die Freigabe-Fassung trägt die geprüfte Einstellung
 * ({@code freigabe_vieraugen}); ein späteres Umschalten ändert keine gespeicherte Freigabe.
 *
 * <h2>Die Reihenfolge</h2>
 *
 * Kundenbereich gewählt → Korrektur da (sonst 404, auch für eine fremde) → Recht mit Einstellung und
 * Ersteller (403) → Begründung (422) → Stand (409) → schreiben. Das Protokoll der vier Angaben ist die
 * Korrektur selbst: Ersteller = Fassung 1, Freigeber, Zeitpunkt und Begründung = die neue Fassung.
 */
@Service
public class KorrekturFreigabeService {

    private static final String OBJEKT = "unternehmen";
    private static final String FELD = "vieraugen_freigabe";

    private final JdbcTemplate jdbc;
    private final MessreiheKorrekturRepository korrekturen;
    private final OrtProtokoll protokoll;
    private final BezugswertService bezugswerte;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public KorrekturFreigabeService(JdbcTemplate jdbc, MessreiheKorrekturRepository korrekturen,
            OrtProtokoll protokoll, BezugswertService bezugswerte, PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.korrekturen = korrekturen;
        this.protokoll = protokoll;
        this.bezugswerte = bezugswerte;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** Nur für Tests. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Die Einstellung: {@code an} gilt; {@code vorgabe} = nie eingestellt (dann ist {@code an} false). */
    public record VierAugen(boolean an, boolean vorgabe) {

        static VierAugen aus(Boolean gespeichert) {
            return new VierAugen(Boolean.TRUE.equals(gespeichert), gespeichert == null);
        }
    }

    /**
     * Eine Entscheidung und ihr Protokoll: die Korrektur mit allen Fassungen, die neue Fassung und die
     * Einstellung, unter der entschieden wurde ({@code null} beim Zurücknehmen — dort sperrt sie nur den
     * Bearbeiter und wird nicht mitgeschrieben).
     */
    public record Entscheidung(Korrektur korrektur, Fassung fassung, Boolean vierAugen) {

        public boolean vonErsteller() {
            String ersteller = korrektur.ersteller().sub();
            return ersteller != null && ersteller.equals(fassung.akteur().sub());
        }
    }

    // ------------------------------------------------------------------ Einstellung

    /** {@code GET}: lesend, ohne eigene Kennung. Ohne Unternehmen-Zeile gilt die Vorgabe. */
    public VierAugen einstellung() {
        UUID tenant = kundenbereich();
        return VierAugen.aus(erste(jdbc.queryForList("SELECT vieraugen_freigabe FROM unternehmen WHERE tenant_id = ?",
                Boolean.class, tenant)));
    }

    /**
     * {@code PUT}: nur der Kundenadministrator ({@code vieraugen.einstellen}); ändert sich nichts, wird nichts
     * geschrieben. Von der Vorgabe auf „aus“ zu schalten IST eine Änderung (sie steht danach im Protokoll).
     */
    public VierAugen einstellen(Boolean an, ProtokollAkteur wer) {
        UUID tenant = kundenbereich();
        Instant jetzt = uhr.instant();
        DarfErgebnis d = KorrekturRechte.darf(wer, KorrekturRechte.VIERAUGEN_EINSTELLEN, jetzt);
        if (!d.darf()) {
            throw KorrekturFreigabeAbgelehnt.rechte(d);
        }
        if (an == null) {
            throw KorrekturFreigabeAbgelehnt.anfrage("vieraugen");
        }
        return transaktion.execute(tx -> {
            List<Map<String, Object>> zeile = jdbc.queryForList("SELECT id, zeitzone, vieraugen_freigabe "
                    + "FROM unternehmen WHERE tenant_id = ? FOR UPDATE", tenant);
            if (zeile.isEmpty()) {
                throw KorrekturFreigabeAbgelehnt.von(Ablehnung.UNTERNEHMEN_NICHT_ANGELEGT);
            }
            Boolean alt = (Boolean) zeile.get(0).get(FELD);
            if (an.equals(alt)) {
                return VierAugen.aus(alt);
            }
            UUID id = (UUID) zeile.get(0).get("id");
            ZoneId zone = ZoneId.of((String) zeile.get(0).get("zeitzone"));
            jdbc.update("UPDATE unternehmen SET vieraugen_freigabe = ? WHERE id = ?", an, id);
            Map<String, Object> vorher = new LinkedHashMap<>();
            vorher.put(FELD, alt);
            protokoll.eintragen(tenant, OBJEKT, id, "bearbeitet", vorher, Map.of(FELD, an),
                    jetzt.atZone(zone).toLocalDate(), zone, jetzt, wer);
            return VierAugen.aus(an);
        });
    }

    // ------------------------------------------------------------------ Entscheidung

    /** {@code POST …/freigeben} ({@code korrektur.freigeben}): unter der Einstellung DIESES Augenblicks. */
    public Entscheidung freigeben(String kennung, String begruendung, ProtokollAkteur wer) {
        UUID tenant = kundenbereich();
        Instant jetzt = uhr.instant();
        return entscheide(() -> transaktion.execute(tx -> {
            boolean an = einstellungGesperrt(tenant);
            if (kennung.startsWith(BezugsgroesseRegeln.BERICHTIGUNG_PRAEFIX + "-")) {
                return bezugswertFreigeben(tenant, kennung, begruendung, wer, an, jetzt);
            }
            Korrektur k = korrektur(tenant, kennung);
            DarfErgebnis d = KorrekturRechte.entscheiden(wer, KorrekturRechte.KORREKTUR_FREIGEBEN,
                    k.ersteller().sub(), an, jetzt);
            if (!d.darf()) {
                throw KorrekturFreigabeAbgelehnt.rechte(d);
            }
            pruefeBegruendung(begruendung, "begruendung");
            pruefeStand(k, EreignisVokabular.KORREKTUR_STATUS.get(0));
            Korrektur neu = korrekturen.freigeben(tenant, kennung, begruendung, wer, an);
            return new Entscheidung(neu, letzte(neu), an);
        }));
    }

    /** {@code POST …/zuruecknehmen} ({@code korrektur.zuruecknehmen}): der Stand VOR der Korrektur (Kaskade). */
    public Entscheidung zuruecknehmen(String kennung, String grund, ProtokollAkteur wer) {
        UUID tenant = kundenbereich();
        Instant jetzt = uhr.instant();
        return entscheide(() -> transaktion.execute(tx -> {
            boolean an = einstellungGesperrt(tenant);
            Korrektur k = korrektur(tenant, kennung);
            DarfErgebnis d = KorrekturRechte.entscheiden(wer, KorrekturRechte.KORREKTUR_ZURUECKNEHMEN,
                    k.ersteller().sub(), an, jetzt);
            if (!d.darf()) {
                throw KorrekturFreigabeAbgelehnt.rechte(d);
            }
            pruefeBegruendung(grund, "grund");
            pruefeStand(k, EreignisVokabular.KORREKTUR_STATUS.get(1));
            Korrektur neu = korrekturen.zuruecknehmen(tenant, kennung, grund, wer);
            return new Entscheidung(neu, letzte(neu), null);
        }));
    }

    /**
     * AP-09 IP-7: die Berichtigung eines Bezugsgrößen-Werts ({@code BK-…}) — dieselbe Route, dieselbe Reihenfolge
     * (Vorgang des eigenen Kundenbereichs → Recht mit Einstellung und Ersteller → Begründung → Stand {@code vorschlag}),
     * dieselben Ablehnungen. Die Wert-Fassung und das Ereignis {@code correction} schreibt {@link BezugswertService}
     * in DIESER Transaktion.
     */
    private Entscheidung bezugswertFreigeben(UUID tenant, String kennung, String begruendung, ProtokollAkteur wer,
            boolean an, Instant jetzt) {
        BezugswertRepository.Berichtigung v = bezugswerte.vorgang(tenant, kennung)
                .orElseThrow(() -> KorrekturFreigabeAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        DarfErgebnis d = KorrekturRechte.entscheiden(wer, KorrekturRechte.KORREKTUR_FREIGEBEN, v.ersteller().sub(), an,
                jetzt);
        if (!d.darf()) {
            throw KorrekturFreigabeAbgelehnt.rechte(d);
        }
        pruefeBegruendung(begruendung, "begruendung");
        if (!EreignisVokabular.KORREKTUR_STATUS.get(0).equals(v.status())) {
            throw KorrekturFreigabeAbgelehnt.von(Ablehnung.STATUS_PASST_NICHT, Map.of("status", v.status()));
        }
        Korrektur neu = bezugswerte.freigeben(tenant, v, begruendung, wer, an);
        return new Entscheidung(neu, letzte(neu), an);
    }

    // ------------------------------------------------------------------ Hilfen

    private static UUID kundenbereich() {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw KorrekturFreigabeAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
        return tenant;
    }

    /** Die Einstellung mit Zeilensperre bis zum Ende der Transaktion — das Umschalten wartet. */
    private boolean einstellungGesperrt(UUID tenant) {
        return Boolean.TRUE.equals(erste(jdbc.queryForList("SELECT vieraugen_freigabe FROM unternehmen "
                + "WHERE tenant_id = ? FOR SHARE", Boolean.class, tenant)));
    }

    /** Der gespeicherte Wert der einen Unternehmen-Zeile — {@code null} ohne Zeile ODER ohne Einstellung. */
    private static Boolean erste(List<Boolean> werte) {
        return werte.isEmpty() ? null : werte.get(0);
    }

    private Korrektur korrektur(UUID tenant, String kennung) {
        return korrekturen.lies(tenant, kennung)
                .orElseThrow(() -> KorrekturFreigabeAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Dieselbe Spanne wie {@code messreihe_korrektur_text_gueltig}: 10 bis 500 Zeichen, nicht leer. */
    private static void pruefeBegruendung(String text, String feld) {
        if (text == null || text.isBlank()) {
            throw KorrekturFreigabeAbgelehnt.von(Ablehnung.BEGRUENDUNG_FEHLT, Map.of("feld", feld));
        }
        int zeichen = text.codePointCount(0, text.length());
        if (zeichen < 10 || zeichen > 500) {
            throw KorrekturFreigabeAbgelehnt.von(Ablehnung.BEGRUENDUNG_FEHLT, Map.of("feld", feld, "zeichen", zeichen));
        }
    }

    private static void pruefeStand(Korrektur k, String noetig) {
        if (!noetig.equals(k.status())) {
            throw KorrekturFreigabeAbgelehnt.von(Ablehnung.STATUS_PASST_NICHT, Map.of("status", k.status()));
        }
    }

    private static Fassung letzte(Korrektur k) {
        return k.fassungen().get(k.fassungen().size() - 1);
    }

    /** Zwei gleichzeitige Entscheidungen schreiben dieselbe Fassung — eine gewinnt (Primärschlüssel). */
    private static Entscheidung entscheide(Supplier<Entscheidung> arbeit) {
        try {
            return arbeit.get();
        } catch (DuplicateKeyException e) {
            throw KorrekturFreigabeAbgelehnt.von(Ablehnung.GLEICHZEITIG);
        }
    }
}
