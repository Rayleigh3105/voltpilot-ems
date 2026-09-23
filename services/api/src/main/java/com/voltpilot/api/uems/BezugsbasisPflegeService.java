package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BezugsbasisPflegeRepository.Basis;
import com.voltpilot.api.uems.BezugsbasisPflegeRepository.Fassung;
import com.voltpilot.api.uems.KennzahlRepository.Zeile;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Wiedervorlage, „geprüft, bleibt“, Beenden und die Übersicht am Unternehmen (UEMS AP-17 IP-17, F4/F5, A4, R13).
 *
 * <p><b>Die Frist wird beim Abruf abgeleitet</b> ({@link BezugsbasisRegeln#frist}): Freigabetag bzw. jüngstes „bleibt“
 * der laufenden Fassung + Wiedervorlage in Monaten, gegen den Tag „heute“ in der Zeitzone der Kennzahl — kein Läufer,
 * kein Ereignis, keine Nachricht. Nichts stuft von selbst um; nur eine Person bestätigt („bleibt“) oder beendet.
 *
 * <p><b>Der Zaun läuft über die Kennzahl:</b> die Kennzahl muss für den Aufrufer lesbar sein (sonst 404), das Recht
 * {@code bezugsbasis.verwalten} gilt an ihrem Geltungsbereich (403 {@code recht_fehlt} bzw. 404) — derselbe Weg wie IP-7
 * ({@link KennzahlService#fuerBezugsbasis}). Die Uhr ist die der
 * Kennzahl ({@link KennzahlService#jetzt()}), damit Tests Archivierung und Frist mit EINEM Stichtag fahren.
 */
@Service
public class BezugsbasisPflegeService {

    static final String VERWALTEN = "bezugsbasis.verwalten";
    static final int BEGRUENDUNG_MIN = 10;
    static final int BEGRUENDUNG_MAX = 500;

    /** Eine Ablehnung dieser Routen: Code, HTTP-Status, Satz. */
    public static final class Abgelehnt extends RuntimeException {
        private final String code;
        private final int status;

        Abgelehnt(String code, int status, String satz) {
            super(satz);
            this.code = code;
            this.status = status;
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }
    }

    /** Der Zustand einer Basis nach einer Handlung bzw. in der Übersicht. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zustand(UUID bezugsbasisId, String kennzeichen, UUID kennzahlId, String kennzahlKennzeichen,
            String kennzahlName, Integer fassung, String freigegebenAm, String datenlage, String zustand,
            String faelligAm, Integer faelligSeitTagen, boolean anstossLiegtVor, String beendetZum,
            String beendetGrund) {}

    /** {@code GET /api/v1/bezugsbasen/uebersicht}: die Zähler und die fälligen Basen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Uebersicht(String stichtag, int laufend, int freigegeben, int vorlaeufig, int mitAnstoss,
            int ueberpruefungFaellig, List<Zustand> faellig) {}

    private final KennzahlService kennzahlen;
    private final BezugsbasisPflegeRepository repo;
    private final TransactionTemplate transaktion;

    public BezugsbasisPflegeService(KennzahlService kennzahlen, BezugsbasisPflegeRepository repo,
            PlatformTransactionManager transactionManager) {
        this.kennzahlen = kennzahlen;
        this.repo = repo;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    // ================================================================================ schreiben

    /** F5: „geprüft, bleibt“ — Protokolleintrag mit Begründung; die Frist beginnt heute neu, die Fassung bleibt. */
    public Zustand bleibt(UUID kennzahlId, UUID basisId, String begruendung, ProtokollAkteur wer) {
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        KennzahlService.BasisKennzahl kz = kennzahlen.fuerBezugsbasis(kennzahlId, VERWALTEN, wer, null);
        Zeile k = kz.zeile();
        Instant jetzt = kz.jetzt();
        String grund = begruendung(begruendung);
        ZoneId zone = kz.zone();
        LocalDate heute = LocalDate.ofInstant(jetzt, zone);
        transaktion.executeWithoutResult(s -> {
            repo.sperre(basisId);
            Basis b = repo.basis(kennzahlId, basisId).orElseThrow(BezugsbasisPflegeService::nichtDa);
            requireLaufend(b);
            Fassung f = b.laufende().orElseThrow(() -> new Abgelehnt("keine_freigegebene_fassung", 409,
                    "Die Bezugsbasis hat noch keine freigegebene Fassung — es gibt nichts zu bestätigen."));
            Map<String, Object> vorher = BezugsbasisRegeln.frist(eingang(b, f, heute, zone));
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("bestaetigt_am", heute.toString());
            neu.put("faellig_am", heute.plusMonths(f.wiedervorlageMonate()).toString());
            neu.put("anstoesse_beantwortet", repo.anstoesseBleiben(f.id(), grund, jetzt, wer));
            Map<String, Object> alt = new LinkedHashMap<>();
            alt.put("faellig_am", vorher.get("faellig_am"));
            alt.put("zustand", vorher.get("zustand"));
            repo.protokoll(tenant, b.id(), f.nummer(), BezugsbasisPflegeRepository.GUELTIG_BLEIBT, alt, neu, grund,
                    jetzt, wer);
        });
        return zustand(k, repo.basis(kennzahlId, basisId).orElseThrow(), heute, zone);
    }

    /**
     * F4: beendet die Basis mit Tag, Grund (A1) und Begründung; nie gelöscht. Ein Tag vor heute nur mit
     * {@code rueckwirkend}; nie vor dem ersten Tag der laufenden Fassung. Prüfreihenfolge wie an der Kennzahl: Anfrage
     * (400) → Kennzahl (404) → Recht (403/404) → Inhalt (422) → Zustand (409). Danach darf die Kennzahl eine neue Basis
     * bekommen (B1).
     */
    public Zustand beenden(UUID kennzahlId, UUID basisId, String tagText, String grund, String begruendung,
            boolean rueckwirkend, ProtokollAkteur wer) {
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        LocalDate tag = tag(tagText);
        KennzahlService.BasisKennzahl kz = kennzahlen.fuerBezugsbasis(kennzahlId, VERWALTEN, wer, null);
        Zeile k = kz.zeile();
        Instant jetzt = kz.jetzt();
        if (grund == null || !BezugsbasisRegeln.ANPASSUNGSGRUENDE.contains(grund)) {
            throw new Abgelehnt("grund_unbekannt", 422, "Bitte wählen Sie einen Grund aus der Liste.");
        }
        String text = begruendung(begruendung);
        ZoneId zone = kz.zone();
        LocalDate heute = LocalDate.ofInstant(jetzt, zone);
        if (tag.isBefore(heute) && !rueckwirkend) {
            throw new Abgelehnt("rueckwirkend_fehlt", 422, "Der Tag liegt vor heute. Ein rückwirkendes Ende braucht das "
                    + "Kennzeichen „rückwirkend“.");
        }
        transaktion.executeWithoutResult(s -> {
            repo.sperre(basisId);
            Basis b = repo.basis(kennzahlId, basisId).orElseThrow(BezugsbasisPflegeService::nichtDa);
            requireLaufend(b);
            b.laufende().ifPresent(f -> {
                if (tag.isBefore(f.giltAb())) {
                    throw new Abgelehnt("tag_vor_fassung", 422, "Die Bezugsbasis kann nicht vor dem "
                            + deutsch(f.giltAb()) + " enden — an diesem Tag beginnt Fassung " + f.nummer() + ".");
                }
            });
            if (!repo.beenden(b.id(), b.laufende(), tag, grund, jetzt, wer)) {
                throw beendet(b);
            }
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("beendet_zum", tag.toString());
            neu.put("grund", grund);
            neu.put("rueckwirkend", tag.isBefore(heute));
            repo.protokoll(tenant, b.id(), b.laufende().map(Fassung::nummer).orElse(null),
                    BezugsbasisPflegeRepository.BEENDET, null, neu, text, jetzt, wer);
        });
        return zustand(k, repo.basis(kennzahlId, basisId).orElseThrow(), heute, zone);
    }

    // ================================================================================ lesen

    /**
     * Die Übersicht am Unternehmen (R13, §5.5): laufende Basen nach Zustand — freigegeben · vorläufig · Anstoß liegt
     * vor · Überprüfung fällig — und die fälligen als Liste (älteste Frist zuerst). Eine Basis an einer Kennzahl, die der
     * Aufrufer nicht sieht, zählt nicht. Recht: {@code bezugsbasis.ansehen} über die Kennzahl.
     */
    public Uebersicht uebersicht() {
        Instant jetzt = kennzahlen.jetzt();
        int laufend = 0;
        int freigegeben = 0;
        int vorlaeufig = 0;
        int anstoss = 0;
        List<Zustand> faellig = new ArrayList<>();
        LocalDate stichtag = null;
        for (Basis b : repo.laufende()) {
            Zeile k = kennzahlen.lesbareKennzahlOderNichts(b.kennzahlId());
            if (k == null) {
                continue;
            }
            ZoneId zone = kennzahlen.zone(k, jetzt);
            LocalDate heute = LocalDate.ofInstant(jetzt, zone);
            stichtag = stichtag == null ? heute : stichtag;
            laufend++;
            Zustand z = zustand(k, b, heute, zone);
            if (b.laufende().isEmpty()) {
                continue;
            }
            freigegeben++;
            if ("vorlaeufig".equals(z.datenlage())) {
                vorlaeufig++;
            }
            if (z.anstossLiegtVor()) {
                anstoss++;
            }
            if ("ueberpruefung_faellig".equals(z.zustand())) {
                faellig.add(z);
            }
        }
        faellig.sort((a, c) -> Integer.compare(c.faelligSeitTagen(), a.faelligSeitTagen()));
        return new Uebersicht((stichtag == null ? LocalDate.ofInstant(jetzt, ZoneId.of("Europe/Berlin")) : stichtag)
                .toString(), laufend, freigegeben, vorlaeufig, anstoss, faellig.size(), List.copyOf(faellig));
    }

    // ================================================================================ Gerüst

    private Zustand zustand(Zeile k, Basis b, LocalDate heute, ZoneId zone) {
        if (b.beendetAm() != null) {
            return new Zustand(b.id(), b.kennzeichen(), k.id(), k.kennzeichen(), k.name(),
                    b.laufende().map(Fassung::nummer).orElse(null), null, null, "beendet", null, null, false,
                    b.beendetZum().toString(), b.beendetGrund());
        }
        if (b.laufende().isEmpty()) {
            return new Zustand(b.id(), b.kennzeichen(), k.id(), k.kennzeichen(), k.name(), null, null, null, "entwurf",
                    null, null, false, null, null);
        }
        Fassung f = b.laufende().get();
        Map<String, Object> frist = BezugsbasisRegeln.frist(eingang(b, f, heute, zone));
        return new Zustand(b.id(), b.kennzeichen(), k.id(), k.kennzeichen(), k.name(), f.nummer(),
                LocalDate.ofInstant(f.freigegebenAm(), zone).toString(), f.datenlage(), (String) frist.get("zustand"),
                (String) frist.get("faellig_am"), (Integer) frist.get("faellig_seit_tagen"), f.offeneAnstoesse() > 0,
                null, null);
    }

    private static BezugsbasisRegeln.FristEingang eingang(Basis b, Fassung f, LocalDate heute, ZoneId zone) {
        return new BezugsbasisRegeln.FristEingang(LocalDate.ofInstant(f.freigegebenAm(), zone).toString(),
                f.wiedervorlageMonate(),
                f.bestaetigtAm() == null ? null : LocalDate.ofInstant(f.bestaetigtAm(), zone).toString(),
                b.beendetZum() == null ? null : b.beendetZum().toString(), heute.toString());
    }

    private static void requireLaufend(Basis b) {
        if (b.beendetAm() != null) {
            throw beendet(b);
        }
    }

    private static Abgelehnt beendet(Basis b) {
        return new Abgelehnt("bezugsbasis_beendet", 409, "Nicht bewertbar: Bezugsbasis beendet am "
                + deutsch(b.beendetZum()) + ".");
    }

    private static Abgelehnt nichtDa() {
        return new Abgelehnt("nicht_gefunden", 404, "Diese Bezugsbasis gibt es nicht.");
    }

    private static String begruendung(String text) {
        String t = text == null ? "" : text.strip();
        if (t.length() < BEGRUENDUNG_MIN || t.length() > BEGRUENDUNG_MAX) {
            throw new Abgelehnt("begruendung_fehlt", 422, "Bitte begründen Sie die Entscheidung (10 bis 500 Zeichen).");
        }
        return t;
    }

    private static LocalDate tag(String text) {
        try {
            return LocalDate.parse(Objects.requireNonNull(text));
        } catch (DateTimeParseException | NullPointerException e) {
            throw new Abgelehnt("anfrage_ungueltig", 400, "Bitte geben Sie den letzten Tag als JJJJ-MM-TT an.");
        }
    }

    static String deutsch(LocalDate tag) {
        return String.format("%02d.%02d.%04d", tag.getDayOfMonth(), tag.getMonthValue(), tag.getYear());
    }
}
