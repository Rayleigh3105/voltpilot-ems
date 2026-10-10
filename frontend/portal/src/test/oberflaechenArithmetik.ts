import ts from 'typescript';

/** Syntaxprüfung statt Wortsuche: Kommentare, Aliasnamen und mehrzeilige Ausdrücke täuschen sie nicht. */
export function rechenstellen(quelltext: string): { importe: string[]; operationen: string[] } {
  const datei = ts.createSourceFile('ableitung.ts', quelltext, ts.ScriptTarget.Latest, true);
  const drucker = ts.createPrinter({ removeComments: true });
  const text = (n: ts.Node) => drucker.printNode(ts.EmitHint.Unspecified, n, datei).replace(/\s+/g, ' ').trim();
  const importe: string[] = [];
  const operationen: string[] = [];
  const arithmetik = new Set([
    ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
    ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, ts.SyntaxKind.AmpersandToken,
    ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken, ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ]);
  const vorzeichen = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken, ts.SyntaxKind.TildeToken]);

  function besitzer(n: ts.Node): string {
    let name = '<modul>';
    for (let p: ts.Node | undefined = n; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name) name = p.name.text;
      if (ts.isVariableDeclaration(p) && p.initializer) name = p.name.getText(datei);
    }
    return name;
  }

  function besuche(n: ts.Node): void {
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
      const c = n.importClause;
      const modul = (n.moduleSpecifier as ts.StringLiteral).text;
      if (c?.name) importe.push(`${modul}:default as ${c.name.text}`);
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) importe.push(`${modul}:* as ${c.namedBindings.name.text}`);
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) {
        for (const e of c.namedBindings.elements) if (!e.isTypeOnly) importe.push(`${modul}:${text(e)}`);
      }
      if (!c) importe.push(`${modul}:<seiteneffekt>`);
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier) importe.push(`export:${text(n)}`);
    const operator = ts.isBinaryExpression(n) && arithmetik.has(n.operatorToken.kind)
      || ts.isPrefixUnaryExpression(n) && vorzeichen.has(n.operator)
      || ts.isPostfixUnaryExpression(n);
    const aufruf = ts.isCallExpression(n) && (
      /^(Math\.|Number\b|BigInt\b|parseFloat\b|parseInt\b|eval\b|Function\b|require\b)/.test(n.expression.getText(datei))
      || n.expression.kind === ts.SyntaxKind.ImportKeyword
    );
    if (operator || aufruf || ts.isNewExpression(n) && /^(Function|Number|BigInt)$/.test(n.expression.getText(datei))) {
      operationen.push(`${besitzer(n)}: ${text(n)}`);
    }
    ts.forEachChild(n, besuche);
  }
  besuche(datei);
  return { importe: [...new Set(importe)].sort(), operationen: [...new Set(operationen)].sort() };
}
