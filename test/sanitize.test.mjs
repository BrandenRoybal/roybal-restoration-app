/* Field-value sanitizing — stripCtrl. Barcode scanners and PDF pastes smuggle
   invisible control characters into job text fields; a live job stores
   "100250382\b \b" as its claim #, which broke every downstream text match
   (the Board link, the spine crosswalk, the email lane).
   Run: node apps/field/test/sanitize.test.mjs   (from repo root) */
import assert from "node:assert";
import { stripCtrl } from "../js/core.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("Field value sanitizing");

/* the live case — the Don Hovda job */
ok("drops the scanner backspaces", stripCtrl("100250382\b \b") === "100250382 ");
ok("result is what a human would have typed",
  stripCtrl("100250382\b \b").trim() === "100250382");

/* the whole C0/C1 range, not just \b */
ok("drops NUL", stripCtrl("A\u0000B") === "AB");
ok("drops newline and tab", stripCtrl("A\r\n\tB") === "AB");
ok("drops DEL", stripCtrl("A\u007FB") === "AB");
ok("drops C1", stripCtrl("A\u0085B") === "AB");

/* everything a real field value may contain survives untouched */
ok("plain text is unchanged", stripCtrl("Don Hovda") === "Don Hovda");
ok("punctuation survives", stripCtrl("CL-88421 #2 / unit B") === "CL-88421 #2 / unit B");
ok("accents survive", stripCtrl("José Peña") === "José Peña");
ok("emoji survive", stripCtrl("water 💧") === "water 💧");

/* NOT a trim — eating a trailing space would fight the user mid-word */
ok("keeps a trailing space", stripCtrl("Don ") === "Don ");
ok("keeps a leading space", stripCtrl(" Don") === " Don");

/* null-ish in, empty out — never the string "null" or "undefined" */
ok("null -> ''", stripCtrl(null) === "");
ok("undefined -> ''", stripCtrl(undefined) === "");
ok("empty -> ''", stripCtrl("") === "");
ok("number is stringified, not mangled", stripCtrl(1000) === "1000");

console.log(`\n${pass} checks passed.`);
