/**
 * Πληθυντικός ονομάτων ειδών για τις προτάσεις («3 Μαργαρίτες», «80 Ζυμάρια»,
 * «2 Special κατεψυγμένες 30εκ»). Μόνο ασφαλείς κανόνες καταλήξεων· οι ξένες
 * λέξεις (Special, Coca-Cola, Σπέσιαλ, Καλτσόνε) δεν κλίνονται. Μετά από
 * «με / χωρίς / και …» το υπόλοιπο μένει όπως είναι («Πίτσες με μανιτάρια»).
 * Όταν μια λέξη δεν έχει ασφαλή κανόνα (π.χ. «-μα», «-ας»), επιστρέφει το
 * όνομα όπως είναι: καλύτερα «3 Κρέμα» από «3 Κρέματα».
 */

const STOP = new Set(['με', 'χωρίς', 'χωρις', 'και', 'από', 'απο', 'σε', 'για', 'του', 'της', 'των', 'στη', 'στην', 'στο', 'στον', 'α', 'ή'])

const GREEK = /[Α-Ωα-ωΆ-Ώά-ώϊϋΐΰ]/
const LATIN_OR_DIGIT = /[A-Za-z0-9]/

/** Ο πληθυντικός μιας λέξης, ή null όταν δεν υπάρχει ασφαλής κανόνας */
function pluralWord(w: string): string | null {
  // ήδη πληθυντικός (Πατάτες, Σουβλάκια, Γύροι)
  if (/(ες|ές|ια|ιά|οι|οί|ματα)$/.test(w)) return w
  const rules: [RegExp, string][] = [
    [/ος$/, 'οι'], [/ός$/, 'οί'],
    [/ί$/, 'ιά'], [/ι$/, 'ια'],
    [/ό$/, 'ά'], [/ο$/, 'α'],
    [/ή$/, 'ές'], [/η$/, 'ες'],
  ]
  for (const [re, to] of rules) if (re.test(w)) return w.replace(re, to)
  // -α: θηλυκά (Μαργαρίτα, Πίτσα, Σαλάτα)· όχι τα -μα (Κρέμα / Γεύμα: δεν ξέρουμε)
  if (/α$/.test(w) && !/μα$/.test(w)) return w.replace(/α$/, 'ες')
  // -ά, -ας, -ης, -μα, σύμφωνο ή ξένη κατάληξη: δεν κλίνεται με ασφάλεια
  return null
}

/** «Μαργαρίτα» → «Μαργαρίτες»· όπως ήταν όταν δεν γίνεται με ασφάλεια */
export function pluralName(name: string): string {
  const words = name.split(/(\s+)/)
  let stop = false
  const out: string[] = []
  for (const w of words) {
    if (stop || /^\s+$/.test(w) || !w) { out.push(w); continue }
    const lower = w.toLowerCase()
    if (STOP.has(lower)) { stop = true; out.push(w); continue }
    // γενική μετά το πρώτο ουσιαστικό («Κουτί πίτσας», «Σαλάτα εποχής»): μένει, και ό,τι ακολουθεί
    if (out.some((x) => x.trim()) && /(ας|άς|ης|ής|ου|ού|ων|ών)$/.test(lower)) { stop = true; out.push(w); continue }
    // ξένη λέξη, αριθμός, «330ml», «30εκ», κεφαλαία (ΒΙΟ): μένουν
    if (!GREEK.test(w) || LATIN_OR_DIGIT.test(w) || (w.length > 1 && w === w.toUpperCase())) { out.push(w); continue }
    const p = pluralWord(lower)
    if (p === null) {
      // ξένη ελληνογραμμένη (Σπέσιαλ, Καλτσόνε, Τοστ): δεν κλίνεται· άγνωστη ελληνική: όλο όπως ήταν
      if (/[^αάηήιίοόυύωώςε]$/.test(lower) || /ε$/.test(lower)) { out.push(w); continue }
      return name
    }
    out.push(w[0] === w[0].toUpperCase() ? p[0].toUpperCase() + p.slice(1) : p)
  }
  return out.join('')
}

/** «1 Μαργαρίτα», «3 Μαργαρίτες»: για τεμάχια (τα κιλά δεν θέλουν κλίση: «10 kg Μοτσαρέλα») */
export const countName = (qty: number, name: string): string => (Math.abs(qty) === 1 ? name : pluralName(name))
