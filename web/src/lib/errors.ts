/** Σφάλματα δικτύου του browser (Chrome/Firefox/Safari) σε ελληνικά */
export const NET_MSG = 'Δεν υπάρχει σύνδεση. Δοκίμασε ξανά.'

const NET_RE = /failed to fetch|networkerror|load failed|network request failed|fetch failed|err_internet_disconnected/i

export const isNetworkMessage = (msg: string | null | undefined): boolean => !!msg && NET_RE.test(msg)

/**
 * Το μήνυμα όπως είναι, εκτός από τα αγγλικά σφάλματα δικτύου· οι ημερομηνίες
 * των μηνυμάτων της βάσης «(2026-10-16)» γίνονται «(16/10/2026)».
 */
export const friendlyMessage = (msg: string): string => (
  isNetworkMessage(msg) ? NET_MSG : msg.replace(/\((\d{4})-(\d{2})-(\d{2})\)/g, '($3/$2/$1)')
)

/**
 * tally_add σε μέρα πριν από καταχωρημένη απογραφή (μόνο τότε κλειδώνει: η
 * μέτρηση της ίδιας μέρας δεν εμποδίζει). Οι πωλήσεις ημέρας δεν διαλέγουν
 * ημερομηνία, άρα το «μεταγενέστερη ημερομηνία» δεν βοηθά.
 */
export const tallyMessage = (msg: string): string => (
  /^Κλειδωμένη περίοδος/.test(msg)
    ? msg.replace(/\s*Χρησιμοποιήστε μεταγενέστερη ημερομηνία\.?\s*$/, '').replace(/\((\d{4})-(\d{2})-(\d{2})\)/, '($3/$2/$1)') +
      ' Η μέρα είναι πριν από αυτή την απογραφή, που έχει ήδη μετρήσει τις πωλήσεις της. Για αλλαγή, ακύρωσε πρώτα την καταχώρηση της απογραφής.'
    : msg
)
