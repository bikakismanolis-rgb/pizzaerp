import { plainDocCodes } from './labels'
/** Σφάλματα δικτύου του browser (Chrome/Firefox/Safari) σε ελληνικά */
export const NET_MSG = 'Δεν υπάρχει σύνδεση. Δοκίμασε ξανά.'

const NET_RE = /failed to fetch|networkerror|load failed|network request failed|fetch failed|err_internet_disconnected/i

export const isNetworkMessage = (msg: string | null | undefined): boolean => !!msg && NET_RE.test(msg)

/**
 * Το μήνυμα όπως είναι, εκτός από τα αγγλικά σφάλματα δικτύου· οι ημερομηνίες
 * των μηνυμάτων της βάσης «(2026-10-16)» γίνονται «(16/10/2026)».
 */
export const friendlyMessage = (msg: string): string => (
  isNetworkMessage(msg) ? NET_MSG : authMessage(msg) ?? plainDocCodes(msg.replace(/\((\d{4})-(\d{2})-(\d{2})\)/g, '($3/$2/$1)'))
)

/** Τα αγγλικά μηνύματα της σύνδεσης (Supabase Auth) σε απλά ελληνικά */
const AUTH_MESSAGES: [RegExp, string][] = [
  [/invalid login credentials/i, 'Λάθος email ή κωδικός. Δοκίμασε ξανά, ή πάτα «Ξέχασα τον κωδικό».'],
  [/email not confirmed/i, 'Δεν έχεις επιβεβαιώσει το email σου. Άνοιξε το email που σου στείλαμε (δες και στα ανεπιθύμητα) και πάτα τον σύνδεσμο.'],
  [/user already registered|already been registered/i, 'Υπάρχει ήδη λογαριασμός με αυτό το email. Πάτα «Έχω ήδη λογαριασμό».'],
  [/password should be at least|password is too short|weak password/i, 'Ο κωδικός θέλει τουλάχιστον 6 γράμματα ή αριθμούς.'],
  [/should be different from the old password/i, 'Ο νέος κωδικός πρέπει να είναι διαφορετικός από τον παλιό.'],
  [/unable to validate email address|invalid email|email address .* is invalid/i, 'Το email δεν είναι σωστό. Δες ότι το έγραψες σωστά (π.χ. maria@gmail.com).'],
  [/rate limit|too many requests|for security purposes, you can only request this/i, 'Πολλές προσπάθειες. Περίμενε ένα λεπτό και δοκίμασε ξανά.'],
  [/signups? not allowed|signup is disabled/i, 'Δεν γίνονται νέοι λογαριασμοί. Ρώτα τον ιδιοκτήτη.'],
  [/token has expired|otp_expired|link is invalid or has expired|invalid.*(token|link)/i, 'Ο σύνδεσμος έληξε ή χρησιμοποιήθηκε ήδη. Ζήτα καινούργιο.'],
  [/auth session missing|jwt expired|invalid jwt|refresh token/i, 'Η σύνδεση έληξε. Συνδέσου ξανά.'],
  [/user not found/i, 'Δεν βρέθηκε λογαριασμός με αυτό το email.'],
]
export const authMessage = (msg: string): string | null => AUTH_MESSAGES.find(([re]) => re.test(msg))?.[1] ?? null

/**
 * tally_add σε μέρα πριν από καταχωρημένη απογραφή (μόνο τότε κλειδώνει: η
 * μέτρηση της ίδιας μέρας δεν εμποδίζει). Οι πωλήσεις ημέρας δεν διαλέγουν
 * ημερομηνία, άρα το «μεταγενέστερη ημερομηνία» δεν βοηθά.
 */
export const tallyMessage = (raw: string): string => {
  const msg = friendlyMessage(raw)
  return /^Κλειδωμένη περίοδος/.test(msg)
    ? msg.replace(/\s*Χρησιμοποιήστε μεταγενέστερη ημερομηνία\.?\s*$/, '') +
      ' Η μέρα είναι πριν από αυτή την απογραφή, που έχει ήδη μετρήσει τις πωλήσεις της. Για αλλαγή, άνοιξε πρώτα την απογραφή και πάτα «Διόρθωση».'
    : msg
}
