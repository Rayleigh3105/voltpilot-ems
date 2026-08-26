'use strict';

const catalogDocument = require('./catalog.json');
const catalog = new Map(catalogDocument.points.map((p) => [p.point_key, p]));

function templateKey(key) {
  return key.replace(/\[[^\]]+\]/g, '[*]');
}

function customPoint(key, definition) {
  if (!key.startsWith('custom.') || !definition || typeof definition !== 'object') return null;
  const source = definition.sourceKind || definition.source_kind;
  const address = Number(definition.address);
  const widthBits = Number(definition.widthBits || definition.width_bits);
  const widthWords = widthBits / 16;
  if (!['modbus_holding', 'modbus_input'].includes(source)
      || !Number.isInteger(address) || address < 0 || address > 65535
      || ![1, 2, 4].includes(widthWords) || address + widthWords > 65536) return null;
  return {
    point_key: key, family: 'custom', source_kind: source, readable: true,
    address: { kind: source, registers: Array.from({ length: widthWords }, (_, i) => address + i),
      width_words: widthWords },
    selector: definition.selector, value_type: definition.valueType || definition.value_type,
    signed: definition.signed, endian: definition.endian,
    scale: { kind: 'factor', value: Number(definition.scale) },
    poll_group: `custom:${source}:${address}`, min_cadence_s: 1,
  };
}

function resolvePoint(key, discovery, definition) {
  const custom = customPoint(key, definition);
  if (custom) return custom;
  let point = catalog.get(key);
  if (!point) point = catalog.get(templateKey(key));
  if (!point) return null;
  const moduleMatch = key.match(/^sunspec\.model_160\.module\[(\d+)]\./);
  if (moduleMatch) {
    const n = Number(discovery && discovery.models && discovery.models[160] && discovery.models[160].moduleCount);
    if (!Number.isInteger(n) || Number(moduleMatch[1]) >= n) return null;
    const address = Object.assign({}, point.address);
    address.offset_words = evalDynamicOffset(address.offset_words, Number(moduleMatch[1]));
    point = Object.assign({}, point, { point_key: key, address });
  }
  return point;
}

function evalDynamicOffset(expr, index) {
  if (Number.isInteger(expr)) return expr;
  const m = String(expr).match(/^(\d+)\+index\*(\d+)\+(\d+)$/);
  if (!m) throw new Error('invalid dynamic SunSpec offset');
  return Number(m[1]) + index * Number(m[2]) + Number(m[3]);
}

function wordsRaw(words) {
  if (words.length === 1) return words[0] & 0xffff;
  return words.map((v) => (v & 0xffff).toString(16).padStart(4, '0')).join('');
}

function derivedAddresses(point) {
  return [...new Set((point.derived_from || []).map((source) => {
    const match = String(source).match(/^holding:0x([0-9a-f]+)$/i);
    return match ? parseInt(match[1], 16) : null;
  }).filter(Number.isInteger))].sort((a, b) => a - b);
}

/**
 * Decode only derivations whose vendor rule is unambiguous in the packaged
 * catalog. The exact address=word vector remains raw in every case; rules with
 * firmware lookups/alternatives deliberately omit decoded instead of guessing.
 */
function decodeDerived(point, wireWords) {
  const addresses = derivedAddresses(point);
  if (!addresses.length || addresses.some((address) => !wireWords.has(address))) return null;
  const raw = addresses.map((address) => `${address.toString(16).padStart(4, '0')}=`
    + `${(wireWords.get(address) & 0xffff).toString(16).padStart(4, '0')}`).join(',');
  const out = { point_key: point.point_key, raw, quality: 'good' };
  const decoder = point.decoder || {};
  if (decoder.rule !== 1 || !Array.isArray(decoder.sensors)
      || decoder.sensors.some((sensor) => sensor.enabled_lookup || sensor.mppt
        || !Array.isArray(sensor.registers) || sensor.registers.flat(Infinity).some((r) => !Number.isInteger(r)))) {
    return out;
  }
  let total = 0;
  for (const sensor of decoder.sensors) {
    let value;
    if (sensor.multiply && Array.isArray(sensor.multiply.registers)
        && sensor.registers.length === 1 && sensor.multiply.registers.length === 1) {
      value = wireWords.get(sensor.registers[0]) * wireWords.get(sensor.multiply.registers[0]);
    } else if (sensor.registers.length === 1) value = wireWords.get(sensor.registers[0]);
    else return out; // multiword vendor rules use rule 3/4 and remain raw-only.
    total += sensor.operator === 'subtract' ? -value : value;
  }
  const scale = point.scale || { kind: 'none' };
  if (scale.kind === 'factor') total *= Number(scale.value);
  else if (scale.kind === 'divisor') total /= Number(scale.value);
  else if (scale.kind !== 'none') return out;
  const validation = decoder.validation || {};
  if (validation.min != null && total < validation.min
      || validation.max != null && total > validation.max) out.quality = 'invalid';
  else if (Number.isFinite(total)) out.decoded = total;
  return out;
}

