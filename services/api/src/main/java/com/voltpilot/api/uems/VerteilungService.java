package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.KostenstelleProzessRepository.Art;
import com.voltpilot.api.uems.KostenstelleProzessRepository.Objekt;
import com.voltpilot.api.uems.MessreiheEreignisRepository.Ausgang;
import com.voltpilot.api.uems.MessstelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.UnternehmenRepository.Unternehmen;
import com.voltpilot.api.uems.VerteilungAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.VerteilungRepository.Zeile;
import com.voltpilot.api.web.dto.VerteilungDto;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionException;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Verteilung einer Messstelle auf Kostenstellen (UEMS AP-10 IP-8, Konzept §4.6, E11 = A, E12 = A): ein SATZ je
 * Tag, 100 % an jedem Tag mit Zeilen, ohne Zeile ausdrücklich „nicht verteilt“.
 *
 * <p>Jede Regel urteilt {@link VerteilungRegeln#satzAbTag} (Vertrag {@code verteilung-vectors.json}, Regel
 * {@code satz_ab_tag}) — hier wird nur gelesen, was sie braucht, und geschrieben, was sie sagt. Die Datenbank
 * ({@code V20260913230000}) hält dieselben Grenzen noch einmal: die 100 % zur COMMIT-Zeit (ein Satz verschiebt
 * Anteile zwischen Zielen und ist mittendrin nie 100 %), das Ende mit der Kostenstelle über das Trigger-Paar aus
 * AP-10 IP-7. Was sie trotzdem abweist (ein Schreiber ohne Sperre), kommt als dieselbe Ablehnung an, nie als 500.
 *
 * <p>Ein Schreibvorgang = EIN Satz in EINER Transaktion unter der Sperre des Unternehmens: aufheben, beenden,
 * eintragen, GENAU EIN Protokolleintrag {@code verteilung_geaendert} und GENAU EIN Ereignis
 * {@code verteilung_geaendert}. Eine Ablehnung schreibt nichts; derselbe Satz noch einmal auch nicht.
 */
@Service
public class VerteilungService {

    static final String PROTOKOLL_ART = "verteilung_geaendert";
    static final String EREIGNIS_ART = "verteilung_geaendert";

