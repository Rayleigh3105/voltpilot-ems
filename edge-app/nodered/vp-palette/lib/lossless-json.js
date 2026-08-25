'use strict';

// JSON.parse necessarily rounds integer tokens outside Number's exact range.
// Device APIs commonly expose uint64 energy counters, so retain only those
// unsafe integer lexemes as decimal strings while leaving ordinary JSON types
// unchanged. The resulting object remains JSON.stringify-compatible.
function parse(text) {
  const source = String(text);
  let index = 0;

  function fail(message) {
    throw new SyntaxError(message + ' at position ' + index);
  }

  function whitespace() {
    while (/\s/.test(source[index] || '')) index += 1;
  }

  function value() {
    whitespace();
    const ch = source[index];
    if (ch === '{') return object();
    if (ch === '[') return array();
    if (ch === '"') return string();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return number();
    if (source.startsWith('true', index)) { index += 4; return true; }
    if (source.startsWith('false', index)) { index += 5; return false; }
    if (source.startsWith('null', index)) { index += 4; return null; }
    fail('Unexpected token');
  }

  function string() {
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (source[index] === '\\') {
        index += 2;
      } else {
        if (source.charCodeAt(index) < 0x20) fail('Control character in string');
        index += 1;
      }
    }
    fail('Unterminated string');
  }

  function number() {
    const rest = source.slice(index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) fail('Invalid number');
    const token = match[0];
    index += token.length;
    if (/^-?(?:0|[1-9]\d*)$/.test(token)) {
      const integer = BigInt(token);
      if (integer > BigInt(Number.MAX_SAFE_INTEGER)
          || integer < BigInt(Number.MIN_SAFE_INTEGER)) return token;
    }
    const parsed = Number(token);
    if (!Number.isFinite(parsed)) fail('Non-finite number');
    return parsed;
  }

  function array() {
    const result = [];
    index += 1;
    whitespace();
    if (source[index] === ']') { index += 1; return result; }
    while (true) {
      result.push(value());
      whitespace();
      if (source[index] === ']') { index += 1; return result; }
      if (source[index] !== ',') fail('Expected comma');
      index += 1;
    }
  }

  function object() {
    const result = {};
    index += 1;
    whitespace();
    if (source[index] === '}') { index += 1; return result; }
    while (true) {
      whitespace();
      if (source[index] !== '"') fail('Expected property name');
      const key = string();
      whitespace();
      if (source[index] !== ':') fail('Expected colon');
      index += 1;
      Object.defineProperty(result, key, {
        value: value(), enumerable: true, configurable: true, writable: true,
      });
      whitespace();
      if (source[index] === '}') { index += 1; return result; }
      if (source[index] !== ',') fail('Expected comma');
      index += 1;
    }
  }

  const result = value();
  whitespace();
  if (index !== source.length) fail('Unexpected trailing token');
  return result;
}

module.exports = { parse };