function variantIndex(decoder, options) {
  const variant = decoder && decoder.variant;
  if (!variant) return 0;
  const word = options && options.variantWord;
  return Array.isArray(variant.index_1_values) && variant.index_1_values.includes(word)
    ? 1 : Number(variant.default_index) || 0;
}

function variantValue(value, decoder, options) {
  if (!Array.isArray(value)) return value;
  const index = variantIndex(decoder, options);
  return value[Math.min(index, value.length - 1)];
}

function effectiveEndian(point, options) {
  const byteOrder = point.decoder && point.decoder.byte_order;
  if (!byteOrder) return point.endian;
  const configured = options && options.byteOrder;
  if (configured === 'big') return 'big';
  if (configured === 'little' || configured === 'word_little_byte_big') {
    return 'word_little_byte_big';
  }
  const detected = options && options.byteOrderWord;
  return detected === byteOrder.big_value ? 'big' : 'word_little_byte_big';
}

function baseNumber(point, words, options) {
  const b = Buffer.alloc(words.length * 2);
  words.forEach((w, i) => b.writeUInt16BE(w & 0xffff, i * 2));
  const ordered = effectiveEndian(point, options) === 'word_little_byte_big' && words.length > 1
    ? [...words].reverse() : words;
  const n = Buffer.alloc(ordered.length * 2);
  ordered.forEach((w, i) => n.writeUInt16BE(w & 0xffff, i * 2));
  switch (point.value_type) {
    case 'int16': case 'sunssf': return b.readInt16BE(0);
    case 'uint16': case 'enum16': case 'bitfield16': case 'count': return b.readUInt16BE(0);
    case 'int32': return n.readInt32BE(0);
    case 'uint32': case 'acc32': case 'bitfield32': return n.readUInt32BE(0);
    case 'float32': return n.readFloatBE(0);
    case 'float64': return n.readDoubleBE(0);
    case 'string': case 'ascii_string': return b.toString('ascii').replace(/[\0\xff]+$/g, '').trim();
    case 'bitfield64': return BigInt('0x' + n.toString('hex')).toString(10);
    case 'datetime': return decodeDateTime(words);
    case 'time': return decodeTime(point, words);
    case 'version': return decodeVersion(point, words);
    default: return null;
  }
}

function deyeLookup(value, dictionary) {
  if (!Array.isArray(dictionary) || dictionary.length === 0) return value;
  let fallback = dictionary[0].value;
  for (const entry of dictionary) {
    let key = Object.prototype.hasOwnProperty.call(entry, 'bit')
      ? (Array.isArray(entry.bit)
        ? entry.bit.reduce((bits, bit) => bits + Math.pow(2, bit), 0)
        : Math.pow(2, entry.bit))
      : entry.key;
    if (entry.mode === '|' && (value & key) === key) key = value;
    if (entry.default != null || key === 'default') fallback = entry.value;
    if (Array.isArray(key) ? key.includes(value) : key === value) return entry.value;
  }
  return fallback;
}

function deyeBound(value, decoder, options) {
  return variantValue(value, decoder, options);
}

