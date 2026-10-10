package com.voltpilot.api.zugriff;

import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Handeingriff;
import com.voltpilot.api.uems.RechteAbleitung.HandeingriffErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import com.voltpilot.api.zugriff.ZugriffRepository.Zeile;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Das Etikett eines gesetzten Handeingriffs (UEMS AP-03 IP-9, E15, A7).
 *
 * <p><b>Ein Entzug beendet keinen Handeingriff.</b> Der Eingriff bleibt unverändert in {@code device_override},
 * wird von der Cloud weiter erneuert und läuft bis zu seinem Ende (Pflicht-Dauer ≤ 24 h, W13) — ein
 * Verwaltungsakt ist keine Steuerungshandlung. Was sich ändert, ist allein sein ETIKETT: „Ladestand halten bis
 * 16:00 — gesetzt von Murat Demirci (Bedienrecht beendet am 14.11.2026 09:02)". So sieht der Kundenadministrator,
 * woher der Eingriff kommt, und entscheidet selbst, ob er ihn beendet.
 *
 * <p>Das Urteil fällt der Vertrag ({@link RechteAbleitung#handeingriff}); hier wird nur zusammengetragen, womit
 * gefragt wird: der Standort der Anlage, die Zuweisungen des SETZERS (wirksame wie beendete) und der
 * Kundenbereich. Ohne Subject (ein Eingriff von vor dem Akteur-Vokabular, V20260916010000, oder von einem Job)
 * gibt es kein Urteil und kein Etikett.
 */
@Component
public class ZugriffEtikett {

    private final JdbcTemplate jdbc;
    private final ZugriffRepository zugriffe;

    public ZugriffEtikett(JdbcTemplate jdbc, ZugriffRepository zugriffe) {
        this.jdbc = jdbc;
        this.zugriffe = zugriffe;
    }

    /** Was eine Anlage für die Etiketten ihrer Eingriffe braucht — einmal gelesen, für jeden Eingriff benutzt. */
    public record Anlage(String standortKennzeichen, Kundenbereich kundenbereich, ZoneId zone) {}

    /**
     * Die Anlage vorbereiten; {@code null}, wenn sie heute an keinem Standort hängt — dann gibt es keinen
     * Geltungsbereich, gegen den ein Bedienrecht geprüft werden könnte, und kein Etikett.
     */
    public Anlage anlage(UUID siteId) {
        ZugriffRepository.KundenbereichKopf kopf = zugriffe.kundenbereichKopf();
        List<String> kennzeichen = jdbc.query("SELECT s.kurzzeichen FROM anlage_standort a "
                + "JOIN standort s ON s.id = a.standort_id AND s.tenant_id = a.tenant_id "
                + "WHERE a.site_id = ? AND a.aufgehoben_am IS NULL "
                + "AND daterange(a.gueltig_ab, a.gueltig_bis, '[]') @> (now() AT TIME ZONE ?::text)::date "
                + "ORDER BY a.gueltig_ab DESC LIMIT 1",
                (rs, n) -> rs.getString("kurzzeichen"), siteId, kopf.zeitzone().getId());
        if (kennzeichen.isEmpty() || kennzeichen.get(0) == null) {
            return null;
        }
        List<Standort> standorte = zugriffe.standorte().stream()
                .map(s -> new Standort(s.kurzzeichen(), s.name())).toList();
        return new Anlage(kennzeichen.get(0), new Kundenbereich(kopf.name(), standorte, List.of()), kopf.zeitzone());
    }

    /**
     * „gesetzt von Murat Demirci" — und, wenn sein Bedienrecht an diesem Standort vorbei ist, mit dem Zusatz
     * „(Bedienrecht beendet am …)". {@code null}, wenn Anlage oder Setzer unbekannt sind.
     */
    public String etikett(Anlage anlage, String setzerSub, String setzerName, Instant bis) {
        if (anlage == null || setzerSub == null || setzerSub.isBlank() || bis == null) {
            return null;
        }
        Benutzer setzer = new Benutzer(setzerSub, setzerName == null ? setzerSub : setzerName,
                zugriffe.spiegel(setzerSub).map(ZugriffRepository.BenutzerSpiegel::konto).orElse(Konto.BENUTZER),
                KontoZustand.AKTIV, zuweisungen(setzerSub));
        HandeingriffErgebnis u = RechteAbleitung.handeingriff(RechteMatrixDatei.matrix(),
                new Handeingriff(anlage.standortKennzeichen(), bis,
                        setzerName == null ? setzerSub : setzerName, setzer),
                anlage.kundenbereich(), Instant.now(), anlage.zone());
        return u.etikett();
    }

    /**
     * Die Zuweisungen des Setzers als Vertrags-Eingang. Eine standortbezogene Zeile, deren Standort der
     * AUFRUFER nicht sieht, trägt kein Kennzeichen (der Zaun, IP-5) und wird ausgelassen — sie kann über diese
     * Anlage ohnehin nichts sagen. Die unternehmensweite Zeile trägt keins und bleibt.
     */
    private List<Zuweisung> zuweisungen(String sub) {
        List<Zuweisung> aus = new ArrayList<>();
        for (Zeile z : zugriffe.zuweisungen(sub)) {
            if (z.standortId() != null && z.standortKurzzeichen() == null) {
                continue;
            }
            aus.add(z.alsZuweisung());
        }
        return aus;
    }
}
