/* ============================================================
   validate.js — a JSON Schema checker for the action schemas
   ------------------------------------------------------------
   Deliberately small: it covers exactly the schema features
   actions.ts uses, which are exactly the features Anthropic's
   strict tool use accepts (type, enum, const, required,
   properties, additionalProperties:false, items, anyOf,
   format:date). No $ref, no numeric or string bounds — those
   are unsupported by strict mode, so the schemas never use them
   and the checker never has to.

   Plain JS on purpose: Deno imports it as-is, and emit-client.mjs
   copies it verbatim into apps/field/js/schemacheck.js so the
   browser runs the SAME checker the server runs. Keep it free of
   TypeScript syntax and of any runtime global.
   ============================================================ */

const typeOf = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;

const typeMatches = (want, v) => {
  const t = typeOf(v);
  if (want === "number") return t === "number" || t === "integer";
  if (want === "integer") return t === "integer";
  return t === want;
};

/* A real calendar date, not just four-two-two digits: "2026-02-30" fails. */
const isIsoDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
};

/** Every way `value` fails `schema`, as plain sentences ("params.stage must
    be one of lead, scheduled…"). Empty array = valid. `path` names the
    value in messages; callers pass "params" for a chip's params. */
export function validateSchema(schema, value, path = "value") {
  const errs = [];
  if (!schema || typeof schema !== "object") return errs;

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.map((s) => validateSchema(s, value, path));
    if (!branches.some((b) => b.length === 0)) {
      // report the branch that got closest, so the message names the real problem
      const best = branches.slice().sort((a, b) => a.length - b.length)[0] || [];
      errs.push(...(best.length ? best : [`${path} matches none of the allowed shapes`]));
    }
    return errs;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errs.push(`${path} must be ${JSON.stringify(schema.const)}`);
    return errs;
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    errs.push(`${path} must be a ${schema.type}${value === undefined ? " (it is missing)" : ""}`);
    return errs;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errs.push(`${path} must be one of ${schema.enum.join(", ")}`);
    return errs;
  }
  if (schema.format === "date" && typeof value === "string" && !isIsoDate(value)) {
    errs.push(`${path} must be a real date written YYYY-MM-DD`);
    return errs;
  }

  if (schema.type === "object" && value && typeof value === "object") {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (value[key] === undefined) errs.push(`${path}.${key} is required`);
    }
    for (const key of Object.keys(value)) {
      if (props[key]) {
        if (value[key] !== undefined) errs.push(...validateSchema(props[key], value[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errs.push(`${path}.${key} is not a known field`);
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errs.push(...validateSchema(schema.items, item, `${path}[${i}]`)));
  }
  return errs;
}

/** Convenience for a proposed action: the schema for `type` from `defs`
    (a map of name → { input_schema }) checked against `params`. Unknown
    types are not an error here — the caller decides what an unknown type
    means (the server rejects it against the actionset; the client skips
    legacy chips that pre-date the schemas). */
export function checkActionParams(defs, type, params) {
  const def = defs && Object.prototype.hasOwnProperty.call(defs, type) ? defs[type] : null;
  const schema = def && (def.input_schema || def);
  if (!schema || typeof schema !== "object" || !schema.type) return { known: false, errors: [] };
  return { known: true, errors: validateSchema(schema, params ?? {}, "params") };
}