function deyeInvalid(decoder, value, options) {
  const validation = decoder.validation;
  if (!validation) return { invalid:0 };
  let invalid = 0;
  let min = deyeBound(validation.min, decoder, options);
  let max = deyeBound(validation.max, decoder, options);
  if (validation.lookup) {
    const reference = options && options.decodedValues && options.decodedValues.get(validation.lookup);
    if (typeof reference === 'number' && Number.isFinite(reference) && reference !== 0) {
      if (min == null) min = -Math.abs(reference);
      if (max == null) max = Math.abs(reference);
    }
  }
  const boundScale = deyeBound(validation.scale, decoder, options);
  if (boundScale != null) {
    if (min != null) min *= Number(boundScale);
    if (max != null) max *= Number(boundScale);
  }
  if (min != null && min > value || max != null && max < value) invalid |= 1;
  const dev = deyeBound(validation.dev, decoder, options);
  const previous = options && options.previousValues;
  const prior = previous && previous.get(decoder.source_key);
  if (dev && value && prior != null && Math.abs(value - prior) > dev) invalid |= 2;
  else if (!invalid && previous) previous.set(decoder.source_key, value);
  const mask = validation.invalidate_all;
  return { invalid, invalidateAll: invalid > 0
    && Object.prototype.hasOwnProperty.call(validation, 'invalidate_all')
    && (mask == null || Boolean(invalid & mask)) };
}

function deyeRule12(point, words, raw, options) {
  const decoder = point.decoder;
  let value = 0n;
  for (let i = 0; i < words.length; i++) value += BigInt(words[i] & 0xffff) << BigInt(i * 16);
  if ([2, 4].includes(decoder.rule)) {
    const bits = BigInt(words.length * 16);
    const sign = 1n << (bits - 1n);
    if (value >= sign) value = decoder.magnitude
      ? -(value & (sign - 1n)) : value - (1n << bits);
  }
  let decoded = Number(value);
  const range = decoder.range;
  if (range) {
    const min = deyeBound(range.min, decoder, options);
    const max = deyeBound(range.max, decoder, options);
    if (min != null && decoded < min || max != null && decoded > max) {
      decoded = deyeBound(range.default, decoder, options);
      if (decoded == null) return { point_key:point.point_key, raw, quality:'invalid' };
    }
  }
  if (decoder.mask != null) decoded = Number(BigInt(Math.trunc(decoded)) & BigInt(decoder.mask));
  if (decoder.bit != null) decoded = Number((BigInt(Math.trunc(decoded))
    >> BigInt(decoder.bit)) & 1n);
  if (decoder.bitmask != null) decoded = Number((BigInt(Math.trunc(decoded))
    & BigInt(decoder.bitmask)) / BigInt(decoder.bitmask));
  if (decoder.lookup) {
    decoded = deyeLookup(decoded, decoder.lookup);
  } else {
    const offset = deyeBound(decoder.offset, decoder, options);
    const scale = deyeBound(decoder.scale, decoder, options);
    const divide = deyeBound(decoder.divide, decoder, options);
    if (offset != null) decoded -= Number(offset);
    if (scale != null) decoded *= Number(scale);
    if (divide != null) decoded = Math.floor(decoded / Number(divide));
  }
  if ([2, 4].includes(decoder.rule) && decoder.inverted) decoded = -decoded;
  const checked = deyeInvalid(decoder, decoded, options);
  if (checked.invalid) {
    const fallback = deyeBound(decoder.validation.default, decoder, options);
    if (fallback == null) return { point_key:point.point_key, raw, quality:'invalid',
      ...(checked.invalidateAll ? { invalidate_all:true } : {}) };
    decoded = fallback;
  }
  if (typeof decoded === 'number') {
    const digits = Number(decoder.digits);
    if (Number.isInteger(digits) && digits >= 0) decoded = Number(decoded.toFixed(digits));
  }
  if (options && options.decodedValues && decoder.source_key) {
    options.decodedValues.set(decoder.source_key, decoded);
  }
  return { point_key:point.point_key, raw, decoded, quality:'good' };
}

function decodeDateTime(words) {
  const values=words.map((word)=>word&0xffff);
  if (values.length >= 6) {
    const [year,month,day,hour,minute,second]=values;
    if (year>=1970&&year<=9999&&month>=1&&month<=12&&day>=1&&day<=31
        &&hour<=23&&minute<=59&&second<=59) {
      return `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}`
        + `-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}`
        + `:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}`;
    }
  }
  // Deye also uses a packed six-byte RTC layout (YY MM DD hh mm ss).
  const bytes=Buffer.alloc(words.length*2); words.forEach((w,i)=>bytes.writeUInt16BE(w&0xffff,i*2));
  if (bytes.length>=6) {
    const [yy,month,day,hour,minute,second]=bytes;
    if (month>=1&&month<=12&&day>=1&&day<=31&&hour<=23&&minute<=59&&second<=59) {
      return `20${String(yy).padStart(2,'0')}-${String(month).padStart(2,'0')}`
        + `-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}`
        + `:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}`;
    }
  }
  return null;
}

