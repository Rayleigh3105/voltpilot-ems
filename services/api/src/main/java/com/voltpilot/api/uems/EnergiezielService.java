package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Das Energieziel (UEMS AP-18 IP-6, Z1–Z4, E3 = A): anlegen, lesen, ändern solange offen, Verantwortlicher, beenden —
 * jede Änderung eine Zeile im Protokoll {@code energieziel_aenderung} — und der Ziel-Stand als Leser.
 *
 * <p><b>Z1/Z2:</b> nur an einer Kennzahl mit freigegebener, heute geltender Bezugsbasis-Fassung (sonst 422
 * {@code kennzahl_ohne_bezugsbasis}); das Ziel zitiert diese Fassung. Zielwert in Prozent gegenüber dem Erwarteten
 * (eine Stelle, weniger negativ, ein positiver nur mit Wortlaut — der Wortlaut ist immer Pflicht); die Zielperiode
 * ist fest aus ganzen Monaten, beginnt frühestens im Monat nach dem Anlegen (nie rückwirkend, nie rollierend: 400).
 * Das Kennzeichen EZ-JJJJ-nnnn vergibt der Anlege-Trigger über {@code uems_verbesserung_kennung} mit dem ersten
 * Jahr der Zielperiode.
 *
 * <p><b>Z3/Z4:</b> der Stand ruft je Monat den Vergleich-Leser der Bezugsbasis gegen die zitierte Basis
 * ({@link BezugsbasisVergleich#fuerZiel}, P4) und über die endgültigen Monate die Operation {@code zielstand}
 * ({@link VerbesserungRegeln#zielstand}: Σ ÷ Σ, x von y, Ausschlüsse mit Grund, Vorschlag nur bei vollständiger
 * Periode) — gerechnet wird hier nichts. Die Kundensätze füllt {@link VerbesserungRegeln#satz}.
 *
 * <p><b>Zaun (RE2):</b> über die Kennzahl ({@link KennzahlService#fuerBezugsbasis}: 404 außerhalb, 403 ohne
 * {@code verbesserung.verwalten} an ihrer Geltung) und über {@code standort_id} (RLS {@code site_scope}); der
 * Kundenbereich kommt nie aus dem Körper.
 */
@Service
public class EnergiezielService {

    static final String VERWALTEN = "verbesserung.verwalten";
    static final Set<String> LISTE_PARAMETER = Set.of("kennzahl", "zustand");
    /** Die Zielperiode liest der Vergleich-Leser in einem Zug ({@link BezugsbasisVergleich#HOECHSTENS_MONATE}). */
    static final int HOECHSTENS_MONATE = BezugsbasisVergleich.HOECHSTENS_MONATE;
    private static final String OFFEN = "offen";

    /** Die Gründe eines nicht gezählten Monats als Satzteil „nicht bewertbar: …“ (§5.9, Energieziel, Stand). */
    private static final Map<String, String> GRUND = Map.of(
            "basis_fehlt", "keine Fassung der Bezugsbasis",
            "basis_beendet", "Bezugsbasis beendet",
            "zu_wenig_perioden", "zu wenige Monate in der Bezugsbasis",
            "periode_nicht_zu_ende", "Monat nicht zu Ende",
            "keine_werte", "kein gemessener Wert",
            "unvollstaendig", "Werte unvollständig");

    private final KennzahlService kennzahlen;
    private final BezugsbasisVergleich vergleich;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;

    public EnergiezielService(KennzahlService kennzahlen, BezugsbasisVergleich vergleich, JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager, ObjectMapper json) {
        this.kennzahlen = kennzahlen;
        this.vergleich = vergleich;
        this.jdbc = jdbc;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    /** Eine Zeile {@code energieziel} mit Kennzahl und Basis. */
    private record Zeile(UUID id, String kennzeichen, UUID kennzahlId, String kennzahl, String kennzahlName,
            UUID basisId, String basis, int fassung, BigDecimal zielwert, String zielperiode, String wortlaut,
            String begruendung, String verantwortlichSub, String verantwortlichName, UUID standortId, String zustand,
            java.time.Instant angelegtAm, LocalDate beendetZum, String beendetGrund, String ergebnis) {}

    private static final String SPALTEN = "SELECT e.id, e.kennzeichen, e.kennzahl_id, k.kennzeichen AS kz, "
            + "k.name AS kz_name, e.bezugsbasis_id, b.kennzeichen AS bb, e.fassung, e.zielwert_prozent, e.zielperiode, "
            + "e.wortlaut, e.begruendung, e.verantwortlich_sub, e.verantwortlich_name, e.standort_id, e.zustand, "
            + "e.angelegt_am, e.beendet_zum, e.beendet_grund, e.ergebnis FROM energieziel e "
            + "JOIN kennzahl k ON k.id = e.kennzahl_id AND k.tenant_id = e.tenant_id "
            + "JOIN bezugsbasis b ON b.id = e.bezugsbasis_id AND b.tenant_id = e.tenant_id ";

    private static Zeile zeile(ResultSet rs, int i) throws SQLException {
        Date zum = rs.getDate("beendet_zum");
        return new Zeile(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                rs.getObject("kennzahl_id", UUID.class), rs.getString("kz"), rs.getString("kz_name"),
                rs.getObject("bezugsbasis_id", UUID.class), rs.getString("bb"), rs.getInt("fassung"),
                rs.getBigDecimal("zielwert_prozent"), rs.getString("zielperiode"), rs.getString("wortlaut"),
                rs.getString("begruendung"), rs.getString("verantwortlich_sub"), rs.getString("verantwortlich_name"),
                rs.getObject("standort_id", UUID.class), rs.getString("zustand"),
                rs.getTimestamp("angelegt_am").toInstant(), zum == null ? null : zum.toLocalDate(),
                rs.getString("beendet_grund"), rs.getString("ergebnis"));
    }

    // ================================================================================ lesen

    /** Das Register: sichtbare Energieziele (RLS/Zaun), wahlweise einer Kennzahl oder eines Zustands. */
    public EnergiezielDto.Liste liste(Collection<String> parameter, String kennzahlText, String zustand) {
        parameter.stream().filter(p -> !LISTE_PARAMETER.contains(p)).findFirst().ifPresent(p -> {
            throw VerbesserungAbgelehnt.anfrage(p);
        });
        StringBuilder sql = new StringBuilder(SPALTEN).append("WHERE true ");
        List<Object> args = new ArrayList<>();
        if (kennzahlText != null) {
            UUID kennzahl;
            try {
                kennzahl = UUID.fromString(kennzahlText);
            } catch (IllegalArgumentException x) {
                throw VerbesserungAbgelehnt.anfrage("kennzahl");
            }
            kennzahlen.fuerBezugsbasis(kennzahl, null, null, null);
            sql.append("AND e.kennzahl_id = ? ");
            args.add(kennzahl);
        }
        if (zustand != null) {
            if (!VerbesserungRegeln.VOKABULARE.get("energieziel_zustand").contains(zustand)) {
                throw VerbesserungAbgelehnt.anfrage("zustand");
            }
            sql.append("AND e.zustand = ? ");
            args.add(zustand);
        }
        sql.append("ORDER BY e.kennzeichen");
        List<EnergiezielDto.Energieziel> aus = new ArrayList<>();
        for (Zeile z : jdbc.query(sql.toString(), EnergiezielService::zeile, args.toArray())) {
            aus.add(dto(z, zone(z), null));
        }
        return new EnergiezielDto.Liste(List.copyOf(aus));
    }

    /** Das Energieziel mit Verlauf; Sichtbarkeit über das Ziel (RLS) und über seine Kennzahl — sonst 404. */
    public EnergiezielDto.Energieziel eines(UUID id) {
        Zeile z = sichtbar(id);
        return dto(z, zone(z), verlauf(id));
    }

    /**
     * Z3/Z4: je Monat der Zielperiode das Vergleichsergebnis; über die endgültigen Monate die Operation
     * {@code zielstand} — Σ ÷ Σ über die bewertbaren, „x von y“, Ausschlüsse mit Grund, ein Vorschlag nur, wenn
     * jeder Monat der Periode endgültig und bewertbar ist.
     */
    public EnergiezielDto.Stand stand(UUID id) {
        Zeile z = sichtbar(id);
        YearMonth von = YearMonth.parse(z.zielperiode().substring(0, 7));
        YearMonth bis = YearMonth.parse(z.zielperiode().substring(8));
        BezugsbasisVergleich.ZielVergleich zv = vergleich.fuerZiel(z.kennzahlId(), z.basis(), von, bis);
        List<VerbesserungRegeln.MonatEingang> endgueltig = new ArrayList<>();
        List<EnergiezielDto.Monat> monate = new ArrayList<>();
        Map<String, BezugsbasisVergleichDto.Monat> zeilen = new LinkedHashMap<>();
        for (BezugsbasisVergleich.ZielMonat m : zv.monate()) {
            monate.add(new EnergiezielDto.Monat(m.zeile().periode(), m.endgueltig(), m.zeile()));
            zeilen.put(m.zeile().periode(), m.zeile());
            if (m.endgueltig()) {
                endgueltig.add(m.eingang());
            }
        }
        Map<String, Object> r = VerbesserungRegeln.zielstand(new VerbesserungRegeln.ZielstandEingang(
                z.zielwert().toPlainString(), z.zielperiode(), endgueltig));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> ng = (List<Map<String, Object>>) r.get("nicht_gezaehlt");
        List<EnergiezielDto.Ausschluss> ausschluesse = ng.stream()
                .map(a -> new EnergiezielDto.Ausschluss((String) a.get("monat"), (String) a.get("grund"))).toList();
        @SuppressWarnings("unchecked")
        List<String> kennzeichen = (List<String>) r.get("kennzeichen");
        EnergiezielDto.Summe summe = new EnergiezielDto.Summe((String) r.get("gemessen"), (String) r.get("erwartet"),
                (String) r.get("delta_prozent"), (String) r.get("band_prozent"), (String) r.get("richtung"),
                (String) r.get("urteil"), List.copyOf(kennzeichen));
        int bewertbar = (int) r.get("monate_bewertbar");
        String vorschlag = (String) r.get("vorschlag");
        String monateText = (String) r.get("monate");

        String satz = null;
        String vorschlagSatz = null;
        if (bewertbar > 0) {
            String prozent = prozent(summe.deltaProzent(), summe.richtung());
            Map<String, String> werte = new LinkedHashMap<>();
            werte.put("kennzeichen", z.kennzeichen());
            werte.put("wortlaut", z.wortlaut());
            werte.put("zielperiode", periodeText(von, bis));
            werte.put("person", z.verantwortlichName());
            werte.put("monate", monateText);
            werte.put("prozent", prozent);
            werte.put("ausschluesse", ausschluesse(ausschluesse, zeilen));
            werte.put("bezugsbasis", z.basis());
            werte.put("fassung", String.valueOf(z.fassung()));
            satz = (String) VerbesserungRegeln.satz("energieziel_stand", werte).get("satz");
            if (vorschlag != null) {
                vorschlagSatz = (String) VerbesserungRegeln.satz("energieziel_vorschlag", Map.of(
                        "vorschlag", "erreicht".equals(vorschlag) ? "erreicht" : "nicht erreicht",
                        "prozent", prozent, "zielwert", zielwertText(z.zielwert()), "monate", monateText))
                        .get("satz");
            }
        }
        return new EnergiezielDto.Stand(dto(z, zone(z), null), zv.heute(), z.zielperiode(),
                z.zielwert().toPlainString(), List.copyOf(monate), bewertbar, (int) r.get("monate_endgueltig"),
                (int) r.get("monate_soll"), monateText, (boolean) r.get("vollstaendig"), ausschluesse, summe, vorschlag,
                satz, vorschlagSatz);
    }

    // ================================================================================ anlegen (Z1, Z2)

    public EnergiezielDto.Energieziel anlegen(EnergiezielDto.Anlegen a, ProtokollAkteur wer) {
        if (a == null || a.kennzahl() == null) {
            throw VerbesserungAbgelehnt.anfrage("kennzahl");
        }
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(a.kennzahl(), VERWALTEN, wer, null);
        if (k.zeile().archiviertAm() != null) {
            throw new VerbesserungAbgelehnt(409, "kennzahl_archiviert",
                    "Eine archivierte Kennzahl bekommt kein Energieziel.", Map.of("kennzahl", k.zeile().kennzeichen()));
        }
        LocalDate heute = LocalDate.ofInstant(k.jetzt(), k.zone());
        Map<String, Object> fassung = jdbc.queryForList("SELECT b.id, b.kennzeichen, f.fassung, f.gilt_ab "
                + "FROM bezugsbasis b JOIN bezugsbasis_fassung f ON f.bezugsbasis_id = b.id AND f.tenant_id = b.tenant_id "
                + "WHERE b.kennzahl_id = ? AND b.beendet_am IS NULL AND f.freigabe_status = 'freigegeben' "
                + "AND f.gilt_ab <= ? AND (f.gilt_bis IS NULL OR f.gilt_bis >= ?) ORDER BY f.fassung DESC LIMIT 1",
                a.kennzahl(), Date.valueOf(heute), Date.valueOf(heute)).stream().findFirst().orElseThrow(() ->
                        VerbesserungAbgelehnt.fachlich("kennzahl_ohne_bezugsbasis", "Ein Energieziel braucht eine "
                                + "Kennzahl mit freigegebener Bezugsbasis — gegen sie wird der Zielwert gemessen.",
                                Map.of("kennzahl", k.zeile().kennzeichen())));

        String zielperiode = zielperiode(a.zielperiode());
        YearMonth von = YearMonth.parse(zielperiode.substring(0, 7));
        YearMonth fruehestens = YearMonth.from(heute).plusMonths(1);
        if (von.isBefore(fruehestens)) {
            throw new VerbesserungAbgelehnt(400, "zielperiode_rueckwirkend", "Die Zielperiode beginnt frühestens im "
                    + "Monat nach dem Anlegen.", Map.of("feld", "zielperiode", "fruehestens", fruehestens.toString()));
        }
        YearMonth giltAb = YearMonth.from(((Date) fassung.get("gilt_ab")).toLocalDate());
        if (von.isBefore(giltAb)) {
            throw VerbesserungAbgelehnt.fachlich("zielperiode_vor_fassung", "Die Zielperiode beginnt nicht vor der "
                    + "Geltung der Bezugsbasis-Fassung.", Map.of("gilt_ab", giltAb.toString()));
        }
        BigDecimal zielwert = zielwert(a.zielwertProzent());
        String wortlaut = wortlaut(a.wortlaut());
        String begruendung = begruendung(a.begruendung());
        Map<String, Object> person = verantwortlich(a.verantwortlich(), k.zeile().verantwortlichSub(), wer);
        UUID standort = kennzahlen.geltungFuerBericht(a.kennzahl()).standort();
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        UUID basisId = (UUID) fassung.get("id");
        int nummer = ((Number) fassung.get("fassung")).intValue();

        UUID neu = transaktion.execute(s -> {
            laufendesUeberlappt(a.kennzahl(), zielperiode, null);
            UUID id;
            try {
                id = jdbc.queryForObject("INSERT INTO energieziel (tenant_id, kennzahl_id, bezugsbasis_id, fassung, "
                        + "zielwert_prozent, zielperiode, wortlaut, begruendung, verantwortlich_sub, verantwortlich_name, "
                        + "verantwortlich_konto, standort_id, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, tenant,
                        a.kennzahl(), basisId, nummer, zielwert, zielperiode, wortlaut, begruendung, person.get("sub"),
                        person.get("name"), person.get("konto"), standort, wer.sub(), wer.name(), wer.rolle(), wer.art(),
                        Timestamp.from(k.jetzt()));
            } catch (DuplicateKeyException x) {
                throw laeuft(null, zielperiode);
            }
            Map<String, Object> inhalt = new LinkedHashMap<>();
            inhalt.put("kennzahl", k.zeile().kennzeichen());
            inhalt.put("bezugsbasis", fassung.get("kennzeichen"));
            inhalt.put("fassung", nummer);
            inhalt.put("zielwert_prozent", zielwert.toPlainString());
            inhalt.put("zielperiode", zielperiode);
            inhalt.put("wortlaut", wortlaut);
            inhalt.put("verantwortlich_name", person.get("name"));
            inhalt.put("zustand", OFFEN);
            protokoll(tenant, id, "energieziel_angelegt", null, inhalt, begruendung, wer);
            return id;
        });
        return eines(neu);
    }

    // ================================================================================ ändern, Verantwortlicher, beenden

    /** §5.7: Wortlaut und das Ende der Zielperiode (nur nach hinten), solange offen, immer mit Begründung. */
    public EnergiezielDto.Energieziel aendern(UUID id, EnergiezielDto.Aendern a, ProtokollAkteur wer) {
        Zeile z = schreibbar(id, wer);
        if (a == null || (a.wortlaut() == null && a.zielperiode() == null)) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
        String begruendung = begruendung(a.begruendung());
        String wortlaut = a.wortlaut() == null ? z.wortlaut() : wortlaut(a.wortlaut());
        String zielperiode = a.zielperiode() == null ? z.zielperiode() : zielperiode(a.zielperiode());
        if (!zielperiode.substring(0, 7).equals(z.zielperiode().substring(0, 7))
                || zielperiode.substring(8).compareTo(z.zielperiode().substring(8)) < 0) {
            throw VerbesserungAbgelehnt.fachlich("zielperiode_nur_nach_hinten", "Die Zielperiode verschiebt nur ihr "
                    + "Ende nach hinten; der Beginn bleibt.", Map.of("zielperiode", z.zielperiode()));
        }
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        transaktion.executeWithoutResult(s -> {
            if (!zielperiode.equals(z.zielperiode())) {
                laufendesUeberlappt(z.kennzahlId(), zielperiode, z.id());
            }
            jdbc.update("UPDATE energieziel SET wortlaut = ?, zielperiode = ? WHERE id = ?", wortlaut, zielperiode, id);
            Map<String, Object> alt = new LinkedHashMap<>();
            Map<String, Object> neu = new LinkedHashMap<>();
            if (!wortlaut.equals(z.wortlaut())) {
                alt.put("wortlaut", z.wortlaut());
                neu.put("wortlaut", wortlaut);
            }
            if (!zielperiode.equals(z.zielperiode())) {
                alt.put("zielperiode", z.zielperiode());
                neu.put("zielperiode", zielperiode);
            }
            protokoll(tenant, id, "energieziel_geaendert", alt, neu, begruendung, wer);
        });
        return eines(id);
    }

    /** RE3/W4: ein aktiver Benutzer des Kundenbereichs; sein Name als Schnappschuss; mit Begründung. */
    public EnergiezielDto.Energieziel verantwortlicher(UUID id, EnergiezielDto.Verantwortlicher v, ProtokollAkteur wer) {
        Zeile z = schreibbar(id, wer);
        if (v == null || v.benutzer() == null || v.benutzer().isBlank()) {
            throw VerbesserungAbgelehnt.anfrage("benutzer");
        }
        String begruendung = begruendung(v.begruendung());
        Map<String, Object> b = benutzer(v.benutzer().strip()).orElseThrow(() -> VerbesserungAbgelehnt.fachlich(
                "benutzer_unbekannt", "Diese Person gibt es in Ihrem Kundenbereich nicht.",
                Map.of("benutzer", v.benutzer())));
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        transaktion.executeWithoutResult(s -> {
            jdbc.update("UPDATE energieziel SET verantwortlich_sub = ?, verantwortlich_name = ?, verantwortlich_konto = ? "
                    + "WHERE id = ?", b.get("sub"), b.get("name"), b.get("konto"), id);
            protokoll(tenant, id, "verantwortlicher_geaendert", Map.of("verantwortlich_name", z.verantwortlichName()),
                    Map.of("verantwortlich_name", b.get("name")), begruendung, wer);
        });
        return eines(id);
    }

    /** §5.7: vorzeitig beenden (Tag, Begründung) — endgültig, nie gelöscht. */
    public EnergiezielDto.Energieziel beenden(UUID id, EnergiezielDto.Beenden e, ProtokollAkteur wer) {
        Zeile z = schreibbar(id, wer);
        String begruendung = begruendung(e == null ? null : e.begruendung());
        ZoneId zone = zone(z);
        LocalDate heute = LocalDate.ofInstant(kennzahlen.jetzt(), zone);
        LocalDate zum = e == null || e.zum() == null ? heute : e.zum();
        if (zum.isAfter(heute) || zum.isBefore(LocalDate.ofInstant(z.angelegtAm(), zone))) {
            throw VerbesserungAbgelehnt.fachlich("tag_ungueltig", "Beendet wird an einem Tag zwischen dem Anlegen "
                    + "und heute.", Map.of("zum", zum.toString()));
        }
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        transaktion.executeWithoutResult(s -> {
            jdbc.update("UPDATE energieziel SET zustand = 'beendet', beendet_zum = ?, beendet_am = ?, beendet_grund = ? "
                    + "WHERE id = ?", Date.valueOf(zum), Timestamp.from(kennzahlen.jetzt()), begruendung, id);
            protokoll(tenant, id, "energieziel_beendet", Map.of("zustand", OFFEN),
                    Map.of("zustand", "beendet", "beendet_zum", zum.toString()), begruendung, wer);
        });
        return eines(id);
    }

    // ================================================================================ Prüfungen

    /** Sichtbar über RLS ({@code site_scope}) und über die Kennzahl (404). */
    private Zeile sichtbar(UUID id) {
        Zeile z = jdbc.query(SPALTEN + "WHERE e.id = ?", EnergiezielService::zeile, id).stream().findFirst()
                .orElseThrow(VerbesserungAbgelehnt::nichtGefunden);
        kennzahlen.fuerBezugsbasis(z.kennzahlId(), null, null, null);
        return z;
    }

    /** Sichtbar (404), das Recht an der Geltung der Kennzahl (403), noch offen (409). */
    private Zeile schreibbar(UUID id, ProtokollAkteur wer) {
        Zeile z = sichtbar(id);
        kennzahlen.fuerBezugsbasis(z.kennzahlId(), VERWALTEN, wer, null);
        if (!OFFEN.equals(z.zustand())) {
            throw new VerbesserungAbgelehnt(409, "energieziel_nicht_offen", "Das Energieziel " + z.kennzeichen()
                    + " ist " + z.zustand() + " und wird nicht mehr geändert.", Map.of("zustand", z.zustand()));
        }
        return z;
    }

    /** Z1: je Kennzahl höchstens ein laufendes Ziel, dessen Zielperiode sich mit dieser überschneidet. */
    private void laufendesUeberlappt(UUID kennzahl, String zielperiode, UUID ausser) {
        for (Map<String, Object> o : jdbc.queryForList("SELECT id, kennzeichen, zielperiode FROM energieziel "
                + "WHERE kennzahl_id = ? AND zustand = 'offen' FOR UPDATE", kennzahl)) {
            String p = (String) o.get("zielperiode");
            boolean ueberlappt = zielperiode.substring(0, 7).compareTo(p.substring(8)) <= 0
                    && p.substring(0, 7).compareTo(zielperiode.substring(8)) <= 0;
            if (ueberlappt && !o.get("id").equals(ausser)) {
                throw laeuft((String) o.get("kennzeichen"), p);
            }
        }
    }

    private static VerbesserungAbgelehnt laeuft(String kennzeichen, String zielperiode) {
        Map<String, Object> f = new LinkedHashMap<>();
        if (kennzeichen != null) {
            f.put("kennzeichen", kennzeichen);
        }
        f.put("zielperiode", zielperiode);
        return new VerbesserungAbgelehnt(409, "energieziel_laeuft", "Für diese Kennzahl läuft in dieser Zielperiode "
                + "schon ein Energieziel.", f);
    }

    /** Z2: fest aus ganzen Monaten {@code JJJJ-MM/JJJJ-MM} (die Prüfung der Operation {@code zielstand}). */
    private static String zielperiode(String text) {
        if (text == null || text.isBlank()) {
            throw VerbesserungAbgelehnt.anfrage("zielperiode");
        }
        String p = text.strip();
        Object fehler = VerbesserungRegeln.zielstand(new VerbesserungRegeln.ZielstandEingang("0", p, List.of()))
                .get("fehler");
        if (fehler != null) {
            throw new VerbesserungAbgelehnt(400, "zielperiode_ungueltig", "Die Zielperiode ist ein fester Zeitraum "
                    + "ganzer Kalendermonate (JJJJ-MM/JJJJ-MM), nicht rollierend.",
                    Map.of("feld", "zielperiode", "grund", fehler));
        }
        long monate = ChronoUnit.MONTHS.between(YearMonth.parse(p.substring(0, 7)), YearMonth.parse(p.substring(8))) + 1;
        if (monate > HOECHSTENS_MONATE) {
            throw new VerbesserungAbgelehnt(400, "zielperiode_ungueltig", "Eine Zielperiode umfasst höchstens "
                    + HOECHSTENS_MONATE + " Monate.", Map.of("feld", "zielperiode", "grund", "zielperiode_laenge"));
        }
        return p;
    }

    /** Z2: Prozent gegenüber dem Erwarteten, eine Stelle, zwischen −100 und 100 (weniger Energie negativ). */
    private static BigDecimal zielwert(BigDecimal wert) {
        if (wert == null || wert.stripTrailingZeros().scale() > 1 || wert.abs().compareTo(BigDecimal.valueOf(100)) >= 0) {
            throw VerbesserungAbgelehnt.anfrage("zielwert_prozent");
        }
        return wert.setScale(1, RoundingMode.UNNECESSARY);
    }

    private static String wortlaut(String text) {
        if (text == null || text.isBlank()) {
            throw VerbesserungAbgelehnt.fachlich("wortlaut_fehlt", "Ein Energieziel sagt in Worten, was es will.",
                    null);
        }
        return text.strip();
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

    /** Der genannte Benutzer, sonst der der Kennzahl, sonst die anlegende Person — immer ein aktives Konto. */
    private Map<String, Object> verantwortlich(String genannt, String derKennzahl, ProtokollAkteur wer) {
        if (genannt != null && !genannt.isBlank()) {
            return benutzer(genannt.strip()).orElseThrow(() -> VerbesserungAbgelehnt.fachlich("benutzer_unbekannt",
                    "Diese Person gibt es in Ihrem Kundenbereich nicht.", Map.of("benutzer", genannt)));
        }
        for (String sub : new String[] {derKennzahl, wer.sub()}) {
            if (sub != null) {
                var b = benutzer(sub);
                if (b.isPresent()) {
                    return b.get();
                }
            }
        }
        throw VerbesserungAbgelehnt.fachlich("verantwortlich_fehlt", "Bitte nennen Sie eine verantwortliche Person "
                + "aus Ihrem Kundenbereich.", null);
    }

    private java.util.Optional<Map<String, Object>> benutzer(String sub) {
        return jdbc.queryForList("SELECT sub, konto, anzeigename FROM benutzer WHERE sub = ? AND zustand = 'aktiv'", sub)
                .stream().findFirst().map(b -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("sub", b.get("sub"));
                    m.put("konto", b.get("konto"));
                    String name = (String) b.get("anzeigename");
                    m.put("name", name == null || name.isBlank() ? b.get("sub") : name);
                    return m;
                });
    }

    // ================================================================================ Protokoll und Darstellung

    private void protokoll(UUID tenant, UUID id, String art, Map<String, Object> alt, Map<String, Object> neu,
            String begruendung, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO energieziel_aenderung (tenant_id, energieziel_id, art, alt, neu, begruendung, actor_sub, "
                + "actor_name, actor_rolle, actor_art) VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?)", tenant, id, art,
                text(alt), text(neu), begruendung, wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    private List<EnergiezielDto.Eintrag> verlauf(UUID id) {
        return jdbc.query("SELECT art, alt::text AS alt, neu::text AS neu, begruendung, actor_name, created_at "
                + "FROM energieziel_aenderung WHERE energieziel_id = ? ORDER BY created_at, id", (rs, i) ->
                        new EnergiezielDto.Eintrag(rs.getString("art"), map(rs.getString("alt")), map(rs.getString("neu")),
                                rs.getString("begruendung"), rs.getString("actor_name"),
                                rs.getTimestamp("created_at").toInstant()), id);
    }

    private String text(Map<String, Object> m) {
        try {
            return m == null ? null : json.writeValueAsString(m);
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
            throw new IllegalStateException(x);
        }
    }

    private Map<String, Object> map(String text) {
        try {
            return text == null ? null : json.readValue(text, new TypeReference<LinkedHashMap<String, Object>>() {});
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
            throw new IllegalStateException(x);
        }
    }

    private ZoneId zone(Zeile z) {
        return kennzahlen.fuerBezugsbasis(z.kennzahlId(), null, null, null).zone();
    }

    private static EnergiezielDto.Energieziel dto(Zeile z, ZoneId zone, List<EnergiezielDto.Eintrag> verlauf) {
        return new EnergiezielDto.Energieziel(z.id(), z.kennzeichen(),
                new EnergiezielDto.Kennzahl(z.kennzahlId(), z.kennzahl(), z.kennzahlName()),
                new EnergiezielDto.Basis(z.basisId(), z.basis(), z.fassung()), z.zielwert().toPlainString(),
                z.zielperiode(), z.wortlaut(), z.begruendung(),
                new EnergiezielDto.Person(z.verantwortlichSub(), z.verantwortlichName()), z.standortId(), z.zustand(),
                LocalDate.ofInstant(z.angelegtAm(), zone), z.beendetZum(), z.beendetGrund(), z.ergebnis(), verlauf);
    }

    /** „Januar bis Dezember 2028“ bzw. „November 2027 bis Oktober 2028“ (§5.9). */
    static String periodeText(YearMonth von, YearMonth bis) {
        String b = KennzahlRegeln.periodeText("monat", bis.toString());
        if (von.equals(bis)) {
            return b;
        }
        String a = KennzahlRegeln.periodeText("monat", von.toString());
        return (von.getYear() == bis.getYear() ? a.substring(0, a.lastIndexOf(' ')) : a) + " bis " + b;
    }

    /** SP4: „2,9 % weniger“ — Prozent eine Stelle, die Richtung als Wort. */
    static String prozent(String delta, String richtung) {
        return BezugsbasisVergleichSatz.prozent(delta) + " % " + ("mehr".equals(richtung) ? "mehr" : "weniger");
    }

    /** SP4: Zahlen der Person ohne „,0“ — −5,0 → „5 % weniger“. */
    static String zielwertText(BigDecimal zielwert) {
        String zahl = BezugsbasisRegeln.de(zielwert.abs().stripTrailingZeros().toPlainString());
        return zahl + " % " + (zielwert.signum() > 0 ? "mehr" : "weniger");
    }

    /** „März 2028 nicht bewertbar: Produktionsmenge Spritzguss außerhalb der Bezugsbasis“ — je Ausschluss. */
    private static String ausschluesse(List<EnergiezielDto.Ausschluss> ausschluesse,
            Map<String, BezugsbasisVergleichDto.Monat> zeilen) {
        if (ausschluesse.isEmpty()) {
            return "kein Monat ausgeschlossen";
        }
        List<String> teile = new ArrayList<>();
        for (EnergiezielDto.Ausschluss a : ausschluesse) {
            BezugsbasisVergleichDto.Monat m = zeilen.get(a.monat());
            String variable = m == null || m.bereinigt().bedingung().isEmpty() ? "Einflussgröße"
                    : m.bereinigt().bedingung().get(0).name();
            String grund = switch (a.grund()) {
                case "variable_ausserhalb" -> variable + " außerhalb der Bezugsbasis";
                case "variable_fehlt" -> variable + " ohne Wert";
                default -> GRUND.getOrDefault(a.grund(), a.grund());
            };
            teile.add(KennzahlRegeln.periodeText("monat", a.monat()) + " nicht bewertbar: " + grund);
        }
        return String.join("; ", teile);
    }
}
