package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.MassnahmeDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Bewertung einer Maßnahme (UEMS AP-18 IP-12, WK6, E6 = A): ein Stand Nr. n — das Wort einer Person
 * ({@code belegt · nicht_belegt · nicht_messbar}) mit Begründung neben der Zahl des Systems. Die Kopie ist die Wirkung
 * ({@link MassnahmeWirkung}) zum Bewertungstag in der Form der Referenzdatei 1.9 ({@code massnahmen[].bewertungen[].kopie}),
 * kanonisch ({@link BerichtRegeln#kanonisch}) mit {@code sha256:}-Prüfsumme; eine zweite Bildung am selben Tag ist
 * byte-gleich. Ein Stand wird nie zurückgenommen, ein neuer ist Nr. n + 1 (Trigger aus IP-9).
 *
 * <p><b>Vier-Augen</b> nach {@code unternehmen.vieraugen_freigabe} wie die Energieziel-Bewertung (IP-7): bewerten ist
 * dann ein Antrag, eine zweite Person (Rolle KA/EM) bestätigt oder lehnt ab — nie, wer beantragt hat, und nie der
 * Verantwortliche der Maßnahme. Recht {@code verbesserung.abschliessen} an der Geltung der Kennzahl bzw. am Standort der
 * Maßnahme. Ohne Messgrundlage nur {@code nicht_messbar} (M4, E2 = A). Die Uhr ist die der Kennzahlen.
 */
@Service
public class MassnahmeBewertung {

    static final String ABSCHLIESSEN = "verbesserung.abschliessen";
    /** {@code massnahme_bewertung_entscheidung_chk}: die zweite Person hat eine dieser Rollen. */
    private static final Set<String> ZWEITE_ROLLEN = Set.of("kundenadministrator", "energiemanager");
    /** {@code massnahme_bewertung_person_chk}: die Rolle der Person, die bewertet oder beantragt, sonst keine. */
    private static final Set<String> FREIGABE_ROLLEN = Set.of("kundenadministrator", "energiemanager",
            "voltpilot_betrieb");
    /** Die Einheit, deren Mengen die Kopie in ganzen Zahlen trägt (SP4, wie die Energieziel-Bewertung). */
    private static final String KWH = "kWh";

    private final MassnahmeService massnahmen;
    private final MassnahmeWirkung wirkung;
    private final KennzahlService kennzahlen;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;

    public MassnahmeBewertung(MassnahmeService massnahmen, MassnahmeWirkung wirkung, KennzahlService kennzahlen,
            JdbcTemplate jdbc, PlatformTransactionManager transactionManager, ObjectMapper json) {
        this.massnahmen = massnahmen;
        this.wirkung = wirkung;
        this.kennzahlen = kennzahlen;
        this.jdbc = jdbc;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    /** Alle Stände nach Nr. — auch beantragte und abgelehnte; Sichtbarkeit wie die Maßnahme (404). */
    public MassnahmeDto.Bewertungen liste(UUID id) {
        Map<String, Object> z = massnahmen.zeile(id, null, null);
        ZoneId zone = massnahmen.zone();
        List<MassnahmeDto.Bewertung> staende = jdbc.queryForList(MassnahmeService.STAND_SPALTEN
                + "WHERE massnahme_id = ? ORDER BY stand_nr", id).stream().map(r -> massnahmen.stand(r, zone)).toList();
        return new MassnahmeDto.Bewertungen(id, (String) z.get("kennzeichen"), (String) z.get("zustand"), staende);
    }

    /** Ohne Vier-Augen: der Stand Nr. n ist sofort bewertet; mit Vier-Augen 409 {@code vieraugen_beantragen}. */
    public MassnahmeDto.Massnahme bewerten(UUID id, MassnahmeDto.Bewerten b, ProtokollAkteur wer) {
        return bewerten(id, b, wer, false);
    }

    /** Mit Vier-Augen: der Stand Nr. n ist ein Antrag; ohne Vier-Augen 409 {@code vieraugen_aus}. */
    public MassnahmeDto.Massnahme beantragen(UUID id, MassnahmeDto.Bewerten b, ProtokollAkteur wer) {
        return bewerten(id, b, wer, true);
    }

    private MassnahmeDto.Massnahme bewerten(UUID id, MassnahmeDto.Bewerten b, ProtokollAkteur wer, boolean antrag) {
        Map<String, Object> z = massnahmen.zeile(id, ABSCHLIESSEN, wer);
        String kennzeichen = (String) z.get("kennzeichen");
        umgesetzt(kennzeichen, (String) z.get("zustand"));
        String ergebnis = b == null ? null : b.ergebnis();
        if (ergebnis == null || !VerbesserungRegeln.VOKABULARE.get("wirkung_ergebnis").contains(ergebnis)) {
            throw VerbesserungAbgelehnt.anfrage("ergebnis");
        }
        String begruendung = begruendung(b.begruendung());
        boolean mitMessgrundlage = z.get("kennzahl_id") != null;
        if (!mitMessgrundlage && !"nicht_messbar".equals(ergebnis)) {
            throw VerbesserungAbgelehnt.fachlich("ohne_messgrundlage", "Ohne Messgrundlage ist die Wirkung nicht "
                    + "messbar — bewertet wird sie nur als „nicht messbar“.", Map.of("kennzeichen",
                            MassnahmeService.OHNE_KENNZEICHEN, "ergebnis", ergebnis));
        }
        String kopie = mitMessgrundlage ? BerichtRegeln.kanonisch(kopie(wirkung.lesen(id, Set.of(), null))) : null;
        String pruefsumme = kopie == null ? null : BerichtRegeln.pruefsumme(kopie);
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = kennzahlen.jetzt();
        transaktion.executeWithoutResult(s -> {
            String zustand = gesperrt(id);
            umgesetzt(kennzeichen, zustand);
            if (antragOffen(id) != null) {
                throw new VerbesserungAbgelehnt(409, "bewertung_beantragt", "Über die beantragte Bewertung entscheidet "
                        + "eine zweite Person.", Map.of("kennzeichen", kennzeichen));
            }
            boolean vierAugen = vierAugen(tenant);
            if (vierAugen && !antrag) {
                throw new VerbesserungAbgelehnt(409, "vieraugen_beantragen", "Mit Vier-Augen-Freigabe beantragen Sie "
                        + "die Bewertung; eine zweite Person bestätigt sie.", Map.of("kennzeichen", kennzeichen));
            }
            if (!vierAugen && antrag) {
                throw new VerbesserungAbgelehnt(409, "vieraugen_aus", "Ohne Vier-Augen-Freigabe bewerten Sie die "
                        + "Maßnahme direkt.", Map.of("kennzeichen", kennzeichen));
            }
            Integer nr = jdbc.queryForObject("INSERT INTO massnahme_bewertung (tenant_id, massnahme_id, kennzahl_id, "
                    + "bezugsbasis_id, fassung, wirkung, pruefsumme, ergebnis, begruendung, vieraugen, status, freigabe_sub, "
                    + "freigabe_name, freigabe_rolle, freigabe_art, freigabe_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                    + "?, ?, ?, ?, ?) RETURNING stand_nr", Integer.class, tenant, id, z.get("kennzahl_id"),
                    z.get("bezugsbasis_id"), z.get("fassung"), kopie, pruefsumme, ergebnis, begruendung, antrag,
                    antrag ? "beantragt" : "bewertet", wer.sub(), wer.name(),
                    FREIGABE_ROLLEN.contains(wer.rolle()) ? wer.rolle() : null, wer.art(), Timestamp.from(jetzt));
            String neuerZustand = antrag ? zustand : bewertet(id, zustand);
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("zustand", neuerZustand);
            neu.put("stand_nr", nr);
            neu.put("ergebnis", ergebnis);
            neu.put("pruefsumme", pruefsumme);
            massnahmen.protokoll(tenant, id, antrag ? "bewertung_beantragt" : "massnahme_bewertet",
                    Map.of("zustand", zustand), neu, begruendung, null, wer);
        });
        return massnahmen.eine(id);
    }

    /**
     * Vier-Augen: eine zweite Person (Rolle KA/EM; nicht, wer beantragt hat: 422 {@code vieraugen_urheber}; nicht der
     * Verantwortliche: 422 {@code vieraugen_verantwortlich}) bestätigt den Antrag — die Maßnahme ist {@code bewertet};
     * Ergebnis, Kopie und Prüfsumme bleiben die des Antrags.
     */
    public MassnahmeDto.Massnahme freigeben(UUID id, MassnahmeDto.Entscheid e, ProtokollAkteur wer) {
        Map<String, Object> z = massnahmen.zeile(id, ABSCHLIESSEN, wer);
        String begruendung = e == null || e.begruendung() == null || e.begruendung().isBlank() ? null
                : begruendung(e.begruendung());
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = kennzahlen.jetzt();
        transaktion.executeWithoutResult(s -> {
            String zustand = gesperrt(id);
            Map<String, Object> a = beantragt(id, z);
            zweitePerson(z, (String) a.get("freigabe_sub"), wer);
            jdbc.update("UPDATE massnahme_bewertung SET status = 'bewertet', entscheidung_sub = ?, entscheidung_name = ?, "
                    + "entscheidung_rolle = ?, entscheidung_art = ?, entschieden_am = ? WHERE massnahme_id = ? "
                    + "AND stand_nr = ?", wer.sub(), wer.name(), wer.rolle(), wer.art(), Timestamp.from(jetzt), id,
                    a.get("stand_nr"));
            String neuerZustand = bewertet(id, zustand);
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("zustand", neuerZustand);
            neu.put("stand_nr", a.get("stand_nr"));
            neu.put("ergebnis", a.get("ergebnis"));
            neu.put("vieraugen", true);
            neu.put("pruefsumme", a.get("pruefsumme"));
            massnahmen.protokoll(tenant, id, "massnahme_bewertet", Map.of("zustand", zustand, "status", "beantragt"),
                    neu, begruendung, null, wer);
        });
        return massnahmen.eine(id);
    }

    /** Vier-Augen: die zweite Person lehnt den Antrag mit Begründung ab; er behält seine Nr., ein neuer darf kommen. */
    public MassnahmeDto.Massnahme ablehnen(UUID id, MassnahmeDto.Entscheid e, ProtokollAkteur wer) {
        Map<String, Object> z = massnahmen.zeile(id, ABSCHLIESSEN, wer);
        String begruendung = begruendung(e == null ? null : e.begruendung());
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = kennzahlen.jetzt();
        transaktion.executeWithoutResult(s -> {
            gesperrt(id);
            Map<String, Object> a = beantragt(id, z);
            zweitePerson(z, (String) a.get("freigabe_sub"), wer);
            jdbc.update("UPDATE massnahme_bewertung SET status = 'abgelehnt', entscheidung_sub = ?, entscheidung_name = ?, "
                    + "entscheidung_rolle = ?, entscheidung_art = ?, entschieden_am = ?, entscheidungs_begruendung = ? "
                    + "WHERE massnahme_id = ? AND stand_nr = ?", wer.sub(), wer.name(), wer.rolle(), wer.art(),
                    Timestamp.from(jetzt), begruendung, id, a.get("stand_nr"));
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("status", "abgelehnt");
            neu.put("stand_nr", a.get("stand_nr"));
            neu.put("ergebnis", a.get("ergebnis"));
            neu.put("pruefsumme", a.get("pruefsumme"));
            massnahmen.protokoll(tenant, id, "bewertung_abgelehnt", Map.of("status", "beantragt"), neu, begruendung,
                    null, wer);
        });
        return massnahmen.eine(id);
    }

    // ================================================================================ Kopie der Wirkung

    /**
     * Die Kopie der Wirkung zum Bewertungstag in der Form der Referenzdatei 1.9 ({@code bewertungen[].kopie}): Anker,
     * Umsetzung, Nachher-Zeitraum, Abruf, je ENDGÜLTIGEM Nachher-Monat Version, Einflussgröße, gemessen, erwartet, Δ,
     * Urteil und Grund (der Umsetzungsmonat zählt nie und steht nicht darin), Σ ÷ Σ mit „x von y“ und Ausschlüssen,
     * die erwartete Wirkung. Gerechnet wird nichts — es sind die Zahlen des Lesers; mengen in kWh ganz (SP4).
     */
    private ObjectNode kopie(MassnahmeDto.Wirkung w) {
        MassnahmeDto.Massnahme m = w.massnahme();
        MassnahmeDto.Messgrundlage mg = m.messgrundlage();
        ObjectNode k = json.createObjectNode();
        k.put("kennzahl", mg.kennzahl().kennzeichen());
        k.put("bezugsbasis", mg.bezugsbasis().kennzeichen());
        k.put("fassung", mg.fassung());
        k.put("umgesetzt_am", m.umgesetztAm().toString());
        k.put("nachher", w.nachherVon() + "/" + w.nachherBis());
        k.put("abruf", w.abruf().toString());
        String einheit = w.monate().stream().map(x -> x.vergleich().bereinigt().gemessen().einheit())
                .filter(Objects::nonNull).findFirst().orElse(null);
        boolean kwh = KWH.equals(einheit);
        if (!kwh) {
            k.put("einheit", einheit);
        }
        var monate = k.putArray("monate");
        for (MassnahmeDto.WirkungMonat wm : w.monate()) {
            if (!wm.endgueltig() || wm.periode().equals(w.umsetzungsmonat())) {
                continue;
            }
            BezugsbasisVergleichDto.Bereinigt b = wm.vergleich().bereinigt();
            ObjectNode z = monate.addObject();
            z.put("periode", wm.periode());
            z.put("version", b.gemessen().version());
            bedingung(z, b.bedingung());
            z.put(kwh ? "kwh" : "gemessen", menge(b.gemessen().wert(), kwh));
            z.put(kwh ? "erwartet_kwh" : "erwartet", menge(b.erwartet(), kwh));
            z.put("delta_prozent", dezimal(b.deltaProzent()));
            z.put("urteil", b.urteil());
            z.put("grund", wm.grund());
        }
        MassnahmeDto.WirkungSumme s = w.summe();
        ObjectNode wi = k.putObject("wirkung");
        wi.put(kwh ? "gemessen_kwh" : "gemessen", menge(s.gemessen(), kwh));
        wi.put(kwh ? "erwartet_kwh" : "erwartet", menge(s.erwartet(), kwh));
        wi.put("delta_prozent", dezimal(s.deltaProzent()));
        wi.put("urteil", s.urteil());
        wi.put("band_prozent", dezimal(s.bandProzent()));
        wi.put("monate_bewertbar", w.monateBewertbar());
        wi.put("monate_gesamt", w.monateEndgueltig());
        ObjectNode aus = wi.putObject("ausgeschlossen");
        w.nichtGezaehlt().stream().filter(a -> !"umsetzungsmonat".equals(a.grund()))
                .forEach(a -> aus.put(a.monat(), a.grund()));
        k.put("erwartete_wirkung_prozent", dezimal(m.erwarteteWirkungProzent()));
        return k;
    }

    /**
     * Die Einflussgröße des Monats: eine mit Einheit unter ihrer Einheit ({@code "kg": 305000}, wie die Referenzdatei);
     * sonst (mehrere, ohne Einheit oder in kWh) als Liste {@code bedingung} mit Name, Wert und Einheit.
     */
    private static void bedingung(ObjectNode z, List<BezugsbasisVergleichDto.Bedingung> bedingung) {
        if (bedingung == null || bedingung.isEmpty()) {
            return;
        }
        String einheit = bedingung.get(0).einheit();
        if (bedingung.size() == 1 && einheit != null && !einheit.isBlank() && !KWH.equalsIgnoreCase(einheit)) {
            z.put(einheit.toLowerCase(Locale.ROOT), dezimal(bedingung.get(0).wert()));
            return;
        }
        var liste = z.putArray("bedingung");
        for (BezugsbasisVergleichDto.Bedingung v : bedingung) {
            liste.addObject().put("name", v.name()).put("wert", dezimal(v.wert())).put("einheit", v.einheit());
        }
    }

    private static BigDecimal menge(String text, boolean ganz) {
        BigDecimal d = dezimal(text);
        return d == null || !ganz ? d : d.setScale(0, RoundingMode.HALF_UP);
    }

    private static BigDecimal dezimal(String text) {
        return text == null ? null : new BigDecimal(text);
    }

    // ================================================================================ Prüfungen

    /** Bewertet wird erst nach der Umsetzung — und wieder, als Stand Nr. n + 1, nach einem Stand (409 sonst). */
    private static void umgesetzt(String kennzeichen, String zustand) {
        if (!"umgesetzt".equals(zustand) && !"bewertet".equals(zustand)) {
            throw new VerbesserungAbgelehnt(409, "massnahme_nicht_umgesetzt", "Die Maßnahme " + kennzeichen + " ist "
                    + zustand + "; bewertet wird sie erst, wenn sie umgesetzt ist.", Map.of("zustand", zustand));
        }
    }

    /** Die Maßnahme unter Sperre — ihr Zustand, wie er jetzt ist. */
    private String gesperrt(UUID id) {
        return jdbc.queryForObject("SELECT zustand FROM massnahme WHERE id = ? FOR UPDATE", String.class, id);
    }

    private Map<String, Object> antragOffen(UUID id) {
        return jdbc.queryForList("SELECT stand_nr, freigabe_sub, ergebnis, pruefsumme FROM massnahme_bewertung "
                + "WHERE massnahme_id = ? AND status = 'beantragt' FOR UPDATE", id).stream().findFirst().orElse(null);
    }

    private Map<String, Object> beantragt(UUID id, Map<String, Object> z) {
        Map<String, Object> a = antragOffen(id);
        if (a == null) {
            throw new VerbesserungAbgelehnt(409, "bewertung_nicht_beantragt", "Entschieden wird nur über eine "
                    + "beantragte Bewertung.", Map.of("kennzeichen", z.get("kennzeichen")));
        }
        return a;
    }

    /** Ein bewerteter Stand macht die umgesetzte Maßnahme {@code bewertet} (Trigger: erst mit Stand). */
    private String bewertet(UUID id, String zustand) {
        if ("umgesetzt".equals(zustand)) {
            jdbc.update("UPDATE massnahme SET zustand = 'bewertet' WHERE id = ?", id);
        }
        return "bewertet";
    }

    /**
     * Vier-Augen: die zweite Person ist nicht, wer beantragt hat (422), nicht der Verantwortliche der Maßnahme (422,
     * §5.7) und hat Rolle KA/EM (403).
     */
    private static void zweitePerson(Map<String, Object> z, String urheber, ProtokollAkteur wer) {
        Object kennzeichen = z.get("kennzeichen");
        if (Objects.equals(wer.sub(), urheber)) {
            throw VerbesserungAbgelehnt.fachlich("vieraugen_urheber", "Bei Vier-Augen-Freigabe entscheidet eine "
                    + "zweite Person — nicht, wer die Bewertung beantragt hat.", Map.of("kennzeichen", kennzeichen));
        }
        if (wer.sub() != null && wer.sub().equals(z.get("verantwortlich_sub"))) {
            throw VerbesserungAbgelehnt.fachlich("vieraugen_verantwortlich", "Bei Vier-Augen-Freigabe entscheidet eine "
                    + "zweite Person — nicht, wer für die Maßnahme verantwortlich ist.", Map.of("kennzeichen", kennzeichen));
        }
        if (wer.sub() == null || !ZWEITE_ROLLEN.contains(wer.rolle())) {
            throw new VerbesserungAbgelehnt(403, "vieraugen_rolle", "Die zweite Person ist Kundenadministrator oder "
                    + "Energiemanager.", Map.of("kennzeichen", kennzeichen));
        }
    }

    /** AP-08 E8: die Vier-Augen-Einstellung des Unternehmens; ohne Einstellung gilt die Vorgabe aus. */
    boolean vierAugen(UUID tenant) {
        List<Boolean> werte = jdbc.queryForList("SELECT vieraugen_freigabe FROM unternehmen WHERE tenant_id = ? "
                + "FOR SHARE", Boolean.class, tenant);
        return !werte.isEmpty() && Boolean.TRUE.equals(werte.get(0));
    }

    /** Begründung 10–500 Zeichen (Muster Bezugsbasis-Anstoß, §5.7). */
    private static String begruendung(String text) {
        String b = text == null ? "" : text.strip();
        if (b.length() < 10 || b.length() > 500) {
            throw VerbesserungAbgelehnt.fachlich("begruendung_fehlt", "Bitte begründen Sie mit 10 bis 500 Zeichen.",
                    Map.of("min", 10, "max", 500));
        }
        return b;
    }
}