function decodeTime(point, words) {
  const values=words.map((word)=>word&0xffff);
  const divisor=Number(point.decoder&&point.decoder.hex||point.decoder&&point.decoder.dec||100);
  let hour,minute,second=null;
  if (values.length===1) [hour,minute]=[Math.floor(values[0]/divisor),values[0]%divisor];
  else [hour,minute,second]=values;
  return hour<=23&&minute<=59&&(second==null||second<=59)
    ? `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`
      + (second==null?'':`:${String(second).padStart(2,'0')}`)
    : null;
}

function decodeVersion(point, words) {
  const decoder=point.decoder||{};
  const digitDelimiter=typeof decoder.delimiter==='string'?decoder.delimiter:'.';
  const registerDelimiter=typeof decoder.delimiter==='object'
    ? String(decoder.delimiter.register==null?'-':decoder.delimiter.register) : '-';
  const within=typeof decoder.delimiter==='object'
    ? String(decoder.delimiter.digit==null?'.':decoder.delimiter.digit) : digitDelimiter;
  const radix=Object.prototype.hasOwnProperty.call(decoder,'hex')?16:10;
  let value=words.map((word)=>[12,8,4,0].map((shift)=>((word>>shift)&15).toString(radix))
    .join(within)).join(registerDelimiter).toUpperCase();
  if (decoder.remove!=null) value=value.split(String(decoder.remove)).join('');
  return value;
}

/** Decode once at the edge. Unknown/conditional scale deliberately omits decoded. */
function decodeRegisters(point, words, scaleFactors, addresses, options) {
  const width = point.address && point.address.width_words;
  if (!Array.isArray(words) || !width || words.length !== width) return null;
  const contiguous = !Array.isArray(addresses) || addresses.length < 2
    || addresses.every((address, i) => i === 0 || address === addresses[i - 1] + 1);
  const raw = contiguous ? wordsRaw(words) : addresses.map((address, i) =>
    `${address.toString(16).padStart(4, '0')}=${(words[i] & 0xffff).toString(16).padStart(4, '0')}`).join(',');
  if (point.decoder && [1, 2, 3, 4].includes(point.decoder.rule)
      && !Array.isArray(point.decoder.sensors)) {
    return deyeRule12(point, words, raw, options || {});
  }
  let decoded = baseNumber(point, words, options);
  if (decoded === null || (typeof decoded === 'number' && !Number.isFinite(decoded))) {
    return { point_key: point.point_key, raw, quality: 'invalid' };
  }
  const scale = point.scale || { kind: 'none' };
  if (scale.kind === 'factor' && typeof decoded === 'number') decoded *= Number(scale.value);
  else if (scale.kind === 'divisor' && typeof decoded === 'number') decoded /= Number(scale.value);
  else if (scale.kind === 'sunssf') {
    const sf = scaleFactors && scaleFactors[scale.point];
    if (!Number.isInteger(sf) || sf === -32768) decoded = undefined;
    else decoded *= Math.pow(10, sf);
  } else if (!['none', 'protocol_value'].includes(scale.kind)) decoded = undefined;
  const out = { point_key: point.point_key, raw, quality: 'good' };
  if (decoded !== undefined) out.decoded = decoded;
  return out;
}

function pathValue(root, selector) {
  const clean = selector.replace(/^\$\.?/, '').replace(/\[(\d+)]/g, '.$1');
  return clean.split(/[./]/).filter(Boolean).reduce((v, key) => v == null ? undefined : v[key], root);
}

function scalarSample(point, key, value) {
  if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) return null;
  if (['number', 'string', 'boolean'].includes(typeof value)) {
    const out={ point_key:key, raw:value, decoded:value, quality:'good' };
    const scale=point.scale||{kind:'none'};
    if (typeof value==='number'&&scale.kind==='factor') out.decoded=value*Number(scale.value);
    else if (typeof value==='number'&&scale.kind==='divisor') out.decoded=value/Number(scale.value);
    if (typeof out.decoded==='number'&&!Number.isFinite(out.decoded)) return null;
    return out;
  }
  // The wire contract intentionally keeps raw scalar. Preserve readable JSON
  // objects/arrays as JSON text instead of silently discarding them or
  // inventing a numeric interpretation.
  if (typeof value === 'object') return { point_key: key, raw: JSON.stringify(value), quality: 'good' };
  return null;
}