    private final VerteilungRepository repo;
    private final KostenstelleProzessRepository kostenstellen;
    private final MessstelleRepository messstellen;
    private final MessstelleAenderungRepository aenderungen;
    private final MessreiheEreignisRepository ereignisse;
    private final UnternehmenRepository unternehmen;
    private final ObjectMapper json;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public VerteilungService(VerteilungRepository repo, KostenstelleProzessRepository kostenstellen,
            MessstelleRepository messstellen, MessstelleAenderungRepository aenderungen,
            MessreiheEreignisRepository ereignisse, UnternehmenRepository unternehmen, ObjectMapper json,
            PlatformTransactionManager transactionManager) {
        this.repo = repo;
        this.kostenstellen = kostenstellen;
        this.messstellen = messstellen;
        this.aenderungen = aenderungen;
        this.ereignisse = ereignisse;
        this.unternehmen = unternehmen;
        this.json = json;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** Nur für Tests: die Uhr, an der „heute“ und „rückwirkend“ hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------------ lesen

    /**
     * Die Verteilung einer Messstelle: ohne {@code am} alle wirksamen Anteile; mit {@code am} die an dem Tag
     * geltenden ({@link VerteilungRegeln#amTag}) und der Zustand — {@code verteilt} oder {@code nicht verteilt}.
     */
    public VerteilungDto.Verteilung verteilung(UUID messstelle, LocalDate am) {
        Messstelle m = messstelle(messstelle);
        List<Zeile> zeilen = repo.zeilen(messstelle);
        String zustand = null;
        List<Zeile> sichtbar = zeilen;
        if (am != null) {
            VerteilungRegeln.AmTagUrteil u = VerteilungRegeln.amTag(am,
                    zeilen.stream().map(Zeile::bestand).toList(), zeilen.stream().map(Zeile::ziel).toList());
            Set<String> gelten = new LinkedHashSet<>(u.zeilen().stream().map(VerteilungRegeln.Zeile::kostenstelle).toList());
            sichtbar = zeilen.stream().filter(z -> gelten.contains(z.kostenstelleId().toString())
                    && !am.isBefore(z.gueltigAb()) && (z.gueltigBis() == null || !am.isAfter(z.gueltigBis()))).toList();
            zustand = u.zustand();
        }
        return new VerteilungDto.Verteilung(m.id(), m.kennzeichen(), am, zustand,
                sichtbar.stream().map(VerteilungService::anteil).toList());
    }

    // --------------------------------------------------------------------- schreiben

    /**
     * Ab {@code gueltig_ab} gilt GENAU dieser Satz. Reihenfolge: Messstelle da (404) → Form (400) → archiviert
     * (409) → Unternehmen da (409) → jede Kostenstelle da (422 {@code kostenstelle_unbekannt}) → die Regel
     * {@link VerteilungRegeln#satzAbTag} (422 {@code anteil_ungueltig} · {@code ziel_besteht_nicht} ·
     * {@code verteilung_summe} · {@code formel_fassung_ueberlappt}). Antwort: alle wirksamen Anteile danach.
     */
    public VerteilungDto.Verteilung setzen(UUID messstelle, VerteilungDto.Setzen a, ProtokollAkteur wer) {
        Messstelle m = messstelle(messstelle);
        if (a == null) {
            throw VerteilungAbgelehnt.anfrage("");
        }
        LocalDate ab = tag("gueltig_ab", a.gueltigAb());
        if (a.zeilen() == null) {
            throw VerteilungAbgelehnt.anfrage("zeilen");
        }
        Map<UUID, BigDecimal> satz = new LinkedHashMap<>();
        for (VerteilungDto.ZeileEingabe z : a.zeilen()) {
            if (z == null) {
                throw VerteilungAbgelehnt.anfrage("zeilen");
            }
            UUID kostenstelle = uuid("zeilen[].kostenstelle_id", z.kostenstelleId());
            if (satz.put(kostenstelle, anteil(z.anteilProzent())) != null) {
                throw VerteilungAbgelehnt.anfrage("zeilen[].kostenstelle_id");
            }
        }
        boolean korrektur = Boolean.TRUE.equals(a.korrektur());
        if (m.archiviertAm() != null) {
            throw new VerteilungAbgelehnt(Ablehnung.MESSSTELLE_ARCHIVIERT, Map.of("kennzeichen", m.kennzeichen()));
        }
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        schreibe(() -> transaktion.execute(tx -> {
            Unternehmen u = sperre();
            ZoneId zone = ZoneId.of(u.zeitzone());
            Map<String, Objekt> ziele = new LinkedHashMap<>();
            for (Objekt k : kostenstellen.alle(Art.KOSTENSTELLE)) {
                ziele.put(k.id().toString(), k);
            }
            for (UUID k : satz.keySet()) {
                if (!ziele.containsKey(k.toString())) {
                    throw new VerteilungAbgelehnt(Ablehnung.KOSTENSTELLE_UNBEKANNT, Map.of("kostenstelle_id", k.toString()));
                }
            }
            List<Zeile> vorher = repo.zeilen(messstelle);
            List<VerteilungRegeln.Zeile> zeilen = satz.entrySet().stream()
                    .map(e -> new VerteilungRegeln.Zeile(e.getKey().toString(), e.getValue())).toList();
            VerteilungRegeln.SatzAbTagUrteil urteil = VerteilungRegeln.satzAbTag(LocalDate.ofInstant(jetzt, zone), ab,
                    zeilen, ziele.values().stream()
                            .map(k -> new VerteilungRegeln.Ziel(k.id().toString(), k.gueltigAb(), k.gueltigBis())).toList(),
                    vorher.stream().map(Zeile::bestand).toList(), korrektur);
            if (urteil.fehler() != null) {
                throw new VerteilungAbgelehnt(Ablehnung.ausRegel(urteil.fehler()), fakten(urteil.fakten(), ziele));
            }
            if (urteil.unveraendert()) {
                return messstelle;
            }
            for (VerteilungRegeln.Aufgehoben x : urteil.aufgehoben()) {
                repo.aufheben(zeile(vorher, x.kostenstelle(), z -> z.gueltigAb().equals(x.gueltigAb())), jetzt);
            }
            for (VerteilungRegeln.Beendet x : urteil.beendet()) {
                repo.beenden(zeile(vorher, x.kostenstelle(), z -> z.gueltigAb().isBefore(ab)
                        && (z.gueltigBis() == null || !z.gueltigBis().isBefore(ab))), x.gueltigBis());
            }
            for (VerteilungRegeln.NeueZeile n : urteil.neu()) {
                repo.eintragen(tenant, messstelle, UUID.fromString(n.kostenstelle()), n.anteilProzent(), n.gueltigAb(),
                        n.gueltigBis(), wer.sub());
            }
            protokoll(tenant, m, vorher, urteil, ab, zone, korrektur, ziele, a.grund(), wer);
            ereignis(tenant, m, ab, zone, jetzt);
            return messstelle;
        }));
        return verteilung(messstelle, null);
    }

    // ------------------------------------------------------------------------ Gerüst

    private Messstelle messstelle(UUID id) {
        return messstellen.finde(id).orElseThrow(() -> VerteilungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Die Zeilensperre des Unternehmens — ohne Unternehmen gibt es keine Kostenstelle. */
    private Unternehmen sperre() {
        if (unternehmen.sperren().isEmpty()) {
            throw VerteilungAbgelehnt.von(Ablehnung.UNTERNEHMEN_NICHT_ANGELEGT);
        }
        return unternehmen.desKundenbereichs().orElseThrow();
    }

    private static UUID zeile(List<Zeile> zeilen, String kostenstelle, java.util.function.Predicate<Zeile> passt) {
        return zeilen.stream().filter(z -> z.kostenstelleId().toString().equals(kostenstelle)).filter(passt)
                .map(Zeile::id).findFirst()
                .orElseThrow(() -> new IllegalStateException("Regel nennt eine Zeile, die es nicht gibt: " + kostenstelle));
    }

    /** Die Fakten der Regel in Kundensicht: zur ID der Kostenstelle ihr Kennzeichen. */
    private static Map<String, Object> fakten(Map<String, String> regel, Map<String, Objekt> ziele) {
        Map<String, Object> f = new LinkedHashMap<>();
        regel.forEach((k, v) -> {
            if (k.equals("kostenstelle")) {
                f.put("kostenstelle_id", v);
                Objekt o = ziele.get(v);
                f.put("kennzeichen", o == null ? null : o.kennzeichen());
            } else {
                f.put(k, v);
            }
        });
        return f;
    }

    /** GENAU EIN Eintrag: {@code gilt_ab} ist Mitternacht des Tages in der Zeitzone des Unternehmens. */
    private void protokoll(UUID tenant, Messstelle m, List<Zeile> vorher, VerteilungRegeln.SatzAbTagUrteil u,
            LocalDate ab, ZoneId zone, boolean korrektur, Map<String, Objekt> ziele, String grund, ProtokollAkteur wer) {
        List<Map<String, Object>> alt = new ArrayList<>();
        for (Zeile z : vorher) {
            if (!ab.isBefore(z.gueltigAb()) && (z.gueltigBis() == null || !ab.isAfter(z.gueltigBis()))) {
                alt.add(zeileForm(z.kostenstelleKennzeichen(), z.anteilProzent()));
            }
        }
        List<Map<String, Object>> neu = new ArrayList<>();
        for (VerteilungRegeln.NeueZeile n : u.neu()) {
            neu.add(zeileForm(ziele.get(n.kostenstelle()).kennzeichen(), n.anteilProzent()));
        }
        Map<String, Object> altForm = new LinkedHashMap<>();
        altForm.put("gueltig_ab", ab.toString());
        altForm.put("zeilen", alt);
        Map<String, Object> neuForm = new LinkedHashMap<>();
        neuForm.put("gueltig_ab", ab.toString());
        neuForm.put("zeilen", neu);
        neuForm.put("korrektur", korrektur);
        aenderungen.eintragen(new NeuerEintrag(tenant, m.id(), PROTOKOLL_ART, alsJson(altForm), alsJson(neuForm),
                ab.atStartOfDay(zone).toInstant(), u.rueckwirkend(), grund == null || grund.isBlank() ? null : grund,
                wer.sub(), wer.name(), wer.rolle(), wer.art()));
    }

    private static Map<String, Object> zeileForm(String kennzeichen, BigDecimal anteil) {
        Map<String, Object> z = new LinkedHashMap<>();
        z.put("kostenstelle", kennzeichen);
        z.put("anteil_prozent", anteil.stripTrailingZeros().toPlainString());
        return z;
    }

    /**
     * GENAU EIN Ereignis {@code verteilung_geaendert} (Urheber {@code kunde}, Bezug nur die Messstelle): der
     * Zeitpunkt ist der Beginn des ersten Tags, {@code eingetragen_am} der Augenblick des Eintrags. Verwirft der
     * Vertrag es, ist das ein Fehler dieses Schreibwegs — die Transaktion geht zurück, nichts bleibt halb.
     */
    private void ereignis(UUID tenant, Messstelle m, LocalDate ab, ZoneId zone, Instant jetzt) {
        ObjectNode e = json.createObjectNode();
        e.put("ereignis_id", UUID.randomUUID().toString());
        e.put("art", EREIGNIS_ART);
        e.put("zeitpunkt", ab.atStartOfDay(zone).toInstant().toString());
        e.put("messstelle", m.kennzeichen());
        e.put("eingetragen_am", jetzt.truncatedTo(ChronoUnit.SECONDS).toString());
        MessreiheEreignisRepository.Ergebnis r = ereignisse.anhaengen(tenant, null, Urheber.KUNDE, e, null, null);
        if (r.ausgang() != Ausgang.ANGEHAENGT) {
            throw new IllegalStateException("verteilung_geaendert nicht angehängt: " + r.ausgang() + " "
                    + r.grund() + " " + r.hinweis());
        }
    }

    private String alsJson(Map<String, Object> werte) {
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Protokolleintrag nicht darstellbar", e);
        }
    }

    private static VerteilungDto.Anteil anteil(Zeile z) {
        return new VerteilungDto.Anteil(z.id(), new VerteilungDto.Kostenstelle(z.kostenstelleId(),
                z.kostenstelleKennzeichen()), z.kostenstelleName(), z.anteilProzent().stripTrailingZeros().toPlainString(),
                z.gueltigAb(), z.gueltigBis(), z.gueltigBis() != null && Objects.equals(z.gueltigBis(), z.kostenstelleBis()));
    }

    private static LocalDate tag(String feld, String text) {
        if (text == null || text.isBlank()) {
            throw VerteilungAbgelehnt.anfrage(feld);
        }
        try {
            return LocalDate.parse(text.strip());
        } catch (RuntimeException e) {
            throw VerteilungAbgelehnt.anfrage(feld);
        }
    }

    private static UUID uuid(String feld, String text) {
        try {
            return UUID.fromString(Objects.requireNonNull(text).strip());
        } catch (RuntimeException e) {
            throw VerteilungAbgelehnt.anfrage(feld);
        }
    }

    /** Ein Dezimaltext; die Grenzen (0, 100] und die Nachkommastelle urteilt die Regel, nicht die Form. */
    private static BigDecimal anteil(String text) {
        try {
            return new BigDecimal(Objects.requireNonNull(text).strip());
        } catch (RuntimeException e) {
            throw VerteilungAbgelehnt.anfrage("zeilen[].anteil_prozent");
        }
    }

    /**
     * Schreibt und übersetzt, was die Sperre nicht ausschließt (ein Schreiber ohne sie): die Grenzen der Datenbank —
     * auch die zur Commit-Zeit — kommen als dieselben Ablehnungen an, nie als 500.
     */
    private <T> T schreibe(Supplier<T> arbeit) {
        try {
            return arbeit.get();
        } catch (DataAccessException | TransactionException e) {
            Ablehnung ablehnung = switch (Objects.requireNonNullElse(constraint(e), "")) {
                case "messstelle_verteilung_hundert_prozent" -> Ablehnung.VERTEILUNG_SUMME;
                case "messstelle_verteilung_kostenstelle_besteht" -> Ablehnung.ZIEL_BESTEHT_NICHT;
                case "messstelle_verteilung_keine_ueberlappung" -> Ablehnung.ZUORDNUNG_UEBERLAPPT;
                case "messstelle_verteilung_anteil_chk" -> Ablehnung.ANTEIL_UNGUELTIG;
                default -> null;
            };
            if (ablehnung == null) {
                throw e;
            }
            throw VerteilungAbgelehnt.von(ablehnung);
        }
    }

    /**
     * Der Constraint-Name der Postgres-Ablehnung. Der Treiber liegt nur zur Laufzeit auf dem Klassenpfad — darum über
     * {@code getServerErrorMessage().getConstraint()} per Reflexion, ohne Kompilier-Abhängigkeit.
     */
    private static String constraint(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            try {
                Object meldung = t.getClass().getMethod("getServerErrorMessage").invoke(t);
                if (meldung != null) {
                    return (String) meldung.getClass().getMethod("getConstraint").invoke(meldung);
                }
            } catch (ReflectiveOperationException keinPostgresFehler) {
                // weiter mit der Ursache
            }
        }
        return null;
    }
}
