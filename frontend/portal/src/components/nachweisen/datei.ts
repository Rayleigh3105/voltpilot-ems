/** Legt eine abgerufene Datei unter ihrem Namen ab (PDF, CSV): ein Link mit `download`, der danach verschwindet. */
export function dateiSpeichern(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}
