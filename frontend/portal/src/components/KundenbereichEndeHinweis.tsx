import type { SelbstauskunftKundenbereichBeendet } from '../api';
import './KundenbereichEndeHinweis.css';

/**
 * Der Kopf-Hinweis des beendeten Kundenbereichs (UEMS AP-20 IP-16, RF-08): über jeder Seite, vor dem Inhalt, wie
 * der Unterstützungs-Hinweis. Der Zustand kommt mit der Selbstauskunft (`kundenbereich.beendet` aus `/api/v1/me`),
 * die jede Person eines beendeten Bereichs noch erreicht — keine eigene Anfrage. Der Satz ist der der API. Kein Knopf,
 * weil es bis IP-17 (Gesamtabzug) nichts zu tun gibt; der Hinweis ersetzt keine Sperre, die steht in der API.
 */
export function KundenbereichEndeHinweis({ beendet }: { beendet?: SelbstauskunftKundenbereichBeendet | null }) {
  if (!beendet) return null;
  return <aside className="vp-kundenbereich-ende" role="status" data-liest={beendet.liest || undefined}>
    <p><strong>Vertrag beendet</strong> {beendet.text}</p>
  </aside>;
}
