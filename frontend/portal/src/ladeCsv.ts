/** Eine CSV als Datei — ohne Server, ohne neue Abhängigkeit. */
export function ladeCsv(inhalt: string, datei: string) {
  // Das BOM lässt Excel die Umlaute als UTF-8 lesen.
  const blob = new Blob(['\ufeff', inhalt], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = datei;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