function concreteKey(template, captures) {
  if (!template.includes('*')) return template;
  const values = captures.length ? captures : ['0'];
  let i = 0;
  return template.replace(/\[\*]/g, () => `[${values[Math.min(i++, values.length - 1)]}]`)
    .replace(/(?<=\.)\*(?=\.|$)/g, () => String(values[Math.min(i++, values.length - 1)]));
}

function expandPath(root, selector) {
  const tokens = selector.replace(/^\$\.?/, '').replace(/\[(\d+|\*)]/g, '.$1')
    .split(/[./]/).filter(Boolean);
  const out = [];
  const walk = (value, at, captures) => {
    if (at === tokens.length) { out.push({ value, captures }); return; }
    const token = tokens[at];
    if (token === '*') {
      if (value == null || typeof value !== 'object') return;
      for (const key of Object.keys(value)) walk(value[key], at + 1, captures.concat(String(key)));
    } else if (value != null) walk(value[token], at + 1, captures);
  };
  walk(root, 0, []);
  return out;
}

function decodeJSONSamples(point, payload) {
  let selector = point.selector;
  if (selector.includes('?filter=')) selector = selector.split('?filter=')[1];
  else if (selector.includes('#')) selector = selector.split('#')[1];
  const indices = [...point.point_key.matchAll(/\[(\d+)]/g)].map((m) => m[1]);
  for (const index of indices) selector = selector.replace('[*]', `[${index}]`);
  const prefixCaptures = [];
  if (/\?id=\*/.test(point.selector) && payload && Number.isInteger(payload.id)) {
    prefixCaptures.push(String(payload.id));
  }
  return expandPath(payload, selector).map(({ value, captures }) =>
    scalarSample(point, concreteKey(point.point_key, prefixCaptures.concat(captures)), value)).filter(Boolean);
}

function decodeJSON(point, payload) {
  const samples = decodeJSONSamples(point, payload);
  return samples.length ? samples[0] : null;
}

function ocppPointKey(value) {
  const slug = (v) => String(v == null ? 'none' : v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const measurand = String(value.measurand || 'Energy.Active.Import.Register').toLowerCase();
  return `ocpp.1_6.metervalues.${measurand}`
    + `.context[${slug(value.context || 'Sample.Periodic')}].format[${slug(value.format || 'Raw')}]`
    + `.phase[${slug(value.phase || 'none')}].location[${slug(value.location || 'Outlet')}]`
    + `.unit[${slug(value.unit || 'none')}]`;
}

function decodeOcppSampledValue(value) {
  const key = ocppPointKey(value);
  const point = resolvePoint(key);
  if (!point) return null;
  const raw = value.value;
  if (!['number', 'string'].includes(typeof raw)) return null;
  // OCPP 1.6 SampledValue.value is a string. If a non-conforming adapter has
  // already converted a wide integer to a JS number, its original digits are
  // unrecoverable: emit no sample instead of presenting rounded data as raw.
  if (typeof raw === 'number' && Number.isInteger(raw) && !Number.isSafeInteger(raw)) return null;
  const out = { point_key: key, raw, quality: 'good' };
  if ((value.format || 'Raw') === 'SignedData') {
    out.signed_data = String(raw); out.signed_data_format = 'OCPP1.6/SignedData';
  } else {
    const n = Number(raw);
    // Keep the OCPP wire string exact. A numeric derivative is useful only
    // while IEEE-754 can represent its integer magnitude safely; otherwise
    // omitting decoded prevents writer/rollup COALESCE from preferring a
    // rounded value over the truthful raw decimal string.
    if (Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n))) out.decoded = n;
  }
  return out;
}

module.exports = { catalogDocument, resolvePoint, decodeRegisters, decodeJSON,
  decodeJSONSamples, decodeDerived, derivedAddresses, decodeOcppSampledValue, ocppPointKey,
  templateKey, _helpers: { templateKey, evalDynamicOffset, pathValue, concreteKey, expandPath,
    customPoint, effectiveEndian, deyeLookup, variantIndex } };
